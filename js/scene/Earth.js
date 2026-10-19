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
import { TouchControls } from '../ui/TouchControls.js';

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
  // A1: world-space normal. three.js normalMatrix is the normal matrix of the
  // modelViewMatrix (VIEW space), so the old value rotated with the camera and
  // disagreed with the world-space uSunDirection / cameraPosition / vWorldPosition
  // every fragment lighting term dots against. mat3(modelMatrix) puts the normal
  // in world space to match them (Earth group is unscaled; cloudMesh.rotation.y
  // is handled correctly by modelMatrix).
  vNormal = normalize(mat3(modelMatrix) * normal);
  vPosition = position;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  #include <logdepthbuf_vertex>
}
`;

// ============================================================================
// SHARED SIMPLEX NOISE (GLSL)
// ============================================================================
// Extracted from the surface fragment shader as a shared GLSL string so it can be
// reused without duplicating the ~50-line Ashima simplex. Injected via template
// interpolation. (Currently consumed only by the surface shader's terrain detail.)
const simplexNoiseGLSL = /* glsl */ `
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
`;

// ============================================================================
// SHARED LIGHTING (GLSL)
// ============================================================================
// A2 Lambert modeling term, shared by the surface and cloud fragment shaders via
// template interpolation so their day-side shading curves cannot drift. Adds a
// luminance gradient from the sub-solar point toward the terminator; the 0.25
// floor keeps the terminator from crushing to black (earthshine lifts the dark
// side further below).
// B4 (2026-07-20): pow(NdotL, 0.6) → 0.8. The 0.6 curve was so flat it erased the
// sub-solar → terminator gradient, so a full-phase disc read as a flat bright ball
// (a compounding cause of the "milky/washed" look). 0.8 restores a visible falloff
// while staying softer than a literal Lambert (1.0); the 0.25 floor is unchanged so
// the terminator band and cloud shading near the terminator do not crush.
const lambertTermGLSL = /* glsl */ `
float lambertTerm(float NdotL) {
  return mix(0.25, 1.0, pow(clamp(NdotL, 0.0, 1.0), 0.8));
}
`;

// ============================================================================
// SHARED CLOUD COVERAGE RAMP (GLSL)
// ============================================================================
// The alpha window that turns a grayscale cloud texel into coverage. Interpolated
// into BOTH the cloud layer (its rendered alpha, cloudFragmentShader) and the
// surface shader (its cast shadow, earthSurfaceFragmentShader) so the two can
// never drift out of registration — retune the window HERE once and the rendered
// clouds and their cast shadows follow together (P1, 2026-07-20). Dial wider
// (e.g. 0.36→0.86) or narrower to taste; both consumers track it.
const cloudCoverageRampGLSL = /* glsl */ `
#define CLOUD_COVERAGE_LO 0.42
#define CLOUD_COVERAGE_HI 0.80
`;

const earthSurfaceFragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

uniform sampler2D uDayTexture;
uniform sampler2D uNightTexture;
uniform sampler2D uCloudTexture;   // shared with the cloud layer — read for surface shadows
uniform float uCloudRotation;      // cloudMesh.rotation.y, radians (CPU-fed per frame)
uniform vec3 uSunDirection;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;
${simplexNoiseGLSL}
${lambertTermGLSL}
${cloudCoverageRampGLSL}
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

  // UV derivatives hoisted OUTSIDE all branches (P1, 2026-07-20): the night and
  // cloud-shadow fetches below are gated by divergent conditions; implicit-LOD
  // sampling inside such branches is undefined (mip derivatives). textureGrad
  // with these keeps mip/aniso selection well-defined in the boundary quads.
  vec2 uvDx = dFdx(vUv);
  vec2 uvDy = dFdy(vUv);

  // Sample textures
  vec3 dayColor = texture2D(uDayTexture, vUv).rgb;

  // BOLD GRADE (visible pass) — WATER-AWARE (2026-07-19). Applied pre-shading /
  // pre-ACES so it reads across the whole disc regardless of view distance:
  //   1) contrast around an 0.18 linear pivot — punch + apparent depth;
  //   2) saturation — clearly visible colour pop.
  // Ocean sits low in linear space (below the pivot), so a strong global contrast
  // hardened the shallow/deep depth boundary into an unnatural bright band and
  // amplified 8-bit banding in the smooth sea gradient. Fix: detect blue-dominant
  // water from the raw texel and fade the grade toward flat over it — land and
  // clouds keep the full punch, water stays soft and natural.
  //
  // B4.1 (2026-07-20): water metrics hoisted OUT of this block and computed once
  // from the RAW texel, shared with the ocean specular mask below. Previously the
  // spec mask read POST-grade dayColor, so any grade retune (e.g. plan Task 4
  // contrast/sat punch) silently shifted the sheen's spatial extent. Raw-texel
  // inputs make the two water detectors drift-proof; each keeps its own tuned
  // window (grade fade: any water incl. shallow; spec mask: dark open water only).
  float rawSum  = dayColor.r + dayColor.g + dayColor.b;
  float blueDom = dayColor.b / max(rawSum, 0.001);      // ~0.33 neutral, >0.42 water
  float rawDark = 1.0 - rawSum / 3.0;
  float waterW  = smoothstep(0.36, 0.44, blueDom);      // 1 over ocean, 0 over land
  {
    float contrastAmt = mix(1.15, 1.02, waterW);        // full on land, near-flat on water
    float satAmt      = mix(1.25, 1.08, waterW);
    dayColor = max(vec3(0.0), (dayColor - 0.18) * contrastAmt + 0.18);
    float gLuma = dot(dayColor, vec3(0.299, 0.587, 0.114));
    dayColor = mix(vec3(gLuma), dayColor, satAmt);
  }

  // === LIGHTING ===
  float NdotL = dot(normal, uSunDirection);

  // Terminator: smooth transition over ~6 degrees. dayFactor deliberately
  // extends to NdotL = -0.1 so the DIFFUSE surface fades out softly across the
  // terminator (atmospheric refraction / twilight lift the illuminated band a
  // little past the geometric horizon).
  float dayFactor = smoothstep(-0.1, 0.15, NdotL);

  // A specular reflection of the sun (ocean sheen + tight sun-glint) can only
  // exist while the sun is ACTUALLY above the local horizon. normal and
  // uSunDirection are both world-space (A1), so NdotL is the cosine of the sun
  // above the surface tangent plane: NdotL > 0 == sun above horizon. Gate the
  // reflection terms on this rather than dayFactor, which leaks glint up to
  // ~6° below the horizon (mirror point on the far side of the terminator).
  // Tiny 0.5° smoothstep ramp avoids a hard aliased edge at the exact horizon.
  float sunAboveHorizon = smoothstep(0.0, 0.009, NdotL);

  // Specular for oceans. Ratio-based detection for robust ocean masking.
  // B4 (2026-07-20): pow 64 → 160 tightens the broad ocean sheen lobe. With A1
  // fixed, this pow-64 lobe was un-masked and spread a wide white patch centred on
  // the sun mirror point (the "moving milky disc"); ocean albedo is ~0.05 so even
  // a small linear lift reads as wash. 160 keeps a soft sheen but shrinks its area.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfVec = normalize(uSunDirection + viewDir);
  float specular = pow(max(dot(normal, halfVec), 0.0), 160.0);

  // Ocean detection: blue-dominant AND overall dark — raw-texel metrics from above
  // (B4.1: decoupled from the grade so grade retunes can't shift the spec mask).
  // Also feeds the E1 glint and the terrain-detail damping; their extents shift
  // marginally (tighter) with the raw-texel input — benign.
  float oceanMask = smoothstep(0.35, 0.55, blueDom) * smoothstep(0.3, 0.7, rawDark);

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
    // Procedural terrain detail is near-field only. Reverted (2026-07-19) from the
    // C4 "extend to gameplay altitude" experiment: the noise was imperceptible at
    // the 350 km orbital view (it only touches the small nadir patch) yet cost
    // snoise() on the whole lit disc. Distance fade restored to its original
    // ~240 km range AND wrapped in an early-out so orbital altitude pays ZERO
    // snoise (previously terrainDetail ran on every lit fragment regardless).
    float detailFade = smoothstep(0.8, 0.2, viewDist / 3.0); // fades out by ~240 km
    if (detailFade > 0.0) {
      // Uses object-space position for consistent detail as camera moves
      float detail = terrainDetail(normalize(vPosition));
      float detailStrength = 0.15 * detailFade * (1.0 - oceanMask * 0.7);
      dayColor *= 1.0 + detail * detailStrength;

      // Ultra-high-frequency detail tiling. Visible only at very close range (nadir)
      float tileNoise = detailTiling(normalize(vPosition));
      float tileFade = smoothstep(2.0, 0.5, viewDist);  // tighter fade than base detail
      float tileStrength = 0.04 * tileFade * (1.0 - oceanMask * 0.7);
      dayColor *= 1.0 + tileNoise * tileStrength;
    }
  }
#endif

  // Fresnel-enhanced ocean reflection. Grazing angles more reflective.
  // B4.1 (2026-07-20) restructure:
  //  * pow lobe: weight 0.25 (was 0.5), scaled by the incident sun cosine
  //    (clamp(NdotL)) so sheen intensity physically tracks sun elevation —
  //    dayFactor saturates by NdotL=0.15 (~8.6°) and used to leave the sheen
  //    angle-independent from there to noon. NOT lambertTerm(): its 0.25 floor
  //    would keep a quarter of the sheen at the terminator. Warm-tinted
  //    (softer than the E1 glint) so residual sheen reads as sunlight, not milk.
  //  * grazing fresnel RECONTOURED (user decision, headless A/B-measured): at
  //    exponent 3 this term was only "limb-only" at nadir — on oblique views
  //    (menu, horizon-ward gameplay) (1-NdotV)^3 painted a broad pale band over
  //    30-150% of the dark ocean albedo, and pixel diffs proved that band WAS
  //    the oblique milky wash (the lobe/lambert/exposure retunes measured
  //    <2/255 there). Exponent 3→5 + weight 0.15→0.30 keeps the bright thin
  //    rim at the true limb (crossover NdotV≈0.3) while collapsing the broad
  //    band to ~18-50% of its old lift.
  float oceanFresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);
  float sheenLobe = specular * 0.25 * clamp(NdotL, 0.0, 1.0);
  vec3 oceanSpec = oceanMask * dayFactor * sunAboveHorizon
    * (sheenLobe * vec3(1.0, 0.97, 0.90) + vec3(oceanFresnel * 0.30));

  // E1 — Tight ocean sun-glint (the iconic orbital-photo cue). A very sharp
  // (pow 300) highlight where the sun mirrors off the water gives a moving
  // glitter point distinct from the broad sheen lobe above (B4: pow 160).
  // Left untouched by the B4 milky-disc retune — this tight sparkle is working
  // as designed. Warm-tinted like real sun-on-water.
  // B3: with A1 fixed, halfVec now tracks the true sun mirror point (it was
  // misplaced pre-fix). Strength 1.2 → 1.8 starting point (plan allows up to 2.0);
  // pow-300 keeps it tight — may bloom slightly past threshold 4.0 (acceptable
  // sparkle). Verify on screenshots.
  float oceanGlintTerm = pow(max(dot(normal, halfVec), 0.0), 300.0)
    * 1.8 * oceanMask * dayFactor * sunAboveHorizon;
  vec3 oceanGlint = oceanGlintTerm * vec3(1.0, 0.95, 0.8);

  // === CLOUD SHADOWS (P1 visual, 2026-07-20) ===
  // Project the cloud layer's coverage straight down onto the surface and
  // attenuate the direct-sun terms — the orbital-photo depth cue the two-layer
  // stack was missing. Straight-down is near-exact: 10 km cloud altitude means
  // the true sun-projected displacement is ≤ ~2 texels of the 8k map. +Y cloud
  // rotation advances a texel's world longitude by +rot (three SphereGeometry),
  // so the same world point samples the cloud map at u − rot/2π. Shares the
  // CLOUD_COVERAGE_LO→HI ramp (cloudCoverageRampGLSL) with the cloud shader so
  // shadow silhouettes match the rendered clouds. LOW_DETAIL compiles the fetch out (iGPU tier); NO_CLOUD_SHADOWS
  // keeps the ?disableClouds cost-isolation A/B pure; the night hemisphere
  // skips it (litDay ≈ 0 there anyway).
  float cloudShade = 1.0;
#if !defined(LOW_DETAIL) && !defined(NO_CLOUD_SHADOWS)
  if (dayFactor > 0.0) {
    vec2 cloudUv = vec2(fract(vUv.x - uCloudRotation * 0.15915494), vUv.y);
    // Gradients ×3 (P2): biases the fetch ~+1.6 mips — a soft, physically
    // plausible penumbra instead of a cloud-sharp cutout, and a slightly
    // cheaper fetch. Registration (cloudUv) untouched.
    float cloudCover = textureGrad(uCloudTexture, cloudUv, uvDx * 3.0, uvDy * 3.0).r;
    cloudShade = 1.0 - smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI, cloudCover) * 0.35;
  }
#endif

  // === NIGHT SIDE ===
  float nightFactor = smoothstep(0.05, -0.15, NdotL);

  // City lights (P1 perf, 2026-07-20): the 16k/8k night texture is fetched ONLY
  // where nightFactor > 0 — it previously ran on every lit fragment and
  // contributed exactly zero there (nightFactor == 0 across the day side).
  vec3 nightColor = vec3(0.0);
  if (nightFactor > 0.0) {
    nightColor = textureGrad(uNightTexture, vUv, uvDx, uvDy).rgb;
    nightColor *= 2.5;                  // dim in the source texture
    nightColor *= vec3(1.0, 0.85, 0.6); // warm city-light tint
  }

  // === TERMINATOR WARMTH (P2 visual, 2026-07-20) ===
  // Low-sun ground gets warm direct light — the orange band along the dawn/dusk
  // line. The atmosphere (sunset band) and clouds (terminator scatter) already
  // warm here; the surface was the one layer crossing the terminator neutrally.
  // Pure ALU (~5 ops) on values already in scope; zero fetches. Band spans
  // NdotL ∈ (-0.05, 0.30), peaking near 0.08 (~85° sun zenith). Dial: 0.55
  // peak mix strength (range 0.4–0.7), tint (1.0, 0.62, 0.38).
  float sunsetZone = smoothstep(-0.05, 0.08, NdotL) * smoothstep(0.30, 0.08, NdotL);
  vec3 sunTint = mix(vec3(1.0), vec3(1.0, 0.62, 0.38), sunsetZone * 0.55);

  // === COMPOSE ===
  // A2: Lambert modeling term (shared lambertTerm() helper). dayFactor alone
  // saturated to 1.0 across the disc (flat albedo = "map on a ball"); this adds a
  // real luminance gradient from the sub-solar point toward the terminator.
  float lambert = lambertTerm(NdotL);
  vec3 litDay = (dayColor * sunTint * max(0.02, dayFactor * lambert) + oceanSpec + oceanGlint) * cloudShade;

  // Earthshine: faint cool-blue ambient reveals terrain shapes on the dark side
  float nightAmbient = 0.03;
  vec3 nightBase = dayColor * nightAmbient * vec3(0.5, 0.6, 1.0);

  vec3 finalColor = litDay + nightColor * nightFactor + nightBase * (1.0 - dayFactor);

  // Atmospheric limb haze: blue scattering in front of the planet edge so the
  // hard surface silhouette dissolves into the atmosphere shell.
  // T2.2 tightened this (exp 3.2, gain 0.22) to fight the A1-bug disc-center wash.
  // B1: with A1 fixed the fresnel is genuinely limb-only, so it can breathe again —
  // gain 0.22 → 0.32, exponent 3.2 → 2.8 for a livelier limb without disc wash.
  // Verify on screenshots (nadir disc-center must stay clean).
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.8);
  finalColor += vec3(0.30, 0.50, 0.85) * fresnel * 0.32 * dayFactor;

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
  // A1: world-space normal. three.js normalMatrix is the normal matrix of the
  // modelViewMatrix (VIEW space), so the old value rotated with the camera and
  // disagreed with the world-space uSunDirection / cameraPosition / vWorldPosition
  // every fragment lighting term dots against. mat3(modelMatrix) puts the normal
  // in world space to match them (Earth group is unscaled; cloudMesh.rotation.y
  // is handled correctly by modelMatrix).
  vNormal = normalize(mat3(modelMatrix) * normal);
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

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec3 vWorldPosition;
${lambertTermGLSL}
${cloudCoverageRampGLSL}
void main() {
  vec3 normal = normalize(vNormal);

  // Sample cloud texture. Use brightness as alpha
  vec3 cloudSample = texture2D(uCloudTexture, vUv).rgb;
  float cloudAlpha = (cloudSample.r + cloudSample.g + cloudSample.b) / 3.0;

  // Shape: crisp cloud edges via a TIGHT alpha ramp + high opacity (bold pass,
  // 2026-07-19). The 8k cloud map is bilinear-magnified (~5 km/texel), which
  // smears the day/clear boundary into haze. A narrow contrast window
  // (CLOUD_COVERAGE_LO→HI, shared with the surface shadow ramp) sharpens that
  // transition across the WHOLE disc — the altitude-independent replacement for
  // the reverted near-field C5 erosion. Higher max opacity (0.92) reads as
  // denser, more solid cloud masses instead of washed-out translucency.
  // Trade-off: the tight low edge drops the faintest wisps. Retune the window in
  // cloudCoverageRampGLSL (both clouds + their cast shadows follow) or opacity
  // down here if it looks hard/aliased.
  cloudAlpha = smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI, cloudAlpha);
  // P2 (2026-07-20): clear-sky early-out. smoothstep is exactly 0.0 at/below
  // CLOUD_COVERAGE_LO, so ~half the sphere's fragments (clear sky) previously
  // ran the full lighting path plus a blend op that contributed nothing.
  // Bit-exact zero visual delta; skips ALU + ROP/blend (the overdraw-heaviest
  // layer). Same pattern as the atmosphere's lum < 0.002 discard.
  if (cloudAlpha <= 0.0) discard;
  cloudAlpha *= 0.92; // Max opacity

  // Lighting
  float NdotL = dot(normal, uSunDirection);
  float dayFactor = smoothstep(-0.1, 0.2, NdotL);

  // A2: reuse the shared lambertTerm() helper so day-side clouds shade with the
  // sun angle identically to the surface (the two can't drift). dayFactor still
  // gates the day/night blend and the terminator scatter below (unchanged).
  float lambert = lambertTerm(NdotL);

  // Cloud color: bright white in sunlight, dark gray in shadow.
  // B2: cloudDay 0.90 → ~0.97. T2.4 pulled it off pure white to protect the ACES
  // shoulder; with A2's lambert term now shading the day side, clouds can read
  // brighter white near noon (grey near terminator) without clipping.
  vec3 cloudDay = vec3(0.97, 0.98, 1.00);
  vec3 cloudNight = vec3(0.05, 0.06, 0.08);
  vec3 cloudColor = mix(cloudNight, cloudDay * lambert, dayFactor);

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
  // T2.3: lowCol base pulled toward electric blue (0.75,0.88,1.00)→(0.60,0.80,1.00)
  // so the limb reads saturated blue rather than white now that ACES no longer
  // clips it to a flat plateau.
  vec3 lowCol  = vec3(0.60, 0.80, 1.00);
  vec3 midCol  = vec3(0.25, 0.55, 1.00);
  vec3 highCol = vec3(0.15, 0.25, 0.90);
  vec3 rayleigh = mix(lowCol, midCol, smoothstep(0.0, 0.45, h01));
  rayleigh = mix(rayleigh, highCol, smoothstep(0.45, 1.0, h01));

  // === TERMINATOR: narrow saturated sunset band at the day/night line ===
  // T2.3: blend 0.85→0.92 for a more saturated sunset now that the shoulder
  // keeps it from blowing out.
  float terminatorZone = smoothstep(-0.18, 0.02, NdotL) * smoothstep(0.22, 0.02, NdotL);
  vec3 sunset = mix(vec3(1.0, 0.25, 0.08), vec3(1.0, 0.55, 0.20), h01);
  vec3 scatter = mix(rayleigh, sunset, terminatorZone * 0.92);

  // === MIE forward scatter: gold hotspot when looking TOWARD the sun ===
  // (rayDir, not viewDir — dot(viewDir,sun) was backscatter, a bug.)
  float VdotS = max(dot(rayDir, uSunDirection), 0.0);
  float v2 = VdotS * VdotS;
  float mie = v2 * v2 * v2;

  // === LINEAR ADDITIVE OUTPUT (alpha=1; falloff lives in rgb) ===
  // T2.3: limb multiplier 2.2→1.8. The old value clipped to a white plateau under
  // pass-through; with ACES rolloff now active a lower value gives a smooth
  // electric-blue gradient instead of an overexposed band.
  vec3 atmos = scatter * density * dayFactor * 1.8;
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
// TEXTURE LOADER + AVIF SUPPORT PROBE (PR P0.1)  +  OFF-THREAD PICTURES (st3)
// ============================================================================
//
// AVIF compresses Earth textures ~5× smaller than JPG at visually equivalent
// quality (e.g. earth_day_16k: 19 MB JPG → 3.9 MB AVIF). We probe browser AVIF
// support once at module load via Image.decode() on a 1×1 AVIF data-URL and
// cache the boolean. loadTexture() then prefers the `.avif` sibling on
// supporting browsers (Chrome 85+, Edge 85+, Firefox 93+, Safari 16+) and
// transparently falls back to the original `.jpg` everywhere else.
//
// st3-earth-quick (2026-10-18): the three Earth pictures used to be decoded and
// uploaded in one 3.8 s block at the first draw (phase-1 measurement,
// docs/research/2026-10-startup.md). They are now decoded OFF the main thread
// with THREE.ImageBitmapLoader, and each bitmap is freed after its upload
// (see onEarthTextureUpdate / attachEarthRestore). A second module-level probe
// (probeBitmapOrientation) proves the bitmap path puts north up with the same
// texels before it is used; if it fails, or there is no DOM, every file takes
// the old TextureLoader path.
//
// The probes use top-level await so the booleans are settled before any Earth
// instance is constructed. In non-browser environments (Node test runner) the
// `Image` global is absent, both probes short-circuit to `false`, and Earth.js
// continues to behave exactly as before — important because test-EarthLOD.js
// imports `selectLOD` from this module.
let textureLoader = new THREE.TextureLoader();

// 2×2 AVIF still-picture, av1 codec, ~311 bytes. Generated locally with
// `ffmpeg -f lavfi -i color=c=black:s=2x2 -c:v libaom-av1 -still-picture 1
//  -crf 30 -b:v 0` and verified to decode cleanly with libavif's avifdec.
// Sufficient payload to verify the browser ships a working AVIF decoder —
// `Image.decode()` will reject on the data-URL if AVIF is not supported.
const AVIF_PROBE_DATA_URL =
  'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAWAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAACAAAAAgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAebWRhdAoFGAA2wCAyDReAAABIAAAADAZusnI=';

