/**
 * SpinDecay.js: a piece's spin slows with age (DECISIONS §70 row 2; owner 2026-11-08 05:42Z pick 2: "pieces slowly lose spin
 * over game days through Earth's magnetic field: bare metal pieces in days, satellites in years. Waiting becomes a real tactic").
 * Pure maths: DebrisField asks `tauDays` and `decayedRate` (and, for a piece with a spin kit, `kitAgedRate`); nothing here reads a
 * piece's mesh or the clock. Imports only Constants (the kit's numbers) and BigPieces (`kitHolds`).
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
import { Constants } from '../core/Constants.js';
import { bigBodiesOf } from './BigPieces.js';

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

/* ───────────────────────── THE SPIN KIT (DECISIONS §70 row 7; plan debris-1 lane K) ─────────────────────────
 * A clip-on magnet that flips with the B-dot rule (m = −m0·sign(n·dB/dt)·n) pushes against Earth's field and slows the spin at a
 * CONSTANT rate (the probe's spin runs fall 2.5 → 2 → 0.5°/s at one pace: tmp/debris1/epm/probe-epm.mjs). THE LAW:
 *     α = FIT_C · m_dip · B0 (Re/r)³ / I        (rad/s², I = the game's 0.1·m·d², the one the net's settle uses)
 * FIT_C was fitted to the probe's 36 usable cells (the five bodies but Vespa, at 25 A·m² and, but for ORBCOMM, 100,
 * 500 / 800 km, 51.6 / 98°): log-mean 0.7056, range 0.665-0.752; the law's days to 0.5°/s fall within −6 % ... +7 % of the probe's on the
 * five fitted bodies (the log in tmp/plans/debris-1.md). The Vespa cone is off: the law's days run 33 % over the probe's, because the game's 2.3 m size
 * makes its I about 64 % bigger than the probe's 1.4 × 1.6 m cylinder (an estimate on both sides). NO INCLINATION TERM: the probe's days at 51.6° and 98°
 * agree within 1 % (the orbit-mean field of `orbitFieldT` would put a 12 % gap there), and the days scale with (Re+h)³ to 0.2 % (SL-14, 25 A·m²: 3.64 d at 500 km, 4.13 d at 800 km), so
 * the field is B0 (Re/r)³ alone. `incDeg` stays in the signatures so the law can take one later.
  * THE FLOOR: B-dot ends with the body turning slowly about the normal to the orbit plane at twice the orbit rate: Reijneveld & Choukroun,
  * "Attitude control system of the Delfi-n3Xt satellite", EUCASS Proceedings Series vol. 6, pp. 189-208, 2013, DOI 10.1051/eucass/201306189
  * (paper, authors and year checked 2026-11-21 on the DOI resolver and a university record; PDF mirror https://www.eucass.eu/component/docindexer?id=4465&task=download):
  * a search snippet of its PDF reads "the satellite acquires a slow rotational motion at a rate that is equal to twice its orbital motion rate"
  * (the "around the normal to its orbital plane" part of the quote we first wrote down is NOT confirmed). Second source, unconfirmed: World Scientific
  * DOI 10.1142/S2737480726500081 ("the Bdot law provides damping only up to approximately twice the orbital rate", also a snippet); the DOI
  * resolves to Roldugin et al. 2026, "Utilization of Raw Magnetometer Measurements for the Attitude Control of a CubeSat" (Guidance, Navigation
  * and Control 6(2)), a title that does not say B-dot: the quote is not checked against that page (it did not open, 403). ESTIMATE, source
  * unconfirmed: no full text was read. The probe stops at 0.5°/s,

 * above the floor (0.13°/s at 500 km): `FLOOR_ORBIT_RATES` × the orbit rate.
 * ON TOP of the natural eddy decay (D2): closed form of ω' = −ω/τ − α, or ω' = −α when no τ is given (a live frame).
 */

const MU_EARTH_M3S2 = 3.986004e14;

/** The field the kit pushes against (tesla): B0 (Re/(Re+h))³, orbit-independent (see the fit above). */
export function kitFieldT(altKm) {
  const alt = Number.isFinite(altKm) ? Math.max(0, altKm) : 500;
  return B0_T * Math.pow(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt), 3);
}

/** Orbit rate (rad/s) at a height. */
export function orbitRateRadS(altKm) {
  const a = (EARTH_RADIUS_KM + (Number.isFinite(altKm) ? Math.max(0, altKm) : 500)) * 1000;
  return Math.sqrt(MU_EARTH_M3S2 / (a * a * a));
}

/** The floor the kit settles at (rad/s): twice the orbit rate. */
export function kitFloorRadS(altKm) {
  return Constants.SPIN_KIT.FLOOR_ORBIT_RATES * orbitRateRadS(altKm);
}

