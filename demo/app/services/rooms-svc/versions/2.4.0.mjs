// rooms-svc 2.4.0 — occupancy becomes a structured status object (PMS v5 alignment).
export const meta = {
  service: 'rooms-svc',
  version: '2.4.0',
  released: '2026-11-12',
  changes: ['Occupancy exposed as occupancyStatus { state, since } to match PMS v5', 'Room payload drops legacy `occupancy` string'],
  breaking: ['GET /rooms/:id no longer returns field `occupancy`; use `occupancyStatus.state` (OCCUPIED | VACANT)'],
  migrations: [],
};

function seeded(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

export function init(state, site) {
  if (state.rooms) return;
  const rnd = seeded(site.id);
  state.rooms = new Map();
  for (const floor of site.floors) {
    for (let i = 1; i <= site.roomsPerFloor; i++) {
      const id = `${floor}${String(i).padStart(2, '0')}`;
      const occupied = rnd() < 0.72;
      state.rooms.set(id, {
        id, floor, occupied,
        occupiedSince: Date.now() - Math.floor(rnd() * 3 * 86400000),
        guestId: occupied ? `g-${site.id.slice(0, 3)}-${id}-${Math.floor(rnd() * 900 + 100)}` : null,
        vip: rnd() < 0.08,
        temp: 24 + rnd() * 4,
        setpoint: 25,
        updatedAt: Date.now(),
      });
    }
  }
}

function settle(room) {
  const dt = (Date.now() - room.updatedAt) / 1000;
  room.temp += (room.setpoint - room.temp) * (1 - Math.exp(-dt / 40));
  room.updatedAt = Date.now();
}

function represent(room) {
  return {
    id: room.id,
    floor: room.floor,
    occupancyStatus: {
      state: room.occupied ? 'OCCUPIED' : 'VACANT',
      since: new Date(room.occupiedSince).toISOString(),
    },
    guestId: room.guestId,
    vip: room.vip,
    temp: Math.round(room.temp * 10) / 10,
    setpoint: room.setpoint,
  };
}

export const routes = {
  'GET /rooms': async (ctx) => ({
    status: 200,
    body: [...ctx.state.rooms.values()].map((r) => ({ id: r.id, floor: r.floor, occupied: r.occupied, guestId: r.guestId })),
  }),

  'GET /rooms/:id': async (ctx, req) => {
    const room = ctx.state.rooms.get(req.params.id);
    ctx.attrs({ roomId: req.params.id });
    if (!room) return { status: 404, body: { error: `room ${req.params.id} not found` } };
    settle(room);
    return { status: 200, body: represent(room) };
  },

  'PUT /rooms/:id/setpoint': async (ctx, req) => {
    const room = ctx.state.rooms.get(req.params.id);
    if (!room) return { status: 404, body: { error: 'room not found' } };
    const value = Number(req.body.value);
    if (!Number.isFinite(value)) return { status: 400, body: { error: 'numeric value required' } };
    settle(room);
    room.setpoint = value;
    ctx.attrs({ roomId: room.id, setpoint: value, source: req.body.source || 'unknown' });
    return { status: 200, body: { ok: true, roomId: room.id, setpoint: value } };
  },

  'POST /rooms/:id/occupancy': async (ctx, req) => {
    const room = ctx.state.rooms.get(req.params.id);
    if (!room) return { status: 404, body: { error: 'room not found' } };
    room.occupied = Boolean(req.body.occupied);
    room.occupiedSince = Date.now();
    room.guestId = room.occupied ? (req.body.guestId || `g-${room.id}-${Date.now() % 1000}`) : null;
    return { status: 200, body: represent(room) };
  },

  'GET /status': async () => ({ status: 200, body: { service: meta.service, version: meta.version } }),
};
