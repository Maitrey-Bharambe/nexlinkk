/**
 * Protocol replay for the /simulation page.
 *
 * buildTimeline() turns a scenario into an ordered list of events that mirror
 * what the real agents and control plane do (same endpoints, same WireGuard
 * message types and sizes, same timers). Nothing here is measured: the page
 * labels every packet as simulated and shows the observed link state from the
 * real agents next to it.
 *
 * Event shapes (t and dur in presentation milliseconds):
 *   { type: 'packet', t, dur, from, to, channel: 'control'|'tunnel', kind, label, bytes, fields, drop, log, rtt }
 *   { type: 'log', t, src, level, msg }
 *   { type: 'state', t, patch }
 *   { type: 'phase', t, id }
 *
 * The animation is slowed down enormously (a LAN round trip is < 1 ms); log
 * lines carry realistic real-world values instead.
 */

export const SCENARIOS = {
  normal: {
    label: 'normal tunnel',
    description: 'Two PCs enroll, get each other as peers, complete a WireGuard handshake and exchange encrypted probes.',
  },
  loss: {
    label: 'lossy Wi-Fi (30% loss)',
    description: 'Some UDP datagrams are dropped on the air. Probes time out, telemetry reports loss, the link becomes degraded.',
  },
  offline: {
    label: 'peer offline',
    description: 'PC-B is switched off after enrolling. PC-A keeps retrying the handshake every 5 s; the link is never marked connected.',
  },
  cpdown: {
    label: 'control plane down',
    description: 'The server stops after the tunnel is up. Telemetry fails, but encrypted traffic keeps flowing — the data plane does not depend on it.',
  },
  revoke: {
    label: 'device revoked',
    description: 'An admin revokes PC-B. Its next signed request is refused, PC-A receives a config without it and tears the session down.',
  },
};

export const PHASES = [
  { id: 'enroll', label: 'enrollment' },
  { id: 'config', label: 'peer config' },
  { id: 'handshake', label: 'handshake' },
  { id: 'traffic', label: 'encrypted traffic' },
  { id: 'telemetry', label: 'telemetry' },
  { id: 'event', label: 'scenario event' },
];

// Deterministic PRNG so a scenario always replays identically.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HTTP_MS = 900; // presentation time for a control-plane request leg
const UDP_MS = 1300; // presentation time for one tunnel leg (A <-> B via the access point)

