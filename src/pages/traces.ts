// M6: Traces. One trace = one turn (a prompt and everything it triggered).
import { GitBranch, Clock, Cpu, Wrench, GitFork, Coins, Zap, ArrowLeft, AlertTriangle, Gauge } from 'lucide';
import { icon, card, pill, seg, wireSeg } from '../ui';
import { C, fmtNum, tooltipBase, tipHtml, ptrShadow } from '../charts';
import { glow } from '../theme';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, dur, ago, esc, tokps, tpsAvg } from '../format';
import { waterfall, spanDetail, type Span } from '../waterfall';
import { kpiRow, speedRow, chartBag, clockTime, dayTime, trunc, note, hhmmss } from './kit';

const status = (s: string) => (s === 'running' ? pill('Running', 'blue') : s === 'error' ? pill('Error', 'red') : pill('OK', 'green'));
// Estimated share of a plan meter (null = no reading covers the turn)
const pctTxt = (v: number | null | undefined) => (v == null ? '–' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%');
const meterSub = (m: any, what: string) => (m ? `${what} · resets ${dayTime(m.resetsAt)}` : 'no meter reading covers this turn');
const MIX_LABEL: Record<string, string> = { cw: 'Cache writes', cr: 'Cache reads', inp: 'Fresh input', out: 'Output' };

// Session picked in the list filter (''=all). Saved in localStorage, so it survives reloads and app restarts.
const PICK_KEY = 'tokenhud.tracesSession';
let pickedSid = localStorage.getItem(PICK_KEY) || '';

export function renderTraces(root: HTMLElement, arg?: string): () => void {
  return arg ? renderDetail(root, arg) : renderList(root);
}

/* ---------------- list ---------------- */
function renderList(root: HTMLElement): () => void {
  let dead = false, data: any = null, only = Math.min(2, Number(localStorage.getItem('th.tracesOnly')) || 0);
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Traces</h1><p class="page-sub" id="tr-sub">Reading turns…</p></div>
    <div class="hstack" style="gap:12px"><span class="live"><span class="dot ping"></span>Live</span><select class="pick" id="tr-pick" aria-label="Session filter"></select>${seg(['ALL', 'ERRORS', 'RUNNING'], only)}</div></div>
  <div id="tr-kpis"></div>
  <div class="row"><div class="c12">${card('Recent turns', '<div id="tr-table" style="overflow-x:auto"></div>', { sub: 'Each row is one prompt and everything it triggered. Click one to see its waterfall.' })}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  wireSeg(root, (i) => { only = i; localStorage.setItem('th.tracesOnly', String(i)); if (data) paint(); });
  const pick = $('tr-pick') as HTMLSelectElement;
  pick.addEventListener('change', () => { pickedSid = pick.value; localStorage.setItem(PICK_KEY, pickedSid); refresh(); });

  // Labels are updated in place on each live refresh (turn counts move), so the choice and an open list are never reset.
  // The list itself is rebuilt only when a session appears or goes, and never while the picker has focus.
  let pickSids: string | null = null;
  const pickLabel = (s: any) => `${trunc(s.title || s.sid.slice(0, 8), 40)} · ${s.turns} turns · last ${dayTime(s.last)}`;
  // Older servers send no session list: build it from the turns they did send
  const sessionsOf = (ts: any[]) => {
    const m = new Map<string, any>();
    for (const t of ts) { const s = m.get(t.sid) ?? { sid: t.sid, title: t.title, turns: 0, last: 0 }; s.turns++; s.last = Math.max(s.last, t.ts); m.set(t.sid, s); }
    return [...m.values()];
  };
  function fillPick(sessions: any[]) {
    if (document.activeElement === pick) return;
    const sids = sessions.map((s) => s.sid).join();
    if (sids !== pickSids) {
      pickSids = sids;
      pick.innerHTML = `<option value="">All sessions</option>` + sessions.map((s) => `<option value="${s.sid}">${esc(pickLabel(s))}</option>`).join('');
    } else sessions.forEach((s, i) => { const o = pick.options[i + 1]; if (o) o.textContent = pickLabel(s); });
    // A saved session missing from the list keeps its choice, so it shows as an extra option instead of resetting
    if (pickedSid && !pick.querySelector(`option[value="${pickedSid}"]`)) pick.add(new Option(pickedSid.slice(0, 8), pickedSid));
    pick.value = pickedSid;
  }

  function paint() {
    const all: any[] = data.traces;
    const list = all.filter((t) => only === 0 || (only === 1 ? t.status === 'error' : t.status === 'running'));
    const sum = (f: (t: any) => number) => list.reduce((a, t) => a + f(t), 0);
    const scoped = pickedSid ? data.sessionTotal : data.total;
    fillPick(data.sessions ?? sessionsOf(data.traces));
    $('tr-sub').textContent = `${list.length} of ${scoped} turns${pickedSid ? ' in this session' : ''} shown · updated ${clockTime(data.now)}`;
    // 5h meter for these turns: summed per window; the latest window is the tile, every window total goes in the sub line
    const perWin = new Map<number, number>();
    for (const t of list) if (t.pct5 != null && t.win5 != null) perWin.set(t.win5, (perWin.get(t.win5) ?? 0) + t.pct5);
    const wins = [...perWin].sort((a, b) => b[0] - a[0]);
    const latest = wins[0];
    const spikes = list.filter((t) => t.spike);
    const meter5Sub = latest ? `${wins.length > 1 ? `${pctTxt(wins.reduce((a, w) => a + w[1], 0))} across ${wins.length} windows · ` : ''}window resets ${dayTime(latest[0])}` : 'no meter reading covers these turns';
    $('tr-kpis').innerHTML = kpiRow([
      { label: 'Turns', value: compactStr(scoped), chip: { svg: icon(GitBranch, 20) }, sub: `${all.filter((t) => t.status === 'running').length} running now` },
      { label: 'Median duration', value: dur(med(list.map((t) => t.durMs))), color: 'green', chip: { svg: icon(Clock, 20), hue: 'green' }, sub: 'prompt to final reply' },
      { label: 'Model requests', value: compactStr(sum((t) => t.llm)), color: 'purple', chip: { svg: icon(Cpu, 20), hue: 'purple' }, sub: `${compactStr(sum((t) => t.sub))} by subagents` },
      { label: 'Tool calls', value: compactStr(sum((t) => t.tools)), chip: { svg: icon(Wrench, 20), hue: 'blue' }, sub: `${int(sum((t) => t.err))} failed` },
      { label: 'Output tokens', value: compactStr(sum((t) => t.out)), color: 'green', chip: { svg: icon(Zap, 20), hue: 'green' }, sub: `${tokps(tpsAvg(list, (t: any) => t.out, (t: any) => t.tps))} tok/s · ${compactStr(sum((t) => t.tin))} prompt tokens` },
      { label: 'Est. cost', value: money(sum((t) => t.cost)), color: 'amber', chip: { svg: icon(Coins, 20) }, sub: 'these turns, estimate' },
    ]) + kpiRow([
      { label: '5h meter', value: latest ? pctTxt(latest[1]) : '–', color: 'amber', chip: { svg: icon(Gauge, 20) }, sub: meter5Sub },
      { label: 'Spike turns', value: String(spikes.length), color: 'purple', chip: { svg: icon(Gauge, 20), hue: 'purple' }, sub: data.bar != null ? `over ${pctTxt(data.bar)} of a window${data.typical ? ` · typical turn ${pctTxt(data.typical)}` : ''}` : '' },
    ], 'c6');
    $('tr-table').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Started</th><th>Prompt</th><th>Session</th><th title="Model and reasoning level that did most of the turn's cost; +N means other levels were used too">Model</th><th class="num">Duration</th><th class="num">Model req.</th><th class="num">Subagent</th><th class="num">Tools</th><th class="num">Output</th><th class="num">tok/s</th><th class="num" title="Tokens served from the prompt cache (part of Total). Shaded from normal at 0 to pure red at 10M">Cache read</th><th class="num" title="Input, cache read, cache write and output tokens">Total</th><th class="num" title="Est. cost per 1,000 tokens. Red: above the average for this model across all sessions and projects">$/1K</th><th class="num">Est.</th><th class="num" title="Estimated share of the 5-hour plan meter">5h meter</th><th>Status</th></tr></thead><tbody>${list.map((t) =>
      `<tr class="link" data-h="${t.sid}/${t.ts}"><td>${dayTime(t.ts)}</td><td class="strong clip">${esc(trunc(t.text || '(no prompt text)', 80))}</td><td class="clip">${esc(t.title)}</td><td style="white-space:nowrap">${esc(t.model || '·')}</td><td class="num">${dur(t.durMs)}</td><td class="num">${t.llm}</td><td class="num">${t.sub || '–'}</td><td class="num">${t.tools}${t.err ? `<span style="color:var(--red)"> (${t.err})</span>` : ''}</td><td class="num">${compactStr(t.out)}</td><td class="num">${tokps(t.tps)}</td><td class="num" style="color:color-mix(in srgb, #ff0000 ${Math.round(Math.min(1, (t.cr ?? 0) / 10e6) * 100)}%, currentColor)">${compactStr(t.cr ?? 0)}</td><td class="num">${t.tok != null ? compactStr(t.tok) : '–'}</td><td class="num" title="${esc(t.avgModel ?? '')} average: ${t.avg1k != null ? '$' + t.avg1k.toFixed(5) : '–'} per 1K" style="${t.hot ? 'color:var(--red)' : ''}">${t.per1k != null ? '$' + t.per1k.toFixed(5) : '–'}</td><td class="num">${money(t.cost)}</td><td class="num">${pctTxt(t.pct5)}${t.spike ? ' ' + pill('Spike', 'red') : ''}</td><td>${status(t.status)}</td></tr>`).join('')}</tbody></table>` : note('No turns match this filter.');
    $('tr-table').querySelectorAll<HTMLElement>('tr.link').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/traces/${tr.dataset.h}`; }));
  }
  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/traces?limit=60' + (pickedSid ? '&sid=' + encodeURIComponent(pickedSid) : '')).catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    data = d; paint();
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); };
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/* ---------------- detail ---------------- */
function renderDetail(root: HTMLElement, arg: string): () => void {
  const [sid, ts] = arg.split('/');
  let dead = false, d: any = null, sel = '';
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><a class="back" href="#/traces">${icon(ArrowLeft, 14)}Traces</a><h1 class="page-title" id="td-title">Loading…</h1><p class="page-sub" id="td-sub"></p></div>
    <div class="hstack" style="gap:12px"><span class="timer" id="td-timer"></span><span id="td-state"></span></div></div>
  <div id="td-kpis"></div>
  <div id="td-speed"></div>
  <div class="row">
    <div class="c8">${card('Waterfall', '<div id="td-wf"></div>', { sub: 'Indented by who started what. Pink bars are subagent work.', right: '<a class="back" id="td-sess" href="#/sessions" style="margin:0">Open session →</a>' })}</div>
    <div class="c4">${card('Step details', '<div id="td-step"></div>')}</div>
  </div>
  <div class="row">
    <div class="c7">${card('Tokens by model request', '<div class="chart" id="td-tok" style="height:260px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Cache read</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>Input & cache write</span><span><i style="background:' + C.green + ';color:' + C.green + '"></i>Output</span></div>')}</div>
    <div class="c5">${card('Tool calls', '<div id="td-tools"></div>')}</div>
  </div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  ($('td-sess') as HTMLAnchorElement).href = `#/sessions/${sid}`;
  const tok = charts.mk($('td-tok'), tokOption([]));

  const spans = (): Span[] => d?.spans ?? [];
  function drawStep() { $('td-step').innerHTML = spanDetail(spans().find((s) => s.id === sel) ?? spans()[0], d?.ts ?? 0); }
  function drawWf() {
    const old = $('td-wf').querySelector('.wf-body') as HTMLElement | null, top = old ? old.scrollTop : 0;
    $('td-wf').innerHTML = waterfall(spans(), d.now, d.live, sel, 400);
    const body = $('td-wf').querySelector('.wf-body') as HTMLElement | null;
    if (body) body.scrollTop = top;
    $('td-wf').querySelectorAll<HTMLElement>('.wf-row').forEach((r) => r.addEventListener('click', () => { sel = r.dataset.id!; drawWf(); drawStep(); }));
  }
  function paint() {
    const T = d.totals;
    $('td-title').textContent = trunc(d.text || '(no prompt text)', 110);
    $('td-sub').textContent = `${d.title} · started ${dayTime(d.ts)} · updated ${clockTime(d.now)}`;
    $('td-state').innerHTML = d.live ? pill('Running', 'blue') : T.err ? pill(`${T.err} failed`, 'red') : pill('Completed', 'green');
    $('td-speed').innerHTML = speedRow(T.sx);
    const mx = d.mix ? Object.entries(d.mix as Record<string, number>).sort((a, b) => b[1] - a[1]) : [];
    const spike5 = !!d.meter?.h5 && d.meter.bar != null && d.meter.h5.pct >= d.meter.bar;
    $('td-kpis').innerHTML = kpiRow([
      { label: 'Duration', value: dur(d.durMs), chip: { svg: icon(Clock, 20) }, sub: d.live ? 'still running' : 'prompt to final reply' },
      { label: 'Model requests', value: String(T.llm), color: 'purple', chip: { svg: icon(Cpu, 20), hue: 'purple' }, sub: `${T.sub} by subagents` },
      { label: 'Tool calls', value: String(T.tools), color: 'green', chip: { svg: icon(Wrench, 20), hue: 'green' }, sub: `${T.err} failed` },
      { label: 'Output tokens', value: compactStr(T.out), chip: { svg: icon(Zap, 20), hue: 'blue' }, sub: `${compactStr(T.in + T.cw)} fresh input · ${tokps(T.tps)} tok/s` },
      { label: 'Cache read', value: compactStr(T.cr), color: 'green', chip: { svg: icon(GitFork, 20), hue: 'green' }, sub: 'tokens served from cache' },
      { label: 'Est. cost', value: money(T.cost), color: 'amber', chip: { svg: icon(Coins, 20) }, sub: 'API rates, estimate' },
    ]) + kpiRow([
      { label: '5h meter', value: pctTxt(d.meter?.h5?.pct), color: 'amber', chip: { svg: icon(Gauge, 20) }, sub: (spike5 ? 'spike · ' : '') + meterSub(d.meter?.h5, 'est. share of the 5-hour window') },
      { label: 'Weekly meter', value: pctTxt(d.meter?.d7?.pct), color: 'purple', chip: { svg: icon(Gauge, 20), hue: 'purple' }, sub: meterSub(d.meter?.d7, 'est. share of the weekly window') },
      { label: 'Biggest cost', value: mx.length ? MIX_LABEL[mx[0][0]] : '–', color: 'green', chip: { svg: icon(Coins, 20) }, sub: mx.map(([k, v]) => `${MIX_LABEL[k]} ${Math.round(v * 100)}%`).join(' · ') || 'no priced requests' },
    ], 'c4');
    drawWf(); drawStep();
    const L = spans().filter((s) => s.kind === 'llm');
    tok.setOption(tokOption(L), true);
    const tools = spans().filter((s) => s.kind === 'tool');
    $('td-tools').innerHTML = tools.length ? `<table class="tbl" style="min-width:0"><thead><tr><th>Tool</th><th>Model</th><th>Input</th><th class="num">Time</th></tr></thead><tbody>${tools.map((s) =>
      `<tr class="link" data-id="${esc(s.id)}" data-toolcall="${esc(s.id)}" title="Click for the full input and result"><td class="strong">${s.err ? `<span style="color:var(--red)">${icon(AlertTriangle, 12)}</span> ` : ''}${esc(s.name)}</td><td class="sub" style="white-space:nowrap">${esc(s.model || '·')}</td><td class="clip sub">${esc(trunc(s.detail ?? '', 60))}</td><td class="num">${s.running ? 'running' : dur(s.end - s.start)}</td></tr>`).join('')}</tbody></table>` : note('This turn made no tool calls.');
    $('td-tools').querySelectorAll<HTMLElement>('tr.link').forEach((r) => r.addEventListener('click', () => { sel = r.dataset.id!; drawWf(); drawStep(); }));
  }
  const tick = setInterval(() => { if (d?.live && !document.hidden) $('td-timer').textContent = `running ${hhmmss(Date.now() - d.ts)}`; else if (d) $('td-timer').textContent = ''; }, 1000);

  async function refresh() {
    if (dead) return;
    try {
      const r = await getJson(`/api/trace/${sid}/${ts}`);
      if (dead) return;
      if (!r) { setTimeout(() => loop.kick(), 700); return; }
      d = r; paint();
      if (!d.live) loop.stop();
    } catch { $('td-title').textContent = 'Trace not found'; $('td-sub').textContent = 'The turn may have been removed, or the server is not reachable.'; }
  }
  const loop = liveLoop(refresh, 5000);
  return () => { dead = true; loop.stop(); clearInterval(tick); charts.dispose(); };
}

