/**
 * MotherWireframe.js — Part-callout wireframe for the V5 "Crossbow" mothership
 * Canvas2D panel — same rendering pipeline as DebrisWireframe.js.
 *
 * Displayed when bare `I` is pressed in ORBITAL_VIEW.
 * Mutually exclusive with the DebrisWireframe right-column: HUD hides the right
 * column while MotherWireframe is shown, and vice versa.
 *
 * Zones auto-rotate every AUTO_ROTATE_MS ms; player can also Tab-cycle manually.
 *
 * @module ui/MotherWireframe
 */

import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const WC  = Constants.WIREFRAMES;
const PW  = WC.PANEL_SIZE_NORMAL.w;   // 280 px
const PH  = WC.PANEL_SIZE_NORMAL.h;   // 200 px
const MR  = 10;
const MB  = 140;
const PERSP_D  = 3.0;
const VIEW_SC  = 185;
const TILT_X   = 15 * Math.PI / 180;
const WIRE_CX  = PW / 2;
const WIRE_CY  = 76;
const TWO_PI   = Math.PI * 2;
const AUTO_ROT_S = WC.AUTO_ROTATE_MS / 1000;

const ZONE_COLORS = {
  GREEN:  WC.COLOR_GREEN,
  YELLOW: WC.COLOR_YELLOW,
  RED:    WC.COLOR_RED,
};

const BG_COLOR    = 'rgba(0, 10, 25, 0.88)';
const BORDER_COL  = 'rgba(88, 166, 255, 0.35)';
const HEADER_COL  = 'rgba(88, 166, 255, 0.85)';
const TYPE_COL    = WC.COLOR_LINE;
const DIM_COL     = WC.COLOR_LABEL;

// ── Rotation scratch buffer (module-level, zero alloc per frame) ──
const _rot     = [0, 0, 0];
const _cosTilt = Math.cos(TILT_X);
const _sinTilt = Math.sin(TILT_X);

function rotateAndTilt(x, y, z, cosY, sinY) {
  const rx = x * cosY + z * sinY;
  const ry = y;
  const rz = -x * sinY + z * cosY;
  _rot[0] = rx;
  _rot[1] = ry * _cosTilt - rz * _sinTilt;
  _rot[2] = ry * _sinTilt + rz * _cosTilt;
}

// ============================================================================
// WIREFRAME SHAPE — V5 Crossbow (simplified schematic)
//
// Vertex layout (88 verts total, scale×1.5 applied at end):
//   0–7   front ring  (Z=+0.55, R=0.35, octagon)
//   8–15  rear ring   (Z=−0.55, R=0.35, octagon)
//  16–23  collar ring (Z=+0.10, R=0.44, octagon)
//  24–27  strut tips  (R=1.20, Z=+0.10, at 0°/90°/180°/270°)
//  28–31  ROSA left wing corners
//  32–35  ROSA right wing corners
//  36–37  sensor mast base + tip
//  38–41  sensor gimbal ring (4 verts)
//  42–47  dock ring  (6 verts, Z=+0.62, R=0.08)
//     48  dock center
//  49–54  laser ring (6 verts, Z=−0.62, R=0.10)
//     55  laser center
//  56–59  FEEP boss  (R=0.38, diagonal azimuths, Z=−0.28)
//  60–63  FEEP grid  (R=0.50, same azimuths, Z=−0.28)
//  64–71  nav light markers (2 verts per light × 4 lights)
//  72–87  arm dock crosses  (4 verts per arm × 4 arms)
// ============================================================================

/**
 * Build the V5 Crossbow part-callout shape.
 * Exported for unit testing (pure data, no DOM).
 * @returns {{ vertices: number[][], zones: Array<{name,edges,massPercent,risk}> }}
 */
