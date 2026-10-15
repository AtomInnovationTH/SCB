/**
 * HudLook — the HUD's two looks ("new" and "classic") and the one switch between them.
 *
 * h2-hud-look (owner 2026-10-14: "default on, menu switch goes back to current style").
 *
 * MECHANISM. Every converted HUD colour reads `var(--hud-<role>, <today's literal>)`.
 * index.html defines the `--hud-*` variables ONLY under `html[data-look="new"]`; `<html>`
 * ships with that attribute (new look is the default, no first-paint flash). The classic
 * setting REMOVES the attribute, so every `var()` falls back to the literal it was written
 * with — classic is today's look by construction, not by a second set of values.
 *
 * `applyLook(classic)` is the ONLY code that sets or removes `data-look` on `<html>` (a
 * test greps for it). Callers: boot in main.js (before the HUD builds) and the main-menu
 * toggle. Pure DOM, no events, no imports.
 *
 * `lookColor(c)` wraps a colour that is only known at run time (a palette entry handed
 * through the target-colour law, a skill-tier colour from Constants) in the same
 * `var(--hud-<role>, c)` form. It classifies by hue with the same rules used to convert
 * the static literals, so a runtime colour and a literal of the same value get one role.
 */

/** The attribute that carries the look; `<html data-look="new">` is the default. */
const ATTR = 'data-look';

/**
 * Set (classic = false) or remove (classic = true) the new-look attribute.
 * @param {boolean} classic  true → today's look (attribute removed)
 * @param {Document} [doc]   defaults to the global document; a headless run no-ops
 * @returns {boolean} true when an element was changed
 */
export function applyLook(classic, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const root = d && d.documentElement;
  if (!root || typeof root.setAttribute !== 'function') return false;
  if (classic === true) root.removeAttribute(ATTR);
  else root.setAttribute(ATTR, 'new');
  return true;
}

/**
 * Which look a boot should show: the URL's `?look=` value wins for this load only
 * (`classic` → true, `new` → false; never saved), otherwise the saved choice.
 * @param {string|null|undefined} urlLook  the `look` query value
 * @param {boolean} saved                  settingsManager.getClassicLook()
 * @returns {boolean} true → classic
 */
export function resolveClassic(urlLook, saved) {
  if (urlLook === 'classic') return true;
  if (urlLook === 'new') return false;
  return saved === true;
}

/**
 * Whether the page is showing today's ("classic") look right now (attribute absent).
 * Read-only; the menu toggle uses it so its label tells the truth under a `?look=` override.
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function isClassic(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const root = d && d.documentElement;
  if (!root || typeof root.hasAttribute !== 'function') return false;
  return !root.hasAttribute(ATTR);
}

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
 * Wrap a run-time colour as `var(--hud-<role>, c)` (or `rgb(var(--hud-<role>-rgb, r g b) / a)`
 * for an rgba() string). Anything that is not a plain hex / rgb() colour (including an
 * already-wrapped `var(...)`) is returned unchanged.
 * @param {string} c
 * @returns {string}
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
