// Transcript ingest: tails ~/.claude/projects/**/*.jsonl, normalizes assistant messages,
// tool spans and user prompts. Pure Node, no deps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { samplesFromLine } from './planvalue.mjs';
import { isCodexFile, listCodexFiles, handleCodexLine, newCx, applyCodexTitles, applyCodexTiming } from './codex.mjs';
export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CHUNK = 16 * 1024 * 1024;

const B_ASSISTANT = Buffer.from('"type":"assistant"');
const B_USER = Buffer.from('"type":"user"');
const B_TOOLRES = Buffer.from('"type":"tool_result"');
const B_ISERR = Buffer.from('"is_error":true');
const B_SYSTEM = Buffer.from('"type":"system"');
const B_TS = Buffer.from('"timestamp":"');
const B_SIDK = Buffer.from('"sessionId":"');
// Value of a top-level string field found by raw key bytes (native scan; escaped copies inside strings don't match).
function field(line, key, len) {
  const i = line.indexOf(key);
  return i < 0 ? '' : line.toString('latin1', i + key.length, i + key.length + len);
}
const RE_TUID = /"tool_use_id":"([^"]+)"/;
const RE_SID = /"sessionId":"([^"]+)"/;
const RE_PROMPT = /"promptId":"([^"]+)"/;
const RE_TEXT = /"content":"((?:[^"\\]|\\.){0,240})/;
const RE_SUBTYPE = /"subtype":"([^"]+)"/;
const RE_LEVEL = /"level":"([^"]+)"/;
const RE_CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;

export class Store {
  constructor() {
    this.msgs = new Map();      // message.id -> Msg
    this.tools = new Map();     // tool_use id -> Tool
    this.prompts = [];          // {ts, sid, pid, text}
    this.events = [];           // {ts, sid, level, kind}
    this.sessions = new Map();  // sid -> Session
    this.files = {};            // file -> {size, offset, sid, project}
    this.plan = [];             // plan % readings {ts,p5,r5,p7,r7}
    this.cxPlan = [];           // Codex plan % readings {ts,p5,r5,p7,r7,plan}
    this.version = 0;           // bumps on any change
  }
  session(sid, project) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = { id: sid, project, cwd: '', title: '', branch: '', entrypoint: '', version: '', firstTs: 0, lastTs: 0 };
      this.sessions.set(sid, s);
    }
    return s;
  }
  toJSON() {
    return { msgs: [...this.msgs.values()], tools: [...this.tools.values()], prompts: this.prompts, events: this.events, sessions: [...this.sessions.values()], files: this.files, plan: this.plan, cxPlan: this.cxPlan, v: 5 };
  }
  static fromJSON(o) {
    const s = new Store();
    for (const m of o.msgs) s.msgs.set(m.id, m);
    for (const t of o.tools) s.tools.set(t.id, t);
    s.prompts = o.prompts; s.events = o.events; s.files = o.files; s.plan = o.plan || []; s.cxPlan = o.cxPlan || [];
    for (const x of o.sessions) s.sessions.set(x.id, x);
    return s;
  }
}

export function listTranscripts(root = PROJECTS_DIR) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(pdir, e.name), project: proj.name });
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push({ file: path.join(sub, f), project: proj.name });
      }
    }
  }
  return out.concat(listCodexFiles());
}

