/**
 * ReachabilityModel.js — Zoom Ladder F6 (NAVCOM) fuel-reachability math (S5).
 *
 * PURE MODULE (no THREE, no DOM, no EventBus): turns the ship's remaining-ΔV
 * budget (ArmManager.getMassBudget(), the Tsiolkovsky SSOT) plus a transfer
 * window (LaunchWindow.computeTransferWindow()) into a per-cluster verdict —
 * can I actually afford this transfer? — and into the floor-wide reachability
 * ENVELOPE (the "orb"): the band of circular altitudes reachable from the
 * player's current orbit within the usable budget.
 *
 * DESIGN NOTES
 *   - The ΔV budget is fuel-aware by construction: getMassBudget() already
 *     folds cargo/berthed mass into wet/dry, so a laden ship's reach shrinks.
 *     This deliberately does NOT reuse DebrisMap's flat 500 m/s gate
 *     (Constants.DEBRIS_MAP.MAX_DV_MS) — 00-spec §8's "do not reuse existing
 *     tables" spirit: reachability must track the live tanks, not a constant.
 *   - Fuel for a burn comes from the INVERSE rocket equation:
 *         fuelKg = wet · (1 − e^(−ΔV / (Isp·g0)))
 *     which round-trips exactly against the budget's forward Tsiolkovsky
 *     ΔV = Isp·g0·ln(wet/dry).
 *   - The ENVELOPE uses coplanar Hohmann cost ONLY (no plane change): a plane
 *     change cost depends on the TARGET's inclination offset, which is a
 *     per-cluster property, not a property of an altitude shell — folding an
 *     arbitrary inclination into the orb would make the band dishonest for
 *     every other plane. Per-cluster assessments DO include the plane change
 *     (win.dvTotal comes from OrbitalMechanics.totalDeltaV), so the orb is an
 *     upper bound for coplanar targets — hence the caption's "≈".
 *   - The envelope bisection is valid because Hohmann total ΔV is monotonic in
 *     the target radius on BOTH sides of r0 within the clamped LEO band
 *     (r2/r1 ≤ ~1.3 ≪ 15.58, the classic non-monotonic knee).
 *
 * All new tunables are EXPORTED here (house rule: not in FloorContract or
 * Constants — those are owned by parallel sessions).
 *
 * @module entities/ReachabilityModel
 */

import { Constants } from '../core/Constants.js';
import { hohmannDeltaV } from './OrbitalMechanics.js';

/** Fraction of the ΔV budget held back as reserve: a transfer is 'reachable'
 *  only if it fits inside budget.deltaV × (1 − RESERVE_FRAC). Between that and
 *  the full budget it is 'marginal' (you can go, but you arrive on fumes). */
export const RESERVE_FRAC = 0.15;

/** Multiplier applied to win.dvTotal when costing a transfer. 1 = one-way
 *  (matches the TransferWindows ΔV line). Set 2 for a there-and-back budget.
 *  Applies to the ΔV cost only; timeS stays the one-way transfer duration. */
export const ROUND_TRIP_FACTOR = 1;

/** Envelope clamp: sane LEO circular-altitude bounds (km). Below ~180 km drag
 *  deorbits you within days; the game's debris population tops out below
 *  2,000 km (00-spec §8 LEO regime). */
export const ENVELOPE_ALT_MIN_KM = 180;
export const ENVELOPE_ALT_MAX_KM = 2000;

/** Envelope bisection convergence: stop when the bracketing radii are closer
 *  than this (km). ~50 iterations worst case over the 2,000 km LEO span. */
export const ENVELOPE_TOL_KM = 0.05;

/**
 * Usable ΔV after the reserve holdback (m/s).
 * @param {{deltaV:number}} budget - getMassBudget()-shaped
 * @param {number} [reserveFrac=RESERVE_FRAC]
 * @returns {number} m/s (0 for a missing/empty budget)
 */
export function usableDeltaV(budget, reserveFrac = RESERVE_FRAC) {
  const dv = budget && Number.isFinite(budget.deltaV) ? budget.deltaV : 0;
  return Math.max(0, dv * (1 - reserveFrac));
}

/**
 * Propellant mass consumed by a burn of `dvMs`, via the inverse rocket
 * equation on the budget's wet mass:  fuel = wet · (1 − e^(−ΔV/(Isp·g0))).
 * @param {number} dvMs - burn ΔV (m/s)
 * @param {{wetMass:number, isp?:number}} budget - getMassBudget()-shaped
 * @returns {number} kg (0 for degenerate inputs)
 */
export function fuelForDeltaV(dvMs, budget) {
  if (!budget || !(dvMs > 0) || !(budget.wetMass > 0)) return 0;
  const isp = budget.isp > 0 ? budget.isp : Constants.OCTOPUS_CORE_HALL_ISP;
  const ve = isp * Constants.G0; // exhaust velocity (m/s)
  return budget.wetMass * (1 - Math.exp(-dvMs / ve));
}

