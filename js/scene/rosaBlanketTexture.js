/**
 * Procedural textures for the ROSA solar wings: 4 x 10 modules (250 x 200 mm) framed by orange Kapton tape,
 * thin string lines inside. One texture covers the whole 1.0 m wide (u) x 2.0 m long (v) blanket.
 * Colours are ESTIMATES from the look reference, not measurements.
 * Every getter returns null without a DOM (headless tests), like solarCellTexture.js.
 *
 * @module scene/rosaBlanketTexture
 */

import * as THREE from 'three';
import { getRosaBackTexture } from './solarCellTexture.js';

const PX_PER_M = 1024;                 // 1 px = about 1 mm across the width; the canvas is 1024 x 2048

/**
 * The module grid and palette (pure, also drives the drawing).
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

/** Seeded 0..1 noise: a texture is the same every run. */
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
      const j = rand(c + 1, r + 1);
      ctx.fillStyle = L.palette.cells[j > 0.5 ? 1 : 0];
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // hair gaps: 2 cells across, 5 along
      ctx.fillStyle = L.palette.gap;
      for (let k = 1; k < 5; k++) {
        const y = y0 + ((y1 - y0) * k) / 5;
        ctx.fillRect(x0, y - 0.5, x1 - x0, 1);
      }
      ctx.fillRect(x0 + (x1 - x0) / 2 - 0.5, y0, 1, y1 - y0);
      ctx.fillStyle = L.palette.string;
      for (let s = 1; s < L.stringsPerModule; s++) {
        const x = x0 + ((x1 - x0) * s) / L.stringsPerModule;
        ctx.fillRect(x - 0.5, y0, 1, y1 - y0);
      }
    }
  }
}

export function getRosaFrontTexture() {
  if (_cache.has('front')) return _cache.get('front');
  const c = makeCanvas(PX_PER_M, PX_PER_M * 2);
  if (!c) return null;
  drawModules(c.ctx, PX_PER_M, PX_PER_M * 2, 'color');
  const tex = finish(c.canvas, 'front');
  _cache.set('front', tex);
  return tex;
}

export function getRosaFrontEmissiveTexture() {
  if (_cache.has('frontEmissive')) return _cache.get('frontEmissive');
  const c = makeCanvas(PX_PER_M, PX_PER_M * 2);
  if (!c) return null;
  drawModules(c.ctx, PX_PER_M, PX_PER_M * 2, 'emissive');
  const tex = finish(c.canvas, 'frontEmissive');
  _cache.set('frontEmissive', tex);
  return tex;
}

/** Back side: copper-Kapton texture tiled 2 x 5 plus one cable-harness run near the outboard edge. Null when the base is null. */
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
  ctx.fillStyle = '#d3a56a'; ctx.fillRect(hx - 4, 0, 8, H);
  ctx.fillStyle = '#17100a'; ctx.fillRect(hx - 3, 0, 6, H);
  ctx.fillStyle = '#8a8a90';                                          // a clip every 250 mm
  for (let y = 125; y < H; y += 250) ctx.fillRect(hx - 8, y - 4, 16, 8);
  const tex = finish(c.canvas, 'back');
  _cache.set('back', tex);
  return tex;
}

/**
 * Furled-coil wrap marks: ten faint lighter bands running ACROSS the coil length (CylinderGeometry: u round, v along).
 * owner 2026-10-14: no gold stripes (jarring); the bands only hint at a wrap.
 */
export const ROSA_STOW_BAND_COLORS = Object.freeze({ base: '#2a2a33', band: '#3a3a46', bandFraction: 0.12 });

export function getRosaStowBandTexture() {
  if (_cache.has('bands')) return _cache.get('bands');
  const W = 32, H = 1024;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const { ctx } = c;
  const K = ROSA_STOW_BAND_COLORS;
  ctx.fillStyle = K.base; ctx.fillRect(0, 0, W, H);
  const bands = 10, pitch = H / bands, bw = pitch * K.bandFraction;
  ctx.fillStyle = K.band;
  for (let b = 0; b < bands; b++) ctx.fillRect(0, b * pitch + (pitch - bw) / 2, W, bw);
  const tex = finish(c.canvas, 'bands', { repeat: true });
  _cache.set('bands', tex);
  return tex;
}

export function _resetRosaBlanketTextureCache() {
  for (const t of _cache.values()) { if (t && t.dispose) t.dispose(); }
  _cache.clear();
}
