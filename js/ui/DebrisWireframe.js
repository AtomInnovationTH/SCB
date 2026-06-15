/**
 * DebrisWireframe.js — FS2-heritage debris wireframe analysis panel
 * Canvas2D overlay rendering a rotating wireframe of the selected debris target
 * with color-coded structural zones and approach recommendations.
 *
 * Pure Canvas2D — no Three.js renderer. Uses simple perspective projection
 * for 3D wireframe visualization on a fixed-position overlay panel.
 *
 * @module ui/DebrisWireframe
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { DebrisTextureAtlas, getUVOffsetForType, getBaseColorForType, getEmissiveForMOID } from './DebrisTextureAtlas.js';
import { FlagDecalSystem, getUVOffsetForCountry, hasFlag } from './FlagDecalSystem.js';
import { dossierSystem, DOSSIER_TIERS, appraiseSalvage } from '../systems/DossierSystem.js';
import { audioSystem } from '../systems/AudioSystem.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PANEL_WIDTH = 280;              // px — match right column & NavSphere width
const PANEL_HEIGHT = 200;             // px — tight: wireframe + essential info text only
const PANEL_MARGIN_RIGHT = 10;        // px from right edge (align with targets panel)
// Fallback anchor: top-right, below the NavSphere (446px = 160 margin + 280
// NavSphere diameter + 6 gap), mirroring the container-mounted slot. Previously
// this floated bottom-right at 140px, which could overlap the bottom-anchored
// warnings strip / comms panel when DebrisWireframe was used standalone.
const PANEL_MARGIN_TOP = 446;         // px from top edge (fallback when no container)
const BG_COLOR = `rgba(0, 10, 25, ${Constants.WIREFRAME_BG_ALPHA})`;
const BORDER_COLOR = 'rgba(0, 255, 136, 0.3)';
const Z_INDEX = 12;

const PERSPECTIVE_D = 3.0;            // perspective distance parameter
const VIEW_SCALE = 280;               // maps 3D units → canvas pixels (fills 280px width better)
const TILT_X = 15 * Math.PI / 180;   // fixed 15° X-axis tilt
const WIRE_CX = PANEL_WIDTH / 2;      // wireframe center X (140)
const WIRE_CY = 72;                   // wireframe center Y (tight for 200px panel)

const MIN_TUMBLE_RATE = 0.1;          // rad/s minimum visual rotation

const DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;
const SEGMENTS = 8;                   // vertices per ring/circle

// ============================================================================
// COLORS
// ============================================================================

/** Zone risk colors (CSS hex) */
const ZONE_COLORS = {
  GREEN:  '#00ff88',
  YELLOW: '#ffcc00',
  RED:    '#ff4444',
};

const HEADER_COLOR = 'rgba(0, 255, 136, 0.7)';
const TYPE_COLOR = '#00ccff';
const INFO_COLOR = '#00ff88';
const DIM_COLOR = 'rgba(0, 255, 136, 0.5)';
const SEPARATOR_COLOR = 'rgba(0, 255, 136, 0.3)';

// ============================================================================
// TYPE DISPLAY LABELS
// ============================================================================

const TYPE_LABELS = {
  rocketBody:    'ROCKET BODY',
  defunctSat:    'DEFUNCT SATELLITE',
  missionDebris: 'MISSION DEBRIS',
  fragment:      'FRAGMENT',
};

// Human-readable material names + a representative swatch colour for the
// inspection readout, so the panel reflects the field's material variety
// (silver hulls / dark composite / gold MLI / blue solar cells) at a glance.
const MATERIAL_LABELS = {
  aluminum:   'Aluminium',
  titanium:   'Titanium',
  composite:  'Composite',
  mli_mylar:  'MLI Foil',
  solar_cell: 'Solar Cell',
};
const MATERIAL_SWATCH = {
  aluminum:   '#c8c8d2',
  titanium:   '#8fa0ad',
  composite:  '#4a4a4a',
  mli_mylar:  '#e8c860',
  solar_cell: '#3a52b0',
};

// ============================================================================
// WIREFRAME SHAPE DATA — built once at module load (except fragment)
// ============================================================================

/**
 * Generate a ring of vertices at given Y-height and radius.
 * @param {number} y - Y coordinate for all ring vertices
 * @param {number} r - ring radius
 * @returns {number[][]} array of [x, y, z] vertices
 */
function makeRing(y, r) {
  const verts = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * TWO_PI;
    verts.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return verts;
}