async function probeAvifSupport() {
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
}

/** createImageBitmap options of the bitmap path (three adds colorSpaceConversion 'none'). */
const BITMAP_LOADER_OPTIONS = Object.freeze({ imageOrientation: 'flipY', premultiplyAlpha: 'none' });

/**
 * st3 D3 self-test gate: does the off-thread bitmap path give the same picture
 * the HTML-image path gives? Draws a tiny canvas (top row red, bottom row
 * blue), encodes it to PNG, decodes it with `createImageBitmap(blob, …exact
 * loader options…)`, draws the bitmap back and reads it. True only when the
 * rows came back flipped (imageOrientation 'flipY' honoured; three ignores
 * texture.flipY for bitmaps). False — never a throw — with no DOM, no
 * createImageBitmap, or any failure; the caller then uses the old path.
 *
 * @param {{doc?: Document, createBitmap?: Function}} [inputs]  injectable for tests
 * @returns {Promise<boolean>}
 */
export async function probeBitmapOrientation({ doc, createBitmap } = {}) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const make = createBitmap || (typeof createImageBitmap === 'function' ? createImageBitmap : null);
    if (!d || !make) return false;
    const src = d.createElement('canvas');
    src.width = 2; src.height = 2;
    const sctx = src.getContext('2d');
    sctx.fillStyle = 'rgb(255,0,0)'; sctx.fillRect(0, 0, 2, 1); // top row red
    sctx.fillStyle = 'rgb(0,0,255)'; sctx.fillRect(0, 1, 2, 1); // bottom row blue
    const blob = await new Promise((resolve, reject) => {
      src.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob gave null'))), 'image/png');
    });
    const bmp = await make(blob, { ...BITMAP_LOADER_OPTIONS, colorSpaceConversion: 'none' });
    try {
      if (!bmp || bmp.width !== 2 || bmp.height !== 2) return false;
      const dst = d.createElement('canvas');
      dst.width = 2; dst.height = 2;
      const dctx = dst.getContext('2d');
      dctx.drawImage(bmp, 0, 0);
      const top = dctx.getImageData(0, 0, 1, 1).data;
      const bottom = dctx.getImageData(0, 1, 1, 1).data;
      return top[2] > 200 && top[0] < 55 && bottom[0] > 200 && bottom[2] < 55;
    } finally {
      try { bmp && bmp.close && bmp.close(); } catch (_e) { /* best effort */ }
    }
  } catch (_e) {
    return false;
  }
}

