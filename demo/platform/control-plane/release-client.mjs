// Client for the Go release controller (go/cmd/release-controller): telemetry, manifests, ring rollouts,
// canary gates, rollback, incidents. Everything here is HTTP; the controller pushes its log lines and
// events back to the control plane's bus (/ingest/events).
import { fetchJson, sleep } from '../lib/util.mjs';

let RC;
export function init(cfg) { RC = `http://127.0.0.1:${cfg.topo.ports['release-controller']}`; }
export const url = () => RC;

async function call(method, p, body, timeoutMs = 5000) {
  const r = await fetchJson(`${RC}${p}`, { method, body, timeoutMs });
  if (r.status !== 200) throw new Error(`release-controller ${method} ${p} → ${r.status}: ${r.body?.error || ''}`);
  return r.body;
}

// { manifests, drift, freeze, parityGate, releases, history, versions, incidents, telemetry }
export const state = () => call('GET', '/api/state');
export const metrics = () => call('GET', '/api/metrics');
export const incident = (id) => fetchJson(`${RC}/api/incidents/${encodeURIComponent(id)}`, { timeoutMs: 5000 });
export const kpi = (site, from, to = Date.now()) => call('GET', `/api/kpi?site=${encodeURIComponent(site)}&from=${from}&to=${to}`);
export const errorSignatures = (site, from, to = Date.now()) => call('GET', `/api/error-signatures?site=${encodeURIComponent(site)}&from=${from}&to=${to}`);
export const setVersion = (site, service, version, { actor = 'system', reason = '' } = {}) => call('POST', '/api/versions', { site, service, version, actor, reason });
export const liftFreeze = (actor = '') => call('POST', '/api/freeze/lift', { actor });
export const setParity = (on) => call('POST', '/api/parity', { on });
export const release = (id) => call('GET', `/api/releases/${encodeURIComponent(id)}`);

// Start a release and wait until the controller has fully finished with it (rings, gates and — if a gate
// failed — the whole incident: rollback, recovery check, impact report, fix task). Same contract as the old
// in-process deploy.rollout(): resolves with the release record.
export async function rollout(opts, { timeoutMs = 15 * 60000 } = {}) {
  const { id } = await call('POST', '/api/releases', opts);
  const t0 = Date.now();
  for (;;) {
    await sleep(1000);
    try {
      const rel = await release(id);
      if (rel.settled) return rel;
    } catch (e) { if (Date.now() - t0 > timeoutMs) throw e; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`release ${id} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  }
}
