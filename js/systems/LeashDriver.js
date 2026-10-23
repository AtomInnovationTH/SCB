/**
 * LeashDriver.js — the leash hand-off, wired into the game (lanes l5b-wire, l5c-reach).
 *
 * LeashTransfer (the pure state machine, lane l3) decides; this driver does. Every game step it:
 *   1. reads the ship, the radiator tip, the keep-out and the autopilot into the machine's `io`,
 *   2. runs `machine.step(dt, io)`,
 *   3. carries out the commands it returns (radiator hold, nose release, ship turn, latch ...),
 *   4. pins the catch where the machine says the bag is, moves the net with it, and gives the ship
 *      the equal-and-opposite push (`reactionImpulse`), unbilled (it is momentum, not a burn).
 *
 * Frame: the machine works in metres in a world-axes frame CENTRED ON THE SHIP (the ship's drift is
 * not modelled — the hand-off is seconds to a minute of mm/s). Scene units are metres * 1e-5.
 *
 * Nose reel-in (l5c-reach E1): a catch seated deep in the bag sits 4-7 m from the ship centre, beyond the line's
 * reach. The net's winch first pulls it in to the nose (the berth seat shrinks at LEASH.NOSE_REEL_MPS, the catch
 * held by the net the whole time, phase NOSE_REEL); at seat 0 the machine starts as before.
 *
 * One hand-off at a time (one collar). The call sites are:
 *   - CaptureNetSystem._tryCargoTransfer  -> refusal(net) / canReach / start(net, debris, tipIndex, {noseReel})
 *   - main.js game loop                   -> update(dt)   (dt 0 while the world is held)
 *   - lane l6 (the picture)               -> view()
 *
 * Plain-language rule: comms lines say angles and what the ship does, never code names.
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus as defaultBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { LeashTransfer, planHandoff, minHandoffD, leashTurnLimits } from './LeashTransfer.js';
import { attitudeTurnProfile, turnGasShort } from './AutopilotSystem.js';
import { bandDegForRadius } from './TipCargo.js';
import { reseatOrbitFromScene } from '../entities/OrbitalMechanics.js';
import { DebrisField } from '../entities/DebrisField.js';

const DEG = Math.PI / 180;
const ATTITUDE_HOLD_S = 300;   // s — safety cap for the autopilot's attitude hold (the hand-off is ~45 s; releaseHold ends it)
const HOLD_OWNER = 'leash';    // l5c-reach E7: the autopilot's lasso / net listeners leave a hold with this owner alone
const FLOOR_EASE_S = 1.0;      // s — l5c-reach E3: the drawn size eases from the net-held floor to the real size
const OWN_TIP_RADIUS_M = 0.20; // m — l5c-reach E4: the hand-off's own tip hardware is never a snag within this of the latch

const _v = new THREE.Vector3();
const _off = { x: 0, y: 0, z: 0 };   // module scratch (the per-frame path allocates nothing)
const _vReach = new THREE.Vector3();

// ── small quaternion helpers (plain {x,y,z,w}) ──────────────────────────────
function qRotInto(q, v, out) {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}
const qRot = (q, v) => qRotInto(q, v, { x: 0, y: 0, z: 0 });
function qInvRotInto(q, v, out) {
  // conjugate rotation without building the conjugate
  const x = -q.x, y = -q.y, z = -q.z;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  out.x = v.x + q.w * tx + (y * tz - z * ty);
  out.y = v.y + q.w * ty + (z * tx - x * tz);
  out.z = v.z + q.w * tz + (x * ty - y * tx);
  return out;
}
const qInvRot = (q, v) => qInvRotInto(q, v, { x: 0, y: 0, z: 0 });
const smoothstep01 = (t) => { const f = t < 0 ? 0 : t > 1 ? 1 : t; return f * f * (3 - 2 * f); };

/**
 * Radiator angle (degrees) for a hand-off: the arriving bag's radius picks the row, the largest bag
 * already held on another tip picks the column; a radius rounds UP to the next row/column. No bag
 * held -> the table's own "none held" column (`noneDeg`): 3° up to a 0.60 m catch, 18° for 0.75 m.
 * Measured at the 2.30 m radiators (v12-big-bags 2026-10-16), then every held-bag cell re-run with the
 * catch at the nose (2026-10-18, commit 19204e83; docs/research/2026-10-leash.md "held bag" re-measure);
 * Constants.LEASH.HANDOFF_THETA_TABLE.
 * @param {number} arrivingR — metres
 * @param {number} [heldR] — metres, the largest held bag (0/undefined = none)
 * @returns {number} degrees
 */
export function handoffThetaDeg(arrivingR, heldR = 0) {
  const T = Constants.LEASH.HANDOFF_THETA_TABLE;
  const idx = (r) => {
    for (let i = 0; i < T.radiiM.length; i++) if (r <= T.radiiM[i] + 1e-9) return i;
    return T.radiiM.length - 1;
  };
  const row = idx(arrivingR);
  if (!(heldR > 0)) return T.noneDeg[row];
  return T.deg[row][idx(heldR)];
}

/** Ship-frame ring anchor (metres) for tip i: the capture ring rim on the tip's side. */
export function leashAnchorShip(tipIndex) {
  const K = Constants.LEASH;
  const az = Constants.THERMAL.FLOWER.AZIMUTHS_DEG[tipIndex] * DEG;
  const z = (Constants.OCTOPUS_V5 && Constants.OCTOPUS_V5.BERTH_COLLAR_Z_M) ?? 1.30;
  return { x: K.ANCHOR_AZ_R_M * Math.cos(az), y: K.ANCHOR_AZ_R_M * Math.sin(az), z };
}

/**
 * Plain words for a machine failure reason (the comms line). A turn the autopilot refused at once names its own
 * cause (leash-fail-rack, Decision 3): out of steering gas, busy aiming, already turning, a daughter on her tether.
 * Any other turn rejection keeps "the ship could not make the turn".
 * @param {{reason?:string}} f
 * @returns {string}
 */
export function plainReason(f) {
  const r = String((f && f.reason) || '');
  if (/^turn rejected/.test(r)) {
    if (/steering gas/i.test(r)) return 'the ship is out of steering gas';
    if (/aim in progress/i.test(r)) return 'the ship was busy aiming';
    if (/turn in progress/i.test(r)) return 'the ship was already turning';
    if (/daughter on its tether/i.test(r)) return 'a daughter is out on her tether';
    return 'the ship could not make the turn';
  }
  if (/^timeout/.test(r)) return 'it took too long';
  if (/too far/.test(r)) return 'the radiator was too far from the catch';
  if (/opposite|wrong side/.test(r)) return 'the radiator is on the far side of the ship';
  if (r === 'payout') return 'the line would not pay out';
  if (/bounce/.test(r)) return 'the catch kept bouncing off the radiator';
  if (/cannot reach/.test(r)) return 'the line could not reach the nose';
  if (/latch/.test(r)) return 'the catch would not latch on the radiator';
  return r || 'it did not work out';
}

const CUT_TEXT = 'Leash cut. The catch is drifting free; net it again.';

