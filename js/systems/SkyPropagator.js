/**
 * SkyPropagator.js — where each object of data/sky.json is at a given time (plan sky-1116, lane L-sky, task 2).
 *
 * Pure: no THREE, no DOM, no game state. From a GP snapshot's MEAN elements it gives MEAN positions:
 *   1. recover the SGP4 (Brouwer) mean motion and semi-major axis from the published Kozai mean motion (Spacetrack Report 3,
 *      the SGP4 initialisation step: a1, delta1, a0, delta0, n0'', a0''; WGS-72 constants, which is what SGP4 itself uses);
 *   2. two-body (Kepler) motion, plus the secular J2 rates of the node, the perigee and the mean anomaly.
 * No short-period terms, no drag, no deep-space (lunar / solar) terms. Accuracy against a later snapshot is NOT measured yet
 * (`build-sky.mjs --check <newer gp.json>` measures it); no km figure is claimed.
 *
 * Frame: the game's scene frame (the same axes as `OrbitalMechanics.keplerianToCartesian`: x, y = the orbit-pole / north axis,
 * z); lengths in km, time in seconds since the snapshot (`snapshotUtc`).
 *
 * @module systems/SkyPropagator
 */

/** WGS-72, the constants SGP4 is defined with (Spacetrack Report 3). Not the game's `Constants` on purpose. */
export const WGS72 = Object.freeze({ MU: 398600.8, RE_KM: 6378.135, J2: 0.001082616 });

const TWO_PI = 2 * Math.PI;
const D2R = Math.PI / 180;
/** Earth's equatorial radius the GP PERIAPSIS / APOAPSIS fields are measured from (km). */
export const GP_HEIGHT_RADIUS_KM = 6378.137;

/**
 * Kozai mean motion → Brouwer mean motion and semi-major axis (Spacetrack Report 3 initialisation).
 * @param {number} nKozaiRevDay GP MEAN_MOTION @param {number} e @param {number} incRad
 * @returns {{nRevDay: number, aKm: number}} n0'' (rev/day) and a0'' (km)
 */
export function recoverBrouwer(nKozaiRevDay, e, incRad) {
  const k2 = 0.5 * WGS72.J2;                                      // Earth radii (ae = 1)
  const ke = 60 / Math.sqrt((WGS72.RE_KM ** 3) / WGS72.MU);       // Earth radii^1.5 per minute
  const no = nKozaiRevDay * TWO_PI / 1440;                        // rad/min
  const c = Math.cos(incRad);
  const f = 1.5 * k2 * (3 * c * c - 1) / Math.pow(1 - e * e, 1.5);
  const a1 = Math.pow(ke / no, 2 / 3);
  const d1 = f / (a1 * a1);
  const a0 = a1 * (1 - d1 / 3 - d1 * d1 - (134 / 81) * d1 * d1 * d1);
  const d0 = f / (a0 * a0);
  const nB = no / (1 + d0);
  const aB = a0 / (1 - d0);
  return { nRevDay: nB * 1440 / TWO_PI, aKm: aB * WGS72.RE_KM };
}

/**
 * Secular J2 rates (rad/s) of one orbit.
 * @param {number} aKm @param {number} e @param {number} incRad @param {number} nRadS Brouwer mean motion, rad/s
 * @returns {{raan: number, argp: number, ma: number}} d(node)/dt, d(perigee)/dt and d(mean anomaly)/dt (incl. n itself)
 */
export function j2Rates(aKm, e, incRad, nRadS) {
  const p = aKm * (1 - e * e);
  const q = 1.5 * WGS72.J2 * (WGS72.RE_KM / p) ** 2 * nRadS;
  const c = Math.cos(incRad);
  return {
    raan: -q * c,
    argp: 0.5 * q * (5 * c * c - 1),
    ma: nRadS + 0.5 * q * Math.sqrt(1 - e * e) * (3 * c * c - 1),
  };
}

