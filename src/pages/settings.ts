// M7: Settings (budgets, alert thresholds, context window, time zone, pricing). M8 adds the Claude Code integration card.
import { card, pill } from '../ui';
import { getJson, postJson } from '../api';
import { setTz } from '../tz';
import { esc } from '../format';
import { note } from './kit';
import { FONTS, SHADOWS, DENSITY, DEFAULT_APPEARANCE, CARD_PRESETS, CARD_SHADOWS, clean, cleanCard, applyAppearance, saveLocalAppearance } from '../appearance';

const FAM: [string, string][] = [['in', 'Input'], ['out', 'Output'], ['cw5m', 'Cache write 5m'], ['cw1h', 'Cache write 1h'], ['cr', 'Cache read']];
const THR: [string, string, string, number, number][] = [
  ['ctxPct', 'Context warning (%)', 'Alert when a live session fills this much of its window', 10, 100],
  ['cacheHitPct', 'Cache hit floor (%)', 'Alert when the 24 h hit rate drops below this', 0, 100],
  ['slowTurnSec', 'Slow request (seconds)', 'A single request slower than this is flagged', 5, 36000],
  ['toolErrorPct', 'Tool error rate (%)', 'Per tool, last 24 h, at least 5 calls', 0, 100],
  ['anomalyX', 'Spike factor (x)', 'Spend this many times the normal level counts as a spike', 1.2, 50],
  ['errorTargetPct', 'Tool success target (%)', 'Sets the 7 day error budget on Alerts', 50, 100],
  ['meterTurnPct', 'One turn, 5 h meter (%)', 'Alert when one turn takes this share of the 5-hour meter (estimate) and at least the spike factor times a typical turn', 1, 100],
  ['rewriteX', 'Cache rewrite warning (x a new session)', 'Warn about an expiring or cold cache when rebuilding it would write this many times what a brand new session writes', 1.2, 20],
  ['meterSessionPct', 'Session, 5 h meter (%)', 'Alert when one session holds this share of the current 5-hour window (estimate)', 5, 100],
];