// ---------------------------------------------------------------------------
// Rocket Body: cylinder + nosecone + nozzle
// Total height normalized ~1.0. Diameter = 0.3 (radius 0.15).
// Y range: -0.65 (nozzle tip) to +0.5 (nosecone tip)
// Zones: Nosecone top 15%, Fuel Tank middle 60%, Engine bottom 25%
// ---------------------------------------------------------------------------
function buildRocketBody() {
  const R = 0.30;
  const tip = [[0, 0.5, 0]];                  // 0: nosecone tip
  const ringTop = makeRing(0.35, R);           // 1–8: nosecone base / fuel-tank top
  const ringMid = makeRing(-0.25, R);          // 9–16: fuel-tank bottom / engine top
  const ringBot = makeRing(-0.50, R);          // 17–24: engine bottom
  const nozzleRing = makeRing(-0.58, R * 1.4); // 25–32: nozzle bell (wider)
  const nozzleTip = [[0, -0.65, 0]];           // 33: nozzle exit

  const vertices = [
    ...tip, ...ringTop, ...ringMid, ...ringBot, ...nozzleRing, ...nozzleTip,
  ];

  // Zone: Nosecone — tip lines + top ring
  const noseconeEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    noseconeEdges.push([0, 1 + i]);                              // tip → ring
    noseconeEdges.push([1 + i, 1 + ((i + 1) % SEGMENTS)]);      // ring loop
  }

  // Zone: Fuel Tank — verticals + bottom ring
  const fuelTankEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    fuelTankEdges.push([1 + i, 9 + i]);                          // verticals
    fuelTankEdges.push([9 + i, 9 + ((i + 1) % SEGMENTS)]);      // bottom ring
  }

  // Zone: Engine — verticals + bottom ring + nozzle bell + converging lines
  const engineEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    engineEdges.push([9 + i, 17 + i]);                            // verticals
    engineEdges.push([17 + i, 17 + ((i + 1) % SEGMENTS)]);       // engine-bottom ring
    engineEdges.push([17 + i, 25 + i]);                            // to nozzle ring
    engineEdges.push([25 + i, 25 + ((i + 1) % SEGMENTS)]);       // nozzle ring
  }
  for (let i = 0; i < SEGMENTS; i += 2) {
    engineEdges.push([25 + i, 33]);                                // converging to nozzle tip
  }

  return {
    vertices,
    zones: [
      { name: 'Nosecone',  edges: noseconeEdges,  massPercent: 15 },
      { name: 'Fuel Tank', edges: fuelTankEdges,   massPercent: 60 },
      { name: 'Engine',    edges: engineEdges,     massPercent: 25 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Defunct Satellite: box bus + 2 solar-panel wings + antenna dish
// ---------------------------------------------------------------------------
function buildDefunctSat() {
  const bx = 0.20, by = 0.15, bz = 0.15;

  // Bus box vertices (0–7)
  const busVerts = [
    [-bx, -by, -bz], [ bx, -by, -bz], [ bx,  by, -bz], [-bx,  by, -bz], // front
    [-bx, -by,  bz], [ bx, -by,  bz], [ bx,  by,  bz], [-bx,  by,  bz], // back
  ];
  const busEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],   // front face
    [4, 5], [5, 6], [6, 7], [7, 4],   // back face
    [0, 4], [1, 5], [2, 6], [3, 7],   // connectors
  ];

  // Solar Panel L — extends left (8–11)
  const py = 0.08;
  const panelLVerts = [
    [-bx,     -py, 0], [-0.60, -py, 0],
    [-0.60,    py, 0], [-bx,    py, 0],
  ];
  const panelLEdges = [
    [8, 9], [9, 10], [10, 11], [11, 8],   // outline
    [8, 10], [9, 11],                       // cross-hatched solar cells
  ];

  // Solar Panel R — extends right (12–15)
  const panelRVerts = [
    [bx,    -py, 0], [0.60, -py, 0],
    [0.60,   py, 0], [bx,    py, 0],
  ];
  const panelREdges = [
    [12, 13], [13, 14], [14, 15], [15, 12],
    [12, 14], [13, 15],
  ];

  // Antenna dish — 6-point circle on top + mast (16–22)
  const antR = 0.10;
  const antY = 0.28;
  const antMast = [[0, by, 0]]; // 16: mast base (top of bus)
  const antRing = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TWO_PI;
    antRing.push([antR * Math.cos(a), antY, antR * Math.sin(a)]);
  }
  // indices 17–22
  const antennaEdges = [];
  for (let i = 0; i < 6; i++) {
    antennaEdges.push([17 + i, 17 + ((i + 1) % 6)]); // dish ring
    antennaEdges.push([16, 17 + i]);                    // spokes from mast
  }

  const vertices = [...busVerts, ...panelLVerts, ...panelRVerts, ...antMast, ...antRing];

  return {
    vertices,
    zones: [
      { name: 'Solar Panel L', edges: panelLEdges,  massPercent: 10 },
      { name: 'Bus',           edges: busEdges,     massPercent: 65 },
      { name: 'Solar Panel R', edges: panelREdges,  massPercent: 10 },
      { name: 'Antenna',       edges: antennaEdges, massPercent: 15 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mission Debris: irregular hexagonal prism + attachment ring
// ---------------------------------------------------------------------------
function buildMissionDebris() {
  const N = 6;
  const R = 0.28;
  const halfH = 0.22;

  // Slight per-vertex radial offsets (deterministic)
  const offsets = [0.02, -0.03, 0.01, -0.02, 0.03, -0.01];

  const topVerts = [];
  const botVerts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TWO_PI;
    const r = R + offsets[i];
    topVerts.push([r * Math.cos(a),  halfH, r * Math.sin(a)]);
    botVerts.push([r * Math.cos(a), -halfH, r * Math.sin(a)]);
  }
  // 0–5: top ring,  6–11: bottom ring

  const primaryEdges = [];
  for (let i = 0; i < N; i++) {
    primaryEdges.push([i, (i + 1) % N]);                 // top ring
    primaryEdges.push([N + i, N + ((i + 1) % N)]);       // bottom ring
    primaryEdges.push([i, N + i]);                         // verticals
  }

  // Attachment ring: slightly larger, at midplane (12–17)
  const ringY = -0.02;
  const ringR = 0.34;
  const ringVerts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TWO_PI + 0.12;                    // slight angular offset
    ringVerts.push([ringR * Math.cos(a), ringY, ringR * Math.sin(a)]);
  }

  const attachEdges = [];
  for (let i = 0; i < N; i++) {
    attachEdges.push([12 + i, 12 + ((i + 1) % N)]);      // ring loop
    attachEdges.push([12 + i, i]);                         // tie to top vertices
  }

  const vertices = [...topVerts, ...botVerts, ...ringVerts];

  return {
    vertices,
    zones: [
      { name: 'Primary Structure', edges: primaryEdges, massPercent: 75 },
      { name: 'Attachment Ring',   edges: attachEdges,  massPercent: 25 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fragment: irregular polygon seeded by debris ID (built per-target)
// ---------------------------------------------------------------------------

/**
 * Build a fragment wireframe shape using the debris ID as a deterministic seed.
 * @param {number} id - debris ID for pseudo-random seed
 * @returns {{ vertices: number[][], zones: { name: string, edges: number[][], massPercent: number }[] }}
 */
function buildFragment(id) {
  // Knuth multiplicative hash for deterministic pseudo-random
  const seed = ((id || 1) >>> 0) * 2654435761;
  const rand = (i) => {
    const v = Math.abs(Math.sin(seed + i * 127.1) * 43758.5453);
    return v - Math.floor(v);
  };

  const count = 5 + Math.floor(rand(0) * 3); // 5–7 vertices
  const vertices = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TWO_PI;
    const r = 0.22 + rand(i + 1) * 0.18;
    const y = (rand(i + 10) - 0.5) * 0.16;
    vertices.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }

  const edges = [];
  for (let i = 0; i < count; i++) {
    edges.push([i, (i + 1) % count]);
  }
  // Cross-edges for 3D depth
  if (count > 4) {
    edges.push([0, Math.floor(count / 2)]);
    edges.push([1, Math.floor(count / 2) + 1]);
  }

  return {
    vertices,
    zones: [
      { name: 'Whole Fragment', edges, massPercent: 100 },
    ],
  };
}

// ---------------------------------------------------------------------------
// ADR Satellite (V3 Octopus): octagonal bus + solar wings + 6 dock cavities
// + ion drive nozzle + laser aperture. Shown as default when no target.
// ---------------------------------------------------------------------------
function buildADRSatellite() {
  // Octagonal prism bus — 8 vertices top, 8 vertices bottom (0–15)
  const R = 0.22;
  const busH = 0.25;
  const topVerts = [];
  const botVerts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TWO_PI;
    topVerts.push([R * Math.cos(a),  busH, R * Math.sin(a)]);
    botVerts.push([R * Math.cos(a), -busH, R * Math.sin(a)]);
  }
  // 0–7: top ring, 8–15: bottom ring

  const busEdges = [];
  for (let i = 0; i < 8; i++) {
    busEdges.push([i, (i + 1) % 8]);             // top ring
    busEdges.push([8 + i, 8 + ((i + 1) % 8)]);   // bottom ring
    busEdges.push([i, 8 + i]);                     // verticals
  }

  // Solar panel wings — left and right (16–23)
  const py = 0.05;
  const panelLVerts = [
    [-R, -py, 0], [-0.55, -py, 0], [-0.55, py, 0], [-R, py, 0],  // 16–19
  ];
  const panelLEdges = [
    [16, 17], [17, 18], [18, 19], [19, 16],
    [16, 18], [17, 19],   // cross-hatch solar cells
  ];
  const panelRVerts = [
    [R, -py, 0], [0.55, -py, 0], [0.55, py, 0], [R, py, 0],       // 20–23
  ];
  const panelREdges = [
    [20, 21], [21, 22], [22, 23], [23, 20],
    [20, 22], [21, 23],
  ];

  // 6 Docking cavities — small diamonds at hexagonal positions on top face (24–35)
  const dockVerts = [];
  const dockEdges = [];
  const dockR = R * 0.65;
  const ds = 0.04; // diamond half-size
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TWO_PI;
    const cx = dockR * Math.cos(a);
    const cz = dockR * Math.sin(a);
    const base = 24 + i * 2;
    dockVerts.push([cx + ds, busH + 0.01, cz]);      // right of diamond
    dockVerts.push([cx - ds, busH + 0.01, cz]);      // left of diamond
    dockEdges.push([base, base + 1]);                  // horizontal bar
  }

  // Ion drive nozzle — small ring + converging lines at bottom (36–43, 44)
  const nR = 0.12;
  const nozzleY = -busH - 0.12;
  const nozzleVerts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TWO_PI;
    nozzleVerts.push([nR * Math.cos(a), nozzleY, nR * Math.sin(a)]);
  }
  // 36–43: nozzle ring, 44: nozzle exit point
  const nozzleTip = [[0, nozzleY - 0.06, 0]];
  const nozzleEdges = [];
  for (let i = 0; i < 8; i++) {
    nozzleEdges.push([36 + i, 36 + ((i + 1) % 8)]); // ring
    nozzleEdges.push([8 + i, 36 + i]);                // connect to bus bottom
  }
  for (let i = 0; i < 8; i += 2) {
    nozzleEdges.push([36 + i, 44]);                    // converge to tip
  }

  // Laser aperture ring — on forward top face (45–50)
  const laserR = 0.10;
  const laserY = busH + 0.02;
  const laserVerts = [];
  const laserEdges = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TWO_PI;
    laserVerts.push([laserR * Math.cos(a), laserY, laserR * Math.sin(a)]);
  }
  for (let i = 0; i < 6; i++) {
    laserEdges.push([45 + i, 45 + ((i + 1) % 6)]);
  }

  const vertices = [
    ...topVerts, ...botVerts,               // 0–15
    ...panelLVerts, ...panelRVerts,         // 16–23
    ...dockVerts,                            // 24–35
    ...nozzleVerts, ...nozzleTip,           // 36–44
    ...laserVerts,                           // 45–50
  ];

  // Scale up ADR satellite wireframe by 1.5× for better visualization
  for (const v of vertices) {
    v[0] *= 1.5;
    v[1] *= 1.5;
    v[2] *= 1.5;
  }

  return {
    vertices,
    zones: [
      { name: 'Bus',          edges: busEdges,    massPercent: 55 },
      { name: 'Solar Panels', edges: [...panelLEdges, ...panelREdges], massPercent: 12 },
      { name: 'Daughter Cavities', edges: dockEdges,   massPercent: 18 },
      { name: 'Ion Drive',    edges: nozzleEdges, massPercent: 10 },
      { name: 'Laser',        edges: laserEdges,  massPercent: 5 },
    ],
  };
}

// Pre-build static shapes at module load (fragment is per-target)
const SHAPES = {
  rocketBody:    buildRocketBody(),
  defunctSat:    buildDefunctSat(),
  missionDebris: buildMissionDebris(),
  adrSatellite:  buildADRSatellite(),
};

// ============================================================================
// 3-D GEOMETRY GENERATION (ST-2.3) — wireframe-derived BufferGeometries
// ============================================================================

/** @type {Map<string, THREE.BufferGeometry>} Cached geometries keyed by type (or fragment variant) */
const _geoCache = new Map();

/** @type {Map<string, number>} Local-space bounding radius per geometry type */
const _geoRadiusCache = new Map();

/** @type {Map<string, {x:number,y:number,z:number}>} Bounding-box half-extents per geometry */
const _geoHalfExtentCache = new Map();

/**
 * Merge an array of THREE.BufferGeometry into a single BufferGeometry.
 * Supports indexed and non-indexed geometries (position + normal only).
 * @param {THREE.BufferGeometry[]} geos
 * @returns {THREE.BufferGeometry}
 */
function _mergeGeometries(geos) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vertexOffset = 0;

  for (const geo of geos) {
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const idx = geo.index;

    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      // ST-6.2: Merge UVs for texture atlas support
      if (uv) {
        uvs.push(uv.getX(i), uv.getY(i));
      } else {
        uvs.push(0, 0);
      }
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices.push(idx.array[i] + vertexOffset);
      }
    } else {
      // Non-indexed: generate sequential indices
      for (let i = 0; i < pos.count; i++) {
        indices.push(vertexOffset + i);
      }
    }
    vertexOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  }
  if (uvs.length > 0) {
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  }
  if (indices.length) merged.setIndex(indices);
  merged.computeVertexNormals();
  return merged;
}

/**
 * Build a THREE.BufferGeometry for a rocket body type.
 *
 * Improved: a spent upper stage — tapered nose, ribbed cylindrical tank, a
 * staging seam ring, and a deep open engine bell with an internal throat cone
 * so the nozzle reads as hollow and machined when you fly in close.
 * @returns {THREE.BufferGeometry}
 */
function _buildRocketBodyGeo() {
  const parts = [];

  // Outer hull profile (Lathe): nosecone → tank → flared nozzle lip
  const profile = [
    new THREE.Vector2(0.001, 0.52),
    new THREE.Vector2(0.16,  0.42),   // nose shoulder
    new THREE.Vector2(0.30,  0.30),   // nosecone base
    new THREE.Vector2(0.30, -0.22),   // tank wall
    new THREE.Vector2(0.27, -0.30),   // tank-to-skirt step
    new THREE.Vector2(0.30, -0.40),   // engine skirt
    new THREE.Vector2(0.44, -0.52),   // nozzle bell lip (flared, open)
  ];
  const hull = new THREE.LatheGeometry(profile, 16);
  parts.push(hull);

  // Internal nozzle throat cone (so the open bell looks hollow up close)
  const throat = new THREE.ConeGeometry(0.10, 0.18, 14, 1, true);
  throat.translate(0, -0.40, 0);
  parts.push(throat);

  // Staging seam ring around the midsection
  const seam = new THREE.TorusGeometry(0.305, 0.018, 6, 18);
  seam.rotateX(Math.PI / 2);
  seam.translate(0, -0.06, 0);
  parts.push(seam);

  // Two raised structural bands (ribs) on the tank
  for (const yb of [0.12, -0.16]) {
    const band = new THREE.TorusGeometry(0.305, 0.010, 5, 16);
    band.rotateX(Math.PI / 2);
    band.translate(0, yb, 0);
    parts.push(band);
  }

  const geo = _mergeGeometries(parts);
  // Match prior scene-size convention.
  geo.scale(1.5, 1.5, 1.5);
  return geo;
}