// Process one JSONL line (a Buffer). ctx holds per-file running state.
function handleLine(store, line, ctx) {
  const n = line.length;
  if (n > 200 && line.includes('percentUsed') && line.includes('5-hour limit')) samplesFromLine(store, line.toString('utf8'), Date.parse(field(line, B_TS, 24)));
  const ts = Date.parse(field(line, B_TS, 24));
  const tail = line.toString('latin1', Math.max(0, n - 700));
  if (line.includes(B_ASSISTANT)) {
    if (!line.includes('"usage"')) { if (ts) ctx.lastTs = ts; return; }
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const m = o.message; if (!m || !m.usage) return;
    const id = m.id || o.requestId || o.uuid;
    const u = m.usage, cc = u.cache_creation || {};
    const t = Date.parse(o.timestamp) || ts;
    let r = store.msgs.get(id);
    const fresh = !r;
    if (fresh) {
      r = { id, sid: o.sessionId, ts: t, startTs: ctx.msgId === id ? ctx.msgStart : ctx.lastTs || t, model: m.model || '', in: 0, out: 0, cr: 0, cw: 0, cw1: 0, think: 0, stop: '', side: !!o.isSidechain, effort: o.effort || '', fast: u.speed === 'fast', tier: u.service_tier || '', ws: 0, wf: 0, tools: [] };
      store.msgs.set(id, r);
    }
    if ((u.output_tokens || 0) >= r.out) {
      r.in = u.input_tokens || 0; r.out = u.output_tokens || 0;
      r.cr = u.cache_read_input_tokens || 0; r.cw = u.cache_creation_input_tokens || 0;
      r.cw1 = cc.ephemeral_1h_input_tokens || 0;
      r.think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
      r.ws = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
      r.wf = (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0;
    }
    if (o.thinkingDurationMs > 0 && t) { const f0 = t - o.thinkingDurationMs; r.firstTs = r.firstTs ? Math.min(r.firstTs, f0) : f0; r.thinkEnd = Math.max(r.thinkEnd || 0, t); r.thinkMs = (r.thinkMs || 0) + o.thinkingDurationMs; }
    if (m.stop_reason) r.stop = m.stop_reason;
    if (t > r.ts) r.ts = t;
    if (ctx.msgId !== id) { ctx.msgId = id; ctx.msgStart = ctx.lastTs || t; }
    r.startTs = Math.min(r.startTs, ctx.msgStart || r.startTs);
    if (Array.isArray(m.content)) for (const c of m.content) {
      if (c && c.type === 'tool_use' && !store.tools.has(c.id)) {
        const tl = { id: c.id, name: c.name, sid: o.sessionId, msg: id, ts: t, endTs: 0, err: false, side: !!o.isSidechain };
        store.tools.set(c.id, tl); r.tools.push(c.id);
      }
    }
    const s = store.session(o.sessionId, ctx.project);
    if (o.cwd) s.cwd = o.cwd; if (o.gitBranch) s.branch = o.gitBranch; if (o.entrypoint) s.entrypoint = o.entrypoint; if (o.version) s.version = o.version;
    if (!s.firstTs || t < s.firstTs) s.firstTs = t; if (t > s.lastTs) s.lastTs = t;
    if (t) ctx.lastTs = t;
    return;
  }
  if (line.includes(B_USER)) {
    if (line.includes(B_TOOLRES)) {
      const head = line.toString('latin1', 0, Math.min(n, 700));
      const idm = RE_TUID.exec(head);
      const tl = idm && store.tools.get(idm[1]);
      if (tl && ts) { tl.endTs = ts; tl.err = line.includes(B_ISERR); }
      if (ts) ctx.lastTs = ts;
      return;
    }
    if (n < 400000 || true) {
      const head = line.toString('utf8', 0, Math.min(n, 3000));
      if (head.includes('"isMeta":true')) { if (ts) ctx.lastTs = ts; return; }
      const tx = RE_TEXT.exec(head);
      if (tx && ts) {
        const sid = field(line, B_SIDK, 36);
        const pid = (RE_PROMPT.exec(head) || [])[1] || '';
        let text = tx[1]; try { text = JSON.parse('"' + text.replace(/\\$/, '') + '"'); } catch { /* keep raw */ }
        if (!text.startsWith('<')) {
          store.prompts.push({ ts, sid, pid, text: text.slice(0, 160) });
          const s = store.sessions.get(sid); if (s && !s.firstTs) s.firstTs = ts;
        }
      }
    }
    if (ts) ctx.lastTs = ts;
    return;
  }
  if (line.includes(B_SYSTEM)) {
    const head = line.toString('utf8', 0, Math.min(n, 1500));
    const st = RE_SUBTYPE.exec(head), lv = RE_LEVEL.exec(head);
    if (st && ts && /error|rate|limit|compact|retry/i.test(st[1])) {
      const ev = { ts, sid: field(line, B_SIDK, 36), level: lv ? lv[1] : 'info', kind: st[1] };
      if (st[1] === 'compact_boundary') { // what the compaction measured about itself: context before, the summary it left, seconds it took
        const g = (k) => { const r = new RegExp('"' + k + '":([0-9]+)').exec(head); return r ? Number(r[1]) : undefined; };
        ev.pre = g('preTokens'); ev.post = g('postTokens'); ev.ms = g('durationMs');
      }
      store.events.push(ev);
    }
    if (ts) ctx.lastTs = ts;
    return;
  }
  if (line.includes('"type":"custom-title"')) {
    const m = /"customTitle":"((?:[^"\\]|\\.)*)"/.exec(line.toString('utf8', 0, Math.min(n, 2000)));
    const sid = (RE_SID.exec(line.toString('latin1', 0, Math.min(n, 2000))) || [])[1];
    if (m && sid) { const s = store.sessions.get(sid) || store.session(sid, ctx.project); try { s.title = JSON.parse('"' + m[1] + '"'); } catch { s.title = m[1]; } }
    return;
  }
  if (ts) ctx.lastTs = ts;
}

