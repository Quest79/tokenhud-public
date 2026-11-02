// Head-to-head plan-usage report: two model cards (model + reasoning level) from this machine's own usage, as the two-slide HTML
// the Compare models tab shows in a frame. Hours to fill are the card figures: 100 x hours used x plan $ per 1% / list cost of that use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planValue } from './planvalue.mjs';
import { modelCards } from './cards.mjs';

const FONT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2');
let fontB64 = null;
const font = () => { if (fontB64 == null) { try { fontB64 = fs.readFileSync(FONT_FILE).toString('base64'); } catch { fontB64 = ''; } } return fontB64; };

export const cardId = (c) => `${c.src}|${c.model}|${c.effort}|${c.fast ? 1 : 0}`;
// "gpt-6.1-sol" -> "GPT-6.1 Sol"; Claude names ("Opus 5.5") are already tidy
const pretty = (m) => { const g = /^gpt-([\d.]+)-?(.*)$/i.exec(m); return g ? `GPT-${g[1]}${g[2] ? ' ' + g[2][0].toUpperCase() + g[2].slice(1) : ''}` : m; };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const usd = (v) => (v == null ? '·' : v >= 10 ? '$' + v.toFixed(1) : v >= 0.1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3));
const usdB = (v) => (v >= 100 ? '$' + Math.round(v) : usd(v));
const hrs = (v) => (v >= 100 ? Math.round(v) + ' h' : v >= 10 ? v.toFixed(0) + ' h' : v.toFixed(1) + ' h');
const hq = (v) => (v >= 100 ? Math.round(v) + ' h' : v >= 10 ? v.toFixed(1) + ' h' : v.toFixed(2) + ' h');
const compact = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e7 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v)));
const int = (v) => Math.round(v).toLocaleString('en-US');
const pc = (v) => `${Math.round(v * 100)}%`;
const x1 = (v) => v.toFixed(1) + '×';
const days = (ts) => { const d = Math.round((Date.now() - ts) / 864e5); return d <= 0 ? 'today' : d + 'd ago'; };
const kt = (v) => Math.round(v / 1000) + 'K';
const vs = (wv, lv, up, down) => (wv >= lv ? `${x1(wv / lv)} ${up}` : `${x1(lv / wv)} ${down}`);

export const errorPage = (msg) => `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:40px;background:#101114;color:#b4b7be;font:15px/1.5 'Segoe UI',system-ui,sans-serif">${esc(msg)}</body>`;