/** Longest start-up wait for the orientation self-test (ms) before the old image path is used. */
export const BITMAP_PROBE_TIMEOUT_MS = 500;

/**
 * Race the self-test against a timer so a callback that never fires (e.g. a
 * `toBlob` that is never called) cannot hang module evaluation, and with it the
 * game's start. Resolves false on timeout, on a throw, or on a non-true result;
 * the timer is cleared when the test wins. A late result is ignored.
 *
 * @param {() => Promise<boolean>} [test]  the self-test (injectable for tests)
 * @param {number} [ms]
 * @returns {Promise<boolean>}
 */
export function gateBitmapProbe(test = probeBitmapOrientation, ms = BITMAP_PROBE_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const run = (async () => {
    try { return (await test()) === true; } catch (_e) { return false; }
  })();
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// ----------------------------------------------------------------------------
// st8 (2026-10-19): the decode itself in a Worker.
// ImageBitmapLoader's createImageBitmap(blob, {imageOrientation:'flipY', …}) still
// RESOLVES on the main thread, and the flip makes that one frame 105–160 ms long
// when each 16k picture arrives (probe: 108–125 ms main thread, 9 ms with the same
// call in a Worker, 0 of 134 M pixels different; docs/research/2026-10-startup.md,
// "Phase 5"). So the file is fetched AND decoded in one inline Worker (no new
// file) and the finished bitmap is transferred back; everything after that (the
// strips, the one-shot upload, the pixel check) is unchanged. The worker is used
// only after the same 2×2 orientation self-test passed INSIDE the worker; on any
// worker problem the main-thread ImageBitmapLoader path runs as before.
// ----------------------------------------------------------------------------

/** createImageBitmap options of the worker path: exactly what three's loader passes. */
export const WORKER_DECODE_OPTIONS = Object.freeze({ ...BITMAP_LOADER_OPTIONS, colorSpaceConversion: 'none' });

/**
 * The worker's program. Written as a function so node tests can run it against a
 * fake scope; the browser gets its source text (`DECODE_WORKER_SOURCE`). It must
 * stay self-contained (no closure over this module). Messages in:
 *   {id, type:'selftest', options}     → {id, ok}
 *   {id, type:'decode', url, options}  → {id, bitmap} (transferred) | {id, error}
 * `fetch` uses the default (same-origin) credentials, like three's loader with
 * crossOrigin 'anonymous'; the page's service worker serves it when the page is
 * controlled (probe: blob-URL workers inherit the page's controller).
 * @param {object} scope  the worker's global (`self`)
 */
export function decodeWorkerMain(scope) {
  async function selfTest(options) {
    const OC = scope.OffscreenCanvas;
    const src = new OC(2, 2);
    const g = src.getContext('2d');
    g.fillStyle = 'rgb(255,0,0)'; g.fillRect(0, 0, 2, 1); // top row red
    g.fillStyle = 'rgb(0,0,255)'; g.fillRect(0, 1, 2, 1); // bottom row blue
    const blob = await src.convertToBlob({ type: 'image/png' });
    const bmp = await scope.createImageBitmap(blob, options);
    try {
      if (!bmp || bmp.width !== 2 || bmp.height !== 2) return false;
      const d = new OC(2, 2).getContext('2d');
      d.drawImage(bmp, 0, 0);
      const top = d.getImageData(0, 0, 1, 1).data;
      const bottom = d.getImageData(0, 1, 1, 1).data;
      return top[2] > 200 && top[0] < 55 && bottom[0] > 200 && bottom[2] < 55;
    } finally {
      try { bmp && bmp.close && bmp.close(); } catch (_e) { /* best effort */ }
    }
  }
  scope.onmessage = async (e) => {
    const m = e.data || {};
    let bmp = null;
    try {
      if (m.type === 'selftest') { scope.postMessage({ id: m.id, ok: (await selfTest(m.options)) === true }); return; }
      const res = await scope.fetch(m.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      bmp = await scope.createImageBitmap(await res.blob(), m.options);
      scope.postMessage({ id: m.id, bitmap: bmp }, [bmp]);
      bmp = null; // moved to the page
    } catch (err) {
      try { bmp && bmp.close && bmp.close(); } catch (_e) { /* best effort */ }
      scope.postMessage({ id: m.id, error: String((err && err.message) || err) });
    }
  };
}

/** A decode request with no answer for this long fails (ms); a 16k AVIF is 4 MB, so this is generous even on a slow link. */
export const WORKER_DECODE_TIMEOUT_MS = 90000;

/** The worker's source text (a classic script). */
export const DECODE_WORKER_SOURCE = `(${decodeWorkerMain.toString()})(self);`;

/**
 * Main-thread end of the decode worker: one promise per request, ids to match
 * the replies. Any worker error (script error, message error) fails every
 * pending request and marks the worker dead; callers then use the main-thread
 * loader. Wraps anything with postMessage / onmessage / onerror / terminate.
 */
export class EarthDecodeWorker {
  /**
   * @param {{postMessage: Function, terminate?: Function}} worker
   * @param {object} [options]  createImageBitmap options sent with every request
   * @param {number} [timeoutMs]  a decode request that gets no answer for this long fails (the
   *   page then uses the main-thread loader); a browser can kill a worker without telling us
   */
  constructor(worker, options = WORKER_DECODE_OPTIONS, timeoutMs = WORKER_DECODE_TIMEOUT_MS) {
    this.worker = worker;
    this.options = { ...options };
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.dead = false;
    worker.onmessage = (e) => this._reply(e && e.data);
    worker.onerror = (e) => this._die(new Error(`decode worker error: ${(e && e.message) || 'unknown'}`));
    worker.onmessageerror = () => this._die(new Error('decode worker message error'));
  }

  _reply(data) {
    const p = data && this.pending.get(data.id);
    if (!p) { if (data && data.bitmap) closeBitmap(data.bitmap); return; }
    this.pending.delete(data.id);
    clearTimeout(p.timer);
    if (data.error) p.reject(new Error(String(data.error)));
    else p.resolve(data);
  }

  _die(err) {
    this.dead = true;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { clearTimeout(p.timer); p.reject(err); }
  }

  _send(msg) {
    if (this.dead) return Promise.reject(new Error('decode worker is dead'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry = { resolve, reject, timer: null };
      this.pending.set(id, entry);
      if (msg.type === 'decode' && this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`decode worker timeout after ${this.timeoutMs} ms`));
        }, this.timeoutMs);
      }
      try {
        this.worker.postMessage({ ...msg, id, options: { ...this.options } });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  /** @returns {Promise<boolean>} the orientation self-test, run inside the worker */
  selfTest() { return this._send({ type: 'selftest' }).then((r) => r.ok === true); }

  /**
   * Fetch and decode one picture in the worker.
   * @param {string} url  absolute (a blob: worker cannot resolve relative paths)
   * @returns {Promise<ImageBitmap>}
   */
  decode(url) {
    return this._send({ type: 'decode', url }).then((r) => {
      if (!r.bitmap) throw new Error('decode worker sent no bitmap');
      return r.bitmap;
    });
  }

  terminate() {
    if (this.terminated) return; // each rejected request's handler retires the worker again
    this.terminated = true;
    // Requests still in flight are rejected, not dropped: each caller then falls back to the
    // main-thread loader (the message is not "HTTP nnn", so it is not read as a missing file).
    this._die(new Error('decode worker retired'));
    try { this.worker.terminate && this.worker.terminate(); } catch (_e) { /* best effort */ }
  }
}

/** Absolute URL of a page-relative path (the worker's fetch has no usable base). */
function absoluteUrl(path) {
  try {
    const base = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' && location.href) || undefined;
    return new URL(path, base).href;
  } catch (_e) {
    return path;
  }
}

/** The decode worker, once its self-test passed; null = decode on the main thread. */
let decodeWorker = null;
/** null while the worker's self-test runs; true / false afterwards. */
let workerPathOk = null;

/**
 * Start the worker and its self-test (bounded by the same 500 ms as the main-thread
 * test). Never throws; resolves false with no DOM / Worker / Blob URL support.
 * @returns {Promise<boolean>}
 */
async function probeWorkerDecode() {
  let w = null;
  let blobUrl = null;
  try {
    if (typeof document === 'undefined' || typeof Worker === 'undefined' || typeof Blob === 'undefined'
      || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
    blobUrl = URL.createObjectURL(new Blob([DECODE_WORKER_SOURCE], { type: 'text/javascript' }));
    w = new EarthDecodeWorker(new Worker(blobUrl));
    const ok = await gateBitmapProbe(() => w.selfTest());
    // the worker has loaded its script by now (or never will): the blob is not needed any more
    try { URL.revokeObjectURL(blobUrl); } catch (_e) { /* best effort */ }
    if (!ok) { w.terminate(); return false; }
    decodeWorker = w;
    return true;
  } catch (_e) {
    try { w && w.terminate(); } catch (_e2) { /* best effort */ }
    try { blobUrl && URL.revokeObjectURL(blobUrl); } catch (_e3) { /* best effort */ }
    return false;
  }
}

// Not awaited by module evaluation (the self-test starts now, in parallel with the
// two probes below; a picture asked for before it ends waits for it, see
// loadLevel). So the start-up wait is exactly what it was before the worker.
let workerProbe = probeWorkerDecode().then((ok) => {
  if (workerPathOk === null) workerPathOk = ok === true;
  if (typeof console !== 'undefined' && typeof document !== 'undefined') {
    console.log(`[Earth] picture decode in a worker: ${workerPathOk ? 'YES' : 'NO (main-thread bitmap loader)'}`);
  }
  return workerPathOk;
});

// Both probes run in parallel (no added wait at module load); the bitmap
// self-test is bounded by BITMAP_PROBE_TIMEOUT_MS. The AVIF probe is not.
const [avifSupported, bitmapProbeResult] = await Promise.all([probeAvifSupport(), gateBitmapProbe()]);
let bitmapPathOk = bitmapProbeResult === true;

if (typeof console !== 'undefined' && typeof document !== 'undefined') {
  console.log(`[Earth] AVIF support: ${avifSupported ? 'YES (preferring .avif)' : 'NO (falling back to .jpg)'}`);
  console.log(`[Earth] off-thread picture decode: ${bitmapPathOk ? 'YES (ImageBitmap)' : 'NO (image loader)'}`);
}

/**
 * Module-level getter so external code (e.g. [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1))
 * can surface AVIF capability without touching the private module variable.
 * @returns {boolean} Whether the browser successfully decoded the AVIF probe.
 */
export function isAvifSupported() {
  return avifSupported === true;
}

/** @returns {boolean} Whether Earth pictures are decoded off-thread (st3 D3 probe passed). */
export function isBitmapPathSupported() {
  return bitmapPathOk === true;
}

/** @returns {boolean} Whether the pictures are decoded in a Worker (st8; false while its self-test still runs). */
export function isWorkerDecodeSupported() {
  return bitmapPathOk === true && workerPathOk === true && !!decodeWorker && !decodeWorker.dead;
}

let bitmapLoader = null;
/** st6 test seam: true / false forces the strip path on / off; null = decide from the browser. */
let stripsForced = null;
/** st7 test seam: replaces the run-time pixel check of the strip path (see EarthStripFeeder.verify). */
let stripCheckHook = null;
/** Created lazily: node has no createImageBitmap and a module-level `new` would warn in every test. */
function getBitmapLoader() {
  if (!bitmapLoader) bitmapLoader = new THREE.ImageBitmapLoader().setOptions({ ...BITMAP_LOADER_OPTIONS });
  return bitmapLoader;
}

/**
 * Test seam: inject a fake bitmap loader / image loader, the D3 result and the
 * strip switch (st6; null = decide from the browser). Returns a function that
 * restores the previous state.
 * st7: `stripCheck(renderer, feeder)` (boolean or promise of one) replaces the run-time pixel check.
 * st8: `decodeWorker` (an EarthDecodeWorker-like object, or null for "no worker") replaces
 * the decode worker; `offlineEnv` replaces what the 16k-for-offline step reads from the browser;
 * `firstFrame: false` keeps the worker waiting for the game's first frame (default after
 * injecting a worker: already drawn); `firstFrameTimeoutMs` shortens the hidden-tab fallback;
 * `pendingWorker` (a worker-like) leaves its self-test "still running" until the returned
 * function's `.settleWorker(true|false)` is called.
 * @param {{bitmapLoader?: object|null, imageLoader?: object, bitmapOk?: boolean, stripsOk?: boolean|null, stripCheck?: Function|null, decodeWorker?: object|null, offlineEnv?: object|null}} o
 */
export function setEarthLoadersForTests({ bitmapLoader: bl, imageLoader, bitmapOk, stripsOk, stripCheck, decodeWorker: dw, offlineEnv, firstFrame, firstFrameTimeoutMs, pendingWorker } = {}) {
  const prev = {
    bl: bitmapLoader, il: textureLoader, ok: bitmapPathOk, st: stripsForced, ck: stripCheckHook,
    dw: decodeWorker, wok: workerPathOk, oe: offlineEnvOverride, od: ensuredOffline,
    ff: firstFrameSeen, fw: frameWaiters, ft: firstFrameFallbackMs, ftm: frameTimers, wp: workerProbe,
  };
  if (bl !== undefined) bitmapLoader = bl;
  if (imageLoader !== undefined) textureLoader = imageLoader;
  if (bitmapOk !== undefined) bitmapPathOk = bitmapOk === true;
  if (stripsOk !== undefined) stripsForced = stripsOk === null ? null : stripsOk === true;
  if (stripCheck !== undefined) stripCheckHook = stripCheck;
  if (dw !== undefined) { decodeWorker = dw; workerPathOk = dw !== null; }
  if (offlineEnv !== undefined) { offlineEnvOverride = offlineEnv; ensuredOffline = new Set(); }
  // A test that injects a worker gets the "first frame is drawn" state unless it asks for the pre-frame state.
  if (dw !== undefined || firstFrame !== undefined) { firstFrameSeen = firstFrame !== false; frameWaiters = []; }
  if (firstFrameTimeoutMs !== undefined) firstFrameFallbackMs = firstFrameTimeoutMs;
  let settleWorker = null;
  if (pendingWorker !== undefined) {
    // the worker's self-test "still running": pictures wait; settleWorker(true|false) ends it
    decodeWorker = pendingWorker; workerPathOk = null;
    workerProbe = new Promise((resolve) => {
      settleWorker = (ok) => { workerPathOk = ok === true; resolve(workerPathOk); };
    });
  }
  const restore = () => {
    bitmapLoader = prev.bl; textureLoader = prev.il; bitmapPathOk = prev.ok; stripsForced = prev.st; stripCheckHook = prev.ck;
    decodeWorker = prev.dw; workerPathOk = prev.wok; offlineEnvOverride = prev.oe; ensuredOffline = prev.od;
    firstFrameSeen = prev.ff; frameWaiters = prev.fw; firstFrameFallbackMs = prev.ft;
    for (const id of frameTimers) clearTimeout(id);
    frameTimers = prev.ftm; workerProbe = prev.wp;
  };
  restore.settleWorker = (ok) => { if (settleWorker) settleWorker(ok); };
  return restore;
}

/**
 * OPEN-2 triage (night-side city lights black on 16k / ANGLE-Metal): every
 * texture-load outcome is also recorded into `window.__earthTexEvents` so the
 * `?bfp` badge-click dump carries decode/fallback history — the user is done
 * with console work, and a silent AVIF decode failure of the 512 MB night map
 * (handle live, image empty → samples black) is exactly the E2 hypothesis this
 * must witness. Capped ring, try/catch'd, no-op outside the DOM (Node tests).
 *
 * @param {string} kind   'loaded' | 'avif-fail' | 'bitmap-fail' | 'fallback-loaded' | 'error'
 * @param {string} file   path as requested
 * @param {{width?: number, height?: number}|null} image  decoded image, if any
 */
function recordTexEvent(kind, file, image) {
  try {
    if (typeof window === 'undefined') return;
    const log = (window.__earthTexEvents = window.__earthTexEvents || []);
    log.push({
      t: Math.round((typeof performance !== 'undefined' ? performance.now() : 0)),
      kind,
      file: String(file).split('/').pop(),
      w: image && image.width ? image.width : 0,
      h: image && image.height ? image.height : 0,
    });
    if (log.length > 40) log.shift();
  } catch (_e) { /* diagnostics must never break texture loading */ }
}

/** Boot-timeline mark (?logBoot=1) — same text as before st3, so probes keep reading it. */
function bootMark(text) {
  try {
    // eslint-disable-next-line no-undef
    window.__bootMark?.(text);
  } catch (_e) { /* swallow — diagnostic only */ }
}

/** True when `img` is an ImageBitmap-like object that has not been closed yet. */
function isOpenBitmap(img) {
  return !!img && typeof img.close === 'function' && img.width > 0;
}

/**
 * Give a texture a new picture. A texture that has been uploaded once keeps its
 * GL storage (three allocates immutable storage once per GL texture), so the
 * texture is disposed first — otherwise a bigger picture would go into the old
 * (e.g. 1×1 restore placeholder) storage and the Earth would stay blank.
 */
function setEarthImage(tex, image) {
  if (tex.userData.uploaded) tex.dispose();
  tex.image = image;
  tex.needsUpdate = true;
}

/**
 * `texture.onUpdate` (three calls it after every upload). Acts only when
 * `tex.image` is an open ImageBitmap at call time: remember its size for the
 * diagnostics (a closed bitmap reads 0×0), then free its memory. The 1×1
 * restore placeholder is ignored.
 * st8: a one-shot upload of the tier's own picture also counts as "complete" for
 * the 16k-for-offline step (the strip path reports through Earth._setPicture).
 */
function onEarthTextureUpdate(tex) {
  tex.userData.uploaded = true;
  const img = tex.image;
  if (img && !img.isPlaceholder) notePictureComplete(tex);
  if (!isOpenBitmap(img)) return;
  tex.userData.uploadedWidth = img.width;
  tex.userData.uploadedHeight = img.height;
  try { img.close(); } catch (_e) { /* best effort */ }
}

/**
 * st8 D3: the files of one picture, best first: the tier's own file, then each
 * smaller tier (16k → 8k → base). Pure; exported for tests.
 * @param {string} path  JPG path as given to loadTexture, e.g. 'textures/earth_day_16k.jpg'
 * @returns {string[]}
 */
export function pictureChain(path) {
  const m = /^(.*\/earth_(?:day|night|clouds))(_16k|_8k)?(\.jpg)$/i.exec(path);
  if (!m) return [path];
  const [, stem, tier, ext] = m;
  if (tier === '_16k') return [path, `${stem}_8k${ext}`, `${stem}${ext}`];
  if (tier === '_8k') return [path, `${stem}${ext}`];
  return [path];
}

/** The sources of a texture, best first; entry 0 is `tex.userData.src` itself (which keeps the tier's real path for a restore). */
function tierSources(src) {
  return pictureChain(src.path).map((p, i) => (i === 0 ? src
    : { path: p, useAvif: src.useAvif, initialPath: src.useAvif ? p.replace(/\.jpg$/i, '.avif') : p }));
}

const fileName = (p) => String(p).split('/').pop();

/** Load (or reload) the picture of an Earth texture into `tex`. */
function loadEarthImage(tex) {
  const seq = (tex.userData.loadSeq = (tex.userData.loadSeq || 0) + 1);
  delete tex.userData.loadedLevel;
  loadLevel(tex, seq, 0);
}

/**
 * The next smaller tier of a picture whose file could not be had on any path
 * (offline, 404, undecodable). Logs one line naming it. False when there is none
 * (the texture then samples black, as before).
 */
function nextTier(tex, seq, level) {
  if (tex.userData.loadSeq !== seq) return true;
  const sources = tierSources(tex.userData.src);
  const next = sources[level + 1];
  if (!next) return false;
  console.warn(`[Earth] ${fileName(sources[level].initialPath)} could not be loaded — showing the smaller ${fileName(next.initialPath)} instead (a reload tries the full picture again)`);
  recordTexEvent('tier-fallback', next.initialPath, null);
  loadLevel(tex, seq, level + 1);
  return true;
}

/** True once the game has drawn a frame (Earth.tickStrips ran, or the fallback timer fired). */
let firstFrameSeen = false;
let frameWaiters = [];
let frameTimers = [];
/** If no frame ever ticks (hidden tab), the worker decodes anyway after this long (ms). */
export const FIRST_FRAME_FALLBACK_MS = 5000;
let firstFrameFallbackMs = FIRST_FRAME_FALLBACK_MS;

/** Runs `fn` once, after the game's first frame (or at once if it has been drawn). */
function afterFirstFrame(fn) {
  if (firstFrameSeen) { fn(); return; }
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  frameWaiters.push(once);
  if (typeof setTimeout === 'function') frameTimers.push(setTimeout(once, firstFrameFallbackMs));
}

/** Earth.tickStrips (the game loop's per-frame call) reports the first frame. */
function noteFirstFrame() {
  if (firstFrameSeen) return;
  firstFrameSeen = true;
  const waiting = frameWaiters;
  frameWaiters = [];
  for (const id of frameTimers) clearTimeout(id);
  frameTimers = [];
  for (const fn of waiting) fn();
}

/** Stop using the decode worker for pictures asked for from now on (requests in flight are rejected by terminate(), so they fall back to the main-thread loader). */
function retireWorker(w) {
  if (decodeWorker !== w) return;
  workerPathOk = false;
  try { w.terminate(); } catch (_e) { /* best effort */ }
}

/** The decode worker to use right now, or null (main-thread loader). */
function usableWorker() {
  return bitmapPathOk && workerPathOk === true && decodeWorker && !decodeWorker.dead ? decodeWorker : null;
}

/**
 * One tier of a picture: worker decode (st8) → main-thread bitmap loader → HTML
 * image (AVIF, then JPG); when all of those fail, the next smaller tier (st8 D3).
 */
function loadLevel(tex, seq, level) {
  const src = tierSources(tex.userData.src)[level];
  const { initialPath } = src;
  if (!bitmapPathOk) { loadViaImageLoader(tex, seq, level); return; }
  const stale = () => tex.userData.loadSeq !== seq;

  // A decoded bitmap has arrived (from the worker or the main-thread loader).
  const arrive = (bmp) => {
    if (stale()) { closeBitmap(bmp); return; }
    const place = () => {
      try {
        const dims = `${bmp.width}×${bmp.height}`;
        tex.userData.loadedLevel = level;
        // st6: on a strip-capable browser the picture is queued and reaches the
        // GPU one strip per frame; this texture stays empty until the finished
        // one replaces it (Earth._setPicture). Otherwise: one-shot, as before.
        const sp = tex.userData.strips;
        if (sp && sp.feeder.accepts(bmp)) sp.feeder.enqueue(tex, bmp, sp.priority, sp.onReady);
        else setEarthImage(tex, bmp);
        console.log(`[Earth] Loaded: ${initialPath} (${dims})`);
        recordTexEvent('loaded', initialPath, { width: bmp.width, height: bmp.height });
        // §13 boot timeline (?logBoot=1): no-op when the flag is off.
        bootMark(`Earth texture decoded: ${initialPath.split('/').pop()} (${dims})`);
      } catch (e) {
        console.error(`[Earth] Texture arrival failed: ${initialPath}`, e);
      }
    };
    // st7: the run-time pixel check of the strip path normally finishes long
    // before a 16k picture is decoded; if not, this picture waits for it.
    const feeder = tex.userData.strips && tex.userData.strips.feeder;
    if (feeder && feeder.verdict === null) {
      feeder.verify().then(() => {
        if (stale()) { closeBitmap(bmp); return; }
        place();
      });
    } else place();
  };

  // Today's path: three's ImageBitmapLoader on the main thread.
  const viaLoader = () => {
    let settled = false;
    getBitmapLoader().load(
      initialPath,
      (bmp) => {
        if (settled) return;
        settled = true;
        arrive(bmp);
      },
      undefined,
      (err) => {
        if (settled) return;
        settled = true;
        if (stale()) return;
        console.warn(`[Earth] bitmap load failed for ${initialPath}, using the image loader`, err);
        recordTexEvent('bitmap-fail', initialPath, null);
        loadViaImageLoader(tex, seq, level);
      }
    );
  };

  // st8: fetch + decode in the worker; any worker failure → the main-thread loader.
  const viaWorker = (w) => {
    w.decode(absoluteUrl(initialPath)).then(arrive, (err) => {
      // A decode failure (not a missing file) means this browser's worker cannot decode what
      // the 2×2 PNG self-test could not show (AVIF in a worker, a killed worker): stop using it.
      if (!/^HTTP \d{3}/.test(String((err && err.message) || err))) retireWorker(w);
      if (stale()) return;
      console.warn(`[Earth] worker decode failed for ${initialPath}, using the main-thread bitmap loader`, err);
      recordTexEvent('worker-fail', initialPath, null);
      viaLoader();
    });
  };

  const start = () => {
    if (stale()) return;
    const w = usableWorker();
    // st8: the worker starts decoding after the game's first frame, not during
    // start-up (measured: decoding in parallel with the boot made the menu 30-95 ms
    // later and landed the pictures in the first game-loop frame); the old
    // main-thread path is unchanged.
    if (w) afterFirstFrame(() => { if (!stale()) viaWorker(w); }); else viaLoader();
  };
  // The worker's self-test normally ended long before the first picture is asked for.
  if (workerPathOk === null) workerProbe.then(start); else start();
}

/**
 * The pre-st3 path (HTML image via THREE.TextureLoader, AVIF → JPG fallback),
 * assigning into the already-returned texture. three honours `flipY` only for
 * HTML images, so it is set to true before one is assigned.
 * st8: `level` picks the tier's file (see tierSources); when neither the AVIF nor
 * the JPG of a tier can be had, the next smaller tier is tried.
 */
function loadViaImageLoader(tex, seq, level = 0) {
  const { path, useAvif, initialPath } = tierSources(tex.userData.src)[level];
  const stale = () => tex.userData.loadSeq !== seq;
  textureLoader.load(
    initialPath,
    (loaded) => {
      if (stale()) return;
      tex.flipY = true;
      tex.userData.loadedLevel = level;
      setEarthImage(tex, loaded.image);
      console.log(`[Earth] Loaded: ${initialPath} (${loaded.image?.width}×${loaded.image?.height})`);
      recordTexEvent('loaded', initialPath, loaded.image);
      bootMark(`Earth texture decoded: ${initialPath.split('/').pop()} (${loaded.image?.width}×${loaded.image?.height})`);
    },
    undefined,
    (err) => {
      if (stale()) return;
      if (useAvif) {
        // AVIF file missing or decode failed at runtime — fall back to JPG.
        console.warn(`[Earth] AVIF load failed for ${initialPath}, falling back to ${path}`, err);
        recordTexEvent('avif-fail', initialPath, null);
        textureLoader.load(path, (loaded) => {
          if (stale()) return;
          tex.flipY = true;
          tex.userData.loadedLevel = level;
          setEarthImage(tex, loaded.image);
          console.log(`[Earth] Loaded fallback: ${path} (${loaded.image?.width}×${loaded.image?.height})`);
          recordTexEvent('fallback-loaded', path, loaded.image);
          bootMark(`Earth texture decoded (fallback): ${path.split('/').pop()} (${loaded.image?.width}×${loaded.image?.height})`);
        }, undefined, (err2) => {
          // Both AVIF and JPG failed — the next smaller tier, else the texture will sample black forever.
          console.error(`[Earth] Fallback JPG load ALSO failed: ${path}`, err2);
          recordTexEvent('error', path, null);
          nextTier(tex, seq, level);
        });
      } else {
        console.error(`[Earth] Texture load failed: ${path}`, err);
        recordTexEvent('error', path, null);
        nextTier(tex, seq, level);
      }
    }
  );
}

/**
 * Load a texture, preferring the .avif sibling when the browser supports AVIF.
 * The Texture is returned at once and its picture arrives later. Pictures are
 * decoded off the main thread (ImageBitmapLoader) when the D3 self-test passed;
 * any bitmap failure reissues the load through THREE.TextureLoader (which keeps
 * the AVIF → JPG fallback) and patches the image into the returned texture so
 * the material binding stays valid.
 *
 * @param {string} path  JPG path (e.g. 'textures/earth_day_16k.jpg'). When AVIF
 *                       is supported, the .jpg suffix is rewritten to .avif.
 * @param {number} [anisotropy=8]
 * @param {{feeder: EarthStripFeeder, priority: number, onReady: Function}|null} [strips]
 *   st6: when given, a bitmap that the feeder accepts is built into a separate
 *   texture in strips and `onReady(finishedTexture)` is called once; this
 *   (returned) texture then stays the empty "not arrived yet" one.
 * @param {EarthOfflineKeeper|null} [keeper]
 *   st8: when given, it is told which 16k files this picture needs and when the
 *   picture is complete on screen at that tier (it then stores the file for offline).
 * @returns {THREE.Texture}
 */
export function loadTexture(path, anisotropy = 8, strips = null, keeper = null) {
  const avifPath = path.replace(/\.jpg$/i, '.avif');
  const useAvif = avifSupported && avifPath !== path;
  const initialPath = useAvif ? avifPath : path;

  // A texture with no image and version 0 is skipped silently by three until
  // the picture arrives.
  const tex = new THREE.Texture();
  tex.userData.src = { path, useAvif, initialPath };
  if (strips) tex.userData.strips = strips;
  // st8 D4: told when this picture is complete on screen at its own tier.
  if (keeper) { tex.userData.keeper = keeper; keeper.expect(initialPath); }
  // Bitmaps are closed after their first upload (onEarthTextureUpdate). Any later
  // change to this texture's anisotropy / filters / wrap / format makes three
  // re-upload, which would hit a closed bitmap and throw: change those only
  // through a reload (loadEarthImage), never on a live texture.
  tex.onUpdate = onEarthTextureUpdate;
  tex.colorSpace = THREE.SRGBColorSpace;
  // flipY is ignored by three for ImageBitmaps (the loader flips instead); it is
  // set to true again if an HTML image has to be used (loadViaImageLoader).
  tex.flipY = !bitmapPathOk;
  // C1 (tier-gated): anisotropy is chosen by the caller from the detected LOD
  // tier (see the Earth constructor) — the full 16x on capable 16k GPUs, less on
  // weaker hardware — so the extra grazing-angle sampling cost only lands where
  // it can be absorbed. three.js clamps this to renderer.capabilities
  // .getMaxAnisotropy() at texture upload, so any value is a safe ceiling.
  // (Anisotropy does not multiply texture memory; the old "16k RGBA ~ 1 GB VRAM"
  // note was stale.)
  tex.anisotropy = anisotropy;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;   // prevent antimeridian seam
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  loadEarthImage(tex);
  return tex;
}

/**
 * st3 D4: survive a lost graphics context. Bitmaps are closed after upload, so
 * after `webglcontextrestored` (three re-uploads every texture) the closed
 * images are replaced at once by a 1×1 placeholder (uploading a closed bitmap
 * throws) and the pictures are reloaded; each arrival disposes the texture
 * first (setEarthImage) so the big picture gets fresh GL storage.
 *
 * st6: a picture finished through strips is swapped back to its empty texture
 * and built again; strips in flight are dropped and requested again.
 *
 * @param {{dayTexture?: THREE.Texture, nightTexture?: THREE.Texture, cloudTexture?: THREE.Texture}} earth
 * @param {{domElement?: EventTarget}} renderer
 * @returns {Function} removes the listener
 */
export function attachEarthRestore(earth, renderer) {
  const target = renderer && renderer.domElement;
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const onRestored = () => {
    // st6: strips in flight are dropped (the new context has none of their GPU
    // memory); each of those pictures is requested again below.
    const dropped = earth._strips ? earth._strips.abandonAll() : [];
    for (const slot of PICTURE_SLOTS) {
      const tex = earth[slot];
      if (!tex || !tex.userData || !tex.userData.src) continue;
      if (tex.userData.stripBuilt) {
        // Finished through strips: the lost context took its GPU copy. Back to
        // the empty texture (nothing allocated for it), then build it again.
        const pending = tex.userData.pending;
        swapEarthPicture(earth, slot, pending);
        try { tex.dispose(); } catch (_e) { /* best effort */ }
        loadEarthImage(pending);
        continue;
      }
      if (dropped.includes(tex)) { loadEarthImage(tex); continue; }
      if (!tex.userData.uploaded) continue;
      const img = tex.image;
      // Only bitmap-backed textures need this: an HTML image is re-uploaded by three itself.
      if (!img || (typeof img.close !== 'function' && !img.isPlaceholder)) continue;
      if (isOpenBitmap(img)) { try { img.close(); } catch (_e) { /* best effort */ } }
      tex.image = makeRestorePlaceholder();
      tex.needsUpdate = true;
      loadEarthImage(tex);
    }
  };
  target.addEventListener('webglcontextrestored', onRestored);
  return () => { try { target.removeEventListener('webglcontextrestored', onRestored); } catch (_e) { /* noop */ } };
}

/** 1×1 image three can upload (canvas in a browser, a plain object in node tests). */
function makeRestorePlaceholder() {
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      c.isPlaceholder = true;
      return c;
    }
  } catch (_e) { /* fall through */ }
  return { width: 1, height: 1, isPlaceholder: true };
}

// ============================================================================
// 16K FILES STORED FOR OFFLINE (st8, 2026-10-19)
// ============================================================================
//
// The service worker precaches every texture EXCEPT the _16k ones (build-precache
// excludes them: 6 MB of AVIF would double the first download). On a first visit
// the page is not yet controlled when it fetches the 16k files, so they never
// reach Cache Storage, and an offline start on a desktop then had no picture at
// all. Fix (owner 2026-10-18/19: "default to local; updating in the background is
// ok, but must not delay or interfere with startup or game"): once BOTH 16k
// pictures are complete on screen and the page is controlled by the service
// worker, the page asks for each file once, one at a time, low priority, and the
// service worker's own cache-first rule stores the response (no service-worker
// change). The browser keeps the downloaded bytes in a Blob outside the page, so
// the page itself does almost nothing. A file already in Cache Storage is never
// fetched again. Nothing happens on touch devices or below the 16k tier.

/** Wait after both pictures are complete before the first file is asked for (ms). */
export const OFFLINE_START_DELAY_MS = 2000;
/** Wait between two files (ms). */
export const OFFLINE_GAP_MS = 1000;
/** How long to wait for the service worker to finish storing a response (ms). */
export const OFFLINE_STORE_WAIT_MS = 10000;

/** Test seam (setEarthLoadersForTests): replaces the browser pieces the keeper reads. */
let offlineEnvOverride = null;
/** URLs the keeper already made sure of in this page (a second Earth does not repeat it). */
let ensuredOffline = new Set();

/** What the keeper reads from the browser; every piece is looked up when used. */
function browserOfflineEnv() {
  return {
    serviceWorker: () => ((typeof navigator !== 'undefined' && navigator.serviceWorker) || null),
    caches: () => (typeof caches !== 'undefined' ? caches : null),
    fetch: (url, init) => fetch(url, init),
    touch: () => { try { return TouchControls.detect() === true; } catch (_e) { return false; } },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    absolute: absoluteUrl,
  };
}

/**
 * Stores the 16k files in Cache Storage for offline use (see the section note).
 * One per Earth. `expect(path)` registers a picture (only `_16k` files count, and
 * not on touch hardware); `complete(path)` says it is on screen at that tier; when
 * every expected picture is complete the work starts, once.
 */
export class EarthOfflineKeeper {
  /** @param {object} [env]  browser pieces (injectable for tests) */
  constructor(env = offlineEnvOverride || browserOfflineEnv()) {
    this.env = env;
    /** @type {Map<string, boolean>} absolute url → complete on screen */
    this.files = new Map();
    this.started = false;
    /** Resolves when the work ended (or at once if it never starts). Tests wait on it. */
    this.done = null;
  }

  /** @returns {boolean} whether this file will be stored */
  expect(initialPath) {
    if (!/_16k\.[a-z0-9]+$/i.test(String(initialPath))) return false;
    if (this.env.touch()) return false;
    this.files.set(this.env.absolute(initialPath), false);
    return true;
  }

  /** The picture of `initialPath` is complete on screen at its own tier. */
  complete(initialPath) {
    const url = this.env.absolute(initialPath);
    if (!this.files.has(url)) return;
    this.files.set(url, true);
    if (this.started) return;
    for (const v of this.files.values()) if (!v) return;
    this.started = true;
    this.done = this.run().catch((e) => console.warn('[Earth] storing the 16k pictures for offline failed', e));
  }

  /** @returns {Promise<string>} what happened, for tests and the log */
  async run() {
    const env = this.env;
    const sw = env.serviceWorker();
    const cs = env.caches();
    if (!sw || !cs || typeof env.fetch !== 'function') return 'no-service-worker';
    // Controlled = the service worker will see (and store) the page's fetches. On a
    // first visit clients.claim() runs only after the precache install.
    if (!sw.controller) {
      await new Promise((resolve) => {
        const onChange = () => {
          if (!sw.controller) return;
          try { sw.removeEventListener('controllerchange', onChange); } catch (_e) { /* best effort */ }
          resolve();
        };
        sw.addEventListener('controllerchange', onChange);
      });
    }
    await env.wait(OFFLINE_START_DELAY_MS);
    let stored = 0;
    for (const url of this.files.keys()) {
      if (ensuredOffline.has(url)) continue;
      const name = fileName(url);
      let have = false;
      try { have = !!(await cs.match(url, { ignoreVary: true })); } catch (_e) { have = false; }
      if (have) {
        ensuredOffline.add(url);
        console.log(`[Earth] 16k picture already stored for offline: ${name}`);
        continue;
      }
      try {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        // force-cache: take the copy the page just downloaded from the HTTP cache when there is one.
        const res = await env.fetch(url, { priority: 'low', cache: 'force-cache' });
        if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
        await res.blob();
        // The service worker stores its copy without making the response wait for it.
        let ok = false;
        for (let waited = 0; !ok && waited <= OFFLINE_STORE_WAIT_MS; waited += 250) {
          if (waited) await env.wait(250);
          try { ok = !!(await cs.match(url, { ignoreVary: true })); } catch (_e) { ok = false; }
        }
        const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
        if (ok) { ensuredOffline.add(url); stored++; console.log(`[Earth] 16k picture stored for offline: ${name} (${ms} ms)`); recordTexEvent('offline-stored', url, null); }
        else console.warn(`[Earth] 16k picture ${name} was fetched but is not in Cache Storage`);
      } catch (err) {
        console.warn(`[Earth] could not store ${name} for offline`, err);
      }
      await env.wait(OFFLINE_GAP_MS);
    }
    return stored > 0 ? 'stored' : 'nothing-to-do';
  }
}

/** The picture in `tex` is on screen at its own tier: tell the keeper (if any). */
function notePictureComplete(tex) {
  const ud = tex && tex.userData;
  if (!ud || !ud.keeper || ud.loadedLevel !== 0 || !ud.src) return;
  try { ud.keeper.complete(ud.src.initialPath); } catch (_e) { /* never break picture loading */ }
}

// ============================================================================
// PICTURES TO THE GPU IN STRIPS (st6, 2026-10-18)
// ============================================================================
//
// The one remaining start-up freeze was the upload of the 16k day picture:
// 2.3 s in one frame (docs/research/2026-10-startup.md, phase 4). The cost is
// the sRGB format of the texture (SRGB8_ALPHA8 16k ≈ 1.45 s, plain RGBA8 ≈
// 150 ms on the same GPU), so the format stays and the work is cut up instead:
// each picture goes to the GPU as horizontal strips of about 2 M texels, ONE per
// rendered frame (Earth.update), into a texture that is allocated once with its
// full mip chain, and the mipmaps are generated once after the last strip. The
// texels are identical to the one-shot upload (probe: 0/255 at 5 mip levels and
// every strip seam). Measured on Apple M5 Max / Chrome (ANGLE Metal): longest
// frame 1480 ms → 31 ms for 16k, 310 → 25 ms for 8k.
//
// Until a picture is complete the Earth shows exactly what it showed before that
// picture arrived: the texture the shaders hold stays EMPTY, and the finished
// one replaces it in a single step (Earth._setPicture → onReady). Source of the
// strips is a fresh THREE.Texture around the ImageBitmap that is never bound to
// a material (a texture three has seen would take its framebuffer-blit branch).
//
// Used only on Chromium-family browsers (the one measured). Safari/WebKit gives
// the same pixels but the 16k allocation alone took 1.1 s and the strips ~180 ms
// each on the test Mac, so it keeps the one-shot upload; so does everything
// else (Firefox: unmeasured), the HTML-image fallback, and any failure here.

/** st7: frames before the strip pixel check starts (it must be done long before the first 16k picture lands). */
export const CHECK_AFTER_TICKS = 20;

/** Texels per strip (16k: 128 rows, 8k: 256 rows). */
export const STRIP_TEXELS = 2 * 1024 * 1024;

/** Rows per strip for a picture `width` pixels wide. */
export function stripRows(width) {
  return Math.max(1, Math.round(STRIP_TEXELS / Math.max(1, width)));
}

/** Chromium-family engine (the strip upload is measured there only). */
export function stripsSupportedByBrowser(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const brands = nav && nav.userAgentData && nav.userAgentData.brands;
  return Array.isArray(brands) && brands.some((b) => b && /^Chromium$/i.test(b.brand));
}

/** True when pictures built for `renderer` may use strips. */
export function stripsUsable(renderer) {
  if (!bitmapPathOk || !renderer) return false;
  if (typeof renderer.initTexture !== 'function' || typeof renderer.copyTextureToTexture !== 'function') return false;
  return stripsForced !== null ? stripsForced : stripsSupportedByBrowser();
}

const _scratchCentre = new THREE.Vector3();
const _scratchRel = new THREE.Vector3();
const PICTURE_SLOTS = ['dayTexture', 'nightTexture', 'cloudTexture'];

/** Put `texture` into one of an Earth's picture slots (field + shader uniforms). */
function swapEarthPicture(earth, slot, texture) {
  if (typeof earth._setPicture === 'function') earth._setPicture(slot, texture);
  else earth[slot] = texture;
}

function closeBitmap(bmp) {
  if (bmp && typeof bmp.close === 'function') { try { bmp.close(); } catch (_e) { /* best effort */ } }
}

/**
 * st7: the run-time pixel check. Builds a tiny picture (top and bottom half in
 * different colours) the way a real one is built (same bitmap options, same
 * destination, two strips), uploads the same bitmap in one go as the reference,
 * draws both into a small target and compares the bytes. True only if the strip
 * result is identical to the reference. Never throws; about a millisecond or two.
 * @param {EarthStripFeeder} feeder
 * @returns {Promise<boolean>}
 */
async function runStripCheck(feeder) {
  const renderer = feeder.renderer;
  let bmp = null, ref = null, dst = null, rt = null, geo = null, mat = null, prevRT = null, haveRT = false;
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return false;
    if (typeof renderer.render !== 'function' || typeof renderer.readRenderTargetPixels !== 'function') return false;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const W = 4, H = 8;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return false;
    g.fillStyle = 'rgb(220,40,90)'; g.fillRect(0, 0, W, H / 2);
    g.fillStyle = 'rgb(30,200,120)'; g.fillRect(0, H / 2, W, H / 2);
    bmp = await createImageBitmap(canvas, { ...BITMAP_LOADER_OPTIONS });

    // The reference: one-shot upload, with the same settings as a real picture.
    ref = new THREE.Texture(bmp);
    ref.colorSpace = THREE.SRGBColorSpace;
    ref.flipY = false;
    ref.minFilter = THREE.LinearMipmapLinearFilter;
    ref.magFilter = THREE.LinearFilter;
    ref.wrapS = ref.wrapT = THREE.ClampToEdgeWrapping;
    ref.generateMipmaps = true;
    ref.needsUpdate = true;
    // The strips: the feeder's own allocation + copy code, two strips of H/2 rows.
    dst = feeder._buildNow(ref, bmp, H / 2);
    // Let a frame go by between the two halves of the work (each is its own task).
    await new Promise((r) => setTimeout(r, 0));

    rt = new THREE.WebGLRenderTarget(W, H, {
      depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    geo = new THREE.PlaneGeometry(2, 2);
    mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: ref } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D uTex; void main() { gl_FragColor = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0); }',
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    prevRT = renderer.getRenderTarget();
    haveRT = true;
    const draw = (tex) => {
      mat.uniforms.uTex.value = tex;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      const out = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, out);
      return out;
    };
    const a = draw(ref);
    const b = draw(dst);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    // The reference must be a real picture: both halves present and different.
    const top = a.slice(0, 4).join(','), bottom = a.slice((H - 1) * W * 4, (H - 1) * W * 4 + 4).join(',');
    const sane = top !== bottom && a.some((v) => v !== 0);
    const ok = same && sane;
    if (typeof console !== 'undefined') {
      const ms = typeof performance !== 'undefined' ? (performance.now() - t0).toFixed(1) : '?';
      console.log(`[Earth] strip pixel check: ${ok ? 'ok' : 'FAILED (one-shot upload instead)'} (${ms} ms incl. waiting for the bitmap)`);
    }
    return ok;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[Earth] strip pixel check failed, one-shot upload instead', e);
    return false;
  } finally {
    try { if (haveRT) renderer.setRenderTarget(prevRT); } catch (_e) { /* best effort */ }
    for (const d of [dst, ref, rt, geo, mat]) { try { d && d.dispose(); } catch (_e) { /* best effort */ } }
    closeBitmap(bmp);
  }
}

