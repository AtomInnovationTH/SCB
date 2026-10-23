/**
 * ResupplySatellite.js - the resupply satellite's LOOK in the world (Nets step 3 slice 3, lane 3b; DECISIONS §33 rows 7 and 10:
 * "it berths the mother at her nose collar, its arm swaps net cartridges, it pumps gas").
 *
 * A small servicer built from procedural THREE geometry: a box bus, two solar wings, a dish, a cartridge rack on top, a robotic arm
 * with an end effector (a docking probe) and a fuel line that runs along the arm to the grip on her nose ring. It is its own `THREE.Group` in the scene. It is NEVER a child of
 * `PlayerSatellite` and NEVER one of `ActiveSatellites` (those are collision hazards: touching one ends the run).
 *
 * What it shows (all driven by events, the logic is GameFlowManager's):
 *   RESUPPLY_BERTH {phase: 'berthed'}  it appears ahead of her on her orbit, facing her, and its arm closes on her nose collar
 *                                      (`player.getNetBerthCollarPositionInto`) over about 3 s, then stays rigidly mated in her frame.
 *                                      A second 'berthed' while it is mated or closing does nothing (a trip that could not go re-sends it).
 *   UPGRADE_PURCHASED {motherNetRestock}  the arm carries one cartridge from its rack to her net launcher face (about 4 s).
 *   RESOURCE_UPGRADED {engineGasResupply} (or a call to `showGasFlow()`) "gas flowing" lights the coupling on the effector for about 2 s,
 *                                      but only while the grip is on her ring (an arm away on a cartridge swap makes the flow wait).
 *                                      The fuel line itself is plumbing: always visible, bus coupling -> along both arm links and the wrist
 *                                      (following every joint, a swap included) -> the effector coupling. Her tanks feed her docked daughters.
 *   RESUPPLY_BERTH {phase: 'left'}     the arm lets go and the satellite drifts ahead, out of the near field, then hides.
 *   RESUPPLY_BERTH {phase: 'coming', playS}  (lane 3c's call) it approaches from far ahead over `playS` real seconds, then waits.
 *   game over, win, menu, a new run      hidden and reset.
 * A load while berthed emits nothing, so on its first update it reads `fieldRegistry.isBerthed()` and appears already mated.
 *
 * Frames and units. Satellite-local metres: +Z toward her (it faces her), +Y up, X along the solar wings; the group's orientation is
 * her orientation turned half a turn about Y, so local +Z is her -Z. Its origin is the bus centre, `dist` metres ahead of her collar
 * along her +Z (her heading is exact prograde, CONVENTIONS Rule 8, so her +Z is ahead on her orbit). Geometry is written in metres
 * times `M` (scene units, 1 m = 1e-5). The whole craft stays within 4 m of its origin so the near-field pass (+-10 m bracket around
 * a root) can hold it: it joins the near pass within 8.5 m of her and leaves beyond 9.5 m (as ArmManager._updateNearFieldMembership).
 * The near pass is off on floors 4 and 5 and nothing else hides it, so it hides itself there (a floor getter, not the ladder object).
 *
 * Call it from the main loop AFTER player.update (it sits on her collar; CONVENTIONS Rule G).
 * @module entities/ResupplySatellite
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { AVIONICS_GUNMETAL, AVIONICS_DARK_OPTIC, AVIONICS_THERMAL_WHITE } from '../scene/avionicsMaterials.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';

const M = Constants.SCENE_UNITS_PER_METER;
const RO = Constants.RENDER_ORDER;

// ── the berth, metres ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Bus centre to her nose collar when mated: the bus front face is at +0.9, the arm bridges the rest. */
export const MATED_DIST_M = 3.2;
/** Hover distance while it waits for 'berthed' after a call ('coming'): outside the near field, in sight. */
export const HOVER_DIST_M = 14;
/** Where a call starts it: far ahead on her orbit. */
export const COMING_START_M = 1200;
/** Distance at which it appears for a berth with no approach before it. */
export const APPEAR_DIST_M = 9;
/** Seconds the arm takes to close on the collar (the satellite glides in over the first two thirds). */
export const CLOSE_S = 3;
const GLIDE_S = 2;
/** Drift after 'left': release (arm retracts) for 1 s, then a steady push. Hidden beyond HIDE_DIST_M. */
const RELEASE_S = 2.5;                         // the arm stows along a raised path (about 6 m of travel), so it takes longer than a straight pull
const DRIFT_START_S = 1.5;
const DRIFT_ACCEL = 0.8;                       // m/s^2
export const HIDE_DIST_M = 60;
/** Near-field membership (the ship's own bracket is never widened). */
export const NEAR_JOIN_M = 8.5;
export const NEAR_LEAVE_M = 9.5;
/** Seconds of a coupling show and of a cartridge swap (the timeline below sums to SWAP_S). */
export const GAS_S = 2;
export const SWAP_S = 4.2;
const SWAP_QUEUE_MAX = 8;
const DEFAULT_PLAY_S = 20;