/** Report HTML for cards `aId` (left) and `bId` (right). Throws an Error with a plain message when a side can't be built. */
export function reportHtml(store, costOf, aId, bId) {
  if (aId === bId) throw new Error('Pick two different cards to compare.');
  const pv = planValue(store, costOf), cd = modelCards(store, costOf, Date.now(), pv);
  const planOf = (src) => (src === 'claude' ? pv : pv.cx);
  const side = (id, cls) => {
    const card = cd.cards.find((c) => cardId(c) === id);
    if (!card) throw new Error('That model card has no usage logged any more.');
    const S = planOf(card.src), name = pretty(card.model);
    const eff = (card.effort || 'default') + (card.fast ? ' fast' : '');
    const row = (win) => { const r = S && S[win] ? S[win].rows.find((x) => x.key === card.bucket) : null; return r && r.perPct ? r : null; };
    const w = row('w7') || (S && S.w7 && S.w7.perPct ? { perPct: S.w7.perPct, rel: null } : null);
    const h = row('h5') || (S && S.h5 && S.h5.perPct ? { perPct: S.h5.perPct, rel: null } : null);
    if (!w || !h || card.h5 == null || card.w7 == null) throw new Error(`No plan-meter data yet for ${name} ${eff}, so its hours to fill can't be worked out.`);
    // an own-bucket fit missing means TokenHUD fell back to the all-models rate: the figure is an estimate with no error range
    const est5 = card.h5Est || h.rel == null, estW = card.w7Est || w.rel == null;
    const word = card.src === 'claude' ? name.split(' ')[0] : name.split(' ')[1] || name;   // "Opus", "Astra"
    return { id, cls, card, w, h, est5, estW, name, eff, short: word, tag: `${word} ${eff}`, vendor: card.src === 'claude' ? 'Claude' : 'Codex', tokPerReply: card.total / card.req, hrs5: card.h5, hrsW: card.w7, burn: (100 * h.perPct) / card.h5, win5: 100 * h.perPct, winW: 100 * w.perPct };
  };
  const X = side(aId, 'o'), Y = side(bId, 'a');
  if (X.short === Y.short) { X.short = X.tag; Y.short = Y.tag; }  // same model, two efforts: "Opus" alone would be ambiguous
  const full = (s) => `${s.name} ${s.eff}`;
  const Wn = X.hrs5 >= Y.hrs5 ? X : Y, Ls = Wn === X ? Y : X;      // winner / loser by hours to fill the 5 h window
  const mult5 = Wn.hrs5 / Ls.hrs5, multW = Wn.hrsW / Ls.hrsW;
  const rng = (r) => (r.rel == null ? null : r.rel * 196);          // 95% range, percent
  const known = (a, b) => (a == null || b == null ? null : Math.hypot(a, b));
  const err5 = known(rng(X.h), rng(Y.h)), errW = known(rng(X.w), rng(Y.w));
  const est = X.est5 || Y.est5 || X.estW || Y.estW;
  const weak = X.est5 || X.estW ? X : Y.est5 || Y.estW ? Y : (rng(X.w) ?? 0) >= (rng(Y.w) ?? 0) ? X : Y;
  const e5 = (s, v) => (s.est5 ? '~' : '') + hq(v), eW = (s, v) => (s.estW ? '~' : '') + hq(v);

  const modelCard = (s) => { const c = s.card; return `
    <section class="mcard ${s.cls}">
      <header><span class="sw"></span><h3>${esc(s.name)}</h3><span class="eff">${esc(s.eff)}</span><span class="vendor">${s.vendor}</span></header>
      <div class="hero">
        <div><div class="num">${Math.round(c.dtps)}<small>tok/s</small></div><div class="cap">Output speed</div></div>
        <div><div class="num">${usd(c.costPerM)}<small>/ 1M</small></div><div class="cap">Cost per 1M tokens</div></div>
      </div>
      <dl class="stats">
        <div><dt>Tokens used</dt><dd>${compact(c.total)}</dd></div>
        <div><dt>To fill 5 h</dt><dd>${s.est5 ? '~' : ''}${hrs(c.h5)}</dd></div>
        <div><dt>To fill week</dt><dd>${s.estW ? '~' : ''}${hrs(c.w7)}</dd></div>
      </dl>
      <footer>${int(c.req)} replies · ${pc(c.cacheHit)} cache · ${int(c.avgOut)} out/reply · ${days(c.last)}</footer>
    </section>`; };

  const tie = err5 != null && mult5 - 1 < err5 / 100;                // edge smaller than the measurement error
  const weekClause = multW >= 1 ? ` and ${x1(multW)} longer per week.` : `, while ${Ls.short} lasts ${x1(1 / multW)} longer per week.`;
  const summary = `Each card's hours to fill come from your own logs, so speed, reply size and context are already in them. TokenHUD prices every reply at list rates and divides by hours used: ${X.tag} burns ${usd(X.burn)} an hour, ${Y.tag} ${usd(Y.burn)}. The plan meter puts 1% of the 5-hour window at ${usd(X.h.perPct)} on ${X.short} and ${usd(Y.h.perPct)} on ${Y.short}, so a full window holds ${usdB(X.win5)} and ${usdB(Y.win5)}. Window divided by hourly burn gives ${e5(X, X.hrs5)} against ${e5(Y, Y.hrs5)}: ${Wn.short} lasts ${x1(mult5)} longer per window${weekClause}${tie ? ' The 5-hour gap sits inside the measurement error.' : ''}`;
  const wk = multW >= 1 ? `${x1(multW)} longer per week` : `${Ls.short} lasts ${x1(1 / multW)} longer per week`;
  const summaryHtml = esc(summary).replace(`${x1(mult5)} longer per window`, `<b>${x1(mult5)} longer per window</b>`).replace(esc(wk), `<b>${esc(wk)}</b>`);

  const bars = (title, xv, yv, fx, fy) => {
    const m = Math.max(xv, yv);
    const b = (s, v, f) => `<div class="b ${s.cls}"><span>${esc(s.tag)}</span><i><u style="width:${Math.max(1.5, (v / m) * 100).toFixed(1)}%"></u></i><b>${f}</b></div>`;
    return `<div class="bars"><h4>${title}</h4>
        ${b(X, xv, fx)}
        ${b(Y, yv, fy)}</div>`;
  };
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const weekKv = multW >= 1 ? 'longer per week' : `longer per week with ${esc(Ls.short)}`;
  const weekBig = multW >= 1 ? x1(multW) : x1(1 / multW);
  const verdict = est ? `One or both sides is an estimate (too few meter readings for its own fit), so treat this as rough.` : tie ? `Inside the ±${Math.round(err5)}% margin of error, so effectively a tie.` : `Margin of error ±${Math.round(err5)}% per window.`;
  const precision = est
    ? `Built from <b>${int(X.card.req)}</b> and <b>${int(Y.card.req)}</b> logged replies. ${esc(weak.tag)} has too few plan-meter readings for its own fit, so its hours (marked ~) use the all-models rate and carry no error range.`
    : `Built from <b>${int(X.card.req)}</b> and <b>${int(Y.card.req)}</b> logged replies. ${esc(weak.tag)} has the looser meter fit (±${Math.round(rng(weak.h))}% on the 5-hour rate, ±${Math.round(rng(weak.w))}% weekly), so the ratio carries about <b>±${Math.round(err5)}%</b> per window and <b>±${Math.round(errW)}%</b> per week.`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(full(X))} vs ${esc(full(Y))}: plan usage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@font-face{font-family:'Inter';font-weight:100 900;font-style:normal;src:url(data:font/woff2;base64,${font()}) format('woff2')}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