function tokOption(L: Span[]) {
  const ax = { color: C.axis, fontSize: 11.5 };
  const x = L.map((s, i) => `#${i + 1}${s.side ? ' sub' : ''}`);
  const bar = (name: string, color: string, data: number[]) => ({ name, type: 'bar' as const, stack: 't', data, itemStyle: { color, borderRadius: 0, shadowBlur: glow(6), shadowColor: color }, barMaxWidth: 26 });
  return {
    animationDuration: 400,
    grid: { left: 52, right: 12, top: 14, bottom: 26 },
    tooltip: { ...tooltipBase, axisPointer: { type: 'shadow' as const, shadowStyle: { color: ptrShadow('rgba(0,208,248,.07)') } }, formatter: (ps: any[]) => tipHtml(`Request ${ps[0].axisValueLabel}`, ps.map((p) => ({ color: p.color, name: p.seriesName, value: fmtNum(p.value) }))) },
    xAxis: { type: 'category' as const, data: x, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: { ...ax, interval: Math.max(0, Math.ceil(x.length / 20) - 1) } },
    yAxis: { type: 'value' as const, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { ...ax, formatter: (v: number) => (v >= 1e6 ? v / 1e6 + 'M' : v >= 1e3 ? v / 1e3 + 'K' : String(v)) } },
    series: [bar('Cache read', C.cyan, L.map((s) => s.cr ?? 0)), bar('Input & cache write', C.purple, L.map((s) => (s.in ?? 0) + (s.cw ?? 0))), bar('Output', C.green, L.map((s) => s.out ?? 0))],
  };
}