/**
 * Builds the Earth pictures on the GPU one strip per `tick()`.
 * Order (st7): the side of the Earth the camera sees first. Camera over the sunlit
 * side (or not known yet): day, clouds, night. Over the dark side: night, day,
 * clouds. Decided when a picture starts, never in the middle of one; a picture
 * that has started is finished before the next one starts (each unfinished
 * picture holds its own full-size GPU allocation).
 * Used for a picture only if `verify()` found the strip result identical to a
 * one-shot upload (once, at start-up) and the picture fits the GPU's texture size.
 */
export class EarthStripFeeder {
  /**
   * @param {{initTexture: Function, copyTextureToTexture: Function, getContext?: Function}} renderer
   * @param {{sunlit?: () => (boolean|null)}} [opts] sunlit(): true / false = the camera is over the
   *   sunlit / dark side, null = not known yet
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.sunlit = opts.sunlit || null;
    this.queue = [];
    this.active = null;
    this.broken = false;
    this._order = 0;
    /** @type {boolean|null} null while the pixel check runs */
    this.verdict = null;
    this._verdictPromise = null;
    this._ticks = 0;
    // A test check or the test switch answers at once. The real check touches the
    // GPU (a few ms, ~50 ms measured under load 50), so it waits until the game is
    // drawing frames (CHECK_AFTER_TICKS), or a picture arrives, whichever is first.
    if (stripCheckHook || stripsForced !== null) this.verify();
  }

  /** @returns {boolean} true while pictures are queued or being built */
  get busy() { return !!this.active || this.queue.length > 0; }

  /**
   * st7: the run-time pixel check (plan D1), run once; the answer is cached in
   * `verdict`. Never throws. Under the test switch `stripsOk` it is skipped (true)
   * unless a test brings its own check.
   * @returns {Promise<boolean>}
   */
  verify() {
    if (this._verdictPromise) return this._verdictPromise;
    const done = (v) => { this.verdict = v === true; return this.verdict; };
    let r;
    try {
      r = stripCheckHook ? stripCheckHook(this.renderer, this) : (stripsForced !== null ? true : runStripCheck(this));
    } catch (_e) { r = false; }
    if (r && typeof r.then === 'function') this._verdictPromise = r.then(done, () => done(false));
    else { done(r); this._verdictPromise = Promise.resolve(this.verdict); }
    return this._verdictPromise;
  }

  _lost() {
    try {
      const gl = this.renderer.getContext && this.renderer.getContext();
      return !!(gl && typeof gl.isContextLost === 'function' && gl.isContextLost());
    } catch (_e) { return false; }
  }

  _fitsGpu(bmp) {
    const max = this.renderer.capabilities && this.renderer.capabilities.maxTextureSize;
    return !(typeof max === 'number' && max > 0) || Math.max(bmp.width, bmp.height) <= max;
  }

  /**
   * Does this bitmap go through strips? Needs: the pixel check passed, more than
   * one strip of rows, a live context, and a size the GPU accepts (a bigger one is
   * shrunk by the one-shot upload; strips would fail on it).
   */
  accepts(bmp) {
    return this.verdict === true && !this.broken && !!bmp && bmp.height > stripRows(bmp.width)
      && this._fitsGpu(bmp) && !this._lost();
  }

  /** Queue a picture; `onReady(finishedTexture)` runs once, after its last strip. */
  enqueue(tex, bmp, priority, onReady) {
    this.queue.push({ tex, bmp, priority, onReady, order: this._order++, step: 0, dst: null, src: null, rows: 0, count: 0 });
  }

  /**
   * One step of work: allocate the next picture, or upload its next strip.
   * Nothing happens while the context is lost.
   * @returns {boolean} whether a step ran
   */
  tick() {
    if (this.verdict === null && !this._verdictPromise && ++this._ticks >= CHECK_AFTER_TICKS) this.verify();
    if (this._lost()) return false;
    if (!this.active) {
      if (this.queue.length === 0) return false;
      let sunlit = true;
      try { if (this.sunlit) sunlit = this.sunlit() !== false; } catch (_e) { sunlit = true; }
      // priority: 0 day, 1 clouds, 2 night. Dark side in view: night, day, clouds.
      const rank = (p) => (sunlit ? p : (p === 2 ? 0 : p + 1));
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i], b = this.queue[best];
        if (rank(a.priority) < rank(b.priority) || (rank(a.priority) === rank(b.priority) && a.order < b.order)) best = i;
      }
      this.active = this.queue.splice(best, 1)[0];
      this.active.sunlit = sunlit;
    }
    const job = this.active;
    let finished = false;
    try {
      if (job.step === 0) this._allocate(job);
      else finished = this._strip(job);
      job.step++;
    } catch (e) {
      console.error('[Earth] strip upload failed, using the one-shot upload', e);
      this.broken = true;
      this._giveUp(job);
      return true;
    }
    if (finished) this._finish(job);
    return true;
  }

  _allocate(job) {
    const { tex, bmp } = job;
    const dst = new THREE.Texture({ width: bmp.width, height: bmp.height });
    dst.source.dataReady = false; // allocate the storage, upload nothing
    dst.colorSpace = tex.colorSpace;
    dst.flipY = false; // the bitmap was flipped by the loader
    dst.anisotropy = tex.anisotropy;
    dst.minFilter = tex.minFilter;
    dst.magFilter = tex.magFilter;
    dst.wrapS = tex.wrapS;
    dst.wrapT = tex.wrapT;
    dst.generateMipmaps = true; // three sizes the mip chain from this flag
    dst.needsUpdate = true;
    this.renderer.initTexture(dst);
    // copyTextureToTexture would rebuild the mip chain after EVERY strip while this is true.
    dst.generateMipmaps = false;
    job.dst = dst;
    job.src = new THREE.Texture(bmp);
    job.src.flipY = false;
    job.rows = job.rows || stripRows(bmp.width);
    job.count = Math.ceil(bmp.height / job.rows);
    job.width = bmp.width;
    job.height = bmp.height;
  }

  /** st7: allocate and fill a whole picture at once (the pixel check uses this). */
  _buildNow(tex, bmp, rows) {
    const job = { tex, bmp, rows, step: 0, dst: null, src: null, count: 0 };
    this._allocate(job);
    for (job.step = 1; !this._strip(job); job.step++);
    return job.dst;
  }

  _strip(job) {
    const i = job.step - 1;
    const y = i * job.rows;
    const y2 = Math.min(job.height, y + job.rows);
    const last = i === job.count - 1;
    job.dst.generateMipmaps = last; // the mip chain is built once, with the last strip
    this.renderer.copyTextureToTexture(
      job.src, job.dst,
      new THREE.Box2(new THREE.Vector2(0, y), new THREE.Vector2(job.width, y2)),
      new THREE.Vector2(0, y)
    );
    return last;
  }

  _finish(job) {
    const { tex, dst } = job;
    this.active = null;
    closeBitmap(job.bmp);
    dst.userData.src = tex.userData.src;
    dst.userData.uploaded = true;
    dst.userData.uploadedWidth = job.width;
    dst.userData.uploadedHeight = job.height;
    dst.userData.stripBuilt = true;
    dst.userData.pending = tex;
    dst.userData.loadedLevel = tex.userData.loadedLevel; // st8
    dst.userData.keeper = tex.userData.keeper;
    const file = tex.userData.src.initialPath;
    console.log(`[Earth] Ready: ${file} (${job.width}×${job.height}, ${job.count} strips of ${job.rows} rows, camera over the ${job.sunlit === false ? 'dark' : 'sunlit'} side when it started)`);
    recordTexEvent('ready', file, { width: job.width, height: job.height });
    bootMark(`Earth texture complete: ${file.split('/').pop()} (${job.width}×${job.height})`);
    try { job.onReady(dst); } catch (e) { console.error('[Earth] onReady failed', e); }
  }

  /** A strip failed: free the half-built texture and upload the bitmap in one go instead. */
  _giveUp(job) {
    this.active = null;
    try { job.dst && job.dst.dispose(); } catch (_e) { /* best effort */ }
    try { setEarthImage(job.tex, job.bmp); } catch (e) { console.error('[Earth] one-shot fallback failed', e); }
    const rest = this.queue.splice(0);
    for (const j of rest) { try { setEarthImage(j.tex, j.bmp); } catch (_e) { /* best effort */ } }
  }

  /**
   * Context restored: drop everything in flight (closing the bitmaps).
   * @returns {THREE.Texture[]} the empty textures whose pictures must be loaded again
   */
  abandonAll() {
    const dropped = [];
    for (const job of [this.active, ...this.queue]) {
      if (!job) continue;
      dropped.push(job.tex);
      try { job.dst && job.dst.dispose(); } catch (_e) { /* best effort */ }
      closeBitmap(job.bmp);
    }
    this.active = null;
    this.queue = [];
    return dropped;
  }
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

