/**
 * armPlumeModel.js — PURE state→plume mapping for the daughter FEEP visuals
 * (wave1-daughter-plumes). Node-testable SSOT: no THREE, no eventBus, no DOM.
 *
 * WHY THIS EXISTS: the old `_updatePlumes` gated on a hardcoded "isThrusting"
 * state list that EXCLUDED STATION_KEEP and NETTING even though both burn fuel
 * (STATION_KEEP.FUEL_RATE_STATIONKEEP / _consumeFuel NETTING 0.3 %/s) — the
 * daughter read as an inert box exactly when the player watches her closest.
 * This module is the single truth for which nozzle glows, and how hard, per
 * state + live burn signals. ArmUnit merely styles meshes from the result.
 *
 * Realism doctrine (BIG_PICTURE.md Part IV): indium FEEP (Enpulsion-class) is a
 * thin, faint, STEADY ion thread — never a flame. Intensities here are
 * fractions of the full transit look; the ±5% length shimmer stays in ArmUnit.
 *
 * Honesty ledger (states → burn source):
 *   TRANSIT/APPROACH   impulse-priced autopilot burn (item 100) / manual rate
 *   HAULING/RETURNING  legacy per-state FEEP rates
 *   WEB_SHOT           fuel debited upfront in fireWebShot()
 *   REELING            zero-fuel winch — EXCEPT the REDOCK_FEEP arrest window
 *                      (one-shot funded burn → the FORE nozzle brakes the
 *                      closing rate; unfunded fallback = winch-only, no flare)
 *   STATION_KEEP       FUEL_RATE_STATIONKEEP hold / FUEL_RATE_MANEUVER inputs
 *   NETTING            0.3 %/s hold while the net flies
 *   DEORBITING         5 %/s retrograde sacrifice burn (the _updateDeorbiting
 *                      comment always said "thruster plume active" — now true)
 *   everything else    no FEEP → dark (ADRIFT/EXPENDED are dark BY DESIGN)
 *
 * Attitude convention (read-only here, HANDOFF §9/§10): nose (+Z) tracks the
 * target in APPROACH/NETTING/STATION_KEEP and the strut dock during REELING —
 * so "thrust toward travel to brake" = the FORE nozzle fires.
 *
 * @module entities/armPlumeModel
 */

import { Constants } from '../core/Constants.js';

const S = Constants.ARM_STATES;

/** Tuning for the daughter plume/puff visuals (visual-only; no physics). */
export const DAUGHTER_PLUME = {
  /** SK/NETTING steady hold thread, as a fraction of transit intensity.
   *  Spec band: 25–35% ("she is alive and holding"). */
  HOLD_FRACTION: 0.30,
  /** Brightened fraction while the pilot feeds SK maneuver inputs (the same
   *  inputs that switch fuel to FUEL_RATE_MANEUVER). */
  MANEUVER_FRACTION: 0.75,
  /** Seconds the maneuver brightening lingers after the last nonzero input
   *  (rates are consumed+reset inside _updateStationKeep before the plume
   *  update runs, so the latch carries the signal across the frame). */
  MANEUVER_GLOW_S: 0.35,
  /** Fore counter-burn flash length on Events.ARM_RECOIL_KICK. */
  RECOIL_FLASH_S: 0.5,
  /** Core opacity at intensity 1 (the existing transit look, now SSOT'd). */
  CORE_OPACITY: 0.6,
  /** Halo runs at this × core opacity (per-type ID at range). */
  HALO_MULT: 0.4,
  /** Beam length floor: length scale = BASE × (MIN + (1−MIN)·intensity), so a
   *  hold thread reads shorter as well as fainter. At intensity 1 this is
   *  exactly the legacy 0.85×shimmer length. */
  MIN_LEN_SCALE: 0.45,
  /** Base length multiplier (legacy value). */
  BASE_LEN_SCALE: 0.85,
  /** Attitude cold-gas puff pool size per daughter (hard budget: ≤4 live). */
  PUFF_POOL_SIZE: 4,
  /** Sprites consumed per discrete attitude burst (a small couple, not a cloud). */
  PUFF_BURST_COUNT: 2,
  /** Global min seconds between bursts (discrete events only — never per-frame). */
  PUFF_COOLDOWN_S: 0.15,
};

/** States whose whole travel is an aft FEEP burn at full visual intensity. */
const FULL_AFT_STATES = new Set([
  S.TRANSIT, S.HAULING, S.RETURNING, S.WEB_SHOT, S.DEORBITING,
]);

