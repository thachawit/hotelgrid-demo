// Generic service host. One process per service; serves every site and hot-loads the version each site's manifest
// names. State (rooms, etc.) lives here so it survives version swaps. Emits one server span per request.
// Manifests come from, and spans go to, the Go release controller. GET /__meta/<version> serves a version's
// release-note metadata (meta.breaking, meta.migrations) for culprit scoring and impact reports.
//   node platform/service-host.mjs <service-name>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { serve, createRouter, fetchJson, spanId as newSpanId, traceId as newTraceId, send } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/sites.json'), 'utf8')).sites;
const WORKSPACE = process.env.WORKSPACE || path.join(ROOT, 'runtime/workspace');
const RC = `http://127.0.0.1:${topo.ports['release-controller']}`;
const port = topo.ports[name];
if (!port) { console.error(`unknown service ${name}`); process.exit(1); }

const siteById = Object.fromEntries(sites.map((s) => [s.id, s]));
const states = new Map(); // siteId -> state object
let manifests = {};       // siteId -> { svc: version }
const modules = new Map(); // version -> { mtime, mod, compiled }

async function pollManifests() {
  const r = await fetchJson(`${RC}/api/manifests`, { timeoutMs: 2000 });
  if (r.status === 200) manifests = r.body.sites || {};
}
setInterval(pollManifests, 1000);

function compile(routes) {
  return Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
    return { method, pattern, re, keys, handler };
  });
}

async function loadVersion(version) {
  const file = path.join(WORKSPACE, 'services', name, 'versions', `${version}.mjs`);
  const stat = fs.statSync(file);
  const cached = modules.get(version);
  if (cached && cached.mtime === stat.mtimeMs) return cached;
  const mod = await import(`${pathToFileURL(file).href}?v=${stat.mtimeMs}`);
  const entry = { mtime: stat.mtimeMs, mod, compiled: compile(mod.routes) };
  modules.set(version, entry);
  return entry;
}

// ---- span shipping ----
let spanBuf = [];
setInterval(async () => {
  if (!spanBuf.length) return;
  const batch = spanBuf; spanBuf = [];
  await fetchJson(`${RC}/ingest/spans`, { method: 'POST', body: { spans: batch }, timeoutMs: 3000 });
}, 400);

const router = createRouter();
router.add('GET', '/__health', () => ({ service: name, ok: true, versions: Object.fromEntries(Object.entries(manifests).map(([s, m]) => [s, m[name]])) }));
router.add('GET', '/__meta/:version', async ({ params }) => {
  try { return (await loadVersion(params.version)).mod.meta || {}; } catch { return { __status: 404, body: { error: `no ${name}@${params.version}` } }; }
});
router.add('*', '/.*', async ({ req, res, body, query, headers }) => {
  const url = new URL(req.url, 'http://x');
  const siteId = headers['x-site-id'];
  const site = siteById[siteId];
  if (!site) return send(res, 400, { error: 'x-site-id header required' });
  const version = manifests[siteId]?.[name];
  if (!version) return send(res, 503, { error: `no manifest for ${name} at ${siteId}` });

  const traceId = headers['x-trace-id'] || newTraceId();
  const span = {
    traceId, spanId: newSpanId(), parentId: headers['x-parent-span'] || null,
    service: name, version, site: siteId, method: req.method, path: url.pathname, route: null,
    status: 0, ms: 0, error: null, attrs: {}, ts: Date.now(),
  };
  const evalLabel = headers['x-eval-label'];
  const started = performance.now();
  let status = 500, out = { error: 'unhandled' };
  try {
    const entry = await loadVersion(version);
    if (!states.has(siteId)) states.set(siteId, {});
    const state = states.get(siteId);
    if (entry.mod.init) entry.mod.init(state, site);
    const m = entry.compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!m) { status = 404; out = { error: `no route ${req.method} ${url.pathname} in ${name}@${version}` }; }
    else {
      span.route = `${m.method} ${m.pattern}`;
      const params = Object.fromEntries(m.keys.map((k, i) => [k, decodeURIComponent(m.re.exec(url.pathname)[i + 1])]));
      const hdrs = { 'x-site-id': siteId, 'x-trace-id': traceId, 'x-parent-span': span.spanId, ...(evalLabel ? { 'x-eval-label': evalLabel } : {}) };
      const ctx = {
        site, state, version, traceId,
        attrs: (a) => Object.assign(span.attrs, a),
        call: (svc, method, p, b) => fetchJson(`http://127.0.0.1:${topo.ports[svc]}${p}`, { method, body: b, headers: hdrs, timeoutMs: 8000 }),
        llm: (route, payload) => fetchJson(`http://127.0.0.1:${topo.ports['llm-gateway']}/v1/messages`, {
          method: 'POST', body: payload, timeoutMs: 15000,
          headers: { ...hdrs, 'x-route': route, 'x-caller': name },
        }),
      };
      const r = await m.handler(ctx, { params, body, query, headers });
      status = r.status; out = r.body;
    }
  } catch (e) {
    status = 500; out = { error: e.message }; span.error = `${e.name}: ${e.message}`;
  }
  span.status = status;
  span.ms = Math.round((performance.now() - started) * 10) / 10;
  if (status >= 500 && !span.error) span.error = out?.error || `HTTP ${status}`;
  spanBuf.push(span);
  send(res, status, out);
});

await pollManifests();
await serve(port, router);
console.log(`[${name}] listening on :${port} (workspace ${WORKSPACE})`);
