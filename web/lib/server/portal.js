/**
 * Server-only helpers for the join scripts (/join.ps1, /join.sh).
 *
 * The portal address is what agents use for everything — API, relay and the
 * agent download — since one process serves all of it. PUBLIC_URL wins (set
 * it when deployed behind HTTPS / a proxy); otherwise the address this PC
 * already used to reach the portal, validated before it is embedded.
 */

const HOST_RE = /^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(?::\d{1,5})?$/;
export const DEVICE_RE = /^[a-f0-9]{24}$/;
const SHARE_RE = /^(?:(?:rdp|ssh|vnc|http|https)(?::\d{1,5})?|tcp:\d{1,5}|\d{1,5})(?:,(?:(?:rdp|ssh|vnc|http|https)(?::\d{1,5})?|tcp:\d{1,5}|\d{1,5})){0,7}$/;

export function portalOrigin(request) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (!HOST_RE.test(host)) return null;
  const proto = (request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function joinParams(request) {
  const url = new URL(request.url);
  const device = url.searchParams.get('device') || '';
  const share = (url.searchParams.get('share') || '').toLowerCase();
  return {
    device: DEVICE_RE.test(device) ? device : null,
    share: share === '' || SHARE_RE.test(share) ? share : null,
  };
}

/** True when the agent may talk plain http to this portal (lab / LAN use). */
export const isPlainHttp = (origin) => origin.startsWith('http://');

export const textResponse = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
