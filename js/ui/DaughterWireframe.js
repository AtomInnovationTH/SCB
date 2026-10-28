/**
 * DaughterWireframe.js — part-callout wireframe for a deployed ArmUnit (daughter craft); Canvas2D panel,
 * same pipeline as DebrisWireframe.js, bottom-left slot so it never overlaps DebrisWireframe (bottom-right).
 *
 * Lifecycle:
 *   - Auto-shows on CAMERA_VIEW_CHANGE → ARM_PILOT.
 *   - Auto-hides on leaving ARM_PILOT.
 *   - Bare `I` in ARM_PILOT expands the panel 1.4× and DebrisWireframe's expanded mode (coordinated by HUD.js).
 * HUD.update() must call setPilotedArm(arm) each frame.
 *
 * @module ui/DaughterWireframe
 */

import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { mono } from '../core/Typeface.js';
import { GestureHints } from './hud/GestureHints.js';
import { degToRad, clamp01, clamp } from '../core/MathUtil.js';

const WC  = Constants.WIREFRAMES;
const PW  = WC.PANEL_SIZE_NORMAL.w;   // 280 px
const PH  = WC.PANEL_SIZE_NORMAL.h;   // 200 px
const ML  = 10;                        // margin left (px)
const MB  = 20;                        // margin bottom (px)
const PERSP_D  = 3.0;
const VIEW_SC  = 165;
const TILT_X   = degToRad(15);
const WIRE_CX  = PW / 2;
const WIRE_CY  = 76;
const TWO_PI   = Math.PI * 2;
const AUTO_ROT_S = WC.AUTO_ROTATE_MS / 1000;

const ZONE_COLORS = {
  GREEN:  WC.COLOR_GREEN,
  YELLOW: WC.COLOR_YELLOW,
  RED:    WC.COLOR_RED,
};

const BG_COLOR   = 'rgba(0, 10, 25, 0.88)';
const BORDER_COL = 'rgba(88, 166, 255, 0.35)';
const HEADER_COL = 'rgba(88, 166, 255, 0.85)';
const TYPE_COL   = WC.COLOR_LINE;
const DIM_COL    = WC.COLOR_LABEL;

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

// Vertex layout (52 verts, scale ×1.8 applied at end):
//   0–5   front hex  (Z=+0.50, R=0.28)
//   6–11  rear  hex  (Z=−0.50, R=0.28)
//  12–15  EPM pole  (base, tip, cross-A, cross-B)
//  16–21  FEEP fore ring (6 verts, Z=+0.62)
//  22–27  FEEP aft  ring (6 verts, Z=−0.62)
//  28–33  solar-skin front ring (6 verts, Z=+0.46, R=0.30 — conformal cells)
//  34–39  solar-skin rear  ring (6 verts, Z=−0.46, R=0.30)
//  40–43  Net pack corners (front-bottom rectangle)
//  44–45  Bridle hardpoints (2 positions)
//  46–49  Status light marker (2-vertex cross)
//  50–51  Tether line (attach point + extended aft)

/**
 * Build the daughter arm part-callout shape (pure data, no DOM; exported for tests).
 * @returns {{ vertices: number[][], zones: Array<{name,edges,massPercent,risk}> }}
 */
