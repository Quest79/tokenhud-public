import { ZEN, setZen } from './theme';
import { startPace } from './pace';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/zen.css';
import { LayoutDashboard, Layers, GitBranch, CircleDollarSign, Percent, LayoutGrid, ArrowLeftRight, Gauge, Cpu, Wrench, Bell, FileText, Settings, Palette, Pin, Minus, Square, X, ChevronDown, Menu, Star } from 'lucide';
import { icon, logo } from './ui';
import { renderGallery } from './pages/gallery';
import { renderOverview } from './pages/overview';
import { renderMini } from './pages/mini';
import { renderSessions } from './pages/sessions';
import { renderCost } from './pages/cost';
import { renderPlan } from './pages/plan';
import { renderCards } from './pages/cards';
import { renderVersus } from './pages/versus';
import { renderTraces } from './pages/traces';
import { renderContext } from './pages/context';
import { renderModels } from './pages/models';
import { renderTools } from './pages/tools';
import { renderAlerts } from './pages/alerts';
import { renderSummary } from './pages/summary';
import { renderSettings } from './pages/settings';
import './pages/toolcall';
import { connect, onStatus, onPause, getJson, postJson, getSrc, setSrc, type Src } from './api';
import { setTz, tzOpt, tzName } from './tz';
import { applyAppearance, loadLocalAppearance, saveLocalAppearance, clean } from './appearance';

declare const __APP_VERSION__: string;

interface Page { id: string; label: string; ico: Parameters<typeof icon>[0]; render?: (root: HTMLElement, arg?: string) => void | (() => void) }

const pages: Page[] = [
  { id: 'overview', label: 'Overview', ico: LayoutDashboard, render: renderOverview },
  { id: 'sessions', label: 'Sessions', ico: Layers, render: renderSessions },
  { id: 'traces', label: 'Traces', ico: GitBranch, render: renderTraces },
  { id: 'cost', label: 'Cost & Usage', ico: CircleDollarSign, render: renderCost },
  { id: 'plan', label: 'Plan value', ico: Percent, render: renderPlan },
  { id: 'cards', label: 'Model cards', ico: LayoutGrid, render: renderCards },
  { id: 'versus', label: 'Compare models', ico: ArrowLeftRight, render: renderVersus },
  { id: 'context', label: 'Context', ico: Gauge, render: renderContext },
  { id: 'models', label: 'Models', ico: Cpu, render: renderModels },
  { id: 'tools', label: 'Tools', ico: Wrench, render: renderTools },
  { id: 'alerts', label: 'Alerts', ico: Bell, render: renderAlerts },
  { id: 'summary', label: 'Summary', ico: FileText, render: renderSummary },
  { id: 'settings', label: 'Settings', ico: Settings, render: renderSettings },
  { id: 'gallery', label: 'Gallery', ico: Palette, render: renderGallery },
];

const app = document.getElementById('app')!;
applyAppearance(loadLocalAppearance(), location.hash.startsWith('#/mini'));
if (location.hash.startsWith('#/mini')) { // tray popover: no header, no router
  getJson('/api/settings').then((s) => { if (s && s.appearance) { saveLocalAppearance(clean(s.appearance)); applyAppearance(s.appearance, true); } }).catch(() => {});
  connect();
  renderMini(app);
} else boot();