/*
 * Picture sizes on a capable desktop: day AND night maps are 16k (owner
 * 2026-10-18: "8k looks like shit, defeats the whole purpose of this game ...
 * back to 16k", then "Night 16k too"). Do not cap either.
 *
 * History (OPEN-2, 2026-08-31, commit 31b6fd47): the night map was capped at
 * 8k on Apple GPUs because on the owner's M4 Max (Brave, ANGLE-Metal) the 16k
 * night-side city lights rendered pure BLACK in long real sessions (and under
 * DevTools the 16k day map once blanked too), while every GL-visible witness
 * stayed healthy (decoded 16384×8192, upload complete, zero gl.getError, zero
 * context losses) and headed runs on the same GPU rendered 16k fine even under
 * a 10 GB allocation. Best explanation, never proven: long-session Metal
 * residency eviction of the largest textures (512 MB + mips apiece). If the
 * lights go black again, check `?bfp=1` and BLACK_SCREEN_TRIAGE.md first;
 * the owner decides any cap. `?tex=16k|8k|base` still forces both maps.
 */

/**
 * iPad port Phase 2 (Ipad.md §4.2 resolution discipline + §4.5 touch gate):
 * cap the WHOLE texture stack at 8k on real touch hardware.
 *
 * Why this exists — two independent reasons, both device-verified classes:
 *   1. Offline permanence: the sw.js precache is capped at the 8k tier
 *      (no *_16k.* — scripts/build-precache.mjs), so an iPad that selected
 *      16k would request a file the offline cache can never hold and boot a
 *      black Earth the first time it's launched unplugged. The clamp makes
 *      the capped precache exactly cover what glass ever requests.
 *   2. Resolution discipline on glass: an iPad reports Apple GPU +
 *      maxTextureSize 16384 and would walk into the 512 MB (+mips) 16k day
 *      map — the exact resource class that goes residency-black in long
 *      sessions on Apple GPUs (OPEN-2, see the note above) — on a device
 *      with none of a Mac's memory headroom.
 *
 * Gate: TouchControls.detect() — the ONE touch gate (Ipad.md §4.5). Desktops
 * and headless bench contexts report no touch, so desktop texture selection
 * is byte-identical by construction. The `?tex=16k` URL override in
 * getTextureQuality() bypasses this clamp (it returns before detection), so
 * the full 16k set stays one URL away for on-glass A/B.
 *
 * Pure + exported for the Node suite, like selectLOD.
 *
 * @param {'16k'|'8k'|''} quality  overall tier from selectLOD()
 * @param {boolean} hasTouch      real-touch detection result
 * @returns {'16k'|'8k'|''} day-map tier (== quality except 16k-on-touch → 8k)
 */