/**
 * Build a THREE.BufferGeometry for a defunct satellite type.
 *
 * Improved: a recognisable spacecraft silhouette — a multi-panel box bus with
 * a beveled top, two segmented solar-array wings on booms, a parabolic dish on
 * a gimbal, an antenna whip and a thruster nozzle. Reads clearly as a derelict
 * satellite from a distance and rewards a close inspection with real structure.
 * @returns {THREE.BufferGeometry}
 */
function _buildDefunctSatGeo() {
  const parts = [];

  // --- Main bus (slightly tapered box via Lathe-free stacked boxes) ---
  const body = new THREE.BoxGeometry(0.40, 0.34, 0.32);
  parts.push(body);
  // Beveled equipment deck on top
  const deck = new THREE.BoxGeometry(0.30, 0.06, 0.24);
  deck.translate(0, 0.20, 0);
  parts.push(deck);
  // MLI blanket lip / lower adapter ring
  const adapter = new THREE.CylinderGeometry(0.10, 0.13, 0.08, 8);
  adapter.translate(0, -0.21, 0);
  parts.push(adapter);

  // --- Solar wings: boom + 3 segmented panel cells each side ---
  for (const side of [-1, 1]) {
    const boom = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6);
    boom.rotateZ(Math.PI / 2);
    boom.translate(side * 0.31, 0, 0);
    parts.push(boom);
    for (let s = 0; s < 3; s++) {
      const panel = new THREE.BoxGeometry(0.30, 0.185, 0.012);
      // gap between cells so seams are visible up close
      panel.translate(side * (0.55 + s * 0.32), 0, 0);
      parts.push(panel);
    }
  }

  // --- Parabolic-ish high-gain dish on a short gimbal ---
  const gimbal = new THREE.CylinderGeometry(0.02, 0.02, 0.10, 6);
  gimbal.translate(0.10, 0.27, 0.10);
  parts.push(gimbal);
  // Open dish (cone, thin) facing up-and-out
  const dish = new THREE.ConeGeometry(0.13, 0.10, 14, 1, true);
  dish.rotateX(Math.PI);          // open face up
  dish.translate(0.10, 0.36, 0.10);
  parts.push(dish);
  const feed = new THREE.ConeGeometry(0.015, 0.07, 4);
  feed.translate(0.10, 0.30, 0.10);
  parts.push(feed);

  // --- Antenna whip ---
  const whip = new THREE.CylinderGeometry(0.006, 0.006, 0.22, 4);
  whip.translate(-0.13, 0.30, -0.10);
  parts.push(whip);

  // --- Thruster nozzle on the underside ---
  const nozzle = new THREE.ConeGeometry(0.05, 0.08, 8, 1, true);
  nozzle.translate(-0.10, -0.24, -0.06);
  parts.push(nozzle);

  const geo = _mergeGeometries(parts);
  // Normalise to scene-size convention (old merged geo scaled 1.5×).
  geo.scale(1.35, 1.35, 1.35);
  return geo;
}

/**
 * Build a THREE.BufferGeometry for mission debris type.
 *
 * Improved: a discarded payload-adapter / equipment module — an octagonal
 * canister with a recessed top hatch, a clamp-band ring, mounting lugs around
 * the rim and a stub connector. More machined and man-made than a bare prism.
 * @returns {THREE.BufferGeometry}
 */
function _buildMissionDebrisGeo() {
  const parts = [];

  // Main octagonal canister
  const can = new THREE.CylinderGeometry(0.28, 0.30, 0.42, 8);
  parts.push(can);

  // Recessed top hatch (smaller disc) + raised rim
  const hatch = new THREE.CylinderGeometry(0.18, 0.18, 0.05, 8);
  hatch.translate(0, 0.225, 0);
  parts.push(hatch);
  const rim = new THREE.TorusGeometry(0.20, 0.02, 5, 8);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.21, 0);
  parts.push(rim);

  // Clamp-band ring around the waist
  const band = new THREE.TorusGeometry(0.31, 0.035, 6, 8);
  band.rotateX(Math.PI / 2);
  band.translate(0, -0.04, 0);
  parts.push(band);

  // Four mounting lugs around the lower rim
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const lug = new THREE.BoxGeometry(0.06, 0.08, 0.04);
    lug.translate(Math.cos(a) * 0.31, -0.18, Math.sin(a) * 0.31);
    lug.rotateY(-a);
    parts.push(lug);
  }

  // Stub connector poking out the side
  const stub = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 6);
  stub.rotateZ(Math.PI / 2);
  stub.translate(0.32, 0.05, 0);
  parts.push(stub);

  const geo = _mergeGeometries(parts);
  // Match prior scene-size convention (old hex prism scaled 2.3×).
  geo.scale(1.85, 1.85, 1.85);
  return geo;
}

/**
 * Deterministic hash → [0,1) for a given integer seed.
 * @param {number} n
 * @returns {number}
 */
