/**
 * CoMCalculator.js — Center-of-Mass Tracking + Thruster Plume Interlock
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
 * AimDecomposition bridge reads `arm._dockOutward` in that convention, so the
 * stored fields cannot move. The mass model converts at the ONE boundary —
 * strutTipMeters / strutMidpointMeters — via the Y/Z swap
 * (x, y, z)_ship = (x, z, y)_stored, a rigid remapping: every magnitude
 * (|CoM position|, the drift scalar, totalMass) is byte-comparable across it,
 * and every downstream consumer (CoM, inertia, drift, both scorers, the plume
 * cone test) computes in ONE frame.
 *
 * BOOKING CONTRACT (S13(b), register item 58): held rack cargo is booked where
 * the pin actually holds it — the strut tip PLUS the pin's slot offset (the
 * √2·(sizeMeter/2 + ARM_HOLD_CLEARANCE_M) standoff), via ONE computation
 * (heldCargoBookingMeters → ArmUnit.heldSlotAnchorInto). Pre-S13(b) the model
 * booked rack cargo AT the tip, understating the CoM lever ~10× (measured at
 * S12's M1: 1600 kg finale 0.68 m modelled vs 6.80 m at the pin).
 *
 * @module systems/CoMCalculator
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { BridleRing } from '../entities/BridleRing.js';
import { heldSlotAnchorInto } from '../entities/ArmUnit.js';

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
  const L = V5.STRUT_LENGTH; // 1.60 m
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

// ── S13(b): rack-cargo booking (register item 58) ───────────────────────────
// Module temps — the repo hot-path idiom (computeCoM runs per frame; none of
// these may be retained across calls).
const _hcdAnchor = new THREE.Vector3();
const _hcdDir = new THREE.Vector3();
const _hcdUp = new THREE.Vector3();
const _hcdQInv = new THREE.Quaternion();
const _hcdOut = new THREE.Vector3();
/** Reused plain-object target for heldCargoBookingMeters on the hot paths. */
const _slotPoint = { x: 0, y: 0, z: 0 };

/**
 * Where a held rack piece actually IS, booked in the honest ship frame, in
 * meters. The anchor is the strut tip from strutTipMeters (the ONE S13(a)
 * conversion lives inside it — read it, never re-derive it); the offset is the
 * pin's own slot offset — `heldSlotAnchorInto`, the ONE computation shared with
 * `ArmUnit.heldSlotWorldInto` (register item 58).
 *
 * The hold axis follows the pin's sources in the pin's order:
 *   1. the fired net's launch direction (authored world-frame), transformed
 *      into the body frame by the inverse attitude quaternion — an identity
 *      quaternion is an exact no-op;
 *   2. else the strut-outboard fallback — the pin's `this.position −
 *      parentPos`, whose body-frame equivalent is the tip direction;
 *   3. else zero (the piece books AT the tip, as the pin parks AT the arm).
 * World-up transforms with the same inverse attitude on every path, so the
 * lat axis (holdDir × up) always lives in the frame of the axis that reaches
 * the helper.
 *
 * Internally the arithmetic runs on the pin's scene-unit tree (tip × M in,
 * ÷ M out) so that under an identity ship fixture the booking equals
 * `heldSlotWorldInto`'s output to float equality — same operands, same order.
 *
 * @param {object} arm — ArmUnit instance or mock (reads arm._firedNet only)
 * @param {object} dp — dock position (stored convention; see the FRAME CONTRACT)
 * @param {number} alpha — strut sweep angle (rad)
 * @param {object|null} playerSatellite — source of the attitude quaternion
 * @param {number} slotIndex — rack slot (0-based; slot 0 carries no lat rotation)
 * @param {number} sizeMeter — the piece's size, for the standoff radius
 * @param {{x:number,y:number,z:number}} out — receives the booking point, meters
 * @param {{x:number,y:number,z:null}} [axisOut] — when provided, receives the
 *   RESOLVED body-frame hold axis (unit; the zero vector when no source
 *   resolves). The ONE resolution of the axis — S9's volume model rides it
 *   instead of re-deriving the pin's direction (register item 32 / S13(b)'s
 *   one-computation rule).
 * @returns {{x:number,y:number,z:number}} out
 */
