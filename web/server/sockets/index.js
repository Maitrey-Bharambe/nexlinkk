'use strict';

const { Server } = require('socket.io');
const cookie = require('cookie');
const { loadSession, SESSION_COOKIE } = require('../middleware/auth');
const { visibleNetworkIds } = require('../modules/networks/scope');

/**
 * Live update channel. Events carry only identifiers; clients refetch through
 * the REST API, which applies authorization. Rooms limit fan-out to users who
 * can see the network in question.
 */
function attachRealtime(httpServer, { config, logger }) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // Other upgrades on this port (agent relay, Next.js HMR) are not ours.
    destroyUpgrade: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const found = await loadSession(cookies[SESSION_COOKIE]);
      if (!found) return next(new Error('unauthenticated'));
      socket.data.user = found.user;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user._id}`);
    if (user.role === 'admin') socket.join('admin');
    for (const id of await visibleNetworkIds(user)) socket.join(`network:${id}`);
    socket.emit('ready', { at: new Date().toISOString() });
  });

  return {
    io,
    emitNetwork(networkId, event, payload, extraUserId) {
      let target = io.to(`network:${networkId}`).to('admin');
      if (extraUserId) target = target.to(`user:${extraUserId}`);
      target.emit(event, { ...payload, networkId: String(networkId), at: new Date().toISOString() });
    },
    emitAudit(ev) {
      const target = ev.networkId ? io.to(`network:${ev.networkId}`).to('admin') : io.to('admin');
      target.emit('audit:new', { id: String(ev._id), at: ev.at });
    },
    close: () => io.close(),
    logger,
  };
}

module.exports = { attachRealtime };