export class LeashDriver {
  /**
   * @param {object} deps
   * @param {object} deps.player — PlayerSatellite
   * @param {object} deps.autopilot — AutopilotSystem
   * @param {object} deps.captureNetSystem
   * @param {object} deps.debrisField
   * @param {object} [deps.armManager] — keep-out + cargo mass (default `player.armManager`)
   * @param {object} [deps.tipCargo] — default `player.tipCargo`
   * @param {object} [deps.eventBus]
   */
  constructor({ player, autopilot, captureNetSystem, debrisField, armManager = null, tipCargo = null, eventBus: bus = defaultBus } = {}) {
    this.player = player;
    this.autopilot = autopilot;
    this.cns = captureNetSystem;
    this.debrisField = debrisField;
    this._armManager = armManager;
    this._tipCargo = tipCargo;
    this.eventBus = bus;
    /** @type {null|object} the hand-off in progress */
    this._h = null;
    this._heldNow = false;   // the last update() came with dt 0 (world held)
    // E9: one view object and a few scratch values for the life of the driver; nothing is allocated per frame
    this._view = {
      tipIndex: 0, phase: 'FOLD', tipEngaged: false, lineCut: false, reelLenM: 0,
      anchorWorld: new THREE.Vector3(), tipWorld: new THREE.Vector3(), bagWorld: new THREE.Vector3(),
      debris: null, net: null,
    };
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this._hq = { x: 0, y: 0, z: 0, w: 1 };   // the tip's hinge -> ship turn (scratch, `_buildIo`)
    this._dv = new THREE.Vector3();
    this._pinV = new THREE.Vector3();
    this._sc = { x: 0, y: 0, z: 0 };
    this._sc2 = { x: 0, y: 0, z: 0 };

    this._onTurnEnd = (e) => {
      const h = this._h;
      if (!h || !h.turn || h.turn.state !== 'turning' || !e || e.mode !== 'turn') return;
      h.turn.ended = { result: e.result, reason: e.reason || '' };
    };
    this._onReset = () => this._abort('reset');
    bus.on(Events.AIM_SEQUENCE_END, this._onTurnEnd);
    bus.on(Events.GAME_RESET, this._onReset);
    bus.on(Events.GAMEOVER_CONTINUE, this._onReset);
  }

  dispose() {
    this.eventBus.off(Events.AIM_SEQUENCE_END, this._onTurnEnd);
    this.eventBus.off(Events.GAME_RESET, this._onReset);
    this.eventBus.off(Events.GAMEOVER_CONTINUE, this._onReset);
  }

  get _tc() { return this._tipCargo || this.player.tipCargo; }
  get _am() { return this._armManager || this.player.armManager; }

  /** petal-single: the azimuth that keys tip `tipIndex`'s radiator petal (`THERMAL.FLOWER.AZIMUTHS_DEG`). */
  _petalAz(tipIndex) { return Constants.THERMAL.FLOWER.AZIMUTHS_DEG[tipIndex]; }

  /** True while a hand-off is under way (the nose reel-in included). */
  isActive() { return this._h !== null; }

  /** l5c-reach E6: true from the start of the nose reel-in (or the radiator fold) to DONE / FAILED / CUT_FREE. */
  get busy() { return this._h !== null; }

  // ── asking ────────────────────────────────────────────────────────────────

  /**
   * Can a hand-off start now? Null = yes; else the reason, once per reason per catch.
   * A hand-off of this very net (its nose reel-in) is not a reason to refuse it.
   * @returns {null|{key:string, text:string}}
   */
  refusal(net) {
    const p = this.player, ap = this.autopilot;
    if (this._h && this._h.net !== net) return { key: 'busy', text: 'One catch is already on its leash. This one waits at the nose.' };
    if (this._heldNow) return { key: 'world', text: 'Time is held. The catch stays at the nose until it runs again.' };
    if (p.flowerHandoffHeld || p.flowerLaunchLocked) {
      return { key: 'radiators', text: 'The radiators are busy. The catch stays at the nose until they are free.' };
    }
    if (ap && (ap._attitudeHold || (typeof ap.isAiming === 'function' && ap.isAiming())
        || (typeof ap.isTurning === 'function' && ap.isTurning()))) {
      return { key: 'turning', text: 'The ship is already holding a heading or turning. The catch stays at the nose until it stops.' };
    }
    const am = this._am;
    if (am && typeof am.getRotationLockTier === 'function' && am.getRotationLockTier() !== 'none') {
      return { key: 'daughter', text: 'A daughter is out on her tether, so the ship cannot turn. The catch stays at the nose.' };
    }
    // launch-seq: a daughter clamped for launch reads tier 'none' (she is part of the ship), but the whole-ship turn
    // must not start under her: she would be swung round on her strut with the spring still to fire.
    const arms = am && am.arms;
    if (arms && arms.some((x) => x && x.state === Constants.ARM_STATES.LAUNCHING)) {
      return { key: 'daughter', text: 'A daughter is leaving the ship, so the ship cannot turn. The catch stays at the nose.' };
    }
    return null;
  }

  /** Say a refusal once per reason per catch (the catch is retried every 0.5 s; the line is not). */
  announceRefusal(net, why) {
    if (!net || !why) return;
    // nets-1b: 'busy' (the last catch still holds the driver) is never spoken. The catch starts by itself when the
    // 0.5 s retry finds the driver free, and "Handing the catch to radiator N" is then the one line about it.
    if (why.key === 'busy') return;
    const said = net._leashSaid || (net._leashSaid = {});
    if (said[why.key]) return;
    said[why.key] = true;
    this._say(why.text);
  }

  // ── starting ──────────────────────────────────────────────────────────────

  /** The angles this hand-off runs with, from the catch and the bags already on the tips. */
  _params(debris, tipIndex) {
    const p = this.player, tc = this._tc, FL = Constants.THERMAL.FLOWER;
    const radiusM = DebrisField.trueReachM(debris, 2);      // tip-fit: the catch as drawn (true size), not half its nominal size
    let heldR = 0;
    for (const sp of tc.spheres()) if (sp.r > heldR) heldR = sp.r;      // the largest bag already held: the table's column
    const thetaHRad = handoffThetaDeg(radiusM, heldR) * DEG;
    const homeThetaRad = Math.min(p._flowerThetaRad, FL.POSE_STOW_DEG * DEG);
    const bandDeg = bandDegForRadius(radiusM);
    const bandRad = Math.min(tc.maxRadiatorThetaRad(), (bandDeg === null ? 0 : bandDeg) * DEG);
    // the radiators stop a hair under a band (the ship's own rule), so aim for where they really stop
    const unfoldThetaRad = homeThetaRad > bandRad + 1e-9 ? bandRad - FL.SETTLE_EPS_RAD : homeThetaRad;
    return { radiusM, thetaHRad, homeThetaRad, unfoldThetaRad };
  }

