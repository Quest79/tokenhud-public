// M4: Sessions list and live session detail.
import { Layers, Radio, Zap, Coins, Wrench, GitFork, Clock, ArrowLeft, Gauge, Activity } from 'lucide';
import { icon, ring, seg, wireSeg, card, pill, bar } from '../ui';
import { signatureOption, C, fmtNum } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, dur, ago, esc, tokps, tpsAvg } from '../format';
import { waterfall, spanDetail, type Span } from '../waterfall';
import { kpiRow, speedRow, chartBag, clockTime, dayTime, hhmmss, trunc, note, type Tile } from './kit';

const FILTERS = ['all', 'live', '24h', '7d'];

export function renderSessions(root: HTMLElement, arg?: string): () => void {
  return arg ? renderDetail(root, arg) : renderList(root);
}

/* ---------------- list ---------------- */
function renderList(root: HTMLElement): () => void {
  let filter = localStorage.getItem('th.sfilter') || 'all';
  if (!FILTERS.includes(filter)) filter = 'all';
  let data: any = null, dead = false;
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Sessions</h1><p class="page-sub" id="ss-sub">Reading sessions…</p></div>
    <div class="hstack" style="gap:12px"><span class="live" id="ss-live"><span class="dot ping"></span>Live</span>${seg(['ALL', 'LIVE', '24H', '7D'], FILTERS.indexOf(filter))}</div></div>
  <div id="ss-kpis"></div>
  <div class="row"><div class="c12">${card('All sessions', '<div id="ss-table"></div>', { sub: 'Newest first. Click a session to follow it live.' })}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  wireSeg(root, (i) => { filter = FILTERS[i]; localStorage.setItem('th.sfilter', filter); if (data) paint(); });

  function paint() {
    const now = data.now as number;
    const all: any[] = data.sessions;
    const list = all.filter((s) => filter === 'all' || (filter === 'live' ? s.state === 'live' : now - s.last < (filter === '24h' ? 864e5 : 6048e5)));
    const sum = (f: (s: any) => number) => list.reduce((a, s) => a + f(s), 0);
    $('ss-sub').textContent = `${list.length} of ${all.length} sessions · updated ${clockTime(now)}`;
    const liveN = all.filter((s) => s.state === 'live').length;
    ($('ss-live') as HTMLElement).style.visibility = liveN ? 'visible' : 'hidden';
    $('ss-kpis').innerHTML = kpiRow([
      { label: 'Sessions', value: String(list.length), chip: { svg: icon(Layers, 20) }, sub: `${liveN} live now` },
      { label: 'Requests', value: compactStr(sum((s) => s.req)), color: 'purple', chip: { svg: icon(Activity, 20), hue: 'purple' }, sub: `${compactStr(sum((s) => s.sub))} by subagents` },
      { label: 'Output tokens', value: compactStr(sum((s) => s.out)), chip: { svg: icon(Zap, 20), hue: 'blue' }, sub: `${compactStr(sum((s) => s.total))} processed · ${tokps(tpsAvg(list, (s: any) => s.out, (s: any) => s.tps))} tok/s` },
      { label: 'Tool calls', value: compactStr(sum((s) => s.tools)), color: 'green', chip: { svg: icon(Wrench, 20), hue: 'green' }, sub: `${int(sum((s) => s.err))} failed` },
      { label: 'Est. cost', value: money(sum((s) => s.cost)), color: 'amber', chip: { svg: icon(Coins, 20) }, sub: 'API rates, estimate' },
      { label: 'Longest session', value: dur(Math.max(0, ...list.map((s) => s.durMs))), color: 'purple', chip: { svg: icon(Clock, 20), hue: 'purple' }, sub: 'first to last message' },
    ]);
    $('ss-table').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Session</th><th>Project</th><th>Model</th><th class="num">Req</th><th class="num">Subagent</th><th class="num">Tools</th><th class="num">Output</th><th class="num">tok/s</th><th>Context</th><th class="num">Est.</th><th class="num">Length</th><th>Last active</th><th>State</th></tr></thead><tbody>${list.map((s) =>
      `<tr class="link${(s as any).src === 'codex' ? ' cx' : ''}" data-id="${s.id}"><td class="strong clip">${(s as any).src === 'codex' ? '<span class="cx-tag">Codex</span>' : ''}${esc(s.title || '(untitled)')}</td><td>${esc(s.project)}${s.branch ? `<span class="muted"> · ${esc(s.branch)}</span>` : ''}</td><td>${esc(s.models.join(', '))}</td><td class="num">${int(s.req)}</td><td class="num">${s.sub ? int(s.sub) : '–'}</td><td class="num">${int(s.tools)}${s.err ? `<span style="color:var(--red)"> (${s.err})</span>` : ''}</td><td class="num">${compactStr(s.out)}</td><td class="num">${tokps(s.tps)}</td><td style="width:110px">${bar(s.ctxPct, s.ctxPct > 85 ? 'amber' : '')}</td><td class="num">${money(s.cost)}</td><td class="num">${dur(s.durMs)}</td><td>${ago(s.last, now)}</td><td>${s.state === 'live' ? pill('Live', 'green') : s.state === 'idle' ? pill('Idle', 'amber') : pill('Done', 'grey')}</td></tr>`).join('')}</tbody></table>` : note('No sessions match this filter.');
    $('ss-table').querySelectorAll<HTMLElement>('tr.link').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/sessions/${tr.dataset.id}`; }));
  }
  async function refresh() {
    if (dead) return;
    try {
      const d = await getJson('/api/sessions');
      if (!d) { $('ss-sub').textContent = 'Reading transcripts…'; setTimeout(() => loop.kick(), 700); return; }
      data = d; paint();
    } catch { $('ss-sub').textContent = "Can't reach the TokenHUD server."; }
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); };
}

