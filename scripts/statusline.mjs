// TokenHUD status line forwarder (installed from Settings). Sends Claude Code's status JSON to the local dashboard,
// then prints a short status text. If a status line existed before, it is run and its output is printed instead.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.TOKENHUD_PORT) || 4317;
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

const send = new Promise((resolve) => {
  try {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/status', method: 'POST', timeout: 700, headers: { 'x-tokenhud': '1', 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', resolve); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(raw || '{}');
  } catch { resolve(); }
});

let out = '';
try {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'TokenHUD');
  const chain = JSON.parse(fs.readFileSync(path.join(dir, 'integration.json'), 'utf8')).chain;
  if (chain && chain.command) out = spawnSync(chain.command, { shell: true, input: raw, encoding: 'utf8', timeout: 4000 }).stdout || '';
} catch { /* no chained status line */ }
if (!out) {
  try {
    const o = JSON.parse(raw);
    const bits = [o.model && (o.model.display_name || o.model.id)];
    if (o.context_window && o.context_window.used_percentage != null) bits.push(`ctx ${Math.round(o.context_window.used_percentage)}%`);
    const f = o.rate_limits && o.rate_limits.five_hour;
    if (f && f.used_percentage != null) bits.push(`5h ${Math.round(f.used_percentage)}%`);
    out = bits.filter(Boolean).join(' · ');
  } catch { /* leave empty */ }
}
await send;
process.stdout.write(out);
