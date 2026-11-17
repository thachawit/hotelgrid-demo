// Minimal BM25 retriever over markdown chunks (the advisor's RAG tool).
import fs from 'node:fs';
import path from 'node:path';

const tokenize = (s) => String(s).toLowerCase().normalize('NFKC').match(/[a-z0-9฀-๿.$%-]+/g) || [];

export function chunkMarkdown(text, source) {
  const chunks = [];
  let heading = '', buf = [];
  const flush = () => { const body = buf.join('\n').trim(); if (body) chunks.push({ source, heading, text: body }); buf = []; };
  for (const line of text.split('\n')) {
    if (/^#{1,3} /.test(line)) { flush(); heading = line.replace(/^#+ /, ''); }
    else buf.push(line);
  }
  flush();
  return chunks;
}

export function buildIndex(dir) {
  const docs = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(md|txt)$/.test(f)) docs.push(...chunkMarkdown(fs.readFileSync(p, 'utf8'), path.relative(dir, p)));
    }
  };
  walk(dir);
  const toks = docs.map((d) => tokenize(`${d.heading} ${d.text}`));
  const df = new Map();
  toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const avgdl = toks.reduce((a, t) => a + t.length, 0) / (toks.length || 1);
  return {
    size: docs.length,
    search(query, k = 4) {
      const q = tokenize(query);
      const N = docs.length, k1 = 1.4, b = 0.75;
      const scored = toks.map((t, i) => {
        const tf = new Map();
        t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
        let s = 0;
        for (const w of q) {
          const f = tf.get(w); if (!f) continue;
          const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avgdl)));
        }
        return { ...docs[i], score: s };
      });
      return scored.filter((d) => d.score > 0).sort((a, b2) => b2.score - a.score).slice(0, k);
    },
  };
}
