/**
 * glowSpriteTexture.js — shared procedural soft radial-glow sprite texture: white
 * radial gradient (opaque core → transparent rim), the `map` of additive sprites
 * (RCS puffs, nav/strobe/dock light halos). Returns `null` with no DOM (Node
 * tests), like `getSolarCellTexture`; callers must tolerate a null map.
 *
 * @module scene/glowSpriteTexture
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

const _cache = new Map();

/**
 * Build (or return a cached) soft radial-glow sprite texture.
 *
 * @param {object} [opts]
 * @param {number}   [opts.size=64]      — canvas pixel dimension (power of two)
 * @param {number}   [opts.coreStop=0.0] — gradient stop where the core alpha ends
 * @param {number}   [opts.midStop=0.4]  — gradient stop for the mid falloff
 * @param {number}   [opts.midAlpha=0.4] — alpha at the mid falloff stop
 * @returns {THREE.CanvasTexture|null}   null in headless/no-DOM environments
 */
export function getRadialGlowTexture(opts = {}) {
  const size = opts.size || 64;
  const coreStop = opts.coreStop ?? 0.0;
  const midStop = opts.midStop ?? 0.4;
  const midAlpha = opts.midAlpha ?? 0.4;
  const key = `${size}:${coreStop}:${midStop}:${midAlpha}`;
  if (_cache.has(key)) return _cache.get(key);
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  if (typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  gradient.addColorStop(coreStop, 'rgba(255,255,255,1)');
  gradient.addColorStop(midStop, `rgba(255,255,255,${midAlpha})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _cache.set(key, tex);
  return tex;
}

/**
 * Additive soft-glow halo sprite for a nav/strobe/dock/status light, shared by
 * Mother (PlayerSatellite) and daughters (ArmUnit) so the recipe has one SSOT.
 *
 * Bloom: the composer threshold is 2.5; colour ×hdrMul only crosses it for
 * near-white strobe peaks, coloured steady halos stay below and glow additively.
 *
 * @param {number} scaleM     sprite world size (scene units) ≈ 3–4× core dia
 * @param {number} [hdrMul=1.6] colour multiplier (>1 = HDR, can bloom at peak)
 * @param {number} [opacity=0] initial opacity (driven per-frame for flashers)
 */
export function makeLightHalo(colorHex, scaleM, hdrMul = 1.6, opacity = 0.0) {
  const tex = getRadialGlowTexture({ size: 64 });
  const mat = new THREE.SpriteMaterial({
    map: tex || null,
    color: new THREE.Color(colorHex).multiplyScalar(hdrMul),
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
  });
  const halo = new THREE.Sprite(mat);
  halo.scale.set(scaleM, scaleM, scaleM);
  halo.name = 'LightHalo';
  halo.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
  return halo;
}
