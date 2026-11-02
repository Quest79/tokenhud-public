// Model leaderboard in the Artificial Analysis layout: one row per model and reasoning level, column groups that
// collapse to their headline column, sortable columns, sticky model column.
import { ArrowLeftToLine, ArrowRightToLine, ArrowUp, ArrowDown, Star } from 'lucide';
import { icon, card, seg, wireSeg } from '../ui';
import { getJson, type Compare, type CompareRow } from '../api';
import { liveLoop } from '../live';
import { compactStr, int, money, esc } from '../format';

interface Col { key: string; label: string; unit?: string; tip?: string; get: (r: CompareRow) => number | null; fmt: (v: number, r: CompareRow) => string; best?: 'hi' | 'lo' }
interface Group { id: string; title: string; cols: Col[] }

const sec = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const rate = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
const price = (v: number) => '$' + (v >= 10 ? v.toFixed(0) : v.toFixed(2));
const cost = (v: number) => (v < 10 ? '$' + v.toFixed(2) : money(v));
const timed = (p: (r: CompareRow) => { n: number }, f: (r: CompareRow) => number) => (r: CompareRow) => (p(r).n ? f(r) : null);

/** Tiny 7-day line: oldest left, newest right, gaps skipped. */
function spark(vs: (number | null)[], col: string): string {
  const pts = vs.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return '<span class="muted">–</span>';
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])), rg = hi - lo || 1;
  const xy = pts.map(([i, v]) => `${(i / 6) * 78 + 1},${20 - ((v - lo) / rg) * 18 - 1}`);
  const [lx, ly] = xy[xy.length - 1].split(',');
  return `<svg class="tspark" viewBox="0 0 80 20" width="80" height="20"><polyline points="${xy.join(' ')}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="2" fill="${col}"/></svg>`;
}
const lastOf = (a: (number | null)[]) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return a[i]; return null; };

type Dist = 'speed' | 'e2e' | 'ttft' | 'ans' | 'lat' | 'think';
const dist = (key: Dist, f: (v: number) => string, unit: string, label: string, best: 'hi' | 'lo', tip: string): Col[] =>
  (['p50', 'p5', 'p25', 'p75', 'p95'] as const).map((p) => ({ key: `${key}.${p}`, label: p === 'p50' ? `${label} median` : `${label} ${p.toUpperCase()}`, unit, tip, best: p === 'p50' ? best : undefined, get: timed((r) => r[key], (r) => r[key][p]), fmt: f }));

/** Median speed column falls back to the published figure (shown with ~) when a model has no timed replies. */
const withEst = (cols: Col[]): Col[] => cols.map((c) => c.key !== 'speed.p50' ? c : { ...c, get: (r: CompareRow) => (r.speed.n ? r.speed.p50 : r.est || null), fmt: (v: number, r: CompareRow) => (r.speed.n ? rate(v) : '~' + rate(v)) });

