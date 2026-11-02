// Small HTML-string component helpers. Styles live in styles/components.css.
import { createElement, ChevronDown, Check, AlertTriangle, Info, Clock, XCircle, Loader } from 'lucide';
import { ZEN, zc } from './theme';

type IconNode = Parameters<typeof createElement>[0];

export function icon(node: IconNode, size = 16): string {
  const el = createElement(node);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', '1.6');
  return el.outerHTML;
}

export const logo = () => ZEN ? `
<svg viewBox="0 0 48 48" aria-hidden="true">
  <path d="M13 8l12 16-12 16h8l12-16-12-16z" fill="#6fb3d2"/>
  <path d="M42 8L30 24l12 16h-8L22 24 34 8z" fill="#a395d4" opacity=".85"/>
</svg>` : `
<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs>
    <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26edf3"/><stop offset="1" stop-color="#2f7cf6"/></linearGradient>
    <linearGradient id="lg2" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a8cff"/><stop offset="1" stop-color="#9058f8"/></linearGradient>
  </defs>
  <path d="M3 24h8" stroke="#26edf3" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="3.2" cy="24" r="1.7" fill="#26edf3"/>
  <path d="M13 8l12 16-12 16h8l12-16-12-16z" fill="url(#lg1)"/>
  <path d="M42 8L30 24l12 16h-8L22 24 34 8z" fill="url(#lg2)" opacity=".92"/>
</svg>`;

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

/* ---------- sparkline ---------- */
export function spark(values: number[], color = '#00d0f8', area = true): string {
  color = zc(color);
  const w = 200, h = 44, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), h - pad - ((v - min) / span) * (h - pad * 2 - 4)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const id = nid('sp');
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${ZEN ? '.14' : '.4'}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>
    <filter id="${id}g" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    ${area ? `<path d="${line} L${w - pad} ${h} L${pad} ${h} Z" fill="url(#${id})"/>` : ''}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="${ZEN ? 1.4 : 1.6}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"${ZEN ? '' : ` filter="url(#${id}g)"`}/>
  </svg>`;
}

/** A sparkline whose shape can be redrawn every frame without rebuilding the SVG. x and y are 0..1. */
export function sparkMount(host: HTMLElement, color = '#00d0f8') {
  color = zc(color);
  const w = 200, h = 44, pad = 3, id = nid('sp');
  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${ZEN ? '.14' : '.4'}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>
    <filter id="${id}g" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <path class="sa" fill="url(#${id})"/>
    <path class="sl" fill="none" stroke="${color}" stroke-width="${ZEN ? 1.4 : 1.6}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"${ZEN ? '' : ` filter="url(#${id}g)"`}/></svg>`;
  const a = host.querySelector('.sa')!, l = host.querySelector('.sl')!;
  return {
    set(xs: number[], ys: number[]) {
      const p = xs.map((x, i) => `${pad + Math.min(1, Math.max(0, x)) * (w - pad * 2)} ${(h - pad - Math.min(1, Math.max(0, ys[i])) * (h - pad * 2 - 4)).toFixed(1)}`);
      const line = 'M' + p.join(' L');
      l.setAttribute('d', line);
      a.setAttribute('d', `${line} L${w - pad} ${h} L${pad} ${h} Z`);
    },
  };
}

/* ---------- KPI tile ---------- */
export interface KpiOpts {
  label: string; value: string; unit?: string;
  delta?: number; lowerIsBetter?: boolean; deltaSuffix?: string;
  series?: number[]; color?: 'cyan' | 'purple' | 'green' | 'amber';
  chip?: { svg: string; hue?: 'cyan' | 'purple' | 'green' | 'blue' }; dropdown?: boolean; id?: string; sub?: string;
}
const HUE = { cyan: zc('#00d0f8'), purple: zc('#9058f8'), green: zc('#00d890'), amber: zc('#f0a038') };

export function deltaChip(delta: number, lowerIsBetter = false, suffix = '%'): string {
  const up = delta > 0, flat = Math.abs(delta) < 0.05;
  const good = flat ? 'flat' : up !== lowerIsBetter ? 'good' : 'bad';
  return `<span class="delta ${good}"><i>${flat ? '●' : up ? '▲' : '▼'}</i>${up ? '+' : ''}${delta.toFixed(delta % 1 ? 1 : 0)}${suffix}</span>`;
}

export function kpi(o: KpiOpts): string {
  const c = o.color ?? 'cyan';
  return `<div class="card kpi ${c} ${o.chip ? 'has-chip' : ''}">
    ${o.chip ? `<div class="chip ${o.chip.hue ?? 'cyan'}">${o.chip.svg}</div>` : ''}
    <div class="kpi-label"><span>${o.label}</span>${o.dropdown ? icon(ChevronDown, 14) : ''}</div>
    <div class="kpi-value" ${o.id ? `id="${o.id}"` : ''}>${o.value}${o.unit ? `<small>${o.unit}</small>` : ''}</div>
    <div class="kpi-foot">${o.delta !== undefined ? deltaChip(o.delta, o.lowerIsBetter, o.deltaSuffix) : '<span></span>'}${o.sub ? ` <span class="muted" style="font-size: calc(12px * var(--fs, 1));white-space:nowrap">${o.sub}</span>` : ''}</div>
    ${o.series ? `<div class="spark">${spark(o.series, HUE[c])}</div>` : ''}
  </div>`;
}

