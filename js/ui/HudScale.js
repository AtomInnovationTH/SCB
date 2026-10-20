/**
 * HudScale.js — text and panels 25 % bigger on the Mac and the iPad (u9-big-text).
 *
 * Owner 2026-10-20 (DECISIONS §32): "Bigger, readable text — make text and panels about 25 % bigger on both
 * screens." The mechanism is the CSS individual `scale` property on the top-level panel GROUPS (the block in
 * index.html: `scale: var(--hud-scale)`), never on `#hud-overlay` — that container also holds canvas overlays and
 * DOM labels positioned from 3D projections, which must keep scale 1.
 *
 * This module owns ONE thing: the number. `hudScaleFor(w, h)` is 1.25 on a screen at least 1280 x 880 and 1
 * everywhere else (phones, the old 1376 x 860 / 1180 x 820 check sizes stay byte-identical to before). The
 * installer writes the CSS variable `--hud-scale` on `<html>` at boot and on resize, write-on-change (no
 * per-frame work). At scale 1 the variable is REMOVED, so the stylesheet default (`--hud-scale: none`) applies
 * and `scale: none` leaves every panel without a transform property at all (a `scale: 1` would still make each
 * group a stacking context and a containing block for fixed descendants).
 *
 * Top-centre room: the two side panes (both `--hud-side-w` wide) and the score strip must not meet once the
 * panes are drawn 1.25 x wider. At scale 1.25 the installer writes an inline `--hud-side-w` override on `<html>`
 * (`hudSideWidthCss`); at scale 1 it removes it, so the stylesheet clamp in index.html (pinned by
 * test-MotherPane.js) applies unchanged.
 *
 * Pure apart from `installHudScale` (which touches the `win` / `doc` it is handed): Node-testable.
 *
 * @module ui/HudScale
 */

/** The scale on a big screen (Mac 1728 x 1117, iPad 1366 x 1024). */
export const HUD_SCALE_BIG = 1.25;
/** A screen at least this wide AND this tall gets HUD_SCALE_BIG. */
export const HUD_SCALE_MIN_W = 1280;
export const HUD_SCALE_MIN_H = 880;
/**
 * The widest unscaled element centred in the top band, rounded up to 10 px: the 300 px payoff line
 * (`#hud-payoff`, max-width 300, centred under the 280 px score strip and scaled with it). The strip itself
 * stays 280 px wide with a 6- or 7-digit credit count (measured 2026-10-20).
 */
export const TOP_CENTRE_WIDEST_PX = 300;
/** Gap kept between each side pane and the top-centre element, summed over both sides (px). */
export const TOP_CENTRE_GAPS_PX = 32;
/** The stylesheet's own clamp ceiling and floor for `--hud-side-w` (index.html :root). */
export const SIDE_W_MAX_PX = 480;
export const SIDE_W_MIN_PX = 300;

/** The CSS variable names this module writes. */
export const HUD_SCALE_VAR = '--hud-scale';
export const HUD_SIDE_W_VAR = '--hud-side-w';
/** The attribute set on <html> while the scale is above 1 (a CSS selector hook; absent at 1). */
export const HUD_SCALE_ATTR = 'data-hud-scale';

/**
 * @param {number} w  innerWidth
 * @param {number} h  innerHeight
 * @returns {number}  1.25 on a big screen, else 1
 */
export function hudScaleFor(w, h) {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(W) || !Number.isFinite(H)) return 1;
  return (W >= HUD_SCALE_MIN_W && H >= HUD_SCALE_MIN_H) ? HUD_SCALE_BIG : 1;
}

/**
 * The `--hud-side-w` value for a scale: at 1 null (= the stylesheet clamp applies); at 1.25 each pane is
 * `(100vw - widest * 1.25 - 32px) / 2.5` wide before scaling, so the two scaled panes (each 1.25 x that) plus the
 * scaled top-centre element plus both gaps fill the screen width exactly. 480 px at most (the stylesheet's
 * ceiling), 300 px at least.
 * @param {number} scale
 * @returns {string|null}
 */
