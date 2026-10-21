'use client';

/**
 * Realistic Theme-Matched SVG Simulation Scene for NexLink Protocol Replay.
 * Renders realistic laptops (PC-A and PC-B), an enterprise rackmount Control Plane server,
 * a high-gain Wi-Fi 6 gateway access point, and a multi-layered encrypted WireGuard tunnel
 * with holographic telemetry packets.
 */

const W = 1000;
const H = 560;

export const POS = {
  A: { x: 160, y: 430 },
  B: { x: 840, y: 430 },
  CP: { x: 500, y: 92 },
  AP: { x: 500, y: 332 },
};

const CURVE = { x: 500, y: 236 }; // Bezier apex for WireGuard tunnel

const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
const bez = (p, c, q, t) => ({
  x: (1 - t) ** 2 * p.x + 2 * (1 - t) * t * c.x + t ** 2 * q.x,
  y: (1 - t) ** 2 * p.y + 2 * (1 - t) * t * c.y + t ** 2 * q.y,
});

// Control traffic anchors: server bottom & laptop top edges
const ctlAnchor = (n) =>
  n === 'CP'
    ? { x: POS.CP.x, y: POS.CP.y + 44 }
    : { x: POS[n].x + (n === 'A' ? 40 : -40), y: POS[n].y - 62 };

export function packetPoint(pk, progress) {
  if (pk.channel === 'tunnel') {
    const from = POS[pk.from];
    const to = POS[pk.to];
    return bez(from, CURVE, to, progress);
  }
  return lerp(ctlAnchor(pk.from), ctlAnchor(pk.to), progress);
}

const COLORS = {
  http: { fill: '#141414', border: '#FFFFFF', text: '#FFFFFF', tag: 'HTTP' },
  'http-res': { fill: '#1E1E1E', border: '#808080', text: '#D4D4D4', tag: 'RESP' },
  'http-err': { fill: '#2A0D0D', border: '#FF5A36', text: '#FF5A36', tag: 'ERR' },
  init: { fill: '#162208', border: '#C7FF2E', text: '#C7FF2E', tag: 'WG-INIT' },
  resp: { fill: '#162208', border: '#C7FF2E', text: '#C7FF2E', tag: 'WG-RESP' },
  data: { fill: '#132107', border: '#C7FF2E', text: '#FFFFFF', tag: 'WG-DATA' },
  keepalive: { fill: '#0E1F1A', border: '#50E3C2', text: '#50E3C2', tag: 'KEEPALIVE' },
};

/** High-tech holographic packet pod with particle motion streak */
function Packet({ pk }) {
  const { progress } = pk;
  const c = COLORS[pk.kind] || COLORS.http;
  const dropAt = 0.55;

  if (pk.drop && progress > dropAt) {
    const p = packetPoint(pk, dropAt);
    const fade = Math.max(0, 1 - (progress - dropAt) / (1 - dropAt));
    return (
      <g transform={`translate(${p.x},${p.y})`} opacity={fade}>
        <circle r={28} fill="none" stroke="#FF5A36" strokeWidth={1.5} opacity={0.6} className="anim-ping" />
        <circle r={14} fill="#FF5A36" opacity={0.25} />
        <path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#FF5A36" strokeWidth={3} strokeLinecap="round" />
        <g transform="translate(0, -28)">
          <rect x={-44} y={-10} width={88} height={20} rx={6} fill="#1a0907" stroke="#FF5A36" strokeWidth={1.2} />
          <text y={4} textAnchor="middle" className="font-mono" fontSize={10} fontWeight={700} fill="#FF5A36">
            ✕ PKT DROPPED
          </text>
        </g>
      </g>
    );
  }

  const p = packetPoint(pk, progress);
  const prevT = Math.max(0, progress - 0.04);
  const pTrail = packetPoint(pk, prevT);
  const dx = p.x - pTrail.x;
  const dy = p.y - pTrail.y;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  // Width = tag column + label text (monospace ~6.1px per char at 10px) + padding.
  const tagW = c.tag.length * 5.2 + 16;
  const labelW = tagW + pk.label.length * 6.1 + 16;
  const above = pk.channel === 'tunnel' && pk.from === 'B' ? 24 : -38;

  return (
    <g transform={`translate(${p.x},${p.y})`}>
      {/* Directional Comet Particle Tail */}
      <g transform={`rotate(${angle})`}>
        <line x1={-32} y1={0} x2={0} y2={0} stroke={c.border} strokeWidth={2.5} strokeLinecap="round" opacity={0.5} />
        <line x1={-20} y1={0} x2={0} y2={0} stroke="#FFFFFF" strokeWidth={1} strokeLinecap="round" opacity={0.8} />
      </g>

      {/* Energy core orb */}
      <circle r={12} fill={c.border} opacity={0.25} filter="url(#glow-blur)" />
      <circle r={6} fill={c.fill} stroke={c.border} strokeWidth={2} />
      <circle r={2.5} fill="#FFFFFF" />

      {/* Holographic capsule badge */}
      <g transform={`translate(0,${above})`}>
        <rect
          x={-labelW / 2}
          y={-11}
          width={labelW}
          height={22}
          rx={11}
          fill={c.fill}
          stroke={c.border}
          strokeWidth={1.4}
          filter="url(#card-shadow)"
        />
        {/* Tiny tag indicator */}
        <text x={-labelW / 2 + 10} y={4} className="font-mono" fontSize={8} fontWeight={700} fill={c.border}>
          {c.tag}
        </text>
        <line x1={-labelW / 2 + tagW} y1={-7} x2={-labelW / 2 + tagW} y2={7} stroke={c.border} strokeWidth={0.8} opacity={0.35} />
        <text x={-labelW / 2 + tagW + 8} y={4} className="font-mono" fontSize={10} fontWeight={600} fill={c.text}>
          {pk.label}
        </text>
      </g>
    </g>
  );
}

