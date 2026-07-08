/**
 * Earth.js — Texture-mapped Earth with day/night, clouds, and atmosphere
 * THE visual centerpiece of Space Cowboy
 * Uses NASA Blue Marble textures for photorealistic rendering
 * Atmosphere: thin bright limb glow (ISS-like), Rayleigh scattering
 * @module scene/Earth
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { profileFlags } from '../core/ProfileFlags.js';

// ============================================================================
// EARTH SURFACE SHADER (texture-based day/night with specular oceans)
// ============================================================================
const earthSurfaceVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  #include <logdepthbuf_vertex>
}
`;

const earthSurfaceFragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

uniform sampler2D uDayTexture;
uniform sampler2D uNightTexture;
uniform vec3 uSunDirection;
uniform float uTime;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;

// Simplex-like noise for procedural terrain detail
// Based on Ashima Arts webgl-noise (3-component, fast)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// Sprint 2 / PR C. LOW_DETAIL define skips the 7-octave noise stack entirely.
// At LOW tier the base 8k/16k AVIF texture is detailed enough on its own;
// the procedural noise was an ~7-octave/fragment burn that ate 2–4 ms on iGPUs.
#ifndef LOW_DETAIL
// Multi-octave fractal noise for terrain detail (5 octaves, higher frequency for close-range detail)
float terrainDetail(vec3 p) {
  float n = 0.0;
  n += 0.5    * snoise(p * 200.0);
  n += 0.25   * snoise(p * 400.0);
  n += 0.125  * snoise(p * 800.0);
  n += 0.0625 * snoise(p * 1600.0);
  n += 0.03125* snoise(p * 3200.0);
  return n;
}

// Ultra-high-frequency detail tiling (octaves 6–7). Nadir-only surface richness
// Simulates tiled detail texture at very close viewing distances
float detailTiling(vec3 p) {
  float n = 0.0;
  n += 0.5  * snoise(p * 6400.0);
  n += 0.25 * snoise(p * 12800.0);
  return n;
}
#endif

void main() {
  vec3 normal = normalize(vNormal);
  vec3 pos = normalize(vPosition);

  // Sample textures
  vec3 dayColor = texture2D(uDayTexture, vUv).rgb;
  vec3 nightColor = texture2D(uNightTexture, vUv).rgb;

  // Boost night lights. They're dim in the source texture
  nightColor *= 2.5;
  // Warm tint for city lights
  nightColor *= vec3(1.0, 0.85, 0.6);

  // === LIGHTING ===
  float NdotL = dot(normal, uSunDirection);

  // Terminator: smooth transition over ~6 degrees
  float dayFactor = smoothstep(-0.1, 0.15, NdotL);

  // Specular for oceans. Ratio-based detection for robust ocean masking
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfVec = normalize(uSunDirection + viewDir);
  float specular = pow(max(dot(normal, halfVec), 0.0), 64.0);

  // Ocean detection: blue channel dominates, overall dark (moved up for detail calc)
  float blueRatio = dayColor.b / max(dayColor.r + dayColor.g + dayColor.b, 0.001);
  float darkness = 1.0 - (dayColor.r + dayColor.g + dayColor.b) / 3.0;
  float oceanMask = smoothstep(0.35, 0.55, blueRatio) * smoothstep(0.3, 0.7, darkness);

  // Sprint 2 / PR C. Terrain detail stack is gated by LOW_DETAIL.
  // viewDist is still needed below for other effects, so it's defined either way.
  float viewDist = length(cameraPosition - vWorldPosition);
#ifndef LOW_DETAIL
  // Sprint 3 GPU profiling. Phase C.4 (2026-05-23): early-out the entire
  // procedural-noise stack when this fragment is on the dark hemisphere.
  // The detail contributions are multiplied into dayColor, which is then
  // attenuated by max(0.02, dayFactor) in litDay below; with dayFactor
  // near 0 on the night side, the noise output is suppressed to a tiny
  // fraction of 1% anyway, so skipping the 7 snoise() calls per fragment
  // is a zero-visual-change pure-savings transform.
  //
  // Threshold (dayFactor > 0.05) matches the nightFactor smoothstep
  // crossover at NdotL ~= 0.05. I.e. the terminator midpoint. Fragments
  // inside the smoothstep transition still run the noise (so the visible
  // band of detail at the dawn/dusk terminator is unchanged).
  if (dayFactor > 0.05) {
    // Procedural terrain detail. Adds fine structure at close viewing distances
    // Uses world-space position for consistent detail as camera moves
    float detail = terrainDetail(normalize(vPosition));

    // Distance-based blend: detail visible only at close range (LEO)
    // At far distances, the base texture is sufficient
    float detailFade = smoothstep(0.8, 0.2, viewDist / 3.0); // fade in within ~300km (closer detail visibility)

    // Apply as subtle luminance modulation. Doesn't change color, just adds texture
    // Reduce effect over ocean (water shouldn't have terrain noise)
    float detailStrength = 0.15 * detailFade * (1.0 - oceanMask * 0.7);
    dayColor *= 1.0 + detail * detailStrength;

    // Ultra-high-frequency detail tiling. Visible only at very close range (nadir)
    float tileNoise = detailTiling(normalize(vPosition));
    float tileFade = smoothstep(2.0, 0.5, viewDist);  // tighter fade than base detail
    float tileStrength = 0.04 * tileFade * (1.0 - oceanMask * 0.7);
    dayColor *= 1.0 + tileNoise * tileStrength;
  }
#endif

  // Fresnel-enhanced ocean reflection. Grazing angles more reflective
  float oceanFresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  float oceanSpec = oceanMask * (specular + oceanFresnel * 0.3) * dayFactor * 0.5;

  // === NIGHT SIDE ===
  float nightFactor = smoothstep(0.05, -0.15, NdotL);

  // === COMPOSE ===
  vec3 litDay = dayColor * max(0.02, dayFactor) + vec3(oceanSpec);

  // Earthshine: faint cool-blue ambient reveals terrain shapes on the dark side
  float nightAmbient = 0.03;
  vec3 nightBase = dayColor * nightAmbient * vec3(0.5, 0.6, 1.0);

  vec3 finalColor = litDay + nightColor * nightFactor + nightBase * (1.0 - dayFactor);

  // Atmospheric limb haze: blue scattering in front of the planet edge so the
  // hard surface silhouette dissolves into the atmosphere shell. Softer power +
  // stronger blue tint than before to marry the surface into the glow.
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5);
  finalColor += vec3(0.30, 0.50, 0.85) * fresnel * 0.35 * dayFactor;

  gl_FragColor = vec4(finalColor, 1.0);

  #include <logdepthbuf_fragment>
}
`;

// ============================================================================
// CLOUD LAYER SHADER (texture-based)
// ============================================================================
const cloudVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  #include <logdepthbuf_vertex>
}
`;

const cloudFragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

uniform sampler2D uCloudTexture;
uniform vec3 uSunDirection;
uniform float uTime;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  vec3 normal = normalize(vNormal);

  // Sample cloud texture. Use brightness as alpha
  vec3 cloudSample = texture2D(uCloudTexture, vUv).rgb;
  float cloudAlpha = (cloudSample.r + cloudSample.g + cloudSample.b) / 3.0;

  // Shape: boost contrast for cleaner cloud edges
  cloudAlpha = smoothstep(0.25, 0.95, cloudAlpha);
  cloudAlpha *= 0.85; // Max opacity

  // Lighting
  float NdotL = dot(normal, uSunDirection);
  float dayFactor = smoothstep(-0.1, 0.2, NdotL);

  // Cloud color: bright white in sunlight, dark gray in shadow
  vec3 cloudDay = vec3(0.95, 0.95, 0.97);
  vec3 cloudNight = vec3(0.05, 0.06, 0.08);
  vec3 cloudColor = mix(cloudNight, cloudDay, dayFactor);

  // Slight scattering highlight at terminator
  float terminator = (1.0 - abs(NdotL)) * smoothstep(-0.2, 0.1, NdotL);
  cloudColor += vec3(0.8, 0.4, 0.2) * terminator * 0.3;

  gl_FragColor = vec4(cloudColor, cloudAlpha);

  #include <logdepthbuf_fragment>
}
`;

// ============================================================================
// ATMOSPHERE SHADER — analytic limb scattering.
// Per-fragment impact-parameter altitude + exponential density falloff:
// brightest at the limb base (Earth's edge), fades smoothly to zero before the
// mesh's geometric edge — no hard silhouette cutoff (the flaw of normal-based
// Fresnel rims). Rayleigh altitude gradient (cyan-white → blue → violet),
// narrow saturated terminator sunset, gold Mie forward-scatter hotspot toward
// the sun, and a thin greenish night airglow band.
// Perf: log depth is encoded in the vertex shader (early-Z preserved, so the
// occluded Earth-disc half of the shell is culled before shading); analytic
// shading reads only `position` (normal/uv attributes stripped).
// ============================================================================
const atmosphereVertexShader = /* glsl */ `
varying vec3 vWorldPosition;

// three.js WebGLRenderer supplies this automatically whenever the renderer has
// logarithmicDepthBuffer enabled (2.0 / log2(camera.far + 1.0)) — declaring it
// is enough, no manual uniform entry needed.
uniform float logDepthBufFC;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  // Vertex-encoded logarithmic depth (three.js classic non-fragDepth path).
  // Writing gl_FragDepth in the fragment stage (the stock logdepthbuf chunks)
  // disables early-Z, forcing the shader to run on the ~half of the shell that
  // is occluded by the opaque Earth disc. Encoding here restores early-Z; the
  // interpolation error is negligible vs the multi-unit shell/surface gap.
  gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
  gl_Position.z *= gl_Position.w;
}
`;

