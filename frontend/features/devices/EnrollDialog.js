'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Button, ErrorState, Field, Modal, inputCls } from '@/components/ui';
import { post } from '@/lib/api';

/**
 * Creates an enrollment request. The one-time token is held only in this
 * component's state and discarded on close — it is never put in a URL,
 * logged, or written to browser storage.
 */
export default function EnrollDialog({ open, onClose, networks, defaultNetworkId, onCreated }) {
  const [name, setName] = useState('');
  const [networkId, setNetworkId] = useState(defaultNetworkId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    setResult(null);
    setName('');
    setError(null);
    setCopied(false);
    onClose();
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await post('/devices/enrollment-requests', { name, networkId: networkId || defaultNetworkId });
      setResult(d);
      onCreated?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(result.enrollment.token);
    setCopied(true);
  }

  const server = typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:4000` : 'http://<control-plane>:4000';

  return (
    <Modal open={open} onClose={close} title={result ? 'enrollment token' : 'enroll a device'}>
      {!result ? (
        <form onSubmit={submit} className="space-y-4">
          <Field label="device name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="desk-pc" required minLength={2} maxLength={64} />
          </Field>
          {!defaultNetworkId && (
            <Field label="network">
              <select className={inputCls} value={networkId} onChange={(e) => setNetworkId(e.target.value)} required>
                <option value="">choose…</option>
                {networks?.map((n) => (
                  <option key={n.id} value={n.id}>{n.name} ({n.cidr})</option>
                ))}
              </select>
            </Field>
          )}
          <ErrorState error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>cancel</Button>
            <Button type="submit" busy={busy}>
              <KeyRound className="h-4 w-4" /> issue token
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl bg-lime p-4 text-ink">
            <div className="label !text-ink/60 mb-2">one-time · expires {new Date(result.enrollment.expiresAt).toLocaleTimeString()}</div>
            <div className="break-all font-mono text-sm">{result.enrollment.token}</div>
          </div>
          <Button variant="white" onClick={copy} className="w-full">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'copied' : 'copy token'}
          </Button>
          <div className="text-sm text-white/80">On <span className="font-semibold">{result.device.name}</span>, run the agent and paste the token when prompted:</div>
          <pre className="overflow-x-auto rounded-2xl border border-charcoal bg-ink p-4 font-mono text-xs text-lime scrollbar-thin">
{`nexlink-agent enroll --server ${server}`}
          </pre>
          <p className="text-xs text-mid">
            the token is shown once and is not stored in your browser. the agent generates its own keys; private keys never leave the device.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
