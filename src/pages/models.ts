// M5: Models.
import { Cpu, Gauge, Timer, DatabaseZap, Brain } from 'lucide';
import { icon, card, bar, inlineBar } from '../ui';
import { glow } from '../theme';
import { donutOption, C, tooltipBase, tipHtml, fmtNum } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, esc, tokps } from '../format';
import { kpiRow, speedRow, chartBag, clockTime, note } from './kit';

const PAL: [string, string][] = [[C.cyan, '#0a6fd0'], [C.purple, '#6a3fd8'], [C.green, '#0a9a6a'], [C.amber, '#c07818'], [C.pink, '#a03080']];
const sec = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
const pc = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

function scatterOption(models: any[], pts: any[]) {
  const axis = { color: C.axis, fontSize: 11.5 };
  return {
    animationDuration: 500,
    grid: { left: 54, right: 16, top: 28, bottom: 34 },
    tooltip: { ...tooltipBase, trigger: 'item' as const, formatter: (p: any) => tipHtml(p.seriesName, [{ color: p.color, name: 'Output tokens', value: fmtNum(p.value[0]) }, { color: p.color, name: 'Latency', value: p.value[1] + 's' }]) },
    xAxis: { type: 'log' as const, name: 'Output tokens', nameLocation: 'middle' as const, nameGap: 22, nameTextStyle: axis, min: 1, axisLabel: axis, axisLine: { lineStyle: { color: C.line } }, splitLine: { lineStyle: { color: C.grid } } },
    yAxis: { type: 'log' as const, name: 'Seconds', nameTextStyle: { ...axis, align: 'left' as const }, min: 0.1, axisLabel: axis, splitLine: { lineStyle: { color: C.grid } } },
    series: models.map((m, i) => ({
      name: m.name, type: 'scatter' as const, symbolSize: 7,
      itemStyle: { color: PAL[i % 5][0], opacity: 0.75, shadowBlur: glow(8), shadowColor: PAL[i % 5][0] },
      data: pts.filter((p) => p.model === m.name && p.out > 0 && p.lat > 0).map((p) => [p.out, p.lat]),
    })),
  };
}

