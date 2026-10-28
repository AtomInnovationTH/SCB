/**
 * CoMCalculator.js — Center-of-Mass, inertia and thruster plume-cone checks
 * ST-9.12 (C-9) — Config G Gaps #5 + #8
 *
 * Computes spacecraft CoM offset from barrel center considering:
 * - Core bus mass at origin (barrel center)
 * - Strut masses at alpha-dependent midpoint positions (cantilever CoM)
 * - Daughter masses at strut tip positions
 *
 * Plume interference checks:
 * - Thruster nozzle cones vs strut tip positions
 * - Binary block per-thruster when any strut tip falls inside cone
 *
 * All positions are in **mother-local body coordinates** (meters, origin at
 * barrel center) — in the RENDERED ship's frame: barrel long axis = ship Z,
 * stowed struts aft at −Z, roll about Z (ArmDockBasis.strutLocalDirection:
 * α=0 → −Z). Scene-unit conversion uses M = 0.00001 (1 m in scene units).
 *
 * FRAME CONTRACT (cargo-continuity S13(a), register item 57): the dock ring is
 * STORED in generateDockPositions' Y-barrel convention (hinge ring in the XZ
 * plane, COLLAR_Y in the y slot, stow direction −ŷ) — CameraSystem's
 * aim bridge reads `arm._dockOutward` in that convention, so the
 * stored fields cannot move. The mass model converts at the ONE boundary —
 * strutTipMeters / strutMidpointMeters — via the Y/Z swap
 * (x, y, z)_ship = (x, z, y)_stored, a rigid remapping: every magnitude
 * (|CoM position|, the drift scalar, totalMass) is byte-comparable across it,
 * and every downstream consumer (CoM, inertia, drift, both scorers, the plume
 * cone test) computes in ONE frame.
 *
 * BOOKING CONTRACT (S13(b), register item 58; rack-snug 2026-10-18): held rack cargo is booked where
 * the pin actually holds it — the strut tip PLUS the rack cell's offset on the daughter
 * (her +Z support + the catch's drawn extent + the net gap, beside her end), turned by her attitude, via ONE
 * computation (heldCargoBookingMeters → ArmUnit.heldSlotAnchorInto). Pre-S13(b) the model
 * booked rack cargo AT the tip, understating the CoM lever ~10× (measured at
 * S12's M1: 1600 kg finale 0.68 m modelled vs 6.80 m at the pin).
 *
 * @module systems/CoMCalculator
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { heldSlotAnchorInto, rackOffsetFor, catchLongAxisInto, nextFreeRackCell } from '../entities/ArmUnit.js';
import { composeDockedArmQuat } from '../entities/ArmDockBasis.js';
import { DebrisField } from '../entities/DebrisField.js';           // net-duck D1: the drawn scale of a held catch
import { DebrisWireframe } from '../ui/DebrisWireframe.js';          // net-duck D1: the drawn mesh
import { degToRad, clamp01, lerp } from '../core/MathUtil.js';

/** 1 meter in scene units — matches ArmManager/PlayerSatellite convention */
const M = 0.00001;

const V5 = Constants.OCTOPUS_V5;

// ═══════════════════════════════════════════════════════════════════════════
// §1  CoM Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a stored dock position to the rendered ship frame, in meters.
 * Stored (generateDockPositions, Y-barrel): hinge ring in the XZ plane, collar
 * height in the y slot, stow direction −ŷ. Ship (Z-barrel, the rendered frame):
 * hinge ring in the XY plane, collar height in z, stow direction −ẑ.
 * The map is (x, y, z)_ship = (x, z, y)_stored — the Y/Z swap of register
 * item 57. S13(a): this is the ONLY place dock geometry enters the mass model.
 *
 * @param {{hingePosition:{x:number,y:number,z:number}, dockOutward:{x:number,y:number,z:number}}} dockPos
 * @returns {{hx:number, hy:number, hz:number, ox:number, oy:number, oz:number}}
 */
function _dockToShipFrame(dockPos) {
  const hp = dockPos.hingePosition;
  const ow = dockPos.dockOutward;
  return {
    hx: hp.x / M, hy: hp.z / M, hz: hp.y / M,
    ox: ow.x, oy: ow.z, oz: ow.y,
  };
}

/**
 * Compute strut tip position in body-local meters, ship frame (see the module
 * FRAME CONTRACT). Matches ArmManager.getStrutTipPosition() (C-2) — ONE
 * computation, the twin delegates here.
 *
 * tip = hinge + L × (sin(α)·dockOutward − cos(α)·ẑ)     (stowed = aft at −Z)
 *
 * @param {{hingePosition:{x:number,y:number,z:number}, dockOutward:{x:number,y:number,z:number}}} dockPos
 * @param {number} alpha — strut sweep angle (rad), 0=stowed, π/2=equatorial, π=zenith
 * @returns {{x:number, y:number, z:number}} position in meters, ship frame
 */
export function strutTipMeters(dockPos, alpha) {
  const L = V5.STRUT_LENGTH; // 1.70 m
  const { hx, hy, hz, ox, oy, oz } = _dockToShipFrame(dockPos);
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  return {
    x: hx + L * sinA * ox,
    y: hy + L * sinA * oy,
    z: hz + L * (sinA * oz - cosA),
  };
}

/**
 * Compute strut midpoint position (approximate strut CoM for a uniform rod).
 * Used for the strut structural mass contribution to overall CoM.
 * Same frame contract as strutTipMeters.
 *
 * @param {{hingePosition:{x:number,y:number,z:number}, dockOutward:{x:number,y:number,z:number}}} dockPos
 * @param {number} alpha — strut sweep angle (rad)
 * @returns {{x:number, y:number, z:number}} midpoint position in meters, ship frame
 */
export function strutMidpointMeters(dockPos, alpha) {
  const halfL = V5.STRUT_LENGTH / 2;
  const { hx, hy, hz, ox, oy, oz } = _dockToShipFrame(dockPos);
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  return {
    x: hx + halfL * sinA * ox,
    y: hy + halfL * sinA * oy,
    z: hz + halfL * (sinA * oz - cosA),
  };
}

// ── S13(b) / rack-snug: rack-cargo booking (register item 58) ───────────────
// Module temps — the repo hot-path idiom (computeCoM runs per frame; none of
// these may be retained across calls).
const _hcdAnchor = new THREE.Vector3();
const _hcdDir = new THREE.Vector3();
const _hcdOut = new THREE.Vector3();
const _hcdOff = new THREE.Vector3();
const _hcdLong = new THREE.Vector3();
const _hcdQ = new THREE.Quaternion();
const _ihAnchor = new THREE.Vector3();   // in-hand booking temps (base behaviour)
const _ihDir = new THREE.Vector3();
const _ihUp = new THREE.Vector3();
const _ihLat = new THREE.Vector3();
const _ihQInv = new THREE.Quaternion();
/** Reused plain-object target for heldCargoBookingMeters on the hot paths. */
const _slotPoint = { x: 0, y: 0, z: 0 };

/**
 * Where a held rack piece actually IS, booked in the honest ship frame, in
 * meters. The anchor is the strut tip from strutTipMeters (the ONE S13(a)
 * conversion lives inside it — read it, never re-derive it).
 *
 * rack-snug (Decision 4): a rack cell is a place on HER, so the booking is the tip PLUS the cell's offset on her,
 * turned by her attitude in the ship's body frame at this strut angle — `heldSlotAnchorInto(tip, herQuat, offset)`,
 * the ONE computation shared with `ArmUnit.heldSlotWorldInto` (register item 58). The offset is the piece's stored
 * `_rackLocalM`; a piece without one (a prediction by size, an old save, a mock) takes the typeless form for `slotIndex`
 * (`ArmUnit.rackOffsetFor`). Her attitude is the docked basis `composeDockedArmQuat(strutDir(α), azimuth)` — the same
 * one the pin composes with the ship's quaternion — so no world direction, hold axis or ship attitude enters:
 * `playerSatellite` is kept in the signature for the callers only.
 *
 * `axisOut` receives the unit body-frame LONG axis of the piece as it sits — the piece's longest mesh axis turned by
 * its attitude in her frame — for the plume volume model (S9); a piece with no stored attitude (or no mesh) reports her
 * +Z (the strut's outboard direction).
 *
 * Internally the arithmetic runs on the pin's scene-unit tree (tip × M in,
 * ÷ M out) so that under an identity ship fixture the booking equals
 * `heldSlotWorldInto`'s output to float equality — same operands, same order.
 *
 * @param {object} arm — ArmUnit instance or mock (reads herSupportZM / config for the typeless form only)
 * @param {object} dp — dock position (stored convention; see the FRAME CONTRACT)
 * @param {number} alpha — strut sweep angle (rad)
 * @param {object|null} playerSatellite — unused (see above)
 * @param {number} slotIndex — the cell (0-based) when `held` carries none
 * @param {number} sizeMeter — the piece's size, for a prediction
 * @param {{x:number,y:number,z:number}} out — receives the booking point, meters
 * @param {{x:number,y:number,z:null}} [axisOut] — receives the unit body-frame long axis (see above)
 * @param {object|null} [held] — the piece (its stored cell, offset and attitude)
 * @param {THREE.Quaternion|null} [quatOut] — net-duck D1: receives the piece's DRAWN attitude in the ship frame (her attitude at this
 *   strut angle × the attitude frozen in her frame, `held._qLocalHer`; her attitude alone for a piece without one)
 * @returns {{x:number,y:number,z:number}} out
 */
export function heldCargoBookingMeters(arm, dp, alpha, playerSatellite, slotIndex, sizeMeter, out, axisOut, held = null, quatOut = null) {
  const tip = strutTipMeters(dp, alpha);
  _hcdAnchor.set(tip.x * M, tip.y * M, tip.z * M);

  // Her attitude in the ship's body frame at this α: the docked basis (identity mother).
  const g = _dockToShipFrame(dp);
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  _hcdDir.set(sinA * g.ox, sinA * g.oy, sinA * g.oz - cosA);
  const az = Number.isFinite(dp.azimuthDeg) ? degToRad(dp.azimuthDeg) : Math.atan2(g.oy, g.ox);
  composeDockedArmQuat(_hcdDir, az, _hcdQ);

  const cell = (held && Number.isInteger(held._rackCell)) ? held._rackCell : slotIndex;
  rackOffsetFor(_hcdOff, arm, held, cell, sizeMeter);
  heldSlotAnchorInto(_hcdAnchor, _hcdQ, _hcdOff, _hcdOut);
  out.x = _hcdOut.x / M;
  out.y = _hcdOut.y / M;
  out.z = _hcdOut.z / M;
  if (axisOut) {
    if (held && held._qLocalHer && held.type) catchLongAxisInto(held, _hcdLong);
    else _hcdLong.set(0, 0, 1);
    if (held && held._qLocalHer) _hcdLong.applyQuaternion(held._qLocalHer);
    _hcdLong.applyQuaternion(_hcdQ);
    axisOut.x = _hcdLong.x;
    axisOut.y = _hcdLong.y;
    axisOut.z = _hcdLong.z;
  }
  if (quatOut) {
    quatOut.copy(_hcdQ);
    if (held && held._qLocalHer) quatOut.multiply(held._qLocalHer);
  }
  return out;
}