export function buildMotherShape() {
  const vl = [];
  let _i    = 0;
  const v   = (x, y, z) => { vl.push([x, y, z]); return _i++; };

  // Octagonal ring helper
  const ring8 = (r, z) => {
    const start = _i;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TWO_PI;
      v(r * Math.cos(a), r * Math.sin(a), z);
    }
    return start;
  };

  // N-point ring helper
  const ringN = (n, r, z) => {
    const start = _i;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TWO_PI;
      v(r * Math.cos(a), r * Math.sin(a), z);
    }
    return start;
  };

  const FR = ring8(0.35,  0.55);  // front ring  0–7
  const RR = ring8(0.35, -0.55);  // rear ring   8–15
  const CR = ring8(0.44,  0.10);  // collar ring 16–23

  // Strut tips at cardinal azimuths
  const T0 = v( 1.20,  0.00, 0.10);  // 24 (0°)
  const T1 = v( 0.00,  1.20, 0.10);  // 25 (90°)
  const T2 = v(-1.20,  0.00, 0.10);  // 26 (180°)
  const T3 = v( 0.00, -1.20, 0.10);  // 27 (270°)

  // ROSA wings ── left (28–31) then right (32–35)
  const RLL  = v(-0.35, -0.07, 0.05);
  const RLO  = v(-1.30, -0.07, 0.05);
  const RLOT = v(-1.30,  0.07, 0.05);
  const RLI  = v(-0.35,  0.07, 0.05);

  const RRL  = v( 0.35, -0.07, 0.05);
  const RRO  = v( 1.30, -0.07, 0.05);
  const RROT = v( 1.30,  0.07, 0.05);
  const RRLT = v( 0.35,  0.07, 0.05);

  // Sensor mast (36–41)
  const SMB = v(0,    0.35, 0.20);
  const SMT = v(0,    0.53, 0.20);
  const SG0 = v( 0.06, 0.54, 0.20);
  const SG1 = v( 0.00, 0.60, 0.20);
  const SG2 = v(-0.06, 0.54, 0.20);
  const SG3 = v( 0.00, 0.48, 0.20);

  // Docking port (42–48)
  const DOCK = ringN(6, 0.08,  0.62);
  const DCNT = v(0, 0,  0.62);

  // Laser aperture (49–55)
  const LASR = ringN(6, 0.10, -0.62);
  const LCNT = v(0, 0, -0.62);

  // FEEP thrusters — boss (56–59) + grid (60–63), interleaved per iteration
  const FB = [], FG = [];
  for (let k = 0; k < 4; k++) {
    const a = k * TWO_PI / 4 + Math.PI / 4;  // 45° offset from struts
    FB.push(v(0.38 * Math.cos(a), 0.38 * Math.sin(a), -0.28));
    FG.push(v(0.50 * Math.cos(a), 0.50 * Math.sin(a), -0.28));
  }

  // Nav light markers — 2-vert short lines, 4 lights (64–71)
  const NP0 = v(-0.39,  0.00,  0.35); const NP1 = v(-0.31,  0.00,  0.35); // port
  const NS0 = v( 0.31,  0.00,  0.35); const NS1 = v( 0.39,  0.00,  0.35); // starboard
  const NT0 = v( 0.00,  0.39, -0.12); const NT1 = v( 0.00,  0.31, -0.12); // top strobe
  const NB0 = v( 0.00, -0.31, -0.12); const NB1 = v( 0.00, -0.39, -0.12); // bottom strobe

  // Arm dock crosses — 4 verts per strut tip [+perp, −perp, +Z, −Z] (72–87)
  const armCross = [];
  const armTipData = [
    [ 1.20,  0.00, 0.10],
    [ 0.00,  1.20, 0.10],
    [-1.20,  0.00, 0.10],
    [ 0.00, -1.20, 0.10],
  ];
  for (const [tx, ty, tz] of armTipData) {
    const px = Math.abs(ty) > Math.abs(tx) ? 0.08 : 0;
    const py = Math.abs(tx) > Math.abs(ty) ? 0.08 : 0;
    armCross.push(
      v(tx + px, ty + py, tz),
      v(tx - px, ty - py, tz),
      v(tx, ty, tz + 0.08),
      v(tx, ty, tz - 0.08),
    );
  }

  // ── ZONE EDGE LISTS ──────────────────────────────────────────────────────

  // Zone 0 — Barrel
  const barrelEdges = [];
  for (let k = 0; k < 8; k++) {
    barrelEdges.push([FR + k, FR + (k + 1) % 8]);
    barrelEdges.push([RR + k, RR + (k + 1) % 8]);
    barrelEdges.push([FR + k, RR + k]);
  }

  // Zone 1 — Collar Ring (ring + ties to front barrel ring)
  const collarEdges = [];
  for (let k = 0; k < 8; k++) {
    collarEdges.push([CR + k, CR + (k + 1) % 8]);
    collarEdges.push([CR + k, FR + k]);
  }

  // Zone 2 — Struts (collar vertices at az 0°/90°/180°/270° → strut tips)
  const strutEdges = [
    [CR + 0, T0], [CR + 2, T1], [CR + 4, T2], [CR + 6, T3],
  ];

  // Zone 3 — FEEP thrusters (boss→grid stub per thruster)
  const feepEdges = [];
  for (let k = 0; k < 4; k++) feepEdges.push([FB[k], FG[k]]);

  // Zone 4 — ROSA solar wings
  const rosaEdges = [
    [RLL, RLO], [RLO, RLOT], [RLOT, RLI], [RLI, RLL],
    [RLL, RLOT], [RLO, RLI],                // cross-hatch cells
    [RRL, RRO], [RRO, RROT], [RROT, RRLT], [RRLT, RRL],
    [RRL, RROT], [RRO, RRLT],
  ];

  // Zone 5 — Sensor cluster
  const sensorEdges = [
    [SMB, SMT],
    [SG0, SG1], [SG1, SG2], [SG2, SG3], [SG3, SG0],
    [SMB, FR + 2],  // tie to barrel top (az 90° vertex)
  ];

  // Zone 6 — Docking port
  const dockEdges = [];
  for (let k = 0; k < 6; k++) {
    dockEdges.push([DOCK + k, DOCK + (k + 1) % 6]);
    dockEdges.push([DCNT, DOCK + k]);
  }
  dockEdges.push([FR + 0, DCNT], [FR + 4, DCNT]);

  // Zone 7 — Laser aperture
  const laserEdges = [];
  for (let k = 0; k < 6; k++) {
    laserEdges.push([LASR + k, LASR + (k + 1) % 6]);
    laserEdges.push([LCNT, LASR + k]);
  }
  laserEdges.push([RR + 0, LCNT], [RR + 4, LCNT]);

  // Zone 8 — Front / Rear caps (star from rings to cap centres)
  const capEdges = [];
  for (let k = 0; k < 8; k += 2) {
    capEdges.push([FR + k, DCNT]);
    capEdges.push([RR + k, LCNT]);
  }

  // Zone 9 — Navigation lights
  const navEdges = [
    [NP0, NP1], [NS0, NS1], [NT0, NT1], [NB0, NB1],
  ];

  // Zone 10 — Crossbow arms (dock crosses + strut lines for context)
  const armEdges = [];
  for (let k = 0; k < 4; k++) {
    const b = k * 4;
    armEdges.push([armCross[b],     armCross[b + 1]]);  // cross perp
    armEdges.push([armCross[b + 2], armCross[b + 3]]);  // cross Z
  }
  // Repeat strut lines so zone highlights the full arm path
  armEdges.push([CR + 0, T0], [CR + 2, T1], [CR + 4, T2], [CR + 6, T3]);

  // ── Scale all vertices 1.5× to fill the panel ────────────────────────────
  for (const vert of vl) {
    vert[0] *= 1.5;
    vert[1] *= 1.5;
    vert[2] *= 1.5;
  }

  return {
    vertices: vl,
    zones: [
      { name: 'Barrel (bus)',       edges: barrelEdges,  massPercent: 35, risk: 'GREEN'  },
      { name: 'Collar Ring',        edges: collarEdges,  massPercent:  5, risk: 'GREEN'  },
      { name: 'Struts (4)',         edges: strutEdges,   massPercent:  8, risk: 'YELLOW' },
      { name: 'FEEP Thrusters',     edges: feepEdges,    massPercent:  6, risk: 'YELLOW' },
      { name: 'ROSA Solar Wings',   edges: rosaEdges,    massPercent: 18, risk: 'GREEN'  },
      { name: 'Sensor Cluster',     edges: sensorEdges,  massPercent:  4, risk: 'GREEN'  },
      { name: 'Docking Port',       edges: dockEdges,    massPercent:  3, risk: 'GREEN'  },
      { name: 'Laser Aperture',     edges: laserEdges,   massPercent:  6, risk: 'RED'    },
      { name: 'Front/Rear Caps',    edges: capEdges,     massPercent:  5, risk: 'GREEN'  },
      { name: 'Navigation Lights',  edges: navEdges,     massPercent:  1, risk: 'GREEN'  },
      { name: 'Crossbow Arms',      edges: armEdges,     massPercent:  9, risk: 'YELLOW' },
    ],
  };
}

