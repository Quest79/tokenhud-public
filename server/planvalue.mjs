// Plan value: how many API dollars each model + reasoning effort burns per 1% of the 5-hour and weekly allotment.
// Inputs: plan % readings (saved in transcripts whenever get_usage ran, plus the status line feed) and per-request cost.
// Method: split the readings into windows (same reset time), cut each window into chunks that moved at least 2 points,
// add up the API dollars of each model+effort bucket inside every chunk, then fit  %moved = sum(k_bucket * dollars)
// with non-negative least squares. $ per 1% for a bucket is 1 / k_bucket.
// costOf is passed in by the caller (importing stats.mjs here would make a cycle through ingest.mjs)

import { dur, spd, mergeSpd, tps } from './speed.mjs';
const MIN = 60e3, MAX_GAP = 90 * MIN, MIN_MOVE = 2;
const REL_OK = 0.25; // a rate is trusted when its standard error is within 25% of its value (about +/-50% at 95% confidence)
const fam = (m) => (/^gpt|codex/i.test(m) ? m : /opus/i.test(m) ? 'Opus' : /sonnet/i.test(m) ? 'Sonnet' : /haiku/i.test(m) ? 'Haiku' : 'Other');
export const bucketOf = (m) =>`${fam(m.model)}|${m.effort || 'default'}${m.fast ? '|fast' : ''}`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// reset times jitter by a few seconds between readings, so window identity is the reset time rounded to 10 minutes
const rms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? Math.round(t / (10 * MIN)) : null; };
const when = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);

/** Add one reading (ts ms, p5/p7 percent, r5/r7 reset time). Returns true when it was new. */
export function addSample(store, s) {
  const list = store.plan || (store.plan = []);
  if (!s || !num(s.ts) || (num(s.p5) == null && num(s.p7) == null)) return false;
  const acct = s.acct ?? null; // 1 or 2 = which Claude login gave the reading (poller); null = status line or transcript
  const last = list.findLast((x) => (x.acct ?? null) === acct);
  if (last && s.ts - last.ts < 10 * MIN && s.ts >= last.ts && last.p5 === s.p5 && last.p7 === s.p7) { last.seen = s.ts; return false; } // unchanged: nothing to learn, but note it was confirmed (age label)
  if (list.some((x) => x.ts === s.ts && x.p5 === s.p5 && x.p7 === s.p7 && (x.acct ?? null) === acct)) return false;
  list.push({ ts: s.ts, p5: num(s.p5), r5: when(s.r5), p7: num(s.p7), r7: when(s.r7), acct });
  store.version++;
  return true;
}

/** Latest 5 h and weekly readings of one Claude login (acct 1 or 2) as { pct, resetsAt, age }: null when none, older than 6 h (by last confirmation) or past its reset. Untagged readings count as acct 1. */
export function latestPlan(store, now = Date.now(), acct = 1) {
  const list = store.plan || [];
  const win = (p, r) => {
    let x = null;
    for (let i = list.length - 1; i >= 0 && !x; i--) if (list[i][p] != null && (list[i].acct ?? 1) === acct) x = list[i];
    if (!x || now - (x.seen ?? x.ts) > 6 * 60 * MIN || (x[r] != null && x[r] <= now)) return null;
    return { pct: x[p], resetsAt: x[r] ?? null, age: now - (x.seen ?? x.ts) };
  };
  return { plan5h: win('p5', 'r5'), plan7d: win('p7', 'r7') };
}

