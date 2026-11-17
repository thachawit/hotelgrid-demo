// Captures dashboard screenshots through Chrome DevTools Protocol (no npm deps; Node 22 global WebSocket).
//   node scripts/screenshot.mjs <outDir> [tab ...]      tabs: overview factory fleet incidents cost diagrams about
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = path.resolve(process.argv[2] || 'screenshots');
const tabs = process.argv.slice(3).length ? process.argv.slice(3) : ['overview', 'factory', 'fleet', 'incidents', 'cost'];
const width = Number(process.env.W || 1440), height = Number(process.env.H || 900);
const theme = process.env.THEME || 'light';
fs.mkdirSync(out, { recursive: true });

const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(out, '.chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
await send('Page.navigate', { url: 'http://127.0.0.1:4000/' });
await sleep(3500);
for (const tab of tabs) {
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-tab="${tab}"]').click()` });
  await sleep(tab === 'diagrams' ? 4000 : 2000);
  if (tab === 'factory') {
    const pickWi = process.env.WI ? `[data-wi="${process.env.WI}"]` : '[data-wi]';
    await send('Runtime.evaluate', { expression: `document.querySelector('#tab-factory ${pickWi}')?.click()` });
    await sleep(2000);
  }
  const { result } = await send('Runtime.evaluate', { expression: 'JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})', returnByValue: true });
  const dims = JSON.parse(result.result.value);
  const full = process.env.FULL !== '0';
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: { x: 0, y: 0, width, height: full ? Math.min(dims.h, 4000) : height, scale: 1 } });
  const file = path.join(out, `${tab}-${theme}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log(`${file}  page ${dims.w}x${dims.h}${dims.w > width ? '  (HORIZONTAL OVERFLOW)' : ''}`);
}
ws.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });
