// OPTIONAL real-model adapter. Not used by default and never run while building this demo (no credentials).
// Enable with: npm i @anthropic-ai/sdk && LLM_PROVIDER=anthropic node scripts/start.mjs
// The SDK reads its credential from the environment itself; this file never reads or logs it.
//
// Scope: only guest-assistant tasks (intent, reply) go to Claude. Factory and advisor agents stay on the simulator,
// because the demo's build step applies patches from a library; a real coding agent (Claude Code headless) would
// replace that step entirely — see README "Going real".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
const MODEL_IDS = { large: 'claude-opus-5-5', medium: 'claude-sonnet-5-5', small: 'claude-haiku-5-5' };
const REAL_TASKS = new Set(['intent', 'reply']);

let client;
async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

async function simFallback(payload, headers = {}) {
  // pass the gateway's provider key (and service tier) through: the simulated provider bills per key and rejects calls without one
  const r = await fetch(`http://127.0.0.1:${topo.ports['sim-llm']}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json() };
}

export async function callAnthropic(payload, headers = {}) {
  const task = payload.metadata?.task;
  if (!REAL_TASKS.has(task)) return simFallback(payload, headers);
  const c = await getClient();
  const model = MODEL_IDS[payload.model] || MODEL_IDS.large;
  const request = {
    model,
    max_tokens: Math.max(payload.max_tokens || 256, 1024),
    system: payload.system,
    messages: payload.messages,
    output_config: { effort: payload.output_config?.effort || 'medium' },
  };
  try {
    // Server-side refusal fallback for Opus/Sonnet tiers (beta); Haiku has no server-side fallback.
    const msg = model === MODEL_IDS.small
      ? await c.messages.create(request)
      : await c.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    if (msg.stop_reason === 'refusal') {
      return { status: 200, body: { ...msg, content: [{ type: 'text', text: task === 'intent' ? '{"intent":"other","temperature":null,"item":null}' : 'Sorry, I cannot help with that. A staff member will follow up.' }] } };
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { status: 200, body: { ...msg, content: [{ type: 'text', text }] } };
  } catch (e) {
    return { status: e.status || 502, body: { type: 'error', error: { message: e.message } } };
  }
}