// ── the craft, satellite-local metres ──────────────────────────────────────────────────────────────────────────────────────────
const BUS = { x: 1.6, y: 1.2, z: 1.8 };
const WING = { len: 2.7, chord: 1.3, inner: 0.9 };            // x from 0.9 to 3.6: the whole span is 7.2 m (<= 8)
const ARM_BASE = new THREE.Vector3(0, 0.8, 0.8);               // shoulder, on the bus top front edge
const LINK_M = 1.3;                                            // upper arm and forearm, each
const WRIST_M = 0.3;                                           // wrist stub to the effector point
const STOW_TIP = new THREE.Vector3(0, 0.85, -0.9);             // arm laid back along the bus top
const SLOT_Z = [-0.7, -0.35, 0, 0.35];                         // cartridge slots on the rack (x 0); the front one stands 0.2 m clear of the shoulder pedestal
const SLOT_Y = 0.72;
const CART = { r: 0.07, len: 0.22 };
/** The fuel line: radius, and its side offset from the arm's axis (the links are r 45-50 mm, so the line floats 18+ mm clear: no z-fight). */
export const GAS_LINE_R = 0.012;
export const GAS_LINE_OFFSET_M = 0.08;
const GAS_COUPLING = new THREE.Vector3(GAS_LINE_OFFSET_M, 0.74, ARM_BASE.z);   // the bus's gas coupling: a block on the shoulder pedestal, line starts on its top
const GAS_HEAD_BACK_M = WRIST_M - 0.09;                        // along the wrist from the wrist joint: the probe head's back face (the line enters the head there)
const GAS_COLOR = 0x33ff88;
const GAS_END_IN_M = 0.02;                                     // the line ends this far inside the probe head, so its flat end cap never reaches past the head's front face
const FLOW_FADE_S = 0.25;                                      // the flow light fades out and in over this long (never cut)
const LAUNCHER_FACE_BEHIND_M = 0.028;                          // her net launcher face is 30 mm behind the collar plane (z 1.27 vs 1.30); stop 2 mm short

/** Cartridge swap path (satellite-local metres, mated: the bus centre is MATED_DIST_M from the collar). The tip never goes straight
 *  through the bus: out along the collar axis, up to RAISE_Y over the rack, down onto the slot's front end, and the same way back. */
const RAISE = new THREE.Vector3(0, 1.05, 1.1);
/** The stow / dock path (arm closed 0 .. 1): straight up from the stowed pose to RAISE height, forward over the rack to RAISE, then down and out
 *  to the hold point. Same raised waypoints as the swap, so the head and the fuel line never cross the bus, tray or cartridges. */
const STOW_RISE = new THREE.Vector3(0, RAISE.y, STOW_TIP.z);
const SWAP_HOLD = new THREE.Vector3(0, 0, MATED_DIST_M);
const SWAP_STAND = new THREE.Vector3(0, 0, MATED_DIST_M - 0.3);
const SWAP_INSERT = new THREE.Vector3(0, 0, MATED_DIST_M + LAUNCHER_FACE_BEHIND_M);
/** Per slot: [{ d seconds, a, b }] legs; the durations sum to SWAP_S (4.2). The cartridge is carried from 0.9 s to 3.2 s. */
const SWAP_LEGS = SLOT_Z.map((sz) => {
  const pick = new THREE.Vector3(0, SLOT_Y, sz + CART.len / 2);
  const above = new THREE.Vector3(0, RAISE.y, pick.z);
  const L = (d, a, b) => ({ d, a, b });
  return [
    L(0.2, SWAP_HOLD, SWAP_STAND), L(0.2, SWAP_STAND, RAISE), L(0.2, RAISE, above), L(0.2, above, pick),   // out to the slot (0.8)
    L(0.2, pick, pick),                                                                                    // grip
    L(0.25, pick, above), L(0.25, above, RAISE), L(0.5, RAISE, SWAP_STAND),                                // lift and back (to 2.0)
    L(0.9, SWAP_STAND, SWAP_INSERT), L(0.3, SWAP_INSERT, SWAP_INSERT), L(1.0, SWAP_INSERT, SWAP_HOLD),       // in, let go, home
  ];
});

const _Z = new THREE.Vector3(0, 0, 1);
const QY_PI = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);   // her frame -> the satellite's (+Z toward her)
const smooth = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
const lerp = (a, b, t) => a + (b - a) * t;

/** A cylinder along +Z from z 0 to `len` (Rule 4: Cylinder axis is Y, rotateX(PI/2) puts it on Z). Metres in, scene units out. */
function cylZ(r, len, segs = 24) {
  const g = new THREE.CylinderGeometry(r * M, r * M, len * M, segs);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len * M / 2);
  return g;
}