/**
 * Where a catch held IN HAND (`arm.capturedDebris`: pulled in, reeling, docking) is booked, in meters, ship frame.
 * rack-snug did NOT change this (the plan covers the rack only): it is the base behaviour, kept byte for byte —
 * the slot-0 geometry along the hold axis: anchor (strut tip) + holdDir·(size/2 + ARM_HOLD_CLEARANCE_M) + the
 * lateral bias along (holdDir × world up). The hold axis follows the pin's sources in the pin's order: 1. the fired
 * net's launch direction (world → body by the inverse attitude); 2. else the strut-outboard direction (the tip
 * direction); 3. else zero (books AT the tip). `axisOut` receives the resolved unit hold axis (zero when none).
 *
 * @param {object} arm — ArmUnit instance or mock (reads arm._firedNet only)
 * @param {object} dp — dock position (stored convention)
 * @param {number} alpha — strut sweep angle (rad)
 * @param {object|null} playerSatellite — source of the attitude quaternion
 * @param {number} sizeMeter — the piece's size, for the standoff radius
 * @param {{x:number,y:number,z:number}} out — receives the booking point, meters
 * @param {{x:number,y:number,z:number}} [axisOut] — receives the resolved body-frame hold axis
 * @returns {{x:number,y:number,z:number}} out
 */
export function heldInHandBookingMeters(arm, dp, alpha, playerSatellite, sizeMeter, out, axisOut) {
  const tip = strutTipMeters(dp, alpha);
  _ihAnchor.set(tip.x * M, tip.y * M, tip.z * M);

  let hasDir = false;
  const ld = arm && arm._firedNet && arm._firedNet.launchDirection;
  const q = playerSatellite && playerSatellite.quaternion;
  const hasQ = q && typeof q.x === 'number';
  _ihUp.set(0, 1, 0);
  if (hasQ) {
    _ihQInv.copy(q).invert();
    _ihUp.applyQuaternion(_ihQInv);       // world-up → body-up, on EVERY path
  }
  if (ld) {
    _ihDir.set(ld.x, ld.y, ld.z);
    hasDir = _ihDir.lengthSq() > 1e-12;
    if (hasDir && hasQ) _ihDir.applyQuaternion(_ihQInv);   // world → body
  }
  if (!hasDir) {
    _ihDir.copy(_ihAnchor);               // strut-outboard (the pin's position − mother)
    hasDir = _ihDir.lengthSq() > 1e-12;
  }
  if (hasDir) _ihDir.normalize(); else _ihDir.set(0, 0, 0);

  const clearance = (Constants.ARM_HOLD_CLEARANCE_M ?? 1.0);
  const bias = Constants.ARM_HOLD_LATERAL_BIAS ?? 0;
  const radius = (sizeMeter || 0) / 2 + clearance;
  _hcdOut.copy(_ihAnchor).addScaledVector(_ihDir, radius * M);
  if (bias !== 0 && _ihDir.lengthSq() > 1e-12) {
    _ihLat.crossVectors(_ihDir, _ihUp);
    if (_ihLat.lengthSq() < 1e-8) _ihLat.set(1, 0, 0); // holdDir ∥ up — pick world-X
    _ihLat.normalize();
    _hcdOut.addScaledVector(_ihLat, radius * M * bias);   // slot 0: no rotation
  }
  out.x = _hcdOut.x / M;
  out.y = _hcdOut.y / M;
  out.z = _hcdOut.z / M;
  if (axisOut) {
    axisOut.x = hasDir ? _ihDir.x : 0;
    axisOut.y = hasDir ? _ihDir.y : 0;
    axisOut.z = hasDir ? _ihDir.z : 0;
  }
  return out;
}

/**
 * Visit every mass point a docked/home arm contributes: the daughter herself at
 * the strut tip, then each held piece at its pinned slot (the in-hand scalar at
 * the slot-0 geometry — its home pin at dock completion; S6/S7's byte-identity
 * contract). The masses are exactly getDaughterMass's sum — only the BOOKING
 * moved off the tip (S13(b)). Detached/expended arms contribute nothing
 * (getDaughterMass's exclusion, the S10 ledger's meaning of "aboard").
 *
 * @param {(mass: number, point: {x:number,y:number,z:number}) => void} cb
 */
function _forEachArmMassPoint(arm, dp, alpha, playerSatellite, cb) {
  if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) return;
  const armMass = arm.config.type === 'weaver'
    ? Constants.V5_WEAVER_MASS
    : Constants.V5_SPINNER_MASS;
  cb(armMass, strutTipMeters(dp, alpha));
  const handMass = (arm.capturedDebris && arm.capturedDebris.mass) || 0;
  if (handMass > 0) {
    cb(handMass,
      heldInHandBookingMeters(arm, dp, alpha, playerSatellite, arm.capturedDebris.sizeMeter, _slotPoint));
  }
  if (Array.isArray(arm.heldCatches)) {
    for (let i = 0; i < arm.heldCatches.length; i++) {
      const held = arm.heldCatches[i];
      const m = (held && held.mass) || 0;
      if (m > 0) {
        cb(m, heldCargoBookingMeters(arm, dp, alpha, playerSatellite, i, held.sizeMeter, _slotPoint, undefined, held));
      }
    }
  }
}

/**
 * Get the arm (daughter) mass for a given arm.
 * Returns 0 if the arm is detached or expended (mass no longer on spacecraft).
 *
 * Mass sum only — the S13(b) positions live in _forEachArmMassPoint (the
 * structure at the tip, held cargo at its pinned slot).
 *
 * @param {object} arm — ArmUnit instance (or mock with .config.type, .isDetached, .state)
 * @returns {number} daughter mass in kg
 */
function getDaughterMass(arm) {
  // Detached or expended daughters are no longer attached to the spacecraft
  if (arm.isDetached) return 0;
  const state = arm.state;
  if (state === Constants.ARM_STATES.EXPENDED) return 0;
  // Active states where the daughter is physically away from the strut tip
  // (TRANSIT, APPROACH, etc.) — the daughter is still tethered but for CoM
  // purposes it's at the strut tip or slightly beyond. Simplify: mass at tip.
  const armMass = arm.config.type === 'weaver'
    ? Constants.V5_WEAVER_MASS
    : Constants.V5_SPINNER_MASS;
  // Cargo-continuity S2 (bug B2): a daughter parked in HOLDING_CATCH is holding
  // a captured body — that mass is cargo and must move CoM / inertia. Add it at
  // the strut tip (same point as the daughter). Guarded so a detached/expended
  // holder (already returned 0 above) and an empty/null catch contribute nothing.
  // For CoM this full mass applies directly; computeInertia splits the cargo
  // contribution out and clamps it with the berthed mass (INERTIA_MAX_FACTOR).
  // S6: the parked hold is a rack — sum every held piece plus any in-hand
  // catch (guarded: plain-object mocks may lack the field).
  let cargoMass = (arm.capturedDebris && arm.capturedDebris.mass) || 0;
  if (Array.isArray(arm.heldCatches)) {
    for (const held of arm.heldCatches) cargoMass += (held && held.mass) || 0;
  }
  return armMass + cargoMass;
}

/**
 * DECISIONS §33 row 4 (2026-10-20): the mother's nets aboard are real mass, held in the launcher at the nose — the same
 * `getMotherNetCount() x CAPTURE_NET.LARGE.MASS` ArmManager.getMassBudget adds to the carried dry mass, booked here
 * on the launcher axis so the two ledgers agree. They ride in the balanced reference too (a permanent, on-axis fitting,
 * not a player-correctable asymmetry), so the CoM DRIFT is unchanged by them.
 * @param {object} [playerSatellite] — for `_captureNetSystem.getMotherNetCount()` (guarded: mocks may lack it)
 * @returns {{ massKg: number, z: number }} massKg 0 when none aboard; z = the cartridge, mid-launcher (m, ship frame)
 */
export function motherNetBooking(playerSatellite) {
  const cns = playerSatellite && playerSatellite._captureNetSystem;
  const n = (cns && typeof cns.getMotherNetCount === 'function') ? cns.getMotherNetCount() : 0;
  // 2026-10-21 (nets-step2): the current line-fibre tier's packed-net mass (getMotherNetMassKg); mocks without it keep
  // the start-tier mass.
  const massKg = n > 0
    ? ((typeof cns.getMotherNetMassKg === 'function') ? cns.getMotherNetMassKg() : n * Constants.CAPTURE_NET.LARGE.MASS)
    : 0;
  return { massKg, z: (V5.NET_LAUNCHER_BASE_Z_M + V5.NET_LAUNCHER_MUZZLE_Z_M) / 2 };
}

/**
 * Compute composite center-of-mass of the entire spacecraft in body-local coordinates.
 *
 * Model:
 *   - Core bus:  mass = CORE_DRY_MASS, position = origin (0,0,0)
 *   - Per strut: mass = STRUT_MASS (4.5 kg), position = strut midpoint (α-dependent)
 *   - Per daughter: mass = WEAVER/SPINNER, position = strut tip (α-dependent)
 *
 *   - Radiators (2026-10-24, owner: "count them"): every owned petal at its live angle, its mass centre at the same
 *       place the inertia puts it (`radiatorCentroid`). A caller with no radiator info books none.
 *
 * @param {object} armManager — ArmManager instance with .arms[], ._dockPositions[]
 * @param {object} [playerSatellite] — radiatorBookings(), tipCargo, _captureNetSystem (all guarded: mocks may lack them)
 * @param {{ radiators?: boolean, excludeArm?: object }} [opts] — `radiators: false` leaves the petals out (the stow suggestion's
 *   direction); `excludeArm`: leaves that ONE daughter (and her cargo) out, her strut stays (the launch kick: she is leaving)
 * @returns {{ position: {x:number,y:number,z:number}, totalMass: number,
 *             breakdown: { core: number, struts: number[], arms: number[], motherNets: number, radiators: number } }}
 */
