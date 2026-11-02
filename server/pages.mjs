// Per-page aggregations (M4 Sessions, M5 Cost/Context/Models/Tools, M6 Traces). Pure functions over the Store,
// plus an on-demand, cached read of one session's transcript for prompt/reply text and tool inputs.
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf, priceFor, rateFor, winOf } from './stats.mjs';
import { spd, addSpd, mergeSpd, tps, msgTps, msgSpeed, speedStats, withEffort } from './speed.mjs';
import { meterIndex } from './planvalue.mjs';
import { getSettings } from './settings.mjs';

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const base = (p) => (p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
export function shortModel(id) {
  const m = /claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}` : id || 'unknown';
}
export const stateOf = (age) => (age < 2 * MIN ? 'live' : age < 30 * MIN ? 'idle' : 'done');
export const used = (m) => m.in + m.cr + m.cw;
export const titleOf = (store, sid) => { const s = store.sessions.get(sid) || {}; return s.title || base(s.cwd) || sid.slice(0, 8); };
export const isAgent = (n) => n === 'Agent' || n === 'Task';
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

export function bySession(store) {
  const g = new Map();
  for (const m of store.msgs.values()) {
    if (m.model === '<synthetic>') continue;
    let a = g.get(m.sid); if (!a) g.set(m.sid, a = []);
    a.push(m);
  }
  for (const a of g.values()) a.sort((x, y) => x.ts - y.ts);
  return g;
}
function windowFor(mainMsgs) { const cw = mainMsgs.find((m) => m.win); if (cw) return cw.win; let peak = 0; for (const m of mainMsgs) peak = Math.max(peak, used(m)); return winOf(peak); }

/* ---------- transcript text (cached by file size) ---------- */
const tcache = new Map();
function fileOf(store, sid) { const fs_ = Object.keys(store.files); return fs_.find((f) => path.basename(f) === sid + '.jsonl') || fs_.find((f) => sid && path.basename(f).includes(sid)) || ''; }
function inputSummary(i) {
  if (!i || typeof i !== 'object') return '';
  const v = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
}
export function transcriptInfo(store, sid) {
  const file = fileOf(store, sid);
  if (!file) return { prompts: [], replies: new Map(), inputs: new Map() };
  const st = fs.statSync(file);
  const hit = tcache.get(sid);
  if (hit && hit.size === st.size) return hit.info;
  const CAP = 8 * 1024 * 1024;
  const start = Math.max(0, st.size - CAP);
  const fd = fs.openSync(file, 'r');
  let text;
  try { const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  const lines = text.split('\n'); if (start > 0) lines.shift();
  const info = { prompts: [], replies: new Map(), inputs: new Map() };
  for (const ln of lines) {
    if (ln.length < 20) continue;
    const isA = ln.includes('"type":"assistant"'), isU = !isA && ln.includes('"type":"user"');
    if (!isA && !isU) continue;
    if (isU && (ln.includes('"tool_result"') || ln.includes('"isMeta":true'))) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const c = o.message && o.message.content;
    if (isU) {
      let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
      t = t.trim(); if (!t || t.startsWith('<')) continue;
      info.prompts.push({ ts: Date.parse(o.timestamp), text: t.slice(0, 700) });
    } else if (Array.isArray(c) && !o.isSidechain) {
      const id = o.message.id; let txt = '';
      for (const b of c) {
        if (b.type === 'text' && b.text) txt += (txt ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') info.inputs.set(b.id, inputSummary(b.input));
      }
      if (txt) info.replies.set(id, txt.trim().slice(0, 500));
    }
  }
  tcache.set(sid, { size: st.size, info });
  if (tcache.size > 12) tcache.delete(tcache.keys().next().value);
  return info;
}

/* ---------- M4: sessions ---------- */
export function sessionsList(store, now = Date.now()) {
  const out = [];
  for (const [sid, arr] of bySession(store)) {
    const s = store.sessions.get(sid) || {};
    const main = arr.filter((m) => !m.side);
    const last = arr[arr.length - 1].ts, first = arr[0].startTs || arr[0].ts;
    let o = 0, cost = 0, tot = 0;
    const sp = spd();
    const models = new Set();
    for (const m of arr) { addSpd(sp, m); o += m.out; tot += m.in + m.out + m.cr + m.cw; cost += costOf(m); models.add(withEffort(shortModel(m.model), m)); }
    const win = windowFor(main), lm = main[main.length - 1];
    let tools = 0, err = 0;
    for (const t of store.tools.values()) if (t.sid === sid) { tools++; if (t.err) err++; }
    out.push({
      id: sid, src: s.src || 'claude', title: s.title || '', project: base(s.cwd) || s.project || '', branch: s.branch || '', app: s.entrypoint || '', version: s.version || '',
      first, last, durMs: last - first, req: arr.length, sub: arr.length - main.length, out: o, total: tot, cost, models: [...models], tools, err,
      prompts: store.prompts.filter((p) => p.sid === sid).length, tps: tps(sp), sx: speedStats(sp),
      ctxPct: lm ? Math.min(100, (used(lm) / win) * 100) : 0, state: stateOf(now - last),
    });
  }
  out.sort((a, b) => b.last - a.last);
  return { now, sessions: out };
}

function spanSummary(store, m) { return { id: m.id, ts: m.ts, startTs: m.startTs, model: withEffort(shortModel(m.model), m), in: m.in, out: m.out, cr: m.cr, cw: m.cw, think: m.think, stop: m.stop, side: m.side, cost: costOf(m), tools: m.tools.length, tps: msgTps(m) }; }

export function sessionDetail(store, sid, now = Date.now()) {
  const g = bySession(store).get(sid);
  const s = store.sessions.get(sid);
  if (!g || !s) return null;
  const main = g.filter((m) => !m.side);
  const last = g[g.length - 1].ts, first = g[0].startTs || g[0].ts;
  const win = windowFor(main);
  const info = transcriptInfo(store, sid);
  const tools = [...store.tools.values()].filter((t) => t.sid === sid).sort((a, b) => a.ts - b.ts);
  let cum = 0, cumCost = 0;
  const series = g.map((m) => { cum += m.out; cumCost += costOf(m); return { ts: m.ts, out: m.out, cum, cumCost, ctx: m.side ? 0 : used(m), side: m.side, tokens: m.in + m.cr + m.cw + m.out }; });
  const t = { req: g.length, in: 0, out: 0, cr: 0, cw: 0, cost: 0, think: 0, tps: 0 }, tsp = spd();
  for (const m of g) { addSpd(tsp, m); t.in += m.in; t.out += m.out; t.cr += m.cr; t.cw += m.cw; t.think += m.think; t.cost += costOf(m); }
  t.tps = tps(tsp); t.sx = speedStats(tsp);
  const effort = main.length ? main[main.length - 1].effort : '';
  const agents = tools.filter((x) => isAgent(x.name)).map((x) => {
    const subs = g.filter((m) => m.side && m.ts >= x.ts && m.ts <= (x.endTs || now));
    return { id: x.id, name: x.name, ts: x.ts, endTs: x.endTs, err: x.err, input: info.inputs.get(x.id) || '', msgs: subs.length, out: subs.reduce((a, m) => a + m.out, 0), cost: subs.reduce((a, m) => a + costOf(m), 0) };
  });
  // stream: prompts, replies and tool calls, newest last
  const stream = [];
  for (const p of info.prompts) stream.push({ ts: p.ts, kind: 'prompt', text: p.text });
  for (const m of main) { const r = info.replies.get(m.id); if (r) stream.push({ ts: m.ts, kind: 'reply', text: r, out: m.out, model: withEffort(shortModel(m.model), m) }); }
  for (const x of tools) if (!x.side) stream.push({ ts: x.ts, kind: 'tool', text: info.inputs.get(x.id) || '', name: x.name, dur: x.endTs ? x.endTs - x.ts : 0, running: !x.endTs && now - x.ts < 10 * MIN, err: x.err });
  stream.sort((a, b) => a.ts - b.ts);
  const turns = turnsOf(store, sid, g);
  const latest = turns.length ? buildTrace(store, sid, turns[turns.length - 1], g, now, info) : null;
  const lm = main[main.length - 1];
  return {
    now, id: sid, title: s.title || base(s.cwd), cwd: s.cwd, project: base(s.cwd), branch: s.branch, app: s.entrypoint, version: s.version, effort,
    first, last, state: stateOf(now - last), models: [...new Set(g.map((m) => withEffort(shortModel(m.model), m)))], totals: t,
    ctx: lm ? { used: used(lm), window: win, pct: Math.min(100, (used(lm) / win) * 100), in: lm.in, cr: lm.cr, cw: lm.cw } : null,
    series, tools: tools.slice(-60).map((x) => ({ id: x.id, name: x.name, ts: x.ts, endTs: x.endTs, err: x.err, side: x.side, input: info.inputs.get(x.id) || '' })),
    toolCount: tools.length, agents, stream: stream.slice(-90), turns: turns.length, trace: latest,
  };
}

/* ---------- M6: turns and traces ---------- */
function turnsOf(store, sid, g) {
  const ps = store.prompts.filter((p) => p.sid === sid).sort((a, b) => a.ts - b.ts);
  const turns = ps.map((p, i) => ({ idx: i, ts: p.ts, end: ps[i + 1] ? ps[i + 1].ts : Infinity, text: p.text }));
  return turns.filter((t) => g.some((m) => m.ts >= t.ts && m.ts < t.end));
}

function buildTrace(store, sid, turn, g, now, info) {
  const inTurn = g.filter((m) => m.ts >= turn.ts && m.ts < turn.end);
  const main = inTurn.filter((m) => !m.side), side = inTurn.filter((m) => m.side);
  const spans = [];
  const sp = (o) => { spans.push(o); return o; };
  let end = turn.ts;
  const mTools = (m) => m.tools.map((id) => store.tools.get(id)).filter(Boolean);
  for (const m of inTurn) { end = Math.max(end, m.ts); for (const t of mTools(m)) end = Math.max(end, t.endTs || t.ts); }
  const live = now - end < 90e3 && (mTools_any(store, inTurn) || (main.length && main[main.length - 1].stop !== 'end_turn'));
  if (live) end = Math.max(end, now);
  const root = sp({ id: 'turn', name: 'Turn', kind: 'turn', depth: 0, start: turn.ts, end, detail: turn.text });
  // agent tool spans collect subagent messages by time
  const agentSpans = [];
  const sideOf = new Map();
  const orphans = [];
  const mainTools = [];
  for (const m of main) for (const t of mTools(m)) mainTools.push(t);
  for (const m of side) {
    let best = null;
    for (const t of mainTools) if (isAgent(t.name) && m.ts >= t.ts && (!t.endTs || m.ts <= t.endTs + 2000) && (!best || t.ts > best.ts)) best = t;
    if (!best) for (const t of mainTools) if (isAgent(t.name) && m.ts >= t.ts && (!best || t.ts > best.ts)) best = t;
    if (best) { let a = sideOf.get(best.id); if (!a) sideOf.set(best.id, a = []); a.push(m); } else orphans.push(m);
  }
  const llm = (m, depth) => sp({
    id: m.id, name: `${m.side ? 'Subagent' : 'LLM'} · ${withEffort(shortModel(m.model), m)}`, kind: 'llm', depth, side: m.side,
    start: Math.max(turn.ts, m.startTs || m.ts), end: m.ts, in: m.in, out: m.out, cr: m.cr, cw: m.cw, think: m.think, stop: m.stop, cost: costOf(m), tps: msgTps(m), ttft: msgSpeed(m).ttft, dtps: +msgSpeed(m).dtps.toFixed(1),
    detail: info.replies.get(m.id) || '',
  });
  const tool = (t, depth, m) => sp({ id: t.id, name: t.name, kind: 'tool', depth, side: t.side, model: m ? withEffort(shortModel(m.model), m) : '', start: t.ts, end: t.endTs || (now - t.ts < 10 * MIN ? now : t.ts), running: !t.endTs && now - t.ts < 10 * MIN, err: t.err, detail: info.inputs.get(t.id) || '' });
  for (const m of main) {
    llm(m, 1);
    for (const t of mTools(m)) {
      const ts = tool(t, 2, m);
      if (isAgent(t.name)) {
        agentSpans.push(ts);
        for (const sm of sideOf.get(t.id) || []) {
          llm(sm, 3);
          for (const st of mTools(sm)) tool(st, 4, sm);
        }
      }
    }
  }
  if (orphans.length) {
    const o = sp({ id: 'orphans', name: 'Subagent work', kind: 'tool', depth: 1, side: true, start: orphans[0].startTs || orphans[0].ts, end: orphans[orphans.length - 1].ts, detail: 'Subagent requests with no matching Agent call in this turn (background or earlier agents).' });
    for (const sm of orphans) { llm(sm, 2); for (const st of mTools(sm)) tool(st, 3, sm); }
    void o;
  }
  const tot = { llm: main.length, sub: side.length, tools: spans.filter((x) => x.kind === 'tool' && x.id !== 'orphans').length, err: spans.filter((x) => x.err).length, in: 0, out: 0, cr: 0, cw: 0, cost: 0, tps: 0 }, tsp = spd();
  for (const m of inTurn) { addSpd(tsp, m); tot.in += m.in; tot.out += m.out; tot.cr += m.cr; tot.cw += m.cw; tot.cost += costOf(m); }
  tot.tps = tps(tsp); tot.sx = speedStats(tsp);
  return { sid, idx: turn.idx, ts: turn.ts, end, durMs: end - turn.ts, text: turn.text, title: titleOf(store, sid), live, spans, totals: tot, now };
}
function mTools_any(store, msgs) { for (const m of msgs) for (const id of m.tools) { const t = store.tools.get(id); if (t && !t.endTs) return true; } return false; }

const DAY_MS = 24 * 3600e3;
// Share of a turn's est. cost per bucket (sums to 1), same rates as costOf
const MIX_NAME = { cw: 'cache writes', cr: 'cache reads', inp: 'fresh input', out: 'output' };
export function costMix(msgs) {
  const x = { cw: 0, cr: 0, inp: 0, out: 0 };
  for (const m of msgs) {
    const p = rateFor(m); if (!p) continue;
    x.inp += m.in * p.in; x.out += m.out * p.out; x.cr += m.cr * p.cr; x.cw += Math.max(0, m.cw - m.cw1) * p.cw5m + m.cw1 * p.cw1h;
  }
  const tot = x.cw + x.cr + x.inp + x.out;
  return tot > 0 ? { cw: x.cw / tot, cr: x.cr / tot, inp: x.inp / tot, out: x.out / tot } : null;
}
// e.g. "62% cache writes cost"
const mixWhy = (mix) => { if (!mix) return ''; const [k, v] = Object.entries(mix).sort((a, b) => b[1] - a[1])[0]; return `${Math.round(v * 100)}% ${MIX_NAME[k]} cost`; };

export function traceList(store, now = Date.now(), limit = 60, sid = null) {
  const out = [];
  const meter = meterIndex(store, costOf, now);
  // Average est. cost per token for each model over every message in the store (all sessions and projects)
  const avgK = new Map();
  for (const m of store.msgs.values()) { const k = m.model || '?', a = avgK.get(k) || { c: 0, t: 0 }; a.c += costOf(m); a.t += m.in + m.cr + m.cw + m.out; avgK.set(k, a); }
  for (const [sid, g] of bySession(store)) {
    for (const turn of turnsOf(store, sid, g)) {
      const inT = g.filter((m) => m.ts >= turn.ts && m.ts < turn.end);
      let o = 0, cost = 0, tools = 0, err = 0, end = turn.ts, tin = 0, cr = 0, running = false;
      const sp = spd(), byModel = {}, byLabel = {};
      for (const m of inT) {
        const c = costOf(m); const lb = withEffort(shortModel(m.model), m); byLabel[lb] = (byLabel[lb] || 0) + c; addSpd(sp, m); o += m.out; cost += c; tin += m.in + m.cr + m.cw; cr += m.cr; end = Math.max(end, m.ts);
        byModel[m.model || '?'] = (byModel[m.model || '?'] || 0) + c;
        for (const id of m.tools) { const t = store.tools.get(id); if (!t) continue; tools++; if (t.err) err++; end = Math.max(end, t.endTs || t.ts); if (!t.endTs && now - t.ts < 10 * MIN) running = true; }
      }
      // Total = input + cache read + cache write + output; cost per 1K compared with the turn's dominant model (by cost)
      const dom = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0] || '?', avg = avgK.get(dom), tok = tin + o;
      const per1k = tok ? (cost / tok) * 1000 : null, avg1k = avg?.t ? (avg.c / avg.t) * 1000 : null;
      const s5 = meter.share('5h', turn.ts, cost), s7 = meter.share('7d', turn.ts, cost), mix = costMix(inT), llm = inT.filter((m) => !m.side).length;
      const why = [mixWhy(mix), `${llm} model requests`, tools ? `${tools} tool calls${err ? ` (${err} failed)` : ''}` : ''].filter(Boolean).join(' · ');
      out.push({ sid, idx: turn.idx, ts: turn.ts, title: titleOf(store, sid), text: turn.text, durMs: end - turn.ts, llm, sub: inT.filter((m) => m.side).length, tools, err, out: o, tin, cr, cost, tok, per1k, avg1k, avgModel: shortModel(dom), model: (() => { const l = Object.entries(byLabel).sort((a, b) => b[1] - a[1]); return l.length ? l[0][0] + (l.length > 1 ? ` +${l.length - 1}` : '') : ''; })(), hot: per1k != null && avg1k != null && per1k > avg1k, pct5: s5?.pct ?? null, win5: s5?.resetsAt ?? null, pct7: s7?.pct ?? null, mix, why, tps: tps(sp), sx: speedStats(sp), status: err ? 'error' : running ? 'running' : 'ok' });
    }
  }
  // Spike bar: a turn is a spike at >= meterTurnPct and >= anomalyX times the median turn of the last 7 days (median needs 10 turns)
  const week = out.filter((t) => t.pct5 != null && t.ts >= now - 7 * DAY_MS).map((t) => t.pct5).sort((a, b) => a - b);
  const typical = week.length >= 10 ? week[Math.floor(week.length / 2)] : 0;
  const T = getSettings().thresholds, bar = Math.max(T.meterTurnPct, typical * T.anomalyX);
  for (const t of out) t.spike = t.pct5 != null && t.pct5 >= bar;
  out.sort((a, b) => b.ts - a.ts);
  // Session picker: every session with turns, newest first. With sid, return all of that session's turns (no limit).
  const bySid = new Map();
  for (const t of out) { const s = bySid.get(t.sid) ?? { sid: t.sid, title: t.title, turns: 0, last: 0 }; s.turns++; s.last = Math.max(s.last, t.ts); bySid.set(t.sid, s); }
  const sessions = [...bySid.values()].sort((a, b) => b.last - a.last);
  if (sid) { const own = out.filter((t) => t.sid === sid); return { now, traces: own, total: out.length, sessionTotal: own.length, sessions, bar, typical }; }
  return { now, traces: out.slice(0, limit), total: out.length, sessions, bar, typical };
}

export function traceDetail(store, sid, ts, now = Date.now()) {
  const g = bySession(store).get(sid);
  if (!g) return null;
  const turn = turnsOf(store, sid, g).find((t) => t.ts === ts);
  if (!turn) return null;
  const tr = buildTrace(store, sid, turn, g, now, transcriptInfo(store, sid));
  const meter = meterIndex(store, costOf, now), c = tr.totals.cost;
  const { bar } = traceList(store, now, 0);
  return { ...tr, mix: costMix(g.filter((m) => m.ts >= turn.ts && m.ts < turn.end)), meter: { h5: meter.share('5h', turn.ts, c), d7: meter.share('7d', turn.ts, c), bar } };
}

/* ---------- M5: cost & usage ---------- */
export function usage(store, now = Date.now()) {
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const D = 30, start = day0.getTime() - (D - 1) * DAY;
  const days = Array.from({ length: D }, (_, i) => ({ t: start + i * DAY, req: 0, inp: 0, out: 0, cr: 0, cost: 0, sp: spd() }));
  const byModel = new Map(), byProject = new Map(), byTool = new Map(), bySess = new Map();
  const add = (map, k, c, o, m) => { let x = map.get(k); if (!x) map.set(k, x = { name: k, cost: 0, out: 0, req: 0, sp: spd() }); x.cost += c; x.out += o; x.req++; if (m) addSpd(x.sp, m); };
  const w = { h5: 0, h24: 0, d7: 0, d30: 0, today: 0 };
  for (const m of store.msgs.values()) {
    if (m.model === '<synthetic>') continue;
    const c = costOf(m);
    if (m.ts >= now - 5 * HOUR) w.h5 += c;
    if (m.ts >= now - DAY) w.h24 += c;
    if (m.ts >= now - 7 * DAY) w.d7 += c;
    if (m.ts >= day0.getTime()) w.today += c;
    const i = Math.floor((m.ts - start) / DAY);
    if (i < 0 || i >= D) continue;
    w.d30 += c;
    const d = days[i]; d.req++; d.inp += m.in + m.cw; d.out += m.out; d.cr += m.cr; d.cost += c; addSpd(d.sp, m);
    add(byModel, shortModel(m.model), c, m.out, m);
    const s = store.sessions.get(m.sid) || {};
    add(byProject, base(s.cwd) || s.project || 'unknown', c, m.out, m);
    add(bySess, m.sid, c, m.out, m);
    if (m.tools.length) { const names = m.tools.map((id) => (store.tools.get(id) || {}).name).filter(Boolean); for (const n of names) add(byTool, n, c / names.length, m.out / names.length); }
    else add(byTool, 'Reply (no tool)', c, m.out);
  }
  const top = (map, n) => [...map.values()].sort((a, b) => b.cost - a.cost).slice(0, n).map(({ sp, ...x }) => ({ ...x, tps: tps(sp), sx: speedStats(sp) }));
  const tokenTot = days.reduce((a, d) => ({ inp: a.inp + d.inp, out: a.out + d.out, cr: a.cr + d.cr }), { inp: 0, out: 0, cr: 0 });
  tokenTot.tps = tps(days.reduce((a, d) => mergeSpd(a, d.sp), spd()));
  // forecast: month to date + trailing 7-day average for the remaining days
  const nd = new Date(now), dim = new Date(nd.getFullYear(), nd.getMonth() + 1, 0).getDate();
  const monthStart = new Date(nd.getFullYear(), nd.getMonth(), 1).getTime();
  let mtd = 0; for (const m of store.msgs.values()) if (m.ts >= monthStart && m.model !== '<synthetic>') mtd += costOf(m);
  const last7 = days.slice(-7).reduce((a, d) => a + d.cost, 0) / 7;
  const forecast = { mtd, dayOfMonth: nd.getDate(), daysInMonth: dim, avgDaily: last7, projected: mtd + last7 * (dim - nd.getDate()), monthLabel: nd.toLocaleString('en-US', { month: 'long' }) };
  const weekIdx = (d) => Math.floor((day0.getTime() - d) / (7 * DAY));
  const weeks = [0, 0, 0, 0];
  for (const d of days) { const k = weekIdx(d.t); if (k >= 0 && k < 4) weeks[k] += d.cost; }
  return {
    now, days: days.map(({ sp, ...d }) => ({ ...d, tps: tps(sp), sx: speedStats(sp) })), window: w, forecast, weeks: weeks.reverse(), tokens: tokenTot,
    byModel: top(byModel, 6), byProject: top(byProject, 6), byTool: top(byTool, 8),
    bySession: top(bySess, 6).map((x) => ({ ...x, id: x.name, name: titleOf(store, x.name), sid: x.name })),
  };
}

/* ---------- M5: context ---------- */
/** What a normal working session re-reads per request: the median size at your 2nd to 4th prompt over recent sessions. A brand new session is
 *  smaller (about 55K before any work) but reaches this within a couple of prompts, so this is the honest comparison point. */
const promptsBy = (store) => { const m = new Map(); for (const p of store.prompts) { if (!m.has(p.sid)) m.set(p.sid, []); m.get(p.sid).push(p); } for (const l of m.values()) l.sort((x, y) => x.ts - y.ts); return m; };
export function freshStart(store, now = Date.now(), pb = promptsBy(store)) {
  const xs = [];
  for (const [sid, arr] of bySession(store)) {
    const main = arr.filter((m) => !m.side && m.src !== 'codex' && m.model !== '<synthetic>');
    const ps = pb.get(sid) || [];
    if (main.length < 3 || ps.length < 4 || main[0].ts < now - 30 * DAY) continue;
    for (let k = 1; k <= 3; k++) { const m = main.find((x) => x.ts >= ps[k].ts); if (m) xs.push(used(m)); }
  }
  xs.sort((a, b) => a - b);
  return xs.length >= 5 ? xs[xs.length >> 1] : 80000;
}

/** Why one session costs more per request the longer it runs. Every request re-sends the whole conversation, so each request re-reads
 *  `cur` tokens. Measured only: sizes come from the logs; growth between two requests is credited to the tools the earlier request called. */
export function heavyInfo(store, sid, now = Date.now(), fresh = freshStart(store, now), pb = promptsBy(store)) {
  const g = bySession(store).get(sid);
  const main = g ? g.filter((m) => !m.side && m.model !== '<synthetic>') : [];
  if (!main.length) return null;
  let from = 0;
  for (let i = 1; i < main.length; i++) if (used(main[i - 1]) > 30000 && used(main[i]) < used(main[i - 1]) * 0.6) from = i; // last compaction
  const seg = main.slice(from);
  const cur = used(seg[seg.length - 1]), startup = used(seg[0]);
  const by = new Map();
  const add = (k, v) => by.set(k, (by.get(k) || 0) + v);
  for (let i = 1; i < seg.length; i++) {
    const d = used(seg[i]) - used(seg[i - 1]);
    if (d <= 0) continue;
    const names = [...new Set((seg[i - 1].tools || []).map((id) => (store.tools.get(id) || {}).name).filter(Boolean))];
    if (!names.length) add('Your prompts and replies', d);
    else for (const n of names) add(n.replace(/^mcp__/, '').replace(/__/g, ' ') + ' results', d / names.length);
  }
  const growth = [...by].map(([k, v]) => ({ key: k, tokens: Math.round(v) })).sort((a, b) => b.tokens - a.tokens);
  const hour = main.filter((m) => m.ts >= now - HOUR);
  let reread = 0, extra = 0;
  for (const m of hour) { const u = used(m); reread += u; extra += Math.max(0, u - fresh); }
  // size at the start of each of your prompts since the last compaction (falls back to request numbers when the prompts are unknown)
  const ps = pb.get(sid) || [], first = seg[0].ts;
  const inSeg = ps.map((p, i) => ({ p, n: i + 1 })).filter((x) => x.p.ts >= first - 1000);
  let pts;
  if (inSeg.length >= 2) {
    const sizeAt = (x) => { const m = seg.find((y) => y.ts >= x.p.ts); return m ? used(m) : cur; };
    const picks = [...new Set([0, 0.25, 0.5, 0.75].map((f) => Math.round(f * (inSeg.length - 1))))];
    pts = picks.map((i) => ({ n: inSeg[i].n, used: sizeAt(inSeg[i]) }));
    pts.push({ n: ps.length, used: cur });
  } else pts = [0, 0.25, 0.5, 0.75, 1].map((f) => { const i = Math.min(seg.length - 1, Math.round(f * (seg.length - 1))); return { n: i + 1, used: used(seg[i]) }; });
  let compactions = 0; for (let i = 1; i < main.length; i++) if (used(main[i - 1]) > 30000 && used(main[i]) < used(main[i - 1]) * 0.6) compactions++;
  const steps = [];
  for (let i = 1; i < seg.length; i++) {
    const d = used(seg[i]) - used(seg[i - 1]);
    if (d < 4000) continue;
    const names = [...new Set((seg[i - 1].tools || []).map((id) => (store.tools.get(id) || {}).name).filter(Boolean))].map((n) => n.replace(/^mcp__/, '').replace(/__/g, ' '));
    steps.push({ ts: seg[i].ts, tokens: d, what: names.length ? names.join(' + ') : 'your prompt and the reply' });
  }
  steps.sort((x, y) => y.tokens - x.tokens);
  const prompts = Math.max(1, inSeg.length);
  let up = 0; for (let i = 1; i < main.length; i++) { const d = used(main[i]) - used(main[i - 1]); if (d > 0) up += d; } // growth per prompt over the whole session, for sessions that compact too often to measure one cycle
  return { sid, title: titleOf(store, sid), cur, startup, fresh, compactions, steps: steps.slice(0, 3), extraPerMsg: Math.max(0, cur - fresh), calls: seg.length, prompts, perPrompt: inSeg.length >= 3 ? Math.max(0, cur - startup) / inSeg.length : ps.length >= 3 ? up / ps.length : null, byPrompt: inSeg.length >= 2, hour: { calls: hour.length, reread, extra }, growth: growth.slice(0, 8), grown: Math.max(0, cur - startup), pts, last: main[main.length - 1].ts };
}

/** Median size of the very first request of recent sessions: what a brand new session writes into the cache before any work (rules, skills, tools). */
export function startupSize(store, now = Date.now()) {
  const xs = [];
  for (const [, arr] of bySession(store)) {
    const main = arr.filter((m) => !m.side && m.src !== 'codex' && m.model !== '<synthetic>');
    if (main.length >= 3 && main[0].ts >= now - 30 * DAY) xs.push(used(main[0]));
  }
  xs.sort((x, y) => x - y);
  return xs.length ? xs[xs.length >> 1] : 50000;
}

/** What a compaction costs in your logs (last 30 days). The log marks each one with the summary it left (`summary`, tokens the model wrote) and how long it took;
 *  the first request after it writes `write` tokens to the cache (summary plus re-attached files) and runs at `post` tokens.
 *  Same drop rule as the context marks for the sizes. Null with fewer than 3 measured compactions, so nothing is assumed. */
export function compactInfo(store, now = Date.now()) {
  const ev = store.events.filter((e) => e.kind === 'compact_boundary' && e.post > 0 && e.ts >= now - 30 * DAY);
  if (ev.length < 3) return null;
  const wr = [], post = [];
  for (const [, arr] of bySession(store)) {
    const main = arr.filter((m) => !m.side && m.src !== 'codex' && m.model !== '<synthetic>');
    for (let i = 1; i < main.length; i++) {
      const p = main[i - 1], m = main[i];
      if (m.ts >= now - 30 * DAY && used(p) > 30000 && used(m) < used(p) * 0.6) { wr.push(m.cw); post.push(used(m)); }
    }
  }
  if (wr.length < 3) return null;
  const med = (a) => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; };
  return { n: ev.length, summary: med(ev.map((e) => e.post)), write: med(wr), post: med(post), secs: med(ev.filter((e) => e.ms > 0).map((e) => e.ms)) / 1000 };
}

/** Each live Claude session: is its prompt cache warm, what the next message will cost to rebuild, whether the whole conversation was rewritten
 *  unexpectedly (and what changed), and how close it is to auto-compact. Active = a request in the last 6 hours. */
export function sessionWatch(store, now = Date.now()) {
  const pb = promptsBy(store), normal = freshStart(store, now, pb), startup = startupSize(store, now), rx = getSettings().thresholds.rewriteX;
  const rows = [];
  for (const [sid, arr] of bySession(store)) {
    const main = arr.filter((m) => !m.side && m.model !== '<synthetic>');
    if (!main.length || main[0].src === 'codex') continue;
    rows.push({ sid, main, lm: main[main.length - 1] });
  }
  rows.sort((x, y) => y.lm.ts - x.lm.ts);
  let rq = 0, pr = 0;
  for (const r of rows) { const n = (pb.get(r.sid) || []).length; if (n) { rq += r.main.length; pr += n; } }
  const rpp = pr >= 20 ? Math.max(1, Math.round(rq / pr)) : 7; // requests one prompt of yours turns into
  const cmp = compactInfo(store, now), lapseMemo = new Map();
  /** Cache lapses per prompt of yours (gaps in a session longer than the cache lifetime), last 30 days: each one rewrites whatever the session holds. */
  const lapseRate = (ttl) => {
    if (!lapseMemo.has(ttl)) {
      let g = 0, p = 0;
      for (const r of rows) {
        if (r.lm.ts < now - 30 * DAY) continue;
        const n = (pb.get(r.sid) || []).length; if (!n) continue;
        p += n; for (let i = 1; i < r.main.length; i++) if (r.main[i].ts - r.main[i - 1].ts >= ttl) g++;
      }
      lapseMemo.set(ttl, p >= 20 ? g / p : 0);
    }
    return lapseMemo.get(ttl);
  };
  const act = rows.filter((r) => r.lm.ts >= now - 6 * HOUR).slice(0, 8);
  const sessions = (act.length ? act : rows.slice(0, 1)).map(({ sid, main, lm }) => {
    const h = heavyInfo(store, sid, now, normal, pb), win = windowFor(main), cur = h.cur;
    // cache lifetime: 1 hour when the session writes to the 1-hour tier, else 5 minutes. Every request refreshes it.
    const rw = main.slice(-20).filter((m) => m.cw > 0), w = rw.reduce((x, m) => x + m.cw, 0), w1 = rw.reduce((x, m) => x + (m.cw1 || 0), 0);
    const ttl = (w && w1 / w < 0.5 ? 5 : 60) * MIN, left = ttl - (now - lm.ts);
    const events = [];
    for (let i = 1; i < main.length; i++) {
      const m = main[i], p = main[i - 1], u = used(m);
      if (m.ts < now - 6 * HOUR || u < 40000 || m.cw < 0.5 * u || u < used(p) * 0.6 || m.ts - p.ts >= ttl) continue; // not a compaction, and the cache had not expired
      const sm = shortModel(m.model), sp = shortModel(p.model);
      const cause = sm !== sp ? `the model was switched from ${sp} to ${sm}` : m.effort && p.effort && m.effort !== p.effort ? `the effort was changed from ${p.effort} to ${m.effort}` : !!m.fast !== !!p.fast ? `fast mode was turned ${m.fast ? 'on' : 'off'}` : 'something at the start of the conversation changed (tools or MCP servers, CLAUDE.md or settings)';
      events.push({ ts: m.ts, tokens: m.cw, cause });
    }
    const room = (to) => (cur >= to ? 0 : h.perPrompt != null && h.perPrompt > 500 ? Math.ceil((to - cur) / h.perPrompt) : null);
    const ratio = cur / startup, pct = (cur / win) * 100, toCompact = room(win * 0.83), rewrite = events.length ? events[events.length - 1] : null;
    // at risk = big enough that rebuilding it matters, and the cache is about to lapse (10 min) or lapsed within the last hour
    const risk = ratio >= rx ? (left > 0 && left <= 10 * MIN ? 'expiring' : left <= 0 && -left <= 60 * MIN ? 'cold' : null) : null;
    const compactSoon = now - lm.ts <= HOUR && pct >= 55 && (toCompact != null ? toCompact <= 3 : pct >= 75); // an idle session is not growing
    // Resume this session or start a new one? Priced from your rate card, counting everything that differs between the two:
    //  1. rewrite: a lapsed cache rewrites all of cur on resume, while a new session writes only a typical working size (normal);
    //  2. reads: every later request re-reads cur instead of normal, at the cache-read price;
    //  3. later lapses: each time the cache lapses again (measured rate per prompt of yours) the bigger session rewrites the extra D again;
    //  4. compaction: the bigger session reaches auto-compact sooner. A compaction reads the whole context and writes a summary (size measured
    //     from your logs), so each token of growth already used up spends its share of the room between the post-compaction size and the compact point.
    // Not priced: details that only live in this conversation. A handoff note must be asked for while the cache is warm (a lapsed session pays the rewrite for it).
    const pr0 = rateFor(lm), wr = pr0 ? (ttl === 60 * MIN ? pr0.cw1h : pr0.cw5m) / 1e6 : 0, rd = pr0 ? pr0.cr / 1e6 : 0, ou = pr0 ? pr0.out / 1e6 : 0;
    const usd = (v) => (v >= 0.1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3)), kk = (n) => Math.round(n / 1000) + 'K';
    const costs = main.slice(-20).map(costOf).filter((c) => c > 0).sort((a, b) => a - b), unit = costs.length ? costs[costs.length >> 1] * rpp : 0; // what one prompt of yours costs in this session
    const D = cur - normal, lp = lapseRate(ttl), cp = win * 0.83;
    const rd$ = Math.max(0, D) * rd * rpp, lp$ = lp * Math.max(0, D) * wr, ongoing = rd$ + lp$; // saved per prompt of yours, once running
    const K = cmp && pr0 ? cp * rd + cmp.summary * ou + cmp.write * wr : 0; // one compaction: read everything, write the summary (output), cache what the next request writes
    const cyc = cmp ? cp - cmp.post : 0, cs = K && cyc > 0 && D > 0 ? K * Math.min(1, D / cyc) : 0;
    const every = lp > 0 ? Math.round(1 / lp) : 0;
    const later = () => `${usd(ongoing)} per prompt after (${usd(rd$)} cheaper reads${lp$ > 0 ? `, ${usd(lp$)} from smaller rewrites when the cache lapses again, which it does about every ${every} prompts of yours` : ''})`;
    const compactTxt = () => (cs > 0 ? `, ${usd(cs)} from putting auto-compact further off (one compaction costs about ${usd(K)}: it reads the whole context, writes a ${kk(cmp.summary)} summary and caches ${kk(cmp.write)})` : '');
    const adviceFor = (lapsed) => {
      if (!pr0) return null;
      if (lapsed) {
        const resume = cur * wr, now$ = Math.max(0, D) * wr, save = now$ + cs;
        if (D <= 0) return { verdict: 'resume', head: 'Resume', say: `Resuming rewrites ${kk(cur)} (about ${usd(resume)}). A normal session grows to about ${kk(normal)} anyway, so a new one saves nothing.`, save: 0 };
        if (save + ongoing < unit) return { verdict: 'either', head: 'Either works', say: `Resuming rewrites ${kk(cur)} (about ${usd(resume)}). Starting fresh would save ${usd(now$)} of that${compactTxt()}, and ${later()}: less than one prompt of yours costs in this session (about ${usd(unit)}).`, save };
        return { verdict: 'fresh', head: 'Start a new session', say: `Resuming rewrites ${kk(cur)} (about ${usd(resume)}). A normal session is only about ${kk(normal)} by its 3rd prompt, so starting fresh saves ${usd(now$)} now${compactTxt()}, and ${later()}. Describe where you left off in your own words: asking this session for a summary would itself pay the rewrite. Resume instead if the next step depends on details found only in this conversation.`, save };
      }
      if (D <= 0) return { verdict: 'resume', head: 'Keep going', say: 'The cache is warm and this session is no bigger than a normal one, so starting fresh saves nothing.', save: 0 };
      const upfront = normal * wr + 2000 * ou + cur * rd, net = upfront - cs, n = ongoing > 0 ? net / ongoing : Infinity;
      const costTxt = `Starting fresh costs about ${usd(upfront)} to rebuild (handoff note included)`;
      const saveTxt = `saves ${later()}${cs > 0 ? `, and avoids about ${usd(cs)} of compaction cost (one compaction costs about ${usd(K)}; this session is that much closer to one)` : ''}`;
      const tip = 'Ask for the handoff note now, while the cache is warm and it is cheap.';
      // pays back before this session would have to compact anyway: hand off at the next natural stopping point
      if (net <= 0 || (toCompact != null && n <= toCompact)) return { verdict: 'fresh', head: 'Hand off at a stopping point', say: `The cache is warm, so continuing costs only cheap reads for now. ${costTxt} and ${saveTxt}, so it ${net <= 0 ? 'is cheaper straight away' : `pays back after about ${Math.max(1, Math.round(n))} prompt${Math.round(n) === 1 ? '' : 's'}, before auto-compact in about ${toCompact}`}. Finish the step you are on, then start a new session. ${tip}`, save: 0 };
      return { verdict: 'resume', head: 'Keep going', say: `The cache is warm, so continuing costs only cheap reads. ${costTxt} and ${saveTxt}, so it pays back after about ${n > 40 ? 'over 40' : Math.max(1, Math.round(n))} prompts. Hand off only if more work than that is ahead.${K && toCompact != null && toCompact <= 3 ? ` Auto-compact is about ${toCompact} prompt${toCompact === 1 ? '' : 's'} away and costs about ${usd(K)}; handing off first costs about ${usd(upfront)}.` : ''} ${tip}`, save: 0 };
    };
    return {
      advice: adviceFor(left <= 0), lapsedAdvice: adviceFor(true),
      sid, title: h.title, model: withEffort(shortModel(lm.model), lm), last: lm.ts, state: stateOf(now - lm.ts), cur, win, pct,
      cache: { warm: left > 0, ttlMin: ttl / MIN, leftMin: Math.max(0, left / MIN), coldMin: Math.max(0, -left / MIN) }, ratio,
      perPrompt: h.perPrompt, promptsToCompact: toCompact, prompts: h.prompts, compactions: h.compactions,
      why: h.growth.filter((x) => x.key !== 'Your prompts and replies').slice(0, 3), steps: h.steps, rewrite, risk, compactSoon, status: compactSoon ? 'big' : risk || rewrite ? 'watch' : 'ok', hour: h.hour,
    };
  });
  return { normal, startup, rewriteX: rx, sessions };
}

export function contextInfo(store, sid, now = Date.now()) {
  const groups = bySession(store);
  const rows = [];
  let latest = null;
  for (const [id, arr] of groups) {
    const main = arr.filter((m) => !m.side);
    if (!main.length) continue;
    const lm = main[main.length - 1];
    if (lm.ts < now - 7 * DAY) continue;
    const win = windowFor(main);
    let peak = 0, comp = 0, prev = 0;
    for (const m of main) { const u = used(m); peak = Math.max(peak, u); if (prev > 30000 && u < prev * 0.6) comp++; prev = u; }
    rows.push({ id, title: titleOf(store, id), last: lm.ts, window: win, cur: used(lm), peak, curPct: Math.min(100, (used(lm) / win) * 100), peakPct: Math.min(100, (peak / win) * 100), compactions: comp, model: withEffort(shortModel(lm.model), lm), state: stateOf(now - lm.ts) });
    if (!latest || lm.ts > latest.ts) latest = { id, ts: lm.ts };
  }
  rows.sort((a, b) => b.last - a.last);
  const pick = sid && groups.has(sid) ? sid : latest ? latest.id : '';
  let series = [], marks = [], cache = [], win = 2e5;
  if (pick) {
    const main = groups.get(pick).filter((m) => !m.side);
    win = windowFor(main);
    let prev = 0;
    series = main.map((m) => {
      const u = used(m);
      const comp = prev > 30000 && u < prev * 0.6;
      if (comp) marks.push({ ts: m.ts, from: prev, to: u });
      prev = u;
      return { ts: m.ts, used: u, pct: +((u / win) * 100).toFixed(2), in: m.in, cr: m.cr, cw: m.cw, hit: u ? +(m.cr / u).toFixed(4) : 0 };
    });
    cache = series.map((x) => ({ ts: x.ts, hit: x.hit, cw: x.cw }));
    for (const e of store.events) if (e.sid === pick && /compact/i.test(e.kind) && !marks.some((k) => Math.abs(k.ts - e.ts) < 120e3)) marks.push({ ts: e.ts, from: 0, to: 0, kind: e.kind });
  }
  let cr = 0, all = 0, saved = 0;
  for (const m of store.msgs.values()) {
    if (m.ts < now - DAY || m.model === '<synthetic>') continue;
    cr += m.cr; all += used(m);
    const p = rateFor(m); if (p) saved += (m.cr * (p.in - p.cr)) / 1e6;
  }
  const sess = pick ? store.sessions.get(pick) || {} : {};
  return { now, sid: pick, title: pick ? titleOf(store, pick) : '', model: series.length ? (() => { const lm = groups.get(pick).filter((m) => !m.side).slice(-1)[0]; return withEffort(shortModel(lm.model), lm); })() : '', window: win, series: series.slice(-400), marks, cache: cache.slice(-400), sessions: rows.slice(0, 20), cacheDay: { hit: all ? cr / all : 0, cr, all, saved }, cwd: sess.cwd || '', heavy: pick ? heavyInfo(store, pick, now) : null, live: sessionWatch(store, now) };
}

/* ---------- M5: models ---------- */
export function modelsInfo(store, now = Date.now()) {
  const since = now - 30 * DAY;
  const g = new Map();
  const dots = [];
  const levels = new Map();
  const winSeen = new Map();
  for (const m of store.msgs.values()) {
    if (m.model === '<synthetic>') continue;
    if (!m.side) winSeen.set(m.model, Math.max(winSeen.get(m.model) || 0, used(m)));
    if (m.ts < since) continue;
    let x = g.get(m.model); if (!x) g.set(m.model, x = { id: m.model, req: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, think: 0, fast: 0, lat: [], durSum: 0, durOut: 0, side: 0, sp: spd() });
    x.req++; x.in += m.in; x.out += m.out; x.cr += m.cr; x.cw += m.cw; x.cost += costOf(m); x.think += m.think; if (m.fast) x.fast++; if (m.side) x.side++; addSpd(x.sp, m);
    const lk = m.model + '|' + (m.effort || '') + '|' + (m.fast ? 1 : 0); let lv = levels.get(lk); if (!lv) levels.set(lk, lv = { name: shortModel(m.model), effort: m.effort || '', fast: !!m.fast, req: 0, out: 0, cost: 0, sp: spd() });
    lv.req++; lv.out += m.out; lv.cost += costOf(m); addSpd(lv.sp, m);
    const lat = m.ts - (m.startTs || m.ts);
    if (lat > 200 && lat < 10 * MIN) { x.lat.push(lat); x.durSum += lat; x.durOut += m.out; if (dots.length < 4000) dots.push({ model: m.model, lat, out: m.out }); }
  }
  const rows = [...g.values()].map((x) => {
    const p = priceFor(x.id);
    return {
      id: x.id, name: shortModel(x.id), req: x.req, share: 0, in: x.in, out: x.out, cr: x.cr, cw: x.cw, cost: x.cost,
      avgOut: x.req ? x.out / x.req : 0, p50: pct(x.lat, 0.5), p95: pct(x.lat, 0.95), tokPerSec: tps(x.sp), sx: speedStats(x.sp),
      hit: x.in + x.cr + x.cw ? x.cr / (x.in + x.cr + x.cw) : 0, thinkShare: x.out ? x.think / x.out : 0, fastShare: x.req ? x.fast / x.req : 0, subShare: x.req ? x.side / x.req : 0,
      window: winOf(winSeen.get(x.id) || 0), peak: winSeen.get(x.id) || 0, price: p ? { in: p.in, out: p.out, cr: p.cr } : null,
    };
  }).sort((a, b) => b.req - a.req);
  const tot = rows.reduce((a, r) => a + r.req, 0);
  for (const r of rows) r.share = tot ? r.req / tot : 0;
  // thin the scatter to at most ~500 points per model, deterministic
  const keep = []; const per = new Map();
  for (const d of dots) { const n = (per.get(d.model) || 0) + 1; per.set(d.model, n); if (n % Math.max(1, Math.ceil(dots.length / 600)) === 0) keep.push({ model: shortModel(d.model), lat: +(d.lat / 1000).toFixed(2), out: d.out }); }
  const allSp = [...g.values()].reduce((a, x) => mergeSpd(a, x.sp), spd());
  const lvRows = [...levels.values()].sort((a, b) => b.req - a.req).map(({ sp, ...x }) => ({ ...x, tps: tps(sp), sx: speedStats(sp) }));
  return { now, models: rows, levels: lvRows, scatter: keep, all: speedStats(allSp) };
}

/* ---------- M5: tools ---------- */
export function toolsInfo(store, now = Date.now(), mix = null) {
  const since = now - 30 * DAY;
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const D = 14, start = day0.getTime() - (D - 1) * DAY;
  const g = new Map(); const slow = []; const errs = [];
  for (const t of store.tools.values()) {
    if (t.ts < since) continue;
    let x = g.get(t.name); if (!x) g.set(t.name, x = { name: t.name, calls: 0, err: 0, durs: [], total: 0, daily: new Array(D).fill(0), p5: 0, n5: 0, p7: 0, n7: 0 });
    x.calls++; if (t.err) { x.err++; errs.push(t); }
    if (t.endTs > 0) { const d = t.endTs - t.ts; x.durs.push(d); x.total += d; if (!isAgent(t.name)) slow.push({ ...t, d }); }
    const i = Math.floor((t.ts - start) / DAY); if (i >= 0 && i < D) x.daily[i]++;
  }
  // Plan meter use per tool: a request's list cost is split evenly over the tool calls it made, then turned into that window's share of the
  // meter reading (meterIndex.share, the Traces method). Total adds every window; avg is per call that fell in a window with a reading.
  if (mix) for (const m of store.msgs.values()) {
    if (!m.tools.length || m.model === '<synthetic>') continue;
    const mi = m.src === 'codex' ? mix.codex : mix.claude, c = (costOf(m) || 0) / m.tools.length;
    for (const id of m.tools) {
      const t = store.tools.get(id), x = t && t.ts >= since && g.get(t.name);
      if (!x) continue;
      const a = mi.share('5h', m.ts, c), b = mi.share('7d', m.ts, c);
      if (a) { x.p5 += a.pct; x.n5++; }
      if (b) { x.p7 += b.pct; x.n7++; }
    }
  }
  const calls = [...g.values()].reduce((a, x) => a + x.calls, 0);
  const rows = [...g.values()].map((x) => ({ name: x.name, calls: x.calls, share: calls ? x.calls / calls : 0, p5: x.n5 ? x.p5 : null, p5Avg: x.n5 ? x.p5 / x.n5 : null, p7: x.n7 ? x.p7 : null, p7Avg: x.n7 ? x.p7 / x.n7 : null, err: x.err, errRate: x.calls ? x.err / x.calls : 0, avgMs: x.durs.length ? x.total / x.durs.length : 0, p50: pct(x.durs, 0.5), p95: pct(x.durs, 0.95), maxMs: x.durs.length ? Math.max(...x.durs) : 0, totalMs: x.total, daily: x.daily })).sort((a, b) => b.calls - a.calls);
  slow.sort((a, b) => b.d - a.d);
  errs.sort((a, b) => b.ts - a.ts);
  const sl = (t) => ({ id: t.id, name: t.name, ts: t.ts, sid: t.sid, session: titleOf(store, t.sid), ms: t.d ?? (t.endTs ? t.endTs - t.ts : 0), err: t.err });
  return { now, days: Array.from({ length: D }, (_, i) => start + i * DAY), tools: rows, calls, errors: rows.reduce((a, r) => a + r.err, 0), slowest: slow.slice(0, 12).map(sl), recentErrors: errs.slice(0, 10).map(sl) };
}

/* ---------- compare: one row per model and reasoning level (the Artificial Analysis table layout) ---------- */
let BENCH = {};
try { BENCH = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench.json'), 'utf8')); } catch { /* optional */ }
const benchSpeed = (id) => { for (const k of Object.keys(BENCH)) if (!k.startsWith('_') && id.includes(k)) return BENCH[k]; return 0; };
const pctl = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const five = (a) => ({ n: a.length, p5: pctl(a, 0.05), p25: pctl(a, 0.25), p50: pctl(a, 0.5), p75: pctl(a, 0.75), p95: pctl(a, 0.95) });
/**
 * Speed is per reply, after the first token (output tokens - 1 over first token to last event), then the median and
 * percentiles across replies, as Artificial Analysis does. Latency columns are seconds from request start to the first
 * chunk (first thinking token) and to the first answer (end of thinking). A task is one user prompt and every call after it.
 */
export function compareInfo(store, days = 7, now = Date.now()) {
  const since = days > 0 ? now - days * DAY : 0;
  const rows = new Map(), trends = new Map();
  for (const [sid, g] of bySession(store)) {
    const ps = store.prompts.filter((p) => p.sid === sid).map((p) => p.ts).sort((a, b) => a - b);
    for (const m of g) {
      if (m.model === '<synthetic>') continue;
      const key = m.model + '|' + (m.effort || '') + '|' + (m.fast ? 1 : 0);
      const s = msgSpeed(m);
      if (m.ts >= now - 7 * DAY) { // 7-day trend, independent of the table window: one point per day, oldest first
        let t = trends.get(key); if (!t) trends.set(key, t = { sp: Array.from({ length: 7 }, () => []), cost: Array(7).fill(0) });
        const di = 6 - Math.min(6, Math.floor((now - m.ts) / DAY));
        if (s.dtps) t.sp[di].push(s.dtps); t.cost[di] += costOf(m);
      }
      if (m.ts < since) continue;
      let x = rows.get(key);
      if (!x) rows.set(key, x = { key, src: m.src || 'claude', win: m.win || 0, id: m.model, name: shortModel(m.model), effort: m.effort || '', fast: !!m.fast, req: 0, side: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, peak: 0, tasks: new Map(), dtps: [], tps: [], ttft: [], ans: [], lat: [], think: [] });
      x.req++; if (m.side) x.side++; x.in += m.in; x.out += m.out; x.cr += m.cr; x.cw += m.cw;
      const c = costOf(m); x.cost += c; if (!m.side) x.peak = Math.max(x.peak, used(m));
      let lo = 0, hi = ps.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ps[mid] <= m.ts) lo = mid + 1; else hi = mid; }
      const tk = sid + ':' + lo; x.tasks.set(tk, (x.tasks.get(tk) || 0) + c);
      if (s.dtps) x.dtps.push(s.dtps); if (s.tps) x.tps.push(s.tps); if (s.ttft) x.ttft.push(s.ttft / 1000); if (s.ans) x.ans.push(s.ans / 1000); if (s.lat) x.lat.push(s.lat / 1000); if (s.think) x.think.push(s.think / 1000);
    }
  }
  const total = [...rows.values()].reduce((a, x) => a + x.req, 0);
  const out = [...rows.values()].map((x) => {
    const p = priceFor(x.id), win = x.win || winOf(x.peak), nt = x.tasks.size;
    return {
      id: x.id, src: x.src, name: x.name, effort: x.effort, fast: x.fast, req: x.req, share: total ? x.req / total : 0, sub: x.req ? x.side / x.req : 0, out: x.out, cost: x.cost,
      tasks: nt, costTask: nt ? x.cost / nt : 0, costReq: x.req ? x.cost / x.req : 0, peak: x.peak, window: win, hit: x.in + x.cr + x.cw ? x.cr / (x.in + x.cr + x.cw) : 0,
      price: p ? { in: p.in, out: p.out, cr: p.cr, cw: p.cw5m ?? p.cw ?? 0 } : null,
      trend: (() => { const t = trends.get(x.key); return t ? { speed: t.sp.map((a) => (a.length ? five(a).p50 : null)), cost: t.cost } : { speed: Array(7).fill(null), cost: Array(7).fill(0) }; })(),
      est: x.dtps.length ? 0 : benchSpeed(x.id), speed: five(x.dtps), e2e: five(x.tps), ttft: five(x.ttft), ans: five(x.ans), lat: five(x.lat), think: five(x.think),
    };
  }).sort((a, b) => b.req - a.req);
  const efforts = [...new Set(out.map((r) => r.effort).filter(Boolean))];
  return { now, days, efforts, rows: out };
}

/* ---------- one tool call: full input and result, read from the transcript on demand ---------- */
const CAPTXT = 20000;
const clip = (t) => { t = String(t ?? ''); return t.length > CAPTXT ? t.slice(0, CAPTXT * 0.6) + '\n… ' + (t.length - CAPTXT) + ' characters left out …\n' + t.slice(-CAPTXT * 0.4) : t; };
const fieldsOf = (o) => {
  if (o == null) return [];
  if (typeof o === 'string') return [{ k: 'input', v: clip(o) }];
  if (typeof o !== 'object') return [{ k: 'input', v: String(o) }];
  return Object.entries(o).map(([k, v]) => ({ k, v: clip(typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }));
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : b && b.type === 'image' ? '[image]' : b && typeof b === 'object' ? JSON.stringify(b) : String(b ?? ''))).join('\n') : c == null ? '' : JSON.stringify(c, null, 2));
export async function toolDetail(store, id) {
  const t = store.tools.get(id);
  if (!t) return null;
  const out = { id, name: t.name, sid: t.sid, ts: t.ts, endTs: t.endTs, err: !!t.err, running: !t.endTs && Date.now() - t.ts < 10 * MIN, src: t.src || 'claude', session: titleOf(store, t.sid), model: (() => { const m = store.msgs.get(t.msg); return m ? withEffort(shortModel(m.model), m) : ''; })(), fields: [], result: '', found: false };
  const file = fileOf(store, t.sid);
  if (!file) { out.note = 'The transcript file for this session is not on disk any more.'; return out; }
  const key = String(id).replace(/^cx:/, '');   // Codex ids are the rollout call_id with a cx: prefix
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let gotIn = false, gotOut = false;
  try {
    for await (const ln of rl) {
      if (!ln.includes(key)) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const p = o.payload;
      if (p && p.call_id === key) {   // Codex rollout line
        if (/_call$/.test(p.type || '') && !gotIn) { let a = p.arguments ?? p.input ?? p.action; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* plain text */ } } out.fields = fieldsOf(a); gotIn = true; }
        else if (/_call_output$/.test(p.type || '') && !gotOut) {
          let r = p.output; if (typeof r === 'string') { try { const j = JSON.parse(r); if (j && typeof j === 'object' && 'output' in j) { r = j.output + (j.metadata && j.metadata.exit_code != null ? '\n\n[exit code ' + j.metadata.exit_code + ']' : ''); } } catch { /* plain text */ } }
          out.result = clip(textOf(r)); gotOut = true;
        }
      } else {   // Claude transcript line
        const c = o.message && o.message.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b && b.type === 'tool_use' && b.id === key && !gotIn) { out.fields = fieldsOf(b.input); gotIn = true; }
          else if (b && b.type === 'tool_result' && b.tool_use_id === key && !gotOut) {
            let r = textOf(b.content);
            if (!r && o.toolUseResult && typeof o.toolUseResult === 'object') r = [o.toolUseResult.stdout, o.toolUseResult.stderr].filter(Boolean).join('\n');
            out.result = clip(r); if (b.is_error) out.err = true; gotOut = true;
          }
        }
      }
      if (gotIn && gotOut) break;
    }
  } finally { rl.close(); }
  out.found = gotIn || gotOut;
  if (!out.found) out.note = 'This call is not in the transcript any more.';
  else if (!gotOut) out.note = t.endTs ? 'No result text was recorded for this call.' : 'No result yet: the call is still running.';
  return out;
}
