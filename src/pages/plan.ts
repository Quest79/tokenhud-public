// Plan value: API dollars per 1% / 10% / 50% / 100% of the 5-hour and weekly plan allotment, by model and effort.
import { Timer, Clock, CalendarDays, ListChecks, Layers, Gauge, TriangleAlert } from 'lucide';
import { icon, card, pill } from '../ui';
import { zc, glow } from '../theme';
import { signatureOption, C, tooltipBase, tipHtml, fmtNum } from '../charts';
import { getJson, getSrc } from '../api';
import { liveLoop } from '../live';
import { money, int, esc, ago, tokps } from '../format';
import { tzOpt } from '../tz';
import { kpiRow, chartBag, dayTime, note } from './kit';

const usd = (v: number | null) => (v == null ? '·' : v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : v >= 10 ? '$' + v.toFixed(1) : '$' + v.toFixed(2));
const pc = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const win = (v: number | null) => (v == null ? '·' : v >= 10 ? v.toFixed(0) : v.toFixed(1));
const hrs = (v: number | null) => (v == null ? '·' : v >= 100 ? Math.round(v) + ' h' : v >= 10 ? v.toFixed(0) + ' h' : v.toFixed(1) + ' h');
const label = (r: any) => `${r.model}${r.fast ? ' fast' : ''}`;

