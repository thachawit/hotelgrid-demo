// feedback-intake 1.4.0 — LINE / Slack / in-app complaints -> normalized signals for the factory.
export const meta = {
  service: 'feedback-intake',
  version: '1.4.0',
  released: '2026-07-14',
  changes: ['PII redaction before signals leave the service', 'Prompt-injection flag on inbound text'],
  breaking: [],
};

const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)/i,
  /system prompt/i,
  /you are now/i,
  /(grant|give) (me )?(admin|root|access)/i,
  /ให้สิทธิ์\s*(admin|แอดมิน)/,
  /ลืมคำสั่ง/,
];

export function redact(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(\+?66|0)[\d\s-]{8,11}\d/g, '[phone]');
}

export function normalize({ source, text, siteId, author, roomId, reporterRole = 'guest' }) {
  const clean = redact(text);
  const room = roomId || (clean.match(/(?:room|ห้อง)\s*(\d{3,4})/i) || [])[1] || null;
  return {
    source,
    siteId,
    roomId: room,
    text: clean,
    lang: /[฀-๿]/.test(clean) ? 'th' : 'en',
    reporterRole,
    author: author ? `hash:${[...author].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}` : null,
    flags: {
      piiRedacted: clean !== String(text),
      promptInjection: INJECTION.some((re) => re.test(text)),
    },
    receivedAt: new Date().toISOString(),
  };
}

async function forward(ctx, signal) {
  ctx.attrs({ source: signal.source, roomId: signal.roomId, injection: signal.flags.promptInjection });
  const r = await ctx.call('control-plane', 'POST', '/api/signals', signal);
  return { status: r.status === 200 ? 200 : 502, body: r.body };
}

export const routes = {
  // LINE Messaging API style webhook
  'POST /webhooks/line': async (ctx, req) => {
    const events = (req.body.events || []).filter((e) => e.type === 'message' && e.message?.type === 'text');
    const out = [];
    for (const e of events) {
      out.push((await forward(ctx, normalize({ source: 'line', text: e.message.text, siteId: ctx.site.id, author: e.source?.userId, roomId: e.roomHint }))).body);
    }
    return { status: 200, body: { accepted: out.length, signals: out } };
  },

  // Slack Events API style webhook (staff channel)
  'POST /webhooks/slack': async (ctx, req) => {
    const ev = req.body.event || {};
    if (ev.type !== 'message' || !ev.text) return { status: 200, body: { accepted: 0 } };
    return forward(ctx, normalize({ source: 'slack', text: ev.text, siteId: ctx.site.id, author: ev.user, reporterRole: 'staff' }));
  },

  // complaints escalated by guest-assistant
  'POST /internal/complaint': async (ctx, req) => forward(ctx, normalize({
    source: req.body.channel || 'assistant', text: req.body.text, siteId: ctx.site.id, author: req.body.guestId, roomId: req.body.roomId,
  })),

  'GET /status': async () => ({ status: 200, body: { service: meta.service, version: meta.version } }),
};
