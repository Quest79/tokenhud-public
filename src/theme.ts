// Zen ("new UI") switch. The class goes on <html> when this module is first imported, before anything renders;
// the old look is untouched CSS, so turning it off restores it exactly. The tray popover (#/mini) stays on the old look.
const KEY = 'th.ui';
export const ZEN: boolean = (() => { try { return localStorage.getItem(KEY) !== 'old'; } catch { return true; } })() && !location.hash.startsWith('#/mini');
if (ZEN) document.documentElement.classList.add('ui-zen');

/** Flip the UI and reload, so charts and gauges (colours baked in when drawn) pick up the new look. */
export function setZen(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'new' : 'old'); } catch { /* private mode */ }
  location.reload();
}

/** Old neon palette -> calm zen palette. Anything not listed passes through unchanged. */
const MAP: Record<string, string> = {
  '#00d0f8': '#6fb3d2', '#26edf3': '#8cc6df', '#26d4f8': '#7bbcd9', '#28c0f8': '#7bbcd9', '#0a6fd0': '#5a9cbd', '#3080f8': '#7b9bd3', '#1e6fd8': '#7b9bd3', '#1c56c0': '#6a88bf',
  '#9058f8': '#a395d4', '#7a5af8': '#a395d4', '#b48cff': '#b5a9dc', '#6a3fd8': '#8f82c4', '#d850a8': '#c58ab0', '#a03080': '#b07a9c',
  '#00d890': '#72b896', '#2cf59b': '#86c9a8', '#00f098': '#86c9a8', '#00b88a': '#62a888', '#0a9a6a': '#62a888',
  '#f0a038': '#d4a65a', '#ffc060': '#e0b672', '#d08020': '#bf9249', '#c07818': '#bf9249', '#e84068': '#d4737f',
  '#4aa3ff': '#7fa8d8', '#ee9aa3': '#d99aa2', '#f2b8a8': '#d9aa9c',
  '#8fa6c0': '#868e98', '#16273a': '#272b30', '#04202c': '#16191c', '#1a2a44': '#23272c', '#04101c': '#16191c', '#041420': '#16191c',
};
export const zc = (c: string): string => (ZEN ? (MAP[c.toLowerCase()] ?? c) : c);
/** Glow strength: the zen look has none. */
export const glow = (n: number): number => (ZEN ? 0 : n);
