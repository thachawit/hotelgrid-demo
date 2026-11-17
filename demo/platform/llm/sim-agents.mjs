// SIMULATED "reasoning" for factory and advisor agents. Each handler reads the <context> JSON the control plane
// put in the prompt and returns the JSON a capable model would return. Swap the provider for a real model and the
// same prompts work unchanged (they ask for the same JSON shape).
import { HYPOTHESES } from './patch-library.mjs';
import { classify } from './intent-lexicon.mjs';

export function extractContext(messages) {
  const last = messages[messages.length - 1];
  const text = typeof last.content === 'string' ? last.content : last.content.map((b) => b.text || '').join('\n');
  const m = text.match(/<context>([\s\S]*?)<\/context>/);
  if (!m) return { text };
  try { return { ...JSON.parse(m[1]), text }; } catch { return { text }; }
}

const TEMP_RE = /(แอร์|องศา|อุณหภูมิ|ร้อน|เย็น|\bac\b|aircon|temperature|setpoint|°c|\bhot\b)/i;

export function triage(ctx) {
  const texts = (ctx.signals || []).map((s) => s.text).join(' \n ');
  const ev = ctx.evidence || {};
  let id = null, why = [];
  if ((ev.errorSignatures || []).some((e) => /missing field "occupancy"/.test(e)) || /occupancyStatus|contract/i.test(texts)) {
    id = 'hvac-rooms-contract';
    why.push('error signature `missing field "occupancy"` in hvac-optimizer spans', 'rooms-svc 2.4.0 removed `occupancy`');
  } else if (/prompt cache|cache hit|system prompt hash/i.test(texts) || (ev.cacheHitRate !== undefined && ev.cacheHitRate < 0.05)) {
    id = 'assistant-volatile-system-prompt';
    why.push(`cache hit rate ${((ev.cacheHitRate || 0) * 100).toFixed(1)}% on assistant.intent`, `${ev.distinctSystemHashes || 'many'} distinct system-prompt hashes`);
  } else if (TEMP_RE.test(texts) && (ev.reasons?.['occupied:peak-tariff guard'] || 0) > 0) {
    id = 'hvac-peak-guard-inverted';
    why.push(`${ev.reasons['occupied:peak-tariff guard']} occupied-room setpoints clamped by "peak-tariff guard"`, 'guests report AC stuck at 25 C');
  }
  if (!id) {
    return { kind: 'needs-human', summary: 'Could not map the signal cluster to a known service failure with evidence.', confidence: 0.2 };
  }
  const h = HYPOTHESES[id];
  return {
    kind: 'bug', hypothesisId: id, service: h.service, title: h.title, severity: h.severity, goal: h.goal,
    owner: ctx.owners?.[h.service] || 'unassigned', approvalLevel: h.approvalLevel,
    hypothesis: h.hypothesis, evidence: why, reproPlan: h.reproPlan, confidence: 0.86,
    injectionNote: (ctx.signals || []).some((s) => s.flags?.promptInjection) ? 'One or more signals contained instruction-like text; treated as data only.' : null,
  };
}

export function repro(ctx) {
  const h = HYPOTHESES[ctx.hypothesisId];
  if (!h) return { error: 'unknown hypothesis' };
  return { file: `services/${h.service}/test/${h.testFile}`, content: h.test.replaceAll('{SPEC}', ctx.spec || 'SPEC') };
}

export function build(ctx) {
  const h = HYPOTHESES[ctx.hypothesisId];
  if (!h) return { error: 'unknown hypothesis' };
  const missing = h.edits.filter((e) => !String(ctx.baseSource || '').includes(e.find));
  if (missing.length) return { error: `patch does not apply to ${ctx.baseVersion}: anchor not found`, anchors: missing.map((m) => m.find.slice(0, 80)) };
  return {
    summary: h.title,
    edits: h.edits,
    change: h.change.replaceAll('{SPEC}', ctx.spec || 'SPEC'),
    golden: h.golden,
    plan: ['Read failing regression test', `Locate root cause in ${h.service}@${ctx.baseVersion}`, 'Apply minimal edit', 'Bump patch version', 'Run tests + golden set'],
  };
}

