// Pace chip in the header, left of "New UI". Uses the 5-hour meter against even pace: minutes to
// slow down (red) or speed up (green) to be level with the share of the window that has passed.
// The model shown in the menu (last used, or one you pick) is only named in the hover text.
import { getJson, onUpdate } from './api';
import type { PlanWin, StatusFeed } from './api';

interface Card { src: string; model: string; effort: string; fast: boolean; h5: number | null; h5Est: boolean; last: number }

const PICK_KEY = 'tokenhud.paceCard'; // '' = auto (last used); else the cardKey of the picked card
const FAMILY = ['Opus', 'Sonnet', 'Haiku'];
const EFFORT = ['max', 'xhigh', 'high', 'medium', 'low'];

let meter: PlanWin | null = null;
let claude: Card[] = []; // Claude cards only (no OpenAI/Codex), newest first
let cardsAt = 0;
let pick = localStorage.getItem(PICK_KEY) || '';
let menu: HTMLElement | null = null;

const cardKey = (c: Card) => `${c.model}|${c.effort}|${c.fast ? 1 : 0}`;
const describe = (c: Card) => `${c.model}, ${c.effort ? c.effort + ' effort' : 'default effort'}, ${c.fast ? 'fast mode' : 'standard speed'}`;

const WINDOW_MIN = 300; // the 5-hour window

/**
 * Minutes to slow down (positive) or speed up (negative) to be level with even pace. Even pace means the meter
 * has risen by the same share of 100% as the share of the window that has passed (20% after 1 h, as the
 * Overview's pace line). Being X points ahead costs X/100 of the window in idle time to catch up.
 */
export function paceGap(usedPct: number, minutesLeft: number, windowMin = WINDOW_MIN): number {
  const used = Math.min(100, Math.max(0, usedPct));
  const elapsed = windowMin - minutesLeft;
  return (used / 100) * windowMin - elapsed;
}

/** The card whose burn rate the chip uses: the one picked in the menu (kept until Auto is chosen), else your last used model. */
function chosen(): { card: Card | undefined; picked: boolean } {
  if (pick) return { card: claude.find((c) => cardKey(c) === pick), picked: true };
  return { card: claude[0], picked: false };
}

function render() {
  const el = document.getElementById('pace');
  if (!el) return;
  const left = meter && meter.resetsAt != null ? meter.resetsAt - Date.now() : 0;
  const { card, picked } = chosen();
  const how = picked ? 'picked in the menu' : 'your last used model';
  if (!meter || left <= 0) {
    el.className = 'pace none';
    el.textContent = 'No 5h reading';
    el.title = 'Needs a live 5-hour reading from Claude Code. Click to pick a model.';
    return;
  }
  const g = Math.round(paceGap(meter.pct, left / 60000));
  const level = Math.round(((WINDOW_MIN - left / 60000) / WINDOW_MIN) * 100);
  el.className = 'pace ' + (g > 0 ? 'slow' : 'fast');
  el.textContent = g > 0 ? `Slow down ${g} min` : g < 0 ? `Speed up ${-g} min` : 'On pace';
  el.title = `Even pace: ${level}% of the 5-hour window has passed, so ${level}% used is level. You are at ${Math.round(meter.pct)}%. ` +
    `Model menu: ${card ? describe(card) + ` (${how})` : 'none yet'}; the model does not change the minutes. Click to pick a model.`;
}

// Menu order: Opus, Sonnet, Haiku; newest version first; standard before fast; effort max to low.
function ordered(list: Card[]): Card[] {
  const fam = (m: string) => { const i = FAMILY.findIndex((f) => m.startsWith(f)); return i < 0 ? 9 : i; };
  const ver = (m: string) => parseFloat((m.match(/\d+(\.\d+)?/) || ['0'])[0]);
  const eff = (e: string) => { const i = EFFORT.indexOf(e); return i >= 0 ? i : e ? 8 : 9; };
  return list.slice().sort((a, b) =>
    fam(a.model) - fam(b.model) || ver(b.model) - ver(a.model) || Number(a.fast) - Number(b.fast) || eff(a.effort) - eff(b.effort));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

function renderMenu() {
  if (!menu) return;
  const { card, picked } = chosen();
  const row = (k: string, label: string, sub: string, on: boolean) =>
    `<button type="button" class="pace-opt${on ? ' on' : ''}" data-k="${esc(k)}"><span>${esc(label)}</span><small>${esc(sub)}</small><i>${on ? '✓' : ''}</i></button>`;
  let html = `<div class="pace-grp">Measure the burn rate of</div>` +
    row('', 'Auto: last used', claude[0] ? describe(claude[0]) : 'no Claude data yet', !picked);
  let model = '';
  const opts = ordered(claude.filter((c) => c.h5 != null));
  for (const c of opts) {
    if (c.model !== model) { model = c.model; html += `<div class="pace-grp">${esc(c.model)}</div>`; }
    const label = (c.effort || 'default') + ' effort' + (c.fast ? ' · fast' : '');
    const sub = `${(c.h5 as number).toFixed(1)} h to fill 5 h${c.h5Est ? ' (est.)' : ''}`;
    html += row(cardKey(c), label, sub, picked && card != null && cardKey(card) === cardKey(c));
  }
  if (!opts.length) html += `<div class="pace-grp">No Claude model with a rate yet</div>`;
  menu.innerHTML = html;
}

function openMenu() {
  const el = document.getElementById('pace');
  if (!el || !menu) return;
  renderMenu();
  const r = el.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.hidden = false;
  loadCards(true);
}

function closeMenu() { if (menu) menu.hidden = true; }

async function loadMeter() {
  try {
    const f = await getJson<StatusFeed>('/api/feed');
    if (f) meter = f.plan5h;
  } catch { /* keep the last reading */ }
  render();
}

// The card rate changes slowly and /api/cards takes ~0.13 s, so refresh it at most every 30 s (or when the menu opens).
async function loadCards(force = false) {
  if (!force && Date.now() - cardsAt < 30000) return;
  cardsAt = Date.now();
  try {
    const d = await getJson<{ cards: Card[] }>('/api/cards');
    if (d) claude = d.cards.filter((c) => c.src === 'claude').sort((a, b) => b.last - a.last);
  } catch { /* keep the last list */ }
  render();
  if (menu && !menu.hidden) renderMenu();
}

export function startPace() {
  const el = document.getElementById('pace');
  if (!el) return;
  menu = document.createElement('div');
  menu.className = 'pace-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', () => (menu && !menu.hidden ? closeMenu() : openMenu()));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  menu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!b) return;
    pick = b.dataset.k || '';
    if (pick) localStorage.setItem(PICK_KEY, pick); else localStorage.removeItem(PICK_KEY);
    closeMenu();
    render();
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (menu && !menu.hidden && !menu.contains(t) && !el.contains(t)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  loadMeter();
  loadCards();
  onUpdate(() => { loadMeter(); loadCards(); });
  setInterval(() => { loadCards(); render(); }, 30000); // the minutes move with the clock, not only with new readings
}