// Read new complete lines of one file from its stored offset.
export function ingestFile(store, file, project) {
  const st = fs.statSync(file);
  let f = store.files[file];
  if (!f || st.size < f.offset) f = store.files[file] = { size: 0, offset: 0, project, lastTs: 0 };
  if (st.size === f.offset) return 0;
  const codex = isCodexFile(file);
  if (codex && !f.cx) f.cx = newCx();
  const ctx = { project, lastTs: f.lastTs || 0, msgId: '', msgStart: 0, cx: f.cx };
  const handle = codex ? handleCodexLine : handleLine;
  const fd = fs.openSync(file, 'r');
  let pos = f.offset, carry = Buffer.alloc(0), lines = 0;
  try {
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.allocUnsafe(len);
      const got = fs.readSync(fd, buf, 0, len, pos);
      if (!got) break;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      let start = 0, nl;
      while ((nl = data.indexOf(10, start)) !== -1) {
        if (nl > start) { handle(store, data.subarray(start, nl), ctx); lines++; }
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
      pos += got;
    }
  } finally { fs.closeSync(fd); }
  f.offset = st.size - carry.length; f.size = st.size; f.lastTs = ctx.lastTs;
  if (lines) { store.version++; if (codex) { applyCodexTitles(store); applyCodexTiming(store); } }
  return lines;
}

export function ingestAll(store, onProgress) {
  const list = listTranscripts();
  let done = 0, total = list.length;
  for (const { file, project } of list) {
    try { ingestFile(store, file, project); } catch (e) { store.events.push({ ts: Date.now(), sid: '', level: 'error', kind: 'ingest: ' + e.message }); }
    onProgress && onProgress(++done, total, file);
  }
  try { applyCodexTiming(store, true); } catch { /* optional */ }
  return list;
}

// A read-only view of the store limited to one source ('claude' | 'codex'); 'all' returns the store itself. Cached per store version.
const views = new Map();
export function srcStore(store, src) {
  if (src !== 'claude' && src !== 'codex') return store;
  const key = src + '|' + store.version;
  let v = views.get(src);
  if (v && v.key === key) return v.store;
  const keep = src === 'codex' ? (o) => o.src === 'codex' : (o) => o.src !== 'codex';
  const sids = new Set();
  const w = Object.create(store);
  w.msgs = new Map([...store.msgs].filter(([, m]) => keep(m)));
  w.tools = new Map([...store.tools].filter(([, t]) => keep(t)));
  w.sessions = new Map([...store.sessions].filter(([id, s]) => { const k = keep(s); if (k) sids.add(id); return k; }));
  w.prompts = store.prompts.filter((p) => sids.has(p.sid));
  w.events = store.events.filter((e) => !e.sid || sids.has(e.sid));
  w.plan = src === 'codex' ? [] : store.plan;
  views.set(src, { key, store: w });
  return w;
}
/** Latest Codex plan windows still in force (a window whose reset time has passed reads as null). */
export function codexPlanNow(store, now = Date.now()) {
  let a = null;
  for (const x of store.cxPlan || []) if (!a || x.ts > a.ts) a = x;
  if (!a) return null;
  const w = (pct, resetsAt) => (resetsAt > now ? { pct, resetsAt } : null);
  return { ts: a.ts, plan: a.plan, plan5h: w(a.p5, a.r5), plan7d: w(a.p7, a.r7) };
}

export const CACHE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'TokenHUD');
export function loadCache() {
  try { const o = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'cache.json'), 'utf8')); if (!o.plan || !(o.v >= 5)) return new Store(); /* older cache: read everything once (plan readings, first-token times, compaction sizes) */ return Store.fromJSON(o); } catch { return new Store(); }
}
export function saveCache(store) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = path.join(CACHE_DIR, 'cache.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, path.join(CACHE_DIR, 'cache.json'));
}