export function heldCargoBookingMeters(arm, dp, alpha, playerSatellite, slotIndex, sizeMeter, out, axisOut) {
  const tip = strutTipMeters(dp, alpha);
  _hcdAnchor.set(tip.x * M, tip.y * M, tip.z * M);

  let hasDir = false;
  const ld = arm && arm._firedNet && arm._firedNet.launchDirection;
  const q = playerSatellite && playerSatellite.quaternion;
  const hasQ = q && typeof q.x === 'number';
  _hcdUp.set(0, 1, 0);
  if (hasQ) {
    _hcdQInv.copy(q).invert();
    // World-up → body-up — on EVERY path, not just the fired-net one: the
    // lat axis is holdDir × up, and the up must live in the same frame as the
    // holdDir that reaches the helper (identity attitude ⇒ exact no-op).
    _hcdUp.applyQuaternion(_hcdQInv);
  }
  if (ld) {
    _hcdDir.set(ld.x, ld.y, ld.z);
    hasDir = _hcdDir.lengthSq() > 1e-12;
    if (hasDir && hasQ) _hcdDir.applyQuaternion(_hcdQInv);   // world → body
  }
  if (!hasDir) {
    _hcdDir.copy(_hcdAnchor);   // strut-outboard (the pin's position − mother)
    hasDir = _hcdDir.lengthSq() > 1e-12;
  }
  if (hasDir) _hcdDir.normalize(); else _hcdDir.set(0, 0, 0);

  heldSlotAnchorInto(_hcdAnchor, _hcdDir, _hcdUp, slotIndex, sizeMeter, _hcdOut);
  out.x = _hcdOut.x / M;
  out.y = _hcdOut.y / M;
  out.z = _hcdOut.z / M;
  if (axisOut) {
    axisOut.x = hasDir ? _hcdDir.x : 0;
    axisOut.y = hasDir ? _hcdDir.y : 0;
    axisOut.z = hasDir ? _hcdDir.z : 0;
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
      heldCargoBookingMeters(arm, dp, alpha, playerSatellite, 0, arm.capturedDebris.sizeMeter, _slotPoint));
  }
  if (Array.isArray(arm.heldCatches)) {
    for (let i = 0; i < arm.heldCatches.length; i++) {
      const held = arm.heldCatches[i];
      const m = (held && held.mass) || 0;
      if (m > 0) {
        cb(m, heldCargoBookingMeters(arm, dp, alpha, playerSatellite, i, held.sizeMeter, _slotPoint));
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
 * Compute composite center-of-mass of the entire spacecraft in body-local coordinates.
 *
 * Model:
 *   - Core bus:  mass = CORE_DRY_MASS, position = origin (0,0,0)
 *   - Per strut: mass = STRUT_MASS (4.5 kg), position = strut midpoint (α-dependent)
 *   - Per daughter: mass = WEAVER/SPINNER, position = strut tip (α-dependent)
 *
 * @param {object} armManager — ArmManager instance with .arms[], ._dockPositions[]
 * @param {object} [playerSatellite] — unused currently; reserved for propellant CoM offset
 * @returns {{ position: {x:number,y:number,z:number}, totalMass: number,
 *             breakdown: { core: number, struts: number[], arms: number[] } }}
 */
export function computeCoM(armManager, playerSatellite) {
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
    let dMass = 0;
    _forEachArmMassPoint(arm, dp, alpha, playerSatellite, (m, p) => {
      cx += m * p.x;
      cy += m * p.y;
      cz += m * p.z;
      totalMass += m;
      dMass += m;
    });

    // ST-9.7 C-8: Bridle ring mass + attached loads at strut tip
    if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.COM_TRACKING) {
      const bridleMass = BridleRing.getRingMassKg(i);
      if (bridleMass > 0) {
        const tip = strutTipMeters(dp, alpha);
        cx += bridleMass * tip.x;
        cy += bridleMass * tip.y;
        cz += bridleMass * tip.z;
        totalMass += bridleMass;
      }
    }

    armMasses.push(dMass);
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
    },
  };
}