/* ---------- ring gauge: 270 degree arc, gradient, glow, end notch ---------- */
export function ring(pct: number, caption: string, kind: 'cyan' | 'green' | 'purple' | 'amber' = 'cyan'): string {
  const r = 52, cx = 75, cy = 75, C = 2 * Math.PI * r, arc = 0.75 * C;
  const p = Math.max(0, Math.min(1, pct / 100));
  const [c1, c2] = ({ cyan: ['#0a6fd0', '#26d4f8'], green: ['#00b88a', '#2cf59b'], purple: ['#6a3fd8', '#b48cff'], amber: ['#d08020', '#ffc060'] }[kind]).map(zc);
  const glow = { cyan: 'rgba(0,208,248,.55)', green: 'rgba(0,240,152,.5)', purple: 'rgba(144,88,248,.55)', amber: 'rgba(240,160,56,.5)' }[kind];
  const id = nid('rg');
  const ang = ((135 + 270 * p) * Math.PI) / 180;
  const x1 = cx + (r - 10) * Math.cos(ang), y1 = cy + (r - 10) * Math.sin(ang);
  const x2 = cx + (r + 10) * Math.cos(ang), y2 = cy + (r + 10) * Math.sin(ang);
  return `<div class="ring" style="--ring-glow:${glow}">
    <svg viewBox="0 0 150 150">
      <defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${zc('#1a2a44')}" stroke-width="${ZEN ? 9 : 14}" stroke-linecap="round" stroke-dasharray="${arc} ${C}" transform="rotate(135 ${cx} ${cy})"/>
      <g class="glow"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${ZEN ? 9 : 14}" stroke-linecap="round" stroke-dasharray="${arc * p} ${C}" transform="rotate(135 ${cx} ${cy})"/></g>
      ${p > 0.02 && !ZEN ? `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#eaffff" stroke-width="2" stroke-linecap="round" opacity=".9"/>` : ''}
    </svg>
    <div class="ring-center"><b>${Math.round(pct)}%</b><span>${caption}</span></div>
  </div>`;
}

export function miniBars(values: number[], kind: '' | 'green' = ''): string {
  const max = Math.max(...values);
  return `<div class="mini-bars ${kind}">${values.map((v) => `<i style="height:${Math.max(12, (v / max) * 100)}%"></i>`).join('')}</div>`;
}

/* ---------- pills / bars / toggles ---------- */
export type Hue = 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
const PILL_ICON: Record<Hue, IconNode> = { green: Check, amber: AlertTriangle, red: XCircle, blue: Loader, grey: Clock, purple: Info };
export function pill(text: string, hue: Hue): string {
  return `<span class="pill ${hue}">${icon(PILL_ICON[hue], 11)}${text}</span>`;
}

export function bar(pct: number, kind: '' | 'green' | 'purple' | 'amber' | 'red' | 'cx' = '', ticks: number[] = []): string {
  return `<div class="bar ${kind}">${ticks.map((t) => `<span class="tick" style="left:${t}%"></span>`).join('')}<i style="width:${Math.min(100, pct)}%"></i></div>`;
}

export function seg(items: string[], active: number): string {
  return `<div class="seg" role="group">${items.map((t, i) => `<button class="${i === active ? 'on' : ''}">${t}</button>`).join('')}</div>`;
}
export function wireSeg(root: HTMLElement, onChange?: (i: number) => void) {
  root.querySelectorAll<HTMLElement>('.seg').forEach((s) => {
    const btns = [...s.querySelectorAll('button')];
    btns.forEach((b, i) => b.addEventListener('click', () => { btns.forEach((x) => x.classList.remove('on')); b.classList.add('on'); onChange?.(i); }));
  });
}
export const select = (label: string) => `<button class="select">${label}${icon(ChevronDown, 13)}</button>`;

export function inlineBar(pct: number, text: string, kind: '' | 'purple' = ''): string {
  return `<span class="ibar ${kind}"><span class="b"><i style="width:${pct}%"></i></span>${text}</span>`;
}

export function card(title: string, body: string, opts: { cls?: string; right?: string; sub?: string } = {}): string {
  return `<section class="card ${opts.cls ?? ''}">
    <div class="card-head"><div><div class="card-title">${title}</div>${opts.sub ? `<div class="card-sub">${opts.sub}</div>` : ''}</div>${opts.right ?? ''}</div>
    ${body}</section>`;
}

/* ---------- live number: count to value + flash ---------- */
export function setNumber(el: HTMLElement, to: number, fmt: (n: number) => string = (n) => Math.round(n).toLocaleString('en-US')) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (from === to) { el.firstChild && (el.firstChild.textContent = fmt(to)); return; }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 300), e = 1 - Math.pow(1 - k, 3);
    const txt = fmt(from + (to - from) * e);
    if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.textContent = txt; else el.prepend(txt);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