export function computeCoM(armManager, playerSatellite, opts) {
  const coreMass = V5.CORE_DRY_MASS; // 161.0 kg at origin
  let totalMass = coreMass;
  let cx = 0, cy = 0, cz = 0; // weighted sum: Σ(m·r)

  // Core at origin → contributes (0,0,0) × coreMass — no change to cx/cy/cz

  const strutMasses = [];
  const armMasses = [];

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) {
      strutMasses.push(0);
      armMasses.push(0);
      continue;
    }

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);

    // Strut structural mass at midpoint
    const strutMass = V5.STRUT_MASS; // 4.5 kg
    const mid = strutMidpointMeters(dp, alpha);
    cx += strutMass * mid.x;
    cy += strutMass * mid.y;
    cz += strutMass * mid.z;
    totalMass += strutMass;
    strutMasses.push(strutMass);

    // Daughter mass: structure at the tip, held cargo at its pinned slot
    // (S13(b), register item 58 — the honest lever, ONE computation with the pin).
    // `opts.excludeArm` (launch-kick): this daughter is leaving: her strut stays, she and what she carries do not.
    let dMass = 0;
    if (!opts || opts.excludeArm !== arm) {
      _forEachArmMassPoint(arm, dp, alpha, playerSatellite, (m, p) => {
        cx += m * p.x;
        cy += m * p.y;
        cz += m * p.z;
        totalMass += m;
        dMass += m;
      });
    }

    armMasses.push(dMass);
  }

  // Bags latched on the radiator tips (TipCargo): real mass at the bag centre,
  // ship frame in metres — the same frame as the arm points above.
  const tipBags = playerSatellite && playerSatellite.tipCargo
    && typeof playerSatellite.tipCargo.massBookings === 'function'
    ? playerSatellite.tipCargo.massBookings() : null;
  if (tipBags) {
    for (let b = 0; b < tipBags.length; b++) {
      const m = tipBags[b].massKg;
      const p = tipBags[b].posShip;
      cx += m * p.x;
      cy += m * p.y;
      cz += m * p.z;
      totalMass += m;
    }
  }

  // The mother's nets in the launcher (on the axis: x = y = 0).
  const nets = motherNetBooking(playerSatellite);
  if (nets.massKg > 0) {
    cz += nets.massKg * nets.z;
    totalMass += nets.massKg;
  }

  // The radiators: structure aboard, every owned petal at its live angle (a held petal at its own).
  let radMass = 0;
  if (!opts || opts.radiators !== false) {
    const petals = _radiatorPetals(playerSatellite);
    if (petals) {
      const rc = radiatorCentroid(petals);
      cx += rc.mx; cy += rc.my; cz += rc.mz;
      totalMass += rc.massKg;
      radMass = rc.massKg;
    }
  }

  const invTotal = totalMass > 0 ? 1 / totalMass : 0;
  return {
    position: {
      x: cx * invTotal,
      y: cy * invTotal,
      z: cz * invTotal,
    },
    totalMass,
    breakdown: {
      core: coreMass,
      struts: strutMasses,
      arms: armMasses,
      motherNets: nets.massKg,
      radiators: radMass,
    },
  };
}

// ── Radiator petals: ONE geometry for the mass centre and the inertia ───────────────────────────────────────────────
// A petal's mass is spread uniformly over its plate span (PLATE_START_M..PLATE_END_M along the strut line), the line
// leaving the hinge pin (HINGE_R_M out at the petal's azimuth, HINGE_Z_M) in the direction u = (sinθ·r̂, cosθ·ẑ). The
// plate's width is symmetric about that line (centre panel on it, a wing each side), so the petal's mass centre is on
// the line at the mean span: h + s̄·u. `radiatorCentroid` (the CoM) and `radiatorInertia` (the inertia) both read the
// line through `_petalLine`, so the two can never put the same petal in two places (2026-10-24, fu-com).
const _pl = { hx: 0, hy: 0, hz: 0, ux: 0, uy: 0, uz: 0, ca: 1, sa: 0 };
const _radSum = { massKg: 0, mx: 0, my: 0, mz: 0 };

/** The strut line of the petal at azimuth `azDeg` swung to `thetaRad`: hinge pin h and direction u (module scratch `_pl`). */
function _petalLine(azDeg, thetaRad) {
  const FL = Constants.THERMAL.FLOWER;
  const az = degToRad(azDeg);
  const ca = Math.cos(az), sa = Math.sin(az);
  const st = Math.sin(thetaRad), ct = Math.cos(thetaRad);
  _pl.hx = FL.HINGE_R_M * ca; _pl.hy = FL.HINGE_R_M * sa; _pl.hz = FL.HINGE_Z_M;
  _pl.ux = st * ca; _pl.uy = st * sa; _pl.uz = ct;
  _pl.ca = ca; _pl.sa = sa;
  return _pl;
}

/**
 * Mass and first moment of the radiator petals about the barrel origin, ship frame: Σ m and Σ m·(mass centre), the
 * petal's centre being h + s̄·u (see `_petalLine`). Allocation-free: the result is written into `out` (default: a module
 * scratch, valid until the next call, so read it at once).
 * @param {Array<{massKg:number, azDeg:number, thetaRad:number}>} petals
 * @param {{massKg:number, mx:number, my:number, mz:number}} [out]
 * @param {number} [allAtThetaRad] when finite, every petal is taken at THIS angle instead of its own (the balanced
 *   reference of the CoM drift: all petals at the shared radiator angle)
 * @returns {{ massKg:number, mx:number, my:number, mz:number }} kg and kg·m
 */
export function radiatorCentroid(petals, out = _radSum, allAtThetaRad) {
  const FL = Constants.THERMAL.FLOWER;
  const sMean = (FL.PLATE_START_M + FL.PLATE_END_M) / 2;
  const same = Number.isFinite(allAtThetaRad);
  let m = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < petals.length; i++) {
    const b = petals[i];
    const pm = b.massKg;
    if (!(pm > 0)) continue;
    const l = _petalLine(b.azDeg, same ? allAtThetaRad : b.thetaRad);
    m += pm;
    mx += pm * (l.hx + sMean * l.ux);
    my += pm * (l.hy + sMean * l.uy);
    mz += pm * (l.hz + sMean * l.uz);
  }
  out.massKg = m; out.mx = mx; out.my = my; out.mz = mz;
  return out;
}

/** The player's radiator petals as bookings, or null for a caller with no radiator info (a mock, a tool). */
function _radiatorPetals(playerSatellite) {
  return playerSatellite && typeof playerSatellite.radiatorBookings === 'function'
    ? playerSatellite.radiatorBookings() : null;
}

/**
 * Inertia of the radiator petals about the barrel origin, ship frame (kg·m²; diagonal terms, like every other part).
 * Each petal's mass is spread uniformly over its plate span (PLATE_START_M..PLATE_END_M along the strut, the
 * method of the reaction-wheels appendix), the strut line leaving the hinge pin (HINGE_R_M out at the petal's azimuth,
 * HINGE_Z_M) in the direction (sinθ·r̂, cosθ·ẑ). Second moments of the line about the origin are exact:
 * <p pᵀ> = h hᵀ + s̄ (h uᵀ + u hᵀ) + <s²> u uᵀ with s uniform on [s0, s1].
 * The plate's own width adds m·σ²·(I − t tᵀ) with t the tangential direction and σ² the tangential variance of the
 * plate's mass: centre panel 50 %, each wing 25 % hinged on the centre panel's edge, the wing centroid at
 * 0.15 + 0.075·cos(fold) from the boom line (fold −π folded, 0 flat), so σ² goes 0.0075 (folded) to 0.030 m² (flat).
 * The wings' small offset out of the plate plane is not modelled.
 * @param {Array<{massKg:number, azDeg:number, thetaRad:number, foldRad:number}>} petals
 * @returns {{ ixx:number, iyy:number, izz:number }}
 */
export function radiatorInertia(petals) {
  const FL = Constants.THERMAL.FLOWER;
  const s0 = FL.PLATE_START_M, s1 = FL.PLATE_END_M;
  const sMean = (s0 + s1) / 2;
  const s2Mean = sMean * sMean + ((s1 - s0) * (s1 - s0)) / 12;
  const hw = FL.PLATE_CENTRE_HALF_WIDTH_M;                 // 0.15: centre panel half-width = wing width
  let ixx = 0, iyy = 0, izz = 0;
  for (let i = 0; i < petals.length; i++) {
    const { massKg: m, azDeg, thetaRad, foldRad } = petals[i];
    if (!(m > 0)) continue;
    const l = _petalLine(azDeg, thetaRad);
    const ca = l.ca, sa = l.sa;
    const sxx = l.hx * l.hx + 2 * sMean * l.hx * l.ux + s2Mean * l.ux * l.ux;
    const syy = l.hy * l.hy + 2 * sMean * l.hy * l.uy + s2Mean * l.uy * l.uy;
    const szz = l.hz * l.hz + 2 * sMean * l.hz * l.uz + s2Mean * l.uz * l.uz;
    ixx += m * (syy + szz);
    iyy += m * (sxx + szz);
    izz += m * (sxx + syy);
    // plate width: centre panel (50 %) + two wings (25 % each) at tangential offset c from the boom line
    const cf = Number.isFinite(foldRad) ? Math.cos(foldRad) : 1;
    const c = hw + (hw / 2) * cf;
    const sig2 = 0.5 * (4 * hw * hw / 12) + 0.5 * (c * c + (hw * hw / 12) * cf * cf);
    // spread along t = (−sin az, cos az, 0): I += m σ² (I₃ − t tᵀ) → ixx (1 − tx²), iyy (1 − ty²), izz 1
    ixx += m * sig2 * (1 - sa * sa);
    iyy += m * sig2 * (1 - ca * ca);
    izz += m * sig2;
  }
  return { ixx, iyy, izz };
}

