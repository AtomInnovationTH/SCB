/**
 * MotherCallouts.js — In-world 3D inspection callouts for the mothership.
 *
 * Replaces the separate 2D MotherWireframe pane: instead of forcing the player
 * to look back and forth between the 3D ship and a schematic panel, part labels,
 * leader lines and detail text are anchored directly onto the real model in the
 * world.
 *
 * Zoom-driven level-of-detail (player request, 2026-06-03) keeps clutter under
 * control — the closer you zoom, the more detail is revealed:
 *
 *   Band 1  SYSTEM   (far, ~12–8 m)  : 5 system-group labels only (POWER /
 *                                       PROPULSION / PAYLOAD / SENSORS /
 *                                       CAPTURE).
 *   Band 2  PART     (mid, ~8–4 m)   : every part label + mass/risk detail; the
 *                                       system labels fade out.
 *   Band 3  COMPONENT(close, <4 m)   : the part nearest screen-centre gets a
 *                                       brightened focus + live data line.
 *
 * Within a band, labels on the far side of the hull fade by camera-facing angle
 * so the near side stays readable. Band edges use hysteresis (Schmitt trigger)
 * so labels don't flicker when the camera parks on a boundary.
 *
 * First time inspection engages, a one-shot "guided pulse" sweeps a highlight
 * through the five systems so a new player learns the vocabulary passively.
 *
 * Gating mirrors the hull outline (PlayerSatellite): active while either the
 * discrete INSPECTION view (CAMERA_VIEW_CHANGE) or the OVERVIEW zoom sub-state
 * (INSPECT_HULL_OUTLINE) reports inspection on.
 *
 * @module ui/MotherCallouts
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { createLabelTexture } from '../scene/labelTexture.js';

// 1 metre in scene units (mirrors PlayerSatellite's M = 0.00001).
const M = 0.00001;

const RISK = {
  GREEN:  Constants.WIREFRAMES?.COLOR_GREEN  ?? '#3fb950',
  YELLOW: Constants.WIREFRAMES?.COLOR_YELLOW ?? '#d29922',
  RED:    Constants.WIREFRAMES?.COLOR_RED    ?? '#f85149',
};
const RISK_TXT = { GREEN: 'LOW', YELLOW: 'MED', RED: 'HIGH' };

// ----------------------------------------------------------------------------
// SYSTEM / PART ANCHOR TABLE
// ----------------------------------------------------------------------------
// Anchors are LOCAL model coordinates (parented to the PlayerSatellite group,
// so they track the ship's transform). `anchor` is the point on the part the
// leader line touches; `labelOffset` is where the text sprite sits (offset
// outward so it floats beside the ship). Values in metres × M, taken from the
// real model build in PlayerSatellite.js (+Z fore, −Z aft, XY radial; barrel
// r=0.40, L=2.0 → caps at z=±1.0; collar at z=+0.90).
//
// `tier`:
//   'major'  → shown in the PART band (mid zoom) and COMPONENT band.
//   'detail' → fine sub-part; shown ONLY in the COMPONENT band, and only when
//              its system owns the focused part (so deep-zoom reveals detail
//              instead of crowding the mid band).
// The five player-facing systems regroup the 11 MotherWireframe zones plus the
// previously un-labelled hardware (MLI bands, tether reels, crossbow springs,
// EO/IR/LIDAR split, nav/strobe lights, daughter pockets).
const SYSTEMS = [
  {
    id: 'POWER', label: 'POWER',
    anchor: [ 1.0 * M, 0, 0 ],
    labelOffset: [ 1.9 * M, 1.0 * M, 0 ],
    parts: [
      { name: 'ROSA SOLAR WINGS', mass: 18, risk: 'GREEN', tier: 'major',
        anchor: [ 1.1 * M, 0, 0 ], labelOffset: [ 2.0 * M, 0.5 * M, 0 ] },
      { name: 'BODY SOLAR CELLS', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.40 * M, 0, 0.30 * M ], labelOffset: [ 1.0 * M, 0.55 * M, 0.30 * M ] },
      { name: 'ARRAY ROLL', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.45 * M, 0, 0 ], labelOffset: [ 0.95 * M, -0.45 * M, 0 ] },
    ],
  },
  {
    id: 'PROPULSION', label: 'PROPULSION',
    anchor: [ 0, 0, -1.0 * M ],
    labelOffset: [ 0, -1.3 * M, -1.3 * M ],
    parts: [
      { name: 'FEEP ION THRUSTERS', mass: 6, risk: 'YELLOW', tier: 'major',
        anchor: [ 0, -0.20 * M, -1.05 * M ], labelOffset: [ -1.1 * M, -1.0 * M, -1.2 * M ] },
      { name: 'RCS ATTITUDE', mass: 2, risk: 'GREEN', tier: 'major',
        anchor: [ -0.03 * M, 0.42 * M, -0.795 * M ], labelOffset: [ 1.2 * M, 1.0 * M, -0.9 * M ] },
      { name: 'MLI THERMAL BANDS', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.43 * M, 0, 0.50 * M ], labelOffset: [ 1.1 * M, 0.5 * M, 0.50 * M ] },
    ],
  },
  {
    id: 'PAYLOAD', label: 'PAYLOAD',
    anchor: [ 0, 0.10 * M, 1.05 * M ],
    labelOffset: [ -1.4 * M, 1.4 * M, 1.2 * M ],
    parts: [
      { name: 'LASER APERTURE', mass: 6, risk: 'RED', tier: 'major',
        anchor: [ 0, 0.20 * M, 1.0 * M ], labelOffset: [ -1.3 * M, 0.7 * M, 1.1 * M ] },
      { name: 'DOCKING PORT', mass: 3, risk: 'GREEN', tier: 'major',
        anchor: [ 0, -0.15 * M, 1.10 * M ], labelOffset: [ -1.2 * M, -0.8 * M, 1.1 * M ] },
    ],
  },
  {
    id: 'SENSORS', label: 'SENSORS',
    // Articulating sensor turret on the fore cap (+Z), offset +Y. Group label
    // floats up-and-right so it doesn't collide with PAYLOAD's fore-cap label.
    anchor: [ 0, 0.40 * M, 1.15 * M ],
    labelOffset: [ 1.5 * M, 1.4 * M, 1.0 * M ],
    parts: [
      { name: 'SENSOR GIMBAL', mass: 4, risk: 'GREEN', tier: 'major',
        anchor: [ 0, 0.40 * M, 1.15 * M ], labelOffset: [ 1.4 * M, 1.0 * M, 1.0 * M ] },
      { name: 'EO CAMERA', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.25 * M, 0.25 * M, 1.10 * M ], labelOffset: [ 1.1 * M, 0.55 * M, 1.0 * M ] },
      { name: 'IR SENSOR', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ -0.25 * M, 0.25 * M, 1.10 * M ], labelOffset: [ -1.1 * M, 0.45 * M, 1.0 * M ] },
      { name: 'LIDAR DOME', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0, 0.40 * M, 1.15 * M ], labelOffset: [ 0.55 * M, 1.3 * M, 1.0 * M ] },
      { name: 'NAV LIGHTS', mass: 1, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.42 * M, 0, 0.30 * M ], labelOffset: [ 1.1 * M, -0.2 * M, 0.30 * M ] },
    ],
  },
  {
    id: 'CAPTURE', label: 'CAPTURE',
    anchor: [ 0, 0.40 * M, 0.90 * M ],
    labelOffset: [ 0, 1.5 * M, 0.5 * M ],
    parts: [
      { name: 'CAPTURE DAUGHTERS', mass: 9, risk: 'YELLOW', tier: 'major', live: 'arms',
        anchor: [ 0.20 * M, 0.346 * M, 0.90 * M ], labelOffset: [ 1.3 * M, 1.0 * M, 0.6 * M ] },
      { name: 'MAIN BUS', mass: 35, risk: 'GREEN', tier: 'major', omnipresent: true,
        anchor: [ 0, 0.40 * M, 0 ], labelOffset: [ -1.6 * M, -0.2 * M, 0 ] },
      { name: 'HINGE PIVOTS', mass: 0, risk: 'YELLOW', tier: 'detail',
        anchor: [ 0.22 * M, 0.381 * M, 0.90 * M ], labelOffset: [ 1.1 * M, 0.65 * M, 0.85 * M ] },
      { name: 'TETHER REELS', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.20 * M, 0.346 * M, 0.55 * M ], labelOffset: [ 1.15 * M, 0.3 * M, 0.4 * M ] },
      { name: 'CRADLE SPRING', mass: 0, risk: 'YELLOW', tier: 'detail',
        anchor: [ 0.20 * M, 0.346 * M, 0.20 * M ], labelOffset: [ 1.1 * M, -0.3 * M, 0.1 * M ] },
      { name: 'DAUGHTER POCKETS', mass: 0, risk: 'GREEN', tier: 'detail',
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ], labelOffset: [ 1.1 * M, 0.3 * M, -0.7 * M ] },
    ],
  },
];

// LOD band edges, in METRES of camera-to-ship distance. Hysteresis: descend
// (zoom in) on the lower number, ascend (zoom out) on the higher.
const BAND = {
  // SYSTEM ↔ PART
  partIn:  8.0,  partOut:  9.0,
  // PART ↔ COMPONENT
  compIn:  4.0,  compOut:  4.8,
};

const GUIDE_STEP_S = 1.1;   // seconds each system stays highlighted in the tour
const GUIDE_HOLD_S = 0.6;   // initial hold before the tour starts

const FADE_RATE = 6.0;      // opacity ease rate (~165 ms to 63%) for band crossfades
// Leader lines read as the *connection*, so keep them proportionally present
// relative to their (lighter, smaller) label rather than as a vanishing hairline.
const LINE_OP_FLOOR = 0.7;  // min line opacity (× label op) once a label is visible
const LINE_OP_SCALE = 0.95; // line opacity = labelOp * this (clamped to floor)
// Leader ribbon half-width as a fraction of camera→ship distance, so the leader
// holds a steady on-screen thickness across the zoom bands instead of the 1px
// hairline a LineBasicMaterial collapses to on most GPUs. ~0.0024 reads as a
// clear ~3px connector at typical inspection range.
const LINE_HALF_WIDTH_FRAC = 0.0024;
const DECLUTTER_NDC = 0.072; // min vertical screen gap between labels (NDC units)

export class MotherCallouts {
  /**
   * @param {THREE.Object3D} playerGroup  The PlayerSatellite group (labels parent here).
   * @param {THREE.Camera}   camera
   * @param {object} [opts]
   * @param {object|null} [opts.armManager]  For the live "x/4 ARMS DOCKED" line.
   */
  constructor(playerGroup, camera, { armManager = null } = {}) {
    this.player = playerGroup;
    this.camera = camera;
    this.armManager = armManager;

    this._active = false;       // inspection engaged?
    this._band = 'SYSTEM';      // current LOD band (hysteresis output)
    this._guideT = -1;          // guided-pulse timer (<0 = not running / done)
    this._guidedDone = false;   // one-shot: tour only on first inspection
    this._focusPart = null;     // nearest-to-centre part in COMPONENT band

    // Reusable scratch vectors (zero per-frame alloc).
    this._vShip = new THREE.Vector3();
    this._vCam = new THREE.Vector3();
    this._vAnchor = new THREE.Vector3();
    this._vLabel = new THREE.Vector3();
    this._vTmp = new THREE.Vector3();
    this._vFace = new THREE.Vector3();
    this._vCamDir = new THREE.Vector3();
    this._qTmp = new THREE.Quaternion();
    // Ribbon-leader scratch (world-space endpoints + perpendicular).
    this._rA = new THREE.Vector3();
    this._rB = new THREE.Vector3();
    this._rDir = new THREE.Vector3();
    this._rView = new THREE.Vector3();
    this._rPerp = new THREE.Vector3();
    this._rC0 = new THREE.Vector3();
    this._rC1 = new THREE.Vector3();
    this._rC2 = new THREE.Vector3();
    this._rC3 = new THREE.Vector3();
    this._vCamLocal = new THREE.Vector3();   // camera position in player-local space
    this._leaderHalfWidth = 0;               // local-space half-width for leader ribbons

    this._group = new THREE.Group();
    this._group.name = 'MotherCallouts';
    this._group.visible = false;
    this.player.add(this._group);

    this._systemLabels = [];  // { def, sprite, line }
    this._partLabels = [];    // { def, sysId, sprite, detailSprite, line }
    this._build();

    // Gating — same two signals that drive the hull outline. They are
    // INDEPENDENT inputs: the discrete INSPECTION view reports via
    // CAMERA_VIEW_CHANGE, the OVERVIEW zoom sub-state via INSPECT_HULL_OUTLINE
    // (which keeps the view as ORBIT). We OR them so a CAMERA_VIEW_CHANGE to
    // ORBIT (fired during the zoom path) can't clobber the hull-outline signal
    // and cause the active flag to flip-flop.
    this._viewInspect = false;   // discrete INSPECTION view active?
    this._zoomInspect = false;   // OVERVIEW zoom sub-state active?
    this._onViewChange = ({ view } = {}) => {
      this._viewInspect = (view === 'INSPECTION');
      this._setActive(this._viewInspect || this._zoomInspect);
    };
    this._onHullOutline = ({ visible } = {}) => {
      this._zoomInspect = !!visible;
      this._setActive(this._viewInspect || this._zoomInspect);
    };
    eventBus.on(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.on(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
  }

  // --------------------------------------------------------------------------
  // BUILD
  // --------------------------------------------------------------------------

  _makeSprite(text, color, fontPx, scaleM, pill = false) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createLabelTexture(text, { color, fontPx, pill }),
      transparent: true, opacity: 1.0, depthWrite: false, depthTest: false,
    }));
    // Sprite scale is in scene units; label canvas is 4:1 (1024×256).
    sprite.scale.set(scaleM * 4, scaleM, 1);
    sprite.renderOrder = 30;
    sprite.frustumCulled = false;
    return sprite;
  }

  /**
   * Build a leader as a thin, camera-facing ribbon (a 2-triangle quad) rather
   * than a THREE.Line. LineBasicMaterial.linewidth is ignored by most WebGL
   * drivers (clamped to 1px hairline), so the leader vanished against the
   * heavier label text. A quad gives genuine, GPU-independent thickness without
   * pulling in Line2/LineMaterial from the examples addons.
   *
   * Geometry is 4 vertices / 2 triangles; positions are rewritten each frame in
   * {@link _setLineLocal} so the ribbon hugs the anchor→label segment and keeps
   * a constant on-screen width regardless of zoom.
   * @private
   */
  _makeLine(color) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)); // 4 verts
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(geo, mat);
    line.renderOrder = 29;
    line.frustumCulled = false;
    return line;
  }

  /** Shared soft-dot texture for leader anchor markers. @private */
  static _dotTexture() {
    if (MotherCallouts._dotTex) return MotherCallouts._dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.25)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    MotherCallouts._dotTex = t;
    return t;
  }

  /** Small filled marker placed where a leader line touches its part. @private */
  _makeDot(color, scaleM) {
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: MotherCallouts._dotTexture(),
      color: new THREE.Color(color),
      transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
    }));
    dot.scale.set(scaleM, scaleM, 1);
    dot.renderOrder = 31;
    dot.frustumCulled = false;
    return dot;
  }

  _build() {
    for (const sys of SYSTEMS) {
      // System-group label (Band 1). Smaller + pill chip so the heavy text no
      // longer dwarfs the hairline leader; lighter blue keeps it secondary.
      const sLabel = this._makeSprite(sys.label, '#cfe6ff', 84, 0.72 * M, true);
      const sLine = this._makeLine(0x88c0ff);
      const sDot = this._makeDot(0x9fd0ff, 0.18 * M);
      this._group.add(sLine, sDot, sLabel);
      this._systemLabels.push({ def: sys, sprite: sLabel, line: sLine, dot: sDot, op: 0 });

      // Per-part labels (Bands 2/3). Detail-tier parts are smaller and only
      // appear in the COMPONENT band near the focused major part.
      for (const part of sys.parts) {
        const isDetail = part.tier === 'detail';
        const color = RISK[part.risk] || '#ffffff';
        const pLabel = this._makeSprite(part.name, color, isDetail ? 56 : 70,
          (isDetail ? 0.42 : 0.58) * M, true);
        // Detail line ("Mass: X%  Risk: Y" / live data) — shown only in Band 3
        // for major parts (detail-tier parts have no secondary line).
        const detail = `Mass: ${part.mass}%   Risk: ${RISK_TXT[part.risk]}`;
        const dLabel = isDetail ? null
          : this._makeSprite(detail, '#c8d6e5', 54, 0.42 * M, true);
        if (dLabel) dLabel.userData.detail = true;
        const pLine = this._makeLine(color);
        const pDot = this._makeDot(color, (isDetail ? 0.11 : 0.15) * M);
        this._group.add(pLine, pDot, pLabel);
        if (dLabel) this._group.add(dLabel);
        this._partLabels.push({
          def: part, sysId: sys.id, isDetail, sprite: pLabel, detailSprite: dLabel,
          line: pLine, dot: pDot, op: 0,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // ACTIVATION
  // --------------------------------------------------------------------------

  _setActive(on) {
    if (this._active === on) return;
    this._active = on;
    this._group.visible = on;
    if (on) {
      // Start the one-shot guided tour the first time only.
      if (!this._guidedDone) this._guideT = -GUIDE_HOLD_S;
      this._band = 'SYSTEM';
    } else {
      this._guideT = -1;
      this._focusPart = null;
    }
  }

  // --------------------------------------------------------------------------
  // PER-FRAME UPDATE
  // --------------------------------------------------------------------------

  /**
   * @param {number} dt  seconds
   * @param {object} [armManager]  optional live arm manager (for the arms line)
   */
  update(dt, armManager) {
    if (armManager) this.armManager = armManager;
    if (!this._active || !this.camera) return;

    // Ensure the ship's world matrix reflects this frame's transform before we
    // read it for anchor/line/facing math (render() refreshes matrices later).
    this.player.updateWorldMatrix(true, false);

    // Camera → ship distance in metres.
    this.player.getWorldPosition(this._vShip);
    this._vCam.copy(this.camera.position);
    const distWorld = this._vCam.distanceTo(this._vShip);
    const distM = distWorld / M;

    // Camera position in player-local space, plus the leader ribbon half-width
    // (scaled by distance → constant on-screen thickness). Both are consumed by
    // _setLineLocal when it rebuilds each leader quad this frame.
    this._vCamLocal.copy(this._vCam);
    this.player.worldToLocal(this._vCamLocal);
    this._leaderHalfWidth = distWorld * LINE_HALF_WIDTH_FRAC;

    this._updateBand(distM);
    this._updateGuide(dt);

    // Ship-centre → camera direction (world), for facing fade.
    this._vCamDir.copy(this._vCam).sub(this._vShip).normalize();
    const camDirWorld = this._vCamDir;

    // Determine focus part in COMPONENT band (nearest label to screen centre).
    if (this._band === 'COMPONENT') this._focusPart = this._pickFocusPart();
    else this._focusPart = null;

    this._layoutSystemLabels(camDirWorld, dt);
    this._layoutPartLabels(camDirWorld, dt);
    this._declutter();
  }

  /** Hysteresis band selection. @private */
  _updateBand(distM) {
    const b = this._band;
    if (b === 'SYSTEM') {
      if (distM < BAND.partIn) this._band = 'PART';
    } else if (b === 'PART') {
      if (distM > BAND.partOut) this._band = 'SYSTEM';
      else if (distM < BAND.compIn) this._band = 'COMPONENT';
    } else { // COMPONENT
      if (distM > BAND.compOut) this._band = 'PART';
    }
  }

  /** Advance the one-shot guided pulse. @private */
  _updateGuide(dt) {
    if (this._guideT < -GUIDE_HOLD_S - 0.001 || this._guidedDone) return;
    this._guideT += dt;
    const total = SYSTEMS.length * GUIDE_STEP_S;
    if (this._guideT >= total) {
      this._guidedDone = true;
      this._guideT = -1;
    }
  }

  /** Which system (if any) the guided pulse is currently highlighting. @private */
  _guideSystemId() {
    if (this._guidedDone || this._guideT < 0) return null;
    const idx = Math.floor(this._guideT / GUIDE_STEP_S);
    return SYSTEMS[idx]?.id ?? null;
  }

  /** Nearest MAJOR part-label to screen centre (NDC) for COMPONENT focus. @private */
  _pickFocusPart() {
    let best = null, bestD = Infinity;
    for (const p of this._partLabels) {
      if (p.isDetail) continue; // detail parts never become the focus
      this._vAnchor.set(...p.def.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vTmp.copy(this._vAnchor).project(this.camera);
      if (this._vTmp.z > 1) continue; // behind camera
      const d = this._vTmp.x * this._vTmp.x + this._vTmp.y * this._vTmp.y;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Opacity from camera-facing angle: labels whose outward direction faces the
   * camera stay bright; far-side labels fade. `outwardLocal` is the label's
   * local offset direction; we compare it (in world) to the ship→camera dir.
   * @private
   */
  _facingOpacity(labelOffsetLocal, camDirWorld) {
    // World-space outward direction of the label from ship centre.
    this._vFace.set(labelOffsetLocal[0], labelOffsetLocal[1], labelOffsetLocal[2]);
    // Rotate into world (ignore translation): use ship quaternion.
    this._vFace.applyQuaternion(this.player.getWorldQuaternion(this._qTmp));
    if (this._vFace.lengthSq() < 1e-20) return 1;
    this._vFace.normalize();
    const d = this._vFace.dot(camDirWorld); // 1 = faces camera, -1 = away
    // Map [-1,1] → [0.12, 1]; keep a little visibility on the back side.
    return 0.12 + 0.88 * Math.max(0, (d + 0.25) / 1.25);
  }

  /**
   * Visibility gate for the PART ITSELF (not the label): is the anchor point on
   * the camera-facing side of the hull, or hidden behind the barrel? We treat
   * the anchor's direction from ship centre as its surface normal and dot it
   * with the ship→camera direction. Parts on the far side (normal points away)
   * return ~0 so their callout + dot fade out — you shouldn't see a marker on
   * geometry occluded by the hull. Cheap proxy (no raycast): correct for the
   * convex barrel + caps that make up the bus. Returns 0..1.
   * @private
   */
  _anchorVisible(anchorLocal, camDirWorld) {
    this._vFace.set(anchorLocal[0], anchorLocal[1], anchorLocal[2]);
    this._vFace.applyQuaternion(this.player.getWorldQuaternion(this._qTmp));
    if (this._vFace.lengthSq() < 1e-20) return 1; // centre-anchored (e.g. bus) — always ok
    this._vFace.normalize();
    const d = this._vFace.dot(camDirWorld); // 1 = anchor faces camera, -1 = behind hull
    // Hard-ish gate: fully visible facing the camera, fading to 0 as it rounds
    // past the limb (d ≈ 0). Slightly past the limb (d < -0.1) → hidden.
    return Math.max(0, Math.min(1, (d + 0.1) / 0.45));
  }

  // Labels and lines are children of _group (a child of the player), so their
  // positions are expressed in PLAYER-LOCAL space — the anchor/offset arrays
  // are already in that space. (Earlier bug: these were set to world coords via
  // localToWorld, which then got compounded by the parent transform and flung
  // the labels ~67 units out to the ship's orbital position.)
  _setLabelLocal(sprite, offset) {
    sprite.position.set(offset[0], offset[1], offset[2]);
  }

  /**
   * Rewrite a leader ribbon's 4 corners so it spans fromLocal→toLocal as a thin
   * camera-facing quad of (roughly) constant on-screen width.
   *
   * All math is done in player-LOCAL space (the ribbon mesh is a child of
   * `_group`): we take the segment direction and the local view direction
   * (segment-midpoint → camera, in local space), cross them for an in-view-plane
   * perpendicular, and push the two endpoints ±halfWidth along it.
   * @private
   */
  _setLineLocal(line, fromLocal, toLocal, opacity, color) {
    const a = this._rA.set(fromLocal[0], fromLocal[1], fromLocal[2]);
    const b = this._rB.set(toLocal[0], toLocal[1], toLocal[2]);

    // View direction in local space: from segment midpoint toward the camera.
    // (this._vCamLocal is refreshed once per frame in update().)
    this._rView.copy(this._vCamLocal)
      .sub(this._rC0.copy(a).add(b).multiplyScalar(0.5));

    this._rDir.copy(b).sub(a);
    this._rPerp.copy(this._rDir).cross(this._rView);
    if (this._rPerp.lengthSq() < 1e-30) {
      // Degenerate (segment points straight at camera) — fall back to up-ish.
      this._rPerp.set(0, 1, 0).cross(this._rDir);
    }
    this._rPerp.normalize().multiplyScalar(this._leaderHalfWidth || 0);

    // Quad corners: a-side then b-side, wound CCW for the [0,1,2,0,2,3] index.
    this._rC0.copy(a).add(this._rPerp);   // 0
    this._rC1.copy(a).sub(this._rPerp);   // 1
    this._rC2.copy(b).sub(this._rPerp);   // 2
    this._rC3.copy(b).add(this._rPerp);   // 3

    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, this._rC0.x, this._rC0.y, this._rC0.z);
    pos.setXYZ(1, this._rC1.x, this._rC1.y, this._rC1.z);
    pos.setXYZ(2, this._rC2.x, this._rC2.y, this._rC2.z);
    pos.setXYZ(3, this._rC3.x, this._rC3.y, this._rC3.z);
    pos.needsUpdate = true;
    line.material.opacity = opacity;
    if (color !== undefined) line.material.color.set(color);
  }

  /**
   * Pick the label offset on the camera-facing side so the leader doesn't spear
   * through the hull to reach a label hiding behind the model. We flip the
   * lateral (X) component of the offset to match the side the camera is on.
   * Writes into the provided 3-array `out`.
   * @private
   */
  _facingSideOffset(offset, out) {
    out[0] = offset[0]; out[1] = offset[1]; out[2] = offset[2];
    // Camera position in the ship's local frame.
    this._vTmp.copy(this._vCam);
    this.player.worldToLocal(this._vTmp);
    // If the label's lateral side is opposite the camera, mirror X.
    if (Math.sign(out[0] || 1) !== Math.sign(this._vTmp.x || out[0] || 1)
        && Math.abs(this._vTmp.x) > 0.05 * M) {
      out[0] = -out[0];
    }
    return out;
  }

  /** Ease one label record's opacity toward target, apply to label/line/dot. @private */
  _applyLabel(rec, targetOp, dt, offset, color, lineColor) {
    rec.op += (targetOp - rec.op) * Math.min(1, FADE_RATE * dt);
    const op = rec.op;
    const visible = op > 0.02;

    rec.sprite.material.opacity = op;
    rec.sprite.visible = visible;
    this._setLabelLocal(rec.sprite, offset);

    // Leader line: keep proportionally present relative to the label, with a
    // floor so it never dwindles to an invisible hairline while text shouts.
    const lineOp = visible ? Math.max(op * LINE_OP_FLOOR, op * LINE_OP_SCALE) : 0;
    this._setLineLocal(rec.line, rec.def.anchor, offset, lineOp, lineColor);
    rec.line.visible = visible;

    // Anchor dot at the part end of the leader.
    if (rec.dot) {
      rec.dot.position.set(rec.def.anchor[0], rec.def.anchor[1], rec.def.anchor[2]);
      rec.dot.material.opacity = op;
      rec.dot.visible = visible;
    }
  }

  /** Band 1 group labels. @private */
  _layoutSystemLabels(camDirWorld, dt) {
    const showGroups = this._band === 'SYSTEM';
    const guideId = this._guideSystemId();
    for (const s of this._systemLabels) {
      let op = showGroups ? this._facingOpacity(s.def.labelOffset, camDirWorld) : 0;
      // Guided pulse: brighten the highlighted system, dim the rest.
      if (guideId) op = (s.def.id === guideId) ? 1.0 : op * 0.25;
      const off = this._facingSideOffset(s.def.labelOffset, s._off || (s._off = [0, 0, 0]));
      this._applyLabel(s, op, dt, off, undefined, 0x88c0ff);
    }
  }

  /** Bands 2/3 part labels + detail/live text. @private */
  _layoutPartLabels(camDirWorld, dt) {
    const band = this._band;
    const guideId = this._guideSystemId();
    const focusSys = this._focusPart?.sysId ?? null;

    for (const p of this._partLabels) {
      let op;
      if (p.isDetail) {
        // Detail tier: revealed only at closest zoom, and only for the system
        // that owns the focused part — deep-zoom shows fine detail without
        // crowding the mid band.
        const reveal = band === 'COMPONENT' && p.sysId === focusSys;
        op = reveal ? this._facingOpacity(p.def.labelOffset, camDirWorld) : 0;
      } else {
        // Major tier: PART + COMPONENT bands.
        const showParts = band === 'PART' || band === 'COMPONENT';
        op = showParts ? this._facingOpacity(p.def.labelOffset, camDirWorld) : 0;
        if (guideId && showParts) op = (p.sysId === guideId) ? op : op * 0.2;
        const isFocus = band === 'COMPONENT' && this._focusPart === p;
        if (band === 'COMPONENT' && !isFocus) op *= 0.4; // de-emphasise non-focus majors
      }

      const color = RISK[p.def.risk] || '#ffffff';
      // Gate by whether the PART itself is on the camera-facing side of the
      // hull — don't draw a marker/leader on geometry hidden behind the barrel.
      // `omnipresent` parts (e.g. the whole bus barrel) skip the gate.
      if (!p.def.omnipresent) op *= this._anchorVisible(p.def.anchor, camDirWorld);
      const off = this._facingSideOffset(p.def.labelOffset, p._off || (p._off = [0, 0, 0]));
      this._applyLabel(p, op, dt, off, color, color);

      // Secondary detail/live line — only major parts, only when focused.
      if (p.detailSprite) {
        const isFocus = band === 'COMPONENT' && this._focusPart === p;
        if (isFocus) {
          this._refreshDetail(p);
          const dOff = [ off[0], off[1] - 0.42 * M, off[2] ];
          this._setLabelLocal(p.detailSprite, dOff);
          p.detailSprite.material.opacity = p.op;
          p.detailSprite.visible = p.op > 0.02;
        } else if (p.detailSprite.visible) {
          p.detailSprite.material.opacity = 0;
          p.detailSprite.visible = false;
        }
      }
    }
  }

  /**
   * Screen-space declutter: project visible labels to NDC and, where two would
   * overlap vertically, nudge the lower one's local Y down so stacked labels
   * separate. Operates on local Y because labels are camera-billboarded sprites;
   * a small local-Y push reads as vertical separation on screen.
   *
   * Runs a few relaxation passes so chains of 3+ stacked labels (common on the
   * fore cap where SENSORS / PAYLOAD / CAPTURE crowd together) fully fan out
   * rather than just splitting the first colliding pair. The leader ribbon is
   * rebuilt for each nudged label so it keeps tracking the moved text.
   * @private
   */
  _declutter() {
    const NUDGE = 0.26 * M;   // local-Y push per overlap (was 0.18×M)
    const PASSES = 3;
    for (let pass = 0; pass < PASSES; pass++) {
      const items = [];
      const all = [...this._systemLabels, ...this._partLabels];
      for (const rec of all) {
        if (!rec.sprite.visible) continue;
        this._vTmp.copy(rec.sprite.position);
        this.player.localToWorld(this._vTmp);
        this._vTmp.project(this.camera);
        if (this._vTmp.z > 1) continue;
        items.push({ rec, x: this._vTmp.x, y: this._vTmp.y });
      }
      items.sort((a, b) => b.y - a.y); // top-down
      let moved = false;
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1], b = items[i];
        const dx = Math.abs(a.x - b.x);
        const dy = a.y - b.y;
        if (dx < DECLUTTER_NDC * 3 && dy < DECLUTTER_NDC) {
          b.rec.sprite.position.y -= NUDGE;
          // Rebuild the leader ribbon so it still reaches the nudged label.
          this._setLineLocal(
            b.rec.line, b.rec.def.anchor,
            [b.rec.sprite.position.x, b.rec.sprite.position.y, b.rec.sprite.position.z],
            b.rec.line.material.opacity, b.rec.line.material.color,
          );
          b.y -= DECLUTTER_NDC; // approximate so subsequent comparisons use new pos
          moved = true;
        }
      }
      if (!moved) break; // settled — skip remaining passes
    }
  }

  /** Rebuild the detail texture when live data changes (arms docked count). @private */
  _refreshDetail(p) {
    let text;
    if (p.def.live === 'arms' && this.armManager) {
      const arms = this.armManager.getArms?.() || this.armManager.arms || [];
      const docked = arms.filter(a => a?.state === 'DOCKED').length;
      text = `${docked}/${arms.length || 4} DAUGHTERS DOCKED`;
    } else {
      text = `Mass: ${p.def.mass}%   Risk: ${RISK_TXT[p.def.risk]}`;
    }
    if (p._detailText === text) return; // no change — skip canvas rebuild
    p._detailText = text;
    const old = p.detailSprite.material.map;
    p.detailSprite.material.map = createLabelTexture(text, { color: '#c8d6e5', fontPx: 54, pill: true });
    p.detailSprite.material.needsUpdate = true;
    if (old) old.dispose();
  }

  dispose() {
    eventBus.off?.(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.off?.(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
    const sprites = [...this._systemLabels, ...this._partLabels];
    for (const s of sprites) {
      s.sprite?.material?.map?.dispose();
      s.sprite?.material?.dispose();
      s.detailSprite?.material?.map?.dispose();
      s.detailSprite?.material?.dispose();
      s.line?.geometry?.dispose();
      s.line?.material?.dispose();
      s.dot?.material?.dispose(); // shared dot texture not disposed (static singleton)
    }
    this.player.remove(this._group);
  }
}