:root{--ink:#ededf0;--soft:#b4b7be;--mute:#8b8e97;--faint:#62656d;--rule:#272930;--paper:#101114;--card:#17181c;--body:#08080a;--track:#202228;--o:#ff7b47;--a:#7ea6dd}
[data-theme=light]{--ink:#17181c;--soft:#4a4c53;--mute:#6c6f76;--faint:#9a9ca2;--rule:#e2dfd7;--paper:#fbfaf7;--card:#fff;--body:#e4e2db;--track:#ecebe5;--o:#d2542a;--a:#2f5d9e}
body{background:var(--body);color:var(--ink);font-family:'Inter','Segoe UI Variable','Segoe UI',system-ui,sans-serif;font-feature-settings:'cv11','ss03';line-height:1.4;padding:24px 0}
.slide{width:1280px;height:720px;margin:0 auto 24px;padding:44px 56px 0;position:relative;overflow:hidden;background:var(--paper)}
.run{display:flex;justify-content:space-between;font-size:13px;color:var(--mute);font-weight:500}
.run b{color:var(--ink);font-weight:600}
.run button{font:inherit;font-size:12px;color:var(--mute);background:none;border:1px solid var(--rule);border-radius:999px;padding:2px 11px;margin-right:8px;cursor:pointer}.run button:hover{color:var(--ink)}
.run .date{margin-left:6px}
@media print{.run button{display:none}}
.num,td,dd,.b b,.kv b{font-variant-numeric:tabular-nums}
/* slide 1 */
.s1{display:grid;grid-template-columns:600px 1fr;gap:64px;margin-top:30px;height:564px}
h1{font-size:23px;line-height:1.25;font-weight:600;letter-spacing:-.015em;max-width:540px}
.big{font-size:136px;line-height:.9;font-weight:700;letter-spacing:-.055em;color:var(--c);margin:16px 0 0 -5px}
.big.tie{color:var(--ink)}
.big+p{font-size:20px;font-weight:500;letter-spacing:-.01em;margin-top:8px}
.verdict{font-size:14px;color:var(--mute);margin-top:4px}
.kv{display:flex;gap:44px;margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)}
.kv div{font-size:13px;color:var(--mute)}
.kv b{display:block;font-size:24px;font-weight:600;color:var(--ink);letter-spacing:-.02em;margin-bottom:1px}
.how{margin-top:18px;max-width:560px}
.how h2{font-size:13px;font-weight:600;color:var(--mute);margin-bottom:6px}
.how p{font-size:14px;line-height:1.55;color:var(--soft)}
.how b{font-weight:600;color:var(--ink)}
.cards{display:grid;grid-template-rows:1fr 1fr;gap:20px}
.mcard{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:22px 26px 16px;display:flex;flex-direction:column}
.mcard header{display:flex;align-items:center;gap:10px}
.sw{width:11px;height:11px;border-radius:3px;background:var(--c)}
.o{--c:var(--o)}.a{--c:var(--a)}
.mcard h3{font-size:18px;font-weight:600;letter-spacing:-.01em}
.eff{font-size:12px;font-weight:600;border:1px solid var(--rule);border-radius:999px;padding:2px 9px;color:var(--ink)}
.vendor{margin-left:auto;font-size:12.5px;color:var(--faint);font-weight:500}
.hero{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px}
.num{font-size:46px;line-height:1;font-weight:650;letter-spacing:-.035em;white-space:nowrap}
.num small{font-size:14px;font-weight:500;letter-spacing:0;color:var(--mute);margin-left:5px}
.cap{font-size:13px;color:var(--mute);margin-top:6px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:auto;padding-top:14px;border-top:1px solid var(--rule)}
.stats dt{font-size:12.5px;color:var(--mute)}
.stats dd{font-size:20px;font-weight:600;letter-spacing:-.015em;margin-top:2px}
.mcard footer{font-size:12px;color:var(--faint);margin-top:12px}
.foot{position:absolute;left:56px;right:56px;bottom:22px;display:flex;justify-content:space-between;font-size:12px;color:var(--faint)}
/* slide 2 */
.s2{display:grid;grid-template-columns:1fr 410px;gap:56px;margin-top:26px}
h2.t{font-size:34px;line-height:1.1;font-weight:700;letter-spacing:-.03em}
.lede{font-size:15px;color:var(--mute);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-size:12.5px;font-weight:600;color:var(--mute);text-align:right;padding:0 0 9px 14px;border-bottom:1px solid var(--ink)}
th:first-child{text-align:left;padding-left:0}
th i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:var(--c)}
td{padding:6.5px 0 6.5px 14px;border-bottom:1px solid var(--rule);text-align:right;color:var(--ink)}
td:first-child{text-align:left;padding-left:0;color:var(--soft)}
td.d{color:var(--mute);font-size:13px}
tr.k td{font-weight:700;font-size:15px;border-bottom:1px solid var(--ink)}
tr.k td:first-child{color:var(--ink)}
tr.k td.d{color:var(--w);font-size:16px}
.side h4,.notes h4{font-size:13px;font-weight:600;color:var(--mute);margin-bottom:8px}
.side table{font-size:13.5px}.side td{padding:5px 0 5px 12px}.side th{padding-left:12px}
.src{font-size:11.5px;color:var(--faint);line-height:1.5;margin-top:9px}
.bars{margin-top:14px}.bars h4{margin-bottom:4px}
.b{display:grid;grid-template-columns:110px 1fr 54px;align-items:center;gap:10px;font-size:13px;margin-top:4px}
.b span{color:var(--soft)}.b b{font-weight:600;text-align:right}
.b i{display:block;height:12px;background:var(--track);border-radius:2px}
.b u{display:block;height:100%;border-radius:2px;background:var(--c)}
.notes{position:absolute;left:56px;right:56px;bottom:56px;display:grid;grid-template-columns:repeat(3,1fr);gap:36px;border-top:1px solid var(--rule);padding-top:14px}
.notes p{font-size:13px;line-height:1.55;color:var(--soft)}
.notes b{color:var(--ink);font-weight:600}
@media print{@page{size:1280px 720px;margin:0}body{padding:0;background:var(--paper)}.slide{margin:0;break-after:page;page-break-after:always;zoom:1!important}}
</style></head><body>

