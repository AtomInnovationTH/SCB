/**
 * Ephemeris.js — minimal real-sky ephemeris (Sun + Moon) for start-time seeding:
 * where the Sun and Moon are, for a real Date: declination + RA, and the sub-solar / sub-lunar east longitude on the Earth-fixed globe (the
 * game's scene is inertial and the globe turns under it, see FRAME). Sun: declination + sub-solar east longitude. Moon: declination +
 * sub-lunar east longitude, elongation from the Sun, illuminated fraction.
 *
 * Accuracy: Sun ≈ 0.01° (Meeus low-precision), Moon ≈ 1° (largest series terms).
 *
 * FRAME: `latLonToUnitVec` and the sub-solar / sub-lunar longitudes below are in the Earth-FIXED frame of the globe's own texture (the
 * mesh's local frame; the texture is longitude-mirrored, `mirrorLon: true` in main.js). The scene itself is inertial and the globe turns
 * under it by GMST of the game date (Reality 7: `Earth.setTurn`, `systems/GameDate`), so anything drawn among the dots or the sky is
 * placed with `raDecToDotFrame` (inertial), and only things riding the globe's group use `latLonToUnitVec`. East longitude λE maps to
 * the globe's local azimuth −λE, Y the polar axis, (lat 0, lon 0) on +X; latLonToUnitVec() applies exactly that.
 *
 * Pure math — no THREE, no DOM.
 *
 * @module scene/Ephemeris
 */

import { DEG2RAD, degToRad, clamp } from '../core/MathUtil.js';

function norm360(d) {
  return ((d % 360) + 360) % 360;
}

function norm180(d) {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
}

/** Julian Day from a JS Date (UTC-based, so the player's timezone is handled automatically). */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Greenwich Mean Sidereal Time, degrees in [0, 360); IAU 1982 incl. T² terms.
 * Single source of truth: NavSphere's ECI→geodetic conversion imports it too.
 * @param {number} d — days since J2000.0 (JD − 2451545.0)
 */
export function gmstDeg(d) {
  const T = d / 36525.0;
  return norm360(
    280.46061837 + 360.98564736629 * d + T * T * (0.000387933 - T / 38710000)
  );
}

/**
 * Low-precision solar position (Meeus, ≈0.01°).
 * @returns {{ declDeg: number, subLonEastDeg: number, eclipticLonDeg: number }}
 *   declDeg = solar declination; subLonEastDeg = east longitude of the sun at
 *   zenith; eclipticLonDeg = geocentric ecliptic longitude (for moon elongation)
 */
export function sunEphemeris(date) {
  const d = julianDay(date) - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * d);         // mean longitude
  const g = norm360(357.528 + 0.9856003 * d) * DEG2RAD;   // mean anomaly
  const lambdaDeg = norm360(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const eps = (23.439 - 0.0000004 * d) * DEG2RAD;         // obliquity
  const lam = lambdaDeg * DEG2RAD;

  const alphaDeg = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / DEG2RAD;
  const declDeg = Math.asin(Math.sin(eps) * Math.sin(lam)) / DEG2RAD;

  const subLonEastDeg = norm180(alphaDeg - gmstDeg(d));
  return { declDeg, subLonEastDeg, eclipticLonDeg: lambdaDeg, raDeg: norm360(alphaDeg) };
}

/**
 * Low-precision lunar position (Montenbruck & Pfleger truncation, ≈1°) plus
 * phase. Illuminated fraction uses elongation only (ignores the ~1/389
 * Sun-distance parallax term).
 */
