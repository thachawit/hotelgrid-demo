// Client for the Go finops service (go/cmd/finops): budgets, bill reconciliation, provider key actions.
// The ledger stays here (SQLite); finops reads/writes it through /internal/ledger/* on the control plane.
// The notebook status (reported by the simulated ds-notebook) is kept here and merged into the public state.
import { fetchJson } from '../lib/util.mjs';
import * as ledger from './ledger.mjs';

let FIN;
export const local = { notebook: null };
let cache = { budgets: [], recon: null, decisions: [], warnAt: 0.8 };
let gatewayCache = {};

export function init(cfg) {
  FIN = `http://127.0.0.1:${cfg.topo.ports.finops}`;
  // keep a fresh copy for synchronous readers (gateway route table, UI tab); the service recomputes budgets every 3 s
  const poll = async () => {
    const [s, g] = await Promise.all([fetchJson(`${FIN}/api/state`, { timeoutMs: 2000 }), fetchJson(`${FIN}/api/budgets/gateway`, { timeoutMs: 2000 })]);
    if (s.status === 200) cache = s.body;
    if (g.status === 200) gatewayCache = g.body;
  };
  poll();
  setInterval(poll, 1000).unref();
}

async function call(method, p, body, timeoutMs = 30000) {
  const r = await fetchJson(`${FIN}${p}`, { method, body, timeoutMs });
  if (r.status !== 200) throw new Error(`finops ${method} ${p} → ${r.status}: ${r.body?.error || ''}`);
  return r.body;
}

export const gatewayBudgets = () => gatewayCache;
export const cached = () => cache;
export const recon = async () => { const r = await fetchJson(`${FIN}/api/recon`, { timeoutMs: 5000 }); return r.status === 200 ? r.body : null; };

export async function state() {
  try { cache = await call('GET', '/api/state', undefined, 5000); } catch {}
  return cache;
}

// What the dashboard shows: Go finops state + infra cost (ledger) + notebook status (local).
export async function publicState() {
  const s = await state();
  return { ...s, notebook: local.notebook, infra: ledger.infraSummary() };
}

export async function reconcile({ days = 14, actor = 'finops (daily job)' } = {}) {
  const r = await call('POST', '/api/reconcile', { days, actor }, 60000);
  cache = r.state;
  return r.recon;
}
export async function deactivateKey(keyId, approvedBy = 'engineer') {
  const r = await call('POST', `/api/keys/${encodeURIComponent(keyId)}/deactivate`, { approvedBy });
  await state();
  return r.key;
}
export async function raiseBudget(team, monthlyUsd, approvedBy = 'owner') {
  cache = await call('POST', `/api/budgets/${encodeURIComponent(team)}/raise`, { monthlyUsd, approvedBy });
  return cache;
}