const atmosphereFragmentShader = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uCenter;            // Earth center, world space (CPU-fed)
uniform float uEarthRadius;
uniform float uInvShellDepth;    // 1.0 / (ATMOSPHERE_RADIUS - EARTH_RADIUS)

varying vec3 vWorldPosition;

// Cheap hash for sub-LSB dithering (breaks 8-bit additive banding).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // === RAY GEOMETRY: altitude of the view ray's closest approach to Earth ===
  // Real atmosphere is densest at the surface and thins exponentially upward.
  // Brightness therefore peaks where the ray grazes the limb (h -> 0) and
  // fades smoothly to zero well before the shell's geometric edge — no hard
  // silhouette cutoff (the flaw of normal-based Fresnel rims).
  vec3 rayDir = normalize(vWorldPosition - cameraPosition);
  vec3 oc = uCenter - cameraPosition;
  float tca = max(dot(oc, rayDir), 0.0);          // camera is always outside the shell
  vec3 rel = (cameraPosition + rayDir * tca) - uCenter;
  float b = length(rel);                           // impact parameter
  float h01 = clamp((b - uEarthRadius) * uInvShellDepth, 0.0, 1.0);

  // Exponential density falloff; forced to exactly 0 at the shell top so the
  // mesh edge is invisible.
  float density = exp(-h01 * 4.0) * smoothstep(1.0, 0.75, h01);

  // === LIGHTING at the closest-approach point (what the viewer perceives) ===
  vec3 limbNormal = rel / max(b, 0.0001);
  float NdotL = dot(limbNormal, uSunDirection);
  float dayFactor = smoothstep(-0.35, 0.2, NdotL);

  // === RAYLEIGH: altitude gradient — bright white-cyan base -> blue -> violet ===
  vec3 lowCol  = vec3(0.75, 0.88, 1.00);
  vec3 midCol  = vec3(0.25, 0.55, 1.00);
  vec3 highCol = vec3(0.15, 0.25, 0.90);
  vec3 rayleigh = mix(lowCol, midCol, smoothstep(0.0, 0.45, h01));
  rayleigh = mix(rayleigh, highCol, smoothstep(0.45, 1.0, h01));

  // === TERMINATOR: narrow saturated sunset band at the day/night line ===
  float terminatorZone = smoothstep(-0.18, 0.02, NdotL) * smoothstep(0.22, 0.02, NdotL);
  vec3 sunset = mix(vec3(1.0, 0.25, 0.08), vec3(1.0, 0.55, 0.20), h01);
  vec3 scatter = mix(rayleigh, sunset, terminatorZone * 0.85);

  // === MIE forward scatter: gold hotspot when looking TOWARD the sun ===
  // (rayDir, not viewDir — dot(viewDir,sun) was backscatter, a bug.)
  float VdotS = max(dot(rayDir, uSunDirection), 0.0);
  float v2 = VdotS * VdotS;
  float mie = v2 * v2 * v2;

  // === LINEAR ADDITIVE OUTPUT (alpha=1; falloff lives in rgb) ===
  vec3 atmos = scatter * density * dayFactor * 2.2;
  atmos += vec3(1.0, 0.88, 0.65) * mie * density * dayFactor * 1.5;

  // === NIGHT: thin greenish airglow layer (~90-100 km, ISS-observed) ===
  float ag = (h01 - 0.62) / 0.18;
  float airglowBand = exp(-ag * ag);
  atmos += vec3(0.10, 0.30, 0.22) * airglowBand * (1.0 - dayFactor) * 0.35;

  // Sub-LSB dither to break additive banding on the smooth gradient.
  atmos += (hash12(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0);

  float lum = max(atmos.r, max(atmos.g, atmos.b));
  if (lum < 0.002) discard;

  gl_FragColor = vec4(atmos, 1.0);
}
`;

// ============================================================================
// TEXTURE LOADER + AVIF SUPPORT PROBE (PR P0.1)
// ============================================================================
//
// AVIF compresses Earth textures ~5× smaller than JPG at visually equivalent
// quality (e.g. earth_day_16k: 19 MB JPG → 3.9 MB AVIF). We probe browser AVIF
// support once at module load via Image.decode() on a 1×1 AVIF data-URL and
// cache the boolean. loadTexture() then prefers the `.avif` sibling on
// supporting browsers (Chrome 85+, Edge 85+, Firefox 93+, Safari 16+) and
// transparently falls back to the original `.jpg` everywhere else.
//
// The probe uses top-level await so the boolean is settled before any Earth
// instance is constructed. In non-browser environments (Node test runner) the
// `Image` global is absent, the probe short-circuits to `false`, and Earth.js
// continues to behave exactly as before — important because test-EarthLOD.js
// imports `selectLOD` from this module.
const textureLoader = new THREE.TextureLoader();

// 2×2 AVIF still-picture, av1 codec, ~311 bytes. Generated locally with
// `ffmpeg -f lavfi -i color=c=black:s=2x2 -c:v libaom-av1 -still-picture 1
//  -crf 30 -b:v 0` and verified to decode cleanly with libavif's avifdec.
// Sufficient payload to verify the browser ships a working AVIF decoder —
// `Image.decode()` will reject on the data-URL if AVIF is not supported.
const AVIF_PROBE_DATA_URL =
  'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAWAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAACAAAAAgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAebWRhdAoFGAA2wCAyDReAAABIAAAADAZusnI=';

