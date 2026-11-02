// CLI check: ingest all transcripts, print totals, and verify against a slow full-parse reference.
import fs from 'node:fs';
import { Store, ingestAll, ingestFile, listTranscripts } from './ingest.mjs';

const n = (x) => x.toLocaleString('en-US');
const store = new Store();
let t0 = Date.now();
ingestAll(store);
console.log(`ingested ${listTranscripts().length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const tot = { in: 0, out: 0, cr: 0, cw: 0, think: 0 };
const byModel = {};
for (const m of store.msgs.values()) {
  for (const k of Object.keys(tot)) tot[k] += m[k];
  const b = (byModel[m.model || '?'] ||= { msgs: 0, in: 0, out: 0, cr: 0, cw: 0 });
  b.msgs++; b.in += m.in; b.out += m.out; b.cr += m.cr; b.cw += m.cw;
}
console.log(`messages ${n(store.msgs.size)}  sessions ${store.sessions.size}  tools ${n(store.tools.size)}  prompts ${n(store.prompts.size ?? store.prompts.length)}  events ${store.events.length}`);
console.log('totals', Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, n(v)])));
console.table(byModel);
const withEnd = [...store.tools.values()].filter((t) => t.endTs).length;
console.log(`tools with duration ${n(withEnd)} / ${n(store.tools.size)}`);

// Reference: parse every line of the given files with JSON.parse, dedupe by message.id (max output_tokens).
const files = process.argv.slice(2);
for (const file of files) {
  const ref = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const u = o.message.usage, id = o.message.id || o.requestId || o.uuid;
    const prev = ref.get(id);
    if (!prev || (u.output_tokens || 0) >= prev.out)
      ref.set(id, { out: u.output_tokens || 0, in: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 });
  }
  const r = { msgs: ref.size, in: 0, out: 0, cr: 0, cw: 0 };
  for (const v of ref.values()) { r.in += v.in; r.out += v.out; r.cr += v.cr; r.cw += v.cw; }
  const sid = [...store.sessions.keys()].find((k) => file.includes(k));
  const g = { msgs: 0, in: 0, out: 0, cr: 0, cw: 0 };
  for (const m of store.msgs.values()) if (m.sid === sid) { g.msgs++; g.in += m.in; g.out += m.out; g.cr += m.cr; g.cw += m.cw; }
  const ok = JSON.stringify(r) === JSON.stringify(g);
  console.log(ok ? 'MATCH' : 'MISMATCH', file.split(/[\\/]/).pop(), '\n  reference', r, '\n  ingest   ', g);
}

// Incremental re-run must add nothing.
t0 = Date.now();
let added = 0;
for (const { file, project } of listTranscripts()) added += ingestFile(store, file, project);
console.log(`re-ingest: ${added} new lines in ${Date.now() - t0}ms`);