/**
 * Compute the rigid-body moment of inertia about the barrel origin, in body
 * axes (kg·m²): ixx pitch (about +X), iyy yaw (about +Y), izz roll (about +Z,
 * the barrel long axis). This is the attitude-dynamics SSOT — it mirrors
 * computeCoM's mass tree exactly (same strut midpoint / daughter tip helpers,
 * same detached/expended exclusions) so inertia and CoM never diverge.
 * S13(a): the arm terms now arrive in the SAME ship frame as the bus-shell
 * term (roll mR² on izz) — pre-S13(a) they came out Y-barrel, which booked
 * the cargo's z-lever into roll and over-fired the izz clamp (register 57).
 *
 * Model:
 *   - Core bus: thin cylindrical shell, mass = CORE_DRY_MASS, at the origin.
 *       transverse (x,y) = m·(R²/2 + L²/12);  roll (z) = m·R².
 *       (R = COLLAR_RADIUS, L = CORE_LENGTH. Stowed transverse ≈ 66.5 kg·m².)
 *   - Struts: point mass STRUT_MASS at the α-dependent midpoint (parallel axis).
 *   - Daughters: point mass WEAVER/SPINNER at the α-dependent tip (parallel axis).
 *   - Bridle rings: same as computeCoM, only when the flags are on.
 *   - Berthed catch mass (D6): included as a fore point mass but the ADDED
 *     transverse/roll contribution is clamped so the total never exceeds
 *     INERTIA_MAX_FACTOR × the stowed bus inertia. 23 t unclamped would freeze
 *     rotation; the clamp mirrors the translation MASS_EFFECT_MAX soft-lock.
 *
 * @param {object} armManager — ArmManager (may be null/empty → bus-only inertia)
 * @param {object} [playerSatellite] — for getBerthedMassKg() via _captureNetSystem
 * @returns {{ ixx:number, iyy:number, izz:number }} kg·m² about the origin
 */
export function computeInertia(armManager, playerSatellite) {
  const R = V5.COLLAR_RADIUS;   // 0.40 m
  const L = V5.CORE_LENGTH;     // 2.0 m
  const coreMass = V5.CORE_DRY_MASS; // 161.0 kg

  // Bare-bus thin-shell inertia (also the stowed reference for the D6 clamp).
  const busTransverse = coreMass * (R * R / 2 + L * L / 12); // ≈ 66.5
  const busRoll = coreMass * R * R;                          // ≈ 25.76

  let ixx = busTransverse;
  let iyy = busTransverse;
  let izz = busRoll;

  // Point-mass contribution via parallel axis: for mass m at (x,y,z),
  //   Ixx += m(y²+z²), Iyy += m(x²+z²), Izz += m(x²+y²).
  const addPoint = (m, p) => {
    if (m <= 0) return;
    ixx += m * (p.y * p.y + p.z * p.z);
    iyy += m * (p.x * p.x + p.z * p.z);
    izz += m * (p.x * p.x + p.y * p.y);
  };

  const arms = (armManager && armManager.arms) || [];
  const docks = (armManager && armManager._dockPositions) || [];

  // Cargo-continuity S2 (bug B2): held-catch cargo contributes inertia, but —
  // like the D6 berthed mass below — a multi-tonne catch at a strut tip would
  // otherwise freeze rotation. Accumulate the daughter CARGO contribution
  // separately and clamp it with the berthed mass under INERTIA_MAX_FACTOR, so
  // the clamp reins in cargo/berth but never the structural config.
  let cargoIxx = 0, cargoIyy = 0, cargoIzz = 0;

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
        const p = heldCargoBookingMeters(arm, dp, alpha, playerSatellite, 0,
          arm.capturedDebris.sizeMeter, _slotPoint);
        cargoIxx += handMass * (p.y * p.y + p.z * p.z);
        cargoIyy += handMass * (p.x * p.x + p.z * p.z);
        cargoIzz += handMass * (p.x * p.x + p.y * p.y);
      }
      if (Array.isArray(arm.heldCatches)) {
        for (let si = 0; si < arm.heldCatches.length; si++) {
          const held = arm.heldCatches[si];
          const m = (held && held.mass) || 0;
          if (m <= 0) continue;
          const p = heldCargoBookingMeters(arm, dp, alpha, playerSatellite, si,
            held.sizeMeter, _slotPoint);
          cargoIxx += m * (p.y * p.y + p.z * p.z);
          cargoIyy += m * (p.x * p.x + p.z * p.z);
          cargoIzz += m * (p.x * p.x + p.y * p.y);
        }
      }
    }

    // Bridle rings — only when both flags are on (mirror computeCoM).
    if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.COM_TRACKING) {
      const bridleMass = BridleRing.getRingMassKg(i);
      if (bridleMass > 0) addPoint(bridleMass, strutTipMeters(dp, alpha));
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
  if (berthed > 0 || cargoIxx > 0 || cargoIyy > 0 || cargoIzz > 0) {
    const factor = Constants.ATTITUDE?.INERTIA_MAX_FACTOR ?? 3.0;
    const leverT2 = (L / 2) * (L / 2); // transverse lever² (fore capture point)
    const leverR2 = (R / 2) * (R / 2); // small roll radius²
    const capT = factor * busTransverse;
    const capR = factor * busRoll;
    const addT = berthed * leverT2;   // berthed transverse addition
    const addR = berthed * leverR2;   // berthed roll addition
    ixx = Math.min(ixx + addT + cargoIxx, Math.max(ixx, capT));
    iyy = Math.min(iyy + addT + cargoIyy, Math.max(iyy, capT));
    izz = Math.min(izz + addR + cargoIzz, Math.max(izz, capR));
  }

  return { ixx, iyy, izz };
}