function _hash01(n) {
  const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Build a flat-shaded BufferGeometry from a triangle list.
 * Each triangle gets its own 3 vertices so faces read as sharp facets
 * (no smoothed/averaged normals across edges).
 * @param {number[][]} verts  - array of [x,y,z]
 * @param {number[][]} faces  - array of [i,j,k] index triples
 * @returns {THREE.BufferGeometry}
 */
function _buildFlatGeometry(verts, faces) {
  const positions = [];
  const uvs = [];
  for (const [a, b, c] of faces) {
    const va = verts[a], vb = verts[b], vc = verts[c];
    positions.push(va[0], va[1], va[2], vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
    // Planar-ish UV from spherical coords so the type atlas reads as surface grime
    for (const v of [va, vb, vc]) {
      const u = 0.5 + Math.atan2(v[2], v[0]) / (2 * Math.PI);
      const w = 0.5 + Math.asin(Math.max(-1, Math.min(1, v[1] /
        (Math.hypot(v[0], v[1], v[2]) || 1)))) / Math.PI;
      uvs.push(u, w);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals(); // per-triangle (vertices not shared) → flat facets
  return geo;
}

/**
 * Build the convex hull (triangle faces) of a small deterministic point cloud.
 * Incremental hull: robust enough for the ~14-point clouds we feed it and
 * avoids any addon/CDN dependency. Returns face index triples into `points`.
 * @param {number[][]} points
 * @returns {number[][]}
 */
function _convexHullFaces(points) {
  const n = points.length;
  const faces = [];
  const EPS = 1e-7;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Brute-force: a triangle (i,j,k) is a hull face if every other point lies
  // on one side of its plane. n is tiny (~14) so O(n^4) is fine and runs once.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const normal = cross(sub(points[j], points[i]), sub(points[k], points[i]));
        const nlen = Math.hypot(normal[0], normal[1], normal[2]);
        if (nlen < EPS) continue; // degenerate / collinear
        let pos = 0, neg = 0;
        for (let m = 0; m < n; m++) {
          if (m === i || m === j || m === k) continue;
          const d = dot(normal, sub(points[m], points[i]));
          if (d > EPS) pos++;
          else if (d < -EPS) neg++;
          if (pos && neg) break;
        }
        if (pos && neg) continue; // not a hull face
        // Orient outward: normal should point away from centroid (origin-ish)
        const centerDot = dot(normal, points[i]);
        if (centerDot < 0) faces.push([i, k, j]);
        else faces.push([i, j, k]);
      }
    }
  }
  return faces;
}

/**
 * Build a THREE.BufferGeometry for a fragment type with per-ID variation.
 *
 * Improved: instead of a smooth subdivided "ball of triangles", each fragment
 * is a sharp, irregular faceted chunk — the convex hull of a deterministic
 * point cloud distorted along its principal axes. This reads as torn rocket
 * shrapnel / cracked panel shards rather than a lumpy sphere. Flat-shaded so
 * every facet catches the sun differently and gives strong specular pops as it
 * tumbles — encouraging the player to move in for a close look.
 *
 * @param {number} variantIndex - Variant index (0..DEBRIS_FRAGMENT_VARIANTS-1)
 * @returns {THREE.BufferGeometry}
 */
function _buildFragmentGeo(variantIndex) {
  const seed = ((variantIndex + 1) >>> 0) * 2654435761 >>> 0;

  // Anisotropic stretch per variant → slab-like shards, splinters, blocky chunks
  const sx = 0.55 + _hash01(seed + 11) * 0.95;       // 0.55 .. 1.50
  const sy = 0.45 + _hash01(seed + 23) * 0.70;       // 0.45 .. 1.15
  const sz = 0.55 + _hash01(seed + 37) * 0.95;
  // A few variants are flat plate-like shards (panel fragments)
  const plate = _hash01(seed + 41) > 0.68;
  const flat = plate ? 0.32 + _hash01(seed + 43) * 0.18 : 1.0;

  // Scatter a small irregular point cloud on a distorted sphere
  const NPTS = 14;
  const pts = [];
  for (let i = 0; i < NPTS; i++) {
    // Fibonacci-ish sphere direction, jittered deterministically
    const t = (i + 0.5) / NPTS;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i + _hash01(seed + i * 7) * 1.3;
    let dx = Math.sin(phi) * Math.cos(theta);
    let dy = Math.cos(phi);
    let dz = Math.sin(phi) * Math.sin(theta);
    // Radius jitter so the hull has uneven, snapped-off vertices
    const r = 0.62 + _hash01(seed + i * 53 + 5) * 0.42;
    pts.push([dx * sx * r, dy * sy * flat * r, dz * sz * r]);
  }

  let faces = _convexHullFaces(pts);
  if (faces.length < 4) {
    // Degenerate fallback (shouldn't happen) → low-detail icosahedron
    return new THREE.IcosahedronGeometry(0.9, 1);
  }

  const geo = _buildFlatGeometry(pts, faces);

  // Normalise bounding radius so all variants occupy a similar footprint,
  // matching the scene-size convention used by the other types.
  geo.computeBoundingSphere();
  const br = geo.boundingSphere ? geo.boundingSphere.radius : 1;
  if (br > 0) geo.scale(0.95 / br, 0.95 / br, 0.95 / br);
  return geo;
}

/**
 * Get wireframe shape data for a debris type (pure data, no THREE dependency).
 * Useful for testing and for the Canvas2D wireframe panel.
 * @param {string} type - 'rocketBody' | 'defunctSat' | 'missionDebris' | 'fragment'
 * @param {number} [id=0] - Debris ID (used for fragment variation)
 * @returns {{ vertices: number[][], zones: Array<{ name: string, edges: number[][], massPercent: number }> }}
 */
export function getWireframeData(type, id = 0) {
  if (type === 'fragment') return buildFragment(id);
  return SHAPES[type] || SHAPES.missionDebris;
}

// ============================================================================
// ZONE RISK ASSESSMENT
// ============================================================================

/**
 * Compute effective brittleness with material modifiers applied.
 * @param {object} target - debris target
 * @returns {number} clamped [0, 1]
 */
function effectiveBrittleness(target) {
  let b = target.brittleness || 0;
  if (target.material === 'composite') b += 0.1;
  if (target.material === 'titanium')  b -= 0.1;
  return Math.max(0, Math.min(1, b));
}

/**
 * Determine zone risk level and color based on zone type, target brittleness
 * and material.
 * @param {string} zoneName
 * @param {object} target
 * @returns {{ risk: string, color: string }}
 */
function assessZone(zoneName, target) {
  const b = effectiveBrittleness(target);
  const nameLower = zoneName.toLowerCase();

  // Engine zones → always red (hazardous propellant/pressure vessels)
  if (nameLower.includes('engine')) {
    return { risk: 'HIGH', color: ZONE_COLORS.RED };
  }

  // Solar panels
  if (nameLower.includes('solar panel')) {
    if (b > 0.7) return { risk: 'HIGH', color: ZONE_COLORS.RED };
    if (b > 0.3) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
    return { risk: 'LOW', color: ZONE_COLORS.GREEN };
  }

  // Fragments
  if (target.type === 'fragment') {
    if (b > 0.5) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
    return { risk: 'LOW', color: ZONE_COLORS.GREEN };
  }

  // Main body / bus / general structure
  if (b >= 0.7) return { risk: 'HIGH', color: ZONE_COLORS.RED };
  if (b >= 0.4) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
  return { risk: 'LOW', color: ZONE_COLORS.GREEN };
}

// ============================================================================
// APPROACH RECOMMENDATION TEXT
// ============================================================================

/**
 * Generate approach recommendation string for a zone + target combination.
 * @param {string} zoneName
 * @param {object} target
 * @returns {string}
 */
function getRecommendation(zoneName, target) {
  const tumbleDeg = (target.tumbleRate || 0) * DEG;
  const nameLower = zoneName.toLowerCase();

  // Tumble-rate warnings take priority
  if (tumbleDeg > 60) return '\u26A0 HIGH TUMBLE \u2014 Manual pilot recommended';
  if (tumbleDeg > 20) return '\u25D0 Moderate tumble \u2014 Time net deployment';

  // Zone-specific recommendations
  if (nameLower.includes('engine'))      return '\u26A0 Avoid engine \u2014 approach from opposite end';
  if (nameLower.includes('solar panel')) return '\u25B3 Fragile \u2014 net may cause fragmentation';
  if (target.type === 'fragment')        return '\u2713 Small target \u2014 spinner auto-capture viable';

  // Fall back to risk-based
  const { risk } = assessZone(zoneName, target);
  if (risk === 'LOW')  return '\u2713 Safe for auto-capture';
  if (risk === 'MED')  return '\u25D0 Caution \u2014 moderate structural risk';
  return '\u26A0 Hazardous zone \u2014 avoid if possible';
}

// ============================================================================
// REUSABLE ROTATION MATH — single object, zero per-frame allocations
// ============================================================================

/** Pre-allocated 3-element array for transform output */
const _rot = [0, 0, 0];
const _cosTilt = Math.cos(TILT_X);
const _sinTilt = Math.sin(TILT_X);

/**
 * Apply Y-axis rotation then fixed X-axis tilt in-place.
 * Result is written to module-level `_rot` — no allocation.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} cosY - precomputed cos(angle)
 * @param {number} sinY - precomputed sin(angle)
 */
function rotateAndTilt(x, y, z, cosY, sinY) {
  // Y-axis rotation
  const rx = x * cosY + z * sinY;
  const ry = y;
  const rz = -x * sinY + z * cosY;

  // X-axis tilt (fixed 15°)
  _rot[0] = rx;
  _rot[1] = ry * _cosTilt - rz * _sinTilt;
  _rot[2] = ry * _sinTilt + rz * _cosTilt;
}

// ============================================================================
// DEBRIS WIREFRAME CLASS
// ============================================================================

export class DebrisWireframe {
  /**
   * Return a THREE.BufferGeometry suitable for instanced-mesh use.
   * Geometries are derived from the wireframe silhouettes and cached per type.
   * For fragments, `id % DEBRIS_FRAGMENT_VARIANTS` selects a variant.
   *
   * @param {string} type - 'rocketBody' | 'defunctSat' | 'missionDebris' | 'fragment'
   * @param {number} [id=0] - Debris ID (only used for fragment variant selection)
   * @returns {THREE.BufferGeometry}
   */
  static getGeometry(type, id = 0) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;

    if (_geoCache.has(cacheKey)) return _geoCache.get(cacheKey);

    let geo;
    switch (type) {
      case 'rocketBody':
        geo = _buildRocketBodyGeo();
        break;
      case 'defunctSat':
        geo = _buildDefunctSatGeo();
        break;
      case 'missionDebris':
        geo = _buildMissionDebrisGeo();
        break;
      case 'fragment':
      default:
        geo = _buildFragmentGeo((id >>> 0) % N);
        // Scale up fragments so they're visible at distance (rocket 1.5×, mission 2.3×, fragment 1.3×)
        geo.scale(1.3, 1.3, 1.3);
        break;
    }

    // Cache the local bounding radius so flag decals can be mounted exactly on
    // the surface. Keyed by cacheKey (includes the fragment variant) so each
    // variant resolves its own radius even if variant sizes ever diverge.
    geo.computeBoundingSphere();
    const br = geo.boundingSphere ? geo.boundingSphere.radius : 1;
    _geoRadiusCache.set(cacheKey, br);

    // Cache bounding-box half-extents too. The bounding *sphere* is dominated by
    // far-reaching parts (e.g. solar wings), so using it to place a flag decal
    // along an arbitrary direction would float the flag in empty space. The box
    // half-extents let us land the decal on the actual hull face per direction.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    _geoHalfExtentCache.set(cacheKey, bb
      ? { x: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
          y: Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)),
          z: Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) }
      : { x: br, y: br, z: br });

    _geoCache.set(cacheKey, geo);
    return geo;
  }

  /**
   * Local-space bounding radius for a debris geometry (cached after first
   * getGeometry call). Used to place flag decals on the surface.
   * @param {string} type
   * @param {number} [id=0] - Debris ID (selects the fragment variant)
   * @returns {number}
   */
  static getBoundingRadius(type, id = 0) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;
    return _geoRadiusCache.has(cacheKey) ? _geoRadiusCache.get(cacheKey) : 1;
  }

  /**
   * Distance from the local origin to the bounding-box surface along a
   * (local-space) unit direction. Used to mount flag decals flush on the hull
   * face the decal points at, rather than at the (often much larger) bounding
   * sphere radius. O(1); falls back to the bounding radius if uncached.
   * @param {string} type
   * @param {number} id
   * @param {number} dx @param {number} dy @param {number} dz - unit direction
   * @returns {number} distance to the box surface along the direction
   */
  static getSurfaceDistance(type, id, dx, dy, dz) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;
    const he = _geoHalfExtentCache.get(cacheKey);
    if (!he) return this.getBoundingRadius(type, id);
    // Ray from origin along (dx,dy,dz) exits the box at the smallest positive t
    // that hits a slab face: t = halfExtent / |component|.
    let t = Infinity;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ax > 1e-6) t = Math.min(t, he.x / ax);
    if (ay > 1e-6) t = Math.min(t, he.y / ay);
    if (az > 1e-6) t = Math.min(t, he.z / az);
    return isFinite(t) ? t : this.getBoundingRadius(type, id);
  }

  /**
   * Creates canvas overlay, initialises internal state.
   * When no target is selected, shows the player's ADR satellite wireframe.
   * @param {HTMLElement} [container] - Optional DOM container; if provided, canvas
   *   is appended to it with relative positioning. Otherwise uses fixed positioning.
   */
  constructor(container) {
    /** @type {HTMLCanvasElement} */
    this._canvas = document.createElement('canvas');

    // HiDPI / Retina scaling — buffer at native resolution, CSS at logical size
    const dpr = window.devicePixelRatio || 1;
    /** @type {number} Device pixel ratio for HiDPI canvas scaling */
    this.dpr = dpr;
    this._canvas.width = PANEL_WIDTH * dpr;
    this._canvas.height = PANEL_HEIGHT * dpr;

    /** @type {boolean} Whether mounted in a container or floating */
    this._hasContainer = !!container;

    /** @type {boolean} Collapsed-to-summary-line state (toggleMinimized). */
    this._minimized = false;

    if (container) {
      // Container-relative positioning (integrated above target list)
      Object.assign(this._canvas.style, {
        width: `${PANEL_WIDTH}px`,
        height: `${PANEL_HEIGHT}px`,
        pointerEvents: 'none',
        display: 'block',
        border: `1px solid ${BORDER_COLOR}`,
        imageRendering: 'auto',
        borderRadius: '4px',
      });
      container.appendChild(this._canvas);

      // Minimized one-line summary (hotkey revamp 2026-06-14 — the 9 key).
      // When minimized we hide the canvas and show this single line of the key
      // capture-planning facts NOT in the target list: identity · size · mass ·
      // tumble (with ⚠ when high) · material. Lives in the same flex container,
      // so the right column collapses up around it.
      this._minLine = document.createElement('div');
      this._minLine.id = 'hud-debris-min-summary';
      Object.assign(this._minLine.style, {
        display: 'none',
        font: "11px 'Courier New', monospace",
        color: 'rgba(0,255,136,0.8)',
        padding: '4px 6px',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      this._minLine.textContent = '. No target. ';
      container.appendChild(this._minLine);
    } else {
      // Legacy fixed positioning (fallback) — top-right below NavSphere so it
      // never collides with bottom-anchored panels (DaughterWireframe bottom-
      // left, warnings strip bottom-center, comms panel).
      Object.assign(this._canvas.style, {
        position: 'fixed',
        top: `${PANEL_MARGIN_TOP}px`,
        right: `${PANEL_MARGIN_RIGHT}px`,
        width: `${PANEL_WIDTH}px`,
        height: `${PANEL_HEIGHT}px`,
        zIndex: String(Z_INDEX),
        pointerEvents: 'none',
        display: 'none',
        border: `1px solid ${BORDER_COLOR}`,
        imageRendering: 'auto',
      });
      document.body.appendChild(this._canvas);
    }

    /** @type {CanvasRenderingContext2D} */
    this._ctx = this._canvas.getContext('2d');

    // Scale context so all drawing uses logical (CSS) pixels
    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    // --- Cached background gradient (never changes) ---
    const grad = this._ctx.createRadialGradient(WIRE_CX, WIRE_CY, 0, WIRE_CX, WIRE_CY, PANEL_WIDTH * 0.55);
    grad.addColorStop(0, 'rgba(0, 20, 40, 0.9)');
    grad.addColorStop(1, BG_COLOR);
    /** @type {CanvasGradient} */
    this._bgGradient = grad;

    // --- State ---
    /** @type {object|null} Current debris target */
    this._target = null;
    /** @type {object|null} Current wireframe shape definition */
    this._shape = null;
    /** @type {number} Currently highlighted zone index (-1 = none) */
    this._zoneIndex = -1;
    /** @type {boolean} True after player has cycled through every zone */
    this._assessed = false;
    /** @type {Set<number>} Indices of zones the player has viewed */
    this._viewedZones = new Set();
    /** @type {number} Accumulated rotation angle (rad) */
    this._angle = 0;
    /** @type {boolean} Panel visibility flag */
    this._visible = false;
    /** @type {number} Throttle counter for Canvas2D redraws (15Hz at 60fps) */
    this._frameSkip = -1;
    /** @type {boolean} True when showing ADR satellite self-view */
    this._showingADR = false;
    /** @type {boolean} True when in daughter-piloted expanded inspection mode */
    this._expandedMode = false;
    /** @type {number|null} Index of daughter arm when expanded */
    this._fromArmIndex = null;
    /** @type {Array<{id:string,state:string,type:string}>} Arm status for dock cavity colors */
    this._armStatuses = [];
    /** @type {boolean} Whether salvage scanner upgrade is active */
    this._hasSalvageScanner = false;

    // --- Pre-allocated projection buffer (resized per target) ---
    /** @type {number[][]} Projected [sx, sy] for each vertex */
    this._projected = [];

    // --- Cached zone assessments (refreshed in setTarget) ---
    /** @type {{ risk: string, color: string }[]} */
    this._zoneAssessments = [];

    // ── Dossier reveal state (capture-feedback overhaul Phase 1.5) ──
    /** @type {number} ms timestamp when the silhouette draw-on began */
    this._traceStart = 0;
    /** @type {number|null} ms timestamp when Full Profile typewriter began */
    this._profileRevealStart = null;
    /** @type {number} rows already revealed (chime once per new row) */
    this._lastRowsShown = 0;

    // Full Profile unlocked while this target is on screen → start the
    // line-by-line typewriter reveal ("the chest opens").
    eventBus.on(Events.DEBRIS_PROFILED, ({ debrisId }) => {
      if (this._target && this._target.id === debrisId) {
        this._profileRevealStart = performance.now();
        this._lastRowsShown = 0;
      }
    });

    // Start with ADR satellite self-view if container-mounted
    if (this._hasContainer) {
      this._showADRSatellite();
    }

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.setVisible(false);
    });

    // Self-manage target via EventBus (Batch 3 decoupling)
    eventBus.on(Events.TARGET_SELECTED, ({ debris }) => {
      if (debris) this.setTarget(debris);
    });
    eventBus.on(Events.TARGET_CLEARED, () => {
      this.setTarget(null);
    });
    eventBus.on(Events.GAME_RESET, () => {
      this.setTarget(null);
    });
    eventBus.on(Events.DEBRIS_REMOVED, () => {
      // If our current target was removed, clear it
      if (this._target && !this._target.alive) {
        this.setTarget(null);
      }
    });
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Set the debris target to display, or `null` to show ADR satellite self-view
   * (when container-mounted) or hide the panel (when floating).
   * Resets zone selection and assessment state.
   * @param {object|null} target - debris object from DebrisField
   */
  setTarget(target) {
    if (target === this._target && !this._showingADR) return;

    this._target = target;
    this._zoneIndex = -1;
    this._assessed = false;
    this._viewedZones.clear();
    this._angle = 0;
    this._showingADR = false;
    // Dossier: restart the silhouette draw-on; profiled targets show all rows.
    this._traceStart = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._profileRevealStart = null;
    this._lastRowsShown = 0;

    if (target) {
      this._shape = target.type === 'fragment'
        ? buildFragment(target.id)
        : (SHAPES[target.type] || null);

      if (this._shape) {
        this._allocateProjectionBuffer(this._shape.vertices.length);
        // Cache zone risk assessments (avoids per-frame object creation)
        this._zoneAssessments = this._shape.zones.map(
          (zone) => assessZone(zone.name, target)
        );
      }
      this.setVisible(true);
    } else if (this._hasContainer) {
      // Container-mounted: show ADR satellite self-view instead of hiding
      this._showADRSatellite();
    } else {
      this._shape = null;
      this._zoneAssessments = [];
      this.setVisible(false);
    }

    // Keep the minimized one-liner current if the pane is collapsed (9).
    if (this._minimized) this._renderMinLine();
  }

  /**
   * Update arm statuses for ADR satellite dock cavity coloring.
   * @param {Array<{id:string, state:string, type:string, fuel:number}>} statuses
   */
  setArmStatuses(statuses) {
    this._armStatuses = statuses || [];
  }

  /**
   * Set whether the salvage scanner upgrade is active.
   * @param {boolean} active
   */
  setSalvageScanner(active) {
    this._hasSalvageScanner = !!active;
  }

  /**
   * Cycle the zone highlight forward (+1) or backward (-1).
   * Tracks which zones have been visited for {@link hasAssessedTarget}.
   * Works on both debris targets and ADR satellite self-view.
   * @param {number} direction - +1 for next, -1 for previous
   */
  cycleZone(direction) {
    if (!this._shape) return;
    // Allow zone cycling even when showing ADR (no target needed)
    if (!this._target && !this._showingADR) return;
    const count = this._shape.zones.length;
    if (count === 0) return;

    if (this._zoneIndex < 0) {
      this._zoneIndex = direction > 0 ? 0 : count - 1;
    } else {
      this._zoneIndex = ((this._zoneIndex + direction) % count + count) % count;
    }

    this._viewedZones.add(this._zoneIndex);
    if (this._viewedZones.size >= count) {
      if (!this._assessed) {
        this._assessed = true;
        eventBus.emit(Events.WIREFRAME_ASSESSED);
      }
    }
  }

  /**
   * Returns info about the currently highlighted zone, or null if none selected.
   * @returns {{ name: string, risk: string, color: string, massPercent: number }|null}
   */
  getSelectedZone() {
    if (!this._shape || !this._target || this._zoneIndex < 0) return null;
    const zone = this._shape.zones[this._zoneIndex];
    const { risk, color } = this._zoneAssessments[this._zoneIndex];
    return { name: zone.name, risk, color, massPercent: zone.massPercent };
  }

  /**
   * Returns true if the player has cycled through all zones on the current target.
   * Used by the scoring system for bonus multiplier.
   * @returns {boolean}
   */
  hasAssessedTarget() {
    return this._assessed;
  }

  /**
   * Per-frame update: advances rotation animation and redraws the panel.
   * Should be called from the main game loop.
   * @param {number} dt - frame delta in seconds
   */
  update(dt) {
    if (!this._visible || !this._shape) return;
    // Need either a target OR ADR self-view OR expanded-mode placeholder
    if (!this._target && !this._showingADR && !this._expandedMode) return;

    // Rotation: use debris tumble rate, or slow spin for ADR satellite
    if (this._showingADR) {
      this._angle += 0.15 * dt; // slow gentle spin
    } else {
      // Same structure as DebrisField.js (tumbleRate × TIME_SCALE capped) but with a
      // lower ceiling tuned for Canvas2D perceptual comfort.
      const tumble = this._target.tumbleRate || 0;
      const maxWireRad = Constants.WIREFRAME_MAX_TUMBLE_DEG_S * Math.PI / 180;
      const rate = Math.max(MIN_TUMBLE_RATE, Math.min(tumble * Constants.TIME_SCALE_GAMEPLAY, maxWireRad));
      this._angle += rate * dt;
    }

    // FIX (Sprint 2 v2): Removed 30Hz frame throttle — was the root cause of
    // perceived "jitter/vibration" on rotating wireframes. Canvas2D render at
    // 60fps matches DOM compositor, eliminates stutter. Back-edge depth
    // dimming (below in _render) addresses the Necker-cube oscillation.
    this._render();
  }

  /**
   * Show or hide the panel.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = visible;
    this._frameSkip = -1; // Reset throttle so next update draws immediately
    // Respect the manual minimize (9 key): while minimized the one-liner owns
    // the slot, so target-selection / state logic must not re-show the canvas.
    if (this._minimized) {
      this._canvas.style.display = 'none';
      return;
    }
    this._canvas.style.display = visible ? 'block' : 'none';
  }

  /**
   * Minimize-to-one-line toggle for the "Debris pane" key (9, hotkey revamp
   * 2026-06-14) — mirrors the comms/target minimize. When minimized we hide the
   * wireframe canvas and show a single line of the capture-planning facts the
   * target list doesn't carry (identity · size · mass · tumble · material); the
   * right column collapses up around the shorter line. Press again to restore.
   * Falls back to a plain canvas hide when floating (no container / no min line).
   */
  toggleMinimized() {
    if (!this._hasContainer || !this._minLine) {
      this.setVisible(!this._visible);
      return;
    }
    this._minimized = !this._minimized;
    if (this._minimized) {
      this._renderMinLine();
      this._minLine.style.display = '';
      this._canvas.style.display = 'none';
    } else {
      this._minLine.style.display = 'none';
      this._canvas.style.display = 'block';
      this._frameSkip = -1; // redraw the wireframe immediately on restore
    }
  }

  /** @private Populate the minimized one-liner from the current target. */
  _renderMinLine() {
    if (!this._minLine) return;
    const t = this._target;
    if (!t) {
      this._minLine.textContent = this._showingADR ? '. V3 OCTOPUS (self). ' : '. No target. ';
      return;
    }
    const ident = t.name || TYPE_LABELS[t.type] || t.type || 'TARGET';
    const sizeStr = t.sizeMeter != null ? `${t.sizeMeter.toFixed(1)}m` : '?';
    let massStr = '?';
    if (t.mass != null) {
      massStr = t.mass >= 1000 ? `${(t.mass / 1000).toFixed(1)}t` : `${t.mass.toFixed(0)}kg`;
    }
    const tumbleDeg = (t.tumbleRate || 0) * DEG;
    const warn = tumbleDeg > 60 ? ' \u26A0' : '';
    const tumbleStr = `\u27F3${tumbleDeg.toFixed(0)}\u00B0/s${warn}`;
    const matStr = MATERIAL_LABELS[t.material] || t.material || '?';
    this._minLine.textContent = `${ident} \u00B7 ${sizeStr} \u00B7 ${massStr} \u00B7 ${tumbleStr} \u00B7 ${matStr}`;
  }

  /**
   * Remove the canvas from the DOM and release references.
   */
  dispose() {
    if (this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._target = null;
    this._shape = null;
    this._projected = [];
  }

  /**
   * Enter expanded inspection mode.
   * Scales the canvas and (for the daughter context) shows an origin badge.
   * @param {number|null} armIndex     0-based daughter arm index, or null when
   *                                    inspecting from the mothership.
   * @param {object|null} [debrisTarget] The arm's current debris target. When
   *   omitted, the already-selected target is kept (mothership V-cycle INSPECT);
   *   only falls back to the ADR self-view if nothing is selected.
   */
  setExpandedMode(armIndex, debrisTarget = null) {
    this._expandedMode   = true;
    this._fromArmIndex   = armIndex;
    const WC = Constants.WIREFRAMES;
    const EW = WC ? WC.PANEL_SIZE_EXPANDED.w : 392;
    const EH = WC ? WC.PANEL_SIZE_EXPANDED.h : 280;
    this._canvas.style.width  = `${EW}px`;
    this._canvas.style.height = `${EH}px`;
    if (debrisTarget) {
      this.setTarget(debrisTarget);
    } else if (this._target) {
      // Keep the already-tracked selected target (mothership inspection).
      this.setVisible(true);
    } else {
      // Show ADR self-view as placeholder when nothing is selected.
      this._showADRSatellite();
      this.setVisible(true);
    }
  }

  /**
   * Exit expanded mode; restore normal 280×200 panel size.
   */
  clearExpandedMode() {
    this._expandedMode   = false;
    this._fromArmIndex   = null;
    this._canvas.style.width  = `${PANEL_WIDTH}px`;
    this._canvas.style.height = `${PANEL_HEIGHT}px`;
  }

  // ==========================================================================
  // RENDERING — Private
  // ==========================================================================

  /** @private Full redraw of the panel. */
  _render() {
    const ctx = this._ctx;
    const W = PANEL_WIDTH;
    const H = PANEL_HEIGHT;

    // --- Background (cached gradient) ---
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this._bgGradient;
    ctx.fillRect(0, 0, W, H);

    // --- Header ---
    ctx.font = "bold 13px 'Courier New', monospace";
    ctx.textAlign = 'center';
    ctx.fillStyle = HEADER_COLOR;

    if (this._showingADR) {
      ctx.fillText('YOUR SATELLITE', WIRE_CX, 15);
      ctx.font = "12px 'Courier New', monospace";
      ctx.fillStyle = TYPE_COLOR;
      ctx.fillText('V3 OCTOPUS ADR', WIRE_CX, 27);
    } else {
      // Dossier tier (Phase 1.5): UNSCANNED → static noise, no data.
      const tier = dossierSystem.getTier(this._target);
      if (tier === DOSSIER_TIERS.UNSCANNED) {
        ctx.fillText('TARGET DOSSIER', WIRE_CX, 15);
        this._renderStaticNoise(ctx);
        ctx.font = "bold 11px 'Courier New', monospace";
        ctx.fillStyle = DIM_COLOR;
        ctx.textAlign = 'center';
        ctx.fillText('UNRESOLVED \u2014 scan [S]', WIRE_CX, 150);
        return;
      }
      ctx.fillText('TARGET DOSSIER [Z]', WIRE_CX, 15);
      const typeLabel = TYPE_LABELS[this._target.type] || this._target.type;
      ctx.font = "12px 'Courier New', monospace";
      ctx.fillStyle = TYPE_COLOR;
      ctx.fillText(typeLabel, WIRE_CX, 27);
    }

    // Daughter-origin badge (expanded mode from an arm pilot only)
    if (this._expandedMode && this._fromArmIndex != null) {
      ctx.textAlign = 'right';
      ctx.font = "9px 'Courier New', monospace";
      ctx.fillStyle = 'rgba(255,200,60,0.90)';
      ctx.fillText(
        `\uD83D\uDEF0 from Daughter ${this._fromArmIndex + 1}`,
        PANEL_WIDTH - 6,
        PANEL_HEIGHT - 6,
      );
    }

    // --- Project all vertices (also store rotated Z for depth-based alpha) ---
    const cosY = Math.cos(this._angle);
    const sinY = Math.sin(this._angle);
    const verts = this._shape.vertices;
    const proj = this._projected;

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      rotateAndTilt(v[0], v[1], v[2], cosY, sinY);
      const pz = _rot[2] + PERSPECTIVE_D;
      proj[i][0] = WIRE_CX + (_rot[0] / pz) * VIEW_SCALE;
      proj[i][1] = WIRE_CY - (_rot[1] / pz) * VIEW_SCALE;
      // Rotated Z: positive = far side (behind), negative = near side (camera).
      // Used below to dim back-facing edges — kills Necker-cube oscillation.
      proj[i][2] = _rot[2];
    }

    // --- Draw each zone — SMOOTH per-edge depth-interpolated alpha ---
    // Sprint 2 v2b: Previous two-pass hard-threshold (back/front classify by
    // avgZ > 0) caused FLICKER on edges near the rotation equator, which
    // swapped classification as they rotated. Single-pass with smooth linear
    // alpha mapping eliminates the flicker entirely.
    const zones = this._shape.zones;
    const assessments = this._zoneAssessments;
    // Dossier draw-on (Phase 1.5): after a scan the silhouette MATERIALIZES —
    // edges trace in over WIREFRAME_TRACE_S instead of popping fully formed.
    let edgeBudget = Infinity;
    if (!this._showingADR && this._target && this._traceStart) {
      const traceS = (Constants.DOSSIER && Constants.DOSSIER.WIREFRAME_TRACE_S) || 1.0;
      const nowMs = (typeof performance !== 'undefined') ? performance.now() : this._traceStart + traceS * 1000;
      const frac = Math.min(1, (nowMs - this._traceStart) / (traceS * 1000));
      if (frac < 1) {
        let totalEdges = 0;
        for (let zi = 0; zi < zones.length; zi++) totalEdges += zones[zi].edges.length;
        edgeBudget = Math.floor(frac * totalEdges);
      }
    }
    ctx.save();
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      const { color } = assessments[zi];
      const highlighted = zi === this._zoneIndex;
      const edges = zone.edges;

      // Highlighted glow — front-weighted (but still smooth, not hard cut)
      if (highlighted) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e][0];
          const b = edges[e][1];
          if (a >= proj.length || b >= proj.length) continue;
          const avgZ = (proj[a][2] + proj[b][2]) * 0.5;
          // Glow alpha: 0.35 front → 0 back (smooth)
          const frontness = Math.max(0, Math.min(1, (1 - avgZ) * 0.5));
          ctx.globalAlpha = 0.35 * frontness;
          ctx.beginPath();
          ctx.moveTo(proj[a][0], proj[a][1]);
          ctx.lineTo(proj[b][0], proj[b][1]);
          ctx.stroke();
        }
      }

      // Main pass — per-edge smooth depth-alpha
      ctx.strokeStyle = color;
      ctx.lineWidth = highlighted ? 2 : 1;
      const baseAlpha = highlighted ? 0.9 : 0.55;
      for (let e = 0; e < edges.length; e++) {
        if (edgeBudget <= 0) break;           // draw-on: remaining edges trace in next frames
        edgeBudget--;
        const a = edges[e][0];
        const b = edges[e][1];
        if (a >= proj.length || b >= proj.length) continue;
        const avgZ = (proj[a][2] + proj[b][2]) * 0.5;
        // avgZ ~∈ [-1, 1] for unit-radius shapes. Map → depthT ∈ [0, 1].
        // depthT=0 at camera-side (front), depthT=1 at far side (back).
        const depthT = Math.max(0, Math.min(1, (avgZ + 1) * 0.5));
        // Smooth fade: front=1.0, back=0.25. No hard threshold → no flicker.
        const depthFade = 1 - depthT * 0.75;
        ctx.globalAlpha = baseAlpha * depthFade;
        ctx.beginPath();
        ctx.moveTo(proj[a][0], proj[a][1]);
        ctx.lineTo(proj[b][0], proj[b][1]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // --- Info readout ---
    this._renderInfoText(ctx);
  }

  /**
   * Draw zone info (if selected) or general target/ADR info below the wireframe.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   */
  _renderInfoText(ctx) {
    const infoY = 140;
    ctx.textAlign = 'center';

    // --- ADR Satellite self-view info ---
    if (this._showingADR) {
      if (this._zoneIndex >= 0 && this._shape) {
        const zone = this._shape.zones[this._zoneIndex];
        const { color } = this._zoneAssessments[this._zoneIndex];
        ctx.font = "bold 11px 'Courier New', monospace";
        ctx.fillStyle = color;
        ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillStyle = DIM_COLOR;
        ctx.fillText(`${zone.massPercent}% of satellite`, WIRE_CX, infoY + 12);
      } else {
        // Show arm status summary
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillStyle = DIM_COLOR;
        const arms = this._armStatuses;
        if (arms.length > 0) {
          let armStr = '';
          for (const a of arms) {
            const prefix = a.type === 'weaver' ? 'W' : 'S';
            const idx = a.id.split('-')[1] || '?';
            const stateChar = a.state === 'DOCKED' ? '\u25CF' :
                              a.state === 'EXPENDED' ? '\u2715' : '\u25D0';
            const stateColor = a.state === 'DOCKED' ? '#00ff88' :
                               a.state === 'EXPENDED' ? '#ff4444' : '#ffaa00';
            armStr += `<${stateColor}>${prefix}${idx}${stateChar} `;
          }
          // Draw arm status as colored indicators
          let armX = 30;
          for (const a of arms) {
            const prefix = a.type === 'weaver' ? 'W' : 'S';
            const idx = a.id.split('-')[1] || '?';
            const icon = a.state === 'DOCKED' ? '\u25CF' :
                         a.state === 'EXPENDED' ? '\u2715' : '\u25D0';
            ctx.fillStyle = a.state === 'DOCKED' ? '#00ff88' :
                            a.state === 'EXPENDED' ? '#ff4444' : '#ffaa00';
            ctx.fillText(`${prefix}${idx}${icon}`, armX, infoY);
            armX += 40;
          }
        }
        ctx.fillStyle = DIM_COLOR;
        ctx.textAlign = 'center';
        ctx.fillText('[Z] Cycle zones', WIRE_CX, infoY + 16);
      }
      return;
    }

    // --- Debris target info — dossier-tier gated (Phase 1.5) ---
    const tier = dossierSystem.getTier(this._target);
    if (tier === DOSSIER_TIERS.SCANNED) {
      this._renderScannedInfo(ctx, infoY);
      return;
    }

    // PROFILED — full structural + salvage knowledge.
    if (this._zoneIndex >= 0 && this._shape) {
      const zone = this._shape.zones[this._zoneIndex];
      const { risk, color } = this._zoneAssessments[this._zoneIndex];
      const rec = getRecommendation(zone.name, this._target);

      ctx.font = "bold 11px 'Courier New', monospace";
      ctx.fillStyle = color;
      ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);

      ctx.font = "10px 'Courier New', monospace";
      ctx.fillStyle = color;
      ctx.fillText(`Risk: ${risk}  Mass: ${zone.massPercent}%`, WIRE_CX, infoY + 12);

      // Recommendation (compact)
      ctx.fillStyle = INFO_COLOR;
      this._wrapText(ctx, rec, WIRE_CX, infoY + 24, PANEL_WIDTH - 20, 10);

      // Salvage info below recommendation
      this._renderSalvageInfo(ctx, infoY + 46);
    } else {
      // General target info (compact)
      const t = this._target;
      ctx.font = "10px 'Courier New', monospace";
      ctx.fillStyle = DIM_COLOR;

      const label = TYPE_LABELS[t.type] || t.type;
      const massStr = t.mass != null ? `${t.mass.toFixed(1)}kg` : '?';
      const sizeStr = t.sizeMeter != null ? `${t.sizeMeter.toFixed(1)}m` : '?';
      const tumbleDeg = ((t.tumbleRate || 0) * DEG).toFixed(1);

      ctx.fillText(`${label}  ${massStr}  ${sizeStr}`, WIRE_CX, infoY);

      // Material readout with a friendly name + colour swatch so the panel
      // communicates the field's new material variety at a glance.
      const matKey = t.material;
      const matName = MATERIAL_LABELS[matKey] || matKey || '?';
      const tumbleLine = `Tumble: ${tumbleDeg}\u00B0/s   Mat: ${matName}`;
      ctx.fillText(tumbleLine, WIRE_CX, infoY + 12);
      const swatchColor = MATERIAL_SWATCH[matKey];
      if (swatchColor && typeof ctx.measureText === 'function') {
        // Place a small swatch just left of the material name. Measure so it
        // sits next to "Mat: " regardless of the tumble value width.
        ctx.save();
        const prevAlign = ctx.textAlign;
        const fullW = ctx.measureText(tumbleLine).width;
        const nameW = ctx.measureText(matName).width;
        const swX = WIRE_CX + fullW / 2 - nameW - 9;
        ctx.fillStyle = swatchColor;
        ctx.fillRect(swX, infoY + 6, 6, 6);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(swX, infoY + 6, 6, 6);
        ctx.textAlign = prevAlign;
        ctx.restore();
        ctx.fillStyle = DIM_COLOR;
      }

      // Stacked info rows — track y so HIGH TUMBLE, brittleness and the
      // manifest never overdraw each other (M4).
      let rowY = infoY + 24;

      // High-tumble warning
      if ((t.tumbleRate || 0) * DEG > 60) {
        ctx.fillStyle = ZONE_COLORS.RED;
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.fillText('\u26A0 HIGH TUMBLE', WIRE_CX, rowY);
        rowY += 12;
      }

      // Brittleness — the FRAG-chip driver. Show the RAW brittleness the
      // fragmentation roll uses (resolveFragSeverity / effectiveFragility),
      // NOT the material-adjusted effectiveBrittleness (zone-risk only), so
      // the displayed number can't drift from what's actually rolled.
      if (t.brittleness != null) {
        const b = Math.max(0, Math.min(1, t.brittleness));
        ctx.font = "10px 'Courier New', monospace";
        ctx.fillStyle = b >= 0.7 ? ZONE_COLORS.RED : b >= 0.4 ? ZONE_COLORS.YELLOW : ZONE_COLORS.GREEN;
        ctx.fillText(`Brittleness: ${b.toFixed(2)}`, WIRE_CX, rowY);
        rowY += 12;
      }

      // Decrypted salvage manifest with credit values (typewriter reveal).
      this._renderProfiledManifest(ctx, Math.max(rowY, infoY + 36));
    }
  }

  /**
   * @private UNSCANNED — static noise in the wireframe area (no data leaks).
   */
  _renderStaticNoise(ctx) {
    const seed = Math.floor((typeof performance !== 'undefined' ? performance.now() : 0) / 90);
    const rand = (i) => {
      const v = Math.abs(Math.sin(seed * 31.7 + i * 127.1) * 43758.5453);
      return v - Math.floor(v);
    };
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 50; i++) {
      const x = 30 + rand(i) * (PANEL_WIDTH - 60);
      const y = 36 + rand(i + 100) * 90;
      const len = 2 + rand(i + 200) * 10;
      ctx.globalAlpha = 0.1 + rand(i + 300) * 0.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * @private SCANNED — silhouette + type/size/est-mass; salvage manifest shows
   * REDACTED rows (you can see THAT there's treasure, not WHAT). The survey
   * ring fills while a platform holds within DETAIL_SCAN_RANGE_M.
   */
  _renderScannedInfo(ctx, infoY) {
    const t = this._target;
    const D = Constants.DOSSIER || {};
    ctx.font = "10px 'Courier New', monospace";
    ctx.fillStyle = DIM_COLOR;
    ctx.textAlign = 'center';

    const label = TYPE_LABELS[t.type] || t.type;
    const massStr = t.mass != null ? `~${t.mass.toFixed(0)}kg` : '?';
    const sizeStr = t.sizeMeter != null ? `${t.sizeMeter.toFixed(1)}m` : '?';
    ctx.fillText(`${label}  ${massStr}  ${sizeStr}`, WIRE_CX, infoY);
    const tumbleDeg = ((t.tumbleRate || 0) * DEG).toFixed(1);
    ctx.fillText(`Tumble: ${tumbleDeg}\u00B0/s   Mat: \u2588\u2588\u2588\u2588`, WIRE_CX, infoY + 12);

    // Redacted manifest — one ▓-row per real salvage line.
    let y = infoY + 24;
    if (t.hasSalvage && t.salvage) {
      const { rows } = appraiseSalvage(t.salvage);
      const n = Math.max(1, Math.min(3, rows.length || 1));
      ctx.fillStyle = '#ffcc00';
      ctx.font = "bold 10px 'Courier New', monospace";
      ctx.fillText('\u26CF METALS \u2014 UNKNOWN', WIRE_CX, y);
      y += 12;
      ctx.font = "10px 'Courier New', monospace";
      ctx.fillStyle = 'rgba(255, 204, 0, 0.4)';
      for (let i = 0; i < n; i++) {
        ctx.fillText('\u2593\u2593\u2593\u2593\u2593  \u2593\u2593 kg   \u00B7\u20B9\u2593\u2593\u2593', WIRE_CX, y);
        y += 11;
      }
    }

    // Survey progress ring (top-right of the wireframe) + prompt line.
    const progress = dossierSystem.getSurveyProgress(t.id);
    if (progress > 0) {
      const rx = PANEL_WIDTH - 26;
      const ry = 42;
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.25)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(rx, ry, 10, 0, TWO_PI);
      ctx.stroke();
      ctx.strokeStyle = '#00ffaa';
      ctx.beginPath();
      ctx.arc(rx, ry, 10, -Math.PI / 2, -Math.PI / 2 + TWO_PI * progress);
      ctx.stroke();
      ctx.font = "bold 10px 'Courier New', monospace";
      ctx.fillStyle = '#00ffaa';
      ctx.fillText(`SURVEYING ${Math.round(progress * 100)}%`, WIRE_CX, y + 2);
    } else {
      ctx.font = "10px 'Courier New', monospace";
      ctx.fillStyle = DIM_COLOR;
      ctx.fillText(`close to ${D.DETAIL_SCAN_RANGE_M || 50}m to survey`, WIRE_CX, y + 2);
    }
  }

  /**
   * @private PROFILED — the decrypted salvage manifest with credit values,
   * revealed line-by-line (typewriter) right after the survey completes.
   */
  _renderProfiledManifest(ctx, y) {
    const t = this._target;
    if (!t.hasSalvage || !t.salvage) return;
    const D = Constants.DOSSIER || {};
    const { rows, total } = appraiseSalvage(t.salvage);
    if (rows.length === 0) return;

    // Typewriter: rows appear one per PROFILE_ROW_INTERVAL_S after the survey;
    // targets profiled earlier (re-selected) show everything at once.
    let rowsShown = rows.length + 1;
    if (this._profileRevealStart != null && typeof performance !== 'undefined') {
      const interval = (D.PROFILE_ROW_INTERVAL_S || 0.35) * 1000;
      rowsShown = Math.floor((performance.now() - this._profileRevealStart) / interval);
      // Plan 1.5: soft chime per newly-revealed row (typewriter only — a
      // re-selected, already-profiled target shows everything silently).
      if (rowsShown > this._lastRowsShown && this._lastRowsShown < rows.length + 1) {
        audioSystem.playTerminalBlip();
      }
    }
    this._lastRowsShown = rowsShown;

    ctx.font = "bold 10px 'Courier New', monospace";
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffcc00';
    ctx.fillText('\u26CF SALVAGE MANIFEST', WIRE_CX, y);
    y += 12;
    ctx.font = "10px 'Courier New', monospace";
    const maxRows = Math.min(3, rows.length);
    for (let i = 0; i < maxRows && i < rowsShown; i++) {
      ctx.fillStyle = '#00ccff';
      ctx.fillText(`${rows[i].label}  \u00B7\u20B9${rows[i].value}`, WIRE_CX, y);
      y += 11;
    }
    if (rowsShown > maxRows) {
      ctx.font = "bold 10px 'Courier New', monospace";
      ctx.fillStyle = '#00ffaa';
      const extra = rows.length > maxRows ? ` (+${rows.length - maxRows} more)` : '';
      ctx.fillText(`EST. VALUE \u20B9${total}${extra}`, WIRE_CX, y);
    }
  }

  /**
   * Render salvage indicators below the zone/target info.
   * Shows ⛏ SALVAGE DETECTED with resource types when applicable.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} y - starting Y position
   */
  _renderSalvageInfo(ctx, y) {
    if (!this._target || !this._target.hasSalvage) return;
    const salvage = this._target.salvage;
    if (!salvage) return;

    // Determine what to show based on scanner upgrade
    const hasScanner = this._hasSalvageScanner;

    ctx.font = "bold 10px 'Courier New', monospace";
    ctx.textAlign = 'center';

    // Separator line
    ctx.fillStyle = SEPARATOR_COLOR;
    ctx.fillText('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', WIRE_CX, y);

    ctx.fillStyle = '#ffcc00';
    ctx.fillText('\u26CF SALVAGE DETECTED', WIRE_CX, y + 12);

    ctx.font = "10px 'Courier New', monospace";
    let infoY = y + 24;

    if (hasScanner) {
      // Exact amounts shown with scanner upgrade
      if (salvage.xenon > 0) {
        ctx.fillStyle = '#00ccff';
        ctx.fillText(`Xe: ~${salvage.xenon.toFixed(1)} kg (ion fuel)`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.indium > 0) {
        ctx.fillStyle = '#cc88ff';
        ctx.fillText(`In: ~${(salvage.indium * 1000).toFixed(0)} g (FEEP fuel)`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.gaAs > 0) {
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(`GaAs: ${(salvage.gaAs * 100).toFixed(1)}% panel repair`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.battery > 0) {
        ctx.fillStyle = '#88ff88';
        ctx.fillText(`\u26A1 ${salvage.battery.toFixed(0)} Wh charge`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.hydrazine > 0) {
        ctx.fillStyle = '#ff4444';
        ctx.fillText(`\u26A0 N\u2082H\u2084: ${salvage.hydrazine.toFixed(1)} kg (HAZMAT)`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.lithium > 0) {
        ctx.fillStyle = '#88ccff';
        ctx.fillText(`Li: ~${salvage.lithium.toFixed(1)} units (MPD fuel)`, WIRE_CX, infoY);
      }
    } else {
      // Without scanner: show type hints only
      const hints = [];
      if (salvage.xenon > 0) hints.push('Xe');
      if (salvage.indium > 0) hints.push('In');
      if (salvage.gaAs > 0) hints.push('\u2600');
      if (salvage.battery > 0) hints.push('\u26A1');
      if (salvage.hydrazine > 0) hints.push('\u26A0N\u2082H\u2084');
      if (salvage.lithium > 0) hints.push('Li');
      ctx.fillStyle = DIM_COLOR;
      ctx.fillText(`Scan for details: ${hints.join(' ')}`, WIRE_CX, infoY);
    }
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Switch to ADR satellite self-view mode.
   * @private
   */
  _showADRSatellite() {
    this._showingADR = true;
    this._target = null;
    this._shape = SHAPES.adrSatellite;
    this._zoneIndex = -1;
    this._assessed = false;
    this._viewedZones.clear();
    this._angle = 0;

    if (this._shape) {
      this._allocateProjectionBuffer(this._shape.vertices.length);
      // ADR satellite zones: all green by default
      this._zoneAssessments = this._shape.zones.map((zone) => {
        if (zone.name === 'Daughter Cavities') return { risk: 'DYNAMIC', color: '#00ff88' };
        if (zone.name === 'Ion Drive') return { risk: 'LOW', color: '#00ccff' };
        if (zone.name === 'Laser') return { risk: 'LOW', color: '#00ccff' };
        return { risk: 'LOW', color: ZONE_COLORS.GREEN };
      });
    }
    this.setVisible(true);
  }

  /**
   * Pre-allocate or resize the projection buffer.
   * @private
   * @param {number} len - number of vertices
   */
  _allocateProjectionBuffer(len) {
    if (this._projected.length !== len) {
      this._projected = new Array(len);
      // [sx, sy, rotZ] — rotZ enables back-edge depth dimming in _render
      for (let i = 0; i < len; i++) this._projected[i] = [0, 0, 0];
    }
  }

  /**
   * Draw word-wrapped centered text.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} cx - center X
   * @param {number} y  - starting Y
   * @param {number} maxW - maximum pixel width
   * @param {number} lineH - line height in px
   */
  _wrapText(ctx, text, cx, y, maxW, lineH) {
    const words = text.split(' ');
    let line = '';
    let curY = y;

    for (let i = 0; i < words.length; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, cx, curY);
        line = words[i];
        curY += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, cx, curY);
  }
}

// ============================================================================
// STATIC ATLAS MANAGEMENT (ST-6.2)
// ============================================================================

/** @type {DebrisTextureAtlas|null} Shared type atlas instance */
let _typeAtlas = null;
/** @type {FlagDecalSystem|null} Shared flag atlas instance */
let _flagSystem = null;
/** @type {string} Current visual mode — 'textured' or 'wireframe' */
let _visualMode = (Constants.DEBRIS_VISUAL && Constants.DEBRIS_VISUAL.DEFAULT_MODE) || 'textured';

/**
 * Pick atlas dimensions for the current device.
 *
 * The DEBRIS_VISUAL constants are the HIGH-end target (2048 type / 1024 flag).
 * On low-end GPUs/RAM a 2048² RGBA atlas (~16 MB) + flag atlas is wasteful and
 * can fail to allocate, so clamp against two signals:
 *   • GPU MAX_TEXTURE_SIZE — a hard limit; never request a larger atlas.
 *   • navigator.deviceMemory — Chrome/Edge only; ≤4 GB → halve the atlases.
 * Both signals are optional; when unknown we keep the configured (HIGH) sizes,
 * matching the conservative "unknown = capable desktop" stance used elsewhere
 * (see scene/Earth.js selectLOD).
 *
 * @param {object} C - Constants.DEBRIS_VISUAL
 * @returns {{ atlasSize: number, flagSize: number }}
 * @private
 */
function _pickAtlasSizes(C) {
  const cfgAtlas = C.ATLAS_SIZE || 1024;
  const cfgFlag  = C.FLAG_ATLAS_SIZE || 512;

  let maxTex = Infinity;
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (gl) maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || Infinity;
  } catch (_) { /* headless / no WebGL — keep configured sizes */ }

  const memGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || undefined;
  const lowMem = memGB !== undefined && memGB <= 4;
  // Halve on low memory; one extra halving step is enough (4096→2048→1024 etc.).
  const scale = lowMem ? 0.5 : 1;

  // Clamp to GPU limit AND apply the memory scale, but never below a usable floor.
  const atlasSize = Math.max(512,  Math.min(cfgAtlas, maxTex) * scale);
  const flagSize  = Math.max(256,  Math.min(cfgFlag,  maxTex) * scale);
  return { atlasSize, flagSize };
}

/**
 * Initialise the type and flag texture atlases. Called once at boot by DebrisField.
 * No-op if already initialised or if DOM is unavailable (Node tests).
 */
export function initAtlases() {
  if (typeof document === 'undefined') return;
  if (_typeAtlas) return; // already initialised
  const C = Constants.DEBRIS_VISUAL || {};
  const { atlasSize, flagSize } = _pickAtlasSizes(C);
  _typeAtlas = new DebrisTextureAtlas(atlasSize);
  _flagSystem = new FlagDecalSystem(flagSize);
  _typeAtlas.generate();
  _flagSystem.generate();
}

/** @returns {THREE.CanvasTexture|null} The debris type atlas texture */
export function getTypeAtlasTexture() { return _typeAtlas ? _typeAtlas.texture : null; }

/** @returns {THREE.CanvasTexture|null} The flag decal atlas texture */
export function getFlagAtlasTexture() { return _flagSystem ? _flagSystem.texture : null; }

/** @returns {DebrisTextureAtlas|null} */
export function getTypeAtlas() { return _typeAtlas; }

/** @returns {FlagDecalSystem|null} */
export function getFlagSystem() { return _flagSystem; }

/** @returns {string} 'textured' or 'wireframe' */
export function getVisualMode() { return _visualMode; }

/**
 * Toggle or set the visual mode.
 * @param {string} [mode] — 'textured' | 'wireframe'. If omitted, toggles.
 * @returns {string} The new mode
 */
export function setVisualMode(mode) {
  if (mode) {
    _visualMode = mode;
  } else {
    _visualMode = _visualMode === 'textured' ? 'wireframe' : 'textured';
  }
  return _visualMode;
}

/** Release atlas resources */
export function disposeAtlases() {
  if (_typeAtlas) { _typeAtlas.dispose(); _typeAtlas = null; }
  if (_flagSystem) { _flagSystem.dispose(); _flagSystem = null; }
}

// Re-export atlas pure-logic helpers for convenience
export { getUVOffsetForType, getBaseColorForType, getEmissiveForMOID };
export { getUVOffsetForCountry, hasFlag };

// Export builder functions for testing (pure data, no THREE dependency)
export { buildRocketBody, buildDefunctSat, buildMissionDebris, buildFragment };

// Named + default export (matches NavSphere / OrbitMFD pattern)
export default DebrisWireframe;
