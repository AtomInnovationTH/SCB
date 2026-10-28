/**
 * Shared procedural solar-cell texture: tileable near-black triple-junction GaAs cells (Dawn/Juno look) on a
 * dark substrate with silver gridlines and busbars. Real arrays cover ~100% of the face with dark cells, so
 * the substrate is dark, not a bright wireframe. `map`/`emissiveMap` of the flat body-mounted PV sub-panels.
 *
 * @module scene/solarCellTexture
 */

import * as THREE from 'three';

const _cache = new Map();

/**
 * @param {object} [opts]
 * @param {number} [opts.size=512]   — canvas pixel dimension (power of two)
 * @param {number} [opts.cols=4]     — cell columns within the tile
 * @param {number} [opts.rows=8]     — cell rows within the tile (cells are tall)
 * @returns {THREE.CanvasTexture|null}  null in headless/no-DOM environments
 */
export function getSolarCellTexture(opts = {}) {
  const size = opts.size || 512;
  const cols = opts.cols || 4;
  const rows = opts.rows || 8;
  const key = `${size}:${cols}:${rows}`;
  if (_cache.has(key)) return _cache.get(key);
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  if (typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, size, size);

  const cw = size / cols;
  const ch = size / rows;          // cells are taller than wide
  const gap = Math.max(1, Math.round(Math.min(cw, ch) * 0.05));
  const fingerW = Math.max(1, Math.round(cw * 0.02));
  const busW = Math.max(1, Math.round(cw * 0.05));

  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cw + gap;
      const y = ry * ch + gap;
      const w = cw - gap * 2;
      const h = ch - gap * 2;

      // per-cell tone jitter; very dark blue-violet
      const j = Math.abs((Math.sin(cx * 12.9898 + ry * 78.233) * 43758.5453) % 1);
      const jitter = Math.floor(j * 10) - 5; // ±5
      const r = 20 + jitter;
      const g = 22 + jitter;
      const b = 46 + jitter;

      // faint AR-coating sheen, still dark
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0.0, `rgb(${r + 14}, ${g + 16}, ${b + 34})`);
      grad.addColorStop(0.5, `rgb(${r}, ${g}, ${b})`);
      grad.addColorStop(1.0, `rgb(${Math.max(0, r - 6)}, ${Math.max(0, g - 6)}, ${Math.max(0, b - 14)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);

      ctx.strokeStyle = 'rgba(150, 165, 195, 0.22)';
      ctx.lineWidth = fingerW;
      const fingers = 8;
      for (let f = 1; f < fingers; f++) {
        const fx = x + (w * f) / fingers;
        ctx.beginPath();
        ctx.moveTo(fx, y);
        ctx.lineTo(fx, y + h);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(190, 205, 235, 0.45)';
      ctx.lineWidth = busW;
      for (let bbar = 1; bbar <= 2; bbar++) {
        const bx = x + (w * bbar) / 3;
        ctx.beginPath();
        ctx.moveTo(bx, y);
        ctx.lineTo(bx, y + h);
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _cache.set(key, tex);
  return tex;
}

export function _resetSolarCellTextureCache() {
  for (const t of _cache.values()) { if (t && t.dispose) t.dispose(); }
  _cache.clear();
}

const _rosaBackCache = new Map();

/**
 * Tileable ROSA wing BACKSIDE texture: amber-brown copper-Kapton with bay seams, lighter stiffener strips along
 * the length (Y), faint wiring runs and per-bay value jitter. Multiplies under a white material tint (hue mostly
 * from the map). Same conventions as getSolarCellTexture; also has a `_resetRosaBackTextureCache()` hook.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=512]   — canvas pixel dimension (power of two)
 * @param {number} [opts.baysX=2]    — seam-bay columns within the tile
 * @param {number} [opts.baysY=5]    — seam-bay rows within the tile (bays run along length)
 * @returns {THREE.CanvasTexture|null}  null in headless/no-DOM environments
 */
export function getRosaBackTexture(opts = {}) {
  const size = opts.size || 512;
  const baysX = opts.baysX || 2;
  const baysY = opts.baysY || 5;
  const key = `${size}:${baysX}:${baysY}`;
  if (_rosaBackCache.has(key)) return _rosaBackCache.get(key);
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  if (typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rand = (a, b) => {
    const s = Math.sin(a * 91.7 + b * 47.31) * 43758.5453;
    return s - Math.floor(s);
  };

  ctx.fillStyle = '#7a4f26';
  ctx.fillRect(0, 0, size, size);

  const bw = size / baysX;
  const bh = size / baysY;

  for (let by = 0; by < baysY; by++) {
    for (let bx = 0; bx < baysX; bx++) {
      const j = rand(bx + 1, by + 1);
      const f = 1 + (j - 0.5) * 0.08;   // ±4%
      const r = Math.round(0x7a * f), g = Math.round(0x4f * f), b = Math.round(0x26 * f);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(bx * bw, by * bh, bw, bh);
    }
  }

  ctx.strokeStyle = 'rgba(40, 26, 12, 0.75)';
  ctx.lineWidth = Math.max(1, Math.round(size * 0.006));
  for (let bx = 1; bx < baysX; bx++) {
    const x = bx * bw;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
  }
  for (let by = 1; by < baysY; by++) {
    const y = by * bh;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
  }

  const strips = 3;
  const stripW = Math.max(2, Math.round(size * 0.018));
  ctx.fillStyle = 'rgba(168, 122, 66, 0.55)';
  for (let sIdx = 1; sIdx <= strips; sIdx++) {
    const sx = (size * sIdx) / (strips + 1) - stripW / 2;
    ctx.fillRect(sx, 0, stripW, size);
  }

  ctx.strokeStyle = 'rgba(30, 20, 10, 0.45)';
  ctx.lineWidth = Math.max(1, Math.round(size * 0.004));
  const wires = 4;
  for (let w = 0; w < wires; w++) {
    const x0 = rand(w + 3, 1) * size;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    const midX = x0 + (rand(w + 3, 2) - 0.5) * size * 0.4;
    ctx.lineTo(midX, size * 0.5);
    ctx.lineTo(x0 + (rand(w + 3, 3) - 0.5) * size * 0.3, size);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _rosaBackCache.set(key, tex);
  return tex;
}

export function _resetRosaBackTextureCache() {
  for (const t of _rosaBackCache.values()) { if (t && t.dispose) t.dispose(); }
  _rosaBackCache.clear();
}
