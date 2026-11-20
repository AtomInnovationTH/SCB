/**
 * SpinDecay.js: a piece's spin slows with age (DECISIONS §70 row 2; owner 2026-11-08 05:42Z pick 2: "pieces slowly lose spin
 * over game days through Earth's magnetic field: bare metal pieces in days, satellites in years. Waiting becomes a real tactic").
 * Pure maths, no imports: DebrisField asks `tauDays` and `decayedRate`; nothing here reads a piece's mesh or the clock.
 *
 * THE LAW (docs/research/2026-11-detumble-methods.md §3.6): eddy currents in a conducting body turning in Earth's field slow its
 * spin as rate · exp(−t/τ) with τ = 4ρ/(σB²)/f. ρ, σ are the metal's density and conductivity (aluminium: 2700 kg/m³, 3.5e7 S/m),
 * B the field the piece meets (orbit-averaged, below) and f the share of the body's inertia carried by its conducting skin
 * (f = 1 is a bare metal shell; a satellite of composites and electronics is far lower).
 *
 * BASE: at B = 25 µT and f = 1, τ = 4·2700/(3.5e7·(25e-6)²) = 5.71 d (computed below, not typed). The doc's "12.6 days for
 * fragments, 5.2 for a stage, 2.3 for a satellite, 25 h for the mover" are NOT τ: they are the times to reach each class's goal spin
 * from its start spin (90→10°/s: τ·ln 9 = 12.6 d; 5→2: τ·ln 2.5 = 5.2 d; 15→10: 2.3 d; 12→10: 25 h) at the same 5.71 d τ.
 * Test-SpinDecay pins both readings (lane B of Debris 1 found the plan's table listed them as τ).
 *
 * F BY CLASS (coordinator's call, sourced): fragment, missionDebris and the training movers f = 1 (bare metal; Killian 2013:
 * aluminium shells stabilise in 12-90 days); rocketBody f = 0.25 (Praly's Ariane stage: f 0.23-0.30, 19-25 d at 25 µT);
 * defunctSat and cubesat f = 0.003 (Envisat radar: 5.0-6.4 years; computed f 0.0025-0.003). An unknown type falls back to the
 * fragment's. A steel or iron hull keeps its type's f.
 *
 * THE FIELD: tilted dipole B = B0 (Re/r)³ √(1 + 3 sin²λ); its orbit mean of B² is B0² (Re/r)⁶ (1 + 1.5 sin² i_m), i_m the
 * orbit's inclination to the magnetic equator. The game takes i_m = the orbit's tilt (coordinator's call). Same average as
 * tmp/encounter-1108/detumble-methods/probe-natural.mjs (`Brms`), so the doc's bands come back: f = 1 shell at 400 / 800 /
 * 1,500 km, 30-90° to the magnetic equator: 2.1-3.8 / 3.0-5.4 / 5.2-9.5 d.
 * NO DECAY INSIDE ONE VISIT: measured under 1.5 % in 21 min of play (tmp/debris1/spin), so the game ages spin only by SHIP DAYS
 * (a trip, a wait, a finish burn), never by the frame.
 * @module systems/SpinDecay
 */

/** Conducting-shell material (aluminium): density kg/m³ and conductivity S/m (probe-natural.mjs). */
export const RHO_KG_M3 = 2700;
export const SIGMA_S_M = 3.5e7;
/** Earth's dipole equatorial surface field (T) and mean radius (km): the same figures as probe-natural.mjs. */
export const B0_T = 3.12e-5;
export const EARTH_RADIUS_KM = 6371;
/** The field the base τ is quoted at (T). */
export const BASE_FIELD_T = 25e-6;
const SECONDS_PER_DAY = 86400;

/** τ (days) for a bare conducting shell (f = 1) in a uniform field of `B` tesla. */
export function bareShellTauDays(B) {
  return (4 * RHO_KG_M3) / (SIGMA_S_M * B * B) / SECONDS_PER_DAY;
}

/** τ (days) at the base field, f = 1: 5.71 d. */
export const BASE_TAU_DAYS = bareShellTauDays(BASE_FIELD_T);

/** Share of the inertia carried by a conducting skin, by debris type (see the header for the sources). */
export const CONDUCTING_SHARE = Object.freeze({
  fragment: 1,
  missionDebris: 1,
  rocketBody: 0.25,
  defunctSat: 0.003,
  cubesat: 0.003,
});

/** f of a piece: a training mover (`mover: true` / `_mover: true`) is bare metal; an unknown type is the fragment's. */
export function conductingShare(piece) {
  if (piece && (piece.mover === true || piece._mover === true)) return 1;
  const f = piece && CONDUCTING_SHARE[piece.type];
  return Number.isFinite(f) && f > 0 ? f : CONDUCTING_SHARE.fragment;
}

/**
 * Orbit-averaged field (tesla, root of the orbit mean of B²) at `altKm` for an orbit tilted `incDeg` to the magnetic equator.
 * @param {number} altKm @param {number} incDeg @returns {number}
 */
export function orbitFieldT(altKm, incDeg) {
  const alt = Number.isFinite(altKm) ? Math.max(0, altKm) : 500;
  const s = Math.sin((Number.isFinite(incDeg) ? incDeg : 51.6) * Math.PI / 180);
  return B0_T * Math.pow(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt), 3) * Math.sqrt(1 + 1.5 * s * s);
}

/**
 * The e-folding time (days) of a piece's spin at a height and orbit tilt.
 * @param {{type?: string, mover?: boolean, _mover?: boolean}} piece
 * @param {number} altKm height above the surface (the field she laid it out at)
 * @param {number} incDeg the orbit's tilt
 * @returns {number} days
 */
export function tauDays(piece, altKm, incDeg) {
  return bareShellTauDays(orbitFieldT(altKm, incDeg)) / conductingShare(piece);
}

/**
 * A spin after `days` ship days: rate · exp(−days/τ). Negative or missing days change nothing (a clock that went back never
 * speeds a piece up).
 * @param {number} rate any unit @param {number} days @param {number} tau days @returns {number} same unit
 */
export function decayedRate(rate, days, tau) {
  if (!Number.isFinite(rate) || !(rate > 0)) return Number.isFinite(rate) ? rate : 0;
  if (!Number.isFinite(days) || !(days > 0) || !Number.isFinite(tau) || !(tau > 0)) return rate;
  return rate * Math.exp(-days / tau);
}