/** Estimated share of login 1's 5 h or weekly meter for any turn, by its start time. Each window (reset time minus its length) is priced with its last reading. Null when no reading covers the turn. */
export function meterIndex(store, costOf, now = Date.now(), src = 'claude') {
  // Cumulative list-price cost by time, so any window's total is two lookups. Synthetic messages and the other source's are left out
  // (`src` 'codex' reads the Codex plan readings against Codex messages).
  const isMine = (m) => m.model !== '<synthetic>' && (m.src === 'codex') === (src === 'codex');
  const a = [];
  for (const m of store.msgs.values()) if (isMine(m)) a.push([m.ts, costOf(m) || 0]);
  a.sort((x, y) => x[0] - y[0]);
  const cum = [0];
  for (const [, c] of a) cum.push(cum[cum.length - 1] + c);
  const at = (t) => { let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid][0] < t) lo = mid + 1; else hi = mid; } return cum[lo]; };
  const wins = (p, r, len) => {
    const last = new Map();
    for (const x of (src === 'codex' ? store.cxPlan : store.plan) || []) {
      if (x[p] == null || x[r] == null || (x.acct ?? 1) !== 1) continue;
      const k = Math.round(x[r] / MIN) * MIN; // reset times carry millisecond jitter: one window per minute
      const cur = last.get(k);
      if (!cur || x.ts >= cur.ts) last.set(k, { ts: x.ts, pct: x[p] });
    }
    return [...last].map(([end, v]) => ({ start: end - len, end, ts: v.ts, pct: v.pct })).sort((x, y) => x.start - y.start);
  };
  const W = { '5h': wins('p5', 'r5', 5 * 3600e3), '7d': wins('p7', 'r7', 7 * 86400e3) };
  // Windows can overlap (an old reset time still on file next to the current one): the newest start is the meter that was running.
  const winAt = (kind, t) => { const L = W[kind]; for (let i = L.length - 1; i >= 0; i--) if (t >= L[i].start && t < L[i].end) return L[i]; return null; };
  return {
    /** The window that contains now, or null. */
    current: (kind) => W[kind].find((w) => w.start <= now && now < w.end) || null,
    /** { pct, resetsAt } for a turn that started at t and cost c (list price), or null. */
    share(kind, t, c) {
      const w = winAt(kind, t);
      if (!w) return null;
      const den = at(Math.min(w.end, now)) - at(w.start);
      return den > 0 ? { pct: (w.pct * c) / den, resetsAt: w.end } : null;
    },
    /** One session's own part of the meter: per window, the window's latest reading times the session's share of that window's cost
     *  (the same split the Traces turns use), added across windows. Cost that falls in a window with no reading is reported as unreadUsd. Null when none is covered. */
    usage(kind, sid) {
      const mine = new Map();
      let all = 0;
      for (const m of store.msgs.values()) {
        if (m.sid !== sid || !isMine(m)) continue;
        const c = costOf(m) || 0; all += c;
        const w = winAt(kind, m.ts);
        if (w) mine.set(w, (mine.get(w) || 0) + c);
      }
      const wins = []; let covered = 0;
      for (const [w, c] of mine) {
        const den = at(Math.min(w.end, now)) - at(w.start);
        if (!(den > 0)) continue;
        covered += c;
        wins.push({ pct: (w.pct * c) / den, share: c / den, reading: w.pct, ts: w.ts, resetsAt: w.end });
      }
      if (!wins.length) return null;
      wins.sort((x, y) => x.resetsAt - y.resetsAt);
      return { pct: wins.reduce((s, w) => s + w.pct, 0), windows: wins, unreadUsd: Math.max(0, all - covered) };
    },
  };
}

/** Pull readings out of one transcript line (a tool result of get_usage). Called only for lines that mention both words. */
export function samplesFromLine(store, text, ts) {
  let o; try { o = JSON.parse(text); } catch { return; }
  const strs = [];
  const walk = (x) => { if (typeof x === 'string') strs.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
  walk(o.message || o.toolUseResult || o);
  for (const s of strs) {
    if (!s.includes('5-hour limit')) continue;
    let j; try { j = JSON.parse(s); } catch { continue; }
    const w = j && j.plan && j.plan.windows; if (!Array.isArray(w)) continue;
    const a = w.find((x) => /5-hour/i.test(x.label)), b = w.find((x) => /weekly/i.test(x.label));
    addSample(store, { ts: Date.parse(o.timestamp) || ts, p5: a && a.percentUsed, r5: a && a.resetsAt, p7: b && b.percentUsed, r7: b && b.resetsAt });
  }
}

// non-negative least squares by coordinate descent (few columns, few hundred rows)
function nnls(X, y, n) {
  const k = new Array(n).fill(0), r = y.slice();
  const cn = Array.from({ length: n }, (_, j) => X.reduce((a, row) => a + row[j] * row[j], 0));
  for (let it = 0; it < 4000; it++) {
    let moved = 0;
    for (let j = 0; j < n; j++) {
      if (!cn[j]) continue;
      let g = 0; for (let i = 0; i < X.length; i++) g += X[i][j] * r[i];
      const nk = Math.max(0, k[j] + g / cn[j]), d = nk - k[j];
      if (d) { for (let i = 0; i < X.length; i++) r[i] -= X[i][j] * d; k[j] = nk; moved += Math.abs(d); }
    }
    if (moved < 1e-12) break;
  }
  return k;
}

// Gauss-Jordan inverse of a small square matrix; null when singular (columns that cannot be told apart)
function inverse(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c && M[r][c]) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r) => r.slice(n));
}