  /** Ship-frame position (metres) of tip i's latch point if the radiators stood at `thetaRad`. */
  _tipBodyAt(tipIndex, thetaRad) {
    const tc = this._tc, M = Constants.SCENE_UNITS_PER_METER;
    const rec = tc._tipRec(tipIndex);
    if (!rec) return null;
    const saved = rec.hinge.rotation.y;
    rec.hinge.rotation.y = thetaRad - Math.PI / 2;      // the ship's own convention (PlayerSatellite._updateFlower)
    tc._latchHingeInto(rec, _v);
    tc._hingeToShip(rec, _v, _v);
    rec.hinge.rotation.y = saved;
    return { x: _v.x / M, y: _v.y / M, z: _v.z / M };
  }

  /**
   * Can the leash reach this catch from tip `tipIndex` once the radiators stand at the hand-off
   * angle? A catch seated deep in the bag (a lasso catch rides 2.856 m past the berth standoff, so
   * it sits ~5.4 m out; a mother-net catch 5.9-7.5 m, measured l5c-reach Step 0) is beyond the line's
   * reach (LEASH.D_MAX_M): the hand-off would fold the radiators for nothing. The planner answers,
   * on the tip's real position at that angle.
   * @param {object} debris
   * @param {number} tipIndex
   * @param {THREE.Vector3} [bagScene] — where the bag would be (scene units); default: where it is now
   */
  canReach(debris, tipIndex, bagScene = null) {
    const plan = this._handoffPlan(debris, tipIndex, bagScene);
    return !!plan && plan.ok;
  }

  /**
   * The hand-off plan (the bag's target, the turn axis in the SHIP frame, the turn angle, the payout) for tip `tipIndex`
   * once the radiators stand at the hand-off angle, for the bag at `bagScene` (scene units; default: where it is now).
   * The same call `LeashTransfer._replan` makes once the radiators have folded, on the tip's real position at that angle.
   * `canReach` reads its `ok`; the early gas check (`gasShort`) reads its angle and axis.
   * @returns {null|object} `planHandoff`'s answer, or null when there is no bag position or no such tip
   */
  _handoffPlan(debris, tipIndex, bagScene = null) {
    const K = Constants.LEASH;
    const sp = bagScene || (debris && debris._scenePosition);
    if (!sp) return null;
    const prm = this._params(debris, tipIndex);
    const tipBody = this._tipBodyAt(tipIndex, prm.thetaHRad);
    if (!tipBody) return null;
    const bagBodyNow = qInvRot(this._quat(), this._toMachine(sp));
    return planHandoff({ anchorBody: leashAnchorShip(tipIndex), tipBody, bagBodyNow, dMin: minHandoffD(prm.radiusM), dMax: K.D_MAX_M });
  }

  /**
   * l5c-reach E1: where the bag would sit once the net's winch had pulled it in to the nose (seat 0), predicted from the
   * bag position the berth hold gives there: where it is now, back along the bag axis by its seat. Null = nothing to
   * reel (already home) or no bag. A module scratch vector (valid until the next call).
   */
  _noseBagScene(net, debris) {
    const seat = net && net._catchSeatM;
    const ld = net && net.launchDirection;
    // l8-reel-collar: "the nose" is HOME now — the seat the reel-in ends at is the net's home seat (the catch on the ring),
    // not 0 (a seat of 0 would put the catch at the bag's mouth = inside the ring). 0 for a net with no home.
    const floor = (net && net._homeSeatM) || 0;
    if (!(seat > floor + 1e-9) || !ld || !debris || !debris._scenePosition) return null;
    const sp = debris._scenePosition, M = Constants.SCENE_UNITS_PER_METER;
    const back = seat - floor;
    return _vReach.set(sp.x - ld.x * back * M, sp.y - ld.y * back * M, sp.z - ld.z * back * M);
  }

  /**
   * l5c-reach E1: could the line reach this catch once the net's winch had pulled it in to the nose
   * (seat 0)? Predicted from the bag position the berth hold gives at seat 0: where it is now, back
   * along the bag axis by its seat.
   */
  canReachAtNose(net, debris, tipIndex) {
    const sp = this._noseBagScene(net, debris);
    return sp ? this.canReach(debris, tipIndex, sp) : false;
  }

  /**
   * gas-low-fail-fast D1: can the tank pay for the ONE steering-gas turn this hand-off makes? True = it cannot, so the
   * hand-off must not start (the catch goes to the daughter rack at once; the ~41 s fold-and-turn that used to end in
   * the same refusal never begins). Prices the turn with the autopilot's own helper (`attitudeTurnProfile`, the one
   * `requestAttitudeTurn` runs at TURN) from the plan the hand-off would run — the nose-reel plan when the catch must be
   * pulled in first — with the limits TURN sends. Inertia is the one she will have AT THE TURN, not the current one
   * (2026-10-23, radiators counted): the FOLD phase swings only the receiving tip's petal (`holdPetalForHandoff`, the
   * hand-off angle, `_command` 'foldRadiators') before the turn, so the turn runs with that petal at `thetaHRad` (capped
   * as the ship caps it) and the other petals at the angles they have now; `attitudeInertiaAt` prices exactly that, and
   * the early price equals the price TURN computes. (Before the radiators were counted the two were the same: measured
   * 2026-10-19, ixx 91.253 / iyy 87.766 both times, price 0.29170 units; the early plan's angle was 31° and TURN's 36°:
   * the line pays out 0.2 m first; a turn over ~12.5° costs the same, only the two ramps burn gas.) TURN's own check
   * stays as the fallback for gas spent elsewhere during the swing, and for a short turn whose plan angle moves.
   * A player that cannot say its inertia (a mock), a plan with no turn, or a turn with no authority: not short (TURN
   * still checks).
   * @param {object} net
   * @param {object} debris
   * @param {number} tipIndex
   * @param {object} [opts]
   * @param {boolean} [opts.noseReel] — the catch is pulled in to the nose first: plan from there
   * @param {object} [opts.bagScene] — u20-nose: plan from this world (scene) point instead of the catch's own place (net may be null)
   * @returns {boolean}
   */
  gasShort(net, debris, tipIndex, opts = {}) {
    const p = this.player;
    if (!p || typeof p.getAttitudeInertia !== 'function' || typeof p._coupleTauMag !== 'function') return false;
    const I = p.getAttitudeInertia();
    if (!I || !(I.ixx > 0) || !(I.iyy > 0)) return false;
    let sp = null;
    if (opts && opts.bagScene) {
      sp = opts.bagScene;           // u20-nose: no net yet (the daughter is still bringing the catch): plan from where the nose will seat it
    } else if (opts && opts.noseReel) {
      sp = this._noseBagScene(net, debris);
      if (!sp) return false;
    }
    const plan = this._handoffPlan(debris, tipIndex, sp);
    if (!plan || !plan.ok || !(plan.psiRad >= 1e-4)) return false;       // < 1e-4: TURN skips the turn, which costs nothing
    // the inertia at the turn: the receiving petal folded to the hand-off angle, the rest as they are (see above)
    let priced = p;
    if (typeof p.attitudeInertiaAt === 'function') {
      const prm = this._params(debris, tipIndex);
      const th = typeof p._flowerClampRad === 'function' ? p._flowerClampRad(prm.thetaHRad) : prm.thetaHRad;
      const It = p.attitudeInertiaAt({ petals: [{ azDeg: this._petalAz(tipIndex), thetaRad: th }] });
      if (It && It.ixx > 0 && It.iyy > 0) {
        priced = Object.create(p);
        priced.getAttitudeInertia = () => It;
      }
    }
    const prof = attitudeTurnProfile(priced, plan.axisBody, plan.psiRad, leashTurnLimits());
    return prof.ok && turnGasShort(p, prof.gasEstimate);
  }

