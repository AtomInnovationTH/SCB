/** AutopilotSystem.js — Trailing-rendezvous autopilot for the mothership.
 * Four-phase state machine:
 *   RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD
 * The goal pose is P_m* = P_d − v̂_d · D_trail, V_m* = V_d, nose* = v̂_d.
 * Commands are world-frame Cartesian ΔV via `PlayerSatellite.applyCartesianImpulse`,
 * keeping orbit updates physically consistent.
 * Design rationale: archive/AUTOPILOT_ANALYSIS.md §C & §D.
 * @module systems/AutopilotSystem */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { classifyNetTarget } from './netRouting.js';
import { TimeAuthority } from './TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian, orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { findNearestLiveDebris } from './NavRecoveryAdvisor.js';
import { strutLocalDirection, bestStrutAlpha, chestStrutAlpha, launchKickPerNs } from '../entities/ArmDockBasis.js';
import { computeCoM, computeInertia, strutTipMeters, strutMidpointMeters } from './CoMCalculator.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, coldGasPoolToKg } from './ResourceSystem.js';
import { wingsHint } from './WingsHint.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { tripRefuses } from './TransferTrip.js';
import { outOfMotherNetsLine } from './resupplyWords.js';
import { wrapRefusalLine, linesCross, pairReadyLine, pairLessonWaitLine, pairLessonSkipLine, pairSavedLine, pairSameLine, PAIR_PARK_LINE } from './PieceClaim.js';
import { checkActiveSatArming } from './ActiveSatGuard.js';
import { DEG2RAD, degToRad, clamp01, clamp } from '../core/MathUtil.js';

/** 1 metre in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** Minimum ΔV (m/s) required to engage autopilot */
const ENGAGE_DV_MIN = 50;

/** ΔV (m/s) threshold for automatic disengage */
const DISENGAGE_DV_MIN = 30;

/** Autopilot comms lines in plain words (Ruling 0); the "Autopilot ..." openers stay clear of the copilot phrases (test-CopilotVoice.js). */
export const AUTOPILOT_ON_TEXT = Object.freeze({
  TARGET:   'Autopilot on: flying to your selected target.',
  DEBRIS:   'Autopilot on: flying to the nearest large piece of debris.',
  TRAWL:    'Autopilot on: flying to the debris sweep.',
  CLUSTER:  'Autopilot on: flying to the debris cluster.',
  PROGRADE: 'Autopilot on: no target, so it is following your orbit.',
});
export const AUTOPILOT_ON_FALLBACK = 'Autopilot on.';

export const AUTOPILOT_OFF_TEXT = Object.freeze({
  MANUAL:        'Autopilot off: you took over.',
  DELTAV:        'Autopilot off: the engine fuel is nearly gone.',
  TARGET_LOST:   'Autopilot off: the target is gone.',
  TARGET_CAUGHT: 'Autopilot off: catch made.',
  ARRIVED:       'Autopilot off: arrived.',
  COLLISION:     'Autopilot off: another object is about to pass close. Steer clear.',
  TRAWL:         'Autopilot off: a debris sweep has started.',
  ARROW_INPUT:   'Autopilot off: you steered with the arrow keys.',
  MANUAL_REEL:   'Autopilot off: you took over with the reel key (R).',
  TRANSFER:      'Autopilot off: burning to the next field.',
});
export const AUTOPILOT_OFF_FALLBACK = 'Autopilot off.';

export function autopilotOnText(mode) {
  return AUTOPILOT_ON_TEXT[mode] || AUTOPILOT_ON_FALLBACK;
}
export function autopilotOffText(reason) {
  return AUTOPILOT_OFF_TEXT[reason] || AUTOPILOT_OFF_FALLBACK;
}

/** The `_arrivalSaidFor` key of an engagement with no locked target (cluster / heading arrivals). */
const ARRIVAL_NO_LOCK = Symbol('arrivalNoLock');

/** The ONE arrival line after the tutorial, by what the mother can still do (DECISIONS §33 row 3): nets left, N nets it;
 * none left, a daughter takes it (D), unless the piece is over 500 kg (the N key's band, netRouting.classifyNetTarget):
 * then only a resupply restock helps. Plain words (Ruling 0). Unknown mass follows the net rule. Pure.
 * @param {number} [mass] target mass in kg
 * @param {number} [motherNetsLeft] the mother's nets now (default: a full magazine)
 * @param {object} [readiness] `ArmManager.daughterLaunchReadiness` for the piece; with nets 0 the D line waits until a
 *   daughter can launch (null = say nothing yet / a daughter is already out), or names the real blocker
 * @returns {string|null} */
export function arrivalLineText(mass, motherNetsLeft, readiness) {
  const left = Number.isFinite(motherNetsLeft) ? motherNetsLeft : Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
  if (left > 0) return 'In position. Press N to net it.';
  if (mass > 0 && classifyNetTarget(mass).band === 'whale') {
    return outOfMotherNetsLine();
  }
  if (!readiness) return 'In position. Press D to send a daughter.';
  // Nets gone: the D line only once a daughter can really launch (DECISIONS §33 row 3).
  if (readiness.going) return null;
  if (readiness.ready) return 'In position. Press D to send a daughter.';
  if (readiness.wait) return null;
  return daughterBlockerText(readiness);
}

function _blockerParts(c) {
  const parts = [];
  if (c.noFuel > 0) parts.push(`${c.noFuel} out of fuel`);
  if (c.holding > 0) parts.push(c.holding === 1 ? '1 holding a catch' : `${c.holding} holding catches`);
  if (c.heavy > 0) parts.push(`${c.heavy} too small for this piece`);
  return parts;
}

/** The one plain line naming why no daughter can go (null when `readiness` names no blocker).
 * @param {{why:(string|null), counts:{noFuel:number, holding:number, heavy:number}}} readiness
 * @returns {string|null} */
function daughterBlockerText(readiness) {
  const head = 'In position. ';
  switch (readiness.why) {
    case 'safe': return `${head}The daughters are locked in safe mode.`;
    case 'power': return `${head}Daughter power is off.`;
    case 'none': return `${head}No daughter can go: none are left.`;
    case 'fuel': return `${head}No daughter can go: all are out of fuel.`;
    case 'holding': return `${head}No daughter can go: all hold catches until the burn to the next field.`;
    case 'heavy': return `${head}No daughter can go: the piece is too heavy for them.`;
    case 'mixed': return `${head}No daughter can go: ${_blockerParts(readiness.counts).join(', ')}.`;
    default: return null;
  }
}

/** Battery (Wh) under which it counts as empty (the HUD prints 0 there: `fmtBattery`, VitalsPane). DECISIONS §27: the
 * autopilot switches off at empty and will not engage until charged. */
const BATTERY_EMPTY_WH = 0.5;

/** The owner's words for the autopilot stopping at an empty battery. */
export const AP_BATTERY_EMPTY_LINE =
  'Battery empty — autopilot off. It recharges in sunlight; press A when charged.';

/** Same event with the wings rolled up: the body cells (≈ 120 W) are below the 500 W base load, so "it recharges in
 * sunlight" would be false (as in SensorSystem._payScan). The re-posted wings chip carries the how. */
export const AP_BATTERY_EMPTY_WINGS_LINE =
  'Battery empty — autopilot off. The wings are rolled up.';

/** Has this piece been caught so that chasing it is over? True when `DebrisField.update` stopped propagating its orbit for
 * a reason other than an onboarding tease pin: `_motherParked` (the mother's hold owns the piece, mesh at the nose). Its
 * frozen orbit is a ghost the moving mother leaves behind (~77 km per real second at the 10x clock).
 * Deliberately NOT `_captured`, `_armPinned` or `_capturedByArm`: set while the orbit still propagates, when the HOLD
 * "close on the daughter" burn runs. `_onboardingPinned` is never "done" (resolved by `_targetSceneState`).
 * @param {object|null|undefined} target — a debris record
 * @returns {boolean} */
export function isChaseDone(target) {
  return !!(target && target._motherParked && !target._onboardingPinned);
}

/** Autopilot rotation rate (rad/s) — gentler than manual (0.3) */
const AP_ROT_RATE = 0.2;
/** The orbit-frame offset of a retrograde trip hold: 180° about her up (+Y) axis. */
const _Q_TRIP_RETRO = new THREE.Quaternion(0, 1, 0, 0);
const _Q_IDENTITY = new THREE.Quaternion();

/** The angle the trip's hold still has to turn her nose through. PURE: `offset` is her attitude relative to prograde
 * (the `_manualRotation` the hold eases); a climb eases it to nothing, a descent to the half turn about her up axis.
 * @param {THREE.Quaternion} offset @param {boolean} retro true = a descent
 * @returns {number} rad, 0..pi */
export function tripTurnErrorFor(offset, retro) {
  return retro ? offset.angleTo(_Q_TRIP_RETRO) : 2 * Math.acos(Math.min(1, Math.abs(offset.w)));
}

/** Real seconds the trip waits for her nose for a turn of `errRad` at `AP_ROT_RATE` (0.2 rad/s): the push counts once she
 * is within TRIP.TURN_OK_DEG of the burn attitude (`TransferTrip._pushBlocked`), bounded by TRIP.TURN_WAIT_MAX_S. A turn
 * on the tail boxes (sloth mode) is much slower and not modelled. PURE: flown by `TransferTrip`, added to a trip's days by
 * the where-next list.
 * @param {number} errRad @returns {number} real seconds, >= 0 */
export function tripTurnWaitS(errRad) {
  if (!Number.isFinite(errRad)) return 0;
  const left = errRad - degToRad(Constants.TRIP.TURN_OK_DEG);
  return left > 0 ? Math.min(Constants.TRIP.TURN_WAIT_MAX_S, left / AP_ROT_RATE) : 0;
}

/** Rotation-slew skip threshold (rad): below it the nose is already there (noise). NOT a visible dead zone: a coarse
 * value (0.01 rad) makes a slow prograde follow hop back to zero. Never an "aligned" gate (Constants ANG_TOL_DEG). */
const AP_ROT_DEADZONE = 1e-5;

/** An autopilot turn on the tail boxes is announced above this angle (2°); again only for a NEW target (`_slothNotice`). */
const SLOTH_SAY_RAD = degToRad(2);

/** Leash turn (requestAttitudeTurn): default peak body rate, 5 °/s. Slow on purpose — gas depends on peak rate and
 * inertia, never on the angle, so a slow turn is cheap and keeps a hanging bag's lag small. */
export const TURN_DEFAULT_MAX_RATE = degToRad(5);

/** Largest |body-frame nose-axis component| of a turn axis we accept (roll has ~1 % of pitch authority; estimate). */
const TURN_ROLL_MAX = 0.2;

/** The active-satellite guard asked silently (its own call emits a red alert and a Houston line when it refuses). */
const QUIET_BUS = Object.freeze({ emit() {} });

/** A tracked turn that has come to rest with this much (rad, 0.1°) or less left is over. */
const TURN_TRACK_STOP_RAD = degToRad(0.1);

/** A couple fired at ≤ this fraction folds into the dominant couple (fireRcsRotation skips billing at ≤ 0.01). */
const TURN_MIN_MAG = 0.02;

/** Body axis → RCS couple name, for the two couples with real authority (x = pitch, y = yaw). */
const TURN_COUPLES = Object.freeze([['pitch', 'x'], ['yaw', 'y']]);

// Slow eased turns run on the tail ion boxes (sloth mode) or the reaction wheels (DECISIONS §2 row 9): `src` is
// 'tailBoxes' | 'wheels'; null = cold gas at its own (fast) law. These adapters are the ONE place that tells them apart.
const isSlowSrc = (src) => src === 'tailBoxes' || src === 'wheels';
const slowPeek = (p, src, units, dt) => (src === 'wheels' ? p.wheelPeek(units, dt) : p.slothPeek(units, dt));
const slowTau = (p, src, axis) => (src === 'wheels' ? p.wheelTauMag(axis) : p.slothTauMag(axis));
const slowWarmupLeftS = (p, src) => (src === 'wheels' ? 0 : p.slothWarmupLeftS());
const slowTurnTimeS = (p, src, angleRad, nx, ny) => (src === 'wheels' ? p.wheelTurnTimeS(angleRad, nx, ny) : p.slothTurnTimeS(angleRad, nx, ny));
const srcOf = (c) => c.src || 'tailBoxes';   // a coroutine record's slow source (older records have none: the boxes)
function slowLit(p, src, axis, sign, seconds) {
  if (src === 'wheels') { if (typeof p.wheelLit === 'function') p.wheelLit(axis, sign, seconds); }
  else if (typeof p.tailBoxLit === 'function') p.tailBoxLit(axis, sign, seconds);
}

/** Shape and steering-gas price of one attitude turn: the ONE estimate (`requestAttitudeTurn`, leash early check `LeashDriver.gasShort`).
 * @param {object} player — needs getAttitudeInertia(), _coupleTauMag(axis), `_coldGasRate`
 * @param {{x:number,y:number,z:number}} nBody — UNIT turn axis in the SHIP (body) frame
 * @param {number} angleRad — signed
 * @param {object} [opts]
 * @param {number} [opts.maxRate] — rad/s peak body rate (default TURN_DEFAULT_MAX_RATE)
 * @param {number} [opts.accel] — rad/s² ramp, capped at what the couples give
 * @param {boolean} [opts.boxes] — the tail boxes' torque (sloth mode); @param {boolean} [opts.wheels] — the reaction wheels'
 * @returns {{ok:false, reason:string}
 *   | {ok:true, sign:number, A:number, a:number, wp:number, ta:number, tc:number, T:number,
 *      mag:{x:number,y:number}, dir:{x:number,y:number}, k:number, gasEstimate:number}} */
export function attitudeTurnProfile(player, nBody, angleRad, opts = {}) {
  // α = the slowest couple the turn needs (torque = I·α·n for a fixed axis). `opts.wheels`: 0.25 N·m each, peak rate
  // capped at their room in that direction (spare momentum / I); `gasEstimate` is then 0 (boxes and wheels do not bill steering gas).
  const I = player.getAttitudeInertia();
  const inertia = { x: I.ixx, y: I.iyy };
  const wheels = opts.wheels === true && typeof player.wheelTauMag === 'function';
  const tau = wheels
    ? { x: player.wheelTauMag('x'), y: player.wheelTauMag('y') }
    : opts.boxes === true
      ? { x: player.slothTauMag('x'), y: player.slothTauMag('y') }
      : { x: player._coupleTauMag('x'), y: player._coupleTauMag('y') };
  const comp = { x: Math.abs(nBody.x), y: Math.abs(nBody.y) };
  let aMax = Infinity;
  for (const k of ['x', 'y']) {
    if (comp[k] > 1e-6) aMax = Math.min(aMax, tau[k] / (inertia[k] * comp[k]));
  }
  if (!Number.isFinite(aMax) || !(aMax > 0)) return { ok: false, reason: 'no steering authority about that axis' };

  let maxRate = (Number.isFinite(opts.maxRate) && opts.maxRate > 0) ? opts.maxRate : TURN_DEFAULT_MAX_RATE;
  const rateCap = Constants.ATTITUDE?.MAX_RATE;
  if (rateCap > 0) maxRate = Math.min(maxRate, rateCap);
  if (wheels) {
    const turnSign = angleRad < 0 ? -1 : 1;
    const spare = player.wheelSpareRate(turnSign * nBody.x, turnSign * nBody.y);
    if (!(spare > 0)) return { ok: false, reason: 'the reaction wheels are full' };
    maxRate = Math.min(maxRate, spare);
  }
  const a = (Number.isFinite(opts.accel) && opts.accel > 0) ? Math.min(opts.accel, aMax) : aMax;

  // Trapezoid (triangle when the angle is shorter than maxRate²/α).
  const sign = angleRad < 0 ? -1 : 1;
  const A = Math.abs(angleRad);
  const triangle = A < (maxRate * maxRate) / a;
  const wp = triangle ? Math.sqrt(A * a) : maxRate;
  const ta = wp / a;
  const tc = triangle ? 0 : (A - wp * ta) / wp;
  const T = 2 * ta + tc;

  // Per-couple firing fraction in a ramp (x pitch, y yaw); a sliver on the minor couple folds into the dominant one.
  const mag = { x: 0, y: 0 };
  for (const k of ['x', 'y']) if (comp[k] > 1e-6) mag[k] = inertia[k] * a * comp[k] / tau[k];
  const dom = mag.x >= mag.y ? 'x' : 'y';
  const oth = dom === 'x' ? 'y' : 'x';
  if (mag[oth] > 0 && mag[oth] <= TURN_MIN_MAG) { mag[dom] += mag[oth]; mag[oth] = 0; }
  mag.x = Math.min(1, mag.x);
  mag.y = Math.min(1, mag.y);
  const dir = { x: Math.sign(sign * nBody.x) || 1, y: Math.sign(sign * nBody.y) || 1 };

  // Same unit price as PlayerSatellite.fireRcsRotation (units per full-throttle second).
  const k = (player._coldGasRate ?? 0.5) * (Constants.ATTITUDE?.RCS_ATTITUDE_N2_FACTOR ?? 0.3);
  const gasEstimate = (opts.boxes === true || wheels) ? 0 : k * (mag.x + mag.y) * 2 * ta;
  return { ok: true, sign, A, a, wp, ta, tc, T, mag, dir, k, gasEstimate, boxes: opts.boxes === true, wheels };
}

/** Can the tank pay `gasEstimate`? True = it cannot. No gas figure (a mock) is never short. The ONE comparison
 * (`requestAttitudeTurn`, the leash's early check): the estimate is both burns of a fixed profile (spin up and stop) and
 * the tank must hold it with the STOP_RESERVE margin, so the stop is always paid for: accepted whole or refused.
 * @param {object} player
 * @param {number} gasEstimate — cold-gas (pool) units, from attitudeTurnProfile
 * @returns {boolean} */
export function turnGasShort(player, gasEstimate) {
  const coldGas = player && player.resources ? player.resources.coldGas : undefined;
  return Number.isFinite(coldGas) && coldGas < gasEstimate * Constants.SLOTH.STOP_RESERVE;
}

/** While the aim direction itself turns, an aim is on target at the target's rate plus at most this much (rad/s; the brake step cap). */
const AIM_TRACK_SLACK_MAX = 0.003;

/** Seconds inside the tolerance before an aim may count as tracking (a still piece's last stretch lasts up to 1.25 s, measured). */
const AIM_TRACK_DWELL_S = 2.0;

/** A wheel aim inside the tolerance is at rest below this rate (rad/s; 0.0006°/s, under any bearing drift it could follow). */
const AIM_REST_EPS = 1e-5;

/** The strut's eased move (ArmUnit `strutEaseProfile`: speed up at `a`, coast at a peak, slow down at `a`) carried on
 * from a strut already moving at `v0` (rad/s) toward a target `dRem` rad away: the rest-start profile entered `v0 / a`
 * seconds in (it began `s0 = v0² / 2a` rad back): `d` = dRem + s0, `t0` = v0 / a. `durationS` is the time wanted from
 * here (0 / short: the quickest); the peak never drops below `v0`.
 * @returns {{v0:number, s0:number, t0:number, d:number, v:number, T:number, minS:number, remS:number}} `minS` the
 *   quickest time left from here, `remS` the time left of this profile */
function strutCarryProfile(dRem, v0, a, vMax, durationS) {
  const v00 = Math.max(0, Math.min(v0, vMax, Math.sqrt(2 * a * Math.max(0, dRem))));   // never faster than it can stop in what is left
  const s0 = v00 * v00 / (2 * a), t0 = v00 / a, d = dRem + s0;
  const vq = clamp(Math.sqrt(d * a), v00, vMax);                         // the quickest peak
  const Tq = d > 1e-9 ? d / vq + vq / a : 0;
  let v = vq, T = Tq;
  const Td = t0 + (durationS > 0 ? durationS : 0);
  if (durationS > 0 && Td > Tq + 1e-9) {                                              // a longer move than the quickest: a lower peak
    v = Math.max(v00, 0.5 * a * (Td - Math.sqrt(Math.max(0, Td * Td - 4 * d / a))));
    T = d / v + v / a;
  }
  return { v0: v00, s0, t0, d, v, T, minS: Math.max(0, Tq - t0), remS: Math.max(0, T - t0) };
}

/** Attitude hold carrying an aimed daughter launch from the aim's end to the spring: on LAUNCHING at most
 * CROSSBOW_UNDOCK_TIME + LAUNCH_HOLD_CLAMP_EXTRA_S (safety only: the spring releases it); waiting in the keep-out gate
 * (DOCKED, pending) at most LAUNCH_HOLD_GATE_MAX_S; a refused launch lets go after LAUNCH_HOLD_GRACE_S (the aim promise's
 * callback runs at the end of the frame the aim resolved in). */
const LAUNCH_HOLD_CLAMP_EXTRA_S = 1.0;
const LAUNCH_HOLD_GATE_MAX_S = 20;
const LAUNCH_HOLD_GRACE_S = 0.2;

/** How often to re-scan for nearest large debris (seconds) */
const DEBRIS_SCAN_INTERVAL = 2.0;

/** Minimum mass (kg) to qualify as "large debris" */
const LARGE_DEBRIS_MASS = 50;

/** Phase labels for the rendezvous state machine. Public API: `AutopilotSystem.getCurrentPhase()`. */
const PHASE = Object.freeze({
  OFF:             'OFF',
  RENDEZVOUS_FAR:  'RENDEZVOUS_FAR',
  MATCH_ORBIT:     'MATCH_ORBIT',
  TRAIL_ALIGN:     'TRAIL_ALIGN',
  HOLD:            'HOLD',
});

// PAIR SHOT geometry (DECISIONS §38 row 5). Pure: arrays in, arrays out. Two opposite struts at angle α fly apart by 2α
// (α <= 90 deg) or 360 - 2α; the sum of their launch lines lies on the barrel axis. The mother turns yaw and pitch only
// (no commanded roll): her barrel axis (+z) moves by the minimal arc to a new direction n, her roll stays (`psRollKept`).
// The search is over n (a cap of TURN_DEG about the barrel now) and α; one daughter's miss is the angle between her
// launch line and the bearing from her strut TIP (not the ship's centre: a piece 22 m away is 4 deg off) to her piece.
// A few thousand evaluations, so it runs in a frame.

/** Milliseconds of the pair look one frame may spend (a unit of work is 0.1-1.4 ms; the frame stops after the first unit past this) */
const PAIR_FRAME_MS = 1;

const PS_TAB_STEP = 0.5 * DEG2RAD;
const PS_TAB_N = 361;
const _psTabs = new WeakMap();

/** @private strut tip (ship frame, metres) every half degree of strut angle for one dock position, cached by the dock object */
function psTipTable(dp) {
  let t = _psTabs.get(dp);
  if (t) return t;
  t = new Float64Array(PS_TAB_N * 3);
  for (let k = 0; k < PS_TAB_N; k++) {
    const tip = strutTipMeters(dp, k * PS_TAB_STEP);
    t[3 * k] = tip.x; t[3 * k + 1] = tip.y; t[3 * k + 2] = tip.z;
  }
  _psTabs.set(dp, t);
  return t;
}

/** @private launch line (unit, body) and strut tip (body, metres) of strut `s` at angle `alpha` into `out` (6 numbers: d then tip) */
function psStrutAt(s, alpha, out) {
  const sa = Math.sin(alpha), ca = Math.cos(alpha);
  out[0] = sa * s.cosAz; out[1] = sa * s.sinAz; out[2] = -ca;
  const f = Math.min(PS_TAB_N - 1.000001, Math.max(0, alpha / PS_TAB_STEP)), k = Math.floor(f), w = f - k, tb = s.tab;
  out[3] = tb[3 * k] * (1 - w) + tb[3 * k + 3] * w;
  out[4] = tb[3 * k + 1] * (1 - w) + tb[3 * k + 4] * w;
  out[5] = tb[3 * k + 2] * (1 - w) + tb[3 * k + 5] * w;
}

/** @private angle (deg) between launch line `sd` (body, rotated by row-major `R`) and the bearing from the tip to piece `T` (world, metres) */
function psMiss(R, sd, T) {
  const dx = R[0] * sd[0] + R[1] * sd[1] + R[2] * sd[2], dy = R[3] * sd[0] + R[4] * sd[1] + R[5] * sd[2], dz = R[6] * sd[0] + R[7] * sd[1] + R[8] * sd[2];
  const tx = T[0] - (R[0] * sd[3] + R[1] * sd[4] + R[2] * sd[5]);
  const ty = T[1] - (R[3] * sd[3] + R[4] * sd[4] + R[5] * sd[5]);
  const tz = T[2] - (R[6] * sd[3] + R[7] * sd[4] + R[8] * sd[5]);
  const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  const c = (dx * tx + dy * ty + dz * tz) / l;
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) / DEG2RAD;
}

/** @private row-major rotation of the minimal arc taking unit z0 to unit n, times R0, into `out` */
function psRollKept(z0, n, R0, out) {
  const cx = z0[1] * n[2] - z0[2] * n[1], cy = z0[2] * n[0] - z0[0] * n[2], cz = z0[0] * n[1] - z0[1] * n[0];
  const dot = z0[0] * n[0] + z0[1] * n[1] + z0[2] * n[2];
  const sl = Math.sqrt(cx * cx + cy * cy + cz * cz);
  let x, y, z, c, s;
  if (sl < 1e-9) {
    if (dot > 0) { for (let i = 0; i < 9; i++) out[i] = R0[i]; return out; }
    const px = Math.abs(z0[0]) < 0.9 ? 1 : 0, py = 1 - px;                 // antipodal: a half turn about any axis normal to z0
    x = -z0[2] * py; y = z0[2] * px; z = z0[0] * py - z0[1] * px;
    const l = Math.sqrt(x * x + y * y + z * z); x /= l; y /= l; z /= l; c = -1; s = 0;
  } else {
    x = cx / sl; y = cy / sl; z = cz / sl; c = dot; s = sl;
  }
  const t = 1 - c;
  const a0 = t * x * x + c, a1 = t * x * y - s * z, a2 = t * x * z + s * y;
  const b0 = t * x * y + s * z, b1 = t * y * y + c, b2 = t * y * z - s * x;
  const c0 = t * x * z - s * y, c1 = t * y * z + s * x, c2 = t * z * z + c;
  out[0] = a0 * R0[0] + a1 * R0[3] + a2 * R0[6]; out[1] = a0 * R0[1] + a1 * R0[4] + a2 * R0[7]; out[2] = a0 * R0[2] + a1 * R0[5] + a2 * R0[8];
  out[3] = b0 * R0[0] + b1 * R0[3] + b2 * R0[6]; out[4] = b0 * R0[1] + b1 * R0[4] + b2 * R0[7]; out[5] = b0 * R0[2] + b1 * R0[5] + b2 * R0[8];
  out[6] = c0 * R0[0] + c1 * R0[3] + c2 * R0[6]; out[7] = c0 * R0[1] + c1 * R0[4] + c2 * R0[7]; out[8] = c0 * R0[2] + c1 * R0[5] + c2 * R0[8];
  return out;
}

/** @private a barrel direction on the cap about unit z0: normalise(z0 + a·u + b·v) into `out` */
function psCapDir(z0, u, v, a, b, out) {
  const x = z0[0] + a * u[0] + b * v[0], y = z0[1] + a * u[1] + b * v[1], z = z0[2] + a * u[2] + b * v[2];
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** @private row-major 9 of a THREE quaternion (body to world) */
export function pairRotationOf(q, out = new Float64Array(9)) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * w); out[2] = 2 * (x * z + y * w);
  out[3] = 2 * (x * y + z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - x * w);
  out[6] = 2 * (x * z - y * w); out[7] = 2 * (y * z + x * w); out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

/** The geometry of one pair of opposite struts, ready for `solvePairAim`.
 * @param {{azimuthDeg:number}} dpA @param {{azimuthDeg:number}} dpB the two dock positions (as `ArmManager._dockPositions`)
 * @param {number} alphaLoRad @param {number} alphaHiRad the strut angles the launch gate leaves clear for this pair */
export function pairGeometry(dpA, dpB, alphaLoRad, alphaHiRad) {
  const mk = (dp) => {
    const az = dp.azimuthDeg * DEG2RAD;
    return { cosAz: Math.cos(az), sinAz: Math.sin(az), tab: psTipTable(dp) };
  };
  return { A: mk(dpA), B: mk(dpB), lo: alphaLoRad, hi: alphaHiRad };
}

/** @private max miss of the pair at attitude R, strut angle alpha, struts (sa, sb) aimed at (Ta, Tb); writes both misses to `m` */
function psPairMiss(g, R, alpha, swap, T1, T2, sdA, sdB, m) {
  psStrutAt(g.A, alpha, sdA); psStrutAt(g.B, alpha, sdB);
  const a = psMiss(R, sdA, swap ? T2 : T1), b = psMiss(R, sdB, swap ? T1 : T2);
  m[0] = a; m[1] = b;
  return a > b ? a : b;
}

/** Pure: the attitude and the one strut angle that put both launch lines of a pair of opposite struts closest to two
 * pieces, roll kept (minimal-arc barrel turn) and the barrel turn at most `turnDeg`. A coarse grid (barrel directions
 * on the cap x strut angles near half the pieces' separation, both ways round) seeds Nelder-Mead on (barrel, α),
 * minimising the larger miss plus `opts.turnWeight` x the turn in degrees (a turn that buys no accuracy is not taken).
 * @param {object} g from `pairGeometry`
 * @param {ArrayLike<number>} R0 her attitude now, row-major 9 (body to world, `pairRotationOf`)
 * @param {number[]} T1 @param {number[]} T2 the two pieces, world, metres, from her centre of mass
 * @param {{turnDeg?:number, turnWeight?:number}} [opts]
 * @returns {{alpha:number, swap:boolean, missA:number, missB:number, miss:number, turnDeg:number, n:number[], score:number}|null}
 *   alpha rad; swap false = strut A takes T1 and B takes T2; misses in degrees; n the barrel direction (world, unit) */
export function solvePairAim(g, R0, T1, T2, opts = {}) {
  const all = solvePairAimAll(g, R0, T1, T2, opts);
  return all.length ? all[0] : null;
}

/** `solvePairAim`'s answer for each way of giving the two pieces to the two struts, best first (the caller takes the
 * first that its other checks leave standing: the two tethers must not cross).
 * @returns {Array<{alpha:number, swap:boolean, missA:number, missB:number, miss:number, turnDeg:number, n:number[], score:number}>} */
