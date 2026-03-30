/**
 * src/lib/api.js — Centralised API client
 * Auto-authenticates on first call, retries on 401.
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function request(path, opts = {}, token = '') {
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
}

async function ensureAuth() {
  if (localStorage.getItem('iq_token')) return;
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok || !data.token) {
    throw new Error(data.error || 'Authentication failed');
  }
  localStorage.setItem('iq_token', data.token);
}

async function call(path, opts = {}) {
  await ensureAuth();
  let token = localStorage.getItem('iq_token') || '';
  let res = await request(path, opts, token);

  // Token expired — re-auth once
  if (res.status === 401) {
    localStorage.removeItem('iq_token');
    await ensureAuth();
    token = localStorage.getItem('iq_token') || '';
    res = await request(path, opts, token);
  }

  const data = await parseJsonSafe(res);

  if (!res.ok) {
    const message = data.error || data.message || `Request failed with status ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export const api = {
  // Analytics
  summary:       ()            => call('/api/analytics/summary'),
  accuracyTrend: ()            => call('/api/analytics/accuracy'),
  serviceStats:  ()            => call('/api/analytics/services'),

  // ML service health (proxied through api-gateway to avoid CORS)
  mlHealth:      ()            => call('/api/ml/health'),

  // Metrics
  metricsLive:   (url, n)      => call(`/api/metrics/live?url=${encodeURIComponent(url)}&limit=${n || 30}`),

  // Predictions
  predictions:   (params)      => call('/api/predictions?' + new URLSearchParams(params)),

  // Incidents
  incidents:     (params)      => call('/api/incidents?' + new URLSearchParams(params)),
  incidentById:  (id)          => call(`/api/incidents/${id}`),

  // Approvals — new Action Taken / Ignore workflow
  approvals:     ()            => call('/api/approvals'),
  approvalCount: ()            => call('/api/approvals/count'),
  patchApproval: (id, status)  => call(`/api/approvals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  }),

  // Services
  services:      ()            => call('/api/services'),

  // Monitored sites
  sites:         ()            => call('/api/sites'),
  sitesStatus:   ()            => call('/api/sites/status'),
  addSite:       (url, name)   => call('/api/sites', { method: 'POST', body: JSON.stringify({ url, name }) }),
  removeSite:    (id)          => call(`/api/sites/${id}`, { method: 'DELETE' }),
  siteMetrics:   (id, limit)   => call(`/api/sites/${id}/metrics?limit=${limit || 60}`),
};