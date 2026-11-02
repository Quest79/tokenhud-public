// Aggregations over the Store for the dashboard API. Pure functions, no I/O except pricing.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings } from './settings.mjs';
import { spd, addSpd, tps, msgTps, speedStats, withEffort } from './speed.mjs';
import { accountLatest, acctOf } from './planvalue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let PRICES = {};
try { PRICES = JSON.parse(fs.readFileSync(path.join(here, 'pricing.json'), 'utf8')); } catch { /* costs show as 0 */ }

export function basePrices() {
  const t = {};
  for (const k of Object.keys(PRICES)) if (!k.startsWith('_')) t[k] = { ...PRICES[k] };
  return t;
}
export function priceTable() {
  const o = getSettings().pricing || {}, t = {};
  for (const k of Object.keys(PRICES)) if (!k.startsWith('_')) t[k] = { ...PRICES[k], ...(o[k] || {}) };
  for (const k of Object.keys(o)) if (!(k in t)) t[k] = { in: 0, out: 0, cw5m: 0, cw1h: 0, cr: 0, ...o[k] };
  return t;
}
export function priceFor(model) {
  const t = priceTable();
  for (const k of Object.keys(t)) if (model.includes(k)) return t[k];
  return null;
}
/** Context window for a model given the largest context seen: setting override, else 1M when above 200k. */
export function winOf(peak) {
  const w = getSettings().contextWindow;
  return w === 'auto' ? (peak > 200000 ? 1e6 : 2e5) : Number(w);
}
/** Rate card for a message: the family row, or its tier rates when the prompt (input + cache) is above `tierAbove` (Haiku 5.5). */
export function rateFor(m) {
  const p = priceFor(m.model);
  if (!p) return null;
  return p.tier && m.in + m.cr + m.cw > p.tierAbove ? { ...p, ...p.tier } : p;
}
export function costOf(m) {
  const p = rateFor(m);
  if (!p) return 0;
  const cw5 = Math.max(0, m.cw - m.cw1);
  return (m.in * p.in + m.out * p.out + cw5 * p.cw5m + m.cw1 * p.cw1h + m.cr * p.cr) / 1e6;
}

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
export const RANGES = {
  '60s': { span: MIN, bucket: 5e3, fmt: 'sec' },
  '5m': { span: 5 * MIN, bucket: 15e3, fmt: 'sec' },
  '1h': { span: HOUR, bucket: MIN, fmt: 'time' },
  '6h': { span: 6 * HOUR, bucket: 6 * MIN, fmt: 'time' },
  '24h': { span: DAY, bucket: 30 * MIN, fmt: 'time' },
  '7d': { span: 7 * DAY, bucket: 3 * HOUR, fmt: 'day' },
};

