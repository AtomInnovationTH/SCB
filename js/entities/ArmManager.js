/**
 * ArmManager.js — manages the V5 Crossbow arm fleet: deployments, recalls, dual-fire, pulse scan, HUD status.
 * Tier-aware: Y0 Quad (4), Y1 Hex (6), Y3 Octo (6 ring + 2 end-face).
 * Arms hinge at the top collar (Y = +1.00 m), sweep 0–180° in meridian planes.
 * @module entities/ArmManager
 */

import * as THREE from 'three';
import { Constants, isArmAttachedToMother } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import { checkActiveSatArming } from '../systems/ActiveSatGuard.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { strutTipMeters, heldCargoPlumeConflictAt, heldCargoFoulsCorridorAt, suggestCargoArm } from '../systems/CoMCalculator.js';
import { seatHullClear, seatHullPrime } from '../systems/SeatHullClear.js';
import { armProfile, profileClearAt, profileValid, startProfile, stepProfile, kitFor, kitStep } from '../systems/HoldWingClear.js';
// a pending BIG piece leaves the ledger when its rack drops it (reset), and is never 'paid' for the unload
import { bigPieces } from '../systems/BigPieces.js';
import { strutTipFoulsCorridor, strutLocalDirection, bestStrutAlpha } from './ArmDockBasis.js';
import { createShipKeepOut } from '../systems/ShipKeepOut.js';
import { StrutAutoController } from '../systems/StrutAuto.js';
import { reseatOrbitFromScene } from './OrbitalMechanics.js';
import { ArmUnit, planeTurnLeftRad } from './ArmUnit.js';
import { DebrisField } from './DebrisField.js';
import { clearRackCell, berthAnchorLocalInto, catchHomeDistM, homeShapeKey, isInspectOnlyMass } from './CaptureNet.js';
import { noseBucketFor, noseRadiatorsOk, noseWindowSpans } from './NoseRoute.js';
import { tripRefuses } from '../systems/TransferTrip.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import {
  pieceClaim, isFree, linesCross, lineWrapsShip, pieceIsCaught,
  launchRefusalLine, crossNamedStrutLine, crossNoneClearLine, launchDroppedLine, launchCrossDroppedLine,
  fanOutLine, fanOutNoneLine, stayedLine, reachNoneLine, heavyNoneLine, holdsStillLine, netIsOut,
  pairNoneLine, pairNeedsTurnLine, pairNotReadyLine, pairDroppedLine, pairHeldLine, pairDriftLine, pairCrossLine, pairStrutLine, pairRangeLine, pairErrorLine, pairHoldLine,
} from '../systems/PieceClaim.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, engineGasLowFrac, coldGasPoolToKg } from '../systems/ResourceSystem.js';
import { DEG2RAD, RAD2DEG, degToRad, radToDeg, clamp01, clamp } from '../core/MathUtil.js';

/** 1 meter in scene units */
const M = 0.00001;
/** A daughter's ion fuel is a percentage (the Daughter Fuel Reserve upgrade lifts a full tank to 150 %); a saved level is clamped to this. */
const SUPPLY_FUEL_MAX_PCT = 200;

const _rhInvQ = new THREE.Quaternion();
const _rhGapA = new THREE.Vector3();
const _rhGapB = new THREE.Vector3();
const _rhAxisR = new THREE.Vector3();
const _rhTurnP = new THREE.Vector3();      // her place in the ship's frame, from the ship's centre
const _rhTurnQ = new THREE.Quaternion();

// Safety-net release (s): LASSO_CAPTURED's adoption (CaptureNetSystem.adoptLassoCatch) deliberately does not emit
// NET_BERTHED, so a ducked arm on that path never sees the release event. Longer than the duck sweep AND the lasso's ~3 s
// reel-in: a duck can never strand a strut ducked forever, whichever capture path resolved it.
const LEAN_ASIDE_TIMEOUT_S = 8;

/** How long a daughter waits for her neighbours' lift before she gives up (s), and how often she asks `carryCheck` meanwhile. */
const LIFT_WAIT_MAX_S = 20;
const LIFT_POLL_S = 0.25;

const _aimTmpWanted = new THREE.Vector3();
const _aimTmpAxis = new THREE.Vector3();
const AIM_TOL_RAD = DEG2RAD;
/** A new best angle replaces the one she is swinging to only if it points the strut this much closer (rad, 0.5°). */
const AIM_GAIN_RAD = degToRad(0.5);
/** How many times the aim stage may REVERSE its aim (follow a best angle that flipped back) before it commits. */
const AIM_MAX_REAIMS = 4;
/** Catch states in which the mother holds (or is taking in) a catch whose berth corridor a strut must not enter. */
const AIM_CATCH_HELD_STATES = ['CINCH_CLOSING', 'SECURE_CHECK', 'CAPTURED', 'REELING', 'BERTHED', 'COLLARED', 'TRANSFERRING'];

/** The "." toggle's live sweep read (mirrored in toggleStruts / strutsDeployed): a pending `_strutTargetAlpha` latch wins,
 *  else the ACTUAL angle - never the latch alone, which clears to undefined once the slew finishes. @private */
const _strutLiveAlpha = (a) =>
  a._strutTargetAlpha ?? (a.getAimAlpha ? a.getAimAlpha() : 0);

/**
 * The turn (rad, signed; turning the ship by +t moves her angle by +t) that brings a daughter's angle in her strut's swing plane
 * inside the strut's range [STRUT_MIN_DEG, STRUT_MAX_DEG]; 0 when she is inside it. `v` is the direction hinge -> her, ship-local,
 * `az` the strut's azimuth. The ONE piece of maths the mother's floor turn (`_tickReelHomeTurn`) and the hold that waits for it
 * (`reelHoldReason`) both read, so they never disagree.
 * @param {{x:number,y:number,z:number}} v
 * @param {number} az
 * @param {object} RH Constants.REEL_HOME
 * @returns {number}
 */
function _rhFloorTheta(v, az, RH) {
  const lo = (RH.STRUT_MIN_DEG ?? 34) * DEG2RAD;
  const hi = (RH.STRUT_MAX_DEG ?? 180) * DEG2RAD;
  const phi = Math.atan2(v.x * Math.cos(az) + v.y * Math.sin(az), -v.z);   // her angle in the strut's plane
  if (phi >= lo && phi <= hi) return 0;
  const wrap = (x) => { while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };
  const toLo = wrap(lo - phi);
  const toHi = wrap(hi - phi);
  return Math.abs(toLo) <= Math.abs(toHi) ? toLo : toHi;
}

/**
 * The first strut angle (deg) from `startDeg` on the `stepDeg` grid, below `hiDeg`, at which `conflictAt(deg)` is false, then
 * `hiDeg` itself LAST (a grid that does not land on it must still try it: the pose cap is a pose too); null = none. The same
 * walk as `_holdPoseOf` / `_neighbourLiftRad`. Exported for the test.
 * @param {number} startDeg
 * @param {number} hiDeg
 * @param {number} stepDeg
 * @param {(deg:number)=>boolean} conflictAt
 * @returns {number|null}
 */
export function firstClearPoseDeg(startDeg, hiDeg, stepDeg, conflictAt) {
  for (let deg = startDeg; deg < hiDeg; deg += stepDeg) if (!conflictAt(deg)) return deg;
  return startDeg <= hiDeg && !conflictAt(hiDeg) ? hiDeg : null;
}

/**
 * The key a holder's pose caches read: what she holds, where it sits on her, and whether its wing profile (HoldWingClear) is
 * done, so a pose moves the frame the profile lands.
 * @param {object} arm
 * @returns {string}
 */
function _rackKey(arm) {
  let key = '';
  if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) if (h) key += `${h.id}:${h.sizeMeter}:${h._rackCell}:${h._wingClear ? (h._wingClear.done ? 'd' : 'p') : '-'};`;
  return key;
}

/** Is her catch `rest`-clear of the radiator wings with her strut at `deg`? True when she has no finished profile (none started, or pending). */
function _wingRestOk(arm, deg) {
  const p = armProfile(arm);
  return p.state !== 2 || profileClearAt(p, 'rest', deg);
}

/**
 * The lowest strut angle (deg, on the 5° hold-pose grid) at which a docked holder's catch of `sizeM` stays out of the radiator
 * wings' way in the band (measured). A table, never a mesh sweep at runtime.
 * @param {number} sizeM her biggest catch (m); 0 = unknown -> the deepest row
 * @param {object} R Constants.REEL_HOLD
 * @returns {number}
 */
function _bandClearDeg(sizeM, R) {
  const rows = R.CLEAR_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) return R.LIFT_DEG ?? 69;
  if (!(sizeM > 0)) return rows[rows.length - 1][1];
  for (const [maxSize, deg] of rows) if (sizeM <= maxSize + 1e-9) return deg;
  return rows[rows.length - 1][1];
}

/**
 * The strut angle a daughter holding a catch rests at: the lowest of 34° (STRUT_REST_ALPHA), 39°, 44° ... 99°, then 100°
 * (HOLD_POSE_MAX_DEG), at which her catch is clear of every thruster plume - the exact box check (`heldCargoPlumeConflictAt`) at
 * THAT angle, not the size-ladder floor (`PLUME_CARGO_ALPHA_LADDER` is the worst case over every rack attitude plus 10°; a held
 * catch's attitude in her frame is frozen at the stow, so the exact read is the real answer). Never above 100°: the mother net's
 * berth corridor is clear of a strut tip for every inbound size up to there. If nothing clears (not seen for catches up to 5 m),
 * 100° with `tooBig`. Pure read; null when she holds nothing. A module function (not a method) so `ArmManager.toggleStruts`, which
 * runs on bare stub objects in tests, can call it without `this.method()`.
 *
 * Once her catch's wing profile is done a pose must also be `rest`-clear (HoldWingClear: `REEL_HOLD.CLEAR_M` off every radiator
 * part at every wing angle outside the band). When some pose is plume-clear but none is wing-clear the answer is
 * `wingBlocked: true`: she parks at the highest plume-clear pose and the net / C rules take over (`motherNetHolderBlock`,
 * `_radiatorMoveGate`). A profile still pending (`wingPending`) leaves the plume-only answer.
 * @param {object} mgr an ArmManager (arms[], _dockPositions[], playerSatellite)
 * @param {number} armIndex
 * @returns {{rad:number, tooBig:boolean, wingBlocked?:boolean, wingPending?:boolean}|null}
 */
function _holdPoseOf(mgr, armIndex) {
  const arm = mgr.arms[armIndex];
  if (!arm || arm.isDetached) return null;
  const holds = (arm.capturedDebris && arm.capturedDebris.mass)
    || (Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass));
  if (!holds) return null;
  const V5 = Constants.OCTOPUS_V5;
  const lo = Math.round(V5.STRUT_REST_ALPHA / DEG2RAD);
  const hi = V5.HOLD_POSE_MAX_DEG;
  const wp = armProfile(arm);
  const done = wp.state === 2;
  let lastPlumeClear = null;
  for (let deg = lo; deg < hi; deg += V5.HOLD_POSE_STEP_DEG) {
    if (heldCargoPlumeConflictAt(mgr, armIndex, deg * DEG2RAD)) continue;
    lastPlumeClear = deg;
    if (!done || profileClearAt(wp, 'rest', deg)) return { rad: deg * DEG2RAD, tooBig: false, wingPending: wp.state === 1 };
  }
  if (!heldCargoPlumeConflictAt(mgr, armIndex, hi * DEG2RAD)) {
    lastPlumeClear = hi;
    if (!done || profileClearAt(wp, 'rest', hi)) return { rad: hi * DEG2RAD, tooBig: false, wingPending: wp.state === 1 };
  }
  if (lastPlumeClear !== null) return { rad: lastPlumeClear * DEG2RAD, tooBig: false, wingBlocked: true };
  return { rad: hi * DEG2RAD, tooBig: true };
}

/**
 * The capture-net states in which a mother net's catch is coming home (CONVENTIONS §10 rule B) - the ONE set the holder duck,
 * the carry wait and the StrutAuto view (`inboundNetRadiusM`) read, so a state added to the reel is added once.
 */
const _NET_ST = Constants.CAPTURE_NET.STATES;
const INBOUND_NET_STATES = new Set([_NET_ST.CINCH_CLOSING, _NET_ST.SECURE_CHECK, _NET_ST.CAPTURED, _NET_ST.REELING]);

/**
 * The radius (m) of the berth corridor of the biggest mother net coming home (`INBOUND_NET_STATES`), or null when none is.
 * Read straight from the capture-net system, so it does not depend on StrutAuto running (inert without a debris field).
 * A net whose catch has no size is not counted ("never duck for a piece this cannot measure", the lean-aside rule); neither is
 * a net that MISSED (a slipped or lost catch reels back empty, in REELING, with nothing to keep a catch clear of). No allocation.
 * @param {object} mgr an ArmManager (playerSatellite)
 * @returns {number|null}
 */
function _inboundMotherNetRadiusM(mgr) {
  const CN = Constants.CAPTURE_NET;
  const cns = mgr.playerSatellite && mgr.playerSatellite._captureNetSystem;
  const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
  if (!nets) return null;
  let r = null;
  for (let k = 0; k < nets.length; k++) {
    const n = nets[k];
    if (!n || !n._isMother || n.catchResult === 'miss' || !INBOUND_NET_STATES.has(n.state)) continue;
    const d = n.targetDebris;
    if (!d || !d.sizeMeter) continue;
    const rr = d.sizeMeter / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
    if (r === null || rr > r) r = rr;
  }
  return r;
}

const _duckAnchor = { x: 0, y: 0, z: 0 };
const _duckPlanOut = { rad: null, kind: 0, foul: false };

/**
 * The ONE decision of where a holder goes for an inbound net of corridor radius `radiusM`, read by the duck (`_holderDuckRad`,
 * `_duckHolders`) and by the fire check (`ArmManager.motherNetHolderBlock`) so a refusal and a duck never disagree.
 * The pose set: the grid angles below her live angle (34°, 39°, ...), each counting when the net's corridor is clear of her catch
 * there AND one deadband higher (where the strut may stand) and - once her wing profile is done - her catch is also `rest`-clear
 * of the radiator wings there and, while the wings stand in the band or move through it, `band`-clear (`_netDuck` outranks
 * `_radLift` in the writer, so the duck pose itself must be clear). The highest counting pose wins; none counting: the 34°
 * fallback, which counts only if NO pose clears the net and 34° is wing-clear.
 * Returns the shared `{rad, kind}`: kind 0 = no duck needed (her catch is clear of the corridor where she is heading, or already
 * at the pose); 1 = duck to `rad`; 2 = some pose clears the net but none is wing-clear (she does not duck; the net is refused);
 * 3 = no pose clears the net at all and 34° is not wing-clear (she does not duck; the corridor gate holds the net);
 * 4 = her wing profile is pending (skip her this frame).
 * @param {object} mgr
 * @param {number} i
 * @param {number} radiusM
 * @returns {{rad:number|null, kind:number}} shared scratch: read it at once
 */
function _duckPlan(mgr, i, radiusM) {
  const out = _duckPlanOut;
  out.rad = null; out.kind = 0; out.foul = false;
  const arm = mgr.arms[i];
  berthAnchorLocalInto(mgr.playerSatellite, 0, _duckAnchor);
  const eff = _strutLiveAlpha(arm);
  if (!mgr._corridorFoulAt(i, eff, radiusM)) return out;
  const V5 = Constants.OCTOPUS_V5;
  const lo = Math.round(V5.STRUT_REST_ALPHA / DEG2RAD);
  const dead = V5.HOLD_POSE_DEADBAND_DEG * DEG2RAD;
  const wp = armProfile(arm);
  if (wp.state === 1) { out.kind = 4; return out; }
  const done = wp.state === 2;
  const needBand = done && typeof mgr._wingsInBand === 'function' && (mgr._wingsInBand() || mgr._wingsMovingInBand());
  // a strut stands up to a deadband above its target: the pose and the angle a deadband higher (off the grid: the next grid pose too)
  // must be wing-clear (a deadband changes the clearance by up to -0.032 m; with the next grid pose clear too the worst case over
  // 8758 cells is -0.001 m: no extra margin)
  const deadDeg = V5.HOLD_POSE_DEADBAND_DEG;
  const clearAt = (set, deg) => profileClearAt(wp, set, deg) && profileClearAt(wp, set, deg + deadDeg);
  const wingOk = (deg) => !done || (clearAt('rest', deg) && (!needBand || clearAt('band', deg)));
  let best = null;
  let anyNetClear = false;
  for (let deg = lo; deg * DEG2RAD < eff - 1e-6; deg += V5.HOLD_POSE_STEP_DEG) {
    // a strut stands up to the deadband ABOVE its target (54° passed, she stood at 54.5° and the corridor gate held the reel its
    // full 8 s): an angle counts only when the angle a deadband higher clears too
    if (mgr._corridorFoulAt(i, deg * DEG2RAD, radiusM) || mgr._corridorFoulAt(i, deg * DEG2RAD + dead, radiusM)) continue;
    anyNetClear = true;
    if (wingOk(deg)) best = deg * DEG2RAD;
  }
  if (best === null) {
    // the 34° fallback is only for a catch that clears the net at no pose at all: when some pose clears the net but none is
    // wing-clear she must not drop to a 34° that is wing-clear but still fouls the corridor - the net is refused (kind 2) instead
    if (!anyNetClear && wingOk(lo)) best = lo * DEG2RAD;
    else { out.kind = anyNetClear ? 2 : 3; if (!anyNetClear) out.foul = true; return out; }
  }
  // no pose clears the net's corridor at all, so wherever she stands (the 34° fallback, or already there) her catch still pokes into
  // it: the mother net must refuse (`motherNetHolderBlock`, reason 'corridor') rather than fire and wait on the corridor gate for its full reel
  if (!anyNetClear) out.foul = true;
  if (best < eff - dead) { out.rad = best; out.kind = 1; }
  return out;
}

/**
 * The angle a holder lowers her strut to for an inbound net of corridor radius `radiusM`: null when her catch is clear of the
 * corridor where she is heading (a pending latch wins, as in `_strutLiveAlpha`), or no wing-clear pose exists (`_duckPlan`); else
 * the HIGHEST counting angle on the hold-pose grid.
 * @param {object} mgr
 * @param {number} i
 * @param {number} radiusM
 * @returns {number|null} radians
 */
function _holderDuckRad(mgr, i, radiusM) {
  return _duckPlan(mgr, i, radiusM).rad;
}

/**
 * A strut press that arrived while the holder was ducked or lifted waits for it and is then applied as if pressed at that moment.
 * @param {object} mgr @param {object} arm
 */
function _applyQueuedPress(mgr, arm) {
  const q = arm && arm._queuedPress;
  if (!q) return;
  arm._queuedPress = null;
  _pressHolders(mgr, [arm], q.wantRad, q.autoOn, false);
}

/**
 * Forget every mark of the holder duck and the neighbour lift on one arm (reset, an ex-holder). Her strut is not touched: a
 * holder's writer takes her back to her hold pose, and a docked strut is the business of whoever owns docked struts.
 * @param {object} arm
 */
function _clearNetDuckMarks(arm) {
  arm._netDuck = null;
  arm._netDuckLow = false;
  arm._netDuckSaid = false;
  arm._netDuckThrustSaid = false;
  arm._netLift = null;
  arm._radLift = null;                     // radiator-wing lift, pose cache, reel hold, floor refusal
  arm._radClear = null;
  arm._rhHold = null;
  arm._rhFloorRefused = false;
  arm._rhFloorSpent = false;
  arm._carryWaitLift = null;
  arm._carryRestart = null;
  arm._queuedPress = null;
  arm._netBlock = false;                   // the mother net's refusal mark (C is allowed for her), and the lines said for her catch
  arm._holdWingSaid = null;
  arm._duckWingSaid = null;
}

/**
 * A piece carries salvage when it has any resource to recover or any metal (the test the credit handler's salvage loop makes:
 * `hasSalvage` and a non-empty `salvage`). A bag carries salvage when any member does; a bag that lists no members cannot be
 * judged, so it counts as carrying some (kept, never thrown away on a guess).
 * @param {object|null} d a piece or a scoop bag @returns {boolean}
 */
export function bagHasSalvage(d) {
  if (!d) return false;
  const one = (p) => {
    const s = p && p.hasSalvage && p.salvage;
    if (!s) return false;
    return (s.xenon || 0) + (s.indium || 0) + (s.gaAs || 0) + (s.battery || 0) + (s.hydrazine || 0) + (s.lithium || 0) > 0
      || (Array.isArray(s.metals) && s.metals.length > 0);
  };
  if (d.isBag === true) {
    const members = Array.isArray(d.bagMembers) ? d.bagMembers.map((m) => (m && m.piece) || m).filter(Boolean) : [];
    return members.length === 0 || members.some(one);
  }
  return one(d);
}

/** Does this arm still HOLD a catch at home (the only daughter a holder duck belongs to)? @param {object} arm */
function _holdsCatchAtHome(arm) {
  return !!arm && !arm.isDetached && arm.state === ARM_STATES.HOLDING_CATCH
    && Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass);
}

/**
 * A "." press on daughters holding catches (called by ArmManager.toggleStruts). The wanted angle is clamped to the hold pose from
 * below (a press that would close her sends her to it) and to HOLD_POSE_MAX_DEG from above; an angle above the pose is taken only
 * when her catch is plume-clear there. Each gets the manual marker, as a docked strut does (StrutAuto keeps it for them and ages
 * it) - only when the press moves her: a press that moves nothing is no override. When it moves nothing and no docked strut was
 * commanded either, `mgr.lastStrutPressNote` says why, in one plain line (`toggleStruts` holds a single tap's line back for the
 * double-press window, see `_pendingStrutNote`).
 * @param {object} mgr
 * @param {object[]} holders
 * @param {number} wantRad
 * @param {boolean} autoOn the STRUT_AUTO flag: the manual marker is only written (and aged) when it is on
 * @param {boolean} onlyThese true: nothing else was commanded, so a press that moves nothing gets its line
 */
function _pressHolders(mgr, holders, wantRad, autoOn, onlyThese) {
  if (!holders.length) return;
  const V5 = Constants.OCTOPUS_V5;
  const dead = degToRad(V5.HOLD_POSE_DEADBAND_DEG);
  const cap = degToRad(V5.HOLD_POSE_MAX_DEG);
  let anyMoved = false;
  let stayed = null;
  for (const a of holders) {
    const i = mgr.arms.indexOf(a);
    const hp = _holdPoseOf(mgr, i);
    if (!hp) continue;
    // while she is ducked for a net or lifted for a neighbour's carry her strut is not hers to move: the press waits for the end of it
    // (the last press wins) and counts as taken (no "stays at ..." line)
    if (a._netDuck || a._netLift) {
      a._queuedPress = { wantRad, autoOn };
      anyMoved = true;
      continue;
    }
    let t = hp.rad;
    // an angle above the pose is taken only when it is plume-clear AND `rest`-clear (off the grid: both neighbouring poses)
    if (wantRad > hp.rad + 1e-6 && wantRad <= cap + 1e-6 && !heldCargoPlumeConflictAt(mgr, i, wantRad)
        && _wingRestOk(a, wantRad / DEG2RAD)) t = wantRad;
    // where she is heading (a pending latch wins, as for a docked strut): a press that asks for that again moves nothing, and a
    // press that moves nothing is not a manual override (it left `_strutManual` behind, which later said "back to automatic")
    if (Math.abs(t - _strutLiveAlpha(a)) > dead) {
      a._strutTargetAlpha = t;
      if (autoOn) a._strutManual = { quietS: 0 };
      anyMoved = true;
    } else if (!stayed && Math.abs(t - (a.getAimAlpha ? a.getAimAlpha() : t)) <= dead) {
      stayed = { a, hp };
    }
  }
  if (onlyThese && stayed && !anyMoved) {
    const n = stayed.a.index + 1;
    const deg = Math.round(radToDeg(stayed.hp.rad));
    mgr.lastStrutPressNote = deg <= Math.round(radToDeg(V5.STRUT_REST_ALPHA))
      ? `Daughter ${n} is holding a catch; her strut stays at ${deg}° to keep it clear of the hull.`
      : `Daughter ${n} is holding a big catch; her strut stays at ${deg}° to keep it clear of the thrusters.`;
  }
}

const {
  V5_ARM_COUNT, V5_FRONT_ARM_TYPE, V5_BACK_ARM_TYPE,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  DUALFIRE_SYNC_WINDOW, DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  PULSE_SCAN_DURATION, PULSE_SCAN_COOLDOWN, PULSE_SCAN_POWER, PULSE_SCAN_RANGE_MULT,
  CROSSBOW_LAUNCH_SPEED_MIN, CROSSBOW_LAUNCH_SPEED_DEFAULT,
  SPRING_TIERS, TETHER_TIERS,
  ARM_STATES,
} = Constants;

// Sets built once (no per-call allocation in getRotationLockTier()). An arm in _HIGH_RISK_ROT_STATES with a live tether -> tier
// 'block' (hard displacement limit); in _SOFT_ROT_STATES -> 'soft' (generous limit). DOCKED / RELOADING / EXPENDED / isDetached -> 'none'.
const _HIGH_RISK_ROT_STATES = new Set([
  ARM_STATES.NETTING,
  ARM_STATES.GRAPPLED,
  ARM_STATES.STATION_KEEP,
  ARM_STATES.REELING,
  ARM_STATES.HAULING,
  ARM_STATES.RETURNING,
  ARM_STATES.DOCKING,
  ARM_STATES.DEORBITING,
  // carry: she is out on her strut line, flying in her docked attitude — the mother holds still
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);
// Arm states where the daughter parks AT her strut tip -> drum 'ready'. Mirrors ArmUnit._updateTether's hidden-line set
// (DOCKED/DOCKING/RELOADING/HOLDING_CATCH) minus EXPENDED, whose cartridge maps to 'empty'. CARRY_PREP is docked too (her line
// is wound, the strut and radiators are moving); the three states where she is out ('deployed') are not listed.
const _DRUM_HOME_STATES = new Set([
  ARM_STATES.DOCKED,
  ARM_STATES.DOCKING,
  ARM_STATES.RELOADING,
  ARM_STATES.HOLDING_CATCH,
  ARM_STATES.CARRY_PREP,
]);
const _SOFT_ROT_STATES = new Set([
  ARM_STATES.UNDOCKING,
  ARM_STATES.LAUNCHING,
  ARM_STATES.WEB_SHOT,
  ARM_STATES.TRANSIT,
  ARM_STATES.APPROACH,
  ARM_STATES.TRAWLING,
  ARM_STATES.SCANNING,
  ARM_STATES.ABLATING,
  ARM_STATES.CARRY_PREP,
]);
/** The four carry states. A carrying daughter is still part of the ship's books (her mass is aboard, recall refuses her,
 *  her rack catches are pinned to her), but not "home". */
const _CARRY_STATES = new Set([
  ARM_STATES.CARRY_PREP,
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);

/**
 * Generate dock positions for the given arm tier.
 *
 * Geometry convention (archive/ARM_PIVOT_ANALYSIS.md §10.2, side view):
 *   α = 0   → STOWED  (strut alongside barrel, daughter near −Y bottom)
 *   α = π/2 → EQUATORIAL (strut points radially outward in XZ plane)
 *   α = π   → ZENITH  (strut points +Y, above Mother)
 *
 * Strut tip formula (universal for ring AND end-face arms):
 *   tip = hinge + STRUT_LENGTH × ( sin(α)·dockOutward − cos(α)·ŷ )
 *
 * Ring arms hinge at the top collar (Y = COLLAR_Y = +1.00 m).
 * End-face arms (Y3 Octo only) hinge at the barrel end caps (±Z faces).
 *
 * This is the STORED convention (CameraSystem's aim bridge reads `arm._dockOutward` in it: the XZ collar convention). The mass
 * model does NOT consume it raw: CoMCalculator converts these fields to the rendered ship frame (barrel = Z, stowed aft at −Z)
 * at its strutTipMeters/strutMidpointMeters boundary (the Y/Z swap). Do not "fix" this convention; the conversion is
 * deliberate and single-sited.
 *
 * @param {string|number} [tierKeyOrCount='Y0_QUAD'] — tier key or arm count (4/6/8)
 * @returns {Array<{type: string, offset: THREE.Vector3, angle: number, azimuthDeg: number,
 *   dockOutward: THREE.Vector3, swingAxis: THREE.Vector3, hingePosition: THREE.Vector3,
 *   isEndFace: boolean}>}
 */
export function generateDockPositions(tierKeyOrCount) {
  let tierKey;
  if (typeof tierKeyOrCount === 'number') {
    const ladder = Constants.ARM_LADDER;
    tierKey = Object.keys(ladder).find(k => ladder[k].armCount === tierKeyOrCount) || 'Y0_QUAD';
  } else {
    tierKey = tierKeyOrCount || 'Y0_QUAD';
  }

  const tier = Constants.ARM_LADDER[tierKey] || Constants.ARM_LADDER.Y0_QUAD;
  const V5 = Constants.OCTOPUS_V5;
  const COLLAR_Y = V5.COLLAR_Y;
  const COLLAR_RADIUS = V5.COLLAR_RADIUS;
  const positions = [];

  const azimuths = tier.azimuths; // degrees

  for (let i = 0; i < azimuths.length; i++) {
    const azDeg = azimuths[i];
    const theta = degToRad(azDeg);

    // Hinge XZ on collar perimeter (scene units); Y kept at 0 so that
    // _worldDockDirection (which normalizes dockOffset) stays purely radial.
    const hx = COLLAR_RADIUS * Math.cos(theta) * M;
    const hz = COLLAR_RADIUS * Math.sin(theta) * M;

    const outward = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)).normalize();

    const swingAxis = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta)).normalize();

    const type = i % 2 === 0 ? 'weaver' : 'spinner';

    positions.push({
      type,
      offset: new THREE.Vector3(hx, 0, hz),          // XZ only for backward-compat deploy dir
      angle: theta,
      azimuthDeg: azDeg,
      dockOutward: outward,
      swingAxis,
      hingePosition: new THREE.Vector3(hx, COLLAR_Y * M, hz),
      isEndFace: false,
    });
  }

  // End-face arms (Y3 Octo only: +Z and −Z along velocity vector)
  // owner 2026-08-22 "fix the blueprint": the rows ride the SAME stored convention as the ring - ship Z lives in the stored Y
  // slot (the Y/Z swap) - so hingePosition (0, ±CORE_LENGTH/2, 0)_stored reads (0, 0, ±CORE_LENGTH/2)_ship: ON the barrel axis
  // at the end faces. dockOutward likewise carries ship-Z in its stored-Y slot, so a face's arm deploys straight off its face
  // at α=π/2.
  if (tier.endFaceArms) {
    for (const face of tier.endFaceArms) {
      const isForward = (face === '+Z');
      const endOff = (isForward ? 1 : -1) * (V5.CORE_LENGTH / 2);
      const azDeg = isForward ? 0 : 180;
      const theta = degToRad(azDeg);

      const outward = new THREE.Vector3(0, isForward ? 1 : -1, 0);
      const swingAxis = new THREE.Vector3(1, 0, 0);

      const type = isForward
        ? (V5_FRONT_ARM_TYPE || 'weaver')
        : (V5_BACK_ARM_TYPE || 'weaver');

      positions.push({
        type,
        offset: new THREE.Vector3(0, endOff * M, 0),
        angle: theta,
        azimuthDeg: azDeg,
        dockOutward: outward,
        swingAxis,
        hingePosition: new THREE.Vector3(0, endOff * M, 0), // end-cap hinge (not collar)
        isEndFace: true,
      });
    }
  }

  return positions;
}

/**
 * Can this daughter be sent right now? Docked, spring charged, fuel above the 5 dead-end line, not reserved by an
 * aim in progress. The one filter of `_findDockedArm` (minus the type) and `daughterLaunchReadiness`. Module scope, not a
 * method, so `_findDockedArm` still works when borrowed onto another object (main.js's chip helper test does that).
 * @param {object} a an ArmUnit
 * @returns {boolean}
 */
function armCanLaunchNow(a) {
  return !!a && a.state === ARM_STATES.DOCKED && !!a.springCharged && a.fuel > 5 && !a._aimReserved;
}