// Built once at module load (pure data, no DOM)
const MOTHER_SHAPE = buildMotherShape();

// ============================================================================
// CLASS
// ============================================================================

export class MotherWireframe {
  /**
   * @param {object}  [opts]
   * @param {HTMLElement|null} [opts.container]  Parent element — if null, appended to body.
   * @param {object|null}      [opts.playerSatellite]  Reference (reserved, not used for rendering).
   * @param {object|null}      [opts.armManager]       Used for Crossbow Arms zone count label.
   */
  constructor({ container = null, playerSatellite = null, armManager = null } = {}) {
    this._armManager  = armManager;

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.dpr  = dpr;

    // ── Canvas ────────────────────────────────────────────────────────────
    this._canvas        = document.createElement('canvas');
    this._canvas.width  = PW * dpr;
    this._canvas.height = PH * dpr;
    Object.assign(this._canvas.style, {
      position:      'fixed',
      right:         `${MR}px`,
      bottom:        `${MB}px`,
      width:         `${PW}px`,
      height:        `${PH}px`,
      zIndex:        '13',
      pointerEvents: 'none',
      display:       'none',
      border:        `1px solid ${BORDER_COL}`,
      borderRadius:  '4px',
    });

    if (container) {
      container.appendChild(this._canvas);
    } else {
      document.body.appendChild(this._canvas);
      this._attachedToBody = true;
    }

    // ── Context ───────────────────────────────────────────────────────────
    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    const grad = this._ctx.createRadialGradient(WIRE_CX, WIRE_CY, 0, WIRE_CX, WIRE_CY, PW * 0.55);
    grad.addColorStop(0, 'rgba(0, 20, 50, 0.92)');
    grad.addColorStop(1, BG_COLOR);
    this._bgGradient = grad;

    // ── State ─────────────────────────────────────────────────────────────
    this._shape     = MOTHER_SHAPE;
    this._visible   = false;
    this._zoneIndex = -1;
    this._angle     = 0;
    this._autoTimer = 0;
    this._projected = [];
    this._allocateProjectionBuffer(this._shape.vertices.length);

    // ── Event listeners ───────────────────────────────────────────────────
    this._onInspect = ({ subject } = {}) => {
      if ((subject === 'mother' || subject == null) && !this._visible) {
        this.show();
      } else {
        this.hide();
      }
    };

    this._onStateChange = ({ to }) => {
      const gameplay = to === 'ORBITAL_VIEW' || to === 'APPROACH' || to === 'INTERACTION';
      if (!gameplay) this.hide();
    };

    eventBus.on(Events.INSPECTION_TOGGLE, this._onInspect);
    eventBus.on(Events.GAME_STATE_CHANGE,  this._onStateChange);
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  show() {
    this._visible   = true;
    this._zoneIndex = -1;
    this._autoTimer = 0;
    this._canvas.style.display = 'block';
  }

  hide() {
    this._visible = false;
    this._canvas.style.display = 'none';
  }

  /**
   * @param {number|null} zoneId  0-based zone index, or null to re-enable auto-rotation.
   */
  setZoneHighlight(zoneId) {
    if (zoneId == null) {
      this._zoneIndex = -1;
    } else {
      const n = this._shape.zones.length;
      this._zoneIndex = Math.max(0, Math.min(n - 1, Math.round(zoneId)));
    }
    this._autoTimer = 0;
  }

  /**
   * Cycle zone in direction (+1 forward, −1 back).
   * @param {number} dir
   */
  cycleZone(dir) {
    const n = this._shape.zones.length;
    if (this._zoneIndex < 0) {
      this._zoneIndex = dir > 0 ? 0 : n - 1;
    } else {
      this._zoneIndex = ((this._zoneIndex + dir) % n + n) % n;
    }
    this._autoTimer = 0;
  }

  /**
   * Per-frame update — advances rotation and auto-zone timer, redraws canvas.
   * @param {number} dt  Delta time in seconds.
   */
  update(dt) {
    if (!this._visible || !this._shape) return;

    this._angle += 0.18 * dt;

    this._autoTimer += dt;
    if (this._autoTimer >= AUTO_ROT_S) {
      this._autoTimer = 0;
      const n = this._shape.zones.length;
      this._zoneIndex = (this._zoneIndex < 0 ? 0 : (this._zoneIndex + 1) % n);
    }

    this._render();
  }

  destroy() {
    if (this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    eventBus.off(Events.INSPECTION_TOGGLE, this._onInspect);
    eventBus.off(Events.GAME_STATE_CHANGE,  this._onStateChange);
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  _allocateProjectionBuffer(len) {
    if (this._projected.length !== len) {
      this._projected = new Array(len);
      for (let i = 0; i < len; i++) this._projected[i] = [0, 0, 0];
    }
  }

  _render() {
    const ctx = this._ctx;
    const W   = PW;
    const H   = PH;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this._bgGradient;
    ctx.fillRect(0, 0, W, H);

    // Header
    ctx.font      = "bold 12px 'Courier New', monospace";
    ctx.textAlign = 'center';
    ctx.fillStyle = HEADER_COL;
    ctx.fillText('V5 CROSSBOW [I]', WIRE_CX, 14);
    ctx.font      = "11px 'Courier New', monospace";
    ctx.fillStyle = TYPE_COL;
    ctx.fillText('PART CALLOUT — MOTHERSHIP', WIRE_CX, 26);

    // Separator
    ctx.fillStyle = 'rgba(88,166,255,0.22)';
    ctx.fillRect(10, 30, W - 20, 1);

    // Project vertices
    const cosY  = Math.cos(this._angle);
    const sinY  = Math.sin(this._angle);
    const verts = this._shape.vertices;
    const proj  = this._projected;

    for (let i = 0; i < verts.length; i++) {
      const vert = verts[i];
      rotateAndTilt(vert[0], vert[1], vert[2], cosY, sinY);
      const pz  = _rot[2] + PERSP_D;
      proj[i][0] = WIRE_CX + (_rot[0] / pz) * VIEW_SC;
      proj[i][1] = WIRE_CY - (_rot[1] / pz) * VIEW_SC;
      proj[i][2] = _rot[2];
    }

    // Draw zone edges with depth-based alpha (same algorithm as DebrisWireframe)
    const zones = this._shape.zones;
    ctx.save();
    for (let zi = 0; zi < zones.length; zi++) {
      const zone        = zones[zi];
      const color       = ZONE_COLORS[zone.risk] || WC.COLOR_LINE;
      const highlighted = zi === this._zoneIndex;
      const edges       = zone.edges;

      // Glow pass for highlighted zone
      if (highlighted) {
        ctx.strokeStyle = color;
        ctx.lineWidth   = 4;
        for (const [a, b] of edges) {
          if (a >= proj.length || b >= proj.length) continue;
          const avgZ      = (proj[a][2] + proj[b][2]) * 0.5;
          const frontness = Math.max(0, Math.min(1, (1 - avgZ) * 0.5));
          ctx.globalAlpha = 0.35 * frontness;
          ctx.beginPath();
          ctx.moveTo(proj[a][0], proj[a][1]);
          ctx.lineTo(proj[b][0], proj[b][1]);
          ctx.stroke();
        }
      }

      // Main edge pass
      ctx.strokeStyle = color;
      ctx.lineWidth   = highlighted ? 2 : 1;
      const baseAlpha = highlighted ? 0.90 : 0.55;
      for (const [a, b] of edges) {
        if (a >= proj.length || b >= proj.length) continue;
        const avgZ  = (proj[a][2] + proj[b][2]) * 0.5;
        const depT  = Math.max(0, Math.min(1, (avgZ + 1) * 0.5));
        ctx.globalAlpha = baseAlpha * (1 - depT * 0.75);
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

  _renderInfoText(ctx) {
    const infoY = 143;
    ctx.textAlign = 'center';

    if (this._zoneIndex >= 0 && this._zoneIndex < this._shape.zones.length) {
      const zone    = this._shape.zones[this._zoneIndex];
      const color   = ZONE_COLORS[zone.risk] || WC.COLOR_LINE;
      const riskTxt = zone.risk === 'RED' ? 'HIGH' : zone.risk === 'YELLOW' ? 'MED' : 'LOW';

      ctx.font      = "bold 11px 'Courier New', monospace";
      ctx.fillStyle = color;
      ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);

      ctx.font      = "10px 'Courier New', monospace";
      ctx.fillStyle = color;

      let detail = `Mass: ${zone.massPercent}%   Risk: ${riskTxt}`;
      if (zone.name === 'Crossbow Arms' && this._armManager) {
        const arms   = this._armManager.getArms?.() || [];
        const docked = arms.filter(a => a?.state === 'DOCKED').length;
        detail = `${docked}/${arms.length} ARMS DOCKED`;
      }
      ctx.fillText(detail, WIRE_CX, infoY + 13);

      ctx.font      = "10px 'Courier New', monospace";
      ctx.fillStyle = DIM_COL;
      ctx.fillText('[Tab] next zone   [I] close', WIRE_CX, infoY + 26);
    } else {
      ctx.font      = "11px 'Courier New', monospace";
      ctx.fillStyle = DIM_COL;
      ctx.fillText('SCANNING ALL ZONES…', WIRE_CX, infoY);
      ctx.font      = "10px 'Courier New', monospace";
      ctx.fillText('[I] close   [Tab] select zone', WIRE_CX, infoY + 14);
    }
  }
}

export default MotherWireframe;
