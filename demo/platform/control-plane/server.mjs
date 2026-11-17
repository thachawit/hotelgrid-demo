// Control plane (Node): dashboard + APIs + SSE hub. Owns intake/signals, the factory pipeline, the cost layer and
// the ledger. Delegates to the Go services over HTTP:
//   release-controller (go/cmd/release-controller): telemetry, manifests, ring rollouts, canary gates, rollback, incidents
//   finops            (go/cmd/finops):             budgets, bill reconciliation, provider key actions
// Go services push their log lines and events to /ingest/events and use /internal/* for ledger and intake access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, createRouter, reply, send, fetchJson } from '../lib/util.mjs';
import * as bus from './bus.mjs';
import * as ledger from './ledger.mjs';
import * as rc from './release-client.mjs';
import * as fin from './finops-client.mjs';
import * as signals from './signals.mjs';
import * as ws from './workspace.mjs';
import * as pipeline from './pipeline.mjs';
import * as cost from './cost.mjs';
import * as scenarios from './scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const topo = readJson('config/topology.json');
const sitesCfg = readJson('config/sites.json');
const runtime = process.env.RUNTIME || path.join(ROOT, 'runtime');
const cfg = { root: ROOT, runtime, workspace: path.join(runtime, 'workspace'), topo, sites: sitesCfg.sites, rings: sitesCfg.rings };

await ledger.init({ dbPath: path.join(runtime, 'data/ledger.db'), accel: topo.accel, root: ROOT });
rc.init(cfg);
fin.init(cfg);
ws.init(cfg);
pipeline.init(cfg);
cost.init(cfg);
signals.init(cfg, { clusterReady: pipeline.clusterReady });

const loadgen = { paused: false, rate: 1, complaintRate: 0.07, stats: {} };
const router = createRouter();
const UI = path.join(ROOT, 'platform/ui');
const DIAGRAMS = path.resolve(ROOT, '..', 'diagrams');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
function file(res, p) {
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
  return { __status: 0 };
}
const safe = (base, rel) => { const p = path.resolve(base, rel); return p.startsWith(base) ? p : null; };
const proxied = (r) => (r.status === 200 ? r.body : reply(r.status, r.body));

router.get('/', ({ res }) => { file(res, path.join(UI, 'index.html')); });
router.get('/ui/:file', ({ res, params }) => { const p = safe(UI, params.file); p ? file(res, p) : send(res, 400, 'bad path'); });
router.get('/diagrams/:file', ({ res, params }) => { const p = safe(DIAGRAMS, params.file); p ? file(res, p) : send(res, 400, 'bad path'); });
router.get('/reports/:file', ({ res, params }) => { const p = safe(path.join(runtime, 'reports'), params.file); p ? file(res, p) : send(res, 400, 'bad path'); });
router.get('/events', ({ req, res }) => { bus.sse(req, res); });

// ---- ingest ----
router.post('/ingest/usage', ({ body }) => { ledger.insertLive(body.rows || [], 1 / topo.accel); return { ok: true }; });
// spans belong to the release controller (telemetry); kept here for older senders
router.post('/ingest/spans', async ({ body }) => proxied(await fetchJson(`${rc.url()}/ingest/spans`, { method: 'POST', body, timeoutMs: 5000 })));
// log lines and events from the Go services → the same bus/SSE stream the UI already listens to
router.post('/ingest/events', ({ body }) => {
  for (const ev of body.events || []) {
    if (ev.type === 'log') bus.say(ev.data?.source || 'system', ev.data?.msg || '', { level: ev.data?.level || 'info' });
    else bus.emit(ev.type, ev.data);
  }
  return { ok: true };
});

// ---- internal API for the Go services ----
router.post('/internal/tasks', ({ body }) => { const cl = signals.addTask(body); return { cluster: cl?.id || null, workItem: cl?.workItem || null }; });
router.get('/internal/signals', ({ query }) => signals.signalsIn(query.site, Number(query.from) || 0, Number(query.to) || Date.now()));
router.post('/internal/ledger/budget-inputs', ({ body }) => ({ teams: ledger.budgetInputs(body) }));
router.post('/internal/ledger/daily', ({ body }) => ({ days: ledger.dailyTotals(body.from, body.to, { excludeLiveProvider: body.excludeLiveProvider || null }) }));
router.post('/internal/ledger/adjustments', ({ body }) => ({ ok: true, n: ledger.upsertAdjustments(body.rows || []) }));
router.post('/internal/ledger/decisions', ({ body }) => { ledger.insertDecision(body); return { ok: true }; });
router.post('/internal/ledger/trace-cost', ({ body }) => ledger.traceCost(body.traceIds || []));

// ---- runtime config consumed by services / gateway / loadgen ----
router.get('/api/manifests', async () => proxied(await fetchJson(`${rc.url()}/api/manifests`, { timeoutMs: 2000 })));
router.get('/api/gateway/routes', () => ({ routes: cost.routing.routes, budgets: fin.gatewayBudgets() }));
router.get('/api/loadgen', () => ({ paused: loadgen.paused, rate: loadgen.rate, complaintRate: loadgen.complaintRate }));
router.post('/api/loadgen', ({ body }) => { Object.assign(loadgen, body); bus.say('system', `loadgen: ${JSON.stringify(body)}`); return loadgen; });
router.post('/api/loadgen/stats', ({ body }) => { loadgen.stats = body; return { ok: true }; });

