// Codex ingest: ~/.codex/sessions/**/rollout-*.jsonl (+ archived_sessions) normalized into the same Store as the Claude
// transcripts, every Codex message/session/tool tagged src:'codex' so the UI can tint it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const CODEX_DIR = path.join(os.homedir(), '.codex');
export const CODEX_ROOTS = [path.join(CODEX_DIR, 'sessions'), path.join(CODEX_DIR, 'archived_sessions')];
export const isCodexFile = (file) => file.startsWith(CODEX_DIR + path.sep);

export function listCodexFiles() {
  const out = [];
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: p, project: 'codex' });
    }
  };
  for (const r of CODEX_ROOTS) walk(r);
  return out;
}

const B_TS = Buffer.from('"timestamp":"');
const T_RECORD = Buffer.from('"type":"token_usage_record"');
const T_COUNT = Buffer.from('"type":"token_count"');
const T_TURN = Buffer.from('"type":"turn_context"');
const T_META = Buffer.from('"type":"session_meta"');
const T_START = Buffer.from('"type":"task_started"');
const T_CALL = [Buffer.from('"type":"function_call"'), Buffer.from('"type":"custom_tool_call"'), Buffer.from('"type":"web_search_call"')];
const T_OUT = [Buffer.from('"type":"function_call_output"'), Buffer.from('"type":"custom_tool_call_output"')];
const T_USER = Buffer.from('"type":"UserMessage"');
const RE_CALLID = /"call_id":"([^"]+)"/;
const RE_NAME = /"name":"([^"]+)"/;
const RE_TOOLS = /tools\.([A-Za-z0-9_]+)\(/;

function ts(line) {
  const i = line.indexOf(B_TS);
  return i < 0 ? 0 : Date.parse(line.toString('latin1', i + B_TS.length, i + B_TS.length + 24));
}
const has = (line, b) => line.includes(b);

/** Per-file running state, kept on store.files[file].cx between incremental reads. */
export function newCx() { return { sid: '', thread: '', model: '', effort: '', cwd: '', win: 0, side: false, start: 0, last: 0, pend: [], rl: '' }; }

export function handleCodexLine(store, line, ctx) {
  const cx = ctx.cx, t = ts(line);
  if (t) cx.last = t;
  if (has(line, T_RECORD)) {
    let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = o.payload || {}, u = p.usage; if (!u || !p.response_id) return;
    const id = 'cx:' + p.response_id;
    const sid = p.session_id || cx.sid || p.thread_id;
    const cached = u.cached_input_tokens || 0;
    const r = {
      id, sid, ts: t, startTs: cx.start && cx.start < t ? cx.start : t, model: cx.model || '', src: 'codex', th: cx.thread,
      in: Math.max(0, (u.input_tokens || 0) - cached), out: u.output_tokens || 0, cr: cached, cw: u.cache_write_input_tokens || 0, cw1: 0,
      think: u.reasoning_output_tokens || 0, win: cx.win, stop: '', side: cx.side, effort: cx.effort || '', fast: false, tier: '', ws: 0, wf: 0, tools: [],
    };
    store.msgs.set(id, r);
    for (const tid of cx.pend) { const tl = store.tools.get(tid); if (tl) { tl.msg = id; r.tools.push(tid); } }
    cx.pend = [];
    const s = store.session(sid, 'codex');
    s.src = 'codex'; s.entrypoint = s.entrypoint || 'Codex'; if (cx.cwd) s.cwd = cx.cwd;
    if (!s.firstTs || t < s.firstTs) s.firstTs = t; if (t > s.lastTs) s.lastTs = t;
    return;
  }
  if (has(line, T_COUNT)) {
    if (!line.includes('"rate_limits"')) return;
    let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const rl = o.payload && o.payload.rate_limits; if (!rl || !rl.primary) return;
    const a = rl.primary, b = rl.secondary || {};
    const x = { ts: t, p5: a.used_percent, r5: a.resets_at * 1000, p7: b.used_percent, r7: (b.resets_at || 0) * 1000, plan: rl.plan_type || '' };
    const last = store.cxPlan[store.cxPlan.length - 1];
    if (!last || last.p5 !== x.p5 || last.p7 !== x.p7 || last.r5 !== x.r5) store.cxPlan.push(x);
    return;
  }
  if (has(line, T_TURN)) {
    let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = o.payload || {};
    if (p.model) cx.model = p.model;
    cx.effort = p.effort || (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort) || '';
    if (p.cwd) cx.cwd = p.cwd;
    cx.start = t;
    return;
  }
  if (has(line, T_META)) {
    let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = o.payload || {};
    cx.sid = p.session_id || p.id || cx.sid; cx.thread = p.id || cx.thread; cx.cwd = p.cwd || cx.cwd;
    cx.side = !!p.parent_thread_id || p.thread_source === 'guardian_review';
    const s = store.session(cx.sid, 'codex');
    s.src = 'codex'; s.entrypoint = 'Codex'; if (p.cli_version) s.version = p.cli_version; if (p.cwd && !cx.side) s.cwd = p.cwd;
    return;
  }
  if (has(line, T_START)) { cx.start = t; const w = /"model_context_window":(\d+)/.exec(line.toString('latin1', 0, Math.min(line.length, 800))); if (w) cx.win = Number(w[1]); return; }
  for (const b of T_CALL) if (has(line, b)) {
    const head = line.toString('utf8', 0, Math.min(line.length, 2500));
    const cid = (RE_CALLID.exec(head) || [])[1] || (RE_NAME.exec(head) || [])[1] + t;
    let name = (RE_NAME.exec(head) || [])[1] || (b === T_CALL[2] ? 'web_search' : 'tool');
    if (name === 'exec') name = (RE_TOOLS.exec(head) || [])[1] || name;
    const id = 'cx:' + cid;
    if (!store.tools.has(id)) store.tools.set(id, { id, name, sid: cx.sid, msg: '', ts: t, endTs: 0, err: false, side: cx.side, src: 'codex' });
    cx.pend.push(id);
    return;
  }
  for (const b of T_OUT) if (has(line, b)) {
    const head = line.toString('latin1', 0, Math.min(line.length, 1200));
    const cid = (RE_CALLID.exec(head) || [])[1];
    const tl = cid && store.tools.get('cx:' + cid);
    if (tl) tl.endTs = t;
    cx.start = t;
    return;
  }
  if (has(line, T_USER)) {
    // first text of the user's message becomes a prompt (skip file-mention preambles)
    const head = line.toString('utf8', 0, Math.min(line.length, 6000));
    const m = /"text":"((?:[^"\\]|\\.){1,400})/.exec(head);
    if (m && !cx.side) {
      let text = m[1]; try { text = JSON.parse('"' + text.replace(/\\$/, '') + '"'); } catch { /* keep raw */ }
      const k = text.indexOf('## My request:'); if (k >= 0) text = text.slice(k + 14);
      text = text.replace(/^\s*#[^\n]*Files mentioned[^\n]*\n(?:\s*\n|##[^\n]*\n)*/, '').trim();
      if (text && !text.startsWith('<')) store.prompts.push({ ts: t, sid: cx.sid, pid: '', text: text.slice(0, 160) });
    }
    cx.start = t;
  }
}