/**
 * Compute the rigid-body moment of inertia about the ship's true centre of mass, in body axes (kg·m²): ixx pitch
 * (about +X), iyy yaw (about +Y), izz roll (about +Z, the barrel long axis). This is the attitude-dynamics SSOT — it
 * mirrors computeCoM's mass tree (same strut midpoint / daughter tip helpers, same detached/expended exclusions, same
 * radiator centroid) so inertia and CoM never diverge.
 * S13(a): the arm terms now arrive in the SAME ship frame as the bus-shell
 * term (roll mR² on izz) — pre-S13(a) they came out Y-barrel, which booked
 * the cargo's z-lever into roll and over-fired the izz clamp (register 57).
 *
 * Model (summed about the barrel origin first, then moved to the centre of mass: see "About the CoM"):
 *   - Core bus: thin cylindrical shell, mass = CORE_DRY_MASS, at the origin.
 *       transverse (x,y) = m·(R²/2 + L²/12);  roll (z) = m·R².
 *       (R = COLLAR_RADIUS, L = CORE_LENGTH. CORE_DRY_MASS 176 kg: stowed transverse ≈ 72.75 kg·m², roll ≈ 28.16.)
 *   - Radiators (2026-10-23, owner: "count them"): every owned petal is structure (unclamped), its mass spread
 *       uniformly over the plate span at the petal's live angle — see radiatorInertia.
 *   - Struts: point mass STRUT_MASS at the α-dependent midpoint (parallel axis).
 *   - Daughters: point mass WEAVER/SPINNER at the α-dependent tip (parallel axis).
 *   - Berthed catch mass (D6): included as a fore point mass but the ADDED
 *     transverse/roll contribution is clamped so the total never exceeds
 *     INERTIA_MAX_FACTOR × the stowed bus inertia. 23 t unclamped would freeze
 *     rotation; the clamp mirrors the translation MASS_EFFECT_MAX soft-lock.
 *
 * About the CoM (2026-10-24, owner: "physically real wins"): a free body turns about its centre of mass, and with the
 * radiators counted that centre sits up to 0.5 m from the barrel origin (146°: 0.44 m aft), which the origin-frame
 * sum overstated by 13 % (pitch/yaw). Per axis k, I_k = I_origin,k − M_k·d⊥,k², with M_k and d_k the total mass and mass
 * centre of exactly what the origin sum counted on that axis: structure at full mass, cargo (in hand, rack, tip bags) and
 * berthed mass scaled by s_k = (cargo inertia the clamp let through) ÷ (cargo inertia before the clamp) on that axis
 * (1 when the clamp does not bite or the cargo adds nothing on that axis). A capped catch is thus a lighter catch in the
 * same place, so each axis is the inertia of a real mass layout about its own centre: > 0, never above the origin
 * value. The berthed mass sits on the axis at z = +L/2 (the clamp's own model, below). computeCoM has no berthed mass,
 * so while a catch is berthed the inertia's centre differs from computeCoM's by that mass (accepted). Diagonal terms only
 * (no products of inertia), as before. Both this sum and computeCoM leave out 25.6 kg the ship's mass budget carries
 * (ArmManager.getMassBudget): the engine tank's dry mass 9.5 kg (:4561), the cold gas 3.6 kg (:4577) and the engine gas
 * 12.5 kg (:4575): none of them has a place in the mass tree. The tree's 268.7 kg of the ship's 294.28 is what the
 * centre of mass is taken on.
 *
 * @param {object} armManager — ArmManager (may be null/empty → bus-only inertia)
 * @param {object} [playerSatellite] — for getBerthedMassKg() via _captureNetSystem, radiatorBookings(), tipCargo
 * @param {{ about?: 'origin'|'com' }} [opts] — `about: 'origin'` returns the sum about the barrel origin (what this
 *   function returned before 2026-10-24: tests show the shift with it; the game always takes the CoM frame)
 * @returns {{ ixx:number, iyy:number, izz:number }} kg·m² about the centre of mass (or the origin, see opts)
 */
export function computeInertia(armManager, playerSatellite, opts) {
  const R = V5.COLLAR_RADIUS;   // 0.40 m
  const L = V5.CORE_LENGTH;     // 2.0 m
  const coreMass = V5.CORE_DRY_MASS; // 176.0 kg

  // Bare-bus thin-shell inertia (also the stowed reference for the D6 clamp).
  const busTransverse = coreMass * (R * R / 2 + L * L / 12); // ≈ 72.75
  const busRoll = coreMass * R * R;                          // ≈ 28.16

  let ixx = busTransverse;
  let iyy = busTransverse;
  let izz = busRoll;

  // First moments of what the sums count, for the move to the CoM: structure (full mass) and cargo (mass, Σ m·r) apart,
  // because the clamp lets only a share of the cargo through. The bus sits at the origin: mass, no moment.
  let sM = coreMass, sMx = 0, sMy = 0, sMz = 0;
  let cM = 0, cMx = 0, cMy = 0, cMz = 0;

  // Point-mass contribution via parallel axis: for mass m at (x,y,z),
  //   Ixx += m(y²+z²), Iyy += m(x²+z²), Izz += m(x²+y²).
  const addPoint = (m, p) => {
    if (m <= 0) return;
    ixx += m * (p.y * p.y + p.z * p.z);
    iyy += m * (p.x * p.x + p.z * p.z);
    izz += m * (p.x * p.x + p.y * p.y);
    sM += m; sMx += m * p.x; sMy += m * p.y; sMz += m * p.z;
  };

  const arms = (armManager && armManager.arms) || [];
  const docks = (armManager && armManager._dockPositions) || [];

  // Cargo-continuity S2 (bug B2): held-catch cargo contributes inertia, but —
  // like the D6 berthed mass below — a multi-tonne catch at a strut tip would
  // otherwise freeze rotation. Accumulate the daughter CARGO contribution
  // separately and clamp it with the berthed mass under INERTIA_MAX_FACTOR, so
  // the clamp reins in cargo/berth but never the structural config.
  let cargoIxx = 0, cargoIyy = 0, cargoIzz = 0;
  const addCargo = (m, p) => {
    cargoIxx += m * (p.y * p.y + p.z * p.z);
    cargoIyy += m * (p.x * p.x + p.z * p.z);
    cargoIzz += m * (p.x * p.x + p.y * p.y);
    cM += m; cMx += m * p.x; cMy += m * p.y; cMz += m * p.z;
  };

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);

    // Strut structural mass at midpoint (matches computeCoM).
    addPoint(V5.STRUT_MASS, strutMidpointMeters(dp, alpha));

    // Daughter mass at tip (0 when detached/expended — same exclusion).
    // Split into structural (unclamped) and held-cargo (clamped below).
    if (!arm.isDetached && arm.state !== Constants.ARM_STATES.EXPENDED) {
      const armMass = arm.config.type === 'weaver'
        ? Constants.V5_WEAVER_MASS
        : Constants.V5_SPINNER_MASS;
      const tip = strutTipMeters(dp, alpha);
      addPoint(armMass, tip);
      // S6: cargo = the in-hand catch plus every piece on the parked rack
      // (guarded — mocks may lack heldCatches). Same clamp discipline as S2.
      // S13(b): each piece books at its PINNED slot (register item 58), not at
      // the tip — ONE computation with the rack pin (heldCargoBookingMeters).
      const handMass = (arm.capturedDebris && arm.capturedDebris.mass) || 0;
      if (handMass > 0) {
        const p = heldInHandBookingMeters(arm, dp, alpha, playerSatellite,
          arm.capturedDebris.sizeMeter, _slotPoint);
        addCargo(handMass, p);
      }
      if (Array.isArray(arm.heldCatches)) {
        for (let si = 0; si < arm.heldCatches.length; si++) {
          const held = arm.heldCatches[si];
          const m = (held && held.mass) || 0;
          if (m <= 0) continue;
          const p = heldCargoBookingMeters(arm, dp, alpha, playerSatellite, si,
            held.sizeMeter, _slotPoint, undefined, held);
          addCargo(m, p);
        }
      }
    }

  }

  // The mother's nets in the launcher: structure aboard (unclamped), on the axis — the same booking computeCoM makes.
  const netsAboard = motherNetBooking(playerSatellite);
  addPoint(netsAboard.massKg, { x: 0, y: 0, z: netsAboard.z });

  // The reaction-wheel kit: structure aboard (unclamped), one point on the axis (the on-axis term only: izz does not move).
  // A caller with no kit info (a mock, a tool) books none. computeCoM leaves it out (its z shift, about -1.2 cm, is the
  // inertia's own centre-of-mass step here).
  const kit = playerSatellite && typeof playerSatellite.wheelKitBooking === 'function' ? playerSatellite.wheelKitBooking() : null;
  if (kit && kit.massKg > 0) addPoint(kit.massKg, { x: 0, y: 0, z: kit.z });

  // The radiators: structure aboard (unclamped), at each petal's live angle. A caller with no radiator info
  // (a mock, a tool) books none.
  let radIxx = 0, radIyy = 0, radIzz = 0;   // the radiators' share, also part of the clamp's reference below
  const petals = _radiatorPetals(playerSatellite);
  if (petals) {
    const rad = radiatorInertia(petals);
    ixx += rad.ixx;
    iyy += rad.iyy;
    izz += rad.izz;
    radIxx = rad.ixx; radIyy = rad.iyy; radIzz = rad.izz;
    const rc = radiatorCentroid(petals);     // the same petals, at the same places, for the CoM
    sM += rc.massKg; sMx += rc.mx; sMy += rc.my; sMz += rc.mz;
  }

  // Bags latched on the radiator tips: cargo, so they join the clamped sum.
  const tipBags = playerSatellite && playerSatellite.tipCargo
    && typeof playerSatellite.tipCargo.massBookings === 'function'
    ? playerSatellite.tipCargo.massBookings() : null;
  if (tipBags) {
    for (let b = 0; b < tipBags.length; b++) {
      const m = tipBags[b].massKg;
      const p = tipBags[b].posShip;
      if (!(m > 0)) continue;
      addCargo(m, p);
    }
  }

  // D6 + S2: berthed catch mass AND held daughter cargo, included but clamped.
  // Berthed mass is modelled as a fore point mass one barrel half-length ahead;
  // daughter cargo was accumulated at its strut tip above. Bound the ADDED
  // inertia so the total per axis never exceeds INERTIA_MAX_FACTOR × the stowed
  // bus inertia. The max() guard ensures a legitimately heavy *deployed*
  // configuration is never pulled BELOW its real inertia by the clamp (the clamp
  // only reins in berthed/cargo mass).
  const cns = playerSatellite && playerSatellite._captureNetSystem;
  const berthed = (cns && typeof cns.getBerthedMassKg === 'function')
    ? cns.getBerthedMassKg() : 0;
  if (berthed > 0) { cM += berthed; cMz += berthed * (L / 2); }   // on the axis, at z = +L/2 (the lever below)
  let shareX = 1, shareY = 1, shareZ = 1;   // s_k: how much of the cargo each axis's clamp let through
  if (berthed > 0 || cargoIxx > 0 || cargoIyy > 0 || cargoIzz > 0) {
    const factor = Constants.ATTITUDE?.INERTIA_MAX_FACTOR ?? 3.0;
    const leverT2 = (L / 2) * (L / 2); // transverse lever² (fore capture point)
    const leverR2 = (R / 2) * (R / 2); // small roll radius²
    // The cap is INERTIA_MAX_FACTOR × the bus, plus the radiators once at their live angles (2026-10-23): the radiators
    // are structure, not cargo, so they are neither multiplied nor allowed to eat the cargo's room. With the bus alone as
    // the reference, open radiators (300+ kg·m²) would sit above 3 × the bus and swallow every kilogram of cargo; scaling
    // them by the factor too would give a catch more room the further the radiators are open. This way the room left for
    // cargo does not depend on the radiator angle. No radiators: factor × bus, as before.
    const capX = factor * busTransverse + radIxx;
    const capY = factor * busTransverse + radIyy;
    const capZ = factor * busRoll + radIzz;
    const addT = berthed * leverT2;   // berthed transverse addition
    const addR = berthed * leverR2;   // berthed roll addition
    const wantX = addT + cargoIxx, wantY = addT + cargoIyy, wantZ = addR + cargoIzz;   // cargo inertia before the clamp
    const x0 = ixx, y0 = iyy, z0 = izz;                                                // structure alone
    ixx = Math.min(ixx + wantX, Math.max(ixx, capX));
    iyy = Math.min(iyy + wantY, Math.max(iyy, capY));
    izz = Math.min(izz + wantZ, Math.max(izz, capZ));
    if (wantX > 0) shareX = clamp01((ixx - x0) / wantX);
    if (wantY > 0) shareY = clamp01((iyy - y0) / wantY);
    if (wantZ > 0) shareZ = clamp01((izz - z0) / wantZ);
  }

  if (opts && opts.about === 'origin') return { ixx, iyy, izz };

  // Move each axis to the centre of mass of what that axis counted: I_cm = I_origin − M·d⊥² = I_origin − |S⊥|²/M,
  // S the first moment about the origin, S⊥ its part across the axis.
  const mx = sM + shareX * cM, my = sM + shareY * cM, mz = sM + shareZ * cM;
  const Sx1 = sMx + shareY * cMx, Sx2 = sMx + shareZ * cMx;   // x-moment as seen by the y axis, by the z axis
  const Sy1 = sMy + shareX * cMy, Sy2 = sMy + shareZ * cMy;   // y-moment as seen by the x axis, by the z axis
  const Sz1 = sMz + shareX * cMz, Sz2 = sMz + shareY * cMz;   // z-moment as seen by the x axis, by the y axis
  return {
    ixx: mx > 0 ? ixx - (Sy1 * Sy1 + Sz1 * Sz1) / mx : ixx,
    iyy: my > 0 ? iyy - (Sx1 * Sx1 + Sz2 * Sz2) / my : iyy,
    izz: mz > 0 ? izz - (Sx2 * Sx2 + Sy2 * Sy2) / mz : izz,
  };
}

