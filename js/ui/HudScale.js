/**
 * HudScale.js — text and panels 25 % bigger on the Mac and the iPad (DECISIONS §32).
 *
 * Mechanism: the CSS `scale` property on the top-level panel GROUPS (index.html: `scale: var(--hud-scale)`), never
 * on `#hud-overlay` — it also holds canvas overlays and DOM labels positioned from 3D projections, which must keep
 * scale 1.
 *
 * `hudScaleFor(w, h)` is 1.25 on a screen at least 1280 x 880, else 1 (the cut-off keeps the 1376 x 860 and
 * 1180 x 820 check sizes at scale 1). The installer writes `--hud-scale` on `<html>` at boot and on resize, on change
 * only. At scale 1 the variable is REMOVED so the stylesheet default (`none`) applies: `scale: 1` would still make
 * each group a stacking context and a containing block for fixed descendants.
 *
 * Top-centre room: at 1.25 the installer also writes an inline `--hud-side-w` (`hudSideWidthCss`) so the two side
 * panes and the score strip never meet; at scale 1 it is removed and the stylesheet clamp in index.html (pinned by
 * test-MotherPane.js) applies.
 *
 * Pure apart from `installHudScale` (touches the `win` / `doc` it is handed).
 *
 * @module ui/HudScale
 */

/** The scale on a big screen (Mac 1728 x 1117, iPad 1366 x 1024). */
export const HUD_SCALE_BIG = 1.25;
export const HUD_SCALE_MIN_W = 1280;
export const HUD_SCALE_MIN_H = 880;
/**
 * Widest unscaled element centred in the top band, rounded up to 10 px: the `#hud-payoff` line (max-width 300).
 * The 280 px score strip stays 280 px with a 6- or 7-digit credit count (measured).
 */
export const TOP_CENTRE_WIDEST_PX = 300;
/** Gap between each side pane and the top-centre element, summed over both sides (px). */
export const TOP_CENTRE_GAPS_PX = 32;
/** The stylesheet's clamp ceiling and floor for `--hud-side-w` (index.html :root). */
export const SIDE_W_MAX_PX = 480;
export const SIDE_W_MIN_PX = 300;

export const HUD_SCALE_VAR = '--hud-scale';
export const HUD_SIDE_W_VAR = '--hud-side-w';
/** Attribute on <html> while the scale is above 1 (CSS selector hook; absent at 1). */
export const HUD_SCALE_ATTR = 'data-hud-scale';

/** 1.25 on a big screen, else 1 (w, h = innerWidth, innerHeight). */
export function hudScaleFor(w, h) {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(W) || !Number.isFinite(H)) return 1;
  return (W >= HUD_SCALE_MIN_W && H >= HUD_SCALE_MIN_H) ? HUD_SCALE_BIG : 1;
}

/**
 * The `--hud-side-w` value for a scale: null at 1 (stylesheet clamp applies); at 1.25 each pane is
 * `(100vw - widest * 1.25 - 32px) / 2.5` before scaling, so the two scaled panes plus the scaled top-centre
 * element plus both gaps fill the screen width exactly. Clamped to 300..480 px.
 * @returns {string|null}
 */
export function hudSideWidthCss(scale) {
  if (!(scale > 1)) return null;
  const k = String(scale);
  const two = String(2 * scale);
  return `clamp(${SIDE_W_MIN_PX}px, calc((100vw - ${TOP_CENTRE_WIDEST_PX}px * ${k} - ${TOP_CENTRE_GAPS_PX}px) / ${two}), ${SIDE_W_MAX_PX}px)`;
}

/**
 * A CSS length that is `expr` as seen on screen, for an element drawn `scale` times bigger from its top edge: its
 * layout box must be `expr / scale`. Returned untouched at scale 1.
 * @param {string} expr  a calc() / length, e.g. 'calc(100vh - 60px)'
 * @param {number} [scale]  defaults to the installed scale
 */
export function dividedByScale(expr, scale = currentHudScale()) {
  if (!(scale > 1)) return expr;
  const inner = String(expr).replace(/^calc\((.*)\)$/, '$1');
  return `calc((${inner}) / ${scale})`;
}

let _current = 1;
/** @type {Set<(scale:number, prev:number)=>void>} */
const _subs = new Set();

/** @returns {number} the scale last applied (1 before boot and in Node) */
export function currentHudScale() {
  return _current;
}

/**
 * Subscribe to scale changes (a resize across the threshold), called after the CSS variables are written.
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
 * Write the scale for the window's current size, on change only. Handle: `apply` (run again), `dispose`.
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
      // Selector hook for rules that need "is the HUD scaled at all" (index.html: the floor-1 bar's drawer offset).
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
