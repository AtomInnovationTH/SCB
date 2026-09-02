/**
 * MotherCallouts.js — In-world 3D inspection callouts for the mothership.
 *
 * Part labels, leader lines and detail cards are anchored onto the real model
 * in the world (no separate 2D schematic pane). A screen-space side-rail layout
 * flanks the ship with two stacked columns of cards joined to their anchors by
 * elbow leaders, so labels never crowd the fore cap or cross each other.
 *
 * Zoom-driven level-of-detail keeps clutter under control:
 *
 *   Band 1  SYSTEM   (far, ~12–8 m)  : 6 system-group labels only.
 *   Band 2  PART     (mid, ~8–5.5 m) : every major part card; system labels fade.
 *   Band 3  COMPONENT(close, <5.5 m) : the part nearest screen-centre gets a
 *                                       full detail card (specs + TRL + live data)
 *                                       placed by its anchor; its system's detail
 *                                       sub-parts appear on the rails.
 *
 * Identity: hue = system (6 hues), risk = a small badge dot on the card. Anchors
 * on the far side of the hull fade by camera-facing angle (dot-product proxy).
 * Card positions ease in SCREEN space (NDC) so ship rotation reads as smooth
 * sliding rather than object-space wobble. Rail side and stack order use
 * hysteresis so orbiting doesn't thrash sides or flash leader crossings.
 *
 * First time inspection engages, a one-shot "guided pulse" sweeps a highlight
 * through the systems so a new player learns the vocabulary passively.
 *
 * Gating mirrors the hull outline: active while either the discrete INSPECTION
 * view (CAMERA_VIEW_CHANGE) or the OVERVIEW zoom sub-state (INSPECT_HULL_OUTLINE)
 * reports inspection on.
 *
 * Render pipeline (corrects the round-1 plan note): the callout group is a child
 * of `player`, and SceneManager._updateNearCamera() re-tags every near-field root
 * subtree onto NEAR_FIELD_LAYER EVERY FRAME (SceneManager.js:966-975), so these
 * sprites render in the NEAR pass alongside the hull — after clearDepth(), so the
 * hull can never overpaint them. The pass's uniform ×1e5 camera-relative scale is
 * applied to the shared root, and every position here goes through
 * player.worldToLocal / local anchors, so screen size and position are preserved
 * exactly. Near-plane clipping of dots/leader tips is provably dead: min inspect
 * distance is 2 m (CameraSystem.js:208) vs a 1.33 m clip threshold for the
 * fore-most anchor (1.3 m) — unreachable.
 *
 * @module ui/MotherCallouts
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { createCardTexture, CARD_W_OVER_TITLE_H, wrapHint } from '../scene/labelTexture.js';
import { orderRail } from '../scene/railOrder.js';

// 1 metre in scene units (mirrors PlayerSatellite's M = 0.00001).
const M = 0.00001;
const DEG2RAD = Math.PI / 180;

const CFG = Constants.CALLOUTS;
const HUES = CFG.SYSTEM_HUES;
const RISK = CFG.RISK_COLORS;

// ----------------------------------------------------------------------------
// SYSTEM / PART ANCHOR TABLE
// ----------------------------------------------------------------------------
// Anchors are LOCAL model coordinates (parented to the PlayerSatellite group),
// in metres × M, taken from the real model build in PlayerSatellite.js
// (+Z fore, −Z aft, XY radial; barrel r=0.40, L=2.0 → caps at z=±1.0).
//
// Per part:
//   id       stable lookup key (tests + internal; display copy may change freely).
//   tier     'major' → PART + COMPONENT bands; 'detail' → COMPONENT band only,
//            and only when its system owns the focused part OR it sits near the
//            focused part on screen (proximity reveal, T6).
//   massKg   real-flavoured dry mass (kg) shown on the detail card.
//   specs    1–2 static spec lines for the detail card.
//   priority higher = kept when a rail overflows (culling drops lowest first).
//   risk     GREEN/YELLOW/RED → badge dot colour.
//   codexId  existing codex entry id/alias → clickable deep-link.
//   live     id consumed by _liveRows() for phase-2 dynamic rows (optional).
//   mesh     PlayerSatellite mesh name; the anchor is resolved from the live
//            mesh position instead of the static coordinate (T1). Falls back to
//            `anchor` with a one-time console.warn if the name doesn't resolve.
//   dynamic  re-resolve the mesh anchor EVERY frame (the mesh moves, e.g. the
//            strut-mounted reel cartridges). Static meshes resolve once.
const SYSTEMS = [
  {
    id: 'POWER', label: 'POWER',
    anchor: [ 1.0 * M, 0, 0 ],
    role: 'solar wings + hull cells',
    parts: [
      { id: 'rosa_wings', name: 'ROLL-OUT SOLAR WINGS', risk: 'GREEN', tier: 'major', codexId: 'rosa_solar_array',
        massKg: 22, priority: 9, live: 'rosa',
        specs: ['2× 1×2 m roll-out arrays', '~2.2 kW peak (BOL)'],
        anchor: [ 1.1 * M, 0, 0 ] },
      { id: 'body_cells', name: 'HULL SOLAR CELLS', risk: 'GREEN', tier: 'detail', codexId: 'gallium_arsenide',
        massKg: 3, priority: 2, specs: ['Body-mounted GaAs cells'],
        // az 33.75° facet centre, central PV row (face radius barrelR×1.014).
        // The old az-0° anchor sat in the ROSA-root keep-out on bare hull and
        // collided with NAV LIGHTS (2 cm).
        anchor: [ 0.337 * M, 0.2254 * M, 0 ] },
      { id: 'array_roll', name: 'SOLAR WING SPOOL', risk: 'GREEN', tier: 'detail', codexId: 'solar_power',
        massKg: 4, priority: 2, specs: ['Roll-out drum + drive'],
        // The real spool/drum sits rootX = brkLen + drumR×0.4 = 0.08 outboard
        // of the pivot at barrelR → x = 0.48.
        anchor: [ 0.48 * M, 0, 0 ] },
    ],
  },
  {
    id: 'PROPULSION', label: 'PROPULSION',
    anchor: [ 0, 0, -1.0 * M ],
    role: 'ion + cold-gas steering',
    parts: [
      { id: 'feep', name: 'ION THRUSTERS (FEEP)', risk: 'YELLOW', tier: 'major', codexId: 'feep_thruster',
        massKg: 8, priority: 8, live: 'feep',
        specs: ['4× emitter clusters', 'Isp ~4000 s'],
        anchor: [ 0, -0.20 * M, -1.05 * M ] },
      { id: 'rcs', name: 'COLD-GAS STEERING', risk: 'GREEN', tier: 'major', codexId: 'cold_gas_rcs',
        massKg: 3, priority: 5, specs: ['GN2 thruster ring'],
        anchor: [ -0.03 * M, 0.42 * M, -0.795 * M ] },
      { id: 'mli', name: 'THERMAL BLANKET (MLI)', risk: 'GREEN', tier: 'detail', codexId: 'mli_insulation',
        massKg: 2, priority: 2, specs: ['Multi-layer insulation'],
        // Bare-MLI shoulder band above the fore cell row (cells end at z=0.72).
        // The old z=0.50 anchor pointed at MLI seam rings deleted 2026-07-23.
        anchor: [ 0.404 * M, 0, 0.78 * M ] },
      { id: 'aft_deck', name: 'AFT THRUSTER DECK', risk: 'GREEN', tier: 'detail',
        massKg: 4, priority: 1, specs: ['Aft plate — 0.6 m deck'],
        mesh: 'AftThrusterDeck',
        anchor: [ 0, 0.20 * M, -1.008 * M ] },
    ],
  },
  {
    id: 'PAYLOAD', label: 'PAYLOAD',
    anchor: [ 0, 0.10 * M, 1.05 * M ],
    role: 'net launcher + spin-brake',
    parts: [
      { id: 'despin', name: 'SPIN-BRAKE LASER', risk: 'RED', tier: 'major', codexId: 'detumble',
        massKg: 9, priority: 9, live: 'despin',
        specs: ['Photon-pressure despin', '~5 W fibre laser'],
        // Gimbal child — dynamic so the anchor tracks if the turret articulates.
        mesh: 'LaserMuzzle', dynamic: true,
        anchor: [ -0.184 * M, 0.184 * M, 1.20 * M ] },
      { id: 'net_launcher', name: 'LARGE NET LAUNCHER', risk: 'GREEN', tier: 'major', codexId: 'miura_ori_net',
        massKg: 5, priority: 7, specs: ['Miura-ori net, ~5 m span'],
        anchor: [ 0, 0, 1.30 * M ] },
    ],
  },
  {
    id: 'SENSORS', label: 'SENSORS',
    anchor: [ 0, 0.26 * M, 1.12 * M ],
    role: 'tracking turret + cameras',
    parts: [
      { id: 'gimbal', name: 'SENSOR TURRET', risk: 'GREEN', tier: 'major', codexId: 'docking_precision',
        massKg: 5, priority: 6, specs: ['2-axis pointing platform'],
        anchor: [ 0, 0, 1.00 * M ] },
      { id: 'eo_cam', name: 'DAYLIGHT CAMERA', risk: 'GREEN', tier: 'major', codexId: 'pose_estimation',
        massKg: 2, priority: 4, specs: ['Visible-band imager (EO)'],
        anchor: [ 0.184 * M, 0.184 * M, 1.11 * M ] },
      { id: 'ir_cam', name: 'HEAT (INFRARED) CAM', risk: 'GREEN', tier: 'major', codexId: 'trackable_vs_dark',
        massKg: 2, priority: 4, specs: ['LWIR — spots dark debris'],
        anchor: [ -0.184 * M, -0.184 * M, 1.08 * M ] },
      { id: 'lidar', name: 'LASER RANGEFINDER', risk: 'GREEN', tier: 'major', codexId: 'lidar_ranging',
        massKg: 3, priority: 5, specs: ['Flash LIDAR — range + pose'],
        anchor: [ 0.184 * M, -0.184 * M, 1.10 * M ] },
      { id: 'star_trackers', name: 'STAR TRACKERS', risk: 'GREEN', tier: 'major', codexId: 'star_tracker',
        massKg: 1, priority: 3, specs: ['2× — attitude from starfield'],
        anchor: [ 0.042 * M, 0.398 * M, 0.90 * M ] },
      { id: 'fore_bulkhead', name: 'FORE BULKHEAD', risk: 'GREEN', tier: 'major',
        massKg: 6, priority: 3, specs: ['Fore end cap — 0.8 m plate', 'Carries the sensor deck'],
        mesh: 'FrontCap_ConfigG',
        anchor: [ 0.30 * M, -0.28 * M, 1.005 * M ] },
      { id: 'sensor_deck', name: 'SENSOR DECK', risk: 'GREEN', tier: 'detail',
        massKg: 2, priority: 2, specs: ['Instrument mounting annulus'],
        mesh: 'SensorDeck',
        anchor: [ 0, 0.30 * M, 1.03 * M ] },
      { id: 'sun_sensors', name: 'SUN SENSORS', risk: 'GREEN', tier: 'detail', codexId: 'sun_sensor',
        massKg: 0.5, priority: 2, specs: ['Coarse sun sensing, 4×'],
        anchor: [ 0.28 * M, -0.20 * M, 1.0 * M ] },
      { id: 'nav_lights', name: 'NAVIGATION LIGHTS', risk: 'GREEN', tier: 'detail',
        massKg: 1, priority: 1, specs: ['Port/starboard running lights'],
        anchor: [ 0.42 * M, 0, 0.30 * M ] },
    ],
  },
  {
    id: 'COMMS', label: 'COMMS',
    anchor: [ 0.363 * M, 0.169 * M, 0.87 * M ],
    role: 'radio omnis + antennas',
    parts: [
      { id: 'ttc', name: 'S-BAND RADIO OMNIS', risk: 'GREEN', tier: 'major', codexId: 'frequency_bands',
        massKg: 2, priority: 5, live: 'ttc', specs: ['Pair — command + telemetry'],
        anchor: [ 0, -0.40 * M, 0.92 * M ] },
      { id: 'mga', name: 'MEDIUM-GAIN ANTENNA', risk: 'GREEN', tier: 'detail', codexId: 'bandwidth_limits',
        massKg: 1, priority: 2, specs: ['Tangent patch, higher rate'],
        anchor: [ 0.363 * M, 0.169 * M, 0.87 * M ] },
      { id: 'gps', name: 'GPS ANTENNAS', risk: 'GREEN', tier: 'detail', codexId: 'gps_denied',
        massKg: 0.5, priority: 2, specs: ['GNSS patch pair'],
        anchor: [ 0.376 * M, -0.137 * M, 0.87 * M ] },
      { id: 'ttc_aft', name: 'S-BAND OMNI (AFT)', risk: 'GREEN', tier: 'detail', codexId: 'comms_blackout',
        massKg: 1, priority: 1, specs: ['Aft whip of the omni pair'],
        anchor: [ 0, 0.40 * M, -0.92 * M ] },
    ],
  },
  {
    id: 'CAPTURE', label: 'CAPTURE',
    // Berth groove, centreline — next to the docked daughters, the only
    // capture hardware the player can actually SEE. The old fore-deck anchor
    // (z=+0.90, the hinge line) pointed at the opposite end from 3 of the
    // system's 4 parts and contradicted what it summarized (round 5).
    anchor: [ 0, 0.35 * M, -0.75 * M ],
    role: '4× daughter craft + berths',
    parts: [
      { id: 'berths', name: 'DAUGHTER BERTHS', risk: 'GREEN', tier: 'major', codexId: 'docking_berthing',
        massKg: 6, priority: 6, specs: ['4× — 2 large, 2 small', 'Spring ejector + hinge strut'],
        // az 60° pocket's aft lip (z=-0.85, hull rim of the carved groove) —
        // real hull edge, ~15 cm clear of the docked daughter's own callout,
        // whose anchor is the craft body mid-pocket (z=-0.70).
        anchor: [ 0.20 * M, 0.346 * M, -0.85 * M ] },
      { id: 'tether_reels', name: 'TETHER WINCHES', risk: 'GREEN', tier: 'major', codexId: 'reel_mechanics',
        massKg: 4, priority: 6, live: 'tether', specs: ['4× Dyneema SK78 reels'],
        // Reel cartridges ride the struts (stowed z≈−0.46, deployed ≈1.5 m out).
        mesh: 'ReelCartridge_0', dynamic: true,
        anchor: [ 0.20 * M, 0.346 * M, -0.46 * M ] },
      { id: 'hinges', name: 'STRUT HINGES', risk: 'YELLOW', tier: 'detail', codexId: 'robotic_arm',
        massKg: 2, priority: 2, specs: ['Double-A clevis, 4×'],
        anchor: [ 0.22 * M, 0.381 * M, 0.90 * M ] },
      { id: 'cradle_spring', name: 'CROSSBOW SPRING', risk: 'YELLOW', tier: 'detail', codexId: 'spring_energy',
        massKg: 1, priority: 2, specs: ['Spring ejector — launches daughters'],
        // Spring group rides the strut (stowed z≈−0.62, deployed ≈1.7 m out).
        mesh: 'CrossbowSpring_0', dynamic: true,
        anchor: [ 0.20 * M, 0.346 * M, -0.62 * M ] },
      // NET LAUNCHERS (DAUGHTERS) deleted: that hardware lives on the ArmUnit
      // (ArmUnit.js:660-667), never on the Mother. The fact moved into the
      // daughter cards' specs (T3).
    ],
  },
  {
    // P2 thermal arc — the AFT FLOWER family (charter
    // .kilo/plans/1787839542000-phase2-flower-hardware-charter.md TASK F; hue
    // row lives in Constants.CALLOUTS.SYSTEM_HUES.THERMAL — BOTH places, or
    // the family renders fallback-hued). Purchase-gated hardware: every rec
    // carries `flowerGated` and hides until a pair is bought (the daughter
    // `_armGone` idiom), so no callout ever points at empty rim. Anchors are
    // STATIC station coordinates (the meshes may not exist pre-purchase, so
    // no `mesh:` refs here). The ship already carries the diegetic thermal
    // sensor — the HEAT (INFRARED) CAM callout under SENSORS.
    id: 'THERMAL', label: 'THERMAL',
    anchor: [ 0.283 * M, 0.283 * M, -1.02 * M ],
    role: 'aft flower — struts open LIKE A FLOWER',
    flowerGated: true,
    parts: [
      { id: 'flower_plates', name: 'RADIATOR PLATES', risk: 'GREEN', tier: 'major', codexId: 'space_radiator',
        massKg: 37, priority: 6, flowerGated: true,
        specs: ['4× 1.70×0.60 m panels along the struts', 'Reject heat as infrared — numbers come with the loop refit'],
        anchor: [ -0.30 * M, 0.30 * M, -1.15 * M ] },
      { id: 'flower_struts', name: 'AFT FLOWER STRUTS', risk: 'GREEN', tier: 'major', codexId: 'vacuum_mechanisms',
        massKg: 10, priority: 6, flowerGated: true,
        specs: ['4× aft-pivot booms, 2.5 m', 'They open LIKE A FLOWER — O deploys / stows'],
        anchor: [ 0.283 * M, 0.283 * M, -1.10 * M ] },
      { id: 'flower_tips', name: 'TIP HARDPOINTS', risk: 'GREEN', tier: 'detail',
        massKg: 2, priority: 2, flowerGated: true,
        specs: ['Inert cargo bosses at the strut tips', 'Cold-cell refit will bolt on here'],
        anchor: [ -0.283 * M, -0.283 * M, -1.12 * M ] },
      { id: 'flower_hinges', name: 'FLOWER HINGE BRACKETS', risk: 'YELLOW', tier: 'detail', codexId: 'vacuum_mechanisms',
        massKg: 1, priority: 2, flowerGated: true,
        specs: ['Rim-band clevises, MoS₂-filmed pins', 'Hinges are the honest jam risk'],
        anchor: [ 0.283 * M, -0.283 * M, -0.94 * M ] },
    ],
  },
  {
    // Docked daughters — dynamic recs that follow each docked ArmUnit (T3).
    // Titles are static (berth i%2 alternates Large/Small, ArmManager.js:113),
    // so cards are built once; visibility is gated per frame on the arm's state.
    id: 'DAUGHTERS', label: 'DAUGHTERS',
    anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ],
    daughters: true,
    parts: [
      { id: 'daughter_0', name: 'LARGE DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'weaver_gripper',
        massKg: 6.6, priority: 7, live: 'daughter', armIndex: 0,
        specs: ['Weaver — medium net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_1', name: 'SMALL DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'spinner_pad',
        massKg: 3.7, priority: 7, live: 'daughter', armIndex: 1,
        specs: ['Spinner — small net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_2', name: 'LARGE DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'weaver_gripper',
        massKg: 6.6, priority: 7, live: 'daughter', armIndex: 2,
        specs: ['Weaver — medium net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_3', name: 'SMALL DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'spinner_pad',
        massKg: 3.7, priority: 7, live: 'daughter', armIndex: 3,
        specs: ['Spinner — small net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
    ],
  },
];

// LOD band edges, in METRES of camera-to-ship distance. Hysteresis: descend
// (zoom in) on the lower number, ascend (zoom out) on the higher.
const BAND = {
  partIn:  8.0,  partOut:  9.0,
  compIn:  5.5,  compOut:  6.5,
};

const GUIDE_STEP_S = 1.1;   // seconds each system stays highlighted in the tour
const GUIDE_HOLD_S = 0.6;   // initial hold before the tour starts

const FADE_RATE = 6.0;      // opacity ease rate for band crossfades
const LINE_OP_SCALE = 0.8;  // line opacity = labelOp × this (round 4: hairline)
const LINE_HALF_WIDTH_FRAC = 0.0012; // leader ribbon half-width / camera-ship dist (round 4: hairline)

export class MotherCallouts {
  /**
   * @param {THREE.Object3D} playerGroup  The PlayerSatellite group (labels parent here).
   * @param {THREE.Camera}   camera
   * @param {object} [opts]
   * @param {HTMLCanvasElement|null} [opts.canvas]  Render canvas for pointer events.
   */
  constructor(playerGroup, camera, { canvas = null } = {}) {
    this.player = playerGroup;
    this.camera = camera;
    this.canvas = canvas;

    this._active = false;
    this._band = 'SYSTEM';
    this._guideT = -1;
    this._guidedDone = false;
    this._focusPart = null;
    this._liveCtx = null;       // late-bound live-data context (task 7)
    this._lastLiveT = 0;        // live-refresh cadence guard
    this._bandChangedAt = 0;    // T3: timestamp of last band change (scan-in hold)
    this._revealSeq = 0;        // T3: stagger sequence counter
    this._nowMs = 0;            // T3: frame timestamp stored for _positionCard

    // Reusable scratch vectors (zero per-frame alloc).
    this._vShip = new THREE.Vector3();
    this._vCam = new THREE.Vector3();
    this._vAnchor = new THREE.Vector3();
    this._vTmp = new THREE.Vector3();
    this._vFace = new THREE.Vector3();
    this._vCamDir = new THREE.Vector3();
    this._qTmp = new THREE.Quaternion();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._shipNDC = new THREE.Vector3();
    this._vAttach = new THREE.Vector3();
    this._vElbow = new THREE.Vector3();
    // Ribbon-leader scratch.
    this._rA = new THREE.Vector3();
    this._rB = new THREE.Vector3();
    this._rDir = new THREE.Vector3();
    this._rView = new THREE.Vector3();
    this._rPerp = new THREE.Vector3();
    this._rMid = new THREE.Vector3();
    this._rC0 = new THREE.Vector3();
    this._rC1 = new THREE.Vector3();
    this._rC2 = new THREE.Vector3();
    this._rC3 = new THREE.Vector3();
    this._vCamLocal = new THREE.Vector3();
    this._leaderHalfWidth = 0;

    // Per-frame projection state (populated in update()).
    this._halfH = 1; this._halfW = 1;
    this._railL = -0.5; this._railR = 0.5;

    // Clickable-label interaction (codex deep-links).
    this._raycaster = new THREE.Raycaster();
    // The callouts group rides inside the player subtree, which SceneManager
    // registers as a NEAR_FIELD root — moving every sprite to
    // NEAR_FIELD_LAYER (layer 1) at close range. A default raycaster only
    // tests layer 0, so every pick silently missed at inspection depth and
    // click-to-open was dead (round 5 autopsy: spriteLayers 2 vs rcLayers 1,
    // ray dead-centre at 2.8e-14 miss distance). Test all layers: the pick
    // loop only ever sees these ~37 sprites, so the mask costs nothing.
    this._raycaster.layers.enableAll();
    this._ndc = new THREE.Vector2();
    this._pointerDown = null;
    this._hoverT = 0;
    this._cursorSet = false;
    this._listening = false;
    this._hoverRec = null;
    this._pointerPos = null;   // last pointer client coords, for hover re-pick (R13)
    this._hoverPickT = 0;      // hover re-pick cadence guard (R13)
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onPointerCancel = () => { this._pointerDown = null; };
    this._onPointerLeave = () => {
      this._hoverRec = null;
      this._pointerPos = null;   // stop re-picking once the pointer exits (R13)
      this._restoreCursor();
    };

    this._group = new THREE.Group();
    this._group.name = 'MotherCallouts';
    this._group.visible = false;
    this.player.add(this._group);

    this._partLabels = [];
    this._allRecs = []; // cached union of system + part labels (LOW-16)
    this._leftRail = [];  // persistent rail arrays (LOW-16)
    this._rightRail = [];
    this._build();

    this._viewInspect = false;
    this._zoomInspect = false;
    // Zoom Ladder F3 single costume (docs/ladder/08-workbench.md §2 "F3
    // costume"): a TRANSIENT gate mirroring CityLabels.setSuppressed — while
    // the ladder is on F3 the BlueprintOverlay DOM cards + the cyan hull outline
    // ARE the costume and these sprite cards retire. Never persisted; the
    // inspection signals (CAMERA_VIEW_CHANGE / INSPECT_HULL_OUTLINE) keep owning
    // the resting state, so clearing it restores exactly what they say. The
    // shipped Schmitt path never calls setSuppressed → `_suppressed` stays false
    // → `_applyActive()` reduces to the pre-ladder `viewInspect || zoomInspect`.
    this._suppressed = false;
    this._onViewChange = ({ view } = {}) => {
      this._viewInspect = (view === 'INSPECTION');
      this._applyActive();
    };
    this._onHullOutline = ({ visible } = {}) => {
      this._zoomInspect = !!visible;
      this._applyActive();
    };
    eventBus.on(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.on(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
  }

  /** @returns {boolean} true while the ladder's F3 costume suppresses the sprite cards. */
  isSuppressed() { return this._suppressed; }

  /**
   * Transient show/hide gate for the Zoom Ladder's F3 (HULL CAM) costume —
   * BlueprintOverlay owns the callout grammar there, so the in-world sprite
   * cards hide while the hull outline (INSPECT_HULL_OUTLINE) keeps working
   * unmodified. Like CityLabels.setSuppressed this NEVER persists and never
   * touches the inspection flags: `active = inspecting && !suppressed`.
   * @param {boolean} v
   */
  setSuppressed(v) {
    v = !!v;
    if (v === this._suppressed) return;
    this._suppressed = v;
    this._applyActive();
  }

  /** @private Resolve the activation gate: inspecting (either signal) and not suppressed. */
  _applyActive() {
    this._setActive((this._viewInspect || this._zoomInspect) && !this._suppressed);
  }

  /**
   * Late-bind the live-data context (task 7). Called from main.js after all
   * systems are constructed (construction-order gotcha: motherCallouts is built
   * before commsSystem). Every reference is optional — cards degrade to static
   * rows if a system is missing.
   * @param {object} ctx { resourceSystem, commsSystem, codexSystem,
   *   powerDistribution, tetherReel, despinLaser, player }
   */
  setLiveCtx(ctx) {
    this._liveCtx = ctx || null;
  }

  // --------------------------------------------------------------------------
  // BUILD
  // --------------------------------------------------------------------------

  /** Shared target-bracket texture for leader anchor markers. @private */
  static _dotTexture() {
    if (MotherCallouts._dotTex) return MotherCallouts._dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    // White — _makeDot tints via material.color, and hover brightening reads it.
    // Round 5: thicker strokes + bigger centre dot — at DOT_SIZE 0.016 the
    // sprite lands ~17 px at 1080p; 5 px texture strokes ≈ 1.3 px on screen,
    // and the r=4 core keeps a solid point readable even when ticks blur over
    // bright hull (gold MLI / white dome washed the old 3 px/r=2 version out).
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 5;
    const t = 16; // tick length
    const m = 4;  // margin from edge
    // Four corner ticks (L-shaped brackets).
    // top-left
    ctx.beginPath(); ctx.moveTo(m, m + t); ctx.lineTo(m, m); ctx.lineTo(m + t, m); ctx.stroke();
    // top-right
    ctx.beginPath(); ctx.moveTo(64 - m - t, m); ctx.lineTo(64 - m, m); ctx.lineTo(64 - m, m + t); ctx.stroke();
    // bottom-left
    ctx.beginPath(); ctx.moveTo(m, 64 - m - t); ctx.lineTo(m, 64 - m); ctx.lineTo(m + t, 64 - m); ctx.stroke();
    // bottom-right
    ctx.beginPath(); ctx.moveTo(64 - m - t, 64 - m); ctx.lineTo(64 - m, 64 - m); ctx.lineTo(64 - m, 64 - m - t); ctx.stroke();
    // Centre dot.
    ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    MotherCallouts._dotTex = tex;
    return tex;
  }

  /** Card sprite (texture assigned lazily). @private */
  _makeCardSprite() {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
    }));
    sprite.renderOrder = 30;
    sprite.frustumCulled = false;
    return sprite;
  }

  /**
   * Two-segment elbow leader as camera-facing ribbon quads (8 verts / 4 tris).
   * Positions rewritten each frame in _setElbowLocal.
   * @private
   */
  _makeLine(color) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24), 3)); // 8 verts
    geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(geo, mat);
    line.renderOrder = 29;
    line.frustumCulled = false;
    return line;
  }

  /** Small filled marker where a leader touches its part. @private */
  _makeDot(color) {
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: MotherCallouts._dotTexture(),
      color: new THREE.Color(color),
      transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
    }));
    dot.renderOrder = 31;
    dot.frustumCulled = false;
    return dot;
  }

  _build() {
    for (const sys of SYSTEMS) {
      const hue = HUES[sys.id] || HUES.CAPTURE; // DAUGHTERS reuses the CAPTURE hue
      const sLabel = this._makeCardSprite();
      const sLine = this._makeLine(hue);
      const sDot = this._makeDot(hue);
      this._group.add(sLine, sDot, sLabel);
      const sRec = {
        def: sys, isSystem: true, hue, sprite: sLabel, line: sLine, dot: sDot,
        op: 0, side: null, sx: 0, sy: 0, primed: false,
        cardKey: null, card: null,
        anchor: new THREE.Vector3(...sys.anchor),
        _mesh: null, _meshTried: false,
        _cardCache: null, _railOrder: null, _targetOp: 0,
        _h: 0, _wasFocus: false, _isFocus: false,
        _anchorX: 0, _anchorY: 0, _anchorZ: 0,
        _armGone: false, _revealAt: null,
        _pendingSide: null, _sideT: 0,
      };
      this._applyCard(sRec); // initial static card
      this._allRecs.push(sRec);
      // The DAUGHTERS pseudo-group has no visible system label — its parts are
      // the docked craft themselves (T3); keep the rec for the tour but never show.
      if (sys.daughters) sRec._neverShow = true;

      for (const part of sys.parts) {
        const pLabel = this._makeCardSprite();
        const color = RISK[part.risk] || RISK.GREEN;
        const pLine = this._makeLine(hue);
        const pDot = this._makeDot(hue);
        this._group.add(pLine, pDot, pLabel);
        const rec = {
          def: part, sysId: sys.id, hue, isDetail: part.tier === 'detail',
          riskColor: color, sprite: pLabel, line: pLine, dot: pDot,
          op: 0, side: null, sx: 0, sy: 0, primed: false,
          cardKey: null, card: null,
          anchor: new THREE.Vector3(...part.anchor),
          _mesh: null, _meshTried: false,
          _cardCache: null, _railOrder: null, _targetOp: 0,
          _h: 0, _wasFocus: false, _isFocus: false,
          _anchorX: 0, _anchorY: 0, _anchorZ: 0,
          _armGone: false, _revealAt: null,
          _pendingSide: null, _sideT: 0,
        };
        this._applyCard(rec);
        this._partLabels.push(rec);
        this._allRecs.push(rec);
      }
    }
  }

  /**
   * Resolve a rec's anchor for this frame (T1). Static parts copy their table
   * coordinate; `mesh` parts resolve from the live PlayerSatellite mesh (once,
   * cached); `dynamic` parts re-resolve every frame because the mesh moves
   * (strut-mounted reels/springs); daughter recs follow their docked ArmUnit.
   * Falls back to the static coordinate with a one-time warn on a mesh miss.
   * @private
   */
  _resolveAnchor(rec) {
    const def = rec.def;
    // P2: the THERMAL family hides until a flower pair is purchased (the
    // daughter `_armGone` idiom) — purchase-gated hardware never gets a
    // floating label pointing at empty rim.
    if (def.flowerGated) {
      rec._flowerGone = !this._flowerOn();
    }
    // Daughter recs follow their docked ArmUnit (T3).
    if (def.armIndex !== undefined) {
      const arm = this._liveCtx?.armManager?.arms?.[def.armIndex];
      if (arm && arm.state === Constants.ARM_STATES.DOCKED && arm.group) {
        arm.group.getWorldPosition(this._vTmp);
        this.player.worldToLocal(this._vTmp);
        rec.anchor.copy(this._vTmp);
        rec._armGone = false;
      } else {
        rec._armGone = true; // away or missing → hidden by _targetOpacity
      }
      return;
    }
    if (!def.mesh) {
      rec.anchor.set(def.anchor[0], def.anchor[1], def.anchor[2]);
      return;
    }
    if (!rec._mesh && !rec._meshTried) {
      rec._meshTried = true;
      rec._mesh = this.player.getObjectByName(def.mesh) || null;
      if (!rec._mesh && typeof console !== 'undefined') {
        console.warn(`[MotherCallouts] mesh "${def.mesh}" not found for "${def.name}" — using static anchor`);
      }
    }
    if (rec._mesh) {
      // Static meshes resolve once and cache; `dynamic` meshes (strut-mounted
      // reels/springs, gimbal children) re-resolve every frame.
      if (rec._meshResolved && !def.dynamic) return;
      rec._mesh.getWorldPosition(this._vTmp);
      this.player.worldToLocal(this._vTmp);
      rec.anchor.copy(this._vTmp);
      rec._meshResolved = true;
    } else {
      rec.anchor.set(def.anchor[0], def.anchor[1], def.anchor[2]);
    }
  }

  // --------------------------------------------------------------------------
  // CARD TEXTURE MANAGEMENT
  // --------------------------------------------------------------------------

  /** Codex link state for a part: 'linked' | 'locked' | null. @private */
  _codexState(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return 'linked';
    const entry = cs.getEntry(def.codexId);
    if (!entry) {
      // A codexId that no longer resolves would render a clickable ▸ that
      // silently no-ops (CodexViewerUI.openEntry returns false). Treat it as
      // unlinked and warn once so the drift is loud, not invisible.
      if (!MotherCallouts._warnedMissingCodex) MotherCallouts._warnedMissingCodex = new Set();
      if (typeof console !== 'undefined' && !MotherCallouts._warnedMissingCodex.has(def.codexId)) {
        MotherCallouts._warnedMissingCodex.add(def.codexId);
        console.warn(`[MotherCallouts] codexId "${def.codexId}" for "${def.name || def.id}" does not resolve — no deep-link`);
      }
      return null;
    }
    return entry.unlocked ? 'linked' : 'locked';
  }

  /** Codex entry title for a part's linked entry, or null. @private */
  _codexTitle(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && e.title) ? e.title : null;
  }

  /** Read TRL for a part's codex entry, or null. @private */
  _partTRL(def) {
    const cs = this._liveCtx?.codexSystem;
    if (!def.codexId || !cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && typeof e.trl === 'number') ? e.trl : null;
  }

  /**
   * Build the spec for a rec's current state and (re)generate its card texture
   * only when the content string changes. `full` → focused detail card with
   * spec/TRL/live rows; otherwise a compact title-only card.
   *
   * Cards are cached per rec by VARIANT ('compact' | 'focused'), not by content,
   * so a live-data refresh on the focused card regenerates only that variant and
   * never evicts the permanently-resident compact card (round-2 R3/R14).
   * @private
   */
  _applyCard(rec, { full = false } = {}) {
    const def = rec.def;
    const codex = rec.isSystem ? null : this._codexState(def);
    let rows = [];
    // Round 5: system cards get a single dim role line — a title-only chip
    // made the player guess what the system IS (CAPTURE was the worst case:
    // it pointed at an invisible hinge line with no explanation).
    if (rec.isSystem && def.role) rows.push({ text: def.role });
    if (full && !rec.isSystem) {
      // Deterministic row budget: 6 slots total.
      // Locked: reserve hint lines (1-2), fill [mass, ...specs, ...live(≤2)], append hint last. TRL dropped.
      // Unlocked: [mass, ...specs(≤2), ...live(≤2), TRL], capped at 6.
      const isLocked = codex === 'locked';
      // Only the first two live rows survive the budget (R12).
      const live = this._liveRows(def).slice(0, 2);

      // Pre-wrap the unlock hint with the single shared wrap implementation;
      // its line count IS the budget reservation, so budget and draw agree (review).
      let hintLines = [];
      if (isLocked) {
        const hintText = this._liveCtx?.codexSystem?.getUnlockHint?.(def.codexId) || null;
        if (hintText) hintLines = wrapHint(hintText, 2);
      }

      const budget = 6 - hintLines.length;
      if (typeof def.massKg === 'number') rows.push({ text: `Mass: ${def.massKg} kg` });
      if (Array.isArray(def.specs)) {
        for (const s of def.specs.slice(0, 2)) rows.push({ text: s });
      }
      for (const lr of live) rows.push({ text: lr, dim: false });

      // Deep-link affordance NAMES its destination (round 6): the row shows the
      // exact Tech Library entry the click opens, not a generic "open tech
      // library". Pushed before TRL so it survives the budget slice.
      const codexTitle = codex ? this._codexTitle(def) : null;
      if (codex === 'linked') {
        rows.push({ text: `▸ ${codexTitle || 'open tech library'}`, dim: true, color: rec.hue });
        const trl = this._partTRL(def);
        if (trl != null) rows.push({ text: `Readiness: L${trl}`, dim: true });
      } else if (codex === 'locked' && codexTitle) {
        // Locked cards still name where the ▸ leads (amber, matches the hint).
        rows.push({ text: `▸ ${codexTitle}`, dim: true, color: '#ffaa00' });
      } else if (codex === null) {
        // Structural part with no briefing — explain the dead click (round 6).
        rows.push({ text: 'structure — no briefing', dim: true });
      }

      rows = rows.slice(0, budget);

      // Hint lines appended last, amber (R8).
      for (const line of hintLines) {
        rows.push({ text: line, dim: false, color: '#ffaa00' });
      }
    }
    const title = rec.isSystem ? def.label : def.name;
    const variant = full ? 'focused' : 'compact';
    const key = [
      title, rec.isSystem ? 'sys' : def.risk, codex || '-',
      full ? rows.map((r) => r.text).join('|') : 'compact',
    ].join('::');

    // Early-out: content unchanged → keep the current texture (R3).
    if (rec.cardKey === key && rec.card) return;

    // Reuse the cached variant if its content key still matches.
    if (!rec._cardCache) rec._cardCache = new Map();
    const cached = rec._cardCache.get(variant);
    if (cached && cached.contentKey === key) {
      rec.card = cached;
      rec.cardKey = key;
      rec.sprite.material.map = cached.texture;
      rec.sprite.material.needsUpdate = true;
      return;
    }

    // Generate a fresh card for this variant.
    const card = createCardTexture({
      title,
      titleColor: rec.isSystem ? rec.hue : CFG.INK,
      rows,
      riskColor: rec.isSystem ? null : rec.riskColor,
      systemColor: rec.hue,
      inkColor: CFG.INK,
      inkDimColor: CFG.INK_DIM,
      codex,
    });
    card.contentKey = key;
    // Dispose only the previous entry for THIS variant (not the other variant).
    if (cached && cached.texture) cached.texture.dispose();
    rec._cardCache.set(variant, card);
    rec.card = card;
    rec.cardKey = key;
    rec.sprite.material.map = card.texture;
    rec.sprite.material.needsUpdate = true;
  }

  /**
   * Dynamic live-data rows for a part (graceful degradation: returns [] if the
   * live context or a referenced system is absent). @private
   */
  _liveRows(def) {
    const ctx = this._liveCtx;
    if (!ctx || !def.live) return [];
    const out = [];
    try {
      switch (def.live) {
        case 'rosa': {
          if (ctx.powerDistribution?.getSolarInput) {
            out.push(`Solar: ${Math.round(ctx.powerDistribution.getSolarInput())} W`);
          }
          // Wings state (round-3 T10): makes the furl state legible on the card.
          // Supersedes round-2 R12's Battery row — battery is already on the HUD.
          const furl = ctx.player?._rosaFurlProgress;
          if (typeof furl === 'number') {
            out.push(furl >= 0.98 ? 'Wings: DEPLOYED' : furl <= 0.02 ? 'Wings: FURLED' : `Wings: ${Math.round(furl * 100)}%`);
          }
          break;
        }
        case 'feep': {
          const rs = ctx.resourceSystem;
          if (rs?.getStatus && typeof rs.getStatus === 'function') {
            const st = rs.getStatus();
            // currentFuelName may be a cargo-fed metal (fromCargo), which is NOT
            // drawn from the xenon tank — don't report xenon kg under its name (R4).
            const fuel = rs.getCurrentFuel?.();
            if (fuel && !fuel.fromCargo) {
              out.push(`Fuel: ${st.currentFuelName} ${Math.round(st.xenon)}/${st.xenonMax} kg`);
            } else if (fuel) {
              out.push(`Fuel: ${st.currentFuelName} (cargo)`);
            } else {
              out.push(`Fuel: ${Math.round(st.xenon)}/${st.xenonMax} kg`);
            }
          }
          // No "Thrust" row: its data source (player.thrustInput) is dead —
          // thrustIon/thrustColdGas/thrustMPD have no production callers and
          // _applyThrust zeroes the accumulator before callouts update (review).
          break;
        }
        case 'tether': {
          const tr = ctx.tetherReel;
          if (tr?.getAllReelStates) {
            const states = tr.getAllReelStates() || [];
            const active = states.filter((s) => s?.state && s.state !== 'STOWED').length;
            out.push(`Reels active: ${active}/${states.length || 4}`);
          } else if (tr?.getReelState) {
            out.push(`Reel 0: ${tr.getReelState(0) ?? '—'}`);
          }
          break;
        }
        case 'ttc': {
          const cm = ctx.commsSystem;
          if (cm?.getSuppressionTier) {
            const tier = cm.getSuppressionTier();
            out.push(`Link: ${tier > 0 ? `SUPPRESSED (${tier})` : 'NOMINAL'}`);
          }
          break;
        }
        case 'despin': {
          if (ctx.despinLaser?.isFiring) {
            out.push(`Laser: ${ctx.despinLaser.isFiring() ? 'FIRING' : 'safe'}`);
          }
          break;
        }
        case 'daughter': {
          const arm = ctx.armManager?.arms?.[def.armIndex];
          if (arm) {
            if (typeof arm.fuel === 'number') out.push(`Fuel: ${Math.round(arm.fuel)}%`);
            out.push(`Spring: ${arm.springCharged ? 'charged' : 'reloading'}`);
          }
          break;
        }
      }
    } catch (_e) { /* live data is best-effort; never throw from a card build */ }
    return out;
  }

  // --------------------------------------------------------------------------
  // ACTIVATION
  // --------------------------------------------------------------------------

  _setActive(on) {
    if (this._active === on) return;
    this._active = on;
    this._group.visible = on;
    if (on) {
      if (!this._guidedDone) this._guideT = -GUIDE_HOLD_S;
      this._band = 'SYSTEM';
      this._attachPointer();
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: 'SYSTEM' });
      // Refresh all compact cards so codex lock state is current (MED-9).
      // Content-key check makes unchanged cards a no-op (R3).
      for (const rec of this._allRecs) {
        rec._revealAt = null; // T3: no stale reveal hold across re-entry
        rec._pendingSide = null; // T4: no stale flip across re-entry
        rec._sideT = 0;
        this._applyCard(rec, { full: false });
      }
    } else {
      this._guideT = -1;
      this._focusPart = null;
      // Round 6: the guided tour is a one-shot. Mark it done on the first exit so
      // a quick dip in/out of inspection can't replay the dim tour indefinitely.
      this._guidedDone = true;
      this._detachPointer();
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: null });
    }
  }

  // --------------------------------------------------------------------------
  // CLICKABLE LABELS → CODEX DEEP-LINKS
  // --------------------------------------------------------------------------

  _attachPointer() {
    if (this._listening || !this.canvas) return;
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this._listening = true;
  }

  _detachPointer() {
    if (!this._listening || !this.canvas) return;
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this._listening = false;
    this._pointerDown = null;
    this._restoreCursor();
    if (this._hoverRec) { this._hoverRec = null; }
  }

  _restoreCursor() {
    if (this._cursorSet && typeof document !== 'undefined') {
      document.body.style.cursor = '';
      this._cursorSet = false;
    }
  }

  _pointerNDC(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this._ndc;
  }

  /**
   * Shared raycast pick over the part labels with the camera ray already set.
   * Returns the nearest eligible rec or null. Single source for the
   * eligibility filter so hover and click can never drift apart (review).
   * @private
   */
  _pickBestRec() {
    let best = null, bestDist = Infinity;
    for (const p of this._partLabels) {
      if (!p.def.codexId || !p.sprite.visible) continue;
      // Round 6 review: gate on RESOLVABILITY, not codexId truthiness — a drifted
      // codexId renders "structure — no briefing" (see _codexState) and must not
      // stay clickable with a dead no-op click.
      if (this._codexState(p.def) === null) continue;
      // Gate on whichever is larger of eased vs target opacity, so picking
      // follows what the player can actually see. Derived from the legibility
      // floor (MIN_CARD_OP) so the two can't drift: a card is either clearly
      // readable-and-clickable or hidden — no muddy half-pickable band. The
      // 0.8 factor keeps the gate strictly below the floor (round 6).
      if (Math.max(p.op ?? 0, p._targetOp ?? 0) <= (CFG.MIN_CARD_OP ?? 0.5) * 0.8) continue;
      const hits = this._raycaster.intersectObject(p.sprite, false);
      if (hits.length && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = p;
      }
    }
    return best;
  }

  /**
   * Nearest clickable label sprite under the pointer.
   * @private @returns {object|null}
   */
  _pickLabel(e) {
    if (!this.camera) return null;
    this._raycaster.setFromCamera(this._pointerNDC(e), this.camera);
    return this._pickBestRec();
  }

  _handlePointerMove(e) {
    if (!this._active) return;
    // Always record the latest position so _layout can re-pick under a
    // stationary pointer as cards slide (R13); the pick itself is throttled.
    this._pointerPos = { clientX: e.clientX, clientY: e.clientY };
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._hoverT < 100) return;   // ~10 Hz
    this._hoverT = now;
    const hit = this._pickLabel(e);
    const rec = hit || null;
    if (rec && !this._cursorSet) {
      document.body.style.cursor = 'pointer';
      this._cursorSet = true;
    } else if (!rec && this._cursorSet) {
      this._restoreCursor();
    }
    this._hoverRec = rec;
  }

  /**
   * Re-pick the hovered card from the stored pointer position (R13). Cards slide
   * in screen space as the ship rotates, so with a stationary pointer the hover
   * would otherwise go stale. Runs at ~10 Hz from _layout; cheap (29 raycasts).
   * @private
   */
  _refreshHover() {
    if (!this._pointerPos || !this.canvas) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._hoverPickT < 100) return;
    this._hoverPickT = now;
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(
      ((this._pointerPos.clientX - rect.left) / rect.width) * 2 - 1,
      -((this._pointerPos.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const best = this._pickBestRec() || null;
    if (best !== this._hoverRec) {
      this._hoverRec = best;
      if (best && !this._cursorSet) {
        document.body.style.cursor = 'pointer';
        this._cursorSet = true;
      } else if (!best && this._cursorSet) {
        this._restoreCursor();
      }
    }
  }

  _handlePointerDown(e) {
    if (!this._active) return;
    this._pointerDown = {
      x: e.clientX, y: e.clientY,
      t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    };
  }

  _handlePointerUp(e) {
    if (!this._active || !this._pointerDown) return;
    const down = this._pointerDown;
    this._pointerDown = null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 5 || (now - down.t) > 400) return;   // drag / long-press → ignore
    const hit = this._pickLabel(e);
    // T7: the WHOLE card is clickable — hover and click now agree (the old
    // title-strip UV gate made ~⅔ of a focused card a dead zone with a hand cursor).
    if (hit && hit.def.codexId) {
      eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: hit.def.codexId });
    }
  }

  // --------------------------------------------------------------------------
  // PER-FRAME UPDATE
  // --------------------------------------------------------------------------

  update(dt) {
    if (!this._active || !this.camera) return;

    this.player.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld();

    this.player.getWorldPosition(this._vShip);
    this._vCam.copy(this.camera.position);
    const distWorld = this._vCam.distanceTo(this._vShip);
    const distM = distWorld / M;

    // Camera basis (world) + view metrics at the ship-centre depth plane.
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const fov = (this.camera.fov || 55) * DEG2RAD;
    this._halfH = distWorld * Math.tan(fov / 2);
    this._halfW = this._halfH * (this.camera.aspect || 1);

    // Camera position in player-local space + leader ribbon half-width.
    this._vCamLocal.copy(this._vCam);
    this.player.worldToLocal(this._vCamLocal);
    this._leaderHalfWidth = distWorld * LINE_HALF_WIDTH_FRAC;

    // Ship centre + silhouette radius in NDC → rail X positions.
    this._shipNDC.copy(this._vShip).project(this.camera);
    // Ship world-quaternion, hoisted here so _pickFocusPart (below) and _layout
    // both read the CURRENT rotation, not last frame's or identity (R6).
    this.player.getWorldQuaternion(this._qTmp);
    const shipBoundR = CFG.SHIP_BOUND_M * M;
    this._vTmp.copy(this._vShip).addScaledVector(this._camRight, shipBoundR).project(this.camera);
    const screenR = Math.abs(this._vTmp.x - this._shipNDC.x);
    const margin = CFG.RAIL_MARGIN_NDC;

    // Reserve the widest rail-card width on both sides (R15). aspect × heightFactor
    // is invariant (= CARD_W_OVER_TITLE_H ≈ 6.04) for every card, so the widest rail
    // card is always the SIZE_MAJOR tier — a constant, no per-rec loop, no frame lag.
    const camAspect = this.camera.aspect || 1;
    const railCardW = 2 * CFG.SIZE_MAJOR * CARD_W_OVER_TITLE_H / camAspect;

    this._railL = Math.max(-1 + margin + railCardW, this._shipNDC.x - screenR - CFG.RAIL_INSET_NDC);
    this._railR = Math.min(1 - margin - railCardW, this._shipNDC.x + screenR + CFG.RAIL_INSET_NDC);

    this._updateBand(distM);
    this._updateGuide(dt);

    this._vCamDir.copy(this._vCam).sub(this._vShip).normalize();

    // Resolve every rec's anchor for this frame BEFORE focus picking and layout
    // read them (T1; mirrors the R6 quaternion hoist).
    for (const rec of this._allRecs) this._resolveAnchor(rec);

    if (this._band === 'COMPONENT') this._focusPart = this._pickFocusPart();
    else this._focusPart = null;

    this._layout(dt);
  }

  _updateBand(distM) {
    const b = this._band;
    const prev = b;
    if (b === 'SYSTEM') {
      if (distM < BAND.partIn) this._band = 'PART';
    } else if (b === 'PART') {
      if (distM > BAND.partOut) this._band = 'SYSTEM';
      else if (distM < BAND.compIn) this._band = 'COMPONENT';
    } else {
      if (distM > BAND.compOut) this._band = 'PART';
    }
    if (this._band !== prev) {
      this._bandChangedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._revealSeq = 0;
      // T3: clear stale reveal holds so every rec gets a fresh stagger slot.
      for (const rec of this._allRecs) rec._revealAt = null;
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: this._band });
    }
  }

  /** P2: is any aft-flower pair purchased? Gates the THERMAL family. @private */
  _flowerOn() {
    return typeof this.player?.getFlowerPairCount === 'function'
      && this.player.getFlowerPairCount() > 0;
  }

  _updateGuide(dt) {
    if (this._guideT < -GUIDE_HOLD_S - 0.001 || this._guidedDone) return;
    this._guideT += dt;
    const total = this._tourableSystems().length * GUIDE_STEP_S;
    if (this._guideT >= total) { this._guidedDone = true; this._guideT = -1; }
  }

  /** Tourable groups: visible system labels only — DAUGHTERS excluded (its
   *  recs are the docked craft), THERMAL excluded pre-purchase (P2). @private */
  _tourableSystems() {
    return SYSTEMS.filter((s) => !s.daughters && !(s.flowerGated && !this._flowerOn()));
  }

  _guideSystemId() {
    if (this._guidedDone || this._guideT < 0) return null;
    const tourable = this._tourableSystems();
    const idx = Math.floor(this._guideT / GUIDE_STEP_S);
    return tourable[idx]?.id ?? null;
  }

  _pickFocusPart() {
    let best = null, bestD = Infinity;
    for (const p of this._partLabels) {
      if (p.isDetail) continue;
      // Skip hull-hidden parts (far side of ship) so focus doesn't reveal
      // a system detail tier at ~0 opacity (LOW-13).
      if (this._anchorVisible(p.anchor) < 0.2) continue;
      this._vAnchor.copy(p.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vTmp.copy(this._vAnchor).project(this.camera);
      if (this._vTmp.z > 1) continue;
      const d = this._vTmp.x * this._vTmp.x + this._vTmp.y * this._vTmp.y;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Anchor visibility gate (camera-facing dot proxy). Anchors on the far side
   * of the hull fade to 0. Returns 0..1.
   * Uses the ship world-quaternion hoisted in update() (R6).
   * T8: the anchor's RADIAL component is the surface normal; near-axial parts
   * (net launcher, turret, FEEP) are exempt — they read in silhouette at every
   * angle and must not fade to ~0.2 when viewed broadside.
   * @private
   */
  _anchorVisible(anchorLocal) {
    // Near-axial anchor: no meaningful radial normal → always face-visible.
    const r2 = anchorLocal.x * anchorLocal.x + anchorLocal.y * anchorLocal.y;
    const axialFloor = 0.15 * M;
    if (r2 < axialFloor * axialFloor) return 1;
    this._vFace.set(anchorLocal.x, anchorLocal.y, 0); // radial component only
    this._vFace.applyQuaternion(this._qTmp); // hoisted in update()
    if (this._vFace.lengthSq() < 1e-20) return 1;
    this._vFace.normalize();
    const d = this._vFace.dot(this._vCamDir);
    // Softened ramp: a part 90° off still reads ~0.42 instead of ~0.22 (T8).
    return Math.max(0, Math.min(1, (d + 0.25) / 0.6));
  }

  // --------------------------------------------------------------------------
  // RAIL LAYOUT
  // --------------------------------------------------------------------------

  /** On-screen height fraction (of viewport height) for a rec's tier. @private */
  _sizeFrac(rec, isFocus) {
    if (isFocus) return CFG.SIZE_CARD;
    if (rec.isSystem) return CFG.SIZE_SYSTEM;
    return rec.isDetail ? CFG.SIZE_DETAIL : CFG.SIZE_MAJOR;
  }

  /**
   * Full per-frame layout: compute target opacity + anchor NDC for every rec,
   * assign rail sides (with hysteresis), stack + cull each rail, ease positions
   * in NDC, then unproject to local sprite positions and rebuild leaders.
   * @private
   */
  _layout(dt) {
    const band = this._band;
    const guideId = this._guideSystemId();
    const focus = this._focusPart;
    const focusSys = focus?.sysId ?? null;
    const ease = 1 - Math.exp(-CFG.EASE_RATE * Math.max(dt, 0));
    const fadeK = Math.min(1, FADE_RATE * Math.max(dt, 0));

    // Refresh the focused card's live data at ≤ LIVE_REFRESH_HZ.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._nowMs = now;
    const liveDue = (now - this._lastLiveT) >= (1000 / (CFG.LIVE_REFRESH_HZ || 2));
    if (liveDue) this._lastLiveT = now;

    // Re-pick hover from the stored pointer position so it tracks cards sliding
    // under a stationary pointer (R13).
    this._refreshHover();

    // Reuse persistent rail arrays (LOW-16: zero per-frame alloc).
    const leftList = this._leftRail;
    const rightList = this._rightRail;
    leftList.length = 0;
    rightList.length = 0;

    // T6: project the focused part's anchor once so detail parts NEAR it on
    // screen can reveal even when they belong to another system.
    let focusNX = 0, focusNY = 0;
    if (focus) {
      this._vTmp.copy(focus.anchor);
      this.player.localToWorld(this._vTmp);
      this._vTmp.project(this.camera);
      focusNX = this._vTmp.x; focusNY = this._vTmp.y;
    }

    for (const rec of this._allRecs) {
      const isFocus = !rec.isSystem && band === 'COMPONENT' && rec === focus;

      // Anchor NDC (computed before target opacity: T6 proximity reveal reads it).
      this._vAnchor.copy(rec.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vAnchor.project(this.camera);
      const ax = this._vAnchor.x, ay = this._vAnchor.y, az = this._vAnchor.z;
      rec._anchorX = ax; rec._anchorY = ay; rec._anchorZ = az;

      // Facing ramp (0..1) — applied to the dot + leader (which sit on the hull)
      // in _positionCard, NOT to the card. Stored once per frame.
      rec._facing = this._anchorVisible(rec.anchor);

      let targetOp = this._targetOpacity(rec, band, guideId, focusSys, focusNX, focusNY, rec._facing);
      const off = CFG.OFFSCREEN_NDC;
      if (az > 1 || ax < -off || ax > off || ay < -off || ay > off) targetOp = 0;

      rec._targetOp = targetOp;

      // T3: scan-in stagger — assign a reveal timestamp when a card transitions
      // from hidden to visible after a band change. 150 ms hold so the old band
      // clears, then 40 ms/card stagger capped at 300 ms.
      if (rec._targetOp > 0.02 && rec.op <= 0.02 && rec._revealAt == null) {
        rec._revealAt = this._bandChangedAt + 150 + Math.min(300, (this._revealSeq++) * 40);
      }
      if (rec.op > 0.05) rec._revealAt = null;

      // Card content: focused → full detail card, else compact (R14: no hover variant).
      if (isFocus) {
        if (liveDue || !rec._wasFocus) this._applyCard(rec, { full: true });
        rec._wasFocus = true;
      } else if (rec._wasFocus) {
        this._applyCard(rec, { full: false });
        rec._wasFocus = false;
      }

      // T4: pending side-flip — commit when faded out, force fade otherwise.
      // Placed BEFORE the hidden early-continue so a rec fading out for a band
      // change while a flip is pending can't get stuck invisible.
      if (rec._pendingSide) {
        if (rec.op <= 0.05) {
          rec.side = rec._pendingSide;
          rec._pendingSide = null;
          rec._railOrder = null;
          rec.primed = false;
          rec._sideT = now;
        } else {
          targetOp = 0;
          rec._targetOp = 0;
        }
      }

      if (targetOp <= 0.001 && rec.op <= 0.02) {
        // Fully hidden — still ease opacity down, keep off rails.
        rec._isFocus = false;
        rec.op += (0 - rec.op) * fadeK;
        if (rec.op <= 0.02) {
          rec.primed = false; // reappear snaps to new slot, no sweep
          rec._railOrder = null; // reset rail ordinal when hidden
          rec._pendingSide = null; // T4: clear pending flip on hide
          rec.side = null; // T4: fresh side assignment on reappear (sets _sideT=now)
          rec._sideT = 0;
        }
        this._hideRec(rec);
        continue;
      }

      // Focused card is placed by its anchor, not on a rail.
      rec._isFocus = isFocus;
      if (isFocus) continue;

      // Side assignment with hysteresis + 1.5 s dwell (T4: fade-swap, never sweep).
      const desired = (ax < this._shipNDC.x) ? 'L' : 'R';
      // Cancel a queued flip if the anchor reverted back to the committed side.
      if (rec._pendingSide != null && desired === rec.side) {
        rec._pendingSide = null;
      }
      if (rec.side == null) {
        rec.side = desired;
        rec._railOrder = null; // reset ordinal on side entry
        rec._sideT = now;
      } else if (rec.side !== desired
        && Math.abs(ax - this._shipNDC.x) > CFG.SIDE_HYSTERESIS
        && (now - rec._sideT) > 1500) {
        rec._pendingSide = desired; // commit happens in the block above next frames
      }

      (rec.side === 'L' ? leftList : rightList).push(rec);
    }

    this._stackRail(leftList, this._railL, dt, ease, fadeK);
    this._stackRail(rightList, this._railR, dt, ease, fadeK);
    this._placeFocus(dt, ease, fadeK);
  }

  /** Target opacity for a rec given band/guide/focus, before anchor gating. @private
   * Round 6: binary legibility. The card's opacity is band/guide/focus only —
   * the facing ramp (which belongs to hardware on the hull, not a card on a
   * screen-edge rail) is a hard GATE here (back-facing → 0) and is applied as a
   * soft fade only to the dot + leader in _positionCard. Non-hidden targets are
   * floored to MIN_CARD_OP so a shown card is always readable, never muddy.
   * @param {number} [facing] pre-computed _anchorVisible(rec.anchor) for this
   *   frame (from _layout); recomputed only if not supplied (e.g. unit tests). */
  _targetOpacity(rec, band, guideId, focusSys, focusNX, focusNY, facing) {
    if (rec._neverShow) return 0; // DAUGHTERS pseudo-group has no system label
    if (rec._armGone) return 0;   // daughter away from its berth (T3)
    if (rec._flowerGone) return 0; // THERMAL family pre-purchase (P2)
    // Hard facing gate: a card whose anchor faces away is hidden outright
    // (the dot/leader carry the on-hull fade; the card does not).
    const face = (facing != null) ? facing : this._anchorVisible(rec.anchor);
    if (face < 0.15) return 0;
    const floor = CFG.MIN_CARD_OP ?? 0.5;
    if (rec.isSystem) {
      if (band !== 'SYSTEM') return 0;
      // Guided tour: highlighted system full, the rest dimmed (but still legible).
      if (guideId) return (rec.def.id === guideId) ? 1 : 0.5;
      return 1;
    }
    if (rec.isDetail) {
      let reveal = band === 'COMPONENT' && rec.sysId === focusSys;
      // T6: proximity reveal — detail parts near the focused part on screen
      // appear even when they belong to another system.
      if (!reveal && band === 'COMPONENT' && this._focusPart) {
        const dx = rec._anchorX - focusNX, dy = rec._anchorY - focusNY;
        const r = CFG.DETAIL_REVEAL_NDC || 0.25;
        if (dx * dx + dy * dy < r * r) reveal = true;
      }
      return reveal ? 1 : 0;
    }
    // Major part.
    const showParts = band === 'PART' || band === 'COMPONENT';
    if (!showParts) return 0;
    let op = 1;
    // Guided tour: non-highlighted systems dimmed but legible.
    if (guideId && rec.sysId !== guideId) op = 0.5;
    // COMPONENT band, not the focused part: recede a little (still readable).
    const isFocus = band === 'COMPONENT' && rec === this._focusPart;
    if (band === 'COMPONENT' && !isFocus) op = Math.min(op, 0.8);
    return Math.max(op, floor);
  }

  /**
   * Stack one rail's cards: order top → bottom (with hysteresis, via the pure
   * `orderRail` helper), priority-cull on overflow, assign slot Ys centred on
   * the anchors' mean, then ease + place.
   * @private
   */
  _stackRail(list, railX, dt, ease, fadeK) {
    if (list.length === 0) return;

    // Top → bottom order with persistent ordinals + hysteresis (R2).
    orderRail(list, CFG.ORDER_HYSTERESIS || 0.04);

    const gap = CFG.RAIL_GAP_NDC;
    const marginY = CFG.RAIL_MARGIN_NDC;
    const avail = 2 - 2 * marginY;

    // Heights (NDC full height = 2 * sizeFrac * heightFactor).
    for (const rec of list) {
      const heightFactor = rec.card?.heightFactor || 1;
      rec._h = 2 * this._sizeFrac(rec, false) * heightFactor;
    }

    // Priority culling if the stack overflows.
    let total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
    if (total > avail) {
      const sorted = [...list].sort((a, b) => this._cullScore(a) - this._cullScore(b));
      let i = 0;
      while (total > avail && i < sorted.length && list.length > 1) {
        const drop = sorted[i++];
        const idx = list.indexOf(drop);
        if (idx >= 0) {
          list.splice(idx, 1);
          drop._targetOp = 0;
          // Fade out and hide the culled rec this frame so it doesn't freeze.
          drop.op += (0 - drop.op) * fadeK;
          if (drop.op <= 0.02) drop.primed = false;
          drop._railOrder = null; // renumber when it re-enters (R2)
          this._hideRec(drop);
          total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
        }
      }
      // Renumber the survivors so ordinals stay contiguous after a cull.
      for (let i = 0; i < list.length; i++) list[i]._railOrder = i;
    }

    // Centre the stack on the anchors' mean Y, clamped to the viewport.
    let meanY = 0;
    for (const rec of list) meanY += rec._anchorY;
    meanY /= list.length;
    total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
    let topY = meanY + total / 2;
    const hiLimit = 1 - marginY;
    const loLimit = -1 + marginY;
    if (topY > hiLimit) topY = hiLimit;
    if (topY - total < loLimit) topY = loLimit + total;

    let cursor = topY;
    for (const rec of list) {
      const slotY = cursor - rec._h / 2;
      cursor -= rec._h + gap;
      this._placeRailRec(rec, railX, slotY, dt, ease, fadeK);
    }
  }

  /** Higher = keep. Detail tier culled first, then low priority/mass. @private */
  _cullScore(rec) {
    const tierBonus = rec.isDetail ? 0 : 1000;
    return tierBonus + (rec.def.priority || 0) * 10 + (rec.def.massKg || 0);
  }

  /** Ease a rail rec to (railX, slotY) NDC and place its sprite + leader. @private */
  _placeRailRec(rec, railX, slotY, dt, ease, fadeK) {
    if (!rec.primed) { rec.sx = railX; rec.sy = slotY; rec.primed = true; }
    else { rec.sx += (railX - rec.sx) * ease; rec.sy += (slotY - rec.sy) * ease; }

    const side = rec.side;
    // Card inner edge sits on the rail: left rail → right edge (center.x=1),
    // right rail → left edge (center.x=0). Leader attaches at sprite.position.
    rec.sprite.center.x = (side === 'L') ? 1 : 0;
    this._positionCard(rec, rec.sx, rec.sy, false, side, fadeK);
  }

  /** Place the focused COMPONENT card near its anchor (not on a rail). @private */
  _placeFocus(dt, ease, fadeK) {
    const rec = this._focusPart;
    if (!rec || !rec._isFocus) return;
    const now = this._nowMs;
    const desired = (rec._anchorX < this._shipNDC.x) ? 'L' : 'R';
    // T4: same 1.5 s dwell as rail flips — keep the last committed side until
    // dwell + hysteresis allow the change.
    if (rec.side == null) {
      rec.side = desired;
      rec._sideT = now;
    } else if (rec.side !== desired
      && Math.abs(rec._anchorX - this._shipNDC.x) > CFG.SIDE_HYSTERESIS
      && (now - rec._sideT) > 1500) {
      rec.side = desired;
      rec._sideT = now;
    }
    const side = rec.side;

    // Clamp focus card to viewport, accounting for card width on the extending side.
    // aspect × heightFactor = CARD_W_OVER_TITLE_H for every card (R15).
    const frac = this._sizeFrac(rec, true);
    const heightFactor = rec.card?.heightFactor || 1;
    const camAspect = this.camera.aspect || 1;
    const cardW = 2 * frac * CARD_W_OVER_TITLE_H / camAspect;
    const cardH = 2 * frac * heightFactor;
    const margin = CFG.RAIL_MARGIN_NDC;

    // Small fixed offset toward the nearer rail side.
    let tx = rec._anchorX + (side === 'L' ? -0.12 : 0.12);
    let ty = rec._anchorY + 0.07;

    // Clamp X: card extends outward from anchor, so reserve width on that side.
    if (side === 'L') tx = Math.max(tx, -1 + margin + cardW);
    else tx = Math.min(tx, 1 - margin - cardW);
    // Clamp Y: card is centred vertically on ty.
    ty = Math.max(-1 + margin + cardH / 2, Math.min(1 - margin - cardH / 2, ty));

    if (!rec.primed) { rec.sx = tx; rec.sy = ty; rec.primed = true; }
    else { rec.sx += (tx - rec.sx) * ease; rec.sy += (ty - rec.sy) * ease; }
    rec.sprite.center.x = (side === 'L') ? 1 : 0;
    this._positionCard(rec, rec.sx, rec.sy, true, side, fadeK);
  }

  /**
   * Given a rec's eased NDC slot, unproject to local space, size the sprite
   * screen-constant, ease opacity, and rebuild the elbow leader + dot.
   * @private
   */
  _positionCard(rec, nx, ny, isFocus, side, fadeK) {
    // Unproject NDC slot at ship-centre depth → world → local.
    // Use (nx − shipNDC.x) and (ny − shipNDC.y) so the offset is relative to
    // the ship's actual screen position, not absolute NDC (which would double-
    // shift when the inspection look-at carries a forward offset).
    this._vAttach.copy(this._vShip)
      .addScaledVector(this._camRight, (nx - this._shipNDC.x) * this._halfW)
      .addScaledVector(this._camUp, (ny - this._shipNDC.y) * this._halfH);
    this._vTmp.copy(this._vAttach);
    this.player.worldToLocal(this._vTmp);
    rec.sprite.position.copy(this._vTmp);

    // Screen-constant sizing (manual dist scaling; see plan task 6 fallback).
    // SIZE_* defines the on-screen height of the TITLE BLOCK; scale by heightFactor
    // so the whole card grows proportionally and text stays the same size.
    // aspect × heightFactor = CARD_W_OVER_TITLE_H for every card (R15), so derive
    // the width factor from the invariant instead of reading a possibly-stale card.
    const frac = this._sizeFrac(rec, isFocus);
    const heightFactor = rec.card?.heightFactor || 1;
    const h = frac * 2 * this._halfH * heightFactor;
    const aspect = CARD_W_OVER_TITLE_H / heightFactor;
    rec.sprite.scale.set(h * aspect, h, 1);

    // Ease opacity. T3: hold at 0 while waiting for the scan-in reveal slot.
    // Hover lifts it a little; the colour lift below carries the affordance at
    // full opacity where this boost is a no-op.
    const tgt = (rec._revealAt != null && this._nowMs < rec._revealAt) ? 0 : rec._targetOp;
    rec.op += (tgt - rec.op) * fadeK;
    const hovered = this._hoverRec === rec;
    const op = hovered ? Math.min(1, rec.op + 0.15) : rec.op;
    const visible = op > 0.02;
    rec.sprite.material.opacity = op;
    rec.sprite.visible = visible;
    // Round 6: cards are full-bright (no non-hover dim scalar — the vignette no
    // longer touches them, so a global dim only muddied them). The hover cue is
    // carried by the leader whitening (below), the +0.15 opacity lift, and a
    // small screen-constant scale bump.
    rec.sprite.material.color.setScalar(1.0);
    const hoverScale = hovered ? 1.04 : 1.0;
    rec.sprite.scale.multiplyScalar(hoverScale);
    // Depth sort: nearer anchor draws last.
    rec.sprite.renderOrder = 30 + Math.round((1 - rec._anchorZ) * 200);

    // Dot at the anchor. The facing ramp fades the on-hull marker (not the card).
    const facing = rec._facing != null ? rec._facing : 1;
    const dotWorldH = CFG.DOT_SIZE * 2 * this._halfH;
    rec.dot.position.copy(rec.anchor);
    rec.dot.scale.set(dotWorldH, dotWorldH, 1);
    rec.dot.material.opacity = op * facing;
    rec.dot.visible = visible;
    rec.dot.renderOrder = 31 + Math.round((1 - rec._anchorZ) * 200);

    // Elbow leader (opacity tracks the card, slightly dimmer, faded by facing).
    const lineOp = visible ? op * LINE_OP_SCALE * facing : 0;
    if (hovered) rec.line.material.color.set('#ffffff');
    else rec.line.material.color.set(rec.hue);
    this._setElbowLocal(rec.line, this._vAttach, rec.anchor, side, lineOp);
    rec.line.visible = visible;
  }

  /** Hide a rec fully (opacity 0), keeping it off the rails. @private */
  _hideRec(rec) {
    const vis = rec.op > 0.02;
    rec.sprite.material.opacity = rec.op;
    rec.sprite.visible = vis;
    rec.line.material.opacity = rec.op * LINE_OP_SCALE;
    rec.line.visible = vis;
    rec.dot.material.opacity = rec.op;
    rec.dot.visible = vis;
  }

  /**
   * Build a two-segment elbow leader ribbon: a horizontal screen-space stub off
   * the card edge (toward the ship), then a straight run to the anchor.
   * `attachWorld` is the card's on-rail edge (world); `anchorLocal` the part.
   * @private
   */
  _setElbowLocal(line, attachWorld, anchorLocal, side, opacity) {
    // Attach point in local space.
    this._rA.copy(attachWorld);
    this.player.worldToLocal(this._rA);
    // Anchor in local space (Vector3, resolved per frame — T1).
    const anchorL = this._rB.copy(anchorLocal);
    // Elbow joint: attach + a horizontal screen stub toward the ship.
    const stubWorld = CFG.ELBOW_STUB_NDC * this._halfW;
    const dir = (side === 'L') ? 1 : -1; // left rail → stub goes right (toward ship)
    this._vElbow.copy(attachWorld).addScaledVector(this._camRight, dir * stubWorld);
    this.player.worldToLocal(this._vElbow);

    const pos = line.geometry.attributes.position;
    this._ribbonQuad(pos, 0, this._rA, this._vElbow);
    this._ribbonQuad(pos, 4, this._vElbow, anchorL);
    pos.needsUpdate = true;
    line.material.opacity = opacity;
  }

  /** Write a 4-vertex camera-facing ribbon quad (local space) at index base. @private */
  _ribbonQuad(pos, base, aLocal, bLocal) {
    this._rMid.copy(aLocal).add(bLocal).multiplyScalar(0.5);
    this._rView.copy(this._vCamLocal).sub(this._rMid);
    this._rDir.copy(bLocal).sub(aLocal);
    this._rPerp.copy(this._rDir).cross(this._rView);
    if (this._rPerp.lengthSq() < 1e-30) this._rPerp.set(0, 1, 0).cross(this._rDir);
    this._rPerp.normalize().multiplyScalar(this._leaderHalfWidth || 0);

    this._rC0.copy(aLocal).add(this._rPerp);
    this._rC1.copy(aLocal).sub(this._rPerp);
    this._rC2.copy(bLocal).sub(this._rPerp);
    this._rC3.copy(bLocal).add(this._rPerp);
    pos.setXYZ(base + 0, this._rC0.x, this._rC0.y, this._rC0.z);
    pos.setXYZ(base + 1, this._rC1.x, this._rC1.y, this._rC1.z);
    pos.setXYZ(base + 2, this._rC2.x, this._rC2.y, this._rC2.z);
    pos.setXYZ(base + 3, this._rC3.x, this._rC3.y, this._rC3.z);
  }

  dispose() {
    this._detachPointer();
    // T2a: if inspection was active, tell the HUD breadcrumb to hide before
    // we tear down — otherwise it stays on screen permanently.
    if (this._active) {
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: null });
      this._active = false;
    }
    eventBus.off?.(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.off?.(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
    for (const s of this._allRecs) {
      // Dispose all cached card variants.
      if (s._cardCache) {
        for (const card of s._cardCache.values()) {
          card?.texture?.dispose();
        }
        s._cardCache.clear();
      }
      s.card?.texture?.dispose();
      s.sprite?.material?.dispose();
      s.line?.geometry?.dispose();
      s.line?.material?.dispose();
      s.dot?.material?.dispose();
    }
    this.player.remove(this._group);
  }
}

// Exported for tests (drift guard on the label table / codexId mapping).
export { SYSTEMS as MOTHER_CALLOUT_SYSTEMS };
