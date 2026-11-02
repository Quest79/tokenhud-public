// Data layer: one EventSource shared by all pages + typed fetchers.
export interface Series { t: number[]; req: number[]; outPerMin: number[]; out: number[]; tps: number[]; inp: number[]; cr: number[]; hit: number[]; cost: number[]; bucket: number; fmt: 'time' | 'day' | 'sec' }
export interface Dist { n: number; p50: number; p95: number; avg: number }
/** Standard LLM speed set (ms and tok/s);. */
export interface Speed { tps: number; dtps: number; tpot: number; ttft: Dist; lat: Dist }
export interface Totals { req: number; in: number; out: number; cr: number; cw: number; think: number; cost: number; hit: number; total: number; tps: number; sx?: Speed }
export interface Session { id: string; title: string; project: string; branch: string; app: string; last: number; req: number; out: number; cost: number; tps: number; sx?: Speed; model: string; state: 'live' | 'idle' | 'done' }
export interface Overview {
  codexPlan?: { ts: number; plan: string; plan5h: { pct: number; resetsAt: number } | null; plan7d: { pct: number; resetsAt: number } | null } | null;
  now: number; range: string; since: number; version: number; appVersion: string;
  totals: Totals; prev: Totals; series: Series;
  mix: { in: number; cr: number; cw: number; out: number };
  tools: { name: string; calls: number; err: number; share: number; avgMs: number }[]; toolCalls: number;
  sessions: Session[];
  ctx: { sid: string; title: string; model: string; used: number; in: number; cr: number; cw: number; window: number; pct: number; ts: number } | null;
  feed: { ts: number; src: string; level: string; text: string }[];
  models: Record<string, number>;
  local: { out5h: number; tok5h: number; out7d: number; cost7d: number; out30d: number; cost30d: number; all5h: number; all7d: number; all30d: number };
  apiMult: { usd: number; accts: { name: string; usd: number; cost: number; out: number; all: number; mult: number }[]; cost: number; days: number; mult: number };
  liveSessions: number; lastTs: number;
  ingest: { files: number; messages: number };
  hourly: { t: number; inp: number; out: number }[];
  today: { req: number; in: number; out: number; cr: number; cw: number; cost: number; total: number; tps: number; sx?: Speed };
  activity: { state: 'idle' | 'live' | 'generating' | 'tool'; tool: string; sid: string; title: string; ageMs: number };
  paused: boolean;
  statusFeed?: StatusFeed;
}
export interface PlanWin { pct: number; resetsAt: number | null }
export interface StatusFeed {
  fresh: boolean; ageMs: number | null; hooks: boolean; plan5h: PlanWin | null; plan7d: PlanWin | null;
  ctx?: { pct: number; size: number | null; over200k: boolean } | null;
  cache?: { warm: boolean | null; ttl: number | null; expiresAt: number | null; hit: number | null; misses: number | null; lastMissCause: string; recacheTokens: number | null } | null;
  costUsd?: number | null; events: { ts: number; name: string; sid: string; tool: string }[];
}

export type Status = 'connecting' | 'online' | 'offline';
let es: EventSource | null = null;
let status: Status = 'connecting';
const updateSubs = new Set<() => void>();
const statusSubs = new Set<(s: Status) => void>();
const pauseSubs = new Set<(p: boolean) => void>();
let paused = false;

function setStatus(s: Status) { if (s !== status) { status = s; statusSubs.forEach((f) => f(s)); } }

declare const __APP_VERSION__: string;
/** This page was built from one version; when the server runs another, reload once so the window matches it (no Ctrl+R). */
async function checkBuild() {
  if (document.hidden) return;
  const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const v: string | undefined = h?.version;
  if (v && v !== __APP_VERSION__ && sessionStorage.getItem('tokenhud.reloaded') !== v) { // the guard stops a reload loop
    sessionStorage.setItem('tokenhud.reloaded', v);
    location.reload();
  }
}

export function connect() {
  if (es) return;
  es = new EventSource('/api/live');
  es.addEventListener('update', () => { setStatus('online'); updateSubs.forEach((f) => f()); });
  es.addEventListener('pause', (e) => { paused = JSON.parse((e as MessageEvent).data).paused; pauseSubs.forEach((f) => f(paused)); });
  es.onopen = () => setStatus('online');
  es.onerror = () => setStatus('offline'); // EventSource retries by itself
  void checkBuild();
  setInterval(checkBuild, 30000);
}
export const onUpdate = (f: () => void) => { updateSubs.add(f); return () => updateSubs.delete(f); };
export const onStatus = (f: (s: Status) => void) => { statusSubs.add(f); f(status); return () => statusSubs.delete(f); };

export const onPause = (f: (p: boolean) => void) => { pauseSubs.add(f); f(paused); return () => pauseSubs.delete(f); };
/** False while updates are paused from the tray menu or while this window is hidden (saves work). */
export const shouldRun = () => !paused && !document.hidden;

/** Data source filter in the header: everything, Claude only or Codex only. Sent as ?src= on every data request. */
export type Src = 'all' | 'claude' | 'codex';
export const getSrc = (): Src => { const s = localStorage.getItem('tokenhud.src'); return s === 'claude' || s === 'codex' ? s : 'all'; };
export const setSrc = (s: Src) => localStorage.setItem('tokenhud.src', s);
const SRC_PATHS = /^\/api\/(overview|sessions|traces?|usage|context|models|compare|tools|alerts|summary)/;
const withSrc = (path: string) => { const s = getSrc(); return s === 'all' || !SRC_PATHS.test(path) ? path : path + (path.includes('?') ? '&' : '?') + 'src=' + s; };

export async function getOverview(range: string): Promise<Overview | { loading: true; done: number; total: number }> {
  const r = await fetch(withSrc(`/api/overview?range=${range}`), { cache: 'no-store' });
  return r.json();
}

/** Fetch one page's data. Resolves to null while the server is still reading transcripts. */
export async function getJson<T = any>(path: string): Promise<T | null> {
  const r = await fetch(withSrc(path), { cache: 'no-store' });
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** POST JSON to the local server (the custom header is its CSRF guard). */
export async function postJson<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'x-tokenhud': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export interface Pctl { n: number; p5: number; p25: number; p50: number; p75: number; p95: number }
export interface CompareRow {
  id: string; src?: string; name: string; effort: string; fast: boolean; req: number; share: number; sub: number; out: number; cost: number; tasks: number; costTask: number; costReq: number;
  est: number; peak: number; window: number; hit: number; price: { in: number; out: number; cr: number; cw: number } | null;
  speed: Pctl; e2e: Pctl; ttft: Pctl; ans: Pctl; lat: Pctl; think: Pctl;
  trend: { speed: (number | null)[]; cost: number[] };
}
export interface Compare { now: number; days: number; efforts: string[]; rows: CompareRow[] }
