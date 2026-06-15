/**
 * FlagDecalSystem.js — Procedural Canvas2D country flag decal atlas
 * Generates simplified geometric flags for ~15 countries + unknown fallback.
 * No external image files — all Canvas2D procedural shapes.
 *
 * ST-6.2: Phase 3 country flag decals.
 * @module ui/FlagDecalSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

// ============================================================================
// COUNTRY CONFIGURATION (pure logic — Node-safe)
// ============================================================================

/**
 * Ordered list of supported country codes.
 * Index = slot position in the 4×4 flag atlas grid.
 * The last slot (index 15) is the "unknown" fallback.
 */
const COUNTRY_ORDER = [
  'USA', 'CIS', 'PRC', 'JPN',
  'IND', 'ESA', 'FRA', 'GBR',
  'ISS', 'DEU', 'ITA', 'CAN',
  'BRA', 'KOR', 'ISR', '???',
];

/** Alias map: alternate codes resolve to canonical codes */
const COUNTRY_ALIASES = {
  RUS: 'CIS',
  CHN: 'PRC',
};

// ============================================================================
// PURE-LOGIC EXPORTS (Node-safe — no Canvas/THREE dependency)
// ============================================================================

/**
 * Compute UV offset + scale for a country's flag slot in the atlas grid.
 * Unknown country codes map to the '???' fallback slot.
 *
 * @param {string} countryCode — ISO-3-ish code (e.g. 'USA', 'CIS')
 * @param {number} [cols] — grid columns (default: Constants or 4)
 * @param {number} [rows] — grid rows (default: Constants or 4)
 * @returns {{ offsetU: number, offsetV: number, scaleU: number, scaleV: number }}
 */
export function getUVOffsetForCountry(countryCode, cols, rows) {
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const c = cols || C.FLAG_SLOT_COLS || 4;
  const r = rows || C.FLAG_SLOT_ROWS || 4;

  const resolved = COUNTRY_ALIASES[countryCode] || countryCode;
  let idx = COUNTRY_ORDER.indexOf(resolved);
  if (idx < 0) idx = COUNTRY_ORDER.indexOf('???');

  const col = idx % c;
  const row = Math.floor(idx / c);
  return {
    offsetU: col / c,
    offsetV: 1 - (row + 1) / r,
    scaleU: 1 / c,
    scaleV: 1 / r,
  };
}

/**
 * Check whether a country code has a dedicated flag design.
 * @param {string} countryCode
 * @returns {boolean}
 */
export function hasFlag(countryCode) {
  const resolved = COUNTRY_ALIASES[countryCode] || countryCode;
  const idx = COUNTRY_ORDER.indexOf(resolved);
  // '???' slot is the unknown fallback — not a "real" flag
  return idx >= 0 && COUNTRY_ORDER[idx] !== '???';
}

/**
 * Item 12 (2026-06-12): flag eligibility by debris CLASS, not just country.
 * Only satellites and rocket bodies large enough to plausibly carry national
 * markings get a decal — fragments and small junk never do.
 * Pure + Node-safe (unit-tested headless).
 *
 * @param {{type?: string, sizeMeter?: number}|null} debris
 * @returns {boolean}
 */
export function isFlagEligible(debris) {
  if (!debris) return false;
  const t = debris.type;
  if (t !== 'rocketBody' && t !== 'defunctSat') return false;
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const minM = C.FLAG_MIN_SIZE_M ?? 2;
  return (debris.sizeMeter || 0) >= minM;
}

/**
 * Item 12 (2026-06-12): deterministic weighted country pick for PROCEDURAL
 * sats/rockets (catalog rows carry their own country). Weighted toward the
 * historically dominant launch states so early-mission fields look plausible.
 * Deterministic from the debris id so saves agree.
 *
 * @param {number} id — numeric debris id
 * @returns {string} country code from the flag atlas (never '???')
 */
export function pickCountryForId(id) {
  // [code, weight] — rough share of large LEO objects by origin.
  const WEIGHTED = [
    ['CIS', 30], ['USA', 25], ['PRC', 18], ['JPN', 5], ['IND', 5],
    ['ESA', 5], ['FRA', 3], ['GBR', 2], ['DEU', 2], ['ITA', 1],
    ['CAN', 1], ['BRA', 1], ['KOR', 1], ['ISR', 1],
  ];
  const total = WEIGHTED.reduce((s, [, w]) => s + w, 0);
  // Deterministic hash of the id → [0, 1)
  const h = Math.sin((id || 0) * 78.233 + 1.618) * 43758.5453;
  let roll = (h - Math.floor(h)) * total;
  for (const [code, w] of WEIGHTED) {
    roll -= w;
    if (roll < 0) return code;
  }
  return WEIGHTED[0][0];
}

