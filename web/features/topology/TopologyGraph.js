'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, Server } from 'lucide-react';
import { StatusMarker, toneOf } from '@/components/StatusBadge';

const LIME = '#C7FF2E';
const AMBER = '#F2B94B';
const CORAL = '#FF5A36';
const GRAY = '#808080';

/**
 * Edge style encodes evidence, never decoration:
 *   lime, travelling pulse         — connected direct (fresh WireGuard handshake)
 *   lime, long dashes, pulse       — connected through the relay
 *   amber                          — degraded (handshake ok, loss/latency high)
 *   thin dashed lime               — connecting (configured on interface, no handshake yet)
 *   dashed coral                   — unreachable (handshake went stale)
 *   dotted gray                    — configured only / unknown (no evidence either way)
 */
function peerEdge(e) {
  const relay = e.path === 'relay';
  switch (e.state) {
    case 'connected':
      return { style: { stroke: LIME, strokeWidth: 2 }, className: `edge-verified${relay ? ' edge-relay' : ''}`, label: relay ? 'relay' : 'direct', color: LIME };
    case 'degraded':
      return { style: { stroke: AMBER, strokeWidth: 2 }, label: `degraded${relay ? ' · relay' : ''}`, color: AMBER };
    case 'connecting':
      return { style: { stroke: LIME, strokeOpacity: 0.6, strokeWidth: 1.25, strokeDasharray: '4 6' }, label: 'connecting', color: GRAY };
    case 'unreachable':
      return { style: { stroke: CORAL, strokeWidth: 1.5, strokeDasharray: '5 5' }, label: 'unreachable', color: CORAL };
    default:
      return { style: { stroke: GRAY, strokeOpacity: 0.7, strokeWidth: 1, strokeDasharray: '1 5' }, label: e.state === 'unknown' ? 'unknown' : 'configured', color: GRAY };
  }
}

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, border: 0 };

const NODE_TONE = {
  good: 'border-lime/70',
  progress: 'border-lime/40 border-dashed',
  warn: 'border-amber/70',
  bad: 'border-coral/70',
  info: 'border-white/50',
  none: 'border-line-strong',
};