/**
 * The balanced reference the drift is measured from: the CoM with all arms at the mean alpha (bus, struts, daughters
 * with their held cargo, the nets in the launcher) and, 2026-10-24, every owned radiator petal at the ONE shared
 * radiator angle `playerSatellite._flowerThetaRad` (NOT `foldRad`, the wing fold). The actual CoM counts each petal at
 * its own live angle, so a symmetric fold or opening moves actual and reference together (no drift), while a petal
 * held at a different angle (a leash hand-off, a daughter's carry) reads its real offset. A caller with no shared angle
 * (a mock) books its petals at their own angles: no radiator drift. Written into `out` (no allocation).
 * @returns {{x:number,y:number,z:number}} out
 */
function _balancedReference(armManager, playerSatellite, out) {
  // Compute mean alpha across all active arms
  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  let sumAlpha = 0, count = 0;
  for (let i = 0; i < arms.length; i++) {
    if (!docks[i]) continue;
    const a = arms[i].getAimAlpha ? arms[i].getAimAlpha() : (arms[i]._aimAlpha || 0);
    sumAlpha += a;
    count++;
  }
  const meanAlpha = count > 0 ? sumAlpha / count : 0;

  // Compute balanced reference CoM with all arms at meanAlpha
  let bcx = 0, bcy = 0, bcz = 0;
  let bTotal = V5.CORE_DRY_MASS; // core at origin contributes (0,0,0)

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    const strutMass = V5.STRUT_MASS;
    const mid = strutMidpointMeters(dp, meanAlpha);
    bcx += strutMass * mid.x;
    bcy += strutMass * mid.y;
    bcz += strutMass * mid.z;
    bTotal += strutMass;

    _forEachArmMassPoint(arm, dp, meanAlpha, playerSatellite, (m, p) => {
      bcx += m * p.x;
      bcy += m * p.y;
      bcz += m * p.z;
      bTotal += m;
    });
  }

  // The nets are in the actual CoM, so they are in the balanced reference too (permanent, on-axis).
  const netsB = motherNetBooking(playerSatellite);
  if (netsB.massKg > 0) { bcz += netsB.massKg * netsB.z; bTotal += netsB.massKg; }

  // The radiators are in the actual CoM, so they are in the reference too, all at the shared angle.
  const petals = _radiatorPetals(playerSatellite);
  if (petals) {
    const rc = radiatorCentroid(petals, _radSum, playerSatellite._flowerThetaRad);
    bcx += rc.mx; bcy += rc.my; bcz += rc.mz;
    bTotal += rc.massKg;
  }

  const invB = bTotal > 0 ? 1 / bTotal : 0;
  out.x = bcx * invB; out.y = bcy * invB; out.z = bcz * invB;
  return out;
}
const _balRef = { x: 0, y: 0, z: 0 };

/**
 * Compute scalar CoM drift — the *asymmetric* displacement of CoM from the
 * "balanced" reference position (all arms at mean alpha, all radiator petals at the shared angle). This isolates
 * the player-correctable asymmetry from the permanent collar-height offset.
 *
 * When all arms are at the same alpha, drift = 0 (within floating-point tolerance).
 * When one arm is stowed while others are deployed, drift > 0.
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {number} drift distance in meters
 */