const avifSupported = await (async () => {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return false; // Node / non-DOM environment (test runner)
  }
  try {
    const probe = new Image();
    probe.src = AVIF_PROBE_DATA_URL;
    await probe.decode();
    return true;
  } catch (_e) {
    return false;
  }
})();

if (typeof console !== 'undefined' && typeof document !== 'undefined') {
  console.log(`[Earth] AVIF support: ${avifSupported ? 'YES (preferring .avif)' : 'NO (falling back to .jpg)'}`);
}

/**
 * Module-level getter so external code (e.g. [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1))
 * can surface AVIF capability without touching the private module variable.
 * @returns {boolean} Whether the browser successfully decoded the AVIF probe.
 */
export function isAvifSupported() {
  return avifSupported === true;
}

/**
 * Load a texture, preferring the .avif sibling when the browser supports AVIF.
 * On AVIF load failure we automatically reissue the load against the .jpg path
 * and patch the resulting image into the already-returned THREE.Texture so the
 * material binding stays valid.
 *
 * @param {string} path  JPG path (e.g. 'textures/earth_day_16k.jpg'). When AVIF
 *                       is supported, the .jpg suffix is rewritten to .avif.
 */
function loadTexture(path) {
  const avifPath = path.replace(/\.jpg$/i, '.avif');
  const useAvif = avifSupported && avifPath !== path;
  const initialPath = useAvif ? avifPath : path;

  const tex = textureLoader.load(
    initialPath,
    (loaded) => {
      console.log(`[Earth] Loaded: ${initialPath} (${loaded.image?.width}×${loaded.image?.height})`);
      // §13 boot timeline (?logBoot=1). Optional-chained so this is a no-op
      // when the flag is off — `window.__bootMark` is only attached by main.js
      // when `?logBoot=1` is set. This timestamps each Earth texture load (the
      // prime suspect for the boot-time fan spike per the suspect list).
      try {
        const fname = initialPath.split('/').pop();
        const dims = `${loaded.image?.width}×${loaded.image?.height}`;
        // eslint-disable-next-line no-undef
        window.__bootMark?.(`Earth texture decoded: ${fname} (${dims})`);
      } catch (_e) { /* swallow — diagnostic only */ }
    },
    undefined,
    (err) => {
      if (useAvif) {
        // AVIF file missing or decode failed at runtime — fall back to JPG.
        console.warn(`[Earth] AVIF load failed for ${initialPath}, falling back to ${path}`, err);
        textureLoader.load(path, (loaded) => {
          tex.image = loaded.image;
          tex.needsUpdate = true;
          console.log(`[Earth] Loaded fallback: ${path} (${loaded.image?.width}×${loaded.image?.height})`);
          try {
            const fname = path.split('/').pop();
            const dims = `${loaded.image?.width}×${loaded.image?.height}`;
            // eslint-disable-next-line no-undef
            window.__bootMark?.(`Earth texture decoded (fallback): ${fname} (${dims})`);
          } catch (_e) { /* swallow */ }
        });
      } else {
        console.error(`[Earth] Texture load failed: ${path}`, err);
      }
    }
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;   // ST-5.3: 8× anisotropy (16k RGBA ≈ 1 GB VRAM — be conservative)
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;   // prevent antimeridian seam
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  return tex;
}

// ============================================================================
// ADAPTIVE TEXTURE QUALITY
// ============================================================================

/**
 * Pure LOD selector — testable without DOM/WebGL.
 * Primary signal: maxTextureSize from renderer capabilities.
 * Secondary signal: deviceMemory + Apple-GPU heuristics (Safari fallback).
 *
 * @param {number} maxTextureSize - renderer.capabilities.maxTextureSize (or gl.MAX_TEXTURE_SIZE)
 * @param {number|undefined} deviceMemory - navigator.deviceMemory (undefined on Safari/Firefox)
 * @param {boolean} [isAppleGPU=false] - true when WEBGL_debug_renderer_info contains 'Apple'
 * @returns {'16k'|'8k'|''}
 */
export function selectLOD(maxTextureSize, deviceMemory, isAppleGPU = false) {
  // Memory: default to 8 GB when unavailable (Safari on macOS = capable HW)
  const memory = deviceMemory ?? 8;

  // Primary signal: GPU maxTextureSize drives LOD tier
  if (maxTextureSize >= Constants.EARTH.LOD_16K_THRESHOLD) {
    // Secondary guard: Apple Silicon or ≥8 GB for 16k (keeps existing safety check)
    if (memory >= 8 || isAppleGPU) return '16k';
    // GPU claims 16k but memory is low — fall to 8k
    return '8k';
  }
  if (maxTextureSize >= Constants.EARTH.LOD_8K_THRESHOLD) {
    if (memory >= 4) return '8k';
    return ''; // low memory + 8k GPU — use base
  }
  return ''; // base resolution (4k or less)
}

/**
 * Detect hardware capability and return the best texture quality tier.
 * Gathers runtime inputs, delegates to selectLOD() for the actual decision.
 * @returns {'16k'|'8k'|''}
 */
function getTextureQuality() {
  // navigator.deviceMemory is Chrome/Edge only (NOT available in Safari/Firefox).
  const deviceMemory = navigator.deviceMemory; // may be undefined
  const gl = document.createElement('canvas').getContext('webgl2') ||
             document.createElement('canvas').getContext('webgl');
  const maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;

  // Also detect Apple Silicon via renderer string (Safari-specific fallback)
  let isAppleGPU = false;
  if (gl) {
    const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbgExt) {
      const renderer = gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '';
      isAppleGPU = /Apple/i.test(renderer);
    }
  }

  const quality = selectLOD(maxTextureSize, deviceMemory, isAppleGPU);
  // PR 5 / P2.10: gate verbose LOD log behind DEBUG flag (?debug=1).
  if (Constants && Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
    console.log(`[Earth] LOD selected: ${quality || '4k (base)'}. MaxTextureSize=${maxTextureSize}`);
  }
  return quality;
}

