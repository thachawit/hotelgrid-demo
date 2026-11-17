import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const pricing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pricing.json'), 'utf8'));

// usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
export function priceCall(model, usage, batch = false) {
  const p = pricing.models[model];
  if (!p) return 0;
  const usd = ((usage.input_tokens || 0) * p.inputPerMTok + (usage.output_tokens || 0) * p.outputPerMTok +
    (usage.cache_read_input_tokens || 0) * p.cacheReadPerMTok + (usage.cache_creation_input_tokens || 0) * p.cacheWritePerMTok) / 1e6;
  return batch ? usd * pricing.batchDiscount : usd;
}
