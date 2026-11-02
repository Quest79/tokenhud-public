// ECharts setup + the shared "hud" look.
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart, HeatmapChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { LabelLayout } from 'echarts/features';
import { ZEN, zc, glow } from './theme';

echarts.use([LineChart, BarChart, PieChart, HeatmapChart, ScatterChart, TitleComponent, GridComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, LabelLayout, CanvasRenderer]);

export const C = { cyan: zc('#00d0f8'), cyanB: zc('#26edf3'), blue: zc('#3080f8'), purple: zc('#9058f8'), pink: zc('#d850a8'), green: zc('#00d890'), amber: zc('#f0a038'), red: zc('#e84068'), axis: zc('#8fa6c0'), grid: ZEN ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.06)', line: zc('#16273a'), ring: zc('#04202c') };
/** Hover band behind bars; the zen look uses a plain white wash instead of a tinted one. */
export const ptrShadow = (old: string) => (ZEN ? 'rgba(255,255,255,.04)' : old);

const fmtAxis = (v: number) => (Math.abs(v) >= 1e9 ? v / 1e9 + 'B' : Math.abs(v) >= 1e6 ? v / 1e6 + 'M' : Math.abs(v) >= 1e3 ? v / 1e3 + 'K' : String(v));
export const fmtNum = (v: number) => v.toLocaleString('en-US');

const gradient = (color: string, top = 0.45) =>
  new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: hexA(color, top) }, { offset: 1, color: hexA(color, 0.03) }]);

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export const tooltipBase = {
  trigger: 'axis' as const,
  backgroundColor: ZEN ? '#1b1e22' : 'rgba(6,20,34,.96)',
  borderColor: ZEN ? '#30353b' : 'rgba(0,208,248,.38)',
  borderWidth: 1,
  padding: [10, 12],
  textStyle: { color: ZEN ? '#c8ccd1' : '#d1e7ff', fontSize: 12.5, fontFamily: 'Inter Variable, Inter, sans-serif' },
  extraCssText: ZEN ? 'border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);' : 'border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);backdrop-filter:blur(6px);',
  axisPointer: { type: 'line' as const, lineStyle: { color: ZEN ? '#4a5058' : C.cyanB, type: ZEN ? 'solid' as const : 'dashed' as const, width: 1 } },
};

export function tipHtml(title: string, rows: { color: string; name: string; value: string }[]): string {
  return `<div class="tip"><div class="t">${title}</div>${rows.map((r) => `<div class="r"><i style="background:${r.color};${ZEN ? '' : 'box-shadow:0 0 8px ' + r.color}"></i>${r.name}<b>${r.value}</b></div>`).join('')}</div>`;
}

const axisText = { color: C.axis, fontSize: 12, fontFamily: 'Inter Variable, Inter, sans-serif' };
const nameText = { color: C.axis, fontSize: 12.5, fontFamily: 'Inter Variable, Inter, sans-serif' };

export interface SigOpts {
  x: string[];
  a: { name: string; data: number[]; fmt?: (v: number) => string; color?: string };
  b?: { name: string; data: number[]; fmt?: (v: number) => string; color?: string };
  marks?: { x: string; name: string }[]; yMax?: number; yFmt?: (v: number) => string;
}

/** Signature chart: dual-axis glowing area lines with a dot on every point. */
export function signatureOption(o: SigOpts) {
  const ca = o.a.color ?? C.cyan, cb = o.b?.color ?? C.purple;
  const dots = o.x.length <= 60;
  const series = (s: NonNullable<SigOpts['b']>, color: string, axis: number, z: number) => ({
    name: s.name, type: 'line' as const, yAxisIndex: axis, data: s.data, smooth: 0.3, z,
    showSymbol: dots && !ZEN, symbol: 'circle', symbolSize: ZEN ? 5 : 7, showAllSymbol: true,
    itemStyle: { color, borderColor: C.ring, borderWidth: 1.5 },
    lineStyle: { width: ZEN ? 1.75 : 2, color, shadowBlur: glow(10), shadowColor: hexA(color, 0.7) },
    areaStyle: { color: gradient(color, ZEN ? 0.14 : 0.45) },
    emphasis: { focus: 'none' as const, scale: 1.6 },
    ...(o.marks && s === o.a ? { markLine: { silent: true, symbol: 'none', label: { color: C.amber, fontSize: 11, formatter: '{b}' }, lineStyle: { color: C.amber, type: 'dashed' as const, width: 1 }, data: o.marks.map((m) => ({ xAxis: m.x, name: m.name })) } } : {}),
  });
  return {
    animationDuration: 500, animationEasing: 'cubicOut' as const, animationDurationUpdate: 300,
    grid: { left: 52, right: o.b ? 52 : 18, top: 44, bottom: 26 },
    tooltip: {
      ...tooltipBase,
      formatter: (ps: any[]) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ color: p.seriesIndex === 0 && o.b ? cb : ca, name: p.seriesName, value: ((p.seriesName === o.a.name ? o.a.fmt : o.b?.fmt) ?? fmtNum)(p.value) })).reverse()),
    },
    xAxis: { type: 'category' as const, data: o.x, boundaryGap: false, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: { ...axisText, margin: 12 } },
    yAxis: [
      { type: 'value' as const, max: o.yMax, name: o.a.name, nameLocation: 'end' as const, nameGap: 16, nameTextStyle: { ...nameText, align: 'left' as const }, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { ...axisText, formatter: o.yFmt ?? fmtAxis }, axisLine: { show: false } },
      ...(o.b ? [{ type: 'value' as const, name: o.b.name, nameLocation: 'end' as const, nameGap: 16, nameTextStyle: { ...nameText, align: 'right' as const }, splitLine: { show: false }, axisLabel: { ...axisText, formatter: fmtAxis }, axisLine: { show: false } }] : []),
    ],
    series: [...(o.b ? [series(o.b, cb, 1, 1)] : []), series(o.a, ca, 0, 2)],
  };
}

