/**
 * Starfield.js — 10,000 background stars as Points geometry
 * with 8 major constellation outlines and planetarium-style labels
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
  ctx.fillStyle = '#cce0ff';
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

    this.mesh = this._create();
    this.group.add(this.mesh);
    this._createConstellations();

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
      // Range 0.5 to 2.0
      const sizeRoll = Math.random();
      sizes[i] = 0.5 + Math.pow(sizeRoll, 3) * 1.5;
    }

    // Add a few bright "prominent" stars
    const prominentCount = Math.min(50, count);
    for (let i = 0; i < prominentCount; i++) {
      sizes[i] = 1.5 + Math.random() * 1.0;
      const brightness = 0.9 + Math.random() * 0.1;
      colors[i * 3] *= brightness / colors[i * 3] || 1;
      colors[i * 3 + 1] *= brightness / colors[i * 3 + 1] || 1;
      colors[i * 3 + 2] *= brightness / colors[i * 3 + 2] || 1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      vertexColors: true,
      size: 1.5,
      sizeAttenuation: false,  // Stars stay same size regardless of distance
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'Starfield';
    points.frustumCulled = false; // Always render — surrounds the scene

    return points;
  }

  /**
   * Build constellation line outlines and planetarium-style name labels.
   * Lines and labels are added to the star group so they co-rotate.
   * @private
   */
  _createConstellations() {
    const radius = Constants.STAR_SPHERE_RADIUS;

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

      // Compute centroid for label placement, re-project onto sphere
      const center = new THREE.Vector3();
      for (const p of stars3d) center.add(p);
      center.divideScalar(stars3d.length).normalize().multiplyScalar(radius);

      // Planetarium-style text label sprite — subtle, matches original aesthetic
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createConstellationLabel(cst.name),
        transparent: true,
        opacity: 0.9,            // brighter labels (§18 Fix 3 — was 0.7)
        depthWrite: false,
        depthTest: true,         // occlude behind Earth mesh and celestial body depth masks
      }));
      label.position.copy(center);
      label.scale.set(50, 12, 1);
      label.frustumCulled = false;
      this.group.add(label);
    }
  }

  /**
   * Per-frame update: keep Line2 material resolution in sync with viewport.
   * @param {number} _dt — delta time (unused for stars)
   */
  update(_dt) {
    // Line2 LineMaterial needs current viewport resolution for correct screenspace width
    if (this._constellationLineMaterial) {
      this._constellationLineMaterial.resolution.set(
        window.innerWidth, window.innerHeight
      );
    }
  }
}

export default Starfield;
