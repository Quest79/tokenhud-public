// Overview: live KPIs, signature chart, context ring, token mix, tools, sessions, activity. Real data only.
import { Zap, Activity, Database, Coins, Layers, Sigma, TriangleAlert, ArrowUp, ArrowDown, ChevronDown, ChevronRight } from 'lucide';
import type { ECharts } from 'echarts/core';
import { speedRow, clockTime } from './kit';
import { mountCompare } from './compare';
import { icon, kpi, sparkMount, deltaChip, ring, seg, wireSeg, card, pill, inlineBar, bar } from '../ui';
import { zc } from '../theme';
import { init, signatureOption, signatureTimeOption, stackedBarsOption, donutOption, C, fmtNum } from '../charts';
import { getOverview, getJson, getSrc, postJson, type Overview, type StatusFeed } from '../api';
import { liveLoop } from '../live';
import { calm, ease, frameLoop, windowPts, Eased, EasedSeries } from '../anim';
import { tokps, compact, compactStr, int, money, dur, ago, hms, bucketLabel, pctDelta, esc } from '../format';

const RANGES = ['60s', '5m', '1h', '6h', '24h', '7d'];
const RANGE_LABEL: Record<string, string> = { '60s': 'last 60 seconds', '5m': 'last 5 minutes', '1h': 'last hour', '6h': 'last 6 hours', '24h': 'last 24 hours', '7d': 'last 7 days' };
const HUE = { cyan: zc('#00d0f8'), purple: zc('#9058f8'), green: zc('#00d890'), amber: zc('#f0a038') } as const;

