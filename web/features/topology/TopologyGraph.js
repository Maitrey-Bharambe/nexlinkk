'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, getSmoothStepPath } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toneOf } from '@/components/StatusBadge';

const LIME = '#C7FF2E';
const AMBER = '#F2B94B';
const CORAL = '#FF5A36';
const GRAY = '#808080';
const GRID = 24;

/**
 * Edge style encodes evidence, never decoration:
 *   lime + square packets          — connected direct (fresh WireGuard handshake)
 *   lime long dashes + packets     — connected through the relay
 *   amber                          — degraded (handshake ok, loss/latency high)
 *   thin dashed lime               — connecting (configured on interface, no handshake yet)
 *   dashed coral                   — unreachable (handshake went stale)
 *   dotted gray                    — configured only / unknown (no evidence either way)
 * Packets move only on verified paths, and not at all under reduced motion.
 */
function peerStyle(e) {
  const relay = e.path === 'relay';
  switch (e.state) {
    case 'connected':
      return { stroke: LIME, strokeWidth: 2, dash: relay ? '10 6' : undefined, label: relay ? 'relay' : 'direct', tone: 'lime', packets: true };
    case 'degraded':
      return { stroke: AMBER, strokeWidth: 2, dash: relay ? '10 6' : undefined, label: `degraded${relay ? ' · relay' : ''}`, tone: 'amber', packets: false };
    case 'connecting':
      return { stroke: LIME, strokeWidth: 1.25, opacity: 0.55, dash: '4 6', label: 'connecting', tone: 'gray' };
    case 'unreachable':
      return { stroke: CORAL, strokeWidth: 1.5, dash: '6 6', label: 'unreachable', tone: 'coral' };
    default:
      return { stroke: GRAY, strokeWidth: 1, opacity: 0.75, dash: '2 6', label: e.state === 'unknown' ? 'unknown' : 'configured', tone: 'gray' };
  }
}

