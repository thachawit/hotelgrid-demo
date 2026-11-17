// api-gateway 5.2.0 — edge API for the guest app and staff panel.
export const meta = {
  service: 'api-gateway',
  version: '5.2.0',
  released: '2026-08-30',
  changes: ['Per-site routing via x-site-id'],
  breaking: [],
};

function edge(r, upstream) {
  if (r.status >= 500) return { status: 502, body: { error: `${upstream} failed (${r.status})`, upstream: r.body } };
  return { status: r.status, body: r.body };
}

export const routes = {
  'GET /api/rooms/:id': async (ctx, req) => {
    ctx.attrs({ roomId: req.params.id, op: 'room_status' });
    return edge(await ctx.call('rooms-svc', 'GET', `/rooms/${req.params.id}`), 'rooms-svc');
  },

  'POST /api/rooms/:id/temperature': async (ctx, req) => {
    const value = Number(req.body.value);
    ctx.attrs({ roomId: req.params.id, op: 'set_temperature', guestId: req.body.guestId });
    if (!Number.isFinite(value)) return { status: 400, body: { error: 'numeric value required' } };
    return edge(await ctx.call('hvac-optimizer', 'POST', '/setpoint', { roomId: req.params.id, requested: value }), 'hvac-optimizer');
  },

  'POST /api/chat': async (ctx, req) => {
    ctx.attrs({ roomId: req.body.roomId, op: 'chat', guestId: req.body.guestId });
    return edge(await ctx.call('guest-assistant', 'POST', '/chat', req.body), 'guest-assistant');
  },

  'GET /status': async () => ({ status: 200, body: { service: meta.service, version: meta.version } }),
};