/**
 * Assess one transfer window against the live ΔV budget.
 *
 * @param {object} args
 * @param {object} args.budget - ArmManager.getMassBudget() result
 *                 ({deltaV m/s, wetMass kg, dryMass kg, isp s, ...})
 * @param {object} args.win - LaunchWindow.computeTransferWindow() result
 *                 ({dvTotal m/s, transferTime s, ...})
 * @param {number} [args.reserveFrac=RESERVE_FRAC]
 * @param {number} [args.roundTripFactor=ROUND_TRIP_FACTOR]
 * @returns {{
 *   verdict: 'reachable'|'marginal'|'unreachable',
 *   dvCost: number,      // m/s (win.dvTotal × roundTripFactor)
 *   fuelKg: number,      // xenon consumed by dvCost (inverse rocket equation)
 *   timeS: number,       // one-way transfer duration (s)
 *   budgetAfter: number, // budget.deltaV − dvCost (m/s; negative if unreachable)
 * }|null} null when budget/window are missing or degenerate
 */
export function assess({ budget, win, reserveFrac = RESERVE_FRAC, roundTripFactor = ROUND_TRIP_FACTOR } = {}) {
  if (!budget || !win || !Number.isFinite(win.dvTotal)) return null;
  const dvCost = win.dvTotal * roundTripFactor;
  const budgetDv = Number.isFinite(budget.deltaV) ? budget.deltaV : 0;
  const usable = usableDeltaV(budget, reserveFrac);
  const verdict = dvCost <= usable ? 'reachable'
    : dvCost <= budgetDv ? 'marginal'
    : 'unreachable';
  return {
    verdict,
    dvCost,
    fuelKg: fuelForDeltaV(dvCost, budget),
    timeS: Number.isFinite(win.transferTime) ? win.transferTime : NaN,
    budgetAfter: budgetDv - dvCost,
  };
}

/**
 * @private Bisect for the reachability boundary between a known-feasible
 * radius (r0, cost 0) and a bound. Monotonic within the LEO clamp (header
 * note). Returns the last FEASIBLE radius (km).
 */
function _bisectBoundary(r0Km, boundKm, usableMs, mu) {
  const costOf = (r) => hohmannDeltaV(r0Km, r, mu).total * 1000; // km/s → m/s
  if (costOf(boundKm) <= usableMs) return boundKm; // whole span affordable
  let feasible = r0Km;
  let infeasible = boundKm;
  // 2,000 km span / 2^50 ≪ ENVELOPE_TOL_KM — the iteration cap is a safety net.
  for (let i = 0; i < 60 && Math.abs(infeasible - feasible) > ENVELOPE_TOL_KM; i++) {
    const mid = (feasible + infeasible) / 2;
    if (costOf(mid) <= usableMs) feasible = mid; else infeasible = mid;
  }
  return feasible;
}

/**
 * The reachability ENVELOPE: the min/max circular altitude reachable from the
 * player's current orbit radius within the usable (reserve-held) budget, via
 * bisection over coplanar Hohmann cost. Plane change is EXCLUDED by design
 * (header note: it is a per-target property, not a property of an altitude
 * shell). Clamped to [ENVELOPE_ALT_MIN_KM, ENVELOPE_ALT_MAX_KM].
 *
 * Zero/tiny budget degenerates to the player's current altitude (clamped).
 *
 * @param {object} args
 * @param {object} args.budget - getMassBudget()-shaped ({deltaV m/s, ...})
 * @param {number} args.playerOrbitKm - current (near-circular) orbit RADIUS
 *                 from Earth's center, km (sma of the player's orbit in km)
 * @param {number} [args.reserveFrac=RESERVE_FRAC]
 * @param {number} [args.mu=Constants.MU_EARTH]
 * @returns {{
 *   minAltKm: number, maxAltKm: number,   // envelope altitudes (km)
 *   usableDvMs: number,                    // budget after reserve (m/s)
 *   budgetDvMs: number,                    // full budget (m/s), for captions
 * }|null} null when the budget or player radius is missing/degenerate
 */
export function envelope({ budget, playerOrbitKm, reserveFrac = RESERVE_FRAC, mu = Constants.MU_EARTH } = {}) {
  if (!budget || !(playerOrbitKm > 0)) return null;
  const usable = usableDeltaV(budget, reserveFrac);
  const rFloor = Constants.EARTH_RADIUS_KM + ENVELOPE_ALT_MIN_KM;
  const rCeil = Constants.EARTH_RADIUS_KM + ENVELOPE_ALT_MAX_KM;
  const r0 = Math.min(rCeil, Math.max(rFloor, playerOrbitKm));
  const rLow = _bisectBoundary(r0, rFloor, usable, mu);
  const rHigh = _bisectBoundary(r0, rCeil, usable, mu);
  return {
    minAltKm: rLow - Constants.EARTH_RADIUS_KM,
    maxAltKm: rHigh - Constants.EARTH_RADIUS_KM,
    usableDvMs: usable,
    budgetDvMs: Number.isFinite(budget.deltaV) ? budget.deltaV : 0,
  };
}