  /**
   * Begin handing `debris` (held at the nose by `net`) to radiator tip `tipIndex`.
   * @param {object} [opts]
   * @param {boolean} [opts.noseReel] — the catch is out of the line's reach at its seat: pull it in to the
   *   nose first (E1). The net stays COLLARED; the machine starts when the seat reaches 0.
   * @returns {boolean} true = the hand-off is under way (the net is now leashed / reeling in)
   */
  start(net, debris, tipIndex, opts = {}) {
    const tc = this._tc;
    if (!net || !debris || !debris._scenePosition || !tc || this._h || this.refusal(net)) return false;
    if (!(tipIndex >= 0 && tipIndex < 4) || tc.has(tipIndex)) return false;
    const massKg = net.capturedMass || debris.mass || 0;
    const radiusM = DebrisField.trueReachM(debris, 2);      // tip-fit: the keep-out and the stow radius follow the drawn catch
    if (!tc.fits(radiusM)) return false;
    const reel = !!(opts && opts.noseReel) && (net._catchSeatM || 0) > (net._homeSeatM || 0) + 1e-9;

    const h = this._h = {
      net, debris, tipIndex, machine: null, massKg, radiusM,
      homeBody: null,
      anchorShip: leashAnchorShip(tipIndex),
      homeThetaRad: 0, thetaHRad: 0,
      elapsed: 0,
      noseReleased: false, latched: false, relatched: false, freed: false, lineCut: false,
      tookHold: false, turn: null, swingIssued: false, abort: null,
      hitCat: new Map(),
      state: null, phase: reel ? 'NOSE_REEL' : 'FOLD',
      reelDone: false, reelStartSeatM: net._catchSeatM || 0,
      // E3: the drawn size eases from the net-held floor to the real size over FLOOR_EASE_S
      easeT: 0,
      easeFull: Math.max(DebrisField.baseRenderScale(debris), typeof net._catchFloorScale === 'function' ? net._catchFloorScale(debris, 0) : 0),
      // E9: everything the per-frame path reuses
      io: null, koIgnore: [], koOpts: {}, koOwn: null, keepOut: null, tipShip: { x: 0, y: 0, z: 0 },
      bagW: { x: 0, y: 0, z: 0 }, bagKnown: false, bagOff: { x: 0, y: 0, z: 0 },
    };
    net._leashTipIndex = tipIndex;
    net._cargoS = 0;
    net._cargoDur = Constants.LEASH.EXPECTED_S;

    if (reel) {
      net._leashNoseReel = true;          // CaptureNetSystem leaves the net alone (no furnace clock, no second try)
      this._say('Pulling the catch in to the nose.');
      this._writeFloor(h, 0);
      this._refreshView(h);
      return true;
    }
    return this._beginMachine(h);
  }

  /**
   * The line goes out: build the machine on the catch where it sits NOW, take the radiators and the heading,
   * and hand the net to the driver (TRANSFERRING, leashed).
   * @returns {boolean}
   */
  _beginMachine(h) {
    const net = h.net, debris = h.debris, tc = this._tc;
    const q = this._quat();
    const bagPos = this._toMachine(debris._scenePosition);
    const prm = this._params(debris, h.tipIndex);
    h.machine = new LeashTransfer({
      tipIndex: h.tipIndex, bagMass: h.massKg, bagR: h.radiusM,
      bagPos, bagVel: { x: 0, y: 0, z: 0 },
      thetaHRad: prm.thetaHRad, homeThetaRad: prm.homeThetaRad, unfoldThetaRad: prm.unfoldThetaRad,
    });
    h.homeBody = qInvRot(q, bagPos);          // where the bag sits in the ship frame (rigid until the nose is released)
    h.homeThetaRad = prm.homeThetaRad;
    h.thetaHRad = prm.thetaHRad;
    h.phase = 'FOLD';
    h.elapsed = 0;
    h.io = this._newIo(h);
    h.keepOut = this._keepOut(h);
    h.io.keepOut = h.keepOut || undefined;

    net._leashNoseReel = false;
    net._leash = true;
    net._cargoS = 0;
    net._cargoDur = Constants.LEASH.EXPECTED_S;
    net._transitionTo(Constants.CAPTURE_NET.STATES.TRANSFERRING);

    // Keep the ship's heading still while the radiators fold: a drifting nose would carry the bag off the plan.
    if (this.autopilot && typeof this.autopilot.holdAttitude === 'function') {
      this.autopilot.holdAttitude(ATTITUDE_HOLD_S, { owner: HOLD_OWNER });
      h.tookHold = true;
    }
    this._say(`Handing the catch to radiator ${h.tipIndex + 1} on its own leash.`);
    this._refreshView(h);
    return true;
  }

  // ── per frame ─────────────────────────────────────────────────────────────

  /** @param {number} dt — game seconds; 0 while the world is held (nothing moves then) */
  update(dt) {
    this._heldNow = !(dt > 0);
    const h = this._h;
    if (!h) return;
    if (this._heldNow) {
      // time stopped: nothing moves, but the net's hold rewrote the full floor this frame — put the eased size back
      this._writeFloor(h, 0);
      return;
    }
    try {
      this._step(h, dt);
    } catch (err) {
      this._abort('error');
      throw err;
    }
  }

  /**
   * What the picture needs (lane l6): world points in SCENE units, refreshed every step. The SAME object every
   * frame. During the nose reel-in the phase is 'NOSE_REEL', there is no line (tipEngaged false, reelLenM null).
   * @returns {null|{tipIndex:number, phase:string, anchorWorld:THREE.Vector3, tipWorld:THREE.Vector3,
   *   bagWorld:THREE.Vector3, reelLenM:(number|null), tipEngaged:boolean, lineCut:boolean, debris:object, net:object}}
   */
  view() { return this._h ? this._view : null; }

