'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Play, Sparkles, XCircle } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, ErrorState, Field, KV, Loading, Modal, PageHeader, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import ActionCard from '@/features/incidents/ActionCard';
import { post } from '@/lib/api';
import { fmtTime, humanize, timeAgo } from '@/lib/format';

function EvidenceList({ items, now, highlight }) {
  if (!items?.length) return <p className="text-sm text-mid">no evidence collected.</p>;
  return (
    <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
      {items.map((e) => (
        <li key={e.ref} className={`rounded-xl border px-3 py-2 ${highlight?.has(e.ref) ? 'border-lime/60 bg-lime/5' : 'border-charcoal'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-lime">{e.ref}</span>
            <span className="shrink-0 font-mono text-[10px] text-mid">{e.observedAt ? timeAgo(e.observedAt, now) : 'no timestamp'}</span>
          </div>
          <div className="text-xs text-white/80">{e.summary}</div>
        </li>
      ))}
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
      <PageHeader kicker={`incident · ${humanize(inc.category)}${inc.isTest ? ' · TEST EVENT' : ''}`} title={inc.title.replace(/^\[TEST\] /, '')}>
        <StatusBadge state={inc.state} size="lg" />
        {inc.active && can('incidents:diagnose') && (
          <Button busy={busy === 'deterministic'} disabled={Boolean(busy)} onClick={() => diagnose('deterministic')}><Play className="h-4 w-4" /> run diagnostics</Button>
        )}
        {inc.active && can('incidents:diagnose') && registry?.llmProviderConfigured && (
          <Button variant="white" busy={busy === 'diagnostic_service'} disabled={Boolean(busy)} onClick={() => diagnose('diagnostic_service')} title="LLM analysis via the diagnostic service; output is schema-checked, grounded and policy-gated">
            <Sparkles className="h-4 w-4" /> ask ai
          </Button>
        )}
        {inc.active && can('incidents:close') && (
          <Button variant="ghost" onClick={() => setCloseOpen(true)}><XCircle className="h-4 w-4" /> close</Button>
        )}
      </PageHeader>
      <CloseDialog open={closeOpen} onClose={() => setCloseOpen(false)} incidentId={incidentId} onDone={reload} />
      <ErrorState error={runError} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <Card tone={inc.state === 'resolved' ? 'lime' : 'default'} label="incident">
            <KV k="id" mono>{inc.id}</KV>
            <KV k="device"><Link className="underline" href={`/devices/${inc.deviceId}`}>{inc.deviceName || inc.deviceId}</Link></KV>
            <KV k="severity"><StatusBadge state={inc.severity} /></KV>
            <KV k="source">{inc.source === 'test' ? 'explicit test event' : 'deterministic detector'}</KV>
            <KV k="detected">{fmtTime(inc.detectedAt)}</KV>
            <KV k="last observed">{fmtTime(inc.lastObservedAt)}</KV>
            {inc.resolution?.method && (
              <KV k="final outcome">
                {humanize(inc.resolution.method)} {inc.resolution.verifiedAt ? `· verified ${timeAgo(inc.resolution.verifiedAt, now)}` : '· not verified'}
              </KV>
            )}
          </Card>
          <Card label="detection evidence">
            <EvidenceList items={inc.evidence} now={now} />
          </Card>
          {run && (
            <Card label={`evidence gathered by tools · run ${run.status}`}>
              <EvidenceList items={run.evidence} now={now} highlight={cited} />
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {!run ? (
            <Card tone="charcoal" label="diagnosis">
              <p className="text-sm text-white/70">not diagnosed yet. running diagnostics calls only read-only tools, then proposes actions that still need policy approval and a human yes.</p>
            </Card>
          ) : run.status !== 'completed' ? (
            <Card label={`diagnosis · ${run.status}`}>
              <ErrorState error={{ code: `RUN_${run.status.toUpperCase()}`, message: run.status === 'failed' ? 'The planner could not be reached or returned an error' : 'Planner output failed validation and was discarded', details: run.validationErrors.map((m) => ({ message: m })) }} />
            </Card>
          ) : (
            <Card label={`diagnosis · ${run.provider} · ${timeAgo(run.completedAt, now)}`}>
              <p className="text-lg font-semibold">{run.result.summary}</p>

              <div className="label mb-2 mt-6">observations (measured)</div>
              <ul className="space-y-2">
                {run.result.observations.map((o, i) => (
                  <li key={i} className="text-sm">
                    {o.statement}
                    <div className="mt-0.5 flex min-w-0 flex-wrap gap-1">{o.evidence_refs.map((r) => <span key={r} className="max-w-full break-all rounded bg-charcoal px-1.5 font-mono text-[10px] text-lime">{r}</span>)}</div>
                  </li>
                ))}
              </ul>

              <div className="label mb-2 mt-6">hypotheses (not facts)</div>
              <ul className="space-y-2">
                {run.result.hypotheses.map((h, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-sm">
                    <span>{h.statement}</span>
                    <StatusBadge state={h.status === 'plausible' ? 'pending' : h.status === 'ruled_out' ? 'rejected' : 'unknown'} label={h.status.replace('_', ' ')} />
                  </li>
                ))}
              </ul>

              {run.result.uncertainties.length > 0 && (
                <>
                  <div className="label mb-2 mt-6">uncertainties</div>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">{run.result.uncertainties.map((u, i) => <li key={i}>{u}</li>)}</ul>
                </>
              )}
            </Card>
          )}

          <div>
            <h2 className="mb-3 mt-2 text-2xl font-bold lowercase">proposed actions</h2>
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
