// Output speed and latency from message timing, using the standard LLM serving definitions:
//   latency (E2E)  = request start to the reply's last event
//   TTFT           = request start to the first generated token
//   output speed   = tokens after the first / time from first token to last event   (decode speed; TPOT = 1000 / this)
//   tok/s (E2E)    = output tokens / latency (includes TTFT, so lower than output speed)
// Request start is the event before the reply. The first token is only knowable when the reply has a thinking block
// (Claude Code logs its start as end time minus thinkingDurationMs); other replies count toward E2E only.
// Replies under 200 ms, over 10 min, or implying over 500 tok/s are ignored as timing noise. No imports, so any module can use it.
const OK = (l) => l > 200 && l < 600000;
export const dur = (m) => { const l = m.ts - (m.startTs || m.ts); return OK(l) && m.out / (l / 1000) <= 500 ? l : 0; };
/** Decode window (first token to last event), 0 when the first token time is unknown or implausible. */
export const decMs = (m) => { if (!m.firstTs || !m.startTs || m.firstTs <= m.startTs || m.firstTs - m.startTs > 120000) return 0; const l = m.ts - m.firstTs; return l >= 300 && l < 600000 && (m.out - 1) / (l / 1000) <= 500 ? l : 0; };
export const spd = () => ({ out: 0, ms: 0, dOut: 0, dMs: 0, tt: [], lat: [] });
export const addSpd = (x, m) => {
  const l = dur(m); if (l) { x.out += m.out; x.ms += l; x.lat.push(l); }
  const d = decMs(m); if (d) { x.dOut += m.out - 1; x.dMs += d; x.tt.push(m.firstTs - m.startTs); }
  return x;
};
export const mergeSpd = (a, b) => { a.out += b.out; a.ms += b.ms; a.dOut += b.dOut; a.dMs += b.dMs; for (const v of b.tt) a.tt.push(v); for (const v of b.lat) a.lat.push(v); return a; };
export const tps = (x) => (x && x.ms ? x.out / (x.ms / 1000) : 0);
export const msgTps = (m) => { const l = dur(m); return l ? m.out / (l / 1000) : 0; };
/** One reply's numbers (any can be 0 when unknown). */
export const msgSpeed = (m) => {
  const d = decMs(m), l = dur(m);
  return { lat: l, ttft: d ? m.firstTs - m.startTs : 0, ans: d && m.thinkEnd > m.firstTs ? m.thinkEnd - m.startTs : 0, think: d ? m.thinkMs || 0 : 0, dtps: d ? (m.out - 1) / (d / 1000) : 0, tps: l ? m.out / (l / 1000) : 0 };
};
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const dist = (a) => ({ n: a.length, p50: Math.round(pct(a, 0.5)), p95: Math.round(pct(a, 0.95)), avg: a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0 });
/** The full standard set for a group of replies. */
export const speedStats = (x) => {
  const dtps = x.dMs ? x.dOut / (x.dMs / 1000) : 0;
  return { tps: +tps(x).toFixed(1), dtps: +dtps.toFixed(1), tpot: dtps ? +(1000 / dtps).toFixed(2) : 0, ttft: dist(x.tt), lat: dist(x.lat) };
};

/** Model name with its reasoning effort and fast-mode flag, e.g. `Opus 5.5 · xhigh`. */
export const withEffort = (name, m) => name + (m && m.effort ? ' · ' + m.effort : '') + (m && m.fast ? ' · fast' : '');
