// Event bus + Server-Sent Events fan-out + human-readable activity log.
const clients = new Set();
const log = [];
let seq = 0;

export function emit(type, data) {
  const ev = { id: ++seq, ts: Date.now(), type, data };
  if (type === 'log') { log.push(ev); if (log.length > 600) log.shift(); }
  const line = `id: ${ev.id}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
  return ev;
}

// source: factory | deploy | canary | rollback | intake | cost | scenario | system
export function say(source, msg, extra = {}) {
  const level = extra.level || 'info';
  if (process.env.CP_QUIET !== '1') console.log(`[${source}] ${msg}`);
  return emit('log', { source, msg, level, ...extra });
}

export function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`retry: 2000\n\n`);
  for (const ev of log.slice(-120)) res.write(`id: ${ev.id}\nevent: log\ndata: ${JSON.stringify(ev)}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export const recentLog = (n = 200) => log.slice(-n);