  _step(h, dt) {
    if (h.phase === 'NOSE_REEL') { this._stepNoseReel(h, dt); return; }
    const p = this.player, tc = this._tc;
    const d = h.debris;
    if (!h.latched && (!d || d.alive === false)) { this._lose(h); return; }
    if (!tc.latchWorldInto(h.tipIndex, _v)) { this._abort('error'); return; }

    // mass of everything but the bag, read before the commands move the bag between ledgers
    const am = this._am;
    // (before the latch the bag is on the berthed ledger, after it on the tip ledger; both are in the cargo mass)
    // On the leash the bag is not part of the ship: rest = ship + cargo - this bag. From the step AFTER the latch
    // command (`h.latched` is set by that step's command, so the LATCHED phase's m·v kick and everything later read
    // it true) the bag has merged with the ship (perfectly inelastic): rest = ship + ALL cargo, this bag and any bag
    // already held on another tip included. The command step itself still divides by the pre-latch mass: its
    // impulse is the line's push up to contact, with the bag still on the leash.
    const cargoKg = am && typeof am.getCargoMassKg === 'function' ? am.getCargoMassKg() : h.massKg;
    const bagKg = h.latched ? 0 : h.massKg;
    // Her cargo-free mass (Nets step 3 slice 2a): `p.mass` is her live wet mass and already carries the cargo aboard,
    // which is added back here, once. Mocks without the method keep `p.mass` as before.
    const shipKg = typeof p.massExcludingCargoKg === 'function' ? p.massExcludingCargoKg() : (p.mass || 0);
    const restKg = Math.max(1, shipKg + cargoKg - bagKg);

    const io = this._buildIo(h);
    const res = h.machine.step(dt, io);
    h.elapsed += dt;
    h.phase = res.phase;
    h.state = res.state;

    const cmds = res.commands;
    for (let i = 0; i < cmds.length; i++) {
      this._command(h, cmds[i], res);
      if (h.abort) break;
    }
    h.phase = h.machine.phase;                 // a refused latch moves the machine on inside the step
    if (h.abort) {
      this._say(h.abort.text, 'warning');
      this._abort(h.abort.why);
      return;
    }
    this._applyState(h, res.state, dt, restKg);
    for (let i = 0; i < res.events.length; i++) this._event(h, res.events[i]);
    this._refreshView(h);

    if (res.phase === 'DONE' || res.phase === 'FAILED') this._finish(h, res);
  }

  // ── the nose reel-in (E1) ───────────────────────────────────────────────

  _stepNoseReel(h, dt) {
    const net = h.net, d = h.debris, K = Constants.LEASH;
    // the net left play (the berth hold tore it down: a dead target, a reset): nothing is held, nothing to undo
    if (this.cns.activeNets.indexOf(net) < 0) { this._endNoseReel(h); return; }
    if (!d || d.alive === false) { this._lose(h); return; }
    const why = this.refusal(net);
    if (why) { this._declineNoseReel(h, why); return; }

    if (h.reelDone) {
      // the catch has sat at seat 0 for a frame (the hold pinned it there): start the line if the line can reach
      if (!this.canReach(d, h.tipIndex)) { this._rackNoseReel(h); return; }
      const tcRef = this._tc;
      if (!tcRef.fits(h.radiusM) || tcRef.has(h.tipIndex)) { this._declineNoseReel(h, { key: 'tip', text: 'No radiator tip is free for the catch. It stays at the nose.' }); return; }
      this._beginMachine(h);
      return;
    }

    const seat = net._catchSeatM || 0;
    const floor = net._homeSeatM || 0;                    // l8-reel-collar: the reel-in ends at HOME, not at seat 0
    const next = Math.max(floor, seat - K.NOSE_REEL_MPS * dt);
    net._catchSeatM = next;
    h.elapsed += dt;
    net._cargoS = Math.min(h.elapsed, net._cargoDur);
    if (next <= floor + 1e-9) { net._catchSeatM = floor; h.reelDone = true; }
    this._writeFloor(h, dt);
    this._refreshView(h);
  }

  /** The nose reel-in ends with no holds taken and the net as it was: normal COLLARED. */
  _clearNoseReel(h) {
    if (h.net) h.net._leashNoseReel = false;
    this._h = null;
  }
  _endNoseReel(h) { this._clearNoseReel(h); }

  /** A refusal appeared during the reel-in (the D8 list): stop where we are, say why once, retry on the 0.5 s cadence. */
  _declineNoseReel(h, why) {
    this.announceRefusal(h.net, why);
    const net = h.net;
    this._clearNoseReel(h);
    net._cargoDeclined = true;
    net._cargoRetryS = 0;
  }

  /** At seat 0 the line still cannot reach (the prediction was off): today's rack path takes it. */
  _rackNoseReel(h) {
    const net = h.net;
    this._clearNoseReel(h);
    net._cargoDeclined = false;       // re-arm the first-tick decision: _tryLeash says 'rack' next frame (seat is 0)
  }

  /**
   * [K] during the reel-in (CaptureNetSystem.releaseDockedCatch): stop the reel cleanly, hold nothing.
   * @returns {boolean} true if a nose reel-in of `net` was stopped
   */
  cancelNoseReel(net) {
    const h = this._h;
    if (!h || h.net !== net || h.phase !== 'NOSE_REEL') return false;
    this._clearNoseReel(h);
    return true;
  }

  // ── drawn size (E3) ───────────────────────────────────────────────────────

  /**
   * The net-held floor eases down to the real size over FLOOR_EASE_S (smoothstep), timer in game seconds.
   * `updateBerthHold` rewrites the full floor every COLLARED frame, so this runs after the nets every frame
   * (also frames where time is held: the timer waits, the value is put back). A net still COLLARED is re-pinned
   * so the matrix the berth hold just wrote picks up the eased size.
   */
  _writeFloor(h, dt) {
    const d = h.debris;
    if (!d) return;
    h.easeT += dt;
    if (h.easeT >= FLOOR_EASE_S) {
      d._catchRenderMin = 0;               // at the real size: written EVERY frame, a COLLARED net's hold rewrites the full floor
    } else {
      const base = DebrisField.baseRenderScale(d);
      d._catchRenderMin = base + (h.easeFull - base) * (1 - smoothstep01(h.easeT / FLOOR_EASE_S));
    }
    if (h.net.state === Constants.CAPTURE_NET.STATES.COLLARED && d._scenePosition && this.debrisField) {
      this.debrisField.pinCapturedDebris(d, d._scenePosition);
    }
  }

  // ── machine io ────────────────────────────────────────────────────────────

  _quat() {
    const q = this.player.quaternion, o = this._q;
    o.x = q.x; o.y = q.y; o.z = q.z; o.w = q.w;
    return o;
  }

  /** Scene position -> metres in the ship-centred world-axes frame. */
  _toMachine(scene, out = null) {
    const pp = this.player.position, M = Constants.SCENE_UNITS_PER_METER;
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = (scene.x - pp.x) / M; o.y = (scene.y - pp.y) / M; o.z = (scene.z - pp.z) / M;
    return o;
  }

  /** The io object the machine reads, built once per hand-off and refilled every step (E9). */
  _newIo(h) {
    return {
      shipQuat: { x: 0, y: 0, z: 0, w: 1 },
      anchorWorld: { x: 0, y: 0, z: 0 },
      tipWorld: { x: 0, y: 0, z: 0 },
      radiatorThetaRad: 0,
      turn: { state: 'idle', progressRad: 0, reason: '' },
      swingDone: false,
      noseReleased: false,
      keepOut: undefined,
      bagWorld: undefined,
    };
  }

