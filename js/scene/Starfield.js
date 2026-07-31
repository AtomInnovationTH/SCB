/**
 * Starfield.js — 10,000 background stars (size-honoring ShaderMaterial with
 * round soft sprites; the 49 named catalogue stars sit at the constellation
 * vertices in the same Points), a faint procedural Milky Way band, an
 * occasional shooting star, plus 8 major constellation outlines and
 * planetarium-style labels
 * @module scene/Starfield
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';
import { BRIGHT_STARS, CONSTELLATION_FIGURES, sampleFieldMagnitude, fieldSizeAlpha, magnitudeBrightness, skyBrightness } from './starCatalog.js';

// ============================================================================
// RA/Dec → Cartesian conversion
// ============================================================================

/**
 * Convert Right Ascension (hours) and Declination (degrees) to 3D cartesian
 * coordinates on the star sphere.
 *
 * Convention: +Y is celestial north, RA 0 at +X, with Z negated. Exported so
 * the `?shot=1` sky-pose hook in main.js can reuse it rather than re-deriving
 * (this basis is easy to get subtly wrong).
 *
 * @param {number} raHours — RA in hours (0–24)
 * @param {number} decDeg  — Dec in degrees (-90 to +90)
 * @param {number} radius  — sphere radius
 * @returns {THREE.Vector3}
 */
export function raDec2xyz(raHours, decDeg, radius) {
  const ra = raHours * (Math.PI / 12);   // hours → radians
  const dec = decDeg * (Math.PI / 180);  // degrees → radians
  return new THREE.Vector3(
    radius * Math.cos(dec) * Math.cos(ra),
    radius * Math.sin(dec),
    -radius * Math.cos(dec) * Math.sin(ra)
  );
}

// ============================================================================
// CONSTELLATION LABEL — canvas-based text texture (planetarium style)
// ============================================================================

/**
 * Create a subtle planetarium-style label texture for a constellation name.
 * Matches the thin-font aesthetic from planet labels (Sprint C4).
 *
 * Sprint 3 GPU profiling — Phase C.5 (2026-05-23, rev. 2): canvas resolution
 * quadrupled (original 512×128 → 2048×512) and font / shadow scaled 4×
 * proportionally. First attempt (1024×256) was still soft per user smoke test.
 * The label sprite occupies ~80–150 screen pixels of width at typical camera
 * distances; at pr=1.5 retina (≈225 physical pixels) the GPU samples the
 * texture's mip1 or mip2 level. A 2048-px-wide base texture means mip1 is
 * still 1024 px wide — plenty of detail headroom. Cost: 16 MB total VRAM
 * across 8 constellations (vs 4 MB at 1024×256, 256 KB original) — well
 * within budget for fixed scene chrome.
 *
 * @param {string} text — constellation name (e.g. "ORION")
 * @returns {THREE.CanvasTexture}
 */
function createConstellationLabel(text) {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 512;
  const ctx = c.getContext('2d');
  // Sprint 3 GPU profiling — Phase C.5 (2026-05-23, rev. 4): font weight
  // bumped to 700 and shadow glow removed entirely. The first three revs
  // progressively raised texel density (512→1024→2048) and font weight
  // (400→600) but text was still soft. Root cause: at pr=1.5 + no SMAA,
  // mip-level sampling averages adjacent texels and the planetarium-soft
  // shadow was bleeding into the glyph silhouette, blurring the perceived
  // edge. 700-weight strokes (~80% thicker than original 400) survive any
  // mip sampling, and removing the shadow lets the glyph edge stay crisp.
  // Fill color brightened from #aabbdd → #cce0ff to keep readability after
  // losing the bluish glow.
  ctx.font = '700 224px Arial, "Helvetica Neue", Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8792a8';
  ctx.globalAlpha = 1.0;
  ctx.fillText(text, 1024, 256);
  return new THREE.CanvasTexture(c);
}

// ============================================================================
// STARFIELD CLASS
// ============================================================================

export class Starfield {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'StarfieldGroup';

    // Accumulated time for the star twinkle shader uniform.
    this._time = 0;
    // Reusable temporaries for the shooting-star update (no per-frame alloc).
    this._tmpMeteorA = new THREE.Vector3();
    this._tmpMeteorB = new THREE.Vector3();

    this.mesh = this._create();
    this.group.add(this.mesh);
    this._createMilkyWay();
    this._createConstellations();
    this._initShootingStar();