<div class="slide">
  <div class="run"><span><b>TokenHUD</b> · Plan usage report</span><span><button id="pr" type="button">Save PDF</button><button id="th" type="button">Light mode</button><span class="date">${date}</span></span></div>
  <div class="s1">
    <div>
      <h1>${esc(full(X))} against ${esc(full(Y))}: how long one plan allowance lasts</h1>
      <div class="big ${tie || est ? 'tie' : Wn.cls}">${x1(mult5)}</div>
      <p>more hours per 5-hour window with ${esc(Wn.short)}</p>
      <p class="verdict">${verdict}</p>
      <div class="kv">
        <div><b>${weekBig}</b>${weekKv}</div>
        <div><b>${e5(Wn, Wn.hrs5)} vs ${e5(Ls, Ls.hrs5)}</b>to fill 5 h, ${esc(Wn.short)} vs ${esc(Ls.short)}</div>
        <div><b>${eW(Wn, Wn.hrsW)} vs ${eW(Ls, Ls.hrsW)}</b>to fill a week, ${esc(Wn.short)} vs ${esc(Ls.short)}</div>
      </div>
      <div class="how"><h2>How we got there</h2><p>${summaryHtml}</p></div>
    </div>
    <div class="cards">${modelCard(X)}${modelCard(Y)}
    </div>
  </div>
  <div class="foot"><span>Model cards: TokenHUD, all-time usage on this machine. ${int(pv.readings)} Claude and ${int(pv.cx ? pv.cx.readings : 0)} Codex plan-meter readings.</span><span>1 / 2</span></div>
