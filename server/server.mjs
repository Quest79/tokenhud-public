// TokenHUD server: ingests Claude Code transcripts, tails them live, serves the UI + JSON API + SSE.
// Binds to 127.0.0.1 only. Start: node server/server.mjs   (TOKENHUD_PORT overrides 4317)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCodexFile, CODEX_ROOTS } from './codex.mjs';
import { PROJECTS_DIR, CACHE_DIR, loadCache, saveCache, ingestAll, ingestFile, listTranscripts, srcStore, codexPlanNow } from './ingest.mjs';
import { overview, hourly, trayStatus, priceTable, basePrices, costOf } from './stats.mjs';
import { loadSettings, getSettings, saveSettings } from './settings.mjs';
import { alerts, summary } from './insights.mjs';
import { ingestStatus, ingestEvent, feedSnapshot, runningOf } from './feed.mjs';
import { planValue, addSample, meterIndex, latestPlan } from './planvalue.mjs';
import { modelCards } from './cards.mjs';
import { reportHtml, errorPage } from './report.mjs';
import { applyPoll, pollStatus } from './planpoll.mjs';
import * as integ from './integrate.mjs';
import { sessionsList, sessionDetail, traceList, traceDetail, usage, contextInfo, modelsInfo, compareInfo, toolsInfo, toolDetail } from './pages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const PORT = Number(process.env.TOKENHUD_PORT) || 4317;
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// Run by the "TokenHUD Server" scheduled task (scripts/service.ps1): it is a windowless program with no console, so write the log
// ourselves, and keep serving after a stray error instead of dying until the next 5-minute relaunch.
if (process.argv.includes('--log')) {
  const lf = path.join(CACHE_DIR, 'server.log');
  try { if (fs.statSync(lf).size > 2e6) fs.renameSync(lf, lf + '.old'); } catch {}
  const w = (...a) => { try { fs.appendFileSync(lf, `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch {} };
  console.log = console.error = console.warn = w;
  process.on('uncaughtException', (e) => w('uncaught', e));
  process.on('unhandledRejection', (e) => w('unhandled', e));
}

const t0 = Date.now();
loadSettings();
const store = loadCache();
let savedVersion = -1;
const state = { ready: false, done: 0, total: 0, startedAt: t0, paused: false };

// ---------- ingest + live tailing ----------
function backfill() {
  ingestAll(store, (d, t) => { state.done = d; state.total = t; });
  state.ready = true;
  console.log(`ingested ${store.msgs.size} messages from ${state.total} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  broadcast();
}

const pending = new Set();
let timer = null;
function queue(file) {
  pending.add(file);
  if (!timer) timer = setTimeout(flush, 250);
}
function projectOf(file) {
  if (isCodexFile(file)) return 'codex';
  const rel = path.relative(PROJECTS_DIR, file).split(path.sep);
  return rel[0];
}
function flush() {
  timer = null;
  const v = store.version;
  for (const f of pending) {
    try { if (fs.existsSync(f)) ingestFile(store, f, projectOf(f)); } catch (e) { console.error('ingest', f, e.message); }
  }
  pending.clear();
  if (store.version !== v) broadcast();
}
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, name) => { if (name && name.endsWith('.jsonl')) queue(path.join(PROJECTS_DIR, name)); });
} catch (e) { console.error('watch failed, polling only:', e.message); }
for (const root of CODEX_ROOTS) try { fs.watch(root, { recursive: true }, (_ev, name) => { if (name && name.endsWith('.jsonl')) queue(path.join(root, name)); }); } catch { /* codex not installed or not watchable: polling covers it */ }
// safety net: fs.watch can miss events, so compare sizes every 3 s
setInterval(() => {
  if (!state.ready) return;
  for (const { file } of listTranscripts()) {
    let size = 0; try { size = fs.statSync(file).size; } catch { continue; }
    const f = store.files[file];
    if (!f || f.offset !== size) queue(file);
  }
}, 3000).unref();
setInterval(() => { if (state.ready && store.version !== savedVersion) { savedVersion = store.version; try { saveCache(store); } catch (e) { console.error('cache save', e.message); } } }, 60000).unref();

