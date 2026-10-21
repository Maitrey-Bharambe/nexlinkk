'use client';

/**
 * Join commands and invite links. Everything an invited computer needs is the
 * portal address: the same origin serves the API, the relay and the agent
 * download, so the computer can be on any network.
 *
 * Invite links carry the one-time token in the URL fragment (#…). Browsers
 * never send the fragment to a server, so the token does not reach access
 * logs, proxies or the Referer header.
 */

export const OSES = [
  ['windows', 'windows'],
  ['unix', 'mac · linux'],
];

export function guessOs() {
  if (typeof navigator === 'undefined') return 'windows';
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.userAgent}`.toLowerCase();
  return p.includes('win') ? 'windows' : p.includes('mac') || p.includes('linux') || p.includes('x11') ? 'unix' : 'windows';
}

const query = (deviceId, share) => `device=${deviceId}${share ? `&share=${encodeURIComponent(share)}` : ''}`;

export function joinLine({ origin, token, deviceId, share, os }) {
  if (os === 'unix') {
    return `curl -fsSL '${origin}/join.sh?${query(deviceId, share)}' | NEXLINK_ENROLLMENT_TOKEN='${token}' sh`;
  }
  return `$env:NEXLINK_ENROLLMENT_TOKEN='${token}'; irm '${origin}/join.ps1?${query(deviceId, share)}' | iex`;
}

export function inviteLink({ origin, token, deviceId, name, share, expiresAt }) {
  const p = new URLSearchParams({ t: token, d: deviceId, n: name || '', e: expiresAt ? String(new Date(expiresAt).getTime()) : '' });
  if (share) p.set('s', share);
  return `${origin}/join#${p.toString()}`;
}

export function parseInvite(hash) {
  const p = new URLSearchParams((hash || '').replace(/^#/, ''));
  const token = p.get('t') || '';
  const deviceId = p.get('d') || '';
  if (!/^nxe_[A-Za-z0-9_-]{20,}$/.test(token) || !/^[a-f0-9]{24}$/.test(deviceId)) return null;
  const e = Number(p.get('e'));
  return { token, deviceId, name: p.get('n') || '', share: p.get('s') || '', expiresAt: e ? new Date(e) : null };
}

// navigator.clipboard exists only on https/localhost; fall back to execCommand.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