export function renderSettings(root: HTMLElement): () => void {
  let dead = false;
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Settings</h1><p class="page-sub" id="se-sub">Loading…</p></div></div>
  <div id="se-body" class="se">${note('Loading settings…')}</div>`;
  const body = root.querySelector('#se-body') as HTMLElement;

  async function load() {
    const s = await getJson('/api/settings').catch(() => null);
    if (!s || dead) return;
    root.querySelector('#se-sub')!.textContent = `TokenHUD v${s.info.version} · stored in ${s.info.cacheDir}`;
    const f = (id: string, label: string, val: number | string, hint = '', attrs = 'type="number" step="any" min="0"') =>
      `<label class="fld"><span class="lh">${label}</span><input id="${id}" ${attrs} value="${esc(String(val))}">${hint ? `<small>${hint}</small>` : ''}</label>`;
    const ap = clean(s.appearance);
    body.innerHTML = `
    <div class="row">
      <div class="c6">${card('Budgets', `<div class="set-grid">${f('b-dailyUsd', 'Daily ($)', s.budgets.dailyUsd, '0 turns it off')}${f('b-weeklyUsd', 'Weekly ($)', s.budgets.weeklyUsd, 'weeks start Monday')}${f('b-monthlyUsd', 'Monthly ($)', s.budgets.monthlyUsd, 'also drives the forecast alert')}</div>`, { sub: 'Warns at 80% and 100% of each budget. Spend is an API-rate estimate, not your plan bill.' })}</div>
      <div class="c6">${card('Display', `<div class="set-grid">
        <label class="fld"><span class="lh">Time zone</span><select id="tz"><option value="local" ${s.tz === 'local' ? 'selected' : ''}>This computer</option><option value="UTC" ${s.tz === 'UTC' ? 'selected' : ''}>UTC</option></select><small>Header clock and timestamps</small></label>
        <label class="fld"><span class="lh">Context window</span><select id="cw"><option value="auto" ${s.contextWindow === 'auto' ? 'selected' : ''}>Auto-detect</option><option value="200000" ${s.contextWindow === 200000 ? 'selected' : ''}>200K</option><option value="1000000" ${s.contextWindow === 1000000 ? 'selected' : ''}>1M</option></select><small>Auto switches to 1M once a session passes 200K</small></label>
      </div>`, { sub: 'Transcripts do not record the window size, so it is inferred unless you set it.' })}</div>
    </div>
    <div class="row"><div class="c12">${card('Appearance', `<div class="set-grid cols4">
      <label class="fld"><span class="lh">Font</span><select id="ap-font">${Object.entries(FONTS).map(([k, v]) => `<option value="${k}" ${ap.font === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select><small>Fonts other than Inter and JetBrains Mono must be installed on this computer</small></label>
      <label class="fld"><span class="lh">Spacing</span><select id="ap-density">${Object.entries(DENSITY).map(([k, v]) => `<option value="${k}" ${ap.density === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select><small>Gap between cards and page margins</small></label>
      <label class="fld"><span class="lh">Text shadow</span><select id="ap-shadow">${Object.entries(SHADOWS).map(([k, v]) => `<option value="${k}" ${ap.shadow === k ? 'selected' : ''}>${v}</option>`).join('')}</select><small>Shadow behind all text</small></label>
      <label class="fld"><span class="lh">Shadow color</span><input id="ap-shadowColor" type="color" value="${ap.shadowColor}"><small>Used when a text shadow is on</small></label>
      <label class="fld"><span class="lh">Text size <b id="ap-size-v">${ap.size}%</b></span><input id="ap-size" type="range" min="80" max="140" step="5" value="${ap.size}"><small>Scales all text, not the layout</small></label>
      <label class="fld"><span class="lh">UI scale <b id="ap-scale-v">${ap.scale}%</b></span><input id="ap-scale" type="range" min="70" max="160" step="5" value="${ap.scale}"><small>Zooms everything. Not used in the tray popover</small></label>
      <label class="fld"><span class="lh">Text outline <b id="ap-outline-v">${ap.outline.toFixed(1)} px</b></span><input id="ap-outline" type="range" min="0" max="1.5" step="0.1" value="${ap.outline}"><small>0 turns it off</small></label>
      <label class="fld"><span class="lh">Outline color</span><input id="ap-outlineColor" type="color" value="${ap.outlineColor}"><small>Used when the outline is above 0</small></label>
    </div>
    <div class="set-foot"><label class="chk"><input id="ap-motion" type="checkbox" ${ap.motion ? 'checked' : ''}> Animations and live pulses</label><span class="grow"></span><span class="muted" id="ap-msg"></span><button class="btn ghost" id="ap-reset" type="button">Reset appearance</button></div>`, { sub: 'Applies at once and is saved automatically. Shared by the tray window and the browser.' })}</div></div>
    <div class="row"><div class="c12">${card('Themes', `<div class="theme-presets" id="ct-presets">${Object.entries(CARD_PRESETS).map(([k, [name, p]]) => `<button type="button" class="theme-chip ${ap.card.preset === k ? 'on' : ''}" data-preset="${k}"><i style="background:linear-gradient(${p.angle}deg, ${p.bg1}, ${p.bg2});border-color:${p.border1};box-shadow:0 0 ${Math.round(p.shadowSize / 3)}px ${p.shadow === 'none' ? 'transparent' : p.shadowColor}"></i>${name}</button>`).join('')}</div>
      <div class="set-grid cols4">
      <label class="fld"><span class="lh">Fill, top</span><input id="ct-bg1" type="color" value="${ap.card.bg1}"><small>Gradient start of every section</small></label>
      <label class="fld"><span class="lh">Fill, bottom</span><input id="ct-bg2" type="color" value="${ap.card.bg2}"><small>Gradient end</small></label>
      <label class="fld"><span class="lh">Gradient angle <b id="ct-angle-v">${ap.card.angle}°</b></span><input id="ct-angle" type="range" min="0" max="360" step="5" value="${ap.card.angle}"><small>180° is top to bottom</small></label>
      <label class="fld"><span class="lh">Shadow style</span><select id="ct-shadow">${Object.entries(CARD_SHADOWS).map(([k, v]) => `<option value="${k}" ${ap.card.shadow === k ? 'selected' : ''}>${v}</option>`).join('')}</select><small>Shadow around each section: none, soft, deep, glow or neon</small></label>
      <label class="fld"><span class="lh">Border, top left</span><input id="ct-border1" type="color" value="${ap.card.border1}"><small>Colour of the lit corner</small></label>
      <label class="fld"><span class="lh">Border, bottom right</span><input id="ct-border2" type="color" value="${ap.card.border2}"><small>Colour of the far corner</small></label>
      <label class="fld"><span class="lh">Shadow color</span><input id="ct-shadowColor" type="color" value="${ap.card.shadowColor}"><small>Used by every shadow style except None</small></label>
      <label class="fld"><span class="lh">Shadow size <b id="ct-size-v">${ap.card.shadowSize} px</b></span><input id="ct-shadowSize" type="range" min="0" max="60" step="1" value="${ap.card.shadowSize}"><small>How far the shadow or glow spreads</small></label>
    </div>`, { sub: 'The look of the sections that hold the data. Pick a theme or change any part; it applies at once and is saved automatically.' })}</div></div>
    <div class="row"><div class="c12">${card('Alert thresholds', `<div class="set-grid cols6">${THR.map(([k, l, h, lo, hi]) => f('t-' + k, l, s.thresholds[k], h, `type="number" step="any" min="${lo}" max="${hi}"`)).join('')}</div>`)}</div></div>
    <div class="row"><div class="c7">${card('Pricing', `<div style="overflow-x:auto"><table class="tbl price-tbl"><thead><tr><th>Model family</th>${FAM.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>${Object.keys(s.prices).map((fam) =>
      `<tr><td class="strong">${esc(fam)}</td>${FAM.map(([k]) => `<td class="num"><input class="pin" data-fam="${esc(fam)}" data-k="${k}" type="number" step="any" min="0" value="${s.prices[fam][k] ?? 0}" style="background:rgba(6,22,38,.9);color:#fff;border:1px solid var(--border);border-radius:6px;padding:5px 7px;font:inherit"></td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      { sub: 'USD per million tokens, matched by model family. Defaults are public API list prices; edit if yours differ.', right: '<button class="btn ghost" id="reset-prices" type="button">Reset to defaults</button>' })}</div>
    <div class="c5"><div id="se-int">${card('Claude Code connection (optional)', note('Checking…'))}</div></div></div>
    <div class="row"><div class="c6">${card('Plan % tracking', `<label class="chk"><input id="planPoll" type="checkbox" ${s.planPoll ? 'checked' : ''}> Read my plan % every minute, only within 10 minutes of a prompt</label><p class="muted" style="font-size: calc(12.5px * var(--fs, 1));margin:10px 0 0">${s.planPoll ? (s.poll.idle ? 'Waiting: no prompt in the last 10 minutes, so no requests are sent. ' + s.poll.count + ' readings this run.' : s.poll.ok ? 'Working. ' + s.poll.count + ' readings this run.' : s.poll.error ? 'Not working: ' + esc(s.poll.error) : 'Starting…') : 'Off. Plan value then only learns when get_usage runs in a Claude Code session.'}</p>`, { sub: 'Keeps Plan value up to date by itself. Uses the Claude Code login token already on this computer, sent only to api.anthropic.com (usage endpoint), never stored or logged. Click Save settings to apply.' })}</div>
    <div class="c6">${card('About', `<div class="stat-list hz"><div class="r"><span>Transcript folder</span><b>${esc(s.info.projectsDir)}</b></div><div class="r"><span>Dashboard address</span><b>http://127.0.0.1:${s.info.port}</b></div><div class="r"><span>Data stays</span><b>on this computer; nothing is uploaded</b></div></div>`)}</div></div>
    <div class="savebar"><button class="btn" id="save" type="button">Save settings</button><span class="muted" id="saved"></span></div>`;

    const apv = (id: string) => body.querySelector('#ap-' + id) as HTMLInputElement;
    let apTimer: number | undefined;
    const ctv = (id: string) => body.querySelector('#ct-' + id) as HTMLInputElement;
    let ctPreset = ap.card.preset;
    const ctRead = () => cleanCard({ preset: ctPreset, bg1: ctv('bg1').value, bg2: ctv('bg2').value, angle: Number(ctv('angle').value), border1: ctv('border1').value, border2: ctv('border2').value, shadow: ctv('shadow').value, shadowColor: ctv('shadowColor').value, shadowSize: Number(ctv('shadowSize').value) });
    const ctMark = () => body.querySelectorAll<HTMLElement>('#ct-presets .theme-chip').forEach((b) => b.classList.toggle('on', b.dataset.preset === ctPreset));
    const apRead = () => clean({ card: ctRead(), font: apv('font').value, size: Number(apv('size').value), scale: Number(apv('scale').value), density: apv('density').value, shadow: apv('shadow').value, shadowColor: apv('shadowColor').value, outline: Number(apv('outline').value), outlineColor: apv('outlineColor').value, motion: apv('motion').checked });
    const apChange = () => {
      const a = apRead();
      (body.querySelector('#ap-size-v') as HTMLElement).textContent = a.size + '%';
      (body.querySelector('#ap-scale-v') as HTMLElement).textContent = a.scale + '%';
      (body.querySelector('#ap-outline-v') as HTMLElement).textContent = a.outline.toFixed(1) + ' px';
      (body.querySelector('#ct-angle-v') as HTMLElement).textContent = a.card.angle + '°';
      (body.querySelector('#ct-size-v') as HTMLElement).textContent = a.card.shadowSize + ' px';
      applyAppearance(a); saveLocalAppearance(a);
      clearTimeout(apTimer);
      apTimer = window.setTimeout(() => { postJson('/api/settings', { appearance: a }).then(() => { (body.querySelector('#ap-msg') as HTMLElement).textContent = 'Saved'; }).catch(() => { (body.querySelector('#ap-msg') as HTMLElement).textContent = 'Could not save'; }); }, 400);
    };
    // UI scale resizes the slider itself, so it only applies on release (the others apply live)
    body.querySelectorAll('[id^="ap-"]').forEach((el) => { if (el.id !== 'ap-reset' && !el.id.endsWith('-v') && el.id !== 'ap-msg') { el.addEventListener('change', apChange); if (el.id === 'ap-scale') el.addEventListener('input', () => { (body.querySelector('#ap-scale-v') as HTMLElement).textContent = apv('scale').value + '%'; }); else el.addEventListener('input', apChange); } });
    const ctFill = (c: typeof ap.card) => { ctv('bg1').value = c.bg1; ctv('bg2').value = c.bg2; ctv('angle').value = String(c.angle); ctv('border1').value = c.border1; ctv('border2').value = c.border2; ctv('shadow').value = c.shadow; ctv('shadowColor').value = c.shadowColor; ctv('shadowSize').value = String(c.shadowSize); };
    body.querySelectorAll('[id^="ct-"]').forEach((el) => { if (!el.id.endsWith('-v') && el.id !== 'ct-presets') { const h = () => { ctPreset = 'custom'; ctMark(); apChange(); }; el.addEventListener('input', h); el.addEventListener('change', h); } });
    body.querySelectorAll<HTMLElement>('#ct-presets .theme-chip').forEach((b) => b.addEventListener('click', () => { ctPreset = b.dataset.preset!; ctFill(cleanCard({ preset: ctPreset, ...CARD_PRESETS[ctPreset][1] })); ctMark(); apChange(); }));
    body.querySelector('#ap-reset')!.addEventListener('click', () => {
      const d = DEFAULT_APPEARANCE; ctPreset = d.card.preset; ctFill(d.card); ctMark();
      apv('font').value = d.font; apv('size').value = String(d.size); apv('scale').value = String(d.scale); apv('density').value = d.density; apv('shadow').value = d.shadow;
      apv('shadowColor').value = d.shadowColor; apv('outline').value = String(d.outline); apv('outlineColor').value = d.outlineColor; apv('motion').checked = d.motion; apChange();
    });
    const val = (id: string) => Number((body.querySelector('#' + id) as HTMLInputElement).value);
    body.querySelector('#reset-prices')!.addEventListener('click', () => {
      body.querySelectorAll<HTMLInputElement>('input.pin').forEach((i) => { i.value = String(s.basePrices[i.dataset.fam!]?.[i.dataset.k!] ?? 0); });
    });
    body.querySelector('#save')!.addEventListener('click', async () => {
      const pricing: Record<string, Record<string, number>> = {};
      body.querySelectorAll<HTMLInputElement>('input.pin').forEach((i) => {
        const fam = i.dataset.fam!, k = i.dataset.k!, v = Number(i.value);
        if (v !== (s.basePrices[fam]?.[k] ?? NaN)) (pricing[fam] ||= {})[k] = v;
      });
      const payload = {
        budgets: { dailyUsd: val('b-dailyUsd'), weeklyUsd: val('b-weeklyUsd'), monthlyUsd: val('b-monthlyUsd') },
        thresholds: Object.fromEntries(THR.map(([k]) => [k, val('t-' + k)])),
        contextWindow: (body.querySelector('#cw') as HTMLSelectElement).value,
        tz: (body.querySelector('#tz') as HTMLSelectElement).value,
        planPoll: (body.querySelector('#planPoll') as HTMLInputElement).checked,
        pricing,
      };
      const out = root.querySelector('#saved') as HTMLElement;
      try { const r = await postJson('/api/settings', payload); setTz(r.tz); out.textContent = 'Saved. Costs and alerts use the new values on the next refresh.'; out.style.color = 'var(--green)'; }
      catch { out.textContent = 'Could not save. Is the TokenHUD server running?'; out.style.color = 'var(--red)'; }
    });
  }
  async function loadInt() {
    const el = root.querySelector('#se-int') as HTMLElement | null; if (!el) return;
    const [g, f] = await Promise.all([getJson('/api/integration').catch(() => null), getJson('/api/feed').catch(() => null)]);
    if (!g || dead) return;
    const on = g.statusLine && g.hooks.length === g.events.length;
    const live = f && f.fresh;
    el.innerHTML = card('Claude Code connection (optional)', `<div class="stat-list" style="margin-bottom:14px">
      <div class="r"><span>Status line (plan limits, exact context, cache timer)</span>${g.statusLine ? (live ? pill('Receiving data', 'green') : pill('Installed, waiting for data', 'amber')) : pill('Not installed', 'grey')}</div>
      <div class="r"><span>Hooks (what Claude is doing right now)</span>${g.hooks.length === g.events.length ? (f && f.hooks ? pill('Receiving events', 'green') : pill('Installed, waiting for events', 'amber')) : g.hooks.length ? pill(g.hooks.length + ' of ' + g.events.length + ' installed', 'amber') : pill('Not installed', 'grey')}</div>
      <div class="r"><span>Settings file</span><b>${esc(g.path)}</b></div></div>
      ${g.error ? `<p style="color:var(--red)">${esc(g.error)}</p>` : on ? '<p class="muted" style="font-size: calc(12.5px * var(--fs, 1));margin:0 0 12px">Connected. If nothing arrives, start a new Claude Code session: running sessions read their settings at start. The desktop Code tab may not run the status line at all; hooks usually still work.</p>' : `<p class="muted" style="font-size: calc(12.5px * var(--fs, 1));margin:0 0 6px">Installing will:</p><ul class="muted" style="font-size: calc(12.5px * var(--fs, 1));margin:0 0 14px;padding-left:18px;line-height:1.6">${g.plan.map((x: string) => '<li>' + esc(x) + '</li>').join('')}</ul>`}
      ${g.error ? '' : on ? '<button class="btn ghost" id="int-off" type="button">Remove from Claude Code</button>' : '<button class="btn" id="int-on" type="button">Install into Claude Code</button>'}
      <span class="muted" id="int-msg" style="margin-left:12px"></span>`, { sub: 'Edits your Claude Code settings file, only when you click. A backup is made first; Remove undoes it and restores your old status line.' });
    const act = async (action: string) => {
      const m = root.querySelector('#int-msg') as HTMLElement;
      try { const r = await postJson('/api/integration', { action }); if (r.error) throw new Error(r.error); loadInt(); }
      catch (e) { m.textContent = 'Failed: ' + (e as Error).message; m.style.color = 'var(--red)'; }
    };
    root.querySelector('#int-on')?.addEventListener('click', () => act('install'));
    root.querySelector('#int-off')?.addEventListener('click', () => act('uninstall'));
  }
  load().then(loadInt);
  const intTimer = setInterval(loadInt, 5000);
  return () => { dead = true; clearInterval(intTimer); };
}
