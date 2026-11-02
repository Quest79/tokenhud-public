// M7: Alerts: severity KPIs, health strip, error budget, spend bars, active alerts, incident timeline.
import { Bell, ShieldCheck, Activity, CircleDollarSign, AlertTriangle, OctagonAlert } from 'lucide';
import { icon, card, pill, bar } from '../ui';
import { stackedBarsOption, C } from '../charts';
import { getJson } from '../api';
import { liveLoop } from '../live';
import { money, ago, esc } from '../format';
import { kpiRow, chartBag, clockTime, note } from './kit';

import type { Tile } from './kit';
const ACK = 'tokenhud.ack';
const loadAck = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(ACK) || '[]')); } catch { return new Set(); } };
const hue = (s: string) => (s === 'crit' ? 'red' : s === 'warn' ? 'amber' : s === 'ok' ? 'green' : 'grey') as 'red' | 'amber' | 'green' | 'grey';
const label = (s: string) => (s === 'crit' ? 'Critical' : s === 'warn' ? 'Warning' : s === 'ok' ? 'OK' : 'Off');
const hh = (t: number) => String(new Date(t).getHours()).padStart(2, '0');

export function renderAlerts(root: HTMLElement): () => void {
  let dead = false;
  const charts = chartBag();
  const ack = loadAck();
  root.innerHTML = `
  <div class="page-head"><div><h1 class="page-title">Alerts</h1><p class="page-sub" id="al-sub">Checking rules…</p></div><span class="live"><span class="dot ping"></span>Live</span></div>
  <div id="al-kpis"></div>
  <div class="row">
    <div class="c8">${card('Activity health, last 24 hours', '<div id="al-strip"></div>', { sub: 'One block per hour: green is clean, amber has failed tool calls, red is a slow request, grey is idle.' })}</div>
    <div class="c4">${card('Error budget, 7 days', '<div id="al-budget"></div>')}</div>
  </div>
  <div class="row">
    <div class="c8">${card('Spend per hour', '<div class="chart" id="al-bars" style="height:230px"></div><div class="legend"><span><i style="background:' + C.cyan + ';color:' + C.cyan + '"></i>Normal</span><span><i style="background:' + C.purple + ';color:' + C.purple + '"></i>Spike</span></div>', { sub: 'API-rate estimate. A spike is an hour at or above the threshold times the typical busy hour.' })}</div>
    <div class="c4">${card('Rules', '<div id="al-rules"></div>', { sub: 'Thresholds and budgets are set in Settings.' })}</div>
  </div>
  <div class="row"><div class="c12">${card('Active alerts', '<div id="al-active" style="overflow-x:auto"></div>', { right: '<button class="pick" id="al-ack" type="button">Acknowledge selected</button>' })}</div></div>
  <div class="row"><div class="c12">${card('Incident timeline', '<div id="al-time"></div>', { sub: 'Failed tool calls, slow requests and spend spikes in the last 24 hours.' })}</div></div>`;
  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const bars = charts.mk($('al-bars'), stackedBarsOption([''], { name: 'a', data: [0] }, { name: 'b', data: [0] }));
  let lastActive: any[] = [];

  $('al-ack').addEventListener('click', () => {
    root.querySelectorAll<HTMLInputElement>('input.ak:checked').forEach((c) => ack.add(c.dataset.id!));
    localStorage.setItem(ACK, JSON.stringify([...ack]));
    draw(lastActive);
  });

  function draw(active: any[]) {
    lastActive = active;
    const open = active.filter((a) => !ack.has(a.id));
    $('al-active').innerHTML = active.length ? `<table class="tbl"><thead><tr><th style="width:34px"></th><th>Severity</th><th>Alert</th><th>Detail</th><th>Kind</th><th></th></tr></thead><tbody>${active.map((a) =>
      `<tr class="${ack.has(a.id) ? 'acked' : ''}"><td><input type="checkbox" class="ak" data-id="${esc(a.id)}" ${ack.has(a.id) ? 'checked disabled' : ''}></td><td>${pill(ack.has(a.id) ? 'Acknowledged' : label(a.sev), ack.has(a.id) ? 'grey' : hue(a.sev))}</td><td class="strong">${esc(a.title)}</td><td class="clip">${esc(a.detail)}</td><td>${esc(a.kind)}</td><td>${a.link ? `<a class="back" href="${esc(a.link)}">Open</a>` : ''}</td></tr>`).join('')}</tbody></table>` : note('No active alerts. Everything is within its thresholds.');
    $('al-ack').style.display = open.length ? '' : 'none';
    return open;
  }

  async function refresh() {
    if (dead) return;
    const d = await getJson('/api/alerts').catch(() => null);
    if (!d || dead) { if (!d) setTimeout(() => loop.kick(), 700); return; }
    const ids = new Set(d.active.map((a: any) => a.id));
    for (const k of [...ack]) if (!ids.has(k)) ack.delete(k); // an alert that cleared can fire again later
    localStorage.setItem(ACK, JSON.stringify([...ack]));
    const open = draw(d.active);
    const crit = open.filter((a: any) => a.sev === 'crit').length, warn = open.filter((a: any) => a.sev === 'warn').length;
    const ok = d.rules.filter((r: any) => r.state === 'ok').length, on = d.rules.filter((r: any) => r.state !== 'off').length;
    const spend = d.hours.reduce((a: number, h: any) => a + h.cost, 0), b = d.budget;
    $('al-sub').textContent = `${on} rules active · updated ${clockTime(Date.now())}`;
    $('al-kpis').innerHTML = kpiRow(<Tile[]>[
      { label: 'Critical', value: String(crit), color: crit ? 'amber' : 'green', chip: { svg: icon(OctagonAlert, 20), hue: crit ? undefined : 'green' }, sub: crit ? 'needs attention now' : 'none open' },
      { label: 'Warnings', value: String(warn), color: warn ? 'amber' : 'green', chip: { svg: icon(AlertTriangle, 20) }, sub: warn ? 'worth a look' : 'none open' },
      { label: 'Rules passing', value: `${ok}/${on}`, color: 'green', chip: { svg: icon(ShieldCheck, 20), hue: 'green' }, sub: `${d.rules.length - on} switched off` },
      { label: 'Tool success', value: b.success.toFixed(1), unit: '%', color: 'purple', chip: { svg: icon(Activity, 20), hue: 'purple' }, sub: `target ${b.target}% over 7 days` },
      { label: 'Spend, 24h', value: money(spend), color: 'purple', chip: { svg: icon(CircleDollarSign, 20), hue: 'purple' }, sub: 'API-rate estimate' },
      { label: 'Acknowledged', value: String(d.active.length - open.length), chip: { svg: icon(Bell, 20) }, sub: 'hidden from the counts' },
    ]);
    $('al-strip').innerHTML = `<div class="hstrip">${d.hours.map((h: any) => {
      const slow = d.incidents.some((i: any) => i.sev === 'crit' && i.ts >= h.t && i.ts < h.t + 3600e3);
      const k = !h.req && !h.tools ? 'idle' : slow ? 'crit' : h.err ? 'warn' : 'ok';
      return `<i class="${k}" title="${hh(h.t)}:00  ${h.req} requests, ${h.tools} tool calls, ${h.err} failed"></i>`;
    }).join('')}</div><div class="hstrip-lbl"><span>${hh(d.hours[0].t)}:00</span><span>${hh(d.hours[12].t)}:00</span><span>now</span></div>`;
    const rem = Math.round(b.remainingPct);
    $('al-budget').innerHTML = `<div class="stat-list"><div class="r"><span>Success rate</span><b>${b.success.toFixed(2)}%</b></div><div class="r"><span>Failed calls</span><b>${b.errs} of ${b.calls.toLocaleString()}</b></div><div class="r"><span>Allowed at target</span><b>${Math.floor(b.allowed)}</b></div></div>
      <div class="meter-row"><div class="meter-top"><span>Budget left</span><b>${rem}%</b></div>${bar(rem, rem > 50 ? 'green' : rem > 20 ? 'amber' : 'red')}</div>`;
    bars.setOption(stackedBarsOption(d.hours.map((h: any) => hh(h.t)), { name: 'Normal', data: d.hours.map((h: any) => (h.spike ? 0 : +h.cost.toFixed(2))) }, { name: 'Spike', data: d.hours.map((h: any) => (h.spike ? +h.cost.toFixed(2) : 0)) }));
    $('al-rules').innerHTML = d.rules.map((r: any) =>
      `<div class="rulerow"><div><b>${esc(r.label)}</b><span class="muted">${esc(r.threshold)} · ${esc(r.value)}</span></div>${pill(label(r.state), hue(r.state))}</div>`).join('');
    $('al-time').innerHTML = d.incidents.length ? `<div class="timeline">${d.incidents.map((i: any) =>
      `<a class="tl-item ${i.sev}" href="${esc(i.link || '#/alerts')}"><i></i><div><b>${esc(i.title)}</b><span>${esc(i.detail)}</span></div><time>${ago(i.ts, d.now)}</time></a>`).join('')}</div>` : note('Nothing went wrong in the last 24 hours.');
  }
  const loop = liveLoop(refresh);
  return () => { dead = true; loop.stop(); charts.dispose(); };
}