export class ArmManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./PlayerSatellite.js').PlayerSatellite} playerSatellite
   */
  constructor(scene, playerSatellite) {
    this.scene = scene;
    this.playerSatellite = playerSatellite;

    /** @type {import('../systems/AutopilotSystem.js').AutopilotSystem|null}
     *  Injected post-construction for the aim-before-launch daughter ceremony. */
    this._autopilot = null;
    /** The two daughters of a pair launch whose springs have not both fired yet (the recoil refund waits for them), or null. */
    this._pairRecoil = null;

    /** @type {ArmUnit[]} */
    this.arms = [];

    // Last state sent to PlayerSatellite.setTetherState per strut index (edge-triggered: only transitions emit a call).
    this._drumStatesSent = [];

    /**
     * SceneManager ref for DYNAMIC near-field membership (z-layer fix): a daughter's hull is in the near-field depth pass only
     * while docked/close to the mother; set via setSceneManager(). Null in headless / menu-backdrop contexts (toggling is a no-op).
     * @type {import('../scene/SceneManager.js').SceneManager|null}
     */
    this._sceneManager = null;

    this._activeTierKey = this._resolveActiveTierKey();
    const tierConfig = Constants.ARM_LADDER[this._activeTierKey] || Constants.ARM_LADDER.Y0_QUAD;

    this.maxSimultaneous = tierConfig.armCount;

    this.weaverCount = tierConfig.weaverCount;
    this.spinnerCount = tierConfig.spinnerCount;

    /**
     * Stored upgrade overrides that survive reset().
     * Maps effect name → value (e.g., 'tetherRange' → 2.0)
     * @type {Object<string, number>}
     */
    this._storedUpgrades = {};

    /**
     * Currently selected arm index (0-7). -1 = no selection (mothership).
     * Set by number keys 1-8 via ARM_SELECT event.
     * @type {number}
     */
    this.selectedArmIndex = -1;

    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // Arms lean aside for an inbound catch. Arm indices currently held ducked at the 90° open angle (STRUT_DEPLOY_ALPHA);
    // this manager is the sole writer of _strutTargetAlpha for exactly these arms while the set is non-empty.
    this._leanAsideArmIndices = new Set();
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;

    // The mother turn a daughter on the reels owns (first come), and the transient exception `getRotationLockTier` reads while
    // that turn is being requested.
    this._rhTurn = null;          // { arm, attempt } while a turn for a daughter on the reels is running
    this._rhOwner = null;
    this._rhSeq = 0;
    this._lockExceptArm = null;

    // Daughter-arm automation: the controller, the once-per-player store (main.js hands it in; no store → the full-range show
    // never runs) and the "." press counter the show uses to notice a player taking over.
    this._strutAuto = new StrutAutoController();
    this._strutAutoStore = null;
    this._strutAutoView = null;
    this._strutPress = 0;

    this._initArms();
    this._setupListeners();
  }

  /**
   * Resolve the active arm tier key from persisted save data; falls back to Y0_QUAD on missing/legacy saves.
   * @private
   * @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
   */
  _resolveActiveTierKey() {
    try {
      return persistenceManager.getArmTier();
    } catch (_) {
      return 'Y0_QUAD';
    }
  }

  _initArms() {
    this._dockPositions = generateDockPositions(this._activeTierKey);
    let wIdx = 1;
    let sIdx = 1;

    for (let i = 0; i < this._dockPositions.length; i++) {
      const dp = this._dockPositions[i];
      const { type, offset } = dp;
      const id = type === 'weaver' ? `weaver-${wIdx++}` : `spinner-${sIdx++}`;
      const arm = new ArmUnit(id, type, offset, this.scene);
      arm.index = i;
      // the rack feed-end's direct attitude-inertia invalidation reaches the cache through this handle (same injection idiom
      // as _beaconSpeedScale / _digestSunScale)
      arm._playerSatellite = this.playerSatellite;
      arm._dockPos = dp;                                  // where SeatHullClear measures from
      arm._seatHullGate = seatHullClear;                  // the check a seated big piece must pass (ArmUnit.rackCellOffsetInto)
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      arm.initNetInventory(); // fill net magazine (CAPTURE_NET flag gated)
      this.arms.push(arm);
    }
    seatHullPrime(this.playerSatellite, this.arms);       // the obstacle set for the hull check is built now, not at the first big catch
  }

  _setupListeners() {
    eventBus.on(Events.ARM_DEPLOY_TO, ({ target, preferType }) => {
      this.deployArm(target, preferType);
    });

    eventBus.on(Events.ARM_RECALL_ONE, ({ armId }) => {
      this.recallArm(armId);
    });

    eventBus.on(Events.ARM_RECALL_ALL, () => {
      this.recallAll();
    });

    eventBus.on(Events.UPGRADE_V4_TECH, ({ upgrade }) => {
      this._applyV4Upgrade(upgrade);
    });

    eventBus.on(Events.UPGRADE_PURCHASED, ({ effect, value }) => {
      if (effect === 'v4TetherRange' || effect === 'v4NetArea' || effect === 'v4GripForce') {
        this.applyUpgrade({ effect, value });
      }
    });

    eventBus.on(Events.ARM_DEORBIT_CMD, () => {
      this.deorbitCapturingArm();
    });

    // ARM_SELECT / ARM_DESELECT are EMITTED by selectArm/deselectArm (InputManager calls those directly); no listener here.

    eventBus.on(Events.ARM_MANUAL_THRUST, (data) => {
      const arm = this.arms.find(a => a.id === data.armId);
      if (arm && arm.isManual()) {
        arm.applyManualThrust(data.direction, data.fine, data.dt);
      }
    });

    // Arms lean aside for an inbound catch: trigger on LASSO_CAPTURED; release on NET_BERTHED or when the net clears or fails.
    // NET_BERTHED alone is not sufficient on every path (see _releaseLeanAside): a bounded timeout in _updateLeanAside covers the gap.
    eventBus.on(Events.LASSO_CAPTURED, (payload) => this._onInboundCatchCaptured(payload));
    const releaseLeanAside = () => this._releaseLeanAside();
    eventBus.on(Events.NET_BERTHED, releaseLeanAside);
    eventBus.on(Events.LASSO_MISSED, releaseLeanAside);
    eventBus.on(Events.LASSO_SNAPPED, releaseLeanAside);
    eventBus.on(Events.NET_FAILED, releaseLeanAside);
    eventBus.on(Events.NET_RELEASED, releaseLeanAside);
    eventBus.on(Events.NET_TORN, releaseLeanAside);

    // the mother's own net or lasso going out wins over a reel-home turn of the mother
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.podIndex >= 0) this._rhOnMotherCatchFired('net');
    });
    eventBus.on(Events.LASSO_FIRED, () => this._rhOnMotherCatchFired('lasso'));
  }

  /**
   * @param {object} target - Debris object with .mesh, .id, .mass
   * @param {'weaver'|'spinner'|null} preferType - Preferred arm type (null = auto)
   * @returns {boolean} true if an arm was deployed
   */
  deployArm(target, preferType = null) {
    if (!target) return false;
    if (target._disposed === true) return false;       // a piece that was disposed of is no catch

    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // Active-satellite treaty guard: refuse if the target's NORAD is in the active-sat catalogue (emits RED CONJUNCTION_ALERT +
    // Houston stand-down COMMS_MESSAGE)
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;

    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    const targetMass = target.mass || 1;

    // ONE owner per piece, and no crossed lines. The picked piece must be free (no daughter, net or catch on it), and the daughter
    // sent is the best one whose strut line stays clear of every line already out.
    const pick = this._pickLaunchArm(target, preferType);
    if (pick.refusal) {
      this._sayWarn(pick.refusal.text);
      return false;
    }
    const arm = pick.arm;

    if (!arm) {
      // with no furnace a daughter that holds a catch stays holding it until the burn to the next field, where she carries it to
      // a furnace: say that plainly instead of the bare "no daughters" line
      const holding = Constants.isFeatureEnabled('FURNACE_COOK') ? 0
        : this.arms.filter((a) => a && a.state === ARM_STATES.HOLDING_CATCH).length;
      const usable = this.arms.filter((a) => a && a.state !== ARM_STATES.EXPENDED && !a.isDetached).length;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: holding > 0 && holding >= usable
          ? 'All daughters are holding catches. They carry them to the furnaces on the burn to the next field.'
          : holding > 0
            ? `No daughter is free: ${holding} holding catches. They carry them to the furnaces on the burn to the next field.`
            : 'No daughters available for deployment (check spring charge)',
        priority: 'warning',
      });
      return false;
    }

    // a piece over the mother's catch limit is sent a daughter to INSPECT, no net: the mass refusal does not apply
    if (targetMass > arm.config.maxCaptureMass && !isInspectOnlyMass(targetMass)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName} cannot capture ${targetMass}kg (max ${arm.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      return false;
    }

    // Aim-before-launch ceremony: slew the chosen strut + rotate the Mother so the physical strut fire direction points at the
    // target, THEN launch. Loose tolerance (TRANSIT FEEP corrects the residual). Falls back to an immediate launch when the
    // autopilot/feature is unavailable.
    return this._deployWithCeremony(arm, target);
  }

  /**
   * Run the daughter launch ceremony for a selected+validated arm, then deploy. Returns true when the ceremony starts (or the
   * immediate fallback fires). The ceremony turns the mother only when she is free to turn (`_motherTurnBlock`); otherwise the
   * strut alone aims the launch, with one comms line saying why.
   * @param {ArmUnit} arm
   * @param {object} target
   * @param {{announce?: boolean}} [opts] — see `deployArmByIndex`; handed on to the strut-only launch
   * @returns {boolean}
   * @private
   */
  _deployWithCeremony(arm, target, opts) {
    const ap = this._autopilot;
    const player = this.playerSatellite;
    const canCeremony = ap && typeof ap.requestAimRotation === 'function'
      && Constants.FEATURE_FLAGS.SEMI_AUTO_AIM
      && player && target && target._scenePosition;

    // Pre-ceremony max-deploy-range refusal (stays instant; ArmUnit.deploy still backstops it at fire time): the same
    // tether-tier-aware expression as the backstop, tetherMax × fraction.
    if (target._scenePosition && arm.position) {
      const distM = target._scenePosition.clone().sub(arm.position).length() / M;
      const maxRange = arm.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION;
      if (distM > maxRange) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${arm.displayName}: Target ${Math.round(distM)}m away (max ${Math.round(maxRange)}m). Press A to autopilot closer first.`,
          priority: 'warning',
        });
        return false;
      }
    }

    if (!canCeremony) {
      // no aim ceremony → the daughter fires along the direct bearing; the launch line is checked along that same bearing
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), opts, target);
    }

    // Not free to turn (a daughter on her line, a catch on the collar, a hand-off or another launch under way) → no turn; the
    // strut alone aims the launch. `announce`: a launch the aim stage holds back announces itself when it fires (the D key's
    // auto-pick caller announces only a launch that has already happened).
    const blocked = this._motherTurnBlock();
    if (blocked) {
      this._sayCantTurn(blocked);
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), { ...(opts || {}), announce: true }, target);
    }

    // Concurrency guard: don't supersede an in-flight aim sequence (e.g. a Mother net aim already rotating); defer, matching
    // InputManager.fireMotherNet. (`_motherTurnBlock` already refuses while an aim runs, so this is a backstop only.)
    if (typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info',
      });
      return false;
    }

    // Reserve the arm so a second D-press doesn't grab it mid-ceremony; the piece is hers from this moment (the ceremony takes
    // 8-10 s): a net or another daughter sent at it meanwhile is refused.
    arm._claimTarget = target;
    arm._aimReserved = true;

    // World-direction provider: strut-tip → target scene position, recomputed per tick (tracks the moving target). No lead —
    // TRANSIT corrects. One scratch output object (no per-frame allocation).
    const provOut = { x: 0, y: 0, z: 0 };
    const provider = () => {
      const tp = (target._scenePosition) ? target._scenePosition
        : (typeof target.getScenePosition === 'function' ? target.getScenePosition() : null);
      if (!tp || !arm.position) return null;
      const dx = tp.x - arm.position.x, dy = tp.y - arm.position.y, dz = tp.z - arm.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      provOut.x = dx / len; provOut.y = dy / len; provOut.z = dz / len;
      return provOut;
    };

    ap.requestAimRotation(provider, {
      mode: 'daughter', armManager: this, arm, pairIndex: arm.index,
      maxWaitS: Constants.AIM.AIM_TIMEOUT_S,   // backstop: `_motherTurnBlock` already sends a slow turn to the strut-only launch
    }).then(() => {
      arm._aimReserved = false;
      // the launch goes through the keep-out gate. The line is checked along the converged STRUT direction (re-derived each
      // check — struts move); a clear line fires this same frame.
      this._launchArm(arm, 'ceremony', () => this._strutDirShip(arm), () => {
        // tell deploy() the strut was physically aimed at the target, so it fires along the strut basis (SSOT) rather than the
        // direct-bearing fallback
        arm._aimConverged = true;
        const ok = arm.deploy(target);
        // the camera ceremony must start when the arm ACTUALLY deploys (post-rotation), not during the slew; the synchronous
        // InputManager emit is skipped for ceremony deploys (not deployed yet), so emit here
        if (ok) eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
        return ok;
      }, undefined, target);
    }).catch((err) => {
      arm._aimReserved = false;
      arm._claimTarget = null;
      // Abort comms already emitted by AutopilotSystem.
      // Reaction wheels: with the steering gas out the wheels were asked to turn her and need longer than the aim allows
      // ('TOO_SLOW', refused at once, nothing moved): the strut aims alone, as it always did with the gas out.
      if (err && err.code === 'TOO_SLOW' && arm.state === ARM_STATES.DOCKED) {
        this._sayCantTurn('the steering gas is empty');
        this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
          () => arm.deploy(target), { announce: true }, target);
      }
    });

    return true;
  }

  setAutopilot(autopilot) { this._autopilot = autopilot; }

  /**
   * @param {string} armId
   * @param {object} target
   * @returns {boolean}
   */
  deploySpecificArm(armId, target) {
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms.find(a => a.id === armId);
    if (!arm) return false;
    const owned = target ? this.launchRefusalAt(target, { exceptArm: arm }) : null;
    if (owned) { this._sayWarn(owned.text); return false; }
    return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
      () => arm.deploy(target), undefined, target);
  }

  /**
   * Deploy a specific arm by index (0-based). With a target, deploys toward it; null = free-fly mode. Used by the number key
   * deploy+select flow. With a target and the mother free to turn, the number key does what the D key does: the mother turns
   * (and the strut slews) until the strut points at the target, then the spring fires. Not free (a daughter out on her line, a
   * catch on the collar, a hand-off or another launch): the strut aims alone.
   * @param {number} index - 0-based arm index
   * @param {object|null} target - Optional target to aim toward
   * @param {{announce?: boolean}} [opts] - `announce`: the number-key launch (InputManager). A launch the aim stage holds back
   *   then announces itself (the cut-scene start) when it fires; an immediate launch is announced by the caller. The launch
   *   LINE is not announced here: ArmUnit says "Spring released. Separating" when the spring really fires.
   * @returns {boolean} true if deployment started
   */
  deployArmByIndex(index, target, opts) {
    if (target && target._disposed === true) return false;       // a piece that was disposed of is no catch
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // Active-sat treaty guard (even if the player selected the target)
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms[index];
    if (!arm || arm.state !== ARM_STATES.DOCKED) return false;

    if (!arm.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      return false;
    }

    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    // one owner per piece, and the strut she was picked on must keep its line clear of the others'.
    const refused = target ? this.indexLaunchRefusal(index, target) : null;
    if (refused) { this._sayWarn(refused.text); return false; }

    // With a target, the number key turns the mother too (the D key's ceremony) when she is free to turn; otherwise only the
    // arm's strut aims. A launch of this arm that is already waiting keeps its single entry (requestClearLaunch answers
    // "accepted" for it).
    if (target && !(this._pendingLaunches && this._pendingLaunches.has(index))) {
      const blocked = this._motherTurnBlock();
      if (!blocked) return this._deployWithCeremony(arm, target, opts);
      // The D key with this daughter selected (`announce`) says why the mother does not turn, once; a launch of hers that
      // already waits keeps its single entry and says nothing again.
      if (opts && opts.announce) this._sayCantTurn(blocked);
    }

    // No target → free-fly mode (TRANSIT with manual control), through the keep-out gate, along the direction the arm will
    // actually fire.
    return this._launchTargetOrFree(arm, target, opts);
  }

  // A piece has ONE owner; a daughter's line never crosses another's (archive/research/2026-10-launch-interlocks.md)

  /**
   * Hand the manager the lasso (it is not reachable from the ship). InputManager does this at init; without it the lasso is
   * found through the capture-net system when that has it.
   */
  setLassoSystem(lassoSystem) { this._lassoSystemRef = lassoSystem || null; }

  /** What `pieceClaim` reads: the daughters, the launches waiting on the gate, the nets in the air, the lasso. */
  claimWorld() {
    const p = this.playerSatellite;
    const cns = p && p._captureNetSystem;
    return {
      arms: this.arms,
      pending: this._pendingLaunches || null,
      nets: cns && Array.isArray(cns.activeNets) ? cns.activeNets : [],
      lasso: this._lassoSystemRef || (cns && cns._lassoSystem) || null,
    };
  }

  /** Who owns `piece` right now (see PieceClaim.pieceClaim). `opts.exceptArm`: leave that daughter's own claim out. */
  pieceClaimOf(piece, opts) { return pieceClaim(piece, this.claimWorld(), opts); }

  /**
   * Pure: the refusal a DAUGHTER launch at `target` meets because someone already owns it, or null when the piece is free.
   * @returns {{kind: string, claim: object, text: string}|null}
   */
  launchRefusalAt(target, opts) {
    if (!target) return null;
    const claim = this.pieceClaimOf(target, opts);
    if (isFree(claim)) return null;
    const text = launchRefusalLine(claim);
    return text ? { kind: claim.kind, claim, text } : null;
  }

  _sayWarn(text) {
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'warning' });
  }

  /** A world (scene) point in the SHIP frame, metres (null when the ship's pose is unknown). @private */
  _shipPointM(w) {
    const p = this.playerSatellite;
    const pos = p && (p.position || (p.mesh && p.mesh.position));
    if (!pos || !w) return null;
    const v = new THREE.Vector3(w.x - pos.x, w.y - pos.y, w.z - pos.z);
    if (p.quaternion) v.applyQuaternion(p.quaternion.clone().invert());
    return [v.x / M, v.y / M, v.z / M];
  }

  /** The tether anchor of `arm` on her strut RIGHT NOW, ship frame, metres (the reel at 85 % of the strut). @private */
  _anchorShipM(arm) {
    const o = arm && (arm._reelOffset || arm.dockOffset);
    return o ? [o.x / M, o.y / M, o.z / M] : null;
  }

  /**
   * The tether anchor `arm` will have once her strut has swung to launch toward `wantedShip` (ship frame): the hinge on the
   * collar plus the strut at the aim angle, to the reel at 85 % of its length (PlayerSatellite._updateStruts).
   * Without strut aiming she fires from where her strut is.
   * @private
   */
  _aimedAnchorShipM(arm, wantedShip) {
    const i = this.arms.indexOf(arm);
    if (Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT !== true || i < 0 || typeof arm.getAimAlpha !== 'function' || !arm.dockOffset) {
      return this._anchorShipM(arm);
    }
    const V5 = Constants.OCTOPUS_V5;
    const alpha = this._aimAlphaFor(i, wantedShip);
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const d = strutLocalDirection(alpha, az, new THREE.Vector3());
    const reel = V5.STRUT_LENGTH * 0.85;
    return [
      Math.cos(az) * V5.COLLAR_RADIUS + d.x * reel,
      Math.sin(az) * V5.COLLAR_RADIUS + d.y * reel,
      V5.COLLAR_Y + d.z * reel,
    ];
  }

  /**
   * The lines of the daughters that are out, or lining up to go, as ship-frame segments (metres): from her tether anchor on
   * the strut to her far end (the piece she is flying at, else where she is). A daughter that waits for a turn-the-ship
   * ceremony has no stable geometry yet (the ship is about to move) and a free-fly or trawl launch has no piece, so those
   * are left out; the OWNER check still sees them.
   * @param {object|null} exceptArm
   * @returns {Array<{arm: object, a: number[], b: number[]}>}
   * @private
   */
  _lineSet(exceptArm = null) {
    const S = ARM_STATES;
    const out = [];
    const pend = this._pendingLaunches;
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a || a === exceptArm || a.isDetached) continue;
      let far = null;
      let anchor = null;
      if (a.state === S.DOCKED) {
        const t = a._claimTarget;
        if (!(pend && pend.has(i) && t && t._scenePosition)) continue;
        far = t._scenePosition;
        anchor = this._aimedAnchorShipM(a, this._launchDirShip(a, t));
      } else if (a.state === S.RELOADING || a.state === S.HOLDING_CATCH || a.state === S.EXPENDED
          || a.state === S.DOCKING || a.state === S.CARRY_PREP) {
        continue;
      } else {
        const t = a.target && a.target._scenePosition;
        const flying = a.state === S.LAUNCHING || a.state === S.UNDOCKING || a.state === S.TRANSIT || a.state === S.APPROACH;
        far = flying && t ? t : a.position;
        anchor = this._anchorShipM(a);
      }
      const b = far ? this._shipPointM(far) : null;
      if (!anchor || !b) continue;
      out.push({ arm: a, a: anchor, b });
    }
    return out;
  }

  /** The line `arm` would fly at `target`: her anchor once her strut has swung, to the piece. @private */
  _candidateLine(arm, target) {
    const tp = target && target._scenePosition;
    if (!tp || !arm || !arm.dockOffset || !arm.position) return null;
    const b = this._shipPointM(tp);
    const a = this._aimedAnchorShipM(arm, this._launchDirShip(arm, target));
    return a && b ? { a, b } : null;
  }

  /**
   * The daughter whose line a launch of `arm` at `target` would cross (the t4 harness's side-swap test on the real strut
   * anchors), or null when the line stays clear. A checker error answers null (fails open, as the launch gate does).
   */
  _crossingArm(arm, target) {
    try {
      const cand = this._candidateLine(arm, target);
      if (!cand) return null;
      for (const L of this._lineSet(arm)) if (linesCross(cand, L)) return L.arm;
    } catch (err) {
      if (!this._crossWarned) { this._crossWarned = true; console.warn('[ArmManager] line-cross check failed; launching unchecked:', err); }
    }
    return null;
  }

  /**
   * What keeps `arm` from this piece: 'heavy' (more than she holds), 'reach' (past tether x deploy fraction), or null when she
   * holds it and reaches it. Null too when either is unknown (mock arms). @private
   */
  _armShortfall(arm, piece) {
    const cfg = arm && arm.config;
    if (!cfg) return null;
    if (cfg.maxCaptureMass !== undefined && (piece.mass || 1) > cfg.maxCaptureMass && !isInspectOnlyMass(piece.mass || 1)) return 'heavy';
    const tp = piece._scenePosition;
    if (tp && arm.position && cfg.tetherMax > 0) {
      const distM = Math.hypot(tp.x - arm.position.x, tp.y - arm.position.y, tp.z - arm.position.z) / M;
      if (distM > cfg.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION) return 'reach';
    }
    return null;
  }

  /** Can `arm` hold `piece`'s mass and reach it (tether x deploy fraction)? True when either is unknown (mock arms). @private */
  _armFitsPiece(arm, piece) { return this._armShortfall(arm, piece) === null; }

  /** Ship-frame direction from the ship's centre to `target` (null when unknown): what picks the dock best aligned. @private */
  _shipDirTo(target) {
    if (!(target && target._scenePosition && this.playerSatellite)) return null;
    const playerPos = this.playerSatellite.position || (this.playerSatellite.mesh && this.playerSatellite.mesh.position);
    if (!playerPos) return null;
    const dir = target._scenePosition.clone().sub(playerPos);
    const q = this.playerSatellite.quaternion;
    if (q) dir.applyQuaternion(q.clone().invert());
    return dir;
  }

  /**
   * The D key's choice for `target`, free of side effects: the best docked daughter whose strut line stays clear of every
   * line already out, or the reason there is none. Order: the right size for the piece, then the other size; within a
   * size the dock best aligned with the piece (`_findDockedArm`). A piece with an owner is refused first.
   * @param {object} target
   * @param {'weaver'|'spinner'|null} [preferType]
   * @param {function(ArmUnit): boolean|null} [fits] extra filter on the daughters (the one-per-piece send passes "can reach
   *   it": when the best daughter falls short the next one is tried before the piece is given up)
   * @returns {{arm: (ArmUnit|null), refusal: ({kind: string, text: string}|null)}}
   *   `arm` null with no `refusal` = no daughter is free at all (the caller says so).
   */
  _pickLaunchArm(target, preferType = null, fits = null) {
    const owned = this.launchRefusalAt(target);
    if (owned) return { arm: null, refusal: owned };
    const mass = target.mass || 1;
    const first = preferType || (mass > Constants.SPINNER_MAX_CAPTURE_MASS ? 'weaver' : 'spinner');
    const other = first === 'weaver' ? 'spinner' : 'weaver';
    const dir = this._shipDirTo(target);
    const cap = (a) => !(a.config && a.config.maxCaptureMass !== undefined) || mass <= a.config.maxCaptureMass || isInspectOnlyMass(mass);   // over the catch limit = an inspection, any daughter
    const clear = (a) => cap(a) && (!fits || fits(a)) && !this._crossingArm(a, target);
    const arm = this._findDockedArm(first, dir, clear) || this._findDockedArm(other, dir, clear);
    if (arm) return { arm, refusal: null };
    // None is clear. An arm that could go but for a crossing line gets the crossing line.
    const any = this._findDockedArm(first, dir) || this._findDockedArm(other, dir);
    if (!any) return { arm: null, refusal: null };
    if (fits) {
      // judge the crossing only for a daughter who could fly there at all: a piece nobody holds or reaches gets the reach (or
      // weight) line, not the crossing line of whichever daughter happened to be listed first
      const able = (a) => cap(a) && fits(a);
      const goer = this._findDockedArm(first, dir, able) || this._findDockedArm(other, dir, able);
      if (!goer) {
        const docked = this.arms.filter((a) => armCanLaunchNow(a));
        const kinds = docked.map((a) => this._armShortfall(a, target));
        const heavy = kinds.length > 0 && kinds.every((k) => k === 'heavy');
        return { arm: null, refusal: heavy ? { kind: 'heavy', text: heavyNoneLine(1) } : { kind: 'reach', text: reachNoneLine(1) } };
      }
      const blocker = this._crossingArm(goer, target);
      return blocker
        ? { arm: null, refusal: { kind: 'cross', text: crossNoneClearLine(blocker.displayName) } }
        : { arm: goer, refusal: null };
    }
    if (!cap(any)) return { arm: any, refusal: null };
    const crossed = this._crossingArm(any, target);
    if (!crossed) return { arm: any, refusal: null };
    return { arm: null, refusal: { kind: 'cross', text: crossNoneClearLine(crossed.displayName) } };
  }

  /** Pure: what the D key's auto-pick would be refused with at `target` (an owner, or every strut crossing), or null. */
  interlockRefusal(target, preferType = null) {
    if (!target) return null;
    return this._pickLaunchArm(target, preferType).refusal;
  }

  /**
   * Pure: what a launch of daughter `index` at `target` is refused with - the piece has an owner, or this strut's line would
   * cross another daughter's (with the clear strut to press named when there is one) - or null. A launch of hers that
   * already waits is never refused here (it keeps its single entry).
   * @returns {{kind: string, text: string}|null}
   */
  indexLaunchRefusal(index, target) {
    const arm = this.arms[index];
    if (!arm || !target) return null;
    const owned = this.launchRefusalAt(target, { exceptArm: arm });
    if (owned) return owned;
    if ((this._pendingLaunches && this._pendingLaunches.has(index)) || arm._aimReserved) return null;
    const crossed = this._crossingArm(arm, target);
    if (!crossed) return null;
    const mass = target.mass || 1;
    const dir = this._shipDirTo(target);
    const clear = (a) => (!(a.config && a.config.maxCaptureMass !== undefined) || mass <= a.config.maxCaptureMass || isInspectOnlyMass(mass))
      && !this._crossingArm(a, target);
    const alt = this._findDockedArm(arm.type, dir, clear)
      || this._findDockedArm(arm.type === 'weaver' ? 'spinner' : 'weaver', dir, clear);
    return {
      kind: 'cross',
      // glass has no number keys: the daughter is picked by a tap on her row in DAUGHTERS (read at say time, as pilotLine does)
      text: alt
        ? crossNamedStrutLine(this.arms.indexOf(alt) + 1, crossed.displayName, GestureHints.isGlass() ? alt.displayName : null)
        : crossNoneClearLine(crossed.displayName),
    };
  }

  /**
   * At the moment of release: has the piece been caught, lost or taken since the launch was asked for?
   * @returns {'gone'|'caught'|'taken'|null}
   * @private
   */
  _releaseBlock(arm, target) {
    if (!target) return null;
    if (target.alive === false) return 'gone';
    const claim = this.pieceClaimOf(target, { exceptArm: arm });
    if (isFree(claim)) return null;
    return pieceIsCaught(target) ? 'caught' : 'taken';
  }

  /**
   * Why the daughters still docked after a send stayed. `pieces` are the pieces the send was about; those somebody
   * owns now (the daughter just sent, a net, a catch) or that are gone are not "left". A daughter stays because
   *   - no free piece is left (`ranOut`),
   *   - every piece left is past her tether (`reach`) or heavier than she holds (`heavy`),
   *   - or she reaches and holds at least one, but every such piece takes her line across a line already out (`cross`,
   *     naming the daughter whose line is in the way for the best such piece).
   * A daughter that fits a piece on a clear line counts as `other` (her launch was refused for a reason already said).
   * @param {object[]} pieces
   * @param {function(ArmUnit): boolean} [ready] which daughters count as "still docked and ready"
   * @returns {{stayed: number, ranOut: number, cross: number, crossWho: string[], reach: number, heavy: number, other: number, left: number}}
   * @private
   */
  _whyStayed(pieces, ready = (a) => armCanLaunchNow(a)) {
    const why = { stayed: 0, ranOut: 0, cross: 0, crossWho: [], reach: 0, heavy: 0, other: 0, left: 0, reachSeen: false, heavySeen: false };
    const left = (pieces || []).filter((p) => p && p.alive !== false && isFree(this.pieceClaimOf(p)));
    why.left = left.length;
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a || !ready(a) || (this._pendingLaunches && this._pendingLaunches.has(i))) continue;
      why.stayed++;
      if (left.length === 0) { why.ranOut++; continue; }
      const fit = left.filter((p) => this._armFitsPiece(a, p));
      if (fit.length === 0) {
        const kinds = left.map((p) => this._armShortfall(a, p));
        const far = kinds.includes('reach');
        if (far) why.reachSeen = true;
        if (kinds.includes('heavy')) why.heavySeen = true;     // every reason present is kept, not only the one she is counted under
        if (far) why.reach++; else why.heavy++;
        continue;
      }
      const blockers = fit.map((p) => this._crossingArm(a, p));
      if (blockers.every(Boolean)) {
        why.cross++;
        const name = blockers[0].displayName;
        if (!why.crossWho.includes(name)) why.crossWho.push(name);
      } else {
        why.other++;
      }
    }
    return why;
  }

  /**
   * One daughter per piece, best first. Each piece goes to the best docked daughter that can hold it, reach it and
   * whose line stays clear; a piece that has an owner is skipped; daughters left over stay docked (`_whyStayed` says why).
   * @param {object[]} pieces best first
   * @returns {number} how many daughters were sent
   * @private
   */
  _sendOnePerPiece(pieces) {
    let sent = 0;
    for (const piece of pieces) {
      if (!piece || piece.alive === false) continue;
      if (!this.arms.some((a) => armCanLaunchNow(a))) break;
      // the daughter must hold it, reach it AND stay clear; when the best one falls short the next is tried
      const pick = this._pickLaunchArm(piece, null, (a) => this._armFitsPiece(a, piece));
      if (pick.refusal) continue;
      if (!pick.arm || !this._armFitsPiece(pick.arm, piece)) continue;
      if (this._launchTargetOrFree(pick.arm, piece)) sent++;
    }
    return sent;
  }

  /**
   * Would turning the ship to point +Z along `dirWorld` (a net aim) wrap a daughter's line round the hull? The daughters
   * stay where they are in space while the ship turns; each line then runs from her strut anchor (fixed on the ship) to
   * where she is, seen from the TURNED ship. A hit on the ship keep-out in the first 30 m is a wrap.
   * The whole turn is walked in 5 degree steps along the shortest arc, not just its end: the end attitude alone is a poor
   * guide (measured in the real game: the ship came to rest 9.5 degrees from the predicted attitude, and the answer for a
   * 175 degree aim went clear, wrap, wrap, clear, wrap across the last 15 degrees), and a line dragged across the hull on the
   * way round is as tangled as one that ends there.
   * @param {{x:number,y:number,z:number}} dirWorld unit direction to aim along (world / scene frame)
   * @returns {{wraps: boolean, arm: (object|null), part: string, atDeg: (number|null)}} `atDeg`: how far into the turn
   */
  netTurnWraps(dirWorld) {
    const none = { wraps: false, arm: null, part: '', atDeg: null };
    try {
      const p = this.playerSatellite;
      const ko = this.getKeepOut();
      const pos = p && (p.position || (p.mesh && p.mesh.position));
      if (!ko || !pos || !p.quaternion || !dirWorld) return none;
      // every daughter that is out (docked and reloading ones have no line)
      const lines = [];
      for (let i = 0; i < this.arms.length; i++) {
        const a = this.arms[i];
        if (!a || a.isDetached || !a.position) continue;
        if (a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.RELOADING || a.state === ARM_STATES.HOLDING_CATCH
            || a.state === ARM_STATES.EXPENDED || a.state === ARM_STATES.DOCKING || a.state === ARM_STATES.CARRY_PREP) continue;
        const anchor = this._anchorShipM(a);
        if (!anchor) continue;
        lines.push({ arm: a, i, anchor, dx: a.position.x - pos.x, dy: a.position.y - pos.y, dz: a.position.z - pos.z });
      }
      if (lines.length === 0) return none;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(p.quaternion);
      const want = new THREE.Vector3(dirWorld.x, dirWorld.y, dirWorld.z).normalize();
      const total = fwd.angleTo(want);
      const arc = new THREE.Quaternion().setFromUnitVectors(fwd, want);
      const STEP = degToRad(5);
      const n = Math.max(1, Math.ceil(total / STEP));
      const ident = new THREE.Quaternion();
      const part = new THREE.Quaternion();
      const inv = new THREE.Quaternion();
      const v = new THREE.Vector3();
      for (let k = 1; k <= n; k++) {
        part.slerpQuaternions(ident, arc, k / n);
        inv.copy(part).multiply(p.quaternion).invert();
        for (const L of lines) {
          v.set(L.dx, L.dy, L.dz).applyQuaternion(inv);
          const hit = lineWrapsShip({ a: L.anchor, b: [v.x / M, v.y / M, v.z / M] }, ko,
            { ignore: ['dau' + L.i, 'strut' + L.i, 'rack catch ' + L.i] });
          if (hit.wraps) return { wraps: true, arm: L.arm, part: hit.part, atDeg: Math.round(radToDeg(total * k / n)) };
        }
      }
    } catch (err) {
      if (!this._wrapWarned) { this._wrapWarned = true; console.warn('[ArmManager] net-turn wrap check failed; turning unchecked:', err); }
    }
    return none;
  }

  _sayCantTurn(reason) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: holdsStillLine(reason), priority: 'info',
    });
  }

  /**
   * Does `a` NOT limit the mother's turn for `exceptArm`? True for `exceptArm`
   * herself (her own reservation and state), and for another daughter on the strut line (state REELING and home — her
   * line is being wound in). False without `exceptArm` (launch callers), and for a daughter still in GRAPPLED, her net
   * reel included: that daughter is working.
   * @private
   */
  _rhIgnoredForTurn(a, exceptArm) {
    return !!exceptArm && (a === exceptArm || (a.state === ARM_STATES.REELING && a.isReelingHome === true));
  }

  /**
   * Why the mother may NOT turn for a launch right now, in plain words, or null when she is free to turn.
   * Free = no daughter out on a line (rotation-lock tier 'none'), no launch in flight or waiting (another arm
   * LAUNCHING, an arm reserved, a pending launch, an aim running), no catch on the collar / nose (state + size:
   * `_heldCatchCorridorRadiusM`, whatever its mass), no hand-off, no scripted turn and no other system holding
   * the attitude (a mother-net reel-in). Catches latched on radiator tips and on daughters' racks do NOT block:
   * they are held rigidly and their inertia is already in the turn's gas bill (`getAttitudeInertia`).
   * @returns {string|null}
   * @private
   */
  _motherTurnBlock(exceptArm = null) {
    if (this.getRotationLockTier(exceptArm) !== 'none') return 'a daughter is out on her line';
    // with the steering gas out she turns on the tail boxes, minutes for a launch turn: the strut aims alone ("Aiming the arm
    // only: the steering gas is empty, so the ship holds still.") and a reel-home line-up is hers to do. (With the reaction-wheel
    // kit powered and not full the wheels turn her for no gas, a launch turn the aim may still refuse as too slow for its 30 s:
    // then the strut aims alone, `_deployWithCeremony`)
    const pl = this.playerSatellite;
    if (pl && typeof pl.isSlothMode === 'function' && pl.isSlothMode()
        && !(typeof pl.wheelsCanTurn === 'function' && pl.wheelsCanTurn())) return 'the steering gas is empty';
    const ap = this._autopilot;
    // the autopilot flying the ship keeps steering it back to its own heading the moment a turn ends, so a daughter's turn
    // would be undone: she lines herself up instead. Launch callers (no argument) are unaffected.
    if (exceptArm && ap && ap.engaged === true) return 'the autopilot is flying the ship';
    // with `exceptArm` the daughter's own reservation does not count, nor the reservation of another daughter on the strut
    // line (REELING); the mother's own reel-home turn (below) is not "a hand-off" either.
    const mine = !!exceptArm && !!this._rhTurn;
    if ((this._pendingLaunches && this._pendingLaunches.size > 0)
        || this.arms.some((a) => a && ((a._aimReserved && !this._rhIgnoredForTurn(a, exceptArm))
          || a.state === ARM_STATES.LAUNCHING))
        || (ap && typeof ap.isAiming === 'function' && ap.isAiming())) {
      return 'a launch is in progress';
    }
    const ld = this.playerSatellite && this.playerSatellite.leashDriver;
    if (ld && typeof ld.isActive === 'function' && ld.isActive()) return 'a hand-off is running';
    if (this._heldCatchCorridorRadiusM() !== null) return 'a catch is on the collar';
    if (!mine && ap && typeof ap.isTurning === 'function' && ap.isTurning()) return 'a hand-off is running';   // a scripted turn takes an anonymous hold too
    if (ap && typeof ap.isReelInHeld === 'function' && ap.isReelInHeld()) {
      // say what is true: the hold starts the moment a net or the lasso leaves; while it is still flying there is no catch
      // yet, only "a net is out".
      return netIsOut(this.claimWorld()) ? 'a net is out' : 'a catch is being reeled in';
    }
    if (!mine && ap && typeof ap.isAttitudeHeld === 'function' && ap.isAttitudeHeld()) return 'a hand-off is running';
    return null;
  }

  /**
   * Pane-density pure-scenery rung: hide/show every daughter's scene group for an empty-orbit view. Prior per-arm group
   * visibility is remembered so a restore never resurrects an EXPENDED/lost daughter (ArmUnit hides its group on
   * deorbit-complete). A daughter deployed while hidden is not retroactively hidden — an accepted edge of the mode.
   * @param {boolean} visible
   */
  setFleetVisible(visible) {
    if (!visible) {
      if (!this._fleetVisMemory) this._fleetVisMemory = new Map();
      for (const arm of this.arms) {
        if (!arm || !arm.group) continue;
        this._fleetVisMemory.set(arm, arm.group.visible);
        arm.group.visible = false;
      }
    } else {
      const mem = this._fleetVisMemory;
      for (const arm of this.arms) {
        if (!arm || !arm.group) continue;
        arm.group.visible = mem && mem.has(arm) ? mem.get(arm) : true;
      }
      this._fleetVisMemory = null;
    }
  }

  /**
   * Mother hidden (floor-4/5 ship-is-icon costume, menu, Ships step): a daughter that is still attached to her
   * (docked on a strut, or holding a catch at the tip) is part of the ship and hides with her; one flying on her own
   * stays drawn. Called once a frame from main.js. Idempotent while hidden, restores only what this call hid, and never
   * resurrects an expended daughter. Allocation-free (at most four arms).
   * @param {boolean} hidden  the mother's current hidden state
   * @returns {number} bitmask of the daughters whose group is hidden after the pass (a change key for held catches)
   */
  syncAttachedWithMother(hidden) {
    const S = Constants.ARM_STATES;
    let mask = 0;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || !arm.group) continue;
      const attached = isArmAttachedToMother(arm.state);
      if (hidden && attached) {
        if (arm.group.visible) { arm.group.visible = false; arm._hiddenWithMother = true; }
      } else if (arm._hiddenWithMother) {
        arm._hiddenWithMother = false;
        if (arm.state !== S.EXPENDED) {
          if (!this._fleetVisMemory) arm.group.visible = true;
          // The "-" Ships step took its memory while we had her hidden: that memory says "hidden", and "+" would restore it for good.
          else if (this._fleetVisMemory.get(arm) === false) this._fleetVisMemory.set(arm, true);
        }
      }
      if (!arm.group.visible) mask |= (1 << i);
    }
    return mask;
  }

  /**
   * Forward the live camera→craft distance (scene units) to each daughter so its inert detail hardware can be culled at
   * range. Cheap: each daughter only does work when a hysteresis threshold is crossed.
   * @param {number} distSceneUnits
   */
  setCameraDistance(distSceneUnits) {
    for (const arm of this.arms) {
      if (arm && typeof arm.setCameraDistance === 'function') {
        arm.setCameraDistance(distSceneUnits);
      }
    }
  }

  /**
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction = null) {
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    const maxTrawl = (Constants.TRAWLING && Constants.TRAWLING.MAX_TRAWL_ARMS) || 3;
    const trawling = this.arms.filter(a => a.state === ARM_STATES.TRAWLING);

    if (trawling.length >= maxTrawl) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'DTR-MGR', text: `Max trawl daughters (${maxTrawl}) deployed`, priority: 'warning',
      });
      return false;
    }

    let arm = this._findDockedArm('spinner');
    if (!arm) arm = this._findDockedArm('weaver');
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'DTR-MGR', text: 'No docked daughters available', priority: 'warning',
      });
      return false;
    }

    // No direction given: she sweeps along her own dock direction (frozen at the request).
    return this._launchArm(arm, 'trawl', () => this._trawlDirShip(arm, direction),
      () => arm.deployTrawl(direction), direction ? undefined : { frozenAim: true });
  }

  /**
   * "Fire and forget" ranged shot that increases debris atmospheric drag.
   * @param {object} target - Debris object with .id and ._scenePosition
   * @param {'weaver'|'spinner'|null} [preferType] - Preferred arm type
   * @returns {boolean} true if web shot was fired
   */
  fireWebShot(target, preferType = null) {
    if (!target) return false;

    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power for web shot',
        priority: 'warning',
      });
      return false;
    }

    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (selected.state === ARM_STATES.DOCKED &&
          selected._webShotCooldown <= 0 && selected.fuel > Constants.WEB_SHOT_FUEL_COST) {
        if (selected.fireWebShot(target)) return true;
      }
    }

    const eligible = (a) =>
      a.state === ARM_STATES.DOCKED &&
      a._webShotCooldown <= 0;

    let arm = preferType
      ? this.arms.find(a => a.type === preferType && eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST)
      : null;
    if (!arm) {
      arm = this.arms.find(a => eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST);
    }
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available for web shot (cooldown or insufficient fuel)',
        priority: 'warning',
      });
      return false;
    }
    return arm.fireWebShot(target);
  }

  /**
   * Debris field for trawling proximity checks.
   * @param {import('../entities/DebrisField.js').DebrisField} debrisField
   */
  setDebrisField(debrisField) {
    this._debrisField = debrisField;
  }

  /**
   * Inject the CatalogLoader so arm-arming code can look up active-sat entries before committing. Null-safe: if not set,
   * the treaty guard is a no-op.
   * @param {object} catalogLoader
   */
  setCatalogLoader(catalogLoader) {
    this._catalogLoader = catalogLoader || null;
  }

  /**
   * ResourceSystem, for reading upgraded resource maxes.
   * @param {ResourceSystem} rs
   */
  setResourceSystem(rs) {
    this._resourceSystem = rs;
  }

  /**
   * Wire the SceneManager so docked/close daughters can join the near-field depth pass. Without this, daughters render on layer 0
   * (far pass), get occluded by the depth-cleared near pass and z-fight the mother's strut-tip collars. Null-safe.
   * @param {import('../scene/SceneManager.js').SceneManager} sceneManager
   */
  setSceneManager(sceneManager) {
    this._sceneManager = sceneManager || null;
  }

  /**
   * Issue deorbit sacrifice command to the first arm that has captured debris.
   * The arm burns all remaining FEEP fuel retrograde and is lost.
   * @returns {{ success: boolean, armId?: string, fuelAtStart?: number, totalMass?: number, debrisId?: number }}
   */
  deorbitCapturingArm() {
    // Prefer the selected arm if it is eligible. Only fuel-capable states are eligible for the auto-pick path (a deorbit burn
    // needs real propellant): ADRIFT (reserve-only) is deliberately NOT eligible here, so an out-of-fuel daughter can't intercept
    // and consume a healthy daughter's deorbit via the find() fallback below.
    const isEligible = (a) =>
      (a.state === ARM_STATES.GRAPPLED ||
       a.state === ARM_STATES.HAULING ||
       a.state === ARM_STATES.RETURNING) &&
      (a.capturedDebris || a.target);

    let eligible = null;
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (isEligible(selected)) {
        eligible = selected;
      } else if (selected && selected.state === ARM_STATES.ADRIFT &&
                 (selected.capturedDebris || selected.target)) {
        // the player explicitly targeted an adrift daughter: let startDeorbit emit the "reel her in instead" hint for THAT
        // daughter (scoped to the selection so it can't shadow another's deorbit)
        selected.startDeorbit();
        return { success: false };
      }
    }
    if (!eligible) {
      eligible = this.arms.find(isEligible);
    }

    if (!eligible) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughter with captured debris available for deorbit sacrifice',
        priority: 'warning',
      });
      return { success: false };
    }

    const result = eligible.startDeorbit();
    if (result.success) {
      return {
        success: true,
        armId: eligible.id,
        fuelAtStart: result.fuelAtStart,
        totalMass: result.totalMass,
        debrisId: eligible.capturedDebris?.id || eligible.target?.id,
      };
    }
    return { success: false };
  }

  /**
   * @param {string} armId
   */
  recallArm(armId) {
    const arm = this.arms.find(a => a.id === armId);
    if (arm) arm.recall();
  }

  /**
   * Get the best candidate arm for detach.
   * Priority: APPROACH > TRANSIT > NETTING > GRAPPLED > STATION_KEEP > ADRIFT.
   * If ARM PILOT is active, prefer the piloted arm (including a station-keeping
   * or adrift daughter, so X cuts HER tether).
   * @returns {ArmUnit|null}
   */
  getActiveDetachCandidate() {
    const S = ARM_STATES;
    const PRIORITY = [S.APPROACH, S.TRANSIT, S.NETTING, S.GRAPPLED, S.STATION_KEEP, S.ADRIFT];
    const selected = this.getSelectedDeployedArm();
    if (selected && !selected.isDetached) {
      const detachable = new Set(PRIORITY);
      if (detachable.has(selected.state)) return selected;
    }
    for (const state of PRIORITY) {
      const arm = this.arms.find(a => a.state === state && !a.isDetached);
      if (arm) return arm;
    }
    return null;
  }

  /**
   * @param {number} armIndex
   * @returns {boolean}
   */
  detachArm(armIndex) {
    const arm = this.arms[armIndex];
    if (!arm) return false;
    return arm.detach();
  }

  /**
   * Shift+D and Shift+N send every docked daughter out, ONE PER PIECE, best first. `target` (the picked piece) goes first, then
   * `more` (the next eligible pieces, best first, from InputManager). Each piece takes the best docked daughter that can hold it,
   * reach it and whose strut line stays clear of the lines already out; a piece that already has an owner is skipped; daughters
   * left over stay docked and one line says how many went. The picked piece itself, when owned, is refused with the reason
   * (nothing is sent). With no `target` (and no `more`) every docked daughter free-flies.
   * @param {object|null} target - The picked piece. If null (and `more` empty), deploys in free-fly.
   * @param {object[]} [more] - Further pieces for the other daughters, best first.
   * @returns {number} Number of arms successfully deployed
   */
  deployAllToTarget(target, more = []) {
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy', priority: 'warning',
      });
      return 0;
    }

    const rest = Array.isArray(more) ? more.filter(Boolean) : [];
    if (!target && rest.length === 0) {
      let free = 0;
      for (const arm of this.arms) {
        if (arm.state !== ARM_STATES.DOCKED) continue;
        if (!arm.springCharged) continue;
        if (this._launchTargetOrFree(arm, null)) free++;
      }
      eventBus.emit(Events.COMMS_MESSAGE, free > 0
        ? { text: `${free} daughter${free > 1 ? 's' : ''} deployed (free-fly)`, priority: 'info' }
        : { text: 'No daughters available. Check charge status.', priority: 'warning' });
      return free;
    }

    const pieces = [];
    const seen = new Set();
    for (const t of [target, ...rest]) {
      if (!t) continue;
      const key = t.id !== undefined && t.id !== null ? t.id : t;
      if (seen.has(key)) continue;
      seen.add(key);
      pieces.push(t);
    }
    // The picked piece is the player's own choice: when it has an owner, say who and send nobody.
    if (target) {
      const owned = this.launchRefusalAt(target);
      if (owned) { this._sayWarn(owned.text); return 0; }
    }

    const sent = this._sendOnePerPiece(pieces);
    // the daughters that stayed docked, by cause - no piece left, a crossing line, out of reach, too heavy
    const why = this._whyStayed(pieces);
    if (sent > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: fanOutLine(sent, why.stayed, why), priority: 'info' });
    } else if (why.stayed === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: 'No daughters available. Check charge status.', priority: 'warning' });
    } else {
      this._sayWarn(fanOutNoneLine(why));
    }
    return sent;
  }

  /**
   * Shift+A fan-out: deploy every docked daughter to a *distinct* debris so the fleet spreads across the field for quick,
   * high-risk salvage. The i-th deployable daughter is sent to the first listed piece she can hold and reach, that nobody owns (a
   * daughter, a net or a catch) and whose strut line stays clear of the lines already out. When there are more daughters than
   * pieces, the extras fall back to `fallbackTarget` (the mother's active target) when that piece is still free, or free-fly
   * when none is given. Returns the number deployed.
   *
   * @param {Array<object>} targets - distinct debris objects, best-first
   * @param {object|null} [fallbackTarget] - target for surplus daughters
   * @returns {number} number of daughters successfully deployed
   */
  deployAllToDistinctTargets(targets, fallbackTarget = null) {
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy', priority: 'warning',
      });
      return 0;
    }

    const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
    const keyOf = (t) => (t.id !== undefined && t.id !== null ? t.id : t);
    const used = new Set();
    let deployed = 0;
    for (const arm of this.arms) {
      if (arm.state !== ARM_STATES.DOCKED) continue;
      if (!arm.springCharged) continue;
      // Pieces nobody owns yet (a daughter, a net or a catch), and not given to an earlier daughter in this send.
      const open = list.filter((t) => !used.has(keyOf(t)) && isFree(this.pieceClaimOf(t)));
      let target = null;
      if (open.length > 0) {
        // The first open piece this daughter can hold, reach and fly to on a clear line; none suits her -> she stays docked.
        target = open.find((t) => this._armFitsPiece(arm, t) && !this._crossingArm(arm, t)) || null;
        if (!target) continue;
      } else if (fallbackTarget) {
        // Surplus daughter: the mother's own piece, only while it is still free and her line to it is clear.
        if (used.has(keyOf(fallbackTarget)) || !isFree(this.pieceClaimOf(fallbackTarget))
            || this._crossingArm(arm, fallbackTarget)) continue;
        target = fallbackTarget;
      } else if (list.length > 0 && used.size === 0) {
        // Every listed piece already has an owner (a daughter, a net, a catch): nobody is sent to fly with no piece at all.
        continue;
      }
      if (this._launchTargetOrFree(arm, target)) {
        deployed++;
        if (target) used.add(keyOf(target));
      }
    }

    // the daughters this send left docked, and why - counted, never silent (the lines to fly at: the list, and the surplus
    // fallback while it is still a piece to send somebody to)
    const ready = (a) => a.state === ARM_STATES.DOCKED && !!a.springCharged && !a._aimReserved;
    const candidates = fallbackTarget && !list.some((t) => keyOf(t) === keyOf(fallbackTarget)) ? [...list, fallbackTarget] : list;
    const why = this._whyStayed(candidates, ready);
    if (deployed > 0) {
      const pieces = Math.min(deployed, used.size) || 1;
      const head = `${deployed} daughter${deployed > 1 ? 's' : ''} fanned out across ${pieces} target${pieces > 1 ? 's' : ''}`;
      const tail = stayedLine(why);
      eventBus.emit(Events.COMMS_MESSAGE, { text: tail ? `${head}. ${tail}` : head, priority: 'info' });
    } else if (why.stayed === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available. Check charge status.',
        priority: 'warning',
      });
    } else {
      // Daughters were ready and nobody went: the true reason (a crossing line, out of reach, too heavy, or every piece owned).
      this._sayWarn(fanOutNoneLine(why));
    }
    return deployed;
  }

  recallAll() {
    for (const arm of this.arms) {
      arm.recall();
    }
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'All daughters recalled',
      priority: 'info',
    });
  }

  /**
   * Recall every *deployed* daughter (Shift+R). Unlike recallAll(), this skips arms that are already resting / homing / spent
   * (DOCKED, EXPENDED, DOCKING; a detached RETURNING daughter has no line) or parked with a catch (HOLDING_CATCH — recall
   * refuses her, so commanding her would eat the hold; see ArmUnit.recall) and returns the number actually commanded home, so
   * the caller can give honest feedback ("Reeling in all daughters (N)" vs "nothing to reel").
   * @returns {number} count of daughters commanded to reel home
   */
  recallAllDeployed() {
    const S = ARM_STATES;
    let count = 0;
    for (const arm of this.arms) {
      if (!arm) continue;
      if (arm.state === S.DOCKED) continue;
      if (arm.state === S.EXPENDED) continue;
      // a tethered RETURNING daughter (limping home on her FEEP) is on her line: R winds her in (recall() -> REELING)
      if (arm.state === S.RETURNING && arm.isDetached) continue;
      if (arm.state === S.DOCKING) continue;
      if (arm.state === S.HOLDING_CATCH) continue; // parked with cargo — recall refuses her
      if (_CARRY_STATES.has(arm.state)) continue;  // carrying a catch to a furnace — it ends at her dock
      if (typeof arm.recall === 'function') {
        // zero-fuel reel on the mothership tether motor: stuck / fuel-depleted tethered daughters always come home (never
        // abandoned as EXPENDED); count only real recalls (recall() === true): 'already' (reeling) and refusals are not recalls
        if (arm.recall() === true) count++;
      }
    }
    return count;
  }

  /**
   * Propagate the Shift-held boost-reel intent to every arm. Called every frame from InputManager.processInput so the boost
   * always releases on keyup / overlay open.
   * @param {boolean} held
   */
  setReelBoost(held) {
    for (const arm of this.arms) {
      arm._boostReelHeld = !!held;
    }
  }

  /**
   * Recall a deployed daughter: the SELECTED one first, closest as fallback.
   *   • If `selectedArmIndex` points at an eligible deployed daughter (recallable state, not detached), recall HER (covers the
   *     pick-then-launch → skip-ceremony path). A DOCKED selection (picked, never launched) is NOT recallable and falls through
   *     to the closest scan: selection alone must never short-circuit eligibility.
   *   • Eligible = any non-resting state (NOT DOCKED, EXPENDED, DOCKING, HOLDING_CATCH, a detached RETURNING one: those are
   *     already docking, unable to be recalled, or parked with a catch recall must not destroy). A tethered RETURNING daughter
   *     IS eligible (R winds her in on the strut reel).
   *   • Picks the candidate with the smallest world-space distance from the mother. When `motherPos`/`arm.position` is
   *     unresolvable the scan silently keeps `eligible[0]`.
   *   • Calls `arm.recall()`, the same flow `H` triggers.
   *
   * @returns {number|null} 0-based index of the recalled arm, or `null` if
   *   no eligible deployed daughter was found.
   */
  recallClosestDeployed() {
    const S = ARM_STATES;
    const isRecallable = (a) => a
      && a.state !== S.DOCKED
      && a.state !== S.EXPENDED
      && !(a.state === S.RETURNING && a.isDetached)
      && a.state !== S.DOCKING
      && a.state !== S.HOLDING_CATCH
      && !_CARRY_STATES.has(a.state);

    if (this.selectedArmIndex >= 0) {
      const sel = this.arms[this.selectedArmIndex];
      if (sel && isRecallable(sel) && !sel.isDetached
          && typeof sel.recall === 'function') {
        sel.recall();
        return this.selectedArmIndex;
      }
    }

    const eligible = [];
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a) continue;
      if (!isRecallable(a)) continue;
      eligible.push({ idx: i, arm: a });
    }
    if (eligible.length === 0) return null;

    const motherPos = (this.playerSatellite && (this.playerSatellite.position
      || (this.playerSatellite.mesh && this.playerSatellite.mesh.position))) || null;

    let bestIdx = eligible[0].idx;
    let bestDistSq = Infinity;
    for (const { idx, arm } of eligible) {
      if (motherPos && arm.position) {
        const dx = arm.position.x - motherPos.x;
        const dy = arm.position.y - motherPos.y;
        const dz = arm.position.z - motherPos.z;
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDistSq) {
          bestDistSq = dsq;
          bestIdx = idx;
        }
      }
    }

    const target = this.arms[bestIdx];
    if (target && typeof target.recall === 'function') {
      target.recall();
      return bestIdx;
    }
    return null;
  }

  /**
   * Fire two opposite arms simultaneously to cancel recoil.
   * Antipodal pairs: Y0 (0↔2, 1↔3), Y1 (0↔3, 1↔4, 2↔5), Y3 + end-face (6↔7).
   * Use getDualFirePair() to resolve the correct partner at any tier.
   * @param {number} armIndex1 - First arm index
   * @param {number} armIndex2 - Second arm index (opposite)
   * @param {Object} target1 - Target for arm 1 (optional)
   * @param {Object} target2 - Target for arm 2 (optional)
   * @returns {boolean} Success
   */
  dualFire(armIndex1, armIndex2, target1 = null, target2 = null, opts = null) {
    const arm1 = this.arms[armIndex1];
    const arm2 = this.arms[armIndex2];

    if (!arm1 || !arm2) return false;

    // a pair at ONE fixed strut angle (the pair ceremony's: `firePair`) is the barrier path below, never the per-target gate.
    if (opts && Number.isFinite(opts.alpha)) return this._dualFireFixed(arm1, arm2, target1, target2, opts);

    if (arm1.state !== ARM_STATES.DOCKED || !arm1.springCharged) return false;
    if (arm2.state !== ARM_STATES.DOCKED || !arm2.springCharged) return false;

    // each goes through the keep-out gate; a pair only counts as a DUAL fire (recoil cancelled) when BOTH fired now — a launch
    // the gate deferred leaves a single-arm launch later
    const deployed1 = this._launchTargetOrFree(arm1, target1);
    const deployed2 = this._launchTargetOrFree(arm2, target2);
    const pend = this._pendingLaunches;
    const firedTogether = deployed1 && deployed2
      && !(pend && (pend.has(armIndex1) || pend.has(armIndex2)));

    if (firedTogether) {
      // net recoil (~zero for same-type pairs)
      const mass1 = arm1.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const mass2 = arm2.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const recoil1 = mass1 * arm1.launchSpeed;
      const recoil2 = mass2 * arm2.launchSpeed;
      const residualMomentum = Math.abs(recoil1 - recoil2);
      // Her LIVE mass (the budget, the two daughters already out of it); MASS_KG, her start mass, when there is no player or it
      // answers nothing usable.
      const live = this.playerSatellite ? this.playerSatellite.mass : NaN;
      const motherMass = Number.isFinite(live) && live > 0 ? live : Constants.MOTHER_DRAG.MASS_KG; // kg
      const residualDv = residualMomentum / motherMass;

      eventBus.emit(Events.DUAL_FIRE, {
        armIndex1,
        armIndex2,
      });

      eventBus.emit(Events.DUAL_FIRE_RECOIL, {
        cancelled: residualDv < 0.01,
        residualDv: residualDv,
      });

      return true;
    }

    // Both accepted but one was deferred by the gate: no DUAL_FIRE yet (they will
    // not fire together). Otherwise at least one was refused.
    return !!(deployed1 && deployed2);
  }

  // PAIR SHOT (owner 2026-10-25; DECISIONS §38 row 5)

  /**
   * The Q key (and the touch PAIR button): launch the pair the autopilot offers, both daughters in the SAME frame. Both arms reserved and
   * both pieces claimed; the mother turns (yaw, pitch only) while both struts swing to the pair's ONE angle (`requestAimRotation`, `pair`
   * option); then `_pairBarrier` fires both. `_launchTargetOrFree` is not used: it gives each strut its own angle (different frames).
   * Nothing leaves unless both can.
   * @returns {boolean} true when the ceremony started
   */
  firePair() {
    const ap = this._autopilot;
    const offer = (ap && typeof ap.getPairOffer === 'function') ? ap.getPairOffer() : null;
    const say = (text, priority = 'warning') => { eventBus.emit(Events.COMMS_MESSAGE, { text, priority }); return false; };
    if (!offer) return say(pairNoneLine(), 'info');
    const player = this.playerSatellite;
    if (player && player.safeMode) return say('Daughters locked. Safe mode active. Repair subsystems first.');
    if (powerDistribution.armMultiplier <= 0) return say('CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy');
    if (tripRefuses('daughter')) return false;
    const pairs = [[offer.armA, offer.tA], [offer.armB, offer.tB]];
    for (const [arm, target] of pairs) {
      if (!target || target._disposed === true || target.alive === false) return say(pairNotReadyLine(arm.displayName));
      if (arm.state !== ARM_STATES.DOCKED || !arm.springCharged || !(arm.fuel > 5) || arm._aimReserved) return say(pairNotReadyLine(arm.displayName));
      if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
      const refused = this.indexLaunchRefusal(arm.index, target);
      if (refused) return say(refused.text);
      const far = this._pairOutOfReach(arm, target);
      if (far) return say(`${arm.displayName}: Target ${Math.round(far.distM)}m away (max ${Math.round(far.maxRange)}m). Press A to autopilot closer first.`);
    }
    const blocked = this._motherTurnBlock();
    if (blocked) return say(pairNeedsTurnLine(blocked), 'info');
    if (typeof ap.isAiming === 'function' && ap.isAiming()) return say('Turning the ship to line up the launch — stand by.', 'info');
    const [[armA, tA], [armB, tB]] = pairs;
    armA._claimTarget = tA; armB._claimTarget = tB;
    armA._aimReserved = true; armB._aimReserved = true;
    const release = () => { armA._aimReserved = false; armB._aimReserved = false; armA._claimTarget = null; armB._claimTarget = null; };
    ap.requestAimRotation(ap.pairAimProvider(offer), {
      mode: 'daughter', armManager: this, arm: armA, pairIndex: armA.index, pair: { armB, alpha: offer.alpha },
      maxWaitS: Constants.AIM.AIM_TIMEOUT_S,
    }).then(() => {
      armA._aimReserved = false; armB._aimReserved = false;
      try {
        this._pairBarrier(offer);
      } catch (err) {
        // a check at the barrier threw: neither daughter has left (the checks come before the springs)
        release();
        console.warn('[ArmManager] pair shot: the launch check failed', err);
        this._sayWarn(pairErrorLine());
      }
    }).catch((err) => {
      release();
      if (err && err.code === 'TOO_SLOW') this._sayWarn('Pair shot cancelled: the turn is too slow. Neither daughter left.');
    });
    return true;
  }

  /** @private is the piece past this daughter's deploy range? @returns {{distM:number, maxRange:number}|null} */
  _pairOutOfReach(arm, target) {
    if (!target || !target._scenePosition || !arm.position) return null;
    const distM = target._scenePosition.clone().sub(arm.position).length() / M;
    const maxRange = arm.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION;
    return distM > maxRange ? { distM, maxRange } : null;
  }

  /** The aim is done: both struts are at the pair's angle and she is on the pair's attitude. Fire both, or neither. @private */
  _pairBarrier(offer) {
    const { armA, armB, tA, tB, alpha } = offer;
    const stop = (text) => { armA._claimTarget = null; armB._claimTarget = null; this._sayWarn(text); return false; };
    for (const [arm, target] of [[armA, tA], [armB, tB]]) {
      if (arm.state !== ARM_STATES.DOCKED || !arm.springCharged) return stop(pairNotReadyLine(arm.displayName));
      const why = this._releaseBlock(arm, target);
      if (why) return stop(pairDroppedLine(arm.displayName, why));
    }
    return this.dualFire(armA.index, armB.index, tA, tB, { alpha, offer });
  }

  /**
   * The barrier: every check that could stop either daughter runs FIRST (piece taken/lost, strut off `opts.alpha`, pieces drifted off the
   * lines `PAIR_SHOT.FIRE_MISS_DEG`, a ship part across a line, tethers crossing); only when all pass do both leave, in this one call.
   * Any "no" releases both with ONE plain line; the struts are never moved to clear a line. `DUAL_FIRE` emits only when both launched.
   */
  _dualFireFixed(arm1, arm2, t1, t2, opts) {
    const PS = Constants.PAIR_SHOT;
    const alpha = opts.alpha;
    const stop = (text) => { arm1._claimTarget = null; arm2._claimTarget = null; this._sayWarn(text); return false; };
    const pairs = [[arm1, t1], [arm2, t2]];
    const player = this.playerSatellite;
    if (player && player.safeMode) return stop('Daughters locked. Safe mode active. Repair subsystems first.');
    if (powerDistribution.armMultiplier <= 0) return stop('CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy');
    if (tripRefuses('daughter')) return stop(pairNotReadyLine(arm1.displayName));
    for (const [arm, target] of pairs) {
      if (arm.state !== ARM_STATES.DOCKED || !arm.springCharged || !(arm.fuel > 5)) return stop(pairNotReadyLine(arm.displayName));
      if (target) {
        const why = this._releaseBlock(arm, target);
        if (why) return stop(pairDroppedLine(arm.displayName, why));
        // the piece may have drifted out of reach while she turned (the aim only follows the lines)
        const far = this._pairOutOfReach(arm, target);
        if (far) return stop(pairRangeLine(arm.displayName, far.distM, far.maxRange));
      }
      if (typeof arm.getAimAlpha === 'function' && Math.abs(arm.getAimAlpha() - alpha) > degToRad(0.5)) return stop(pairStrutLine(arm.displayName));
    }
    const ap = this._autopilot;
    if (opts.offer && ap && typeof ap.pairMissesNow === 'function') {
      const m = ap.pairMissesNow(opts.offer);
      if (!m || m.missA > PS.FIRE_MISS_DEG || m.missB > PS.FIRE_MISS_DEG) return stop(pairDriftLine(m ? m.missA : 90, m ? m.missB : 90));
    }
    for (const [arm] of pairs) {
      let v;
      try { v = this.launchLineBlocked(arm.index, this._strutDirShip(arm)); }
      catch (err) { console.warn('[ArmManager] pair shot: the line check failed', err); return stop(pairErrorLine()); }   // never silent, never one alone
      if (v.blocked) return stop(pairHeldLine(arm.displayName, v.part));
    }
    if (t1 && t2 && this._pairTethersCross(arm1, t1, arm2, t2)) return stop(pairCrossLine());
    arm1._claimTarget = t1 || null; arm2._claimTarget = t2 || null;
    arm1._aimConverged = true; arm2._aimConverged = true;
    const ok1 = t1 ? arm1.deploy(t1) : arm1.deployFreefly();
    const ok2 = t2 ? arm2.deploy(t2) : arm2.deployFreefly();
    arm1._aimConverged = false; arm2._aimConverged = false;
    if (!ok1 || !ok2) {
      if (!ok1) arm1._claimTarget = null;
      if (!ok2) arm2._claimTarget = null;
      if (ok1 || ok2) this._sayWarn(`Pair shot: only ${ok1 ? arm1.displayName : arm2.displayName} left; ${ok1 ? arm2.displayName : arm1.displayName} stayed docked.`);
      if (ok1 || ok2) eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm: ok1 ? arm1 : arm2 });
      return ok1 || ok2;
    }
    eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm: arm1 });
    eventBus.emit(Events.DUAL_FIRE, { armIndex1: arm1.index, armIndex2: arm2.index });
    this._pairRecoil = { a: arm1, b: arm2, t: 0 };
    this._pairLink(arm1, arm2);       // partners for the way home only once both have left
    return true;
  }

  _pairLink(a, b) {
    a._pairPartner = b; b._pairPartner = a;
    a._pairWaiting = b._pairWaiting = false; a._pairWaitS = b._pairWaitS = 0;
    a._pairGo = b._pairGo = null; a._pairTogether = b._pairTogether = false;
    a._pairSaid = b._pairSaid = false; a._pairCatchFailed = b._pairCatchFailed = false;
  }

  _pairUnlink(a) {
    const b = a._pairPartner;
    a._pairPartner = null; a._pairSaid = false; a._pairCatchFailed = false;
    if (b && b._pairPartner === a) { b._pairPartner = null; b._pairSaid = false; b._pairCatchFailed = false; }
  }

  /**
   * One frame of the pair link and the reel-start barrier, run once after every arm's update. The link BREAKS when a daughter docks, is
   * recalled / goes home / loses the piece without having left the barrier together (`_pairTogether`), is lost, or her catch fails
   * (`_pairCatchFailed`, set by `ArmUnit._finishFailedCatch`), or the partner link is not mutual. A daughter held at the barrier
   * (`_pairWaiting`) is let go (`_pairGo`, read by her next update: both in the SAME frame) when both wait; alone, after
   * `PAIR_SHOT.HOME_WAIT_S` of her own waiting (0 = she never waits).
   * @param {number} dt mission-clock seconds (the arms' dt); unused: `ArmUnit._pairBarrierHolds` counts her own wait
   */
  _tickPairHome(dt) {
    const S = ARM_STATES;
    const PS = Constants.PAIR_SHOT || {};
    for (const a of this.arms) {
      if (!a) continue;
      const b = a._pairPartner;
      if (!b) continue;
      const gone = (x) => x.isDetached || x.state === S.DOCKED || x.state === S.DOCKING || x.state === S.RELOADING || x.state === S.HOLDING_CATCH
        || x.state === S.EXPENDED || x.state === S.DEORBITING
        || ((x.state === S.REELING || x.state === S.RETURNING || x.state === S.ADRIFT || x.state === S.HAULING) && !x._pairTogether);
      if (b._pairPartner !== a || gone(a) || gone(b) || a._pairCatchFailed || b._pairCatchFailed) this._pairUnlink(a);
    }
    for (const a of this.arms) {
      if (!a || !a._pairPartner || a.index > a._pairPartner.index) continue;     // each pair once, from its lower strut
      const b = a._pairPartner;
      if (a._pairWaiting && b._pairWaiting && !a._pairGo && !b._pairGo) {
        a._pairGo = b._pairGo = 'both';                                          // both leave the barrier next frame
        a._pairSaid = b._pairSaid = true;
        continue;
      }
      const w = a._pairWaiting ? a : (b._pairWaiting ? b : null);
      if (!w) continue;
      if (!w._pairSaid) { w._pairSaid = true; const o = w._pairPartner; if (o) o._pairSaid = true; eventBus.emit(Events.COMMS_MESSAGE, { text: pairHoldLine(), priority: 'info' }); }
    }
    for (const a of this.arms) {
      if (!a || !a._pairPartner || !a._pairWaiting || a._pairGo) continue;
      if (a._pairWaitS >= (PS.HOME_WAIT_S ?? 60) - 1e-9) {
        a._pairGo = 'alone';
        this._pairUnlink(a);
      }
    }
    for (const a of this.arms) {
      if (a && !a._pairPartner && a._pairWaiting && !a._pairGo) a._pairGo = 'alone';
    }
  }

  /** The two tethers of a pair at its fixed angle, as `_lineSet` would draw them, swap sides? @private */
  _pairTethersCross(arm1, t1, arm2, t2) {
    const V5 = Constants.OCTOPUS_V5;
    const line = (arm, t) => {
      const b = t._scenePosition ? this._shipPointM(t._scenePosition) : null;
      if (!b || !arm.dockOffset || typeof arm.getAimAlpha !== 'function') return null;
      const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
      const d = strutLocalDirection(arm.getAimAlpha(), az, new THREE.Vector3());
      const reel = V5.STRUT_LENGTH * 0.85;
      return { a: [Math.cos(az) * V5.COLLAR_RADIUS + d.x * reel, Math.sin(az) * V5.COLLAR_RADIUS + d.y * reel, V5.COLLAR_Y + d.z * reel], b };
    };
    try {
      const A = line(arm1, t1), B = line(arm2, t2);
      return !!(A && B && linesCross(A, B));
    } catch (err) { return false; }
  }

  /**
   * Once both springs of a pair launch have fired (the same frame) the opposite kicks cancel: emit `DUAL_FIRE_RECOIL`, so the
   * linear-recoil gas each daughter's push billed is refunded (`PlayerSatellite._applyDualFireRecoil`). Called each frame.
   */
  _tickPairRecoil(dt) {
    const pr = this._pairRecoil;
    if (!pr) return;
    pr.t += dt;
    if (pr.a._springFired && pr.b._springFired) {
      this._pairRecoil = null;
      const m1 = pr.a.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const m2 = pr.b.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const residual = Math.abs(m1 * pr.a.launchSpeed - m2 * pr.b.launchSpeed);
      const live = this.playerSatellite ? this.playerSatellite.mass : NaN;
      const motherMass = Number.isFinite(live) && live > 0 ? live : Constants.MOTHER_DRAG.MASS_KG;
      const residualDv = residual / motherMass;
      eventBus.emit(Events.DUAL_FIRE_RECOIL, { cancelled: residualDv < 0.01, residualDv });
    } else if (pr.t > 5 || (pr.a.state !== ARM_STATES.LAUNCHING && pr.b.state !== ARM_STATES.LAUNCHING && pr.t > 0)) {
      this._pairRecoil = null;       // one never fired (recalled in the clamp): nothing to refund together
    }
  }

  /**
   * @param {number} index - arm index
   * @returns {number} antipodal arm index (`getDualFirePair`), or -1 if none
   */
  getOppositeArm(index) {
    const result = this.getDualFirePair(index);
    return result !== null ? result : -1;
  }

  /**
   * Antipodal partner for dual-fire: the arm whose azimuth = (this azimuth + 180°) % 360° (all tiers; Y3 includes the end-face pair +Z ↔ −Z).
   * @param {number} armIndex — 0-based arm index
   * @returns {number|null} Antipodal partner index, or null if none
   */
  getDualFirePair(armIndex) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    const dp = this._dockPositions[armIndex];
    const targetAz = (dp.azimuthDeg + 180) % 360;

    for (let j = 0; j < this._dockPositions.length; j++) {
      if (j === armIndex) continue;
      if (Math.abs(this._dockPositions[j].azimuthDeg - targetAz) < 0.1) return j;
    }
    return null;
  }

  /** @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO' */
  getCurrentTier() {
    return this._activeTierKey;
  }

  /**
   * Strut tip position at sweep angle α. Convention (ArmDockBasis.strutLocalDirection — the RENDERED ship frame):
   *   α = 0   → STOWED  (alongside barrel, daughter aft at −Z)
   *   α = π/2 → EQUATORIAL (radial outward in the collar XY plane)
   *   α = π   → ZENITH  (pointing +Z, forward of Mother)
   * tip = hinge + STRUT_LENGTH × ( sin(α)·outward − cos(α)·ẑ ). Delegates to CoMCalculator.strutTipMeters, which owns the
   * stored-dock → ship-frame map; this twin must never re-derive it.
   * @param {number} armIndex — arm index
   * @param {number} alpha — sweep angle in radians [0, π]
   * @returns {{x: number, y: number, z: number}|null} Tip in METERS (not scene units; caller scales by M), ship frame, or null
   */
  getStrutTipPosition(armIndex, alpha) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    return strutTipMeters(this._dockPositions[armIndex], alpha);
  }

  /**
   * The "." hotkey's strut toggle, PUBLIC (the REFIT BERTHS STRUTS chip, the F1 `struts` actuator and InputManager's Period case call it):
   * the ONE copy of the strut law. Writes `_strutTargetAlpha` on DOCKED arms and on daughters HOLDING A CATCH (owner 2026-10-22: never
   * below her hold pose, never above 100°; see `_pressHolders`); decides from the live read (getAimAlpha, a pending latch winning: never
   * the latch alone, it clears to undefined on arrival).
   * The law (owner 2026-10-14; angles measured from the tail):
   *   • a press while any docked strut is open (live or pending, past STRUT_OPEN_THRESHOLD, half the rest angle, 17°) → ALL to 0°;
   *   • otherwise → ALL to STRUT_REST_ALPHA, 34° (swept back);
   *   • with `armIndex` of a DOCKED daughter (owner 2026-10-16) "ALL" means just her, and the open/closed test reads only her strut;
   *   • a press within STRUT_PUSH_WINDOW_MS (600 ms) of the previous press → ALL to STRUT_DEPLOY_ALPHA, 90°, whatever the first press
   *     did; the window then resets (a third quick press is a fresh single press). So a second press
   *     inside 600 ms ALWAYS means 90°; reversing a swing needs a press after 600 ms;
   *   • no tap sequence ever targets 180° (STRUT_SWEEP_MAX is the range, not a target).
   * Emitting Events.STRUT_DEPLOY_INPUT stays the CALLER's job (as does the click).
   * @returns {boolean|null} true = opening (34° or 90°), false = closing (0°); null when no DOCKED or holding arm could take the write
   *   (nothing toggled; the caller skips its emit). A press that moves nothing leaves one plain sentence for the caller to say: a DOUBLE
   *   press in `lastStrutPressNote`, a single press in `_pendingStrutNote` (said by `_tickStrutPressNote` after the double-press window).
   */
  toggleStruts(armIndex) {
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;               // a new press supersedes a line still waiting out the double-press window
    let docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    // a daughter holding a catch takes the press too; her strut stays between her hold pose and HOLD_POSE_MAX_DEG (see `_pressHolders`)
    let holders = (this.arms || []).filter((a) => a && a.state === ARM_STATES.HOLDING_CATCH && !a.isDetached
      && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h));
    if (Number.isInteger(armIndex) && armIndex >= 0) {
      const only = (this.arms || [])[armIndex];
      if (only && only.state === ARM_STATES.DOCKED) { docked = [only]; holders = []; }
      else if (only && holders.includes(only)) { docked = []; holders = [only]; }
    }
    if (!docked.length && !holders.length) return null;
    const V5 = Constants.OCTOPUS_V5;
    // the open/closed read comes from the docked struts; with only holders it reads whether they stand above their hold pose
    const holdRad = (a) => { const hp = _holdPoseOf(this, this.arms.indexOf(a)); return hp ? hp.rad : V5.STRUT_REST_ALPHA; };
    const anyOpen = docked.length
      ? docked.some((a) => _strutLiveAlpha(a) >= V5.STRUT_OPEN_THRESHOLD)
      : holders.some((a) => _strutLiveAlpha(a) > holdRad(a) + degToRad(V5.HOLD_POSE_DEADBAND_DEG));
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const doubleTap = this._lastStrutTap !== undefined
      && now - this._lastStrutTap < V5.STRUT_PUSH_WINDOW_MS;

    // a press is a manual override: each commanded arm gets a marker; StrutAuto leaves it alone until 10 s after it ARRIVES.
    // Plain data writes only (the Salvage tests run this body on bare stub objects).
    const autoOn = Constants.FEATURE_FLAGS.STRUT_AUTO === true;
    if (autoOn) this._strutPress = (this._strutPress | 0) + 1;

    if (doubleTap) {
      this._lastStrutTap = undefined;               // one 90° per double tap
      for (const a of docked) {
        a._strutTargetAlpha = V5.STRUT_DEPLOY_ALPHA;
        if (autoOn) a._strutManual = { quietS: 0 };
      }
      _pressHolders(this, holders, V5.STRUT_DEPLOY_ALPHA, autoOn, docked.length === 0);
      return true;
    }

    this._lastStrutTap = now;
    const targetAlpha = anyOpen ? 0 : V5.STRUT_REST_ALPHA;
    for (const arm of docked) {
      arm._strutTargetAlpha = targetAlpha;
      if (autoOn) arm._strutManual = { quietS: 0 };
    }
    _pressHolders(this, holders, targetAlpha, autoOn, docked.length === 0);
    if (this.lastStrutPressNote) {
      this._pendingStrutNote = { text: this.lastStrutPressNote, leftS: V5.STRUT_PUSH_WINDOW_MS / 1000 };
      this.lastStrutPressNote = null;
    }
    return !anyOpen;
  }

  /**
   * The opening's SET (StartOpening, owner 2026-10-20 "on the player's first action"): every DOCKED strut still closed goes to
   * STRUT_REST_ALPHA (34°). Never a toggle: a strut already open (live or pending past STRUT_OPEN_THRESHOLD) is left alone. Not a
   * player press: no `_strutPress` count, no `_strutManual` 10 s hold, no tap-timer, no emit.
   * @returns {boolean|null} true = every docked strut is now open or opening; null when no DOCKED arm could take the write
   */
  restStruts() {
    const docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    if (!docked.length) return null;
    const V5 = Constants.OCTOPUS_V5;
    for (const arm of docked) {
      if (_strutLiveAlpha(arm) >= V5.STRUT_OPEN_THRESHOLD) continue;
      arm._strutTargetAlpha = V5.STRUT_REST_ALPHA;
    }
    return true;
  }

  /**
   * Read-only: the SAME predicate toggleStruts() decides from (any DOCKED strut past STRUT_OPEN_THRESHOLD, 17°; a pending latch counts).
   * @returns {boolean}
   */
  strutsDeployed() {
    return (this.arms || []).some((a) =>
      a && a.state === ARM_STATES.DOCKED
      && _strutLiveAlpha(a) >= Constants.OCTOPUS_V5.STRUT_OPEN_THRESHOLD);
  }

  /**
   * Pulse scan: every docked, charged arm fires as a sensor node (needs at least 2).
   * @returns {boolean} true when the scan started
   */
  pulseScan() {
    if (this._pulseScanCooldown > 0) return false;

    const scanArms = this.arms.filter(a =>
      a.state === ARM_STATES.DOCKED && a.springCharged
    );

    if (scanArms.length < 2) return false; // Need at least 2 for triangulation

    for (const arm of scanArms) {
      arm.startScan();
    }

    this._pulseScanCooldown = PULSE_SCAN_COOLDOWN;

    eventBus.emit(Events.PULSE_SCAN_START, {
      armCount: scanArms.length,
    });

    this._pulseScanTimer = PULSE_SCAN_DURATION;
    this._pulseScanActive = true;

    return true;
  }

  /**
   * Speed dial (`;` down / `'` up) for all arms; emits LAUNCH_SPEED_CHANGED with the clamped fleet value.
   * @param {number} speed - m/s, clamped to tier limits
   */
  setFleetLaunchSpeed(speed) {
    for (const arm of this.arms) {
      arm.setLaunchSpeed(speed);
    }
    eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
  }

  /**
   * @param {number} index - arm index
   * @param {number} speed - m/s, clamped to tier limits
   */
  setArmLaunchSpeed(index, speed) {
    if (this.arms[index]) {
      this.arms[index].setLaunchSpeed(speed);
      eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
    }
  }

  /**
   * What a save must keep per daughter (DECISIONS §34 row 10): ion fuel (%) and cold-gas bottle (kg), keyed by arm id (a changed arm
   * tier cannot shift the values onto another daughter).
   * @returns {Array<{id: string, fuel: number, coldGasKg: number}>}
   */
  getSupplyState() {
    return this.arms.map((a) => ({ id: a.id, fuel: a.fuel, coldGasKg: a.coldGasKg }));
  }

  /**
   * Put saved ion fuel and cold gas back (matched by id; unknown ids skipped, a non-finite value leaves that tank). Fuel clamps to
   * [0, SUPPLY_FUEL_MAX_PCT] (the Daughter Fuel Reserve lifts a full tank to 150 %), the bottle to [0, its size]. Call AFTER `reset()`
   * and the upgrade replay (`ArmUnit.reset()` fills the tanks; the replay can raise a tank's max).
   * @param {Array<{id: string, fuel?: number, coldGasKg?: number}>|null} list
   * @returns {number} how many daughters were restored
   */
  restoreSupplyState(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const e of list) {
      const a = e && this.arms.find((x) => x.id === e.id);
      if (!a) continue;
      if (Number.isFinite(e.fuel)) a.fuel = Math.min(SUPPLY_FUEL_MAX_PCT, Math.max(0, e.fuel));
      if (Number.isFinite(e.coldGasKg)) a.coldGasKg = Math.min(a._coldGasBottleKg(), Math.max(0, e.coldGasKg));
      n++;
    }
    return n;
  }

  /** The fleet launch speed (m/s): max across arms (all share the fleet spring tier). @returns {number} */
  getFleetLaunchSpeed() {
    if (!this.arms || this.arms.length === 0) return Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT;
    return Math.max(...this.arms.map((a) => a.launchSpeed));
  }

  /** @param {number} tier - Spring tier index */
  applySpringUpgrade(tier) {
    for (const arm of this.arms) {
      arm.setSpringTier(tier);
    }
  }

  /**
   * The one hub for the line-fibre upgrade (DECISIONS §33 row 5): the purchase, the save-load replay and the reset replay all land
   * here; the tier raises the tether length AND the net capacities (Constants.TETHER_TIERS[tier].nets: mother / large / small daughter).
   * Loaded nets stay loaded (new cartridges arrive empty, fill at the stop); capacity never drops. No second listener anywhere.
   * @param {number} tier - Tether tier index
   * @param {{fill?: boolean}} [opts] fill = load every launcher to the new capacity (save-load path)
   */
  applyTetherUpgrade(tier, opts = {}) {
    for (const arm of this.arms) {
      arm.setTetherTier(tier);
    }
    const idx = Math.max(0, Math.min(Number.isFinite(tier) ? Math.floor(tier) : 0, Constants.TETHER_TIERS.length - 1));
    const nets = Constants.TETHER_TIERS[idx].nets;
    if (!nets) return;
    const fill = !!opts.fill;
    for (const arm of this.arms) {
      if (typeof arm.setNetCapacity !== 'function') continue;
      arm.setNetCapacity(arm.type === 'weaver' ? nets.large : nets.small, { fill });
    }
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    if (cns && typeof cns.setMotherNetCapacity === 'function') cns.setMotherNetCapacity(nets.mother, { tier: idx, fill });
    const ps = this.playerSatellite;
    if (ps && typeof ps.setNetCellCount === 'function') ps.setNetCellCount(nets.mother);
  }

  /**
   * Add/remove each daughter's HULL (`arm.mesh`, child of `arm.group`) to the near-field depth pass by distance to the mother, with
   * hysteresis. WHY the hull, not the group: the mother-spanning `arm.tetherLine` hangs on `arm.group` and must stay on layer 0 (far
   * pass: it can span to far debris and must not be scaled into the near sub-render); the ×S transform preserves screen projection, so
   * it still lines up with the near-pass hull. Distances are in scene units (1 unit = 100 km; M = 1e-5 /m).
   * @param {THREE.Vector3} parentPos mother world position (scene units)
   */
  _updateNearFieldMembership(parentPos) {
    const sm = this._sceneManager;
    if (!sm || typeof sm.registerNearFieldRoot !== 'function' || !parentPos) return;

    const M = 1e-5;                 // 1 metre in scene units
    const INCLUDE_D = 10 * M;       // ≤ 10 m from mother → join near pass
    const EXCLUDE_D = 15 * M;       // ≥ 15 m → leave (hysteresis band avoids flip-flop)

    for (const arm of this.arms) {
      const hull = arm && arm.mesh;
      if (!hull) continue;
      const pos = arm.position || arm.group?.position;
      if (!pos) continue;

      const d = pos.distanceTo(parentPos);
      const isMember = arm._nearFieldMember === true;

      if (!isMember && d <= INCLUDE_D) {
        sm.registerNearFieldRoot(hull);
        arm._nearFieldMember = true;
      } else if (isMember && d >= EXCLUDE_D) {
        sm.unregisterNearFieldRoot(hull);
        arm._nearFieldMember = false;
      }
    }
  }

  /** @param {number} dt - Real-time delta in seconds */
  update(dt, opts) {
    const parentPos = this.playerSatellite.position || this.playerSatellite.mesh?.position || new THREE.Vector3();
    const parentQuat = this.playerSatellite.quaternion || null;

    if (this._pulseScanCooldown > 0) {
      this._pulseScanCooldown -= dt;
      if (this._pulseScanCooldown < 0) this._pulseScanCooldown = 0;
    }

    if (this._pulseScanActive && this._pulseScanTimer !== undefined) {
      this._pulseScanTimer -= dt;
      if (this._pulseScanTimer <= 0) {
        this._pulseScanActive = false;
        const detections = [];
        eventBus.emit(Events.PULSE_SCAN_COMPLETE, { detections });
      }
    }

    const passiveArms = this.arms.filter(a =>
      a.state === ARM_STATES.TRAWLING
    );
    if (passiveArms.length > 0 && this._debrisField) {
      const nearbyDebris = this._debrisField.getUntrackedDebrisNear
        ? this._debrisField.getUntrackedDebrisNear(parentPos, 0.05)  // 5km radius
        : [];
      const tracked = this._debrisField.getTargetList ? this._debrisField.getTargetList() : [];
      // resolve to CANONICAL field objects by id (the lists hand back wrappers): captures must pin, flag and remove the real object
      const seen = new Set();
      const allDebris = [];
      const getById = this._debrisField.getDebrisById?.bind(this._debrisField);
      for (const w of [...tracked, ...nearbyDebris]) {
        if (!w || w.id == null || seen.has(w.id)) continue;
        seen.add(w.id);
        const canonical = getById ? getById(w.id) : w;
        if (canonical && canonical.alive !== false) allDebris.push(canonical);
      }
      for (const arm of passiveArms) {
        arm._nearbyDebris = allDebris;
      }
    }

    const armMult = powerDistribution.armMultiplier;
    const speedScale = armMult > 0 ? armMult : 0.1;

    // digestion sun scale: 1.0 in sunlight, ECLIPSE_RATE in eclipse (weather solar multiplier 0 = eclipse; a 1.3 flare does not overcook);
    // mocks without the getter cook at full rate
    const FTD = Constants.FURNACE_TRANSFER;
    const solarMult = (this._resourceSystem && typeof this._resourceSystem.getSolarPowerMultiplier === 'function')
      ? this._resourceSystem.getSolarPowerMultiplier()
      : 1.0;
    const digestSunScale = solarMult > 0 ? 1.0 : (FTD.TRANSIT_DIGEST_ECLIPSE_RATE ?? 1.0);

    // the collar's digestion clock is the same law's mother-side consumer: one multiplier SSOT, one per-frame write
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    if (cns) cns._digestSunScale = digestSunScale;

    for (const arm of this.arms) {
      arm._beaconSpeedScale = speedScale;
      arm._digestSunScale = digestSunScale;
      arm.update(dt, parentPos, parentQuat);
    }

    this._tickPairRecoil(dt);
    this._tickPairHome(dt);

    this._updateReelHome(dt, parentPos, parentQuat);
    this._updateCarry(dt);
    this._tickMissionCarry(dt);
    this._tickStrutPressNote(dt);
    this._tickWingClear(dt);        // each held catch's wing profile, in budgeted steps (before the holders' writers read it)

    this._syncTetherDrums();

    // hold-catch (owner 2026-10-22): a daughter holding a catch keeps her strut at her hold pose (34°, or the lowest plume-clear 5° step,
    // never above 100°); a strut the reel left high comes down. NOT flag-gated: it changes how the arm MOVES, never what thrust refuses.
    // Runs AFTER arm.update so aim writes land on fresh positions.
    this._tickNetDuck(dt);          // holders duck for an inbound mother net, lift for a neighbour's carry (inputs to the writer below)
    this._tickRadLifts(dt);         // and lift for the radiator wings moving through the band (third input)
    this._updateCargoPlumePoses(dt);

    this._updateLeanAside(dt);

    this._updateLaunchGates(dt);

    this._updateStrutAuto(dt, !!(opts && opts.noStrutAuto));

    // runs AFTER arm.update so positions are current for this frame
    this._updateNearFieldMembership(parentPos);

    // AUTHORITATIVE CATCH PIN (AFTER arms move and after DebrisField.update): force each reeling/docking arm's captured debris, looked up
    // CANONICALLY by id, onto the arm's position (and its rendered instance); otherwise net + debris drift away during reel-in.
    if (this._debrisField && this._debrisField.pinCapturedDebris) {
      for (const arm of this.arms) {
        // HOLDING_CATCH reads the parked cargo RACK (heldCatches); the haul states (REELING/DOCKING) read the in-hand scalar
        const pieces = (arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state))
          ? (arm.heldCatches || [])
          : (arm.capturedDebris ? [arm.capturedDebris] : null);
        if (!pieces || pieces.length === 0) continue;
        // the catch stays FULL SIZE from reel-in through docking and while parked (HOLDING_CATCH): no stow-shrink or removal
        if (arm.state === ARM_STATES.REELING ||
            arm.state === ARM_STATES.DOCKING ||
            arm.state === ARM_STATES.HOLDING_CATCH ||
            _CARRY_STATES.has(arm.state) ||     // the rack rides along on the carry
            (arm.state === ARM_STATES.GRAPPLED && arm._rhPinned === true) ||   // the net reel winds the pinned catch in
            (arm.state === ARM_STATES.GRAPPLED && arm._toolCatchRidesWithHer?.())) {   // a pad/magnet/gripper catch rides with her in the hold
          for (const d of pieces) {
            if (!d) continue;
            // once the staged furnace breakdown begins (debris._breakdownActive, set by ArmUnit at chop start), shrink the ORIGINAL instanced
            // catch out of view so FurnaceBreakdownVisual's chunk meshes are all that is seen; per piece, only the rack's oldest (the one
            // being chopped). Deliberately kept (owner 2026-10-06: "net vanishes at the daughter's re-dock"): this ramp is the crossfade to
            // the chunk stream (same _digestPhaseT clock); CaptureNetVisual carries the real bag through the chop on the same FT.chopScaleMul ramp.
            let scaleMul = 1;
            if (d._breakdownActive) {
              // phase boundaries from the single authoritative constant (no local defaults that could desync the ramp from the chop window);
              // ArmUnit's progress-derived phase time (_digestPhaseT), else stateTimer for legacy mocks; FT.chopScaleMul is shared with the collar chop
              const FT = Constants.FURNACE_TRANSFER;
              const phaseT = arm._digestPhaseT ?? arm.stateTimer;
              scaleMul = FT.chopScaleMul(phaseT);   // 1 → ~0 across the chop window
            }
            // honor the arm's standoff pin (_armPinPos = arm.position + holdDir × clearance, set by _pinCatchToSelf) so the catch hangs
            // outboard of the daughter instead of being re-snapped onto her position (she rendered INSIDE large catches)
            const pinPos = (d._armPinned && d._armPinPos) ? d._armPinPos : arm.position;
            this._debrisField.pinCapturedDebris(d, pinPos, scaleMul);
          }
        }
      }
    }
  }

  // carry: a daughter takes the catch on her rack to her radiator's tip furnace (ArmUnit.beginCarry)

  /** @returns {boolean} some daughter is on a carry (any CARRY state) */
  isCarrying() {
    for (const a of this.arms) if (a && a.isCarrying) return true;
    return false;
  }

  /** The gate's size row of a catch: the row of `PLUME_CARGO_ALPHA_LADDER` its `sizeMeter` falls in (unknown size: the deepest). */
  carryRowOf(debris) {
    const ladder = Constants.PLUME_CARGO_ALPHA_LADDER || [];
    const s = debris && debris.sizeMeter > 0 ? debris.sizeMeter : Infinity;
    for (let i = 0; i < ladder.length; i++) if (s <= ladder[i].maxSizM) return i;
    return Math.max(0, ladder.length - 1);
  }

  /**
   * The gate entry for a daughter's carry: `Constants.CARRY.GATE[pair]['<row>|<cell>']` = {strutDeg, thetaDeg} or
   * absent/null (no pose clears that row: it never carries). Generated offline (js/test/fixtures/carry-gate.json).
   * @param {ArmUnit} arm
   * @param {number} row size row (the larger of the pieces she holds)
   * @param {number} cell the delivered piece's rack cell
   * @returns {{strutDeg:number, thetaDeg:number}|null}
   */
  carryGateFor(arm, row, cell) {
    const G = Constants.CARRY && Constants.CARRY.GATE;
    const pair = G && G[arm.config.type];
    const e = pair && pair[`${row}|${cell}`];
    return e || null;
  }

  /** The carry is certified for the dock ring the quad has (4 daughters at its azimuths): any other layout never carries. @private */
  _carryLayoutOk() {
    const want = Constants.ARM_LADDER && Constants.ARM_LADDER.Y0_QUAD && Constants.ARM_LADDER.Y0_QUAD.azimuths;
    if (!want || this.arms.length !== want.length) return false;
    for (let i = 0; i < want.length; i++) {
      const a = this.arms[i];
      if (!a || Math.abs((a._azimuthDeg ?? NaN) - want[i]) > 1e-6) return false;
    }
    return true;
  }

  /**
   * The conditions the gate table was certified for that can change while a daughter waits or carries (the other petals' radiator range,
   * the other struts at rest angle or their HOLD POSE, neighbour catches the path was measured clear of, her own strut range). Read-only.
   * `null` = all hold, else `{reason, text}`; all clear by waiting except a 'neighbour-catch' whose catch fits no tip (`never: true`),
   * unless the neighbour can be LIFTED (a catch up to 5 m passes once she stands at 69° or higher): then `never` is false and `lift` names
   * who rises (`[{index, rad}]`; `_commandLifts` commands it, THIS stays read-only). A mother net coming home holds a carry only when it
   * NEEDS the holder a duck lowered or a lift has to raise ('net-inbound', never `never`). `opts.ignoreRealTime` (the unflown hand-over):
   * radiators judged where they SETTLE (`_flowerSettleDeg`; outside the window = 'radiators-angle', `never`); neighbour strut, net coming
   * in, her strut range and a liftable catch are skipped.
   * @param {ArmUnit} arm
   * @param {object|null} [nose] the nose route's bucket when the catch goes that way
   * @param {{ignoreRealTime?:boolean}} [opts]
   * @returns {null|{reason:string, text:string, never?:boolean, lift?:{index:number, rad:number}[]}}
   */
  carryConditions(arm, nose = null, opts = {}) {
    if (nose) return this._noseConditions(arm, nose, opts);
    const V = Constants.CARRY;
    const ps = this.playerSatellite;
    const n = arm.index + 1;
    const skipRT = opts.ignoreRealTime === true;
    const inRange = (deg) => V.OTHERS_RANGES_DEG.some(([lo, hi]) => deg >= lo - 1e-6 && deg <= hi + 1e-6);
    const sharedDeg = (ps._flowerThetaRad ?? 0) * RAD2DEG;
    const targetDeg = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta * RAD2DEG : sharedDeg;
    if (skipRT) {
      const settleDeg = this._flowerSettleDeg();
      if (!inRange(settleDeg)) {
        return { reason: 'radiators-angle', never: true, text: `The radiators are settling at ${Math.round(settleDeg)}°, where the hand-off was not tried. Daughter ${n} keeps her catch.` };
      }
    } else if (!inRange(sharedDeg) || !inRange(targetDeg)) {
      return { reason: 'radiators-moving', text: `The radiators are not settled. Daughter ${n} waits.` };
    }
    // while a mother net is coming home a holder whose catch is in its path is ducked, and a neighbour whose catch blocks this carry
    // cannot be lifted (the corridor is the net's): that carry waits for the berth (it clears by itself, so never `never`)
    const inbound = !skipRT && _inboundMotherNetRadiusM(this) !== null;
    const netWait = { reason: 'net-inbound', text: `A net is coming in. Daughter ${n} waits.` };
    for (const o of this.arms) {
      if (!o || o === arm || typeof o.getAimAlpha !== 'function') continue;
      if (inbound && o._netDuck) return netWait;                  // her strut is down for the net by design: off her pose until the berth
      const oDeg = o.getAimAlpha() * RAD2DEG;
      const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
      // a neighbour whose catch's wing profile is still pending has no hold pose yet: wait, with the 'neighbour-strut' reason
      if (!skipRT && held.length && armProfile(o).state === 1) {
        return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1} is still settling her catch. Daughter ${n} waits.` };
      }
      if (!skipRT && Math.abs(oDeg - V.NEIGHBOUR_REST_DEG) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
        // a neighbour holding a catch stands at her HOLD POSE (34..100 deg): accepted (the carry was measured against it, see
        // Constants.CARRY.NEIGHBOUR_CATCH_MAX_SIZE_M), as is the angle she was lifted to for this carry (`_netLift`); elsewhere is out of place
        const hp = held.length ? this._holdPoseCached(o, this.arms.indexOf(o), 0) : null;
        const atPose = !!hp && Math.abs(oDeg - hp.rad * RAD2DEG) <= V.NEIGHBOUR_TOL_DEG + 1e-6;
        const atLift = !!o._netLift && Math.abs(oDeg - o._netLift.rad * RAD2DEG) <= V.NEIGHBOUR_TOL_DEG + 1e-6;
        if (!atPose && !atLift) {
          return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1}'s strut is out of place. Daughter ${n} waits.` };
        }
      }
      // the catch on her nose is an obstacle the gate never saw: only catches the measurement cleared pass (Constants.CARRY)
      const high = oDeg >= V.NEIGHBOUR_CATCH_HIGH_POSE_DEG - V.NEIGHBOUR_TOL_DEG - 1e-6;
      const blocking = held.filter((h) => !(h.sizeMeter <= V.NEIGHBOUR_CATCH_MAX_SIZE_M + 1e-9
          || (high && h.sizeMeter <= V.NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M + 1e-9)));
      if (blocking.length) {
        // a catch that fits no radiator tip never leaves her rack by a hand-off: waiting does not help (`never`; carryCheck says retry:false)
        const tc = ps && ps.tipCargo;
        let never = !!(tc && typeof tc.fits === 'function' && blocking.some((h) => !tc.fits(DebrisField.trueReachM(h, 0))));
        // a liftable neighbour (see the docblock): waiting helps whatever the fit; `never` stays only when no angle 69-100° clears the
        // exhaust (a catch over 5 m, or every angle in a plume)
        const lift = this._liftsFor(arm);
        if (lift.length && lift.some((l) => l.index === o.index)) {
          if (inbound) return netWait;
          never = false;
        }
        if (skipRT && !never) continue;
        const out = { reason: 'neighbour-catch', never, text: `Daughter ${o.index + 1}'s catch is too close to Daughter ${n}'s path. Daughter ${n} keeps hers.` };
        if (lift.length) out.lift = lift;
        return out;
      }
    }
    const recDeg = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() * RAD2DEG : NaN;
    if (!skipRT && !(recDeg >= V.STRUT_REC_LO_DEG - 1e-6 && recDeg <= V.STRUT_REC_HI_DEG + 1e-6)) {
      return { reason: 'strut-range', text: '' };
    }
    return null;
  }

  /**
   * The angle (deg) the radiators are SETTLING to: the slew's target lowered to the ceiling the bags on the tips NOW set
   * (`PlayerSatellite._updateFlower` retargets only on its next frame, so the live target can be stale). The unflown hand-over
   * judges the radiators here.
   * @returns {number} degrees
   */
  _flowerSettleDeg() {
    const ps = this.playerSatellite;
    const shared = ps._flowerThetaRad ?? 0;
    let t = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta : shared;
    const tc = ps.tipCargo;
    const band = tc && typeof tc.maxRadiatorThetaRad === 'function' ? tc.maxRadiatorThetaRad() : Infinity;
    if (band !== Infinity && t > band + 1e-9) t = band - (Constants.THERMAL.FLOWER.SETTLE_EPS_RAD || 0);
    return radToDeg(t);
  }

  // the nose route: a catch longer than 0.5 m goes to the mother's nose, then by leash to a tip (Constants.CARRY.NOSE)

  /**
   * The reach the carry reads a catch by: its drawn reach (`DebrisField.trueReachM`; a typeless piece: half its size). A scoop bag
   * (`isBag`, set by the net lane; absent on pieces today) is a sphere: reach = sizeMeter / 2.
   */
  carryReachOf(d) {
    if (d && d.isBag === true && Number.isFinite(d.sizeMeter) && d.sizeMeter > 0) return d.sizeMeter / 2;
    return DebrisField.trueReachM(d, 0);
  }

  _noseParts() {
    const ps = this.playerSatellite;
    return {
      ps,
      tc: ps && ps.tipCargo,
      drv: (ps && ps.leashDriver) || (this.player && this.player.leashDriver) || null,
      cns: ps && ps._captureNetSystem,
    };
  }

  /**
   * Is this a nose candidate, and was the route certified for it? `null` = not a candidate (the caller keeps its 'gate' refusal): the
   * daughter holds more than one catch, or the catch is row 0, or the route is off. Otherwise `{refusal}` (the reach is in no certified
   * bucket) or `{bucket, reachM, gate}`, `gate` standing in for the GATE row the shared checks read (`swingBackReachM` is not used by the nose).
   */
  _noseCandidate(arm, rack, row, cell, reach) {
    const N = Constants.CARRY.NOSE;
    if (!N || N.ENABLED !== true || row < 1 || cell !== 0 || rack.length !== 1) return null;
    const n = arm.index + 1;
    const bucket = noseBucketFor(N.BUCKETS, reach);
    if (!bucket) {
      return {
        refusal: {
          ok: false, reason: 'nose-reach', retry: false, giveUp: true, sayKey: `${arm.index}|nose-reach`,
          text: reach > N.MAX_REACH_M
            ? `Daughter ${n}'s catch is too big to hand to the nose and then to a radiator (it reaches ${reach.toFixed(2)} m, the limit is ${N.MAX_REACH_M.toFixed(2)} m). It stays on her rack.`
            : `Daughter ${n}'s catch is not a size the nose hand-off was measured for (it reaches ${reach.toFixed(2)} m). It stays on her rack.`,
        },
      };
    }
    return { bucket, reachM: reach, gate: { nose: true, bucket } };
  }

  /** The catch-centre z on the collar axis (ship frame, metres) where the nose seats a catch (`catchHomeDistM`: what the mother's own catches use). */
  noseSeatZ(d) {
    const ps = this.playerSatellite;
    const anchorZ = (ps && ps._netBerthCollar && ps._netBerthCollar.position) ? ps._netBerthCollar.position.z / M
      : (Constants.OCTOPUS_V5 && Constants.OCTOPUS_V5.BERTH_COLLAR_Z_M != null ? Constants.OCTOPUS_V5.BERTH_COLLAR_Z_M : 1.30);
    return anchorZ + catchHomeDistM(ps, this, d);
  }

  /**
   * The catch-centre z (ship frame, metres) of the seat for a catch of reach `reachM` that has no body of its own: the VIRTUAL catch of
   * a bucket's top reach the route is flown for. Same function as a real catch's (`catchHomeDistM`), cached per reach AND per ship
   * shape (`homeShapeKey`: the radiators' angle and the bags on the tips). While the radiators swing the cached seat is reused.
   */
  noseSeatZForReach(reachM) {
    const key = Math.round(reachM * 1000);
    const shape = homeShapeKey(this.playerSatellite);
    if (!this._noseSeatCache) this._noseSeatCache = new Map();
    const hit = this._noseSeatCache.get(key);
    if (hit && (shape === null || hit.shape === shape)) return hit.z;
    const z = this.noseSeatZ({ sizeMeter: 2 * reachM });
    this._noseSeatCache.set(key, { shape, z });
    return z;
  }

  /** Prep re-read of what the offer read about the nose and the leash (ArmUnit `_updateCarryPrep`, every step): null = still fine, else the reason. */
  noseRecheck(arm) {
    const c = arm && arm._carry;
    if (!c || c.kind !== 'nose') return null;
    const r = this._noseHandOverRefusal(arm, c.nose, c.mission === true);
    return r ? r.reason : null;
  }

  /** The seat as a world (scene) point: where the leash's reach and gas plans see the catch once the nose has it. @private */
  _noseSeatScene(d, out) {
    const ps = this.playerSatellite;
    out.set(0, 0, this.noseSeatZ(d) * M).applyQuaternion(ps.quaternion || new THREE.Quaternion());
    const pos = ps.position || (ps.mesh && ps.mesh.position);
    if (pos) out.add(pos);
    return out;
  }

  /**
   * Is the nose free for a catch, and can the leash take it on from there? Null = yes, else `{reason, text, retry, giveUp}`. The nose
   * holds ONE body (`getDockedCatch`); a mother net or a lasso catch on its way keeps it; the leash is checked as `CaptureNet._tryLeash`
   * checks it before `drv.start`, so a catch never strands at the nose. Read-only (prep re-reads it through `noseRecheck`).
   */
  _noseHandOverRefusal(arm, nose, mission, ignoreRealTime = false) {
    const n = arm.index + 1;
    const { tc, drv, cns } = this._noseParts();
    const d = arm.heldCatches.find(Boolean);
    // `ignoreRealTime` (the trip's unflown hand-over, which uses neither the nose nor the leash): nose-busy, a busy tip, the leash's own
    // reach and its real-time refusals do not apply; the steering gas for the swing still does (`nose-gas`: physical, not refilled on a trip)
    if (cns && !ignoreRealTime) {
      const lasso = this.claimWorld().lasso;
      const busy = (typeof cns.getDockedCatch === 'function' && cns.getDockedCatch())
        || (typeof cns.hasMotherNetInFlight === 'function' && cns.hasMotherNetInFlight())
        || (lasso && (lasso.active || lasso._pendingAdoption));
      if (busy) return { reason: 'nose-busy', text: `The nose is busy with another catch. Daughter ${n} waits.`, retry: true };
    }
    if (tc && typeof tc.pickTip === 'function') {
      const tip = tc.pickTip();
      if (tip == null && !ignoreRealTime) return { reason: 'tip-busy', text: `Every radiator tip is busy. Daughter ${n} waits.`, retry: true };
      if (tip != null && drv && typeof drv.canReach === 'function' && d) {
        const seat = this._noseSeatScene(d, new THREE.Vector3());
        if (!ignoreRealTime && !drv.canReach(d, tip, seat)) {
          return { reason: 'nose-leash', text: `The leash cannot reach this catch from the nose. Daughter ${n} keeps it.`, retry: false, giveUp: true };
        }
        if (typeof drv.gasShort === 'function' && !Constants.isFeatureEnabled('FURNACE_COOK')
            && drv.gasShort(null, d, tip, { bagScene: seat })) {
          return { reason: 'nose-gas', text: `Not enough steering gas to swing the catch to a radiator from the nose. Daughter ${n} keeps it.`, retry: false };
        }
      }
    }
    if (!ignoreRealTime && drv && typeof drv.refusal === 'function') {
      const why = drv.refusal(null);
      // her own carry holds the ship still too (CARRY_* are rotation-locking states): in prep that is not a reason, another daughter out or leaving is
      const ownLock = why && why.key === 'daughter' && !!arm._carry && this.arms.every((o) => !o || o === arm || o.isDetached
        || (!_HIGH_RISK_ROT_STATES.has(o.state) && !_SOFT_ROT_STATES.has(o.state) && o.state !== ARM_STATES.LAUNCHING));
      if (why && !ownLock) return { reason: `mission-${why.key}`, text: '', retry: true };
    }
    return null;
  }

  /**
   * The conditions the nose route was certified for that can change while a daughter waits or flies the prep: radiators inside the
   * bucket's window (it depends on the biggest tip bag: `_tipBagReachM`, `noseRadiatorsOk`), the other struts at the hold pose with
   * catches no bigger than measured, her own strut at the hold pose, no mother net coming home. Read-only. `null` = all hold, else
   * `{reason, text, never?}`; all clear by waiting except a too-big neighbour catch and radiators SETTLED outside every window (`never`).
   */
  _noseConditions(arm, nose, opts = {}) {
    const V = Constants.CARRY, N = V.NOSE;
    const ps = this.playerSatellite;
    const n = arm.index + 1;
    const skipRT = opts.ignoreRealTime === true;
    const b = nose.bucket;
    const sharedDeg = (ps._flowerThetaRad ?? 0) * RAD2DEG;
    const targetDeg = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta * RAD2DEG : sharedDeg;
    const bagR = this._tipBagReachM();
    const settleDeg = skipRT ? this._flowerSettleDeg() : targetDeg;       // judged where they settle (inside the window: they are only moving, real-time)
    if (skipRT ? !noseRadiatorsOk(b, settleDeg, bagR) : (!noseRadiatorsOk(b, sharedDeg, bagR) || !noseRadiatorsOk(b, targetDeg, bagR))) {
      if (!skipRT && Math.abs(targetDeg - sharedDeg) > 0.01) {          // on their way somewhere: waiting helps once they stop
        return { reason: 'radiators-moving', text: `The radiators are still moving (${Math.round(sharedDeg)}°). Daughter ${n} waits.` };
      }
      // SETTLED outside every window. Nothing moves them (a bag on a tip holds them at its cap, and they are never moved for a carry:
      // no auto-close), so waiting never clears it: `never`, the trip's end rule does not wait for it, and the words say what the player can do.
      return { reason: 'radiators-angle', never: true, text: this._noseAngleText(n, skipRT ? settleDeg : sharedDeg, bagR, b) };
    }
    if (!skipRT && _inboundMotherNetRadiusM(this) !== null) return { reason: 'net-inbound', text: `A net is coming in. Daughter ${n} waits.` };
    for (const o of this.arms) {
      if (!o || o === arm || typeof o.getAimAlpha !== 'function') continue;
      // the catch size first: a catch past the measured reach never clears (retry false); a strut out of place does, so it must not hide that
      const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
      if (held.some((h) => this.carryReachOf(h) > N.NEIGHBOUR_CATCH_MAX_REACH_M + 1e-9)) {
        return { reason: 'neighbour-catch', never: true, text: `Daughter ${o.index + 1}'s catch is too close to Daughter ${n}'s path. Daughter ${n} keeps hers.` };
      }
      const oDeg = o.getAimAlpha() * RAD2DEG;
      if (!skipRT && Math.abs(oDeg - N.HOLD_DEG) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
        return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1}'s strut is out of place. Daughter ${n} waits.` };
      }
    }
    if (!skipRT && !arm._carry) {                                                  // the offer: her own strut stands at the hold pose the route starts from (in prep it is on its way to the seat angle)
      const recDeg = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() * RAD2DEG : NaN;
      if (!(Math.abs(recDeg - N.HOLD_DEG) <= V.NEIGHBOUR_TOL_DEG + 1e-6)) return { reason: 'strut-range', text: '' };
    }
    return null;
  }

  /** The biggest bag (reach, m) on any radiator tip now; 0 when no tip holds one. Read-only. @private */
  _tipBagReachM() {
    const tc = this.playerSatellite && this.playerSatellite.tipCargo;
    let m = 0;
    if (tc && typeof tc.spheres === 'function') for (const sp of tc.spheres()) if (sp.r > m) m = sp.r;
    return m;
  }

  /**
   * The refusal when the radiators stand, settled, where the nose hand-off was not run for this bucket and the bag now on a tip (plain words:
   * degrees, what holds them there, what works). `bagR > 0`: a catch on a tip is what holds them at that angle.
   */
  _noseAngleText(n, sharedDeg, bagR, bucket) {
    const spans = noseWindowSpans(bucket, bagR);
    const part = (x) => {
      const hi = Math.min(146, x[1]);                                    // the radiators open to 146° at most: a window's 146.5° end is only its float tolerance
      if (x[0] <= 1.5) return `closed (${Math.round(x[0])}°)`;
      const lo = Math.ceil(x[0] - 1e-9), up = Math.floor(hi + 1e-9);      // whole degrees INSIDE the window (132.75 reads 133°, never 132°)
      return hi - x[0] <= 1.5 ? `fully open (${Math.round((x[0] + hi) / 2)}°)` : `open ${lo}° to ${up}°`;
    };
    const works = spans.map(part).join(' or ');
    const at = Math.round(sharedDeg * 10) / 10;
    if (bagR > 0 && sharedDeg <= 1.5) {                                  // closed over a catch on a tip: nothing holds them there, the player closed them (closed is offered only with no catch on a tip)
      return `The radiators are closed (${Math.round(sharedDeg)}°) with a catch on a tip, and the hand-off to the nose was not tried that way. Daughter ${n} keeps her catch.`
        + (works ? ` It works with them ${works}.` : '');
    }
    if (bagR > 0) {
      return `The radiators are at ${at}°, held there by a catch on a tip, and the hand-off to the nose was not tried at that angle. Daughter ${n} keeps her catch.`
        + (works ? ` It works with them ${works}.` : '');
    }
    return `The radiators are at ${at}°; the hand-off to the nose works with them ${works || 'nowhere'}. Daughter ${n} keeps her catch until they are moved.`;
  }

  /**
   * Can this daughter start a carry now? Reads, changes nothing. `retry`: whether waiting can help. A catch that fits no tip, a row the
   * gate does not allow and a daughter without the fuel never carry; a busy tip, another carry, a hand-off under way, radiators or
   * neighbour struts not where the gate was certified end by themselves ('swing-back' too: the catch is bigger than the gate certified
   * for the radiators' present range). `giveUp`: waiting cannot change the answer (dock layout, fit, row, no tip record): the scheduler
   * marks her and stops asking until something changes. Options: `mission` (outside a trip: the leash's mission conditions also apply
   * and a launch request for her blocks it); `motherNetOnly` (refuse 'own-catch' unless the mother's net put the piece on the rack,
   * `_rackFromMotherNet`); `ignoreGaveUp` (skip the `_carryGaveUp` refusal, as `moveCatchToRadiator` does); `ignoreRealTime` (the
   * unflown hand-over): skip every refusal that days of time would clear, run every physical one (see `deliverUnflown`).
   * @param {ArmUnit} arm
   * @param {{mission?:boolean, motherNetOnly?:boolean, ignoreGaveUp?:boolean, ignoreRealTime?:boolean}} [opts]
   * @returns {{ok:boolean, reason:string, text:string, retry:boolean, giveUp:boolean, plan?:object}}
   */
  carryCheck(arm, opts = {}) {
    const S = ARM_STATES;
    const mission = opts.mission === true;
    const motherNetOnly = opts.motherNetOnly === true;
    const skipRT = opts.ignoreRealTime === true;
    const no = (reason, text = '', retry = true, giveUp = false, sayKey = '') => ({ ok: false, reason, text, retry, giveUp, sayKey });
    if (!arm || arm.isDetached || (arm.state !== S.HOLDING_CATCH && arm.state !== S.DOCKED)) return no('state', '', false);
    if (arm._carryGaveUp && opts.ignoreGaveUp !== true) {
      // her last carry failed on its own: not again until something changes. A mark `scheduleCarry` left for the leash's reach from the
      // nose ('nose-leash') is a real-time reason for the unflown hand-over (it uses no leash), so it does not hold her back there
      if (!(skipRT && arm._carryGaveUpWhy === 'nose-leash')) return no('gave-up', '', false);
    }
    const rack = Array.isArray(arm.heldCatches) ? arm.heldCatches.filter(Boolean) : [];
    if (rack.length === 0) return no('no-catch', '', false);
    const ps = this.playerSatellite;
    const tc = ps && ps.tipCargo;
    if (!tc || typeof ps.holdPetalForHandoff !== 'function' || typeof arm.beginCarry !== 'function') return no('no-tip', '', false, true);
    if (!this._carryLayoutOk()) return no('layout', '', false, true);
    const n = arm.index + 1;
    // the delivered piece is the outermost one (cell 1 leads when she holds two: cell 0's cannot pass it)
    let delivered = rack[0];
    const cellOf = (d, i) => (Number.isInteger(d._rackCell) ? d._rackCell : i);
    for (let i = 1; i < rack.length; i++) if (cellOf(rack[i], i) > cellOf(delivered, 0)) delivered = rack[i];
    // owner 2026-10-22 "Keep: radiator right away": the mission scheduler asks only for catches the MOTHER's net put on this rack (it
    // could not reach a tip at once); a catch the daughter caught herself stays ('own-catch': no line, not a give-up; "Press C" skips this)
    if (motherNetOnly && !delivered._rackFromMotherNet) return no('own-catch', '', false);
    const cell = clamp01(cellOf(delivered, rack.indexOf(delivered)));
    const reach = this.carryReachOf(delivered);
    if (!tc.fits(reach)) {
      return no('fit', `Daughter ${n}'s catch is too big for a radiator tip. It stays on her rack.`, false, true);
    }
    let row = 0;
    for (const d of rack) row = Math.max(row, this.carryRowOf(d));
    let gate = this.carryGateFor(arm, row, cell);
    // the direct carry has no row for a catch longer than 0.5 m (row >= 1; GATE holds row 0, cell 0 only): it can go to the nose and then
    // by leash instead. Only that cause: a second catch, or a row-0 catch with no gate entry, keeps the refusal. The direct carry has priority.
    let nose = null;
    if (!gate) {
      nose = this._noseCandidate(arm, rack, row, cell, reach);
      if (!nose) {
        return no('gate', `Daughter ${n} cannot carry this catch to a furnace without touching the ship. It stays on her rack.`, false, true);
      }
      if (nose.refusal) return nose.refusal;
      gate = nose.gate;
    }
    const tipIndex = nose ? -1 : arm.index;                   // her radiator: the tip on her line (DECISIONS §29 row 4); the nose route reserves none (the leash picks a tip after the hand-over)
    const fuelPct = nose ? arm.noseFuelPct() : (typeof arm.carryFuelPct === 'function' ? arm.carryFuelPct() : 0);
    if (!(arm.fuel >= fuelPct)) {
      return no('fuel', `Daughter ${n} has too little fuel to carry her catch. It stays on her rack.`, false);
    }
    if (!skipRT && this.isCarrying()) return no('carry-busy');
    const drv = ps.leashDriver || (this.player && this.player.leashDriver) || null;
    // ANY petal on its own (a hand-off, or one still swinging back from one) or a launch fold blocks it
    if (!skipRT && (ps.flowerPetalsBusy || ps.flowerLaunchLocked || (drv && drv.busy))) {
      return no('leash-busy', 'The radiators are busy with another catch. She waits.');
    }
    if (mission && !skipRT) {
      if (this._pendingLaunches && this._pendingLaunches.has(arm.index)) return no('launch-pending');
      const why = drv && typeof drv.refusal === 'function' ? drv.refusal(null) : null;
      if (why) return no(`mission-${why.key}`);
    }
    if (nose) {
      const r = this._noseHandOverRefusal(arm, nose, mission, skipRT);
      if (r) return no(r.reason, r.text, r.retry, r.giveUp === true);
    } else if (!skipRT && (tc.debrisAt(tipIndex) || (typeof tc.isReserved === 'function' && tc.isReserved(tipIndex)))) {
      return no('tip-busy', `Radiator ${tipIndex + 1}'s furnace is busy. Daughter ${n} waits.`);
    }
    const cond = this.carryConditions(arm, nose, skipRT ? { ignoreRealTime: true } : undefined);
    if (cond) {
      const r = no(cond.reason, cond.text, !cond.never);
      if (cond.lift) r.lift = cond.lift;                       // who can be lifted to let this carry pass (read-only here)
      return r;
    }
    // no carry starts whose swing BACK (petal released, catch in the tip bag, past her strut, body, hull and the other petals) is not
    // certified 0.15 m; the gate measured the largest catch reach per radiator range (closed / open): a bigger one waits for the other range
    if (!nose) {
      const V = Constants.CARRY;
      const sharedDeg = skipRT ? this._flowerSettleDeg() : radToDeg(ps._flowerThetaRad ?? 0);
      const closed = sharedDeg <= V.OTHERS_RANGES_DEG[0][1] + 1e-6;                      // [0, 1] deg = closed, [133, 146] = open (carryConditions)
      const limit = gate.swingBackReachM ? gate.swingBackReachM[closed ? 'closed' : 'open'] : 0;
      if (!(reach <= limit + 1e-9)) {
        return no('swing-back',
          closed
            ? `Daughter ${n}'s catch is too big to hand over while the radiators are closed. She waits for them to open.`
            : `Daughter ${n}'s catch is too big to hand over while the radiators are open. She waits for them to close.`,
          true, false, `${arm.index}|swing-back|${delivered.id ?? delivered.sizeMeter}`);
      }
    }
    if (nose) {
      return {
        ok: true, reason: '', text: '', retry: false, giveUp: false,
        plan: {
          kind: 'nose', tipIndex: -1, cell, delivered, row, mission,
          strutRad: degToRad(Constants.CARRY.NOSE.STRUT_DEG), thetaRad: 0, dir: null,
          recordedStrutRad: typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : degToRad(Constants.CARRY.NOSE.HOLD_DEG),
          nose: { bucket: nose.bucket, reachM: nose.reachM },
        },
      };
    }
    return {
      ok: true, reason: '', text: '', retry: false, giveUp: false,
      plan: {
        tipIndex, cell, delivered, row, mission,
        strutRad: degToRad(gate.strutDeg), thetaRad: degToRad(gate.thetaDeg), dir: gate.dir,
        recordedStrutRad: typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : degToRad(gate.strutDeg),
      },
    };
  }

  /**
   * The angle (rad) a neighbour HOLDING a big catch rises to so a carry can pass her: max(her hold pose, 69°) on the hold-pose grid, the
   * lowest at which her catch is out of every Hall exhaust, cap 100° (69° = `NEIGHBOUR_CATCH_HIGH_POSE_DEG`, where the carry was measured
   * clear of a catch up to 5 m). Null when she is not holding, a catch is over `NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M`, or no angle 69-100° clears.
   * @param {ArmUnit} o
   * @returns {number|null}
   */
  _neighbourLiftRad(o) {
    const V = Constants.CARRY;
    const V5 = Constants.OCTOPUS_V5;
    if (!o || o.isDetached || o.state !== ARM_STATES.HOLDING_CATCH) return null;
    const idx = this.arms.indexOf(o);
    const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
    const big = held.filter((h) => h.sizeMeter > V.NEIGHBOUR_CATCH_MAX_SIZE_M + 1e-9);
    if (!big.length || big.some((h) => h.sizeMeter > V.NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M + 1e-9)) return null;
    const hp = this._holdPoseCached(o, idx, 0);
    if (!hp) return null;
    // a lift pose must also be `rest`-clear of the wings (not monotone in the pose); a pending profile = today's walk (the carry is refused meanwhile)
    const wp = armProfile(o);
    const deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / DEG2RAD), V.NEIGHBOUR_CATCH_HIGH_POSE_DEG), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
      (d) => heldCargoPlumeConflictAt(this, idx, d * DEG2RAD) || (wp.state === 2 && !profileClearAt(wp, 'rest', d)));
    return deg === null ? null : deg * DEG2RAD;
  }

  /**
   * Every neighbour of `arm` whose catch blocks her carry only because she stands below `NEIGHBOUR_CATCH_HIGH_POSE_DEG` and that CAN
   * be lifted (`_neighbourLiftRad`): `[{index, rad}]`. Read-only; empty when nothing blocks or nobody can lift.
   * @param {ArmUnit} arm
   * @returns {{index:number, rad:number}[]}
   */
  _liftsFor(arm) {
    const V = Constants.CARRY;
    const out = [];
    for (const o of this.arms) {
      if (!o || o === arm || o.isDetached || typeof o.getAimAlpha !== 'function') continue;
      const high = radToDeg(o.getAimAlpha()) >= V.NEIGHBOUR_CATCH_HIGH_POSE_DEG - V.NEIGHBOUR_TOL_DEG - 1e-6;
      if (high) continue;
      const rad = this._neighbourLiftRad(o);
      if (rad !== null) out.push({ index: o.index, rad });
    }
    return out;
  }

  /**
   * The carry's start path (C key, mission scheduler, trip) was refused only by a neighbour's big catch and `carryCheck` named who can lift
   * (`r.lift`): command the lifts and remember `arm` is waiting (`_carryWaitLift`; `_tickLifts` polls `carryCheck`, starts the carry the
   * moment it passes and puts the neighbours back at the end). The one writer: `carryCheck` / `carryConditions` stay read-only (the UI polls them).
   * @param {ArmUnit} arm the daughter who wants to carry
   * @param {{lift:{index:number, rad:number}[]}} r the refusal
   * @param {object} opts the `carryCheck` options she will be asked with
   */
  _commandLifts(arm, r, opts) {
    for (const l of r.lift || []) {
      const o = this.arms[l.index];
      if (!o || o.state !== ARM_STATES.HOLDING_CATCH || o._netLift) continue;
      o._netLift = { rad: l.rad };
    }
    this._waitForCarry(arm, opts);
  }

  /**
   * Remember that `arm` wants her carry and waits for something that clears by itself (a neighbour's lift, a mother net's berth).
   * @param {ArmUnit} arm
   * @param {object} opts the `carryCheck` options she will be asked with
   */
  _waitForCarry(arm, opts) {
    if (!arm._carryWaitLift) arm._carryWaitLift = { opts: { ...opts }, ageS: 0, pollS: 0, last: null };
  }

  /**
   * The plain clause that follows "Daughter N keeps her catch:" when a waiting hand-off is given up.
   * @param {{reason?:string}|null} r the last refusal she was given (null: none)
   * @returns {string|null} null: say nothing ('no-catch', 'gave-up')
   */
  _handoffGiveUpClause(r) {
    switch (r && r.reason) {
      case 'fit': return 'it is too big for a radiator tip';
      case 'gate': return 'she cannot carry it to a furnace without touching the ship';
      case 'fuel': return 'she has too little fuel';
      case 'neighbour-catch': return "a neighbour's catch is in her way";
      case 'neighbour-strut': return "a neighbour's strut is out of place";
      case 'tip-busy': return "the radiator's furnace is still busy";
      case 'net-inbound': return 'a net is coming in';
      case 'leash-busy': return 'the radiators are busy';
      case 'radiators-moving': return 'the radiators are not settled';
      case 'radiators-angle': return 'the radiators stand where the nose hand-off was not tried';
      case 'swing-back': return 'her catch is too big to hand over with the radiators as they are';
      case 'nose-reach': return 'it is not a size the nose hand-off was measured for';
      case 'nose-busy': return 'the nose is busy';
      case 'nose-leash': return 'the leash cannot reach it from the nose';
      case 'nose-gas': return 'there is too little steering gas to swing it to a radiator';
      case 'no-tip': case 'layout': return 'this ship cannot move catches to a radiator';
      case 'no-catch': case 'gave-up': return null;     // she is empty / her own last carry failed: there is no catch to "keep", nothing to say
      default: return 'the hand-off cannot start';
    }
  }

  /**
   * Per frame: a daughter waiting for her neighbours' lift (or a net's berth) asks `carryCheck` again and starts her carry when it passes;
   * a wait that cannot end by itself or has lasted over `LIFT_WAIT_MAX_S` is dropped, with one Comms line that says why (none when she
   * went on her own way). The wait's clock stands still while a mother net is coming home (a reel lasts 10-35 s). A carry the C key
   * started (`opts.restart`) that the net stopped in its prep restarts after the berth. Lifted neighbours stay up while any daughter
   * waits or carries, then go back (a queued "." press now applies).
   * @param {number} dt
   */
  _tickLifts(dt) {
    let wanting = false;
    let any = false;
    const inbound = _inboundMotherNetRadiusM(this) !== null;
    for (const a of this.arms) {
      if (!a) continue;
      if (a._netLift) any = true;
      const rs = a._carryRestart;
      if (rs) {
        any = true;
        if (a._carry) {
          if (inbound) rs.sawNet = true;
        } else {
          a._carryRestart = null;
          const end = a._lastCarryEnd;
          if (rs.sawNet && end && end.why === 'conditions' && !a.isDetached) this._waitForCarry(a, rs.opts);
        }
      }
      const w = a._carryWaitLift;
      if (w) {
        any = true;
        if (!inbound) w.ageS += dt;
        w.pollS += dt;
        let drop = false;
        let why = null;                                          // a line is said only when she is NOT on her own way
        if (a.isDetached || a._carry || (a.state !== ARM_STATES.HOLDING_CATCH && a.state !== ARM_STATES.DOCKED)) drop = true;
        else if (w.ageS > LIFT_WAIT_MAX_S) { drop = true; why = this._handoffGiveUpClause(w.last); }
        if (!drop && w.pollS >= LIFT_POLL_S) {
          w.pollS = 0;
          const r = this.carryCheck(a, w.opts);
          if (r.ok) {
            drop = true;
            const q = this.requestCarry(a, w.opts);
            if (!q.ok) why = this._handoffGiveUpClause(q);
          }
          else {
            w.last = r;
            if (r.reason === 'neighbour-catch' && r.lift) this._commandLifts(a, r, w.opts);
            else if (!(r.retry && !r.giveUp)) { drop = true; why = this._handoffGiveUpClause(r); }
          }
        }
        if (drop) {
          a._carryWaitLift = null;
          if (why) eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${a.index + 1} keeps her catch: ${why}.`, priority: 'info' });
        } else wanting = true;
      }
      if (a._carry) wanting = true;
    }
    if (!any || wanting) return;
    for (const o of this.arms) {
      if (!o || !o._netLift) continue;
      o._netLift = null;
      _applyQueuedPress(this, o);
    }
  }

  /**
   * Start a carry for `arm` if `carryCheck` allows it. A start the daughter itself refuses (no tip record) is a give-up.
   * @param {ArmUnit} arm
   * @param {{mission?:boolean}} [opts]
   * @returns {{ok:boolean, reason:string, text:string, retry:boolean, giveUp:boolean}} the check's answer (ok: she is in CARRY_PREP)
   */
  requestCarry(arm, opts = {}) {
    const c = this.carryCheck(arm, opts);
    if (!c.ok) return c;
    if (!arm.beginCarry(c.plan)) {
      arm._carryGaveUp = true;
      arm._carryGaveUpWhy = 'refused';
      return { ok: false, reason: 'refused', text: '', retry: false, giveUp: true };
    }
    arm._carryGaveUpWhy = null;                  // a carry began: any later give-up (ArmUnit marks them) is its own, not the scheduler's
    // the player's C-key carry (`opts.restart`) that a mother net stops in its prep is restarted by `_tickLifts` after the berth
    if (opts.restart === true) arm._carryRestart = { opts: { ...opts }, sawNet: false };
    return c;
  }

  /**
   * One look of a carry scheduler: start the first daughter that can carry (first free tip first, ties by daughter index).
   * A refusal that cannot clear by waiting marks her (`_carryGaveUp`: the scheduler stops asking); the ones worth a line say it once
   * per `said` key. The trip calls it on its own cadence while it burns. (Outside a trip nothing calls it: hold-catch, owner
   * 2026-10-22 — a daughter keeps her catch; "Press C" -> `moveCatchToRadiator` starts one.)
   * @param {{mission?:boolean, motherNetOnly?:boolean, say?:function(string):void, said?:object}} [o]
   * @returns {ArmUnit|null} the daughter that started
   */
  scheduleCarry({ mission = false, motherNetOnly = false, say = null, said = null } = {}) {
    const tc = this.playerSatellite && this.playerSatellite.tipCargo;
    const tipTaken = (a) => (tc && typeof tc.debrisAt === 'function' && tc.debrisAt(a.index) ? 1 : 0);
    const arms = this.arms.filter((a) => a && !a.isDetached);
    arms.sort((a, b) => tipTaken(a) - tipTaken(b) || a.index - b.index);
    for (const arm of arms) {
      const r = this.carryCheck(arm, { mission, motherNetOnly });
      if (r.ok) {
        if (this.requestCarry(arm, { mission, motherNetOnly }).ok) return arm;
        continue;
      }
      if (r.giveUp) { arm._carryGaveUp = true; arm._carryGaveUpWhy = r.reason; }   // (why, so the unflown hand-over can tell a real-time mark from a physical one)
      // a neighbour's big catch is the only thing in the way and she can be lifted: lift her (the carry starts by itself)
      if (r.reason === 'neighbour-catch' && r.lift) { this._commandLifts(arm, r, { mission, motherNetOnly }); continue; }
      // a neighbour's catch that can never leave is said too, once, or the catch just stays on her rack in silence
      const sayIt = say && r.text && (r.reason === 'fit' || r.reason === 'gate' || r.reason === 'fuel' || r.reason === 'swing-back'
        || r.reason === 'nose-reach' || r.reason === 'nose-leash' || r.reason === 'nose-gas' || r.reason === 'radiators-angle'
        || (r.reason === 'neighbour-catch' && !r.retry));
      if (sayIt) {
        const key = r.sayKey || `${arm.index}|${r.reason}`;
        if (said && !said[key]) { said[key] = true; say(r.text); }
      }
    }
    return null;
  }

  /**
   * Hand ONE rack catch to a radiator tip WITHOUT flying it (owner 2026-10-24, "Show one, finish rest"; DECISIONS §33 row 17). The trip
   * shows one pass and delivers every other catch this way: the same checks as the flown carry (`carryCheck`) minus every refusal days
   * of time would clear, then the same end state (`ArmUnit.stowUnflown` -> `_stowOnTip`) and her fuel billed as a flown carry bills it.
   *
   * Reasons from `carryCheck(arm, {ignoreRealTime: true})`, one row each:
   *   state            not at her dock (out, or in a carry)                    -> STAYS
   *   gave-up          a carry of hers failed in flight                        -> STAYS (a mark left for 'nose-leash' alone does not count)
   *   no-catch         nothing on her rack                                     -> STAYS
   *   no-tip/layout    no tip store / not the certified dock ring              -> STAYS
   *   fit              the catch is too big for any tip                        -> STAYS
   *   gate             no gate row and not a nose candidate                    -> STAYS
   *   nose-reach       in no certified nose size                               -> STAYS
   *   fuel             her tank is under the hand-off's cost                   -> STAYS while it is under; docked, she swaps in indium
   *                    from the mother's store (`ArmUnit._updateIndiumSwap`), so only an empty store keeps it for good
   *   nose-gas         the mother's steering gas cannot pay the swing          -> STAYS (a yes/no gate; nothing is billed)
   *   radiators-angle  they settle outside the certified window                -> STAYS (radiators are never moved for a carry:
   *                    DECISIONS line 37, §38 row 4)
   *   swing-back       the swing back needs the other radiator range           -> STAYS (same reason)
   *   neighbour-catch  a neighbour's catch can never leave (no lift)           -> STAYS; with a lift -> GOES
   *   carry-busy, leash-busy, mission-*  another carry, the leash or a petal   -> GOES (real time)
   *   nose-busy        the nose holds another catch                            -> GOES (no nose is used)
   *   nose-leash       the leash cannot reach it from the nose                 -> GOES (no leash is used)
   *   radiators-moving judged where they settle (`_flowerSettleDeg`)           -> inside the window GOES, outside = radiators-angle
   *   net-inbound, neighbour-strut, strut-range                                -> GOES (clear by waiting)
   *   tip-busy         her own tip (radial) / every tip (nose route) is full   -> WAITS (this call's own check: delivered once a melt frees one)
   * The target tip: radial = her own tip (`arm.index`) as a flown carry; nose route = `pickTip()`. Never a full or reserved tip.
   * Each physical refusal worth a line is said once per `said` key (the trip's, shared with `scheduleCarry`).
   * @param {{say?:function(string):void, said?:object}} [o]
   * @returns {{arm:ArmUnit, tipIndex:number, nose:boolean}|null} the delivery made (one per call), or null
   */
  deliverUnflown({ say = null, said = null } = {}) {
    const ps = this.playerSatellite;
    const tc = ps && ps.tipCargo;
    if (!tc) return null;
    const tipTaken = (a) => (typeof tc.debrisAt === 'function' && tc.debrisAt(a.index) ? 1 : 0);
    const arms = this.arms.filter((a) => a && !a.isDetached);
    arms.sort((a, b) => tipTaken(a) - tipTaken(b) || a.index - b.index);
    for (const arm of arms) {
      const r = this.carryCheck(arm, { ignoreRealTime: true });
      if (!r.ok) {
        const sayIt = say && r.text && (r.reason === 'fit' || r.reason === 'gate' || r.reason === 'fuel' || r.reason === 'swing-back'
          || r.reason === 'nose-reach' || r.reason === 'nose-gas' || r.reason === 'radiators-angle'
          || (r.reason === 'neighbour-catch' && !r.retry));
        if (sayIt) {
          const key = r.sayKey || `${arm.index}|${r.reason}`;
          if (said && !said[key]) { said[key] = true; say(r.text); }
        }
        continue;
      }
      const plan = r.plan;
      const nose = plan.kind === 'nose';
      const tip = nose ? tc.pickTip() : plan.tipIndex;
      if (tip == null || tc.debrisAt(tip) || (typeof tc.isReserved === 'function' && tc.isReserved(tip))) continue;   // every tip busy: waits for a melt
      const pct = nose ? arm.noseFuelPct() : (typeof arm.carryFuelPct === 'function' ? arm.carryFuelPct() : 0);
      if (!(arm.fuel >= pct)) continue;
      if (!arm.stowUnflown(plan.delivered, tip)) continue;
      arm.fuel -= pct;                                                                 // her thrusters would start and stop her: billed as a flown carry bills it
      return { arm, tipIndex: tip, nose };
    }
    return null;
  }

  /** The trip has started its one shown pass: no daughter waits any more for a neighbour's lift or a net's berth to start a carry. */
  cancelCarryWaits() {
    for (const a of this.arms) if (a && a._carryWaitLift) a._carryWaitLift = null;
  }

  /**
   * The trip phase the mission tick (_tickMissionCarry) stands aside for: 'wait' (the trip waits for the daughters: no new carry), 'burn'
   * (the trip's own scheduler) or null (a mission). Set by TransferTrip.
   * @param {string|null} phase
   */
  setTripPhase(phase) {
    this._tripPhase = phase || null;
    // the lines already said (a hand-off refusal, "too big for a tip") start over after a trip
    if (!this._tripPhase) { this._missionCarryAgeS = 0; this._missionTipsTaken = null; this._missionCarrySaid = Object.create(null); this._allFullSaid = false; }
  }

  /**
   * Outside a trip a daughter KEEPS the catch she made (owner 2026-10-22: "daughters that catch debris should hold it"; transfer to a
   * radiator is an option when all are full, not automatic). The scheduler (every `MISSION_CHECK_S`) asks only for a catch the MOTHER's
   * net put on a rack because no tip was free (`_rackFromMotherNet`, set where CaptureNet's cargo flight lands; owner "Keep: radiator
   * right away"). The rest is bookkeeping (a give-up clears when she leaves the dock or any tip frees) and the one line telling the
   * player the choice is his (`_sayAllFull`, once). The mother's OWN nose catches go to a free tip via CaptureNet._tryLeash ->
   * LeashDriver; on a trip `TransferTrip._tickCarry` owns the hand-offs (`_tripPhase` set).
   */
  _tickMissionCarry(dt) {
    if (this._tripPhase || !(dt > 0)) return;
    const V = Constants.CARRY;
    this._missionCarryAgeS = (this._missionCarryAgeS || 0) + dt;
    if (this._missionCarryAgeS < (V.MISSION_CHECK_S ?? 1)) return;
    this._missionCarryAgeS = 0;
    const said = this._missionCarrySaid || (this._missionCarrySaid = Object.create(null));
    const tc = this.playerSatellite && this.playerSatellite.tipCargo;
    // something changed that could let a refused carry through: a tip freed, or the daughter went out and came back
    let taken = 0;
    for (let i = 0; i < 4; i++) if (tc && typeof tc.debrisAt === 'function' && tc.debrisAt(i)) taken |= (1 << i);
    const freed = this._missionTipsTaken != null && (this._missionTipsTaken & ~taken) !== 0;
    this._missionTipsTaken = taken;
    for (const a of this.arms) {
      if (!a) continue;
      const home = a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.HOLDING_CATCH;
      if (freed || !home) {
        if (a._carryGaveUp) a._carryGaveUp = false;
        for (const k of Object.keys(said)) if (k.startsWith(`${a.index}|`) && !k.includes('|swing-back|')) delete said[k];
      }
    }
    // a catch the mother's net racked goes to a free radiator tip by itself (a daughter's own never does)
    if (this.arms.some((a) => a && !a._carryGaveUp && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h && h._rackFromMotherNet)
        && (a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.HOLDING_CATCH))) {
      this.scheduleCarry({
        mission: true, motherNetOnly: true, said,
        say: (text) => eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' }),
      });
    }
    this._sayAllFull();
  }

  /**
   * All full -> ONE line, and "Press C" only when C can work. Outlook per daughter via `carryCheck` (mission): 'now' = would start now,
   * 'later' = waiting can help, 'never' = cannot go (too big for a tip, no gate row, no fuel). Said once per time they become full;
   * "Press C" is said once more if the first line had to leave it out and a hand-off then becomes possible. Re-armed when one is not full.
   */
  _sayAllFull() {
    if (!this.allDaughtersFull()) { this._allFullSaid = false; return; }
    let now = 0, later = 0;
    for (const a of this.arms) {
      if (!a || a.isDetached || a.state === ARM_STATES.EXPENDED) continue;
      const o = this._handoffOutlook(a);
      if (o === 'now') now++; else if (o === 'later') later++;
    }
    const key = now ? 'press' : (later ? 'full' : 'never');
    if (this._allFullSaid && !(key === 'press' && this._allFullSaid !== 'press')) return;
    this._allFullSaid = key;
    const text = key === 'press' ? 'All daughters are holding catches. Press C to move one to a radiator.'
      : key === 'full' ? 'All daughters are holding catches.'
      : 'All daughters are holding catches, and none of them can go to a radiator.';
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' });
  }

  /**
   * Can this daughter's catch go to a radiator tip - now, later, or never? Read-only (`carryCheck`, a mission carry).
   * 'gave-up' counts as 'later': "Press C" clears it and asks again.
   * @param {ArmUnit} arm
   * @returns {'now'|'later'|'never'}
   */
  _handoffOutlook(arm) {
    const r = this.carryCheck(arm, { mission: true });
    if (r.ok) return 'now';
    return (r.retry || r.reason === 'gave-up' || r.reason === 'radiators-angle') ? 'later' : 'never';
  }

  /** A "." line held back for the double-press window is said once the window has passed with no second press. @private */
  _tickStrutPressNote(dt) {
    const p = this._pendingStrutNote;
    if (!p || !(dt > 0)) return;
    p.leftS -= dt;
    if (p.leftS > 0) return;
    this._pendingStrutNote = null;
    eventBus.emit(Events.COMMS_MESSAGE, { source: 'SPACECRAFT', channel: 'CMD', text: p.text, priority: 'info' });
  }

  // hold-clear (owner 2026-10-23): a held catch never touches a radiator wing

  /**
   * Per frame: start a wing profile (HoldWingClear) for every racked catch of a daughter parked HOLDING_CATCH whose attitude is frozen
   * (`_qLocalHer`) and that has none valid for where it sits (arm, cell, attitude, size, radiator kit), and spend
   * `HOLD_CLEAR.UNITS_PER_FRAME` work points on the queue, oldest first: a fixed count, never a clock. With nothing queued the radiator
   * kit is built ahead (half a frame's points) so the first stow finds it ready. Also ends `_netBlock` for a daughter who no longer
   * holds a catch at home.
   * @param {number} dt
   */
  _tickWingClear(dt) {
    const ps = this.playerSatellite;
    const HC = Constants.HOLD_CLEAR;
    if (HC.ENABLED === false || !ps || !Array.isArray(ps._flowerGroups) || ps._flowerGroups.length === 0 || typeof ps._writeFlowerPose !== 'function') return;
    if (!this._wingQueue) this._wingQueue = [];
    const q = this._wingQueue;
    const kit = kitFor(ps);
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm) continue;
      if (!_holdsCatchAtHome(arm)) { if (arm._netBlock) arm._netBlock = false; continue; }
      for (const h of arm.heldCatches) {
        if (!h || !h.mass || !h._qLocalHer || !h._rackLocalM) continue;
        if (!profileValid(this, i, h) && startProfile(this, i, h) && !q.includes(h)) q.push(h);
      }
    }
    let pts = HC.UNITS_PER_FRAME;
    if (q.length === 0) {
      if (kit && !kit.ready) kitStep(kit, pts / 2);
      return;
    }
    while (pts > 0 && q.length) {
      const h = q[0];
      const w = h._wingClear;
      const arm = w ? this.arms[w.arm] : null;
      if (!w || w.done || !arm || !Array.isArray(arm.heldCatches) || !arm.heldCatches.includes(h)) { q.shift(); continue; }
      pts = stepProfile(this, h, pts);
      if (h._wingClear && h._wingClear.done) q.shift(); else break;
    }
  }

  /**
   * Finish this daughter's pending wing profiles NOW, spending at most `PENDING_FORCE_POINTS` work points (about 50 ms) on ALL of them:
   * the mother-net press asks, so it can decide on a finished profile. The cap is on the work actually done, not on an estimate (which
   * ran 3-6x low); what is not finished stays pending and the press says she is still stowing. @returns {boolean} true when none is pending
   */
  _forceWingProfiles(arm) {
    let pts = Constants.HOLD_CLEAR.PENDING_FORCE_POINTS;
    let left = false;
    for (const h of arm.heldCatches || []) {
      if (!h || !h._wingClear || h._wingClear.done) continue;
      if (pts > 0) pts = stepProfile(this, h, pts);
      if (!h._wingClear.done) left = true;
    }
    if (this._wingQueue) this._wingQueue = this._wingQueue.filter((h) => h._wingClear && !h._wingClear.done);
    return !left;
  }

  /**
   * Would a mother net for `target` be held back by a holder (owner 2026-10-23, "Net refuses, says why")? The index of the first daughter
   * HOLDING_CATCH whose catch fouls the net's berth corridor (radius `target.sizeMeter / 2 + BERTH_CLEARANCE_M`) at her live strut angle
   * and for whom some grid pose clears the net but none is wing-clear (`_duckPlan` kind 2); -1 when none or the target has no size. A
   * pending wing profile is finished now if the work left is small, else `_netBlockKind` = 'pending'; otherwise 'wing'; no pose clears
   * at all (`_duckPlan` `foul`) = 'corridor'. Pure read apart from finishing a profile and `_netBlockKind`.
   * @param {{sizeMeter?:number}} target
   * @returns {number}
   */
  motherNetHolderBlock(target) {
    this._netBlockKind = null;
    const sizeM = target && target.sizeMeter;
    if (!(sizeM > 0)) return -1;
    const radiusM = sizeM / 2 + (Constants.CAPTURE_NET.BERTH_CLEARANCE_M ?? 1.0);
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!_holdsCatchAtHome(arm)) continue;
      let plan = _duckPlan(this, i, radiusM);
      if (plan.kind === 4) {
        if (!this._forceWingProfiles(arm)) { this._netBlockKind = 'pending'; return i; }
        plan = _duckPlan(this, i, radiusM);
      }
      if (plan.kind === 2) { this._netBlockKind = 'wing'; return i; }
      if (plan.foul) { this._netBlockKind = 'corridor'; return i; }          // no pose clears the net, her catch stays in its way
    }
    return -1;
  }

  /**
   * The plain line for a refused mother-net press naming daughter `index` (from `motherNetHolderBlock`) and, for a wing refusal, the
   * `_netBlock` mark that lets C move her catch (the C clause is said only when `canMoveCatchToRadiator` passes).
   * @param {number} index @returns {string}
   */
  motherNetBlockLine(index) {
    const arm = this.arms[index];
    const n = index + 1;
    if (this._netBlockKind === 'pending') return `Daughter ${n} is still stowing her catch; try again in a moment.`;
    if (arm) arm._netBlock = true;
    const c = arm && this.canMoveCatchToRadiator(index) ? ' C moves it to a radiator.' : '';
    if (this._netBlockKind === 'corridor') return `Mother net held: Daughter ${n}'s catch is too big to get out of its way at any angle she can lower it to. K lets her catch go.${c}`;
    return `Mother net held: Daughter ${n}'s catch can't get out of its way without touching a radiator. K lets her catch go.${c}`;
  }

  clearNetBlocks() {
    for (const a of this.arms) if (a) a._netBlock = false;
    this._netBlockKind = null;
  }

  /**
   * True when every daughter that can still fly (not detached, not expended) is aboard holding a catch, and at least one is. A daughter
   * on a carry is not "holding".
   * @returns {boolean}
   */
  allDaughtersFull() {
    let n = 0;
    for (const a of this.arms) {
      if (!a || a.isDetached || a.state === ARM_STATES.EXPENDED) continue;
      const holds = a.state === ARM_STATES.HOLDING_CATCH && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h);
      if (!holds) return false;
      n++;
    }
    return n > 0;
  }

  /**
   * The checks `moveCatchToRadiator` makes BEFORE it asks `carryCheck` (not on the trip, no hand-off running, somebody holds a catch, no
   * daughter free), with no comms line and no state change; one copy, so `canMoveCatchToRadiator` and the C key cannot disagree.
   * @returns {{ok:true, holders:ArmUnit[]}|{ok:false, text:string}} `text` is the line C says for that refusal
   */
  _radiatorMoveGate() {
    const S = ARM_STATES;
    if (this._tripPhase) {
      return { ok: false, text: 'The daughters hand their catches to the radiators by themselves on the trip.' };
    }
    const arms = (this.arms || []).filter((a) => a && !a.isDetached && a.state !== S.EXPENDED);
    const holders = arms.filter((a) => a.state === S.HOLDING_CATCH && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h));
    if (this.isCarrying()) return { ok: false, text: 'A hand-off is already running.' };
    if (holders.length === 0) return { ok: false, text: 'No daughter is holding a catch.' };
    const free = arms.find((a) => !holders.includes(a));
    if (free) {
      // owner 2026-10-23: a holder the mother net refused for (`_netBlock`) or whose catch cannot be held clear of the radiators
      // (`wingBlocked` hold pose) may go to a radiator tip even while another daughter is empty: only those holders are returned
      const stuck = holders.filter((a) => a._netBlock === true || this._holdWingBlocked(a));
      if (stuck.length > 0) return { ok: true, holders: stuck };
      const away = free.state !== S.DOCKED && free.state !== S.RELOADING;
      return { ok: false, text: `Daughter ${free.index + 1} is ${away ? 'out' : 'free'}; catches stay with the daughters until all are full.` };
    }
    return { ok: true, holders };
  }

  /** Is this holder's hold pose `wingBlocked` (no pose up to 100° keeps her catch off the radiators)? @private */
  _holdWingBlocked(arm) {
    const hp = arm && Array.isArray(arm.heldCatches) ? this._holdPoseCached(arm, this.arms.indexOf(arm), 0) : null;
    return !!hp && hp.wingBlocked === true;
  }

  /**
   * Would `moveCatchToRadiator(index)` start THIS daughter's hand-off right now (owner 2026-10-22: TO RADIATOR button on a DAUGHTERS
   * row)? Read-only (`carryCheck` writes only a short-lived hold-pose memo). True only when she is a holder, every daughter that can
   * still fly holds a catch, no trip / hand-off is running, and a mission `carryCheck` passes for her; an earlier give-up
   * (`_carryGaveUp`) is ignored, as C clears it. Not covered: her own `beginCarry` can still refuse after a passing check (no tip
   * record, no petal hold); that marks her gave-up silently.
   * @param {number} index the daughter's index
   * @returns {boolean}
   */
  canMoveCatchToRadiator(index) {
    if (!Number.isInteger(index) || index < 0) return false;
    const gate = this._radiatorMoveGate();
    if (!gate.ok) return false;
    const arm = gate.holders.find((a) => a.index === index);
    if (!arm) return false;
    const r = this.carryCheck(arm, { mission: true, ignoreGaveUp: true });
    return r.ok === true || (r.reason === 'neighbour-catch' && !!r.lift);
  }

  /**
   * "Press C" (owner 2026-10-22): the player's choice to move ONE daughter's catch to a radiator tip, only when every daughter is full.
   * Starts one hand-off through the same `carryCheck` / `requestCarry` / `beginCarry` path the trip uses (a mission carry). The selected
   * daughter if she holds a catch, else the first holding one that can go (lowest number first; if none can, the first one's reason is
   * the line). Never on a trip, while a hand-off runs, or while a daughter is free. Every outcome that moves nothing says why, in one line.
   * @param {number} [selectedIndex] the selected daughter's index (-1 / undefined: none)
   * @returns {{ok:boolean, text:string, arm?:object}}
   */
  moveCatchToRadiator(selectedIndex) {
    const finish = (r) => {
      if (r.text) eventBus.emit(Events.COMMS_MESSAGE, { text: r.text, priority: 'info' });
      return r;
    };
    const gate = this._radiatorMoveGate();
    if (!gate.ok) return finish({ ok: false, text: gate.text });
    const holders = gate.holders;
    const sel = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? holders.find((a) => a.index === selectedIndex) : null;
    const order = sel ? [sel] : holders.slice().sort((a, b) => a.index - b.index);
    // nobody selected: the line names the first daughter whose hand-off can still happen (waiting helps), not a catch that never fits
    let first = null;
    let netWait = null;
    for (const arm of order) {
      arm._carryGaveUp = false;                              // he asked: a give-up from an earlier try does not count
      const r = this.carryCheck(arm, { mission: true });
      if (r.ok) {
        const started = this.requestCarry(arm, { mission: true, restart: true });
        if (started.ok) {
          if (started.plan && started.plan.kind === 'nose') {
            return finish({ ok: true, arm, nose: true, text: `Daughter ${arm.index + 1} takes her catch to the nose; the leash then moves it to a radiator.` });
          }
          const tip = (arm._carry && Number.isInteger(arm._carry.tipIndex)) ? arm._carry.tipIndex : arm.index;
          return finish({ ok: true, arm, text: `Daughter ${arm.index + 1} takes her catch to radiator ${tip + 1}.` });
        }
        if (!first || !first.r.retry) first = { arm, r: started };
        continue;
      }
      // only a neighbour's big catch is in the way and she can rise out of it: she does, and this daughter's hand-off follows
      if (r.reason === 'neighbour-catch' && r.lift) {
        this._commandLifts(arm, r, { mission: true, restart: true });
        const who = r.lift[0].index + 1;
        return finish({ ok: true, arm, lifting: true, text: `Daughter ${who} raises her catch to make room; Daughter ${arm.index + 1}'s hand-off follows.` });
      }
      if (r.reason === 'net-inbound') { if (!netWait) netWait = arm; continue; }
      if (!first || (!first.r.retry && r.retry)) first = { arm, r };
    }
    // nobody could start, and a net coming home is what holds one back: she asked, so her hand-off follows the berth
    if (netWait) {
      this._waitForCarry(netWait, { mission: true, restart: true });
      return finish({ ok: true, arm: netWait, waiting: true, text: `A net is coming in. Daughter ${netWait.index + 1}'s hand-off follows the berth.` });
    }
    return finish({ ok: false, text: this._carryRefusalText(first.arm, first.r) });
  }

  _carryRefusalText(arm, r) {
    if (r && r.reason === 'fit') return `Daughter ${arm.index + 1}'s catch is too big for a radiator tip; she keeps it.`;
    if (r && r.text) return r.text;
    const n = arm.index + 1;
    switch (r && r.reason) {
      case 'carry-busy': return 'A hand-off is already running.';
      case 'net-inbound': return `A net is coming in. Daughter ${n} waits.`;
      case 'mission-turning': return `The ship is turning or holding a heading, so Daughter ${n} waits. Try again when it stops.`;
      case 'mission-daughter': return `A daughter is leaving the ship, so Daughter ${n} waits.`;
      case 'mission-radiators': return `The radiators are busy, so Daughter ${n} waits. Try again in a moment.`;
      case 'mission-world': return 'Time is held.';
      case 'mission-busy': return `One catch is already on its leash, so Daughter ${n} waits.`;
      case 'strut-range': return `Daughter ${n}'s strut is still moving. Try again in a moment.`;
      case 'no-tip': case 'layout': return 'This ship cannot move catches to a radiator.';
      default: return `Daughter ${n} cannot move her catch right now.`;
    }
  }

  resetCarryGiveUps() {
    for (const a of this.arms) if (a) a._carryGaveUp = false;
  }

  /** Stop every carry now (game over, reset, load, the trip's hard cap). @returns {number} how many were running */
  abortAllCarries(why = 'abort') {
    let n = 0;
    for (const a of this.arms) if (a && a.isCarrying && a.abortCarry(why)) n++;
    return n;
  }

  /**
   * Can any rack catch still be carried - now, or once her tip frees / the hand-off ends / the bag in the way melts? The trip's end rule
   * waits for it. A catch that never carries (too big for a tip, a row the gate does not allow, no fuel: fuel does not come back on the
   * trip) does not count.
   * @returns {boolean}
   */
  rackCanCarry() {
    for (const a of this.arms) {
      if (!a || a.isDetached || !Array.isArray(a.heldCatches) || a.heldCatches.length === 0) continue;
      const r = this.carryCheck(a);
      if (r.ok || r.retry) return true;
    }
    return false;
  }

  /**
   * Per frame: a daughter in CARRY_PREP whose strut has no slewer (a headless rig) is slewed here; in the game
   * `PlayerSatellite._updateStruts` slews to `_strutTargetAlpha`.
   */
  _updateCarry(dt) {
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    if (!headless) return;
    for (const a of this.arms) {
      if (!a || !a._carry || a.state !== ARM_STATES.CARRY_PREP || typeof a.setAimAlpha !== 'function') continue;
      const t = a._carry.strutRad;
      a.setAimAlpha(t, dt);
      if (Math.abs(a.getAimAlpha() - t) < 0.01) a._strutTargetAlpha = undefined;
    }
  }

  // reel-home: the strut follows a daughter on the reels, the mother turns to meet her line

  /**
   * For every daughter on the reels (her net winding the catch in, or on the strut line):
   *  - the strut's target angle follows her (swing-plane angle nearest the direction hinge -> her, clamped to
   *    REEL_HOME.STRUT_MIN_DEG..STRUT_MAX_DEG, at the existing slew rate); the strut is `_aimReserved` so StrutAuto leaves it alone;
   *  - the mother turns to bring her into the strut's swing plane when she is off it by more than PLANE_TOL_DEG and nothing limits the
   *    mother (`_motherTurnBlock(arm)`). One daughter owns the turn at a time, first come.
   */
  _updateReelHome(dt, parentPos, parentQuat) {
    const on = Constants.isFeatureEnabled('REEL_HOME');
    const RH = Constants.REEL_HOME || {};
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const homers = [];
    for (const arm of this.arms) {
      if (!arm) continue;
      const home = on && arm.isReelingHome === true && !arm.isDetached;
      if (!home) {
        arm._rhSeq = 0;
        arm._rhMotherWorking = false;
        arm._rhGapFn = null;
        arm._rhHold = null;
        arm._rhFloorRefused = false;
        arm._rhFloorSpent = false;
        continue;
      }
      if (!arm._rhSeq) arm._rhSeq = ++this._rhSeq;
      homers.push(arm);
      if (Number.isFinite(arm._rhBestAlpha)) {
        const a = clamp(arm._rhBestAlpha, (RH.STRUT_MIN_DEG ?? 34) * DEG2RAD, (RH.STRUT_MAX_DEG ?? 180) * DEG2RAD);
        if (!arm._aimReserved) { arm._aimReserved = true; arm._rhReserved = true; }
        arm._strutTargetAlpha = a;
        if (headless && typeof arm.setAimAlpha === 'function') {
          arm.setAimAlpha(a, dt);
          if (Math.abs(arm.getAimAlpha() - a) < 0.01) arm._strutTargetAlpha = undefined;
        }
      }
      if (!arm._rhGapFn) arm._rhGapFn = (pos, pp, pq) => this._rhGapAt(arm, pos, pp, pq);
    }
    this._tickReelHomeTurn(homers, parentQuat, dt);
  }

  /**
   * Who turns the mother, and when. The earliest daughter on the reels owns the turn until she leaves them. The owner asks for a turn when
   * she is off the strut's swing plane by more than PLANE_TOL_DEG, or (once in the plane) below STRUT_MIN_DEG..STRUT_MAX_DEG by more than
   * that; the mother is free (`_motherTurnBlock(owner)`) and the turn is not bigger than TURN_MAX_DEG. One scripted attitude turn per
   * request, at most one per TURN_RETRY_S (a refusal counts). The autopilot engaging ends a running turn. The turn axis has no component
   * along the nose (almost no roll authority): the strut's radial direction for the plane error, the plane's normal t for the range error.
   * owner 2026-10-21 "strange oscillations ... not good": the PLANE turn is closed loop, a tracked turn (`requestAttitudeTurn`
   * `opts.track`): every frame `_rhTrackPlane` reads the angle left from her live place relative to the ship's centre (`planeTurnLeftRad`;
   * the strut hinge hangs ~1 m off the turning axis) and the autopilot's rate law (√(2·α·left), at most the 5°/s peak) brakes to rest on
   * it. Starts beyond PLANE_TOL_DEG, ends inside half of it (hysteresis) or when her lever is gone (more than TURN_MAX_DEG left). A fixed
   * angle overshoots: she reels in during the 8-11 s turn. The range turn is still one fixed profile. `_rhMotherWorking` tells each
   * daughter whether the mother is turning for her.
   */
  _tickReelHomeTurn(homers, parentQuat, dt = 0) {
    const RH = Constants.REEL_HOME || {};
    let owner = null;
    for (const a of homers) if (!owner || a._rhSeq < owner._rhSeq) owner = a;
    this._rhOwner = owner;
    for (const a of homers) {
      a._rhMotherWorking = false;
      if (a._rhTurnWaitS > 0) a._rhTurnWaitS = Math.max(0, a._rhTurnWaitS - dt);
    }
    if (this._rhTurn && this._rhTurn.arm !== owner) this._rhAbortTurn();
    const apNow = this._autopilot;
    // the autopilot engaged: it steers back to its own heading, so the turn is cancelled (`_motherTurnBlock` then keeps new ones away)
    if (this._rhTurn && apNow && apNow.engaged === true) this._rhAbortTurn();
    if (this._rhTurn && apNow && typeof apNow.isTurning === 'function' && !apNow.isTurning()) {
      this._rhEndTurn(apNow);
    }
    if (!owner) return;
    if (this._rhTurn) { owner._rhMotherWorking = true; return; }
    if (owner._rhTurnWaitS > 0) return;
    const v = owner._rhRelShip;
    if (!v) return;
    const az = owner._rhAzRad();
    const tol = (RH.PLANE_TOL_DEG ?? 5) * DEG2RAD;
    // which error: first the one across the strut's swing plane (a turn about its radial direction); once in the plane, the one along it
    // (the strut can only point at [STRUT_MIN, STRUT_MAX]: below the floor the mother turns about the plane's normal)
    let theta;
    let axisL;
    let tracked = false;
    if (Math.abs(owner._rhPlaneErrRad) > tol) {
      // closed loop (see the docblock): the angle left is read from her live place every frame (`_rhTrackPlane`). Without the ship's
      // place (a headless stub) the open-loop angle from the hinge direction stays.
      const live = this._rhPlaneTurnLeft(owner, az);
      if (live !== null) {
        theta = live;
        tracked = true;
      } else {
        const vt = -v.x * Math.sin(az) + v.y * Math.cos(az);
        theta = Math.atan2(vt, -v.z);
        if (theta > Math.PI / 2) theta -= Math.PI; else if (theta <= -Math.PI / 2) theta += Math.PI;
      }
      axisL = _rhAxisR.set(Math.cos(az), Math.sin(az), 0);
    } else {
      theta = _rhFloorTheta(v, az, RH);                                         // turning the ship by +t moves her angle by +t (shared with `reelHoldReason`)
      if (theta === 0) return;
      if (Math.abs(theta) <= tol) return;                                       // a few degrees short: the 2 m check decides
      axisL = _rhAxisR.set(-Math.sin(az), Math.cos(az), 0);
    }
    if (Math.abs(theta) > (RH.TURN_MAX_DEG ?? 60) * DEG2RAD || Math.abs(theta) < 1e-3) return;
    const ap = this._autopilot;
    if (!ap || typeof ap.requestAttitudeTurn !== 'function') return;
    if (this._motherTurnBlock(owner)) return;
    const pq = parentQuat || (this.playerSatellite && this.playerSatellite.quaternion);
    if (!pq) return;
    const axisW = new THREE.Vector3().copy(axisL).applyQuaternion(pq);
    owner._rhTurnTries++;
    owner._rhTurnWaitS = RH.TURN_RETRY_S ?? 1;
    const turn = { arm: owner, tracked };
    const opts = { holdOwner: 'REEL_HOME', holdS: 30, maxWaitS: 60 };   // sloth mode backstop: `_motherTurnBlock` already refuses
    if (tracked) {
      opts.track = () => this._rhTrackPlane(turn, owner, az, tol);
      opts.timeoutS = 60;                                                     // a moving target: the planned-time default is too short
    }
    this._lockExceptArm = owner;
    let p;
    try {
      p = ap.requestAttitudeTurn(axisW, theta, opts);
    } catch (e) {
      p = null;
    } finally {
      this._lockExceptArm = null;
    }
    if (!p || typeof p.then !== 'function') { if (!tracked) owner._rhFloorRefused = true; return; }
    if (typeof p.catch === 'function') p.catch(() => {});                     // a refusal / cancel is read below, not thrown
    const refusal = typeof ap.lastAttitudeTurnRefusal === 'function' ? ap.lastAttitudeTurnRefusal() : null;
    if (refusal) { if (!tracked) owner._rhFloorRefused = true; return; }      // refused at once: nothing moved (no floor turn is possible, so no floor hold)
    if (!tracked) owner._rhFloorRefused = false;
    this._rhTurn = turn;
    owner._rhMotherWorking = true;
  }

  // reel-hold (owner 2026-10-23): a daughter waits 5 m out until the floor turn is done and the radiators are clear

  /**
   * Is a mother FLOOR turn (bringing her angle in the strut's plane up to the 34° floor) running for her, or would one be asked now?
   * True when she is in her strut's plane, short of the floor by more than PLANE_TOL_DEG and no more than TURN_MAX_DEG, her floor request
   * was not refused (`_rhFloorRefused`: steering gas low, roll axis, ...), and her turn is running or the mother is free for her
   * (`_motherTurnBlock(arm)`). The angle is `_rhFloorTheta`, the one `_tickReelHomeTurn` reads. Pure read.
   * @param {ArmUnit} arm
   * @returns {boolean}
   */
  _rhFloorWanted(arm) {
    const RH = Constants.REEL_HOME || {};
    const v = arm._rhRelShip;
    if (!v || arm._rhFloorRefused === true) return false;
    const tol = degToRad(RH.PLANE_TOL_DEG ?? 5);
    if (Math.abs(arm._rhPlaneErrRad) > tol) return false;                       // the plane turn is first (the start-of-reel turn: untouched)
    const theta = _rhFloorTheta(v, arm._rhAzRad(), RH);
    if (theta === 0 || Math.abs(theta) <= tol) return false;                    // inside the range, or a few degrees short (the 2 m check decides)
    if (Math.abs(theta) > degToRad(RH.TURN_MAX_DEG ?? 60)) return false;
    const t = this._rhTurn;
    if (t && t.arm === arm && !t.tracked) return true;
    const ap = this._autopilot;
    if (!ap || typeof ap.requestAttitudeTurn !== 'function') return false;
    if (!(this.playerSatellite && this.playerSatellite.quaternion)) return false;
    return !this._motherTurnBlock(arm);
  }

  /** The wing angle band as radians {lo, hi}, written into a scratch (no allocation). @private */
  _radBand() {
    const R = Constants.REEL_HOLD || {};
    const out = this._radBandScratch || (this._radBandScratch = { lo: 0, hi: 0 });
    out.lo = degToRad(R.BAND_LO_DEG ?? 55);
    out.hi = degToRad(R.BAND_HI_DEG ?? 130);
    return out;
  }

  /**
   * Do the wings stand strictly inside the band now? false with no radiators. The band's edge is outside: wings the drive parked there
   * leave the holders at their hold pose.
   */
  _wingsInBand() {
    const ps = this.playerSatellite;
    const th = ps && ps._flowerThetaRad;
    if (!Number.isFinite(th)) return false;
    const b = this._radBand();
    return th > b.lo + 1e-6 && th < b.hi - 1e-6;
  }

  /**
   * Are the wings moving on a path that touches [BAND_LO, BAND_HI] (a target is set)? Wings that stand still are not "moving": nothing
   * would end such a wait, and docked holders are lifted for them (`_tickRadLifts`). @private
   */
  _wingsMovingInBand() {
    const ps = this.playerSatellite;
    if (!ps) return false;
    const th = ps._flowerThetaRad;
    const tg = ps._flowerTargetTheta;
    if (tg === undefined || !Number.isFinite(th) || !Number.isFinite(tg) || Math.abs(tg - th) < 1e-6) return false;
    const b = this._radBand();
    return Math.max(th, tg) >= b.lo && Math.min(th, tg) <= b.hi;
  }

  _holdsAnyCatch(arm) {
    return !!(arm && ((arm.capturedDebris && arm.capturedDebris.mass)
      || (Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass))));
  }

  /**
   * Why a reeling daughter must wait HOLD_M out from her strut tip, or null. `'floor'`: a mother floor turn is running or askable for her
   * and her angle is short of the 34° floor (`_rhFloorWanted`; ArmUnit ends a hold over FLOOR_CAP_S, `_rhHold.capped`). `'radiators'`:
   * she carries a catch and the wings are moving through the band (`_wingsMovingInBand`). Pure read; ArmUnit reads it every reeling frame.
   * @param {ArmUnit} arm
   * @returns {'floor'|'radiators'|null}
   */
  reelHoldReason(arm) {
    if (!arm || arm.isDetached || arm.state !== ARM_STATES.REELING || arm._rhHome !== true) return null;
    if (!arm._rhFloorSpent && this._rhFloorWanted(arm)) return 'floor';
    if (arm.capturedDebris && this._wingsMovingInBand()) return 'radiators';
    return null;
  }

  /**
   * Does daughter `i`'s catch stand in the berth corridor of radius `radiusM` (anchor in `_duckAnchor`, set by `_duckPlan`)
   * with her strut at `rad`? A test seam: with the real meshes the foul is monotone in the angle (measured: 0 of 2652
   * configs x 8 radii and 0 of 44 scoop balls x 8 radii foul at 34° but not higher), so a test sets the corridor.
   */
  _corridorFoulAt(i, rad, radiusM) {
    return heldCargoFoulsCorridorAt(this, i, rad, _duckAnchor, radiusM);
  }

  /** Would daughter `i`'s catch be in a Hall exhaust with her strut at `rad`? Test seam (a test sets a plume the geometry never makes). */
  _plumeConflictAt(i, rad) {
    return !!heldCargoPlumeConflictAt(this, i, rad);
  }

  /**
   * The lowest strut angle on the hold-pose grid at which a holder's catch stays CLEAR_M off every wing in the band AND out
   * of every Hall exhaust, from max(her hold pose, the measured band-clear angle for her biggest catch) up to
   * HOLD_POSE_MAX_DEG; null = none (the wings must not move: 'never'). Cached like `_holdPoseCached`. Read-only.
   * @returns {{rad:number|null}|null} null when she holds nothing
   */
  _radClearPose(arm, i, dt = 0) {
    const key = _rackKey(arm);
    const c = arm._radClear;
    if (c && c.key === key && c.ageS < 0.5) { c.ageS += dt; return c.pose; }
    const hp = this._holdPoseCached(arm, i, 0);
    let pose = null;
    if (hp) {
      const R = Constants.REEL_HOLD || {};
      const V5 = Constants.OCTOPUS_V5;
      const wp = armProfile(arm);
      let deg;
      if (wp.state === 2) {
        // her catch's own profile replaces the size table: first pose from max(hold pose, LIFT_DEG) that is plume-, `rest`- and
        // `band`-clear (`rest` is not monotone in the pose); none = 'never'
        deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / DEG2RAD), R.LIFT_DEG ?? 69), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
          (d) => this._plumeConflictAt(i, d * DEG2RAD) || !profileClearAt(wp, 'rest', d) || !profileClearAt(wp, 'band', d));
      } else {
        let size = 0;                                                          // no finished profile: the measured size table (fallback only)
        if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) if (h && h.mass) size = Math.max(size, h.sizeMeter || 0);
        const floorDeg = _bandClearDeg(size, R);
        deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / DEG2RAD), floorDeg), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
          (d) => this._plumeConflictAt(i, d * DEG2RAD));                           // the cap (100°) is tried last, whatever the grid
      }
      pose = { rad: deg === null ? null : deg * DEG2RAD };
    }
    arm._radClear = { key, pose, ageS: 0 };
    return pose;
  }

  /**
   * May the radiator wings enter the band now? null: yes. `'wait'`: a daughter's catch is not clear of the wings yet (a
   * holder below her band-clear lift pose, a catch docking, one reeling inside HOLD_M or too fast to be stopped before it:
   * `_rhHold.refused`); one held at HOLD_M, at rest, does not count (she waits for the wings). `'never'`: a holder that can
   * reach no band-clear, plume-clear pose (`_radClearPose`). The first blocker's index is left in `_radBandWho`.
   * Empty daughters never block. Pure read apart from that index and the pose cache.
   * @returns {'wait'|'never'|null}
   */
  radiatorBandBlocked() {
    this._radBandWho = -1;
    const R = Constants.REEL_HOLD || {};
    const holdM = R.HOLD_M ?? 5;
    const tolM = R.STOP_TOL_M ?? 0.25;
    const dead = degToRad(Constants.OCTOPUS_V5.HOLD_POSE_DEADBAND_DEG ?? 1);
    let out = null;
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a || a.isDetached) continue;
      const st = a.state;
      let wait = false;
      if (st === ARM_STATES.REELING) {
        const hs = a._rhHold;
        if (!a.capturedDebris || (hs && hs.on)) continue;
        const dM = typeof a._strutTipDistM === 'function' ? a._strutTipDistM() : null;
        // inside HOLD_M, or on her way in with no hold (refused or capped, whatever the reason): she docks, the wings wait
        wait = (dM !== null && dM < holdM - tolM) || (!!hs && (hs.refused === true || hs.capped === true));
      } else if (st === ARM_STATES.DOCKING || st === ARM_STATES.RELOADING) {
        wait = this._holdsAnyCatch(a);
      } else if (st === ARM_STATES.HOLDING_CATCH) {
        if (!this._holdsAnyCatch(a)) continue;
        // a catch whose wing profile is started but not done is not known to be clear: the radiators wait (a few frames)
        if (armProfile(a).state === 1) { if (out === null) { out = 'wait'; this._radBandWho = i; } continue; }
        const cp = this._radClearPose(a, i, 0);
        if (!cp) continue;
        if (cp.rad === null) { this._radBandWho = i; return 'never'; }
        wait = (typeof a.getAimAlpha === 'function' ? a.getAimAlpha() : cp.rad) < cp.rad - dead;
      }
      if (wait && out === null) { out = 'wait'; this._radBandWho = i; }
    }
    return out;
  }

  /**
   * The plain line for a radiator wait (`kind` 'wait') or a dropped move ('stay'), naming the daughter `radiatorBandBlocked` found first.
   * @returns {string}
   */
  radiatorBandSays(kind) {
    const n = this._radBandWho >= 0 ? this._radBandWho + 1 : 0;
    const who = n > 0 ? `Daughter ${n}` : 'A daughter';
    return kind === 'stay' ? `Radiators stay: ${who}'s catch is in their way.` : `Radiators wait while ${who} lifts her catch clear.`;
  }

  /**
   * Per frame: while the wings move through the band (or stand in it) every holder is lifted to her band-clear pose
   * (`_radLift`; the writer is `_updateCargoPlumePoses`, below the net duck and a neighbour's carry lift in priority), and
   * goes back to her hold pose when the wings are settled outside it. A holder with no clear pose is not lifted (the
   * wings do not move: 'never'). Marks of arms that no longer hold a catch at home are dropped.
   */
  _tickRadLifts(dt) {
    const need = this._wingsMovingInBand() || this._wingsInBand();
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a) continue;
      if (!need || a.isDetached || a.state !== ARM_STATES.HOLDING_CATCH || !this._holdsAnyCatch(a)) { if (a._radLift) a._radLift = null; continue; }
      const cp = this._radClearPose(a, i, dt);
      if (cp && cp.rad !== null) { if (!a._radLift || a._radLift.rad !== cp.rad) a._radLift = { rad: cp.rad }; }
      else if (a._radLift) a._radLift = null;
    }
  }

  /**
   * The angle (rad) the mother must still turn about the strut's radial axis to bring this daughter into the swing
   * plane, from her place NOW and the ship's centre (`planeTurnLeftRad`). Null without the ship's place (a headless stub).
   */
  _rhPlaneTurnLeft(owner, az) {
    const ps = this.playerSatellite;
    if (!ps || !ps.position || !ps.quaternion || !owner.position) return null;
    _rhTurnQ.copy(ps.quaternion).invert();
    _rhTurnP.copy(owner.position).sub(ps.position).applyQuaternion(_rhTurnQ);
    return planeTurnLeftRad(_rhTurnP.x, _rhTurnP.y, _rhTurnP.z, az);
  }

  /**
   * The autopilot asks this EVERY frame of a tracked plane turn: how far is the mother still to turn (signed, rad)?
   * Null = stop where she is (the autopilot brakes at the couples' α): the turn is no longer ours (its daughter left the
   * reels, another turn replaced it), she is inside half the tolerance (hysteresis: a turn starts beyond PLANE_TOL_DEG and
   * ends inside half of it, so it cannot restart on the edge), or her lever on this axis is gone (level with it, or turn
   * left > TURN_MAX_DEG): turning on would only spin the mother, and the 2 m line-up deals with the rest.
   */
  _rhTrackPlane(turn, owner, az, tol) {
    if (this._rhTurn !== turn || !owner._rhHome || owner.isDetached) return null;
    if (Math.abs(owner._rhPlaneErrRad) < 0.5 * tol) return null;
    const left = this._rhPlaneTurnLeft(owner, az);
    const RH = Constants.REEL_HOME || {};
    if (left === null || Math.abs(left) > degToRad(RH.TURN_MAX_DEG ?? 60)) return null;
    return left;
  }

  _rhEndTurn(ap) {
    this._rhTurn = null;
    if (ap && ap._attitudeHoldOwner === 'REEL_HOME' && typeof ap.releaseAttitudeHold === 'function') ap.releaseAttitudeHold();
  }

  /**
   * The mother's own net (podIndex >= 0) or lasso is fired while a reel-home turn owns her attitude. The catch wins: the
   * turn stops at once and its REEL_HOME hold is let go; the catch's own reel-in hold is then taken through
   * AutopilotSystem's public calls (when its own listener ran first, `holdAttitudeForNet` / `holdAttitude` left our owned
   * hold alone, so it is taken here). The daughter then holds at 2 m (the mother is "limited": `isReelInHeld`).
   * @param {'net'|'lasso'} kind
   */
  _rhOnMotherCatchFired(kind) {
    if (!this._rhTurn) return;                       // none of ours holds the attitude
    const ap = this._autopilot;
    this._rhAbortTurn();
    if (!ap) return;
    if (kind === 'net' && typeof ap.holdAttitudeForNet === 'function') ap.holdAttitudeForNet();
    else if (kind === 'lasso' && typeof ap.holdAttitude === 'function') ap.holdAttitude();
  }

  _rhAbortTurn() {
    const ap = this._autopilot;
    if (ap && typeof ap.cancelAttitudeTurn === 'function') ap.cancelAttitudeTurn();
    this._rhEndTurn(ap);
  }

  /**
   * The gap, metres, between the ship and a daughter placed at `pos` (world) with her catch on her nose: a capsule from her
   * centre to the catch's centre, wide enough for the catch. Infinity without a keep-out model (a headless rig). The
   * line-up refuses a step nearer than ALIGN_CLEAR_M.
   */
  _rhGapAt(arm, pos, parentPos, parentQuat) {
    const ko = this.getKeepOut();
    if (!ko || !parentPos || !parentQuat) return Infinity;
    const q = _rhInvQ.copy(parentQuat).invert();
    const toShipM = (w, out) => out.copy(w).sub(parentPos).applyQuaternion(q).multiplyScalar(1 / M);
    const a = toShipM(pos, _rhGapA);
    const d = arm.capturedDebris;
    let rM = 0.30;
    const b = _rhGapB.copy(a);
    if (d && arm.group && d._rackLocalM) {
      b.copy(d._rackLocalM).applyQuaternion(arm.group.quaternion).applyQuaternion(q).add(a);
      rM = Math.max(rM, (d.sizeMeter || 0) / 2);
    }
    const ignore = ['dau' + arm.index, 'strut' + arm.index, 'rack catch ' + arm.index];
    const hit = ko.segment([a.x, a.y, a.z], [b.x, b.y, b.z], rM, { ignore });
    return hit && Number.isFinite(hit.gap) ? hit.gap : Infinity;
  }

  /**
   * ONE owner for the strut reel-cartridge LED/drum states (PlayerSatellite.setTetherState); this poll already reads every
   * arm's state.
   *
   * Mapping (mirrors ArmUnit._updateTether's tether-visible rules, so the drum spins exactly while the cable it reels is drawn):
   *   'deployed' — arm out on tether work (REELING/RETURNING/HAULING and every other deployed-away state): amber LED + spool spin
   *   'ready'    — strut home states (DOCKED/DOCKING/RELOADING/HOLDING_CATCH)
   *   'empty'    — EXPENDED (tether snapped) or deliberately DETACHED (cable cut): she'll never fly this cable again,
   *                so the cartridge must not read "home" (green) — it reads red.
   *
   * Edge-triggered (send on change only). Guarded for headless/legacy player mocks that lack setTetherState.
   */
  _syncTetherDrums() {
    const ps = this.playerSatellite;
    if (!ps || typeof ps.setTetherState !== 'function') return;
    for (const arm of this.arms) {
      const idx = arm.index;
      if (!(idx >= 0)) continue;
      let want;
      if (arm.isDetached || arm.state === ARM_STATES.EXPENDED) want = 'empty';
      else want = _DRUM_HOME_STATES.has(arm.state) ? 'ready' : 'deployed';
      if (this._drumStatesSent[idx] !== want) {
        this._drumStatesSent[idx] = want;
        ps.setTetherState(idx, want);
      }
    }
  }

  /**
   * The ONE SSOT for *cargo aboard*: the mother berth (BERTHED/COLLARED/TRANSFERRING, via getBerthedMassKg) PLUS every
   * daughter's heldCatches rack. Range (getMassBudget) and handling (PlayerSatellite._applyThrust) both read this.
   * Guarded: plain-object mocks may lack fields.
   *
   * A detached or expended daughter's rack does NOT count: that mass left with her, and CoMCalculator.getDaughterMass
   * already returns 0 for those holders. Unreachable today (HOLDING_CATCH is in neither detach()'s DETACHABLE set nor
   * deorbit eligibility), pinned by test.
   *
   * The in-hand `capturedDebris` scalar is deliberately NOT counted: it is the haul, and getMassBudget excludes a
   * deployed daughter's own mass too, so counting her cargo would be inconsistent.
   * @returns {number} kg of captured mass currently aboard, wherever it sits
   */
  getCargoMassKg() {
    const berthed = (this.playerSatellite
        && this.playerSatellite._captureNetSystem
        && typeof this.playerSatellite._captureNetSystem.getBerthedMassKg === 'function')
      ? this.playerSatellite._captureNetSystem.getBerthedMassKg() : 0;
    let rack = 0;
    for (const arm of this.arms) {
      if (arm.isDetached || arm.state === ARM_STATES.EXPENDED) continue;
      if (Array.isArray(arm.heldCatches)) {
        for (const held of arm.heldCatches) rack += (held && held.mass) || 0;
      }
    }
    const tip = (this.playerSatellite && this.playerSatellite.tipCargo
        && typeof this.playerSatellite.tipCargo.totalMassKg === 'function')
      ? this.playerSatellite.tipCargo.totalMassKg() : 0;
    return berthed + rack + tip;
  }

  /** The strut angle a daughter holding a catch rests at (see `_holdPoseOf` above). @returns {{rad:number, tooBig:boolean}|null} */
  holdPoseFor(armIndex) { return _holdPoseOf(this, armIndex); }

  /** Hold pose with a short memory: re-read when her rack changes or every 0.5 s (the read is a few dozen cone tests). */
  _holdPoseCached(arm, armIndex, dt) {
    const key = _rackKey(arm);                    // includes whether her wing profile is done, so the pose moves when it lands
    const c = arm._holdPose;
    if (c && c.key === key && c.ageS < 0.5) { c.ageS += dt; return c.pose; }
    const pose = this.holdPoseFor(armIndex);
    arm._holdPose = { key, pose, ageS: 0 };
    return pose;
  }

  /**
   * Every daughter parked HOLDING_CATCH with a catch gets her strut to her hold pose (`holdPoseFor`: 34° if her catch is
   * plume-clear there, else the lowest plume-clear angle, never above 100°). It starts from 34°, NOT from where the strut
   * is (a strut the reel left at 180° comes down), and acts whether or not the catch bites at the present angle. Live,
   * NOT flag-gated; THRUSTER_INTERLOCK stays dormant.
   *  • MANUAL: a "." press (`_strutManual`, aged by StrutAuto for holding arms too) stands for its quiet window as long as the
   *    angle it asked for is safe (not below the hold pose, not above 100°, catch plume-clear there); an unsafe one is dropped.
   *  • ONE writer of `_strutTargetAlpha` for a holding arm while no hand-off runs (CARRY_* arms are in another state).
   * Headless mocks lack the render-side strut driver, so they slew HERE; production slews once, in _updateStruts, which owns
   * the same latch.
   * @param {number} dt — frame delta, s
   */
  _updateCargoPlumePoses(dt) {
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const V5 = Constants.OCTOPUS_V5;
    const dead = V5.HOLD_POSE_DEADBAND_DEG * DEG2RAD;
    const cap = V5.HOLD_POSE_MAX_DEG * DEG2RAD;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
      const hp = this._holdPoseCached(arm, i, dt);
      // Inputs to this single writer: the net duck (inbound mother net) and the neighbour's carry lift (`_netLift`): while either
      // stands her target is its angle (the duck wins), whatever her hold pose or a standing "." press says; both end by
      // deleting `_netDuck` / `_netLift`, and the hold pose (or the press, if still safe) takes her back. The radiator-wing lift
      // (`_radLift`) is the third input; with a carry lift too, the HIGHER of the two (a carry's 69° under a 99° the wings
      // need would keep them waiting until the cap).
      const forced = arm._netDuck ? arm._netDuck.rad
        : (arm._netLift || arm._radLift) ? Math.max(arm._netLift ? arm._netLift.rad : -Infinity, arm._radLift ? arm._radLift.rad : -Infinity)
          : null;
      if (forced !== null) {
        const effF = arm._strutTargetAlpha !== undefined ? arm._strutTargetAlpha : arm.getAimAlpha();
        if (Math.abs(effF - forced) > dead) arm._strutTargetAlpha = forced;
      } else if (hp) {
        const eff = arm._strutTargetAlpha !== undefined ? arm._strutTargetAlpha : arm.getAimAlpha();
        let go = true;
        if (arm._strutManual) {
          const safe = eff >= hp.rad - dead && eff <= cap + dead && !heldCargoPlumeConflictAt(this, i, eff)
            && _wingRestOk(arm, eff / DEG2RAD);                                    // nor a pose her catch touches a wing at
          if (safe) go = false; else delete arm._strutManual;
        }
        if (go && Math.abs(eff - hp.rad) > dead) arm._strutTargetAlpha = hp.rad;
        if (hp.wingBlocked) {
          // nothing up to 100° keeps her catch off the radiators: one line per catch (K lets it go; C only when it can work)
          const sig = arm._holdPose.key;
          if (arm._holdWingSaid !== sig) {
            arm._holdWingSaid = sig;
            const c = this.canMoveCatchToRadiator(i) ? ' C moves it to a radiator.' : '';
            eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${i + 1}'s catch can't be held clear of the radiators. K lets it go.${c}`, priority: 'warning' });
          }
        }
        if (hp.tooBig) {
          const sig = arm._holdPose.key;
          if (arm._holdTooBigSaid !== sig) {
            arm._holdTooBigSaid = sig;
            // "Press C" only when C can work: the catch must be able to go to a tip at all, and C works only once every
            // daughter is full (otherwise the line says when). A catch that cannot go to a tip is parked and the line says so.
            const where = this._handoffOutlook(arm) === 'never'
              ? `, and it cannot go to a radiator; her strut parks at ${V5.HOLD_POSE_MAX_DEG}°.`
              : (this.allDaughtersFull() ? '; move it to a radiator (Press C).' : '; it can go to a radiator once every daughter is holding a catch.');
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `Daughter ${i + 1}'s catch is too big to keep clear of the thrusters${where}`,
              priority: 'warning',
            });
          }
        }
      }
      if (headless && arm._strutTargetAlpha !== undefined && typeof arm.setAimAlpha === 'function') {
        arm.setAimAlpha(arm._strutTargetAlpha, dt);
        if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
          arm._strutTargetAlpha = undefined;
        }
      }
    }
  }

  /**
   * Destination-feasibility READ (NOT the live gate): would planting arm `armIndex`'s strut tip at `alphaDest` put it
   * inside an occupied mother-net berth corridor? Same ship-local cylinder geometry as CaptureNet's _corridorClear
   * section 1 (fore of the berth anchor plane, radial < the mated catch's radius + BERTH_CLEARANCE_M), scoped to the
   * station holders (BERTHED/COLLARED/TRANSFERRING — the getDockedCatch set). The hold pose no longer reads this (its 100°
   * cap is clear of every inbound size, measured with `strutTipFoulsCorridor`); kept for any pose allowed above 100°.
   * @param {number} armIndex — arm index
   * @param {number} alphaDest — destination sweep angle (rad)
   * @returns {boolean} true when the destination crosses no occupied corridor
   */
  _repPoseCorridorClear(armIndex, alphaDest) {
    const player = this.playerSatellite;
    const cns = player && player._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (!nets || nets.length === 0) return true;
    const V5C = Constants.OCTOPUS_V5;
    const CN = Constants.CAPTURE_NET;
    if (!V5C || !CN || !CN.STATES) return true;
    const M_NET = 0.00001;

    // The ONE berth anchor: the collar object, else pod 0's muzzle, else the documented collar constant (as _corridorClear reads).
    const anchor = player._netBerthCollar
      ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M_NET : 0;
    const my = anchor ? anchor.position.y / M_NET : 0;
    const mz = anchor ? anchor.position.z / M_NET : (V5C.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (degToRad(dp.azimuthDeg)) : 0;
    const collarR = V5C.COLLAR_RADIUS ?? 0.40;
    const collarY = V5C.COLLAR_Y ?? 1.00;
    const strutLen = V5C.STRUT_LENGTH ?? 1.70;
    const anchorLocal = { x: mx, y: my, z: mz };

    const S = CN.STATES;
    for (const net of nets) {
      if (!net || !net._isMother) continue;
      if (net.state !== S.BERTHED && net.state !== S.COLLARED && net.state !== S.TRANSFERRING) continue;
      const d = net.targetDebris;
      const radiusM = ((d && d.sizeMeter) || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
      if (strutTipFoulsCorridor(alphaDest, azRad, collarR, collarY, strutLen, anchorLocal, radiusM)) {
        return false;
      }
    }
    return true;
  }

  // Lean aside for an inbound catch: nothing crosses or tangles (tethers, struts, debris). Both open poses, 34°
  // (STRUT_REST_ALPHA, tip z −0.41 m) and 90° (STRUT_DEPLOY_ALPHA, tip z ≈ −0.30 m), are aft of the muzzle plane, so no catch
  // fouls them and neither is ever ducked. The duck still runs for a strut set to 180° directly (no button reaches it),
  // to 90° and never past it.

  /**
   * Does arm `armIndex`'s CURRENT (live, `getAimAlpha()`) strut tip sit inside a berth corridor cylinder sized for an
   * inbound catch of `radiusM`? The geometry is `ArmDockBasis.strutTipFoulsCorridor`, the ONE copy, shared with
   * `CaptureNet._corridorClear` (the authoritative berth gate) and `_repPoseCorridorClear`. This method supplies only the
   * POLICY: which arm, which anchor, which radius.
   * @param {number} armIndex — arm index
   * @param {number} radiusM — the inbound catch's corridor radius (`debris.sizeMeter / 2 + CAPTURE_NET.BERTH_CLEARANCE_M`)
   * @param {number} [alphaRad] — test this strut angle instead of her live one (launch-aim cap)
   * @returns {boolean} true when this arm's live tip (or the tip at `alphaRad`) fouls the corridor
   */
  _strutFoulsInboundCorridor(armIndex, radiusM, alphaRad) {
    const arm = this.arms[armIndex];
    if (!arm || typeof arm.getAimAlpha !== 'function') return false;

    const player = this.playerSatellite;
    const V5 = Constants.OCTOPUS_V5;
    if (!player || !V5) return false;

    const anchor = player._netBerthCollar ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M : 0;
    const my = anchor ? anchor.position.y / M : 0;
    const mz = anchor ? anchor.position.z / M : (V5.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (degToRad(dp.azimuthDeg)) : 0;
    return strutTipFoulsCorridor(
      alphaRad === undefined ? arm.getAimAlpha() : alphaRad,
      azRad,
      V5.COLLAR_RADIUS ?? 0.40,
      V5.COLLAR_Y ?? 1.00,
      V5.STRUT_LENGTH ?? 1.70,
      { x: mx, y: my, z: mz },
      radiusM,
    );
  }

  /**
   * Trigger: `Events.LASSO_CAPTURED` — a catch is inbound. Every DOCKED arm whose live strut would foul the SAME corridor
   * `_corridorClear` uses ducks to `STRUT_DEPLOY_ALPHA` (90°). A strut at 34° or 90° never fouls (tip aft of the muzzle
   * plane), so only one past 90° (set directly, 180°) ducks; unresolved-size pieces never trigger a duck. Sole writer of
   * `_strutTargetAlpha` for the arms it ducks, for the duration of the duck only (`_releaseLeanAside` restores them).
   * @param {{debrisId?: number|string}} payload — LASSO_CAPTURED's payload
   */
  _onInboundCatchCaptured(payload) {
    const debrisId = payload && payload.debrisId;
    if (debrisId == null) return;
    if (!this._debrisField || typeof this._debrisField.getDebrisById !== 'function') return;
    // Rule H (CONVENTIONS §10): resolve the canonical object by id, never a snapshot/wrapper.
    const debris = this._debrisField.getDebrisById(debrisId);
    // No resolvable size ⇒ never duck ("small pieces must never trigger it").
    if (!debris || !debris.sizeMeter) return;

    const CN = Constants.CAPTURE_NET;
    const radiusM = debris.sizeMeter / 2 + (CN?.BERTH_CLEARANCE_M ?? 1.0);

    this._duckFoulingStruts(radiusM);
  }

  /**
   * Duck every DOCKED strut whose live tip fouls a berth corridor of `radiusM` to `STRUT_DEPLOY_ALPHA` (90°) and arm the
   * lean-aside release timer. The ONE copy of the duck loop (the lasso event and the arms-auto controller both call it).
   * @param {number} radiusM — the inbound catch's corridor radius, m
   * @returns {boolean} true when at least one strut was ducked
   */
  _duckFoulingStruts(radiusM) {
    let ducked = false;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.DOCKED) continue;
      if (this._strutFoulsInboundCorridor(i, radiusM)) {
        arm._strutTargetAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
        this._leanAsideArmIndices.add(i);
        ducked = true;
      }
    }
    // Holders duck through the same mechanism (trigger, release, timer), but only for a MOTHER net coming home
    // (`_tickNetDuck` ends their duck the moment none is; the lasso event has no mother net)
    if (_inboundMotherNetRadiusM(this) !== null && this._duckHolders(radiusM)) ducked = true;
    if (ducked) {
      this._leanAsideActive = true;
      this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
    }
    return ducked;
  }

  /**
   * (owner 2026-10-22: "their strut should ... move out of the way of mother net"): every daughter HOLDING a catch whose catch
   * would sit in the berth corridor of an inbound net of `radiusM` (`heldCargoFoulsCorridorAt`, her drawn mesh) lowers her
   * strut to the highest hold-pose-grid angle at which it does not (`_holderDuckRad`: 34° at the lowest). The angle is
   * computed ONCE per holder per reel (`arm._netDuck`) and kept until the lean-aside release; `_updateCargoPlumePoses`, the
   * one writer of a holder's strut target, takes it as an input. One Comms line per holder per reel. A holder already
   * ducked counts as "ducked" for the caller, which re-arms the release timer (a reel lasts 10-35 s, the timer is 8 s: a
   * backstop for a missed release event). A holder lifted (`_netLift`) for a carry IN FLIGHT (CARRY_OUT / CARRY_HANDOFF /
   * CARRY_BACK) is skipped: ducking her would put her catch in the carry's path; she ducks once the carry has landed, if
   * the net is still inbound (the net's corridor check counts her body meanwhile, so the reel pauses).
   * @param {number} radiusM — the inbound net's corridor radius, m
   * @returns {boolean} true when at least one holder is (or has just been) ducked
   */
  _duckHolders(radiusM) {
    let any = false;
    const flying = this.arms.some((a) => a && (a.state === ARM_STATES.CARRY_OUT || a.state === ARM_STATES.CARRY_HANDOFF || a.state === ARM_STATES.CARRY_BACK));
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.isDetached || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
      if (arm._netDuck) { any = true; continue; }
      if (arm._netLift && flying) continue;
      if (!(Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass))) continue;
      // One decision with the fire check (`_duckPlan`). A pending wing profile skips her this frame (the net's corridor gate holds
      // the net; she ducks the frame it is done: this runs every frame while a net is inbound); no wing-clear pose = she stays, one line.
      const plan = _duckPlan(this, i, radiusM);
      if (plan.kind === 4) continue;
      if (plan.kind === 2 || plan.kind === 3) {
        const sig = _rackKey(arm);
        if (arm._duckWingSaid !== sig) {
          arm._duckWingSaid = sig;
          eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${i + 1} can't lower her catch past the radiators; the net waits.`, priority: 'warning' });
        }
        continue;
      }
      const rad = plan.rad;
      if (rad === null) continue;
      // No holder starts a duck below the lift pose while the wings are inside the band (they leave it in a few seconds; the
      // net reel's own pause for the fouled corridor covers the wait), nor while they are about to enter or cross it (a duck
      // started the frame before they go in lowers her under them: the wings' own gate has not seen her move yet)
      if (rad < degToRad(Constants.REEL_HOLD.LIFT_DEG ?? 69) - 1e-6 && (this._wingsInBand() || this._wingsMovingInBand())) continue;
      arm._netDuck = { rad };
      arm._netDuckLow = true;                       // the Hall drive waits while this stands (and while she climbs back)
      arm._netDuckThrustSaid = false;
      this._leanAsideArmIndices.add(i);
      any = true;
      if (!arm._netDuckSaid) {
        arm._netDuckSaid = true;
        eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${i + 1} lowers her catch for the incoming net.`, priority: 'info' });
      }
    }
    return any;
  }

  /**
   * The per-frame part. While a mother net is inbound a holder's duck is (re)decided and its release timer re-armed,
   * StrutAuto runs; the moment NO mother net is inbound any more (a miss, a cut, a lost target: CaptureNet
   * sends no NET_FAILED / NET_TORN for those) the holders' ducks end (the 8 s timer is only the backstop); a duck whose
   * daughter no longer holds a catch is dropped; a holder whose strut is down for the net keeps the `_netDuckLow` mark until
   * she is back at her hold pose (`netDuckHold` reads it); the lifts for a neighbour's carry are kept or ended. Runs before
   * `_updateCargoPlumePoses`.
   * @param {number} dt — frame delta, s
   */
  _tickNetDuck(dt) {
    if (!(dt > 0)) return;
    const radiusM = _inboundMotherNetRadiusM(this);
    let ducked = false;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm) continue;
      if (arm._netDuck && !_holdsCatchAtHome(arm)) this._dropExHolderDuck(i, arm);
      else if (arm._netDuck) ducked = true;
    }
    if (radiusM !== null) {
      if (this._duckHolders(radiusM)) {
        this._leanAsideActive = true;
        this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
      }
    } else if (ducked) {
      this._releaseHolderDucks();
    }
    const V5 = Constants.OCTOPUS_V5;
    const dead = degToRad(V5.HOLD_POSE_DEADBAND_DEG);
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || !arm._netDuckLow) continue;
      const hp = arm.state === ARM_STATES.HOLDING_CATCH && !arm.isDetached ? this._holdPoseCached(arm, i, 0) : null;
      if (!hp) { arm._netDuckLow = false; continue; }
      if (!arm._netDuck && arm.getAimAlpha() >= hp.rad - 2 * dead) arm._netDuckLow = false;
    }
    this._tickLifts(dt);
  }

  /**
   * A daughter whose duck outlived her catch (hand-off, empty rack, detached) is dropped from the duck at once: no marks,
   * no queued press, and no place in the lean-aside list (it would send a DOCKED arm to 90° at the next release, and
   * re-send her every timer while a net is inbound).
   * @param {number} i — arm index
   * @param {object} arm
   */
  _dropExHolderDuck(i, arm) {
    arm._netDuck = null;
    arm._netDuckLow = false;
    arm._netDuckSaid = false;
    arm._netDuckThrustSaid = false;
    arm._queuedPress = null;
    this._leanAsideArmIndices.delete(i);
    if (this._leanAsideArmIndices.size === 0) { this._leanAsideActive = false; this._leanAsideTimer = 0; }
  }

  /**
   * End every holder's duck (no mother net is coming home): each goes back to her hold pose (`_updateCargoPlumePoses` is the
   * writer), a "." press that waited is applied, and her place in the lean-aside list is given up. A DOCKED arm another duck
   * (the lasso event) put in the list is not touched: that release belongs to its own events and timer.
   */
  _releaseHolderDucks() {
    for (const i of this._leanAsideArmIndices) {
      const arm = this.arms[i];
      if (!arm || !arm._netDuck) continue;
      arm._netDuck = null;
      arm._netDuckSaid = false;
      this._leanAsideArmIndices.delete(i);
      _applyQueuedPress(this, arm);
    }
    if (this._leanAsideArmIndices.size === 0) { this._leanAsideActive = false; this._leanAsideTimer = 0; }
  }

  /**
   * First daughter whose strut is down for an inbound net (ducked, or climbing back to her hold pose), else -1.
   * PlayerSatellite's billed-burn gate reads it: a Hall burn into her lowered catch waits.
   * @returns {number} arm index or -1
   */
  netDuckHold() {
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (a && a._netDuckLow && a.state === ARM_STATES.HOLDING_CATCH) return i;
    }
    return -1;
  }

  /**
   * Restore every arm this lane ducked to the 90° duck angle (`STRUT_DEPLOY_ALPHA`). Wired to `Events.NET_BERTHED` and the
   * "net clears/fails" events (LASSO_MISSED, LASSO_SNAPPED, NET_FAILED, NET_RELEASED, NET_TORN), plus a bounded timeout
   * (`_updateLeanAside`): the lasso adoption path (`CaptureNetSystem.adoptLassoCatch`) deliberately never emits NET_BERTHED.
   * Only restored while the arm is still DOCKED: if it left DOCKED mid-duck some other system owns its
   * `_strutTargetAlpha` and this must not fight it.
   */
  _releaseLeanAside() {
    if (this._leanAsideArmIndices.size === 0 && !this._leanAsideActive) return;
    // another mother net still coming home keeps the holders down (this release was the end of a different one)
    const stillInbound = _inboundMotherNetRadiusM(this) !== null;
    let kept = 0;
    for (const i of this._leanAsideArmIndices) {
      const arm = this.arms[i];
      // a duck whose daughter no longer holds a catch is over BEFORE anything else is asked of her: she is not sent to 90°
      // and she cannot keep the list alive ("another net is still coming in" below)
      if (arm && arm._netDuck && !_holdsCatchAtHome(arm)) { this._dropExHolderDuck(i, arm); continue; }
      if (arm && arm.state === ARM_STATES.DOCKED) {
        arm._strutTargetAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
      }
      // a holder goes back to her hold pose (`_updateCargoPlumePoses` is the writer); her "." press, if one waited, now
      // applies. `_netDuckLow` stays until she is there.
      if (arm && arm._netDuck) {
        if (stillInbound) { kept++; continue; }
        arm._netDuck = null;
        arm._netDuckSaid = false;
        _applyQueuedPress(this, arm);
      }
    }
    if (kept > 0) {
      for (const i of [...this._leanAsideArmIndices]) {
        const arm = this.arms[i];
        if (!(arm && arm._netDuck)) this._leanAsideArmIndices.delete(i);
      }
      this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
      return;
    }
    this._leanAsideArmIndices.clear();
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;
  }

  /**
   * Per-frame tick for the lean-aside safety-net timeout (see `_releaseLeanAside`).
   * @param {number} dt — frame delta, s
   */
  _updateLeanAside(dt) {
    if (!this._leanAsideActive) return;
    this._leanAsideTimer -= dt;
    if (this._leanAsideTimer <= 0) this._releaseLeanAside();
  }

  /**
   * Mass and Tsiolkovsky ΔV remaining for the HUD. coreDry = V5 bus dry mass + strut mass (struts stay on the mothership);
   * daughter masses (weaver/spinner) are separate — they leave when deployed.
   * @returns {object}
   */
  getMassBudget() {
    const V5 = Constants.OCTOPUS_V5;
    const strutMassTotal = V5.STRUT_MASS * this.arms.length;
    // Purchased flower pairs are permanent structure too: the ONE hardware-mass carrier is this coreDry term. The legacy
    // top-level OCTOPUS_CORE_DRY_MASS twin (170) is deliberately NOT grown: its one reader is TargetReticle's local ΔV
    // mirror (a known +626.7 m/s optimism at tier 0, tmp/flower-mass-budget.mjs §3; the flower widens it by the untold pair tax).
    const flowerMass = (this.playerSatellite
        && typeof this.playerSatellite.getFlowerDryMassKg === 'function')
      ? this.playerSatellite.getFlowerDryMassKg() : 0;
    // Reaction-wheel kit (DECISIONS §2 row 9): 12.1 kg of structure on the same carrier term.
    const wheelMass = (this.playerSatellite
        && typeof this.playerSatellite.getWheelKitMassKg === 'function')
      ? this.playerSatellite.getWheelKitMassKg() : 0;
    // The 60 L engine tank is structure too (9.5 kg, research §2.2), ADDED to CORE_DRY_MASS (176 = bus + ROSA + body-mount + collar; no
    // tank); its dry mass follows its size (the Bigger Engine Tank carries more tank).
    const resources = this.playerSatellite.resources || {};
    const rsStatus = this._resourceSystem ? this._resourceSystem.getStatus() : null;
    const xenonPoolMax = rsStatus ? rsStatus.xenonMax : Constants.XENON_FUEL_MAX;
    const tankDry = engineTankDryKg({ xenonMax: xenonPoolMax });
    const coreDry = V5.CORE_DRY_MASS + tankDry + strutMassTotal + flowerMass + wheelMass;

    // The tank is POOL units (20 = the 6 kg tank; Extra Cold Gas raises the max), so kg = coldGasPoolToKg, not 6 kg x fraction.
    const coldGasPoolMax = rsStatus ? rsStatus.coldGasMax : Constants.COLD_GAS_MAX;
    const coldGasMax = coldGasPoolToKg(coldGasPoolMax);
    // Engine gas in kg = pool/100 x kgFull of the gas IN THE TANK (tankGasId), via the ONE exported converter.
    // `xenonCurrent` / `xenonMax` keep their names (HUD readers) but are the engine gas kg now / when the tank is full.
    const gasRes = {
      xenon: resources.xenon || 0,
      tankGasId: resources.tankGasId || (rsStatus && rsStatus.tankGasId) || Constants.DEFAULT_FUEL,
    };
    const tankGas = Constants.FUELS[gasRes.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    const xenonCurrent = engineGasKg(gasRes);
    const xenonMax = (xenonPoolMax / 100) * tankGas.kgFull;
    const coldGasCurrent = coldGasPoolToKg(resources.coldGas || 0);

    let armMassTotal = 0;
    let dockedArmMass = 0;
    let deployedArmMass = 0;
    let detachedArmMass = 0;
    for (const arm of this.arms) {
      const m = arm.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      armMassTotal += m;
      // HOLDING_CATCH is home-and-occupied, NOT "out": keying on DOCKED only dipped the ship mass by one arm at the arrival
      // tick, as the rack gained the cargo. CoMCalculator counts her throughout (only detached/expended are excluded).
      if (arm.state === ARM_STATES.DOCKED || arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state)) {
        dockedArmMass += m;
      } else if (arm.state !== ARM_STATES.EXPENDED) {
        deployedArmMass += m;
        if (arm.isDetached) detachedArmMass += m;
      }
    }

    // A berthed whale is real mass the Tsiolkovsky readout and the autopilot's pre-engage ΔV gate must both see: added to
    // wetMass AND dryMass (it is not propellant), else the HUD promises ΔV the laden ship cannot deliver. The fold is
    // CARGO ABOARD (berthed + every daughter rack) via the getCargoMassKg SSOT; berthedMass stays as its own berth-only
    // field, and the HUD's "+N kg" line reads cargoMass, so it survives the transfer off the nose.
    const berthedMass = (this.playerSatellite
        && this.playerSatellite._captureNetSystem
        && typeof this.playerSatellite._captureNetSystem.getBerthedMassKg === 'function')
      ? this.playerSatellite._captureNetSystem.getBerthedMassKg() : 0;
    const cargoMass = this.getCargoMassKg();

    // DECISIONS §33 row 4 (2026-10-20): the mother's nets aboard are real mass, carried in the launcher like the cargo: in
    // the loaded and the empty mass, and so in the engine's Tsiolkovsky dry term. A fired net leaves the ship (the count is
    // the one CaptureNetSystem owns). The daughters' own nets are taken to be inside V5_WEAVER_MASS / V5_SPINNER_MASS (no
    // separate term). CoMCalculator books the same mass on the launcher axis (motherNetBooking). Every loaded net weighs
    // the current line-fibre tier's packed mass (CaptureNetSystem.getMotherNetMassKg: count x
    // TETHER_TIERS[tier].netMassKg.mother; 1.425 kg = CAPTURE_NET.LARGE.MASS at the start tier).
    const mCns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    const motherNetCount = (mCns && typeof mCns.getMotherNetCount === 'function') ? mCns.getMotherNetCount() : 0;
    const motherNetMass = (mCns && typeof mCns.getMotherNetMassKg === 'function')
      ? mCns.getMotherNetMassKg()
      : motherNetCount * Constants.CAPTURE_NET.LARGE.MASS;

    // Cold gas is CARRIED, not burned by the Hall engine: it sits in BOTH the loaded and the empty mass.
    // Ruling 0, §33 row 11 "her mass is live": the indium in her ion-fuel store is carried like cargo (the Hall engine
    // never burns it): in the loaded and the empty mass.
    const indiumStoreKg = (this._resourceSystem && Number.isFinite(this._resourceSystem.indiumStoreKg)) ? Math.max(0, this._resourceSystem.indiumStoreKg) : 0;
    // The drag sails in her stock (§33 row 11 "her mass is live") are carried like the indium: in the loaded and the empty mass.
    const dragSailKg = (this._resourceSystem && typeof this._resourceSystem.dragSailMassKg === 'function') ? this._resourceSystem.dragSailMassKg() : 0;
    const carriedDry = coreDry + coldGasCurrent + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg;
    const wetMass = carriedDry + xenonCurrent;
    const dryMass = coreDry + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg;   // reported without either gas

    // Tsiolkovsky for the engine: ΔV = Isp_eff x g0 x ln((dry + cold + gas) / (dry + cold)).
    // Isp_eff = the ACTIVE fuel's Isp / c (shop upgrade x power split act as Isp gains).
    const fuel = this._resourceSystem ? this._resourceSystem.getCurrentFuel() : Constants.FUELS[gasRes.tankGasId];
    const c = (this.playerSatellite && typeof this.playerSatellite.getConsumptionMultiplier === 'function')
      ? this.playerSatellite.getConsumptionMultiplier() : 1;
    const ispActive = fuel && fuel.isp > 0 ? fuel.isp : Constants.OCTOPUS_CORE_HALL_ISP;
    const isp = ispActive / (c > 0 ? c : 1);
    const deltaV = engineDeltaV({
      dryKg: coreDry + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg, coldGasKg: coldGasCurrent, gasKg: xenonCurrent, isp: ispActive, c,
    });

    return {
      coreDry,
      flowerMass: Math.round(flowerMass * 10) / 10,
      xenonCurrent: Math.round(xenonCurrent * 10) / 10,
      xenonMax,
      // "how full is the engine tank" by MASS, the same for every gas (bars and colours read this)
      gasFrac: engineGasLowFrac({ xenon: gasRes.xenon, xenonMax: xenonPoolMax, tankGasId: gasRes.tankGasId }),
      coldGasCurrent: Math.round(coldGasCurrent * 10) / 10,
      coldGasMax,
      dockedArmMass: Math.round(dockedArmMass * 10) / 10,
      deployedArmMass: Math.round(deployedArmMass * 10) / 10,
      detachedArmMass: Math.round(detachedArmMass * 10) / 10,
      armMassTotal: Math.round(armMassTotal * 10) / 10,
      wetMass: Math.round(wetMass),
      dryMass: Math.round(dryMass),
      berthedMass: Math.round(berthedMass * 10) / 10,
      cargoMass: Math.round(cargoMass * 10) / 10,
      motherNets: motherNetCount,
      motherNetMass: Math.round(motherNetMass * 1000) / 1000,
      deltaV: Math.round(deltaV),
      isp,
      shipMassKg: wetMass,   // exact (unrounded) total mass now — the gas-flow law's m_ship (PlayerSatellite)
      tankGasId: gasRes.tankGasId,
    };
  }

  /**
   * Select an arm by index (0-7).
   * @param {number} index — arm index in the arms array
   * @param {{quiet?: boolean}} [opts] - quiet: no "X selected." comms line (the auto-pick after a launch already has its
   *   launch line; one line in comms, not two)
   */
  selectArm(index, opts = {}) {
    if (index < 0 || index >= this.arms.length) return;
    if (this.selectedArmIndex === index) {
      this.deselectArm();
      return;
    }
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const prev = this.arms[this.selectedArmIndex];
      if (prev && prev.isManual()) prev.disableManual();
      if (prev && typeof prev.setSelectedHighlight === 'function') prev.setSelectedHighlight(false);
    }
    this.selectedArmIndex = index;
    const arm = this.arms[index];
    if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(true);
    eventBus.emit(Events.ARM_SELECT, { armIndex: index });
    if (opts && opts.quiet) return;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${arm.displayName} selected.`,
      priority: 'info',
    });
  }

  /** Deselect arm — return focus to mothership. */
  deselectArm() {
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const arm = this.arms[this.selectedArmIndex];
      if (arm && arm.isManual()) arm.disableManual();
      if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(false);
    }
    this.selectedArmIndex = -1;
    eventBus.emit(Events.ARM_DESELECT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Daughter deselected. Mothership focus',
      priority: 'info',
    });
  }

  /** @returns {ArmUnit|null} */
  getSelectedArm() {
    if (this.selectedArmIndex < 0 || this.selectedArmIndex >= this.arms.length) return null;
    return this.arms[this.selectedArmIndex];
  }

  /**
   * The selected arm IF it is deployed and pilotable, or null.
   * Pilotable states: TRANSIT, APPROACH, TRAWLING, STATION_KEEP.
   * @returns {ArmUnit|null}
   */
  getSelectedDeployedArm() {
    const arm = this.getSelectedArm();
    if (!arm) return null;
    const pilotable = [
      ARM_STATES.TRANSIT,
      ARM_STATES.APPROACH,
      ARM_STATES.TRAWLING,
      ARM_STATES.STATION_KEEP,
    ];
    return pilotable.includes(arm.state) ? arm : null;
  }

  getDockedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.DOCKED).length;
  }

  getDeployedCount() {
    return this.arms.filter(a =>
      a.state !== ARM_STATES.DOCKED &&
      a.state !== ARM_STATES.EXPENDED
    ).length;
  }

  /**
   * True if ANY arm is deployed on a tether (not docked, not expended, not detached).
   * Canonical predicate — use this instead of inline state checks.
   */
  hasTetheredArm() {
    const S = Constants.ARM_STATES;
    return this.arms.some(a =>
      a.state !== S.DOCKED &&
      a.state !== S.RELOADING &&
      a.state !== S.HOLDING_CATCH &&   // parked at the strut holding a catch — home, no live tether
      a.state !== S.EXPENDED &&
      !a.isDetached
    );
  }

  /**
   * The rotation lock tier based on deployed arm states.
   * 'block' — hard-block rotation (high-risk: REELING, HAULING, GRAPPLED, STATION_KEEP, NETTING, DOCKING)
   * 'soft'  — soft-cap rotation to TETHER_ROTATION.SOFT_CAP_RATE (TRANSIT, APPROACH, TRAWLING, LAUNCHING, RETURNING, SCANNING, ABLATING)
   * 'none'  — no constraint (all arms DOCKED/EXPENDED/RELOADING or detached)
   *
   * A LAUNCHING daughter whose spring has NOT fired is still clamped to her strut (part of the ship, no tether out), so she
   * contributes 'none'; her tier is 'soft' from the spring on (she is flying out on the line).
   */
  getRotationLockTier(exceptArm = this._lockExceptArm) {
    let tier = 'none';
    for (const arm of this.arms) {
      if (arm.isDetached) continue;
      // The daughter the mother turns FOR, and every other daughter already on the strut line (REELING home: her line is
      // being wound in), do not hold the mother still. A daughter still in GRAPPLED (her net reel included) does. Callers
      // with no `exceptArm` get the plain answer.
      if (this._rhIgnoredForTurn(arm, exceptArm)) continue;
      const s = arm.state;
      if (s === ARM_STATES.LAUNCHING && !arm._springFired) continue;  // clamped: part of the ship
      if (_HIGH_RISK_ROT_STATES.has(s)) return 'block';
      if (_SOFT_ROT_STATES.has(s)) tier = 'soft';
      // DOCKED / RELOADING / HOLDING_CATCH / EXPENDED contribute 'none' — leave tier unchanged
    }
    return tier;
  }

  getExpendedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.EXPENDED).length;
  }

  /**
   * Status of all arms for HUD display: an array of per-arm status objects, each with springCharged and reloadProgress
   * from ArmUnit.getStatus().
   * @returns {Array<object>}
   */
  getAllStatus() {
    return this.arms.map(a => a.getStatus());
  }

  /**
   * Pure read (no comms, no state change): can a daughter go at `target` now, will one without the player doing
   * anything, or what stops them all? Mirrors the gates of `deployArm` (safe mode, ARM power, the arm `_findDockedArm`
   * picks by type, its capture mass), so `ready` is true exactly when `deployArm(target)` gets past them. Daughter fuel
   * never refills in play, so fuel <= 5 is a dead end (`noFuel`).
   * @param {object} target - needs `.mass` (default 1 kg, as deployArm)
   * @returns {{ready:boolean, wait:boolean, going:boolean, why:(string|null), counts:{noFuel:number, holding:number, heavy:number}}}
   *   `going`: a daughter already out for this very piece. `wait`: not ready, but one will be (spring reloading, or
   *   out on her line). `why`: 'safe' | 'power' | 'none' | 'fuel' | 'holding' | 'heavy' | 'mixed' when nothing will be ready.
   */
  daughterLaunchReadiness(target) {
    const S = ARM_STATES;
    const counts = { noFuel: 0, holding: 0, heavy: 0 };
    const out = { ready: false, wait: false, going: false, why: null, counts };
    const arms = this.arms || [];
    out.going = !!target && arms.some((a) => a && a.state !== S.DOCKED && a.target === target);
    if (this.playerSatellite && this.playerSatellite.safeMode) { out.why = 'safe'; return out; }
    if (powerDistribution.armMultiplier <= 0) { out.why = 'power'; return out; }

    const mass = (target && target.mass) || 1;
    const first = mass > Constants.SPINNER_MAX_CAPTURE_MASS ? 'weaver' : 'spinner';
    const order = [first, first === 'weaver' ? 'spinner' : 'weaver'];
    for (const type of order) {
      const eligible = arms.filter((a) => a && a.type === type && armCanLaunchNow(a));
      if (eligible.length > 0) {
        out.ready = eligible.some((a) => mass <= a.config.maxCaptureMass || isInspectOnlyMass(mass));
        break;
      }
    }
    if (out.ready) return out;

    for (const a of arms) {
      if (!a || a.state === S.EXPENDED || a.state === S.ADRIFT || a.isDetached) continue;
      if (a.state === S.HOLDING_CATCH) { counts.holding++; continue; }
      if (!(a.fuel > 5)) { counts.noFuel++; continue; }
      if (mass > a.config.maxCaptureMass && !isInspectOnlyMass(mass)) { counts.heavy++; continue; }
      out.wait = true;
    }
    if (out.wait) return out;
    const kinds = (counts.noFuel > 0) + (counts.holding > 0) + (counts.heavy > 0);
    out.why = kinds === 0 ? 'none'
      : kinds > 1 ? 'mixed'
        : counts.noFuel > 0 ? 'fuel' : counts.holding > 0 ? 'holding' : 'heavy';
    return out;
  }

  /**
   * Find a docked arm matching the preferred type, with highest fuel (springCharged required). With `targetDir`
   * (ship-local) prefer the arm whose dockOffset best aligns with it (within ~45°) to minimise camera swing on deploy.
   * @param {'weaver'|'spinner'} type
   * @param {THREE.Vector3|null} [targetDir=null] - ship-local direction to the target
   * @param {((arm: ArmUnit) => boolean)|null} [accept=null] - only arms this accepts (a strut whose line stays clear)
   * @returns {ArmUnit|null}
   */
  _findDockedArm(type, targetDir = null, accept = null) {
    const eligible = this.arms.filter(a => a.type === type && armCanLaunchNow(a) && (!accept || accept(a)));
    if (eligible.length === 0) return null;

    if (targetDir && targetDir.lengthSq() > 0) {
      const dir = targetDir.clone().normalize();
      const COS_45 = 0.707; // cos(45°) threshold for "well-aligned"

      const scored = eligible.map(arm => {
        const dockDir = arm.dockOffset.clone().normalize();
        return { arm, dot: dir.dot(dockDir) };
      });

      const aligned = scored.filter(s => s.dot > COS_45);
      if (aligned.length > 0) {
        aligned.sort((a, b) => b.dot - a.dot);
        return aligned[0].arm;
      }
    }

    eligible.sort((a, b) => b.fuel - a.fuel);
    return eligible[0];
  }

  /**
   * Apply a shop upgrade to all arms. Stores the override so it survives reset() (which field-resets and reuses the
   * existing arm instances — no new ArmUnit construction outside _initArms).
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data, opts = {}) {
    this._storedUpgrades[data.effect] = data.value;

    if (data.type === 'springTier' || data.effect === 'springTier') {
      this.applySpringUpgrade(data.value || data.level);
      return;
    }
    if (data.type === 'tetherTier' || data.effect === 'tetherTier') {
      // opts.restore = the save-load replay (GameFlowManager MENU_CONTINUE): every launcher comes up full.
      this.applyTetherUpgrade(data.value || data.level, { fill: !!(opts && opts.restore) });
      return;
    }

    // Apply to all current arm units
    for (const arm of this.arms) {
      arm.applyUpgradeOverride(data.effect, data.value);
    }
  }

  /**
   * The first DOCKED daughter of `type` (weaver = large, spinner = small) with room in her net magazine (DECISIONS §33
   * rows 2 and 5: nets refill only by buying at the resupply stop, one at a time).
   * @param {'weaver'|'spinner'} type — weaver = the large daughter, spinner = the small
   * @returns {object|null} the arm, or null when none is docked with room
   */
  findDaughterNeedingNet(type) {
    for (const arm of this.arms) {
      if (!arm || arm.state !== ARM_STATES.DOCKED) continue;
      const t = arm.config ? arm.config.type : arm.type;
      if (t !== type) continue;
      const max = typeof arm.getNetInventoryMax === 'function' ? arm.getNetInventoryMax() : 0;
      const have = typeof arm.getNetInventory === 'function' ? arm.getNetInventory() : 0;
      if (max > 0 && have < max) return arm;
    }
    return null;
  }

  hasDaughterNetSpace(type) {
    return this.findDaughterNeedingNet(type) !== null;
  }

  /**
   * Shop consumable: load exactly ONE net into the first docked daughter of `type` with room. Not an upgrade (no
   * stored override, nothing replays after a reset): the magazine is the state.
   * @param {'weaver'|'spinner'} type
   * @returns {boolean} true if a net was loaded
   */
  addDaughterNet(type) {
    const arm = this.findDaughterNeedingNet(type);
    if (!arm) return false;
    arm.setNetInventory(arm.getNetInventory() + 1);
    return true;
  }

  /** Re-apply all stored shop upgrades to current arms, after reset() has field-reset the (reused, not recreated) ArmUnits. */
  _reapplyStoredUpgrades() {
    for (const [effect, value] of Object.entries(this._storedUpgrades)) {
      if (effect === 'springTier') {
        this.applySpringUpgrade(value);
        continue;
      }
      if (effect === 'tetherTier') {
        this.applyTetherUpgrade(value);
        continue;
      }
      for (const arm of this.arms) {
        arm.applyUpgradeOverride(effect, value);
      }
    }
  }

  /**
   * Apply V4 "Opussy" GSL technology upgrade.
   * @param {string} upgrade - One of: 'gslTether', 'gslNet', 'electrostaticNet'
   */
  _applyV4Upgrade(upgrade) {
    switch (upgrade) {
      case 'gslTether':
        for (const arm of this.arms) {
          arm.config.tetherMax = Math.round(arm.config.tetherMax * Constants.V4_TETHER_LENGTH_MULT);
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL tethers installed. Reach extended to 12.5 km',
          priority: 'success',
        });
        break;

      case 'gslNet':
        for (const arm of this.arms) {
          arm.config.netSize = arm.config.netSize * Constants.V4_NET_SIZE_MULT;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL nets installed. 50×50m capture area',
          priority: 'success',
        });
        break;

      case 'electrostaticNet':
        for (const arm of this.arms) {
          // capture rate 85% -> ~95%, handled in ArmUnit._updateNetting via a flag
          arm._v4Electrostatic = true;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 HBN-coated electrostatic nets. Capture rate improved',
          priority: 'success',
        });
        break;
    }
  }

  reset() {
    // A carry in progress lets go of its tip reservation, the strut reservation and the radiator hold first (this reset
    // sets the fields below directly and never calls ArmUnit.reset, which would have done it).
    this.abortAllCarries('reset');
    // Release the cargo this reset drops BEFORE the fields clear (every other unpin lives on a non-reset path, so a dropped
    // piece kept _armPinned/_armPinPos/_capturedByArm and DebrisField drew it glued at the stale slot forever, in no ledger).
    // Release to a free, re-targetable body re-seated at the pin the player last saw.
    const _player = this.playerSatellite;
    const _releaseVel = (_player && typeof _player.getVelocity === 'function')
      ? _player.getVelocity() : null;
    for (const arm of this.arms) {
      this._releaseDroppedCargo(arm.heldCatches, _releaseVel);
      if (arm.capturedDebris) this._releaseDroppedCargo([arm.capturedDebris], _releaseVel);
      // A tether-snapped catch stays pinned to the drifting EXPENDED daughter (_updateExpended re-pins it every frame until
      // TETHER_SNAP_RELEASE_DELAY_S releases it). The reset re-docks the arm inside that window, so release the pin first,
      // else the piece ghosts at the stale drift pin with _capturedByArm on a now-DOCKED arm.
      if (arm._severedCatch) {
        this._releaseDroppedCargo([arm._severedCatch], _releaseVel);
        arm._severedCatch = null;
        arm._severedDriftS = 0;
      }
      arm.state = ARM_STATES.DOCKED;
      arm._pairPartner = null; arm._pairWaiting = false; arm._pairWaitS = 0; arm._pairGo = null;
      arm._pairTogether = false; arm._pairSaid = false; arm._pairCatchFailed = false;
      arm.fuel = 100;
      arm.coldGasKg = arm._coldGasBottleKg();   // the bottle is reset wherever the FEEP fuel is
      // An SK target's LOD-protection flag must not survive the reset: clear it on `_stationKeepTarget` (the SK session's
      // own reference) before dropping the target, else the piece skips LOD downscaling forever (`DebrisField._updateInstanceTransform`), rendering
      // at full detail past the 50 km cull.
      if (arm._stationKeepTarget) arm._stationKeepTarget._isStationKeepTarget = false;
      arm._stationKeepTarget = null;
      arm.target = null;
      arm.capturedDebris = null;
      arm.heldCatches = [];               // the parked cargo rack resets too
      arm.captures = 0;
      arm.stateTimer = 0;
      arm.tetherLength = 0;
      arm.velocity.set(0, 0, 0);
      arm.mesh.visible = false;
      arm.tetherLine.visible = false;
      arm._webShotCooldown = 0;
      arm._webShotTarget = null;
      arm.isDetached = false;
      arm._detachFuelWarning25 = false;
      arm._detachFuelWarning10 = false;
      arm.springCharged = true;
      arm.reloadProgress = 0;
      arm.reloadDuration = 0;
      arm.tetherTension = 0;
      arm.reeling = false;
      arm.launchDirection = null;
      _clearNetDuckMarks(arm);        // no duck, lift, wait or queued press outlives the holder she belonged to
    }
    // ... and the lean-aside list, flag and timer go with them (else the 8 s backstop later sends a docked arm to 90°)
    if (this._leanAsideArmIndices) this._leanAsideArmIndices.clear();       // (test-ArmUnit-ParkCatch resets a bare prototype object)
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;
    this._radBandWho = -1;            // no radiator wait outlives the reset
    this._wingQueue = [];             // no wing-profile work outlives the reset (the catches themselves were dropped above)
    this._netBlockKind = null;

    // The loop above clears every rack (a cargo mass-exit) but sets arm.state directly, so no ARM_STATE_CHANGE crosses it:
    // invalidate the attitude-inertia cache here or the cleared mass rides the rotational model until the next arm/berth
    // event. The berthed/collared side needs nothing (no reset path touches captureNetSystem.activeNets).
    if (this.playerSatellite) this.playerSatellite._attitudeInertia = null;
    if (this.playerSatellite) this.playerSatellite._daughterIndiumEmptySaid = false;

    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    if (this._strutAuto) this._strutAuto.reset();
    this._strutPress = 0;
    this._allFullSaid = false;        // the "all daughters are holding catches" line may be said again
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;
    this._missionCarrySaid = null;
    for (const arm of this.arms) { delete arm._strutManual; delete arm._holdPose; }

    this._reapplyStoredUpgrades();
  }

  /**
   * Release the pieces reset() drops (the rack + the in-hand scalar) back to the field as free, re-targetable bodies, as
   * ArmUnit._releaseCapturedDebris and CaptureNetSystem._clearCatchPins do: clear the authoritative pin AND the captor
   * back-reference (both must go, or DebrisField's _pinToArm branch re-pins the piece to the re-docked arm), and re-seat
   * the orbit from the shown pin (reseatOrbitFromScene). Without a player velocity the re-seat skips and the piece resumes
   * its live orbit (it kept propagating under the pin; DebrisField freezes only _onboardingPinned/_motherParked).
   * @param {Array<object>|null} pieces
   * @param {{x:number,y:number,z:number}|null} releaseVel km/s (Y-up scene frame)
   */
  _releaseDroppedCargo(pieces, releaseVel) {
    if (!pieces) return;
    for (const d of pieces) {
      if (!d) continue;
      reseatOrbitFromScene(d.orbit, d._scenePosition, releaseVel);
      d._armPinned = false;
      d._armPinPos = null;
      d._capturedByArm = null;
      d._captured = false;             // re-targetable — a chase-able object again
      d._isStationKeepTarget = false;
      d._committedNetArmId = null;
      d._netted = true;                // drifting in its net (the haul-failure idiom)
      d._breakdownActive = false;      // a mid-chop reset owns no furnace timeline
      d._catchRenderMin = 0;           // the held-readability floor dies with the hold
      clearRackCell(d);                // and the cell it held on her
      // A pending BIG piece that breaks loose leaves the ledger with a plain line (nobody pays for it now) and is `_disposed`.
      // GameFlowManager clears the ledger BEFORE a new game's reset, so this says nothing there.
      if (bigPieces.loose(d.id)) d._disposed = true;
    }
  }

  /**
   * The station takes the catches parked on the daughters' racks (the resupply stop; GameFlowManager). Each paid piece
   * leaves the rack and is returned for the caller to remove from the field; the rack is cleared, so ArmUnit's empty-rack
   * fallback sends her to reload next frame. An unpaid piece stays. Emits NET_CONSUMED per piece; no CATCH_PROCESSED
   * (nothing is credited or digested).
   * @param {(piece: object) => boolean} [isPaid] - true when the piece has been credited (default: `_credited`)
   * @returns {Array<object>} the pieces handed over
   */
  unloadHeldCatches(isPaid) {
    // a pending big piece is credited but UNPAID (it pays when disposed of): the default never unloads one for nothing
    const paid = typeof isPaid === 'function' ? isPaid : (d) => !!(d && d._credited && !bigPieces.isPending(d));
    const out = [];
    for (const arm of this.arms) {
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH || !Array.isArray(arm.heldCatches)) continue;
      const keep = [];
      for (const d of arm.heldCatches) {
        if (!d) continue;
        if (!paid(d)) { keep.push(d); continue; }
        d._armPinned = false;
        d._armPinPos = null;
        d._capturedByArm = null;
        d._breakdownActive = false;
        clearRackCell(d);               // it leaves her rack
        out.push(d);
        eventBus.emit(Events.NET_CONSUMED, { armIndex: arm.index, armId: arm.id, debrisId: d.id });
      }
      if (keep.length !== arm.heldCatches.length) {
        arm.heldCatches = keep;
        arm.stateTimer = 0;
      }
    }
    if (out.length > 0) {
      const ps = this.playerSatellite;
      if (ps && '_attitudeInertia' in ps) ps._attitudeInertia = null;
    }
    return out;
  }

  /**
   * Take ONE piece off a daughter's rack, as `unloadHeldCatches` does per piece (a big piece being disposed of; the caller
   * clears the field body's own pins, a rack may hold a snapshot of it). NET_CONSUMED is said (the bag visual clears; a
   * collared catch waiting for room tries again). Refuses (null) unless she is HOLDING_CATCH and not carrying it anywhere.
   * @param {number|string} debrisId @returns {object|null} the rack's entry for the piece, or null
   */
  detachHeldCatch(debrisId) {
    for (const arm of this.arms) {
      if (!arm || !Array.isArray(arm.heldCatches)) continue;
      const i = arm.heldCatches.findIndex((h) => h && h.id === debrisId);
      if (i < 0) continue;
      if (arm.state !== ARM_STATES.HOLDING_CATCH || arm._carry) return null;
      const d = arm.heldCatches[i];
      d._armPinned = false;
      d._armPinPos = null;
      d._capturedByArm = null;
      d._breakdownActive = false;
      d._catchRenderMin = 0;
      clearRackCell(d);
      arm.heldCatches.splice(i, 1);
      arm.stateTimer = 0;
      eventBus.emit(Events.NET_CONSUMED, { armIndex: arm.index, armId: arm.id, debrisId: d.id });
      const ps = this.playerSatellite;
      if (ps && '_attitudeInertia' in ps) ps._attitudeInertia = null;
      return d;
    }
    return null;
  }

  /**
   * The scoop bag a daughter could let go. Candidates are the small bags parked on a rack (HOLDING_CATCH, not being carried;
   * a bag with a big member is in the ledger and pays when disposed of, so it is never a candidate). The selected
   * daughter's bag wins; a selected daughter who holds none is `notSelected` (K speaks to her: the others' bags are not
   * touched, never a guess); with none selected the ONLY daughter holding one; two holders and no selection is
   * `ambiguous`. `salvage: true` when any member carries salvage; one with none is "not worth salvaging".
   * @returns {{arm: object, bag: object, salvage: boolean}|{ambiguous: true}|{notSelected: true}|null} null: no such bag
   */
  rackBagOffer() {
    const S = ARM_STATES;
    const holders = [];
    for (const arm of this.arms) {
      if (!arm || arm.state !== S.HOLDING_CATCH || arm._carry || !Array.isArray(arm.heldCatches)) continue;
      const bag = arm.heldCatches.find((h) => h && h.isBag === true && h.alive !== false && !bigPieces.isPending(h));
      if (bag) holders.push({ arm, bag });
    }
    if (holders.length === 0) return null;
    const sel = this.selectedArmIndex >= 0 ? this.arms[this.selectedArmIndex] : null;
    if (sel && !holders.some((h) => h.arm === sel)) return { notSelected: true };
    const pick = holders.find((h) => h.arm === sel) || (holders.length === 1 ? holders[0] : null);
    if (!pick) return { ambiguous: true };
    return { arm: pick.arm, bag: pick.bag, salvage: bagHasSalvage(pick.bag) };
  }

  /**
   * Put a restored big piece back on a daughter's rack after a reload: the daughter it was saved on if she is home and
   * empty, else the one the cargo routing would pick (home, empty, not the last able to capture). Nothing is credited.
   * @param {object} debris the restored field body @param {string|null} [hintArmId] the daughter it was saved on
   * @returns {string|null} the daughter's id, or null when none can take it (the caller seats it at the collar)
   */
  restoreHeldCatch(debris, hintArmId = null) {
    if (!debris) return null;
    const ps = this.playerSatellite;
    const pos = ps && typeof ps.getPosition === 'function' ? ps.getPosition() : (ps && ps.position) || null;
    const quat = (ps && ps.quaternion) || null;
    const hinted = hintArmId != null ? this.arms.find((a) => a && a.id === hintArmId) : null;
    if (hinted && hinted.restoreHeldCatch(debris, pos, quat)) return hinted.id;
    const idx = suggestCargoArm(this, ps, debris.mass, 0, null);
    const arm = idx != null ? this.arms[idx] : null;
    if (arm && arm.restoreHeldCatch(debris, pos, quat)) return arm.id;
    return null;
  }

  // arms-auto — the daughter arms mostly move themselves (DECISIONS §25 ruling 5)

  /**
   * Hand the once-per-player record to the automation (main.js, next to setDebrisField).
   * No store (tests, a bare boot) → the full-range show never runs.
   * @param {import('../systems/StrutAuto.js').StrutAutoStore|null} store
   */
  setStrutAutoStore(store) { this._strutAutoStore = store || null; }

  /**
   * Per frame, after the launch gates: run the StrutAuto controller over this manager's state. Inert unless
   * FEATURE_FLAGS.STRUT_AUTO and a debris field is wired (production wires it; the bare mocks of most tests never do).
   * @param {number} dt — frame delta, s
   */
  _updateStrutAuto(dt, paused = false) {
    if (!this._strutAuto) return;                  // bare Object.create(ArmManager.prototype) test objects
    if (paused) { this._strutAuto.suspend(); return; }   // menu / briefing / shop: no show, no auto moves
    if (!this._strutAutoView) this._strutAutoView = this._buildStrutAutoView();
    this._strutAuto.update(dt, this._strutAutoView);
  }

  _buildStrutAutoView() {
    const self = this;
    const CN = Constants.CAPTURE_NET;
    const ST = CN.STATES;
    const OVER = new Set([ST.FOLDED, ST.STOWED, ST.MISSED, ST.RELEASED]);
    const motherNets = () => {
      const cns = self.playerSatellite && self.playerSatellite._captureNetSystem;
      const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
      return nets ? nets.filter((n) => n && n._isMother) : [];
    };
    return {
      get arms() { return self.arms; },
      get headless() { return !(self.playerSatellite && self.playerSatellite.strutGroups); },
      get store() { return self._strutAutoStore; },
      inert() {
        const p = self.playerSatellite;
        return Constants.FEATURE_FLAGS.STRUT_AUTO !== true
          || !self._debrisField
          || !!(p && p.safeMode)
          || !!(p && typeof p._danceDrivesMe === 'function' && p._danceDrivesMe());
      },
      busy() {
        if (self._pendingLaunches && self._pendingLaunches.size > 0) return true;
        if (self._leanAsideActive) return true;
        // the autopilot's pre-turn swings a docked strut for the shot and holds it there until a launch or a cancel
        const ap = self._autopilot;
        if (ap && typeof ap.isPreturning === 'function' && ap.isPreturning()) return true;
        for (const a of self.arms) {
          if (!a) continue;
          if (a._aimReserved) return true;
          if (a.state === ARM_STATES.LAUNCHING || a.state === ARM_STATES.UNDOCKING) return true;
        }
        const ld = self.playerSatellite && self.playerSatellite.leashDriver;
        return !!(ld && typeof ld.isActive === 'function' && ld.isActive());
      },
      catchActive() {
        const ld = self.playerSatellite && self.playerSatellite.leashDriver;
        if (ld && typeof ld.isActive === 'function' && ld.isActive()) return true;
        return motherNets().some((n) => !OVER.has(n.state));
      },
      netInFlight() {
        const cns = self.playerSatellite && self.playerSatellite._captureNetSystem;
        const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : [];
        return nets.some((n) => n && !OVER.has(n.state));
      },
      inboundNetRadiusM() { return _inboundMotherNetRadiusM(self); },
      duck(radiusM) { self._duckFoulingStruts(radiusM); },
      pressCount() { return self._strutPress | 0; },
      nearestPieceM() { return self._nearestFreePieceM(); },
      gapAt(arm, alphaRad) { return self._strutGapAt(arm, alphaRad); },
      say(text) {
        eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' });
      },
    };
  }

  /**
   * Metres to the nearest discovered, free (not netted, not pinned) piece within the "leave" ring
   * (NET_LOCK_RANGE_M x STRUT_AUTO.LEAVE_FACTOR) of the ship; Infinity when none. Always re-filtered by distance: a
   * same-frame call can hand back a cached larger set.
   * @returns {number}
   */
  _nearestFreePieceM() {
    const df = this._debrisField;
    const p = this.playerSatellite;
    if (!df || typeof df.getDebrisNear !== 'function' || !p) return Infinity;
    const pos = p.position || (p.mesh && p.mesh.position);
    if (!pos) return Infinity;
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    const reachM = Constants.NET_LOCK_RANGE_M * V.LEAVE_FACTOR;
    const list = df.getDebrisNear(pos, reachM * M) || [];
    let best = Infinity;
    for (const d of list) {
      if (!d || d.alive === false || d._disposed) continue;     // a disposed piece is no catch to be near
      // canonical flag: the frame cache can hold pre-reveal snapshots (main.js does the same)
      const live = typeof df.getDebrisById === 'function' ? df.getDebrisById(d.id) : null;
      const src = live || d;
      if (src.discovered === false) continue;
      if (src._captured || src._armPinned || src._capturedByArm) continue;
      const m = typeof d.distance === 'number' ? d.distance / M : Infinity;
      if (m <= reachM && m < best) best = m;
    }
    return best;
  }

  /** Show safety net: clearance (m) of arm `arm`'s strut + daughter at sweep angle `alphaRad` against the ship (thin strut capsule
   * plus a daughter sphere). Infinity when there is no keep-out (mock ship). Own strut/daughter/rack are ignored. */
  _strutGapAt(arm, alphaRad) {
    const ko = this.getKeepOut();
    const i = this.arms.indexOf(arm);
    if (!ko || i < 0) return Infinity;
    const V5 = Constants.OCTOPUS_V5;
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const d = strutLocalDirection(alphaRad, az, new THREE.Vector3());
    const hinge = [Math.cos(az) * V5.COLLAR_RADIUS, Math.sin(az) * V5.COLLAR_RADIUS, V5.COLLAR_Y];
    const L = V5.STRUT_LENGTH;
    const start = [hinge[0] + d.x * 0.30, hinge[1] + d.y * 0.30, hinge[2] + d.z * 0.30];
    const tip = [hinge[0] + d.x * L, hinge[1] + d.y * L, hinge[2] + d.z * L];
    const ignore = ['dau' + i, 'strut' + i, 'rack catch ' + i];
    const rStrut = (V5.STRUT_TUBE_OD ?? 0.05) / 2 + 0.03;
    const a = ko.segment(start, tip, rStrut, { ignore });
    const b = ko.sphere(tip, 0.13, { ignore });
    return Math.min(a.gap, b.gap);
  }

  dispose() {
    for (const arm of this.arms) {
      arm.dispose();
    }
    this.arms = [];
  }

  // Launch line: nothing is fired into a part of the ship. Every launch path (ceremony, key D by index, free-fly, trawl,
  // fan-out, dual fire) goes through `_launchArm` → `requestClearLaunch`. The line is the daughter's body swept 15 m along
  // the direction she will fire, checked against the ship's REAL triangles (ShipKeepOut). Known limit: the line is not
  // re-checked during the 1.5 s magnetic-clamp hold before the spring fires (CROSSBOW_UNDOCK_TIME): a strut moved in
  // that window is not caught.

  /**
   * One ShipKeepOut for this manager's ship (lazy). Null when there is no real ship (bare-ArmUnit tests, mock ships): the
   * launch gate is then a no-op.
   *
   * Held-catch obstacles come through `setSphereProvider`: the nose catch (CaptureNet BERTHED/COLLARED/TRANSFERRING) at its
   * REAL radius `sizeMeter / 2` + 0.05 m of net margin, NOT the 2 m readability floor (`MOTHER_CATCH_MIN_RENDER_M` is a
   * drawing floor, Ruling 0: physically real), and every daughter's parked rack (`heldSlotWorldInto`). Tip bags join by
   * extending `_heldCatchSpheres` (push `{ c: [x,y,z] ship metres, r, name, cat: 'catch' }`) or by calling
   * `getKeepOut().setSphereProvider(fn)` with a wrapper that must also return `this._heldCatchSpheres()`.
   * @returns {ReturnType<typeof createShipKeepOut>|null}
   */
  getKeepOut() {
    const p = this.playerSatellite;
    if (!p || typeof p.updateWorldMatrix !== 'function' || typeof p.traverse !== 'function') return null;
    if (!this._keepOut || this._keepOutShip !== p) {
      this._keepOut = createShipKeepOut({ player: p, armManager: this });
      this._keepOutShip = p;
      this._keepOut.setSphereProvider(() => this._heldCatchSpheres());
    }
    return this._keepOut;
  }

  /**
   * Held catches as keep-out spheres in the SHIP frame, metres (called by the keep-out once per query, after it has
   * brought the matrices up to date).
   * @returns {Array<{c:number[], r:number, name:string, cat:string}>}
   */
  _heldCatchSpheres() {
    const out = this._catchSpheres || (this._catchSpheres = []);
    out.length = 0;
    const p = this.playerSatellite;
    if (!p || !p.matrixWorld) return out;
    const inv = this._koInv || (this._koInv = new THREE.Matrix4());
    const v = this._koVec || (this._koVec = new THREE.Vector3());
    inv.copy(p.matrixWorld).invert();
    const push = (worldScene, radiusM, name) => {
      v.copy(worldScene).applyMatrix4(inv).multiplyScalar(1 / M);
      out.push({ c: [v.x, v.y, v.z], r: radiusM, name, cat: 'catch' });
    };

    const CN = Constants.CAPTURE_NET;
    const cns = p._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (nets && CN && CN.STATES) {
      const S = CN.STATES;
      for (const net of nets) {
        if (!net || !net._isMother) continue;
        if (net.state !== S.BERTHED && net.state !== S.COLLARED && net.state !== S.TRANSFERRING) continue;
        const d = net.targetDebris;
        if (!d || !d._scenePosition) continue;
        push(d._scenePosition, (d.sizeMeter || 2) / 2 + 0.05, 'nose catch');
      }
    }

    // Bags held on the radiator tips. Raw bag radius, no net margin: the measured hand-off clearances
    // (tmp/probes/leash/multi2) are against the bag itself.
    const tc = p.tipCargo;
    if (tc && typeof tc.count === 'function' && tc.count() > 0) {
      for (const sp of tc.spheres()) {
        out.push({ c: [sp.c.x, sp.c.y, sp.c.z], r: sp.r, name: `tip bag ${sp.name.split('_')[1]}`, cat: 'catch' });
      }
    }

    const slot = this._koSlot || (this._koSlot = new THREE.Vector3());
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      const held = arm && arm.heldCatches;
      if (!held || held.length === 0 || typeof arm.heldSlotWorldInto !== 'function') continue;
      for (let k = 0; k < held.length; k++) {
        const d = held[k];
        if (!d) continue;
        const size = d.sizeMeter || 1;
        // The sphere sits where the piece IS (its cell on her, not a slot in a hold axis); its radius is the drawn reach from
        // that point (true size), not sizeMeter / 2. During the 1 s cell-1 → cell-0 slide it is where the piece is drawn NOW.
        if (!(d._rackSlide && typeof arm.heldDrawnWorldInto === 'function' && arm.heldDrawnWorldInto(d, slot, p.quaternion))) {
          arm.heldSlotWorldInto(k, size, p.position, slot, d, p.quaternion);
        }
        push(slot, DebrisField.trueReachM(d, size) + 0.05, `rack catch ${i}`);
      }
    }
    return out;
  }

  /** Ship-frame unit vector: origin → strut tip of `arm` (what free-fly / trawl fire along). */
  _dockDirShip(arm) {
    return arm.dockOffset.clone().normalize();
  }

  /** Ship-frame unit vector along the arm's CURRENT strut (what deploy() fires along after the aim ceremony). */
  _strutDirShip(arm) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    return strutLocalDirection(arm.getAimAlpha(), az, new THREE.Vector3()).normalize();
  }

  _worldToShipDir(vec) {
    const q = this.playerSatellite && this.playerSatellite.quaternion;
    const out = new THREE.Vector3(vec.x, vec.y, vec.z);
    if (q) out.applyQuaternion(q.clone().invert());
    return out.normalize();
  }

  /**
   * The direction `ArmUnit.deploy(target)` will fire along, in the ship frame: the converged strut after an aim ceremony,
   * else the bearing to the target, else the dock direction.
   */
  _launchDirShip(arm, target) {
    const tp = target && target._scenePosition;
    if (!tp) return this._dockDirShip(arm);
    if (arm._aimConverged) return this._strutDirShip(arm);
    return this._worldToShipDir(new THREE.Vector3(tp.x - arm.position.x, tp.y - arm.position.y, tp.z - arm.position.z));
  }

  _trawlDirShip(arm, direction) {
    return direction ? this._worldToShipDir(direction) : this._dockDirShip(arm);
  }

  _launchTargetOrFree(arm, target, opts) {
    return target
      ? this._launchArm(arm, 'target', () => this._launchDirShip(arm, target), () => arm.deploy(target), opts, target)
      : this._launchArm(arm, 'freefly', () => this._dockDirShip(arm), () => arm.deployFreefly(), opts);
  }

  /**
   * The ONE seam every ArmManager launch call site goes through.
   * @param {ArmUnit} arm
   * @param {string} mode — 'ceremony' | 'target' | 'freefly' | 'trawl' (for diagnostics)
   * @param {() => THREE.Vector3} getDirShip — fire direction in the SHIP frame, re-derived each call
   * @param {() => boolean} fire — the real ArmUnit call
   * @param {{announce?: boolean}} [opts] — see `deployArmByIndex`
   * @param {object|null} [target] — the piece this launch is for (modes 'target' / 'ceremony'). It is hers from the request
   *   until the spring fires; if it was caught or taken by then she stays docked and says so.
   * @returns {boolean} true when the launch fired or was accepted (deferred); false when refused
   */
  _launchArm(arm, mode, getDirShip, fire, opts, target = null) {
    const i = this.arms.indexOf(arm);
    if (i < 0) return !!fire();
    const claimed = (mode === 'target' || mode === 'ceremony') && target ? target : null;
    arm._claimTarget = claimed;
    const guarded = !claimed ? fire : () => {
      const why = this._releaseBlock(arm, claimed);
      if (why) {
        arm._claimTarget = null;
        this._sayWarn(launchDroppedLine(arm.displayName, why));
        return false;
      }
      // At the spring: the strut was picked for the ship as it stood; the autopilot or an aim may have turned her since
      // (measured in the real game, Shift+A: clear when picked, crossing a few frames later). Her line is judged again now,
      // with the strut at its final angle. Her own waiting entry is not a line (_lineSet leaves `arm` out).
      const crossed = this._crossingArm(arm, claimed);
      if (crossed) {
        arm._claimTarget = null;
        this._sayWarn(launchCrossDroppedLine(arm.displayName, crossed.displayName));
        return false;
      }
      return fire();
    };
    return this.requestClearLaunch(i, getDirShip, guarded, mode, opts);
  }

  /**
   * Capsule from the daughter's body centre along `dirShip` for 15 m, radius = her own half-width across that direction
   * (measured from her mesh), ignoring herself, her strut and her own rack. Reports every part the capsule touches.
   * @param {number} armIndex
   * @param {{x:number,y:number,z:number}|number[]} dirShip — ship frame, need not be unit
   * @param {{alsoIgnore?: string[], centre?: number[], halfWidth?: number}} [opts] alsoIgnore: more parts to ignore (the
   *   partner's strut and body); centre: the body's centre (ship metres) when the daughter is not yet where the line starts;
   *   halfWidth: when known (measuring the mesh costs half a millisecond)
   * @returns {{blocked:boolean, part:string, cat:string, name:string, hits:Array<{name:string,cat:string,gap:number}>}}
   */
  launchLineBlocked(armIndex, dirShip, opts) {
    const none = { blocked: false, part: '', cat: '', name: '', hits: [] };
    const ko = this.getKeepOut();
    const arm = this.arms[armIndex];
    if (!ko || !arm || !dirShip) return none;
    const raw = Array.isArray(dirShip) ? dirShip : [dirShip.x, dirShip.y, dirShip.z];
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    if (!(len > 1e-9)) return none;
    const d = [raw[0] / len, raw[1] / len, raw[2] / len];

    const body = opts && opts.centre && opts.halfWidth > 0 ? { n: 1, centre: opts.centre, halfWidth: opts.halfWidth } : ko.measureCat('dau' + armIndex, d);
    let c, r;
    if (body.n > 0) {
      c = (opts && opts.centre) || body.centre; r = body.halfWidth;
    } else {                                   // no mesh to measure: tip + table size
      c = (opts && opts.centre) || [arm.dockOffset.x / M, arm.dockOffset.y / M, arm.dockOffset.z / M];
      r = Math.max(...(arm.config.bodyDims || [0.4])) / 2;
    }
    const L = 15;
    const res = ko.segment(c, [c[0] + d[0] * L, c[1] + d[1] * L, c[2] + d[2] * L], r, {
      hits: true,
      ignore: ['dau' + armIndex, 'strut' + armIndex, 'rack catch ' + armIndex, ...((opts && opts.alsoIgnore) || [])],
    });
    if (!res.hits || res.hits.length === 0) return none;
    const h = res.hits[0];
    return { blocked: true, part: this._plainPart(h), cat: h.cat, name: h.name, hits: res.hits };
  }

  /**
   * Would either launch line of the pair, along strut angle `alpha`, be blocked by a part of the ship as it is now? The
   * barrier asks the same of the same lines and refuses; the finder asks first, so no pair is offered that the barrier
   * would refuse. The daughters are not at `alpha` yet, so each line starts at the strut tip for `alpha` (measured within
   * 0.04 m of her body's centre at every angle) and the partner's own strut and body are ignored (at the barrier both
   * stand at `alpha`).
   * @returns {{arm: object, part: string}|null} the first blocked line, or null when both are clear
   */
  pairLineBlockedAt(armA, armB, alpha) {
    for (const [arm, other] of [[armA, armB], [armB, armA]]) {
      const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
      const d = strutLocalDirection(alpha, az, new THREE.Vector3()).normalize();
      const dp = this._dockPositions && this._dockPositions[arm.index];
      const tip = dp ? strutTipMeters(dp, alpha) : null;
      // her half-width across the line: measured once per keep-out (0.13-0.14 m at every angle) and kept: the mesh walk was half the cost of a look
      const ko = this.getKeepOut();
      let cache = this._pairBodyR;
      if (!cache || cache.ko !== ko) cache = this._pairBodyR = { ko, r: new Map() };
      let hw = cache.r.get(arm.index);
      if (hw === undefined && ko) { const m = ko.measureCat('dau' + arm.index, d); hw = m.n > 0 ? m.halfWidth : 0; cache.r.set(arm.index, hw); }
      const v = this.launchLineBlocked(arm.index, d, { alsoIgnore: ['dau' + other.index, 'strut' + other.index], centre: tip ? [tip.x, tip.y, tip.z] : undefined, halfWidth: hw || undefined });
      if (v.blocked) return { arm, part: v.part };
    }
    return null;
  }

  _plainPart(h) {
    const cat = (h && h.cat) || '';
    if (cat === 'wing') return 'a solar wing';
    if (cat === 'rad') return 'a radiator';
    if (cat === 'catch') return /^nose catch/.test(h.name || '') ? 'the catch at the nose' : 'a held catch';
    if (/^(strut|dau)\d+$/.test(cat)) return 'another strut';
    return 'the hull';
  }

  /**
   * Can the blockers on arm `i`'s line be moved out of the way by opening struts to the open angle (90°)? Two cures:
   *   - another strut/daughter in the line: that arm is DOCKED, not held by the lean-aside duck, and not already at the
   *     open angle → open IT;
   *   - anything else (hull, nose, radiator, wing, held catch): the launching strut is below the open angle (the 0° park)
   *     → open IT, since the line is re-derived from the open pose. If the part is STILL in the way once the strut has
   *     arrived (own strut no longer movable), the launch is refused with that part's line.
   * Opening the own strut for more than the hull follows owner 2026-10-14: "open ... struts to 90 or as needed", and the
   * measured park geometry (a 0° strut's line crosses folded radiators too).
   */
  _launchVerdict(i, dirShip, mode) {
    const res = this.launchLineBlocked(i, dirShip);
    if (!res.blocked) return { blocked: false, fixable: true, open: [], openOwn: false, part: '', cat: '', hits: [] };
    const arm = this.arms[i];
    const openAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
    const tol = DEG2RAD;
    const lean = this._leanAsideArmIndices;
    const ownLive = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : openAlpha;
    // A ceremony launch fires along the strut she has just aimed: her own strut is never moved for it (a wing, radiator,
    // catch or the hull in that line refuses). An aimed launch may open her own strut toward 90° from EITHER side
    // (e.g. 170° → 90°); otherwise only from below.
    const ownOffOpen = this._aimsStrut(mode) ? Math.abs(ownLive - openAlpha) > tol : ownLive < openAlpha - tol;
    const ownMovable = mode !== 'ceremony' && ownOffOpen && !lean.has(i)
      && typeof arm.setAimAlpha === 'function';
    const open = new Set();
    let openOwn = false;
    let stuck = null;
    for (const h of res.hits) {
      const m = /^(strut|dau)(\d+)$/.exec(h.cat);
      const n = m ? +m[2] : -1;
      const o = n >= 0 ? this.arms[n] : null;
      if (o && n !== i && o.state === ARM_STATES.DOCKED && !lean.has(n)
          && typeof o.getAimAlpha === 'function' && Math.abs(o.getAimAlpha() - openAlpha) > tol) {
        open.add(n);
      } else if (ownMovable) {
        openOwn = true;
      } else if (!stuck) {
        stuck = h;
      }
    }
    const shown = stuck || res.hits[0];
    return {
      blocked: true, fixable: !stuck, open: [...open], openOwn,
      part: this._plainPart(shown), cat: shown.cat, name: shown.name, hits: res.hits,
    };
  }

  _openForLaunch(i, verdict) {
    const openAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
    for (const n of verdict.open) {
      const o = this.arms[n];
      if (o && o.state === ARM_STATES.DOCKED && !this._leanAsideArmIndices.has(n)) o._strutTargetAlpha = openAlpha;
    }
    if (verdict.openOwn) {
      const a = this.arms[i];
      if (a && !this._leanAsideArmIndices.has(i)) {
        a._strutTargetAlpha = openAlpha;
        const p = this._pendingLaunches && this._pendingLaunches.get(i);
        if (p) p.openedOwn = true;
      }
    }
  }

  _launchHeld(i, verdict, reason) {
    const arm = this.arms[i];
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch held: ${verdict.part} is in the way.`, priority: 'warning',
    });
    eventBus.emit(Events.ARM_LAUNCH_HELD, {
      armIndex: i, armId: arm ? arm.id : null, part: verdict.part, cat: verdict.cat, reason,
    });
  }

  /**
   * Drop a launch the keep-out gate is holding (the player's arrow key: AutopilotSystem._launchHoldManualRotate).
   * @param {number} i — arm index
   * @returns {boolean} true if one was waiting
   */
  cancelPendingLaunch(i) {
    const had = !!(this._pendingLaunches && this._pendingLaunches.has(i));
    if (had) this._dropPendingLaunch(i);
    return had;
  }

  /**
   * Is HER launch still on its way, with her not yet off the dock? True from the moment DEPLOY is accepted (the mother
   * turns for her: she holds `_aimReserved`, `_deployWithCeremony`; or the keep-out gate / strut aim holds her: an entry in
   * `_pendingLaunches`) until she leaves DOCKED. Read only: changes nothing.
   * @param {number} i - arm index
   * @returns {boolean}
   */
  isLaunchPending(i) {
    const arm = this.arms[i];
    if (!arm || arm.state !== ARM_STATES.DOCKED) return false;
    return arm._aimReserved === true || !!(this._pendingLaunches && this._pendingLaunches.has(i));
  }

  /** Forget a pending launch and give back the arm reservation we took. */
  _dropPendingLaunch(i) {
    const pend = this._pendingLaunches;
    const p = pend && pend.get(i);
    if (!p) return;
    pend.delete(i);
    const arm = this.arms[i];
    if (arm && p.reservedByUs) arm._aimReserved = false;
    // a launch cancelled mid-swing stops the strut where it is (the latch is ours if it still holds our angle)
    if (arm && p.stage === 'aim' && arm._strutTargetAlpha === p.aimAlpha) arm._strutTargetAlpha = undefined;
  }

  /**
   * Gate a launch on a clear line. Clear → `fire()` now. Blocked only by what opening struts can clear → open them, keep
   * ONE pending launch (arm reserved) that re-checks every update() and fires when clear, giving up after 8 s. Any other
   * blocker → no fire. With no real ship the gate is a no-op. A checker error fails OPEN (the launch fires): a broken
   * check must not strand the fleet.
   * @param {number} armIndex
   * @param {() => THREE.Vector3} getDirShip — ship-frame fire direction, re-derived every check
   * @param {() => boolean} fire — the real ArmUnit call
   * @param {string} [mode] — launch mode ('ceremony' never moves her own strut)
   * @param {{announce?: boolean}} [opts] — `announce`: the number-key launch; if the aim stage holds it back, it
   *   announces itself (the cut-scene start) when it fires.
   * @returns {boolean} fired, or accepted and waiting (true); refused (false)
   */
  requestClearLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // no launch while the ship burns to the next field
    const arm = this.arms[armIndex];
    if (!arm || !this.getKeepOut()) return !!fire();
    const pend = this._pendingLaunches || (this._pendingLaunches = new Map());
    if (pend.has(armIndex)) return true;

    // One driver per strut: the D-key ceremony reserves her while it aims, and a second launch request would swing her
    // strut under it (the ceremony fires along the strut it converged on).
    if (Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true && mode !== 'ceremony' && arm._aimReserved) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${arm.displayName} is already aiming.`, priority: 'warning' });
      return false;
    }

    // Swing the strut toward where she is going first, then check the line along it.
    if (this._aimsStrut(mode)) {
      const r = this._requestAimedLaunch(armIndex, getDirShip, fire, mode, opts);
      if (r !== undefined) return r;                    // undefined = could not aim: the plain gate below
    }

    let v;
    try {
      const dir = getDirShip();
      v = dir ? this._launchVerdict(armIndex, dir, mode) : { blocked: false };
    } catch (err) {
      if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-line check failed; launching unchecked:', err); }
      v = { blocked: false };
    }
    if (!v.blocked) return !!fire();
    if (!v.fixable) { this._launchHeld(armIndex, v, 'blocked'); return false; }

    const reservedByUs = !arm._aimReserved;
    arm._aimReserved = true;
    pend.set(armIndex, { armIndex, getDirShip, fire, mode, t: 0, stateTimer: arm.stateTimer || 0, reservedByUs });
    this._openForLaunch(armIndex, v);
    return true;
  }

  /**
   * Per-update tick for launches the gate is holding: cancel when the arm has left DOCKED (or was reset), safe mode
   * started, or the arm bus is off; fire when the line is clear; keep the needed struts opening; give up after 8 s or as
   * soon as the remaining blocker is one opening cannot clear.
   * @param {number} dt — frame delta, s
   */
  _updateLaunchGates(dt) {
    const pend = this._pendingLaunches;
    if (!pend || pend.size === 0) return;
    for (const [i, p] of [...pend]) {
      const arm = this.arms[i];
      // reset() zeroes stateTimer, which otherwise only grows while DOCKED.
      if (!arm || arm.state !== ARM_STATES.DOCKED || (arm.stateTimer || 0) < p.stateTimer - 1e-6) {
        this._dropPendingLaunch(i);
        continue;
      }
      if (this.playerSatellite && this.playerSatellite.safeMode) {
        this._dropPendingLaunch(i);
        eventBus.emit(Events.COMMS_MESSAGE, { text: 'Launch cancelled: safe mode.', priority: 'warning' });
        continue;
      }
      if (powerDistribution.armMultiplier <= 0) {
        this._dropPendingLaunch(i);
        eventBus.emit(Events.COMMS_MESSAGE, { text: 'Launch cancelled: daughter power is off.', priority: 'warning' });
        continue;
      }
      p.t += dt;
      p.stateTimer = arm.stateTimer || 0;
      if (p.stage) { this._tickAimedLaunch(i, p, arm, dt); continue; }
      let v;
      try {
        const dir = p.getDirShip();
        v = dir ? this._launchVerdict(i, dir, p.mode) : { blocked: false };
      } catch (err) { v = { blocked: false }; }
      if (!v.blocked) {
        this._dropPendingLaunch(i);
        // The gate opened her strut to clear her line: it stops where the line cleared, so she never floats off a strut that
        // keeps swinging towards the full-open angle.
        if (p.openedOwn && typeof arm.getAimAlpha === 'function') arm._strutTargetAlpha = arm.getAimAlpha();
        p.fire();
        continue;
      }
      if (!v.fixable) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'blocked'); continue; }
      if (p.t >= 8) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'timeout'); continue; }
      this._openForLaunch(i, v);
    }
  }

  // launch-aim — the strut aims first, then the spring pushes along it (FEATURE_FLAGS.LAUNCH_AIMS_STRUT).
  // Every 'target' / 'freefly' / 'trawl' launch through `requestClearLaunch` first swings the daughter's own strut — at its
  // real motor rate (STRUT_SLEW_RATE, 19.5°/s; the gate's swing is a plain latch slew, no mother's turn paces it), never
  // faster — to the best angle toward where she is going (`bestStrutAlpha`, capped short of a held catch's berth corridor),
  // then checks the launch line ALONG THE STRUT and fires with the push along the strut. Pending entries carry `stage`:
  // 'aim' (swinging; no line verdict — the swing path is not checked: the full 0–180° range is measured clear of the
  // ship's own parts) then 'line' (the gate's open-the-blockers logic, on the strut-axis line). OFF = the plain gate.

  /** Does a launch in `mode` aim the strut first? ('ceremony' already aimed; bare modes keep the plain gate.) */
  _aimsStrut(mode) {
    return Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true
      && (mode === 'target' || mode === 'freefly' || mode === 'trawl');
  }

  /** Radius (m) of the berth corridor of the catch the mother holds or takes in (as the lean-aside duck uses), or null. */
  _heldCatchCorridorRadiusM() {
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (!nets) return null;
    const CN = Constants.CAPTURE_NET;
    let r = null;
    for (const n of nets) {
      if (!n || !n._isMother || AIM_CATCH_HELD_STATES.indexOf(n.state) < 0) continue;
      const d = n.targetDebris;
      if (!d || !d.sizeMeter) continue;                 // unresolved size: never cap (the lean-aside rule)
      const rr = d.sizeMeter / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
      if (r === null || rr > r) r = rr;
    }
    return r;
  }

  /**
   * The strut angle arm `i` should swing to for a launch toward `wantedShip` (ship frame): `bestStrutAlpha`, capped below
   * the first angle (1° steps from her live angle toward it) at which her tip would foul a held catch's berth corridor.
   * Fouling only happens at the high angles, so only an upward swing is capped; if her live angle already fouls, she stays.
   */
  _aimAlphaFor(i, wantedShip) {
    const arm = this.arms[i];
    // bestStrutAlpha(dir exactly along ±z) can return -π (atan2(-0, negative)); |.| is the same strut angle in [0, π].
    const best = Math.min(Math.PI, Math.abs(bestStrutAlpha(wantedShip, Math.atan2(arm.dockOffset.y, arm.dockOffset.x))));
    const radiusM = this._heldCatchCorridorRadiusM();
    const now = arm.getAimAlpha();
    if (radiusM === null || best <= now) return best;
    const step = DEG2RAD;
    let prev = now;
    for (let a = now + step; ; a += step) {
      const at = Math.min(a, best);
      if (this._strutFoulsInboundCorridor(i, radiusM, at)) return prev;
      prev = at;
      if (at >= best) return best;
    }
  }

  /** How much closer (rad) the strut axis at `toAlpha` points to `wantedShip` than at `fromAlpha`. */
  _aimGainRad(arm, wantedShip, fromAlpha, toAlpha) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const w = _aimTmpWanted.copy(wantedShip).normalize();
    const angTo = (alpha) => Math.acos(Math.max(-1, Math.min(1, strutLocalDirection(alpha, az, _aimTmpAxis).dot(w))));
    return angTo(fromAlpha) - angTo(toAlpha);
  }

  /**
   * Fire a launch whose strut is in place: nothing may move her strut while LAUNCHING (clear the latch), and
   * `_aimConverged` tells `deploy()` / `deployFreefly()` / `deployTrawl()` to push along the strut axis (never outlives the call).
   */
  _fireAimed(i, fire) {
    const arm = this.arms[i];
    arm._strutTargetAlpha = undefined;
    arm._aimConverged = true;
    try { return !!fire(); } finally { arm._aimConverged = false; }
  }

  /** The number-key launch fired after waiting to aim: what InputManager emits for an immediate one (the cut-scene start only). */
  _announceLaunch(arm) {
    eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
  }

  _launchHeldAim(i) {
    const arm = this.arms[i];
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch held: ${arm ? arm.displayName : 'daughter'}'s strut could not swing into place.`, priority: 'warning',
    });
    eventBus.emit(Events.ARM_LAUNCH_HELD, {
      armIndex: i, armId: arm ? arm.id : null, part: '', cat: '', reason: 'aim',
    });
  }

  /**
   * `requestClearLaunch` for an aimed mode. Returns true (fired or waiting), false (refused), or undefined when the wanted
   * direction cannot be derived (the caller falls back to the plain gate).
   */
  _requestAimedLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // (see requestClearLaunch)
    const arm = this.arms[armIndex];
    const pend = this._pendingLaunches;
    if (typeof arm.getAimAlpha !== 'function') return undefined;
    let wanted;
    try {
      wanted = getDirShip();
    } catch (err) {
      if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-aim direction failed; using the plain gate:', err); }
      return undefined;
    }
    if (!wanted) return undefined;

    // The dock direction (free-fly; a trawl without a direction) is the ray from the ship's centre through HER OWN strut
    // tip, so it moves whenever her strut moves: following it would chase its own tail (measured: a free-fly launch swung
    // to 155° and took 4-10 s instead of 2-3 s). Freeze it at the request (a ship-frame direction, so ship turns don't move it).
    if (mode === 'freefly' || (opts && opts.frozenAim)) {
      const frozen = wanted.clone();
      getDirShip = () => frozen;
    }

    const now = arm.getAimAlpha();
    const ducked = this._leanAsideArmIndices.has(armIndex);   // the duck owns her latch: never aim a ducked arm
    const aim = ducked ? now : this._aimAlphaFor(armIndex, wanted);
    const needAim = !ducked && Math.abs(aim - now) > AIM_TOL_RAD;
    const swingS = needAim ? Math.abs(aim - now) / Constants.OCTOPUS_V5.STRUT_SLEW_RATE : 0;
    const entry = {
      armIndex, getDirShip, fire, mode, opts: opts || null, t: 0, stateTimer: arm.stateTimer || 0,
      reservedByUs: !arm._aimReserved, stage: needAim ? 'aim' : 'line', aimAlpha: aim,
      aimDir: aim > now ? 1 : -1, reaims: 0,                 // reaims = REVERSALS of the aim so far (see _tickAimedLaunch)
      giveUpAt: swingS + 8,                              // the swing is not part of the 8 s patience
    };

    if (!needAim) {
      let v;
      try {
        v = this._launchVerdict(armIndex, this._strutDirShip(arm), mode);
      } catch (err) {
        if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-line check failed; launching unchecked:', err); }
        v = { blocked: false };
      }
      if (!v.blocked) return this._fireAimed(armIndex, fire);
      if (!v.fixable) { this._launchHeld(armIndex, v, 'blocked'); return false; }
      arm._aimReserved = true;
      pend.set(armIndex, entry);
      this._openForLaunch(armIndex, v);
      return true;
    }

    arm._aimReserved = true;
    arm._strutTargetAlpha = aim;
    pend.set(armIndex, entry);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Daughter ${arm.displayName}: aiming, about ${Math.max(1, Math.ceil(swingS - 1e-9))} s.`, priority: 'info',
    });
    return true;
  }

  /**
   * One tick of a pending aimed launch (the arm is still DOCKED, not cancelled).
   * 'aim': keep the latch on the best angle (the ship may turn, her tip moves as she swings) until she is within 1° of it
   * with the latch cleared (or the duck takes her); 'line': the gate's line logic on the strut-axis line. Gives up at
   * (swing time + 8 s).
   */
  _tickAimedLaunch(i, p, arm, dt) {
    // Headless mocks have no ship strut driver: slew the latch here (a zero-step call must not snap the strut).
    if (dt > 0 && !(this.playerSatellite && this.playerSatellite.strutGroups)
        && arm._strutTargetAlpha !== undefined && typeof arm.setAimAlpha === 'function') {
      arm.setAimAlpha(arm._strutTargetAlpha, dt);
      if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) arm._strutTargetAlpha = undefined;
    }

    if (p.stage === 'aim') {
      if (this._leanAsideArmIndices.has(i)) {
        p.stage = 'line';                               // mid-aim duck: the duck owns her latch; aim ends where she is
      } else {
        let wanted = null;
        try { wanted = p.getDirShip(); } catch (err) { wanted = null; }
        if (wanted) {
          // Her tip (the bearing's origin) and the ship's own turn move the wanted direction, so the best angle drifts:
          // follow it when it moved > 1° AND the move points the strut closer by at least 0.5° and a quarter of the move
          // (stops a flip-flop when the wanted direction is nearly tangential to her swing plane: the best angle then jumps
          // 0 <-> 180° while both are about equally far off; measured, a 46 m target did this for 17 s). A follow-up that
          // keeps the previous move's direction (a ship turning steadily) is free; only a REVERSAL counts toward
          // AIM_MAX_REAIMS, so a flip-flop still ends after 4. Each follow-up adds its swing time to the give-up clock.
          const aim = this._aimAlphaFor(i, wanted);
          const move = Math.abs(aim - p.aimAlpha);
          if (move > AIM_TOL_RAD) {
            const dir = aim > p.aimAlpha ? 1 : -1;
            const reverses = dir !== p.aimDir;
            if ((!reverses || p.reaims < AIM_MAX_REAIMS)
                && this._aimGainRad(arm, wanted, p.aimAlpha, aim) > Math.max(AIM_GAIN_RAD, 0.25 * move)) {
              if (reverses) p.reaims++;
              p.aimDir = dir;
              p.aimAlpha = aim;
              p.giveUpAt += move / Constants.OCTOPUS_V5.STRUT_SLEW_RATE;
            }
          }
        }
        if (Math.abs(arm.getAimAlpha() - p.aimAlpha) > AIM_TOL_RAD) {
          arm._strutTargetAlpha = p.aimAlpha;           // (re)assert: another writer may have replaced the latch
        }
        if (arm._strutTargetAlpha === undefined && Math.abs(arm.getAimAlpha() - p.aimAlpha) <= AIM_TOL_RAD) {
          p.stage = 'line';
        } else if (p.t >= p.giveUpAt) {
          arm._strutTargetAlpha = undefined;
          this._dropPendingLaunch(i);
          this._launchHeldAim(i);
          return;
        }
      }
      if (p.stage === 'aim') return;
    }

    // line stage: the launch line is the strut axis from her tip.
    let v;
    try {
      v = this._launchVerdict(i, this._strutDirShip(arm), p.mode);
    } catch (err) { v = { blocked: false }; }
    if (!v.blocked) {
      this._dropPendingLaunch(i);
      if (this._fireAimed(i, p.fire) && p.opts && p.opts.announce) this._announceLaunch(arm);
      return;
    }
    if (!v.fixable) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'blocked'); return; }
    if (p.t >= p.giveUpAt) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'timeout'); return; }
    this._openForLaunch(i, v);
  }
}
