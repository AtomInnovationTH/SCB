/**
 * FooterChip.js — PURE footer-band chips for the experimental rung (Discoveries
 * / Orb). Plan 1788867799156-hud-pane-ladder-reorder.md Task 10 / locked #7:
 * 32 px visual / 44 px hit, INFO-cyan SPECS-tab costume, uppercase 11 px mono.
 * DISCOVERIES / ORB mount these; density-hide lives on the rung wrapper
 * (experimental sheds first, so rails-shy is a no-op at level 0). `bottomPx`
 * defaults to `footerBand({ glass, hintBandPx }).bottom`.
 *
 * WHY a module: the two chips share chrome, density, rails-shy, and hit math.
 * Resting law `[data-density-hidden]{display:none !important}` is global
 * (HUD.js:562); this file only toggles the attribute. VisualLaw.EASING is
 * `cubic-in-out` (not a CSS keyword) so rails-shy hide is instant — no
 * transition to reduce.
 *
 * @module ui/hud/FooterChip
 */

import { VisualLaw } from '../../core/VisualLaw.js';
import { RAIL_GEOMETRY, footerBand } from '../RailGeometry.js';

/** Visual height — the footer band (RailGeometry.FOOTER_BAND_PX). */
export const FOOTER_CHIP_PX = RAIL_GEOMETRY.FOOTER_BAND_PX;

/** Touch target — Apple HIG 44 pt (RailGeometry.TOUCH_PITCH_PX). */
export const FOOTER_CHIP_HIT_PX = RAIL_GEOMETRY.TOUCH_PITCH_PX;

/**
 * Documented fallback CSS `bottom` of the footer band (RailGeometry.js:108
 * example: `footerBand({ hintBandPx: 124 }) → { bottom: 132 }`). Used when
 * `bottomPx` is omitted and hintBandPx defaults to the ticker band
 * (main.js `_HINT_BAND_PX` = TICKER.BOTTOM_PX + ROW_HEIGHT_PX = 124).
 */
export const FOOTER_CHIP_BOTTOM_PX = 132;

/** Ticker band that yields FOOTER_CHIP_BOTTOM_PX via footerBand (124 + 8). */
const DEFAULT_HINT_BAND_PX = FOOTER_CHIP_BOTTOM_PX - RAIL_GEOMETRY.FOOTER_GAP_PX;

const STYLE_ID = 'hud-footer-chip-style';
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
const RAILS_SHY_ATTR = 'data-rails-shy';
const EXPANDED_ATTR = 'data-expanded';
const FONT_PX = 11;
const HIT_PAD_PX = (FOOTER_CHIP_HIT_PX - FOOTER_CHIP_PX) / 2;

/** SPECS-tab plate (LibraryPane.js:948). */
const GLASS_BG = 'rgba(0, 16, 32, 0.85)';

/** '#rrggbb' → 'rgba(r,g,b,a)' (DetailSlider idiom) — keeps hex out of this file. */
const _rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function _ensureStyle(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  if (!doc.head || typeof doc.head.appendChild !== 'function') return;
  const info = VisualLaw.COLORS.INFO;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .hud-footer-chip {
      box-sizing: border-box;
      margin: 0;
      padding: 0 10px;
      height: ${FOOTER_CHIP_PX}px;
      line-height: ${FOOTER_CHIP_PX - 2}px;
      border: 1px solid ${_rgba(info, 0.4)};
      border-radius: 3px;
      background: ${GLASS_BG};
      color: ${info};
      font-family: var(--font-mono);
      font-size: ${FONT_PX}px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      pointer-events: auto;
      z-index: 35;
    }
    .hud-footer-chip::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: ${-HIT_PAD_PX}px;
      bottom: ${-HIT_PAD_PX}px;
    }
    .hud-footer-chip[${RAILS_SHY_ATTR}] { display: none !important; }
  `;
  doc.head.appendChild(style);
}

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.label
 * @param {'left'|'right'} opts.side
 * @param {number} opts.offsetPx
 * @param {function} [opts.onTap]
 * @param {Document} [opts.doc]
 * @param {number} [opts.bottomPx] CSS `bottom` — defaults to footerBand().bottom
 * @param {boolean} [opts.glass]
 * @param {number} [opts.hintBandPx]
 * @param {object} [opts.parent] append target (default doc.body)
 * @returns {{el: object, setVisible: function, isVisible: function, setExpanded: function, isExpanded: function, setRailsShy: function, destroy: function}}
 */
export function createFooterChip({
  id, label, side, offsetPx, onTap, doc = document,
  bottomPx, glass = false, hintBandPx, parent,
} = {}) {
  _ensureStyle(doc);
  const el = doc.createElement('button');
  el.id = id;
  el.className = 'hud-footer-chip';
  el.type = 'button';
  if (el.setAttribute) {
    el.setAttribute('type', 'button');
    el.setAttribute('aria-pressed', 'false');
    el.setAttribute('data-side', side === 'right' ? 'right' : 'left');
  }
  el.textContent = String(label == null ? '' : label).toUpperCase();

  const band = footerBand({
    glass,
    hintBandPx: hintBandPx == null ? DEFAULT_HINT_BAND_PX : hintBandPx,
  });
  const bottom = Number.isFinite(Number(bottomPx)) ? Number(bottomPx) : (band.bottom || FOOTER_CHIP_BOTTOM_PX);

  const s = el.style;
  s.position = 'fixed';
  s.bottom = `${bottom}px`;
  s.height = `${FOOTER_CHIP_PX}px`;
  s.boxSizing = 'border-box';
  if (side === 'right') s.right = `${Number(offsetPx)}px`;
  else s.left = `${Number(offsetPx)}px`;
  s.color = VisualLaw.COLORS.INFO;
  s.background = GLASS_BG;
  s.fontSize = `${FONT_PX}px`;
  s.fontFamily = 'var(--font-mono)';
  s.textTransform = 'uppercase';

  const fire = () => { if (typeof onTap === 'function') onTap(); };
  const onClick = () => fire();
  const onKey = (e) => {
    const k = e && e.key;
    if (k !== 'Enter' && k !== ' ') return;
    if (e.preventDefault) e.preventDefault();
    if (e.isTrusted) return;
    fire();
  };
  if (typeof el.addEventListener === 'function') {
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
  }
  const host = parent || doc.body;
  if (host && typeof host.appendChild === 'function') host.appendChild(el);

  return {
    el,
    setVisible(v) {
      if (!el.setAttribute) return;
      if (v) el.removeAttribute(DENSITY_HIDDEN_ATTR);
      else el.setAttribute(DENSITY_HIDDEN_ATTR, '');
    },
    isVisible() {
      return !(el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR));
    },
    setExpanded(v) {
      if (!el.setAttribute) return;
      if (v) el.setAttribute(EXPANDED_ATTR, '');
      else el.removeAttribute(EXPANDED_ATTR);
      el.setAttribute('aria-pressed', v ? 'true' : 'false');
    },
    isExpanded() {
      return !!(el.hasAttribute && el.hasAttribute(EXPANDED_ATTR));
    },
    setRailsShy(v) {
      if (!el.setAttribute) return;
      if (v) el.setAttribute(RAILS_SHY_ATTR, '');
      else el.removeAttribute(RAILS_SHY_ATTR);
    },
    destroy() {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener('click', onClick);
        el.removeEventListener('keydown', onKey);
      }
      if (typeof el.remove === 'function') el.remove();
    },
  };
}