/** Realistic Laptop Workstation with terminal screen, glowing keyboard, and status HUD */
function RealisticLaptop({ id, node, status }) {
  const { x, y } = POS[id];
  const off = status === 'offline';
  const revoked = status === 'revoked';
  const online = status === 'online';
  const statusColor = revoked ? '#FF5A36' : off ? '#666666' : online ? '#C7FF2E' : '#E3B341';

  return (
    <g transform={`translate(${x},${y})`}>
      {/* Drop shadow on desk */}
      <ellipse cx={0} cy={54} rx={118} ry={14} fill="#000000" opacity={0.65} filter="url(#blur-lg)" />

      {/* === SCREEN LID === */}
      {/* Display outer metallic shell with chamfer */}
      <rect
        x={-96}
        y={-84}
        width={192}
        height={116}
        rx={10}
        fill="url(#laptop-lid-grad)"
        stroke={revoked ? '#FF5A36' : '#333333'}
        strokeWidth={1.8}
        filter="url(#card-shadow)"
      />

      {/* Screen inner bezel */}
      <rect x={-90} y={-78} width={180} height={104} rx={6} fill="#0A0A0A" />

      {/* Top Webcam Notch & Green Privacy LED */}
      <circle cx={0} cy={-72} r={2} fill="#181818" stroke="#2B2B2B" strokeWidth={0.6} />
      <circle cx={6} cy={-72} r={1} fill={off ? '#333333' : '#C7FF2E'} opacity={0.9} />

      {/* Active Screen Display (Glass panel) */}
      <rect
        x={-85}
        y={-66}
        width={170}
        height={88}
        rx={4}
        fill={revoked ? '#1A0A0A' : off ? '#080808' : '#0B0F14'}
        stroke={revoked ? '#FF5A36' : '#1C2630'}
        strokeWidth={1}
      />

      {/* Terminal Title Bar */}
      <rect x={-85} y={-66} width={170} height={14} rx={4} fill="#11161D" />
      <circle cx={-76} cy={-59} r={2.5} fill="#FF5A36" opacity={0.8} />
      <circle cx={-68} cy={-59} r={2.5} fill="#E3B341" opacity={0.8} />
      <circle cx={-60} cy={-59} r={2.5} fill="#C7FF2E" opacity={0.8} />
      <text x={-50} y={-56} className="font-mono" fontSize={8} fill="#7A8699" letterSpacing="0.5">
        {node.name} :: nexlink-agent
      </text>

      {/* Screen terminal content / telemetry */}
      {revoked ? (
        <g>
          <path d="M-10 -35 L10 -35 L0 -50 Z" fill="#FF5A36" opacity={0.25} />
          <text y={-30} textAnchor="middle" className="font-mono" fontSize={11} fontWeight={700} fill="#FF5A36">
            [ACCESS REVOKED]
          </text>
          <text y={-14} textAnchor="middle" className="font-mono" fontSize={8} fill="#FF8A70">
            403 DEVICE_REVOKED
          </text>
          <text y={0} textAnchor="middle" className="font-mono" fontSize={8} fill="#808080">
            PEER KEY REMOVED FROM CONFIG
          </text>
        </g>
      ) : off ? (
        <g opacity={0.4}>
          <text y={-24} textAnchor="middle" className="font-mono" fontSize={10} fill="#808080">
            AGENT OFFLINE
          </text>
          <text y={-8} textAnchor="middle" className="font-mono" fontSize={8} fill="#555555">
            DAEMON PROCESS STOPPED
          </text>
        </g>
      ) : (
        <g>
          <text x={-78} y={-44} className="font-mono" fontSize={8.5} fill="#7A8699">
            &gt; nexlink-agent run --userspace
          </text>
          <text x={-78} y={-32} className="font-mono" fontSize={9} fontWeight={600} fill="#C7FF2E">
            nexlink-userspace · {node.address}
          </text>
          <text x={-78} y={-21} className="font-mono" fontSize={8} fill="#808080">
            wireguard-go · udp 51820
          </text>

          {/* Mini Sparkline network traffic pulse */}
          <path
            d="M-78 -6 Q-66 -16 -54 -10 T-30 -14 T-6 -8 T18 -16 T42 -10 T66 -14 T78 -8"
            fill="none"
            stroke="#C7FF2E"
            strokeWidth={1.2}
            opacity={0.8}
          />
          <path
            d="M-78 -6 Q-66 -16 -54 -10 T-30 -14 T-6 -8 T18 -16 T42 -10 T66 -14 T78 -8 L78 6 L-78 6 Z"
            fill="url(#spark-area)"
            opacity={0.25}
          />

        </g>
      )}

      {/* Screen Glass Reflection Sheen */}
      <path d="M-85 -66 L-20 -66 L-60 22 L-85 22 Z" fill="url(#screen-sheen)" opacity={0.12} />

      {/* === LOWER KEYBOARD BASE === */}
      {/* Unibody chassis base (perspective wedge) */}
      <path
        d="M-106 32 L106 32 L120 52 L-120 52 Z"
        fill="url(#laptop-deck-grad)"
        stroke="#2E2E2E"
        strokeWidth={1.2}
      />
      {/* Front edge chamfer */}
      <line x1={-120} y1={52} x2={120} y2={52} stroke="#444444" strokeWidth={1} />
      <rect x={-18} y={50} width={36} height={2} rx={1} fill="#141414" />

      {/* Recessed keyboard well */}
      <path d="M-92 34 L92 34 L98 44 L-98 44 Z" fill="#0C0C0C" stroke="#1A1A1A" strokeWidth={0.8} />

      {/* Backlit Keycap Rows */}
      {[-82, -66, -50, -34, -18, -2, 14, 30, 46, 62, 78].map((kx) => (
        <rect key={`k1-${kx}`} x={kx} y={35.5} width={10} height={2.5} rx={0.6} fill="#1C1C1C" stroke="#2A2A2A" strokeWidth={0.4} />
      ))}
      {[-86, -70, -54, -38, -22, -6, 10, 26, 42, 58, 74].map((kx) => (
        <rect key={`k2-${kx}`} x={kx} y={39.5} width={11} height={3} rx={0.6} fill="#1F1F1F" stroke="#303030" strokeWidth={0.4} />
      ))}
      {/* Spacebar & modifier keys */}
      <rect x={-20} y={43.5} width={40} height={2} rx={0.5} fill="#242424" stroke="#383838" strokeWidth={0.4} />

      {/* Precision Glass Trackpad */}
      <path d="M-26 46 L26 46 L30 50 L-30 50 Z" fill="#181818" stroke="#333333" strokeWidth={0.7} />

      {/* Power / Status Indicator LED */}
      <circle cx={-108} cy={42} r={2} fill={statusColor} filter="url(#glow-blur)" />
      <circle cx={-108} cy={42} r={1.2} fill={statusColor} />

      {/* Side Ports (USB-C & LAN indicators) */}
      <rect x={-115} y={40} width={2} height={4} rx={0.5} fill="#444444" />
      <rect x={113} y={40} width={2} height={4} rx={0.5} fill="#444444" />

      {/* === BADGE & LABELS UNDER LAPTOP === */}
      <g transform="translate(0, 72)">
        <rect x={-76} y={-10} width={152} height={20} rx={10} fill="#141414" stroke="#2E2E2E" strokeWidth={1} />
        <circle cx={-62} cy={0} r={3.5} fill={statusColor} />
        <text x={-52} y={3} className="font-mono" fontSize={10} fontWeight={700} fill="#FFFFFF">
          {node.name}
        </text>
        <text x={64} y={3} textAnchor="end" className="font-mono" fontSize={9} fill={statusColor} letterSpacing="0.8">
          {(status || 'idle').toUpperCase()}
        </text>
      </g>
      <text y={92} textAnchor="middle" className="font-mono" fontSize={10} fill="#808080">
        udp {node.endpoint}
      </text>
    </g>
  );
}

