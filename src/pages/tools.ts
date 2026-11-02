// M5: Tools.
import { Wrench, Timer, AlertTriangle, Hash, ArrowUp, ArrowDown } from 'lucide';
import { icon, card, inlineBar, spark, pill } from '../ui';
import { stackedBarsOption, C } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, ago, dur, esc } from '../format';
import { kpiRow, chartBag, clockTime, note } from './kit';

import type { Tile } from './kit';
const sec = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const short = (n: string) => n.replace(/^mcp__/, '').replace(/__/g, ' · ');
const pc = (v: number | null) => (v == null ? '<span class="muted">·</span>' : `${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3)}%`);
const LS = 'tokenhud.tools.sort';
interface Col { k: string; label: string; tip?: string; num?: boolean; w?: string; get: (t: any) => number | string | null; cell: (t: any, i: number) => string }
const COLS: Col[] = [
  { k: 'name', label: 'Tool', get: (t) => short(t.name).toLowerCase(), cell: (t) => `<td class="strong">${esc(short(t.name))}</td>` },
  { k: 'calls', label: 'Calls', num: true, get: (t) => t.calls, cell: (t) => `<td class="num">${int(t.calls)}</td>` },
  { k: 'share', label: 'Share', w: '130px', get: (t) => t.share, cell: (t, i) => `<td>${inlineBar(t.share * 100, (t.share * 100).toFixed(t.share < 0.1 ? 1 : 0) + '%', i % 2 ? 'purple' : '')}</td>` },
  { k: 'p5', label: '5h total', tip: "Summed 5h-meter share of this tool's calls", num: true, get: (t) => t.p5, cell: (t) => `<td class="num">${pc(t.p5)}</td>` },
  { k: 'p7', label: 'Week total', tip: "Summed weekly-meter share of this tool's calls", num: true, get: (t) => t.p7, cell: (t) => `<td class="num">${pc(t.p7)}</td>` },
  { k: 'p5Avg', label: '5h avg', tip: '5h-meter share per call', num: true, get: (t) => t.p5Avg, cell: (t) => `<td class="num">${pc(t.p5Avg)}</td>` },
  { k: 'p7Avg', label: 'Week avg', tip: 'Weekly-meter share per call', num: true, get: (t) => t.p7Avg, cell: (t) => `<td class="num">${pc(t.p7Avg)}</td>` },
  { k: 'daily', label: '14 days', tip: 'Calls per day, last 14 days (sorts by their total)', get: (t) => t.daily.reduce((a: number, v: number) => a + v, 0), cell: (t, i) => `<td>${spark(t.daily, i % 2 ? '#9058f8' : '#00d0f8', false)}</td>` },
  { k: 'avgMs', label: 'Avg', num: true, get: (t) => t.avgMs, cell: (t) => `<td class="num">${sec(t.avgMs)}</td>` },
  { k: 'p50', label: 'p50', num: true, get: (t) => t.p50, cell: (t) => `<td class="num">${sec(t.p50)}</td>` },
  { k: 'p95', label: 'p95', num: true, get: (t) => t.p95, cell: (t) => `<td class="num">${sec(t.p95)}</td>` },
  { k: 'maxMs', label: 'Max', num: true, get: (t) => t.maxMs, cell: (t) => `<td class="num">${sec(t.maxMs)}</td>` },
  { k: 'err', label: 'Errors', num: true, get: (t) => t.err, cell: (t) => `<td class="num">${t.err ? `<span style="color:var(--red)">${int(t.err)}</span>` : '0'}</td>` },
  { k: 'errRate', label: 'Error rate', num: true, get: (t) => t.errRate, cell: (t) => `<td class="num">${(t.errRate * 100).toFixed(1)}%</td>` },
];

