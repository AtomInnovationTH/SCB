/** Textured Earth with day/night, clouds and limb atmosphere, plus its picture loader. @module scene/Earth */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { profileFlags } from '../core/ProfileFlags.js';
import { isDevHost, devSearch } from '../core/DevHost.js';
import { TouchControls } from '../ui/TouchControls.js';
import { smoothstep01 } from '../core/MathUtil.js';

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

// Ashima simplex noise as a shared GLSL string, injected by template interpolation (used only by the surface shader's terrain detail).
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

// Lambert term shared by the surface and cloud shaders so their day-side curves cannot drift. The 0.25 floor keeps
// the terminator from crushing to black (earthshine lifts the dark side). Exponent 0.8: 0.6 erased the
// sub-solar → terminator gradient (flat "milky" disc); 1.0 would be literal Lambert.
const lambertTermGLSL = /* glsl */ `
float lambertTerm(float NdotL) {
  return mix(0.25, 1.0, pow(clamp(NdotL, 0.0, 1.0), 0.8));
}
`;

// Alpha window turning a grayscale cloud texel into coverage. Interpolated into BOTH cloudFragmentShader (alpha)
// and earthSurfaceFragmentShader (cast shadow) so they cannot drift out of registration: retune only here.
const cloudCoverageRampGLSL = /* glsl */ `
#define CLOUD_COVERAGE_LO 0.42
#define CLOUD_COVERAGE_HI 0.80
`;

const earthSurfaceFragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

// st9 (2026-10-19): every picture slot can show up to three pictures at once
// while one blends into the next. *Texture = the newest picture, *Prev = the one
// before it, *Prev2 = the oldest; *W = their weights (x oldest, y previous, z newest).
// A finished slot is (0,0,1): the newest picture alone, and the two other fetches
// are skipped (uniform branch). A weight sum below 1 is black: the empty start.
uniform sampler2D uDayTexture;
uniform sampler2D uDayPrev;
uniform sampler2D uDayPrev2;
uniform vec3 uDayW;
uniform float uDayVis;             // share of the day picture that is a real picture (fades the ocean shine in with it)
uniform sampler2D uNightTexture;
uniform sampler2D uNightPrev;
uniform sampler2D uNightPrev2;
uniform vec3 uNightW;
uniform sampler2D uCloudTexture;   // shared with the cloud layer — read for surface shadows
uniform sampler2D uCloudPrev;
uniform sampler2D uCloudPrev2;
uniform vec3 uCloudW;
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

  // Sample textures (st9: the pictures of a running blend are mixed here, before the grade)
  vec3 dayColor = texture2D(uDayTexture, vUv).rgb * uDayW.z;
  if (uDayW.y > 0.0) dayColor += textureGrad(uDayPrev, vUv, uvDx, uvDy).rgb * uDayW.y;
  if (uDayW.x > 0.0) dayColor += textureGrad(uDayPrev2, vUv, uvDx, uvDy).rgb * uDayW.x;

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
  float oceanMask = smoothstep(0.35, 0.55, blueDom) * smoothstep(0.3, 0.7, rawDark) * uDayVis; // st9: uDayVis is 1 once a picture is whole, so the shine fades in with the picture

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
  float oceanFresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 5.0); // st9 D5: the dot can round above 1 (negative base = NaN)
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
    // st9: coverage is ramped per picture and then mixed by the blend weights,
    // so shadows fade in/out exactly as the cloud layer does.
    float cloudCover = smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI,
      textureGrad(uCloudTexture, cloudUv, uvDx * 3.0, uvDy * 3.0).r) * uCloudW.z;
    if (uCloudW.y > 0.0) cloudCover += smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI,
      textureGrad(uCloudPrev, cloudUv, uvDx * 3.0, uvDy * 3.0).r) * uCloudW.y;
    if (uCloudW.x > 0.0) cloudCover += smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI,
      textureGrad(uCloudPrev2, cloudUv, uvDx * 3.0, uvDy * 3.0).r) * uCloudW.x;
    cloudShade = 1.0 - cloudCover * 0.35;
  }
#endif

  // === NIGHT SIDE ===
  float nightFactor = smoothstep(0.05, -0.15, NdotL);

  // City lights (P1 perf, 2026-07-20): the 16k/8k night texture is fetched ONLY
  // where nightFactor > 0 — it previously ran on every lit fragment and
  // contributed exactly zero there (nightFactor == 0 across the day side).
  vec3 nightColor = vec3(0.0);
  if (nightFactor > 0.0) {
    nightColor = textureGrad(uNightTexture, vUv, uvDx, uvDy).rgb * uNightW.z;
    if (uNightW.y > 0.0) nightColor += textureGrad(uNightPrev, vUv, uvDx, uvDy).rgb * uNightW.y;
    if (uNightW.x > 0.0) nightColor += textureGrad(uNightPrev2, vUv, uvDx, uvDy).rgb * uNightW.x;
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
  float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.8); // st9 D5: same clamp as the ocean fresnel
  finalColor += vec3(0.30, 0.50, 0.85) * fresnel * 0.32 * dayFactor;

  gl_FragColor = vec4(finalColor, 1.0);

  #include <logdepthbuf_fragment>
}
`;

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

uniform sampler2D uCloudTexture;   // st9: newest picture; *Prev / *Prev2 and uCloudW as in the surface shader
uniform sampler2D uCloudPrev;
uniform sampler2D uCloudPrev2;
uniform vec3 uCloudW;
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
  float cloudAlpha = smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI, (cloudSample.r + cloudSample.g + cloudSample.b) / 3.0) * uCloudW.z;
  // st9: while a picture blends into the next the COVERAGE of each is mixed (not
  // the grey), so a new picture fades in as opacity instead of growing out of the ramp.
  if (uCloudW.y > 0.0) {
    vec3 cs = texture2D(uCloudPrev, vUv).rgb;
    cloudAlpha += smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI, (cs.r + cs.g + cs.b) / 3.0) * uCloudW.y;
  }
  if (uCloudW.x > 0.0) {
    vec3 cs2 = texture2D(uCloudPrev2, vUv).rgb;
    cloudAlpha += smoothstep(CLOUD_COVERAGE_LO, CLOUD_COVERAGE_HI, (cs2.r + cs2.g + cs2.b) / 3.0) * uCloudW.x;
  }

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
  // (the coverage ramp is applied per picture above)
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

// Analytic limb scattering: per-fragment impact-parameter altitude + exponential density, fading to zero before
// the mesh edge (no hard silhouette like normal-based Fresnel rims). Log depth is encoded in the vertex shader
// (early-Z kept, so the occluded half of the shell is culled); reads only `position` (normal/uv stripped).
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

// AVIF is ~5× smaller than JPG (earth_day_16k: 19 MB → 3.9 MB). loadTexture prefers the `.avif` sibling when a
// one-time Image.decode() probe of a 1×1 AVIF data-URL passes, else `.jpg`.
// Pictures decode off the main thread (THREE.ImageBitmapLoader; each bitmap freed after upload, see
// onEarthTextureUpdate / attachEarthRestore) once probeBitmapOrientation proves north-up with the same texels;
// otherwise the TextureLoader path runs.
// The probes use top-level await so they settle before any Earth is constructed. In Node (no `Image`) both
// are false (test-EarthLOD imports selectLOD from this module).
let textureLoader = new THREE.TextureLoader();

// 2×2 AVIF still-picture, av1, ~311 bytes: `ffmpeg -f lavfi -i color=c=black:s=2x2 -c:v libaom-av1 -still-picture 1
// -crf 30 -b:v 0`, verified with libavif's avifdec. Image.decode() rejects on it if AVIF is unsupported.
const AVIF_PROBE_DATA_URL =
  'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAWAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAACAAAAAgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAebWRhdAoFGAA2wCAyDReAAABIAAAADAZusnI=';

