// Model cards: one card per model version + reasoning effort (+ fast). Everything comes from this machine's own usage.
// Output speed: decode tok/s from reply timing (speed.mjs). Tokens: the logs. Hours and $ per 1M come from the plan meter fit
// in planvalue.mjs: a bucket's dollars per 1% of the weekly (or 5 h) meter, and the weekly $ per 1% for all models.
// $ per 1M tokens = list-price cost per 1M x (weekly $ per 1% / bucket $ per 1%). That equals list price when the meter
// charges in proportion to list price, and goes up or down when this model uses the meter faster or slower than average.
import { planValue, bucketOf } from './planvalue.mjs';
import { addSpd, spd, speedStats } from './speed.mjs';
import { shortModel } from './pages.mjs';

const MIN = 60e3, LOW_REQ = 20;

export function modelCards(store, costOf, now = Date.now(), pvIn = null) {
  const pv = pvIn || planValue(store, costOf, now);
  const src = { claude: pv, codex: pv.cx };
  const cards = new Map();
  for (const m of store.msgs.values()) {
    if (m.model === '<synthetic>') continue;
    const s = m.src === 'codex' ? 'codex' : 'claude';
    const id = `${s}|${m.model}|${m.effort || ''}|${m.fast ? 1 : 0}`;
    let c = cards.get(id);
    if (!c) cards.set(id, c = { src: s, model: shortModel(m.model), effort: m.effort || '', fast: !!m.fast, bucket: bucketOf(m), req: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, last: 0, mins: new Set(), sp: spd() });
    c.req++; c.in += m.in; c.out += m.out; c.cr += m.cr; c.cw += m.cw; c.cost += costOf(m);
    c.last = Math.max(c.last, m.ts); c.mins.add(Math.floor(m.ts / MIN)); addSpd(c.sp, m);
  }
  const srcCost = { claude: 0, codex: 0 };
  for (const c of cards.values()) srcCost[c.src] += c.cost;
  const row = (S, win, key) => (S && S[win] ? S[win].rows.find((r) => r.key === key) : null);
  const out = [];
  for (const c of cards.values()) {
    const S = src[c.src];
    const total = c.in + c.cr + c.cw + c.out;
    const all = c.in + c.cr + c.cw;
    const sx = speedStats(c.sp);
    const r7 = row(S, 'w7', c.bucket), r5 = row(S, 'h5', c.bucket);
    const hours = c.mins.size / 60;
    const toFill = (r) => (r && r.perPct && c.cost ? (100 * hours * r.perPct) / c.cost : null);
    // No fit for this model's own bucket: fall back to the all-models rate (est), or to list price for the cost
    const toFillAll = (win) => (S && S[win] && S[win].perPct && c.cost ? (100 * hours * S[win].perPct) / c.cost : null);
    // The weekly fit is noisy (r2 about 0.4), so a model's own weekly rate is not trusted over its 5h one: weekly hours = 5h hours x the
    // all-models ratio (weekly $ per 1% / 5h $ per 1%), so models that fill the 5 h window faster also fill the week faster.
    const h5Own = toFill(r5), ratio = S && S.w7 && S.h5 && S.w7.perPct && S.h5.perPct ? S.w7.perPct / S.h5.perPct : null;
    const w7Own = h5Own != null && ratio ? h5Own * ratio : toFill(r7);
    const blendPerM = total ? c.cost / (total / 1e6) : 0;
    const costOwn = r7 && r7.perPct && S.w7.perPct ? (blendPerM * S.w7.perPct) / r7.perPct : null;
    out.push({
      src: c.src, model: c.model, effort: c.effort, fast: c.fast, bucket: c.bucket, req: c.req, total,
      in: c.in, out: c.out, cr: c.cr, cw: c.cw, cacheHit: all ? c.cr / all : 0, avgOut: c.req ? c.out / c.req : 0,
      dtps: sx.dtps || sx.tps, dtpsE2e: !sx.dtps && sx.tps > 0, tps: sx.tps,
      costPerM: costOwn ?? (blendPerM || null), costList: costOwn == null && blendPerM > 0,
      h5: h5Own ?? toFillAll('h5'), h5Est: h5Own == null && toFillAll('h5') != null, w7: w7Own ?? toFillAll('w7'), w7Est: w7Own == null && toFillAll('w7') != null,
      share: srcCost[c.src] ? c.cost / srcCost[c.src] : 0,
      meter: !r7 || r7.perPct == null ? 'none' : r7.low ? 'low' : 'good', rel: r7 && r7.rel != null ? r7.rel : null, thin: c.req < LOW_REQ, last: c.last,
    });
  }
  out.sort((a, b) => b.total - a.total);
  return {
    cards: out,
    readings: { claude: pv.readings, codex: pv.cx ? pv.cx.readings : 0 },
    weekUsd: { claude: pv.w7.perPct, codex: pv.cx ? pv.cx.w7.perPct : null },
  };
}
