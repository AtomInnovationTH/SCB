/**
 * Earth.js — Texture-mapped Earth with day/night, clouds, and atmosphere
 * THE visual centerpiece of Space Cowboy
 * Uses NASA Blue Marble textures for photorealistic rendering
 * Atmosphere: thin bright limb glow (ISS-like), Rayleigh scattering
 * @module scene/Earth
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

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

// Ultra-high-frequency detail tiling (octaves 6–7) — nadir-only surface richness
// Simulates tiled detail texture at very close viewing distances
float detailTiling(vec3 p) {
  float n = 0.0;
  n += 0.5  * snoise(p * 6400.0);
  n += 0.25 * snoise(p * 12800.0);
  return n;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 pos = normalize(vPosition);

  // Sample textures
  vec3 dayColor = texture2D(uDayTexture, vUv).rgb;
  vec3 nightColor = texture2D(uNightTexture, vUv).rgb;

  // Boost night lights — they're dim in the source texture
  nightColor *= 2.5;
  // Warm tint for city lights
  nightColor *= vec3(1.0, 0.85, 0.6);

  // === LIGHTING ===
  float NdotL = dot(normal, uSunDirection);

  // Terminator: smooth transition over ~6 degrees
  float dayFactor = smoothstep(-0.1, 0.15, NdotL);

  // Specular for oceans — ratio-based detection for robust ocean masking
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfVec = normalize(uSunDirection + viewDir);
  float specular = pow(max(dot(normal, halfVec), 0.0), 64.0);

  // Ocean detection: blue channel dominates, overall dark (moved up for detail calc)
  float blueRatio = dayColor.b / max(dayColor.r + dayColor.g + dayColor.b, 0.001);
  float darkness = 1.0 - (dayColor.r + dayColor.g + dayColor.b) / 3.0;
  float oceanMask = smoothstep(0.35, 0.55, blueRatio) * smoothstep(0.3, 0.7, darkness);

  // Procedural terrain detail — adds fine structure at close viewing distances
  // Uses world-space position for consistent detail as camera moves
  float detail = terrainDetail(normalize(vPosition));

  // Distance-based blend: detail visible only at close range (LEO)
  // At far distances, the base texture is sufficient
  float viewDist = length(cameraPosition - vWorldPosition);
  float detailFade = smoothstep(0.8, 0.2, viewDist / 3.0); // fade in within ~300km (closer detail visibility)

  // Apply as subtle luminance modulation — doesn't change color, just adds texture
  // Reduce effect over ocean (water shouldn't have terrain noise)
  float detailStrength = 0.15 * detailFade * (1.0 - oceanMask * 0.7);
  dayColor *= 1.0 + detail * detailStrength;

  // Ultra-high-frequency detail tiling — visible only at very close range (nadir)
  float tileNoise = detailTiling(normalize(vPosition));
  float tileFade = smoothstep(2.0, 0.5, viewDist);  // tighter fade than base detail
  float tileStrength = 0.04 * tileFade * (1.0 - oceanMask * 0.7);
  dayColor *= 1.0 + tileNoise * tileStrength;

  // Fresnel-enhanced ocean reflection — grazing angles more reflective
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

  // Subtle Fresnel rim for blending into atmosphere
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  finalColor += vec3(0.1, 0.15, 0.3) * fresnel * 0.15 * dayFactor;

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

  // Sample cloud texture — use brightness as alpha
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
// ATMOSPHERE SHADER — FIXED: thin bright limb glow (ISS photo reference)
// Fresnel is brightest at the EDGE (limb) and fades toward the camera.
// From VLEO, atmosphere appears as an incredibly thin, bright blue band.
// ============================================================================
const atmosphereVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vViewDir;
varying float vDot;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vViewDir = normalize(cameraPosition - worldPos.xyz);

  // Pre-compute dot product for fragment shader
  vDot = dot(vNormal, vViewDir);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  #include <logdepthbuf_vertex>
}
`;

const atmosphereFragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDirection;
uniform float uTime;
uniform float uEarthRadius;
uniform float uAtmosphereRadius;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vViewDir;
varying float vDot;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewDir);

  // === FIXED FRESNEL: Brightest at the LIMB (edge), fades inward ===
  // When viewing the edge, dot(normal, viewDir) → 0 (perpendicular)
  // When viewing face-on, dot(normal, viewDir) → 1
  // We want brightness at the edge, so we use (1 - abs(dot))
  float edgeFactor = 1.0 - abs(dot(normal, viewDir));

  // Sharp power curve: slightly wider than razor-thin for visual impact
  // Power of 4.0 gives a clearly visible ISS-like limb glow
  float rimPower = pow(edgeFactor, 4.0);

  // Additional sharpening: kill anything that isn't at the very edge
  // This prevents the "thick haze" look
  rimPower *= smoothstep(0.0, 0.12, edgeFactor);

  // Altitude-based falloff: atmosphere should only be visible near Earth limb
  float atmosphereThickness = rimPower * 2.5;
  atmosphereThickness = clamp(atmosphereThickness, 0.0, 1.0);

  // === SUN ILLUMINATION ===
  float NdotL = dot(normal, uSunDirection);
  float dayFactor = smoothstep(-0.3, 0.5, NdotL);

  // === RAYLEIGH SCATTERING COLORS ===
  // Blue on the sunlit side (dominant Rayleigh)
  vec3 rayleighDay = vec3(0.4, 0.7, 1.0);

  // Orange/red at the terminator (sunset/sunrise)
  float terminatorZone = smoothstep(-0.15, 0.05, NdotL) * smoothstep(0.25, 0.05, NdotL);
  vec3 rayleighTerminator = vec3(1.0, 0.5, 0.15);

  // Blend between day blue and terminator orange
  vec3 scatterColor = mix(rayleighDay, rayleighTerminator, terminatorZone * 0.7);

  // Brighten the limb color slightly for that ISS-like brilliant blue-white
  scatterColor = mix(scatterColor, vec3(0.8, 0.9, 1.0), rimPower * 0.3);

  // === COMBINE: bright rim × sun illumination ===
  float intensity = atmosphereThickness * 1.8;
  vec3 atmosColor = scatterColor * intensity * dayFactor;

  // === NIGHT SIDE: visible airglow (greenish tint, ISS-observed) ===
  float nightGlow = rimPower * 0.30 * (1.0 - dayFactor);
  atmosColor += vec3(0.10, 0.25, 0.18) * nightGlow;

  // === ALPHA: visible mainly at rim edges, transparent everywhere else ===
  float alpha = atmosphereThickness * dayFactor * 1.0 + nightGlow * 0.9;
  alpha = clamp(alpha, 0.0, 0.95);

  // Fade very faint contributions to zero for cleanliness
  if (alpha < 0.005) discard;

  gl_FragColor = vec4(atmosColor, alpha);

  #include <logdepthbuf_fragment>
}
`;

// ============================================================================
// TEXTURE LOADER
// ============================================================================
const textureLoader = new THREE.TextureLoader();

function loadTexture(path) {
  const tex = textureLoader.load(path, (loaded) => {
    console.log(`[Earth] Loaded: ${path} (${loaded.image?.width}×${loaded.image?.height})`);
  });
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
  console.log(`[Earth] LOD selected: ${quality || '4k (base)'} — maxTextureSize=${maxTextureSize}`);
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
    this._createClouds();
    this._createAtmosphere();

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
    });

    this.surfaceMesh = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.surfaceMesh.name = 'EarthSurface';
    this.group.add(this.surfaceMesh);
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

  // --- ATMOSPHERE (128×128 segments, BackSide, additive blending) ---
  _createAtmosphere() {
    const geometry = new THREE.SphereGeometry(Constants.ATMOSPHERE_RADIUS, 128, 128);

    this.atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunDirection: { value: this.sunDirection },
        uTime: { value: 0 },
        uEarthRadius: { value: Constants.EARTH_RADIUS },
        uAtmosphereRadius: { value: Constants.ATMOSPHERE_RADIUS },
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
    this.cloudMaterial.uniforms.uSunDirection.value.copy(dir);
    this.atmosphereMaterial.uniforms.uSunDirection.value.copy(dir);
  }

  /**
   * Per-frame update: animate clouds, advance time uniform
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    this.elapsedTime += dt;

    // Advance time uniforms
    this.surfaceMaterial.uniforms.uTime.value = this.elapsedTime;
    this.cloudMaterial.uniforms.uTime.value = this.elapsedTime;
    this.atmosphereMaterial.uniforms.uTime.value = this.elapsedTime;

    // Sidereal cloud rotation — visible drift over a game hour (ST-5.3)
    this.cloudMesh.rotation.y += Constants.EARTH.CLOUD_ROTATION_RATE * dt;
  }

  /** @returns {THREE.Group} */
  getGroup() {
    return this.group;
  }
}

export default Earth;
