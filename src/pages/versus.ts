// Compare models: pick any two model cards (model + reasoning level) and get the head-to-head plan-usage report, built on the
// server by server/report.mjs from your own usage and shown in a frame.
import { getJson } from '../api';
import { int, esc } from '../format';
import { note } from './kit';

interface Card { src: 'claude' | 'codex'; model: string; effort: string; fast: boolean; req: number; total: number; h5: number | null; h5Est: boolean; w7: number | null; w7Est: boolean }

const LS = 'tokenhud.versus';
const SRC = { claude: 'Claude', codex: 'Codex' };
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const idOf = (c: Card) => `${c.src}|${c.model}|${c.effort}|${c.fast ? 1 : 0}`;
const usable = (c: Card) => c.h5 != null && c.w7 != null;   // the report needs hours to fill for both windows
const rank = (c: Card) => (EFFORT.indexOf(c.effort) < 0 ? 9 : EFFORT.indexOf(c.effort)) * 2 + (c.fast ? 1 : 0);
const optText = (c: Card) => `${c.model} · ${c.effort || 'default'}${c.fast ? ' fast' : ''}  (${int(c.req)} replies${c.h5Est || c.w7Est ? ', estimated' : ''}${usable(c) ? '' : ', no plan data'})`;

function options(cards: Card[], sel: string): string {
  return (['claude', 'codex'] as const).map((s) => {
    const cs = cards.filter((c) => c.src === s);
    if (!cs.length) return '';
    const tot = new Map<string, number>();
    for (const c of cs) tot.set(c.model, (tot.get(c.model) || 0) + c.total);
    cs.sort((a, b) => (tot.get(b.model)! - tot.get(a.model)!) || a.model.localeCompare(b.model) || rank(a) - rank(b));
    return `<optgroup label="${SRC[s]}">${cs.map((c) => `<option value="${esc(idOf(c))}"${idOf(c) === sel ? ' selected' : ''}${usable(c) ? '' : ' disabled'}>${esc(optText(c))}</option>`).join('')}</optgroup>`;
  }).join('');
}

export function renderVersus(root: HTMLElement): () => void {
  let dead = false, timer = 0;
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Compare models</h1><p class="page-sub">Pick any two models and reasoning levels. The report shows how long each makes your plan allowance last, from your own usage.</p></div></div>
  <div id="vs-body"></div>`;
  const body = root.querySelector('#vs-body') as HTMLElement;

  async function load() {
    const d = await getJson('/api/cards').catch(() => null);
    if (dead) return;
    if (!d || d.loading) { timer = window.setTimeout(load, 700); return; }
    const cards: Card[] = d.cards;
    const ok = cards.filter(usable);
    if (ok.length < 2) { body.innerHTML = note('Two cards with plan-meter data are needed. They appear once the meter has moved while you used a model; see Model cards.'); return; }
    let a = '', b = '';
    try { const s = JSON.parse(localStorage.getItem(LS) || '{}'); a = s.a || ''; b = s.b || ''; } catch { /* no saved pick */ }
    const has = (i: string) => ok.some((c) => idOf(c) === i);
    if (!has(a) || !has(b) || a === b) {
      const top = (s: string) => ok.find((c) => c.src === s);   // cards arrive sorted by tokens used
      a = idOf(top('claude') || ok[0]);
      b = idOf(top('codex') || ok.find((c) => idOf(c) !== a)!);
    }
    body.innerHTML = `
    <div class="vs-bar">
      <span class="vs-dot" style="background:#ff7b47"></span><select class="pick" id="vs-a" aria-label="First model">${options(cards, a)}</select>
      <button type="button" class="btn ghost" id="vs-swap" title="Swap the two sides">⇄</button>
      <span class="vs-dot" style="background:#7ea6dd"></span><select class="pick" id="vs-b" aria-label="Second model">${options(cards, b)}</select>
      <a class="btn ghost" id="vs-open" target="_blank" rel="noopener">Open in new tab</a>
    </div>
    <iframe class="vs-frame" id="vs-frame" title="Comparison report"></iframe>`;
    const $ = <T extends HTMLElement>(id: string) => body.querySelector('#' + id) as T;
    const sa = $<HTMLSelectElement>('vs-a'), sb = $<HTMLSelectElement>('vs-b'), frame = $<HTMLIFrameElement>('vs-frame'), open = $<HTMLAnchorElement>('vs-open');
    const fit = () => { try { const h = frame.contentDocument?.documentElement.scrollHeight; if (h) frame.style.height = h + 'px'; } catch { /* frame not ready */ } };
    const show = () => {
      try { localStorage.setItem(LS, JSON.stringify({ a: sa.value, b: sb.value })); } catch { /* storage unavailable */ }
      const url = `/api/report?a=${encodeURIComponent(sa.value)}&b=${encodeURIComponent(sb.value)}`;
      frame.src = url; open.href = url;
    };
    frame.addEventListener('load', () => { fit(); setTimeout(fit, 120); });
    const ro = new ResizeObserver(() => setTimeout(fit, 80));   // the report rescales itself to the frame width
    ro.observe(frame);
    sa.addEventListener('change', show); sb.addEventListener('change', show);
    $('vs-swap').addEventListener('click', () => { const t = sa.value; sa.value = sb.value; sb.value = t; show(); });
    show();
    stop = () => ro.disconnect();
  }
  let stop = () => {};
  load();
  return () => { dead = true; clearTimeout(timer); stop(); };
}
