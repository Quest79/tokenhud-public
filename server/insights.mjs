// M7/M8: alerts (rules over recent activity) and the summary/insights report. Pure functions over the Store.
import { costOf, winOf } from './stats.mjs';
import { spd, addSpd, tps, msgTps, speedStats } from './speed.mjs';
import { getSettings } from './settings.mjs';
import { bySession, used, titleOf, shortModel, stateOf, traceList, sessionWatch } from './pages.mjs';
import { meterIndex } from './planvalue.mjs';

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const real = (m) => m.model !== '<synthetic>';
const hit = (a) => { const t = a.in + a.cr + a.cw; return t ? a.cr / t : 0; };
const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

function spendWindows(store, now) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const wk = d0.getTime() - ((d0.getDay() + 6) % 7) * DAY; // Monday
  const mo = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime();
  const w = { day: 0, week: 0, month: 0, prior: new Array(7).fill(0), dayStart: d0.getTime() };
  for (const m of store.msgs.values()) {
    if (!real(m)) continue;
    const c = costOf(m);
    if (m.ts >= d0.getTime()) w.day += c;
    if (m.ts >= wk) w.week += c;
    if (m.ts >= mo) w.month += c;
    const i = Math.floor((d0.getTime() - m.ts) / DAY); // days before today (i>=1)
    if (m.ts < d0.getTime() && i >= 0 && i < 7) w.prior[i] += c;
  }
  return w;
}

