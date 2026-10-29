/**
 * DebrisWireframe.js — Canvas2D wireframe panel for the selected debris target: zone colours and approach
 * recommendations. Simple perspective projection, no Three.js renderer.
 *
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { DebrisTextureAtlas, getUVOffsetForType, getBaseColorForType, getEmissiveForMOID } from './DebrisTextureAtlas.js';
import { FlagDecalSystem, getUVOffsetForCountry, hasFlag } from './FlagDecalSystem.js';
import { salvageGasKg } from '../systems/ResourceSystem.js';
import { dossierSystem, DossierSystem, DOSSIER_TIERS, appraiseSalvage, inspectStepLines } from '../systems/DossierSystem.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { mono } from '../core/Typeface.js';
import { currentHudScale } from './HudScale.js';
import { GestureHints } from './hud/GestureHints.js';
import { RAD2DEG, degToRad, clamp01, clamp } from '../core/MathUtil.js';
import { VisualLaw } from '../core/VisualLaw.js';

const PANEL_WIDTH = 280;              // px — match right column & NavSphere width
const PANEL_HEIGHT = 200;             // px — tight: wireframe + essential info text only
const PANEL_MARGIN_RIGHT = 10;        // px from right edge (align with targets panel)
// Fallback anchor (no container): top-right below the NavSphere (446px = 160 margin + 280 NavSphere diameter + 6 gap).
const PANEL_MARGIN_TOP = 446;         // px from top edge (fallback when no container)
const BG_COLOR = `rgba(0, 10, 25, ${Constants.WIREFRAME_BG_ALPHA})`;
const BORDER_COLOR = 'rgba(0, 255, 136, 0.3)';
const Z_INDEX = 12;

const PERSPECTIVE_D = 3.0;            // perspective distance parameter
const VIEW_SCALE = 280;               // maps 3D units → canvas pixels (fills 280px width better)
const TILT_X = degToRad(15);   // fixed 15° X-axis tilt
const WIRE_CX = PANEL_WIDTH / 2;      // wireframe center X (140)
const WIRE_CY = 72;                   // wireframe center Y (tight for 200px panel)

const MIN_TUMBLE_RATE = 0.1;          // rad/s minimum visual rotation

const TWO_PI = Math.PI * 2;
const SEGMENTS = 8;                   // vertices per ring/circle

const ZONE_COLORS = {
  GREEN:  VisualLaw.COLORS.PLAYER,
  YELLOW: '#ffcc00',
  RED:    '#ff4444',
};

const HEADER_COLOR = 'rgba(0, 255, 136, 0.7)';
const TYPE_COLOR = VisualLaw.COLORS.INFO;
const INFO_COLOR = VisualLaw.COLORS.PLAYER;
const DIM_COLOR = 'rgba(0, 255, 136, 0.5)';
const SEPARATOR_COLOR = 'rgba(0, 255, 136, 0.3)';

const TYPE_LABELS = {
  rocketBody:    'ROCKET BODY',
  defunctSat:    'DEFUNCT SATELLITE',
  missionDebris: 'MISSION DEBRIS',
  fragment:      'FRAGMENT',
  cubesat:       'CUBESAT',
};

// Material names + swatch colours for the inspection readout.
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

// Wireframe shapes: built once at module load (fragment is built per target).

/** Ring of SEGMENTS vertices at height y, radius r → [x, y, z][]. */
function makeRing(y, r) {
  const verts = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * TWO_PI;
    verts.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return verts;
}