const sum = (a, f) => { let t = 0; for (const x of a) t += f(x); return t; };
const base = (p) => (p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';

function totals(msgs) {
  const t = { req: 0, in: 0, out: 0, cr: 0, cw: 0, think: 0, cost: 0 }, sp = spd();
  for (const m of msgs) { addSpd(sp, m); t.req++; t.in += m.in; t.out += m.out; t.cr += m.cr; t.cw += m.cw; t.think += m.think; t.cost += costOf(m); }
  const all = t.in + t.cr + t.cw;
  t.hit = all ? t.cr / all : 0;
  t.total = all + t.out;
  t.tps = tps(sp); t.sx = speedStats(sp);
  return t;
}

function shortModel(id) {
  const m = /claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}` : id || 'unknown';
}

export function overview(store, rangeKey = '1h', now = Date.now()) {
  const R = RANGES[rangeKey] || RANGES['1h'];
  const since = now - R.span, prevSince = since - R.span;
  const cur = [], prev = [];
  for (const m of store.msgs.values()) {
    if (m.model === '<synthetic>') continue;
    if (m.ts >= since) cur.push(m); else if (m.ts >= prevSince) prev.push(m);
  }
  const T = totals(cur), P = totals(prev);

  // time buckets aligned to the bucket size so labels are stable between refreshes
  const n = Math.round(R.span / R.bucket);
  const end = Math.ceil(now / R.bucket) * R.bucket;
  const start = end - n * R.bucket;
  const b = Array.from({ length: n }, (_, i) => ({ t: start + i * R.bucket, req: 0, out: 0, inp: 0, cr: 0, cost: 0, cw: 0, raw: 0, sp: spd() }));
  for (const m of cur) {
    const i = Math.floor((m.ts - start) / R.bucket);
    if (i >= 0 && i < n) { const x = b[i]; x.req++; x.out += m.out; x.inp += m.in + m.cw; x.cr += m.cr; x.raw += m.in + m.cw; x.cost += costOf(m); addSpd(x.sp, m); }
  }
  const mins = R.bucket / MIN;

  // tools
  const tg = new Map();
  for (const t of store.tools.values()) {
    if (t.ts < since) continue;
    let g = tg.get(t.name); if (!g) tg.set(t.name, g = { name: t.name, calls: 0, err: 0, dur: 0, timed: 0 });
    g.calls++; if (t.err) g.err++;
    if (t.endTs > 0) { g.dur += t.endTs - t.ts; g.timed++; }
  }
  const toolCalls = sum(tg.values(), (g) => g.calls);
  const tools = [...tg.values()].sort((a, b) => b.calls - a.calls).slice(0, 8)
    .map((g) => ({ name: g.name, calls: g.calls, err: g.err, share: toolCalls ? g.calls / toolCalls : 0, avgMs: g.timed ? g.dur / g.timed : 0 }));

  // sessions (touched in the last 24 h, newest first)
  const per = new Map();
  for (const m of store.msgs.values()) {
    if (m.ts < now - DAY) continue;
    let p = per.get(m.sid); if (!p) per.set(m.sid, p = { req: 0, out: 0, cost: 0, last: 0, model: '', tool: '', sp: spd() });
    p.req++; p.out += m.out; p.cost += costOf(m); addSpd(p.sp, m);
    if (m.ts >= p.last) { p.last = m.ts; p.model = m.model; p.lm = m; if (!m.side) p.main = m; }
  }
  const sessions = [...per.entries()].map(([sid, p]) => {
    const s = store.sessions.get(sid) || {};
    const age = now - p.last;
    return {
      id: sid, title: s.title || '', project: base(s.cwd) || s.project || '', branch: s.branch || '', app: s.entrypoint || '',
      last: p.last, req: p.req, out: p.out, cost: p.cost, tps: tps(p.sp), sx: speedStats(p.sp), model: withEffort(shortModel(p.model), p.main || p.lm),
      state: age < 2 * MIN ? 'live' : age < 30 * MIN ? 'idle' : 'done',
    };
  }).sort((a, b) => b.last - a.last).slice(0, 8);

  // context of the most recently active main-thread session
  let ctx = null;
  let latest = null;
  for (const m of store.msgs.values()) if (!m.side && (!latest || m.ts > latest.ts)) latest = m;
  if (latest) {
    let peak = 0;
    for (const m of store.msgs.values()) if (m.sid === latest.sid && !m.side) peak = Math.max(peak, m.in + m.cr + m.cw);
    const used = latest.in + latest.cr + latest.cw;
    const window = winOf(peak);
    const s = store.sessions.get(latest.sid) || {};
    ctx = { sid: latest.sid, title: s.title || base(s.cwd), model: withEffort(shortModel(latest.model), latest), used, in: latest.in, cr: latest.cr, cw: latest.cw, window, pct: Math.min(100, (used / window) * 100), ts: latest.ts };
  }

  // recent activity feed
  const feed = [];
  for (const m of store.msgs.values()) if (m.ts >= now - 30 * MIN) feed.push({ ts: m.ts, src: m.side ? 'subagent' : 'assistant', level: 'INFO', text: `${shortModel(m.model)}  out ${m.out.toLocaleString('en-US')}  cache ${m.cr.toLocaleString('en-US')}${msgTps(m) ? '  ' + Math.round(msgTps(m)) + ' tok/s' : ''}${m.tools.length ? '  tools ' + m.tools.length : ''}` });
  for (const t of store.tools.values()) if (t.endTs >= now - 30 * MIN) feed.push({ ts: t.endTs, src: 'tool', level: t.err ? 'ERROR' : 'INFO', text: `${t.name} ${t.err ? 'failed' : 'finished'} in ${((t.endTs - t.ts) / 1000).toFixed(1)}s` });
  for (const p of store.prompts) if (p.ts >= now - 30 * MIN) feed.push({ ts: p.ts, src: 'user', level: 'INFO', text: 'prompt submitted' });
  feed.sort((a, b) => b.ts - a.ts);

  // rolling local usage (plan limits need the status line feed, M8)
  // Which Claude login was active at a time: every plan reading carries its login's weekly reset, and the reset's time-of-week names the login.
  const tl = (store.plan || []).filter((x) => x.p7 != null && acctOf(x.r7) != null).map((x) => ({ ts: x.ts, k: acctOf(x.r7) })).sort((a, b) => a.ts - b.ts);
  const loginAt = (t) => { // latest reading at or before t, else the first one after it
    let lo = 0, hi = tl.length - 1, k = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tl[mid].ts <= t) { k = tl[mid].k; lo = mid + 1; } else hi = mid - 1; }
    return k ?? tl[0]?.k ?? null;
  };
  const byLogin = new Map(); // login key -> { cost, out }
  let out5h = 0, out7d = 0, out30d = 0, tok5h = 0, all5h = 0, all7d = 0, all30d = 0, cost7d = 0, cost30d = 0, cx30 = 0, cxOut = 0, cxAll = 0, first = now;
  for (const m of store.msgs.values()) {
    if (m.ts >= now - 5 * HOUR) { out5h += m.out; tok5h += m.in + m.cw + m.out; all5h += m.in + m.cr + m.cw + m.out; }
    if (m.ts >= now - 7 * DAY) { out7d += m.out; all7d += m.in + m.cr + m.cw + m.out; cost7d += costOf(m); }
    if (m.ts >= now - 30 * DAY && m.model !== '<synthetic>') {
      const c = costOf(m), all = m.in + m.cr + m.cw + m.out; cost30d += c; out30d += m.out; all30d += all;
      if (m.src === 'codex') { cx30 += c; cxOut += m.out; cxAll += all; } else { const k = loginAt(m.ts), a = byLogin.get(k) || { cost: 0, out: 0, all: 0 }; a.cost += c; a.out += m.out; a.all += all; byLogin.set(k, a); }
    }
    if (m.model !== '<synthetic>' && m.ts < first) first = m.ts;
  }
  // API-rate value of the last 30 days over the price of every plan used in it, plus one row per account.
  // Shorter history is prorated to a 30-day month, so the multiplier stays comparable.
  const CLAUDE_PRO_USD = 20; // Claude Pro billed monthly (claude.com/pricing, checked 2026-10-14)
  const CX_PLAN_USD = { go: 8, plus: 20, pro: 100 }; // ChatGPT plans by Codex plan_type (chatgpt.com/pricing, checked 2026-10-31)
  const days = Math.min(30, Math.max(1, (now - first) / DAY)), month = days / 30;
  const accts = [];
  const logins = accountLatest(store.plan || [], now).sort((a, b) => acctOf(a.resetsAt) - acctOf(b.resetsAt));
  for (const l of logins) {
    const a = byLogin.get(acctOf(l.resetsAt)); if (!a) continue;
    const when = new Date(l.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    accts.push({ name: logins.length > 1 ? `Claude Pro, resets ${when}` : 'Claude Pro', usd: CLAUDE_PRO_USD, cost: a.cost, out: a.out, all: a.all });
  }
  const unknown = [...byLogin].filter(([k]) => !logins.some((l) => acctOf(l.resetsAt) === k)).reduce((s, [, a]) => ({ cost: s.cost + a.cost, out: s.out + a.out, all: s.all + a.all }), { cost: 0, out: 0, all: 0 });
  if (unknown.cost > 0) { if (accts.length) { accts[0].cost += unknown.cost; accts[0].out += unknown.out; accts[0].all += unknown.all; } else accts.push({ name: 'Claude Pro', usd: CLAUDE_PRO_USD, ...unknown }); }
  const cxType = [...(store.cxPlan || [])].reverse().find((x) => x.plan)?.plan || '';
  if (cx30 > 0 && CX_PLAN_USD[cxType]) accts.push({ name: `ChatGPT ${cxType[0].toUpperCase()}${cxType.slice(1)}`, usd: CX_PLAN_USD[cxType], cost: cx30, out: cxOut, all: cxAll });
  for (const a of accts) a.mult = a.cost / (a.usd * month);
  const planUsd = accts.reduce((s, a) => s + a.usd, 0) || CLAUDE_PRO_USD;
  const apiMult = { usd: planUsd, accts, cost: cost30d, days, mult: cost30d / (planUsd * month) };

  // today (server local midnight)
  const mid = new Date(now); mid.setHours(0, 0, 0, 0);
  const today = { req: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, total: 0, tps: 0 }, todaySp = spd();
  for (const m of store.msgs.values()) {
    if (m.ts < mid.getTime() || m.model === '<synthetic>') continue;
    today.req++; today.in += m.in; today.out += m.out; today.cr += m.cr; today.cw += m.cw; today.cost += costOf(m); addSpd(todaySp, m);
  }
  today.tps = tps(todaySp); today.sx = speedStats(todaySp);
  today.total = today.in + today.out + today.cr + today.cw;

  // what the most recent main-thread session is doing right now (inferred from the transcript)
  let activity;
  {
    let run = null;
    for (const t of store.tools.values()) if (!t.endTs && t.ts > now - 10 * MIN && (!run || t.ts > run.ts)) run = t;
    const sid = run ? run.sid : latest ? latest.sid : '';
    const ss = store.sessions.get(sid) || {};
    const age = latest ? now - latest.ts : 0;
    const state = run ? 'tool' : latest && age < 90e3 && latest.stop !== 'end_turn' ? 'generating' : latest && age < 2 * MIN ? 'live' : 'idle';
    activity = { state, tool: run ? run.name : '', sid, title: ss.title || base(ss.cwd), ageMs: age };
  }

  const models = {};
  for (const m of cur) { const k = shortModel(m.model); models[k] = (models[k] || 0) + 1; }

  return {
    now, range: rangeKey, since, version: store.version,
    totals: T, prev: P,
    series: { t: b.map((x) => x.t), req: b.map((x) => x.req), tps: b.map((x) => +tps(x.sp).toFixed(1)), outPerMin: b.map((x) => Math.round(x.out / mins)), out: b.map((x) => x.out), inp: b.map((x) => x.inp), cr: b.map((x) => x.cr), hit: b.map((x) => (x.cr + x.raw ? +(x.cr / (x.cr + x.raw)).toFixed(4) : 0)), cost: b.map((x) => +x.cost.toFixed(4)), bucket: R.bucket, fmt: R.fmt },
    mix: { in: T.in, cr: T.cr, cw: T.cw, out: T.out },
    today, activity, tools, toolCalls, sessions, ctx, feed: feed.slice(0, 14), models,
    local: { out5h, tok5h, out7d, cost7d, out30d, cost30d, all5h, all7d, all30d },
    apiMult,
    liveSessions: sessions.filter((s) => s.state === 'live').length,
    lastTs: latest ? latest.ts : 0,
    ingest: { files: Object.keys(store.files).length, messages: store.msgs.size },
  };
}

// 24 hourly buckets for the burn chart (always 24h, independent of range)
export function hourly(store, now = Date.now()) {
  const end = Math.ceil(now / HOUR) * HOUR, start = end - 24 * HOUR;
  const h = Array.from({ length: 24 }, (_, i) => ({ t: start + i * HOUR, inp: 0, out: 0 }));
  for (const m of store.msgs.values()) {
    const i = Math.floor((m.ts - start) / HOUR);
    if (i >= 0 && i < 24) { h[i].inp += m.in + m.cw; h[i].out += m.out; }
  }
  return h;
}

// compact status for the tray icon tooltip and dot
export function trayStatus(store, now = Date.now()) {
  let out5m = 0, live = 0;
  const seen = new Set();
  for (const m of store.msgs.values()) {
    if (m.ts >= now - 5 * MIN) out5m += m.out;
    if (!m.side && m.ts >= now - 2 * MIN) seen.add(m.sid);
  }
  live = seen.size;
  const mid = new Date(now); mid.setHours(0, 0, 0, 0);
  let todayOut = 0, todayCost = 0;
  for (const m of store.msgs.values()) if (m.ts >= mid.getTime() && m.model !== '<synthetic>') { todayOut += m.out; todayCost += costOf(m); }
  return { level: live ? 'live' : 'idle', liveSessions: live, tokPerMin: Math.round(out5m / 5), todayOut, todayCost: +todayCost.toFixed(2), plan5h: null };
}
