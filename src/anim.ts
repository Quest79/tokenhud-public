// Frame loop and easing for the live pages: data arrives every second or so, the screen redraws every frame.
import { shouldRun } from './api';

/** True when the user switched animations off in Settings (then pages redraw about once a second, no easing). */
export const calm = () => document.documentElement.classList.contains('no-motion');

/** Frame-rate independent exponential easing factor for a time constant in ms. */
export const ease = (dt: number, tau: number) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** Runs fn every animation frame while updates are not paused. Returns a stop function. */
export function frameLoop(fn: (ts: number, dt: number) => void): () => void {
  let raf = 0, last = performance.now(), dead = false;
  const step = (ts: number) => {
    if (dead) return;
    const dt = Math.min(1000, ts - last); last = ts;
    if (shouldRun()) fn(ts, dt);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => { dead = true; cancelAnimationFrame(raf); };
}

/** Points of a bucketed series inside the window [t0, now], with an interpolated point on the left edge and a tip at now. */
export function windowPts(ts: number[], vs: number[], t0: number, now: number): [number, number][] {
  const out: [number, number][] = [];
  let prev = -1;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] > now) break;
    if (ts[i] < t0) { prev = i; continue; }
    if (!out.length && prev >= 0) { const f = (t0 - ts[prev]) / (ts[i] - ts[prev]); out.push([t0, vs[prev] + (vs[i] - vs[prev]) * f]); }
    out.push([ts[i], vs[i]]);
  }
  const lastV = out.length ? out[out.length - 1][1] : prev >= 0 ? vs[prev] : 0;
  if (!out.length) out.push([t0, lastV]);
  out.push([now, lastV]);
  return out;
}

/** A bucketed series whose values glide to new targets. New buckets at the right edge start from the previous last value. */
export class EasedSeries {
  t: number[] = []; tgt: number[] = []; cur: number[] = [];
  set(t: number[], v: number[]) {
    const old = new Map<number, number>();
    this.t.forEach((x, i) => old.set(x, this.cur[i]));
    const lastT = this.t.length ? this.t[this.t.length - 1] : -Infinity, lastV = this.cur.length ? this.cur[this.cur.length - 1] : 0;
    this.cur = t.map((x, i) => old.get(x) ?? (x > lastT && old.size ? lastV : v[i]));
    this.t = t; this.tgt = v;
  }
  /** Moves toward the targets by factor k (0..1). Returns true while anything is still moving. */
  step(k: number): boolean {
    let moving = false;
    for (let i = 0; i < this.cur.length; i++) {
      const d = this.tgt[i] - this.cur[i];
      if (Math.abs(d) < 1e-3 * (Math.abs(this.tgt[i]) + 1)) this.cur[i] = this.tgt[i]; else { this.cur[i] += d * k; moving = true; }
    }
    return moving;
  }
  snap() { this.cur = this.tgt.slice(); }
}

/** One number gliding to a target. */
export class Eased {
  cur = 0; tgt = 0; init = false;
  set(v: number, snap = false) { this.tgt = v; if (!this.init || snap) { this.cur = v; this.init = true; } }
  step(k: number): boolean {
    const d = this.tgt - this.cur;
    if (Math.abs(d) < 1e-3 * (Math.abs(this.tgt) + 1)) { this.cur = this.tgt; return false; }
    this.cur += d * k; return true;
  }
}
