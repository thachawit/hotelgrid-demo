// SIMULATED rogue spend: the data team's "review summaries" notebook. It was set up with its own provider API key
// and calls the provider DIRECTLY — no gateway, so no tags, no PII redaction, no budget, invisible in the ledger.
// Only the provider bill sees it. When its key is deactivated it is re-pointed at the gateway (route
// data.review-summaries, team-data), where budgets apply.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep, traceId } from '../lib/util.mjs';
import { NOTEBOOK } from '../lib/seed-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
const CP = `http://127.0.0.1:${topo.ports['control-plane']}`;

const REVIEWS = [
  'Staff were lovely, breakfast great, but the AC took ages to cool the room.',
  'ห้องสะอาด พนักงานบริการดี แต่แอร์เย็นช้ามาก',
  'Noise from the street on the 5th floor. Pool was excellent.',
  'Check-in quick. Room smelled fresh. Wifi dropped twice.',
  'อาหารเช้าอร่อย สระว่ายน้ำสวย ห้องชั้นล่างเสียงดัง',
];
function batchText() {
  const lines = [];
  while (lines.join('\n').length < NOTEBOOK.input * 3.6) lines.push(`review ${lines.length + 1}: ${REVIEWS[lines.length % REVIEWS.length]}`);
  return lines.join('\n');
}
const DOC = batchText();

const state = { mode: 'direct', sent: 0, ok: 0, blocked: 0, unauthorized: 0, lastStatus: null, lastError: null };
let paused = false;

async function report() {
  const r = await fetchJson(`${CP}/api/notebook`, { method: 'POST', body: state, timeoutMs: 2000 });
  if (r.status === 200) paused = !!r.body.paused;
}

async function once() {
  const body = {
    system: 'Summarize these hotel guest reviews into themes with counts. Output 5 bullet points.',
    messages: [{ role: 'user', content: DOC }],
    max_tokens: 600, metadata: { task: 'review-summary' },
  };
  let r;
  if (state.mode === 'direct') {
    r = await fetchJson(`http://127.0.0.1:${topo.ports['sim-llm']}/v1/messages`, {
      method: 'POST', body: { ...body, model: NOTEBOOK.model, output_config: { effort: 'high' } }, timeoutMs: 20000,
      headers: { 'x-api-key': NOTEBOOK.apiKeyId },
    });
    if (r.status === 401) {
      state.unauthorized++;
      state.mode = 'gateway';
      state.lastError = r.body?.error?.message;
      console.log('[ds-notebook] provider key rejected — re-pointed to the LLM gateway (route data.review-summaries)');
      return;
    }
  } else {
    r = await fetchJson(`http://127.0.0.1:${topo.ports['llm-gateway']}/v1/messages`, {
      method: 'POST', body, timeoutMs: 20000,
      headers: { 'x-route': 'data.review-summaries', 'x-caller': 'ds-notebook', 'x-site-id': 'analytics', 'x-trace-id': traceId() },
    });
    if (r.status === 429) { state.blocked++; state.lastError = r.body?.error?.message; await sleep(4000); }
  }
  state.sent++;
  state.lastStatus = r.status;
  if (r.status === 200) state.ok++;
}

setInterval(report, 2000);
await sleep(3000);
console.log(`[ds-notebook] summarizing reviews with ${NOTEBOOK.model} via ${state.mode} provider key ${NOTEBOOK.apiKeyId}`);
for (;;) {
  if (!paused) await once().catch((e) => { state.lastError = e.message; });
  await sleep(2500);
}