const TAG = {
  lime: 'border-lime bg-lime text-ink',
  amber: 'border-amber bg-ink text-amber',
  coral: 'border-coral bg-ink text-coral',
  gray: 'border-line-strong bg-ink text-white/60',
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const on = (e) => setReduced(e.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Orthogonal peer path with a square tag; verified paths carry square packets. */
function PeerEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }) {
  const reduced = useReducedMotion();
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0, offset: GRID });
  const s = data.style;
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: s.stroke, strokeWidth: s.strokeWidth, strokeDasharray: s.dash, strokeOpacity: s.opacity ?? 1 }} />
      {s.packets && !reduced &&
        [0, 1, 2].map((k) => (
          // Hidden until its staggered start, so it never sits at the origin.
          <rect key={k} className="packet" width="6" height="6" x="-3" y="-3" fill={LIME} stroke="#0F0F0F" strokeWidth="1" shapeRendering="crispEdges" visibility="hidden">
            <set attributeName="visibility" to="visible" begin={`${(k * (data.path === 'relay' ? 3.6 : 2.4)) / 3}s`} />
            <animateMotion dur={data.path === 'relay' ? '3.6s' : '2.4s'} begin={`${(k * (data.path === 'relay' ? 3.6 : 2.4)) / 3}s`} repeatCount="indefinite" path={path} />
          </rect>
        ))}
      <EdgeLabelRenderer>
        <div
          className={`nodrag nopan pointer-events-none absolute border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] ${TAG[s.tone]}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        >
          {s.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, border: 0 };
const handles = (
  <>
    <Handle id="t" type="target" position={Position.Top} style={hidden} />
    <Handle id="b" type="source" position={Position.Bottom} style={hidden} />
    <Handle id="l" type="target" position={Position.Left} style={hidden} />
    <Handle id="r" type="source" position={Position.Right} style={hidden} />
    <Handle id="ts" type="source" position={Position.Top} style={hidden} />
    <Handle id="bt" type="target" position={Position.Bottom} style={hidden} />
  </>
);

/** A 10×8 pixel computer, drawn with crisp squares. */
function PixelComputer({ color }) {
  const px = ['1111111111', '1000000001', '1000000001', '1000000001', '1111111111', '0000110000', '0001111000', '0000000000'];
  return (
    <svg width="20" height="16" viewBox="0 0 10 8" shapeRendering="crispEdges" aria-hidden>
      {px.flatMap((row, y) => [...row].map((c, x) => (c === '1' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={color} /> : null)))}
    </svg>
  );
}

const NODE_TAPE = {
  good: 'bg-lime text-ink',
  progress: 'bg-ink-3 text-lime',
  warn: 'bg-amber text-ink',
  bad: 'bg-coral text-ink',
  info: 'bg-white text-ink',
  none: 'bg-charcoal text-white/70',
};
const NODE_BORDER = { good: 'border-lime', progress: 'border-lime/50 border-dashed', warn: 'border-amber', bad: 'border-coral', info: 'border-white/60', none: 'border-line-strong' };

function DeviceNode({ data }) {
  const tone = toneOf(data.status);
  const selected = data.selected;
  return (
    <div className={`w-[192px] border bg-ink ${NODE_BORDER[tone]} ${selected ? 'brut' : ''} ${data.changed ? 'status-flash' : ''}`}>
      {handles}
      <div className={`flex items-center justify-between gap-2 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] ${NODE_TAPE[tone]}`}>
        <span>{data.status.replace(/_/g, ' ')}</span>
        <span>vpn {data.vpnSource === 'simulated' ? 'sim' : data.vpn}</span>
      </div>
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <PixelComputer color={tone === 'good' ? LIME : tone === 'bad' ? CORAL : tone === 'warn' ? AMBER : '#FFFFFF'} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight">{data.label}</div>
          <div className="font-mono text-[11px] text-white/70">{data.address || 'no address'}</div>
        </div>
      </div>
    </div>
  );
}

function NetworkNode({ data }) {
  return (
    <div className="border border-dashed border-white/40 bg-ink px-3 py-2">
      {handles}
      <div className="font-pixel text-[9px] uppercase leading-relaxed text-lime">net</div>
      <div className="text-[13px] font-semibold">{data.label}</div>
      <div className="font-mono text-[11px] text-white/60">{data.cidr}</div>
    </div>
  );
}

function ControlPlaneNode() {
  return (
    <div className="border border-white bg-white px-3 py-2 text-ink">
      {handles}
      <div className="font-pixel text-[10px] uppercase leading-relaxed">nexlink</div>
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-ink/70">coordination · relays ciphertext only</div>
    </div>
  );
}

const nodeTypes = { device: DeviceNode, network: NetworkNode, controlPlane: ControlPlaneNode };
const edgeTypes = { peer: PeerEdge };

const snap = (v) => Math.round(v / GRID) * GRID;
// Wide enough that a side-to-side tunnel between neighbours is long enough to read.
const COL_W = 312;
const ROW_H = 144;
const PER_ROW = 4;

/** Grid layout: network columns; inside each, devices in rows of four. */
function layout(graph) {
  const nets = graph.nodes.filter((n) => n.type === 'network');
  const devsOf = (n) => graph.nodes.filter((d) => d.type === 'device' && d.networkId === n.networkId);
  const widths = nets.map((n) => Math.max(1, Math.min(PER_ROW, devsOf(n).length)) * COL_W + GRID * 2);
  const total = widths.reduce((a, b) => a + b, 0) || COL_W;
  const pos = new Map([['control-plane', { x: snap(total / 2 - 110), y: 0 }]]);
  let left = 0;
  nets.forEach((n, i) => {
    pos.set(n.id, { x: snap(left + widths[i] / 2 - 90), y: 168 });
    devsOf(n).forEach((d, j) => {
      const row = Math.floor(j / PER_ROW);
      const col = j % PER_ROW;
      pos.set(d.id, { x: snap(left + GRID + col * COL_W), y: snap(336 + row * ROW_H) });
    });
    left += widths[i];
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

export default function TopologyGraph({ graph, showControl, showMembership, selectedId, onSelect }) {
  const changed = useChangedNodes(graph);
  const { nodes, edges } = useMemo(() => {
    const pos = layout(graph);
    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: pos.get(n.id) || { x: 0, y: 0 },
      data: { ...n, changed: changed.has(n.id), selected: n.id === selectedId },
    }));
    const at = (id) => pos.get(id) || { x: 0, y: 0 };
    const edges = graph.edges
      .filter((e) => (e.kind === 'control' ? showControl : e.kind === 'membership' ? showMembership : true))
      .map((e) => {
        if (e.kind === 'peer') {
          // Same row: side to side; otherwise bottom to top. Keeps paths orthogonal and short.
          const a = at(e.source);
          const b = at(e.target);
          const sameRow = a.y === b.y;
          const [src, dst] = sameRow ? (a.x < b.x ? [e.source, e.target] : [e.target, e.source]) : a.y < b.y ? [e.source, e.target] : [e.target, e.source];
          return {
            id: e.id,
            source: src,
            target: dst,
            sourceHandle: sameRow ? 'r' : 'b',
            targetHandle: sameRow ? 'l' : 't',
            type: 'peer',
            data: { style: peerStyle(e), path: e.path },
          };
        }
        if (e.kind === 'control') {
          const color = e.state === 'connected' ? 'rgba(255,255,255,0.35)' : e.state === 'unreachable' ? CORAL : 'rgba(128,128,128,0.6)';
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: 'ts',
            targetHandle: 'bt',
            type: 'step',
            style: { stroke: color, strokeWidth: 1, strokeDasharray: '1 5' },
            markerEnd: { type: MarkerType.Arrow, color, width: 14, height: 14 },
          };
        }
        return { id: e.id, source: e.target, target: e.source, sourceHandle: 'b', targetHandle: 't', type: 'step', style: { stroke: 'rgba(255,255,255,0.16)', strokeWidth: 1 } };
      });
    return { nodes, edges };
  }, [graph, showControl, showMembership, changed, selectedId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      snapToGrid
      snapGrid={[GRID, GRID]}
      onNodeClick={(_, n) => n.type === 'device' && onSelect?.(n.id)}
      proOptions={{ hideAttribution: false }}
      nodesConnectable={false}
      colorMode="dark"
    >
      <Background color="rgba(255,255,255,0.06)" gap={GRID} variant="lines" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
