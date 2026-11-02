// TokenHUD hook forwarder (installed from Settings). Tells the local dashboard which event just happened.
// Only the event name, session, tool name and folder are sent (never prompts or tool output), and nothing is printed,
// because a hook's output can be fed back to Claude.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.TOKENHUD_PORT) || 4317;
let o = {};
try { o = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const body = JSON.stringify({ hook_event_name: o.hook_event_name, session_id: o.session_id, tool_name: o.tool_name, cwd: o.cwd });
try {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/event', method: 'POST', timeout: 700, headers: { 'x-tokenhud': '1', 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
} catch { process.exit(0); }