/** @param feed optional status-line feed snapshot ({fresh, plan5h, plan7d, cache}) for M8 rules */
export function alerts(store, now = Date.now(), feed = null) {
  const S = getSettings(), T = S.thresholds, B = S.budgets;
  const rules = [], list = [];
  const rule = (id, label, threshold, value, state, note = '') => rules.push({ id, label, threshold, value, state, note });
  const fire = (a) => list.push({ ts: now, ...a });

  // budgets
  const sp = spendWindows(store, now);
  for (const [k, label, spent] of [['dailyUsd', 'Daily budget', sp.day], ['weeklyUsd', 'Weekly budget', sp.week], ['monthlyUsd', 'Monthly budget', sp.month]]) {
    const cap = B[k];
    if (!cap) { rule(k, label, 'off', usd(spent), 'off', 'Set a budget in Settings'); continue; }
    const p = spent / cap;
    const st = p >= 1 ? 'crit' : p >= 0.8 ? 'warn' : 'ok';
    rule(k, label, usd(cap), `${usd(spent)} (${Math.round(p * 100)}%)`, st);
    if (st !== 'ok') fire({ id: k, sev: st, kind: 'budget', title: `${label} ${st === 'crit' ? 'exceeded' : 'at ' + Math.round(p * 100) + '%'}`, detail: `${usd(spent)} of ${usd(cap)} (API-rate estimate)`, link: '#/cost' });
  }
  if (B.monthlyUsd) {
    const nd = new Date(now), dim = new Date(nd.getFullYear(), nd.getMonth() + 1, 0).getDate();
    const avg = sp.prior.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    const proj = sp.month + avg * (dim - nd.getDate());
    const st = proj > B.monthlyUsd * 1.0 && sp.month < B.monthlyUsd ? 'warn' : 'ok';
    rule('forecast', 'Month forecast', usd(B.monthlyUsd), `${usd(proj)} projected`, st);
    if (st === 'warn') fire({ id: 'forecast', sev: 'warn', kind: 'budget', title: 'On track to pass the monthly budget', detail: `Projected ${usd(proj)} vs ${usd(B.monthlyUsd)} at the 7-day pace`, link: '#/cost' });
  }

  // cost anomaly: today vs trailing 6-day average
  {
    const base = sp.prior.slice(1, 7).reduce((a, b) => a + b, 0) / 6;
    const hoursIn = Math.max(1, (now - sp.dayStart) / HOUR);
    const pace = sp.day * (24 / Math.max(hoursIn, 6)); // don't over-extrapolate early in the day
    const x = base > 0.5 ? pace / base : 0;
    const st = x >= T.anomalyX && sp.day > 2 ? 'warn' : 'ok';
    rule('anomaly', 'Spend spike', `${T.anomalyX}x daily avg`, base > 0.5 ? `${x.toFixed(1)}x (${usd(sp.day)} today)` : 'no baseline', st);
    if (st === 'warn') fire({ id: 'anomaly', sev: 'warn', kind: 'cost', title: `Spend is running ${x.toFixed(1)}x your daily average`, detail: `${usd(sp.day)} so far today vs ${usd(base)}/day over the last 6 days`, link: '#/cost' });
  }

  // context pressure per live/idle session
  const sess = bySession(store);
  let worst = 0, worstSid = '';
  const ctxHits = [];
  for (const [sid, arr] of sess) {
    const last = arr[arr.length - 1].ts;
    if (stateOf(now - last) === 'done') continue;
    const main = arr.filter((m) => !m.side); if (!main.length) continue;
    let peak = 0; for (const m of main) peak = Math.max(peak, used(m));
    const win = winOf(peak), p = (used(main[main.length - 1]) / win) * 100;
    if (p > worst) { worst = p; worstSid = sid; }
    if (p >= T.ctxPct) ctxHits.push({ sid, p, win });
  }
  rule('ctx', 'Context window', `${T.ctxPct}%`, worstSid ? `${Math.round(worst)}% (${titleOf(store, worstSid)})` : 'no active session', ctxHits.length ? (worst >= 95 ? 'crit' : 'warn') : 'ok');
  for (const h of ctxHits) fire({ id: 'ctx:' + h.sid, sev: h.p >= 95 ? 'crit' : 'warn', kind: 'context', title: `Context ${Math.round(h.p)}% full`, detail: `${titleOf(store, h.sid)}: compact or start a fresh session soon`, link: '#/context/' + h.sid });

  // live session watch: cache expiry, unexpected whole-conversation rewrites, auto-compact forecast (all measured, nothing guessed)
  {
    const W = sessionWatch(store, now), kt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'K');
    const worst = { c: null, k: null };
    for (const x of W.sessions) {
      if (x.last < now - 6 * HOUR) continue;
      const link = '#/context/' + x.sid, cost = `${kt(x.cur)} is about ${x.ratio.toFixed(1)}x what a brand new session writes (${kt(W.startup)})`;
      if (x.risk) {
        if (x.risk === 'expiring') { worst.c = worst.c || x; fire({ id: 'cache:' + x.sid, sev: 'warn', kind: 'cache', title: `Cache expires in ${Math.max(1, Math.round(x.cache.leftMin))} min: ${x.title}`, detail: `Send a message before then to keep it warm. If you are stopping, ask for a handoff note now: it is cheap while warm and costs a full rewrite after. If it lapses, the next message rewrites the whole conversation (${cost}). ${x.lapsedAdvice ? x.lapsedAdvice.head + ': ' + x.lapsedAdvice.say : ''}`, link }); }
        else if (x.risk === 'cold' && x.advice && x.advice.verdict !== 'resume') { worst.c = x; fire({ id: 'cold:' + x.sid, sev: 'warn', kind: 'cache', title: `Cache lapsed: ${x.title}`, detail: `Idle for ${Math.round(x.cache.coldMin + x.cache.ttlMin)} min, so the next message rewrites the whole conversation (${cost}). ${x.advice ? x.advice.head + ': ' + x.advice.say : ''}`, link }); }
      }
      if (x.rewrite) fire({ id: 'rewrite:' + x.sid + ':' + x.rewrite.ts, ts: x.rewrite.ts, sev: 'warn', kind: 'cache', title: `Whole conversation rewritten: ${kt(x.rewrite.tokens)} tokens`, detail: `${x.title}: the cache was still valid, but ${x.rewrite.cause}. Changing these mid-session makes the next request pay to rewrite everything. Do it at a session boundary.`, link });
      if (x.compactSoon) { worst.k = x; fire({ id: 'compact:' + x.sid, sev: x.pct >= 90 ? 'crit' : 'warn', kind: 'context', title: `Auto-compact is close: ${x.title}`, detail: `${Math.round(x.pct)}% of the window is full${x.promptsToCompact != null ? `, about ${x.promptsToCompact} prompt${x.promptsToCompact === 1 ? '' : 's'} left at +${kt(x.perPrompt)} each` : ''}. Compacting rewrites everything once and keeps only a summary${x.compactions ? `; this session was already compacted ${x.compactions} time${x.compactions === 1 ? '' : 's'}` : ''}. Finish the step, then hand off to a new session.`, link });
      }
    }
    rule('cachelife', 'Cache rewrite cost', `${T.rewriteX}x a new session`, worst.c ? `${worst.c.title}: ${worst.c.cache.warm ? 'expires soon' : 'cold'}` : 'none at risk', worst.c ? 'warn' : 'ok');
    rule('compact', 'Auto-compact forecast', '3 prompts', worst.k ? `${worst.k.title}: ${Math.round(worst.k.pct)}% full` : 'none close', worst.k ? (worst.k.pct >= 90 ? 'crit' : 'warn') : 'ok');
  }

  // cache hit rate, last 24h (needs a minimum of traffic)
  {
    const a = { in: 0, cr: 0, cw: 0 }; let n = 0;
    for (const m of store.msgs.values()) if (real(m) && m.ts >= now - DAY) { a.in += m.in; a.cr += m.cr; a.cw += m.cw; n++; }
    const h = hit(a) * 100;
    const st = n >= 20 && h < T.cacheHitPct ? 'warn' : 'ok';
    rule('cache', 'Cache hit rate (24h)', `>= ${T.cacheHitPct}%`, n >= 20 ? `${h.toFixed(1)}%` : 'not enough data', st);
    if (st === 'warn') fire({ id: 'cache', sev: 'warn', kind: 'cache', title: `Cache hit rate fell to ${h.toFixed(0)}%`, detail: 'More input is being re-billed at the uncached rate. Long pauses (cache expiry) or changed prompts cause this.', link: '#/context' });
  }

  // slow turns, last 24h
  {
    const slow = [];
    for (const m of store.msgs.values()) if (real(m) && !m.side && m.ts >= now - DAY && m.startTs && (m.ts - m.startTs) / 1000 >= T.slowTurnSec) slow.push(m);
    slow.sort((a, b) => (b.ts - b.startTs) - (a.ts - a.startTs));
    rule('slow', 'Slow request', `> ${T.slowTurnSec}s`, slow.length ? `${slow.length} in 24h` : 'none', slow.length ? 'warn' : 'ok');
    for (const m of slow.slice(0, 3)) fire({ id: 'slow:' + m.id, ts: m.ts, sev: 'warn', kind: 'latency', title: `Request took ${Math.round((m.ts - m.startTs) / 1000)}s`, detail: `${titleOf(store, m.sid)} on ${shortModel(m.model)}`, link: `#/traces/${m.sid}/${m.ts}` });
  }

  // tool error rate per tool, last 24h
  {
    const g = new Map();
    for (const t of store.tools.values()) if (t.ts >= now - DAY) { const x = g.get(t.name) || { name: t.name, n: 0, e: 0 }; x.n++; if (t.err) x.e++; g.set(t.name, x); }
    const bad = [...g.values()].filter((x) => x.n >= 5 && (x.e / x.n) * 100 >= T.toolErrorPct).sort((a, b) => b.e / b.n - a.e / a.n);
    rule('toolerr', 'Tool error rate (24h)', `< ${T.toolErrorPct}%`, bad.length ? `${bad[0].name} ${Math.round((bad[0].e / bad[0].n) * 100)}%` : 'ok', bad.length ? 'warn' : 'ok');
    for (const x of bad.slice(0, 3)) fire({ id: 'toolerr:' + x.name, sev: 'warn', kind: 'tools', title: `${x.name} failing ${Math.round((x.e / x.n) * 100)}% of calls`, detail: `${x.e} of ${x.n} calls errored in the last 24h`, link: '#/tools' });
  }

  // plan limits (only when the status-line feed is connected)
  if (feed && feed.fresh && feed.plan5h) {
    for (const [id, label, w] of [['plan5h', '5-hour plan limit', feed.plan5h], ['plan7d', 'Weekly plan limit', feed.plan7d]]) {
      if (!w || w.pct == null) continue;
      const st = w.pct >= 95 ? 'crit' : w.pct >= 80 ? 'warn' : 'ok';
      rule(id, label, '80% / 95%', `${Math.round(w.pct)}%`, st);
      if (st !== 'ok') fire({ id, sev: st, kind: 'plan', title: `${label} at ${Math.round(w.pct)}%`, detail: w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : '', link: '#/overview' });
    }
  } else rule('plan', 'Plan limits', '80% / 95%', 'feed not connected', 'off', 'Connect the status line in Settings');

  // one turn, or one session in the current window, taking a large share of the 5 h meter (estimate, see meterIndex)
  {
    const cur = meterIndex(store, costOf, now).current('5h');
    const L = traceList(store, now, Infinity), tr = L.traces.filter((t) => t.pct5 != null), bar = L.bar, typical = L.typical;
    const hot = tr.filter((t) => t.ts >= now - DAY && t.spike).sort((a, b) => b.pct5 - a.pct5);
    rule('turnmeter', 'One turn, 5-hour meter', `${Math.round(bar)}%+ (est.)`, hot.length ? `${Math.round(hot[0].pct5)}% (${hot[0].title})` : 'none in 24 h', hot.length ? 'warn' : 'ok', typical ? `Typical turn ${typical.toFixed(1)}%` : 'Typical turn not known yet');
    for (const t of hot.slice(0, 3)) fire({ id: 'turnmeter:' + t.sid + ':' + t.ts, ts: t.ts, sev: 'warn', kind: 'meter', title: `One turn used ${Math.round(t.pct5)}% of the 5-hour meter`, detail: `${t.title}: ${t.why}`, link: `#/traces/${t.sid}/${t.ts}` });
    if (cur) {
      const by = new Map();
      for (const t of tr) if (t.ts >= cur.start) { const x = by.get(t.sid) || { sid: t.sid, title: t.title, pct: 0, n: 0, top: t }; x.pct += t.pct5; x.n++; if (t.pct5 > x.top.pct5) x.top = t; by.set(t.sid, x); }
      const top = [...by.values()].sort((a, b) => b.pct - a.pct);
      const lead = top[0];
      rule('sessmeter', 'Session, 5-hour meter', `${T.meterSessionPct}%+ (est.)`, lead ? `${Math.round(lead.pct)}% (${lead.title})` : 'no turns this window', lead && lead.pct >= T.meterSessionPct ? 'warn' : 'ok');
      for (const x of top.filter((x) => x.pct >= T.meterSessionPct).slice(0, 3)) fire({ id: 'sessmeter:' + x.sid, sev: 'warn', kind: 'meter', title: `${x.title} is using ${Math.round(x.pct)}% of the 5-hour meter`, detail: `${x.n} turns this window · biggest ${Math.round(x.top.pct5)}%: ${x.top.why}`, link: '#/sessions/' + x.sid });
    } else rule('sessmeter', 'Session, 5-hour meter', `${T.meterSessionPct}%+ (est.)`, 'no reading for this window', 'off', 'Needs plan polling on (Settings)');
  }

  const order = { crit: 0, warn: 1, info: 2 };
  list.sort((a, b) => order[a.sev] - order[b.sev] || b.ts - a.ts);

  // 24 hourly buckets: health strip + cost bars (spikes flagged against the median of busy hours)
  const h0 = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => ({ t: h0 + i * HOUR, req: 0, tools: 0, err: 0, cost: 0 }));
  for (const m of store.msgs.values()) { if (!real(m)) continue; const i = Math.floor((m.ts - h0) / HOUR); if (i >= 0 && i < 24) { hours[i].req++; hours[i].cost += costOf(m); } }
  const incidents = [];
  for (const t of store.tools.values()) {
    const i = Math.floor((t.ts - h0) / HOUR);
    if (i >= 0 && i < 24) { hours[i].tools++; if (t.err) { hours[i].err++; incidents.push({ ts: t.ts, sev: 'warn', title: `${t.name} call failed`, detail: titleOf(store, t.sid), link: '#/sessions/' + t.sid }); } }
  }
  const busy = hours.map((h) => h.cost).filter((c) => c > 0).sort((a, b) => a - b);
  const med = busy.length ? busy[Math.floor(busy.length / 2)] : 0;
  for (const h of hours) h.spike = med > 0.5 && h.cost >= med * T.anomalyX;
  for (const m of store.msgs.values()) {
    if (real(m) && !m.side && m.ts >= h0 && m.startTs && (m.ts - m.startTs) / 1000 >= T.slowTurnSec) incidents.push({ ts: m.ts, sev: 'crit', title: `Request took ${Math.round((m.ts - m.startTs) / 1000)}s`, detail: titleOf(store, m.sid), link: `#/traces/${m.sid}/${m.ts}` });
  }
  for (const h of hours) if (h.spike) incidents.push({ ts: h.t + HOUR / 2, sev: 'warn', title: `Spend spike: ${usd(h.cost)} in one hour`, detail: `${(h.cost / med).toFixed(1)}x the typical busy hour`, link: '#/cost' });
  incidents.sort((a, b) => b.ts - a.ts);

  // error budget over 7 days: tool success rate against the target in Settings
  let calls = 0, errs = 0;
  for (const t of store.tools.values()) if (t.ts >= now - 7 * DAY) { calls++; if (t.err) errs++; }
  const allowed = calls * (1 - T.errorTargetPct / 100);
  const budget = { calls, errs, target: T.errorTargetPct, success: calls ? (1 - errs / calls) * 100 : 100, allowed, remainingPct: allowed > 0 ? Math.max(0, (1 - errs / allowed) * 100) : (errs ? 0 : 100) };

  return { now, active: list, rules, hours, median: med, incidents: incidents.slice(0, 14), budget, counts: { crit: list.filter((a) => a.sev === 'crit').length, warn: list.filter((a) => a.sev === 'warn').length } };
}