export function moonEphemeris(date) {
  const d = julianDay(date) - 2451545.0;
  const Lp = norm360(218.316 + 13.176396 * d);          // mean longitude
  const Mp = norm360(134.963 + 13.064993 * d) * DEG2RAD;    // mean anomaly
  const F = norm360(93.272 + 13.229350 * d) * DEG2RAD;      // argument of latitude

  const eclipticLonDeg = norm360(Lp + 6.289 * Math.sin(Mp)); // evection ≫ rest
  const eclipticLatDeg = 5.128 * Math.sin(F);

  const eps = (23.439 - 0.0000004 * d) * DEG2RAD;
  const lam = eclipticLonDeg * DEG2RAD;
  const bet = eclipticLatDeg * DEG2RAD;

  const alphaDeg = Math.atan2(
    Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps),
    Math.cos(lam)
  ) / DEG2RAD;
  const declDeg = Math.asin(
    Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam)
  ) / DEG2RAD;

  const subLonEastDeg = norm180(alphaDeg - gmstDeg(d));

  // illuminated fraction (1 − cos e)/2: 0 new, 1 full
  const sun = sunEphemeris(date);
  const cosE = Math.cos(bet) * Math.cos((eclipticLonDeg - sun.eclipticLonDeg) * DEG2RAD);
  const clamped = clamp(cosE, -1, 1);
  const elongationDeg = Math.acos(clamped) / DEG2RAD;
  const illuminatedFraction = (1 - clamped) / 2;

  // Earth-Moon distance: the two largest terms only (Meeus ch. 47: 385001 - 20905 cos M'), good to ~1% (an estimate, not
  // a measurement; the Moon's drawn size on floor 4 follows it).
  const distKm = 385001 - 20905 * Math.cos(Mp);

  return { declDeg, subLonEastDeg, eclipticLonDeg, eclipticLatDeg, elongationDeg, illuminatedFraction,
    raDeg: norm360(alphaDeg), distKm };
}

/**
 * Right ascension / declination (degrees) → unit direction in the SKY-DOT frame: the frame `SkyPropagator` (the real-sky dots on
 * floors 4-5, `ui/RealSkyLayer`) puts its satellites in, which is the game's orbit frame (`keplerianToCartesian`, the frame law
 * `OrbitalMechanics.eciToScene`): x = ECI X, y = the polar axis, z = −ECI Y, so RA runs from +X toward −Z (azimuth −atan2(z, x) = RA) and
 * it is the same direction as the Starfield's `raDec2xyz`. NO Earth rotation here: the dots are inertial (the globe turns under them by
 * GMST, R7E). Use it for anything drawn among the dots; NOT for geography (`latLonToUnitVec`).
 * @param {number} raDeg @param {number} declDeg
 * @returns {{ x: number, y: number, z: number }} unit vector (plain object)
 */
export function raDecToDotFrame(raDeg, declDeg) {
  const a = raDeg * DEG2RAD, d = declDeg * DEG2RAD;
  return { x: Math.cos(d) * Math.cos(a), y: Math.sin(d), z: -Math.cos(d) * Math.sin(a) };
}

/**
 * Geographic (lat, east-lon) → unit direction in the Earth-fixed (globe-local) frame; Earth's GMST turn (`Earth.setTurn`) carries it to the world.
 * AUTHORITATIVE geographic→scene entry point: the mirrored-longitude convention
 * is applied INTERNALLY (pass real east longitude; never negate before calling).
 * Unlike latLonToPosition, which does NOT mirror (its callers negate longitude:
 * CityLabels `mirrorLon`, AmbientLaunchScheduler, LaunchCameo).
 *
 * Frame: Y-up polar axis, (0°, 0°) → +X, east longitude toward −Z.
 *
 * @param {number} latDeg      Latitude, degrees north
 * @param {number} lonEastDeg  Geographic east longitude, degrees
 * @returns {{ x: number, y: number, z: number }} unit vector (plain object)
 */
export function latLonToUnitVec(latDeg, lonEastDeg) {
  const lat = latDeg * DEG2RAD;
  const lon = -lonEastDeg * DEG2RAD; // mirrored-longitude convention
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: Math.cos(lat) * Math.sin(lon),
  };
}

/**
 * Latitude / longitude → 3-D position on a sphere of `radius`. Y-up; lat=0,
 * lon=0 → +X; lat=90 → +Y. RAW spherical helper: does NOT apply the mirrored-
 * longitude convention; callers with real east longitude negate it themselves
 * (see `mirrorLon` in CityLabels) or use latLonToUnitVec.
 *
 * @param {number} lat_deg - Latitude in degrees (-90…+90)
 * @param {number} lon_deg - Longitude in degrees (-180…+180)
 */
export function latLonToPosition(lat_deg, lon_deg, radius) {
  const lat = degToRad(lat_deg);
  const lon = degToRad(lon_deg);
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: radius * Math.cos(lat) * Math.sin(lon),
  };
}