function DeviceNode({ data }) {
  const tone = toneOf(data.status);
  return (
    <div className={`w-[184px] rounded-[8px] border bg-ink-2 ${NODE_TONE[tone]} ${data.changed ? 'status-flash' : ''}`}>
      <Handle type="target" position={Position.Top} style={hidden} />
      <Handle type="source" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <StatusMarker state={data.status} />
        <span className="truncate text-[13px] font-semibold">{data.label}</span>
      </div>
      <div className="px-3 py-2">
        <div className="font-mono text-[11px] text-white/80">{data.address || 'no address'}</div>
        <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-wider text-mid">
          <span className={tone === 'bad' ? 'text-coral' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-lime' : ''}>{data.status.replace(/_/g, ' ')}</span>
          <span>vpn {data.vpnSource === 'simulated' ? 'sim' : data.vpn}</span>
        </div>
      </div>
    </div>
  );
}

function NetworkNode({ data }) {
  return (
    <div className="rounded-[8px] border border-dashed border-white/25 bg-ink px-4 py-2.5">
      <Handle type="target" position={Position.Top} style={hidden} />
      <Handle type="source" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2 text-[13px] font-semibold"><Network className="h-3.5 w-3.5 text-lime" strokeWidth={1.75} />{data.label}</div>
      <div className="font-mono text-[11px] text-mid">{data.cidr}</div>
    </div>
  );
}

function ControlPlaneNode() {
  return (
    <div className="rounded-[8px] border border-white/60 bg-ink-3 px-4 py-2.5">
      <Handle type="target" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2 text-[13px] font-semibold"><Server className="h-3.5 w-3.5" strokeWidth={1.75} />nexlink</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-mid">coordination · relays ciphertext only</div>
    </div>
  );
}

const nodeTypes = { device: DeviceNode, network: NetworkNode, controlPlane: ControlPlaneNode };

function layout(graph) {
  const nets = graph.nodes.filter((n) => n.type === 'network');
  const devsOf = (n) => graph.nodes.filter((d) => d.type === 'device' && d.networkId === n.networkId);
  // Each network gets a column sized by how many devices it holds.
  const widths = nets.map((n) => Math.min(640, Math.max(280, devsOf(n).length * 170)));
  const total = widths.reduce((a, b) => a + b, 0) || 620;
  const pos = new Map([['control-plane', { x: total / 2 - 110, y: 0 }]]);
  let left = 0;
  nets.forEach((n, i) => {
    const cx = left + widths[i] / 2;
    left += widths[i];
    pos.set(n.id, { x: cx - 90, y: 300 });
    const devs = devsOf(n);
    const r = Math.max(170, Math.min(260, widths[i] / 2 - 40));
    devs.forEach((d, j) => {
      // Fan devices out on a half-circle below their network node.
      const angle = devs.length === 1 ? Math.PI / 2 : Math.PI * 0.1 + (j / (devs.length - 1)) * Math.PI * 0.8;
      const rr = r + (devs.length > 6 ? (j % 2) * 90 : 0);
      pos.set(d.id, { x: cx - 92 + Math.cos(angle) * rr, y: 300 + Math.sin(angle) * rr });
    });
  });
  return pos;
}

/** Ids of device nodes whose status differs from the previous graph (real changes only). */
function useChangedNodes(graph) {
  const prev = useRef(null);
  const [changed, setChanged] = useState(new Set());
  useEffect(() => {
    const cur = new Map(graph.nodes.filter((n) => n.type === 'device').map((n) => [n.id, n.status]));
    if (prev.current) {
      const diff = new Set([...cur].filter(([id, s]) => prev.current.has(id) && prev.current.get(id) !== s).map(([id]) => id));
      if (diff.size) {
        setChanged(diff);
        const t = setTimeout(() => setChanged(new Set()), 2400);
        prev.current = cur;
        return () => clearTimeout(t);
      }
    }
    prev.current = cur;
    return undefined;
  }, [graph]);
  return changed;
}

export default function TopologyGraph({ graph, showControl, showMembership }) {
  const changed = useChangedNodes(graph);
  const { nodes, edges } = useMemo(() => {
    const pos = layout(graph);
    const nodes = graph.nodes.map((n) => ({ id: n.id, type: n.type, position: pos.get(n.id) || { x: 0, y: 0 }, data: { ...n, changed: changed.has(n.id) } }));
    const edges = graph.edges
      .filter((e) => (e.kind === 'control' ? showControl : e.kind === 'membership' ? showMembership : true))
      .map((e) => {
        if (e.kind === 'peer') {
          const s = peerEdge(e);
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'straight',
            style: s.style,
            className: s.className,
            label: s.label,
            labelStyle: { fill: s.color, fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase' },
            labelBgStyle: { fill: '#0F0F0F' },
            labelBgPadding: [6, 3],
            labelBgBorderRadius: 4,
          };
        }
        if (e.kind === 'control') {
          const color = e.state === 'connected' ? 'rgba(255,255,255,0.28)' : e.state === 'unreachable' ? CORAL : 'rgba(128,128,128,0.6)';
          return { id: e.id, source: e.source, target: e.target, style: { stroke: color, strokeWidth: 1, strokeDasharray: '1 5' }, markerEnd: { type: MarkerType.Arrow, color, width: 14, height: 14 } };
        }
        return { id: e.id, source: e.target, target: e.source, style: { stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1 } };
      });
    return { nodes, edges };
  }, [graph, showControl, showMembership, changed]);

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.2} proOptions={{ hideAttribution: false }} nodesConnectable={false} colorMode="dark">
      <Background color="rgba(255,255,255,0.06)" gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
