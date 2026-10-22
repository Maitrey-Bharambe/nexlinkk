'use strict';

const { WebSocketServer } = require('ws');
const { Device } = require('../../database/models/device');
const { Membership } = require('../../database/models/network');
const { authenticateAgent } = require('../../middleware/agentAuth');

const RELAY_PATH = '/api/v1/agent/relay';

// The running relay, for read-only diagnostics (one per process).
let current = null;
const currentRelay = () => current;
const ID_BYTES = 12; // a MongoDB ObjectId, raw
const MAX_PACKET = 2048; // one WireGuard message (MTU 1420 + headers)
const RECHECK_MS = 15_000;
const IDLE_MS = 60_000; // agents send a keepalive frame every 20 s
const MAX_BUFFERED = 1 << 20;

/**
 * Encrypted relay for devices that cannot reach each other directly: behind
 * NAT or CGNAT, on hotel or mobile networks, or blocked from UDP.
 *
 * Each agent keeps one WebSocket open, authenticated with the same Ed25519
 * request signature as every other agent call. A frame is
 * [12-byte peer device id][one WireGuard UDP payload]. The relay rewrites the
 * id to the sender's and passes the payload on — to a connected device of
 * the same network only. Payloads are WireGuard ciphertext; the relay holds
 * no WireGuard key and cannot read or forge tunnel traffic. Membership and
 * revocation are re-checked while connected.
 */
function createRelay({ config, logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: ID_BYTES + MAX_PACKET, perMessageDeflate: false });
  const conns = new Map(); // deviceId -> { ws, networkId, name, tokens, lastFill, stats }
  const attempts = new Map(); // ip -> { n, resetAt }

  const reject = (socket, status, code) => {
    socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const tooManyAttempts = (ip) => {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.resetAt < now) {
      attempts.set(ip, { n: 1, resetAt: now + 60_000 });
      return false;
    }
    return ++a.n > 30;
  };

  async function handleUpgrade(req, socket, head) {
    if (!config.RELAY_ENABLED) return reject(socket, 404, 'Not Found');
    if (tooManyAttempts(req.socket.remoteAddress)) return reject(socket, 429, 'Too Many Requests');
    socket.on('error', () => {});
    const shim = {
      method: req.method,
      originalUrl: req.url,
      rawBody: Buffer.alloc(0),
      ip: req.socket.remoteAddress,
      get: (h) => req.headers[h.toLowerCase()],
    };
    let device;
    let membership;
    try {
      device = await authenticateAgent(config, shim);
      membership = await Membership.findOne({ deviceId: device._id, status: 'active' }).lean();
    } catch (err) {
      return reject(socket, err.status || 500, err.code || 'Error');
    }
    if (!membership) return reject(socket, 409, 'NO_MEMBERSHIP');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, device, String(membership.networkId)));
  }

  function attach(ws, device, networkId) {
    const id = String(device._id);
    const prev = conns.get(id);
    if (prev) prev.ws.close(4000, 'replaced by a newer connection');
    const c = {
      ws,
      networkId,
      name: device.name,
      idBytes: Buffer.from(id, 'hex'),
      tokens: config.RELAY_MAX_BYTES_PER_SECOND,
      lastFill: Date.now(),
      lastSeen: Date.now(),
      connectedAt: new Date(),
      stats: { rxBytes: 0, txBytes: 0, dropped: 0 },
    };
    conns.set(id, c);
    logger.info({ deviceId: id, device: device.name }, 'relay: device connected');

    ws.on('message', (data, isBinary) => {
      c.lastSeen = Date.now();
      if (!isBinary || data.length <= ID_BYTES) return; // keepalive
      c.stats.rxBytes += data.length;
      // Token bucket per sender: a device cannot flood the relay.
      const now = Date.now();
      c.tokens = Math.min(config.RELAY_MAX_BYTES_PER_SECOND, c.tokens + ((now - c.lastFill) / 1000) * config.RELAY_MAX_BYTES_PER_SECOND);
      c.lastFill = now;
      const dst = conns.get(data.subarray(0, ID_BYTES).toString('hex'));
      if (!dst || dst === c || dst.networkId !== c.networkId || c.tokens < data.length || dst.ws.bufferedAmount > MAX_BUFFERED) {
        c.stats.dropped++;
        return;
      }
      c.tokens -= data.length;
      c.idBytes.copy(data, 0); // the receiver learns who sent it, from the relay, not the sender
      dst.stats.txBytes += data.length;
      dst.ws.send(data, { binary: true });
    });
    ws.on('close', () => {
      if (conns.get(id) === c) conns.delete(id);
      logger.info({ deviceId: id, ...c.stats }, 'relay: device disconnected');
    });
    ws.on('error', () => {});
  }

  // Liveness, plus revocation / membership changes while a socket is open.
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const c of conns.values()) if (now - c.lastSeen > IDLE_MS) c.ws.terminate();
    try {
      const ids = [...conns.keys()];
      if (!ids.length) return;
      const [devices, members] = await Promise.all([
        Device.find({ _id: { $in: ids } }, { enrollmentState: 1 }).lean(),
        Membership.find({ deviceId: { $in: ids }, status: 'active' }, { deviceId: 1, networkId: 1 }).lean(),
      ]);
      const enrolled = new Set(devices.filter((d) => d.enrollmentState === 'enrolled').map((d) => String(d._id)));
      const netOf = new Map(members.map((m) => [String(m.deviceId), String(m.networkId)]));
      for (const [id, c] of conns) {
        if (!enrolled.has(id) || netOf.get(id) !== c.networkId) c.ws.close(4403, 'device revoked or removed from network');
      }
    } catch (err) {
      logger.warn({ err }, 'relay: membership re-check failed');
    }
  }, RECHECK_MS);
  timer.unref();

  const api = {
    handleUpgrade,
    /** Relay state of one device, for the console. */
    status(deviceId) {
      const c = conns.get(String(deviceId));
      return c ? { connected: true, since: c.connectedAt, ...c.stats } : { connected: false };
    },
    disconnect(deviceId, reason = 'disconnected') {
      conns.get(String(deviceId))?.ws.close(4403, reason);
    },
    close() {
      clearInterval(timer);
      for (const c of conns.values()) c.ws.terminate();
      wss.close();
    },
  };
  current = api;
  return api;
}

module.exports = { createRelay, currentRelay, RELAY_PATH, ID_BYTES };