// ============================================================================
// CANVAS2D FLAG ATLAS CLASS (browser-only)
// ============================================================================

/**
 * Procedural Canvas2D flag atlas for ~15 countries.
 * Generates a single THREE.CanvasTexture at boot; not per-frame.
 */
export class FlagDecalSystem {
  /**
   * @param {number} [atlasSize] — pixel dimension (default from Constants)
   */
  constructor(atlasSize) {
    const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
    this._size = atlasSize || C.FLAG_ATLAS_SIZE || 512;
    this._cols = C.FLAG_SLOT_COLS || 4;
    this._rows = C.FLAG_SLOT_ROWS || 4;
    /** @type {HTMLCanvasElement|null} */
    this._canvas = null;
    /** @type {THREE.CanvasTexture|null} */
    this.texture = null;
  }

  /**
   * Paint all flags and return a THREE.CanvasTexture.
   * @returns {THREE.CanvasTexture|null}
   */
  generate() {
    if (typeof document === 'undefined') return null;

    const size = this._size;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    this._canvas = canvas;
    const ctx = canvas.getContext('2d');

    const slotW = Math.floor(size / this._cols);
    const slotH = Math.floor(size / this._rows);

    for (let i = 0; i < COUNTRY_ORDER.length; i++) {
      const code = COUNTRY_ORDER[i];
      const col = i % this._cols;
      const row = Math.floor(i / this._cols);
      const x = col * slotW;
      const y = row * slotH;
      this._paintFlag(ctx, code, x, y, slotW, slotH);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = tex;
    return tex;
  }

  /** Delegates to pure function */
  getUVOffsetForCountry(countryCode) {
    return getUVOffsetForCountry(countryCode, this._cols, this._rows);
  }

  /** Delegates to pure function */
  hasFlag(countryCode) {
    return hasFlag(countryCode);
  }

  /** Release canvas + texture GPU memory */
  dispose() {
    if (this.texture && this.texture.dispose) this.texture.dispose();
    this.texture = null;
    this._canvas = null;
  }

  // --------------------------------------------------------------------------
  // Flag painting dispatch
  // --------------------------------------------------------------------------

  /** @private */
  _paintFlag(ctx, code, x, y, w, h) {
    // Add 2px padding inside each slot for visual separation
    const pad = 2;
    const fx = x + pad;
    const fy = y + pad;
    const fw = w - pad * 2;
    const fh = h - pad * 2;

    this._drawFlagArt(ctx, code, fx, fy, fw, fh);

    // Decal placard frame so the flag reads as a riveted plate bonded to the
    // hull (NASA/ESA style), not a floating banner. Drawn over the flag art.
    this._paintDecalFrame(ctx, fx, fy, fw, fh);
  }

  /**
   * @private Pure flag artwork dispatch (no placard frame). Shared by the debris
   * atlas (`_paintFlag`) and the standalone EVA shoulder-patch texture
   * (`makeFlagCanvas`). Supports a couple of codes beyond the 16-slot atlas
   * (THA, ESP) used only for the player's suit patch.
   */
  _drawFlagArt(ctx, code, x, y, w, h) {
    switch (code) {
      case 'USA': this._paintUSA(ctx, x, y, w, h); break;
      case 'CIS': this._paintCIS(ctx, x, y, w, h); break;
      case 'PRC': this._paintPRC(ctx, x, y, w, h); break;
      case 'JPN': this._paintJPN(ctx, x, y, w, h); break;
      case 'IND': this._paintIND(ctx, x, y, w, h); break;
      case 'ESA': this._paintESA(ctx, x, y, w, h); break;
      case 'FRA': this._paintFRA(ctx, x, y, w, h); break;
      case 'GBR': this._paintGBR(ctx, x, y, w, h); break;
      case 'ISS': this._paintISS(ctx, x, y, w, h); break;
      case 'DEU': this._paintDEU(ctx, x, y, w, h); break;
      case 'ITA': this._paintITA(ctx, x, y, w, h); break;
      case 'CAN': this._paintCAN(ctx, x, y, w, h); break;
      case 'BRA': this._paintBRA(ctx, x, y, w, h); break;
      case 'KOR': this._paintKOR(ctx, x, y, w, h); break;
      case 'ISR': this._paintISR(ctx, x, y, w, h); break;
      case 'THA': this._paintTHA(ctx, x, y, w, h); break;
      case 'ESP': this._paintESP(ctx, x, y, w, h); break;
      default:    this._paintUnknown(ctx, x, y, w, h); break;
    }
  }

  /**
   * Render a SINGLE flag to a standalone canvas (no riveted decal frame), for
   * use as a texture map elsewhere — e.g. the astronaut's curved shoulder
   * patch. Browser-only (returns null under Node).
   *
   * @param {string} code — flag code (USA/IND/JPN/THA/ESP/…)
   * @param {number} [w=96]  canvas width  (landscape ~3:2 reads best)
   * @param {number} [h=64]  canvas height
   * @returns {HTMLCanvasElement|null}
   */
  makeFlagCanvas(code, w = 96, h = 64) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    this._drawFlagArt(ctx, code, 0, 0, w, h);
    return canvas;
  }

