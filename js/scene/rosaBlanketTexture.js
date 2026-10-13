/**
 * rosaBlanketTexture.js - procedural textures for the ROSA solar wings (v3-wings-look D1/D2/D4).
 *
 * Real ROSA blankets are not a field of identical tiles: the cells are laid in MODULES, each module framed by
 * orange Kapton (polyimide) tape lines, with thin string lines inside. Colours are ESTIMATES from the look
 * reference (brown-black cells #1B1210...#2A1A14, orange Kapton #D98A1E), not measurements.
 *
 * One texture covers the WHOLE blanket (1.0 m wide x 2.0 m long: u across the width, v along the length), so the
 * module grid is real-size: 4 columns x 10 rows = 250 mm x 200 mm modules.
 *
 *  - `rosaBlanketLayout()`            pure data: pitches, line positions, palette (also drives the drawing)
 *  - `getRosaFrontTexture()`          colour map of the sun-facing side
 *  - `getRosaFrontEmissiveTexture()`  cell interiors only (white) so the power glow tints cells, not the tape
 *  - `getRosaBackHarnessTexture()`    the existing copper-Kapton back map tiled over the blanket + one harness run
 *  - `getRosaStowBandTexture()`       yellow-gold wrap bands for the furled coil
 *
 * Every getter returns null without a DOM (headless tests), like solarCellTexture.js.
 *
 * @module scene/rosaBlanketTexture
 */

import * as THREE from 'three';
import { getRosaBackTexture } from './solarCellTexture.js';

const PX_PER_M = 1024;                 // 1 px = about 1 mm across the width; the canvas is 1024 x 2048

/**
 * The module grid and palette. Pure: no DOM, no THREE.
 * @returns {{widthM:number,lengthM:number,columns:number,rows:number,columnPitchM:number,crosswisePitchM:number,
 *   lineWidthM:number,lengthwiseLines:number[],crosswiseLines:number[],stringsPerModule:number,
 *   palette:{cells:string[],line:string,string:string,gap:string}}}
 */
export function rosaBlanketLayout() {
  const widthM = 1.0, lengthM = 2.0, columns = 4, rows = 10;
  const columnPitchM = widthM / columns;      // 250 mm across the blanket
  const crosswisePitchM = lengthM / rows;     // 200 mm along it (the pitch of the lines that cross the length)
  const lengthwiseLines = [];                 // x positions (m from the inboard edge) of the interior lengthwise lines
  for (let c = 1; c < columns; c++) lengthwiseLines.push(c * columnPitchM);
  const crosswiseLines = [];                  // y positions (m from the top edge) of the interior crosswise lines
  for (let r = 1; r < rows; r++) crosswiseLines.push(r * crosswisePitchM);
  return {
    widthM, lengthM, columns, rows, columnPitchM, crosswisePitchM,
    lineWidthM: 0.006,
    lengthwiseLines, crosswiseLines,
    stringsPerModule: 6,
    palette: {
      cells: ['#1B1210', '#2A1A14'],
      line: '#D98A1E',
      string: '#3B2A22',
      gap: '#0E0A09',
    },
  };
}

const _cache = new Map();

/** Seeded 0..1 noise, so a texture is the same every run. */
function rand(a, b) {
  const s = Math.sin(a * 91.7 + b * 47.31) * 43758.5453;
  return s - Math.floor(s);
}

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  if (typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function finish(canvas, tag, { repeat = false } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; }
  tex.anisotropy = 8;
  tex.userData.rosaBlanket = tag;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draw every module. `mode` 'color' paints cells, strings and tape; 'emissive' paints cell interiors white on black.
 */
function drawModules(ctx, W, H, mode) {
  const L = rosaBlanketLayout();
  const lineW = Math.max(2, Math.round(L.lineWidthM * PX_PER_M));
  const mw = W / L.columns, mh = H / L.rows;
  if (mode === 'color') { ctx.fillStyle = L.palette.line; } else { ctx.fillStyle = '#000000'; }
  ctx.fillRect(0, 0, W, H);                           // the tape between and around the modules
  const half = lineW / 2;
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.columns; c++) {
      const x0 = c * mw + (c === 0 ? lineW : half), x1 = (c + 1) * mw - (c === L.columns - 1 ? lineW : half);
      const y0 = r * mh + (r === 0 ? lineW : half), y1 = (r + 1) * mh - (r === L.rows - 1 ? lineW : half);
      if (mode === 'emissive') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        continue;
      }
      // cell colour: one of the two browns per module, plus a small per-module value shift
      const j = rand(c + 1, r + 1);
      ctx.fillStyle = L.palette.cells[j > 0.5 ? 1 : 0];
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // cell-to-cell hair gaps: 2 cells across, 5 along
      ctx.fillStyle = L.palette.gap;
      for (let k = 1; k < 5; k++) {
        const y = y0 + ((y1 - y0) * k) / 5;
        ctx.fillRect(x0, y - 0.5, x1 - x0, 1);
      }
      ctx.fillRect(x0 + (x1 - x0) / 2 - 0.5, y0, 1, y1 - y0);
      // thin string lines (lengthwise), lighter than the cell
      ctx.fillStyle = L.palette.string;
      for (let s = 1; s < L.stringsPerModule; s++) {
        const x = x0 + ((x1 - x0) * s) / L.stringsPerModule;
        ctx.fillRect(x - 0.5, y0, 1, y1 - y0);
      }
    }
  }
}

