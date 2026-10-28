/**
 * LaunchWindow.js - transfer-ellipse launch-window math. Pure, dependency-light helpers that turn "which cluster next?" into a fuel-vs-time
 * decision: for a chaser orbit and a target orbit, the next Hohmann transfer window (time to the optimal departure, when the relative phase
 * matches the Hohmann lead angle; transfer time; arrival time; the synodic period, so a missed window rolls to the next one).
 *
 * Teaches the §24 lesson: space is periodic, "go now" is usually wrong.
 *
 * All angles are radians; all times are seconds; semi-major axes are KILOMETRES (callers convert scene-unit orbits via `orbitToKm` /
 * `clusterToOrbitKm`).
 *
 * @module entities/LaunchWindow
 */

import { Constants } from '../core/Constants.js';
import { hohmannDeltaV, totalDeltaV, orbitToKm, kmToScene } from './OrbitalMechanics.js';
import { degToRad } from '../core/MathUtil.js';

const TAU = Math.PI * 2;

export function wrapTwoPi(angle) {
  return ((angle % TAU) + TAU) % TAU;
}

/**
 * Mean motion of an orbit (0 for a non-positive axis).
 * @param {number} aKm - Semi-major axis (km)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {number} rad/s
 */
export function meanMotion(aKm, mu = Constants.MU_EARTH) {
  if (!(aKm > 0)) return 0;
  return Math.sqrt(mu / (aKm * aKm * aKm));
}

/**
 * Orbital period (Infinity for a non-positive axis).
 * @param {number} aKm - Semi-major axis (km)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {number} seconds
 */
export function orbitalPeriod(aKm, mu = Constants.MU_EARTH) {
  const n = meanMotion(aKm, mu);
  return n > 0 ? TAU / n : Infinity;
}

/**
 * Synodic period: the interval between identical relative-phase configurations of two orbits, i.e. the spacing between launch windows.
 * @param {number} a1Km
 * @param {number} a2Km
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {number} seconds (Infinity when the orbits are co-altitude/co-period)
 */
export function synodicPeriod(a1Km, a2Km, mu = Constants.MU_EARTH) {
  const dn = Math.abs(meanMotion(a1Km, mu) - meanMotion(a2Km, mu));
  return dn < 1e-12 ? Infinity : TAU / dn;
}

/**
 * In-plane true longitude (argument of latitude + node), wrapped to [0, 2π): the body's angular position on a near-circular orbit.
 * @param {object} orbit - { raan, argPerigee, trueAnomaly } (rad)
 * @returns {number} rad
 */
export function trueLongitude(orbit) {
  return wrapTwoPi((orbit.raan || 0) + (orbit.argPerigee || 0) + (orbit.trueAnomaly || 0));
}

/**
 * Required phase lead for a Hohmann rendezvous: the angle (rad) by which the TARGET must lead the chaser at departure so that both arrive at
 * the transfer apsis together: α = π · (1 − ((r1 + r2) / (2·r2))^1.5). Positive for an outward (raising) transfer, negative for an inward one.
 * @param {number} r1Km - Chaser orbital radius (km)
 * @param {number} r2Km - Target orbital radius (km)
 * @returns {number} rad
 */
export function hohmannPhaseLead(r1Km, r2Km) {
  if (!(r1Km > 0) || !(r2Km > 0)) return 0;
  const ratio = (r1Km + r2Km) / (2 * r2Km);
  return Math.PI * (1 - Math.pow(ratio, 1.5));
}

/**
 * The next Hohmann transfer launch window from a chaser orbit to a target orbit. Orbits have `semiMajorAxis` in KM plus angles in rad.
 *
 * @param {object} chaserKm - { semiMajorAxis(km), inclination, raan, argPerigee, trueAnomaly }
 * @param {object} targetKm - same shape
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {{
 *   departIn: number, transferTime: number, arriveIn: number, synodic: number,
 *   dvTotal: number, phaseLeadReq: number, currentLead: number,
 *   transferSemiMajorAxisKm: number, raising: boolean
 * }}  times in seconds, dvTotal in m/s, angles in rad. `departIn === 0` ⇒ open now.
 */
export function computeTransferWindow(chaserKm, targetKm, mu = Constants.MU_EARTH) {
  const r1 = chaserKm.semiMajorAxis;
  const r2 = targetKm.semiMajorAxis;

  const hoh = hohmannDeltaV(r1, r2, mu);
  const transferTime = hoh.transferTime;
  const dvTotal = totalDeltaV(chaserKm, targetKm, mu) * 1000;  // km/s → m/s

  const n1 = meanMotion(r1, mu);
  const n2 = meanMotion(r2, mu);
  const omegaRel = n2 - n1;
  const synodic = synodicPeriod(r1, r2, mu);

  const alpha = hohmannPhaseLead(r1, r2);
  const thetaC = trueLongitude(chaserKm);
  const thetaT = trueLongitude(targetKm);
  const currentLead = wrapTwoPi(thetaT - thetaC);

  let departIn;
  if (!Number.isFinite(synodic) || Math.abs(omegaRel) < 1e-12) {
    // Co-orbital: relative geometry never changes: always launchable.
    departIn = 0;
  } else {
    // Solve currentLead + omegaRel·t ≡ alpha (mod 2π) for the smallest t ≥ 0; solutions are spaced by the synodic period.
    const t = (alpha - currentLead) / omegaRel;
    departIn = ((t % synodic) + synodic) % synodic;
  }

  return {
    departIn,
    transferTime,
    arriveIn: departIn + transferTime,
    synodic,
    dvTotal,
    phaseLeadReq: alpha,
    currentLead,
    transferSemiMajorAxisKm: (r1 + r2) / 2,
    raising: r2 >= r1,
  };
}