/**
 * Compute scalar CoM drift — the *asymmetric* displacement of CoM from the
 * "balanced" reference position (all arms at mean alpha). This isolates the
 * player-correctable asymmetry from the permanent collar-height offset.
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

  const invB = bTotal > 0 ? 1 / bTotal : 0;
  const bx = bcx * invB, by = bcy * invB, bz = bcz * invB;

  // Drift = |actualCoM − balancedCoM|
  const dx = actual.position.x - bx;
  const dy = actual.position.y - by;
  const dz = actual.position.z - bz;
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

  let bcx = 0, bcy = 0, bcz = 0;
  let bTotal = V5.CORE_DRY_MASS;

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

  const invB = bTotal > 0 ? 1 / bTotal : 0;
  return {
    x: actual.position.x - bcx * invB,
    y: actual.position.y - bcy * invB,
    z: actual.position.z - bcz * invB,
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
  const com = computeCoM(armManager, playerSatellite);
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

    // Only suggest stow for arms that are deployed and not detached/expended
    const deployState = arm.getDeployState ? arm.getDeployState() : 'DEPLOYED';
    if (deployState !== 'DEPLOYED' && deployState !== 'DEPLOYING') continue;
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
 * ONTO the CoM offset, and its filter keeps DEPLOYED/DEPLOYING arms). A carrier
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
 *   • the FREE-CELL rule — `heldCatches.length < DAUGHTER_CARGO_CELLS`;
 *   • the HOME rule — DOCKED or HOLDING_CATCH only, never detached/expended (a
 *     daughter away from her strut has nothing to pin the cargo to);
 *   • the LAST-DAUGHTER guard — never consume the last capture-capable daughter,
 *     so an automatic hand-off can never strand the fleet with zero usable arms.
 *
 * @param {object} armManager — ArmManager (or mock) with .arms[], ._dockPositions[]
 * @param {object} [playerSatellite] — passed through to computeCoM
 * @param {number} cargoMassKg — mass of the piece being handed over
 * @param {number} [sizeMeter=0] — the piece's size, for the slot standoff
 *   radius (the S7 caller is mass-only; 0 books the bare clearance standoff).
 * @returns {number|null} arm index, or null when nothing may carry it
 */