function analyse(samples, pk, rk, spendIn, keys) {
  const chunks = [];
  const wins = new Map();
  for (const s of samples) {
    if (s[pk] == null || s[rk] == null) continue;
    const w = rms(s[rk]);
    if (!wins.has(w)) wins.set(w, []);
    wins.get(w).push(s);
  }
  for (const list of wins.values()) {
    let i = 0;
    while (i < list.length - 1) {
      let j = i + 1, ok = list[j].ts - list[i].ts <= MAX_GAP;
      while (ok && j < list.length && list[j][pk] - list[i][pk] < MIN_MOVE) {
        j++;
        if (j < list.length && list[j].ts - list[j - 1].ts > MAX_GAP) ok = false;
      }
      if (j >= list.length) break;
      const dp = list[j][pk] - list[i][pk];
      if (ok && dp >= MIN_MOVE) chunks.push({ t0: list[i].ts, t1: list[j].ts, dp });
      i = ok ? j : j;
    }
  }
  const got = chunks.map((c) => spendIn(c.t0, c.t1));
  const spent = got.map((g) => g.s);
  const sumMin = keys.map((k) => got.reduce((a, g) => a + (g.m[k] || 0), 0));
  const spdOf = (k) => got.reduce((a, g) => (g.sp[k] ? mergeSpd(a, g.sp[k]) : a), spd());
  const allSpd = keys.reduce((a, k) => mergeSpd(a, spdOf(k)), spd());
  const allMin = got.reduce((a, g) => a + (g.m['*'] || 0), 0);
  const totalDp = chunks.reduce((a, c) => a + c.dp, 0);
  const sumBucket = keys.map((k) => spent.reduce((a, s) => a + (s[k] || 0), 0));
  const totalUsd = sumBucket.reduce((a, b) => a + b, 0);
  const used = keys.map((_, j) => j).filter((j) => sumBucket[j] > 0);
  const X = spent.map((s) => used.map((j) => s[keys[j]] || 0));
  const y = chunks.map((c) => c.dp);
  const k = used.length && chunks.length ? nnls(X, y, used.length) : [];
  const yh = X.map((row) => row.reduce((a, v, j) => a + v * k[j], 0));
  const my = y.reduce((a, b) => a + b, 0) / (y.length || 1);
  const ssr = y.reduce((a, v, i) => a + (v - yh[i]) ** 2, 0), sst = y.reduce((a, v) => a + (v - my) ** 2, 0);
  // How precisely the meter data pins down each rate: standard error of its fitted coefficient, relative to the coefficient
  const act = used.map((_, ix) => ix).filter((ix) => k[ix] > 1e-9);
  const dof = y.length - act.length;
  const cov = dof > 0 && act.length ? inverse(act.map((a) => act.map((b) => X.reduce((s, row) => s + row[a] * row[b], 0)))) : null;
  const relOf = (ix) => { const a = act.indexOf(ix); return cov && a >= 0 && cov[a][a] > 0 ? Math.sqrt((ssr / dof) * cov[a][a]) / k[ix] : null; };
  const rows = used.map((j, ix) => {
    const [family, effort, fast] = keys[j].split('|');
    const perPct = k[ix] > 1e-9 ? 1 / k[ix] : null;
    const rel = relOf(ix);
    const share = totalUsd ? sumBucket[j] / totalUsd : 0;
    const hours = sumMin[j] / 60; // active hours behind the spend: minutes in which this bucket sent a request
    return { key: keys[j], model: family, effort, fast: !!fast, spend: sumBucket[j], hours, tps: tps(spdOf(keys[j])), hoursPer100: perPct && sumBucket[j] > 0 ? (perPct * 100 * hours) / sumBucket[j] : null, share, perPct, rel, low: rel == null || rel > REL_OK };
  }).sort((a, b) => b.spend - a.spend);
  return { chunks: chunks.length, deltaPct: totalDp, spend: totalUsd, perPct: totalDp ? totalUsd / totalDp : null, hours: allMin / 60, tps: tps(allSpd), hoursPer100: totalDp ? (100 * allMin) / 60 / totalDp : null, r2: sst > 0 ? Math.max(0, 1 - ssr / sst) : null, rows };
}