/**
 * Representative member orbit for a debris cluster: the live member whose semi-major axis is closest to the cluster's mean altitude, so the
 * launch window gets a real, propagating phase (`trueAnomaly`).
 * @param {object} cluster - from DebrisField.getDebrisClusters()
 * @returns {object|null} a debris ref with `.orbit`, or null if the cluster is empty
 */
export function pickRepresentative(cluster) {
  const targets = (cluster && Array.isArray(cluster.targets)) ? cluster.targets : [];
  const alive = targets.filter(t => t && t.orbit && t.alive !== false);
  if (alive.length === 0) return null;
  if (typeof cluster.avgAltKm !== 'number') return alive[0];

  const meanSmaScene = kmToScene(Constants.EARTH_RADIUS_KM + cluster.avgAltKm);
  let best = alive[0];
  let bestD = Math.abs((best.orbit.semiMajorAxis ?? 0) - meanSmaScene);
  for (let i = 1; i < alive.length; i++) {
    const d = Math.abs((alive[i].orbit.semiMajorAxis ?? 0) - meanSmaScene);
    if (d < bestD) { bestD = d; best = alive[i]; }
  }
  return best;
}

/**
 * Km-unit target orbit for a cluster: the representative member's live orbit when available, else a synthetic circular orbit at the
 * cluster's mean altitude/inclination (no phase information: zero longitude).
 * @param {object} cluster
 * @returns {object} orbit with semiMajorAxis in km
 */
export function clusterToOrbitKm(cluster) {
  const rep = pickRepresentative(cluster);
  if (rep && rep.orbit) {
    return orbitToKm(rep.orbit);
  }
  return {
    semiMajorAxis: Constants.EARTH_RADIUS_KM + (cluster?.avgAltKm || 0),
    eccentricity: 0.001,
    inclination: degToRad(cluster?.incCenter || 0),
    raan: 0,
    argPerigee: 0,
    trueAnomaly: 0,
  };
}

/**
 * Detect launch-window threshold crossings between two successive countdown samples (fires the T-minus beep once and the "window open" cue
 * once).
 *
 * @param {number|null} prevDepartIn - previous departIn (s), or null on first sample
 * @param {number} departIn - current departIn (s)
 * @param {number} synodic - synodic period (s) (Infinity for co-orbital)
 * @param {number} imminentS - T-minus threshold for the imminent cue (s)
 * @returns {{ imminent: boolean, opened: boolean }}
 */
export function detectWindowCrossing(prevDepartIn, departIn, synodic, imminentS) {
  if (prevDepartIn == null || !Number.isFinite(prevDepartIn)) {
    return { imminent: false, opened: false };
  }
  // The window "opens" when the countdown rolls over (jumps back toward synodic) *from near zero*. Requiring the previous sample to be
  // at/below the imminent threshold rejects spurious upward jumps from the player's own burns changing the relative phase mid-flight.
  const opened = Number.isFinite(synodic)
    ? (prevDepartIn <= imminentS && (departIn - prevDepartIn) > synodic * 0.5)
    : false;
  const imminent = !opened && prevDepartIn > imminentS && departIn <= imminentS;
  return { imminent, opened };
}

/**
 * Co-orbital thresholds. When a cluster sits at almost the player's altitude, the two mean motions are nearly equal, so the synodic period
 * balloons to YEARS (a huge-but-FINITE number) and the Hohmann ΔV is trivial; past these thresholds there is effectively no phasing to wait
 * for and you can depart whenever.
 */
export const CO_ORBITAL_DELTA_V_MS = 1;  // total transfer ΔV ≤ 1 m/s
export const CO_ORBITAL_SYNODIC_S = 7 * 86400;  // synodic period > 7 days

/**
 * Is a computeTransferWindow() result effectively co-orbital ("launch anytime")? True for an exactly co-period orbit (infinite synodic),
 * a trivial ΔV, or a synodic period beyond the threshold.
 * @param {object|null} win - a computeTransferWindow() result
 * @param {{ dvMs?: number, synodicS?: number }} [opts] - threshold overrides
 * @returns {boolean}
 */
export function isCoOrbital(win, { dvMs = CO_ORBITAL_DELTA_V_MS, synodicS = CO_ORBITAL_SYNODIC_S } = {}) {
  if (!win) return false;
  if (!Number.isFinite(win.synodic)) return true;
  if (Number.isFinite(win.dvTotal) && win.dvTotal < dvMs) return true;
  return win.synodic > synodicS;
}

/**
 * Presentation model for the co-orbital case. Null when the window is a normal transfer (the caller keeps its T-minus countdown render);
 * otherwise the "launch anytime" display strings. Pure, so the DebrisMap readout decision is unit-testable without the canvas-bound UI.
 * @param {object|null} win - a computeTransferWindow() result
 * @param {{ dvMs?: number, synodicS?: number }} [opts]
 * @returns {{ departText: string, periodText: string, showArrive: boolean }|null}
 */
export function coOrbitalReadout(win, opts) {
  if (!isCoOrbital(win, opts)) return null;
  return {
    departText: 'LAUNCH ANYTIME',
    periodText: 'co-altitude \u2014 no transfer needed',
    showArrive: false,
  };
}
