// Gateway overhead benchmark: Node gateway vs Go gateway against stub provider / control plane / telemetry that answer
// instantly, so the measured latency is the gateway's own work (parse, route, price, buffer rows, proxy).
// Stop the demo first (same ports). The load client and the stubs share one Node process, so at high req/s the
// client is the bottleneck: treat the Go throughput as a lower bound.
//   node scripts/bench-gateway.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goBin = path.join(os.tmpdir(), 'hotelgrid-bench-llm-gateway');
execFileSync('go', ['build', '-C', path.join(root, 'go'), '-o', goBin, './cmd/llm-gateway'], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stub = (port, handler) => new Promise((res) => { const s = http.createServer(handler); s.keepAliveTimeout = 5000; s.listen(port, '127.0.0.1', () => res(s)); });
const json = (res, body) => { const b = JSON.stringify(body); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
const drain = (req, cb) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => cb(Buffer.concat(c).toString())); };

const routes = JSON.parse(fs.readFileSync(path.join(root, 'config/routing.json'), 'utf8')).routes;
const servers = await Promise.all([
  stub(4000, (req, res) => drain(req, () => json(res, req.url.startsWith('/api/gateway/routes') ? { routes, budgets: {} } : { ok: true }))),
  stub(4300, (req, res) => drain(req, () => json(res, { ok: true }))),
  stub(4200, (req, res) => drain(req, () => json(res, { id: 'msg_bench', type: 'message', role: 'assistant', model: 'large',
    content: [{ type: 'text', text: '{"intent":"set_temperature"}' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1800, output_tokens: 40, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 } }))),
]);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const body = JSON.stringify({ system: [{ type: 'text', text: 'You are the HotelGrid guest assistant. Classify the intent.' }],
  messages: [{ role: 'user', content: 'Room 1204. Guest: ช่วยตั้งแอร์ 22 องศาค่ะ' }], max_tokens: 200, metadata: { task: 'intent' } });
function one() {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: 4100, path: '/v1/messages', method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-route': 'assistant.intent', 'x-trace-id': Math.random().toString(16).slice(2), 'x-site-id': 'bkk-pilot', 'x-eval-label': 'set_temperature' } },
    (res) => { res.resume(); res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.statusCode })); });
    req.on('error', () => resolve({ ms: 0, status: 0 }));
    req.end(body);
  });
}
async function load(n, conc) {
  const lat = [];
  let next = 0, bad = 0;
  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: conc }, async () => { while (next++ < n) { const r = await one(); if (r.status !== 200) bad++; lat.push(r.ms); } }));
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)];
  return { rps: Math.round(n / sec), p50: p(0.5).toFixed(2), p99: p(0.99).toFixed(2), bad };
}
async function bench(name, cmd, args) {
  const proc = spawn(cmd, args, { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:4100/health'); if (r.ok) break; } catch {} await sleep(100); }
  await sleep(1500); // first route-table poll
  await load(3000, 32); // warm-up (JIT / connection pool)
  const rssIdle = Number(execSync(`ps -o rss= -p ${proc.pid}`).toString().trim());
  const c1 = await load(5000, 1);
  const c64 = await load(30000, 64);
  const rss = Number(execSync(`ps -o rss= -p ${proc.pid}`).toString().trim());
  proc.kill('SIGTERM');
  await sleep(500);
  return { name, 'p50 ms (1 client)': c1.p50, 'p99 ms (1 client)': c1.p99, 'req/s (64 clients)': c64.rps, 'p50 ms (64)': c64.p50, 'p99 ms (64)': c64.p99, 'RSS MB after load': (rss / 1024).toFixed(0), errors: c1.bad + c64.bad, 'RSS idle MB': (rssIdle / 1024).toFixed(0) };
}
const rows = [await bench('node', process.execPath, ['platform/llm/gateway.mjs']), await bench('go', goBin, ['-root', root])];
console.table(rows);
servers.forEach((s) => s.close());
agent.destroy();
process.exit(0);