// Direct measure: between consecutive readings in the same 5 h and weekly window, how far the weekly meter moved
// per point of the 5 h meter. 100 / (that x 100) = full 5 h windows that fit in a week.
function windowsPerWeek(samples) {
  let d5 = 0, d7 = 0, n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.p5 == null || b.p5 == null || a.p7 == null || b.p7 == null) continue;
    if (b.ts - a.ts > MAX_GAP || rms(a.r5) !== rms(b.r5) || rms(a.r7) !== rms(b.r7)) continue;
    const x = b.p5 - a.p5, y = b.p7 - a.p7;
    if (x < 0 || y < 0) continue;
    d5 += x; d7 += y; n++;
  }
  return { pairs: n, d5, d7, weekPctPerWindow: d5 ? (d7 / d5) * 100 : null, windows: d7 ? d5 / d7 : null };
}

/** One source's analysis: its own plan readings against its own messages. */
function analyseSource(samples, msgs, costOf, now) {
  samples = samples.slice().sort((a, b) => a.ts - b.ts);
  msgs = msgs.slice().sort((a, b) => a.ts - b.ts);
  const cost = new Map();
  for (const m of msgs) cost.set(m, costOf(m));
  const keys = [...new Set(msgs.map(bucketOf))];
  const spendIn = (t0, t1) => {
    const out = {}, mins = {}, all = new Set(), sp = {};
    let a = 0, b = msgs.length; // first message with ts > t0
    while (a < b) { const mid = (a + b) >> 1; if (msgs[mid].ts > t0) b = mid; else a = mid + 1; }
    for (let i = a; i < msgs.length && msgs[i].ts <= t1; i++) { const k = bucketOf(msgs[i]); out[k] = (out[k] || 0) + cost.get(msgs[i]); const mn = Math.floor(msgs[i].ts / 60000); (mins[k] ||= new Set()).add(mn); all.add(mn); const l = dur(msgs[i]); if (l) { const q = (sp[k] ||= spd()); q.out += msgs[i].out; q.ms += l; } }
    mins['*'] = all;
    for (const k in mins) mins[k] = mins[k].size;
    return { s: out, m: mins, sp };
  };
  const step = Math.max(1, Math.ceil(samples.length / 500));
  const h5 = analyse(samples, 'p5', 'r5', spendIn, keys), w7 = analyse(samples, 'p7', 'r7', spendIn, keys);
  // The weekly meter moves slowly (whole percents), so its per-model fit is weak (r2 about 0.4) while the 5h one is tight (r2 about 0.96).
  // Both meters charge the same tokens, so each model's weekly $ per 1% = its 5h $ per 1% x one all-models ratio (weekly / 5h).
  const ratio = w7.perPct && h5.perPct ? w7.perPct / h5.perPct : null;
  if (ratio) {
    for (const r of w7.rows) {
      const f = h5.rows.find((x) => x.key === r.key);
      if (!f || !f.perPct) continue;
      r.perPct = f.perPct * ratio; r.rel = f.rel; r.low = f.low;
      r.hoursPer100 = r.spend > 0 ? (r.perPct * 100 * r.hours) / r.spend : null;
    }
  }
  return {
    now, readings: samples.length, first: samples.length ? samples[0].ts : null, last: samples.length ? samples[samples.length - 1].ts : null,
    series: samples.filter((_, i) => i % step === 0).map((s) => ({ t: s.ts, p5: s.p5, r5: s.r5, p7: s.p7 })),
    perWeek: windowsPerWeek(samples),
    h5, w7,
  };
}

const WEEK_SLOTS = 7 * 24 * 6;
/** Accounts reset their weekly meters at different times of the week, so the reset time-of-week (10-minute slots) names the account. */
export const acctOf = (r7) => { const r = rms(r7); return r == null ? null : ((r % WEEK_SLOTS) + WEEK_SLOTS) % WEEK_SLOTS; };

/**
 * One entry per Claude account (weekly meter), from its latest plan reading. A reset that has passed counts as full (100) until a new reading arrives.
 */
export function accountLatest(samples, now) {
  const latest = new Map();
  for (const s of samples.filter((x) => x.p7 != null && acctOf(x.r7) != null).sort((a, b) => a.ts - b.ts)) latest.set(acctOf(s.r7), s);
  return [...latest.values()].map((s) => {
    const passed = s.r7 <= now;
    return { resetsAt: s.r7, latestPct: s.p7, meterLeft: passed ? 100 : 100 - s.p7, passed, ageH: (now - (s.seen ?? s.ts)) / 3600e3 };
  }).sort((a, b) => a.resetsAt - b.resetsAt);
}

/** A weekly reading older than this is not live, so it is never added to the pool (the poll runs every minute). */
const LIVE_H = 0.25;

