'use client';

import { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Cpu, Network, Server } from 'lucide-react';
import { toneOf } from '@/components/StatusBadge';

const LIME = '#C7FF2E';
const CORAL = '#FF5A36';
const GRAY = '#808080';
const WHITE = '#FFFFFF';

/**
 * Edge style encodes evidence:
 *   solid lime   — connected (fresh WireGuard handshake observed)
 *   solid white  — degraded (handshake ok, loss/latency high)
 *   dashed lime  — connecting (configured on interface, no handshake yet)
 *   dashed coral — unreachable (handshake went stale)
 *   dashed gray  — configured only / unknown (no evidence either way)
 */
function peerEdgeStyle(state) {
  switch (state) {
    case 'connected':
      return { stroke: LIME, strokeWidth: 3 };
    case 'degraded':
      return { stroke: WHITE, strokeWidth: 2.5 };
    case 'connecting':
      return { stroke: LIME, strokeWidth: 1.5, strokeDasharray: '6 6' };
    case 'unreachable':
      return { stroke: CORAL, strokeWidth: 2, strokeDasharray: '4 6' };
    default:
      return { stroke: GRAY, strokeWidth: 1.5, strokeDasharray: '2 6' };
  }
}

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, border: 0 };

function DeviceNode({ data }) {
  const tone = toneOf(data.status);
  const ring = { good: 'border-lime bg-lime text-ink', partial: 'border-lime text-white bg-ink-2', bad: 'border-coral text-white bg-ink-2', info: 'border-white bg-white text-ink', none: 'border-charcoal text-white bg-ink-2 hatch' }[tone];
  return (
    <div className={`w-[170px] rounded-[22px] border-2 px-4 py-3 ${ring}`}>
      <Handle type="target" position={Position.Top} style={hidden} />
      <Handle type="source" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 shrink-0" />
        <span className="truncate text-sm font-bold">{data.label}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] opacity-80">{data.address || 'no address'}</div>
      <div className="mt-2 flex flex-wrap gap-1 font-mono text-[10px] uppercase">
        <span className="rounded-full bg-black/20 px-1.5">{data.status.replace('_', ' ')}</span>
        <span className="rounded-full bg-black/20 px-1.5">vpn {data.vpnSource === 'simulated' ? 'sim' : data.vpn}</span>
      </div>
    </div>
  );
}

function NetworkNode({ data }) {
  return (
    <div className="rounded-full border-2 border-dashed border-mid bg-ink px-5 py-2.5 text-center">
      <Handle type="target" position={Position.Top} style={hidden} />
      <Handle type="source" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2 text-sm font-bold"><Network className="h-4 w-4 text-lime" />{data.label}</div>
      <div className="font-mono text-[11px] text-mid">{data.cidr}</div>
    </div>
  );
}

function ControlPlaneNode() {
  return (
    <div className="rounded-[22px] bg-white px-5 py-3 text-ink">
      <Handle type="target" position={Position.Bottom} style={hidden} />
      <div className="flex items-center gap-2 text-sm font-bold"><Server className="h-4 w-4" />control plane</div>
      <div className="font-mono text-[10px] uppercase opacity-60">coordination only · no vpn traffic</div>
    </div>
  );
}

const nodeTypes = { device: DeviceNode, network: NetworkNode, controlPlane: ControlPlaneNode };

function layout(graph) {
  const nets = graph.nodes.filter((n) => n.type === 'network');
  const width = Math.max(1, nets.length) * 620;
  const pos = new Map([['control-plane', { x: width / 2 - 110, y: 0 }]]);
  nets.forEach((n, i) => {
    const cx = i * 620 + 310;
    pos.set(n.id, { x: cx - 90, y: 330 });
    const devs = graph.nodes.filter((d) => d.type === 'device' && d.networkId === n.networkId);
    devs.forEach((d, j) => {
      // Fan devices out on a half-circle below their network node.
      const angle = devs.length === 1 ? Math.PI / 2 : Math.PI * 0.1 + (j / (devs.length - 1)) * Math.PI * 0.8;
      const r = 230 + (devs.length > 6 ? (j % 2) * 90 : 0);
      pos.set(d.id, { x: cx - 85 + Math.cos(angle) * r, y: 330 + Math.sin(angle) * r });
    });
  });
  return pos;
}

export default function TopologyGraph({ graph, showControl, showMembership }) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(graph);
    const nodes = graph.nodes.map((n) => ({ id: n.id, type: n.type, position: pos.get(n.id) || { x: 0, y: 0 }, data: n }));
    const edges = graph.edges
      .filter((e) => (e.kind === 'control' ? showControl : e.kind === 'membership' ? showMembership : true))
      .map((e) => {
        if (e.kind === 'peer') {
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'straight',
            style: peerEdgeStyle(e.state),
            animated: e.state === 'connected',
            label: e.state === 'connected' ? `${e.path}` : e.state,
            labelStyle: { fill: e.state === 'connected' ? LIME : GRAY, fontSize: 10, fontFamily: 'var(--font-mono)' },
            labelBgStyle: { fill: '#0F0F0F' },
          };
        }
        if (e.kind === 'control') {
          const color = e.state === 'connected' ? 'rgba(255,255,255,0.35)' : e.state === 'unreachable' ? CORAL : GRAY;
          return { id: e.id, source: e.source, target: e.target, style: { stroke: color, strokeWidth: 1, strokeDasharray: '1 5' }, markerEnd: { type: MarkerType.Arrow, color } };
        }
        return { id: e.id, source: e.target, target: e.source, style: { stroke: '#2E2E2E', strokeWidth: 1 } };
      });
    return { nodes, edges };
  }, [graph, showControl, showMembership]);

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} proOptions={{ hideAttribution: false }} nodesConnectable={false} colorMode="dark">
      <Background color="#2E2E2E" gap={28} size={1.2} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