const wd = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, ...tzOpt() });
/** Hours as "12 h 13m", or "38m" under an hour. */
const dur = (h: number) => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)} h ${m % 60}m`; };

/** Runway grid under the pool tiles: hours of continuous use per model and effort until the weekly pool reaches 0. Red = after the next reset, green = before it. */
function runwayCard(d: any): string {
  const rw = d.runway;
  if (!rw) return '';
  const cell = (c: any) => {
    if (c.hours == null && !c.never) return '<td class="num muted">·</td>';
    const bg = 'transparent';
    const fg = 'var(--cyan)';
    const tip = `${c.est ? 'Estimated from the 5h rate: no weekly reading yet. ' : ''}${c.low ? 'Low data. ' : ''}Hours of continuous use left before the weekly pool reaches 0%`;
    const warn = c.low ? `<span style="color:var(--amber);opacity:1">${icon(TriangleAlert, 11)}</span> ` : '';
    return `<td class="num" title="${tip}" style="background:${bg};color:${fg};font-weight:600;font-style:${c.est ? 'italic' : 'normal'};opacity:${c.low ? 0.6 : 1}">${warn}${c.never ? 'past 8 wk' : dur(c.hours)}</td>`;
  };
  const head = rw.efforts.map((e: string) => `<th class="num">${e}</th>`).join('');
  const body = rw.rows.map((r: any) => `<tr><td class="strong">${esc(r.model)}</td>${r.cells.map(cell).join('')}</tr>`).join('');
  const sub = `Hours of continuous use left before the weekly pool reaches 0%, per model and effort. Each reset adds 100%. Faded with a warning icon = low data. Italic = estimated from the 5h rate because there is no weekly reading yet. · = no data.`;
  const html = card('Runway to 0%', `<div style="overflow-x:auto"><table class="tbl" style="table-layout:fixed;min-width:0"><thead><tr><th style="width:120px">Model</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`, { sub });
  return `<div class="row" style="margin-top:var(--gap)"><div class="c12">${html}</div></div>`;
}

/** Claude weekly pool: each account's meter % left, plus 100 back at each reset (max 200% with two accounts). */
function poolTiles(d: any): string {
  const accts: any[] = d.accounts || [];
  if (!accts.length || !d.pool) return card('Weekly pool', note('Needs weekly plan readings. They appear as Claude Code reports the plan %.'));
  const age = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);
  if (d.pool.now == null) {
    const waiting = accts.filter((x) => !x.passed && x.ageH > 0.25).map((x) => `${wd(x.resetsAt).split(' ')[0]} account (last reading ${age(x.ageH)} ago)`).join(', ');
    return card('Weekly pool', note(`Waiting for a live reading from every account. Old readings are not counted. Missing: ${waiting}.`));
  }
  const now = {
    label: 'Pool now', value: `${Math.round(d.pool.now)}% left`, color: 'cyan', chip: { svg: icon(Gauge, 20) },
    sub: accts.map((x) => `${wd(x.resetsAt).split(' ')[0]} ${Math.round(x.meterLeft)}%${x.passed ? ' (reset passed, assumed full)' : ` (${age(x.ageH)} old)`}`).join(' + ') + ' · max 200%',
  };
  const resets = d.pool.resets.map((r: any) => ({ label: `After ${wd(r.resetsAt)} reset`, value: `${Math.round(r.pool)}%`, color: 'green', chip: { svg: icon(CalendarDays, 20), hue: 'green' }, sub: 'no further use assumed' }));
  return kpiRow([now, ...resets], 'c4');
}

function table(w: any, h5?: any): string {
  const wk = (r: any) => { const a = h5?.rows.find((x: any) => x.key === r.key); return a?.perPct && r.perPct ? win(r.perPct / a.perPct) : '·'; };
  if (!w.rows.length) return note('Not enough readings in this window yet.');
  return `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Model</th><th>Effort</th><th class="num">$ per 1%</th><th class="num">$ per 10%</th><th class="num">$ per 50%</th><th class="num">$ per 100%</th><th class="num">Hours per 100%</th><th class="num">tok/s</th>${h5 ? '<th class="num">5h windows per week</th>' : ''}<th class="num">Spend measured</th><th class="num">Share</th><th>Confidence</th></tr></thead><tbody>${w.rows.map((r: any) =>
    `<tr><td class="strong">${esc(label(r))}</td><td>${esc(r.effort)}</td><td class="num">${usd(r.perPct)}</td><td class="num">${usd(r.perPct && r.perPct * 10)}</td><td class="num">${usd(r.perPct && r.perPct * 50)}</td><td class="num">${usd(r.perPct && r.perPct * 100)}</td><td class="num">${hrs(r.hoursPer100)}</td><td class="num">${tokps(r.tps)}</td>${h5 ? `<td class="num">${wk(r)}</td>` : ''}<td class="num">${money(r.spend)}</td><td class="num">${pc(r.share)}</td><td>${r.perPct == null ? pill('No signal', 'grey') : r.low ? pill('Low data', 'amber') : pill('Good', 'green')}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted" style="font-size: calc(12px * var(--fs, 1));margin:10px 2px 0">All models together: <b style="color:var(--text-2)">${usd(w.perPct)}</b> per 1% (${usd(w.perPct && w.perPct * 100)} per 100%) from ${w.chunks} measured stretches covering ${int(w.deltaPct)} points of movement${w.r2 != null ? ` · fit quality R² ${w.r2.toFixed(2)}` : ''}.</p>`;
}

// Claude vs Codex scatter: every model + effort row from both sources, any metric on either axis.
const COL = { claude: zc('#4aa3ff'), codex: zc('#ee9aa3') };
const dotSize = (sized: boolean, spend: number) => (sized ? Math.max(10, Math.min(36, 7 + Math.sqrt(spend) * 1.5)) : 9);
interface Slot { x: number; y: number; w: number; h: number; right: boolean; dx: number; dy: number; r: number }
const lay = { ver: 0, key: '', dots: [] as { si: number; di: number; v: number[]; r: number; name: string }[], pos: new Map<string, Slot>() };
let measureCtx: CanvasRenderingContext2D | null = null;
const textW = (t: string) => { measureCtx ||= document.createElement('canvas').getContext('2d'); measureCtx!.font = '11px Inter Variable, Inter, sans-serif'; return measureCtx!.measureText(t).width + 10; };
interface Metric { id: string; label: string; fmt: (v: number) => string }
const num2 = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const METRICS: Metric[] = [
  { id: 'tps', label: 'Output speed (tok/s)', fmt: num2 },
  { id: 'wpw', label: '5h windows per week', fmt: num2 },
  { id: 'h5hrs', label: '5h: hours per 100%', fmt: (v) => num2(v) + ' h' },
  { id: 'h5pp', label: '5h: $ per 1%', fmt: (v) => '$' + num2(v) },
  { id: 'h5p100', label: '5h: $ per 100%', fmt: (v) => '$' + num2(v) },
  { id: 'w7hrs', label: 'Weekly: hours per 100%', fmt: (v) => num2(v) + ' h' },
  { id: 'w7pp', label: 'Weekly: $ per 1%', fmt: (v) => '$' + num2(v) },
  { id: 'w7p100', label: 'Weekly: $ per 100%', fmt: (v) => '$' + num2(v) },
  { id: 'spend', label: 'Spend measured ($)', fmt: (v) => '$' + num2(v) },
  { id: 'share', label: 'Share of source usage', fmt: (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%' },
];
interface Pt { src: 'claude' | 'codex'; name: string; low: boolean; spend: number; m: Record<string, number | null> }
function points(d: any): Pt[] {
  const out: Pt[] = [];
  for (const [src, o] of [['claude', d], ['codex', d.cx]] as const) {
    if (!o) continue;
    for (const a of o.h5.rows) {
      const b = o.w7.rows.find((x: any) => x.key === a.key);
      const m: Record<string, number | null> = {
        tps: a.tps || null, wpw: a.perPct && b?.perPct ? b.perPct / a.perPct : null, h5hrs: a.hoursPer100, h5pp: a.perPct, h5p100: a.perPct && a.perPct * 100,
        w7hrs: b?.hoursPer100 ?? null, w7pp: b?.perPct ?? null, w7p100: b?.perPct ? b.perPct * 100 : null, spend: a.spend, share: a.share,
      };
      out.push({ src, name: `${a.model}${a.fast ? ' fast' : ''} ${a.effort}`, low: a.low || !!b?.low, spend: a.spend, m });
    }
  }
  return out;
}
const SUB5 = 'What each model and effort level costs, at API prices, to use up 1%, 10%, 50% or 100% of the 5-hour allotment.';
const SUB7 = 'The same for the weekly allotment, plus how many full 5h windows of that model and effort fit in a week. Fewer readings move this meter, so expect wider error.';

/** One source's page block (KPIs, readings chart, two tables). sfx '' = Claude, '-cx' = Codex. */
const block = (sfx: string) => {
  const cx = sfx === '-cx';
  return `${cx ? '<h2 style="margin:22px 2px 10px;font-size:calc(17px * var(--fs, 1));color:var(--cx)">Codex (ChatGPT plan)</h2>' : `<div id="pl-acct"></div>`}
  <div id="pl-kpis${sfx}"></div>
  <div class="row"><div class="c12">${card(cx ? 'Codex plan limit readings' : 'Plan limit readings', `<div class="chart" id="pl-chart${sfx}" style="height:260px"></div>`, { sub: cx ? 'Your Codex 5-hour and weekly % used over time, from the rate limits Codex writes in its session logs.' : 'Your 5-hour and weekly % used over time, from every time Claude Code reported it.' })}</div></div>
  <div class="row"><div class="c12" id="pl-h5${sfx}"></div></div>
  <div class="row"><div class="c12" id="pl-w7${sfx}"></div></div>`;
};

export function renderPlan(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  const src = getSrc(), showClaude = src !== 'codex', showCx = src !== 'claude';
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Plan value</h1><p class="page-sub" id="pl-sub">Reading plan limit history…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="pl-stale"></div>
  <div class="row"><div class="c12">${card('Claude vs Codex', `<div class="cmp-bar"><label class="muted">X</label><select id="pl-x">${METRICS.map((m) => `<option value="${m.id}"${m.id === 'tps' ? ' selected' : ''}>${m.label}</option>`).join('')}</select><label class="muted" style="margin-left:6px"><input type="checkbox" id="pl-xlog"> log</label>
    <label class="muted" style="margin-left:14px">Y</label><select id="pl-y">${METRICS.map((m) => `<option value="${m.id}"${m.id === 'wpw' ? ' selected' : ''}>${m.label}</option>`).join('')}</select><label class="muted" style="margin-left:6px"><input type="checkbox" id="pl-ylog"> log</label>
    <label class="muted" style="margin-left:14px"><input type="checkbox" id="pl-size" checked> dot size = spend</label><label class="muted" style="margin-left:14px"><input type="checkbox" id="pl-nolow"> hide low-data rows</label><span class="muted" id="pl-cmp-n" style="margin-left:auto"></span></div><div class="cmp-pick" id="pl-pick"></div><div class="chart" id="pl-cmp" style="height:440px"></div>`, { sub: 'Every model and effort from both plans. Blue = Claude, red = Codex; dot size = spend measured, faded dots have little data. Pick any two measures. Shows both sources whatever the header filter says.' })}</div></div>
  ${showClaude ? block('') : ''}${showCx ? block('-cx') : ''}
  <div class="row"><div class="c12">${card('How to read this', `<ul class="muted" style="font-size: calc(12.5px * var(--fs, 1));line-height:1.7;margin:0;padding-left:18px">
    <li><b style="color:var(--text-2)">Method.</b> Each time the plan % moved by 2 points or more between two readings, the API-rate cost of every model and effort used in that stretch is added up. A least-squares fit then finds how many dollars of each it takes to move the meter 1%.</li>
    <li><b style="color:var(--text-2)">Hours per 100%</b> is how long that model and effort could be used, at the pace you actually used it, before the meter hits 100%. It is the dollars per 100% divided by your dollars per active hour, where an active hour is 60 minutes in which that model sent a request. A busier pace uses the meter up faster.</li>
    <li><b style="color:var(--text-2)">Readings</b> come from every <code>get_usage</code> result saved in your transcripts, plus the status line feed when it is installed. New readings only appear when one of those runs. Codex readings come from the <code>rate_limits</code> Codex writes after every reply, so they are dense; Claude and Codex are fitted separately because they have separate meters.</li>
    <li><b style="color:var(--text-2)">Rough edges.</b> The plan reports whole percents, so small stretches are noisy and the weekly meter moves slowly. Usage outside Claude Code or Codex (chat apps, other devices) also moves the meter but is not in the logs, which makes dollars per % look higher than it is. Rows marked Low data have little spend behind them.</li>
    <li><b style="color:var(--text-2)">Weekly pool.</b> Each Claude account has a 100% weekly meter, so both together max out at 200%. "Pool now" adds each account's meter % left from its latest reading (age shown). Each reset refills that account to 100%. The "After reset" tiles add those refills to today's numbers and assume no further use, so they are the most you could have then.</li>
    <li><b style="color:var(--text-2)">Runway to 0%.</b> For each Claude model and effort, how many hours of continuous use at its measured weekly rate would empty the pool, counting each reset as +100%. Red means it runs out after the next reset; green means before.</li>
    <li><b style="color:var(--text-2)">Dollars</b> are API list-price estimates (Settings, Pricing). If the plan weights tokens differently, models with a very different token mix will drift from the fit.</li></ul>`)}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const mkChart = (sfx: string) => charts.mk($('pl-chart' + sfx), signatureOption({ x: [''], a: { name: '5-hour %', data: [0] }, b: { name: 'Weekly %', data: [0] } }));
  // One checkbox per good-confidence row decides whether it's on the chart; the choice is remembered.
  const key = (p: Pt) => p.src + '|' + p.name;
  const hidden = new Set<string>(JSON.parse(localStorage.getItem('tokenhud.plan.hide') || '[]'));
  // the chart's axis, log and hide-low-data choices are remembered until changed
  const CTL = ['pl-x', 'pl-y', 'pl-xlog', 'pl-ylog', 'pl-size', 'pl-nolow'], CTL_KEY = 'tokenhud.plan.chart';
  try {
    const sv = JSON.parse(localStorage.getItem(CTL_KEY) || '{}');
    for (const id of CTL) {
      const e = $(id) as HTMLInputElement | HTMLSelectElement;
      if (sv[id] === undefined) continue;
      if (e instanceof HTMLInputElement) e.checked = !!sv[id]; else if ([...e.options].some((o) => o.value === sv[id])) e.value = sv[id];
    }
  } catch {}
  const cmpOpt = (pts: Pt[]) => {
    const xm = METRICS.find((m) => m.id === ($('pl-x') as HTMLSelectElement).value)!, ym = METRICS.find((m) => m.id === ($('pl-y') as HTMLSelectElement).value)!;
    const xl = ($('pl-xlog') as HTMLInputElement).checked, yl = ($('pl-ylog') as HTMLInputElement).checked, nolow = ($('pl-nolow') as HTMLInputElement).checked, sized = ($('pl-size') as HTMLInputElement).checked;
    const ok = pts.filter((p) => !hidden.has(key(p)) && p.m[xm.id] != null && p.m[ym.id] != null && (!xl || p.m[xm.id]! > 0) && (!yl || p.m[ym.id]! > 0) && !(nolow && p.low));
    $('pl-cmp-n').textContent = `${ok.length} of ${pts.length} rows plotted${ok.length < pts.length ? ' (the rest lack data for these two measures)' : ''}`;
    const axis = { color: C.axis, fontSize: 11.5 };
    const ax = (m: Metric, log: boolean, y: boolean) => ({ type: log ? 'log' as const : 'value' as const, name: m.label, nameLocation: y ? 'end' as const : 'middle' as const, nameGap: y ? 14 : 28, nameTextStyle: { ...axis, align: y ? 'left' as const : 'center' as const }, scale: !log, axisLabel: { ...axis, formatter: (v: number) => m.fmt(v) }, axisLine: { lineStyle: { color: C.line } }, splitLine: { lineStyle: { color: C.grid } } });
    lay.ver++; lay.dots = [];
    const series = (['claude', 'codex'] as const).map((src, si) => ({
      name: src === 'claude' ? 'Claude' : 'Codex', type: 'scatter' as const,
      symbolSize: (v: any, p: any) => dotSize(sized, p.data.spend),
      itemStyle: { color: COL[src], borderColor: '#ffffff', borderWidth: 1, borderType: 'solid' as const, shadowBlur: glow(10), shadowColor: COL[src] },
      label: { show: true, position: 'right' as const, color: COL[src], fontSize: 11, padding: [5, 2, 5, 2], formatter: (p: any) => p.data.name, textBorderColor: zc('#04101c'), textBorderWidth: 3 },
      labelLine: { show: true, minTurnAngle: 90, lineStyle: { color: COL[src], width: 1, opacity: 0.6 } },
      // one global layout over every dot and label at once (layoutAll), then each label is put where it says, with a leader line
      labelLayout: (p: any) => {
        const W = cmp.getWidth(), H = cmp.getHeight(), k = lay.ver + ':' + W + 'x' + H;
        if (lay.key !== k) { lay.key = k; layoutAll(W, H); }
        const q = lay.pos.get(p.seriesIndex + ':' + p.dataIndex);
        if (!q) return {};
        const ex = q.right ? q.x - 3 : q.x + q.w + 3, sx = q.right ? q.dx + q.r : q.dx - q.r, ey = q.y + q.h / 2;
        return { x: q.x, y: q.y, labelLinePoints: [[sx, q.dy], [(sx + ex) / 2, (q.dy + ey) / 2], [ex, ey]] };
      },
      emphasis: { focus: 'none' as const, scale: 1.25 }, blur: { itemStyle: { opacity: 1 }, label: { opacity: 1 } },
      data: ok.filter((p) => p.src === src).map((p, di) => { lay.dots.push({ si, di, v: [p.m[xm.id]!, p.m[ym.id]!], r: dotSize(sized, p.spend) / 2, name: p.name }); return { value: [p.m[xm.id], p.m[ym.id]], name: p.name, spend: p.spend, itemStyle: { opacity: p.low ? 0.4 : 0.95 }, p }; }),
    }));
    return {
      animationDuration: 400, grid: { left: 64, right: 90, top: 34, bottom: 44 },
      legend: { top: 0, right: 10, textStyle: { color: C.axis }, itemWidth: 10, itemHeight: 10 },
      tooltip: { ...tooltipBase, trigger: 'item' as const, confine: true, hideDelay: 0, formatter: (q: any) => { const p: Pt = q.data.p; return tipHtml(`${q.seriesName}: ${p.name}`, [{ color: q.color, name: xm.label, value: xm.fmt(q.value[0]) }, { color: q.color, name: ym.label, value: ym.fmt(q.value[1]) }, { color: q.color, name: 'Spend measured', value: '$' + fmtNum(Math.round(p.spend)) }, { color: q.color, name: 'Confidence', value: p.low ? 'Low data' : 'Good' }]); } },
      xAxis: ax(xm, xl, false), yAxis: ax(ym, yl, true), series,
    };
  };
  let cmpPts: Pt[] = [];
  // Places every label: nearest free spot to its dot (right side first, then left), never over another label or any dot, always inside the chart.
  const layoutAll = (W: number, H: number) => {
    lay.pos = new Map();
    const dots = lay.dots.map((d) => { const [px, py] = cmp.convertToPixel({ seriesIndex: d.si }, d.v) as number[]; return { ...d, px, py }; }).filter((d) => Number.isFinite(d.px) && Number.isFinite(d.py));
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hitsDot = (x: number, y: number, w: number, h: number, skip: any) => dots.some((o) => o !== skip && (Math.max(x, Math.min(o.px, x + w)) - o.px) ** 2 + (Math.max(y, Math.min(o.py, y + h)) - o.py) ** 2 < (o.r + 2) ** 2);
    const hitsLabel = (x: number, y: number, w: number, h: number) => placed.some((q) => x < q.x + q.w + 2 && q.x < x + w + 2 && y < q.y + q.h + 1 && q.y < y + h + 1);
    for (const d of [...dots].sort((a, b) => a.py - b.py || a.px - b.px)) {
      const w = textW(d.name), h = 18;
      let best: Slot | null = null, bestCost = Infinity;
      for (const right of [true, false]) {
        const x = right ? d.px + d.r + 22 : d.px - d.r - 22 - w;
        for (let m = 0; m <= 14; m++) for (const sg of m ? [1, -1] : [1]) {
          const dy = sg * m * (h + 1), y = d.py - h / 2 + dy;
          if (x < 0 || x + w > W || y < 0 || y + h > H || hitsLabel(x, y, w, h) || hitsDot(x, y, w, h, d)) continue;
          const cost = Math.abs(dy) + (right ? 0 : 25);
          if (cost < bestCost) { bestCost = cost; best = { x, y, w, h, right, dx: d.px, dy: d.py, r: d.r }; }
        }
      }
      best ||= { x: d.px + d.r + 22, y: d.py - h / 2, w, h, right: true, dx: d.px, dy: d.py, r: d.r };
      placed.push(best);
      lay.pos.set(d.si + ':' + d.di, best);
    }
  };
  const cmp = charts.mk($('pl-cmp'), cmpOpt([]));
  const drawCmp = () => cmp.setOption(cmpOpt(cmpPts), true);
  const pick = (all: boolean | null) => {
    const good = [...cmpPts.filter((p) => !p.low), ...cmpPts.filter((p) => p.low)]; // every row has a checkbox, low-data ones last and faded
    if (cmpPts.length && localStorage.getItem('tokenhud.plan.hide') === null) cmpPts.filter((p) => p.low).forEach((p) => hidden.add(key(p))); // first visit: low-data rows start unchecked
    if (all !== null) good.forEach((p) => (all ? hidden.delete(key(p)) : hidden.add(key(p))));
    if (cmpPts.length) localStorage.setItem('tokenhud.plan.hide', JSON.stringify([...hidden]));
    // one block per source, each with its own All / None, models as toggle chips (filled = shown, dashed + faded = low data)
    const grp = (src: 'claude' | 'codex') => {
      const rows = good.map((p, i) => ({ p, i })).filter((r) => r.p.src === src);
      if (!rows.length) return '';
      const shown = rows.filter((r) => !hidden.has(key(r.p))).length;
      return `<div class="pk-grp ${src}"><div class="pk-h"><b>${src === 'claude' ? 'Claude' : 'Codex'}</b><span class="muted">${shown} of ${rows.length} shown</span><button data-src="${src}" data-all="1">All</button><button data-src="${src}" data-all="0">None</button></div><div class="pk-chips">` +
        rows.map((r) => `<label class="pk-chip${hidden.has(key(r.p)) ? '' : ' on'}${r.p.low ? ' low' : ''}"${r.p.low ? ' title="Little data behind this rate"' : ''}><input type="checkbox" data-i="${r.i}"${hidden.has(key(r.p)) ? '' : ' checked'}>${r.p.name}</label>`).join('') + '</div></div>';
    };
    $('pl-pick').innerHTML = good.length ? grp('claude') + grp('codex') : '';
    $('pl-pick').querySelectorAll<HTMLInputElement>('input').forEach((c) => c.addEventListener('change', () => { const p = good[+c.dataset.i!]; c.checked ? hidden.delete(key(p)) : hidden.add(key(p)); pick(null); drawCmp(); }));
    $('pl-pick').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      const src = b.dataset.src, on = b.dataset.all === '1';
      good.filter((p) => p.src === src).forEach((p) => (on ? hidden.delete(key(p)) : hidden.add(key(p))));
      pick(null); drawCmp();
    }));
  };
  $('pl-cmp').addEventListener('mouseleave', () => cmp.dispatchAction({ type: 'hideTip' }));
  for (const id of CTL) $(id).addEventListener('change', () => {
    localStorage.setItem(CTL_KEY, JSON.stringify(Object.fromEntries(CTL.map((k) => { const e = $(k) as HTMLInputElement | HTMLSelectElement; return [k, e instanceof HTMLInputElement ? e.checked : e.value]; }))));
    drawCmp();
  });
  const chart = showClaude ? mkChart('') : null, chartCx = showCx ? mkChart('-cx') : null;

  function fill(sfx: string, d: any, ch: any, empty: string) {
    if (!d || !d.readings) { $('pl-h5' + sfx).innerHTML = card('No readings yet', note(empty)); $('pl-kpis' + sfx).innerHTML = ''; return; }
    const h = d.h5, w = d.w7, pw = d.perWeek;
    $('pl-kpis' + sfx).innerHTML = kpiRow([
      { label: '5-hour, per 1%', value: usd(h.perPct), chip: { svg: icon(Clock, 20) }, sub: `${usd(h.perPct && h.perPct * 100)} for the full window` },
      { label: '5-hour, hours per 100%', value: hrs(h.hoursPer100), color: 'cyan', chip: { svg: icon(Timer, 20) }, sub: 'of active use, all models, at your pace' },
      { label: 'Weekly, per 1%', value: usd(w.perPct), color: 'purple', chip: { svg: icon(CalendarDays, 20), hue: 'purple' }, sub: `${usd(w.perPct && w.perPct * 100)} for the full week` },
      { label: 'Weekly, hours per 100%', value: hrs(w.hoursPer100), color: 'purple', chip: { svg: icon(Timer, 20), hue: 'purple' }, sub: 'of active use, all models, at your pace' },
      { label: '5h windows per week', value: win(pw.windows), color: 'amber', chip: { svg: icon(Layers, 20) }, sub: `one full 5h window = ${pw.weekPctPerWindow == null ? '·' : pw.weekPctPerWindow.toFixed(1) + '%'} of the week` },
      { label: 'Readings', value: int(d.readings), color: 'green', chip: { svg: icon(ListChecks, 20), hue: 'green' }, sub: 'plan % samples collected' },
    ], 'c2');
    $('pl-h5' + sfx).innerHTML = card('5-hour window: dollars per percent', table(h), { sub: SUB5 });
    $('pl-w7' + sfx).innerHTML = card('Weekly window: dollars per percent', table(w, h), { sub: SUB7 });
    const s: any[] = d.series;
    ch.setOption(signatureOption({ x: s.map((p) => dayTime(p.t)), a: { name: '5-hour %', data: s.map((p) => p.p5), fmt: (v) => v + '%' }, b: { name: 'Weekly %', data: s.map((p) => p.p7), fmt: (v) => v + '%' }, yMax: 100, yFmt: (v) => v + '%' }), true);
  }

  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/plan').catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const c = d.cx, parts: string[] = [];
    cmpPts = points(d); pick(null); drawCmp();
    if (showClaude) {
      if (!d.readings) parts.push('No Claude plan readings yet');
      else {
        const age = Date.now() - d.last;
        parts.push(`${int(d.readings)} readings · ${dayTime(d.first)} to ${dayTime(d.last)} · latest ${ago(d.last)}${d.pollOn ? (d.poll.ok ? ' · auto-reading on' : ' · auto-reading failing: ' + d.poll.error) : ''}`);
        $('pl-stale').innerHTML = !d.pollOn && age > 2 * 3600e3 ? `<div class="card" style="padding:12px 16px;border-color:rgba(240,160,56,.4)"><span style="color:var(--amber)">Latest reading was ${ago(d.last)}.</span> <span class="muted">Turn on <a href="#/settings" style="color:var(--cyan)">Plan % tracking in Settings</a> so this page keeps updating by itself.</span></div>` : '';
      }
    }
    if (showCx) parts.push(c ? `Codex ${c.plan ? c.plan + ' plan, ' : ''}${int(c.readings)} readings · ${dayTime(c.first)} to ${dayTime(c.last)} · latest ${ago(c.last)}` : 'No Codex plan readings yet');
    $('pl-sub').textContent = parts.join(' · ');
    if (showClaude) $('pl-acct').innerHTML = poolTiles(d) + runwayCard(d);
    if (chart) fill('', d, chart, 'TokenHUD has not seen a plan % yet. Run <code>get_usage</code> in a Claude Code session, or install the status line in Settings, and readings will start to collect.');
    if (chartCx) fill('-cx', c, chartCx, 'Codex has not reported a rate limit yet. Readings appear after the first Codex reply.');
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
