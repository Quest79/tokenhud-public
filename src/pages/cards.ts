// Model cards: one 16:9 card per model and reasoning level, grouped by model. Numbers come from your own usage.
import { card, pill } from '../ui';
import { zc } from '../theme';
import { getJson, getSrc } from '../api';
import { liveLoop } from '../live';
import { tokps, compactStr, int, ago, esc } from '../format';
import { note } from './kit';

const COL = { claude: zc('#4aa3ff'), codex: zc('#ee9aa3') };
const SRC = { claude: 'Claude', codex: 'Codex' };
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
// Artificial Analysis scores, read 29 Oct 2026. fc2: FrontierCode 2.0 score per effort, from each model's AA page (artificialanalysis.ai/models/<slug>-<effort>). Only efforts AA publishes are listed. gpt-6-sol, gpt-5.6-sol and gpt-5.6-luna have no FrontierCode 2.0 score on AA, and gpt-6.1-sol has no Ultra score, so they get no badge.
// agent: Coding Agent Index v1.5 (artificialanalysis.ai/agents/coding-agents), which scores the coding agent (Claude Code or Codex) with the model, at the one effort listed.
const AA: Record<string, { fc2?: Record<string, number>; agent?: { score: number; effort: string; tool: string } }> = {
  'Opus 5.5': { fc2: { max: 46.4, xhigh: 43.8, high: 35.9, medium: 33.1, low: 15.8 }, agent: { score: 66, effort: 'max', tool: 'Claude Code' } },
  'Sonnet 5.5': { fc2: { max: 41.7, xhigh: 35.6, high: 25.7, medium: 11.0, low: 7.1 }, agent: { score: 68, effort: 'max', tool: 'Claude Code' } },
  'Haiku 5.5': { fc2: { max: 34.9, xhigh: 29.9, high: 23.2, medium: 16.1, low: 8.0 }, agent: { score: 41, effort: 'xhigh', tool: 'Claude Code' } },
  'gpt-6-astra': { fc2: { max: 42.4, xhigh: 41.4, high: 40.1, medium: 36.6, low: 26.2 }, agent: { score: 62, effort: 'max', tool: 'Codex' } },
  'gpt-6.1-sol': { fc2: { max: 40.6, xhigh: 38.5, high: 36.7, medium: 33.4, low: 20.2 }, agent: { score: 63, effort: 'xhigh', tool: 'Codex' } },
  'gpt-6-luna': { fc2: { max: 25.2, xhigh: 18.4, high: 18.6, medium: 12.8, low: 2.2 } },
};
const aaAgentTitle = (a: { score: number; effort: string; tool: string }) => `Artificial Analysis Coding Agent Index v1.5: ${a.score}, measured through ${a.tool} at ${a.effort} effort (13 Oct 2026)`;
const usd = (v: number | null) => (v == null ? '·' : v >= 10 ? '$' + v.toFixed(1) : v >= 0.1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3));
const hrs = (v: number | null) => (v == null ? '·' : v >= 100 ? Math.round(v) + ' h' : v >= 10 ? v.toFixed(0) + ' h' : v.toFixed(1) + ' h');
const pc = (v: number) => `${Math.round(v * 100)}%`;

interface Card { src: 'claude' | 'codex'; model: string; effort: string; fast: boolean; req: number; total: number; in: number; out: number; cr: number; cw: number; cacheHit: number; avgOut: number; dtps: number; dtpsE2e: boolean; tps: number; costPerM: number | null; costList: boolean; h5: number | null; h5Est: boolean; w7: number | null; w7Est: boolean; share: number; meter: 'good' | 'low' | 'none'; rel: number | null; thin: boolean; last: number }

const rank = (c: Card) => { const i = EFFORT.indexOf(c.effort); return (i < 0 ? 9 : i) * 2 + (c.fast ? 1 : 0); };
const sumTokens = (cs: Card[]) => cs.reduce((a, c) => a + c.total, 0);

