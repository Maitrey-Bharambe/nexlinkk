'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Bot, Eye, Play, Route, Sparkles, XCircle } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, ErrorState, Field, KV, Loading, Modal, PageHeader, Running, inputCls } from '@/components/ui';
import StatusBadge, { StatusMarker } from '@/components/StatusBadge';
import ActionCard from '@/features/incidents/ActionCard';
import PathView from '@/features/incidents/PathView';
import { post } from '@/lib/api';
import { fmtTime, humanize, timeAgo } from '@/lib/format';

function EvidenceList({ items, now, highlight }) {
  if (!items?.length) return <p className="text-sm text-mid">no evidence collected.</p>;
  return (
    <ul className="max-h-[420px] divide-y divide-line overflow-y-auto pr-1 scrollbar-thin">
      {/* Two tools may return the same record (e.g. one heartbeat), so the ref alone is not unique. */}
      {items.map((e, i) => {
        const cited = highlight?.has(e.ref);
        return (
          <li key={`${e.ref}:${i}`} className={`relative py-2.5 pl-3 ${cited ? 'before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:bg-lime' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`truncate font-mono text-[11px] ${cited ? 'text-lime' : 'text-white/60'}`}>{e.ref}</span>
              <span className="shrink-0 font-mono text-[10px] text-mid">{e.observedAt ? timeAgo(e.observedAt, now) : 'no timestamp'}</span>
            </div>
            <div className="mt-0.5 text-[13px] text-white/85">{e.summary}</div>
          </li>
        );
      })}
    </ul>
  );
}

function CloseDialog({ open, onClose, incidentId, onDone }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/incidents/${incidentId}/close`, { note });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="close incident">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-mid">manual close is recorded as <b className="text-white">closed</b>, not resolved — no verification happened.</p>
        <Field label="note (audited)"><input className={inputCls} required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorState error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>cancel</Button>
          <Button type="submit" variant="danger" busy={busy}>close</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Timeline from recorded timestamps only; steps that did not happen are not drawn. */
function Timeline({ inc, now }) {
  const events = [
    inc.detectedAt && { at: inc.detectedAt, what: 'detected', detail: inc.source === 'test' ? 'explicit test event' : 'deterministic detector', state: 'open' },
    ...inc.diagnosticRuns.map((r) => ({
      at: r.completedAt || r.startedAt,
      what: `diagnosis ${r.status}`,
      detail: r.method === 'diagnostic_service' ? `ai · ${r.provider}` : `rules · ${r.provider}`,
      state: r.status === 'completed' ? 'completed' : 'failed',
    })),
    ...inc.actions.flatMap((a) => [
      a.approval && { at: a.approval.decidedAt, what: `${a.approval.decision} · ${a.actionType}`, detail: a.approval.approverName || 'operator', state: a.approval.decision === 'approve' || a.approval.decision === 'approved' ? 'approved' : 'rejected' },
      a.verification?.checkedAt && { at: a.verification.checkedAt, what: `verified · ${humanize(a.verification.outcome)}`, detail: a.actionType, state: a.verification.outcome },
    ]),
    inc.resolution?.verifiedAt && { at: inc.resolution.verifiedAt, what: humanize(inc.resolution.method), detail: 'detector saw the condition clear', state: 'resolved' },
    inc.lastObservedAt && inc.active && { at: inc.lastObservedAt, what: 'last observed', detail: 'condition still present', state: inc.state },
  ]
    .filter((e) => e && e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  return (
    <ol className="relative">
      <span aria-hidden className="absolute bottom-3 left-[3px] top-3 w-px bg-line" />
      {events.map((e, i) => (
        <li key={i} className="relative grid grid-cols-[8px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
          <StatusMarker state={e.state} className="relative z-10 ring-4 ring-ink-2" />
          <div className="min-w-0">
            <div className="truncate text-[13px]">{e.what}</div>
            <div className="truncate font-mono text-[10.5px] text-mid">{e.detail}</div>
          </div>
          <time className="font-mono text-[10.5px] text-mid" dateTime={e.at} title={fmtTime(e.at)}>{timeAgo(e.at, now)}</time>
        </li>
      ))}
    </ol>
  );
}

/** The read-only checks that produced the evidence for the latest diagnosis. */
function DiagnosticChecks({ run, registry, cited }) {
  const desc = new Map((registry?.tools || []).map((t) => [t.name, t.description]));
  if (!run?.toolsRun?.length) return null;
  return (
    <Card label={`diagnostic checks · ${run.toolsRun.filter((t) => t.ok).length}/${run.toolsRun.length} ran · read-only`}>
      <ul className="divide-y divide-line">
        {run.toolsRun.map((t) => {
          const used = (t.refs || []).filter((r) => cited.has(r)).length;
          return (
            <li key={t.tool} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5">
              <StatusMarker state={t.ok ? 'completed' : 'failed'} />
              <div className="min-w-0">
                <div className="font-mono text-[12px] text-white">{t.tool}</div>
                <div className="text-xs text-mid">{t.ok ? desc.get(t.tool) || '' : `failed: ${t.error}`}</div>
              </div>
              <div className="text-right font-mono text-[10.5px] text-mid">
                {t.items} item{t.items === 1 ? '' : 's'}
                {used > 0 && <span className="text-lime"> · {used} cited</span>}
                {t.ms != null && <div>{t.ms} ms</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The investigation as a sequence of states — only those the backend
 * actually reached, each derived from a recorded fact.
 */
function InvestigationStates({ inc }) {
  const runs = inc.diagnosticRuns || [];
  const acts = inc.actions || [];
  const reached = [
    ['detected', Boolean(inc.detectedAt)],
    ['investigating', runs.length > 0 || inc.state === 'investigating'],
    ['evidence collected', runs.some((r) => (r.evidence || []).length > 0)],
    ['action proposed', acts.length > 0],
    ['awaiting approval', acts.some((a) => a.status === 'awaiting_approval' || a.approval)],
    ['executing', acts.some((a) => ['queued', 'executing'].includes(a.status) || a.approval?.decision === 'approved')],
    ['verifying', acts.some((a) => a.verification?.checkedAt)],
    ['resolved', inc.state === 'resolved'],
    ['failed', runs.some((r) => ['failed', 'rejected'].includes(r.status)) || acts.some((a) => ['failed', 'timed_out'].includes(a.verification?.outcome))],
  ].filter(([, ok]) => ok);
  return (
    <ol aria-label="Investigation progress" className="mb-6 flex flex-wrap items-stretch gap-px border border-line bg-line">
      {reached.map(([label], i) => {
        const last = i === reached.length - 1;
        const failed = label === 'failed';
        return (
          <li
            key={label}
            aria-current={last ? 'step' : undefined}
            className={`flex items-center gap-2 px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] ${
              failed ? 'bg-coral text-ink' : last ? 'bg-lime text-ink' : 'bg-ink-2 text-white/70'
            }`}
          >
            <span className="font-pixel text-[8px]">{String(i + 1).padStart(2, '0')}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function ColumnHead({ icon: Icon, title, note, tone = 'text-lime' }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Icon className={`h-4 w-4 shrink-0 translate-y-0.5 ${tone}`} strokeWidth={1.75} aria-hidden />
      <h2 className="t-section">{title}</h2>
      <span className="font-mono text-[10.5px] uppercase tracking-wider text-mid">{note}</span>
    </div>
  );
}

export default function IncidentDetail({ params }) {
  const { incidentId } = use(params);
  const { can } = useAuth();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const { data: inc, error, loading, reload } = useApi(`/incidents/${incidentId}`, { events: ['incident:update', 'action:update'], pollMs: 10_000 });
  const { data: registry } = useApi('/diagnostics/registry');

  if (loading && !inc) return <Loading />;
  if (!inc) return <ErrorState error={error} onRetry={reload} />;

  const run = inc.diagnosticRuns[0];
  const isAi = run?.method === 'diagnostic_service';
  const cited = new Set(run?.result ? [...run.result.observations.flatMap((o) => o.evidence_refs), ...run.result.hypotheses.flatMap((h) => h.supporting_refs)] : []);

  async function diagnose(mode) {
    setBusy(mode);
    setRunError(null);
    try {
      await post(`/incidents/${incidentId}/diagnostics`, { mode });
      reload();
    } catch (err) {
      setRunError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader kicker={`network autopsy · ${humanize(inc.category)}${inc.isTest ? ' · test event' : ''}`} plain title={inc.title.replace(/^\[TEST\] /, '')}>
        <StatusBadge state={inc.state} size="lg" />
        {inc.active && can('incidents:diagnose') && (
          <Button busy={busy === 'deterministic'} disabled={Boolean(busy)} onClick={() => diagnose('deterministic')}><Play className="h-4 w-4" aria-hidden /> run diagnostics</Button>
        )}
        {inc.active && can('incidents:diagnose') && registry?.llmProviderConfigured && (
          <Button variant="white" busy={busy === 'diagnostic_service'} disabled={Boolean(busy)} onClick={() => diagnose('diagnostic_service')} aria-label="ask ai" title="AI analysis: output is schema-checked, must cite collected evidence, and any action is policy-gated">
            <Sparkles className="h-4 w-4" aria-hidden /> ask ai
          </Button>
        )}
        {inc.active && can('incidents:close') && (
          <Button variant="ghost" onClick={() => setCloseOpen(true)}><XCircle className="h-4 w-4" aria-hidden /> close</Button>
        )}
      </PageHeader>
      <CloseDialog open={closeOpen} onClose={() => setCloseOpen(false)} incidentId={incidentId} onDone={reload} />
      <ErrorState error={runError} />
      {busy && (
        <div className="mb-5">
          <Running label={busy === 'diagnostic_service' ? 'collecting evidence with read-only tools · asking the diagnostic service' : 'collecting evidence with read-only tools · applying rules'} />
        </div>
      )}

      <InvestigationStates inc={inc} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] 2xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ── left: the incident and its timeline ── */}
        <div className="space-y-4">
          <ColumnHead icon={Eye} title="incident" note="what was detected, and when" />
          <Card>
            <KV k="device"><Link className="underline decoration-white/30 underline-offset-4 hover:text-lime" href={`/devices/${inc.deviceId}`}>{inc.deviceName || inc.deviceId}</Link></KV>
            <KV k="severity"><StatusBadge state={inc.severity} /></KV>
            <KV k="source">{inc.source === 'test' ? 'explicit test event' : 'deterministic detector'}</KV>
            <KV k="detected" mono>{fmtTime(inc.detectedAt)}</KV>
            <KV k="last observed" mono>{fmtTime(inc.lastObservedAt)}</KV>
            {inc.resolution?.method && (
              <KV k="final outcome">
                {humanize(inc.resolution.method)} {inc.resolution.verifiedAt ? `· verified ${timeAgo(inc.resolution.verifiedAt, now)}` : '· not verified'}
              </KV>
            )}
            <KV k="id" mono><span className="text-white/50">{inc.id}</span></KV>
          </Card>
          <Card label="timeline">
            <Timeline inc={inc} now={now} />
          </Card>
        </div>

        {/* ── center: the affected connection, and the checks that measured it ── */}
        <div className="space-y-4">
          <ColumnHead icon={Route} title="path" note="the connection this incident is about" />
          <section className="pixel-corners border border-line-strong bg-ink-2 p-5">
            <PathView deviceId={inc.deviceId} peerDeviceId={inc.peerDeviceId} />
          </section>
          <DiagnosticChecks run={run} registry={registry} cited={cited} />
          <Card label="detection evidence · observed">
            <EvidenceList items={inc.evidence} now={now} />
          </Card>
          {run && (
            <Card label={`evidence gathered by tools · ${cited.size} cited`}>
              <EvidenceList items={run.evidence} now={now} highlight={cited} />
            </Card>
          )}
        </div>

        {/* ── right: hypotheses and recovery ── */}
        <div className="space-y-4 lg:col-span-2 2xl:col-span-1">
          <ColumnHead
            icon={isAi ? Sparkles : Bot}
            title="analysis"
            note={!run ? 'not run yet' : isAi ? 'ai-generated · grounded, schema-checked' : 'deterministic rules'}
            tone={isAi ? 'text-white' : 'text-lime'}
          />
          {!run ? (
            <Card tone="flat">
              <p className="text-sm text-white/70">
                not diagnosed yet. running diagnostics calls only read-only tools, then proposes actions that still need policy approval and a human yes.
              </p>
            </Card>
          ) : run.status !== 'completed' ? (
            <Card label={`diagnosis · ${run.status}`}>
              <ErrorState error={{ code: `RUN_${run.status.toUpperCase()}`, message: run.status === 'failed' ? 'The planner could not be reached or returned an error' : 'Planner output failed validation and was discarded', details: run.validationErrors.map((m) => ({ message: m })) }} />
            </Card>
          ) : (
            <section className={`border bg-ink-2 ${isAi ? 'border-dashed border-white/40' : 'border-line'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
                <span className="font-mono text-[11px] uppercase tracking-wider text-mid">{run.provider} · {timeAgo(run.completedAt, now)}</span>
                {isAi && <span className="rounded-[2px] border border-line-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/70">ai output · not a measurement</span>}
              </div>
              <div className="px-5 py-5">
                <p className="text-[17px] font-medium leading-snug">{run.result.summary}</p>

                <div className="label mb-2 mt-7">observations · each cites evidence</div>
                <ul className="space-y-3">
                  {run.result.observations.map((o, i) => (
                    <li key={i} className="border-l-2 border-lime/70 pl-3 text-sm">
                      {o.statement}
                      <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                        {[...new Set(o.evidence_refs)].map((r) => <span key={r} className="max-w-full break-all rounded-[2px] bg-ink-3 px-1.5 py-0.5 font-mono text-[10px] text-lime">{r}</span>)}
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="label mb-2 mt-7">hypotheses · not facts</div>
                <ul className="space-y-2">
                  {run.result.hypotheses.map((h, i) => (
                    <li key={i} className={`flex items-start justify-between gap-3 rounded-control border border-dashed border-line-strong px-3 py-2.5 text-sm ${h.status === 'ruled_out' ? 'text-white/55 line-through decoration-white/25' : ''}`}>
                      <span>{h.statement}</span>
                      <StatusBadge state={h.status === 'plausible' ? 'pending' : h.status === 'ruled_out' ? 'rejected' : 'unknown'} label={h.status.replace('_', ' ')} />
                    </li>
                  ))}
                </ul>

                {run.result.uncertainties.length > 0 && (
                  <>
                    <div className="label mb-2 mt-7">uncertainties</div>
                    <ul className="space-y-1 text-sm text-white/70">
                      {run.result.uncertainties.map((u, i) => <li key={i} className="flex gap-2"><span className="font-mono text-amber" aria-hidden>?</span>{u}</li>)}
                    </ul>
                  </>
                )}
              </div>
            </section>
          )}

          <div className="pt-2">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="t-section">proposed recovery</h2>
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-mid">policy-checked · human approval · verified after</span>
            </div>
            {inc.actions.length === 0 ? (
              <p className="text-sm text-mid">none yet.</p>
            ) : (
              <div className="space-y-3">
                {inc.actions.map((a) => <ActionCard key={a.id} action={a} canDecide={can('actions:approve:low')} onChange={reload} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