/** The piece's moment of inertia for the law (kg·m²): the game's uniform-sphere I, `CAPTURE_TORQUE_SETTLE.INERTIA_COEFF`·m·d². */
export function kitInertia(piece) {
  const m = piece && piece.mass > 0 ? piece.mass : 0;
  const d = piece && piece.sizeMeter > 0 ? piece.sizeMeter : 0;
  return Constants.CAPTURE_TORQUE_SETTLE.INERTIA_COEFF * m * d * d;
}

/**
 * The kit's constant slowing (rad/s²) on a piece. 0 for a piece with no mass or size.
 * @param {{mass?: number, sizeMeter?: number}} piece @param {number} altKm @param {number} [incDeg] unused (see the fit)
 * @param {number} [dipole] A·m², default the kit's
 */
export function kitAlpha(piece, altKm, incDeg, dipole = Constants.SPIN_KIT.dipoleAm2) {
  const I = kitInertia(piece);
  if (!(I > 0) || !(dipole > 0)) return 0;
  return Constants.SPIN_KIT.FIT_C * dipole * kitFieldT(altKm) / I;
}

/**
 * A spin after `seconds` with the kit on, the kit alone: max(floor, rate − α·t). A spin already at or under the floor stays.
 * @param {number} rate rad/s @param {number} seconds @param {object} piece @param {number} altKm @param {number} [incDeg]
 * @param {number} [dipole] @returns {number} rad/s
 */
export function kitSlowedRate(rate, seconds, piece, altKm, incDeg, dipole = Constants.SPIN_KIT.dipoleAm2) {
  if (!Number.isFinite(rate) || !(rate > 0) || !Number.isFinite(seconds) || !(seconds > 0)) return Number.isFinite(rate) ? rate : 0;
  const floor = kitFloorRadS(altKm);
  if (rate <= floor) return rate;
  return Math.max(floor, rate - kitAlpha(piece, altKm, incDeg, dipole) * seconds);
}

/**
 * Natural decay and the kit together over `seconds`: ω' = −ω/τ − α (τ in seconds; none or non-positive: the kit alone), never below
 * the floor because of the kit and never above the natural decay alone.
 * @param {number} rate rad/s @param {number} seconds @param {number} tauSeconds @param {number} alpha rad/s² @param {number} floor rad/s
 */
export function kitDecayedRate(rate, seconds, tauSeconds, alpha, floor) {
  if (!Number.isFinite(rate) || !(rate > 0) || !Number.isFinite(seconds) || !(seconds > 0)) return Number.isFinite(rate) ? rate : 0;
  const tau = Number.isFinite(tauSeconds) && tauSeconds > 0 ? tauSeconds : Infinity;
  const nat = rate * Math.exp(-seconds / tau);
  if (!(alpha > 0) || rate <= floor) return nat;
  const w = tau === Infinity ? rate - alpha * seconds : nat + alpha * tau * Math.expm1(-seconds / tau);
  return Math.min(nat, Math.max(floor, w));
}

/**
 * A piece's spin after `days` ship days with a kit on it for the last `kitDays` of them: natural decay alone for the first
 * `days − kitDays`, then natural decay and the kit together. This is the number D2's store / restore / wait paths use.
 * @param {number} rate rad/s @param {number} days @param {number} kitDays (clamped into 0..days)
 * @param {object} piece @param {number} altKm @param {number} incDeg @param {number} [dipole]
 * @returns {number} rad/s
 */
export function kitAgedRate(rate, days, kitDays, piece, altKm, incDeg, dipole = Constants.SPIN_KIT.dipoleAm2) {
  const d = Number.isFinite(days) && days > 0 ? days : 0;
  const kd = Math.min(d, Number.isFinite(kitDays) && kitDays > 0 ? kitDays : 0);
  const tau = tauDays(piece, altKm, incDeg);
  const lead = decayedRate(rate, d - kd, tau);
  return kitDecayedRate(lead, kd * SECONDS_PER_DAY, tau * SECONDS_PER_DAY, kitAlpha(piece, altKm, incDeg, dipole), kitFloorRadS(altKm));
}

/**
 * Does the kit hold on this piece: a big piece (a HIGH_FIELD stage or satellite with an owner, not a bag) with a steel spot (a steel hull
 * or steel fasteners: `debrisFerrous`)? Same test the arm, the odds strip and the buy path use. The map-on gate of `isBigPiece` is
 * implied: only the high-field spawn sets an owner.
 * @param {object|null} piece @returns {boolean}
 */
export function kitHolds(piece) {
  if (!piece || piece.isBag === true) return false;
  if (!(piece.ferromagnetic === true || piece.hasFerrousFasteners === true)) return false;
  return bigBodiesOf(piece).length > 0;
}