function cardHtml(c: Card): string {
  const aa = AA[c.model];
  const flag = c.meter !== 'good' || c.thin ? pill(c.thin ? 'Few replies' : 'Low data', 'amber') : '';
  const why = c.thin ? `Under 20 replies, so the speed numbers are a small sample` : c.meter === 'none' ? 'The plan meter has never moved in a way that isolates this model, so its own rate cannot be measured' : c.rel != null ? `The rate is uncertain by about ±${Math.round(c.rel * 196)}% (95% range). It is trusted at ±50% or better` : 'The rate cannot be separated from the other models used at the same time';
  return `<section class="card mcard">
    <div class="mcard-head"><span class="mcard-name">${c.effort ? esc(c.effort) : 'default effort'}</span>${c.fast ? '<span class="mcard-tag fast">fast</span>' : ''}${aa && aa.fc2 && aa.fc2[c.effort] != null ? `<span class="mcard-tag" title="FrontierCode 2.0 score for this model at this effort (Artificial Analysis, 29 Oct 2026)">FC 2.0 ${aa.fc2[c.effort]}%</span>` : ''}${flag ? `<span class="mcard-flag" title="${why}">${flag}</span>` : ''}</div>
    <div class="mcard-hero">
      <div title="${c.dtpsE2e ? 'End-to-end speed: output tokens over the whole reply time. No reply had a thinking block, so the first token cannot be timed and decode speed is not available' : 'Decode speed: output tokens over the time from first token to last event, pooled over all replies'}"><div class="mcard-big">${tokps(c.dtps)}<small>tok/s</small></div><div class="mcard-lbl">${c.dtpsE2e ? 'Output speed (end to end)' : 'Output speed'}</div></div>
      <div title="${c.costList ? 'List-price cost per 1M tokens. Too few plan-meter readings for this model to scale it by what your plan charges' : 'List-price cost per 1M tokens, scaled by how much your plan meter charges this model compared with the average'}"><div class="mcard-big">${usd(c.costPerM)}<small>/ 1M</small></div><div class="mcard-lbl">${c.costList ? 'Cost per 1M (list price)' : 'Cost per 1M tokens'}</div></div>
    </div>
    <div class="mcard-stats">
      <div title="Input, cache reads and writes, and output"><b>${compactStr(c.total)}</b><span>tokens used</span></div>
      <div title="Hours of this model's use, at your pace, that fill the 5-hour window${c.h5Est ? '. Estimate: too few readings for this model, so it uses the all-models rate' : ''}"><b>${c.h5Est ? '~' : ''}${hrs(c.h5)}</b><span>to fill 5 h</span></div>
      <div title="Hours of this model's use, at your pace, that fill the weekly window${c.w7Est ? '. Estimate: too few readings for this model, so it uses the all-models rate' : ''}"><b>${c.w7Est ? '~' : ''}${hrs(c.w7)}</b><span>to fill week</span></div>
    </div>
    <div class="mcard-foot"><span>${int(c.req)} replies · ${pc(c.cacheHit)} cache · ${int(c.avgOut)} out/reply · ${ago(c.last)}</span></div>
  </section>`;
}

// Each model group collapses to its header; the collapsed set persists in localStorage.
const CK = 'tokenhud.cards.collapsed';
const collapsed = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(CK) || '[]'); } catch { return []; } })());
const saveCollapsed = () => { try { localStorage.setItem(CK, JSON.stringify([...collapsed])); } catch { /* storage unavailable */ } };

function groups(cards: Card[]): Card[][] {
  const g = new Map<string, Card[]>();
  for (const c of cards) { const k = `${c.src}|${c.model}`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(c); }
  return [...g.values()].sort((a, b) => sumTokens(b) - sumTokens(a));
}
const gid = (cs: Card[]) => `${cs[0].src}|${cs[0].model}`;

