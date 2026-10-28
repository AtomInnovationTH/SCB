/**
 * @module ui/HudLook — HUD colour roles; `lookColor` wraps run-time colours as `var(--hud-<role>, c)`.
 * owner 2026-10-18: keep the new look; the classic look and its menu switch are gone.
 * index.html defines `--hud-*` under `html[data-look="new"]` (set on `<html>` in the markup, never at run time);
 * the literal inside each `var()` is only a CSS fallback. Pure functions, no DOM, no imports.
 */

/** Colours whose role cannot be read off the hue. */
const OVERRIDE = { 'rgba(180,200,210,0.45)': 'dim' };

function _rgbOf(c) {
  const s = String(c).trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: null };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? null : m[4] };
  return null;
}

/** Role of an sRGB colour: ink / dim / label / text / normal / info / target / warning / caution. */
export function roleOf(r, g, b, hasAlpha = false) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = max ? (max - min) / max : 0;
  if (max <= 60 && !(sat < 0.12 && max >= 40)) return 'ink';
  if (sat < 0.12) {
    if (lum >= 235) return hasAlpha ? 'text' : 'label';
    if (lum >= 195) return 'text';
    if (lum >= 150) return 'label';
    return 'dim';
  }
  if (lum >= 205 && sat < 0.36) return 'text';
  if (sat < 0.3 && lum < 165) return 'dim';
  const d = max - min;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  if (h >= 75 && h < 175) return 'normal';
  if (h >= 175 && h < 255) return 'info';
  if (h >= 255 && h < 340) return 'target';
  if (h >= 340 || h < 30) return 'warning';
  return 'caution';
}

/**
 * Wrap a run-time colour as `var(--hud-<role>, c)` (`rgb(var(--hud-<role>-rgb, r g b) / a)` for rgba()).
 * Same hue rules as the static literals, so equal colours get one role. Non-hex/rgb() input
 * (including an already-wrapped `var(...)`) is returned unchanged.
 */
export function lookColor(c) {
  if (typeof c !== 'string') return c;
  const p = _rgbOf(c);
  if (!p) return c;
  const key = c.trim().toLowerCase().replace(/\s+/g, '');
  const role = OVERRIDE[key] || roleOf(p.r, p.g, p.b, p.a !== null);
  if (p.a !== null) return `rgb(var(--hud-${role}-rgb, ${p.r} ${p.g} ${p.b}) / ${p.a})`;
  return `var(--hud-${role}, ${c})`;
}
