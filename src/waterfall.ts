// Execution trace waterfall: an indented span tree on the left, time bars on the right, a moving "now" marker.
import { dur, compactStr, int, money, esc, tokps } from './format';

export interface Span {
  id: string; name: string; kind: 'turn' | 'llm' | 'tool'; depth: number; side?: boolean;
  start: number; end: number; running?: boolean; err?: boolean; detail?: string; model?: string;
  in?: number; out?: number; cr?: number; cw?: number; think?: number; cost?: number; stop?: string; tps?: number; ttft?: number; dtps?: number;
}

const nice = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);

export function waterfall(spans: Span[], now: number, live: boolean, sel = '', maxRows = 200): string {
  if (!spans.length) return '<p class="muted">No steps yet.</p>';
  const root = spans[0];
  const t0 = root.start, t1 = Math.max(root.end, ...spans.map((s) => s.end), live ? now : 0);
  const total = Math.max(1, t1 - t0);
  const pos = (t: number) => ((t - t0) / total) * 100;
  const ticks = Array.from({ length: 6 }, (_, i) => i / 5);
  const rows = spans.slice(0, maxRows);
  const nowX = live && now >= t0 && now <= t1 + 1 ? pos(now) : -1;
  return `<div class="wf">
    <div class="wf-head"><div class="wf-name">Step</div><div class="wf-lane">${ticks.map((k) => `<span style="left:${k * 100}%">${nice(total * k)}</span>`).join('')}</div></div>
    <div class="wf-body">${rows.map((s) => {
    const l = pos(s.start), w = Math.max(0.35, pos(Math.max(s.end, s.start)) - l);
    const cls = `${s.kind}${s.side ? ' side' : ''}${s.err ? ' err' : ''}${s.running ? ' run' : ''}`;
    const d = s.end - s.start;
    return `<div class="wf-row${s.id === sel ? ' sel' : ''}" data-id="${esc(s.id)}">
        <div class="wf-name" style="padding-left:${s.depth * 16 + 4}px"><i class="wf-dot ${cls}"></i><span class="wf-t">${esc(s.name)}</span>${s.detail && s.kind === 'tool' ? `<em>${esc(s.detail.slice(0, 70))}</em>` : ''}</div>
        <div class="wf-lane">${ticks.map((k) => `<u style="left:${k * 100}%"></u>`).join('')}<span class="wf-bar ${cls}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></span><b class="wf-dur" style="left:${Math.min(l + w, 90).toFixed(2)}%">${nice(d)}</b></div>
      </div>`;
  }).join('')}${nowX >= 0 ? `<div class="wf-now" style="left:calc(var(--wf-name) + (100% - var(--wf-name)) * ${(nowX / 100).toFixed(4)})"><span>now</span></div>` : ''}</div>
    ${spans.length > maxRows ? `<p class="muted" style="font-size: calc(12px * var(--fs, 1));padding:6px 4px">Showing the first ${maxRows} of ${spans.length} steps.</p>` : ''}
  </div>`;
}

/** Detail panel for one selected span. */
export function spanDetail(s: Span | undefined, base: number): string {
  if (!s) return '<p class="muted">Click a step in the trace to see its details.</p>';
  const r = (k: string, v: string) => `<div class="r">${k}<b>${v}</b></div>`;
  const tok = s.kind === 'llm' ? r('Input', int(s.in ?? 0)) + r('Cache read', `<span class="g">${int(s.cr ?? 0)}</span>`) + r('Cache write', int(s.cw ?? 0)) + r('Output', int(s.out ?? 0)) + (s.ttft ? r('Time to first token', dur(s.ttft)) : '') + (s.dtps ? r('Output speed', tokps(s.dtps) + ' tok/s') : '') + (s.tps ? r('End-to-end speed', tokps(s.tps) + ' tok/s') : '') + (s.think ? r('Thinking', int(s.think)) : '') + r('Est. cost', money(s.cost ?? 0)) + (s.stop ? r('Stop reason', esc(s.stop)) : '') : '';
  return `<div class="sd"><div class="sd-title">${esc(s.name)}${s.err ? ' <span style="color:var(--red)">· failed</span>' : s.running ? ' <span style="color:var(--cyan)">· running</span>' : ''}</div>
    <div class="stat-list">${r('Kind', s.kind === 'llm' ? (s.side ? 'Subagent request' : 'Model request') : s.kind === 'tool' ? 'Tool call' : 'Turn')}${r('Started', `+${nice(s.start - base)}`)}${r('Duration', dur(s.end - s.start))}${tok}</div>
    ${s.detail ? `<div class="sd-text">${esc(s.detail)}</div>` : ''}${s.kind === 'tool' ? `<button type="button" class="btn ghost" data-toolcall="${esc(s.id)}" style="margin-top:8px">View full input & result</button>` : ''}${s.kind === 'llm' && s.out ? `<p class="muted" style="font-size: calc(12px * var(--fs, 1))">${compactStr(s.out)} output tokens</p>` : ''}</div>`;
}