export function buildTimeline(scenario, { a, b, seed = 7 }) {
  const rand = rng(seed + scenario.length * 101);
  const hex = (bytes) => Array.from({ length: bytes }, () => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('');
  const b64 = (bytes) => btoa(String.fromCharCode(...Array.from({ length: bytes }, () => Math.floor(rand() * 256)))).slice(0, 44);
  const rtt = () => +(0.3 + rand() * 0.6).toFixed(2);

  const events = [];
  let at = 0;
  const wait = (ms) => (at += ms);
  const log = (src, msg, level = 'info') => events.push({ type: 'log', t: at, src, level, msg });
  const state = (patch) => events.push({ type: 'state', t: at, patch });
  const phase = (id) => events.push({ type: 'phase', t: at, id });
  const nodeOf = { A: a, B: b };

  // Sends a packet starting now; returns its arrival time. Does not advance the cursor.
  const packet = (from, to, p) => {
    const dur = p.dur || (p.channel === 'tunnel' ? UDP_MS : HTTP_MS);
    events.push({ type: 'packet', t: at, dur, from, to, ...p });
    return at + dur;
  };
  // Request/response over the signed control channel; advances the cursor past the reply.
  const http = (dev, req, res) => {
    at = packet(dev, 'CP', { channel: 'control', kind: 'http', ...req });
    at = packet('CP', dev, { channel: 'control', kind: 'http-res', ...res });
    wait(150);
  };
  const signed = (dev, method, path, bytes) => [
    ['method', `${method} ${path}`],
    ['X-NexLink-Device', nodeOf[dev].id],
    ['X-NexLink-Timestamp', String(1792500000 + Math.floor(at / 1000))],
    ['X-NexLink-Nonce', hex(12)],
    ['X-NexLink-Signature', `ed25519:${b64(48)}…`],
    ['body', `${bytes} B · sha256 signed`],
  ];

  const idxA = hex(4);
  const idxB = hex(4);
  let counterA = 0;
  let counterB = 0;

  const transport = (from, inner, innerBytes, extra = {}) => {
    const padded = Math.ceil(innerBytes / 16) * 16;
    const counter = from === 'A' ? counterA++ : counterB++;
    return {
      channel: 'tunnel',
      kind: innerBytes === 0 ? 'keepalive' : 'data',
      label: innerBytes === 0 ? 'keepalive · 32 B' : `${inner} · ${16 + padded + 16} B`,
      bytes: 16 + padded + 16,
      fields: [
        ['message', 'Transport Data (type 4)'],
        ['receiver_index', from === 'A' ? idxB : idxA],
        ['counter', String(counter)],
        ['encrypted_packet', innerBytes === 0 ? '0 B (keepalive)' : `${padded} B ChaCha20-Poly1305 · inner: ${inner}`],
        ['auth_tag', '16 B'],
        ['outer', `UDP ${nodeOf[from].endpoint} → ${nodeOf[from === 'A' ? 'B' : 'A'].endpoint}`],
      ],
      ...extra,
    };
  };

  // Encrypted TCP probe from `from` to the other side's tunnel address (what the agent's probe does).
  const probe = (from, { lost = false } = {}) => {
    const to = from === 'A' ? 'B' : 'A';
    const peer = nodeOf[to];
    const ms = rtt();
    const arrive = packet(from, to, transport(from, `TCP SYN → ${peer.address}:7946`, 60, lost ? { drop: true } : {}));
    if (lost) {
      at = arrive + 400;
      log(from, `tunnel probe timeout peer_ip=${peer.address} (no SYN-ACK within 2s)`, 'warn');
      return null;
    }
    at = arrive;
    at = packet(to, from, transport(to, `TCP SYN-ACK → ${nodeOf[from].address}`, 60));
    events.push({ type: 'log', t: at, src: from, level: 'ok', msg: `tunnel probe peer_ip=${peer.address} rtt_ms=${ms}`, rtt: ms });
    wait(250);
    return ms;
  };

  const handshake = (initiator, { responds = true, attempt = 1 } = {}) => {
    const other = initiator === 'A' ? 'B' : 'A';
    const arrive = packet(initiator, other, {
      channel: 'tunnel',
      kind: 'init',
      label: 'Handshake Initiation · 148 B',
      bytes: 148,
      drop: !responds,
      fields: [
        ['message', 'Handshake Initiation (type 1)'],
        ['protocol', 'Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s'],
        ['sender_index', initiator === 'A' ? idxA : idxB],
        ['unencrypted_ephemeral', `${b64(32)} (32 B)`],
        ['encrypted_static', '48 B (initiator public key, AEAD)'],
        ['encrypted_timestamp', '28 B (TAI64N, replay protection)'],
        ['mac1 / mac2', '16 B / 16 B'],
        ['attempt', String(attempt)],
      ],
    });
    if (!responds) {
      at = arrive;
      log(initiator, `handshake did not complete after 5 seconds, retrying (try ${attempt + 1})`, 'warn');
      return false;
    }
    at = arrive;
    at = packet(other, initiator, {
      channel: 'tunnel',
      kind: 'resp',
      label: 'Handshake Response · 92 B',
      bytes: 92,
      fields: [
        ['message', 'Handshake Response (type 2)'],
        ['sender_index', other === 'A' ? idxA : idxB],
        ['receiver_index', initiator === 'A' ? idxA : idxB],
        ['unencrypted_ephemeral', `${b64(32)} (32 B)`],
        ['encrypted_nothing', '16 B (AEAD tag only)'],
        ['mac1 / mac2', '16 B / 16 B'],
      ],
    });
    log(initiator, 'session keys derived · ChaCha20-Poly1305 · rekey after 120 s', 'ok');
    // The initiator must send first so the responder can confirm the session.
    at = packet(initiator, other, transport(initiator, '', 0));
    log(other, `handshake complete with ${nodeOf[initiator].name}`, 'ok');
    // The PCs now share a session (tunnel up); the server still says "connecting"
    // until telemetry brings evidence of the handshake.
    state({ link: 'connecting', tunnel: 'up', handshakeAt: at });
    wait(200);
    return true;
  };

  const telemetry = (dev, { failed = false, loss = 0, connected = true } = {}) => {
    const peer = nodeOf[dev === 'A' ? 'B' : 'A'];
    const req = {
      label: 'POST /agent/telemetry',
      bytes: 1180,
      fields: [
        ...signed(dev, 'POST', '/api/v1/agent/telemetry', 1180),
        ['interface', 'nexlink-userspace · up · source wireguard-go'],
        ['peer', `${peer.name} · handshake ${connected ? '2s ago' : 'never'} · rx/tx counted`],
        ['measurement', loss ? `tcp_rtt + packet_loss=${loss}%` : 'tcp_rtt (valid, 1 sample)'],
      ],
    };
    if (failed) {
      at = packet(dev, 'CP', { channel: 'control', kind: 'http', drop: true, ...req });
      log(dev, 'telemetry failed: dial tcp :4000: connection refused (will retry)', 'warn');
      wait(150);
      return;
    }
    http(dev, req, { label: '202 Accepted', bytes: 96, fields: [['status', '202 Accepted'], ['stored', 'peer observation + measurement']] });
    log(dev, `telemetry sent interface=up source=wireguard-go peers=1${loss ? ` loss=${loss}%` : ''}`);
  };

  // ── 1 · enrollment ────────────────────────────────────────────────
  phase('enroll');
  state({ a: 'enrolling', b: 'enrolling', link: 'none', cp: 'up' });
  log('CP', `network ${a.network} · two one-time tokens issued (15 min, stored as hashes)`);
  wait(400);
  for (const dev of ['A', 'B']) {
    const n = nodeOf[dev];
    log(dev, 'generated Ed25519 identity key + X25519 WireGuard key locally');
    http(
      dev,
      {
        label: 'POST /agent/enroll',
        bytes: 612,
        fields: [
          ['method', 'POST /api/v1/agent/enroll'],
          ['token', 'nxe_•••••••• (single use)'],
          ['identityPublicKey', `${b64(32)}`],
          ['wireguardPublicKey', `${b64(32)}`],
          ['proof', 'Ed25519 signature over token + keys + timestamp'],
        ],
      },
      {
        label: `201 · ${n.address}`,
        bytes: 340,
        fields: [
          ['status', '201 Created'],
          ['deviceId', n.id],
          ['address', `${n.address}/32 in ${a.cidr}`],
          ['token', 'consumed atomically'],
        ],
      },
    );
    log(dev, `enrolled as "${n.name}" address=${n.address}`, 'ok');
    state(dev === 'A' ? { a: 'online' } : { b: 'online' });
  }

  // ── 2 · peer configuration ────────────────────────────────────────
  phase('config');
  state({ link: 'configured' });
  for (const dev of ['A', 'B']) {
    const peer = nodeOf[dev === 'A' ? 'B' : 'A'];
    http(
      dev,
      { label: 'GET /agent/config', bytes: 420, fields: signed(dev, 'GET', '/api/v1/agent/config', 0) },
      {
        label: `200 · peer ${peer.name}`,
        bytes: 760,
        fields: [
          ['status', '200 OK · configVersion 4'],
          ['peer.publicKey', b64(32)],
          ['peer.allowedIPs', `${peer.address}/32`],
          ['peer.endpoint', peer.endpoint],
          ['persistentKeepalive', '25 s'],
        ],
      },
    );
    log(dev, `tunnel peers updated peers=${peer.name}@${peer.endpoint}`);
  }

  // ── 3 · handshake ─────────────────────────────────────────────────
  phase('handshake');
  if (scenario === 'offline') {
    state({ b: 'offline' });
    log('B', 'PC switched off — agent stopped', 'warn');
    wait(300);
    for (let i = 1; i <= 3; i++) {
      handshake('A', { responds: false, attempt: i });
      wait(900);
    }
    phase('telemetry');
    telemetry('A', { connected: false });
    state({ link: 'connecting' });
    log('CP', `link ${a.name} ⇄ ${b.name}: configured, no handshake evidence → not shown as connected`, 'warn');
    wait(600);
    phase('event');
    log('CP', `incident detected: peer handshake stale (${a.name} → ${b.name}) · heartbeats from ${b.name} stopped`, 'error');
    state({ link: 'unreachable' });
    log('CP', 'diagnosis: read-only evidence collected; proposes run_connectivity_test (needs approval)');
    wait(1200);
    return finish();
  }
  handshake('A');

  // ── 4 · encrypted traffic ─────────────────────────────────────────
  phase('traffic');
  const lossPlan = scenario === 'loss' ? [false, true, false, false, true, false] : [false, false, false, false];
  let lost = 0;
  lossPlan.forEach((drop, i) => {
    if (probe(i % 2 === 0 ? 'A' : 'B', { lost: drop }) === null) lost += 1;
  });

  // ── 5 · telemetry → server marks the link from evidence ───────────
  phase('telemetry');
  const lossPct = Math.round((lost / lossPlan.length) * 100);
  telemetry('A', { loss: lossPct });
  telemetry('B', { loss: lossPct });
  if (lossPct > 0) {
    state({ link: 'degraded' });
    log('CP', `link ${a.name} ⇄ ${b.name}: handshake fresh but loss ${lossPct}% → degraded`, 'warn');
  } else {
    state({ link: 'connected' });
    log('CP', `link ${a.name} ⇄ ${b.name}: fresh handshake observed → connected · direct`, 'ok');
  }
  wait(500);

  // ── 6 · scenario event ────────────────────────────────────────────
  phase('event');
  if (scenario === 'cpdown') {
    state({ cp: 'down' });
    log('CP', 'control plane stopped', 'error');
    wait(400);
    telemetry('A', { failed: true });
    probe('A');
    telemetry('B', { failed: true });
    probe('B');
    log('A', 'tunnel keeps working without the server: keys are already on both PCs', 'ok');
    wait(300);
    at = packet('A', 'B', transport('A', '', 0));
    wait(600);
  } else if (scenario === 'revoke') {
    log('CP', `admin revoked ${b.name} (reason: lost laptop) · audit: device.revoke`, 'warn');
    state({ revoked: true });
    wait(400);
    at = packet('B', 'CP', { channel: 'control', kind: 'http', label: 'POST /agent/heartbeat', bytes: 380, fields: signed('B', 'POST', '/api/v1/agent/heartbeat', 120) });
    at = packet('CP', 'B', { channel: 'control', kind: 'http-err', label: '403 DEVICE_REVOKED', bytes: 110, fields: [['status', '403 Forbidden'], ['error', 'DEVICE_REVOKED — signature no longer accepted']] });
    log('B', 'agent stopped: DEVICE_REVOKED', 'error');
    state({ b: 'revoked' });
    wait(200);
    http('A', { label: 'GET /agent/config', bytes: 420, fields: signed('A', 'GET', '/api/v1/agent/config', 0) }, { label: '200 · peers: none', bytes: 210, fields: [['status', '200 OK · configVersion 5'], ['peers', '[] (revoked peer removed)']] });
    log('A', `tunnel peers updated peers= (removed ${b.name}) · session keys wiped`, 'warn');
    state({ link: 'none', tunnel: 'down' });
    wait(800);
  } else {
    // steady state: keepalives + periodic probes
    log('A', 'steady state: persistent keepalive every 25 s, probe every 60 s, rekey every 120 s');
    for (let i = 0; i < 2; i++) {
      at = packet('A', 'B', transport('A', '', 0));
      wait(300);
      probe(i ? 'B' : 'A', { lost: scenario === 'loss' && i === 1 });
    }
    telemetry('A', { loss: scenario === 'loss' ? 25 : 0 });
  }
  return finish();

  function finish() {
    events.sort((x, y) => x.t - y.t);
    const end = Math.max(...events.map((e) => e.t + (e.dur || 0))) + 800;
    return { events, duration: end };
  }
}
