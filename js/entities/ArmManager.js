/**
 * ArmManager.js — Manages the V5 Crossbow arm fleet
 * Config G top-collar 3-plane layout (ST-9.2).
 * Tier-aware: Y0 Quad (4), Y1 Hex (6), Y3 Octo (6 ring + 2 end-face).
 * Arms hinge at top collar (Y = +1.00 m), sweep 0–180° in meridian planes.
 * Coordinates deployments, recalls, dual-fire, pulse scan, and provides status for HUD.
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
import { armProfile, profileClearAt, profileValid, startProfile, stepProfile, kitFor, kitStep } from '../systems/HoldWingClear.js';
// Nets step 3 slice 5 (lane 5b): a pending BIG piece leaves the ledger when its rack drops it (reset), and is never 'paid' for the unload.
import { bigPieces } from '../systems/BigPieces.js';
import { strutTipFoulsCorridor, strutLocalDirection, bestStrutAlpha } from './ArmDockBasis.js';
import { createShipKeepOut } from '../systems/ShipKeepOut.js';
import { StrutAutoController } from '../systems/StrutAuto.js';
import { reseatOrbitFromScene } from './OrbitalMechanics.js';
import { ArmUnit, planeTurnLeftRad } from './ArmUnit.js';
import { DebrisField } from './DebrisField.js';
import { clearRackCell, berthAnchorLocalInto, catchHomeDistM, homeShapeKey } from './CaptureNet.js';
import { noseBucketFor, noseRadiatorsOk, noseWindowSpans } from './NoseRoute.js';
import { tripRefuses } from '../systems/TransferTrip.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import {
  pieceClaim, isFree, linesCross, lineWrapsShip, samePiece, pieceIsCaught,
  launchRefusalLine, crossNamedStrutLine, crossNoneClearLine, launchDroppedLine, launchCrossDroppedLine, wrapRefusalLine,
  fanOutLine, fanOutNoneLine, stayedLine, reachNoneLine, heavyNoneLine, holdsStillLine, netIsOut,
} from '../systems/PieceClaim.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, engineGasLowFrac, coldGasPoolToKg } from '../systems/ResourceSystem.js';

/** 1 meter in scene units */
const M = 0.00001;
/** A daughter's ion fuel is a percentage; the Daughter Fuel Reserve upgrade lifts a full tank to 150 %. A saved level is clamped to this. */
const SUPPLY_FUEL_MAX_PCT = 200;

// reel-home scratch
const _rhInvQ = new THREE.Quaternion();
const _rhGapA = new THREE.Vector3();
const _rhGapB = new THREE.Vector3();
const _rhAxisR = new THREE.Vector3();
const _rhTurnP = new THREE.Vector3();      // reel-turn: her place in the ship's frame, from the ship's centre
const _rhTurnQ = new THREE.Quaternion();

// Task 7 (opening-dance plan) — bounded safety-net release. LASSO_CAPTURED's
// own downstream adoption (CaptureNetSystem.adoptLassoCatch) deliberately
// does not emit NET_BERTHED (its doc comment: "none of the spectacle"), so a
// ducked arm on that path never sees the plan's own release event. This
// timeout (comfortably longer than the duck sweep AND the lasso's own
// ~3 s reel-in) guarantees a duck can never strand a strut ducked forever,
// regardless of which capture path resolved it. Not a plan requirement —
// see the lane's final report.
const LEAN_ASIDE_TIMEOUT_S = 8;

/** net-duck D4: how long a daughter waits for her neighbours' lift before she gives up (s), and how often she asks `carryCheck` while she does. */
const LIFT_WAIT_MAX_S = 20;
const LIFT_POLL_S = 0.25;

const _aimTmpWanted = new THREE.Vector3();
const _aimTmpAxis = new THREE.Vector3();
/** launch-aim: the aim stage counts a strut as "in place" within 1° of the best angle. */
const AIM_TOL_RAD = Math.PI / 180;
/** launch-aim: a new best angle replaces the one she is swinging to only if it points the strut this much closer (rad, 0.5°). */
const AIM_GAIN_RAD = 0.5 * Math.PI / 180;
/** launch-aim: how many times the aim stage may REVERSE its aim (follow a best angle that flipped back) before it commits. */
const AIM_MAX_REAIMS = 4;
/** launch-aim: catch states in which the mother holds (or is taking in) a catch whose berth corridor a strut must not enter. */
const AIM_CATCH_HELD_STATES = ['CINCH_CLOSING', 'SECURE_CHECK', 'CAPTURED', 'REELING', 'BERTHED', 'COLLARED', 'TRANSFERRING'];

/** The "." toggle's live sweep read (InputManager.js Period case, mirrored
 *  for toggleStruts / strutsDeployed): a pending `_strutTargetAlpha` latch
 *  wins, else the ACTUAL angle — never the latch alone, which clears to
 *  undefined once the slew finishes. @private */
const _strutLiveAlpha = (a) =>
  a._strutTargetAlpha ?? (a.getAimAlpha ? a.getAimAlpha() : 0);

/**
 * reel-hold (2026-10-23): the turn (rad, signed; turning the ship by +t moves her angle by +t) that brings a daughter's angle in
 * her strut's swing plane inside the strut's range [STRUT_MIN_DEG, STRUT_MAX_DEG]; 0 when she is inside it. `v` is the
 * direction hinge -> her, ship-local, `az` the strut's azimuth. The ONE piece of maths the mother's floor turn
 * (`_tickReelHomeTurn`) and the hold that waits for it (`reelHoldReason`) both read, so they never disagree.
 * @param {{x:number,y:number,z:number}} v
 * @param {number} az
 * @param {object} RH Constants.REEL_HOME
 * @returns {number}
 */
function _rhFloorTheta(v, az, RH) {
  const D2R = Math.PI / 180;
  const lo = (RH.STRUT_MIN_DEG ?? 34) * D2R;
  const hi = (RH.STRUT_MAX_DEG ?? 180) * D2R;
  const phi = Math.atan2(v.x * Math.cos(az) + v.y * Math.sin(az), -v.z);   // her angle in the strut's plane
  if (phi >= lo && phi <= hi) return 0;                                       // the strut can point at her
  const wrap = (x) => { while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };
  const toLo = wrap(lo - phi);
  const toHi = wrap(hi - phi);
  return Math.abs(toLo) <= Math.abs(toHi) ? toLo : toHi;
}

/**
 * reel-hold F4: the first strut angle (deg) from `startDeg` on the `stepDeg` grid, below `hiDeg`, at which `conflictAt(deg)` is false,
 * then `hiDeg` itself LAST (a grid that does not land on it must still try it: the pose cap is a pose too); null = none. The same
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
 * hold-clear (owner 2026-10-23): the key a holder's pose caches read - what she holds, where it sits on her, and whether its wing profile
 * (HoldWingClear) is done, so a pose moves the frame the profile lands.
 * @param {object} arm
 * @returns {string}
 */
function _rackKey(arm) {
  let key = '';
  if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) if (h) key += `${h.id}:${h.sizeMeter}:${h._rackCell}:${h._wingClear ? (h._wingClear.done ? 'd' : 'p') : '-'};`;
  return key;
}

/** hold-clear D2: is her catch `rest`-clear of the radiator wings with her strut at `deg`? True when she has no finished profile (none started, or pending: today's behaviour). */
function _wingRestOk(arm, deg) {
  const p = armProfile(arm);
  return p.state !== 2 || profileClearAt(p, 'rest', deg);
}

/**
 * reel-hold D4/D5 (measured, tmp/plans/reel-hold.md T1): the lowest strut angle (deg, on the 5° hold-pose grid) at which a docked
 * holder's catch of `sizeM` stays out of the radiator wings' way in the band. A table, never a mesh sweep at runtime.
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
 * hold-catch (owner 2026-10-22): the strut angle a daughter holding a catch rests at. The lowest of 34° (STRUT_REST_ALPHA),
 * 39°, 44° ... 99°, then 100° (HOLD_POSE_MAX_DEG), at which her catch is clear of every thruster plume — the exact box check
 * (`heldCargoPlumeConflictAt`) at THAT angle, not the size-ladder floor (`PLUME_CARGO_ALPHA_LADDER` is the worst case over
 * every rack attitude plus 10°, sized for a re-pose from anywhere; a held catch's attitude in her frame is frozen at the stow,
 * so the exact read is the real answer, and it keeps a 1 m catch at 34° where the ladder said 41°). Never above 100°: the
 * mother net's berth corridor is clear of a strut tip for every inbound size up to there. If nothing clears (not seen for
 * catches up to 5 m), 100° with `tooBig`. Pure read; null when she holds nothing. A module function (not a method) so
 * `ArmManager.toggleStruts`, which runs on bare stub objects in tests, can call it without `this.method()`.
 *
 * hold-clear (owner 2026-10-23: "a held catch never touches a radiator wing"): once her catch's wing profile is done a pose must also be
 * `rest`-clear (HoldWingClear: `REEL_HOLD.CLEAR_M` off every radiator part at every wing angle outside the band). When some pose is
 * plume-clear but none is wing-clear the answer is `wingBlocked: true`: she parks at the highest plume-clear pose and the net / C rules
 * take over (`motherNetHolderBlock`, `_radiatorMoveGate`). A profile still pending (`wingPending`) leaves today's plume-only answer.
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
  const D2R = Math.PI / 180;
  const lo = Math.round(V5.STRUT_REST_ALPHA / D2R);
  const hi = V5.HOLD_POSE_MAX_DEG;
  // hold-clear D2: a pose also has to keep her catch `REEL_HOLD.CLEAR_M` off every radiator part at every wing angle outside the band
  // (HoldWingClear `rest`). No finished profile (none started, or still pending) = today's plume-only walk.
  const wp = armProfile(arm);
  const done = wp.state === 2;
  let lastPlumeClear = null;
  for (let deg = lo; deg < hi; deg += V5.HOLD_POSE_STEP_DEG) {
    if (heldCargoPlumeConflictAt(mgr, armIndex, deg * D2R)) continue;
    lastPlumeClear = deg;
    if (!done || profileClearAt(wp, 'rest', deg)) return { rad: deg * D2R, tooBig: false, wingPending: wp.state === 1 };
  }
  if (!heldCargoPlumeConflictAt(mgr, armIndex, hi * D2R)) {
    lastPlumeClear = hi;
    if (!done || profileClearAt(wp, 'rest', hi)) return { rad: hi * D2R, tooBig: false, wingPending: wp.state === 1 };
  }
  // some pose is plume-clear but none keeps her catch clear of the wings: she parks at the highest plume-clear one (never in a plume)
  if (lastPlumeClear !== null) return { rad: lastPlumeClear * D2R, tooBig: false, wingBlocked: true };
  return { rad: hi * D2R, tooBig: true };
}

/**
 * net-duck R7 (CONVENTIONS §10 rule B): the capture-net states in which a mother net's catch is coming home - the ONE set the holder
 * duck, the carry wait and the StrutAuto view (`inboundNetRadiusM`) read, so a state added to the reel is added once.
 */
const _NET_ST = Constants.CAPTURE_NET.STATES;
const INBOUND_NET_STATES = new Set([_NET_ST.CINCH_CLOSING, _NET_ST.SECURE_CHECK, _NET_ST.CAPTURED, _NET_ST.REELING]);

/**
 * net-duck (owner 2026-10-22: "out of the way of mother net"): the radius (m) of the berth corridor of the biggest mother net that is
 * coming home (`INBOUND_NET_STATES`), or null when none is.
 * Read straight from the capture-net system, so it does not depend on StrutAuto running (that controller is inert without a debris field).
 * A net whose catch has no size is not counted ("never duck for a piece this cannot measure", the lean-aside rule); neither is a net
 * that MISSED (R3: a slipped or lost catch reels back empty, in REELING, with nothing to keep a catch clear of). No allocation.
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
const _duckPlanOut = { rad: null, kind: 0 };

/**
 * net-duck D2 + hold-clear D4/D5: the ONE decision of where a holder goes for an inbound net of corridor radius `radiusM`, read by the duck
 * (`_holderDuckRad`, `_duckHolders`) and by the fire check (`ArmManager.motherNetHolderBlock`) so a refusal and a duck never disagree.
 * The pose set: the grid angles below her live angle (34°, 39°, ...), each counting when the net's corridor is clear of her catch there AND one
 * deadband higher (where the strut may stand: found 2026-10-23, R4) and - once her wing profile is done - her catch is also `rest`-clear of the
 * radiator wings there and, while the wings stand in the band or move through it, `band`-clear (`_netDuck` outranks `_radLift` in the writer,
 * so the duck pose itself must be clear). The highest counting pose wins; none counting: the 34° fallback, which counts only if NO pose clears the net (round 1 F4) and 34° is wing-clear.
 * Returns the shared `{rad, kind}`: kind 0 = no duck needed (her catch is clear of the corridor where she is heading, or already at the pose);
 * 1 = duck to `rad`; 2 = some pose clears the net but none is wing-clear (she does not duck; D5 refuses the net); 3 = no pose clears the net at
 * all and 34° is not wing-clear (she does not duck; today's corridor gate holds the net); 4 = her wing profile is pending (skip her this frame).
 * @param {object} mgr
 * @param {number} i
 * @param {number} radiusM
 * @returns {{rad:number|null, kind:number}} shared scratch: read it at once
 */
function _duckPlan(mgr, i, radiusM) {
  const out = _duckPlanOut;
  out.rad = null; out.kind = 0;
  const arm = mgr.arms[i];
  berthAnchorLocalInto(mgr.playerSatellite, 0, _duckAnchor);
  const eff = _strutLiveAlpha(arm);
  if (!mgr._corridorFoulAt(i, eff, radiusM)) return out;
  const V5 = Constants.OCTOPUS_V5;
  const D2R = Math.PI / 180;
  const lo = Math.round(V5.STRUT_REST_ALPHA / D2R);
  const dead = V5.HOLD_POSE_DEADBAND_DEG * D2R;
  const wp = armProfile(arm);
  if (wp.state === 1) { out.kind = 4; return out; }
  const done = wp.state === 2;
  const needBand = done && typeof mgr._wingsInBand === 'function' && (mgr._wingsInBand() || mgr._wingsMovingInBand());
  // a strut stands up to a deadband above its target: the pose and the angle a deadband higher (off the grid: the next grid pose too) must be wing-clear
  // (T1: a deadband changes the clearance by up to -0.032 m; with the next grid pose clear too the worst case over 8758 cells is -0.001 m: no extra margin)
  const deadDeg = V5.HOLD_POSE_DEADBAND_DEG;
  const clearAt = (set, deg) => profileClearAt(wp, set, deg) && profileClearAt(wp, set, deg + deadDeg);
  const wingOk = (deg) => !done || (clearAt('rest', deg) && (!needBand || clearAt('band', deg)));
  let best = null;
  let anyNetClear = false;
  for (let deg = lo; deg * D2R < eff - 1e-6; deg += V5.HOLD_POSE_STEP_DEG) {
    // a strut stands up to the deadband ABOVE its target (found 2026-10-23 probing R4: 54° passed, she stood at 54.5° and the net's
    // corridor gate held the reel its full 8 s): an angle counts only when the angle a deadband higher clears too
    if (mgr._corridorFoulAt(i, deg * D2R, radiusM) || mgr._corridorFoulAt(i, deg * D2R + dead, radiusM)) continue;
    anyNetClear = true;
    if (wingOk(deg)) best = deg * D2R;
  }
  if (best === null) {
    // the 34° fallback is only for a catch that clears the net at no pose at all (round 1 F4): when some pose clears the net but none is
    // wing-clear she must not drop to a 34° that is wing-clear but still fouls the corridor - D5 refuses that net (kind 2) instead
    if (!anyNetClear && wingOk(lo)) best = lo * D2R;
    else { out.kind = anyNetClear ? 2 : 3; return out; }
  }
  if (best < eff - dead) { out.rad = best; out.kind = 1; }
  return out;
}

/**
 * net-duck D2: the angle a holder lowers her strut to for an inbound net of corridor radius `radiusM`: null when her catch is clear of
 * the corridor where she is heading (a pending latch wins, as in `_strutLiveAlpha`), or no wing-clear pose exists (`_duckPlan`); else the
 * HIGHEST counting angle on the hold-pose grid.
 * @param {object} mgr
 * @param {number} i
 * @param {number} radiusM
 * @returns {number|null} radians
 */
function _holderDuckRad(mgr, i, radiusM) {
  return _duckPlan(mgr, i, radiusM).rad;
}

/**
 * net-duck D5: a strut press that arrived while the holder was ducked or lifted waits for it and is then applied as if pressed at
 * that moment. @param {object} mgr @param {object} arm
 */
function _applyQueuedPress(mgr, arm) {
  const q = arm && arm._queuedPress;
  if (!q) return;
  arm._queuedPress = null;
  _pressHolders(mgr, [arm], q.wantRad, q.autoOn, false);
}

/**
 * net-duck R1: forget every mark of the holder duck and the neighbour lift on one arm (reset, an ex-holder). Her strut is not touched:
 * a holder's writer takes her back to her hold pose, and a docked strut is the business of whoever owns docked struts.
 * @param {object} arm
 */
function _clearNetDuckMarks(arm) {
  arm._netDuck = null;
  arm._netDuckLow = false;
  arm._netDuckSaid = false;
  arm._netDuckThrustSaid = false;
  arm._netLift = null;
  arm._radLift = null;                     // reel-hold D4/D8: the lift for the radiator wings, the pose cache, the reel hold and the floor refusal
  arm._radClear = null;
  arm._rhHold = null;
  arm._rhFloorRefused = false;
  arm._rhFloorSpent = false;
  arm._carryWaitLift = null;
  arm._carryRestart = null;
  arm._queuedPress = null;
  arm._netBlock = false;                   // hold-clear D6/D11: the mother net's refusal mark (C is allowed for her), and the lines said for her catch
  arm._holdWingSaid = null;
  arm._duckWingSaid = null;
}

/** net-duck R1: does this arm still HOLD a catch at home (the only daughter a holder duck belongs to)? @param {object} arm */
function _holdsCatchAtHome(arm) {
  return !!arm && !arm.isDetached && arm.state === ARM_STATES.HOLDING_CATCH
    && Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass);
}

/**
 * hold-catch: a "." press on daughters holding catches (called by ArmManager.toggleStruts). The wanted angle is clamped to the
 * hold pose from below (a press that would close her sends her to it) and to HOLD_POSE_MAX_DEG from above; an angle above the
 * pose is taken only when her catch is plume-clear there. Each gets the manual marker, as a docked strut does (StrutAuto keeps
 * it for them and ages it) - only when the press moves her: a press that moves nothing is no override. When it moves nothing and no
 * docked strut was commanded either, `mgr.lastStrutPressNote` says why, in one plain line (`toggleStruts` holds a single tap's line
 * back for the double-press window, see `_pendingStrutNote`).
 * @param {object} mgr
 * @param {object[]} holders
 * @param {number} wantRad
 * @param {boolean} autoOn the STRUT_AUTO flag: the manual marker is only written (and aged) when it is on
 * @param {boolean} onlyThese true: nothing else was commanded, so a press that moves nothing gets its line
 */
function _pressHolders(mgr, holders, wantRad, autoOn, onlyThese) {
  if (!holders.length) return;
  const V5 = Constants.OCTOPUS_V5;
  const dead = V5.HOLD_POSE_DEADBAND_DEG * Math.PI / 180;
  const cap = V5.HOLD_POSE_MAX_DEG * Math.PI / 180;
  let anyMoved = false;
  let stayed = null;
  for (const a of holders) {
    const i = mgr.arms.indexOf(a);
    const hp = _holdPoseOf(mgr, i);
    if (!hp) continue;
    // net-duck D5: while she is ducked for a net or lifted for a neighbour's carry her strut is not hers to move: the press waits
    // for the end of it (the last press wins) and counts as taken (no "stays at ..." line)
    if (a._netDuck || a._netLift) {
      a._queuedPress = { wantRad, autoOn };
      anyMoved = true;
      continue;
    }
    let t = hp.rad;
    // hold-clear D2: an angle above the pose is taken only when it is plume-clear AND `rest`-clear (off the grid: both neighbouring poses)
    if (wantRad > hp.rad + 1e-6 && wantRad <= cap + 1e-6 && !heldCargoPlumeConflictAt(mgr, i, wantRad)
        && _wingRestOk(a, wantRad / (Math.PI / 180))) t = wantRad;
    // where she is heading (a pending latch wins, as for a docked strut): a press that asks for that again moves nothing, and a
    // press that moves nothing is not a manual override (FA4: it left `_strutManual` behind, which later said "back to automatic")
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
    const deg = Math.round(stayed.hp.rad * 180 / Math.PI);
    mgr.lastStrutPressNote = deg <= Math.round(V5.STRUT_REST_ALPHA * 180 / Math.PI)
      ? `Daughter ${n} is holding a catch; her strut stays at ${deg}° to keep it clear of the hull.`
      : `Daughter ${n} is holding a big catch; her strut stays at ${deg}° to keep it clear of the thrusters.`;
  }
}

// V5 Constants (destructured for readability)
const {
  V5_ARM_COUNT, V5_FRONT_ARM_TYPE, V5_BACK_ARM_TYPE,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  DUALFIRE_SYNC_WINDOW, DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  PULSE_SCAN_DURATION, PULSE_SCAN_COOLDOWN, PULSE_SCAN_POWER, PULSE_SCAN_RANGE_MULT,
  CROSSBOW_LAUNCH_SPEED_MIN, CROSSBOW_LAUNCH_SPEED_DEFAULT,
  SPRING_TIERS, TETHER_TIERS,
  ARM_STATES,
} = Constants;

// FIX_PLAN §3: Module-local sets built once — avoids re-allocation per call to getRotationLockTier().
// Any arm in _HIGH_RISK_ROT_STATES with a live tether → tier 'block' (hard displacement limit).
// Any arm in _SOFT_ROT_STATES with a live tether   → tier 'soft' (generous displacement limit).
// DOCKED / RELOADING / EXPENDED / isDetached arms contribute tier 'none'.
const _HIGH_RISK_ROT_STATES = new Set([
  ARM_STATES.NETTING,
  ARM_STATES.GRAPPLED,
  ARM_STATES.STATION_KEEP,
  ARM_STATES.REELING,
  ARM_STATES.HAULING,
  ARM_STATES.RETURNING,
  ARM_STATES.DOCKING,
  ARM_STATES.DEORBITING,
  // trip-melt-2 (carry): she is out on her strut line, flying in her docked attitude — the mother holds still
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);
// Wave1 reel-drum feedback (2026-08-27): arm states where the daughter parks
// AT her strut tip → drum 'ready'. Mirrors ArmUnit._updateTether's hidden-line
// set (DOCKED/DOCKING/RELOADING/HOLDING_CATCH) minus EXPENDED, whose cartridge
// maps to 'empty'. CARRY_PREP is docked too (her line is wound, the strut and radiators are moving); the three
// states where she is out ('deployed') are not listed.
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
  ARM_STATES.CARRY_PREP,           // trip-melt-2: docked, but the strut and radiators are moving
]);
/** trip-melt-2 (carry): the four carry states. A carrying daughter is still part of the ship's books (her mass is aboard,
 *  recall refuses her, her rack catches are pinned to her), but not "home". */
