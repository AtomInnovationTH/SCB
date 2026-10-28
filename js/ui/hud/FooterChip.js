/**
 * FooterChip.js — PURE footer-band chips for the experimental rung (Discoveries / Orb): 32 px visual / 44 px hit,
 * INFO-cyan SPECS-tab costume, uppercase 11 px mono. DISCOVERIES / ORB mount these; density-hide lives on the rung
 * wrapper (experimental sheds first, so rails-shy is a no-op at level 0). `bottomPx` defaults to
 * `footerBand({ glass, hintBandPx }).bottom`.
 *
 * WHY a module: the two chips share chrome, density, rails-shy, and hit math. Resting law
 * `[data-density-hidden]{display:none !important}` is global (HUD.js); this file only toggles the attribute.
 * VisualLaw.EASING is `cubic-in-out` (not a CSS keyword) so rails-shy hide is instant — no transition to reduce.
 *
 * @module ui/hud/FooterChip
 */

import { VisualLaw } from '../../core/VisualLaw.js';
import { HUD_EDGE_PX, RAIL_GEOMETRY, footerBand } from '../RailGeometry.js';
import { TRACK_WIDTH_PX } from '../DetailSlider.js';

/** Visual height — the footer band (RailGeometry.FOOTER_BAND_PX). */
export const FOOTER_CHIP_PX = RAIL_GEOMETRY.FOOTER_BAND_PX;

/** Touch target — Apple HIG 44 pt (RailGeometry.TOUCH_PITCH_PX). */
export const FOOTER_CHIP_HIT_PX = RAIL_GEOMETRY.TOUCH_PITCH_PX;

/**
 * Fallback CSS `bottom` of the footer band (RailGeometry `footerBand({ hintBandPx: 124 }) → { bottom: 132 }`). Used when
 * `bottomPx` is omitted and hintBandPx defaults to the ticker band (main.js `_HINT_BAND_PX` = TICKER.BOTTOM_PX +
 * ROW_HEIGHT_PX = 124).
 */
export const FOOTER_CHIP_BOTTOM_PX = 132;

/** Ticker band that yields FOOTER_CHIP_BOTTOM_PX via footerBand (124 + 8). */
const DEFAULT_HINT_BAND_PX = FOOTER_CHIP_BOTTOM_PX - RAIL_GEOMETRY.FOOTER_GAP_PX;

/**
 * Where the two chips sit: the DETAIL slider lives bottom RIGHT (its right edge HUD_EDGE_PX from the screen, 176 px wide
 * x `--hud-scale`) and the SPECS tab bottom LEFT, so both chips stand left of the slider on the footer baseline:
 * [DISCOVERIES] gap [ORB] gap [slider] edge. One gap everywhere (>= 8 px to anything).
 */
export const FOOTER_CHIP_GAP_PX = 10;
/** ORB's fixed width (its text is about 46 px) so DISCOVERIES can be placed by number. */
export const ORB_CHIP_WIDTH_PX = 52;
const SLIDER_FOOTPRINT_PX = TRACK_WIDTH_PX + 2 * 8;   // DetailSlider.js: track + 8 px pad each side

/**
 * CSS `right` of a chip that stands `extraPx` left of the slider's left edge (+ one gap). The slider scales with
 * `--hud-scale` (index.html), the chips do not, so the footprint is multiplied by the live scale.
 */
export function leftOfSliderCss(extraPx = 0) {
  return `calc(${HUD_EDGE_PX + FOOTER_CHIP_GAP_PX + extraPx}px + ${SLIDER_FOOTPRINT_PX}px * var(--hud-scale, 1))`;
}

/** Unscaled (scale 1) value of {@link leftOfSliderCss}, for tests and docs. */
export function leftOfSliderBasePx(extraPx = 0) {
  return HUD_EDGE_PX + FOOTER_CHIP_GAP_PX + extraPx + SLIDER_FOOTPRINT_PX;
}

/**
 * The F1 SPECS drawer covers the footer band's right half, so both chips step aside while it is open. Writes
 * `style.visibility` on the DISCOVERIES wrapper (chip + popover) and the ORB chip: a bit of its own, so it never fights
 * the density step or FloorMask; '' when the drawer closes restores them.
 */
export function setChipsUnderDrawer(hidden, doc = document) {
  for (const id of ['hud-discoveries', 'hud-chip-orb']) {
    const el = doc.getElementById(id);
    if (el) el.style.visibility = hidden ? 'hidden' : '';
  }
}

const STYLE_ID = 'hud-footer-chip-style';
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
const RAILS_SHY_ATTR = 'data-rails-shy';
const EXPANDED_ATTR = 'data-expanded';
const FONT_PX = 11;
const HIT_PAD_PX = (FOOTER_CHIP_HIT_PX - FOOTER_CHIP_PX) / 2;

/** SPECS-tab plate (LibraryPane). */
const GLASS_BG = 'rgb(var(--hud-ink-rgb, 0 16 32) / 0.85)';

/** '#rrggbb' → an info-role tint at alpha a: `rgb(var(--hud-info-rgb, r g b) / a)` (the fallback IS today's colour). */
const _rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgb(var(--hud-info-rgb, ${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}) / ${a})`;
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
      color: var(--hud-info, ${info});
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
 * @param {number|string} opts.offsetPx  px, or a CSS length such as a calc()
 * @param {number} [opts.bottomPx] CSS `bottom` — defaults to footerBand().bottom
 * @param {object} [opts.parent] append target (default doc.body)
 * @returns {{el: object, setVisible: function, isVisible: function, setExpanded: function, isExpanded: function, setRailsShy: function, destroy: function}}
 */
export function createFooterChip({
  id, label, side, offsetPx, onTap, doc = document, minWidthPx,
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
  const off = typeof offsetPx === 'string' ? offsetPx : `${Number(offsetPx)}px`;
  if (side === 'right') s.right = off;
  else s.left = off;
  if (Number.isFinite(Number(minWidthPx))) s.minWidth = `${Number(minWidthPx)}px`;
  s.color = `var(--hud-info, ${VisualLaw.COLORS.INFO})`;
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
