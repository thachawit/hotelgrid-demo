// Starts the whole demo: sim LLM, Go services (release controller, finops, LLM gateway, loadgen), control plane,
// 5 HotelGrid services, ds-notebook.  GATEWAY_IMPL=node runs the Node gateway instead of the Go one.
//   node scripts/start.mjs            (reuses runtime/ if present)
//   node scripts/start.mjs --reset    (fresh workspace repo, ledger and reports)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = process.env.RUNTIME || path.join(ROOT, 'runtime');
const WS = path.join(RUNTIME, 'workspace');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
const quiet = process.argv.includes('--quiet');

export function resetRuntime() {
  fs.rmSync(RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUNTIME, 'logs'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'app'), WS, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=hotelgrid', '-c', 'user.email=dev@hotelgrid.invalid', '-c', 'commit.gpgsign=false', '-C', WS, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'HotelGrid baseline: api-gateway 5.2.0, rooms-svc 2.3.1/2.4.0, hvac-optimizer 1.8.0/1.9.0-rc1, guest-assistant 3.0.2/3.1.0, feedback-intake 1.4.0');
}

if (process.argv.includes('--reset') || !fs.existsSync(path.join(WS, '.git'))) {
  resetRuntime();
  console.log(`runtime reset: ${RUNTIME}`);
}
fs.mkdirSync(path.join(RUNTIME, 'logs'), { recursive: true });

const env = { ...process.env, WORKSPACE: WS, RUNTIME, CP_QUIET: quiet ? '1' : '0' };
const children = [];
function start(name, args, opts = {}) {
  const log = fs.createWriteStream(path.join(RUNTIME, 'logs', `${name}.log`), { flags: 'a' });
  const p = spawn(opts.cmd || process.execPath, args, { cwd: ROOT, env });
  const out = (d) => {
    log.write(d);
    if (opts.show && !quiet) for (const line of String(d).split('\n').filter(Boolean)) console.log(`${name.padEnd(15)}│ ${line}`);
  };
  p.stdout.on('data', out);
  p.stderr.on('data', (d) => { log.write(d); if (!quiet) for (const l of String(d).split('\n').filter(Boolean)) console.error(`${name.padEnd(15)}│ ${l}`); });
  p.on('exit', (code) => { if (code && !stopping) console.error(`${name} exited with ${code} — see runtime/logs/${name}.log`); });
  children.push(p);
  return p;
}

async function waitFor(url, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

let stopping = false;
function stop() { stopping = true; for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Go services (go/cmd/*): llm-gateway, release-controller, finops, loadgen. Built on every start; the Go build
// cache makes repeat builds take about a second.
const BIN = path.join(RUNTIME, 'bin');
try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch {
  console.error('Go toolchain not found. Install Go 1.24+ (https://go.dev/dl/ or `brew install go`) and run again.');
  process.exit(1);
}
execFileSync('go', ['build', '-C', path.join(ROOT, 'go'), '-o', BIN + path.sep, './cmd/...'], { stdio: 'inherit' });
const goBin = (name) => path.join(BIN, name);
const url = (svc, p = '') => `http://127.0.0.1:${topo.ports[svc]}${p}`;

start('sim-llm', ['--experimental-sqlite', '--no-warnings', 'platform/llm/sim-llm.mjs']);
start('release-controller', ['-root', ROOT], { cmd: goBin('release-controller') });
start('finops', ['-root', ROOT], { cmd: goBin('finops') });
start('control-plane', ['--experimental-sqlite', '--no-warnings', 'platform/control-plane/server.mjs'], { show: true });
await waitFor(url('control-plane', '/api/loadgen'));
await waitFor(url('release-controller', '/health'));
await waitFor(url('finops', '/health'));
if (process.env.LLM_PROVIDER === 'anthropic' && process.env.GATEWAY_IMPL !== 'node') {
  // Optional real Claude for guest-assistant calls. The adapter is its own Go module (official Go SDK), so the default
  // build stays dependency-free. Credentials are resolved by the SDK from your environment; calls are billed.
  execFileSync('go', ['build', '-C', path.join(ROOT, 'go/claude-adapter'), '-o', goBin('claude-adapter'), '.'], { stdio: 'inherit' });
  start('claude-adapter', ['-root', ROOT], { cmd: goBin('claude-adapter'), show: true });
  await waitFor(url('claude-adapter', '/health'));
}
if (process.env.GATEWAY_IMPL === 'node') start('llm-gateway', ['platform/llm/gateway.mjs']); // Node fallback / benchmark baseline
else start('llm-gateway', ['-root', ROOT], { cmd: goBin('llm-gateway') });
for (const svc of Object.keys(topo.services)) start(svc, ['platform/service-host.mjs', svc]);
await waitFor(url('llm-gateway', '/health'));
for (const svc of Object.keys(topo.services)) await waitFor(url(svc, '/__health'));
start('loadgen', ['-root', ROOT], { cmd: goBin('loadgen') });
start('ds-notebook', ['platform/loadgen/ds-notebook.mjs']);
console.log(`\n  HotelGrid dark-factory demo running → http://127.0.0.1:${topo.ports['control-plane']}\n  Ctrl+C to stop. Logs: ${path.relative(process.cwd(), path.join(RUNTIME, 'logs'))}\n`);
