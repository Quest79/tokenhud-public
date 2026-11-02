// M8: opt-in install of the status line feed and hooks into Claude Code's settings.json.
// Nothing here runs on its own: it only acts when the user clicks Install/Remove in Settings.
// Safety: the file is backed up before every change, only TokenHUD's own entries are added or removed,
// and an existing statusLine is chained (kept working), not replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR } from './ingest.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'];
const settingsPath = () => process.env.TOKENHUD_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const STATE = () => path.join(CACHE_DIR, 'integration.json');
const statusCmd = () => `node "${ROOT}/scripts/statusline.mjs"`;
const hookCmd = () => `node "${ROOT}/scripts/hook.mjs"`;
const ours = (cmd) => typeof cmd === 'string' && (cmd.includes(`${ROOT}/scripts/statusline.mjs`) || cmd.includes(`${ROOT}/scripts/hook.mjs`));

function read() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { path: p, exists: false, json: {} };
  const text = fs.readFileSync(p, 'utf8');
  try { return { path: p, exists: true, json: text.trim() ? JSON.parse(text) : {} }; }
  catch { return { path: p, exists: true, json: null, error: 'settings.json is not valid JSON, so TokenHUD will not touch it.' }; }
}
function write(p, json) {
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.tokenhud-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tokenhud-tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
const hasHook = (json, ev) => (json.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => ours(h.command)));
const chainOf = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')).chain || null; } catch { return null; } };

export function status() {
  const s = read();
  if (!s.json) return { path: s.path, error: s.error, statusLine: false, hooks: [], events: EVENTS, plan: [] };
  const sl = s.json.statusLine, chain = chainOf();
  const other = sl && !ours(sl.command) ? sl.command || '(custom)' : chain ? chain.command : null;
  return {
    path: s.path, exists: s.exists,
    statusLine: !!sl && ours(sl.command), existingStatusLine: other,
    hooks: EVENTS.filter((e) => hasHook(s.json, e)), events: EVENTS,
    plan: [
      other ? `Keep your current status line (${other}): TokenHUD forwards the data, then runs yours and shows its output` : 'Add a status line command that forwards plan limits and context data to TokenHUD',
      `Add a hook for ${EVENTS.join(', ')} that tells TokenHUD what Claude is doing right now (event name, session and tool name only)`,
      'Back up settings.json first (a .tokenhud-backup file next to it)',
    ],
  };
}

export function install() {
  const s = read();
  if (!s.json) throw new Error(s.error);
  const j = s.json, sl = j.statusLine;
  if (!sl || !ours(sl.command)) {
    if (sl) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify({ chain: sl })); }
    else try { fs.unlinkSync(STATE()); } catch { /* none */ }
    j.statusLine = { type: 'command', command: statusCmd() };
  }
  if (j.statusLine && ours(j.statusLine.command)) j.statusLine.refreshInterval = 60; // re-run every minute while idle, so the plan meter stays current
  j.hooks = j.hooks || {};
  for (const ev of EVENTS) {
    if (hasHook(j, ev)) continue;
    (j.hooks[ev] = j.hooks[ev] || []).push({ hooks: [{ type: 'command', command: hookCmd(), timeout: 5 }] });
  }
  write(s.path, j);
  return status();
}

export function uninstall() {
  const s = read();
  if (!s.json) throw new Error(s.error);
  const j = s.json;
  if (j.statusLine && ours(j.statusLine.command)) {
    const chain = chainOf();
    if (chain) j.statusLine = chain; else delete j.statusLine;
  }
  if (j.hooks) {
    for (const ev of Object.keys(j.hooks)) {
      j.hooks[ev] = j.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h.command)) })).filter((g) => (g.hooks || []).length);
      if (!j.hooks[ev].length) delete j.hooks[ev];
    }
    if (!Object.keys(j.hooks).length) delete j.hooks;
  }
  write(s.path, j);
  try { fs.unlinkSync(STATE()); } catch { /* none */ }
  return status();
}
