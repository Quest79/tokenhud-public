// M8: live feed from the optional Claude Code status line and hooks. Everything here is parsed defensively because
// the exact payload shape comes from Claude Code and may change; unknown fields are ignored.
const FRESH_MS = 3 * 60e3; // a status payload older than this is treated as "not connected"
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');
const ts = (v) => { // seconds or ms epoch, or an ISO string
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  const n = num(v); if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
};
const win = (w) => {
  if (!w || typeof w !== 'object') return null;
  const pct = num(w.used_percentage ?? w.percent_used ?? w.used_pct);
  return pct == null ? null : { pct, resetsAt: ts(w.resets_at ?? w.reset_at) };
};

let last = null; // newest status payload, normalised
const running = new Map(); // sid -> { tool, since, prompt }
const events = []; // newest last, capped

export function ingestStatus(o, now = Date.now()) {
  if (!o || typeof o !== 'object') return false;
  const rl = o.rate_limits || {}, cw = o.context_window || {}, pc = o.prompt_cache || {};
  last = {
    at: now, sid: str(o.session_id), name: str(o.session_name), model: str((o.model && (o.model.id || o.model)) || ''),
    plan5h: win(rl.five_hour), plan7d: win(rl.seven_day),
    ctx: num(cw.used_percentage) == null ? null : { pct: num(cw.used_percentage), size: num(cw.context_window_size), over200k: !!cw.exceeds_200k_tokens },
    cache: Object.keys(pc).length ? {
      warm: pc.warm == null ? null : !!pc.warm, ttl: num(pc.ttl), expiresAt: ts(pc.expires_at), hit: num(pc.hit_ratio), misses: num(pc.misses),
      lastMissCause: str(pc.last_miss_cause), recacheTokens: num(pc.recache_tokens_if_cold),
    } : null,
    costUsd: o.cost ? num(o.cost.total_cost_usd) : null,
    effort: o.effort ? str(o.effort.level) : '', fast: !!o.fast_mode, thinking: !!(o.thinking && o.thinking.enabled),
  };
  return true;
}

export function ingestEvent(o, now = Date.now()) {
  if (!o || typeof o !== 'object') return false;
  const name = str(o.hook_event_name || o.event), sid = str(o.session_id);
  if (!name) return false;
  const tool = str(o.tool_name);
  if (name === 'PreToolUse') running.set(sid, { tool, since: now, prompt: false });
  else if (name === 'PostToolUse') running.delete(sid);
  else if (name === 'UserPromptSubmit') running.set(sid, { tool: '', since: now, prompt: true });
  else if (name === 'Stop' || name === 'SessionEnd') running.delete(sid);
  events.push({ ts: now, name, sid, tool });
  if (events.length > 200) events.splice(0, events.length - 200);
  for (const [k, v] of running) if (now - v.since > 30 * 60e3) running.delete(k); // lost Stop events
  return true;
}

/** What the hooks say a session is doing right now (null when nothing is known). */
export const runningOf = (sid, now = Date.now()) => {
  const r = running.get(sid);
  return r && now - r.since < 30 * 60e3 ? { tool: r.tool, thinking: r.prompt, ageMs: now - r.since } : null;
};

export function feedSnapshot(now = Date.now()) {
  const fresh = !!last && now - last.at < FRESH_MS;
  const ev = events.length ? events[events.length - 1] : null;
  return {
    now, fresh, ageMs: last ? now - last.at : null, hooks: !!ev, lastEvent: ev, events: events.slice(-30).reverse(),
    ...(last || {}), at: last ? last.at : null,
    plan5h: fresh && last.plan5h && (last.plan5h.resetsAt == null || last.plan5h.resetsAt > now) ? last.plan5h : null,
    plan7d: fresh && last.plan7d && (last.plan7d.resetsAt == null || last.plan7d.resetsAt > now) ? last.plan7d : null,
  };
}