export function renderModels(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Models</h1><p class="page-sub" id="md-sub">Reading models…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="md-kpis"></div>
  <div id="md-speed"></div>
  <div class="row"><div class="c12">${card('By reasoning level', '<div id="md-levels" style="overflow-x:auto"></div>', { sub: 'Each model at each reasoning effort (and fast mode), last 30 days. Output speed counts thinking tokens, which are generated but not all shown.' })}</div></div>
  <div class="row"><div class="c12">${card('Model comparison', '<div id="md-table" style="overflow-x:auto"></div>', { sub: 'Latency is the time from request to the end of the reply. Cost is estimated at API list prices.' })}</div></div>
  <div class="row">
    <div class="c4">${card('Share of requests', '<div class="chart" id="md-donut" style="height:230px"></div>')}</div>
    <div class="c8">${card('Latency vs output size', '<div class="chart" id="md-scatter" style="height:260px"></div><div class="legend" id="md-leg"></div>', { sub: 'Each dot is one reply. Both axes are logarithmic.' })}</div>
  </div>
  <div class="row"><div class="c12">${card('Context window use', '<div id="md-win" class="stack" style="gap:14px"></div>', { sub: 'Largest main-thread context seen against the model window.' })}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const donut = charts.mk($('md-donut'), donutOption('0', [], 'Requests'));
  const scat = charts.mk($('md-scatter'), scatterOption([], []));

  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/models').catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const M: any[] = d.models;
    if (!M.length) { $('md-table').innerHTML = note('No model requests yet.'); return; }
    const tot = (f: (m: any) => number) => M.reduce((a, m) => a + f(m), 0);
    const req = tot((m) => m.req), top = M[0];
    $('md-sub').textContent = `${M.length} models in use · updated ${clockTime(Date.now())}`;
    const wavg = (f: (m: any) => number) => tot((m) => f(m) * m.req) / Math.max(1, req);
    $('md-speed').innerHTML = speedRow(d.all);
    const L: any[] = d.levels || [];
    $('md-levels').innerHTML = `<table class="tbl"><thead><tr><th>Model</th><th>Level</th><th class="num">Requests</th><th class="num">Output</th><th class="num">Est. cost</th><th class="num">tok/s</th><th class="num">Decode tok/s</th><th class="num">TTFT</th><th class="num">Latency p50</th></tr></thead><tbody>${L.map((l) => `<tr><td class="strong">${esc(l.name)}</td><td>${esc(l.effort || 'default')}${l.fast ? ' · fast' : ''}</td><td class="num">${int(l.req)}</td><td class="num">${compactStr(l.out)}</td><td class="num">${money(l.cost)}</td><td class="num">${tokps(l.tps)}</td><td class="num">${tokps(l.sx?.dtps)}</td><td class="num">${l.sx?.ttft.n ? sec(l.sx.ttft.p50) : '·'}</td><td class="num">${l.sx?.lat.n ? sec(l.sx.lat.p50) : '·'}</td></tr>`).join('')}</tbody></table>`;
    $('md-kpis').innerHTML = kpiRow([
      { label: 'Models used', value: String(M.length), chip: { svg: icon(Cpu, 20) }, sub: `${top.name} leads` },
      { label: 'Requests', value: compactStr(req), color: 'purple', chip: { svg: icon(Gauge, 20), hue: 'purple' }, sub: `${compactStr(tot((m) => m.out))} output tokens` },
      { label: 'Cache hit', value: pc(wavg((m) => m.hit)), color: 'green', chip: { svg: icon(DatabaseZap, 20), hue: 'green' }, sub: 'share of prompt cached' },
      { label: 'Thinking', value: pc(wavg((m) => m.thinkShare)), color: 'amber', chip: { svg: icon(Brain, 20) }, sub: 'replies with thinking' },
    ], 'c3');
    $('md-table').innerHTML = `<table class="tbl"><thead><tr><th>Model</th><th class="num">Requests</th><th style="width:130px">Share</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Est. cost</th><th class="num">Avg output</th><th class="num">p50</th><th class="num">p95</th><th class="num">tok/s</th><th class="num">Decode tok/s</th><th class="num">TTFT</th><th class="num">Cache hit</th><th class="num">Thinking</th><th class="num">Fast</th><th class="num">Subagent</th></tr></thead><tbody>${M.map((m, i) =>
      `<tr><td class="strong"><i class="legdot" style="background:${PAL[i % 5][0]}"></i>${esc(m.name)}</td><td class="num">${int(m.req)}</td><td>${inlineBar(m.share * 100, pc(m.share), i % 2 ? 'purple' : '')}</td><td class="num">${compactStr(m.out)}</td><td class="num">${compactStr(m.cr)}</td><td class="num">${money(m.cost)}</td><td class="num">${int(m.avgOut)}</td><td class="num">${sec(m.p50)}</td><td class="num">${sec(m.p95)}</td><td class="num">${m.tokPerSec.toFixed(0)}</td><td class="num">${tokps(m.sx?.dtps)}</td><td class="num">${m.sx?.ttft.n ? sec(m.sx.ttft.p50) : '·'}</td><td class="num">${pc(m.hit)}</td><td class="num">${pc(m.thinkShare)}</td><td class="num">${pc(m.fastShare)}</td><td class="num">${pc(m.subShare)}</td></tr>`).join('')}</tbody></table>`;
    donut.setOption(donutOption(compactStr(req), M.map((m, i) => ({ name: m.name, value: m.req, c1: PAL[i % 5][0], c2: PAL[i % 5][1] })), 'Requests'), true);
    scat.setOption(scatterOption(M, d.scatter), true);
    $('md-leg').innerHTML = M.map((m, i) => `<span><i style="background:${PAL[i % 5][0]};color:${PAL[i % 5][0]}"></i>${esc(m.name)}</span>`).join('');
    $('md-win').innerHTML = M.map((m) => {
      const p = (m.peak / m.window) * 100;
      return `<div class="meter-row"><div class="meter-top"><span>${esc(m.name)}</span><b>${compactStr(m.peak)} <span class="muted" style="font-size: calc(13px * var(--fs, 1));font-weight:400">of ${compactStr(m.window)}</span></b></div>${bar(p, p > 85 ? 'amber' : '', [85])}<div class="meter-sub"><span>${p.toFixed(0)}% of the window at peak</span><span>${m.price ? `$${m.price.in} in · $${m.price.out} out · $${m.price.cr} cached per M tokens` : 'No price on file'}</span></div></div>`;
    }).join('');
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