/** Realistic 19" 2U Rackmount Control Plane Server with hot-swap bays and OLED screen */
function RealisticControlPlane({ down }) {
  const { x, y } = POS.CP;
  const statusColor = down ? '#FF5A36' : '#C7FF2E';

  return (
    <g transform={`translate(${x},${y})`}>
      {/* Outer ambient glow */}
      <rect
        x={-176}
        y={-46}
        width={352}
        height={92}
        rx={10}
        fill={statusColor}
        opacity={down ? 0.12 : 0.06}
        filter="url(#glow-blur)"
      />

      {/* Server Chassis 2U Faceplate */}
      <rect
        x={-156}
        y={-44}
        width={312}
        height={88}
        rx={6}
        fill="url(#server-faceplate-grad)"
        stroke={down ? '#FF5A36' : '#383838'}
        strokeWidth={1.8}
        filter="url(#card-shadow)"
      />

      {/* Left Rack Mounting Ear with Torx Hex Screws */}
      <rect x={-172} y={-44} width={16} height={88} rx={3} fill="#202020" stroke="#333333" strokeWidth={1} />
      <circle cx={-164} cy={-28} r={4} fill="#141414" stroke="#444444" strokeWidth={1} />
      <path d="M-167 -28 L-161 -28 M-164 -31 L-164 -25" stroke="#666666" strokeWidth={1} />
      <circle cx={-164} cy={28} r={4} fill="#141414" stroke="#444444" strokeWidth={1} />
      <path d="M-167 28 L-161 28 M-164 25 L-164 31" stroke="#666666" strokeWidth={1} />

      {/* Right Rack Mounting Ear */}
      <rect x={156} y={-44} width={16} height={88} rx={3} fill="#202020" stroke="#333333" strokeWidth={1} />
      <circle cx={164} cy={-28} r={4} fill="#141414" stroke="#444444" strokeWidth={1} />
      <path d="M161 -28 L167 -28 M164 -31 L164 -25" stroke="#666666" strokeWidth={1} />
      <circle cx={164} cy={28} r={4} fill="#141414" stroke="#444444" strokeWidth={1} />
      <path d="M161 28 L167 28 M164 25 L164 31" stroke="#666666" strokeWidth={1} />

      {/* Hexagonal / slotted ventilation intake mesh on sides */}
      <g opacity={0.35}>
        {[-38, -26, -14, -2, 10, 22, 34].map((sy) => (
          <line key={sy} x1={-150} y1={sy} x2={-136} y2={sy} stroke="#FFFFFF" strokeWidth={1.5} strokeDasharray="2 3" />
        ))}
      </g>

      {/* Hot-Swap Enterprise Storage Drive Trays (Left Section) */}
      {[0, 1, 2, 3].map((i) => {
        const dy = -36 + i * 19;
        return (
          <g key={i} transform={`translate(-130, ${dy})`}>
            <rect x={0} y={0} width={74} height={15} rx={2} fill="#121212" stroke="#282828" strokeWidth={0.8} />
            {/* Drive Handle Latch */}
            <rect x={2} y={2} width={12} height={11} rx={1} fill="#1E1E1E" stroke="#333333" strokeWidth={0.5} />
            <text x={20} y={11} className="font-mono" fontSize={8} fill="#808080">
              NVMe-{`0${i + 1}`}
            </text>
            {/* Drive Activity & Status LEDs */}
            <circle cx={62} cy={7.5} r={1.6} fill={down ? '#FF5A36' : '#C7FF2E'} opacity={0.9} />
            <circle
              cx={68}
              cy={7.5}
              r={1.6}
              fill={down ? '#FF5A36' : '#C7FF2E'}
              className={down ? '' : i % 2 === 0 ? 'led-blink-fast' : 'led-blink-slow'}
            />
          </g>
        );
      })}

      {/* Center High-Contrast OLED Management Display */}
      <g transform="translate(-46, -36)">
        <rect
          x={0}
          y={0}
          width={124}
          height={72}
          rx={4}
          fill="#06080A"
          stroke={down ? '#FF5A36' : '#1F341F'}
          strokeWidth={1.2}
        />
        {/* OLED Screen Content */}
        {down ? (
          <g>
            <rect x={0} y={0} width={124} height={16} rx={4} fill="#2E0E0E" />
            <text x={62} y={12} textAnchor="middle" className="font-mono" fontSize={9} fontWeight={700} fill="#FF5A36">
              SYSTEM HALTED
            </text>
            <text x={62} y={34} textAnchor="middle" className="font-mono" fontSize={9} fill="#FF5A36">
              PORT :4000 OFFLINE
            </text>
            <text x={62} y={48} textAnchor="middle" className="font-mono" fontSize={7.5} fill="#808080">
              CLUSTER DISCONNECTED
            </text>
            <text x={62} y={62} textAnchor="middle" className="font-mono" fontSize={7.5} fill="#FF5A36">
              ALERT: DAEMON DOWN
            </text>
          </g>
        ) : (
          <g>
            <rect x={0} y={0} width={124} height={15} rx={4} fill="#0E1A11" />
            <circle cx={8} cy={7.5} r={2} fill="#C7FF2E" />
            <text x={14} y={11} className="font-mono" fontSize={8} fontWeight={700} fill="#C7FF2E">
              NEXLINK CP :: :4000
            </text>
            <text x={8} y={27} className="font-mono" fontSize={8} fill="#D4D4D4">
              PEERS: 2 SYNCHRONIZED
            </text>
            <text x={8} y={39} className="font-mono" fontSize={7.5} fill="#808080">
              AUTH: ED25519 SIGNED
            </text>
            <text x={8} y={51} className="font-mono" fontSize={7.5} fill="#808080">
              DB: MONGODB
            </text>
            {/* CPU / Load mini bars */}
            <rect x={8} y={59} width={50} height={4} rx={1} fill="#181818" />
            <rect x={8} y={59} width={28} height={4} rx={1} fill="#C7FF2E" />
            <rect x={66} y={59} width={50} height={4} rx={1} fill="#181818" />
            <rect x={66} y={59} width={38} height={4} rx={1} fill="#64D2FF" />
          </g>
        )}
      </g>

      {/* Right Section: SFP+ 10G Fiber Transceiver Cages & Dual PSUs */}
      <g transform="translate(86, -36)">
        {/* Dual SFP+ Optical Cages */}
        <rect x={0} y={0} width={58} height={32} rx={3} fill="#101010" stroke="#2B2B2B" strokeWidth={1} />
        <rect x={6} y={6} width={20} height={20} rx={1} fill="#1C1C1C" stroke="#3D3D3D" strokeWidth={0.8} />
        <rect x={32} y={6} width={20} height={20} rx={1} fill="#1C1C1C" stroke="#3D3D3D" strokeWidth={0.8} />
        {/* SFP+ fiber optic laser links */}
        <circle cx={16} cy={16} r={3} fill={down ? '#444444' : '#64D2FF'} filter="url(#glow-blur)" />
        <circle cx={16} cy={16} r={1.5} fill="#FFFFFF" />
        <circle cx={42} cy={16} r={3} fill={down ? '#444444' : '#C7FF2E'} filter="url(#glow-blur)" />
        <circle cx={42} cy={16} r={1.5} fill="#FFFFFF" />
        <text x={29} y={39} textAnchor="middle" className="font-mono" fontSize={7.5} fill="#808080">
          10G SFP+ OPTIC
        </text>

        {/* Dual Redundant PSU Status */}
        <g transform="translate(0, 48)">
          <rect x={0} y={0} width={26} height={16} rx={2} fill="#141414" stroke="#2B2B2B" strokeWidth={0.6} />
          <text x={13} y={9} textAnchor="middle" className="font-mono" fontSize={6} fill="#808080">
            PSU1
          </text>
          <circle cx={13} cy={12.5} r={1.5} fill={down ? '#FF5A36' : '#C7FF2E'} />

          <rect x={32} y={0} width={26} height={16} rx={2} fill="#141414" stroke="#2B2B2B" strokeWidth={0.6} />
          <text x={45} y={9} textAnchor="middle" className="font-mono" fontSize={6} fill="#808080">
            PSU2
          </text>
          <circle cx={45} cy={12.5} r={1.5} fill={down ? '#FF5A36' : '#C7FF2E'} />
        </g>
      </g>

      {/* Label under server */}
      <g transform="translate(0, 56)">
        <text y={6} textAnchor="middle" className="font-mono" fontSize={11} fontWeight={700} fill="#FFFFFF" letterSpacing="0.8">
          CONTROL PLANE HUB
        </text>
        <text y={18} textAnchor="middle" className="font-mono" fontSize={9} fill="#808080">
          signed REST · central key exchange · peer discovery
        </text>
      </g>
    </g>
  );
}