</div>

<div class="slide ${Wn.cls}" style="--w:var(--c)">
  <div class="run"><span><b>TokenHUD</b> · Plan usage report</span><span>The working</span></div>
  <div class="s2">
    <div>
      <h2 class="t">From your logs to hours per window</h2>
      <p class="lede">Everything here is measured from your own sessions and the plan meters. No benchmark data is used.</p>
      <table style="margin-top:22px">
        <tr><th></th><th class="${X.cls}"><i></i>${esc(X.tag)}</th><th class="${Y.cls}"><i></i>${esc(Y.tag)}</th><th>${esc(Wn.short)} vs ${esc(Ls.short)}</th></tr>
        <tr><td>Replies logged</td><td>${int(X.card.req)}</td><td>${int(Y.card.req)}</td><td class="d">·</td></tr>
        <tr><td>List-price spend per hour of use</td><td>${usd(X.burn)}</td><td>${usd(Y.burn)}</td><td class="d">${vs(Wn.burn, Ls.burn, 'more', 'less')}</td></tr>
        <tr><td>Plan dollars behind 1% of the 5 h meter</td><td>${usd(X.h.perPct)}</td><td>${usd(Y.h.perPct)}</td><td class="d">${vs(Wn.h.perPct, Ls.h.perPct, 'larger', 'smaller')}</td></tr>
        <tr><td>Plan dollars in a full 5 h window</td><td>${usdB(X.win5)}</td><td>${usdB(Y.win5)}</td><td class="d">${vs(Wn.win5, Ls.win5, 'more', 'less')}</td></tr>
        <tr class="k"><td>Hours of use to fill 5 h</td><td>${e5(X, X.hrs5)}</td><td>${e5(Y, Y.hrs5)}</td><td class="d">${vs(Wn.hrs5, Ls.hrs5, 'longer', 'shorter')}</td></tr>
        <tr><td>Plan dollars behind 1% of the weekly meter</td><td>${usd(X.w.perPct)}</td><td>${usd(Y.w.perPct)}</td><td class="d">${vs(Wn.w.perPct, Ls.w.perPct, 'larger', 'smaller')}</td></tr>
        <tr><td>Plan dollars in a full week</td><td>${usdB(X.winW)}</td><td>${usdB(Y.winW)}</td><td class="d">${vs(Wn.winW, Ls.winW, 'more', 'less')}</td></tr>
        <tr class="k"><td>Hours of use to fill a week</td><td>${eW(X, X.hrsW)}</td><td>${eW(Y, Y.hrsW)}</td><td class="d">${vs(Wn.hrsW, Ls.hrsW, 'longer', 'shorter')}</td></tr>
      </table>
    </div>
    <div class="side">
      <h4 style="margin-top:4px">Your usage</h4>
      <table>
        <tr><th></th><th>${esc(X.tag)}</th><th>${esc(Y.tag)}</th></tr>
        <tr><td>Output speed</td><td>${Math.round(X.card.dtps)} tok/s</td><td>${Math.round(Y.card.dtps)} tok/s</td></tr>
        <tr><td>Output per reply</td><td>${int(X.card.avgOut)}</td><td>${int(Y.card.avgOut)}</td></tr>
        <tr><td>Tokens per reply</td><td>${kt(X.tokPerReply)}</td><td>${kt(Y.tokPerReply)}</td></tr>
        <tr><td>Cache hit</td><td>${pc(X.card.cacheHit)}</td><td>${pc(Y.card.cacheHit)}</td></tr>
        <tr><td>Cost per 1M tokens</td><td>${usd(X.card.costPerM)}</td><td>${usd(Y.card.costPerM)}</td></tr>
      </table>
      <p class="src">TokenHUD usage logs, all-time on this machine.</p>
      ${bars('Hours to fill 5 h', X.hrs5, Y.hrs5, e5(X, X.hrs5), e5(Y, Y.hrs5))}
      ${bars('Hours to fill a week', X.hrsW, Y.hrsW, eW(X, X.hrsW), eW(Y, Y.hrsW))}
    </div>
  </div>
  <div class="notes">
    <div><h4>Precision</h4><p>${precision}</p></div>
    <div><h4>Speed is already counted</h4><p>Hours come from your own pace with each model, so output speed, reply size and context are already in them. Nothing from a benchmark is applied on top.</p></div>
    <div><h4>What it measures</h4><p>How long the allowance lasts at your pace, not how much finished work each model gets done in an hour.</p></div>
  </div>
  <div class="foot"><span>Hours to fill are the TokenHUD card figures, from the Claude and Codex plan meters as fitted by TokenHUD.</span><span>2 / 2</span></div>
</div>

<script>
var th=document.getElementById("th");th.onclick=function(){var l=document.documentElement.dataset.theme!=="light";document.documentElement.dataset.theme=l?"light":"dark";th.textContent=l?"Dark mode":"Light mode"};
document.getElementById("pr").onclick=function(){window.print()};
function fit(){var s=Math.min(1,(innerWidth-24)/1280);document.querySelectorAll('.slide').forEach(function(e){e.style.zoom=s})}
addEventListener('resize',fit);addEventListener('beforeprint',function(){document.querySelectorAll('.slide').forEach(function(e){e.style.zoom=1})});addEventListener('afterprint',fit);fit();
</script>
</body></html>`;
}