export function clampLODForGlass(quality, hasTouch) {
  if (hasTouch && quality === '16k') return '8k';
  return quality;
}

/**
 * Detect hardware capability and return the best texture quality tier.
 * Gathers runtime inputs, delegates to selectLOD() for the actual decision.
 *
 * st2-start-quick D3: when the game's own renderer exists it is asked for the
 * maximum texture size and the Apple GPU string, so no throw-away WebGL context
 * is built just to read them (a cost of ~20 ms on a GPU, seconds on a software
 * renderer). With no renderer (tests, other callers) the old probe canvas runs,
 * and each probe context is released with WEBGL_lose_context after reading.
 *
 * @param {object} [opts]
 * @param {{capabilities?: {maxTextureSize?: number}, getContext?: Function}} [opts.renderer]
 *   the game's THREE.WebGLRenderer (or a stand-in)
 * @param {Document} [opts.doc] document used for the probe canvas (default: global)
 * @param {Navigator} [opts.nav] navigator for deviceMemory (default: global)
 * @returns {{quality: '16k'|'8k'|'', dayQuality: '16k'|'8k'|'', nightQuality: '16k'|'8k'|''}}
 *   `quality` = hardware tier (mesh detail, anisotropy, cloud file);
 *   `dayQuality` = `nightQuality` = `quality` (16k day and night kept, owner 2026-10-18)
 */
