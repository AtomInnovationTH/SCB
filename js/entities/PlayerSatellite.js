/**
 * PlayerSatellite.js — The player's ADR (Active Debris Removal) spacecraft
 * (Octopus V5 / Config G core). Detailed cylindrical "barrel" model with
 * subsystems: body-mount thin-film solar cells, deployable ROSA wings,
 * FEEP main + RCS thrusters, EO/IR/LIDAR sensor gimbal, arm collar with
 * hinges and crossbow struts, docking port, and nav lights.
 * @module entities/PlayerSatellite
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture, getRosaBackTexture } from '../scene/solarCellTexture.js';
import {
  getRosaFrontTexture, getRosaFrontEmissiveTexture, getRosaBackHarnessTexture, getRosaStowBandTexture,
} from '../scene/rosaBlanketTexture.js';
import { getMLIFoilMaps, MLI_FOIL_LOOK } from '../scene/mliFoilTexture.js';
import { getRadialGlowTexture, makeLightHalo } from '../scene/glowSpriteTexture.js';
import { makePlumeFrustum } from '../scene/plumeGeometry.js';
import { applyDetailLod } from '../scene/detailLodCull.js';
import { getRadiatorRailTexture } from '../scene/radiatorRailTexture.js';
import { getOrbitalFoilEnv } from '../scene/orbitalFoilEnv.js';
import { AVIONICS_GUNMETAL, AVIONICS_DARK_OPTIC, AVIONICS_THERMAL_WHITE } from '../scene/avionicsMaterials.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import { engineGasKg, engineTankDryKg, engineGasLowFrac, startEnginePool, START_GAS_KG, coldGasKgToPool, coldGasPoolToKg } from '../systems/ResourceSystem.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import {
  computeCoM,
  computeInertia,
} from '../systems/CoMCalculator.js';
import { composeDockedArmQuat, strutLocalDirection } from './ArmDockBasis.js';
import { netCellLayout } from './netCellLayout.js';
import { motherDragAreaM2 } from './MotherDragArea.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  cartesianToKeplerian,
  isInShadow,
  orbitalVelocity,
  atmosphericDrag,
} from './OrbitalMechanics.js';
import { DEG2RAD, RAD2DEG, degToRad, radToDeg, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

// Engine-gas flow follows thrust and Isp. Module-level (not methods) so the borrowed-prototype / mock ships the tests use
// (`PlayerSatellite.prototype.applyCartesianImpulse.call(mock, ...)`) bill the same way.

/**
 * The consumption multiplier c: every gain that makes a kilogram of gas push longer acts as an Isp gain — the paid
 * "Efficient Ion Drive" (`_ionThrustXenonRate / _baseIonXenonRate` = 0.8 after the upgrade) times the THRUST-bus power
 * split (1 / thrustMultiplier). Used by the flow AND by the ΔV readout (ArmManager.getMassBudget), so they cannot disagree.
 * @returns {number} c (1 = no gain; 0.8 = 20 % less gas per m/s)
 */
function consumptionMultiplier(ship) {
  const base = ship._baseIonXenonRate;
  const upgrade = (base > 0 && Number.isFinite(ship._ionThrustXenonRate))
    ? ship._ionThrustXenonRate / base : 1;
  const tm = powerDistribution.thrustMultiplier;
  const split = tm > 0 ? 1 / tm : 1;   // 0 = engine offline: refused before billing, so 1 is only a readout default
  return upgrade * split;
}

/**
 * The cargo mass factor the main-thrust translation uses (see _applyThrust): 1 with no cargo, else
 * 1 / (1 + min(cargo·mult / mass, max)). One definition for the Δv applied and the gas it costs.
 * `mass` is her mass WITHOUT the cargo (ship.massExcludingCargoKg()): `ship.mass` is the live wet mass and already
 * carries the cargo, which this formula adds itself — counted once.
 */
function cargoThrustFactor(ship) {
  const cargo = (ship.armManager && typeof ship.armManager.getCargoMassKg === 'function')
    ? ship.armManager.getCargoMassKg()
    : (ship._captureNetSystem && typeof ship._captureNetSystem.getBerthedMassKg === 'function')
      ? ship._captureNetSystem.getBerthedMassKg() : 0;
  if (!(cargo > 0)) return 1;
  const CN = Constants.CAPTURE_NET || {};
  const mult = CN.MASS_EFFECT_MULT ?? 1.0;
  const maxFactor = CN.MASS_EFFECT_MAX ?? 2.0;
  return 1 / (1 + Math.min(cargo * mult / ship.massExcludingCargoKg(), maxFactor));
}

/**
 * The active fuel's thrustScale: how hard the engine pushes per watt, relative to xenon (argon 0.46, krypton 0.67,
 * xenon 1.0; a cargo fuel its own). The SAME scale acts in the live burn path (applyCartesianImpulse), and the
 * autopilot reads it (getThrustScale) to plan a braking rate its engine can really deliver. Always > 0.
 */
function activeThrustScale(ship) {
  const fuel = ship._resourceSystem
    ? ship._resourceSystem.getCurrentFuel()
    : (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
  const s = fuel && fuel.thrustScale;
  return s > 0 ? s : 1;
}

/**
 * The ship's total mass NOW (dry + tank + cold gas + engine gas + cargo + docked arms), kg. Exact (unrounded) when the
 * ArmManager budget is wired; otherwise core + tank + both gases from the resource mirror (headless/mock ships).
 */
function shipMassKg(ship) {
  const am = ship.armManager;
  if (am && typeof am.getMassBudget === 'function') {
    try {
      const b = am.getMassBudget();
      if (b && b.shipMassKg > 0) return b.shipMassKg;
    } catch (_) { /* fall through to the mirror */ }
  }
  const r = ship.resources || {};
  const cold = coldGasPoolToKg(r.coldGas || 0);   // pool units -> kg (a bigger tank holds more kg)
  return Constants.OCTOPUS_V5.CORE_DRY_MASS + engineTankDryKg(r) + engineGasKg(r) + cold;
}

/**
 * Propellant a burn of `dvMps` costs, in the units the active fuel is held in: pool units (percent of one full base
 * tank, `res.xenon`) for an engine-tank gas, kg of cargo metal for a cargo fuel.
 *   ṁ = c · m_ship · Δv / (Isp · g0)
 * — Tsiolkovsky's differential, so a burn that empties a tenth of the tank costs exactly the ΔV the HUD's formula
 * (engineDeltaV) says it should.
 * @param {number} dvMps - Δv the engine actually delivered this tick, m/s
 * @param {object} [fuel] - the active fuel definition (FUELS entry)
 */
function ionGasUnits(ship, dvMps, fuel) {
  if (!(dvMps > 0)) return 0;
  const f = fuel || (ship._resourceSystem ? ship._resourceSystem.getCurrentFuel() : Constants.FUELS[Constants.DEFAULT_FUEL]);
  const isp = f && f.isp > 0 ? f.isp : Constants.OCTOPUS_CORE_HALL_ISP;
  const kg = consumptionMultiplier(ship) * shipMassKg(ship) * dvMps / (isp * Constants.G0);
  if (f && f.fromCargo) return kg;
  const tank = Constants.FUELS[(ship.resources && ship.resources.tankGasId) || Constants.DEFAULT_FUEL]
    || Constants.FUELS[Constants.DEFAULT_FUEL];
  return kg / tank.kgFull * 100;
}


/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** `_petalHolds` of a test stub that borrows `_updateFlower` (never written). */
const EMPTY_HOLDS = Object.freeze([]);

// Preallocated temps (strut sweep animation, strut-tip dock offset, arm orientation).
const _strutFrom = new THREE.Vector3(0, -1, 0);
const _strutTo   = new THREE.Vector3();
const _strutQuat = new THREE.Quaternion();
const _tipLocal    = new THREE.Vector3();
const _armQuat     = new THREE.Quaternion();
// Scratch world-space target quat for DOCKING slerp / HOLDING_CATCH snap.
const _armDockTargetQuat = new THREE.Quaternion();

// Per-frame animation temps (solar tracking, sensor gimbal, solar power): written and consumed within one call;
// single PlayerSatellite instance.
const _qInvTmp = new THREE.Quaternion();
const _v3TmpA  = new THREE.Vector3();
const _v3TmpB  = new THREE.Vector3();
const _v3TmpC  = new THREE.Vector3();
const _v3TmpD  = new THREE.Vector3();
/* Gathered-Δv key for a push with no source (a test, a one-off); a reeling daughter keys her own. */
const REEL_PUSH_SHARED = Object.freeze({ shared: true });
// Shared raycaster for the throttled body-cell shading estimate (_computeBodyPowerW).
const _solarRaycaster = new THREE.Raycaster();
_solarRaycaster.layers.enableAll();   // ship meshes sit on the near-field layer (SceneManager.registerNearFieldRoot)
// Per-frame scratch, single instance, no alloc: RCS direction-aware firing, then attitude dynamics.
const _rcsL  = new THREE.Vector3();
const _rcsLn = new THREE.Vector3();
const _v3AttA = new THREE.Vector3();
const _v3AttB = new THREE.Vector3();
const _v3AttC = new THREE.Vector3();
const _v3AttD = new THREE.Vector3();
const _v3AttE = new THREE.Vector3();
const _v3SlA = new THREE.Vector3();   // sloth mode: the boxes' torque this substep (kept apart from the cold-gas torque)
const _AXES3 = Object.freeze(['x', 'y', 'z']);
const _v3WhA = new THREE.Vector3();   // reaction wheels: the torque the wheels give the ship this substep (kept apart from the gas torque)
const _qAttA  = new THREE.Quaternion();
const _qAttB  = new THREE.Quaternion();
const _qAttC  = new THREE.Quaternion();
const _qIdentity = new THREE.Quaternion();   // never written: the target of easeOrbitFrameOffset
const _matAtt = new THREE.Matrix4();
// Drag-area scratch: her velocity direction in her body frame, the inverse attitude, and the two wing records the pure
// model reads.
const _dragDir = new THREE.Vector3();
const _dragNrm = new THREE.Vector3();
const _dragQInv = new THREE.Quaternion();
const _dragWings = [{ scale: 0, nx: 0, ny: 0, nz: 0 }, { scale: 0, nx: 0, ny: 0, nz: 0 }];
const clampAbs = (v, limit) => (v > limit ? limit : (v < -limit ? -limit : v));
// Roll basis: ArmDockBasis.js (CONVENTIONS.md §10 Rule B).
const _composeDockedArmQuat = composeDockedArmQuat;

const {
  DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  V5_ARM_COUNT, V5_WEAVER_MASS, V5_SPINNER_MASS, ARM_STATES,
} = Constants;

/**
 * owner 2026-10-12: "adjusting wings and open/closing costs battery and thermals … 8 motors on strut cost energy and
 * thermals". Bills one moving motor's watts for this frame through the wired ResourceSystem (`billWatts`: the base
 * load's own W→units conversion, drawUpTo, so the heat follows through the ledger). Nothing on a held-world frame
 * (`_motorBillHeld`, set from dtWorld at the top of update()) or with no battery wired (menu hero, headless stubs).
 * A module function so the duck-typed stubs that call `P.method.call(stub)` still run.
 * @param {number} dt - real seconds
 * @returns {number} battery units drawn
 */
function billMotorW(ship, watts, dt) {
  if (!ship || ship._motorBillHeld === true || !(watts > 0) || !(dt > 0)) return 0;
  const rs = ship._resourceSystem;
  if (!rs || typeof rs.billWatts !== 'function') return 0;
  return rs.billWatts(watts, dt);
}

/** A hinge / tilt drive turning at least this fast is moving (rad/s). */
function motorMoveMinRadS() {
  return degToRad(Constants.MOTOR_DRAW_W?.MOVE_MIN_DEG_S ?? 0.1);
}

/**
 * "…unless debris blocks the path" (owner 2026-10-09; measured in Constants THERMAL.FLOWER.CARGO_CLEAR_ALPHA_ROWS):
 * true while a docked daughter holds cargo on its rack with its strut angle α below the first angle that clears the
 * petals' swept volume (θ 146–180°) for that cargo's size. Only the AUTOMATIC swings to OPEN_DEG consult it; the
 * player's commands never do. A module function so `_updateFlower` / `_warnFlowerThrustInhibit` still run against
 * the duck-typed stubs (`P.method.call(stub)`).
 */
function radiatorSweepBlocked(ship) {
  const arms = ship.armManager && ship.armManager.arms;
  if (!Array.isArray(arms)) return false;
  const rows = Constants.THERMAL.FLOWER.CARGO_CLEAR_ALPHA_ROWS;
  for (const arm of arms) {
    if (!arm || arm.isDetached || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
    // Largest piece she holds: the rack plus the in-hand scalar (no allocation: runs on every refused autopilot frame above 146°).
    const rack = Array.isArray(arm.heldCatches) ? arm.heldCatches : null;
    const inHand = arm.capturedDebris || null;
    if ((!rack || rack.length === 0) && !inHand) continue;
    let size = 0;
    let sized = false;
    if (rack) {
      for (let k = 0; k < rack.length; k++) {
        const h = rack[k];
        if (h && h.sizeMeter > 0) { size = Math.max(size, h.sizeMeter); sized = true; }
      }
    }
    if (inHand && inHand.sizeMeter > 0) { size = Math.max(size, inHand.sizeMeter); sized = true; }
    if (!sized) size = Infinity;                       // unknown size → the deepest row
    let clearDeg = rows[rows.length - 1][1];
    for (const [maxSize, alphaDeg] of rows) { if (size <= maxSize) { clearDeg = alphaDeg; break; } }
    const alpha = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : 0;
    if (radToDeg(alpha) < clearDeg - 1e-9) return true;   // (1e-9: a strut parked exactly on the row angle is clear)
  }
  return false;
}

/**
 * Aim the radiator home at OPEN_DEG (146°) from 180° (DECISIONS §15, owner 2026-10-09). Writes ONLY `_flowerTargetTheta`
 * — the driver keeps the vent ceiling until θ is back inside the band, so this slews at SLEW_RATE_RAD_S and never
 * snaps. It never clears `_flowerVentArmed`, never touches `_lastFlowerTap` (the F1 bar's O-then-tap guard reads it),
 * never stamps the player-command clock and never emits THERMAL_FLOWER_INPUT (ThermalSystem would read that as a player
 * command and let go of an auto-opened radiator). A module function: `_updateFlower` and `_warnFlowerThrustInhibit`
 * also run against duck-typed stubs (`P.method.call(stub)`).
 * @returns {boolean} true when the swing was commanded now (false: already heading into the band, nothing is above
 *   it, or the lock holds it)
 */
function commandFlowerHome(ship) {
  if (ship._flowerGroups.length === 0 || ship._flowerLaunchLock) return false;
  // The shared angle does not change while a petal is held for a catch (settle and auto-open wait for it)
  if (ship.flowerHandoffHeld === true || ship.flowerCommandsLocked === true) return false;
  const FL = Constants.THERMAL.FLOWER;
  const openRad = degToRad(FL.OPEN_DEG);
  if (ship._flowerThetaRad <= openRad + 1e-9) return false;
  const tgt = ship._flowerTargetTheta;
  // Already heading into the band (the player folding it, or a swing in flight): leave that command alone, skip the arm scan.
  if (tgt !== undefined && tgt <= openRad + 1e-9) return false;
  if (radiatorSweepBlocked(ship)) return false;
  ship._flowerTargetTheta = openRad;
  return true;
}

/**
 * DECISIONS §15 (owner 2026-10-09): "It settles back to 146° from 180° after 30 s". Called every `_updateFlower`. Fires
 * once θ is more than 1° past OPEN_DEG, RETURN_TO_OPEN_S real seconds have passed since the last player radiator
 * command, and nothing else owns the radiator (launch lock, OVERRIDE fold, an active launch driver — the opening
 * dance). One plain COMMS line.
 */
function settleFlowerToOpen(ship) {
  if (ship._flowerLaunchLock || ship._flowerOverrideFold) return;
  const FL = Constants.THERMAL.FLOWER;
  if (!(FL.RETURN_TO_OPEN_S > 0)) return;
  if (ship._flowerThetaRad <= degToRad(FL.OPEN_DEG + 1)) return;
  if ((ship._flowerClockS || 0) - (ship._flowerCmdClockS || 0) < FL.RETURN_TO_OPEN_S) return;
  // An active launch driver holds it: the opening dance drives via `_launchSequence` (`_danceDrivesMe()` is
  // `isOpeningDance && isActive()`, the same check).
  const ls = ship._launchSequence;
  if (ls && typeof ls.isActive === 'function' && ls.isActive()) return;
  if (!commandFlowerHome(ship)) return;
  eventBus.emit(Events.COMMS_MESSAGE, {
    sender: 'THERMAL',
    text: `Radiator back to ${FL.OPEN_DEG}°.`,
    priority: 'info',
  });
}

/**
 * owner 2026-10-23: the radiator wings wait before the band [BAND_LO, BAND_HI] while a daughter's catch is not clear of
 * it (`armManager.radiatorBandBlocked()`: 'wait' = a holder not yet lifted, one docking with a catch, one reeling inside
 * HOLD_M; 'never' = a holder that can reach no clear pose). Called with the step the slew just made (`th0` -> `th1`)
 * toward `_flowerTargetTheta`: a move that would ENTER the band from outside is cut at the band's edge ('wait'; the
 * target stays, and the frame the blocker clears the wings go on); a wing already inside keeps moving (leaving is the
 * safe way). 'never', or a wait of more than WAIT_CAP_S, drops the target for good, in the same step, with every lock
 * that move armed (the launch fold's lock, the override fold: a dropped fold leaves thrust free and no sequence
 * waiting on it), and says so in one line. A module function: `_updateFlower` also runs against duck-typed stubs
 * (`P.method.call(stub)`), which have no `armManager`: no gate.
 * @param {number} th0 the angle before the step (rad)
 * @param {number} th1 the angle after it (rad)
 * @returns {number} the angle the wings take this frame (rad)
 */
function bandGate(ship, th0, th1, dt) {
  const am = ship.armManager;
  if (!am || typeof am.radiatorBandBlocked !== 'function') return th1;
  const tgt = ship._flowerTargetTheta;
  const R = Constants.REEL_HOLD;
  const lo = degToRad(R.BAND_LO_DEG);
  const hi = degToRad(R.BAND_HI_DEG);
  const eps = 1e-9;
  let edge = NaN;                                                 // the band edge this move enters through (the cut parks them AT it)
  if (th0 <= lo + eps && tgt > lo + eps) edge = lo;
  else if (th0 >= hi - eps && tgt < hi - eps) edge = hi;
  if (edge !== edge) { ship._bandWaitS = 0; ship._bandSaid = false; return th1; }   // not entering: a wing inside keeps going
  const why = am.radiatorBandBlocked();
  if (why === null) { ship._bandWaitS = 0; ship._bandSaid = false; return th1; }
  if (why === 'wait') {
    const cut = edge === lo ? th1 > lo : th1 < hi;
    if (!cut) return th1;                                         // still on the way to the edge: the wait starts there
    ship._bandWaitS = (ship._bandWaitS || 0) + (dt > 0 ? dt : 0);
    if (ship._bandWaitS <= R.WAIT_CAP_S) {
      if (!ship._bandSaid) {
        ship._bandSaid = true;
        eventBus.emit(Events.COMMS_MESSAGE, { sender: 'THERMAL', text: am.radiatorBandSays('wait'), priority: 'info' });
      }
      return edge;
    }
  }
  // 'never', or a wait that lasted too long: the move is dropped, here, with its locks
  eventBus.emit(Events.COMMS_MESSAGE, { sender: 'THERMAL', text: am.radiatorBandSays('stay'), priority: 'info' });
  ship._flowerTargetTheta = undefined;
  ship._flowerLaunchLock = false;
  ship._flowerOverrideFold = false;
  ship._flowerBandDropped = true;                                 // one-shot for ThermalSystem: its auto-open asks again
  ship._bandWaitS = 0;
  ship._bandSaid = false;
  return th0;
}

export class PlayerSatellite extends THREE.Group {
  constructor(scene) {
    super();
    this.name = 'PlayerSatellite';

    // ORBITAL STATE (Keplerian elements; semiMajorAxis in scene units)
    this.orbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE,
      eccentricity: 0.0001,
      inclination: degToRad(51.6),
      raan: 0,
      argPerigee: 0,
      trueAnomaly: 0,
      meanMotion: 0,
    };

    this._cartesian = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };

    this.resources = {
      xenon: startEnginePool(Constants.DEFAULT_FUEL, Constants.XENON_FUEL_MAX),     // starts 60 % (START_GAS_KG of the tank gas)
      tankGasId: Constants.DEFAULT_FUEL,   // the gas the `xenon` pool holds (kept name = pool)
      coldGas: Constants.COLD_GAS_MAX * (Constants.PROPELLANT_START_FRACTION ?? 1),
      battery: Constants.BATTERY_MAX * (Constants.BATTERY_START_FRACTION ?? 1),   // starts at half
      solarRate: 0,
      solarPanelHealth: 1.0,
      // Body-mount cells are backup power with their OWN health, separate from the wings (DECISIONS §10): collision/impact
      // damage (ResourceSystem.damageSolarPanel) and passive wear (EnvironmentSystem AO erosion) hit `solarPanelHealth`
      // (the wings/ROSA); nothing degrades `bodyPanelHealth` today, so the body cells keep working when the wings are
      // damaged, furled or edge-on. Synced from ResourceSystem (_syncToPlayer).
      bodyPanelHealth: 1.0,
      // Shop solarEfficiency multiplier (ResourceSystem.applyUpgrade), synced here so _updateSolarPower's per-panel calc
      // responds to it.
      solarEfficiencyMult: 1.0,
      lithium: 0,
      lithiumMax: Constants.MPD_LITHIUM_CAPACITY,
    };

    this._hasMPD = false;           // unlocked via shop purchase
    this._mpdCathodeTime = 0;       // cumulative seconds of MPD firing
    this._mpdCathodeLife = Constants.MPD_CATHODE_LIFE || 600; // upgradable via Hardened Cathode

    this._mpdArmed = false;           // M key toggle
    this._mpdHeat = 0;                // thermal accumulator (0 to MPD_BURST_OVERHEAT_THRESHOLD)
    this._mpdCooldownTimer = 0;       // seconds remaining in forced cooldown (0 = ready)
    this._mpdDegraded = false;        // true when battery < 5% during burst
    this._hasSupercap = false;        // set by Graphene Supercap upgrade

    // Consumption rates. The engine-gas flow follows thrust and Isp (ṁ = c·m·Δv/(Isp·g0), see ionGasUnits).
    // `_ionThrustXenonRate` / `_baseIonXenonRate` survive only as the CARRIER of the paid "Efficient Ion Drive"
    // multiplier (rate/base = 0.8 after the upgrade; read by fittingCatalog `efficient_ion`); 0.02 is not a flow.
    this._ionThrustXenonRate = 0.02;
    this._ionThrustPowerRate = 5.0;
    // The frame the 0.3 m/s per-tick proxy was written for; a continuous burn is billed per second against it.
    this._ionBillTickS = 1 / 60;
    this._coldGasRate = Constants.ATTITUDE.COLD_GAS_BASE_RATE;
    this._basePowerDraw = 0.5;
    this._ionDeltaV = 0.0003;

    // Base values for upgrade multipliers (the live burn path reads the rate properties directly)
    this._baseIonDeltaV = this._ionDeltaV;
    this._baseIonXenonRate = this._ionThrustXenonRate;
    this._baseColdGasRate = this._coldGasRate;

    // Ion-drive multiplier factors, kept separate so upgrades compose without clobbering each other on the save-restore
    // path. _ionDeltaV is always base × thrustMult × mpdPassiveMult via _recomputeIonDeltaV().
    this._thrustMult = 1;        // Ion Booster (thrustMultiplier effect)
    this._mpdPassiveMult = 1;    // MPD Thruster passive drive gain (mpdThruster effect)

    this.thrustInput = { x: 0, y: 0, z: 0 };
    this._lastThrustOfflineWarning = 0; // Throttle for power-offline comms warnings
    this._lastFlowerInhibitWarning = 0; // Throttle for the folded-radiator FEEP-inhibit caution

    // RCS fine-positioning velocity (additive to orbital motion)
    this._rcsVelocity = new THREE.Vector3();

    // Cosmetic launch-recoil offset (scene units), applied to the rendered hull position each frame and decayed to zero by
    // a critically-damped spring. VISUAL ONLY: it does NOT feed the orbit, fuel or _rcsVelocity, and is re-derived from
    // orbit each frame so it never accumulates. ≤ LASSO_RECOIL_KICK_M (~1.2 m): a subtle shudder at ship scale,
    // negligible at orbital scale.
    this._recoilOffset = new THREE.Vector3();

    // Thrust direction tracking & cumulative ΔV
    this._deltaVSpent = 0;         // cumulative ΔV spent this mission (km/s game units)
    this._thrustDirection = null;   // 'prograde' | 'retrograde' | 'lateral' | null
    this._lastThrustType = null;    // 'ion' | 'coldgas' | null

    // Throttle level (0..1)
    this.throttleLevel = 1.0;

    // Manual rotation offset (applied on top of velocity-aligned orientation)
    this._manualRotation = new THREE.Quaternion(); // identity = no offset
    // The heading the tether rotation limit is measured from. Latched (as an offset from prograde,
    // like _manualRotation) when the aim hold hands the attitude back to the player; cleared when no daughter is out
    // (setAttitudeConstraintTier('none')). Without it the limit is measured from prograde. See _tetherRefAngles.
    this._tetherLatch = new THREE.Quaternion();
    this._tetherLatchOn = false;

    // Rigid-body attitude. _rcsOmega: body-frame angular velocity (rad/s), x pitch, y yaw, z roll (recoil/parasitic
    // torques can roll the hull; the hold nulls it, no player roll input). _attitudeCmd: latched per-frame rate command
    // (−1..1) from commandAttitude, read by _tickAttitudeDynamics, cleared when nothing commands attitude.
    this._rcsOmega = new THREE.Vector3();
    this._attitudeCmd = null;
    // Sloth mode (owner 2026-10-23): the tail ion boxes turn her when the steering gas is out. Warm state is NOT saved:
    // after a load the cathodes warm again. `_slothLitS[i]` = full-output seconds box i was lit since the last frame-end bill
    // (order = Constants.THRUSTERS = the mainThrusters meshes); `_slothGlow[i]` = this frame's lit fraction for the glow.
    this._slothWarm = false;
    this._slothWarming = false;
    this._slothWarmS = 0;
    this._slothWasOn = false;
    this._slothLitS = [0, 0, 0, 0];
    this._slothGlow = [0, 0, 0, 0];
    // Ion start-up (trip burn): the level (0..1) the trip sets DIRECTLY on each tail box while the engines light
    // (a flicker the glow lerp would smooth away), or null when the glow follows its normal targets. Order as `_slothGlow`.
    this._ionStartGlow = null;
    this._slothBox = null;
    this._capP = 1;
    this._capY = 1;
    this._capMsgOn = false;
    this._gasSpin = false;   // sloth mode: the current spin was made by the cold gas, so the gas stops it (see attitudeTorqueSource)
    // Reaction-wheel kit (Constants.WHEELS, DECISIONS §2 row 9). `_wheelH` = the wheels' stored spin, ship frame, N·m·s: what the
    // ship's own turns borrowed from the wheels and kicks / the coils changed; a rest-to-rest wheel turn leaves it where it was.
    this._wheelKit = false;          // the kit is aboard (bought; the save-restore replay re-applies it)
    this._wheelH = new THREE.Vector3();
    this._wheelSpin = false;         // the current spin was made by the wheels, so the wheels stop it (the gas twin is `_gasSpin`)
    this._wheelUse = { x: 0, y: 0, z: 0 };   // this frame's full-torque seconds per axis (the power bill, `_wheelFrameEnd`)
    this._wheelWorldDt = 0;          // the frame's world seconds (`update`): the coils work on the world clock
    this._wheelUnload = { x: false, y: false };   // the tail boxes are unloading this axis (steering gas empty, the wheels full)
    this._wheelMsg = { full: false, power: false, top: false };   // the "wheels full" / "no power" lines say themselves once per event; "top speed" once per held key
    this._wheelPf = 0;               // the frame's power peek (0..1), `_slFrameBegin`
    this._slowTurnProbe = null;      // () => boolean: the autopilot's slow turn / aim / scripted turn is running (set by `setSlowTurnProbe`)
    this._unloadLitS = 0;            // this frame's box seconds lit by the wheel unload (they are not a turn: no sloth line, `_slothFrameEnd`)
    this._slothSayPending = false;   // the kit is aboard: the "steering gas empty" line waits until the boxes really are the source
    this._inertiaKit = false;        // the kit flag the cached inertia was computed with (the cache follows the kit)
    // A refused mother-net shot / lasso cast leaves the ship pointed where the aim turned it: no
    // recenter toward prograde until the next deliberate attitude change. See holdHeadingAfterRefusal.
    this._recenterPaused = false;

    // Autopilot flag: suppresses orientation decay when autopilot is steering
    this.autopilotEngaged = false;

    // The transfer trip's attitude hold keeps the heading in the ORBIT frame (quaternion = prograde ·
    // _manualRotation, recomposed every frame from the exact prograde) while the autopilot owns the nose, so it
    // tracks prograde at any world rate. See setOrbitFrameHold / easeOrbitFrameOffset.
    this._orbitFrameHold = false;

    // While an aim sequence is slewing attitude the coroutine writes this.quaternion directly (like autopilot):
    // suppresses the prograde auto-orient slerp so it doesn't drag the nose off the aim solution.
    this.aimHold = false;

    // Fuel system references
    /** @type {import('../systems/ResourceSystem.js').ResourceSystem|null} */
    this._resourceSystem = null;
    /** @type {import('../systems/CargoSystem.js').CargoSystem|null} */
    this._cargoSystem = null;

    this._lidarPulseTimer = 0;

    // ROSA furl/unfurl (Comma key): 1 = unfurled (deployed), 0 = furled. _rosaManualControl latches once the
    // player toggles, so the opening dance hands the panels to the player at hand-over.
    this._rosaFurlTarget = 1.0;
    this._rosaFurlProgress = 1.0;
    this._rosaManualControl = false;
    // ROSA feather (Shift+Comma): 0 = sun-tracking (normal), 1 = feathered (parked edge-on to a hazard). Acts only on
    // a deployed wing: furl takes precedence (a furled wing is frozen). Feathering cuts the ROSA power share via the
    // edge-on incidence angle (see _updateSolarPower), NOT a separate multiplier like furl uses.
    this._rosaFeatherTarget = 0.0;
    this._rosaFeatherProgress = 0.0;
    // ROSA power-flow glow: a running clock for the idle "breathing" shimmer plus an optional idle floor (the menu hero
    // sets it so the wings glow without the power subsystem driving solarRate). See _animateRosaGlow.
    this._rosaGlowClock = 0;
    this._rosaGlowIdleFloor = 0;
    this._thrusterGlowTargets = new Map(); // thruster mesh → { glow, plume, outerGlow, intensity }
    this._activeThrustDir = { x: 0, y: 0, z: 0 };

    // AFT FLOWER (thermal). Purchase-gated: pairs land via the shop (flower_pair_a/b) → applyUpgrade.
    // ONE pose for all four struts (deploy/stow in unison). θ from +Z, α_aft = 180° − θ.
    this._flowerPairs = { A: false, B: false };
    /** @type {Array<{hinge: THREE.Group, azDeg: number, pair: string, wings: THREE.Group[]}>} */
    this._flowerGroups = [];
    // Boot at the orbit REST pose: CLOSED (θ 0°, folded flat along the body), DECISIONS §15 row 4.
    this._flowerThetaRad = degToRad(this._flowerRestDeg());
    /** Slew latch (mirrors the daughter `_strutTargetAlpha` contract): player intent wins mid-swing (a new toggle
     *  overwrites an in-flight target), bounded rate, never a snap, cleared on arrival. */
    this._flowerTargetTheta = undefined;
    /** Owner 2026-10-19, DECISIONS §29 rows 6-7: the radiators share ONE angle (`_flowerThetaRad`, the player's),
     *  except a petal held for a catch hand-off or a daughter's carry: it slews on its own (SLEW_RATE_RAD_S) to the hold angle
     *  and, once released, back to the shared angle, then it is free again (and follows the shared angle). Keyed by the tip's
     *  azimuth (`THERMAL.FLOWER.AZIMUTHS_DEG`: 40, 140, 220, 320); at most one record per fitted petal.
     *  `petalThetaRad(az)` is DERIVED from this list and the shared angle: nothing stores a free petal's angle.
     *  @type {Array<{az:number, thetaRad:number, targetRad:number, releasing:boolean}>} */
    this._petalHolds = [];
    /** VENT push-through state (owner ask 2026-09-16). `_flowerVentArmed` lifts the driver's ladder ceiling from the
     *  bud (POSE_STOW_DEG) to POSE_VENT_DEG; `_lastFlowerTap` timestamps the last O press, so a second one inside
     *  VENT_DOUBLE_TAP_MS that lands on the bud is read as "push through the wall". Both clear on any ordinary pose
     *  command and on every reset path: the vent is never a resting default. */
    this._flowerVentArmed = false;
    this._lastFlowerTap = undefined;
    /** Whether the LAST toggleFlowerDeploy was a double tap that pushed through (to 180°, or past closed into the
     *  launch fold) and so narrated itself; the O handler reads it to skip its plain line. A flag, not
     *  `_lastFlowerTap === undefined`: the timer is cleared on every double tap. */
    this._flowerPushedThrough = false;
    /** Settle clock (DECISIONS §15, owner 2026-10-09): `_flowerClockS` is real seconds advanced by
     *  `_updateFlower(dt)`; `_flowerCmdClockS` is its value at the last PLAYER radiator command (toggleFlowerDeploy,
     *  toggleFlowerOverride, setFlowerPose). A radiator pushed past OPEN_DEG (the 180° vent) settles back to OPEN_DEG
     *  once RETURN_TO_OPEN_S have passed since that stamp (`settleFlowerToOpen`). Non-player callers of setFlowerPose
     *  stamp it too: harmless, they never run above 146°. */
    this._flowerClockS = 0;
    this._flowerCmdClockS = 0;
    /** One-shot launch lock: while armed the driver floor is POSE_LAUNCH_DEG (0°) instead of POSE_FLOOR_DEG (CLOSED,
     *  also 0°; DECISIONS §15 row 4) and thrust is refused. Armed ONLY by setFlowerPose('LAUNCH') under an active
     *  launch driver, by the dev hook's { force: true }, or (owner amendment 2026-09-09) by the SAFETY OVERRIDE
     *  actuator path's { override: true } (toggleFlowerOverride, the full-range sweep the player watches); cleared by
     *  the driver the frame a release swing (any orbit target) carries θ up to the floor. Never re-armable from REFIT /
     *  autopilot (they only ever pass CLOSED / STOW / PARK / CARGO); plain O reaches it only through the double-tap
     *  fold past CLOSED, which IS the override arming (toggleFlowerDeploy). */
    this._flowerLaunchLock = false;
    /** DECISIONS §10/§11: an OVERRIDE fold is in flight: the wing DODGE takes its tightest limit
     *  (WING_DODGE_LOW_LIMIT_DEG) from the moment this is set, so the wings clear the fold corridor before the radiator
     *  gets there and the driver never waits for them (the tilt law clamps itself through `_rosaDodgeLimitRad`;
     *  sun-track and feather both yield). The driver floor does not wait for the STRUTS either (§11: a new player
     *  can't read a halfway-stop interlock): a double-tap folds straight through at any strut angle. Set by
     *  setFlowerPose's override branch, cleared with the lock. Scoped to the OVERRIDE arming: the ?shot=1 dev force is
     *  byte-identical (its own procedure furls ROSA). */
    this._flowerOverrideFold = false;

    // Tether reel states: 'ready', 'deployed', 'empty'
    this._tetherStates = Array(V5_ARM_COUNT).fill('ready');
    this._tetherDeployAnim = Array(V5_ARM_COUNT).fill(0); // 0..1 spool animation

    this._rcsPuffs = [];          // Array of { sprite, startTime, active }
    this._rcsPuffIndex = 0;       // Round-robin pool index
    this._rcsPuffLastFire = {};   // Per-nozzle cooldown timestamps (seconds)

    // Eclipse cache: _updateSolarPower caches the shadow flag here every frame so puff/plume dimming can read it.
    // False by default so headless/Node builds (no update; _updateSolarPower early-returns on null sunDirection)
    // treat the craft as sunlit.
    this._inShadow = false;

    // Sun-scatter cache: camera world pos (set from main.js each frame) and the sun direction (cached in update).
    // Both null → scatter = 1 (headless / null-sun frames stay scatter-free).
    this._camWorldPos = null;
    this._sunDirWorld = null;

    // Detail-LOD cull set: inert mm-scale hardware hidden when the camera is far. Populated by
    // _collectDetailMeshes() after _buildModel; toggled only on threshold crossing by setCameraDistance().
    this._detailMeshes = [];
    this._detailHidden = false;

    this._edtDeployed = false;
    this._edtDeployTimer = 0;
    this._edtActive = false;

    eventBus.on(Events.EDT_DEPLOY, () => this.toggleEDT());

    // kg — mothership mass for recoil calculations AND the drag denominator below (update() "Atmospheric drag").
    // `mass` is an ACCESSOR (see `get mass()` below): her live wet mass from the ArmManager budget,
    // Constants.MOTHER_DRAG.MASS_KG (294.28, her start mass) when there is no arm manager. The constructor must NOT
    // assign `this.mass`: that would set the explicit override (a test-rig facility), not the start value.
    this._massOverride = null;
    // The area and mass her last drag step used (null above the air / before the first step): the welcome pieces share them.
    this.lastDragAreaM2 = null;
    this.lastDragMassKg = null;
    this.armManager = null;         // Set via setArmManager() for interlock checks
    this._thrusterInterlock = false; // True when back arm blocks FEEP thruster exhaust
    // Attitude-dynamics inertia SSOT: lazily computed from the mass tree, cached, never per frame; null = needs
    // (re)compute. Invalidated on arm-state/berth changes plus the cargo-ledger direct invalidations (lasso adoption
    // entry, collar digestion completion exit — CaptureNet.js; [K] jettison from BERTHED/COLLARED and the daughter
    // rack's sequential-digestion feed-end; the mission-reset rack clear — ArmManager.reset()).
    this._attitudeInertia = null;
    /** The radiator inputs the cache was computed from (`getAttitudeInertia`); null = none recorded yet. */
    this._radiatorKey = null;
    /** The strut angles the cache was computed from (`getAttitudeInertia`); null = none recorded yet. */
    this._strutKey = null;
    const _invalidateInertia = () => { this._attitudeInertia = null; };
    eventBus.on(Events.ARM_STATE_CHANGE, _invalidateInertia);
    eventBus.on(Events.NET_BERTHED, _invalidateInertia);
    this._crossbowAutoRcs = true;   // Auto-compensate crossbow recoil with RCS
    this._frameRecoilDv = 0;        // Accumulated recoil ΔV this frame (for dual-fire tracking)
    this._frameRecoilCount = 0;     // Number of crossbow fires this frame
    this._frameN2Consumed = 0;      // Actual N₂ consumed (kg) this frame for refund on dual-fire
    // Mother-net recoil: a whale-net launch is a real momentum event. `_recoilPitchAngle` is the integrated transient
    // hull pitch (rad) from the OFF-AXIS muzzle lever arm; RCS springs it back to 0 (attitude hold). The muzzle sits
    // 0.25 m below the CoM (packaging around the sensor turret), so an uncompensated shot pitches the ship and bills
    // the correction in cold-gas N₂. A centred muzzle would produce zero torque.
    this._recoilPitchAngle = 0;
    this._recoilPitchVel = 0;                 // mother-net pitch rate (rad/s)
    // Angular recoil perturbs a REAL transient yaw: these drive the visible yaw and settle it (ζ≈1, ~2 s).
    this._recoilYawAngle = 0;
    this._recoilYawVel = 0;
    // owner 2026-10-25 ("careful planning ... pairs"): the angular kicks of ONE frame (a launch, a latch bump, each reel's
    // pull) are summed here and handed to the wheels and the gas once, at the frame's end (`_flushKicks`), so two daughters
    // that push opposite ways in the same frame cancel instead of being billed one after the other.
    this._kickLx = 0;
    this._kickLy = 0;
    // The gas the reel line's push has cost her (kg): holding against it under the autopilot HOLD, and nulling its turn;
    // and when her cold-gas puffs last fired for it (performance.now seconds).
    this._reelPushHoldKg = 0;
    this._reelPushTurnKg = 0;
    this._reelPushWheelNms = 0;               // N·m·s of kicks the wheels took (|taken| summed; a diagnostic, read by tests and probes)
    this._reelPushPuffAt = -Infinity;
    this._reelPushTurnPuffAt = -Infinity;
    this._qRecoil = new THREE.Quaternion();   // scratch: transient recoil rotation
    // The recoil shake is a transient overlay on the commanded attitude. Under an owner that does not
    // rebuild the quaternion each frame (AIM; AUTOPILOT without the orbit-frame hold) the overlay would pile up, so the
    // rotation last multiplied in is kept here (`_recoilApplied`) and taken off again before the next frame's goes on.
    this._recoilApplied = false;
    this._qRecoilApplied = new THREE.Quaternion();   // the overlay now sitting on this.quaternion (valid while _recoilApplied)
    this._qRecoilUndo = new THREE.Quaternion();      // scratch: its inverse
    this._vRecoilPitchAxis = new THREE.Vector3(1, 0, 0); // ship-local pitch axis (+X)
    this._vRecoilYawAxis = new THREE.Vector3(0, 1, 0);   // ship-local yaw axis (+Y)

    eventBus.on(Events.CROSSBOW_FIRE, (data) => this._applyCrossbowRecoil(data));
    eventBus.on(Events.DUAL_FIRE_RECOIL, (data) => this._applyDualFireRecoil(data));
    // Mother whale-net launch → real linear + angular recoil (source-filtered).
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.source === 'mother') {
        this._applyMotherNetRecoil(data);
        // Muzzle FX hangs off NET_FIRED, which is NOT flag-gated, so it fires in REALITY_MODE too, whereas the brake FX
        // below runs only when FEATURE_FLAGS.NET_CEREMONY is on (NET_BRAKE_FIRED is gated at its emit site, CaptureNet.js).
        // Accepted, not a bug: cosmetic FX, nothing load-bearing behind the flag (§6 not breached).
        this._fireNetMuzzleFx(data.podIndex ?? 0);
      }
    });
    // 4 radial retro puffs at the tether-brake moment (the cinch-path deceleration: the net fires its rim-weight retros
    // inward, toward the cone axis, to shed closing velocity). Puffs sit at the net's live position (the contact point),
    // NOT at the muzzle: the brake happens at the target, metres to tens of metres downrange. NET_BRAKE_FIRED is
    // emitted only under FEATURE_FLAGS.NET_CEREMONY (CaptureNet.js), so these are silent in REALITY_MODE while the
    // muzzle puff above is not; cosmetic-only asymmetry (see the NET_FIRED note above).
    eventBus.on(Events.NET_BRAKE_FIRED, (data) => {
      if (data && data.podIndex >= 0) this._fireNetBrakeFx(data.podIndex);
    });

    // Scan visual feedback — emissive flash on body material
    this._scanFlashTimer = 0;
    eventBus.on(Events.SCAN_INITIATED, () => {
      this._scanFlashTimer = 0.5; // 0.5s flash duration
    });

    // Diagnostic hull outline, visible during close inspection. Two INDEPENDENT inputs are OR'd (the outline is on if
    // EITHER reports inspection), each with its own boolean so they can't desync or flip-flop:
    //   (1) the discrete INSPECTION camera view (bare-I / debris / arm path) via CAMERA_VIEW_CHANGE, and
    //   (2) the OVERVIEW zoom-driven mothership inspection sub-state, which keeps the view as ORBIT and signals via
    //       INSPECT_HULL_OUTLINE.
    // Separate flags: a CAMERA_VIEW_CHANGE to ORBIT during the zoom path must not clobber the zoom signal (flicker).
    //
    // SECOND CONSUMER: `_orientAlongVelocity()` also reads these two flags (OR'd) to suspend the prograde auto-orient
    // during close inspection so the hull holds still for the player. Keep both flags reset on inspection exit or the
    // ship stays frozen — don't fold this into the outline plumbing.
    this._hullInspectView = false; // discrete INSPECTION view active?
    this._hullInspectZoom = false; // OVERVIEW zoom sub-state active?
    eventBus.on(Events.CAMERA_VIEW_CHANGE, ({ view } = {}) => {
      this._hullInspectView = (view === 'INSPECTION');
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });
    eventBus.on(Events.INSPECT_HULL_OUTLINE, ({ visible } = {}) => {
      this._hullInspectZoom = !!visible;
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });

    this._buildModel();

    this._updateCartesian();
    this._applyPosition();

    scene.add(this);
  }

  /**
   * Thin PV panel BOX. The outward +z face carries the GaAs cell material; the four side walls + inner (−z) face carry
   * the dark mounting-rail material (`_matPanelRail`) — the 10 mm side walls ARE the mounting rail that covers the
   * flat-facet-over-curved-hull corner air gap, so no separate frame decal is needed. BoxGeometry material array order
   * is [+x, −x, +y, −y, +z, −z]; index 4 (+z) is the cell face, with standard 0..1 UVs so the cell texture's `repeat`
   * is unchanged. The caller positions it so the +z face lands at the visual radius (1.014R), back buried at 1.004R.
   * @param {number} w   panel width (local X)
   * @param {number} h   panel height (local Y)
   * @param {number} thick  panel thickness (local Z)
   * @returns {THREE.Mesh}
   */
  _makePanelBox(w, h, thick, cellMat) {
    const geo = new THREE.BoxGeometry(w, h, thick);   // keeps geo.parameters (area scan reads width/height)
    // Re-group the index buffer: the five rail faces (+x, -x, +y, -y, -z) become ONE group (material 0) and the +z
    // cell face is group 1: 2 draws per panel instead of 6. BoxGeometry emits 6 indices per face in the order
    // [+x, -x, +y, -y, +z, -z].
    const src = Array.from(geo.index.array);
    const face = (f) => src.slice(f * 6, f * 6 + 6);
    const idx = [...face(0), ...face(1), ...face(2), ...face(3), ...face(5), ...face(4)];
    geo.setIndex(idx);
    geo.clearGroups();
    geo.addGroup(0, 30, 0);    // rail
    geo.addGroup(30, 6, 1);    // outward cell face
    // Material order [rail, outward cell, edge trim]; the trim group is appended by _addPanelTrim once the neighbour
    // layout is known (_buildMainBus).
    return new THREE.Mesh(geo, [this._matPanelRail, cellMat, this._matPanelTrim]);
  }

  /**
   * Thin EDGE TRIM on a body PV panel so it doesn't look stuck on the blanket (real body-mounted cells are retained by
   * edge tape or a frame lapping the cell edge): 8 mm-wide, 2 mm-thick strips INSIDE the panel's own footprint (x/y
   * extent unchanged, so clearances to hardware are unchanged), sitting ON TOP of the cell face (z from depth/2 to
   * depth/2 + 2 mm) so no strip face is coplanar with a dark rail face (z-fight). The strips are appended to the PANEL'S
   * OWN geometry as a third draw group (no new mesh: the mother-callouts pick index and mesh-count pins are untouched,
   * and the power/area scan still reads geometry.parameters).
   * @param {{lo:boolean, hi:boolean}} sides  true = add the side strip on that side (local -x / +x). The two short ends
   *   (y = +-h/2) are always trimmed.
   */
  _addPanelTrim(mesh, sides) {
    const geo = mesh.geometry;
    const { width: w, height: h, depth: thick } = geo.parameters;
    const TW = M * 0.008, TT = M * 0.002;
    const strips = [
      [0,  h / 2 - TW / 2, w, TW],
      [0, -h / 2 + TW / 2, w, TW],
    ];
    if (sides.hi) strips.push([ w / 2 - TW / 2, 0, TW, h - 2 * TW]);
    if (sides.lo) strips.push([-w / 2 + TW / 2, 0, TW, h - 2 * TW]);
    const pos = Array.from(geo.attributes.position.array);
    const nor = Array.from(geo.attributes.normal.array);
    const uv = Array.from(geo.attributes.uv.array);
    const idx = Array.from(geo.index.array);
    const start = idx.length;
    for (const [cx, cy, sx, sy] of strips) {
      const box = new THREE.BoxGeometry(sx, sy, TT);
      box.translate(cx, cy, thick / 2 + TT / 2); // sits on the cell face: top 2 mm proud
      const base = pos.length / 3;
      pos.push(...box.attributes.position.array);
      nor.push(...box.attributes.normal.array);
      uv.push(...box.attributes.uv.array);
      for (const i of box.index.array) idx.push(i + base);
      box.dispose();
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.addGroup(start, idx.length - start, 2);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  }

  /**
   * Apply the synthetic orbital environment map to the gold MLI foil materials. Foil is a near-mirror: its contrast is
   * the reflected environment × normal variation, so under the scene's near-uniform RoomEnvironment the gold reads as a
   * smooth brass pipe however much crumple detail the normal map carries. A per-MATERIAL orbital envMap (sun + void +
   * Earth) on ONLY these materials makes it read as broken white/dark foil patchwork; scene.environment stays
   * RoomEnvironment for everything else.
   *
   * Call once after construction, from the owning scene, passing its renderer. Safe to call again (re-fetches the
   * cached env). Headless-safe: with no renderer getOrbitalFoilEnv returns null and this no-ops.
   *
   * NOTE: a per-material envMap ignores scene.environmentIntensity; brightness is retuned via
   * material.envMapIntensity here (default 1.0, useful 0.5–2).
   *
   * @param {number} [intensity=1.0] - envMapIntensity for the foil materials.
   * @returns {boolean} true if an env map was applied, false if it no-op'd.
   */
  applyFoilEnv(renderer, intensity = 1.0) {
    const env = getOrbitalFoilEnv(renderer);
    if (!env || !this._foilMats) return false;
    for (const mat of this._foilMats) {
      if (!mat) continue;
      mat.envMap = env;
      mat.envMapIntensity = intensity;
      mat.needsUpdate = true;
    }
    return true;
  }

  _buildModel() {
    // Gold MLI foil materials (master + clones) are collected here so applyFoilEnv() can set the orbital env-map on all
    // of them in one pass. Foil is a near-mirror, so its look is the reflected environment; a per-material envMap on
    // just these (not scene.environment) is what makes it read as broken foil. See orbitalFoilEnv.js.
    this._foilMats = [];
    // MLI foil maps: albedo (neutral grey) + normal + one rough/metal PNG (G = roughness, B = 255 = all metal; the same
    // texture feeds roughnessMap and metalnessMap). Null in headless/no-DOM. They are BAKED static PNGs
    // (textures/mli_foil_v8_*.png) from the generator in mliFoilTexture.js (re-run `node scripts/bake-foil-maps.mjs`
    // after knob tweaks, and take a NEW file name — textures/ is cache-first in the service worker). ONE crinkled
    // gold-mylar sheet draped over the barrel (owner 2026-10-14: it matches the gold mylar foil on the scale model):
    // long sharp fold ridges, fans, gated micro-crumple; no panels, tape or buttons. The barrel gets a SINGLE un-tiled
    // wrap [1,1] (u=1 is an integer wrap, so the cylinder UV is seamless; a fractional u would put a hard seam down the
    // barrel). The IR box uses `variant:'flat'` — a taut, calmer sheet. See mliFoilTexture.js.
    const bodyFoil = getMLIFoilMaps({ repeat: [1, 1] });
    // _matBody is assigned in _buildMainBus as a clone of _matGoldMLI.
    // MLI foil: LEMON-gold crinkled mylar. The look constants live in MLI_FOIL_LOOK so the scan-flash restore reads the
    // SAME values. The colour is the MATERIAL colour (the albedo map is neutral grey); metalness 1.0 x the map's B
    // channel (255); roughness 0.50 x the map's G channel (crumpled 0.30-0.70 => effective 0.15-0.35: sharp crinkle
    // glints).
    this._matGoldMLI = new THREE.MeshStandardMaterial({
      color: MLI_FOIL_LOOK.materialColor,   // lemon gold; the albedo map is neutral grey
      metalness: MLI_FOIL_LOOK.metalness, roughness: MLI_FOIL_LOOK.roughness,
      emissive: MLI_FOIL_LOOK.emissive, emissiveIntensity: MLI_FOIL_LOOK.emissiveIntensity,
    });
    // Apply the maps. The body skin (_matBody) and the IR box are clones, so they inherit them; scan-flash mutates
    // emissive/emissiveIntensity only (the emissiveMap carries the crease pattern into the shadow side).
    if (bodyFoil) {
      this._matGoldMLI.map = bodyFoil.albedoMap;
      this._matGoldMLI.normalMap = bodyFoil.normalMap;
      this._matGoldMLI.normalScale = new THREE.Vector2(1.0, 1.0);
      this._matGoldMLI.roughnessMap = bodyFoil.roughnessMap;
      this._matGoldMLI.metalnessMap = bodyFoil.metalnessMap;
      this._matGoldMLI.emissiveMap = bodyFoil.albedoMap;
    }
    // Register the master gold material for the orbital envMap pass. The _matBody / aperture-ring / IR-box clones are
    // registered at their clone sites: envMap is set AFTER construction via applyFoilEnv, so each clone must be tracked.
    this._foilMats.push(this._matGoldMLI);
    this._matDark = new THREE.MeshStandardMaterial({
      color: 0x222233, metalness: 0.6, roughness: 0.4,
    });
    // PV panel mounting-rail material: dark satin metal on the side walls + inner face of the thin PV boxes. The 10 mm
    // box side walls ARE the mounting rail (they cover the ~6.7 mm corner air gap of a flat facet panel over the curved
    // hull): solid, depth-writing, single-sided (FrontSide), no polygon offset or decal render-order tricks.
    this._matPanelRail = new THREE.MeshStandardMaterial({
      color: 0x1a1a22, metalness: 0.55, roughness: 0.5,
      side: THREE.FrontSide,
    });
    // FEEP nozzle material: copper/bronze tint (field-emission emitters use refractory metals)
    this._matFEEP = new THREE.MeshStandardMaterial({
      color: 0x996644, metalness: 0.80, roughness: 0.35,
    });
    // FEEP nozzle interior: bright emissive ion-emitter surface (BackSide), distinct from the copper exterior;
    // emissive follows the engine push (trip burn), never a turn
    this._matFEEPInner = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.5, roughness: 0.2,
      emissive: 0x334466, emissiveIntensity: 0.3,
      side: THREE.BackSide,
    });
    // RCS nozzles, standard aerospace gray. DoubleSide so the interior bell wall renders looking straight down the mouth
    // (otherwise the back faces cull and you see through the wall past the inset liner).
    this._matRCS = new THREE.MeshStandardMaterial({
      color: 0x555566, metalness: 0.65, roughness: 0.45, side: THREE.DoubleSide,
    });

    this._buildMainBus();
    this._buildCollar();
    this._buildStruts();

    // 4 main dual-metal FEEP + 4 RCS doghouse quad pods
    this._buildThrusters();

    // Mid-ring: the strong point wing hardware mounts to (DECISIONS §10 "one motor box bolted to a strong part of the body")
    this._buildMidRing();
    this._buildSolarPanels();
    this._buildSensors();

    // Tether reels + indicators are populated by _buildStruts(). Deliberately no fore docking port: nothing docks with
    // the mother; capture/berthing is handled by the arms.

    // Large net launcher: fore-end hardware for the Mother's whale-class capture net ([N] fire). ONE housing on the long
    // axis, inside the collar bore (owner 2026-10-13: one, centred), with a 2×2 magazine window whose caps show
    // loaded/spent nets. It stands on the sensor turntable; no saddle.
    this._buildNetPods();

    // Nose berthing collar (owner ruling 2026-08-14): whale-class cargo mates rigidly, on-axis, at this ring. The one
    // launcher stands inside the bore and fires THROUGH it (owner 2026-10-13), so a catch held at the collar blocks the
    // shot (getCollarShotFoul).
    this._buildBerthCollar();

    this._buildNavLights();

    // Avionics: star trackers, TT&C omnis + MGA patch, sun sensors, GPS patches.
    this._buildAvionics();

    this._buildRcsPuffPool();

    this._collectDetailMeshes();
  }

  /**
   * Gather inert, mm-scale hardware into `_detailMeshes` for the distance LOD cull. Selected by NAME so the set is
   * auditable in one place and can never accidentally include a gameplay-communicative mesh (nav/strobe/dock lights,
   * reel LEDs, plumes, tethers are additive/connector meshes with different names and are deliberately excluded).
   * Structural silhouette pieces (hull, struts, caps, collar ring, joint collars, sensor deck, docking ring) are NOT
   * listed: only sub-pixel-at-distance detail.
   */
  _collectDetailMeshes() {
    // FEEP_Boss_/FEEP_GridDisc_ are uniquely named per bell (FEEP_Boss_0..3), so they match by PREFIX. The four
    // r 0.03 BerthCollarFoot_ pads are sub-pixel past 30 m (60 mm ≈ 1 px at 1280 px / FOV 35); the ring and its
    // struts are nose silhouette and stay.
    const CULL_PREFIXES = [
      'PyroPin_', 'PClip_', 'CClip_', 'CableHarness_', 'SpringHousing_', 'SpringCoil_',
      'GuideRail_', 'RibRing_', 'FEEPInner_', 'FEEP_Boss_', 'FEEP_GridDisc_',
      'MountBolt_', 'Bushing_', 'BerthCollarFoot_', 'LaserSpider',
      // radiator fold-line hinges (Ø20 mm barrels — sub-pixel past ~30 m)
      'FlowerStrutHingeLug_',
    ];
    const CULL_EXACT = new Set(['AccentRing']);
    this._detailMeshes.length = 0;
    this.traverse((o) => {
      if (!(o.isMesh || o.isLine) || !o.name) return;   // isLine covers CableHarness lines
      if (CULL_EXACT.has(o.name) || CULL_PREFIXES.some((p) => o.name.startsWith(p))) {
        this._detailMeshes.push(o);
      }
    });
  }

  /**
   * Feed the live camera→craft distance (SCENE UNITS), once per frame from main.js. The flip is applied only when a
   * hysteresis threshold is CROSSED, never per frame, so it does not fight systems that own `visible` on other meshes.
   */
  setCameraDistance(distSceneUnits) {
    this._detailHidden = applyDetailLod(distSceneUnits, this._detailMeshes, this._detailHidden);
  }

  /**
   * Single source of truth for stow-groove angular half-widths. The pocket arc spans ~1.3× the daughter body width
   * (capped at 0.45 rad); the shallower stow channel the folded strut lies in is 0.55× the pocket half-width. Both the
   * groove carve (`_carveStowGrooves`/`profileFor`) and the pyro-pin lip placement consume this so the two can never
   * drift apart.
   * @param {number} crossW    daughter body cross-section width (m)
   * @param {number} barrelR_m barrel radius (m)
   * @returns {{ pocketHa: number, chanHa: number }} angular half-widths (rad)
   */
  _stowGrooveHalfWidths(crossW, barrelR_m) {
    const pocketHa = Math.min(0.45, (1.3 * crossW) / (2 * barrelR_m));
    return { pocketHa, chanHa: pocketHa * 0.55 };
  }

  /**
   * SSOT groove profile (stow channel + cradle pocket) for one daughter body. Consumed by `_carveStowGrooves` (the
   * vertex carve) AND by test-RcsPlacement.js (which asserts the RCS doghouse pods clear these bands), so the two can
   * never drift apart.
   * @param {number[]} body     daughter [x,y,z] in metres
   * @param {number}   barrelH  barrel length (scene units)
   * @returns {Array<{zc:number,hl:number,ha:number,d:number}>} scene-unit bands
   */
  _stowGrooveProfile(body, barrelH) {
    const V5 = Constants.OCTOPUS_V5 ?? {};
    const barrelR_m = (V5.COLLAR_RADIUS ?? 0.40); // metres
    const crossW = body[0];                 // body width (m), cross-section
    const bodyLen = body[2];                // body length (m), along barrel Z
    // Pocket angular half-width so the arc spans ~1.3× the body width (a little clearance around the cradled body):
    // arcWidth = barrelR * 2*ha = 1.3*crossW. Shared with the pyro-pin lip placement via _stowGrooveHalfWidths.
    const { pocketHa, chanHa } = this._stowGrooveHalfWidths(crossW, barrelR_m);
    // Pocket depth scales with daughter size. A small MLI standoff is baked in so the cradle floor sits a few mm clear
    // of the stowed daughter's blanket (avoids MLI-on-MLI scrubbing). Cap ~18% of the barrel radius (0.072 m): with the
    // plateau profile it reads as a machined recess with visible clearance. Weaver (crossW 0.20) hits the cap; the
    // smaller Spinner (crossW 0.10) scales down proportionally.
    const MLI_GAP_M = 0.006;                        // ~6 mm blanket standoff
    const maxDepth_m = barrelR_m * 0.18;            // 0.072 m ≈ 18% of 0.40 m radius
    const WEAVER_CROSS = (Constants.WEAVER_BODY ?? [0.2])[0];  // reference (largest)
    const pocketDepth =
      (Math.min(maxDepth_m, maxDepth_m * (crossW / WEAVER_CROSS)) + MLI_GAP_M) * M;
    // Pocket axial CENTRE derived from the true stowed-daughter geometry rather than a magic barrelH fraction: when an
    // arm is STOWED (sweep α = 0) the strut lies along −Z, so the daughter body parks at its tip — z = COLLAR_Y −
    // STRUT_LENGTH (≈ 1.00 − 1.70 = −0.70 m, DECISIONS §11). Centring the pocket exactly there makes both the large
    // (Weaver) and small (Spinner) daughters sit dead-centre in their cradle. Falls back to −0.34·barrelH if the tier
    // constants are missing.
    const pocketZc = (V5.COLLAR_Y != null && V5.STRUT_LENGTH != null)
      ? (V5.COLLAR_Y - V5.STRUT_LENGTH) * M
      : -barrelH * 0.34;
    // Pocket axial half-length ≈ body half-length + clearance + MLI standoff so the end caps clear the pocket end walls.
    const pocketHl = (bodyLen * 0.6 + MLI_GAP_M) * M;
    // Stow channel: a shallower, narrower groove the folded strut lies in, running forward of the pocket (chanHa from the
    // shared helper above).
    const chanDepth = pocketDepth * 0.55;
    return [
      { zc: barrelH * 0.08,  hl: barrelH * 0.38, ha: chanHa,   d: chanDepth },  // stow channel
      { zc: pocketZc,        hl: pocketHl,       ha: pocketHa, d: pocketDepth }, // cradle pocket
    ];
  }

  /**
   * Resolve the active arm-tier config (azimuth ring) the way ArmManager does, from the persisted save, so the carved
   * stow pockets and pyro-pin launch locks land at the SAME azimuths where daughters dock
   * (ArmManager.generateDockPositions). Falls back to Y0_QUAD for fresh/headless builds with no save.
   *
   * NOTE: the barrel is carved once at construction, so an in-session tier refit (which does not reconstruct the ship)
   * only re-aligns the pockets on the next load.
   * @returns {{azimuths:number[]}} the active tier config
   */
  _activeArmTierConfig() {
    let key = 'Y0_QUAD';
    try {
      const persisted = persistenceManager?.getArmTier?.();
      if (persisted && Constants.ARM_LADDER?.[persisted]) key = persisted;
    } catch (_) { /* headless / no save → default quad */ }
    return Constants.ARM_LADDER?.[key] ?? Constants.ARM_LADDER?.Y0_QUAD
      ?? { azimuths: [64, 116, 244, 296] };
  }

  /**
   * Carve stow grooves into the barrel by displacing the cylinder's vertices radially inward in a band at each strut
   * azimuth. The body CylinderGeometry is built Y-axis aligned and the mesh is later rotated rotation.x=π/2 (geom-Y →
   * world-Z). So a groove at ship azimuth θ and barrel-Z range [z0,z1] maps to:
   *   geometry azimuth  φ = -θ          (atan2(geomZ, geomX))
   *   geometry axial    y ∈ [z0, z1]    (geom-Y == world-Z after the rotation)
   *
   * Each groove uses smooth cosine falloff across its angular width and a smooth ramp at its axial ends, so the dip is
   * a rounded depression rather than a hard-edged trench. Vertices are pushed inward up to `depth`; the normals are
   * recomputed so lighting reads the groove correctly.
   * @param {THREE.BufferGeometry} geo  the body CylinderGeometry (Y-axis)
   */
  _carveStowGrooves(geo, barrelR, barrelH) {
    // Carve at the ACTIVE tier's ring azimuths (Quad/Hex/Octo) so the pockets land where daughters really dock.
    // (End-face Octo arms dock on the ±Z caps, not the barrel side, so they need no side pocket.)
    const azimuths = (this._activeArmTierConfig().azimuths ?? [64, 116, 244, 296])
      .map(d => degToRad(d));

    // Daughter body specs [x, y, z] in metres (Constants.WEAVER_BODY / SPINNER_BODY). The pocket cradles the body
    // cross-section (x≈y); z is the body length. Arm type alternates around the ring by index (mirrors
    // ArmManager._buildDockPositions: i%2===0 → weaver, else spinner).
    const WEAVER_BODY  = Constants.WEAVER_BODY  ?? [0.2, 0.2, 0.3];
    const SPINNER_BODY = Constants.SPINNER_BODY ?? [0.1, 0.1, 0.15];

    const weaverProfile  = this._stowGrooveProfile(WEAVER_BODY, barrelH);
    const spinnerProfile = this._stowGrooveProfile(SPINNER_BODY, barrelH);

    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const smooth = (t) => { // smoothstep 0..1
      t = clamp01(t);
      return smoothstep01(t);
    };
    const angDist = (a, b) => {
      let d = Math.abs(a - b) % (Math.PI * 2);
      return d > Math.PI ? Math.PI * 2 - d : d;
    };

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const r = Math.hypot(v.x, v.z);
      if (r < 1e-9) continue;              // skip axis-cap centre (open cyl: none)
      const phi = Math.atan2(v.z, v.x);    // geometry azimuth around Y
      const y = v.y;                       // geometry axial == world barrel-Z

      let maxDepth = 0;
      for (let a = 0; a < azimuths.length; a++) {
        const gPhi = -azimuths[a];         // ship azimuth → geometry azimuth
        const grooves = (a % 2 === 0) ? weaverProfile : spinnerProfile;
        for (const g of grooves) {
          const dAng = angDist(phi, gPhi);
          if (dAng > g.ha) continue;
          const dAx = Math.abs(y - g.zc);
          if (dAx > g.hl) continue;
          // Plateau profile: flat floor over the inner ~60% of the angular width, steep smoothstep walls over the outer
          // 40% (a machined pocket with a level bottom, not a crater dip). Same smooth ramp over the last 25% of the
          // axial length.
          const plateauHa = g.ha * 0.60;
          const wAng = (dAng <= plateauHa)
            ? 1
            : smooth((g.ha - dAng) / (g.ha - plateauHa));
          const wAx  = smooth((g.hl - dAx) / (g.hl * 0.25));
          maxDepth = Math.max(maxDepth, g.d * wAng * wAx);
        }
      }
      if (maxDepth > 0) {
        const nr = (r - maxDepth) / r;     // pull inward toward the axis
        v.x *= nr; v.z *= nr;
        pos.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  _buildMainBus() {
    // Config G barrel: cylindrical, 0.4 m radius × 2.0 m height (Constants.OCTOPUS_V5; archive/ARM_PIVOT_ANALYSIS.md §10.11)
    const V5 = Constants.OCTOPUS_V5;
    const barrelR = V5.COLLAR_RADIUS * M;  // 0.40m → M * 0.40
    const barrelH = V5.CORE_LENGTH * M;    // 2.00m → M * 2.00

    // Main body: smooth cylinder (64 radial segments). The body shell IS the base MLI thermal blanket (gold foil wraps
    // the whole bus); solar panels, thrusters, sensors, collar and channels sit ON TOP of it (higher renderOrder /
    // larger radius), as mounts sit on a real satellite's MLI. 64 segments so stow grooves can be carved into the hull
    // as real vertex displacement (a conforming depression, no separate coincident groove mesh).
    const bodyGeo = new THREE.CylinderGeometry(barrelR, barrelR, barrelH, 64, 24, true);
    this._carveStowGrooves(bodyGeo, barrelR, barrelH);
    this._matBody = this._matGoldMLI.clone();   // body skin = MLI blanket (gold)
    this._foilMats.push(this._matBody);         // orbital envMap target
    this.body = new THREE.Mesh(bodyGeo, this._matBody);
    this.body.rotation.x = Math.PI / 2; // Align Y-cylinder to Z-forward
    this.body.name = 'Barrel_ConfigG';
    this.body.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this.add(this.body);

    // Diagnostic hull edge-outline, shown only in the INSPECT camera view ("technical scan" read). Built LAZILY on the
    // first setHullOutlineVisible(true): the EdgesGeometry walk over the carved 64×24 barrel is pure boot waste for
    // sessions that never open INSPECT. `null` until first use.
    this._hullOutline = null;

    // Body-mount GaAs solar cells (610 W, archive/ARM_PIVOT_ANALYSIS.md §10.15; supplements the deployable ROSA wings).
    // Real body-mounted cells are FLAT rigid sub-panels tiled onto the structure's facets, not a curved film: flat
    // 10 mm-deep sub-panels (back face 1.004R, side walls cover the corner air over the curved hull), tangent to the
    // barrel ON TOP of the MLI blanket, ONLY in the clear sectors between the stowed struts ([64,116,244,296]°) and
    // clear of the ROSA wing roots at 0°/180°. Each carries the dark GaAs cell texture; cells occupy only the central
    // z-band, the MLI blanket (= the body skin) shows through everywhere else.

    // PV rows along the barrel length. Solar-constrained (2240 W solar vs an 8 kW distributable budget + 600 Wh
    // battery), so body cells are maximized: a tall CENTRAL row plus a shorter FORWARD and AFT row in the end bands,
    // only on the clear inter-strut facets. The end rows sit inward and short so they clear the end-mounted hardware
    // (collar ring at +Z, FEEP/RCS thrusters at −Z) and the carved daughter pockets near the aft end.
    const centralH = barrelH * 0.46;          // central PV row height (z)
    const endH     = barrelH * 0.12;          // forward/aft PV row height
    const endZ     = barrelH * 0.30;          // |z| centre of the end rows
    const cellBandH = centralH;               // (kept for MLI seam placement below)
    const barrelFacets = 16;                  // structural facet count (the barrel shell itself is 64-seg)
    const facetStep = (Math.PI * 2) / barrelFacets; // 22.5° — kept for the gap-cell width below
    const facetWidth = 2 * (barrelR * 1.006) * Math.tan(facetStep / 2); // chord of one 22.5° facet
    // DECISIONS §10/§11: body cells are HALF WIDTH, 32 slots of 11.25° instead of 16 facets of 22.5°, so a future strut
    // re-clock loses at most a half-cell of area instead of a whole facet. cellStep/halfCellWidth mirror
    // facetStep/facetWidth at twice the resolution. The keep-out rule below (strutKeep/strutKeepAft/rosaKeep, 18°/30°/8°)
    // is tested against each cell's CENTRE. MEASURED: the whole-facet layout's tightest gap was 0.635 mm (four facets vs
    // WingMotorBox_0/180deg, rosaKeep ridden to its physical limit); a rosaKeep below 5.625° would reopen a pinch of
    // that class (0.401 mm measured), so it stays; the real worst clearance of the rebuilt ship is 25.0 mm (RCS pod).
    const cellStep = facetStep / 2;                                    // 11.25°
    const barrelCells = barrelFacets * 2;                              // 32 half-width slots
    const halfCellWidth = 2 * (barrelR * 1.006) * Math.tan(cellStep / 2); // chord of one half-width cell
    // PV panels are thin boxes 10 mm deep. The dark side walls (this thickness) cover the ~6.7 mm corner air gap of a
    // flat panel over the curved hull and give the panel a real silhouette lip at the limb.
    const PANEL_THICK = M * 0.010;
    // Dark-orange Kapton edge tape (the MLI binding-tape family)
    this._matPanelTrim = new THREE.MeshStandardMaterial({
      color: 0x8a5a24, metalness: 0.45, roughness: 0.6, side: THREE.FrontSide,
    });

    const barrelCellTex = getSolarCellTexture();
    const makeRowMat = (texRows) => {
      let tx = null;
      if (barrelCellTex) {
        tx = barrelCellTex.clone();
        tx.needsUpdate = true;
        tx.repeat.set(1, texRows);   // ~one cell-tile across a facet, N rows down
      }
      return new THREE.MeshStandardMaterial({
        color: tx ? 0xffffff : 0x0a1133, // tint comes from the map when present
        map: tx || null,
        emissiveMap: tx || null,
        // Real PV cells carry an anti-reflective coating and read matte: low metalness + high roughness so the
        // directional sun does NOT mirror-glint on the flat body cells as the hull rolls.
        metalness: 0.25, roughness: 0.7,
        emissive: 0x0b1030, emissiveIntensity: 0.18,
        side: THREE.FrontSide,
        // Thin BOXES, not zero-thickness decals: the +z (outward) cell face sits at 1.014R with the back face buried at
        // 1.004R, so the panel writes depth normally (no coplanar-decal z-fight, no floating-sticker read).
        // depthWrite ON, standard OPAQUE render order.
        depthWrite: true,
      });
    };
    // PV rows: { z-centre, height, texture rows }. Three rows: central + 2 ends.
    const pvRows = [
      { z: 0,      h: centralH, mat: makeRowMat(3) },
      { z: endZ,   h: endH,     mat: makeRowMat(1) },
      { z: -endZ,  h: endH,     mat: makeRowMat(1), aft: true },
    ];
    // Scan-flash drives every PV-row material.
    this._cellSkinMats = pvRows.map(r => r.mat);

    // Bare-MLI half-window reserved around each strut; cells avoid these and the ROSA roots at 0°/180°. The central/fore
    // rows keep a ±18° strut keep-out (they sit away from the daughter, which stows AFT); the AFT row gets ±30° so no
    // aft cell overlaps a carved daughter pocket or a stowed daughter.
    const strutAz = Constants.ARM_LADDER.Y0_QUAD.azimuths.map(d => degToRad(d));
    const rosaAz = [0, Math.PI];
    const strutKeep    = degToRad(18);  // ±18° clear of each strut (side/central/fore rows)
    const strutKeepAft = degToRad(30);  // ±30° clear of each strut for the AFT row (pocket/daughter)
    const rosaKeep  = degToRad(8);   // ±8° clear of each ROSA root
    const angDist = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };

    let _panelN = 0;
    // Every body PV panel is remembered so a thin edge trim can be appended after the loops (neighbour layout must be
    // known first).
    const trimSpecs = [];
    const rowCells = pvRows.map(() => new Set());   // kept cell indices per row
    for (let f = 0; f < barrelCells; f++) {
      const az = f * cellStep + cellStep / 2;  // half-width cell centre azimuth
      // Skip cells near a strut or a ROSA root (centre-based keep-out: every cell this keeps is at least as far from
      // real hardware as the facet it came from).
      if (strutAz.some(s => angDist(az, s) < strutKeep)) continue;
      if (rosaAz.some(rz => angDist(az, rz) < rosaKeep)) continue;

      // Radial stack (units of hull radius R): hull 1.000 writes depth; seam tape 0.998–1.006R; accent rings
      // 1.004–1.012R; PV panels flat-tangent at 1.014R centre. Flat facet panels still lift a little (proportional to
      // the square of the half-angle) at their azimuth edges; that residual gold gap is masked by the per-panel dark
      // frame border below (reads as a mounting rail), NOT by pushing rr lower (which would let the accents poke
      // through).
      const rr = barrelR * 1.014;
      const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const _m4 = new THREE.Matrix4().makeBasis(right, up, radial);

      for (let rowIdx = 0; rowIdx < pvRows.length; rowIdx++) {
        const row = pvRows[rowIdx];
        if (row.aft && strutAz.some(s => angDist(az, s) < strutKeepAft)) continue;

        // Thin BOX panel: the +z cell face stays at the visual radius (1.014R); the box is PANEL_THICK (10 mm) deep, so
        // the back buries inside the hull and the dark side walls cover the corner air gap (read as a mounting rail).
        // Centre the box so its +z face lands at rr: centre = rr − halfThick.
        const panel = this._makePanelBox(halfCellWidth * 0.92, row.h, PANEL_THICK, row.mat);
        const cr = rr - PANEL_THICK / 2;   // box-centre radius so +z face sits at rr
        panel.position.set(Math.cos(az) * cr, Math.sin(az) * cr, row.z);
        panel.quaternion.setFromRotationMatrix(_m4);
        panel.name = `BarrelSolarPanel_${_panelN++}`;
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(panel);
        rowCells[rowIdx].add(f);
        trimSpecs.push({ mesh: panel, rowIdx, f, gap: false });
      }
    }

    // A few EXTRA cells in the clear gaps BETWEEN stowed daughters near the barrel ends. Daughters stow at the strut
    // azimuths [64,116,244,296]; the widest clear windows sit at 94.65° and 274.65° (centres of the pocket gaps,
    // between a Weaver edge at 82.61° and a Spinner edge at 106.69°). At the fore/aft end Z-bands they are clear of
    // daughters, struts and the collar; the RCS quad pods share those columns but sit at |z| ≥ 0.737 (clear of these
    // cells' z-band 0.48–0.72). The strobe lights at 90/270 sit at the equator Z=0: no conflict.
    const gapMat = makeRowMat(1);
    this._cellSkinMats.push(gapMat);
    const gapCellW = facetWidth * 0.75;   // half-angle ≈ 8.5° → ~3.5° margin to each pocket edge
    for (const gapAzDeg of [94.65, 274.65]) {
      const gapAz = degToRad(gapAzDeg);
      const radial = new THREE.Vector3(Math.cos(gapAz), Math.sin(gapAz), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const gM4 = new THREE.Matrix4().makeBasis(right, up, radial);
      for (const z of [endZ, -endZ]) {  // fore (+) and aft (−) end bands
        const rr = barrelR * 1.014;
        const cr = rr - PANEL_THICK / 2;   // box-centre radius so +z face sits at rr
        const panel = this._makePanelBox(gapCellW, endH, PANEL_THICK, gapMat);
        panel.position.set(Math.cos(gapAz) * cr, Math.sin(gapAz) * cr, z);
        panel.quaternion.setFromRotationMatrix(gM4);
        panel.name = `BarrelSolarPanel_gap_${gapAzDeg}_${z > 0 ? 'F' : 'A'}`;
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(panel);
        trimSpecs.push({ mesh: panel, rowIdx: -1, f: -1, gap: true });
      }
    }

    // Edge trim on every body PV panel (see _addPanelTrim). Every panel gets its two short ends (y = +-h/2); the two
    // side edges only where the neighbouring cell of the same row is absent (strut / ROSA keep-out, row end):
    // neighbours butt with a 6 mm gap that 2 x 8 mm of tape would swallow. Gap cells are isolated: all four edges.
    for (const sp of trimSpecs) {
      const lo = sp.gap || !rowCells[sp.rowIdx].has((sp.f + barrelCells - 1) % barrelCells);
      const hi = sp.gap || !rowCells[sp.rowIdx].has((sp.f + 1) % barrelCells);   // local +x = increasing azimuth
      this._addPanelTrim(sp.mesh, { lo, hi });
    }

    // Deliberately NO MLI quilting seam rings: thin gold tape hoops were sub-pixel in normal play, read as floating
    // distractions at inspect zoom, and the ±0.80 m pair ran through the RCS pod housings (z ±0.795). The MLI foil
    // texture carries the quilted read.

    // Panel-line accent rings (thin dark seam grooves) at the central-row edges. They span radial 1.004–1.012R, INSIDE
    // the PV panel radial span (outer face 1.014R, buried back to ~0.989R), at z = ±(cellBandH*0.5 + M*0.015) in the
    // bare-MLI band: +15 mm clears BOTH the central row edge (top at cellBandH*0.5) and the seam tape sitting at
    // cellBandH*0.5 ("never coincide" z rule), while staying inboard of the fore/aft rows (inner edge endZ − endH/2 =
    // barrelH*0.24 = 0.48M; the accent at 0.475M ± tube stays clear). No z=0 ring: it ran through the central PV row.
    // The accents sit fully proud on bare MLI: no panel crossing, deterministic tie-pass.
    const lineGeo = new THREE.TorusGeometry(barrelR * 1.008, M * 0.0016, 6, 64);
    const lineMat = this._matDark.clone();
    lineMat.depthWrite = false;
    const accentZ = cellBandH * 0.5 + M * 0.015; // bare-MLI band, +15 mm off the row edge/seam
    for (const z of [-accentZ, accentZ]) {
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.position.z = z;
      line.rotation.x = Math.PI / 2;
      line.name = 'AccentRing';   // detail-cull tag
      // Sub-order 2.03 — paints last (over panels + seam tape).
      line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL + 0.03;
      this.add(line);
    }

    // Deliberately NO flat laser "aperture" disc on the sensor deck: a fixed forward-facing emissive disc embedded in the
    // deck slab needed renderOrder tricks and can't track targets. The gimbal-mounted Cassegrain LaserTelescope built
    // in _buildSensors replaces it; `this.viewport` has no readers and no longer exists.

    // End caps. The bus is openEnded, so there is no built-in cap to z-fight with; the cap renders as plain
    // SPACECRAFT_OPAQUE (no polygonOffset) so any DETAIL-tagged mesh in front wins cleanly. 64 segments match the barrel
    // (both thetaStart=0, phases align). Rim rows are uncarved (groove z-spans stay clear of the ±barrelH/2 rims), so
    // the flat 64-gon caps seat exactly on the barrel edge, no see-through slits. The cap is a lid LIP at 1.004R
    // (+1.6 mm overhang): its rim is not coincident with the barrel-rim circle (flicker under log-depth), and the barrel
    // wall meets the cap underside perpendicular (a stable crossing, not a parallel tie). Do NOT inset the cap in z:
    // that would open a slit at the rim.
    const capGeo = new THREE.CircleGeometry(barrelR * 1.004, 64);
    // End caps are structural plates (optics bench forward, thruster deck aft),
    // not blanket — keep them dark metallic, distinct from the gold MLI body.
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x4a4a52, metalness: 0.7, roughness: 0.5,
    });
    const frontCap = new THREE.Mesh(capGeo, capMat);
    frontCap.position.z = barrelH * 0.5;
    frontCap.name = 'FrontCap_ConfigG';
    frontCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this.add(frontCap);
    const rearCap = new THREE.Mesh(capGeo, capMat);
    rearCap.position.z = -barrelH * 0.5;
    rearCap.rotation.y = Math.PI;
    rearCap.name = 'RearCap_ConfigG';
    rearCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this.add(rearCap);

    // Stowage grooves are part of the BODY mesh (a true inset arc would be hidden behind the thin, open body wall):
    // _carveStowGrooves displaces the body cylinder's vertices inward in a band at each strut azimuth. Here we only add
    // the pyro-pin launch locks at the groove lips, on the ACTIVE tier's ring so each lands on a real carved lip, not a
    // phantom Y0_QUAD azimuth after a refit.
    const channelTier = this._activeArmTierConfig();

    // Groove angular half-widths at the stow-channel band (matches the profile used by _carveStowGrooves): the pin sits
    // at z=-barrelH*0.21, inside the stow channel, whose angular half-width is chanHa = pocketHa*0.55. Recomputed per
    // daughter type so each pin lands on the carved lip, not the deepest floor.
    const barrelR_m_pin = (Constants.OCTOPUS_V5?.COLLAR_RADIUS ?? 0.40);
    const chanHaFor = (body) =>
      this._stowGrooveHalfWidths(body[0], barrelR_m_pin).chanHa;
    const chanHaWeaver  = chanHaFor(Constants.WEAVER_BODY  ?? [0.2, 0.2, 0.3]);
    const chanHaSpinner = chanHaFor(Constants.SPINNER_BODY ?? [0.1, 0.1, 0.15]);
    const pinEps = degToRad(2);   // small margin past the lip onto uncarved hull

    channelTier.azimuths.forEach((azDeg, aIdx) => {
      const azRad = degToRad(azDeg);
      const chanHa = (aIdx % 2 === 0) ? chanHaWeaver : chanHaSpinner;

      // Two pins per groove, one on each lip (±(chanHa+ε) around the azimuth), at radius 1.005R on the uncarved hull
      // just outside the channel wall.
      for (const side of [-1, 1]) {
        const lipAz = azRad + side * (chanHa + pinEps);
        const pyroGeo = new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.025, 24);
        const pyroMat = new THREE.MeshStandardMaterial({
          color: 0xcc4400, metalness: 0.6, roughness: 0.4,
        });
        const pyro = new THREE.Mesh(pyroGeo, pyroMat);
        pyro.position.set(
          Math.cos(lipAz) * barrelR * 1.005,
          Math.sin(lipAz) * barrelR * 1.005,
          -barrelH * 0.21,
        );
        const radialUp = new THREE.Vector3(Math.cos(lipAz), Math.sin(lipAz), 0);
        pyro.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radialUp);
        pyro.name = `PyroPin_${azDeg}_${side > 0 ? 'hi' : 'lo'}`;
        this.add(pyro);
      }
    });

    // No docking cavities (Config G uses collar-mounted struts)
    this._dockingCavities = [];
  }

  /**
   * A-frame bracket 2D Shape for ExtrudeGeometry: topology-optimized profile with rounded apex, tapered web, gusset
   * fillets and oval lightening hole. See archive/EPIC10_DEEP_ANALYSIS.md §13.1.2.
   * @returns {THREE.Shape}
   */
  _aframeShape() {
    const W  = M * 0.025;  // half-width at base (50 mm total)
    const H  = M * 0.040;  // total height base→apex (40 mm)
    const FH = M * 0.012;  // flange height (12 mm)
    const AW = M * 0.010;  // half-width at apex (20 mm total)
    const R  = M * 0.008;  // apex fillet radius

    const shape = new THREE.Shape();
    shape.moveTo(-W, 0);
    shape.lineTo(-W, FH);
    shape.bezierCurveTo(
      -W, FH + M * 0.010,    // CP1: slight outward bulge (gusset fillet)
      -AW - R, H - R,        // CP2: approach apex tangent
      -AW, H,                // End: apex left edge
    );
    shape.bezierCurveTo(
      -AW + R * 0.5, H + R * 0.4,  // CP1
       AW - R * 0.5, H + R * 0.4,  // CP2
       AW, H,                       // End: apex right edge
    );
    shape.bezierCurveTo(
       AW + R, H - R,
       W, FH + M * 0.010,
       W, FH,
    );
    shape.lineTo(W, 0);
    shape.lineTo(-W, 0);

    // Lightening hole — oval cutout in web center (~30 % mass removal)
    const hole = new THREE.Path();
    hole.ellipse(0, M * 0.022, M * 0.007, M * 0.005, 0, Math.PI * 2, false, 0);
    shape.holes.push(hole);

    return shape;
  }

  /**
   * Double-A clevis hinge assemblies at the strut roots (archive/EPIC10_DEEP_ANALYSIS.md §13.1): topology-optimized
   * A-frame brackets, Vespel bushings, brake discs, Ti bolt details on a HingePad per strut azimuth. The body skin
   * carries the pads directly (no collar flange ring or bolt circle); the clevis sits on the StrutPivot_* kinematic
   * axis (pin radial +0.011, plates ±0.036). All shared geometries are created once and reused via mesh cloning.
   *
   * PRESERVED: this.hingeMounts[], this.hingeLEDs[] (used by postArmUpdate).
   */
  _buildCollar() {
    const V5 = Constants.OCTOPUS_V5;
    const collarY = V5.COLLAR_Y * M;          // 1.00 m → ship-frame Z offset
    const collarR = V5.COLLAR_RADIUS * M;     // 0.40 m → torus major radius
    const tier = Constants.ARM_LADDER.Y0_QUAD; // { azimuths: [64, 116, 244, 296] }
    const _yUpCollar = new THREE.Vector3(0, 1, 0);  // reusable Y-up for quaternion ops

    // Materials (archive/EPIC10_DEEP_ANALYSIS.md §13.1.1 Material Selection Table)
    const aframeMat = new THREE.MeshStandardMaterial({
      color: 0x9090a8, metalness: 0.72, roughness: 0.30,   // 6061-T6 CNC
    });
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xaabbcc, metalness: 0.85, roughness: 0.15,   // 17-4PH stainless
    });
    const bushingMat = new THREE.MeshStandardMaterial({
      color: 0x8b6914, metalness: 0.15, roughness: 0.70,   // Vespel SP-1
    });
    const boltMat = new THREE.MeshStandardMaterial({
      color: 0x99aabb, metalness: 0.80, roughness: 0.20,   // Ti-6Al-4V
    });

    // Deliberately NO collar ring (torus belt, flange ring, seat ring, flange bolts): it read as a loose hoop, was
    // overkill for 4 hinge points, and sat in the fore axial RCS exhaust path (~27 mm clearance). Struts mount on
    // discrete hinge pads (below); this.collarRing is intentionally not set.

    // Hinge mounting pads: one low plate per strut hinge. Base buried 4 mm below the hull surface (bury-don't-touch,
    // same anti-z-fight pattern as the RCS doghouses); top face 4 mm proud (r 0.396–0.404), sitting under the A-frame
    // brackets. A 0.10 m flat plate on the r 0.40 barrel has 3.1 mm of corner sag, so at 4 mm bury its tangential
    // corners sit 0.9 mm inside the hull. Every radial number in the hinge cluster below assumes the 0.404 pad top.
    const PAD_W = 0.10, PAD_L = 0.10, PAD_T = 0.008;   // m: tangential × axial × radial
    const PAD_BURY = 0.004;                             // m: base below the skin
    const PAD_TOP  = -PAD_BURY + PAD_T;                 // m: pad top above the skin (+0.004)
    // The Ø18 pin's belly (pad-local r +2) would sit 2 mm inside the 4 mm pad top. The pad
    // gets a matching cradle groove across its whole width (±8 mm along the barrel, floor at r +1.5), so the pin
    // clears the pad by 0.5 mm and nothing intersects. Profile in (axial u, radial v), extruded along the tangent.
    const GROOVE_HALF = 0.008, GROOVE_FLOOR = 0.0015;   // m
    const padShape = new THREE.Shape();
    padShape.moveTo(-PAD_L / 2 * M, -PAD_T / 2 * M);
    padShape.lineTo(PAD_L / 2 * M, -PAD_T / 2 * M);
    padShape.lineTo(PAD_L / 2 * M, PAD_T / 2 * M);
    padShape.lineTo(GROOVE_HALF * M, PAD_T / 2 * M);
    padShape.lineTo(GROOVE_HALF * M, GROOVE_FLOOR * M);
    padShape.lineTo(-GROOVE_HALF * M, GROOVE_FLOOR * M);
    padShape.lineTo(-GROOVE_HALF * M, PAD_T / 2 * M);
    padShape.lineTo(-PAD_L / 2 * M, PAD_T / 2 * M);
    padShape.closePath();
    const padGeo = new THREE.ExtrudeGeometry(padShape, { depth: PAD_W * M, bevelEnabled: false, steps: 1 });
    padGeo.translate(0, 0, -PAD_W * M / 2);
    padGeo.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));   // (u, v, w) → (tangent, axial, radial)
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,   // 7075-T6 (matches hinge metal)
    });
    tier.azimuths.forEach((azDeg, i) => {
      const azRad  = degToRad(azDeg);
      const radial = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const padR = collarR - M * PAD_BURY + M * (PAD_T / 2);  // base 4 mm under hull
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(radial.x * padR, radial.y * padR, collarY);
      pad.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 0, 1), radial),
      );
      pad.name = `HingePad_${i}`;
      pad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.add(pad);
    });

    // Folded-strut rests (DECISIONS §11): the strut is 1.70 m (front-ring hinge z 1.00 to the stow pocket z −0.70) and,
    // stowed (α 0), its centreline runs at a CONSTANT r = collarR the whole way (sin 0° = 0): a long unsupported run
    // over the hull. A small fixed saddle on the skin over the middle ring (z ≈ 0; this only adds the pad, not the
    // ring) gives it a real bolted support at roughly its midpoint; the stowed rod resting on it is by design, like the
    // carved stow nest at the pocket. Sized to the rod (STRUT_TUBE_OD 50 mm) like the hinge pad; buried/proud the same
    // way (bury-don't-touch).
    const REST_W = 0.06, REST_L = 0.05, REST_T = 0.008;  // m: tangential × axial × radial
    const REST_BURY = 0.004;
    const restGeo = new THREE.BoxGeometry(M * REST_W, M * REST_L, M * REST_T);
    const restMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,   // matches HingePad's 7075-T6
    });
    tier.azimuths.forEach((azDeg, i) => {
      const azRad  = degToRad(azDeg);
      const radial = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const restR = collarR - M * REST_BURY + M * (REST_T / 2);
      const rest = new THREE.Mesh(restGeo, restMat);
      rest.position.set(radial.x * restR, radial.y * restR, 0);
      rest.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 0, 1), radial),
      );
      rest.name = `StrutRest_${i}`;
      rest.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.add(rest);
    });

    // Shared hinge geometries (two-ear clevis, stepped pin). Owner 2026-10-13: "Hinges should be more realistic for
    // space, for 3d print can use m4 bolts for hinges." Every size below is Decision H (docs/DECISIONS.md): ears 9 mm,
    // clevis 65 mm wide (inner faces ±23.5, outer ±32.5), stepped pin Ø18, duplex-bearing bosses Ø32, ONE motor +
    // harmonic-gear cylinder Ø45 × 28 coaxial on one pin end, a small encoder cap on the other. All measured in mm from
    // the pivot, tangent = along the pin, radial = out from the skin.
    const aframeGeo = new THREE.ExtrudeGeometry(this._aframeShape(), {
      depth:          M * 0.007,    // 7 mm + 2 × 1 mm chamfer = 9 mm ear
      bevelEnabled:   true,
      bevelThickness: M * 0.001,    // 1 mm chamfer
      bevelSize:      M * 0.001,
      bevelSegments:  1,            // single chamfer (machined look)
      curveSegments:  12,           // bezier smoothness (8 mm apex fillet + 7×5 mm oval hole, r < 10 mm → 12)
    });
    aframeGeo.center();             // origin at bracket centroid (bbox CENTRE, see HINGE_PLATE_RADIAL)

    const HINGE_PIN_RADIAL     = 0.011;   // m above the skin: pin axis (StrutPivot_i is frozen)
    const HINGE_PLATE_TANGENT  = 0.028;   // m: ear centres (9 mm ears → faces ±23.5 / ±32.5)
    const HINGE_PLATE_RADIAL   = 0.0055;  // m: ear bbox CENTRE → base r −15.7 (4 mm clear of the SensorDeck rim, r 0.380), apex r +26.7 (pin top at 20)
    const HINGE_BOSS_TANGENT   = 0.0355;  // m: Ø32 × 6 duplex-bearing boss on each ear's outer face (32.5…38.5)
    const HINGE_MOTOR_TANGENT  = 0.0525;  // m: motor Ø45 × 28 spans 38.5…66.5 (axis = pin axis)
    const HINGE_ENC_TANGENT    = 0.0435;  // m: encoder cap Ø22 × 10 spans 38.5…48.5 (opposite end)
    const HINGE_BOLT_TANGENT   = 0.044;   // m: pad bolts, outside the motor / encoder / bosses
    const HINGE_BOLT_AXIAL     = 0.044;   // m: ± along the barrel; clear of the Ø45 motor (±22.5) by 18 mm
    const HINGE_BOLT_RADIAL    = PAD_TOP + 0.001;  // m: 4 mm bolt centred 1 mm above the pad top → 3 mm proud
    const HINGE_LED_R          = 0.006;   // m
    const HINGE_LED_RADIAL     = PAD_TOP + 0.004;  // m: on the pad, 4 mm above its top
    // The tube sweeps the tangent = 0 plane and is 25 mm in radius: anything at |tangent| ≥ 29 mm is clear of it at
    // every α. The LED sits on the encoder side, beside the encoder cap (z ±11) and the stop lugs (z 30…38).
    const HINGE_LED_TANGENT    = 0.043;
    const HINGE_LED_Z          = 0.020;

    // Motor side per azimuth: the tangent side toward 90° / 270°, away from the radiator stations.
    //   64 → +, 116 → −, 244 → +, 296 → −
    const motorSide = (azDeg) => ((azDeg === 64 || azDeg === 244) ? 1 : -1);

    // Stepped pin: Ø18 through both ears (±32.5), Ø12 out through the bosses into the motor / encoder.
    const pinGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0, -M * 0.045), new THREE.Vector2(M * 0.006, -M * 0.045),
      new THREE.Vector2(M * 0.006, -M * 0.0325), new THREE.Vector2(M * 0.009, -M * 0.0325),
      new THREE.Vector2(M * 0.009, M * 0.0325), new THREE.Vector2(M * 0.006, M * 0.0325),
      new THREE.Vector2(M * 0.006, M * 0.045), new THREE.Vector2(0, M * 0.045),
    ], 32);
    const bossGeo    = new THREE.CylinderGeometry(M * 0.016, M * 0.016, M * 0.006, 48);
    const headGeo    = new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.004, 24);   // Ø12: its underside (r 5) clears the pad top (r 4)
    const mountBoltGeo = new THREE.CylinderGeometry(M * 0.003, M * 0.003, M * 0.004, 6);
    const ledGeo     = new THREE.SphereGeometry(M * HINGE_LED_R, 16, 8);  // r 6 mm, on the pad
    const motorGeo   = new THREE.CylinderGeometry(M * 0.0225, M * 0.0225, M * 0.028, 48);
    const encoderGeo = new THREE.CylinderGeometry(M * 0.011, M * 0.011, M * 0.010, 32);
    const stopGeo    = new THREE.BoxGeometry(M * 0.008, M * 0.008, M * 0.010);   // tangent × axial × radial
    const latchGeo   = new THREE.BoxGeometry(M * 0.008, M * 0.010, M * 0.014);
    // Fixed half of the harness loop: a half-torus standing on the pad, its two feet on the pad top.
    const harnessGeo = new THREE.TorusGeometry(M * 0.005, M * 0.0012, 8, 12, Math.PI);
    const motorMat = new THREE.MeshStandardMaterial({
      color: 0x6c7480, metalness: 0.55, roughness: 0.42,  // anodized actuator housing
    });
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.2, roughness: 0.7,    // harness sleeve
    });

    this.hingeMounts = [];
    this.hingeLEDs   = [];

    for (const azDeg of tier.azimuths) {
      const azRad   = degToRad(azDeg);
      const cx      = Math.cos(azRad) * collarR;
      const cy      = Math.sin(azRad) * collarR;
      const radial  = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const pinQuat = new THREE.Quaternion().setFromUnitVectors(_yUpCollar, tangent);
      const mSide   = motorSide(azDeg);
      const sideTag = (s) => (s > 0 ? 'L' : 'R');   // L = +tangent, R = −tangent
      // ship-frame point: tangent t, radial r, axial z (all metres)
      const at = (t, r, z = 0) => new THREE.Vector3(
        cx + radial.x * M * r + tangent.x * M * t,
        cy + radial.y * M * r + tangent.y * M * t,
        collarY + M * z,
      );
      const place = (mesh, name, pos, order, quat) => {
        mesh.position.copy(pos);
        if (quat) mesh.quaternion.copy(quat);
        mesh.name = name;
        mesh.renderOrder = order;
        this.add(mesh);
        return mesh;
      };
      const DETAIL = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      const boxQuat = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 0, 1), radial),
      );

      for (const side of [-1, 1]) {
        // Ear (9 mm). Orientation: shape +Y → radial, extrude +Z → tangent × side, shape +X → barrel Z.
        const ear = new THREE.Mesh(aframeGeo, aframeMat);
        ear.position.copy(at(HINGE_PLATE_TANGENT * side, HINGE_PLATE_RADIAL));
        ear.setRotationFromMatrix(new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 0, side), radial, tangent.clone().multiplyScalar(side)));
        ear.name = `AFrame_${azDeg}_${sideTag(side)}`;
        ear.renderOrder = DETAIL;
        this.add(ear);

        // Duplex-bearing boss Ø32 × 6 on the ear's outer face, around the pin.
        place(new THREE.Mesh(bossGeo, bushingMat), `Bushing_${azDeg}_${sideTag(side)}`,
          at(HINGE_BOSS_TANGENT * side, HINGE_PIN_RADIAL), DETAIL, pinQuat);

        // Pad bolts (×2 per side), outside the motor / encoder / bosses.
        for (const boltSide of [-1, 1]) {
          place(new THREE.Mesh(mountBoltGeo, boltMat), `MountBolt_${azDeg}_${sideTag(side)}_${boltSide}`,
            at(HINGE_BOLT_TANGENT * side, HINGE_BOLT_RADIAL, HINGE_BOLT_AXIAL * boltSide), DETAIL,
            new THREE.Quaternion().setFromUnitVectors(_yUpCollar, radial));
        }

        // Pin head (encoder end) / nut (motor end): a Ø12 × 4 cap just beyond the housing.
        const capT = side === mSide ? (0.0665 + 0.002) : (0.0485 + 0.002);
        place(new THREE.Mesh(headGeo, pinMat), `CClip_${azDeg}_${sideTag(side)}`,
          at(capT * side, HINGE_PIN_RADIAL), DETAIL, pinQuat);
      }

      // Stepped pivot pin (17-4PH): the M4 bolt in the print.
      const pin = place(new THREE.Mesh(pinGeo, pinMat), `HingePin_${azDeg}`,
        at(0, HINGE_PIN_RADIAL), DETAIL, pinQuat);
      this.hingeMounts.push(pin);           // preserve hingeMounts[] reference

      // Motor + harmonic gear: ONE Ø45 × 28 cylinder, axis = pin axis, on the 90° / 270° side.
      place(new THREE.Mesh(motorGeo, motorMat), `StrutMotorBox_${azDeg}`,
        at(HINGE_MOTOR_TANGENT * mSide, HINGE_PIN_RADIAL), Constants.RENDER_ORDER.SPACECRAFT_OPAQUE, pinQuat);
      // Encoder cap on the other pin end.
      place(new THREE.Mesh(encoderGeo, motorMat), `AFrame_${azDeg}_Encoder`,
        at(-HINGE_ENC_TANGENT * mSide, HINGE_PIN_RADIAL), DETAIL, pinQuat);

      // Two hard-stop lugs and a hook latch block on the pad, beside the sweep (|tangent| ≥ 40 mm). The stops are VISIBLE
      // BUMPER LUGS, not the load path (coordinator decision): a true stop lives inside the motor gearbox on real
      // hardware, and a round lug turning with the pivot twist cannot meet a fixed stop above the skin. They show where
      // the sweep ends; the strut does not touch them. The stops sit ± 34 mm along the barrel on the encoder side; the
      // latch on the motor side, fore.
      place(new THREE.Mesh(stopGeo, aframeMat), `AFrame_${azDeg}_StopLo`,
        at(-0.044 * mSide, PAD_TOP + 0.005, 0.034), DETAIL, boxQuat);
      place(new THREE.Mesh(stopGeo, aframeMat), `AFrame_${azDeg}_StopHi`,
        at(-0.044 * mSide, PAD_TOP + 0.005, -0.034), DETAIL, boxQuat);
      place(new THREE.Mesh(latchGeo, aframeMat), `AFrame_${azDeg}_Latch`,
        at(0.044 * mSide, PAD_TOP + 0.007, 0.033), DETAIL, boxQuat);
      // Hinge-side half of the harness loop, aft of the motor, feet on the pad.
      const loopQuat = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1).multiplyScalar(-1), radial, tangent));
      place(new THREE.Mesh(harnessGeo, bootMat), `AFrame_${azDeg}_Harness`,
        at(0.044 * mSide, PAD_TOP, -0.032), DETAIL, loopQuat);

      // LED indicator on the hinge PAD, beside the encoder cap
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.copy(at(-HINGE_LED_TANGENT * mSide, HINGE_LED_RADIAL, HINGE_LED_Z));
      led.name = `HingeLED_${azDeg}`;
      led.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      this.add(led);
      this.hingeLEDs.push(led);             // preserve hingeLEDs[] for postArmUpdate
    }
  }

  /**
   * @private — Build animated strut pivots at each hinge mount. Each strut extends from the collar hinge and sweeps
   * 0–π driven by {@link ArmUnit.getAimAlpha}. A tip node at the far end is the attachment point for daughter arms.
   *
   * Scene hierarchy per arm:
   * ```
   *   PlayerSatellite (ship group)
   *     └─ StrutPivot_i (THREE.Group) — at hinge, rotates for sweep
   *          └─ Strut_i (Mesh)       — cylinder, top = pivot
   *          └─ StrutTip_i (Group)   — far end, daughter-arm dock
   * ```
   */
  _buildStruts() {
    const V5 = Constants.OCTOPUS_V5;
    const strutLen = V5.STRUT_LENGTH * M;         // 1.70 m → scene
    const strutR   = (V5.STRUT_TUBE_OD / 2) * M;  // 0.025 m → scene
    const collarY  = V5.COLLAR_Y * M;
    const collarR  = V5.COLLAR_RADIUS * M;
    const tier     = Constants.ARM_LADDER.Y0_QUAD;

    // Cached for the dock-offset computation in _updateStruts
    this._strutLen = strutLen;

    // Shared geometry + material (one per satellite, 4 struts share). Open-ended: the bare tip showed the CFRP bottom
    // cap coplanar (y = −strutLen) with the TipCollar's alu bottom cap (z-fight when no daughter is docked); the collar
    // (r 1.10× strut) closes the end alone. The tube starts 40 mm out from the pivot (the Ø42 lug and the Ø60 end
    // fitting cover the first 115 mm); its tip is 1.70 m from the pivot.
    const TUBE_ROOT = M * 0.040;
    const strutGeo = new THREE.CylinderGeometry(strutR, strutR, strutLen - TUBE_ROOT, 48, 1, true);   // 48-seg like the collars
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.15, roughness: 0.65,  // CFRP T800/M21
    });

    // Rib ring collars (field-joint detail). Seated: the inner edge is 0.25 mm INSIDE the tube wall (a crossing, not a
    // coplanar tie), so the ring grips the strut. 6-sided section: the ring's inner vertex is exactly R − 3 mm.
    const ribGeo = new THREE.TorusGeometry(strutR + M * 0.00275, M * 0.003, 6, 48);   // 48 around
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // machined 6061-T6
    });

    // Root joint collar (clevis fork fitting at the hinge end): the rootCollar cylinder at strutR*1.20 (radius 0.030)
    // sits at the pivot point on the bus surface, over the hinge PAD and between the A-frame plates (inner faces at
    // tangent ±0.032, 2 mm clear of this r 0.030 collar at α = 0).
    // Two round pieces, both axisymmetric about the strut (the pivot frame twists about the strut axis, so only round
    // parts may ride in it):
    //   RootCollar_i_Lug  Ø42 stub from 10 mm behind the pivot to 40 mm out: it carries the pin
    //                     (pin top 20 mm from the strut axis) and fits between the ears (2.5 mm clear);
    //   RootCollar_i      Ø60 × 75 tube end fitting from 40 mm out.
    const LUG_R = M * 0.021, LUG_BACK = M * 0.010;
    // Front half tapers (Ø42 -> Ø30 at 40 mm out, starting 9 mm out = the pin's edge): at exactly 180° the
    // lug lies along the fore axis and its inner flank would otherwise graze the sensor-deck rim (0 mm);
    // the taper holds it >= 1.5 mm clear over the whole 0…180° game range (STRUT_SWEEP_MAX = π).
    const lugGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0, -TUBE_ROOT),
      new THREE.Vector2(LUG_R * (15 / 21), -TUBE_ROOT),
      new THREE.Vector2(LUG_R, -M * 0.009),
      new THREE.Vector2(LUG_R, LUG_BACK),
      new THREE.Vector2(0, LUG_BACK),
    ], 48);
    const ROOT_COLLAR_LEN = M * 0.075;
    const rootCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.20, strutR * 1.20, ROOT_COLLAR_LEN, 48
    );
    const rootCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,  // 7075-T6
    });
    // Strut-side half of the harness loop: a clamp ring round the tube just past the end fitting
    // (round, so the pivot twist cannot turn it).
    const loopGeo = new THREE.TorusGeometry(strutR + M * 0.0012, M * 0.0012, 8, 48);

    const tipCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.10, strutR * 1.10, M * 0.020, 48   // inscribed 0.02726 > strut r 0.025
    );
    const tipCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // 6061-T6
    });

    // Reel cartridge shared geometry + materials. The can's ends are closed (openEnded=false: an open FrontSide shell
    // culled its far wall end-on, and the drum end-caps, coaxial with and pierced by the strut, read as interpenetrating
    // geometry; test-MotherZFix pins openEnded === false). So the drum stays visible (a tether winch needs a visible
    // spool), the shell is a WINDOWED C-SHELL: 240° of wall (thetaStart 4π/3 → wall θ ∈ [240°, 120°] through 0°) and a
    // 120° window centred on housing-local −Z (θ = 180°). CylinderGeometry's θ = 0 is local +Z, where ReelLED_* stands
    // off the wall, so the LED sits over solid wall, never over the window. DoubleSide so the shell's interior renders
    // through the window. Keyed child order (housing[0], drum[1], led[2]). Window direction at α = 0 (pivot frame from
    // setFromUnitVectors(−Y, −Z)): local −Z → ship +Y, i.e. the two upper stowed cans (az 64/116, DECISIONS §11) show
    // their window to +Y; at α = π/2 every window faces aft (local −Z → ship −Z).
    const REEL_WALL_THETA_START = 4 * Math.PI / 3;  // wall start (240°)
    const REEL_WALL_THETA_LEN   = 4 * Math.PI / 3;  // 240° of wall → 120° window at θ = 180° (local −Z)
    const housingGeo = new THREE.CylinderGeometry(
      M * 0.055, M * 0.055, M * 0.065, 48, 1, false,   // 48-seg: always in chase view; matches the drum
      REEL_WALL_THETA_START, REEL_WALL_THETA_LEN,
    );
    // NB: housingMat is also the material of SpringHousing_* and GuideRail_*_L/R below. DoubleSide is what the
    // open-ended spring housing needs too (its interior culls away end-on otherwise) and is a no-op on the closed rail
    // boxes.
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x505868, metalness: 0.40, roughness: 0.50,  // hard-anodized 6061-T6
      side: THREE.DoubleSide,                             // T7: interior visible through the window
    });
    const drumGeo = new THREE.CylinderGeometry(M * 0.045, M * 0.045, M * 0.055, 48);
    const drumMat = new THREE.MeshStandardMaterial({
      color: 0xddddee, metalness: 0.20, roughness: 0.60,  // Dyneema SK78 T0
      // _animateTetherIndicators spins children[1] at 2 rad/s during reel-in; a smooth cylinder reads static when it
      // turns, so flat shading bands the facets and the spin reads through the window.
      flatShading: true,
    });
    // Status LED: a small solid box whose inner face stands REEL_LED_STANDOFF (4 mm) proud of the wall (a 1 mm offset is
    // below reliable log-depth separation and z-fights the shell), so it reads as a raised indicator and never shares a
    // depth plane with the housing. Colour is driven via .material.color in _animateTetherIndicators.
    const REEL_LED_STANDOFF = M * 0.004;      // 4 mm ≥ log-depth min separation
    const ledDepth = M * 0.004;
    const ledGeo = new THREE.BoxGeometry(M * 0.008, M * 0.008, ledDepth);
    const ledZ = M * 0.055 + REEL_LED_STANDOFF + ledDepth * 0.5; // inner face 4 mm proud
    const ledMatBase = new THREE.MeshBasicMaterial({
      color: 0x00ff44,  // green = STOWED
    });

    // Cable harness (Line geometry). Routed just OUTSIDE the rib-ring outer edge (ring tube centre 0.0305, outer
    // 0.0335) so the 1px line rides proud of the rings with a real gap instead of z-fighting where it crosses each
    // ring. The P-clips inherit this offset, so cable + clips stay aligned.
    const cableOffset = strutR * 1.22 + M * 0.006;  // ~clear of rib-ring outer (0.0335)
    const cableVerts = new Float32Array([
      cableOffset, -(TUBE_ROOT + M * 0.075), 0,         // root collar exit (collar spans 40…115 mm out)
      cableOffset, -strutLen * 0.25, 0,                  // clip 1
      cableOffset, -strutLen * 0.50, 0,                  // clip 2
      cableOffset, -strutLen * 0.75, 0,                  // clip 3
      cableOffset, -strutLen * 0.85 + M * 0.0325, 0,    // reel housing entry
    ]);
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.BufferAttribute(cableVerts, 3));
    const cableMat = new THREE.LineBasicMaterial({ color: 0x555566 });

    // P-clip shared geometry (reuses ribMat)
    const clipGeo = new THREE.BoxGeometry(M * 0.012, M * 0.008, M * 0.006);

    // Crossbow spring mechanism: the housing is open-ended so the coil shows, and shares housingMat (DoubleSide) so its
    // interior renders end-on instead of culling to see-through. No separate liner: a BackSide sleeve 3 mm inside a
    // wall that already draws both faces would only add a sub-4 mm interior pair (a z-tie).
    const springHousingGeo = new THREE.CylinderGeometry(
      M * 0.030, M * 0.030, M * 0.060, 48, 1, true   // open-ended, reveals coil (DoubleSide housingMat)
    );
    const springRingGeo = new THREE.TorusGeometry(M * 0.018, M * 0.003, 3, 6);   // (3, 6): outer r 0.021 sits inside the 0.025 strut, never visible (measured)
    const springMat = new THREE.MeshStandardMaterial({
      color: 0x889999, metalness: 0.82, roughness: 0.28,  // maraging steel C-300
    });
    const guideLen = strutLen * 0.05;  // 5% of strut = 80mm (housing to tip)
    const guideGeo = new THREE.BoxGeometry(M * 0.005, guideLen, M * 0.005);

    this.strutPivots   = [];   // THREE.Group — pivot at hinge
    this.strutMeshes   = [];   // THREE.Mesh  — the thin rod
    this.strutTipNodes = [];   // THREE.Group — tip attachment for V-4
    this.tetherReels   = [];   // THREE.Group[] — reel cartridge per strut
    this._tetherIndicators = []; // THREE.Mesh[] — LED per reel

    /** @type {Array<{pivotGroup: THREE.Group, strut: THREE.Mesh, tipNode: THREE.Group, azRad: number}>} */
    this.strutGroups = [];

    tier.azimuths.forEach((azDeg, i) => {
      const azRad = degToRad(azDeg);

      const pivotGroup = new THREE.Group();
      pivotGroup.position.set(
        Math.cos(azRad) * collarR,
        Math.sin(azRad) * collarR,
        collarY,
      );
      pivotGroup.name = `StrutPivot_${i}`;

      // CylinderGeometry default is Y-axis aligned: offset so the pivot point = top end of the cylinder.
      const strut = new THREE.Mesh(strutGeo, strutMat);
      strut.position.y = -(TUBE_ROOT + strutLen) / 2;   // from 40 mm out to the tip
      strut.name = `Strut_${i}`;
      strut.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      pivotGroup.add(strut);

      const tipNode = new THREE.Group();
      tipNode.position.y = -strutLen;
      tipNode.name = `StrutTip_${i}`;
      pivotGroup.add(tipNode);

      // Reel cartridge (3-child group). Render order: shell + drum DETAIL (drawn after the strut/hull opaques they sit
      // on), LED ADDITIVE (after every solid).
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.name = `ReelHousing_${i}`;
      housing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      const drum = new THREE.Mesh(drumGeo, drumMat);
      drum.name = `ReelDrum_${i}`;
      drum.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      const led = new THREE.Mesh(ledGeo, ledMatBase.clone());
      led.position.set(0, M * 0.02, ledZ);  // on the housing wall (local +Z, θ = 0 — solid wall), standing proud
      led.name = `ReelLED_${i}`;
      led.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;

      const reelCartridge = new THREE.Group();
      reelCartridge.add(housing);    // children[0] — housing shell
      reelCartridge.add(drum);       // children[1] — spool drum (keyed for rotation)
      reelCartridge.add(led);        // children[2] — status LED
      reelCartridge.position.y = -strutLen * 0.85;
      reelCartridge.name = `ReelCartridge_${i}`;
      pivotGroup.add(reelCartridge);

      this.tetherReels.push(reelCartridge);
      this._tetherIndicators.push(led);

      const cable = new THREE.Line(cableGeo, cableMat);
      cable.name = `CableHarness_${i}`;
      pivotGroup.add(cable);

      // P-clips at the rib ring positions, offset CLIP_Y_OFFSET along Y off the ring plane: at the same Y the clip box
      // (centred at radius cableOffset≈0.030, extent ±0.006 → 0.024–0.036) would sit INSIDE the rib-ring torus radial
      // span (0.0275–0.0335): coincident geometry that z-fights on the +X side. (A clip clamping the cable just below
      // its rib ring is physically correct.)
      const CLIP_Y_OFFSET = M * 0.012;
      for (const frac of [0.25, 0.50, 0.75]) {
        const clip = new THREE.Mesh(clipGeo, ribMat);
        clip.position.set(cableOffset, -strutLen * frac - CLIP_Y_OFFSET, 0);
        clip.name = `PClip_${i}_${frac * 100}`;
        clip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        pivotGroup.add(clip);
      }

      const springGroup = new THREE.Group();
      const springHousing = new THREE.Mesh(springHousingGeo, housingMat);
      springHousing.name = `SpringHousing_${i}`;
      springGroup.add(springHousing);
      const springCoil = new THREE.Mesh(springRingGeo, springMat);
      springCoil.rotation.x = Math.PI / 2;
      springCoil.name = `SpringCoil_${i}`;
      springGroup.add(springCoil);
      const railOff = M * 0.012;
      const railL = new THREE.Mesh(guideGeo, housingMat);
      railL.position.set(-railOff, -strutLen * 0.025, 0);
      railL.name = `GuideRail_${i}_L`;
      springGroup.add(railL);
      const railR = new THREE.Mesh(guideGeo, housingMat);
      railR.position.set(+railOff, -strutLen * 0.025, 0);
      railR.name = `GuideRail_${i}_R`;
      springGroup.add(railR);
      springGroup.position.y = -strutLen * 0.95;
      springGroup.name = `CrossbowSpring_${i}`;
      pivotGroup.add(springGroup);

      for (const frac of [0.25, 0.50, 0.75]) {
        const ring = new THREE.Mesh(ribGeo, ribMat);
        ring.position.y = -strutLen * frac;
        ring.rotation.x = Math.PI / 2;   // torus plane ⊥ strut Y-axis
        ring.name = `RibRing_${i}_${frac * 100}`;
        ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        pivotGroup.add(ring);
      }

      const rootCollar = new THREE.Mesh(rootCollarGeo, rootCollarMat);
      // Ø60 × 75 end fitting, 40…115 mm out from the pivot.
      rootCollar.position.y = -(TUBE_ROOT + ROOT_COLLAR_LEN / 2);
      rootCollar.name = `RootCollar_${i}`;
      rootCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivotGroup.add(rootCollar);

      const lug = new THREE.Mesh(lugGeo, rootCollarMat);
      // geometry already spans 10 mm behind the pivot … 40 mm out (Lathe about the strut axis)
      lug.name = `RootCollar_${i}_Lug`;
      lug.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivotGroup.add(lug);

      const loop = new THREE.Mesh(loopGeo, rootCollarMat);
      loop.position.y = -(TUBE_ROOT + ROOT_COLLAR_LEN + M * 0.006);
      loop.rotation.x = Math.PI / 2;   // ring plane ⊥ the strut axis
      loop.name = `RootCollar_${i}_Loop`;
      loop.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivotGroup.add(loop);

      const tipCollar = new THREE.Mesh(tipCollarGeo, tipCollarMat);
      tipCollar.position.y = -strutLen + M * 0.010;  // at strut tip
      tipCollar.name = `TipCollar_${i}`;
      tipCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivotGroup.add(tipCollar);

      // Default orientation α = π/2: the strut points radially outward. The rotation maps local -Y to the radial
      // direction (cosθ, sinθ, 0) via setFromUnitVectors for exact alignment (same as _updateStruts).
      const radialDir = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const baseQuat = new THREE.Quaternion();
      baseQuat.setFromUnitVectors(new THREE.Vector3(0, -1, 0), radialDir);
      pivotGroup.setRotationFromQuaternion(baseQuat);

      this.add(pivotGroup);

      this.strutPivots.push(pivotGroup);
      this.strutMeshes.push(strut);
      this.strutTipNodes.push(tipNode);
      this.strutGroups.push({ pivotGroup, strut, tipNode, azRad, baseQuat, strutDir: new THREE.Vector3() });
    });
  }

  /**
   * @private — Diverging, open-ended plume frustum with a per-vertex alpha fade to zero at the far (downstream) end.
   * Thin delegate to the shared `makePlumeFrustum` (scene/plumeGeometry.js), which the daughters reuse so Mother and
   * daughter beams share one shape/fade SSOT.
   */
  _makePlumeFrustum(rNear, rFar, len, radial = 12, rings = 4) {
    return makePlumeFrustum(rNear, rFar, len, radial, rings);
  }

  /**
   * @private — Merge indexed geometries (position/normal/uv, already positioned) into one BufferGeometry, so a flange
   * + its bolt heads draw as ONE mesh.
   */
  static _mergeParts(geos) {
    const pos = [], nor = [], uv = [], idx = [];
    let base = 0;
    for (const g of geos) {
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
      uv.push(...g.attributes.uv.array);
      const ix = g.index.array;
      for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
      base += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.setIndex(idx);
    return out;
  }

  /** @private — Config G FEEP thruster array + RCS attitude thrusters */
  _buildThrusters() {
    this.mainThrusters = [];
    this.mainThrusterPlumes = [];
    this.attitudeThrusters = [];
    this.attitudeThrusterPlumes = [];

    // FEEP thrusters are small boxes, not bells (owner 2026-10-13; DECISIONS.md): a field-emission thruster is a ~100 mm
    // box (ENPULSION IFM Nano R3: 98-101 x 99 x 97 mm) with a small emitter aperture and a neutraliser on its face and
    // NO bell. Aft face stays at z -1.075 (Constants.THRUSTERS), so the box centre is 50 mm fore of it.
    const FEEP_BOX = 0.10, FEEP_FACE_Z = -1.075, FEEP_BOX_Z = FEEP_FACE_Z + FEEP_BOX / 2;   // -1.025
    const FEEP_APERTURE_R = 0.015, FEEP_PLATE_R = 0.028;
    const nozzleGeo = new THREE.BoxGeometry(M * FEEP_BOX, M * FEEP_BOX, M * FEEP_BOX);
    const feepNeutraliserGeo = new THREE.CylinderGeometry(M * 0.005, M * 0.005, M * 0.012, 24);
    const feepPlateGeo = new THREE.CircleGeometry(M * FEEP_PLATE_R, 48);
    const feepApertureGeo = new THREE.CircleGeometry(M * FEEP_APERTURE_R, 48);
    const feepPlateMat = new THREE.MeshStandardMaterial({ color: 0x23252b, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide });

    // Map thruster index → Constants.THRUSTERS id (for interlock visual)
    const thrusterIds = ['HT_TOP', 'HT_BOTTOM', 'HT_RIGHT', 'HT_LEFT'];

    // Recessed aft thruster deck: a shallow mounting plate the 4 FEEP boxes sit on, so the cluster reads as attached
    // hardware. Sits just aft of the rear cap (z=-M*1.0) on a distinct z-plane (z=-M*1.008) with DETAIL order so it does
    // not z-fight the cap face; radius covers the ±0.2M cross while staying inside the 0.40M hull.
    const deckGeo = new THREE.CylinderGeometry(M * 0.30, M * 0.30, M * 0.04, 64);
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.45,
    });
    const aftDeck = new THREE.Mesh(deckGeo, deckMat);
    aftDeck.rotation.x = Math.PI / 2;
    aftDeck.position.set(0, 0, -M * 1.008);
    aftDeck.name = 'AftThrusterDeck';
    aftDeck.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(aftDeck);

    // 4 main FEEP thrusters at aft face, cross pattern (Config G barrel)
    const mainPositions = [
      { x: 0, y: M * 0.2 },  // top
      { x: 0, y: -M * 0.2 }, // bottom
      { x: M * 0.2, y: 0 },  // right
      { x: -M * 0.2, y: 0 }, // left
    ];

    mainPositions.forEach((pos, i) => {
      const thruster = new THREE.Mesh(nozzleGeo, this._matFEEP);
      thruster.position.set(pos.x, pos.y, M * FEEP_BOX_Z);   // box centre; aft face z -1.075
      thruster.rotation.x = Math.PI / 2;
      thruster.name = `MainFEEP_${i}`;
      thruster._thrusterId = thrusterIds[i]; // for interlock visual lookup
      // Explicit DETAIL order: the box passes through the OPAQUE deck/cap, so it must not sort at the default 0 beneath them.
      thruster.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(thruster);
      this.mainThrusters.push(thruster);

      // Emitter aperture: a small dark-blue disc on the box face, the surface the ion beam leaves. Keeps the old liner's
      // name + emissive material (_animateThrusterGlow lights it). Local frame: the parent is rotated pi/2 about X, so
      // local +Y = world +Z and a child circle turned another pi/2 faces aft (-Z). Plate 1.2 mm aft of the box face,
      // aperture 1.2 mm aft of the plate: never coplanar, and each within the 1.5 mm 'touching' distance of
      // test-NothingFloats of what it sits on (a larger standoff makes them floaters).
      const apertureMat = this._matFEEPInner.clone();
      apertureMat.side = THREE.DoubleSide;
      const innerLiner = new THREE.Mesh(feepApertureGeo, apertureMat);
      innerLiner.name = `FEEPInner_${i}`;
      innerLiner.position.y = M * (FEEP_FACE_Z - 0.0024 - FEEP_BOX_Z);    // world z -1.0774
      innerLiner.rotation.x = Math.PI / 2;
      innerLiner.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      thruster.add(innerLiner);

      // Mounting boss (flange ring where the thruster leaves the deck). The parent has rotation.x=π/2 mapping local +Y →
      // world +Z, so boss.position.y is the axis along the nozzle and the cylinder (along local Y) aligns with world Z
      // without extra rotation.
      const bossGeo = new THREE.CylinderGeometry(M * 0.07, M * 0.07, M * 0.03, 48);
      const bossMat = new THREE.MeshStandardMaterial({
        color: 0x444455, metalness: 0.7, roughness: 0.3,
      });
      const boss = new THREE.Mesh(bossGeo, bossMat);
      // At local −0.028 → world z −1.028 (h 0.03 → −1.013…−1.043): it straddles the AftThrusterDeck's aft face (−1.028),
      // 15 mm buried, 15 mm proud: a visible flange collar round the thruster where it emerges.
      boss.position.y = M * (-1.028 - FEEP_BOX_Z);   // world z -1.028
      boss.name = `FEEP_Boss_${i}`;   // unique per bell: cull matches by prefix
      boss.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      thruster.add(boss);

      // Emitter plate: the dark plate round the aperture, in the old grid disc's slot (name, CircleGeometry, DoubleSide
      // kept). 1.2 mm aft of the box face (world z -1.0762), opaque.
      const gridDisc = new THREE.Mesh(feepPlateGeo, feepPlateMat);
      gridDisc.position.y = M * (FEEP_FACE_Z - 0.0012 - FEEP_BOX_Z);
      gridDisc.rotation.x = Math.PI / 2;
      gridDisc.name = `FEEP_GridDisc_${i}`;   // unique per bell: cull matches by prefix
      gridDisc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      thruster.add(gridDisc);

      // Two neutraliser tubes (thermionic cathodes) either side of the plate, tangential to the cross pattern: r 5 mm,
      // 12 mm long, 2 mm buried in the face, 10 mm proud.
      for (let k = 0; k < 2; k++) {
        const nt = new THREE.Mesh(feepNeutraliserGeo, this._matFEEP);
        const off = (k === 0 ? -1 : 1) * M * 0.036;
        nt.position.set(pos.x === 0 ? off : 0, M * (FEEP_FACE_Z - 0.004 - FEEP_BOX_Z), pos.x === 0 ? 0 : off);
        nt.name = `FEEP_Neutraliser_${i}_${k}`;
        nt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        thruster.add(nt);
      }

      // FEEP nozzle glow ring (sized to the nozzle aperture).
      const glowGeo = new THREE.RingGeometry(M * FEEP_APERTURE_R, M * 0.055, 48);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x99bbdd, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(pos.x, pos.y, -M * 1.082);   // 7 mm aft of the box face and 4.6 mm aft of the aperture: never coplanar
      glow.name = `MainFEEPGlow_${i}`;
      glow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      this.add(glow);

      // FEEP plume: diverging ion beam, an open frustum narrow at the exit (r = nozzle exit 0.06M) widening to ~2.2×
      // downstream, vertex-alpha fading to 0 at the tip (a converging cone reads as a chemical flame: wrong for
      // field-emission). Kept in mainThrusterPlumes as a Mesh with .material.opacity/.color/.visible, the exact hooks
      // _animateThrusterGlow drives.
      const plumeGeo = this._makePlumeFrustum(M * FEEP_APERTURE_R, M * 0.13, M * 0.35);
      const feepPlumeMat = new THREE.MeshBasicMaterial({
        color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const plume = new THREE.Mesh(plumeGeo, feepPlumeMat);
      plume.position.set(pos.x, pos.y, -M * 1.075);  // near end welded to nozzle exit
      plume.rotation.x = -Math.PI / 2;               // beam local +Y → world -Z (aft)
      plume.name = `MainFEEPPlume_${i}`;
      plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      plume.visible = false;
      this.add(plume);
      this.mainThrusterPlumes.push(plume);

      // Outer glow halo — longer, wider, fainter diverging frustum around the core.
      const outerGlowGeo = this._makePlumeFrustum(M * FEEP_APERTURE_R, M * 0.17, M * 0.75);
      const outerGlowMat = new THREE.MeshBasicMaterial({
        color: 0xaaccee, transparent: true, opacity: 0.0, vertexColors: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
      outerGlow.position.set(pos.x, pos.y, -M * 1.075);
      outerGlow.rotation.x = -Math.PI / 2;
      outerGlow.name = `MainFEEPOuterGlow_${i}`;
      outerGlow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      outerGlow.visible = false;
      this.add(outerGlow);

      this._thrusterGlowTargets.set(thruster, { glow, plume, outerGlow, innerLiner, intensity: 0 });
    });

    // RCS: 4 doghouse quad pods. NO plinth: the housing is SEMI-RECESSED, its base buried RCS_BURY (10 mm) BELOW the hull
    // surface, so its flat bottom edges land inside the hull and no under-gap shows from any angle (the box sides cross
    // the MLI at a steep angle: no log-depth z-fight, which only bites near-parallel coincident surfaces). This is how
    // real doghouses read: the MLI blanket closes out around a base that emerges from the hull.
    // Each pod (2 azimuth columns × 2 z-stations) carries 3 nozzles: RADIAL (±Y), AXIAL (±Z), TANGENTIAL (canted ±X), so
    // all six local translation directions show a plume (a Draco-style cluster), with 2 nozzles per ±X/±Y/±Z axis for
    // single-nozzle-failure redundancy.
    // Placement (all guarded from BUILT geometry by test-RcsPlacement.js, never trust these comments):
    //   • azimuth = 94.65°/274.65°: centred in the stow-pocket gap, ~2.9° clear of both pocket edges (boot footprint,
    //     ≥2° gate). Near-orthogonal to the ROSA wings (0°/180°, 4.65° off), so radial/axial exhaust never washes the
    //     blankets.
    //   • |z| = 0.775 m, housing 0.06 m long → pod z-span 0.745–0.805 m: 2.5 cm clear of the PV end rows (edge 0.72) and
    //     of the collar cluster. The axial bell's throat sits ON the housing end face, so its mouth is at z 0.8655.
    //   • TANGENTIAL bells are canted RCS_TANG_CANT (18°) radially outward: an uncanted ±X plume runs parallel just
    //     ~0.44 m above the wing plane and a ~25° cold-gas boundary would clip the outer wing beyond ~0.8 m; the cant
    //     lifts the boundary clear (≥0.24 m above the plane at the wing tip) while still firing at cos18°=0.95
    //     intensity for ±X demand.
    const RCS_POD_Z    = 0.775;   // m — pod centre |z| station (fore/aft)
    const RCS_POD_W    = 0.12;    // m — tangential width
    const RCS_POD_L    = 0.06;    // m — axial length
    const RCS_POD_H    = 0.055;   // m — radial height
    const RCS_BURY     = 0.010;   // m — housing base buried below hull (no under-gap, no plinth)
    const RCS_BELL_LEN = 0.06;    // m — nozzle bell length (throat 0.015 → exit 0.025)
    const RCS_TANG_CANT = degToRad(18);  // rad — tangential bell outward cant (ROSA plume clearance)

    // Liner inset: the RCS exit is 0.025 m, so 0.88 would leave only 3.0 mm (< 4 mm log-depth minimum); 0.82 gives
    // 0.025·0.18 = 4.5 mm: a deterministic tie-pass at the bell mouth.
    const RCS_LINER_INSET = 0.82;

    // Azimuth columns: centred in the stow-pocket gap: weaver pocket edge 82.61° (az 64 + 18.62° half-width), spinner
    // edge 106.69° (az 116 − 9.31°), centre 94.65°/274.65°. Worst clearance 2.91° (boot edge vs BOTH pockets), measured
    // from the built footprints with the guard's own math, above the ≥2° gate at the strut clock 64/116/244/296. The PV
    // gap cells at 90/270 are z-clear of the pods (cell band 0.48–0.72 vs pod |z| ≥ 0.737). The SSOT half-widths are
    // still read below only for the clearance context.
    const barrelR_m = Constants.OCTOPUS_V5?.COLLAR_RADIUS ?? 0.40;
    const RCS_POD_AZ_DEG = [94.65, 274.65];

    // owner 2026-10-14 ("white box visible inside bell"): the housing is shaped AROUND the three bells instead of a plain
    // 0.12 m block they were buried in. In the pod's own tangent axis, measured towards the side the tangential bell
    // fires (u): the back wall stays at -RCS_POD_W/2 (-60 mm), the exhaust-side wall is pulled in to RCS_POD_U1 (-3 mm).
    // The radial and axial bells sit on the centre of the shortened block; the tangential bell's throat sits on its
    // exhaust-side wall, so the three cavities never meet each other or the housing.
    const RCS_POD_U1 = -0.003;                          // m — exhaust-side wall (u)
    const RCS_POD_WIDTH = RCS_POD_U1 + RCS_POD_W / 2;   // m — 57 mm
    const RCS_POD_CU = (RCS_POD_U1 - RCS_POD_W / 2) / 2;   // m — block centre in u (-31.5 mm)
    const podGeo = new THREE.BoxGeometry(M * RCS_POD_WIDTH, M * RCS_POD_L, M * RCS_POD_H);
    const podMat = new THREE.MeshStandardMaterial({
      color: 0x9090a8, metalness: 0.72, roughness: 0.30,   // 6061-T6 CNC (matches A-frame gray)
    });
    // MLI close-out boot: the darker gold/bronze lip where the housing emerges from the blanket; one per pod, buried base.
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x6e5a30, metalness: 0.55, roughness: 0.55,   // darker gold/bronze close-out
    });
    const bootGeo = new THREE.BoxGeometry(
      M * (RCS_POD_WIDTH + 0.006), M * (RCS_POD_L + 0.016), M * 0.012,
    );
    // Corner bolts: Ti fasteners on the housing outer face (the collar's boltMat is local to _buildCollar, so a fresh one).
    const podBoltMat = new THREE.MeshStandardMaterial({
      color: 0x99aabb, metalness: 0.80, roughness: 0.20,
    });
    const podBoltGeo = new THREE.CylinderGeometry(M * 0.004, M * 0.004, M * 0.005, 6);
    // 48-seg bells: pods are end-mounted focal hardware at inspect zoom. Throat 0.015 → exit 0.025 (Ø50 mm), 0.06 m long.
    const bellGeo = new THREE.CylinderGeometry(M * 0.015, M * 0.025, M * RCS_BELL_LEN, 48, 1, true);
    const linerGeo = new THREE.CylinderGeometry(
      M * 0.015 * RCS_LINER_INSET, M * 0.025 * RCS_LINER_INSET, M * RCS_BELL_LEN, 48, 1, true,
    );
    const linerMat = new THREE.MeshStandardMaterial({
      color: 0x22242c, metalness: 0.6, roughness: 0.5,     // dark cold-gas throat
      side: THREE.BackSide,
    });
    // Throat funnel: the converging section of a real bell. A 3-step lathe from the liner wall down to a throat of exit
    // Ø / 12 (ArianeGroup 10 N: Ø2.85 / Ø35 = 12.3:1), closed by a dark plate. 24 segments (r <= 12 mm, v1 rule),
    // inside the 48-gon liner.
    const RCS_EXIT_R = 0.025, RCS_THROAT_AREA_RATIO_D = 12;
    const rcsThroatR = RCS_EXIT_R / RCS_THROAT_AREA_RATIO_D;   // 2.08 mm -> throat Ø 4.2 mm
    const linerRAt = (y) => 0.015 * RCS_LINER_INSET + (0.025 - 0.015) * RCS_LINER_INSET * ((RCS_BELL_LEN / 2 - y) / RCS_BELL_LEN);
    const fY = [0.0255, 0.0272, 0.0285, 0.0297];     // bell-local y of the four funnel rings (+y = throat end)
    const throatFunnelGeo = new THREE.LatheGeometry([
      new THREE.Vector2(linerRAt(fY[0]) * 0.96 * M, fY[0] * M),
      new THREE.Vector2(0.0085 * M, fY[1] * M),
      new THREE.Vector2(0.0045 * M, fY[2] * M),
      new THREE.Vector2(rcsThroatR * M, fY[3] * M),
    ], 24);   // v1 rule: 24-gon for r 5..20 mm
    const throatFunnelMat = new THREE.MeshStandardMaterial({
      color: 0x15161c, metalness: 0.55, roughness: 0.6,    // dark, darker than the liner (recessed injector)
      side: THREE.DoubleSide, emissive: 0x000000,
    });
    const throatPlateGeo = new THREE.CircleGeometry(M * rcsThroatR, 24);
    // Exit lip: the mouth rolls out into a thin flared rim, 1.2 mm wider than the bell exit (one cone segment; starts
    // 0.3 mm outside the wall, so it never ties with it).
    const rcsLipGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0.0249 * M, -0.0275 * M),
      new THREE.Vector2(0.0262 * M, -0.0302 * M),
    ], 48);
    // Radial-bell mounting flange + 4 bolt heads (one merged mesh): a RING (not a disc, so it never crosses the bell
    // cavity) of outer r 26 mm, inner r 16.5 mm (1.1 mm clear of the bell wall), standing 3 mm proud of the housing
    // face and 1 mm buried in it. Bell-local y: the bell throat plane is y 0.0300, 0.5 mm off the face (y 0.0305);
    // ring y 0.0275 (top) .. 0.0315 (buried); heads on a 21.5 mm circle at 45 deg steps, 1 mm sunk into the ring top.
    const rcsFlangeGeo = (() => {
      const parts = [];
      const fl = new THREE.LatheGeometry([
        new THREE.Vector2(M * 0.0165, M * 0.0275),   // inner edge of the top annulus (the 1.1 mm slot to the bell wall)
        new THREE.Vector2(M * 0.026, M * 0.0275),
        new THREE.Vector2(M * 0.026, M * 0.0315),    // outer wall down into the housing
      ], 48);
      parts.push(fl);
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + k * Math.PI / 2;
        const h = new THREE.CylinderGeometry(M * 0.0025, M * 0.0025, M * 0.0035, 12);
        h.translate(Math.cos(a) * M * 0.0215, M * 0.0267, Math.sin(a) * M * 0.0215);
        parts.push(h);
      }
      return PlayerSatellite._mergeParts(parts);
    })();
    const rcsFlangeMat = new THREE.MeshStandardMaterial({ color: 0x8a8a9a, metalness: 0.75, roughness: 0.3, side: THREE.DoubleSide });
    // Mount collar: the axial and tangential bells start ON or just outside a pod face, so each gets a short cylindrical
    // collar behind its throat plane (bell-local +y, away from the mouth) that ties it into the housing. Side wall +
    // rear cap on the axial bell (the cap shows above the housing roof); side wall + a full front disc on the
    // tangential bell (closing the throat from behind; its rear end is buried in the housing); one cap each keeps the
    // triangle count down. 24-gon (r 5..20 mm, v1 rule). Length is per bell (built in buildNozzle); nothing of it lies
    // on the mouth side of the throat plane, so it never enters a cavity.
    const RCS_MOUNT_R = 0.0165;
    const RCS_THROAT_GAP = 0.0005;   // m — every bell's throat plane stands this far OUTSIDE the housing face it sits on
    const rcsMountGeo = (len, rearCap) => new THREE.LatheGeometry(rearCap
      ? [new THREE.Vector2(M * RCS_MOUNT_R, 0), new THREE.Vector2(M * RCS_MOUNT_R, M * len), new THREE.Vector2(0, M * len)]
      : [new THREE.Vector2(0, 0), new THREE.Vector2(M * RCS_MOUNT_R, 0), new THREE.Vector2(M * RCS_MOUNT_R, M * len)], 24);

    // RCS plume: short, puffy, white-gray cold gas (NOT ion blue). Near end welds to the nozzle exit; +Y beam axis
    // aimed along each nozzle's exhaust dir.
    const rcsPlumeGeo = makePlumeFrustum(M * 0.015, M * 0.041, M * 0.10, 8, 2);
    const rcsPlumeMat = new THREE.MeshBasicMaterial({
      color: 0xccd2dc, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const yUpBeam = new THREE.Vector3(0, 1, 0);  // bell/plume geometry axis

    // Per-nozzle exhaust dirs + local positions: direction-aware firing (a nozzle lights when its EXHAUST opposes the
    // thrust demand) and puff-spawn snapping.
    this._rcsExhaustDir = [];
    this._rcsNozzleLocalPos = [];
    // Per-bell liner meshes (index-aligned with attitudeThrusterPlumes), each with a CLONED material: a shared one would
    // light all 12 throats whenever any one fires.
    this._rcsLiners = [];

    /** One bell+liner+plume cluster; exhaustDir = unit vector the plume exits along (throat faces −exhaustDir). */
    const buildNozzle = (name, centre, exhaustDir, withFlange = false, mountLen = 0, rearCap = false) => {
      const bell = new THREE.Mesh(bellGeo, this._matRCS);
      bell.position.copy(centre);
      // CylinderGeometry: +Y = radiusTop (throat 0.015), −Y = radiusBottom (exit 0.025). Map +Y → −exhaust so the
      // wide mouth flares along the exhaust.
      bell.quaternion.setFromUnitVectors(yUpBeam, _v3TmpA.copy(exhaustDir).negate());
      bell.name = name;
      // Explicit DETAIL order: the bells cross the OPAQUE housing face/boot, so never leave them at the default 0.
      bell.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(bell);
      this.attitudeThrusters.push(bell);

      const liner = new THREE.Mesh(linerGeo, linerMat.clone());
      liner.name = name.replace('RCSThruster', 'RCSLiner');
      liner.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(liner);
      this._rcsLiners.push(liner);   // index-aligned with attitudeThrusterPlumes

      // Throat funnel (3-step lathe) + the dark plate that closes the throat, children of the bell.
      const funnel = new THREE.Mesh(throatFunnelGeo, throatFunnelMat);
      funnel.name = name.replace('RCSThruster', 'RCSThroat');
      funnel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(funnel);
      const plate = new THREE.Mesh(throatPlateGeo, throatFunnelMat);
      plate.position.set(0, M * fY[3], 0);
      plate.rotation.x = Math.PI / 2;   // circle normal +Z -> -Y (out the mouth)
      plate.name = name.replace('RCSThruster', 'RCSThroatPlate');
      plate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(plate);
      const lip = new THREE.Mesh(rcsLipGeo, this._matRCS);
      lip.name = name.replace('RCSThruster', 'RCSLip');
      lip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(lip);
      if (mountLen > 0) {
        const mount = new THREE.Mesh(rcsMountGeo(mountLen, rearCap), rcsFlangeMat);
        mount.name = name.replace('RCSThruster', 'RCSMount');
        mount.position.y = M * (RCS_BELL_LEN / 2);   // starts at the throat plane, runs back (+y) into the housing
        mount.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        bell.add(mount);
      }
      if (withFlange) {
        const flange = new THREE.Mesh(rcsFlangeGeo, rcsFlangeMat);
        flange.name = name.replace('RCSThruster', 'RCSFlange');
        flange.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        bell.add(flange);
      }

      const exit = _v3TmpB.copy(centre).addScaledVector(exhaustDir, M * (RCS_BELL_LEN / 2));
      const plume = new THREE.Mesh(rcsPlumeGeo, rcsPlumeMat.clone());
      plume.position.copy(exit).addScaledVector(exhaustDir, M * 0.005);
      plume.quaternion.setFromUnitVectors(yUpBeam, exhaustDir);  // +Y beam → exhaust
      plume.name = name.replace('RCSThruster', 'RCSPlume');
      plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      plume.visible = false;
      this.add(plume);
      this.attitudeThrusterPlumes.push(plume);

      this._rcsExhaustDir.push(exhaustDir.clone());
      // Puff origin = the nozzle MOUTH (exit + 1 cm outward), NOT the bell centre: a glow at the centre is occluded by
      // the depth-tested bell wall. Torque sign is unchanged (same radial line, slightly longer arm).
      const puffOrigin = _v3TmpB.copy(centre).addScaledVector(exhaustDir, M * (RCS_BELL_LEN / 2 + 0.01));
      this._rcsNozzleLocalPos.push(puffOrigin.clone());
    };

    let podIdx = 0;
    for (let col = 0; col < RCS_POD_AZ_DEG.length; col++) {
      const az = degToRad(RCS_POD_AZ_DEG[col]);
      const azSign = col === 0 ? 1 : -1;   // +Y column (0) / −Y column (1)
      const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const podBasis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), radial).normalize(), // tangent
        new THREE.Vector3(0, 0, 1),
        radial,
      );

      for (const station of [1, -1]) {   // fore (+z) / aft (−z)
        const podZ = station * M * RCS_POD_Z;

        // The tangential bell's direction decides which way the housing is trimmed (see RCS_POD_U1). Canted
        // RCS_TANG_CANT (18°) radially OUTWARD from the pure ±X axis so its cold-gas plume clears the ROSA wing plane
        // (an uncanted ±X plume runs ~0.44 m above it and would clip the outer wing); still fires at cos18°=0.95 for ±X
        // demand. The ±X sign is distributed across the 4 pods (fore/aft × col) so BOTH +X and −X exhaust exist:
        //   +Y col: fore→+X, aft→−X ;  −Y col: fore→−X, aft→+X.
        const tangSignX = station * azSign;
        const tangDir = new THREE.Vector3(tangSignX, 0, 0)
          .multiplyScalar(Math.cos(RCS_TANG_CANT))
          .addScaledVector(radial, Math.sin(RCS_TANG_CANT))
          .normalize();
        const tvec = new THREE.Vector3(-Math.sin(az), Math.cos(az), 0);   // the pod's tangent axis (podBasis x)
        const et = tangDir.dot(tvec), er = tangDir.dot(radial);
        const tSide = Math.sign(et);                                      // +1: exhaust runs towards +tvec
        const podCentreT = tSide * RCS_POD_CU;                            // block centre along tvec (m)

        // Doghouse housing: SEMI-RECESSED, NO plinth. Base buried RCS_BURY (10 mm) below the hull so the flat bottom
        // edges land inside the hull and no under-gap shows (box sides cross the MLI at a steep angle: no z-fight).
        // Centre at hull − BURY + half-height; outer face is faceR.
        const housingBaseR = M * (barrelR_m - RCS_BURY);   // base buried below hull
        const podR = housingBaseR + M * (RCS_POD_H / 2);
        const pod = new THREE.Mesh(podGeo, podMat);
        pod.position.set(
          radial.x * podR + tvec.x * M * podCentreT,
          radial.y * podR + tvec.y * M * podCentreT,
          podZ,
        );
        pod.quaternion.setFromRotationMatrix(podBasis);
        pod.name = `RCSPod_${podIdx}`;
        pod.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(pod);

        // MLI close-out boot: a low lip framing the housing where it emerges from the blanket. A FLAT box on a curved
        // hull: at its ±0.063 tangential corners the skin sags to r 0.395. Centre hullR − 2 mm: the 12 mm slab spans
        // r 0.392–0.404 → 3 mm buried at the corners, 4 mm (centre) to 9 mm (corners) proud.
        const bootR = M * (barrelR_m - 0.002);
        const boot = new THREE.Mesh(bootGeo, bootMat);
        boot.position.set(
          radial.x * bootR + tvec.x * M * podCentreT,
          radial.y * bootR + tvec.y * M * podCentreT,
          podZ,
        );
        boot.quaternion.setFromRotationMatrix(podBasis);
        boot.name = `RCSPodBoot_${podIdx}`;
        boot.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(boot);

        // Corner bolts: 4 on the housing outer face, inset ~12 mm from the face corners, oriented radially. Positioned
        // in pod-local space (x = tangential, y = axial, z = radial), baked into the mother frame via pod.matrix and
        // parented to `this`: as pod children, Box3.setFromObject misses the pod transform for the placement guards.
        pod.updateMatrix();
        const boltInsetX = M * (RCS_POD_WIDTH / 2 - 0.005);
        const boltInsetY = M * (RCS_POD_L / 2 - 0.005);
        const boltZ = M * (RCS_POD_H / 2);   // on the outer face
        let boltN = 0;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const bolt = new THREE.Mesh(podBoltGeo, podBoltMat);
            bolt.position.set(sx * boltInsetX, sy * boltInsetY, boltZ);
            bolt.rotation.x = Math.PI / 2;   // +Y → pod-local +z (radial)
            bolt.updateMatrix();
            bolt.applyMatrix4(pod.matrix);   // bake pod transform → mother-local
            bolt.name = `RCSPodBolt_${podIdx}_${boltN}`;
            bolt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
            this.add(bolt);
            boltN++;
          }
        }

        const faceR = podR + M * (RCS_POD_H / 2);  // housing outer face radius (~0.445 m)

        // RADIAL nozzle: on the outer face, exhaust radially outward (±Y column). The throat plane sits 0.5 mm OUTSIDE the
        // face (bell centre faceR + 30.5 mm), so the grey housing never cuts across the bell cavity (same for the axial
        // and tangential bells). The mounting flange is a ring.
        const radialCentre = new THREE.Vector3(
          radial.x * (faceR + M * (RCS_BELL_LEN / 2 + RCS_THROAT_GAP)) + tvec.x * M * podCentreT,
          radial.y * (faceR + M * (RCS_BELL_LEN / 2 + RCS_THROAT_GAP)) + tvec.y * M * podCentreT,
          podZ,
        );
        buildNozzle(`RCSThruster_${podIdx}_R`, radialCentre, radial.clone(), true);

        // AXIAL nozzle: corner-mounted at the pod's outboard-z end, exhaust ±Z (fore pods +Z, aft −Z). Axis radius
        // (faceR + 7 mm): the mouth min radial 0.427 > the hinge A-frame apex 0.4214 and the 0.415 collar guard
        // (test-RcsPlacement guards the PV/groove/hull clearances from geometry). Throat plane 0.5 mm outside the END
        // face (bell centre 60.5 mm from the pod centre, mouth 90.5 mm: 60 mm clear of the housing); a 10 mm collar ties
        // it in.
        const axialR = faceR + M * (0.015 - 0.008);
        const axialCentre = new THREE.Vector3(
          radial.x * axialR + tvec.x * M * podCentreT,
          radial.y * axialR + tvec.y * M * podCentreT,
          podZ + station * M * (RCS_POD_L / 2 + RCS_THROAT_GAP + RCS_BELL_LEN / 2),
        );
        buildNozzle(`RCSThruster_${podIdx}_A`, axialCentre, new THREE.Vector3(0, 0, station), false, 0.010, true);

        // TANGENTIAL nozzle (direction: see tangDir above). The throat is slid 2 mm along the bell line so its disc
        // touches the housing's exhaust-side wall 0.5 mm clear (the disc leans 13..23 deg off the wall, so its nearest
        // point is 15 mm x |radial part of the axis| from the disc centre); a short collar ties it in.
        const uT = RCS_POD_U1 + RCS_THROAT_GAP + 0.015 * Math.abs(er);   // throat centre, exhaust-oriented tangent (m)
        const slideT = uT / Math.abs(et);                                 // slide along the axis, from the old centre
        const tangThroat = new THREE.Vector3(radial.x * faceR, radial.y * faceR, podZ).addScaledVector(tangDir, M * slideT);
        // Collar: back along the axis to the wall, plus 4 mm so its rear cap lies inside the housing.
        const tangMount = (uT - RCS_POD_U1) / Math.abs(et) + 0.004;
        const tangCentre = tangThroat.clone().addScaledVector(tangDir, M * (RCS_BELL_LEN / 2));
        buildNozzle(`RCSThruster_${podIdx}_T`, tangCentre, tangDir, false, tangMount);

        podIdx++;
      }
    }

    // Per-nozzle ATTITUDE flash intensity: rotation demand lights the couple bells' plume cones/liners directly,
    // decoupled from the puff cadence. Index-aligned with attitudeThrusterPlumes / _rcsLiners.
    this._rcsAttitudeFlash = new Float32Array(this.attitudeThrusterPlumes.length);
  }

  /**
   * @private ROSA (Roll-Out Solar Array) panels: two compact panels at 0° and 180° azimuths (±X from barrel centre).
   *
   * Scene hierarchy per wing:
   * ```
   *   panelRightPivot (Group — sun-tracking tilt / feather rotation)
   *     ├─ _rosaPanelWrapper1 (Group — scale.x drives roll-out)
   *     │    ├─ ROSA_Panel_Front_0deg (PlaneGeometry — FrontSide cell-string surface, local z = +2 mm)
   *     │    └─ ROSA_Panel_Back_0deg  (PlaneGeometry — BackSide copper-Kapton substrate, local z = −2 mm)
   *     └─ ROSA_Spool_0deg            (Group — drum + stow-coil bulge; the rolled-up read)
   * ```
   *
   * The blanket is a plain square-cornered rectangle (real ROSA wings are NOT chamfered) carrying the shared
   * procedural solar-cell texture, which carries the cell detail. The slit-tube booms (built in `_buildRosaStructure`)
   * provide the edge structure. UVs are oriented so the cell strings run along the deploy/X axis.
   */
  /**
   * ROSA blanket inboard-edge standoff from the wrapper origin (= the drum axis), scene units: drumR + 1 mm, so the
   * blanket, both edge booms and the tip spreader start at the drum SURFACE. One source for `_buildSolarPanels`
   * (blanket) and `_buildRosaStructure` (booms/spreader).
   */
  static rosaInboardGap() {
    return (Constants.OCTOPUS_V5.ROSA_DRUM_R + 0.001) * M;
  }

  /**
   * Radius of the FURLED ROSA coil, in METRES, derived from the blanket it holds instead of asserted: a blanket of
   * thickness `t` and rolled length `L` wound onto a mandrel of radius `r` is an Archimedean spiral; equating the
   * wound cross-section area to the flat strip's gives
   *
   *     R = sqrt(r² + L·t/π)
   *
   * with L = ROSA_WIDTH (the width is the dimension that rolls; the 2.0 m LENGTH runs along the barrel and is the
   * coil's length, not its wrap) and t = ROSA_BLANKET_T (blanket + flattened edge-boom allowance).
   *
   * @returns {number} furled coil radius in metres (NOT scene units)
   */
  static rosaFurledCoilRadiusM() {
    const V5 = Constants.OCTOPUS_V5;
    return Math.sqrt(V5.ROSA_DRUM_R * V5.ROSA_DRUM_R + (V5.ROSA_WIDTH * V5.ROSA_BLANKET_T) / Math.PI);
  }

  /**
   * Distance from the SHIP axis to a ROSA spool axis, in METRES: the spool sits on the root bracket, `rootX` outboard
   * of the sun-tracking pivot, and the pivot sits on the bus collar:
   *
   *     spoolAxis = COLLAR_RADIUS + (ROSA_BRACKET_LEN + 0.4·ROSA_DRUM_R)
   *
   * One source for `_buildRosaStructure` (builds at `rootX` in scene units) and for the clearance pins in
   * `js/test/_flowerFold.js` and `test-RosaFurl.js`, which measure the furled coil about this line. A helper, not three
   * literals: ROSA_BRACKET_LEN is a live lever, and a hard-coded value left behind is the drift those pins exist to catch.
   * @returns {number} spool-axis offset in metres (NOT scene units)
   */
  static rosaSpoolAxisM() {
    const V5 = Constants.OCTOPUS_V5;
    return V5.COLLAR_RADIUS + PlayerSatellite.rosaRootStandoffM();
  }

  /** Bracket standoff from the sun-tracking pivot to the spool axis, in METRES. */
  static rosaRootStandoffM() {
    const V5 = Constants.OCTOPUS_V5;
    return V5.ROSA_BRACKET_LEN + Constants.OCTOPUS_V5.ROSA_ROOT_DRUM_FRAC * V5.ROSA_DRUM_R;
  }

  _buildSolarPanels() {
    const V5      = Constants.OCTOPUS_V5;
    const rosaW   = V5.ROSA_WIDTH * M;       // 1.0 m → scene (radial deploy / X)
    const rosaL   = V5.ROSA_LENGTH * M;      // 2.0 m → scene (axial / Y→world Z)
    const barrelR = V5.COLLAR_RADIUS * M;    // 0.4 m → scene

    // Front = brown-black GaAs cells laid in MODULES with orange Kapton tape round each module and thin string lines
    // (js/scene/rosaBlanketTexture.js). ONE texture covers the whole 1 x 2 m blanket (u across the width, v along the
    // length), so no repeat. Null in headless (no DOM); the material tolerates a null map (tint falls back to the dark
    // cell colour).
    const frontMap = getRosaFrontTexture();
    const frontEmissiveMap = getRosaFrontEmissiveTexture();
    const panelMatFront = new THREE.MeshPhysicalMaterial({
      color: frontMap ? 0xffffff : 0x0a1133, // tint comes from the map when present
      map: frontMap || null,
      // Softer specular: real PV blankets are anti-reflective and fairly matte. Low metalness, high roughness and a
      // weak, rough clearcoat keep the sun glint from blowing out under the intensity-2.0 sun + ACES tonemapping.
      metalness: 0.25, roughness: 0.62,
      side: THREE.FrontSide,
      emissive: 0x1e3cff, emissiveIntensity: 0.30, // royal blue (matches _animateRosaGlow)
      emissiveMap: frontEmissiveMap || null,       // cell interiors only: the glow tints cells, not the tape
      clearcoat: 0.3, clearcoatRoughness: 0.5,
      iridescence: 0.0, // off: 0.5 produced a TEAL thin-film sheen
    });
    this._rosaFrontMats = [panelMatFront];
    // Back substrate: deep amber-brown copper-Kapton (real ROSA backing reads dark amber) with a procedural substrate
    // map (bay-seam grid, stiffener strips, wiring runs, per-bay jitter) so it is not flat cardboard at the top-down
    // inspect angle. Near-matte like real Kapton. The emissive is a self-illuminating floor so the substrate never
    // collapses to pure black facing away from the sun or in shadow (inverted wings would vanish). Keep
    // emissiveIntensity at/above the ROSA_BACK_EMISSIVE_MIN (0.24) floor asserted in js/test/test-RosaFurl.js.
    // Emissive stays UN-masked (never-black floor), same as the front mat.
    // The same back map is tiled over the whole blanket plus ONE cable-harness run (rosaBlanketTexture.js).
    let backMap = getRosaBackHarnessTexture();
    const rosaBackTex = backMap ? null : getRosaBackTexture();
    if (rosaBackTex) {
      backMap = rosaBackTex.clone();
      backMap.repeat.set(2, 5);   // ~2 bay-cols across width × 5 bays along length
      backMap.needsUpdate = true;
    }
    const panelMatBack = new THREE.MeshStandardMaterial({
      color: backMap ? 0xffffff : 0x7a4f26, // tint comes from the map when present
      map: backMap || null,
      metalness: 0.08, roughness: 0.85,
      side: THREE.BackSide,
      emissive: 0x3e2c14, emissiveIntensity: 0.25,
    });
    // No legacy ROSA_Roll_* cylinders: furled, they sat inside the stow-coil bulge with end caps coplanar at z=±1.0
    // (a depth tie). ROSA_StowRoll_* on the spool axis carries the rolled-up read alone.

    // Square-cornered blanket planes (local XY, rotated to XZ via wrapper). Front and back faces are 4 mm apart (front
    // +M*0.002, back −M*0.002): coincident faces shimmer under logarithmicDepthBuffer at the wing's edge-on sweep even
    // with complementary Front/BackSide culling. Kept as two named meshes, NOT a merged box: test-RosaFurl.js and the
    // inverted-visibility guard bind ROSA_Panel_Front/Back and their Front/BackSide semantics. Offsets are M-SCALED
    // mm: 1 scene unit = 100 km, so M*0.002 = 2 mm (always multiply real mm by M).
    // The inboard edge sits ROSA_INBOARD_GAP outboard of the wrapper origin (the drum axis): drumR + 1 mm (51 mm), so
    // the blanket STARTS at the drum surface; the booms and spreader in _buildRosaStructure use the same value
    // (rosaInboardGap()) so they span exactly the blanket. Furled (wrapper scale.x→0.05) collapses the panel toward the
    // drum axis, inside the stow coil.
    const ROSA_HALF_THICK = M * 0.002;   // 2 mm — half the blanket thickness
    const ROSA_INBOARD_GAP = PlayerSatellite.rosaInboardGap();  // 51 mm — inboard-edge standoff
    const panelGeo = new THREE.PlaneGeometry(rosaW, rosaL);

    // Shared solar array pivot: groups both wings as one rigid assembly so they stay coplanar through the ship centre.
    // No Z-rotation: panels extend ±X (orbit-normal direction), horizontal wings from the CHASE camera.
    // Sun-tracking is per-panel via boom-axis tilt (pivot.rotation.x).
    this._solarArrayPivot = new THREE.Group();
    this._solarArrayPivot.name = 'SolarArrayPivot';
    this.add(this._solarArrayPivot);

    // Panel 1: 0° azimuth (+X)
    this.panelRightPivot = new THREE.Group();
    this.panelRightPivot.position.set(barrelR, 0, 0);
    this.panelRightPivot.name = 'PanelRightPivot';
    this._solarArrayPivot.add(this.panelRightPivot);

    this._rosaPanelWrapper1 = new THREE.Group();
    // Wrapper at pivot origin — shape starts at local x=0 (barrel surface)
    this._rosaPanelWrapper1.rotation.x = -Math.PI / 2; // local XY → world XZ
    this.panelRightPivot.add(this._rosaPanelWrapper1);

    const panel1Front = new THREE.Mesh(panelGeo, panelMatFront);
    panel1Front.position.set(rosaW / 2 + ROSA_INBOARD_GAP, 0, ROSA_HALF_THICK); // +2 mm proud (Z1), +5 mm inboard gap (Z2)
    panel1Front.name = 'ROSA_Panel_Front_0deg';
    panel1Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper1.add(panel1Front);

    // Back substrate: 4 mm behind the front face (local z = −2 mm) so the blanket is a real thin panel. FrontSide/
    // BackSide stay complementary (one rasterizes per camera) AND sit at distinct depths, so the edge-on sweep does not
    // shimmer. All offsets here are M-scaled real mm, never raw literals (1 scene unit = 100 km: a raw −0.001 is −100 m).
    const panel1Back = new THREE.Mesh(panelGeo, panelMatBack);
    panel1Back.position.set(rosaW / 2 + ROSA_INBOARD_GAP, 0, -ROSA_HALF_THICK);
    panel1Back.name = 'ROSA_Panel_Back_0deg';
    panel1Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper1.add(panel1Back);

    this._buildRosaStructure(1, this._rosaPanelWrapper1, this.panelRightPivot, +1);

    // Panel 2: 180° azimuth (-X)
    this.panelLeftPivot = new THREE.Group();
    this.panelLeftPivot.position.set(-barrelR, 0, 0);
    this.panelLeftPivot.name = 'PanelLeftPivot';
    this._solarArrayPivot.add(this.panelLeftPivot);

    this._rosaPanelWrapper2 = new THREE.Group();
    this._rosaPanelWrapper2.rotation.x = -Math.PI / 2;
    this.panelLeftPivot.add(this._rosaPanelWrapper2);

    const panel2Front = new THREE.Mesh(panelGeo, panelMatFront);
    panel2Front.position.set(-(rosaW / 2 + ROSA_INBOARD_GAP), 0, ROSA_HALF_THICK); // mirrored; +2 mm proud, +5 mm gap
    panel2Front.name = 'ROSA_Panel_Front_180deg';
    panel2Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper2.add(panel2Front);

    const panel2Back = new THREE.Mesh(panelGeo, panelMatBack);
    panel2Back.position.set(-(rosaW / 2 + ROSA_INBOARD_GAP), 0, -ROSA_HALF_THICK);
    panel2Back.name = 'ROSA_Panel_Back_180deg';
    panel2Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper2.add(panel2Back);

    this._buildRosaStructure(2, this._rosaPanelWrapper2, this.panelLeftPivot, -1);

    this._setRosaWingProgress(1, 1.0);
    this._setRosaWingProgress(2, 1.0);
  }

  /**
   * @private Apply roll-out progress to one ROSA wing.
   * @param {1|2} wing  — 1 = +X (0°), 2 = -X (180°)
   * @param {number} progress  — 0 (stowed) → 1 (deployed)
   */
  _setRosaWingProgress(wing, progress) {
    const wrapper = wing === 1 ? this._rosaPanelWrapper1 : this._rosaPanelWrapper2;
    const struct  = wing === 1 ? this._rosaStruct1 : this._rosaStruct2;
    // Booms + spreader live INSIDE the wrapper, so scale.x extends them with the blanket. The blanket starts at 5%
    // (a thin rolled stub).
    if (wrapper) wrapper.scale.x = 0.05 + 0.95 * progress;

    if (struct) {
      // Spool spin: drum + coil turn about their long axis in proportion to the length paid out (~6 turns per stroke).
      const spin = (1 - progress) * Math.PI * 2 * 6 * (struct.sign || 1);
      if (struct.drum)     struct.drum.rotation.y = spin;
      if (struct.stowRoll) struct.stowRoll.rotation.y = spin;

      // Stowed-roll bulge: the radius follows the SPIRAL, not a linear ramp (wound area ∝ length still on the drum):
      //     r(p) = sqrt(drumR² + (1−p)·(R_furled² − drumR²))
      // The mesh is built at R_furled, so scale 1 is fully furled and it shrinks toward drumR/R_furled.
      if (struct.stowRoll) {
        const V5 = Constants.OCTOPUS_V5;
        const rDrum = V5.ROSA_DRUM_R;
        const rFurl = PlayerSatellite.rosaFurledCoilRadiusM();
        const rNow = Math.sqrt(rDrum * rDrum + (1 - progress) * (rFurl * rFurl - rDrum * rDrum));
        const s = rNow / rFurl;
        struct.stowRoll.scale.set(s, 1, s);
        struct.stowRoll.visible = progress < 0.98; // hide the bulge when fully out
      }

      // Slit-tube spool curls (tape-spring uncoiling): tuck toward the coil when furled, lie flat when deployed. A short
      // damped overshoot over progress ~0.85→1 is the elastic "snap" of a composite boom locking straight.
      if (struct.curls && struct.curls.length) {
        const tuck = (1 - progress) * (Math.PI / 2);      // 0 (flat) → 90° (coiled)
        let snap = 0;
        if (progress > 0.85) {
          const u = (progress - 0.85) / 0.15;             // 0→1 over the last 15%
          snap = Math.sin(u * Math.PI * 2) * 0.12 * (1 - u); // damped wobble, rad
        }
        for (const curl of struct.curls) {
          const base = curl.userData.baseRotZ || 0;
          curl.rotation.z = base + (struct.sign || 1) * (tuck + snap);
        }
      }
    }
  }

  /**
   * @private Mother-wings mount (DECISIONS §10, owner 2026-09-23): real satellites mount each wing on ONE motor box
   * bolted to a strong part of the body; this builds that part — a ring frame just INSIDE the hull skin at z=0
   * (mid-body), a fixed, named anchor (`MidRing`) that the wing motor boxes (`_buildRosaStructure`) mount to instead of
   * the tilting sun-tracking pivot. Radius is just inside the barrel wall (`COLLAR_RADIUS`) so the ring never pokes
   * through the skin or the body-mount PV tiles riding outside it (~1.014·R, see `_buildMainBus`). Not visible from
   * outside in normal play.
   */
  _buildMidRing() {
    const V5 = Constants.OCTOPUS_V5;
    const barrelR = V5.COLLAR_RADIUS * M;
    const ringR = barrelR - V5.MID_RING_INSET * M;   // just inside the skin
    const tubeR = V5.MID_RING_TUBE_R * M;

    this._midRing = new THREE.Group();
    this._midRing.name = 'MidRing';
    this._midRing.position.set(0, 0, 0);             // mid-body station (z=0)
    this.add(this._midRing);

    // TorusGeometry's default normal is +Z (Convention Rule 4): already the barrel axis, no rotation needed.
    const ringGeo = new THREE.TorusGeometry(ringR, tubeR, 8, 48);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a33, metalness: 0.6, roughness: 0.4,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.name = 'MidRing_Frame';
    ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this._midRing.add(ring);

    // Wing tilt drive (owner 2026-10-13: "how to make the wings pivot? One piece cylinder thru the body?"). ONE drive per
    // wing, bolted to the body via MidRing (child of the SHIP, NOT the tilting pivots), at the wing root (az 0/180,
    // z=0): a hollow cylindrical STATOR (LatheGeometry) on the tilt axis, on a plinth that fills the hull-side 5 mm. The
    // turning yoke (`ROSA_Bracket_{0,180}deg`, built in _buildRosaStructure, same axis so it never floats) is the
    // one-piece shaft: it passes THROUGH the bore of the plinth and the stator to the drum, >= 3 mm from both at every
    // tilt and feather (it turns about the bore's own axis, so the gap does not change with the angle).
    // Why a pancake and not a real SADA-sized Ø110 x 200 mm drive: between the hull skin and the nearest face of the
    // spool there are only ROOM metres (derived below), so the drive is Ø110 and ROOM - 10 mm long: 5 mm clear of the
    // hull skin and 5 mm clear of the furled coil at each end. WING_MOTOR_BOX_* / WING_MOTOR_PAD_H in
    // Constants are no longer read by the mesh (kept: test-Constants pins them).
    // ROOM = spool axis - furled coil radius (the coil is nearer the hull than the drum, 35.4 mm vs 40.1 mm) minus
    // the hull skin at its nearest point (the barrel is a 64-gon with a vertex on the x axis: r 0.400 there).
    const roomM = PlayerSatellite.rosaSpoolAxisM() - PlayerSatellite.rosaFurledCoilRadiusM() - V5.COLLAR_RADIUS;
    const statorLo = barrelR + 0.005 * M;                    // 5 mm clear of the hull skin
    const statorLen = (roomM - 0.010) * M;                   // ... and 5 mm clear of the coil at the far end
    const statorR = 0.055 * M, boreR = 0.0375 * M, ch = 0.002 * M;
    // closed profile, (radius, axial): bottom face -> outer wall -> top face -> bore wall; 2 mm chamfers outside
    const statorPts = [
      [boreR, 0], [statorR - ch, 0], [statorR, ch], [statorR, statorLen - ch], [statorR - ch, statorLen],
      [boreR, statorLen], [boreR, 0],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const statorGeo = new THREE.LatheGeometry(statorPts, 48);
    statorGeo.rotateZ(-Math.PI / 2);                         // lathe axis Y -> ship +X; spans x 0..statorLen
    const plinthR = 0.060 * M, plinthLo = barrelR - 0.008 * M, plinthHi = statorLo;   // seated 8 mm into the skin
    const plinthLen = plinthHi - plinthLo;
    const plinthPts = [
      [boreR, 0], [plinthR, 0], [plinthR, plinthLen - ch], [plinthR - ch, plinthLen], [boreR, plinthLen], [boreR, 0],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const plinthGeo = new THREE.LatheGeometry(plinthPts, 48);
    plinthGeo.rotateZ(-Math.PI / 2);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a33, metalness: 0.6, roughness: 0.4,
    });
    for (const sign of [1, -1]) {
      const wingDeg = sign > 0 ? '0' : '180';
      // The -X drive is the same part turned half a turn about Y (axisymmetric: x -> -x, z -> -z).
      const pad = new THREE.Mesh(plinthGeo, boxMat);
      pad.position.set(sign * plinthLo, 0, 0);
      pad.rotation.y = sign > 0 ? 0 : Math.PI;
      pad.name = `WingMotorPad_${wingDeg}deg`;
      pad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this._midRing.add(pad);

      const box = new THREE.Mesh(statorGeo, boxMat);
      box.position.set(sign * statorLo, 0, 0);
      box.rotation.y = sign > 0 ? 0 : Math.PI;
      box.name = `WingMotorBox_${wingDeg}deg`;
      box.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this._midRing.add(box);
    }
  }

  /**
   * @private Structural detail for one ROSA wing: two high-strain composite edge booms (one per long edge), the tip
   * spreader bar, the root roller drum/mandrel (with a stowed-coil bulge) and the mounting bracket. Follows the real
   * Redwire/NASA ROSA layout (slit-tube booms on BOTH long edges, blanket rolled onto a root spool).
   * Booms + spreader are parented to `wrapper` so the wing's `scale.x` roll-out extends them with the blanket edge;
   * drum/bracket to `pivot` (root-fixed, do not stretch).
   * @param {1|2} wing
   * @param {THREE.Group} wrapper  — the scale.x roll-out wrapper (local XY)
   * @param {THREE.Group} pivot    — the sun-tracking pivot (root-fixed)
   * @param {number} sign          — +1 for +X wing, -1 for -X wing
   */
  _buildRosaStructure(wing, wrapper, pivot, sign) {
    const V5      = Constants.OCTOPUS_V5;
    const rosaW   = V5.ROSA_WIDTH * M;
    const rosaL   = V5.ROSA_LENGTH * M;
    const boomOD  = V5.ROSA_BOOM_OD * M;
    const sprOD   = V5.ROSA_SPREADER_OD * M;
    const drumR   = V5.ROSA_DRUM_R * M;

    // Root of the rolled blanket: the spool/drum sits this far OUTBOARD of the sun-tracking pivot (at the bus collar,
    // barrelR from centre). Blanket, edge booms and tip spreader all live in `wrapper`, so anchoring the wrapper at the
    // drum pins the blanket's INBOARD edge at the drum at every furl state (scale.x rolls out from this origin);
    // anchored at the pivot, a ~8 cm strip would poke inboard of the drum.
    const rootX = PlayerSatellite.rosaRootStandoffM() * M;
    wrapper.position.x = sign * rootX;

    // Near-black matte carbon-composite (real ROSA slit-tube spars read dark).
    const boomMat = new THREE.MeshStandardMaterial({
      color: 0x1c1c20, metalness: 0.2, roughness: 0.6,
    });
    const drumMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a33, metalness: 0.6, roughness: 0.4,
    });

    // Handles animated by _setRosaWingProgress: spool drum + coil (spin/scale as the blanket reels), slit-tube curls.
    const struct = { stowRoll: null, drum: null, curls: [], sign };

    // Blanket inboard-edge standoff (shared with _buildSolarPanels): the blanket spans wrapper-local x ∈ [gap, gap + rosaW];
    // booms and spreader must span the SAME interval.
    const gap = PlayerSatellite.rosaInboardGap();

    // One edge boom per long edge (±Y), centred on the blanket plane (z=0). Cylinder default axis is Y; rotate Z by 90°
    // so it lies along local X. The boom OD (2 cm) far exceeds the 4 mm blanket sandwich, so a SINGLE centred spar
    // embeds the blanket edge and reads from BOTH faces (a front/back pair left a see-through channel near edge-on).
    // Parented to `wrapper` so roll-out scale.x extends them with the blanket. Names A/B are bound in test-RosaFurl.js.
    // Booms are not in `struct` handles, so _setRosaWingProgress leaves them untouched. 24 radial segments: fewer
    // read as octagons in the furl frames.
    // The booms are OPEN C-sections (slit tubes, the real ROSA tape-spring section), not closed pipes: same OD and
    // length, 24 sides over 300 degrees, openEnded, DoubleSide, with the 60-degree slit facing the blanket.
    // CylinderGeometry vertex at angle t is (r sin t, ., r cos t); the boom's rotation.z = 90 degrees
    // maps cylinder x -> wrapper y (the blanket length), so the slit centre sits at t = 270 degrees (towards -y)
    // for the +y boom (A) and 90 degrees (towards +y) for the -y boom (B).
    const BOOM_ARC = degToRad(300);
    const slitW = Math.PI * 2 - BOOM_ARC;
    const boomShellMat = new THREE.MeshStandardMaterial({
      color: 0x1c1c20, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide,
    });
    for (const edgeY of [rosaL / 2, -rosaL / 2]) {
      const slitMid = edgeY > 0 ? (3 * Math.PI) / 2 : Math.PI / 2;
      const boomGeo = new THREE.CylinderGeometry(boomOD / 2, boomOD / 2, rosaW, 24, 1, true, slitMid + slitW / 2, BOOM_ARC);
      const boom = new THREE.Mesh(boomGeo, boomShellMat);
      boom.rotation.z = Math.PI / 2;           // Y-axis → X-axis (blanket length)
      // Centre at gap + half-width: spans local x ∈ [gap, gap + rosaW], the blanket's exact extent (mirrored via sign).
      boom.position.set(sign * (rosaW / 2 + gap), edgeY, 0);
      boom.name = `ROSA_Boom_${wing === 1 ? '0' : '180'}deg_${edgeY > 0 ? 'A' : 'B'}`;
      boom.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      wrapper.add(boom);
    }

    // Tip spreader bar at the blanket's outboard edge, spans width (Y). Embedded like the booms: centred on the blanket
    // plane, the tube stands 3 mm proud of each face (transversal: no tangent/coplanar contact with the ±2 mm sandwich).
    const sprGeo = new THREE.CylinderGeometry(sprOD / 2, sprOD / 2, rosaL, 24);
    const spreader = new THREE.Mesh(sprGeo, boomMat);
    spreader.position.set(sign * (rosaW + gap), 0, 0); // rides to the deployed tip via scale.x
    spreader.name = `ROSA_Spreader_${wing === 1 ? '0' : '180'}deg`;
    spreader.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    wrapper.add(spreader);

    // A collar at each end of the spreader where it meets its boom, and one small damper (a box clamped round the tube
    // near the A end). All inside the wrapper: they ride the roll-out and sit in the coil when furled (the x scale
    // squeezes them with the blanket).
    const fitR = sprOD * 0.7, fitLen = 0.014 * M;
    const fitGeo = new THREE.CylinderGeometry(fitR, fitR, fitLen, 24);
    const fitMat = new THREE.MeshStandardMaterial({ color: 0x9a9aa2, metalness: 0.75, roughness: 0.4 });
    for (const endY of [rosaL / 2, -rosaL / 2]) {
      const fit = new THREE.Mesh(fitGeo, fitMat);
      fit.position.set(sign * (rosaW + gap), endY > 0 ? endY - fitLen / 2 : endY + fitLen / 2, 0);
      fit.name = `ROSA_SpreaderFitting_${wing === 1 ? '0' : '180'}deg_${endY > 0 ? 'A' : 'B'}`;
      fit.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      wrapper.add(fit);
    }
    const damperGeo = new THREE.BoxGeometry(sprOD * 1.6, 0.050 * M, sprOD * 1.6);
    const damper = new THREE.Mesh(damperGeo, new THREE.MeshStandardMaterial({ color: 0x3a3a42, metalness: 0.5, roughness: 0.5 }));
    damper.position.set(sign * (rosaW + gap), rosaL / 2 - 0.060 * M, 0);
    damper.name = `ROSA_SpreaderDamper_${wing === 1 ? '0' : '180'}deg`;
    damper.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    wrapper.add(damper);

    // Slit-tube spool curls: short quarter-tori where each boom peels off the root drum and flattens into the blanket
    // plane (the ROSA "uncoiling tape measure" read), animated by _setRosaWingProgress: tucked toward the coil when
    // furled, flat when deployed, with a small elastic overshoot. Root-fixed (parented to pivot): they do NOT stretch
    // with scale.x.
    // TorusGeometry sweeps in its local XY plane about local Z (the barrel axis): built about the DRUM axis it runs
    // from the boom end (angle 0, at +drumR) up to the drum's zenith (angle π/2). The geometry is translated so its
    // ORIGIN is the boom end and the mesh sits at (rootX + drumR, 0, ±rosaL/2): the tuck rotates the arc about the boom
    // end, which stays on the boom axis at every p while the drum end swings up into the coil (r 0.105 at p 0.5,
    // 0.157 at p 0). The −X wing gets a MIRRORED copy (x → −x: rotateZ(π/2) then translate +drumR), not a π rotation:
    // a rotation is not a mirror, and with `sign·tuck` the port curl would tuck the wrong way. Both wings start at
    // their outboard boom end, rise to the drum's zenith at p = 1 and tuck symmetrically (base rotation 0).
    // Tube 24 sides / 12 segments along the quarter arc: fewer reads as a faceted elbow with a hexagonal tube end.
    const curlGeo = new THREE.TorusGeometry(drumR, boomOD / 2, 24, 12, Math.PI / 2);
    if (sign > 0) curlGeo.translate(-drumR, 0, 0);
    else          curlGeo.rotateZ(Math.PI / 2).translate(drumR, 0, 0);
    const curls = [];
    for (const edgeZ of [rosaL / 2, -rosaL / 2]) {
      const curl = new THREE.Mesh(curlGeo, boomMat);
      curl.position.set(sign * (rootX + drumR), 0, sign > 0 ? edgeZ : -edgeZ);
      curl.userData.baseRotZ = 0;
      curl.rotation.z = curl.userData.baseRotZ;
      curl.name = `ROSA_SpoolCurl_${wing === 1 ? '0' : '180'}deg_${edgeZ > 0 ? 'A' : 'B'}`;
      curl.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivot.add(curl);
      curls.push(curl);
    }
    struct.curls = curls;
    struct.sign = sign;

    // Root yoke: the turning coupling from the fixed motor box (built in _buildMidRing, a child of the SHIP) up to the
    // drum. Only the CENTRAL bracket exists (DECISIONS §10, owner 2026-09-23): flanking brackets (±0.32·rosaL along
    // the drum axis) swept a wide arc as the wing tilted (measured: −9 mm buried at 0°, +341 mm floating at 90°), the
    // "pillars floating on the solar cells". The central one sits ON the pivot's rotation axis (y=0, z=0 in pivot-local
    // space), so it is invariant to tilt: it never floats and never buries deeper. The pivot sits ON the hull tangent
    // (r 0.40): the box spans pivot-x −0.010…0.060 (0.070 long at x 0.025), so its inboard face is 10 mm buried in the
    // skin instead of tangent to the barrel (a coplanar tie).
    const brkGeo = new THREE.BoxGeometry(0.070 * M, drumR * 1.2, drumR * 0.6);
    const bracket = new THREE.Mesh(brkGeo, drumMat);
    bracket.position.set(sign * 0.025 * M, 0, 0);
    bracket.name = `ROSA_Bracket_${wing === 1 ? '0' : '180'}deg`;
    bracket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    pivot.add(bracket);

    // Spool assembly: drum/mandrel + stowed-coil bulge share a pivot whose local Y is the barrel axis, so spinning
    // each mesh about its own long axis (rotation.y) reads as the blanket reeling on/off the spool.
    const spoolPivot = new THREE.Group();
    spoolPivot.rotation.x = Math.PI / 2;                 // long axis → barrel Z
    spoolPivot.position.set(sign * rootX, 0, 0);
    spoolPivot.name = `ROSA_Spool_${wing === 1 ? '0' : '180'}deg`;
    pivot.add(spoolPivot);

    // Root roller drum / mandrel: the bare spool the blanket rolls onto. Length 1.02×rosaL (±1.02): the spool curls
    // (tube z 0.99…1.01) need mandrel under them at every furl state, and the stow coil must stay fore of the rear-cap
    // plane (±1.0), so the mandrel end showing beyond the coil cap when furled is intended.
    // openEnded: the collar discs (r 60 mm, drum children, so they spin and tilt with it) cover the whole drum end in
    // every pose; capping the drum too (r 50 mm, same plane, same satin silver) z-fights into a pinwheel.
    const drumGeo = new THREE.CylinderGeometry(drumR, drumR, rosaL * 1.02, 48, 1, true);
    // The drum is its own satin-metal part, with three anodised bands and a bearing flange near each end. Bands and
    // flanges are drum children (they spin with it), 0.6 mm proud (r 50.6 mm), clear of the blanket's inboard edge at
    // 51 mm.
    const drumSatinMat = new THREE.MeshStandardMaterial({ color: 0x9a9ca4, metalness: 0.85, roughness: 0.34 });
    const drum = new THREE.Mesh(drumGeo, drumSatinMat);
    drum.name = `ROSA_Drum_${wing === 1 ? '0' : '180'}deg`;
    drum.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    spoolPivot.add(drum);
    struct.drum = drum;
    {
      const ringR = drumR + 0.0006 * M;
      const bandGeo = new THREE.CylinderGeometry(ringR, ringR, 0.040 * M, 48, 1, true)   // open: the caps would be buried in the drum;
      const bandMat = new THREE.MeshStandardMaterial({ color: 0x2f6aa8, metalness: 0.7, roughness: 0.38 });
      // The yoke (a 30 mm wide block) enters the drum at z = 0, so no band sits there: bands at z -0.50 and +0.50 (the
      // ends) and one at +0.25 - every band >= 1 mm clear of the yoke's z extent (+-15 mm), asserted in test-WingsLook.
      [-0.5, 0.25, 0.5].forEach((zm, k) => {
        const band = new THREE.Mesh(bandGeo, bandMat);
        band.position.set(0, zm * M, 0);
        band.name = `ROSA_DrumBand_${wing === 1 ? '0' : '180'}deg_${k}`;
        band.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        drum.add(band);
      });
      const flangeGeo = new THREE.CylinderGeometry(ringR, ringR, 0.012 * M, 48, 1, true);
      const flangeMat = new THREE.MeshStandardMaterial({ color: 0x3a3a42, metalness: 0.7, roughness: 0.4 });
      for (const endSign of [1, -1]) {
        const fl = new THREE.Mesh(flangeGeo, flangeMat);
        fl.position.set(0, endSign * 0.965 * M, 0);     // just inboard of the coil's end plates (0.979-0.988)
        fl.name = `ROSA_DrumFlange_${wing === 1 ? '0' : '180'}deg_${endSign > 0 ? 'Fore' : 'Aft'}`;
        fl.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        drum.add(fl);
      }
    }

    // Wing-drum clamps (DECISIONS §10). Each drum end is held to the front/back end ring by a hold-down latch. The ship
    // starts released; the latch closes by motor whenever the player rolls the wings fully up (owner 2026-09-25:
    // re-latchable, not one-shot pyros; _wingClampsLatched(), _updateWingClamps()). The DRUM half is a collar on the
    // drum's own tip: it moves and spins exactly with the drum. The BODY half is a hold-down BRACKET bolted to the end
    // ring: it bears on the barrel's last WING_CLAMP_LAND of length (bottom sunk into the skin, so it is attached, not
    // hovering) and overhangs the rim under the collar, its top WING_CLAMP_SEAT_GAP below the collar. A release PIN
    // bridges that gap while latched and withdraws into the bracket at release; the bracket never moves. The wing tilts
    // about this side's x axis, so no wing point changes its x: the bracket, under the wing's lowest point (the
    // collar), is clear at every tilt.
    const V5c = Constants.OCTOPUS_V5;
    const clampR = drumR * 1.2;
    const clampLen = V5c.WING_CLAMP_LEN * M;
    const clampGeo = new THREE.CylinderGeometry(clampR, clampR, clampLen, 48);
    const halfDrumLen = (rosaL * 1.02) / 2;
    const ringZ = (V5c.CORE_LENGTH / 2) * M;                    // end-ring plane
    const spoolAxisX = PlayerSatellite.rosaSpoolAxisM() * M;    // ship-frame x
    const bW = V5c.WING_CLAMP_W * M;
    const bTop = spoolAxisX - clampR - V5c.WING_CLAMP_SEAT_GAP * M;
    // bottom: 3 mm under the skin at the bracket's outer edges (the skin is
    // lowest there — sqrt(R² − (W/2)²)), so the whole footprint is seated.
    const skinR = V5c.COLLAR_RADIUS * M;
    const bBot = Math.sqrt(skinR * skinR - (bW / 2) * (bW / 2)) - 0.003 * M;
    const bOuterZ = halfDrumLen;                                // flush with the collar's outer face
    const bInnerZ = ringZ - V5c.WING_CLAMP_LAND * M;
    const bracketGeo = new THREE.BoxGeometry(bTop - bBot, bW, bOuterZ - bInnerZ);
    const pinR = V5c.WING_CLAMP_PIN_R * M;
    const pinH = V5c.WING_CLAMP_SEAT_GAP * M * 2;               // half in the bracket, half bridging the gap
    const pinGeo = new THREE.CylinderGeometry(pinR, pinR, pinH, 24);
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, metalness: 0.8, roughness: 0.35 });
    struct.clampBody = [];
    struct.clampPins = [];
    for (const endSign of [1, -1]) {
      const endName = endSign > 0 ? 'Fore' : 'Aft';
      const tag = `${wing === 1 ? '0' : '180'}deg_${endName}`;

      const drumHalf = new THREE.Mesh(clampGeo, drumMat);
      // halfDrumLen is already in scene units (rosaL = ROSA_LENGTH·M): do NOT multiply by M again.
      drumHalf.position.set(0, endSign * (halfDrumLen - clampLen / 2), 0);
      drumHalf.name = `ROSA_WingClamp_${tag}_Drum`;
      drumHalf.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      drum.add(drumHalf);

      const bracket = new THREE.Mesh(bracketGeo, drumMat);   // same finish as the wing motor boxes
      bracket.position.set(sign * (bTop + bBot) / 2, 0, endSign * (bOuterZ + bInnerZ) / 2);
      bracket.name = `WingClamp_${tag}_Body`;
      bracket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(bracket);
      struct.clampBody.push(bracket);

      // Release pin, under the collar's middle; axis radial (cylinder Y → ship X).
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.rotation.z = Math.PI / 2;
      pin.position.set(sign * bTop, 0, endSign * (halfDrumLen - clampLen / 2));
      pin.name = `WingClamp_${tag}_Pin`;
      pin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pin.visible = false;                                      // released unless latched
      this.add(pin);
      struct.clampPins.push(pin);
    }

    // Stowed-coil bulge: the wound blanket, shrinking onto the bare mandrel as the wing rolls out (scaled radially by
    // _setRosaWingProgress). The FURLED radius is derived, not styled: PlayerSatellite.rosaFurledCoilRadiusM() winds
    // ROSA_WIDTH of ROSA_BLANKET_T stock onto the mandrel and returns sqrt(drumR² + W·t/π) ≈ 0.0546 m. The geometry is
    // built AT that radius and scales DOWN toward the drum, so scale 1 is the true full coil. Length is 0.98×rosaL so
    // its end caps (z=±0.98) never tie with the drum (±1.02) or the spool curls (±1.00). 48 radial segments, matching
    // the drum (test-MotherZFix pins the floor).
    const coilR = PlayerSatellite.rosaFurledCoilRadiusM() * M;
    // openEnded: the end plates below close the coil.
    const coilGeo = new THREE.CylinderGeometry(coilR, coilR, rosaL * 0.98, 48, 1, true);
    // The wound blanket reads as dark wrapped Kapton with ten faint lighter bands (own material, band map when a DOM
    // exists); two grey end plates close the coil's flat ends.
    const bandMap = getRosaStowBandTexture();
    const coilMat = new THREE.MeshStandardMaterial({
      color: bandMap ? 0xffffff : 0x2a2a33, map: bandMap || null, metalness: 0.3, roughness: 0.55,
    });
    coilMat.userData.rosaStowBands = true;
    const stowRoll = new THREE.Mesh(coilGeo, coilMat);
    stowRoll.name = `ROSA_StowRoll_${wing === 1 ? '0' : '180'}deg`;
    stowRoll.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    spoolPivot.add(stowRoll);
    struct.stowRoll = stowRoll;
    // Plates are children of the coil: they shrink and vanish with it at progress >= 0.98. z 0.980-0.988 (the coil wall
    // ends at 0.980, collars from 1.008): 8 mm thick, coil radius, no overlap band with the wall.
    const plateGeo = new THREE.CylinderGeometry(coilR, coilR, 0.008 * M, 48);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x6c6c74, metalness: 0.65, roughness: 0.4 });
    for (const endSign of [1, -1]) {
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.position.set(0, endSign * 0.984 * M, 0);
      plate.name = `ROSA_StowRoll_${wing === 1 ? '0' : '180'}deg_Plate_${endSign > 0 ? 'Fore' : 'Aft'}`;
      plate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      stowRoll.add(plate);
    }

    if (wing === 1) this._rosaStruct1 = struct;
    else            this._rosaStruct2 = struct;
  }

  /**
   * @private Drive ROSA panel roll-out: the opening dance's scripted roll-out while it runs, then the player furl
   * state ("," furls/unfurls to dodge debris or tether strikes).
   * @param {number} dt — seconds since last frame
   */
  _updateRosaPanels(dt = 0) {
    // Feather only changes per-panel tilt (_animateSolarTracking): independent of roll-out/launch state.
    const fRate = (Constants.OCTOPUS_V5.ROSA_FEATHER_RATE || 0.6) * dt;
    const fTarget = this._rosaFeatherTarget ?? 0;
    if (this._rosaFeatherProgress < fTarget) {
      this._rosaFeatherProgress = Math.min(fTarget, this._rosaFeatherProgress + fRate);
    } else if (this._rosaFeatherProgress > fTarget) {
      this._rosaFeatherProgress = Math.max(fTarget, this._rosaFeatherProgress - fRate);
    }

    const ls = this._launchSequence;
    const launchActive = !!(ls && ls.isActive && ls.isActive());

    if (launchActive && ls.getRosaProgress) {
      // The scripted roll-out owns the panels. Re-stow latch forced off so a dance never inherits it.
      this._rosaStowLatched = false;
      const prog = ls.getRosaProgress();
      this._setRosaWingProgress(1, prog.wing1);
      this._setRosaWingProgress(2, prog.wing2);
      // AVERAGE, not min: the staggered wing roll-out would otherwise read as body-only power until wing 2 starts.
      this._rosaFurlProgress = (prog.wing1 + prog.wing2) / 2;
      // The dance holds the wings rolled up and leaves the target to the player (a `,` pressed during the dance
      // is kept and rolls them out at hand-over).
      if (!ls.isOpeningDance) this._rosaFurlTarget = 1.0;
      this._updateWingClamps();
      return;
    }

    // Post-launch / no-launch: player furl control. Never toggled → fully deployed. Every start path sets manual
    // control with target 0, so this default never rolls the wings out.
    const target = this._rosaManualControl ? this._rosaFurlTarget : 1.0;

    // Wing-drum clamps are re-latchable motor-driven latches (owner 2026-09-25; DECISIONS-older.md). Once fully rolled
    // up (target 0, progress 0) and both tilts are within WING_CLAMP_RELATCH_TILT_DEG of 0, they snap closed
    // (_rosaStowLatched) until the player unrolls. ORDER: the latch opens FIRST and the roll-out resumes the FOLLOWING
    // frame, so the drum never turns inside a closed clamp. Tilt is read here, ahead of _animateSolarTracking (which
    // snaps the pivots to 0 while latched); furled tilt only decays toward 0, so a value inside tolerance stays inside.
    if (this._rosaStowLatched) {
      if (target > 0) this._rosaStowLatched = false;
    } else {
      const rate = (Constants.OCTOPUS_V5.ROSA_FURL_RATE || 0.4) * dt;
      const p0 = this._rosaFurlProgress;
      if (this._rosaFurlProgress < target) {
        this._rosaFurlProgress = Math.min(target, this._rosaFurlProgress + rate);
      } else if (this._rosaFurlProgress > target) {
        this._rosaFurlProgress = Math.max(target, this._rosaFurlProgress - rate);
      }
      // Both roll-out drums turn together: bill them while they move.
      if (this._rosaFurlProgress !== p0) {
        billMotorW(this, 2 * (Constants.MOTOR_DRAW_W?.WING_DRUM ?? 0), dt);
      }
      this._setRosaWingProgress(1, this._rosaFurlProgress);
      this._setRosaWingProgress(2, this._rosaFurlProgress);
      // Settle: both tilts within tolerance of 0. Inline (no helper) so test-RosaFurl.js stubs keep working;
      // a missing pivot reads as 0.
      const tol = degToRad(Constants.OCTOPUS_V5.WING_CLAMP_RELATCH_TILT_DEG ?? 0.5);
      const settled = [this.panelRightPivot, this.panelLeftPivot]
        .every((pivot) => !pivot || Math.abs(pivot.rotation.x) <= tol);
      if (target === 0 && this._rosaFurlProgress === 0 && settled) {
        this._rosaStowLatched = true;
      }
    }

    // Pins snap to latched/released every frame (motor detent, no interpolation). AFTER the latch state machine
    // so a close/open shows on the same frame.
    this._updateWingClamps();
  }

  /**
   * @private True while the wing-drum clamps hold the wings (re-stow latch closed on fully-rolled-up wings, see
   * `_updateRosaPanels`). The ship starts released. Read by `_updateWingClamps()` and `_animateSolarTracking`.
   * @returns {boolean}
   */
  _wingClampsLatched() {
    return this._rosaStowLatched ?? false;
  }

  /**
   * @private Show each wing-drum clamp's release pin while latched (bridging bracket → drum collar), hide it when
   * released. The bracket is bolted to the end ring and never moves; the drum half rides the drum. A snap, not an
   * animation: a motor-driven detent.
   */
  _updateWingClamps() {
    const latched = this._wingClampsLatched();
    for (const struct of [this._rosaStruct1, this._rosaStruct2]) {
      if (!struct || !struct.clampPins) continue;
      for (const pin of struct.clampPins) pin.visible = latched;
    }
  }

  /**
   * Toggle the ROSA arrays between furled (rolled up) and unfurled (deployed). Furling reduces solar power (ROSA share
   * only — body-mount cells stay on) but lets the player retract the wings to avoid debris or tether strikes.
   *
   * Direction comes from the COMMANDED target, not the live animation, so any press reverses immediately — the "." law
   * (InputManager reads `_strutTargetAlpha ?? getAimAlpha()`). Reading the live progress left a press at 0.9 while already
   * furling re-commanding the SAME target, so the key looked dead until the animation crossed halfway.
   * @returns {number} the new furl target (0 = furling, 1 = unfurling)
   */
  toggleRosaFurl() {
    this._rosaManualControl = true;
    this._rosaFurlTarget = this._rosaFurlTarget >= 0.5 ? 0.0 : 1.0;
    return this._rosaFurlTarget;
  }

  /** Set the ROSA furl target, 0 (furled) → 1 (unfurled) (tests / scripted events). */
  setRosaFurl(target) {
    this._rosaManualControl = true;
    this._rosaFurlTarget = clamp01(target);
    return this._rosaFurlTarget;
  }

  /**
   * Reset ROSA furl state to the start: both wings rolled up, held there like a player hold — the auto roll-out below the
   * launch branch never undoes it; `,` / WINGS opens them. Called on game reset so a retry never inherits the dead run's
   * wings. Also clears the feather state so the wings track the sun once opened.
   */
  resetRosaFurlState() {
    this._rosaManualControl = true;
    this._rosaFurlTarget = 0.0;
    this._rosaFurlProgress = 0.0;
    if (typeof this._setRosaWingProgress === 'function') {
      this._setRosaWingProgress(1, 0);
      this._setRosaWingProgress(2, 0);
    }
    this._rosaFeatherTarget = 0.0;
    this._rosaFeatherProgress = 0.0;
    // owner 2026-09-25: a retry must not inherit a closed re-stow latch from the dead run — the clamps would hold wings
    // that are already deployed.
    this._rosaStowLatched = false;
  }

  /**
   * Toggle the ROSA arrays between feathered (parked edge-on) and sun-tracking. Bound to "Shift+,", parallel to "," = furl.
   * Feathering swings the wings edge-on to a hazard — faster than a full furl and the wings stay deployed — cutting the
   * ROSA power share via the edge-on sun-incidence angle (NOT via a separate multiplier like furl). Furl takes precedence:
   * a furled wing is frozen, so feather only visibly acts once the array is unfurled.
   * @returns {boolean} the new feather state (true = feathering edge-on)
   */
  toggleRosaFeather() {
    // Decide from the live animated progress so a mid-animation press reverses.
    this._rosaFeatherTarget = this._rosaFeatherProgress >= 0.5 ? 0.0 : 1.0;
    return this._rosaFeatherTarget >= 0.5;
  }

  /**
   * Set the ROSA feather target (tests / scripted events).
   * @param {number} target — 0 (sun-tracking) → 1 (edge-on)
   * @returns {number} the clamped feather target
   */
  setRosaFeather(target) {
    this._rosaFeatherTarget = clamp01(target);
    return this._rosaFeatherTarget;
  }

  /** Wire up the launch driver (the opening dance); `ls` is duck-typed: isActive(), getRosaProgress(). Called by OpeningDance. */
  setLaunchSequence(ls) {
    this._launchSequence = ls;
  }

  /**
   * @private Opening-dance silence gate: true while the injected launch driver is the opening dance AND it is actively
   * running. The unfold is wordless — anything it would say is suppressed AT SOURCE, not held by the HUD toast inhibit (an
   * inhibited prompt is held and REPLAYED when the window closes, which would parade at hand-over). Duck-typed on the
   * driver's `isOpeningDance` marker: no import either way.
   * @returns {boolean}
   */
  _danceDrivesMe() {
    const ls = this._launchSequence;
    return !!(ls && ls.isOpeningDance === true && typeof ls.isActive === 'function' && ls.isActive());
  }

  // AFT FLOWER: 4 rigid aft-pivot struts with radiator plates and inert tip hardpoints at the FLOWER-NE/NW/SW/SE stations
  // (az 40/140/220/320, inside the 45k° ± 11.25° grants; clevis pin r 0.475 at the z=−1.0 rim, brackets in the
  // z −1.000..−0.886 / r 0.34..0.51 band). The struts "open LIKE A FLOWER" — the owner's grammar, kept verbatim. Each plate
  // folds in two along the boom line and the whole flower folds FORE along the barrel for launch (θ 0, GEO-comsat
  // pattern) — see _buildFlowerPair.
  //
  // Frame per strut: pivotGroup at the hinge point, rotated so local +X = radial out, +Y = tangential, +Z = ship +Z. The
  // hinge child rotates about local Y (the physical clevis axis): rotation.y = θ − 90° maps the boom (built along +X) to
  // sin(θ)·r̂ + cos(θ)·ẑ — θ=90° full bloom at the rim plane, θ=146° the stow bud (probe-pinned band edge; θ→180° camps
  // the Y3 axial reserve and is plume-illegal beyond R=1.714 m under thrust).

  /** Number of purchased flower pairs (0..2). */
  getFlowerPairCount() {
    return (this._flowerPairs.A ? 1 : 0) + (this._flowerPairs.B ? 1 : 0);
  }

  /** Purchased flower dry mass (kg): the mass-budget term read by ArmManager.getMassBudget() (pair taxes −280.7 / −231.0 m/s ΔV at full tanks). */
  getFlowerDryMassKg() {
    return this.getFlowerPairCount() * Constants.THERMAL.FLOWER.PAIR_DRY_MASS_KG;
  }

  // REACTION-WHEEL KIT (Constants.WHEELS; DECISIONS §2 row 9). One wheel per body axis. A wheel turn borrows spin from the wheel:
  // the ship gains L, the wheel loses the same L (`_wheelH`), so a rest-to-rest turn leaves the wheels where they were. Torque
  // costs battery in proportion; a full wheel gives no more in that direction; the coils bleed `_wheelH` toward 0 on the world
  // clock, and with the steering gas empty the tail boxes unload a full pitch/yaw wheel on the real-time clock.

  /** @returns {boolean} the reaction-wheel kit is aboard */
  hasWheelKit() { return this._wheelKit === true; }

  /** @private Install the kit (idempotent). It is structure: mass and inertia change, so the cached inertia goes. */
  _installWheelKit() {
    if (this._wheelKit) return;
    this._wheelKit = true;
    this._attitudeInertia = null;
  }

  /** The kit's dry mass (kg): the mass-budget carrier term `ArmManager.getMassBudget` adds to the bus (12.1 kg); 0 without it. */
  getWheelKitMassKg() {
    return this._wheelKit ? Constants.WHEELS.MASS_KG : 0;
  }

  /**
   * The kit as one point mass on the axis (x = y = 0) at Z_M, for `computeInertia`. null without the kit. It is not in
   * `computeCoM` (on the axis: it moves the centre of mass along z by m·z/M, about -1.2 cm, which the inertia's own CoM step
   * takes and the CoM calculator does not).
   * @returns {{massKg:number, z:number}|null}
   */
  wheelKitBooking() {
    if (!this._wheelKit) return null;
    return { massKg: Constants.WHEELS.MASS_KG, z: Constants.WHEELS.Z_M };
  }

  /** @returns {{x:number,y:number,z:number}} the wheels' stored spin, ship frame, N·m·s (a copy) */
  getWheelMomentum() {
    const h = this._wheelH;
    return h ? { x: h.x, y: h.y, z: h.z } : { x: 0, y: 0, z: 0 };
  }

  /** @returns {number} 0..1: how full the fullest wheel is (0 without the kit) */
  getWheelFill() {
    if (!this._wheelKit || !this._wheelH) return 0;
    const h = this._wheelH;
    return Math.min(1, Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) / Constants.WHEELS.MOMENTUM_NMS);
  }

  /** The kit's save slice: `[x, y, z]` N·m·s, or null without the kit (the save then carries no key). */
  getWheelState() {
    if (!this._wheelKit) return null;
    const h = this._wheelH;
    return [h.x, h.y, h.z];
  }

  /**
   * Put a saved stored-spin back (after the upgrade replay has re-installed the kit). Bad data (not three finite numbers) and a
   * ship without the kit change nothing; each value is held inside the wheel's capacity.
   * @param {number[]} state `[x, y, z]`
   */
  restoreWheelState(state) {
    if (!this._wheelKit || !Array.isArray(state) || state.length !== 3 || !state.every(Number.isFinite)) return;
    const H = Constants.WHEELS.MOMENTUM_NMS;
    this._wheelH.set(
      clamp(state[0], -H, H), clamp(state[1], -H, H), clamp(state[2], -H, H));
  }

  /** New game: the kit goes with the run's purchases (the replay of a continued save puts it back), the wheels stand empty. */
  resetWheelState() {
    // (tolerant of a ship stub built without the constructor: a test double the reset handlers are handed)
    if (this._wheelH) this._wheelH.set(0, 0, 0);
    this._wheelSpin = false;
    if (this._wheelUnload) { this._wheelUnload.x = false; this._wheelUnload.y = false; }
    if (this._wheelMsg) { this._wheelMsg.full = false; this._wheelMsg.power = false; this._wheelMsg.top = false; }
    if (this._wheelUse) { this._wheelUse.x = 0; this._wheelUse.y = 0; this._wheelUse.z = 0; }
    this._unloadLitS = 0;
    if (this._wheelKit) { this._wheelKit = false; this._attitudeInertia = null; }
  }

  /** @returns {boolean} the kit is aboard and the battery can feed it (a play frame; no battery wired = not power-limited) */
  wheelsUsable() {
    if (!this._wheelKit || this._offPlayFrame === true) return false;
    const b = this.resources ? this.resources.battery : undefined;
    return !Number.isFinite(b) || b >= Constants.WHEELS.MIN_BATTERY_WH;
  }

  /** Peak torque (N·m) the wheel on a body axis gives the ship. */
  wheelTauMag() { return Constants.WHEELS.TORQUE_NM; }

  /**
   * The autopilot says whether one of its slow turns (the eased slews and the trip hold, an aim, a scripted turn) is running: those
   * write the attitude themselves, so the ship's own rate reads 0 under them. `fn() -> boolean`; null clears it.
   * @param {(() => boolean)|null} fn
   */
  setSlowTurnProbe(fn) { this._slowTurnProbe = typeof fn === 'function' ? fn : null; }

  /**
   * the wheels can turn her now (kit aboard, powered, neither pitch nor yaw wheel full): with the gas out she is not stuck on the
   * tail boxes (minutes for a turn), so the launch ceremony may turn her. A wheel that is full one way only still counts as full here
   * (no direction is known to the caller).
   * @returns {boolean}
   */
  wheelsCanTurn() {
    return this._wheelKit === true && this.wheelsUsable() && !this.wheelsFull();
  }

  /**
   * no turn or spin is in progress about pitch or yaw: no wheel-made spin, no rate (her own, to the wheels' own rest), no
   * arrow key, no slow turn of the autopilot. The tail-box unload runs only then.
   * @returns {boolean}
   */
  wheelsAtRest() {
    if (this._wheelSpin === true) return false;
    const w = this._rcsOmega;
    if (w && (Math.abs(w.x) > 1e-6 || Math.abs(w.y) > 1e-6)) return false;
    const c = this._attitudeCmd;
    if (c && (c.pitch !== 0 || c.yaw !== 0)) return false;
    if (this._slowTurnProbe && this._slowTurnProbe()) return false;
    return true;
  }

  /**
   * How much more spin (rad/s) the wheels can take from now while the ship turns about the body direction (dx, dy, dz)
   * (normalised here): each axis's wheel has (H + sign·h) N·m·s of room in that direction, and the ship's rate along the
   * direction costs it I·|d_i| of that per rad/s; the fullest axis sets it. 0 without the kit or with a full wheel.
   * @returns {number} rad/s
   */
  wheelSpareRate(dx, dy, dz = 0) {
    if (!this._wheelKit) return 0;
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-12)) return 0;
    const I = this.getAttitudeInertia(), H = Constants.WHEELS.MOMENTUM_NMS, h = this._wheelH;
    let r = Infinity;
    const one = (d, hh, inertia) => {
      const m = Math.abs(d) / l;
      if (m > 1e-9) r = Math.min(r, (H + Math.sign(d) * hh) / (inertia * m));
    };
    one(dx, h.x, I.ixx); one(dy, h.y, I.iyy); one(dz, h.z, I.izz);
    return Number.isFinite(r) ? Math.max(0, r) : 0;
  }

  /**
   * The wheels cannot take (meaningful) spin in this direction: with a direction (dx, dy) an axis it uses has under
   * (1 - FULL_FRAC) of its capacity left that way; without one, a pitch or yaw wheel is at FULL_FRAC or more.
   * @returns {boolean}
   */
  wheelsFull(dx, dy) {
    if (!this._wheelKit) return false;
    const W = Constants.WHEELS, h = this._wheelH;
    const lo = (1 - W.FULL_FRAC) * W.MOMENTUM_NMS;
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      if (Math.abs(dx) > 1e-6 && W.MOMENTUM_NMS + Math.sign(dx) * h.x < lo) return true;
      if (Math.abs(dy) > 1e-6 && W.MOMENTUM_NMS + Math.sign(dy) * h.y < lo) return true;
      return false;
    }
    return Math.max(Math.abs(h.x), Math.abs(h.y)) >= W.FULL_FRAC * W.MOMENTUM_NMS;
  }

  /**
   * Seconds a rest-to-rest turn of `angleRad` takes on the wheels about the body axis (nx, ny, 0)/|·| (the sign of `angleRad`
   * is the sense): accelerate at the weakest axis's torque, never faster than the wheels' room allows (a trapezoid when the
   * room is the limit, a triangle when it is not), brake the same way. Infinity when the wheels cannot turn her that way
   * (no kit, a full wheel). The planning figure the selector, the aim and the slews all use.
   * @returns {number} s
   */
  wheelTurnTimeS(angleRad, nx = 1, ny = 0) {
    const lim = this._wheelTurnLimits(angleRad, nx, ny);
    if (!lim) return Infinity;
    const A = Math.abs(angleRad), { alpha, wmax } = lim;
    return A * alpha < wmax * wmax ? 2 * Math.sqrt(A / alpha) : A / wmax + wmax / alpha;
  }

  /**
   * The wheels' angular acceleration (the weakest axis the turn uses) and top rate (room, MAX_RATE) for a turn about (nx, ny); null
   * when they cannot. `rateRadS`: the rate she already has about that axis: the room is what is LEFT (her spin already took
   * I·rate of it), so her top rate is that room's rate plus what she has.
   * @private
   */
  _wheelTurnLimits(angleRad, nx, ny, rateRadS = 0) {
    if (!this._wheelKit) return null;
    const l = Math.hypot(nx, ny) || 1;
    const s = angleRad < 0 ? -1 : 1;
    const dx = s * nx / l, dy = s * ny / l;
    const I = this.getAttitudeInertia(), tau = Constants.WHEELS.TORQUE_NM;
    let alpha = Infinity;
    if (Math.abs(dx) > 1e-9) alpha = Math.min(alpha, tau / (I.ixx * Math.abs(dx)));
    if (Math.abs(dy) > 1e-9) alpha = Math.min(alpha, tau / (I.iyy * Math.abs(dy)));
    const had = Number.isFinite(rateRadS) ? Math.max(0, rateRadS) : 0;
    const wmax = Math.min(this.wheelSpareRate(dx, dy) + had, Constants.ATTITUDE.MAX_RATE);
    if (!(alpha > 0) || !Number.isFinite(alpha) || !(wmax > 0)) return null;
    return { alpha, wmax };
  }

  /**
   * How much of the torque the wheels were asked for the battery can pay this frame, for `units` wheel-outputs (0..3) over
   * `dt` seconds: the fraction of the power it holds (never free; 0 with no battery left). PEEK: the draw is billed at the
   * frame end from the recorded torque (`_wheelFrameEnd`).
   * @param {number} units @param {number} dt @returns {number} 0..1
   */
  wheelPeek(units, dt) {
    if (!this._wheelKit || this._offPlayFrame === true) return 0;
    const b = this.resources ? this.resources.battery : undefined;
    if (!Number.isFinite(b)) return 1;
    if (b < Constants.WHEELS.MIN_BATTERY_WH) return 0;
    const need = (Constants.WHEELS.PEAK_W / Constants.SHIP_HEAT.W_PER_UNIT_S) * units * dt;
    return need > 0 ? Math.min(1, Math.max(0, b) / need) : 1;
  }

  /**
   * One wheel gives (or takes) torque: `seconds` of full output about `axis` turning the SHIP `sign` (+1 = positive about
   * the axis). The wheel's own spin changes by the same moment the other way, and the seconds go on this frame's power bill.
   * The autopilot's rate laws call it where they would light a tail box (`tailBoxLit`); the integrator's torque goes through
   * the same bookkeeping. The stored spin stays inside the wheel's capacity (the rate laws never ask for more).
   * @param {'x'|'y'|'z'} axis @param {number} sign @param {number} seconds
   */
  wheelLit(axis, sign, seconds) {
    if (!this._wheelKit || !(seconds > 0)) return;
    const H = Constants.WHEELS.MOMENTUM_NMS;
    this._wheelH[axis] = clamp(this._wheelH[axis] - sign * Constants.WHEELS.TORQUE_NM * seconds, -H, H);
    this._wheelUse[axis] += seconds;
  }

  /**
   * Wheel kit, kicks: an angular impulse `(lx, ly)` N·m·s (body frame, about her centre of mass: what `applyImpulseAtPoint`
   * computes from r × J) goes into the pitch and yaw wheels WITH ITS SIGN, as far as their 4 N·m·s limit allows: the ship
   * gains L, the wheels hold it (`_wheelH += L`), so a kick against the stored spin lowers |h| (up to 2 × 4 N·m·s from a full
   * wheel the other way) and one with it raises |h|. What does not fit is returned for the gas (the caller bills it at the
   * real price). Roll is not kicked (dropped). The wheels' torque is on the battery's bill: |taken| / TORQUE_NM seconds of
   * full output on that axis (like any wheel turn), and only as much is taken as the battery can pay for (`wheelPeek`: on a
   * nearly flat battery a share, the rest is gas). Nothing is taken without the kit or without power (`wheelsUsable`: then
   * the whole turn is gas, as without the kit).
   * (A daughter launch's push comes through here too: `_applyLaunchKickTurn`.)
   * @param {number} lx N·m·s about +X @param {number} ly N·m·s about +Y
   * @returns {{x:number,y:number}|null} what is left for the gas; null: the wheels took nothing (no kit, no power)
   */
  _wheelAbsorbKick(lx, ly) {
    if (!this._wheelKit || !this._wheelH || !this.wheelsUsable()) return null;
    const W = Constants.WHEELS, h = this._wheelH, use = this._wheelUse;
    const { fx, fy, share } = this._wheelKickFit(lx, ly);
    let taken = 0;
    const take = (axis, L, room) => {
      if (!(Math.abs(L) > 0) || !Number.isFinite(L)) return 0;
      const got = room * share;
      if (got !== 0) {
        h[axis] += got;
        taken += Math.abs(got);
        if (use) use[axis] += Math.abs(got) / W.TORQUE_NM;
      }
      const rest = L - got;
      return Math.abs(rest) < 1e-9 ? 0 : rest;
    };
    const x = take('x', lx, fx), y = take('y', ly, fy);
    this._reelPushWheelNms += taken;
    return { x, y };
  }

  /**
   * @private What the wheels can take of a kick `(lx, ly)` N·m·s, signed, and the share of it the battery can pay for: the
   * battery pays for the torque the wheels give, in full-output seconds like a turn's; on a nearly flat battery they take
   * only that share of what fits, the rest is gas at the real price. Reads, changes nothing: `_wheelAbsorbKick` takes it,
   * `wheelKickPeek` asks.
   */
  _wheelKickFit(lx, ly) {
    const W = Constants.WHEELS, H = W.MOMENTUM_NMS, h = this._wheelH;
    const fit = (axis, L) => (Math.abs(L) > 0 && Number.isFinite(L))
      ? clamp(h[axis] + L, -H, H) - h[axis]                   // what fits, signed (a push against the spin: it all fits)
      : 0;
    const fx = fit('x', lx), fy = fit('y', ly);
    const total = Math.abs(fx) + Math.abs(fy);
    const share = total > 0 ? this.wheelPeek(1, total / W.TORQUE_NM) : 1;
    return { fx, fy, share };
  }

  /**
   * what `_wheelAbsorbKick(lx, ly)` WOULD do right now, without doing it (the shot chooser prices a launch's kick before it
   * is made). null = the wheels would take nothing (no kit, no power: the whole kick is gas), else the part left for the gas and the
   * part the wheels take, signed, N·m·s.
   * @param {number} lx @param {number} ly
   * @returns {{x:number,y:number,tx:number,ty:number}|null}
   */
  wheelKickPeek(lx, ly) {
    if (!this._wheelKit || !this._wheelH || !this.wheelsUsable()) return null;
    const { fx, fy, share } = this._wheelKickFit(lx, ly);
    const tx = fx * share, ty = fy * share;
    const rest = (L, t) => (Math.abs(L - t) < 1e-9 ? 0 : L - t);
    return { x: rest(lx, tx), y: rest(ly, ty), tx, ty };
  }

  /** @private The "wheels full" / "no power" comms line, once per event (the flag clears when the wheels serve a turn again). */
  _wheelSay(kind) {
    if (!this._wheelKit || this._offPlayFrame === true) return;
    const m = this._wheelMsg;
    if (m[kind]) return;
    m[kind] = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT',
      text: kind === 'full'
        ? 'Reaction wheels full: turning on steering gas while the coils slow them.'
        : 'Reaction wheels have no power: turning on steering gas.',
      priority: 'info',
    });
  }

  /**
   * @private a held arrow key with the steering gas out has run the wheel full: she coasts on at the wheels' top speed and
   * the wheels, not a tail box, will brake her once the key is up. Said once per hold, with the live numbers: the stop takes I·ω/τ
   * seconds and I·ω²/(2τ) of angle (the wheels' torque τ, her inertia I about that axis, her rate ω now).
   */
  _wheelTopSpeedSay(axis, omegaAxis, I, WK) {
    const m = this._wheelMsg;
    if (!m || m.top || this._offPlayFrame === true) return;
    const Ia = axis === 'x' ? I.ixx : I.iyy, w = Math.abs(omegaAxis);
    if (!(Ia > 0) || !(WK.TORQUE_NM > 0)) return;
    m.top = true;
    const sec = Math.max(1, Math.round(Ia * w / WK.TORQUE_NM));
    const deg = Math.max(1, Math.round(radToDeg(Ia * w * w / (2 * WK.TORQUE_NM))));
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT',
      text: `Reaction wheels at top speed: she needs about ${sec} s and ${deg}\u00b0 to stop after you let go.`,
      priority: 'info',
    });
  }

  /**
   * Per frame, after the attitude tick (any owner): the kit's battery bill (standby always, torque in proportion to this frame's
   * recorded full-output seconds, the coils while any wheel holds spin), the coils' dump on the WORLD clock, the tail boxes'
   * unload on the real clock, and the tallies cleared. Nothing on an off-play frame (the menu picture bills nothing).
   * @param {number} dt real seconds @private
   */
  _wheelFrameEnd(dt) {
    const use = this._wheelUse;
    if (!this._wheelKit || !use) { if (use) { use.x = 0; use.y = 0; use.z = 0; } return; }
    if (this._offPlayFrame === true || !(dt > 0)) { use.x = 0; use.y = 0; use.z = 0; return; }
    const W = Constants.WHEELS, per = Constants.SHIP_HEAT.W_PER_UNIT_S;
    const h = this._wheelH;
    const holding = Math.abs(h.x) > 1e-9 || Math.abs(h.y) > 1e-9 || Math.abs(h.z) > 1e-9;
    const torqueS = use.x + use.y + use.z;
    use.x = 0; use.y = 0; use.z = 0;
    this._drawBurnResource('battery',
      ((W.STANDBY_W * W.COUNT) * dt + W.PEAK_W * torqueS) / per);
    // The coils work on the world clock (a held-world frame passes no game time) and only as far as the battery feeds them.
    let fc = 0;
    if (holding) fc = this._drawBurnResource('battery', (W.COIL_W * W.COUNT / per) * dt);
    const dtWorld = this._motorBillHeld === true ? 0 : (this._wheelWorldDt > 0 ? this._wheelWorldDt : 0);
    if (holding && fc > 0 && dtWorld > 0) {
      const d = W.COIL_TORQUE_NM * dtWorld * fc;
      for (const k of ['x', 'y', 'z']) {
        const v = h[k];
        h[k] = Math.abs(v) <= d ? 0 : v - Math.sign(v) * d;
      }
    }
    this._wheelUnloadTick(dt);
  }

  /**
   * Steering gas empty and a pitch / yaw wheel full: the tail boxes take its spin off, on the real-time clock, with the
   * ship held still (the box's torque on the ship is cancelled by the wheel's, so the wheel's spin falls by the box's
   * torque × time). Starts at UNLOAD_ON_FRAC of full, stops at UNLOAD_OFF_FRAC. The boxes are asked through `slothPeek`
   * (cathodes, engine gas, power) and billed from their lit time like any box burn.
   * @param {number} dt @private
   */
  _wheelUnloadTick(dt) {
    const W = Constants.WHEELS, un = this._wheelUnload, h = this._wheelH;
    if (!this.isSlothMode()) { un.x = false; un.y = false; return; }
    // only with the ship at rest. A turn or a spin in progress (a held key, a wheel-made rate she coasts on, the autopilot's slow
    // turn or aim) is the wheels' business: the unload waits (its on/off flags keep) and never lights a box during a wheel turn.
    if (!this.wheelsAtRest()) return;
    let units = 0;
    for (const k of ['x', 'y']) {
      const f = Math.abs(h[k]) / W.MOMENTUM_NMS;
      if (f >= W.UNLOAD_ON_FRAC) un[k] = true; else if (f <= W.UNLOAD_OFF_FRAC) un[k] = false;
      if (un[k]) units += 1;
    }
    if (!(units > 0)) return;
    const pf = this.slothPeek(units, dt);
    if (!(pf > 0)) return;
    const t = this._slothBoxTable();
    for (const k of ['x', 'y']) {
      if (!un[k]) continue;
      const sgn = h[k] > 0 ? -1 : 1;                 // the box torque opposes the spin it takes off
      const i = k === 'x' ? (sgn > 0 ? t.xp : t.xn) : (sgn > 0 ? t.yp : t.yn);
      if (i < 0) continue;
      const tau = Math.min(Math.abs(t.tau[i][k]), W.TORQUE_NM);   // the wheel can only cancel what it can hold
      const dh = Math.min(Math.abs(h[k]), tau * pf * dt);
      h[k] -= Math.sign(h[k]) * dh;
      this._slothLitS[i] += pf * dt;
      this._unloadLitS += pf * dt;      // lit for the unload: billed and glowing, but not a turn (sloth mode's line is for a turn)
    }
  }

  /**
   * Deploy-state snapshot for the thermal HUD group (StatusPanel). EMPTY-SAFE contract: returns null until a pair is
   * purchased — the HUD renders ''. Pose readout only, NO thermal numbers. `pose` is 'LAUNCH' within 1° of
   * POSE_LAUNCH_DEG (fore-folded); `locked` = the one-shot launch lock is armed.
   *
   * DECISIONS §15 row 4 — the D4 contract: `openFrac` is 0 at the REST pose (CLOSED 0°) and 1 at CARGO (90°), linear in θ
   * between, clamped to [0, 1] — so the bud (146°) and the vent read 1 too. `pose` reads 'CLOSED' within 1° of
   * POSE_CLOSED_DEG while the launch lock is off.
   * @returns {{pairCount:number, thetaDeg:number, openFrac:number,
   *            slewing:boolean, pose:string, locked:boolean}|null}
   */
  getFlowerStatus() {
    const pairCount = this.getFlowerPairCount();
    if (pairCount === 0) return null;
    const FL = Constants.THERMAL.FLOWER;
    const thetaDeg = radToDeg(this._flowerThetaRad);
    const restDeg = this._flowerRestDeg();
    const span = FL.POSE_CARGO_DEG - restDeg;
    const fracOf = (deg) => (span === 0 ? 1 : clamp01((deg - restDeg) / span));
    // `thetaDeg` / `pose` are the shared angle (the player's); `openFrac` is the MEAN of the fitted petals' open fractions
    // (one petal held at 44° among three at 146° radiates less than four at 146°)
    let openFrac = fracOf(thetaDeg);
    const holds = this._petalHolds;
    if (holds.length > 0) {
      let sum = 0;
      let n = 0;
      for (const fg of this._flowerGroups) {
        sum += fracOf(radToDeg(this.petalThetaRad(fg.azDeg)));
        n++;
      }
      if (n > 0) openFrac = sum / n;
    }
    const slewing = this._flowerTargetTheta !== undefined;
    const near = (deg) => Math.abs(thetaDeg - deg) < 1.0;
    const pose = near(FL.POSE_VENT_DEG) ? 'VENT'
      : near(FL.POSE_STOW_DEG) ? 'STOW'
        : near(FL.POSE_PARK_DEG) ? 'PARK'
          : near(FL.POSE_CARGO_DEG) ? 'CARGO'
            : (!this._flowerLaunchLock && Number.isFinite(FL.POSE_CLOSED_DEG) && near(FL.POSE_CLOSED_DEG)) ? 'CLOSED'
              : near(FL.POSE_LAUNCH_DEG) ? 'LAUNCH' : 'SLEW';
    return { pairCount, thetaDeg, openFrac, slewing, pose, locked: this._flowerLaunchLock };
  }

  /**
   * The radiators (1-based, the numbers the comms lines use) whose petal is held for a catch right now, for the readouts
   * ("radiator N receiving"). A new array; empty when no petal is held.
   * @returns {number[]}
   */
  receivingRadiators() {
    const AZ = Constants.THERMAL.FLOWER.AZIMUTHS_DEG;
    const out = [];
    for (const h of this._petalHolds) if (!h.releasing) out.push(AZ.indexOf(h.az) + 1);
    return out.sort((a, b) => a - b);
  }

  /**
   * The orbit REST θ in degrees — the pose named by Constants.THERMAL.FLOWER.REST_POSE ('CLOSED' → POSE_CLOSED_DEG,
   * DECISIONS §15 row 4; a missing/unknown name falls back to the 146° bud, the owner's stated fallback). Boot, the
   * opening dance's end, every endState(), snapFlowerToStow() and O's closed end all land here.
   * @returns {number}
   */
  _flowerRestDeg() {
    return Constants.THERMAL.FLOWER.REST_DEG;
  }

  /**
   * O key — toggle the aft radiator between the REST pose (CLOSED 0°, folded along the body — DECISIONS §15 row 4) and
   * the OPEN pose (OPEN_POSE, 146° — owner 2026-10-09, DECISIONS §15 "Radiator angles").
   *
   * Direction comes from the COMMANDED target, falling back to the live pose when nothing is in flight — the "." strut
   * law verbatim (InputManager reads `_strutTargetAlpha ?? getAimAlpha()`). So ANY press reverses an in-flight slew, at
   * any angle. A pose nearer the rest end than the open end opens (→ OPEN_DEG); anything else closes (→ REST) — so from
   * 146° or 180° a press closes, and from the LAUNCH fold (θ 0, lock armed) a press opens: the release, the driver clears
   * the lock as θ passes the CLOSED floor.
   *
   * Double-tap push-through (owner 2026-09-16 "reverse 2 times into the 146 degree wall pushes through, with a warning";
   * 2026-09-22 "double press at 90 should push thru to 0"). Presses alternate cleanly, so two taps inside
   * VENT_DOUBLE_TAP_MS land back on the end you started from — a free gesture, read as pushing on past the end the second
   * tap lands on, in the direction it was travelling: past the open end (θ rising) that is 180°, warned (a double-tap at
   * 146° still goes to 180°: tap 1 closes, tap 2 reopens past it); past CLOSED (θ falling) it is the LAUNCH fold (0°),
   * through the SAFETY OVERRIDE arming. A single tap never goes to 180° and never arms the lock. 180° is not a resting
   * pose: the radiator settles back to 146° by itself (see `settleFlowerToOpen`).
   *
   * Nothing is made less safe: thrust above POSE_THRUST_MAX_DEG is already refused by _flowerPoseBandGuard (and swings the
   * radiator back to 146° first — `_warnFlowerThrustInhibit`), so 180° inhibits the drive under the existing law. The
   * warning explains the trade it is making.
   * @returns {boolean} true when now deploying (opening toward OPEN_DEG)
   */
  toggleFlowerDeploy() {
    if (this.flowerCommandsLocked) return this._refuseFlowerWhileHeld();
    const FL = Constants.THERMAL.FLOWER;
    const restDeg = this._flowerRestDeg();
    const restRad = degToRad(restDeg);
    const openDeg = FL.OPEN_DEG;
    const openRad = degToRad(openDeg);
    const ref = this._flowerTargetTheta !== undefined ? this._flowerTargetTheta : this._flowerThetaRad;
    const deploying = Math.abs(ref - restRad) <= Math.abs(ref - openRad);

    const now = performance.now();
    const doubleTap = this._lastFlowerTap !== undefined
      && now - this._lastFlowerTap < FL.VENT_DOUBLE_TAP_MS;
    this._lastFlowerTap = now;
    this._flowerPushedThrough = false;
    this._flowerCmdClockS = this._flowerClockS || 0;

    if (doubleTap && this._flowerGroups.length > 0) {
      const landDeg = deploying ? openDeg : restDeg;
      const fromDeg = deploying ? restDeg : openDeg;
      // Closed end with nothing past it (rest = launch fold = 0°): this is an ordinary tap — `_flowerPushedThrough` stays
      // false, so the input handler still says its plain line.
      const nothingPast = landDeg <= fromDeg && restDeg <= FL.POSE_LAUNCH_DEG;
      // One push per double-tap: the timer always clears, so a third quick tap is a first tap again.
      this._lastFlowerTap = undefined;
      if (landDeg > fromDeg) {
        // θ rising past the open end: 180° — the one shared method (a hold on the touch bar uses it too).
        this.pushFlowerToVent();
        return deploying;
      }
      // θ falling past the closed end: the LAUNCH fold (θ 0). Go through the SAFETY OVERRIDE path, not a bare latch: it is
      // what drops the driver floor to 0 AND engages the early wing dodge (folding with the arrays tracking is a measured
      // collision — DECISIONS §10). A refusal (no hardware) falls through to the ordinary command below.
      // owner 2026-10-16: the radiators rest fully closed (REST_DEG = POSE_LAUNCH_DEG = 0°), so there is nothing left to
      // fold to — the second tap only returns to the closed end and never arms the lock (a "launch fold, locked down" at the
      // rest angle would refuse the engines for no visible change).
      if (!nothingPast && this.setFlowerPose('LAUNCH', { override: true }) !== null) {
        this._flowerPushedThrough = true;
        this._flowerVentArmed = false;
        this._warnFlowerFold();
        return deploying;
      }
    }

    // An ordinary command re-aims — but it must NOT drop the vent ceiling here. The driver's ceiling is a hard clamp, so
    // clearing the flag while θ is still out at 180° snaps the panel back to 146° in one frame instead of slewing. The
    // driver disarms on ARRIVAL instead.
    this._flowerTargetTheta = deploying ? openRad : restRad;
    return deploying;
  }

  /**
   * Command the radiators to 180° (`POSE_VENT_DEG`). The ONE place that logic lives: the O key's double press
   * (`toggleFlowerDeploy`'s push-through) and a 450 ms hold on the touch bar's RADIATORS button both call it.
   * From any angle (0°, 146°, or already 180° — then it only restarts the 30 s settle-back clock). The settle-back
   * rules (30 s, or at once when the ion engine fires) are untouched. Refused while the radiators are held for
   * a catch hand-off, like every radiator command.
   * @returns {boolean|null} true when commanded; null when refused (the ship has already said so)
   */
  pushFlowerToVent() {
    if (this.flowerCommandsLocked) return this._refuseFlowerWhileHeld();
    if (!this._flowerGroups || this._flowerGroups.length === 0) return null;
    const FL = Constants.THERMAL.FLOWER;
    this._lastFlowerTap = undefined;
    this._flowerPushedThrough = true;
    this._flowerCmdClockS = this._flowerClockS || 0;   // a player command — restarts the 180° → 146° settle clock
    this._flowerVentArmed = true;
    this._flowerTargetTheta = degToRad(FL.POSE_VENT_DEG);
    this._warnFlowerVent();
    return true;
  }

  /**
   * @private Say what the VENT pose costs, once per entry. The radiator is past the thrust band, so the drive is
   * inhibited (the existing pose-band law); the line names the physical reason rather than just the refusal.
   *
   * The Mother runs dual-metal FEEP, i.e. CONDENSABLE metal propellant: exhaust plates out on whatever it reaches and stays
   * there (why ThrustMe chose iodine over caesium; plume redeposition is a standing contamination concern).
   *
   * Owner 2026-09-22: full 180° is allowed, into the cone, WITH warnings. So the line escalates — it names whichever
   * hazards the commanded pose crosses (measured thresholds POSE_VENT_CONE_DEG / POSE_VENT_Y3_DEG) instead of pretending
   * the pose is refused. Nothing physically blocks the swing: the tightest hull gap over the whole travel is 45.2 mm.
   */
  _warnFlowerVent() {
    const FL = Constants.THERMAL.FLOWER;
    const th = FL.POSE_VENT_DEG;
    // owner 2026-10-20: player text is positive and plain; every fact stays (the angle, past the thrust band, each hazard
    // the pose crosses, the ion engine waits, the swing back: 30 s or when the engine fires, unless held).
    const hazards = [];
    if (th >= FL.POSE_VENT_CONE_DEG) {
      hazards.push('inside the exhaust cone (metal propellant would condense on the panels for good)');
    }
    if (th >= FL.POSE_VENT_Y3_DEG) {
      hazards.push(`across the strip along the ship's centre line that is kept free (from ${FL.POSE_VENT_Y3_DEG}°)`);
    }
    const where = hazards.length ? ` The panels are ${hazards.join(' and ')}.` : '';
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'THERMAL',
      text: `Radiators swinging to ${th}°: the most heat goes out. That is past the ${FL.POSE_THRUST_MAX_DEG}° thrust band,`
        + ` so the ion engine waits while they are there.${where}`
        + ` They swing back to ${FL.OPEN_DEG}° by themselves after ${FL.RETURN_TO_OPEN_S} s, or at once when the ion engine fires,`
        + ' unless a held catch is in the way.',
      priority: 'warning',
      _reactive: true,
    });
    eventBus.emit(Events.THERMAL_FLOWER_VENTED, { thetaDeg: th });
  }

  /**
   * @private The mirror of _warnFlowerVent at the closed end: a double-command past CLOSED folds the radiator the last 2°
   * into the LAUNCH pose (θ 0), through the SAFETY OVERRIDE path so the early wing dodge comes with it. A folded radiator
   * is barely radiating. (Only reachable with a rest angle above the fold; the override fold arms no launch lock, so the
   * engines keep working.)
   */
  _warnFlowerFold() {
    const FL = Constants.THERMAL.FLOWER;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'THERMAL',
      text: `Radiator folded to ${FL.POSE_LAUNCH_DEG}° — the launch fold. `
        + `Folded panels radiate almost nothing: heat will build. Tap RADIATORS / O to open it to ${FL.OPEN_DEG}°.`,
      priority: 'warning',
      _reactive: true,
    });
  }

  /**
   * SAFETY OVERRIDE sweep (owner amendment 2026-09-09: "when player presses override button, and press "O" or clicks
   * radiator button, they need to see how radiator struts move, full range of motion"). Toggles the flower FOLDED ↔
   * DEPLOYED over the WHOLE travel: FOLDED = the LAUNCH geometry (θ 0, packs fore along the barrel, wings folded),
   * DEPLOYED = the STOW bud (146°) — one press = 146° at SLEW_RATE_RAD_S (≈ 9.7 s) through the bloom with the wings
   * folding / unfolding over WING_OPEN_START/END_DEG.
   *
   * Direction: from the COMMANDED target while a slew is in flight (so a press mid-swing REVERSES: what the label shows is
   * what a tap reverses), else from the live θ; θ > (LAUNCH + STOW)/2 = 73° → fold, else deploy. A fold goes through
   * setFlowerPose('LAUNCH', { override: true }) — the ONE production arming of the launch lock outside the launch sequence
   * — so the driver floor drops to 0°; a deploy is the ordinary STOW release (the lock clears at the CLOSED floor, 0°,
   * with THERMAL_FLOWER_RELEASED, once per arming). FEEP thrust stays inhibited the whole time the lock is armed
   * (_flowerPoseBandGuard).
   *
   * REACHABILITY: only the OVERRIDE actuator path may call this — the hub's `ladderActuators.flowerSweep.toggle()` (the
   * pane's RADIATOR chip) and the O key while `isOverrideEngaged()`, both guarded on OverridePane.isExpanded(). REFIT /
   * plain O / autopilot never reach it.
   *
   * ROSA (DECISIONS §10): the wings DODGE clear by themselves. The tilt law clamps through the measured clearance curves
   * (`_rosaDodgeLimitRad`): from the moment the override arming sets `_flowerOverrideFold`, the pivots take the
   * fold-corridor limit (5°) and hold it while the lock is armed — sun-track and feather both yield — so the wings
   * (τ 0.57 s) are clear before the 15°/s petals reach them and the driver NEVER waits for the pivots.
   * DECISIONS §11: the STRUTS no longer gate it either — a double-tap folds straight through at any strut angle (held cargo
   * in the corridor is out of scope). One press is still the whole travel; nothing is refused; a furled ROSA (pivots
   * parked at 0 by the furl blend) is unaffected.
   * @returns {boolean|null} true when now deploying (toward STOW 146°),
   *   false when folding (toward LAUNCH 0°), null when no flower is fitted
   */
  toggleFlowerOverride() {
    if (this.flowerCommandsLocked) return this._refuseFlowerWhileHeld();
    if (this._flowerGroups.length === 0) return null;
    const FL = Constants.THERMAL.FLOWER;
    const midRad = degToRad((FL.POSE_LAUNCH_DEG + FL.POSE_STOW_DEG) / 2);
    const ref = this._flowerTargetTheta !== undefined ? this._flowerTargetTheta : this._flowerThetaRad;
    const deploying = ref <= midRad;
    this._flowerCmdClockS = this._flowerClockS || 0;
    if (deploying) { this.setFlowerPose('STOW'); return true; }
    // Defensive: setFlowerPose refuses only without hardware (guarded above);
    // propagate a null so the caller never reports a fold that did not arm.
    if (this.setFlowerPose('LAUNCH', { override: true }) === null) return null;
    return false;
  }

  /**
   * Drive the flower to a named ladder pose ('CLOSED' | 'STOW' | 'PARK' | 'CARGO'): the thermal-duty / load-easing entry
   * point (and the test hook). DECISIONS §15 row 4: 'CLOSED' (POSE_CLOSED_DEG, folded along the body) is the REST pose —
   * `setFlowerPose(REST_POSE)` closes, `setFlowerPose('CARGO')` opens. Targets clamp to [POSE_FLOOR_DEG, POSE_STOW_DEG];
   * the floor is additionally enforced every frame in the driver.
   *
   * 'LAUNCH' (θ 0 — fore along the barrel, wings folded) is the fairing pose behind the launch lock. It is accepted ONLY
   * (a) while a launch driver (the opening dance, through the `_launchSequence` slot) owns the ship, (b) from the ?shot=1
   * dev hook with an explicit `{ force: true }`, or (c) from the SAFETY OVERRIDE actuator path with an explicit
   * `{ override: true }` (toggleFlowerOverride, and the O double-tap past CLOSED in toggleFlowerDeploy); every other caller
   * gets null and nothing changes. Accepting it ARMS the launch lock (the driver floor drops to 0°) and latches the target
   * at POSE_LAUNCH_DEG − 0.5° so the floor clamp holds θ at exactly 0 with no SETTLE_EPS residual. Any orbit pose
   * (CLOSED / STOW / PARK / CARGO — the REFIT chip, the O key, the OVERRIDE deploy) is the RELEASE: the driver clears the
   * lock the frame θ reaches POSE_FLOOR_DEG and emits Events.THERMAL_FLOWER_RELEASED once; from then on a bare 'LAUNCH' is
   * refused again — re-armable ONLY under OVERRIDE (or the sequence / the dev force), never from REFIT / autopilot. The (c)
   * override branch ALSO engages the wing DODGE (DECISIONS §10: `_flowerOverrideFold` — the tilt law clamps itself to the
   * fold-corridor limit from the moment of arming, so the wings are clear before the petals arrive; nothing is held and
   * nothing waits for them). (a) and (b) do not engage it (their own procedures furl ROSA, which parks the pivots at 0).
   * @param {'CLOSED'|'STOW'|'PARK'|'CARGO'|'LAUNCH'} pose
   * @param {{ force?: boolean, override?: boolean }} [opts] honoured for 'LAUNCH'
   *   only — `force` the dev hook, `override` the SAFETY OVERRIDE sweep
   * @returns {number|null} the accepted target θ in degrees (0 for LAUNCH), or null
   */
  setFlowerPose(pose, opts = undefined) {
    if (this.flowerCommandsLocked) return this._refuseFlowerWhileHeld();
    const FL = Constants.THERMAL.FLOWER;
    if (this._flowerGroups.length === 0) return null;
    this._flowerCmdClockS = this._flowerClockS || 0;   // restarts the 180° → 146° settle clock (non-player callers never run above 146°)
    if (pose === 'LAUNCH') {
      const ls = this._launchSequence;
      const launchActive = !!(ls && typeof ls.isActive === 'function' && ls.isActive());
      const forced = !!(opts && opts.force === true);
      const override = !!(opts && opts.override === true);
      if (!launchActive && !forced && !override) return null;
      // A catch bag on a radiator tip: the fold would park θ at the floor under the bag, never release the lock and inhibit
      // thrust.
      if (this.tipCargo?.count?.() > 0) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'THERMAL',
          text: 'Radiators cannot fold flat with a catch on a radiator tip.',
          priority: 'info',
          _reactive: true,
        });
        return null;
      }
      // DECISIONS §10 (the measured curve lives in the Constants WING_DODGE_* comment): the fold corridor below the pose floor
      // contacts the DEPLOYED ROSA beyond ~7° of tilt (133 mm at tilt 0, ~16 mm per degree). The override arming therefore
      // ENGAGES THE WING DODGE: the tilt law clamps to the fold-corridor limit from this frame (`_rosaDodgeLimitRad` reads
      // `_flowerOverrideFold`), sun-track and feather both yield, and the pivots (τ 0.57 s) are clear before the 15°/s petals
      // arrive. DECISIONS §11: the STRUTS no longer gate it either. Scoped to the override arming: the launch sequence and
      // the ?shot=1 dev force furl ROSA themselves (which parks the pivots at 0).
      if (override) {
        this._flowerOverrideFold = true;
      }
      // The lock is the launch latch at boot (sequence / dev force) only. The OVERRIDE sweep to 0° does not arm it (owner
      // 2026-10-16, rest = 0°): the floor is 0° too, so a lock would switch the engines off with no visible change. The
      // driver drops the dodge on the next command that leaves the fold.
      if (!override || launchActive || forced) this._flowerLaunchLock = true;
      this._flowerTargetTheta = degToRad(FL.POSE_LAUNCH_DEG - 0.5);
      return FL.POSE_LAUNCH_DEG;
    }
    const map = { CLOSED: FL.POSE_CLOSED_DEG, STOW: FL.POSE_STOW_DEG, PARK: FL.POSE_PARK_DEG, CARGO: FL.POSE_CARGO_DEG };
    const deg = map[pose];
    if (!Number.isFinite(deg)) return null;
    const clamped = clamp(deg, FL.POSE_FLOOR_DEG, FL.POSE_STOW_DEG);
    this._flowerTargetTheta = degToRad(clamped);
    return clamped;
  }

  /** @returns {boolean} whether the one-shot flower launch lock is armed. */
  get flowerLaunchLocked() { return this._flowerLaunchLock; }

  /**
   * Some radiator petal is HELD for a catch (a leash hand-off or a daughter's carry). Player pose commands, the 180° → 146°
   * settle and the thermal auto-open wait for it. A petal that has been released and is still swinging back to the shared
   * angle is not held (it chases the shared angle, whatever that does); see `flowerPetalsBusy` for "any petal off the
   * shared angle".
   * @returns {boolean}
   */
  get flowerHandoffHeld() {
    const holds = this._petalHolds;
    for (let i = 0; i < holds.length; i++) if (!holds[i].releasing) return true;
    return false;
  }

  /**
   * Some petal is off the shared angle - held, or released and still swinging back. The carry's clearance is certified with
   * the other three petals standing still on the shared angle, so it starts only when this is false.
   * @returns {boolean}
   */
  get flowerPetalsBusy() { return this._petalHolds.length > 0; }

  /**
   * The player's radiator commands, the 180° → 146° settle and the thermal auto-open all wait while a petal is held
   * (`flowerHandoffHeld`) OR a daughter's carry is under way, from its first step to her strut landing back on its recorded
   * angle. The petal is released a stage before that, and the shared angle must not move while her strut still stands at
   * the carry angle (124-130°): the gate certified the way back only with the other petals standing still.
   * Also while the resupply satellite is taking a piece (`_resupplyTaking`, written by ResupplySatellite from `takePiece` to
   * the last haul): its plan was made with the radiators at 90°, and a swing under the haul would put them where the plan
   * did not look.
   * @returns {boolean}
   */
  get flowerCommandsLocked() {
    if (this.flowerHandoffHeld) return true;
    if (this._resupplyTaking === true) return true;
    const am = this.armManager;
    return !!(am && typeof am.isCarrying === 'function' && am.isCarrying());
  }

  /**
   * The angle (rad) of the petal whose tip sits at azimuth `azDeg` (`THERMAL.FLOWER.AZIMUTHS_DEG`: 40, 140, 220, 320).
   * DERIVED: the petal's own angle while it is held or swinging back, else the shared angle (a free petal never lags it).
   * Nothing stores a free petal's angle.
   * @param {number} azDeg
   * @returns {number}
   */
  petalThetaRad(azDeg) {
    const holds = this._petalHolds;
    for (let i = 0; i < holds.length; i++) if (holds[i].az === azDeg) return holds[i].thetaRad;
    return this._flowerThetaRad;
  }

  /** @returns {boolean} the petal at azimuth `azDeg` is held or swinging back (not yet following the shared angle). */
  isPetalHeld(azDeg) {
    const holds = this._petalHolds;
    for (let i = 0; i < holds.length; i++) if (holds[i].az === azDeg) return true;
    return false;
  }

  /** @returns {boolean} the petal at azimuth `azDeg` is held (not released yet). */
  isPetalHolding(azDeg) {
    const holds = this._petalHolds;
    for (let i = 0; i < holds.length; i++) if (holds[i].az === azDeg) return !holds[i].releasing;
    return false;
  }

  /**
   * Hold ONE radiator petal for a catch. It slews on its own (the normal 15°/s) from its current angle to `thetaRad`; the
   * other petals keep the shared angle, which no pose command changes while a petal is held. Calling it again for a held
   * (or returning) petal just retargets it.
   * @param {number} azDeg the petal's tip azimuth (40, 140, 220 or 320)
   * @param {number} thetaRad
   * @param {{rateRadS?:number}} [opts] `rateRadS` = this hold's own slew rate (rad/s). The leash hand-off asks for
   *   `LEASH.HOLD_SLEW_DEG_S` (a hinge motor commanded faster than the 15°/s the player's radiators run at); a daughter's
   *   carry passes nothing and stays on `THERMAL.FLOWER.SLEW_RATE_RAD_S`. Applies to the move to `thetaRad` and (unless
   *   `releasePetalHandoff` says otherwise) the way back.
   * @returns {number|null} the angle in degrees after the bag-band cap (what the petal will really reach), or null with no
   *   such petal fitted, while the launch lock is armed, or for a non-finite angle
   */
  holdPetalForHandoff(azDeg, thetaRad, opts = null) {
    if (this._flowerLaunchLock || !Number.isFinite(thetaRad)) return null;
    if (!this._flowerGroups.some((fg) => fg.azDeg === azDeg)) return null;
    thetaRad = this._flowerClampRad(thetaRad);
    if (!this.flowerHandoffHeld) this._flowerHoldWarned = false;
    let h = null;
    for (const x of this._petalHolds) if (x.az === azDeg) { h = x; break; }
    if (!h) {
      h = { az: azDeg, thetaRad: this._flowerThetaRad, targetRad: thetaRad, releasing: false, rateRadS: 0 };
      this._petalHolds.push(h);
    }
    h.targetRad = thetaRad;
    h.releasing = false;
    h.rateRadS = opts && opts.rateRadS > 0 ? opts.rateRadS : 0;   // 0 = the normal SLEW_RATE_RAD_S
    this._flowerCmdClockS = this._flowerClockS || 0;
    return this._flowerCappedDeg(thetaRad);
  }

  /**
   * Let go of the held petal at `azDeg`. It slews back to the shared angle and is free again on arrival.
   * @param {{rateRadS?:number}} [opts] the way back's own slew rate (rad/s); none = the normal `SLEW_RATE_RAD_S`
   * @returns {number|null} the shared angle it returns to (degrees, after the bag-band cap), or null when it was not held
   */
  releasePetalHandoff(azDeg, opts = null) {
    for (const h of this._petalHolds) {
      if (h.az !== azDeg) continue;
      h.releasing = true;
      h.rateRadS = opts && opts.rateRadS > 0 ? opts.rateRadS : 0;
      this._flowerCmdClockS = this._flowerClockS || 0;
      return this._flowerCappedDeg(this._flowerThetaRad);
    }
    return null;
  }

  /** @returns {number[]} the held petals' tip azimuths (a new array: read it for tests and readouts, not per frame) */
  heldPetalAzimuths() { return this._petalHolds.map((h) => h.az); }

  /**
   * The smallest and largest angle among the fitted petals (rad) and the smallest angle any petal is on its way to — for
   * the gates that are about the whole ring (the thrust band, the wing dodge). Written into `out`.
   * @param {{min:number, max:number, minTarget:number}} out
   * @returns {{min:number, max:number, minTarget:number}}
   */
  _petalRangeInto(out) {
    const th = this._flowerThetaRad;
    out.min = th; out.max = th;
    const tgt = this._flowerTargetTheta;
    out.minTarget = tgt !== undefined ? Math.min(th, tgt) : th;
    const holds = this._petalHolds;
    for (let i = 0; i < holds.length; i++) {
      const h = holds[i];
      if (h.thetaRad < out.min) out.min = h.thetaRad;
      if (h.thetaRad > out.max) out.max = h.thetaRad;
      const to = h.releasing ? h.thetaRad : Math.min(h.thetaRad, h.targetRad);
      if (to < out.minTarget) out.minTarget = to;
    }
    return out;
  }

  /** @private Clamp a finite θ (rad) to [POSE_FLOOR_DEG, POSE_STOW_DEG]. */
  _flowerClampRad(thetaRad) {
    const FL = Constants.THERMAL.FLOWER;
    const lo = degToRad(FL.POSE_FLOOR_DEG);
    const hi = degToRad(FL.POSE_STOW_DEG);
    return clamp(thetaRad, lo, hi);
  }

  /**
   * @private θ (rad) → degrees the radiators really reach: above the tip-bag
   * band the slew aims SETTLE_EPS_RAD under it (see _updateFlower).
   */
  _flowerCappedDeg(thetaRad) {
    const band = this.tipCargo?.maxRadiatorThetaRad?.() ?? Infinity;
    if (thetaRad > band + 1e-9) {
      return radToDeg(band - Constants.THERMAL.FLOWER.SETTLE_EPS_RAD);
    }
    return radToDeg(thetaRad);
  }

  /** @private A radiator command while held: one comms line per hold, then null. A take's lock (no hand-off, no carry) says so: the hand-off line wins when both hold. */
  _refuseFlowerWhileHeld() {
    if (!this._flowerHoldWarned) {
      this._flowerHoldWarned = true;
      const takeOnly = this._resupplyTaking === true && !this.flowerHandoffHeld && !(this.armManager && typeof this.armManager.isCarrying === 'function' && this.armManager.isCarrying());
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'THERMAL',
        text: takeOnly ? 'Radiators stay while the satellite is taking a piece.' : 'Radiators held for the catch hand-off.',
        priority: 'info',
        _reactive: true,
      });
    }
    return null;
  }

  /**
   * Snap the flower to its stowed REST pose — CLOSED (θ 0°, folded flat along the body; DECISIONS §15 row 4). The name is
   * kept because GameFlowManager.resetGame() and OpeningDance.endState() call it. The launch lock is cleared and the latch
   * idle, and the hinges / wings are written now (no slew). Emits THERMAL_FLOWER_RELEASED once if the lock WAS armed (so
   * listeners see the same release the real swing would have produced); no POSE event — nothing slewed. No hardware → no-op.
   */
  snapFlowerToStow() {
    if (this._petalHolds) this._petalHolds.length = 0;   // every petal follows the shared angle again
    if (this._flowerGroups.length === 0) return;
    const restDeg = this._flowerRestDeg();
    const wasLocked = this._flowerLaunchLock;
    this._flowerLaunchLock = false;
    this._flowerOverrideFold = false;
    this._flowerTargetTheta = undefined;
    this._flowerVentArmed = false;
    this._lastFlowerTap = undefined;
    this._flowerPushedThrough = false;
    this._bandWaitS = 0;                    // no radiator wait or drop mark outlives a reset
    this._flowerBandDropped = false;
    this._bandSaid = false;
    this._flowerThetaRad = degToRad(restDeg);
    this._updateFlower(0);
    // Suppressed while the opening dance drives this ship (wordless unfold).
    if (wasLocked && !this._danceDrivesMe()) {
      eventBus.emit(Events.THERMAL_FLOWER_RELEASED, { thetaDeg: restDeg });
    }
  }

  /**
   * @private Install a purchased pair (idempotent — the save-restore path re-applies shop effects, so a second call is a
   * no-op). Pair A = az 40/220, pair B = az 140/320 — trim-neutral diagonals (⟂-CoM 0.0000).
   */
  _installFlowerPair(pairKey) {
    if (this._flowerPairs[pairKey]) return;
    this._flowerPairs[pairKey] = true;
    this._buildFlowerPair(pairKey);
    // New meshes joined the tree: refresh the DETAIL-LOD cull set so the flower's MountBolt_* hardware rides the existing
    // inert-detail family.
    this._collectDetailMeshes();
    // Suppressed while the opening dance drives this ship (wordless unfold).
    if (!this._danceDrivesMe()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'THERMAL',
        text: pairKey === 'A'
          ? 'Aft flower pair A installed — radiator struts at az 40/220. They open LIKE A FLOWER: press O.'
          : `Aft flower pair B installed — full four-strut flower at az 40/140/220/320. O opens them to ${Constants.THERMAL.FLOWER.OPEN_DEG}° and folds them flat.`,
        priority: 'info',
      });
    }
  }

  /**
   * Launch hold-down (owner 2026-10-14: "Radiator struts need a cradle or latch in closed position"): one cradle per boom
   * on the hull skin under it, plus a latch lug on the boom:
   *   • FlowerStrutCradle_<i>      — a saddle pad on the skin (50 x 16 x 8 mm, 4 mm buried: the StrutRest style, 16 mm long
   *                                  so it fits the bare seam between the PV cell rows) and two cheeks whose top faces form
   *                                  a V round the boom. Both faces are tangent to a circle CRADLE_GAP (2 mm) bigger than the
   *                                  boom, so with the boom at POSE_LAUNCH_DEG the faces stand 2 mm off it; a 16 mm slot
   *                                  between the cheeks takes the lug.
   *   • FlowerStrutCradle_<i>_Pin  — the hold-down pin, across the slot, ends buried in the cheeks (visual only).
   *   • FlowerStrutLatch_<i>       — the lug: a tongue hanging from the boom (child of the hinge, so it turns with it)
   *                                  into the slot, the pin passing through it at launch. Once the boom lifts to the
   *                                  orbit rest (POSE_FLOOR_DEG) the tongue is clear of the pin by the boom's lift.
   * Every height is derived from the boom pose (hinge position, boom axis at the cradle station for POSE_LAUNCH_DEG, boom
   * radius), never typed. The station is zc, the seam between the PV cell rows (no solar cell under it; clear of the MGA at
   * z > 0.76, the sun sensor, nav lights, pyro pins at z -0.43 and the StrutRest saddles). The names carry the FlowerStrut
   * prefix: the cradle is flower hardware, measured by test-LookR5 (its designed 2 mm contact with the boom at launch is not
   * an EveryDoor clash).
   */
  _buildFlowerCradle(i, azDeg, hinge, FL, mergeGeos) {
    const V5 = Constants.OCTOPUS_V5;
    const skinR = V5.COLLAR_RADIUS;                      // m — the same skin radius the StrutRest saddles use
    const thL = degToRad(FL.POSE_LAUNCH_DEG);
    const zc = 0.47;                                     // m — cradle station (ship z): the middle of the 20 mm seam between the two PV cell rows (z 0.46 / 0.48)
    const CRADLE_LEN = 0.016;                            // m — axial length of pad and cheeks: 2 mm of bare skin each side of it in the seam, so no part of the cradle is over a solar cell
    const sB = (zc - FL.HINGE_Z_M) / Math.cos(thL);      // m — distance along the boom from the hinge to the station
    const axisR = FL.HINGE_R_M + sB * Math.sin(thL);     // m — boom axis radius at the station, launch pose
    const Ha = axisR - skinR;                            // m — boom axis height above the skin
    const rho = FL.STRUT_RADIUS_M + 0.002;               // m — V faces tangent to this circle: 2 mm off the boom
    const S45 = Math.SQRT1_2;
    const tTan = rho * S45, hTan = Ha - rho * S45;       // tangent point of the right face (tangential, height)
    const faceH = (t) => hTan + (t - tTan);              // right face: rises outward at 45 degrees
    const SLOT = 0.008, T_OUT = tTan + 0.001;            // m — slot half-width; cheek outer wall 1 mm past the tangent
    const BASE = -0.004, LEN = CRADLE_LEN;               // m — cheek base (buried) and axial length
    const cheek = (sg) => {
      const pts = [[SLOT, BASE], [T_OUT, BASE], [T_OUT, faceH(T_OUT)], [SLOT, faceH(SLOT)]];
      const sh = new THREE.Shape((sg > 0 ? pts : pts.slice().reverse()).map(([t, h]) => new THREE.Vector2(sg * t * M, h * M)));
      const g = new THREE.ExtrudeGeometry(sh, { depth: LEN * M, bevelEnabled: false });
      // shape (t, h, depth) -> cradle frame (tangent, axial, radial): the pad's makeBasis(tangent, z, radial)
      g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
      g.translate(0, (LEN / 2) * M, 0);
      return g;
    };
    const pad = new THREE.BoxGeometry(0.050 * M, CRADLE_LEN * M, 0.008 * M);   // 50 mm across, CRADLE_LEN along the hull; spans h -4 .. +4 mm
    const azRad = degToRad(azDeg);
    const radial = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
    const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
    const basis = new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 0, 1), radial);
    const placed = (mesh, name) => {
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.position.set(radial.x * skinR * M, radial.y * skinR * M, zc * M);
      mesh.name = name;
      mesh.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.add(mesh);
      return mesh;
    };
    const cradleMat = new THREE.MeshStandardMaterial({ color: 0x8888a0, metalness: 0.75, roughness: 0.28 });   // StrutRest recipe
    placed(new THREE.Mesh(mergeGeos([pad, cheek(+1), cheek(-1)]), cradleMat), `FlowerStrutCradle_${i}`);
    // the hold-down pin: Ø6 along the tangent, centred 3 mm below the V apex's inner wall so it stays inside the cheeks
    const PIN_R = 0.003, PIN_H = faceH(SLOT) - 0.0035 - PIN_R + PIN_R * 0;   // m — pin axis height above the skin
    const pinLen = 2 * (T_OUT - 0.002);
    const pinGeo = new THREE.CylinderGeometry(PIN_R * M, PIN_R * M, pinLen * M, 16);
    pinGeo.rotateZ(Math.PI / 2);                         // cylinder Y -> cradle X (tangent)
    pinGeo.translate(0, 0, PIN_H * M);
    const pinMat = new THREE.MeshStandardMaterial({ color: 0x444455, metalness: 0.7, roughness: 0.3 });
    placed(new THREE.Mesh(pinGeo, pinMat), `FlowerStrutCradle_${i}_Pin`);
    // the latch lug: a tongue from inside the boom down past the pin (hinge frame: +X along the boom, +Z toward the hull
    // at launch). Its bottom hangs 3.5 mm below the pin axis' lower edge.
    const dPin = Ha - PIN_H;                             // m — pin axis below the boom axis
    const dBottom = dPin + PIN_R + 0.0035;
    const tongue = new THREE.BoxGeometry(0.010 * M, 0.010 * M, (dBottom - 0.020) * M);   // root 20 mm under the boom axis: inside the tube, 3 mm clear of the panel's pipes (their top is 17 mm)
    tongue.translate(0, 0, ((dBottom + 0.020) / 2) * M);
    const lug = new THREE.Mesh(tongue, new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.45 }));
    lug.position.x = sB * M;
    lug.name = `FlowerStrutLatch_${i}`;
    lug.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    lug.userData.noSolarShade = true;                    // mm-scale detail: never a solar occluder (the boom already shades)
    hinge.add(lug);
  }

  /**
   * @private Build the two struts of one pair. Names use the P1-reserved
   * `FlowerStrut_*` LOD prefix (PascalCase_${i} convention); station index i
   * is fixed by azimuth order (0:41°, 1:139°, 2:221°, 3:319°) regardless of
   * purchase order. Bolts take the `MountBolt_` prefix so the DETAIL-LOD
   * inert-hardware family culls them by naming convention alone — no floating
   * boxes: every piece hangs off the bracket/boom/plate stack.
   */
  _buildFlowerPair(pairKey) {
    const FL = Constants.THERMAL.FLOWER;
    const azList = pairKey === 'A' ? FL.PAIR_A_AZ_DEG : FL.PAIR_B_AZ_DEG;

    const boomMat = new THREE.MeshStandardMaterial({
      color: 0x555c66, metalness: 0.7, roughness: 0.4,
    });
    // Radiator plate: OSR-class light grey, distinct from the gold MLI body and the dark deck. The radiating +Z face is matte
    // white (#E8E6E0; the earlier light grey blew out to a flat slab); the four edge faces and all frame hardware are
    // mid-grey metal. The -Z face is the same matte white (owner 2026-10-23: all white both sides, so the game matches the
    // printed model). BoxGeometry groups run +X, -X, +Y, -Y, +Z, -Z, so the material array is [edge x4, front, back].
    const frontMat = new THREE.MeshStandardMaterial({ color: 0xE8E6E0, metalness: 0.05, roughness: 0.75 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0xE8E6E0, metalness: 0.05, roughness: 0.75 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.45 });
    const bracketMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.45,
    });
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x444455, metalness: 0.7, roughness: 0.3,
    });
    // Hinge-seam groove: near-black, matte — the shadowed gap between the centre panel and each wing.
    const seamMat = new THREE.MeshStandardMaterial({
      color: 0x1c1e26, metalness: 0.3, roughness: 0.85,
    });

    const boomLen = FL.STRUT_LENGTH_M * M;
    // 48 radial segments: the Ø60 mm strut is a foreground tube in the aft frames and its facets showed.
    const boomGeo = new THREE.CylinderGeometry(FL.STRUT_RADIUS_M * M, FL.STRUT_RADIUS_M * M, boomLen, 48);
    const plateLen = (FL.PLATE_END_M - FL.PLATE_START_M) * M;
    const plateX = ((FL.PLATE_START_M + FL.PLATE_END_M) / 2) * M;
    // Plate = a 0.30 m CENTRE panel on the boom plus two FULL 0.15 m WINGS hinged along the boom line (GEO-comsat
    // intercostal-hinge pattern: it has to fold to fit the rocket). Open: butt-jointed, width 0.60, area 4 × 0.90 = 3.60 m²
    // (3.582 built: the wings end 15 mm short). Folded (launch, θ 0): both wings land side by side on ONE layer over the
    // centre panel's −Z_hinge face (= radially OUTBOARD when the strut lies fore along the barrel) and meet at the boom line
    // edge-to-edge under the boom — a 0.32 × 0.117 × 1.50 m pack with its hinges (r_max 0.560 on the built model).
    // Measured: test-FlowerLaunchFold (ii).
    const cHalf = FL.PLATE_CENTRE_HALF_WIDTH_M;
    const wingW = FL.PLATE_HALF_WIDTH_M - cHalf;                  // 0.15 — the FULL wing (⟦R⟧1: no air seam)
    const layer = FL.WING_GAP_M + FL.PLATE_THICK_M;               // 0.050 folded layer pitch
    const knuckleK = layer / 2;                                   // 0.025 fold-axis standoff below the mid-plane
    const plateGeo = new THREE.BoxGeometry(plateLen, 2 * cHalf * M, FL.PLATE_THICK_M * M);
    // Wings stop WING_TIP_INSET_M short of the plate's tip end (folded, they lie under the centre panel, where the tip boss
    // would otherwise hold them); the root ends stay flush with the centre panel's.
    const wingInset = FL.WING_TIP_INSET_M * M;
    const wingLen = plateLen - wingInset;
    const wingGeo = new THREE.BoxGeometry(wingLen, wingW * M, FL.PLATE_THICK_M * M);
    // Hinge-seam strip: a dark 2 cm band on the centre panel's edge, set back 2 mm from the hinge-line plane (so no side face
    // shares the wing's edge plane) and standing 1 mm proud of both plate faces (log-depth rule: ≥ 1 mm proud, never
    // coplanar). A true cut groove would need the panel split; the dark band is what reads at 3 m.
    // End-cap rule: the strip is SEAM_END_INSET_M shorter at EACH end than the panel it sits on, so its ±X end faces never
    // share the panel's end planes (coplanar ends z-fought at both ends of the radiators).
    const seamLen = plateLen - 2 * FL.SEAM_END_INSET_M * M;
    const seamGeo = new THREE.BoxGeometry(seamLen, FL.WING_SEAM_M * M, (FL.PLATE_THICK_M + 0.002) * M);
    const seamY = (cHalf - 0.002 - FL.WING_SEAM_M / 2) * M;
    // owner 2026-09-09: the centre-panel knuckle set (24 invisible hinge blocks) is deliberately gone; the wing-mounted set
    // below is the hinge's visible detail. knuckleK stays: it is the wing-hinge standoff for the wing hinges, seams and knuckles.
    // The hinge-mounted seam above sits on the CENTRE PANEL's faces, which become the INNERMOST layer once folded: the true
    // OUTERMOST (camera-visible) layer at LAUNCH is the WING's own +Z face (r 0.560; the plate face and its seam are buried
    // 6–24 mm beneath it). So a matching seam + three knuckle blocks sit on EACH WING (children of `wh`, not `hinge`), 1 mm
    // proud of the wing's own faces both deployed and folded.
    // wingSeamGeo reuses seamGeo's cross-section (symmetric ±1 mm about the wing's mid-plane, same dark groove; 1 cm wide,
    // y 0.015..0.025). wingKnuckleGeo is SHORT (12 mm, not the 35 mm layer pitch): it only needs to read against ONE panel.
    // Its outer face sits 2 mm past the wing's +Z face = 1 mm proud of the seam it straddles (its y 0.01..0.03 footprint covers
    // the seam's; at +1 mm both faces were coplanar and z-fought: the log-depth rule applies to the surface the part sits on).
    // The other end (12 mm back) is buried 10 mm in the wing's 30 mm. Same end-cap rule as seamGeo.
    const wingSeamGeo = new THREE.BoxGeometry(wingLen - 2 * FL.SEAM_END_INSET_M * M, 0.01 * M, (FL.PLATE_THICK_M + 0.002) * M);
    // Fold-line hinge lug (owner 2026-09-24, "magic handwaving": nothing joined a wing to the centre panel). Cross-section in
    // the hinge-axis frame (u across the panel, v along the panel normal): a barrel of radius knuckleK − thick/2 (10 mm) on
    // the axis — its top line is the panel's lower edge and the wing's inner edge in EVERY pose, since the wing turns about
    // exactly this axis — joined to a 2 mm leaf lying flat on the face the lug belongs to (u −LEAF…−4 mm, v r−2 mm…r). The
    // leaf stops 4 mm short of the axis so its end face never shares the seam strip's side plane. Built with the leaf toward
    // −u; a lug on the other side is the same mesh turned π about the axis's own frame Z. Extruded along X (the fold axis)
    // by WING_HINGE_LUG_M.
    const lugR = knuckleK - FL.PLATE_THICK_M / 2;
    const lugLeaf = FL.WING_HINGE_LEAF_M;
    const lugShape = new THREE.Shape();
    const vLow = lugR - 0.002, uIn = -0.004;
    lugShape.moveTo(-lugLeaf * M, vLow * M);
    lugShape.lineTo(-Math.sqrt(lugR * lugR - vLow * vLow) * M, vLow * M);
    lugShape.absarc(0, 0, lugR * M,
      Math.atan2(vLow, -Math.sqrt(lugR * lugR - vLow * vLow)),
      Math.atan2(Math.sqrt(lugR * lugR - uIn * uIn), uIn), false);
    lugShape.lineTo(uIn * M, lugR * M);
    lugShape.lineTo(-lugLeaf * M, lugR * M);
    lugShape.closePath();
    const lugGeo = new THREE.ExtrudeGeometry(lugShape, {
      // 24 arc segments: the facet sagitta (≈ 0.09 mm on the 10 mm barrel) stays under test-RadiatorFold's 0.5 mm contact gate
      // at every fold angle.
      depth: FL.WING_HINGE_LUG_M * M, bevelEnabled: false, curveSegments: 24,
    });
    // shape (x_s, y_s, z_s) → axis frame (u = y, v = z, along = x); centred on x.
    lugGeo.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    lugGeo.translate(-(FL.WING_HINGE_LUG_M / 2) * M, 0, 0);
    const lugGap = 0.01;    // m between a hinge's panel lug and wing lug
    const WING_KNUCKLE_H_M = 0.012;
    const wingKnuckleGeo = new THREE.BoxGeometry(0.05 * M, 0.02 * M, WING_KNUCKLE_H_M * M);
    const wingKnuckleOuterZ = knuckleK + FL.PLATE_THICK_M / 2 + 0.002;   // wing's +Z face + 2 mm = seam face + 1 mm
    const wingKnuckleZ = wingKnuckleOuterZ - WING_KNUCKLE_H_M / 2;
    // 2 cm inset from the fold axis (y 0), matching the plate-side seam's "set back from the edge" convention, keeps r_max at
    // the pinned value (0.560): a proud element exactly ON the fold axis (y 0) measurably out-radials the wing's own far-edge
    // corner through the θ-rotation; 2 cm in from it does not (test-FlowerLaunchFold (ii)).
    const WING_DETAIL_Y_M = 0.02;
    // Bracket box 0.14 radial × 0.14 tangential × 0.10 deep, spans r 0.37..0.51 about the pin at 0.475 (the P1 band widened to
    // 0.51 by the owner-approved amendment), z −0.99..−0.89. A U in plan: the Ø60 boom sweeps x >= -0.030 m, |y| <= 0.030 m
    // about the pin at every angle 0..180, so a slot |y| < 0.0315 m (1.5 mm clear) is cut from the +X end back to x = -0.031 m
    // (pivot-local), leaving the stop seat (stops sit at x -0.0405..-0.0305) and two side blocks for the ears and harness. The
    // mesh sits at pivot-local x -0.035, so slot floor = local 0.004. The two OUTER corners are cut 20 x 20 mm (45 deg), full
    // depth: the wing end collar (R 60 mm, 12 mm thick, 1.014 m from the wing pivot) sweeps past a sharp corner at wing tilt
    // 13..19 deg and touched it (0 mm). The bounding box (0.14 x 0.14 x 0.10, pinned by test-FlowerHardware) is unchanged.
    // The two outer mount bolts sit inboard (BOLT_OUT_X/Y), and the bolt heads are M6-size (see boltGeo).
    const PAD_CORNER_CUT = 0.020;
    const padShape = new THREE.Shape([[-0.07, -0.07], [0.07 - PAD_CORNER_CUT, -0.07], [0.07, -0.07 + PAD_CORNER_CUT], [0.07, -0.0315], [0.004, -0.0315], [0.004, 0.0315],
      [0.07, 0.0315], [0.07, 0.07 - PAD_CORNER_CUT], [0.07 - PAD_CORNER_CUT, 0.07], [-0.07, 0.07]]
      .map(([px, py]) => new THREE.Vector2(px * M, py * M)));
    const bracketGeo = new THREE.ExtrudeGeometry(padShape, { depth: 0.10 * M, bevelEnabled: false });
    bracketGeo.translate(0, 0, -0.05 * M);                  // centred in z
    // The tip boss grows over the plate/boom seam: h 0.065 at tip-local x −0.0275 spans boom-x (R − 0.06)…(R + 0.005)
    // (2.24…2.305 at R 2.30): the plate's end face (PLATE_END_M 2.25, pinned) is buried 10 mm inside the boss and the boom
    // tip (2.30) sits 5 mm inside the boss's outer face — no bare 10 mm of boom between plate and boss, no coplanar end
    // discs. 48 radial segments: the boss's outer face is the strut tip's silhouette and read as an octagon at fewer.
    const padGeo = new THREE.CylinderGeometry(0.05 * M, 0.05 * M, 0.065 * M, 48);
    // M6-size bolt head Ø12: the outer bolts must sit fully on the cut pad AND >= 25 mm from the folded radiator
    // (test-StrutHinge d); the two limits cannot both be met with larger heads.
    const boltGeo = new THREE.CylinderGeometry(0.006 * M, 0.006 * M, 0.012 * M, 24);

    // Leash tip hardware (owner 2026-10-14, DECISIONS §1 "reel in at a petal tip"): a telescoping stalk (two nested tubes)
    // carries a slotted cone out to the latch point: TipCargo puts it TIP_STALK_M 0.15 m past the PAD ORIGIN (the pad's
    // centre, tip-local x -0.0275) = tip-local x 0.1225, which is the cone's MOUTH centre. Round-parts rule counts: r 8 / 6 mm
    // -> 24 around, the cone r 40 mm -> 48. The cone is an open-ended CylinderGeometry (not ConeGeometry) so test-RoundParts
    // measures it; four slots (2 of the 48 segments wide, mouth row only) are cut out of its index.
    const tipHwGeo = (() => {
      const cone = new THREE.CylinderGeometry(0.04 * M, 0.012 * M, 0.03 * M, 48, 2, true);   // top (+Y) = the mouth
      const pos = cone.getAttribute('position'), idx = cone.index.array, keep = [];
      const mouthY = 0.015 * M;
      for (let t = 0; t < idx.length; t += 3) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 3; k++) { cx += pos.getX(idx[t + k]); cy += pos.getY(idx[t + k]); cz += pos.getZ(idx[t + k]); }
        cx /= 3; cy /= 3; cz /= 3;
        const seg = ((Math.atan2(cz, cx) / (Math.PI * 2) + 1) % 1) * 48;        // 0..48 around
        const slotted = cy > mouthY * 0.1 && (Math.floor(seg + 1e-6) % 12) < 2;  // mouth row, 4 slots 2 segments wide
        if (!slotted) keep.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      cone.setIndex(keep);
      cone.clearGroups();
      return {
        cone,
        outer: new THREE.CylinderGeometry(0.008 * M, 0.008 * M, 0.060 * M, 24),
        inner: new THREE.CylinderGeometry(0.006 * M, 0.006 * M, 0.060 * M, 24),
      };
    })();
    const tipConeMat = padMat.clone();
    tipConeMat.side = THREE.DoubleSide;           // an open cone: the inside shows through the slots

    // owner 2026-10-13: realistic hinges ("for 3D print M4 bolts can be used"). Small merge helper: one BufferGeometry per
    // face (BufferGeometryUtils is not vendored). Parts are given in METRES, panel-local.
    const mergeGeos = (list) => {
      const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
      const out = new THREE.BufferGeometry();
      for (const [attr, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
        const total = parts.reduce((a, g) => a + g.attributes[attr].array.length, 0);
        const arr = new Float32Array(total);
        let o = 0;
        for (const g of parts) { arr.set(g.attributes[attr].array, o); o += g.attributes[attr].array.length; }
        out.setAttribute(attr, new THREE.BufferAttribute(arr, size));
      }
      return out;
    };
    const boxAt = (w, h, d, cx, cy, cz) => {
      const g = new THREE.BoxGeometry(w * M, h * M, d * M);
      g.translate(cx * M, cy * M, cz * M);
      return g;
    };
    // Edge frame: two rails per panel, 14 mm wide, 1 mm proud of EACH face, 10 mm in from each end (the SEAM_END_INSET_M rule,
    // so no end face shares a plane with the panel's). On the centre panel they sit just inboard of the dark fold-line seams
    // (y 0.113..0.127; the seams are 0.128..0.148); on a wing they are the outer edge (inset 1 mm so the rail's edge face is
    // not coplanar with the wing's) and a stiffener at y 0.033..0.047.
    const RAIL_W = 0.014, RAIL_H = FL.PLATE_THICK_M + 0.002, RIDGE_W = 0.010, RIDGE_UP = 0.0015;
    const railLen = plateLen / M - 2 * FL.SEAM_END_INSET_M;
    const wingRailLen = wingLen / M - 2 * FL.SEAM_END_INSET_M;
    const frameCentreGeo = mergeGeos([
      boxAt(railLen, RAIL_W, RAIL_H, 0, 0.120, 0), boxAt(railLen, RAIL_W, RAIL_H, 0, -0.120, 0)]);
    // wing-local y is measured from the fold axis (the wing mesh's own centre is at y wingW / 2)
    const frameWingGeo = mergeGeos([
      boxAt(wingRailLen, RAIL_W, RAIL_H, 0, 0.142, 0), boxAt(wingRailLen, RAIL_W, RAIL_H, 0, 0.040, 0)]);
    // §11.17: the rails are PAINTED on the faces as a mipmapped texture, not drawn as geometry: a 0.7-2 px box shimmers as the
    // view turns. The rail meshes stay in the scene (names, sizes and clearances are pinned by tests) but are not drawn:
    // `paintedAway` is a material that three skips (material.visible false), so mesh.visible and raycasts are unchanged.
    // ShipKeepOut skips invisible materials, so the material says `keepOutSolid` and the keep-out still counts the boxes
    // (<= 1 mm, as the clearance fixtures were measured); MotherCallouts._chainVisible skips them for picking and outlines.
    // Row 0 of the texture is the face's -Y edge; both rails are measured from there.
    const paintedAway = new THREE.MeshBasicMaterial();
    paintedAway.visible = false;
    paintedAway.userData.keepOutSolid = true;
    const railFace = (lengthM, widthM, bands) => [frontMat, backMat].map((base, k) => {
      const mat = base.clone();
      mat.map = getRadiatorRailTexture({
        lengthM, widthM, endInsetM: FL.SEAM_END_INSET_M, faceHex: 0xE8E6E0,
        rails: bands.map(([c, w, kind]) => [c, w, kind === 'seam' ? 0x1c1e26 : 0x55585c]),
      });
      mat.color.set(0xffffff);                      // the face colour lives in the texture now
      return mat;
    });
    const plateMatCentre = [metalMat, metalMat, metalMat, metalMat, ...railFace(plateLen / M, 2 * cHalf, [
      [cHalf - 0.120, RAIL_W, 'rail'], [cHalf + 0.120, RAIL_W, 'rail'],
      [cHalf - seamY / M, FL.WING_SEAM_M, 'seam'], [cHalf + seamY / M, FL.WING_SEAM_M, 'seam']])];
    const plateMatWing = [metalMat, metalMat, metalMat, metalMat, ...railFace(wingLen / M, wingW, [
      [0.142, RAIL_W, 'rail'], [0.040, RAIL_W, 'rail'], [WING_DETAIL_Y_M, 0.01, 'seam']])];
    // Coolant channels: 11 ridges (5 centre, 3 per wing), 10 mm wide, 1.5 mm proud, +Z face only. The middle centre ridge runs
    // under the Ø60 boom spine (the boom stands 15 mm proud of the face): it is there, not seen.
    const ridge = (len, cy) => boxAt(len, RIDGE_W, RIDGE_UP + 0.001, 0, cy, FL.PLATE_THICK_M / 2 + RIDGE_UP / 2 - 0.0005);
    const pipesCentreGeo = mergeGeos([-0.085, -0.045, 0, 0.045, 0.085].map((y) => ridge(railLen, y)));
    const pipesWingGeo = mergeGeos([0.06, 0.09, 0.12].map((y) => ridge(wingRailLen, y)));

    // The root clevis (two-ear clevis on a pad; stepped pin; ears; bearing bosses; a motor + harmonic-gear cylinder on one
    // pin end, a small encoder cap on the other; two hard stops; a U harness loop) scaled x1.2 for the Ø60 boom. The pad is the
    // bracket box above (its size is pinned by test-FlowerHardware). Pivot-local metres: +X radial out, +Y along the pin, +Z
    // ship fore; the pin is the origin. The boom (Ø60, starting AT the pin) turns between the ears with a 3 mm gap each side,
    // so no tongue is needed.
    // A cylinder along Y with its far end closed and the end against its neighbour left open (that face is hidden and would
    // only cost triangles): side wall plus one cap, `dir` +1/-1 = which end is closed.
    const capped = (r, len, segs, centreY, dir) => {
      const wall = new THREE.CylinderGeometry(r * M, r * M, len * M, segs, 1, true);
      const cap = new THREE.CircleGeometry(r * M, segs);
      cap.rotateX(dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      if (segs === 6) cap.rotateY(Math.PI / 6);            // a hexagon: the cylinder wall's corners sit 30 deg off the circle's
      cap.translate(0, (dir * len) / 2 * M, 0);
      const g = mergeGeos([wall, cap]);
      g.translate(0, centreY * M, 0);
      return g;
    };
    const EAR_R = 0.022, EAR_UP = 0.014, EAR_IN = 0.033, EAR_T = 0.010, BOSS_R = 0.019, BOSS_T = 0.008;
    const earShape = new THREE.Shape();
    earShape.moveTo(-EAR_R * M, EAR_UP * M);
    earShape.lineTo(-EAR_R * M, 0);
    earShape.absarc(0, 0, EAR_R * M, Math.PI, 2 * Math.PI, false);      // the aft half round the pin
    earShape.lineTo(EAR_R * M, EAR_UP * M);                              // the straight sides run 14 mm into the pad
    earShape.closePath();
    const earBase = new THREE.ExtrudeGeometry(earShape, { depth: EAR_T * M, bevelEnabled: false, curveSegments: 24 });
    // shape (x, y, depth) -> pivot (x, -depth, y): the ear lies in the X-Z plane and is EAR_T thick along Y
    earBase.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    const earGeo = (side) => {                                            // side +1: y from EAR_IN to EAR_IN + EAR_T
      const ear = earBase.clone();
      ear.translate(0, (side > 0 ? EAR_IN + EAR_T : -EAR_IN) * M, 0);
      // duplex-bearing boss, Ø38: side + outer face only (the inner face is against the ear)
      const boss = capped(BOSS_R, BOSS_T, 24, side * (EAR_IN + EAR_T + BOSS_T / 2), side);
      return mergeGeos([ear, boss]);
    };
    const earLGeo = earGeo(-1), earRGeo = earGeo(+1);
    const ACT_Y0 = EAR_IN + EAR_T + BOSS_T, ENC_Y0 = -(EAR_IN + EAR_T + BOSS_T);
    const actuatorGeo = capped(0.027, 0.034, 48, ACT_Y0 + 0.017, +1);    // Ø54 x 34 motor + harmonic gear
    const encoderGeo = capped(0.018, 0.017, 24, ENC_Y0 - 0.0085, -1);    // Ø36 x 17
    // stepped pin: a real Ø20 cylinder shaft (print/dims.mjs measures FlowerStrutPin_<i> as a cylinder), with a Ø28 head
    // on the actuator end and a hex nut on the encoder end as one more mesh, `..._Bracket_<i>_PinEnds`
    const pinGeo = new THREE.CylinderGeometry(0.010 * M, 0.010 * M, 0.157 * M, 24);
    pinGeo.translate(0, 0.0085 * M, 0);
    const pinEndsGeo = mergeGeos([capped(0.014, 0.004, 24, 0.089, +1), capped(0.0139, 0.006, 6, -0.073, -1)]);
    // hard stops, 0.5 mm off the boom's -X flank (the flank is at x = -0.030): Lo meets it at 0 deg, Hi at 180 deg
    const stopLoGeo = new THREE.BoxGeometry(0.010 * M, 0.024 * M, 0.012 * M);
    const stopHiGeo = new THREE.BoxGeometry(0.010 * M, 0.024 * M, 0.020 * M);
    // U harness: out of the actuator, round the pad's +X side and into the pad (ends buried 3-5 mm: pinned by test-WingBracketClear)
    const harnessGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      [0.024, 0.074, 0.0], [0.050, 0.074, 0.004], [0.058, 0.074, 0.030], [0.046, 0.068, 0.058], [0.0175, 0.062, 0.062],
    ].map(([x, y, z]) => new THREE.Vector3(x * M, y * M, z * M))), 8, 0.0035 * M, 5, false);
    // Hand of the clevis: on the pivots at 140 and 320 deg the Ø54 x 34 motor end of the pin (pin head, motor, harness) would
    // point at the wing's end collar: its end-face centre stands 11.5 mm from the collar's edge and its rim and the harness lie
    // in the collar's path at wing tilt 13..19 deg (measured 0.0 mm; test-WingBracketClear). No trim of a Ø54 motor can give
    // 5 mm there (it would need about Ø16), so those two clevises are built as the mirror image about the pad's centre line
    // (local Y): motor end, pin head, nut end, encoder, harness and the pin's offset all swap sides. Every clevis then shows its
    // small Ø36 x 17 encoder end to the wing. Nothing else moves: pin axis, ears (already mirror images), pad, stops and bolts
    // are unchanged.
    const mirrorY = (g) => {
      const n = g.index ? g.toNonIndexed() : g.clone();
      for (const [name, sg] of [['position', -1], ['normal', -1]]) {
        const a = n.attributes[name];
        if (a) for (let k = 0; k < a.count; k++) a.setY(k, sg * a.getY(k));
      }
      for (const a of [n.attributes.position, n.attributes.normal, n.attributes.uv]) {   // reflect = reverse every triangle's winding
        if (!a) continue;
        const s = a.itemSize, arr = a.array;
        for (let t = 0; t + 2 < a.count; t += 3) {
          for (let c = 0; c < s; c++) { const tmp = arr[(t + 1) * s + c]; arr[(t + 1) * s + c] = arr[(t + 2) * s + c]; arr[(t + 2) * s + c] = tmp; }
        }
      }
      return n;
    };
    // the pin shaft is a cylinder about its own axis, so its mirror is the same cylinder shifted the other way (stays a CylinderGeometry)
    const pinGeoMirrored = new THREE.CylinderGeometry(0.010 * M, 0.010 * M, 0.157 * M, 24);
    pinGeoMirrored.translate(0, -0.0085 * M, 0);
    const mirroredClevis = { Actuator: mirrorY(actuatorGeo), Encoder: mirrorY(encoderGeo), PinEnds: mirrorY(pinEndsGeo), Harness: mirrorY(harnessGeo), Pin: pinGeoMirrored };
    // Coolant manifold header at each panel's root edge: a Ø26 tube across the panel width, axis on the mid-plane (so it is
    // entirely inside the 30 mm thickness), sticking HEADER_OUT_M out of the root end; 10 mm short of each side edge so its end
    // caps never share a plane with the panel's edge faces.
    const HEADER_R = 0.013, HEADER_OUT = 0.012;
    const headerCentreGeo = new THREE.CylinderGeometry(HEADER_R * M, HEADER_R * M, (2 * cHalf - 0.02) * M, 24);
    const headerWingGeo = new THREE.CylinderGeometry(HEADER_R * M, HEADER_R * M, (wingW - 0.02) * M, 24);
    const headerAxisX = (HEADER_R - HEADER_OUT) * M;        // offset of the tube axis inboard of the root end face

    // Fold-line flex hose: a corrugated Ø14 core with Ø17 end rings ON the fold axis, between the two hinge stations (they end
    // 0.555 m either side of the panel centre). Round about the axis, so it looks the same at every fold angle, and a child of
    // `hinge` (never turns). The corrugation itself is a stripe texture on the tube (24 sides x 5 profile steps): real rings
    // would cost ~1,700 triangles a hose.
    const HOSE_R_CORE = 0.007, HOSE_R_RING = 0.0085, HOSE_HALF = 0.545, HOSE_RING_W = 0.006, HOSE_PITCH = 0.012;
    const hoseGeo = new THREE.LatheGeometry([
      new THREE.Vector2(HOSE_R_RING * M, -HOSE_HALF * M),
      new THREE.Vector2(HOSE_R_RING * M, (-HOSE_HALF + HOSE_RING_W) * M),
      new THREE.Vector2(HOSE_R_CORE * M, (-HOSE_HALF + HOSE_RING_W) * M),
      new THREE.Vector2(HOSE_R_CORE * M, (HOSE_HALF - HOSE_RING_W) * M),
      new THREE.Vector2(HOSE_R_RING * M, (HOSE_HALF - HOSE_RING_W) * M),
      new THREE.Vector2(HOSE_R_RING * M, HOSE_HALF * M),
    ], 24);
    hoseGeo.rotateZ(-Math.PI / 2);                       // lathe axis Y -> fold axis X
    {
      const pos = hoseGeo.attributes.position, uv = hoseGeo.attributes.uv;
      for (let k = 0; k < pos.count; k++) uv.setY(k, pos.getX(k) / M / HOSE_PITCH);   // stripes by length, not by profile step
    }
    const stripe = new Uint8Array(8 * 4);
    for (let k = 0; k < 8; k++) { const v = k < 4 ? 200 : 96; stripe.set([v, v, v + 6, 255], k * 4); }
    const hoseTex = new THREE.DataTexture(stripe, 1, 8, THREE.RGBAFormat);
    hoseTex.wrapT = THREE.RepeatWrapping;
    hoseTex.generateMipmaps = false;
    hoseTex.minFilter = THREE.LinearFilter;
    hoseTex.needsUpdate = true;
    const hoseMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: hoseTex, metalness: 0.3, roughness: 0.65 });
    // Fold-line bolts (M4-class, 3D-print friendly): a Ø6 shaft through each lug pair, hexagonal heads at both ends
    // (hex = a bolt head and a nut; a merged buffer, so the radius rule for cylinders does not see it).
    const boltPinGeo = (() => {
      const shaftLen = 2 * FL.WING_HINGE_LUG_M + 0.014;       // both lugs + the 10 mm gap + 2 mm each side
      const shaft = new THREE.CylinderGeometry(0.003 * M, 0.003 * M, shaftLen * M, 12, 1, true);
      shaft.rotateZ(-Math.PI / 2);
      const heads = [-1, 1].map((sg) => {
        const h = capped(0.004, 0.0028, 6, 0, sg);          // outer face closed, the face on the lug left open
        h.rotateZ(-Math.PI / 2);
        h.translate(sg * (shaftLen + 0.0028) / 2 * M, 0, 0);
        return h;
      });
      return mergeGeos([shaft, ...heads]);
    })();

    for (const azDeg of azList) {
      const i = FL.AZIMUTHS_DEG.indexOf(azDeg);
      const azRad = degToRad(azDeg);

      // Pivot at the hinge point on the rim ring; local +X = radial out,
      // +Y = tangential, +Z = ship +Z.
      const pivot = new THREE.Group();
      pivot.position.set(
        Math.cos(azRad) * FL.HINGE_R_M * M,
        Math.sin(azRad) * FL.HINGE_R_M * M,
        FL.HINGE_Z_M * M,
      );
      pivot.rotation.z = azRad;
      pivot.name = `FlowerStrutPivot_${i}`;
      this.add(pivot);

      // Hinge bracket — clevis on the barrel FORE of the rim, inside the allocated band (z −1.000..−0.886, r 0.34..0.51): box
      // spans r 0.37..0.51 about the pin at r 0.475, z −0.99..−0.89. Does not rotate with the pose. The clevis stands 7.5 cm
      // above the rim so the fore-folded boom clears the PV / MGA corners (Constants.THERMAL.FLOWER.HINGE_R_M). The box's aft
      // face stands 10 mm clear of the rear-cap plane (no coplanar tie); test-FlowerHardware's band check still holds.
      const bracket = new THREE.Mesh(bracketGeo, bracketMat);
      bracket.position.set(-0.035 * M, 0, 0.06 * M);  // centre r 0.44 → box r 0.37..0.51
      bracket.name = `FlowerStrutBracket_${i}`;
      bracket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      pivot.add(bracket);

      // Hinge pin along the tangential (local Y) clevis axis: stepped, with head and nut (v4 D6).
      const mirrored = Math.sin(azRad) * Math.cos(azRad) < 0;   // the clevises at 140 and 320 deg: motor end away from the wing (see mirrorY)
      const hand = (part, geo) => (mirrored ? mirroredClevis[part] : geo);
      const pin = new THREE.Mesh(hand('Pin', pinGeo), metalMat);
      pin.name = `FlowerStrutPin_${i}`;
      pin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      pin.userData.noSolarShade = true;
      pivot.add(pin);
      // The rest of the clevis; none of it turns.
      for (const [part, geo, mat] of [
        ['EarL', earLGeo, bracketMat], ['EarR', earRGeo, bracketMat], ['PinEnds', hand('PinEnds', pinEndsGeo), metalMat], ['Actuator', hand('Actuator', actuatorGeo), padMat],
        ['Encoder', hand('Encoder', encoderGeo), bracketMat], ['Harness', hand('Harness', harnessGeo), seamMat],
      ]) {
        const m = new THREE.Mesh(geo, mat);
        m.name = `FlowerStrutBracket_${i}_${part}`;
        m.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        m.userData.noSolarShade = true;
        pivot.add(m);
      }
      for (const [part, geo, z] of [['StopLo', stopLoGeo, 0.006], ['StopHi', stopHiGeo, -0.010]]) {
        const m = new THREE.Mesh(geo, metalMat);
        m.position.set(-0.0355 * M, 0, z * M);
        m.name = `FlowerStrutBracket_${i}_${part}`;
        m.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        m.userData.noSolarShade = true;
        pivot.add(m);
      }

      // Bracket mount bolts — DETAIL-LOD inert hardware (MountBolt_ prefix joins the existing cull family; hidden when far).
      // Ride the bracket's fore face: centre 2 mm proud of it (face at z 0.11 → bolts at 0.112; 12 mm shank half-buried). The
      // two outer bolts sit inboard so each head is fully on the pad, 10.6 mm inside the 20 mm corner cut face (radius 8 + 2 mm).
      const BOLT_OUT_X = 0.0115, BOLT_OUT_Y = 0.061;
      const boltAt = [[BOLT_OUT_X, BOLT_OUT_Y], [BOLT_OUT_X, -BOLT_OUT_Y], [-0.035, 0.055], [-0.035, -0.055]];
      boltAt.forEach(([bx, by], k) => {
        const bolt = new THREE.Mesh(boltGeo, padMat);
        bolt.rotation.x = Math.PI / 2;
        bolt.position.set(bx * M, by * M, 0.112 * M);
        bolt.name = `MountBolt_Flower_${i}_${k}`;
        bolt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        pivot.add(bolt);
      });

      // Hinge group — rotation.y = θ − 90° (set every frame by _updateFlower).
      const hinge = new THREE.Group();
      hinge.name = `FlowerStrutHinge_${i}`;
      pivot.add(hinge);
      this._buildFlowerCradle(i, azDeg, hinge, FL, mergeGeos);   // launch hold-down cradle + latch lug

      const boom = new THREE.Mesh(boomGeo, boomMat);
      boom.rotation.z = Math.PI / 2;                 // cylinder Y-axis → local X
      boom.position.x = boomLen / 2;
      boom.name = `FlowerStrut_${i}`;
      boom.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      hinge.add(boom);

      // Radiator plate ALONG the strut, width TANGENTIAL (local Y — the allocation table's plate clause). The Ø60 mm boom runs
      // through the 30 mm plate's mid-plane, so it stands 15 mm proud of BOTH faces as a central spine (intentional: a
      // bare-plate look would need a boom ≤ Ø30 or a thicker plate; neither is wanted). FlowerStrutPlate_${i} is the 0.30 m
      // CENTRE panel (name, boom-spine mid-plane and tangential-width convention kept — the callout binding and
      // test-FlowerHardware's spine pin read this mesh).
      const plate = new THREE.Mesh(plateGeo, plateMatCentre);
      plate.position.x = plateX;
      plate.name = `FlowerStrutPlate_${i}`;
      plate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      hinge.add(plate);
      // edge rails + coolant channels of the centre panel (children of the hinge, like the panel itself)
      const plateFrame = new THREE.Mesh(frameCentreGeo, metalMat);
      plateFrame.position.x = plateX;
      plateFrame.name = `FlowerStrutPlate_${i}_Frame`;
      plateFrame.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      plateFrame.userData.noSolarShade = true;
      plateFrame.material = paintedAway;          // §11.17: painted on the face instead
      hinge.add(plateFrame);
      const platePipes = new THREE.Mesh(pipesCentreGeo, frontMat);
      platePipes.position.x = plateX;
      platePipes.name = `FlowerStrutPlate_${i}_Pipes`;
      platePipes.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      platePipes.userData.noSolarShade = true;
      hinge.add(platePipes);
      const plateHeader = new THREE.Mesh(headerCentreGeo, metalMat);
      plateHeader.position.x = plateX - plateLen / 2 + headerAxisX;
      plateHeader.name = `FlowerStrutPlate_${i}_Header`;
      plateHeader.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      plateHeader.userData.noSolarShade = true;
      hinge.add(plateHeader);

      // Wings: one hinge group per side at the hinge line (x_mid, ±0.15, −knuckleK) — the 2.5 cm offset puts the fold axis
      // below the −Z face so the folded wing lands one layer (0.050) outboard of the centre panel with a 20 mm air gap (clear
      // of the boom, which stands 15 mm proud). The L group is turned π about Z so its local +Y points outward along ITS wing,
      // with Euler order ZXY so its fold turn is taken BEFORE that flip: both groups then fold to the same (−Z) side with one
      // shared sign (rotation.x = −π folded … 0 open, _updateFlower's lanyard law). With the default XYZ order the X turn was
      // applied in the parent frame, so the L wing folded UP over the +Z face and passed through the centre panel for
      // 30°–170° of its swing (owner 2026-09-24: "3 panels folding in a Z but 2 layers"). Open: mid-plane flush with the
      // centre panel, inner edge butt-jointed at y = ±0.15. Folded: wing R spans y 0..0.15 and wing L 0..−0.15 at mid-plane
      // z −0.050 — they MEET at y = 0 edge-to-edge, under the boom.
      const wings = [];
      for (const [side, sgn] of [['L', -1], ['R', +1]]) {
        const wh = new THREE.Group();
        wh.name = `FlowerStrutWingHinge_${i}_${side}`;
        wh.position.set(plateX, sgn * cHalf * M, -knuckleK * M);
        if (sgn < 0) { wh.rotation.order = 'ZXY'; wh.rotation.z = Math.PI; }
        hinge.add(wh);
        // local +X is ship −X on the L side (the π turn), so the tip-end
        // shortening shifts the wing by −sgn·inset/2 to keep its root flush.
        const wingShiftX = -sgn * wingInset / 2;
        const wing = new THREE.Mesh(wingGeo, plateMatWing);
        wing.position.set(wingShiftX, (wingW / 2) * M, knuckleK * M);
        wing.name = `FlowerStrutWing_${i}_${side}`;
        wing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        wh.add(wing);
        // the wing's own rails and channels ride its fold transform (children of `wh`)
        const wingFrame = new THREE.Mesh(frameWingGeo, metalMat);
        wingFrame.position.set(wingShiftX, 0, knuckleK * M);
        wingFrame.name = `FlowerStrutWing_${i}_${side}_Frame`;
        wingFrame.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        wingFrame.userData.noSolarShade = true;
        wingFrame.material = paintedAway;         // §11.17
        wh.add(wingFrame);
        const wingPipes = new THREE.Mesh(pipesWingGeo, frontMat);
        wingPipes.position.set(wingShiftX, 0, knuckleK * M);
        wingPipes.name = `FlowerStrutWing_${i}_${side}_Pipes`;
        wingPipes.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        wingPipes.userData.noSolarShade = true;
        wh.add(wingPipes);
        // The wing's root end is ship -X side for R and (after the L group's turn) wh +X for L.
        const wingHeader = new THREE.Mesh(headerWingGeo, metalMat);
        wingHeader.position.set(-sgn * (plateLen / 2 - headerAxisX), (wingW / 2) * M, knuckleK * M);
        wingHeader.name = `FlowerStrutWing_${i}_${side}_Header`;
        wingHeader.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        wingHeader.userData.noSolarShade = true;
        wh.add(wingHeader);
        // The WING's own hinge-line detail (children of `wh`: it carries the wing's fold transform exactly): the seam straddles
        // the wing's mid-plane (wh y 0.015..0.025), three knuckle blocks ride the same y line. Folded, the seam's inner-face
        // millimetre sits 19 mm off the centre panel's face (the 20 mm WING_GAP_M minus 1): no contact.
        const wingSeam = new THREE.Mesh(wingSeamGeo, seamMat);
        wingSeam.position.set(wingShiftX, WING_DETAIL_Y_M * M, knuckleK * M);
        wingSeam.name = `FlowerStrutWingSeam_${i}_${side}`;
        wingSeam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        wingSeam.material = paintedAway;          // §11.17: painted on the face
        wh.add(wingSeam);
        [-0.6, 0, 0.6].forEach((sx, k) => {
          const wkn = new THREE.Mesh(wingKnuckleGeo, bracketMat);
          wkn.position.set(sx * M, WING_DETAIL_Y_M * M, wingKnuckleZ * M);
          wkn.name = `FlowerStrutWingKnuckle_${i}_${side}_${k}`;
          wkn.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
          wh.add(wkn);
        });
        // The fold line's two hinges: at each WING_HINGE_X_M station a
        // panel-side lug (hinge child — never moves; leaf on the centre
        // panel's −Z face) and, 10 mm further along, a wing-side lug (wh
        // child — its barrel turns in place about its own axis; its leaf rides
        // the wing's inner face). Lug x positions are in ship-frame terms, so
        // the wh-local x is multiplied by sgn (the L group's π turn).
        FL.WING_HINGE_X_M.forEach((hx, k) => {
          const panelX = hx - (FL.WING_HINGE_LUG_M + lugGap) / 2;
          const wingX = hx + (FL.WING_HINGE_LUG_M + lugGap) / 2;
          const pl = new THREE.Mesh(lugGeo, metalMat);
          pl.position.set(plateX + panelX * M, sgn * cHalf * M, -knuckleK * M);
          if (sgn < 0) pl.rotation.z = Math.PI;      // leaf toward the centre (+y on the L side)
          pl.name = `FlowerStrutHingeLug_${i}_${side}_${k}_Panel`;
          pl.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
          hinge.add(pl);
          const wl = new THREE.Mesh(lugGeo, metalMat);
          wl.position.set(sgn * wingX * M, 0, 0);    // on the axis, in wh-local
          wl.rotation.z = Math.PI;                    // leaf out along the wing (wh-local +y)
          wl.name = `FlowerStrutHingeLug_${i}_${side}_${k}_Wing`;
          wl.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
          wh.add(wl);
          // the bolt through this lug pair (fixed to the panel side, on the fold axis; the wing lug turns on it)
          const bolt = new THREE.Mesh(boltPinGeo, metalMat);
          bolt.position.set(plateX + hx * M, sgn * cHalf * M, -knuckleK * M);
          bolt.name = `FlowerStrutHingeLug_${i}_${side}_${k}_Pin`;
          bolt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
          bolt.userData.noSolarShade = true;
          hinge.add(bolt);
        });
        const hose = new THREE.Mesh(hoseGeo, hoseMat);
        hose.position.set(plateX, sgn * cHalf * M, -knuckleK * M);
        hose.name = `FlowerStrutHingeLug_${i}_${side}_Hose`;
        hose.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        hose.userData.noSolarShade = true;
        hinge.add(hose);
        // Seam strip on the CENTRE panel's edge (a hinge child — it does not
        // fold with the wing): y from ±0.128 to ±0.148, 1 mm proud each face.
        const seam = new THREE.Mesh(seamGeo, seamMat);
        seam.position.set(plateX, sgn * seamY, 0);
        seam.name = `FlowerStrutSeam_${i}_${side}`;
        seam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        seam.material = paintedAway;              // §11.17: painted on the face
        hinge.add(seam);
        wings.push(wh);
      }

      // Inert tip hardpoint — a named node + boss pad. NO booking, NO cargo logic.
      const tip = new THREE.Group();
      tip.position.x = boomLen;
      tip.name = `FlowerStrutTip_${i}`;
      hinge.add(tip);
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.rotation.z = Math.PI / 2;                  // pad axis along local X
      pad.position.x = -0.0275 * M;                  // boss spans boom-x R−0.06…R+0.005 (see padGeo)
      pad.name = `FlowerStrutTipPad_${i}`;
      pad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      tip.add(pad);

      // Leash tip hardware — two nested tubes and a slotted cone on a pivot at its narrow end. _updateTipStalks owns their
      // POSITIONS (retracted into the pad for the launch fold, out at the latch point); LeashVisual owns the cone pivot's
      // ROTATION (the swivel). Same render tier as the pad.
      const stalk = new THREE.Mesh(tipHwGeo.outer, padMat);
      stalk.rotation.z = Math.PI / 2;                // tube axis along local X
      stalk.name = `FlowerStrutTipStalk_${i}`;
      stalk.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      tip.add(stalk);
      const stalkIn = new THREE.Mesh(tipHwGeo.inner, padMat);
      stalkIn.rotation.z = Math.PI / 2;
      stalkIn.name = `FlowerStrutTipStalk_${i}_Inner`;
      stalkIn.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      tip.add(stalkIn);
      const conePivot = new THREE.Group();
      conePivot.name = `FlowerStrutTipConePivot_${i}`;
      tip.add(conePivot);
      const cone = new THREE.Mesh(tipHwGeo.cone, tipConeMat);
      cone.rotation.z = -Math.PI / 2;                // cone mouth (+Y) -> local +X, outward
      cone.position.x = 0.015 * M;                   // pivot sits at the narrow end; the mouth is 0.03 m out
      cone.name = `FlowerStrutTipCone_${i}`;
      cone.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      conePivot.add(cone);

      this._flowerGroups.push({
        hinge, azDeg, pair: pairKey, wings,
        tipHw: { index: i, stalk, stalkIn, conePivot, cone, u: NaN },
      });
    }

    // Initialize the new pair at the current shared pose immediately (a pair bought mid-slew joins the swing on the next
    // driver tick).
    PlayerSatellite.prototype._writeFlowerPose.call(this);   // via the prototype: test stubs borrow this method
  }

  /**
   * Pose the leash tip hardware for radiator angle θ: POSITIONS only of the two stalk tubes and the cone pivot (never
   * scale: scale 0 breaks keep-out maths); the cone's rotation is LeashVisual's. Retracted (tubes slid into the pad,
   * cone mouth level with the pad's outer face) at or below STALK_FROM_DEG (2°), linearly out by 3°. A tip holding a
   * bag, or the one the hand-off is using, stays fully out at any θ.
   * @param {number} [thetaRad] — default: the current radiator angle
   */
  _updateTipStalks(thetaRad) {
    const groups = this._flowerGroups;
    if (!groups || groups.length === 0) return;
    const FL = Constants.THERMAL.FLOWER;
    const th = Number.isFinite(thetaRad) ? thetaRad : this._flowerThetaRad;
    const floor = degToRad(FL.STALK_FROM_DEG);     // own constant: the stalks keep 2°..3° though the radiator floor is 0°
    const openAt = (t) => clamp01((t - floor) / DEG2RAD);     // 0 at 2° .. 1 at 3°
    const open = openAt(th);
    const holds = this._petalHolds || EMPTY_HOLDS;
    const tc = this.tipCargo;
    const view = this.leashDriver && typeof this.leashDriver.view === 'function' ? this.leashDriver.view() : null;
    for (const fg of groups) {
      const hw = fg.tipHw;
      if (!hw) continue;
      const held = (tc && typeof tc.has === 'function' && tc.has(hw.index)) || (view && view.tipIndex === hw.index);
      let own = open;                                                         // a held petal's stalk follows ITS angle
      for (let i = 0; i < holds.length; i++) if (holds[i].az === fg.azDeg) { own = openAt(holds[i].thetaRad); break; }
      const u = held ? 1 : own;
      if (u === hw.u) continue;
      hw.u = u;
      // tip-local x, metres. Out: outer tube 0.000..0.060 (root buried in the pad), inner tube 0.0345..0.0945, cone
      // mouth 0.1225 = the latch point (TipCargo: pad origin -0.0275 + 0.15). In: tubes inside the boom behind the pad,
      // cone mouth 1 mm below the pad's outer face; no coplanar faces (every end face >= 2 mm off the pad's and boom's).
      hw.stalk.position.x = (lerp(-0.042, 0.030, u)) * M;
      hw.stalkIn.position.x = (lerp(-0.0395, 0.0645, u)) * M;
      hw.conePivot.position.x = (lerp(-0.026, 0.0925, u)) * M;
    }
  }

  /**
   * @private Wing fold angle in radians (rotation.x of both FlowerStrutWingHinge_* groups) as a PURE function of the
   * strut angle θ: −π (folded flat onto the centre panel) below WING_OPEN_START_DEG, linear to the deployed dihedral
   * by WING_OPEN_END_DEG (the orbit ladder floor), so the orbit band θ ≥ 90° always shows them open. WING_OPEN_DEG
   * 180 = flat (owner Q4); a shallower dihedral tilts each wing by (180 − D)/2 toward the fold side.
   */
  _flowerWingFoldAngle(thetaRad) {
    const FL = Constants.THERMAL.FLOWER;
    const thetaDeg = radToDeg(thetaRad);
    const open = clamp01((thetaDeg - FL.WING_OPEN_START_DEG) / (FL.WING_OPEN_END_DEG - FL.WING_OPEN_START_DEG));
    const openTilt = degToRad((180 - FL.WING_OPEN_DEG) / 2);
    return -(Math.PI * (1 - open) + openTilt * open);
  }

  /**
   * @private Per-frame flower slew driver (mirrors the daughter `_updateStruts` / `_strutTargetAlpha` latch contract):
   * bounded rate, never a snap; player intent wins mid-swing (toggle/setPose overwrite the latch); latch cleared on
   * arrival.
   *
   * POSE FLOOR: θ ≥ POSE_FLOOR_DEG is enforced HERE every frame. DECISIONS §15 row 4 made the folded radiator the
   * orbit rest, so the floor is CLOSED (0°), measured clear of the docked daughters, every strut swing, the hull and
   * the deployed wings at their dodge limit (the Constants POSE_CLOSED_DEG table). The ceiling is the stow bud: no
   * legal pose exists past 146° (Y3 axial reserve + plume band) except the deliberate VENT.
   *
   * While the launch lock is armed the floor is POSE_LAUNCH_DEG (0°), the fore-folded fairing pose, measured against
   * the DOCKED daughters. DECISIONS §10: under an OVERRIDE fold the wings no longer gate this floor (they dodge clear
   * via `_rosaDodgeLimitRad`). DECISIONS §11 (ratified): the STRUTS no longer gate it either (a new player can't read
   * a halfway-stop interlock), so an OVERRIDE fold drops straight to POSE_LAUNCH_DEG at any strut angle (held cargo
   * in the corridor is out of scope). The lock clears once, with Events.THERMAL_FLOWER_RELEASED, the frame a release
   * swing (target at or above the orbit floor) carries θ up to POSE_FLOOR_DEG; a release never latches below the
   * floor. Order: slew → clamp → release → settle, so every event carries the CLAMPED θ.
   */
  _updateFlower(dt) {
    if (this._flowerGroups.length === 0) return;
    const FL = Constants.THERMAL.FLOWER;
    // 180° → 146° settle (DECISIONS §15, owner 2026-10-09): advance the clock; once a vented radiator has sat
    // RETURN_TO_OPEN_S past the last command, aim it home BEFORE the slew reads the target. Only writes the target;
    // the ceiling and rate limit do the swing.
    this._flowerClockS = (this._flowerClockS || 0) + (dt > 0 ? dt : 0);
    settleFlowerToOpen(this);

    // Tip-bag ceiling (TipCargo): a bag on a radiator tip past its band row would sit in the engine plume cones.
    // Retarget the SLEW, never clamp θ, so the rate-limited swing brings the radiator down. The band target sits
    // SETTLE_EPS_RAD below the band edge so the arrival latch lands strictly inside the band (no retarget churn).
    const tipBand = (this.tipCargo && typeof this.tipCargo.maxRadiatorThetaRad === 'function')
      ? this.tipCargo.maxRadiatorThetaRad() : Infinity;
    const holdsTipBag = tipBand !== Infinity;
    if (holdsTipBag) {
      const bandTarget = tipBand - FL.SETTLE_EPS_RAD;
      if (this._flowerTargetTheta !== undefined && this._flowerTargetTheta > tipBand + 1e-9) {
        this._flowerTargetTheta = bandTarget;
        if (!this._flowerBandWarned) {
          this._flowerBandWarned = true;
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'THERMAL',
            text: `Radiators stop at ${Math.floor(radToDeg(tipBand) + 1e-6)}° — a catch on a radiator tip would sit in the engine plume.`,
            priority: 'info',
          });
        }
      } else if (this._flowerTargetTheta === undefined && this._flowerThetaRad > tipBand + 1e-6) {
        this._flowerTargetTheta = bandTarget;
      }
    } else {
      this._flowerBandWarned = false;
    }

    const target = this._flowerTargetTheta;
    const stepping = target !== undefined && dt > 0;
    const theta0 = this._flowerThetaRad;

    if (stepping) {
      const maxDelta = FL.SLEW_RATE_RAD_S * dt;
      const delta = target - this._flowerThetaRad;
      this._flowerThetaRad += clamp(maxDelta, -maxDelta, delta);
      this._flowerThetaRad = bandGate(this, theta0, this._flowerThetaRad, dt);   // wings wait before the band while a catch is in the way
    }

    // Pose floor + ladder ceiling, clamped in the driver unconditionally. DECISIONS §10/§11: neither wings nor struts
    // gate this floor, so an OVERRIDE fold drops below POSE_FLOOR_DEG at once.
    const orbitFloorRad = degToRad(FL.POSE_FLOOR_DEG);
    // A bag held on a tip refuses the launch fold: the floor stays at POSE_FLOOR_DEG.
    const foldFloorOpen = this._flowerLaunchLock && !holdsTipBag;
    const floorRad = foldFloorOpen ? degToRad(FL.POSE_LAUNCH_DEG) : orbitFloorRad;
    // Vent push-through: the ceiling lifts from the bud to POSE_VENT_DEG only while the player has double-commanded it.
    const ceilRad = degToRad(this._flowerVentArmed ? FL.POSE_VENT_DEG : FL.POSE_STOW_DEG);

    this._flowerThetaRad = clamp(this._flowerThetaRad, floorRad, ceilRad);

    // The radiator hinge drives (one per strut, in unison) bill on frames where θ actually moves (a clamp with no
    // slew, or dt 0, bills nothing). A held petal bills for itself (`_stepPetalHolds`).
    const holdsNow = this._petalHolds || EMPTY_HOLDS;
    if (stepping && Math.abs(this._flowerThetaRad - theta0) >= motorMoveMinRadS() * dt) {
      billMotorW(this, (Constants.MOTOR_DRAW_W?.RADIATOR_HINGE ?? 0) * Math.max(0, this._flowerGroups.length - holdsNow.length), dt);
    }
    if (holdsNow.length > 0) this._stepPetalHolds(dt, floorRad, ceilRad, holdsTipBag ? tipBand : Infinity);

    // Disarm on ARRIVAL, never on command: dropping the ceiling from the vent to the bud while θ is still out at 180°
    // would teleport the panel 34° in one frame (hard clamp); holding it lets the rate-limited swing bring θ home.
    if (this._flowerVentArmed) {
      const stowRad = degToRad(FL.POSE_STOW_DEG);
      const tgt = this._flowerTargetTheta;
      if (this._flowerThetaRad <= stowRad + 1e-9 && (tgt === undefined || tgt <= stowRad + 1e-9)) {
        this._flowerVentArmed = false;
      } else if (stepping && tgt !== undefined && tgt <= stowRad + 1e-9
          && Math.abs(this._flowerThetaRad - tgt) < FL.SETTLE_EPS_RAD) {
        // Coming DOWN from 180° onto 146°: the latch clears within SETTLE_EPS_RAD (0.57°) of the target, which can be
        // ABOVE the band edge with the ceiling still up. Land on the edge exactly so the band guard clears and the
        // ceiling drops.
        this._flowerThetaRad = Math.min(this._flowerThetaRad, stowRad);
        this._flowerVentArmed = false;
      }
    }

    // Release: an orbit-bound swing under the lock clears it the frame θ reaches the orbit floor, once per arming; the
    // ROSA centre hold (override folds) clears with it (sun-track resumes). An OVERRIDE sweep to 0° arms no lock
    // (setFlowerPose), so its wing dodge ends at the first command whose target is not below the floor.
    if (this._flowerOverrideFold && !this._flowerLaunchLock
        && target !== undefined && target >= orbitFloorRad - 1e-9) {
      this._flowerOverrideFold = false;
    }
    const releasing = this._flowerLaunchLock && target !== undefined && target >= orbitFloorRad - 1e-9;
    if (releasing && this._flowerThetaRad >= orbitFloorRad - 1e-9) {
      this._flowerLaunchLock = false;
      this._flowerOverrideFold = false;
      // The opening dance keeps the release quiet (wordless unfold).
      if (!this._danceDrivesMe()) {
        eventBus.emit(Events.THERMAL_FLOWER_RELEASED, { thetaDeg: radToDeg(this._flowerThetaRad) });
      }
    }

    if (stepping && Math.abs(this._flowerThetaRad - target) < FL.SETTLE_EPS_RAD
        && !(this._flowerLaunchLock && releasing)) {
      // Land EXACTLY on the CLOSED rest (final step < SETTLE_EPS_RAD) so a closed radiator reads θ 0° / openFrac 0, not
      // up to 0.57° / 0.0065: the D4 contract the heat lane reads. Other poses keep the daughter-contract residual.
      if (!this._flowerLaunchLock && target <= orbitFloorRad + 1e-9) this._flowerThetaRad = orbitFloorRad;
      const thetaDeg = radToDeg(this._flowerThetaRad);
      const near = (deg) => Math.abs(thetaDeg - deg) < 1.0;
      const pose = near(FL.POSE_STOW_DEG) ? 'STOW'
        : near(FL.POSE_PARK_DEG) ? 'PARK'
          : near(FL.POSE_CARGO_DEG) ? 'CARGO'
            : (!this._flowerLaunchLock && Number.isFinite(FL.POSE_CLOSED_DEG) && near(FL.POSE_CLOSED_DEG)) ? 'CLOSED'
              : near(FL.POSE_LAUNCH_DEG) ? 'LAUNCH' : 'CUSTOM';
      this._flowerTargetTheta = undefined;
      eventBus.emit(Events.THERMAL_FLOWER_POSE, { thetaDeg, pose });
    }

    PlayerSatellite.prototype._writeFlowerPose.call(this);   // via the prototype: test stubs borrow this method
  }

  /**
   * @private Slew every held petal toward its own target (the hold angle, or the shared angle once released) at
   * SLEW_RATE_RAD_S (or the hold's `rateRadS`, the leash hand-off), landing EXACTLY on it (the carry's clearance is
   * certified at the held angle). A released petal that reaches the shared angle is freed. The tip-bag band caps hold
   * targets; each moving petal bills its own hinge drive.
   */
  _stepPetalHolds(dt, floorRad, ceilRad, tipBand) {
    const FL = Constants.THERMAL.FLOWER;
    const holds = this._petalHolds;
    const bandTarget = tipBand - FL.SETTLE_EPS_RAD;
    const hingeW = Constants.MOTOR_DRAW_W?.RADIATOR_HINGE ?? 0;
    for (let i = holds.length - 1; i >= 0; i--) {
      const h = holds[i];
      let tgt = h.releasing ? this._flowerThetaRad : h.targetRad;
      if (!h.releasing && tgt > tipBand + 1e-9) tgt = bandTarget;
      tgt = clamp(tgt, floorRad, ceilRad);
      const before = h.thetaRad;
      const maxDelta = dt > 0 ? (h.rateRadS > 0 ? h.rateRadS : FL.SLEW_RATE_RAD_S) * dt : 0;
      if (maxDelta > 0) h.thetaRad += clamp(maxDelta, -maxDelta, tgt - h.thetaRad);
      h.thetaRad = clamp(h.thetaRad, floorRad, ceilRad);
      if (maxDelta > 0 && Math.abs(h.thetaRad - before) >= motorMoveMinRadS() * dt) billMotorW(this, hingeW, dt);
      if (h.releasing && Math.abs(h.thetaRad - this._flowerThetaRad) < 1e-9) holds.splice(i, 1);
    }
  }

  /**
   * @private Write every fitted petal's hinge, wing fold and tip stalk from ITS OWN angle: the shared angle for a free
   * petal, the held petal's own for a held one. Wings ride the same θ (pure function, no persisted wing state).
   * Test stubs borrow `_updateFlower`, hence the guards.
   */
  _writeFlowerPose() {
    const holds = this._petalHolds || EMPTY_HOLDS;
    const shared = this._flowerThetaRad;
    const sharedRotY = shared - Math.PI / 2;
    const sharedFold = this._flowerWingFoldAngle(shared);
    for (const fg of this._flowerGroups) {
      let th = shared;
      for (let i = 0; i < holds.length; i++) if (holds[i].az === fg.azDeg) { th = holds[i].thetaRad; break; }
      if (th === shared) {
        fg.hinge.rotation.y = sharedRotY;
        for (const wh of fg.wings) wh.rotation.x = sharedFold;
      } else {
        fg.hinge.rotation.y = th - Math.PI / 2;
        const fold = this._flowerWingFoldAngle(th);
        for (const wh of fg.wings) wh.rotation.x = fold;
      }
    }
    if (typeof this._updateTipStalks === 'function') this._updateTipStalks(shared);   // stalks follow θ, a held bag, the hand-off tip
  }

  /**
   * @private Merge plain BufferGeometries (position + normal only) into one non-indexed geometry, for inert structural
   * detail that must ship as ONE mesh (a merged mesh touches/floats as a single part in test-NothingFloats).
   */
  _mergePlainGeometries(geos) {
    const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return out;
  }

  /** @private */
  _buildSensors() {
    // The instruments sit in a symmetric RING (RING_R, azimuths below) around the fore-cap axis,
    // which the net launcher owns (one launcher, INSIDE the collar bore; _buildBerthCollar). The turret is FIXED (no
    // gimbal tracking), so the ring only has to clear the collar at rest: the barrels' inner half-extent
    // (0.26 − 0.10 = 0.16) meets the bore edge radially and sits ≥ 35 mm below the ring tube in z (test-MotherZFix;
    // test-SensorClearance measures the field cones themselves: 0 % blocked for EO / IR / telescope).
    const RING_R = M * 0.26;
    this._sensorRingR = RING_R;
    // Gimbal platform group: pivot on the CoM axis, at the fore cap (z = 1.0M).
    this.sensorGimbal = new THREE.Group();
    this.sensorGimbal.position.set(0, 0, M * 1.0);
    this.sensorGimbal.name = 'SensorGimbal';
    this.add(this.sensorGimbal);
    // Ring azimuths (deg) for EO / TELESCOPE / IR / LIDAR — a symmetric quad.
    const RING_AZ = { eo: 45, tele: 135, ir: 225, lidar: 315 };
    const ringXY = (azDeg) => new THREE.Vector2(
      Math.cos(degToRad(azDeg)) * RING_R,
      Math.sin(degToRad(azDeg)) * RING_R,
    );

    // Shared gunmetal, same recipe as the LIDAR dome.
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,
    });

    // EO Camera: shortened to 0.22M so it stays aft of the berth collar ring (z 1.30). Barrel axis +Z (fore).
    const eoXY = ringXY(RING_AZ.eo);
    const camGeo = new THREE.CylinderGeometry(M * 0.10, M * 0.10, M * 0.22, 64);
    const camLensMat = new THREE.MeshStandardMaterial({
      color: 0x111122, metalness: 0.7, roughness: 0.3,
    });
    const eoCam = new THREE.Mesh(camGeo, gunmetalMat);
    eoCam.rotation.x = Math.PI / 2;
    eoCam.position.set(eoXY.x, eoXY.y, M * 0.11);
    eoCam.name = 'EO_Camera';
    eoCam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(eoCam);

    // Lens: dark disc 1 mm proud of the front (+Z) face (bury-don't-touch). rotation.x +π/2 maps cylinder-local +Y →
    // gimbal +Z; the front face is at cylinder-local y = +0.11M.
    const eoLensGeo = new THREE.CircleGeometry(M * 0.07, 64);
    const eoLens = new THREE.Mesh(eoLensGeo, camLensMat);
    eoLens.position.set(0, M * 0.111, 0);
    eoLens.rotation.x = -Math.PI / 2;   // circle +Z normal → cylinder-local +Y (outward)
    eoLens.name = 'EO_Lens';
    eoLens.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    eoCam.add(eoLens);
    const eoBezelMat = new THREE.MeshStandardMaterial({
      color: 0xaabbcc, metalness: 0.85, roughness: 0.15,
    });
    const eoBezelGeo = new THREE.RingGeometry(M * 0.07, M * 0.095, 64);
    const eoBezel = new THREE.Mesh(eoBezelGeo, eoBezelMat);
    eoBezel.position.set(0, M * 0.1115, 0);   // distinct proud offset avoids a coplanar tie with the lens
    eoBezel.rotation.x = -Math.PI / 2;
    eoBezel.name = 'EO_Bezel';
    eoBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    eoCam.add(eoBezel);

    // IR Sensor: gold-foil box STANDING ON the turret top (z 1.055), footprint inside the rim (R 0.34) with >= 5 mm:
    // 0.165 radial (inner face on the bore edge, 0.16) x 0.133 tangential x 0.18 high (top 1.235, >= 35 mm under the ring
    // tube 1.28), centre radial 0.2425. owner: it must not look embedded in the turret.
    const IR_W = 0.165, IR_T = 0.133, IR_H = 0.18, IR_RC = 0.2425, IR_BOTTOM = 0.055;   // gimbal-local z of the turret top
    const irGeo = new THREE.BoxGeometry(M * IR_W, M * IR_T, M * IR_H);
    // Clone the gold MLI material with the `flat` foil variant: the barrel's full-amplitude tile on a tiny box face
    // would read as glitter. Roughness 0.6 x the flat map's G (0.50-0.80) = ~0.30-0.48 satin keeps the box from blowing
    // out white over the collar under bloom. Override ALL the maps so the repeat stays consistent.
    const irMat = this._matGoldMLI.clone();
    const irFoil = getMLIFoilMaps({ repeat: [1, 1], variant: 'flat' });
    irMat.roughness = 0.6;
    if (irFoil) {
      irMat.map = irFoil.albedoMap;
      irMat.normalMap = irFoil.normalMap;
      irMat.roughnessMap = irFoil.roughnessMap;
      irMat.metalnessMap = irFoil.metalnessMap;
      irMat.emissiveMap = irFoil.albedoMap;
      irMat.needsUpdate = true;
    }
    this._foilMats.push(irMat);                 // orbital envMap target
    const irSensor = new THREE.Mesh(irGeo, irMat);
    const irXY = ringXY(RING_AZ.ir);
    irSensor.position.set(irXY.x * (IR_RC * M / RING_R), irXY.y * (IR_RC * M / RING_R), M * (IR_BOTTOM + IR_H / 2));
    // Rotate the box to its ring azimuth so it sits square to the ring (unrotated, its inner corner reached inside the
    // collar bore, 0.16); rotated, the inner face is ON the bore edge. IR_Aperture is a child, so it rides along.
    irSensor.rotation.z = degToRad(RING_AZ.ir);
    irSensor.name = 'IR_Sensor';
    irSensor.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(irSensor);

    // IR aperture window: one dark facet so the foil box reads as an instrument (same recipe as the LIDAR lens), 1 mm
    // proud of the +Z face (local z=0.1M).
    const irWinGeo = new THREE.CircleGeometry(M * 0.05, 48);
    const irWinMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    const irWin = new THREE.Mesh(irWinGeo, irWinMat);
    irWin.position.set(0, 0, M * (IR_H / 2 + 0.001));   // CircleGeometry +Z normal already faces outward
    irWin.name = 'IR_Aperture';
    irWin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    irSensor.add(irWin);

    // LIDAR: small dome with pulsing green light, on a gunmetal drum (r 0.10, h 0.09, z 1.02–1.11: 2 cm clear of the
    // cap; the deck plane 1.03 and the turntable cross it transversally). The dome pole faces fore, its equator 1 cm
    // INSIDE the drum's top face: no coplanar tie, and the open base is buried in a closed solid (no see-through).
    const lidarMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,   // gunmetal: a light grey blooms to a white blob
    });
    const lidarXY = ringXY(RING_AZ.lidar);
    const lidarDrum = new THREE.Mesh(new THREE.CylinderGeometry(M * 0.10, M * 0.10, M * 0.09, 64), lidarMat);
    lidarDrum.rotation.x = Math.PI / 2;                       // cylinder +Y → +Z fore
    lidarDrum.position.set(lidarXY.x, lidarXY.y, M * 0.065);  // spans gimbal-local z 0.02 … 0.11
    lidarDrum.name = 'LIDAR_Drum';
    lidarDrum.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(lidarDrum);

    const lidarGeo = new THREE.SphereGeometry(M * 0.1, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    this.lidarDome = new THREE.Mesh(lidarGeo, lidarMat);
    this.lidarDome.position.set(lidarXY.x, lidarXY.y, M * 0.10);   // equator at z 1.10, apex 1.20
    this.lidarDome.rotation.x = Math.PI / 2;    // hemisphere pole (+Y) → +Z fore; dome-local +Z → world −Y
    this.lidarDome.name = 'LIDAR_Dome';
    this.lidarDome.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(this.lidarDome);

    // LIDAR aperture: dark lens facet on the dome's outboard face, 1 mm proud of the surface (bury-don't-touch: no
    // coincident curved-on-flat tie under log-depth).
    const lidarLensGeo = new THREE.CircleGeometry(M * 0.045, 48);
    const lidarLensMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    const lidarLens = new THREE.Mesh(lidarLensGeo, lidarLensMat);
    // Dome-local frame (equator at y=0, pole +Y = world +Z). Lens at 65° elevation toward dome-local +Z (= world −Y,
    // the belly side the fore-q-bot pose sees), clear of the apex and the equator (lens r 0.045).
    const lensEl = degToRad(65);
    lidarLens.position.set(0, Math.sin(lensEl) * M * 0.101, Math.cos(lensEl) * M * 0.101);
    lidarLens.lookAt(lidarLens.position.clone().multiplyScalar(2)); // face outward along the radial (before add: dome-local frame)
    lidarLens.name = 'LIDAR_Lens';
    lidarLens.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.lidarDome.add(lidarLens);

    const lidarLightGeo = new THREE.SphereGeometry(M * 0.04, 32, 16);
    this._lidarLightMat = new THREE.MeshBasicMaterial({
      color: 0x00ff44, transparent: true, opacity: 0.0,
    });
    this.lidarLight = new THREE.Mesh(lidarLightGeo, this._lidarLightMat);
    // Co-located with LIDAR_Lens, centre ON the dome surface (r 0.10) so half the r 0.04 pulse sphere protrudes: reads
    // as the emitter firing through the aperture. A dome child (a gimbal child would be enclosed by the opaque dome).
    this.lidarLight.position.set(0, Math.sin(lensEl) * M * 0.10, Math.cos(lensEl) * M * 0.10);
    this.lidarLight.name = 'LIDAR_Light';
    this.lidarLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    this.lidarDome.add(this.lidarLight);

    // Sensor base plate: FIXED deck, an ANNULUS around the collar bore (the axis is open above the solid turntable,
    // whose top carries the BerthFace plate inside the bore); the four ring instruments mount to its rim. Inner bore
    // r 0.15M (under the r 0.34 turntable); outer r 0.38M carries the RING_R=0.26M instrument circle with its outer
    // envelope and stays 2 cm inside the hull (0.40M). Fixed to the hull (only the instruments articulate).
    const deckInnerR = M * 0.15;
    const deckOuterR = M * 0.38;
    const basePlateGeo = new THREE.RingGeometry(deckInnerR, deckOuterR, 64);
    const basePlate = new THREE.Mesh(basePlateGeo, this._matDark);
    // RingGeometry (XY plane, +Z normal) already faces fore; placed just fore of the cap plane (z=1.0M).
    basePlate.position.set(0, 0, M * 1.03);
    basePlate.name = 'SensorDeck';
    basePlate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(basePlate);

    // Thin fixed skirt ring bridging the cap face (z=1.0M) to the deck's aft face.
    const skirtGeo = new THREE.CylinderGeometry(deckOuterR * 0.98, deckOuterR * 0.98, M * 0.03, 64, 1, true);
    const skirt = new THREE.Mesh(skirtGeo, this._matDark);
    skirt.rotation.x = Math.PI / 2;
    skirt.position.set(0, 0, M * 1.015);
    skirt.name = 'SensorDeckSkirt';
    skirt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(skirt);

    // Turntable: the SENSOR TURRET body the four ring instruments stand on. Solid gunmetal cylinder r 0.34, 3 cm thick,
    // gimbal-local z 0.025–0.055 (world 1.025–1.055): its underside is 5 mm behind the deck plane so the deck ring lies
    // INSIDE it (no slit, no tie); every instrument passes through it (the barrels r 0.09–0.10 at RING_R 0.26 cross the
    // rim transversally). r 0.34, not 0.35: the telescope's outer surface is at radial exactly 0.35, so a 0.35 rim would
    // be tangent to it along a line. The four BerthCollarStrut_* feet stand on its top face at radial 0.30 (5 mm buried,
    // under r 0.03 pads) and the BerthFace plate sits 5 mm proud of it inside the bore.
    const hubR = M * 0.34;
    const hubRing = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, M * 0.03, 64), gunmetalMat);
    hubRing.rotation.x = Math.PI / 2;       // cylinder +Y → +Z fore
    hubRing.position.set(0, 0, M * 0.04);   // gimbal-local z 0.025 … 0.055
    hubRing.name = 'SensorHubRing';         // name kept: callouts / tests pick it
    hubRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(hubRing);

    // Despin laser telescope in the RING_AZ.tele slot, co-boresighted with the EO camera (both gimbal children along
    // +Z, lines of sight parallel). Shortened (0.20M, r 0.09M) so its mouth stays AFT of the berth collar ring (z 1.30)
    // and the NetLauncherMuzzle plane (z 1.27): a reeled-in catch parks on the collar, never on the optics.
    const teleXY = ringXY(RING_AZ.tele);
    const teleR = M * 0.09;
    const teleLen = M * 0.20;
    const teleCenter = new THREE.Vector3(teleXY.x, teleXY.y, M * 0.10);
    const teleGeo = new THREE.CylinderGeometry(teleR, teleR, teleLen, 64);
    const telescope = new THREE.Mesh(teleGeo, gunmetalMat);
    telescope.rotation.x = Math.PI / 2;   // cylinder +Y → +Z
    telescope.position.copy(teleCenter);
    telescope.name = 'LaserTelescope';
    telescope.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(telescope);

    // Stray-light baffle: short TAPERED open ring seated on the tube mouth (fore, +Z). Its base radius matches teleR and
    // the shell overlaps the tube by ~5 mm, so it reads as a collar grown out of the barrel. Mouth stays aft of the
    // net-launcher muzzle (z 1.27): spans tube-local 0.095→0.145 → world z ≈ 1.195→1.245.
    const baffleGeo = new THREE.CylinderGeometry(M * 0.10, M * 0.09, M * 0.05, 64, 1, true);
    const baffleMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide,
    });
    const baffle = new THREE.Mesh(baffleGeo, baffleMat);
    // Coaxial with the tube: the tube mesh is already rotated (axis → world +Z), so a child keeps tube-local +Y as the
    // axis with NO extra rotation.
    baffle.position.set(0, teleLen * 0.5 + M * 0.020, 0);
    baffle.name = 'LaserBaffle';
    baffle.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    telescope.add(baffle);

    // Recessed primary mirror: dark optic disc ~2 cm INSIDE the tube mouth, faint blue emissive; tube-local +Y is fore.
    // r 0.0895 leaves a uniform ~0.5 mm rim gap to the tube's inner wall (a smaller disc floated in the bore: a
    // KNOWN_FLOATER); its rim vertices share azimuths with the tube's, so the rim never pierces the wall.
    const primaryGeo = new THREE.CircleGeometry(M * 0.0895, 64);
    const primaryMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
      emissive: 0x1133aa, emissiveIntensity: 0.25,
    });
    const primary = new THREE.Mesh(primaryGeo, primaryMat);
    primary.position.set(0, teleLen * 0.5 - M * 0.02, 0);
    primary.rotation.x = Math.PI / 2;   // circle +Z normal → tube-local +Y (fore)
    primary.name = 'LaserPrimary';
    primary.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    telescope.add(primary);

    // Secondary-obstruction dot — dark disc, 1 mm proud of the primary.
    const secondaryGeo = new THREE.CircleGeometry(M * 0.025, 48);
    const secondaryMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    const secondary = new THREE.Mesh(secondaryGeo, secondaryMat);
    secondary.position.set(0, teleLen * 0.5 - M * 0.019, 0);
    secondary.rotation.x = Math.PI / 2;
    secondary.name = 'LaserSecondary';
    secondary.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    telescope.add(secondary);

    // Secondary spider: three vanes reaching the tube wall, ONE merged mesh (hub + 3 vanes, ≤ 3 mm thick) in the
    // secondary's plane, a child of the telescope so it rides the gimbal. The hub stands 0.3 mm proud of the vane faces
    // and the vanes start inside it, so no two faces are coplanar (log-depth: coincident faces z-fight). Vane tips at
    // r 0.0885 sit 0.04–1.5 mm off the wall (measured when the tube was a 16-gon) without piercing it.
    const spiderHubGeo = new THREE.CylinderGeometry(M * 0.008, M * 0.008, M * 0.0036, 24);
    spiderHubGeo.translate(0, teleLen * 0.5 - M * 0.019, 0);
    const spiderParts = [spiderHubGeo];
    const SPIDER_TIP_R = 0.0885, SPIDER_IN_R = 0.002;
    for (let k = 0; k < 3; k++) {
      const vaneGeo = new THREE.BoxGeometry((SPIDER_TIP_R - SPIDER_IN_R) * M, M * 0.003, M * 0.0025);
      const az = k * 2 * Math.PI / 3 + Math.PI / 6;
      vaneGeo.rotateY(az);
      vaneGeo.translate(Math.cos(az) * (SPIDER_TIP_R + SPIDER_IN_R) / 2 * M, teleLen * 0.5 - M * 0.019, -Math.sin(az) * (SPIDER_TIP_R + SPIDER_IN_R) / 2 * M);
      spiderParts.push(vaneGeo);
    }
    const spiderGeo = this._mergePlainGeometries(spiderParts);
    const spider = new THREE.Mesh(spiderGeo, gunmetalMat);
    spider.name = 'LaserSpider';
    spider.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    telescope.add(spider);

    // Muzzle anchor: gimbal-local at the telescope mouth; the DespinLaser beam origin via getLaserAperturePosition().
    this._laserMuzzle = new THREE.Object3D();
    this._laserMuzzle.position.set(teleXY.x, teleXY.y, M * 0.10 + teleLen * 0.5);
    this._laserMuzzle.name = 'LaserMuzzle';
    this.sensorGimbal.add(this._laserMuzzle);
  }

  /**
   * @private Build the Large Net launcher: ONE gunmetal cylinder on the long axis (x = y = 0), inside the collar bore,
   * firing through it. It is the hardware for the whale-class capture net's 4-net magazine
   * (CaptureNetSystem._motherPodInventory): r 0.12 (NET_LAUNCHER_R_M), base z 1.050 (5 mm buried in the turntable top at
   * 1.055, passing through the 5 mm berth plate z 1.055–1.060, so it never shares a plane with either), front face at
   * z 1.27 (NET_LAUNCHER_MUZZLE_Z_M), 10 mm behind the collar ring. The front face is the magazine window: one round
   * cell per net, drawn by _buildNetCells from netCellLayout (4 at the start line-fibre tier, 6 / 8 / 10 after the
   * upgrade), each a dark open bore with a pale Dyneema cap shown while that net is loaded (cap i shows while
   * i < count). The muzzle anchor is the launch point used by fireMotherNet (via getNetPodPosition).
   *
   * Clearances (measured, ~1.5 mm): ring tube 47.1 mm, optics (IR / EO / LIDAR / LaserBaffle) 40.0 mm, collar struts
   * 54.8 mm, fore sun pucks 57.8 mm. Straight along the nose from the muzzle the corridor is clear to radius 0.155
   * (the sun pucks set it).
   *
   * The muzzle is on the centre-of-mass axis, so a shot has no lever arm: `_applyMotherNetRecoil` gives zero yaw and
   * pitch, and no N₂ is billed to stop a turn. A catch held at the collar sits on the axis and so fouls every shot
   * (getCollarShotFoul keeps refusing it: that is the physics, not a regression).
   */
  _buildNetPods() {
    const V5 = Constants.OCTOPUS_V5;
    // Gunmetal housing, same recipe as the LIDAR dome.
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,
    });
    // Cell bore (dark recessed): same recipe as LIDAR_Lens / IR_Aperture.
    const cellHoleMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    // Loaded-net cap — pale Dyneema face, visible only while that net is loaded.
    const cellCapMat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d0, metalness: 0.1, roughness: 0.7,
    });

    // Index 0 is the one launcher; the arrays keep the podIndex API (always 0).
    this._netPodMuzzles = [];
    this._netPodCaps = [];

    const R = (V5?.NET_LAUNCHER_R_M ?? 0.12) * M;
    const muzzleZ = (V5?.NET_LAUNCHER_MUZZLE_Z_M ?? 1.27) * M;     // front face = muzzle plane
    const baseZ = (V5?.NET_LAUNCHER_BASE_Z_M ?? 1.050) * M;        // 5 mm into the turntable
    const LAUNCH_LEN = muzzleZ - baseZ;
    const launchCz = (muzzleZ + baseZ) * 0.5;
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(R, R, LAUNCH_LEN, 64), gunmetalMat);
    housing.rotation.x = Math.PI / 2;                              // cylinder +Y → ship +Z (fore)
    housing.position.set(0, 0, launchCz);
    housing.name = 'NetLauncher';
    housing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(housing);

    // The magazine window on the front face (one cell per net). Housing frame (rotation.x = π/2): local X → ship X,
    // local Z → ship −Y, local Y → ship +Z (the proud offset); front face at local y = +LAUNCH_LEN / 2.
    const faceLocalY = LAUNCH_LEN * 0.5;
    const CELL_D = M * 0.05;      // cell centre offset on each axis (cells at (±0.05, ±0.05))
    const caps = [];

    // owner: the launcher front needs a raised or inset white disc (3D, matching the sim and the scale model).
    // A white disc on the front face (3 mm proud, 2 mm buried; r 0.105) framed by a gunmetal lip ring (r 0.107-0.120,
    // 4 mm above the disc = 7 mm above the face, 3 mm behind the ring tube plane 1.28) so the white reads inset. The
    // cell holes, rims and loaded-state caps are lifted by the disc thickness and sit ON the disc.
    const DISC_TOP = M * 0.003;
    const discMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, metalness: 0.0, roughness: 0.8 });   // cap white, matte
    const disc = new THREE.Mesh(new THREE.LatheGeometry([                // top + side only (the buried underside is never seen)
      new THREE.Vector2(M * 0.105, -M * 0.002), new THREE.Vector2(M * 0.105, M * 0.003), new THREE.Vector2(0, M * 0.003),
    ], 64), discMat);
    disc.position.set(0, faceLocalY, 0);                              // spans -2 mm .. +3 mm about the face
    disc.name = 'NetLauncherDisc';
    disc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    housing.add(disc);
    const lipGeo = new THREE.LatheGeometry([
      new THREE.Vector2(M * 0.120, -M * 0.002), new THREE.Vector2(M * 0.120, M * 0.007),
      new THREE.Vector2(M * 0.107, M * 0.007), new THREE.Vector2(M * 0.107, -M * 0.002),
    ], 64);   // r 0.12 >= 0.10 -> 64 around (test-RoundParts radius rule)
    const lip = new THREE.Mesh(lipGeo, gunmetalMat);
    lip.position.set(0, faceLocalY, 0);
    lip.name = 'NetLauncherLip';
    lip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    housing.add(lip);
    // DECISIONS §33 row 5: cells are drawn by _buildNetCells(n), redrawn on the fibre upgrade by setNetCellCount.
    this._netPodHousing = housing;
    this._netPodMats = { hole: cellHoleMat, cap: cellCapMat, rim: gunmetalMat };
    this._netPodCellBaseY = faceLocalY + DISC_TOP;                    // the cells sit on the disc top
    this._netPodCells = [];
    this._buildNetCells(Constants.TETHER_TIERS[0].nets.mother);

    // Muzzle anchor: invisible, at the front-face centre, a child of the ship frame (NOT the rotated housing); x = y = 0
    // on the centre-of-mass axis, so the launch recoil has no lever arm.
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, muzzleZ);
    muzzle.name = 'NetLauncherMuzzle';
    this.add(muzzle);
    this._netPodMuzzles.push(muzzle);

    // Mirror the pale caps to the live magazine. Session singleton: fire-and-forget eventBus.on like the constructor
    // listeners (no teardown). Filters to mother-source emits carrying a podInventory array; the payload is a
    // one-element array, summed so a legacy two-element payload still lights the right number of caps.
    this._onNetInventoryChanged = (p) => {
      if (!p || p.source !== 'mother' || !Array.isArray(p.podInventory)) return;
      let n = 0;
      for (const v of p.podInventory) n += (v || 0);
      const launcherCaps = this._netPodCaps?.[0] || [];
      launcherCaps.forEach((cap, i) => { cap.visible = i < n; });
    };
    eventBus.on(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);
  }

  /**
   * @private Draw the launcher face's `n` cells: per cell a dark bore (hole), a low gunmetal rim and a pale cap shown
   * while that net is loaded. Positions and size come from netCellLayout(n, disc radius 0.105, 1.5 mm gap): the largest
   * round cell that fits the white disc. Cell outer = the rim's outer edge; hole = outer - 3.5 mm; cap = hole - 2 mm.
   * Names are NetLauncherCellHole_i / Rim_i / Cap_i. Behind the face the cartridges are sectors filling the housing
   * (not drawn; test-NetTiers sizes them).
   */
  _buildNetCells(n) {
    const housing = this._netPodHousing;
    const { hole: cellHoleMat, cap: cellCapMat, rim: rimMat } = this._netPodMats;
    const baseY = this._netPodCellBaseY;
    const cells = netCellLayout(n, 0.105, 0.0015);
    const outer = cells.length ? cells[0].r : 0.03;
    const holeR = outer - 0.0035;
    const capR = holeR - 0.002;
    const holeGeo = new THREE.CircleGeometry(M * holeR, 48);
    const capGeo = new THREE.CircleGeometry(M * capR, 48);
    const rimGeo = new THREE.LatheGeometry([
      new THREE.Vector2(M * outer, -M * 0.002), new THREE.Vector2(M * outer, M * 0.004),
      new THREE.Vector2(M * holeR, M * 0.004),
    ], 48);
    this._netPodCellGeos = [holeGeo, capGeo, rimGeo];
    const caps = [];
    const made = [];
    cells.forEach((cell, c) => {
      // face (x, y) -> housing local: local X = ship X, local Z = ship -Y
      const lx = M * cell.x;
      const lz = -M * cell.y;
      const hole = new THREE.Mesh(holeGeo, cellHoleMat);
      hole.position.set(lx, baseY + M * 0.001, lz);               // 1 mm proud of the white disc
      hole.rotation.x = -Math.PI / 2;
      hole.name = `NetLauncherCellHole_${c}`;
      hole.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      housing.add(hole);

      // Low gunmetal rim round each cell (4 mm proud, 2 mm buried); geometry shared.
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.set(lx, baseY, lz);
      rim.name = `NetLauncherCellRim_${c}`;
      rim.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      housing.add(rim);

      const cap = new THREE.Mesh(capGeo, cellCapMat);
      cap.position.set(lx, baseY + M * 0.0015, lz);               // distinct offset - no coplanar tie
      cap.rotation.x = -Math.PI / 2;
      cap.name = `NetLauncherCellCap_${c}`;
      cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      cap.visible = true;                      // default full; init() emit syncs
      housing.add(cap);
      caps.push(cap);
      made.push(hole, rim, cap);
    });
    this._netPodCells = made;
    this._netPodCaps[0] = caps;
  }

  /**
   * Redraw the launcher face for `n` cartridges (line-fibre upgrade: 4 / 6 / 8 / 10): disposes the old cell geometries
   * (shared materials stay), builds `n`, re-lights the caps from the live count (the mother's net system when wired,
   * else all lit). Called by ArmManager.applyTetherUpgrade.
   */
  setNetCellCount(n) {
    if (!this._netPodHousing) return;
    const want = Math.max(1, Math.floor(n) || 0);
    if (this._netPodCells && this._netPodCells.length === want * 3) return;
    for (const m of this._netPodCells || []) this._netPodHousing.remove(m);
    for (const g of this._netPodCellGeos || []) g.dispose();
    this._buildNetCells(want);
    const cns = this._captureNetSystem;
    if (cns && typeof cns.getMotherNetCount === 'function') {
      const live = cns.getMotherNetCount();
      this._netPodCaps[0].forEach((cap, i) => { cap.visible = i < live; });
    }
  }

  // No fore docking port: nothing docks with the mother (the arms capture and berth). The nose carries the net launcher
  // (_buildNetPods) and the berthing collar (_buildBerthCollar), where whale-class cargo mates rigidly, on-axis.

  /**
   * @private Build the nose berthing collar, dead on the long axis at the muzzle plane (z = 1.30 M). A SKELETON collar
   * (owner 2026-09-08: sensors need visual clearance to see; research ultralight skeleton docking): a thin capture ring
   * (bore 0.16 kept, tube r 0.020 → R 0.180) on four inclined struts whose feet stand on the sensor turntable, a dark
   * berth plate on the turntable top inside the bore, steady lamps on the ±X struts. The solid collar it replaced stood
   * 2–6 cm in front of the four ring optics (RING_R 0.26) and blocked 100 / 100 / 100 / 80 % of the EO / IR / telescope
   * / LIDAR field cones and 58 % of the fore sun sensors' sky (js/test/test-SensorClearance.js is the acceptance test).
   * Real capture craft do the same (IDSS soft-capture ring on struts, ClearSpace's open cage): thin members, sensors
   * see through. ONE net launcher stands inside this bore (behind the ring, z 1.27); every shot passes through the ring.
   * The collar's seat rule lives in the berth hold (CaptureNet.updateBerthHold): cargo surface AT the ring plane + the
   * 1.0 m clearance (collar anchor + fwd × (sizeMeter/2 + BERTH_CLEARANCE_M)). The ring is a tether-hold SEAT, never a
   * contact surface, so a berthed catch blinds the +Z optics whatever the collar looks like (ELSA-d precedent); this
   * geometry is about the approach / shot, when the optics work. Also builds `_netBerthCollar`, the invisible
   * berth-anchor Object3D (getNetBerthCollarPositionInto), frozen at (0, 0, 1.30).
   *
   * Contact rules (logarithmicDepthBuffer, no polygonOffset: bury ≥ 4–5 mm or stand ≥ 1 mm proud, never coplanar):
   * strut heads buried WHOLE inside the ring tube (head centre 5 mm off the tube centreline, end-disc rim 0.019 < tube
   * 0.020, no tangency); feet 5 mm into the turntable top; foot pads 5 mm into it, 7 mm proud; berth plate 5 mm proud
   * of it; lamps 8 mm into the strut skin. Nothing else touches the ring: the nearest other part is the LaserBaffle
   * rim, 35.6 mm off the tube.
   */
  _buildBerthCollar() {
    const V5 = Constants.OCTOPUS_V5;
    const zM = V5.BERTH_COLLAR_Z_M ?? 1.30;
    const rIn = V5.BERTH_COLLAR_INNER_R_M ?? 0.16;
    const tube = V5.BERTH_COLLAR_TUBE_R_M ?? 0.020;
    const footR = V5.BERTH_COLLAR_STRUT_FOOT_R_M ?? 0.30;

    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,
    });

    // The capture ring: a thin torus whose bore axis is the long axis (TorusGeometry already lies in XY about +Z).
    // Bore radius preserved (rIn 0.16, the "0.32 m bore"), so the tube centreline is at R = rIn + tube = 0.180, annulus
    // 0.160–0.200, z 1.280–1.320. owner 2026-09-08: tube 40 mm; the LIDAR ±45° sweep loses 10 % to the ring's outer edge,
    // all in its 30–45° band, 0 % inside ±30° (inherent to any ring at the bore with the dome at radial 0.26).
    // Name kept: BerthCollarRing is API (callout mesh, blueprint CARGO mesh, harness truth, test pins); origin = bore
    // centre at the seat plane.
    const ringR = rIn + tube;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(ringR * M, tube * M, 16, 64), gunmetalMat);
    ring.position.set(0, 0, zM * M);
    ring.name = 'BerthCollarRing';
    ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(ring);

    // The DEBRIS CAPTURE ring (net-tether tension holds the junk against it; not a docking port: no petals, hooks,
    // latch blocks or guide pins): a flat flange face on its fore side plus a 24-bolt circle. The flange washer
    // R 0.1685..0.1915 stays inside the tube's own silhouette (the sensor shadow does not grow); its face is 0.5 mm over
    // the tube top and its wall sunk inside the tube. Bolt heads: 24 twelve-gons on the tube-centreline circle, 4.5 mm
    // tall, 1.5 mm sunk into the flange, one merged mesh; the two at az 90 / 270 hide inside the fore sun-sensor pucks
    // (nothing rises above z 1.3235).
    const flangeGeo = new THREE.LatheGeometry([
      new THREE.Vector2((ringR - 0.0115) * M, 1.312 * M), new THREE.Vector2((ringR - 0.0115) * M, 1.3205 * M),
      new THREE.Vector2((ringR + 0.0115) * M, 1.3205 * M), new THREE.Vector2((ringR + 0.0115) * M, 1.312 * M),
    ], 64);
    flangeGeo.rotateX(Math.PI / 2);   // lathe axis +Y -> +Z (the ring's axis); positions already carry z
    const flange = new THREE.Mesh(flangeGeo, gunmetalMat);
    flange.name = 'BerthCollarFlange';
    flange.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(flange);
    const boltParts = [];
    for (let k = 0; k < 24; k++) {
      const a = k * Math.PI / 12;
      const h = new THREE.CylinderGeometry(0.0035 * M, 0.0035 * M, 0.0045 * M, 12);
      h.setIndex(Array.from(h.index.array.slice(0, h.groups[2].start)));   // the sunk end is never seen: drop its cap
      h.rotateX(Math.PI / 2);
      h.translate(ringR * Math.cos(a) * M, ringR * Math.sin(a) * M, 1.32125 * M);
      boltParts.push(h);
    }
    const bolts = new THREE.Mesh(PlayerSatellite._mergeParts(boltParts), gunmetalMat);
    bolts.name = 'BerthCollarFlangeBolts';
    bolts.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(bolts);

    // Four inclined struts at az 0 / 90 / 180 / 270 carry the ring: foot on the sensor turntable top (SensorHubRing,
    // top z 1.055) at radial 0.30, z 1.050 (5 mm buried); head 5 mm off the tube centreline toward the lower-outboard
    // quadrant, so the whole r 0.014 end disc lies ≥ 1 mm inside the r 0.020 tube (rim 0.019): no surface tie, no stub
    // inside the bore. The 25.3° lean is load-bearing for the LOOK: a vertical post under the tube projected INTO the
    // bore from a close fore-on view and read as a spoke piercing the tube; with the feet at radial 0.30 the struts
    // stay outside the ring's apparent radius down to 1.8 m. Do not straighten.
    // Clearances (measured, test-SensorClearance "strut capsules"): launcher housing 54.8 mm, every ring instrument
    // ≥ 60 mm, fore sun pucks 5.9 mm.
    const strutR = 0.014;
    const footZ = 1.050;
    const headOff = 0.005;
    const headR = ringR + headOff * Math.SQRT1_2, headZ = zM - headOff * Math.SQRT1_2;
    const yUpV = new THREE.Vector3(0, 1, 0);
    // Strut direction in the (radial, z) plane and its outward normal (the lamps sit on the ±X struts' outboard skins).
    const strutDir = new THREE.Vector2(headR - footR, headZ - footZ).normalize();
    const strutOutN = new THREE.Vector2(strutDir.y, -strutDir.x);
    [0, 90, 180, 270].forEach((azDeg, i) => {
      const a = degToRad(azDeg), cx = Math.cos(a), cy = Math.sin(a);
      const A = new THREE.Vector3(footR * cx, footR * cy, footZ).multiplyScalar(M);
      const B = new THREE.Vector3(headR * cx, headR * cy, headZ).multiplyScalar(M);
      const strut = new THREE.Mesh(
        new THREE.CylinderGeometry(strutR * M, strutR * M, A.distanceTo(B), 24, 1, false), gunmetalMat);
      strut.position.copy(A).add(B).multiplyScalar(0.5);
      strut.quaternion.setFromUnitVectors(yUpV, B.clone().sub(A).normalize());
      strut.name = `BerthCollarStrut_${i}`;
      strut.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(strut);
      // Foot pad: r 0.03 × 12 mm disc centred at z 1.056 (spans 1.050–1.062: 5 mm into the turntable top, 7 mm proud);
      // bare feet did not read. All four stay on the turntable: the pad rim is at radial 0.330, the struts lean inboard.
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * M, 0.03 * M, 0.012 * M, 48), gunmetalMat);
      pad.rotation.x = Math.PI / 2;               // cylinder +Y → +Z fore
      pad.position.set(footR * cx * M, footR * cy * M, 1.056 * M);
      pad.name = `BerthCollarFoot_${i}`;
      pad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(pad);
    });

    // Berth plate: the dark disc seen through the ring bore, ON the turntable top. A real 5 mm plate (bottom on the
    // turntable top z 1.055, top face z 1.060), not a hovering disc (a KNOWN_FLOATER). Its bottom cap faces aft and the
    // turntable's top cap faces fore, so the coplanar rest is opposite-facing: backface culling never rasterises both
    // (no z-fight). r 0.13 < bore 0.16. Name kept (BerthFace): the DOCKING COLLAR pick list names it.
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13 * M, 0.13 * M, 0.005 * M, 64),
      new THREE.MeshStandardMaterial({ color: 0x0a0a12, metalness: 0.4, roughness: 0.15 }));
    face.rotation.x = Math.PI / 2;             // cylinder +Y → +Z (top cap faces fore)
    face.position.set(0, 0, 1.0575 * M);       // spans z 1.055–1.060
    face.name = 'BerthFace';
    face.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(face);

    // Panel lamps (steady work lights): green on +X (approach-clear), red on −X, on the ±X struts' outboard skins at
    // z 1.26: 18 mm off the strut axis along the outward normal, so the r 0.012 sphere is buried 8 mm in the r 0.014
    // strut and stands 16 mm proud.
    const lampGeo = new THREE.SphereGeometry(0.012 * M, 24, 12);
    const lampAt = (sign) => {
      const t = (1.26 - footZ) / (headZ - footZ);
      const axisR = footR + t * (headR - footR);                 // strut axis radial at z 1.26
      return new THREE.Vector3(sign * (axisR + 0.018 * strutOutN.x) * M, 0, (1.26 + 0.018 * strutOutN.y) * M);
    };
    const lampGreen = new THREE.Mesh(lampGeo, new THREE.MeshStandardMaterial({
      color: 0x0a3016, emissive: 0x2aff66, emissiveIntensity: 0.9,
    }));
    lampGreen.position.copy(lampAt(1));
    lampGreen.name = 'BerthCollarLamp_G';
    lampGreen.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(lampGreen);
    const lampRed = new THREE.Mesh(lampGeo, new THREE.MeshStandardMaterial({
      color: 0x300a0a, emissive: 0xff4433, emissiveIntensity: 0.9,
    }));
    lampRed.position.copy(lampAt(-1));
    lampRed.name = 'BerthCollarLamp_R';
    lampRed.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(lampRed);
    // A short gunmetal housing round each lens: a cup on the strut's outboard normal, 14.5 mm radius, from 5 mm off the
    // strut axis (inside the strut) to 26 mm (lens centre at 18 mm: lens 4 mm proud of the rim).
    const lampHousingGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0.0145 * M, -0.013 * M), new THREE.Vector2(0.0145 * M, 0.008 * M), new THREE.Vector2(0.0125 * M, 0.008 * M),
    ], 32);
    [[lampGreen, 'G'], [lampRed, 'R']].forEach(([lamp, tag]) => {
      const hsg = new THREE.Mesh(lampHousingGeo, gunmetalMat);
      hsg.position.copy(lamp.position);
      const sign = Math.sign(lamp.position.x);
      hsg.quaternion.setFromUnitVectors(yUpV, new THREE.Vector3(sign * strutOutN.x, 0, strutOutN.y));
      hsg.name = `BerthCollarLampHousing_${tag}`;
      hsg.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(hsg);
    });

    // Berth anchor: invisible Object3D at the collar seat plane centre, ON the axis; the reel/berth pin math homes
    // here so a reeled catch mates ON the axis. The muzzle is 30 mm behind this plane, the seat is not.
    this._netBerthCollar = new THREE.Object3D();
    this._netBerthCollar.position.set(0, 0, zM * M);
    this._netBerthCollar.name = 'NetBerthCollar';
    this.add(this._netBerthCollar);
  }

  /**
   * World position of the Large Net launcher's muzzle, the launch point for fireMotherNet. ONE launcher, on the axis at
   * (0, 0, 1.27); any index returns it, and the ship origin if it wasn't built.
   * @param {number} [podIndex] always 0 (kept for the podIndex API)
   * @returns {THREE.Vector3} world-space muzzle position
   */
  getNetPodPosition(podIndex) {
    return this.getNetPodPositionInto(podIndex, new THREE.Vector3());
  }

  /**
   * Allocation-free getNetPodPosition for per-frame callers (the net-fire lead-aim provider). Fallback: muzzle
   * [podIndex] → muzzle [0] → ship origin.
   * @param {number} [podIndex] always 0 (kept for the podIndex API)
   * @param {THREE.Vector3} out — receives the world-space muzzle position
   * @returns {THREE.Vector3} out (for chaining)
   */
  getNetPodPositionInto(podIndex, out) {
    const m = this._netPodMuzzles?.[podIndex] ?? this._netPodMuzzles?.[0];
    if (m) m.getWorldPosition(out); else this.getWorldPosition(out);
    return out;
  }

  /**
   * World position of the berth anchor: the collar seat plane centre, ON the long axis. The reel/berth pin math homes
   * HERE; the launch origin stays at the launcher muzzle (30 mm behind it). Fallback: collar anchor → launcher muzzle →
   * ship origin (headless mocks without the anchor).
   * @param {THREE.Vector3} out — receives the world-space berth-anchor position
   * @returns {THREE.Vector3} out (for chaining)
   */
  getNetBerthCollarPositionInto(out) {
    if (this._netBerthCollar) this._netBerthCollar.getWorldPosition(out);
    else if (this._netPodMuzzles?.[0]) this._netPodMuzzles[0].getWorldPosition(out);
    else this.getWorldPosition(out);
    return out;
  }

  /**
   * World position of the despin-laser telescope muzzle (gimbal-mounted, so it tracks sensor articulation): the
   * DespinLaser BEAM VISUAL origin. Falls back to the hull origin when the muzzle anchor is missing (headless builds).
   */
  getLaserAperturePosition() {
    const pos = new THREE.Vector3();
    if (this._laserMuzzle) this._laserMuzzle.getWorldPosition(pos); else this.getWorldPosition(pos);
    return pos;
  }

  /**
   * @private Thin delegate to the shared `makeLightHalo` factory (scene/glowSpriteTexture.js): Mother and daughters build
   * halos from one SSOT. A co-located additive radial-gradient sprite gives real spill (bare emissive spheres read as
   * flat painted dots). Gameplay only. Bloom threshold is 2.5, so coloured halos glow additively without blooming; only
   * near-white strobe peaks (×hdrMul) cross 2.5 to bloom in the HalfFloat target, keeping the hull clean.
   */
  _makeLightHalo(colorHex, scaleM, hdrMul = 1.6, opacity = 0.0) {
    return makeLightHalo(colorHex, scaleM, hdrMul, opacity);
  }

  /** @private */
  _buildNavLights() {
    const LFX = Constants.LIGHT_FX;
    const navGeo = new THREE.SphereGeometry(M * LFX.NAV_CORE_R, 32, 16);
    const HALO = M * LFX.NAV_HALO;

    // Site: fore shoulder band at z 0.76, bare MLI between the PV end rows' top (z 0.72) and the avionics (z ≥ 0.79; the
    // GPS patches at az 340 start at z 0.835, above the 0.14 m halo sprite's top edge 0.83). Radial 0.412: core r 0.025
    // buried 13 mm, centre 12 mm proud (never coincident with the skin); ADDITIVE renderOrder so the cores sort with the
    // other light hardware. Not on the ±X equator: the ROSA drum's sun-track sweep (axis on the spool line,
    // rosaSpoolAxisM(), through the YZ plane at every sun angle) and the furled coil would swallow it. Azimuth ∓24°
    // (starboard 336°, port 204°) clears the fully furled stow roll: 0.197 from the axis, x_max 0.401 < 0.43 (the drum
    // sweep's inboard face). test-MotherZFix computes the gate from rosaFurledCoilRadiusM() / rosaSpoolAxisM().
    const navR = 0.412 * M, navAz = degToRad(24), navZ = 0.76 * M;
    const navX = navR * Math.cos(navAz), navY = -navR * Math.sin(navAz);

    // Port (left), red
    this._portLightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    this.portLight = new THREE.Mesh(navGeo, this._portLightMat);
    this.portLight.position.set(-navX, navY, navZ);            // az 204°
    this.portLight.name = 'NavLight_Port';
    this.portLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    this.add(this.portLight);
    // Port/starboard are STEADY (running lights) — a constant modest halo.
    this.portLight.add(this._makeLightHalo(0xff0000, HALO, 1.6, LFX.NAV_HALO_OPACITY));

    // Starboard (right), green
    this._starboardLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.starboardLight = new THREE.Mesh(navGeo, this._starboardLightMat);
    this.starboardLight.position.set(navX, navY, navZ);        // az 336°
    this.starboardLight.name = 'NavLight_Starboard';
    this.starboardLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    this.add(this.starboardLight);
    this.starboardLight.add(this._makeLightHalo(0x00ff00, HALO, 1.6, LFX.NAV_HALO_OPACITY));

    // A gunmetal cup round each light core (same centre, axis = the hull normal there): wall r 32.5 mm, 10 mm above the
    // core centre, floor 12 mm below it; the core (r 25 mm) stands 15 mm above the rim. DETAIL order (cores stay ADDITIVE).
    const navHousingGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0.0325 * M, -0.020 * M), new THREE.Vector2(0.0325 * M, 0.010 * M),
      new THREE.Vector2(0.0275 * M, 0.010 * M), new THREE.Vector2(0.0275 * M, -0.014 * M),
    ], 48);   // no floor: the MLI skin (12 mm below the core centre) closes the cup
    const navHousingMat = new THREE.MeshStandardMaterial({ color: 0x55585f, metalness: 0.5, roughness: 0.55, side: THREE.DoubleSide });
    [[this.portLight, 'Port'], [this.starboardLight, 'Starboard']].forEach(([core, tag]) => {
      const hsg = new THREE.Mesh(navHousingGeo, navHousingMat);
      hsg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(core.position.x, core.position.y, 0).normalize());
      hsg.name = `NavHousing_${tag}`;   // a CHILD of the core (the core has no rotation): the callout pick owns it with the light
      hsg.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      core.add(hsg);
    });
  }

  /**
   * @private Body-mounted (NOT gimbal) attitude/navigation/comms hardware, all DETAIL renderOrder with
   * buried-don't-touch standoffs (no coplanar ties). Mounted only in the usable bare-MLI zones (fore/aft shoulder bands
   * + the fore-shoulder azimuth wedges between keep-outs), never on PV cells. Not in the _detailMeshes cull allowlist
   * (they read at inspect range).
   */
  _buildAvionics() {
    const barrelR = M * 0.40;
    const barrelHZ = M * 1.0;   // fore cap plane (half of the 2.0M barrel)
    const gunmetal = new THREE.MeshStandardMaterial({ ...AVIONICS_GUNMETAL });
    const darkOptic = new THREE.MeshStandardMaterial({ ...AVIONICS_DARK_OPTIC });
    const thermalWhite = new THREE.MeshStandardMaterial({ ...AVIONICS_THERMAL_WHITE });
    const yUp = new THREE.Vector3(0, 1, 0);
    const zFwd = new THREE.Vector3(0, 0, 1);
    const radialAt = (azDeg) => new THREE.Vector3(Math.cos(azDeg * DEG2RAD), Math.sin(azDeg * DEG2RAD), 0);

    // Star trackers ×2: open baffle tubes with a dark optic recessed ~1 cm behind the mouth. Fore shoulder band az
    // 82°/98°, z 0.90; boresights canted 30° off +Z toward up-outward. The pair spacing is load-bearing: 84°/96° put the
    // tube axes 83.6 mm apart at the skin, inside the 100 mm sum of radii, so the tubes fused; a base-end overlap
    // survives any cant, only separation fixes it. 82°/98° measures 111.3 mm at the base / 130.8 mm at the mouth.
    const stR = M * 0.05;
    const stLen = M * 0.14;
    // The mouth is OPEN (the optic must show), so the bore's inner wall and back cap render from inside: one
    // DoubleSide gunmetal serves the tube, the back cap and the mount wedge.
    const stGunmetal = new THREE.MeshStandardMaterial({ ...AVIONICS_GUNMETAL, side: THREE.DoubleSide });
    [82, 98].forEach((azDeg, i) => {
      const radial = radialAt(azDeg);
      const boresight = zFwd.clone().multiplyScalar(Math.cos(30 * DEG2RAD))
        .addScaledVector(radial, Math.sin(30 * DEG2RAD)).normalize();
      const base = radial.clone().multiplyScalar(barrelR).setZ(barrelHZ * 0.90);
      const tubeGeo = new THREE.CylinderGeometry(stR, stR, stLen, 48, 1, true);   // open baffle
      const tube = new THREE.Mesh(tubeGeo, stGunmetal);
      tube.quaternion.setFromUnitVectors(yUp, boresight);   // tube axis (+Y) → boresight
      tube.position.copy(base).addScaledVector(boresight, stLen * 0.5);
      tube.name = `StarTracker_${i}`;
      tube.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(tube);
      // Back cap closes the base end so the baffle interior reads dark from every angle (the mount wedge passes
      // through it); DoubleSide shows it from the mouth.
      const backCap = new THREE.Mesh(new THREE.CircleGeometry(stR, 48), stGunmetal);
      backCap.position.set(0, -stLen * 0.5, 0);
      backCap.rotation.x = Math.PI / 2;   // circle plane → tube-local XZ (base end)
      backCap.name = `StarTracker_${i}_BackCap`;
      backCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      tube.add(backCap);
      // Recessed optic ~1 cm inside the mouth (tube-local +Y), spanning the bore: r 0.049 vs the 0.0483–0.05 wall puts
      // the rim ~1 mm from its OWN tube (measured 1.0 mm; every other mesh ≥ 20 mm). It FACES the mouth.
      const optic = new THREE.Mesh(new THREE.CircleGeometry(stR * 0.98, 48), darkOptic);
      optic.position.set(0, stLen * 0.5 - M * 0.01, 0);
      optic.rotation.x = -Math.PI / 2;   // circle +Z → tube-local +Y (mouth)
      optic.name = `StarTracker_${i}_Optic`;
      optic.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      tube.add(optic);

      // Mount wedge: the base disc sits ON the skin canted 30°, so its outer-aft lip would stand 43 mm over the hull
      // with air under it; a gunmetal wedge fills that slot. NOT a boresight-aligned box (reaching the skin along the
      // cant needs ~8 cm of aft run, through RCSPod_0's fore face and the axial bell RCSThruster_0_A): a hull-aligned
      // extrusion, profile in the axial–radial plane, ±0.029 tangentially. Bottom at radial 0.390 (10 mm inside the
      // skin); aft face vertical at z 0.876 (6 mm fore of the bell-mouth plane, 23 mm fore of the boot); top face
      // parallel to the tube, 12 mm inside its outer wall, so the top is hidden inside the tube and the side faces
      // emerge from the wall below the top edge at 53° (no ledge, no glancing cut); fore face (z 0.920) inside the
      // tube's cross-section. Twin wedges keep a ≥ 20 mm slit; the neighbour tube's base rim clears the inboard face
      // by ≥ 4 mm. No face is coplanar with the skin, the tube or the pod (log-depth: no polygonOffset).
      const STM_Z_AFT = 0.876, STM_Z_FORE = 0.920, STM_R_BOT = 0.390, STM_HALF_W = 0.029;
      const STM_S_TOP = 0.038;   // tube coordinate (along the outward-aft normal) of the top face
      const stmTopAt = (z) => 0.40 + Math.cos(30 * DEG2RAD) * STM_S_TOP
        + 0.5 * ((z - (0.90 - 0.5 * STM_S_TOP)) / Math.cos(30 * DEG2RAD));   // the s = STM_S_TOP line in (z, r)
      const stmZc = (STM_Z_AFT + STM_Z_FORE) / 2, stmRc = (STM_R_BOT + stmTopAt(STM_Z_FORE)) / 2;
      const prof = new THREE.Shape();   // shape x = axial (z), shape y = radial, about the centroid
      prof.moveTo(M * (STM_Z_AFT - stmZc), M * (STM_R_BOT - stmRc));
      prof.lineTo(M * (STM_Z_FORE - stmZc), M * (STM_R_BOT - stmRc));
      prof.lineTo(M * (STM_Z_FORE - stmZc), M * (stmTopAt(STM_Z_FORE) - stmRc));
      prof.lineTo(M * (STM_Z_AFT - stmZc), M * (stmTopAt(STM_Z_AFT) - stmRc));
      prof.closePath();
      const mountGeo = new THREE.ExtrudeGeometry(prof, { depth: M * 2 * STM_HALF_W, bevelEnabled: false });
      mountGeo.translate(0, 0, -M * STM_HALF_W);   // centre the tangential extrusion
      const tangential = new THREE.Vector3().crossVectors(zFwd, radial).normalize();
      const mount = new THREE.Mesh(mountGeo, stGunmetal);
      mount.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(zFwd, radial, tangential));
      mount.position.copy(radial).multiplyScalar(M * stmRc).setZ(M * stmZc);
      mount.name = `StarTracker_${i}_Mount`;
      mount.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(mount);
    });

    // TT&C omni antennas ×2: whips on a small base puck, radially outward, in opposite hemispheres: az 270° z +0.92
    // (fore) and az 78° z −0.92 (aft). The aft whip is at 78°, not 90°: 90° put it 1 mm off the axis of the aft pod's
    // axial bell (az 94.65°) and 55 mm downstream, in its cold gas; 78° is outside the drawn plume and puff cone of
    // every bell (test-LookR5).
    [[270, 0.92], [78, -0.92]].forEach(([azDeg, zFrac], i) => {
      const radial = radialAt(azDeg);
      const base = radial.clone().multiplyScalar(barrelR).setZ(barrelHZ * zFrac);
      const puck = new THREE.Mesh(new THREE.CylinderGeometry(M * 0.02, M * 0.02, M * 0.02, 48), gunmetal);
      puck.quaternion.setFromUnitVectors(yUp, radial);
      puck.position.copy(base).addScaledVector(radial, M * 0.008);   // base sits proud
      puck.name = `TTC_Omni_${i}_Base`;
      puck.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(puck);
      const whipGeo = new THREE.CylinderGeometry(M * 0.008, M * 0.008, M * 0.18, 24);
      const whip = new THREE.Mesh(whipGeo, gunmetal);
      whip.quaternion.setFromUnitVectors(yUp, radial);
      whip.position.copy(base).addScaledVector(radial, M * 0.09);
      whip.name = `TTC_Omni_${i}`;
      whip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(whip);
    });

    // A gunmetal bezel frame round each patch face + 4 screws (ONE merged mesh per patch), built in the patch's own
    // frame (local +Z = radial): 6 mm wide, outer edge 1 mm outside the patch edge (not coplanar; keeps the MGA >= 20 mm
    // from the folded radiator, test-EveryDoor), from the patch's inner face (-10 mm, inside the skin) to 1.5 mm proud of
    // its face. Screw heads (r 1.8 mm, 12-gons) stand 0.7 mm above the bar.
    const makeBezel = (name, patch, half, proud = 0.0015) => {
      const zLo = -0.010, zHi = 0.010 + proud, zc = (zLo + zHi) / 2, hh = zHi - zLo;
      const hi = half - 0.005, ho = half + 0.001;
      const parts = [];
      const bar = (cx, cy, sx, sy) => { const g = new THREE.BoxGeometry(M * sx, M * sy, M * hh); g.translate(M * cx, M * cy, M * zc); parts.push(g); };
      bar(0, (hi + ho) / 2, 2 * ho, ho - hi); bar(0, -(hi + ho) / 2, 2 * ho, ho - hi);
      bar((hi + ho) / 2, 0, ho - hi, 2 * hi); bar(-(hi + ho) / 2, 0, ho - hi, 2 * hi);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const g = new THREE.CylinderGeometry(M * 0.0018, M * 0.0018, M * 0.0016, 12);
        g.rotateX(Math.PI / 2);   // cylinder +Y -> +Z (radial)
        g.translate(M * sx * (hi + ho) / 2, M * sy * (hi + ho) / 2, M * (zHi - 0.0001));
        parts.push(g);
      }
      const bz = new THREE.Mesh(PlayerSatellite._mergeParts(parts), gunmetal);
      bz.position.copy(patch.position);   // a sibling, not a child: print/dims.mjs measures the patch's own subtree
      bz.quaternion.copy(patch.quaternion);
      bz.name = name;
      bz.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(bz);
    };
    // GPS patches are dark ceramic; the MGA keeps its pale thermal-white face.
    const darkCeramic = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.35, roughness: 0.3 });

    // MGA patch: tangent-mounted flat box, pale thermal-white, az ~25° fore-shoulder wedge, z 0.87. Centred ON the skin:
    // a 2 cm box at radial 0.400 spans 0.39–0.41, still ~1.5 mm buried at its 8 cm edges where the hull curves away to
    // 0.392, so no air shows under the edges.
    {
      const azDeg = 25, radial = radialAt(azDeg);
      const patch = new THREE.Mesh(new THREE.BoxGeometry(M * 0.16, M * 0.16, M * 0.02), thermalWhite);
      patch.quaternion.setFromUnitVectors(zFwd, radial);   // box +Z (face) → radial
      patch.position.copy(radial).multiplyScalar(barrelR).setZ(barrelHZ * 0.87);
      patch.name = 'MGA_Patch';
      patch.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(patch);
      makeBezel('MGA_Bezel', patch, 0.08, 0.0008);   // 0.8 mm: the folded radiator passes 22 mm off the MGA face (gate 20)
    }

    // Sun sensors ×4: pucks with a dark window disc. Two on the docking collar's ring fore face, two on barrel
    // fore-shoulder wedges.
    const ssR = M * 0.025, ssT = M * 0.015;
    const makeSunSensor = (idx, pos, axis) => {
      const puck = new THREE.Mesh(new THREE.CylinderGeometry(ssR, ssR, ssT, 48), gunmetal);
      puck.quaternion.setFromUnitVectors(yUp, axis);
      puck.position.copy(pos);
      puck.name = `SunSensor_${idx}`;
      puck.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(puck);
      // Window 0.7 R (a 12 mm window on a 50 mm puck read as a bolt head at 2.6 m). The ray origin the clearance meter
      // uses is the window CENTRE, so the register does not move with the radius.
      const win = new THREE.Mesh(new THREE.CircleGeometry(ssR * 0.7, 48), darkOptic);
      win.position.set(0, ssT * 0.5 + M * 0.001, 0);
      win.rotation.x = Math.PI / 2;
      win.name = `SunSensor_${idx}_Window`;
      win.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      puck.add(win);
    };
    // Fore pair: on the capture ring's fore face at az 90/270, (0, ±0.180) = the tube centreline radius, aft face 4 mm
    // INTO the tube top (puck spans z 1.316–1.331), facing +Z. The ring face is the highest clear platform on the nose
    // (0 % blocked; the turntable site was 58 % blind). The ring is a tether-hold SEAT, never a contact surface (the
    // berth hold keeps the catch 1.0 m fore of it), so hardware on its face is legitimate (IDSS rings carry targets and
    // reflectors). 5.9 mm clear of the ±Y strut heads (buried in the tube under the pucks).
    const collarZ = Constants.OCTOPUS_V5?.BERTH_COLLAR_Z_M ?? 1.30;
    const collarTube = Constants.OCTOPUS_V5?.BERTH_COLLAR_TUBE_R_M ?? 0.020;
    const collarRingR = M * ((Constants.OCTOPUS_V5?.BERTH_COLLAR_INNER_R_M ?? 0.16) + collarTube);
    const collarTubeTopZ = M * (collarZ + collarTube);
    makeSunSensor(0, new THREE.Vector3(0, collarRingR, collarTubeTopZ + ssT * 0.5 - M * 0.004), zFwd);
    makeSunSensor(1, new THREE.Vector3(0, -collarRingR, collarTubeTopZ + ssT * 0.5 - M * 0.004), zFwd);
    // Barrel pair: az 150° and 205°, z 0.90, radial-out. Centre at barrelR + ssT/2 − 5 mm so the puck is buried 5 mm
    // in the skin (a flat aft face would hover off the curved hull at its rim).
    [150, 205].forEach((azDeg, k) => {
      const radial = radialAt(azDeg);
      const pos = radial.clone().multiplyScalar(barrelR + ssT * 0.5 - M * 0.005).setZ(barrelHZ * 0.90);
      makeSunSensor(2 + k, pos, radial);
    });

    // GPS patches ×2: flat squares 0.07M, az ~340° fore-shoulder wedge, z 0.87 and 0.95. Centred at radial 0.405: the
    // 2 cm box spans 0.395–0.415, 5 mm buried at the centre, ~3 mm at the 3.5 cm edges (no air under the edges).
    [0.87, 0.95].forEach((zFrac, i) => {
      const azDeg = 340, radial = radialAt(azDeg);
      const patch = new THREE.Mesh(new THREE.BoxGeometry(M * 0.07, M * 0.07, M * 0.02), darkCeramic);
      patch.quaternion.setFromUnitVectors(zFwd, radial);
      patch.position.copy(radial).multiplyScalar(barrelR + M * 0.005).setZ(barrelHZ * zFrac);
      patch.name = `GPS_Patch_${i}`;
      patch.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(patch);
      makeBezel(`GPS_Bezel_${i}`, patch, 0.035);
    });
  }

  /** @private */
  _buildRcsPuffPool() {
    // Shared procedural radial gradient (headless-safe: null without a DOM, so the whole model builds in Node tests).
    const tex = getRadialGlowTexture({ size: 32 });

    const puffMat = new THREE.SpriteMaterial({
      map: tex || null,
      color: 0xcfe0ff,   // cool translucent cold-gas (N₂) white-blue, not a hot flash
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // depthTest ON so the hull/pods occlude puffs.
      depthTest: true,
    });

    // Nozzle positions keyed by THRUST-axis sign (exhaust appears OPPOSITE to thrust); ship +Z = forward (prograde).
    // Each key snaps to the nozzle whose EXHAUST best opposes that thrust (min exhaust·thrust), robust to the
    // doghouse-quad layout (radial=±Y, axial=±Z, tangential=±X across the 4 pods).
    const thrustAxis = {
      'pz': new THREE.Vector3(0, 0, 1),
      'nz': new THREE.Vector3(0, 0, -1),
      'px': new THREE.Vector3(1, 0, 0),
      'nx': new THREE.Vector3(-1, 0, 0),
      'py': new THREE.Vector3(0, 1, 0),
      'ny': new THREE.Vector3(0, -1, 0),
    };
    const dirs = this._rcsExhaustDir || [];
    const nozzles = this._rcsNozzleLocalPos || [];
    this._rcsPuffNozzles = {};
    this._rcsPuffDirs = {};   // exhaust dir per key — gas drifts along this in vacuum
    for (const key of Object.keys(thrustAxis)) {
      const thrust = thrustAxis[key];
      let best = null, bestDir = null;
      let bestDot = Infinity;   // want the MOST-opposing exhaust (most negative dot)
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i].dot(thrust);
        if (d < bestDot) { bestDot = d; best = nozzles[i]; bestDir = dirs[i]; }
      }
      this._rcsPuffNozzles[key] = best ? best.clone() : new THREE.Vector3();
      this._rcsPuffDirs[key] = bestDir ? bestDir.clone() : new THREE.Vector3(0, 1, 0);
    }

    // Attitude couples: which pod nozzles puff for pitch/yaw (arrow-key rotation puffs these and costs cold gas; see
    // fireRcsRotation). Torque from a nozzle is τ = r × F, thrust F = −exhaust. rotatePitch spins about +X, rotateYaw
    // about +Y. Pick the two nozzles with the largest same-sign torque about the axis (pitch resolves to the radial ±Y
    // bells, yaw to the tangential bells, by geometry).
    this._rcsAttitudeNozzles = {};
    this._rcsAttitudeDirs = {};   // exhaust dir per couple nozzle (index-aligned)
    this._rcsAttitudeIdx = {};    // nozzle INDICES per couple (into attitudeThrusterPlumes / _rcsLiners)
    const pickCouple = (comp, sign) => {
      const scored = [];
      for (let i = 0; i < dirs.length; i++) {
        const F = dirs[i].clone().multiplyScalar(-1);              // thrust = −exhaust
        const t = new THREE.Vector3().crossVectors(nozzles[i], F);
        const v = t[comp] * sign;
        if (v > 1e-9) scored.push({ i, v });
      }
      scored.sort((a, b) => b.v - a.v);
      const top = scored.slice(0, 2);
      return {
        pos: top.map(s => nozzles[s.i].clone()),
        dir: top.map(s => dirs[s.i].clone()),
        idx: top.map(s => s.i),
      };
    };
    for (const [key, comp, sign] of [
      ['pitchPos', 'x', +1], ['pitchNeg', 'x', -1],
      ['yawPos', 'y', +1], ['yawNeg', 'y', -1],
    ]) {
      const c = pickCouple(comp, sign);
      this._rcsAttitudeNozzles[key] = c.pos;
      this._rcsAttitudeDirs[key] = c.dir;
      this._rcsAttitudeIdx[key] = c.idx;
    }

    // Per-couple RESULTANT torque and force in SI: for the selected couple nozzles, τ = Σ (r × F) with r in metres
    // (× 1/M), F = −exhaust × NOZZLE_THRUST_N, and the net force Σ F (≈0 for the pitch couple, non-zero for yaw: the
    // parasitic side force we deliberately model). They are the authority ceilings the integrator clamps against and the
    // source of the yaw parasitic thrust fed into _rcsVelocity.
    const thrustN = Constants.ATTITUDE?.NOZZLE_THRUST_N ?? 25.0;
    this._rcsCoupleTorque = {};
    this._rcsCoupleForce = {};
    for (const key of Object.keys(this._rcsAttitudeIdx)) {
      const idx = this._rcsAttitudeIdx[key] || [];
      const tau = new THREE.Vector3();
      const force = new THREE.Vector3();
      for (const i of idx) {
        const rM = nozzles[i].clone().multiplyScalar(1 / M);        // metres
        const F = dirs[i].clone().multiplyScalar(-thrustN);         // N (thrust = −exhaust)
        tau.add(new THREE.Vector3().crossVectors(rM, F));
        force.add(F);
      }
      this._rcsCoupleTorque[key] = tau;
      this._rcsCoupleForce[key] = force;
    }

    // Pooled sprites (round-robin reuse); a burst emits a small multi-sprite cloud, so keep enough to avoid thrash.
    for (let i = 0; i < 16; i++) {
      const sprite = new THREE.Sprite(puffMat.clone());
      sprite.scale.set(M * 0.05, M * 0.05, M * 0.05);
      sprite.visible = false;
      sprite.name = `RcsPuff_${i}`;
      this.add(sprite);
      this._rcsPuffs.push({
        sprite, startTime: 0, active: false,
        startPos: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0),
        life: 0.3, maxScale: M * 0.3, baseOp: 0.5, drift: M * 0.5,
        rot: 0, spin: 0,
      });
    }
  }

  /** Get world position of the sensor gimbal (laser/scan origin) */
  getSensorGimbalPosition() {
    const pos = new THREE.Vector3();
    this.sensorGimbal.getWorldPosition(pos);
    return pos;
  }

  /** Get world position of a specific main FEEP nozzle (field-emission beam origin) */
  getMainThrusterPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.mainThrusters[index]) {
      this.mainThrusters[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  /** Get world position of a specific tether reel (tether origin) */
  getTetherReelPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.tetherReels[index]) {
      this.tetherReels[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  /** Set tether reel state (index 0-7, state: 'ready'|'deployed'|'empty') */
  setTetherState(index, state) {
    if (index >= 0 && index < this._tetherStates.length) {
      this._tetherStates[index] = state;
    }
  }

  /** Set the active thrust direction (read by the thruster glow). */
  setActiveThrustDirection(dir) {
    this._activeThrustDir = dir;
  }

  /**
   * Ion start-up (TransferTrip, DECISIONS §37 row 7): sets the four tail boxes' glow DIRECTLY, bypassing the glow lerp
   * (which would smooth the flicker away). `levels` = [top, bottom, right, left] 0..1 (Constants.THRUSTERS order);
   * null hands the glow back to its normal targets (no jump once all four burn at 1).
   * @param {number[]|null} levels
   */
  setIonStartGlow(levels) {
    if (!levels) { this._ionStartGlow = null; return; }
    if (!this._ionStartGlow) this._ionStartGlow = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) this._ionStartGlow[i] = clamp01(levels[i] || 0);
  }

  /**
   * Per-frame update: orbit, position, solar power, animations.
   * @param {number} dt - real-time (dtReal) seconds: attitude, RCS, resources, animations.
   * @param {THREE.Vector3} sunDirection - normalized sun direction
   * @param {number} [dtWorld] - game seconds for orbit + drag (from the TimeAuthority choke point); the default is the
   *   base rate for headless/test callers.
   * @param {boolean} [noMotorBilling=false] - menu/briefing/shop background tick (main.js): the battery clock is not
   *   running there, so motors must not bill (the charge would land as heat on the first play frame).
   */
  update(dt, sunDirection, dtWorld = TimeAuthority.baseGameDt(dt), noMotorBilling = false) {
    const gameDt = dtWorld;
    // Held-world frame (a drawer holds the world, dtWorld 0; main.js `_worldHeld`): bills no motor; meter and heat skip it too.
    this._motorBillHeld = !(dtWorld > 0) || noMotorBilling === true;
    this._wheelWorldDt = dtWorld > 0 ? dtWorld : 0;   // the reaction-wheel coils work on the world clock (`_wheelFrameEnd`)
    // OFF-PLAY frame (menu/briefing/shop tick): bills nothing, no base load, no cold-gas hold (else it lands as one heat
    // step when play resumes). Deliberately NOT keyed on _motorBillHeld: a held frame (drawer open) still bills.
    this._offPlayFrame = noMotorBilling === true;

    // Cache the sun direction for puff sun-scatter (null when unavailable: headless / null-sun frames stay scatter-free,
    // no per-frame alloc).
    if (sunDirection) {
      this._sunDirWorld ||= new THREE.Vector3();
      this._sunDirWorld.copy(sunDirection);
    } else {
      this._sunDirWorld = null;
    }

    this._updateThrusterInterlock();

    // Mother-net recoil: integrate the transient hull pitch and let RCS (attitude hold) spring it back to zero. Ungated:
    // only the mother net feeds _recoilPitchAngle.
    this._tickRecoilAttitude(gameDt);

    this._applyThrust(gameDt);

    const kmOrbit = {
      ...this.orbit,
      semiMajorAxis: this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
    };
    propagateOrbit(kmOrbit, gameDt);
    this.orbit.trueAnomaly = kmOrbit.trueAnomaly;
    this.orbit.meanMotion = kmOrbit.meanMotion;

    const altKm = (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
    if (altKm < Constants.DRAG_CEILING_KM) {
      const vel = orbitalVelocity(
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        Constants.MU_EARTH
      );
      // Her live area and mass, once per frame (the sub-steps below only split the factor). Area: dragAreaM2() = projected
      // area across her velocity from her real attitude, radiator angle and wing turn (MotherDragArea.js). Mass: this.mass.
      // The welcome pieces (DebrisField.dragDecelFor) read the two values USED here (lastDragAreaM2 / lastDragMassKg) so
      // their SMA decays in lock-step with hers: the ballistic coefficient is the ONLY input to the per-step decay
      // factor that differs between the two.
      const areaM2 = this.dragAreaM2();
      const massKg = this.mass;
      this.lastDragAreaM2 = areaM2;
      this.lastDragMassKg = massKg;
      const dragDecel = atmosphericDrag(altKm, vel, areaM2, massKg);
      if (vel > 0) {
        // Drag chunking: the decay factor (1 − 2·dvDrag/vel) can go negative at high warp (large gameDt), flipping the
        // orbit. Integrate in ≤ DRAG_CHUNK_GAME_S game-second sub-steps (a single step at warp ≤ ~6×, gameDt ≤ 60).
        const nSub = TimeAuthority.dragSubSteps(gameDt);
        const subDt = gameDt / nSub;
        const factor = 1 - 2 * (dragDecel * subDt) / vel;
        for (let s = 0; s < nSub; s++) this.orbit.semiMajorAxis *= factor;
      }
    } else {
      this.lastDragAreaM2 = null;      // above the air: no drag step this frame, the welcome pieces fall back to her reference
      this.lastDragMassKg = null;
    }

    this._updateCartesian();
    this._applyPosition();

    if (this._rcsVelocity.lengthSq() > 1e-20) {
      this.position.addScaledVector(this._rcsVelocity, dt);
      // Damping: velocity decays when not thrusting (stops quickly on key release)
      this._rcsVelocity.multiplyScalar(Constants.RCS_DAMPING);
      if (this._rcsVelocity.lengthSq() < 1e-22) {
        this._rcsVelocity.set(0, 0, 0);
      }
    }

    // Mother-net cosmetic launch-recoil shudder: add the decaying offset to the rendered position, then spring it to
    // zero. _applyPosition() recomputes position from orbit every frame, so it never accumulates into the orbit (purely
    // visual; the tether/muzzle follow via getPosition).
    if (this._recoilOffset.lengthSq() > 1e-24) {
      this.position.add(this._recoilOffset);
      const decay = Math.max(0, 1 - Constants.LASSO_RECOIL_DECAY * dt);
      this._recoilOffset.multiplyScalar(decay);
      if (this._recoilOffset.lengthSq() < 1e-26) this._recoilOffset.set(0, 0, 0);
    }

    // Rigid-body attitude integration, REAL dt (never gameDt). Runs BEFORE _orientAlongVelocity composes
    // quaternion = prograde · _manualRotation, and after _updateCartesian so the prograde base and the handback
    // continuity read the current velocity/position.
    this._tickAttitudeDynamics(dt);

    this._orientAlongVelocity();

    // Transient recoil attitude rides on top of the settled heading (applied here so it also shows under autopilot/inspection
    // holds, which _orientAlongVelocity early-returns from). Both springs settle in ~2 s.
    //   • pitch (+X): mother whale-net launch off the CoM axis
    //   • yaw   (+Y): crossbow / dual-fire angular residual
    //
    // A quaternion NOT rebuilt this frame (AIM; AUTOPILOT without the orbit-frame hold) still carries last frame's
    // overlay, so that comes off first, else every frame stacks another (a 0.3 rad/s kick drifted the nose 7° under AP).
    // A rebuilt quaternion (`_orientAlongVelocity`) already dropped the old overlay and cleared the record, so nothing
    // comes off twice. AutopilotSystem takes it off at the top of its own update too (before it slews), same call.
    this.undoRecoilOverlay();
    if (this._recoilPitchAngle !== 0 || this._recoilYawAngle !== 0) {
      const applied = this._qRecoilApplied.identity();
      if (this._recoilPitchAngle !== 0) {
        applied.multiply(this._qRecoil.setFromAxisAngle(this._vRecoilPitchAxis, this._recoilPitchAngle));
      }
      if (this._recoilYawAngle !== 0) {
        applied.multiply(this._qRecoil.setFromAxisAngle(this._vRecoilYawAxis, this._recoilYawAngle));
      }
      this.quaternion.multiply(applied);
      this._recoilApplied = true;
    }

    this._updateSolarPower(sunDirection, dt);

    this._updateResources(dt, this._offPlayFrame === true);

    // MPD thermal dissipation (always runs, even when not firing)
    if (this._mpdHeat > 0) {
      const coolRate = this._hasSupercap
        ? (Constants.MPD_BURST_COOL_RATE_SUPERCAP || 0.5)
        : (Constants.MPD_BURST_COOL_RATE || 0.3);
      this._mpdHeat = Math.max(0, this._mpdHeat - coolRate * dt);
    }

    if (this._mpdCooldownTimer > 0) {
      this._mpdCooldownTimer -= dt;
      if (this._mpdCooldownTimer <= 0) {
        this._mpdCooldownTimer = 0;
        this._mpdHeat = 0;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thermal nominal. Ready to arm',
          priority: 'info',
        });
      }
    }

    if (this._mpdArmed && this.resources.battery <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'battery_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD OFFLINE. Battery depleted',
        priority: 'warning',
      });
    }

    if (this._mpdArmed && this.resources.lithium <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'lithium_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD FUEL DEPLETED. No lithium',
        priority: 'warning',
      });
    }

    this._updateRosaPanels(dt);
    this._animateSolarTracking(dt, sunDirection);
    this._animateRosaGlow(dt);
    // No sensor gimbal tracking: the turret is a FIXED ring around the collar bore (see _buildSensors).
    this._animateNavLights(dt);
    this._animateThrusterGlow(dt);
    this._animateLidarPulse(dt);
    this._animateTetherIndicators(dt);
    this._animateScanFlash(dt);
    this._updateRcsPuffs(dt);
    this._updateStruts(dt);
    this._updateFlower(dt);

    if (this._edtDeployed && !this._edtActive) {
      const deployTime = (Constants.EDT && Constants.EDT.DEPLOY_TIME) || 5;
      this._edtDeployTimer += dt;
      if (this._edtDeployTimer >= deployTime) {
        this._edtActive = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT active. Attracting nearby debris', priority: 'info',
        });
      }
    }

    if (this._edtActive) {
      const powerDraw = (Constants.EDT && Constants.EDT.POWER_DRAW) || 0.05;
      if (this._resourceSystem && !this._resourceSystem.canAfford('battery', powerDraw * dt)) {
        this._edtActive = false;
        this._edtDeployed = false;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT shutdown. Low power', priority: 'warning',
        });
      } else if (this._resourceSystem) {
        this._resourceSystem.consume('battery', powerDraw * dt);
        eventBus.emit(Events.EDT_ATTRACT, {
          position: this.position ? this.position.clone() : new THREE.Vector3(),
          radius: (Constants.EDT && Constants.EDT.ATTRACTION_RADIUS_KM) || 0.2,
          force: (Constants.EDT && Constants.EDT.ATTRACTION_FORCE) || 0.0001,
          maxMass: (Constants.EDT && Constants.EDT.MAX_ATTRACT_MASS) || 20,
        });
      } else {
        // No resource system — drain legacy battery directly
        this.resources.battery -= powerDraw * dt;
        if (this.resources.battery <= 0) {
          this.resources.battery = 0;
          this._edtActive = false;
          this._edtDeployed = false;
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'EDT', text: 'EDT shutdown. Low power', priority: 'warning',
          });
        }
      }
    }

    if (Math.random() < 0.02) {
      const currentFuel = this._resourceSystem
        ? this._resourceSystem.getCurrentFuel()
        : Constants.FUELS[Constants.DEFAULT_FUEL];

      const frac = (v, of) => (of > 0 && Number.isFinite(v) ? Math.max(0, v) / of : 1);
      eventBus.emit(Events.PLAYER_TELEMETRY, {
        altitude: altKm,
        velocity: this._cartesian.velocity,
        resources: { ...this.resources },
        // The fractions the codex triggers read, against what the ship LAUNCHED with (so nothing unlocks on the first
        // frame). 0..1; gas may exceed 1 after a resupply.
        engineGasPct: START_GAS_KG > 0 ? engineGasKg(this.resources) / START_GAS_KG : 1,
        coldGasPct: frac(this.resources.coldGas, Constants.COLD_GAS_MAX * (Constants.PROPELLANT_START_FRACTION ?? 1)),
        batteryPct: frac(this.resources.battery, this._resourceSystem?.batteryMax ?? Constants.BATTERY_MAX),
        orbit: { ...this.orbit },
        deltaVSpent: this._deltaVSpent,
        thrustDirection: this._thrustDirection,
        lastThrustType: this._lastThrustType,
        deltaV: this._telemetryDeltaV(),   // the HUD figure (getMassBudget); no game reader (test-ArgonEngine pins it)
        consumptionMultiplier: consumptionMultiplier(this),   // c (Isp_eff = Isp / c); no game reader
        currentFuelId: currentFuel.id || Constants.DEFAULT_FUEL,
        currentIsp: currentFuel.isp || Constants.OCTOPUS_CORE_HALL_ISP,
        throttleLevel: this.throttleLevel,
        edtActive: this._edtActive,
        edtDeployed: this._edtDeployed,
        hasMPD: this._hasMPD,
        mpdCathodeTime: this._mpdCathodeTime,
        mpdCathodeHealth: this.mpdCathodeHealth,
        mpdCathodeLife: this._mpdCathodeLife,
        mpdArmed: this._mpdArmed,
        mpdHeat: this._mpdHeat,
        mpdHeatFraction: this.mpdHeatFraction,
        mpdCooldownRemaining: this._mpdCooldownTimer,
        mpdDegraded: this._mpdDegraded,
      });
    }
    // Reset per-frame thrust direction (accumulated fresh each frame)
    this._thrustDirection = null;
  }

  /**
   * @private Solar panels slowly track the sun via boom-axis tilt: each pivot rotates around the boom axis (body ±X),
   * so wings keep extending in ±X (orbit-normal → horizontal on screen from CHASE camera).
   * Panel normal at rotation.x = 0 is body +Y (zenith); rotation.x = α tilts it to (0, cos α, sin α) in body space;
   * optimal α = atan2(localSun.z, localSun.y).
   * Precedence: furl wins — a furled wing is parked at 0° (the rolled cylinder is a pivot child, so tracking would
   * visibly tilt it) and the target blends to the sun angle across the deploy stroke. Deployed and feathered: the pivot
   * goes to the edge-on park angle (sun-track skipped). Otherwise it tracks the sun, clamped to the tier-aware maximum
   * so the trailing edge clears the arm struts.
   */
  _animateSolarTracking(dt, sunDirection) {
    if (!sunDirection) return;

    // DECISIONS §10 + owner 2026-09-25: while the wing-drum clamps are latched (the re-stow latch, closed once the wings
    // are rolled fully up) hold tilt 0 outright. The drum ends are bolted to the end rings (see _buildRosaStructure), so
    // no reliance on the furl blend landing at 0. Sun-track, feather and dodge all live in `_rosaDesiredTilt`, never
    // reached while latched.
    if (this._wingClampsLatched()) {
      if (this.panelRightPivot) this.panelRightPivot.rotation.x = 0;
      if (this.panelLeftPivot) this.panelLeftPivot.rotation.x = 0;
      return;
    }

    // DECISIONS §10: the tilt law itself dodges (`_rosaDesiredTilt` clamps through `_rosaDodgeLimitRad`, which wins over
    // sun-track AND feather). An OVERRIDE fold takes the tightest limit from the moment it arms, so the wing beats the
    // radiator down and the driver never waits for the pivots.
    const desired = this._rosaDesiredTilt(sunDirection);

    // A furled wing must NOT track the sun: the rolled cylinder, drum, spool curls and brackets are children of this
    // pivot, so tracking would visibly tilt (and jump) the 2 m roll on every attitude slew. Park at 0° (roll parallel to
    // the hull) and blend to the sun target across the deploy stroke (same exponential filter: unfurling reads as a
    // motorized gimbal waking up). This deliberately replaces the old "no wake-up sweep" goal: the sweep runs across the
    // 2.5 s furl stroke, not as a post-deploy twitch.
    const furl = this._rosaFurlProgress ?? 1;
    const blend = clamp01((furl - 0.15) / 0.5); // 0 furled → 1 by ~65%
    const target = desired * blend; // stow tilt = 0

    // First-frame seed for spawn-already-deployed: assign directly so it doesn't sweep from 0. Only when the wing is
    // ALREADY essentially deployed; during a roll-out (progress rising through 0.9) the smooth blend must carry the
    // gimbal up, not a one-frame snap.
    if (!this._rosaTrackSeeded) {
      this._rosaTrackSeeded = true;
      if (furl > 0.98) {
        if (this.panelRightPivot) this.panelRightPivot.rotation.x = target;
        if (this.panelLeftPivot) this.panelLeftPivot.rotation.x = target;
        return;
      }
    }

    // Framerate-correct exponential smoothing toward the target (~0.57 s time constant). Rate 1.75: brisk enough to keep
    // up with attitude slews (aim/launch/autopilot), not so fast it snaps. No deadband: the filter already rejects
    // attitude micro-noise, and a deadband turns settled motion into freeze/nudge/freeze steps.
    const alpha = 1 - Math.exp(-1.75 * dt);

    // Each wing's tilt drive bills on frames it turns at least MOTOR_DRAW_W.MOVE_MIN_DEG_S (0.1°/s): slews, feather
    // swings, live tracking. The exponential tail after catching the sun (and a clamped, holding drive) bills nothing.
    // The menu hero runs this too but has no battery wired, so it never bills.
    const moveMin = motorMoveMinRadS() * dt;
    const driveW = Constants.MOTOR_DRAW_W?.WING_DRIVE ?? 0;
    if (this.panelRightPivot) {
      const cur = this.panelRightPivot.rotation.x;
      this.panelRightPivot.rotation.x = lerp(cur, target, alpha);
      if (Math.abs(this.panelRightPivot.rotation.x - cur) >= moveMin) billMotorW(this, driveW, dt);
    }
    if (this.panelLeftPivot) {
      const cur = this.panelLeftPivot.rotation.x;
      this.panelLeftPivot.rotation.x = lerp(cur, target, alpha);
      if (Math.abs(this.panelLeftPivot.rotation.x - cur) >= moveMin) billMotorW(this, driveW, dt);
    }
  }

  /**
   * @private Desired ROSA pivot tilt (rad) for a sun direction: optimal boom-axis tilt (panel normal → sun projection
   * in the YZ plane), tier-aware clamp, blend toward the edge-on park angle when feathered, then the DECISIONS §10
   * DODGE clamp, which wins over both sun-track and feather (`_rosaDodgeLimitRad`). Shared by live tracking and
   * first-frame seeding.
   * @param {THREE.Vector3} sunDirection — world-space sun direction
   * @returns {number} desired pivot rotation.x in radians
   */
  _rosaDesiredTilt(sunDirection) {
    const localSun = _v3TmpA.copy(sunDirection).applyQuaternion(_qInvTmp.copy(this.quaternion).invert());

    const targetTilt = Math.atan2(localSun.z, localSun.y);

    const maxTilt = this._rosaMaxTiltRad();

    // Feather: when feathered (and deployed) park the wing edge-on to the sun (target + 90°) instead of tracking,
    // minimising the blanket's sun-facing cross-section to dodge a hazard while staying deployed.
    const feather = this._rosaFeatherProgress ?? 0;
    let desired;
    if (feather > 0) {
      const edgeOn = targetTilt + Math.PI / 2;
      const tracked = clamp(targetTilt, -maxTilt, maxTilt);
      desired = lerp(tracked, edgeOn, feather);
    } else {
      desired = clamp(targetTilt, -maxTilt, maxTilt);
    }

    // DECISIONS §10 — the dodge wins over sun-track AND feather.
    const dodge = this._rosaDodgeLimitRad();
    if (dodge !== Infinity) desired = clamp(desired, -dodge, dodge);
    return desired;
  }

  /**
   * @private DECISIONS §10 — the wing dodge tilt limit (radians, or Infinity when unconstrained): the MINIMUM of two
   * measured clearance curves.
   *   θ-curve — petals ↔ wings, 20 mm clearance: 5° while the radiator is folded flat (θ < WING_DODGE_LOW_THETA_DEG;
   *     CLOSED, the orbit rest, lives here), 12° through the fold corridor and the bloom (θ < WING_DODGE_MID_THETA_DEG),
   *     unconstrained above. EARLY DODGE: a commanded swing takes the limit of the LOWEST θ it will pass —
   *     min(θ, target) — from the moment it is commanded, and an OVERRIDE fold (`_flowerOverrideFold`) takes the LOW
   *     limit from the moment it ARMS and holds it while the lock is armed. The wing motor (τ 0.57 s) then beats the
   *     15°/s radiator to every θ, so the radiator never waits for the wing. Measured: with the θ thresholds alone a
   *     close 146° → 2° with the wings feathered touched a petal; with the early dodge every close keeps ≥ 59 mm.
   *     Only with a radiator fitted (a ship without one has nothing to dodge).
   *   α-curve — struts+daughters ↔ wings: while any strut is at — or slewing through — α WING_DODGE_ALPHA_LO..HI,
   *     feathering (60–120°) contacts the wing root hardware; the limit drops to WING_DODGE_ALPHA_LIMIT.
   * A furled wing never sees this (the furl blend parks tilt 0 first); the ?shot=1 dev force furls ROSA by its own
   * procedure. No pivot hardware → Infinity.
   * @returns {number} max |tilt| in radians, or Infinity
   */
  _rosaDodgeLimitRad() {
    if (!this.panelRightPivot && !this.panelLeftPivot) return Infinity;
    const FL = Constants.THERMAL.FLOWER;
    let limitDeg = Infinity;
    if (this._flowerOverrideFold) {
      limitDeg = FL.WING_DODGE_LOW_LIMIT_DEG;              // fold in flight — dodge early
    } else if (this._flowerGroups && this._flowerGroups.length > 0) {
      // The dodge is about the ring: the MOST RESTRICTIVE petal (the smallest angle any petal is on its way to) decides,
      // so a petal held low for a catch keeps the wings dodging as four petals at that angle did
      const r = this._petalRangeInto(this._petalRange || (this._petalRange = { min: 0, max: 0, minTarget: 0 }));
      const thDeg = Math.min((this._flowerThetaRad ?? Math.PI / 2) * RAD2DEG, r.min * RAD2DEG, r.minTarget * RAD2DEG);
      if (thDeg < FL.WING_DODGE_LOW_THETA_DEG) limitDeg = FL.WING_DODGE_LOW_LIMIT_DEG;
      else if (thDeg < FL.WING_DODGE_MID_THETA_DEG) limitDeg = FL.WING_DODGE_MID_LIMIT_DEG;
    }
    if (this._strutsInWingDodgeBand()) {
      limitDeg = Math.min(limitDeg, FL.WING_DODGE_ALPHA_LIMIT_DEG);
    }
    return limitDeg === Infinity ? Infinity : degToRad(limitDeg);
  }

  /**
   * @private Is any strut at — or slewing through — the wing-dodge α band (WING_DODGE_ALPHA_LO..HI)? The live aim AND
   * a pending latch both count: a strut commanded across the band engages the dodge for the whole crossing.
   */
  _strutsInWingDodgeBand() {
    const FL = Constants.THERMAL.FLOWER;
    const lo = degToRad(FL.WING_DODGE_ALPHA_LO_DEG);
    const hi = degToRad(FL.WING_DODGE_ALPHA_HI_DEG);
    const arms = this.armManager && this.armManager.arms;
    if (!arms || arms.length === 0) return false;
    for (const arm of arms) {
      if (!arm) continue;
      const a = arm.getAimAlpha ? arm.getAimAlpha() : null;
      if (a === null || a === undefined) continue;
      const t = arm._strutTargetAlpha;
      const loEnd = t !== undefined ? Math.min(a, t) : a;
      const hiEnd = t !== undefined ? Math.max(a, t) : a;
      if (loEnd < hi && hiEnd > lo) return true;
    }
    return false;
  }

  /**
   * @private Tier-aware sun-track tilt clamp (radians): tilt swings the ROSA trailing edge toward the arm-strut planes.
   * Y0 struts sit 64° off the 0°/180° ROSA plane, so the loose ±30° clears them; Y1+ tiers add struts only 30° from the
   * plane, so when the nearest strut is within ~30° the clamp tightens to ROSA_TILT_CLAMP_TIGHT_DEG.
   * Reads the active tier's azimuths from ArmManager/ARM_LADDER at runtime (an in-session refit updates the clamp);
   * falls back to the Y0 quad azimuths.
   * @returns {number} max tilt magnitude in radians
   */
  _rosaMaxTiltRad() {
    const V5 = Constants.OCTOPUS_V5;
    const looseDeg = 30;
    const tightDeg = V5.ROSA_TILT_CLAMP_TIGHT_DEG ?? 18;

    // Active tier's strut azimuths (degrees).
    let azimuths = Constants.ARM_LADDER?.Y0_QUAD?.azimuths ?? [64, 116, 244, 296];
    const tierKey = this.armManager?.getCurrentTier?.();
    if (tierKey && Constants.ARM_LADDER?.[tierKey]?.azimuths) {
      azimuths = Constants.ARM_LADDER[tierKey].azimuths;
    }

    // Smallest angular gap between any strut and the ROSA plane (0° / 180°).
    let minGapDeg = 90;
    for (const az of azimuths) {
      const a = ((az % 180) + 180) % 180;      // fold onto [0,180): plane is 0 & 180
      const gap = Math.min(a, 180 - a);
      if (gap < minGapDeg) minGapDeg = gap;
    }

    const deg = minGapDeg <= 30 + 1e-6 ? tightDeg : looseDeg;
    return degToRad(deg);
  }

  /**
   * @private Power-flow glow on the ROSA cell faces: the front material emissive follows resources.solarRate, so the
   * wings energize in sunlight and go dark in shadow / when feathered or furled (both already drop solarRate), with a
   * faint sine "breathing". Runs BEFORE _animateScanFlash so a scan pulse overrides it for its brief window. The menu
   * hero has no power subsystem, so it sets `_rosaGlowIdleFloor` for a constant energized look.
   * @param {number} dt — seconds since last frame
   */
  _animateRosaGlow(dt = 0) {
    if (!this._rosaFrontMats || !this._rosaFrontMats.length) return;
    this._rosaGlowClock += dt;

    // Normalise generated power to 0..1 against the theoretical panel peak.
    const peak = Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA *
                 Constants.SOLAR_PANEL_EFFICIENCY;
    const rate = this.resources?.solarRate ?? 0;
    let frac = peak > 0 ? rate / peak : 0;
    frac = clamp(frac, this._rosaGlowIdleFloor || 0, 1);

    const breathe = 0.04 * (0.5 + 0.5 * Math.sin(this._rosaGlowClock * 2.0));
    const intensity = 0.12 + 0.66 * frac + breathe * frac;
    // Hue lerp: deep royal blue (0x101e64) → bright royal blue (0x2a55ff). Both ends are blue-dominant, so the wings
    // read royal blue at ANY power level.
    const r = 0x10 + Math.round((0x2a - 0x10) * frac);
    const g = 0x1e + Math.round((0x55 - 0x1e) * frac);
    const b = 0x64 + Math.round((0xff - 0x64) * frac);
    const hex = (r << 16) | (g << 8) | b;
    for (const mat of this._rosaFrontMats) {
      mat.emissive.setHex(hex);
      mat.emissiveIntensity = intensity;
    }
  }

  /** @private No-op: nav lights are constant (set at build); kept so the update loop and menu hero call sites stay stable. */
  _animateNavLights(dt) {
  }

  /**
   * @private Tail ion-box glow — lit only while the ion engine pushes (trip burn via
   * setActiveThrustDirection, or thrustInput.z > 0). Turns never light it: attitude is
   * cold gas, whose bells are driven below and by fireRcsRotation.
   */
  _animateThrusterGlow(dt) {
    const ti = this.thrustInput;
    const mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    const hasThrust = mag > 1e-12;
    const lerpRate = Constants.DIFFERENTIAL_THRUST.LERP_RATE;

    this.mainThrusters.forEach((thruster, i) => {
      const data = this._thrusterGlowTargets.get(thruster);
      if (!data) return;

      let progradeTarget = 0;
      if (hasThrust && ti.z > 0) {
        progradeTarget = Math.min(1.0, Math.abs(ti.z) * 5000);
      }
      // The transfer trip burns the ion engine for its whole length but fires no impulse (thrustInput stays 0: orbit and
      // battery untouched), so it lights the plume through setActiveThrustDirection.
      if (this._activeThrustDir && this._activeThrustDir.z > 0) progradeTarget = 1.0;

      let target = progradeTarget;
      // Sloth mode: a box the slow turn lights glows for as long as it thrusts (per box), max-combined with the shared
      // trip/prograde target. Warm-up gives no glow (no thrust).
      if (this._slothGlow && this._slothGlow[i] > target) target = this._slothGlow[i];

      // Ion start-up: the trip sets the level itself (the sputter would not survive the lerp)
      if (this._ionStartGlow) {
        const lvl = this._ionStartGlow[i] || 0;
        data.intensity = lvl;
      } else {
        data.intensity += (target - data.intensity) * Math.min(1, dt * lerpRate);
      }

      if (data.glow && data.glow.material) {
        data.glow.material.opacity = data.intensity * 0.8;
        data.glow.material.color.setHex(0x99bbdd);
      }

      if (data.plume) {
        data.plume.visible = data.intensity > 0.05;
        if (data.plume.visible) {
          // Frame-rate-independent shimmer: two sines (±~5%), NOT per-frame Math.random() (frame-rate-dependent flicker).
          // Ion emission is steady: length breathes with thrust, width stays ~constant.
          const t = Date.now() * 0.001;
          const shimmer = 1 + 0.032 * Math.sin(t * 6.1 + i * 1.7)
                            + 0.02 * Math.sin(t * 11.3 + i * 2.9);
          const lenS = (0.55 + data.intensity * 0.9) * shimmer;
          const wS = 0.9 + data.intensity * 0.12;
          data.plume.scale.set(wS, lenS, wS);                   // local +Y = beam length
          data.plume.material.opacity = data.intensity * 0.5;   // steady (fade is vertex-alpha)
          data.plume.material.color.setHex(0x99bbdd);
        }
      }

      if (data.outerGlow) {
        data.outerGlow.visible = data.intensity > 0.08;
        if (data.outerGlow.visible) {
          const t = Date.now() * 0.001;
          const shimmer = 1 + 0.028 * Math.sin(t * 4.3 + i * 2.3);
          const lenS = (0.6 + data.intensity * 0.8) * shimmer;
          const wS = 0.95 + data.intensity * 0.1;
          data.outerGlow.scale.set(wS, lenS, wS);
          data.outerGlow.material.opacity = data.intensity * 0.16;
          data.outerGlow.material.color.setHex(0xaaccee);
        }
      }

      if (data.innerLiner && data.innerLiner.material) {
        const DT = Constants.DIFFERENTIAL_THRUST;
        const fireEmissive = DT.INNER_EMISSIVE_BASE + data.intensity * DT.INNER_EMISSIVE_FIRE_SCALE;
        data.innerLiner.material.emissiveIntensity = fireEmissive;
        data.innerLiner.material.emissive.setHex(0x334466);
      }
    });

    // Attitude (RCS) thrusters — DIRECTION-AWARE, 3-D for the doghouse pods. thrustInput carries LOCAL translation ΔV.
    // Each nozzle stores its EXHAUST direction (`_rcsExhaustDir`: radial for the lateral bells, ±Z for the pod axial
    // bells) and fires when its exhaust opposes the demand: to thrust +X, the exhaust must exit −X. The z demand lights
    // the axial bells too (fore pods exhaust +Z for retro trim, aft pods −Z for prograde trim).
    _rcsL.set(ti.x, ti.y, ti.z);
    const lMag = _rcsL.length();
    const transScale = Math.min(1, lMag * 5000);
    const haveLat = lMag > 1e-12 && transScale > 0.001;
    if (haveLat) _rcsLn.copy(_rcsL).divideScalar(lMag);
    const plumes = this.attitudeThrusterPlumes;
    const shadowMul = this._inShadow ? 0.35 : 1;   // eclipse dimming (cold gas isn't self-luminous)
    const flash = this._rcsAttitudeFlash;
    for (let k = 0; k < plumes.length; k++) {
      const plume = plumes[k];
      const exhaust = this._rcsExhaustDir[k];
      let transInten = 0;
      if (haveLat && exhaust) transInten = Math.max(0, -exhaust.dot(_rcsLn)) * transScale;
      // Attitude rotation lights the couple bells directly, decoupled from the puff cadence; composite =
      // max(translation, attitude flash).
      const attInten = flash ? flash[k] : 0;
      const inten = Math.max(transInten, attInten);
      plume.visible = inten > 0.1;
      if (plume.visible && plume.material) {
        plume.material.opacity = inten * 0.5 * shadowMul;
        // Jet-core streak: grow the plume along its beam axis (+Y) with intensity; the root is welded to the bell mouth,
        // so it stretches outward.
        const s = 0.7 + inten * 0.6;
        plume.scale.set(s, s * (1 + 0.4 * inten), s);
      }
      // Liner throat glow: only firing bells brighten; emissive → 0 as the flash decays (driven every frame, so no
      // restore bookkeeping).
      const liner = this._rcsLiners && this._rcsLiners[k];
      if (liner && liner.material) {
        liner.material.emissive.setHex(0x8fb0d8);
        liner.material.emissiveIntensity = 0.6 * inten;
      }
    }

    // Decay the attitude flash toward 0: held keys re-raise it each frame in fireRcsRotation; released keys fade over ~1/8 s.
    if (flash) {
      const decay = Math.exp(-8 * dt);
      for (let k = 0; k < flash.length; k++) {
        flash[k] *= decay;
        if (flash[k] < 1e-3) flash[k] = 0;
      }
    }
  }

  /** @private Scan flash: brief cyan emissive pulse on body material (SCAN_INITIATED), decays over 0.5 s. */
  _animateScanFlash(dt) {
    if (this._scanFlashTimer <= 0) return;
    this._scanFlashTimer -= dt;

    const t = Math.max(0, this._scanFlashTimer / 0.5);
    const done = this._scanFlashTimer <= 0;

    // Drive BOTH the MLI body blanket and the solar-cell panels with the cyan scan glow. Restore values MUST match each
    // material's build defaults.
    if (this._matBody) {
      this._matBody.emissive.setHex(0x00aaff);
      this._matBody.emissiveIntensity = t * 0.6;
      if (done) {
        this._matBody.emissive.setHex(MLI_FOIL_LOOK.emissive);   // gold MLI build default (_matGoldMLI)
        this._matBody.emissiveIntensity = MLI_FOIL_LOOK.emissiveIntensity;
      }
    }
    if (this._cellSkinMats) {
      for (const mat of this._cellSkinMats) {
        mat.emissive.setHex(0x00aaff);
        mat.emissiveIntensity = t * 0.6;
        if (done) {
          mat.emissive.setHex(0x0b1030); // build default (_buildMainBus)
          mat.emissiveIntensity = 0.18;
        }
      }
    }
    // ROSA wings: the same cyan pulse across the cell faces. On `done` DON'T restore: _animateRosaGlow runs every frame
    // (before this) and owns the steady state.
    if (!done && this._rosaFrontMats) {
      for (const mat of this._rosaFrontMats) {
        mat.emissive.setHex(0x00aaff);
        mat.emissiveIntensity = t * 0.7;
      }
    }
  }

  /** @private LIDAR occasional green pulse */
  _animateLidarPulse(dt) {
    this._lidarPulseTimer += dt;
    if (this._lidarPulseTimer > 3.0) {
      this._lidarPulseTimer = 0;
      this._lidarLightMat.opacity = 1.0;
    }
    if (this._lidarLightMat.opacity > 0) {
      this._lidarLightMat.opacity = Math.max(0, this._lidarLightMat.opacity - dt * 2.0);
    }
  }

  /** @private Tether indicator colours by state (a no-op: the bus reels are removed). */
  _animateTetherIndicators(dt) {
    // Bus reels removed: guard against empty arrays
    if (!this._tetherIndicators || this._tetherIndicators.length === 0) return;

    this._tetherStates.forEach((state, i) => {
      const ind = this._tetherIndicators[i];
      if (!ind) return;

      switch (state) {
        case 'ready':
          ind.material.color.setHex(0x00ff44);
          break;
        case 'deployed':
          ind.material.color.setHex(0xffaa00);
          if (this.tetherReels && this.tetherReels[i]) {
            this.tetherReels[i].children[1].rotation.y += dt * 2;
          }
          break;
        case 'empty':
          ind.material.color.setHex(0xff2222);
          break;
      }
    });

    // EDT active: pulse the indicators blue (colour override: they are MeshBasicMaterial, no emissive)
    if (this._edtActive && this._tetherIndicators && this._tetherIndicators.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
      const r = Math.round(79 * pulse);
      const g = Math.round(195 * (0.5 + 0.5 * pulse));
      const b = Math.round(247);
      for (const indicator of this._tetherIndicators) {
        if (indicator && indicator.material) {
          indicator.material.color.setRGB(r / 255, g / 255, b / 255);
        }
      }
    }
  }

  /** Set ResourceSystem reference for fuel-aware thrust. */
  setResourceSystem(rs) { this._resourceSystem = rs; }

  /** Set CargoSystem reference for cargo-based fuel consumption. */
  setCargoSystem(cs) { this._cargoSystem = cs; }

  /**
   * Show/hide the diagnostic hull edge-outline (INSPECT view); gated by Constants.INSPECTION.HULL_OUTLINE. Built lazily
   * on the FIRST show (EdgesGeometry over the carved barrel is boot waste for sessions that never open INSPECT), then cached.
   * @param {boolean} visible
   */
  setHullOutlineVisible(visible) {
    const enabled = Constants.INSPECTION?.HULL_OUTLINE !== false;
    const want = !!visible && enabled;
    if (want && !this._hullOutline && this.body) {
      // First show: build from the live (groove-carved) barrel geometry so the outline matches the hull exactly.
      const INS = Constants.INSPECTION || {};
      const outlineEdges = new THREE.EdgesGeometry(
        this.body.geometry, INS.HULL_OUTLINE_THRESHOLD_DEG ?? 20,
      );
      this._hullOutline = new THREE.LineSegments(
        outlineEdges,
        new THREE.LineBasicMaterial({
          color: INS.HULL_OUTLINE_COLOR ?? 0x00ffcc,
          transparent: true,
          opacity: 0.85,
        }),
      );
      this._hullOutline.rotation.x = Math.PI / 2; // match this.body orientation
      this._hullOutline.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      this.add(this._hullOutline);
    }
    if (!this._hullOutline) return;
    this._hullOutline.visible = want;
  }

  /**
   * Run `fn` with the diagnostic hull outline HIDDEN and restore it exactly (the LIBRARY pane's one-shot PART PORTRAIT
   * renders the near set while INSPECT may be showing the seam + rim lines on the barrel skin, a child of this group,
   * so a ship-only render would draw them over the part). Touches only `.visible` (never builds the outline, never
   * re-gates through setHullOutlineVisible's Constants flag); restores in a `finally`, so a throwing `fn` propagates
   * with the outline back. Per click, never per frame.
   * @template T @param {() => T} fn @returns {T}
   */
  withHullOutlineHidden(fn) {
    const o = this._hullOutline;
    const was = !!(o && o.visible);
    if (was) o.visible = false;
    try {
      return fn();
    } finally {
      if (was) o.visible = true;
    }
  }

  /**
   * Set the arm manager reference (interlock and recoil calculations).
   * @param {import('./ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this.armManager = armManager;
  }

  /**
   * Her live wet mass, kg: ArmManager.getMassBudget().shipMassKg = core dry + engine gas + cold gas + docked daughters +
   * cargo aboard + the mother's nets (lighter as gas burns, a net flies or a daughter leaves). Every reader of `ship.mass`
   * (drag, recoils, RCS torque, net tug, lasso, autopilot recoil compensation, cargoThrustFactor) gets it. Without an arm
   * manager, or when the budget throws or is not a positive finite number: Constants.MOTHER_DRAG.MASS_KG (start mass).
   * An explicit override (the setter below) wins while set. No cache: the budget costs 0.0006 ms a call.
   * @returns {number} kg
   */
  get mass() {
    if (this._massOverride != null) return this._massOverride;
    const am = this.armManager;
    if (am && typeof am.getMassBudget === 'function') {
      try {
        const kg = am.getMassBudget().shipMassKg;
        if (Number.isFinite(kg) && kg > 0) return kg;
      } catch (_) { /* a half-built rig: fall back to the start mass */ }
    }
    return Constants.MOTHER_DRAG.MASS_KG;
  }

  /**
   * Explicit mass override: TEST RIGS ONLY (production never writes `mass`). null / undefined / NaN clears it.
   * @param {number|null|undefined} kg
   */
  set mass(kg) {
    this._massOverride = Number.isFinite(kg) ? kg : null;
  }

  /**
   * Her projected area across her velocity NOW (MotherDragArea.motherDragAreaM2): velocity direction in her body frame
   * (the scene velocity turned by her inverse attitude; +Z, nose-first, when not moving), the radiator angle
   * `_flowerThetaRad` (the shared angle: single-petal holds are not followed) and the two ROSA wings, each with its
   * deploy scale (wrapper scale.x) and blanket normal in the body frame, taken from the pivots' real transforms
   * (wrapper -> pivot -> array pivot rotations, never re-derived from an angle). A rig without the wings
   * (Object.create(prototype)) gets the core alone. Allocation-free; the drag block calls it once per frame.
   * @returns {number} m2
   */
  dragAreaM2() {
    const v = this._cartesian && this._cartesian.velocity;
    const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
    if (speed > 1e-10) {
      _dragDir.set(v.x / speed, v.y / speed, v.z / speed);
      _dragDir.applyQuaternion(_dragQInv.copy(this.quaternion).invert());
    } else {
      _dragDir.set(0, 0, 1);
    }
    let nW = 0;
    const array = this._solarArrayPivot;
    for (let i = 0; i < 2; i++) {
      const pivot = i === 0 ? this.panelRightPivot : this.panelLeftPivot;
      const wrapper = i === 0 ? this._rosaPanelWrapper1 : this._rosaPanelWrapper2;
      if (!pivot || !wrapper) continue;
      // the blanket's normal is its wrapper's +Z; carry it up the chain the way the scene graph does
      _dragNrm.set(0, 0, 1).applyQuaternion(wrapper.quaternion).applyQuaternion(pivot.quaternion);
      if (array) _dragNrm.applyQuaternion(array.quaternion);
      const rec = _dragWings[nW++];
      rec.scale = wrapper.scale.x;
      rec.nx = _dragNrm.x; rec.ny = _dragNrm.y; rec.nz = _dragNrm.z;
    }
    return motherDragAreaM2(_dragDir.x, _dragDir.y, _dragDir.z, this._flowerThetaRad, _dragWings, nW);
  }

  /**
   * Her mass without the cargo aboard, kg (>= 1): `mass` minus ArmManager.getCargoMassKg(). The two places that add the
   * cargo on top of her mass themselves (cargoThrustFactor, LeashDriver's rest mass) read this, so it counts once.
   * @returns {number} kg, >= 1
   */
  massExcludingCargoKg() {
    const am = this.armManager;
    let cargo = 0;
    if (am && typeof am.getCargoMassKg === 'function') {
      try { cargo = am.getCargoMassKg(); } catch (_) { cargo = 0; }
    }
    if (!(cargo > 0)) cargo = 0;
    return Math.max(1, this.mass - cargo);
  }

  /**
   * Inject the CaptureNetSystem so the berthed-mass channel (getBerthedMassKg) is reachable: read by computeInertia,
   * ArmManager.getCargoMassKg and _applyThrust's legacy-mock fallback. Deliberately a setter, not an import: CaptureNet
   * imports OrbitalMechanics and Constants, so a direct import would risk a cycle.
   * @param {import('./CaptureNet.js').CaptureNetSystem} cns
   */
  setCaptureNetSystem(cns) {
    this._captureNetSystem = cns;
  }

  /**
   * Reel-in ANGULAR coupling: hauling a heavy catch on a tether attached at the fore muzzle swings the nose toward the
   * catch. LassoSystem already applies the LINEAR CoM pull (`_rcsVelocity`); this adds the attitude tug: the lateral (off
   * fore-axis) component of the tether direction, scaled by the catch/ship mass ratio, drives the yaw/pitch springs (RCS
   * then nulls them). A catch reeled straight down the centreline produces no tug: only OFF-axis loads disturb attitude.
   *
   * @param {THREE.Vector3} worldToCatchDir — unit direction from ship to catch (world)
   * @param {number} massRatio — m_catch / (m_catch + m_ship), 0..1
   * @param {number} dt — seconds
   */
  applyReelTorque(worldToCatchDir, massRatio, dt) {
    if (!Constants.FEATURE_FLAGS.RECOIL_PHYSICS) return;
    if (!worldToCatchDir || !(massRatio > 0)) return;
    this._qInvScratch = this._qInvScratch || new THREE.Quaternion();
    this._vReelScratch = this._vReelScratch || new THREE.Vector3();
    this._qInvScratch.copy(this.quaternion).invert();
    const local = this._vReelScratch.copy(worldToCatchDir).applyQuaternion(this._qInvScratch);
    const GAIN = Constants.LASSO_REEL_TORQUE_GAIN ?? 0.8;
    // Yaw (+Y): nose (+Z) turns toward +X for +θ → tug by +local.x.
    // Pitch (+X): nose (+Z) turns toward −Y for +θ → tug toward +Y by −local.y.
    this._recoilYawVel   += GAIN * massRatio * local.x * dt;
    this._recoilPitchVel += -GAIN * massRatio * local.y * dt;
  }

  /**
   * Reel-push (owner 2026-10-22: "make the reel pull move and turn the mother, like real physics"): a one-off push on
   * the hull, `impulseWorldNs` true N·s in the world frame, at `pointWorld` (scene units). The push is momentum, not a
   * burn: unbilled. What takes it back out is billed: the turn (always) and, under the autopilot HOLD, the Δv (see
   * `flushReelPush`).
   *
   *   • LINEAR: Δv = J / mass (true m/s, her live mass) through `applyCartesianImpulse(.., { noBill, quiet })`: the real
   *     orbit, the way the mother-net tug and the leash change her motion (`_rcsVelocity` is cosmetic and not used).
   *     Pushes under `Constants.REEL_PUSH.MIN_DV_MS` are gathered, one gathering per `opts.source` (a reeling daughter:
   *     two reels at once keep their own), and applied together once they pass it (the orbit element round trip is only
   *     good to ~1e-6 m/s); `opts.flush` applies whatever that source has gathered.
   *   • ANGULAR: L = r × J about her centre of mass (r = point − CoM, `computeCoM`), body frame, divided by the inertia
   *     SSOT (`getAttitudeInertia`): Δω goes into the pitch (about +X) and yaw (about +Y) springs that `applyReelTorque`,
   *     the net recoil and the net tug feed, and her attitude hold takes it back out. Roll (about +Z) has no spring and
   *     is dropped. A push through the CoM turns nothing. The spring's work is paid in cold gas like the net recoil's
   *     turn (`_billTurnNullN2`), with the attitude couple's puffs.
   *
   * @param {THREE.Vector3} impulseWorldNs true N·s, world frame
   * @param {THREE.Vector3} pointWorld scene units, where the push acts on the hull
   * @param {{ flush?: boolean, flushLinear?: boolean, source?: object, angularOnly?: boolean, excludeArm?: object }} [opts]
   *   `source`: whose gathering this is (the ArmUnit); none = a shared one. `flush`: the gathered Δv AND this frame's
   *   angular sum are applied at once. `flushLinear` (the latch bump): only the gathered Δv is applied at once; the
   *   angular kick joins the frame's sum. `angularOnly` (launch-kick): the turn only, no linear Δv (the caller has its
   *   own linear handling). `excludeArm`: the centre of mass is taken without that daughter (she is leaving)
   * @returns {boolean|null} true: the Δv went into her orbit (or was gathered); false: `applyCartesianImpulse` refused it
   *   (the altitude envelope); null: nothing to do (disabled, zero or invalid push)
   */
  applyImpulseAtPoint(impulseWorldNs, pointWorld, opts = {}) {
    const RP = Constants.REEL_PUSH || {};
    if (RP.ENABLED === false || !impulseWorldNs || !pointWorld) return null;
    const src = opts.source || REEL_PUSH_SHARED;
    const jMag = impulseWorldNs.length();
    if (!isFinite(jMag)) return null;
    const flushLin = opts.flush === true || opts.flushLinear === true;
    if (!(jMag > 0)) return flushLin ? this.flushReelPush(src) : null;               // nothing new, but the gathered Δv still goes
    const mass = (this.mass > 0) ? this.mass : 130;

    // ANGULAR: L = r x J about the centre of mass, body frame (before the linear call: it emits events)
    const qInv = (this._qPushInv || (this._qPushInv = new THREE.Quaternion())).copy(this.quaternion).invert();
    const jLoc = (this._vPushJ || (this._vPushJ = new THREE.Vector3())).copy(impulseWorldNs).applyQuaternion(qInv);
    const r = (this._vPushR || (this._vPushR = new THREE.Vector3()));
    r.copy(pointWorld).sub(this.position).applyQuaternion(qInv).multiplyScalar(1 / M);   // metres, body frame
    const am = this.armManager;
    if (am && am.arms) {
      const com = computeCoM(am, this, opts.excludeArm ? { excludeArm: opts.excludeArm } : undefined).position;
      r.x -= com.x; r.y -= com.y; r.z -= com.z;
    }
    const lx = r.y * jLoc.z - r.z * jLoc.y;                                              // N·m·s
    const ly = r.z * jLoc.x - r.x * jLoc.z;
    if (lx !== 0 || ly !== 0) {
      const I = this.getAttitudeInertia();
      this._recoilPitchVel += lx / I.ixx;                                                // rad/s, true
      this._recoilYawVel += ly / I.iyy;
      // The spring takes this turn back out, which costs cold gas (the net recoil's price list) with the couple's puffs
      // (a push through the CoM leaves float noise ~1e-17 N·m·s here: it turns and bills nothing). The kick goes into this
      // frame's sum; the wheels and the gas see the SUM once, in `_flushKicks` (end of frame, `postArmUpdate`), or at
      // once with `opts.flush` (the tests that read the bill right after).
      this._kickLx += lx;
      this._kickLy += ly;
      if (opts.flush === true) this._flushKicks();
    }

    if (opts.angularOnly === true) return true;                                          // launch-kick: the linear part is the caller's

    // LINEAR: gather (per source), then one clean orbit impulse
    const acc = this._reelPushAcc(src, true);
    acc.addScaledVector(impulseWorldNs, 1 / mass);
    if (!flushLin && acc.length() < (RP.MIN_DV_MS ?? 1e-4)) return true;
    return this.flushReelPush(src);
  }

  /**
   * @private Hand this frame's summed angular kick to the wheels and the gas, once. The wheels take it first, with its
   * sign (`_wheelAbsorbKick`); only what does not fit is gas, at the real price (`_billTurnNullN2`), with the couple's
   * puffs. No kit, or a kit without power: the whole turn is gas. Under 1e-6 N·m·s (float noise, a push through the
   * centre of mass, or two kicks that cancelled) nothing is taken and nothing is billed.
   */
  _flushKicks() {
    let lx = this._kickLx, ly = this._kickLy;
    this._kickLx = 0;
    this._kickLy = 0;
    if (!(Math.abs(lx) + Math.abs(ly) > 1e-6)) return;
    const o = this._wheelAbsorbKick(lx, ly);
    if (o) { lx = o.x; ly = o.y; }
    if (Math.abs(lx) + Math.abs(ly) > 1e-6) {
      this._reelPushTurnKg += this._billTurnNullN2(lx, ly);
      this._reelPushTurnPuff(lx, ly);
    }
  }

  /** @private reel-push: `source`'s gathered-Δv vector (m/s, world), made on demand when `create`; else null when it has none. */
  _reelPushAcc(source, create = false) {
    let accs = this._reelPushAccs;
    if (!accs) { if (!create) return null; accs = this._reelPushAccs = new Map(); }
    let acc = accs.get(source);
    if (!acc && create) { acc = new THREE.Vector3(); accs.set(source, acc); }
    return acc || null;
  }

  /**
   * Reel-push: hand `source`'s gathered Δv to her real orbit in one quiet call (null when there is none). While the
   * autopilot HOLD copies the locked target's orbit into hers every frame (`_reelPushHoldErases`), that copy wipes the Δv
   * again: a station-keeping burn on her cold-gas thrusters, not a free pass, so the call is billed
   * m = M x Δv / (Isp x g0) of coldGas, with a burst of puffs on the side that pushes against the line.
   * @param {object} [source] whose gathering (default: the shared one)
   * @returns {boolean|null} what `applyCartesianImpulse` said (true applied, false refused), null: nothing was gathered
   */
  flushReelPush(source) {
    const key = source || REEL_PUSH_SHARED;
    const acc = this._reelPushAcc(key);
    if (!acc) return null;
    this._reelPushAccs.delete(key);
    if (!(acc.length() > 1e-9)) return null;                               // below applyCartesianImpulse's own floor
    const dv = (this._vPushDv || (this._vPushDv = new THREE.Vector3())).copy(acc);
    const res = this.applyCartesianImpulse(dv, 0, { noBill: true, quiet: true });
    if (res === true && this._reelPushHoldErases()) this._reelPushHoldBurn(dv);
    return res;
  }

  /** reel-push: drop `source`'s gathered sub-threshold Δv (no source: every gathering, a reset or a load). */
  clearReelPush(source) {
    if (!this._reelPushAccs) return;
    if (source === undefined) this._reelPushAccs.clear();
    else this._reelPushAccs.delete(source);
  }

  /**
   * A reset leaves nothing of the reel push behind: every gathering (the shared one too) and the turn it kicked into her
   * attitude springs (rates and angles) go. Called by GameFlowManager's `resetGame` (new game, retry, menu, load) and its
   * GAMEOVER_CONTINUE handler; NOT at a mission start, which fires mid-play and would wipe other daughters' gathered
   * pushes. `_reelPushTurnKg` is a diagnostic tally (read by tests only) and stays.
   */
  clearReelPushState() {
    this.clearReelPush();
    this._kickLx = 0;
    this._kickLy = 0;
    this._recoilPitchVel = 0;
    this._recoilYawVel = 0;
    this._recoilPitchAngle = 0;
    this._recoilYawAngle = 0;
  }

  /** reel-push: the Δv `source` (none: all) has gathered and not yet handed to her orbit, a fresh vector, m/s world. */
  getReelPushGathered(source) {
    const out = new THREE.Vector3();
    const accs = this._reelPushAccs;
    if (!accs) return out;
    if (source !== undefined) return out.copy(accs.get(source) || out);
    for (const a of accs.values()) out.add(a);
    return out;
  }

  /**
   * @private Reel-push: a reel that ended any way but the latch (the line snapped, a recall, a state change, a reset or a
   * load) leaves its gathered Δv behind: apply it. Runs each frame after the arms (`postArmUpdate`); cheap, the map is
   * empty outside a reel. A source is still reeling while it is in the ArmManager's list, REELING and not cut loose.
   */
  _reelPushSweep() {
    const accs = this._reelPushAccs;
    if (!accs || accs.size === 0) return;
    const arms = this.armManager && this.armManager.arms;
    for (const src of accs.keys()) {
      if (src === REEL_PUSH_SHARED) continue;
      const live = src.state === ARM_STATES.REELING && !src.isDetached && !!arms && arms.includes(src);
      if (!live) this.flushReelPush(src);
    }
  }

  /**
   * @private Read-only question to the autopilot: is its HOLD copying the locked target's orbit into hers every frame
   * (AutopilotSystem `PHASE.HOLD`: a, e, i, Ω, ω and the mean motion; "models active station-keeping")? Then the push's
   * Δv is wiped the next frame. Not in HOLD, no lock with an orbit, or an onboarding-pinned target (it follows her
   * instead of the other way round): the Δv stays in her orbit as real drift.
   */
  _reelPushHoldErases() {
    const ap = this.armManager && this.armManager._autopilot;
    if (!ap || ap.engaged !== true || typeof ap.getCurrentPhase !== 'function' || ap.getCurrentPhase() !== 'HOLD') return false;
    const t = ap._lockedTargetRef;
    return !!(t && t.orbit && !t._onboardingPinned);
  }

  /**
   * @private The HOLD burns to cancel `dvWorld` (what the line just gave her): bill the gas and puff.
   * m = M x |Δv| / (Isp x g0), what is left in the tank at most (a short tank is drained, like the other burn bills).
   */
  _reelPushHoldBurn(dvWorld) {
    const RP = Constants.REEL_PUSH || {};
    const mass = (this.mass > 0) ? this.mass : 130;
    let kg = mass * dvWorld.length() / ((RP.HOLD_ISP_S ?? 60) * Constants.G0);
    const tank = Number(this.resources && this.resources.coldGas);
    if (Number.isFinite(tank)) kg = Math.min(kg, coldGasPoolToKg(Math.max(0, tank)));   // the tank is POOL units, the burn is kg
    // A cold-gas turn that is spinning keeps the gas to stop; the burn takes what is left above it and no more (the
    // station-keeping Δv itself is wiped by the HOLD's orbit copy whether or not it is paid: only the bill is the burn's)
    const pool = this._nonTurnPoolBudget(coldGasKgToPool(kg));
    kg = coldGasPoolToKg(pool);
    if (pool > 0) {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'coldGas', amount: pool });
      this._reelPushHoldKg += kg;
    }
    // The burn pushes AGAINST the line: thrust along -dv; the puff sprites sit at the nozzle that opposes this thrust,
    // like every other burn puff
    const now = performance.now() * 0.001;
    if (now - this._reelPushPuffAt < (RP.PUFF_EVERY_S ?? 0.3)) return;
    this._reelPushPuffAt = now;
    const qInv = (this._qPushInv || (this._qPushInv = new THREE.Quaternion())).copy(this.quaternion).invert();
    const dir = (this._vPushPuff || (this._vPushPuff = new THREE.Vector3())).copy(dvWorld).negate().applyQuaternion(qInv).normalize();
    this._fireRcsPuff(dir);
  }

  /** @private The attitude couple that takes the turn `(lx, ly)` N·m·s back out puffs, at most every PUFF_EVERY_S. */
  _reelPushTurnPuff(lx, ly) {
    const RP = Constants.REEL_PUSH || {};
    const now = performance.now() * 0.001;
    if (now - this._reelPushTurnPuffAt < (RP.PUFF_EVERY_S ?? 0.3)) return;
    this._reelPushTurnPuffAt = now;
    const big = Math.max(Math.abs(lx), Math.abs(ly));
    if (Math.abs(lx) >= 0.25 * big) this.fireRcsStopPulse('pitch', lx > 0 ? 1 : -1);   // the OPPOSITE couple nulls the rate
    if (Math.abs(ly) >= 0.25 * big) this.fireRcsStopPulse('yaw', ly > 0 ? 1 : -1);
  }

  /**
   * Reel-push: a force `forceWorldN` (true N, world) acting on the hull at `pointWorld` for `dtGame` game seconds.
   * J = F x dt_game (the reel runs on real dt, the game clock `TIME_SCALE_GAMEPLAY` x faster: the caller converts), then
   * as `applyImpulseAtPoint` (same return value).
   * @param {number} dtGame game seconds
   * @param {{ flush?: boolean, source?: object }} [opts]
   */
  applyForceAtPoint(forceWorldN, pointWorld, dtGame, opts = {}) {
    if (!forceWorldN || !(dtGame > 0)) return null;
    const j = (this._vPushF || (this._vPushF = new THREE.Vector3())).copy(forceWorldN).multiplyScalar(dtGame);
    return this.applyImpulseAtPoint(j, pointWorld, opts);
  }

  /**
   * Apply REAL recoil from a Mother whale-net launch (Newton's 3rd law), r_muzzle × F_recoil about the CoM:
   *   • linear recoil  Δv = m_net·v_launch / m_mother  (along −fore)
   *   • angular recoil τ = r_muzzle × F_recoil — pitch −J·y about +X and yaw +J·x about +Y.
   * Owner 2026-10-13: ONE launcher, centred. The muzzle is at x = y = 0 on the centre-of-mass axis, so both lever arms are
   * zero: a Mother net shot gives NO yaw and NO pitch and bills no N₂ for stopping a turn. The lever-arm form is kept, so
   * a muzzle ever moved off the axis is kicked and billed again (as real couple gas, `_billTurnNullN2`).
   * The linear part is auto-nulled by RCS at a cold-gas N₂ cost (the crossbow pattern).
   *
   * @param {{ podIndex?: number }} data — NET_FIRED payload (source: 'mother')
   * @private
   */
  _applyMotherNetRecoil(data) {
    const LARGE = Constants.CAPTURE_NET?.LARGE;
    if (!LARGE) return;
    const netMass = LARGE.MASS || 1.95;            // kg (net + hub)
    const vLaunch = LARGE.LAUNCH_SPEED || 10.0;    // m/s
    const motherMass = this.mass || 130;           // kg
    const podIndex = data?.podIndex ?? 0;

    // Linear recoil: p = m_net·v / m_mother, backward along the fore axis (net departs +Z fore → hull recoils −Z). Same
    // RECOIL_SCALE + RCS auto-null as the crossbow so the two read consistently.
    const RECOIL_SCALE = 0.1;
    const recoilSpeed = (netMass * vLaunch) / motherMass;   // m/s
    const recoilDv = recoilSpeed * M * RECOIL_SCALE;        // scene units/s
    const backward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(backward);
    this._autoRcsCompensation(recoilDv);
    this._frameRecoilDv = 0;               // one-shot; not part of dual-fire tracking
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;

    // Angular recoil: J = m_net·v (N·s) acts along −fore at the muzzle; inertia from the honest one-frame _attitudeMOI.
    // The one centred launcher has x = y = 0, so both impulses are exactly 0 and the N₂ bill below never runs.
    const podMuzzle = this._netPodMuzzles && this._netPodMuzzles[podIndex];
    const muzzleLocalX = podMuzzle ? podMuzzle.position.x : 0;
    const muzzleLocalY = podMuzzle ? podMuzzle.position.y : 0;
    const impulse = netMass * vLaunch;                       // N·s
    const pitchImpulse = -impulse * (muzzleLocalY / M);      // N·m·s about +X
    const yawImpulse = impulse * (muzzleLocalX / M);         // N·m·s about +Y
    if (pitchImpulse !== 0) {
      this._recoilPitchVel += pitchImpulse / this._attitudeMOI('x');   // rad/s
    }
    if (yawImpulse !== 0) {
      this._recoilYawVel += yawImpulse / this._attitudeMOI('y');       // rad/s
    }

    // N₂ honesty: bill the angular null too, if there is one. The attitude-hold spring always runs (unlike the
    // player-toggleable linear compensation), so its cost always accrues: the real cold gas her attitude couple burns to
    // make that torque (`_billTurnNullN2`, shared with the reel push's turn). Zero for the centred launcher.
    this._billTurnNullN2(pitchImpulse, yawImpulse);

    // The cosmetic hull kick is LassoSystem's _recoilOffset.
  }

  /**
   * Cold-gas bill for nulling a turn kick, priced as the gas her attitude couple really burns (DECISIONS §35 row 6). Per
   * axis, making an angular impulse L takes the couple (two nozzles of `NOZZLE_THRUST_N`, torque τ) L/τ seconds of
   * burning at 2F of thrust, so
   *   kg = |L| x 2F / (τ x Isp x g0)       (Isp = `REEL_PUSH.HOLD_ISP_S`, her cold-gas thrusters),
   * summed over pitch and yaw; τ is the live couple torque the attitude controller uses (`_coupleTauMag`), about 61.8 N·m
   * pitch and 59.0 yaw on the flower ship, so about 2.2 g per N·m·s. The mass is not in it: the inertia is already in L.
   * The one price list for the net recoil's off-axis turn and the reel push's turn. Without couple nozzles the 0.772 m
   * effective arm measured on the flower ship stands in. Emits RESOURCE_CONSUME coldGas.
   * @param {number} lPitchNms N·m·s about +X (sign ignored)
   * @param {number} lYawNms N·m·s about +Y (sign ignored)
   * @returns {number} kg of gas billed (0 when there is nothing to null)
   * @private
   */
  _billTurnNullN2(lPitchNms, lYawNms) {
    const kg = this.turnNullKg(lPitchNms, lYawNms);
    if (!(kg > 0)) return 0;
    eventBus.emit(Events.RESOURCE_CONSUME, {
      resource: 'coldGas',
      amount: coldGasKgToPool(kg),     // the pool is not kg (20 units = 6 kg)
    });
    return kg;
  }

  /**
   * The price list of `_billTurnNullN2` as a read: kg of cold gas to make or null a turn kick `(lPitchNms, lYawNms)`
   * (nothing is billed or emitted). The shot chooser prices a launch's kick with it before the launch.
   * @param {number} lPitchNms N·m·s about +X (sign ignored) @param {number} lYawNms N·m·s about +Y (sign ignored)
   * @returns {number} kg
   */
  turnNullKg(lPitchNms, lYawNms) {
    const twoF = 2 * (Constants.ATTITUDE?.NOZZLE_THRUST_N ?? 25.0);
    const fallbackTau = twoF * 0.772;                                    // N·m: 2F x the effective arm measured on the flower ship
    const isp = Constants.REEL_PUSH?.HOLD_ISP_S ?? 60;
    const perNms = (axis) => {
      const tau = this._coupleTauMag(axis);
      return twoF / ((tau > 1e-3 ? tau : fallbackTau) * isp * Constants.G0);   // kg per N·m·s
    };
    const lp = Math.abs(lPitchNms), ly = Math.abs(lYawNms);
    return (lp > 0 ? lp * perNms('x') : 0) + (ly > 0 ? ly * perNms('y') : 0);
  }

  /**
   * Steering-gas reserve (DECISIONS §37 "always keep gas to stop"): the gas (POOL units) a bill that is NOT a turn must
   * leave in the tank while a cold-gas turn is spinning: STOP_RESERVE x the gas the stop of her live spin will bill
   * (`slothStopGasPool`). 0 when no cold-gas spin is running.
   * @returns {number} pool units
   * @private
   */
  _stopReservePool() {
    if (this._gasSpin !== true) return 0;
    return (Constants.SLOTH.STOP_RESERVE ?? 1) * this.slothStopGasPool();
  }

  /**
   * How much of `wantPool` (pool units) a non-turn bill may take: what the tank holds above the stop reserve, never more
   * than it wants. With no spin running (no reserve) the bill is whole.
   * @returns {number} pool units, 0..wantPool
   * @private
   */
  _nonTurnPoolBudget(wantPool) {
    const reserve = this._stopReservePool();
    if (!(reserve > 0)) return wantPool;
    const tank = Number(this.resources && this.resources.coldGas);
    if (!Number.isFinite(tank)) return wantPool;
    return clamp(tank - reserve, 0, wantPool);
  }

  /**
   * Recoil momentum from crossbow arm firing (Newton's 3rd law): p_recoil = m_arm × v_launch / m_mother.
   * Single Weaver at 10 m/s: 6.6 × 10 / 130 = 0.508 m/s recoil; single Spinner: 2.1 × 10 / 130 = 0.162 m/s.
   * @param {object} data - { armIndex, armMass, speed }
   * @private
   */
  _applyCrossbowRecoil(data) {
    if (!data) return;                               // a bare event (tests, old emitters) has nothing to recoil from
    const { armMass, speed } = data;
    const motherMass = this.mass || 130; // kg
    const recoilSpeed = (armMass * speed) / motherMass;

    // Scene units/s, scaled to 10% of theoretical: a subtle nudge, not disorienting for new players (real ADR sats
    // absorb most recoil with internal momentum management).
    const RECOIL_SCALE = 0.1;
    const recoilDv = recoilSpeed * M * RECOIL_SCALE;

    // Recoil opposite to the arm launch direction, approximated as backward along the ship's heading (-Z local)
    const backward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(backward);

    // Cumulative recoil for this frame: DUAL_FIRE_RECOIL may supersede these individual impulses (opposing arms cancel).
    this._frameRecoilDv += recoilDv;
    this._frameRecoilCount++;

    // Launch kick (owner 10-24 "1 a", DECISIONS §37 row 9): the push also TURNS her. The daughter leaves with J = m x v
    // along the launch direction; the mother takes -J at the strut tip, so L = r x (-J) about her centre of mass WITHOUT
    // the departing daughter. Full physical size (the 0.1 scale above is the linear nudge's only), through the reel
    // push's angular path: the wheels take it first, the rest is gas at the real price. A payload without
    // `launchPosition` (an old emitter, a bare event) skips the turn.
    this._applyLaunchKickTurn(data);

    // Auto-compensate with RCS if enabled. For dual-fire each compensation still applies but the net velocity change is
    // zero (backward + forward cancel); the N₂ is refunded when DUAL_FIRE_RECOIL arrives with cancelled=true.
    this._autoRcsCompensation(recoilDv);
  }

  /**
   * The turn a daughter's launch gives the mother (called from `_applyCrossbowRecoil`). Angular only: no second linear
   * push. True N·s (mass x true m/s), world frame, at the strut tip the daughter lets go from.
   * @param {{ armIndex?: number, speed?: number, armMass?: number, launchMassKg?: number, launchDirection?: THREE.Vector3,
   *   launchPosition?: THREE.Vector3 }} data the CROSSBOW_FIRE payload
   * @private
   */
  _applyLaunchKickTurn(data) {
    const dir = data && data.launchDirection, at = data && data.launchPosition;
    if (!dir || !at || !(data.speed > 0)) return;
    const m = data.launchMassKg > 0 ? data.launchMassKg : data.armMass;
    if (!(m > 0)) return;
    const J = (this._vLaunchKickJ || (this._vLaunchKickJ = new THREE.Vector3())).copy(dir).multiplyScalar(-m * data.speed);   // on the MOTHER
    const arms = this.armManager && this.armManager.arms;
    const arm = arms && Number.isInteger(data.armIndex) ? arms[data.armIndex] : undefined;
    this.applyImpulseAtPoint(J, at, { angularOnly: true, excludeArm: arm, source: this });
  }

  /**
   * Automatic RCS compensation after crossbow recoil, paid in cold-gas N₂ (3.7 g per Weaver single-fire).
   * @param {number} recoilDv - Scene-scale ΔV to compensate
   * @private
   */
  _autoRcsCompensation(recoilDv) {
    if (!this._crossbowAutoRcs) return;

    // N₂ needed: proportional to ΔV relative to the Weaver baseline
    const baseRecoilDv = DUALFIRE_RECOIL_WEAVER * M;
    const n2Grams = DUALFIRE_RCS_COMPENSATION_N2 * (recoilDv / baseRecoilDv);

    const n2Kg = n2Grams / 1000;
    // The pool is not kg (20 units = 6 kg). A cold-gas turn that is spinning keeps the gas to stop, so the burn takes
    // what is left above that and corrects only that share of the recoil (the rest stays as drift).
    const wantPool = coldGasKgToPool(n2Kg);
    const pool = this._nonTurnPoolBudget(wantPool);
    const share = wantPool > 0 ? pool / wantPool : 1;
    eventBus.emit(Events.RESOURCE_CONSUME, {
      resource: 'coldGas',
      amount: pool,
    });

    // Actual N₂ consumed (kg), for the dual-fire refund
    this._frameN2Consumed += coldGasPoolToKg(pool);

    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv * share);
    this._rcsVelocity.add(forward);

    this._triggerRcsPuff('compensation');
  }

  /**
   * Handle the dual-fire recoil result: cancelled → no compensation needed (opposing arms cancelled momentum); residual
   * → small RCS correction only.
   * @param {object} data - { cancelled: boolean, residualDv: number }
   * @private
   */
  _applyDualFireRecoil(data) {
    if (data.cancelled) {
      // Momentum fully cancelled by opposing arms: each arm's autoRcsCompensation already cancelled the velocity, so only
      // the cold gas the individual CROSSBOW_FIRE handlers consumed (2 arms × compensation) is refunded.
      if (this._crossbowAutoRcs && this._frameN2Consumed > 0) {
        eventBus.emit(Events.RESOURCE_REPLENISH, {
          resource: 'coldGas',
          amount: coldGasKgToPool(this._frameN2Consumed),   // kg back to pool units, the way it was billed
        });
      }
      this._frameRecoilDv = 0;
      this._frameRecoilCount = 0;
      this._frameN2Consumed = 0;
      return;
    }

    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
    const residualDv = data.residualDv * M;
    this._autoRcsCompensation(residualDv);
  }

  /**
   * Integrate the mother-net recoil pitch and let RCS attitude-hold spring it back to zero. Models the muzzle-lever-arm
   * kick as a critically-damped 2nd order system (ζ≈1): the launch injects angular velocity (`_recoilPitchVel`), RCS
   * applies a restoring torque proportional to the pitch error and a damping torque proportional to the rate, so the
   * hull kicks then recovers to neutral in ~2 s. The propellant cost is billed at fire time (via _autoRcsCompensation
   * for the linear part); this method is the visible attitude transient. No-op once both settle. @private
   * @param {number} dt seconds
   */
  _tickRecoilAttitude(dt) {
    const settling = this._recoilPitchVel !== 0 || this._recoilPitchAngle !== 0
      || this._recoilYawVel !== 0 || this._recoilYawAngle !== 0;
    if (!settling) return;
    // Natural frequency ω (rad/s) for a ~2 s settle; ζ=1 → c=2ω, k=ω².
    const OMEGA = Math.PI;
    const k = OMEGA * OMEGA;
    const c = 2 * OMEGA;
    // Substep: semi-implicit Euler for this spring is only stable for h < 2/ω ≈ 0.64 s. On slow machines / software GL
    // (SwiftShader capture harness) render dt reaches 0.4–1 s and the integration diverges exponentially (measured
    // _recoilPitchVel ≈ −2.3e150, ×100/frame). Cap the step at 0.05 s (12× margin); the designed kick and settle are
    // unchanged at 60 fps.
    const steps = Math.max(1, Math.ceil(dt / 0.05));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._recoilPitchVel += (-k * this._recoilPitchAngle - c * this._recoilPitchVel) * h;
      this._recoilPitchAngle += this._recoilPitchVel * h;
      this._recoilYawVel += (-k * this._recoilYawAngle - c * this._recoilYawVel) * h;
      this._recoilYawAngle += this._recoilYawVel * h;
    }
    // Settle to exact zero once negligible (avoids perpetual tiny residuals).
    if (Math.abs(this._recoilPitchVel) < 1e-5 && Math.abs(this._recoilPitchAngle) < 1e-5) {
      this._recoilPitchVel = 0; this._recoilPitchAngle = 0;
    }
    if (Math.abs(this._recoilYawVel) < 1e-5 && Math.abs(this._recoilYawAngle) < 1e-5) {
      this._recoilYawVel = 0; this._recoilYawAngle = 0;
    }
  }

  /** @private Fire a visual RCS puff for compensation feedback. */
  _triggerRcsPuff(type) {
    this._fireRcsPuff({ x: 0, y: 0, z: 0.5 });
  }

  /**
   * Back-arm (index 7) thrust inhibit plus the Config G plume interlock. §13 Thruster Safety: Hall/MPD exhaust endangers
   * the arm at retrograde dock. @private
   */
  _updateThrusterInterlock() {
    // Pose-band guard (bookkeeping, not physics): thrust only for θ ∈ [POSE_FLOOR_DEG, POSE_THRUST_MAX_DEG] = [0°, 146°]
    // (DECISIONS §15 row 4): never while the launch lock holds the flower fore of the rim, during its release swing, or the
    // SAFETY OVERRIDE sweep (owner 2026-09-09: the lock is armed when a fold is commanded, so FEEP is inhibited from the
    // press). Plume-legal at every θ; the guard keeps the ledger's "under thrust" clause true. Honoured without an ArmManager.
    const flowerGuard = this._flowerPoseBandGuard();
    if (!this.armManager) {
      this._thrusterInterlock = flowerGuard;
      return;
    }

    const backArm = this.armManager.arms[7];
    if (backArm) {
      const dangerStates = [
        ARM_STATES.LAUNCHING,
        ARM_STATES.DOCKING,
        ARM_STATES.REELING,
      ];
      this._thrusterInterlock = dangerStates.includes(backArm.state);
    } else {
      this._thrusterInterlock = false;
    }
    if (flowerGuard) this._thrusterInterlock = true;
  }

  /**
   * @private True when the installed flower is outside the thrust band or the one-shot launch lock is armed. No hardware, or
   * boot (θ = CLOSED 0° = the floor, lock off) → false: DECISIONS §15 row 4, the engines work with the radiator folded because
   * every θ from CLOSED to the bud sits outside the FEEP plume cones (measured: ≥ 0.325 m to the 35° cones; 0.265 m at the bud).
   */
  _flowerPoseBandGuard() {
    if (this._flowerGroups.length === 0) return false;
    if (this._flowerLaunchLock) return true;
    const FL = Constants.THERMAL.FLOWER;
    // the band is about the whole ring: the most restrictive petal (any petal outside it refuses thrust)
    const r = this._petalRangeInto(this._petalRange || (this._petalRange = { min: 0, max: 0, minTarget: 0 }));
    return radToDeg(r.min) < FL.POSE_FLOOR_DEG - 1e-6 || radToDeg(r.max) > FL.POSE_THRUST_MAX_DEG + 1e-6;
  }

  /** The one line a refused Hall burn says while a daughter's catch is lowered for the net (once per duck). @private */
  _warnNetDuckThrust(am, index) {
    const a = am.arms[index];
    if (!a || a._netDuckThrustSaid) return;
    a._netDuckThrustSaid = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `The thrusters wait: Daughter ${index + 1}'s catch is lowered for the net.`,
      priority: 'warning',
    });
  }

  /**
   * @private Say WHY the drive does not answer when the aft radiator is the reason (pose-band guard). Called by every
   * refused thrust path (applyCartesianImpulse) AFTER the interlock has refused, so it only narrates. ABOVE the band with
   * the lock off it also starts the swing back to OPEN_DEG 146° (DECISIONS §15, "swing to 146°, then fire"; this burn stays
   * refused). Else one COMMS caution per 3 s naming type, live θ and the way out, plus PLAYER_THRUST_FAILED.
   * @param {'FEEP'|'MPD'} type
   */
  _warnFlowerThrustInhibit(type) {
    if (!this._flowerPoseBandGuard()) return;
    const FL = Constants.THERMAL.FLOWER;
    // DECISIONS §15 (owner 2026-10-09): "180 is allowed but dumb when ion thrusters are on": the engine commands the radiator
    // home (swing to OPEN_DEG, then fire). Every refused caller counts as thrust commanded (autopilot, dodge, recoil), so this
    // runs before the dance gate and the 3 s throttle. `swinging` is true only for the call that starts the swing.
    const aboveBand = !this._flowerLaunchLock
      && radToDeg(this._flowerThetaRad) > FL.POSE_THRUST_MAX_DEG + 1e-6;
    const swinging = aboveBand && commandFlowerHome(this);
    if (swinging && !this._danceDrivesMe()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'THERMAL',
        text: `Radiator swinging back to ${FL.OPEN_DEG}°.`,
        priority: 'warning',
      });
    }
    // Opening dance: the unfold is wordless and any input fast-forwards it: no caution line (the refusal stands).
    if (this._danceDrivesMe()) return;
    const now = performance.now();
    if (now - this._lastFlowerInhibitWarning < 3000) return;
    this._lastFlowerInhibitWarning = now;
    const thetaDeg = Math.round(radToDeg(this._flowerThetaRad));
    // The swing line already said why; only a refusal while the radiator is ALREADY on its way in needs its own line.
    if (!swinging) {
      const why = this._flowerLaunchLock
        ? `aft radiator folded for launch (θ ${thetaDeg}°, lock armed)`
        : aboveBand
          ? (radiatorSweepBlocked(this)
            ? `aft radiator at ${thetaDeg}° — a held catch is in its way, so it will not swing back to ${FL.OPEN_DEG}°. Tap O to fold it, or raise that daughter's strut`
            : `aft radiator at ${thetaDeg}° is still swinging into the ${FL.POSE_FLOOR_DEG}–${FL.POSE_THRUST_MAX_DEG}° thrust band`)
          : `aft radiator outside the ${FL.POSE_FLOOR_DEG}–${FL.POSE_THRUST_MAX_DEG}° thrust band (θ ${thetaDeg}°)`;
      const fix = aboveBand ? '' : ' Deploy the radiator (O / RADIATORS) to thrust.';
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'THERMAL',
        text: `CAUTION: ${type} INHIBITED — ${why}.${fix}`,
        priority: 'warning',
      });
    }
    eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'flower_folded', type: type === 'MPD' ? 'mpd' : 'ion', thetaDeg });
  }

  /**
   * §16 Attitude Management: recoil torque is dangerous if ω is too high.
   * @returns {boolean} true if safe, false if ω too high (HUD shows "STABILIZE")
   */
  isCrossbowFireSafe() {
    const maxOmega = 0.1; // rad/s
    if (this.angularVelocity) {
      const omega = typeof this.angularVelocity === 'number'
        ? Math.abs(this.angularVelocity)
        : this.angularVelocity.length();
      return omega < maxOmega;
    }
    return true; // No angular velocity tracking — assume safe
  }

  toggleCrossbowAutoRcs() {
    this._crossbowAutoRcs = !this._crossbowAutoRcs;
    return this._crossbowAutoRcs;
  }

  resetCrossbowState() {
    this._thrusterInterlock = false;
    this._attitudeInertia = null;
    this._crossbowAutoRcs = true;
    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
  }

  /** @returns {boolean} Whether thruster interlock is active (back arm blocking exhaust) */
  get thrusterInterlocked() { return this._thrusterInterlock; }

  get crossbowAutoRcs() { return this._crossbowAutoRcs; }

  /**
   * Attitude-dynamics inertia SSOT: {ixx, iyy, izz} kg·m² about her true centre of mass (radiators counted), lazily computed
   * and cached. Cleared by an arm state-change / berth event or a cargo-ledger direct invalidation (lasso adoption, collar
   * digestion, [K] jettison from BERTHED/COLLARED, the rack's stay-parked feed-end, ArmManager.reset()), and when the cache
   * key changes (fold angle, petal holds, pairs owned), i.e. every frame the radiators swing.
   * @returns {{ ixx:number, iyy:number, izz:number }}
   */
  getAttitudeInertia() {
    // Radiators are structure and nothing emits an event for the fold angle (written in ~10 places): keyed on the shared
    // angle, every petal hold angle and the pairs owned. A cache set from outside (a test) with no key yet counts as current.
    if (this._attitudeInertia && !this._radiatorKeyMatches()) {
      if (this._radiatorKey === null) this._storeRadiatorKey();
      else this._attitudeInertia = null;
    }
    // Struts are structure too (nothing emits an event for a strut angle): keyed on the angles. Measured: deploying them took
    // a fresh inertia from 119.6 / 118.0 / 45.9 to 145.3 / 119.7 / 85.0 kg m2 while the cache stayed at 119.6.
    if (this._attitudeInertia && !this._strutKeyMatches()) {
      if (this._strutKey === null) this._storeStrutKey();
      else this._attitudeInertia = null;
    }
    // The wheel kit is structure too: installing it drops the cache itself; this catches a flag set from outside.
    if (this._attitudeInertia && this._inertiaKit !== this._wheelKit) this._attitudeInertia = null;
    if (!this._attitudeInertia) {
      this._attitudeInertia = computeInertia(this.armManager, this);
      this._storeRadiatorKey();
      this._storeStrutKey();
      this._inertiaKit = this._wheelKit;
    }
    return this._attitudeInertia;
  }

  /**
   * What-if inertia: the radiators at other angles, everything else as it is now (the hand-off's early gas check prices a
   * turn that runs after a petal has folded). Cache and key untouched. Bags latched on the tips ride their live petal angles.
   * @param {number} [over.flowerThetaRad] the shared angle (default: the live one)
   * @param {Array<{azDeg:number, thetaRad:number}>} [over.petals] petals at their own angle (the rest: live hold or shared)
   * @returns {{ ixx:number, iyy:number, izz:number }}
   */
  attitudeInertiaAt(over = {}) {
    const view = Object.create(this);
    view.radiatorBookings = () => this.radiatorBookings(over);
    return computeInertia(this.armManager, view);
  }

  /** Pairs owned as a bit mask (A = 1, B = 2). */
  _radiatorPairBits() {
    const fp = this._flowerPairs;
    return fp ? (fp.A ? 1 : 0) | (fp.B ? 2 : 0) : 0;
  }

  /** @private Inertia cache key: what the radiators' inertia depends on, as a flat number list. No radiators → angles are moot. */
  _radiatorKeyMatches() {
    const key = this._radiatorKey;
    if (key === null || key === undefined) return false;
    const bits = this._radiatorPairBits();
    if (key[0] !== bits) return false;
    if (bits === 0) return true;
    if (key[1] !== this._flowerThetaRad) return false;
    const holds = this._petalHolds || EMPTY_HOLDS;
    if (key.length !== 2 + 2 * holds.length) return false;
    for (let i = 0; i < holds.length; i++) {
      if (key[2 + 2 * i] !== holds[i].az || key[3 + 2 * i] !== holds[i].thetaRad) return false;
    }
    return true;
  }

  /** @private The struts' angles the inertia cache was computed from (a flat number list); null = none recorded yet. */
  _strutKeyMatches() {
    const key = this._strutKey;
    if (key === null || key === undefined) return false;
    const arms = (this.armManager && this.armManager.arms) || EMPTY_HOLDS;
    if (key.length !== arms.length) return false;
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      if (key[i] !== (a ? (typeof a.getAimAlpha === 'function' ? a.getAimAlpha() : (a._aimAlpha || 0)) : 0)) return false;
    }
    return true;
  }

  _storeStrutKey() {
    const arms = (this.armManager && this.armManager.arms) || EMPTY_HOLDS;
    const key = this._strutKey && this._strutKey.length === arms.length ? this._strutKey : new Array(arms.length);
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      key[i] = a ? (typeof a.getAimAlpha === 'function' ? a.getAimAlpha() : (a._aimAlpha || 0)) : 0;
    }
    this._strutKey = key;
  }

  _storeRadiatorKey() {
    const bits = this._radiatorPairBits();
    const holds = this._petalHolds || EMPTY_HOLDS;
    const key = [bits, bits === 0 ? 0 : this._flowerThetaRad];
    if (bits !== 0) for (let i = 0; i < holds.length; i++) key.push(holds[i].az, holds[i].thetaRad);
    this._radiatorKey = key;
  }

  /**
   * The radiator petals as masses at live angles, for computeInertia and computeCoM (structure: counted whether or not the
   * meshes are built). One entry per owned petal: pair A = azimuths 40/220, pair B = 140/320, half a pair's dry mass each; a
   * held petal reports its own angle, a free one the shared angle. With no argument (per-frame reads) ONE scratch array is
   * refilled in place: read it before the next call, never keep it. A what-if (`over`) gets a fresh array.
   * @returns {Array<{massKg:number, azDeg:number, thetaRad:number, foldRad:number}>}
   */
  radiatorBookings(over = null) {
    const FL = Constants.THERMAL.FLOWER;
    const out = over ? [] : (this._radBookScratch || (this._radBookScratch = []));
    const each = FL.PAIR_DRY_MASS_KG / 2;
    const shared = over && Number.isFinite(over.flowerThetaRad) ? over.flowerThetaRad : this._flowerThetaRad;
    const fp = this._flowerPairs;
    let n = 0;
    for (let pair = 0; pair < 2; pair++) {
      if (!fp || !(pair === 0 ? fp.A : fp.B)) continue;
      const azs = pair === 0 ? FL.PAIR_A_AZ_DEG : FL.PAIR_B_AZ_DEG;
      for (let k = 0; k < azs.length; k++) {
        const az = azs[k];
        const th = this._petalBookingTheta(az, shared, over);
        let e = out[n];
        if (!e) e = out[n] = { massKg: 0, azDeg: 0, thetaRad: 0, foldRad: 0 };
        e.massKg = each; e.azDeg = az; e.thetaRad = th; e.foldRad = this._flowerWingFoldAngle(th);
        n++;
      }
    }
    out.length = n;
    return out;
  }

  /** @private A booked petal's angle: a named what-if petal's, else its live hold, else the shared angle. */
  _petalBookingTheta(az, shared, over) {
    const petals = over && Array.isArray(over.petals) ? over.petals : null;
    if (petals) for (let i = 0; i < petals.length; i++) if (petals[i].azDeg === az) return petals[i].thetaRad;
    const holds = this._petalHolds || EMPTY_HOLDS;
    for (let i = 0; i < holds.length; i++) if (holds[i].az === az) return holds[i].thetaRad;
    return shared;
  }

  /** Moment of inertia (kg·m²) about a body axis, from the mass tree (SSOT). @param {'x'|'y'|'z'} axis */
  _attitudeMOI(axis) {
    const I = this.getAttitudeInertia();
    return axis === 'x' ? I.ixx : (axis === 'z' ? I.izz : I.iyy);
  }

  /**
   * Recompute the effective ion-drive delta-V from its base and the composable multipliers (Ion Booster × MPD passive).
   * applyUpgrade calls it so the two stack instead of overwriting, and re-applying on the save-restore path is idempotent.
   * @private
   */
  _recomputeIonDeltaV() {
    this._ionDeltaV = this._baseIonDeltaV * this._thrustMult * this._mpdPassiveMult;
  }

  /**
   * Apply a shop upgrade that affects propulsion properties; modifies the rate properties the live burn path reads.
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'xenonEfficiency':
        this._ionThrustXenonRate = this._baseIonXenonRate * data.value;
        break;
      case 'thrustMultiplier':
        this._thrustMult = data.value;
        this._recomputeIonDeltaV();
        break;
      case 'coldGasThrust':
        // No consumer (the manual cold-gas thrust method is gone); the case stays so the shop route (upgradeEffectRoutes)
        // still lands on a handler.
        break;
      case 'coldGasEfficiency':
        this._coldGasRate = this._baseColdGasRate * data.value;
        break;
      case 'mpdThruster':
        // Unlock the MPD thruster. The burst subsystem has no arming verb; the MPD instead gives a REAL passive gain by boosting
        // the primary ion drive, so ch11's copy ("its passive drive trims your transfer burns") is honest. Idempotent on
        // save-restore: _ionDeltaV is recomputed from base × factors.
        this._hasMPD = true;
        this._mpdPassiveMult = Constants.MPD_PASSIVE_THRUST_MULT || 1.5;
        this._recomputeIonDeltaV();
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thruster installed. Passive drive boosts primary thrust; lithium reserves feed heavy burns.',
          priority: 'info',
        });
        break;
      case 'mpdCathodeLife':
        this._mpdCathodeLife = data.value;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'Hardened tungsten-rhenium cathode installed. Cathode lifetime extended to 1,200s.',
          priority: 'info',
        });
        break;
      case 'supercapUpgrade':
        this._hasSupercap = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'POWER',
          text: 'Graphene supercapacitor bank installed. MPD thermal dissipation improved.',
          priority: 'info',
        });
        break;
      case 'flowerPairA':
        // Aft flower pair A (az 40/220): observe-only hardware (draws, slews, throttles nothing). Idempotent via _installFlowerPair.
        this._installFlowerPair('A');
        break;
      case 'flowerPairB':
        // Pair B (az 140/320) completes the four-strut flower.
        this._installFlowerPair('B');
        break;
      case 'wheelKit':
        // Reaction-wheel kit: a flag + dry mass + inertia (the cached inertia drops with it). Idempotent: the save-restore
        // replay re-applies it. The wheels start with no stored spin (`restoreWheelState` puts a saved one back).
        this._installWheelKit();
        break;
    }
  }

  /** Set the throttle level (0.0–1.0), clamped. Affects all thrust methods proportionally. */
  setThrottleLevel(level) {
    this.throttleLevel = clamp01(level);
    eventBus.emit(Events.THROTTLE_CHANGE, { level: this.throttleLevel });
  }

  /**
   * Rate-command the attitude thrusters: `pitchCmd`/`yawCmd` ∈ [−1, 1] are this frame's demand, latched for
   * _tickAttitudeDynamics (which does the physics). Feedback (puff/flash/liner) AND N₂ billing use the ACTUAL post-rate-cap
   * fraction: at MAX_RATE in the demanded direction the thrusters give no torque (coasting is free, §3), so the visual goes
   * dark and no gas is billed. Mirrors the gate in _integrateAttitudeStep. Lights only the cold-gas bells (never the tail boxes).
   * @param {number} pitchCmd −1..1 (nose up +)
   * @param {number} yawCmd   −1..1 (nose left +)
   */
  commandAttitude(pitchCmd, yawCmd, dt) {
    const p = clamp(pitchCmd || 0, -1, 1);
    const y = clamp(yawCmd || 0, -1, 1);
    // Latch the RAW demand: the integrator re-applies the rate-cap gate itself (ω changes across substeps).
    this._attitudeCmd = (p !== 0 || y !== 0) ? { pitch: p, yaw: y } : null;
    if (this._attitudeCmd) this._recenterPaused = false;   // a manual command ends the recenter pause

    // Rate-cap gate for FEEDBACK/BILLING (mirrors _integrateAttitudeStep): an axis already at the cap goes dark and unbilled.
    const A = Constants.ATTITUDE;
    const w = this._rcsOmega || _v3AttA.set(0, 0, 0);
    let pv = p, yv = y;
    if (pv > 0 && w.x >=  A.MAX_RATE) pv = 0;
    if (pv < 0 && w.x <= -A.MAX_RATE) pv = 0;
    if (yv > 0 && w.y >=  A.MAX_RATE) yv = 0;
    if (yv < 0 && w.y <= -A.MAX_RATE) yv = 0;

    this._capP = 1; this._capY = 1;
    if (pv === 0 && yv === 0) this._capMsgOn = false;
    // The torque source is chosen in ONE place; the arrow keys are the `fast` ask: the gas, unless it is out; then the wheels, else the boxes
    if (pv !== 0 || yv !== 0) {
      const src = this.attitudeTorqueSource({ spinUp: true, fast: true, nx: pv, ny: yv });
      if (src === 'tailBoxes' || src === 'wheels') {
        this._cmdTauFrac = 0;
        return;
      }
    }
    if (pv !== 0 || yv !== 0) this._capColdSpinUp(pv, yv, dt);
    const capP = this._capP, capY = this._capY;

    // fireRcsRotation owns the flash raise, the puff cadence AND the N₂ billing (test-RcsPlacement's cost/flash guards).
    if (pv !== 0 && capP > 0) { this.fireRcsRotation('pitch', Math.sign(pv), Math.abs(pv) * capP, dt); }
    if (yv !== 0 && capY > 0) { this.fireRcsRotation('yaw', Math.sign(yv), Math.abs(yv) * capY, dt); }

    // Post-rate-cap fraction for the audio level (getAttitudeThrustLevel): zero while coasting at the cap, so the hiss follows the plume.
    this._cmdTauFrac = Math.min(1, Math.hypot(pv * capP, yv * capY));
  }

  /**
   * 0..1 attitude-thrust level driving the RCS hiss: the MAX of the post-rate-cap commanded fraction (manual slew) and the
   * instantaneous hold-torque fraction (arrest/recenter burn). Frame-rate independent; 0 under AP/AIM.
   */
  getAttitudeThrustLevel() {
    const cmd = this._cmdTauFrac || 0;
    const hold = this._holdTauFrac || 0;
    return Math.max(cmd, hold);
  }

  /**
   * A mother-net shot or lasso cast was refused AFTER the aim turn ran (target left the envelope during the slew, the net
   * system said no). The ship stays pointed where the turn left her: the recenter toward prograde pauses, so no thruster
   * fires to turn her back (owner 2026-10-18: "if it can't launch thrusters seem to stay on"). The arrest servo still nulls
   * any rate. The pause ends on the next deliberate attitude change (manual pitch/yaw command, autopilot engage, a new aim,
   * or a daughter going out: `setAttitudeConstraintTier`), never on a timer.
   *
   * The refusal is known one microtask after the aim resolved, i.e. after the frame that already handed the attitude back and
   * ran the recenter servo once. This undoes it (the hand-back zeroes the rate by fiat), so the refusal costs no spin or hiss.
   */
  holdHeadingAfterRefusal() {
    this._recenterPaused = true;
    this._wheelTakeBackSpin();
    if (this._rcsOmega) this._rcsOmega.set(0, 0, 0);
    this._holdTauFrac = 0;
  }

  /**
   * Continuity on handback (load-bearing). When attitude ownership returns to PLAYER, fold the current world attitude into
   * the manual offset so `quaternion = prograde · _manualRotation` reproduces it exactly (no snap), and zero the body rate.
   * When the hold that aimed the ship (owner AIM) hands back, the heading she hands back at becomes the heading the tether
   * rotation limit is measured from (`_tetherLatch`), so the limit starts at 0 there. Computed from prograde⁻¹ · quaternion,
   * not `_manualRotation` (stale under AIM until folded).
   * @param {boolean} [fromAim=false] the owner that hands back is AIM
   * @private
   */
  _handAttitudeToPlayer(fromAim = false) {
    this.undoRecoilOverlay();   // the transient shake must not be folded into the lasting offset
    const pg = this._progradeQuat(_qAttA);
    if (pg) {
      this._manualRotation.copy(pg).invert().multiply(this.quaternion).normalize();
    } else {
      this._manualRotation.identity();
    }
    this._wheelTakeBackSpin();
    if (this._rcsOmega) this._rcsOmega.set(0, 0, 0);
    if (fromAim) {
      this._tetherLatch.copy(this._manualRotation);
      this._tetherLatchOn = true;
    }
  }

  /**
   * Keep the autopilot-owned heading in the ORBIT frame. On: the attitude is folded into `_manualRotation` (no snap) and
   * `_orientAlongVelocity` recomposes `prograde · _manualRotation` from the exact prograde every frame, so the nose follows
   * the orbit at any world rate (~1.1 rad/s at the trip's 100x; the autopilot's 0.2 rad/s world-frame slew cannot). Off: the
   * autopilot's / scripted turn's direct writes stand. Only meaningful while the owner is AUTOPILOT.
   */
  setOrbitFrameHold(on) {
    const want = !!on;
    if (want === this._orbitFrameHold) return;
    if (want) this._handAttitudeToPlayer(false);
    this._orbitFrameHold = want;
  }

  isOrbitFrameHold() { return this._orbitFrameHold === true; }

  /**
   * Ease the orbit-frame offset toward prograde (identity) by at most `maxAngle` rad this frame (the turn to the burn
   * attitude, at the autopilot's own turn rate). Inside `deadzone` rad nothing moves.
   * @param {number} maxAngle - rad this frame (rate x real dt)
   * @param {number} [deadzone=0] - rad
   * @returns {number} the angle (rad) still to go after this step
   */
  easeOrbitFrameOffset(maxAngle, deadzone = 0) {
    const q = this._manualRotation;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    if (!(angle > deadzone) || !(maxAngle > 0)) return angle;
    const step = Math.min(maxAngle, angle);
    q.slerp(_qIdentity, step / angle).normalize();
    return angle - step;
  }

  /** @private Peak torque (N·m) about a body axis, from the couple SSOT. @param {'x'|'y'|'z'} axis */
  _coupleTauMag(axis) {
    const ct = this._rcsCoupleTorque;
    if (!ct) return 0;
    if (axis === 'x') return Math.max(Math.abs(ct.pitchPos?.x || 0), Math.abs(ct.pitchNeg?.x || 0));
    if (axis === 'y') return Math.max(Math.abs(ct.yawPos?.y || 0), Math.abs(ct.yawNeg?.y || 0));
    // roll authority is only the parasitic z-leak of the pitch/yaw couples
    return Math.max(
      Math.abs(ct.pitchPos?.z || 0), Math.abs(ct.pitchNeg?.z || 0),
      Math.abs(ct.yawPos?.z || 0), Math.abs(ct.yawNeg?.z || 0), 1e-6,
    );
  }

  // SLOTH MODE (owner 2026-10-23, DECISIONS §37): the four tail ion boxes turn her when the steering gas is out

  /**
   * Steering gas (POOL units: the 20-unit tank is 6 kg of nitrogen, 0.3 kg per unit) a cold-gas turn bills per rad/s of spin
   * about a body axis: k·I/τ (k = the rate × RCS_ATTITUDE_N2_FACTOR). `mode` picks the torque the price is per: 'stop' = the
   * rate-null servo's reference (bigger of the pitch/yaw couples; bills |τ|/τ_ref of full flow), 'up' = the axis's own couple
   * (arrow key / autopilot torque × time bill). 0 = no cold-gas authority on that axis (a stub). @private
   */
  _coldGasPerRadS(axis, mode = 'up') {
    const tau = mode === 'stop' ? Math.max(this._coupleTauMag('x'), this._coupleTauMag('y')) : this._coupleTauMag(axis);
    if (!(tau > 1e-3)) return 0;
    return this._coldGasRate * (Constants.ATTITUDE.RCS_ATTITUDE_N2_FACTOR ?? 1) * this._attitudeMOI(axis) / tau;
  }

  /**
   * G_stop(ω): the steering gas (POOL units, 0.3 kg of nitrogen each) the arrest will bill to bring a spin to rest (pitch +
   * yaw; roll is never billed). Derived from the billing law of the path that arrests: the rate-null servo bills
   * k × ∫(|τ|/τ_ref)dt = k·I·ω/τ_ref (measured within 1% for pitch and yaw at 0.02, 0.1 and 0.3 rad/s; test-SlothMode.js
   * pins the rest). `autopilot`: its brake bills k × mag × t = k·I·Δω/τ_axis instead (its own axis's couple: yaw is 4.8%
   * dearer), so it prices with that.
   * @param {{x:number,y:number}} [w] body rate (rad/s); default her live rate
   * @param {boolean} [autopilot=false]
   */
  slothStopGasPool(w = this._rcsOmega, autopilot = false) {
    if (!w) return 0;
    const mode = autopilot ? 'up' : 'stop';
    return this._coldGasPerRadS('x', mode) * Math.abs(w.x) + this._coldGasPerRadS('y', mode) * Math.abs(w.y);
  }

  /**
   * G_min: the gas to spin up to MIN_SPIN_DEG_S plus the gas to stop from it (the worse of pitch and yaw). Below it the
   * tank cannot pay for even a 1°/s turn with its stop, so every turn is a slow one on the tail boxes. 0 for a stub with
   * no cold-gas couples (never sloth mode). POOL units (the bare ship: about 0.034 pool = 10 g of nitrogen).
   */
  slothGasFloorPool() {
    const w1 = degToRad(Constants.SLOTH.MIN_SPIN_DEG_S);
    const per = (axis) => this._coldGasPerRadS(axis, 'up') + this._coldGasPerRadS(axis, 'stop');   // spin up + stop
    return w1 * Math.max(per('x'), per('y'));
  }

  /** Sloth mode: the tank holds less steering gas than G_min. Never on an off-play frame (menu picture: nothing bills). */
  isSlothMode() {
    if (this._offPlayFrame === true || !this.resources) return false;
    const floor = this.slothGasFloorPool();
    return floor > 0 && (this.resources.coldGas || 0) < floor;
  }

  /** Steering gas (pool units) under which the tank counts as empty for the torque selector: GAS_DUST_FRAC × G_min. */
  slothGasDustPool() {
    return Constants.SLOTH.GAS_DUST_FRAC * this.slothGasFloorPool();
  }

  /**
   * The ONE place the mother's attitude torque source is chosen. Order: cold gas above the stop reserve → the reaction
   * wheels (the kit, DECISIONS §2 row 9) → the tail ion boxes. Every turn path asks it: the arrow keys (`commandAttitude`,
   * the integrator), the rate-null servo, the autopilot's aim, its scripted turn, the trip's turn, the slews.
   *
   * Reaction wheels, only with the kit aboard (`_wheelSource`): arrow keys (`fast`) stay on the gas while it lasts; other turns
   * go to the wheels when they can finish inside the caller's limit (`limitS`, over `angleRad` about the body axis (nx, ny)),
   * else to the gas; with the gas out the wheels take every turn; wheels full or unpowered fall back to the gas (comms line,
   * once), and with the gas out too, to the tail boxes. A gas-made spin is braked by the gas, a wheel-made one by the wheels.
   * @param {{spinUp?: boolean, rate?: number, fast?: boolean, angleRad?: number, nx?: number, ny?: number, limitS?: number, losRateRadS?: number, rateRadS?: number}} [ask]
   *   spinUp:false = an arrest (rate: the |rate error| it is about, rad/s); fast:true = the arrow-key command;
   *   losRateRadS = how fast the target's bearing turns away from her (an aim at a drifting piece), rateRadS = her rate about the turn axis now
   * @returns {'coldGas'|'tailBoxes'|'wheels'}
   */
  attitudeTorqueSource(ask) {
    if (this._wheelKit === true) {
      const w = this._wheelSource(ask || {});
      if (w !== null) return w;
    }
    if (!this.isSlothMode()) return 'coldGas';
    // The arrest may always spend what is left (the reserve was kept for it): a spin the cold gas made (`_gasSpin`) or any
    // spin the boxes could not have made (above GAS_ARREST_ABOVE_DEG_S: a kick) is stopped with the gas that remains; the
    // boxes finish once the tank is dry. A spin the boxes made is stopped by the boxes. A remainder under `slothGasDustPool()`
    // (1% of G_min, ~0.1 g) counts as empty: the frame bill is capped at half the tank (`gasFrac`), so a grain would fade the
    // torque away for ~18 s while the boxes could be braking her.
    if (ask && ask.spinUp === false && (this.resources.coldGas || 0) > this.slothGasDustPool()
        && (this._gasSpin === true || ask.rate > degToRad(Constants.SLOTH.GAS_ARREST_ABOVE_DEG_S))) return 'coldGas';
    return 'tailBoxes';
  }

  /**
   * The wheels' part of the selector: 'wheels' or 'coldGas' when the kit decides, null when no wheel can serve (the
   * two-source choice follows). @param {object} ask see `attitudeTorqueSource` @private
   */
  _wheelSource(ask) {
    const usable = this.wheelsUsable();
    const sloth = this.isSlothMode();
    if (ask.spinUp === false) {
      // an arrest: a wheel-made spin is the wheels' to stop (the spin came out of them, the stop goes back into them)
      return (this._wheelSpin === true && usable) ? 'wheels' : null;
    }
    const fast = ask.fast === true;
    const hasAngle = Number.isFinite(ask.angleRad);
    if (!usable) {
      // no power: the turn goes to the gas (with the gas out, to the boxes: null). Said once, for a turn the wheels would have done.
      if (!sloth && !fast && hasAngle && this._offPlayFrame !== true && ask.quiet !== true) {
        const b = this.resources ? this.resources.battery : undefined;
        if (Number.isFinite(b) && b < Constants.WHEELS.MIN_BATTERY_WH) this._wheelSay('power');
      }
      return null;
    }
    if (sloth) {
      // steering gas out: the wheels take every turn they can, the arrow keys too. A full wheel hands the turn to the boxes
      // only for a ship AT REST: one already turning on the wheels (`_wheelSpin`, or the autopilot's slow turn, `ask.carrying`)
      // coasts on the full wheel and the wheels brake her, which is what empties them. No "turning on steering gas" line (no gas).
      const turning = ask.carrying === true || this._wheelSpin === true;
      if (this.wheelsFull(ask.nx, ask.ny) && !turning) return null;
      return 'wheels';
    }
    if (fast) return 'coldGas';                  // the arrow keys stay on the gas while it lasts (owner)
    if (!hasAngle) return 'coldGas';             // nothing says how far: the wheels cannot promise to finish
    const est = this.wheelTurnTimeS(ask.angleRad, ask.nx, ask.ny);
    if (!Number.isFinite(est)) { if (ask.quiet !== true) this._wheelSay('full'); return 'coldGas'; }
    if (ask.quiet !== true) { this._wheelMsg.full = false; this._wheelMsg.power = false; }   // the wheels can serve again: the next failure is a new event
    const limit = Number.isFinite(ask.limitS) ? ask.limitS : Infinity;
    // A drifting target: the wheels take the aim only when their room rate covers the target's line-of-sight rate (LOS_COVER
    // times over: an aim that stops AT the bearing needs more than that) and the chase (the angle plus the bearing's drift
    // during the turn) fits the limit; the gas takes a faster one. `rateRadS` = the rate she already has about the turn axis.
    const los = Number.isFinite(ask.losRateRadS) ? Math.max(0, ask.losRateRadS) : 0;
    if (los > 0) {
      const l = Math.hypot(ask.nx, ask.ny) || 1, s = ask.angleRad < 0 ? -1 : 1;
      const room = this.wheelSpareRate(s * ask.nx / l, s * ask.ny / l) + Math.max(0, Number.isFinite(ask.rateRadS) ? ask.rateRadS : 0);
      if (room < Constants.WHEELS.LOS_COVER * los) return 'coldGas';
      return this.wheelChaseTimeS(ask.angleRad, ask.nx, ask.ny, los, ask.rateRadS) <= limit ? 'wheels' : 'coldGas';
    }
    return est <= limit ? 'wheels' : 'coldGas';
  }

  /**
   * Seconds to turn onto a bearing `angleRad` away that runs on at `losRateRadS` (rad/s, along the turn), ARRIVING AT ITS RATE
   * (the eased aim of the wheels tracks it, it does not stop at it); from rest, or from the rate `rateRadS` she already has
   * along the turn. Her rate climbs at α to a peak then back down to the bearing's rate w; in the bearing's frame she closes at
   * v0 = rate - w, peak closing rate vp = sqrt(α·angle + v0²/2), at most the wheels' room (then she cruises at it).
   * w = 0 and rate = 0 is `wheelTurnTimeS`. Infinity when the wheels cannot turn her that way or cannot out-turn the bearing.
   */
  wheelChaseTimeS(angleRad, nx = 1, ny = 0, losRateRadS = 0, rateRadS = 0) {
    const w = Number.isFinite(losRateRadS) ? Math.max(0, losRateRadS) : 0;
    const r = Number.isFinite(rateRadS) ? Math.max(0, rateRadS) : 0;
    if (!(w > 0) && !(r > 0)) return this.wheelTurnTimeS(angleRad, nx, ny);
    const lim = this._wheelTurnLimits(angleRad, nx, ny, r);
    if (!lim || !(lim.wmax > w)) return Infinity;
    const { alpha } = lim, e0 = Math.abs(angleRad), v0 = r - w, vmax = lim.wmax - w;
    if (v0 > 0 && e0 < v0 * v0 / (2 * alpha)) return v0 / alpha + 2 * Math.sqrt((v0 * v0 / (2 * alpha) - e0) / alpha);   // too fast to stop in time: brake, come back
    const vp = Math.sqrt(alpha * e0 + 0.5 * v0 * v0);
    if (vp <= vmax) return (2 * vp - v0) / alpha;
    const gain = (2 * vmax * vmax - v0 * v0) / (2 * alpha);                      // what the climb to the room's rate and the return win on the bearing
    return (2 * vmax - v0) / alpha + Math.max(0, e0 - gain) / vmax;
  }

  /**
   * The four boxes' force and torque about the ship's centre of mass, from their real places: τ = (r − CoM) × F, with F
   * along the push (opposite the exhaust, `Constants.THRUSTERS[i].thrustDir`), F = one engine's thrust / 4. Table order =
   * Constants.THRUSTERS = the `mainThrusters` meshes. `xp/xn/yp/yn` = the box that turns her + / − about that axis (-1
   * = none). Cached 100 ms and per thrust level (CoM follows the arms).
   * @returns {{stamp:number, F:number, tau:THREE.Vector3[], xp:number, xn:number, yp:number, yn:number, mag:{x:number,y:number}}}
   * @private
   */
  _slothBoxTable() {
    const now = performance.now();
    const list = Constants.THRUSTERS;
    const F = Constants.TRIP.XENON_THRUST_N * activeThrustScale(this) / list.length;
    const t0 = this._slothBox;
    if (t0 && t0.F === F && now - t0.stamp < 100) return t0;
    const am = this.armManager;
    const com = (am && am.arms) ? computeCoM(am, this).position : null;
    const cx = com ? com.x : 0, cy = com ? com.y : 0, cz = com ? com.z : 0;
    const tau = [];
    for (let i = 0; i < list.length; i++) {
      const th = list[i];
      let fx = -th.thrustDir.x, fy = -th.thrustDir.y, fz = -th.thrustDir.z;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx *= F / fl; fy *= F / fl; fz *= F / fl;
      const rx = th.nozzlePos.x - cx, ry = th.nozzlePos.y - cy, rz = th.nozzlePos.z - cz;
      tau.push(new THREE.Vector3(ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx));
    }
    const pick = (comp, sgn) => {
      let best = -1, bv = 1e-12;
      for (let i = 0; i < tau.length; i++) { const v = sgn * tau[i][comp]; if (v > bv) { bv = v; best = i; } }
      return best;
    };
    const t = { stamp: now, F, tau, xp: pick('x', 1), xn: pick('x', -1), yp: pick('y', 1), yn: pick('y', -1), mag: { x: 0, y: 0 } };
    t.mag.x = (t.xp >= 0 && t.xn >= 0) ? Math.min(Math.abs(tau[t.xp].x), Math.abs(tau[t.xn].x)) : 0;
    t.mag.y = (t.yp >= 0 && t.yn >= 0) ? Math.min(Math.abs(tau[t.yp].y), Math.abs(tau[t.yn].y)) : 0;
    this._slothBox = t;
    return t;
  }

  /** Peak torque (N·m) the tail boxes give about a body axis: the weaker of the two directions (the planning figure). 0 for roll. */
  slothTauMag(axis) {
    const m = this._slothBoxTable().mag;
    return axis === 'x' ? m.x : (axis === 'y' ? m.y : 0);
  }

  /** Angular acceleration (rad/s²) of the tail boxes about a body axis at full output. */
  slothAlpha(axis) {
    const tau = this.slothTauMag(axis);
    return tau > 0 ? tau / this._attitudeMOI(axis) : 0;
  }

  /**
   * Seconds a slow turn of `angleRad` takes on the boxes (accelerate half, brake half), about the body axis
   * (nx, ny, 0)/|·|; warm-up not included (`slothWarmupLeftS`). Infinity when the boxes cannot turn her that way.
   */
  slothTurnTimeS(angleRad, nx = 1, ny = 0) {
    const l = Math.hypot(nx, ny) || 1;
    const ax = Math.abs(nx) / l, ay = Math.abs(ny) / l;
    let a = Infinity;
    if (ax > 1e-9) a = Math.min(a, this.slothTauMag('x') / (this._attitudeMOI('x') * ax));
    if (ay > 1e-9) a = Math.min(a, this.slothTauMag('y') / (this._attitudeMOI('y') * ay));
    return a > 0 && Number.isFinite(a) ? 2 * Math.sqrt(Math.abs(angleRad) / a) : Infinity;
  }

  /** Seconds of cathode warm-up still to wait before the boxes give thrust (0 once warm). */
  slothWarmupLeftS() {
    return this._slothWarm ? 0 : Math.max(0, Constants.SLOTH.WARMUP_S - (this._slothWarmS || 0));
  }

  isSlothWarm() { return this._slothWarm === true; }

  /** Plain-words duration for comms: "about 40 s" under 90 s, else "about 12 min". */
  slothTimeWords(sec) {
    if (!Number.isFinite(sec)) return 'a very long time';
    if (sec < 90) return `about ${Math.max(1, Math.round(sec / 5) * 5)} s`;
    return `about ${Math.round(sec / 60)} min`;
  }

  /** Engine gas for the boxes: the loaded gas has something in the tank (a cargo fuel falls back to the tank when short). @private */
  _slothGasOk() {
    const rs = this._resourceSystem;
    const fuel = rs ? rs.getCurrentFuel() : (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
    if (fuel && fuel.fromCargo) return true;
    return (this.resources.xenon || 0) > 0;
  }

  /**
   * How much of full thrust (0..1) the boxes can give this frame if asked for `litUnits` box-outputs (0..2) for `dt` seconds.
   * 0 while the cathodes are cold (asking starts the warm-up), with no engine gas, or with no battery; otherwise the fraction
   * of the power the battery holds (empty in sun → the panel's share only, empty in shadow → 0; never free). PEEK: the draw is
   * billed at the frame end from the lit seconds.
   */
  slothPeek(litUnits, dt) {
    const S = Constants.SLOTH;
    if (!(litUnits > 1e-9)) return this._slothWarm ? 1 : 0;
    if (!this._slothWarm) { this._slothWarming = true; return 0; }
    if (!this._slothGasOk()) return 0;
    const need = (S.BOX_POWER_W / Constants.SHIP_HEAT.W_PER_UNIT_S) * litUnits * dt;
    const avail = Math.max(0, this.resources.battery || 0);
    return need > 0 ? Math.min(1, avail / need) : 1;
  }

  /**
   * The tail-box torque function: ask for `signedFrac` (−1..1) of the box that turns her about `axis` for `h` seconds.
   * Returns the torque about that axis the box gives (N·m, signed); adds the box's whole torque vector (a lateral CoM
   * offset gives a little on the other axis) into `out`. Scaled by the frame's peek (cold / no gas / no power → 0) and
   * recorded as lit time for the frame-end bill and the glow. The wheel kit can call it later to unload momentum.
   * @param {'x'|'y'} axis @param {number} signedFrac @param {number} h @param {THREE.Vector3} out
   */
  tailBoxTorque(axis, signedFrac, h, out) {
    const f = Math.min(1, Math.abs(signedFrac));
    if (!(f > 0)) return 0;
    const t = this._slothBoxTable();
    const i = axis === 'x' ? (signedFrac > 0 ? t.xp : t.xn) : (signedFrac > 0 ? t.yp : t.yn);
    if (i < 0) return 0;
    const eff = f * (this._sl ? this._sl.pf : 0);
    if (!(eff > 0)) return 0;
    this._slothLitS[i] += eff * h;
    out.addScaledVector(t.tau[i], eff);
    return t.tau[i][axis] * eff;
  }

  /**
   * A body spin another owner was carrying as a bare number (the trip hold's slow turn, `AutopilotSystem._tripLetGo`)
   * comes to her: it stays, and her rate-null brakes it on the boxes when they have power and engine gas.
   * @param {number} wx rad/s about body X @param {number} wy rad/s about body Y
   * @param {string} [src] what made it ('wheels' marks a wheel-made spin)
   */
  adoptBodySpin(wx, wy, src) {
    // Kept until the next attitude tick has resolved the owner: the hand-back from AUTOPILOT to PLAYER zeroes the body rate
    // (`_handAttitudeToPlayer`), and the spin must outlive that.
    const a = this._adoptSpin || (this._adoptSpin = { x: 0, y: 0, wheels: false });
    a.x += wx; a.y += wy;
    if (src === 'wheels') a.wheels = true;   // a wheel-made spin: the wheels' to brake (`attitudeTorqueSource`)
  }

  /**
   * The autopilot's burn writes the attitude itself (its own rate law), so the boxes only need their lit time recorded for the
   * power / engine-gas bill and the glow: the box that turns her `sign` about `axis`, for `seconds` of full output.
   * @param {'x'|'y'} axis @param {number} sign @param {number} seconds
   */
  tailBoxLit(axis, sign, seconds) {
    if (!(seconds > 0)) return;
    const t = this._slothBoxTable();
    const i = axis === 'x' ? (sign > 0 ? t.xp : t.xn) : (sign > 0 ? t.yp : t.yn);
    if (i >= 0) this._slothLitS[i] += seconds;
  }

  /**
   * Per frame, before the attitude tick (any owner): the cathodes' warm-up and hot standby, and the one "steering gas empty"
   * line when sloth mode turns on. Warm-up starts when a box is first asked for (`slothPeek`), runs on the standby heater's
   * power, and gives no thrust; once warm they stay warm for STANDBY_W while sloth mode is on; a standby the battery cannot
   * pay in full turns them cold again.
   * @private
   */
  _slothTick(dt) {
    const S = Constants.SLOTH;
    if (!this.isSlothMode()) {
      this._slothWarm = false; this._slothWarming = false; this._slothWarmS = 0; this._slothWasOn = false;
      this._slothSayPending = false;
      return;
    }
    if (!this._slothWasOn) {
      this._slothWasOn = true;
      // With the reaction wheels aboard the wheels turn her when the gas is out: the line is said only if the boxes have to
      // take over (a box lights: wheels full or without power; `_slothFrameEnd`).
      if (this._wheelKit === true) this._slothSayPending = true;
      else this._slothSay();
    }
    if (!(dt > 0) || !(this._slothWarm || this._slothWarming)) return;
    const f = this._drawBurnResource('battery', (S.STANDBY_W / Constants.SHIP_HEAT.W_PER_UNIT_S) * dt);
    if (this._slothWarm) {
      if (f < 1 - 1e-6) { this._slothWarm = false; this._slothWarming = false; this._slothWarmS = 0; }
    } else {
      this._slothWarmS += dt * f;
      if (this._slothWarmS >= S.WARMUP_S) { this._slothWarm = true; this._slothWarming = false; }
    }
  }

  /** @private The one "steering gas empty" line (sloth mode on, the boxes the source). */
  _slothSay() {
    const t = this.slothTurnTimeS(Math.PI / 2);
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT',
      text: `Emergency steering activated: steering gas empty, the tail boxes turn her slowly (${this.slothTimeWords(t)} per 90°).`,
      priority: 'warning',
    });
  }

  /**
   * A spin the wheels made goes back into them when she stops being the ship that carries it (a hand-over to the autopilot, a refused
   * shot): the rate is zeroed by fiat there, so the wheels take its angular momentum (I·ω per axis) and the total still adds up.
   * @private
   */
  _wheelTakeBackSpin() {
    if (!this._wheelSpin) return;
    this._wheelSpin = false;
    if (!this._wheelKit || !this._rcsOmega) return;
    const I = this.getAttitudeInertia(), H = Constants.WHEELS.MOMENTUM_NMS, w = this._rcsOmega, h = this._wheelH;
    h.x = clamp(h.x + I.ixx * w.x, -H, H);
    h.y = clamp(h.y + I.iyy * w.y, -H, H);
  }

  /**
   * Per frame, after the attitude tick (any owner): bill the boxes' lit time (battery at BOX_POWER_W × lit seconds, engine gas
   * at thrust × lit seconds / (Isp·g0) via `billBurnGas`), set the per-box glow from this frame's lit fraction, clear the tallies.
   * @private
   */
  _slothFrameEnd(dt) {
    const lit = this._slothLitS;
    let sum = 0;
    for (let i = 0; i < lit.length; i++) sum += lit[i];
    for (let i = 0; i < lit.length; i++) this._slothGlow[i] = dt > 0 ? Math.min(1, lit[i] / dt) : 0;
    const unloadS = this._unloadLitS;
    this._unloadLitS = 0;
    if (!(sum > 0)) return;
    // With the kit aboard the "steering gas empty" line waits until a box really TURNS her (the wheels were full at rest or
    // unpowered): the unload's lit time is a box at work on a full wheel, not a turn
    if (this._slothSayPending === true && sum - unloadS > 1e-9) { this._slothSayPending = false; this._slothSay(); }
    if (this._offPlayFrame !== true) {
      const S = Constants.SLOTH;
      this._drawBurnResource('battery', (S.BOX_POWER_W / Constants.SHIP_HEAT.W_PER_UNIT_S) * sum, { beam: true });
      const t = this._slothBoxTable();
      let n = 0;
      for (let i = 0; i < lit.length; i++) n += t.F * lit[i];            // N·s
      this.billBurnGas(n / Math.max(1, shipMassKg(this)));                // Δv the push would give
    }
    for (let i = 0; i < lit.length; i++) lit[i] = 0;
  }

  /** Box-outputs the attitude tick will ask for this frame, from the latched command and the rate error (for the power peek). @private */
  _slothDemandUnits() {
    const S = Constants.SLOTH;
    const cmd = this._attitudeCmd, w = this._rcsOmega;
    let units = 0;
    const one = (c, rate, axis) => {
      if (c !== 0) return (this._sl && this._sl.cmdSrc === 'wheels') ? 0 : Math.min(1, Math.abs(c));   // a key the wheels serve lights no box
      const e = Math.abs(rate);
      if (e <= S.REST_RAD_S) return 0;
      if (e <= S.COLD_START_RAD_S && !this._slothWarm && !this._slothWarming) return 0;   // a cold-gas arrest's residue does not wake the cathodes
      if (this.attitudeTorqueSource({ spinUp: false, rate: e }) !== 'tailBoxes') return 0;   // the gas or the wheels brake it
      const a = this.slothAlpha(axis);
      return a > 0 ? Math.min(1, e / (a * S.SERVO_ZONE_S)) : 0;
    };
    units += one(cmd ? cmd.pitch : 0, w.x, 'x');
    units += one(cmd ? cmd.yaw : 0, w.y, 'y');
    return units;
  }

  /**
   * Once per attitude tick (PLAYER / CINEMATIC owner): decide this frame's torque source and the scalings the substeps use.
   * `on` = sloth mode; `pf` = the boxes' peek (warm, gas, power); `gasFrac` = the cold-gas torque scale that keeps the
   * frame's bill inside the tank (1 until the tank is nearly empty); `cmdSrc` = the source a held key uses.
   * @private
   */
  _slFrameBegin(dt) {
    const st = this._sl || (this._sl = { on: false, pf: 0, gasFrac: 1, cmdSrc: 'coldGas' });
    st.on = this.isSlothMode();
    st.pf = 0; st.gasFrac = 1; st.cmdSrc = 'coldGas';
    const dtc = Math.min(dt, 0.1);
    // the wheels' power peek (what the battery can give them this frame, for full torque on all three), any mode
    this._wheelPf = this._wheelKit === true ? this.wheelPeek(3, dtc) : 0;
    if (!st.on) return st;
    if (this._attitudeCmd) {
      st.cmdSrc = this.attitudeTorqueSource({ spinUp: true, fast: true, nx: this._attitudeCmd.pitch, ny: this._attitudeCmd.yaw });
    }
    const k = this._coldGasRate * (Constants.ATTITUDE.RCS_ATTITUDE_N2_FACTOR ?? 1);
    st.gasFrac = k > 0 ? Math.min(1, (this.resources.coldGas || 0) / (2 * k * dtc)) : 1;
    st.pf = this.slothPeek(this._slothDemandUnits(), dtc);
    return st;
  }

  /**
   * Keep gas to stop. The command's spin-up fraction on each axis is cut so that, after this frame, the tank still
   * holds STOP_RESERVE × the gas the stop will bill: adding f of full torque for dt burns k·f·dt and adds k·f·dt to the
   * stop's price, so the affordable total is (G − R·G_stop(ω)) / ((1+R)·k·dt). Components that brake (opposite the spin)
   * are never cut. Sets `_capP` / `_capY` (read by the integrator) and says so once per turn when it first bites.
   * @param {number} pv @param {number} yv gated demand @param {number} dt @private
   */
  _capColdSpinUp(pv, yv, dt) {
    this._capP = 1; this._capY = 1;
    const w = this._rcsOmega;
    const upX = pv !== 0 && pv * w.x >= 0, upY = yv !== 0 && yv * w.y >= 0;
    const fsum = (upX ? Math.abs(pv) : 0) + (upY ? Math.abs(yv) : 0);
    if (!(fsum > 0)) return;
    const R = Constants.SLOTH.STOP_RESERVE;
    const k = this._coldGasRate * (Constants.ATTITUDE.RCS_ATTITUDE_N2_FACTOR ?? 1);
    const dtc = Math.min(dt, 0.1);
    if (!(k > 0) || !(dtc > 0)) return;
    const budget = (this.resources.coldGas || 0) - R * this.slothStopGasPool(w);
    const fmax = budget > 0 ? budget / ((1 + R) * k * dtc) : 0;
    if (fsum <= fmax) return;
    const s = fmax / fsum;
    if (upX) this._capP = s;
    if (upY) this._capY = s;
    if (!this._capMsgOn) {
      this._capMsgOn = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT',
        text: 'Steering gas low — turning slower to keep enough to stop.',
        priority: 'info',
      });
    }
  }

  /**
   * The fastest recenter rate (rad/s) the tank can afford about a body axis while keeping the stop reserve:
   * G / (R · k·I/τ). Infinity with no cold-gas authority. @private
   */
  _recenterRateCap(axis) {
    const per = this._coldGasPerRadS(axis, 'stop');
    return per > 0 ? (this.resources.coldGas || 0) / (Constants.SLOTH.STOP_RESERVE * per) : Infinity;
  }

  /**
   * Integrate rigid-body attitude on REAL dt (never gameDt). One owner per frame; only PLAYER and the CINEMATIC inspection
   * hold integrate torque, AP and AIM keep ω=0 and their direct-quaternion writes.
   *
   * dt-invariance (headline guard): the physics runs on a FIXED internal substep (1/120 s) with a remainder, so 30/60/120
   * fps integrate through identical sub-steps and agree to fp (plain semi-implicit Euler only gives O(dt)).
   * Frame-level feedback (N₂ billing, arrest-burn visual, empty-tank comms) runs ONCE after the loop.
   * @param {number} dt seconds @private
   */
  _tickAttitudeDynamics(dt) {
    // Sloth mode, any owner (the autopilot's burns are billed here too): warm-up / standby / the one "gas empty" line
    // first, the boxes' lit time billed and their glow set last.
    this._slothTick(dt);
    this._tickAttitudeCore(dt);
    // The wheels' battery bill, coil dump, tail-box unload (nothing without the kit): BEFORE the boxes' frame end, so the
    // unload's lit time is billed and glows this frame.
    this._wheelFrameEnd(dt);
    this._slothFrameEnd(dt);
  }

  /** The attitude tick proper (see `_tickAttitudeDynamics`). @param {number} dt @private */
  _tickAttitudeCore(dt) {
    if (!this._rcsOmega) this._rcsOmega = new THREE.Vector3();
    const owner = this._updateAttitudeOwner();

    // Handback continuity: when a DIRECT-quaternion owner (AUTOPILOT/AIM) releases into PLAYER or the CINEMATIC inspect hold
    // (both compose from _manualRotation), fold the current world attitude into _manualRotation so `prograde · _manualRotation`
    // reproduces it exactly; AP/AIM → CINEMATIC straight would otherwise snap to a stale offset.
    const prev = this._prevAttitudeOwner;
    if (owner !== prev) this.undoRecoilOverlay();   // a new owner starts from the commanded attitude
    const wasDirect = prev === 'AUTOPILOT' || prev === 'AIM';
    const entersManual = owner === 'PLAYER' || owner === 'CINEMATIC';
    if (entersManual && wasDirect) {
      // Latch on ANY aim-to-player hand-back (launch aim, lasso hold, net aim, net reel-in hold, leash hand-off turn): where an
      // aim leaves her pointing is where the tether limit starts. Also when the AUTOPILOT hands back with a daughter out: the
      // tier is only updated outside autopilot, so an old latch points at a heading she has left, and 'block' would push her hard.
      this._handAttitudeToPlayer(prev === 'AIM' || (prev === 'AUTOPILOT' && this._holdsHeadingForTether()));
    }

    // A spin another owner was carrying (`adoptBodySpin`) joins her rate once she is hers again, after the hand-back's zeroing
    if (this._adoptSpin) {
      if (entersManual) {
        this._rcsOmega.x += this._adoptSpin.x; this._rcsOmega.y += this._adoptSpin.y;
        if (this._adoptSpin.wheels) this._wheelSpin = true;
      }
      this._adoptSpin = null;
    }

    // AP / AIM drive the quaternion directly — hold zero body rate under them.
    if (owner !== 'PLAYER' && owner !== 'CINEMATIC') {
      this._wheelTakeBackSpin();   // the wheels' spin goes back into them (the zeroing below is by fiat)
      this._rcsOmega.set(0, 0, 0);
      this._attitudeCmd = null;
      this._cmdTauFrac = 0;
      this._holdTauFrac = 0; // no hold burn under AP/AIM: keeps the audio level honest
      this._recenterPaused = false; // autopilot engage / a new aim ends the pause
      return;
    }
    if (dt <= 0) return;

    const STEP = 1 / 120;
    let holdFired = false;
    this._frameHoldWork = 0; // accumulated hold torque·time (full-throttle-seconds)
    this._slFrameBegin(dt);  // this frame's sloth-mode torque source, power peek and gas scale
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-9) {
      const h = remaining > STEP + 1e-12 ? STEP : remaining;
      if (this._integrateAttitudeStep(h, owner)) holdFired = true;
      remaining -= h;
    }

    const A = Constants.ATTITUDE;
    const omega = this._rcsOmega;
    // back at rest (the cold servo's own 1e-4 rad/s): the gas spin is over, the next spin is whoever makes it
    if (Math.abs(omega.x) <= 1e-4 && Math.abs(omega.y) <= 1e-4) this._gasSpin = false;
    // the wheels' own rest (REST_RAD_S, finer than the gas's): a wheel-made spin is the wheels' until the servo has braked it
    // there; clearing it earlier would leave the last 1e-6 rad/s to a tail box (a glow at the end of every wheel turn)
    if (Math.abs(omega.x) <= Constants.WHEELS.REST_RAD_S && Math.abs(omega.y) <= Constants.WHEELS.REST_RAD_S) this._wheelSpin = false;
    const coldGas = this.resources ? (this.resources.coldGas || 0) : 0;
    const cmd = this._attitudeCmd;

    // Frame-level hold billing/visual is the ARREST + RECENTER burn, billed ONLY when nothing is commanded: while a command
    // is held, fireRcsRotation (via commandAttitude) already bills it, so billing here too would double-charge. Billing is by
    // ACTUAL applied torque (_frameHoldWork, gas ∝ thrust), so the rate-null's long low-ω exponential tail bills ~nothing and
    // a committed turn costs two real burns (spin-up + arrest, ~5% tank).
    if (holdFired && coldGas > 0 && !cmd && this._frameHoldWork > 0) {
      // the hold may turn the ship for the menu picture but bills no gas off play.
      if (this._offPlayFrame !== true) eventBus.emit(Events.RESOURCE_CONSUME, {
        resource: 'coldGas',
        amount: this._coldGasRate * (A.RCS_ATTITUDE_N2_FACTOR ?? 1.0) * this._frameHoldWork,
      });
      // Real arrest-burn visual on the opposing couple (§16), driven by the hold controller. Gate on the rate ERROR
      // (ω − ω_target) so a recenter burn (ω → ω_target ≠ 0) is never silent, and fire the couple that opposes the ERROR,
      // not ω: during a return ω and the needed couple have opposite signs.
      const pulseGate = 0.5 * A.RECENTER_RATE;
      const cmdP = cmd ? cmd.pitch : 0, cmdY = cmd ? cmd.yaw : 0;
      const th = this._tetherOffsetAngles(_v3AttD);
      // MUST match _integrateAttitudeStep's `recentering` gate: under CINEMATIC the substep never recenters (ω_target is 0), and a
      // non-zero target here would flash a plume on an idle couple while the player inspects the hull. Likewise while a
      // daughter is out (tier not 'none': she keeps her heading) and after a refused shot (`_recenterPaused`).
      const inspecting = (owner === 'CINEMATIC') || this._holdsHeadingForTether() || this._recenterPaused
        || (this._sl && this._sl.on);   // sloth mode: no recentering (the same gate as the substep)
      const wTx = (!inspecting && cmdP === 0 && Math.abs(th.x) > A.HOLD_DEADBAND_RAD)
        ? -clampAbs(A.RECENTER_GAIN * th.x, Math.min(A.RECENTER_RATE, this._recenterRateCap('x'))) : 0;
      const wTy = (!inspecting && cmdY === 0 && Math.abs(th.y) > A.HOLD_DEADBAND_RAD)
        ? -clampAbs(A.RECENTER_GAIN * th.y, Math.min(A.RECENTER_RATE, this._recenterRateCap('y'))) : 0;
      const errX = omega.x - wTx, errY = omega.y - wTy;
      if (Math.abs(errX) > pulseGate) this.fireRcsStopPulse('pitch', errX > 0 ? 1 : -1);
      if (Math.abs(errY) > pulseGate) this.fireRcsStopPulse('yaw', errY > 0 ? 1 : -1);
    }

    // No empty-tank steering line here: the tail boxes take over, and `_slothTick` says so once when the tank drops below G_min.
  }

  /**
   * One fixed-step attitude integration substep: torque law (command + hold + tether), clamp to couple authority, advance ω
   * (τ/I) then the manual offset (semi-implicit), inject the parasitic couple force.
   * @param {number} h seconds @param {string} owner @returns {boolean} holdFired @private
   */
  _integrateAttitudeStep(h, owner) {
    const A = Constants.ATTITUDE;
    const I = this.getAttitudeInertia();
    const omega = this._rcsOmega;
    const cmd = this._attitudeCmd || { pitch: 0, yaw: 0 };
    const ct = this._rcsCoupleTorque || {};
    const inspecting = (owner === 'CINEMATIC');

    // Commanded torque (rate-command with an authority ceiling). `cmdP`/`cmdY` = raw player demand; `p`/`y` = that demand after the
    // rate-cap gate (the DRIVEN component drops once |ω| has reached the cap in the commanded direction: a ceiling, not a wall).
    // CRITICAL: the hold controller keys off the RAW demand, NOT the gated p/y: the gated value would let the rate-null fight
    // the command at the cap, so ω would stall just below it and the thrusters would burn gas forever instead of coasting free.
    const cmdP = cmd.pitch, cmdY = cmd.yaw;
    let p = cmdP, y = cmdY;
    if (p > 0 && omega.x >=  A.MAX_RATE) p = 0;
    if (p < 0 && omega.x <= -A.MAX_RATE) p = 0;
    if (y > 0 && omega.y >=  A.MAX_RATE) y = 0;
    if (y < 0 && omega.y <= -A.MAX_RATE) y = 0;

    const sl = this._sl;
    const slothOn = !!(sl && sl.on);
    const boxTau = _v3SlA.set(0, 0, 0);   // sloth mode: what the tail boxes add (the cold-gas torque stays in `tau`)
    const tau = _v3AttA.set(0, 0, 0);
    // Reaction wheels (the kit): the torque they give the ship this substep; the wheel's own spin changes the other way and the
    // battery pays in proportion (applied below, inside the wheel's capacity). `kitOn` = aboard and the battery can feed them.
    const WK = Constants.WHEELS;
    const kitOn = this._wheelKit === true && this._wheelPf > 0;
    const wTau = _v3WhA.set(0, 0, 0);
    let wKeyX = false, wKeyY = false;     // a held key is giving torque to the wheels on this axis
    if (slothOn && sl.cmdSrc === 'tailBoxes') {
      // holding a key lights (after warm-up) the box that turns her that way: the real ion torque, scaled by what the
      // battery / engine gas / cathodes give (`tailBoxTorque`).
      if (p !== 0) this.tailBoxTorque('x', p, h, boxTau);
      if (y !== 0) this.tailBoxTorque('y', y, h, boxTau);
      p = 0; y = 0;   // no cold couple fires: no parasitic couple force below either
    } else if (slothOn && sl.cmdSrc === 'wheels' && kitOn) {
      // gas out, wheels aboard: a held key is the wheels' torque (the arrow keys stay on the gas while it lasts), no puffs, no gas
      if (p !== 0) { wTau.x += p * WK.TORQUE_NM * this._wheelPf; wKeyX = true; }
      if (y !== 0) { wTau.y += y * WK.TORQUE_NM * this._wheelPf; wKeyY = true; }
      p = 0; y = 0;
    } else {
      // the cap on the command's spin-up (set by commandAttitude for this frame; 1 = no cap)
      p *= this._capP; y *= this._capY;
      if (p !== 0 || y !== 0) this._gasSpin = true;   // the cold gas is making this spin: its arrest is the gas's too
      if (p > 0 && ct.pitchPos) tau.addScaledVector(ct.pitchPos, p);
      else if (p < 0 && ct.pitchNeg) tau.addScaledVector(ct.pitchNeg, -p);
      if (y > 0 && ct.yawPos) tau.addScaledVector(ct.yawPos, y);
      else if (y < 0 && ct.yawNeg) tau.addScaledVector(ct.yawNeg, -y);
    }

    // Hold controller: ONE rate servo (arrest + recenter folded together). RCS thrusters are on/off, so it fires the FULL opposing
    // couple until the rate error |ω − ω_target| enters a small linear anti-chatter zone (OMEGA_LIN). ω_target is the recenter
    // demand: zero while arresting a slew (pure rate-null), non-zero when an offset remains. One error term avoids the two-torque
    // fight (RECENTER vs RATE-NULL cancelled at ω_eq = FRAC × OMEGA_LIN). Gated on the RAW demand (never fight an active command).
    const OMEGA_LIN = 0.03; // rad/s — below this, ramp arrest torque down (anti-chatter)
    let holdFired = false;

    const coldGas = this.resources ? (this.resources.coldGas || 0) : 0;
    const tethered = this._holdsHeadingForTether();
    // No recenter while a daughter is out (any rotation tier): she keeps the heading she launched at (owner 2026-10-18:
    // "then mother turns back jerking tether"); the arrest servo still stops any rate. When the tier returns to 'none' the
    // recenter resumes: at most RECENTER_RATE, driven by the couple torque only. Nor after a refused mother-net shot / lasso
    // cast (`holdHeadingAfterRefusal`): the ship stays where the aim turned her until the next deliberate attitude change.
    const recentering = !inspecting && coldGas > 0 && !tethered && !this._recenterPaused && !slothOn;   // sloth mode: recentering stays off
    // Decompose the manual offset to its body-frame rotation vector ONCE (shared by the recenter ω_target and the tether
    // spring; both read the same unmutated _manualRotation). th_i = ang·axis_i, so |th| = ang (total offset).
    const th = (recentering || tethered) ? this._tetherOffsetAngles(_v3AttD) : null;

    // Reaction wheels: a recentre is a turn too. The wheels take it when they can finish the whole offset inside AIM_TIMEOUT_S, else
    // the gas; a spin already running keeps its source (the choice is made at rest). The wheels' target rate stops inside the offset
    // at half their own α (a P-law at the gas's rates would overshoot: the wheels are slow) and never exceeds the room they have.
    let wheelRec = false;
    if (kitOn && recentering && th) {
      if (this._wheelSpin) wheelRec = true;
      else if (!this._gasSpin) {
        const offX = cmdP === 0 && Math.abs(th.x) > A.HOLD_DEADBAND_RAD, offY = cmdY === 0 && Math.abs(th.y) > A.HOLD_DEADBAND_RAD;
        if (offX || offY) {
          const tx = offX ? th.x : 0, ty = offY ? th.y : 0;
          wheelRec = this.wheelTurnTimeS(Math.hypot(tx, ty), -tx, -ty) <= Constants.AIM.AIM_TIMEOUT_S;
        }
      }
    }
    const wheelWT = (thi, axis) => {
      const Ii = axis === 'x' ? I.ixx : (axis === 'y' ? I.iyy : I.izz);
      const dirS = -Math.sign(thi);
      const rem = Math.max(0, Math.abs(thi) - 0.5 * A.HOLD_DEADBAND_RAD);
      const room = Math.max(0, (WK.MOMENTUM_NMS + dirS * this._wheelH[axis]) / Ii);   // the rate this wheel can still take that way
      return dirS * Math.min(A.RECENTER_RATE, Math.sqrt((WK.TORQUE_NM / Ii) * rem), room);
    };

    // Target body rate: default zero (pure arrest); on axes with an offset beyond the deadband and no raw command, servo toward
    // prograde at ≤ RECENTER_RATE. A recenter turn is a cold-gas turn too: its rate is held to what the tank can stop (`_recenterRateCap`).
    const wTx = (recentering && th && cmdP === 0 && Math.abs(th.x) > A.HOLD_DEADBAND_RAD)
      ? (wheelRec ? wheelWT(th.x, 'x') : -clampAbs(A.RECENTER_GAIN * th.x, Math.min(A.RECENTER_RATE, this._recenterRateCap('x')))) : 0;
    const wTy = (recentering && th && cmdY === 0 && Math.abs(th.y) > A.HOLD_DEADBAND_RAD)
      ? (wheelRec ? wheelWT(th.y, 'y') : -clampAbs(A.RECENTER_GAIN * th.y, Math.min(A.RECENTER_RATE, this._recenterRateCap('y')))) : 0;
    const wTz = (recentering && th && Math.abs(th.z) > A.HOLD_DEADBAND_RAD)
      ? (wheelRec ? wheelWT(th.z, 'z') : -clampAbs(A.RECENTER_GAIN * th.z, A.RECENTER_RATE)) : 0;
    const gasLeft = coldGas > this.slothGasDustPool();
    const servo = (w, wT, axis) => {
      const err = w - wT;
      // Reaction wheels: a wheel-made spin is braked by the wheels (down to REST_RAD_S, proportional inside alpha × SERVO_ZONE_S: no
      // chatter), a wheel recentre is the wheels' too, the z wheel nulls any roll spin, a gas-made spin stays the gas's to stop.
      if (kitOn && !(this._gasSpin && gasLeft && axis !== 'z')
          && (axis === 'z' ? (Math.abs(err) > 1e-4 && (wT === 0 || wheelRec)) : (this._wheelSpin || (wheelRec && wT !== 0)))) {
        if (Math.abs(err) > WK.REST_RAD_S) {
          const Ii = axis === 'x' ? I.ixx : (axis === 'y' ? I.iyy : I.izz);
          const frac = Math.min(1, Math.abs(err) / ((WK.TORQUE_NM / Ii) * WK.SERVO_ZONE_S));
          wTau[axis] += -Math.sign(err) * WK.TORQUE_NM * frac * this._wheelPf;
        }
        return 0;
      }
      // The rate-null asks the selector. Sloth mode: the box that opposes the error brakes her (proportional inside alpha ×
      // SERVO_ZONE_S, so no chatter, and down to REST_RAD_S: the cold-gas 1e-4 is bigger than a sloth turn); a spin above
      // GAS_ARREST_ABOVE_DEG_S is stopped with the gas that is left (the boxes finish the stop).
      if (slothOn && axis !== 'z') {
        const SL = Constants.SLOTH;
        if (this.attitudeTorqueSource({ spinUp: false, rate: Math.abs(err) }) === 'tailBoxes') {
          if (Math.abs(err) <= SL.REST_RAD_S) return 0;
          if (Math.abs(err) <= SL.COLD_START_RAD_S && !this._slothWarm && !this._slothWarming) return 0;
          const a = this.slothAlpha(axis);
          if (!(a > 0)) return 0;
          this.tailBoxTorque(axis, -Math.sign(err) * Math.min(1, Math.abs(err) / (a * SL.SERVO_ZONE_S)), h, boxTau);
          return 0;
        }
      }
      if (Math.abs(err) <= 1e-4) return 0;
      holdFired = true;
      this._gasSpin = true;
      // sloth mode: the cold torque is scaled so this frame's bill cannot exceed what is left in the tank
      return -Math.sign(err) * this._coupleTauMag(axis) * Math.min(1, Math.abs(err) / OMEGA_LIN) * (slothOn ? sl.gasFrac : 1);
    };
    if (cmdP === 0) { const sx = servo(omega.x, wTx, 'x'); tau.x += sx; }
    if (cmdY === 0) { const sy = servo(omega.y, wTy, 'y'); tau.y += sy; }
    tau.z += servo(omega.z, wTz, 'z'); // roll always servos

    // Clamp the RCS torque (command + hold) to the physically available couple authority.
    tau.x = clampAbs(tau.x, this._coupleTauMag('x'));
    tau.y = clampAbs(tau.y, this._coupleTauMag('y'));
    tau.z = clampAbs(tau.z, this._coupleTauMag('z'));

    // Latch the instantaneous RCS hold-torque fraction for the audio level (getAttitudeThrustLevel). RCS-only (the tether spring is
    // structural, must not drive the hiss) and NOT the _frameHoldWork time-integral (which scales with frame time).
    {
      const tauMaxRef = Math.max(1e-6, this._coupleTauMag('x'), this._coupleTauMag('y'));
      this._holdTauFrac = Math.min(1, Math.hypot(tau.x, tau.y) / tauMaxRef);
    }

    // Tether restoring torque: a STRUCTURAL constraint (the taut tether), not RCS authority, so it is added AFTER the couple clamp:
    // a stiffening spring that exceeds τ_max at the limit, so angular momentum cannot carry the offset past it.
    if (tethered && th) {
      this._applyTetherTorque(tau, this._tetherLatchOn ? this._tetherRefAngles(_v3AttE) : th);
    }

    // N₂ accounting for the HOLD: bill by ACTUAL applied torque fraction (gas ∝ thrust), NOT by |ω|: a proportional rate-null has a long
    // low-ω exponential tail that fires almost nothing, so ω-based billing would massively over-charge it. Only on frames with no active
    // command (those bill via commandAttitude→fireRcsRotation); τ here is hold+tether only.
    if (cmdP === 0 && cmdY === 0) {
      const tauMaxRef = Math.max(1e-6, this._coupleTauMag('x'), this._coupleTauMag('y'));
      const eff = Math.min(1, Math.hypot(tau.x, tau.y) / tauMaxRef);
      this._frameHoldWork = (this._frameHoldWork || 0) + eff * h;
    }

    // Sloth mode: the boxes' torque joins after the cold-gas bookkeeping (not billed as gas, no hiss, far below the couple clamp).
    if (slothOn) tau.add(boxTau);

    // Reaction wheels: their torque joins here too (no gas, no hiss). A wheel never goes past its capacity: the torque that
    // would fill (or over-empty) it is cut to what fits. The wheel's spin changes by the opposite moment, and the full-output
    // seconds go on the frame's power bill (`_wheelFrameEnd`).
    if (kitOn) {
      const H = WK.MOMENTUM_NMS, hw = this._wheelH;
      if (cmdP === 0 && cmdY === 0) this._wheelMsg.top = false;      // the key is up: the next hold is a new one
      for (const k of _AXES3) {
        let t = wTau[k];
        if (t === 0) continue;
        const t0 = t;
        const lo = (hw[k] - H) / h, hi = (hw[k] + H) / h;
        t = t < lo ? lo : (t > hi ? hi : t);
        hw[k] -= t * h;
        this._wheelUse[k] += (Math.abs(t) / WK.TORQUE_NM) * h;
        tau[k] += t;
        if (k !== 'z' && t !== 0) this._wheelSpin = true;
        // a held key whose torque the full wheel cuts to under half has reached the wheels' top speed: say what the stop costs, once
        if ((k === 'x' ? wKeyX : (k === 'y' && wKeyY)) && Math.abs(t) < 0.5 * Math.abs(t0)) this._wheelTopSpeedSay(k, omega[k], I, WK);
      }
    }

    omega.x += (tau.x / I.ixx) * h;
    omega.y += (tau.y / I.iyy) * h;
    omega.z += (tau.z / I.izz) * h;
    omega.x = clampAbs(omega.x, A.MAX_RATE);
    omega.y = clampAbs(omega.y, A.MAX_RATE);
    omega.z = clampAbs(omega.z, A.MAX_RATE);

    const wLen = omega.length();
    if (wLen > 1e-9) {
      _qAttB.setFromAxisAngle(_v3AttB.copy(omega).divideScalar(wLen), wLen * h);
      this._manualRotation.multiply(_qAttB).normalize();
    }

    // Parasitic net force from the commanded couples (yaw is not a pure couple) → _rcsVelocity in the WORLD frame; damping bleeds it off.
    const cf = this._rcsCoupleForce;
    if (cf) {
      _v3AttC.set(0, 0, 0);
      if (p > 0 && cf.pitchPos) _v3AttC.addScaledVector(cf.pitchPos, p);
      else if (p < 0 && cf.pitchNeg) _v3AttC.addScaledVector(cf.pitchNeg, -p);
      if (y > 0 && cf.yawPos) _v3AttC.addScaledVector(cf.yawPos, y);
      else if (y < 0 && cf.yawNeg) _v3AttC.addScaledVector(cf.yawNeg, -y);
      if (_v3AttC.lengthSq() > 1e-12) {
        const mass = this.mass || 130;
        _v3AttC.applyQuaternion(this.quaternion).multiplyScalar((M / mass) * h);
        this._rcsVelocity.add(_v3AttC);
      }
    }
    return holdFired;
  }

  /** @returns {{pitch:number, yaw:number, roll:number}} live body angular rate (deg/s). */
  getAngularRate() {
    const w = this._rcsOmega || _v3AttA.set(0, 0, 0);
    return { pitch: w.x * RAD2DEG, yaw: w.y * RAD2DEG, roll: w.z * RAD2DEG };
  }

  /**
   * Set the active tether rotation-limit tier ('none' | 'soft' | 'block'); drives the restoring torque in _applyTetherTorque.
   * Owns the displacement state. @param {string} tier
   */
  setAttitudeConstraintTier(tier) {
    this._attitudeConstraintTier = tier || 'none';
    if (this._attitudeConstraintTier === 'none') this._tetherLatchOn = false;   // no daughter out, no latch
    else this._recenterPaused = false;   // a daughter out on her line has her own rules for the heading
  }

  /**
   * Is a daughter out (rotation tier 'soft' or 'block')? Then the ship keeps her heading: the hold controller does not
   * recenter her toward prograde (see `_integrateAttitudeStep`).
   * @private
   */
  _holdsHeadingForTether() {
    const t = this._attitudeConstraintTier;
    return !!t && t !== 'none';
  }

  /**
   * Is the tether offset saturated AND being pushed further into the limit on the demanded axes? InputManager uses it to
   * gate the comms warning.
   * @param {number} pitchIn @param {number} yawIn @returns {boolean}
   */
  isAttitudeConstraintSaturated(pitchIn, yawIn) {
    const tier = this._attitudeConstraintTier;
    if (!tier || tier === 'none') return false;
    const TR = Constants.TETHER_ROTATION;
    const maxDisp = tier === 'block' ? TR.MAX_DISPLACEMENT_BLOCK : TR.MAX_DISPLACEMENT_SOFT;
    const th = this._tetherRefAngles(_v3AttA);
    const sat = TR.SATURATION_THRESHOLD * maxDisp;
    const pitchSat = Math.abs(th.x) >= sat && Math.sign(th.x) === Math.sign(pitchIn) && pitchIn !== 0;
    const yawSat = Math.abs(th.y) >= sat && Math.sign(th.y) === Math.sign(yawIn) && yawIn !== 0;
    return pitchSat || yawSat;
  }

  /** Manual offset as per-axis rotation-vector angles (rad), body frame: {x: pitch, y: yaw, z: roll}. */
  _tetherOffsetAngles(out, mr = this._manualRotation) {
    const ang = 2 * Math.acos(Math.min(1, Math.abs(mr.w)));
    const s = Math.sqrt(Math.max(0, 1 - mr.w * mr.w)) || 1;
    const sign = mr.w >= 0 ? 1 : -1;
    return out.set(ang * sign * mr.x / s, ang * sign * mr.y / s, ang * sign * mr.z / s);
  }

  /**
   * Offset the tether rotation limit is measured from, as body-frame angles (rad) like `_tetherOffsetAngles`: from the
   * latched heading when a latch is on (`_handAttitudeToPlayer` after a launch aim), else from prograde. A rotation has
   * the same axis in both frames, so the angles read the same in either.
   */
  _tetherRefAngles(out) {
    if (!this._tetherLatchOn) return this._tetherOffsetAngles(out);
    const rel = _qAttC.copy(this._tetherLatch).invert().multiply(this._manualRotation);   // latch⁻¹ · offset
    return this._tetherOffsetAngles(out, rel);
  }

  /**
   * Tether rotation-limit restoring torque added into `tau` (N·m, body frame). Per pitch/yaw axis: a stiffening spring
   * −sign(θ)·τ_wall·(|θ|/θ_max)^n (n = STIFFNESS_EXPONENT) plus damping beyond half-limit. τ_wall is several × the
   * couple authority, so the momentum equilibrium sits well below θ_max.
   * The 'soft' tier (a daughter flying out on her line) is a slack line: its torque plus the thrusters' stays inside
   * the couple authority, so it never kicks her. The 'block' tier (a loaded, reeling or hauling line) is the full wall.
   * @param {THREE.Vector3} th body-frame offset rotation vector the limit is measured from (`_tetherRefAngles`;
   *   RECENTER reads `_tetherOffsetAngles`)
   */
  _applyTetherTorque(tau, th) {
    const tier = this._attitudeConstraintTier;
    const TR = Constants.TETHER_ROTATION;
    const maxDisp = tier === 'block' ? TR.MAX_DISPLACEMENT_BLOCK : TR.MAX_DISPLACEMENT_SOFT;
    const stiff = TR.STIFFNESS_EXPONENT;
    const I = this.getAttitudeInertia();
    const w = this._rcsOmega;
    const wall = 6 * Math.max(this._coupleTauMag('x'), this._coupleTauMag('y')); // ≫ τ_max
    const axis = (thv, wv, Iax) => {
      const n = Math.min(1, Math.abs(thv) / maxDisp);
      let t = -Math.sign(thv) * wall * Math.pow(n, stiff);   // stiffening spring
      if (n > 0.5) t += -Iax * 6 * wv;                        // damp inward momentum near the wall
      return t;
    };
    tau.x += axis(th.x, w.x, I.ixx);
    tau.y += axis(th.y, w.y, I.iyy);
    if (tier !== 'block') {
      tau.x = clampAbs(tau.x, this._coupleTauMag('x'));
      tau.y = clampAbs(tau.y, this._coupleTauMag('y'));
    }
  }

  /**
   * Partial-draw a burn resource: draw what the pool holds, up to `amount`, and return the fraction of `amount` drawn.
   * Never refuses (consume()'s all-or-nothing gate would let thrust apply for free on a near-empty battery), so the
   * caller scales thrust by the fraction. Without a ResourceSystem (menu hero, headless tests) it draws the local mirror.
   * @param {'battery'|'xenon'|'lithium'} resource
   * @param {number} amount - desired draw (> 0)
   * @param {{beam?: boolean}} [opts] - `beam: true` tags a battery draw as an ion engine's (part of it leaves in the beam, not as heat)
   * @returns {number} fraction drawn (0..1; 1 when nothing was needed)
   */
  _drawBurnResource(resource, amount, opts) {
    if (!(amount > 0)) return 1;
    const rs = this._resourceSystem;
    if (rs && typeof rs.drawUpTo === 'function') {
      return rs.drawUpTo(resource, amount, opts) / amount;
    }
    const have = Math.max(0, this.resources[resource] || 0);
    const drawn = Math.min(amount, have);
    this.resources[resource] = have - drawn;
    eventBus.emit(Events.RESOURCE_CONSUME, { resource, amount: drawn });
    return drawn / amount;
  }

  /**
   * Bill the engine gas of a burn of `dvMps` WITHOUT applying an impulse (no orbit change, no battery: the transfer
   * trip is "a burn fed by the wings"). Same Δv -> gas conversion and draw as `applyCartesianImpulse` (`ionGasUnits`:
   * ṁ = c·m_ship·Δv/(Isp·g0), active fuel, the ship's real mass). Takes what is there: a short tank is drained, not
   * refused. A short cargo fuel pays what the hold has, then the rest comes from the tank gas (the ResourceSystem
   * switches back to it and says so).
   * @param {number} dvMps - Δv the burn delivers, m/s (> 0)
   * @returns {number} fraction of the gas that was in the tank / hold (0..1; 1 when nothing was due)
   */
  billBurnGas(dvMps) {
    if (!(dvMps > 0)) return 1;
    const rs = this._resourceSystem;
    const fuel = rs
      ? rs.getCurrentFuel()
      : (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
    const amount = ionGasUnits(this, dvMps, fuel);
    if (!(amount > 0)) return 1;
    if (rs && fuel && fuel.fromCargo) {
      const cs = rs._cargoSystem;
      const entry = cs && typeof cs.getManifest === 'function'
        ? cs.getManifest().find((m) => m.metalId === fuel.cargoMetalId) : null;
      const have = entry ? Math.max(0, entry.massKg) : 0;
      if (rs.consumeIonFuel(amount)) return 1;
      // Short supply: consumeIonFuel took nothing and switched to the tank gas. Take what the hold had, then bill the
      // rest of the burn (by Δv) from the tank at the tank gas's own rate.
      const got = have > 0 && cs && typeof cs.removeMetal === 'function' ? Math.min(have, cs.removeMetal(fuel.cargoMetalId, have)) : 0;
      const frac = Math.min(1, got / amount);
      const paid = this._drawBurnResource('xenon', ionGasUnits(this, dvMps * (1 - frac), rs.getCurrentFuel()));
      return lerp(frac, 1, paid);
    }
    return this._drawBurnResource('xenon', amount);
  }

  /**
   * Rate-limited (3 s) plain-language caution when an electric drive is power-limited: no power at all, or only what
   * the solar panels put back per frame. Same cadence as _lastThrustOfflineWarning.
   * @param {'ion'|'mpd'} type
   * @param {number} fraction - fraction of the frame's power need actually drawn
   */
  _warnPowerLimited(type, fraction) {
    const now = performance.now();
    if (now - (this._lastPowerLimitedWarning || 0) < 3000) return;
    this._lastPowerLimitedWarning = now;
    const name = type === 'mpd' ? 'MPD drive' : 'ion drive';
    const text = fraction <= 0
      ? `Battery empty — ${name} has no power`
      : `Battery empty — ${name} running on solar power only (${Math.round(fraction * 100)} %)`;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION',
      text,
      priority: 'warning',
    });
  }

  /** The consumption multiplier c (see consumptionMultiplier()). */
  getConsumptionMultiplier() { return consumptionMultiplier(this); }

  /**
   * The active fuel's thrustScale (argon 0.46, xenon 1.0): `applyCartesianImpulse` multiplies its Δv by it; the
   * autopilot scales its braking rate by it.
   */
  getThrustScale() { return activeThrustScale(this); }

  /** @private remaining ΔV (m/s) from the ArmManager budget, or undefined when it is not wired */
  _telemetryDeltaV() {
    const am = this.armManager;
    if (!am || typeof am.getMassBudget !== 'function') return undefined;
    try { return am.getMassBudget().deltaV; } catch (_) { return undefined; }
  }

  get hasMPD() { return this._hasMPD; }

  // DEAD FEATURE: the MPD "Ludicrous mode" burst subsystem (heat / cooldown / lithium bookkeeping in the tick, the
  // MPD_BURST_END event, the StatusPanel HEAT row, the CodexSystem trigger, the AudioSystem disarm SFX) can no longer
  // be started: its arming verb was deleted with the manual thrust methods (the `M` key became the Debris Map). The
  // shop describes the MPD as a passive thrust upgrade (no hotkey promised); that passive gain is the live one.
  //
  // DECISION NEEDED if burst mode is wanted back: re-add an arming verb on a free key (HotkeyOverlay.HOTKEY_GROUPS +
  // README/ARCHITECTURE §6 tables + InputManager), or delete what is left (these getters, the tick bookkeeping, the
  // StatusPanel HEAT row, the CodexSystem trigger). See ARCHITECTURE.md §19 (drift register).

  get isMPDArmed() { return this._mpdArmed; }

  get mpdBurstHeat() { return this._mpdHeat; }

  /** @returns {number} Heat as fraction 0–1 of overheat threshold */
  get mpdHeatFraction() {
    return this._mpdHeat / (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40);
  }

  /** @returns {number} Seconds remaining in forced cooldown (0 = ready) */
  get mpdCooldownRemaining() { return this._mpdCooldownTimer; }

  get hasSupercap() { return this._hasSupercap; }

  /** Cumulative cathode operation time, s */
  get mpdCathodeTime() { return this._mpdCathodeTime; }

  /** Cathode health: 1.0 = new, 0.0 = fully worn */
  get mpdCathodeHealth() {
    return Math.max(0, 1 - this._mpdCathodeTime / this._mpdCathodeLife);
  }

  /**
   * Emit a cold-gas RCS burst at a nozzle mouth: a few diffuse pooled sprites that free-expand, drift along the exhaust
   * and thin out fast (a vacuum jet: no flame, no lingering smoke), randomised per burst.
   * @param {THREE.Vector3} pos — nozzle-mouth local position
   * @param {THREE.Vector3} dir — exhaust (drift) direction
   * @param {number} now — seconds (performance.now * 0.001)
   */
  _emitColdGas(pos, dir, now) {
    if (!this._rcsPuffs.length) return;
    const base = (dir && dir.lengthSq() > 1e-9)
      ? _v3TmpA.copy(dir).normalize()
      : _v3TmpA.set(0, 1, 0);
    const CLOUD = 2;   // mini-puffs per burst
    for (let k = 0; k < CLOUD; k++) {
      const puff = this._rcsPuffs[this._rcsPuffIndex];
      this._rcsPuffIndex = (this._rcsPuffIndex + 1) % this._rcsPuffs.length;

      puff.startPos.set(
        pos.x + (Math.random() - 0.5) * M * 0.012,
        pos.y + (Math.random() - 0.5) * M * 0.012,
        pos.z + (Math.random() - 0.5) * M * 0.012,
      );
      // Direction jitter: ±~8° cone spread.
      puff.dir.set(
        base.x + (Math.random() - 0.5) * 0.28,
        base.y + (Math.random() - 0.5) * 0.28,
        base.z + (Math.random() - 0.5) * 0.28,
      ).normalize();

      puff.life     = 0.22 + Math.random() * 0.12;        // 0.22–0.34 s
      puff.maxScale = M * (0.20 + Math.random() * 0.16);  // 0.20–0.36 m
      puff.baseOp   = 0.32 + Math.random() * 0.16;        // 0.32–0.48 peak
      puff.drift    = M * (0.45 + Math.random() * 0.35);  // 0.45–0.80 m along exhaust
      puff.startTime = now - k * 0.012;                   // tiny stagger between the two
      puff.rot  = Math.random() * Math.PI * 2;
      puff.spin = (Math.random() - 0.5) * 1.6;            // ±0.8 rad/s

      puff.sprite.position.copy(puff.startPos);
      puff.sprite.material.opacity = 0;
      puff.sprite.scale.set(M * 0.04, M * 0.04, M * 0.04);
      puff.sprite.visible = true;
      puff.active = true;
    }
  }

  /**
   * Muzzle FX on a mother net launch: a cold-gas puff burst at the firing pod's muzzle plus a brief plume-frustum flash
   * (the attitude plume nearest the muzzle, spiked then decayed by the normal plume loop). Puffs reuse the pooled RCS
   * sprites.
   * @param {number} podIndex
   */
  _fireNetMuzzleFx(podIndex) {
    const muzzle = this._netPodMuzzles?.[podIndex] ?? this._netPodMuzzles?.[0];
    if (!muzzle) return;
    const now = performance.now() * 0.001;
    // Exhaust forward (+Z ship-local).
    _v3TmpA.set(0, 0, 1);
    this._emitColdGas(muzzle.position, _v3TmpA, now);
    this._emitColdGas(muzzle.position, _v3TmpA, now + 0.02);
    // Plume flash: spike the attitude plume nearest the muzzle; the plume loop decays it back.
    if (this._rcsAttitudeFlash && this._rcsNozzleLocalPos) {
      let best = -1, bestD = Infinity;
      for (let k = 0; k < this._rcsNozzleLocalPos.length; k++) {
        const d = this._rcsNozzleLocalPos[k].distanceToSquared(muzzle.position);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best >= 0) this._rcsAttitudeFlash[best] = 1.25;
    }
  }

  /**
   * 4 radial retro puffs at the tether-brake moment: the brake fires the rim-weight retros INWARD (toward the cone
   * axis) to shed closing velocity, so the puffs sit at the active mother net's live position (the contact point
   * downrange) and point radially inward.
   * @param {number} podIndex
   */
  _fireNetBrakeFx(podIndex) {
    if (!this._captureNetSystem) return;
    const net = (typeof this._captureNetSystem.getActiveNetForPod === 'function')
      ? this._captureNetSystem.getActiveNetForPod(podIndex) : null;
    if (!net || !net.position) return;
    const now = performance.now() * 0.001;
    // CaptureNet position is metres → scene units; the puff pool is in the ship's LOCAL frame, so convert world → local.
    _v3TmpA.set(net.position.x * M, net.position.y * M, net.position.z * M);
    this.worldToLocal(_v3TmpA);
    // 4 radial retros 90° apart, pointing inward (cone axis ≈ +Z ship-local, so the radial plane is XY).
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      _v3TmpB.set(Math.cos(a), Math.sin(a), 0);   // radial outward (local)
      _v3TmpC.copy(_v3TmpA).addScaledVector(_v3TmpB, M * 4);  // rim radius ~4 m
      _v3TmpB.negate();                            // exhaust inward
      this._emitColdGas(_v3TmpC, _v3TmpB, now + i * 0.015);
    }
  }

  /**
   * Fire the RCS attitude couple for a pitch/yaw demand: puffs the pod nozzles that produce the torque (visual) and
   * consumes cold gas (N₂). Called per frame while an arrow key is held; rotation kinematics live in rotatePitch/rotateYaw.
   * @param {'pitch'|'yaw'} axis
   * @param {number} magnitude — 0..1 firing intensity (spring-reduced under tether)
   * @param {number} dt — frame delta (s) for propellant scaling
   */
  fireRcsRotation(axis, sign, magnitude, dt) {
    if (!this._rcsPuffs.length || !this._rcsAttitudeNozzles) return;
    const key = axis + (sign >= 0 ? 'Pos' : 'Neg');
    const nozzles = this._rcsAttitudeNozzles[key];
    if (!nozzles || !nozzles.length) return;

    // Cold-gas (N₂) cost only while propellant remains (rotation is never hard-blocked: no attitude soft-lock).
    if (magnitude > 0.01 && this.resources.coldGas > 0 && dt > 0) {
      const RCS_ATTITUDE_N2_FACTOR = Constants.ATTITUDE?.RCS_ATTITUDE_N2_FACTOR ?? 0.3;
      eventBus.emit(Events.RESOURCE_CONSUME, {
        resource: 'coldGas',
        amount: this._coldGasRate * RCS_ATTITUDE_N2_FACTOR * Math.min(1, magnitude) * dt,
      });
    }

    // Flash the couple bells' plume meshes directly from rotation demand, BEFORE the puff cooldown early-return, so a
    // held key keeps the cones lit while the cloud puffs at its own 0.12 s cadence. Decayed in _animateThrusterGlow.
    if (this._rcsAttitudeFlash && this._rcsAttitudeIdx) {
      const idx = this._rcsAttitudeIdx[key] || [];
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n];
        // First-pulse spike (valve-opening transient): from cold (<0.05) overshoot to 1.25× so the plume pops; the
        // exp(−8·dt) decay eats it in ~30 ms, then held keys re-raise to exactly `magnitude`. Do NOT clamp to 1.
        const spike = this._rcsAttitudeFlash[i] < 0.05 ? 1.25 : 1.0;
        this._rcsAttitudeFlash[i] = Math.max(this._rcsAttitudeFlash[i], magnitude * spike);
      }
    }

    const now = performance.now() * 0.001;
    const ck = `att_${key}`;
    if (this._rcsPuffLastFire[ck] && (now - this._rcsPuffLastFire[ck]) < 0.12) return;
    this._rcsPuffLastFire[ck] = now;
    const ndirs = this._rcsAttitudeDirs[key] || [];
    for (let i = 0; i < nozzles.length; i++) this._emitColdGas(nozzles[i], ndirs[i], now);
  }

  /** Cache the camera world position for cold-gas sun-scatter brightening (called each frame; no alloc). */
  setCameraWorldPos(v) {
    if (!v) return;
    this._camWorldPos ||= new THREE.Vector3();
    this._camWorldPos.copy(v);
  }

  /**
   * One counter-firing RCS stop pulse on arrow-key RELEASE. Rotation is kinematic (rotatePitch applies angle directly
   * while held), so a real craft nulls the residual rate by firing the OPPOSITE couple once. Visual only; never blocks.
   * @param {'pitch'|'yaw'} axis
   * @param {number} heldSign — the sign of the rotation that WAS held
   */
  fireRcsStopPulse(axis, heldSign) {
    if (!this._rcsPuffs.length || !this._rcsAttitudeIdx) return;
    const key = axis + (heldSign >= 0 ? 'Neg' : 'Pos');

    // Flash pop: flat 1.0 (decays in ~1/8 s via _animateThrusterGlow); deliberately not the first-pulse spike branch.
    const flash = this._rcsAttitudeFlash;
    if (flash) {
      const idx = this._rcsAttitudeIdx[key] || [];
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n];
        flash[i] = Math.max(flash[i], 1.0);
      }
    }

    // Visual only: the hold controller (_tickAttitudeDynamics, torque-proportional _frameHoldWork) bills the N₂ for the
    // arrest every frame; a fixed sip here too would double-charge.

    // One puff burst, guarded against key-repeat bounce double-fires.
    const now = performance.now() * 0.001;
    const ck = `stop_${key}`;
    if (this._rcsPuffLastFire[ck] && (now - this._rcsPuffLastFire[ck]) < 0.25) return;
    this._rcsPuffLastFire[ck] = now;
    const nozzles = this._rcsAttitudeNozzles[key] || [];
    const ndirs = this._rcsAttitudeDirs[key] || [];
    for (let i = 0; i < nozzles.length; i++) this._emitColdGas(nozzles[i], ndirs[i], now);
  }

  /** Fire RCS puff sprites opposite to the given thrust direction (round-robin pool of 8, per-nozzle cooldown). */
  _fireRcsPuff(direction) {
    if (!this._rcsPuffs.length) return;
    const now = performance.now() * 0.001; // seconds
    const cooldown = 0.12; // min seconds between puffs per nozzle
    const threshold = 0.1;

    const axes = [
      { val: direction.z, pos: 'pz', neg: 'nz' },
      { val: direction.x, pos: 'px', neg: 'nx' },
      { val: direction.y, pos: 'py', neg: 'ny' },
    ];

    for (const { val, pos, neg } of axes) {
      let nozzleKey = null;
      if (val > threshold) nozzleKey = pos;
      else if (val < -threshold) nozzleKey = neg;
      if (!nozzleKey) continue;

      if (this._rcsPuffLastFire[nozzleKey] &&
          (now - this._rcsPuffLastFire[nozzleKey]) < cooldown) continue;
      this._rcsPuffLastFire[nozzleKey] = now;
      this._emitColdGas(this._rcsPuffNozzles[nozzleKey], this._rcsPuffDirs[nozzleKey], now);
    }
  }

  /**
   * Animate active cold-gas puffs: each drifts at constant velocity, grows fast (∝√t) and fades with a quick
   * rise-then-decay (no lingering smoke).
   * @param {number} dt — frame delta (unused; uses absolute time)
   */
  _updateRcsPuffs(dt) {
    const now = performance.now() * 0.001;
    const shadowMul = this._inShadow ? 0.35 : 1;   // eclipse dimming (readability floor)

    // Sun-scatter: ONE forward-lobe factor per frame (puffs cluster within ~1 m of the craft, so one view vector
    // suffices); 1 in shadow / headless / null-sun frames.
    let scatter = 1;
    if (!this._inShadow && this._camWorldPos && this._sunDirWorld) {
      this.getWorldPosition(_v3TmpA);
      const viewDir = _v3TmpB.copy(_v3TmpA).sub(this._camWorldPos).normalize();
      const g = Math.max(0, viewDir.dot(this._sunDirWorld));
      scatter = 1 + 0.5 * g * g * g * g;                    // sharp forward lobe, max 1.5×
    }
    // Earthshine tint.
    const tint = this._inShadow ? 0x8fa0c8 : 0xcfe0ff;

    for (const puff of this._rcsPuffs) {
      if (!puff.active) continue;
      const age = now - puff.startTime;
      const life = puff.life || 0.3;

      if (age >= life) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        puff.active = false;
        continue;
      }

      const t = age / life;                 // 0 → 1
      puff.sprite.position.copy(puff.startPos).addScaledVector(puff.dir, puff.drift * t);
      const startS = M * 0.04;
      const s = lerp(startS, puff.maxScale, Math.sqrt(t));
      puff.sprite.scale.set(s, s, s);
      // Slow tumble (materials are cloned, so per-puff safe).
      puff.sprite.material.rotation = puff.rot + puff.spin * age;
      // Tint driven every frame (no restore bookkeeping).
      puff.sprite.material.color.setHex(tint);
      // Quick rise (first ~10 %), then thin out.
      const rise = Math.min(1, t / 0.1);
      const fall = Math.pow(1 - t, 1.5);
      // Scatter brightening, capped at 0.85 so stacked additive sprites can't blow out.
      puff.sprite.material.opacity = Math.min(0.85, puff.baseOp * rise * fall * shadowMul * scatter);
    }
  }

  /**
   * Each frame: read arm aim-alpha and rotate strut pivot. getAimAlpha() (0–π) maps to strut orientation:
   *   α = 0   → strut along −Z (aft / stowed alongside barrel)
   *   α = π/2 → strut radially outward (equatorial)
   *   α = π   → strut along +Z (forward / zenith)
   * i.e. d(α) = sin(α) · r̂ − cos(α) · ẑ, r̂ = (cos θ, sin θ, 0) radial-outward for azimuth θ. The pivot's local −Y axis
   * is rotated onto d(α) with `Quaternion.setFromUnitVectors()`.
   */
  _updateStruts(dt) {
    if (!this.strutGroups || !this.armManager) return;
    const arms = this.armManager.arms;
    if (!arms) return;

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const sg  = this.strutGroups[i];
      const arm = arms[i];

      // Gradual strut slew toward a target alpha (the Period key's latch in InputManager, or ArmManager's salvage /
      // recall drivers).
      if (arm._strutTargetAlpha !== undefined && arm.setAimAlpha) {
        arm.setAimAlpha(arm._strutTargetAlpha, dt);
        // Clear target when reached (0.01 rad ≈ 0.6°)
        if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
          arm._strutTargetAlpha = undefined;
        }
      }

      // Current sweep angle from the arm FSM (default π/2 = radially out)
      const alpha = (arm.getAimAlpha ? arm.getAimAlpha() : Math.PI / 2);

      // The strut hinge motor bills every frame its angle moved, whoever drove it (the latch slew above, ArmManager's
      // salvage / recall drivers, autopilot or camera aim; those run after this in the loop, so their move is billed
      // one frame later).
      if (dt > 0 && sg._billAlpha !== undefined
          && Math.abs(alpha - sg._billAlpha) >= motorMoveMinRadS() * dt) {
        billMotorW(this, Constants.MOTOR_DRAW_W?.STRUT_HINGE ?? 0, dt);
      }
      sg._billAlpha = alpha;

      // Desired strut direction (shared SSOT convention: strutLocalDirection)
      strutLocalDirection(alpha, sg.azRad, _strutTo);

      // Rotate local -Y → desired direction
      _strutQuat.setFromUnitVectors(_strutFrom, _strutTo);
      sg.pivotGroup.setRotationFromQuaternion(_strutQuat);

      // Track the arm dockOffset to the strut tip (player-local: pivot origin + strutDir * strutLen). Runs BEFORE
      // armManager.update() in the game loop, so arm._updateDocked() uses the updated dockOffset and the arm follows
      // the tip each frame.
      if (arm.dockOffset && this._strutLen !== undefined) {
        _tipLocal.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen,
        );
        arm.dockOffset.copy(_tipLocal);

        // Reel position: 85% along the strut from the pivot; the tether anchors HERE, not at the tip.
        const REEL_FRAC = 0.85;
        if (!arm._reelOffset) arm._reelOffset = new THREE.Vector3();
        arm._reelOffset.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen * REEL_FRAC,
        );

        // Cache strut direction for postArmUpdate orientation
        sg.strutDir.copy(_strutTo);
      }
    }
  }

  /**
   * Post-arm-update visibility sync. Must be called AFTER `armManager.update()` so `_updateDocked()`'s unconditional
   * `mesh.visible = false` can be overridden for docked daughter arms (always shown clamped at the strut tip).
   */
  postArmUpdate() {
    if (this._kickLx !== 0 || this._kickLy !== 0) this._flushKicks();   // this frame's kicks, billed once (before any early return)
    if (!this.armManager || !this.strutGroups) return;
    const arms = this.armManager.arms;
    if (!arms) return;
    this._reelPushSweep();   // a reel that ended without the latch hands over what it had gathered

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const arm = arms[i];
      const sg  = this.strutGroups[i];

      // Hinge LEDs: amber in the high-recoil zone, green otherwise
      if (this.hingeLEDs && this.hingeLEDs[i]) {
        const led = this.hingeLEDs[i];
        const isRecoil = arm.isHighRecoilZone ? arm.isHighRecoilZone() : false;
        led.material.color.setHex(isRecoil ? 0xff6600 : 0x00ff44);
      }

      // Only DOCKED arms (strut-mounted) get visibility + orientation overridden here; other FSM states (TRANSIT,
      // HAULING, ...) manage their own visuals. Exceptions, so a SINGLE owner composes the strut basis (live
      // sg.strutDir/azRad + mother world quat) and avoids the override-fight bug class (CONVENTIONS.md §10 Rule B):
      //   • LAUNCHING (pre-spring): still clamped to the strut — track it, else the daughter counter-rotates as the
      //     ceremony slews the strut to target.
      //   • DOCKING: slerp onto the strut basis over the dock window — no orientation pop at RELOADING→DOCKED.
      //   • HOLDING_CATCH: snap to the strut basis every frame (like DOCKED) so the parked daughter holds the catch
      //     square to her strut instead of drifting toward the raw mother-bus quaternion.
      if (arm.state !== ARM_STATES.DOCKED) {
        const trackStrut =
          (arm.state === 'LAUNCHING' && !arm._springFired) ||
          arm.state === ARM_STATES.DOCKING ||
          arm.state === ARM_STATES.RELOADING ||   // she keeps turning with the strut while she reloads (DOCKED snapped her)
          arm.state === ARM_STATES.HOLDING_CATCH;
        if (trackStrut && arm.group && sg.strutDir.lengthSq() > 0) {
          _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);
          _armDockTargetQuat.copy(this.quaternion).multiply(_armQuat);
          if (arm.state === ARM_STATES.DOCKING || arm.state === ARM_STATES.RELOADING) {
            // Exponential approach onto the strut over the ~3 s dock window; time-based (0.12/frame at 60 Hz, converges
            // in <1 s) so at a low frame rate or in time warp she doesn't trail, then snap at DOCKED.
            const dtA = Math.min(Math.max(arm._lastDt > 0 ? arm._lastDt : 1 / 60, 0), 0.5);
            arm.group.quaternion.slerp(_armDockTargetQuat, 1 - Math.pow(0.88, dtA * 60));
          } else {
            arm.group.quaternion.copy(_armDockTargetQuat);
          }
          // ArmUnit._updateTether already baked tetherLine.quaternion = group.quaternion⁻¹ during armManager.update(),
          // BEFORE the quat change above: re-sync so the tether isn't counter-rotated by this frame's slerp delta
          // (worst at DOCKING entry, pose error up to ~180°). Single-owner rule (CONVENTIONS.md §10 Rule B): this
          // block owns the quat for these states, so it also owns the tether counter-quat.
          if (arm.tetherLine && arm.tetherLine.visible) {
            arm.tetherLine.quaternion.copy(arm.group.quaternion).invert();
          }
        }
        continue;
      }

      if (arm.mesh) arm.mesh.visible = true;

      // Orient arm.group so its +Z (forward) faces outward along the strut direction (player-local strutDir) in world
      // space; compose the mother's full quaternion so the arm inherits pitch/yaw/roll, not just the forward axis.
      // SYMMETRY: the deterministic basis (forward + azimuth-radial up) rather than setFromUnitVectors, so every docked
      // daughter shares one roll convention and body-conformal cells / panel lines stay symmetric around the ring.
      if (arm.group && sg.strutDir.lengthSq() > 0) {
        _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);  // local strut rotation
        arm.group.quaternion.copy(this.quaternion).multiply(_armQuat);
      }
    }
  }

  /**
   * Apply a world-frame Cartesian ΔV impulse to the orbit. Used by AutopilotSystem to command rendezvous burns
   * independent of the element-rate channel mapping in `_applyThrust()`, which is tuned for manual thrust feel.
   *
   * Takes the current Cartesian state (km / km/s), adds the impulse (m/s → km/s), recomputes Keplerian elements via
   * `cartesianToKeplerian()` and writes them back: the closed-form equivalent of the Gauss planetary equations, without
   * `_applyThrust`'s approximations.
   *
   * Side-effects: mutates `this.orbit`, refreshes `this._cartesian`, charges fuel/battery, accumulates `_deltaVSpent`.
   * Does NOT touch `_rcsVelocity`. The billed path obeys the electric-engine power law: the impulse scales by the
   * fraction of its power draw the battery actually holds; dt = 0 physics responses (recoil compensations) draw no
   * power but still pay for their gas.
   *
   * Same watts, less push: a billed burn applies the ACTIVE fuel's thrustScale (argon 0.46, krypton 0.67, xenon 1.0) to
   * the Δv as well as the power fraction; the power draw per tick is unchanged and the gas is billed once for the Δv
   * actually applied (see ionGasUnits). A `noBill` call is NOT the engine (the net tug is passive momentum transfer),
   * so it is exempt.
   *
   * @param {THREE.Vector3} dvWorld - World-frame ΔV in m/s
   * @param {number} dt - Frame delta (s) for resource bookkeeping
   * @param {object} [opts]
   * @param {boolean} [opts.noBill=false] — skip fuel/battery billing AND the resource/power gates (the line-taut net tug
   *   is passive momentum transfer: no propellant, so an empty tank or powered-down bus must not refuse it).
   * @param {boolean} [opts.continuous=false] — this Δv is a burn spread over `dt` (the autopilot's per-frame thrust): the
   *   power bill is scaled to the frame, so the Wh per second does not depend on the frame rate. A one-shot (the dodge)
   *   leaves it off.
   * @param {boolean} [opts.dodge=false] — the collision-avoidance dodge: it burns even while a daughter's catch is
   *   lowered for a mother net (the Hall-drive wait of `netDuckHold`); every other billed burn waits for her.
   * @param {boolean} [opts.quiet=false] — a passive pull with no exhaust (the line tension from a reeling daughter): no
   *   RCS puff, no THRUST_VISUAL streaks, not counted in `_deltaVSpent` (she spent nothing). Only meaningful with `noBill`.
   * @returns {boolean} true when the impulse was applied; false when refused (envelope guard, degenerate orbit, or —
   *   with billing on — resource gates). Callers that keep the Δv (the tug) must surface a false return honestly
   *   ("tug damped — envelope limit") rather than lying about kept Δv.
   */
  applyCartesianImpulse(dvWorld, dt, opts = {}) {
    if (!dvWorld) return false;
    const dvMag = dvWorld.length();
    if (dvMag < 1e-9 || !isFinite(dvMag)) return false;
    const noBill = opts.noBill === true;
    const quiet = noBill && opts.quiet === true;
    // The engine's push per watt; the tug (noBill) is momentum, not the engine -> 1.
    const thrustScale = noBill ? 1 : activeThrustScale(this);

    // Burn sizing (billed path only): this impulse's share of one ion-thrust tick; needed up front because the
    // electric-engine power law below scales the Δv itself.
    let usage = 1.0;
    let powerNeed = 0;
    if (!noBill) {
      const baselineDv_mps =
        (this._ionDeltaV || 0.0003) * (this.throttleLevel || 1) * 1000; // rough m/s per tick proxy
      // A continuous burn (the autopilot's per-frame thrust) is a Δv spread over dt, so the per-tick proxy scales to
      // this frame.
      const perTick = (opts.continuous === true && dt > 0)
        ? baselineDv_mps * (dt / (this._ionBillTickS || 1 / 60))
        : baselineDv_mps;
      usage = perTick > 1e-6
        ? Math.min(5.0, dvMag / perTick)
        : 1.0;
      powerNeed = this._ionThrustPowerRate * dt * usage;
    }

    // Resource / power gating, skipped for a no-bill passive impulse (the tug needs no ion drive and no propellant).
    let powerFraction = 1;   // no-bill paths and dt = 0 physics responses draw nothing
    if (!noBill) {
      if (powerDistribution.thrustMultiplier <= 0) {
        const now = performance.now();
        if (now - this._lastThrustOfflineWarning > 3000) {
          this._lastThrustOfflineWarning = now;
          eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'CAUTION: ION DRIVE OFFLINE. Increase THRUST power allocation',
            priority: 'warning',
          });
        }
        return false;
      }
      // The interlock refuses BEFORE billing, the Δv write, the puff and the THRUST_VISUAL emit: nothing downstream
      // sees a burn. A folded radiator is told to the player.
      if (this._thrusterInterlock) { this._warnFlowerThrustInhibit('FEEP'); return false; }
      // A daughter whose strut is down for an inbound net (or still climbing back) has her catch below her plume-clear
      // hold pose, i.e. in the exhaust (owner 2026-10-22: a held catch "should move out of the way of
      // mother net"): the Hall drive waits until she is back. The caller's burn is refused this time (the autopilot asks
      // again next frame; cold gas is a different path); dt = 0 callers are the recoil compensations of a launch, not
      // burns. One line per duck. A collision dodge (`opts.dodge`, "dodge wins") is never held: a ducked catch in the
      // exhaust is the lesser harm.
      if (dt > 0 && opts.dodge !== true) {
        const am = this.armManager;
        const low = am && typeof am.netDuckHold === 'function' ? am.netDuckHold() : -1;
        if (low >= 0) { this._warnNetDuckThrust(am, low); return false; }
      }
      // Electric engine: the battery pays what it holds, up to this burn's need, and the impulse scales by that
      // fraction. PEEK only: the draw happens after the envelope accepts the burn, so a refused burn never pays.
      const available = Math.max(0, this.resources.battery || 0);
      powerFraction = powerNeed > 0 ? Math.min(1, available / powerNeed) : 1;
      if (powerFraction <= 0) {
        this._warnPowerLimited('ion', 0);
        eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_power', type: 'ion' });
        return false;
      }
      if (powerFraction < 1) this._warnPowerLimited('ion', powerFraction);
      const fuel = this._resourceSystem
        ? this._resourceSystem.getCurrentFuel()
        : (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
      if (fuel && !fuel.fromCargo && this.resources.xenon <= 0) {
        eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
        return false;
      }
    }

    // Cartesian state (km / km/s) from the current orbit
    const pos = this._cartesian.position;   // scene units
    const vel = this._cartesian.velocity;   // km/s (unchanged by orbitToSceneCartesian)

    const rKm = {
      x: pos.x / Constants.SCENE_SCALE,
      y: pos.y / Constants.SCENE_SCALE,
      z: pos.z / Constants.SCENE_SCALE,
    };
    // Add impulse (m/s → km/s), scaled by the power actually available (1 for a no-bill impulse or a dt = 0 physics
    // response, which draw none) and by the fuel's push per watt (1 for no-bill).
    const dvScale = powerFraction * thrustScale;
    const vKms = {
      x: vel.x + dvWorld.x * 0.001 * dvScale,
      y: vel.y + dvWorld.y * 0.001 * dvScale,
      z: vel.z + dvWorld.z * 0.001 * dvScale,
    };

    const newOrbit = cartesianToKeplerian(rKm, vKms);
    if (!isFinite(newOrbit.semiMajorAxis) || newOrbit.semiMajorAxis <= 0) return false;

    // Altitude guard (same envelope as _applyThrust)
    const newSmaScene = newOrbit.semiMajorAxis * Constants.SCENE_SCALE;
    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    if (newSmaScene < minAlt || newSmaScene > maxAlt) {
      // Refuse the burn rather than silently clip — keeps orbital energy accounting honest
      return false;
    }

    this.orbit.semiMajorAxis = newSmaScene;
    this.orbit.eccentricity = clamp(newOrbit.eccentricity, 0, 0.1);
    this.orbit.inclination = newOrbit.inclination;
    this.orbit.raan = newOrbit.raan;
    this.orbit.argPerigee = newOrbit.argPerigee;
    this.orbit.trueAnomaly = newOrbit.trueAnomaly;
    this.orbit.meanMotion = newOrbit.meanMotion;

    // Refresh cached Cartesian so subsequent getVelocity/getPosition reads see the new state
    this._cartesian = orbitToSceneCartesian(this.orbit);

    // Only the Δv actually applied counts (a quiet passive pull spent nothing)
    if (!quiet) this._deltaVSpent += dvMag * dvScale;

    // The battery pays what it holds (drawn only now, once the envelope accepted the burn); the engine gas is billed
    // for the thrust that actually happened. Skipped for a no-bill passive impulse (mother-net tug). dt = 0 physics
    // responses (recoil compensations) draw no power (powerNeed 0) but DO pay for their gas.
    if (!noBill) {
      if (powerNeed > 0) this._drawBurnResource('battery', powerNeed, { beam: true });
      const fuel = this._resourceSystem
        ? this._resourceSystem.getCurrentFuel()
        : (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
      // Billed once, from the Δv actually applied (dvMag·dvScale m/s: power fraction and thrustScale are in dvScale)
      const fuelAmount = ionGasUnits(this, dvMag * dvScale, fuel);

      if (this._resourceSystem && fuel && fuel.fromCargo) {
        this._resourceSystem.consumeIonFuel(fuelAmount);
      } else {
        this._drawBurnResource('xenon', fuelAmount);
      }
    }

    // Visual: RCS puff opposite to the impulse direction (local frame). A quiet passive pull has no exhaust: no puff, no streaks.
    if (quiet) return true;
    const localDir = dvWorld.clone().applyQuaternion(
      this.quaternion.clone().invert()
    ).normalize();
    this._fireRcsPuff({ x: localDir.x, y: localDir.y, z: localDir.z });

    // Velocity-streaks visual (magnitude reflects the power actually drawn)
    const dirTag = Math.abs(localDir.z) > Math.max(Math.abs(localDir.x), Math.abs(localDir.y))
      ? (localDir.z > 0 ? 'prograde' : 'retrograde')
      : 'lateral';
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: Math.min(1, dvMag * dvScale * 0.5),
      direction: dirTag,
      type: 'ion',
    });

    return true;
  }

  _applyThrust(gameDt) {
    const ti = this.thrustInput;
    let mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    if (mag < 1e-12) {
      ti.x = ti.y = ti.z = 0;
      return;
    }

    // CARGO translational mass, wherever it sits: ONE massFactor scales ti AND mag at the top (the CoM-leak block below
    // reads mag, and _deltaVSpent += mag happens first, so both must see the laden value). The clamp is NOT optional:
    // raw (130+5000)/130 ≈ 39× and 23 t ≈ 178× would leave thrust authority at 0.5–2.5% (a soft-lock). Translation
    // only: rotation is rigid-body DYNAMIC and reads the inertia SSOT, which already carries cargo, so this must NEVER
    // scale rotation. applyCartesianImpulse is deliberately not cargo-scaled (the AP models RCS/station-keeping, not
    // the main engine: RCS translation stays brisk while main thrust is heavy) but IS scaled by the fuel's thrustScale.
    // this.mass is her LIVE total (cargo included), so the cargo-free mass below is massExcludingCargoKg(), never
    // this.mass. Cargo aboard (berthed + daughter racks) comes from the ArmManager.getCargoMassKg SSOT, the same
    // quantity getMassBudget folds into ΔV, so handling and range agree; legacy mocks without the accessor fall back
    // to the berthed-only read.
    const massFactor = cargoThrustFactor(this);   // one definition, shared with the gas billing
    if (massFactor !== 1) {
      ti.x *= massFactor; ti.y *= massFactor; ti.z *= massFactor;
      mag *= massFactor;
    }

    // Accumulate ΔV spent (mag is the actual |Δv| applied this tick)
    this._deltaVSpent += mag;

    const aKm = this.orbit.semiMajorAxis / Constants.SCENE_SCALE;
    const v = orbitalVelocity(aKm, aKm, Constants.MU_EARTH);

    if (Math.abs(ti.z) > 1e-14) {
      const da = 2 * aKm * ti.z / v;
      this.orbit.semiMajorAxis += da * Constants.SCENE_SCALE;
    }

    if (Math.abs(ti.y) > 1e-14) {
      this.orbit.inclination += ti.y / v;
    }

    if (Math.abs(ti.x) > 1e-14) {
      this.orbit.eccentricity += ti.x / (2 * v);
      this.orbit.eccentricity = clamp(this.orbit.eccentricity, 0, 0.1);
    }

    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    this.orbit.semiMajorAxis = clamp(this.orbit.semiMajorAxis, minAlt, maxAlt);

    ti.x = ti.y = ti.z = 0;
  }

  _updateCartesian() {
    this._cartesian = orbitToSceneCartesian(this.orbit);
  }

  _applyPosition() {
    const p = this._cartesian.position;
    this.position.set(p.x, p.y, p.z);
  }

  /**
   * Attitude ownership arbiter: derives the single current attitude owner from existing signals (no new state). Order
   * matters: AUTOPILOT and AIM take the quaternion directly, then the close-inspection CINEMATIC hold, else PLAYER.
   * Stored on `_attitudeOwner`; the previous value stays on `_prevAttitudeOwner` so the dynamics can detect handback
   * edges.
   * @returns {'PLAYER'|'AUTOPILOT'|'AIM'|'CINEMATIC'}
   */
  _updateAttitudeOwner() {
    let owner;
    if (this.autopilotEngaged) owner = 'AUTOPILOT';
    else if (this.aimHold) owner = 'AIM';
    else if (this._hullInspectView || this._hullInspectZoom) owner = 'CINEMATIC';
    else owner = 'PLAYER';
    this._prevAttitudeOwner = this._attitudeOwner;
    this._attitudeOwner = owner;
    return owner;
  }

  /**
   * Exact prograde attitude quaternion (nose +Z along velocity, panel +Y along the radial): lookAt with eye = pos +
   * velDir, target = pos → +Z = velDir.
   * @param {THREE.Quaternion} out
   * @returns {THREE.Quaternion|null} out, or null when velocity is ~0
   */
  _progradeQuat(out) {
    const v = this._cartesian.velocity;
    const vLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (vLen < 1e-10) return null;
    const velDir = _v3TmpA.set(v.x, v.y, v.z).divideScalar(vLen);
    const radial = _v3TmpB.copy(this.position).normalize();
    const eye = _v3TmpC.copy(this.position).add(velDir);
    _matAtt.lookAt(eye, this.position, radial);
    return out.setFromRotationMatrix(_matAtt);
  }

  /** Orient the satellite so +Z faces the velocity direction, then apply the manual rotation offset. */
  _orientAlongVelocity() {
    // Owner: already resolved (with handback) by _tickAttitudeDynamics this frame.
    const owner = this._attitudeOwner || 'PLAYER';

    // AUTOPILOT and AIM write this.quaternion directly (slerp): leave it. Exception: AUTOPILOT-owned headings kept in
    // the orbit frame (the transfer trip's hold, prograde follow above warp 1) recompose prograde · _manualRotation
    // below (a direct world-frame write cannot follow the orbit at 100x).
    if (owner === 'AIM') return;
    if (owner === 'AUTOPILOT' && !this._orbitFrameHold) return;

    // Rigid-body path: base = EXACT prograde, no slerp, no decay; the offset (_manualRotation) is advanced by the
    // integrator in _tickAttitudeDynamics. Applies to PLAYER and the CINEMATIC inspect hold.
    const pg = this._progradeQuat(_qAttA);
    if (pg) this.quaternion.copy(pg).multiply(this._manualRotation).normalize();
    else this.quaternion.copy(this._manualRotation).normalize();
    this._recoilApplied = false;   // the rebuild dropped last frame's recoil overlay with the rest
  }

  /**
   * Take the recoil overlay that `update()` multiplied onto `this.quaternion` last frame off again, then forget it.
   * Exact (it came on the right, so it comes off on the right), idempotent, and a no-op once the quaternion has been
   * rebuilt or when no shake is on. Callers: the overlay block of `update()` (before this frame's goes on),
   * `_handAttitudeToPlayer` (so no overlay is folded into `_manualRotation`), an owner change, and the
   * AutopilotSystem (before its slew and its aim / turn writes).
   */
  undoRecoilOverlay() {
    if (!this._recoilApplied) return;
    this._recoilApplied = false;
    this.quaternion.multiply(this._qRecoilUndo.copy(this._qRecoilApplied).invert()).normalize();
  }

  /**
   * Each surface earns its own power from its own real area × incidence (DECISIONS §10, "power follows the panels,
   * realistic wins"), not one generic area scaled by a table peak.
   * Wings: real area × incidence (from the ACTUAL current pivot tilt, which already blends toward edge-on under
   * feather — see _rosaDesiredTilt — so a separate feather multiplier would double-count it) × furl (the wrapper's own
   * scale.x) × the shop solarEfficiency upgrade × wing health.
   * Body: _computeBodyPowerW sums the built cells, each area × incidence × a throttled shading estimate × the same
   * upgrade × body health, kept separate from wing health (DECISIONS §10: "body cells must keep working when the wings
   * are damaged, furled or edge-on").
   * @param {number} [dt=0] — seconds since last frame (throttles body shading)
   */
  _updateSolarPower(sunDirection, dt = 0) {
    if (!sunDirection) {
      this.resources.solarRate = 0;
      this._inShadow = false;   // keep the eclipse cache safe when sun dir is unavailable
      return;
    }

    const pos = this._cartesian.position;
    const sunDir = { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z };
    const inShadow = isInShadow(pos, sunDir, Constants.EARTH_RADIUS);
    this._inShadow = inShadow;   // cache for puff/plume eclipse dimming

    if (inShadow) {
      this.resources.solarRate = 0;
      return;
    }

    const effMult = this.resources.solarEfficiencyMult ?? 1;
    const efficiency = Constants.SOLAR_PANEL_EFFICIENCY * effMult;
    const wingHealth = this.resources.solarPanelHealth ?? 1;
    const bodyHealth = this.resources.bodyPanelHealth ?? 1;

    const wingAreaEachM2 = Constants.OCTOPUS_V5.ROSA_WIDTH * Constants.OCTOPUS_V5.ROSA_LENGTH;
    let wingPowerW = 0;
    const wingPairs = [
      [this.panelRightPivot, this._rosaPanelWrapper1],
      [this.panelLeftPivot, this._rosaPanelWrapper2],
    ];
    for (const [pivot, wrapper] of wingPairs) {
      if (!pivot || !wrapper) continue;
      // The panel's own outward normal, ship-local, is (0, cos(tilt), sin(tilt)): the relation _rosaDesiredTilt's atan2
      // solves for (from the wrapper's -90° X rotation feeding the pivot's rotation.x; both wings track the same
      // target). No separate feather term: tiltR IS the real current angle, already blended toward edge-on.
      const tiltR = pivot.rotation.x;
      _v3TmpA.set(0, Math.cos(tiltR), Math.sin(tiltR)).applyQuaternion(this.quaternion);
      const incidence = Math.max(0, _v3TmpA.dot(sunDirection));
      // The deployed fraction of the blanket, not the wrapper's scale: scale.x keeps a 5 % visual stub when rolled up
      // (_setRosaWingProgress), and a rolled-up wing makes nothing.
      const furl = clamp01((wrapper.scale.x - 0.05) / 0.95);
      wingPowerW += Constants.SOLAR_FLUX * efficiency * wingAreaEachM2 * incidence * furl;
    }
    wingPowerW *= wingHealth;

    const bodyPowerW = this._computeBodyPowerW(sunDirection, dt, efficiency) * bodyHealth;

    this.resources.solarRate = wingPowerW + bodyPowerW;
  }

  /**
   * Sum the built body-mount cells (`BarrelSolarPanel_*`, built by `_buildMainBus`; only read here): each contributes
   * area × efficiency × flux × max(0, cos(sun, cell normal)) × a shading estimate. The cos term is one dot product per
   * cell and runs every call; the shading raycast (wings/struts+daughters/radiator) is throttled to
   * `BODY_SHADE_UPDATE_S` (≤ 2 Hz) and cached between updates. Cells facing away from the sun skip the raycast.
   * @param {number} efficiency — SOLAR_PANEL_EFFICIENCY × the shop upgrade mult
   * @returns {number} watts, before body health
   */
  _computeBodyPowerW(sunDirection, dt, efficiency) {
    if (!this._bodyCells) this._discoverBodyCells();
    const cells = this._bodyCells;
    if (cells.length === 0) return 0;

    this._bodyShadeTimer = (this._bodyShadeTimer ?? 0) + Math.max(0, dt);
    const updateShade = this._bodyShadeTimer >= Constants.OCTOPUS_V5.BODY_SHADE_UPDATE_S
      || this._solarOccluders === undefined;
    if (updateShade) {
      this._bodyShadeTimer = 0;
      this._solarOccluders = this._gatherSolarOccluders();
    }

    const flux = Constants.SOLAR_FLUX;
    let totalW = 0;
    for (const cell of cells) {
      cell.mesh.getWorldPosition(_v3TmpB);
      _v3TmpC.setFromMatrixColumn(cell.mesh.matrixWorld, 2).normalize();   // outward face normal
      const incidence = Math.max(0, _v3TmpC.dot(sunDirection));
      if (incidence <= 0) { cell.unshaded = 0; continue; }
      if (updateShade || cell.unshaded === undefined) {
        cell.unshaded = this._isPointUnshaded(_v3TmpB, sunDirection) ? 1 : 0;
      }
      totalW += flux * efficiency * cell.areaM2 * incidence * cell.unshaded;
    }
    return totalW;
  }

  /** Discover the built body-mount cells once and cache {mesh, areaM2} per cell (reads `_buildMainBus`'s layout only). */
  _discoverBodyCells() {
    this._bodyCells = [];
    this.traverse((o) => {
      if (o.isMesh && /^BarrelSolarPanel_/.test(o.name || '')) {
        const p = o.geometry && o.geometry.parameters;
        if (!p) return;
        const areaM2 = (p.width / M) * (p.height / M);
        this._bodyCells.push({ mesh: o, areaM2, unshaded: undefined });
      }
    });
  }

  /**
   * The shading occluder list for the throttled body-cell raycast: both wing panel faces (Front=FrontSide +
   * Back=BackSide, so a ray hitting the outboard or inboard face registers; one alone misses half the approach
   * directions), every strut arm's group (struts + any docked daughter), and every radiator/flower hinge group,
   * flattened to their visible solid meshes. Rebuilt each time the 2 Hz shade throttle fires.
   * @returns {THREE.Object3D[]}
   */
  _gatherSolarOccluders() {
    const roots = [];
    for (const name of ['ROSA_Panel_Front_0deg', 'ROSA_Panel_Back_0deg',
                         'ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg']) {
      const o = this.getObjectByName(name);
      if (o) roots.push(o);
    }
    if (this.armManager && Array.isArray(this.armManager.arms)) {
      for (const arm of this.armManager.arms) if (arm && arm.group) roots.push(arm.group);
    }
    if (Array.isArray(this._flowerGroups)) {
      for (const fg of this._flowerGroups) if (fg && fg.hinge) roots.push(fg.hinge);
    }
    // Flatten to the visible SOLID meshes only, so the cast can run non-recursive. Sprites (labels, LED halos) throw
    // inside Raycaster without a camera (menu-boot), Lines/Points would "shade" via the ray's pick threshold, and
    // additive glow shells are light, not matter.
    const list = [];
    for (const root of roots) {
      root.updateWorldMatrix(true, true);   // the renderer refreshes matrixWorld after player.update moves the ship: this root's matrices are last frame's
      root.traverseVisible((o) => {
        if (!o.isMesh || o.isSprite) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.blending === THREE.AdditiveBlending) return;
        if (o.userData && o.userData.noSolarShade) return;   // mm-scale panel/hinge detail never shades a cell
        list.push(o);
      });
    }
    return list;
  }

  /**
   * True if nothing in `_solarOccluders` sits between `worldPos` (scene units) and the sun (`sunDirection`: unit
   * vector, world frame) within `BODY_SHADE_MAX_DIST_M`. The origin is nudged along the ray so the cast doesn't graze
   * the cell's own (excluded) box.
   */
  _isPointUnshaded(worldPos, sunDirection) {
    const occluders = this._solarOccluders;
    if (!occluders || occluders.length === 0) return true;
    _v3TmpD.copy(sunDirection).normalize();
    _v3TmpA.copy(worldPos).addScaledVector(_v3TmpD, 0.01 * M);   // 10 mm nudge (M = scene units/metre)
    _solarRaycaster.set(_v3TmpA, _v3TmpD);
    _solarRaycaster.far = Constants.OCTOPUS_V5.BODY_SHADE_MAX_DIST_M * M;
    const hits = _solarRaycaster.intersectObjects(occluders, false);   // pre-flattened in _gatherSolarOccluders
    return hits.length === 0;
  }

  _updateResources(dt, skipBilling = false) {
    // Base power draw routed through ResourceSystem (canonical owner); nothing on an off-play frame (skipBilling).
    const powerDraw = this._basePowerDraw * dt;
    if (powerDraw > 0 && skipBilling !== true) {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: powerDraw });
    }

    // Low-resource warnings (reads from player.resources, pushed by ResourceSystem)
    if (this.resources.battery < 10) {
      eventBus.emit(Events.PLAYER_LOW_BATTERY, { level: this.resources.battery, batteryMax: this.resources.batteryMax });
    }
    // "Low" is MASS against the base argon tank scaled by the tank size, the same for every gas (xenon's 12.48 kg must
    // not read 9.7 % of its own 129 kg tank). `level` stays a percent of the base tank (CommsSystem turns it into the
    // printed percent with / XENON_FUEL_MAX).
    const gasFrac = engineGasLowFrac(this.resources);
    if (gasFrac < 0.10) {
      eventBus.emit(Events.PLAYER_LOW_XENON, { level: gasFrac * 100 });
    }
    this._updateSteeringGasLow();
  }

  /**
   * One "steering gas low" line when the cold-gas tank falls below COLD_GAS_LOW_FRAC of its capacity (the HUD gas meter
   * turns amber at the same fraction). Once per crossing: a latch, re-armed only after the tank is back above
   * COLD_GAS_LOW_REARM_FRAC (a refill), like the heat warnings (ThermalSystem._updateLines). Sent straight to
   * COMMS_MESSAGE with `_critical` (so mission 1 hears it), not through PLAYER_LOW_* + the 15 s `_canSend` cooldown,
   * which would repeat it. Never at game start (the tank starts at PROPELLANT_START_FRACTION). What the line says is
   * true: the gas is spent by turning the ship (the AutopilotSystem aim path → fireRcsRotation, and every
   * `requestAttitudeTurn`).
   */
  _updateSteeringGasLow() {
    const r = this.resources;
    const gas = Number(r && r.coldGas);
    if (!Number.isFinite(gas)) return;
    const max = Number(r.coldGasMax) > 0 ? Number(r.coldGasMax) : Constants.COLD_GAS_MAX;
    const frac = gas / max;
    if (!this._steeringGasLowSaid) {
      if (frac < Constants.COLD_GAS_LOW_FRAC) {
        this._steeringGasLowSaid = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'SPACECRAFT',
          text: 'Steering gas low: about a quarter left. Aiming the net and turning the ship use it.',
          priority: 'warning',
          _critical: true,
        });
      }
    } else if (frac > Constants.COLD_GAS_LOW_REARM_FRAC) {
      this._steeringGasLowSaid = false;
    }
  }

  /**
   * Consume a resource via ResourceSystem (eventBus). `resources` is a read-only view; ResourceSystem is the canonical
   * owner and pushes updated values back via _syncToPlayer().
   * @param {string} type - 'xenon' | 'coldGas' | 'battery'
   * @returns {boolean}
   */
  consumeResource(type, amount) {
    if (this.resources[type] === undefined) return false;
    if (this.resources[type] <= 0) {
      return false;
    }

    eventBus.emit(Events.RESOURCE_CONSUME, { resource: type, amount });
    return true;
  }

  /**
   * Cosmetic launch-recoil kick on the hull mesh: `offset` (scene units, world space, opposite the launch direction) is
   * added to the rendered position next frame and springs back to zero. VISUAL ONLY: no orbit/fuel/RCS change. See
   * _recoilOffset in the constructor + update().
   * @param {THREE.Vector3} offset
   */
  applyCosmeticRecoil(offset) {
    if (offset) this._recoilOffset.copy(offset);
  }

  /** @returns {THREE.Vector3} */
  getPosition() {
    return this.position.clone();
  }

  /** @returns {{ x: number, y: number, z: number }} */
  getVelocity() {
    return { ...this._cartesian.velocity };
  }

  toggleEDT() {
    if (!this._edtActive && !this._edtDeployed) {
      this._edtDeployed = true;
      this._edtDeployTimer = 0;
      this._edtActive = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'Deploying electrodynamic tether...', priority: 'info',
      });
    } else if (this._edtActive) {
      this._edtDeployed = false;
      this._edtActive = false;
      eventBus.emit(Events.EDT_RETRACT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT retracted', priority: 'info',
      });
    } else if (this._edtDeployed && !this._edtActive) {
      this._edtDeployed = false;
      this._edtDeployTimer = 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT deployment cancelled', priority: 'info',
      });
    }
  }

  isEDTActive() { return this._edtActive; }

  /** @returns {boolean} Whether EDT is deployed (may still be deploying) */
  isEDTDeployed() { return this._edtDeployed; }

  getOrbitalElements() {
    return { ...this.orbit };
  }

  getAltitudeKm() {
    return (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
  }

  /** @returns {number} Cumulative ΔV spent in km/s game units */
  getDeltaVSpent() {
    return this._deltaVSpent;
  }

  /** @returns {string|null} 'prograde' | 'retrograde' | 'lateral' | null */
  getThrustDirection() {
    return this._thrustDirection;
  }

  /** @returns {string|null} 'ion' | 'coldgas' | null */
  getLastThrustType() {
    return this._lastThrustType;
  }

  /**
   * Onboarding "struts" beat helper: briefly brightens every strut's emissive channel to a cyan glow so the player sees
   * what their `,` / `.` keypress just animated. Self-clears after `durationMs`; calling again while a highlight is
   * live extends the timer (idempotent). Glow only: no labels rendered here.
   * @param {number} [durationMs=4000]
   * @returns {boolean} true if struts exist and the highlight was applied
   */
  highlightStrutsForBeat(durationMs = 4000) {
    if (!Array.isArray(this.strutMeshes) || this.strutMeshes.length === 0) return false;
    // Mesh materials may be shared across all struts — collect the unique set.
    const uniqueMats = new Set();
    for (const s of this.strutMeshes) {
      if (s && s.material) uniqueMats.add(s.material);
    }
    if (uniqueMats.size === 0) return false;
    // Record original emissive values once, to restore.
    if (!this._strutEmissiveOriginal) {
      this._strutEmissiveOriginal = new Map();
      for (const m of uniqueMats) {
        if (m.emissive && typeof m.emissive.clone === 'function') {
          this._strutEmissiveOriginal.set(m, m.emissive.clone());
        }
      }
    }
    for (const m of uniqueMats) {
      if (m.emissive && typeof m.emissive.setRGB === 'function') {
        m.emissive.setRGB(0.05, 0.55, 0.75);
        m.emissiveIntensity = 1.0;
        m.needsUpdate = true;
      }
    }
    if (this._strutHighlightTimer != null && typeof clearTimeout === 'function') {
      clearTimeout(this._strutHighlightTimer);
    }
    if (typeof setTimeout === 'function') {
      this._strutHighlightTimer = setTimeout(() => {
        this._strutHighlightTimer = null;
        const orig = this._strutEmissiveOriginal;
        if (!orig) return;
        for (const [m, c] of orig) {
          if (m && m.emissive && typeof m.emissive.copy === 'function') {
            m.emissive.copy(c);
            m.needsUpdate = true;
          }
        }
      }, durationMs);
    }
    // Emit strut-labels event so StrutLabels overlay can visualize tip positions: each entry carries the authoritative
    // hingeAngleDeg from the partner arm's aimAlpha (the real sweep angle, not the legacy Euler-magnitude proxy); 0° when
    // an arm slot is empty.
    const arms = this.armManager?.arms || [];
    const sgPayload = (this.strutGroups || []).map((sg, i) => {
      const arm = arms[i];
      const alphaRad = (arm && typeof arm.getAimAlpha === 'function')
        ? arm.getAimAlpha()
        : 0;
      return {
        pivotGroup: sg.pivotGroup,
        strut:      sg.strut,
        tipNode:    sg.tipNode,
        azRad:      sg.azRad,
        hingeAngleDeg: Math.round(alphaRad * RAD2DEG),
      };
    });
    eventBus.emit(Events.STRUT_LABELS_SHOW, {
      strutGroups: sgPayload,
      durationMs,
    });
    return true;
  }
}

export default PlayerSatellite;