// ---- ds-notebook (simulated rogue job) reports its state; demo can pause it ----
const notebook = { paused: false };
router.post('/api/notebook', ({ body }) => { fin.local.notebook = { ...body, at: Date.now() }; return notebook; });
router.post('/api/notebook/pause', ({ body }) => { notebook.paused = !!body.paused; return notebook; });

// ---- intake ----
router.post('/api/signals', ({ body }) => signals.add(body));

// ---- state for the UI ----
router.get('/api/state', async () => {
  let d;
  try { d = await rc.state(); } catch (e) { return reply(503, { error: `release controller unavailable: ${e.message}` }); }
  return {
    now: Date.now(), topo, sites: sitesCfg.sites, rings: sitesCfg.rings,
    manifests: d.manifests, drift: d.drift, freeze: d.freeze, parityGate: d.parityGate,
    releases: d.releases, history: d.history, versions: d.versions, incidents: d.incidents,
    workItems: pipeline.items.map((w) => ({ ...pipeline.summary(w), diff: undefined, specMd: undefined, steps: w.steps.slice(-3) })),
    clusters: signals.clusters.slice(0, 25), signals: signals.signals.slice(0, 60),
    settings: pipeline.settings, loadgen, scenarios: scenarios.running, telemetry: d.telemetry, log: bus.recentLog(150),
  };
});
router.get('/api/metrics', async () => proxied(await fetchJson(`${rc.url()}/api/metrics`, { timeoutMs: 5000 })));
router.get('/api/incidents/:id', async ({ params }) => proxied(await rc.incident(params.id)));
router.get('/api/workitems/:id', ({ params }) => { const w = pipeline.items.find((x) => x.id === params.id); return w ? pipeline.summary(w) : reply(404, { error: 'not found' }); });
router.post('/api/workitems/:id/approve', ({ params, body }) => ({ ok: pipeline.approve(params.id, body.who || 'engineer (UI)') }));
router.post('/api/clusters/:id/triage', ({ params }) => { const wi = pipeline.start(params.id); return { workItem: wi.id }; });
router.post('/api/settings', ({ body }) => { Object.assign(pipeline.settings, body); bus.say('system', `settings: ${JSON.stringify(pipeline.settings)}`); return pipeline.settings; });
router.post('/api/releases', async ({ body }) => proxied(await fetchJson(`${rc.url()}/api/releases`, { method: 'POST', body: { ...body, actor: body.actor || 'engineer (UI)' }, timeoutMs: 5000 })));
router.post('/api/freeze/lift', async () => { await rc.liftFreeze('engineer (UI)'); return { ok: true }; });
router.post('/api/parity', async ({ body }) => rc.setParity(!!body.on));
router.get('/api/git/log', () => ({ log: ws.log(25) }));

// ---- scenarios ----
const S = { s1: scenarios.selfHeal, s2: scenarios.badRelease, s3: scenarios.costReview, 's3-bad': scenarios.badCanary, s4: scenarios.billReconcile };
router.post('/api/scenarios/:id/run', ({ params, body }) => {
  const fn = S[params.id];
  if (!fn) return reply(404, { error: 'unknown scenario' });
  fn(body).catch(() => {});
  return { started: params.id };
});
router.get('/api/scenarios', () => scenarios.running);

// ---- cost ----
router.get('/api/cost/summary', ({ query }) => cost.summary({ liveWindowSec: Number(query.liveWindowSec) || 300 }));
router.get('/api/cost/state', () => cost.publicState());
router.post('/api/cost/advisor', async () => { await cost.runAdvisor(); return cost.publicState(); });
router.post('/api/cost/findings/F1/fix', () => ({ cluster: cost.createCacheFixTask().id }));
router.post('/api/cost/findings/F3/apply', () => cost.applyBatch());
router.post('/api/cost/shadow', ({ body }) => { cost.runShadow(body).catch((e) => bus.say('cost', `shadow eval error: ${e.message}`, { level: 'error' })); return { started: true }; });
router.post('/api/cost/canary', ({ body }) => { cost.startCanary(body).catch((e) => bus.say('cost', `canary error: ${e.message}`, { level: 'error' })); return { started: true }; });

// ---- finops (Go service): bill reconciliation, budgets; infra cost from the ledger ----
router.get('/api/finops', () => fin.publicState());
router.get('/api/finops/recon', async () => (await fin.recon()) || reply(404, { error: 'not run yet' }));
router.post('/api/finops/reconcile', async ({ body }) => { await fin.reconcile({ days: body.days || 14, actor: body.actor || 'finops (UI)' }); return fin.publicState(); });
router.post('/api/finops/keys/:id/deactivate', async ({ params, body }) => ({ key: await fin.deactivateKey(params.id, body.approvedBy || 'engineer (UI)') }));
router.post('/api/finops/budgets/:team/raise', async ({ params, body }) => { await fin.raiseBudget(params.team, Number(body.monthlyUsd), body.approvedBy || 'owner (UI)'); return fin.publicState(); });

await serve(topo.ports['control-plane'], router);
bus.say('system', `control plane on http://127.0.0.1:${topo.ports['control-plane']} — ${sitesCfg.sites.length} sites, ${Object.keys(topo.services).length} services (release controller + finops in Go)`);