export function hudSideWidthCss(scale) {
  if (!(scale > 1)) return null;
  const k = String(scale);
  const two = String(2 * scale);
  return `clamp(${SIDE_W_MIN_PX}px, calc((100vw - ${TOP_CENTRE_WIDEST_PX}px * ${k} - ${TOP_CENTRE_GAPS_PX}px) / ${two}), ${SIDE_W_MAX_PX}px)`;
}

/**
 * A CSS length that is `expr` seen on screen, written on an element that is drawn `scale` times bigger from its
 * top edge: the element's own layout box must be `expr / scale` for the scaled box to end where `expr` says.
 * At scale 1 the string is returned untouched (byte-identical to before).
 * @param {string} expr  a calc() / length, e.g. 'calc(100vh - 60px)'
 * @param {number} [scale]  defaults to the installed scale
 * @returns {string}
 */
export function dividedByScale(expr, scale = currentHudScale()) {
  if (!(scale > 1)) return expr;
  const inner = String(expr).replace(/^calc\((.*)\)$/, '$1');
  return `calc((${inner}) / ${scale})`;
}

// ── state ──────────────────────────────────────────────────────────────────────────────────────────────────
let _current = 1;
/** @type {Set<(scale:number, prev:number)=>void>} */
const _subs = new Set();

/** @returns {number} the scale last applied by an installer (1 before boot and in Node) */
export function currentHudScale() {
  return _current;
}

/**
 * Be told when the scale changes (a resize across the threshold). Called after the CSS variables are written.
 * @param {(scale:number, prev:number)=>void} fn
 * @returns {() => void} unsubscribe
 */
export function onHudScaleChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** Test seam: forget the installed scale and every subscriber. */
export function _resetHudScaleForTests() {
  _current = 1;
  _subs.clear();
}

/**
 * Write the scale for the window's current size, on change only. Returns a handle with `apply` (run again),
 * `dispose` (remove the listeners).
 *
 * @param {{innerWidth:number, innerHeight:number, addEventListener?:Function, removeEventListener?:Function,
 *          visualViewport?:any, document?:any}} [win]  defaults to window
 * @param {{documentElement:{style:{setProperty:Function, removeProperty:Function}}}} [doc]  defaults to win.document
 * @returns {{apply:() => number, dispose:() => void}}
 */
export function installHudScale(win = (typeof window !== 'undefined' ? window : null), doc = (win && win.document) || null) {
  const root = doc && doc.documentElement;
  const style = root && root.style;
  const canWrite = !!(style && typeof style.setProperty === 'function' && typeof style.removeProperty === 'function');
  /** @type {number|null} what is written now; null = nothing written yet (the first apply always writes) */
  let written = null;

  const apply = () => {
    const scale = win ? hudScaleFor(win.innerWidth, win.innerHeight) : 1;
    if (scale === written) return scale;
    const prev = _current;
    if (canWrite) {
      const side = hudSideWidthCss(scale);
      if (scale > 1) style.setProperty(HUD_SCALE_VAR, String(scale));
      else style.removeProperty(HUD_SCALE_VAR);
      // A selector hook for the few rules that need "is the HUD scaled at all" (index.html: the floor-1 bar's drawer offset).
      if (root && typeof root.setAttribute === 'function' && typeof root.removeAttribute === 'function') {
        if (scale > 1) root.setAttribute(HUD_SCALE_ATTR, String(scale));
        else root.removeAttribute(HUD_SCALE_ATTR);
      }
      if (side) style.setProperty(HUD_SIDE_W_VAR, side);
      else style.removeProperty(HUD_SIDE_W_VAR);
    }
    written = scale;
    _current = scale;
    if (scale !== prev) {
      for (const fn of [..._subs]) { try { fn(scale, prev); } catch (_e) { /* a listener never breaks the resize */ } }
    }
    return scale;
  };

  apply();
  const listeners = [];
  const listen = (target) => {
    if (target && typeof target.addEventListener === 'function') {
      target.addEventListener('resize', apply);
      listeners.push(target);
    }
  };
  listen(win);
  listen(win && win.visualViewport);

  return {
    apply,
    dispose() {
      for (const t of listeners) { try { t.removeEventListener('resize', apply); } catch (_e) { /* gone */ } }
      listeners.length = 0;
    },
  };
}

export default { hudScaleFor, hudSideWidthCss, dividedByScale, currentHudScale, onHudScaleChange, installHudScale };