  /** @private Riveted placard frame + edge shading to sell "painted on hardware" */
  _paintDecalFrame(ctx, x, y, w, h) {
    ctx.save();
    // Subtle inner vignette (panel curvature / dirt at edges)
    const vg = ctx.createLinearGradient(x, y, x, y + h);
    vg.addColorStop(0, 'rgba(255,255,255,0.10)');
    vg.addColorStop(0.5, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(x, y, w, h);

    // Dark metal border
    ctx.strokeStyle = 'rgba(20,22,26,0.85)';
    ctx.lineWidth = Math.max(2, w * 0.03);
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2,
      w - ctx.lineWidth, h - ctx.lineWidth);

    // Corner rivets
    ctx.fillStyle = 'rgba(180,182,190,0.9)';
    const r = Math.max(2, w * 0.04);
    const inset = r * 1.6;
    for (const [rx, ry] of [
      [x + inset, y + inset], [x + w - inset, y + inset],
      [x + inset, y + h - inset], [x + w - inset, y + h - inset],
    ]) {
      ctx.beginPath(); ctx.arc(rx, ry, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(40,42,48,0.6)';
      ctx.beginPath(); ctx.arc(rx + r * 0.2, ry + r * 0.2, r * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(180,182,190,0.9)';
    }
    ctx.restore();
  }

  // --------------------------------------------------------------------------
  // Individual flag painters (simplified geometric approximations)
  // --------------------------------------------------------------------------

  /** USA: blue canton + star grid + red/white stripes */
  _paintUSA(ctx, x, y, w, h) {
    const stripeH = h / 13;
    for (let i = 0; i < 13; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#B22234' : '#FFFFFF';
      ctx.fillRect(x, y + i * stripeH, w, stripeH + 1);
    }
    const cw = w * 0.4;
    const ch = stripeH * 7;
    ctx.fillStyle = '#3C3B6E';
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = '#FFFFFF';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        ctx.beginPath();
        ctx.arc(x + cw * (c + 0.5) / 5, y + ch * (r + 0.5) / 3,
          Math.max(1, Math.min(cw, ch) * 0.04), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** CIS/Russia: horizontal tricolour white/blue/red */
  _paintCIS(ctx, x, y, w, h) {
    const sh = h / 3;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x, y, w, sh + 1);
    ctx.fillStyle = '#0039A6'; ctx.fillRect(x, y + sh, w, sh + 1);
    ctx.fillStyle = '#D52B1E'; ctx.fillRect(x, y + sh * 2, w, sh + 1);
  }

  /** PRC/China: red field + yellow star cluster */
  _paintPRC(ctx, x, y, w, h) {
    ctx.fillStyle = '#DE2910';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#FFDE00';
    // Large star
    const sx = x + w * 0.2;
    const sy = y + h * 0.35;
    this._drawStar(ctx, sx, sy, Math.min(w, h) * 0.12, 5);
    // 4 small stars
    const smallR = Math.min(w, h) * 0.05;
    this._drawStar(ctx, x + w * 0.35, y + h * 0.18, smallR, 5);
    this._drawStar(ctx, x + w * 0.42, y + h * 0.28, smallR, 5);
    this._drawStar(ctx, x + w * 0.42, y + h * 0.42, smallR, 5);
    this._drawStar(ctx, x + w * 0.35, y + h * 0.52, smallR, 5);
  }

  /** Japan: white field + red circle */
  _paintJPN(ctx, x, y, w, h) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#BC002D';
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  /** India: saffron/white/green + blue Ashoka chakra circle */
  _paintIND(ctx, x, y, w, h) {
    const sh = h / 3;
    ctx.fillStyle = '#FF9933'; ctx.fillRect(x, y, w, sh + 1);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x, y + sh, w, sh + 1);
    ctx.fillStyle = '#138808'; ctx.fillRect(x, y + sh * 2, w, sh + 1);
    // Blue circle (simplified Ashoka Chakra)
    ctx.strokeStyle = '#000080';
    ctx.lineWidth = 2;
    const cr = Math.min(w, h) * 0.1;
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, cr, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** ESA: dark blue field + white arc of stars */
  _paintESA(ctx, x, y, w, h) {
    ctx.fillStyle = '#003399';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#FFFFFF';
    const cx = x + w / 2;
    const cy = y + h / 2;
    const arcR = Math.min(w, h) * 0.3;
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI * 0.8 + (i / 7) * Math.PI * 0.6;
      const sx = cx + arcR * Math.cos(a);
      const sy = cy + arcR * Math.sin(a);
      this._drawStar(ctx, sx, sy, Math.min(w, h) * 0.04, 5);
    }
  }

  /** France: vertical tricolour blue/white/red */
  _paintFRA(ctx, x, y, w, h) {
    const sw = w / 3;
    ctx.fillStyle = '#002395'; ctx.fillRect(x, y, sw + 1, h);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x + sw, y, sw + 1, h);
    ctx.fillStyle = '#ED2939'; ctx.fillRect(x + sw * 2, y, sw + 1, h);
  }

  /** UK: simplified Union Jack */
  _paintGBR(ctx, x, y, w, h) {
    ctx.fillStyle = '#012169';
    ctx.fillRect(x, y, w, h);
    // White diagonal + cross
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(2, h * 0.12);
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
    ctx.stroke();
    ctx.lineWidth = Math.max(3, h * 0.18);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    // Red cross on top
    ctx.strokeStyle = '#C8102E';
    ctx.lineWidth = Math.max(1.5, h * 0.1);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
  }

  /** ISS: white field + "ISS" text in blue */
  _paintISS(ctx, x, y, w, h) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#003399';
    ctx.font = `bold ${Math.floor(h * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ISS', x + w / 2, y + h / 2);
  }

  /** Germany: horizontal tricolour black/red/gold */
  _paintDEU(ctx, x, y, w, h) {
    const sh = h / 3;
    ctx.fillStyle = '#000000'; ctx.fillRect(x, y, w, sh + 1);
    ctx.fillStyle = '#DD0000'; ctx.fillRect(x, y + sh, w, sh + 1);
    ctx.fillStyle = '#FFCC00'; ctx.fillRect(x, y + sh * 2, w, sh + 1);
  }

  /** Italy: vertical tricolour green/white/red */
  _paintITA(ctx, x, y, w, h) {
    const sw = w / 3;
    ctx.fillStyle = '#008C45'; ctx.fillRect(x, y, sw + 1, h);
    ctx.fillStyle = '#F4F5F0'; ctx.fillRect(x + sw, y, sw + 1, h);
    ctx.fillStyle = '#CD212A'; ctx.fillRect(x + sw * 2, y, sw + 1, h);
  }

  /** Canada: red bars + white centre + red maple leaf (simplified rectangle) */
  _paintCAN(ctx, x, y, w, h) {
    const barW = w * 0.25;
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(x, y, barW, h);
    ctx.fillRect(x + w - barW, y, barW, h);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x + barW, y, w - barW * 2, h);
    // Simplified maple leaf (red diamond)
    ctx.fillStyle = '#FF0000';
    const cx = x + w / 2;
    const cy = y + h / 2;
    const leafR = Math.min(w, h) * 0.18;
    ctx.beginPath();
    ctx.moveTo(cx, cy - leafR);
    ctx.lineTo(cx + leafR * 0.7, cy);
    ctx.lineTo(cx, cy + leafR);
    ctx.lineTo(cx - leafR * 0.7, cy);
    ctx.closePath();
    ctx.fill();
  }

  /** Brazil: green field + yellow diamond + blue circle */
  _paintBRA(ctx, x, y, w, h) {
    ctx.fillStyle = '#009C3B';
    ctx.fillRect(x, y, w, h);
    // Yellow diamond
    ctx.fillStyle = '#FFDF00';
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + h * 0.1);
    ctx.lineTo(x + w * 0.9, y + h / 2);
    ctx.lineTo(x + w / 2, y + h * 0.9);
    ctx.lineTo(x + w * 0.1, y + h / 2);
    ctx.closePath();
    ctx.fill();
    // Blue circle
    ctx.fillStyle = '#002776';
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Korea: white field + red/blue yin-yang circle */
  _paintKOR(ctx, x, y, w, h) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) * 0.22;
    // Red top half
    ctx.fillStyle = '#CD2E3A';
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.fill();
    // Blue bottom half
    ctx.fillStyle = '#0047A0';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI);
    ctx.fill();
  }

  /** Israel: white field + blue stripes + Star of David (hexagram) */
  _paintISR(ctx, x, y, w, h) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
    const stripeH = h * 0.12;
    ctx.fillStyle = '#0038B8';
    ctx.fillRect(x, y + h * 0.12, w, stripeH);
    ctx.fillRect(x, y + h - h * 0.12 - stripeH, w, stripeH);
    // Hexagram (two overlapping triangles)
    const cx = x + w / 2;
    const cy = y + h / 2;
    const sr = Math.min(w, h) * 0.15;
    ctx.strokeStyle = '#0038B8';
    ctx.lineWidth = 2;
    // Triangle up
    ctx.beginPath();
    ctx.moveTo(cx, cy - sr);
    ctx.lineTo(cx - sr * 0.866, cy + sr * 0.5);
    ctx.lineTo(cx + sr * 0.866, cy + sr * 0.5);
    ctx.closePath();
    ctx.stroke();
    // Triangle down
    ctx.beginPath();
    ctx.moveTo(cx, cy + sr);
    ctx.lineTo(cx - sr * 0.866, cy - sr * 0.5);
    ctx.lineTo(cx + sr * 0.866, cy - sr * 0.5);
    ctx.closePath();
    ctx.stroke();
  }

  /** Thailand (Trairanga): 5 horizontal bands red/white/blue/white/red (1:1:2:1:1) */
  _paintTHA(ctx, x, y, w, h) {
    const u = h / 6;                 // band unit
    ctx.fillStyle = '#A51931'; ctx.fillRect(x, y, w, u + 1);             // red top
    ctx.fillStyle = '#F4F5F8'; ctx.fillRect(x, y + u, w, u + 1);         // white
    ctx.fillStyle = '#2D2A4A'; ctx.fillRect(x, y + u * 2, w, u * 2 + 1); // blue (2u)
    ctx.fillStyle = '#F4F5F8'; ctx.fillRect(x, y + u * 4, w, u + 1);     // white
    ctx.fillStyle = '#A51931'; ctx.fillRect(x, y + u * 5, w, u + 1);     // red bottom
  }

  /** Spain: red/yellow/red horizontal bands (1:2:1) + simplified crest block */
  _paintESP(ctx, x, y, w, h) {
    const band = h / 4;
    ctx.fillStyle = '#AA151B'; ctx.fillRect(x, y, w, band + 1);              // red top
    ctx.fillStyle = '#F1BF00'; ctx.fillRect(x, y + band, w, band * 2 + 1);  // yellow (2u)
    ctx.fillStyle = '#AA151B'; ctx.fillRect(x, y + band * 3, w, band + 1);  // red bottom
    // Simplified coat-of-arms hint: a small red/gold shield on the hoist side
    const sw = w * 0.14;
    const sh = h * 0.34;
    const sx = x + w * 0.28 - sw / 2;
    const sy = y + h / 2 - sh / 2;
    ctx.fillStyle = '#AD1519';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.strokeStyle = '#C8961E';
    ctx.lineWidth = Math.max(1, w * 0.015);
    ctx.strokeRect(sx, sy, sw, sh);
  }

  /** Unknown: grey field + white "?" text */
  _paintUnknown(ctx, x, y, w, h) {
    ctx.fillStyle = '#888888';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.floor(h * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x + w / 2, y + h / 2);
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /** @private Draw a simple 5-pointed star */
  _drawStar(ctx, cx, cy, r, points) {
    const step = Math.PI / points;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + i * step;
      const radius = i % 2 === 0 ? r : r * 0.4;
      const px = cx + radius * Math.cos(a);
      const py = cy + radius * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
}

// ============================================================================
// CJS guard — expose pure helpers for Node.js tests
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FlagDecalSystem,
    getUVOffsetForCountry,
    hasFlag,
    COUNTRY_ORDER,
  };
}

export { COUNTRY_ORDER };
export default FlagDecalSystem;
