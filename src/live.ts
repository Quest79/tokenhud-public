// Shared refresh loop for live pages: server pushes (throttled to 1/s), a slow timer for relative times,
// and nothing at all while updates are paused or the window is hidden.
import { onUpdate, onPause, shouldRun } from './api';

export function liveLoop(refresh: () => Promise<void> | void, interval: number | (() => number) = 30000) {
  let dead = false, busy = false, again = false, last = 0;
  let pend: ReturnType<typeof setTimeout> | null = null;
  const exec = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { await refresh(); } finally { busy = false; if (again && !dead) { again = false; setTimeout(kick, 400); } }
  };
  const kick = () => { if (!dead) void exec(); };
  const run = () => { if (shouldRun()) kick(); };
  const offUpdate = onUpdate(() => { // at most one refresh per second
    if (pend || !shouldRun()) return;
    pend = setTimeout(() => { pend = null; last = Date.now(); run(); }, Math.max(0, 1000 - (Date.now() - last)));
  });
  let tick: ReturnType<typeof setTimeout>;
  const arm = () => { tick = setTimeout(() => { run(); if (!dead) arm(); }, typeof interval === 'function' ? interval() : interval); };
  arm();
  const vis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', vis);
  let first = true;
  const offPause = onPause((p) => { if (first) { first = false; return; } if (!p) kick(); });
  kick();
  return {
    kick,
    stop() { dead = true; offUpdate(); offPause(); clearTimeout(tick); document.removeEventListener('visibilitychange', vis); if (pend) clearTimeout(pend); },
  };
}