export function computeCoMDrift(armManager, playerSatellite) {
  const actual = computeCoM(armManager, playerSatellite);
  const ref = _balancedReference(armManager, playerSatellite, _balRef);

  // Drift = |actualCoM − balancedCoM|
  const dx = actual.position.x - ref.x;
  const dy = actual.position.y - ref.y;
  const dz = actual.position.z - ref.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compute the CoM drift as a 3D vector (actual − balanced reference).
 * This vector represents the player-correctable asymmetry offset.
 * Used by torque-coupling code in _applyThrust (PlayerSatellite).
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {{x:number, y:number, z:number}} drift vector in meters
 */
export function computeCoMDriftVector(armManager, playerSatellite) {
  const actual = computeCoM(armManager, playerSatellite);
  const ref = _balancedReference(armManager, playerSatellite, _balRef);
  return {
    x: actual.position.x - ref.x,
    y: actual.position.y - ref.y,
    z: actual.position.z - ref.z,
  };
}

/**
 * Compute perpendicular offset of CoM from a thrust line.
 * This offset × thrust force = unwanted torque (τ = r × F).
 *
 * The thrust line passes through the origin along `thrustVector`.
 * The perpendicular distance from CoM to this line is:
 *   d = |comPos × thrustDir| / |thrustDir|
 *
 * @param {{x:number,y:number,z:number}} comPos — CoM position in meters
 * @param {{x:number,y:number,z:number}} thrustVector — thrust direction vector (not necessarily unit)
 * @returns {number} perpendicular offset in meters
 */
export function computeCoMOffsetFromThrustVector(comPos, thrustVector) {
  // Cross product: comPos × thrustVector
  const cx = comPos.y * thrustVector.z - comPos.z * thrustVector.y;
  const cy = comPos.z * thrustVector.x - comPos.x * thrustVector.z;
  const cz = comPos.x * thrustVector.y - comPos.y * thrustVector.x;
  const crossMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const dirMag = Math.sqrt(
    thrustVector.x * thrustVector.x +
    thrustVector.y * thrustVector.y +
    thrustVector.z * thrustVector.z
  );
  return dirMag > 0 ? crossMag / dirMag : 0;
}

/**
 * Identify which arm contributes most to CoM drift (best candidate to stow).
 * "Most displaced" = arm whose mass-weighted position has the largest projection
 * onto the current CoM direction (stowing it reduces drift the most).
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {number|null} arm index of suggested stow, or null if no arms deployed
 */
export function suggestStowArm(armManager, playerSatellite) {
  // The direction is read WITHOUT the radiators (2026-10-24): they are counted in the CoM now, but they are no arm. At 146°
  // they sit the CoM 0.4 m aft, which would swamp the asymmetry this suggestion is about and pick an arm by the radiators.
  const com = computeCoM(armManager, playerSatellite, { radiators: false });
  const p = com.position;
  const driftSq = p.x * p.x + p.y * p.y + p.z * p.z;
  if (driftSq < 1e-12) return null; // CoM at origin, nothing to suggest

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];

  let bestIdx = null;
  let bestDot = -Infinity;

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    // Only suggest stow for arms that are not detached/expended
    if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    const tip = strutTipMeters(dp, alpha);

    // Total mass contribution of this arm (strut + daughter)
    const dMass = getDaughterMass(arm);
    const totalArmMass = V5.STRUT_MASS + dMass;

    // Weighted contribution direction · CoM direction (projection)
    const dot = (tip.x * p.x + tip.y * p.y + tip.z * p.z) * totalArmMass;
    if (dot > bestDot) {
      bestDot = dot;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Cargo-continuity S7 — pick the daughter that should receive a parked mother
 * catch, or `null` when no daughter may take it.
 *
 * This is the INVERSE question to `suggestStowArm`, which answers "which arm
 * contributes most to CoM drift" (its score is the mass-weighted tip projection
 * ONTO the CoM offset). A carrier
 * must instead be HOME with a free cargo cell, and loading it should make trim
 * BETTER — so this scores the anti-projection: the measured drop in CoM drift
 * from adding the cargo at that rack slot (S13(b): the pinned point, not the
 * bare strut tip — register item 58).
 *
 *   score = W_CG · (driftBefore − driftAfter) + W_DEPLOY · (1 − deployability)
 *
 * where deployability is the propellant fraction — there is no per-arm panel
 * health in the tree (only the mother has `solarPanelHealth`). The second term is
 * the owner's "a daughter that cannot usefully deploy is the right mule".
 *
 * This function is also the single gatekeeper for "may this piece go to a
 * daughter at all", so there is exactly one place that decides:
 *   • the MASS GATE — above `CARGO_TRANSFER.MAX_KG` the body stays on the tether
 *     at the nose (at 44–114× the mother's mass the system CoM sits inside the
 *     cargo, so moving it off the thrust axis is the physically wrong move);
 *   • the ONE-CATCH rule (owner 2026-10-22 13:01Z: "daughter can only hold one debris") — only a daughter
 *     holding NOTHING takes a mother catch (`heldCatches` empty); one that holds a catch, her own or a racked
 *     one, is never a carrier;
 *   • the HOME rule — DOCKED only, never detached/expended (a daughter away from her strut has nothing to
 *     pin the cargo to; HOLDING_CATCH means she already holds a catch);
 *   • the BOOKED rule (fix round 1) — a daughter a catch is already flying to is not empty any more: she is
 *     no carrier and no longer counts as capture-capable, so two catches are never sent to the same daughter
 *     (the second would snap back on arrival) and two flights can never use up the last free daughter;
 *   • the LAST-DAUGHTER guard — never consume the last capture-capable daughter,
 *     so an automatic hand-off can never strand the fleet with zero usable arms.
 *
 * @param {object} armManager — ArmManager (or mock) with .arms[], ._dockPositions[]
 * @param {object} [playerSatellite] — passed through to computeCoM
 * @param {number} cargoMassKg — mass of the piece being handed over
 * @param {number} [sizeMeter=0] — the piece's size, for the slot standoff
 *   radius (the S7 caller is mass-only; 0 books the bare clearance standoff).
 * @param {Iterable<number>|null} [bookedArms=null] — arm indices that already have a cargo flight on the way
 *   (the capture system reads them off its transferring nets); each counts as holding a catch.
 * @param {number} [reachM=0] — hold-clear D7: the piece's drawn reach (`DebrisField.trueReachM`); above `HOLD_CLEAR.MAX_HOLD_REACH_M` no daughter is
 *   offered it (measured: none of them could hold it clear of the radiator wings), so it waits at the nose. 0 = not asked. NOT the booking size.
 * @returns {number|null} arm index, or null when nothing may carry it
 */
export function suggestCargoArm(armManager, playerSatellite, cargoMassKg, sizeMeter = 0, bookedArms = null, reachM = 0) {
  const mass = Number(cargoMassKg) || 0;
  if (mass <= 0) return null;
  if (reachM > (Constants.HOLD_CLEAR ? Constants.HOLD_CLEAR.MAX_HOLD_REACH_M : Infinity)) return null;   // hold-clear D7

  const CT = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.CARGO_TRANSFER) || {};
  const maxKg = CT.MAX_KG ?? 2000;
  if (mass > maxKg) return null;                       // monster: stays on the axis

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  if (!arms.length) return null;

  const S = Constants.ARM_STATES;
  const reserve = Constants.ARM_RESERVE_FUEL ?? 0;

  // A daughter that could still take a capture: home, charged, fuelled. Loading
  // one of these costs the fleet a working arm, so the last one is never loaded
  // (a HOLDING_CATCH arm is not a candidate at all: she already holds a catch).
  // R2 (fix round 1): a daughter with a cargo flight on the way is booked. She is still DOCKED with an empty rack until the
  // piece lands, so `heldCatches` alone cannot tell; count her as holding a catch (no carrier, not capture-capable).
  const booked = bookedSet(bookedArms);
  const captureCapable = (arm, i) => !!arm && !arm.isDetached
    && arm.state === S.DOCKED
    && !booked.has(i)
    && arm.springCharged !== false
    && (arm.fuel ?? 0) > reserve;
  const capableCount = arms.reduce((n, a, i) => n + (captureCapable(a, i) ? 1 : 0), 0);

  // Without the radiators (2026-10-24), as suggestStowArm: they are no arm, and at 146° their common 0.44 m axial shift
  // would dilute the lateral balance this choice is about.
  const com = computeCoM(armManager, playerSatellite, { radiators: false });
  const p = com.position;
  const totalMass = com.totalMass || 0;
  const driftBefore = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);

  const W_CG = CT.W_CG ?? 1.0;
  const W_DEPLOY = CT.W_DEPLOY ?? 0.5;

  let bestIdx = null;
  let bestScore = -Infinity;
  let bestFuel = Infinity;

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!arm || !dp) continue;

    // Home, holding nothing, and still part of the ship. A HOLDING_CATCH daughter holds her own catch or one
    // already racked on her: one catch per daughter (owner 2026-10-22), so she is never a carrier.
    if (arm.isDetached || arm.state === S.EXPENDED) continue;
    if (arm.state !== S.DOCKED) continue;
    if (Array.isArray(arm.heldCatches) && arm.heldCatches.length > 0) continue;
    if (booked.has(i)) continue;          // a catch is already flying to her

    // Never spend the last capture-capable daughter on cargo.
    if (captureCapable(arm, i) && capableCount <= 1) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    // S13(b) / rack-snug: the hypothetical add books where the piece would actually be
    // PINNED — this arm's next FREE cell, on her (register item 58; ONE computation
    // with the rack pin). A prediction has no mesh yet, so it is the typeless form.
    const book = heldCargoBookingMeters(arm, dp, alpha, playerSatellite,
      nextFreeRackCell(arm.heldCatches), sizeMeter, _slotPoint);

    // CoM after adding `mass` at this slot: (M·p + m·slot) / (M + m).
    const denom = totalMass + mass;
    if (denom <= 0) continue;
    const ax = (totalMass * p.x + mass * book.x) / denom;
    const ay = (totalMass * p.y + mass * book.y) / denom;
    const az = (totalMass * p.z + mass * book.z) / denom;
    const driftAfter = Math.sqrt(ax * ax + ay * ay + az * az);

    const deployability = clamp01((arm.fuel ?? 0) / 100);
    const score = W_CG * (driftBefore - driftAfter) + W_DEPLOY * (1 - deployability);

    // Tie-break: the least deployable daughter is the right mule.
    const fuel = arm.fuel ?? 0;
    if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && fuel < bestFuel)) {
      bestScore = score;
      bestFuel = fuel;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/** R2: a Set of arm indices from whatever the caller passed (null, an array, a Set). */
const _noBooked = new Set();
function bookedSet(bookedArms) {
  if (!bookedArms) return _noBooked;
  return bookedArms instanceof Set ? bookedArms : new Set(bookedArms);
}

/**
 * one-catch: how many daughters are home (DOCKED) holding nothing. Pure read, for the words only: when
 * `suggestCargoArm` finds no carrier for a piece under the mass gate, a count above 0 means the refusal is the
 * last-daughter guard (one free daughter, kept ready for the next capture), 0 means nobody is free (each is out,
 * holds a catch, or has one on the way).
 * @param {object} armManager — ArmManager (or mock) with .arms[]
 * @param {Iterable<number>|null} [bookedArms=null] — arm indices with a cargo flight on the way (not empty any more)
 * @returns {number}
 */
export function countEmptyDockedDaughters(armManager, bookedArms = null) {
  const S = Constants.ARM_STATES;
  const booked = bookedSet(bookedArms);
  const arms = (armManager && armManager.arms) || [];
  let n = 0;
  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    if (!arm || arm.isDetached || arm.state !== S.DOCKED || booked.has(i)) continue;
    if (Array.isArray(arm.heldCatches) && arm.heldCatches.length > 0) continue;
    n++;
  }
  return n;
}


// ═══════════════════════════════════════════════════════════════════════════
// §2  Plume Interference (Gap #8)
// ═══════════════════════════════════════════════════════════════════════════

// ── S9: the held-cargo VOLUME model (register item 32) ──────────────────────
// The box: dims from the item-7 SSOT (DebrisField.setDebrisSize keeps
// lengthM/widthM tracking sizeMeter per type), oriented as the piece sits
// (rack-snug: its longest mesh axis turned by its attitude in the daughter's
// frame — `heldCargoBookingMeters`' axisOut; her +Z for a piece with no stored
// attitude), square widthM × widthM
// cross-section. The check encloses that box EXACTLY by a chain of
// PLUME_CARGO_CHAIN_K balls riding the long axis: each slab's half-extents are
// (L/2K, W/2, W/2), so radius √((L/2K)² + W²/2) covers its slab and the union
// of the K balls contains the whole box. Box ⊆ chain, therefore a chain CLEAR
// is decisive for the box and a chain HIT may overstate — the conservative
// direction the work order mandates ("never shrink below the honest hull").
// Degenerate dims (missing / non-finite / not elongated) fall back to the
// legacy single sphere of radius sizeMeter/2 at the booking.
// Measured basis: tmp/i32s9-box-probe.log — the item-32 sweep re-run under
// this exact model BEFORE any production edit. The sphere's old "clear at
// α ≥ 71°" band is dead under the box (a fat 12.4 m hull bites to α ≈ 106°);
// the re-pose destination floors that answer it live in
// Constants.PLUME_CARGO_ALPHA_LADDER (measured from the same probe).
const PLUME_CARGO_CHAIN_K = 4;
const _plumeChainBall = [];            // module scratch — K reused plain objects
for (let _i = 0; _i < PLUME_CARGO_CHAIN_K; _i++) _plumeChainBall.push({ x: 0, y: 0, z: 0, r: 0 });
const _plumeBookingTmp = { x: 0, y: 0, z: 0 };
const _plumeAxisTmp = { x: 0, y: 0, z: 0 };