// ============================================================================
// EARTH CLASS
// ============================================================================
export class Earth {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'EarthGroup';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();
    this.elapsedTime = 0;

    // Sprint 2 / PR C — LOW_DETAIL fragment-shader branch flag.
    // Toggled by [`Earth.setLowDetail`](js/scene/Earth.js:1), wired through
    // [`SceneManager.applyTier()`](js/scene/SceneManager.js:275).
    //
    // Sprint 3 GPU profiling — `?disableEarthNoise=1` force-pins LOW_DETAIL
    // on at construction so the 7-octave noise stack is compiled out
    // regardless of which quality tier is active. Lets us A/B the entire
    // procedural-terrain cost in one session.
    this._useLowDetail = profileFlags.disableEarthNoise === true;

    // Adaptive quality: pick texture resolution based on hardware
    const quality = getTextureQuality();
    const texSuffix = quality ? `_${quality}` : '';
    const cloudSuffix = quality === '16k' ? '_8k' : (quality === '8k' ? '_8k' : '');

    console.log(`[Earth] Texture quality: ${quality || 'base'} (suffix: "${texSuffix}")`);

    // Load textures at detected quality tier
    this.dayTexture = loadTexture(`textures/earth_day${texSuffix}.jpg`);
    this.nightTexture = loadTexture(`textures/earth_night${texSuffix}.jpg`);
    this.cloudTexture = loadTexture(`textures/earth_clouds${cloudSuffix}.jpg`);

