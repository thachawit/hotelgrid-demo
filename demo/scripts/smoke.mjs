// Headless end-to-end run of all scenarios against a fresh runtime (runtime-smoke/). Stop the demo first: same ports.
//   node scripts/smoke.mjs
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CP = 'http://127.0.0.1:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body) => (await fetch(CP + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); }
async function until(fn, ms, every = 2000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; }
const mismatch = async (site) => (await j('/api/metrics'))[site].kpi;

try { await fetch(CP); console.error('Port 4000 is busy — stop the running demo first.'); process.exit(2); } catch {}
const stack = spawn(process.execPath, ['scripts/start.mjs', '--reset', '--quiet'], { cwd: ROOT, env: { ...process.env, RUNTIME: path.join(ROOT, 'runtime-smoke') }, stdio: 'inherit' });
const stop = () => stack.kill('SIGINT');
process.on('exit', stop);
const t0 = Date.now();
try {
  await until(async () => { try { return (await fetch(`${CP}/api/state`)).ok; } catch { return false; } }, 30000, 500);
  await sleep(15000);
  await j('/api/settings', { autoApprove: true });
  const port = (svc) => `http://127.0.0.1:${({ 'llm-gateway': 4100, 'release-controller': 4300, finops: 4400 })[svc]}`;
  const impls = await Promise.all(['llm-gateway', 'release-controller', 'finops'].map(async (svc) => `${svc}=${(await (await fetch(`${port(svc)}/health`)).json()).impl}`));
  const lg = (await j('/api/state')).loadgen.stats;
  const goGw = process.env.GATEWAY_IMPL === 'node' ? impls.slice(1) : impls;
  check('Go services serving: release controller, finops, LLM gateway, loadgen', goGw.every((x) => x.endsWith('=go')) && lg.sent > 0, `${impls.join(', ')}; loadgen sent ${lg.sent}`);
  const before = await mismatch('bkk-pilot');
  check('baseline: seeded hvac bug causes setpoint mismatch at the pilot hotel', before.mismatchRate > 0.3, `mismatch ${(before.mismatchRate * 100).toFixed(0)}% (n=${before.setN})`);

  // S1
  await j('/api/scenarios/s1/run', {});
  const wi1 = await until(async () => { const s = await j('/api/state'); const w = s.workItems.find((x) => x.hypothesisId === 'hvac-peak-guard-inverted' || x.service === 'hvac-optimizer'); return w && ['done', 'failed', 'needs-human'].includes(w.status) ? w : null; }, 180000);
  check('S1: complaint cluster triaged, reproduced, fixed, shipped through 3 rings', wi1?.status === 'done', wi1 ? `${wi1.id} ${wi1.status} → ${wi1.service}@${wi1.newVersion}` : 'timeout');
  await sleep(12000);
  const after = await mismatch('bkk-pilot');
  check('S1: setpoint mismatch at the pilot hotel dropped', after.mismatchRate < 0.05, `now ${(after.mismatchRate * 100).toFixed(1)}%`);

  // S2
  await j('/api/scenarios/s2/run', {});
  const inc = await until(async () => { const s = await j('/api/state'); return s.incidents[0]?.status && s.incidents[0].status !== 'mitigating' ? s.incidents[0] : null; }, 120000);
  check('S2: bad release tripped the canary and was rolled back', inc?.status === 'mitigated', inc ? `${inc.id} detect→mitigate ${Math.round((inc.mitigatedAt - inc.detectedAt) / 1000)}s` : 'timeout');
  check('S2: culprit = rooms-svc@2.4.0 (not the loudest service)', inc?.culprit?.ranking?.[0]?.service === 'rooms-svc', `loudest ${inc?.culprit?.loudest?.service}`);
  const s2 = await j('/api/state');
  check('S2: other sites never received the release', ['bkk-riverside', 'phuket-beach', 'chiangmai-oldtown'].every((x) => s2.manifests[x]['rooms-svc'] === '2.3.1'));
  const wi2 = await until(async () => { const s = await j('/api/state'); const w = s.workItems.find((x) => x.origin === 'incident'); return w && ['done', 'failed', 'needs-human'].includes(w.status) ? w : null; }, 200000);
  check('S2: incident fix task went through the factory and shipped', wi2?.status === 'done', wi2 ? `${wi2.id} ${wi2.service}@${wi2.newVersion}` : 'timeout');
  const s2b = await j('/api/state');
  check('S2: freeze lifted, parity gate on', !s2b.freeze && s2b.parityGate);
  await j('/api/releases', { name: '2026.11-r2 (retry)', services: { 'rooms-svc': '2.4.0', 'guest-assistant': '3.1.0' }, level: 'L3' });
  const retry = await until(async () => { const s = await j('/api/state'); const r = s.releases.find((x) => x.name.includes('retry')); return r && !['rolling'].includes(r.status) ? r : null; }, 120000);
  check('S2: release r2 retried after the fix — completes', retry?.status === 'complete', retry?.status);

  // S3
  await j('/api/scenarios/s3/run', {});
  const s3 = await until(async () => { const r = await j('/api/scenarios'); return r.s3 && r.s3.status !== 'running' ? r.s3 : null; }, 240000);
  const cs = await j('/api/cost/state');
  check('S3: advisor produced findings F1–F4 (+F6 infra) with citations', ['F1', 'F2', 'F3', 'F4'].every((id) => cs.findings.some((f) => f.id === id)) && cs.findings.every((f) => f.citations.length), cs.findings.map((f) => `${f.id} $${Math.round(f.monthlySavingsUsd)}`).join(', '));
  const arms = Object.fromEntries((cs.shadow?.arms || []).map((a) => [a.model, a]));
  check('S3: shadow eval — medium@low passes, small fails the Thai slice', arms.medium?.pass === true && arms.small?.pass === false, `small Thai Δ ${(arms.small?.diffThai?.mean * 100).toFixed(1)} pts`);
  check('S3: swap canary promoted', cs.canary?.status === 'promoted', s3?.status);
  const wi3 = await until(async () => { const s = await j('/api/state'); const w = s.workItems.find((x) => x.origin === 'cost'); return w && ['done', 'failed', 'needs-human'].includes(w.status) ? w : null; }, 200000);
  check('S3: prompt-cache fix shipped through the factory (Thai slice held)', wi3?.status === 'done', wi3 ? `${wi3.service}@${wi3.newVersion}` : 'timeout');
  await sleep(15000);
  const cost = await j('/api/cost/summary?liveWindowSec=30');
  const intent = cost.live.find((r) => r.route === 'assistant.intent');
  check('S3: live prompt-cache hit rate on assistant.intent > 50%', intent?.cacheHitRate > 0.5, `${((intent?.cacheHitRate || 0) * 100).toFixed(1)}%`);

  // forced bad canary
  await j('/api/scenarios/s3-bad/run', {});
  const bad = await until(async () => { const c = await j('/api/cost/state'); return c.canary?.status && c.canary.status !== 'running' && c.canary.to.model === 'small' ? c.canary : null; }, 150000);
  check('S3: forced small-tier canary auto-reverted on online accuracy', bad?.status === 'reverted', bad ? `at ${bad.steps.at(-1).weight}%` : 'timeout');

  // S4 — bill reconciliation + budgets
  const pre = await j('/api/finops');
  check('S4 setup: notebook calls the provider directly (invisible to the ledger)', pre.notebook?.mode === 'direct' && pre.notebook.ok > 0, JSON.stringify(pre.notebook && { mode: pre.notebook.mode, ok: pre.notebook.ok }));
  await j('/api/scenarios/s4/run', {});
  const s4 = await until(async () => { const r = await j('/api/scenarios'); return r.s4 && r.s4.status !== 'running' ? r.s4 : null; }, 90000, 1000);
  const fin = await j('/api/finops');
  const rc = fin.recon;
  const nbKey = rc?.findings.find((f) => f.apiKeyId === 'apikey_ds_review_notebook');
  check('S4: reconciliation finds the bill/ledger gap and the unrouted key', !!nbKey && rc.varianceDays >= 5, nbKey ? `${rc.varianceDays} variance days, ≈$${Math.round(nbKey.monthly)}/month on ${nbKey.name}` : s4?.error);
  check('S4: gateway-key residual ≤ 0.5% on complete days (metering accurate)', rc && rc.maxResidualPct <= 0.005, rc ? `${(rc.maxResidualPct * 100).toFixed(3)}%` : '');
  const nbAfter = await until(async () => { const f = await j('/api/finops'); return f.notebook?.mode === 'gateway' && f.notebook.blocked > 0 ? f.notebook : null; }, 30000, 1000);
  check('S4: key deactivated → notebook re-pointed to the gateway → blocked by budget (429)', !!nbAfter, nbAfter?.lastError || '');
  const dataBudget = (await j('/api/finops')).budgets.find((b) => b.team === 'team-data');
  check('S4: team-data budget exceeded after attributing unrouted spend', dataBudget?.status === 'exceeded', dataBudget ? `$${dataBudget.mtd.toFixed(0)} of $${dataBudget.budget}` : '');
  const ids = (await j('/api/cost/state')).findings.map((f) => f.id);
  check('S4: advisor findings include F5 (unrouted key) and F6 (idle GPU from cloud export)', ids.includes('F5') && ids.includes('F6'), ids.join(','));
} catch (e) {
  check('smoke run', false, e.message);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s`);
stop();
setTimeout(() => process.exit(failed ? 1 : 0), 800);