/** Realistic High-Gain Wi-Fi 6 Gateway Access Point with radiating radio pulses */
function RealisticAccessPoint() {
  const { x, y } = POS.AP;

  return (
    <g transform={`translate(${x},${y})`}>
      {/* Expanding Concentric RF Beamforming Wave Ripples */}
      <circle r={36} fill="none" stroke="#C7FF2E" strokeWidth={1.8} className="radio-wave-1" />
      <circle r={56} fill="none" stroke="#64D2FF" strokeWidth={1.4} className="radio-wave-2" />
      <circle r={76} fill="none" stroke="#C7FF2E" strokeWidth={1.0} className="radio-wave-3" />

      {/* 4 High-Gain Beamforming Antennas with brass swivels */}
      {[
        { angle: -65, len: 44 },
        { angle: -25, len: 48 },
        { angle: 25, len: 48 },
        { angle: 65, len: 44 },
      ].map(({ angle, len }, idx) => (
        <g key={idx} transform={`rotate(${angle})`}>
          {/* Swivel Mount */}
          <circle cx={0} cy={-24} r={3.5} fill="#D4AF37" stroke="#8C7320" strokeWidth={0.6} />
          {/* Antenna Mast */}
          <line x1={0} y1={-24} x2={0} y2={-24 - len} stroke="#1C1C1C" strokeWidth={4} strokeLinecap="round" />
          <line x1={0} y1={-24} x2={0} y2={-24 - len} stroke="#383838" strokeWidth={2} strokeLinecap="round" />
          {/* Antenna Tip Highlight */}
          <circle cx={0} cy={-24 - len} r={1.5} fill="#C7FF2E" opacity={0.8} />
        </g>
      ))}

      {/* Main Gateway Hub Enclosure (Sleek dark hexagon/puck) */}
      <circle r={28} fill="url(#ap-body-grad)" stroke="#383838" strokeWidth={2} filter="url(#card-shadow)" />
      <circle r={23} fill="#0F0F0F" stroke="#242424" strokeWidth={1} />

      {/* Inner illuminated logo emblem */}
      <circle r={12} fill="#141B12" stroke="#C7FF2E" strokeWidth={1.2} />
      {/* Wi-Fi Wave glyph in center */}
      <path d="M-6 -2 A9 9 0 0 1 6 -2" fill="none" stroke="#C7FF2E" strokeWidth={1.6} strokeLinecap="round" />
      <path d="M-3.5 1 A5 5 0 0 1 3.5 1" fill="none" stroke="#C7FF2E" strokeWidth={1.6} strokeLinecap="round" />
      <circle cx={0} cy={5} r={1.4} fill="#C7FF2E" />

      {/* Status LED Bar */}
      <g transform="translate(0, 18)">
        {[-8, -4, 0, 4, 8].map((lx, i) => (
          <circle key={i} cx={lx} cy={0} r={1} fill={i === 1 ? '#64D2FF' : '#C7FF2E'} opacity={0.9} />
        ))}
      </g>

      {/* Subtitles & specs under AP */}
      <g transform="translate(0, 42)">
        <text y={0} textAnchor="middle" className="font-mono" fontSize={10} fontWeight={700} fill="#FFFFFF" letterSpacing="1">
          WI-FI 6 GATEWAY
        </text>
        <text y={12} textAnchor="middle" className="font-mono" fontSize={8.5} fill="#808080">
          802.11ax · 51820/UDP PASSTHROUGH
        </text>
      </g>
    </g>
  );
}