/**
 * Build the ball-chain enclosure of ONE held piece's SSOT box at its live
 * booking. REUSES heldCargoBookingMeters — booking point AND hold axis come
 * from the ONE call (never a duplicate resolution; S13(b)'s rule).
 *
 * @param {object} arm — ArmUnit instance or mock (reads arm._firedNet only)
 * @param {object} dp — dock position (stored convention)
 * @param {number} alpha — strut sweep angle (rad)
 * @param {object|null} playerSatellite — source of the attitude quaternion
 * @param {number} slotIndex — rack slot (0-based)
 * @param {object|null} debris — the held piece (sizeMeter + lengthM/widthM)
 * @param {Array<{x:number,y:number,z:number,r:number}>} out — preallocated
 *   scratch with >= PLUME_CARGO_CHAIN_K entries (module temps on hot paths)
 * @param {boolean} [inHand=false] — true for `arm.capturedDebris` (a catch in hand): booked by
 *   `heldInHandBookingMeters` (base behaviour), `slotIndex` unused
 * @returns {number} balls written (1 = sphere fallback, else CHAIN_K)
 */
export function heldCargoPlumeChainInto(arm, dp, alpha, playerSatellite, slotIndex, debris, out, inHand = false) {
  const sizeMeter = (debris && debris.sizeMeter) || 0;
  if (inHand) {
    // a catch held in hand keeps its base booking and hold-axis box (rack-snug changed the rack only)
    heldInHandBookingMeters(arm, dp, alpha, playerSatellite, sizeMeter, _plumeBookingTmp, _plumeAxisTmp);
  } else {
    heldCargoBookingMeters(arm, dp, alpha, playerSatellite, slotIndex, sizeMeter,
      _plumeBookingTmp, _plumeAxisTmp, debris);
  }
  const L = debris ? debris.lengthM : undefined;
  const W = debris ? debris.widthM : undefined;
  const hasAxis = (_plumeAxisTmp.x !== 0) || (_plumeAxisTmp.y !== 0) || (_plumeAxisTmp.z !== 0);
  const boxUsable = Number.isFinite(L) && Number.isFinite(W) && L > W && L > 0 && W > 0;
  if (!boxUsable || !hasAxis) {
    out[0].x = _plumeBookingTmp.x;
    out[0].y = _plumeBookingTmp.y;
    out[0].z = _plumeBookingTmp.z;
    out[0].r = sizeMeter / 2;
    return 1;
  }
  const step = L / PLUME_CARGO_CHAIN_K;
  const r = Math.sqrt((step / 2) * (step / 2) + (W * W) / 2);
  for (let j = 0; j < PLUME_CARGO_CHAIN_K; j++) {
    const off = (j - (PLUME_CARGO_CHAIN_K - 1) / 2) * step;
    const b = out[j];
    b.x = _plumeBookingTmp.x + _plumeAxisTmp.x * off;
    b.y = _plumeBookingTmp.y + _plumeAxisTmp.y * off;
    b.z = _plumeBookingTmp.z + _plumeAxisTmp.z * off;
    b.r = r;
  }
  return PLUME_CARGO_CHAIN_K;
}

/**
 * Exact ball-vs-infinite-plume-cone test — the i32/S12 instrument's validated
 * branches (apex-engulf HIT; entirely-upstream CLEAR; else the angular limb
 * φ − (halfAngle + asin(r/dist)) decides). A CLEAR is decisive for the ball,
 * hence for anything the ball contains.
 * @private
 */
function _ballInPlumeCone(bx, by, bz, r, n, dx, dy, dz, halfAngle) {
  const vx = bx - n.x, vy = by - n.y, vz = bz - n.z;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (dist <= r) return true;
  const axial = vx * dx + vy * dy + vz * dz;
  if (axial <= -r) return false;
  let cosPhi = axial / dist;
  if (cosPhi < -1) cosPhi = -1; else if (cosPhi > 1) cosPhi = 1;
  const phi = Math.acos(cosPhi);
  const t = r / dist;
  return phi <= halfAngle + Math.asin(t > 1 ? 1 : t);
}

/**
 * Does ANY piece this arm holds sit — box-chain model, live booking — inside
 * THIS thruster's cone? Mirrors _forEachArmMassPoint's guards exactly: the
 * in-hand scalar books at slot 0, then every rack piece at its own slot, each
 * gated on a truthy mass. An EMPTY arm costs two field reads.
 * @private
 */
function _armHoldsCargoInCone(arm, dp, alpha, playerSatellite, n, dx, dy, dz, halfAngle) {
  const hand = arm.capturedDebris;
  if (hand && hand.mass) {
    const count = heldCargoPlumeChainInto(arm, dp, alpha, playerSatellite, 0, hand, _plumeChainBall, true);
    for (let j = 0; j < count; j++) {
      const b = _plumeChainBall[j];
      if (_ballInPlumeCone(b.x, b.y, b.z, b.r, n, dx, dy, dz, halfAngle)) return true;
    }
  }
  const rack = arm.heldCatches;
  if (Array.isArray(rack)) {
    for (let s = 0; s < rack.length; s++) {
      const held = rack[s];
      if (!held || !held.mass) continue;
      const count = heldCargoPlumeChainInto(arm, dp, alpha, playerSatellite, s, held, _plumeChainBall);
      for (let j = 0; j < count; j++) {
        const b = _plumeChainBall[j];
        if (_ballInPlumeCone(b.x, b.y, b.z, b.r, n, dx, dy, dz, halfAngle)) return true;
      }
    }
  }
  return false;
}

/**
 * S9 driver-facing read (ArmManager's re-pose tick + the tests): does the arm
 * at `armIndex` hold cargo whose box-chain sits in ANY thruster's cone at its
 * live booking? Applies the SAME skip filter as checkPlumeInterference
 * (detached/expended arms and missing dock positions are skipped). READ-ONLY —
 * what thrust refuses is not decided here.
 *
 * @param {object} armManager — with .arms[], ._dockPositions[]
 * @param {number} armIndex
 * @param {number} [alphaRad] — hold-catch (owner 2026-10-22): read the arm's cargo at THIS strut angle instead of
 *   her live one ("would her catch be clear of the plumes if the strut stood at 34°?"). Omitted: the live angle.
 * @returns {{ armIndex: number, thrusterId: string }|null} first conflict
 */
export function heldCargoPlumeConflictAt(armManager, armIndex, alphaRad) {
  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return null;
  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  const arm = arms[armIndex];
  const dp = docks[armIndex];
  if (!arm || !dp) return null;
  if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) return null;
  const holdsAnything = (arm.capturedDebris && arm.capturedDebris.mass)
    || (Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass));
  if (!holdsAnything) return null;

  const alpha = Number.isFinite(alphaRad) ? alphaRad : (arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0));
  const playerSatellite = armManager.playerSatellite || null;
  for (const t of thrusters) {
    const d = t.thrustDir;
    const dMag = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    const dx = d.x / dMag, dy = d.y / dMag, dz = d.z / dMag;
    if (_armHoldsCargoInCone(arm, dp, alpha, playerSatellite, t.nozzlePos, dx, dy, dz,
      Constants.PLUME_HALF_ANGLE)) {
      return { armIndex, thrusterId: t.id };
    }
  }
  return null;
}

// ── net-duck D1: the held catch's DRAWN mesh against the mother net's berth corridor ──────────────────────────────────
// The plume check's box chain (`heldCargoPlumeChainInto`) is NOT used here. Measured 2026-10-23 (tmp/plans/net-duck.md Log, T0a):
// the SSOT box (`lengthM` x `widthM`) is a sphere for a fragment and a 5 x 3.1 box for a defunctSat (both far fatter than the drawn
// body), and 1.4 m wide for a 5 m rocketBody that is drawn 4.2 m across; against the drawn mesh it over-counted 5 m catches by
// 17-85 points at 54 deg, left 34 deg "not clear" for 47 % of 5 m defunctSats, and MISSED 8-34 of 120 rocketBodies. The corridor test
// therefore reads the mesh the player sees: a cached cloud of its surface (spacing CLOUD_STEP_FRAC of the longest side, each point a
// ball of ONE spacing (R6, 2026-10-23: the gap between a surface point and its nearest sample was measured up to 0.82 x the spacing,
// so a ball of half of it could let a hit through), moved to her pose at the asked strut angle. 0.02 (was 0.04 with half-spacing balls)
// keeps the SAME ball (0.1 m on a 5 m body) now that it is a whole spacing: 34 deg and 39 deg stay clear for every size and type, and
// a 5 m rocketBody reads 0 0 10 25 77 87 100 % at 34/39/44/54/64/69/89 deg, vs 0 0 7 20 68 83 100 % for the drawn mesh itself.
const CLOUD_STEP_FRAC = 0.02;
const _cloudCache = new Map();
const _cdQ = new THREE.Quaternion();
const _cdBook = { x: 0, y: 0, z: 0 };

/** Cache key of a piece's drawn mesh (the same one `DebrisWireframe.getGeometry` uses). @private */
function _cloudKey(type, id) {
  return type === 'fragment' ? `fragment_${(id >>> 0) % (Constants.DEBRIS_FRAGMENT_VARIANTS || 7)}` : type;
}

/**
 * The surface of a debris mesh as a point cloud in MESH units (origin = the pin point), spacing `stepU`. Built once per mesh.
 * Triangles are sampled as `forEachSurfacePoint` (js/test/_flowerFold.js) does: from the vertex opposite the longest edge.
 * @returns {{pts: Float32Array, stepU: number}|null} null for a type with no mesh
 * @private
 */
function _heldCloud(type, id) {
  const key = _cloudKey(type, id);
  let c = _cloudCache.get(key);
  if (c !== undefined) return c;
  c = null;
  const geo = DebrisWireframe.getGeometry(type, id);
  const pos = geo && geo.getAttribute('position');
  if (pos && pos.count > 0) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const longest = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    const stepU = CLOUD_STEP_FRAC * (longest > 0 ? longest : 1);
    const idx = geo.index ? geo.index.array : null;
    const nTri = (idx ? idx.length : pos.count) / 3;
    const out = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3();
    for (let t = 0; t < nTri; t++) {
      a.fromBufferAttribute(pos, idx ? idx[3 * t] : 3 * t);
      b.fromBufferAttribute(pos, idx ? idx[3 * t + 1] : 3 * t + 1);
      cc.fromBufferAttribute(pos, idx ? idx[3 * t + 2] : 3 * t + 2);
      let A = a, B = b, C = cc;
      const ab = a.distanceTo(b), bc = b.distanceTo(cc), ca = cc.distanceTo(a);
      if (ab >= bc && ab >= ca) { A = cc; B = a; C = b; } else if (ca >= ab && ca >= bc) { A = b; B = cc; C = a; }
      const ku = Math.max(1, Math.ceil(A.distanceTo(B) / stepU)), kv = Math.max(1, Math.ceil(A.distanceTo(C) / stepU));
      for (let i = 0; i <= ku; i++) {
        const u = i / ku;
        for (let j = 0; j <= kv; j++) {
          const v = j / kv;
          if (u + v > 1 + 1e-12) break;
          out.push(lerp(A.x, B.x, u) + (C.x - A.x) * v, lerp(A.y, B.y, u) + (C.y - A.y) * v, lerp(A.z, B.z, u) + (C.z - A.z) * v);
        }
      }
    }
    c = { pts: Float32Array.from(out), stepU };
  }
  _cloudCache.set(key, c);
  return c;
}