  _buildIo(h) {
    const p = this.player, tc = this._tc;
    const io = h.io;
    const q = this._quat();
    io.shipQuat.x = q.x; io.shipQuat.y = q.y; io.shipQuat.z = q.z; io.shipQuat.w = q.w;
    qRotInto(q, h.anchorShip, io.anchorWorld);
    tc.latchWorldInto(h.tipIndex, _v);
    this._toMachine(_v, io.tipWorld);
    qInvRotInto(q, io.tipWorld, h.tipShip);                // E4: the latch point in the ship frame (the radiators fold, it moves)
    if (h.koOwn) { h.koOwn.p.x = h.tipShip.x; h.koOwn.p.y = h.tipShip.y; h.koOwn.p.z = h.tipShip.z; }
    io.radiatorThetaRad = typeof p.petalThetaRad === 'function' ? p.petalThetaRad(this._petalAz(h.tipIndex)) : p._flowerThetaRad;
    this._turnIoInto(h, io.turn);
    io.swingDone = h.swingIssued && !tc.isSwinging(h.tipIndex);
    io.noseReleased = h.noseReleased;
    if (h.latched) {
      const name = `tipBag_${h.tipIndex}`;
      const sph = tc.spheres();
      let s = null;
      for (let i = 0; i < sph.length; i++) if (sph[i].name === name) { s = sph[i]; break; }
      // l8-reel-collar D7: DEFINED in every latched frame. The tip's bag sphere is the truth; a frame where the ledger
      // has not (yet) listed it keeps the last known position, and before any was known the bag is at the latch point
      // (it is on the tip). It was `undefined` there, and the picture drew no bag for the first ~1 s after the latch.
      // The tip's sphere drops out of the ledger when ITS COOK ENDS (the slot is freed, TipCargo.js `_cook`), whatever
      // phase the hand-off is in — in UNFOLD the boom is still turning, so a ship-frame offset would swing into the strut.
      // So the bag's offset from the latch point is kept in the tip's HINGE frame and turned back to the ship frame with
      // the hinge's turn this frame: the ghost rides the boom. Two edges (D6): if the tip is gone (no hinge turn) the
      // ghost stays where it was last; if the cook ends mid-SWING the ghost keeps the bag's last hinge-frame offset
      // (TipCargo stops swinging a freed slot, so nothing turns it further).
      const hq = tc.hingeQuatShipInto(h.tipIndex, this._hq);
      if (s) {
        qRotInto(q, s.c, h.bagW); h.bagKnown = true;
        if (hq) {
          _off.x = s.c.x - h.tipShip.x; _off.y = s.c.y - h.tipShip.y; _off.z = s.c.z - h.tipShip.z;
          qInvRotInto(hq, _off, h.bagOff);
        }
      } else if (h.bagKnown) {
        if (hq) {
          qRotInto(hq, h.bagOff, _off);
          _off.x += h.tipShip.x; _off.y += h.tipShip.y; _off.z += h.tipShip.z;
          qRotInto(q, _off, h.bagW);
        }
      } else if (h.debris && h.debris._scenePosition) {
        // l8-reel-collar F4: before the ledger lists the tip's bag the LIVE catch is where it is (the latch frame), so
        // the picture's shift (live catch - bagWorld) is zero there instead of a tip-to-catch jump.
        this._toMachine(h.debris._scenePosition, h.bagW);
      } else { h.bagW.x = io.tipWorld.x; h.bagW.y = io.tipWorld.y; h.bagW.z = io.tipWorld.z; }
      io.bagWorld = h.bagW;
    } else {
      io.bagWorld = undefined;
    }
    return io;
  }

  /** The turn the machine reads: its state, the reason, and how far it got. */
  _turnIoInto(h, out) {
    const t = h.turn;
    if (!t) { out.state = 'idle'; out.progressRad = 0; out.reason = ''; return out; }
    const ap = this.autopilot;
    if (t.state === 'turning') {
      if (ap.isTurning()) {
        t.lastProgress = ap.turnProgressRad();
      } else if (t.cancelled) {
        t.state = 'idle';                         // a turn we stopped ourselves is not a refusal
      } else if (t.ended) {
        t.state = t.ended.result === 'resolved' ? 'done' : 'rejected';
        if (t.state === 'rejected' && !t.reason) t.reason = t.ended.reason || 'turn stopped';
      } else {
        t.state = 'rejected';
        t.reason = t.reason || 'turn lost';
      }
    }
    out.state = t.state; out.progressRad = t.lastProgress; out.reason = t.reason;
    return out;
  }

  /**
   * The ship's keep-out, with the catch itself (and the tip it is going to) never counted as an obstacle, and
   * the hand-off's OWN tip hardware (cone, stalk, pad of tip i within OWN_TIP_RADIUS_M of the latch) not a snag
   * either (E4). Built once per hand-off: the ignore list and the options object are reused by every query, and
   * the latch point in it is refreshed every step (`_buildIo`).
   */
  _keepOut(h) {
    const am = this._am;
    if (!am || typeof am.getKeepOut !== 'function' || !am.getKeepOut()) return null;
    const i = h.tipIndex;
    h.koOwn = {
      p: { x: 0, y: 0, z: 0 }, r: OWN_TIP_RADIUS_M,
      names: [`FlowerStrutTipCone_${i}`, `FlowerStrutTipStalk_${i}`, `FlowerStrutTipPad_${i}`],
    };
    const nose = 'nose catch', bag = `tip bag ${i}`;
    const ignore = h.koIgnore, opts = h.koOpts;
    const prep = (o) => {
      ignore.length = 0;
      if (o && o.ignore) for (let k = 0; k < o.ignore.length; k++) ignore.push(o.ignore[k]);
      ignore.push(nose, bag, h.koOwn);
      if (o) for (const key in o) if (key !== 'ignore') opts[key] = o[key];
      opts.ignore = ignore;
      return opts;
    };
    const note = (res) => {
      if (res && res.gap <= 0 && res.name) h.hitCat.set(res.name, res.cat || '');
      return res;
    };
    return {
      segment: (a, b, r, o) => note(am.getKeepOut().segment(a, b, r, prep(o))),
      sphere: (c, r, o) => note(am.getKeepOut().sphere(c, r, prep(o))),
    };
  }

  // ── commands ──────────────────────────────────────────────────────────────

  _command(h, c, res) {
    const p = this.player, tc = this._tc, ap = this.autopilot;
    switch (c.type) {
      case 'foldRadiators':
        // petal-single (Decision 2): only the receiving tip's petal swings to the hand-off angle; the rest keep the shared
        // angle. null = no such petal / launch-locked: nothing has moved yet, so give up cleanly
        if (typeof p.holdPetalForHandoff !== 'function' || p.holdPetalForHandoff(this._petalAz(h.tipIndex), c.thetaRad) === null) {
          h.abort = { why: 'radiators', text: 'The radiators would not move. The catch stays at the nose.' };
        }
        break;
      case 'unfoldRadiators':
        // the petal swings back to the shared angle (the machine waits for it within THETA_TOL_DEG of its unfold angle)
        if (typeof p.releasePetalHandoff === 'function') p.releasePetalHandoff(this._petalAz(h.tipIndex));
        break;
      case 'releaseNose':
        h.noseReleased = true;                    // the machine already booked the push (reactionImpulse)
        break;
      case 'startTurn':
        this._requestTurn(h, c);
        break;
      case 'cancelTurn':
        if (h.turn && h.turn.state === 'turning') {
          if (ap.isTurning()) h.turn.lastProgress = ap.turnProgressRad();
          h.turn.cancelled = true;
          ap.cancelAttitudeTurn('leash hand-off stopped the turn');
        }
        break;
      case 'latch':
        this._latch(h, res);
        break;
      case 'swingToBoom':
        h.swingIssued = true;
        tc.swingToBoom(h.tipIndex);
        break;
      case 'relatchNose':
        this._relatch(h);
        break;
      case 'cutLine':
        h.lineCut = true;
        break;
      case 'bagFree':
        this._free(h, res.state);
        break;
      case 'releaseHold':
        this._releaseHold(h);
        break;
      default:
        break;
    }
  }