async function probeAvifSupport() {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return false;
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
 * Does the off-thread bitmap path give the same picture as the HTML-image path? Draws a 2×1 canvas (top red,
 * bottom blue), round-trips it via createImageBitmap with the exact loader options and reads it back: true only
 * when the rows came back flipped (three ignores texture.flipY for bitmaps). Never throws: false with no DOM,
 * no createImageBitmap, or on any failure.
 */
export async function probeBitmapOrientation({ doc, createBitmap } = {}) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const make = createBitmap || (typeof createImageBitmap === 'function' ? createImageBitmap : null);
    if (!d || !make) return false;
    const src = d.createElement('canvas');
    src.width = 2; src.height = 2;
    const sctx = src.getContext('2d');
    sctx.fillStyle = 'rgb(255,0,0)'; sctx.fillRect(0, 0, 2, 1);
    sctx.fillStyle = 'rgb(0,0,255)'; sctx.fillRect(0, 1, 2, 1);
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

/** Longest start-up wait (ms) for the orientation self-test before the old image path is used. */
export const BITMAP_PROBE_TIMEOUT_MS = 500;

/**
 * Race the self-test against a timer so a callback that never fires (e.g. `toBlob`) cannot hang module
 * evaluation and the game's start. False on timeout, throw or non-true result; a late result is ignored.
 */
export function gateBitmapProbe(test = probeBitmapOrientation, ms = BITMAP_PROBE_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const run = (async () => {
    try { return (await test()) === true; } catch (_e) { return false; }
  })();
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// ImageBitmapLoader's createImageBitmap(blob, {imageOrientation:'flipY'}) RESOLVES on the main thread, and the
// flip makes a 105–160 ms frame per 16k picture (9 ms in a Worker, 0 of 134 M pixels different; archive/research/2026-10-startup.md,
// "Phase 5"). So fetch AND decode run in one inline Worker and the bitmap is transferred back. The worker is used
// only after the 2×2 orientation self-test passed INSIDE it; on any worker problem the main-thread loader runs.

/** createImageBitmap options of the worker path: exactly what three's loader passes. */
export const WORKER_DECODE_OPTIONS = Object.freeze({ ...BITMAP_LOADER_OPTIONS, colorSpaceConversion: 'none' });

/**
 * The worker's program: a function so node tests can run it against a fake scope; the browser gets its source text
 * (DECODE_WORKER_SOURCE). Must stay self-contained (no closure over this module). Messages:
 *   in {id, type:'selftest', options} → {id, ok}
 *   in {id, type:'decode', url, options} → {id, bitmap} (transferred) | {id, error}
 * `fetch` uses default same-origin credentials (like three's loader with crossOrigin 'anonymous'); the page's
 * service worker serves it when the page is controlled (blob-URL workers inherit the controller).
 */
export function decodeWorkerMain(scope) {
  async function selfTest(options) {
    const OC = scope.OffscreenCanvas;
    const src = new OC(2, 2);
    const g = src.getContext('2d');
    g.fillStyle = 'rgb(255,0,0)'; g.fillRect(0, 0, 2, 1);
    g.fillStyle = 'rgb(0,0,255)'; g.fillRect(0, 1, 2, 1);
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
 * Main-thread end of the decode worker: one promise per request, matched by id. Any worker error fails every
 * pending request and marks the worker dead; callers then use the main-thread loader.
 */
export class EarthDecodeWorker {
  /**
   * @param {{postMessage: Function, terminate?: Function}} worker
   * @param {object} [options]  createImageBitmap options sent with every request
   * @param {number} [timeoutMs]  a request with no answer for this long fails (a browser can kill a worker silently)
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

  _send(msg, extra) {
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
        this.worker.postMessage({ ...msg, id, options: { ...this.options, ...(extra || {}) } });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  selfTest() { return this._send({ type: 'selftest' }).then((r) => r.ok === true); }

  /**
   * Fetch and decode one picture in the worker.
   * @param {string} url  absolute (a blob: worker cannot resolve relative paths)
   * @param {object} [extra]  createImageBitmap options added for this request only (e.g. a smaller size)
   */
  decode(url, extra) {
    return this._send({ type: 'decode', url }, extra).then((r) => {
      if (!r.bitmap) throw new Error('decode worker sent no bitmap');
      return r.bitmap;
    });
  }

  terminate() {
    if (this.terminated) return; // each rejected request's handler retires the worker again
    this.terminated = true;
    // In-flight requests are rejected, not dropped: each caller falls back to the main-thread loader (the message
    // is not "HTTP nnn", so it is not read as a missing file).
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

/** Start the worker and its self-test (bounded like the main-thread test). Never throws; false with no DOM / Worker / Blob URL. */
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

// Not awaited by module evaluation: the self-test runs in parallel with the probes below; a picture asked for
// before it ends waits for it (see loadLevel).
let workerProbe = probeWorkerDecode().then((ok) => {
  if (workerPathOk === null) workerPathOk = ok === true;
  if (typeof console !== 'undefined' && typeof document !== 'undefined') {
    console.log(`[Earth] picture decode in a worker: ${workerPathOk ? 'YES' : 'NO (main-thread bitmap loader)'}`);
  }
  return workerPathOk;
});

// Both probes run in parallel (no added wait). Only the bitmap self-test is bounded (BITMAP_PROBE_TIMEOUT_MS), not the AVIF probe.
const [avifSupported, bitmapProbeResult] = await Promise.all([probeAvifSupport(), gateBitmapProbe()]);
let bitmapPathOk = bitmapProbeResult === true;

if (typeof console !== 'undefined' && typeof document !== 'undefined') {
  console.log(`[Earth] AVIF support: ${avifSupported ? 'YES (preferring .avif)' : 'NO (falling back to .jpg)'}`);
  console.log(`[Earth] off-thread picture decode: ${bitmapPathOk ? 'YES (ImageBitmap)' : 'NO (image loader)'}`);
}

/** Whether the browser decoded the AVIF probe (for PerfReportOverlay). */
export function isAvifSupported() {
  return avifSupported === true;
}

export function isBitmapPathSupported() {
  return bitmapPathOk === true;
}

export function isWorkerDecodeSupported() {
  return bitmapPathOk === true && workerPathOk === true && !!decodeWorker && !decodeWorker.dead;
}

let bitmapLoader = null;
/** test seam: true / false forces the strip path on / off; null = decide from the browser. */
let stripsForced = null;
/** test seam: replaces the run-time pixel check of the strip path (see EarthStripFeeder.verify). */
let stripCheckHook = null;
/** test seam: false = no small pictures; true = normal. */
let smallFirstOn = true;
/** test seam: replaces performance.now() for the picture blend. */
let clockHook = null;
/** Created lazily: node has no createImageBitmap and a module-level `new` would warn in every test. */
function getBitmapLoader() {
  if (!bitmapLoader) bitmapLoader = new THREE.ImageBitmapLoader().setOptions({ ...BITMAP_LOADER_OPTIONS });
  return bitmapLoader;
}

/**
 * Test seam: inject fake loaders, probe results and the strip switch (null = decide from the browser). Returns a
 * function that restores the previous state.
 * `stripCheck(renderer, feeder)` (boolean or promise) replaces the run-time pixel check; `decodeWorker`
 * (EarthDecodeWorker-like, or null = no worker) replaces the worker; `offlineEnv` replaces what the 16k-for-offline
 * step reads from the browser; `firstFrame: false` keeps the worker waiting for the first frame (default after
 * injecting a worker: already drawn); `firstFrameTimeoutMs` shortens the hidden-tab fallback; `pendingWorker`
 * leaves its self-test "still running" until the returned function's `.settleWorker(true|false)`;
 * `smallFirst` (false = no small pictures); `clock` replaces performance.now() for the blend (null = real).
 */
export function setEarthLoadersForTests({ bitmapLoader: bl, imageLoader, bitmapOk, stripsOk, stripCheck, decodeWorker: dw, offlineEnv, firstFrame, firstFrameTimeoutMs, pendingWorker, smallFirst, clock } = {}) {
  const prev = {
    bl: bitmapLoader, il: textureLoader, ok: bitmapPathOk, st: stripsForced, ck: stripCheckHook,
    dw: decodeWorker, wok: workerPathOk, oe: offlineEnvOverride, od: ensuredOffline,
    ff: firstFrameSeen, fw: frameWaiters, ft: firstFrameFallbackMs, ftm: frameTimers, wp: workerProbe,
    sf: smallFirstOn, ch: clockHook,
  };
  if (smallFirst !== undefined) smallFirstOn = smallFirst !== false;
  if (clock !== undefined) clockHook = clock;
  if (bl !== undefined) bitmapLoader = bl;
  if (imageLoader !== undefined) textureLoader = imageLoader;
  if (bitmapOk !== undefined) bitmapPathOk = bitmapOk === true;
  if (stripsOk !== undefined) stripsForced = stripsOk === null ? null : stripsOk === true;
  if (stripCheck !== undefined) stripCheckHook = stripCheck;
  if (dw !== undefined) { decodeWorker = dw; workerPathOk = dw !== null; }
  if (offlineEnv !== undefined) { offlineEnvOverride = offlineEnv; ensuredOffline = new Set(); }
  // An injected worker gets the "first frame drawn" state unless the test asks for the pre-frame state.
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
    smallFirstOn = prev.sf; clockHook = prev.ch;
  };
  restore.settleWorker = (ok) => { if (settleWorker) settleWorker(ok); };
  return restore;
}

/**
 * Records every texture-load outcome in `window.__earthTexEvents` so the `?bfp` badge-click dump carries the
 * decode/fallback history (a silent AVIF decode failure of the 512 MB night map samples black). Capped ring,
 * try/catch'd, no-op outside the DOM.
 * @param {string} kind  'loaded' | 'ready' | 'shown' (blend started) | 'avif-fail' | 'bitmap-fail' | 'fallback-loaded' | 'error'
 */
function recordTexEvent(kind, file, image) {
  try {
    if (typeof window !== 'undefined' && isDevHost()) {
      const log = (window.__earthTexEvents = window.__earthTexEvents || []);
      log.push({
        t: Math.round((typeof performance !== 'undefined' ? performance.now() : 0)),
        kind,
        file: String(file).split('/').pop(),
        w: image && image.width ? image.width : 0,
        h: image && image.height ? image.height : 0,
      });
      if (log.length > 40) log.shift();
    }
  } catch (_e) { /* diagnostics must never break texture loading */ }
}

/** Boot-timeline mark (?logBoot=1); probes read the text. */
function bootMark(text) {
  try {
    // eslint-disable-next-line no-undef
    window.__bootMark?.(text);
  } catch (_e) { /* swallow — diagnostic only */ }
}

function isOpenBitmap(img) {
  return !!img && typeof img.close === 'function' && img.width > 0;
}

/**
 * Give a texture a new picture. It is disposed first: three allocates immutable GL storage once per texture, so a
 * bigger picture would otherwise go into the old (e.g. 1×1 placeholder) storage and the Earth would stay blank.
 */
function setEarthImage(tex, image) {
  if (tex.userData.uploaded) tex.dispose();
  tex.image = image;
  tex.needsUpdate = true;
}

/**
 * `texture.onUpdate` (three calls it after every upload). Acts only when `tex.image` is an open ImageBitmap:
 * records its size for the diagnostics (a closed bitmap reads 0×0), then frees its memory. The 1×1 restore
 * placeholder is ignored. A one-shot upload of the tier's own picture also counts as "complete" for the
 * 16k-for-offline step (the strip path reports through Earth._setPicture).
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

/** The files of one picture, best first: the tier's own file, then each smaller tier (16k → 8k → base). Pure; exported for tests. */
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

function loadEarthImage(tex) {
  const seq = (tex.userData.loadSeq = (tex.userData.loadSeq || 0) + 1);
  delete tex.userData.loadedLevel;
  loadLevel(tex, seq, 0);
}

/**
 * The next smaller tier of a picture whose file could not be had on any path (offline, 404, undecodable); logs
 * one line naming it. False when there is none (the texture then samples black).
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

/** Runs `fn` once, after the game's first frame (at once if already drawn). `urgent` puts it ahead of the waiting ones. */
function afterFirstFrame(fn, urgent = false) {
  if (firstFrameSeen) { fn(); return; }
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  if (urgent) {
    // behind the other urgent ones (they keep the order they were asked in), ahead of the rest
    once.urgent = true;
    const at = frameWaiters.findIndex((w) => !w.urgent);
    frameWaiters.splice(at < 0 ? frameWaiters.length : at, 0, once);
  } else frameWaiters.push(once);
  if (typeof setTimeout === 'function') frameTimers.push(setTimeout(once, firstFrameFallbackMs));
}

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

function usableWorker() {
  return bitmapPathOk && workerPathOk === true && decodeWorker && !decodeWorker.dead ? decodeWorker : null;
}

/** One tier of a picture: worker decode → main-thread bitmap loader → HTML image (AVIF, then JPG); if all fail, the next smaller tier. */
function loadLevel(tex, seq, level) {
  const src = tierSources(tex.userData.src)[level];
  const { initialPath } = src;
  // The picture's staging hook (null for a plain loadTexture call). A SMALL picture (the base-tier file shown while
  // the sharp one loads) only goes the off-thread way: decoding an extra picture on the main thread is the stutter it avoids.
  const pic = tex.userData.strips || null;
  const isSmall = !!pic && pic.kind === 'small';
  if (isSmall && !bitmapPathOk) return;
  if (!bitmapPathOk) { loadViaImageLoader(tex, seq, level); return; }
  const stale = () => tex.userData.loadSeq !== seq;

  const arrive = (bmp) => {
    if (stale()) { closeBitmap(bmp); return; }
    const place = () => {
      try {
        const bw = bmp.width, bh = bmp.height; // read now: the one-shot route closes the image
        const dims = `${bw}×${bh}`;
        tex.userData.loadedLevel = level;
        // On a strip-capable browser the picture is queued and reaches the GPU one strip per frame; this texture stays
        // empty until the finished one replaces it (Earth._setPicture). Otherwise one-shot: an Earth's one-shot picture
        // goes into a NEW texture (Earth._oneShotPicture), uploaded before it is shown, so there is always something to blend from.
        const sp = tex.userData.strips;
        if (sp && sp.dropped && sp.dropped()) {
          // a small picture that arrives after the sharp one (or after a restore) is never shown
          closeBitmap(bmp);
          console.log(`[Earth] Dropped: ${initialPath} (${dims}), not needed any more`);
          return;
        }
        if (sp && sp.feeder && sp.feeder.accepts(bmp, sp.kind)) sp.feeder.enqueue(tex, bmp, sp.priority, sp.onReady, { kind: sp.kind, level });
        else if (isSmall && bmp.width * bmp.height > SMALL_ONE_SHOT_MAX_TEXELS) {
          // no strips for it and too heavy for one frame: skip this slot's small picture
          closeBitmap(bmp);
          console.log(`[Earth] Skipped: ${initialPath} (${dims}), too big for a one-shot upload`);
          return;
        } else if (sp && sp.onOneShot) sp.onOneShot(tex, bmp, false, level);
        else setEarthImage(tex, bmp);
        console.log(`[Earth] Loaded: ${initialPath} (${dims})`);
        recordTexEvent('loaded', initialPath, { width: bw, height: bh });
        bootMark(`Earth texture decoded: ${initialPath.split('/').pop()} (${dims})`);
      } catch (e) {
        console.error(`[Earth] Texture arrival failed: ${initialPath}`, e);
      }
    };
    // The run-time pixel check of the strip path normally finishes long before a 16k picture is decoded; if not, this picture waits for it.
    const feeder = tex.userData.strips && tex.userData.strips.feeder;
    if (feeder && feeder.verdict === null) {
      feeder.verify().then(() => {
        if (stale()) { closeBitmap(bmp); return; }
        place();
      });
    } else place();
  };

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

  const viaWorker = (w) => {
    w.decode(absoluteUrl(initialPath), pic && pic.decodeExtra).then(arrive, (err) => {
      // A decode failure (not a missing file) means this worker cannot decode what the 2×2 self-test could not show
      // (AVIF in a worker, a killed worker): stop using it. A failed small picture is just dropped: retiring the worker
      // would send the sharp pictures still queued in it to main-thread decoding.
      if (isSmall) { if (!stale()) console.warn(`[Earth] small picture ${initialPath} could not be decoded in the worker; the sharp one comes alone`, err); return; }
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
    // The worker starts decoding after the game's first frame, not during start-up (measured: parallel with the boot
    // it made the menu 30–95 ms later and landed the pictures in the first game-loop frame).
    if (isSmall && !w) return; // no worker, no small picture (the sharp one comes alone)
    if (w) afterFirstFrame(() => { if (!stale()) viaWorker(w); }, isSmall); else viaLoader();
  };
  // The worker's self-test normally ended long before the first picture is asked for.
  if (workerPathOk === null) workerProbe.then(start); else start();
}

/** st9: an HTML image has arrived for `tex`: into a new texture of the Earth (blended in), else into `tex` itself. */
function placeImage(tex, image, level) {
  const sp = tex.userData.strips;
  if (sp && sp.onOneShot) sp.onOneShot(tex, image, true, level);
  else setEarthImage(tex, image);
}

/**
 * HTML image path (THREE.TextureLoader, AVIF → JPG fallback), assigning into the already-returned texture. three
 * honours `flipY` only for HTML images, so it is set true before one is assigned. `level` picks the tier's file
 * (see tierSources); when neither the AVIF nor the JPG of a tier can be had, the next smaller tier is tried.
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
      placeImage(tex, loaded.image, level);
      console.log(`[Earth] Loaded: ${initialPath} (${loaded.image?.width}×${loaded.image?.height})`);
      recordTexEvent('loaded', initialPath, loaded.image);
      bootMark(`Earth texture decoded: ${initialPath.split('/').pop()} (${loaded.image?.width}×${loaded.image?.height})`);
    },
    undefined,
    (err) => {
      if (stale()) return;
      if (useAvif) {
        console.warn(`[Earth] AVIF load failed for ${initialPath}, falling back to ${path}`, err);
        recordTexEvent('avif-fail', initialPath, null);
        textureLoader.load(path, (loaded) => {
          if (stale()) return;
          tex.flipY = true;
          tex.userData.loadedLevel = level;
          placeImage(tex, loaded.image, level);
          console.log(`[Earth] Loaded fallback: ${path} (${loaded.image?.width}×${loaded.image?.height})`);
          recordTexEvent('fallback-loaded', path, loaded.image);
          bootMark(`Earth texture decoded (fallback): ${path.split('/').pop()} (${loaded.image?.width}×${loaded.image?.height})`);
        }, undefined, (err2) => {
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
 * Load a texture, preferring the .avif sibling when the browser supports AVIF. The texture is returned at once and
 * its picture arrives later. Pictures decode off the main thread when the bitmap self-test passed; a bitmap failure
 * reissues the load through THREE.TextureLoader (AVIF → JPG fallback) and patches the image into the returned
 * texture so the material binding stays valid.
 *
 * @param {string} path  JPG path (e.g. 'textures/earth_day_16k.jpg'); rewritten to .avif when AVIF is supported
 * @param {number} [anisotropy=8]
 * @param {{feeder: EarthStripFeeder|null, priority: number, onReady: Function, kind?: string, onOneShot?: Function, dropped?: Function|null, decodeExtra?: object}|null} [strips]
 *   When given, a bitmap the feeder accepts is built into a separate texture in strips and
 *   `onReady(finishedTexture)` is called once; the returned texture stays the empty "not arrived yet" one.
 *   `kind` is 'sharp' or 'small' (the base-tier picture shown first); a picture the feeder does not take (no
 *   feeder, too short, a failure) goes through `onOneShot(tex, image, flipY, level)` into a NEW texture instead;
 *   `dropped()` says a small picture is no longer wanted; `decodeExtra` = createImageBitmap options for this picture only.
 * @param {EarthOfflineKeeper|null} [keeper]  told which 16k files this picture needs and when it is complete on
 *   screen at that tier (it then stores the file for offline)
 */
export function loadTexture(path, anisotropy = 8, strips = null, keeper = null) {
  const avifPath = path.replace(/\.jpg$/i, '.avif');
  const useAvif = avifSupported && avifPath !== path;
  const initialPath = useAvif ? avifPath : path;

  // A texture with no image and version 0 is skipped silently by three until the picture arrives.
  const tex = new THREE.Texture();
  tex.userData.src = { path, useAvif, initialPath };
  if (strips) tex.userData.strips = strips;
  if (keeper) { tex.userData.keeper = keeper; keeper.expect(initialPath); }
  // Bitmaps are closed after their first upload (onEarthTextureUpdate). Changing anisotropy / filters / wrap / format
  // on a live texture makes three re-upload, which would hit a closed bitmap and throw: change those only through a
  // reload (loadEarthImage).
  tex.onUpdate = onEarthTextureUpdate;
  tex.colorSpace = THREE.SRGBColorSpace;
  // three ignores flipY for ImageBitmaps (the loader flips instead); loadViaImageLoader sets it true again for an HTML image.
  tex.flipY = !bitmapPathOk;
  // Anisotropy is chosen by the caller from the LOD tier (see the Earth constructor). three clamps it to
  // renderer.capabilities.getMaxAnisotropy() at upload, so any value is a safe ceiling. It does not multiply texture memory.
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
 * Survive a lost graphics context. Bitmaps are closed after upload, so on `webglcontextrestored` (three re-uploads
 * every texture) the closed images are replaced at once by a 1×1 placeholder (uploading a closed bitmap throws) and
 * the pictures are reloaded; each arrival disposes the texture first (setEarthImage) for fresh GL storage.
 * A picture finished through strips is swapped back to its empty texture and built again; strips in flight are
 * dropped and requested again.
 *
 * @param {{dayTexture?: THREE.Texture, nightTexture?: THREE.Texture, cloudTexture?: THREE.Texture}} earth
 * @param {{domElement?: EventTarget}} renderer
 * @returns {Function} removes the listener
 */
export function attachEarthRestore(earth, renderer) {
  const target = renderer && renderer.domElement;
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const onRestored = () => {
    // Strips in flight are dropped (the new context has none of their GPU memory); each is requested again below.
    const dropped = earth._strips ? earth._strips.abandonAll() : [];
    // Small-first Earth: every picture on screen (small or sharp, strip result or one-shot copy) lost its GPU copy, and a
    // one-shot one has a closed bitmap that cannot be uploaded again, so ALL are dropped, including one mid-blend. Only the
    // sharp pictures are loaded again (no small stage after a restore); they blend in from black.
    if (typeof earth._resetPicture === 'function') {
      if (typeof earth._dropSmallPictures === 'function') earth._dropSmallPictures();
      for (const slot of PICTURE_SLOTS) {
        const r = earth._resetPicture(slot);
        if (r && r.pending && (r.shown || dropped.includes(r.pending))) loadEarthImage(r.pending);
      }
      return;
    }
    for (const slot of PICTURE_SLOTS) {
      const tex = earth[slot];
      if (!tex || !tex.userData || !tex.userData.src) continue;
      if (tex.userData.stripBuilt) {
        // Finished through strips: the lost context took its GPU copy. Back to the empty texture, then build it again.
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

// 16K FILES STORED FOR OFFLINE. The service worker precaches every texture EXCEPT the _16k ones (6 MB of AVIF would
// double the first download) and the JPGs that have an AVIF twin, and on a first visit the page is not yet controlled
// when it fetches the 16k files, so they never
// reach Cache Storage. Once BOTH 16k pictures are complete on screen and the page is controlled, it asks for each
// file once, one at a time, low priority, and the service worker's cache-first rule stores the response (no
// service-worker change). A file already in Cache Storage is never fetched again. Nothing happens on touch devices
// or below the 16k tier. DECISIONS §16: default to local; background updates must not delay or interfere with start-up or the game.

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
 * Stores the 16k files in Cache Storage for offline use (see the section note). One per Earth. `expect(path)`
 * registers a picture (only `_16k` files count, not on touch hardware); `complete(path)` says it is on screen at
 * that tier; when every expected picture is complete the work starts, once.
 */
export class EarthOfflineKeeper {
  constructor(env = offlineEnvOverride || browserOfflineEnv()) {
    this.env = env;
    /** @type {Map<string, boolean>} absolute url → complete on screen */
    this.files = new Map();
    this.started = false;
    /** Resolves when the work ended (or at once if it never starts). Tests wait on it. */
    this.done = null;
  }

  expect(initialPath) {
    if (!/_16k\.[a-z0-9]+$/i.test(String(initialPath))) return false;
    if (this.env.touch()) return false;
    this.files.set(this.env.absolute(initialPath), false);
    return true;
  }

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

// PICTURES TO THE GPU IN STRIPS. Uploading the 16k day picture took 2.3 s in one frame
// (archive/research/2026-10-startup.md, phase 4), mostly the sRGB format (SRGB8_ALPHA8 16k ≈ 1.45 s, RGBA8 ≈ 150 ms on
// the same GPU), so the format stays and the work is cut up: each picture goes to the GPU as horizontal strips of
// about 2 M texels, ONE per rendered frame (Earth.update), into a texture allocated once with its full mip chain;
// mipmaps are generated once after the last strip. Texels are identical to the one-shot upload (probe: 0/255 at 5 mip
// levels and every strip seam). Measured on Apple M5 Max / Chrome (ANGLE Metal): longest frame 1480 → 31 ms for 16k,
// 310 → 25 ms for 8k.
// Until a picture is complete the texture the shaders hold stays EMPTY; the finished one replaces it in a single step
// (Earth._setPicture → onReady). The strips' source is a fresh THREE.Texture around the ImageBitmap, never bound to a
// material (a texture three has seen would take its framebuffer-blit branch).
// Chromium-family only (the one measured). Safari/WebKit gives the same pixels but the 16k allocation alone took 1.1 s
// and each strip ~180 ms on the test Mac, so it keeps the one-shot upload; so do Firefox (unmeasured), the HTML-image
// fallback and any failure here.

/** Frames before the strip pixel check starts (it must be done long before the first 16k picture lands). */
export const CHECK_AFTER_TICKS = 20;

/** Texels per strip (16k: 128 rows, 8k: 256 rows). */
export const STRIP_TEXELS = 2 * 1024 * 1024;

/**
 * Largest SMALL picture (texels) uploaded in one go when it cannot use strips (WebKit/iPad, failed strip check, feeder
 * gave up). Measured: macOS WebKit one-shot ≈ 23 ns/texel (16k: 2.8–3.4 s; the 2048×1024 clouds made 29–111 ms
 * frames), Chromium 66–147 ms; 0.5 M texels (1024×512) ≈ 12 ms by that rate.
 */
export const SMALL_ONE_SHOT_MAX_TEXELS = 1024 * 512;

/**
 * On the one-shot route the worker decodes small pictures at this size (createImageBitmap resize options) so they fit
 * SMALL_ONE_SHOT_MAX_TEXELS. A browser that ignores the options sends the full size, which is then skipped.
 */
export const SMALL_ONE_SHOT_DECODE = Object.freeze({ resizeWidth: 1024, resizeHeight: 512, resizeQuality: 'medium' });

export function stripRows(width) {
  return Math.max(1, Math.round(STRIP_TEXELS / Math.max(1, width)));
}

/** Chromium-family engine (the strip upload is measured there only). */
export function stripsSupportedByBrowser(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const brands = nav && nav.userAgentData && nav.userAgentData.brands;
  return Array.isArray(brands) && brands.some((b) => b && /^Chromium$/i.test(b.brand));
}

export function stripsUsable(renderer) {
  if (!bitmapPathOk || !renderer) return false;
  if (typeof renderer.initTexture !== 'function' || typeof renderer.copyTextureToTexture !== 'function') return false;
  return stripsForced !== null ? stripsForced : stripsSupportedByBrowser();
}

const _scratchCentre = new THREE.Vector3();
const _scratchRel = new THREE.Vector3();
const PICTURE_SLOTS = ['dayTexture', 'nightTexture', 'cloudTexture'];

// SMALL FIRST, THEN SHARPEN. owner 2026-10-19: clouds/surface appearing was "acceptable but a little jarring"; he chose
// "small first, then sharpen". Above the base tier each slot (day, night, clouds) first loads its BASE-tier file
// (already on the device: the service worker precaches it), then the tier's own picture. Every completed picture
// BLENDS in over EARTH_BLEND_MS from what was on screen (black for the first), so nothing pops.
// Small pictures never count as "complete": that word still means the sharp picture (notePictureComplete, the offline
// store, earth.dayTexture / nightTexture / cloudTexture for BlackFrameProbe).
// Each finished picture is a texture object of its own (the strip result, or for one-shot a new texture uploaded
// BEFORE it is shown); the texture returned by loadTexture() stays an empty "loading" handle. A slot can show up to
// three pictures at once (an interrupted blend continues from the current mix, no jump); the shader gets them as
// *Texture / *Prev / *Prev2 with weights *W.

/** How long a picture takes to blend in (ms). One constant for all three slots. */
export const EARTH_BLEND_MS = 1000;

/** The blend's ease: smoothstep. 0 → 0, 1 → exactly 1. */
export function blendEase(x) {
  const t = x <= 0 ? 0 : (x >= 1 ? 1 : x);
  return smoothstep01(t);
}

/** Never uploaded, never disposed: three samples its 1×1 black. Stands in for "no picture". */
const EMPTY_TEXTURE = new THREE.Texture();
const EMPTY_LAYER = Object.freeze({ tex: EMPTY_TEXTURE, real: false });

const PICTURE_STEM = { dayTexture: 'Day', nightTexture: 'Night', cloudTexture: 'Cloud' };

/** The clock of the blend: performance.now() (never dt: the game can hold dt at 0 or run unfocused). */
function nowMs() {
  if (clockHook) return clockHook();
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function disposeTexture(t) {
  try { t && t.dispose && t.dispose(); } catch (_e) { /* best effort */ }
}

function setUniformValue(u, name, value) {
  const e = u && u[name];
  if (e) e.value = value;
}

function setWeights(u, name, w) {
  const e = u && u[name];
  if (!e) return;
  if (e.value && typeof e.value.set === 'function') e.value.set(w[0], w[1], w[2]);
  else e.value = { x: w[0], y: w[1], z: w[2] };
}

function newPictureState(pending) {
  return {
    pending,               // the empty handle loadTexture() returned for the sharp picture
    small: null,           // the empty handle of the small picture, if there is a small stage
    layers: [EMPTY_LAYER, EMPTY_LAYER, { tex: pending, real: false }], // oldest, previous, newest
    w: [0, 0, 1],          // weights now (a weight sum below 1 is black)
    from: [0, 0, 1],       // weights when the running blend started
    t0: 0,
    active: false,
    sharpSeen: false,      // the sharp picture has been shown: a small one is never shown after it
    noSmall: false,        // a context restore: no small picture is shown any more
  };
}

/** Put `texture` into one of an Earth's picture slots (field + shader uniforms). */
function swapEarthPicture(earth, slot, texture) {
  if (typeof earth._setPicture === 'function') earth._setPicture(slot, texture);
  else earth[slot] = texture;
}

function closeBitmap(bmp) {
  if (bmp && typeof bmp.close === 'function') { try { bmp.close(); } catch (_e) { /* best effort */ } }
}

/**
 * Run-time pixel check: builds a tiny picture (top and bottom half in different colours) the way a real one is built
 * (same bitmap options and destination, two strips), uploads the same bitmap in one go as the reference, draws both
 * into a small target and compares the bytes. True only if identical. Never throws; ~1–2 ms.
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
    // Let a frame go by between the two halves (each is its own task).
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
 * Order: the side of the Earth the camera sees first. Over the sunlit side (or not known yet): day, clouds, night;
 * over the dark side: night, day, clouds. Decided when a picture starts; a started picture is finished before the
 * next (each unfinished picture holds its own full-size GPU allocation).
 * Used for a picture only if `verify()` found the strip result identical to a one-shot upload (once, at start-up) and
 * the picture fits the GPU's texture size.
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
    // A test check or the test switch answers at once. The real check touches the GPU (a few ms, ~50 ms measured under
    // load 50), so it waits for CHECK_AFTER_TICKS frames or a picture arriving, whichever is first.
    if (stripCheckHook || stripsForced !== null) this.verify();
  }

  get busy() { return !!this.active || this.queue.length > 0; }

  /**
   * The run-time pixel check, run once; cached in `verdict`. Never throws. Skipped (true) under the test switch
   * `stripsOk` unless a test brings its own check.
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
   * Does this bitmap go through strips? Needs: the pixel check passed, more than one strip of rows, a live context, and
   * a size the GPU accepts (a bigger one is shrunk by the one-shot upload; strips would fail on it). A SMALL picture
   * one strip tall (the 2048×1024 clouds) is taken too, as a single strip: its one-shot upload made a 66–147 ms frame in
   * every warm Chromium run, where a strip of the same size costs a normal frame.
   * @param {string} [kind]  'small' | 'sharp'
   */
  accepts(bmp, kind) {
    return this.verdict === true && !this.broken && !!bmp
      && (bmp.height > stripRows(bmp.width) || (kind === 'small' && bmp.height > 0))
      && this._fitsGpu(bmp) && !this._lost();
  }

  /**
   * Queue a picture; `onReady(finishedTexture)` runs once, after its last strip. `meta.kind` ('small' | 'sharp') ranks
   * the job (every small picture is built before any sharp one); `meta.level` is the tier the picture was decoded at,
   * recorded NOW (a later decode into the same slot must not relabel this job's result).
   * @param {{kind?: string, level?: number}} [meta]
   */
  enqueue(tex, bmp, priority, onReady, meta = {}) {
    this.queue.push({
      tex, bmp, priority, onReady, order: this._order++, step: 0, dst: null, src: null, rows: 0, count: 0,
      kind: meta.kind === 'small' ? 'small' : 'sharp',
      level: meta.level !== undefined ? meta.level : tex.userData.loadedLevel,
    });
  }

  /** One step of work: allocate the next picture, or upload its next strip. Nothing happens while the context is lost. */
  tick() {
    if (this.verdict === null && !this._verdictPromise && ++this._ticks >= CHECK_AFTER_TICKS) this.verify();
    if (this._lost()) return false;
    if (!this.active) {
      // a queued small picture whose sharp one is already shown (or after a restore) is never built
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const j = this.queue[i];
        const sp = j.kind === 'small' && j.tex.userData.strips;
        if (sp && sp.dropped && sp.dropped()) { this.queue.splice(i, 1); closeBitmap(j.bmp); }
      }
      if (this.queue.length === 0) return false;
      let sunlit = true;
      try { if (this.sunlit) sunlit = this.sunlit() !== false; } catch (_e) { sunlit = true; }
      // priority: 0 day, 1 clouds, 2 night; dark side in view: night, day, clouds. Every small picture comes before any sharp one.
      const rank = (p) => (sunlit ? p : (p === 2 ? 0 : p + 1));
      const stage = (j) => (j.kind === 'small' ? 0 : 1);
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i], b = this.queue[best];
        if (stage(a) < stage(b)
          || (stage(a) === stage(b) && (rank(a.priority) < rank(b.priority) || (rank(a.priority) === rank(b.priority) && a.order < b.order)))) best = i;
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

  /** Allocate and fill a whole picture at once (the pixel check uses this). */
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
    // The tier and owner of this result are the ones recorded when the job was queued (never read from the slot's
    // texture now: another decode may have changed it).
    dst.userData.loadedLevel = job.level;
    dst.userData.stage = job.kind;
    if (job.kind !== 'small') dst.userData.keeper = tex.userData.keeper; // a small picture never counts as "complete"
    const file = tex.userData.src.initialPath;
    console.log(`[Earth] Ready: ${file} (${job.width}×${job.height}, ${job.count} strips of ${job.rows} rows, camera over the ${job.sunlit === false ? 'dark' : 'sunlit'} side when it started)`);
    recordTexEvent('ready', file, { width: job.width, height: job.height });
    bootMark(`Earth texture complete: ${file.split('/').pop()} (${job.width}×${job.height})`);
    try { job.onReady(dst); } catch (e) { console.error('[Earth] onReady failed', e); }
  }

  /**
   * Upload a queued picture in one go (strips cannot be used). A small picture is not worth a heavy upload and is
   * dropped (the sharp one comes alone); a sharp one of an Earth goes through its one-shot hook (a new texture, blended
   * in), any other into its own texture.
   */
  _oneShot(job) {
    if (job.kind === 'small') { closeBitmap(job.bmp); return; }
    const sp = job.tex.userData.strips;
    if (sp && sp.onOneShot) sp.onOneShot(job.tex, job.bmp, false, job.level);
    else setEarthImage(job.tex, job.bmp);
  }

  /** A strip failed: free the half-built texture and upload the bitmap in one go instead. */
  _giveUp(job) {
    this.active = null;
    try { job.dst && job.dst.dispose(); } catch (_e) { /* best effort */ }
    try { this._oneShot(job); } catch (e) { console.error('[Earth] one-shot fallback failed', e); }
    const rest = this.queue.splice(0);
    for (const j of rest) { try { this._oneShot(j); } catch (_e) { /* best effort */ } }
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

/**
 * Pure LOD selector, testable without DOM/WebGL. Primary signal: maxTextureSize from renderer capabilities.
 * Secondary: deviceMemory + Apple-GPU heuristics (Safari fallback).
 *
 * @param {number|undefined} deviceMemory  navigator.deviceMemory (undefined on Safari/Firefox)
 * @param {boolean} [isAppleGPU=false]  WEBGL_debug_renderer_info contains 'Apple'
 * @returns {'16k'|'8k'|''}
 */
export function selectLOD(maxTextureSize, deviceMemory, isAppleGPU = false) {
  // Memory: default to 8 GB when unavailable (Safari on macOS = capable HW)
  const memory = deviceMemory ?? 8;

  if (maxTextureSize >= Constants.EARTH.LOD_16K_THRESHOLD) {
    if (memory >= 8 || isAppleGPU) return '16k';
    return '8k';
  }
  if (maxTextureSize >= Constants.EARTH.LOD_8K_THRESHOLD) {
    if (memory >= 4) return '8k';
    return '';
  }
  return '';
}

/*
 * Day AND night maps are 16k on a capable desktop; do not cap either (DECISIONS §16).
 * The night map was once capped at 8k on Apple GPUs (OPEN-2): on an M4 Max (Brave, ANGLE-Metal) the 16k night-side
 * city lights rendered pure BLACK in long real sessions while every GL-visible witness stayed healthy (decoded,
 * uploaded, zero gl.getError, zero context losses). Best explanation, never proven: long-session Metal residency
 * eviction of the largest textures (512 MB + mips apiece). If the lights go black again, check `?bfp=1` and
 * BLACK_SCREEN_TRIAGE.md first; the owner decides any cap. `?tex=16k|8k|base` still forces both maps.
 */

/**
 * Cap the WHOLE texture stack at 8k on real touch hardware (Ipad.md §4.2, §4.5). Two reasons:
 *   1. Offline: the sw.js precache is capped at the 8k tier (no *_16k.*, scripts/build-precache.mjs), so an iPad that
 *      selected 16k would request a file the offline cache can never hold and boot a black Earth when launched unplugged.
 *   2. An iPad reports Apple GPU + maxTextureSize 16384 and would take the 512 MB (+mips) 16k day map, the resource
 *      class that goes residency-black on Apple GPUs (OPEN-2, see the note above), with none of a Mac's headroom.
 * Gate: TouchControls.detect(), the ONE touch gate. Desktops and headless bench contexts report no touch, so their
 * selection is unchanged. The `?tex=16k` override in getTextureQuality() returns before detection and bypasses this clamp.
 * Pure + exported for the Node suite, like selectLOD.
 *
 * @param {'16k'|'8k'|''} quality  overall tier from selectLOD()
 * @param {boolean} hasTouch  real-touch detection result
 * @returns {'16k'|'8k'|''} day-map tier (== quality except 16k-on-touch → 8k)
 */
export function clampLODForGlass(quality, hasTouch) {
  if (hasTouch && quality === '16k') return '8k';
  return quality;
}

/**
 * Detect hardware capability and return the best texture quality tier; selectLOD() makes the decision.
 * With the game's own renderer, max texture size and the Apple GPU string are read from it (a throw-away WebGL
 * context costs ~20 ms on a GPU, seconds on a software renderer). Without one (tests, other callers) a probe canvas
 * runs, each probe context released with WEBGL_lose_context after reading.
 *
 * @param {object} [opts]
 * @param {{capabilities?: {maxTextureSize?: number}, getContext?: Function}} [opts.renderer]  the game's THREE.WebGLRenderer (or a stand-in)
 * @param {Document} [opts.doc]  document for the probe canvas (default: global)
 * @param {Navigator} [opts.nav]  navigator for deviceMemory (default: global)
 * @returns {{quality: '16k'|'8k'|'', dayQuality: '16k'|'8k'|'', nightQuality: '16k'|'8k'|''}}
 *   `quality` = hardware tier (mesh detail, anisotropy, cloud file); `dayQuality` = `nightQuality` = `quality` (DECISIONS §16)
 */
export function getTextureQuality({ renderer, doc, nav } = {}) {
  // `?tex=16k|8k|base` overrides hardware LOD detection (the NIGHT map too) so the 1.2+ GB 16k set can be A/B'd against
  // 8k in one URL (OPEN-2 triage). Opt-in, exact-value only (DevShotGate idiom); any other value falls through to
  // detection. Dev-only: never ship URLs with it.
  try {
    if (typeof window !== 'undefined' && typeof URLSearchParams !== 'undefined') {
      const raw = (new URLSearchParams(devSearch(window.location)).get('tex') || '').toLowerCase();
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
  const deviceMemory = navigatorRef ? navigatorRef.deviceMemory : undefined;

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
    // Probe path (no renderer yet): each context is released after reading so a throw-away context never lingers.
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
  // Day and night ride the full hardware tier (DECISIONS §16).
  const dayQuality = quality;
  const nightQuality = quality;
  // verbose LOD log behind ?debug=1
  if (Constants && Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
    console.log(`[Earth] LOD selected: ${quality || '4k (base)'} (pictures: day ${dayQuality || '4k (base)'}, night: ${nightQuality || '4k (base)'}). MaxTextureSize=${maxTextureSize}`);
  }
  return { quality, dayQuality, nightQuality };
}

/**
 * Sphere tessellation per texture-quality tier. Pure + exported for tests, like selectLOD. A hard-coded 256×256
 * (~131k tris) on every device was the biggest static vertex load in the scene; segment counts now ride the same
 * hardware signal as the textures. Applied at CONSTRUCTION only: a live tier change does not rebuild the spheres
 * (static vertex cost; rebuilding would hitch).
 *
 * @param {'16k'|'8k'|''} quality  from selectLOD()/getTextureQuality()
 * @returns {{surface:number, clouds:number, atmosphere:number}} widthSegments (heightSegments uses the same value;
 *   the analytic atmosphere needs the least)
 */
export function selectSphereSegments(quality) {
  if (quality === '16k') return { surface: 256, clouds: 128, atmosphere: 64 };
  if (quality === '8k')  return { surface: 160, clouds: 96,  atmosphere: 64 };
  return { surface: 96, clouds: 64, atmosphere: 48 };
}

export class Earth {
  /**
   * @param {THREE.Scene} scene
   * @param {{renderer?: THREE.WebGLRenderer}} [options] renderer: the game's own, so the texture-tier probe needs no
   *   throw-away WebGL context
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'EarthGroup';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();

    // LOD-tier flag for the LOW_DETAIL fragment-shader branch, toggled by Earth.setLowDetail (SceneManager.applyTier).
    // `?disableEarthNoise=1` force-pins it on at construction so the 7-octave noise stack is compiled out at every
    // tier (A/B of the procedural-terrain cost).
    this._useLowDetail = profileFlags.disableEarthNoise === true;

    // Texture resolution by hardware. `quality` = hardware tier (mesh detail, anisotropy, cloud file); day and night
    // follow it (16k on a capable desktop, DECISIONS §16).
    const { quality, dayQuality, nightQuality } = getTextureQuality({ renderer: options && options.renderer });
    const texSuffix = dayQuality ? `_${dayQuality}` : '';
    const nightSuffix = nightQuality ? `_${nightQuality}` : '';
    const cloudSuffix = quality === '16k' ? '_8k' : (quality === '8k' ? '_8k' : '');
    // Sphere tessellation rides the hardware tier; construction-only (see selectSphereSegments).
    this._sphereSegments = selectSphereSegments(quality);

    console.log(`[Earth] Texture quality: hardware ${quality || 'base'}, pictures day "${texSuffix || 'base'}" night "${nightSuffix || 'base'}"`);

    // Anisotropy scales with the LOD tier so the weakest GPUs (base tier) don't pay for 16x: 4 / 8 / 16.
    const texAniso = quality === '16k' ? 16 : (quality === '8k' ? 8 : 4);

    // Aniso stays keyed on the hardware tier. On a strip-capable browser each picture is built on the GPU one strip per
    // frame (priority day, clouds, night) and swapped in when complete.
    this._camPos = new THREE.Vector3();
    this._camSeen = false;
    this._renderer = (options && options.renderer) || null;
    this._strips = options && stripsUsable(options.renderer)
      ? new EarthStripFeeder(options.renderer, { sunlit: () => this._cameraOverSunlitSide() })
      : null;
    // The picture state per slot exists before any picture is asked for (arrivals call back into it).
    this._pics = {};
    // The staging hook of one picture: where its result goes. kind 'sharp' = the tier's own picture, 'small' = the
    // base-tier picture shown first.
    const hook = (slot, priority, kind) => ({
      kind, slot, priority,
      feeder: this._strips,
      onReady: (t) => this._setPicture(slot, t, kind),
      onOneShot: (tex, image, flipY, level) => this._oneShotPicture(slot, kind, tex, image, flipY, level),
      dropped: kind === 'small' ? () => this._smallDropped(slot) : null,
      // no strips on this browser: decode the small picture small enough for one frame
      decodeExtra: kind === 'small' && !this._strips ? SMALL_ONE_SHOT_DECODE : undefined,
    });
    // Stores the 16k files for offline once both are on screen (nothing below 16k / on touch). The sharp pictures are
    // asked for in this order; the small ones follow below and are DISPATCHED ahead of them once the first frame is
    // drawn (afterFirstFrame).
    this._offline = new EarthOfflineKeeper();
    this.dayTexture = loadTexture(`textures/earth_day${texSuffix}.jpg`, texAniso, hook('dayTexture', 0, 'sharp'), this._offline);
    this.nightTexture = loadTexture(`textures/earth_night${nightSuffix}.jpg`, texAniso, hook('nightTexture', 2, 'sharp'), this._offline);
    // Clouds are low-frequency and anisotropy cost concentrates at grazing angles (the limb), where clouds are softest:
    // 4x is indistinguishable from the tier value and trims bandwidth on the overdraw-heaviest (transparent) layer.
    this.cloudTexture = loadTexture(`textures/earth_clouds${cloudSuffix}.jpg`, Math.min(texAniso, 4), hook('cloudTexture', 1, 'sharp'));
    this._pics.dayTexture = newPictureState(this.dayTexture);
    this._pics.nightTexture = newPictureState(this.nightTexture);
    this._pics.cloudTexture = newPictureState(this.cloudTexture);
    // Above the base tier each slot shows its base-tier picture first (never at the base tier or with ?tex=base: nothing
    // is smaller). Order = the strip order (day, clouds, night).
    if (smallFirstOn) {
      if (texSuffix) this._pics.dayTexture.small = loadTexture('textures/earth_day.jpg', texAniso, hook('dayTexture', 0, 'small'));
      if (cloudSuffix && !profileFlags.disableClouds) this._pics.cloudTexture.small = loadTexture('textures/earth_clouds.jpg', Math.min(texAniso, 4), hook('cloudTexture', 1, 'small'));
      if (nightSuffix) this._pics.nightTexture.small = loadTexture('textures/earth_night.jpg', texAniso, hook('nightTexture', 2, 'small'));
    }
    // Bitmaps are closed after upload; reload them after a lost context.
    if (options && options.renderer) attachEarthRestore(this, options.renderer);

    this._createSurface();
    // `?disableClouds=1` skips the cloud sphere (transparent, depthWrite=false: a bandwidth hog at 5760×3600) to isolate its cost.
    if (!profileFlags.disableClouds) {
      this._createClouds();
    } else {
      this.cloudMesh = null;
      this.cloudMaterial = null;
      console.info('[Earth] cloud layer skipped (?disableClouds=1)');
    }
    // `?disableAtmosphere=1` skips the atmosphere shell.
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
   * A picture of a slot is ready (uploaded): hand it to the shaders, blended in. A sharp one is also
   * `earth.dayTexture` / `nightTexture` / `cloudTexture` (BlackFrameProbe reads them) at once; a small one never is.
   * The cloud picture sits in two uniforms; the cloud shell is null under `?disableClouds=1`.
   */
  _setPicture(slot, texture, kind = 'sharp') {
    const st = this._pics && this._pics[slot];
    const small = kind === 'small';
    if (!st) {
      // No picture state (a partial object in a test, or an Earth that is not finished building): the plain swap.
      this[slot] = texture;
      if (texture && texture.userData && texture.userData.stripBuilt) notePictureComplete(texture);
      const surface = this.surfaceMaterial && this.surfaceMaterial.uniforms;
      if (slot === 'dayTexture' && surface) surface.uDayTexture.value = texture;
      else if (slot === 'nightTexture' && surface) surface.uNightTexture.value = texture;
      else if (slot === 'cloudTexture') {
        if (surface) surface.uCloudTexture.value = texture;
        if (this.cloudMaterial) this.cloudMaterial.uniforms.uCloudTexture.value = texture;
      }
      return;
    }
    if (small && (st.sharpSeen || st.noSmall)) {
      // finished after the sharp picture (or after a context restore): never shown
      disposeTexture(texture);
      console.log(`[Earth] small ${slot} dropped (finished too late)`);
      return;
    }
    if (!small) {
      st.sharpSeen = true;
      this[slot] = texture;
      // A picture finished through strips (not the empty one put back by a restore); a small one never counts.
      if (texture && texture.userData && texture.userData.stripBuilt) notePictureComplete(texture);
    }
    this._pushPicture(slot, texture);
  }

  _smallDropped(slot) {
    const st = this._pics && this._pics[slot];
    return !!st && (st.sharpSeen === true || st.noSmall === true);
  }

  /**
   * One-shot route and fallbacks: the decoded picture goes into a NEW texture that is uploaded first, then shown
   * (blended in). The loading handle `pending` is never uploaded, so the picture on screen is never disposed under the
   * blend and `earth.*Texture` never points at a texture that has not reached the GPU.
   * @param {THREE.Texture} pending  the loading handle the picture was asked for with
   * @param {boolean} flipY  true for an HTML image (a bitmap is flipped by the decoder)
   * @param {number} level  the tier the picture was decoded at, recorded at arrival
   */
  _oneShotPicture(slot, kind, pending, image, flipY = false, level = pending.userData.loadedLevel) {
    if (kind === 'small' && this._smallDropped(slot)) { closeBitmap(image); return; }
    const t = new THREE.Texture(image);
    t.colorSpace = pending.colorSpace;
    t.flipY = flipY === true;
    t.anisotropy = pending.anisotropy;
    t.minFilter = pending.minFilter;
    t.magFilter = pending.magFilter;
    t.wrapS = pending.wrapS;
    t.wrapT = pending.wrapT;
    t.generateMipmaps = true;
    t.onUpdate = onEarthTextureUpdate; // closes the bitmap after the upload; tells the keeper (sharp only)
    t.userData.src = pending.userData.src;
    t.userData.pending = pending;
    t.userData.loadedLevel = level;
    t.userData.stage = kind;
    t.userData.picW = image.width; // the bitmap is closed after the upload; keep its size for the log
    t.userData.picH = image.height;
    if (kind !== 'small') t.userData.keeper = pending.userData.keeper;
    t.needsUpdate = true;
    // Upload now: the cost lands here, outside the render.
    try {
      if (this._renderer && typeof this._renderer.initTexture === 'function') this._renderer.initTexture(t);
    } catch (e) {
      console.warn('[Earth] early upload failed; it will upload at the first draw', e);
    }
    this._setPicture(slot, t, kind);
  }

  /**
   * A new picture takes the newest place of its slot; the blend runs from what is on screen now (weights continue if
   * another blend runs, nothing jumps).
   */
  _pushPicture(slot, texture) {
    const st = this._pics[slot];
    const now = nowMs();
    const cur = this._weightsAt(st, now);
    const [la, lb, lc] = st.layers;
    // The oldest picture falls off (a third arrival inside one blend; its share goes to the next).
    if (la.real) disposeTexture(la.tex);
    const fa = lb.real ? cur[1] + (la.real ? cur[0] : 0) : 0;
    const fb = lc.real ? cur[2] : 0;
    st.layers = [lb.real ? lb : EMPTY_LAYER, lc.real ? lc : EMPTY_LAYER, { tex: texture, real: true }];
    st.from = [fa, fb, 0];
    st.w = [fa, fb, 0];
    st.t0 = now;
    st.active = true;
    this._applyPicture(slot);
    const ud = texture.userData || {};
    const file = ud.src ? ud.src.initialPath : slot;
    const dims = { width: ud.uploadedWidth || ud.picW || 0, height: ud.uploadedHeight || ud.picH || 0 };
    console.log(`[Earth] On screen (blending in over ${EARTH_BLEND_MS} ms): ${file} (${dims.width}×${dims.height})`);
    recordTexEvent('shown', file, dims);
    bootMark(`Earth picture on screen: ${String(file).split('/').pop()} (${dims.width}×${dims.height})`);
  }

  /** The weights [oldest, previous, newest] of a slot at time `now`. */
  _weightsAt(st, now) {
    if (!st.active) return st.w;
    const e = blendEase((now - st.t0) / EARTH_BLEND_MS);
    const k = 1 - e;
    return [st.from[0] * k, st.from[1] * k, st.from[2] * k + e];
  }

  _applyPicture(slot) {
    const st = this._pics[slot];
    const P = PICTURE_STEM[slot];
    const [a, b, c] = st.layers;
    const surface = this.surfaceMaterial && this.surfaceMaterial.uniforms;
    const targets = [surface];
    if (slot === 'cloudTexture') targets.push(this.cloudMaterial && this.cloudMaterial.uniforms);
    for (const u of targets) {
      if (!u) continue;
      setUniformValue(u, `u${P}Texture`, c.tex);
      setUniformValue(u, `u${P}Prev`, b.tex);
      setUniformValue(u, `u${P}Prev2`, a.tex);
      setWeights(u, `u${P}W`, st.w);
    }
    if (slot === 'dayTexture' && surface) {
      // how much of the day picture is a real picture (the ocean shine follows it); exactly 1 when whole
      let vis = 0;
      if (a.real) vis += st.w[0];
      if (b.real) vis += st.w[1];
      if (c.real) vis += st.w[2];
      setUniformValue(surface, 'uDayVis', vis > 1 ? 1 : vis);
    }
  }

  /** Move every running blend forward to `now` (called from tickStrips, so also while unfocused). */
  _advanceBlends(now) {
    if (!this._pics) return;
    for (const slot of PICTURE_SLOTS) {
      const st = this._pics[slot];
      if (!st || !st.active) continue;
      if ((now - st.t0) / EARTH_BLEND_MS >= 1) {
        // done: only the newest picture is left, the others go (each is disposed exactly once)
        for (const l of st.layers) if (l.real && l !== st.layers[2]) disposeTexture(l.tex);
        st.layers = [EMPTY_LAYER, EMPTY_LAYER, st.layers[2]];
        st.w = [0, 0, 1];
        st.from = [0, 0, 1];
        st.active = false;
      } else {
        st.w = this._weightsAt(st, now);
      }
      this._applyPicture(slot);
    }
  }

  /**
   * A lost graphics context: everything shown in the slot is gone (strip results lost their GPU memory; a one-shot
   * picture's bitmap is closed). Disposes it all and shows nothing (black, then the sharp picture blends in when loaded again).
   * @returns {{pending: THREE.Texture, shown: boolean}|null}  the loading handle, and whether a sharp picture had been
   *   shown (then it must be loaded again)
   */
  _resetPicture(slot) {
    const st = this._pics && this._pics[slot];
    if (!st) return null;
    for (const l of st.layers) if (l.real) disposeTexture(l.tex);
    const shown = st.sharpSeen === true;
    st.layers = [EMPTY_LAYER, EMPTY_LAYER, { tex: st.pending, real: false }];
    st.w = [0, 0, 1];
    st.from = [0, 0, 1];
    st.active = false;
    st.sharpSeen = false;
    this[slot] = st.pending;
    this._applyPicture(slot);
    return { pending: st.pending, shown };
  }

  /** After a restore no small picture is shown again; one still being decoded is dropped on arrival. */
  _dropSmallPictures() {
    for (const slot of PICTURE_SLOTS) {
      const st = this._pics && this._pics[slot];
      if (!st) continue;
      st.noSmall = true;
      if (st.small) st.small.userData.loadSeq = (st.small.userData.loadSeq || 0) + 1;
    }
  }

  /**
   * Is the camera over the sunlit half? dot(camera position relative to the Earth's centre, sun direction) >= 0. Null
   * until the surface has been drawn once.
   */
  _cameraOverSunlitSide() {
    if (!this._camSeen) return null;
    const centre = this.group.getWorldPosition(_scratchCentre);
    const rel = _scratchRel.copy(this._camPos).sub(centre);
    return rel.dot(this.sunDirection) >= 0;
  }

  /** Feed at most one picture strip (once per drawn frame; main.js also calls this while the window is unfocused). */
  tickStrips() {
    noteFirstFrame(); // the decode worker starts after the first frame
    if (this._strips) this._strips.tick();
    this._advanceBlends(nowMs()); // blends run on the real clock, with or without dt
  }

  _createSurface() {
    const segs = this._sphereSegments.surface;
    const geometry = new THREE.SphereGeometry(Constants.EARTH_RADIUS, segs, segs);

    this.surfaceMaterial = new THREE.ShaderMaterial({
      vertexShader: earthSurfaceVertexShader,
      fragmentShader: earthSurfaceFragmentShader,
      uniforms: {
        // Newest picture, the two before it, their weights (see the shader). Start: the empty handle alone.
        uDayTexture: { value: this.dayTexture },
        uDayPrev: { value: EMPTY_TEXTURE },
        uDayPrev2: { value: EMPTY_TEXTURE },
        uDayW: { value: new THREE.Vector3(0, 0, 1) },
        uDayVis: { value: 0 },
        uNightTexture: { value: this.nightTexture },
        uNightPrev: { value: EMPTY_TEXTURE },
        uNightPrev2: { value: EMPTY_TEXTURE },
        uNightW: { value: new THREE.Vector3(0, 0, 1) },
        uCloudTexture: { value: this.cloudTexture },
        uCloudPrev: { value: EMPTY_TEXTURE },
        uCloudPrev2: { value: EMPTY_TEXTURE },
        uCloudW: { value: new THREE.Vector3(0, 0, 1) },
        uCloudRotation: { value: 0 },
        uSunDirection: { value: this.sunDirection },
      },
      // `defines` controls the LOW_DETAIL branch (setLowDetail touches only that key). NO_CLOUD_SHADOWS compiles the
      // surface cloud-shadow fetch out when clouds are profiling-disabled, so the ?disableClouds A/B stays pure; it survives tier flips.
      defines: {
        ...(this._useLowDetail ? { LOW_DETAIL: 1 } : {}),
        ...(profileFlags.disableClouds ? { NO_CLOUD_SHADOWS: 1 } : {}),
      },
    });

    this.surfaceMesh = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.surfaceMesh.name = 'EarthSurface';
    // Remember where the camera is (world space), for the strip order.
    this.surfaceMesh.onBeforeRender = (_renderer, _scene, camera) => {
      const e = camera.matrixWorld.elements;
      this._camPos.set(e[12], e[13], e[14]);
      this._camSeen = true;
    };
    this.group.add(this.surfaceMesh);
  }

  /**
   * Toggle the fragment shader's LOW_DETAIL branch (SceneManager.applyTier calls it on a tier switch). When true the
   * 7-octave noise stack in earthSurfaceFragmentShader is compiled out: the base AVIF texture carries detail on its own.
   * Idempotent and mid-flight safe: mutates `defines` and flips `needsUpdate` so the program recompiles next frame.
   * @param {boolean} enabled
   */
  /**
   * Toggle the cloud sphere's visibility (AutoProfileSweep A/B of the cloud-layer GPU cost mid-session). No-op when
   * clouds were never created (`?disableClouds=1` at boot).
   * @param {boolean} visible
   */
  setCloudsVisible(visible) {
    if (this.cloudMesh) {
      this.cloudMesh.visible = visible !== false;
    }
  }

  /**
   * Toggle the atmosphere shell's visibility. No-op when it was never created (`?disableAtmosphere=1` at boot).
   * @param {boolean} visible
   */
  setAtmosphereVisible(visible) {
    if (this.atmosphereMesh) {
      this.atmosphereMesh.visible = visible !== false;
    }
  }

  setLowDetail(enabled) {
    // `?disableEarthNoise=1` force-pins LOW_DETAIL on regardless of the tier: otherwise SceneManager.setEarth /
    // applyTier would call `setLowDetail(false)` at HIGH/MEDIUM tier and silently undo the flag.
    const want = profileFlags.disableEarthNoise ? true : !!enabled;
    if (this._useLowDetail === want) return;
    this._useLowDetail = want;
    if (!this.surfaceMaterial) return;
    const defs = this.surfaceMaterial.defines || {};
    if (want) {
      defs.LOW_DETAIL = 1;
    } else {
      delete defs.LOW_DETAIL;
    }
    this.surfaceMaterial.defines = defs;
    this.surfaceMaterial.needsUpdate = true;
  }

  _createClouds() {
    const segs = this._sphereSegments.clouds;
    const geometry = new THREE.SphereGeometry(Constants.CLOUD_RADIUS, segs, segs);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uCloudTexture: { value: this.cloudTexture },
        uCloudPrev: { value: EMPTY_TEXTURE },
        uCloudPrev2: { value: EMPTY_TEXTURE },
        uCloudW: { value: new THREE.Vector3(0, 0, 1) },
        uSunDirection: { value: this.sunDirection },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      // Polygon offset prevents z-fighting where the cloud sphere nearly overlaps the surface at grazing angles. Negative
      // values pull cloud depth TOWARD the camera so clouds win at the limb, where the 0.10-unit (10 km) gap collapses in
      // screen-space depth.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.cloudMesh = new THREE.Mesh(geometry, this.cloudMaterial);
    this.cloudMesh.name = 'EarthClouds';
    this.group.add(this.cloudMesh);
  }

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
    // Layer 0 only, no bloom layer: threshold bloom glows only very bright objects (emissive > 0.85).
    this.group.add(this.atmosphereMesh);
  }

  /** @param {THREE.Vector3} dir  normalized sun direction */
  setSunDirection(dir) {
    this.sunDirection.copy(dir);
    this.surfaceMaterial.uniforms.uSunDirection.value.copy(dir);
    // cloud / atmosphere are null under `?disableClouds=1` / `?disableAtmosphere=1`.
    if (this.cloudMaterial) {
      this.cloudMaterial.uniforms.uSunDirection.value.copy(dir);
    }
    if (this.atmosphereMaterial) {
      this.atmosphereMaterial.uniforms.uSunDirection.value.copy(dir);
    }
  }

  /** @param {number} dt  seconds */
  update(dt) {
    this.tickStrips();
    if (this.atmosphereMaterial) {
      // Keep the analytic shader's Earth-center uniform in sync (group may move).
      this.atmosphereMesh.getWorldPosition(this.atmosphereMaterial.uniforms.uCenter.value);
    }

    // Sidereal cloud rotation (visible drift over a game hour). The live rotation is fed to the surface shader so its
    // straight-down cloud-shadow projection stays registered to the drifting clouds.
    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += Constants.EARTH.CLOUD_ROTATION_RATE * dt;
      this.surfaceMaterial.uniforms.uCloudRotation.value = this.cloudMesh.rotation.y;
    }
  }

  getGroup() {
    return this.group;
  }
}

export default Earth;