export function suggestCargoArm(armManager, playerSatellite, cargoMassKg, sizeMeter = 0) {
  const mass = Number(cargoMassKg) || 0;
  if (mass <= 0) return null;

  const CT = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.CARGO_TRANSFER) || {};
  const maxKg = CT.MAX_KG ?? 2000;
  if (mass > maxKg) return null;                       // monster: stays on the axis

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  if (!arms.length) return null;

  const S = Constants.ARM_STATES;
  const cells = Constants.DAUGHTER_CARGO_CELLS ?? 2;
  const reserve = Constants.ARM_RESERVE_FUEL ?? 0;

  // A daughter that could still take a capture: home, charged, fuelled. Loading
  // one of these costs the fleet a working arm; loading a HOLDING_CATCH arm costs
  // nothing extra (she is already occupied).
  const captureCapable = (arm) => !!arm && !arm.isDetached
    && arm.state === S.DOCKED
    && arm.springCharged !== false
    && (arm.fuel ?? 0) > reserve;
  const capableCount = arms.reduce((n, a) => n + (captureCapable(a) ? 1 : 0), 0);

  const com = computeCoM(armManager, playerSatellite);
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

    // Home with a free cell, and still part of the ship.
    if (arm.isDetached || arm.state === S.EXPENDED) continue;
    if (arm.state !== S.DOCKED && arm.state !== S.HOLDING_CATCH) continue;
    const held = Array.isArray(arm.heldCatches) ? arm.heldCatches.length : 0;
    if (held >= cells) continue;

    // Never spend the last capture-capable daughter on cargo.
    if (captureCapable(arm) && capableCount <= 1) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    // S13(b): the hypothetical add books where the piece would actually be
    // PINNED — this arm's next free slot (register item 58; ONE computation
    // with the rack pin). Rankings on symmetric fixtures are unchanged:
    // fallback axes are tip-radial, so |p_i| and p_i.z are arm-independent
    // (tip·lat = 0) and the CG term ties exactly as before.
    const book = heldCargoBookingMeters(arm, dp, alpha, playerSatellite, held, sizeMeter, _slotPoint);

    // CoM after adding `mass` at this slot: (M·p + m·slot) / (M + m).
    const denom = totalMass + mass;
    if (denom <= 0) continue;
    const ax = (totalMass * p.x + mass * book.x) / denom;
    const ay = (totalMass * p.y + mass * book.y) / denom;
    const az = (totalMass * p.z + mass * book.z) / denom;
    const driftAfter = Math.sqrt(ax * ax + ay * ay + az * az);

    const deployability = Math.max(0, Math.min(1, (arm.fuel ?? 0) / 100));
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


// ═══════════════════════════════════════════════════════════════════════════
// §2  Plume Interference (Gap #8)
// ═══════════════════════════════════════════════════════════════════════════

// ── S9: the held-cargo VOLUME model (register item 32) ──────────────────────
// The box: dims from the item-7 SSOT (DebrisField.setDebrisSize keeps
// lengthM/widthM tracking sizeMeter per type), oriented by the booking's hold
// frame — long axis ALONG the resolved hold direction, square widthM × widthM
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
 * @returns {number} balls written (1 = sphere fallback, else CHAIN_K)
 */