    scene.add(this.group);
  }

  /**
   * Build the star Points object
   * @returns {THREE.Points}
   * @private
   */
  _create() {
    const count = Constants.STAR_COUNT;
    const radius = Constants.STAR_SPHERE_RADIUS;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // Per-star alpha (0..1) so the faint field can fade below the size floor
    // without hue-shifting — alpha carries faintness once size is pinned at the
    // 1.2 px floor. Catalogue stars stay at 1.
    const alphas = new Float32Array(count);
    // Twinkle amplitude per star (0 = steady). The whole field is steady today
    // — the catalogue stars are real sky and do not shimmer, and the old fake
    // "prominent" block that twinkled is gone. Kept as an attribute so the
    // vertex shader can modulate size over time without touching the CPU each
    // frame; Stage 5 repurposes it.
    const twinkle = new Float32Array(count);
    // Random per-star phase so twinkles don't beat in unison.
    const phase = new Float32Array(count);

    // Star color palette (spectral types)
    const STAR_COLORS = [
      new THREE.Color(1.0, 1.0, 1.0),       // White (A-type)
      new THREE.Color(0.8, 0.85, 1.0),      // Blue-white (B-type)
      new THREE.Color(1.0, 0.95, 0.8),      // Yellow-white (F-type)
      new THREE.Color(1.0, 0.85, 0.6),      // Orange (K-type)
      new THREE.Color(0.7, 0.8, 1.0),       // Cool blue (O-type)
      new THREE.Color(1.0, 0.92, 0.85),     // Warm white (G-type / solar)
    ];

    // --- Faint random field: the tail of the same magnitude curve ---
    // The field is the faint end (mag MAG_MIN..MAG_MAX) of the SAME
    // magnitude→size curve the catalogue stars use, so the two populations sit
    // on one curve. Brightness is the exception: it is a CONSTANT
    // (STAR_FIELD_BRIGHT), not the curve — pow(10, -0.4*(mag-1)) yields
    // 0.044..0.004 across the field's range, far below any floor that would
    // keep it visible, so the curve cannot carry brightness information here.
    // Size (via the 1.2 px floor) and aAlpha carry the magnitude instead — the
    // same division of labour the catalogue stars use. The constant MUST stay
    // strictly below the catalogue soft-knee asymptote (STAR_MAG_BRIGHT_MIN ×
    // STAR_MAG_BRIGHT_FLOOR_SOFT = 0.3825, the faintest catalogue star's peak)
    // or a field star ties the named stars in peak luminance and breaks
    // Stage 1's hierarchy. The magnitude sample and size/alpha map are shared
    // helpers from starCatalog.js (single source of truth with the test).
    const FMN = Constants.STAR_FIELD_MAG_MIN;
    const FMX = Constants.STAR_FIELD_MAG_MAX;
    const brightMin = Constants.STAR_MAG_BRIGHT_MIN;
    const brightMax = Constants.STAR_MAG_BRIGHT_MAX;
    const brightSoft = Constants.STAR_MAG_BRIGHT_FLOOR_SOFT;
    const fieldBright = Constants.STAR_FIELD_BRIGHT;
    const sizeBase = Constants.STAR_MAG_SIZE_BASE;
    const sizeSlope = Constants.STAR_MAG_SIZE_SLOPE;
    const FIELD_CURVE = {
      base: sizeBase,
      slope: sizeSlope,
      floor: Constants.STAR_FIELD_SIZE_FLOOR,
      alphaMin: Constants.STAR_FIELD_ALPHA_MIN,
    };

    for (let i = 0; i < count; i++) {
      // Random point on a sphere using spherical coordinates
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Magnitude — exponential counts toward the faint end (log N ∝ 0.6·m).
      const mag = sampleFieldMagnitude(Math.random(), FMN, FMX);

      // Star color — weighted toward white/blue-white
      const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
      const color = STAR_COLORS[colorIndex];

      // Brightness is constant across the field (see header comment).
      colors[i * 3] = color.r * fieldBright;
      colors[i * 3 + 1] = color.g * fieldBright;
      colors[i * 3 + 2] = color.b * fieldBright;

      // Size on the same curve, floored at 1.2 px; alpha carries the faintness
      // below the floor. This cures sub-pixel crawl — no 0.5 px specks at full
      // alpha shimmering as they cross texel centres.
      const { size, alpha } = fieldSizeAlpha(mag, FMX, FIELD_CURVE);
      sizes[i] = size;
      alphas[i] = alpha;

      twinkle[i] = 0.0;
      phase[i] = Math.random() * Math.PI * 2;
    }

    // Named bright stars at the constellation vertices — the 49 catalogue
    // stars, written into indices 0..48 of the SAME buffers (same Points, zero
    // new draw calls). Position, size, brightness and colour all read from
    // starCatalog.js, so a star and its constellation line share one source of
    // truth and can never desync. Size carries the magnitude range (stars are
    // capped at 2.0 to stay under the bloom threshold, so brightness alone
    // cannot separate mag 0.1 from mag 3.5 under ACES); brightness carries the
    // truth. Both are monotone in magnitude. twinkle = 0 — these are real sky
    // and do not shimmer (Stage 5 repurposes aTwinkle; the attribute and shader
    // path stay in place).
    //
    // Colour-space: the spectral swatches are display-referred hex, so use
    // `new THREE.Color(0x…)` (applies sRGB→linear under three r155+ colour
    // management), NOT the raw-linear `new THREE.Color(r,g,b)` the random
    // palette above uses. Every swatch has one channel at 0xff, so the max
    // linear channel is 1.0 and no renormalization is needed; peak fragment
    // value is then 1.0 × 2.0 × uOpacity 0.95 = 1.9, safely under the 2.5
    // bloom threshold.
    const SPECTRAL_COLORS = {
      OB: new THREE.Color(0xaabfff), // Rigel, Mimosa, Acrux
      A:  new THREE.Color(0xcad7ff), // Deneb, Castor, Denebola
      F:  new THREE.Color(0xf8f7ff), // Caph, Sadr
      G:  new THREE.Color(0xfff4e8), // Epsilon Leo, Mebsuta
      K:  new THREE.Color(0xffd2a1), // Pollux, Dubhe, Albireo
      M:  new THREE.Color(0xffb46b), // Betelgeuse, Antares, Gacrux
    };
    const spectralColorFor = (spec) => {
      const c = spec.charAt(0);
      return (c === 'O' || c === 'B') ? SPECTRAL_COLORS.OB : SPECTRAL_COLORS[c];
    };

    // sizeBase/sizeSlope/brightMin/brightMax are shared with the field loop
    // above; only the catalogue-specific floor is needed here.
    const sizeMin = Constants.STAR_MAG_SIZE_MIN;

    // Buffer index = position in the flat traversal (figures in array order,
    // stars in array order) → 0..48. The test asserts the flat count is 49.
    let catalogIndex = 0;
    for (const fig of CONSTELLATION_FIGURES) {
      for (const name of fig.stars) {
        const star = BRIGHT_STARS[name];
        const i = catalogIndex++;
        const p = raDec2xyz(star.ra, star.dec, radius);
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;

        sizes[i] = Math.max(sizeMin, Math.min(sizeBase, sizeBase - sizeSlope * star.mag));
        // One curve for the whole sky: skyBrightness adds the soft ceiling to
        // the star curve, so Rigel (raw 2.23) reads 2.019 instead of a hard-
        // clamped 2.0 — still bloom-safe (2.019 × uOpacity 0.95 = 1.92 < 2.5),
        // and the planets share the exact same function (bodyCatalog).
        const brightness = skyBrightness(star.mag, brightMin, brightMax, brightSoft);
        const c = spectralColorFor(star.spec);
        colors[i * 3] = c.r * brightness;
        colors[i * 3 + 1] = c.g * brightness;
        colors[i * 3 + 2] = c.b * brightness;
        alphas[i] = 1.0;   // catalogue stars never fade below the floor

        twinkle[i] = 0.0;
        phase[i] = 0.0;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    // ShaderMaterial — honors the per-star `size` attribute (PointsMaterial
    // could not), draws round soft-edged sprites via gl_PointCoord instead of
    // hard 1.5 px squares, and keeps the twinkle shader path in place (dormant
    // — every aTwinkle is 0 until Stage 5 repurposes it). Keeps
    // vertex colors + additive blending + depthWrite:false like before.
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: (typeof window !== 'undefined' && window.devicePixelRatio) || 1 },
        uSizeScale: { value: 1.5 },   // matches the old PointsMaterial base size
        uOpacity: { value: 0.95 },
      },
      // NOTE: no `vertexColors: true` — raw ShaderMaterial would then inject its
      // own `attribute vec3 color` and collide with the manual declaration
      // below. We declare and consume `color` ourselves.
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 color;
        attribute float size;
        attribute float aAlpha;
        attribute float aTwinkle;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uSizeScale;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          // Twinkle: gentle sine shimmer, only where aTwinkle > 0. Modulates
          // both point size and a brightness varying used in the fragment.
          float tw = 1.0 + aTwinkle * sin(uTime * 2.5 + aPhase);
          vBright = tw;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // sizeAttenuation:false — constant screen size, scaled for retina.
          gl_PointSize = size * uSizeScale * uPixelRatio * tw;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlpha;
        void main() {
          // Round soft-edged sprite: radial falloff from the point center.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;              // 0 at center → 1 at edge
          float alpha = smoothstep(1.0, 0.0, r);  // soft round disc
          alpha *= alpha;                          // tighten core, soften halo
          // aAlpha carries faintness for field stars pinned at the size floor.
          gl_FragColor = vec4(vColor * vBright, alpha * uOpacity * vAlpha);
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'Starfield';
    points.frustumCulled = false; // Always render — surrounds the scene
    this._starMaterial = material;

    return points;
  }

  /**
   * Build a faint procedural Milky Way band — ~3500 clustered stars along a
   * tilted great circle. No texture: stars are scattered in a band-local frame
   * (a thin ribbon around the equator of a rotated basis) then rotated into
   * world space. Sizes 0.4–0.9, dim additive so it reads as a soft glow rather
   * than discrete points. Reuses the same star ShaderMaterial (via a clone with
   * a lower opacity + no twinkle) for a single extra draw call.
   * @private
   */
  _createMilkyWay() {
    const count = 3500;
    const radius = Constants.STAR_SPHERE_RADIUS * 0.985; // just inside the star shell
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // aAlpha all 1 — the band's faintness is carried by its own dim colors and
    // lower uOpacity, not the field's magnitude→alpha floor. The shared shader
    // requires the attribute to be present.
    const alphas = new Float32Array(count).fill(1.0);
    const twinkle = new Float32Array(count); // all 0 (band doesn't twinkle)
    const phase = new Float32Array(count);

    // Band basis: a great circle tilted ~28° so it cuts diagonally across the
    // sky rather than lying on the ecliptic. u,v span the band plane; w is the
    // band normal (stars cluster near the u–v plane, i.e. small |w·pos|).
    const tilt = 0.49; // ~28°
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    // rotated basis (rotation about the X axis)
    const uAxis = new THREE.Vector3(1, 0, 0);
    const vAxis = new THREE.Vector3(0, ct, st);
    const wAxis = new THREE.Vector3(0, -st, ct);

    // Milky-Way palette — faint warm-white with a few dusty blue.
    const c0 = new THREE.Color(0.85, 0.86, 0.95);
    const c1 = new THREE.Color(0.95, 0.92, 0.85);

    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // Angle around the band + a gaussian-ish spread across its width.
      const ang = Math.random() * Math.PI * 2;
      // Sum of two randoms ≈ triangular → clusters toward band center.
      const spread = (Math.random() + Math.random() - 1.0) * 0.22; // half-width ~0.22 rad
      // Longitudinal clumping: bias density with a couple of low-freq lobes so
      // the band has brighter "clouds" like the real galactic plane.
      const clump = 0.6 + 0.4 * Math.abs(Math.sin(ang * 1.5 + 0.7));
      const cosS = Math.cos(spread), sinS = Math.sin(spread);
      // Point on the tilted great circle, lifted off-plane by `spread`.
      tmp.copy(uAxis).multiplyScalar(Math.cos(ang) * cosS)
        .addScaledVector(vAxis, Math.sin(ang) * cosS)
        .addScaledVector(wAxis, sinS)
        .normalize().multiplyScalar(radius);
      positions[i * 3] = tmp.x;
      positions[i * 3 + 1] = tmp.y;
      positions[i * 3 + 2] = tmp.z;

      const col = Math.random() < 0.8 ? c0 : c1;
      const b = (0.28 + Math.random() * 0.32) * clump;
      colors[i * 3] = col.r * b;
      colors[i * 3 + 1] = col.g * b;
      colors[i * 3 + 2] = col.b * b;

      sizes[i] = 0.4 + Math.random() * 0.5; // 0.4–0.9
      twinkle[i] = 0.0;
      phase[i] = 0.0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    // Same shader as the main stars but lower overall opacity for a haze read.
    const material = this._starMaterial.clone();
    material.uniforms.uOpacity.value = 0.55;
    material.uniforms.uSizeScale.value = 1.5;

    const points = new THREE.Points(geometry, material);
    points.name = 'MilkyWay';
    points.frustumCulled = false;
    this._milkyWay = points;
    this._milkyWayMaterial = material;
    this.group.add(points);
  }

  /**
   * Initialize the shooting-star system: a single reusable 2-vertex additive
   * line (LineSegments) that stays hidden until a meteor fires. One meteor
   * every 60–120 s, streaking for ~0.35 s across a random arc of the sky.
   * Cheap: one line, no per-frame allocation.
   * @private
   */
  _initShootingStar() {
    const geom = new THREE.BufferGeometry();
    // 2 vertices (head, tail); positions updated per active frame.
    this._meteorPos = new Float32Array(6);
    geom.setAttribute('position', new THREE.BufferAttribute(this._meteorPos, 3));
    // Per-vertex color so the tail fades to black (streak look).
    this._meteorCol = new Float32Array([1, 1, 1, 0, 0, 0]);
    geom.setAttribute('color', new THREE.BufferAttribute(this._meteorCol, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      // B1: depthTest ON (matches the star/Milky Way materials). The meteor
      // lives on the star shell (r≈392); with depthTest:false a far-side meteor
      // drew OVER the opaque Earth (only ~0.6 units away, writes depth) — a
      // white streak across the day disc. depthTest lets the Earth occlude it.
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this._meteor = new THREE.LineSegments(geom, mat);
    this._meteor.name = 'ShootingStar';
    this._meteor.frustumCulled = false;
    this._meteor.visible = false;
    this._meteorMat = mat;
    this.group.add(this._meteor);

    this._meteorTimer = 8 + Math.random() * 20; // first one within ~8–28 s
    this._meteorActive = false;
    this._meteorElapsed = 0;
    this._meteorDur = 0.35;
    this._meteorStart = new THREE.Vector3();
    this._meteorEnd = new THREE.Vector3();
  }

  /**
   * Advance the shooting-star scheduler + active streak.
   * @param {number} dt — seconds
   * @private
   */
  _updateShootingStar(dt) {
    if (!this._meteor) return;
    if (this._meteorActive) {
      this._meteorElapsed += dt;
      const t = this._meteorElapsed / this._meteorDur;
      if (t >= 1) {
        this._meteorActive = false;
        this._meteor.visible = false;
        this._meteorMat.opacity = 0;
        this._meteorTimer = 60 + Math.random() * 60; // next in 60–120 s
        return;
      }
      // Head advances along the arc; tail trails behind by a fixed fraction.
      const head = Math.min(1, t * 1.15);
      const tail = Math.max(0, head - 0.12);
      const hv = this._tmpMeteorA.copy(this._meteorStart).lerp(this._meteorEnd, head);
      const tv = this._tmpMeteorB.copy(this._meteorStart).lerp(this._meteorEnd, tail);
      this._meteorPos[0] = hv.x; this._meteorPos[1] = hv.y; this._meteorPos[2] = hv.z;
      this._meteorPos[3] = tv.x; this._meteorPos[4] = tv.y; this._meteorPos[5] = tv.z;
      this._meteor.geometry.attributes.position.needsUpdate = true;
      // Fade in fast, out slow (ease the whole streak's opacity by a sine).
      this._meteorMat.opacity = Math.sin(t * Math.PI) * 0.9;
      return;
    }
    this._meteorTimer -= dt;
    if (this._meteorTimer <= 0) this._fireShootingStar();
  }

  /** Launch a shooting star along a random short arc. @private */
  _fireShootingStar() {
    const radius = Constants.STAR_SPHERE_RADIUS * 0.98;
    // Random start direction on the sphere.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this._meteorStart.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    // End point: a short random offset direction, re-projected to the shell.
    const off = this._tmpMeteorA.set(
      (Math.random() - 0.5),
      (Math.random() - 0.5),
      (Math.random() - 0.5)
    ).normalize().multiplyScalar(radius * 0.18);
    this._meteorEnd.copy(this._meteorStart).add(off).normalize().multiplyScalar(radius);
    this._meteorActive = true;
    this._meteorElapsed = 0;
    this._meteor.visible = true;
  }

  /**
   * Build constellation line outlines and planetarium-style name labels.
   * Lines and labels are added to the star group so they co-rotate.
   * @private
   */
  _createConstellations() {
    const radius = Constants.STAR_SPHERE_RADIUS;
    // Hotkey revamp 2026-06-14: collect constellation line + label objects so
    // the 6 key ("Constellation names" toggle) can show/hide them without
    // affecting the star field itself.
    this._constellationObjects = this._constellationObjects || [];
    // Label sprites also tracked on their own: the lines get their limb fade
    // in-shader, the sprites get the CPU twin in update().
    this._constellationLabels = this._constellationLabels || [];
    // Scratch vectors for _limbFadeFactor — allocated once, never per frame.
    this._limbScratchA = this._limbScratchA || new THREE.Vector3();
    this._limbScratchB = this._limbScratchB || new THREE.Vector3();
    this._limbScratchC = this._limbScratchC || new THREE.Vector3();

    // Shared Line2 material — screenspace-width lines that stay visible at any distance.
    // LineMaterial renders sub-pixel-to-few-pixel lines via geometry shaders,
    // bypassing the WebGL 1px lineWidth hardware clamp that made
    // LineBasicMaterial invisible.
    //
    // Styling lives in Constants.CONSTELLATION_* so it can be tuned in one
    // place. NOTE: do NOT enable alphaToCoverage here — the renderer runs
    // antialias:false behind an EffectComposer (SceneManager), so there is no
    // MSAA for it to resolve against; thin lines rely on the SMAA/FXAA pass.
    this._constellationLineMaterial = new LineMaterial({
      color: Constants.CONSTELLATION_LINE_COLOR,
      transparent: true,
      opacity: Constants.CONSTELLATION_LINE_OPACITY,
      linewidth: Constants.CONSTELLATION_LINE_WIDTH,
      depthWrite: false,
      depthTest: true,           // occlude behind Earth mesh and celestial body depth masks
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });
    this._installLimbFade(this._constellationLineMaterial);

    // Trim each line segment back from its endpoints so it stops short of the
    // star core instead of ending on top of it — a normal-blended line over an
    // additive star dims the core. The trim is the larger of a fixed gap
    // (Constants.CONSTELLATION_LINE_GAP, ≈6 px) and 2% of the segment length,
    // capped at 25% of the length so the short Shaula–Lesath arm (~2.9 units)
    // is not inverted.
    const GAP = Constants.CONSTELLATION_LINE_GAP;
    const _trimDir = new THREE.Vector3();

    for (const cst of CONSTELLATION_FIGURES) {
      // Resolve the figure's star names → 3D vectors on the sphere, reading the
      // SAME catalogue the rendered stars use so a line can never miss its star.
      const stars3d = cst.stars.map((n) => raDec2xyz(BRIGHT_STARS[n].ra, BRIGHT_STARS[n].dec, radius));

      // Build line segment pairs (flat array for LineSegmentsGeometry), with
      // both ends of every segment trimmed back toward the interior.
      const verts = [];
      for (const [a, b] of cst.lines) {
        const pa = stars3d[a];
        const pb = stars3d[b];
        const L = pa.distanceTo(pb);
        const trim = Math.min(Math.max(0.02 * L, GAP), 0.25 * L);
        // pa + (pb - pa) * (trim / L)  and  pb + (pa - pb) * (trim / L)
        _trimDir.subVectors(pb, pa);
        const t0 = trim / L;
        const ax = pa.x + _trimDir.x * t0;
        const ay = pa.y + _trimDir.y * t0;
        const az = pa.z + _trimDir.z * t0;
        const bx = pb.x - _trimDir.x * t0;
        const by = pb.y - _trimDir.y * t0;
        const bz = pb.z - _trimDir.z * t0;
        verts.push(ax, ay, az);
        verts.push(bx, by, bz);
      }

      const lineGeom = new LineSegmentsGeometry();
      lineGeom.setPositions(verts);
      const lineObj = new LineSegments2(lineGeom, this._constellationLineMaterial);
      lineObj.computeLineDistances();
      lineObj.frustumCulled = false;
      this.group.add(lineObj);
      this._constellationObjects.push(lineObj);

      // Compute centroid for label placement, re-project onto sphere
      const center = new THREE.Vector3();
      for (const p of stars3d) center.add(p);
      center.divideScalar(stars3d.length).normalize().multiplyScalar(radius);

      // Planetarium-style text label sprite — subtle, matches original aesthetic
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createConstellationLabel(cst.name),
        transparent: true,
        opacity: Constants.CONSTELLATION_LABEL_OPACITY,
        depthWrite: false,
        depthTest: true,         // occlude behind Earth mesh and celestial body depth masks
      }));
      // Nudge the label sideways (tangent to the star sphere) so the glyphs sit
      // beside the constellation lines instead of on top of them — e.g. Orion's
      // "i" previously landed directly over the belt line.
      const tangent = new THREE.Vector3()
        .crossVectors(center, new THREE.Vector3(0, 1, 0));
      // Fall back to world X if the centroid is near the poles (degenerate cross).
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      tangent.normalize().multiplyScalar(-30); // shift toward screen-left
      label.position.copy(center).add(tangent);
      label.scale.set(50, 12, 1);
      label.frustumCulled = false;
      this.group.add(label);
      this._constellationObjects.push(label);
      // Also tracked separately so update() can apply the same limb fade the
      // lines get in-shader (8 sprites — negligible per-frame cost).
      this._constellationLabels.push(label);
    }
  }

  /**
   * Inject a soft Earth-limb fade into the constellation LineMaterial.
   *
   * WHY: with depthTest:true a constellation edge crossing the Earth limb is
   * chopped dead at the silhouette, leaving a straight saturated line with a
   * hard endpoint apparently ON the surface — which reads unmistakably as a
   * rocket launch plume. Fading the lines out BEFORE they reach the limb glow
   * removes that cue entirely (the z-test then only ever hides already-invisible
   * pixels).
   *
   * HOW: per-fragment angular fade. Earth sits at the world origin (Earth.js
   * never moves its group; the floating origin is DebrisField-local), so
   * Earth's view-space centre is just viewMatrix[3].xyz — no per-frame uniform
   * plumbing needed. A varying carries each fragment's view-space position;
   * because varyings interpolate perspective-correctly along the segment, every
   * fragment gets the true 3D point beneath it without subdividing the geometry.
   * Chord-vs-great-circle error is a couple of degrees and irrelevant to a soft
   * ramp.
   *
   * The fade reference radius is ATMOSPHERE_RADIUS (not EARTH_RADIUS) so the
   * ramp completes outside the visible airglow band — the atmosphere shell is
   * depthWrite:false, so lines would otherwise punch straight through it.
   * @param {LineMaterial} material
   * @private
   */
  _installLimbFade(material) {
    const uniforms = {
      uLimbRadius:    { value: Constants.ATMOSPHERE_RADIUS },
      uLimbFadeScale: { value: Constants.CONSTELLATION_LIMB_FADE_SCALE },
      uLimbFadeMin:   { value: Constants.CONSTELLATION_LIMB_FADE_MIN },
      uLimbFadeMax:   { value: Constants.CONSTELLATION_LIMB_FADE_MAX },
    };

    // Anchors below are tied to vendored three r184
    // (vendor/three/examples/jsm/lines/LineMaterial.js). A silently-missed
    // replace would drop the fade with no error, so each one is asserted.
    const VERT_DECL_ANCHOR = 'uniform float linewidth;\n\t\tuniform vec2 resolution;';
    const VERT_BODY_ANCHOR = 'vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );';
    const FRAG_DECL_ANCHOR = 'uniform vec3 diffuse;';
    const FRAG_BODY_ANCHOR = 'gl_FragColor = vec4( diffuseColor.rgb, alpha );';

    const warn = (what) => {
      if (this._limbFadeWarned) return;
      this._limbFadeWarned = true;
      console.warn(
        `[Starfield] Constellation limb-fade injection failed (${what} anchor not ` +
        'found in LineMaterial). Lines will hard-clip at the Earth limb. The ' +
        'vendored three.js LineMaterial shader has probably changed.'
      );
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      const vertDecl = /* glsl */`
        uniform float linewidth;
        uniform vec2 resolution;
        varying vec3 vLimbViewPos;
        varying vec3 vLimbEarthView;`;

      // position.y < 0.5 is the same start/end selector the stock shader
      // already uses for instanceColorStart/End. Use the raw endpoint (not the
      // screen-space-expanded quad corner) so the fade varies ALONG the line
      // rather than across its width.
      const vertBody = /* glsl */`${VERT_BODY_ANCHOR}
			vec4 limbEnd = modelViewMatrix * vec4( instanceEnd, 1.0 );
			vLimbViewPos = ( position.y < 0.5 ) ? start.xyz : limbEnd.xyz;
			vLimbEarthView = viewMatrix[ 3 ].xyz;`;

      const fragDecl = /* glsl */`
        uniform vec3 diffuse;
        uniform float uLimbRadius;
        uniform float uLimbFadeScale;
        uniform float uLimbFadeMin;
        uniform float uLimbFadeMax;
        varying vec3 vLimbViewPos;
        varying vec3 vLimbEarthView;`;

      // Injected after the endcap discards so it modulates the final alpha.
      const fragBody = /* glsl */`
			float limbDist  = length( vLimbEarthView );
			float sinLimb   = clamp( uLimbRadius / max( limbDist, uLimbRadius + 1e-3 ), 0.0, 1.0 );
			float thetaLimb = asin( sinLimb );
			float theta     = acos( clamp( dot( normalize( vLimbViewPos ), normalize( vLimbEarthView ) ), -1.0, 1.0 ) );
			float limbBand  = clamp( uLimbFadeScale * thetaLimb, uLimbFadeMin, uLimbFadeMax );
			alpha *= smoothstep( thetaLimb, thetaLimb + limbBand, theta );
			${FRAG_BODY_ANCHOR}`;

      if (shader.vertexShader.includes(VERT_DECL_ANCHOR)) {
        shader.vertexShader = shader.vertexShader.replace(VERT_DECL_ANCHOR, vertDecl);
      } else warn('vertex declaration');

      if (shader.vertexShader.includes(VERT_BODY_ANCHOR)) {
        shader.vertexShader = shader.vertexShader.replace(VERT_BODY_ANCHOR, vertBody);
      } else warn('vertex body');

      if (shader.fragmentShader.includes(FRAG_DECL_ANCHOR)) {
        shader.fragmentShader = shader.fragmentShader.replace(FRAG_DECL_ANCHOR, fragDecl);
      } else warn('fragment declaration');

      if (shader.fragmentShader.includes(FRAG_BODY_ANCHOR)) {
        shader.fragmentShader = shader.fragmentShader.replace(FRAG_BODY_ANCHOR, fragBody);
      } else warn('fragment body');
    };

    // Keep the injected variant from sharing a compiled program with a stock
    // LineMaterial (ShaderMaterial cache keys ignore onBeforeCompile).
    material.customProgramCacheKey = () => 'constellationLimbFade';
  }

  /**
   * CPU-side twin of the in-shader limb fade, for the name-label sprites.
   * Returns the 0..1 ramp for a world-space point as seen from `camera`.
   * @param {THREE.Vector3} worldPos
   * @param {THREE.Camera} camera
   * @returns {number}
   * @private
   */
  _limbFadeFactor(worldPos, camera) {
    // Earth is at the world origin, so camera.position doubles as the
    // camera→Earth-centre vector (negated).
    const limbRadius = Constants.ATMOSPHERE_RADIUS;
    const camDist = camera.position.length();
    if (!(camDist > limbRadius)) return 1; // inside the shell: no meaningful limb
    const thetaLimb = Math.asin(Math.min(1, limbRadius / camDist));

    const toPoint = this._limbScratchA.copy(worldPos).sub(camera.position);
    const toEarth = this._limbScratchB.copy(camera.position).negate();
    const lp = toPoint.length();
    if (lp < 1e-6) return 1;
    const cos = toPoint.dot(toEarth) / (lp * camDist);
    const theta = Math.acos(Math.max(-1, Math.min(1, cos)));

    const band = Math.min(
      Constants.CONSTELLATION_LIMB_FADE_MAX,
      Math.max(Constants.CONSTELLATION_LIMB_FADE_MIN,
        Constants.CONSTELLATION_LIMB_FADE_SCALE * thetaLimb)
    );
    // smoothstep(thetaLimb, thetaLimb + band, theta)
    const t = Math.max(0, Math.min(1, (theta - thetaLimb) / band));
    return t * t * (3 - 2 * t);
  }

  /**
   * Show/hide the constellation outlines + name labels (hotkey revamp
   * 2026-06-14 — the 6 key). Leaves the star field untouched.
   * @param {boolean} visible
   */
  setConstellationsVisible(visible) {
    this._constellationsVisible = !!visible;
    for (const obj of (this._constellationObjects || [])) {
      obj.visible = this._constellationsVisible;
    }
  }

  /** Toggle constellation outlines + labels (6 key).
   *  @returns {boolean} the NEW visibility state (for reactive comms feedback). */
  toggleConstellations() {
    this.setConstellationsVisible(!(this._constellationsVisible ?? true));
    return this._constellationsVisible;
  }

  /** @returns {boolean} whether constellation outlines + labels are visible.
   *  The effective default is visible (true) until the player first toggles. */
  isConstellationsVisible() {
    return this._constellationsVisible ?? true;
  }

  /**
   * Per-frame update: advance twinkle time, keep pixel-ratio + Line2 material
   * resolution in sync with the viewport.
   * @param {number} _dt — delta time (seconds)
   * @param {number} [pixelRatio] — the RENDERER's capped pixel ratio (B2). Falls
   *   back to window.devicePixelRatio when undefined so the class stays usable
   *   standalone (e.g. in tests / menu preview).
   * @param {THREE.Camera} [camera] — active camera, used to apply the Earth-limb
   *   fade to the constellation name sprites (the lines do it in-shader). When
   *   omitted the sprites keep their static opacity — same defensive style as
   *   pixelRatio above, so the class stays usable standalone.
   */
  update(_dt, pixelRatio, camera) {
    const dt = (typeof _dt === 'number' && isFinite(_dt)) ? _dt : 0;
    // B3: wrap the accumulator to keep float32 precision. 251.327 = 100 twinkle
    // periods (2π / 2.5 ≈ 2.51327 s); wrapping on a whole multiple keeps
    // sin(uTime*2.5 + phase) continuous across the wrap so twinkle never jumps.
    this._time = (this._time + dt) % 251.327;

    // Drive the star time uniform (the twinkle path is dormant — every
    // aTwinkle is 0 — until Stage 5 repurposes it).
    if (this._starMaterial) {
      this._starMaterial.uniforms.uTime.value = this._time;
      // Keep pixelRatio current for correct on-screen star size after a
      // window move between displays of different density. B2: prefer the
      // renderer's capped ratio passed in; fall back to devicePixelRatio.
      const pr = (typeof pixelRatio === 'number' && isFinite(pixelRatio) && pixelRatio > 0)
        ? pixelRatio
        : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      this._starMaterial.uniforms.uPixelRatio.value = pr;
      if (this._milkyWayMaterial) this._milkyWayMaterial.uniforms.uPixelRatio.value = pr;
    }

    // Shooting-star scheduler + active streak.
    this._updateShootingStar(dt);

    // Line2 LineMaterial needs current viewport resolution for correct screenspace width
    if (this._constellationLineMaterial) {
      this._constellationLineMaterial.resolution.set(
        window.innerWidth, window.innerHeight
      );
    }

    // Match the in-shader limb fade on the name sprites so a label does not
    // hang crisply over the airglow band after its lines have dissolved.
    // Opacity only — `visible` stays owned by setConstellationsVisible().
    if (camera && this._constellationLabels && this._constellationLabels.length) {
      const base = Constants.CONSTELLATION_LABEL_OPACITY;
      for (const label of this._constellationLabels) {
        // The star group is never transformed today, but resolve world space
        // anyway so a future sky rotation cannot silently desync the fade.
        const worldPos = label.getWorldPosition(this._limbScratchC);
        label.material.opacity = base * this._limbFadeFactor(worldPos, camera);
      }
    }
  }
}

export default Starfield;