export function renderTools(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Tools</h1><p class="page-sub" id="tl-sub">Reading tool calls…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="tl-kpis"></div>
  <div class="row">
    <div class="c8">${card('Calls per day, last 14 days', '<div class="chart" id="tl-days" style="height:240px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Most-used tool</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>All other tools</span></div>')}</div>
    <div class="c4">${card('Slowest calls', '<div id="tl-slow"></div>')}</div>
  </div>
  <div class="row"><div class="c12">${card('All tools', '<div id="tl-table" style="overflow-x:auto"></div>', { sub: 'Duration is the time from call to result. Plan % splits each request\'s cost over its tool calls and scales it by the 5h / weekly meter reading: totals add up over 30 days (they can pass 100%), averages are per call.' })}</div></div>
  <div class="row"><div class="c12">${card('Recent errors', '<div id="tl-err"></div>')}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const days = charts.mk($('tl-days'), stackedBarsOption([''], { name: 'a', data: [0] }, { name: 'b', data: [0] }));

  let rows: any[] = [];
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  let sortK: string = COLS.some((c) => c.k === saved.k) ? saved.k : 'calls', dir: number = saved.dir === 1 ? 1 : -1;
  function drawTable() {
    const sc = COLS.find((c) => c.k === sortK)!;
    const list = [...rows].sort((a, b) => {   // empty values (no meter reading) always last
      const x = sc.get(a), y = sc.get(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * dir;
    });
    const head = COLS.map((c) => `<th class="srt${c.num ? ' num' : ''}${c.k === sortK ? ' on' : ''}" data-k="${c.k}" title="${esc(c.tip || c.label)}"${c.w ? ` style="width:${c.w}"` : ''}>${esc(c.label)}${c.k === sortK ? icon(dir > 0 ? ArrowUp : ArrowDown, 11) : ''}</th>`).join('');
    $('tl-table').innerHTML = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${list.map((t, i) => `<tr>${COLS.map((c) => c.cell(t, i)).join('')}</tr>`).join('')}</tbody></table>`;
    $('tl-table').querySelectorAll<HTMLElement>('th[data-k]').forEach((h) => h.addEventListener('click', () => {
      const k = h.dataset.k!;
      if (sortK === k) dir = -dir; else { sortK = k; dir = k === 'name' ? 1 : -1; }
      try { localStorage.setItem(LS, JSON.stringify({ k: sortK, dir })); } catch { /* storage unavailable */ }
      drawTable();
    }));
  }

  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/tools').catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const T: any[] = d.tools;
    if (!T.length) { $('tl-table').innerHTML = note('No tool calls yet.'); return; }
    const timed = T.reduce((a, t) => a + t.totalMs, 0), n = T.reduce((a, t) => a + t.calls, 0);
    $('tl-sub').textContent = `${T.length} tools · updated ${clockTime(Date.now())}`;
    $('tl-kpis').innerHTML = kpiRow(<Tile[]>[
      { label: 'Tool calls', value: compactStr(d.calls), chip: { svg: icon(Wrench, 20) }, series: d.days.length ? d.days.map((_: number, i: number) => T.reduce((a, t) => a + t.daily[i], 0)) : undefined, sub: `${T.length} different tools` },
      { label: 'Failed', value: int(d.errors), color: d.errors ? 'amber' : 'green', chip: { svg: icon(AlertTriangle, 20) }, sub: `${((d.errors / Math.max(1, d.calls)) * 100).toFixed(1)}% of calls` },
      { label: 'Most used', value: short(T[0].name), color: 'purple', chip: { svg: icon(Hash, 20), hue: 'purple' }, sub: `${int(T[0].calls)} calls, ${(T[0].share * 100).toFixed(0)}%` },
      { label: 'Avg duration', value: sec(timed / Math.max(1, n)), color: 'green', chip: { svg: icon(Timer, 20), hue: 'green' }, sub: 'across all tools' },
      { label: 'Slowest call', value: sec(d.slowest[0]?.ms ?? 0), color: 'amber', chip: { svg: icon(Timer, 20) }, sub: short(d.slowest[0]?.name ?? '') },
      { label: 'Time in tools', value: dur(timed), color: 'purple', chip: { svg: icon(Timer, 20), hue: 'purple' }, sub: 'sum of all call durations' },
    ].map((t) => ({ ...t, value: t.value.length > 14 ? t.value.slice(0, 13) + '…' : t.value })));
    const top = T[0].daily, all = d.days.map((_: number, i: number) => T.reduce((a, t) => a + t.daily[i], 0));
    days.setOption(stackedBarsOption(d.days.map(day), { name: T[0].name, data: top }, { name: 'Other tools', data: all.map((v: number, i: number) => v - top[i]) }));
    $('tl-slow').innerHTML = d.slowest.slice(0, 8).map((s: any) =>
      `<div class="callrow" style="cursor:pointer" data-toolcall="${esc(s.id)}" title="Click for the full input and result"><b>${esc(short(s.name))}</b><span class="in">${esc(s.session)}</span><span class="d">${sec(s.ms)}</span></div>`).join('') || note('None.');
    rows = T; drawTable();
    $('tl-err').innerHTML = d.recentErrors.length ? `<table class="tbl"><thead><tr><th>When</th><th>Tool</th><th>Session</th><th class="num">Duration</th><th></th></tr></thead><tbody>${d.recentErrors.map((e: any) =>
      `<tr class="link" data-toolcall="${esc(e.id)}" title="Click for the error output"><td>${ago(e.ts, d.now ?? Date.now())}</td><td class="strong">${esc(short(e.name))}</td><td class="clip">${esc(e.session)}</td><td class="num">${sec(e.ms)}</td><td>${pill('Failed', 'red')}</td></tr>`).join('')}</tbody></table>` : note('No failed calls. Nice.');
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