function boot() {
app.innerHTML = `
<div class="app">
  <header class="header" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>${logo()}<div data-tauri-drag-region><div class="brand-name" data-tauri-drag-region>TokenHUD<span class="brand-ver">v${__APP_VERSION__}</span></div><div class="brand-sub" data-tauri-drag-region>Claude Code live dashboard</div></div></div>
    <nav class="tabs" data-tauri-drag-region><button type="button" class="tab navbtn" id="navmenu" aria-haspopup="true" aria-expanded="false" title="All sections"></button><div class="navtabs" id="navtabs" data-tauri-drag-region></div></nav>
    <div class="navpanel" id="navpanel" hidden></div>
    <div class="hdr-right" data-tauri-drag-region><span class="pace none" id="pace" title="Minutes to slow down (red) or speed up (green) to stay level with your 5-hour limit">No 5h reading</span><label class="uitoggle" title="Tick for the new zen look, untick for the old one"><input type="checkbox" id="ui-new" ${ZEN ? 'checked' : ''}><span>New UI</span></label><div class="srcseg" id="srcseg" title="Show data from Claude Code, Codex, or both">${([['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex']] as const).map(([k, l]) => `<button data-s="${k}" class="${getSrc() === k ? 'on' : ''}">${l}</button>`).join('')}</div><button class="pinbtn" id="pin-main" title="Keep this window on top" style="display:none">${icon(Pin, 15)}</button><span class="online"><span class="dot ping"></span>Online</span><span class="clock" id="clock" data-tauri-drag-region></span><div class="wctl" id="wctl" style="display:none"><button data-w="minimize" title="Minimize">${icon(Minus, 14)}</button><button data-w="toggle_maximize" title="Maximize">${icon(Square, 12)}</button><button data-w="close" class="x" title="Close to tray">${icon(X, 15)}</button></div></div>
  </header>
  <main class="main" id="view"></main>
</div>`;

const view = document.getElementById('view')!;
let cleanup: void | (() => void);

// Top row = the sections you starred; the Sections menu lists them all.
const FAVS = 'tokenhud.navfavs';
const navPages = pages.filter((p) => p.id !== 'gallery');
let favs: string[] = (() => { try { const v = JSON.parse(localStorage.getItem(FAVS) || 'null'); if (Array.isArray(v)) return v.filter((id) => navPages.some((p) => p.id === id)); } catch { /* use the defaults */ } return ['overview', 'sessions', 'traces', 'plan', 'versus']; })();
let curId = 'overview';
const navTabs = document.getElementById('navtabs')!, navBtn = document.getElementById('navmenu')!, navPanel = document.getElementById('navpanel')!;
function drawNav() {
  const cur = navPages.find((p) => p.id === curId), extra = cur && !favs.includes(cur.id) ? cur : null;   // the page you're on, when it isn't starred
  navBtn.innerHTML = `<span class="ico">${icon(extra ? extra.ico : Menu, 16)}</span><span class="lbl">${extra ? extra.label : 'Sections'}</span>${icon(ChevronDown, 14)}`;
  navBtn.classList.toggle('active', !!extra);
  navTabs.innerHTML = navPages.filter((p) => favs.includes(p.id)).map((p) => `<a class="tab${p.id === curId ? ' active' : ''}" href="#/${p.id}" data-id="${p.id}" title="${p.label}"><span class="ico">${icon(p.ico, 16)}</span><span class="lbl">${p.label}</span></a>`).join('');
  navPanel.innerHTML = `<div class="navhint">Star a section to keep it in the top row</div>` + navPages.map((p) => { const f = favs.includes(p.id); return `<div class="navrow${p.id === curId ? ' on' : ''}"><a href="#/${p.id}"><span class="ico">${icon(p.ico, 16)}</span><span>${p.label}</span></a><button type="button" class="navfav${f ? ' on' : ''}" data-id="${p.id}" aria-pressed="${f}" title="${f ? 'Remove from the top row' : 'Add to the top row'}">${icon(Star, 15)}</button></div>`; }).join('');
}
const setMenu = (open: boolean) => {
  navPanel.hidden = !open; navBtn.setAttribute('aria-expanded', String(open));
  if (open) navPanel.style.left = Math.max(8, navBtn.getBoundingClientRect().left - (navPanel.parentElement as HTMLElement).getBoundingClientRect().left) + 'px';
};
navBtn.addEventListener('click', () => setMenu(navPanel.hidden));
navPanel.addEventListener('click', (e) => {
  const t = e.target as HTMLElement, star = t.closest<HTMLElement>('.navfav');
  if (star) {
    const id = star.dataset.id!;
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    try { localStorage.setItem(FAVS, JSON.stringify(favs)); } catch { /* storage unavailable */ }
    postJson('/api/settings', { navFavs: favs }).catch(() => {});   // the server copy is the one every window loads
    drawNav();   // the menu stays open so several can be starred in one go
  } else if (t.closest('a')) setMenu(false);
});
document.addEventListener('click', (e) => { if (!navPanel.hidden && !e.composedPath().includes(navPanel) && !e.composedPath().includes(navBtn)) setMenu(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !navPanel.hidden) { setMenu(false); navBtn.focus(); } });
function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const [id, ...rest] = (location.hash.replace(/^#\//, '') || 'overview').split('/');
  const arg = rest.join('/') || undefined;
  const page = pages.find((p) => p.id === id) ?? pages[0];
  curId = page.id; drawNav(); setMenu(false);
  view.innerHTML = '';
  if (page.render) cleanup = page.render(view, arg);
  else view.innerHTML = `<div><h1 class="page-title">${page.label}</h1><p class="page-sub">Planned.</p></div>`;
}
addEventListener('hashchange', route);
route();
connect();
const online = document.querySelector('.online') as HTMLElement;
let st: string = 'connecting', pz = false;
const drawOnline = () => {
  online.classList.toggle('idle', st !== 'online' || pz);
  online.innerHTML = `<span class="dot ${st === 'online' && !pz ? 'ping' : ''}"></span>${st !== 'online' ? (st === 'connecting' ? 'Connecting' : 'Offline') : pz ? 'Paused' : 'Online'}`;
};
onStatus((s) => { st = s; drawOnline(); });
onPause((p) => { pz = p; drawOnline(); });

getJson('/api/settings').then((s) => { if (s) { setTz(s.tz); if (Array.isArray(s.navFavs)) { favs = s.navFavs.filter((id: string) => navPages.some((p) => p.id === id)); try { localStorage.setItem(FAVS, JSON.stringify(favs)); } catch { /* storage unavailable */ } drawNav(); } else if (localStorage.getItem(FAVS)) postJson('/api/settings', { navFavs: favs }).catch(() => {}); /* first run: keep this window's stars */ if (s.appearance) { saveLocalAppearance(clean(s.appearance)); applyAppearance(s.appearance); } } }).catch(() => {});
const tauri = (window as any).__TAURI_INTERNALS__ as { invoke: (c: string, a?: object) => Promise<unknown> } | undefined;
document.querySelectorAll<HTMLElement>('#srcseg button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.s === getSrc()) return; setSrc(b.dataset.s as Src); location.reload(); }));
document.getElementById('ui-new')!.addEventListener('change', (e) => setZen((e.target as HTMLInputElement).checked));
const pinBtn = document.getElementById('pin-main') as HTMLElement;
if (tauri) { // only inside the tray app; a plain browser has no always-on-top
  pinBtn.style.display = '';
  document.querySelector('.header')!.classList.add('native');
  const wctl = document.getElementById('wctl') as HTMLElement; wctl.style.display = '';
  wctl.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) tauri.invoke('plugin:window|' + b.dataset.w); });
  let on = localStorage.getItem('th.pinMain') === '1';
  const apply = () => { pinBtn.classList.toggle('on', on); tauri.invoke('set_main_pinned', { on }); };
  pinBtn.addEventListener('click', () => { on = !on; localStorage.setItem('th.pinMain', on ? '1' : '0'); apply(); });
  if (on) apply();
}
const clock = document.getElementById('clock')!;
const tick = () => {
  const d = new Date();
  clock.innerHTML = `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tzOpt() })}  ${d.toLocaleTimeString('en-US', { hour12: false, ...tzOpt() })}<small>${tzName()}</small>`;
};
tick();
setInterval(tick, 1000);
startPace();
}
