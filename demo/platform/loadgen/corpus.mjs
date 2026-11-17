// Labeled guest messages (EN + TH). The data lives in corpus.json so the Go loadgen (go/cmd/loadgen) and the
// golden-set builder (scripts/build-golden.mjs) sample exactly the same messages. {t} is replaced with a temperature.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const data = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus.json'), 'utf8'));

export const CHAT_TEMPLATES = data.chatTemplates;
export const TEMPS = data.temps;
export const LINE_COMPLAINTS = data.lineComplaints;
export const STAFF_SLACK = data.staffSlack;

export function render(tpl, t) {
  return tpl.text.replace('{t}', String(t));
}