const CAPTION_Y = 286;

/** Multi-layered holographic WireGuard tunnel conduit */
function RealisticTunnel({ link, tunnel }) {
  const d = `M${POS.A.x} ${POS.A.y} Q${CURVE.x} ${CURVE.y} ${POS.B.x} ${POS.B.y}`;

  if (tunnel !== 'up' && (!link || link === 'none')) return null;

  if (tunnel !== 'up') {
    const stroke = link === 'unreachable' ? '#FF5A36' : link === 'connecting' ? '#C7FF2E' : '#808080';
    return (
      <g>
        <path d={d} fill="none" stroke={stroke} strokeWidth={2.5} strokeDasharray={link === 'configured' ? '4 8' : '10 8'} opacity={0.7} />
        <g transform={`translate(500, ${CAPTION_Y})`}>
          <rect x={-140} y={-11} width={280} height={22} rx={11} fill="#121212" stroke={stroke} strokeWidth={1.2} />
          <text y={4} textAnchor="middle" className="font-mono" fontSize={10} fontWeight={700} fill={stroke} letterSpacing="1">
            {link === 'configured' ? 'PEERS CONFIGURED · AWAITING HANDSHAKE' : link === 'connecting' ? 'HANDSHAKE IN PROGRESS…' : 'HANDSHAKE TIMEOUT · UNREACHABLE'}
          </text>
        </g>
      </g>
    );
  }

  const isDegraded = link === 'degraded';
  const color = isDegraded ? '#FFB800' : '#C7FF2E';

  return (
    <g>
      {/* Outer energy conduit glow */}
      <path d={d} fill="none" stroke={color} strokeWidth={32} opacity={0.06} filter="url(#glow-blur)" />
      {/* Secondary containment beam */}
      <path d={d} fill="none" stroke={color} strokeWidth={14} opacity={0.12} />
      {/* Core laser data conduit */}
      <path d={d} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray="16 10" className="sim-flow" />

      {/* Floating Cryptographic Security Badge */}
      <g transform={`translate(500, ${CAPTION_Y})`}>
        <rect
          x={-165}
          y={-14}
          width={330}
          height={28}
          rx={14}
          fill="#111611"
          stroke={color}
          strokeWidth={1.4}
          filter="url(#card-shadow)"
        />
        {/* Lock glyph */}
        <path
          d="M-146 -3 L-146 -6 A4 4 0 0 1 -138 -6 L-138 -3 M-148 -3 L-136 -3 L-136 5 L-148 5 Z"
          fill="none"
          stroke={color}
          strokeWidth={1.4}
        />
        <text x={-124} y={3} className="font-mono" fontSize={10} fontWeight={700} fill={color} letterSpacing="0.8">
          {isDegraded ? 'WIREGUARD TUNNEL · DEGRADED (PACKET LOSS)' : 'WIREGUARD TUNNEL · CHACHA20-POLY1305'}
        </text>
      </g>

      <text x={500} y={CAPTION_Y + 22} textAnchor="middle" className="font-mono" fontSize={9} fill="#808080">
        direct peer-to-peer overlay · authenticated 256-bit crypto · UDP 51820
      </text>
    </g>
  );
}

