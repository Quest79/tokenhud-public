// User settings (budgets, alert thresholds, price overrides, window size, time zone), stored next to the cache.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './ingest.mjs';

export const DEFAULTS = {
  budgets: { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }, // 0 = off
  thresholds: { ctxPct: 85, cacheHitPct: 80, slowTurnSec: 300, toolErrorPct: 5, anomalyX: 3, errorTargetPct: 98, meterTurnPct: 10, meterSessionPct: 50, rewriteX: 2 },
  contextWindow: 'auto', // 'auto' | 200000 | 1000000
  tz: 'local', // 'local' | 'UTC'
  appearance: { font: 'inter', size: 100, scale: 100, shadow: 'none', shadowColor: '#00d0f8', outline: 0, outlineColor: '#000000', density: 'normal', motion: true, card: { preset: 'default', bg1: '#071727', bg2: '#041420', angle: 180, border1: '#00d0f8', border2: '#9058f8', shadow: 'soft', shadowColor: '#000000', shadowSize: 24 } }, // client look, validated here too
  planPoll: false, // read the plan % automatically every few minutes (uses the Claude Code login token; off until switched on)
  navFavs: null, // starred sections in the top row (page ids); null = the built-in set. Kept here, not in browser storage, so every window and port shares it
  pricing: {}, // overrides per model family: { opus: { in, out, cw5m, cw1h, cr } }
};

const FILE = path.join(CACHE_DIR, 'settings.json');
let S = clone(DEFAULTS);
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function num(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }

/** Merge untrusted input into a valid settings object (unknown keys dropped, numbers clamped). */
export function sanitize(inp, cur = S) {
  const o = clone(cur);
  if (!inp || typeof inp !== 'object') return o;
  if (inp.budgets) for (const k of Object.keys(o.budgets)) if (k in inp.budgets) o.budgets[k] = num(inp.budgets[k], 0, 1e7, o.budgets[k]);
  if (inp.thresholds) {
    const lim = { ctxPct: [10, 100], cacheHitPct: [0, 100], slowTurnSec: [5, 36000], toolErrorPct: [0, 100], anomalyX: [1.2, 50], errorTargetPct: [50, 100], meterTurnPct: [1, 100], meterSessionPct: [5, 100], rewriteX: [1.2, 20] };
    for (const k of Object.keys(o.thresholds)) if (k in inp.thresholds) o.thresholds[k] = num(inp.thresholds[k], lim[k][0], lim[k][1], o.thresholds[k]);
  }
  if ('contextWindow' in inp) o.contextWindow = inp.contextWindow === 'auto' ? 'auto' : [200000, 1000000].includes(Number(inp.contextWindow)) ? Number(inp.contextWindow) : o.contextWindow;
  if (inp.appearance && typeof inp.appearance === 'object') {
    const a = inp.appearance, d = o.appearance, hex = (v, x) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : x);
    o.appearance = {
      font: ['inter', 'system', 'segoe', 'arial', 'verdana', 'georgia', 'mono', 'consolas'].includes(a.font) ? a.font : d.font,
      size: num(a.size, 80, 140, d.size), scale: num(a.scale, 70, 160, d.scale),
      shadow: ['none', 'soft', 'glow', 'hard'].includes(a.shadow) ? a.shadow : d.shadow, shadowColor: hex(a.shadowColor, d.shadowColor),
      outline: num(a.outline, 0, 1.5, d.outline), outlineColor: hex(a.outlineColor, d.outlineColor),
      density: ['compact', 'normal', 'roomy'].includes(a.density) ? a.density : d.density, motion: 'motion' in a ? a.motion !== false : d.motion,
      card: ((c, k) => c && typeof c === 'object' ? {
        preset: ['default', 'midnight', 'ember', 'forest', 'violet', 'graphite'].includes(c.preset) ? c.preset : 'custom',
        bg1: hex(c.bg1, k.bg1), bg2: hex(c.bg2, k.bg2), angle: num(c.angle, 0, 360, k.angle), border1: hex(c.border1, k.border1), border2: hex(c.border2, k.border2),
        shadow: ['none', 'soft', 'deep', 'glow', 'neon'].includes(c.shadow) ? c.shadow : k.shadow, shadowColor: hex(c.shadowColor, k.shadowColor), shadowSize: num(c.shadowSize, 0, 60, k.shadowSize),
      } : k)(a.card, d.card),
    };
  }
  if ('navFavs' in inp) o.navFavs = Array.isArray(inp.navFavs) ? [...new Set(inp.navFavs.filter((x) => typeof x === 'string' && /^[a-z0-9-]{1,24}$/.test(x)))].slice(0, 40) : null;
  if ('planPoll' in inp) o.planPoll = inp.planPoll === true;
  if ('tz' in inp) o.tz = inp.tz === 'UTC' ? 'UTC' : 'local';
  if (inp.pricing && typeof inp.pricing === 'object') {
    o.pricing = {};
    for (const [fam, p] of Object.entries(inp.pricing)) {
      if (!/^[a-z0-9-]{2,24}$/.test(fam) || !p || typeof p !== 'object') continue;
      const row = {};
      for (const k of ['in', 'out', 'cw5m', 'cw1h', 'cr']) if (k in p) row[k] = num(p[k], 0, 1000, 0);
      if (Object.keys(row).length) o.pricing[fam] = row;
    }
  }
  return o;
}

export function loadSettings() {
  try { S = sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')), clone(DEFAULTS)); } catch { S = clone(DEFAULTS); }
  return S;
}
export const getSettings = () => S;
export function saveSettings(inp) {
  S = sanitize(inp, S);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S, null, 2));
  fs.renameSync(tmp, FILE);
  return S;
}
