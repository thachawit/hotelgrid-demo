// Deterministic 30-day production history (hourly rows). Used by BOTH the gateway ledger and the simulated provider
// bill, so the two agree exactly on gateway traffic — any difference on the bill must come from somewhere else.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateTokens } from './util.mjs';
import { priceCall } from './pricing.mjs';

export const startOfTodayUtc = () => new Date(new Date().toISOString().slice(0, 10)).getTime();
export const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

const DIURNAL = [0.25, 0.15, 0.1, 0.1, 0.15, 0.35, 0.8, 1.4, 1.6, 1.4, 1.2, 1.2, 1.3, 1.25, 1.2, 1.2, 1.3, 1.5, 1.7, 1.8, 1.6, 1.3, 0.9, 0.5];

// The data team's review-summary notebook: calls the provider directly with its own key (bypasses the gateway).
export const NOTEBOOK = {
  apiKeyId: 'apikey_ds_review_notebook', team: 'team-data', model: 'large', callsPerDay: 400, input: 12000, output: 400,
  startedDaysAgo: 9,
};

async function promptSizes(root) {
  const asst = await import(pathToFileURL(path.join(root, 'app/services/guest-assistant/versions/3.0.2.mjs')).href);
  return { intentSys: estimateTokens(asst.buildIntentRequest('x').system[0].text), replySys: estimateTokens(asst.REPLY_INSTRUCTIONS) };
}

// rows: { ts, day, route, team, model, effort, calls, batch, usage:{input_tokens,...}, costUsd, apiKeyId }
export async function gatewayHistory(root, { days = 30, today = startOfTodayUtc() } = {}) {
  const { intentSys, replySys } = await promptSizes(root);
  // [route, team, model, effort, callsPerDay, input, output, cacheRead, cacheWrite, guestTraffic, batch]
  const shapes = [
    ['assistant.intent', 'team-guest-ai', 'large', 'high', 21000, 26, 22, 0, intentSys, true, 0],
    ['assistant.reply', 'team-guest-ai', 'medium', 'medium', 21000, replySys + 46, 34, 0, 0, true, 0],
    ['eval.golden', 'team-platform', 'large', 'high', 1550, 26, 22, 0, intentSys, false, 0],
    ['factory.triage', 'team-platform', 'large', 'high', 8, 2600, 700, 0, 0, false, 0],
    ['factory.repro', 'team-platform', 'large', 'high', 6, 2200, 1000, 0, 0, false, 0],
    ['factory.build', 'team-platform', 'large', 'xhigh', 6, 4800, 2600, 0, 0, false, 0],
    ['factory.review', 'team-platform', 'medium', 'high', 8, 2400, 420, 0, 0, false, 0],
    ['cost.advisor', 'team-finops', 'large', 'high', 1, 3000, 900, 0, 0, false, 0],
  ];
  const dsum = DIURNAL.reduce((a, b) => a + b, 0);
  const rows = [];
  for (let d = days; d >= 1; d--) {
    const dayStart = today - d * 86400000;
    const dow = new Date(dayStart).getUTCDay();
    const growth = 1 + (days - d) * 0.004;
    const weekend = dow === 0 || dow === 6 ? 1.12 : 1;
    for (const [route, team, model, effort, perDay, inp, out, cr, cw, guest, batch] of shapes) {
      let carry = 0;
      for (let h = 0; h < 24; h++) {
        const share = guest ? DIURNAL[h] / dsum : (h >= 2 && h < 20 ? 1 / 18 : 0);
        carry += perDay * growth * (guest ? weekend : 1) * share * (0.92 + ((d * 7 + h * 13) % 17) / 100);
        const calls = Math.floor(carry);
        carry -= calls;
        if (!calls) continue;
        const usage = { input_tokens: inp * calls, output_tokens: out * calls, cache_read_input_tokens: cr * calls, cache_creation_input_tokens: cw * calls };
        rows.push({ ts: dayStart + h * 3600000, day: dayOf(dayStart), route, team, model, effort, calls, batch, usage, costUsd: priceCall(model, usage, !!batch), apiKeyId: 'apikey_gateway_prod' });
      }
    }
  }
  return rows;
}

export function notebookHistory({ today = startOfTodayUtc() } = {}) {
  const rows = [];
  for (let d = NOTEBOOK.startedDaysAgo; d >= 1; d--) {
    const dayStart = today - d * 86400000;
    // nightly job: runs 01:00-05:00 UTC
    for (let h = 1; h <= 4; h++) {
      const calls = Math.round((NOTEBOOK.callsPerDay / 4) * (0.9 + ((d * 5 + h * 3) % 7) / 30));
      const usage = { input_tokens: NOTEBOOK.input * calls, output_tokens: NOTEBOOK.output * calls, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      rows.push({ ts: dayStart + h * 3600000, day: dayOf(dayStart), route: null, team: null, model: NOTEBOOK.model, effort: null, calls, batch: 0, usage, costUsd: priceCall(NOTEBOOK.model, usage), apiKeyId: NOTEBOOK.apiKeyId });
    }
  }
  return rows;
}