  _requestTurn(h, c) {
    const ap = this.autopilot;
    const t = h.turn = { state: 'turning', reason: '', lastProgress: 0, ended: null, cancelled: false };
    let promise = null;
    try {
      promise = ap.requestAttitudeTurn(c.axisWorld, c.angleRad, { maxRate: c.maxRate, accel: c.accel, holdS: ATTITUDE_HOLD_S, holdOwner: HOLD_OWNER, maxWaitS: 60 });
    } catch (err) {
      t.state = 'rejected';
      t.reason = (err && err.message) || 'turn refused';
      return;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(() => {}, (err) => { if (t.state !== 'done' && err && err.message) t.reason = t.reason || err.message; });
    }
    // leash-fail-rack: the autopilot's own refusal text, read at once (its rejection handler runs later, and
    // isTurning() is true when another turn was already running: that turn is not ours to adopt, and a refused
    // request took no hold, so _releaseHold must not release someone else's).
    const refusal = typeof ap.lastAttitudeTurnRefusal === 'function' ? ap.lastAttitudeTurnRefusal() : null;
    if (refusal) {
      t.state = 'rejected';
      t.reason = refusal;
      return;
    }
    h.tookHold = true;
    if (!ap.isTurning()) {
      t.state = 'rejected';
      t.reason = t.reason || this._whyNoTurn();
    }
  }

  _whyNoTurn() {
    const am = this._am;
    if (am && typeof am.getRotationLockTier === 'function' && am.getRotationLockTier() !== 'none') {
      return 'a daughter is out on her tether';
    }
    if (am && am.arms && am.arms.some((x) => x && x.state === Constants.ARM_STATES.LAUNCHING)) return 'a daughter is leaving the ship';
    return 'the turn was refused';
  }

  /** Stow the bag on its tip and take the net out of play in this very tick. */
  _latch(h, res) {
    const tc = this._tc, d = h.debris, net = h.net;
    const dirFrom = this._lineDirFromLatch(res.state);
    const stowed = tc.stow(h.tipIndex, d, { massKg: h.massKg, radiusM: h.radiusM, fromDirWorld: dirFrom });
    if (!stowed) {
      // E8: the machine is already in LATCHED; it reels the bag home on its line (no one-frame move to the collar)
      if (h.machine.refuseLatch()) {
        this._say(`The catch would not latch on radiator ${h.tipIndex + 1}. Bringing it back to the nose.`, 'warning');
      } else {
        h.abort = { why: 'latch', text: 'The catch would not latch on the radiator. Bringing it back to the nose.' };
      }
      return;
    }
    h.latched = true;
    d._motherParked = false;
    net._cargoDelivered = true;
    net._leash = false;
    this.cns.removeNetNow(net);
    this._say(`Catch latched on radiator ${h.tipIndex + 1}.`);
    this.eventBus.emit(Events.CARGO_TRANSFER_COMPLETE, {
      debrisId: d.id, massKg: h.massKg, podIndex: net.podIndex,
      armIndex: -1, armId: null, to: { kind: 'tip', tipIndex: h.tipIndex },
    });
  }

  /** Unit vector from the latch point to the bag centre (the line the bag arrives along), world axes. */
  _lineDirFromLatch(state) {
    const tc = this._tc;
    tc.latchWorldInto(this._h.tipIndex, _v);
    const tip = this._toMachine(_v, this._sc);
    const b = state.bagPos;
    const dx = b.x - tip.x, dy = b.y - tip.y, dz = b.z - tip.z;
    const n = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return { x: dx / n, y: dy / n, z: dz / n };
  }

  /** The leash failed (or the hand-off ended early): the catch goes back under the collar's hold. */
  _relatch(h) {
    if (h.relatched || h.latched || h.freed) return;
    const net = h.net;
    h.relatched = true;
    net._leash = false;
    net._leashNoseReel = false;
    // No second leash try. With FURNACE_COOK on, never the rack either: the nose furnace takes it. With it off
    // (the shipped default) nothing at the nose takes it, so CaptureNet._tryCargoTransfer sends it to the daughter
    // rack instead (leash-fail-rack).
    net._leashFailed = true;
    net._cargoDeclined = true;
    net._cargoRetryS = 0;
    net._floorRampT = 0;           // E3: the drawn size ramps up from the real size again, no pop to the full floor
    net._transitionTo(Constants.CAPTURE_NET.STATES.COLLARED);
  }

  /** The line was cut with the bag out of reach: it drifts off with the speed it had. */
  _free(h, state) {
    if (h.freed || h.latched) return;
    h.freed = true;
    const d = h.debris, net = h.net, p = this.player;
    net._leash = false;
    net._leashNoseReel = false;
    this.cns._clearCatchPins(d);
    if (d && d._scenePosition && d.orbit) {
      const v = typeof p.getVelocity === 'function' ? p.getVelocity() : null;
      if (v) {
        const b = (state && state.bagVel) || { x: 0, y: 0, z: 0 };
        reseatOrbitFromScene(d.orbit, d._scenePosition, {
          x: v.x + b.x * 0.001, y: v.y + b.y * 0.001, z: v.z + b.z * 0.001,
        });
      }
    }
    net.isActive = false;
    this.cns.removeNetNow(net);
  }

  _releaseHold(h) {
    if (!h.tookHold) return;
    h.tookHold = false;
    if (this.autopilot && typeof this.autopilot.releaseAttitudeHold === 'function') this.autopilot.releaseAttitudeHold();
  }

  // ── state -> the world ────────────────────────────────────────────────────

