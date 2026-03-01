// src/lib/api.js — all backend calls go through here
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Token storage ─────────────────────────────────────────────
export const getToken  = ()    => localStorage.getItem('iq_token');
export const setToken  = (t)   => localStorage.setItem('iq_token', t);
export const clearToken = ()   => localStorage.removeItem('iq_token');

// ── Auto-login (dev: any credentials work) ───────────────────
export async function ensureAuth() {
  if (getToken()) return;
  const res  = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const data = await res.json();
  if (data.token) setToken(data.token);
}

// ── Authenticated fetch ───────────────────────────────────────
async function call(path, opts = {}) {
  await ensureAuth();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...opts.headers },
  });
  if (res.status === 401) { clearToken(); await ensureAuth(); return call(path, opts); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
  return res.json();
}

// ── API surface ───────────────────────────────────────────────
export const api = {
  summary:       ()           => call('/api/analytics/summary'),
  metricsLive:   (svc='service-a', n=40) => call(`/api/metrics/live?service_id=${svc}&limit=${n}`),
  predictions:   (p={})      => call('/api/predictions?' + new URLSearchParams(p)),
  incidents:     (p={})      => call('/api/incidents?'   + new URLSearchParams(p)),
  incidentById:  (id)        => call(`/api/incidents/${id}`),
  approvals:     (s='pending') => call(`/api/approvals?status=${s}`),
  approvalCount: ()           => call('/api/approvals/count'),
  approve:       (id)         => call(`/api/approvals/${id}/approve`, { method: 'POST' }),
  reject:        (id, reason) => call(`/api/approvals/${id}/reject`,  { method: 'POST', body: JSON.stringify({ reason }) }),
};