export function init(el: HTMLElement, option: any): echarts.ECharts {
  const ch = echarts.init(el, undefined, { renderer: 'canvas' });
  // The UI scale setting is CSS zoom on <html>; ECharts reads offsetX, which is off under zoom, so
  // hover and tooltips hit the wrong spot. Hand it the position itself (it skips events that carry one).
  const fix = (e: Event) => {
    const m = e as MouseEvent, r = el.getBoundingClientRect(), k = el.offsetWidth ? r.width / el.offsetWidth : 1;
    if (Math.abs(k - 1) < 0.001 || m.clientX == null) return;
    Object.assign(m, { zrX: (m.clientX - r.left) / k, zrY: (m.clientY - r.top) / k });
  };
  for (const t of ['mousemove', 'mousedown', 'mouseup', 'mouseout', 'click', 'dblclick', 'contextmenu', 'wheel', 'pointermove', 'pointerdown', 'pointerup', 'pointerout']) el.addEventListener(t, fix, true);
  ch.setOption(option);
  new ResizeObserver(() => ch.resize()).observe(el);
  return ch;
}

/** Stacked bars: input cyan->blue, output purple, rounded tops (hourly burn style). */
export function stackedBarsOption(x: string[], a: { name: string; data: number[] }, b: { name: string; data: number[] }) {
  const g = (c1: string, c2: string) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: c1 }, { offset: 1, color: c2 }]);
  return {
    animationDuration: 500,
    grid: { left: 44, right: 12, top: 16, bottom: 24 },
    tooltip: { ...tooltipBase, axisPointer: { type: 'shadow' as const, shadowStyle: { color: ptrShadow('rgba(0,208,248,.07)') } }, formatter: (ps: any[]) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ color: p.seriesIndex ? C.purple : C.cyan, name: p.seriesName, value: fmtNum(p.value) }))) },
    xAxis: { type: 'category' as const, data: x, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: { ...axisText, interval: 3 } },
    yAxis: { type: 'value' as const, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { ...axisText, formatter: fmtAxis } },
    series: [
      { name: a.name, type: 'bar' as const, stack: 's', data: a.data, barWidth: '58%', itemStyle: { color: g(zc('#26d4f8'), zc('#0a6fd0')) } },
      { name: b.name, type: 'bar' as const, stack: 's', data: b.data, barWidth: '58%', itemStyle: { color: g(zc('#b48cff'), zc('#6a3fd8')), borderRadius: [3, 3, 0, 0] } },
    ],
  };
}

/** Donut with gradient segments and a big total in the centre. */
export function donutOption(total: string, parts: { name: string; value: number; c1: string; c2: string }[], unit = 'Tokens', fmt: (v: number) => string = fmtNum) {
  return {
    animationDuration: 600,
    tooltip: { ...tooltipBase, trigger: 'item' as const, formatter: (p: any) => tipHtml(p.name, [{ color: p.color.colorStops?.[1]?.color ?? p.color, name: unit, value: `${fmt(p.value)} (${p.percent}%)` }]) },
    title: { text: total, subtext: 'Total', left: 'center', top: '36%', textStyle: { color: ZEN ? '#eceef0' : '#fff', fontSize: 20, fontWeight: (ZEN ? 600 : 700) as number }, subtextStyle: { color: C.axis, fontSize: 12 } },
    series: [{
      type: 'pie' as const, radius: ['62%', '80%'], padAngle: 2, label: { show: false },
      itemStyle: { borderRadius: 6 },
      data: parts.map((p) => ({ name: p.name, value: p.value, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [{ offset: 0, color: zc(p.c1) }, { offset: 1, color: zc(p.c2) }]), shadowBlur: glow(12), shadowColor: hexA(zc(p.c2), 0.5) } })),
    }],
  };
}