const _CARRY_STATES = new Set([
  ARM_STATES.CARRY_PREP,
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);
/** @param {string} state @returns {boolean} one of CARRY_PREP / OUT / HANDOFF / BACK */
export function isCarryState(state) { return _CARRY_STATES.has(state); }

/**
 * Config G: Generate dock positions for the given arm tier (ST-9.2).
 *
 * Geometry convention (ARM_PIVOT_ANALYSIS.md §10.2 side-view):
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
 * This is the STORED convention (CameraSystem's aim bridge reads
 * `arm._dockOutward` in it: the XZ collar convention). The mass model does NOT consume it raw:
 * CoMCalculator converts these fields to the rendered ship frame (barrel = Z,
 * stowed aft at −Z) at its strutTipMeters/strutMidpointMeters boundary — the
 * Y/Z swap of register item 57 (S13(a)). Do not "fix" this convention; the
 * conversion is deliberate and single-sited.
 *
 * @param {string|number} [tierKeyOrCount='Y0_QUAD'] — tier key or arm count (4/6/8)
 * @returns {Array<{type: string, offset: THREE.Vector3, angle: number, azimuthDeg: number,
 *   dockOutward: THREE.Vector3, swingAxis: THREE.Vector3, hingePosition: THREE.Vector3,
 *   isEndFace: boolean}>}
 */
export function generateDockPositions(tierKeyOrCount) {
  // Resolve tier key
  let tierKey;
  if (typeof tierKeyOrCount === 'number') {
    const ladder = Constants.ARM_LADDER;
    tierKey = Object.keys(ladder).find(k => ladder[k].armCount === tierKeyOrCount) || 'Y0_QUAD';
  } else {
    tierKey = tierKeyOrCount || 'Y0_QUAD';
  }

  const tier = Constants.ARM_LADDER[tierKey] || Constants.ARM_LADDER.Y0_QUAD;
  const V5 = Constants.OCTOPUS_V5;
  const COLLAR_Y = V5.COLLAR_Y;           // 1.00 m
  const COLLAR_RADIUS = V5.COLLAR_RADIUS;  // 0.40 m
  const positions = [];

  // ── Ring arms (from tier azimuth table) ──
  const azimuths = tier.azimuths; // degrees

  for (let i = 0; i < azimuths.length; i++) {
    const azDeg = azimuths[i];
    const theta = azDeg * Math.PI / 180;

    // Hinge XZ on collar perimeter (scene units); Y kept at 0 so that
    // _worldDockDirection (which normalizes dockOffset) stays purely radial.
    const hx = COLLAR_RADIUS * Math.cos(theta) * M;
    const hz = COLLAR_RADIUS * Math.sin(theta) * M;

    // dockOutward: radial outward in XZ plane (deploy direction at α = π/2)
    const outward = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)).normalize();

    // swingAxis: tangent to collar at this azimuth, perpendicular to radial in XZ
    const swingAxis = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta)).normalize();

    // Type alternates weaver/spinner around ring
    const type = i % 2 === 0 ? 'weaver' : 'spinner';

    positions.push({
      type,
      offset: new THREE.Vector3(hx, 0, hz),          // XZ only for backward-compat deploy dir
      angle: theta,
      azimuthDeg: azDeg,
      dockOutward: outward,
      swingAxis,
      hingePosition: new THREE.Vector3(hx, COLLAR_Y * M, hz), // full 3-D hinge
      isEndFace: false,
    });
  }

  // ── End-face arms (Y3 Octo only: +Z and −Z along velocity vector) ──
  // Register item 61 (2026-08-22, owner-ruled "fix the blueprint"): the rows
  // ride the SAME stored convention as the ring — ship Z lives in the stored
  // Y slot (the S13(a) swap) — so hingePosition (0, ±CORE_LENGTH/2, 0)_stored
  // reads (0, 0, ±CORE_LENGTH/2)_ship: ON the barrel axis at the end faces,
  // exactly where the end-face mounts were once drawn (that visual was removed 2026-10-16).
  // dockOutward likewise carries ship-Z in its stored-Y slot, so a face's
  // arm deploys straight off its face at α=π/2. (The pre-fix rows parked
  // hinge AND outward in the stored-Z slots = side stations at
  // (0, ±ACROSS_FLATS/2, 0)_ship that matched nothing renderable.)
  if (tier.endFaceArms) {
    for (const face of tier.endFaceArms) {
      const isForward = (face === '+Z');
      const endOff = (isForward ? 1 : -1) * (V5.CORE_LENGTH / 2);
      const azDeg = isForward ? 0 : 180;
      const theta = azDeg * Math.PI / 180;

      // Stored outward carries ship-Z in its Y slot (deploy off the face).
      const outward = new THREE.Vector3(0, isForward ? 1 : -1, 0);
      // Swing axis for end-face arms: perpendicular to Z, lies in X direction
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

    /** @type {ArmUnit[]} */
    this.arms = [];

    // Wave1 reel-drum feedback: last state sent to PlayerSatellite.setTetherState
    // per strut index (edge-triggered — only transitions emit a call).
    this._drumStatesSent = [];

    /**
     * SceneManager ref for DYNAMIC near-field membership (z-layer fix). A
     * daughter's hull is added to the near-field depth pass only while it is
     * docked/close to the mother; set via setSceneManager(). Null in headless /
     * menu-backdrop contexts, where the toggling is a no-op.
     * @type {import('../scene/SceneManager.js').SceneManager|null}
     */
    this._sceneManager = null;

    // ST-9.2: Resolve active tier from persistence (default Y0_QUAD)
    this._activeTierKey = this._resolveActiveTierKey();
    const tierConfig = Constants.ARM_LADDER[this._activeTierKey] || Constants.ARM_LADDER.Y0_QUAD;

    /** Maximum simultaneous deployments (matches active tier arm count) */
    this.maxSimultaneous = tierConfig.armCount;

    /** Weaver/Spinner counts (from active tier) */
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

    // V5 Pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // Task 7 (opening-dance plan) — arms lean aside for an inbound catch.
    // Arm indices this lane currently holds ducked at the 90° open angle (STRUT_DEPLOY_ALPHA);
    // this manager is the sole writer of _strutTargetAlpha for exactly these
    // arms while the set is non-empty.
    this._leanAsideArmIndices = new Set();
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;

    // reel-home (2026-10-19): the mother turn a daughter on the reels owns (first come), and the transient exception
    // `getRotationLockTier` reads while that turn is being requested.
    this._rhTurn = null;          // { arm, attempt } while a turn for a daughter on the reels is running
    this._rhOwner = null;         // the daughter that owns the mother turn
    this._rhSeq = 0;              // arrival counter ("first come")
    this._lockExceptArm = null;

    // Daughter-arm automation (lane arms-auto): the controller, the once-per-player
    // store (main.js hands it in; no store → the full-range show never runs) and the
    // "." press counter the show uses to notice a player taking over.
    this._strutAuto = new StrutAutoController();
    this._strutAutoStore = null;
    this._strutAutoView = null;
    this._strutPress = 0;

    this._initArms();
    this._setupListeners();
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Resolve the active arm tier key from persisted save data.
   * Falls back to Y0_QUAD on missing/legacy saves.
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

  /** @private Create all arm units for the active tier configuration (ST-9.2) */
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
      // Register item 67(b): the rack feed-end's direct attitude-inertia
      // invalidation reaches the cache through this handle (same injection
      // idiom as _beaconSpeedScale / _digestSunScale).
      arm._playerSatellite = this.playerSatellite;
      // Config G geometry (ST-9.2): hinge, swing axis, azimuth — used by C-3 strut tip math
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      arm.initNetInventory(); // ST-9.4 C-6: fill net magazine (CAPTURE_NET flag gated)
      this.arms.push(arm);
    }
  }

  /** @private Wire up eventBus listeners */
  _setupListeners() {
    // Deploy arm to a target
    eventBus.on(Events.ARM_DEPLOY_TO, ({ target, preferType }) => {
      this.deployArm(target, preferType);
    });

    // Recall specific arm
    eventBus.on(Events.ARM_RECALL_ONE, ({ armId }) => {
      this.recallArm(armId);
    });

    // Recall all arms
    eventBus.on(Events.ARM_RECALL_ALL, () => {
      this.recallAll();
    });

    // The cast-all/fishing verb (ARM_FISH + deployFishing + the FISHING FSM
    // state) was orphaned when the RadialMenu/CommsPanel command was removed
    // (UX-11 #9); it had zero triggers, so the whole path was deleted in the
    // P1 integrity sweep. Re-introducing a passive-ambush verb is a fresh design.

    // V4 upgrade event (unlockable via tech tree)
    eventBus.on(Events.UPGRADE_V4_TECH, ({ upgrade }) => {
      this._applyV4Upgrade(upgrade);
    });

    // Sprint D5: V4 GSL upgrades purchased from shop
    eventBus.on(Events.UPGRADE_PURCHASED, ({ effect, value }) => {
      if (effect === 'v4TetherRange' || effect === 'v4NetArea' || effect === 'v4GripForce') {
        this.applyUpgrade({ effect, value });
      }
    });

    // Deorbit sacrifice command (Session 10)
    eventBus.on(Events.ARM_DEORBIT_CMD, () => {
      this.deorbitCapturingArm();
    });

    // Note: ARM_SELECT / ARM_DESELECT events are now EMITTED by selectArm/deselectArm
    // (Phase 1B). InputManager calls selectArm()/deselectArm() directly.
    // StatusPanel and other listeners still receive the events for HUD refresh.

    // Manual arm thrust from ARM PILOT mode
    eventBus.on(Events.ARM_MANUAL_THRUST, (data) => {
      const arm = this.arms.find(a => a.id === data.armId);
      if (arm && arm.isManual()) {
        arm.applyManualThrust(data.direction, data.fine, data.dt);
      }
    });

    // Task 7 (opening-dance plan, decision 6/7): arms lean aside for an
    // inbound catch. Trigger on LASSO_CAPTURED (a catch is inbound); release
    // on NET_BERTHED (the plan's own release event) or when the net clears
    // or fails. See _releaseLeanAside for why NET_BERTHED alone is not
    // sufficient on every path (a bounded timeout in _updateLeanAside covers
    // the gap).
    eventBus.on(Events.LASSO_CAPTURED, (payload) => this._onInboundCatchCaptured(payload));
    const releaseLeanAside = () => this._releaseLeanAside();
    eventBus.on(Events.NET_BERTHED, releaseLeanAside);
    eventBus.on(Events.LASSO_MISSED, releaseLeanAside);
    eventBus.on(Events.LASSO_SNAPPED, releaseLeanAside);
    eventBus.on(Events.NET_FAILED, releaseLeanAside);
    eventBus.on(Events.NET_RELEASED, releaseLeanAside);
    eventBus.on(Events.NET_TORN, releaseLeanAside);

    // reel-home (fix round F3): the mother's own net or lasso going out wins over a reel-home turn of the mother.
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.podIndex >= 0) this._rhOnMotherCatchFired('net');
    });
    eventBus.on(Events.LASSO_FIRED, () => this._rhOnMotherCatchFired('lasso'));
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Deploy the best available arm to capture a target.
   * @param {object} target - Debris object with .mesh, .id, .mass
   * @param {'weaver'|'spinner'|null} preferType - Preferred arm type (null = auto)
   * @returns {boolean} true if an arm was deployed
   */
  deployArm(target, preferType = null) {
    if (!target) return false;
    if (target._disposed === true) return false;       // slice 5 (5d, D4): a piece that was disposed of is no catch

    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // ST-6.1: Active-satellite treaty guard — refuse arming if target's NORAD
    // is in the active-sat catalogue. Emits RED CONJUNCTION_ALERT + Houston
    // stand-down COMMS_MESSAGE, returns false.
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    const targetMass = target.mass || 1;

    // interlocks-p2: ONE owner per piece, and no crossed lines. The picked piece must be free (no daughter, net or catch
    // on it), and the daughter sent is the best one whose strut line stays clear of every line already out.
    const pick = this._pickLaunchArm(target, preferType);
    if (pick.refusal) {
      this._sayWarn(pick.refusal.text);
      return false;
    }
    const arm = pick.arm;

    if (!arm) {
      // no-melt: with no furnace a daughter that holds a catch stays holding it until the burn to the next field, where she
      // carries it to a furnace (trip-melt-2), so say that plainly instead of the bare "no daughters" line.
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

    // Check mass compatibility
    if (targetMass > arm.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName} cannot capture ${targetMass}kg (max ${arm.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      return false;
    }

    // Aim-before-launch daughter ceremony: slew the chosen strut + rotate the
    // Mother so the physical strut fire direction points at the target, THEN
    // launch. Loose tolerance — TRANSIT FEEP corrects residual. Falls back to
    // an immediate launch when the autopilot/feature is unavailable.
    return this._deployWithCeremony(arm, target);
  }

  /**
   * Run the daughter launch ceremony for a selected+validated arm, then deploy.
   * Returns true when the ceremony starts (or the immediate fallback fires).
   * mother-aims: the ceremony turns the mother only when she is free to turn (`_motherTurnBlock`);
   * otherwise the strut alone aims the launch, with one comms line saying why.
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

    // Pre-ceremony max-deploy-range refusal (moved earlier so it stays instant;
    // ArmUnit.deploy still backstops it at fire time). Register item 100: same
    // tether-tier-aware expression as the backstop — tetherMax × fraction.
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
      // L2: no aim ceremony → the daughter fires along the direct bearing; the
      // launch line is checked along that same bearing.
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), opts, target);
    }

    // mother-aims: not free to turn (a daughter on her line, a catch on the collar, a hand-off or another
    // launch under way) → no turn; the strut alone aims the launch. `announce`: a launch the aim stage
    // holds back announces itself when it fires (the D key's auto-pick caller announces only a launch that
    // has already happened).
    const blocked = this._motherTurnBlock();
    if (blocked) {
      this._sayCantTurn(blocked);
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), { ...(opts || {}), announce: true }, target);
    }

    // Concurrency guard: don't supersede an in-flight aim sequence (e.g. a
    // Mother net aim already rotating). Defer, matching InputManager.fireMotherNet.
    // (mother-aims: `_motherTurnBlock` already refuses while an aim runs, so this is a backstop only.)
    if (typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info',
      });
      return false;
    }

    // Reserve the arm so a second D-press doesn't grab it mid-ceremony. interlocks-p2: and the piece is hers from this
    // moment (the ceremony takes 8-10 s): a net or another daughter sent at it meanwhile is refused.
    arm._claimTarget = target;
    arm._aimReserved = true;

    // World-direction provider: strut-tip → target scene position (recomputed
    // per tick so it tracks the moving target). No lead — TRANSIT corrects.
    // Reuses one scratch output object (no per-frame allocation).
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
      maxWaitS: Constants.AIM.AIM_TIMEOUT_S,   // sloth mode backstop (D7): `_motherTurnBlock` already sends a slow turn to the strut-only launch
    }).then(() => {
      arm._aimReserved = false;
      // L2: the launch goes through the keep-out gate. The line is checked along
      // the converged STRUT direction (re-derived each check — struts move); a
      // clear line fires this same frame, as before.
      this._launchArm(arm, 'ceremony', () => this._strutDirShip(arm), () => {
        // Tell deploy() the strut was physically aimed at the target, so it fires
        // along the strut basis (SSOT) rather than the direct-bearing fallback.
        arm._aimConverged = true;
        const ok = arm.deploy(target);
        // Camera ceremony must start when the arm ACTUALLY deploys (post-rotation),
        // not during the slew. The synchronous InputManager emit is skipped for
        // ceremony deploys (arm isn't deployed yet at that point), so emit here.
        if (ok) eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
        return ok;
      }, undefined, target);
    }).catch((err) => {
      arm._aimReserved = false;
      arm._claimTarget = null;
      // Abort comms already emitted by AutopilotSystem.
      // Reaction wheels (F1.5): with the steering gas out the wheels were asked to turn her and need longer than the aim allows
      // ('TOO_SLOW', refused at once, nothing moved): the strut aims alone, as it always did with the gas out.
      if (err && err.code === 'TOO_SLOW' && arm.state === ARM_STATES.DOCKED) {
        this._sayCantTurn('the steering gas is empty');
        this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
          () => arm.deploy(target), { announce: true }, target);
      }
    });

    return true;
  }

  /** Inject the autopilot for the aim-before-launch daughter ceremony. */
  setAutopilot(autopilot) { this._autopilot = autopilot; }

  /**
   * Deploy a specific arm by ID.
   * @param {string} armId
   * @param {object} target
   * @returns {boolean}
   */
  deploySpecificArm(armId, target) {
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms.find(a => a.id === armId);
    if (!arm) return false;
    // interlocks-p2: one owner per piece
    const owned = target ? this.launchRefusalAt(target, { exceptArm: arm }) : null;
    if (owned) { this._sayWarn(owned.text); return false; }
    return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
      () => arm.deploy(target), undefined, target);
  }

  /**
   * Deploy a specific arm by index (0-based).
   * If target is provided, deploys toward target. If null, deploys in free-fly mode.
   * Used by number key deploy+select flow (Phase 1B).
   * mother-aims: with a target and the mother free to turn, the number key does what the D key does: the
   * mother turns (and the strut slews) until the strut points at the target, then the spring fires. Not
   * free (a daughter out on her line, a catch on the collar, a hand-off or another launch): the strut aims alone.
   * @param {number} index - 0-based arm index
   * @param {object|null} target - Optional target to aim toward
   * @param {{announce?: boolean}} [opts] - `announce`: the number-key launch (InputManager). A launch
   *   the aim stage holds back then announces itself (the cut-scene start) when it fires; an
   *   immediate launch is announced by the caller as before. The launch LINE is not announced
   *   here: ArmUnit says "Spring released. Separating" when the spring really fires.
   * @returns {boolean} true if deployment started
   */
  deployArmByIndex(index, target, opts) {
    if (target && target._disposed === true) return false;       // slice 5 (5d, D4): a piece that was disposed of is no catch
    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // ST-6.1: Active-sat treaty guard (even if target was selected by player).
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms[index];
    if (!arm || arm.state !== ARM_STATES.DOCKED) return false;

    // V5: Spring must be charged to deploy
    if (!arm.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      return false;
    }

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    // interlocks-p2: one owner per piece, and the strut she was picked on must keep its line clear of the others'.
    const refused = target ? this.indexLaunchRefusal(index, target) : null;
    if (refused) { this._sayWarn(refused.text); return false; }

    // mother-aims: with a target, the number key turns the mother too (the D key's ceremony) when she is
    // free to turn; otherwise only the arm's strut aims (today's launch aim). A launch of this arm that is
    // already waiting keeps its single entry (requestClearLaunch answers "accepted" for it).
    if (target && !(this._pendingLaunches && this._pendingLaunches.has(index))) {
      const blocked = this._motherTurnBlock();
      if (!blocked) return this._deployWithCeremony(arm, target, opts);
      // The D key with this daughter selected (`announce`) says why the mother does not turn, once; a launch
      // of hers that already waits keeps its single entry and says nothing again.
      if (opts && opts.announce) this._sayCantTurn(blocked);
    }

    // No target → free-fly mode (TRANSIT with manual control). L2: through the
    // keep-out gate, along the direction the arm will actually fire.
    return this._launchTargetOrFree(arm, target, opts);
  }

  // ==========================================================================
  // interlocks-p2 — a piece has ONE owner; a daughter's line never crosses another's (docs/research/2026-10-launch-interlocks.md)
  // ==========================================================================

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

  /** One warning line in Comms. @private */
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
    if (cfg.maxCaptureMass !== undefined && (piece.mass || 1) > cfg.maxCaptureMass) return 'heavy';
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
   *   it": when the best daughter falls short the next one is tried before the piece is given up, F6)
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
    const cap = (a) => !(a.config && a.config.maxCaptureMass !== undefined) || mass <= a.config.maxCaptureMass;
    const clear = (a) => cap(a) && (!fits || fits(a)) && !this._crossingArm(a, target);
    const arm = this._findDockedArm(first, dir, clear) || this._findDockedArm(other, dir, clear);
    if (arm) return { arm, refusal: null };
    // None is clear. An arm that could go but for a crossing line gets the crossing line; the rest is the old answers.
    const any = this._findDockedArm(first, dir) || this._findDockedArm(other, dir);
    if (!any) return { arm: null, refusal: null };
    if (fits) {
      // F15: judge the crossing only for a daughter who could fly there at all. A piece nobody holds or reaches gets the reach
      // (or weight) line, not the crossing line of whichever daughter happened to be listed first.
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
    const clear = (a) => (!(a.config && a.config.maxCaptureMass !== undefined) || mass <= a.config.maxCaptureMass)
      && !this._crossingArm(a, target);
    const alt = this._findDockedArm(arm.type, dir, clear)
      || this._findDockedArm(arm.type === 'weaver' ? 'spinner' : 'weaver', dir, clear);
    return {
      kind: 'cross',
      // F11: glass has no number keys: the daughter is picked by a tap on her row in DAUGHTERS (read at say time, as pilotLine does)
      text: alt
        ? crossNamedStrutLine(this.arms.indexOf(alt) + 1, crossed.displayName, GestureHints.isGlass() ? alt.displayName : null)
        : crossNoneClearLine(crossed.displayName),
    };
  }

  /**
   * At the moment of release: has the piece been caught, lost or taken since the launch was asked for? (R4, waiting launch.)
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
   * F12/F13: why the daughters still docked after a send stayed. `pieces` are the pieces the send was about; those somebody
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
        if (kinds.includes('heavy')) why.heavySeen = true;     // F19: every reason present is kept, not only the one she is counted under
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
   * One daughter per piece, best first (Q1). Each piece goes to the best docked daughter that can hold it, reach it and
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
      // F6: the daughter must hold it, reach it AND stay clear; when the best one falls short the next is tried
      const pick = this._pickLaunchArm(piece, null, (a) => this._armFitsPiece(a, piece));
      if (pick.refusal) continue;
      if (!pick.arm || !this._armFitsPiece(pick.arm, piece)) continue;
      if (this._launchTargetOrFree(pick.arm, piece)) sent++;
    }
    return sent;
  }

  /**
   * R7: would turning the ship to point +Z along `dirWorld` (a net aim) wrap a daughter's line round the hull? The daughters
   * stay where they are in space while the ship turns; each line then runs from her strut anchor (fixed on the ship) to
   * where she is, seen from the TURNED ship. A hit on the ship keep-out in the first 30 m is a wrap.
   * The whole turn is walked in 5 degree steps along the shortest arc, not just its end: the end attitude alone is a poor
   * guide (measured in the real game, 2026-10-22: the ship came to rest 9.5 degrees from the predicted attitude, and the
   * answer for a 175 degree aim went clear, wrap, wrap, clear, wrap across the last 15 degrees), and a line dragged across
   * the hull on the way round is as tangled as one that ends there.
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
      // The lines to test: every daughter that is out (docked and reloading ones have no line).
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
      // Where +Z points now, and the shortest turn that takes it to dirWorld.
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(p.quaternion);
      const want = new THREE.Vector3(dirWorld.x, dirWorld.y, dirWorld.z).normalize();
      const total = fwd.angleTo(want);
      const arc = new THREE.Quaternion().setFromUnitVectors(fwd, want);
      const STEP = 5 * Math.PI / 180;
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
          if (hit.wraps) return { wraps: true, arm: L.arm, part: hit.part, atDeg: Math.round((total * k / n) * 180 / Math.PI) };
        }
      }
    } catch (err) {
      if (!this._wrapWarned) { this._wrapWarned = true; console.warn('[ArmManager] net-turn wrap check failed; turning unchecked:', err); }
    }
    return none;
  }

  // ==========================================================================
  // mother-aims — the launch turns the mother when she is free to turn
  // ==========================================================================

  /** The one comms line for a launch the mother may not turn for. @private */
  _sayCantTurn(reason) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: holdsStillLine(reason), priority: 'info',
    });
  }

  /**
   * reel-home (Decision 6, fix round F1): does `a` NOT limit the mother's turn for `exceptArm`? True for `exceptArm`
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
    // sloth mode (D7): with the steering gas out she turns on the tail boxes, minutes for a launch turn: the strut aims alone
    // ("Aiming the arm only: the steering gas is empty, so the ship holds still.") and a reel-home line-up is hers to do.
    // (reaction wheels, F1.5: with the kit powered and not full the wheels turn her for no gas, a launch turn the aim may still refuse
    // as too slow for its 30 s: then the strut aims alone, `_deployWithCeremony`)
    const pl = this.playerSatellite;
    if (pl && typeof pl.isSlothMode === 'function' && pl.isSlothMode()
        && !(typeof pl.wheelsCanTurn === 'function' && pl.wheelsCanTurn())) return 'the steering gas is empty';
    const ap = this._autopilot;
    // reel-home (fix round F5): the autopilot flying the ship keeps steering it back to its own heading the moment a
    // turn ends, so a daughter's turn would be undone: she lines herself up instead. Launch callers (no argument) keep
    // today's answer.
    if (exceptArm && ap && ap.engaged === true) return 'the autopilot is flying the ship';
    // reel-home (Decision 6): with `exceptArm` the daughter's own reservation does not count, nor the reservation of
    // another daughter on the strut line (REELING); the mother's own reel-home turn (below) is not "a hand-off" either.
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
      // interlocks-p2 R9: say what is true. The hold starts the moment a net or the lasso leaves; while it is still flying
      // there is no catch yet, only "a net is out".
      return netIsOut(this.claimWorld()) ? 'a net is out' : 'a catch is being reeled in';
    }
    if (!mine && ap && typeof ap.isAttitudeHeld === 'function' && ap.isAttitudeHeld()) return 'a hand-off is running';
    return null;
  }

  /**
   * Pane-density pure-scenery rung: hide/show every daughter's scene group for
   * an empty-orbit view. Prior per-arm group visibility is remembered so a
   * restore never resurrects an EXPENDED/lost daughter (ArmUnit hides its group
   * on deorbit-complete, ArmUnit.js). A daughter deployed while hidden is not
   * retroactively hidden — an accepted edge of the pure-scenery mode.
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
   * Forward the live camera→craft distance (scene units) to each daughter so its
   * inert detail hardware can be culled at range (Phase 6 detail LOD). Cheap:
   * each daughter only does work when a hysteresis threshold is crossed.
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
   * Deploy a docked arm in trawling mode — slow sweep for passive debris collection.
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction = null) {    // Power distribution: block deployment if ARM bus is at 0%
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

    // Find a docked arm (prefer spinner type for trawling)
    let arm = this._findDockedArm('spinner');
    if (!arm) arm = this._findDockedArm('weaver');
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'DTR-MGR', text: 'No docked daughters available', priority: 'warning',
      });
      return false;
    }

    // No direction given: she sweeps along her own dock direction (launch-aim: that one is frozen at the request).
    return this._launchArm(arm, 'trawl', () => this._trawlDirShip(arm, direction),
      () => arm.deployTrawl(direction), direction ? undefined : { frozenAim: true });
  }

  /**
   * Fire a GSL web shot from a docked arm at a target debris.
   * "Fire and forget" ranged shot that increases debris atmospheric drag.
   * @param {object} target - Debris object with .id and ._scenePosition
   * @param {'weaver'|'spinner'|null} [preferType] - Preferred arm type
   * @returns {boolean} true if web shot was fired
   */
  fireWebShot(target, preferType = null) {
    if (!target) return false;

    // Power distribution: block if ARM bus offline
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power for web shot',
        priority: 'warning',
      });
      return false;
    }

    // Sprint C2: Prefer selected arm if eligible
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (selected.state === ARM_STATES.DOCKED &&
          selected._webShotCooldown <= 0 && selected.fuel > Constants.WEB_SHOT_FUEL_COST) {
        if (selected.fireWebShot(target)) return true;
      }
    }

    // Find a docked arm (prefer type if given) with no cooldown
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
   * Set reference to debris field for trawling proximity checks.
   * @param {import('../entities/DebrisField.js').DebrisField} debrisField
   */
  setDebrisField(debrisField) {
    this._debrisField = debrisField;
  }

  /**
   * ST-6.1: Inject the CatalogLoader so arm-arming code can look up active-sat
   * entries before committing. Null-safe: if not set, the treaty guard is a no-op.
   * @param {object} catalogLoader
   */
  setCatalogLoader(catalogLoader) {
    this._catalogLoader = catalogLoader || null;
  }

  /**
   * Set reference to ResourceSystem for reading upgraded resource maxes.
   * @param {ResourceSystem} rs
   */
  setResourceSystem(rs) {
    this._resourceSystem = rs;
  }

  /**
   * Wire the SceneManager so docked/close daughters can join the near-field
   * depth pass (z-layer fix). Without this, daughters render on layer 0 (far
   * pass) and get occluded by the depth-cleared near pass — and z-fight the
   * mother's strut-tip collars where they overlap. Null-safe.
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
    // Sprint C2: Prefer selected arm if it's eligible for deorbit.
    // Only fuel-capable states are eligible for the general (auto-pick) path —
    // a deorbit burn needs real propellant. ADRIFT (reserve-only) is deliberately
    // NOT eligible here so an out-of-fuel daughter can't intercept and consume a
    // healthy daughter's deorbit via the find() fallback below.
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
        // The player explicitly targeted an adrift daughter for deorbit — let
        // startDeorbit emit the "reel her in instead" hint for THAT daughter
        // (scoped to the selection so it can't shadow another's deorbit).
        selected.startDeorbit();
        return { success: false };
      }
    }
    // Fallback: find first eligible (fuel-capable) arm
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
   * Recall a specific arm by ID.
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
    // If a specific arm is selected (arm pilot mode), prefer it
    const selected = this.getSelectedDeployedArm();
    if (selected && !selected.isDetached) {
      const detachable = new Set(PRIORITY);
      if (detachable.has(selected.state)) return selected;
    }
    // Otherwise find highest-priority candidate
    for (const state of PRIORITY) {
      const arm = this.arms.find(a => a.state === state && !a.isDetached);
      if (arm) return arm;
    }
    return null;
  }

  /**
   * Execute detach on a specific arm by index.
   * @param {number} armIndex
   * @returns {boolean}
   */
  detachArm(armIndex) {
    const arm = this.arms[armIndex];
    if (!arm) return false;
    return arm.detach();
  }

  /**
   * S2.2 / interlocks-p2 (Q1): Shift+D and Shift+N send every docked daughter out, ONE PER PIECE, best first.
   * `target` (the picked piece) goes first, then `more` (the next eligible pieces, best first, from InputManager).
   * Each piece takes the best docked daughter that can hold it, reach it and whose strut line stays clear of the lines
   * already out; a piece that already has an owner is skipped; daughters left over stay docked and one line says how many
   * went. The picked piece itself, when owned, is refused with the reason (nothing is sent).
   * With no `target` (and no `more`) every docked daughter free-flies, as before.
   * @param {object|null} target - The picked piece. If null (and `more` empty), deploys in free-fly.
   * @param {object[]} [more] - Further pieces for the other daughters, best first.
   * @returns {number} Number of arms successfully deployed
   */
  deployAllToTarget(target, more = []) {
    // ST-6.7: Safe-mode guard
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    // Power distribution guard
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
    // F13: the daughters that stayed docked, by cause - no piece left, a crossing line, out of reach, too heavy
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
   * Shift+A fan-out (2026-06-14): deploy every docked daughter to a *distinct*
   * debris so the fleet spreads across the field for quick, high-risk salvage.
   * The i-th deployable daughter is sent to the first listed piece she can hold and reach, that nobody owns (a daughter,
   * a net or a catch: interlocks-p2) and whose strut line stays clear of the lines already out. When there are more
   * daughters than pieces, the extras fall back to `fallbackTarget` (the mother's active target) when that piece is
   * still free, or free-fly when none is given. Returns the number deployed.
   *
   * @param {Array<object>} targets - distinct debris objects, best-first
   * @param {object|null} [fallbackTarget] - target for surplus daughters
   * @returns {number} number of daughters successfully deployed
   */
  deployAllToDistinctTargets(targets, fallbackTarget = null) {
    // ST-6.7: Safe-mode guard
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    // Power distribution guard
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

    // F12: the daughters this send left docked, and why - counted, never silent (the lines to fly at: the list, and the
    // surplus fallback while it is still a piece to send somebody to).
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

  /**
   * Recall all deployed arms.
   */
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
   * Recall every *deployed* daughter (Shift+R). Unlike recallAll(), this skips
   * arms that are already resting / homing / spent (DOCKED, EXPENDED, DOCKING;
   * a detached RETURNING daughter has no line) or parked with a catch (HOLDING_CATCH — recall refuses her, so
   * commanding her would eat the hold; see ArmUnit.recall) and returns the
   * number actually commanded home, so the caller can
   * give honest feedback ("Reeling in all daughters (N)" vs "nothing to reel")
   * instead of the old always-positive "All daughters recalled" notice that read
   * as a no-op when nothing was out (2026-06-14 reel-in fix).
   * @returns {number} count of daughters commanded to reel home
   */
  recallAllDeployed() {
    const S = ARM_STATES;
    let count = 0;
    for (const arm of this.arms) {
      if (!arm) continue;
      if (arm.state === S.DOCKED) continue;
      if (arm.state === S.EXPENDED) continue;
      // fail-reel: a tethered RETURNING daughter (limping home on her FEEP) is on her line: R winds her in (recall() -> REELING)
      if (arm.state === S.RETURNING && arm.isDetached) continue;
      if (arm.state === S.DOCKING) continue;
      if (arm.state === S.HOLDING_CATCH) continue; // parked with cargo — recall refuses her
      if (_CARRY_STATES.has(arm.state)) continue;  // carrying a catch to a furnace — it ends at her dock
      if (typeof arm.recall === 'function') {
        // Zero-fuel reel on the mothership tether motor: stuck / fuel-depleted
        // tethered daughters always come home (never abandoned as EXPENDED).
        // fail-reel review F4: count only real recalls (recall() === true); 'already' (reeling) and refusals are not recalls
        if (arm.recall() === true) count++;
      }
    }
    return count;
  }

  /**
   * Phase 3a (capture-feedback overhaul): propagate the Shift-held boost-reel
   * intent to every arm. Called every frame from InputManager.processInput so
   * the boost always releases on keyup / overlay open.
   * @param {boolean} held
   */
  setReelBoost(held) {
    for (const arm of this.arms) {
      arm._boostReelHeld = !!held;
    }
  }

  /**
   * Recall a deployed daughter: the SELECTED one first, closest as fallback.
   *
   * Delegation 1 (2026-05-31) onboarding helper for the bare-R rebind;
   * selection-aware since the pick-then-launch fix:
   *   • If `selectedArmIndex` points at an eligible deployed daughter (in a
   *     recallable state and not detached), recall HER — this covers the
   *     pick-then-launch → skip-ceremony path that leaves a deployed daughter
   *     selected in mother mode. A DOCKED selection (picked but never
   *     launched) is NOT recallable, so it intentionally falls through to the
   *     closest scan; selection alone must never short-circuit eligibility.
   *   • Otherwise iterates this.arms.
   *   • Selects arms in any non-resting state (i.e. NOT DOCKED, EXPENDED,
   *     DOCKING, HOLDING_CATCH, a detached RETURNING one — those are already
   *     docking, unable to be recalled, or parked with a catch recall must not
   *     destroy). A tethered RETURNING daughter IS eligible (fail-reel: R winds
   *     her in on the strut reel).
   *   • Picks the candidate with the smallest world-space distance from
   *     the mother. When `motherPos`/`arm.position` is unresolvable the scan
   *     silently keeps `eligible[0]` — acceptable fallback.
   *   • Calls the existing recall path used by `recallArm()` / `recallAll()`
   *     (i.e. `arm.recall()`), which is the same flow `H` triggers.
   *
   * No new event constant is introduced — `arm.recall()` already emits the
   * arm-state-change events the rest of the system listens for.
   *
   * @returns {number|null} 0-based index of the recalled arm, or `null` if
   *   no eligible deployed daughter was found.
   */
  recallClosestDeployed() {
    const S = ARM_STATES;
    const isRecallable = (a) => a
      && a.state !== S.DOCKED
      && a.state !== S.EXPENDED
      && !(a.state === S.RETURNING && a.isDetached)   // fail-reel: tethered RETURNING is recallable (R winds her in)
      && a.state !== S.DOCKING
      && a.state !== S.HOLDING_CATCH // parked with cargo — recall refuses her
      && !_CARRY_STATES.has(a.state);  // carrying a catch to a furnace — it ends at her dock

    // (0) Selection-aware: recall the SELECTED deployed daughter first.
    if (this.selectedArmIndex >= 0) {
      const sel = this.arms[this.selectedArmIndex];
      if (sel && isRecallable(sel) && !sel.isDetached
          && typeof sel.recall === 'function') {
        sel.recall();
        return this.selectedArmIndex;
      }
      // Ineligible selection (e.g. DOCKED pick-then-launch) → fall through.
    }

    // Any non-resting state — exclude arms already homing or expended.
    const eligible = [];
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a) continue;
      if (!isRecallable(a)) continue;
      eligible.push({ idx: i, arm: a });
    }
    if (eligible.length === 0) return null;

    // Resolve mother world position once.
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
      // Pull the daughter home on the strut/tether reel motor (zero-fuel) so a
      // stuck or fuel-depleted daughter is still reeled in, never abandoned.
      target.recall();
      return bestIdx;
    }
    return null;
  }

  // ==========================================================================
  // V5 DUAL-FIRE
  // ==========================================================================

  /**
   * Fire two opposite arms simultaneously to cancel recoil.
   * Config G antipodal pairs: Y0 (0↔2, 1↔3), Y1 (0↔3, 1↔4, 2↔5), Y3 + end-face (6↔7).
   * Use getDualFirePair() to resolve the correct partner at any tier.
   * @param {number} armIndex1 - First arm index
   * @param {number} armIndex2 - Second arm index (opposite)
   * @param {Object} target1 - Target for arm 1 (optional)
   * @param {Object} target2 - Target for arm 2 (optional)
   * @returns {boolean} Success
   */
  dualFire(armIndex1, armIndex2, target1 = null, target2 = null) {
    const arm1 = this.arms[armIndex1];
    const arm2 = this.arms[armIndex2];

    if (!arm1 || !arm2) return false;

    // Both must be docked AND spring-charged
    if (arm1.state !== ARM_STATES.DOCKED || !arm1.springCharged) return false;
    if (arm2.state !== ARM_STATES.DOCKED || !arm2.springCharged) return false;

    // Deploy both within sync window. L2: each goes through the keep-out gate; a
    // pair only counts as a DUAL fire (recoil cancelled) when BOTH fired now —
    // a launch the gate deferred leaves a single-arm launch later.
    const deployed1 = this._launchTargetOrFree(arm1, target1);
    const deployed2 = this._launchTargetOrFree(arm2, target2);
    const pend = this._pendingLaunches;
    const firedTogether = deployed1 && deployed2
      && !(pend && (pend.has(armIndex1) || pend.has(armIndex2)));

    if (firedTogether) {
      // Calculate net recoil (should be ~zero for same-type pairs)
      const mass1 = arm1.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const mass2 = arm2.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const recoil1 = mass1 * arm1.launchSpeed;
      const recoil2 = mass2 * arm2.launchSpeed;
      const residualMomentum = Math.abs(recoil1 - recoil2);
      // Her LIVE mass (Nets step 3 slice 2a: the budget, the two daughters already out of it); MASS_KG, her start mass, when
      // there is no player or it answers nothing usable.
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

  /**
   * Get the opposite arm index for dual-fire pairing (ST-9.2).
   * Delegates to getDualFirePair for azimuth-based antipodal lookup.
   * @param {number} index - Arm index
   * @returns {number} Opposite arm index, or -1 if invalid
   */
  getOppositeArm(index) {
    const result = this.getDualFirePair(index);
    return result !== null ? result : -1;
  }

  /**
   * Get the antipodal partner index for dual-fire (ST-9.2 Config G).
   * Looks up arm whose azimuth = (thisAzimuth + 180°) % 360°.
   * Works for all tiers: Y0 Quad (60↔240, 120↔300), Y1 Hex,
   * Y3 Octo ring arms + end-face pair (+Z ↔ −Z).
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

  // ==========================================================================
  // ST-9.2 CONFIG G TIER MANAGEMENT
  // ==========================================================================

  /**
   * Get the active arm tier key (ST-9.2).
   * @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
   */
  getCurrentTier() {
    return this._activeTierKey;
  }

  // ==========================================================================
  // ST-9.2 CONFIG G STRUT TIP GEOMETRY
  // ==========================================================================

  /**
   * Compute strut tip position at sweep angle α (ST-9.2 Config G).
   *
   * Convention (ArmDockBasis.strutLocalDirection — the RENDERED ship frame):
   *   α = 0   → STOWED  (alongside barrel, daughter aft at −Z)
   *   α = π/2 → EQUATORIAL (radial outward in the collar XY plane)
   *   α = π   → ZENITH  (pointing +Z, forward of Mother)
   *
   * Formula: tip = hinge + STRUT_LENGTH × ( sin(α)·outward − cos(α)·ẑ )
   *
   * Returns position in METERS (not scene units). Caller scales by M if needed.
   * S13(a): delegates to CoMCalculator.strutTipMeters — ONE computation owns
   * the stored-dock → ship-frame map (register item 57); this twin must never
   * re-derive it.
   *
   * @param {number} armIndex — arm index
   * @param {number} alpha — sweep angle in radians [0, π]
   * @returns {{x: number, y: number, z: number}|null} Tip in meters, ship frame, or null
   */
  getStrutTipPosition(armIndex, alpha) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    return strutTipMeters(this._dockPositions[armIndex], alpha);
  }

  /**
   * Session L (plan item 4): the "." hotkey's strut toggle as a PUBLIC method
   * — the REFIT BERTHS card's STRUTS chip and the F1 bar's `struts` actuator
   * drive it through the hub; InputManager's Period case delegates here. It is
   * the ONE copy of the strut law. It writes `_strutTargetAlpha` on DOCKED arms
   * and on daughters HOLDING A CATCH (hold-catch, owner 2026-10-22: never below
   * her hold pose, never above 100°; see `_pressHolders`), and decides from the
   * live read (getAimAlpha, a pending latch winning — never the latch alone, it
   * clears to undefined on arrival).
   *
   * The law (owner 2026-10-14; angles measured from the tail):
   *   • a press while any docked strut is open (live or pending, past
   *     STRUT_OPEN_THRESHOLD, half the rest angle, 17°) → ALL to 0°;
   *   • otherwise → ALL to STRUT_REST_ALPHA, 34° (swept back);
   *   • with `armIndex` of a DOCKED daughter ("." with her selected, lane
   *     arms-default, owner 2026-10-16) "ALL" below means just her, and the
   *     open/closed test reads only her strut;
   *   • a press within STRUT_PUSH_WINDOW_MS (600 ms) of the previous press → ALL
   *     to STRUT_DEPLOY_ALPHA, 90°, whatever the first press did, and the window
   *     resets (a third quick press is a fresh single press). So a second press
   *     inside 600 ms ALWAYS means 90°; reversing a swing needs a press after 600 ms.
   *   • no tap sequence ever targets 180° (STRUT_SWEEP_MAX is the range, not a target).
   * Emitting Events.STRUT_DEPLOY_INPUT stays the CALLER's job (InputManager
   * emits its own; the hub emits for the pane), as does the click.
   * @returns {boolean|null} true = opening (34° or 90°), false = closing (0°);
   *   null when no DOCKED or holding arm could take the write (nothing toggled —
   *   the caller should skip its emit). A DOUBLE press that moves nothing leaves one
   *   plain sentence in `lastStrutPressNote` (else null) for the caller to say; a
   *   single press that moves nothing leaves it in `_pendingStrutNote`, which
   *   `_tickStrutPressNote` says once the double-press window has passed.
   */
  toggleStruts(armIndex) {
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;               // a new press supersedes a line still waiting out the double-press window
    let docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    // hold-catch (owner 2026-10-22: '"." keys doesn't move them'): a daughter aboard holding a catch takes the press too, but
    // her strut never goes below her hold pose (34° or the lowest plume-clear angle) or above HOLD_POSE_MAX_DEG.
    let holders = (this.arms || []).filter((a) => a && a.state === ARM_STATES.HOLDING_CATCH && !a.isDetached
      && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h));
    // A selected daughter, docked or holding (the "." key passes her index): the same law, for her alone.
    // No index, or she is away → every docked / holding arm, as before.
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
      : holders.some((a) => _strutLiveAlpha(a) > holdRad(a) + V5.HOLD_POSE_DEADBAND_DEG * Math.PI / 180);
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const doubleTap = this._lastStrutTap !== undefined
      && now - this._lastStrutTap < V5.STRUT_PUSH_WINDOW_MS;

    // Daughter-arm automation (arms-auto, item 5): a press is a manual override — each
    // commanded arm gets a marker; StrutAuto leaves it alone until 10 s after it ARRIVES.
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
    // FA4: this tap may be the first of a double press that lifts her to 90°; "stays at 34°" is said only when the window
    // has passed with no second press (ArmManager._tickStrutPressNote), not at once
    if (this.lastStrutPressNote) {
      this._pendingStrutNote = { text: this.lastStrutPressNote, leftS: V5.STRUT_PUSH_WINDOW_MS / 1000 };
      this.lastStrutPressNote = null;
    }
    return !anyOpen;
  }

  /**
   * The opening's SET (StartOpening, owner 2026-10-20 "on the player's first
   * action"): every DOCKED strut that is still closed goes to STRUT_REST_ALPHA
   * (34°). Never a toggle: a strut already open (live or pending past
   * STRUT_OPEN_THRESHOLD, e.g. the player's own "." press, even its 90° double
   * press) is left where it is, so the opening can never close what the player
   * just opened. It is not a player press: no `_strutPress` count, no
   * `_strutManual` 10 s hold (StrutAuto marks the arm opened from the latch and
   * rests it at 34° on its own), no tap-timer, no emit.
   * @returns {boolean|null} true = every docked strut is now open or opening;
   *   null when no DOCKED arm could take the write
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
   * Read-only: the SAME predicate toggleStruts() decides from — true while any
   * DOCKED strut is past STRUT_OPEN_THRESHOLD, half the 34° rest angle (17°; a
   * pending latch counts, so the read flips the instant the toggle writes; the
   * REFIT chip re-reads truth, no optimism). No docked arm → false.
   * @returns {boolean}
   */
  strutsDeployed() {
    return (this.arms || []).some((a) =>
      a && a.state === ARM_STATES.DOCKED
      && _strutLiveAlpha(a) >= Constants.OCTOPUS_V5.STRUT_OPEN_THRESHOLD);
  }

  // ==========================================================================
  // V5 PULSE SCAN
  // ==========================================================================

  /**
   * Initiate pulse scan — all docked arms fire simultaneously as sensor nodes.
   * "Jellyfish pulse" — the signature move.
   * @returns {boolean} Success
   */
  pulseScan() {
    // Check cooldown
    if (this._pulseScanCooldown > 0) return false;

    // Collect all docked, charged arms
    const scanArms = this.arms.filter(a =>
      a.state === ARM_STATES.DOCKED && a.springCharged
    );

    if (scanArms.length < 2) return false; // Need at least 2 for triangulation

    // Fire all scan arms
    for (const arm of scanArms) {
      arm.startScan();
    }

    // Set cooldown
    this._pulseScanCooldown = PULSE_SCAN_COOLDOWN;

    eventBus.emit(Events.PULSE_SCAN_START, {
      armCount: scanArms.length,
    });

    // Schedule completion event
    this._pulseScanTimer = PULSE_SCAN_DURATION;
    this._pulseScanActive = true;

    return true;
  }

  // ==========================================================================
  // V5 FLEET-WIDE LAUNCH SPEED CONTROL
  // ==========================================================================

  /**
   * Set launch speed for all arms (the item-100 speed dial: `;` down / `'` up).
   * Emits LAUNCH_SPEED_CHANGED with the clamped fleet value so the HUD arms
   * panel + persistence see the truth after per-arm tier clamps.
   * @param {number} speed - m/s, clamped to tier limits
   */
  setFleetLaunchSpeed(speed) {
    for (const arm of this.arms) {
      arm.setLaunchSpeed(speed);
    }
    eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
  }

  /**
   * Set launch speed for a specific arm.
   * @param {number} index - Arm index
   * @param {number} speed - m/s, clamped to tier limits
   */
  setArmLaunchSpeed(index, speed) {
    if (this.arms[index]) {
      this.arms[index].setLaunchSpeed(speed);
      eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
    }
  }

  /**
   * Nets step 3 lane 3f (DECISIONS §34 row 10): what each daughter carries that a save must keep - her ion fuel (%) and her cold-gas
   * bottle (kg). Keyed by arm id (so a changed arm tier cannot shift the values onto another daughter).
   * @returns {Array<{id: string, fuel: number, coldGasKg: number}>}
   */
  getSupplyState() {
    return this.arms.map((a) => ({ id: a.id, fuel: a.fuel, coldGasKg: a.coldGasKg }));
  }

  /**
   * Nets step 3 lane 3f: put saved ion fuel and cold gas back on the daughters they were saved from (matched by id; an id this fleet
   * does not have is skipped, a missing or non-finite value leaves that tank as it is). Fuel is clamped to [0, SUPPLY_FUEL_MAX_PCT]
   * (the Daughter Fuel Reserve lifts a full tank to 150 %), the bottle to [0, its size]. Call it AFTER `reset()` and after the upgrade
   * replay (`ArmUnit.reset()` fills the tanks and the replay can raise a tank's max).
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

  /**
   * The fleet launch speed (m/s): max across arms — all arms share the fleet
   * spring tier, so this is the dial's single truth for HUD + save.
   * @returns {number}
   */
  getFleetLaunchSpeed() {
    if (!this.arms || this.arms.length === 0) return Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT;
    return Math.max(...this.arms.map((a) => a.launchSpeed));
  }

  // ==========================================================================
  // V5 FLEET-WIDE UPGRADE METHODS
  // ==========================================================================

  /**
   * Apply spring tier upgrade to all arms.
   * @param {number} tier - Spring tier index
   */
  applySpringUpgrade(tier) {
    for (const arm of this.arms) {
      arm.setSpringTier(tier);
    }
  }

  /**
   * Apply tether tier upgrade to all arms. This is the one hub for the line-fibre upgrade (DECISIONS §33 row 5): the
   * purchase, the save-load replay and the reset replay all land here, and the tier raises the tether length AND the
   * net capacities (Constants.TETHER_TIERS[tier].nets: mother / large daughter / small daughter).
   * Loaded nets stay loaded (the new cartridges arrive empty and fill at the stop); `fill` (the save-load replay)
   * loads every launcher full instead. Capacity never drops. No second listener anywhere.
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

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * z-layer fix (A.6): add/remove each daughter's HULL (`arm.mesh`, a child of
   * `arm.group`) to the near-field depth pass based on its distance to the
   * mother, with hysteresis to avoid flip-flop mid-deploy.
   *
   * WHY the hull, not the whole group: everything the daughter renders lives on
   * `arm.mesh`; only the mother-spanning `arm.tetherLine` hangs on `arm.group`.
   * Registering `arm.mesh` brings the hull into the ×S near pass (so it depth-
   * tests correctly against the mother's strut-tip collars and is not occluded
   * by the depth clear) while LEAVING the tether on layer 0 (far pass) — a
   * tether can span from a near daughter out to far debris and must not be
   * scaled into the near sub-render. Because the ×S transform preserves screen
   * projection, the far-pass tether still lines up with the near-pass hull.
   *
   * Only daughters that overlap the mother on screen (i.e. are close) need this;
   * a deployed daughter far away renders fine in the far pass, so it leaves the
   * near set. Distances are in scene units (1 unit = 100 km; M = 1e-5 /m).
   *
   * @param {THREE.Vector3} parentPos mother world position (scene units)
   * @private
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

  /**
   * Update all arms.
   * @param {number} dt - Real-time delta in seconds
   */
  update(dt, opts) {
    const parentPos = this.playerSatellite.position || this.playerSatellite.mesh?.position || new THREE.Vector3();
    const parentQuat = this.playerSatellite.quaternion || null;

    // V5: Pulse scan cooldown tracking
    if (this._pulseScanCooldown > 0) {
      this._pulseScanCooldown -= dt;
      if (this._pulseScanCooldown < 0) this._pulseScanCooldown = 0;
    }

    // V5: Pulse scan completion timer
    if (this._pulseScanActive && this._pulseScanTimer !== undefined) {
      this._pulseScanTimer -= dt;
      if (this._pulseScanTimer <= 0) {
        this._pulseScanActive = false;
        // Gather scan results from all scanning arms
        const detections = []; // Would be populated by SensorSystem
        eventBus.emit(Events.PULSE_SCAN_COMPLETE, { detections });
      }
    }

    // Inject nearby debris data into trawling arms for auto-capture
    const passiveArms = this.arms.filter(a =>
      a.state === ARM_STATES.TRAWLING
    );
    if (passiveArms.length > 0 && this._debrisField) {
      const nearbyDebris = this._debrisField.getUntrackedDebrisNear
        ? this._debrisField.getUntrackedDebrisNear(parentPos, 0.05)  // 5km radius
        : [];
      // Also include tracked debris
      const tracked = this._debrisField.getTargetList ? this._debrisField.getTargetList() : [];
      // Resolve to CANONICAL debris objects by id (getTargetList /
      // getUntrackedDebrisNear hand back sparse/snapshot wrappers). Fishing &
      // web-shot capture store the picked object as their target/capturedDebris,
      // so they must hold the real field object — never a wrapper — to pin,
      // flag, and remove it correctly.
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

    // Power distribution: arm beacon multiplier affects return speed
    // If beacon is offline (0%), returning/hauling arms move at 10% speed
    const armMult = powerDistribution.armMultiplier;
    const speedScale = armMult > 0 ? armMult : 0.1;

    // S8: digestion sun scale — 1.0 in sunlight, ECLIPSE_RATE in eclipse. Reads
    // the resource system's weather solar multiplier (0 = eclipse, 1.0 nominal,
    // 1.3 flare); flare does not overcook (concentrator saturation). Legacy
    // mocks without the getter cook at full rate (byte-identical pre-S8).
    const FTD = Constants.FURNACE_TRANSFER;
    const solarMult = (this._resourceSystem && typeof this._resourceSystem.getSolarPowerMultiplier === 'function')
      ? this._resourceSystem.getSolarPowerMultiplier()
      : 1.0;
    const digestSunScale = solarMult > 0 ? 1.0 : (FTD.TRANSIT_DIGEST_ECLIPSE_RATE ?? 1.0);

    // S13(c): the collar's digestion clock is the SAME law's mother-side
    // consumer (register item 47) — one multiplier SSOT, one per-frame write.
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    if (cns) cns._digestSunScale = digestSunScale;

    for (const arm of this.arms) {
      // Pass speed scale for returning/hauling arms affected by beacon power
      arm._beaconSpeedScale = speedScale;
      arm._digestSunScale = digestSunScale;
      arm.update(dt, parentPos, parentQuat);
    }

    // reel-home (Decisions 5-7): the strut follows a daughter on the reels; the mother turns for her when nothing limits.
    this._updateReelHome(dt, parentPos, parentQuat);
    this._updateCarry(dt);
    this._tickMissionCarry(dt);
    this._tickStrutPressNote(dt);
    this._tickWingClear(dt);        // hold-clear D1: each held catch's wing profile, in budgeted steps (before the holders' writers read it)

    // Wave1: spin/amber the strut reel cartridges per live arm state.
    this._syncTetherDrums();

    // hold-catch (owner 2026-10-22; rebases S9 strut posing, register item 32):
    // a daughter holding a catch keeps her strut at her hold pose (34°, or the
    // lowest plume-clear 5° step, never above 100°) — also a strut the reel left
    // high comes down. Live, NOT flag-gated — this changes how the arm MOVES,
    // never what thrust refuses (THRUSTER_INTERLOCK stays dormant and
    // untouched). Runs AFTER arm.update so aim writes land on fresh positions.
    this._tickNetDuck(dt);          // net-duck: holders duck for an inbound mother net, lift for a neighbour's carry (inputs to the writer below)
    this._tickRadLifts(dt);         // reel-hold D4: ... and lift for the radiator wings moving through the band (third input)
    this._updateCargoPlumePoses(dt);

    // Task 7 (opening-dance plan) — lean-aside safety-net timeout tick.
    this._updateLeanAside(dt);

    // L2: a launch held back by the keep-out gate re-checks its line here.
    this._updateLaunchGates(dt);

    // arms-auto: the daughter arms mostly move themselves (flat idle, 34° near, ...).
    this._updateStrutAuto(dt, !!(opts && opts.noStrutAuto));

    // z-layer fix: toggle each daughter's hull in/out of the near-field depth
    // pass by distance to the mother (runs AFTER arm.update so positions are
    // current for this frame).
    this._updateNearFieldMembership(parentPos);

    // AUTHORITATIVE CATCH PIN (runs AFTER arms move, and after DebrisField.update
    // which ran earlier this frame): force each reeling/docking arm's captured
    // debris — looked up CANONICALLY by id — onto the arm's position, including
    // its rendered instance. This is the definitive fix for the "net + debris
    // drift ~600 m away and vanish during reel-in" bug, which was caused by the
    // debris the arm pinned not being the same object DebrisField rendered.
    if (this._debrisField && this._debrisField.pinCapturedDebris) {
      for (const arm of this.arms) {
        // S6: HOLDING_CATCH reads the parked cargo RACK (heldCatches); the haul
        // states (REELING/DOCKING) read the in-hand scalar — unchanged.
        const pieces = (arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state))
          ? (arm.heldCatches || [])
          : (arm.capturedDebris ? [arm.capturedDebris] : null);
        if (!pieces || pieces.length === 0) continue;
        // PARK-THE-CATCH (2026-06-06): the catch stays FULL SIZE from reel-in,
        // through docking, and while parked on the strut (HOLDING_CATCH) — no
        // stow-shrink/removal any more (furnace transfer is deferred). The old
        // 1.0 → 0.15 dock shrink-then-remove read to the player as "the catch
        // vanishes when it reaches the mother".
        if (arm.state === ARM_STATES.REELING ||
            arm.state === ARM_STATES.DOCKING ||
            arm.state === ARM_STATES.HOLDING_CATCH ||
            _CARRY_STATES.has(arm.state) ||     // trip-melt-2: the rack rides along on the carry
            (arm.state === ARM_STATES.GRAPPLED && arm._rhPinned === true) ||   // reel-home: the net reel winds the pinned catch in
            (arm.state === ARM_STATES.GRAPPLED && arm._toolCatchRidesWithHer?.())) {   // nets-1b review 3: a pad/magnet/gripper catch rides with her in the hold
          for (const d of pieces) {
            if (!d) continue;
            // Item 1: once the staged furnace breakdown begins (debris._breakdownActive,
            // set by ArmUnit at chop start), shrink the ORIGINAL instanced catch out
            // of view so the FurnaceBreakdownVisual's chunk meshes are the only thing
            // the player sees being fed to the furnace. Ramp over the chop phase so
            // the swap reads as the catch coming apart, not popping out. S6: per
            // piece — only the rack's oldest (the piece being chopped) ramps.
            // Round 3 (2026-08-26, V5) — REVIEWED and deliberately left as-is:
            // unlike the collar chop (small-catch W3, which had NO covering
            // visual until the bag deflation), the rack chop is already
            // staged honest — FurnaceBreakdownVisual's chunk stream IS the
            // read, synchronized on the same _digestPhaseT clock, and this
            // ramp is its crossfade by design. (W1 net-reach D2, 2026-10-06:
            // the owner DID name the rack — "net vanishes at the daughter's
            // re-dock" — so the premise "the net stowed at NET_REEL_COMPLETED;
            // the strut holds cargo bare" no longer holds: CaptureNetVisual now
            // CARRIES the real bag on the catch through this chop, deflating on
            // the same FT.chopScaleMul ramp, and fades it at chop end. This
            // ramp itself is unchanged.)
            let scaleMul = 1;
            if (d._breakdownActive) {
              // Phase boundaries from the single authoritative constant (same keys
              // ArmUnit._updateHoldingCatch drives the chop with — no local defaults
              // that could desync the scale-out ramp from the chop window).
              // S8: the ramp reads the progress-derived phase time ArmUnit writes
              // (_digestPhaseT), falling back to stateTimer for legacy mocks.
              // Small-catch plan W3 (2026-08-25): the ramp expression moved to
              // FT.chopScaleMul — the ONE home shared with the collar chop and
              // the collar bag's deflation. Values byte-identical.
              const FT = Constants.FURNACE_TRANSFER;
              const phaseT = arm._digestPhaseT ?? arm.stateTimer;
              scaleMul = FT.chopScaleMul(phaseT);   // 1 → ~0 across the chop window
            }
            // Issue 13 (2026-06-12): honor the arm's standoff pin (_armPinPos =
            // arm.position + holdDir × clearance, set by _pinCatchToSelf) so the
            // catch hangs outboard of the daughter instead of being re-snapped
            // exactly onto her position (daughter rendered INSIDE large catches).
            const pinPos = (d._armPinned && d._armPinPos) ? d._armPinPos : arm.position;
            this._debrisField.pinCapturedDebris(d, pinPos, scaleMul);
          }
        }
      }
    }
  }

  // ==========================================================================
  // trip-melt-2 "carry" — a daughter takes the catch on her rack to her radiator's tip furnace (ArmUnit.beginCarry)
  // ==========================================================================

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
   * petal-single (Decisions 4, 7d): the conditions the gate table was certified for that can change while a daughter waits
   * or carries - the other three petals standing in a certified shared-angle range and not on their way out of it, the
   * other three struts within `NEIGHBOUR_TOL_DEG` of their rest angle - or of their own HOLD POSE when they hold a catch (hold-catch FA3) -
   * and no neighbour holding a catch the carry path was not measured clear of (`NEIGHBOUR_CATCH_MAX_SIZE_M`, or any measured size when the
   * neighbour stands at `NEIGHBOUR_CATCH_HIGH_POSE_DEG` or higher), and her own recorded strut angle inside the swept range.
   * Read-only. `null` = all hold, else `{reason, text}` (every one of them clears by waiting) - except a 'neighbour-catch' whose
   * blocking catch fits no radiator tip: that one carries `never: true` (hold-catch FA6; it leaves her rack by no hand-off) - unless
   * the neighbour can be LIFTED out of the way (net-duck D4: a catch up to 5 m passes once she stands at 69° or higher): then `never`
   * is false and `lift` names who rises (`[{index, rad}]`; the carry's start path commands it, `_commandLifts`; THIS stays read-only).
   * A mother net coming home holds a carry only when it NEEDS the holder a duck has lowered or a lift has to raise ('net-inbound', net-duck
   * R4): it clears by itself at the berth, so it is never `never`. Every other carry goes on as before.
   * u23 `opts.ignoreRealTime` (the trip's unflown hand-over: nothing flies, so only what days of time cannot change counts): the radiators are judged
   * where they SETTLE (`_flowerSettleDeg`: inside the window = fine, outside = 'radiators-angle', `never`), and a neighbour's strut, a net coming
   * in, her own strut's range and a neighbour's catch that can be lifted are skipped; a neighbour's catch that can never leave (`never`) still refuses.
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
    const R2D = 180 / Math.PI;
    const skipRT = opts.ignoreRealTime === true;
    const inRange = (deg) => V.OTHERS_RANGES_DEG.some(([lo, hi]) => deg >= lo - 1e-6 && deg <= hi + 1e-6);
    const sharedDeg = (ps._flowerThetaRad ?? 0) * R2D;
    const targetDeg = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta * R2D : sharedDeg;
    if (skipRT) {
      const settleDeg = this._flowerSettleDeg();
      if (!inRange(settleDeg)) {
        return { reason: 'radiators-angle', never: true, text: `The radiators are settling at ${Math.round(settleDeg)}°, where the hand-off was not tried. Daughter ${n} keeps her catch.` };
      }
    } else if (!inRange(sharedDeg) || !inRange(targetDeg)) {
      return { reason: 'radiators-moving', text: `The radiators are not settled. Daughter ${n} waits.` };
    }
    // net-duck D2/D4/R4: while a mother net is coming home a holder whose catch is in its path is ducked, and a neighbour whose catch
    // blocks this carry cannot be lifted (the corridor is the net's): such a carry waits for the berth (it clears by itself, so `never`
    // is never set for it). A carry that needs neither goes on.
    const inbound = !skipRT && _inboundMotherNetRadiusM(this) !== null;
    const netWait = { reason: 'net-inbound', text: `A net is coming in. Daughter ${n} waits.` };
    for (const o of this.arms) {
      if (!o || o === arm || typeof o.getAimAlpha !== 'function') continue;
      if (inbound && o._netDuck) return netWait;                  // her strut is down for the net by design: off her pose until the berth
      const oDeg = o.getAimAlpha() * R2D;
      const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
      // hold-clear D9: a neighbour whose catch's wing profile is still pending has no hold pose yet (it may rise when the profile lands): the
      // carry waits for it, with the existing 'neighbour-strut' reason (the one every "her strut is not where it belongs yet" wait uses)
      if (!skipRT && held.length && armProfile(o).state === 1) {
        return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1} is still settling her catch. Daughter ${n} waits.` };
      }
      if (!skipRT && Math.abs(oDeg - V.NEIGHBOUR_REST_DEG) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
        // hold-catch FA3: a neighbour holding a catch stands at her HOLD POSE (34..100 deg), which is where she belongs: accepted
        // (the carry was measured against it, see Constants.CARRY.NEIGHBOUR_CATCH_MAX_SIZE_M). Anywhere else (a "." press, a strut on its
        // way) is out of place, as before. net-duck D4: so is the angle she was lifted to for this carry (`_netLift`).
        const hp = held.length ? this._holdPoseCached(o, this.arms.indexOf(o), 0) : null;
        const atPose = !!hp && Math.abs(oDeg - hp.rad * R2D) <= V.NEIGHBOUR_TOL_DEG + 1e-6;
        const atLift = !!o._netLift && Math.abs(oDeg - o._netLift.rad * R2D) <= V.NEIGHBOUR_TOL_DEG + 1e-6;
        if (!atPose && !atLift) {
          return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1}'s strut is out of place. Daughter ${n} waits.` };
        }
      }
      // ... and the catch on her nose is an obstacle the gate never saw: only catches the measurement cleared pass (Constants.CARRY)
      const high = oDeg >= V.NEIGHBOUR_CATCH_HIGH_POSE_DEG - V.NEIGHBOUR_TOL_DEG - 1e-6;
      const blocking = held.filter((h) => !(h.sizeMeter <= V.NEIGHBOUR_CATCH_MAX_SIZE_M + 1e-9
          || (high && h.sizeMeter <= V.NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M + 1e-9)));
      if (blocking.length) {
        // hold-catch FA6: a blocking catch that does not fit a radiator tip never leaves her rack by a hand-off, so waiting does not help
        // (`never`: carryCheck answers retry:false; the trip's end rule stops waiting for it, and "Press C" says this plain reason)
        const tc = ps && ps.tipCargo;
        let never = !!(tc && typeof tc.fits === 'function' && blocking.some((h) => !tc.fits(DebrisField.trueReachM(h, 0))));
        // net-duck D4: a catch up to NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M passes once its holder stands at NEIGHBOUR_CATCH_HIGH_POSE_DEG or
        // higher, and the holder can be LIFTED there (`lift`: the carry's start commands it, `_commandLifts`): so waiting does help,
        // whatever the catch's own fit. `never` stays only when no such angle exists (a catch over 5 m, or every angle 69-100° in a plume).
        const lift = this._liftsFor(arm);
        if (lift.length && lift.some((l) => l.index === o.index)) {
          if (inbound) return netWait;                            // R4: the lift would pull her catch back into the net's path: after the berth
          never = false;
        }
        if (skipRT && !never) continue;                         // u23: waiting (a lift) clears it: real-time, skipped
        const out = { reason: 'neighbour-catch', never, text: `Daughter ${o.index + 1}'s catch is too close to Daughter ${n}'s path. Daughter ${n} keeps hers.` };
        if (lift.length) out.lift = lift;
        return out;
      }
    }
    const recDeg = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() * R2D : NaN;
    if (!skipRT && !(recDeg >= V.STRUT_REC_LO_DEG - 1e-6 && recDeg <= V.STRUT_REC_HI_DEG + 1e-6)) {
      return { reason: 'strut-range', text: '' };
    }
    return null;
  }

  /**
   * u23: the angle (deg) the radiators are SETTLING to: the slew's target (where they stand when it is settled), lowered to the ceiling the bags
   * held on the tips NOW set, as `PlayerSatellite._updateFlower` retargets the slew on its next frame (a bag stowed this very frame has not
   * retargeted it yet, so the live target would be stale). The unflown hand-over judges the radiators here: they are never moved for a carry.
   * @returns {number} degrees
   */
  _flowerSettleDeg() {
    const ps = this.playerSatellite;
    const shared = ps._flowerThetaRad ?? 0;
    let t = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta : shared;
    const tc = ps.tipCargo;
    const band = tc && typeof tc.maxRadiatorThetaRad === 'function' ? tc.maxRadiatorThetaRad() : Infinity;
    if (band !== Infinity && t > band + 1e-9) t = band - (Constants.THERMAL.FLOWER.SETTLE_EPS_RAD || 0);
    return (t * 180) / Math.PI;
  }

  // ==========================================================================
  // u20-nose — the nose route: a catch longer than 0.5 m goes to the mother's nose, then by leash to a tip (Constants.CARRY.NOSE)
  // ==========================================================================

  /**
   * The reach the carry reads a catch by: its drawn reach (`DebrisField.trueReachM`; a typeless piece: half its size). The one place the nose offer reads it.
   * A scoop bag (`isBag`, set by the net lane; absent on pieces today) is a sphere: reach = sizeMeter / 2 (plan u20-nose, coordinator).
   */
  carryReachOf(d) {
    if (d && d.isBag === true && Number.isFinite(d.sizeMeter) && d.sizeMeter > 0) return d.sizeMeter / 2;
    return DebrisField.trueReachM(d, 0);
  }

  /** The tipCargo, the leash driver and the capture-net system as the nose checks read them (any may be null in a bare rig). @private */
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
   * Is this a nose candidate, and is it one the route was certified for? `null` = not a candidate (the caller keeps today's 'gate' refusal): the
   * daughter holds more than one catch, or the catch is row 0 (row 0 has a gate row; it lacking is something else), or the route is switched off.
   * Otherwise `{refusal}` (the reach is in no certified bucket) or `{bucket, reachM, gate}` where `gate` is a stand-in for the GATE row the
   * shared checks read (`swingBackReachM` is not used by the nose).
   * @private
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
   * The catch-centre z (ship frame, metres) of the seat for a catch of reach `reachM` that has no body of its own: the VIRTUAL catch of a bucket's top
   * reach the route is flown for. Same function as a real catch's (`catchHomeDistM`), cached per reach AND per ship shape (`homeShapeKey`: the
   * radiators' angle and the bags on the tips; u22-nose-tipbags: it was keyed on the reach alone and never cleared, so after the radiators were
   * closed over a tip bag the route still flew to the open-angle seat). While the radiators swing the cached seat is reused (see `homeShapeKey`).
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
   * Is the nose free for a catch, and can the leash take it on from there? Null = yes, else `{reason, text, retry, giveUp}`.
   * The nose holds ONE body (`getDockedCatch`), a mother net or a lasso catch on its way keeps it, and the leash is checked as
   * `CaptureNet._tryLeash` checks it before `drv.start` - a free tip that fits, the line's reach from the nose seat, the ship free to turn
   * and the gas for the turn - so a catch never strands at the nose. Read-only. (Prep re-reads it each step through `noseRecheck`.)
   * @private
   */
  _noseHandOverRefusal(arm, nose, mission, ignoreRealTime = false) {
    const n = arm.index + 1;
    const { tc, drv, cns } = this._noseParts();
    const d = arm.heldCatches.find(Boolean);
    // u23 `ignoreRealTime` (the trip's unflown hand-over, which uses neither the nose nor the leash): nose-busy, a busy tip, the leash's own reach and its
    // real-time refusals do not apply; the steering gas for the swing still does (`nose-gas`: physical, the mother's steering gas is not refilled on a trip)
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
   * The conditions the nose route was certified for that can change while a daughter waits or flies the prep: her radiators closed or open
   * inside the bucket's window, the other three struts at the hold pose with catches no bigger than the measured one, her own strut at the
   * hold pose, no mother net coming home. Read-only. `null` = all hold, else `{reason, text, never?}`: every one clears by waiting except a
   * neighbour's catch that is too big and radiators SETTLED outside every window (`never`: 'radiators-angle'; swinging ones are
   * 'radiators-moving' and wait). The window depends on the biggest bag on a tip (`_tipBagReachM`, `noseRadiatorsOk`).
   * @private
   */
  _noseConditions(arm, nose, opts = {}) {
    const V = Constants.CARRY, N = V.NOSE;
    const ps = this.playerSatellite;
    const n = arm.index + 1;
    const R2D = 180 / Math.PI;
    const skipRT = opts.ignoreRealTime === true;                          // u23: the trip's unflown hand-over (see `carryConditions`)
    const b = nose.bucket;
    const sharedDeg = (ps._flowerThetaRad ?? 0) * R2D;
    const targetDeg = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta * R2D : sharedDeg;
    const bagR = this._tipBagReachM();
    const settleDeg = skipRT ? this._flowerSettleDeg() : targetDeg;       // u23: judged where they settle (inside the window: they are only moving, real-time)
    if (skipRT ? !noseRadiatorsOk(b, settleDeg, bagR) : (!noseRadiatorsOk(b, sharedDeg, bagR) || !noseRadiatorsOk(b, targetDeg, bagR))) {
      if (!skipRT && Math.abs(targetDeg - sharedDeg) > 0.01) {          // on their way somewhere: waiting helps once they stop
        return { reason: 'radiators-moving', text: `The radiators are still moving (${Math.round(sharedDeg)}°). Daughter ${n} waits.` };
      }
      // u22-nose-tipbags: SETTLED outside every window. Nothing moves them (a bag on a tip holds them at its cap, and they are never moved for a
      // carry: no auto-close), so waiting never clears it: `never`, the trip's end rule does not wait for it, and the words say what the player can do.
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
      const oDeg = o.getAimAlpha() * R2D;
      if (!skipRT && Math.abs(oDeg - N.HOLD_DEG) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
        return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1}'s strut is out of place. Daughter ${n} waits.` };
      }
    }
    if (!skipRT && !arm._carry) {                                                  // the offer: her own strut stands at the hold pose the route starts from (in prep it is on its way to the seat angle)
      const recDeg = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() * R2D : NaN;
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
   * @private
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
    if (bagR > 0 && sharedDeg <= 1.5) {                                  // closed over a catch on a tip: nothing holds them there, the player closed them (closed is offered only with no catch on a tip: fix round 1)
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
   * Can this daughter start a carry now? Reads, changes nothing. `retry` tells the trip whether waiting can help: a
   * catch that does not fit a tip, a row the gate does not allow and a daughter without the fuel never carry; a busy
   * tip, another carry, a hand-off under way, radiators or neighbour struts that are not where the gate was certified end by
   * themselves. `giveUp` (petal-single, Decision 7e): the answer cannot change by waiting at all (the dock layout, the catch
   * does not fit, the row is not allowed, no tip record): the scheduler marks her so it stops asking until something changes.
   * 'swing-back' (review R8) waits too: the catch is bigger than the gate certified for the radiators' present range (closed/open).
   * `mission`: outside a trip - the leash's mission conditions also apply (the ship is not turning or holding a heading, no
   * daughter is leaving, time is not held) and a launch request for her blocks it.
   * `motherNetOnly` (hold-catch FA1): refuse ('own-catch') unless the piece it would deliver was put on the rack by the mother's
   * net (`_rackFromMotherNet`, set where CaptureNet's cargo flight lands): the mission scheduler's rule.
   * `ignoreGaveUp` (u17b): do not refuse on `_carryGaveUp`, the way `moveCatchToRadiator` clears the flag before it asks
   * ("he asked: a give-up from an earlier try does not count"). It lets the read-only `canMoveCatchToRadiator` answer as C would.
   * `ignoreRealTime` (u23, the trip's unflown hand-over: `deliverUnflown`): skip every refusal that days of time would clear (another carry, the
   * leash or a petal busy, the nose busy, no free tip, the leash's own reach from the nose and its refusals, the radiators still moving, a net
   * coming in, a neighbour's strut) and run every physical one (see the table at `deliverUnflown`). A free tip is the caller's own check.
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
      // her last carry failed on its own: not again until something changes. u23: a mark `scheduleCarry` left for the leash's reach from the
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
    // hold-catch FA1 (owner 2026-10-22 "Keep: radiator right away"): the mission scheduler asks only for catches the MOTHER's net
    // put on this rack (it could not reach a tip at once); a catch the daughter caught herself stays with her ('own-catch' is
    // not a refusal worth a line, and not a give-up: "Press C" asks without this option).
    if (motherNetOnly && !delivered._rackFromMotherNet) return no('own-catch', '', false);
    const cell = Math.max(0, Math.min(1, cellOf(delivered, rack.indexOf(delivered))));
    const reach = this.carryReachOf(delivered);
    if (!tc.fits(reach)) {
      return no('fit', `Daughter ${n}'s catch is too big for a radiator tip. It stays on her rack.`, false, true);
    }
    let row = 0;
    for (const d of rack) row = Math.max(row, this.carryRowOf(d));
    let gate = this.carryGateFor(arm, row, cell);
    // u20-nose: the direct carry has no row for a catch longer than 0.5 m (row >= 1; GATE holds row 0, cell 0 only): that catch can go the
    // other way round, to the nose and then by leash. Only that cause: a second catch on the rack, or a row-0 catch with no gate entry, keeps
    // today's refusal. The direct carry keeps priority: this branch is reached only when it has no row.
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
      if (cond.lift) r.lift = cond.lift;                       // net-duck D4: who can be lifted to let this carry pass (read-only here)
      return r;
    }
    // review R8: no carry starts whose swing BACK (her petal released, the catch in the tip bag, past her strut, her body, the hull
    // and the other petals) is not certified 0.15 m. The gate measured the largest catch reach each range of the radiators
    // allows (closed: the bag passes her own strut close; open: far); a bigger catch waits for the other range - it clears by itself.
    if (!nose) {
      const V = Constants.CARRY;
      const sharedDeg = skipRT ? this._flowerSettleDeg() : (ps._flowerThetaRad ?? 0) * 180 / Math.PI;   // (u23: the unflown check reads where they settle)
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
          strutRad: Constants.CARRY.NOSE.STRUT_DEG * Math.PI / 180, thetaRad: 0, dir: null,
          recordedStrutRad: typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : Constants.CARRY.NOSE.HOLD_DEG * Math.PI / 180,
          nose: { bucket: nose.bucket, reachM: nose.reachM },
        },
      };
    }
    return {
      ok: true, reason: '', text: '', retry: false, giveUp: false,
      plan: {
        tipIndex, cell, delivered, row, mission,
        strutRad: gate.strutDeg * Math.PI / 180, thetaRad: gate.thetaDeg * Math.PI / 180, dir: gate.dir,
        recordedStrutRad: typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : gate.strutDeg * Math.PI / 180,
      },
    };
  }

  /**
   * net-duck D4: the angle (rad) a neighbour HOLDING a big catch rises to so a carry can pass her: max(her hold pose, 69°) on the
   * hold-pose grid, the lowest one at which her catch is out of every Hall exhaust (`heldCargoPlumeConflictAt`), cap 100°; the grid
   * 69° is `NEIGHBOUR_CATCH_HIGH_POSE_DEG`, the angle at which the carry was measured clear of a catch up to 5 m (FA5a). Null when
   * she is not holding, a catch is over `NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M`, or no angle 69-100° clears the exhaust. Read-only.
   * @param {ArmUnit} o
   * @returns {number|null}
   * @private
   */
  _neighbourLiftRad(o) {
    const V = Constants.CARRY;
    const V5 = Constants.OCTOPUS_V5;
    const D2R = Math.PI / 180;
    if (!o || o.isDetached || o.state !== ARM_STATES.HOLDING_CATCH) return null;
    const idx = this.arms.indexOf(o);
    const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
    const big = held.filter((h) => h.sizeMeter > V.NEIGHBOUR_CATCH_MAX_SIZE_M + 1e-9);
    if (!big.length || big.some((h) => h.sizeMeter > V.NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M + 1e-9)) return null;
    const hp = this._holdPoseCached(o, idx, 0);
    if (!hp) return null;
    // hold-clear D9: a lift pose also has to be `rest`-clear of the wings (`rest` is not monotone in the pose); a profile still pending = today's walk
    // (`carryConditions` refuses the carry for a neighbour with a pending profile, so the answer here is not acted on in that time)
    const wp = armProfile(o);
    const deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / D2R), V.NEIGHBOUR_CATCH_HIGH_POSE_DEG), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
      (d) => heldCargoPlumeConflictAt(this, idx, d * D2R) || (wp.state === 2 && !profileClearAt(wp, 'rest', d)));
    return deg === null ? null : deg * D2R;
  }

  /**
   * net-duck D4: every neighbour of `arm` whose catch blocks her carry only because she stands below `NEIGHBOUR_CATCH_HIGH_POSE_DEG`
   * and that CAN be lifted (`_neighbourLiftRad`): `[{index, rad}]`. Read-only; empty when nothing blocks or nobody can lift.
   * @param {ArmUnit} arm
   * @returns {{index:number, rad:number}[]}
   * @private
   */
  _liftsFor(arm) {
    const V = Constants.CARRY;
    const out = [];
    for (const o of this.arms) {
      if (!o || o === arm || o.isDetached || typeof o.getAimAlpha !== 'function') continue;
      const high = o.getAimAlpha() * 180 / Math.PI >= V.NEIGHBOUR_CATCH_HIGH_POSE_DEG - V.NEIGHBOUR_TOL_DEG - 1e-6;
      if (high) continue;
      const rad = this._neighbourLiftRad(o);
      if (rad !== null) out.push({ index: o.index, rad });
    }
    return out;
  }

  /**
   * net-duck D4: the carry's start path (the C key, the mission scheduler, the trip) was refused only by a neighbour's big catch and
   * `carryCheck` named who can lift (`r.lift`): command the lifts and remember that `arm` is waiting for them
   * (`_carryWaitLift`; `_tickLifts` polls `carryCheck` and starts the carry the moment it passes, and puts the neighbours back when
   * the carry has ended). `carryCheck` / `carryConditions` stay read-only (the UI polls them): this is the one writer.
   * @param {ArmUnit} arm the daughter who wants to carry
   * @param {{lift:{index:number, rad:number}[]}} r the refusal
   * @param {object} opts the `carryCheck` options she will be asked with
   * @private
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
   * net-duck D4 / R4: remember that `arm` wants her carry and is waiting for something that clears by itself (a neighbour's lift, a
   * mother net's berth): `_tickLifts` asks `carryCheck` again and starts it the moment it passes.
   * @param {ArmUnit} arm
   * @param {object} opts the `carryCheck` options she will be asked with
   * @private
   */
  _waitForCarry(arm, opts) {
    if (!arm._carryWaitLift) arm._carryWaitLift = { opts: { ...opts }, ageS: 0, pollS: 0, last: null };
  }

  /**
   * net-duck R5: the plain clause that follows "Daughter N keeps her catch:" when a waiting hand-off is given up.
   * @param {{reason?:string}|null} r the last refusal she was given (null: none)
   * @returns {string|null} null: say nothing ('no-catch', 'gave-up')
   * @private
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
      case 'no-catch': case 'gave-up': return null;     // review F2: she is empty / her own last carry failed: there is no catch to "keep", nothing to say
      default: return 'the hand-off cannot start';
    }
  }

  /**
   * net-duck D4, per frame: a daughter waiting for her neighbours' lift (or for a net's berth) asks `carryCheck` again and starts her
   * carry when it passes; a wait that cannot end by itself (a refusal that is not a "wait") or has lasted over `LIFT_WAIT_MAX_S` is
   * dropped - with one Comms line that says why (R5; none when she went on her own way: she started a carry, left, or is empty). The
   * wait's clock stands still while a mother net is coming home (a reel lasts 10-35 s; the hand-off follows the berth, R4). A carry the C
   * key started (`opts.restart`) that the net stopped in its prep restarts after the berth. The lifted neighbours stay up while any
   * daughter waits or carries, and go back (their "." press, if one waited, now applies) when none does.
   * @param {number} dt
   * @private
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
            if (!q.ok) why = this._handoffGiveUpClause(q);          // review F3: `beginCarry` refused after a passing check: say so (R5)
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
    // net-duck R4: a carry the player asked for (`opts.restart`: the C key) that a mother net stops in its prep is not dropped:
    // `_tickLifts` restarts it after the berth. The trip's and the mission's own schedulers ask again by themselves.
    if (opts.restart === true) arm._carryRestart = { opts: { ...opts }, sawNet: false };
    return c;
  }

  /**
   * One look of a carry scheduler: start the first daughter that can carry (first free tip first, ties by daughter index).
   * A refusal that cannot clear by waiting marks her (`_carryGaveUp`: the scheduler stops asking); the ones worth a line say it
   * once per `said` key. The trip calls it on its own cadence while it burns. (Outside a trip nothing calls it any more:
   * hold-catch, owner 2026-10-22 — a daughter keeps her catch; "Press C" -> `moveCatchToRadiator` starts one.)
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
      if (r.giveUp) { arm._carryGaveUp = true; arm._carryGaveUpWhy = r.reason; }   // (u23: why, so the unflown hand-over can tell a real-time mark from a physical one)
      // net-duck D4: a neighbour's big catch is the only thing in the way and she can be lifted: lift her (the carry starts by itself)
      if (r.reason === 'neighbour-catch' && r.lift) { this._commandLifts(arm, r, { mission, motherNetOnly }); continue; }
      // (FA6: a neighbour's catch that can never leave is said too - once - or the catch just stays on her rack in silence)
      const sayIt = say && r.text && (r.reason === 'fit' || r.reason === 'gate' || r.reason === 'fuel' || r.reason === 'swing-back'
        || r.reason === 'nose-reach' || r.reason === 'nose-leash' || r.reason === 'nose-gas' || r.reason === 'radiators-angle'
        || (r.reason === 'neighbour-catch' && !r.retry));
      if (sayIt) {
        const key = r.sayKey || `${arm.index}|${r.reason}`;                  // swing-back: once per catch
        if (said && !said[key]) { said[key] = true; say(r.text); }
      }
    }
    return null;
  }

  /**
   * u23 (owner 2026-10-24, "Show one, finish rest"; DECISIONS §33 row 17: "many hours or days of realtime to melt debris. and many hours or days to move
   * between debris fields"): hand ONE rack catch to a radiator tip WITHOUT flying it. The trip shows one pass and delivers every other catch this way, in
   * the days the flight takes: the same checks as the flown carry (`carryCheck`) minus every refusal that days of time would clear, then the same end state
   * (`ArmUnit.stowUnflown` -> `_stowOnTip`, the one function a flown stow ends in) and her fuel billed as a flown carry bills it. Nothing is said when a
   * delivery is made (the melt lines and the trip's one summary line are the words).
   *
   * The reason table (`carryCheck(arm, {ignoreRealTime: true})`; flown = what a flown carry does, unflown = what this does):
   *   state          not at her dock (out, or in a carry)                   -> STAYS   (she is not here)
   *   gave-up        a carry of hers failed in flight                       -> STAYS   (physical; a mark left for 'nose-leash' alone does not count)
   *   no-catch       nothing on her rack                                    -> STAYS
   *   no-tip/layout  no tip store / not the certified dock ring             -> STAYS
   *   fit            the catch is too big for any tip                       -> STAYS
   *   gate           no gate row and not a nose candidate                   -> STAYS
   *   nose-reach     in no certified nose size                              -> STAYS
   *   fuel           her tank is under the hand-off's cost                  -> STAYS, while it is under. Nothing here holds her tank down: docked, she swaps a
   *                  fresh indium cartridge in from the mother's store (`ArmUnit._updateIndiumSwap`, no trip check), so with indium in the store she
   *                  refills seconds later and the next call delivers her catch; it stays for good only when the store is empty (physical: no fuel aboard)
   *   nose-gas       the mother's steering gas cannot pay the swing         -> STAYS   (a yes/no gate; nothing is billed: it has no amount)
   *   radiators-angle  they settle outside the certified window             -> STAYS   (radiators are never moved for a carry: DECISIONS line 37, §38 row 4)
   *   swing-back     the swing back needs the other radiator range          -> STAYS   (a radiator-angle clearance, same reason)
   *   neighbour-catch a neighbour's catch can never leave (no lift)         -> STAYS   (days do not move it)
   *   carry-busy, leash-busy, mission-*  another carry, the leash or a petal on its own -> GOES (real time)
   *   nose-busy      the nose holds another catch                           -> GOES    (no nose is used)
   *   nose-leash     the leash cannot reach it from the nose                -> GOES    (no leash is used; plan D2)
   *   radiators-moving  judged at where they settle (`_flowerSettleDeg`)    -> inside the window GOES, outside = radiators-angle
   *   net-inbound, neighbour-strut, strut-range, neighbour-catch with a lift -> GOES   (clear by waiting)
   *   tip-busy       her own tip (radial) / every tip (nose route) is full  -> WAITS   (this call's own check: delivered once a melt frees one)
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
      if (!(arm.fuel >= pct)) continue;                                                // (carryCheck passed it a moment ago)
      if (!arm.stowUnflown(plan.delivered, tip)) continue;
      arm.fuel -= pct;                                                                 // her thrusters would start and stop her: billed as a flown carry bills it
      return { arm, tipIndex: tip, nose };
    }
    return null;
  }

  /** u23: the trip has started its one shown pass: no daughter waits any more for a neighbour's lift or a net's berth to start a flown carry of her own. */
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
    // hold-catch FA7: the lines already said (a hand-off refusal, "too big for a tip") start over after a trip, as on main
    if (!this._tripPhase) { this._missionCarryAgeS = 0; this._missionTipsTaken = null; this._missionCarrySaid = Object.create(null); this._allFullSaid = false; }
  }

  /**
   * hold-catch (owner 2026-10-22: "daughters that catch debris should hold it ... Transfer to radiator strut is risky,
   * should be an option when all daughters are full, not automatic"): outside a trip a daughter KEEPS the catch she made. The
   * petal-single scheduler that started a hand-off by itself every `MISSION_CHECK_S` now asks only for a catch the MOTHER's net
   * put on a rack because no radiator tip was free (`_rackFromMotherNet`, set where CaptureNet's cargo flight lands; owner
   * "Keep: radiator right away"): it goes to a tip as soon as one is, as before. The rest is bookkeeping (a give-up clears when
   * she leaves the dock or any tip frees, so a later "Press C" can try again) and the one line that tells the player the choice
   * is his: when every daughter is aboard holding a catch, say it once (`_sayAllFull`). The mother's OWN nose catches are not here:
   * CaptureNet._tryLeash -> LeashDriver send them to a free radiator tip right away, as before. On a trip
   * `TransferTrip._tickCarry` owns the hand-offs (`_tripPhase` set), automatic as before.
   * @private
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
        for (const k of Object.keys(said)) if (k.startsWith(`${a.index}|`) && !k.includes('|swing-back|')) delete said[k];   // (swing-back: once per catch, its key names the catch)
      }
    }
    // FA1: a catch the mother's net racked goes to a free radiator tip by itself (a daughter's own never does)
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
   * hold-catch FA2: all full -> ONE line, and "Press C" only when C can work. Every daughter's hand-off outlook is read through
   * `carryCheck` (a mission carry): 'now' = it would start now (fits a tip, its tip is free, the gate allows it); 'later' = waiting
   * can help (a busy tip, the radiators or the ship are moving); 'never' = it cannot go (too big for a tip, no gate row, no fuel).
   * Said once per time they become full; "Press C" is said once more if the first line had to leave it out and a hand-off then
   * becomes possible. No catch that fits -> the daughters are full and the line says nothing about C. Re-armed when one is not full.
   * @private
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
   * hold-catch FA2: can this daughter's catch go to a radiator tip - now, later, or never? Read-only (`carryCheck`, a mission carry).
   * 'gave-up' counts as 'later': "Press C" clears it and asks again.
   * @param {ArmUnit} arm
   * @returns {'now'|'later'|'never'}
   */
  _handoffOutlook(arm) {
    const r = this.carryCheck(arm, { mission: true });
    if (r.ok) return 'now';
    return (r.retry || r.reason === 'gave-up' || r.reason === 'radiators-angle') ? 'later' : 'never';   // radiators-angle: C says what to do with them
  }

  /** hold-catch FA4: a "." line held back for the double-press window is said once the window has passed with no second press. @private */
  _tickStrutPressNote(dt) {
    const p = this._pendingStrutNote;
    if (!p || !(dt > 0)) return;
    p.leftS -= dt;
    if (p.leftS > 0) return;
    this._pendingStrutNote = null;
    eventBus.emit(Events.COMMS_MESSAGE, { source: 'SPACECRAFT', channel: 'CMD', text: p.text, priority: 'info' });
  }

  // ── hold-clear (owner 2026-10-23): a held catch never touches a radiator wing ─────────────────────────────────────────────────────

  /**
   * hold-clear D1, per frame: start a wing profile (HoldWingClear) for every racked catch of a daughter parked HOLDING_CATCH whose attitude is
   * frozen (`_qLocalHer`) and that has none valid for where it sits (same arm, cell, attitude, size, radiator kit), and spend
   * `HOLD_CLEAR.UNITS_PER_FRAME` work points on the queue, oldest first - a fixed count, never a clock. With nothing queued the radiator
   * kit is still built ahead (half a frame's points per frame) so the first stow finds it ready. A ship with no radiator kit (a bare stub) starts
   * nothing: today's behaviour everywhere. Also ends `_netBlock` for a daughter who no longer holds a catch at home.
   * @param {number} dt
   * @private
   */
  _tickWingClear(dt) {
    const ps = this.playerSatellite;
    const HC = Constants.HOLD_CLEAR;
    if (HC.ENABLED === false || !ps || !Array.isArray(ps._flowerGroups) || ps._flowerGroups.length === 0 || typeof ps._writeFlowerPose !== 'function') return;
    if (!this._wingQueue) this._wingQueue = [];
    const q = this._wingQueue;
    const kit = kitFor(ps);                                   // (re)built when the radiator kit changed
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm) continue;
      if (!_holdsCatchAtHome(arm)) { if (arm._netBlock) arm._netBlock = false; continue; }
      for (const h of arm.heldCatches) {
        if (!h || !h.mass || !h._qLocalHer || !h._rackLocalM) continue;     // her attitude and cell are not fixed yet
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
   * hold-clear D1: finish this daughter's pending wing profiles NOW, spending at most `PENDING_FORCE_POINTS` work points (about 50 ms) on ALL of
   * them together: the mother-net press asks, so it can decide on a finished profile. The cap is on the work actually done, not on an estimate
   * of it (round 1 F3: the estimate was 3-6x low and a forced step could stall a frame for 13-37 ms more): what the points did not finish stays
   * pending (the progress is kept; the frame ticks go on with it) and the press says she is still stowing. @returns {boolean} true when none is pending afterwards
   * @private
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
   * hold-clear D5 (owner 2026-10-23, "Net refuses, says why"): would a mother net for `target` be held back by a holder? The index of the first
   * daughter HOLDING_CATCH whose catch fouls the net's berth corridor (radius `target.sizeMeter / 2 + BERTH_CLEARANCE_M`) at her live strut
   * angle and for whom some grid pose clears the net but none of those is wing-clear (`_duckPlan` kind 2: the same decision the duck makes);
   * -1 when none, or the target has no size. A catch whose wing profile is pending is finished now if the work left is small, else the answer is
   * that daughter with `_netBlockKind` 'pending' (the press says she is still stowing); 'wing' otherwise. A holder for whom no pose clears the net at all
   * is today's case (34° + the corridor gate), not refused. Pure read apart from finishing a pending profile and `_netBlockKind`.
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
    }
    return -1;
  }

  /**
   * hold-clear D5/D8: the plain line for a refused mother-net press naming daughter `index` (from `motherNetHolderBlock`), and - for a wing
   * refusal - the `_netBlock` mark that lets C move her catch (D6). The C clause is said only when `canMoveCatchToRadiator` passes for her
   * with the mark set. @param {number} index @returns {string}
   */
  motherNetBlockLine(index) {
    const arm = this.arms[index];
    const n = index + 1;
    if (this._netBlockKind === 'pending') return `Daughter ${n} is still stowing her catch; try again in a moment.`;
    if (arm) arm._netBlock = true;
    const c = arm && this.canMoveCatchToRadiator(index) ? ' C moves it to a radiator.' : '';
    return `Mother net held: Daughter ${n}'s catch can't get out of its way without touching a radiator. K lets her catch go.${c}`;
  }

  /** hold-clear D6: a mother net has fired (a shot nobody blocked): no refusal mark outlives it. */
  clearNetBlocks() {
    for (const a of this.arms) if (a) a._netBlock = false;
    this._netBlockKind = null;
  }

  /**
   * hold-catch: true when every daughter that can still fly (not detached, not expended) is aboard holding a catch, and at
   * least one is: none can launch for a new catch. A daughter on a carry is not "holding" (she is busy moving one).
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
   * u17b: the checks `moveCatchToRadiator` makes BEFORE it asks `carryCheck`, in its order, with no comms line and no state change:
   * not on the trip, no hand-off running, somebody holds a catch, and no daughter is free (every one that can still fly holds one).
   * One copy, so the read-only `canMoveCatchToRadiator` and the C key can never disagree about them.
   * @private
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
      // hold-clear D6 (owner 2026-10-23): a holder the mother net refused for (`_netBlock`) or whose catch cannot be held clear of the radiators
      // (`wingBlocked` hold pose) may go to a radiator tip even while another daughter is empty: only those holders are returned
      const stuck = holders.filter((a) => a._netBlock === true || this._holdWingBlocked(a));
      if (stuck.length > 0) return { ok: true, holders: stuck };
      const away = free.state !== S.DOCKED && free.state !== S.RELOADING;
      return { ok: false, text: `Daughter ${free.index + 1} is ${away ? 'out' : 'free'}; catches stay with the daughters until all are full.` };
    }
    return { ok: true, holders };
  }

  /** hold-clear D6: is this holder's hold pose `wingBlocked` (no pose up to 100° keeps her catch off the radiators)? @private */
  _holdWingBlocked(arm) {
    const hp = arm && Array.isArray(arm.heldCatches) ? this._holdPoseCached(arm, this.arms.indexOf(arm), 0) : null;
    return !!hp && hp.wingBlocked === true;
  }

  /**
   * u17b (owner pick 2026-10-22, TO RADIATOR button on a DAUGHTERS row): would `moveCatchToRadiator(index)` start THIS daughter's
   * hand-off right now? Read-only: no comms line, no state change (`carryCheck` writes nothing but a short-lived hold-pose memo).
   * True only when she is a holder, every daughter that can still fly holds a catch, no trip / hand-off is running, and a mission
   * `carryCheck` passes for her (fits a tip, gate row, fuel, free tip, radiators settled, neighbour struts). An earlier give-up
   * (`_carryGaveUp`) does not count: C clears it and asks again, so the getter ignores it the same way. Not covered: the daughter's own
   * `beginCarry` can still refuse after a passing check (no tip record, no petal hold); that marks her gave-up and says nothing.
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
    return r.ok === true || (r.reason === 'neighbour-catch' && !!r.lift);   // net-duck D4: C lifts the neighbour first, then carries
  }

  /**
   * hold-catch (owner 2026-10-22, "Press C"): the player's choice to move ONE daughter's catch to a radiator tip, only when
   * every daughter is full. Starts one hand-off through the same `carryCheck` / `requestCarry` / `beginCarry` path the trip
   * uses (a mission carry: the hand-off ends with "puts her catch on radiator N's tip; she is free again"). The selected
   * daughter if she holds a catch, else the first holding one that can go (lowest number first; if none can, the first one's
   * reason is the line). Never on a trip (the trip hands them off by itself), never while a hand-off runs, never while a
   * daughter is free. Every outcome that moves nothing says why, in one comms line.
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
    // FA2: with nobody selected, the line names the first daughter whose hand-off can still happen (waiting helps), not a
    // catch that never fits a tip while another one only waits for her tip
    let first = null;
    let netWait = null;                                      // net-duck R4: the first daughter only a mother net's berth holds back
    for (const arm of order) {
      arm._carryGaveUp = false;                              // he asked: a give-up from an earlier try does not count
      const r = this.carryCheck(arm, { mission: true });
      if (r.ok) {
        const started = this.requestCarry(arm, { mission: true, restart: true });
        if (started.ok) {
          if (started.plan && started.plan.kind === 'nose') {         // u20-nose: no tip yet - the leash picks one once the nose has the catch
            return finish({ ok: true, arm, nose: true, text: `Daughter ${arm.index + 1} takes her catch to the nose; the leash then moves it to a radiator.` });
          }
          const tip = (arm._carry && Number.isInteger(arm._carry.tipIndex)) ? arm._carry.tipIndex : arm.index;
          return finish({ ok: true, arm, text: `Daughter ${arm.index + 1} takes her catch to radiator ${tip + 1}.` });
        }
        if (!first || !first.r.retry) first = { arm, r: started };
        continue;
      }
      // net-duck D4: only a neighbour's big catch is in the way and she can rise out of it: she does, and this daughter's hand-off follows
      if (r.reason === 'neighbour-catch' && r.lift) {
        this._commandLifts(arm, r, { mission: true, restart: true });
        const who = r.lift[0].index + 1;
        return finish({ ok: true, arm, lifting: true, text: `Daughter ${who} raises her catch to make room; Daughter ${arm.index + 1}'s hand-off follows.` });
      }
      if (r.reason === 'net-inbound') { if (!netWait) netWait = arm; continue; }
      if (!first || (!first.r.retry && r.retry)) first = { arm, r };
    }
    // net-duck R4: nobody could start, and a net coming home is what holds one back: she asked, so her hand-off follows the berth
    if (netWait) {
      this._waitForCarry(netWait, { mission: true, restart: true });
      return finish({ ok: true, arm: netWait, waiting: true, text: `A net is coming in. Daughter ${netWait.index + 1}'s hand-off follows the berth.` });
    }
    return finish({ ok: false, text: this._carryRefusalText(first.arm, first.r) });
  }

  /** @private one plain sentence for a `carryCheck` refusal that has no text of its own */
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

  /** A new trip: every daughter may try a carry again (`_carryGaveUp` cleared). */
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
   * Can any rack catch still be carried - now, or once her tip frees / the hand-off ends / the bag in the way melts?
   * The trip's end rule waits for it. A catch that never carries (too big for a tip, a row the gate does not allow, no
   * fuel: fuel does not come back on the trip) does not count.
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
   * Per frame: a daughter in CARRY_PREP whose strut has nobody to slew it (a headless rig with no strut groups) is
   * slewed here, as reel-home does. In the game `PlayerSatellite._updateStruts` slews to `_strutTargetAlpha`.
   * @private
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

  // ==========================================================================
  // reel-home — the strut follows a daughter on the reels, the mother turns to meet her line
  // ==========================================================================

  /**
   * reel-home (Decisions 5, 6). For every daughter on the reels (her net winding the catch in, or on the strut line):
   *  - the strut's target angle follows her (the swing-plane angle nearest the direction hinge -> her, clamped to
   *    REEL_HOME.STRUT_MIN_DEG..STRUT_MAX_DEG, at the existing slew rate); the strut is `_aimReserved` so StrutAuto
   *    leaves it alone (the arm releases it when it leaves the reels);
   *  - the mother turns to bring her into the strut's swing plane when she is off it by more than PLANE_TOL_DEG and
   *    nothing limits the mother (`_motherTurnBlock(arm)`). One daughter owns the turn at a time, first come.
   * Off with the flag.
   * @private
   */
  _updateReelHome(dt, parentPos, parentQuat) {
    const on = Constants.isFeatureEnabled('REEL_HOME');
    const RH = Constants.REEL_HOME || {};
    const D2R = Math.PI / 180;
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const homers = [];
    for (const arm of this.arms) {
      if (!arm) continue;
      const home = on && arm.isReelingHome === true && !arm.isDetached;
      if (!home) {
        arm._rhSeq = 0;
        arm._rhMotherWorking = false;
        arm._rhGapFn = null;
        arm._rhHold = null;                 // reel-hold D8: no hold or floor refusal outlives her reel
        arm._rhFloorRefused = false;
        arm._rhFloorSpent = false;
        continue;
      }
      if (!arm._rhSeq) arm._rhSeq = ++this._rhSeq;
      homers.push(arm);
      // Decision 5: the strut points at her
      if (Number.isFinite(arm._rhBestAlpha)) {
        const a = Math.max((RH.STRUT_MIN_DEG ?? 34) * D2R, Math.min((RH.STRUT_MAX_DEG ?? 180) * D2R, arm._rhBestAlpha));
        if (!arm._aimReserved) { arm._aimReserved = true; arm._rhReserved = true; }
        arm._strutTargetAlpha = a;
        if (headless && typeof arm.setAimAlpha === 'function') {
          arm.setAimAlpha(a, dt);                                       // production slews once, in _updateStruts
          if (Math.abs(arm.getAimAlpha() - a) < 0.01) arm._strutTargetAlpha = undefined;
        }
      }
      if (!arm._rhGapFn) arm._rhGapFn = (pos, pp, pq) => this._rhGapAt(arm, pos, pp, pq);
    }
    this._tickReelHomeTurn(homers, parentQuat, dt);
  }

  /**
   * reel-home (Decision 6): who turns the mother, and when. The earliest daughter on the reels owns the turn until she
   * leaves them (docks, loses her catch, ...); the next in line takes it then. The owner asks for a turn when she is off
   * the strut's swing plane by more than PLANE_TOL_DEG, or (once in the plane) below the strut's STRUT_MIN_DEG..STRUT_MAX_DEG
   * range by more than that; the mother is free (`_motherTurnBlock(owner)`) and the turn is
   * not bigger than TURN_MAX_DEG; each request is one scripted attitude turn (the same one the leash hand-off uses), and
   * the geometry is re-read when it ends. A request is made at most once per TURN_RETRY_S (a refusal counts), so a mother
   * who was busy at the first look is asked again a second later, not never; the autopilot being engaged ends a running
   * turn (it steers the ship back to its own heading, so she lines herself up). The turn axis has no component along the
   * nose (the ship has almost no roll authority): for the plane error it is the strut's radial direction; for the range
   * error it is the plane's normal t, the angle that brings her to the nearer end of the range.
   * reel-turn (owner 2026-10-21, "strange oscillations ... not good"): the PLANE turn is closed loop. It is a tracked turn
   * (`requestAttitudeTurn` with `opts.track`): every frame `_rhTrackPlane` reads the angle left from her live place relative
   * to the ship's centre (`planeTurnLeftRad`: the turning axis runs through the centre, the strut hinge hangs ~1 m off it),
   * and the autopilot's rate law (√(2·α·left), α = the couples' own, at most the 5°/s peak) brakes to rest on it. It starts
   * beyond PLANE_TOL_DEG and ends inside half of it (hysteresis), or when her lever on the axis is gone (more than
   * TURN_MAX_DEG left). Before, the angle was fixed once while she was ~13 m out: she reeled in during the 8-11 s turn, the
   * same rotation moved her plane angle 1.3-1.4x as far near the strut, the turn overshot, the next request reversed it, and
   * the reel went hold -> pull -> hold -> pull (up to 7 toggles). The range turn is still one fixed profile.
   * `_rhMotherWorking` tells each daughter whether the mother is turning (or may still be asked to) for her.
   * @private
   */
  _tickReelHomeTurn(homers, parentQuat, dt = 0) {
    const RH = Constants.REEL_HOME || {};
    const D2R = Math.PI / 180;
    // the owner: the earliest arrival still on the reels
    let owner = null;
    for (const a of homers) if (!owner || a._rhSeq < owner._rhSeq) owner = a;
    this._rhOwner = owner;
    for (const a of homers) {
      a._rhMotherWorking = false;
      if (a._rhTurnWaitS > 0) a._rhTurnWaitS = Math.max(0, a._rhTurnWaitS - dt);
    }
    if (this._rhTurn && this._rhTurn.arm !== owner) this._rhAbortTurn();     // its daughter has left the reels
    const apNow = this._autopilot;
    // D11b: the autopilot engaged while the turn runs. It steers the ship back to its own heading, so the turn is cancelled
    // and she lines herself up (the check before a request, `_motherTurnBlock`, then keeps new ones away).
    if (this._rhTurn && apNow && apNow.engaged === true) this._rhAbortTurn();
    if (this._rhTurn && apNow && typeof apNow.isTurning === 'function' && !apNow.isTurning()) {
      this._rhEndTurn(apNow);                                                  // the turn is over: let the attitude go
    }
    if (!owner) return;
    if (this._rhTurn) { owner._rhMotherWorking = true; return; }             // her turn is running
    if (owner._rhTurnWaitS > 0) return;                                       // D11a: asked a moment ago; look again later
    const v = owner._rhRelShip;
    if (!v) return;
    const az = owner._rhAzRad();
    const tol = (RH.PLANE_TOL_DEG ?? 5) * D2R;
    // Which error does the turn correct? First the one across the strut's swing plane (a turn about the strut's radial
    // direction). Once she is in the plane, the one along it (fix round F2a): the strut can only point at [STRUT_MIN,
    // STRUT_MAX], so a daughter below the floor needs the mother turned about the plane's normal until she is inside.
    let theta;
    let axisL;
    let tracked = false;
    if (Math.abs(owner._rhPlaneErrRad) > tol) {
      // reel-turn (owner 2026-10-21, "strange oscillations ... not good"): the turn is CLOSED LOOP. The angle left is read from
      // her live place every frame (`_rhTrackPlane`), because she reels in during the turn and the strut hinge hangs ~1 m off
      // the turning axis: an angle fixed at the request overshot, the next request reversed it, and the reel held and pulled
      // by turns. Without the ship's place (a headless stub) the old open-loop angle from the hinge direction stays.
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
      theta = _rhFloorTheta(v, az, RH);                                         // turning the ship by +t moves her angle by +t (reel-hold: shared with `reelHoldReason`)
      if (theta === 0) return;                                                  // the strut can point at her
      if (Math.abs(theta) <= tol) return;                                       // a few degrees short: the 2 m check decides
      axisL = _rhAxisR.set(-Math.sin(az), Math.cos(az), 0);                     // the plane's normal
    }
    if (Math.abs(theta) > (RH.TURN_MAX_DEG ?? 60) * D2R || Math.abs(theta) < 1e-3) return;
    const ap = this._autopilot;
    if (!ap || typeof ap.requestAttitudeTurn !== 'function') return;
    if (this._motherTurnBlock(owner)) return;                                 // limited: the line-up is hers to do
    const pq = parentQuat || (this.playerSatellite && this.playerSatellite.quaternion);
    if (!pq) return;
    const axisW = new THREE.Vector3().copy(axisL).applyQuaternion(pq);
    owner._rhTurnTries++;
    owner._rhTurnWaitS = RH.TURN_RETRY_S ?? 1;                                // the next request, if this one fails, in a second
    const turn = { arm: owner, tracked };
    const opts = { holdOwner: 'REEL_HOME', holdS: 30, maxWaitS: 60 };   // sloth mode backstop (D7): `_motherTurnBlock` already refuses
    if (tracked) {
      opts.track = () => this._rhTrackPlane(turn, owner, az, tol);
      opts.timeoutS = 60;                                                     // a moving target: the planned-time default is too short
    }
    this._lockExceptArm = owner;                                              // the lock check inside the request
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
    if (refusal) { if (!tracked) owner._rhFloorRefused = true; return; }      // refused at once: nothing moved (reel-hold: no floor turn is possible, so no floor hold)
    if (!tracked) owner._rhFloorRefused = false;
    this._rhTurn = turn;
    owner._rhMotherWorking = true;
  }

  // ==========================================================================
  // reel-hold (owner 2026-10-23): a daughter waits 5 m out until the floor turn is done and the radiators are clear
  // ==========================================================================

  /**
   * reel-hold D2a: is a mother FLOOR turn (the one that brings her angle in the strut's plane up to the 34° floor) running for
   * her, or would one be asked for her now? True when she is in her strut's plane (the plane turn comes first and is not
   * this), short of the floor by more than PLANE_TOL_DEG and by no more than TURN_MAX_DEG (the turn is not asked for beyond it:
   * she lines herself up), no refusal of her floor request stands (`_rhFloorRefused`: steering gas low, roll axis, ... a
   * refused turn is "no turn possible"), and either her turn is running or the mother is free for her
   * (`_motherTurnBlock(arm)`, an autopilot to turn with). The angle is `_rhFloorTheta`, the one `_tickReelHomeTurn` reads.
   * A daughter that is not the owner of the turn is asked as if she were: she waits and gets her turn when she becomes it.
   * Pure read.
   * @param {ArmUnit} arm
   * @returns {boolean}
   * @private
   */
  _rhFloorWanted(arm) {
    const RH = Constants.REEL_HOME || {};
    const v = arm._rhRelShip;
    if (!v || arm._rhFloorRefused === true) return false;
    const tol = (RH.PLANE_TOL_DEG ?? 5) * Math.PI / 180;
    if (Math.abs(arm._rhPlaneErrRad) > tol) return false;                       // the plane turn is first (the start-of-reel turn: untouched)
    const theta = _rhFloorTheta(v, arm._rhAzRad(), RH);
    if (theta === 0 || Math.abs(theta) <= tol) return false;                    // inside the range, or a few degrees short (the 2 m check decides)
    if (Math.abs(theta) > (RH.TURN_MAX_DEG ?? 60) * Math.PI / 180) return false; // no turn is asked: the line-up fallback runs as before
    const t = this._rhTurn;
    if (t && t.arm === arm && !t.tracked) return true;                           // her floor turn is running
    const ap = this._autopilot;
    if (!ap || typeof ap.requestAttitudeTurn !== 'function') return false;
    if (!(this.playerSatellite && this.playerSatellite.quaternion)) return false;
    return !this._motherTurnBlock(arm);
  }

  /** reel-hold: the wing angle band as radians {lo, hi}, written into a scratch (no allocation). @private */
  _radBand() {
    const R = Constants.REEL_HOLD || {};
    const out = this._radBandScratch || (this._radBandScratch = { lo: 0, hi: 0 });
    out.lo = (R.BAND_LO_DEG ?? 55) * Math.PI / 180;
    out.hi = (R.BAND_HI_DEG ?? 130) * Math.PI / 180;
    return out;
  }

  /**
   * reel-hold: do the radiator wings stand strictly inside the band now? false for a ship with no radiators or a stub. The band's
   * edge itself is outside: wings the drive parked there (a dropped move) leave the holders at their hold pose.
   * @private
   */
  _wingsInBand() {
    const ps = this.playerSatellite;
    const th = ps && ps._flowerThetaRad;
    if (!Number.isFinite(th)) return false;
    const b = this._radBand();
    return th > b.lo + 1e-6 && th < b.hi - 1e-6;
  }

  /**
   * reel-hold: are the wings moving on a path that enters, crosses or leaves the band (a target is set and the segment from
   * where they are to where they go touches [BAND_LO, BAND_HI])? Wings that stand still are not "moving": nothing would
   * ever end such a wait, and the docked holders are lifted for them anyway (`_tickRadLifts`). @private
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

  /** reel-hold: does she hold a catch (in hand or on her rack)? @private */
  _holdsAnyCatch(arm) {
    return !!(arm && ((arm.capturedDebris && arm.capturedDebris.mass)
      || (Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass))));
  }

  /**
   * reel-hold D2: why a reeling daughter must wait HOLD_M out from her strut tip, or null. `'floor'`: a mother floor turn is
   * running or askable for her and her angle is short of the 34° floor (`_rhFloorWanted`; a hold of more than FLOOR_CAP_S
   * is ArmUnit's to end, `_rhHold.capped`). `'radiators'`: she carries a catch and the wings are moving through the band
   * (`_wingsMovingInBand`). Pure read; ArmUnit reads it every reeling frame (`_rhHoldStep`).
   * @param {ArmUnit} arm
   * @returns {'floor'|'radiators'|null}
   */
  reelHoldReason(arm) {
    if (!arm || arm.isDetached || arm.state !== ARM_STATES.REELING || arm._rhHome !== true) return null;
    if (!arm._rhFloorSpent && this._rhFloorWanted(arm)) return 'floor';        // F3: a floor hold that was capped / refused does not hide the radiator reason
    if (arm.capturedDebris && this._wingsMovingInBand()) return 'radiators';
    return null;
  }

  /**
   * net-duck / hold-clear: does daughter `i`'s catch stand in the berth corridor of radius `radiusM` (anchor in `_duckAnchor`, set by `_duckPlan`) with
   * her strut at `rad`? The one read `_duckPlan` makes (a seam, like `_plumeConflictAt`: with the real meshes the foul is monotone in the angle - 0 of
   * 2652 configs x 8 corridor radii and 0 of 44 scoop balls x 8 radii foul at 34° but not higher, tmp/f4-nonmono.mjs - so a test sets the corridor the meshes never make).
   * @private
   */
  _corridorFoulAt(i, rad, radiusM) {
    return heldCargoFoulsCorridorAt(this, i, rad, _duckAnchor, radiusM);
  }

  /** reel-hold: would daughter `i`'s catch be in a Hall exhaust with her strut at `rad`? The one read `_radClearPose` makes (a seam: a test sets a plume the real geometry never makes). @private */
  _plumeConflictAt(i, rad) {
    return !!heldCargoPlumeConflictAt(this, i, rad);
  }

  /**
   * reel-hold D4 (T1, tmp/plans/reel-hold.md): the lowest strut angle on the hold-pose grid at which a holder's catch stays
   * CLEAR_M off every wing in the band AND out of every Hall exhaust, from max(her hold pose, the measured band-clear angle
   * for her biggest catch) up to HOLD_POSE_MAX_DEG; null = none (the wings must not move: 'never'). Cached like `_holdPoseCached`
   * (re-read when her rack changes, or every 0.5 s). Read-only. @private
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
      const D2R = Math.PI / 180;
      const wp = armProfile(arm);
      let deg;
      if (wp.state === 2) {
        // hold-clear D3: her catch's own profile replaces the size table - the first pose from max(hold pose, LIFT_DEG) that is plume-clear,
        // `rest`-clear and `band`-clear (`rest` is not monotone in the pose); none = 'never'
        deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / D2R), R.LIFT_DEG ?? 69), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
          (d) => this._plumeConflictAt(i, d * D2R) || !profileClearAt(wp, 'rest', d) || !profileClearAt(wp, 'band', d));
      } else {
        let size = 0;                                                          // no finished profile: the measured size table (fallback only)
        if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) if (h && h.mass) size = Math.max(size, h.sizeMeter || 0);
        const floorDeg = _bandClearDeg(size, R);
        deg = firstClearPoseDeg(Math.max(Math.round(hp.rad / D2R), floorDeg), V5.HOLD_POSE_MAX_DEG, V5.HOLD_POSE_STEP_DEG,
          (d) => this._plumeConflictAt(i, d * D2R));                           // F4: the cap (100°) is tried last, whatever the grid
      }
      pose = { rad: deg === null ? null : deg * D2R };
    }
    arm._radClear = { key, pose, ageS: 0 };
    return pose;
  }

  /**
   * reel-hold D3: may the radiator wings enter the band now? null: yes. `'wait'`: a daughter's catch is not clear of the
   * wings yet: a holder below her band-clear lift pose, a daughter with a catch docking, or one reeling inside HOLD_M, or on her
   * way in at a speed she could not be stopped from before it (`_rhHold.refused` for the radiators: she docks, the wings wait for
   * her); one that is held at HOLD_M, at rest, does not count: she waits for the wings, not they for her. `'never'`: a holder that cannot
   * reach any band-clear, plume-clear pose (T1: `_radClearPose`). The first blocker's index is left in `_radBandWho`.
   * Empty daughters never block. Pure read apart from that index and the pose cache.
   * @returns {'wait'|'never'|null}
   */
  radiatorBandBlocked() {
    this._radBandWho = -1;
    const R = Constants.REEL_HOLD || {};
    const holdM = R.HOLD_M ?? 5;
    const tolM = R.STOP_TOL_M ?? 0.25;
    const dead = (Constants.OCTOPUS_V5.HOLD_POSE_DEADBAND_DEG ?? 1) * Math.PI / 180;
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
        // inside HOLD_M, or on her way in with no hold (D1: she could not stop from before it, or her hold was capped: whatever its reason,
        // F3), she docks: the wings wait for her
        wait = (dM !== null && dM < holdM - tolM) || (!!hs && (hs.refused === true || hs.capped === true));
      } else if (st === ARM_STATES.DOCKING || st === ARM_STATES.RELOADING) {
        wait = this._holdsAnyCatch(a);
      } else if (st === ARM_STATES.HOLDING_CATCH) {
        if (!this._holdsAnyCatch(a)) continue;
        // hold-clear D1: a catch whose wing profile is started and not done yet is not known to be clear: the radiators wait (a few frames)
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
   * reel-hold D6: the plain line for a radiator wait (`kind` 'wait') or a move that was dropped (`kind` 'stay'), naming the
   * daughter `radiatorBandBlocked` found first. @returns {string}
   */
  radiatorBandSays(kind) {
    const n = this._radBandWho >= 0 ? this._radBandWho + 1 : 0;
    const who = n > 0 ? `Daughter ${n}` : 'A daughter';
    return kind === 'stay' ? `Radiators stay: ${who}'s catch is in their way.` : `Radiators wait while ${who} lifts her catch clear.`;
  }

  /**
   * reel-hold D4, per frame: while the wings move through the band (or stand in it) every holder is lifted to her band-clear
   * pose (`_radLift`, the writer is `_updateCargoPlumePoses`, below the net duck and a neighbour's carry lift in priority), and
   * goes back to her hold pose when the wings are settled outside it. A holder that can reach no clear pose is not lifted (the
   * wings do not move: 'never'). Marks of arms that no longer hold a catch at home are dropped.
   * @private
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
   * reel-turn: the angle (rad) the mother must still turn about the strut's radial axis to bring this daughter into the swing
   * plane, from her place NOW and the ship's centre (`planeTurnLeftRad`). Null without the ship's place (a headless stub).
   * @private
   */
  _rhPlaneTurnLeft(owner, az) {
    const ps = this.playerSatellite;
    if (!ps || !ps.position || !ps.quaternion || !owner.position) return null;
    _rhTurnQ.copy(ps.quaternion).invert();
    _rhTurnP.copy(owner.position).sub(ps.position).applyQuaternion(_rhTurnQ);
    return planeTurnLeftRad(_rhTurnP.x, _rhTurnP.y, _rhTurnP.z, az);
  }

  /**
   * reel-turn: the autopilot asks this EVERY frame of a tracked plane turn: how far is the mother still to turn (signed, rad)?
   * Null = stop where she is (the autopilot brakes at the couples' α): the turn is not ours any more (its daughter left the
   * reels, another turn replaced it), she is inside half the tolerance (the hysteresis: a turn starts beyond PLANE_TOL_DEG and
   * ends inside half of it, so it cannot restart on the edge), or her lever on this axis is gone (she is level with it, or the
   * turn left is bigger than TURN_MAX_DEG): turning on would only spin the mother, and the 2 m line-up deals with the rest.
   * @private
   */
  _rhTrackPlane(turn, owner, az, tol) {
    if (this._rhTurn !== turn || !owner._rhHome || owner.isDetached) return null;
    if (Math.abs(owner._rhPlaneErrRad) < 0.5 * tol) return null;
    const left = this._rhPlaneTurnLeft(owner, az);
    const RH = Constants.REEL_HOME || {};
    if (left === null || Math.abs(left) > (RH.TURN_MAX_DEG ?? 60) * Math.PI / 180) return null;
    return left;
  }

  /** reel-home: her turn is over (or its daughter left) — drop the attitude hold it took, if it is still ours. @private */
  _rhEndTurn(ap) {
    this._rhTurn = null;
    if (ap && ap._attitudeHoldOwner === 'REEL_HOME' && typeof ap.releaseAttitudeHold === 'function') ap.releaseAttitudeHold();
  }

  /**
   * reel-home (fix round F3): the mother's own net (podIndex >= 0) or lasso is fired while a reel-home turn owns her
   * attitude. The catch wins: the turn stops where it is at once and its REEL_HOME hold is let go; then the catch's own
   * reel-in hold is taken through AutopilotSystem's public calls (its own listener runs before or after this one;
   * when it ran first, `holdAttitudeForNet` / `holdAttitude` left our owned hold alone, so it is taken here). The
   * daughter then holds at 2 m (the mother is "limited": `isReelInHeld`) and lines herself up on her thrusters.
   * @param {'net'|'lasso'} kind
   * @private
   */
  _rhOnMotherCatchFired(kind) {
    if (!this._rhTurn) return;                       // none of ours holds the attitude
    const ap = this._autopilot;
    this._rhAbortTurn();
    if (!ap) return;
    if (kind === 'net' && typeof ap.holdAttitudeForNet === 'function') ap.holdAttitudeForNet();
    else if (kind === 'lasso' && typeof ap.holdAttitude === 'function') ap.holdAttitude();
  }

  /** reel-home: its daughter has left the reels mid-turn — stop the turn's hold from outliving her. @private */
  _rhAbortTurn() {
    const ap = this._autopilot;
    if (ap && typeof ap.cancelAttitudeTurn === 'function') ap.cancelAttitudeTurn();
    this._rhEndTurn(ap);
  }

  /**
   * reel-home (Decision 7): the gap, metres, between the ship and a daughter placed at `pos` (world) with her catch on her
   * nose — a capsule from her centre to the catch's centre, wide enough for the catch. Infinity without a keep-out model
   * (a headless rig). The line-up refuses a step nearer than ALIGN_CLEAR_M.
   * @private
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
   * Wave1 reel-drum feedback (2026-08-27): ONE OWNER for the strut reel-
   * cartridge LED/drum states (PlayerSatellite.setTetherState). ArmManager's
   * per-frame arm poll already reads every arm's state, so the sync lives here
   * rather than inside ArmUnit — one place that knows the whole fleet, and the
   * entity stays free of a render-furniture concern.
   *
   * Mapping (mirrors ArmUnit._updateTether's tether-visible rules, so the drum
   * spins exactly while the cable it reels is drawn):
   *   'deployed' — arm out on tether work (REELING/RETURNING/HAULING and every
   *                other deployed-away state): amber LED + spool spin
   *   'ready'    — strut home states (DOCKED/DOCKING/RELOADING/HOLDING_CATCH)
   *   'empty'    — EXPENDED (tether snapped) or deliberately DETACHED (cable
   *                cut): she'll never fly this cable again, so the cartridge
   *                must not read "home" (green) — it reads red.
   *
   * Edge-triggered (send on change only) so calls trace a clean sequence.
   * Guarded for headless/legacy player mocks that lack setTetherState (they
   * simply carry no drum furniture).
   * @private
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
   * Cargo-continuity S10 (register item 35): the ONE SSOT for *cargo aboard* —
   * the mother berth (BERTHED/COLLARED/TRANSFERRING, via getBerthedMassKg) PLUS
   * every daughter's heldCatches rack. Both range (getMassBudget) and handling
   * (PlayerSatellite._applyThrust) read this, so a catch's kilograms count the
   * same wherever it sits — that is the mechanism of the campaign loop
   * (range ↔ cargo ↔ processing during the journey). Guarded exactly like the
   * S2/S6 CoMCalculator sites: plain-object mocks may lack the fields.
   *
   * A detached or expended daughter's rack does NOT count: that mass left with
   * her, and CoMCalculator.getDaughterMass already returns 0 for those holders —
   * the two ledgers must agree on what "aboard" means (§6). Unreachable today
   * (HOLDING_CATCH is in neither detach()'s DETACHABLE set nor deorbit
   * eligibility), pinned by test so it stays true.
   *
   * The in-hand `capturedDebris` scalar is deliberately NOT counted: it is the
   * haul, and getMassBudget excludes a deployed daughter's own mass too, so
   * counting her cargo would be inconsistent. (Register item 45, CLOSED: a
   * HOLDING_CATCH daughter is home-and-occupied, and getMassBudget now counts
   * her own arm mass in dockedArmMass — the S7 arrival tick no longer dips
   * the ship mass as the rack gains the cargo.)
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
    // Bags latched on the radiator tips (TipCargo) are cargo aboard too.
    const tip = (this.playerSatellite && this.playerSatellite.tipCargo
        && typeof this.playerSatellite.tipCargo.totalMassKg === 'function')
      ? this.playerSatellite.tipCargo.totalMassKg() : 0;
    return berthed + rack + tip;
  }

  // ── hold-catch: a daughter aboard with a catch keeps her strut at her hold pose ───

  /** hold-catch: the strut angle a daughter holding a catch rests at (see `_holdPoseOf` above). @returns {{rad:number, tooBig:boolean}|null} */
  holdPoseFor(armIndex) { return _holdPoseOf(this, armIndex); }

  /** hold pose with a short memory: re-read when her rack changes or every 0.5 s (the read is a few dozen cone tests). @private */
  _holdPoseCached(arm, armIndex, dt) {
    const key = _rackKey(arm);                    // hold-clear: includes whether her wing profile is done, so the pose moves when it lands
    const c = arm._holdPose;
    if (c && c.key === key && c.ageS < 0.5) { c.ageS += dt; return c.pose; }
    const pose = this.holdPoseFor(armIndex);
    arm._holdPose = { key, pose, ageS: 0 };
    return pose;
  }

  /**
   * hold-catch (rebases S9's re-pose, cargo-continuity plan §5 part 3, register item 32): every daughter parked HOLDING_CATCH
   * with a catch gets her strut to her hold pose (`holdPoseFor`: 34° if her catch is plume-clear there, else the lowest
   * plume-clear angle, never above 100°). It starts from 34°, NOT from where the strut is — a strut the reel left at 180° comes
   * down — and it acts whether or not the catch bites at the present angle. Live, NOT flag-gated; THRUSTER_INTERLOCK stays dormant.
   *  • MANUAL: a "." press (`_strutManual`, aged by StrutAuto for holding arms too) stands for its quiet window as long as the
   *    angle it asked for is safe (not below the hold pose, not above 100°, catch plume-clear there); an unsafe one is dropped.
   *  • ONE writer of `_strutTargetAlpha` for a holding arm while no hand-off runs (CARRY_* arms are in another state).
   *  • She says one line when nothing clears even at 100° (a catch that big is for a radiator).
   * Headless mocks lack the render-side strut driver — they slew HERE (the S10 legacy-fallback idiom); production slews once, in
   * _updateStruts, which owns the same latch.
   * @param {number} dt — frame delta seconds
   * @private
   */
  _updateCargoPlumePoses(dt) {
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const V5 = Constants.OCTOPUS_V5;
    const D2R = Math.PI / 180;
    const dead = V5.HOLD_POSE_DEADBAND_DEG * D2R;
    const cap = V5.HOLD_POSE_MAX_DEG * D2R;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
      const hp = this._holdPoseCached(arm, i, dt);
      // net-duck D2/D4: the duck for an inbound mother net and the lift for a neighbour's carry are INPUTS to this single writer: while
      // either stands her target is its angle (the duck wins), whatever her hold pose or a standing "." press says; both end by
      // deleting `_netDuck` / `_netLift`, and the hold pose (or the press, if it is still safe) takes her back
      // reel-hold D4: the lift for the radiator wings is the third input; F7: with a carry lift too, the HIGHER of the two (a carry's 69° under a
      // 99° the wings need would keep them waiting until the cap)
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
          // the player's press stands while it is safe; an unsafe one (below the pose, over the cap, in a plume) is dropped
          const safe = eff >= hp.rad - dead && eff <= cap + dead && !heldCargoPlumeConflictAt(this, i, eff)
            && _wingRestOk(arm, eff / D2R);                                    // hold-clear D2: nor a pose her catch touches a wing at
          if (safe) go = false; else delete arm._strutManual;
        }
        if (go && Math.abs(eff - hp.rad) > dead) arm._strutTargetAlpha = hp.rad;
        if (hp.wingBlocked) {
          // hold-clear D8: nothing up to 100° keeps her catch off the radiators: one line per catch (K lets it go; C only when it can work)
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
            // FA2: "Press C" only when C can work: the catch must be able to go to a tip at all, and C works only once every
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
          arm._strutTargetAlpha = undefined; // arrived — the render driver's own rule
        }
      }
    }
  }

  /**
   * S9 destination-feasibility READ (NOT the live gate): would planting arm
   * `armIndex`'s strut tip at `alphaDest` put it inside an occupied mother-net
   * berth corridor? Same ship-local cylinder geometry as CaptureNet's
   * _corridorClear section 1 (fore of the berth anchor plane, radial < the
   * mated catch's radius + BERTH_CLEARANCE_M), scoped to the station holders
   * (BERTHED/COLLARED/TRANSFERRING — the getDockedCatch set). The live
   * corridor gate itself is untouched (S13(d): strut-tips-only there).
   * (hold-catch, 2026-10-22: the hold pose no longer reads this: its 100° cap is clear of every inbound size, measured
   * with `strutTipFoulsCorridor`. Kept as the destination read for any pose that is allowed above 100°.)
   * @param {number} armIndex
   * @param {number} alphaDest — destination sweep angle (rad)
   * @returns {boolean} true when the destination crosses no occupied corridor
   * @private
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

    // The ONE berth anchor (S13(e)): the collar object, else pod 0's muzzle,
    // else the documented collar constant — the same reads _corridorClear makes.
    const anchor = player._netBerthCollar
      ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M_NET : 0;
    const my = anchor ? anchor.position.y / M_NET : 0;
    const mz = anchor ? anchor.position.z / M_NET : (V5C.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (dp.azimuthDeg * Math.PI / 180) : 0;
    const collarR = V5C.COLLAR_RADIUS ?? 0.40;
    const collarY = V5C.COLLAR_Y ?? 1.00;
    const strutLen = V5C.STRUT_LENGTH ?? 1.70;
    const anchorLocal = { x: mx, y: my, z: mz };

    // ONE geometry (ArmDockBasis.strutTipFoulsCorridor), per occupant radius.
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

  // ── Task 7 (opening-dance plan) — lean aside for an inbound catch ────────
  // Decision 6 (LOCKED, governing law for this task): nothing crosses or
  // tangles — tethers, struts, debris. The daughters' open pose used to be
  // 146°, which sat inside an inbound catch's berth corridor for pieces over
  // ~0.7 m. The one-press rest is now 34° (STRUT_REST_ALPHA, tip z −0.41 m) and
  // a double tap is 90° (STRUT_DEPLOY_ALPHA, tip z ≈ −0.30 m): both tips are aft
  // of the muzzle plane, so no catch of any size fouls them and neither is ever
  // ducked. The duck still runs for a strut set to 180° directly (no button
  // reaches it), to 90° — STRUT_DEPLOY_ALPHA, never past it.

  /**
   * Does arm `armIndex`'s CURRENT (live, `getAimAlpha()`) strut tip sit
   * inside a berth corridor cylinder sized for an inbound catch of
   * `radiusM`? The geometry is `ArmDockBasis.strutTipFoulsCorridor` — the ONE
   * copy, shared with `CaptureNet._corridorClear` (the authoritative berth
   * gate) and `_repPoseCorridorClear` above, so this really is "the SAME
   * test" the plan asks for rather than a mirror that can drift. This method
   * supplies only the POLICY: which arm, which anchor, which radius.
   * `_corridorClear`'s own behaviour is untouched.
   * @param {number} armIndex
   * @param {number} radiusM — the inbound catch's corridor radius
   *   (`debris.sizeMeter / 2 + CAPTURE_NET.BERTH_CLEARANCE_M`)
   * @param {number} [alphaRad] — test this strut angle instead of her live one (launch-aim cap)
   * @returns {boolean} true when this arm's live tip (or the tip at `alphaRad`) fouls the corridor
   * @private
   */
  _strutFoulsInboundCorridor(armIndex, radiusM, alphaRad) {
    const arm = this.arms[armIndex];
    if (!arm || typeof arm.getAimAlpha !== 'function') return false;

    const player = this.playerSatellite;
    const V5 = Constants.OCTOPUS_V5;
    if (!player || !V5) return false;

    // The ONE berth anchor (S13(e)): the collar object, else pod 0's muzzle,
    // else the documented collar constant — the same reads _corridorClear
    // and _repPoseCorridorClear make.
    const anchor = player._netBerthCollar ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M : 0;
    const my = anchor ? anchor.position.y / M : 0;
    const mz = anchor ? anchor.position.z / M : (V5.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (dp.azimuthDeg * Math.PI / 180) : 0;
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
   * Trigger: `Events.LASSO_CAPTURED` — a catch is inbound. Tests every
   * DOCKED arm's live strut alpha against the SAME corridor cylinder
   * `_corridorClear` uses (mirrored above); only the arms that would
   * actually foul duck to `STRUT_DEPLOY_ALPHA` (90°, the open angle). A strut
   * at the 34° rest or 90° never fouls any catch (tip aft of the muzzle plane),
   * so only a strut past 90° (set directly, 180°) ducks; unresolved-size pieces never
   * trigger a duck. Sole writer of `_strutTargetAlpha` for the arms it ducks,
   * for the duration of the duck only (`_releaseLeanAside` restores them to
   * `STRUT_DEPLOY_ALPHA`, the same angle).
   * @param {{debrisId?: number|string}} payload — LASSO_CAPTURED's payload
   * @private
   */
  _onInboundCatchCaptured(payload) {
    const debrisId = payload && payload.debrisId;
    if (debrisId == null) return;
    if (!this._debrisField || typeof this._debrisField.getDebrisById !== 'function') return;
    // Rule H (CONVENTIONS §10): resolve the canonical object by id, never a
    // snapshot/wrapper.
    const debris = this._debrisField.getDebrisById(debrisId);
    // No resolvable size ⇒ never duck — "small pieces must never trigger it"
    // extends to a piece this lane cannot measure.
    if (!debris || !debris.sizeMeter) return;

    const CN = Constants.CAPTURE_NET;
    const radiusM = debris.sizeMeter / 2 + (CN?.BERTH_CLEARANCE_M ?? 1.0);

    this._duckFoulingStruts(radiusM);
  }

  /**
   * Duck every DOCKED strut whose live tip fouls a berth corridor of `radiusM` to
   * `STRUT_DEPLOY_ALPHA` (90°) and arm the lean-aside release timer. The ONE copy of the
   * duck loop: `_onInboundCatchCaptured` (LASSO_CAPTURED) and the arms-auto controller
   * (the mother net's own approach) both call it.
   * @param {number} radiusM
   * @returns {boolean} true when at least one strut was ducked
   * @private
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
    // net-duck D2: the daughters HOLDING a catch duck through the same mechanism (same trigger, same release, same timer) - but only
    // for a MOTHER net coming home (R3: `_tickNetDuck` ends their duck the moment none is; the lasso event has no mother net)
    if (_inboundMotherNetRadiusM(this) !== null && this._duckHolders(radiusM)) ducked = true;
    if (ducked) {
      this._leanAsideActive = true;
      this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
    }
    return ducked;
  }

  /**
   * net-duck D2 (owner 2026-10-22: "their strut should ... move out of the way of mother net"): every daughter HOLDING a catch whose
   * catch would sit in the berth corridor of an inbound net of `radiusM` (D1: `heldCargoFoulsCorridorAt`, her drawn mesh) lowers her
   * strut to the highest hold-pose-grid angle at which it does not (`_holderDuckRad`: 34° at the lowest). The angle is computed ONCE
   * per holder per reel (`arm._netDuck`) and kept until the lean-aside release; `_updateCargoPlumePoses`, the one writer of a holder's
   * strut target, takes it as an input. One Comms line per holder per reel. A holder already ducked counts as "ducked" for the caller,
   * which re-arms the release timer (a reel lasts 10-35 s, the timer is 8 s: it is the backstop for a missed release event, not the
   * clock of the reel). A holder lifted (`_netLift`) for a carry that is IN FLIGHT (CARRY_OUT / CARRY_HANDOFF / CARRY_BACK) is skipped:
   * ducking her would put her catch in the carry's path; she ducks once the carry has landed and the lift is released, if the net is
   * still inbound (the mother net's corridor check counts her body meanwhile, so the reel pauses).
   * @param {number} radiusM
   * @returns {boolean} true when at least one holder is (or has just been) ducked
   * @private
   */
  _duckHolders(radiusM) {
    let any = false;
    const flying = this.arms.some((a) => a && (a.state === ARM_STATES.CARRY_OUT || a.state === ARM_STATES.CARRY_HANDOFF || a.state === ARM_STATES.CARRY_BACK));
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.isDetached || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
      if (arm._netDuck) { any = true; continue; }
      if (arm._netLift && flying) continue;           // review F1: lifted for a carry that is flying past her: she ducks after it has landed
      if (!(Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass))) continue;
      // hold-clear D4: one decision with the fire check (`_duckPlan`). A pending wing profile skips her this frame (the net's corridor gate holds
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
      // reel-hold D4: no holder starts a duck below the lift pose while the wings are inside the band (they leave it in a few
      // seconds; the net reel's own pause for the fouled corridor covers the wait). F5: nor while they are about to enter it or
      // cross it (a duck started the frame before they go in lowers her under them: the wings' own gate has not seen her move yet)
      if (rad < (Constants.REEL_HOLD.LIFT_DEG ?? 69) * Math.PI / 180 - 1e-6 && (this._wingsInBand() || this._wingsMovingInBand())) continue;
      arm._netDuck = { rad };
      arm._netDuckLow = true;                       // D3: the Hall drive waits while this stands (and while she climbs back)
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
   * net-duck: the per-frame part. While a mother net is inbound a holder's duck is (re)decided and its release timer re-armed, whether
   * or not StrutAuto runs (D2); the moment NO mother net is inbound any more (a miss, a cut, a lost target: CaptureNet sends no
   * NET_FAILED / NET_TORN for those) the holders' ducks end (R3) - the 8 s timer is only the backstop; a duck whose daughter no longer
   * holds a catch is dropped (R1); a holder whose strut is down for the net keeps the `_netDuckLow` mark until she is back at her hold
   * pose (D3 reads it); the lifts for a neighbour's carry are kept or ended (D4). Runs before `_updateCargoPlumePoses`.
   * @param {number} dt
   * @private
   */
  _tickNetDuck(dt) {
    if (!(dt > 0)) return;
    const radiusM = _inboundMotherNetRadiusM(this);
    let ducked = false;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm) continue;
      if (arm._netDuck && !_holdsCatchAtHome(arm)) this._dropExHolderDuck(i, arm);      // R1
      else if (arm._netDuck) ducked = true;
    }
    if (radiusM !== null) {
      if (this._duckHolders(radiusM)) {
        this._leanAsideActive = true;
        this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
      }
    } else if (ducked) {
      this._releaseHolderDucks();                                                      // R3
    }
    const V5 = Constants.OCTOPUS_V5;
    const dead = V5.HOLD_POSE_DEADBAND_DEG * Math.PI / 180;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || !arm._netDuckLow) continue;
      const hp = arm.state === ARM_STATES.HOLDING_CATCH && !arm.isDetached ? this._holdPoseCached(arm, i, 0) : null;
      if (!hp) { arm._netDuckLow = false; continue; }
      if (!arm._netDuck && arm.getAimAlpha() >= hp.rad - 2 * dead) arm._netDuckLow = false;   // back at her pose
    }
    this._tickLifts(dt);
  }

  /**
   * net-duck R1: a daughter whose duck outlived her catch (it left by a hand-off, the rack ran empty, she was detached) is dropped
   * from the duck at once: no marks, no queued press, and no place in the lean-aside list (that list would send a DOCKED arm to 90° at
   * the next release, and re-send her every timer while a net is inbound).
   * @param {number} i
   * @param {object} arm
   * @private
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
   * net-duck R3: end every holder's duck (no mother net is coming home): each goes back to her hold pose (`_updateCargoPlumePoses` is
   * the writer), a "." press that waited is applied (D5), and her place in the lean-aside list is given up. A DOCKED arm another duck
   * (the lasso event) put in the list is not touched: that release belongs to its own events and timer.
   * @private
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
   * net-duck D3: the first daughter whose strut is down for an inbound net (ducked, or still climbing back to her hold pose), else -1.
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
   * Release: restore every arm this lane ducked back to the 90° duck angle
   * (`STRUT_DEPLOY_ALPHA`). Wired to `Events.NET_BERTHED` (the plan's own
   * release event) and the "net clears/fails" events (LASSO_MISSED,
   * LASSO_SNAPPED, NET_FAILED, NET_RELEASED, NET_TORN), plus a bounded
   * timeout (`_updateLeanAside`) — see this lane's final report: the lasso
   * adoption path (`CaptureNetSystem.adoptLassoCatch`) deliberately never
   * emits NET_BERTHED, so NET_BERTHED alone would strand a ducked arm
   * ducked forever on that path.
   * A duck is only ever restored while the arm is still DOCKED — if it left
   * DOCKED mid-duck (deployed, recalled, expended…) some other system now
   * owns its `_strutTargetAlpha` and this lane must not fight it.
   * @private
   */
  _releaseLeanAside() {
    if (this._leanAsideArmIndices.size === 0 && !this._leanAsideActive) return;
    // net-duck: another mother net still coming home keeps the holders down (this release was the end of a different one)
    const stillInbound = _inboundMotherNetRadiusM(this) !== null;
    let kept = 0;
    for (const i of this._leanAsideArmIndices) {
      const arm = this.arms[i];
      // net-duck R1: a duck whose daughter no longer holds a catch is over BEFORE anything else is asked of her: she is not sent to 90°
      // and she cannot keep the list alive ("another net is still coming in" below)
      if (arm && arm._netDuck && !_holdsCatchAtHome(arm)) { this._dropExHolderDuck(i, arm); continue; }
      if (arm && arm.state === ARM_STATES.DOCKED) {
        arm._strutTargetAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
      }
      // net-duck D2: a holder goes back to her hold pose (`_updateCargoPlumePoses` is the writer); her "." press, if one waited, now
      // applies (D5). `_netDuckLow` stays until she is there (D3).
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
   * Per-frame tick for the lean-aside safety-net timeout. See
   * `_releaseLeanAside`'s doc for why a timeout exists at all.
   * @param {number} dt
   * @private
   */
  _updateLeanAside(dt) {
    if (!this._leanAsideActive) return;
    this._leanAsideTimer -= dt;
    if (this._leanAsideTimer <= 0) this._releaseLeanAside();
  }

  /**
   * Get mass budget data for HUD display.
   * Computes current system mass and Tsiolkovsky ΔV remaining.
   * Config G (ST-9.2): coreDry = V5 bus dry mass + strut mass (struts stay on mothership).
   * Daughter masses (weaver/spinner) are separate — they leave when deployed.
   * @returns {object}
   */
  getMassBudget() {
    const V5 = Constants.OCTOPUS_V5;
    // Config G: bus + ROSA + body-mount + struts (struts are permanent mothership structure)
    const strutMassTotal = V5.STRUT_MASS * this.arms.length;
    // P2 aft flower: purchased pairs are permanent structure too — the ONE
    // hardware-mass carrier is this coreDry term (V5.CORE_DRY_MASS + dynamic
    // hardware sums; the strut-mass precedent). The legacy top-level
    // OCTOPUS_CORE_DRY_MASS twin (170) is deliberately NOT grown — its one
    // reader is TargetReticle's local ΔV mirror, recorded as prior debt with
    // numbers in tmp/flower-mass-budget.mjs §3 (pre-existing +626.7 m/s
    // optimism at tier 0; the flower widens it by the untold pair tax).
    const flowerMass = (this.playerSatellite
        && typeof this.playerSatellite.getFlowerDryMassKg === 'function')
      ? this.playerSatellite.getFlowerDryMassKg() : 0;
    // Reaction-wheel kit (DECISIONS §2 row 9): 12.1 kg of structure on the same carrier term (bus + tank + struts + flower + kit).
    const wheelMass = (this.playerSatellite
        && typeof this.playerSatellite.getWheelKitMassKg === 'function')
      ? this.playerSatellite.getWheelKitMassKg() : 0;
    // h3-argon-engine D3: the 60 L engine tank is structure too (9.5 kg, research §2.2). CORE_DRY_MASS
    // (176 = bus + ROSA + body-mount + collar) carries no tank, so this is ADDED, not a replacement.
    // g1-gas-upgrades D6: the tank's dry mass follows its size (the Bigger Engine Tank carries more tank).
    const resources = this.playerSatellite.resources || {};
    const rsStatus = this._resourceSystem ? this._resourceSystem.getStatus() : null;
    const xenonPoolMax = rsStatus ? rsStatus.xenonMax : Constants.XENON_FUEL_MAX;
    const tankDry = engineTankDryKg({ xenonMax: xenonPoolMax });
    const coreDry = V5.CORE_DRY_MASS + tankDry + strutMassTotal + flowerMass + wheelMass;

    // Get current propellant from player resources
    // fu-gas F1.1: the tank is POOL units (20 = the 6 kg tank; Extra Cold Gas raises the max), so kg = coldGasPoolToKg, not 6 kg x fraction.
    const coldGasPoolMax = rsStatus ? rsStatus.coldGasMax : Constants.COLD_GAS_MAX;
    const coldGasMax = coldGasPoolToKg(coldGasPoolMax);
    // h3-argon-engine D2: engine gas in kg = pool/100 x kgFull of the gas IN THE TANK (tankGasId), via the
    // ONE exported converter. `xenonCurrent` / `xenonMax` keep their names (HUD readers) but are now the
    // engine gas kg now / when the (possibly upgraded) tank is full.
    const gasRes = {
      xenon: resources.xenon || 0,
      tankGasId: resources.tankGasId || (rsStatus && rsStatus.tankGasId) || Constants.DEFAULT_FUEL,
    };
    const tankGas = Constants.FUELS[gasRes.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    const xenonCurrent = engineGasKg(gasRes);
    const xenonMax = (xenonPoolMax / 100) * tankGas.kgFull;
    const coldGasCurrent = coldGasPoolToKg(resources.coldGas || 0);

    // Sum arm masses using V5 weights (reel on mothership = 40% lighter arms)
    let armMassTotal = 0;
    let dockedArmMass = 0;
    let deployedArmMass = 0;
    let detachedArmMass = 0;
    for (const arm of this.arms) {
      const m = arm.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      armMassTotal += m;
      // HOLDING_CATCH is home-and-occupied (S1: docked at her strut tip, parked
      // with cargo) — she is NOT "out". Register item 45: keying on DOCKED only
      // dipped the ship mass by one arm at the S7 arrival tick, in the same
      // moment the rack gained the cargo; CoMCalculator counts her throughout
      // (only detached/expended are excluded) and the two ledgers must agree.
      if (arm.state === ARM_STATES.DOCKED || arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state)) {
        dockedArmMass += m;
      } else if (arm.state !== ARM_STATES.EXPENDED) {
        deployedArmMass += m;
        if (arm.isDetached) detachedArmMass += m;
      }
    }

    // Mother-net-reel plan §4.16: a berthed whale is real mass the Tsiolkovsky
    // readout and the autopilot's pre-engage ΔV gate must both see. Add it to
    // wetMass AND dryMass (it rides along whether or not the tanks are full —
    // it is not propellant). Without this the HUD promises ΔV the laden ship
    // can no longer deliver and the AP happily engages.
    // S10: the fold is CARGO ABOARD (berthed + every daughter rack) via the
    // getCargoMassKg SSOT — a transferred catch's kilograms still ride the
    // ship. berthedMass stays as its own berth-only field; the HUD's "+N kg"
    // explanation line reads cargoMass (register item 45), so it survives the
    // S7 transfer off the nose.
    const berthedMass = (this.playerSatellite
        && this.playerSatellite._captureNetSystem
        && typeof this.playerSatellite._captureNetSystem.getBerthedMassKg === 'function')
      ? this.playerSatellite._captureNetSystem.getBerthedMassKg() : 0;
    const cargoMass = this.getCargoMassKg();

    // DECISIONS §33 row 4 (2026-10-20): the mother's nets aboard are real mass (count x CAPTURE_NET.LARGE.MASS 1.425 kg),
    // carried in the launcher like the cargo: in the loaded and the empty mass, and so in the engine's Tsiolkovsky dry
    // term. A fired net leaves the ship (the count is the one CaptureNetSystem owns), so a shot lightens her. The
    // daughters' own nets are taken to be inside V5_WEAVER_MASS / V5_SPINNER_MASS (no separate term). CoMCalculator
    // books the same mass on the launcher axis (motherNetBooking), so the two ledgers agree.
    // 2026-10-21 (nets-step2): every loaded net weighs the current line-fibre tier's packed mass
    // (CaptureNetSystem.getMotherNetMassKg: count x TETHER_TIERS[tier].netMassKg.mother; 1.425 kg at the start tier).
    const mCns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    const motherNetCount = (mCns && typeof mCns.getMotherNetCount === 'function') ? mCns.getMotherNetCount() : 0;
    const motherNetMass = (mCns && typeof mCns.getMotherNetMassKg === 'function')
      ? mCns.getMotherNetMassKg()
      : motherNetCount * Constants.CAPTURE_NET.LARGE.MASS;

    // Cold gas is CARRIED, not burned by the Hall engine (h3-argon-engine D4: it used to be counted as
    // burnable at Hall Isp, ~30 % too high): it sits in BOTH the loaded and the empty mass.
    // Lane 3f F2 (Ruling 0, §33 row 11 "her mass is live"): the indium in her ion-fuel store is carried like cargo (the Hall
    // engine never burns it): in the loaded and the empty mass.
    const indiumStoreKg = (this._resourceSystem && Number.isFinite(this._resourceSystem.indiumStoreKg)) ? Math.max(0, this._resourceSystem.indiumStoreKg) : 0;
    // Slice 5 (5a, V6, §33 row 11 "her mass is live"): the drag sails in her stock are carried like the indium: in the loaded and the empty mass.
    const dragSailKg = (this._resourceSystem && typeof this._resourceSystem.dragSailMassKg === 'function') ? this._resourceSystem.dragSailMassKg() : 0;
    const carriedDry = coreDry + coldGasCurrent + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg;
    const wetMass = carriedDry + xenonCurrent;
    const dryMass = coreDry + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg;   // reported, as before: without either gas

    // Tsiolkovsky for the engine: ΔV = Isp_eff x g0 x ln((dry + cold + gas) / (dry + cold)).
    // Isp_eff = the ACTIVE fuel's Isp / c (D5: shop upgrade x power split act as Isp gains).
    const fuel = this._resourceSystem ? this._resourceSystem.getCurrentFuel() : Constants.FUELS[gasRes.tankGasId];
    const c = (this.playerSatellite && typeof this.playerSatellite.getConsumptionMultiplier === 'function')
      ? this.playerSatellite.getConsumptionMultiplier() : 1;
    const ispActive = fuel && fuel.isp > 0 ? fuel.isp : Constants.OCTOPUS_CORE_HALL_ISP;
    const isp = ispActive / (c > 0 ? c : 1);   // effective Isp: the figure the ΔV and the flow share
    const deltaV = engineDeltaV({
      dryKg: coreDry + dockedArmMass + cargoMass + motherNetMass + indiumStoreKg + dragSailKg, coldGasKg: coldGasCurrent, gasKg: xenonCurrent, isp: ispActive, c,
    });

    return {
      coreDry,
      flowerMass: Math.round(flowerMass * 10) / 10,
      xenonCurrent: Math.round(xenonCurrent * 10) / 10,
      xenonMax,
      // g1-gas-upgrades D7: "how full is the engine tank" by MASS, the same for every gas (bars and colours read this)
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
      motherNets: motherNetCount,                                   // the mother's nets aboard (count)
      motherNetMass: Math.round(motherNetMass * 1000) / 1000,       // kg, count x 1.425 (inside wet and dry mass)
      deltaV: Math.round(deltaV),
      isp,
      shipMassKg: wetMass,   // exact (unrounded) total mass now — the gas-flow law's m_ship (PlayerSatellite)
      tankGasId: gasRes.tankGasId,
    };
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  // ==========================================================================
  // ARM SELECTION (Sprint C2 — extended to 8 arms)
  // ==========================================================================

  /**
   * Select an arm by index (0-7).
   * @param {number} index — arm index in the arms array
   * @param {{quiet?: boolean}} [opts] - quiet: no "X selected." comms line (u20 integration: the auto-pick after a launch
   *   already has its launch line; one line in comms, not two)
   */
  selectArm(index, opts = {}) {
    if (index < 0 || index >= this.arms.length) return;
    // Toggle: re-selecting the same arm deselects
    if (this.selectedArmIndex === index) {
      this.deselectArm();
      return;
    }
    // Disable manual mode on previously selected arm (Phase 1A cleanup)
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const prev = this.arms[this.selectedArmIndex];
      if (prev && prev.isManual()) prev.disableManual();
      // D4 (hotkey revamp 2026-06-14): clear the old plate's selection glow.
      if (prev && typeof prev.setSelectedHighlight === 'function') prev.setSelectedHighlight(false);
    }
    this.selectedArmIndex = index;
    const arm = this.arms[index];
    // D4: glow/flash the newly selected plate (visible feedback for docked arms
    // before launch; deployed arms also light while piloted).
    if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(true);
    eventBus.emit(Events.ARM_SELECT, { armIndex: index });
    if (opts && opts.quiet) return;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${arm.displayName} selected.`,
      priority: 'info',
    });
  }

  /**
   * Deselect arm — return focus to mothership.
   */
  deselectArm() {
    // Disable manual mode on currently selected arm (Phase 1A cleanup)
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const arm = this.arms[this.selectedArmIndex];
      if (arm && arm.isManual()) arm.disableManual();
      // D4 (hotkey revamp 2026-06-14): clear the selection glow.
      if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(false);
    }
    this.selectedArmIndex = -1;
    eventBus.emit(Events.ARM_DESELECT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Daughter deselected. Mothership focus',
      priority: 'info',
    });
  }

  /**
   * Get the currently selected arm (any state), or null.
   * @returns {ArmUnit|null}
   */
  getSelectedArm() {
    if (this.selectedArmIndex < 0 || this.selectedArmIndex >= this.arms.length) return null;
    return this.arms[this.selectedArmIndex];
  }

  /**
   * Get the selected arm IF it is deployed and pilotable, or null.
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

  /** Get count of docked arms */
  getDockedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.DOCKED).length;
  }

  /** Get count of deployed (active) arms */
  getDeployedCount() {
    return this.arms.filter(a =>
      a.state !== ARM_STATES.DOCKED &&
      a.state !== ARM_STATES.EXPENDED
    ).length;
  }

  /**
   * FIX_PLAN §3: Returns true if ANY arm is deployed on a tether (not docked, not expended, not detached).
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
   * FIX_PLAN §3: Returns the rotation lock tier based on deployed arm states.
   * 'block' — hard-block rotation (high-risk: REELING, HAULING, GRAPPLED, STATION_KEEP, NETTING, DOCKING)
   * 'soft'  — soft-cap rotation to TETHER_ROTATION.SOFT_CAP_RATE (TRANSIT, APPROACH, TRAWLING, LAUNCHING, RETURNING, SCANNING, ABLATING)
   * 'none'  — no constraint (all arms DOCKED/EXPENDED/RELOADING or detached)
   *
   * launch-seq: a LAUNCHING daughter whose spring has NOT fired is still clamped to her strut — part of the
   * ship, no tether out — so she contributes 'none'. Her tier is 'soft' from the spring on (she is flying out
   * on the line). Before, the clamp hold counted as tethered and dragged the mother back from the aim.
   */
  getRotationLockTier(exceptArm = this._lockExceptArm) {
    let tier = 'none';
    for (const arm of this.arms) {
      if (arm.isDetached) continue;             // free-flying — severed tether, no shear risk
      // reel-home (Decision 6, fix round F1): the daughter the mother turns FOR, and every other daughter that is already
      // on the strut line (REELING home: her line is being wound in), do not hold the mother still. A daughter still in
      // GRAPPLED (her net reel included) does. Callers with no `exceptArm` get today's answer.
      if (this._rhIgnoredForTurn(arm, exceptArm)) continue;
      const s = arm.state;
      if (s === ARM_STATES.LAUNCHING && !arm._springFired) continue;  // clamped: part of the ship
      if (_HIGH_RISK_ROT_STATES.has(s)) return 'block'; // early exit — max severity
      if (_SOFT_ROT_STATES.has(s)) tier = 'soft';
      // DOCKED / RELOADING / HOLDING_CATCH / EXPENDED contribute 'none' — leave tier unchanged
    }
    return tier;
  }

  /** Get count of expended arms */
  getExpendedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.EXPENDED).length;
  }

  /** Get total captures across all arms */
  getTotalCaptures() {
    return this.arms.reduce((sum, a) => sum + a.captures, 0);
  }

  /**
   * Get status of all arms for HUD display.
   * Returns array of per-arm status objects (backward compatible).
   * V5: Each status now includes springCharged, reloadProgress from ArmUnit.getStatus().
   * @returns {Array<object>}
   */
  getAllStatus() {
    return this.arms.map(a => a.getStatus());
  }

  /**
   * Get V5 fleet-wide status for enhanced HUD display.
   * Includes per-arm statuses plus fleet-level data (pulse scan, counts, etc.).
   * @returns {object}
   */
  getFleetStatus() {
    return {
      arms: this.arms.map(a => a.getStatus()),
      totalArms: this.arms.length,
      pulseScanCooldown: this._pulseScanCooldown,
      pulseScanActive: this._pulseScanActive,
      selectedArmIndex: this.selectedArmIndex,
      reloadingCount: this.arms.filter(a => a.state === ARM_STATES.RELOADING).length,
      chargedCount: this.arms.filter(a => a.state === ARM_STATES.DOCKED && a.springCharged).length,
    };
  }

  /**
   * Get arms by type.
   * @param {'weaver'|'spinner'} type
   * @returns {ArmUnit[]}
   */
  getArmsByType(type) {
    return this.arms.filter(a => a.type === type);
  }

  /**
   * Pure read (no comms, no state change): can a daughter go at `target` now, will one without the player doing
   * anything, or what stops them all? Mirrors the gates of `deployArm` (safe mode, ARM power, the arm `_findDockedArm`
   * picks by type, its capture mass), so `ready` is true exactly when `deployArm(target)` gets past them.
   * Daughter fuel never refills in play, so fuel <= 5 is a dead end (`noFuel`).
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
    // The arm deployArm would pick: the preferred type first, the other type if none of it can go.
    const first = mass > Constants.SPINNER_MAX_CAPTURE_MASS ? 'weaver' : 'spinner';
    const order = [first, first === 'weaver' ? 'spinner' : 'weaver'];
    for (const type of order) {
      const eligible = arms.filter((a) => a && a.type === type && armCanLaunchNow(a));
      if (eligible.length > 0) {
        out.ready = eligible.some((a) => mass <= a.config.maxCaptureMass);
        break;
      }
    }
    if (out.ready) return out;

    for (const a of arms) {
      if (!a || a.state === S.EXPENDED || a.state === S.ADRIFT || a.isDetached) continue;
      if (a.state === S.HOLDING_CATCH) { counts.holding++; continue; }
      if (!(a.fuel > 5)) { counts.noFuel++; continue; }
      if (mass > a.config.maxCaptureMass) { counts.heavy++; continue; }
      out.wait = true;    // docked with the spring reloading / aim-reserved, or out on her line: she will be ready
    }
    if (out.wait) return out;
    const kinds = (counts.noFuel > 0) + (counts.holding > 0) + (counts.heavy > 0);
    out.why = kinds === 0 ? 'none'
      : kinds > 1 ? 'mixed'
        : counts.noFuel > 0 ? 'fuel' : counts.holding > 0 ? 'holding' : 'heavy';
    return out;
  }

  /**
   * Find a docked arm matching the preferred type, with highest fuel.
   * V5: Also checks springCharged — can't deploy an uncharged arm.
   * If targetDir (ship-local) is provided, prefers the arm whose dockOffset
   * best aligns with the target direction to minimise camera swing on deploy.
   * Falls back to highest-fuel arm when no arm aligns within ~45°.
   * @private
   * @param {'weaver'|'spinner'} type
   * @param {THREE.Vector3|null} [targetDir=null] - Direction to target in ship-local space
   * @param {((arm: ArmUnit) => boolean)|null} [accept=null] - interlocks-p2: only arms this accepts (a strut whose line stays clear)
   * @returns {ArmUnit|null}
   */
  _findDockedArm(type, targetDir = null, accept = null) {
    const eligible = this.arms.filter(a => a.type === type && armCanLaunchNow(a) && (!accept || accept(a)));
    if (eligible.length === 0) return null;

    if (targetDir && targetDir.lengthSq() > 0) {
      const dir = targetDir.clone().normalize();
      const COS_45 = 0.707; // cos(45°) threshold for "well-aligned"

      // Score each arm by how well its dock offset aligns with the target
      const scored = eligible.map(arm => {
        const dockDir = arm.dockOffset.clone().normalize();
        return { arm, dot: dir.dot(dockDir) };
      });

      // Prefer arms within ~45° of target direction
      const aligned = scored.filter(s => s.dot > COS_45);
      if (aligned.length > 0) {
        aligned.sort((a, b) => b.dot - a.dot);
        return aligned[0].arm;
      }
      // No well-aligned arm → fall through to fuel-based selection
    }

    // Default: highest fuel first (original behaviour)
    eligible.sort((a, b) => b.fuel - a.fuel);
    return eligible[0];
  }

  // ==========================================================================
  // SHOP UPGRADES (Tier 4B — persisted across reset)
  // ==========================================================================

  /**
   * Apply a shop upgrade to all arms. Stores the override so it
   * survives reset() (which field-resets and reuses the existing arm
   * instances — no new ArmUnit construction outside _initArms).
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data, opts = {}) {
    // Store for re-application after reset
    this._storedUpgrades[data.effect] = data.value;

    // V5: Handle spring/tether tier upgrades
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
   * The first DOCKED daughter of `type` whose net magazine has room (DECISIONS §33 rows 2 and 5: nets refill only by
   * buying at the resupply stop, one at a time).
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

  /** True when some docked daughter of `type` has room for one more net (the shop's full check). */
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

  /**
   * Re-apply all stored shop upgrades to current arms.
   * Called after reset() has field-reset the existing ArmUnit instances
   * (they are reused, not recreated).
   * @private
   */
  _reapplyStoredUpgrades() {
    for (const [effect, value] of Object.entries(this._storedUpgrades)) {
      // V5: Handle spring/tether tier upgrades
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

  // ==========================================================================
  // V4 UPGRADES (Unlockable GSL technology)
  // ==========================================================================

  /**
   * Apply V4 "Opussy" GSL technology upgrade.
   * @private
   * @param {string} upgrade - One of: 'gslTether', 'gslNet', 'electrostaticNet'
   */
  _applyV4Upgrade(upgrade) {
    switch (upgrade) {
      case 'gslTether':
        // GSL tethers: 6× lighter → extend reach by TETHER_LENGTH_MULT
        for (const arm of this.arms) {
          arm.config.tetherMax = Math.round(arm.config.tetherMax * Constants.V4_TETHER_LENGTH_MULT);
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL tethers installed. Reach extended to 12.5 km',
          priority: 'success',
        });
        break;

      case 'gslNet':
        // GSL nets: 10× larger at same mass
        for (const arm of this.arms) {
          arm.config.netSize = arm.config.netSize * Constants.V4_NET_SIZE_MULT;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL nets installed. 50×50m capture area',
          priority: 'success',
        });
        break;

      case 'electrostaticNet':
        // Electrostatic capture: increased capture success
        for (const arm of this.arms) {
          // Boost capture rate (was 85%, now ~95%)
          // This is handled in ArmUnit._updateNetting via a flag
          arm._v4Electrostatic = true;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 HBN-coated electrostatic nets. Capture rate improved',
          priority: 'success',
        });
        break;
    }
  }

  // ==========================================================================
  // RESET / DISPOSE
  // ==========================================================================

  /**
   * Reset all arms to docked with full fuel, then re-apply stored upgrades.
   */
  reset() {
    // trip-melt-2 (carry): a carry in progress lets go of its tip reservation, the strut reservation and the radiator hold
    // first (this reset sets the fields below directly and never calls ArmUnit.reset, which would have done it).
    this.abortAllCarries('reset');
    // Register item 71: release the cargo this reset drops BEFORE the fields
    // clear. Every other unpin lives on a non-reset path (_releaseCapturedDebris
    // / the rack feed-end / _clearCatchPins / the lasso releases), so a dropped
    // piece kept _armPinned/_armPinPos/_capturedByArm set and DebrisField
    // rendered it glued at the stale slot forever — drawn, but in no ledger
    // (the continuity law's inverse violation). Release to a free,
    // re-targetable body re-seated at the pin the player last saw.
    const _player = this.playerSatellite;
    const _releaseVel = (_player && typeof _player.getVelocity === 'function')
      ? _player.getVelocity() : null;
    for (const arm of this.arms) {
      this._releaseDroppedCargo(arm.heldCatches, _releaseVel);
      if (arm.capturedDebris) this._releaseDroppedCargo([arm.capturedDebris], _releaseVel);
      // Register item 78: a tether-snapped catch stays pinned to the drifting
      // EXPENDED daughter (keepPinned keeps _capturedByArm; _updateExpended
      // re-pins it every frame until TETHER_SNAP_RELEASE_DELAY_S releases it).
      // The reset re-docks the arm inside that drift window unless the pin
      // releases first — else the piece ghosts at the stale drift pin, drawn,
      // in no ledger, with _capturedByArm on a now-DOCKED arm (the item-71
      // ghost through the captor back-reference). Same seam: flags + re-seat,
      // then drop the tracking fields.
      if (arm._severedCatch) {
        this._releaseDroppedCargo([arm._severedCatch], _releaseVel);
        arm._severedCatch = null;
        arm._severedDriftS = 0;
      }
      arm.state = ARM_STATES.DOCKED;
      arm.fuel = 100;
      arm.coldGasKg = arm._coldGasBottleKg();   // reel-gas: the bottle is reset wherever the FEEP fuel is
      // Register item 80: an SK target's LOD-protection flag must not survive
      // the reset. The SK session's own reference is _stationKeepTarget (set
      // together with the debris-side flag at SK entry, ArmUnit.js:3005/:3122)
      // and every live SK exit clears the flag on it (ArmUnit _exitStationKeep
      // and siblings). reset() drops the target assignment itself, so clear the
      // flag on the same reference before dropping both — otherwise the piece
      // keeps skipping LOD downscaling forever (DebrisField.js:2115), a free
      // body rendering at full detail past the 50 km cull.
      if (arm._stationKeepTarget) arm._stationKeepTarget._isStationKeepTarget = false;
      arm._stationKeepTarget = null;
      arm.target = null;
      arm.capturedDebris = null;
      arm.heldCatches = [];               // S6: the parked cargo rack resets too
      arm.captures = 0;
      arm.stateTimer = 0;
      arm.tetherLength = 0;
      arm.velocity.set(0, 0, 0);
      arm.mesh.visible = false;
      arm.tetherLine.visible = false;
      arm._webShotCooldown = 0;      // Sprint D1: clear web shot state
      arm._webShotTarget = null;
      arm.isDetached = false;         // Phase 6: reset detach state
      arm._detachFuelWarning25 = false;
      arm._detachFuelWarning10 = false;
      // V5: Reset crossbow state
      arm.springCharged = true;
      arm.reloadProgress = 0;
      arm.reloadDuration = 0;
      arm.tetherTension = 0;
      arm.reeling = false;
      arm.launchDirection = null;
      _clearNetDuckMarks(arm);        // net-duck R1: no duck, lift, wait or queued press outlives the holder she belonged to
    }
    // net-duck R1: ... and the lean-aside list, flag and timer go with them (else the 8 s backstop later sends a docked arm to 90°)
    if (this._leanAsideArmIndices) this._leanAsideArmIndices.clear();       // (test-ArmUnit-ParkCatch resets a bare prototype object)
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;
    this._radBandWho = -1;            // reel-hold D8: no radiator wait outlives the reset
    this._wingQueue = [];             // hold-clear D11: no wing-profile work outlives the reset (the catches themselves were dropped above)
    this._netBlockKind = null;

    // Register item 69: the loop above clears every rack — a cargo mass-exit —
    // but sets arm.state directly, so no ARM_STATE_CHANGE crosses it and the
    // cleared mass would ride the rotational model until the next arm/berth
    // event. Invalidate the attitude-inertia cache directly at the exit site,
    // the item-63/67 seam (reset-side). The berthed/collared side needs
    // nothing: those nets survive the reset with their mass (no reset path
    // touches captureNetSystem.activeNets), so the ledger never loses them.
    if (this.playerSatellite) this.playerSatellite._attitudeInertia = null;
    // Lane 3f F4: a new run (and a game-over continue) lets the empty ion-fuel store line be said once more.
    if (this.playerSatellite) this.playerSatellite._daughterIndiumEmptySaid = false;

    // V5: Reset pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // arms-auto: forget the automatic-pose state and any manual-override markers.
    if (this._strutAuto) this._strutAuto.reset();
    this._strutPress = 0;
    this._allFullSaid = false;        // hold-catch: the "all daughters are holding catches" line may be said again
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;
    this._missionCarrySaid = null;
    for (const arm of this.arms) { delete arm._strutManual; delete arm._holdPose; }

    // Re-apply any purchased upgrades to the freshly reset arms
    this._reapplyStoredUpgrades();
  }

  /**
   * Register item 71 — release the pieces reset() drops (the rack + the in-hand
   * scalar) back to the field as free, re-targetable bodies. Mirrors the
   * release idiom of ArmUnit._releaseCapturedDebris (haul failure) and
   * CaptureNetSystem._clearCatchPins (mother exits): clears the authoritative
   * pin AND the captor back-reference — both must go, or DebrisField's
   * _pinToArm branch re-pins the piece to the freshly re-docked arm (the ghost
   * in a different costume) — and re-seats the orbit from the shown pin via
   * the ONE shared computation (reseatOrbitFromScene, the §8 A2
   * _reseatOrbitOnRelease seam). Without a player velocity the re-seat skips
   * and the piece resumes its live orbit (the orbit kept propagating under the
   * pin — DebrisField freezes only _onboardingPinned/_motherParked).
   * @param {Array<object>|null} pieces
   * @param {{x:number,y:number,z:number}|null} releaseVel km/s (Y-up scene frame)
   * @private
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
      clearRackCell(d);                // rack-snug: and the cell it held on her
      // Nets step 3 slice 5 (lane 5b, C5): a pending BIG piece that breaks loose leaves the ledger with a plain line (nobody pays for it
      // now) and is `_disposed`. GameFlowManager clears the ledger BEFORE a new game's reset, so this says nothing there.
      if (bigPieces.loose(d.id)) d._disposed = true;
    }
  }

  /**
   * no-melt: the station takes the catches parked on the daughters' racks (the resupply stop; GameFlowManager).
   * Each paid piece leaves the rack and is returned for the caller to remove from the field; the rack is cleared, so
   * ArmUnit's empty-rack fallback sends her to reload next frame and she can launch again. A piece that is not yet
   * paid is left on the rack. Emits NET_CONSUMED per piece (the bag visual clears the way the cook's end does); no
   * CATCH_PROCESSED (nothing is credited or digested).
   * @param {(piece: object) => boolean} [isPaid] - true when the piece has been credited (default: `_credited`)
   * @returns {Array<object>} the pieces handed over
   */
  unloadHeldCatches(isPaid) {
    // slice 5 (5b): a pending big piece is credited but UNPAID (it pays when disposed of): the default never unloads one for nothing
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
        clearRackCell(d);               // rack-snug: it leaves her rack
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
   * Nets step 3 slice 5 (lane 5b, P4): take ONE piece off a daughter's rack, as `unloadHeldCatches` does per piece (a big piece being
   * disposed of; the caller clears the field body's own pins, a rack may hold a snapshot of it). The rack entry's pins and cell go,
   * NET_CONSUMED is said (the bag visual clears; a collared catch that was waiting for room tries again), the rack is empty so ArmUnit's
   * fallback sends her to reload next frame. Refuses (null) unless she is HOLDING_CATCH and not carrying it anywhere (a carry to a tip
   * or the nose is in transit).
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
   * Nets step 3 slice 5 (lane 5b, P5): put a restored big piece back on a daughter's rack after a reload: the daughter it was saved on
   * if she is home and empty, else the one the cargo routing would pick (home, empty, not the last able to capture). Nothing is credited.
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

  // ========================================================================
  // arms-auto — the daughter arms mostly move themselves (DECISIONS §25 ruling 5)
  // ========================================================================

  /**
   * Hand the once-per-player record to the automation (main.js, next to setDebrisField).
   * No store (tests, a bare boot) → the full-range show never runs.
   * @param {import('../systems/StrutAuto.js').StrutAutoStore|null} store
   */
  setStrutAutoStore(store) { this._strutAutoStore = store || null; }

  /**
   * Per frame, after the launch gates: run the StrutAuto controller over this manager's
   * state. Inert unless FEATURE_FLAGS.STRUT_AUTO and a debris field is wired (production
   * wires it; the bare mocks of most tests never do).
   * @param {number} dt
   * @private
   */
  _updateStrutAuto(dt, paused = false) {
    if (!this._strutAuto) return;                  // bare Object.create(ArmManager.prototype) test objects
    if (paused) { this._strutAuto.suspend(); return; }   // menu / briefing / shop: no show, no auto moves
    if (!this._strutAutoView) this._strutAutoView = this._buildStrutAutoView();
    this._strutAuto.update(dt, this._strutAutoView);
  }

  /** The read-only snapshot + few actions StrutAutoController works through. @private */
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
        // wheel-preturn: the autopilot's pre-turn swings a docked strut for the shot and holds it there until a launch or a cancel
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
   * Metres to the nearest discovered, free (not netted, not pinned) piece within the
   * "leave" ring (NET_LOCK_RANGE_M x STRUT_AUTO.LEAVE_FACTOR) of the ship; Infinity when none.
   * Always re-filtered by distance: a same-frame call can hand back a cached larger set.
   * @returns {number}
   * @private
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
      if (!d || d.alive === false || d._disposed) continue;     // (slice 5, 5d: a piece that was disposed of is no catch to be near)
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

  /**
   * Show safety net: clearance (m) of arm `arm`'s strut + daughter at sweep angle `alphaRad`
   * against the ship, from a thin strut capsule plus a daughter sphere. Infinity when there
   * is no keep-out (mock ship). Own strut/daughter/rack are ignored.
   * @private
   */
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

  /**
   * Dispose all arms and remove from scene.
   */
  dispose() {
    for (const arm of this.arms) {
      arm.dispose();
    }
    this.arms = [];
  }

  // ==========================================================================
  // L2 — LAUNCH LINE: nothing is fired into a part of the ship
  // ==========================================================================
  // Every launch path (ceremony, key D by index, free-fly, trawl, fan-out, dual
  // fire) goes through `_launchArm` → `requestClearLaunch`. The line is the
  // daughter's body swept 15 m along the direction she will fire, checked
  // against the ship's REAL triangles (ShipKeepOut). Known limit: the line is
  // not re-checked during the 1.5 s magnetic-clamp hold before the spring fires
  // (CROSSBOW_UNDOCK_TIME) — a strut moved in that window is not caught.

  /**
   * One ShipKeepOut for this manager's ship (lazy). Null when there is no real
   * ship (bare-ArmUnit tests, mock ships): the launch gate is then a no-op.
   *
   * Held-catch obstacles are supplied through `setSphereProvider`:
   * the nose catch (CaptureNet BERTHED/COLLARED/TRANSFERRING) at its REAL radius
   * `sizeMeter / 2` + 0.05 m of net margin — NOT the 2 m readability floor
   * (`MOTHER_CATCH_MIN_RENDER_M` is a drawing floor, Ruling 0: physically real) —
   * and every daughter's parked rack (`heldSlotWorldInto`). Lane l5a feeds tip
   * bags in by extending `_heldCatchSpheres` (push `{ c: [x,y,z] ship metres,
   * r, name, cat: 'catch' }`) or by calling `getKeepOut().setSphereProvider(fn)`
   * with a wrapper that also returns `this._heldCatchSpheres()`.
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
   * Held catches as keep-out spheres in the SHIP frame, metres. Called by the
   * keep-out once per query, after it has brought the matrices up to date.
   * @returns {Array<{c:number[], r:number, name:string, cat:string}>}
   * @private
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

    // The nose catch held by the mother net.
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

    // Bags held on the radiator tips (lane l5b-wire). Raw bag radius, no net margin: the measured
    // hand-off clearances (tmp/probes/leash/multi2) are against the bag itself.
    const tc = p.tipCargo;
    if (tc && typeof tc.count === 'function' && tc.count() > 0) {
      for (const sp of tc.spheres()) {
        out.push({ c: [sp.c.x, sp.c.y, sp.c.z], r: sp.r, name: `tip bag ${sp.name.split('_')[1]}`, cat: 'catch' });
      }
    }

    // Pieces parked on a daughter's rack.
    const slot = this._koSlot || (this._koSlot = new THREE.Vector3());
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      const held = arm && arm.heldCatches;
      if (!held || held.length === 0 || typeof arm.heldSlotWorldInto !== 'function') continue;
      for (let k = 0; k < held.length; k++) {
        const d = held[k];
        if (!d) continue;
        const size = d.sizeMeter || 1;
        // rack-snug (Decision 4): the sphere sits where the piece IS — its cell on her, not a slot in a hold axis.
        // Decision 7: its radius is the drawn reach from that point (true size), not sizeMeter / 2.
        // rack-centre fix round 1: during the 1 s cell-1 → cell-0 slide it is where the piece is drawn NOW, not the slide's end.
        if (!(d._rackSlide && typeof arm.heldDrawnWorldInto === 'function' && arm.heldDrawnWorldInto(d, slot, p.quaternion))) {
          arm.heldSlotWorldInto(k, size, p.position, slot, d, p.quaternion);
        }
        push(slot, DebrisField.trueReachM(d, size) + 0.05, `rack catch ${i}`);
      }
    }
    return out;
  }

  /** Ship-frame unit vector: origin → strut tip of `arm` (what free-fly / trawl fire along). @private */
  _dockDirShip(arm) {
    return arm.dockOffset.clone().normalize();
  }

  /** Ship-frame unit vector along the arm's CURRENT strut (what deploy() fires along after the aim ceremony). @private */
  _strutDirShip(arm) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    return strutLocalDirection(arm.getAimAlpha(), az, new THREE.Vector3()).normalize();
  }

  /** World (scene) direction → ship frame. @private */
  _worldToShipDir(vec) {
    const q = this.playerSatellite && this.playerSatellite.quaternion;
    const out = new THREE.Vector3(vec.x, vec.y, vec.z);
    if (q) out.applyQuaternion(q.clone().invert());
    return out.normalize();
  }

  /**
   * The direction `ArmUnit.deploy(target)` will fire along, in the ship frame:
   * the converged strut after an aim ceremony, else the direct bearing to the
   * target, else (no target position) the dock direction.
   * @private
   */
  _launchDirShip(arm, target) {
    const tp = target && target._scenePosition;
    if (!tp) return this._dockDirShip(arm);
    if (arm._aimConverged) return this._strutDirShip(arm);
    return this._worldToShipDir(new THREE.Vector3(tp.x - arm.position.x, tp.y - arm.position.y, tp.z - arm.position.z));
  }

  /** Trawl direction (world, optional) in the ship frame. @private */
  _trawlDirShip(arm, direction) {
    return direction ? this._worldToShipDir(direction) : this._dockDirShip(arm);
  }

  /**
   * Launch `arm` at `target` (deploy) or free-fly (no target) through the gate.
   * @private
   */
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
   * @param {object|null} [target] — interlocks-p2: the piece this launch is for (modes 'target' / 'ceremony'). It is hers from
   *   the request until the spring fires; if it was caught or taken by then she stays docked and says so (R4).
   * @returns {boolean} true when the launch fired or was accepted (deferred); false when refused
   * @private
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
      // R5 at the spring: the strut was picked for the ship as it stood; the autopilot or an aim may have turned her since
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
   * Capsule from the daughter's body centre along `dirShip` for 15 m, radius =
   * her own half-width across that direction (measured from her mesh), ignoring
   * herself, her strut and her own rack. Reports every part the capsule touches.
   * @param {number} armIndex
   * @param {{x:number,y:number,z:number}|number[]} dirShip — ship frame, need not be unit
   * @returns {{blocked:boolean, part:string, cat:string, name:string, hits:Array<{name:string,cat:string,gap:number}>}}
   */
  launchLineBlocked(armIndex, dirShip) {
    const none = { blocked: false, part: '', cat: '', name: '', hits: [] };
    const ko = this.getKeepOut();
    const arm = this.arms[armIndex];
    if (!ko || !arm || !dirShip) return none;
    const raw = Array.isArray(dirShip) ? dirShip : [dirShip.x, dirShip.y, dirShip.z];
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    if (!(len > 1e-9)) return none;
    const d = [raw[0] / len, raw[1] / len, raw[2] / len];

    const body = ko.measureCat('dau' + armIndex, d);
    let c, r;
    if (body.n > 0) {
      c = body.centre; r = body.halfWidth;
    } else {                                   // no mesh to measure: tip + table size
      c = [arm.dockOffset.x / M, arm.dockOffset.y / M, arm.dockOffset.z / M];
      r = Math.max(...(arm.config.bodyDims || [0.4])) / 2;
    }
    const L = 15;
    const res = ko.segment(c, [c[0] + d[0] * L, c[1] + d[1] * L, c[2] + d[2] * L], r, {
      hits: true,
      ignore: ['dau' + armIndex, 'strut' + armIndex, 'rack catch ' + armIndex],
    });
    if (!res.hits || res.hits.length === 0) return none;
    const h = res.hits[0];
    return { blocked: true, part: this._plainPart(h), cat: h.cat, name: h.name, hits: res.hits };
  }

  /** Plain-words name of a blocking part, for the comms line. @private */
  _plainPart(h) {
    const cat = (h && h.cat) || '';
    if (cat === 'wing') return 'a solar wing';
    if (cat === 'rad') return 'a radiator';
    if (cat === 'catch') return /^nose catch/.test(h.name || '') ? 'the catch at the nose' : 'a held catch';
    if (/^(strut|dau)\d+$/.test(cat)) return 'another strut';
    return 'the hull';
  }

  /**
   * Can the blockers on arm `i`'s line be moved out of the way by opening
   * struts to the open angle (90°)? Two cures exist:
   *   - another strut/daughter in the line: that arm is DOCKED, not held by the
   *     lean-aside duck, and not already at the open angle → open IT;
   *   - anything else (hull, nose, radiator, wing, held catch): the launching
   *     strut itself is below the open angle (the 0° park) → open IT, since the
   *     line is re-derived from the open pose. If the part is STILL in the way
   *     once the strut has arrived (own strut no longer movable), the launch is
   *     refused with that part's line.
   * The plan's literal rule only opened the own strut for the hull; the owner's
   * wording ("open ... struts to 90 or as needed") and the measured park
   * geometry (a 0° strut's line crosses folded radiators too) made that
   * too strict — logged in tmp/plans/l2-keepout.md.
   * @private
   */
  _launchVerdict(i, dirShip, mode) {
    const res = this.launchLineBlocked(i, dirShip);
    if (!res.blocked) return { blocked: false, fixable: true, open: [], openOwn: false, part: '', cat: '', hits: [] };
    const arm = this.arms[i];
    const openAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
    const tol = Math.PI / 180;
    const lean = this._leanAsideArmIndices;
    const ownLive = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : openAlpha;
    // A ceremony launch fires along the strut she has just aimed: her own strut is never
    // moved for it (a wing, radiator, catch or the hull in that line refuses, with its line).
    // launch-aim: an aimed launch (strut already swung toward the target) may open her own strut
    // toward 90° from EITHER side (e.g. 170° → 90°); the old gate only ever opened from below.
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

  /** Command the struts a blocked line needs open to the open angle (90°). @private */
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

  /** No fire: one comms line + one event. @private */
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
   * u18a (D1): is HER launch still on its way, with her not yet off the dock? True from the moment DEPLOY is accepted
   * (the mother turns for her: she holds `_aimReserved`, `_deployWithCeremony`; or the keep-out gate / strut aim holds her:
   * an entry in `_pendingLaunches`) until she leaves DOCKED. Read only: changes nothing.
   * @param {number} i - arm index
   * @returns {boolean}
   */
  isLaunchPending(i) {
    const arm = this.arms[i];
    if (!arm || arm.state !== ARM_STATES.DOCKED) return false;
    return arm._aimReserved === true || !!(this._pendingLaunches && this._pendingLaunches.has(i));
  }

  /** Forget a pending launch and give back the arm reservation we took. @private */
  _dropPendingLaunch(i) {
    const pend = this._pendingLaunches;
    const p = pend && pend.get(i);
    if (!p) return;
    pend.delete(i);
    const arm = this.arms[i];
    if (arm && p.reservedByUs) arm._aimReserved = false;
    // launch-aim: a launch cancelled mid-swing stops the strut where it is (the latch is ours if it still holds our angle).
    if (arm && p.stage === 'aim' && arm._strutTargetAlpha === p.aimAlpha) arm._strutTargetAlpha = undefined;
  }

  /**
   * Gate a launch on a clear line. Clear → `fire()` now (same frame as before
   * the gate existed). Blocked only by what opening struts can clear → open them,
   * keep ONE pending launch (arm reserved) that re-checks every update() and
   * fires when clear, giving up after 8 s. Any other blocker → no fire. With no
   * real ship the gate is a no-op. A checker error fails OPEN (the launch fires):
   * a broken check must not strand the fleet.
   * @param {number} armIndex
   * @param {() => THREE.Vector3} getDirShip — ship-frame fire direction, re-derived every check
   * @param {() => boolean} fire
   * @param {string} [mode] — launch mode ('ceremony' never moves her own strut)
   * @param {{announce?: boolean}} [opts] — `announce`: the number-key launch; if the aim stage holds
   *   it back, it announces itself (the cut-scene start) when it fires.
   * @returns {boolean} fired, or accepted and waiting (true); refused (false)
   */
  requestClearLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // trip-melt D7: no launch while the ship burns to the next field
    const arm = this.arms[armIndex];
    if (!arm || !this.getKeepOut()) return !!fire();
    const pend = this._pendingLaunches || (this._pendingLaunches = new Map());
    if (pend.has(armIndex)) return true;

    // launch-aim: one driver per strut. The D-key ceremony reserves her while it aims; a second launch
    // request would swing her strut under it (the ceremony fires along the strut it converged on).
    if (Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true && mode !== 'ceremony' && arm._aimReserved) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${arm.displayName} is already aiming.`, priority: 'warning' });
      return false;
    }

    // launch-aim: swing the strut toward where she is going first, then check the line along it.
    if (this._aimsStrut(mode)) {
      const r = this._requestAimedLaunch(armIndex, getDirShip, fire, mode, opts);
      if (r !== undefined) return r;                    // undefined = could not aim: today's gate below
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
   * Per-update tick for launches the gate is holding: cancel when the arm has
   * left DOCKED (or was reset), safe mode started, or the arm bus is off; fire
   * when the line is clear; keep the needed struts opening; give up after 8 s or
   * as soon as the remaining blocker is one opening cannot clear.
   * @param {number} dt
   * @private
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
        // The gate opened her strut to clear her line: it stops where the line cleared, so she never
        // floats off a strut that keeps swinging towards the full-open angle (owner: "to 90 or as needed").
        if (p.openedOwn && typeof arm.getAimAlpha === 'function') arm._strutTargetAlpha = arm.getAimAlpha();
        p.fire();
        continue;
      }
      if (!v.fixable) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'blocked'); continue; }
      if (p.t >= 8) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'timeout'); continue; }
      this._openForLaunch(i, v);
    }
  }

  // ==========================================================================
  // launch-aim — the strut aims first, then the spring pushes along it
  // (FEATURE_FLAGS.LAUNCH_AIMS_STRUT; lane launch-aim, 2026-10-16)
  // ==========================================================================
  // Every 'target' / 'freefly' / 'trawl' launch through `requestClearLaunch` first swings the
  // daughter's own strut — at its real motor rate (STRUT_SLEW_RATE, 15°/s), never faster — to the
  // best angle toward where she is going (`bestStrutAlpha`, capped short of a held catch's berth
  // corridor), then checks the launch line ALONG THE STRUT and fires with the push along the strut.
  // Pending entries carry `stage`: 'aim' (swinging; no line verdict — the swing path is not
  // checked: the full 0–180° range is measured clear of the ship's own parts) then 'line' (the
  // gate's old open-the-blockers logic, on the strut-axis line). OFF = today's gate, untouched.

  /** Does a launch in `mode` aim the strut first? ('ceremony' already aimed; bare modes keep the old gate.) @private */
  _aimsStrut(mode) {
    return Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true
      && (mode === 'target' || mode === 'freefly' || mode === 'trawl');
  }

  /**
   * Radius (m) of the berth corridor of the catch the mother is holding or taking in
   * (`sizeMeter / 2 + BERTH_CLEARANCE_M`, the same radius the lean-aside duck uses), or null.
   * @private
   */
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
   * The strut angle arm `i` should swing to for a launch toward `wantedShip` (ship frame):
   * `bestStrutAlpha`, capped below the first angle (1° steps from her live angle toward it) at
   * which her tip would foul a held catch's berth corridor. Fouling only happens at the high
   * angles, so only an upward swing is capped; if her live angle already fouls, she stays.
   * @private
   */
  _aimAlphaFor(i, wantedShip) {
    const arm = this.arms[i];
    // bestStrutAlpha(dir exactly along ±z) can return -π (atan2(-0, negative)); |.| is the same strut angle in [0, π].
    const best = Math.min(Math.PI, Math.abs(bestStrutAlpha(wantedShip, Math.atan2(arm.dockOffset.y, arm.dockOffset.x))));
    const radiusM = this._heldCatchCorridorRadiusM();
    const now = arm.getAimAlpha();
    if (radiusM === null || best <= now) return best;
    const step = Math.PI / 180;
    let prev = now;
    for (let a = now + step; ; a += step) {
      const at = Math.min(a, best);
      if (this._strutFoulsInboundCorridor(i, radiusM, at)) return prev;
      prev = at;
      if (at >= best) return best;
    }
  }

  /** How much closer (rad) the strut axis at `toAlpha` points to `wantedShip` than at `fromAlpha`. @private */
  _aimGainRad(arm, wantedShip, fromAlpha, toAlpha) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const w = _aimTmpWanted.copy(wantedShip).normalize();
    const angTo = (alpha) => Math.acos(Math.max(-1, Math.min(1, strutLocalDirection(alpha, az, _aimTmpAxis).dot(w))));
    return angTo(fromAlpha) - angTo(toAlpha);
  }

  /**
   * Fire a launch whose strut is in place: nothing may move her strut while LAUNCHING (clear the
   * latch), and `_aimConverged` tells `deploy()` / `deployFreefly()` / `deployTrawl()` to push along
   * the strut axis. The flag never outlives the call.
   * @private
   */
  _fireAimed(i, fire) {
    const arm = this.arms[i];
    arm._strutTargetAlpha = undefined;
    arm._aimConverged = true;
    try { return !!fire(); } finally { arm._aimConverged = false; }
  }

  /**
   * The number-key launch fired after waiting to aim: what InputManager emits for an immediate one.
   * launch-seq: the cut-scene start only. The "deployed. Tracking…" line is gone; the one launch line is
   * "Spring released. Separating", from ArmUnit when the spring fires.
   * @private
   */
  _announceLaunch(arm) {
    eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
  }

  /** The strut never swung into place: one comms line + one event. @private */
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
   * `requestClearLaunch` for an aimed mode. Returns true (fired or waiting), false (refused), or
   * undefined when the wanted direction cannot be derived (the caller falls back to today's gate).
   * @private
   */
  _requestAimedLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // trip-melt D7 (see requestClearLaunch)
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

    // The dock direction (free-fly; a trawl without a direction) is the ray from the ship's centre through HER
    // OWN strut tip, so it moves whenever her strut moves: following it would chase its own tail (measured: a
    // free-fly launch swung to 155° and took 4-10 s instead of 2-3 s). Freeze it at the request; it does not
    // change when the ship turns (it is a ship-frame direction), so there is nothing to follow.
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
   * 'aim': keep the latch on the best angle (the ship may turn, her tip moves as she swings) until
   * she is within 1° of it with the latch cleared (or the duck takes her); 'line': the gate's line
   * logic on the strut-axis line. Gives up at (swing time + 8 s).
   * @private
   */
  _tickAimedLaunch(i, p, arm, dt) {
    // Headless mocks have no ship strut driver: slew the latch here (the _updateCargoPlumePoses idiom).
    // (dt > 0 only: a zero-step call must not snap the strut.)
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
          // Her tip (the bearing's origin) and the ship's own turn move the wanted direction, so the best
          // angle drifts: follow it when it moved > 1° AND the move points the strut closer to the wanted
          // direction by at least 0.5° and a quarter of the move. That second test stops a flip-flop when
          // the wanted direction is nearly tangential to her swing plane (the best angle then jumps
          // 0 <-> 180° while both are about equally far off: measured, a 46 m target did this for 17 s).
          // A follow-up that keeps the direction of the previous move (a ship turning steadily) is free;
          // only a REVERSAL counts toward AIM_MAX_REAIMS, so a flip-flop still ends after 4 and a steady
          // drift is bounded by the 0-180° range. Each follow-up adds its swing time to the give-up clock.
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
