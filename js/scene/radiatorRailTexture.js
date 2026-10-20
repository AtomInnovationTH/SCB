/**
 * radiatorRailTexture.js — the radiator panels' edge rails as a MIPMAPPED texture (CONVENTIONS §11.17).
 *
 * The 14 mm rails stood 1 mm proud of each panel face as real boxes. At 6-25 m they are 0.7-2 px wide, and a
 * line that thin shimmers whatever the MSAA: its coverage changes in steps as the view turns (measured with
 * tmp/probes/rad-shimmer: mean per-pixel change on the panel faces 6.1/255 with the boxes, 2.7 without,
 * 3.0 with this texture; 2nd-difference 4.1 -> 1.8). A texture is filtered by the GPU (mip chain + anisotropy),
 * so the same dark line fades smoothly instead of crawling.
 *
 * One texel-exact box-filtered coverage per texel (rail rectangle ∩ texel), so the base level already has
 * smooth edges. Data textures need no canvas, so this also builds headless (tests).
 *
 * @module scene/radiatorRailTexture
 */
import * as THREE from 'three';

const _cache = new Map();

/** 1-D overlap of [a0,a1] with [b0,b1], in the same unit. */
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * @param {object} o
 * @param {number} o.lengthM       panel length along the texture's U (m)
 * @param {number} o.widthM        panel width along V (m)
 * @param {Array<[number, number, number]>} o.rails  [centre from the V=0 edge (m), width (m), albedo (sRGB hex)] per painted band
 * @param {number} o.endInsetM     the rails stop this far short of each end (m)
 * @param {number} o.faceHex       the panel face albedo (sRGB hex)
 * @returns {THREE.DataTexture} cached per parameter set; shared, never dispose per ship
 */
export function getRadiatorRailTexture({ lengthM, widthM, rails, endInsetM, faceHex }) {
  const key = JSON.stringify([lengthM, widthM, rails, endInsetM, faceHex]);
  const hit = _cache.get(key);
  if (hit) return hit;
  const W = 1024, H = 256;                       // powers of two: a full mip chain on WebGL2 and WebGL1
  const data = new Uint8Array(W * H * 4);
  const f = [(faceHex >> 16) & 255, (faceHex >> 8) & 255, faceHex & 255];
  const du = lengthM / W, dv = widthM / H;
  // Texel x has full rail coverage along U (cu = 1) except within endInsetM of an end; those few columns are
  // computed one by one, the rest of the row is one colour (a row's colour depends on v alone).
  const xFull0 = Math.min(W, Math.ceil(endInsetM / du - 1e-9)), xFull1 = Math.max(xFull0, Math.floor((lengthM - endInsetM) / du + 1e-9));
  const paint = (cvList, cu) => {
    let rgb = f;
    for (const [cv, hex] of cvList) {                          // later bands paint over earlier ones
      const k = Math.min(1, cu * cv);
      if (k > 0) rgb = [0, 1, 2].map((p) => rgb[p] + ((((hex >> (16 - 8 * p)) & 255) - rgb[p]) * k));
    }
    return rgb;
  };
  for (let y = 0; y < H; y++) {
    // Row 0 is v = 0 = the face's -Y edge (BoxGeometry's +Z and -Z faces both run v with +Y); callers measure from there.
    const v0 = y * dv, v1 = v0 + dv;
    const bands = rails.map(([c, w, hex]) => [overlap(v0, v1, c - w / 2, c + w / 2) / dv, hex]);
    const row = y * W;
    const full = paint(bands, 1);
    const r0 = Math.round(full[0]), g0 = Math.round(full[1]), b0 = Math.round(full[2]);
    if (xFull1 > xFull0) {                                       // one texel, then doubled with memcpy (copyWithin)
      const o0 = (row + xFull0) * 4, n = xFull1 - xFull0;
      data[o0] = r0; data[o0 + 1] = g0; data[o0 + 2] = b0; data[o0 + 3] = 255;
      for (let have = 1; have < n; have *= 2) data.copyWithin(o0 + have * 4, o0, o0 + Math.min(have, n - have) * 4);
    }
    for (let x = 0; x < W; x++) {
      if (x >= xFull0 && x < xFull1) { x = xFull1 - 1; continue; }
      const u0 = x * du, u1 = u0 + du;
      const cu = overlap(u0, u1, endInsetM, lengthM - endInsetM) / du;
      const rgb = paint(bands, cu), o = (row + x) * 4;
      for (let p = 0; p < 3; p++) data[o + p] = Math.round(rgb[p]);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;                            // the renderer clamps to its own maximum
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _cache.set(key, tex);
  return tex;
}