/** Hour x weekday heatmap, cyan sequential ramp, rounded cells. */
export function heatmapOption(hours: string[], days: string[], data: [number, number, number][]) {
  const max = Math.max(...data.map((d) => d[2]));
  return {
    animationDuration: 500,
    grid: { left: 40, right: 16, top: 10, bottom: 46 },
    tooltip: { ...tooltipBase, trigger: 'item' as const, axisPointer: undefined, formatter: (p: any) => tipHtml(`${days[p.value[1]]} ${hours[p.value[0]]}`, [{ color: C.cyan, name: 'Tokens', value: fmtNum(p.value[2]) }]) },
    xAxis: { type: 'category' as const, data: hours, splitArea: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisText, interval: 2 } },
    yAxis: { type: 'category' as const, inverse: true, data: days, axisLine: { show: false }, axisTick: { show: false }, axisLabel: axisText },
    visualMap: { min: 0, max, calculable: false, orient: 'horizontal' as const, left: 'center', bottom: 0, itemWidth: 10, itemHeight: 120, textStyle: { color: C.axis, fontSize: 11 }, inRange: { color: ZEN ? ['#1d2227', '#2f4a59', '#4f87a3', '#8cc6df'] : ['#06222c', '#00607a', '#00b4d8', '#26edf3'] } },
    series: [{ type: 'heatmap' as const, data, itemStyle: { borderColor: zc('#041420'), borderWidth: 3, borderRadius: 4 }, emphasis: { itemStyle: { shadowBlur: glow(10), shadowColor: 'rgba(38,237,243,.6)' } } }],
  };
}

/** Histogram: blue to purple vertical gradient bars. */
export function histogramOption(x: string[], data: number[]) {
  return {
    animationDuration: 500,
    grid: { left: 40, right: 8, top: 10, bottom: 24 },
    tooltip: { ...tooltipBase, axisPointer: { type: 'shadow' as const, shadowStyle: { color: ptrShadow('rgba(144,88,248,.08)') } }, formatter: (ps: any[]) => tipHtml(ps[0].axisValueLabel + ' tokens', [{ color: C.blue, name: 'Messages', value: fmtNum(ps[0].value) }]) },
    xAxis: { type: 'category' as const, data: x, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: axisText },
    yAxis: { type: 'value' as const, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { ...axisText, formatter: fmtAxis } },
    series: [{ type: 'bar' as const, data, barWidth: '78%', itemStyle: { borderRadius: [3, 3, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: zc('#7a5af8') }, { offset: 1, color: zc('#1e6fd8') }]) } }],
  };
}

export interface SigTimeOpts {
  xt: number[]; xFmt: (t: number) => string; min: number; max: number; yMax?: [number, number];
  a: SigOpts['a']; b: NonNullable<SigOpts['b']>;
}

/** The signature chart on a real time axis, so the window can slide smoothly between data updates (Overview). */
export function signatureTimeOption(o: SigTimeOpts) {
  const opt: any = signatureOption({ x: o.xt.map(String), a: o.a, b: o.b });
  opt.animation = false; opt.animationDurationUpdate = 0;
  opt.xAxis = { type: 'time' as const, min: o.min, max: o.max, boundaryGap: false, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { ...axisText, margin: 12, hideOverlap: true, formatter: (v: number) => o.xFmt(v) } };
  if (o.yMax) { opt.yAxis[0].max = o.yMax[0]; opt.yAxis[1].max = o.yMax[1]; }
  opt.series[0].data = o.xt.map((t, i) => [t, o.b.data[i]]);
  opt.series[1].data = o.xt.map((t, i) => [t, o.a.data[i]]);
  opt.tooltip.formatter = (ps: any[]) => tipHtml(o.xFmt(ps[0].value[0]), ps.map((p) => ({ color: p.seriesIndex === 0 ? (o.b.color ?? C.purple) : (o.a.color ?? C.cyan), name: p.seriesName, value: ((p.seriesName === o.a.name ? o.a.fmt : o.b.fmt) ?? fmtNum)(p.value[1]) })).reverse());
  return opt;
}
