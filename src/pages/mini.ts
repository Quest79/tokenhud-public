// Tray popover (#/mini): the small version of the dashboard. Fixed 360x344, no scrolling, no tabs.
import { Pin, ExternalLink } from 'lucide';
import { getOverview, onStatus, onPause, type Overview } from '../api';
import { liveLoop } from '../live';
import { icon, logo, ring, bar, spark } from '../ui';
import { compactStr, money, ago, esc, tokps } from '../format';

declare global { interface Window { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: object) => Promise<unknown> } } }
const invoke = (cmd: string, args?: object) => window.__TAURI_INTERNALS__?.invoke(cmd, args);

export function renderMini(root: HTMLElement): () => void {
  document.documentElement.classList.add('is-mini');
  let pinned = false, paused = false, online = false;
  let last: Overview | undefined;
  root.innerHTML = `
  <div class="mini-card" id="mn-card">
    <div class="mini-head" data-tauri-drag-region>
      <span class="mini-logo">${logo()}</span><b data-tauri-drag-region>TokenHUD</b>
      <span class="mini-state" id="mn-state"></span>
      <span class="mini-btns">
        <button id="mn-pin" title="Pin this window (stays open, drag to move)">${icon(Pin, 14)}</button>
        <button id="mn-open" title="Open the dashboard">${icon(ExternalLink, 14)}</button>
      </span>
    </div>
    <div class="mini-body">
      <div class="mini-top">
        <div class="mini-ring" id="mn-ring"></div>
        <div class="mini-act"><div class="mini-title" id="mn-title">Loading…</div><div class="mini-sub" id="mn-model"></div><div class="mini-now" id="mn-now"></div></div>
      </div>
      <div class="mini-spark"><div class="mini-spark-top"><span>Output tokens / min</span><b id="mn-rate">0</b></div><div id="mn-spark" class="mini-spark-svg"></div></div>
      <div class="mini-meters"><div><div class="mini-m-top"><span>Output, 5 h</span><b id="mn-5h"></b></div><div id="mn-5hb"></div></div><div><div class="mini-m-top"><span>Output, 7 d</span><b id="mn-7d"></b></div><div id="mn-7db"></div></div></div>
      <div class="mini-foot"><div><span>Today</span><b id="mn-tok"></b></div><div><span>Est. cost</span><b id="mn-cost"></b></div><div><span>Live</span><b id="mn-live"></b></div></div>
    </div>
  </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const stateEl = $('mn-state');

  const drawState = (d?: Overview) => {
    const live = (d?.liveSessions ?? 0) > 0;
    stateEl.innerHTML = !online ? '<i class="dot off"></i>Offline' : paused ? '<i class="dot amber"></i>Paused' : live ? '<i class="dot ping"></i>Live' : '<i class="dot idle"></i>Idle';
  };
  const offStatus = onStatus((s) => { online = s === 'online'; drawState(last); });
  const offPause = onPause((p) => { paused = p; drawState(last); });

  $('mn-pin').addEventListener('click', (e) => { e.stopPropagation(); pinned = !pinned; $('mn-pin').classList.toggle('on', pinned); invoke('set_mini_pinned', { on: pinned }); });
  $('mn-open').addEventListener('click', (e) => { e.stopPropagation(); invoke('open_dashboard'); });
  $('mn-card').addEventListener('click', () => invoke('open_dashboard'));

  function paint(d: Overview) {
    last = d; drawState(d);
    const c = d.ctx, a = d.activity;
    $('mn-ring').innerHTML = c ? ring(c.pct, 'context', c.pct > 85 ? 'amber' : 'cyan') : ring(0, 'context');
    $('mn-title').textContent = c ? (c.title || 'Untitled session') : 'No session yet';
    $('mn-model').textContent = c ? `${c.model}  ·  ${compactStr(c.used)} of ${compactStr(c.window)}` : '';
    $('mn-now').innerHTML = a.state === 'tool' ? `<i class="dot ping"></i>Running <b>${esc(a.tool)}</b>`
      : a.state === 'generating' ? '<i class="dot ping"></i>Generating a reply'
      : a.state === 'live' ? '<i class="dot idle"></i>Waiting for you' : `<i class="dot idle"></i>Idle · last activity ${a.ageMs ? ago(Date.now() - a.ageMs) : 'unknown'}`;
    const per = d.series.outPerMin;
    $('mn-spark').innerHTML = per.length > 1 ? spark(per, '#00d0f8') : '';
    $('mn-rate').textContent = compactStr(per.slice(-5).reduce((x, y) => x + y, 0) / Math.max(1, Math.min(5, per.length)));
    $('mn-5h').textContent = compactStr(d.local.out5h); $('mn-5hb').innerHTML = bar(Math.min(100, (d.local.out5h / 2e6) * 100), '');
    $('mn-7d').textContent = compactStr(d.local.out7d); $('mn-7db').innerHTML = bar(Math.min(100, (d.local.out7d / 25e6) * 100), 'purple');
    $('mn-tok').textContent = compactStr(d.today.out) + ' out' + (d.today.tps ? ' · ' + tokps(d.today.tps) + ' tok/s' : '');
    $('mn-cost').textContent = money(d.today.cost);
    $('mn-live').textContent = String(d.liveSessions);
  }
  async function refresh() {
    try {
      const d = await getOverview('1h');
      if ('loading' in d) { $('mn-title').textContent = `Reading transcripts… ${d.done}/${d.total}`; setTimeout(() => loop.kick(), 800); return; }
      paint(d);
    } catch { online = false; drawState(last); }
  }
  const loop = liveLoop(refresh, 15000);
  return () => { loop.stop(); offStatus(); offPause(); document.documentElement.classList.remove('is-mini'); };
}