/** Summary/insights report for the last 7 days vs the 7 days before, plus 28-day patterns. */
export function summary(store, now = Date.now()) {
  const cur = { cost: 0, req: 0, out: 0, tot: 0, in: 0, cr: 0, cw: 0, sess: new Set(), tools: 0, err: 0, sp: spd() };
  const prev = { cost: 0, req: 0, out: 0, tot: 0, in: 0, cr: 0, cw: 0, sess: new Set(), tools: 0, err: 0, sp: spd() };
  const byModel = new Map(), bySess = new Map(), hours = new Array(24).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const turns = [];
  for (const m of store.msgs.values()) {
    if (!real(m)) continue;
    const age = now - m.ts, c = costOf(m);
    if (age < 28 * DAY) { const d = new Date(m.ts); heat[(d.getDay() + 6) % 7][d.getHours()] += m.out + m.in + m.cw; }
    const tgt = age < 7 * DAY ? cur : age < 14 * DAY ? prev : null;
    if (!tgt) continue;
    tgt.cost += c; tgt.req++; tgt.out += m.out; tgt.in += m.in; tgt.cr += m.cr; tgt.cw += m.cw; tgt.tot += m.in + m.out + m.cr + m.cw; tgt.sess.add(m.sid); addSpd(tgt.sp, m);
    if (tgt === cur) {
      hours[new Date(m.ts).getHours()] += c;
      const k = shortModel(m.model); const x = byModel.get(k) || { name: k, cost: 0, req: 0, sp: spd() }; x.cost += c; x.req++; addSpd(x.sp, m); byModel.set(k, x);
      const s = bySess.get(m.sid) || { sid: m.sid, cost: 0, req: 0, sp: spd() }; s.cost += c; s.req++; addSpd(s.sp, m); bySess.set(m.sid, s);
      turns.push({ sid: m.sid, ts: m.ts, cost: c, tps: msgTps(m), out: m.out, model: shortModel(m.model), ctx: used(m), tools: m.tools.length });
    }
  }
  const byTool = new Map();
  for (const t of store.tools.values()) {
    const age = now - t.ts, tgt = age < 7 * DAY ? cur : age < 14 * DAY ? prev : null;
    if (!tgt) continue;
    tgt.tools++; if (t.err) tgt.err++;
    if (tgt === cur) { const x = byTool.get(t.name) || { name: t.name, calls: 0, err: 0 }; x.calls++; if (t.err) x.err++; byTool.set(t.name, x); }
  }
  const fin = (p) => ({ cost: p.cost, req: p.req, out: p.out, tot: p.tot, sessions: p.sess.size, tools: p.tools, err: p.err, hit: hit(p), tps: tps(p.sp), sx: speedStats(p.sp), tokPerUsd: p.cost > 0 ? p.tot / p.cost : 0 });
  const A = fin(cur), P = fin(prev);
  const top = (m, n) => [...m.values()].sort((a, b) => b.cost - a.cost).slice(0, n).map(({ sp, ...x }) => ({ ...x, tps: tps(sp), sx: speedStats(sp) }));
  turns.sort((a, b) => b.cost - a.cost);
  const topSess = top(bySess, 1)[0];
  const topModel = top(byModel, 1)[0];
  const topTool = [...byTool.values()].sort((a, b) => b.calls - a.calls)[0];
  const busyH = hours.indexOf(Math.max(...hours));

  const ins = [];
  const dpct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  const dc = dpct(A.cost, P.cost);
  if (A.req) ins.push({ hue: dc != null && dc > 25 ? 'amber' : 'green', text: dc == null ? `You spent ${usd(A.cost)} (API-rate estimate) over the last 7 days.` : `Spend is ${dc >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(dc))}% on the previous week: ${usd(A.cost)} vs ${usd(P.cost)}.` });
  if (topSess && A.cost > 0) ins.push({ hue: 'blue', text: `"${titleOf(store, topSess.sid)}" drove ${Math.round((topSess.cost / A.cost) * 100)}% of the week's cost across ${topSess.req} requests.` });
  if (topModel && A.cost > 0 && byModel.size > 1) ins.push({ hue: 'purple', text: `${topModel.name} accounts for ${Math.round((topModel.cost / A.cost) * 100)}% of spend. Routing routine steps to a smaller model is the biggest saving.` });
  if (A.req > 20) ins.push({ hue: A.hit >= 0.9 ? 'green' : A.hit >= 0.75 ? 'amber' : 'red', text: `Cache hit rate is ${(A.hit * 100).toFixed(1)}%${A.hit >= 0.9 ? ': prompt caching is working well.' : '. Long idle gaps let the cache expire and re-bill the context.'}` });
  if (A.tools > 10) { const er = (A.err / A.tools) * 100; ins.push({ hue: er > 5 ? 'amber' : 'green', text: `${A.tools.toLocaleString()} tool calls, ${er.toFixed(1)}% failed${topTool ? `; most used is ${topTool.name} (${topTool.calls.toLocaleString()})` : ''}.` }); }
  if (A.req > 20 && hours[busyH] > 0) ins.push({ hue: 'grey', text: `Busiest hour is ${String(busyH).padStart(2, '0')}:00, carrying ${Math.round((hours[busyH] / Math.max(A.cost, 1e-9)) * 100)}% of spend.` });
  if (turns[0]) ins.push({ hue: 'amber', text: `Most expensive request: ${usd(turns[0].cost)} on ${turns[0].model} with ${Math.round(turns[0].ctx / 1000)}k tokens of context.` });

  return {
    now, week: A, prev: P, insights: ins,
    topSessions: top(bySess, 5).map((x) => ({ ...x, title: titleOf(store, x.sid) })),
    topModels: top(byModel, 5),
    topTools: [...byTool.values()].sort((a, b) => b.calls - a.calls).slice(0, 6),
    expensive: turns.slice(0, 8).map((t) => ({ ...t, title: titleOf(store, t.sid) })),
    hours, heat,
  };
}
