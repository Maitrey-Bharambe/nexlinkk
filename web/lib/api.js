'use client';

/**
 * Thin client for the control-plane REST API (proxied same-origin under /api/v1).
 * The session lives in an HttpOnly cookie the browser handles; the CSRF token
 * is kept only in memory — never localStorage/sessionStorage.
 */

let csrfToken = null;
export const setCsrfToken = (t) => {
  csrfToken = t;
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed');
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Control plane unreachable');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `Unexpected response (HTTP ${res.status})`);
  }
  if (!res.ok || !json?.ok) {
    throw new ApiError(res.status, json?.error?.code, json?.error?.message, json?.error?.details);
  }
  return json.data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const del = (path) => api(path, { method: 'DELETE' });