export function heldCargoPlumeChainInto(arm, dp, alpha, playerSatellite, slotIndex, debris, out) {
  const sizeMeter = (debris && debris.sizeMeter) || 0;
  heldCargoBookingMeters(arm, dp, alpha, playerSatellite, slotIndex, sizeMeter,
    _plumeBookingTmp, _plumeAxisTmp);
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
    const count = heldCargoPlumeChainInto(arm, dp, alpha, playerSatellite, 0, hand, _plumeChainBall);
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
 * what thrust refuses is THRUSTER_INTERLOCK's business, untouched.
 *
 * @param {object} armManager — with .arms[], ._dockPositions[]
 * @param {number} armIndex
 * @returns {{ armIndex: number, thrusterId: string }|null} first conflict
 */
export function heldCargoPlumeConflictAt(armManager, armIndex) {
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

  const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
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
 * exactly the pre-S9 path (byte-identical results). The interlock stays
 * dormant — THRUSTER_INTERLOCK semantics are untouched; S9 changes what this
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

    // Skip arms that are stowed (effectively alongside barrel, not in plume path)
    // But still check DEPLOYING/STOWING since the strut is in motion
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

/**
 * Check all thrusters for plume conflicts and return a map of blocked thrusters.
 *
 * @param {object} armManager
 * @returns {Object<string, string>} Map: { thrusterId → blockedReason } (only blocked thrusters)
 */
export function getActiveBlocks(armManager) {
  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return {};

  const blocks = {};
  for (const t of thrusters) {
    const result = checkPlumeInterference(armManager, t.id);
    if (result.blocked) {
      blocks[t.id] = result.reason;
    }
  }
  return blocks;
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  CoM Drift Warning State Machine
// ═══════════════════════════════════════════════════════════════════════════

/** @type {boolean} Whether a drift warning is currently active (for debouncing) */
let _driftWarningActive = false;

/** @type {Object<string, boolean>} Per-thruster block state (for edge detection) */
const _thrusterBlockState = {};

/**
 * Update CoM drift warning state. Call once per frame (or at HUD rate).
 * Emits COM_DRIFT_WARNING on threshold crossing up, COM_DRIFT_CLEARED on crossing down.
 * Debounced: only emits on state transitions.
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {{ offsetM: number, isWarning: boolean, suggestedArm: number|null }}
 */
export function updateDriftWarning(armManager, playerSatellite) {
  if (!Constants.FEATURE_FLAGS.COM_TRACKING) {
    // Flag off: silently return zero drift, no events
    if (_driftWarningActive) {
      _driftWarningActive = false;
    }
    return { offsetM: 0, isWarning: false, suggestedArm: null };
  }

  const offsetM = computeCoMDrift(armManager, playerSatellite);
  const threshold = Constants.COM_DRIFT_WARN_THRESHOLD;
  const isOverThreshold = offsetM >= threshold;

  let suggestedArm = null;

  if (isOverThreshold && !_driftWarningActive) {
    // Threshold crossing UP → emit warning
    _driftWarningActive = true;
    suggestedArm = suggestStowArm(armManager, playerSatellite);
    eventBus.emit(Events.COM_DRIFT_WARNING, {
      offsetM,
      threshold,
      suggestedStowArm: suggestedArm,
    });
  } else if (!isOverThreshold && _driftWarningActive) {
    // Threshold crossing DOWN → emit cleared
    _driftWarningActive = false;
    eventBus.emit(Events.COM_DRIFT_CLEARED, { offsetM });
  } else if (isOverThreshold) {
    // Still over threshold — compute suggestion for HUD but don't re-emit
    suggestedArm = suggestStowArm(armManager, playerSatellite);
  }

  return { offsetM, isWarning: _driftWarningActive, suggestedArm };
}

/**
 * Update thruster block state and emit edge events.
 * Call once per frame/HUD-tick when THRUSTER_INTERLOCK flag is ON.
 *
 * @param {object} armManager
 * @returns {Object<string, string>} current blocks map { thrusterId → reason }
 */
export function updateThrusterBlocks(armManager) {
  if (!Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK) {
    // Flag off: clear all block state, no events
    for (const id of Object.keys(_thrusterBlockState)) {
      if (_thrusterBlockState[id]) {
        _thrusterBlockState[id] = false;
      }
    }
    return {};
  }

  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return {};

  const currentBlocks = {};

  for (const t of thrusters) {
    const result = checkPlumeInterference(armManager, t.id);
    const wasBlocked = !!_thrusterBlockState[t.id];

    if (result.blocked && !wasBlocked) {
      _thrusterBlockState[t.id] = true;
      eventBus.emit(Events.THRUSTER_BLOCKED_PLUME, {
        thrusterId: t.id,
        conflictingArms: result.conflictingArms,
        reason: result.reason,
      });
    } else if (!result.blocked && wasBlocked) {
      _thrusterBlockState[t.id] = false;
      eventBus.emit(Events.THRUSTER_UNBLOCKED, { thrusterId: t.id });
    }

    if (result.blocked) {
      currentBlocks[t.id] = result.reason;
    }
  }

  return currentBlocks;
}

/**
 * Reset internal state (for testing / new game).
 */
export function resetCoMState() {
  _driftWarningActive = false;
  for (const id of Object.keys(_thrusterBlockState)) {
    delete _thrusterBlockState[id];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §4  CoM-Induced Torque Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the torque vector induced when thrust F acts through a CoM that is
 * offset from the thrust line.
 *
 *   τ = r × F
 *
 * where r is the CoM position (offset from origin which is the thrust-line anchor).
 * Returns the torque vector in body coordinates (N·m if F is in Newtons, r in meters).
 *
 * @param {{x:number,y:number,z:number}} comPos — CoM offset from origin (meters)
 * @param {{x:number,y:number,z:number}} thrustForce — thrust force vector (N)
 * @returns {{x:number, y:number, z:number}} torque vector (N·m)
 */
export function computeInducedTorque(comPos, thrustForce) {
  return {
    x: comPos.y * thrustForce.z - comPos.z * thrustForce.y,
    y: comPos.z * thrustForce.x - comPos.x * thrustForce.z,
    z: comPos.x * thrustForce.y - comPos.y * thrustForce.x,
  };
}

// Default export: namespace convenience
export default {
  computeCoM,
  computeInertia,
  computeCoMDrift,
  computeCoMDriftVector,
  computeCoMOffsetFromThrustVector,
  computeInducedTorque,
  suggestStowArm,
  heldCargoBookingMeters,
  heldCargoPlumeChainInto,
  heldCargoPlumeConflictAt,
  strutTipMeters,
  strutMidpointMeters,
  checkPlumeInterference,
  getActiveBlocks,
  updateDriftWarning,
  updateThrusterBlocks,
  resetCoMState,
};
