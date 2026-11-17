// Shared helpers: HTTP router, JSON fetch, ids, hashing, seeded RNG, token estimates, text similarity.
import http from 'node:http';
import crypto from 'node:crypto';

// ---------- HTTP ----------
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };
  const match = (method, path) => {
    for (const r of routes) {
      if (r.method !== method && r.method !== '*') continue;
      const m = r.re.exec(path);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  };
  return { add, match, get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), put: (p, h) => add('PUT', p, h) };
}

export const reply = (status, body) => ({ __status: status, body });

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

export function serve(port, router, { name = 'svc', onRequest } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = router.match(req.method, url.pathname);
    if (!m) return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      if (onRequest) onRequest(req);
      const out = await m.handler({ req, res, params: m.params, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      if (out === undefined || res.writableEnded) return;
      if (out && out.__status) return send(res, out.__status, out.body);
      send(res, 200, out);
    } catch (e) {
      if (!res.writableEnded) send(res, 500, { error: e.message });
    }
  });
  server.keepAliveTimeout = 5000;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
    return { status: r.status, body: json };
  } catch (e) {
    return { status: 599, body: { error: `upstream unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}` } };
  } finally { clearTimeout(t); }
}

// ---------- ids / hashing / rng ----------
export const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
export const traceId = () => hex(16);
export const spanId = () => hex(8);
export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function hash01(s) { // deterministic uniform [0,1)
  const h = crypto.createHash('sha1').update(String(s)).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- text ----------
export const isThai = (s) => /[฀-๿]/.test(s || '');
export function estimateTokens(s) {
  if (!s) return 0;
  const str = String(s);
  const thai = (str.match(/[฀-๿]/g) || []).length;
  return Math.max(1, Math.ceil(thai / 2.2 + (str.length - thai) / 4));
}
function trigrams(s) {
  const t = ` ${String(s).toLowerCase().replace(/\s+/g, ' ')} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

export const now = () => Date.now();
export const fmtUsd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
