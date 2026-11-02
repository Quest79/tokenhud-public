export const int = (n: number) => Math.round(n).toLocaleString('en-US');

/** 1.28 M, 12.4 K, 1.37 B: value and unit split so the unit can be styled small. */
export function compact(n: number): { v: string; u: string } {
  const a = Math.abs(n);
  if (a >= 1e9) return { v: (n / 1e9).toFixed(a >= 1e10 ? 1 : 2), u: 'B' };
  if (a >= 1e6) return { v: (n / 1e6).toFixed(a >= 1e7 ? 1 : 2), u: 'M' };
  if (a >= 1e4) return { v: (n / 1e3).toFixed(1), u: 'K' };
  return { v: int(n), u: '' };
}
export const compactStr = (n: number) => { const c = compact(n); return c.v + c.u; };

export function money(n: number): string {
  if (n >= 1000) return '$' + int(n);
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

export function dur(ms: number): string {
  if (!ms) return '-';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Output speed, tokens per second. A dot when there is no timing yet. */
export const tokps = (v?: number | null): string => (v && v > 0 ? (v >= 10 ? Math.round(v) : v.toFixed(1)).toLocaleString() : '·');

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

import { tzOpt } from './tz';
export const hms = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false, ...tzOpt() });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function bucketLabel(ts: number, fmt: 'time' | 'day' | 'sec'): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (fmt === 'sec') return `${hm}:${String(d.getSeconds()).padStart(2, '0')}`;
  return fmt === 'day' ? `${DAYS[d.getDay()]} ${hm}` : hm;
}

export function pctDelta(cur: number, prev: number): number | undefined {
  if (!prev) return undefined;
  return ((cur - prev) / prev) * 100;
}
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Weighted output speed of many rows: total output over total reply time (each row's time is out / tps). */
export function tpsAvg<T>(rows: T[], out: (r: T) => number, tps: (r: T) => number): number {
  let o = 0, t = 0;
  for (const r of rows) { const s = tps(r); if (s > 0) { o += out(r); t += out(r) / s; } }
  return t ? o / t : 0;
}