/**
 * Does a ball (centre `cx, cy, cz`, radius `r`, ship frame, metres) overlap the corridor cylinder: z + r above the anchor plane and
 * its centre's distance from the axis, less r, under `radiusM`? @private
 */
function _ballFoulsCorridor(cx, cy, cz, r, anchor, radiusM) {
  if (cz - anchor.z + r <= 0) return false;
  const rx = cx - anchor.x, ry = cy - anchor.y;
  return Math.sqrt(rx * rx + ry * ry) - r < radiusM;
}

/**
 * One held piece, centred `(cx, cy, cz)` in the ship frame with drawn attitude `q`: does any part of its drawn mesh sit in the
 * corridor? A piece with no mesh (no `type`: a mock, a prediction) is the sphere of its `trueReachM`. Allocation-free after the
 * mesh's first use. @private
 */
function _pieceFoulsCorridor(d, cx, cy, cz, q, anchor, radiusM) {
  const sizeM = d.sizeMeter;
  if (!(sizeM > 0)) return false;
  const reach = DebrisField.trueReachM(d, sizeM);
  const cloud = d.type ? _heldCloud(d.type, d.id) : null;
  if (!cloud) return _ballFoulsCorridor(cx, cy, cz, reach, anchor, radiusM);
  const sc = DebrisField.effectiveRenderScale(d) / M;               // the scale it is DRAWN at (metres per mesh unit)
  if (!(sc > 0)) return false;
  const margin = cloud.stepU * sc;                                   // each sample is a ball of one spacing (R6)
  if (!_ballFoulsCorridor(cx, cy, cz, Math.max(reach, DebrisWireframe.getOriginRadius(d.type, d.id) * sc) + margin, anchor, radiusM)) return false;
  // rotation matrix of q (row-major), scaled
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const r00 = (1 - 2 * (y * y + z * z)) * sc, r01 = 2 * (x * y - z * w) * sc, r02 = 2 * (x * z + y * w) * sc;
  const r10 = 2 * (x * y + z * w) * sc, r11 = (1 - 2 * (x * x + z * z)) * sc, r12 = 2 * (y * z - x * w) * sc;
  const r20 = 2 * (x * z - y * w) * sc, r21 = 2 * (y * z + x * w) * sc, r22 = (1 - 2 * (x * x + y * y)) * sc;
  const pts = cloud.pts;
  const axX = anchor.x, axY = anchor.y, axZ = anchor.z - margin;
  const rr = radiusM + margin, rr2 = rr * rr;
  for (let i = 0; i < pts.length; i += 3) {
    const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
    if (cz + r20 * px + r21 * py + r22 * pz <= axZ) continue;       // aft of the muzzle plane
    const dx = cx + r00 * px + r01 * py + r02 * pz - axX;
    const dy = cy + r10 * px + r11 * py + r12 * pz - axY;
    if (dx * dx + dy * dy < rr2) return true;
  }
  return false;
}

/**
 * net-duck D1 (owner 2026-10-22: "out of the way of mother net"): does anything this arm holds at home sit, with her strut at
 * `alphaRad`, inside the mother net's berth corridor? The corridor is the cylinder `CaptureNet._corridorClear` tests the strut tips
 * against: axis ship-local +Z through `anchor` (x, y), fore of the anchor plane (z > anchor.z), radius `radiusM`. A rack piece is its
 * drawn mesh (see the note above `CLOUD_STEP_FRAC`) at her pose at that angle; the in-hand catch (cleared when she parks, so only a
 * DOCKED / CARRY_PREP daughter that still has one) is the sphere of its `trueReachM` at its in-hand booking. Only a daughter at home
 * counts (HOLDING_CATCH, DOCKED, CARRY_PREP: her rack is at her strut); one out on a line, detached or expended does not. A mock arm
 * manager with no dock positions, or a held piece with no `mass`, is skipped (nothing to measure). READ-ONLY, no allocation.
 *
 * @param {object} armManager — with .arms[], ._dockPositions[], .playerSatellite
 * @param {number} armIndex
 * @param {number} alphaRad — strut sweep angle to read her cargo at (the live angle when not finite)
 * @param {{x:number,y:number,z:number}} anchor — the berth anchor in the ship frame, metres (the collar)
 * @param {number} radiusM — the corridor radius (inbound size / 2 + CAPTURE_NET.BERTH_CLEARANCE_M)
 * @returns {boolean} true when a held piece overlaps the corridor
 */
export function heldCargoFoulsCorridorAt(armManager, armIndex, alphaRad, anchor, radiusM) {
  const arm = (armManager.arms || [])[armIndex];
  const dp = (armManager._dockPositions || [])[armIndex];
  if (!arm || !dp || arm.isDetached) return false;
  const S = Constants.ARM_STATES;
  if (arm.state !== S.HOLDING_CATCH && arm.state !== S.DOCKED && arm.state !== S.CARRY_PREP) return false;
  const alpha = Number.isFinite(alphaRad) ? alphaRad : (arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0));
  const ps = armManager.playerSatellite || null;
  const hand = arm.capturedDebris;
  if (hand && hand.mass && hand.sizeMeter > 0) {
    heldInHandBookingMeters(arm, dp, alpha, ps, hand.sizeMeter, _cdBook, null);
    if (_ballFoulsCorridor(_cdBook.x, _cdBook.y, _cdBook.z, DebrisField.trueReachM(hand, hand.sizeMeter), anchor, radiusM)) return true;
  }
  const rack = arm.heldCatches;
  if (Array.isArray(rack)) {
    for (let s = 0; s < rack.length; s++) {
      const held = rack[s];
      if (!held || !held.mass) continue;
      heldCargoBookingMeters(arm, dp, alpha, ps, s, held.sizeMeter || 0, _cdBook, null, held, _cdQ);
      if (_pieceFoulsCorridor(held, _cdBook.x, _cdBook.y, _cdBook.z, _cdQ, anchor, radiusM)) return true;
    }
  }
  return false;
}

/**
 * Check whether any strut tip — or any cargo a strut HOLDS (S9, register
 * item 32) — is inside the plume cone of a specific thruster.
 *
 * Cone test: A point P is inside the plume cone of thruster at nozzle N
 * firing along direction D (unit) with half-angle θ if:
 *   1. axial = (P − N) · D > 0            (downstream of nozzle)
 *   2. perpDist / axial < tan(θ)           (within cone angle)
 *
 * S9 cargo term: for each arm passing the skip filter below, every HELD piece
 * is tested at its live booking through the box-chain volume model
 * (heldCargoPlumeChainInto → _ballInPlumeCone). An arm conflicts if its TIP
 * is in the cone OR any held piece's chain touches it. EMPTY arms take
 * exactly the pre-S9 path (byte-identical results). S9 changes what this
 * check SEES, never what thrust REFUSES.
 *
 * @param {object} armManager — with .arms[], ._dockPositions[]
 * @param {string} thrusterId — one of Constants.THRUSTERS[].id
 * @returns {{ blocked: boolean, conflictingArms: number[], reason: string }}
 */
export function checkPlumeInterference(armManager, thrusterId) {
  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return { blocked: false, conflictingArms: [], reason: '' };

  const thruster = thrusters.find(t => t.id === thrusterId);
  if (!thruster) return { blocked: false, conflictingArms: [], reason: `Unknown thruster: ${thrusterId}` };

  const tanHalf = Math.tan(Constants.PLUME_HALF_ANGLE);
  const n = thruster.nozzlePos;
  const d = thruster.thrustDir;
  // Normalize thrust direction
  const dMag = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  const dx = d.x / dMag, dy = d.y / dMag, dz = d.z / dMag;

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  const playerSatellite = armManager.playerSatellite || null;
  const conflictingArms = [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    // Skip arms that are detached or expended (not in the plume path)
    if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    const tip = strutTipMeters(dp, alpha);

    // Vector from nozzle to tip
    const vx = tip.x - n.x;
    const vy = tip.y - n.y;
    const vz = tip.z - n.z;

    // Axial projection: (tip − nozzle) · thrustDir
    const axial = vx * dx + vy * dy + vz * dz;
    let conflict = false;
    if (axial > 0) {
      // Perpendicular distance from cone axis
      // perpSq = |v|² − axial²
      const vLenSq = vx * vx + vy * vy + vz * vz;
      const perpSq = vLenSq - axial * axial;
      const perp = perpSq > 0 ? Math.sqrt(perpSq) : 0;

      // Cone test: perp / axial < tan(halfAngle)
      if (perp < axial * tanHalf) conflict = true;
    }

    // S9: when the tip tests clear, the check still sees what the pin DRAWS —
    // every held piece at its live booking through the box-chain model. The
    // i32 measurement proved the tip NEVER fouls while cargo did, so this
    // term is where the entire measured bite population becomes visible.
    if (!conflict) {
      conflict = _armHoldsCargoInCone(arm, dp, alpha, playerSatellite,
        n, dx, dy, dz, Constants.PLUME_HALF_ANGLE);
    }

    if (conflict) {
      conflictingArms.push(i);
    }
  }

  if (conflictingArms.length > 0) {
    return {
      blocked: true,
      conflictingArms,
      reason: `Arms [${conflictingArms.join(',')}] in plume cone of ${thrusterId}`,
    };
  }

  return { blocked: false, conflictingArms: [], reason: '' };
}

// Default export: namespace convenience
export default {
  computeCoM,
  computeInertia,
  computeCoMDrift,
  computeCoMDriftVector,
  computeCoMOffsetFromThrustVector,
  suggestStowArm,
  heldCargoBookingMeters,
  heldInHandBookingMeters,
  heldCargoPlumeChainInto,
  heldCargoPlumeConflictAt,
  strutTipMeters,
  strutMidpointMeters,
  checkPlumeInterference,
};