export function solvePairAimAll(g, R0, T1, T2, opts = {}) {
  const turnDeg = Math.min(80, opts.turnDeg ?? 30), turnW = opts.turnWeight ?? 0.05;
  const z0 = [R0[2], R0[5], R0[8]];
  const ref = Math.abs(z0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [z0[1] * ref[2] - z0[2] * ref[1], z0[2] * ref[0] - z0[0] * ref[2], z0[0] * ref[1] - z0[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [z0[1] * u[2] - z0[2] * u[1], z0[2] * u[0] - z0[0] * u[2], z0[0] * u[1] - z0[1] * u[0]];
  const tanMax = Math.tan(turnDeg * DEG2RAD);
  // bearing of the two pieces from the centre, for the strut angle to start from (flight angle between the daughters = psi)
  const l1 = Math.hypot(T1[0], T1[1], T1[2]) || 1, l2 = Math.hypot(T2[0], T2[1], T2[2]) || 1;
  const psi = Math.acos(clamp((T1[0] * T2[0] + T1[1] * T2[1] + T1[2] * T2[2]) / (l1 * l2), -1, 1)) / DEG2RAD;
  const sdA = new Float64Array(6), sdB = new Float64Array(6), m = [0, 0], R = new Float64Array(9), n = [0, 0, 0];
  const lo = g.lo / DEG2RAD, hi = g.hi / DEG2RAD;
  const clampA = (a) => clamp(a, g.lo, g.hi);
  // stage 1: the cap grid (rings of 6 x ring-number points), the strut angles around psi/2 and 180 - psi/2
  const caps = [[0, 0]];
  const rings = 5;
  for (let k = 1; k <= rings; k++) {
    const r = tanMax * k / rings, cnt = 6 * k;
    for (let j = 0; j < cnt; j++) caps.push([r * Math.cos(2 * Math.PI * j / cnt), r * Math.sin(2 * Math.PI * j / cnt)]);
  }
  const Rs = caps.map(([a, b]) => psRollKept(z0, psCapDir(z0, u, v, a, b, n), R0, new Float64Array(9)));
  const seeds = [];                                              // best (cap, alpha) per (swap, branch)
  for (const swap of [false, true]) {
    for (const branch of [0, 1]) {
      const centre = branch === 0 ? psi / 2 : 180 - psi / 2;
      let best = null;
      for (let a = centre - 20; a <= centre + 20.001; a += 4) {
        const al = clampA(a * DEG2RAD);
        for (let k = 0; k < Rs.length; k++) {
          const e = psPairMiss(g, Rs[k], al, swap, T1, T2, sdA, sdB, m);
          if (!best || e < best.e) best = { e, k, al, swap };
        }
      }
      if (best) seeds.push(best);
    }
  }
  // stage 2: Nelder-Mead on (cap a, cap b, alpha) from each seed; objective = larger miss + turnW x turn
  const obj = (x, swap) => {
    let a = x[0], b = x[1];
    const r = Math.hypot(a, b);
    if (r > tanMax) { a *= tanMax / r; b *= tanMax / r; }
    psCapDir(z0, u, v, a, b, n);
    psRollKept(z0, n, R0, R);
    const al = clampA(x[2]);
    const e = psPairMiss(g, R, al, swap, T1, T2, sdA, sdB, m);
    const turn = Math.acos(clamp(z0[0] * n[0] + z0[1] * n[1] + z0[2] * n[2], -1, 1)) / DEG2RAD;
    return e + turnW * turn + (r > tanMax ? 50 * (r - tanMax) : 0);
  };
  const bySwap = [null, null];
  for (const sd of seeds) {
    if (sd.e > 40) continue;                         // the coarse grid is within a few degrees of the best: nothing near 10 is left here
    const f = (x) => obj(x, sd.swap);
    let r = psNelderMead(f, [caps[sd.k][0], caps[sd.k][1], sd.al], [0.04, 0.04, 3 * DEG2RAD], 110);
    if (r.f > 3) r = psNelderMead(f, r.x, [0.02, 0.02, 1.5 * DEG2RAD], 110);     // a restart on a fresh simplex: the larger-miss objective has kinks
    const k = sd.swap ? 1 : 0;
    if (!bySwap[k] || r.f < bySwap[k].f) bySwap[k] = { f: r.f, x: r.x, swap: sd.swap };
  }
  const out = [];
  for (const res of bySwap) {
    if (!res) continue;
    let a = res.x[0], b = res.x[1];
    const rr = Math.hypot(a, b);
    if (rr > tanMax) { a *= tanMax / rr; b *= tanMax / rr; }
    psCapDir(z0, u, v, a, b, n);
    psRollKept(z0, n, R0, R);
    const alpha = clampA(res.x[2]);
    const miss = psPairMiss(g, R, alpha, res.swap, T1, T2, sdA, sdB, m);
    const turn = Math.acos(clamp(z0[0] * n[0] + z0[1] * n[1] + z0[2] * n[2], -1, 1)) / DEG2RAD;
    out.push({ alpha, swap: res.swap, missA: m[0], missB: m[1], miss, turnDeg: turn, n: [n[0], n[1], n[2]], score: miss + turnW * turn });
  }
  return out.sort((p, q) => p.score - q.score);
}

/** Her attitude when her barrel points along `n`, roll kept (row-major 9) */
export function pairAttitudeFor(R0, n) {
  return psRollKept([R0[2], R0[5], R0[8]], n, R0, new Float64Array(9));
}

/** Would the two daughters' tethers swap sides on the way? The launch ceremony's own test (`linesCross`) on the two lines
 * as they will lie: each from her tether anchor on her strut (85 % out, `_aimedAnchorShipM`) to her piece, in her frame at
 * attitude R. Opposite struts at one angle, each aimed within MISS_DEG, rarely swap; side by side (α near 180) they can. */
export function pairTethersCross(g, R, alpha, swap, T1, T2) {
  const V5 = Constants.OCTOPUS_V5, reel = V5.STRUT_LENGTH * 0.85;
  const sa = Math.sin(alpha), ca = Math.cos(alpha);
  const line = (s, T) => {
    const dx = sa * s.cosAz, dy = sa * s.sinAz, dz = -ca;
    return {
      a: [s.cosAz * V5.COLLAR_RADIUS + dx * reel, s.sinAz * V5.COLLAR_RADIUS + dy * reel, V5.COLLAR_Y + dz * reel],
      b: [R[0] * T[0] + R[3] * T[1] + R[6] * T[2], R[1] * T[0] + R[4] * T[1] + R[7] * T[2], R[2] * T[0] + R[5] * T[1] + R[8] * T[2]],
    };
  };
  return linesCross(line(g.A, swap ? T2 : T1), line(g.B, swap ? T1 : T2));
}

/** Both misses (degrees) of a pair at its attitude R and strut angle alpha, for the barrier at the spring and for the tests.
 * @returns {{missA:number, missB:number}} */
export function pairMisses(g, R, alpha, swap, T1, T2) {
  const m = [0, 0];
  psPairMiss(g, R, alpha, swap, T1, T2, new Float64Array(6), new Float64Array(6), m);
  return { missA: m[0], missB: m[1] };
}

/** The barrel direction that keeps the pair on its two pieces as they drift, strut angle and assignment kept (a few
 * Nelder-Mead steps from the last answer, roll kept from her attitude now); the aim's provider calls it a few times a
 * second.
 * @returns {{n:number[], missA:number, missB:number}} */
export function refinePairAim(g, R0, T1, T2, alpha, swap, nPrev, turnDeg = 30) {
  const z0 = [R0[2], R0[5], R0[8]];
  const ref = Math.abs(nPrev[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [nPrev[1] * ref[2] - nPrev[2] * ref[1], nPrev[2] * ref[0] - nPrev[0] * ref[2], nPrev[0] * ref[1] - nPrev[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [nPrev[1] * u[2] - nPrev[2] * u[1], nPrev[2] * u[0] - nPrev[0] * u[2], nPrev[0] * u[1] - nPrev[1] * u[0]];
  const sdA = new Float64Array(6), sdB = new Float64Array(6), m = [0, 0], R = new Float64Array(9), n = [0, 0, 0];
  const f = (x) => {
    psCapDir(nPrev, u, v, x[0], x[1], n);
    const turn = Math.acos(clamp(z0[0] * n[0] + z0[1] * n[1] + z0[2] * n[2], -1, 1)) / DEG2RAD;
    psRollKept(z0, n, R0, R);
    return psPairMiss(g, R, alpha, swap, T1, T2, sdA, sdB, m) + (turn > turnDeg ? 5 * (turn - turnDeg) : 0);
  };
  const r = psNelderMead(f, [0, 0], [0.02, 0.02], 40);
  psCapDir(nPrev, u, v, r.x[0], r.x[1], n);
  psRollKept(z0, n, R0, R);
  psPairMiss(g, R, alpha, swap, T1, T2, sdA, sdB, m);
  return { n: [n[0], n[1], n[2]], missA: m[0], missB: m[1] };
}

/** @private Nelder-Mead minimiser (no allocation beyond the simplex; `iters` caps the steps, a spread under 1e-4 ends it) */
function psNelderMead(f, x0, step, iters) {
  const dim = x0.length;
  let S = [x0.slice()];
  for (let i = 0; i < dim; i++) { const x = x0.slice(); x[i] += step[i]; S.push(x); }
  let F = S.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = F.map((_, i) => i).sort((p, q) => F[p] - F[q]);
    S = idx.map((i) => S[i]); F = idx.map((i) => F[i]);
    if (F[dim] - F[0] < 1e-4) break;
    const c = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) c[j] += S[i][j] / dim;
    const pt = (t) => c.map((val, j) => val + t * (S[dim][j] - val));
    const xr = pt(-1), fr = f(xr);
    if (fr < F[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { S[dim] = xe; F[dim] = fe; } else { S[dim] = xr; F[dim] = fr; } }
    else if (fr < F[dim - 1]) { S[dim] = xr; F[dim] = fr; }
    else {
      const xc = pt(fr < F[dim] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, F[dim])) { S[dim] = xc; F[dim] = fc; }
      else for (let i = 1; i <= dim; i++) { S[i] = S[i].map((val, j) => S[0][j] + 0.5 * (val - S[0][j])); F[i] = f(S[i]); }
    }
  }
  let b = 0;
  for (let i = 1; i <= dim; i++) if (F[i] < F[b]) b = i;
  return { x: S[b], f: F[b] };
}

export class AutopilotSystem {
  constructor() {
    /** @type {boolean} */
    this._engaged = false;

    /** @type {number} The mother's nets, cached for the arrival line (DECISIONS §33 row 3): follows
     *  NET_INVENTORY_CHANGED { source:'mother', motherNets }, reset by GAME_RESET. */
    this._motherNetsLeft = Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
    /** @type {number} The mother's magazine capacity (4 at the start; 6 / 8 / 10 after the upgrade), from the podMax
     *  on her inventory events. A new game puts this many nets back. */
    this._motherNetCap = Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;

    /** @type {string} 'OFF'|'RENDEZVOUS_FAR'|'MATCH_ORBIT'|'TRAIL_ALIGN'|'HOLD' */
    this._phase = PHASE.OFF;

    /** @type {number} Seconds in HOLD (auto-disengage at HOLD_DURATION) */
    this._holdTimer = 0;

    /** @type {number} Time the HOLD excursion has exceeded the demotion band: debounces HOLD → TRAIL_ALIGN. */
    this._holdExitDwell = 0;

    /** @type {THREE.Vector3|null} Latest computed goal position (P_m*) in scene units */
    this._goalPos = null;

    /** @type {number|null} Range to the goal pose (posErrM, metres) for the flight-mode annunciator's 1 Hz poll via
     *  fmaState(). null while disengaged or without a resolvable goal (the prograde fallback). Never emitted. */
    this._fmaRangeM = null;

    /** @type {string} 'NONE'|'TARGET'|'TRAWL'|'DEBRIS'|'PROGRADE' */
    this._headingMode = 'NONE';

    /** @type {THREE.Vector3|null} Current heading world position (legacy HUD) */
    this._headingTarget = null;

    /** @type {import('../entities/PlayerSatellite.js').PlayerSatellite|null} */
    this._player = null;
    /** @type {import('./TargetSelector.js').TargetSelector|null} */
    this._targetSelector = null;
    /** @type {import('./TrawlManager.js').TrawlManager|null} */
    this._trawlManager = null;
    /** @type {import('../entities/DebrisField.js').DebrisField|null} */
    this._debrisField = null;
    /** @type {import('../entities/ArmManager.js').ArmManager|null} */
    this._armManager = null;
    /** @type {import('./TargetAcquisition.js').TargetAcquisition|null} */
    this._targetAcquisition = null;

    this._debrisScanTimer = 0;
    /** @type {{ pos: THREE.Vector3, orbit: object, id: (number|string|null) }|null} */
    this._cachedDebrisResult = null;

    /** @type {boolean} A trawl sweep is active (blocks engage) */
    this._trawlActive = false;

    /** @type {boolean} Armed after a trawl-denied engage: the next A press aborts the sweep */
    this._trawlAbortArmed = false;

    this._debrisMapCluster = null;

    /** @type {THREE.Vector3|null} Resolved arrival point for the cluster heading (an InsertionPlanner candidate,
     *  via engageCluster(cluster, { arrivalPoint })). Lives and dies with _debrisMapCluster; null = cluster centre. */
    this._clusterArrivalPoint = null;

    /** @type {object|null} Locked target (persists through target cycling) */
    this._lockedTargetRef = null;

    /** What the arrival line was last said for (the locked target, or ARRIVAL_NO_LOCK); undefined = not yet.
     *  The line is said once per lock; engage / disengage reset it. */
    this._arrivalSaidFor = undefined;

    /** The lock the D line is waiting on (nets 0, no daughter can launch yet, but one will); undefined = not waiting. */
    this._arrivalPendingFor = undefined;
    this._arrivalPendingT = 0;

    /** @type {number|string|null} Lock id last emitted (for LOCK/UNLOCK events) */
    this._lockedEmittedId = null;

    this._tmpV1 = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpV3 = new THREE.Vector3();

    // Hot-path temps for update()/_resolveTargetState/_rotateTowardWorld, each written+consumed within one call.
    // _goalPosV/_headingTargetV are OWNED persistent vectors: never .copy() into a foreign object (engageCluster /
    // heading paths can assign foreign refs to _headingTarget).
    this._relP = new THREE.Vector3();
    this._relVv = new THREE.Vector3();
    this._noseWorld = new THREE.Vector3();
    this._goalDir = new THREE.Vector3();
    this._relVmps = new THREE.Vector3();
    this._velCtrlErr = new THREE.Vector3();
    this._dvCmd = new THREE.Vector3();
    this._goalPosV = new THREE.Vector3();
    this._headingTargetV = new THREE.Vector3();
    this._PdV = new THREE.Vector3();
    this._VdV = new THREE.Vector3();
    this._rotRadial = new THREE.Vector3();
    this._rotEye = new THREE.Vector3();
    this._rotMat = new THREE.Matrix4();
    this._rotQuat = new THREE.Quaternion();

    // Scratch outputs for `orbitToSceneCartesianInto` (used by `_resolveTargetState`).
    this._tmpAPCartPos = { x: 0, y: 0, z: 0 };
    this._tmpAPCartVel = { x: 0, y: 0, z: 0 };

    /** @type {number} Cumulative ΔV spent on station-keeping recoil compensation (m/s) */
    this._stationKeepDeltaV = 0;

    this._aimCoroutine = null;

    this._turn = null;
    /** @type {string|null} Why the last requestAttitudeTurn() call refused at once (null = it was accepted) */
    this._lastTurnRefusal = null;

    this._attitudeHold = false;
    /** The transfer trip's own prograde hold is on (attitude only; NOT the autopilot - `_engaged` stays false). */
    this._tripHold = false;
    /** The trip hold also steers to prograde (false: the trip burns as the ship points). */
    this._tripTurn = false;
    /** The trip hold steers to RETROGRADE instead (a descent): nose -Z of the orbit frame. */
    this._tripRetro = false;
    /** The trip asked for the turn, whether or not it runs now: an empty battery drops it, it returns with power. */
    this._tripTurnWanted = false;
    this._tripStatus = null;
    /** The engaged prograde follow keeps the heading in the ORBIT frame (time warp above 1; see `_holdFrameForWarp`). */
    this._apFrameHold = false;
    /** Who owns the attitude hold ('leash' = LeashDriver), or null. Other listeners may not release an owned hold. */
    this._attitudeHoldOwner = null;
    this._attitudeHoldElapsed = 0;
    /** The attitude hold from the end of an aimed daughter launch's aim to her spring, or null. */
    this._launchHold = null;
    /** The wheels turning her toward a picked daughter's shot, or null. NOT an aim (`isAiming()` stays false). */
    this._preturn = null;
    this._preturnReq = null;
    /** The piece the "turning on the wheels" line was last said for (once per piece). */
    this._preturnSaid = null;
    /** Why the last pre-turn ended (diagnostic; tests read it). */
    this._preturnEnd = null;
    /** The pair offered now (`getPairOffer()`), or null. */
    this._pairOffer = null;
    this._pairDirty = true;
    /** Seconds since the offer was last looked at; and a running clock for the aim's provider. */
    this._pairClock = 0;
    this._pairT = 0;
    /** The pair the "ready" line was last said for (once per pair); the single-shot check for the picked piece. */
    this._pairSaid = null;
    this._pairSingle = null;
    this._pairSearch = null;
    /** The Mission 2 double-shot lesson's setup under way (`_lessonBegin`), or null; `_lessonBeat` true for the beat. */
    this._lesson = null;
    this._lessonBeat = false;
    /** At the Q press, the gas of the pair and of the two singles it replaces (`_pairSavingNow`); said on DUAL_FIRE. */
    this._pairSaving = null;

    this._aimBoresightWorld = new THREE.Vector3();
    this._aimTargetDir = new THREE.Vector3();
    this._aimErrAxis = new THREE.Vector3();
    this._aimDeltaQuat = new THREE.Quaternion();
    this._aimTargetQuat = new THREE.Quaternion();
    this._aimInvQuat = new THREE.Quaternion();
    this._aimLocalDir = new THREE.Vector3();
    this._tripRel = new THREE.Quaternion();   // sloth mode: the trip turn's relative rotation (scratch)
    this._tripWaitQ = new THREE.Quaternion(); // the list's turn-wait read of her attitude (scratch)
    this._tripOmega = 0;                      // sloth mode: the trip turn's rate on the tail boxes (rad/s)
    this._tripSrc = null;                     // the source that made `_tripOmega`: 'tailBoxes' | 'wheels' (the carried rate is its to brake)
    // The choice for a slew in force ('wheels' | 'gas', null = none running), made at its start and kept to its stop
    // (`_slewSource`; cleared by `_slewStopTick`): a gas slew never hands a spinning ship to the wheels mid-slew.
    this._slewLatch = null;
    // The free slews at normal gas bill the real cold gas for the body rate they command (`_billSlewStep`).
    this._slewOmega = new THREE.Vector3();    // the body rate (rad per REAL s) the last slew step commanded
    this._slewW = new THREE.Vector3();        // scratch: this step's body rate
    this._slewDq = new THREE.Quaternion();    // scratch: this step's body-frame rotation
    this._slewQ0 = new THREE.Quaternion();    // snapshot of the slewed quaternion before the step (the slerps are in place)
    this._slewSteppedThisFrame = false;
    /** What the engaged autopilot / the trip hold has already said about its slow turn (one engagement). */
    this._slow = { said: false, kind: null, mode: null, ref: null, noPowerSaid: false };
    this._aimBm = new THREE.Vector3();     // the mother's boresight with the strut at its target angle

    this._setupListeners();
  }

  init(deps) {
    this._player = deps.player;
    this._targetSelector = deps.targetSelector;
    this._trawlManager = deps.trawlManager;
    this._debrisField = deps.debrisField;
    this._armManager = deps.armManager;
    this._targetAcquisition = deps.targetAcquisition || null;
    // The reaction-wheel tail-box unload runs only with the ship at rest: it asks whether a slow turn of ours is
    // running (our turns write her attitude directly, so her own rate reads 0 under them)
    if (this._player && typeof this._player.setSlowTurnProbe === 'function') this._player.setSlowTurnProbe(() => this._slowTurnBusy());
  }

  _slowTurnBusy() { return this._tripOmega > 0 || !!this._aimCoroutine || !!this._turn || !!this._preturn; }

  get engaged() { return this._engaged; }

  get headingMode() { return this._headingMode; }

  /** @returns {'OFF'|'RENDEZVOUS_FAR'|'MATCH_ORBIT'|'TRAIL_ALIGN'|'HOLD'} the rendezvous phase, for HUD / telemetry */
  getCurrentPhase() { return this._phase; }

  isAiming() { return !!this._aimCoroutine; }

  /** True while the wheels turn her toward a picked daughter's shot or hold her on it. Not an aim: `isAiming()` and
   * `isAttitudeHeld()` stay false, so ArmManager's launch checks (`_motherTurnBlock`) see a free mother and the launch
   * takes over from where the wheels got her.
   * @returns {boolean} */
  isPreturning() { return !!this._preturn; }

  isTurning() { return !!this._turn; }

  /** The reason the most recent requestAttitudeTurn() call refused at once ('Aim in progress', 'Turn in progress',
   * 'not enough steering gas', …), or null when accepted. Read it right after the call: the rejected promise's
   * handler runs later, and isTurning() cannot tell a refusal from a turn somebody else already had running.
   * @returns {string|null} */
  lastAttitudeTurnRefusal() { return this._lastTurnRefusal; }

  /** True while some system holds the mother's attitude steady (net reel-in, leash hand-off, a launch's hold from aim end to spring).
   * @returns {boolean} */
  isAttitudeHeld() { return !!this._attitudeHold; }

  /** True while the attitude hold is a catch's reel-in (mother-net or lasso): held, no owner (the leash owns its hold), not a launch's.
   * @returns {boolean} */
  isReelInHeld() {
    return !!(this._attitudeHold && !this._attitudeHoldOwner
      && !(this._launchHold && this._launchHoldIsOurs(this._launchHold)));
  }

  /** Signed angle (rad) the running scripted turn has turned so far about its own axis, in the request's direction; 0 if none runs.
   * @returns {number} */
  turnProgressRad() {
    const t = this._turn;
    if (!t) return 0;
    return t.track ? t.progress : t.sign * this._turnAngleAt(t, t.t);
  }

  /** The FMA snapshot, polled at <= 1 Hz by FmaStrip; a fresh object per call. `rangeM` = the goal range stored by update():
   * null while disengaged, before the first engaged update, or on the prograde fallback; `headingMode` / `targetName` are
   * null while disengaged.
   * @returns {{ engaged: boolean, aiming: boolean, phase: string,
   *   headingMode: (string|null), targetName: (string|null), rangeM: (number|null) }} */
  fmaState() {
    const engaged = !!this._engaged;
    const range = this._fmaRangeM;
    let targetName = null;
    if (engaged) {
      const c = this._headingMode === 'CLUSTER' ? this._debrisMapCluster : null;
      targetName = c ? String(c.name || c.id || 'CLUSTER') : this._getTargetLabel();
    }
    // The transfer trip's burn reads as an engaged hold with the word TRANSFER (no target, no range).
    const trip = this._tripHold && !engaged;
    return {
      engaged: engaged || trip,
      aiming: !!this._aimCoroutine,
      phase: trip ? 'TRANSFER' : this._phase,
      headingMode: engaged ? this._headingMode : null,
      targetName,
      rangeM: (engaged && typeof range === 'number' && Number.isFinite(range)) ? range : null,
      ...(trip && this._tripStatus ? { trip: { ...this._tripStatus } } : {}),
    };
  }

  /** The transfer trip's own prograde hold. ATTITUDE ONLY: turns the ship to prograde at the autopilot's turn rate and
   * keeps it there in the orbit frame at any world rate (`_tickTripHold`); no thrust, no battery, no orbit change. NOT
   * `engage()`: `_engaged` stays false and `engage()` / `engageCluster()` keep refusing the player while the trip burns.
   * `turn: false` (a daughter is still out on her line) holds nothing: the trip burns as the ship points, but the strip
   * still reads TRANSFER. An empty battery drops the turn (DECISIONS §27); it returns at TRIP.TURN_POWER_WH
   * (`tripTurnWaitsForPower`, `_tickTripPower`), so a descent waits for power instead of for ever.
   * @param {{turn?: boolean}} [opts] */
  holdPrograde(opts = {}) {
    this._tripHold = true;
    this._slothNoticeReset();                              // the hold's slow turn is said once
    this._tripTurn = opts.turn !== false;
    // `retro: true` holds her nose AGAINST her motion (a descent): eased to a half turn about her up axis, not to nothing.
    this._tripRetro = opts.retro === true;
    // `reask: true` is the field trip only (TransferTrip, playing a profile): there a dropped turn is asked for again.
    this._tripTurnWanted = this._tripTurn && opts.reask === true;
    if (this._tripTurn && this._player && !this._engaged) this._player.autopilotEngaged = true;
  }

  /** End `holdPrograde()`. The arbiter's handback folds the attitude into the player's offset (no snap). */
  releasePrograde() {
    this._dropTripTurn();
    if (this._player) this._tripLetGo(this._player);   // a rate the slow turn still carries stays with her
    this._tripHold = false;
    this._tripRetro = false;
    this._tripTurnWanted = false;
    this._tripStatus = null;
  }

  /** @param {{dir: number, toKm: number, day: number, days: number, wait?: string}|null} status null clears it;
   *   `wait: 'nose'` = the push waits for her nose to point the way she goes (the strip says so) */
  setTripStatus(status) { this._tripStatus = status || null; }

  /** How far the trip hold's turn to the burn attitude still has to go, rad (0 when it is not turning her: no hold, a
   * burn "as she points", or a scripted turn / aim / reel-in owns the nose). The trip waits for it to be small.
   * @returns {number} */
  tripTurnErrorRad() {
    const p = this._player;
    if (!this._tripHold || !this._tripTurn || this._engaged || !p || !p._manualRotation) return 0;
    if (this._turn || this._aimCoroutine || this._attitudeHold) return 0;
    return tripTurnErrorFor(p._manualRotation, this._tripRetro);
  }

  /** The turn wait a trip started NOW would fly, real seconds, for `up` (a climb: nose along her motion) and `down` (a
   * descent: against it). The hold has not started before a trip (`tripTurnErrorRad` reads 0), so the angle is taken from
   * her attitude as it stands: prograde^-1 * quaternion (as `PlayerSatellite._handAttitudeToPlayer`). Feeds
   * `WhereNextRows` (`opts.turnWaitS`).
   * @returns {{up: number, down: number}|null} null when her attitude or orbit cannot be read (no ship, a stub) */
  tripTurnWaitsS() {
    const p = this._player;
    if (!p || !p.quaternion || typeof p._progradeQuat !== 'function') return null;
    const pg = p._progradeQuat(this._tripWaitQ);
    if (!pg) return null;
    const offset = pg.invert().multiply(p.quaternion).normalize();
    return { up: tripTurnWaitS(tripTurnErrorFor(offset, false)), down: tripTurnWaitS(tripTurnErrorFor(offset, true)) };
  }

  isTripHold() { return this._tripHold; }

  /** Ruling 0 (without power she cannot hold her nose): true while the trip's turn is wanted but dropped at an empty
   * battery: the ship waits for power with no time limit (`_tickTripPower`); the trip reads it to say why a push waits.
   * @returns {boolean} */
  tripTurnWaitsForPower() { return this._tripHold && this._tripTurnWanted && !this._tripTurn && !this._engaged; }

  /** Sloth mode: true while the trip's hold turns her on the tail boxes (steering gas out) or the wheels: minutes, so the
   * trip waits with no limit instead of burning after TURN_WAIT_MAX_S. Only while the boxes CAN push (engine gas in the
   * tank, `_slothGasOk`): with none the 45 s limit applies (an unbounded wait would hang the trip). A flat battery drops the turn.
   * @returns {boolean} */
  tripTurnIsSlow() {
    const p = this._player;
    if (!(this._tripHold && this._tripTurn && !this._engaged && p && typeof p.attitudeTorqueSource === 'function')) return false;
    const src = p.attitudeTorqueSource({ spinUp: true });
    // the wheels answer a no-angle ask only with the steering gas out: their turn takes minutes too, no engine gas
    if (src === 'wheels') return true;
    return src === 'tailBoxes' && (typeof p._slothGasOk !== 'function' || p._slothGasOk());
  }

  /** @private The trip hold's power rule, once per frame: an empty battery (BATTERY_EMPTY_WH) drops the turn (DECISIONS §27:
   * the trip burns as she points); at TRIP.TURN_POWER_WH it is asked for again. A hold that never wanted a turn is not. */
  _tickTripPower() {
    if (this._tripTurn) {
      if (this._batteryEmpty()) this._dropTripTurn();
      return;
    }
    if (!this._tripTurnWanted || this._engaged || !this._player || this._batteryEmpty()) return;
    const wh = this._player.resources && this._player.resources.battery;
    if (Number.isFinite(wh) && wh >= Constants.TRIP.TURN_POWER_WH) {
      this._tripTurn = true;
      this._player.autopilotEngaged = true;
    }
  }

  _dropTripTurn() {
    const p = this._player;
    if (p && typeof p.setOrbitFrameHold === 'function') p.setOrbitFrameHold(false);
    if (this._tripTurn && p && !this._engaged) p.autopilotEngaged = false;
    this._tripTurn = false;
  }

  /** @private The hold's heading lives in the ORBIT frame: a world-frame slew at AP_ROT_RATE (0.2 rad/s real) never
   * catches up at the trip's 100x (the orbit turns ~1.1 rad per real second). The player keeps `quaternion = prograde ·
   * offset` (PlayerSatellite.setOrbitFrameHold, recomposed every frame) and this eases the offset to nothing on REAL time.
   * A held world (the drawer) does not turn it. A scripted turn, an aim or a reel-in attitude hold owns the nose while it
   * runs: this steps aside, then resumes from wherever it left the ship.
   * @param {number} dt real seconds
   * @param {number} dtWorld world seconds (0 while the world is held) */
  _tickTripHold(dt, dtWorld) {
    const p = this._player;
    if (typeof p.setOrbitFrameHold !== 'function') return;
    const drive = this._tripTurn && !this._turn && !this._aimCoroutine && !this._attitudeHold;
    p.setOrbitFrameHold(drive);
    // In sloth mode the turn's rate is a real spin: it does not vanish when the steering lets go of her (the player's
    // own rate-null brakes it on the boxes when they can), and a held world only pauses it.
    if (!drive) { this._tripLetGo(p); return; }
    // Which source turns her: tail boxes, wheels or cold gas (`_slewSource`).
    const target = this._tripRetro ? _Q_TRIP_RETRO : _Q_IDENTITY;
    const geom = this._offsetTurnGeom(p, target);
    const src = geom ? this._slewSource(p, geom.err, geom.nx, geom.ny) : this._slowGeneric(p);
    if (!(dtWorld > 0)) { if (!src) this._tripOmega = 0; return; }
    if (src) { this._slothOffsetTurn(p, dt, target, src); return; }
    this._tripOmega = 0;
    // The ease (and the retro slerp below) are real turns at AP_ROT_RATE: billed on the offset, not the orbit frame.
    const mr = p._manualRotation;
    const snap = mr && typeof mr.angleTo === 'function';
    if (snap) this._slewQ0.copy(mr);
    if (!this._tripRetro) {
      p.easeOrbitFrameOffset(AP_ROT_RATE * dt, AP_ROT_DEADZONE);
      if (snap) this._billSlewStep(p, this._slewQ0, p._manualRotation, dt);
      return;
    }
    // Retrograde: the same ease toward the half turn about her up axis: her +Z then points against her motion, +Y still away from Earth.
    const q = p._manualRotation;
    if (!q || typeof q.slerp !== 'function') return;
    const angle = q.angleTo(_Q_TRIP_RETRO);
    const maxAngle = AP_ROT_RATE * dt;
    if (!(angle > AP_ROT_DEADZONE) || !(maxAngle > 0)) return;
    q.slerp(_Q_TRIP_RETRO, Math.min(maxAngle, angle) / angle).normalize();
    this._billSlewStep(p, this._slewQ0, q, dt);
  }

  /** @private The selector picks the tail boxes (steering gas out, sloth mode): every turn is then theirs, a carried rate a real spin. */
  _slothOn(p) {
    return typeof p.attitudeTorqueSource === 'function' && p.attitudeTorqueSource({ spinUp: true }) === 'tailBoxes';
  }

  /** @private The slow source of a NO-ANGLE ask: 'tailBoxes' | 'wheels' with the steering gas out, null with gas (the
   * selector cannot promise wheels without the angle). For callers without geometry (mocks); `_slewSource` otherwise. */
  _slowGeneric(p) {
    if (typeof p.attitudeTorqueSource !== 'function') return null;
    const src = p.attitudeTorqueSource({ spinUp: true, carrying: this._wheelRateCarried() });
    return isSlowSrc(src) ? src : null;
  }

  /** @private The rate the slow law carries (`_tripOmega`) was made by the wheels: a full wheel does not hand her to the boxes mid-turn. */
  _wheelRateCarried() { return this._tripOmega > 0 && this._tripSrc === 'wheels'; }

  /** @private Which source runs ONE autopilot slew of `err` rad about the body axis (nx, ny): 'tailBoxes' | 'wheels' (the
   * eased slow laws) or null (cold gas at AP_ROT_RATE, billed by `_billSlewStep`). The selector decides (gas out: the
   * wheels, or the boxes when they are full; gas: the wheels if they can finish within AIM_TIMEOUT_S, else the gas) and the
   * choice is LATCHED until the slew stops (`_slewStopTick`); gas gone mid-slew (sloth mode) overrides the latch.
   * @returns {'tailBoxes'|'wheels'|null} */
  _slewSource(p, err, nx, ny) {
    if (typeof p.attitudeTorqueSource !== 'function') return null;
    const sloth = typeof p.isSlothMode === 'function' ? p.isSlothMode() : this._slowGeneric(p) !== null;
    if (!(err > AP_ROT_DEADZONE)) {
      // nothing left to turn: the arrival still brakes a rate the slow law carries (billed on its source); gas has none
      if (sloth) return this._slowGeneric(p);
      return this._tripOmega > 0 && isSlowSrc(this._tripSrc) ? this._tripSrc : null;
    }
    // Steering gas out: "the wheels are full" counts only for a ship at rest (`carrying`): a wheel-made rate stays on the wheels to its stop.
    const sel = p.attitudeTorqueSource({ spinUp: true, angleRad: err, nx, ny, limitS: Constants.AIM.AIM_TIMEOUT_S, carrying: this._wheelRateCarried() });
    if (sloth) { this._slewLatch = null; return isSlowSrc(sel) ? sel : null; }
    const latch = this._slewLatch;
    if (latch === 'gas') return null;                              // a gas slew runs to its stop on gas
    if (latch === 'wheels') {
      const usable = typeof p.wheelsUsable === 'function' && p.wheelsUsable();
      // A wheel slew whose wheels have just filled still goes on: the rate may not climb (`wheelSpareRate` is 0) but she
      // coasts and the wheels brake her (that is what un-fills them). Only a ship at rest with full wheels is the gas's.
      const full = typeof p.wheelsFull === 'function' && p.wheelsFull(nx, ny) && !(this._tripOmega > 0);
      if (usable && !full) return 'wheels';
      this._slewLatch = 'gas';                                      // the wheels cannot go on (no power, full at rest): the gas takes it
      return null;
    }
    this._slewLatch = sel === 'wheels' ? 'wheels' : 'gas';
    return sel === 'wheels' ? 'wheels' : null;
  }

  /** @private The orbit-frame offset's turn to `target` as the slow laws see it: angle and body axis (q⁻¹·target; w < 0 = the
   * long way round, slerp goes the short way so the axis is flipped). null for a mock without quaternion maths.
   * @returns {{err:number, nx:number, ny:number}|null} */
  _offsetTurnGeom(p, target) {
    const q = p._manualRotation;
    if (!q || typeof q.slerp !== 'function') return null;
    const err = q.angleTo(target);
    const rel = this._tripRel.copy(q).invert().multiply(target);
    const sw = Math.sqrt(Math.max(0, 1 - rel.w * rel.w));
    const flip = rel.w < 0 ? -1 : 1;
    return { err, nx: sw > 1e-9 ? flip * rel.x / sw : 1, ny: sw > 1e-9 ? flip * rel.y / sw : 0 };
  }

  /** @private The nose's turn to a WORLD direction as the slow laws see it: the minimal arc's angle and its body axis.
   * The gas path measures the whole quaternion (roll too); the slow ones do not turn roll.
   * @returns {{err:number, nx:number, ny:number, nose:THREE.Vector3, T:THREE.Vector3}} */
  _worldTurnGeom(p, worldDir) {
    const q = p.quaternion;
    const nose = this._aimBm.set(0, 0, 1).applyQuaternion(q).normalize();
    const T = this._aimTargetDir.set(worldDir.x, worldDir.y, worldDir.z).normalize();
    const err = Math.acos(Math.max(-1, Math.min(1, nose.dot(T))));
    let nx = 1, ny = 0;
    const ax = this._aimErrAxis.crossVectors(nose, T);
    if (ax.lengthSq() > 1e-12) { ax.applyQuaternion(this._aimInvQuat.copy(q).invert()).normalize(); nx = ax.x; ny = ax.y; }
    return { err, nx, ny, nose, T };
  }

  /** @private The trip hold's drive stopped this frame. A rate the slow turn carried (`_tripOmega`, about `_tripAxis` in the
   * body frame) is her real spin: with nobody else holding the nose it goes to the player (`adoptBodySpin`), whose rate-null
   * brakes it on the boxes when they have power and gas (else she drifts). When a scripted turn, an aim or a reel-in hold
   * owns the nose the rate goes with it (they keep her rate at 0, as in `_tickAttitudeCore`). */
  _tripLetGo(p) {
    // an aim, a scripted turn or a reel-in hold owns the nose on the boxes: the rate stays with it (`_slothCarryTick` brakes it)
    if ((this._turn || this._aimCoroutine || this._attitudeHold) && this._tripOmega > 0 && this._tripSourceOn(p)) return;
    const w = this._tripOmega || 0;
    this._tripOmega = 0;
    if (!(w > 0) || !this._tripAxis) return;
    if (this._tripTurn || this._turn || this._aimCoroutine || this._attitudeHold || this._engaged) return;
    // the spin goes to her with the name of what made it: a wheel-made one is braked by the wheels (the gas never takes it)
    if (typeof p.adoptBodySpin === 'function') p.adoptBodySpin(this._tripAxis.x * w, this._tripAxis.y * w, this._tripSrc);
  }

  /** @private The source of the carried rate (`_tripOmega`) can still brake it: the wheels while the kit is aboard, the tail boxes while picked. */
  _tripSourceOn(p) {
    if (this._tripSrc === 'wheels') return typeof p.hasWheelKit === 'function' && p.hasWheelKit();
    return this._slothOn(p);
  }

  /** @private One frame of a slow turn of the player's ORBIT-FRAME offset (`_manualRotation`) toward `target` on the tail
   * boxes (or the wheels, `src`): only a CHANGE of the offset is a turn (a constant one co-rotates with the orbit, no
   * torque), at the source's real α (`_slothEase`). The caller turns the player's orbit-frame hold on. */
  _slothOffsetTurn(p, dt, target, src = 'tailBoxes') {
    const q = p._manualRotation;
    const g = this._offsetTurnGeom(p, target);
    if (!g) return;
    const step = this._slothEase(p, dt, g.err, g.nx, g.ny, target === _Q_TRIP_RETRO ? 'retro' : 'prograde', src);
    if (step > 0) q.slerp(target, step / g.err).normalize();
  }

  /** @private One frame of a slow turn toward a WORLD direction (the engaged law's rendezvous heading) on the tail boxes or
   * the wheels (`src`): a world-frame target is held inertially (no torque); the nose goes by the minimal arc, roll is not turned.
   * @param {object} p the player @param {{x:number,y:number,z:number}} worldDir @param {number} dt real seconds
   * @param {string} [src] */
  _slothSteerWorld(p, worldDir, dt, src = 'tailBoxes') {
    const q = p.quaternion;
    const g = this._worldTurnGeom(p, worldDir);
    const step = this._slothEase(p, dt, g.err, g.nx, g.ny, 'world', src);
    if (step > 0 && g.err > 1e-9) {
      this._aimDeltaQuat.setFromUnitVectors(g.nose, g.T);
      this._aimTargetQuat.copy(this._aimDeltaQuat).multiply(q);
      q.slerp(this._aimTargetQuat, step / g.err).normalize();
    }
  }

  /** @private The eased law of the slow turn (the aim's, `_tickAimEased`): her rate about the turn axis (nx, ny) climbs at the
   * source's α and falls to 0 as the heading is reached; the player bills the lit time (boxes: power, engine gas; wheels: the
   * stored spin moves, power follows torque). No power, no engine gas, or cold cathodes (30 s): no change of rate, she coasts.
   * The wheels cap the rate by their room left in this direction (a trapezoid, `wheelSpareRate`). State: `_tripOmega`
   * (rad/s) and `_tripAxis`, shared by the trip hold and the engaged autopilot (never both at once).
   * @param {string} [src] 'tailBoxes' | 'wheels'
   * @returns {number} the angle (rad) to turn this frame (0 = none) */
  _slothEase(p, dt, err, nx, ny, kind, src = 'tailBoxes') {
    this._tripAxis = this._tripAxis || { x: 0, y: 0 };
    this._tripAxis.x = nx; this._tripAxis.y = ny;
    if (!(err > AP_ROT_DEADZONE)) {
      // arrived: the last of her rate is braked by its source (lit time billed), not dropped for free
      const w0 = this._tripOmega || 0;
      const madeBy = this._tripSrc || src;
      this._tripOmega = 0;
      if (w0 > 0) this._slothTripBrake(p, w0, nx, ny, madeBy);
      return 0;
    }
    const { aFull, mx, my } = this._slothTripAccel(p, nx, ny, src);
    if (!(aFull > 0)) return 0;
    if (err > SLOTH_SAY_RAD) this._slothNotice(p, err, nx, ny, kind, src);
    const f = slowPeek(p, src, mx + my, dt);                       // boxes: asking starts the warm-up; 0 until warm
    const a = aFull * f, dOm = a * dt;
    const was = this._tripOmega || 0;
    const want = 0.5 * (-dOm + Math.sqrt(dOm * dOm + 8 * a * err));
    const lo = Math.max(0, was - dOm);
    const up = src === 'wheels' ? Math.min(was + dOm, was + p.wheelSpareRate(nx, ny)) : was + dOm;
    const now = Math.min(Math.max(want, lo), Math.max(lo, up));
    this._tripOmega = now;
    if (now > 0 || was > 0) this._tripSrc = src;
    if (now !== was) {
      const dL = Math.abs(now - was) / aFull;                      // full-output seconds the source was lit for this change
      if (mx > 0) slowLit(p, src, 'x', nx * Math.sign(now - was) >= 0 ? 1 : -1, mx * dL);
      if (my > 0) slowLit(p, src, 'y', ny * Math.sign(now - was) >= 0 ? 1 : -1, my * dL);
    }
    // a wheel slew is a step the gas slews' stop bookkeeping must not mistake for a stop (it also keeps the latch)
    if (src === 'wheels' && (now > 0 || was > 0)) this._slewSteppedThisFrame = true;
    return Math.min(now * dt, err);
  }

  /** @private The source's angular acceleration at full output about the turn axis (nx, ny), and each axis's firing fraction. */
  _slothTripAccel(p, nx, ny, src = 'tailBoxes') {
    const I = p.getAttitudeInertia();
    const cx = Math.abs(nx), cy = Math.abs(ny);
    const tx = slowTau(p, src, 'x'), ty = slowTau(p, src, 'y');
    let aFull = Infinity;
    if (cx > 1e-6 && tx > 0) aFull = Math.min(aFull, tx / (I.ixx * cx));
    if (cy > 1e-6 && ty > 0) aFull = Math.min(aFull, ty / (I.iyy * cy));
    if (!Number.isFinite(aFull) || !(aFull > 0)) return { aFull: 0, mx: 0, my: 0 };
    const mx = tx > 0 ? Math.min(1, I.ixx * aFull * cx / tx) : 0, my = ty > 0 ? Math.min(1, I.iyy * aFull * cy / ty) : 0;
    return { aFull, mx, my };
  }

  /** @private Bill the source's lit time for braking a rate `w` (rad/s) about the turn axis (nx, ny) to rest. */
  _slothTripBrake(p, w, nx, ny, src = this._tripSrc || 'tailBoxes') {
    const { aFull, mx, my } = this._slothTripAccel(p, nx, ny, src);
    if (!(aFull > 0)) return;
    const dL = w / aFull;                                        // full-output seconds the brake takes
    if (mx > 0) slowLit(p, src, 'x', nx >= 0 ? -1 : 1, mx * dL);
    if (my > 0) slowLit(p, src, 'y', ny >= 0 ? -1 : 1, my * dL);
  }

  /** Hold the mother's orientation steady (catch reel-in): suppresses prograde auto-orient and autopilot steering. Released at reel-in end. */
  holdAttitude(timeoutS, opts) {
    const owner = (opts && opts.owner) || null;
    // An owned hold (the leash hand-off) is not taken over or re-timed by an anonymous request (lasso, net): only its owner re-asserts it.
    if (this._attitudeHold && this._attitudeHoldOwner && this._attitudeHoldOwner !== owner) return;
    this._attitudeHold = true;
    this._attitudeHoldElapsed = 0;
    this._attitudeHoldOwner = owner;
    // Optional own safety cap (scripted turn); omitted → the shared AIM_TIMEOUT_S.
    if (timeoutS != null) this._attitudeHoldTimeoutS = timeoutS;
    if (this._player) this._player.aimHold = true;
  }

  /** The net hold gets its OWN timeout: flight (≤11 s) + reel (≤25 s) + berth margin exceeds the aim coroutine's shared
   * AIM.AIM_TIMEOUT_S (30 s), which would drop the hold mid-reel and resume the prograde auto-orient with a whale on the line. */
  holdAttitudeForNet() {
    if (this._attitudeHold && this._attitudeHoldOwner) return;     // an owned hold keeps its owner and cap
    this._attitudeHold = true;
    this._attitudeHoldElapsed = 0;
    this._attitudeHoldOwner = null;
    this._attitudeHoldTimeoutS = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE
      ? (Constants.CAPTURE_NET.LARGE.MAX_FLIGHT_TIME ?? 11) : 11)
      + 25 + (Constants.CAPTURE_NET?.BERTH_SECURE_S ?? 4) + 6; // flight + reel + berth + margin
    if (this._player) this._player.aimHold = true;
  }

  /** Release the reel-in attitude hold (unless an aim seq owns it).
   * @param {{ifUnowned?: boolean}} [opts] — `ifUnowned` (the lasso / net listeners) leaves a hold that an owner took
   *   (the leash hand-off) alone; the owner and the safety cap release it for real.
   * @returns {boolean} true if the hold was released */
  releaseAttitudeHold(opts) {
    if (opts && opts.ifUnowned && this._attitudeHoldOwner) return false;
    this._attitudeHoldOwner = null;
    this._attitudeHold = false;
    this._attitudeHoldElapsed = 0;
    this._attitudeHoldTimeoutS = null;
    // A running scripted turn keeps the aim ownership (it re-asserts the hold when it ends).
    if (this._player && !this._aimCoroutine && !this._turn && !this._preturn) this._player.aimHold = false;
    return true;
  }

  /** @private The hold is a steady freeze (steering is suppressed): this only enforces the safety cap if a reel-in end event is missed. */
  _tickAttitudeHold(dt) {
    if (!this._attitudeHold) return;
    this._attitudeHoldElapsed += dt;
    const timeout = this._attitudeHoldTimeoutS ?? Constants.AIM.AIM_TIMEOUT_S;
    if (this._attitudeHoldElapsed > timeout) this.releaseAttitudeHold();
  }

  /** Keep the mother where the aim left her until the spring fires. owner 2026-10-16: "daughters seem to be released,
   * then mother turns, then crossbow fires, looks strange". The attitude owner stays AIM: no dynamics, no recentering, no
   * tether spring (the clamped daughter's tether would pull her back while the strut walks off the target). Not started when
   * somebody else holds the attitude (a net reel-in, the leash hand-off): theirs stays.
   * @param {object} arm — the daughter being launched
   * @private */
  _beginLaunchHold(arm) {
    if (!arm) return;
    const maxS = LAUNCH_HOLD_GATE_MAX_S + (Constants.CROSSBOW_UNDOCK_TIME ?? 1.5) + LAUNCH_HOLD_CLAMP_EXTRA_S + 1;
    const h = this._launchHold;
    // A second D-key launch while the first still holds: the one hold covers both, with its clock restarted so the
    // newcomer gets her whole gate wait + clamp; released only when every daughter it covers is done.
    if (h && this._launchHoldIsOurs(h)) {
      if (!h.entries.some((e) => e.arm === arm)) h.entries.push(this._launchHoldEntry(arm));
      this._attitudeHoldElapsed = 0;
      h.lastElapsed = 0;
      return;
    }
    if (this._attitudeHold) return;
    this.holdAttitude(maxS);
    this._launchHold = {
      entries: [this._launchHoldEntry(arm)], timeoutS: maxS, lastElapsed: this._attitudeHoldElapsed,
      onManual: () => this._launchHoldManualRotate(),
    };
    eventBus.on(Events.MOTHER_MANUAL_ROTATE, this._launchHold.onManual);
  }

  /** @private */
  _launchHoldEntry(arm) { return { arm, t: 0, ticks: 0, clampT: 0, clamped: false }; }

  /** @private Is the attitude hold still the one this launch hold took (nobody re-timed, took over or released it)? */
  _launchHoldIsOurs(h) {
    return !!(this._attitudeHold && !this._attitudeHoldOwner
      && this._attitudeHoldTimeoutS === h.timeoutS && this._attitudeHoldElapsed >= h.lastElapsed);
  }

  /** @private Forget the launch hold (the attitude hold itself is the caller's business). */
  _clearLaunchHold() {
    const h = this._launchHold;
    this._launchHold = null;
    if (h && h.onManual) eventBus.off(Events.MOTHER_MANUAL_ROTATE, h.onManual);
  }

  /** A rotation key press while a D-key launch still waits in the keep-out gate (before her spring is clamped) drops it
   * with the aim's cancel message and gives the ship back to the player. A daughter already in the 1.5 s clamp keeps the
   * hold until her spring.
   * @private */
  _launchHoldManualRotate() {
    const h = this._launchHold;
    if (!h || !this._launchHoldIsOurs(h)) return;
    const am = this._armManager;
    const S = Constants.ARM_STATES;
    let dropped = false;
    h.entries = h.entries.filter((e) => {
      const arm = e.arm;
      if (arm.state !== S.DOCKED) return true;                       // clamped or flying: keep
      const waiting = !!(am && am._pendingLaunches && am._pendingLaunches.has(arm.index));
      if (!waiting) return true;                                     // between the aim end and her gate: nothing to cancel yet
      if (typeof am.cancelPendingLaunch === 'function') am.cancelPendingLaunch(arm.index);
      dropped = true;
      return false;
    });
    if (dropped) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Launch aborted — Manual attitude input.', priority: 'warning', source: 'HOUSTON',
      });
    }
    if (h.entries.length === 0) {
      this._clearLaunchHold();
      this.releaseAttitudeHold({ ifUnowned: true });
    }
  }

  /** Release the launch hold when the spring has fired, the launch is refused / cancelled / over, or its safety time is
   * up; runs right after _tickAttitudeHold. A hold that changed hands (a net or the leash re-asserted it) is left alone.
   * One hold covers every daughter clamped or waiting under it: it goes when the last is done.
   * @param {number} dt
   * @private */
  _tickLaunchHold(dt) {
    const h = this._launchHold;
    if (!h) return;
    if (!this._launchHoldIsOurs(h)) {
      this._clearLaunchHold();                       // released by someone else, or taken over
      return;
    }
    h.lastElapsed = this._attitudeHoldElapsed;
    const S = Constants.ARM_STATES;
    const am = this._armManager;
    h.entries = h.entries.filter((e) => {
      const arm = e.arm;
      e.t += dt;
      e.ticks++;
      if (arm.state === S.LAUNCHING) {
        e.clamped = true;
        e.clampT += dt;
        return !arm._springFired && e.clampT <= (Constants.CROSSBOW_UNDOCK_TIME ?? 1.5) + LAUNCH_HOLD_CLAMP_EXTRA_S;
      }
      if (arm.state === S.DOCKED && !e.clamped) {
        const pending = !!(am && am._pendingLaunches && am._pendingLaunches.has(arm.index));
        // The aim promise's callback runs at the END of the frame the aim resolved in (this tick is that
        // frame's), so the first tick never judges a launch that has not had its turn — whatever the dt.
        return pending ? e.t <= LAUNCH_HOLD_GATE_MAX_S : (e.ticks <= 1 || e.t <= LAUNCH_HOLD_GRACE_S);
      }
      return false;                                  // cancelled, returned, or past the spring
    });
    if (h.entries.length === 0) {
      this._clearLaunchHold();
      this.releaseAttitudeHold({ ifUnowned: true });
    }
  }

  /** True when the player's battery is a real number below BATTERY_EMPTY_WH (a stub without one is never "empty"). @private */
  _batteryEmpty() {
    const wh = this._player?.resources?.battery;
    return Number.isFinite(wh) && wh < BATTERY_EMPTY_WH;
  }

  /** Say the autopilot is off because the battery is empty (wings variant when the wings are rolled up; it also puts the wings row up).
   * @param {object} tag — comms priority tag: `{ _critical: true }` for the automatic switch-off, `{ _reactive: true }` for a refused A press.
   * @private */
  _emitBatteryEmpty(tag) {
    const wingsUp = wingsHint.needsOpening() === true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: GestureHints.speak(wingsUp ? AP_BATTERY_EMPTY_WINGS_LINE : AP_BATTERY_EMPTY_LINE),
      priority: 'warning',
      ...tag,
    });
    if (wingsUp) wingsHint.post();
  }

  toggle() {
    if (this._engaged) {
      this.disengage('MANUAL');
    } else {
      this.engage();
    }
  }

  /** Attempt to engage: validates ΔV and trawl state, resolves (or one-tap acquires) a target; a pinned in-net-range target gets a hint instead. */
  engage() {
    // The burn to the next field is the ship's job; the player's autopilot waits until it is over.
    if (tripRefuses('autopilot')) return;
    // Empty battery (DECISIONS §27): refuse, and say so (answers the A press).
    if (this._batteryEmpty()) {
      this._emitBatteryEmpty({ _reactive: true });
      return;
    }
    // ΔV safety FIRST — before any destructive side effect: a second-press trawl abort (below) must never fire when
    // the engage would be denied anyway.
    const dv = this._getRemainingDeltaV();
    if (dv < ENGAGE_DV_MIN) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `CAUTION: AUTOPILOT DENIED. ΔV ${Math.round(dv)} m/s below ${ENGAGE_DV_MIN} m/s safety limit`,
        priority: 'warning',
      });
      return;
    }

    // The trawl-block is advisory: re-derive it from the TrawlManager's live state so a stuck `_trawlActive` flag
    // (sweep that never completed) can never wedge the autopilot.
    if (this._trawlActive && !(this._trawlManager && this._trawlManager.active)) {
      this._trawlActive = false;
    }
    if (this._trawlActive) {
      // Genuine active sweep. First A press warns; a second aborts the trawl (TRAWL_SWEEP_COMPLETE clears the flag
      // synchronously) and engages.
      if (this._trawlAbortArmed) {
        this._trawlAbortArmed = false;
        eventBus.emit(Events.TRAWL_ABORT, { reason: 'AUTOPILOT_OVERRIDE' });
        if (this._trawlActive) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'CAUTION: AUTOPILOT DENIED. Trawl sweep still active',
            priority: 'warning',
          });
          return;
        }
      } else {
        this._trawlAbortArmed = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'CAUTION: AUTOPILOT DENIED. Trawl sweep in progress. Press A again to abort the sweep and engage.',
          priority: 'warning',
        });
        return;
      }
    }
    this._trawlAbortArmed = false;

    let hasSelectedTarget = this._targetSelector && this._targetSelector.getActiveTarget();
    if (!hasSelectedTarget) {
      // One-tap re-acquire: A with no target selects the best contact and engages. Prefer the unified helper (top of the
      // Tracked Targets pane, so pane highlight and AP destination agree); its list is discovered-only, so fall back to the
      // mass-based nearest lookup when it yields null (NavRecoveryAdvisor's "press A to approach" promise). The fallback
      // takes the nearest catchable piece of ANY mass: a 50 kg preference picked a satellite ~5,000 km off over 7 pieces 100-340 m off.
      let acquired = null;
      if (this._targetAcquisition && typeof this._targetAcquisition.acquireBestTarget === 'function') {
        acquired = this._targetAcquisition.acquireBestTarget({
          source: 'autopilot_reacquire',
          maxRangeM: Constants.AUTOLOCK.RANGE_M, // a 385 km auto-pick once emptied the argon in mission 2
        });
      }
      if (acquired) {
        hasSelectedTarget = this._targetSelector.getActiveTarget();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'No target selected. Acquiring nearest contact.',
          priority: 'info',
          _keep: true,
        });
      } else {
        const nearest = this._findNearestCatchableDebris();
        if (nearest && nearest.debris && this._targetSelector &&
            typeof this._targetSelector.setTarget === 'function') {
          this._targetSelector.setTarget(nearest.debris, { source: 'autopilot_reacquire' });
          hasSelectedTarget = this._targetSelector.getActiveTarget();
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'No target selected. Acquiring nearest contact.',
            priority: 'info',
            _keep: true,
          });
        } else if (nearest) {
          // No selector API available — engage in DEBRIS heading mode directly.
          this._cachedDebrisResult = nearest;
          this._debrisScanTimer = 0;
          hasSelectedTarget = true;
        }
      }
    }
    if (!hasSelectedTarget) {
      // Refuse to engage without a selected target. The skills system listens for AUTOPILOT_NO_TARGET as a discovery
      // signal (Constants nav_autopilot_no_target).
      eventBus.emit(Events.AUTOPILOT_NO_TARGET);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: AUTOPILOT DENIED. No live contacts in the field. Zoom out to LEO for the next cluster.',
        priority: 'warning',
      });
      return;
    }

    // Refuse a pinned target. An onboarding tease pin rides the mother 22–45 m off the nose, ALREADY inside net range:
    // nothing to rendezvous with (the default AutoLock pick, and what the no-target path above acquires). The goal pose
    // reads _scenePosition (_targetSceneState), so engaging would just park her against a ~2 m goal error. `hasSelectedTarget`
    // is the selector's target object, or `true` on the no-selector-API DEBRIS fallback (the piece is
    // `_cachedDebrisResult.debris`). The hint is `_reactive` so it passes comms suppression tier 0 (onboarding mutes the
    // plain DENIED lines). No AUTOPILOT_ENGAGE is emitted: OnboardingDirector pre-satisfies its `range_wall` beat on it.
    const activeTarget = (hasSelectedTarget && typeof hasSelectedTarget === 'object')
      ? hasSelectedTarget
      : ((this._cachedDebrisResult && this._cachedDebrisResult.debris) || null);
    if (activeTarget && activeTarget._onboardingPinned) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'Target is already in net range — launch the net (N).',
        priority: 'info',
        _reactive: true,
      });
      return;
    }
    // A berthed piece has nothing left to chase: refuse up front (no AUTOPILOT_ENGAGE, no state change) rather than engage
    // for one frame and disengage TARGET_CAUGHT. The in-flight TARGET_CAUGHT disengage stays.
    if (isChaseDone(activeTarget)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'That piece is already caught. Pick another target.',
        priority: 'info',
        _reactive: true,
      });
      return;
    }

    const heading = this._determineHeading();
    if (!heading) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Autopilot has no target to fly to, so it is following your orbit.',
        priority: 'info',
        _keep: true,
      });
    }

    this._engaged = true;
    this._slothNoticeReset();                              // a new engagement says its slow turn again
    if (this._player) {
      this._player.autopilotEngaged = true;
      // No manual-offset reset on AP transitions: the arbiter owns handback continuity
      // (`_handAttitudeToPlayer` folds the attitude into the offset); a hard reset would snap.
    }
    this._headingTarget = heading ? heading.position : null;
    this._headingMode = heading ? heading.mode : 'PROGRADE';

    // Lock target reference so cycling targets doesn't change AP destination
    this._lockedTargetRef = null;
    this._arrivalSaidFor = undefined;   // a new lock: the arrival line may be said again
    this._arrivalPendingFor = undefined;
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      this._lockedTargetRef = this._targetSelector.getActiveTarget();
    }

    // Start in RENDEZVOUS_FAR; the state machine promotes on the first update tick if tighter phases already hold.
    this._setPhase(PHASE.RENDEZVOUS_FAR);
    this._holdTimer = 0;
    this._fmaRangeM = null;                                // first engaged update fills it

    // for CollisionAvoidanceSystem
    this._refreshTargetLock();

    eventBus.emit(Events.AUTOPILOT_ENGAGE, {
      mode: this._headingMode,
      targetName: this._getTargetLabel(),
      phase: this._phase,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: autopilotOnText(this._headingMode),
      priority: 'info',
      _keep: true,   // autopilot on/off is never folded into "x N queued"
    });
    // kind 'memo': goes to the MOTHER header MEMO slot.
    eventBus.emit(Events.SHOW_NOTIFICATION, { text: 'AUTOPILOT ACTIVE', kind: 'memo' });
  }

  /** Engage toward a debris cluster centre (from Field-Assay MFD). Bypasses the selected-target and trawl-active checks:
   * clusters are not individual targets.
   * @param {object} cluster — with .center { x, y, z } and .id
   * @param {object} [opts] — omitted ⇒ the cluster-centre heading (test-AutopilotSystem.js "engageCluster arrivalPoint").
   * @param {object} [opts.arrivalPoint] — an InsertionPlanner candidate ({ pos: {x,y,z}, ... }) or a bare {x,y,z}: the
   *   arrival point the heading should prefer over cluster.center. */
  engageCluster(cluster, opts = {}) {
    if (tripRefuses('autopilot')) return;
    // Empty battery (DECISIONS §27): refuse, and say so (answers the player's press).
    if (this._batteryEmpty()) {
      this._emitBatteryEmpty({ _reactive: true });
      return;
    }
    if (!cluster?.center) return;
    this._debrisMapCluster = cluster;
    // Arrival point: {pos:{x,y,z}} (planner candidate) or bare {x,y,z}; anything else leaves the cluster-centre heading.
    const ap = opts && opts.arrivalPoint;
    const apPos = ap ? (ap.pos || ap) : null;
    this._clusterArrivalPoint =
      (apPos && Number.isFinite(apPos.x) && Number.isFinite(apPos.y) && Number.isFinite(apPos.z))
        ? new THREE.Vector3(apPos.x, apPos.y, apPos.z)
        : null;
    this._trawlActive = false;  // override trawl if active
    this._engaged = true;
    this._slothNoticeReset();
    this._setPhase(PHASE.RENDEZVOUS_FAR);
    this._holdTimer = 0;
    this._fmaRangeM = null;                                // first engaged update fills it
    this._headingMode = 'CLUSTER';
    this._headingTarget = this._clusterArrivalPoint
      ? this._clusterArrivalPoint.clone()
      : new THREE.Vector3(cluster.center.x, cluster.center.y, cluster.center.z);
    this._lockedTargetRef = null;
    this._arrivalSaidFor = undefined;   // a new engagement (cluster B after cluster A, no disengage between): said again
    this._arrivalPendingFor = undefined;

    if (this._player) {
      this._player.autopilotEngaged = true;
    }

    // CollisionAvoidanceSystem exemption
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { targetId: cluster.id });

    eventBus.emit(Events.AUTOPILOT_ENGAGE, {
      mode: 'CLUSTER',
      clusterId: cluster.id,
      targetName: cluster.name || cluster.id,
      phase: this._phase,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      // the map's own cluster name when it has one (never the raw id)
      text: cluster.name ? `Autopilot on: flying to ${cluster.name}.` : autopilotOnText('CLUSTER'),
      priority: 'info',
      _keep: true,
    });
  }

  /** @param {string} reason — 'MANUAL'|'DELTAV'|'ARRIVED'|'COLLISION'|'ARROW_INPUT'|'TRAWL'|'TARGET_LOST'|'TARGET_CAUGHT'|'BATTERY' */
  disengage(reason) {
    if (!this._engaged) return;

    this._engaged = false;
    this._slothNoticeReset();
    this._lockedTargetRef = null;
    this._arrivalSaidFor = undefined;
    this._arrivalPendingFor = undefined;
    this._debrisMapCluster = null;
    this._clusterArrivalPoint = null;
    this._goalPos = null;
    this._fmaRangeM = null;
    this._holdTimer = 0;
    this._holdExitDwell = 0;
    this._stationKeepDeltaV = 0;

    this._releaseTargetLock();

    // A leftover orbit-frame hold would overwrite every later direct write to the nose (PlayerSatellite
    // `_orientAlongVelocity`), so it ends with the autopilot. The attitude stays where it is (no snap).
    this._dropFrameHold();
    if (this._player) {
      this._player.autopilotEngaged = false;
      // A slow turn on the tail boxes leaves its rate with her (the player's rate-null brakes it), not zeroed by the hand-back.
      this._tripLetGo(this._player);
    }
    this._headingTarget = null;
    this._headingMode = 'NONE';
    this._setPhase(PHASE.OFF);

    eventBus.emit(Events.AUTOPILOT_DISENGAGE, { reason });
    if (reason === 'BATTERY') {
      this._emitBatteryEmpty({ _critical: true });
      // with the steering gas out as well she cannot turn at all: the one "no power" line
      const slowNow = this._player ? this._slowGeneric(this._player) : null;
      if (slowNow) this._slothNoPowerNote(this._player, this._slow, 'battery empty', slowNow);
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: autopilotOffText(reason),
        priority: reason === 'DELTAV' || reason === 'COLLISION' ? 'warning' : 'info',
        _keep: true,
      });
    }
    eventBus.emit(Events.SHOW_NOTIFICATION, { text: 'AUTOPILOT DISENGAGED', kind: 'memo' });
  }

  /** The arrival line, as the one COMMS_MESSAGE (plain words; the next step to press stays up). */
  _emitArrivalLine(text) {
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info', _keep: true });
  }

  /** The "Press D" line waiting for a daughter (nets 0 at arrival, none able to launch yet, one soon able to). Looks
   * again each real second: ready -> the line once; a daughter already out -> silence; a blocker that will not clear ->
   * that one plain line. Ends quietly if the lock changed or the piece is gone.
   * @param {number} dt real frame seconds */
  _tickDaughterLinePending(dt) {
    const key = this._arrivalPendingFor;
    if (key === undefined) return;
    const lockRef = this._lockedTargetRef;
    if (!lockRef || key !== lockRef || lockRef._captured === true || lockRef.alive === false) {
      this._arrivalPendingFor = undefined;
      return;
    }
    this._arrivalPendingT += dt;
    if (this._arrivalPendingT < 1.0) return;
    this._arrivalPendingT = 0;
    const readiness = this._armManager?.daughterLaunchReadiness?.(lockRef);
    if (!readiness) { this._arrivalPendingFor = undefined; this._arrivalSaidFor = key; return; }
    const text = arrivalLineText(lockRef.mass, this._motherNetsLeft, readiness);
    if (text === null && !readiness.going) return;   // still waiting
    this._arrivalPendingFor = undefined;
    this._arrivalSaidFor = key;
    if (text !== null) this._emitArrivalLine(text);
  }

  // WHEEL PRE-TURN. owner 2026-10-25: with the wheel kit, a docked daughter picked (keys 1-4) and a piece picked (either order),
  // the wheels turn the mother toward the shot the aim would take: no gas, at the wheels' own pace (no 30 s limit).
  // NOT an aim: own state `_preturn`; `isAiming()` and `isAttitudeHeld()` stay false; nothing is announced or aborted.
  // Firing (D) goes through the normal ceremony; its first act (`requestAimRotation`) ends the pre-turn: the rate it has is braked
  // on the wheels (billed) and the aim starts from where she got to. Same eased law as the aim on the wheel source (`_aimAccel`,
  // `_fireAimCouples`, `_billAimTail` are shared), minus the resolve: arrived, she holds the attitude (player.aimHold) until a
  // launch or cancel takes over.

  /**
   * A pick (piece or daughter) was made: ask for a pre-turn on the next frame; one already running is braked and re-planned.
   * A piece the automatic assist picked starts one only if a daughter is already picked (either order gives the same result).
   * @param {'target'|'arm'} kind @param {object} [data] the event's payload
   */
  _onPreturnTrigger(kind, data) {
    const W = Constants.WHEEL_PRETURN;
    if (!W || W.ENABLED === false) return;
    const auto = kind === 'target' && !!(data && (data.autoLock || data.autoTarget || data.autoAcquire));
    if (auto) {
      const am = this._armManager;
      const picked = am && typeof am.getSelectedArm === 'function' ? am.getSelectedArm() : null;
      if (!picked) {                                                    // no daughter picked: nothing is asked for, nothing runs
        this._preturnReq = null;
        if (this._preturn) this._endPreturn('automatic pick');
        return;
      }
    }
    // a running pre-turn is braked and re-planned by the next tick in one go: she is never handed back for a frame between
    this._preturnReq = { target: kind === 'target' && data && data.debris ? data.debris : null };
  }

  _preturnDrop(why) {
    this._preturnReq = null;
    if (why === 'piece cleared') this._preturnSaid = null;
    if (this._preturn) this._endPreturn(why);
  }

  /**
   * The (daughter, piece) pair a pre-turn would turn toward, or null: wheels usable, a docked daughter picked and launchable at
   * the piece (charged, in reach, holds its mass, nobody owns the piece, no line crossed), and the mother free to turn
   * (`_motherTurnBlock`, the ceremony's own test).
   * @param {object|null} piece the piece the pick named (null: the target selector's)
   * @param {boolean} [full] also ask the slower gates (an owner on the piece, a crossed line)
   * @returns {{arm: object, target: object}|null}
   */
  _preturnCandidate(piece, full = true) {
    const p = this._player, am = this._armManager;
    const W = Constants.WHEEL_PRETURN;
    if (!p || !am || !W || W.ENABLED === false || !Constants.FEATURE_FLAGS.SEMI_AUTO_AIM) return null;
    if (typeof p.hasWheelKit !== 'function' || !p.hasWheelKit() || !p.wheelsUsable()) return null;
    if (typeof p.isSlothMode === 'function' && p.isSlothMode()) return null;          // sloth mode: the aim's own slow law, no pre-turn
    if (p.safeMode) return null;                                                      // daughters are locked in safe mode
    const res = p.resources;
    if (res && Number.isFinite(res.battery)) {
      const max = res.batteryMax || (p._resourceSystem && p._resourceSystem.batteryMax) || Constants.BATTERY_MAX;
      if (res.battery < W.MIN_BATTERY_FRAC * max) return null;
    }
    const arm = typeof am.getSelectedArm === 'function' ? am.getSelectedArm() : null;
    if (!arm || arm.state !== Constants.ARM_STATES.DOCKED || !arm.springCharged || !(arm.fuel > 5) || arm._aimReserved) return null;
    if (!arm.position || !arm.config) return null;
    const ts = this._targetSelector;
    const target = piece || (ts && typeof ts.getActiveTarget === 'function' ? ts.getActiveTarget() : null);
    if (!target || target._disposed === true || target.alive === false || !target._scenePosition) return null;
    if ((target.mass || 0) > arm.config.maxCaptureMass && !((target.mass || 0) > Constants.CAPTURE_NET.LARGE.CATCH_LIMIT_KG)) return null;   // over the catch limit she inspects, no net
    if (checkActiveSatArming(target, am._catalogLoader, QUIET_BUS)) return null;      // an active satellite is never a target
    const dx = target._scenePosition.x - arm.position.x, dy = target._scenePosition.y - arm.position.y, dz = target._scenePosition.z - arm.position.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_UNITS_PER_METER > arm.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION) return null;
    if (this._engaged || p.autopilotEngaged || this._tripHold || this._tripOmega > 0 || this._turn || this._aimCoroutine || this._attitudeHold) return null;
    if (typeof am._motherTurnBlock === 'function' && am._motherTurnBlock()) return null;
    if (full && typeof am.indexLaunchRefusal === 'function' && am.indexLaunchRefusal(arm.index, target)) return null;
    return { arm, target };
  }

  /** Dock-to-piece direction the launch ceremony would use; returns a reused scratch object. */
  _preturnProvider(arm, target) {
    const out = { x: 0, y: 0, z: 0 };
    return () => {
      const tp = target._scenePosition ? target._scenePosition
        : (typeof target.getScenePosition === 'function' ? target.getScenePosition() : null);
      if (!tp || !arm.position) return null;
      const dx = tp.x - arm.position.x, dy = tp.y - arm.position.y, dz = tp.z - arm.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      out.x = dx / len; out.y = dy / len; out.z = dz / len;
      return out;
    };
  }

  /**
   * Start the pre-turn a pick asked for (one frame after the pick: its own emit has finished). Nothing starts when the shot is
   * already on the piece or the wheels cannot turn her toward it (full that way).
   */
  _startPreturn() {
    const req = this._preturnReq;
    this._preturnReq = null;
    const c = this._preturnCandidate(req ? req.target : null, true);
    if (!c) return;
    const { arm, target } = c;
    const p = this._player, am = this._armManager;
    const AIM = Constants.AIM;
    const tolRad = degToRad(AIM.DAUGHTER_AIM_TOLERANCE_DEG);
    const rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);
    // With a pair offered for this daughter and piece, turn toward the PAIR's attitude (barrel on the pair's direction, both struts
    // to its angle) instead of the single shot; same guards, wheel-only
    const offer = this._pairOffer;
    if (offer && (arm === offer.armA || arm === offer.armB) && offer.t1 === target && this._pairPieceOk(offer.t2)) {
      const pprov = this._pairAimProvider(offer);
      const pshot = this._planPairShot(pprov, { arm: offer.armA, armManager: am, pair: { armB: offer.armB, alpha: offer.alpha } }, AIM.AIM_TIMEOUT_S, tolRad, rate);
      if (pshot && pshot.errRad > tolRad) {
        const pwheels = p.attitudeTorqueSource({ spinUp: true, angleRad: pshot.errRad - 0.5 * tolRad, nx: pshot.nx, ny: pshot.ny, limitS: Infinity, quiet: true });
        if (pwheels === 'wheels') {
          this._preturn = {
            mode: 'daughter', arm, armManager: am, pairIndex: arm.index, target, provider: pprov, shot: pshot,
            pair: { armB: offer.armA === arm ? offer.armB : offer.armA, armA: arm, alpha: offer.alpha, key: offer.key },
            alphaF: offer.alpha,
            tolRad, stopErr: 0.5 * tolRad, rate,
            sloth: true, src: 'wheels', burn: null, axX: pshot.nx, axY: pshot.ny, omega: 0,
            phase: 'turn', elapsed: 0, recheckS: Constants.WHEEL_PRETURN.RECHECK_S,
            ease: { durationS: 0 },
          };
          p.aimHold = true;
          if (this._preturnSaid !== offer.key) {
            this._preturnSaid = offer.key;
            eventBus.emit(Events.COMMS_MESSAGE, { text: 'Turning on the reaction wheels toward the pair shot (no gas).', priority: 'info', source: 'HOUSTON' });
          }
        }
      }
      return;
    }
    const provider = this._preturnProvider(arm, target);
    // The shot the fire would take right now: the pre-turn does the first part of that very aim on the wheels, so a later fire
    // finds less left to turn. When the shot's turn is on the gas (too long for the wheels in 30 s, or they are full that way) the
    // pre-turn still turns her toward it on the wheels at their pace, if they can turn her that way at all.
    const shot = this._planDaughterShot(provider, { arm, armManager: am, pairIndex: arm.index }, AIM.AIM_TIMEOUT_S, tolRad, rate);
    if (!shot || !(shot.errRad > tolRad)) return;
    const wheelsOk = p.attitudeTorqueSource({ spinUp: true, angleRad: shot.errRad - 0.5 * tolRad, nx: shot.nx, ny: shot.ny, limitS: Infinity, quiet: true });
    if (wheelsOk !== 'wheels') return;
    this._preturn = {
      mode: 'daughter', arm, armManager: am, pairIndex: arm.index, target, provider, shot,
      alphaF: shot.alpha,                       // strut angle her boresight is aimed for, fixed now (as the aim does)
      tolRad, stopErr: 0.5 * tolRad, rate,
      sloth: true, src: 'wheels',               // slow law on the wheels: lit time moves their spin and is billed
      burn: null, axX: shot.nx, axY: shot.ny, omega: 0,
      phase: 'turn', elapsed: 0, recheckS: Constants.WHEEL_PRETURN.RECHECK_S,
      ease: { durationS: 0 },                   // strut move as short as possible (keyed by this object)
    };
    p.aimHold = true;                           // she holds this attitude: nothing else (prograde re-orient, rate-null) may move her
    if (this._preturnSaid !== target) {
      this._preturnSaid = target;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning on the reaction wheels toward the shot (no gas).', priority: 'info', source: 'HOUSTON',
      });
    }
  }

  /**
   * End the pre-turn: the rate it has is braked on the wheels (lit time billed; the wheels keep what the turn put in them) and
   * she is handed back, unless another holder of the nose keeps `aimHold`.
   * @param {string} why short reason (kept in `_preturnEnd` for the tests and the log)
   */
  _endPreturn(why) {
    const pt = this._preturn;
    if (!pt) return;
    this._preturn = null;
    this._billAimTail(pt);
    this._preturnEnd = why;
    const p = this._player;
    if (p) p.aimHold = !!(this._attitudeHold || this._aimCoroutine || this._turn);
  }

  /**
   * Before anything moves the nose this frame: a pre-turn whose conditions are gone ends. The wheels, daughter, piece and the
   * ceremony's own conditions (`_motherTurnBlock`) are asked every frame; a net or catch on the piece, a line across another
   * daughter's, every RECHECK_S.
   */
  _preturnGuard(dt) {
    const pt = this._preturn;
    if (!pt) return;
    const W = Constants.WHEEL_PRETURN;
    const slow = (pt.recheckS -= dt) <= 0;
    if (slow) pt.recheckS = W.RECHECK_S;
    const c = this._preturnCandidate(pt.target, slow);
    if (!c || c.arm !== pt.arm || c.target !== pt.target) {
      this._endPreturn(c ? 'another pick' : 'conditions gone');
    } else if (pt.pair && (!this._pairOffer || this._pairOffer.key !== pt.pair.key)) {
      this._endPreturn('the pair is gone');                          // the offer ended or changed (the next frame plans the right turn)
    }
  }

  /**
   * One frame of the pre-turn (or of the request waiting to become one): the aim's eased law on the wheels (`_tickAimEased`).
   * She climbs to the wheels' own peak (their room, never above AP_ROT_RATE), brakes into the shot and rests on it; the strut
   * swings to the chosen angle at its own pace. Arrived she holds (no torque) until the line drifts REENGAGE_DEG off, then turns again.
   * @param {number} dtWorld game seconds (0 with the world held: nothing turns, nothing is billed)
   */
  _tickPreturn(dt, dtWorld) {
    if (this._preturnReq && dtWorld > 0) {
      if (this._preturn) this._endPreturn('re-plan');
      this._startPreturn();
      return;
    }
    const pt = this._preturn;
    if (!pt) return;
    if (!(dtWorld > 0) || !(dt > 0)) return;
    const p = this._player;
    pt.elapsed += dt;
    const raw = pt.provider();
    if (!raw) { this._endPreturn('piece lost'); return; }
    const T = this._aimTargetDir.set(raw.x, raw.y, raw.z);
    if (!(T.lengthSq() > 1e-12)) return;
    T.normalize();
    const q = p.quaternion;
    const az = this._aimAzimuth(pt);
    const bm = this._aimBm;
    if (pt.pair) bm.set(0, 0, 1); else strutLocalDirection(pt.alphaF, az, bm);   // pair: the barrel is the boresight
    bm.applyQuaternion(q).normalize();
    const errM = Math.acos(Math.max(-1, Math.min(1, bm.dot(T))));

    // Arrived and at rest: hold (no torque) and swing the strut to the chosen angle (billed by the strut driver; not while another
    // driver has a move in flight, a "." press or an auto pose: that one finishes first). The strut stays folded while she turns:
    // a folded strut is the lighter ship, and a launch asked for mid-turn spins that ship up on the gas.
    const arm = pt.arm;
    if (pt.phase === 'hold') {
      for (const sa of (pt.pair ? [arm, pt.pair.armB] : [arm])) {
        if (sa._strutTargetAlpha === undefined && Math.abs(sa.getAimAlpha() - pt.alphaF) > 1e-6) {
          if (sa.setAimAlpha(pt.alphaF, dt, pt.ease) === false) { this._endPreturn('hinge locked'); return; }
        }
      }
      if (errM <= degToRad(Constants.WHEEL_PRETURN.REENGAGE_DEG)) return;
      pt.phase = 'turn';
    }

    const aFull = this._aimAccel(pt, bm, T);
    if (!(aFull > 0)) return;
    const a = aFull * p.wheelPeek(pt.burn.mx + pt.burn.my, dt);
    const dOm = a * dt;
    const rem = errM - pt.stopErr;
    const want = rem > 0 ? 0.5 * (-dOm + Math.sqrt(dOm * dOm + 8 * a * rem)) : 0;
    const was = pt.omega;
    const lo = Math.max(0, was - dOm);
    // the wheels' room left (they fill as she turns): no room and no rate = she cannot turn that way now
    const room = p.wheelSpareRate(pt.axX, pt.axY);
    if (was <= 0 && !(room > 1e-9) && errM > pt.tolRad) { this._endPreturn('wheels full'); return; }
    const vLim = Math.min(pt.rate, was + room);
    const now = Math.min(Math.max(want, lo), clamp(was + dOm, lo, vLim));

    if (errM <= pt.tolRad && now <= 0) {
      if (was > 0) this._fireAimCouples(pt, -1, was / aFull);
      pt.omega = 0;
      pt.phase = 'hold';
      return;
    }
    pt.omega = now;
    if (now !== was) this._fireAimCouples(pt, now > was ? 1 : -1, Math.abs(now - was) / aFull);
    const step = Math.min(now * dt, errM);
    if (step > 0 && errM > 1e-9) {
      this._aimDeltaQuat.setFromUnitVectors(bm, T);
      this._aimTargetQuat.copy(this._aimDeltaQuat).multiply(q);
      q.slerp(this._aimTargetQuat, step / errM);
      q.normalize();
    }
  }

  /**
   * Each gameplay frame from the main loop: advances the rendezvous state machine and commands Cartesian impulses.
   * @param {number} dt frame delta in seconds (game-scaled)
   */
  update(dt, dtWorld = TimeAuthority.baseGameDt(dt)) {
    // Last frame's transient recoil shake comes off the nose before anything below reads or writes it, so they work on the
    // commanded attitude; PlayerSatellite puts this frame's shake back after composing the attitude. Idempotent; no-op without a shake.
    const apPlayer = this._player;
    if (apPlayer && typeof apPlayer.undoRecoilOverlay === 'function') apPlayer.undoRecoilOverlay();
    if (apPlayer) this._slewStopTick(apPlayer, dtWorld);
    // order: a pre-turn whose conditions are gone ends before anything below moves the nose
    if (this._preturn) this._preturnGuard(dt);

    // The orbit-frame hold steps aside whenever something else owns the nose (aim, scripted turn, reel-in / launch hold) and
    // never outlives the engagement.
    if (this._apFrameHold && (!this._engaged || this._aimCoroutine || this._turn || this._attitudeHold)) this._dropFrameHold();
    // An aim, scripted turn or reel-in hold takes the nose from a slow turn that still carries a rate on the tail boxes: she goes
    // on turning on that rate and the boxes brake it (battery billed); the incoming controller starts from rest once braked,
    // never from a spin stopped in one frame.
    const carrying = apPlayer ? this._slothCarryTick(apPlayer, dt, dtWorld) : false;

    if (!carrying) this._tickAimCoroutine(dt);

    // A held world (the drawer) neither turns the ship nor bills gas.
    this._tickTurnCoroutine(dtWorld > 0 && !carrying ? dt : 0);

    // Reel-in always ends with a stow/snap/miss event; an internal safety cap releases if one is ever missed.
    this._tickAttitudeHold(dtWorld > 0 ? dt : 0);   // the 120 s cap does not run while the world is held
    this._tickLaunchHold(dtWorld > 0 ? dt : 0);     // the hold from the end of the aim to the spring
    if (dtWorld > 0) this._tickPairOffer(dt);       // second piece for a picked daughter's opposite partner; before the pre-turn reads it
    if (dtWorld > 0) this._tickPairLesson(dt);      // Mission 2 coach beat's setup; after the offer's look, which it waits on
    this._tickPreturn(dt, dtWorld);

    // The transfer trip's prograde hold: attitude only, not the autopilot. A held world does not turn the ship; a scripted turn /
    // aim / reel-in hold owns the nose and the hold steps aside (the leash hand-off turn is `_turn`). Heading is kept in the
    // ORBIT frame (see `_tickTripHold`).
    if (this._tripHold && !this._engaged && this._player) {
      this._tickTripPower();   // §27: not at 0 Wh (the trip burns as she points); the turn comes back with the power
      this._tickTripHold(dt, dtWorld);
      return;
    }

    if (!this._engaged || !this._player) return;

    this._tickDaughterLinePending(dt);

    const dv = this._getRemainingDeltaV();
    if (dv < DISENGAGE_DV_MIN) {
      this.disengage('DELTAV');
      return;
    }

    // Empty battery (DECISIONS §27)
    if (this._batteryEmpty()) {
      this.disengage('BATTERY');
      return;
    }

    if (this._lockedTargetRef && !this._lockedTargetRef.alive) {
      this.disengage('TARGET_LOST');
      return;
    }

    // Locked target already caught: a parked catch is still `alive` but DebrisField no longer propagates its orbit, so the
    // orbit-derived goal is a ghost the mother leaves behind at orbital speed: hand the ship back. Must come BEFORE
    // _resolveTargetState. The reel-in attitude hold is independent of engagement and keeps running.
    if (this._lockedTargetRef && isChaseDone(this._lockedTargetRef)) {
      this.disengage('TARGET_CAUGHT');
      return;
    }

    const targetState = this._resolveTargetState(dt);
    if (!targetState) {
      this._fmaRangeM = null;
      this._updateProgradeOnly(dt, dtWorld);
      return;
    }
    // A target takes over the nose (the control law slews it in the world frame): the prograde follow's orbit-frame hold ends
    // here, or it would overwrite every `_rotateTowardWorld` write.
    this._dropFrameHold();
    const { Pd, Vd, mode } = targetState;

    // legacy listeners: AUTOPILOT_ENGAGE when the heading mode changes
    if (mode !== this._headingMode) {
      this._headingMode = mode;
      eventBus.emit(Events.AUTOPILOT_ENGAGE, {
        mode: this._headingMode,
        targetName: this._getTargetLabel(),
        phase: this._phase,
      });
      // the lock may have changed: refresh the CA exemption
      this._refreshTargetLock();
    }

    // Target unit velocity v̂_d (player prograde if degenerate)
    const vdMag = Vd.length();
    const vHat = this._tmpV1;
    if (vdMag > 1e-10) {
      vHat.copy(Vd).divideScalar(vdMag);
    } else {
      const pv = this._player.getVelocity();
      vHat.set(pv.x, pv.y, pv.z);
      if (vHat.lengthSq() > 1e-20) vHat.normalize();
      else vHat.set(0, 0, 1);
    }

    const Dtrail_m = this._getTrailDistance();
    const Dtrail_scene = Dtrail_m * M;

    // Goal pose: P_m* = P_d − v̂_d · D_trail
    const Pm_goal = this._tmpV2.copy(Pd).addScaledVector(vHat, -Dtrail_scene);
    this._goalPos = this._goalPosV.copy(Pm_goal);
    this._headingTarget = this._headingTargetV.copy(Pd); // keep legacy HUD field populated

    const Pm = this._player.getPosition();                 // scene units
    const pvel = this._player.getVelocity();               // km/s
    const Vm = this._tmpV3.set(pvel.x, pvel.y, pvel.z);    // km/s

    const relP = this._relP.subVectors(Pm_goal, Pm);
    const relV = this._relVv.subVectors(Vd, Vm);

    const posErrM = relP.length() / M;                     // metres
    const velErrMps = relV.length() * 1000;                // m/s
    this._fmaRangeM = posErrM;

    // Angle error: ship nose (+Z local) vs. v̂_d
    const noseWorld = this._noseWorld.set(0, 0, 1).applyQuaternion(this._player.quaternion);
    const dotNose = Math.max(-1, Math.min(1, noseWorld.dot(vHat)));
    const angleRad = Math.acos(dotNose);

    const AP = Constants.AUTOPILOT;
    const POS_TOL = AP.POS_TOL;                            // m
    const VEL_TOL = AP.VEL_TOL;                            // m/s
    const ANG_TOL = degToRad(AP.ANG_TOL_DEG);        // rad
    const FAR_TO_MATCH = AP.FAR_TO_MATCH_POS;              // m

    // Predictive quadratic-braking profile: v*(r) = min(V_CAP, √(2·A_BRAKE·r)). Commanded ΔV = KP_VEL · (v*·goalDir + relV_mps),
    // zero when relV = −v*·goalDir (matching the closing profile); at r=0 v*=0, so it is pure velocity damping and the ship arrives
    // at rest. A_BRAKE leaves headroom below MAX_ACCEL for transverse corrections and tracking error.
    // See archive/AUTOPILOT_ANALYSIS.md Retrospective #2.
    // The engine applies only `thrustScale` (argon 0.46, xenon 1.0) of the commanded Δv (PlayerSatellite.applyCartesianImpulse), so
    // A_BRAKE scales by it too, or an argon ship would plan to brake harder than it can and fly through the goal. Scaled ONCE: the
    // request limit below (MAX_ACCEL · dt) is not, so the real limit is thrustScale·MAX_ACCEL and the real/brake headroom
    // (1/BRAKE_FRACTION = 2x) is the same on every fuel. The MATCH→TRAIL gate below reads the same A_BRAKE.
    const A_BRAKE = AP.MAX_ACCEL * AP.BRAKE_FRACTION * this._engineThrustScale();   // m/s²
    const vStarBrake = Math.sqrt(2 * A_BRAKE * posErrM);   // m/s
    const vStar = Math.min(AP.V_CAP, vStarBrake);          // m/s

    // goalDir in world frame (scene-unit direction == world-direction since M is scalar)
    const goalDir = this._goalDir.set(0, 0, 0);
    if (relP.lengthSq() > 1e-20) goalDir.copy(relP).normalize();
    const relV_mps = this._relVmps.copy(relV).multiplyScalar(1000);
    const velCtrlErr = this._velCtrlErr.copy(goalDir).multiplyScalar(vStar).add(relV_mps);

    const dvCmd = this._dvCmd.set(0, 0, 0);

    switch (this._phase) {
      case PHASE.RENDEZVOUS_FAR: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        if (posErrM < FAR_TO_MATCH) this._setPhase(PHASE.MATCH_ORBIT);
        break;
      }
      case PHASE.MATCH_ORBIT: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        // MATCH→TRAIL gate: under the braking law the residual velocity error is v*(r) by design, so a tight velErr gate would block
        // TRAIL_ALIGN entry until sub-metre posErr; gate on posErr and a looser velErr consistent with v*(D_trail).
        if (posErrM < Dtrail_m && velErrMps < Math.sqrt(2 * A_BRAKE * Dtrail_m)) {
          this._setPhase(PHASE.TRAIL_ALIGN);
        } else if (posErrM > FAR_TO_MATCH * 1.5) {
          this._setPhase(PHASE.RENDEZVOUS_FAR);
        }
        break;
      }
      case PHASE.TRAIL_ALIGN: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        if (posErrM < POS_TOL && velErrMps < VEL_TOL && angleRad < ANG_TOL) {
          this._setPhase(PHASE.HOLD);
          this._holdTimer = 0;

          // Snap mother orbit shape/plane to the target's so they share Keplerian elements and propagate together (prevents secular
          // drift from differential drag and residual ΔV error). Snapping the plane (inc/raan/argPerigee) maps the old trueAnomaly to a
          // DIFFERENT Cartesian position, potentially hundreds of km away: capture the pre-snap position, snap, then recompute
          // trueAnomaly so the Cartesian position matches it.
          // Skipped for an onboarding tease pin (`_onboardingPinned`): the pin's orbit IS the mother's elements (DebrisField re-syncs it
          // every frame), so the copy would be a no-op at best; the mother never takes elements from a piece that takes them from her.
          if (this._lockedTargetRef && this._lockedTargetRef.orbit && this._player &&
              !this._lockedTargetRef._onboardingPinned) {
            const tOrb = this._lockedTargetRef.orbit;
            const pOrb = this._player.orbit;

            const preSnap = orbitToSceneCartesian(pOrb);

            pOrb.semiMajorAxis = tOrb.semiMajorAxis;
            pOrb.eccentricity  = tOrb.eccentricity;
            pOrb.inclination   = tOrb.inclination;
            pOrb.raan          = tOrb.raan;
            pOrb.argPerigee    = tOrb.argPerigee;
            pOrb.meanMotion    = tOrb.meanMotion;

            const inc  = pOrb.inclination;
            const raan = pOrb.raan;
            const argP = pOrb.argPerigee;
            const cosO = Math.cos(raan), sinO = Math.sin(raan);
            const cosW = Math.cos(argP), sinW = Math.sin(argP);
            const cosI = Math.cos(inc),  sinI = Math.sin(inc);

            // Perifocal → scene rotation (matches keplerianToCartesian)
            const l1 = cosO * cosW - sinO * sinW * cosI;
            const l2 = -cosO * sinW - sinO * cosW * cosI;
            const m1 = sinO * cosW + cosO * sinW * cosI;
            const m2 = -sinO * sinW + cosO * cosW * cosI;
            const n1 = sinW * sinI;
            const n2 = cosW * sinI;

            // Inverse (scene → perifocal): xP = l1*x + n1*y + m1*z
            const sx = preSnap.position.x;
            const sy = preSnap.position.y;
            const sz = preSnap.position.z;
            const xP = l1 * sx + n1 * sy + m1 * sz;
            const yP = l2 * sx + n2 * sy + m2 * sz;

            let newTA = Math.atan2(yP, xP);
            if (newTA < 0) newTA += 2 * Math.PI;
            pOrb.trueAnomaly = newTA;

            // Zero RCS residual so the additive position offset in PlayerSatellite.update() doesn't shift the mother off the
            // orbit-derived position and trigger spurious dead-band corrections.
            if (this._player._rcsVelocity) {
              this._player._rcsVelocity.set(0, 0, 0);
            }
          }

          eventBus.emit(Events.AUTOPILOT_ARRIVED, { mode: this._headingMode });
          // (DECISIONS §33, one line per fact) Said once per lock, never for a piece already caught or gone. A HOLD excursion (4*POS_TOL)
          // drops to TRAIL_ALIGN and re-arrives on the same lock: it must not repeat the line. With no mother nets the D line waits until
          // a daughter can really launch (_tickDaughterLinePending); if none ever can, it names why instead; a daughter already out
          // for this piece: nothing to say.
          const lockRef = this._lockedTargetRef;
          const lockKey = lockRef || ARRIVAL_NO_LOCK;
          const lockDone = !!lockRef && (lockRef._captured === true || lockRef.alive === false);
          if (!lockDone && this._arrivalSaidFor !== lockKey && this._arrivalPendingFor !== lockKey) {
            const readiness = (lockRef && !(this._motherNetsLeft > 0))
              ? (this._armManager?.daughterLaunchReadiness?.(lockRef) ?? null) : null;
            const text = arrivalLineText(lockRef ? lockRef.mass : 0, this._motherNetsLeft, readiness);
            if (text === null && !readiness?.going) {
              this._arrivalPendingFor = lockKey;    // a daughter will be ready soon: say it then
              this._arrivalPendingT = 0;
            } else {
              this._arrivalSaidFor = lockKey;
              if (text !== null) this._emitArrivalLine(text);
            }
          }
        } else if (posErrM > Dtrail_m * 3) {
          this._setPhase(PHASE.MATCH_ORBIT);
        }
        break;
      }
      case PHASE.HOLD: {
        // Continuous orbit-shape sync: copy target shape/plane elements to the mother every frame (models station-keeping thrust that
        // compensates differential drag, CoM perturbations and other forces the debris does not experience). Same teleportation guard
        // as the TRAIL_ALIGN→HOLD snap: if the plane changed since last frame (perturbation, CA impulse), recompute trueAnomaly to
        // preserve the mother's position.
        // Skipped for an onboarding tease pin (`_onboardingPinned`): the pin takes ITS elements from the mother every frame
        // (DebrisField._syncPinnedOrbitToMother), so both already share elements and the copy would only write her own values back.
        // `syncedThisFrame` stays TRUE for a pinned lock: the lock-step it guards (no dead-band damping pulse) holds by construction.
        let syncedThisFrame = false;
        if (this._lockedTargetRef && this._lockedTargetRef.orbit && this._player) {
          syncedThisFrame = true;
        }
        if (syncedThisFrame && !this._lockedTargetRef._onboardingPinned) {
          const tOrb = this._lockedTargetRef.orbit;
          const pOrb = this._player.orbit;

          const planeChanged =
            pOrb.inclination !== tOrb.inclination ||
            pOrb.raan        !== tOrb.raan ||
            pOrb.argPerigee  !== tOrb.argPerigee;

          const preSnap = planeChanged ? orbitToSceneCartesian(pOrb) : null;

          pOrb.semiMajorAxis = tOrb.semiMajorAxis;
          pOrb.eccentricity  = tOrb.eccentricity;
          pOrb.inclination   = tOrb.inclination;
          pOrb.raan          = tOrb.raan;
          pOrb.argPerigee    = tOrb.argPerigee;
          // trueAnomaly deliberately NOT copied — preserves trailing offset
          pOrb.meanMotion    = tOrb.meanMotion;

          if (planeChanged && preSnap) {
            const cosO = Math.cos(pOrb.raan), sinO = Math.sin(pOrb.raan);
            const cosW = Math.cos(pOrb.argPerigee), sinW = Math.sin(pOrb.argPerigee);
            const cosI = Math.cos(pOrb.inclination), sinI = Math.sin(pOrb.inclination);
            const l1 = cosO * cosW - sinO * sinW * cosI;
            const l2 = -cosO * sinW - sinO * cosW * cosI;
            const m1 = sinO * cosW + cosO * sinW * cosI;
            const m2 = -sinO * sinW + cosO * cosW * cosI;
            const n1 = sinW * sinI;
            const n2 = cosW * sinI;
            const sx = preSnap.position.x, sy = preSnap.position.y, sz = preSnap.position.z;
            let newTA = Math.atan2(
              l2 * sx + n2 * sy + m2 * sz,
              l1 * sx + n1 * sy + m1 * sz
            );
            if (newTA < 0) newTA += 2 * Math.PI;
            pOrb.trueAnomaly = newTA;
          }
        }

        // Dead-band for along-track fine-tuning: a gentle velocity-damping pulse when the trailing distance drifts outside tolerance
        // (numerical noise, frame-boundary drag mismatch).
        // CRITICAL: skipped while the continuous orbit-sync above is active. The sync alone holds the mother at the trailing point
        // (shared elements and mean motion = lock-step); a velocity-damping `applyCartesianImpulse` re-derives `player.orbit` from a
        // STALE cached `_cartesian` state and discards the sync that just ran, and with da/dv ≈ 1.8 km per m/s at LEO a sub-m/s pulse
        // corrupts the semi-major axis by hundreds of metres (HOLD ⇄ TRAIL_ALIGN oscillation).
        if (!syncedThisFrame && (posErrM > POS_TOL || velErrMps > VEL_TOL)) {
          dvCmd.addScaledVector(relV_mps, AP.KP_VEL * 0.5);
        }

        // Hysteresis + dwell: drop back to TRAIL_ALIGN only on a LARGE excursion (4× tolerance: sync failed, target lost, big
        // perturbation) that PERSISTS for HOLD_EXIT_DWELL_S, which debounces single-frame transients (CA dodge settling, measurement
        // lag, drag mismatch). Measured posErr/velErr is used so a genuinely displaced mother (e.g. a large CA dodge the sync cannot
        // heal) still demotes and re-aligns.
        // The lasso fires only inside NET_LOCK_RANGE_M (90 m, LASSO_RANGE === NET_LOCK_RANGE_M) but the 4·POS_TOL band lets a lasso
        // HOLD (park point D_TRAIL_LASSO 70 m) sit up to ~130 m out, "on station" where [N] is refused (measured: HOLD held at
        // 91–129 m). For the lasso a target beyond the gate is an excursion too: same dwell, same demotion. Re-entry needs
        // posErr < POS_TOL (≤ 85 m), so it cannot oscillate.
        const lassoOutOfReach = this._targetSelector?._recommendedTool === 'lasso'
          && Pm.distanceTo(Pd) / M > Constants.NET_LOCK_RANGE_M;
        const excursion = posErrM > 4 * POS_TOL || velErrMps > 4 * VEL_TOL || lassoOutOfReach;
        if (excursion) {
          this._holdExitDwell += dt;
        } else {
          this._holdExitDwell = 0;
        }
        if (excursion && this._holdExitDwell >= AP.HOLD_EXIT_DWELL_S) {
          this._setPhase(PHASE.TRAIL_ALIGN);
        } else {
          // Suppress the HOLD timer while ANY of: (a) a daughter arm is actively seeking targets; (b) a locked target is still alive.
          // With (b) the contract is "hold indefinitely until manual disengage, target captured/burned (TARGET_CAUGHT / TARGET_LOST,
          // checked at the top of update()) or arm work starts"; without it the mother auto-disengages 1.5 s after arrival and drifts
          // away ((a) alone only covers the post-deployment window). The remaining ARRIVED auto-disengage is cluster / prograde AP (no
          // target locked): nothing further to do, so it shuts off after 1.5 s.
          // Canonical predicate: covers REELING, HAULING, etc.
          const armsActive = this._armManager?.hasTetheredArm?.() || false;
          const hasLockedTarget = !!(this._lockedTargetRef && this._lockedTargetRef.alive);
          if (!armsActive && !hasLockedTarget) {
            this._holdTimer += dt;
          }
          if (this._holdTimer >= AP.HOLD_DURATION) {
            this.disengage('ARRIVED');
            return;
          }
        }
        // When an arm is GRAPPLED or REELING the mother also gently closes on the daughter: a small additive ΔV toward the active arm,
        // bounded by the MAX_ACCEL clamp below so it cannot overpower HOLD control; works whether or not the target's orbit is synced.
        if (this._armManager && this._armManager.arms) {
          let activeArm = null;
          for (const a of this._armManager.arms) {
            if (a.state === Constants.ARM_STATES.GRAPPLED ||
                a.state === Constants.ARM_STATES.REELING) {
              activeArm = a;
              break;
            }
          }
          if (activeArm && activeArm.position) {
            const toArm = this._tmpV3.subVectors(activeArm.position, Pm);
            const distM = toArm.length() / M;
            if (distM > 1) {
              // Closing rate proportional to gap, capped at 3 m/s: a stale 1-km drift converges in ~5 min, and a clean ≤ 35 m capture isn't
              // disturbed (3 % gain × 35 m = 1 m/s vs the 4 m/s reel-in).
              const closeSpeed = Math.min(3.0, distM * 0.03);
              toArm.normalize();
              // Applied as velocity-control error so KP_VEL converts it to a Cartesian impulse on the same scale as the rest of HOLD.
              // toArm points mother→arm (a positive scalar pushes the mother toward the arm); the MAX_ACCEL clamp below bounds it.
              dvCmd.addScaledVector(toArm, closeSpeed * AP.KP_VEL);
            }
          }
        }
        break;
      }
      default:
        break;
    }

    // Clamp commanded ΔV by MAX_ACCEL · gameDt. Orbit propagation runs at the world rate (dtWorld), so the acceleration budget must
    // match it, or the effective braking authority is 1/scale of what the profile assumes and the ship oscillates through the goal.
    // dtWorld is the TimeAuthority world delta (byte-identical to dt × base rate at 1× warp).
    const gameDt = dtWorld;
    const maxDv = AP.MAX_ACCEL * gameDt;
    const dvMag = dvCmd.length();
    if (dvMag > maxDv && dvMag > 1e-12) {
      dvCmd.multiplyScalar(maxDv / dvMag);
    }

    // Resource bookkeeping inside applyCartesianImpulse uses the raw dt so fuel use stays physical, not time-warped.
    // `continuous`: a per-frame burn is billed per second, whatever the frame rate.
    if (dvCmd.lengthSq() > 1e-18) {
      this._player.applyCartesianImpulse(dvCmd, dt, { continuous: true });
    }

    // Aim-before-launch mutual exclusion: an aim coroutine or a reel-in attitude hold owns the quaternion; the HOLD-phase
    // prograde steer must not fight it.
    if (!this._aimCoroutine && !this._attitudeHold) {
      this._rotateTowardWorld(vHat, dt, dtWorld);
    }
  }

  /**
   * The engine's push per watt relative to xenon: the active fuel's thrustScale (PlayerSatellite.getThrustScale), 1 for a player
   * without the accessor (menu hero, test stubs).
   * @returns {number} > 0
   */
  _engineThrustScale() {
    const p = this._player;
    const s = (p && typeof p.getThrustScale === 'function') ? p.getThrustScale() : 1;
    return s > 0 ? s : 1;
  }

  /** Advance the rendezvous phase. No public phase event on purpose: the HUD reads `getCurrentPhase()` directly. */
  _setPhase(newPhase) {
    if (newPhase === this._phase) return;
    this._phase = newPhase;
    // Reset the HOLD-exit debounce on any phase change: a fresh HOLD entry starts clean and a demotion can't carry stale dwell time.
    this._holdExitDwell = 0;
  }

  /**
   * Resolve a debris target's scene-Cartesian position + velocity into the two scratch outputs: the ONE place the autopilot turns
   * a debris record into a rendezvous state.
   * An onboarding tease pin (`_onboardingPinned`) rides the mother at a fixed offset in her LOCAL frame; DebrisField writes it to
   * `_scenePosition` every frame and re-syncs the piece's orbit to the mother's elements. The orbit still cannot express the pin's
   * LATERAL offset (one pin sits 18 m to one side of the boresight), so for a pinned piece the authoritative pose is
   * `_scenePosition` and the velocity is the mother's own (the pin is nose-relative, not prograde-relative). Every other debris
   * derives both from its live orbit.
   * @param {object} debris debris record ({ orbit, _onboardingPinned, _scenePosition })
   * @param {{x:number,y:number,z:number}} outPos scratch, written in place
   * @param {{x:number,y:number,z:number}} outVel scratch, written in place
   * @returns {boolean} true when the outputs were written; false when the record has neither a usable pin nor an orbit (untouched)
   */
  _targetSceneState(debris, outPos, outVel) {
    if (!debris) return false;
    const sp = debris._scenePosition;
    if (debris._onboardingPinned && sp && this._player) {
      outPos.x = sp.x; outPos.y = sp.y; outPos.z = sp.z;
      const pv = this._player.getVelocity();
      outVel.x = pv.x; outVel.y = pv.y; outVel.z = pv.z;
      return true;
    }
    if (!debris.orbit) return false;
    orbitToSceneCartesianInto(debris.orbit, outPos, outVel);
    return true;
  }

  /**
   * Resolve the current target's scene-Cartesian state and heading mode.
   * Priority: locked TARGET ref > live TARGET ref > TRAWL cluster > large DEBRIS scan.
   * @returns {{ Pd: THREE.Vector3, Vd: THREE.Vector3, mode: string }|null}
   */
  _resolveTargetState(dt) {
    // Locked TARGET ref (persists through target cycling). A locked piece already caught (frozen orbit, see isChaseDone) yields NO
    // state: not its ghost orbit, and not the selector's next target (falling through would silently re-target). update()
    // disengages before here; this keeps the resolver from steering at the ghost for any other caller.
    if (this._lockedTargetRef && this._lockedTargetRef.alive && isChaseDone(this._lockedTargetRef)) {
      return null;
    }
    if (this._lockedTargetRef && this._lockedTargetRef.alive && this._lockedTargetRef.orbit) {
      // A pinned piece resolves to its _scenePosition + the mother's velocity (`_targetSceneState`); a free piece to its live orbit.
      this._targetSceneState(this._lockedTargetRef, this._tmpAPCartPos, this._tmpAPCartVel);
      const p = this._tmpAPCartPos, v = this._tmpAPCartVel;
      return {
        Pd: this._PdV.set(p.x, p.y, p.z),
        Vd: this._VdV.set(v.x, v.y, v.z),
        mode: 'TARGET',
      };
    }

    // Non-locked heading: re-evaluate the priority chain
    this._debrisScanTimer += dt;
    const heading = this._determineHeading();
    if (!heading || !heading.position) return null;

    let Vd = null;

    if (heading.mode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t && t.orbit) {
        this._targetSceneState(t, this._tmpAPCartPos, this._tmpAPCartVel);
        const v = this._tmpAPCartVel;
        Vd = this._VdV.set(v.x, v.y, v.z);
      }
    } else if (heading.mode === 'TRAWL' &&
               this._trawlManager && this._trawlManager.activeCluster) {
      // Trawl clusters rarely expose a composite velocity; falls back to player prograde below (keeps the trailing vector tangent to
      // the player's own orbit, a fair approximation when the cluster drifts with the mother).
    } else if (heading.mode === 'DEBRIS' &&
               this._cachedDebrisResult && this._cachedDebrisResult.orbit) {
      orbitToSceneCartesianInto(
        this._cachedDebrisResult.orbit, this._tmpAPCartPos, this._tmpAPCartVel
      );
      const v = this._tmpAPCartVel;
      Vd = this._VdV.set(v.x, v.y, v.z);
    } else if (heading.mode === 'PROGRADE') {
      return null; // prograde coast: no rendezvous geometry
    }

    if (!Vd) {
      const pv = this._player.getVelocity();
      Vd = this._VdV.set(pv.x, pv.y, pv.z);
    }

    return { Pd: heading.position, Vd, mode: heading.mode };
  }

  /**
   * Prograde fallback: face velocity, no thrust.
   * At warp 1 the nose follows by the world-frame slew (`_rotateTowardWorld`, 0.2 rad/s of real time). Above warp 1 the orbit
   * turns the prograde frame faster (measured: 42 deg behind at 20x, up to 180 deg at 100x), so the heading is kept in the ORBIT
   * frame instead, as the transfer trip's hold does (`_tickTripHold`): the player recomposes prograde · offset from the exact
   * prograde every frame and the slew eases the offset to nothing.
   * @param {number} [dtWorld] world seconds; undefined = a caller that knows no warp (the world-frame slew)
   */
  _updateProgradeOnly(dt, dtWorld) {
    const pv = this._player.getVelocity();
    // _tmpV1 is free here: the main control law's vHat only runs when _resolveTargetState() returns non-null, which routes away.
    const dir = this._tmpV1.set(pv.x, pv.y, pv.z);
    if (dir.lengthSq() > 1e-20) {
      dir.normalize();
      // Aim-before-launch mutual exclusion (as on the main control path): the aim coroutine / reel-in freeze owns the quaternion.
      if (this._aimCoroutine || this._attitudeHold) { this._dropFrameHold(); return; }
      if (!this._turn && this._holdFrameForWarp(dt, dtWorld)) return;   // (a scripted turn owns the nose: no hold)
      this._dropFrameHold();
      this._rotateTowardWorld(dir, dt, dtWorld);
    }
  }

  /**
   * Is the world running faster than warp 1? `dtWorld` is the TimeAuthority clock; warp 1 is already BASE_SCALE (10x) real time,
   * so "above warp 1" is `dtWorld > dt * BASE_SCALE * 1.001` (the ramp snaps onto 1 within 1e-4, TimeAuthority.update). A held
   * world (`dtWorld` 0), a slowed one and an unknown clock count as not warping.
   */
  _isWarpAbove1(dt, dtWorld) {
    return dt > 0 && dtWorld > dt * TimeAuthority.BASE_SCALE * 1.001;
  }

  /**
   * Above warp 1, steer the engaged prograde follow through the player's orbit-frame hold (`setOrbitFrameHold`; recomposed from
   * the exact prograde every frame, so it follows the orbit at any world rate) and ease the offset from prograde to nothing at
   * the autopilot's own turn rate on REAL time (`easeOrbitFrameOffset`).
   * @returns {boolean} true when the hold steered this frame (warp above 1); false: the caller slews in the world frame
   */
  _holdFrameForWarp(dt, dtWorld) {
    const p = this._player;
    if (typeof p.setOrbitFrameHold !== 'function') return false;
    // With the steering gas out, the wheels or the boxes hold her in the orbit frame at EVERY warp (co-rotating with the orbit is
    // free; only a change of the offset is a turn, at the real α). Above warp 1 with gas the ease may still be the wheels'
    // (`_slewSource`, the 30 s rule) when they can finish it.
    const sloth = this._slowGeneric(p) !== null;
    if (!sloth && !this._isWarpAbove1(dt, dtWorld)) return false;
    if (!this._apFrameHold) { p.setOrbitFrameHold(true); this._apFrameHold = true; }
    const geom = this._offsetTurnGeom(p, _Q_IDENTITY);
    const src = geom ? this._slewSource(p, geom.err, geom.nx, geom.ny) : this._slowGeneric(p);
    if (src) { if (!(dtWorld <= 0)) this._slothOffsetTurn(p, dt, _Q_IDENTITY, src); return true; }   // a held world pauses the turn
    if (this._tripOmega > 0) this._slothBrakeBill(p);                  // the slow source stops being the source: bill the brake of what was turning
    const mr = p._manualRotation;                                      // the ease is billed (`_billSlewStep`)
    const snap = mr && typeof mr.angleTo === 'function';
    if (snap) this._slewQ0.copy(mr);
    p.easeOrbitFrameOffset(AP_ROT_RATE * dt, AP_ROT_DEADZONE);
    if (snap) this._billSlewStep(p, this._slewQ0, p._manualRotation, dt);
    return true;
  }

  /**
   * Why the slow source cannot push right now ('engine gas empty' | 'battery empty'), or null. The same reasons `slothPeek`
   * answers 0 for when the cathodes are warm; read here without asking the boxes (no warm-up starts). The wheels need only the battery.
   */
  _slothWhyBlocked(p, src = 'tailBoxes') {
    if (src !== 'wheels' && typeof p._slothGasOk === 'function' && !p._slothGasOk()) return 'engine gas empty';
    const wh = p.resources && p.resources.battery;
    if (src === 'wheels') return Number.isFinite(wh) && wh < Constants.WHEELS.MIN_BATTERY_WH ? 'battery empty' : null;
    if (Number.isFinite(wh) && !(wh > 0)) return 'battery empty';
    return null;
  }

  /**
   * The once-per-engagement "she can't turn" line. `holder` carries the flag: the autopilot's engagement (`this._slow`) or a
   * coroutine record (an aim, a scripted turn).
   * @returns {boolean} true when the source cannot push (the caller leaves her where she points)
   */
  _slothNoPowerNote(p, holder, why, src = 'tailBoxes') {
    if (why === undefined) why = this._slothWhyBlocked(p, src);
    if (!why) return false;
    if (!holder.noPowerSaid) {
      holder.noPowerSaid = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: src === 'wheels'
          ? 'Reaction wheels have no power: she waits where she points until the battery has charge.'
          : `Emergency steering has no power: steering gas empty and ${why}, she can't turn.`,
        priority: 'warning', source: 'HOUSTON',
      });
    }
    return true;
  }

  /**
   * The A-key follow and the trip hold announce their slow turn once: when it starts (more than 2° to go), and again only after
   * the engagement ended (`_slothNoticeReset`: a disengage, an engage, a hold start), a change of kind (prograde / retro / world
   * heading) or a NEW target (the locked target object or the commanded heading mode changed). Never because a world heading
   * drifts: a rendezvous heading turns with the orbit all the time (0.66°/s of real time at warp 1), and that is the same
   * target. Never per frame. No power / no engine gas says the one "can't turn" line instead.
   */
  _slothNotice(p, err, nx, ny, kind, src = 'tailBoxes') {
    const s = this._slow;
    if (this._slothNoPowerNote(p, s, undefined, src)) return;
    const mode = this._headingMode, ref = this._slothTargetRef();
    if (s.said && s.kind === kind && s.mode === mode && s.ref === ref) return;
    s.said = true; s.kind = kind; s.mode = mode; s.ref = ref;
    const t = slowTurnTimeS(p, src, err, nx, ny) + slowWarmupLeftS(p, src);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: src === 'wheels'
        ? `Autopilot turning on the reaction wheels, ${p.slothTimeWords(t)}.`
        : `Autopilot on emergency steering: turning slowly on the tail boxes, ${p.slothTimeWords(t)}.`,
      priority: 'warning', source: 'HOUSTON',
    });
  }

  /** What the engaged heading is aimed at, by identity: the locked target, the Field-Assay cluster, or the debris id. */
  _slothTargetRef() {
    if (this._lockedTargetRef) return this._lockedTargetRef;
    if (this._headingMode === 'CLUSTER') return this._debrisMapCluster || null;
    if (this._headingMode === 'DEBRIS' && this._cachedDebrisResult) return this._cachedDebrisResult.id ?? null;
    return null;
  }

  /** A new engagement (or a trip hold) says its slow turn and its no-power line again. */
  _slothNoticeReset() {
    const s = this._slow;
    s.said = false; s.kind = null; s.mode = null; s.ref = null; s.noPowerSaid = false;
  }

  /**
   * The real cold gas for a free slew step. The trip hold's ease, the prograde-only hold above warp 1 and the world-frame slew
   * (`_rotateTowardWorld`) all turn her at AP_ROT_RATE and charge nothing at normal gas. The caller snapshots the slewed
   * quaternion (`this._slewQ0.copy(q)`: `_manualRotation` for the orbit-frame offset, so the orbit's own turning stays free;
   * `p.quaternion` for the world slew) and calls this after the step. The body-frame step becomes a body rate (rad per REAL
   * second, so a swing bills the same at any warp) and the CHANGE of rate from last frame's is billed as angular momentum
   * (I x |dw|, pitch and yaw; roll is never commanded) through the player's `_billTurnNullN2`. Spin-up, a change of direction
   * and the stop each bill; steady tracking bills only its rate changes. The stop is billed by `_slewStopTick` (a frame with no
   * step). Mocks without the player's bill or inertia pay nothing.
   * @param {object} p player @param {THREE.Quaternion} qBefore snapshot @param {THREE.Quaternion} qAfter the live quaternion
   */
  _billSlewStep(p, qBefore, qAfter, dt) {
    if (qBefore.equals(qAfter)) return;                       // nothing moved (deadzone): the stop bill covers the end
    this._slewSteppedThisFrame = true;
    if (!(dt > 0)) return;
    if (typeof p._billTurnNullN2 !== 'function' || typeof p.getAttitudeInertia !== 'function') return;
    const dq = this._slewDq.copy(qBefore).invert().multiply(qAfter);
    const sinHalf = Math.hypot(dq.x, dq.y, dq.z);
    const w = this._slewW;
    if (sinHalf > 1e-12) {
      const ang = 2 * Math.atan2(sinHalf, Math.abs(dq.w));   // the short way round
      w.set(dq.x, dq.y, dq.z).multiplyScalar((dq.w < 0 ? -1 : 1) * ang / (sinHalf * dt));
    } else {
      w.set(0, 0, 0);
    }
    const I = p.getAttitudeInertia();
    const w0 = this._slewOmega;
    if (I) p._billTurnNullN2(I.ixx * Math.abs(w.x - w0.x), I.iyy * Math.abs(w.y - w0.y));
    w0.copy(w);
  }

  /**
   * The top of `update`. A frame with no slew step after one with a rate is the stop (a swing that ended in the deadzone, a path
   * dropped mid-swing, a scripted turn or aim taking the nose): bill I x |w0| and zero the rate. A held world is not a stop
   * (neither bills nor clears); the tail boxes taking over (empty tank) zero it unbilled: their twin works from rest.
   */
  _slewStopTick(p, dtWorld) {
    if (dtWorld <= 0) return;
    const stepped = this._slewSteppedThisFrame;
    this._slewSteppedThisFrame = false;
    if (!stepped) this._slewLatch = null;       // no slew step = the slew's stop: the next one chooses afresh
    const w0 = this._slewOmega;
    if (stepped || w0.lengthSq() === 0) return;
    const bill = this._slowGeneric(p) === null
      && typeof p._billTurnNullN2 === 'function' && typeof p.getAttitudeInertia === 'function';
    if (bill) {
      const I = p.getAttitudeInertia();
      if (I) p._billTurnNullN2(I.ixx * Math.abs(w0.x), I.iyy * Math.abs(w0.y));
    }
    w0.set(0, 0, 0);
  }

  /**
   * The slow turn's rate (`_tripOmega`) is a real spin. When the nose changes hands to a direct writer (an aim, a scripted turn,
   * a reel-in hold) or the boxes stop being the source, the brake that spin still needs is billed on the boxes (lit time: battery,
   * engine gas), as `_billAimTail` does for an aim, not dropped for free.
   */
  _slothBrakeBill(p) {
    const w = this._tripOmega || 0;
    this._tripOmega = 0;
    if (!(w > 0) || !this._tripAxis) return;
    const nx = this._tripAxis.x, ny = this._tripAxis.y;
    if (this._tripSrc === 'wheels' && !(typeof p.wheelsUsable === 'function' && p.wheelsUsable())) {
      // a wheel-made rate whose wheels cannot brake it (no power): the gas pays, at the real price
      if (typeof p._billTurnNullN2 === 'function' && typeof p.getAttitudeInertia === 'function') {
        const I = p.getAttitudeInertia();
        if (I) p._billTurnNullN2(I.ixx * Math.abs(nx * w), I.iyy * Math.abs(ny * w));
      }
      return;
    }
    this._slothTripBrake(p, w, nx, ny, this._tripSrc || 'tailBoxes');
  }

  /**
   * A slow turn on the tail boxes (`_tripOmega`, about the body axis `_tripAxis`) is a real spin. When an aim, a scripted turn or
   * a reel-in hold takes the nose, those write the attitude themselves, so the spin cannot live in the player's rate (the AIM
   * owner zeroes it every frame); it lives here: each frame she still turns on it (nose moves by rate x dt) and the boxes brake
   * it at their real α (lit time: battery and engine gas). The incoming controller waits until she is at rest (`true` = it must
   * not tick this frame), then starts from her present attitude. When the boxes cannot push (no power, no engine gas) she drifts
   * on the rate and the controller is not held up: it does nothing without the boxes either. When the boxes are not the source
   * any more (the gas is back) the brake is billed and the free cold-gas law takes the nose (`_slothBrakeBill`).
   * @param {number} dtWorld world seconds (0 = a held world)
   * @returns {boolean} true while the incoming controller has to wait for her to come to rest
   */
  _slothCarryTick(p, dt, dtWorld) {
    const w = this._tripOmega || 0;
    if (!(w > 0)) return false;
    const direct = !!(this._aimCoroutine || this._turn || this._attitudeHold);
    if (!direct) {
      // nobody took the nose. A running follow / trip hold carries the rate in its own law; with none, she keeps it
      if (!this._engaged && !(this._tripHold && this._tripTurn)) this._tripLetGo(p);
      return false;
    }
    if (!this._tripAxis || !this._tripSourceOn(p)) { this._slothBrakeBill(p); return false; }
    const src = this._tripSrc || 'tailBoxes';
    // A wheel-made rate whose wheels have no power (battery empty) is the GAS's to brake, as the player path brakes the same spin
    // (cold servo): billed at the real price (`_slothBrakeBill`), the rate ends. With no gas either nothing can brake her: she
    // coasts on below.
    if (src === 'wheels' && typeof p.wheelsUsable === 'function' && !p.wheelsUsable()
        && (p.resources ? p.resources.coldGas || 0 : 0) > (typeof p.slothGasDustPool === 'function' ? p.slothGasDustPool() : 0)) {
      this._slothBrakeBill(p);
      return false;
    }
    const canPush = !this._slothWhyBlocked(p, src);
    if (dtWorld <= 0 || !(dt > 0)) return canPush;                // a held world pauses her turn and the brake
    const nx = this._tripAxis.x, ny = this._tripAxis.y;
    const { aFull, mx, my } = this._slothTripAccel(p, nx, ny, src);
    let now = w;
    if (canPush && aFull > 0) {
      const f = slowPeek(p, src, mx + my, dt);                    // boxes: asking starts the warm-up; 0 until warm
      now = Math.max(0, w - aFull * f * dt);
      if (now < w) this._slothTripBrake(p, w - now, nx, ny, src); // the source's lit time for this frame's drop in rate
    }
    const spin = this._aimBm.set(nx * w, ny * w, 0);              // she turned on the old rate and the new one: the mean over the frame
    const rate = spin.length() * (0.5 * (w + now) / w);
    if (rate > 0) {
      this._aimDeltaQuat.setFromAxisAngle(spin.normalize(), rate * dt);
      p.quaternion.multiply(this._aimDeltaQuat).normalize();
    }
    this._tripOmega = now;
    return canPush && now > 0;
  }

  /** End the autopilot's own orbit-frame hold (the attitude stays where it is). Idempotent. */
  _dropFrameHold() {
    if (!this._apFrameHold) return;
    this._apFrameHold = false;
    const p = this._player;
    if (p && typeof p.setOrbitFrameHold === 'function') p.setOrbitFrameHold(false);
  }

  /**
   * Best heading by priority: 0. Field-Assay cluster  1. Selected target  2. Trawl cluster  3. Nearest large debris  4. Prograde
   * @returns {{ position: THREE.Vector3|null, mode: string }|null}
   */
  _determineHeading() {
    if (this._debrisMapCluster?.center) {
      // A committed InsertionPlanner arrival point (engageCluster opts) overrides the cluster CENTER as the rendezvous position;
      // absent, the heading is the cluster center (pinned in test-AutopilotSystem.js).
      const c = this._clusterArrivalPoint || this._debrisMapCluster.center;
      return {
        position: new THREE.Vector3(c.x, c.y, c.z),
        mode: 'CLUSTER',
      };
    }

    if (this._targetSelector) {
      const target = this._targetSelector.getActiveTarget();
      if (target && target.alive && target.orbit) {
        // One resolver for the heading position too: a pinned piece reads its _scenePosition (the mesh), a free piece its live orbit
        // (a pinned piece's frozen orbit would put the heading hundreds of km behind the ship).
        if (this._targetSceneState(target, this._tmpAPCartPos, this._tmpAPCartVel)) {
          const p = this._tmpAPCartPos;
          return {
            position: new THREE.Vector3(p.x, p.y, p.z),
            mode: 'TARGET',
          };
        }
      }
    }

    if (this._trawlManager && this._trawlManager.active && this._trawlManager.activeCluster) {
      const cluster = this._trawlManager.activeCluster;
      if (cluster.center) {
        return {
          position: new THREE.Vector3(cluster.center.x, cluster.center.y, cluster.center.z),
          mode: 'TRAWL',
        };
      }
    }

    if (this._debrisScanTimer >= DEBRIS_SCAN_INTERVAL || !this._cachedDebrisResult) {
      this._debrisScanTimer = 0;
      this._cachedDebrisResult = this._findNearestLargeDebris();
    }
    if (this._cachedDebrisResult) {
      return { position: this._cachedDebrisResult.pos, mode: 'DEBRIS' };
    }

    return { position: null, mode: 'PROGRADE' };
  }

  _getTargetLabel() {
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t) return t.type || 'TARGET';
    }
    return this._headingMode;
  }

  /**
   * Nearest alive debris with mass ≥ minMassKg (default LARGE_DEBRIS_MASS), via the shared pure helper `findNearestLiveDebris`
   * (js/systems/NavRecoveryAdvisor.js).
   * @param {number} [minMassKg=LARGE_DEBRIS_MASS]
   * @returns {{ pos: THREE.Vector3, orbit: object, id: (number|string|null), debris: object }|null}
   */
  _findNearestLargeDebris(minMassKg = LARGE_DEBRIS_MASS) {
    if (!this._debrisField || !this._debrisField.debrisList) return null;
    const playerPos = this._player.getPosition();
    const nearest = findNearestLiveDebris(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      this._debrisField.debrisList,
      minMassKg
    );
    if (!nearest) return null;
    const d = nearest.debris;
    return {
      pos: new THREE.Vector3(nearest.pos.x, nearest.pos.y, nearest.pos.z),
      orbit: d.orbit,
      id: d.id != null ? d.id : null,
      debris: d,
    };
  }

  /**
   * Nearest live piece of ANY mass that can still be caught. Skips what the target list and auto-lock skip: caught (`_captured`,
   * e.g. still on the rack), parked (`isChaseDone`), hazard shards. Undiscovered pieces count (N and A work before a scan).
   * Allocates a filtered list per call; A is a rare keypress.
   * @returns {{ pos: THREE.Vector3, orbit: object, id: (number|string|null), debris: object }|null}
   */
  _findNearestCatchableDebris() {
    if (!this._debrisField || !this._debrisField.debrisList) return null;
    const playerPos = this._player.getPosition();
    const catchable = this._debrisField.debrisList.filter(
      (d) => d && !d._captured && !d.hazard && !isChaseDone(d)
    );
    const nearest = findNearestLiveDebris(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      catchable,
      0
    );
    if (!nearest) return null;
    const d = nearest.debris;
    return {
      pos: new THREE.Vector3(nearest.pos.x, nearest.pos.y, nearest.pos.z),
      orbit: d.orbit,
      id: d.id != null ? d.id : null,
      debris: d,
    };
  }

  /** Emit LOCK/UNLOCK for the debris id the autopilot is locked onto, so CollisionAvoidanceSystem can exempt it from dodging. */
  _refreshTargetLock() {
    const id = this._getCurrentLockId();
    if (id === this._lockedEmittedId) return;

    if (this._lockedEmittedId != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._lockedEmittedId });
    }
    this._lockedEmittedId = id;
    if (id != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: id });
    }
  }

  _releaseTargetLock() {
    if (this._lockedEmittedId == null) return;
    eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._lockedEmittedId });
    this._lockedEmittedId = null;
  }

  /** Current lock id (null if no single debris is being approached). */
  _getCurrentLockId() {
    if (this._lockedTargetRef && this._lockedTargetRef.alive) {
      return this._lockedTargetRef.id != null
        ? this._lockedTargetRef.id
        : (this._lockedTargetRef.debrisId != null ? this._lockedTargetRef.debrisId : null);
    }
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t) return t.id != null ? t.id : (t.debrisId != null ? t.debrisId : null);
    }
    if (this._headingMode === 'DEBRIS' && this._cachedDebrisResult) {
      return this._cachedDebrisResult.id;
    }
    return null;
  }

  /**
   * Rotate the ship toward a world-space direction by rate-limited slerp, with the same lookAt convention as
   * `PlayerSatellite._orientAlongVelocity` (radial-up). No PD controller: monotonic convergence, no oscillation.
   * @param {THREE.Vector3} worldDir normalized world-space direction
   * @param {number} [dtWorld] world seconds (0 = a held world; only the slow turn on the tail boxes reads it)
   */
  _rotateTowardWorld(worldDir, dt, dtWorld) {
    // With the steering gas out the nose goes to the heading at the tail boxes' α, not at AP_ROT_RATE for free (a held world
    // pauses it, like the trip hold); likewise a slew the wheels can finish in AIM_TIMEOUT_S (`_slewSource`, latched to the slew's
    // stop). The choke point for every caller of this slew.
    let src = null;
    if (typeof this._player.attitudeTorqueSource === 'function') {
      const wg = this._worldTurnGeom(this._player, worldDir);
      src = this._slewSource(this._player, wg.err, wg.nx, wg.ny);
    }
    if (src) {
      if (!(dtWorld <= 0) && !this._turn) this._slothSteerWorld(this._player, worldDir, dt, src);   // (a scripted turn owns the nose)
      return;
    }
    if (this._tripOmega > 0) this._slothBrakeBill(this._player);
    const pos = this._player.getPosition();
    const radial = this._rotRadial.copy(pos).normalize();

    // lookAt: eye=pos+dir, target=pos → +Z = worldDir (model +Z = forward).
    this._rotMat.lookAt(this._rotEye.copy(pos).add(worldDir), pos, radial);
    const targetQuat = this._rotQuat.setFromRotationMatrix(this._rotMat);

    const angle = this._player.quaternion.angleTo(targetQuat);
    if (angle < AP_ROT_DEADZONE) return;

    const maxAngle = AP_ROT_RATE * dt;
    const alpha = Math.min(maxAngle / angle, 1.0);
    this._slewQ0.copy(this._player.quaternion);                        // the world slew is billed (`_billSlewStep`)
    this._player.quaternion.slerp(targetQuat, alpha);
    this._billSlewStep(this._player, this._slewQ0, this._player.quaternion, dt);
  }

  /**
   * Tool-aware trailing distance (metres):
   *   lasso   → D_TRAIL_LASSO
   *   spinner → D_TRAIL_ARMS
   *   weaver  → D_TRAIL_ARMS
   *   trawl   → D_TRAIL_TRAWL
   *   mother  → D_TRAIL_NET (20 m, inside the Large Net sure-shot band)
   *   default → D_TRAIL_DEFAULT
   */
  _getTrailDistance() {
    const AP = Constants.AUTOPILOT;
    const tool = this._targetSelector ? this._targetSelector._recommendedTool : null;
    switch (tool) {
      case 'lasso':   return AP.D_TRAIL_LASSO;
      case 'spinner': return AP.D_TRAIL_ARMS;
      case 'weaver':  return AP.D_TRAIL_ARMS;
      case 'trawl':   return AP.D_TRAIL_TRAWL;
      case 'mother':  return AP.D_TRAIL_NET;
      default:        return AP.D_TRAIL_DEFAULT;
    }
  }

  /**
   * Remaining ΔV (m/s) from the ArmManager mass budget, with a fallback from the player's resources through the same formula
   * (engineDeltaV).
   */
  _getRemainingDeltaV() {
    if (this._armManager) {
      try {
        return this._armManager.getMassBudget().deltaV;
      } catch (_) { /* fall through */ }
    }
    if (!this._player) return 0;
    // No mass budget wired (headless/mock): the SAME shared formula over the player's resources: the gas in the tank (its Isp),
    // core + tank dry mass, cold gas carried.
    const r = this._player.resources || {};
    const fuel = Constants.FUELS[r.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    const c = typeof this._player.getConsumptionMultiplier === 'function'
      ? this._player.getConsumptionMultiplier() : 1;
    return engineDeltaV({
      dryKg: Constants.OCTOPUS_V5.CORE_DRY_MASS + engineTankDryKg(r),
      coldGasKg: coldGasPoolToKg(r.coldGas || 0),
      gasKg: engineGasKg(r),
      isp: fuel.isp,
      c,
    });
  }

  _setupListeners() {
    // The mother's nets, for the arrival line (DECISIONS §33 row 9): CaptureNetSystem owns the one count and announces it on every
    // change; a new game puts the full magazine back.
    eventBus.on(Events.NET_INVENTORY_CHANGED, (data) => {
      if (!data || data.source !== 'mother') return;
      if (Array.isArray(data.podMax)) {
        const cap = data.podMax.reduce((a, b) => a + (b || 0), 0);
        if (cap > 0) this._motherNetCap = cap;
      }
      if (Number.isFinite(data.motherNets)) this._motherNetsLeft = data.motherNets;
    });
    eventBus.on(Events.GAME_RESET, () => { this._motherNetsLeft = this._motherNetCap; });

    // Attitude-hold across a lasso capture: HOLD the mother's orientation steady from the moment it fires (the aim-before-launch
    // has just put +Z on the debris) until the catch is stowed/lost. Steady, not active tracking: during reel-in the catch is pulled
    // to the ship's own nose (+Z), so "point at the catch" is circular and oscillates; holding keeps the tethered mass on the
    // launcher axis so it reels straight in instead of swinging into the fore sensors / ROSA panels. The hold suppresses the
    // prograde auto-orient (_orientAlongVelocity via player.aimHold) and `_rotateTowardWorld` (guarded on `_attitudeHold`).
    eventBus.on(Events.LASSO_FIRED, () => this.holdAttitude());
    const endHold = () => this.releaseAttitudeHold({ ifUnowned: true });
    eventBus.on(Events.LASSO_STOWED, endHold);
    eventBus.on(Events.LASSO_SNAPPED, endHold);
    eventBus.on(Events.LASSO_MISSED, endHold);
    eventBus.on(Events.LASSO_DENIED, endHold);

    // Mother-net attitude hold: mirrors the lasso wiring, mother-only (podIndex ≥ 0), with the dedicated net timeout (flight + reel
    // + berth, not the shared 30 s AIM_TIMEOUT_S). The hold is a FREEZE; manual rotation stays available by design.
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.podIndex >= 0) this.holdAttitudeForNet();
    });
    const endNetHold = (data) => {
      if (data && data.podIndex >= 0) this.releaseAttitudeHold({ ifUnowned: true });
    };
    eventBus.on(Events.NET_CATCH_MISS, endNetHold);
    eventBus.on(Events.NET_RELEASED, endNetHold);
    eventBus.on(Events.NET_BERTHED, endNetHold);
    // NET_FAILED / TETHER_SNAP are ArmUnit-only emitters: subscribed defensively, never relied on for mother cleanup.
    eventBus.on(Events.NET_FAILED, endNetHold);
    eventBus.on(Events.TETHER_SNAP, endNetHold);

    // A picked piece / daughter starts the wheels turning her toward the shot; a cleared piece, a deselected daughter, an arrow key
    // or a new game ends it. (Firing, the autopilot, a scripted turn, the leash: `_preturnGuard`.)
    eventBus.on(Events.TARGET_SELECTED, (d) => this._onPreturnTrigger('target', d));
    eventBus.on(Events.ARM_SELECT, (d) => this._onPreturnTrigger('arm', d));
    eventBus.on(Events.TARGET_CLEARED, () => this._preturnDrop('piece cleared'));
    eventBus.on(Events.ARM_DESELECT, () => this._preturnDrop('daughter deselected'));
    eventBus.on(Events.MOTHER_MANUAL_ROTATE, () => this._preturnDrop('arrow key'));
    eventBus.on(Events.GAME_RESET, () => { this._preturnDrop('new game'); this._preturnSaid = null; this._pairOffer = null; this._pairSaid = null; this._pairSingle = null; this._pairSearch = null; this._pairDirty = true; });
    // a pick or a cleared pick looks the pair offer up again next frame
    for (const ev of [Events.TARGET_SELECTED, Events.TARGET_CLEARED, Events.ARM_SELECT, Events.ARM_DESELECT]) eventBus.on(ev, () => { this._pairDirty = true; });
    // The Mission 2 coach beat starts the pair-lesson setup; its end (satisfied, skipped, new game) drops it; a double shot says its gas
    eventBus.on(Events.MISSION_BEAT_STARTED, (d) => { if (d && d.beatId === 'ch2_pair_shot') this._lessonBegin(); });
    eventBus.on(Events.MISSION_BEAT_SATISFIED, (d) => { if (d && d.beatId === 'ch2_pair_shot') this._lessonEnd(); });
    eventBus.on(Events.GAME_RESET, () => { this._lessonEnd(); this._pairSaving = null; });
    eventBus.on(Events.DUAL_FIRE, (d) => this._onDualFire(d));

    // Conjunction warning (tier ≥ 2) → auto-disengage (CA overrides AP)
    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      if (this._engaged && data && data.tier >= 2) {
        this.disengage('COLLISION');
      }
    });

    // Trawl awareness: block autopilot during active sweeps (real cluster starts only, not plain command events).
    eventBus.on(Events.TRAWL_START, (data) => {
      if (!data || !data.cluster) return;
      this._trawlActive = true;
      if (this._engaged) {
        this.disengage('TRAWL');
      }
    });

    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => {
      this._trawlActive = false;
      this._trawlAbortArmed = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Press A to autopilot to next target cluster.',
        priority: 'info',
      });
    });

    eventBus.on(Events.LASSO_FIRED, (data) => {
      this._applyRecoilCompensation(data);
    });

    eventBus.on(Events.CROSSBOW_FIRE, (data) => {
      this._applyRecoilCompensation(data);
    });

    eventBus.on(Events.TRAWL_START, (data) => {
      this._applyTrawlRecoilCompensation(data);
    });

    // "Release arrows" coaching: while AP is engaged, arrow-key input disengages by design (see InputManager) and new pilots fight
    // that by mashing arrows. 3 arrow events within a 2 s rolling window emit a one-shot COMMS warning; reset on AP disengage.
    this._arrowInterferenceCount = 0;
    this._arrowInterferenceFirstAt = 0;
    this._warnedAboutArrows = false;
    eventBus.on(Events.TUTORIAL_ARROW_INPUT, () => {
      if (!this._engaged) return;
      const now = Date.now();
      if (now - (this._arrowInterferenceFirstAt || 0) > 2000) {
        this._arrowInterferenceFirstAt = now;
        this._arrowInterferenceCount = 1;
        return;
      }
      this._arrowInterferenceCount++;
      if (this._arrowInterferenceCount >= 3 && !this._warnedAboutArrows) {
        this._warnedAboutArrows = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'SPACECRAFT', channel: 'CMD', priority: 'warning',
          text: 'Release arrow keys. Autopilot has control.',
        });
      }
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._arrowInterferenceCount = 0;
      this._arrowInterferenceFirstAt = 0;
      this._warnedAboutArrows = false;
    });

  }

  /** Total ΔV spent on station-keeping recoil compensation this session (m/s), for Field-Assay MFD reporting. */
  getStationKeepDeltaV() { return this._stationKeepDeltaV || 0; }

  /**
   * Apply the opposite impulse to compensate for tool firing while in HOLD, by momentum conservation:
   * ΔV_player = −(m_proj × v_proj / m_player) × η
   * @param {object} data event payload with projectileMass/armMass, launchDirection, speed
   */
  _applyRecoilCompensation(data) {
    const AP = Constants.AUTOPILOT;
    if (!AP.STATION_KEEP_COMPENSATION) return;
    if (this._phase !== PHASE.HOLD) return;
    if (!this._player) return;

    let projMass, projSpeed, launchDir;

    if (data.projectileMass && data.launchDirection && data.speed) {
      // LASSO_FIRED payload
      projMass = data.projectileMass;
      projSpeed = data.speed;
      launchDir = data.launchDirection;
    } else if (data.armMass && data.launchDirection && data.speed) {
      // CROSSBOW_FIRE payload
      projMass = data.armMass;
      projSpeed = data.speed;
      launchDir = data.launchDirection;
    } else {
      return;
    }

    if (!launchDir || typeof projMass !== 'number' || typeof projSpeed !== 'number') return;

    const playerMass = this._player.mass || 130;
    const dvMagnitude = (projMass * projSpeed) / playerMass;

    const reactionDv = new THREE.Vector3()
      .copy(launchDir)
      .normalize()
      .negate()
      .multiplyScalar(dvMagnitude * AP.STATION_KEEP_EFFICIENCY);

    // dt = 0: instantaneous compensation, not continuous thrust. Draws no power but pays for its gas; the engine applies
    // thrustScale of it.
    this._player.applyCartesianImpulse(reactionDv, 0);

    // cumulative ΔV the engine actually applied (MFD reporting)
    this._stationKeepDeltaV = (this._stationKeepDeltaV || 0)
      + dvMagnitude * AP.STATION_KEEP_EFFICIENCY * this._engineThrustScale();
  }

  /** Recoil compensation for trawl net deployment: the net deploys slowly, so a smaller single-pulse approximation. */
  _applyTrawlRecoilCompensation(data) {
    const AP = Constants.AUTOPILOT;
    if (!AP.STATION_KEEP_COMPENSATION) return;
    if (this._phase !== PHASE.HOLD) return;
    if (!this._player) return;

    const netMass = Constants.TRAWLING?.NET_MASS || 5;
    const deploySpeed = Constants.TRAWLING?.DEPLOY_SPEED || 2;
    const playerMass = this._player.mass || 130;
    const dvMag = (netMass * deploySpeed) / playerMass;

    const dir = new THREE.Vector3();
    if (this._player.mesh) {
      this._player.mesh.getWorldDirection(dir);
    } else if (this._player.getForwardVector) {
      dir.copy(this._player.getForwardVector());
    } else {
      dir.set(0, 0, 1).applyQuaternion(this._player.quaternion);
    }
    dir.negate().multiplyScalar(dvMag * AP.STATION_KEEP_EFFICIENCY);

    this._player.applyCartesianImpulse(dir, 0);   // dt = 0: billed for gas, not power
    this._stationKeepDeltaV = (this._stationKeepDeltaV || 0)
      + dvMag * AP.STATION_KEEP_EFFICIENCY * this._engineThrustScale();
  }

  /**
   * Aim-before-launch: rotate the Mother (and, for daughter mode, slew the chosen strut pair) so the physical launcher axis points
   * at the target, then resolve so the caller can fire along the ACTUAL attitude.
   * Modes:
   *   'net'      - align ship +Z with the lead-intercept direction; tight tolerance (NET_AIM_TOLERANCE_DEG), the net cannot steer.
   *   'daughter' - align the physical strut fire direction of the chosen arm with the target and concurrently slew α; loose
   *                tolerance (DAUGHTER_AIM_TOLERANCE_DEG), TRANSIT FEEP corrects the residual.
   * Attitude is driven by slerping this._player.quaternion toward a minimal-arc target quaternion (same 3-DOF authority as
   * `_rotateTowardWorld`) while plumes + N₂ draw are fired through the manual RCS path for feel.
   *
   * @param {(function():{x,y,z}|null)|{x,y,z}} dirProvider callback returning the current WORLD aim direction (recomputed per tick
   *   so it tracks a moving target), or a static world dir object
   * @param {object} [opts]
   * @param {'net'|'daughter'} [opts.mode='net']
   * @param {import('../entities/ArmManager.js').ArmManager} [opts.armManager]
   * @param {import('../entities/ArmUnit.js').ArmUnit} [opts.arm] daughter arm (for α slew)
   * @param {number} [opts.pairIndex] chosen pair primary index (daughter)
   * @param {{x,y,z}} [opts.aimDir] net mode: the aim direction the caller has JUST read from its provider; the wrap check uses it
   *   instead of reading the provider again (a stateful provider must not get an extra sample)
   * @returns {Promise<{ mode:string, launchDir:{x,y,z} }>}
   */
  requestAimRotation(dirProvider, opts = {}) {
    if (!Constants.FEATURE_FLAGS.SEMI_AUTO_AIM) {
      return Promise.reject(new Error('SEMI_AUTO_AIM feature flag is disabled.'));
    }
    if (!this._player) {
      return Promise.reject(new Error('AutopilotSystem not initialized (no player).'));
    }

    const mode = opts.mode === 'daughter' ? 'daughter' : 'net';
    const provider = (typeof dirProvider === 'function')
      ? dirProvider
      : () => dirProvider;

    // A daughter out on her line limits how far the mother may turn. ArmManager checks this before it asks (the launch then aims
    // the strut alone); this is the backstop for any other caller.
    if (mode === 'daughter') {
      const am = opts.armManager || this._armManager;
      const tier = (am && typeof am.getRotationLockTier === 'function') ? am.getRotationLockTier() : 'none';
      if (tier !== 'none') {
        const reason = 'a daughter is out on her line';
        eventBus.emit(Events.COMMS_MESSAGE, { text: `Launch aborted — ${reason}.`, priority: 'warning', source: 'HOUSTON' });
        return Promise.reject(new Error(reason));
      }
    }

    // owner 2026-10-23: a net aim turns the mother with a daughter out on her line (the arrow keys have their own limit). Refused
    // only when the attitude the aim leads to would run her line through the ship. InputManager's fireMotherNet asks the same
    // question first (with its own sound); this is the backstop for every other net aim.
    if (mode === 'net') {
      const am = opts.armManager || this._armManager;
      if (am && typeof am.netTurnWraps === 'function') {
        // The caller's provider can be stateful (the large net's lead-aim smooths the relative velocity with an EMA on every call), so
        // an extra read here would shift the aim: callers pass the direction they just read as `aimDir`; only a caller that does not
        // asks the provider (once).
        const dir = opts.aimDir || provider();
        const wrap = dir ? am.netTurnWraps(dir) : null;
        if (wrap && wrap.wraps) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: wrapRefusalLine((wrap.arm && wrap.arm.displayName) || 'A daughter'), priority: 'warning', source: 'HOUSTON',
          });
          const err = new Error('a daughter\'s line would wrap the ship');
          err.code = 'LINE_WRAP';
          return Promise.reject(err);
        }
      }
    }

    if (this._aimCoroutine) {
      this._rejectAim('Superseded by new aim request', 'SUPERSEDED');
    }
    if (this._turn) this._rejectTurn('Superseded by aim request');
    // ends the wheel pre-turn: its rate is braked on the wheels (billed); this aim starts from where she got to
    if (this._preturn) this._endPreturn('fire');

    const AIM = Constants.AIM;
    const tolRad = degToRad(mode === 'net' ? AIM.NET_AIM_TOLERANCE_DEG : AIM.DAUGHTER_AIM_TOLERANCE_DEG);
    const rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);

    // Sloth mode: the tank cannot pay for a turn, so the aim turns her on the tail boxes (minutes, not seconds). The source is
    // chosen once, here, by the player's selector. A caller with its own time limit passes `maxWaitS`: a slow turn longer than that
    // is refused at once with the honest time (nothing moves, nothing is billed).
    // Reaction wheels (the kit): the selector also gets the angle and the caller's limit (`maxWaitS`, else the aim's own 30 s): with
    // gas, the wheels take an aim they can finish inside it (0 gas, battery) and the gas takes the rest; with the gas out the wheels
    // take every aim (the boxes when they are full), and `maxWaitS` refuses a too-slow one as for the boxes.
    const slowAimSrc = { src: null };
    let slothEstS = 0, lineS = 0;
    const aimLimitS = Number.isFinite(opts.maxWaitS) ? opts.maxWaitS : AIM.AIM_TIMEOUT_S;   // the time the wheels must finish a net aim in
    // The geometry is read only when it can change the answer (sloth mode, or a ship with the kit): a stateful provider must be
    // read once per aim.
    const kitAboard = typeof this._player.hasWheelKit === 'function' && this._player.hasWheelKit();
    const slothAtStart = typeof this._player.isSlothMode === 'function' && this._player.isSlothMode();
    // Chest shot (DECISIONS §38 row 5): a daughter aim picks the strut angle of the cheaper shot (today's angle or the chest angle,
    // and with the kit a scan of the others) before anything is said or turned. Null: a stub without the geometry.
    // `opts.pair` = two opposite daughters aimed together at one strut angle; her barrel (+z) is the boresight and the provider
    // names the barrel direction (`_planPairShot`). A pair that cannot be planned is not started.
    const pair = (mode === 'daughter' && opts.pair) ? opts.pair : null;
    const shot = mode === 'daughter'
      ? (pair ? this._planPairShot(provider, opts, aimLimitS, tolRad, rate) : this._planDaughterShot(provider, opts, aimLimitS, tolRad, rate))
      : null;
    if (pair && !shot) return Promise.reject(Object.assign(new Error('the pair shot cannot be planned'), { code: 'OTHER' }));
    if (pair) this._pairSaving = this._pairSavingNow(opts);          // the gas of this pair and of the two singles it replaces, from the attitude now
    if (this._player.attitudeTorqueSource && (kitAboard || slothAtStart)) {
      const p = this._player;
      const dir = opts.aimDir || provider();
      const nose = this._aimBm.set(0, 0, 1).applyQuaternion(p.quaternion).normalize();
      const dv = dir ? this._aimTargetDir.set(dir.x, dir.y, dir.z) : null;
      let errAng = 0, nx = 1, ny = 0;
      if (dv && dv.lengthSq() > 1e-12) {
        dv.normalize();
        errAng = Math.acos(Math.max(-1, Math.min(1, nose.dot(dv))));
        const ax = this._aimErrAxis.crossVectors(nose, dv);
        if (ax.lengthSq() > 1e-12) { ax.applyQuaternion(this._aimInvQuat.copy(p.quaternion).invert()).normalize(); nx = ax.x; ny = ax.y; }
      }
      // the chosen shot's own boresight (the strut at its chosen angle), not the ship's nose: the turn the wheels must make is that one
      if (shot) { errAng = shot.errRad; nx = shot.nx; ny = shot.ny; }
      // A target already inside the aim tolerance needs no turn: no warm-up estimate, no refusal, no cathodes lit (`_tickAimEased`
      // resolves it on its first frame without asking the boxes).
      const turnRad = errAng > tolRad ? errAng - 0.5 * tolRad : 0;
      const sloth = slothAtStart;
      if (sloth || turnRad > 0) {
        const sel = p.attitudeTorqueSource({ spinUp: true, angleRad: turnRad, nx, ny, limitS: aimLimitS, losRateRadS: opts.losRateRadS });
        if (isSlowSrc(sel)) slowAimSrc.src = sel;
      }
      const src = slowAimSrc.src;
      if (src) {
        slothEstS = turnRad > 0 ? slowTurnTimeS(p, src, turnRad, nx, ny) + slowWarmupLeftS(p, src) : 0;
        // The seconds the line says are the shot's own (the wheel law run with the strut's inertia as it swings out): the rest-to-rest
        // figure at today's inertia undercounts. `slothEstS` stays that figure (the selector's 30 s test, the watch's limit); the line
        // and the hand-over deadline use the longer of the two.
        if (shot && src === 'wheels' && shot.src === 'wheels' && turnRad > 0 && Number.isFinite(shot.timeS)) lineS = Math.max(slothEstS, shot.timeS);
        else lineS = slothEstS;
        if (sloth && Number.isFinite(opts.maxWaitS) && slothEstS > opts.maxWaitS) {
          const text = src === 'wheels'
            ? `Steering gas is empty and the reaction wheels need ${p.slothTimeWords(slothEstS)} to turn her that far: too slow for this.`
            : `Emergency steering — the tail boxes need ${p.slothTimeWords(slothEstS)} to turn her that far: too slow for this.`;
          eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'warning', source: 'HOUSTON' });
          const err = new Error('emergency steering — the turn is too slow');
          err.code = 'TOO_SLOW';
          return Promise.reject(err);
        }
      }
    }
    const slothAim = slowAimSrc.src !== null;

    return new Promise((resolve, reject) => {
      const onManualRotate = () => this._rejectAim('Manual attitude input', 'MANUAL');
      // TARGET_SELECTED = the player (or the auto-lock) picked another piece: a deliberate change.
      // TARGET_CLEARED is only emitted by TargetSelector.setTarget(null), and every caller of that is the target going away
      // (drifted/!alive, DEBRIS_REMOVED, capture/berth bookkeeping, game reset); there is no player "deselect", so it is a lost target.
      const onTargetChange = () => this._rejectAim('Target changed', 'TARGET_CHANGED');
      const onTargetGone = () => this._rejectAim('Target changed', 'TARGET_LOST');
      eventBus.on(Events.MOTHER_MANUAL_ROTATE, onManualRotate);
      eventBus.on(Events.TARGET_SELECTED, onTargetChange);
      eventBus.on(Events.TARGET_CLEARED, onTargetGone);

      this._player.aimHold = true;

      eventBus.emit(Events.AIM_SEQUENCE_START, { mode });
      if (slothAim) {
        // the honest time; nothing to say when the target is already inside the tolerance (the shot fires with no turn)
        if (slothEstS > 0) {
          // a daughter shot also says the gas of the launch kick (what the wheels cannot take) when it is a gram or more, and the quicker
          // other way when the gas line would name it
          const kick = shot && shot.kickKg * 1000 >= 1 ? `, then ${this._shotGasWords(shot.kickKg)} for the launch kick` : '';
          const quick = shot && shot.alt ? this._shotQuickWords(shot.alt) : '';
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: slowAimSrc.src === 'wheels'
              ? `Turning the ship on the reaction wheels (no steering gas used): ${this._player.slothTimeWords(lineS)}${kick}.${quick}`
              : `Emergency steering — turning slowly on the tail boxes: ${this._player.slothTimeWords(slothEstS)}${kick}.${quick}`,
            priority: slowAimSrc.src === 'wheels' ? 'info' : 'warning', source: 'HOUSTON',
            _keep: true,
          });
        }
      } else {
        // a daughter shot says what it will really take (seconds, grams of gas), not the worst case
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: shot ? this._shotAimLine(shot) : `Turning the ship to line up the launch. About ${Math.ceil(Math.PI / rate)} s at most.`,
          priority: 'info', source: 'HOUSTON',
          _keep: true,
        });
      }
      if (shot && shot.empties) this._sayWheelsEmpty();      // once per shot

      this._aimCoroutine = {
        mode, provider, tolRad, rate,
        stopErr: 0.5 * tolRad,     // the eased turn comes to rest this far from the target (inside tolRad)
        pT: null,                  // last frame's aim direction (a clone), for the target's turn rate
        inTolS: 0,                 // seconds inside the tolerance, strut done
        armManager: opts.armManager || this._armManager,
        arm: opts.arm || null,
        pairIndex: (opts.pairIndex != null) ? opts.pairIndex : null,
        shot,                      // the chosen shot (its strut angle, its estimate), null for a net aim or a stub
        pair,                      // `{armB, alpha, ...}` when two opposite daughters are aimed together, else null
        alphaF: shot ? shot.alpha : undefined,   // the strut angle her boresight is aimed for (`_tickAimEased` keeps it fixed for the aim)
        azRad: null,
        elapsed: 0,
        // a slow aim: twice its planned time + the cathodes' warm-up + a minute (the plain 30 s is for a gas turn)
        timeout: slothAim ? Math.max(AIM.AIM_TIMEOUT_S, 2 * slothEstS + Constants.SLOTH.AIM_SLACK_S) : AIM.AIM_TIMEOUT_S,
        sloth: slothAim,           // the slow eased law runs (the tail boxes or the wheels)
        src: slowAimSrc.src,       // 'tailBoxes' | 'wheels' | null (cold gas)
        estS: slothEstS,
        limitS: aimLimitS,         // the limit that planned time had to fit (the watch applies it to a drifting target's chase)
        handAt: Constants.WHEELS.AIM_HANDOVER_X * Math.max(slothEstS, lineS) + Constants.WHEELS.AIM_HANDOVER_S,   // a wheel aim not done by then goes to the gas
        wLos: 0,                   // the target bearing's whole turn rate (rad/s, smoothed); read only on the wheels
        wFf: 0,                    // the part of it along her error axis, away from her boresight (the feed-forward)
        losAt: -Infinity,          // c.elapsed of the last look at it
        _cleanup: () => {
          eventBus.off(Events.MOTHER_MANUAL_ROTATE, onManualRotate);
          eventBus.off(Events.TARGET_SELECTED, onTargetChange);
          eventBus.off(Events.TARGET_CLEARED, onTargetGone);
          // Preserve an active reel-in freeze — don't clobber its aimHold.
          if (this._player) this._player.aimHold = this._attitudeHold;
        },
        resolve, reject,
      };
    });
  }

  // CHEST SHOT (DECISIONS §38 row 5)

  /**
   * Pick the strut angle of a daughter shot before the aim starts. The launch line of a strut at angle α is
   * d(α) = (sinα·cos az, sinα·sin az, −cosα); the mother turns until it points at the target, then the spring kicks her about her
   * centre of mass without the daughter (L = r × (−m·v·d)). Two shots matter: today's (`bestStrutAlpha`: the strut swings so little
   * of the turn is left for her) and the CHEST shot (`chestStrutAlpha`: the line passes through her centre of mass, the kick is nil,
   * she turns the whole way). Each is priced as the aim will run it (the turn on the wheels inside the aim's limit, else on the gas,
   * by the same law as `_tickAimEased`) plus the kick (the wheels take what they can, `wheelKickPeek`; the rest is gas at the real
   * price); the cheaper in gas is taken (within TIE_FRAC / TIE_G the quicker). With the wheel kit and its fullest axis over
   * WHEEL_CREDIT_FRAC full (and only then) it also scans the strut's whole range (SCAN_STEP_DEG), keeps the angles whose kick
   * LOWERS that axis, and credits that kick at what the gas would cost to lower it (the coils empty it for free, but in hours);
   * `empties` (the comms line) says the credit changed the pick. Steering gas out (sloth mode): no gas to count, the quicker shot
   * wins. The player's selected daughter stays (no strut switching). Null when the geometry is not there (a stub player, no dock
   * position).
   * @param {Function} provider world aim direction
   * @param {object} opts the aim's options (`arm`, `armManager`, `pairIndex`)
   * @param {number} aimLimitS the time the wheels must finish in
   * @param {number} tolRad
   * @param {number} rate peak rate, rad/s
   * @returns {null|{alpha:number, kind:string, errRad:number, nx:number, ny:number, src:string|null, timeS:number, gasKg:number,
   *   aimKg:number, kickKg:number, creditKg:number, dropNms:number, empties:boolean, alt:null|{timeS:number, gasKg:number}}}
   */
  _planDaughterShot(provider, opts, aimLimitS, tolRad, rate) {
    const CS = Constants.CHEST_SHOT;
    const p = this._player;
    const arm = opts.arm, am = opts.armManager || this._armManager;
    if (!CS || CS.ENABLED === false || !p || !arm || !am || opts.pairIndex == null) return null;
    if (typeof arm.getAimAlpha !== 'function' || typeof arm.setAimAlpha !== 'function' || !am.arms || !this._aimCanEase()) return null;
    const dp = am._dockPositions && am._dockPositions[opts.pairIndex];
    if (!dp) return null;
    const raw = provider();
    if (!raw) return null;
    const Tb = new THREE.Vector3(raw.x, raw.y, raw.z);
    if (!(Tb.lengthSq() > 1e-12)) return null;
    Tb.normalize().applyQuaternion(new THREE.Quaternion().copy(p.quaternion).invert());   // the target in her body frame
    const V5 = Constants.OCTOPUS_V5;
    const lo = V5.STRUT_SWEEP_MIN, hi = V5.STRUT_SWEEP_MAX;
    const az = degToRad(dp.azimuthDeg);

    // her CoM without this daughter; only the strut's midpoint moves with alpha, so each angle is the same sum with that point moved
    const com = computeCoM(am, p, { excludeArm: arm });
    const a0 = arm.getAimAlpha();
    const mid0 = strutMidpointMeters(dp, a0);
    const kStrut = V5.STRUT_MASS / com.totalMass;
    const comAt = (alpha, out) => {
      const mid = strutMidpointMeters(dp, alpha);
      out.x = com.position.x + kStrut * (mid.x - mid0.x);
      out.y = com.position.y + kStrut * (mid.y - mid0.y);
      out.z = com.position.z + kStrut * (mid.z - mid0.z);
      return out;
    };
    const armsView = (alpha) => ({
      arms: am.arms.map((a) => (a === arm ? Object.assign(Object.create(a), { getAimAlpha: () => alpha }) : a)),
      _dockPositions: am._dockPositions,
    });
    const inertiaTable = (alpha) => {
      if (Math.abs(alpha - a0) < 1e-9) { const I = p.getAttitudeInertia(); return [{ ixx: I.ixx, iyy: I.iyy }]; }
      const tab = [];
      for (let j = 0; j <= 4; j++) {
        const I = computeInertia(armsView(a0 + (alpha - a0) * j / 4), p);
        tab.push({ ixx: I.ixx, iyy: I.iyy });
      }
      return tab;
    };
    const dir = new THREE.Vector3(), cm = { x: 0, y: 0, z: 0 }, per = { x: 0, y: 0 }, ax = new THREE.Vector3();
    const missAt = (alpha) => {
      strutLocalDirection(alpha, az, dir);
      const tip = strutTipMeters(dp, alpha);
      comAt(alpha, cm);
      const rx = tip.x - cm.x, ry = tip.y - cm.y, rz = tip.z - cm.z;
      return Math.hypot(ry * dir.z - rz * dir.y, rz * dir.x - rx * dir.z, rx * dir.y - ry * dir.x);
    };

    // what leaves with her, and how fast (ArmUnit `_applyLaunchImpulse`): the kick is m·v along her line
    const tier = Constants.SPRING_TIERS && Constants.SPRING_TIERS[arm.springTier];
    const speed = Math.min(Number.isFinite(arm.launchSpeed) ? arm.launchSpeed : Infinity, tier ? tier.maxSpeed : Infinity);
    const type = arm.config && arm.config.type;
    let massKg = type === 'weaver' ? Constants.V5_WEAVER_MASS : (type === 'spinner' ? Constants.V5_SPINNER_MASS : (arm.config && arm.config.mass));
    massKg += (arm.capturedDebris && arm.capturedDebris.mass) || 0;
    if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) massKg += (h && h.mass) || 0;
    const mv = (massKg > 0 && speed > 0 && Number.isFinite(speed)) ? massKg * speed : 0;

    const sloth = typeof p.isSlothMode === 'function' && p.isSlothMode();
    const kit = typeof p.hasWheelKit === 'function' && p.hasWheelKit();
    const tankKg = coldGasPoolToKg(Math.max(0, Number(p.resources && p.resources.coldGas) || 0));
    const Wc = Constants.WHEELS, Hm = Wc.MOMENTUM_NMS;
    const stopErr = 0.5 * tolRad;

    const evalAlpha = (alpha, kind) => {
      strutLocalDirection(alpha, az, dir);
      const errRad = Math.acos(Math.max(-1, Math.min(1, dir.dot(Tb))));
      ax.crossVectors(dir, Tb);
      let nx = 1, ny = 0;
      if (ax.lengthSq() > 1e-12) { ax.normalize(); nx = ax.x; ny = ax.y; }
      const tS = typeof arm.aimEaseMinTime === 'function'
        ? arm.aimEaseMinTime(alpha) : Math.abs(alpha - arm.getAimAlpha()) / V5.AIM_TURN_STRUT_PACE;
      const turnRad = errRad > tolRad ? errRad - stopErr : 0;
      let src = null;
      if (typeof p.attitudeTorqueSource === 'function' && (kit || sloth) && (sloth || turnRad > 0)) {
        const sel = p.attitudeTorqueSource({ spinUp: true, angleRad: turnRad, nx, ny, limitS: aimLimitS, quiet: true });
        if (isSlowSrc(sel)) src = sel;
      }
      let timeS, aimKg;
      if (src === 'wheels') {
        // the strut swinging out makes her heavier as she turns (the table): longer than the rest-to-rest figure at today's inertia
        timeS = Math.max(this._simGasAim({ err: errRad, nx, ny, table: inertiaTable(alpha), tS, stopErr, tolRad, rate, dStrut: Math.abs(alpha - a0), wheels: true }).timeS, tS);
        aimKg = 0;
      } else if (src) {
        timeS = Math.max(turnRad > 0 ? slowTurnTimeS(p, src, turnRad, nx, ny) + slowWarmupLeftS(p, src) : 0, tS);
        aimKg = 0;
      } else {
        const t = this._simGasAim({ err: errRad, nx, ny, table: inertiaTable(alpha), tS, stopErr, tolRad, rate, dStrut: Math.abs(alpha - a0) });
        timeS = t.timeS; aimKg = t.gasKg;
      }
      const tip = strutTipMeters(dp, alpha);
      comAt(alpha, cm);
      launchKickPerNs(tip, cm, dir, per);
      const lx = per.x * mv, ly = per.y * mv;
      let kickKg = 0, creditKg = 0, dropNms = 0;
      if (Math.abs(lx) + Math.abs(ly) > 1e-6) {
        const peek = kit ? p.wheelKickPeek(lx, ly) : null;
        const left = peek || { x: lx, y: ly };
        if (Math.abs(left.x) + Math.abs(left.y) > 1e-6) kickKg = p.turnNullKg(left.x, left.y);
        if (peek && p._wheelH) {
          const hx = Math.abs(p._wheelH.x), hy = Math.abs(p._wheelH.y);
          const onX = hx >= hy, h = onX ? p._wheelH.x : p._wheelH.y, took = onX ? peek.tx : peek.ty;
          if (Math.abs(h) > CS.WHEEL_CREDIT_FRAC * Hm) {
            const drop = Math.abs(h) - Math.abs(h + took);
            if (drop > 1e-6) { dropNms = drop; creditKg = drop * (onX ? p.turnNullKg(1, 0) : p.turnNullKg(0, 1)); }
          }
        }
      }
      const gasKg = aimKg + kickKg;
      return { alpha, kind, errRad, nx, ny, src, timeS, aimKg, kickKg, gasKg, creditKg, dropNms, cost: sloth ? timeS : gasKg - creditKg };
    };

    const aToday = bestStrutAlpha(Tb, az);
    const aChest = chestStrutAlpha(missAt, lo, hi);
    const cands = [evalAlpha(aToday, 'today')];
    const have = (a) => cands.some((c) => Math.abs(c.alpha - a) < degToRad(0.25));
    if (!have(aChest)) cands.push(evalAlpha(aChest, 'chest'));
    else cands.find((c) => Math.abs(c.alpha - aChest) < degToRad(0.25)).kind = 'chest';
    // owner: "a single only if its kick empties the wheels": scan only with the fullest wheel axis over WHEEL_CREDIT_FRAC
    // full, keeping the angles whose kick LOWERS that axis (they carry the credit).
    const hFull = (kit && p._wheelH) ? Math.max(Math.abs(p._wheelH.x), Math.abs(p._wheelH.y)) : 0;
    if (kit && CS.SCAN_STEP_DEG > 0 && hFull > CS.WHEEL_CREDIT_FRAC * Hm) {
      for (let a = lo; a <= hi + 1e-9; a += degToRad(CS.SCAN_STEP_DEG)) {
        const al = Math.min(a, hi);
        if (have(al)) continue;
        const c = evalAlpha(al, 'scan');
        if (c.creditKg > 0) cands.push(c);
      }
    }
    const choose = (costOf) => {
      let b = cands[0];
      for (const c of cands) {
        const tie = Math.max(CS.TIE_FRAC * Math.min(Math.abs(costOf(c)), Math.abs(costOf(b))), sloth ? 0.5 : CS.TIE_G / 1000);
        if (Math.abs(costOf(c) - costOf(b)) <= tie) { if (c.timeS < b.timeS) b = c; }
        else if (costOf(c) < costOf(b)) b = c;
      }
      return b;
    };
    const best = choose((c) => c.cost);
    // "also empties the wheels" only when that is why it was picked (the credit changed the winner) and the fullest
    // axis really ends at least EMPTIES_SAY_NMS lower
    const plain = choose((c) => (sloth ? c.timeS : c.gasKg));
    const empties = best !== plain && best.dropNms >= CS.EMPTIES_SAY_NMS;
    const named = cands.filter((c) => c !== best && (c.kind === 'today' || c.kind === 'chest'));
    named.sort((a, b) => a.timeS - b.timeS);
    const other = named[0] || null;
    const quick = other && other.timeS < best.timeS - 0.5
      && Math.abs(other.gasKg - best.gasKg) > CS.QUICK_FRAC * Math.max(best.gasKg, 0.001)
      ? { timeS: other.timeS, gasKg: other.gasKg } : null;
    const kickGas = Math.min(best.kickKg, tankKg);
    return {
      alpha: best.alpha, kind: best.kind, errRad: best.errRad, nx: best.nx, ny: best.ny, src: best.src,
      timeS: best.timeS, aimKg: best.aimKg, kickKg: kickGas, gasKg: Math.min(best.aimKg + best.kickKg, tankKg),
      creditKg: best.creditKg, dropNms: best.dropNms, empties, alt: quick,
      alphaToday: aToday, alphaChest: aChest,                          // the two named angles (rad), for the report and the tests
    };
  }

  // PAIR SHOT (owner 2026-10-25 "2 a"; DECISIONS §38 row 5)
  // Two daughters of one type leave in the same frame at the same strut angle, so their kicks cancel (no turning kick, no gas
  // for it). With a daughter and a piece picked, the game looks for a SECOND piece her opposite partner could take in the same
  // launch; within PAIR_SHOT's limits the second piece is marked, Comms says so once, and Q (or the touch button) fires both.

  /** @returns {object|null} the pair offered now (`{armA, armB, t1, t2, tA, tB, alpha, n, missA, missB, turnDeg, fuelG, gasKg, key, markId}`), or null */
  getPairOffer() {
    const o = this._pairOffer;
    if (!o) return null;
    // a look under way takes a few frames: the standing offer is not shown (nor fired by Q) for a pick that has changed
    const ts = this._targetSelector, am = this._armManager;
    if (this._pairSearch && ts && typeof ts.getActiveTarget === 'function' && ts.getActiveTarget() !== o.t1) return null;
    if (this._pairSearch && am && typeof am.getSelectedArm === 'function') { const a = am.getSelectedArm(); if (a !== o.armA && a !== o.armB) return null; }
    return o;
  }

  _pairPieceOk(d) {
    return !!d && d.alive !== false && !d._disposed && !d.hazard && !d.isBag && !!d._scenePosition;
  }

  _pairArmReady(a) {
    return !!a && a.state === Constants.ARM_STATES.DOCKED && !!a.springCharged && a.fuel > 5 && !a._aimReserved && !!a.config && !!a.position;
  }

  _pairFits(arm, d) {
    const am = this._armManager;
    if (!(d.mass <= arm.config.maxCaptureMass) || !arm.position) return false;
    const reach = arm.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION;
    const dx = d._scenePosition.x - arm.position.x, dy = d._scenePosition.y - arm.position.y, dz = d._scenePosition.z - arm.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_UNITS_PER_METER <= reach && !checkActiveSatArming(d, am._catalogLoader, QUIET_BUS);
  }

  /** @private metres from her centre to a piece (world frame), into `out` */
  _pairRel(piece, out) {
    const pos = this._player.position, sp = piece._scenePosition;
    out[0] = (sp.x - pos.x) / M; out[1] = (sp.y - pos.y) / M; out[2] = (sp.z - pos.z) / M;
    return out;
  }

  _pairAimProvider(offer) {
    const out = { x: offer.n[0], y: offer.n[1], z: offer.n[2] };
    let n = offer.n.slice(), last = -Infinity;
    const R = new Float64Array(9), T1 = [0, 0, 0], T2 = [0, 0, 0];
    return () => {
      if (!this._pairPieceOk(offer.t1) || !this._pairPieceOk(offer.t2)) return null;
      if (this._pairT - last >= 0.25 && this._player) {
        last = this._pairT;
        pairRotationOf(this._player.quaternion, R);
        const r = refinePairAim(offer.g, R, this._pairRel(offer.t1, T1), this._pairRel(offer.t2, T2), offer.alpha, offer.swap, n, Constants.PAIR_SHOT.TURN_DEG);
        n = r.n;
      }
      out.x = n[0]; out.y = n[1]; out.z = n[2];
      return out;
    };
  }

  pairAimProvider(offer) { return this._pairAimProvider(offer); }

  /** @returns {{missA:number, missB:number}|null} the two launch lines' misses (degrees) right now, for the barrier at the spring */
  pairMissesNow(offer) {
    if (!offer || !this._player || !this._pairPieceOk(offer.t1) || !this._pairPieceOk(offer.t2)) return null;
    const R = pairRotationOf(this._player.quaternion);
    const alpha = typeof offer.armA.getAimAlpha === 'function' ? offer.armA.getAimAlpha() : offer.alpha;
    return pairMisses(offer.g, R, alpha, offer.swap, this._pairRel(offer.t1, [0, 0, 0]), this._pairRel(offer.t2, [0, 0, 0]));
  }

  /**
   * The best pair for the daughter and piece picked now, or null. Preconditions are the launch ceremony's own, plus the
   * mother free to turn and steering not handed away; every other piece in reach is tried as the second (nearest bearings
   * first; a clump is one piece) and the cheapest pair by gas wins. A shot whose single launch would empty a wheel stays single.
   * @private
   */
  _pairSearchBegin() {
    const PS = Constants.PAIR_SHOT;
    const p = this._player, am = this._armManager, ts = this._targetSelector;
    if (!PS || PS.ENABLED === false || !p || !am || !ts || !Constants.FEATURE_FLAGS.SEMI_AUTO_AIM) return null;
    if (p.safeMode || !this._aimCanEase()) return null;
    if (this._engaged || p.autopilotEngaged || this._tripHold || this._tripOmega > 0 || this._turn || this._aimCoroutine || this._attitudeHold) return null;
    if (typeof am.getSelectedArm !== 'function' || typeof am.getDualFirePair !== 'function') return null;
    const sel = am.getSelectedArm();
    if (!this._pairArmReady(sel)) return null;
    const j = am.getDualFirePair(sel.index);
    const opp = Number.isInteger(j) ? am.arms[j] : null;
    if (!this._pairArmReady(opp) || !opp.config || opp.config.type !== sel.config.type) return null;
    if (typeof am._motherTurnBlock === 'function' && am._motherTurnBlock()) return null;
    const type = sel.config.type === 'spinner' ? 'spinner' : 'weaver';
    const armA = sel.index < opp.index ? sel : opp, armB = armA === sel ? opp : sel;
    const dpA = am._dockPositions && am._dockPositions[armA.index], dpB = am._dockPositions && am._dockPositions[armB.index];
    if (!dpA || !dpB) return null;
    const T1 = ts.getActiveTarget();
    if (!this._pairPieceOk(T1) || T1.alive === false) return null;
    const fits = (d) => this._pairFits(sel, d);
    if (!fits(T1) || (typeof am.launchRefusalAt === 'function' && am.launchRefusalAt(T1))) return null;
    const AIM = Constants.AIM;
    const tolRad = degToRad(AIM.DAUGHTER_AIM_TOLERANCE_DEG), rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);
    const sk = `${sel.index}:${T1.id}`;
    if (!this._pairSingle || this._pairSingle.key !== sk) {
      const single = this._planDaughterShot(this._preturnProvider(sel, T1), { arm: sel, armManager: am, pairIndex: sel.index }, AIM.AIM_TIMEOUT_S, tolRad, rate);
      this._pairSingle = { key: sk, empties: !!(single && single.empties) };
    }
    if (this._pairSingle.empties) return null;
    const list = this._debrisField && this._debrisField.debrisList;
    if (!list || !list.length) return null;

    const lo = degToRad(PS.ALPHA_MIN_DEG[type] ?? 7), hi = degToRad(Math.min(PS.ALPHA_MAX_DEG, 180));
    const g = pairGeometry(dpA, dpB, lo, hi);
    const R0 = pairRotationOf(p.quaternion), z0 = [R0[2], R0[5], R0[8]];
    const r1 = this._pairRel(T1, [0, 0, 0]), l1 = Math.hypot(r1[0], r1[1], r1[2]) || 1;
    const minSep = degToRad(PS.MIN_SEP_DEG);
    const cands = [];
    for (const d of list) {
      if (d === T1 || d.id === T1.id || !this._pairPieceOk(d) || d.discovered === false || !fits(d)) continue;
      const r2 = this._pairRel(d, [0, 0, 0]), l2 = Math.hypot(r2[0], r2[1], r2[2]) || 1;
      const cs = (r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / (l1 * l2);
      if (Math.acos(clamp(cs, -1, 1)) < minSep) continue;
      const mx = r1[0] / l1 + r2[0] / l2, my = r1[1] / l1 + r2[1] / l2, mz = r1[2] / l1 + r2[2] / l2, ml = Math.hypot(mx, my, mz);
      const proxy = ml > 1e-6 ? Math.acos(Math.min(1, Math.abs((z0[0] * mx + z0[1] * my + z0[2] * mz) / ml))) : Math.PI / 2;
      cands.push({ d, r2, u: [r2[0] / l2, r2[1] / l2, r2[2] / l2], proxy });
    }
    cands.sort((a, b) => a.proxy - b.proxy);
    const kept = [];
    for (const c of cands) {
      // a clump (pieces within 6 m of each other: the real ones are inside 2.8 m) is one piece: the nearest to a cheap turn stands for it
      if (kept.some((k) => Math.hypot(k.r2[0] - c.r2[0], k.r2[1] - c.r2[1], k.r2[2] - c.r2[2]) < 6)) continue;
      kept.push(c);
      if (kept.length >= PS.MAX_CANDIDATES) break;
    }
    return {
      phase: 'search', done: kept.length === 0, i: 0, sols: null, k: 0, c: null, last: false, best: null, T1, armA, armB, type, g, R0, r1, kept, tolRad, rate,
      rateG: PS.FUEL_G_PER_DEG[type], capG: PS.FUEL_G[type], next: null, planeMaxDeg: this._pairPlaneMax(),
    };
  }

  /**
   * The search in small units of work: one candidate's solve (0.5-0.7 ms) or the checks of one of its answers (launch lines
   * 1.4 ms, gas plan 0.1 ms); all eight candidates in one frame was a visible hitch. With a `budgetMs` it runs units until
   * it is spent (at least one); without, until the search is done.
   * @private
   */
  _pairSearchStep(st, budgetMs = 0) {
    const t0 = budgetMs > 0 ? performance.now() : 0;
    do { this._pairSearchUnit(st); } while (!st.done && (budgetMs <= 0 || performance.now() - t0 < budgetMs));
  }

  /**
   * @private the larger of the pair's two launch misses the finder accepts (deg): the wheel kit turns the tethers into their
   * planes without gas, so it gets the wider `_KIT` limit, but only while the wheels can run: kit aboard AND battery at or
   * over `WHEELS.MIN_BATTERY_WH` (read as `wheelsUsable()` reads it: no battery wired = not power-limited; not its
   * off-play-frame check). Not stored: a standing offer over the tight limit is dropped at the first refresh after the
   * battery falls under the line.
   */
  _pairPlaneMax() {
    const PS = Constants.PAIR_SHOT, p = this._player, base = PS.PLANE_MISS_MAX_DEG ?? Infinity;
    const kit = !!p && typeof p.hasWheelKit === 'function' && p.hasWheelKit();
    if (!kit) return base;
    const b = p.resources ? p.resources.battery : undefined;
    const runs = !Number.isFinite(b) || b >= Constants.WHEELS.MIN_BATTERY_WH;
    return runs ? Math.max(base, PS.PLANE_MISS_MAX_DEG_KIT ?? base) : base;
  }

  _pairSearchUnit(st) {
    const PS = Constants.PAIR_SHOT, AIM = Constants.AIM, am = this._armManager;
    const { T1, armA, armB, g, R0, r1, tolRad, rate, rateG, capG } = st;
    if (!st.sols) {
      const c = st.kept[st.i++];
      if (st.i >= st.kept.length) st.last = true;
      if (c && this._pairPieceOk(c.d) && this._pairPieceOk(T1)) { st.c = c; st.sols = solvePairAimAll(g, R0, r1, c.r2, { turnDeg: PS.TURN_DEG }); st.k = 0; }   // a piece may go while the search runs
      else if (st.last) st.done = true;
      return;
    }
    const c = st.c, r = st.sols[st.k++];
    if (!r) { st.sols = null; if (st.last) st.done = true; return; }
    const verdict = (() => {
      if (r.missA > PS.MISS_DEG || r.missB > PS.MISS_DEG || r.turnDeg > PS.TURN_DEG + 1e-6) return null;
      // a line leaving a piece far off its strut's swing plane makes the mother turn it into the plane during the reel, costing
      // more than the pair saves (PAIR_SHOT.PLANE_MISS_MAX_DEG)
      if (Math.max(r.missA, r.missB) > st.planeMaxDeg) { st.why = st.why || {}; st.why['pair plane'] = (st.why['pair plane'] || 0) + 1; return null; }
      const fuelG = rateG * (r.missA + r.missB);
      if (fuelG > capG) return null;
      const flight = r.alpha <= Math.PI / 2 ? 2 * r.alpha : 2 * Math.PI - 2 * r.alpha;   // the angle the two daughters fly apart by
      if (flight < (PS.SPREAD_MIN_DEG || 0) * DEG2RAD) return null;
      if (pairTethersCross(g, pairAttitudeFor(R0, r.n), r.alpha, r.swap, r1, c.r2)) return null;
      // the barrier refuses a line a part of the ship is across (radiators at 146 deg block weaver lines at 12 deg): never offer such a pair
      if (typeof am.pairLineBlockedAt === 'function' && am.pairLineBlockedAt(armA, armB, r.alpha)) return null;
      const tA = r.swap ? c.d : T1, tB = r.swap ? T1 : c.d;
      if (typeof am.indexLaunchRefusal === 'function' && (am.indexLaunchRefusal(armA.index, tA) || am.indexLaunchRefusal(armB.index, tB))) return null;
      // a pair comes home together (the reel-start barrier holds the first catch): catches minutes apart are not a pair
      const homeGapS = this._pairHomeGapS(armA, armB, r.swap ? c.r2 : r1, r.swap ? r1 : c.r2);
      if (homeGapS > (PS.HOME_GAP_S ?? Infinity)) { st.why = st.why || {}; st.why['pair home gap'] = (st.why['pair home gap'] || 0) + 1; return null; }
      const nW = { x: r.n[0], y: r.n[1], z: r.n[2] };
      const shot = this._planPairShot(() => nW, { arm: armA, armManager: am, pair: { armB, alpha: r.alpha } }, AIM.AIM_TIMEOUT_S, tolRad, rate);
      return shot ? { shot, fuelG, tA, tB, homeGapS } : null;
    })();
    if (!verdict) return;                                          // the other way round is tried next
    const cost = verdict.shot.gasKg * 1000 + verdict.fuelG;       // grams, the two kinds of gas in one currency (an estimate)
    if (!st.best || cost < st.best.cost) st.best = { c, r, shot: verdict.shot, fuelG: verdict.fuelG, cost, tA: verdict.tA, tB: verdict.tB, homeGapS: verdict.homeGapS };
    st.sols = null;                                                // this piece's best way round; the other is worse by construction
    if (st.last) st.done = true;
  }

  /**
   * How far apart (mission-clock seconds) the pair's two catches are predicted to land: each flight is range / her
   * `launchSpeed` (brake, station-keep and net are the same for both and cancel). Measured on the PAIR_FIELDS weaver pair
   * (535 and 471 m): 9.1 s predicted, catches 9.0 s apart.
   * @param {object} armA @param {object} armB @param {number[]} rA metres, centre to A's piece @param {number[]} rB metres, centre to B's piece
   */
  _pairHomeGapS(armA, armB, rA, rB) {
    const speed = (a) => Math.max(0.5, Number.isFinite(a.launchSpeed) ? a.launchSpeed : (Constants.DAUGHTER_AUTOPILOT || {}).V_CAP || 7);
    const tA = Math.hypot(rA[0], rA[1], rA[2]) / speed(armA), tB = Math.hypot(rB[0], rB[1], rB[2]) / speed(armB);
    return Math.abs(tA - tB);
  }

  _pairSearchResult(st) {
    const { T1, armA, armB, g, type } = st;
    const best = st.best;
    if (!best) return null;
    const { c, r, shot, fuelG, cost, tA, tB, homeGapS } = best;
    return {
      key: `${armA.index}+${armB.index}:${T1.id}+${c.d.id}`,
      armA, armB, t1: T1, t2: c.d, swap: r.swap, tA, tB, alpha: r.alpha, n: r.n, g,
      missA: r.missA, missB: r.missB, turnDeg: r.turnDeg, fuelG, gasKg: shot.gasKg, cost, shot, type,
      flightDeg: (r.alpha <= Math.PI / 2 ? 2 * r.alpha : 2 * Math.PI - 2 * r.alpha) / DEG2RAD,
      markId: c.d.id, homeGapS,
    };
  }

  /** @private the whole search at once, for tests and probes */
  _computePairOffer() {
    const st = this._pairSearchBegin();
    if (!st) return null;
    while (!st.done) this._pairSearchStep(st);
    return this._pairSearchResult(st);
  }

  /**
   * One frame of the offer. Looked at again when a pick changed it or REPLAN_S has passed; a new pair says so once and, with
   * the pre-turn on, re-plans toward it. A standing offer is kept until another beats its cost by HOLD_RATIO. The look is
   * spread over frames: one candidate piece per frame, the last settles the offer; a pick in the middle starts over.
   * Measured with 60 pieces in view: one-frame look 8.5 ms median / 75 ms worst; a frame's share is under 4 ms.
   * @param {number} dt @private
   */
  _tickPairOffer(dt) {
    this._pairT += dt;
    const PS = Constants.PAIR_SHOT;
    if (!PS || PS.ENABLED === false) { this._pairSearch = null; if (this._pairOffer) this._setPairOffer(null); return; }
    this._pairClock += dt;
    if (this._pairDirty) this._pairSearch = null;                   // a pick: the look under way is for the old pick
    const st = this._pairSearch;
    if (st) {
      try {
        if (st.phase === 'search') {
          this._pairSearchStep(st, PAIR_FRAME_MS);
          if (!st.done) return;
          st.next = this._pairSearchResult(st);
          const cur = this._pairOffer, next = st.next;
          if (next && cur && cur.key !== next.key && cur.armA === next.armA && cur.armB === next.armB && cur.t1 === next.t1 && this._pairPieceOk(cur.t2)) {
            st.phase = 'standing';                                  // solved again from now: a frame of its own
            return;
          }
        } else {
          const cur = this._pairOffer, next = st.next, again = cur ? this._pairRefreshStanding(cur) : null;
          st.next = again && !(next.cost < PS.HOLD_RATIO * again.cost) ? again : next;
        }
        this._pairSearch = null; this._pairErr = null;
        this._setPairOffer(st.next);
      } catch (e) { this._pairSearch = null; this._pairErr = e; this._setPairOffer(null); }
      return;
    }
    if (!this._pairDirty && this._pairClock < PS.REPLAN_S) return;
    this._pairDirty = false;
    this._pairClock = 0;
    let begun = null;
    try { begun = this._pairSearchBegin(); this._pairErr = null; } catch (e) { begun = null; this._pairErr = e; }
    if (begun && !begun.done) { this._pairSearch = begun; return; }
    if (begun) { this._setPairOffer(this._pairSearchResult(begun)); return; }
    this._setPairOffer(null);
  }

  _pairRefreshStanding(cur) {
    const PS = Constants.PAIR_SHOT, p = this._player, am = this._armManager;
    if (!this._pairFits(cur.armA, cur.t2) || !this._pairFits(cur.armA, cur.t1) || (typeof am.launchRefusalAt === 'function' && am.launchRefusalAt(cur.t2))) return null;
    const R0 = pairRotationOf(p.quaternion), r1 = this._pairRel(cur.t1, [0, 0, 0]), r2 = this._pairRel(cur.t2, [0, 0, 0]);
    const r = solvePairAimAll(cur.g, R0, r1, r2, { turnDeg: PS.TURN_DEG }).find((x) => !pairTethersCross(cur.g, pairAttitudeFor(R0, x.n), x.alpha, x.swap, r1, r2));
    if (!r || r.missA > PS.MISS_DEG || r.missB > PS.MISS_DEG) return null;
    if (Math.max(r.missA, r.missB) > this._pairPlaneMax()) return null;            // as in the search, with the limit the battery gives now
    if (typeof am.pairLineBlockedAt === 'function' && am.pairLineBlockedAt(cur.armA, cur.armB, r.alpha)) return null;
    const fuelG = PS.FUEL_G_PER_DEG[cur.type] * (r.missA + r.missB);
    if (fuelG > PS.FUEL_G[cur.type]) return null;
    const homeGapS = this._pairHomeGapS(cur.armA, cur.armB, r.swap ? r2 : r1, r.swap ? r1 : r2);
    if (homeGapS > (PS.HOME_GAP_S ?? Infinity)) return null;
    const tA = r.swap ? cur.t2 : cur.t1, tB = r.swap ? cur.t1 : cur.t2;
    if (typeof am.indexLaunchRefusal === 'function' && (am.indexLaunchRefusal(cur.armA.index, tA) || am.indexLaunchRefusal(cur.armB.index, tB))) return null;
    const AIM = Constants.AIM;
    const tolRad = degToRad(AIM.DAUGHTER_AIM_TOLERANCE_DEG), rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);
    const nW = { x: r.n[0], y: r.n[1], z: r.n[2] };
    const shot = this._planPairShot(() => nW, { arm: cur.armA, armManager: am, pair: { armB: cur.armB, alpha: r.alpha } }, AIM.AIM_TIMEOUT_S, tolRad, rate);
    if (!shot) return null;
    return Object.assign({}, cur, {
      swap: r.swap, tA, tB, alpha: r.alpha, n: r.n, missA: r.missA, missB: r.missB, turnDeg: r.turnDeg, fuelG, gasKg: shot.gasKg, shot, homeGapS,
      cost: shot.gasKg * 1000 + fuelG,
    });
  }

  _setPairOffer(next) {
    const cur = this._pairOffer;
    this._pairOffer = next;
    const changed = (cur ? cur.key : null) !== (next ? next.key : null);
    if (!changed) return;
    if (next && this._pairSaid !== next.key) {
      this._pairSaid = next.key;
      const deg = Math.max(1, Math.round(Math.max(next.missA, next.missB)));
      eventBus.emit(Events.COMMS_MESSAGE, { text: pairReadyLine(deg), priority: 'info', source: 'HOUSTON' });
    }
    if (!next) this._pairSaid = null;
    const W = Constants.WHEEL_PRETURN;
    if (W && W.ENABLED !== false && (this._preturn || next)) this._preturnReq = { target: next ? next.t1 : (cur ? cur.t1 : null) };
  }

  // PAIR LESSON
  // MissionCoach's beat `ch2_pair_shot` starts it (MISSION_BEAT_STARTED). It waits for both daughters of one type to be home
  // and charged, reveals the pieces the finder may use (a pick discovers its piece, TARGET_DISCOVERED; no scan: a touch player
  // has none to press), then picks a daughter and a piece as keys 1-4 do until the finder offers a pair (PAIR_FIELDS pieces
  // first). With no pair after `PAIR_LESSON_SKIP_S` (or `PAIR_LESSON_CAP_S` from the beat's start) it says why and emits
  // PAIR_LESSON_SKIP, which MissionCoach ends the beat on. DUAL_FIRE ends it too.

  _lessonBegin() {
    this._lessonBeat = true;
    this._lesson = { t: 0, readyT: 0, step: 'wait', said: false, revealed: false, combos: null, ci: 0, picked: false, settle: 0, idleT: 0, tried: new Set(), exp: null, yielded: false };
  }

  _lessonEnd() {
    this._lessonBeat = false;
    this._lesson = null;
  }

  _lessonReadyPairs() {
    const am = this._armManager;
    const out = [];
    if (!am || !Array.isArray(am.arms) || typeof am.getDualFirePair !== 'function') return out;
    for (const a of am.arms) {
      if (!a || !Number.isInteger(a.index)) continue;
      const j = am.getDualFirePair(a.index);
      if (!Number.isInteger(j) || j < a.index) continue;
      const b = am.arms[j];
      if (!this._pairArmReady(a) || !this._pairArmReady(b) || !b.config || !a.config || a.config.type !== b.config.type) continue;
      out.push({ sel: a, opp: b, type: a.config.type === 'spinner' ? 'spinner' : 'weaver' });
    }
    out.sort((x, y) => (x.type === y.type ? 0 : (x.type === 'weaver' ? -1 : 1)));
    return out;
  }

  _lessonPieces() {
    const PF = Constants.PAIR_FIELDS;
    const list = (this._debrisField && this._debrisField.debrisList) || [];
    const isPairRow = (d) => Number.isInteger(d.fieldRow) && d.fieldRow >= PF.ROW0 && d.fieldRow < PF.ROW0 + 2 * PF.PAIRS;
    const ok = list.filter((d) => this._pairPieceOk(d) && d.alive !== false && !d._captured && !d._armPinned);
    const rows = ok.filter(isPairRow).sort((a, b) => a.fieldRow - b.fieldRow);
    const rel = [0, 0, 0];
    const others = ok.filter((d) => !isPairRow(d))
      .map((d) => { this._pairRel(d, rel); return { d, r: Math.hypot(rel[0], rel[1], rel[2]) }; })
      .sort((a, b) => a.r - b.r).slice(0, 8).map((x) => x.d);
    return { rows, others, isPairRow };
  }

  /** @private the (daughter, piece) picks to try, best first: a pair's own kind of daughter on its own pieces, then the other kind, then the nearest others */
  _lessonCombos(ready, pieces, tried) {
    const PF = Constants.PAIR_FIELDS;
    const combos = [];
    for (const r of ready) {
      for (const d of pieces.rows.concat(pieces.others)) {
        if (!this._pairFits(r.sel, d) || (tried && tried.has(r.sel.index + ':' + d.id))) continue;
        const isRow = pieces.isPairRow(d);
        const own = isRow && PF.KINDS[Math.floor((d.fieldRow - PF.ROW0) / 2)].name === r.type;
        combos.push({ arm: r.sel, piece: d, key: own ? 0 : (isRow ? 1 : 2) });
      }
    }
    combos.sort((a, b) => a.key - b.key);
    return combos.slice(0, 24);
  }

  /**
   * @private the pieces the finder could take as the second piece for `piece` (its own filters, nearest bearing first, at
   * most MAX_CANDIDATES) that are not discovered yet: discovered now, as a pick does. A partner whose catches would land
   * more than HOME_GAP_S apart, whichever daughter takes which piece, is not revealed (it showed the whole field).
   */
  _lessonRevealPartners(arm, piece) {
    const PS = Constants.PAIR_SHOT, ts = this._targetSelector;
    const list = (this._debrisField && this._debrisField.debrisList) || [];
    const r1 = this._pairRel(piece, [0, 0, 0]), l1 = Math.hypot(r1[0], r1[1], r1[2]) || 1;
    const minSep = degToRad(PS.MIN_SEP_DEG), rel = [0, 0, 0];
    const am = this._armManager, j = am && typeof am.getDualFirePair === 'function' ? am.getDualFirePair(arm.index) : null;
    const opp = Number.isInteger(j) ? am.arms[j] : null;
    const gapMax = PS.HOME_GAP_S ?? Infinity;
    const cands = [];
    for (const d of list) {
      if (d === piece || d.id === piece.id || !this._pairPieceOk(d) || d.alive === false || d._captured || d._armPinned || !this._pairFits(arm, d)) continue;
      this._pairRel(d, rel);
      const l2 = Math.hypot(rel[0], rel[1], rel[2]) || 1;
      const sep = Math.acos(clamp((r1[0] * rel[0] + r1[1] * rel[1] + r1[2] * rel[2]) / (l1 * l2), -1, 1));
      if (sep < minSep) continue;
      if (opp && Math.min(this._pairHomeGapS(arm, opp, r1, rel), this._pairHomeGapS(arm, opp, rel, r1)) > gapMax) continue;   // the finder refuses it on the gap
      cands.push({ d, sep });
    }
    cands.sort((a, b) => a.sep - b.sep);
    for (const c of cands.slice(0, PS.MAX_CANDIDATES)) if (c.d.discovered === false) ts.setTarget(c.d);
  }

  _tickPairLesson(dt) {
    const L = this._lesson;
    if (!L) return;
    L.t += dt;
    const am = this._armManager, ts = this._targetSelector;
    const ready = this._lessonReadyPairs();
    if (ready.length) L.readyT += dt;                        // the skip time counts from when a pair is ready, not while she waits
    // the skip runs in every step ('done' too: a player who picks another piece takes the offer away and must not strand the
    // chapter); a standing pair offer is never skipped
    const MC = Constants.MISSION_COACH;
    if ((L.readyT >= MC.PAIR_LESSON_SKIP_S || L.t >= MC.PAIR_LESSON_CAP_S) && !this.getPairOffer()) {
      this._lessonEnd();
      eventBus.emit(Events.COMMS_MESSAGE, { text: pairLessonSkipLine(ready.length > 0), priority: 'info', source: 'HOUSTON', channel: 'MISSION', _postOnboarding: true });
      eventBus.emit(Events.PAIR_LESSON_SKIP, { reason: ready.length > 0 ? 'no pair offered' : 'daughters not ready' });
      return;
    }
    if (L.step === 'done') return;
    if (this.getPairOffer()) { L.step = 'done'; return; }
    if (!am || !ts || typeof am.selectArm !== 'function' || typeof ts.setTarget !== 'function') return;
    if (!ready.length) {
      if (L.step !== 'wait') { L.step = 'wait'; L.combos = null; L.picked = false; }
      if (!L.said) { L.said = true; eventBus.emit(Events.COMMS_MESSAGE, { text: pairLessonWaitLine(), priority: 'info', source: 'HOUSTON', channel: 'MISSION', _postOnboarding: true }); }
      return;
    }
    if (!L.yielded && L.exp && (ts.getActiveTarget() !== L.exp.piece || am.getSelectedArm() !== L.exp.arm)) L.yielded = true;
    if (L.yielded) return;
    if (this.isAiming() || this._turn || this._tripOmega > 0) return;
    if (L.step === 'wait') L.step = 'find';
    if (L.step === 'idle') {
      L.idleT += dt;
      if (L.idleT < 3) return;                                     // the pieces drift: look again every 3 s
      L.step = 'find'; L.combos = null; L.picked = false;
    }
    if (!L.combos) {
      L.combos = this._lessonCombos(ready, this._lessonPieces(), L.tried);
      L.ci = 0; L.picked = false;
    }
    // reveal once: only the PAIR_FIELDS pieces (the second mark needs a discovered piece); any other piece is discovered
    // only when the lesson itself picks it (fallback)
    if (!L.revealed) {
      L.revealed = true;
      const nc = L.combos[L.ci], next = nc && this._pairArmReady(nc.arm) && this._pairPieceOk(nc.piece) ? nc.piece : null;   // that pick happens this frame
      for (const d of this._lessonPieces().rows) if (d.discovered === false && d !== next) ts.setTarget(d);
    }
    const c = L.combos[L.ci];
    if (!c) { L.step = 'idle'; L.idleT = 0; L.combos = null; return; }
    if (!L.picked) {
      if (!this._pairArmReady(c.arm) || !this._pairPieceOk(c.piece)) { L.ci++; return; }
      if (typeof am.getSelectedArm === 'function' && am.getSelectedArm() !== c.arm) am.selectArm(c.arm.index, { quiet: true });
      if (!this._lessonPieces().isPairRow(c.piece)) this._lessonRevealPartners(c.arm, c.piece);   // fallback pick: the finder needs its partner discovered
      ts.setTarget(c.piece, { source: 'lesson_pick' });
      L.tried.add(c.arm.index + ':' + c.piece.id);                // each (daughter, piece) is picked at most once per lesson
      L.exp = { piece: c.piece, arm: am.getSelectedArm() };
      L.picked = true; L.settle = 0;
      return;
    }
    L.settle++;
    if (L.settle < 2 || this._pairSearch || this._pairDirty) return;      // the finder looks on the frame after a pick, over a few frames
    const o = this.getPairOffer();
    if (o && o.t1 === c.piece) { L.step = 'done'; return; }              // offered: the second mark and the "ready" line are the finder's own
    L.picked = false; L.ci++;
  }

  /**
   * The gas of the pair about to leave and of the two single shots it replaces, all from the attitude now and the same plans
   * (`_planDaughterShot` / `_planPairShot`) as the shot's "About N s" line. Null when a plan is not possible.
   * @returns {{x:number, y:number, armA:number, armB:number, t:number, lesson:boolean}|null} x, y in grams
   */
  _pairSavingNow(opts) {
    try {
      const o = this._pairOffer, am = this._armManager;
      if (!o || !am || !opts || o.armA !== opts.arm || !opts.pair || o.armB !== opts.pair.armB) return null;
      const AIM = Constants.AIM;
      const tolRad = degToRad(AIM.DAUGHTER_AIM_TOLERANCE_DEG), rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);
      let singles = 0;
      for (const [arm, target] of [[o.armA, o.tA], [o.armB, o.tB]]) {
        const s = this._planDaughterShot(this._preturnProvider(arm, target), { arm, armManager: am, pairIndex: arm.index }, AIM.AIM_TIMEOUT_S, tolRad, rate);
        if (!s || !Number.isFinite(s.gasKg)) return null;
        singles += s.gasKg * 1000;
      }
      const x = o.gasKg * 1000;
      return { x, y: singles - x, armA: o.armA.index, armB: o.armB.index, t: this._pairT, lesson: this._lessonBeat };
    } catch (_err) { return null; }
  }

  /**
   * DUAL_FIRE: say what the double shot used and saved. Outside the lesson only a saving of 1 g or more, from mission 2 on;
   * in the lesson always, plus the sentence about parking the ship between two pieces.
   */
  _onDualFire(d) {
    const sv = this._pairSaving;
    this._pairSaving = null;
    const mine = sv && d && ((sv.armA === d.armIndex1 && sv.armB === d.armIndex2) || (sv.armA === d.armIndex2 && sv.armB === d.armIndex1)) && this._pairT - sv.t < 120;
    const lesson = mine ? sv.lesson : this._lessonBeat;
    const df = this._debrisField;
    const mission = df && Number.isFinite(df._currentMissionNumber) ? df._currentMissionNumber : 2;
    if (!lesson && mission < 2) return;
    const saved = mine && sv.y >= 1;
    let text = null;
    if (mine) text = saved ? pairSavedLine(sv.x, sv.y) : (lesson ? pairSameLine(sv.x) : null);
    if (lesson) text = (text ? text + ' ' : '') + PAIR_PARK_LINE;
    if (!text) return;
    eventBus.emit(Events.COMMS_MESSAGE, lesson
      ? { text: text.trim(), priority: 'info', source: 'HOUSTON', channel: 'MISSION', _postOnboarding: true }
      : { text, priority: 'info', source: 'HOUSTON' });
  }

  /**
   * The price of a pair's aim and kick as `_planDaughterShot` prices a single one: her barrel (+z) turns onto the pair's barrel
   * direction (the provider's), both struts swing to the pair's angle, and the two kicks are summed (they cancel at one
   * angle; what is left is the wheels' or gas's own small residue). Same shape back (`kind: 'pair'`).
   * @returns {object|null} null when the geometry is not there (a stub, no dock positions)
   */
  _planPairShot(provider, opts, aimLimitS, tolRad, rate) {
    const PS = Constants.PAIR_SHOT, CS = Constants.CHEST_SHOT;
    const p = this._player;
    const pair = opts.pair, armA = opts.arm, armB = pair && pair.armB, am = opts.armManager || this._armManager;
    if (!PS || PS.ENABLED === false || !p || !armA || !armB || !am || !am.arms || !am._dockPositions || !this._aimCanEase()) return null;
    if (typeof armA.getAimAlpha !== 'function' || typeof armB.getAimAlpha !== 'function') return null;
    const dpA = am._dockPositions[armA.index], dpB = am._dockPositions[armB.index];
    if (!dpA || !dpB) return null;
    const raw = provider();
    if (!raw) return null;
    const nb = new THREE.Vector3(raw.x, raw.y, raw.z);
    if (!(nb.lengthSq() > 1e-12)) return null;
    nb.normalize().applyQuaternion(new THREE.Quaternion().copy(p.quaternion).invert());   // the barrel direction wanted, in her body frame
    const alpha = pair.alpha;
    const V5 = Constants.OCTOPUS_V5;
    const errRad = Math.acos(clamp(nb.z, -1, 1));
    let nx = 1, ny = 0;
    const sxy = Math.hypot(nb.x, nb.y);
    if (sxy > 1e-6) { nx = -nb.y / sxy; ny = nb.x / sxy; }          // the axis (0,0,1) x nb: the turn is pitch and yaw only
    const a0A = armA.getAimAlpha(), a0B = armB.getAimAlpha();
    const viewAt = (f) => {
      const wrap = new Map();
      const arms = am.arms.map((a) => {
        if (a !== armA && a !== armB) return a;
        const w = Object.assign(Object.create(a), { getAimAlpha: () => a.getAimAlpha() + (alpha - a.getAimAlpha()) * f });
        wrap.set(a, w);
        return w;
      });
      return { view: { arms, _dockPositions: am._dockPositions }, wrap };
    };
    const dStrut = Math.max(Math.abs(alpha - a0A), Math.abs(alpha - a0B));
    const tS = Math.max(
      typeof armA.aimEaseMinTime === 'function' ? armA.aimEaseMinTime(alpha) : Math.abs(alpha - a0A) / V5.AIM_TURN_STRUT_PACE,
      typeof armB.aimEaseMinTime === 'function' ? armB.aimEaseMinTime(alpha) : Math.abs(alpha - a0B) / V5.AIM_TURN_STRUT_PACE,
    );
    const inertiaTable = () => {
      if (dStrut < 1e-9) { const I = p.getAttitudeInertia(); return [{ ixx: I.ixx, iyy: I.iyy }]; }
      const tab = [];
      for (let k = 0; k <= 4; k++) {
        const I = computeInertia(viewAt(k / 4).view, p);
        tab.push({ ixx: I.ixx, iyy: I.iyy });
      }
      return tab;
    };
    const sloth = typeof p.isSlothMode === 'function' && p.isSlothMode();
    const kit = typeof p.hasWheelKit === 'function' && p.hasWheelKit();
    const stopErr = 0.5 * tolRad;
    const turnRad = errRad > tolRad ? errRad - stopErr : 0;
    let src = null;
    if (typeof p.attitudeTorqueSource === 'function' && (kit || sloth) && (sloth || turnRad > 0)) {
      const sel = p.attitudeTorqueSource({ spinUp: true, angleRad: turnRad, nx, ny, limitS: aimLimitS, quiet: true });
      if (isSlowSrc(sel)) src = sel;
    }
    let timeS, aimKg;
    if (src === 'wheels') {
      timeS = Math.max(this._simGasAim({ err: errRad, nx, ny, table: inertiaTable(), tS, stopErr, tolRad, rate, dStrut, wheels: true }).timeS, tS);
      aimKg = 0;
    } else if (src) {
      timeS = Math.max(turnRad > 0 ? slowTurnTimeS(p, src, turnRad, nx, ny) + slowWarmupLeftS(p, src) : 0, tS);
      aimKg = 0;
    } else {
      const t = this._simGasAim({ err: errRad, nx, ny, table: inertiaTable(), tS, stopErr, tolRad, rate, dStrut });
      timeS = t.timeS; aimKg = t.gasKg;
    }
    // the two kicks at the pair's angle: each L = r x (-m v d) about her CoM without that daughter, summed
    const { view, wrap } = viewAt(1);
    const dir = new THREE.Vector3(), per = { x: 0, y: 0 };
    let lx = 0, ly = 0;
    for (const arm of [armA, armB]) {
      const dp = arm === armA ? dpA : dpB;
      const com = computeCoM(view, p, { excludeArm: wrap.get(arm) });
      strutLocalDirection(alpha, degToRad(dp.azimuthDeg), dir);
      launchKickPerNs(strutTipMeters(dp, alpha), com.position, dir, per);
      const tier = Constants.SPRING_TIERS && Constants.SPRING_TIERS[arm.springTier];
      const speed = Math.min(Number.isFinite(arm.launchSpeed) ? arm.launchSpeed : Infinity, tier ? tier.maxSpeed : Infinity);
      const type = arm.config && arm.config.type;
      let massKg = type === 'weaver' ? Constants.V5_WEAVER_MASS : (type === 'spinner' ? Constants.V5_SPINNER_MASS : (arm.config && arm.config.mass));
      massKg += (arm.capturedDebris && arm.capturedDebris.mass) || 0;
      if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) massKg += (h && h.mass) || 0;
      const mv = (massKg > 0 && speed > 0 && Number.isFinite(speed)) ? massKg * speed : 0;
      lx += per.x * mv; ly += per.y * mv;
    }
    const tankKg = coldGasPoolToKg(Math.max(0, Number(p.resources && p.resources.coldGas) || 0));
    let kickKg = 0;
    if (Math.abs(lx) + Math.abs(ly) > 1e-6) {
      const peek = kit ? p.wheelKickPeek(lx, ly) : null;
      const left = peek || { x: lx, y: ly };
      if (Math.abs(left.x) + Math.abs(left.y) > 1e-6) kickKg = p.turnNullKg(left.x, left.y);
    }
    const kickGas = Math.min(kickKg, tankKg);
    return {
      alpha, kind: 'pair', errRad, nx, ny, src, timeS, aimKg, kickKg: kickGas, gasKg: Math.min(aimKg + kickKg, tankKg), creditKg: 0, dropNms: 0,
      empties: false, alt: null, kickNms: Math.hypot(lx, ly),
    };
  }

  /**
   * Seconds and grams of steering gas for a cold-gas aim, by running the law `_tickAimEased` runs on numbers alone (no ship
   * is touched): her slowest couple sets the acceleration; she climbs to a peak (the aim's rate, the tank's cap, lowered when
   * the strut needs longer than the turn), cruises and brakes to rest at the target, the strut moving the whole time (its
   * eased profile stretched to the plan's time); each rad/s of rise and fall is `k·(mx+my)/α` of gas (`_turnFire`). `table`
   * is her inertia at five strut angles from where it is to where it goes (a folded strut turns easily, a swung-out one does
   * not). `q.wheels` runs the same law for a wheel aim: the wheels' torque, their room as the rate cap, no gas.
   * @param {{err:number, nx:number, ny:number, table:Array<{ixx:number,iyy:number}>, tS:number, stopErr:number, tolRad:number,
   *   rate:number, omega0?:number, strutDone?:boolean, wheels?:boolean}} q
   * @returns {{timeS:number, gasKg:number}}
   */
  _simGasAim(q) {
    const p = this._player;
    const wheels = q.wheels === true;
    const tauX = wheels ? p.wheelTauMag('x') : p._coupleTauMag('x'), tauY = wheels ? p.wheelTauMag('y') : p._coupleTauMag('y');
    const cx = Math.abs(q.nx), cy = Math.abs(q.ny);
    const table = q.table, last = table.length - 1;
    const at = (sx) => {                                                      // her inertia a fraction sx (0..1) along the strut's move
      if (last <= 0) return table[0];
      const f = clamp01(sx) * last, i = Math.min(last - 1, Math.floor(f)), w = f - i;
      return { ixx: table[i].ixx + w * (table[i + 1].ixx - table[i].ixx), iyy: table[i].iyy + w * (table[i + 1].iyy - table[i].iyy) };
    };
    const couples = (I) => {                                                  // `_aimAccel`: acceleration and each couple's firing fraction
      let a = Infinity;
      if (cx > 1e-6) a = Math.min(a, tauX / (I.ixx * cx));
      if (cy > 1e-6) a = Math.min(a, tauY / (I.iyy * cy));
      if (!Number.isFinite(a)) a = Math.min(tauX / I.ixx, tauY / I.iyy);
      if (!Number.isFinite(a) || !(a > 0)) return null;
      let mx = cx > 1e-6 ? I.ixx * a * cx / tauX : 0;
      let my = cy > 1e-6 ? I.iyy * a * cy / tauY : 0;
      if (mx >= my) { if (my > 0 && my <= TURN_MIN_MAG) { mx += my; my = 0; } }
      else if (mx > 0 && mx <= TURN_MIN_MAG) { my += mx; mx = 0; }
      return { a, m: Math.min(1, mx) + Math.min(1, my) };
    };
    const k = wheels ? 0 : (p._coldGasRate ?? 0.5) * (Constants.ATTITUDE?.RCS_ATTITUDE_N2_FACTOR ?? 0.3);
    const c0 = couples(at(0));
    if (!c0) return { timeS: q.tS, gasKg: 0 };
    const V5 = Constants.OCTOPUS_V5;
    let vCap = wheels ? Math.min(q.rate, p.wheelSpareRate(q.nx, q.ny))
      : Math.min(q.rate, this._gasRateCap(null, k * c0.m / c0.a, q.omega0 || 0));
    let vPeak = vCap, tPlan = 0;
    const theta0 = Math.max(0, q.err - q.stopErr);
    if (!q.strutDone) {
      const tM = theta0 <= 0 ? 0 : (theta0 >= vCap * vCap / c0.a ? theta0 / vCap + vCap / c0.a : 2 * Math.sqrt(theta0 / c0.a));
      if (q.tS > tM && theta0 > 0) vPeak = Math.min(vCap, 0.5 * c0.a * (q.tS - Math.sqrt(Math.max(0, q.tS * q.tS - 4 * theta0 / c0.a))));
      tPlan = Math.max(tM, q.tS);
    }
    if (!(vCap > 0)) return { timeS: q.tS, gasKg: 0 };
    // the strut's eased profile (ArmUnit `strutEaseProfile`), stretched to the plan's time
    const acc = V5.STRUT_EASE_ACCEL, vMax = V5.AIM_TURN_STRUT_PACE;
    const strutT = q.strutDone ? 0 : (q.tS > 0 ? tPlan : 0);
    let sv = 0;
    if (strutT > 0 && acc > 0) sv = 0.5 * acc * (strutT - Math.sqrt(Math.max(0, strutT * strutT - 4 * (q.dStrut || 0) / acc)));
    const frac = (t) => {                                                     // share of the strut's move done at time t
      if (!(strutT > 0) || !(q.dStrut > 1e-9)) return 1;
      if (t >= strutT) return 1;
      const d = q.dStrut, ta = sv / acc;
      if (t < ta) return 0.5 * acc * t * t / d;
      if (t < strutT - ta) return (0.5 * acc * ta * ta + sv * (t - ta)) / d;
      const r = strutT - t;
      return (d - 0.5 * acc * r * r) / d;
    };
    const dt = 1 / 30;
    let err = q.err, was = q.omega0 || 0, t = 0, pool = 0, sFrac = q.strutDone ? 1 : 0;
    for (let n = 0; n < 60 * 30; n++) {
      const cp = couples(at(sFrac));
      if (!cp) break;
      const strutDone = t >= strutT;
      const dOm = cp.a * dt;
      const rem = err - q.stopErr;
      const stopHere = strutDone && vPeak < vCap && err + was * was / (2 * cp.a) <= q.tolRad;           // as `_tickAimEased`
      const want = stopHere ? 0 : (rem > 0 ? 0.5 * (-dOm + Math.sqrt(dOm * dOm + 8 * cp.a * rem)) : 0);
      const lo = Math.max(0, was - dOm);
      const vLim = strutDone ? vCap : vPeak;
      let now = Math.min(Math.max(want, lo), clamp(was + dOm, lo, vLim));
      if (now > was) {
        const cap = this._gasRateCap(null, k * cp.m / cp.a, was);
        if (now > cap) now = Math.max(was, cap);
      }
      if (strutDone && err <= q.tolRad && now <= 0) { pool += k * cp.m * was / cp.a; break; }
      pool += k * cp.m * Math.abs(now - was) / cp.a;
      was = now;
      err -= Math.min(now * dt, err);
      t += dt;
      sFrac = frac(t);
    }
    return { timeS: t, gasKg: coldGasPoolToKg(pool) };
  }

  _shotGasWords(kg) {
    return `${Math.max(0, Math.round(kg * 1000))} g of gas`;
  }

  /**
   * @private Daughter aim line in plain words: seconds and grams of the shot taken, plus the quicker other way when its
   * gas differs by over QUICK_FRAC.
   */
  _shotAimLine(shot) {
    if (shot.kind === 'pair') return `Turning the ship to line up the pair shot. About ${Math.max(1, Math.round(shot.timeS))} s, ${this._shotGasWords(shot.gasKg)}.`;
    return `Turning the ship to line up the launch. About ${Math.max(1, Math.round(shot.timeS))} s, ${this._shotGasWords(shot.gasKg)}.${shot.alt ? this._shotQuickWords(shot.alt) : ''}`;
  }

  /** @private " (quick: 7 s, 133 g)": the other way of the shot (seconds under 90, else minutes). */
  _shotQuickWords(alt) {
    const t = alt.timeS < 90 ? `${Math.max(1, Math.round(alt.timeS))} s` : `${Math.round(alt.timeS / 60)} min`;
    return ` (quick: ${t}, ${Math.round(alt.gasKg * 1000)} g)`;
  }

  /** @private The same line when the wheels hand a daughter aim to the gas (what is left of the turn, plus the kick). */
  _shotHandedLine(c, bm, T) {
    const err = Math.acos(Math.max(-1, Math.min(1, bm.dot(T))));
    const I = this._player.getAttitudeInertia();
    const e = this._simGasAim({ err, nx: c.axX, ny: c.axY, table: [{ ixx: I.ixx, iyy: I.iyy }], tS: c.handTS > 0 ? c.handTS : 0, stopErr: c.stopErr, tolRad: c.tolRad,
      rate: c.rate, omega0: Math.max(0, c.omega || 0), strutDone: !(c.handTS > 0), dStrut: 0 });
    return `Turning the ship to line up the launch. About ${Math.max(1, Math.round(e.timeS))} s, ${this._shotGasWords(e.gasKg + c.shot.kickKg)}.`;
  }

  _sayWheelsEmpty() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'This launch also empties the wheels.', priority: 'info', source: 'HOUSTON',
    });
  }

  _resolveAim(launchDir) {
    const c = this._aimCoroutine;
    if (!c) return;
    this._aimCoroutine = null;
    // A daughter launch keeps the mother still from here to the spring. Set BEFORE _cleanup so aimHold never drops
    // (cleanup keeps aimHold = _attitudeHold).
    if (c.mode === 'daughter' && c.arm) this._beginLaunchHold(c.arm);
    if (c.mode === 'daughter' && c.pair && c.pair.armB) this._beginLaunchHold(c.pair.armB);   // the one hold covers both
    c._cleanup();
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: c.mode, result: 'resolved' });
    c.resolve({ mode: c.mode, launchDir });
  }

  /**
   * @private Reject the active aim coroutine (nothing fired/spent). `code` = `err.code`: 'MANUAL' | 'TIMEOUT' |
   * 'TARGET_LOST' | 'TARGET_CHANGED' | 'SUPERSEDED' | 'OTHER'. `reason` is shown to the player in comms.
   */
  _rejectAim(reason, code = 'OTHER') {
    const c = this._aimCoroutine;
    if (!c) return;
    this._billAimTail(c);          // a cancelled aim still has to be stopped
    this._aimCoroutine = null;
    c._cleanup();
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: c.mode, result: 'rejected', reason });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch aborted — ${reason}.`, priority: 'warning', source: 'HOUSTON',
    });
    const err = new Error(reason);
    err.code = code;
    c.reject(err);
  }

  // Scripted whole-ship turn (leash hand-off)

  /**
   * Turn the WHOLE ship by `angleRad` about a fixed WORLD axis, slowly and smoothly, then keep the new attitude until
   * the caller lets go. Inertial bang-coast-bang (accelerate at α, coast at `maxRate`, brake at α; a triangle when the
   * angle is too short to reach `maxRate`). A fixed-profile turn writes the attitude ABSOLUTELY each frame as
   * R(axis, θ(t)) · qStart — never accumulated — so frame rate cannot change where it ends; a tracked turn
   * (`opts.track`) writes increments, its end set by the live error the tracker returns. Gas is billed only while the
   * thrusters would fire (the two ramps), by the overlap of each frame with the burn windows; the coast is free. Unlike
   * requestAimRotation this does NOT call fireRcsRotation every frame (that bills ~49 % of the tank for a 146° slew).
   *
   * Takes the attitude hold (holdAttitude → aimHold, owner AIM) and emits AIM_SEQUENCE_START/END with mode 'turn'.
   * After it resolves (or a mid-turn cancel/reject) the hold STAYS ON: the caller must call releaseAttitudeHold() (its
   * own `holdS` safety cap, default 120 s, counts from the end of the turn). Refuses at once (rejects, nothing moves,
   * no gas) when it cannot run: see the `fail(...)` checks below.
   * @param {{x:number,y:number,z:number}} axisWorld — turn axis (WORLD frame, need not be unit)
   * @param {number} angleRad — signed angle about that axis (right-hand rule)
   * @param {object} [opts]
   * @param {number} [opts.maxRate=TURN_DEFAULT_MAX_RATE] — peak rate (rad/s), capped at ATTITUDE.MAX_RATE
   * @param {number} [opts.accel] — ramp acceleration (rad/s²); default and ceiling = the couples' α
   * @param {string} [opts.holdOwner] — who owns every hold this turn makes; the lasso / net listeners do not release it
   * @param {() => (number|null)} [opts.track] — a TRACKED turn, run closed loop (`_tickTrackedTurn`): `angleRad` then only
   *   sizes the first look (sign, gas check, acceleration); every frame `track()` gives the signed angle still to turn
   *   about the axis (rad) and her rate follows it; `null` / NaN = stop here (she brakes at the couples' α).
   * @param {number} [opts.stopRad] — tracked turns: the angle left (rad) at which a turn at rest is over (default 0.1°)
   * @returns {Promise<{ angleRad:number, gasUnits:number, seconds:number }>}
   *   A rejection is an Error carrying `progressRad` and `gasUnits` (what was done so far).
   */
  requestAttitudeTurn(axisWorld, angleRad, opts = {}) {
    const player = this._player;
    this._lastTurnRefusal = null;
    const fail = (msg) => { this._lastTurnRefusal = msg; return Promise.reject(new Error(msg)); };
    if (!player) return fail('AutopilotSystem not initialized (no player).');
    if (this._aimCoroutine) return fail('Aim in progress');
    if (this._turn) return fail('Turn in progress');
    if (!axisWorld || !Number.isFinite(angleRad)
        || typeof player.getAttitudeInertia !== 'function'
        || typeof player._coupleTauMag !== 'function') {
      return fail('Bad attitude-turn request');
    }
    const axis = new THREE.Vector3(axisWorld.x, axisWorld.y, axisWorld.z);
    const axisLenSq = axis.lengthSq();
    if (!(axisLenSq > 1e-12) || !Number.isFinite(axisLenSq)) return fail('Bad attitude-turn axis');
    axis.normalize();

    const tier = this._armManager?.getRotationLockTier?.() ?? 'none';
    if (tier !== 'none') return fail('daughter on its tether');

    // World axis → body frame. Roll (nose axis) has ~1 % of pitch authority.
    // Start from the commanded attitude, never one with a recoil shake applied (the request can arrive after
    // player.update re-applied it; the turn would carry that frozen shake into the hand-back offset).
    if (typeof player.undoRecoilOverlay === 'function') player.undoRecoilOverlay();
    const qStart = player.quaternion.clone();
    const nBody = axis.clone().applyQuaternion(qStart.clone().invert());
    if (Math.abs(nBody.z) > TURN_ROLL_MAX) return fail('roll axis — no roll authority');

    let prof = attitudeTurnProfile(player, nBody, angleRad, opts);
    if (!prof.ok) return fail(prof.reason);
    // Sloth mode: the selector says the tank cannot pay, so the turn is the tail boxes' (their shape and time; no steering
    // gas billed); else the gas must pay for both burns. Wheels: the selector also gets the angle and the caller's limit
    // (`maxWaitS`; none = no limit): with gas, they take a turn they can finish inside it (0 gas, battery), the gas the rest;
    // with the gas out they take it all (the boxes when full), and `maxWaitS` refuses a too-slow one.
    const sloth = typeof player.isSlothMode === 'function'
      ? player.isSlothMode()
      : (typeof player.attitudeTorqueSource === 'function' && player.attitudeTorqueSource({ spinUp: true }) === 'tailBoxes');
    // With gas a caller may hold the wheels to a tighter time than its own limit (`wheelLimitS`: the leash hand-off, whose
    // swing is tuned to the gas profile); with the gas out `maxWaitS` stands.
    const wheelLim = (!sloth && Number.isFinite(opts.wheelLimitS)) ? opts.wheelLimitS : opts.maxWaitS;
    const sel = typeof player.attitudeTorqueSource === 'function'
      ? player.attitudeTorqueSource({ spinUp: true, angleRad, nx: nBody.x, ny: nBody.y,
        limitS: Number.isFinite(wheelLim) ? wheelLim : undefined })
      : null;
    let slowSrc = isSlowSrc(sel) ? sel : null;
    let slothEstS = 0;
    if (slowSrc) {
      const slowProf = attitudeTurnProfile(player, nBody, angleRad, { ...opts, boxes: slowSrc === 'tailBoxes', wheels: slowSrc === 'wheels' });
      if (!slowProf.ok) {
        if (sloth) return fail(slowProf.reason);
        slowSrc = null;                                         // the wheels cannot turn her that way: the gas does (below)
      } else {
        const est = slowProf.T + slowWarmupLeftS(player, slowSrc);
        if (Number.isFinite(wheelLim) && est > wheelLim) {
          if (sloth) {
            // (LeashDriver.plainReason keys on "steering gas" in this text)
            return fail(slowSrc === 'wheels'
              ? `steering gas empty, the reaction wheels need ${player.slothTimeWords(est)} for that turn`
              : `emergency steering — steering gas empty, the tail boxes need ${player.slothTimeWords(est)} for that turn`);
          }
          slowSrc = null;                                       // with gas: the wheels are too slow for this caller's limit
        } else {
          prof = slowProf;
          slothEstS = est;
        }
      }
    }
    const slothTurn = slowSrc !== null;
    if (!slothTurn && turnGasShort(player, prof.gasEstimate)) {
      return fail('not enough steering gas');
    }
    const { sign, A, a, wp, ta, tc, T, mag, dir, k } = prof;

    // A slow source's own planning time is a floor under a caller's explicit limit (the reel-home tracked turn's 60 s
    // would abort a wheel turn accepted at an estimate of 55 s).
    const slowTimeoutS = 2 * slothEstS + 5 + Constants.SLOTH.AIM_SLACK_S;
    const timeoutS = (Number.isFinite(opts.timeoutS) && opts.timeoutS > 0) ? (slothTurn ? Math.max(opts.timeoutS, slowTimeoutS) : opts.timeoutS)
      : (slothTurn ? slowTimeoutS : T * 2 + 5);
    const holdS = (Number.isFinite(opts.holdS) && opts.holdS > 0) ? opts.holdS : 120;
    const holdOwner = opts.holdOwner || null;
    let track = typeof opts.track === 'function' ? opts.track : null;
    // A fixed-profile turn runs from a clock, so a clock that waits (cold cathodes, no power) would stop her spin for free:
    // on the boxes the turn runs closed loop on her real rate instead (`_tickTrackedTurn`); no power = no change of rate.
    const selfTrack = slothTurn && !track;

    return new Promise((resolve, reject) => {
      if (selfTrack) track = () => (this._turn ? this._turn.sign * this._turn.A - this._turn.progress : null);
      this._turn = {
        axis, sign, A, wp, a, ta, tc, T, qStart, mag, dir, k,
        t: 0,            // profile time
        wall: 0,         // time since the request (timeout clock)
        sloth: slothTurn,          // the slow eased law runs: the boxes (sloth mode) or the wheels turn her (always a tracked turn: `selfTrack`)
        src: slowSrc,              // 'tailBoxes' | 'wheels' | null (cold gas)
        nb: { x: nBody.x, y: nBody.y },   // the turn axis in the body frame (the wheels' room depends on its direction)
        timeoutS, holdS, holdOwner,
        gasUnits: 0,
        qRot: new THREE.Quaternion(),
        resolve, reject,
        track,
        omega: 0,        // tracked: signed rate about the axis (rad/s)
        progress: 0,     // tracked: signed angle turned so far (rad)
        stopRad: (Number.isFinite(opts.stopRad) && opts.stopRad > 0) ? opts.stopRad : TURN_TRACK_STOP_RAD,
        dirPos: { x: Math.sign(nBody.x) || 1, y: Math.sign(nBody.y) || 1 },   // couple signs that speed a POSITIVE turn up
      };
      this.holdAttitude(holdS, { owner: holdOwner });
      this._player.aimHold = true;
      eventBus.emit(Events.AIM_SEQUENCE_START, { mode: 'turn' });
      if (slothTurn) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: slowSrc === 'wheels'
            ? `Turning the ship on the reaction wheels (no steering gas used): ${player.slothTimeWords(slothEstS)}.`
            : `Emergency steering — turning slowly on the tail boxes: ${player.slothTimeWords(slothEstS)}.`,
          priority: slowSrc === 'wheels' ? 'info' : 'warning', source: 'HOUSTON',
        });
      }
    });
  }

  /**
   * Stop a running turn where it is (no snap). Rejects its promise with `reason`; the attitude hold stays on and the
   * caller releases it.
   * @returns {boolean} true if a turn was running
   */
  cancelAttitudeTurn(reason = 'Turn cancelled') {
    if (!this._turn) return false;
    this._rejectTurn(reason);
    return true;
  }

  /** @private Angle (rad, unsigned) the profile has covered at time `t`. */
  _turnAngleAt(c, t) {
    if (t <= 0) return 0;
    if (t >= c.T) return c.A;
    if (t < c.ta) return 0.5 * c.a * t * t;
    if (t < c.ta + c.tc) return 0.5 * c.a * c.ta * c.ta + c.wp * (t - c.ta);
    const r = c.T - t;
    return c.A - 0.5 * c.a * r * r;
  }

  /**
   * @private Fire one couple for `seconds` of burn and add the gas it bills to the turn. Below TURN_MIN_MAG the
   * magnitude is raised and the time shortened so fireRcsRotation's 0.01 billing floor cannot make a gentle ramp free.
   */
  _turnFire(c, name, sign, m, seconds) {
    const p = this._player;
    // Sloth mode: the box that gives the torque is lit for m × seconds of full output.
    // (the wheels: the same lit seconds move the wheel's stored spin the other way and go on the power bill)
    if (c.sloth) {
      slowLit(p, srcOf(c), name === 'pitch' ? 'x' : 'y', sign, m * seconds);
      return;
    }
    let fm = m, fdt = seconds;
    if (m < TURN_MIN_MAG) { fm = TURN_MIN_MAG; fdt = seconds * m / TURN_MIN_MAG; }
    if (typeof p.fireRcsRotation === 'function') p.fireRcsRotation(name, sign, fm, fdt);
    const gas = p.resources ? p.resources.coldGas : undefined;
    if (!(gas <= 0)) c.gasUnits += c.k * Math.min(1, m) * seconds; // empty tank bills nothing
  }

  _resolveTurn() {
    const c = this._turn;
    if (!c) return;
    this._turn = null;
    // Re-assert the hold (a stray releaseAttitudeHold mid-turn cleared the flag
    // but kept aimHold) and restart its clock: it counts from the END of the turn.
    this.holdAttitude(c.holdS, { owner: c.holdOwner });
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: 'turn', result: 'resolved' });
    c.resolve({ angleRad: c.track ? c.progress : c.sign * c.A, gasUnits: c.gasUnits, seconds: c.track ? c.wall : c.t });
  }

  _rejectTurn(reason) {
    const c = this._turn;
    if (!c) return;
    if (c.track) this._billTrackTail(c);                       // a real ship would still have to stop
    const progressRad = c.track ? c.progress : c.sign * this._turnAngleAt(c, c.t);
    this._turn = null;
    this.holdAttitude(c.holdS, { owner: c.holdOwner });
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: 'turn', result: 'rejected', reason });
    const err = new Error(reason);
    err.progressRad = progressRad;
    err.gasUnits = c.gasUnits;
    c.reject(err);
  }

  /** @private Called each frame from update() regardless of autopilot engagement, right after the aim coroutine. */
  _tickTurnCoroutine(dt) {
    const c = this._turn;
    if (!c || !this._player || !(dt > 0)) return;

    c.wall += dt;
    if (c.wall >= c.timeoutS) { this._rejectTurn('attitude turn timed out'); return; }
    if (c.track) { this._tickTrackedTurn(c, dt); return; }

    // (A sloth-mode turn never gets here: it is tracked, so its rate is real and a lack of power cannot stop it for free.)
    const t0 = c.t;
    const t1 = Math.min(t0 + dt, c.T);
    c.t = t1;
    c.qRot.setFromAxisAngle(c.axis, c.sign * this._turnAngleAt(c, t1));
    this._player.quaternion.copy(c.qRot).multiply(c.qStart);

    // Burn windows: [0, ta] accelerating, [T − ta, T] braking. Bill the overlap.
    const wAcc = Math.max(0, Math.min(t1, c.ta) - t0);
    const wBrk = Math.max(0, t1 - Math.max(t0, c.T - c.ta));
    if (wAcc > 0 || wBrk > 0) {
      for (let i = 0; i < TURN_COUPLES.length; i++) {
        const name = TURN_COUPLES[i][0], ax = TURN_COUPLES[i][1];
        const m = c.mag[ax];
        if (!(m > 0)) continue;
        if (wAcc > 0) this._turnFire(c, name, c.dir[ax], m, wAcc);
        if (wBrk > 0) this._turnFire(c, name, -c.dir[ax], m, wBrk);
      }
    }

    if (t1 >= c.T) this._resolveTurn();
  }

  /**
   * @private One frame of a TRACKED turn (`requestAttitudeTurn` with `opts.track`): the angle left is read live every
   * frame (`c.track()`: signed rad about the axis; null / NaN = stop here), so a target that moves while the mother
   * turns cannot make her overshoot. The rate follows the law of the eased aim (`_tickAimEased`), never above the peak
   * rate (5°/s, `c.wp`); a target on the other side of zero is first braked to rest. Ends at rest inside `c.stopRad`,
   * or after `track()` said stop.
   */
  _tickTrackedTurn(c, dt) {
    const aFull = c.a;
    // Sloth mode: the boxes' thrust fraction scales the rate change (0 while cold / no power / no gas); the burns below are
    // billed per full-output second (Δω / aFull).
    const a = c.sloth ? aFull * slowPeek(this._player, srcOf(c), c.mag.x + c.mag.y, dt) : aFull;
    const dOm = a * dt;
    let rem = null;
    try { rem = c.track(); } catch (e) { rem = null; }
    const live = Number.isFinite(rem);
    const left = live ? Math.abs(rem) : 0;
    if (c.sloth && live && left > c.stopRad) this._slothNoPowerNote(this._player, c, undefined, srcOf(c));
    const was = c.omega;
    if ((!live || left <= c.stopRad) && Math.abs(was) <= dOm + 1e-12) {      // at rest where she was told to stop
      if (was !== 0) this._fireTrackCouples(c, was > 0 ? -1 : 1, Math.abs(was) / aFull);   // the last of the brake
      c.omega = 0;
      this._resolveTurn();
      return;
    }
    const want = left > 0 ? 0.5 * (-dOm + Math.sqrt(dOm * dOm + 8 * a * left)) : 0;
    const target = (rem < 0 ? -1 : 1) * Math.min(c.wp, want);
    let now = clamp(target, was - dOm, was + dOm);
    // The wheels hold only so much: her rate may not climb past the room they have left in that direction (`wheelSpareRate`).
    if (c.src === 'wheels' && Math.abs(now) > Math.abs(was) && typeof this._player.wheelSpareRate === 'function') {
      const sg = now < 0 ? -1 : 1;
      const base = Math.sign(was) === sg ? Math.abs(was) : 0;
      const cap = base + this._player.wheelSpareRate(sg * c.nb.x, sg * c.nb.y);
      if (Math.abs(now) > cap) now = sg * Math.max(base, cap);
    }
    if (!c.sloth && Math.abs(now) > Math.abs(was)) {
      const cap = this._gasRateCap(c, c.k * (c.mag.x + c.mag.y) / aFull, Math.abs(was));
      if (Math.abs(now) > cap) { now = Math.sign(now) * Math.max(Math.abs(was), cap); this._noteGasCap(c); }
    }
    c.omega = now;
    const step = now * dt;                                            // the new rate over the frame, as the eased aim (the stop above is sized for it)
    if (step !== 0) {
      c.qRot.setFromAxisAngle(c.axis, step);
      this._player.quaternion.premultiply(c.qRot).normalize();
      c.progress += step;
    }
    if (now !== was) this._fireTrackCouples(c, now > was ? 1 : -1, Math.abs(now - was) / aFull);
  }

  /**
   * @private Keep gas to stop: the highest rate a cold-gas aim / turn may climb to this frame so that the tank still
   * holds STOP_RESERVE × the gas its own stop bills. `kappa` = steering gas per rad/s of this turn's brake
   * (k·(mx+my)/α: spin-up and stop price alike); climbing from `was` to `w` burns κ(w − was) and leaves a stop of κ·w, so
   * G − κ(w − was) ≥ R·κ·w  →  w ≤ (G + κ·was) / ((1+R)·κ).
   * @returns {number} rad/s (Infinity with no gas figure, e.g. a mock player)
   */
  _gasRateCap(c, kappa, was) {
    const G = this._player && this._player.resources ? this._player.resources.coldGas : undefined;
    if (!Number.isFinite(G) || !(kappa > 0)) return Infinity;
    const R = Constants.SLOTH.STOP_RESERVE;
    return Math.max(0, (G + kappa * was) / ((1 + R) * kappa));
  }

  /** @private The first time the gas cap holds a turn back: one line. */
  _noteGasCap(c) {
    if (c.capSaid) return;
    c.capSaid = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Steering gas low — turning slower to keep enough to stop.', priority: 'info', source: 'HOUSTON',
    });
  }

  /** @private Fire both couples of a tracked turn for `seconds` (sign +1 = speeding a positive turn up, −1 = braking it). */
  _fireTrackCouples(c, sign, seconds) {
    if (c.mag.x > 0) this._turnFire(c, 'pitch', sign * c.dirPos.x, c.mag.x, seconds);
    if (c.mag.y > 0) this._turnFire(c, 'yaw', sign * c.dirPos.y, c.mag.y, seconds);
  }

  _billTrackTail(c) {
    if (!c || !c.track || !(Math.abs(c.omega) > 0)) return;
    const seconds = Math.abs(c.omega) / c.a;
    const sign = c.omega > 0 ? -1 : 1;
    c.omega = 0;
    this._fireTrackCouples(c, sign, seconds);
  }

  /**
   * @private Per frame from update() regardless of autopilot engagement; resolves with the ACTUAL launcher direction at
   * convergence. A player that cannot say its inertia and couple torque (a headless stub) keeps the plain slerp below.
   */
  _tickAimCoroutine(dt) {
    const c = this._aimCoroutine;
    if (!c || !this._player) return;

    c.elapsed += dt;
    if (c.elapsed >= c.timeout) { this._rejectAim('attitude not held (timeout)', 'TIMEOUT'); return; }

    const raw = c.provider();
    if (!raw) { this._rejectAim('target lost', 'TARGET_LOST'); return; }
    const T = this._aimTargetDir.set(raw.x, raw.y, raw.z);
    if (T.lengthSq() < 1e-12) return; // degenerate this frame; wait
    T.normalize();

    if (c.eased === undefined) c.eased = this._aimCanEase();
    if (c.eased) { this._tickAimEased(c, T, dt); return; }

    const q = this._player.quaternion;

    // Resolve the boresight (launcher axis) in LOCAL frame.
    // net      → ship +Z.
    // daughter → physical strut fire dir (sinα·cos az, sinα·sin az, −cosα).
    let boresightLocalX = 0, boresightLocalY = 0, boresightLocalZ = 1;
    if (c.mode === 'daughter') {
      const az = this._aimAzimuth(c);

      this._aimInvQuat.copy(q).invert();
      const tl = this._aimLocalDir.copy(T).applyQuaternion(this._aimInvQuat);
      // The maximiser over [0, π], not a signed atan2 clamped: a target nearly dead ahead with a slightly negative
      // radial part gave atan2 ≈ −178° and the clamp made it 0° (strut aft) instead of ~180° (forward).
      const alphaDesired = bestStrutAlpha(tl, az);

      let alpha = alphaDesired;
      if (c.arm && typeof c.arm.setAimAlpha === 'function') {
        const ok = c.arm.setAimAlpha(alphaDesired, dt);
        if (ok === false) { this._rejectAim('hinge LOCKED — release the hinge brake [H]'); return; }
        if (typeof c.arm.getAimAlpha === 'function') alpha = c.arm.getAimAlpha();
      }
      strutLocalDirection(alpha, az, this._aimBoresightWorld);
      boresightLocalX = this._aimBoresightWorld.x;
      boresightLocalY = this._aimBoresightWorld.y;
      boresightLocalZ = this._aimBoresightWorld.z;
    }

    const b = this._aimBoresightWorld.set(boresightLocalX, boresightLocalY, boresightLocalZ)
      .applyQuaternion(q).normalize();

    const dot = Math.max(-1, Math.min(1, b.dot(T)));
    const errAngle = Math.acos(dot);

    if (errAngle <= c.tolRad) {
      this._resolveAim({ x: b.x, y: b.y, z: b.z });
      return;
    }

    this._aimDeltaQuat.setFromUnitVectors(b, T);
    this._aimTargetQuat.copy(this._aimDeltaQuat).multiply(q);

    const maxStep = c.rate * dt;
    const alphaSlerp = Math.min(maxStep / errAngle, 1.0);
    q.slerp(this._aimTargetQuat, alphaSlerp);
    q.normalize();

    // Plumes + N₂ draw (feel only; a player that cannot say its inertia / couple torque): decompose the error
    // rotation axis into local pitch (X) / yaw (Y) components to pick nozzles; full throttle until the last 10°.
    this._aimErrAxis.crossVectors(b, T);
    if (this._aimErrAxis.lengthSq() > 1e-12) {
      this._aimInvQuat.copy(q).invert();
      const axLocal = this._aimErrAxis.applyQuaternion(this._aimInvQuat).normalize();
      const mag = Math.min(1, errAngle / degToRad(10));
      const pitchSign = axLocal.x >= 0 ? 1 : -1;
      const yawSign = axLocal.y >= 0 ? 1 : -1;
      const pMag = Math.abs(axLocal.x) * mag;
      const yMag = Math.abs(axLocal.y) * mag;
      if (pMag > 0.02) {
        this._player.fireRcsRotation('pitch', pitchSign, pMag, dt);
      }
      if (yMag > 0.02) {
        this._player.fireRcsRotation('yaw', yawSign, yMag, dt);
      }
    }
  }

  /** @private The dock azimuth (rad) of the daughter's pair, resolved once from the dock geometry. */
  _aimAzimuth(c) {
    if (c.azRad == null && c.armManager && c.armManager._dockPositions && c.pairIndex != null) {
      const dp = c.armManager._dockPositions[c.pairIndex];
      c.azRad = dp ? degToRad(dp.azimuthDeg) : 0;
    }
    return c.azRad || 0;
  }

  /**
   * @private Can the aim be eased? The player must say its inertia and its pitch / yaw couple torque (the rate law needs
   * the angular acceleration). A stub without them keeps the plain slerp.
   * @returns {boolean}
   */
  _aimCanEase() {
    const p = this._player;
    if (typeof p.getAttitudeInertia !== 'function' || typeof p._coupleTauMag !== 'function') return false;
    const I = p.getAttitudeInertia();
    return !!I && I.ixx > 0 && I.iyy > 0 && p._coupleTauMag('x') > 0 && p._coupleTauMag('y') > 0;
  }

  /**
   * @private One frame of the eased aim (launch and net aims alike).
   * owner 2026-10-18: arm aims and mother turns could be improved (eased, not a constant rate).
   *
   * The mother's rate ω climbs at the angular acceleration of her slowest couple (α = torque / inertia about the turn
   * axis, as `requestAttitudeTurn`), coasts at the aim's peak rate, and slows so that it reaches 0 as she gets to the
   * target (derivation at `want` below). Gas is billed by torque × time from the same ω.
   * Strut: the strut angle her boresight is aimed for is fixed when the aim starts (the live optimum moves with her
   * attitude and would chase its own tail); the mother turns the rest (the error out of the strut's plane). The aim
   * lasts max(her turn, the strut's shortest eased move); if the strut needs longer her peak rate is lowered so both
   * end together, and the strut's move (`setAimAlpha`'s `ease`) lasts that long. She never goes above AP_ROT_RATE.
   * The aim resolves once the strut is there, she is within the tolerance and at rest.
   * @param {THREE.Vector3} T — target direction in the world (unit)
   */
  _tickAimEased(c, T, dt) {
    const p = this._player;
    const q = p.quaternion;
    const daughter = c.mode === 'daughter';
    const arm = (daughter && c.arm && typeof c.arm.setAimAlpha === 'function') ? c.arm : null;
    // The second strut of the pair swings with the first to the one angle; her boresight is her barrel (+z), not a strut's line
    const pairB = (daughter && c.pair && c.pair.armB && typeof c.pair.armB.setAimAlpha === 'function') ? c.pair.armB : null;
    const az = daughter ? this._aimAzimuth(c) : 0;

    let alphaT = 0;
    if (daughter && c.pair) {
      alphaT = c.alphaF;
    } else if (daughter) {
      if (arm && c.alphaF !== undefined) {
        alphaT = c.alphaF;
      } else {
        this._aimInvQuat.copy(q).invert();
        const tl = this._aimLocalDir.copy(T).applyQuaternion(this._aimInvQuat);
        alphaT = bestStrutAlpha(tl, az);                               // not a signed atan2 clamped: wrong dead ahead
        if (arm) c.alphaF = alphaT;
      }
    }
    const bm = this._aimBm;
    if (daughter && !c.pair) strutLocalDirection(alphaT, az, bm); else bm.set(0, 0, 1);
    bm.applyQuaternion(q).normalize();
    const errM = Math.acos(Math.max(-1, Math.min(1, bm.dot(T))));      // what is left for her to turn

    // A wheel aim is judged while it runs; one the gas takes over carries on below as a gas aim (same frame, gas torque).
    if (c.src === 'wheels' && c.law !== undefined) this._aimWheelWatch(c, bm, T, errM);

    const aFull = this._aimAccel(c, bm, T);
    if (!(aFull > 0)) return;
    // Sloth mode: the boxes' thrust fraction scales the acceleration (0 while the cathodes warm, or with no power / engine
    // gas: she waits); burns are billed per full-output second (Δω / aFull). At rest and inside the tolerance there is
    // nothing to turn: the boxes are not asked (no warm-up, no power or engine gas drawn) and the aim resolves below.
    const noTurn = c.sloth && !(c.omega > 0) && errM <= c.tolRad;
    const a = c.sloth ? (noTurn ? 0 : aFull * slowPeek(p, srcOf(c), c.burn.mx + c.burn.my, dt)) : aFull;
    if (c.sloth && !noTurn) this._slothNoPowerNote(p, c, undefined, srcOf(c));   // no power / no engine gas: she waits, and says so once

    if (c.law === undefined) {
      c.law = true;
      c.omega = 0;                                                     // her rate along the turn axis (rad/s)
      c.gasUnits = 0;
      c.k = (p._coldGasRate ?? 0.5) * (Constants.ATTITUDE?.RCS_ATTITUDE_N2_FACTOR ?? 0.3);
      const kap = c.k * (c.burn.mx + c.burn.my) / aFull;
      // the wheels' room in this direction caps the peak (spare momentum / I); the boxes have none; the gas holds its own cap
      const capStart = c.sloth ? (c.src === 'wheels' ? p.wheelSpareRate(c.axX, c.axY) : Infinity) : this._gasRateCap(c, kap, 0);
      const vCap = Math.min(c.rate, capStart);                         // today's peak (AP_ROT_RATE): never above it
      if (!c.sloth && capStart < c.rate) this._noteGasCap(c);          // the tank holds the peak below today's: say so once (the wheels' room is not the tank)
      const theta = Math.max(0, errM - c.stopErr);
      const tM = theta <= 0 ? 0 : (theta >= vCap * vCap / aFull ? theta / vCap + vCap / aFull : 2 * Math.sqrt(theta / aFull));
      let tS = 0;
      for (const sa of (pairB ? [arm, pairB] : [arm])) {
        if (!sa) continue;
        tS = Math.max(tS, (typeof sa.aimEaseMinTime === 'function')
          ? sa.aimEaseMinTime(alphaT)
          : Math.abs(alphaT - (sa.getAimAlpha ? sa.getAimAlpha() : alphaT)) / Constants.OCTOPUS_V5.AIM_TURN_STRUT_PACE);
      }
      c.vCap = vCap;
      c.vPeak = vCap;
      if (tS > tM && theta > 0) {                                      // the strut needs longer: slow her peak
        c.vPeak = Math.min(vCap, 0.5 * aFull * (tS - Math.sqrt(Math.max(0, tS * tS - 4 * theta / aFull))));
      }
      c.tPlan = Math.max(tM, tS);
      if (c.sloth || vCap < c.rate) c.timeout = Math.max(c.timeout, 2 * c.tPlan + (c.sloth ? slowWarmupLeftS(p, srcOf(c)) : 0) + Constants.SLOTH.AIM_SLACK_S);
      c.ease = (arm && tS > 0) ? { durationS: c.tPlan } : null;
    }

    let strutDone = true;
    if (arm) {
      const before = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : 0;
      const ok = arm.setAimAlpha(c.alphaF, dt, c.ease || undefined);
      if (ok === false) { this._rejectAim('hinge LOCKED — release the hinge brake [H]'); return; }
      if (typeof arm.getAimAlpha === 'function') {
        strutDone = Math.abs(arm.getAimAlpha() - c.alphaF) < 1e-6;
        c.strutStep = dt > 0 ? (arm.getAimAlpha() - before) / dt : 0;   // the strut's rate this frame (signed, rad/s), for a hand-over
      }
      if (pairB) {                                                      // the other strut of the pair, the same move
        const beforeB = typeof pairB.getAimAlpha === 'function' ? pairB.getAimAlpha() : 0;
        const okB = pairB.setAimAlpha(c.alphaF, dt, c.ease || undefined);
        if (okB === false) { this._rejectAim('hinge LOCKED — release the hinge brake [H]'); return; }
        if (typeof pairB.getAimAlpha === 'function') {
          strutDone = strutDone && Math.abs(pairB.getAimAlpha() - c.alphaF) < 1e-6;
          c.strutStepB = dt > 0 ? (pairB.getAimAlpha() - beforeB) / dt : 0;
        }
      }
    }

    // Her rate: the largest ω she can still stop from inside the angle left (stopping at c.stopErr from the target),
    // limited to ±α·dt per frame and to the peak. Frames of a stop run ω−δ, ω−2δ, … (δ = α·dt), so the angle one
    // step ω·dt plus that stop covers is ω·dt + ω(ω−δ)/2α; solve for ω.
    const dOm = a * dt;

    // How fast the aim direction itself turns (rad/s). T is the shared scratch vector (rewritten every frame), so the
    // previous one is a per-aim clone. A drifting piece's line of sight keeps her turning at its rate with the error just
    // above stopErr, so "at rest" (now <= 0) never came and the aim ran to the timeout, burning gas; a pointing
    // controller is on target when within tolerance and matching the target's motion.
    let wT = 0;
    if (c.pT) {
      if (dt > 0) wT = Math.acos(Math.max(-1, Math.min(1, c.pT.dot(T)))) / dt;
      // Wheels only. Two readings of the bearing's turn, both smoothed over LOS_TAU_S (a running mean first) and not read
      // until a stateful provider has settled: `wLos` = its whole rate (what the wheels must out-turn: a drift across her
      // error axis counts in full), `wFf` = the part that carries the bearing away from her boresight along the error
      // (feed-forward; g = unit tangent at T pointing away from bm), the rest she picks up as the error swings round.
      if (c.src === 'wheels' && dt > 0 && c.elapsed >= Constants.WHEELS.LOS_SETTLE_S) {
        c.losN = (c.losN || 0) + 1;
        const k = Math.max(dt / Constants.WHEELS.LOS_TAU_S, 1 / c.losN);
        c.wLos += (wT - c.wLos) * k;
        const cosE = bm.dot(T), sinE = Math.sqrt(Math.max(0, 1 - cosE * cosE));
        if (sinE > 1e-6) {
          const wRad = ((T.x - c.pT.x) * (T.x * cosE - bm.x) + (T.y - c.pT.y) * (T.y * cosE - bm.y) + (T.z - c.pT.z) * (T.z * cosE - bm.z)) / (sinE * dt);
          c.wFf += (wRad - c.wFf) * k;
        }
      }
      c.pT.copy(T);
    } else {
      c.pT = T.clone();
    }
    // ...but only once she has stayed inside the tolerance for AIM_TRACK_DWELL_S: the lead aim moves with her own braking
    // (the net inherits her muzzle's speed), so even a still piece shows wT > 1e-4 near the end of every turn, and the
    // relaxation must not cut that stop short (measured: the end of a still-piece turn is unchanged).
    c.inTolS = (strutDone && errM <= c.tolRad) ? c.inTolS + dt : 0;
    const slack = (wT > 1e-4 && c.inTolS >= AIM_TRACK_DWELL_S) ? wT + Math.min(dOm, AIM_TRACK_SLACK_MAX) : 0;
    const rem = errM - c.stopErr;
    // On the wheels she is to MATCH the bearing's turn rate when she gets there, not stop at it (her stop distance
    // v²/2α is far over the tolerance at the wheels' small α, so a drifting piece outran every stop): the same law in the
    // frame of the moving bearing, `ff` on top of the closing rate. Only a bearing running away counts (ff ≥ 0), and never
    // more than its whole rate: `wFf` is not updated while she is exactly on the bearing (no error direction to read it
    // along), so a stale value would stand as a feed-forward the bearing no longer has.
    const ff = (c.src === 'wheels' && c.wFf > 0) ? Math.min(c.wFf, c.wLos) : 0;
    // An aim the strut held back (her peak stretched to the strut's time, `vPeak` < `vCap`) whose strut arrives with her
    // still inside the tolerance stops where she is: climbing to the stop-capable rate for the last hundredth of a degree
    // spiked the gas and, with the cruise near zero, could stall for the whole time-out.
    const stopHere = strutDone && c.vPeak < c.vCap && a > 0 && errM + c.omega * c.omega / (2 * a) <= c.tolRad;
    const want = (stopHere ? 0 : (rem > 0 ? 0.5 * (-dOm + Math.sqrt(dOm * dOm + 8 * a * rem)) : 0)) + ff;
    const was = c.omega;
    const lo = Math.max(0, was - dOm);
    let vLim = strutDone ? c.vCap : c.vPeak;                           // once the strut is there nothing is left to wait for
    if (c.src === 'wheels') vLim = Math.min(vLim, was + p.wheelSpareRate(c.axX, c.axY));   // the wheels' room left (they fill as she turns)
    let now = Math.min(Math.max(want, lo), clamp(was + dOm, lo, vLim));
    if (!c.sloth && now > was) {
      const cap = this._gasRateCap(c, c.k * (c.burn.mx + c.burn.my) / aFull, was);
      if (now > cap) { now = Math.max(was, cap); this._noteGasCap(c); }
    }

    // At rest is "no rate left to name": on the wheels the brake ends on a feed-forward of the bearing's own tiny rate, never exactly 0.
    if (strutDone && errM <= c.tolRad && now <= Math.max(slack, c.src === 'wheels' ? AIM_REST_EPS : 0)) {
      if (was > 0) this._fireAimCouples(c, -1, was / aFull);           // the last of the brake
      c.omega = 0;
      this._resolveAim({ x: bm.x, y: bm.y, z: bm.z });                 // strut is there: this IS the launcher axis
      return;
    }

    c.omega = now;
    if (now !== was) this._fireAimCouples(c, now > was ? 1 : -1, Math.abs(now - was) / aFull);
    const step = Math.min(now * dt, errM);
    if (step > 0 && errM > 1e-9) {
      this._aimDeltaQuat.setFromUnitVectors(bm, T);
      this._aimTargetQuat.copy(this._aimDeltaQuat).multiply(q);
      q.slerp(this._aimTargetQuat, step / errM);
      q.normalize();
    }
  }

  /**
   * @private The wheels' aim watch (once the law is running; only with steering gas above sloth's floor; with the gas out
   * the wheels are all she has and the plan's time-out stands):
   *  - from LOS_CHECK_S on, every LOS_RECHECK_S, ask the selector again with the bearing's measured turn rate (`c.wLos`):
   *    it says gas when the wheels' room does not cover that rate LOS_COVER times over;
   *  - the same look holds the aim to its 30 s (`c.limitS`): the planned time plus the time the drift adds, from her rate now;
   *  - an aim not converged by AIM_HANDOVER_X x its plan + AIM_HANDOVER_S goes to the gas, whatever the cause.
   * A look inside the tolerance does not hand over (she is on the bearing; only the plan's time can).
   */
  _aimWheelWatch(c, bm, T, errM) {
    const p = this._player, W = Constants.WHEELS;
    if (typeof p.isSlothMode !== 'function' || p.isSlothMode()) return;
    let why = null;
    if (c.elapsed >= c.handAt) why = 'late';
    else if (c.elapsed >= W.LOS_CHECK_S && c.elapsed - c.losAt >= W.LOS_RECHECK_S && errM > c.tolRad) {
      c.losAt = c.elapsed;
      const sel = p.attitudeTorqueSource({
        spinUp: true, angleRad: errM, nx: c.axX, ny: c.axY, limitS: Infinity,   // the rate cover only: the 30 s is judged below (from her rate now)
        losRateRadS: Math.max(0, c.wLos), rateRadS: c.omega, quiet: true,
      });
      if (sel !== 'wheels') why = 'drift';
      else if (c.wLos > 0) {
        // The 30 s the wheels were chosen for (c.limitS) counts the drift too, which the start could not see: check at every
        // look the plan of the angle (c.estS, which passed) plus what the drift adds from where she is now (chase from her
        // present rate with the drift, minus without it). Over the limit -> the gas takes it now, not at the handover deadline.
        const extra = p.wheelChaseTimeS(errM, c.axX, c.axY, c.wLos, c.omega) - p.wheelChaseTimeS(errM, c.axX, c.axY, 0, c.omega);
        if (!(c.estS + extra <= c.limitS)) why = 'long';
        else if (!c.chased) {
          // the plan of a chase is longer than the plan of the angle: the handover deadline is set from it, once (a
          // stalled chase must not push its own deadline away)
          c.chased = true;
          const tc = p.wheelChaseTimeS(errM, c.axX, c.axY, c.wLos);
          if (Number.isFinite(tc)) c.handAt = Math.max(c.handAt, W.AIM_HANDOVER_X * (c.elapsed + tc) + W.AIM_HANDOVER_S);
        }
      }
    }
    if (why) this._aimToGas(c, bm, T);
  }

  /**
   * @private A wheel aim goes on as a gas aim from the rate she has now: the wheels keep the spin the turn put in them,
   * the gas brakes her at its real price and finishes the aim on its own law. The one line is the gas aim's own.
   */
  _aimToGas(c, bm, T) {
    const p = this._player;
    c.src = null;
    c.sloth = false;
    c.k = (p._coldGasRate ?? 0.5) * (Constants.ATTITUDE?.RCS_ATTITUDE_N2_FACTOR ?? 0.3);
    const aG = this._aimAccel(c, bm, T);
    c.vCap = c.rate;
    if (aG > 0) {
      const cap = this._gasRateCap(c, c.k * (c.burn.mx + c.burn.my) / aG, c.omega);
      c.vCap = Math.min(c.rate, cap);
      if (cap < c.rate) this._noteGasCap(c);
    }
    c.vPeak = c.vCap;
    // The gas aim's own law stretches her peak so she and the strut arrive together (`_tickAimEased`, at its start): a gas
    // aim taking over from the wheels does the same from where it stands, with the strut's quickest move from here (a new
    // ease). Without it the gas turned the rest at the full peak and waited for the strut's slow wheel-length move.
    const arm = (c.mode === 'daughter' && c.arm && typeof c.arm.setAimAlpha === 'function' && c.alphaF !== undefined) ? c.arm : null;
    // The pair's second strut makes the same hand-over move (its own rate carried on)
    const armB = (arm && c.pair && c.pair.armB && typeof c.pair.armB.setAimAlpha === 'function') ? c.pair.armB : null;
    if (aG > 0 && arm) {
      const theta = Math.max(0, Math.acos(Math.max(-1, Math.min(1, bm.dot(T)))) - c.stopErr);
      const vCap = c.vCap;
      const tM = theta <= 0 ? 0 : (theta >= vCap * vCap / aG ? theta / vCap + vCap / aG : 2 * Math.sqrt(theta / aG));
      // The strut is mid-swing (a wheel aim keeps it moving at the pace of its long plan): the new, quicker move carries
      // on from the rate it has (a move from rest stopped it dead and it jerked up again)
      const V5 = Constants.OCTOPUS_V5;
      const target = Math.max(V5.STRUT_SWEEP_MIN, Math.min(c.alphaF, V5.STRUT_SWEEP_MAX));
      const moves = [arm, armB].filter(Boolean).map((sa, k) => {
        const a0 = sa.getAimAlpha ? sa.getAimAlpha() : c.alphaF;
        const sign = target >= a0 ? 1 : -1;
        const rate = k === 0 ? c.strutStep : c.strutStepB;
        const v0 = Number.isFinite(rate) ? Math.max(0, sign * rate) : 0;
        let carry = null;
        if (v0 > 1e-4 && Math.abs(target - a0) > 1e-9 && V5.STRUT_EASE_ACCEL > 0) carry = strutCarryProfile(Math.abs(target - a0), v0, V5.STRUT_EASE_ACCEL, V5.AIM_TURN_STRUT_PACE, 0);
        const tS = carry ? carry.minS
          : ((typeof sa.aimEaseMinTime === 'function') ? sa.aimEaseMinTime(c.alphaF) : Math.abs(c.alphaF - a0) / V5.AIM_TURN_STRUT_PACE);
        return { sa, a0, sign, v0, carry, tS };
      });
      const tS = Math.max(...moves.map((m) => m.tS));
      if (tS > tM && theta > 0) c.vPeak = Math.min(vCap, 0.5 * aG * (tS - Math.sqrt(Math.max(0, tS * tS - 4 * theta / aG))));
      c.ease = tS > 0 ? { durationS: Math.max(tM, tS) } : null;
      if (c.ease) {
        for (const m of moves) {
          if (!m.carry) continue;
          const prof = strutCarryProfile(Math.abs(target - m.a0), m.v0, V5.STRUT_EASE_ACCEL, V5.AIM_TURN_STRUT_PACE, c.ease.durationS);
          // the arm's own move record (ArmUnit.setAimAlpha keys it by the ease object and the target), entered mid-way
          m.sa._aimEase = {
            src: c.ease, from: m.a0 - m.sign * prof.s0, to: target, sign: m.sign, d: prof.d, a: V5.STRUT_EASE_ACCEL, v: prof.v, T: prof.T, t: prof.t0,
          };
        }
      }
      c.handTS = tS;                                                   // the line below prices the stretched aim
    }
    c.timeout = c.elapsed + Constants.AIM.AIM_TIMEOUT_S;
    c.handedToGas = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: (c.mode === 'daughter' && c.shot) ? this._shotHandedLine(c, bm, T) : `Turning the ship to line up the launch. About ${Math.ceil(Math.PI / c.rate)} s at most.`,
      priority: 'info', source: 'HOUSTON', _keep: true,
    });
  }

  /**
   * @private The angular acceleration (rad/s²) she turns with about the axis that takes `bm` onto `T` — her slowest
   * couple's torque / inertia — and the firing fraction of each couple during a burn, kept on `c.burn`.
   * @returns {number} α, or 0 when the player cannot say it
   */
  _aimAccel(c, bm, T) {
    const p = this._player;
    const err = this._aimErrAxis.crossVectors(bm, T);
    if (err.lengthSq() > 1e-12) {
      this._aimInvQuat.copy(p.quaternion).invert();
      const ax = err.applyQuaternion(this._aimInvQuat).normalize();
      c.axX = ax.x; c.axY = ax.y;
    } else if (c.axX === undefined) {
      c.axX = 1; c.axY = 0;                                            // no turn axis yet (aligned): any, nothing burns
    }
    const I = p.getAttitudeInertia();
    // sloth mode: the torque is the tail boxes' (the source was chosen when the aim started)
    const tauX = c.sloth ? slowTau(p, srcOf(c), 'x') : p._coupleTauMag('x');
    const tauY = c.sloth ? slowTau(p, srcOf(c), 'y') : p._coupleTauMag('y');
    const cx = Math.abs(c.axX), cy = Math.abs(c.axY);
    let a = Infinity;                                                  // slowest couple sets the angular acceleration
    if (cx > 1e-6) a = Math.min(a, tauX / (I.ixx * cx));
    if (cy > 1e-6) a = Math.min(a, tauY / (I.iyy * cy));
    // A turn about the roll axis alone (no pitch / yaw part: boresight in the xy plane): the slower of the two
    // couples stands for it, so the aim never waits on an acceleration it cannot name (no burn is billed then).
    if (!Number.isFinite(a)) a = Math.min(tauX / I.ixx, tauY / I.iyy);
    if (!Number.isFinite(a) || !(a > 0)) return 0;

    // Firing fraction of each couple during a burn (as requestAttitudeTurn); a sliver on the minor couple folds in.
    let mx = cx > 1e-6 ? I.ixx * a * cx / tauX : 0;
    let my = cy > 1e-6 ? I.iyy * a * cy / tauY : 0;
    if (mx >= my) { if (my > 0 && my <= TURN_MIN_MAG) { mx += my; my = 0; } }
    else if (mx > 0 && mx <= TURN_MIN_MAG) { my += mx; mx = 0; }
    const burn = c.burn || (c.burn = { mx: 0, my: 0, dx: 1, dy: 1, a: 0 });
    burn.mx = Math.min(1, mx); burn.my = Math.min(1, my);
    burn.dx = c.axX >= 0 ? 1 : -1; burn.dy = c.axY >= 0 ? 1 : -1; burn.a = a;
    return a;
  }

  /** @private Fire both couples of the last burn for `seconds` (sign −1 = against the turn). */
  _fireAimCouples(c, sign, seconds) {
    const burn = c.burn;
    if (burn.mx > 0) this._turnFire(c, 'pitch', sign * burn.dx, burn.mx, seconds);
    if (burn.my > 0) this._turnFire(c, 'yaw', sign * burn.dy, burn.my, seconds);
  }

  /** @private The aim ends while the rate is above zero: bill the rest of the brake (ω/α s against the turn), zero the rate. */
  _billAimTail(c) {
    if (!c || !(c.omega > 0) || !c.burn || !(c.burn.a > 0)) return;
    const seconds = c.omega / c.burn.a;
    c.omega = 0;
    this._fireAimCouples(c, -1, seconds);
  }
}