export class ResupplySatellite {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} [o.sceneManager] for registerNearFieldRoot / unregisterNearFieldRoot
   * @param {object} o.player the mother: `position`, `quaternion`, `getNetBerthCollarPositionInto(out)`
   * @param {object} [o.fieldRegistry] `isBerthed()`, read once on the first update (a load while berthed)
   * @param {() => (number|null)} [o.floor] the ladder floor now, or null (hidden on 4 and 5)
   */
  constructor({ scene, sceneManager = null, player, fieldRegistry = null, floor = null } = {}) {
    this.scene = scene;
    this.sceneManager = sceneManager;
    this.player = player;
    this.fieldRegistry = fieldRegistry;
    this._floor = floor;

    this.group = new THREE.Group();
    this.group.name = 'ResupplySatellite';
    this.group.visible = false;
    this._mats = [];
    this._geos = [];
    this._build();
    if (scene) scene.add(this.group);

    this._state = 'hidden';            // hidden | coming | hover | docking | mated | leaving
    this._synced = false;
    this._t = 0;
    this._dist = MATED_DIST_M;
    this._distFrom = MATED_DIST_M;
    this._armS = 0;                    // 0 stowed .. 1 closed on the collar
    this._armFrom = 0;                 // docking closes from where the arm is
    this._w = 0;                       // weight of her nose frame (1) against her prograde frame (0) in the placement
    this._wFrom = 0;
    this._playS = DEFAULT_PLAY_S;
    this._speed = 0;                   // leaving: m/s ahead
    this._satId = null;
    this._altKm = null;
    this._swapsQueued = 0;
    this._swapT = -1;                  // < 0: no swap running
    this._swapSlot = 0;
    this._swapCount = 0;
    this._gasT = -1;
    this._gasPending = false;
    this._gasOn = false;               // "gas flowing" shows now (the grip is on her ring and the flow timer runs)
    this._flowI = 0;                   // 0..1 the flow light now (the envelope, rate-limited: it fades, never cuts)
    this._dt = 0;                      // the frame's dt, for the light fade
    this._nearMember = false;
    this._tip = new THREE.Vector3();   // effector point, satellite-local metres
    this._elbowM = new THREE.Vector3();   // elbow and wrist joints as the arm stands, satellite-local metres (the fuel line follows them)
    this._wristM = new THREE.Vector3();
    this._line = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
    this._dirNose = new THREE.Vector3();
    this._dirPro = new THREE.Vector3();
    this._qPro = new THREE.Quaternion();
    this._qBase = new THREE.Quaternion();

    this._onBerth = (e) => this._handleBerth(e || {});
    this._onPurchase = (e) => { if (e && e.effect === 'motherNetRestock') this._queueSwap(); };
    this._onGas = (e) => { if (e && e.effect === 'engineGasResupply') this._queueGas(); };
    this._onReset = () => this.reset();
    this._onState = (e) => {
      const to = e && e.to;
      if (to === GameStates.MENU || to === GameStates.GAME_OVER || to === GameStates.WIN) this.reset();
    };
    eventBus.on(Events.RESUPPLY_BERTH, this._onBerth);
    eventBus.on(Events.UPGRADE_PURCHASED, this._onPurchase);
    eventBus.on(Events.RESOURCE_UPGRADED, this._onGas);
    eventBus.on(Events.GAME_RESET, this._onReset);
    eventBus.on(Events.GAME_STATE_CHANGE, this._onState);
    this._poseArm();
    this._poseLine();
  }

  // ── geometry ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  _mat(opts) {
    const m = new THREE.MeshStandardMaterial(opts);
    this._mats.push(m);
    return m;
  }

  _mesh(parent, name, geo, mat, order, x = 0, y = 0, z = 0) {
    this._geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.renderOrder = order;
    m.position.set(x * M, y * M, z * M);
    parent.add(m);
    return m;
  }

  _build() {
    const foil = this._mat({ color: 0xb8923c, metalness: 0.7, roughness: 0.4 });
    const gun = this._mat({ ...AVIONICS_GUNMETAL });
    const dark = this._mat({ ...AVIONICS_DARK_OPTIC });
    const white = this._mat({ ...AVIONICS_THERMAL_WHITE });
    const panelBack = this._mat({ color: 0x2a2d35, metalness: 0.5, roughness: 0.5 });
    const cellMat = { color: 0x16264f, metalness: 0.6, roughness: 0.35 };
    const tex = getSolarCellTexture();
    if (tex) cellMat.map = tex;
    const cells = this._mat(cellMat);
    const g = this.group;

    // bus, interface plate (stands 40 mm proud of the front face), dish on a stalk, a thermal-white radiator band
    this._mesh(g, 'SatBus', new THREE.BoxGeometry(BUS.x * M, BUS.y * M, BUS.z * M), foil, RO.SPACECRAFT_OPAQUE);
    this._mesh(g, 'SatInterfacePlate', new THREE.BoxGeometry(1.4 * M, 1.0 * M, 0.04 * M), gun, RO.SPACECRAFT_DETAIL, 0, 0, BUS.z / 2 + 0.02);
    this._mesh(g, 'SatRadiator', new THREE.BoxGeometry((BUS.x + 0.01) * M, 0.16 * M, 1.2 * M), white, RO.SPACECRAFT_DETAIL, 0, -BUS.y / 2 + 0.2, -0.1);
    this._mesh(g, 'SatDishStalk', cylZ(0.03, 0.3, 16), gun, RO.SPACECRAFT_OPAQUE, 0, -0.2, -1.15);
    const dishGeo = new THREE.SphereGeometry(0.4 * M, 32, 12, 0, Math.PI * 2, 0, Math.PI / 3);
    dishGeo.rotateX(Math.PI / 2);                  // pole toward +Z, the bowl opens toward -Z (away from her)
    const dish = this._mesh(g, 'SatDish', dishGeo, white, RO.SPACECRAFT_OPAQUE, 0, -0.2, -1.55);
    dish.material.side = THREE.DoubleSide;

    // two solar wings: boom, backing plate, cell layer (1.5 mm proud of the backing)
    for (const s of [-1, 1]) {
      this._mesh(g, `SatWingBoom_${s < 0 ? 'L' : 'R'}`, new THREE.CylinderGeometry(0.04 * M, 0.04 * M, 0.2 * M, 16).rotateZ(Math.PI / 2), gun,
        RO.SPACECRAFT_OPAQUE, s * (BUS.x / 2 + 0.05), 0, 0);
      const cx = s * (WING.inner + WING.len / 2);
      this._mesh(g, `SatWingBack_${s < 0 ? 'L' : 'R'}`, new THREE.BoxGeometry(WING.len * M, 0.03 * M, WING.chord * M), panelBack, RO.SPACECRAFT_OPAQUE, cx, 0, 0);
      const cellGeo = new THREE.BoxGeometry((WING.len - 0.04) * M, 0.01 * M, (WING.chord - 0.04) * M);
      this._mesh(g, `SatWingCells_${s < 0 ? 'L' : 'R'}`, cellGeo, cells, RO.SPACECRAFT_DETAIL, cx, 0.022, 0);
    }

    // the cartridge rack on the bus top (tray buried 5 mm) and its four cartridges
    // the tray is half buried (top at 0.625); each cartridge rests 25 mm above it on a saddle, so the probe head (r 90 mm) can grip the
    // front end of a cartridge without touching the tray
    this._mesh(g, 'SatRackTray', new THREE.BoxGeometry(0.5 * M, 0.05 * M, 1.7 * M), gun, RO.SPACECRAFT_DETAIL, 0, BUS.y / 2, 0);
    for (let i = 0; i < SLOT_Z.length; i++) {
      this._mesh(g, `SatRackSaddle_${i}`, new THREE.BoxGeometry(0.12 * M, 0.026 * M, 0.06 * M), gun, RO.SPACECRAFT_DETAIL, 0, 0.6375, SLOT_Z[i] - 0.05);
    }
    this._carts = SLOT_Z.map((z, i) => {
      const c = new THREE.Group();
      c.name = `SatCartridge_${i}`;
      this._mesh(c, `SatCartridgeBody_${i}`, cylZ(CART.r, CART.len), gun, RO.SPACECRAFT_OPAQUE, 0, 0, -CART.len / 2);
      this._mesh(c, `SatCartridgeCap_${i}`, cylZ(CART.r - 0.005, 0.02), white, RO.SPACECRAFT_DETAIL, 0, 0, CART.len / 2 - 0.018);
      c.position.set(0, SLOT_Y * M, z * M);
      g.add(c);
      return c;
    });

    // the arm: shoulder pedestal (buried 20 mm), joints, two links, wrist stub, docking probe
    this._mesh(g, 'SatShoulderPedestal', new THREE.BoxGeometry(0.3 * M, 0.12 * M, 0.3 * M), gun, RO.SPACECRAFT_OPAQUE, ARM_BASE.x, ARM_BASE.y - 0.16, ARM_BASE.z);
    this._mesh(g, 'SatShoulder', new THREE.SphereGeometry(0.09 * M, 24, 12), gun, RO.SPACECRAFT_DETAIL, ARM_BASE.x, ARM_BASE.y, ARM_BASE.z);
    this._upper = new THREE.Group(); this._upper.name = 'SatArmUpper';
    this._mesh(this._upper, 'SatArmUpperLink', cylZ(0.05, LINK_M), gun, RO.SPACECRAFT_OPAQUE);
    this._elbow = this._mesh(g, 'SatElbow', new THREE.SphereGeometry(0.07 * M, 24, 12), foil, RO.SPACECRAFT_DETAIL);
    this._fore = new THREE.Group(); this._fore.name = 'SatArmFore';
    this._mesh(this._fore, 'SatArmForeLink', cylZ(0.045, LINK_M), gun, RO.SPACECRAFT_OPAQUE);
    this._wrist = new THREE.Group(); this._wrist.name = 'SatWrist';
    this._mesh(this._wrist, 'SatWristStub', cylZ(0.04, WRIST_M), gun, RO.SPACECRAFT_OPAQUE);
    // the docking probe at the tip: a head (r 90 mm) and a collet ring on the axis, inside the collar bore (r 140 mm to the ring tube),
    // never a ring round the collar (measured: the sun sensors, lamp housings and baffle stand 2-6 cm from any ring of r 0.17-0.25 at z 1.30-1.35)
    this._mesh(this._wrist, 'SatProbeHead', cylZ(0.09, 0.09, 32), foil, RO.SPACECRAFT_DETAIL, 0, 0, WRIST_M - 0.09);
    this._mesh(this._wrist, 'SatProbeCollet', new THREE.TorusGeometry(0.1 * M, 0.012 * M, 12, 48), gun, RO.SPACECRAFT_DETAIL, 0, 0, WRIST_M - 0.09);
    this._upper.position.copy(ARM_BASE).multiplyScalar(M);
    g.add(this._upper, this._fore, this._wrist);

    // the bus's gas coupling: a block on the shoulder pedestal (the line starts on its top)
    this._mesh(g, 'SatGasCoupling', new THREE.BoxGeometry(0.06 * M, 0.04 * M, 0.06 * M), gun, RO.SPACECRAFT_CONNECTOR, GAS_COUPLING.x, GAS_COUPLING.y - 0.02, GAS_COUPLING.z);

    // the fuel line: five straight runs (coupling -> shoulder -> elbow -> wrist -> into the probe head -> the effector coupling) and a
    // ball at each bend. It lies a few cm beside the arm in the arm's plane's normal (x) and is re-aimed every frame (_poseLine)
    this._lineMat = this._mat({ ...AVIONICS_DARK_OPTIC, emissive: GAS_COLOR, emissiveIntensity: 0 });
    this._segs = [];
    for (let i = 0; i < 5; i++) this._segs.push(this._mesh(g, `SatFuelLine_${i}`, cylZ(GAS_LINE_R, 1, 10), this._lineMat, RO.SPACECRAFT_CONNECTOR));
    this._joints = [];
    for (let i = 0; i < 4; i++) this._joints.push(this._mesh(g, `SatFuelLineBend_${i}`, new THREE.SphereGeometry(GAS_LINE_R * M, 10, 6), this._lineMat, RO.SPACECRAFT_CONNECTOR));
    // the coupling on the effector's front face where it meets her ring: a dark disc with a small light (green while gas flows).
    // It stands 1 mm proud of the head's face, so it never touches her launcher face when the tip stops 2 mm short.
    this._lightMat = this._mat({ color: 0x0c2a18, metalness: 0.3, roughness: 0.5, emissive: GAS_COLOR, emissiveIntensity: 0 });
    this._gasLight = this._mesh(this._wrist, 'SatGasLight', cylZ(0.035, 0.012, 20), this._lightMat, RO.SPACECRAFT_CONNECTOR, 0, 0, WRIST_M - 0.011);
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  _handleBerth(e) {
    const phase = e.phase;
    if (phase === 'berthed') {
      this._satId = e.satId ?? this._satId;
      this._altKm = e.altKm ?? this._altKm;
      if (this._state === 'mated' || this._state === 'docking') return;      // a repeat changes nothing
      this._synced = true;
      this._swapsQueued = 0; this._swapT = -1; this._gasT = -1; this._gasPending = false;
      if (this._state === 'hidden') { this._dist = APPEAR_DIST_M; this._armS = 0; this._w = 0; }
      this._distFrom = this._dist;                                           // from hover, mid-approach or a drift: glide in from where it is
      this._armFrom = this._armS;                                            // ... and close the arm from where it is (never a snap to stowed)
      this._wFrom = this._w;
      this._state = 'docking';
      this._t = 0;
    } else if (phase === 'left') {
      if (this._state === 'hidden' || this._state === 'leaving') return;
      this._wFrom = this._state === 'mated' ? 1 : this._w;
      this._state = 'leaving';
      this._t = 0;
      this._speed = 0;
      this._swapT = -1; this._swapsQueued = 0; this._gasT = -1; this._gasPending = false;
    } else if (phase === 'coming') {
      if (this._state !== 'hidden') return;
      this._synced = true;
      this._state = 'coming';
      this._t = 0;
      this._playS = (e.playS > 0 ? e.playS : DEFAULT_PLAY_S);
      this._dist = COMING_START_M;
      this._armS = 0;
      this._w = 0;
    }
  }

  _queueSwap() {
    if (this._state !== 'mated' && this._state !== 'docking') return;
    if (this._swapsQueued < SWAP_QUEUE_MAX) this._swapsQueued++;
  }

  _queueGas() { this.showGasFlow(); }

  /** "Gas flowing": about GAS_S seconds of light on the effector coupling. Only while it is berthed to her (closing or mated), and it
   *  shows only while the grip is on her ring: with the arm away on a cartridge swap it waits until the grip is back. A later lane
   *  calls this for a cold-gas buy. */
  showGasFlow() {
    if (this._state !== 'mated' && this._state !== 'docking') return;
    this._gasPending = true;
  }

  /** Hidden and forgotten (game over, win, menu, a new run). */
  reset() {
    this._state = 'hidden';
    this._synced = false;
    this._t = 0;
    this._armS = 0; this._armFrom = 0; this._w = 0; this._wFrom = 0;
    this._swapsQueued = 0; this._swapT = -1; this._gasT = -1; this._gasPending = false;
    this._flowI = 0; this._dt = 0;
    this._speed = 0;
    this.group.visible = false;
    this._setNear(false);
    this._restoreCarts();
    this._poseArm();
    this._poseLine();
  }

  // ── per frame ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** @param {number} dt real seconds */
  update(dt) {
    const player = this.player;
    if (!player) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);

    // a load or a new gameplay start while berthed emits nothing: read the registry once and appear already mated
    if (!this._synced) {
      this._synced = true;
      const reg = this.fieldRegistry;
      if (this._state === 'hidden' && reg && typeof reg.isBerthed === 'function' && reg.isBerthed()) {
        const sat = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
        this._satId = sat ? sat.id : this._satId;
        this._altKm = sat ? sat.altKm : this._altKm;
        this._state = 'mated';
        this._dist = MATED_DIST_M;
        this._armS = 1;
      }
    }

    this._dt = dt;
    this._advance(dt);
    this._place();
    this._poseArm();
    this._poseLine();

    let floor = null;
    if (this._floor) { try { floor = this._floor(); } catch (_e) { floor = null; } }
    this.group.visible = this._state !== 'hidden' && floor !== 4 && floor !== 5;
    this._updateNearMembership();
  }

  _advance(dt) {
    switch (this._state) {
      case 'coming': {
        this._t += dt;
        const s = Math.min(1, this._t / this._playS);
        this._dist = lerp(COMING_START_M, HOVER_DIST_M, 1 - (1 - s) * (1 - s));
        if (s >= 1) { this._dist = HOVER_DIST_M; this._state = 'hover'; }
        break;
      }
      case 'docking': {
        this._t += dt;
        this._dist = lerp(this._distFrom, MATED_DIST_M, smooth(this._t / GLIDE_S));
        this._armS = lerp(this._armFrom, 1, smooth(this._t / CLOSE_S));
        if (this._t >= CLOSE_S) { this._dist = MATED_DIST_M; this._armS = 1; this._state = 'mated'; this._t = 0; }
        break;
      }
      case 'mated': {
        this._armS = 1;
        this._dist = MATED_DIST_M;
        if (this._swapT < 0 && this._swapsQueued > 0) {
          this._swapsQueued--;
          this._swapT = 0;
          this._swapSlot = this._swapCount++ % SLOT_Z.length;
        }
        if (this._swapT >= 0) {
          this._swapT += dt;
          if (this._swapT >= SWAP_S) { this._swapT = -1; this._restoreCarts(); }
        }
        // gas flows only while the grip is on her ring (no swap running or queued); a flow cut off by a swap pauses and resumes after it
        if (this._swapT < 0 && this._swapsQueued === 0) {
          if (this._gasPending && this._gasT < 0) { this._gasPending = false; this._gasT = 0; }
          if (this._gasT >= 0) {
            this._gasT += dt;
            if (this._gasT >= GAS_S) this._gasT = -1;
          }
        }
        break;
      }
      case 'leaving': {
        this._t += dt;
        this._armS = 1 - smooth(this._t / RELEASE_S);
        if (this._t > DRIFT_START_S) {
          this._speed += DRIFT_ACCEL * dt;
          this._dist += this._speed * dt;
        }
        if (this._dist >= HIDE_DIST_M) { this._state = 'hidden'; this._armS = 0; this._synced = true; }
        break;
      }
      default: break;
    }
  }

  /** Weight of her nose frame in the placement now: 1 docked, 0 on her orbit (coming, waiting), easing between while it glides in or drifts out. */
  _noseWeight() {
    switch (this._state) {
      case 'mated': return 1;
      case 'docking': return lerp(this._wFrom, 1, smooth(this._t / GLIDE_S));
      case 'leaving': return this._wFrom * (1 - smooth((this._dist - 5) / 5));       // keeps her nose line until clear of her hull (5 m), on her orbit by 10 m
      default: return 0;
    }
  }

  /** The group sits `dist` from her collar: along her nose and in her attitude while docked, along her PROGRADE (her velocity) otherwise. */
  _place() {
    const p = this.player;
    const q = p.quaternion;
    const collar = p.getNetBerthCollarPositionInto(this._tmpA);
    const pro = typeof p._progradeQuat === 'function' ? p._progradeQuat(this._qPro) : null;
    const w = pro ? this._noseWeight() : 1;                                          // no velocity (a stub): her nose
    this._w = w;
    const dir = this._dirNose.copy(_Z).applyQuaternion(q);
    if (w < 1) {
      this._dirPro.copy(_Z).applyQuaternion(pro);
      dir.multiplyScalar(w).addScaledVector(this._dirPro, 1 - w).normalize();
      this._qBase.slerpQuaternions(pro, q, w);
    } else {
      this._qBase.copy(q);
    }
    this.group.position.copy(collar).addScaledVector(dir, this._dist * M);
    this.group.quaternion.copy(this._qBase).multiply(QY_PI);
  }

  // ── the arm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Swap timeline: the legs of the running slot (SWAP_LEGS), no allocation. The cartridge is carried from GRAB_AT to INSERT_AT. */
  _swapTip(t, out) {
    const legs = SWAP_LEGS[this._swapSlot];
    let acc = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (t <= acc + leg.d) return out.lerpVectors(leg.a, leg.b, smooth((t - acc) / leg.d));
      acc += leg.d;
    }
    return out.copy(SWAP_HOLD);
  }

  /** Whether the swap has the cartridge in the grip at time t (grabbed at 1.0 s, inserted at 3.2 s). */
  _carrying(t) { return t >= 0.9 && t < 3.2; }

  /** The tip on the stow / dock path at closure `s` (0 stowed .. 1 on `hold`), by path length; no allocation. */
  _pathTip(s, hold, out) {
    const l0 = STOW_TIP.distanceTo(STOW_RISE), l1 = STOW_RISE.distanceTo(RAISE), l2 = RAISE.distanceTo(hold);
    let u = Math.min(1, Math.max(0, s)) * (l0 + l1 + l2);
    if (u <= l0) return out.lerpVectors(STOW_TIP, STOW_RISE, u / l0);
    u -= l0;
    if (u <= l1) return out.lerpVectors(STOW_RISE, RAISE, u / l1);
    return out.lerpVectors(RAISE, hold, Math.min(1, (u - l1) / Math.max(l2, 1e-6)));
  }

  _poseArm() {
    const tip = this._tip;
    const hold = this._tmpA.set(0, 0, this._dist);
    if (this._swapT >= 0) this._swapTip(this._swapT, tip);
    else this._pathTip(this._armS, hold, tip);

    // planar two-link IK in the YZ plane (x = 0), elbow always up (+Y)
    const wy = tip.y;
    const wz = tip.z - WRIST_M;
    let vy = wy - ARM_BASE.y;
    let vz = wz - ARM_BASE.z;
    let d = Math.hypot(vy, vz);
    const reach = 2 * LINK_M - 1e-3;
    if (d > reach) { vy *= reach / d; vz *= reach / d; d = reach; }
    if (d < 1e-3) { vy = 0; vz = 1e-3; d = 1e-3; }
    const uy = vy / d, uz = vz / d;
    const a = d / 2;                                      // equal links
    const h = Math.sqrt(Math.max(LINK_M * LINK_M - a * a, 0));
    let py = uz, pz = -uy;                                // perpendicular in the plane
    if (py < 0 || (py === 0 && pz < 0)) { py = -py; pz = -pz; }
    const ey = ARM_BASE.y + uy * a + py * h;
    const ez = ARM_BASE.z + uz * a + pz * h;
    const wyc = ARM_BASE.y + vy, wzc = ARM_BASE.z + vz;   // wrist joint, after the reach clamp

    const E = this._tmpB.set(0, ey, ez);
    this._elbowM.copy(E);
    this._wristM.set(0, wyc, wzc);
    this._elbow.position.copy(E).multiplyScalar(M);
    this._aim(this._upper, ARM_BASE, E);
    this._fore.position.copy(E).multiplyScalar(M);
    this._aim(this._fore, E, this._tmpV.set(0, wyc, wzc));
    this._wrist.position.set(0, wyc * M, wzc * M);
    this._tip.set(0, wyc, wzc + WRIST_M);                 // the effector point as the arm actually stands (reach-clamped)

    // the carried cartridge rides in the probe's grip (front end at the tip); otherwise each sits in its slot
    if (this._swapT >= 0) {
      const c = this._carts[this._swapSlot];
      const t = this._swapT;
      if (this._carrying(t)) {
        c.visible = true;
        c.position.set(0, this._tip.y * M, (this._tip.z - CART.len / 2) * M);
      } else if (t >= 3.2) {
        c.visible = false;                                // inserted into her launcher
      } else {
        c.visible = true;
        c.position.set(0, SLOT_Y * M, SLOT_Z[this._swapSlot] * M);
      }
    }
  }

  /** Aim a group's +Z from point a to point b (satellite-local metres). */
  _aim(grp, a, b) {
    grp.position.set(a.x * M, a.y * M, a.z * M);
    const dir = this._tmpDir.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    grp.quaternion.setFromUnitVectors(_Z, dir);
  }

  _restoreCarts() {
    for (let i = 0; i < this._carts.length; i++) {
      const c = this._carts[i];
      c.visible = true;
      c.position.set(0, SLOT_Y * M, SLOT_Z[i] * M);
    }
  }

  /** The fuel line follows the arm: coupling -> shoulder -> elbow -> wrist -> head back -> effector coupling, all `GAS_LINE_OFFSET_M` to the side
   *  of the arm's plane except the coupling ends. Also drives the flow light (an envelope over the 2 s). No allocation. */
  _poseLine() {
    const L = this._line;
    const x = GAS_LINE_OFFSET_M;
    L[0].copy(GAS_COUPLING);
    L[1].set(x, ARM_BASE.y, ARM_BASE.z);
    L[2].set(x, this._elbowM.y, this._elbowM.z);
    L[3].set(x, this._wristM.y, this._wristM.z);
    L[4].set(x, this._wristM.y, this._wristM.z + GAS_HEAD_BACK_M);
    L[5].set(this._tip.x, this._tip.y, this._tip.z - GAS_END_IN_M);   // ends inside the head (the cap is flat and the run leans ~48 deg to the arm)
    for (let i = 0; i < 5; i++) {
      const a = L[i], b = L[i + 1];
      const seg = this._segs[i];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      seg.position.set(a.x * M, a.y * M, a.z * M);
      if (len > 1e-6) seg.quaternion.setFromUnitVectors(_Z, this._tmpV.set(dx / len, dy / len, dz / len));
      seg.scale.set(1, 1, Math.max(len, 1e-6));
    }
    for (let i = 0; i < 4; i++) this._joints[i].position.set(L[i + 1].x * M, L[i + 1].y * M, L[i + 1].z * M);

    // "gas flowing": the timer only runs while the grip is on her ring (_advance); envelope: 0.4 s up, 0.4 s down
    this._gasOn = this._state === 'mated' && this._gasT >= 0 && this._swapT < 0 && this._swapsQueued === 0;
    let p = 0;
    if (this._gasOn) {
      const t = this._gasT;
      p = t < 0.4 ? smooth(t / 0.4) : (t > GAS_S - 0.4 ? smooth((GAS_S - t) / 0.4) : 1);
    }
    // a swap starting mid-flow (the target drops to 0 at once) fades the light out over FLOW_FADE_S, and it fades back in after: never a cut
    const step = this._dt / FLOW_FADE_S;
    this._flowI += Math.min(step, Math.max(-step, p - this._flowI));
    this._lightMat.emissiveIntensity = 2.5 * this._flowI;
    this._lineMat.emissiveIntensity = 0.5 * this._flowI;
  }

  // ── near-field membership ───────────────────────────────────────────────────────────────────────────────────────────────────

  _updateNearMembership() {
    const want = this.group.visible && this._state !== 'hidden';
    const d = this.group.position.distanceTo(this.player.position) / M;
    if (!this._nearMember && want && d <= NEAR_JOIN_M) this._setNear(true);
    else if (this._nearMember && (!want || d >= NEAR_LEAVE_M)) this._setNear(false);
  }

  _setNear(on) {
    const sm = this.sceneManager;
    if (on === this._nearMember) return;
    this._nearMember = on;
    if (!sm) return;
    if (on && typeof sm.registerNearFieldRoot === 'function') sm.registerNearFieldRoot(this.group);
    else if (!on && typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(this.group);
  }

  // ── probes (tests, the coordinator's screenshot bot) ────────────────────────────────────────────────────────────────────────

  getState() { return this._state; }
  isMated() { return this._state === 'mated'; }
  isNearMember() { return this._nearMember; }
  isCarrying() { return this._swapT >= 0 && this._carrying(this._swapT); }
  isSwapping() { return this._swapT >= 0; }
  gasShowing() { return this._gasOn; }

  /** The fuel line's points, satellite-local metres, as of the last update: [bus coupling, shoulder, elbow, wrist, probe head back, effector coupling]. */
  getFuelLinePointsM() { return this._line; }
  /** Metres from her collar to the bus centre along her +Z. */
  getDistM() { return this._dist; }

  /** The end-effector point in the satellite's own frame, metres, as of the last update. */
  getEffectorLocalM(out = new THREE.Vector3()) { return out.copy(this._tip); }

  /** World position of the arm's end-effector point (scene units), as of the last update. */
  getEffectorWorldPosition(out = new THREE.Vector3()) {
    return out.set(this._tip.x * M, this._tip.y * M, this._tip.z * M).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  /** World position of cartridge `i`'s centre (scene units), as of the last update. */
  getCartridgeWorldPosition(i, out = new THREE.Vector3()) {
    return out.copy(this._carts[i].position).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  /** The cartridge the running swap carries, or -1. */
  swapSlot() { return this._swapT >= 0 ? this._swapSlot : -1; }

  dispose() {
    eventBus.off(Events.RESUPPLY_BERTH, this._onBerth);
    eventBus.off(Events.UPGRADE_PURCHASED, this._onPurchase);
    eventBus.off(Events.RESOURCE_UPGRADED, this._onGas);
    eventBus.off(Events.GAME_RESET, this._onReset);
    eventBus.off(Events.GAME_STATE_CHANGE, this._onState);
    this._setNear(false);
    if (this.scene) this.scene.remove(this.group);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
  }
}