function sections(gs: Card[][]): string {
  return gs.map((cs) => {
    cs.sort((a, b) => rank(a) - rank(b));
    const s = cs[0].src, id = gid(cs), shut = collapsed.has(id), aa = AA[cs[0].model];
    return `<div class="mcard-sec" data-g="${esc(id)}">
      <button type="button" class="mcard-sec-head" aria-expanded="${!shut}"><span class="lv-chev">▾</span><span class="mcard-dot" style="background:${COL[s]};color:${COL[s]}"></span><b>${esc(cs[0].model)}</b><span class="muted">${SRC[s]} · ${cs.length} ${cs.length === 1 ? 'card' : 'cards'} · ${compactStr(sumTokens(cs))} tokens</span>${aa && aa.agent ? `<span class="mcard-tag" title="${esc(aaAgentTitle(aa.agent))}">AA coding ${aa.agent.score} (${esc(aa.agent.tool)}, ${esc(aa.agent.effort)})</span>` : ''}</button>
      <div class="cards-grid"${shut ? ' hidden' : ''}>${cs.map(cardHtml).join('')}</div>
    </div>`;
  }).join('');
}

export function renderCards(root: HTMLElement): () => void {
  let dead = false;
  const src = getSrc();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Model cards</h1><p class="page-sub" id="cd-sub">Reading usage…</p></div><span class="mcard-ctl"><button type="button" class="mcard-all" id="cd-all">Collapse all</button><span class="live"><span class="dot ping"></span>Live</span></span></div>
  <div id="cd-body"></div>
  <div class="row"><div class="c12">${card('How to read the cards', `<ul class="muted" style="font-size: calc(12.5px * var(--fs, 1));line-height:1.7;margin:0;padding-left:18px">
    <li><b style="color:var(--text-2)">Output speed</b> is decode tok/s, pooled over every reply of that model and effort.</li>
    <li><b style="color:var(--text-2)">Cost per 1M tokens</b> is list-price cost per 1M tokens, scaled by what your plan meter charges this model compared with the average. It equals list price when the meter charges in proportion; a higher number means this model uses up your plan faster per token.</li>
    <li><b style="color:var(--text-2)">To fill 5 h / week</b> is how many hours of this model's use, at your pace, would use up that whole window. Fewer hours means it burns the window faster.</li>
    <li><b style="color:var(--text-2)">Low data</b> means the plan meter has not pinned this model's rate down well enough: the fit's own 95% range is wider than ±50% of the value (or the model could not be separated from others). Hover the flag for the exact range. <b style="color:var(--text-2)">Few replies</b> means under 20 replies, so the speed is a small sample.</li></ul>`)}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  let ids: string[] = [];
  const syncAll = () => { $('cd-all').textContent = ids.length && ids.every((i) => collapsed.has(i)) ? 'Expand all' : 'Collapse all'; };
  const paint = (sec: HTMLElement) => {
    const shut = collapsed.has(sec.dataset.g!);
    (sec.querySelector('.mcard-sec-head') as HTMLElement).setAttribute('aria-expanded', String(!shut));
    (sec.querySelector('.cards-grid') as HTMLElement).hidden = shut;
  };
  $('cd-body').addEventListener('click', (e) => {
    const sec = (e.target as HTMLElement).closest('.mcard-sec-head')?.parentElement as HTMLElement | null;
    if (!sec) return;
    const id = sec.dataset.g!;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    saveCollapsed(); paint(sec); syncAll();
  });
  $('cd-all').addEventListener('click', () => {
    if (ids.every((i) => collapsed.has(i))) ids.forEach((i) => collapsed.delete(i)); else ids.forEach((i) => collapsed.add(i));
    saveCollapsed(); root.querySelectorAll<HTMLElement>('.mcard-sec').forEach(paint); syncAll();
  });
  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/cards').catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const cards: Card[] = d.cards.filter((c: Card) => src === 'all' || c.src === src);
    $('cd-sub').textContent = `${int(cards.length)} cards · cost and hours from ${int(d.readings.claude)} Claude and ${int(d.readings.codex)} Codex plan readings`;
    const gs = groups(cards);
    ids = gs.map(gid);
    $('cd-body').innerHTML = cards.length ? sections(gs) : note('No replies yet. Cards appear after the first Claude Code or Codex reply.');
    syncAll();
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); };
}
