// Tool call pop-up: click any tool call (an element with data-toolcall="<id>") to read its full input and result or error
// text, which the server reads from the transcript on demand (GET /api/toolcall/<id>).
import { icon, pill } from '../ui';
import { getJson } from '../api';
import { esc, dur } from '../format';
import { clockTime } from './kit';
import { X, Copy } from 'lucide';

let open: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

function close() {
  open?.remove(); open = null;
  if (onKey) { removeEventListener('keydown', onKey); onKey = null; }
}

export async function openToolCall(id: string) {
  close();
  const ov = document.createElement('div');
  ov.className = 'tc-ov';
  ov.innerHTML = `<div class="tc-box" role="dialog" aria-modal="true" aria-label="Tool call"><div class="tc-head"><div class="tc-title">Tool call</div><button type="button" class="tc-x" title="Close (Esc)">${icon(X, 16)}</button></div><div class="tc-body"><p class="muted">Reading the transcript…</p></div></div>`;
  document.body.appendChild(ov); open = ov;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.tc-x')!.addEventListener('click', close);
  onKey = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);

  const box = ov.querySelector('.tc-box') as HTMLElement, body = ov.querySelector('.tc-body') as HTMLElement, title = ov.querySelector('.tc-title') as HTMLElement;
  const d = await getJson(`/api/toolcall/${encodeURIComponent(id)}`).catch(() => null);
  if (open !== ov) return;   // closed while loading
  if (!d || d.error) { body.innerHTML = `<p class="muted">${esc(d?.error === 'no such tool call' ? 'The server no longer has this call.' : 'Could not read this call. The server may be restarting; try again.')}</p>`; return; }

  const state = d.err ? pill('Failed', 'red') : d.running ? pill('Running', 'blue') : d.endTs ? pill('Done', 'green') : pill('No result seen', 'amber');
  title.innerHTML = `${esc(d.name.replace(/^mcp__/, '').replace(/__/g, ' · '))} ${state}`;
  const meta = [d.model ? esc(d.model) : '', `started ${clockTime(d.ts)}`, d.endTs ? `took ${dur(d.endTs - d.ts)}` : '', d.session ? esc(d.session) : ''].filter(Boolean).join(' · ');
  const fields = (d.fields as { k: string; v: string }[]).map((f) => `<div class="tc-k">${esc(f.k)}</div><pre class="tc-pre">${esc(f.v)}</pre>`).join('') || '<p class="muted">No input recorded.</p>';
  const res = d.result ? `<pre class="tc-pre${d.err ? ' err' : ''}" id="tc-res">${esc(d.result)}</pre>` : `<p class="muted">${esc(d.note || 'No result text.')}</p>`;
  body.innerHTML = `<div class="tc-meta">${meta}</div>
    ${d.note && d.result ? `<p class="muted">${esc(d.note)}</p>` : ''}
    <div class="tc-sec">Input</div>${fields}
    <div class="tc-sec">${d.err ? 'Error output' : 'Result'}${d.result ? `<button type="button" class="tc-copy" title="Copy">${icon(Copy, 13)} Copy</button>` : ''}</div>${res}
    <div class="tc-foot"><a class="back" href="#/sessions/${esc(d.sid)}" style="margin:0">Open session →</a></div>`;
  body.querySelector('.tc-copy')?.addEventListener('click', (e) => { navigator.clipboard?.writeText(d.result); (e.currentTarget as HTMLElement).lastChild!.textContent = ' Copied'; });
  body.querySelector('.tc-foot a')?.addEventListener('click', close);
  box.scrollTop = 0;
}

// One listener for the whole app: any element carrying data-toolcall opens the pop-up.
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-toolcall]');
  if (el && el.dataset.toolcall) { e.preventDefault(); openToolCall(el.dataset.toolcall); }
});