/** Colour map of the sun-facing side (cached). */
export function getRosaFrontTexture() {
  if (_cache.has('front')) return _cache.get('front');
  const c = makeCanvas(PX_PER_M, PX_PER_M * 2);
  if (!c) return null;
  drawModules(c.ctx, PX_PER_M, PX_PER_M * 2, 'color');
  const tex = finish(c.canvas, 'front');
  _cache.set('front', tex);
  return tex;
}

/** Emissive map: cell interiors only (cached). */
export function getRosaFrontEmissiveTexture() {
  if (_cache.has('frontEmissive')) return _cache.get('frontEmissive');
  const c = makeCanvas(PX_PER_M, PX_PER_M * 2);
  if (!c) return null;
  drawModules(c.ctx, PX_PER_M, PX_PER_M * 2, 'emissive');
  const tex = finish(c.canvas, 'frontEmissive');
  _cache.set('frontEmissive', tex);
  return tex;
}

/**
 * Back side: the shared copper-Kapton texture tiled 2 x 5 over the blanket, plus ONE cable-harness run
 * (dark cable, lighter edge, a clip every 250 mm) near the outboard edge. Null when the base texture is null.
 */
export function getRosaBackHarnessTexture() {
  if (_cache.has('back')) return _cache.get('back');
  const base = getRosaBackTexture();
  if (!base || !base.image) return null;
  const W = PX_PER_M, H = PX_PER_M * 2;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const { ctx } = c;
  const tw = W / 2, th = H / 5;
  for (let ty = 0; ty < 5; ty++) for (let tx = 0; tx < 2; tx++) ctx.drawImage(base.image, tx * tw, ty * th, tw, th);
  const hx = Math.round(W * 0.88);
  ctx.fillStyle = '#d3a56a'; ctx.fillRect(hx - 4, 0, 8, H);          // edge highlight
  ctx.fillStyle = '#17100a'; ctx.fillRect(hx - 3, 0, 6, H);          // the cable
  ctx.fillStyle = '#8a8a90';                                          // a clip every 250 mm
  for (let y = 125; y < H; y += 250) ctx.fillRect(hx - 8, y - 4, 16, 8);
  const tex = finish(c.canvas, 'back');
  _cache.set('back', tex);
  return tex;
}

/**
 * Wrap bands for the furled coil: about ten yellow-gold Kapton bands on a grey base, running ACROSS the coil length
 * (CylinderGeometry: u round, v along). Cached.
 */
export function getRosaStowBandTexture() {
  if (_cache.has('bands')) return _cache.get('bands');
  const W = 32, H = 1024;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const { ctx } = c;
  ctx.fillStyle = '#4a4a52'; ctx.fillRect(0, 0, W, H);
  const bands = 10, pitch = H / bands, bw = pitch * 0.42;
  ctx.fillStyle = '#C9A227';
  for (let b = 0; b < bands; b++) ctx.fillRect(0, b * pitch + (pitch - bw) / 2, W, bw);
  const tex = finish(c.canvas, 'bands', { repeat: true });
  _cache.set('bands', tex);
  return tex;
}

/** Test/teardown hook - drop every cached texture. */
export function _resetRosaBlanketTextureCache() {
  for (const t of _cache.values()) { if (t && t.dispose) t.dispose(); }
  _cache.clear();
}
