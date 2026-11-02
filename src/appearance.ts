// Appearance settings (font, text size, shadow, outline, UI scale, density, motion). Stored on the server so the tray window
// and the browser agree; mirrored in localStorage so the page paints with the right look before the server answers.
/** How the sections (cards) look: fill gradient, border gradient and outer shadow. `preset` is a CARD_PRESETS key, or 'custom' once edited by hand. */
export interface CardTheme { preset: string; bg1: string; bg2: string; angle: number; border1: string; border2: string; shadow: string; shadowColor: string; shadowSize: number }
export interface Appearance {
  font: string; size: number; scale: number; shadow: string; shadowColor: string;
  outline: number; outlineColor: string; density: string; motion: boolean; card: CardTheme;
}

export const CARD_SHADOWS: Record<string, string> = { none: 'None', soft: 'Soft', deep: 'Deep', glow: 'Glow', neon: 'Neon' };
export const CARD_PRESETS: Record<string, [string, Omit<CardTheme, 'preset'>]> = {
  default: ['Default', { bg1: '#071727', bg2: '#041420', angle: 180, border1: '#00d0f8', border2: '#9058f8', shadow: 'soft', shadowColor: '#000000', shadowSize: 24 }],
  midnight: ['Midnight', { bg1: '#10142e', bg2: '#080a1c', angle: 160, border1: '#6c7bff', border2: '#b06cff', shadow: 'glow', shadowColor: '#4a56ff', shadowSize: 22 }],
  ember: ['Ember', { bg1: '#2a1410', bg2: '#150a08', angle: 180, border1: '#ff8a3c', border2: '#ff3c5a', shadow: 'glow', shadowColor: '#ff6a2a', shadowSize: 20 }],
  forest: ['Forest', { bg1: '#0c2218', bg2: '#06130d', angle: 180, border1: '#2fe39a', border2: '#9be32f', shadow: 'soft', shadowColor: '#000000', shadowSize: 26 }],
  violet: ['Violet', { bg1: '#1d1038', bg2: '#0d0820', angle: 150, border1: '#c06cff', border2: '#ff5cc8', shadow: 'neon', shadowColor: '#a050ff', shadowSize: 18 }],
  graphite: ['Graphite', { bg1: '#1c2128', bg2: '#10141a', angle: 180, border1: '#8b97a7', border2: '#586270', shadow: 'deep', shadowColor: '#000000', shadowSize: 24 }],
};
export const DEFAULT_CARD: CardTheme = { preset: 'default', ...CARD_PRESETS.default[1] };

export const FONTS: Record<string, [string, string]> = {
  inter: ['Inter (default)', "'Inter Variable', 'Inter', system-ui, 'Segoe UI', sans-serif"],
  system: ['System UI', "system-ui, 'Segoe UI Variable', 'Segoe UI', sans-serif"],
  segoe: ['Segoe UI', "'Segoe UI', system-ui, sans-serif"],
  arial: ['Arial', 'Arial, Helvetica, sans-serif'],
  verdana: ['Verdana', 'Verdana, Geneva, sans-serif'],
  georgia: ['Georgia (serif)', "Georgia, 'Times New Roman', serif"],
  mono: ['JetBrains Mono', "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Consolas, monospace"],
  consolas: ['Consolas', "Consolas, ui-monospace, 'Courier New', monospace"],
};
export const SHADOWS: Record<string, string> = { none: 'None', soft: 'Soft drop', glow: 'Glow', hard: 'Hard offset' };
export const DENSITY: Record<string, [string, string, string]> = { compact: ['Compact', '8px', '12px'], normal: ['Normal', '12px', '18px'], roomy: ['Roomy', '18px', '26px'] };

export const DEFAULT_APPEARANCE: Appearance = { font: 'inter', size: 100, scale: 100, shadow: 'none', shadowColor: '#00d0f8', outline: 0, outlineColor: '#000000', density: 'normal', motion: true, card: DEFAULT_CARD };

const KEY = 'th.appearance';
const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);

