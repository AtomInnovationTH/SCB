/**
 * Ephemeris.js — Minimal real-sky ephemeris (Sun + Moon) for start-time seeding
 *
 * Computes, for a real wall-clock Date, where the Sun and Moon actually are in
 * the game's Earth-fixed world frame, so the sky at game start matches what is
 * outside the player's window right now:
 *
 *   • Sun: declination + sub-solar east longitude (i.e. where it is local noon)
 *   • Moon: declination + sub-lunar east longitude, elongation from the Sun,
 *     and the illuminated fraction (today's phase)
 *
 * Accuracy: Sun ≈ 0.01° (Meeus low-precision), Moon ≈ 1° (largest series terms
 * only). Both are far below what a player can perceive against a stylized sky.
 *
 * FRAME NOTE — the game world is Earth-FIXED: the Earth mesh never rotates and
 * the equirectangular texture is longitude-mirrored (`mirrorLon: true` in
 * main.js; see also OrbitalMechanics.subPointToOrbit). Geographic east
 * longitude λE therefore maps to scene azimuth −λE, with Y the polar axis and
 * (lat 0, lon 0) on +X. latLonToUnitVec() applies exactly that convention so
 * SunLight and the ground-track code agree.
 *
 * Pure math — no THREE, no DOM — so it runs headless under the test runner.
 *
 * @module scene/Ephemeris
 */

const DEG = Math.PI / 180;

/** Normalize degrees to [0, 360). */
function norm360(d) {
  return ((d % 360) + 360) % 360;
}

/** Normalize degrees to (−180, +180]. */
function norm180(d) {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
}

/**
 * Julian Day from a JS Date (UTC-based, so the user's timezone is handled
 * automatically — a player in Bangkok and one in Madrid get different local
 * solar times from the same instant, which is exactly right).
 * @param {Date} date
 * @returns {number} Julian Day
 */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Greenwich Mean Sidereal Time, degrees in [0, 360). Full IAU 1982 form
 * (including the T² secular terms). Single source of truth — NavSphere's
 * ECI→geodetic conversion imports this same helper, so the seeded sky and the
 * nav readouts can never drift apart.
 * @param {number} d — days since J2000.0 (JD − 2451545.0)
 * @returns {number} GMST in [0, 360)
 */
export function gmstDeg(d) {
  const T = d / 36525.0;
  return norm360(
    280.46061837 + 360.98564736629 * d + T * T * (0.000387933 - T / 38710000)
  );
}

/**
 * Low-precision solar position (Meeus / Astronomical Almanac, ≈0.01°).
 *
 * @param {Date} date
 * @returns {{ declDeg: number, subLonEastDeg: number, eclipticLonDeg: number }}
 *   declDeg        — sub-solar latitude (solar declination), degrees
 *   subLonEastDeg  — geographic east longitude where the sun is at zenith
 *   eclipticLonDeg — geocentric ecliptic longitude (used for moon elongation)
 */
export function sunEphemeris(date) {
  const d = julianDay(date) - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * d);         // mean longitude
  const g = norm360(357.528 + 0.9856003 * d) * DEG;   // mean anomaly
  const lambdaDeg = norm360(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const eps = (23.439 - 0.0000004 * d) * DEG;         // obliquity
  const lam = lambdaDeg * DEG;

  const alphaDeg = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / DEG;
  const declDeg = Math.asin(Math.sin(eps) * Math.sin(lam)) / DEG;

  // Sub-solar point: where right ascension equals local sidereal time.
  const subLonEastDeg = norm180(alphaDeg - gmstDeg(d));
  return { declDeg, subLonEastDeg, eclipticLonDeg: lambdaDeg };
}

/**
 * Low-precision lunar position (Montenbruck & Pfleger truncation, ≈1°) plus
 * phase. Illuminated fraction uses elongation only (ignores the ~1/389
 * Sun-distance parallax term — imperceptible here).
 *
 * @param {Date} date
 * @returns {{
 *   declDeg: number, subLonEastDeg: number,
 *   eclipticLonDeg: number, eclipticLatDeg: number,
 *   elongationDeg: number, illuminatedFraction: number
 * }}
 */
export function moonEphemeris(date) {
  const d = julianDay(date) - 2451545.0;
  const Lp = norm360(218.316 + 13.176396 * d);          // mean longitude
  const Mp = norm360(134.963 + 13.064993 * d) * DEG;    // mean anomaly
  const F = norm360(93.272 + 13.229350 * d) * DEG;      // argument of latitude

  const eclipticLonDeg = norm360(Lp + 6.289 * Math.sin(Mp)); // evection ≫ rest
  const eclipticLatDeg = 5.128 * Math.sin(F);

  const eps = (23.439 - 0.0000004 * d) * DEG;
  const lam = eclipticLonDeg * DEG;
  const bet = eclipticLatDeg * DEG;

  const alphaDeg = Math.atan2(
    Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps),
    Math.cos(lam)
  ) / DEG;
  const declDeg = Math.asin(
    Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam)
  ) / DEG;

  const subLonEastDeg = norm180(alphaDeg - gmstDeg(d));

  // Elongation from the sun on the sphere; illuminated fraction (1 − cos e)/2:
  // 0 at new moon (moon beside the sun), 1 at full moon (opposite the sun).
  const sun = sunEphemeris(date);
  const cosE = Math.cos(bet) * Math.cos((eclipticLonDeg - sun.eclipticLonDeg) * DEG);
  const clamped = Math.max(-1, Math.min(1, cosE));
  const elongationDeg = Math.acos(clamped) / DEG;
  const illuminatedFraction = (1 - clamped) / 2;

  return { declDeg, subLonEastDeg, eclipticLonDeg, eclipticLatDeg, elongationDeg, illuminatedFraction };
}

/**
 * Geographic (lat, east-lon) → unit direction in the game's Earth-fixed world
 * frame. AUTHORITATIVE geographic→scene entry point: the mirrored-longitude
 * convention is applied INTERNALLY here (pass real east longitude, get the
 * scene direction). By contrast, StrategicMap.latLonToPosition is a raw
 * spherical helper that does NOT mirror — its callers negate longitude
 * themselves (StrategicMap.js:722, CityLabels.js:250 `mirrorLon`). Prefer this
 * function when converting real-world coordinates; never negate before
 * calling it.
 *
 * Frame: Y-up polar axis, (0°, 0°) → +X, east longitude toward −Z.
 *
 * @param {number} latDeg      Latitude, degrees north
 * @param {number} lonEastDeg  Geographic east longitude, degrees
 * @returns {{ x: number, y: number, z: number }} unit vector (plain object)
 */
export function latLonToUnitVec(latDeg, lonEastDeg) {
  const lat = latDeg * DEG;
  const lon = -lonEastDeg * DEG; // mirrored-longitude convention
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: Math.cos(lat) * Math.sin(lon),
  };
}