// ---------- SSE ----------
const clients = new Set();
function broadcast() {
  if (state.paused) return;
  const msg = `event: update\ndata: ${JSON.stringify({ v: store.version, ts: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000).unref();

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const hostOk = (h = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);

// Live status line feed first; otherwise the newest reading (get_usage results in transcripts, or a % typed into the Overview)
const planNow = (now = Date.now()) => { const f = feedSnapshot(); if (f.fresh) return f; const r = latestPlan(store, now); return { ...f, plan5h: r.plan5h, plan7d: r.plan7d }; };
const settingsView = () => ({ ...getSettings(), poll: pollStatus(), prices: priceTable(), basePrices: basePrices(), info: { version: pkg.version, port: PORT, projectsDir: PROJECTS_DIR, cacheDir: CACHE_DIR } });

const server = http.createServer((req, res) => {
  if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return json(res, { ok: true, name: 'tokenhud', version: pkg.version, ready: state.ready, paused: state.paused, done: state.done, total: state.total, messages: store.msgs.size, uptimeMs: Date.now() - t0 });
  if (url.pathname === '/api/overview') {
    if (!state.ready) return json(res, { loading: true, done: state.done, total: state.total }, 503);
    const sv = srcStore(store, url.searchParams.get('src'));
    return json(res, { ...overview(sv, url.searchParams.get('range') || '1h'), hourly: hourly(sv), appVersion: pkg.version, paused: state.paused, statusFeed: planNow(), codexPlan: codexPlanNow(store), src: url.searchParams.get('src') || 'all' });
  }
  if (url.pathname === '/api/live') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: update\ndata: ${JSON.stringify({ v: store.version, ts: Date.now() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST') {
    // the custom header can't be sent cross-site without a preflight, which we never answer
    if (req.headers['x-tokenhud'] !== '1') return json(res, { error: 'forbidden' }, 403);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    return req.on('end', () => {
      let o = {}; try { o = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (url.pathname === '/api/pause') {
        state.paused = !!o.paused;
        const msg = `event: pause
data: ${JSON.stringify({ paused: state.paused })}

`;
        for (const c of clients) c.write(msg);
        if (!state.paused) broadcast();
        return json(res, { ok: true, paused: state.paused });
      }
      if (url.pathname === '/api/settings') { saveSettings(o); applyPoll(store, getSettings().planPoll); return json(res, settingsView()); }
      if (url.pathname === '/api/plan/manual') { // the 5-hour % typed into the Overview; keeps the window's reset time while it is still ahead (pace needs it)
        const v = Number(o.p5);
        if (o.p5 == null || o.p5 === '' || !Number.isFinite(v) || v < 0 || v > 100) return json(res, { error: 'p5 must be 0 to 100' }, 400);
        // The pace chip needs a window end: keep the current one while it is ahead, else the 5 h window starts now.
        const r5 = latestPlan(store).plan5h;
        const resetsAt = r5 && r5.resetsAt > Date.now() ? r5.resetsAt : Date.now() + 5 * 3600 * 1000;
        addSample(store, { ts: Date.now(), p5: v, r5: resetsAt });
        broadcast();
        return json(res, { ok: true, plan5h: planNow().plan5h });
      }
      if (url.pathname === '/status') { ingestStatus(o); { const f = feedSnapshot(); if (f.fresh && (f.plan5h || f.plan7d)) addSample(store, { ts: Date.now(), p5: f.plan5h && f.plan5h.pct, r5: f.plan5h && f.plan5h.resetsAt, p7: f.plan7d && f.plan7d.pct, r7: f.plan7d && f.plan7d.resetsAt }); } broadcast(); return json(res, { ok: true }); }
      if (url.pathname === '/event') { ingestEvent(o); broadcast(); return json(res, { ok: true }); }
      if (url.pathname === '/api/integration') {
        try { return json(res, o.action === 'uninstall' ? integ.uninstall() : o.action === 'install' ? integ.install() : { error: 'bad action' }); }
        catch (e) { return json(res, { error: String(e.message || e) }, 400); }
      }
      if (url.pathname === '/api/quit') { json(res, { ok: true }); return setTimeout(shutdown, 100); }
      json(res, { error: 'not found' }, 404);
    });
  }
  if (url.pathname === '/api/settings') return json(res, settingsView());
  if (url.pathname === '/api/feed') return json(res, planNow());
  if (url.pathname === '/api/integration') return json(res, integ.status());
  if (url.pathname.startsWith('/api/') && req.method === 'GET' && url.pathname !== '/api/tray') {
    if (!state.ready) return json(res, { loading: true, done: state.done, total: state.total }, 503);
    const p = url.pathname, q = url.searchParams;
    const sv = srcStore(store, q.get('src'));
    try {
      let m;
      if (p === '/api/sessions') return json(res, sessionsList(sv));
      if ((m = /^\/api\/sessions\/([\w-]+)$/.exec(p))) { const d = sessionDetail(sv, m[1]), mi = d && meterIndex(store, costOf); /* sessions here live in ~/.claude (login 1) */ return d ? json(res, { ...d, hook: runningOf(m[1]), plan5h: mi.usage('5h', m[1]), plan7d: mi.usage('7d', m[1]) }) : json(res, { error: 'no such session' }, 404); }
      if (p === '/api/traces') return json(res, traceList(sv, Date.now(), Number(q.get('limit')) || 60, q.get('sid') || null));
      if ((m = /^\/api\/trace\/([\w-]+)\/(\d+)$/.exec(p))) { const d = traceDetail(sv, m[1], Number(m[2])); return d ? json(res, d) : json(res, { error: 'no such trace' }, 404); }
      if (p === '/api/usage') return json(res, usage(sv));
      if (p === '/api/context') return json(res, contextInfo(sv, q.get('sid') || ''));
      if (p === '/api/models') return json(res, modelsInfo(sv));
      if (p === '/api/compare') return json(res, compareInfo(sv, q.has('days') ? Number(q.get('days')) : 7));
      if ((m = /^\/api\/toolcall\/([\w.:-]+)$/.exec(p))) return toolDetail(store, m[1]).then((d) => (d ? json(res, d) : json(res, { error: 'no such tool call' }, 404)), (e) => json(res, { error: String(e && e.message || e) }, 500));
      if (p === '/api/tools') { const now = Date.now(); return json(res, toolsInfo(sv, now, { claude: meterIndex(store, costOf, now), codex: meterIndex(store, costOf, now, 'codex') })); }
      if (p === '/api/alerts') return json(res, alerts(sv, Date.now(), feedSnapshot()));
      if (p === '/api/summary') return json(res, summary(sv));
      if (p === '/api/plan') return json(res, { ...planValue(store, costOf), poll: pollStatus(), pollOn: !!getSettings().planPoll });
      if (p === '/api/cards') return json(res, modelCards(store, costOf));
      if (p === '/api/report') { // head-to-head plan-usage report of two cards, as a page the Compare models tab frames
        const head = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
        try { const html = reportHtml(store, costOf, q.get('a') || '', q.get('b') || ''); res.writeHead(200, head); return res.end(html); }
        catch (e) { res.writeHead(400, head); return res.end(errorPage(String(e && e.message || e))); }
      }
    } catch (e) { return json(res, { error: String(e && e.message || e) }, 500); }
  }
  if (url.pathname === '/api/tray') return json(res, { ...trayStatus(store), plan5h: (planNow().plan5h || {}).pct ?? null, paused: state.paused, ready: state.ready });
  if (url.pathname.startsWith('/api/')) return json(res, { error: 'not found' }, 404);

  // static UI
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('UI not built yet. Run: npm run build'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`port ${PORT} already in use (TokenHUD already running?)`); process.exit(2); }
  console.error(e); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`TokenHUD ${pkg.version} on http://127.0.0.1:${PORT}`);
  setImmediate(backfill);
  applyPoll(store, getSettings().planPoll);
});

function shutdown() { try { saveCache(store); } catch { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
