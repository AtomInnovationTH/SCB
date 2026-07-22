/**
 * Starfield.js — 10,000 background stars (size-honoring ShaderMaterial with
 * round soft sprites + prominent-star twinkle), a faint procedural Milky Way
 * band, an occasional shooting star, plus 8 major constellation outlines and
 * planetarium-style labels
 * @module scene/Starfield
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// RA/Dec → Cartesian conversion
// ============================================================================

/**
 * Convert Right Ascension (hours) and Declination (degrees) to 3D cartesian
 * coordinates on the star sphere.
 * @param {number} raHours — RA in hours (0–24)
 * @param {number} decDeg  — Dec in degrees (-90 to +90)
 * @param {number} radius  — sphere radius
 * @returns {THREE.Vector3}
 */
function raDec2xyz(raHours, decDeg, radius) {
  const ra = raHours * (Math.PI / 12);   // hours → radians
  const dec = decDeg * (Math.PI / 180);  // degrees → radians
  return new THREE.Vector3(
    radius * Math.cos(dec) * Math.cos(ra),
    radius * Math.sin(dec),
    -radius * Math.cos(dec) * Math.sin(ra)
  );
}

// ============================================================================
// CONSTELLATION DATA — 8 major stick-figure patterns
// stars: [[RA_hours, Dec_degrees], ...], lines: [[idx_a, idx_b], ...]
// Approximate positions for brightest pattern-forming stars.
// ============================================================================
const CONSTELLATIONS = [
  { // Orion — distinctive hourglass with belt
    name: 'ORION',
    stars: [
      [5.92, 7.41],   // 0 Betelgeuse
      [5.42, 6.35],   // 1 Bellatrix
      [5.53, -0.30],  // 2 Mintaka (belt)
      [5.60, -1.20],  // 3 Alnilam (belt)
      [5.68, -1.94],  // 4 Alnitak (belt)
      [5.80, -9.67],  // 5 Saiph
      [5.24, -8.20],  // 6 Rigel
    ],
    lines: [[0,1],[2,3],[3,4],[0,4],[1,2],[5,4],[6,2]],
  },
  { // Ursa Major (Big Dipper) — 7-star dipper with bowl closed
    name: 'URSA MAJOR',
    stars: [
      [13.79, 49.31],  // 0 Alkaid (handle tip)
      [13.40, 54.93],  // 1 Mizar
      [12.90, 55.96],  // 2 Alioth
      [12.26, 57.03],  // 3 Megrez (bowl-handle junction)
      [11.90, 53.69],  // 4 Phecda
      [11.03, 56.38],  // 5 Merak
      [11.06, 61.75],  // 6 Dubhe
    ],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,3]],
  },
  { // Cassiopeia — distinctive W shape
    name: 'CASSIOPEIA',
    stars: [
      [0.15, 59.15],   // 0 Caph
      [0.68, 56.54],   // 1 Schedar
      [0.95, 60.72],   // 2 Gamma Cas
      [1.43, 60.24],   // 3 Ruchbah
      [1.91, 63.67],   // 4 Segin
    ],
    lines: [[0,1],[1,2],[2,3],[3,4]],
  },
  { // Scorpius — curved tail with Antares
    name: 'SCORPIUS',
    stars: [
      [16.09, -19.81], // 0 Graffias (head)
      [16.01, -22.62], // 1 Dschubba (head)
      [16.49, -26.43], // 2 Antares
      [16.84, -34.29], // 3 Epsilon Sco
      [16.86, -38.05], // 4 Mu1 Sco
      [17.56, -37.10], // 5 Shaula (tail)
      [17.53, -37.29], // 6 Lesath (tail)
    ],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6]],
  },
  { // Leo — sickle/hook + body
    name: 'LEO',
    stars: [
      [10.14, 11.97],  // 0 Regulus
      [10.12, 16.76],  // 1 Eta Leo
      [10.33, 19.84],  // 2 Algieba (Gamma)
      [10.28, 23.42],  // 3 Zeta Leo
      [9.76, 23.77],   // 4 Epsilon Leo (sickle top)
      [11.24, 20.52],  // 5 Zosma (Delta)
      [11.82, 14.57],  // 6 Denebola (Beta)
      [11.24, 15.43],  // 7 Theta Leo
    ],
    lines: [[4,3],[3,2],[2,1],[1,0],[0,7],[7,5],[5,6]],
  },
  { // Crux (Southern Cross) — 4 stars in cross
    name: 'CRUX',
    stars: [
      [12.44, -63.10], // 0 Acrux (Alpha, bottom)
      [12.79, -59.69], // 1 Mimosa (Beta, left)
      [12.52, -57.11], // 2 Gacrux (Gamma, top)
      [12.25, -58.75], // 3 Delta Cru (right)
    ],
    lines: [[0,2],[1,3]],
  },
  { // Cygnus (Northern Cross) — cross shape
    name: 'CYGNUS',
    stars: [
      [20.69, 45.28],  // 0 Deneb (tail)
      [20.37, 40.26],  // 1 Sadr (center)
      [19.51, 27.96],  // 2 Albireo (head)
      [20.77, 33.97],  // 3 Epsilon Cyg (wing)
      [19.75, 45.13],  // 4 Delta Cyg (wing)
    ],
    lines: [[0,1],[1,2],[4,1],[1,3]],
  },
  { // Gemini — two parallel figures (Castor & Pollux)
    name: 'GEMINI',
    stars: [
      [7.58, 31.89],   // 0 Castor
      [7.76, 28.03],   // 1 Pollux
      [6.63, 16.40],   // 2 Alhena (Gamma)
      [6.38, 22.51],   // 3 Tejat (Mu)
      [6.73, 25.13],   // 4 Mebsuta (Epsilon)
      [6.25, 22.51],   // 5 Propus (Eta)
    ],
    lines: [[0,1],[0,4],[4,3],[3,5],[1,2]],
  },
];

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
    // Twinkle amplitude per star (0 = steady; only the ~50 prominent stars
    // twinkle). Kept as an attribute so the vertex shader can modulate size
    // over time without touching the CPU each frame.
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

      // Star color — weighted toward white/blue-white
      const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
      const color = STAR_COLORS[colorIndex];

      // Vary brightness slightly
      const brightness = 0.6 + Math.random() * 0.4;
      colors[i * 3] = color.r * brightness;
      colors[i * 3 + 1] = color.g * brightness;
      colors[i * 3 + 2] = color.b * brightness;

      // Star sizes: most small, few large (power-law distribution)
      // Range 0.5 to 2.0. Now HONORED by the ShaderMaterial below (the old
      // PointsMaterial ignored the per-vertex `size` and drew every star as a
      // uniform 1.5 px square — Item 3 dead-code fix).
      const sizeRoll = Math.random();
      sizes[i] = 0.5 + Math.pow(sizeRoll, 3) * 1.5;
      twinkle[i] = 0.0;
      phase[i] = Math.random() * Math.PI * 2;
    }

    // Add a few bright "prominent" stars — larger, brighter, and the only ones
    // that twinkle (subtle size/brightness shimmer, so the sky isn't static).
    const prominentCount = Math.min(50, count);
    for (let i = 0; i < prominentCount; i++) {
      sizes[i] = 1.5 + Math.random() * 1.0;
      const brightness = 0.9 + Math.random() * 0.1;
      colors[i * 3] *= brightness / colors[i * 3] || 1;
      colors[i * 3 + 1] *= brightness / colors[i * 3 + 1] || 1;
      colors[i * 3 + 2] *= brightness / colors[i * 3 + 2] || 1;
      twinkle[i] = 0.15 + Math.random() * 0.15;   // 15–30% shimmer
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    // ShaderMaterial — honors the per-star `size` attribute (PointsMaterial
    // could not), draws round soft-edged sprites via gl_PointCoord instead of
    // hard 1.5 px squares, and shimmers the prominent stars over time. Keeps
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
        attribute float aTwinkle;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uSizeScale;
        varying vec3 vColor;
        varying float vBright;
        void main() {
          vColor = color;
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
        void main() {
          // Round soft-edged sprite: radial falloff from the point center.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;              // 0 at center → 1 at edge
          float alpha = smoothstep(1.0, 0.0, r);  // soft round disc
          alpha *= alpha;                          // tighten core, soften halo
          gl_FragColor = vec4(vColor * vBright, alpha * uOpacity);
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

    // Shared Line2 material — screenspace-width lines that stay visible at any distance.
    // LineMaterial renders 2px-wide lines via geometry shaders, bypassing the
    // WebGL 1px lineWidth hardware clamp that made LineBasicMaterial invisible.
    this._constellationLineMaterial = new LineMaterial({
      color: 0x6688cc,          // brighter blue (§18 Fix 3 — was 0x5577bb, crushed by ACES)
      transparent: true,
      opacity: 0.7,             // higher opacity (§18 Fix 3 — was 0.5)
      linewidth: 2.0,           // pixels — slightly thicker for visibility (was 1.5)
      depthWrite: false,
      depthTest: true,           // occlude behind Earth mesh and celestial body depth masks
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    for (const cst of CONSTELLATIONS) {
      // Convert RA/Dec star positions → 3D vectors on the sphere
      const stars3d = cst.stars.map(([ra, dec]) => raDec2xyz(ra, dec, radius));

      // Build line segment pairs (flat array for LineSegmentsGeometry)
      const verts = [];
      for (const [a, b] of cst.lines) {
        verts.push(stars3d[a].x, stars3d[a].y, stars3d[a].z);
        verts.push(stars3d[b].x, stars3d[b].y, stars3d[b].z);
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
        opacity: 0.34,           // dimmed to match quiet planet labels (was 0.9)
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
    }
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
   */
  update(_dt, pixelRatio) {
    const dt = (typeof _dt === 'number' && isFinite(_dt)) ? _dt : 0;
    // B3: wrap the accumulator to keep float32 precision. 251.327 = 100 twinkle
    // periods (2π / 2.5 ≈ 2.51327 s); wrapping on a whole multiple keeps
    // sin(uTime*2.5 + phase) continuous across the wrap so twinkle never jumps.
    this._time = (this._time + dt) % 251.327;

    // Drive the star twinkle shader uniform (prominent stars shimmer).
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
  }
}

export default Starfield;