    this._createSurface();
    // Sprint 3 GPU profiling — `?disableClouds=1` skips the 8K-textured
    // 128×128 transparent cloud sphere entirely. Isolates cloud-layer
    // fragment + bandwidth cost (transparent + depthWrite=false sphere is a
    // known bandwidth pig at 5760×3600).
    if (!profileFlags.disableClouds) {
      this._createClouds();
    } else {
      this.cloudMesh = null;
      this.cloudMaterial = null;
      console.info('[Earth] cloud layer skipped (?disableClouds=1)');
    }
    // Sprint 3 GPU profiling — `?disableAtmosphere=1` skips the atmosphere shell.
    if (!profileFlags.disableAtmosphere) {
      this._createAtmosphere();
    } else {
      this.atmosphereMesh = null;
      this.atmosphereMaterial = null;
      console.info('[Earth] atmosphere skipped (?disableAtmosphere=1)');
    }

    scene.add(this.group);
  }

  // --- SURFACE SPHERE (M4 Max: 256×256 segments for silky smooth) ---
  _createSurface() {
    const geometry = new THREE.SphereGeometry(Constants.EARTH_RADIUS, 256, 256);

    this.surfaceMaterial = new THREE.ShaderMaterial({
      vertexShader: earthSurfaceVertexShader,
      fragmentShader: earthSurfaceFragmentShader,
      uniforms: {
        uDayTexture: { value: this.dayTexture },
        uNightTexture: { value: this.nightTexture },
        uSunDirection: { value: this.sunDirection },
        uTime: { value: 0 },
      },
      // Sprint 2 / PR C — `defines` controls the LOW_DETAIL branch. Mutated
      // at runtime by [`Earth.setLowDetail`](js/scene/Earth.js:1) when the
      // quality tier changes.
      defines: this._useLowDetail ? { LOW_DETAIL: 1 } : {},
    });

    this.surfaceMesh = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.surfaceMesh.name = 'EarthSurface';
    this.group.add(this.surfaceMesh);
  }

  /**
   * Sprint 2 / PR C — toggle the fragment shader's LOW_DETAIL branch.
   * Called by [`SceneManager.applyTier()`](js/scene/SceneManager.js:275)
   * whenever the quality tier switches. When `enabled` is true, the 7-octave
   * noise stack in [`earthSurfaceFragmentShader`](js/scene/Earth.js:36) is
   * compiled out — the base AVIF texture carries detail on its own.
   *
   * Idempotent and safe to call mid-flight: mutates `defines` + flips
   * `needsUpdate` so the WebGL program is recompiled on the next frame.
   *
   * @param {boolean} enabled
   */
  /**
   * Toggle the cloud sphere's visibility. Used by
   * [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1) to A/B the
   * cloud-layer GPU cost mid-session without reloading the page. No-op when
   * clouds were never created (i.e. `?disableClouds=1` was set at boot).
   *
   * @param {boolean} visible
   */
  setCloudsVisible(visible) {
    if (this.cloudMesh) {
      this.cloudMesh.visible = visible !== false;
    }
  }

  /**
   * Toggle the atmosphere shell's visibility. Mid-session A/B counterpart
   * to [`setCloudsVisible`](js/scene/Earth.js:1). No-op when atmosphere was
   * never created (`?disableAtmosphere=1` at boot).
   *
   * @param {boolean} visible
   */
  setAtmosphereVisible(visible) {
    if (this.atmosphereMesh) {
      this.atmosphereMesh.visible = visible !== false;
    }
  }

  setLowDetail(enabled) {
    // Sprint 3 GPU profiling — `?disableEarthNoise=1` force-pins LOW_DETAIL
    // on regardless of the tier the caller wants. Without this guard
    // [`SceneManager.setEarth()`](js/scene/SceneManager.js:283) and
    // [`SceneManager.applyTier()`](js/scene/SceneManager.js:305) would call
    // `setLowDetail(false)` at HIGH/MEDIUM tier and silently undo the flag.
    const want = profileFlags.disableEarthNoise ? true : !!enabled;
    if (this._useLowDetail === want) return;
    this._useLowDetail = want;
    if (!this.surfaceMaterial) return; // surface not yet created
    const defs = this.surfaceMaterial.defines || {};
    if (want) {
      defs.LOW_DETAIL = 1;
    } else {
      delete defs.LOW_DETAIL;
    }
    this.surfaceMaterial.defines = defs;
    this.surfaceMaterial.needsUpdate = true;
  }

  // --- CLOUD LAYER (128×128 segments for smooth rendering) ---
  _createClouds() {
    const geometry = new THREE.SphereGeometry(Constants.CLOUD_RADIUS, 128, 128);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uCloudTexture: { value: this.cloudTexture },
        uSunDirection: { value: this.sunDirection },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      // Polygon offset prevents Z-fighting flicker where cloud sphere
      // nearly overlaps the surface sphere at grazing angles (Bug 4 fix).
      // Negative values pull cloud depth TOWARD camera so clouds consistently
      // win depth test over the surface at the limb where the 0.10-unit gap
      // (10 km) collapses to near-zero in screen-space depth.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.cloudMesh = new THREE.Mesh(geometry, this.cloudMaterial);
    this.cloudMesh.name = 'EarthClouds';
    this.group.add(this.cloudMesh);
  }

  // --- ATMOSPHERE (64×64 segments, BackSide, additive blending) ---
  _createAtmosphere() {
    const geometry = new THREE.SphereGeometry(Constants.ATMOSPHERE_RADIUS, 64, 64);
    // Shading is fully analytic — only `position` is read.
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');

    this.atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunDirection: { value: this.sunDirection },
        uCenter: { value: new THREE.Vector3() },
        uEarthRadius: { value: Constants.EARTH_RADIUS },
        uInvShellDepth: { value: 1 / (Constants.ATMOSPHERE_RADIUS - Constants.EARTH_RADIUS) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // Render inner faces — visible from outside
      blending: THREE.AdditiveBlending,
    });

    this.atmosphereMesh = new THREE.Mesh(geometry, this.atmosphereMaterial);
    this.atmosphereMesh.name = 'EarthAtmosphere';
    // Atmosphere stays on default layer 0 only — no bloom layer needed
    // Threshold bloom ensures only very bright objects (emissive > 0.85) glow
    this.group.add(this.atmosphereMesh);
  }

  /**
   * Update the sun direction uniform across all Earth layers
   * @param {THREE.Vector3} dir — normalized sun direction
   */
  setSunDirection(dir) {
    this.sunDirection.copy(dir);
    this.surfaceMaterial.uniforms.uSunDirection.value.copy(dir);
    // Sprint 3 GPU profiling — cloud / atmosphere may be null when the
    // `?disableClouds=1` / `?disableAtmosphere=1` flags are active.
    if (this.cloudMaterial) {
      this.cloudMaterial.uniforms.uSunDirection.value.copy(dir);
    }
    if (this.atmosphereMaterial) {
      this.atmosphereMaterial.uniforms.uSunDirection.value.copy(dir);
    }
  }

  /**
   * Per-frame update: animate clouds, advance time uniform
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    this.elapsedTime += dt;

    // Advance time uniforms
    this.surfaceMaterial.uniforms.uTime.value = this.elapsedTime;
    // Sprint 3 GPU profiling — guarded for `?disableClouds=1` / `?disableAtmosphere=1`.
    if (this.cloudMaterial) {
      this.cloudMaterial.uniforms.uTime.value = this.elapsedTime;
    }
    if (this.atmosphereMaterial) {
      // Keep the analytic shader's Earth-center uniform in sync (group may move).
      this.atmosphereMesh.getWorldPosition(this.atmosphereMaterial.uniforms.uCenter.value);
    }

    // Sidereal cloud rotation — visible drift over a game hour (ST-5.3)
    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += Constants.EARTH.CLOUD_ROTATION_RATE * dt;
    }
  }

  /** @returns {THREE.Group} */
  getGroup() {
    return this.group;
  }
}

export default Earth;