  _applyState(h, st, dt, restKg) {
    const p = this.player;
    const M = Constants.SCENE_UNITS_PER_METER;

    // the equal and opposite push on the ship (momentum, not a burn: unbilled)
    const J = st.reactionImpulse;
    if (J && (J.x || J.y || J.z) && typeof p.applyCartesianImpulse === 'function') {
      p.applyCartesianImpulse(this._dv.set(J.x / restKg, J.y / restKg, J.z / restKg), 0, { noBill: true });
    }

    if (h.latched || h.relatched || h.freed) return;     // the tip / the collar / the field owns the catch now

    h.net._cargoS = Math.min(h.elapsed, Constants.LEASH.EXPECTED_S);

    // where the bag is: rigid with the ship until the nose lets go, then wherever the line puts it
    let b = st.bagPos;
    if (!h.noseReleased) b = qRotInto(this._quat(), h.homeBody, this._sc2);
    const pp = p.position;
    this._pinV.set(pp.x + b.x * M, pp.y + b.y * M, pp.z + b.z * M);

    const net = h.net, d = h.debris;
    if (typeof net._applyCatchOrientation === 'function') net._applyCatchOrientation(d, p, dt);
    d._armPinned = true;
    d._captured = true;
    d._motherParked = true;
    this._writeFloor(h, dt);                              // the eased size must be in place when the pin writes the matrix
    this.debrisField.pinCapturedDebris(d, this._pinV);

    // the net follows: apex = catch - launchDirection * seat
    const seat = (net._catchSeatM || 0) * M, ld = net.launchDirection;
    net.position.x = (this._pinV.x - ld.x * seat) / M;
    net.position.y = (this._pinV.y - ld.y * seat) / M;
    net.position.z = (this._pinV.z - ld.z * seat) / M;
  }

  // ── events -> words ───────────────────────────────────────────────────────

  _event(h, e) {
    if (e.type === 'snag') {
      const raw = String(e.part || '');
      const cat = h.hitCat.get(raw) || '';
      const am = this._am;
      let part = 'something';
      if (raw && raw !== 'tension' && raw !== 'unknown' && am && typeof am._plainPart === 'function') {
        part = am._plainPart({ cat, name: raw });
      }
      if (raw === 'tension') {
        this._say(h.latched
          ? `The catch on radiator ${h.tipIndex + 1} pulled too hard. The radiators stop where they are.`
          : 'The leash pulled too hard. Bringing the catch back to the nose.', 'warning');
      } else if (h.latched) {
        this._say(`The catch on radiator ${h.tipIndex + 1} touched ${part}. The radiators stop where they are.`, 'warning');
      } else {
        this._say(`The leash touched ${part}. Bringing the catch back to the nose.`, 'warning');
      }
    } else if (e.type === 'failed') {
      const f = e;
      if (f.reason === 'cut free') {
        this._say(CUT_TEXT, 'warning');
      } else if (f.cause !== 'snag' && f.reason !== 'snag') {
        this._say(`The hand-off did not work (${plainReason(f)}). The catch is back at the nose.`, 'warning');
      }
    }
  }

  _say(text, priority = 'info') {
    // comms-after-tutorial D6: `_keep` - where the catch went (and why a hand-off failed) is never folded into "x N queued".
    this.eventBus.emit(Events.COMMS_MESSAGE, { source: 'HOUSTON', channel: 'CMD', text, priority, _keep: true });
  }

  // ── ending ────────────────────────────────────────────────────────────────

  /** DONE or FAILED: leave nothing held and the net where its state says. */
  _finish(h) {
    const p = this.player;
    if (typeof p.isPetalHolding === 'function' && p.isPetalHolding(this._petalAz(h.tipIndex)) && typeof p.releasePetalHandoff === 'function') {
      p.releasePetalHandoff(this._petalAz(h.tipIndex));
    }
    this._releaseHold(h);
    if (!h.latched && !h.freed) this._relatch(h);
    h.net._leash = false;
    this._h = null;
  }

  /** The catch died under us (mission change): drop the net, free the holds. */
  _lose(h) {
    this._say('The catch is gone. The leash is released.', 'info');
    this._abort('lost');
    if (h.net) {
      h.net._leash = false;
      this.cns._teardownBerth(h.net);
      this.cns.removeNetNow(h.net);
    }
  }

  /**
   * Stop whatever is running and leave every hold released (game reset, an error, a lost catch).
   * The catch: back under the collar's hold if the game goes on, unpinned on a reset. An error with the
   * bag out on the line cuts it free (E8): the bag is never moved to the collar in one frame.
   */
  _abort(why) {
    const h = this._h;
    if (!h) return;
    const p = this.player, ap = this.autopilot;
    h.net._leashNoseReel = false;
    try {
      if (h.turn && h.turn.state === 'turning' && ap && typeof ap.isTurning === 'function' && ap.isTurning()) {
        h.turn.cancelled = true;
        ap.cancelAttitudeTurn('leash hand-off ended');
      }
    } catch (e) { /* the turn is already over */ }
    try {
      if (typeof p.isPetalHolding === 'function' && p.isPetalHolding(this._petalAz(h.tipIndex)) && typeof p.releasePetalHandoff === 'function') {
        p.releasePetalHandoff(this._petalAz(h.tipIndex));
      }
    } catch (e) { /* radiators already free */ }
    try { this._releaseHold(h); } catch (e) { /* hold already free */ }
    if (!h.latched && !h.freed) {
      if (why === 'reset') {
        h.net._leash = false;
        try { this.cns._clearCatchPins(h.debris); } catch (e) { /* the field is gone */ }
        try { this.cns.removeNetNow(h.net); } catch (e) { /* the system is gone */ }
      } else if (why === 'error' && h.noseReleased) {
        try { this._free(h, h.state); } catch (e) { /* the field is gone */ }
        this._say(CUT_TEXT, 'warning');
      } else {
        this._relatch(h);
      }
    }
    this._h = null;
  }

  // ── view ──────────────────────────────────────────────────────────────────

  _refreshView(h) {
    const M = Constants.SCENE_UNITS_PER_METER, p = this.player, tc = this._tc;
    const v = this._view;
    const a = qRotInto(this._quat(), h.anchorShip, this._sc);
    v.anchorWorld.set(p.position.x + a.x * M, p.position.y + a.y * M, p.position.z + a.z * M);
    tc.latchWorldInto(h.tipIndex, v.tipWorld);
    if (h.latched) {
      // l8-reel-collar D7: once latched the tip owns the bag (the debris pin stopped): it is where the tip's bag is
      // (`_buildIo` keeps h.bagW current, in the ship-centred world-axes frame), so the picture always has a bag.
      // On the very frame of the latch no io was built yet (the command ran inside this step): the bag is the live catch.
      if (h.bagKnown) v.bagWorld.set(p.position.x + h.bagW.x * M, p.position.y + h.bagW.y * M, p.position.z + h.bagW.z * M);
      else if (h.debris && h.debris._scenePosition) v.bagWorld.copy(h.debris._scenePosition);   // F4: the live catch on the latch frame
      else v.bagWorld.copy(v.tipWorld);
    } else if (h.debris && h.debris._scenePosition) {
      v.bagWorld.copy(h.debris._scenePosition);
    }
    v.tipIndex = h.tipIndex;
    v.phase = h.phase;
    if (h.phase === 'NOSE_REEL') {
      v.reelLenM = null;
      v.tipEngaged = false;
      v.lineCut = false;
    } else {
      v.reelLenM = h.state && h.state.reelLen !== undefined ? h.state.reelLen : 0;
      v.tipEngaged = !!(h.state && h.state.tipEngaged);
      v.lineCut = h.lineCut;
    }
    v.debris = h.debris;
    v.net = h.net;
  }
}
