// M5: Context window occupancy and prompt-cache performance.
import { Gauge, Scissors, DatabaseZap, PiggyBank, Layers } from 'lucide';
import { icon, card, bar, pill, ring } from '../ui';
import { signatureOption, C, fmtNum } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, ago, esc } from '../format';
import { kpiRow, chartBag, clockTime, dayTime, note } from './kit';

const kt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(Math.round(n)));
const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

export function renderContext(root: HTMLElement, arg?: string): () => void {
  let dead = false;
  const charts = chartBag();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Context</h1><p class="page-sub" id="cx-sub">Reading sessions…</p></div>
    <div class="hstack" style="gap:12px"><span class="live"><span class="dot ping"></span>Live</span><select class="pick" id="cx-pick" aria-label="Session"></select></div></div>
  <div id="cx-kpis"></div>
  <div class="row"><div class="c12" id="cx-live"></div></div>
  <div class="row"><div class="c12" id="cx-heavy"></div></div>
  <div class="row">
    <div class="c8">${card('Context in use over time', '<div class="chart" id="cx-occ" style="height:290px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Tokens in context</span><span><i style="background:' + C.amber + ';color:' + C.amber + '"></i>Compaction</span></div>', { sub: 'Main-thread requests. A drop after a dashed line is a compaction.' })}</div>
    <div class="c4">${card('Right now', '<div id="cx-now"></div>')}</div>
  </div>
  <div class="row">
    <div class="c8">${card('Cache hit rate', '<div class="chart" id="cx-cache" style="height:240px"></div><div class="legend"><span><i style="background:' + C.green + ';color:' + C.green + '"></i>Cache hit (%)</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>Cache written (tokens)</span></div>', { sub: 'Share of each request\'s prompt served from the cache.' })}</div>
    <div class="c4">${card('Cache savings, 24 hours', '<div class="stat-list" id="cx-save"></div>', { sub: 'Compared with paying full input price for cached tokens.' })}</div>
  </div>
  <div class="row"><div class="c12">${card('Context fill by session', '<div id="cx-table"></div>', { sub: 'Click a session to chart it above.' })}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const occ = charts.mk($('cx-occ'), signatureOption({ x: [''], a: { name: 'Context', data: [0] } }));
  const cache = charts.mk($('cx-cache'), signatureOption({ x: [''], a: { name: 'Hit', data: [0] }, b: { name: 'Written', data: [0] } }));
  const pick = $('cx-pick') as HTMLSelectElement;
  pick.addEventListener('change', () => { location.hash = `#/context/${pick.value}`; });

  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/context' + (arg ? `?sid=${arg}` : '')).catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const S: any[] = d.series;
    $('cx-sub').textContent = `${d.title || 'No session'} · ${d.model} · ${compactStr(d.window)} window · updated ${clockTime(d.now)}`;
    pick.innerHTML = d.sessions.map((s: any) => `<option value="${s.id}"${s.id === d.sid ? ' selected' : ''}>${esc(s.title || s.id.slice(0, 8))}${s.state === 'live' ? ' · live' : ''}</option>`).join('');
    const cur = S[S.length - 1], peak = Math.max(0, ...S.map((p) => p.used));
    const full = d.sessions.filter((s: any) => s.curPct > 85).length;
    $('cx-kpis').innerHTML = kpiRow([
      { label: 'Context used', value: cur ? cur.pct.toFixed(0) : '–', unit: '%', color: cur && cur.pct > 85 ? 'amber' : 'cyan', chip: { svg: icon(Gauge, 20), hue: 'blue' }, series: S.slice(-40).map((p) => p.used), sub: cur ? `${compactStr(cur.used)} of ${compactStr(d.window)}` : '' },
      { label: 'Peak this session', value: compactStr(peak), color: 'purple', chip: { svg: icon(Layers, 20), hue: 'purple' }, sub: `${pct((peak / d.window) * 100)} of the window` },
      { label: 'Compactions', value: String(d.marks.length), color: 'amber', chip: { svg: icon(Scissors, 20) }, sub: d.marks.length ? `last ${clockTime(d.marks[d.marks.length - 1].ts)}` : 'none yet' },
      { label: 'Cache hit', value: pct(d.cacheDay.hit * 100), unit: '', color: 'green', chip: { svg: icon(DatabaseZap, 20), hue: 'green' }, sub: 'last 24 hours, all sessions' },
      { label: 'Cache savings', value: money(d.cacheDay.saved), color: 'green', chip: { svg: icon(PiggyBank, 20), hue: 'green' }, sub: 'last 24 hours, estimate' },
      { label: 'Sessions above 85%', value: String(full), color: full ? 'amber' : 'cyan', chip: { svg: icon(Gauge, 20), hue: 'blue' }, sub: `of ${d.sessions.length} recent` },
    ]);
    $('cx-live').innerHTML = liveCard(d.live, d.sid, d.now);
    $('cx-live').querySelectorAll<HTMLElement>('.lv-grp-head').forEach((b) => b.addEventListener('click', () => {
      const g = b.parentElement as HTMLElement, body = g.querySelector('.lv-grp-body') as HTMLElement, open = body.hidden;
      body.hidden = !open; b.setAttribute('aria-expanded', String(open));
      if (open) lvCollapsed.delete(g.dataset.g!); else lvCollapsed.add(g.dataset.g!);
      try { localStorage.setItem(LV_KEY, JSON.stringify([...lvCollapsed])); } catch { /* storage unavailable */ }
    }));
    $('cx-live').querySelectorAll<HTMLElement>('.lv-row').forEach((r) => r.addEventListener('click', () => { location.hash = `#/context/${r.dataset.id}`; }));
    $('cx-heavy').innerHTML = heavyCard(d.heavy, d.marks);
    const x = S.map((p) => clockTime(p.ts));
    const near = (ts: number) => { let k = 0; for (let i = 0; i < S.length; i++) if (Math.abs(S[i].ts - ts) < Math.abs(S[k].ts - ts)) k = i; return x[k]; };
    occ.setOption(signatureOption({ x, a: { name: 'Context', data: S.map((p) => p.used), fmt: fmtNum }, yMax: d.window, marks: d.marks.map((m: any) => ({ x: near(m.ts), name: 'compact' })) }), true);
    cache.setOption(signatureOption({ x, a: { name: 'Cache hit (%)', data: S.map((p) => +(p.hit * 100).toFixed(1)), fmt: (v) => v + '%', color: C.green }, b: { name: 'Cache written', data: S.map((p) => p.cw), fmt: fmtNum }, yMax: 100, yFmt: (v) => v + '%' }), true);
    $('cx-now').innerHTML = cur ? `<div class="ring-wrap">${ring(cur.pct, 'used', cur.pct > 85 ? 'amber' : 'cyan')}<div class="stat-list"><div class="r">Fresh input<b>${int(cur.in + cur.cw)}</b></div><div class="r">Cache read<b class="g">${int(cur.cr)}</b></div><div class="r">Free<b>${int(Math.max(0, d.window - cur.used))}</b></div></div></div>` : note('No messages in this session.');
    const cd = d.cacheDay;
    $('cx-save').innerHTML = `<div class="r">Cached tokens read<b class="g">${compactStr(cd.cr)}</b></div><div class="r">All prompt tokens<b>${compactStr(cd.all)}</b></div><div class="r">Hit rate<b class="g">${pct(cd.hit * 100)}</b></div><div class="r">Estimated savings<b class="g">${money(cd.saved)}</b></div>`;
    $('cx-table').innerHTML = `<table class="tbl"><thead><tr><th>Session</th><th>Model</th><th class="num">Window</th><th class="num">Now</th><th style="width:200px">Fill</th><th class="num">Peak</th><th class="num">Compactions</th><th>Last active</th><th>State</th></tr></thead><tbody>${d.sessions.map((s: any) =>
      `<tr class="link" data-id="${s.id}"><td class="strong clip">${esc(s.title || s.id.slice(0, 8))}</td><td>${esc(s.model)}</td><td class="num">${compactStr(s.window)}</td><td class="num">${compactStr(s.cur)}</td><td>${bar(s.curPct, s.curPct > 85 ? 'amber' : '', [85])}</td><td class="num">${pct(s.peakPct)}</td><td class="num">${s.compactions}</td><td>${ago(s.last, d.now)}</td><td>${s.state === 'live' ? pill('Live', 'green') : s.state === 'idle' ? pill('Idle', 'amber') : pill('Done', 'grey')}</td></tr>`).join('')}</tbody></table>`;
    $('cx-table').querySelectorAll<HTMLElement>('tr.link').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/context/${tr.dataset.id}`; scrollTo({ top: 0, behavior: 'smooth' }); }));
    void dayTime;
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}

// Why a long session costs more per message, with a fresh start for comparison. Every size is measured from the logs.
function heavyCard(h: any, marks: any[]): string {
  if (!h) return '';
  const max = Math.max(h.cur, h.fresh, ...h.pts.map((p: any) => p.used), 1);
  const w = (n: number) => Math.max(1.5, (n / max) * 100).toFixed(1);
  const unit = h.byPrompt ? 'Prompt ' : 'Request ';
  const rows = h.pts.map((p: any, i: number) => `<div class="hv-row"><span class="hv-l">${i === h.pts.length - 1 ? 'Now, ' + unit.toLowerCase() + p.n : unit + p.n}</span><span class="hv-track"><i style="width:${w(p.used)}%;background:${C.purple}"></i></span><b>${kt(p.used)}</b></div>`).join('');
  const grow = h.growth.map((g: any) => `<div class="hv-row"><span class="hv-l">${esc(g.key)}</span><span class="hv-track"><i style="width:${Math.max(1.5, (g.tokens / Math.max(1, h.cur)) * 100).toFixed(1)}%;background:${C.cyan}"></i></span><b>${kt(g.tokens)}</b></div>`).join('');
  const hr = h.hour;
  const cm = marks.filter((m) => m.from > 0);
  const peaks = cm.map((m) => m.from).sort((a, b) => a - b);
  const comp = cm.length >= 2 ? `<div class="hv-foot">It was <b>compacted ${cm.length} times</b>: the context climbed to about <b>${kt(peaks[peaks.length >> 1])}</b>, was summarised down, then started climbing again. Each compaction re-sends the whole conversation once more just to summarise it, so repeated climbs cost more than a new session.</div>` : '';
  const save = h.extraPerMsg > 0
    ? `A typical session of yours re-reads about <b>${kt(h.fresh)}</b> per request by its 3rd prompt. This one re-reads <b>${kt(h.extraPerMsg)} more</b> on every request.`
    : 'This session is no bigger than a typical one, so there is nothing to save yet.';
  return card('Why requests get more expensive in this session', `
    <div class="hv-lead">Every request re-sends the <b>whole conversation</b> to the model. This session re-reads <b>${kt(h.cur)}</b> tokens on every request</div>
    <div class="hv-cols">
      <div><div class="hv-h">Tokens re-read per request as the session grew</div>${rows}
        <div class="hv-row"><span class="hv-l">Typical, at its 3rd prompt</span><span class="hv-track"><i style="width:${w(h.fresh)}%;background:${C.green}"></i></span><b>${kt(h.fresh)}</b></div>
        <p class="hv-note">${save}</p></div>
      <div><div class="hv-h">What it is made of (${kt(h.cur)})</div>
        <div class="hv-row"><span class="hv-l">Startup: rules, skills, tool lists</span><span class="hv-track"><i style="width:${Math.max(1.5, (h.startup / Math.max(1, h.cur)) * 100).toFixed(1)}%;background:${C.amber}"></i></span><b>${kt(h.startup)}</b></div>${grow}
        <p class="hv-note">Each tool result stays in the conversation and is re-sent on every later request.</p></div>
    </div>
    <div class="hv-foot">Last hour: <b>${int(hr.calls)}</b> requests re-read <b>${kt(hr.reread)}</b> tokens${hr.extra > 0 ? `, <b>${kt(hr.extra)}</b> of it beyond what a typical session carries` : ''}.</div>${comp}`,
    { sub: 'Measured from your logs.' });
}

const LV_KEY = 'tokenhud.live.collapsed';
const lvCollapsed = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(LV_KEY) || '[]'); } catch { return []; } })());

// Your sessions right now: is the cache warm, what the next message costs, how close auto-compact is. All measured from the logs.
function liveCard(L: any, sid: string, now: number): string {
  if (!L || !L.sessions.length) return '';
  const VERDICT: Record<string, [string, string]> = { ok: ['Fine', 'green'], watch: ['Watch', 'amber'], big: ['Near auto-compact', 'red'] };
  const mins = (v: number) => (v >= 90 ? `${(v / 60).toFixed(1)} h` : `${Math.max(1, Math.round(v))} min`);
  const row = (x: any) => {
    const sc = (n: number) => Math.min(100, (n / x.win) * 100).toFixed(1);
    const col = x.status === 'big' ? C.red : x.status === 'watch' ? C.amber : C.green;
    const [vt, vh] = VERDICT[x.status];
    const cost = `the next message rewrites all <b>${kt(x.cur)}</b> (${x.ratio.toFixed(1)}x a brand new session)`;
    const cache = x.cache.warm
      ? `<b class="lv-ok">Cache warm</b>, expires in ${mins(x.cache.leftMin)} unless you send a message. If it lapses, ${cost}.`
      : `<b class="lv-warn">Cache lapsed</b> ${mins(x.cache.coldMin)} ago: ${cost}.`;
    const fc = x.promptsToCompact === 0 ? 'Past the point where auto-compact starts.' : x.promptsToCompact != null ? `About <b>${x.promptsToCompact}</b> prompt${x.promptsToCompact === 1 ? '' : 's'} until auto-compact, at +${kt(x.perPrompt)} per prompt.` : 'Too few prompts to forecast auto-compact yet.';
    const cm = x.compactions ? ` Already compacted ${x.compactions} time${x.compactions === 1 ? '' : 's'}.` : '';
    const rw = x.rewrite ? `<div><b class="lv-warn">Whole conversation rewritten</b> at ${clockTime(x.rewrite.ts)} (${kt(x.rewrite.tokens)} tokens): ${esc(x.rewrite.cause)}.</div>` : '';
    const why = x.why.map((g: any) => `${esc(g.key.toLowerCase())} ${kt(g.tokens)}`).join(', ');
    const steps = x.steps.map((g: any) => `${esc(g.what)} +${kt(g.tokens)}`).join(', ');
    const mv = x.advice ? `<div class="lv-move ${x.advice.verdict}"><b>Best move: ${esc(x.advice.head)}.</b> ${esc(x.advice.say)}</div>` : '';
    return `<div class="lv-row${x.sid === sid ? ' sel' : ''}" data-id="${x.sid}" title="Click to open this session below">
      <div class="lv-who"><b class="clip">${esc(x.title || x.sid.slice(0, 8))}</b><span class="muted">${esc(x.model)} · ${x.state === 'live' ? 'live now' : ago(x.last, now)}</span><span class="muted">${kt(x.cur)} of ${kt(x.win)} · ${Math.round(x.pct)}%</span></div>
      <div class="lv-gauge"><div class="hv-track lv-track"><i style="width:${sc(x.cur)}%;background:${col}"></i></div>
        <span class="lv-tick" style="left:${sc(L.startup)}%"></span><span class="lv-tick comp" style="left:${sc(x.win * 0.83)}%"></span>
        <span class="lv-lab start" style="left:${sc(L.startup)}%">new session ${kt(L.startup)}</span><span class="lv-lab comp" style="left:${sc(x.win * 0.83)}%">auto-compact</span></div>
      <div class="lv-say">${pill(vt, vh as any)}<div>${cache}</div>${mv}${rw}<div>${fc}${cm}</div>${steps ? `<div class="muted">Biggest single additions: ${steps}.</div>` : ''}${why ? `<div class="muted">Grew mostly from: ${why}.</div>` : ''}</div>
    </div>`;
  };
  // Sessions with a request in the last 60 minutes are active; the rest are idle. Each group collapses and remembers it.
  const act = L.sessions.filter((x: any) => now - x.last <= 3600e3), idle = L.sessions.filter((x: any) => now - x.last > 3600e3);
  const group = (id: string, title: string, list: any[], empty: string) => `<div class="lv-grp" data-g="${id}"><button type="button" class="lv-grp-head" aria-expanded="${!lvCollapsed.has(id)}"><span class="lv-chev">▾</span><b>${title}</b><span class="muted">${list.length} session${list.length === 1 ? '' : 's'}</span></button><div class="lv-grp-body"${lvCollapsed.has(id) ? ' hidden' : ''}>${list.length ? list.map(row).join('') : `<p class="hv-note">${empty}</p>`}</div></div>`;
  const rows = group('active', 'Active', act, 'No session has sent a request in the last 60 minutes.') + (idle.length ? group('idle', 'Idle for over 60 minutes', idle, '') : '');
  return card('Your sessions right now', `${rows}<p class="hv-note">The bar is what one request of that session re-reads, against its window. The cache lets the model re-read it at a fraction of the price; once it lapses (${L.sessions[0].cache.ttlMin >= 60 ? '1 hour' : '5 minutes'} without a message here) the next message pays full price to write it again. A cache rewrite before that point means something at the start of the conversation changed. Auto-compact starts near 83% of the window. <b>Best move</b> prices resuming against a new session at your own rates: the cache rewrite, cheaper reads on every later request, future cache lapses (at your measured rate), and the auto-compact the bigger session reaches sooner (what a compaction costs is measured from your logs). It assumes a new session reaches the usual ${kt(L.normal)} by its 3rd prompt. Not priced: details that only live in the old conversation.</p>`,
    { sub: 'Sessions with a request in the last 6 hours. Click one to see what it is made of.' });
}