export function cleanCard(o: Partial<CardTheme> | null | undefined): CardTheme {
  const d = DEFAULT_CARD, c = { ...d, ...(o || {}) };
  return {
    preset: c.preset in CARD_PRESETS ? c.preset : 'custom', bg1: hex(c.bg1, d.bg1), bg2: hex(c.bg2, d.bg2), angle: clamp(c.angle, 0, 360, d.angle),
    border1: hex(c.border1, d.border1), border2: hex(c.border2, d.border2), shadow: c.shadow in CARD_SHADOWS ? c.shadow : d.shadow,
    shadowColor: hex(c.shadowColor, d.shadowColor), shadowSize: clamp(c.shadowSize, 0, 60, d.shadowSize),
  };
}

export function clean(o: Partial<Appearance> | null | undefined): Appearance {
  const a = { ...DEFAULT_APPEARANCE, ...(o || {}) };
  return {
    card: cleanCard(a.card),
    font: a.font in FONTS ? a.font : 'inter', size: clamp(a.size, 80, 140, 100), scale: clamp(a.scale, 70, 160, 100),
    shadow: a.shadow in SHADOWS ? a.shadow : 'none', shadowColor: hex(a.shadowColor, '#00d0f8'),
    outline: clamp(a.outline, 0, 1.5, 0), outlineColor: hex(a.outlineColor, '#000000'),
    density: a.density in DENSITY ? a.density : 'normal', motion: a.motion !== false,
  };
}

const rgba = (h: string, al: number) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${al})`; };

/** Set the CSS variables. The tray popover keeps its fixed size, so it skips scale, size and density. */
export function applyAppearance(o: Partial<Appearance> | null | undefined, mini = false) {
  const a = clean(o), r = document.documentElement, s = r.style;
  s.setProperty('--font', FONTS[a.font][1]);
  s.setProperty('--tshadow', { none: 'none', soft: `0 1px 3px ${rgba(a.shadowColor, 0.6)}`, glow: `0 0 9px ${rgba(a.shadowColor, 0.75)}`, hard: `1px 1px 0 ${rgba(a.shadowColor, 0.9)}` }[a.shadow]!);
  s.setProperty('--tstroke', a.outline + 'px');
  s.setProperty('--tstroke-c', a.outlineColor);
  r.classList.toggle('no-motion', !a.motion);
  const c = a.card, z = c.shadowSize;
  const outer = { none: '0 0 0 0 transparent', soft: `0 ${z / 3}px ${z}px ${rgba(c.shadowColor, 0.35)}`, deep: `0 ${z / 2}px ${z * 1.6}px ${rgba(c.shadowColor, 0.6)}`, glow: `0 0 ${z}px ${rgba(c.shadowColor, 0.45)}`, neon: `0 0 ${z}px ${rgba(c.shadowColor, 0.75)}, 0 0 ${z / 6}px ${rgba(c.shadowColor, 0.9)}` }[c.shadow]!;
  s.setProperty('--card-bg', `linear-gradient(${c.angle}deg, ${c.bg1}, ${c.bg2})`);
  s.setProperty('--card-border', `linear-gradient(135deg, ${rgba(c.border1, 0.38)}, var(--border) 30%, var(--border) 70%, ${rgba(c.border2, 0.28)})`);
  s.setProperty('--card-shadow', `inset 0 1px 0 rgba(120, 200, 255, 0.07), inset 0 0 0 1px rgba(0, 0, 0, 0.35), ${outer}`);
  s.setProperty('--card-shadow-hover', `inset 0 1px 0 rgba(120, 200, 255, 0.1), inset 0 0 0 1px rgba(0, 0, 0, 0.35), ${outer}, 0 0 0 1px ${rgba(c.border1, 0.14)}`);
  if (mini) return;
  s.setProperty('--fs', String(a.size / 100));
  s.setProperty('--gap', DENSITY[a.density][1]);
  s.setProperty('--pad', DENSITY[a.density][2]);
  s.setProperty('zoom', a.scale === 100 ? '' : String(a.scale / 100));
}

export const loadLocalAppearance = (): Appearance => { try { return clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return clean(null); } };
export const saveLocalAppearance = (a: Appearance) => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private mode */ } };
