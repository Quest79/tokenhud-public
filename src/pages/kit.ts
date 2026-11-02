// Small helpers shared by the M4-M6 pages.
import type { ECharts } from 'echarts/core';
import { Gauge, Timer, Zap, Clock, Activity } from 'lucide';
import { kpi, icon, type KpiOpts } from '../ui';
import { dur, tokps, int } from '../format';
import type { Speed } from '../api';
import { init } from '../charts';
import { tzOpt } from '../tz';

export interface Tile extends Omit<KpiOpts, 'value'> { value: string; sub?: string }

/** A row of KPI tiles (cyan/purple/... as given), each with a one-line caption instead of a delta chip. */
export function kpiRow(tiles: Tile[], span = 'c2'): string {
  return `<div class="row">${tiles.map((t) => `<div class="${span}">${kpi(t).replace('<div class="kpi-foot"><span></span></div>', `<div class="kpi-foot"><span class="muted" style="font-size: calc(12px * var(--fs, 1))">${t.sub ?? ''}</span></div>`)}</div>`).join('')}</div>`;
}

/** Owns the charts of one page so cleanup is a single call. */
export function chartBag() {
  let list: ECharts[] = [];
  return {
    mk(el: HTMLElement, opt: any) { const c = init(el, opt); list.push(c); return c; },
    dispose() { list.forEach((c) => c.dispose()); list = []; },
  };
}

export const shortId = (s: string) => s.slice(0, 8);
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const clockTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false, ...tzOpt() });
export const dayTime = (ts: number) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...tzOpt() });
export const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const hhmmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const note = (msg: string) => `<p class="muted" style="padding:18px 4px">${msg}</p>`;

/** The standard speed and latency tiles (output speed after the first token, end-to-end speed, TTFT, latency, TPOT). */
export function speedRow(sx?: Speed | null): string {
  if (!sx || (!sx.lat.n && !sx.ttft.n)) return '';
  const t = (n: number) => (n ? dur(n) : '-');
  return kpiRow([
    { label: 'Output speed', value: sx.dtps ? tokps(sx.dtps) : '–', unit: sx.dtps ? 'tok/s' : '', chip: { svg: icon(Gauge, 20), hue: 'blue' }, sub: sx.dtps ? 'after the first token' : 'needs replies with thinking' },
    { label: 'End-to-end speed', value: sx.tps ? tokps(sx.tps) : '–', unit: sx.tps ? 'tok/s' : '', color: 'green', chip: { svg: icon(Zap, 20), hue: 'green' }, sub: 'output / total reply time' },
    { label: 'Time to first token', value: t(sx.ttft.p50), color: 'purple', chip: { svg: icon(Timer, 20), hue: 'purple' }, sub: sx.ttft.n ? `median · p95 ${t(sx.ttft.p95)}` : 'needs replies with thinking' },
    { label: 'Reply latency', value: t(sx.lat.p50), color: 'amber', chip: { svg: icon(Clock, 20) }, sub: sx.lat.n ? `median · p95 ${t(sx.lat.p95)}` : '' },
    { label: 'Time per token', value: sx.tpot ? sx.tpot.toFixed(1) : '–', unit: sx.tpot ? 'ms' : '', chip: { svg: icon(Activity, 20), hue: 'blue' }, sub: 'TPOT, after the first token' },
    { label: 'Replies timed', value: int(sx.lat.n), color: 'purple', chip: { svg: icon(Gauge, 20), hue: 'purple' }, sub: `${int(sx.ttft.n)} with first-token time` },
  ]);
}
