/**
 * labelTexture.js — Shared canvas → CanvasTexture helper for in-world text labels.
 *
 * Extracted so the planet/constellation labels (SunLight.js) and the mothership
 * inspection callouts (ui/MotherCallouts.js) share one crisp-text recipe instead
 * of duplicating the canvas/mipmap/colour-space setup.
 *
 * Crispness recipe (see SunLight history): 1024×256 canvas, 700-weight Helvetica,
 * NO shadow blur (it bled into glyph edges at pixelRatio 1.5 with SMAA off),
 * linear-mipmap filtering + anisotropy + sRGB. Renders crisp from establishing
 * range down to close inspection.
 *
 * @module scene/labelTexture
 */

import * as THREE from 'three';

/**
 * Build a billboard text-label texture.
 * @param {string} text  Label text (drawn centred, single line).
 * @param {object} [opts]
 * @param {string} [opts.color='#ffffff']  CSS fill colour for the glyphs.
 * @param {number} [opts.fontPx=112]       Font size in canvas px (height is 256).
 * @param {boolean} [opts.pill=false]      Draw a dark rounded "chip" behind the
 *   text for contrast against bright hull / Earth. Stroked in `color`.
 * @returns {THREE.CanvasTexture}
 */
export function createLabelTexture(text, { color = '#ffffff', fontPx = 112, pill = false } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (pill) {
    // Measure the glyph run and draw a rounded dark chip behind it so labels
    // stay legible over the sunlit hull or Earth's limb.
    const tw = Math.min(ctx.measureText(text).width, c.width - 40);
    const padX = 36, padY = 30;
    const w = tw + padX * 2;
    const h = fontPx + padY * 2;
    const x = (c.width - w) / 2;
    const y = (c.height - h) / 2;
    const r = h * 0.32;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(3, 8, 16, 0.74)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // Subtle dark halo around the glyphs so text stays legible against bright
  // hull / Earth even when the pill is absent or semi-transparent.
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, fontPx * 0.06);
  ctx.strokeStyle = 'rgba(2, 6, 12, 0.85)';
  ctx.strokeText(text, 512, 128);

  ctx.fillStyle = color;
  ctx.globalAlpha = 1.0;
  ctx.fillText(text, 512, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4; // Three.js clamps to renderer max; sharpens at oblique angles
  return tex;
}