// Rocket Body: cylinder + nosecone + nozzle
// Total height normalized ~1.0. Body ring radius R = 0.30 (diameter 0.60).
// Y range: -0.65 (nozzle tip) to +0.5 (nosecone tip)
// Zones: Nosecone top 15%, Fuel Tank middle 60%, Engine bottom 25%
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

  const noseconeEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    noseconeEdges.push([0, 1 + i]);
    noseconeEdges.push([1 + i, 1 + ((i + 1) % SEGMENTS)]);
  }

  const fuelTankEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    fuelTankEdges.push([1 + i, 9 + i]);
    fuelTankEdges.push([9 + i, 9 + ((i + 1) % SEGMENTS)]);
  }

  const engineEdges = [];
  for (let i = 0; i < SEGMENTS; i++) {
    engineEdges.push([9 + i, 17 + i]);
    engineEdges.push([17 + i, 17 + ((i + 1) % SEGMENTS)]);
    engineEdges.push([17 + i, 25 + i]);
    engineEdges.push([25 + i, 25 + ((i + 1) % SEGMENTS)]);
  }
  for (let i = 0; i < SEGMENTS; i += 2) {
    engineEdges.push([25 + i, 33]);
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

function buildDefunctSat() {
  const bx = 0.20, by = 0.15, bz = 0.15;

  // Bus box vertices (0–7)
  const busVerts = [
    [-bx, -by, -bz], [ bx, -by, -bz], [ bx,  by, -bz], [-bx,  by, -bz],
    [-bx, -by,  bz], [ bx, -by,  bz], [ bx,  by,  bz], [-bx,  by,  bz],
  ];
  const busEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  // Solar Panel L — extends left (8–11)
  const py = 0.08;
  const panelLVerts = [
    [-bx,     -py, 0], [-0.60, -py, 0],
    [-0.60,    py, 0], [-bx,    py, 0],
  ];
  const panelLEdges = [
    [8, 9], [9, 10], [10, 11], [11, 8],
    [8, 10], [9, 11],
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
    antennaEdges.push([17 + i, 17 + ((i + 1) % 6)]);
    antennaEdges.push([16, 17 + i]);
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
    primaryEdges.push([i, (i + 1) % N]);
    primaryEdges.push([N + i, N + ((i + 1) % N)]);
    primaryEdges.push([i, N + i]);
  }

  // Attachment ring: slightly larger, at midplane (12–17)
  const ringY = -0.02;
  const ringR = 0.34;
  const ringVerts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TWO_PI + 0.12;
    ringVerts.push([ringR * Math.cos(a), ringY, ringR * Math.sin(a)]);
  }

  const attachEdges = [];
  for (let i = 0; i < N; i++) {
    attachEdges.push([12 + i, 12 + ((i + 1) % N)]);
    attachEdges.push([12 + i, i]);
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

/** Fragment wireframe, deterministic from the debris ID (built per target). */
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

// ADR satellite (octopus): octagonal bus, solar wings, 6 dock cavities, ion nozzle, laser aperture; default when no target.
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
    busEdges.push([i, (i + 1) % 8]);
    busEdges.push([8 + i, 8 + ((i + 1) % 8)]);
    busEdges.push([i, 8 + i]);
  }

  // Solar panel wings — left and right (16–23)
  const py = 0.05;
  const panelLVerts = [
    [-R, -py, 0], [-0.55, -py, 0], [-0.55, py, 0], [-R, py, 0],  // 16–19
  ];
  const panelLEdges = [
    [16, 17], [17, 18], [18, 19], [19, 16],
    [16, 18], [17, 19],
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
    dockVerts.push([cx + ds, busH + 0.01, cz]);
    dockVerts.push([cx - ds, busH + 0.01, cz]);
    dockEdges.push([base, base + 1]);
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
    nozzleEdges.push([36 + i, 36 + ((i + 1) % 8)]);
    nozzleEdges.push([8 + i, 36 + i]);
  }
  for (let i = 0; i < 8; i += 2) {
    nozzleEdges.push([36 + i, 44]);
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

function buildCubesat() {
  const bx = 0.17, by = 0.17, bz = 0.23;

  // Bus box vertices (0–7)
  const busVerts = [
    [-bx, -by, -bz], [ bx, -by, -bz], [ bx,  by, -bz], [-bx,  by, -bz],
    [-bx, -by,  bz], [ bx, -by,  bz], [ bx,  by,  bz], [-bx,  by,  bz],
  ];
  const busEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  // Deployed panel L (8–11) and R (12–15), thin quads off ±X near back.
  const py = 0.11, pw = 0.13;
  const panelLVerts = [
    [-bx,       -py, bz - 0.02], [-bx - pw, -py, bz - 0.02],
    [-bx - pw,   py, bz - 0.02], [-bx,       py, bz - 0.02],
  ];
  const panelRVerts = [
    [ bx,       -py, bz - 0.02], [ bx + pw, -py, bz - 0.02],
    [ bx + pw,   py, bz - 0.02], [ bx,       py, bz - 0.02],
  ];
  const panelEdges = [
    [8, 9], [9, 10], [10, 11], [11, 8],
    [12, 13], [13, 14], [14, 15], [15, 12],
  ];

  const vertices = [...busVerts, ...panelLVerts, ...panelRVerts];

  return {
    vertices,
    zones: [
      { name: 'Bus',          edges: busEdges,   massPercent: 80 },
      { name: 'Solar Panels', edges: panelEdges, massPercent: 20 },
    ],
  };
}

const SHAPES = {
  rocketBody:    buildRocketBody(),
  defunctSat:    buildDefunctSat(),
  missionDebris: buildMissionDebris(),
  adrSatellite:  buildADRSatellite(),
  cubesat:       buildCubesat(),
};

/** @type {Map<string, THREE.BufferGeometry>} Cached geometries keyed by type (or fragment variant) */
const _geoCache = new Map();

/** @type {Map<string, number>} Local-space bounding radius per geometry type */
const _geoRadiusCache = new Map();
/** farthest vertex from the mesh ORIGIN (the instance origin: where the catch is pinned) per cache key, in mesh units */
const _geoOriginRadiusCache = new Map();

/** @type {Map<string, {x:number,y:number,z:number}>} Bounding-box half-extents per geometry */
const _geoHalfExtentCache = new Map();

/** @type {Map<string, {cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}>} True
 *  bounding-box centre + half-extents per geometry (balloon→fabric box floor). Distinct from
 *  `_geoHalfExtentCache`, which is symmetric max-abs for decals — several hulls are NOT centred
 *  on the origin (cubesat y is −0.322/+0.476), and symmetrising would inflate the wrap. */
const _geoBBoxCache = new Map();

/** Merge BufferGeometries (position, normal, uv; indexed or not) into one. */
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
 * Spent upper stage: tapered nose, ribbed tank, staging seam ring, deep open engine bell with an internal throat cone
 * (reads hollow up close).
 */
function _buildRocketBodyGeo() {
  const parts = [];

  const profile = [
    new THREE.Vector2(0.001, 0.52),
    new THREE.Vector2(0.16,  0.42),
    new THREE.Vector2(0.30,  0.30),
    new THREE.Vector2(0.30, -0.22),
    new THREE.Vector2(0.27, -0.30),
    new THREE.Vector2(0.30, -0.40),
    new THREE.Vector2(0.44, -0.52),
  ];
  const hull = new THREE.LatheGeometry(profile, 16);
  parts.push(hull);

  const throat = new THREE.ConeGeometry(0.10, 0.18, 14, 1, true);
  throat.translate(0, -0.40, 0);
  parts.push(throat);

  const seam = new THREE.TorusGeometry(0.305, 0.018, 6, 18);
  seam.rotateX(Math.PI / 2);
  seam.translate(0, -0.06, 0);
  parts.push(seam);

  for (const yb of [0.12, -0.16]) {
    const band = new THREE.TorusGeometry(0.305, 0.010, 5, 16);
    band.rotateX(Math.PI / 2);
    band.translate(0, yb, 0);
    parts.push(band);
  }

  const geo = _mergeGeometries(parts);
  // Raw build size; getGeometry normalises every mesh: longest bounding-box side = 1 mesh unit.
  return geo;
}

/**
 * Derelict satellite: multi-panel box bus with a beveled top, two segmented solar wings on booms, gimbaled dish,
 * whip antenna, thruster nozzle.
 */
function _buildDefunctSatGeo() {
  const parts = [];

  const body = new THREE.BoxGeometry(0.40, 0.34, 0.32);
  parts.push(body);
  const deck = new THREE.BoxGeometry(0.30, 0.06, 0.24);
  deck.translate(0, 0.20, 0);
  parts.push(deck);
  const adapter = new THREE.CylinderGeometry(0.10, 0.13, 0.08, 8);
  adapter.translate(0, -0.21, 0);
  parts.push(adapter);

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

  const gimbal = new THREE.CylinderGeometry(0.02, 0.02, 0.10, 6);
  gimbal.translate(0.10, 0.27, 0.10);
  parts.push(gimbal);
  const dish = new THREE.ConeGeometry(0.13, 0.10, 14, 1, true);
  dish.rotateX(Math.PI);          // open face up
  dish.translate(0.10, 0.36, 0.10);
  parts.push(dish);
  const feed = new THREE.ConeGeometry(0.015, 0.07, 4);
  feed.translate(0.10, 0.30, 0.10);
  parts.push(feed);

  const whip = new THREE.CylinderGeometry(0.006, 0.006, 0.22, 4);
  whip.translate(-0.13, 0.30, -0.10);
  parts.push(whip);

  const nozzle = new THREE.ConeGeometry(0.05, 0.08, 8, 1, true);
  nozzle.translate(-0.10, -0.24, -0.06);
  parts.push(nozzle);

  const geo = _mergeGeometries(parts);
  return geo;
}

/**
 * Discarded payload-adapter module: octagonal canister, recessed top hatch, clamp-band ring, mounting lugs,
 * stub connector.
 */
function _buildMissionDebrisGeo() {
  const parts = [];

  const can = new THREE.CylinderGeometry(0.28, 0.30, 0.42, 8);
  parts.push(can);

  const hatch = new THREE.CylinderGeometry(0.18, 0.18, 0.05, 8);
  hatch.translate(0, 0.225, 0);
  parts.push(hatch);
  const rim = new THREE.TorusGeometry(0.20, 0.02, 5, 8);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.21, 0);
  parts.push(rim);

  const band = new THREE.TorusGeometry(0.31, 0.035, 6, 8);
  band.rotateX(Math.PI / 2);
  band.translate(0, -0.04, 0);
  parts.push(band);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const lug = new THREE.BoxGeometry(0.06, 0.08, 0.04);
    lug.translate(Math.cos(a) * 0.31, -0.18, Math.sin(a) * 0.31);
    lug.rotateY(-a);
    parts.push(lug);
  }

  const stub = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 6);
  stub.rotateZ(Math.PI / 2);
  stub.translate(0.32, 0.05, 0);
  parts.push(stub);

  const geo = _mergeGeometries(parts);
  return geo;
}

/**
 * Cubesat (small intact microsat): panelled bus (~3U, long along Z), body-mounted solar faces, a deployed panel
 * wing each side, whip antenna, separation-ring adapter. Reads as INTACT, distinct from an irregular fragment.
 */
function _buildCubesatGeo() {
  const parts = [];

  const body = new THREE.BoxGeometry(0.34, 0.34, 0.46);
  parts.push(body);

  for (const side of [-1, 1]) {
    const cell = new THREE.BoxGeometry(0.015, 0.30, 0.42);
    cell.translate(side * 0.18, 0, 0);
    parts.push(cell);
  }

  for (const side of [-1, 1]) {
    const wing = new THREE.BoxGeometry(0.26, 0.22, 0.012);
    wing.translate(side * 0.33, 0, 0.24);
    parts.push(wing);
  }

  const whip = new THREE.CylinderGeometry(0.006, 0.006, 0.20, 4);
  whip.translate(0.08, 0.24, -0.12);
  parts.push(whip);

  const adapter = new THREE.CylinderGeometry(0.09, 0.11, 0.06, 8);
  adapter.translate(0, -0.20, 0);
  parts.push(adapter);

  const geo = _mergeGeometries(parts);
  return geo;
}

