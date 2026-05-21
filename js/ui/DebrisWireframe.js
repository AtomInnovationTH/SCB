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

// ============================================================================
// CONFIGURATION
// ============================================================================

const PANEL_WIDTH = 280;              // px — match right column & NavSphere width
const PANEL_HEIGHT = 200;             // px — tight: wireframe + essential info text only
const PANEL_MARGIN_RIGHT = 10;        // px from right edge (align with targets panel)
const PANEL_MARGIN_BOTTOM = 140;      // px from bottom edge (fallback when no container)
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
      { name: 'Arm Cavities', edges: dockEdges,   massPercent: 18 },
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
 * Uses LatheGeometry with the wireframe silhouette profile (R=0.30, tapered).
 * @returns {THREE.BufferGeometry}
 */
function _buildRocketBodyGeo() {
  // Profile matches wireframe: nosecone tip → body → nozzle bell → exit
  const profile = [
    new THREE.Vector2(0.001, 0.50),    // nosecone tip (avoid zero-radius)
    new THREE.Vector2(0.30,  0.35),    // nosecone base
    new THREE.Vector2(0.30, -0.25),    // fuel-tank bottom
    new THREE.Vector2(0.30, -0.50),    // engine bottom
    new THREE.Vector2(0.42, -0.58),    // nozzle bell (wider)
    new THREE.Vector2(0.001, -0.65),   // nozzle exit
  ];
  const geo = new THREE.LatheGeometry(profile, 8);
  // Normalize: old CylinderGeometry(0.3,0.3,2.0) had bounding radius ~1.04;
  // this LatheGeometry has ~0.71 → scale 1.5× to match scene-size convention
  geo.scale(1.5, 1.5, 1.5);
  return geo;
}

/**
 * Build a THREE.BufferGeometry for a defunct satellite type.
 * Box bus with solar-panel wing stubs — merged geometry.
 * @returns {THREE.BufferGeometry}
 */
function _buildDefunctSatGeo() {
  // Bus body (matches wireframe bx=0.20, by=0.15, bz=0.15)
  const body = new THREE.BoxGeometry(0.40, 0.30, 0.30, 1, 1, 1);

  // Solar panels (thin flat extensions)
  const wingL = new THREE.BoxGeometry(0.40, 0.16, 0.02, 1, 1, 1);
  wingL.translate(-0.40, 0, 0);
  const wingR = new THREE.BoxGeometry(0.40, 0.16, 0.02, 1, 1, 1);
  wingR.translate(0.40, 0, 0);

  // Antenna mast (small cone on top)
  const antenna = new THREE.ConeGeometry(0.10, 0.13, 6);
  antenna.translate(0, 0.215, 0);

  const geo = _mergeGeometries([body, wingL, wingR, antenna]);
  // Normalize: old BoxGeometry(1.5,0.5,1.0) had bounding radius ~0.94;
  // merged geo has ~0.64 → scale 1.5× to match scene-size convention
  geo.scale(1.5, 1.5, 1.5);
  return geo;
}

/**
 * Build a THREE.BufferGeometry for mission debris type.
 * Hexagonal prism with attachment ring (matches wireframe N=6, R=0.28, halfH=0.22).
 * @returns {THREE.BufferGeometry}
 */
function _buildMissionDebrisGeo() {
  // Main hexagonal prism
  const prism = new THREE.CylinderGeometry(0.28, 0.28, 0.44, 6);

  // Attachment ring (torus around the midsection)
  const ring = new THREE.TorusGeometry(0.34, 0.03, 4, 6);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, -0.02, 0);

  const geo = _mergeGeometries([prism, ring]);
  // Normalize: old SphereGeometry(1) had bounding radius 1.0;
  // hex prism+ring has ~0.43 → scale 2.3× to match scene-size convention
  geo.scale(2.3, 2.3, 2.3);
  return geo;
}

/**
 * Build a THREE.BufferGeometry for a fragment type with per-ID variation.
 * Uses IcosahedronGeometry with deterministic vertex displacement.
 * @param {number} variantIndex - Variant index (0..DEBRIS_FRAGMENT_VARIANTS-1)
 * @returns {THREE.BufferGeometry}
 */
function _buildFragmentGeo(variantIndex) {
  // Detail 2 = 320 faces — smooth enough to read as lumpy, not spiky
  const detail = 2;
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;

  // Deterministic displacement seeded by variant index
  const seed = ((variantIndex + 1) >>> 0) * 2654435761;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;

    // Deterministic pseudo-random per vertex+variant
    const hash = Math.abs(Math.sin(seed + i * 127.1) * 43758.5453);
    const displacement = 0.85 + (hash - Math.floor(hash)) * 0.3;

    pos.setXYZ(i, (x / len) * displacement, (y / len) * displacement, (z / len) * displacement);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
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

    _geoCache.set(cacheKey, geo);
    return geo;
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
    } else {
      // Legacy fixed positioning (fallback)
      Object.assign(this._canvas.style, {
        position: 'fixed',
        bottom: `${PANEL_MARGIN_BOTTOM}px`,
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
    // Need either a target OR ADR self-view mode
    if (!this._target && !this._showingADR) return;

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
    this._canvas.style.display = visible ? 'block' : 'none';
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
      ctx.fillText('TARGET ANALYSIS [Z]', WIRE_CX, 15);
      const typeLabel = TYPE_LABELS[this._target.type] || this._target.type;
      ctx.font = "12px 'Courier New', monospace";
      ctx.fillStyle = TYPE_COLOR;
      ctx.fillText(typeLabel, WIRE_CX, 27);
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

    // --- Debris target info ---
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
      ctx.fillText(`Tumble: ${tumbleDeg}\u00B0/s  Mat: ${t.material || '?'}`, WIRE_CX, infoY + 12);

      // High-tumble warning
      if ((t.tumbleRate || 0) * DEG > 60) {
        ctx.fillStyle = ZONE_COLORS.RED;
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.fillText('\u26A0 HIGH TUMBLE', WIRE_CX, infoY + 24);
      }

      // Salvage info
      this._renderSalvageInfo(ctx, infoY + 36);
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
        if (zone.name === 'Arm Cavities') return { risk: 'DYNAMIC', color: '#00ff88' };
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
 * Initialise the type and flag texture atlases. Called once at boot by DebrisField.
 * No-op if already initialised or if DOM is unavailable (Node tests).
 */
export function initAtlases() {
  if (typeof document === 'undefined') return;
  if (_typeAtlas) return; // already initialised
  const C = Constants.DEBRIS_VISUAL || {};
  _typeAtlas = new DebrisTextureAtlas(C.ATLAS_SIZE);
  _flagSystem = new FlagDecalSystem(C.FLAG_ATLAS_SIZE);
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
