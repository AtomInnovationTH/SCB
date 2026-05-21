/**
 * DebrisTextureAtlas.js — Procedural Canvas2D texture atlas for debris type visuals
 * Generates a single atlas texture with 6 type-differentiated debris appearances.
 * No external image files — all Canvas2D procedural painting.
 *
 * ST-6.2: Phase 2 debris visuals.
 * @module ui/DebrisTextureAtlas
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

// ============================================================================
// TYPE CONFIGURATION (pure logic — Node-safe)
// ============================================================================

/** Ordered list of catalogType values; index = slot position in atlas */
const TYPE_ORDER = ['debris', 'rocket_body', 'inactive', 'active', 'unknown', 'fragment'];

/**
 * Map catalogType → { slot index, hex colour from Constants }.
 * @param {string} catalogType
 * @returns {{ slot: number, color: string }}
 */
function _typeConfig(catalogType) {
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const colorMap = {
    debris:      C.COLOR_DEBRIS      || '#666666',
    rocket_body: C.COLOR_ROCKET_BODY || '#aaaabb',
    inactive:    C.COLOR_INACTIVE    || '#333366',
    active:      C.COLOR_ACTIVE      || '#eeeeff',
    unknown:     C.COLOR_UNKNOWN     || '#665544',
    fragment:    C.COLOR_FRAGMENT    || '#333333',
  };
  const idx = TYPE_ORDER.indexOf(catalogType);
  const slot = idx >= 0 ? idx : TYPE_ORDER.indexOf('unknown');
  return { slot, color: colorMap[catalogType] || colorMap.unknown };
}

// ============================================================================
// PURE-LOGIC EXPORTS (Node-safe — no Canvas/THREE dependency)
// ============================================================================

/**
 * Compute UV offset + scale for a catalogue type slot in the atlas grid.
 * UV (0,0) = bottom-left, UV (1,1) = top-right (WebGL convention).
 * Canvas row 0 = top of image = UV V=1.
 *
 * @param {string} catalogType — one of TYPE_ORDER values
 * @param {number} [cols] — grid columns (default: Constants or 3)
 * @param {number} [rows] — grid rows (default: Constants or 2)
 * @returns {{ offsetU: number, offsetV: number, scaleU: number, scaleV: number }}
 */
export function getUVOffsetForType(catalogType, cols, rows) {
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const c = cols || C.TYPE_SLOT_COLS || 3;
  const r = rows || C.TYPE_SLOT_ROWS || 2;
  const { slot } = _typeConfig(catalogType);
  const col = slot % c;
  const row = Math.floor(slot / c);
  return {
    offsetU: col / c,
    offsetV: 1 - (row + 1) / r,
    scaleU: 1 / c,
    scaleV: 1 / r,
  };
}

/**
 * Get the base colour hex string for a catalogue type.
 * Falls back to COLOR_UNKNOWN for unrecognised types.
 * @param {string} catalogType
 * @returns {string} hex colour string e.g. '#666666'
 */
export function getBaseColorForType(catalogType) {
  return _typeConfig(catalogType).color;
}

/**
 * Return the MOID-based emissive parameters for a debris piece.
 * @param {string|null} moidBadge — 'HI', 'MD', 'LO', or null
 * @returns {{ color: string, intensity: number }}
 */
export function getEmissiveForMOID(moidBadge) {
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const CONJ = (typeof Constants !== 'undefined' && Constants.CONJUNCTION) || {};
  if (moidBadge === 'HI') {
    return {
      color: CONJ.BADGE_COLOR_HI || '#ff3344',
      intensity: C.EMISSIVE_HI_INTENSITY || 0.3,
    };
  }
  if (moidBadge === 'MD') {
    return {
      color: CONJ.BADGE_COLOR_MD || '#ddcc00',
      intensity: C.EMISSIVE_MD_INTENSITY || 0.15,
    };
  }
  return { color: '#000000', intensity: 0 };
}

// ============================================================================
// SEEDED PRNG (deterministic painting)
// ============================================================================

/** @private Simple multiplicative congruential PRNG for reproducible painting */
function _seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ============================================================================
// CANVAS2D ATLAS CLASS (browser-only — generate() uses Canvas2D + THREE)
// ============================================================================

/**
 * Procedural Canvas2D texture atlas for 6 debris type visuals.
 * Generates a single THREE.CanvasTexture at boot; not per-frame.
 */
export class DebrisTextureAtlas {
  /**
   * @param {number} [atlasSize] — pixel dimension (default from Constants)
   */
  constructor(atlasSize) {
    const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
    this._size = atlasSize || C.ATLAS_SIZE || 1024;
    this._cols = C.TYPE_SLOT_COLS || 3;
    this._rows = C.TYPE_SLOT_ROWS || 2;
    /** @type {HTMLCanvasElement|null} */
    this._canvas = null;
    /** @type {THREE.CanvasTexture|null} */
    this.texture = null;
  }

  /**
   * Paint the atlas and return a THREE.CanvasTexture.
   * Requires browser DOM (Canvas2D) + THREE.js.
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

    // Paint each type slot
    for (let i = 0; i < TYPE_ORDER.length; i++) {
      const type = TYPE_ORDER[i];
      const col = i % this._cols;
      const row = Math.floor(i / this._cols);
      const x = col * slotW;
      const y = row * slotH;
      this._paintSlot(ctx, type, x, y, slotW, slotH, i);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = tex;
    return tex;
  }

  /** Get UV offset for a type (delegates to pure function) */
  getUVOffsetForType(catalogType) {
    return getUVOffsetForType(catalogType, this._cols, this._rows);
  }