const GROUPS: Group[] = [
  { id: 'trend', title: 'Trend (7 days)', cols: [
    { key: 'trend.speed', label: 'Speed', tip: 'Median output speed per day, last 7 days (sorts by today)', get: (r) => lastOf(r.trend.speed), fmt: (_v, r) => spark(r.trend.speed, r.src === 'codex' ? OAI : '#26d4f8') },
    { key: 'trend.cost', label: 'Cost', tip: 'Estimated cost per day, last 7 days (sorts by today)', get: (r) => r.trend.cost[6], fmt: (_v, r) => spark(r.trend.cost, r.src === 'codex' ? OAI : '#ffc060') },
  ] },
  { id: 'usage', title: 'Usage', cols: [
    { key: 'req', label: 'Requests', get: (r) => r.req, fmt: (v) => int(v) },
    { key: 'out', label: 'Output tokens', get: (r) => r.out, fmt: (v) => compactStr(v) },
    { key: 'share', label: 'Share', unit: '%', get: (r) => r.share * 100, fmt: (v) => v.toFixed(1) },
    { key: 'tasks', label: 'Tasks', tip: 'Prompt turns this model worked on', get: (r) => r.tasks, fmt: (v) => int(v) },
    { key: 'peak', label: 'Peak context', get: (r) => r.peak, fmt: (v, r) => `${compactStr(v)} / ${compactStr(r.window)}` },
    { key: 'hit', label: 'Cache hit', unit: '%', best: 'hi', get: (r) => r.hit * 100, fmt: (v) => v.toFixed(1) },
    { key: 'sub', label: 'Subagent share', unit: '%', get: (r) => r.sub * 100, fmt: (v) => v.toFixed(1) },
  ] },
  { id: 'price', title: 'Price (USD)', cols: [
    { key: 'costTask', label: 'Cost per task', tip: 'Mean API-equivalent cost of one prompt turn (the prompt and every call it triggered)', best: 'lo', get: (r) => r.costTask, fmt: cost },
    { key: 'costReq', label: 'Cost per request', best: 'lo', get: (r) => r.costReq, fmt: (v) => '$' + v.toFixed(3) },
    { key: 'cost', label: 'Total (est.)', get: (r) => r.cost, fmt: cost },
    { key: 'p.in', label: 'Input price', unit: '/1M', get: (r) => r.price?.in ?? null, fmt: price },
    { key: 'p.out', label: 'Output price', unit: '/1M', get: (r) => r.price?.out ?? null, fmt: price },
    { key: 'p.cr', label: 'Cache read price', unit: '/1M', get: (r) => r.price?.cr ?? null, fmt: price },
    { key: 'p.cw', label: 'Cache write price', unit: '/1M', get: (r) => r.price?.cw ?? null, fmt: price },
  ] },
  { id: 'speed', title: 'Output speed (tokens/s after first token)', cols: [
    ...withEst(dist('speed', rate, 'tok/s', 'Output speed', 'hi', 'Per reply: (output tokens - 1) / time from first token to last event. Codex rows use the first Output item time from its logs. A ~ value is the published speed (Artificial Analysis), shown when a model has no timed replies.')),
    { key: 'e2e.p50', label: 'Median incl. first-token wait', unit: 'tok/s', tip: 'Output tokens / total reply time (first-token wait included), every reply. Not comparable to AA', get: timed((r) => r.e2e, (r) => r.e2e.p50), fmt: rate },
  ] },
  { id: 'lat', title: 'Latency (seconds)', cols: [
    ...dist('ttft', sec, 's', 'First chunk', 'lo', 'Request start to the first thinking token'),
    { key: 'ans.p50', label: 'First answer median', unit: 's', tip: 'Request start to the end of thinking', best: 'lo', get: timed((r) => r.ans, (r) => r.ans.p50), fmt: sec },
  ] },
  { id: 'e2e', title: 'End-to-end response time (seconds)', cols: [
    { key: 'lat.p50', label: 'Total response median', unit: 's', best: 'lo', get: timed((r) => r.lat, (r) => r.lat.p50), fmt: sec },
    { key: 'lat.p95', label: 'Total response P95', unit: 's', get: timed((r) => r.lat, (r) => r.lat.p95), fmt: sec },
    { key: 'think.p50', label: 'Reasoning time median', unit: 's', get: timed((r) => r.think, (r) => r.think.p50), fmt: sec },
    { key: 'timed', label: 'Replies timed', tip: 'Replies with first-token timing (the speed, first chunk and reasoning columns use these)', get: (r) => r.speed.n, fmt: (v) => int(v) },
  ] },
];

const WINDOWS = [{ t: '24H', d: 1 }, { t: '7D', d: 7 }, { t: '30D', d: 30 }, { t: 'All', d: 0 }];
const fam = (id: string) => (id.includes('opus') ? 'opus' : id.includes('haiku') ? 'haiku' : /^(gpt|codex|o\d|xai)/.test(id) ? 'codex' : 'sonnet');
const OAI = '#8ab4ff'; // OpenAI (Codex) rows: slightly blue, so they stand out from Claude
const LS = 'tokenhud.compare';
const LOW_REQ = 20; // fewer requests than this in the window = low confidence; hidden when "hide low confidence" is on

