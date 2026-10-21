'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, ErrorState, Field, Modal, inputCls } from '@/components/ui';
import { post } from '@/lib/api';
import JoinInstructions from './JoinInstructions';

/**
 * Creates an enrollment request and shows how to connect the computer: one
 * command to paste there, or an invite link for whoever sits at it. The
 * one-time token is held only in this component's state and discarded on
 * close — never logged or written to browser storage; in the invite link it
 * sits in the URL fragment, which browsers do not send to servers.
 */
export default function EnrollDialog({ open, onClose, networks, defaultNetworkId, onCreated }) {
  const [name, setName] = useState('');
  const [networkId, setNetworkId] = useState(defaultNetworkId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const close = () => {
    setResult(null);
    setName('');
    setError(null);
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

  return (
    <Modal open={open} onClose={close} title={result ? `connect ${result.device.name}` : 'add a device'}>
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
              <KeyRound className="h-4 w-4" /> create invite
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="label">one-time · expires {new Date(result.enrollment.expiresAt).toLocaleTimeString()}</div>
          <JoinInstructions token={result.enrollment.token} deviceId={result.device.id} deviceName={result.device.name} expiresAt={result.enrollment.expiresAt} />
          <p className="text-xs text-mid">
            the agent generates its own keys; private keys never leave the device. the device shows up here as soon as it enrolls.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