  /** Get base colour for a type (delegates to pure function) */
  getBaseColorForType(catalogType) {
    return getBaseColorForType(catalogType);
  }

  /** Release canvas + texture GPU memory */
  dispose() {
    if (this.texture && this.texture.dispose) this.texture.dispose();
    this.texture = null;
    this._canvas = null;
  }

  // --------------------------------------------------------------------------
  // Painting helpers (private)
  // --------------------------------------------------------------------------

  /** @private Paint one type slot */
  _paintSlot(ctx, type, x, y, w, h, seed) {
    const rand = _seededRandom(seed * 7919 + 42);
    switch (type) {
      case 'debris':      this._paintDebris(ctx, x, y, w, h, rand); break;
      case 'rocket_body': this._paintRocketBody(ctx, x, y, w, h, rand); break;
      case 'inactive':    this._paintInactive(ctx, x, y, w, h, rand); break;
      case 'active':      this._paintActive(ctx, x, y, w, h, rand); break;
      case 'unknown':     this._paintUnknown(ctx, x, y, w, h, rand); break;
      case 'fragment':    this._paintFragment(ctx, x, y, w, h, rand); break;
      default:            this._paintUnknown(ctx, x, y, w, h, rand); break;
    }
  }

  /** @private Debris: dark grey, scratch marks, micro-dents */
  _paintDebris(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#666666';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 1;
    for (let i = 0; i < 20; i++) {
      const sx = x + rand() * w;
      const sy = y + rand() * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (rand() - 0.5) * 40, sy + (rand() - 0.5) * 12);
      ctx.stroke();
    }
    ctx.fillStyle = '#555555';
    for (let i = 0; i < 25; i++) {
      const dx = x + rand() * w;
      const dy = y + rand() * h;
      const r = 1 + rand() * 4;
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** @private Rocket body: metallic silver, rivet lines, staging seam */
  _paintRocketBody(ctx, x, y, w, h, rand) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, '#888899');
    grad.addColorStop(0.3, '#ccccdd');
    grad.addColorStop(0.5, '#aaaabb');
    grad.addColorStop(0.7, '#ccccdd');
    grad.addColorStop(1, '#888899');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#777788';
    ctx.lineWidth = 1;
    const rivetSpacing = h / 8;
    for (let i = 1; i < 8; i++) {
      const ly = y + i * rivetSpacing;
      ctx.beginPath();
      ctx.moveTo(x, ly);
      ctx.lineTo(x + w, ly);
      ctx.stroke();
      ctx.fillStyle = '#999aab';
      for (let j = 0; j < 6; j++) {
        ctx.beginPath();
        ctx.arc(x + (j + 0.5) * (w / 6), ly, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.strokeStyle = '#556677';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.6);
    ctx.lineTo(x + w, y + h * 0.6);
    ctx.stroke();
  }

  /** @private Inactive: dark blue, solar cell grid, gold foil patches */
  _paintInactive(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#333366';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#444488';
    ctx.lineWidth = 1;
    const cellW = w / 10;
    const cellH = h / 10;
    for (let i = 0; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * cellW, y);
      ctx.lineTo(x + i * cellW, y + h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y + i * cellH);
      ctx.lineTo(x + w, y + i * cellH);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200, 170, 50, 0.4)';
    for (let i = 0; i < 5; i++) {
      const fx = x + rand() * w * 0.8;
      const fy = y + rand() * h * 0.8;
      ctx.fillRect(fx, fy, 15 + rand() * 30, 15 + rand() * 30);
    }
  }

  /** @private Active: clean white, reflective highlight, antenna stub */
  _paintActive(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#eeeeff';
    ctx.fillRect(x, y, w, h);
    const cx = x + w * 0.4;
    const cy = y + h * 0.3;
    const gradR = Math.min(w, h) * 0.35;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, gradR);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(238,238,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, gradR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#aaaacc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.7, y + h * 0.1);
    ctx.lineTo(x + w * 0.7, y + h * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w * 0.7, y + h * 0.1, 8, 0, Math.PI, true);
    ctx.stroke();
    ctx.strokeStyle = '#ccccdd';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.5);
    ctx.lineTo(x + w, y + h * 0.5);
    ctx.stroke();
  }

  /** @private Unknown: brown, pitted surface */
  _paintUnknown(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#665544';
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 30; i++) {
      const px = x + rand() * w;
      const py = y + rand() * h;
      const pr = 2 + rand() * 6;
      ctx.fillStyle = rand() > 0.5 ? '#554433' : '#776655';
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#443322';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
  }

  /** @private Fragment: near-black, random noise */
  _paintFragment(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#333333';
    ctx.fillRect(x, y, w, h);
    const step = 4;
    for (let px = x; px < x + w; px += step) {
      for (let py = y; py < y + h; py += step) {
        const v = Math.floor(30 + rand() * 30);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(px, py, step, step);
      }
    }
  }
}

// ============================================================================
// CJS guard — expose pure helpers for Node.js tests
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DebrisTextureAtlas,
    getUVOffsetForType,
    getBaseColorForType,
    getEmissiveForMOID,
    TYPE_ORDER,
  };
}

export { TYPE_ORDER };
export default DebrisTextureAtlas;