export function mountCompare(host: HTMLElement): () => void {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
  const st = { pin: (saved.pin ?? '') as string, days: (saved.days ?? 7) as number, effort: (saved.effort ?? '') as string, closed: new Set<string>(saved.closed ?? []), sort: (saved.sort ?? 'req') as string, dir: (saved.dir ?? -1) as number, hideLow: !!saved.hideLow };
  const persist = () => localStorage.setItem(LS, JSON.stringify({ pin: st.pin, days: st.days, effort: st.effort, closed: [...st.closed], sort: st.sort, dir: st.dir, hideLow: st.hideLow }));
  let data: Compare | null = null, dead = false, sel = '';
  const rk = (r: CompareRow) => `${r.id}|${r.effort}|${r.fast ? 1 : 0}`;

  host.innerHTML = card('Model leaderboard', '<div class="cmp-bar" id="cmp-bar"></div><div class="cmp-wrap" id="cmp-wrap"><div class="muted" style="padding:16px">Loading…</div></div>', {
    sub: 'One row per model and reasoning level · click a column to sort · collapse a group with its arrow',
    right: seg(WINDOWS.map((w) => w.t), Math.max(0, WINDOWS.findIndex((w) => w.d === st.days))),
  });
  const wrap = host.querySelector('#cmp-wrap') as HTMLElement, bar = host.querySelector('#cmp-bar') as HTMLElement;

  const colOf = (key: string) => GROUPS.flatMap((g) => g.cols).find((c) => c.key === key);
  function render() {
    if (!data) return;
    const d = data;
    const inEff = (r: CompareRow) => !st.effort || r.effort === st.effort;
    const hiddenLow = d.rows.filter((r) => inEff(r) && r.req < LOW_REQ).length;
    bar.innerHTML = `<label class="muted">Reasoning</label><select id="cmp-eff"><option value="">All</option>${d.efforts.map((e) => `<option value="${e}"${e === st.effort ? ' selected' : ''}>${e}</option>`).join('')}</select>
      <label class="muted" style="cursor:pointer" title="Hides models with fewer than ${LOW_REQ} requests in this window; their speed and cost figures are too thin to rank"><input type="checkbox" id="cmp-low"${st.hideLow ? ' checked' : ''}> hide low confidence</label>
      <span class="muted" style="margin-left:auto">${d.rows.length} model${d.rows.length === 1 ? '' : 's'}${st.hideLow && hiddenLow ? ` · ${hiddenLow} hidden` : ''} · ${st.days ? `last ${st.days === 1 ? '24 h' : st.days + ' days'}` : 'all time'}</span>`;
    const pr = d.rows.find((r) => rk(r) === st.pin);
    if (pr) bar.insertAdjacentHTML('beforeend', `<span class="cmp-pinned lift" title="Pinned model (star a row to change)">${icon(Star, 13)}<b>${esc(pr.name)} ${esc(pr.effort)}</b>${pr.speed.n ? `<span>${rate(pr.speed.p50)} tok/s</span>` : ''}${pr.ttft.n ? `<span>${sec(pr.ttft.p50)} s first chunk</span>` : ''}<span>${cost(pr.costTask)}/task</span><span>${(pr.share * 100).toFixed(0)}% of requests</span></span>`);
    (bar.querySelector('#cmp-eff') as HTMLSelectElement).onchange = (e) => { st.effort = (e.target as HTMLSelectElement).value; persist(); render(); };
    (bar.querySelector('#cmp-low') as HTMLInputElement).onchange = (e) => { st.hideLow = (e.target as HTMLInputElement).checked; persist(); render(); };
    const rows = d.rows.filter((r) => inEff(r) && (!st.hideLow || r.req >= LOW_REQ));
    const sc = colOf(st.sort);
    if (sc) rows.sort((a, b) => { const x = sc.get(a), y = sc.get(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return (x - y) * st.dir; });
    rows.sort((a, b) => Number(rk(b) === st.pin) - Number(rk(a) === st.pin)); // pinned model first (stable)
    const shown = (g: Group) => (st.closed.has(g.id) ? g.cols.slice(0, 1) : g.cols);
    const best = new Map<string, number>();
    for (const g of GROUPS) for (const c of shown(g)) if (c.best) { const vs = rows.map((r) => c.get(r)).filter((v): v is number => v !== null && v > 0); if (vs.length > 1) best.set(c.key, c.best === 'hi' ? Math.max(...vs) : Math.min(...vs)); }
    const head1 = GROUPS.map((g) => {
      const closed = st.closed.has(g.id);
      return `<th class="grp gs" colspan="${shown(g).length}"><button data-g="${g.id}" title="${closed ? 'Show all columns' : 'Reduce to the headline column'}"><span>${esc(g.title)}</span>${icon(closed ? ArrowRightToLine : ArrowLeftToLine, 13)}</button></th>`;
    }).join('');
    const head2 = GROUPS.flatMap((g) => shown(g).map((c, i) => `<th class="num srt${c.key === st.sort ? ' on' : ''}${i === 0 ? ' gs' : ''}" data-c="${c.key}" title="${esc(c.tip || c.label)}">${esc(c.label)}${c.unit ? `<small>${esc(c.unit)}</small>` : ''}${c.key === st.sort ? icon(st.dir > 0 ? ArrowUp : ArrowDown, 11) : ''}</th>`)).join('');
    const body = rows.map((r) => `<tr data-r="${esc(rk(r))}" class="${rk(r) === sel ? 'sel' : ''}${r.src === 'codex' ? ' cx' : ''}"><td class="mdl"><i class="mbar ${fam(r.id)}"></i><button class="pin${rk(r) === st.pin ? ' on' : ''}" data-pin="${esc(rk(r))}" title="Pin this model to the top">${icon(Star, 13)}</button><span class="strong">${esc(r.name)}</span><span class="eff">${esc(r.effort)}${r.fast ? ' · fast' : ''}</span></td>${GROUPS.flatMap((g) => shown(g).map((c, i) => {
      const v = c.get(r), b = best.get(c.key);
      return `<td class="num${i === 0 ? ' gs' : ''}${v !== null && b !== undefined && v === b ? ' top' : ''}">${v === null || (v === 0 && c.best) ? '<span class="muted">–</span>' : c.fmt(v, r)}</td>`;
    })).join('')}</tr>`).join('');
    wrap.innerHTML = `<table class="tbl cmp"><thead><tr><th class="mdl" rowspan="2">Model · reasoning</th>${head1}</tr><tr class="r2">${head2}</tr></thead><tbody>${body || `<tr><td colspan="40" class="muted" style="padding:16px">${st.hideLow && hiddenLow ? `Every model here has fewer than ${LOW_REQ} requests. Untick "hide low confidence" to see them.` : 'No requests in this window.'}</td></tr>`}</tbody></table>`;
    wrap.querySelectorAll<HTMLElement>('[data-g]').forEach((b) => b.addEventListener('click', () => { const g = b.dataset.g!; if (st.closed.has(g)) st.closed.delete(g); else st.closed.add(g); persist(); render(); }));
    wrap.querySelectorAll<HTMLElement>('[data-pin]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); st.pin = st.pin === b.dataset.pin ? '' : b.dataset.pin!; persist(); render(); }));
    wrap.querySelectorAll<HTMLElement>('tbody tr[data-r]').forEach((tr) => tr.addEventListener('click', () => { sel = sel === tr.dataset.r ? '' : tr.dataset.r!; wrap.querySelectorAll('tbody tr').forEach((x) => x.classList.toggle('sel', (x as HTMLElement).dataset.r === sel)); }));
    wrap.querySelectorAll<HTMLElement>('th[data-c]').forEach((h) => h.addEventListener('click', () => { const k = h.dataset.c!; if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = colOf(k)?.best === 'lo' ? 1 : -1; } persist(); render(); }));
  }

  const loop = liveLoop(async () => {
    const r = await getJson<Compare>(`/api/compare?days=${st.days}`);
    if (!r || dead) return;
    if (data && data.days === r.days && JSON.stringify(data.rows) === JSON.stringify(r.rows)) return;
    data = r; render();
  }, 30000);
  wireSeg(host, (i) => { st.days = WINDOWS[i].d; persist(); loop.kick(); });
  return () => { dead = true; loop.stop(); };
}