export function buildDaughterShape() {
  const vl = [];
  let _i    = 0;
  const v   = (x, y, z) => { vl.push([x, y, z]); return _i++; };

  const hexN = (r, z) => {
    const start = _i;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TWO_PI;
      v(r * Math.cos(a), r * Math.sin(a), z);
    }
    return start;
  };
  const ring6 = (r, z) => hexN(r, z);  // alias — same shape

  const FH = hexN(0.28,  0.50);   // front hex 0–5
  const RH = hexN(0.28, -0.50);   // rear  hex 6–11

  const EPM_B  = v( 0.00,  0.28,  0.15);   // 12 base
  const EPM_T  = v( 0.00,  0.46,  0.15);   // 13 tip
  const EPM_CA = v( 0.05,  0.46,  0.15);   // 14 cross arm A
  const EPM_CB = v(-0.05,  0.46,  0.15);   // 15 cross arm B

  const FFORE = ring6(0.12,  0.62);
  const FAFT  = ring6(0.12, -0.62);

  // Solar skin: hex rings just proud of the body shell (R=0.30 vs 0.28), inset along Z so end caps stay structure.
  // Matches the 3D `-solar-skin` mesh.
  const SKF = hexN(0.30,  0.46);   // skin front ring 28–33
  const SKR = hexN(0.30, -0.46);   // skin rear  ring 34–39

  const NTA = v(-0.10, -0.28,  0.40);
  const NTB = v( 0.10, -0.28,  0.40);
  const NTC = v( 0.10, -0.36,  0.40);
  const NTD = v(-0.10, -0.36,  0.40);

  const BHA = v( 0.22,  0.12,  0.00);
  const BHB = v(-0.22,  0.12,  0.00);

  const SLA = v( 0.04,  0.28, -0.25);
  const SLB = v(-0.04,  0.28, -0.25);
  const SLC = v( 0.00,  0.33, -0.25);
  const SLD = v( 0.00,  0.23, -0.25);

  const TRA = v( 0.00,  0.00, -0.52);   // tether attach at rear face
  const TRB = v( 0.00,  0.00, -0.70);   // tether extends further

  const bodyEdges = [];
  for (let k = 0; k < 6; k++) {
    bodyEdges.push([FH + k, FH + (k + 1) % 6]);
    bodyEdges.push([RH + k, RH + (k + 1) % 6]);
    bodyEdges.push([FH + k, RH + k]);
  }

  const epmEdges = [
    [EPM_B, EPM_T],
    [EPM_CA, EPM_CB],
    [EPM_B, FH + 2],   // tie to body top (az 120° ≈ near +Y)
  ];

  const fforeEdges = [];
  for (let k = 0; k < 6; k++) {
    fforeEdges.push([FFORE + k, FFORE + (k + 1) % 6]);
  }
  fforeEdges.push([FH + 0, FFORE + 0], [FH + 3, FFORE + 3]);

  const faftEdges = [];
  for (let k = 0; k < 6; k++) {
    faftEdges.push([FAFT + k, FAFT + (k + 1) % 6]);
  }
  faftEdges.push([RH + 0, FAFT + 0], [RH + 3, FAFT + 3]);

  // Zone 4 — Solar Skin: two hex end rings plus a longitudinal cell line down each of the 6 faces.
  const solarEdges = [];
  for (let k = 0; k < 6; k++) {
    solarEdges.push([SKF + k, SKF + (k + 1) % 6]);  // front ring
    solarEdges.push([SKR + k, SKR + (k + 1) % 6]);  // rear ring
    solarEdges.push([SKF + k, SKR + k]);            // longitudinal cell line
  }

  const netEdges = [
    [NTA, NTB], [NTB, NTC], [NTC, NTD], [NTD, NTA],
    [NTA, FH + 5], [NTB, FH + 0],
  ];

  const bridleEdges = [
    [BHA, BHB],
    [BHA, FH + 0],
    [BHB, FH + 3],
  ];

  const statusEdges = [
    [SLA, SLB],
    [SLC, SLD],
  ];

  const tetherEdges = [
    [TRA, TRB],
    [RH + 0, TRA],
  ];

  for (const vert of vl) {
    vert[0] *= 1.8;
    vert[1] *= 1.8;
    vert[2] *= 1.8;
  }

  return {
    vertices: vl,
    zones: [
      { name: 'Body Shell (hex)',      edges: bodyEdges,   massPercent: 30, risk: 'GREEN'  },
      { name: 'EPM Pole',              edges: epmEdges,    massPercent:  8, risk: 'YELLOW' },
      { name: 'FEEP Fore Thruster',    edges: fforeEdges,  massPercent: 12, risk: 'YELLOW' },
      { name: 'FEEP Aft Thruster',     edges: faftEdges,   massPercent: 12, risk: 'YELLOW' },
      { name: 'Solar Skin (cells)',   edges: solarEdges,  massPercent: 20, risk: 'GREEN'  },
      { name: 'Net Pack',              edges: netEdges,    massPercent: 10, risk: 'RED'    },
      { name: 'Bridle Ring',           edges: bridleEdges, massPercent:  5, risk: 'YELLOW' },
      { name: 'Status Light',          edges: statusEdges, massPercent:  1, risk: 'GREEN'  },
      { name: 'Tether',                edges: tetherEdges, massPercent:  2, risk: 'YELLOW' },
    ],
  };
}

const DAUGHTER_SHAPE = buildDaughterShape();

export class DaughterWireframe {
  /**
   * @param {object}      [opts]
   * @param {HTMLElement} [opts.container]  Parent element — if null, appended to body.
   */
  constructor({ container = null } = {}) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.dpr  = dpr;

