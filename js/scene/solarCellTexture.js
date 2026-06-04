/**
 * solarCellTexture.js — Shared procedural solar-cell (photovoltaic) texture.
 *
 * Generates a tileable CanvasTexture that reads as a real spacecraft PV panel:
 * a dense grid of near-black triple-junction GaAs cells (the "black-light test"
 * look of Dawn/Juno arrays), close-packed with hair-thin silver interconnect
 * gridlines and 2–3 thin busbars per cell. Real space arrays cover ~100% of the
 * sun-facing area with dark rectangular cells — NOT a sparse blue wireframe on a
 * bright substrate — so the substrate here is dark and the cells dominate.
 *
 * Used as the `map`/`emissiveMap` of flat body-mounted PV sub-panels (mother
 * barrel + daughter) so the cell pattern lives on the panel surface itself.
 *
 * @module scene/solarCellTexture
 */

import * as THREE from 'three';

/** Cached textures keyed by cell-grid resolution. */
const _cache = new Map();

/**
 * Build (or return a cached) tileable solar-cell texture.
 *
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

  // Dark interconnect substrate (Kapton/adhesive seen in the hairline gaps).
  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, size, size);

  const cw = size / cols;          // cell pixel width
  const ch = size / rows;          // cell pixel height (cells are taller than wide)
  const gap = Math.max(1, Math.round(Math.min(cw, ch) * 0.05)); // hairline interconnect gap
  const fingerW = Math.max(1, Math.round(cw * 0.02));
  const busW = Math.max(1, Math.round(cw * 0.05));

  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cw + gap;
      const y = ry * ch + gap;
      const w = cw - gap * 2;
      const h = ch - gap * 2;

      // Per-cell tone jitter (manufacturing/illumination variance). Cells are
      // very dark blue-violet — triple-junction GaAs reads near-black.
      const j = Math.abs((Math.sin(cx * 12.9898 + ry * 78.233) * 43758.5453) % 1);
      const jitter = Math.floor(j * 10) - 5; // ±5
      const r = 20 + jitter;
      const g = 22 + jitter;
      const b = 46 + jitter;

      // Diagonal gradient → faint glassy AR-coating sheen, still dark.
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0.0, `rgb(${r + 14}, ${g + 16}, ${b + 34})`);
      grad.addColorStop(0.5, `rgb(${r}, ${g}, ${b})`);
      grad.addColorStop(1.0, `rgb(${Math.max(0, r - 6)}, ${Math.max(0, g - 6)}, ${Math.max(0, b - 14)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);

      // Hair-thin vertical finger conductors (many, faint silver).
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

      // Two thin vertical busbars (brighter silver) — the cell's main collectors.
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

/** Test/teardown hook — drop all cached textures. */
export function _resetSolarCellTextureCache() {
  for (const t of _cache.values()) { if (t && t.dispose) t.dispose(); }
  _cache.clear();
}