export function renderOverview(root: HTMLElement): () => void {
  let range = localStorage.getItem('th.range') || '1h';
  if (!RANGES.includes(range)) range = '1h';
  let data: Overview | null = null;
  let charts: ECharts[] = [];
  let sig: ECharts | null = null, bars: ECharts | null = null, donut: ECharts | null = null;
  let dead = false;

  root.innerHTML = `
  <div class="hstack" style="justify-content:space-between;align-items:flex-end">
    <div><h1 class="page-title">Overview</h1><p class="page-sub" id="ov-sub">Loading your Claude Code activity…</p></div>
    <div class="hstack" style="gap:12px"><a class="btn ghost" href="#/summary" style="text-decoration:none">Weekly summary</a><span class="live" id="ov-live"><span class="dot ping"></span>Live</span>${seg(['60S', '5M', '1H', '6H', '24H', '7D'], RANGES.indexOf(range))}</div>
  </div>

  <div id="ov-alert"></div>

  <div class="row" id="ov-plan" data-sec="plan" data-title="Plan limits">
    <form class="c12 hstack" id="ov-manual" style="gap:10px;align-items:center;flex-wrap:wrap">
      <label for="ov-manual-pct" style="color:var(--text-2)">Set your 5-hour %</label>
      <input id="ov-manual-pct" type="number" min="0" max="100" step="1" placeholder="e.g. 92" style="width:90px;background:rgba(6,22,38,.9);color:#fff;border:1px solid var(--border);border-radius:6px;padding:5px 7px;font:inherit">
      <button class="btn" type="submit">Save</button>
      <span id="ov-manual-msg" style="color:var(--text-3);font-size:12px"></span>
    </form>
    <div id="ov-plan-cards" style="display:contents"></div>
  </div>
  <div class="row" id="ov-left" data-sec="left" data-title="Time left in the 5h window"></div>

  <div class="row" id="ov-kpis" data-sec="kpis" data-title="Key numbers">
    <div class="c2" data-k="out">${kpi({ label: 'Output tokens', value: '–', series: [0, 0], chip: { svg: icon(Zap, 20) }, id: 'k-out' })}</div>
    <div class="c2" data-k="req">${kpi({ label: 'Requests', value: '–', series: [0, 0], color: 'purple', chip: { svg: icon(Activity, 20), hue: 'purple' }, id: 'k-req' })}</div>
    <div class="c2" data-k="tot">${kpi({ label: 'Tokens processed', value: '–', series: [0, 0], chip: { svg: icon(Sigma, 20), hue: 'blue' }, id: 'k-tot' })}</div>
    <div class="c2" data-k="hit">${kpi({ label: 'Cache hit rate', value: '–', series: [0, 0], color: 'green', chip: { svg: icon(Database, 20), hue: 'green' }, id: 'k-hit' })}</div>
    <div class="c2" data-k="cost">${kpi({ label: 'Est. cost (API rates)', value: '–', series: [0, 0], color: 'amber', chip: { svg: icon(Coins, 20), hue: 'cyan' }, id: 'k-cost' })}</div>
    <div class="c2" data-k="live">${kpi({ label: 'Live sessions', value: '–', color: 'purple', chip: { svg: icon(Layers, 20), hue: 'purple' }, id: 'k-live' })}</div>
  </div>

  <div id="ov-speed" data-sec="speed" data-title="Output speed"></div>

  <div class="row" data-sec="board" data-title="Model leaderboard"><div class="c12" id="ov-compare"></div></div>

  <div class="row" data-sec="flow" data-title="Throughput and usage">
    <div class="c8">${card('Requests & Output Throughput', `<div class="chart" id="ov-sig" style="height:300px"></div><div class="legend"><span><i style="background:${C.cyan};color:${C.cyan}"></i>Requests</span><span><i style="background:${C.purple};color:${C.purple}"></i>Output tokens / min</span></div>`)}</div>
    <div class="c4">${card('Usage so far', '<div class="stack" style="gap:16px" id="ov-local"></div>', { right: '<span id="ov-planpill"></span>' })}</div>
  </div>

  <div class="row" data-sec="mix" data-title="Context, token mix, hourly burn">
    <div class="c4">${card('Context window', '<div id="ov-ctx"></div>', { sub: 'Most recently active session' })}</div>
    <div class="c4">${card('Token mix', '<div class="chart" id="ov-donut" style="height:230px"></div><div class="legend" id="ov-mixleg"></div>')}</div>
    <div class="c4">${card('Hourly burn (24 h)', '<div class="chart" id="ov-bars" style="height:230px"></div><div class="legend"><span><i style="background:' + zc('#26d4f8') + ';color:' + zc('#26d4f8') + '"></i>Input + cache write</span><span><i style="background:' + zc('#b48cff') + ';color:' + zc('#b48cff') + '"></i>Output</span></div>')}</div>
  </div>

  <div class="row" data-sec="tools" data-title="Tools and sessions">
    <div class="c5">${card('Top tools', '<div id="ov-tools"></div>')}</div>
    <div class="c7">${card('Sessions (last 24 h)', '<div id="ov-sessions"></div>')}</div>
  </div>

  <div class="row" data-sec="feed" data-title="Live activity and prompt cache">
    <div class="c8">${card('Live activity', '<div class="log" id="ov-feed"></div>', { right: '<span class="live" id="ov-live2"><span class="dot ping"></span>Live</span>' })}</div>
    <div class="c4">${card('Prompt cache', '<div id="ov-cache"></div>', { right: '<span id="ov-cachepill"></span>' })}</div>
  </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector('#' + id) as T;
  wireSeg(root, (i) => { range = RANGES[i]; localStorage.setItem('th.range', range); fresh = true; loop.kick(); });
  $('ov-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('ov-manual-pct'), msg = $('ov-manual-msg');
    const v = inp.value.trim() === '' ? NaN : Number(inp.value);
    if (!(v >= 0 && v <= 100)) { msg.textContent = 'Enter a number from 0 to 100'; return; }
    try {
      await postJson('/api/plan/manual', { p5: v });
      inp.value = ''; msg.textContent = `Saved ${v}%`;
      loop.kick();
    } catch (err) { msg.textContent = `Not saved (HTTP ${(err as Error).message})`; }
  });

  const mk = (id: string, opt: any) => { const c = init($(id), opt); charts.push(c); return c; };
  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  sig = mk('ov-sig', signatureOption({ x: [''], a: { name: 'Requests', data: [0] }, b: { name: 'Output tokens / min', data: [0], fmt: fmtNum } }));
  bars = mk('ov-bars', stackedBarsOption(hours, { name: 'Input + cache write', data: [] }, { name: 'Output', data: [] }));
  donut = mk('ov-donut', donutOption('0', [{ name: 'Cache read', value: 1, c1: '#0a6fd0', c2: '#26d4f8' }]));

  // Smooth rendering: data lands every second or so, every number and line below glides toward it and the time axis
  // slides continuously, redrawn each animation frame (). Calm mode (Settings, Motion off) redraws once a second.
  const SPAN: Record<string, number> = { '60s': 60e3, '5m': 300e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
  const KFMT: Record<string, (n: number) => { v: string; u: string }> = {
    out: compact, req: compact, tot: compact,
    hit: (n) => ({ v: (n * 100).toFixed(1), u: '%' }),
    cost: (n) => ({ v: money(n), u: '' }),
  };
  const kp: Record<string, { e: Eased; s: EasedSeries; lo: Eased; hi: Eased; val: HTMLElement; mount: ReturnType<typeof sparkMount>; html: string }> = {};
  for (const key of Object.keys(KFMT)) {
    const tile = root.querySelector(`[data-k="${key}"] .kpi`) as HTMLElement;
    const hue = HUE[tile.classList.contains('purple') ? 'purple' : tile.classList.contains('green') ? 'green' : tile.classList.contains('amber') ? 'amber' : 'cyan'];
    kp[key] = { e: new Eased(), s: new EasedSeries(), lo: new Eased(), hi: new Eased(), val: tile.querySelector('.kpi-value') as HTMLElement, mount: sparkMount(tile.querySelector('.spark') as HTMLElement, hue), html: '' };
  }
  const sigA = new EasedSeries(), sigB = new EasedSeries(), yA = new Eased(), yB = new Eased();
  let fresh = true, dirty = false, fmtMode: 'time' | 'day' | 'sec' = 'time', sigFull = true, lastNow = 0, lastPaint = 0;

  function setFoot(key: string, delta: number | undefined, lowerIsBetter = false, deltaSuffix = '%', speed = 0, speedNote = '') {
    const sp = speed > 0 ? ` <span class="muted" style="font-size: calc(12px * var(--fs, 1));white-space:nowrap">${tokps(speed)} tok/s${speedNote}</span>` : '';
    (root.querySelector(`[data-k="${key}"] .kpi-foot`) as HTMLElement).innerHTML = (delta !== undefined ? deltaChip(delta, lowerIsBetter, deltaSuffix) : '<span class="muted" style="font-size: calc(12px * var(--fs, 1))">no earlier data</span>') + sp;
  }

  /** Redraws everything that moves: KPI numbers, sparklines and the throughput chart. */
  function frame(ts: number, dt: number) {
    const d = data;
    if (!d) return;
    const still = calm();
    if (still && !dirty && ts - lastPaint < 1000) return;
    const k = still ? 1 : ease(dt, 320);
    let moving = dirty;
    for (const key in kp) { const o = kp[key]; moving = o.e.step(k) || moving; moving = o.s.step(k) || moving; }
    moving = sigA.step(k) || sigB.step(k) || moving;
    const now = Date.now(), span = SPAN[d.range] || 3600e3, t0 = now - span;
    const px = (Math.abs(now - lastNow) / span) * ($('ov-sig').clientWidth || 700);
    if (!moving && px < 0.02 && !sigFull) return;
    dirty = false; lastNow = now; lastPaint = ts;
    for (const key in kp) {
      const o = kp[key], f = KFMT[key](o.e.cur), html = `${f.v}${f.u ? `<small>${f.u}</small>` : ''}`;
      if (html !== o.html) { o.val.innerHTML = html; o.html = html; }
      const pts = windowPts(o.s.t, o.s.cur, t0, now), vs = pts.map((p) => p[1]);
      o.lo.set(Math.min(...vs)); o.hi.set(Math.max(...vs));
      o.lo.step(k); o.hi.step(k);
      const lo = o.lo.cur, rng = o.hi.cur - lo || 1;
      o.mount.set(pts.map((p) => (p[0] - t0) / span), vs.map((v) => (v - lo) / rng));
    }
    const pa = windowPts(sigA.t, sigA.cur, t0, now), pb = windowPts(sigB.t, sigB.cur, t0, now);
    yA.set(Math.max(1, Math.max(...pa.map((p) => p[1])) * 1.18), sigFull); yB.set(Math.max(1, Math.max(...pb.map((p) => p[1])) * 1.18), sigFull);
    yA.step(k); yB.step(k);
    if (sigFull) {
      sigFull = false;
      sig!.setOption(signatureTimeOption({ xt: pa.map((p) => p[0]), xFmt: (t) => bucketLabel(t, fmtMode), min: t0, max: now, yMax: [yA.cur, yB.cur], a: { name: 'Requests', data: pa.map((p) => p[1]) }, b: { name: 'Output tokens / min', data: pb.map((p) => p[1]), fmt: fmtNum } }), true);
    } else {
      sig!.setOption({ xAxis: { min: t0, max: now }, yAxis: [{ max: yA.cur }, { max: yB.cur }], series: [{ data: pb }, { data: pa }] });
    }
  }
  // ---- collapsible, reorderable sections (order and collapsed state persist) ----
  const LAYOUT = 'tokenhud.ov.layout';
  const sections = [...root.querySelectorAll<HTMLElement>(':scope > [data-sec]')].map((el) => {
    const bar = document.createElement('div');
    bar.className = 'sec-bar lift';
    el.before(bar);
    return { id: el.dataset.sec!, title: el.dataset.title!, el, bar };
  });
  const lay = (() => { try { return JSON.parse(localStorage.getItem(LAYOUT) || '{}'); } catch { return {}; } })() as { order?: string[]; closed?: string[] };
  // a section missing from the saved order goes right after its predecessor in the page, so new rows land under their neighbour
  const secOrder = (lay.order || []).filter((id) => sections.some((x) => x.id === id));
  sections.forEach((x, i) => { if (!secOrder.includes(x.id)) secOrder.splice(i ? secOrder.indexOf(sections[i - 1].id) + 1 : 0, 0, x.id); });
  const secClosed = new Set<string>(lay.closed || []);
  function layoutDraw() {
    secOrder.forEach((id, i) => {
      const x = sections.find((y) => y.id === id)!, closed = secClosed.has(id);
      root.append(x.bar, x.el);
      x.el.hidden = closed;
      x.bar.classList.toggle('closed', closed);
      x.bar.innerHTML = `<button class="sb-t" data-a="fold" title="${closed ? 'Expand' : 'Collapse'}">${icon(closed ? ChevronRight : ChevronDown, 14)}<span>${esc(x.title)}</span></button><span class="sb-m"><button data-a="up" title="Move up"${i === 0 ? ' disabled' : ''}>${icon(ArrowUp, 13)}</button><button data-a="down" title="Move down"${i === secOrder.length - 1 ? ' disabled' : ''}>${icon(ArrowDown, 13)}</button></span>`;
      x.bar.querySelectorAll<HTMLElement>('button').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a, at = secOrder.indexOf(id);
        if (a === 'fold') { if (secClosed.has(id)) secClosed.delete(id); else secClosed.add(id); }
        else { const j = at + (a === 'up' ? -1 : 1); if (j < 0 || j >= secOrder.length) return; [secOrder[j], secOrder[at]] = [secOrder[at], secOrder[j]]; }
        localStorage.setItem(LAYOUT, JSON.stringify({ order: secOrder, closed: [...secClosed] }));
        layoutDraw();
      }));
    });
  }
  layoutDraw();

  const stopCompare = mountCompare($('ov-compare'));
  const stopFrames = frameLoop(frame);

  function paint(d: Overview) {
    const T = d.totals, P = d.prev, S = d.series;
    $('ov-sub').textContent = `${RANGE_LABEL[d.range]} · ${int(d.ingest.messages)} messages from ${d.ingest.files} transcript files · updated ${hms(d.now)}`;

    const snap = fresh; fresh = false;
    const tot = S.out.map((o, i) => o + S.inp[i] + S.cr[i]);
    const track = (key: string, target: number, series: number[]) => { const o = kp[key]; o.e.set(target, snap); o.s.set(S.t, series); if (snap) { o.s.snap(); o.lo.init = false; o.hi.init = false; } };
    track('out', T.out, S.out); track('req', T.req, S.req); track('tot', T.total, tot); track('hit', T.hit, S.hit); track('cost', T.cost, S.cost);
    setFoot('out', pctDelta(T.out, P.out), false, '%', T.tps || d.today.tps, T.tps ? '' : ' today'); setFoot('req', pctDelta(T.req, P.req)); setFoot('tot', pctDelta(T.total, P.total));
    setFoot('hit', P.hit ? (T.hit - P.hit) * 100 : undefined, false, ' pts'); setFoot('cost', pctDelta(T.cost, P.cost), true);
    const spHtml = speedRow(T.sx); const spEl = $('ov-speed'); if (spEl.dataset.h !== spHtml) { spEl.dataset.h = spHtml; spEl.innerHTML = spHtml; }
    const live = root.querySelector('[data-k="live"] .kpi-value') as HTMLElement;
    if (live.textContent !== String(d.liveSessions)) { live.textContent = String(d.liveSessions); live.classList.remove('flash'); void live.offsetWidth; live.classList.add('flash'); }
    (root.querySelector('[data-k="live"] .kpi-foot') as HTMLElement).innerHTML = `<span class="muted" style="font-size: calc(12px * var(--fs, 1))">${d.sessions.length} active in 24 h</span>`;

    fmtMode = S.fmt;
    sigA.set(S.t, S.req); sigB.set(S.t, S.outPerMin);
    if (snap) { sigA.snap(); sigB.snap(); sigFull = true; }
    dirty = true;

    // usage so far: real plan percentages when the status line feed is connected
    const sf = d.statusFeed, plan = sf && (sf.plan5h || sf.plan7d);
    $('ov-planpill').innerHTML = plan ? pill(sf && sf.fresh ? 'Live from status line' : 'From last reading', 'green') : `<a href="#/settings" style="text-decoration:none">${pill('Plan % not connected', 'grey')}</a>`;
    const pm = (label: string, w: { pct: number; resetsAt: number | null } | null, kind: '' | 'purple' | 'amber' | 'red') => w ? `<div class="meter-row"><div class="meter-top"><span>${label}</span><b>${Math.round(w.pct)}%</b></div>${bar(w.pct, w.pct >= 95 ? 'red' : w.pct >= 80 ? 'amber' : kind, [80])}<div class="meter-sub"><span>${w.resetsAt ? 'resets in ' + dur(Math.max(0, w.resetsAt - d.now)) : ''}</span><span>of your plan limit</span></div></div>` : '';
    paintPlan(d, sf && plan ? sf : null);
    cacheFeed = sf && sf.fresh ? sf : null; lastMsgTs = d.lastTs;
    drawCache();
    const am = d.apiMult, amWin = am.days >= 29.5 ? 'the last 30 days' : `the last ${Math.max(1, Math.round(am.days))} days`;
    const xs = (n: number) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}×`;
    const multBlock = am.cost > 0 ? `<div class="mult" title="Usage at API list prices, divided by the plan price (prorated to 30 days)"><div class="mult-n">${xs(am.mult)}</div><div class="mult-t"><b>${money(am.cost)}</b> of usage at API rates in ${amWin}, on ${am.accts.length > 1 ? `${am.accts.length} plans totalling $${am.usd}/mo` : `a $${am.usd}/mo plan`}</div></div>
      ${am.accts.length > 1 ? `<div class="stat-list" style="margin:-4px 0 14px">${am.accts.map((a) => `<div class="r" title="Claude messages go to the login that was active when they were sent (from its plan readings)">${esc(a.name)} <span class="muted">($${a.usd}/mo)</span><b>${xs(a.mult)} · ${money(a.cost)} · ${compactStr(a.out)} out · ${compactStr(a.all)} total</b></div>`).join('')}</div>` : ''}` : '';
    $('ov-local').innerHTML = multBlock + (plan ? pm('5-hour limit', sf!.plan5h, '') + pm('Weekly limit', sf!.plan7d, 'purple') : '') + `
      <div class="meter-row"><div class="meter-top"><span>Output, last 5 hours</span><b>${compactStr(d.local.out5h)}</b></div>${bar(Math.min(100, (d.local.out5h / 2e6) * 100), '')}<div class="meter-sub"><span>${compactStr(d.local.tok5h)} new tokens incl. input</span><span>${compactStr(d.local.all5h)} total</span></div></div>
      <div class="meter-row"><div class="meter-top"><span>Output, last 7 days</span><b>${compactStr(d.local.out7d)}</b></div>${bar(Math.min(100, (d.local.out7d / 25e6) * 100), 'purple')}<div class="meter-sub"><span>${money(d.local.cost7d)} at API rates (estimate)</span><span>${compactStr(d.local.all7d)} total</span></div></div>
      <div class="meter-row"><div class="meter-top"><span>Output, last 30 days</span><b>${compactStr(d.local.out30d)}</b></div>${bar(Math.min(100, (d.local.out30d / 100e6) * 100), 'purple')}<div class="meter-sub"><span>${money(d.local.cost30d)} at API rates (estimate)</span><span>${compactStr(d.local.all30d)} total</span></div></div>
      <p class="muted" style="font-size: calc(12px * var(--fs, 1));line-height:1.5">${plan ? 'Exact plan figures come from the status line.' : 'Plan percentages are not in transcripts. Connect the status line in Settings to see them. Bars here are only a rough scale.'}</p>`;

    // context
    const c = d.ctx;
    $('ov-ctx').innerHTML = c ? `<div class="ring-wrap">${ring(c.pct, 'used', c.pct > 85 ? 'amber' : 'cyan')}
      <div class="stat-list"><div class="r">Session<b style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.title)}">${esc(c.title || '(untitled)')}</b></div><div class="r">Model<b>${esc(c.model)}</b></div><div class="r">Input<b>${int(c.in + c.cw)}</b></div><div class="r">Cache read<b class="g">${int(c.cr)}</b></div><div class="r">Window<b>${int(c.window)}</b></div><div class="r">Last message<b>${ago(c.ts, d.now)}</b></div></div></div>` : '<p class="muted">No session yet.</p>';

    // mix
    const m = d.mix;
    donut!.setOption(donutOption(compactStr(m.in + m.cr + m.cw + m.out), [
      { name: 'Cache read', value: m.cr, c1: '#0a6fd0', c2: '#26d4f8' },
      { name: 'Cache write', value: m.cw, c1: '#6a3fd8', c2: '#b48cff' },
      { name: 'Input', value: m.in, c1: '#00b88a', c2: '#2cf59b' },
      { name: 'Output', value: m.out, c1: '#d08020', c2: '#ffc060' },
    ]));
    const leg = (col: string, n: string, v: number) => `<span><i style="background:${col};color:${col}"></i>${n} ${compactStr(v)}</span>`;
    $('ov-mixleg').innerHTML = leg(zc('#26d4f8'), 'Cache read', m.cr) + leg(zc('#b48cff'), 'Write', m.cw) + leg(zc('#2cf59b'), 'Input', m.in) + leg(zc('#ffc060'), 'Output', m.out);

    // hourly
    const hrs = d.hourly;
    bars!.setOption({ xAxis: { data: hrs.map((h) => bucketLabel(h.t, 'time')) }, series: [{ data: hrs.map((h) => h.inp) }, { data: hrs.map((h) => h.out) }] });

    // tools
    $('ov-tools').innerHTML = d.tools.length ? `<table class="tbl"><thead><tr><th>Tool</th><th class="num">Calls</th><th>Share</th><th class="num">Avg</th><th class="num">Err</th></tr></thead><tbody>${d.tools.map((t) =>
      `<tr><td class="strong" title="${esc(t.name)}"><span style="display:block;max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</span></td><td class="num">${int(t.calls)}</td><td>${inlineBar(Math.max(2, t.share * 100), Math.round(t.share * 100) + '%', t.share < 0.15 ? 'purple' : '')}</td><td class="num">${dur(t.avgMs)}</td><td class="num">${t.err ? `<span style="color:var(--red)">${t.err}</span>` : '0'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No tool calls in this range.</p>';

    // sessions
    $('ov-sessions').innerHTML = d.sessions.length ? `<table class="tbl"><thead><tr><th>Session</th><th>Project</th><th>Model</th><th class="num">Req</th><th class="num">Output</th><th class="num">tok/s</th><th class="num">Est.</th><th>State</th></tr></thead><tbody>${d.sessions.map((s) =>
      `<tr><td class="strong" style="max-width:230px;overflow:hidden;text-overflow:ellipsis">${esc(s.title || '(untitled)')}</td><td>${esc(s.project)}</td><td>${esc(s.model)}</td><td class="num">${int(s.req)}</td><td class="num">${compactStr(s.out)}</td><td class="num">${tokps(s.tps)}</td><td class="num">${money(s.cost)}</td><td>${s.state === 'live' ? pill('Live', 'green') : s.state === 'idle' ? pill('Idle ' + ago(s.last, d.now).replace(' ago', ''), 'amber') : pill(ago(s.last, d.now), 'grey')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No sessions in the last 24 hours.</p>';

    // feed
    $('ov-feed').innerHTML = `<div class="h"><span>Time</span><span>Level</span><span>Source</span><span>Message</span></div>${d.feed.map((f, i) =>
      `<div class="l${i === 0 ? ' new' : ''}"><span>${hms(f.ts)}</span><span class="lv-${f.level}">${f.level}</span><span>${f.src}</span><span>${esc(f.text)}</span></div>`).join('') || '<div class="l"><span></span><span></span><span></span><span class="muted">Nothing in the last 30 minutes.</span></div>'}`;
  }

  // plan limits strip: percent used, even-pace tick, projected % at reset and time to the limit at the current pace
  type Al = { sev: string; title: string; detail: string; link: string };
  let planAlerts: Al[] = [], srvAlerts: Al[] = [], alertsAt = 0;
  function paintPlan(d: Overview, sf: StatusFeed | null) {
    planAlerts = [];
    const tile = (label: string, w: { pct: number; resetsAt: number | null } | null, len: number, kind: '' | 'purple' | 'cx') => {
      if (!w) return '';
      const left = w.resetsAt ? Math.max(0, w.resetsAt - d.now) : 0, frac = w.resetsAt ? Math.min(1, Math.max(0, (len - left) / len)) : 0;
      const proj = frac > 0.03 ? w.pct / frac : 0, rate = frac > 0.03 && w.pct > 0 ? w.pct / (len * frac) : 0, toLimit = rate ? (100 - w.pct) / rate : 0;
      const hit = rate && w.pct < 100 && toLimit < left;
      const sev = w.pct >= 95 ? 'red' : w.pct >= 80 ? 'amber' : kind;
      if (w.pct >= 80) planAlerts.push({ sev: w.pct >= 95 ? 'crit' : 'warn', title: `${label} at ${Math.round(w.pct)}%`, detail: w.resetsAt ? `Resets in ${dur(left)}` : '', link: '#/settings' });
      return `<div class="@@"><div class="card lift plan-t${kind === 'cx' ? ' cx' : ''}"><div class="plan-top"><span class="plan-l">${label}</span><b class="plan-v ${sev}">${Math.round(w.pct)}<small>%</small></b></div>${bar(w.pct, sev, w.resetsAt ? [Math.round(frac * 100)] : [])}
        <div class="plan-sub"><span>${w.resetsAt ? 'resets in ' + dur(left) : ''}</span><span>${proj ? `pace: ${Math.round(proj)}% at reset` : 'pace: too early'}</span><span class="${hit ? 'plan-hit' : ''}">${hit ? 'limit in ~' + dur(toLimit) + ', before the reset' : rate ? 'on pace to stay under the limit' : ''}</span></div></div></div>`;
    };
    const src = getSrc(), cxp = src !== 'claude' ? d.codexPlan : null;
    const parts = [
      ...(src !== 'codex' && sf ? [tile('5-hour limit', sf.plan5h, 5 * 3600e3, ''), tile('Weekly limit', sf.plan7d, 7 * 86400e3, 'purple')] : []),
      ...(cxp ? [tile('Codex 5-hour limit', cxp.plan5h, 5 * 3600e3, 'cx'), tile('Codex weekly limit', cxp.plan7d, 7 * 86400e3, 'cx')] : []),
    ].filter(Boolean);
    const cls = parts.length >= 4 ? 'c3' : parts.length === 3 ? 'c4' : parts.length === 2 ? 'c6' : 'c12';
    const off = src === 'codex' ? 'No Codex plan reading in the current windows. Codex reports it with every request, so it appears after the next Codex turn.'
      : 'The status line is installed but has sent nothing yet (hooks do arrive). The Claude desktop Code tab may not run it; Claude Code in a terminal does. Limits, pace and time to the limit appear here once it posts.';
    const html = parts.length ? parts.map((x) => x.replace('@@', cls)).join('')
      : `<div class="c12"><a class="card lift plan-off" href="#/settings">${pill('No plan data', 'grey')}<span>${off}</span></a></div>`;
    const el = $('ov-plan-cards'); if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
    paintAlerts();
  }
  // one strip for everything that needs attention: plan limits plus the server's active alerts
  function paintAlerts() {
    const all = [...planAlerts, ...srvAlerts].sort((a, b) => Number(b.sev === 'crit') - Number(a.sev === 'crit'));
    const el = $('ov-alert'), a = all[0];
    const html = a ? `<a class="alertbar lift ${a.sev}" href="${esc(a.link || '#/alerts')}">${icon(TriangleAlert, 16)}<b>${esc(a.title)}</b><span>${esc(a.detail)}</span>${all.length > 1 ? `<em>+${all.length - 1} more</em>` : ''}<i>Open</i></a>` : '';
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
  }
  async function loadAlerts() {
    if (Date.now() - alertsAt < 15000) return;
    alertsAt = Date.now();
    const r = await getJson<{ active: Al[] }>('/api/alerts').catch(() => null);
    if (r && !dead) { srvAlerts = r.active || []; paintAlerts(); }
  }

  let cacheFeed: StatusFeed | null = null, lastMsgTs = 0;
  let tickN = 0;
  function drawCache(light = false) {
    const now = Date.now(), el = root.querySelector('#ov-cache') as HTMLElement | null, pl = root.querySelector('#ov-cachepill') as HTMLElement | null;
    if (!el || !pl) return;
    const c = cacheFeed && cacheFeed.cache;
    let ttl = 300000, expires = lastMsgTs + ttl, note = 'Estimated from your last request, assuming the 5 minute cache lifetime.';
    if (c && c.expiresAt) { expires = c.expiresAt; ttl = c.ttl ? c.ttl * (c.ttl < 100000 ? 1000 : 1) : ttl; note = c.warm === false ? 'Cache is cold: the next request re-reads the whole context at the uncached rate.' : 'Exact, from the status line.'; }
    const left = expires - now, warm = lastMsgTs > 0 && left > 0;
    const cap = el.querySelector('.ring-center b');
    if (light && warm && cap && ++tickN % 15) { cap.textContent = mmssCache(left); return; } // redraw the arc every 15 s, the countdown every second
    pl.innerHTML = c ? pill(c.warm === false || !warm ? 'Cold' : 'Warm', c.warm === false || !warm ? 'amber' : 'green') : pill(warm ? 'Warm (est.)' : 'Cold (est.)', warm ? 'grey' : 'amber');
    el.innerHTML = `<div class="ring-wrap">${ring(warm ? Math.min(100, (left / ttl) * 100) : 0, warm ? 'until cold' : 'expired', warm ? 'green' : 'amber')}<div class="stat-list">${c && c.hit != null ? `<div class="r">Hit ratio<b>${(c.hit * (c.hit <= 1 ? 100 : 1)).toFixed(0)}%</b></div>` : ''}${c && c.misses != null ? `<div class="r">Misses<b>${c.misses}</b></div>` : ''}${c && c.lastMissCause ? `<div class="r">Last miss<b>${esc(c.lastMissCause)}</b></div>` : ''}${c && c.recacheTokens ? `<div class="r">Re-cache if cold<b>${compactStr(c.recacheTokens)}</b></div>` : ''}</div></div><p class="muted" style="font-size: calc(12px * var(--fs, 1));line-height:1.5;margin-top:8px">${note}</p>`;
    const big = el.querySelector('.ring-center b'); if (big) big.textContent = warm ? mmssCache(left) : 'Cold';
  }
  const mmssCache = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  const cacheTick = setInterval(() => drawCache(true), 1000);

  // time left at continuous use in each 5h model/effort card: (100 - used %) x hours per 100%, hours per 100% is "to fill 5 h" from /api/cards (the Cards page figure), with /api/plan's rate as fallback (read at most every 15 s).
  // The five most recently used model/efforts (from /api/cards, newest first) get a card; the newest is tagged "Last used".
  // Over/under pace: when that model reaches 100%, minutes before (over) or after (under) the 5h reset. Even pace reaches 100% exactly at the reset.
  let leftAt = 0;
  async function loadLeft() {
    if (dead || Date.now() - leftAt < 15e3) return;
    leftAt = Date.now();
    const [p, cd] = await Promise.all([getJson<any>('/api/plan').catch(() => null), getJson<any>('/api/cards').catch(() => null)]);
    if (dead || !p) return;
    paintLeft(p, cd);
  }
  function paintLeft(p: any, cd: any) {
    const last = [...(p.series || [])].reverse().find((x: any) => x.p5 != null);
    const el = $('ov-left');
    if (!last) { el.innerHTML = ''; return; }
    const used = last.p5, ago = dur(Math.max(0, Date.now() - last.t));
    const rows: any[] = p.h5?.rows || [];
    const claude: any[] = (cd?.cards || []).filter((c: any) => c.src === 'claude');
    const recent = [...claude].sort((a: any, b: any) => b.last - a.last).slice(0, 5);
    if (!recent.length) { el.innerHTML = ''; return; }
    const items = recent.map((c: any, i: number) => ({ model: c.model.split(' ')[0], effort: c.effort || '', fast: !!c.fast, lastUsed: i === 0 }));
    const cards = items.map((it) => {
      const r = rows.find((x) => x.model === it.model && x.effort === it.effort && !!x.fast === it.fast);
      const c = claude.find((x) => x.model.split(' ')[0] === it.model && x.effort === it.effort && !!x.fast === it.fast);
      const hours = c?.h5 ?? r?.hoursPer100 ?? null, rough = c?.h5 != null ? !!c.h5Est : !!r?.low;
      const title = `${it.model} ${it.effort || 'default'}${it.fast ? ' · fast' : ''}`, right = it.lastUsed ? pill('Last used', 'grey') : '';
      if (!hours) return card(title, '<div class="card-sub">no 5h data yet</div>', { cls: 'lift', right });
      const leftMs = (100 - used) / 100 * hours * 3600e3, t100 = Date.now() + leftMs;
      const gap = last.r5 && used < 100 ? Math.round((t100 - last.r5) / 60000) : null; // > 0: 100% comes after the reset (under), < 0: before (over)
      const pace = gap == null ? '' : gap < 0 ? `<div class="card-sub" style="color:var(--red)" title="At this rate the 5h limit is hit before the window resets">${-gap} min over pace</div>` : `<div class="card-sub" style="color:var(--green)" title="At this rate the window resets before the 5h limit is hit">${gap} min under pace</div>`;
      const body = `<div style="font-size:26px;font-weight:600;color:var(--cyan)">${dur(leftMs)}</div><div class="card-sub">${rough ? `<span style="color:var(--amber)">${icon(TriangleAlert, 12)}</span> rough data` : 'of continuous use left'}</div>` +
        `<div class="card-sub">${used >= 100 ? 'limit reached' : `100% at ${clockTime(t100).slice(0, 5)}`}</div>${pace}`;
      return card(title, body, { cls: 'lift', right });
    }).join('');
    el.innerHTML = `<div class="c12"><div style="display:grid;grid-template-columns:repeat(${items.length},minmax(0,1fr));gap:var(--gap)">${cards}</div><div class="card-sub" style="margin-top:6px">Based on the latest 5h reading: ${Math.round(used)}% used, read ${ago} ago.</div></div>`;
  }
  async function refresh() {
    if (dead) return;
    try {
      const d = await getOverview(range);
      if (dead) return;
      if ('loading' in d) { $('ov-sub').textContent = `Reading transcripts… ${d.done} of ${d.total} files`; setTimeout(() => loop.kick(), 600); return; }
      data = d; paint(d); void loadAlerts(); void loadLeft();
    } catch { $('ov-sub').textContent = "Can't reach the TokenHUD server."; }
  }
  // short ranges slide with the clock, so poll them faster; long ranges only need the server push
  const loop = liveLoop(refresh, () => ({ '60s': 1000, '5m': 2000, '1h': 5000 } as Record<string, number>)[range] ?? 30000);

  return () => { dead = true; clearInterval(cacheTick); stopFrames(); stopCompare(); loop.stop(); charts.forEach((c) => c.dispose()); charts = []; void data; };
}