/* ---------------- detail ---------------- */
function renderDetail(root: HTMLElement, sid: string): () => void {
  let dead = false, d: any = null, sel = '';
  const charts = chartBag();
  let sig: ReturnType<typeof charts.mk> | null = null;
  root.innerHTML = `
  <div class="page-head"><div><a class="back" href="#/sessions">${icon(ArrowLeft, 14)}Sessions</a><h1 class="page-title" id="sd-title">Loading…</h1><p class="page-sub" id="sd-sub"></p></div>
    <div class="hstack" style="gap:12px"><span class="timer" id="sd-timer"></span><span id="sd-hook"></span><span id="sd-state"></span></div></div>
  <div id="sd-plan"></div>
  <div id="sd-kpis"></div>
  <div id="sd-speed"></div>
  <div class="row">
    <div class="c8">${card('Execution trace', '<div id="sd-wf"></div>', { sub: 'Latest turn. Bars show when each model request and tool call ran.', right: '<a class="back" id="sd-open" href="#/traces" style="margin:0">Open in Traces →</a>' })}</div>
    <div class="c4"><div class="stack" style="gap:var(--gap)">${card('Step details', '<div id="sd-step"></div>', { cls: 'flat' })}${card('Context window', '<div id="sd-ctx"></div>', { cls: 'flat' })}</div></div>
  </div>
  <div class="row">
    <div class="c8">${card('Cumulative output & context', '<div class="chart" id="sd-sig" style="height:280px"></div><div class="legend"><span><i style="background:${C.cyan};color:${C.cyan}"></i>Output tokens (cumulative)</span><span><i style="background:${C.purple};color:${C.purple}"></i>Context in use (main thread)</span></div>')}</div>
    <div class="c4">${card('Session info', '<div class="stat-list" id="sd-info"></div>')}</div>
  </div>
  <div class="row">
    <div class="c7">${card('Conversation', '<div class="stream" id="sd-stream"></div>', { sub: 'Prompts, replies and tool calls as they happen', right: '<span class="live" id="sd-live2"><span class="dot ping"></span>Live</span>' })}</div>
    <div class="c5"><div class="stack" style="gap:var(--gap)">${card('Tool calls', '<div id="sd-tools"></div>', { cls: 'flat' })}${card('Subagents', '<div id="sd-agents"></div>', { cls: 'flat' })}</div></div>
  </div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  sig = charts.mk($('sd-sig'), signatureOption({ x: [''], a: { name: 'Output (cumulative)', data: [0] }, b: { name: 'Context in use', data: [0] } }));

  function drawStep() {
    const spans: Span[] = d?.trace?.spans ?? [];
    $('sd-step').innerHTML = spanDetail(spans.find((s) => s.id === sel) ?? (spans.length > 1 ? spans[spans.length - 1] : spans[0]), d?.trace?.ts ?? 0);
  }
  function drawWf() {
    const t = d.trace;
    if (!t) { $('sd-wf').innerHTML = note('No turn recorded yet.'); return; }
    const keep = $('sd-wf').querySelector('.wf-body') as HTMLElement | null;
    const top = keep ? keep.scrollTop : 0, atEnd = keep ? keep.scrollHeight - keep.scrollTop - keep.clientHeight < 40 : true;
    $('sd-wf').innerHTML = waterfall(t.spans, d.now, t.live, sel);
    const body = $('sd-wf').querySelector('.wf-body') as HTMLElement;
    if (body) body.scrollTop = atEnd ? body.scrollHeight : top;
    $('sd-wf').querySelectorAll<HTMLElement>('.wf-row').forEach((r) => r.addEventListener('click', () => { sel = r.dataset.id!; drawWf(); drawStep(); }));
    ($('sd-open') as HTMLAnchorElement).href = `#/traces/${sid}/${t.ts}`;
  }
  function paint() {
    const T = d.totals, live = d.state === 'live';
    $('sd-title').textContent = d.title || '(untitled)';
    $('sd-sub').textContent = `${d.project}${d.branch ? ' · ' + d.branch : ''} · ${d.models.join(', ')} · updated ${clockTime(d.now)}`;
    const hk = d.hook as { tool: string; thinking: boolean; ageMs: number } | null;
    $('sd-hook').innerHTML = hk && live ? pill(hk.tool ? `Running ${esc(hk.tool.replace(/^mcp__/, '').replace(/__/g, ' · '))}` : 'Thinking', 'blue') : '';
    $('sd-state').innerHTML = live ? pill('Live', 'green') : d.state === 'idle' ? pill('Idle ' + ago(d.last, d.now).replace(' ago', ''), 'amber') : pill('Done · ' + ago(d.last, d.now), 'grey');
    ($('sd-live2') as HTMLElement).style.visibility = live ? 'visible' : 'hidden';
    $('sd-speed').innerHTML = speedRow(T.sx);
    type PlanWin = { pct: number; share: number; reading: number; ts: number };
    const plan = (label: string, w: { pct: number; windows: PlanWin[]; unreadUsd: number } | null, color: 'cyan' | 'purple'): Tile => ({
      label, value: w ? (w.pct < 10 ? w.pct.toFixed(1) : String(Math.round(w.pct))) : '–', unit: '%', color: w && w.pct >= 80 ? 'amber' : color, chip: { svg: icon(Clock, 20), hue: 'blue' },
      sub: w ? `Estimate: ${w.windows.length === 1 ? `${Math.round(w.windows[0].share * 100)}% of the window's cost × meter ${w.windows[0].reading}% (read ${clockTime(w.windows[0].ts)})` : `${w.windows.map((x) => `${Math.round(x.share * 100)}% × ${x.reading}%`).join(' + ')}`}${w.unreadUsd > 0.005 ? ` · $${w.unreadUsd.toFixed(2)} had no reading` : ''}` : 'No meter reading covers this session',
    });
    $('sd-plan').innerHTML = kpiRow([plan('This session, 5-hour', d.plan5h, 'cyan'), plan('This session, weekly', d.plan7d, 'purple')], 'c6');
    $('sd-kpis').innerHTML = kpiRow([
      { label: 'Output tokens', value: compactStr(T.out), chip: { svg: icon(Zap, 20) }, series: d.series.slice(-40).map((x: any) => x.out), sub: `${compactStr(T.think)} thinking · ${tokps(T.tps)} tok/s` },
      { label: 'Requests', value: int(T.req), color: 'purple', chip: { svg: icon(Activity, 20), hue: 'purple' }, sub: `${d.turns} turns` },
      { label: 'Context used', value: d.ctx ? d.ctx.pct.toFixed(0) : '–', unit: '%', color: d.ctx && d.ctx.pct > 85 ? 'amber' : 'cyan', chip: { svg: icon(Gauge, 20), hue: 'blue' }, sub: d.ctx ? `${compactStr(d.ctx.used)} of ${compactStr(d.ctx.window)}` : '' },
      { label: 'Est. cost', value: money(T.cost), color: 'amber', chip: { svg: icon(Coins, 20) }, series: d.series.slice(-40).map((x: any) => x.cumCost), sub: 'API rates, estimate' },
      { label: 'Tool calls', value: int(d.toolCount), color: 'green', chip: { svg: icon(Wrench, 20), hue: 'green' }, sub: `${d.tools.filter((t: any) => t.err).length} failed recently` },
      { label: 'Subagents', value: int(d.agents.length), color: 'purple', chip: { svg: icon(GitFork, 20), hue: 'purple' }, sub: `${compactStr(d.agents.reduce((a: number, x: any) => a + x.out, 0))} output` },
    ]);
    drawWf(); drawStep();
    $('sd-ctx').innerHTML = d.ctx ? `<div class="ring-wrap">${ring(d.ctx.pct, 'used', d.ctx.pct > 85 ? 'amber' : 'cyan')}<div class="stat-list"><div class="r">Input<b>${int(d.ctx.in + d.ctx.cw)}</b></div><div class="r">Cache read<b class="g">${int(d.ctx.cr)}</b></div><div class="r">Window<b>${int(d.ctx.window)}</b></div></div></div>` : note('No main-thread messages.');

    const S = d.series;
    const x = S.map((p: any) => clockTime(p.ts));
    sig!.setOption(signatureOption({ x, a: { name: 'Output (cumulative)', data: S.map((p: any) => p.cum), fmt: fmtNum }, b: { name: 'Context in use', data: S.map((p: any) => p.ctx), fmt: fmtNum, color: C.purple } }));

    const r = (k: string, v: string) => `<div class="r">${k}<b style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.replace(/<[^>]+>/g, ''))}">${v}</b></div>`;
    $('sd-info').innerHTML = r('Project', esc(d.project)) + r('Folder', esc(d.cwd || '–')) + r('Branch', esc(d.branch || '–')) + r('Model', esc(d.models.join(', '))) + r('Effort', esc(d.effort || 'default')) + r('Client', esc(d.app || '–')) + r('Version', esc(d.version || '–')) + r('Started', dayTime(d.first)) + r('Last message', dayTime(d.last)) + r('Cache read', compactStr(T.cr)) + r('Session id', `<span style="font-family:var(--mono);font-size: calc(11.5px * var(--fs, 1))">${sid.slice(0, 13)}…</span>`);

    const el = $('sd-stream');
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = d.stream.map((m: any) => m.kind === 'tool'
      ? `<div class="msg tool${m.err ? ' err' : ''}"><time>${clockTime(m.ts)}</time><div class="b"><i>${esc(m.name)}</i><span>${esc(trunc(m.text, 140))}</span><small>${m.running ? 'running…' : m.dur ? dur(m.dur) : ''}</small></div></div>`
      : `<div class="msg ${m.kind}"><time>${clockTime(m.ts)}</time><div class="b"><span class="k">${m.kind === 'prompt' ? 'You' : 'Claude' + (m.model ? ' · ' + esc(m.model) : '')}</span>${esc(m.text)}</div></div>`).join('') + (live ? '<div class="msg"><time></time><div class="b" style="border:0;background:none;padding:2px 0"><span class="cursor"></span></div></div>' : '');
    if (stick) el.scrollTop = el.scrollHeight;

    const tools = [...d.tools].reverse();
    $('sd-tools').innerHTML = tools.length ? tools.slice(0, 12).map((t: any) =>
      `<div class="callrow" style="cursor:pointer" data-toolcall="${esc(t.id)}" title="Click for the full input and result"><span class="dot ${!t.endTs && d.now - t.ts < 6e5 ? 'ping' : ''}" style="color:${t.err ? 'var(--red)' : !t.endTs ? 'var(--cyan)' : 'var(--green)'}"></span><b>${esc(t.name)}</b><span class="in">${esc(trunc(t.input, 90))}</span><span class="d">${t.endTs ? dur(t.endTs - t.ts) : d.now - t.ts < 6e5 ? 'running' : '–'}</span></div>`).join('') : note('No tool calls yet.');
    $('sd-agents').innerHTML = d.agents.length ? [...d.agents].reverse().slice(0, 8).map((a: any) =>
      `<div class="callrow"><span class="dot" style="color:${a.endTs ? 'var(--pink)' : 'var(--cyan)'}"></span><b>${esc(a.name)}</b><span class="in">${esc(trunc(a.input, 80))}</span><span class="d">${a.msgs} req · ${compactStr(a.out)} out</span></div>`).join('') : note('This session has not started any subagents.');
  }
  const tick = setInterval(() => {
    const t = d?.trace;
    if (!t || document.hidden) return;
    const live = t.live || d.state === 'live';
    $('sd-timer').textContent = live ? `running ${hhmmss(Date.now() - t.ts)}` : '';
  }, 1000);

  async function refresh() {
    if (dead) return;
    try {
      const r = await getJson(`/api/sessions/${sid}`);
      if (dead) return;
      if (!r) { $('sd-sub').textContent = 'Reading transcripts…'; setTimeout(() => loop.kick(), 700); return; }
      d = r; paint();
    } catch { $('sd-title').textContent = 'Session not found'; $('sd-sub').textContent = 'It may have been removed, or the server is not reachable.'; }
  }
  const loop = liveLoop(refresh, 10000);
  return () => { dead = true; loop.stop(); clearInterval(tick); charts.dispose(); };
}