export function getTextureQuality({ renderer, doc, nav } = {}) {
  // Black-flicker triage (H3) / OPEN-2 (16k night texture renders black on
  // ANGLE-Metal): `?tex=16k|8k|base` overrides hardware LOD detection so the
  // 1.2+ GB 16k day+night set can be A/B'd against 8k in one URL, no rebuild.
  // Opt-in, exact-value only (DevShotGate idiom); any other value falls through
  // to detection. Dev-only — never ship URLs with it. The override forces the
  // NIGHT map too — that is the point:
  // ?tex=16k must reproduce the full failing 16k set on demand.
  try {
    if (typeof window !== 'undefined' && typeof URLSearchParams !== 'undefined') {
      const raw = (new URLSearchParams(window.location.search).get('tex') || '').toLowerCase();
      if (raw === '16k' || raw === '8k') {
        console.info(`[Earth] texture LOD URL override → ${raw}`);
        return { quality: raw, dayQuality: raw, nightQuality: raw };
      }
      if (raw === 'base' || raw === '4k') {
        console.info('[Earth] texture LOD URL override → base');
        return { quality: '', dayQuality: '', nightQuality: '' };
      }
    }
  } catch (_e) { /* fall through to detection */ }

  // navigator.deviceMemory is Chrome/Edge only (NOT available in Safari/Firefox).
  const navigatorRef = nav || (typeof navigator !== 'undefined' ? navigator : undefined);
  const deviceMemory = navigatorRef ? navigatorRef.deviceMemory : undefined; // may be undefined

  // The Apple string is read from the debug-info extension (Safari-specific fallback).
  const readAppleGPU = (gl) => {
    const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbgExt) return false;
    return /Apple/i.test(gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '');
  };

  let maxTextureSize = 4096;
  let isAppleGPU = false;
  let fromRenderer = false;
  const rendererGl = (renderer && typeof renderer.getContext === 'function') ? renderer.getContext() : null;
  if (rendererGl) {
    const cap = renderer.capabilities && renderer.capabilities.maxTextureSize;
    maxTextureSize = cap || rendererGl.getParameter(rendererGl.MAX_TEXTURE_SIZE);
    isAppleGPU = readAppleGPU(rendererGl);
    fromRenderer = true;
  }
  if (!fromRenderer) {
    const d = doc || document;
    // Probe path (no renderer yet). The context is released after reading so a
    // throw-away context never lingers (a second one only when webgl2 fails).
    const probes = [];
    const open = (kind) => {
      const gl = d.createElement('canvas').getContext(kind);
      if (gl) probes.push(gl);
      return gl;
    };
    const gl = open('webgl2') || open('webgl');
    try {
      maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;
      if (gl) isAppleGPU = readAppleGPU(gl);
    } finally {
      for (const p of probes) {
        try {
          const lose = p.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch (_e) { /* best effort */ }
      }
    }
  }

  const quality = clampLODForGlass(
    selectLOD(maxTextureSize, deviceMemory, isAppleGPU),
    // Touch gate (Ipad.md §4.5): glass caps at 8k — see clampLODForGlass.
    TouchControls.detect()
  );
  // Day and night pictures ride the full hardware tier (16k on a capable
  // desktop; owner 2026-10-18 — see the note above clampLODForGlass).
  const dayQuality = quality;
  const nightQuality = quality;
  // PR 5 / P2.10: gate verbose LOD log behind DEBUG flag (?debug=1).
  if (Constants && Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
    console.log(`[Earth] LOD selected: ${quality || '4k (base)'} (pictures: day ${dayQuality || '4k (base)'}, night: ${nightQuality || '4k (base)'}). MaxTextureSize=${maxTextureSize}`);
  }
  return { quality, dayQuality, nightQuality };
}

