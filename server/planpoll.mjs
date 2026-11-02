// Optional automatic plan % reading (off until switched on in Settings).
// Asks Anthropic's usage endpoint for the 5-hour and weekly meters, using the Claude Code login token already on this
// computer, and stores each answer as a reading. The token is read from disk per call, sent only to api.anthropic.com
// and never stored or logged. Without this, readings only appear when get_usage runs or the status line feed is live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addSample } from './planvalue.mjs';

const URL_ = 'https://api.anthropic.com/api/oauth/usage';
const EVERY = 60e3; // once a minute (was 3 min); the on/off switch (planPoll) is still the user's
export const CRED = path.join(os.homedir(), '.claude', '.credentials.json');
// Second account, signed in from its own config folder. Polled only once its login file exists.
export const CRED2 = path.join(os.homedir(), '.claude-acct2', '.credentials.json');
const st = { on: false, idle: false, ok: null, ts: null, error: null, count: 0 };
let timer = null, backoff = 0, fails = 0;

const IDLE = 10 * 60e3; // no request goes out unless a Claude prompt was submitted within this long
export const promptedRecently = (store, now = Date.now()) => {
  for (const p of store.prompts) if (p.ts >= now - IDLE && p.ts <= now + 60e3 && (store.sessions.get(p.sid) || {}).src !== 'codex') return true;
  return false;
};

export const pollStatus = () => ({ ...st });

/** Turn the endpoint's JSON into a reading, or null. Percent is 0..100; reset times are ISO strings. */
export function parseUsage(j, ts = Date.now()) {
  const w = (x) => (x && typeof x.utilization === 'number' ? { p: x.utilization, r: x.resets_at ? Date.parse(x.resets_at) : null } : null);
  const a = w(j && j.five_hour), b = w(j && j.seven_day);
  if (!a && !b) return null;
  return { ts, p5: a ? a.p : null, r5: a ? a.r : null, p7: b ? b.p : null, r7: b ? b.r : null };
}

export async function pollOnce(store, fetchFn = fetch, credFile = CRED, acct = 1) {
  let tok;
  try { tok = JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken; } catch { tok = null; }
  if (!tok) { Object.assign(st, { ok: false, ts: Date.now(), error: 'No Claude Code login found on this computer' }); return false; }
  try {
    const r = await fetchFn(URL_, { headers: { authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      // 429: wait the server's Retry-After (else doubling 2, 4, 8, 15 min) so polling stops feeding the limit
      if (r.status === 429) { fails++; const ra = Number(r.headers.get('retry-after')); backoff = Math.min(15, Math.max(Number.isFinite(ra) && ra > 0 ? Math.ceil(ra / 60) : 0, 2 ** fails)); } else backoff = 0; Object.assign(st, { ok: false, ts: Date.now(), error: r.status === 401 || r.status === 403 ? 'Login expired. Use Claude Code once to refresh it' : 'Usage request failed (HTTP ' + r.status + ')' }); return false; }
    const s = parseUsage(await r.json());
    if (!s) { Object.assign(st, { ok: false, ts: Date.now(), error: 'Unrecognised usage reply' }); return false; }
    addSample(store, { ...s, acct });
    backoff = 0; fails = 0;
    Object.assign(st, { ok: true, ts: Date.now(), error: null, count: st.count + 1 });
    return true;
  } catch (e) { Object.assign(st, { ok: false, ts: Date.now(), error: 'Could not reach Anthropic (' + (e.name === 'TimeoutError' ? 'timed out' : 'offline') + ')' }); return false; }
}

/** Start or stop the loop to match the setting. Safe to call on every settings change. */
export function applyPoll(store, on) {
  st.on = !!on;
  if (process.env.TOKENHUD_NOPOLL) return; // test servers must not share the live service's rate limit
  if (!on) { if (timer) clearInterval(timer); timer = null; return; }
  if (timer) return;
  const tick = async () => {
    if (!promptedRecently(store)) { Object.assign(st, { idle: true }); return; }
    st.idle = false;
    if (backoff > 0) { backoff--; return; }
    await pollOnce(store, fetch, CRED, 1);
    if (fs.existsSync(CRED2)) await pollOnce(store, fetch, CRED2, 2);
  };
  tick();
  timer = setInterval(tick, EVERY);
  timer.unref();
}