    this._canvas        = document.createElement('canvas');
    this._canvas.width  = PW * dpr;
    this._canvas.height = PH * dpr;
    Object.assign(this._canvas.style, {
      position:      'fixed',
      left:          `${ML}px`,
      bottom:        `${MB}px`,
      width:         `${PW}px`,
      height:        `${PH}px`,
      zIndex:        '12',
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

    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    const grad = this._ctx.createRadialGradient(WIRE_CX, WIRE_CY, 0, WIRE_CX, WIRE_CY, PW * 0.55);
    grad.addColorStop(0, 'rgba(0, 20, 50, 0.92)');
    grad.addColorStop(1, BG_COLOR);
    this._bgGradient = grad;

    this._shape     = DAUGHTER_SHAPE;
    this._visible   = false;
    this._zoneIndex = -1;
    this._angle     = 0;
    this._autoTimer = 0;
    this._projected = [];
    this._allocateProjectionBuffer(this._shape.vertices.length);

    /** @type {object|null} Currently tracked ArmUnit */
    this._arm     = null;
    /** @type {number} Net risk colour index, looked up by name so it survives zone-list changes. */
    this._netZoneIdx = this._shape.zones.findIndex(z => z.name === 'Net Pack');
    /** @type {number} §11.3 wheel-saturation accent target: the body shell carries the whole-craft warning;
     * looked up by name like the net index. */
    this._bodyZoneIdx = this._shape.zones.findIndex(z => z.name === 'Body Shell (hex)');
    /** @type {string} Dynamic status light color */
    this._statusColor = ZONE_COLORS.GREEN;
    /** @type {number} Arm index for badge label */
    this._armIndex = 0;

    this._onViewChange = ({ view } = {}) => {
      if (view === 'ARM_PILOT') {
        this.show();
      } else {
        this.hide();
      }
    };

    this._onStateChange = ({ to }) => {
      const gameplay = to === 'ORBITAL_VIEW' || to === 'APPROACH' ||
                       to === 'INTERACTION'  || to === 'ARM_PILOT';
      if (!gameplay) this.hide();
    };

    eventBus.on(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.on(Events.GAME_STATE_CHANGE,  this._onStateChange);
  }

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
   * Which arm this panel describes; HUD.update() passes `armManager.getPilotedArm()` each frame.
   * @param {object|null} arm  ArmUnit instance or null
   * @param {number}      [armIndex=0]
   */
  setPilotedArm(arm, armIndex = 0) {
    this._arm      = arm;
    this._armIndex = armIndex;

    if (!arm) return;

    const nets = arm.netInventory ?? arm._netInventory ?? 0;
    this._shape.zones[this._netZoneIdx].risk = nets > 0 ? 'GREEN' : 'RED';

    // §11.3 wheel-saturation accent: while the piloted arm's reaction wheels are saturated the body shell goes
    // risk RED, like the Net Pack flip above (the desat-surcharge WARNING itself lives on StatusPanel/comms).
    // Allocation-free: reads the backing field of getStatus()'s wheelSaturated pair (same idiom as
    // `netInventory ?? _netInventory`), since getStatus() builds a fresh literal per call.
    // false when DAUGHTER_NET_RECOIL is OFF (ArmUnit zeroes the pair) or on legacy mocks, so the panel
    // renders the design 'GREEN'.
    const wheelSat = arm.wheelSaturated ?? arm._wheelSaturated ?? false;
    this._shape.zones[this._bodyZoneIdx].risk = wheelSat ? 'RED' : 'GREEN';

    const mat = arm._statusLightMat;
    if (mat && mat.color) {
      const rgb = mat.color;
      const r   = Math.round(rgb.r * 255);
      const g   = Math.round(rgb.g * 255);
      const b   = Math.round(rgb.b * 255);
      this._statusColor = `rgb(${r},${g},${b})`;
    }
  }

  setZoneHighlight(zoneId) {
    if (zoneId == null) {
      this._zoneIndex = -1;
    } else {
      const n = this._shape.zones.length;
      this._zoneIndex = clamp(Math.round(zoneId), 0, n - 1);
    }
    this._autoTimer = 0;
  }

  cycleZone(dir) {
    const n = this._shape.zones.length;
    if (this._zoneIndex < 0) {
      this._zoneIndex = dir > 0 ? 0 : n - 1;
    } else {
      this._zoneIndex = ((this._zoneIndex + dir) % n + n) % n;
    }
    this._autoTimer = 0;
  }

  update(dt) {
    if (!this._visible || !this._shape) return;

    this._angle += 0.22 * dt;

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
    eventBus.off(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.off(Events.GAME_STATE_CHANGE,  this._onStateChange);
  }

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

    ctx.font      = mono(12, 'bold');
    ctx.textAlign = 'center';
    ctx.fillStyle = HEADER_COL;
    const armLabel = this._arm ? `DAUGHTER ${this._armIndex + 1}` : 'DAUGHTER PILOT';
    ctx.fillText(armLabel, WIRE_CX, 14);
    ctx.font      = mono(11);
    ctx.fillStyle = TYPE_COL;
    const stateLabel = this._arm ? `${this._arm.state || '. '}` : 'NO DAUGHTER PILOTED';
    ctx.fillText(stateLabel, WIRE_CX, 26);

    ctx.fillStyle = 'rgba(88,166,255,0.22)';
    ctx.fillRect(10, 30, W - 20, 1);

    if (!this._arm) {
      ctx.font      = mono(10);
      ctx.fillStyle = DIM_COL;
      ctx.textAlign = 'center';
      ctx.fillText(GestureHints.isGlass() ? '. Tap her row in DAUGHTERS to fly her. ' : '. Press 1–4 to pilot a daughter. ', WIRE_CX, WIRE_CY + 20);   // glass read at draw time (D7)
      return;
    }

    const cosY  = Math.cos(this._angle);
    const sinY  = Math.sin(this._angle);
    const verts = this._shape.vertices;
    const proj  = this._projected;

    for (let i = 0; i < verts.length; i++) {
      const vert = verts[i];
      rotateAndTilt(vert[0], vert[1], vert[2], cosY, sinY);
      const pz   = _rot[2] + PERSP_D;
      proj[i][0] = WIRE_CX + (_rot[0] / pz) * VIEW_SC;
      proj[i][1] = WIRE_CY - (_rot[1] / pz) * VIEW_SC;
      proj[i][2] = _rot[2];
    }

    const zones = this._shape.zones;
    ctx.save();
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      let color  = ZONE_COLORS[zone.risk] || WC.COLOR_LINE;
      if (zone.name === 'Status Light') color = this._statusColor;
      const highlighted = zi === this._zoneIndex;
      const edges       = zone.edges;

      if (highlighted) {
        ctx.strokeStyle = color;
        ctx.lineWidth   = 4;
        for (const [a, b] of edges) {
          if (a >= proj.length || b >= proj.length) continue;
          const avgZ      = (proj[a][2] + proj[b][2]) * 0.5;
          const frontness = clamp01((1 - avgZ) * 0.5);
          ctx.globalAlpha = 0.35 * frontness;
          ctx.beginPath();
          ctx.moveTo(proj[a][0], proj[a][1]);
          ctx.lineTo(proj[b][0], proj[b][1]);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = color;
      ctx.lineWidth   = highlighted ? 2 : 1;
      const baseAlpha = highlighted ? 0.90 : 0.55;
      for (const [a, b] of edges) {
        if (a >= proj.length || b >= proj.length) continue;
        const avgZ  = (proj[a][2] + proj[b][2]) * 0.5;
        const depT  = clamp01((avgZ + 1) * 0.5);
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
      let color     = ZONE_COLORS[zone.risk] || WC.COLOR_LINE;
      if (zone.name === 'Status Light') color = this._statusColor;
      const riskTxt = zone.risk === 'RED' ? 'HIGH' : zone.risk === 'YELLOW' ? 'MED' : 'LOW';

      ctx.font      = mono(11, 'bold');
      ctx.fillStyle = color;
      ctx.fillText(`[${zone.name.toUpperCase()}]`, WIRE_CX, infoY);

      ctx.font      = mono(10);
      ctx.fillStyle = color;
      let detail = `Mass: ${zone.massPercent}%   Risk: ${riskTxt}`;
      if (zone.name === 'Net Pack' && this._arm) {
        const nets = this._arm.netInventory ?? this._arm._netInventory ?? '?';
        detail = `Nets onboard: ${nets}`;
      }
      if (zone.name === 'Bridle Ring' && this._arm) {
        const br = this._arm.bridleRing;
        if (br && typeof br.getStatus === 'function') {
          const hp = br.getStatus(this._armIndex);
          detail = hp ? `HP: ${hp.join('/')}` : detail;
        }
      }
      ctx.fillText(detail, WIRE_CX, infoY + 13);
    } else {
      ctx.font      = mono(11);
      ctx.fillStyle = DIM_COL;
      ctx.fillText('SCANNING DAUGHTER CRAFT…', WIRE_CX, infoY);
    }
  }
}

export default DaughterWireframe;
