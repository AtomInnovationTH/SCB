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

  /** @private Debris: scratched/scorched grey metal panel with seams & a warning stencil */
  _paintDebris(ctx, x, y, w, h, rand) {
    // Base metal with a soft vertical lighting gradient
    const base = ctx.createLinearGradient(x, y, x, y + h);
    base.addColorStop(0, '#7a7a7e');
    base.addColorStop(0.5, '#636367');
    base.addColorStop(1, '#4e4e52');
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);

    // Large mottled discolouration patches (oxidation / sun-fade)
    for (let i = 0; i < 14; i++) {
      const px = x + rand() * w, py = y + rand() * h;
      const pr = w * (0.05 + rand() * 0.18);
      const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
      const shade = rand() > 0.5 ? '90,86,78' : '60,64,72';
      g.addColorStop(0, `rgba(${shade},0.30)`);
      g.addColorStop(1, `rgba(${shade},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    }

    // Panel seams (a couple of straight weld lines)
    ctx.strokeStyle = 'rgba(40,40,44,0.8)';
    ctx.lineWidth = Math.max(1, w * 0.004);
    for (let i = 0; i < 3; i++) {
      const sy = y + (0.25 + i * 0.25) * h + (rand() - 0.5) * h * 0.05;
      ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x + w, sy); ctx.stroke();
    }
    // Rivets along the seams
    ctx.fillStyle = 'rgba(150,150,156,0.7)';
    for (let i = 0; i < 3; i++) {
      const sy = y + (0.25 + i * 0.25) * h;
      for (let j = 0; j < 16; j++) {
        ctx.beginPath();
        ctx.arc(x + (j + 0.5) * (w / 16), sy, w * 0.003, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Scratches
    ctx.strokeStyle = 'rgba(200,200,205,0.25)';
    ctx.lineWidth = Math.max(1, w * 0.0015);
    for (let i = 0; i < 40; i++) {
      const sx = x + rand() * w, sy = y + rand() * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (rand() - 0.5) * w * 0.12, sy + (rand() - 0.5) * h * 0.04);
      ctx.stroke();
    }

    // Scorch / impact marks
    for (let i = 0; i < 6; i++) {
      const px = x + rand() * w, py = y + rand() * h;
      const pr = w * (0.02 + rand() * 0.05);
      const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
      g.addColorStop(0, 'rgba(15,12,10,0.85)');
      g.addColorStop(1, 'rgba(15,12,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }

    // Faded hazard stencil
    this._stencil(ctx, x + w * 0.1, y + h * 0.78, w * 0.22, h * 0.12, 'rgba(200,180,40,0.35)');
  }

  /** @private Rocket body: metallic silver hull, rivet bands, staging seam, scorch */
  _paintRocketBody(ctx, x, y, w, h, rand) {
    // Cylindrical shading — bright down the middle, dark at the edges
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, '#6c6c78');
    grad.addColorStop(0.25, '#b8b8c6');
    grad.addColorStop(0.5, '#d8d8e2');
    grad.addColorStop(0.75, '#a4a4b2');
    grad.addColorStop(1, '#62626e');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    // Brushed-metal vertical streaks
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 120; i++) {
      const sx = x + rand() * w;
      ctx.beginPath(); ctx.moveTo(sx, y); ctx.lineTo(sx, y + h); ctx.stroke();
    }

    // Rivet bands
    ctx.strokeStyle = 'rgba(90,90,105,0.8)';
    ctx.lineWidth = Math.max(1, h * 0.003);
    const bands = 10;
    for (let i = 1; i < bands; i++) {
      const ly = y + i * (h / bands);
      ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + w, ly); ctx.stroke();
      ctx.fillStyle = 'rgba(160,160,180,0.8)';
      for (let j = 0; j < 12; j++) {
        ctx.beginPath();
        ctx.arc(x + (j + 0.5) * (w / 12), ly, w * 0.0035, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Heavy staging seam
    ctx.strokeStyle = 'rgba(60,66,80,0.9)';
    ctx.lineWidth = Math.max(2, h * 0.012);
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.62); ctx.lineTo(x + w, y + h * 0.62); ctx.stroke();

    // Scorching near the engine end
    const sg = ctx.createLinearGradient(x, y + h, x, y + h * 0.7);
    sg.addColorStop(0, 'rgba(20,16,14,0.6)');
    sg.addColorStop(1, 'rgba(20,16,14,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(x, y + h * 0.7, w, h * 0.3);

    // Agency stencil band
    this._stencil(ctx, x + w * 0.12, y + h * 0.30, w * 0.3, h * 0.1, 'rgba(40,60,120,0.5)');
  }

  /** @private Inactive: dark-blue solar array with cells, busbars, MLI gold foil */
  _paintInactive(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#1f2a55';
    ctx.fillRect(x, y, w, h);

    // Individual solar cells with subtle per-cell shading
    const cols = 12, rows = 12;
    const cw = w / cols, ch = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + c * cw, cy = y + r * ch;
        const tint = 30 + Math.floor(rand() * 40);
        ctx.fillStyle = `rgb(${tint},${tint + 10},${tint + 70})`;
        ctx.fillRect(cx + cw * 0.06, cy + ch * 0.06, cw * 0.88, ch * 0.88);
        // diagonal specular sheen on some cells
        if (rand() > 0.7) {
          ctx.fillStyle = 'rgba(120,150,255,0.18)';
          ctx.fillRect(cx + cw * 0.06, cy + ch * 0.06, cw * 0.88, ch * 0.25);
        }
      }
    }

    // Silver busbar gridlines
    ctx.strokeStyle = 'rgba(180,190,210,0.5)';
    ctx.lineWidth = Math.max(1, w * 0.0025);
    for (let i = 0; i <= cols; i++) {
      ctx.beginPath(); ctx.moveTo(x + i * cw, y); ctx.lineTo(x + i * cw, y + h); ctx.stroke();
    }
    for (let i = 0; i <= rows; i++) {
      ctx.beginPath(); ctx.moveTo(x, y + i * ch); ctx.lineTo(x + w, y + i * ch); ctx.stroke();
    }

    // Crinkled gold MLI foil patches
    for (let i = 0; i < 5; i++) {
      const fx = x + rand() * w * 0.7, fy = y + rand() * h * 0.7;
      const fw = w * (0.1 + rand() * 0.2), fh = h * (0.1 + rand() * 0.2);
      const g = ctx.createLinearGradient(fx, fy, fx + fw, fy + fh);
      g.addColorStop(0, 'rgba(220,180,70,0.55)');
      g.addColorStop(0.5, 'rgba(255,215,110,0.65)');
      g.addColorStop(1, 'rgba(180,140,40,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(fx, fy, fw, fh);
      // foil crinkle lines
      ctx.strokeStyle = 'rgba(120,90,20,0.4)';
      ctx.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        ctx.moveTo(fx + rand() * fw, fy);
        ctx.lineTo(fx + rand() * fw, fy + fh);
        ctx.stroke();
      }
    }
  }

  /** @private Active: clean white spacecraft skin, reflective highlight, labels */
  _paintActive(ctx, x, y, w, h, rand) {
    const base = ctx.createLinearGradient(x, y, x, y + h);
    base.addColorStop(0, '#f4f4fb');
    base.addColorStop(1, '#d8d8e6');
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);

    // Big soft reflective highlight
    const cx = x + w * 0.4, cy = y + h * 0.3;
    const gradR = Math.min(w, h) * 0.5;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, gradR);
    grad.addColorStop(0, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(238,238,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, gradR, 0, Math.PI * 2); ctx.fill();

    // Panel seams
    ctx.strokeStyle = 'rgba(170,170,200,0.6)';
    ctx.lineWidth = Math.max(1, w * 0.002);
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(x, y + i * h / 4); ctx.lineTo(x + w, y + i * h / 4); ctx.stroke();
    }
    // Black thermal radiator strip
    ctx.fillStyle = 'rgba(20,20,28,0.85)';
    ctx.fillRect(x + w * 0.62, y + h * 0.1, w * 0.12, h * 0.55);
    // Antenna stub
    ctx.strokeStyle = '#9999bb';
    ctx.lineWidth = Math.max(2, w * 0.005);
    ctx.beginPath(); ctx.moveTo(x + w * 0.2, y + h * 0.15); ctx.lineTo(x + w * 0.2, y + h * 0.45); ctx.stroke();
    // Caution stencil
    this._stencil(ctx, x + w * 0.1, y + h * 0.8, w * 0.25, h * 0.1, 'rgba(200,40,40,0.45)');
  }

  /** @private Unknown: pitted brown/charred surface, dents and cracks */
  _paintUnknown(ctx, x, y, w, h, rand) {
    const base = ctx.createLinearGradient(x, y, x, y + h);
    base.addColorStop(0, '#6f5c46');
    base.addColorStop(1, '#4a3c2c');
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);

    // Pitting / craters
    for (let i = 0; i < 80; i++) {
      const px = x + rand() * w, py = y + rand() * h;
      const pr = w * (0.004 + rand() * 0.02);
      const g = ctx.createRadialGradient(px - pr * 0.3, py - pr * 0.3, 0, px, py, pr);
      g.addColorStop(0, rand() > 0.5 ? 'rgba(120,104,80,0.8)' : 'rgba(50,40,28,0.8)');
      g.addColorStop(1, 'rgba(60,48,34,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }
    // Cracks
    ctx.strokeStyle = 'rgba(25,18,12,0.7)';
    ctx.lineWidth = Math.max(1, w * 0.002);
    for (let i = 0; i < 5; i++) {
      let px = x + rand() * w, py = y + rand() * h;
      ctx.beginPath(); ctx.moveTo(px, py);
      for (let s = 0; s < 6; s++) {
        px += (rand() - 0.5) * w * 0.08; py += (rand() - 0.5) * h * 0.08;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  /** @private Fragment: dark torn metal — bright fracture edges + soot */
  _paintFragment(ctx, x, y, w, h, rand) {
    ctx.fillStyle = '#2c2c30';
    ctx.fillRect(x, y, w, h);
    // Coarse metal noise
    const step = Math.max(2, Math.floor(w / 256));
    for (let px = x; px < x + w; px += step) {
      for (let py = y; py < y + h; py += step) {
        const v = Math.floor(28 + rand() * 38);
        ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
        ctx.fillRect(px, py, step, step);
      }
    }
    // Bright torn fracture edges (exposed bare metal)
    ctx.strokeStyle = 'rgba(210,210,220,0.55)';
    ctx.lineWidth = Math.max(1, w * 0.003);
    for (let i = 0; i < 10; i++) {
      let px = x + rand() * w, py = y + rand() * h;
      ctx.beginPath(); ctx.moveTo(px, py);
      for (let s = 0; s < 4; s++) {
        px += (rand() - 0.5) * w * 0.15; py += (rand() - 0.5) * h * 0.15;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // Soot blotches
    for (let i = 0; i < 8; i++) {
      const px = x + rand() * w, py = y + rand() * h;
      const pr = w * (0.03 + rand() * 0.07);
      const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
      g.addColorStop(0, 'rgba(0,0,0,0.7)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** @private Draw a faint rectangular stencil block (mimics a painted label) */
  _stencil(ctx, x, y, w, h, color) {
    ctx.save();
    ctx.fillStyle = color;
    // a few "characters" as bars
    const n = 4;
    const cw = w / (n * 1.6);
    for (let i = 0; i < n; i++) {
      ctx.fillRect(x + i * cw * 1.6, y, cw, h);
    }
    ctx.restore();
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