const clamp01 = (x) => (x > 1 ? 1 : (x > 0 ? x : 0));

/**
 * Map the daughter's live state + burn signals to plume intensities.
 *
 * PURE: no side effects, no globals — feed it primitives, get fractions back.
 *
 * @param {object} sig
 * @param {string}  sig.state              current ARM_STATES value
 * @param {number}  sig.fuel               remaining fuel %; `fuel <= 0` (or missing)
 *                                         forces BOTH nozzles dark — no propellant,
 *                                         no thread, regardless of state
 * @param {number}  [sig.skManeuverGlowS]  seconds left of the SK maneuver-input
 *                                         brightening window (latched by
 *                                         _updateStationKeep when |rate| > 0.01,
 *                                         the FUEL_RATE_MANEUVER threshold)
 * @param {number}  [sig.approachBrake01]  smoothed 0..1 "commanded impulse opposes
 *                                         velocity" read from the APPROACH
 *                                         controller (1 = braking hard)
 * @param {boolean} [sig.arrestFeepActive] REELING re-dock arrest window entered
 *                                         AND the burn was funded
 *                                         (_redockArrestStarted && _redockDebitApplied);
 *                                         the unfunded FUEL_FALLBACK_SLOW winch
 *                                         finish must NOT flare
 * @param {number}  [sig.recoilFlashS]     seconds left of the fore counter-burn
 *                                         flash (ARM_RECOIL_KICK)
 * @returns {{aft:number, fore:number}} intensities in [0,1], fractions of the
 *                                      full transit look
 */
export function computeDaughterPlumeIntensity(sig) {
  const state = sig && sig.state;
  // No propellant → no ion thread, anywhere. (ADRIFT = "out of usable FEEP"
  // reaches this via its own state fallthrough too, but the fuel gate makes
  // the contract explicit: zero fuel is dark in EVERY state.)
  if (!sig || !(sig.fuel > 0)) return { aft: 0, fore: 0 };

  let aft = 0;
  let fore = 0;

  if (FULL_AFT_STATES.has(state)) {
    aft = 1;
  } else if (state === S.REELING) {
    // Winch-powered haul: legacy aft read for the cruise; inside the
    // REDOCK_FEEP ARREST_DISTANCE_M window a FUNDED arrest burn brakes the
    // closing rate — nose (+Z) points at the dock, so the FORE nozzle fires
    // instead of the aft one.
    if (sig.arrestFeepActive === true) fore = 1;
    else aft = 1;
  } else if (state === S.APPROACH) {
    // Crossfade on the smoothed brake read: closing burns aft; braking
    // (thrusting toward travel) burns fore. Smoothing upstream prevents a
    // frame-flip strobe when the controller dithers around standoff.
    const b = clamp01(sig.approachBrake01 || 0);
    aft = 1 - b;
    fore = b;
  } else if (state === S.STATION_KEEP) {
    // Faint steady hold thread — the "she is alive and holding" read — that
    // eases up toward MANEUVER_FRACTION while pilot inputs are live, then
    // decays back over MANEUVER_GLOW_S.
    const g = clamp01((sig.skManeuverGlowS || 0) / DAUGHTER_PLUME.MANEUVER_GLOW_S);
    aft = DAUGHTER_PLUME.HOLD_FRACTION
      + (DAUGHTER_PLUME.MANEUVER_FRACTION - DAUGHTER_PLUME.HOLD_FRACTION) * g;
  } else if (state === S.NETTING) {
    // Position hold while the net flies (0.3 %/s legacy rate) — same faint
    // thread as STATION_KEEP so the weave doesn't read as engine-off.
    aft = DAUGHTER_PLUME.HOLD_FRACTION;
  }
  // All other states (DOCKED/DOCKING/RELOADING/LAUNCHING/GRAPPLED/HOLDING_CATCH/
  // TRAWLING/ABLATING/SCANNING/ADRIFT/EXPENDED/tool-closing) stay dark: no FEEP
  // burn there. (TRAWLING's 0.002 %/s drag-sail trickle is below read threshold.)

  // Recoil counter-burn overlay: a decaying fore flash in whatever state the
  // kick lands (WEB_SHOT/NETTING/SK). Defensive by construction — when the
  // emitter never fires, recoilFlashS stays 0 and this is a no-op.
  const r = clamp01((sig.recoilFlashS || 0) / DAUGHTER_PLUME.RECOIL_FLASH_S);
  if (r > fore) fore = r;

  return { aft, fore };
}