/** Thread titles from session_index.jsonl (small file, re-read cheaply). */
export function applyCodexTitles(store) {
  let raw; try { raw = fs.readFileSync(path.join(CODEX_DIR, 'session_index.jsonl'), 'utf8'); } catch { return; }
  for (const l of raw.split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); const s = store.sessions.get(o.id); if (s && s.src === 'codex' && o.thread_name) s.title = o.thread_name; } catch { /* skip */ }
  }
}

// Per-item timing: Codex writes ms-resolution "Output item" lines (item added / item done) to logs_2.sqlite. The first item added
// after a request is the first token, the reasoning item's done line ends the thinking, so Codex gets TTFT / decode speed like Claude.
const LOGS_DB = path.join(CODEX_DIR, 'logs_2.sqlite');
const tm = { lastId: 0, items: new Map(), at: 0, db: null, max: 0, tried: false };
function openLogs() {
  if (tm.db || tm.tried) return tm.db;
  tm.tried = true;
  try { const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); tm.db = new DatabaseSync(LOGS_DB, { readOnly: true }); } catch { tm.db = null; }
  return tm.db;
}
export function applyCodexTiming(store, force) {
  const now = Date.now();
  if (!force && now - tm.at < 5000) return;
  tm.at = now;
  const db = openLogs(); if (!db) return;
  try {
    const rows = db.prepare("select id, ts, ts_nanos, thread_id, instr(feedback_log_body,'handle_output_item_done')>0 as done, substr(feedback_log_body, instr(feedback_log_body,'Output item'), 40) b from logs where id > ? and target = 'codex_core::stream_events_utils' and instr(feedback_log_body,'Output item') > 0 order by id").all(tm.lastId);
    for (const r of rows) {
      tm.lastId = r.id; const type = (/item_type="(\w+)"/.exec(r.b) || [])[1] || '';
      const t = r.ts * 1000 + Math.floor(r.ts_nanos / 1e6); if (t > tm.max) tm.max = t;
      let a = tm.items.get(r.thread_id); if (!a) tm.items.set(r.thread_id, a = []);
      a.push({ t, done: !!r.done, type });
    }
  } catch { tm.db = null; tm.tried = false; return; }
  let n = 0;
  for (const m of store.msgs.values()) {
    if (m.src !== 'codex' || m.firstTs || m.tn) continue;
    const a = tm.items.get(m.th || m.sid);
    const f = a && a.find((x) => !x.done && x.t > m.startTs && x.t <= m.ts + 50);
    if (f) {
      m.firstTs = f.t;
      const d = f.type === 'reasoning' && a.find((x) => x.done && x.type === 'reasoning' && x.t >= f.t && x.t <= m.ts + 50);
      if (d) { m.thinkEnd = d.t; m.thinkMs = d.t - f.t; }
      n++;
    } else if (m.ts < tm.max - 60000 || m.ts < now - 3600000) m.tn = 1;
  }
  if (n) store.version++;
}
