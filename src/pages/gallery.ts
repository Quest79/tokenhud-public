// Component gallery: every widget of the design system with SAMPLE data (not real usage).
import { Activity, Zap, Database, Timer, Coins } from 'lucide';
import { icon, kpi, ring, miniBars, pill, bar, seg, wireSeg, select, inlineBar, card } from '../ui';
import { init, signatureOption, stackedBarsOption, donutOption, heatmapOption, histogramOption, C, fmtNum } from '../charts';

const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const r = rnd(7);
const series = (n: number, base: number, amp: number) => Array.from({ length: n }, (_, i) => Math.round(base + Math.sin(i / 2.2) * amp + r() * amp * 0.6));

export function renderGallery(root: HTMLElement) {
  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const mins = Array.from({ length: 13 }, (_, i) => `10:${String(i * 4).padStart(2, '0')}`);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const heat: [number, number, number][] = [];
  days.forEach((_, d) => hours.forEach((_, h) => heat.push([h, d, Math.round(Math.max(0, Math.sin((h - 6) / 3.8)) * 900000 * (d > 4 ? 0.4 : 1) * (0.5 + r()))])));

  const legend = (c: string, t: string) => `<span><i style="background:${c};color:${c}"></i>${t}</span>`;

  root.innerHTML = `
  <div><h1 class="page-title">Gallery <span class="pill purple" style="vertical-align:middle;margin-left:8px">Sample data</span></h1>
  <p class="page-sub">Design-system reference. Every widget here uses made-up numbers; real pages arrive in later milestones.</p></div>

  <div class="row">
    <div class="c3">${kpi({ label: 'Output tokens', value: '1.28', unit: 'M', delta: 12.4, series: series(24, 40, 14), chip: { svg: icon(Zap, 20) } })}</div>
    <div class="c3">${kpi({ label: 'Requests', value: '3,482', delta: -4.2, series: series(24, 50, 18), color: 'purple', chip: { svg: icon(Activity, 20), hue: 'purple' } })}</div>
    <div class="c3">${kpi({ label: 'Cache hit rate', value: '96.4', unit: '%', delta: 0.8, series: series(24, 60, 6), color: 'green', chip: { svg: icon(Database, 20), hue: 'green' } })}</div>
    <div class="c3">${kpi({ label: 'Est. cost', value: '$18.40', delta: 9.1, lowerIsBetter: true, series: series(24, 30, 12), color: 'amber', chip: { svg: icon(Coins, 20), hue: 'cyan' } })}</div>
  </div>

  <div class="row">
    <div class="c8">${card('Requests & Token Throughput', `<div class="chart" id="sig" style="height:300px"></div><div class="legend">${legend(C.cyan, 'Requests')}${legend(C.purple, 'Tokens / min')}</div>`, { right: seg(['1H', '6H', '24H', '7D'], 0) })}</div>
    <div class="c4">${card('Plan limits', `
      <div class="stack" style="gap:18px">
        <div class="meter-row"><div class="meter-top"><span>5-hour window</span><b>37%</b></div>${bar(37, '', [50, 80])}<div class="meter-sub"><span>resets in 3h 12m</span><span>pace OK</span></div></div>
        <div class="meter-row"><div class="meter-top"><span>Weekly</span><b>71%</b></div>${bar(71, 'amber', [50, 80])}<div class="meter-sub"><span>resets Thu 09:00</span><span>ahead of pace</span></div></div>
        <div class="meter-row"><div class="meter-top"><span>Cache TTL</span><b>4:12</b></div>${bar(84, 'green')}<div class="meter-sub"><span>warm</span><span>hit ratio 96%</span></div></div>
        <div class="meter-row"><div class="meter-top"><span>Budget</span><b>96%</b></div>${bar(96, 'red', [50, 80])}<div class="meter-sub"><span>near limit</span><span>$48 / $50</span></div></div>
      </div>`)}</div>
  </div>

  <div class="row">
    <div class="c4">${card('Context window', `<div class="ring-wrap">${ring(62, 'used')}<div class="stat-list"><div class="r">Input<b>118,402</b></div><div class="r">Cache read<b class="g">412,930</b></div><div class="r">Window<b>1,000,000</b></div></div></div>`)}</div>
    <div class="c4">${card('Health rings', `<div class="hstack" style="justify-content:space-around">${ring(98, 'success', 'green')}${ring(34, 'thinking', 'purple')}${ring(81, 'budget', 'amber')}</div>`)}</div>
    <div class="c4">${card('Bars, pills, toggles', `<div class="hstack" style="align-items:end;gap:20px"><div style="flex:1;height:96px">${miniBars(series(18, 40, 25))}</div><div style="flex:1;height:96px">${miniBars(series(18, 50, 20), 'green')}</div></div>
      <div class="hstack" style="margin-top:14px;flex-wrap:wrap;gap:8px">${pill('Healthy', 'green')}${pill('Degraded', 'amber')}${pill('Failed', 'red')}${pill('Running', 'blue')}${pill('Idle', 'grey')}${pill('Subagent', 'purple')}</div>
      <div class="hstack" style="margin-top:14px;gap:10px">${select('Last 24 hours')}${select('All models')}${seg(['Tokens', 'Cost'], 0)}</div>`)}</div>
  </div>

  <div class="row">
    <div class="c6">${card('Tokens by hour (stacked bars)', `<div class="chart" id="bars"></div>`)}</div>
    <div class="c3">${card('Token mix (donut)', `<div class="chart" id="donut"></div>`)}</div>
    <div class="c3">${card('Message size (histogram)', `<div class="chart" id="hist"></div>`)}</div>
  </div>

  <div class="row">
    <div class="c7">${card('Activity by hour and weekday (heatmap)', `<div class="chart" id="heat" style="height:300px"></div>`)}</div>
    <div class="c5">${card('Top tools (table)', `<table class="tbl"><thead><tr><th>Tool</th><th class="num">Calls</th><th>Share</th><th class="num">Avg</th></tr></thead><tbody>
      <tr><td class="strong">Bash</td><td class="num">4,120</td><td>${inlineBar(88, '31%')}</td><td class="num">2.4s</td></tr>
      <tr><td class="strong">Read</td><td class="num">3,310</td><td>${inlineBar(70, '25%')}</td><td class="num">0.2s</td></tr>
      <tr><td class="strong">Edit</td><td class="num">2,046</td><td>${inlineBar(44, '15%', 'purple')}</td><td class="num">0.4s</td></tr>
      <tr><td class="strong">Grep</td><td class="num">1,180</td><td>${inlineBar(26, '9%', 'purple')}</td><td class="num">0.6s</td></tr>
      <tr><td class="strong">Agent</td><td class="num">212</td><td>${inlineBar(8, '2%')}</td><td class="num">41s</td></tr></tbody></table>`)}</div>
  </div>

  <div class="row">
    <div class="c5">${card('Live event log', `<div class="log"><div class="h"><span>Time</span><span>Level</span><span>Source</span><span>Message</span></div>
      <div class="l new"><span>10:41:07</span><span class="lv-INFO">INFO</span><span>assistant</span><span>msg_01 out 842 tok</span></div>
      <div class="l"><span>10:41:05</span><span class="lv-INFO">INFO</span><span>tool</span><span>Bash finished in 2.1s</span></div>
      <div class="l"><span>10:41:02</span><span class="lv-INFO">INFO</span><span>user</span><span>prompt submitted</span></div></div>`, { right: `<span class="live"><span class="dot ping"></span>Live</span>` })}</div>
    <div class="c4">${card('Streaming output', `<div class="stream"><div class="who">${icon(Timer, 13)} Assistant</div>Reading the transcript tail and updating the totals<span class="cursor"></span></div>`)}</div>
    <div class="c3">${card('Trace timeline (gantt)', `<div class="gantt">
      <div class="g-row"><span>LLM turn</span><div class="g-track"><div class="g-bar llm" style="left:2%;width:30%"></div></div></div>
      <div class="g-row"><span>Bash</span><div class="g-track"><div class="g-bar tool" style="left:32%;width:22%"></div></div></div>
      <div class="g-row"><span>Retry</span><div class="g-track"><div class="g-bar retry" style="left:54%;width:8%"></div></div></div>
      <div class="g-row"><span>LLM turn</span><div class="g-track"><div class="g-bar llm" style="left:62%;width:28%"></div><div class="now" style="left:90%"></div></div></div></div>`)}</div>
  </div>`;

  const mk = (id: string, opt: any) => init(root.querySelector('#' + id) as HTMLElement, opt);
  mk('sig', signatureOption({ x: mins, a: { name: 'Requests', data: series(13, 90, 40) }, b: { name: 'Tokens / min', data: series(13, 12000, 6000), fmt: fmtNum } }));
  mk('bars', stackedBarsOption(hours, { name: 'Input', data: series(24, 400000, 250000) }, { name: 'Output', data: series(24, 90000, 60000) }));
  mk('donut', donutOption('4.8B', [
    { name: 'Cache read', value: 4100, c1: '#0a6fd0', c2: '#26d4f8' },
    { name: 'Cache write', value: 520, c1: '#6a3fd8', c2: '#b48cff' },
    { name: 'Input', value: 90, c1: '#00b88a', c2: '#2cf59b' },
    { name: 'Output', value: 120, c1: '#d08020', c2: '#ffc060' },
  ]));
  mk('hist', histogramOption(['<1K', '1-5K', '5-20K', '20-50K', '50-100K', '100K+'], [820, 2400, 3100, 1500, 640, 210]));
  mk('heat', heatmapOption(hours, days, heat));
  wireSeg(root);
}
