// hvac-optimizer 1.9.0-rc1 — PRE-RELEASE (staging only). Accepts rooms-svc 2.4 contract.
export const meta = {
  service: 'hvac-optimizer',
  version: '1.9.0-rc1',
  released: '2026-11-10',
  prerelease: true,
  changes: [
    'Accept rooms-svc 2.4 `occupancyStatus.state` as well as legacy `occupancy`',
    'Peak-tariff guard applies to vacant rooms only',
  ],
  breaking: [],
};

export const MIN_SETPOINT = 18;
export const MAX_SETPOINT = 28;
export const PEAK_FLOOR_VACANT = 25;

export function parseRoom(room) {
  const occ = room?.occupancy ?? room?.occupancyStatus?.state;
  if (!room || typeof occ !== 'string') {
    throw new Error('invalid room payload from rooms-svc: missing field "occupancy"');
  }
  return { id: room.id, occupancy: occ.toLowerCase(), guestId: room.guestId };
}

export function computeSetpoint(room, requested, site) {
  const clamped = Math.min(MAX_SETPOINT, Math.max(MIN_SETPOINT, Math.round(requested * 2) / 2));
  let effective = clamped;
  let reason = clamped === requested ? 'as requested' : 'clamped to range';
  // Peak-tariff guard (energy contract EC-114): during peak hours,
  // unoccupied rooms must not be pre-cooled below PEAK_FLOOR_VACANT.
  if (site.peakNow && room.occupancy === 'vacant') {
    if (effective < PEAK_FLOOR_VACANT) reason = 'peak-tariff guard';
    effective = Math.max(effective, PEAK_FLOOR_VACANT);
  }
  return { effective, clamped, reason };
}

export const routes = {
  'POST /setpoint': async (ctx, req) => {
    const { roomId, requested } = req.body;
    if (!roomId || typeof requested !== 'number') {
      return { status: 400, body: { error: 'roomId and numeric requested are required' } };
    }
    ctx.attrs({ roomId, requested });
    const r = await ctx.call('rooms-svc', 'GET', `/rooms/${roomId}`);
    if (r.status !== 200) return { status: 502, body: { error: `rooms-svc returned ${r.status}` } };
    const room = parseRoom(r.body);
    const { effective, clamped, reason } = computeSetpoint(room, requested, ctx.site);
    const w = await ctx.call('rooms-svc', 'PUT', `/rooms/${roomId}/setpoint`, { value: effective, source: 'hvac-optimizer' });
    if (w.status !== 200) return { status: 502, body: { error: `rooms-svc setpoint write returned ${w.status}` } };
    ctx.attrs({
      effective, reason, occupancy: room.occupancy, guestId: room.guestId,
      mismatch: room.occupancy === 'occupied' && effective !== clamped,
    });
    return { status: 200, body: { roomId, requested, effective, reason } };
  },

  'GET /status': async () => ({ status: 200, body: { service: meta.service, version: meta.version } }),
};