/**
 * Sphere tessellation per texture-quality tier (visual-detail audit Task 3b).
 * Pure + exported for tests, mirroring {@link selectLOD}. The Earth sphere was
 * a hard-coded 256×256 (~131k tris) on EVERY device — the single biggest
 * static vertex load in the scene — while only its textures/shaders were
 * tiered. Segment counts ride the same hardware signal the textures use:
 * a GPU that only rates base/8k textures does not resolve 256² geometry either.
 * Applied at CONSTRUCTION only: live tier changes do NOT rebuild geometry
 * (a mid-session downgrade keeps the built spheres — acceptable, geometry is
 * static vertex cost, and rebuilding Earth live would hitch).
 *
 * @param {'16k'|'8k'|''} quality  from selectLOD()/getTextureQuality()
 * @returns {{surface:number, clouds:number, atmosphere:number}} widthSegments
 *   (heightSegments uses the same value; atmosphere is analytic-shaded and
 *   needs the least)
 */
export function selectSphereSegments(quality) {
  if (quality === '16k') return { surface: 256, clouds: 128, atmosphere: 64 }; // unchanged top tier
  if (quality === '8k')  return { surface: 160, clouds: 96,  atmosphere: 64 };
  return { surface: 96, clouds: 64, atmosphere: 48 };                          // base/weak GPUs
}

// ============================================================================
// EARTH CLASS
// ============================================================================
export class Earth {
  /**
   * @param {THREE.Scene} scene
   * @param {{renderer?: THREE.WebGLRenderer}} [options] renderer: the game's own,
   *   so the texture-tier probe needs no throw-away WebGL context (st2 D3)
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'EarthGroup';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();

    // Sprint 2 / PR C — LOW_DETAIL fragment-shader branch flag.
    // Toggled by [`Earth.setLowDetail`](js/scene/Earth.js:1), wired through
    // [`SceneManager.applyTier()`](js/scene/SceneManager.js:275).
    //
    // Sprint 3 GPU profiling — `?disableEarthNoise=1` force-pins LOW_DETAIL
    // on at construction so the 7-octave noise stack is compiled out
    // regardless of which quality tier is active. Lets us A/B the entire
    // procedural-terrain cost in one session.
    this._useLowDetail = profileFlags.disableEarthNoise === true;

    // Adaptive quality: pick texture resolution based on hardware. `quality` is
    // the hardware tier (mesh detail, anisotropy, cloud file); the day and night
    // pictures follow it (16k on a capable desktop, owner 2026-10-18).
    const { quality, dayQuality, nightQuality } = getTextureQuality({ renderer: options && options.renderer });
    const texSuffix = dayQuality ? `_${dayQuality}` : '';
    const nightSuffix = nightQuality ? `_${nightQuality}` : '';
    const cloudSuffix = quality === '16k' ? '_8k' : (quality === '8k' ? '_8k' : '');
    // Sphere tessellation rides the same hardware signal (Task 3b) — see
    // selectSphereSegments() for the rationale + construction-only caveat.
    // Keyed on the DAY tier: geometry detail tracks the primary map.
    this._sphereSegments = selectSphereSegments(quality);

    console.log(`[Earth] Texture quality: hardware ${quality || 'base'}, pictures day "${texSuffix || 'base'}" night "${nightSuffix || 'base'}"`);

    // C1 (tier-gated anisotropy): scale the grazing-angle sampling cost with the
    // detected LOD tier so the weakest GPUs — the base tier (low maxTextureSize /
    // low memory), the same population the LOW render tier targets — don't pay for
    // 16x. 8k-capable hardware gets 8x; 16k-capable (Apple Silicon / >=8 GB) gets
    // the full 16x.
    const texAniso = quality === '16k' ? 16 : (quality === '8k' ? 8 : 4);

    // Load the pictures at their tiers (aniso stays keyed on the hardware tier;
    // three.js clamps it at upload anyway).
    // st6: on a strip-capable browser each picture is built on the GPU one strip
    // per frame (priority day, clouds, night) and swapped in when complete.
    this._camPos = new THREE.Vector3();
    this._camSeen = false;
    this._strips = options && stripsUsable(options.renderer)
      ? new EarthStripFeeder(options.renderer, { sunlit: () => this._cameraOverSunlitSide() })
      : null;
    const strips = (slot, priority) => (this._strips
      ? { feeder: this._strips, priority, onReady: (t) => this._setPicture(slot, t) }
      : null);
    // st8 D4: stores the 16k files for offline once both are on screen (nothing below 16k / on touch).
    this._offline = new EarthOfflineKeeper();
    this.dayTexture = loadTexture(`textures/earth_day${texSuffix}.jpg`, texAniso, strips('dayTexture', 0), this._offline);
    this.nightTexture = loadTexture(`textures/earth_night${nightSuffix}.jpg`, texAniso, strips('nightTexture', 2), this._offline);
    // Clouds are low-frequency; anisotropy cost concentrates at grazing angles
    // (the limb) where clouds are softest — 4x is indistinguishable from the tier
    // aniso and trims bandwidth on the overdraw-heaviest (transparent) layer.
    this.cloudTexture = loadTexture(`textures/earth_clouds${cloudSuffix}.jpg`, Math.min(texAniso, 4), strips('cloudTexture', 1));
    // st3 D4: bitmaps are closed after upload; reload them after a lost context.
    if (options && options.renderer) attachEarthRestore(this, options.renderer);

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

  /**
   * st6: a picture built in strips is complete — hand it to the shaders and to
   * `earth.dayTexture` / `nightTexture` / `cloudTexture` (BlackFrameProbe reads
   * them) in one step. The cloud picture sits in two uniforms; the cloud shell
   * is null under `?disableClouds=1`.
   * @param {'dayTexture'|'nightTexture'|'cloudTexture'} slot
   * @param {THREE.Texture} texture
   */
  _setPicture(slot, texture) {
    this[slot] = texture;
    // st8 D4: a picture finished through strips (not the empty one put back by a restore).
    if (texture && texture.userData && texture.userData.stripBuilt) notePictureComplete(texture);
    const surface = this.surfaceMaterial && this.surfaceMaterial.uniforms;
    if (slot === 'dayTexture' && surface) surface.uDayTexture.value = texture;
    else if (slot === 'nightTexture' && surface) surface.uNightTexture.value = texture;
    else if (slot === 'cloudTexture') {
      if (surface) surface.uCloudTexture.value = texture;
      if (this.cloudMaterial) this.cloudMaterial.uniforms.uCloudTexture.value = texture;
    }
  }

  /**
   * st7: is the camera over the sunlit half of the Earth? dot(camera position
   * relative to the Earth's centre, sun direction) >= 0.
   * @returns {boolean|null} null until the surface has been drawn once
   */
  _cameraOverSunlitSide() {
    if (!this._camSeen) return null;
    const centre = this.group.getWorldPosition(_scratchCentre);
    const rel = _scratchRel.copy(this._camPos).sub(centre);
    return rel.dot(this.sunDirection) >= 0;
  }

  /** Feed at most one picture strip (once per drawn frame; main.js also calls this while the window is unfocused). */
  tickStrips() {
    noteFirstFrame(); // st8: the decode worker starts after the first frame
    if (this._strips) this._strips.tick();
  }

  // --- SURFACE SPHERE (tier-tessellated: 256² top tier … 96² base — Task 3b) ---
  _createSurface() {
    const segs = this._sphereSegments.surface;
    const geometry = new THREE.SphereGeometry(Constants.EARTH_RADIUS, segs, segs);

    this.surfaceMaterial = new THREE.ShaderMaterial({
      vertexShader: earthSurfaceVertexShader,
      fragmentShader: earthSurfaceFragmentShader,
      uniforms: {
        uDayTexture: { value: this.dayTexture },
        uNightTexture: { value: this.nightTexture },
        uCloudTexture: { value: this.cloudTexture },
        uCloudRotation: { value: 0 },
        uSunDirection: { value: this.sunDirection },
      },
      // Sprint 2 / PR C — `defines` controls the LOW_DETAIL branch. Mutated
      // at runtime by [`Earth.setLowDetail`](js/scene/Earth.js:1) when the
      // quality tier changes. NO_CLOUD_SHADOWS compiles the surface cloud-shadow
      // fetch out when clouds are profiling-disabled so the ?disableClouds
      // cost-isolation A/B stays pure. setLowDetail() only touches the LOW_DETAIL
      // key on this object, so NO_CLOUD_SHADOWS survives tier flips.
      defines: {
        ...(this._useLowDetail ? { LOW_DETAIL: 1 } : {}),
        ...(profileFlags.disableClouds ? { NO_CLOUD_SHADOWS: 1 } : {}),
      },
    });

    this.surfaceMesh = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.surfaceMesh.name = 'EarthSurface';
    // st7: remember where the camera is (world space), for the strip order.
    this.surfaceMesh.onBeforeRender = (_renderer, _scene, camera) => {
      const e = camera.matrixWorld.elements;
      this._camPos.set(e[12], e[13], e[14]);
      this._camSeen = true;
    };
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

  // --- CLOUD LAYER (tier-tessellated: 128² top tier … 64² base — Task 3b) ---
  _createClouds() {
    const segs = this._sphereSegments.clouds;
    const geometry = new THREE.SphereGeometry(Constants.CLOUD_RADIUS, segs, segs);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uCloudTexture: { value: this.cloudTexture },
        uSunDirection: { value: this.sunDirection },
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

  // --- ATMOSPHERE (tier-tessellated 64²…48², BackSide, additive blending) ---
  _createAtmosphere() {
    const segs = this._sphereSegments.atmosphere;
    const geometry = new THREE.SphereGeometry(Constants.ATMOSPHERE_RADIUS, segs, segs);
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
   * Per-frame update: animate clouds, sync analytic uniforms.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    // st6: at most one picture strip per rendered frame (no-op when none are queued).
    this.tickStrips();
    // Sprint 3 GPU profiling — atmosphere may be null when `?disableAtmosphere=1`.
    if (this.atmosphereMaterial) {
      // Keep the analytic shader's Earth-center uniform in sync (group may move).
      this.atmosphereMesh.getWorldPosition(this.atmosphereMaterial.uniforms.uCenter.value);
    }

    // Sidereal cloud rotation — visible drift over a game hour (ST-5.3).
    // Null-safe for `?disableClouds=1`. Feed the live rotation to the surface
    // shader so its straight-down cloud-shadow projection stays registered to
    // the drifting cloud layer (P1, 2026-07-20).
    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += Constants.EARTH.CLOUD_ROTATION_RATE * dt;
      this.surfaceMaterial.uniforms.uCloudRotation.value = this.cloudMesh.rotation.y;
    }
  }

  /** @returns {THREE.Group} */
  getGroup() {
    return this.group;
  }
}

export default Earth;
