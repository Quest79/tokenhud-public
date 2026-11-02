// M5: Cost & Usage.
import { Coins, Flame, CalendarDays, TrendingUp, Zap } from 'lucide';
import { icon, card, bar, inlineBar } from '../ui';
import { donutOption, stackedBarsOption, C } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, money, esc, tokps } from '../format';
import { kpiRow, chartBag, clockTime, note } from './kit';

const PAL: [string, string][] = [[C.cyan, '#0a6fd0'], [C.purple, '#6a3fd8'], [C.green, '#0a9a6a'], [C.amber, '#c07818'], [C.pink, '#a03080'], [C.blue, '#1c56c0']];
const parts = (rows: { name: string; cost: number }[]) => rows.map((r, i) => ({ name: r.name, value: +r.cost.toFixed(2), c1: PAL[i % 6][0], c2: PAL[i % 6][1] }));
const dayLbl = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function renderCost(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Cost & Usage</h1><p class="page-sub" id="cu-sub">Reading usage…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="cu-kpis"></div>
  <div class="row">
    <div class="c4">${card('Burn rate', '<div class="meter-list" id="cu-burn" style="display:grid;gap:16px"></div>', { sub: 'Estimated spend at API rates' })}</div>
    <div class="c8">${card('Daily cost, last 30 days', '<div class="chart" id="cu-days" style="height:250px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Input & cache writes (tokens)</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>Output (tokens)</span></div>', { sub: 'Bars show tokens per day. Hover for cost.' })}</div>
  </div>
  <div class="row">
    <div class="c4">${card('Cost by model', '<div class="chart" id="cu-d-model" style="height:200px"></div><div id="cu-l-model"></div>')}</div>
    <div class="c4">${card('Cost by project', '<div class="chart" id="cu-d-proj" style="height:200px"></div><div id="cu-l-proj"></div>')}</div>
    <div class="c4">${card('Tokens, last 30 days', '<div class="chart" id="cu-d-tok" style="height:200px"></div><div id="cu-l-tok"></div>')}</div>
  </div>
  <div class="row">
    <div class="c6">${card('Most expensive sessions', '<div id="cu-sess"></div>')}</div>
    <div class="c6">${card('Cost by tool (estimate)', '<div id="cu-tool"></div>', { sub: 'A request that calls several tools has its cost split evenly between them.' })}</div>
  </div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const dDays = charts.mk($('cu-days'), stackedBarsOption([''], { name: 'Input', data: [0] }, { name: 'Output', data: [0] }));
  const dm = charts.mk($('cu-d-model'), donutOption('$0', []));
  const dp = charts.mk($('cu-d-proj'), donutOption('$0', []));
  const dt = charts.mk($('cu-d-tok'), donutOption('0', []));

  const legend = (rows: { name: string; v: string }[]) => `<div class="stat-list" style="margin-top:6px">${rows.map((r, i) => `<div class="r"><span>${r.name === 'Total' ? '' : `<i class="legdot" style="background:${PAL[i % 6][0]}"></i>`}${esc(r.name)}</span><b>${r.v}</b></div>`).join('')}</div>`;
  const ranked = (rows: any[], total: number, link = false) => rows.length ? rows.map((r) => `<div class="callrow" ${link ? `style="cursor:pointer" data-sid="${r.sid}"` : ''}><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(r.name)}</b><span style="width:140px">${inlineBar(total ? (r.cost / total) * 100 : 0, '')}</span><span class="d" style="width:70px;text-align:right">${money(r.cost)}</span></div>`).join('') : note('Nothing yet.');

  async function refresh() {
    if (dead) return;
    const u = await getJson('/api/usage').catch(() => null);
    if (!u || dead) { if (!u) setTimeout(() => loop.kick(), 700); return; }
    const w = u.window, f = u.forecast;
    $('cu-sub').textContent = `Estimates from API list prices, not your plan's billing · updated ${clockTime(u.now)}`;
    $('cu-kpis').innerHTML = kpiRow([
      { label: 'Today', value: money(w.today), chip: { svg: icon(Coins, 20) }, series: u.days.slice(-14).map((d: any) => d.cost), sub: 'since midnight' },
      { label: 'Last 5 hours', value: money(w.h5), color: 'amber', chip: { svg: icon(Flame, 20) }, sub: `${money(w.h5 / 5)} per hour` },
      { label: 'Last 7 days', value: money(w.d7), color: 'purple', chip: { svg: icon(CalendarDays, 20), hue: 'purple' }, sub: `${money(w.d7 / 7)} per day` },
      { label: `${f.monthLabel} so far`, value: money(f.mtd), color: 'green', chip: { svg: icon(TrendingUp, 20), hue: 'green' }, sub: `day ${f.dayOfMonth} of ${f.daysInMonth}` },
      { label: 'Projected month', value: money(f.projected), color: 'amber', chip: { svg: icon(TrendingUp, 20) }, sub: `at ${money(f.avgDaily)} per day` },
      { label: 'Total tokens, 30 days', value: compactStr(u.tokens.out + u.tokens.inp + u.tokens.cr), chip: { svg: icon(Zap, 20), hue: 'blue' }, sub: `${compactStr(u.tokens.out)} output · ${compactStr(u.tokens.cr)} cache read${u.tokens.tps ? ' · ' + tokps(u.tokens.tps) + ' tok/s' : ''}` },
    ]);
    const rows: [string, number][] = [['Last 5 hours', w.h5], ['Last 24 hours', w.h24], ['Last 7 days', w.d7], ['Last 30 days', w.d30], ['Today', w.today]];
    const max = w.d30 || 1;
    $('cu-burn').innerHTML = rows.map(([k, v], i) => `<div class="meter-row"><div class="meter-top"><span>${k}</span><b>${money(v)}</b></div>${bar((v / max) * 100, i === 0 ? 'amber' : i === 2 ? 'purple' : '')}</div>`).join('');
    dDays.setOption(stackedBarsOption(u.days.map((d: any) => dayLbl(d.t)), { name: 'Input & cache writes', data: u.days.map((d: any) => d.inp) }, { name: 'Output', data: u.days.map((d: any) => d.out) }));
    const tot = () => w.d30;
    dm.setOption(donutOption(money(tot()), parts(u.byModel), 'Cost', money), true);
    dp.setOption(donutOption(money(tot()), parts(u.byProject), 'Cost', money), true);
    const tk = [{ name: 'Output', cost: u.tokens.out }, { name: 'Fresh input', cost: u.tokens.inp }, { name: 'Cache read', cost: u.tokens.cr }];
    dt.setOption(donutOption(compactStr(tk.reduce((a, x) => a + x.cost, 0)), parts(tk), 'Tokens', (v) => v.toLocaleString('en-US')), true);
    $('cu-l-model').innerHTML = legend(u.byModel.map((r: any) => ({ name: r.name, v: money(r.cost) })));
    $('cu-l-proj').innerHTML = legend(u.byProject.map((r: any) => ({ name: r.name, v: money(r.cost) })));
    $('cu-l-tok').innerHTML = legend([...tk.map((r) => ({ name: r.name, v: compactStr(r.cost) })), { name: 'Total', v: compactStr(tk.reduce((a, x) => a + x.cost, 0)) }]);
    $('cu-sess').innerHTML = ranked(u.bySession, u.bySession[0]?.cost || 1, true);
    $('cu-sess').querySelectorAll<HTMLElement>('[data-sid]').forEach((e) => e.addEventListener('click', () => { location.hash = `#/sessions/${e.dataset.sid}`; }));
    $('cu-tool').innerHTML = ranked(u.byTool, u.byTool[0]?.cost || 1);
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
