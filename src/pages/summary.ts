// M7/M8: Summary: week vs previous week, signature chart, insight cards, top lists, expensive turns, heatmap.
import { CircleDollarSign, Zap, Layers, Database, Coins, MessageSquare, Lightbulb, ChevronRight } from 'lucide';
import { icon, card, inlineBar, kpi } from '../ui';
import { signatureOption, heatmapOption, C } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, pctDelta, esc, tokps } from '../format';
import { chartBag, clockTime, note, trunc } from './kit';

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const HUE: Record<string, string> = { green: 'green', amber: 'amber', red: 'red', blue: 'blue', purple: 'purple', grey: 'grey' };
const INS_ICON: Record<string, string> = { green: 'Good', amber: 'Watch', red: 'Fix', blue: 'Top', purple: 'Models', grey: 'Pattern' };

export function renderSummary(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Summary</h1><p class="page-sub" id="su-sub">Building the report…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="su-kpis"></div>
  <div class="row">
    <div class="c8">${card('Cost and output per day, last 30 days', '<div class="chart" id="su-sig" style="height:300px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Cost (est.)</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>Output tokens</span></div>')}</div>
    <div class="c4">${card('Insights', '<div id="su-ins"></div>', { sub: 'Rule-based, from your last 7 days.' })}</div>
  </div>
  <div class="row">
    <div class="c4">${card('Top sessions by cost', '<div id="su-sess"></div>')}</div>
    <div class="c4">${card('Models by cost', '<div id="su-mod"></div>')}</div>
    <div class="c4">${card('Most-used tools', '<div id="su-tool"></div>')}</div>
  </div>
  <div class="row">
    <div class="c7">${card('Most expensive requests', '<div id="su-exp" style="overflow-x:auto"></div>', { sub: 'Large context is the usual reason: every request re-sends it.' })}</div>
    <div class="c5">${card('When you work, last 28 days', '<div class="chart" id="su-heat" style="height:300px"></div>', { sub: 'Tokens by weekday and hour.' })}</div>
  </div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const sig = charts.mk($('su-sig'), signatureOption({ x: [''], a: { name: 'Cost', data: [0] } }));
  const heat = charts.mk($('su-heat'), heatmapOption(HOURS, DAYS, [[0, 0, 0]]));

  const list = (rows: { name: string; v: number; text: string; sid?: string }[], kind: '' | 'purple') => {
    const max = Math.max(1e-9, ...rows.map((r) => r.v));
    return rows.length ? rows.map((r) => `<div class="callrow" ${r.sid ? `style="cursor:pointer" data-sid="${r.sid}"` : ''}><b class="clip" style="flex:0 0 42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(trunc(r.name, 34))}</b><span class="in" style="flex:1">${inlineBar((r.v / max) * 100, r.text, kind)}</span></div>`).join('') : note('Nothing yet.');
  };

  async function refresh() {
    if (dead) return;
    const [d, u] = await Promise.all([getJson('/api/summary').catch(() => null), getJson('/api/usage').catch(() => null)]);
    if (!d || !u || dead) { if (!d || !u) setTimeout(() => loop.kick(), 700); return; }
    const w = d.week, p = d.prev;
    $('su-sub').textContent = `Last 7 days vs the 7 days before · updated ${clockTime(Date.now())}`;
    const dl = (a: number, b: number) => pctDelta(a, b);
    const last7 = u.days.slice(-7);
    const K = [
      { label: 'Est. cost', value: money(w.cost), color: 'cyan' as const, svg: CircleDollarSign, delta: dl(w.cost, p.cost), low: true, series: last7.map((x: any) => x.cost) },
      { label: 'Requests', value: compactStr(w.req), color: 'purple' as const, svg: MessageSquare, delta: dl(w.req, p.req), hue: 'purple', series: last7.map((x: any) => x.req) },
      { label: 'Output tokens', value: compactStr(w.out), color: 'green' as const, svg: Zap, delta: dl(w.out, p.out), sub: w.tps ? tokps(w.tps) + ' tok/s' : undefined, hue: 'green', series: last7.map((x: any) => x.out) },
      { label: 'Sessions', value: int(w.sessions), color: 'cyan' as const, svg: Layers, delta: dl(w.sessions, p.sessions) },
      { label: 'Cache hit', value: (w.hit * 100).toFixed(1), unit: '%', color: 'purple' as const, svg: Database, delta: p.hit ? (w.hit - p.hit) * 100 : undefined, suffix: ' pts', hue: 'purple' },
      { label: 'Tokens per $', value: compactStr(w.tokPerUsd), color: 'green' as const, svg: Coins, delta: dl(w.tokPerUsd, p.tokPerUsd), hue: 'green', series: last7.map((x: any) => (x.cost ? (x.inp + x.out + x.cr) / x.cost : 0)) },
    ];
    $('su-kpis').innerHTML = `<div class="row">${K.map((k) => `<div class="c2">${kpi({ label: k.label, value: k.value, unit: (k as any).unit, color: k.color, chip: { svg: icon(k.svg, 20), hue: (k as any).hue }, delta: k.delta, sub: (k as any).sub, lowerIsBetter: (k as any).low, deltaSuffix: (k as any).suffix, series: (k as any).series })}</div>`).join('')}</div>`;

    sig.setOption(signatureOption({
      x: u.days.map((x: any) => day(x.t)),
      a: { name: 'Cost (est.)', data: u.days.map((x: any) => +x.cost.toFixed(2)), fmt: (v) => money(v) },
      b: { name: 'Output tokens', data: u.days.map((x: any) => x.out), fmt: (v) => compactStr(v) },
      yFmt: (v) => '$' + v,
    }));
    $('su-ins').innerHTML = d.insights.length ? d.insights.map((i: any) =>
      `<div class="insight ${HUE[i.hue]}"><span class="ic">${icon(Lightbulb, 16)}</span><div><b>${INS_ICON[i.hue]}</b><p>${esc(i.text)}</p></div><span class="chev">${icon(ChevronRight, 14)}</span></div>`).join('') : note('Not enough activity yet for insights.');

    $('su-sess').innerHTML = list(d.topSessions.map((s: any) => ({ name: s.title, v: s.cost, text: money(s.cost), sid: s.sid })), '');
    $('su-mod').innerHTML = list(d.topModels.map((m: any) => ({ name: m.name, v: m.cost, text: money(m.cost) })), 'purple');
    $('su-tool').innerHTML = list(d.topTools.map((t: any) => ({ name: t.name.replace(/^mcp__/, '').replace(/__/g, ' · '), v: t.calls, text: int(t.calls) })), '');
    $('su-sess').querySelectorAll<HTMLElement>('[data-sid]').forEach((e) => e.addEventListener('click', () => { location.hash = `#/sessions/${e.dataset.sid}`; }));

    $('su-exp').innerHTML = d.expensive.length ? `<table class="tbl"><thead><tr><th>When</th><th>Session</th><th>Model</th><th class="num">Context</th><th class="num">Output</th><th class="num">tok/s</th><th class="num">Cost</th></tr></thead><tbody>${d.expensive.map((t: any) =>
      `<tr class="link" data-h="#/traces/${t.sid}/${t.ts}"><td>${new Date(t.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</td><td class="clip">${esc(trunc(t.title, 30))}</td><td>${esc(t.model)}</td><td class="num">${compactStr(t.ctx)}</td><td class="num">${compactStr(t.out)}</td><td class="num">${tokps(t.tps)}</td><td class="num strong">${money(t.cost)}</td></tr>`).join('')}</tbody></table>` : note('No requests yet.');
    $('su-exp').querySelectorAll<HTMLElement>('tr.link').forEach((e) => e.addEventListener('click', () => { location.hash = e.dataset.h!; }));

    const cells: [number, number, number][] = [];
    d.heat.forEach((row: number[], di: number) => row.forEach((v, hi) => cells.push([hi, di, v])));
    heat.setOption(heatmapOption(HOURS, DAYS, cells));
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