export default function SimulationCanvas({ a, b, st, inflight }) {
  const ctl = (n) => {
    const p = ctlAnchor(n);
    const q = ctlAnchor('CP');
    return `M${p.x} ${p.y} L${q.x} ${q.y}`;
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full select-none"
      role="img"
      aria-label="Real-time simulated NexLink WireGuard network topology"
    >
      <defs>
        {/* Style sheet for realistic hardware & RF animations */}
        <style>{`
          @keyframes radio-expand {
            0% { r: 24px; opacity: 0.85; }
            60% { opacity: 0.35; }
            100% { r: 90px; opacity: 0; }
          }
          @keyframes pulse-fast {
            0%, 100% { opacity: 1; }
            40% { opacity: 0.2; }
          }
          @keyframes pulse-slow {
            0%, 100% { opacity: 0.9; }
            50% { opacity: 0.3; }
          }
          @keyframes ping-loss {
            0% { transform: scale(0.6); opacity: 1; }
            100% { transform: scale(1.6); opacity: 0; }
          }
          .radio-wave-1 { animation: radio-expand 3.2s cubic-bezier(0.15, 0.85, 0.35, 1) infinite; }
          .radio-wave-2 { animation: radio-expand 3.2s cubic-bezier(0.15, 0.85, 0.35, 1) infinite 1.1s; }
          .radio-wave-3 { animation: radio-expand 3.2s cubic-bezier(0.15, 0.85, 0.35, 1) infinite 2.2s; }
          .led-blink-fast { animation: pulse-fast 0.7s infinite; }
          .led-blink-slow { animation: pulse-slow 1.6s infinite; }
          .anim-ping { animation: ping-loss 1.2s ease-out infinite; transform-box: fill-box; transform-origin: center; }

          @media (prefers-reduced-motion: reduce) {
            .radio-wave-1, .radio-wave-2, .radio-wave-3,
            .led-blink-fast, .led-blink-slow, .anim-ping {
              animation: none;
            }
          }
        `}</style>

        {/* Ambient Grid Pattern */}
        <pattern id="sim-grid-fine" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0 L0 0 0 32" fill="none" stroke="#FFFFFF" strokeOpacity="0.04" />
          <circle cx="0" cy="0" r="1" fill="#FFFFFF" fillOpacity="0.1" />
        </pattern>

        {/* Filters */}
        <filter id="glow-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id="blur-lg" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="10" />
        </filter>

        <filter id="card-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#000000" floodOpacity="0.65" />
        </filter>

        {/* Gradients */}
        <linearGradient id="laptop-lid-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#282828" />
          <stop offset="40%" stopColor="#1C1C1C" />
          <stop offset="100%" stopColor="#101010" />
        </linearGradient>

        <linearGradient id="laptop-deck-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2A2A2A" />
          <stop offset="50%" stopColor="#1E1E1E" />
          <stop offset="100%" stopColor="#121212" />
        </linearGradient>

        <linearGradient id="server-faceplate-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#1A1A1A" />
          <stop offset="25%" stopColor="#242424" />
          <stop offset="75%" stopColor="#242424" />
          <stop offset="100%" stopColor="#1A1A1A" />
        </linearGradient>

        <linearGradient id="ap-body-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2C2C2C" />
          <stop offset="100%" stopColor="#141414" />
        </linearGradient>

        <linearGradient id="screen-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.2" />
          <stop offset="40%" stopColor="#FFFFFF" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>

        <linearGradient id="spark-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C7FF2E" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#C7FF2E" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* 1. Base Dark Canvas Fill */}
      <rect width={W} height={H} fill="#0A0C0E" />

      {/* 2. Theme-Matched Generated Cyber Circuit Backdrop */}
      <image
        href="/simulation-bg.jpg"
        x="0"
        y="0"
        width={W}
        height={H}
        preserveAspectRatio="xMidYMid slice"
        opacity="0.22"
        style={{ mixBlendMode: 'screen' }}
      />

      {/* 3. Tech Grid Overlay */}
      <rect width={W} height={H} fill="url(#sim-grid-fine)" />

      {/* 4. HUD Technical Schematics & Corner Brackets */}
      <g opacity={0.45} className="font-mono">
        {/* Top-Left Telemetry */}
        <text x={24} y={32} fontSize={9} fill="#808080" letterSpacing="1">
          SYS // NEXLINK PROTOCOL REPLAY ENGINE
        </text>
        <text x={24} y={46} fontSize={8} fill="#C7FF2E">
          DIRECT P2P DATA PLANE · ZERO-TRUST OVERLAY
        </text>

        {/* Top-Right Telemetry */}
        <text x={W - 24} y={32} textAnchor="end" fontSize={9} fill="#808080" letterSpacing="1">
          CHANNEL // UDP:51820 · HTTPS:4000
        </text>
        <text x={W - 24} y={46} textAnchor="end" fontSize={8} fill="#808080">
          CHACHA20-POLY1305 · ED25519
        </text>

        {/* Corner Targeting Crosshairs */}
        <path d="M16 16 L32 16 M16 16 L16 32" stroke="#C7FF2E" strokeWidth={1} fill="none" opacity={0.6} />
        <path d={`M${W - 16} 16 L${W - 32} 16 M${W - 16} 16 L${W - 16} 32`} stroke="#C7FF2E" strokeWidth={1} fill="none" opacity={0.6} />
        <path d={`M16 ${H - 16} L32 ${H - 16} M16 ${H - 16} L16 ${H - 32}`} stroke="#C7FF2E" strokeWidth={1} fill="none" opacity={0.6} />
        <path d={`M${W - 16} ${H - 16} L${W - 32} ${H - 16} M${W - 16} ${H - 16} L${W - 16} ${H - 32}`} stroke="#C7FF2E" strokeWidth={1} fill="none" opacity={0.6} />
      </g>

      {/* 5. Control Plane Signed Telemetry Beams (A -> CP, B -> CP) */}
      {['A', 'B'].map((n) => (
        <g key={n}>
          <path
            d={ctl(n)}
            fill="none"
            stroke={st.cp === 'down' ? '#FF5A36' : '#555555'}
            strokeWidth={1.8}
            strokeDasharray="6 7"
            opacity={st.cp === 'down' ? 0.35 : 0.65}
            className={st.cp === 'down' ? '' : 'sim-flow-slow'}
          />
        </g>
      ))}

      {/* Control Plane Channel Label */}
      <g transform="translate(260, 230) rotate(-38)">
        <rect x={-64} y={-9} width={128} height={18} rx={9} fill="#141414" stroke="#2B2B2B" strokeWidth={1} opacity={0.85} />
        <text x={0} y={3} textAnchor="middle" className="font-mono" fontSize={8.5} fill="#808080" letterSpacing="0.5">
          control · signed HTTP
        </text>
      </g>
      <g transform="translate(740, 230) rotate(38)">
        <rect x={-64} y={-9} width={128} height={18} rx={9} fill="#141414" stroke="#2B2B2B" strokeWidth={1} opacity={0.85} />
        <text x={0} y={3} textAnchor="middle" className="font-mono" fontSize={8.5} fill="#808080" letterSpacing="0.5">
          control · signed HTTP
        </text>
      </g>

      {/* 6. WireGuard Multi-Layered Tunnel */}
      <RealisticTunnel link={st.link} tunnel={st.tunnel} />

      {/* 7. Enterprise Wi-Fi 6 Gateway Access Point */}
      <RealisticAccessPoint />

      {/* 8. Enterprise Rackmount Control Plane Server */}
      <RealisticControlPlane down={st.cp === 'down'} />

      {/* 9. Realistic Workstation Laptops */}
      <RealisticLaptop id="A" node={a} status={st.a} />
      <RealisticLaptop id="B" node={b} status={st.b} />

      {/* 10. Holographic Telemetry Packets In Flight */}
      {inflight.map((pk) => (
        <Packet key={pk.key} pk={pk} />
      ))}
    </svg>
  );
}