/** Deterministic hash → [0,1) for an integer seed. */
function _hash01(n) {
  const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Flat-shaded BufferGeometry from a triangle list: each triangle gets its own 3 vertices (sharp facets, no averaged
 * normals). verts: [x,y,z][], faces: [i,j,k][].
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
      const w = 0.5 + Math.asin(clamp(v[1] /
        (Math.hypot(v[0], v[1], v[2]) || 1), -1, 1)) / Math.PI;
      uvs.push(u, w);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/** Convex hull (triangle faces, index triples into `points`) of a small point cloud; no addon/CDN dependency. */
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
        if (nlen < EPS) continue;
        let pos = 0, neg = 0;
        for (let m = 0; m < n; m++) {
          if (m === i || m === j || m === k) continue;
          const d = dot(normal, sub(points[m], points[i]));
          if (d > EPS) pos++;
          else if (d < -EPS) neg++;
          if (pos && neg) break;
        }
        if (pos && neg) continue;
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
 * Fragment: sharp irregular faceted chunk, the convex hull of a deterministic point cloud distorted along its principal
 * axes; flat-shaded so facets catch the sun as it tumbles.
 * @param {number} variantIndex - 0..DEBRIS_FRAGMENT_VARIANTS-1
 */
function _buildFragmentGeo(variantIndex) {
  const seed = ((variantIndex + 1) >>> 0) * 2654435761 >>> 0;

  // Anisotropic stretch per variant → slab-like shards, splinters, blocky chunks
  const sx = 0.55 + _hash01(seed + 11) * 0.95;       // 0.55 .. 1.50
  const sy = 0.45 + _hash01(seed + 23) * 0.70;       // 0.45 .. 1.15
  const sz = 0.55 + _hash01(seed + 37) * 0.95;
  // Some variants are flat plate-like shards (panel fragments). DebrisWireframe.isPlateVariant is the single source of
  // truth (the welcome-field selector shares it); variantIndex is already reduced (% N) and isPlateVariant reduces
  // idempotently, so the seed matches.
  const plate = DebrisWireframe.isPlateVariant(variantIndex);
  const flat = plate ? 0.32 + _hash01(seed + 43) * 0.18 : 1.0;

  const NPTS = 14;
  const pts = [];
  for (let i = 0; i < NPTS; i++) {
    const t = (i + 0.5) / NPTS;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i + _hash01(seed + i * 7) * 1.3;
    let dx = Math.sin(phi) * Math.cos(theta);
    let dy = Math.cos(phi);
    let dz = Math.sin(phi) * Math.sin(theta);
    const r = 0.62 + _hash01(seed + i * 53 + 5) * 0.42;
    pts.push([dx * sx * r, dy * sy * flat * r, dz * sz * r]);
  }

  let faces = _convexHullFaces(pts);
  if (faces.length < 4) {
    // Degenerate fallback (shouldn't happen) → low-detail icosahedron
    return new THREE.IcosahedronGeometry(0.9, 1);
  }

  // Raw hull: `DebrisWireframe.getGeometry` is the one place that sizes it; a second normaliser here would fight it.
  return _buildFlatGeometry(pts, faces);
}

/**
 * Scale a freshly built geometry IN PLACE (uniformly) so its bounding box's longest side is exactly 1 mesh unit: the
 * one size rule of `DebrisWireframe.getGeometry`. Call it only on a geometry nobody else holds yet.
 */
function _normaliseLongestSideToOne(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const longest = b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 0;
  if (longest > 0 && Number.isFinite(longest)) geo.scale(1 / longest, 1 / longest, 1 / longest);
  return geo;
}

/**
 * Wireframe shape data for a debris type (pure data, no THREE dependency).
 * @param {string} type - 'rocketBody' | 'defunctSat' | 'missionDebris' | 'fragment'
 * @param {number} [id=0] - Debris ID (used for fragment variation)
 * @returns {{ vertices: number[][], zones: Array<{ name: string, edges: number[][], massPercent: number }> }}
 */
export function getWireframeData(type, id = 0) {
  if (type === 'fragment') return buildFragment(id);
  return SHAPES[type] || SHAPES.missionDebris;
}

/** Brittleness with material modifiers applied, clamped to [0, 1]. */
function effectiveBrittleness(target) {
  let b = target.brittleness || 0;
  if (target.material === 'composite') b += 0.1;
  if (target.material === 'titanium')  b -= 0.1;
  return clamp01(b);
}

/** Zone risk level and colour from zone type, effective brittleness and material. */
function assessZone(zoneName, target) {
  const b = effectiveBrittleness(target);
  const nameLower = zoneName.toLowerCase();

  // Engine zones → always red (hazardous propellant/pressure vessels)
  if (nameLower.includes('engine')) {
    return { risk: 'HIGH', color: ZONE_COLORS.RED };
  }

  if (nameLower.includes('solar panel')) {
    if (b > 0.7) return { risk: 'HIGH', color: ZONE_COLORS.RED };
    if (b > 0.3) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
    return { risk: 'LOW', color: ZONE_COLORS.GREEN };
  }

  if (target.type === 'fragment') {
    if (b > 0.5) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
    return { risk: 'LOW', color: ZONE_COLORS.GREEN };
  }

  if (b >= 0.7) return { risk: 'HIGH', color: ZONE_COLORS.RED };
  if (b >= 0.4) return { risk: 'MED',  color: ZONE_COLORS.YELLOW };
  return { risk: 'LOW', color: ZONE_COLORS.GREEN };
}

function getRecommendation(zoneName, target) {
  const tumbleDeg = (target.tumbleRate || 0) * RAD2DEG;
  const nameLower = zoneName.toLowerCase();

  // Tumble-rate warnings take priority
  if (tumbleDeg > 60) return 'WARN HIGH TUMBLE \u2014 Manual pilot recommended';
  if (tumbleDeg > 20) return '\u25D0 Moderate tumble \u2014 Time net deployment';

  if (nameLower.includes('engine'))      return 'WARN Avoid engine \u2014 approach from opposite end';
  if (nameLower.includes('solar panel')) return '\u25B3 Fragile \u2014 net may cause fragmentation';
  if (target.type === 'fragment')        return '\u2713 Small target \u2014 Small daughter auto-capture viable';

  const { risk } = assessZone(zoneName, target);
  if (risk === 'LOW')  return '\u2713 Safe for auto-capture';
  if (risk === 'MED')  return '\u25D0 Caution \u2014 moderate structural risk';
  return 'WARN Hazardous zone \u2014 avoid if possible';
}

// Reusable rotation math: zero per-frame allocations (output goes to module-level `_rot`).
const _rot = [0, 0, 0];
const _cosTilt = Math.cos(TILT_X);
const _sinTilt = Math.sin(TILT_X);

/** Y-axis rotation by (cosY, sinY) then the fixed X-axis tilt, written to module-level `_rot`. */
function rotateAndTilt(x, y, z, cosY, sinY) {
  const rx = x * cosY + z * sinY;
  const ry = y;
  const rz = -x * sinY + z * cosY;

  _rot[0] = rx;
  _rot[1] = ry * _cosTilt - rz * _sinTilt;
  _rot[2] = ry * _sinTilt + rz * _cosTilt;
}

export class DebrisWireframe {
  /**
   * BufferGeometry for instanced-mesh use, cached per type; for fragments `id % DEBRIS_FRAGMENT_VARIANTS` picks a variant.
   * @param {string} type - 'rocketBody' | 'defunctSat' | 'missionDebris' | 'fragment'
   * @param {number} [id=0]
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
      case 'cubesat':
        geo = _buildCubesatGeo();
        break;
      case 'fragment':
      default:
        geo = _buildFragmentGeo((id >>> 0) % N);
        break;
    }

    // ONE size rule: scale the new mesh uniformly so its bounding box's LONGEST side is exactly 1.0 mesh unit.
    // DebrisField draws an instance at scale `sizeMeter × 1e-5`, so the drawn longest side is `sizeMeter` metres.
    // Runs on the NEW geometry, BEFORE any cache below is filled and before it is handed out: ArmUnit keeps
    // per-geometry vertex caches (a WeakMap keyed by the BufferGeometry), so a cached or handed-out geometry must
    // never be rescaled. The origin is not moved (no re-centring).
    _normaliseLongestSideToOne(geo);

    // Local bounding radius per cacheKey (includes the fragment variant), for mounting flag decals on the surface.
    geo.computeBoundingSphere();
    const br = geo.boundingSphere ? geo.boundingSphere.radius : 1;
    _geoRadiusCache.set(cacheKey, br);
    // The bounding sphere is NOT centred on the origin (a fragment's sits up to 0.3 mesh units off, so its vertices
    // reach 16 % past `br` from the origin); anything centred on the catch needs the origin-centred reach.
    const pos = geo.attributes && geo.attributes.position;
    let reach = 0;
    if (pos) for (let i = 0; i < pos.count; i++) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
    _geoOriginRadiusCache.set(cacheKey, reach || br);

    // Bounding-box half-extents too: the bounding *sphere* is dominated by far-reaching parts (solar wings) and
    // would float a flag decal in empty space; the box lands it on the hull face per direction.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    _geoHalfExtentCache.set(cacheKey, bb
      ? { x: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
          y: Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)),
          z: Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) }
      : { x: br, y: br, z: br });

    // True centre + half-extents (balloon→fabric): the bag's contents floor
    // wraps the catch's REAL box, so the asymmetry must survive.
    _geoBBoxCache.set(cacheKey, bb
      ? { cx: (bb.min.x + bb.max.x) / 2, cy: (bb.min.y + bb.max.y) / 2, cz: (bb.min.z + bb.max.z) / 2,
          hx: (bb.max.x - bb.min.x) / 2, hy: (bb.max.y - bb.min.y) / 2, hz: (bb.max.z - bb.min.z) / 2 }
      : { cx: 0, cy: 0, cz: 0, hx: br, hy: br, hz: br });

    _geoCache.set(cacheKey, geo);
    return geo;
  }

  /**
   * Local-space bounding radius (cached after the first getGeometry call), for placing flag decals on the surface.
   * @returns {number}
   */
  static getBoundingRadius(type, id = 0) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;
    return _geoRadiusCache.has(cacheKey) ? _geoRadiusCache.get(cacheKey) : 1;
  }

  /**
   * Farthest vertex of the mesh from its origin (the instance origin the catch is pinned and bagged at), in mesh
   * units: multiply by the render scale for the drawn reach. >= `getBoundingRadius` only when the bounding sphere
   * is centred off the origin. Primes the cache itself (no uncached-returns-1 trap).
   * @returns {number}
   */
  static getOriginRadius(type, id = 0) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;
    if (!_geoOriginRadiusCache.has(cacheKey)) this.getGeometry(type, id);
    return _geoOriginRadiusCache.get(cacheKey) || 1;
  }

  /**
   * Instance scale (scene units) that renders this mesh at a given RADIUS in metres: `radiusM × 1e-5 / br`. Rendered
   * radius = scale × br, so the bounding radius must be divided OUT (else the real floor of
   * `MOTHER_CATCH_MIN_RENDER_M` would be `minM × br` metres, mesh-dependent). Primes the geometry cache first (the
   * `getBoundingRadius` uncached-returns-1 trap). A missing/unknown mesh falls back to br = 1.
   * @param {number} radiusM - desired rendered radius in metres
   * @param {string} [type] - debris type (mesh key)
   * @returns {number} instance scale in scene units
   */
  static scaleForRenderRadiusM(radiusM, type, id = 0) {
    let br = 1;
    if (type != null) {
      this.getGeometry(type, id);
      br = this.getBoundingRadius(type, id) || 1;
    }
    return (radiusM * 0.00001) / br;
  }

  /**
   * Local-space bounding-box centre + half-extents, keyed like getBoundingRadius (balloon→fabric box floor). Primes
   * the cache via getGeometry (no uncached trap). The returned object is SHARED (cached): do not mutate; scale it by
   * the instance's render scale before use.
   * @returns {{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}}
   */
  static getBoundingBoxExtents(type, id = 0) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const cacheKey = type === 'fragment' ? `fragment_${(id >>> 0) % N}` : type;
    if (!_geoBBoxCache.has(cacheKey)) this.getGeometry(type, id);
    return _geoBBoxCache.get(cacheKey);
  }

  /**
   * Whether a fragment variant renders as a flat plate-like shard (panel/foil fragment). SINGLE SOURCE OF TRUTH:
   * `_buildFragmentGeo` and the welcome-field candidate selector both call it, so shape and selector never drift.
   * Pure (no THREE / geometry build).
   * @param {number} variantId - fragment variant index (id % DEBRIS_FRAGMENT_VARIANTS)
   * @returns {boolean}
   */
  static isPlateVariant(variantId) {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const seed = (((((variantId >>> 0) % N) + 1) >>> 0) * 2654435761) >>> 0;
    return _hash01(seed + 41) > 0.68;
  }

  /**
   * Distance from the local origin to the bounding-box surface along a local-space unit direction (flag decals sit
   * flush on the hull face, not at the larger bounding-sphere radius). O(1); falls back to the bounding radius if
   * uncached.
   * @param {number} dx @param {number} dy @param {number} dz - unit direction
   * @returns {number} distance along the direction
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
   * Creates the canvas overlay; with no target selected it shows the player's ADR satellite wireframe.
   * @param {HTMLElement} [container] - appended with relative positioning; otherwise fixed positioning.
   */
  constructor(container) {
    /** @type {HTMLCanvasElement} */
    this._canvas = document.createElement('canvas');

    // HiDPI buffer at native resolution, CSS at logical size. The pane is drawn HUD_SCALE x bigger (CSS scale on its
    // column), so the buffer is HUD_SCALE x denser to stay sharp.
    const dpr = (window.devicePixelRatio || 1) * currentHudScale();
    /** @type {number} Device pixel ratio for HiDPI canvas scaling */
    this.dpr = dpr;
    this._canvas.width = PANEL_WIDTH * dpr;
    this._canvas.height = PANEL_HEIGHT * dpr;

    /** @type {boolean} Whether mounted in a container or floating */
    this._hasContainer = !!container;

    /** @type {boolean} Collapsed-to-summary-line state (toggleMinimized). */
    this._minimized = false;

    if (container) {
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

      // Minimized one-line summary (the 9 key): hides the canvas and shows identity · size · mass · tumble (WARN when
      // high) · material, the capture-planning facts not in the target list. Same flex container, so the right column
      // collapses around it.
      this._minLine = document.createElement('div');
      this._minLine.id = 'hud-debris-min-summary';
      Object.assign(this._minLine.style, {
        display: 'none',
        font: '11px var(--font-mono)',   // the DOM line rides the house token (the canvas fonts above stay literal by design)
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

      // Keep a container ref so the 9 key can clear a density-ladder hide.
      this._container = container;

      // No visible [9] badge; the 9 key still shows / hides the pane (Help page, hover tip). The container stays
      // position:relative for the pane's own absolutely placed children.
      container.style.position = container.style.position || 'relative';
    } else {
      // Fallback fixed positioning: top-right below NavSphere, clear of bottom-anchored panels (DaughterWireframe,
      // warnings strip, comms panel).
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

    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    const grad = this._ctx.createRadialGradient(WIRE_CX, WIRE_CY, 0, WIRE_CX, WIRE_CY, PANEL_WIDTH * 0.55);
    grad.addColorStop(0, 'rgba(0, 20, 40, 0.9)');
    grad.addColorStop(1, BG_COLOR);
    /** @type {CanvasGradient} */
    this._bgGradient = grad;

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
    /** @type {boolean} The simple level (set by HUD.setSimple via isSimpleTargets) */
    this._simple = false;
    /** @type {boolean} True when in daughter-piloted expanded inspection mode */
    this._expandedMode = false;
    /** @type {number|null} Index of daughter arm when expanded */
    this._fromArmIndex = null;
    /** @type {Array<{id:string,state:string,type:string}>} Arm status for dock cavity colors */
    this._armStatuses = [];
    /** @type {boolean} Whether salvage scanner upgrade is active */
    this._hasSalvageScanner = false;

    /** @type {number[][]} Projected [sx, sy] for each vertex */
    this._projected = [];

    /** @type {{ risk: string, color: string }[]} */
    this._zoneAssessments = [];

    // Dossier reveal state
    /** @type {number} ms timestamp when the silhouette draw-on began */
    this._traceStart = 0;
    /** @type {number|null} ms timestamp when Full Profile typewriter began */
    this._profileRevealStart = null;
    /** @type {number} rows already revealed (chime once per new row) */
    this._lastRowsShown = 0;

    // Full Profile unlocked while this target is on screen → line-by-line typewriter reveal.
    eventBus.on(Events.DEBRIS_PROFILED, ({ debrisId }) => {
      if (this._target && this._target.id === debrisId) {
        this._profileRevealStart = performance.now();
        this._lastRowsShown = 0;
      }
    });

    if (this._hasContainer) {
      this._showADRSatellite();
    }

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.setVisible(false);
    });

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
      if (this._target && !this._target.alive) {
        this.setTarget(null);
      }
    });
  }

  /**
   * Set the target to display; `null` shows the ADR self-view (container-mounted) or hides the panel (floating).
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
        this._zoneAssessments = this._shape.zones.map(
          (zone) => assessZone(zone.name, target)
        );
      }
      this.setVisible(true);
    } else if (this._hasContainer) {
      this._showADRSatellite();
    } else {
      this._shape = null;
      this._zoneAssessments = [];
      this.setVisible(false);
    }

    if (this._minimized) this._renderMinLine();
  }

  setSalvageScanner(active) {
    this._hasSalvageScanner = !!active;
  }

  /**
   * Cycle the zone highlight (+1 next, -1 previous); tracks visited zones for {@link hasAssessedTarget}. Works on
   * debris targets and the ADR self-view.
   */
  cycleZone(direction) {
    if (!this._shape) return;
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

  /** True once the player has cycled through all zones on the current target (scoring bonus multiplier). */
  hasAssessedTarget() {
    return this._assessed;
  }

  /** Per-frame update from the main loop: advances rotation and redraws. @param {number} dt - seconds */
  update(dt) {
    if (!this._visible || !this._shape) return;
    if (!this._target && !this._showingADR && !this._expandedMode) return;

    if (this._showingADR) {
      this._angle += 0.15 * dt;
    } else {
      // Same structure as DebrisField.js (tumbleRate × TIME_SCALE capped) with a lower ceiling tuned for Canvas2D comfort.
      const tumble = this._target.tumbleRate || 0;
      const maxWireRad = degToRad(Constants.WIREFRAME_MAX_TUMBLE_DEG_S);
      const rate = Math.max(MIN_TUMBLE_RATE, Math.min(tumble * TimeAuthority.BASE_SCALE, maxWireRad));
      this._angle += rate * dt;
    }

    // No frame throttle: a 30 Hz one caused perceived jitter; 60 fps matches the DOM compositor. Back-edge depth
    // dimming (in _render) addresses the Necker-cube oscillation.
    this._render();
  }

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
   * Minimize-to-one-line toggle for the Debris pane key (9), mirroring the comms/target minimize: hides the canvas and
   * shows one line of capture-planning facts (identity · size · mass · tumble · material); press again to restore.
   * Falls back to a plain canvas hide when floating (no container / no min line).
   */
  toggleMinimized() {
    // Held back until the first scan (HUD's scan gate): say when it comes, fold nothing.
    if (this._container && this._container.hasAttribute('data-scan-wait')) {
      // In mission 1, after the scan it waits for the player's analyse (Z).
      const analyse = typeof this._container.getAttribute === 'function' && this._container.getAttribute('data-scan-wait') === 'analyse';
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: analyse ? 'Target info opens when you analyse a target (Z)' : 'Target info appears after your first scan (S)',
        priority: 'info', _reactive: true,
      });
      return;
    }
    if (!this._hasContainer || !this._minLine) {
      this.setVisible(!this._visible);
      this._emitPaneToggle(this._visible);
      // The floating fallback flips the pane's visibility bit itself: the room-memory write trigger (after the flip).
      eventBus.emit(Events.HUD_PANE_VISIBILITY, { pane: 'debris', shown: this._visible });
      return;
    }
    // 9 always re-reveals the pane, even when the pane-density ladder (−) hid
    // it: clear the density-hidden flag first so this press shows the canvas.
    if (this._container && this._container.hasAttribute('data-density-hidden')) {
      this._container.removeAttribute('data-density-hidden');
      this._minimized = false;
      this._minLine.style.display = 'none';
      this._canvas.style.display = 'block';
      this._frameSkip = -1;
      this._emitPaneToggle(true);
      // The attribute-clear path flipped the ONE density bit (the intent FloorMask captures): emit after the flip.
      eventBus.emit(Events.HUD_PANE_VISIBILITY, { pane: 'debris', shown: true });
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
      this._frameSkip = -1;
    }
    // No HUD_PANE_VISIBILITY here: the minimize fold is NOT the visibility bit
    // (the container stays on screen; the intent FloorMask reads is unchanged).
    this._emitPaneToggle(!this._minimized);
  }

  /** @private Reactive comms line for the 9 key (never suppressed). */
  _emitPaneToggle(shown) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: shown ? 'Target info pane shown (9 to hide)' : 'Target info pane hidden (9 to show)',
      priority: 'info',
      _reactive: true,
    });
  }

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
    const tumbleDeg = (t.tumbleRate || 0) * RAD2DEG;
    const warn = tumbleDeg > 60 ? ' WARN' : '';
    const tumbleStr = `\u27F3${tumbleDeg.toFixed(0)}\u00B0/s${warn}`;
    const matStr = MATERIAL_LABELS[t.material] || t.material || '?';
    this._minLine.textContent = `${ident} \u00B7 ${sizeStr} \u00B7 ${massStr} \u00B7 ${tumbleStr} \u00B7 ${matStr}`;
  }

  dispose() {
    if (this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._target = null;
    this._shape = null;
    this._projected = [];
  }

  /**
   * Enter expanded inspection mode: scales the canvas; for the daughter context shows an origin badge.
   * @param {number|null} armIndex - 0-based daughter arm index, or null when inspecting from the mothership.
   * @param {object|null} [debrisTarget] - the arm's debris target. When omitted, the already-selected target is kept
   *   (mothership V-cycle INSPECT); falls back to the ADR self-view only if nothing is selected.
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
      this.setVisible(true);
    } else {
      this._showADRSatellite();
      this.setVisible(true);
    }
  }

  clearExpandedMode() {
    this._expandedMode   = false;
    this._fromArmIndex   = null;
    this._canvas.style.width  = `${PANEL_WIDTH}px`;
    this._canvas.style.height = `${PANEL_HEIGHT}px`;
  }

  _render() {
    const ctx = this._ctx;
    const W = PANEL_WIDTH;
    const H = PANEL_HEIGHT;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this._bgGradient;
    ctx.fillRect(0, 0, W, H);

    ctx.font = mono(13, 'bold');
    ctx.textAlign = 'center';
    ctx.fillStyle = HEADER_COLOR;

    if (this._showingADR) {
      ctx.fillText('YOUR SATELLITE', WIRE_CX, 15);
      ctx.font = mono(12);
      ctx.fillStyle = TYPE_COLOR;
      ctx.fillText('V3 OCTOPUS ADR', WIRE_CX, 27);
    } else {
      // UNSCANNED → static noise, no data.
      const tier = dossierSystem.getTier(this._target);
      if (tier === DOSSIER_TIERS.UNSCANNED) {
        ctx.fillText('TARGET INFO', WIRE_CX, 15);
        this._renderStaticNoise(ctx);
        ctx.font = mono(11, 'bold');
        ctx.fillStyle = DIM_COLOR;
        ctx.textAlign = 'center';
        // Glass has no S key: an empty tap is the scan there (floors 2-3). Read at draw time.
        ctx.fillText(GestureHints.isGlass() ? 'UNRESOLVED \u2014 tap empty space to scan' : 'UNRESOLVED \u2014 scan [S]', WIRE_CX, 150);
        return;
      }
      ctx.fillText('TARGET INFO', WIRE_CX, 15);
      // The simple level draws no lone type label (the name is in the one info line below).
      if (!this._simple) {
        const typeLabel = TYPE_LABELS[this._target.type] || this._target.type;
        ctx.font = mono(12);
        ctx.fillStyle = TYPE_COLOR;
        ctx.fillText(typeLabel, WIRE_CX, 27);
      }
    }

    if (this._expandedMode && this._fromArmIndex != null) {
      ctx.textAlign = 'right';
      ctx.font = mono(10);
      ctx.fillStyle = 'rgba(255,200,60,0.90)';
      ctx.fillText(
        `from Daughter ${this._fromArmIndex + 1}`,
        PANEL_WIDTH - 6,
        PANEL_HEIGHT - 6,
      );
    }

    // Project all vertices; rotated Z is kept for the depth-based alpha
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
      // Rotated Z: positive = far side, negative = near side (camera); dims back-facing edges (kills Necker-cube
      // oscillation).
      proj[i][2] = _rot[2];
    }

    // Single pass with smooth per-edge depth-interpolated alpha: a two-pass hard threshold (avgZ > 0) flickered on
    // edges near the rotation equator.
    const zones = this._shape.zones;
    const assessments = this._zoneAssessments;
    // Draw-on: after a scan the silhouette MATERIALIZES, edges tracing in over WIREFRAME_TRACE_S.
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

      if (highlighted) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e][0];
          const b = edges[e][1];
          if (a >= proj.length || b >= proj.length) continue;
          const avgZ = (proj[a][2] + proj[b][2]) * 0.5;
          const frontness = clamp01((1 - avgZ) * 0.5);
          ctx.globalAlpha = 0.35 * frontness;
          ctx.beginPath();
          ctx.moveTo(proj[a][0], proj[a][1]);
          ctx.lineTo(proj[b][0], proj[b][1]);
          ctx.stroke();
        }
      }

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
        // avgZ ~∈ [-1, 1] for unit-radius shapes; depthT 0 = front (camera side), 1 = back. Fade front=1.0 → back=0.25,
        // no hard threshold (no flicker).
        const depthT = clamp01((avgZ + 1) * 0.5);
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

    this._renderInfoText(ctx);
  }

  /** Zone info (if selected) or general target/ADR info below the wireframe. */
  _renderInfoText(ctx) {
    const infoY = 140;
    ctx.textAlign = 'center';

    if (this._showingADR) {
      if (this._zoneIndex >= 0 && this._shape) {
        const zone = this._shape.zones[this._zoneIndex];
        const { color } = this._zoneAssessments[this._zoneIndex];
        ctx.font = mono(11, 'bold');
        ctx.fillStyle = color;
        ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);
        ctx.font = mono(10);
        ctx.fillStyle = DIM_COLOR;
        ctx.fillText(`${zone.massPercent}% of satellite`, WIRE_CX, infoY + 12);
      } else {
        ctx.font = mono(10);
        ctx.fillStyle = DIM_COLOR;
        const arms = this._armStatuses;
        if (arms.length > 0) {
          let armStr = '';
          for (const a of arms) {
            const prefix = a.type === 'weaver' ? 'L' : 'S';
            const idx = a.id.split('-')[1] || '?';
            const stateChar = a.state === 'DOCKED' ? '\u25CF' :
                              a.state === 'EXPENDED' ? '\u00D7' : '\u25D0';
            const stateColor = a.state === 'DOCKED' ? VisualLaw.COLORS.PLAYER :
                               a.state === 'EXPENDED' ? '#ff4444' : VisualLaw.COLORS.CAUTION;
            armStr += `<${stateColor}>${prefix}${idx}${stateChar} `;
          }
          let armX = 30;
          for (const a of arms) {
            const prefix = a.type === 'weaver' ? 'L' : 'S';
            const idx = a.id.split('-')[1] || '?';
            const icon = a.state === 'DOCKED' ? '\u25CF' :
                         a.state === 'EXPENDED' ? '\u00D7' : '\u25D0';
            ctx.fillStyle = a.state === 'DOCKED' ? VisualLaw.COLORS.PLAYER :
                            a.state === 'EXPENDED' ? '#ff4444' : VisualLaw.COLORS.CAUTION;
            ctx.fillText(`${prefix}${idx}${icon}`, armX, infoY);
            armX += 40;
          }
        }
        ctx.fillStyle = DIM_COLOR;
        ctx.textAlign = 'center';
        // No touch control cycles the zones, so glass leaves the label out (draw-time read).
        if (!GestureHints.isGlass()) ctx.fillText('[Z] Cycle zones', WIRE_CX, infoY + 16);
      }
      return;
    }

    const tier = dossierSystem.getTier(this._target);
    if (this._simple) {
      this._renderSimpleInfo(ctx, infoY, tier);
      return;
    }
    if (tier === DOSSIER_TIERS.SCANNED) {
      this._renderScannedInfo(ctx, infoY);
      return;
    }

    // PROFILED — full structural + salvage knowledge.
    if (this._zoneIndex >= 0 && this._shape) {
      const zone = this._shape.zones[this._zoneIndex];
      const { risk, color } = this._zoneAssessments[this._zoneIndex];
      const rec = getRecommendation(zone.name, this._target);

      ctx.font = mono(11, 'bold');
      ctx.fillStyle = color;
      ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);

      ctx.font = mono(10);
      ctx.fillStyle = color;
      ctx.fillText(`Risk: ${risk}  Mass: ${zone.massPercent}%`, WIRE_CX, infoY + 12);

      ctx.fillStyle = INFO_COLOR;
      this._wrapText(ctx, rec, WIRE_CX, infoY + 24, PANEL_WIDTH - 20, 10);

      this._renderSalvageInfo(ctx, infoY + 46);
    } else {
      const t = this._target;
      ctx.font = mono(10);
      ctx.fillStyle = DIM_COLOR;

      const label = TYPE_LABELS[t.type] || t.type;
      const massStr = t.mass != null ? `${t.mass.toFixed(1)}kg` : '?';
      const sizeStr = t.sizeMeter != null ? `${t.sizeMeter.toFixed(1)}m` : '?';
      // A piece she does not catch reads the spin as drawn: the same rate its spin step measures (one clock).
      const tumbleDeg = ((dossierSystem.inspectPay(t) ? DossierSystem.drawnSpinRadS(t) : (t.tumbleRate || 0)) * RAD2DEG).toFixed(1);

      ctx.fillText(`${label}  ${massStr}  ${sizeStr}`, WIRE_CX, infoY);

      const matKey = t.material;
      const matName = MATERIAL_LABELS[matKey] || matKey || '?';
      const tumbleLine = `Tumble: ${tumbleDeg}\u00B0/s   Mat: ${matName}`;
      ctx.fillText(tumbleLine, WIRE_CX, infoY + 12);
      const swatchColor = MATERIAL_SWATCH[matKey];
      if (swatchColor && typeof ctx.measureText === 'function') {
        // Swatch just left of the material name, measured so it sits next to "Mat: " whatever the tumble width.
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

      // Stacked rows: track y so HIGH TUMBLE, brittleness and the manifest never overdraw each other.
      let rowY = infoY + 24;

      if ((t.tumbleRate || 0) * RAD2DEG > 60) {
        ctx.fillStyle = ZONE_COLORS.RED;
        ctx.font = mono(10, 'bold');
        ctx.fillText('WARN HIGH TUMBLE', WIRE_CX, rowY);
        rowY += 12;
      }

      // A piece over her catch limit shows its characterising steps and no salvage manifest (she cannot catch it).
      const stepsY = this._renderInspectLines(ctx, rowY);
      const stepsShown = stepsY !== rowY;
      rowY = stepsY;

      // Brittleness is the FRAG-chip driver: show the RAW brittleness the fragmentation roll uses (resolveFragSeverity /
      // effectiveFragility), NOT the material-adjusted effectiveBrittleness (zone risk only), so the displayed number
      // can't drift from what is rolled.
      if (t.brittleness != null && !stepsShown) {   // (a piece she does not catch: the four step lines take the room)
        const b = clamp01(t.brittleness);
        ctx.font = mono(10);
        ctx.fillStyle = b >= 0.7 ? ZONE_COLORS.RED : b >= 0.4 ? ZONE_COLORS.YELLOW : ZONE_COLORS.GREEN;
        ctx.fillText(`Brittleness: ${b.toFixed(2)}`, WIRE_CX, rowY);
        rowY += 12;
      }

      if (!stepsShown) this._renderProfiledManifest(ctx, Math.max(rowY, infoY + 36));
    }
  }

  /**
   * The simple level (mission 1, same gate as the Targets list): exactly two text lines under the title, for the
   * SCANNED and PROFILED tiers alike: `<NAME> · <mass> kg · <size> m`, then the survey progress or the salvage worth.
   * @private
   */
  _renderSimpleInfo(ctx, infoY, tier) {
    const t = this._target;
    const D = Constants.DOSSIER || {};
    const scanned = tier === DOSSIER_TIERS.SCANNED;
    const label = TYPE_LABELS[t.type] || t.type;
    const massStr = t.mass != null ? (scanned ? `~${t.mass.toFixed(0)}` : t.mass.toFixed(1)) : '?';
    const sizeStr = t.sizeMeter != null ? t.sizeMeter.toFixed(1) : '?';
    ctx.font = mono(10);
    ctx.fillStyle = DIM_COLOR;
    ctx.textAlign = 'center';
    ctx.fillText(`${label} \u00B7 ${massStr} kg \u00B7 ${sizeStr} m`, WIRE_CX, infoY);

    let line2;
    if (scanned) {
      const progress = dossierSystem.getSurveyProgress(t.id);
      line2 = progress > 0
        ? `Surveying\u2026 ${Math.round(progress * 100)} %`
        : `Get within ${D.DETAIL_SCAN_RANGE_M || 50} m to survey`;
      if (progress > 0) {
        // The survey ring is a drawing, not text: it stays.
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
      }
    } else {
      // Same total (and digits) as _renderProfiledManifest's EST. VALUE.
      let total = 0;
      if (t.hasSalvage && t.salvage) {
        const a = appraiseSalvage(t.salvage);
        if (a.rows.length > 0) total = a.total;
      }
      line2 = total > 0 ? `Worth about ${total} cr` : 'No salvage value';
    }
    ctx.font = mono(10, 'bold');
    ctx.fillStyle = '#00ffaa';
    // A piece over her catch limit: its four characterising steps take the second line's place (the 200 px panel has no room for both)
    if (this._renderInspectLines(ctx, infoY + 12) === infoY + 12) ctx.fillText(line2, WIRE_CX, infoY + 14);
  }

  /**
   * The four step lines of a piece she does not catch, each with its credits (DossierSystem.inspectStepLines, e.g.
   * "orbit 771 cr · within 200 m"; each at most 38 characters so the 280 px panel keeps its padding). Draws nothing for
   * any other piece. Lines are 11 px apart, so four fit between `y` and the 200 px panel's foot when `y` is at most 164.
   * @private
   * @returns {number} the y for what follows (y + 44 after the four lines, y unchanged when there are none)
   */
  _renderInspectLines(ctx, y) {
    const lines = inspectStepLines(dossierSystem.getInspectState(this._target));
    if (!lines) return y;
    ctx.textAlign = 'center';
    for (let i = 0; i < lines.length; i++) {   // one font site for all lines (the first bold and yellow)
      ctx.font = mono(10, i === 0 ? 'bold' : undefined);
      ctx.fillStyle = i === 0 ? '#ffcc00' : INFO_COLOR;
      ctx.fillText(lines[i], WIRE_CX, y + 11 * i);
    }
    return y + 44;
  }

  /**
   * HUD tells the wireframe whether the simple level is on (same answer as HUD.isSimpleTargets); drawn next frame.
   * @param {boolean} on
   */
  setSimple(on) {
    const v = !!on;
    if (v === this._simple) return;
    this._simple = v;
    this._frameSkip = -1;
  }

  /** @private UNSCANNED: static noise in the wireframe area (no data leaks). */
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
   * @private SCANNED: silhouette + type/size/est-mass; the salvage manifest shows REDACTED rows (THAT there is
   * treasure, not WHAT). The survey ring fills while a platform holds within DETAIL_SCAN_RANGE_M.
   */
  _renderScannedInfo(ctx, infoY) {
    const t = this._target;
    const D = Constants.DOSSIER || {};
    ctx.font = mono(10);
    ctx.fillStyle = DIM_COLOR;
    ctx.textAlign = 'center';

    const label = TYPE_LABELS[t.type] || t.type;
    const massStr = t.mass != null ? `~${t.mass.toFixed(0)}kg` : '?';
    const sizeStr = t.sizeMeter != null ? `${t.sizeMeter.toFixed(1)}m` : '?';
    ctx.fillText(`${label}  ${massStr}  ${sizeStr}`, WIRE_CX, infoY);
    // A piece over her catch limit shows its four characterising steps from the second line on (she cannot catch it, so its salvage is no
    // use to her, its spin is what its spin step measures, and the 200 px panel has no room for more): no tumble line, no survey prompt.
    const stepsShown = this._renderInspectLines(ctx, infoY + 12) !== infoY + 12;
    if (!stepsShown) {
      const tumbleDeg = ((t.tumbleRate || 0) * RAD2DEG).toFixed(1);
      ctx.fillText(`Tumble: ${tumbleDeg}\u00B0/s   Mat: \u2588\u2588\u2588\u2588`, WIRE_CX, infoY + 12);
    }

    // Redacted manifest — one ▓-row per real salvage line.
    let y = infoY + 24;
    if (!stepsShown && t.hasSalvage && t.salvage) {
      const { rows } = appraiseSalvage(t.salvage);
      const n = clamp(rows.length || 1, 1, 3);
      ctx.fillStyle = '#ffcc00';
      ctx.font = mono(10, 'bold');
      ctx.fillText('METALS \u2014 UNKNOWN', WIRE_CX, y);
      y += 12;
      ctx.font = mono(10);
      ctx.fillStyle = 'rgba(255, 204, 0, 0.4)';
      for (let i = 0; i < n; i++) {
        ctx.fillText('\u2593\u2593\u2593\u2593\u2593  \u2593\u2593 kg   \u00B7\u2593\u2593\u2593 cr', WIRE_CX, y);
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
      if (!stepsShown) {
        ctx.font = mono(10, 'bold');
        ctx.fillStyle = '#00ffaa';
        ctx.fillText(`SURVEYING ${Math.round(progress * 100)}%`, WIRE_CX, y + 2);
      }
    } else if (!stepsShown) {
      ctx.font = mono(10);
      ctx.fillStyle = DIM_COLOR;
      ctx.fillText(`close to ${D.DETAIL_SCAN_RANGE_M || 50}m to survey`, WIRE_CX, y + 2);
    }
  }

  /** @private PROFILED: the decrypted salvage manifest with credit values, revealed line by line after the survey. */
  _renderProfiledManifest(ctx, y) {
    const t = this._target;
    if (!t.hasSalvage || !t.salvage) return;
    const D = Constants.DOSSIER || {};
    const { rows, total } = appraiseSalvage(t.salvage);
    if (rows.length === 0) return;

    // Typewriter: one row per PROFILE_ROW_INTERVAL_S after the survey; targets profiled earlier (re-selected) show
    // everything at once.
    let rowsShown = rows.length + 1;
    if (this._profileRevealStart != null && typeof performance !== 'undefined') {
      const interval = (D.PROFILE_ROW_INTERVAL_S || 0.35) * 1000;
      rowsShown = Math.floor((performance.now() - this._profileRevealStart) / interval);
      // Soft chime per newly revealed row (typewriter only; a re-selected, already-profiled target is silent).
      if (rowsShown > this._lastRowsShown && this._lastRowsShown < rows.length + 1) {
        // Pitch-step each row so the manifest reads as one rising "data loading" gesture, not identical clicks.
        audioSystem.playTerminalBlip(Math.max(0, rowsShown - 1));
      }
    }
    this._lastRowsShown = rowsShown;

    ctx.font = mono(10, 'bold');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffcc00';
    ctx.fillText('SALVAGE MANIFEST', WIRE_CX, y);
    y += 12;
    ctx.font = mono(10);
    const maxRows = Math.min(3, rows.length);
    for (let i = 0; i < maxRows && i < rowsShown; i++) {
      ctx.fillStyle = VisualLaw.COLORS.INFO;
      ctx.fillText(`${rows[i].label}  \u00B7${rows[i].value} cr`, WIRE_CX, y);
      y += 11;
    }
    if (rowsShown > maxRows) {
      ctx.font = mono(10, 'bold');
      ctx.fillStyle = '#00ffaa';
      const extra = rows.length > maxRows ? ` (+${rows.length - maxRows} more)` : '';
      ctx.fillText(`EST. VALUE ${total} cr${extra}`, WIRE_CX, y);
    }
  }

  /** @private Salvage indicators below the zone/target info (SALVAGE DETECTED with resource types). */
  _renderSalvageInfo(ctx, y) {
    if (!this._target || !this._target.hasSalvage) return;
    const salvage = this._target.salvage;
    if (!salvage) return;

    const hasScanner = this._hasSalvageScanner;

    ctx.font = mono(10, 'bold');
    ctx.textAlign = 'center';

    ctx.fillStyle = SEPARATOR_COLOR;
    ctx.fillText('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', WIRE_CX, y);

    ctx.fillStyle = '#ffcc00';
    ctx.fillText('SALVAGE DETECTED', WIRE_CX, y + 12);

    ctx.font = mono(10);
    let infoY = y + 24;

    if (hasScanner) {
      if (salvage.xenon > 0) {
        ctx.fillStyle = VisualLaw.COLORS.INFO;
        ctx.fillText(`Gas: ~${salvageGasKg(salvage.xenon).toFixed(1)} kg`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.indium > 0) {
        ctx.fillStyle = '#cc88ff';
        ctx.fillText(`In: ~${(salvage.indium * 1000).toFixed(0)} g (FEEP fuel)`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.gaAs > 0) {
        ctx.fillStyle = VisualLaw.COLORS.CAUTION;
        ctx.fillText(`GaAs: ${(salvage.gaAs * 100).toFixed(1)}% panel repair`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.battery > 0) {
        ctx.fillStyle = '#88ff88';
        ctx.fillText(`Bat: ${salvage.battery.toFixed(0)} Wh charge`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.hydrazine > 0) {
        ctx.fillStyle = '#ff4444';
        ctx.fillText(`N\u2082H\u2084: ${salvage.hydrazine.toFixed(1)} kg (HAZMAT)`, WIRE_CX, infoY);
        infoY += 11;
      }
      if (salvage.lithium > 0) {
        ctx.fillStyle = '#88ccff';
        ctx.fillText(`Li: ~${salvage.lithium.toFixed(1)} units (MPD fuel)`, WIRE_CX, infoY);
      }
    } else {
      const hints = [];
      if (salvage.xenon > 0) hints.push('Gas');
      if (salvage.indium > 0) hints.push('In');
      if (salvage.gaAs > 0) hints.push('GaAs');
      if (salvage.battery > 0) hints.push('Bat');
      if (salvage.hydrazine > 0) hints.push('N\u2082H\u2084 HAZ');
      if (salvage.lithium > 0) hints.push('Li');
      ctx.fillStyle = DIM_COLOR;
      ctx.fillText(`Scan for details: ${hints.join(' ')}`, WIRE_CX, infoY);
    }
  }

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
      this._zoneAssessments = this._shape.zones.map((zone) => {
        if (zone.name === 'Daughter Cavities') return { risk: 'DYNAMIC', color: VisualLaw.COLORS.PLAYER };
        if (zone.name === 'Ion Drive') return { risk: 'LOW', color: VisualLaw.COLORS.INFO };
        if (zone.name === 'Laser') return { risk: 'LOW', color: VisualLaw.COLORS.INFO };
        return { risk: 'LOW', color: ZONE_COLORS.GREEN };
      });
    }
    this.setVisible(true);
  }

  _allocateProjectionBuffer(len) {
    if (this._projected.length !== len) {
      this._projected = new Array(len);
      // [sx, sy, rotZ] — rotZ enables back-edge depth dimming in _render
      for (let i = 0; i < len; i++) this._projected[i] = [0, 0, 0];
    }
  }

  /** @private Word-wrapped centred text; maxW and lineH in px. */
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

/** @type {DebrisTextureAtlas|null} Shared type atlas instance */
let _typeAtlas = null;
/** @type {FlagDecalSystem|null} Shared flag atlas instance */
let _flagSystem = null;
/** @type {string} Current visual mode — 'textured' or 'wireframe' */
let _visualMode = (Constants.DEBRIS_VISUAL && Constants.DEBRIS_VISUAL.DEFAULT_MODE) || 'textured';

/**
 * Atlas dimensions for the current device. The DEBRIS_VISUAL constants are the HIGH-end target (2048 type / 1024
 * flag); on low-end GPUs/RAM a 2048² RGBA atlas (~16 MB) can fail to allocate, so clamp against:
 *   • GPU MAX_TEXTURE_SIZE — a hard limit;
 *   • navigator.deviceMemory — Chrome/Edge only; ≤4 GB → halve the atlases.
 * Both are optional; when unknown keep the configured sizes ("unknown = capable desktop", as scene/Earth.js selectLOD).
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

/** Initialise the type and flag atlases (once, at boot, by DebrisField). No-op if already initialised or no DOM. */
export function initAtlases() {
  if (typeof document === 'undefined') return;
  if (_typeAtlas) return;
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

/** @returns {string} 'textured' or 'wireframe' */
export function getVisualMode() { return _visualMode; }

export { getUVOffsetForType, getBaseColorForType, getEmissiveForMOID };
export { getUVOffsetForCountry, hasFlag };

// Export builder functions for testing (pure data, no THREE dependency)
export { buildRocketBody, buildDefunctSat, buildMissionDebris, buildFragment };

export default DebrisWireframe;