/**
 * Weekly pool across accounts (max 200% with two): each account adds its meter % left; a reset refills that account to 100.
 * `resets` = pool after each upcoming reset, assuming no further use. If any account has no live reading, `now` is null
 * and `stale` lists those accounts: a stale reading is never counted.
 */
function poolOf(accts) {
  const stale = accts.filter((x) => !x.passed && x.ageH > LIVE_H).map((x) => x.resetsAt);
  if (stale.length) return { now: null, stale, resets: [] };
  const left = accts.reduce((a, x) => a + x.meterLeft, 0);
  return {
    now: left,
    stale: [],
    resets: accts.filter((x) => !x.passed).map((x) => ({ resetsAt: x.resetsAt, pool: accts.reduce((a, y) => a + (y.resetsAt <= x.resetsAt ? 100 : y.meterLeft), 0) })),
  };
}

const WEEK_MS = 7 * 24 * 3600e3;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = ['Opus', 'Sonnet', 'Haiku'];

/** Every weekly reset (ms) of each account in the next `weeks` weeks, earliest first. */
function resetTimes(accts, now, weeks = 8) {
  const out = [];
  for (const a of accts) {
    let t = a.resetsAt;
    while (t <= now) t += WEEK_MS;
    for (; t <= now + weeks * WEEK_MS; t += WEEK_MS) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

/**
 * When the weekly pool reaches 0 under continuous use at `pctPerH` % of a meter per hour. Each reset adds 100.
 * Returns ms, or Infinity if it does not reach 0 before the last reset in `resets`.
 */
function zeroAt(pool, pctPerH, resets, now) {
  let t = now, left = pool;
  for (const r of resets) {
    const z = t + (left / pctPerH) * 3600e3;
    if (z <= r) return z;
    left += 100 - (pctPerH * (r - t)) / 3600e3;
    t = r;
  }
  return Infinity;
}

/**
 * Weekly hours per 100% for one model and effort. Where the weekly meter has no usable reading (too few whole-percent steps),
 * estimate it from the 5h rate x the all-model weekly-to-5h $ ratio. `est` marks the estimate.
 */
function weeklyHours(model, effort, out) {
  const w = out.w7.rows.find((x) => x.model === model && x.effort === effort && !x.fast);
  if (w?.hoursPer100) return { h: w.hoursPer100, est: false, low: w.low };
  const f = out.h5.rows.find((x) => x.model === model && x.effort === effort && !x.fast);
  if (!f?.hoursPer100 || !out.w7.perPct || !out.h5.perPct) return null;
  return { h: f.hoursPer100 * (out.w7.perPct / out.h5.perPct), est: true, low: true };
}

/** Runway grid: per Claude model and effort, hours of continuous use until the weekly pool reaches 0. */
function runwayOf(pool, out, accts, now) {
  const resets = resetTimes(accts, now);
  const next = resets[0];
  return {
    nextReset: next,
    efforts: EFFORTS,
    rows: CLAUDE_MODELS.map((model) => ({
      model,
      cells: EFFORTS.map((effort) => {
        const w = weeklyHours(model, effort, out);
        if (!w) return { effort, hours: null, after: false, low: false, est: false };
        const z = zeroAt(pool, 100 / w.h, resets, now);
        return { effort, hours: Number.isFinite(z) ? (z - now) / 3600e3 : null, never: !Number.isFinite(z), after: z > next, low: w.low, est: w.est };
      }),
    })),
  };
}

/** Claude readings (status line, get_usage) against Claude messages; Codex rate_limits readings against Codex messages (`cx`). `accounts`, `pool` and `runway`: weekly meters per Claude account. */
export function planValue(store, costOf, now = Date.now()) {
  const all = [...store.msgs.values()].filter((m) => m.model !== '<synthetic>');
  const claude = all.filter((m) => m.src !== 'codex');
  const out = analyseSource(store.plan || [], claude, costOf, now);
  out.accounts = accountLatest(store.plan || [], now);
  out.pool = poolOf(out.accounts);
  out.runway = out.accounts.length && out.pool.now != null ? runwayOf(out.pool.now, out, out.accounts, now) : null;
  const cxs = (store.cxPlan || []).map((x) => ({ ts: x.ts, p5: x.p5, r5: x.r5, p7: x.p7, r7: x.r7 }));
  out.cx = cxs.length ? { ...analyseSource(cxs, all.filter((m) => m.src === 'codex'), costOf, now), plan: [...store.cxPlan].reverse().find((x) => x.plan)?.plan || '' } : null;
  return out;
}