/** Kepler's equation, Newton, for E (rad). */
export function solveE(M, e) {
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;
  for (let k = 0; k < 12; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Column indices in a data/sky.json row (see skyPack.FIELDS). */
const F = { norad: 0, name: 1, cls: 2, n: 9, e: 10, inc: 11, raan: 12, argp: 13, ma: 14, epochS: 8 };

export class SkyPropagator {
  /**
   * @param {Array<Array>} rows data/sky.json rows
   * @param {Array<string>} [fields] data/sky.json `fields` (checked against the layout this module reads)
   */
  constructor(rows, fields) {
    if (fields && (fields[F.n] !== 'n' || fields[F.ma] !== 'maDeg' || fields[F.epochS] !== 'epochS')) {
      throw new Error('SkyPropagator: unexpected sky.json field layout');
    }
    const N = rows.length;
    this.count = N;
    this.a = new Float64Array(N);
    this.e = new Float64Array(N);
    this.cosI = new Float64Array(N);
    this.sinI = new Float64Array(N);
    this.raan0 = new Float64Array(N);
    this.argp0 = new Float64Array(N);
    this.ma0 = new Float64Array(N);
    this.dRaan = new Float64Array(N);
    this.dArgp = new Float64Array(N);
    this.dMa = new Float64Array(N);
    this.epochS = new Float64Array(N);
    this.nRevDay = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const r = rows[i];
      const e = r[F.e];
      const inc = r[F.inc] * D2R;
      const b = recoverBrouwer(r[F.n], e, inc);
      const rates = j2Rates(b.aKm, e, inc, b.nRevDay * TWO_PI / 86400);
      this.a[i] = b.aKm;
      this.e[i] = e;
      this.cosI[i] = Math.cos(inc);
      this.sinI[i] = Math.sin(inc);
      this.raan0[i] = r[F.raan] * D2R;
      this.argp0[i] = r[F.argp] * D2R;
      this.ma0[i] = r[F.ma] * D2R;
      this.dRaan[i] = rates.raan;
      this.dArgp[i] = rates.argp;
      this.dMa[i] = rates.ma;
      this.epochS[i] = r[F.epochS];
      this.nRevDay[i] = b.nRevDay;
    }
  }

  /** The element set of row i at `tSec` seconds after the snapshot (angles in rad). */
  elementsAt(i, tSec) {
    const dt = tSec - this.epochS[i];
    return {
      aKm: this.a[i], e: this.e[i], incRad: Math.atan2(this.sinI[i], this.cosI[i]),
      raan: this.raan0[i] + this.dRaan[i] * dt,
      argp: this.argp0[i] + this.dArgp[i] * dt,
      ma: this.ma0[i] + this.dMa[i] * dt,
    };
  }

  /**
   * Position of row i, km, scene frame, written to out[o], out[o+1], out[o+2]. Allocation-free.
   * @param {number} i @param {number} tSec seconds after the snapshot @param {Float32Array|Float64Array|number[]} out @param {number} [o]
   */
  positionInto(i, tSec, out, o = 0) {
    const dt = tSec - this.epochS[i];
    const e = this.e[i];
    let M = (this.ma0[i] + this.dMa[i] * dt) % TWO_PI;
    if (M < 0) M += TWO_PI;
    const E = solveE(M, e);
    const a = this.a[i];
    const xP = a * (Math.cos(E) - e);
    const yP = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const raan = this.raan0[i] + this.dRaan[i] * dt;
    const argp = this.argp0[i] + this.dArgp[i] * dt;
    rotateInto(xP, yP, raan, argp, this.cosI[i], this.sinI[i], out, o);
  }

  /**
   * Position (km) and velocity (km/s) of row i at `tSec`, scene frame, written to pOut[po..po+2] and vOut[vo..vo+2]. Allocation-free.
   * The position is exactly `positionInto`'s. The velocity is the exact time derivative of that model (Kepler motion plus the secular
   * rates of the node and the perigee), so `p + v * dt` follows `positionInto(i, t + dt)` to second order in dt.
   */
  positionVelocityInto(i, tSec, pOut, po, vOut, vo) {
    const dt = tSec - this.epochS[i];
    const e = this.e[i];
    let M = (this.ma0[i] + this.dMa[i] * dt) % TWO_PI;
    if (M < 0) M += TWO_PI;
    const E = solveE(M, e);
    const a = this.a[i];
    const b = a * Math.sqrt(1 - e * e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const xP = a * (cE - e), yP = b * sE;
    const eDot = this.dMa[i] / (1 - e * cE);
    const xV = -a * sE * eDot, yV = b * cE * eDot;
    const raan = this.raan0[i] + this.dRaan[i] * dt;
    const argp = this.argp0[i] + this.dArgp[i] * dt;
    const ci = this.cosI[i], si = this.sinI[i];
    const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp);
    const l1 = cO * cw - sO * sw * ci, l2 = -cO * sw - sO * cw * ci;
    const m1 = sO * cw + cO * sw * ci, m2 = -sO * sw + cO * cw * ci;
    pOut[po] = l1 * xP + l2 * yP;
    pOut[po + 1] = sw * si * xP + cw * si * yP;
    // scene = (x, z, -y) of the ECI matrix result: the frame law (OrbitalMechanics.eciToScene)
    pOut[po + 2] = -(m1 * xP + m2 * yP);
    // d(matrix)/d(node) and d(matrix)/d(perigee), times the rates, applied to the perifocal position; plus the matrix on the perifocal velocity
    const dO = this.dRaan[i], dW = this.dArgp[i];
    const dl1 = (-sO * cw - cO * sw * ci) * dO + l2 * dW;
    const dl2 = (sO * sw - cO * cw * ci) * dO - l1 * dW;
    const dm1 = l1 * dO + m2 * dW;
    const dm2 = l2 * dO - m1 * dW;
    vOut[vo] = l1 * xV + l2 * yV + dl1 * xP + dl2 * yP;
    vOut[vo + 1] = si * (sw * xV + cw * yV) + si * dW * (cw * xP - sw * yP);
    vOut[vo + 2] = -(m1 * xV + m2 * yV + dm1 * xP + dm2 * yP);
  }

  /** Radius (km from Earth's centre) of row i at `tSec` (cheap: no rotation). */
  radiusKm(i, tSec) {
    const dt = tSec - this.epochS[i];
    const e = this.e[i];
    let M = (this.ma0[i] + this.dMa[i] * dt) % TWO_PI;
    if (M < 0) M += TWO_PI;
    return this.a[i] * (1 - e * Math.cos(solveE(M, e)));
  }

  /** Perigee and apogee heights, km above the GP reference radius (6378.137), as the GP's own PERIAPSIS / APOAPSIS. */
  heightsKm(i) {
    return {
      perKm: this.a[i] * (1 - this.e[i]) - GP_HEIGHT_RADIUS_KM,
      apoKm: this.a[i] * (1 + this.e[i]) - GP_HEIGHT_RADIUS_KM,
    };
  }

  /**
   * The orbit of row i as a closed ring of `nPts` + 1 points (km, scene frame) at the node and perigee it has at `tSec`
   * (uniform in eccentric anomaly: denser at perigee). `out` holds 3 × (nPts + 1) numbers.
   */
  orbitLineInto(i, tSec, nPts, out) {
    const dt = tSec - this.epochS[i];
    const e = this.e[i];
    const a = this.a[i];
    const b = a * Math.sqrt(1 - e * e);
    const raan = this.raan0[i] + this.dRaan[i] * dt;
    const argp = this.argp0[i] + this.dArgp[i] * dt;
    for (let k = 0; k <= nPts; k++) {
      const E = (k / nPts) * TWO_PI;
      rotateInto(a * (Math.cos(E) - e), b * Math.sin(E), raan, argp, this.cosI[i], this.sinI[i], out, 3 * k);
    }
  }
}

/** Perifocal (xP, yP) → the game's scene frame (the same matrix as OrbitalMechanics.keplerianToCartesianInto, scene z = -ECI y). */
function rotateInto(xP, yP, raan, argp, cosI, sinI, out, o) {
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const l1 = cO * cw - sO * sw * cosI;
  const l2 = -cO * sw - sO * cw * cosI;
  const m1 = sO * cw + cO * sw * cosI;
  const m2 = -sO * sw + cO * cw * cosI;
  out[o] = l1 * xP + l2 * yP;
  out[o + 1] = sw * sinI * xP + cw * sinI * yP;
  out[o + 2] = -(m1 * xP + m2 * yP);
}
