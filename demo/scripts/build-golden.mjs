// Builds app/evals/golden/*.jsonl from the labeled corpus. Run once; output is committed in app/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_TEMPLATES, TEMPS, render } from '../platform/loadgen/corpus.mjs';
import { classify } from '../platform/llm/intent-lexicon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'app/evals/golden');
fs.mkdirSync(out, { recursive: true });

// Assistant intent golden set: every template; temperature templates expanded with 3 temps.
const rows = [];
let n = 0;
for (const tpl of CHAT_TEMPLATES) {
  const temps = tpl.text.includes('{t}') ? [21, 23.5, 26] : [null];
  for (const t of temps) {
    const text = t === null ? tpl.text : render(tpl, t);
    rows.push({ id: `ai-${String(++n).padStart(3, '0')}`, lang: tpl.lang, text, expect: { intent: tpl.intent, temperature: t } });
  }
}
let bad = 0;
for (const r of rows) {
  const c = classify(r.text);
  if (c.intent !== r.expect.intent || (r.expect.temperature !== null && c.temperature !== r.expect.temperature)) { bad++; console.error('lexicon mismatch', r, c); }
}
fs.writeFileSync(path.join(out, 'assistant-intent.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// hvac setpoint golden set (deterministic cases)
const hv = [
  { id: 'hv-001', site: { peakNow: false }, room: { occupancy: 'occupied' }, requested: 22, expect: 22 },
  { id: 'hv-002', site: { peakNow: false }, room: { occupancy: 'vacant' }, requested: 20, expect: 20 },
  { id: 'hv-004', site: { peakNow: true }, room: { occupancy: 'vacant' }, requested: 26, expect: 26 },
  { id: 'hv-005', site: { peakNow: false }, room: { occupancy: 'occupied' }, requested: 12, expect: 18 },
  { id: 'hv-006', site: { peakNow: false }, room: { occupancy: 'occupied' }, requested: 31, expect: 28 },
  { id: 'hv-007', site: { peakNow: false }, room: { occupancy: 'occupied' }, requested: 22.3, expect: 22.5 },
  { id: 'hv-008', site: { peakNow: true }, room: { occupancy: 'occupied' }, requested: 26, expect: 26 },
];
fs.writeFileSync(path.join(out, 'hvac-setpoint.jsonl'), hv.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`assistant-intent: ${rows.length} cases (${rows.filter((r) => r.lang === 'th').length} Thai), lexicon mismatches: ${bad}`);
console.log(`hvac-setpoint: ${hv.length} cases`);
if (bad) process.exit(1);