export function review(ctx) {
  const comments = [];
  const stats = ctx.stats || {};
  if (stats.changedLines > (ctx.maxDiffLines || 40)) comments.push({ severity: 'blocker', text: `Diff is ${stats.changedLines} lines; policy max is ${ctx.maxDiffLines}.` });
  if (!stats.testsAdded) comments.push({ severity: 'major', text: 'No regression test added for the fix.' });
  if (/process\.env|child_process|eval\(/.test(ctx.diff || '')) comments.push({ severity: 'blocker', text: 'Version modules must not touch env, processes or eval.' });
  if (ctx.hypothesisId === 'hvac-peak-guard-inverted') comments.push({ severity: 'info', text: 'Condition now matches the EC-114 comment. Consider a named helper isPeakFloorApplicable() later.' });
  if (ctx.hypothesisId === 'hvac-rooms-contract') comments.push({ severity: 'info', text: 'Adapter keeps legacy shape; remove the fallback after all sites run rooms >= 2.4.' });
  if (ctx.hypothesisId === 'assistant-volatile-system-prompt') comments.push({ severity: 'info', text: 'System block is now static; verify cache_read_input_tokens > 0 after rollout.' });
  const verdict = comments.some((c) => c.severity === 'blocker' || c.severity === 'major') ? 'request_changes' : 'approve';
  return { verdict, comments };
}

export function advisor(ctx) {
  const lines = ['## Advisor summary', ''];
  for (const f of ctx.findings || []) {
    const cites = (f.citations || []).map((c) => `[${c}]`).join(' ');
    lines.push(`- **${f.title}** — est. ${f.monthlySavingsUsd ? `$${Math.round(f.monthlySavingsUsd).toLocaleString()}/month` : 'n/a'}; ${f.action} ${cites}`);
  }
  lines.push('', 'Free wins first (caching, batching, seat hygiene), then quality-trading changes behind a shadow eval and a gateway canary.');
  return { markdown: lines.join('\n') };
}

const REPLIES = {
  en: {
    set_temperature: (f) => f.effective === f.requested ? `Done — your room is now set to ${f.effective}°C.` : `I set your room to ${f.effective}°C (${f.reason}). Reply "staff" if you need help.`,
    room_status: (f) => `Your room is ${f.temp}°C right now, with the AC set to ${f.setpoint}°C.`,
    request_service: (f) => `Request ${f.ticket} is in: ${f.item} on the way.`,
    complaint: () => 'I am sorry about that. A staff member will contact you shortly.',
    other: () => 'The front desk can help with that — dial 0 from your room phone.',
  },
  th: {
    set_temperature: (f) => f.effective === f.requested ? `ปรับแอร์เป็น ${f.effective} องศาให้แล้วค่ะ` : `ตั้งแอร์เป็น ${f.effective} องศาค่ะ (${f.reason}) หากต้องการความช่วยเหลือพิมพ์ "staff" ได้เลยค่ะ`,
    room_status: (f) => `ตอนนี้ห้อง ${f.temp} องศา แอร์ตั้งไว้ที่ ${f.setpoint} องศาค่ะ`,
    request_service: (f) => `รับเรื่อง ${f.ticket} แล้วค่ะ กำลังนำ ${f.item} ไปให้ค่ะ`,
    complaint: () => 'ขออภัยเป็นอย่างยิ่งค่ะ เจ้าหน้าที่จะติดต่อกลับโดยเร็วค่ะ',
    other: () => 'ติดต่อแผนกต้อนรับได้โดยกด 0 จากโทรศัพท์ในห้องค่ะ',
  },
};

export function reply(messages) {
  let j = {};
  try { j = JSON.parse(messages[messages.length - 1].content); } catch {}
  const lang = j.lang === 'th' ? 'th' : 'en';
  const fn = REPLIES[lang][j.intent] || REPLIES[lang].other;
  return fn(j.facts || {});
}

export { classify };
