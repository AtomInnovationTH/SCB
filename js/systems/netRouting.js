/**
 * netRouting.js — net-ladder mass routing (single source of truth).
 *
 * Pure helper shared by the Mother fire verb (InputManager.fireLasso), the
 * lasso's own too-heavy rejection (LassoSystem.fire), and any HUD that needs
 * the routing copy. Also the home of the two shared mother-net lines. Kept in its own lightweight module (Constants only, no
 * THREE / NetProjectile deps) so the input/lasso layers don't pull the heavy
 * CaptureNet module just for a mass comparison.
 *
 * @module systems/netRouting
 */

import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';

/**
 * The ONE line for N with no mother nets left (DECISIONS §33 row 3; owner 2026-10-20: "One line in Comms is better
 * than 2."). Every empty-magazine refusal says exactly this — the small-net path, the large-net path and the director.
 */
export const OUT_OF_MOTHER_NETS_LINE = 'Out of mother nets. Press D to send a daughter.';

/**
 * N on a piece beyond the reach of the net that would fire, but inside a docked daughter's reach (DECISIONS §33 row 8).
 * Not said while the mission-1 tutorial runs (its range beat teaches the autopilot instead).
 */
export const OUT_OF_NET_RANGE_LINE = 'Out of net range. Press D to send a daughter.';

/** A daughter with no nets: they refill only by buying at the resupply stop (DECISIONS §33 rows 5 and 8). The map-off words; read through
 *  `daughterOutOfNetsLine()` where the line is said (lane 3d: "resupply satellite" with the map on). */
export const DAUGHTER_OUT_OF_NETS_LINE = 'Out of nets. Restock at the resupply stop.';
export { daughterOutOfNetsLine } from './resupplyWords.js';

/** The ONE line when a shot leaves a single mother net (replaces the old "running low at 5" warning). */
export const ONE_MOTHER_NET_LEFT_LINE = 'One mother net left.';

/**
 * Mass routing for the Mother fire verb (N). One count of mother nets feeds both paths (DECISIONS §33 row 1);
 * the band only says which launcher carries the shot:
 *   ≤ LASSO_MAX_CAPTURE_MASS (10 kg)   → 'lasso'  — the small point-blank net (LassoSystem)
 *   ≤ WEAVER_MAX_CAPTURE_MASS (500 kg) → 'mother' — the mother's large net; a daughter could hold it too
 *   otherwise                          → 'whale'  — the mother's large net; no daughter can hold it
 * The old "daughter-sized, press D" refusal for 10–500 kg is gone: N fires at any piece in range while nets remain.
 * @param {number} mass — target mass (kg)
 * @returns {{ band: 'lasso'|'mother'|'whale', message: string|null }}
 *   `message` is the refusal line for the small net on a piece it cannot hold (null for 'lasso').
 */
export function classifyNetTarget(mass) {
  const lassoCap = Constants.LASSO_MAX_CAPTURE_MASS;
  const daughterCap = Constants.WEAVER_MAX_CAPTURE_MASS;
  const m = mass || 0;
  const tooHeavy = 'Too heavy for the lasso.';
  if (m > daughterCap) return { band: 'whale', message: tooHeavy };
  if (m > lassoCap) return { band: 'mother', message: tooHeavy };
  return { band: 'lasso', message: null };
}

// ── One range truth (net-range, owner 2026-10-24: "mother net allows capturing debris more than 100 meters away") ──
// The distance the HUD shows for a target (DebrisField distanceKm, NavSphere label) is the straight line from the
// ship's centre (player.getPosition()) to the piece's live scene position. Every net fire gate and in-flight check
// uses THIS function, so the number on screen and the number that refuses a shot are the same number. (The large
// net used to measure from the muzzle, 1.27 m forward of that, so the two could differ by up to that much.)

/**
 * Distance in metres from the ship's centre to a piece, both in scene units (1 m = SCENE_UNITS_PER_METER).
 * @param {{x:number,y:number,z:number}} shipPos
 * @param {{x:number,y:number,z:number}} targetPos
 * @returns {number} metres (Infinity when either position is missing)
 */
export function targetRangeM(shipPos, targetPos) {
  if (!shipPos || !targetPos) return Infinity;
  const dx = targetPos.x - shipPos.x, dy = targetPos.y - shipPos.y, dz = targetPos.z - shipPos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_UNITS_PER_METER;
}

/**
 * A distance as the HUD writes it (TargetPanel target rows): metres rounded to the nearest, km above 1 km.
 * TargetPanel._formatDist calls this, so the refusal line and the row can never read differently.
 * @param {number} distKm
 * @returns {string}
 */
export function hudDistText(distKm) {
  if (distKm < 1) return `${(distKm * 1000).toFixed(0)}m`;
  if (distKm < 10) return `${distKm.toFixed(2)}km`;
  if (distKm < 100) return `${distKm.toFixed(1)}km`;
  return `${distKm.toFixed(0)}km`;
}

/**
 * The refusal line for a shot at a piece beyond the net's advertised reach: names the distance (written as the HUD
 * writes it) and the limit. When the HUD's rounding would read the same as the limit (100.4 m shows "100m"), it
 * says so plainly with one decimal instead.
 * @param {number} distM
 * @param {number} limitM
 * @param {'net'|'lasso'} [kind]
 * @returns {string}
 */
export function netRangeLine(distM, limitM, kind = 'net') {
  const what = kind === 'lasso' ? 'Out of lasso range' : 'Out of net envelope';
  const limitText = `${Math.round(limitM)}m`;
  let away = hudDistText(distM / 1000);
  if (away === limitText) {
    const d1 = distM.toFixed(1);
    away = Number(d1) > limitM ? `${d1}m` : `just past ${limitText}`;
  }
  return `${what} (${limitText}): the piece is ${away} away. Close in.`;
}

// ── One reach, on screen and at the trigger (net-reach-ticker T2/T3, owner 2026-10-27) ──

/**
 * Single source of truth for "how far can this net class reach" (metres). Reach is tether-limited AND
 * flight-time-limited: the projectile misses with 'timeout' at MAX_FLIGHT_TIME (per-class override, else the shared
 * default) and with 'tether_limit' at TETHER_MAX, whichever comes first (NetProjectile._updateFlight). Lives here so
 * the reticle can read it without the heavy CaptureNet module; CaptureNet re-exports it.
 * @param {object} netClass — one of CN.LARGE / CN.MEDIUM / CN.SMALL
 * @returns {number} max reach in metres
 */
export function netMaxReachM(netClass) {
  if (!netClass) return 0;
  const CN = Constants.CAPTURE_NET;
  const maxFlightTime = netClass.MAX_FLIGHT_TIME ?? CN.MAX_FLIGHT_TIME;
  return Math.min(
    netClass.TETHER_MAX ?? Infinity,
    (netClass.LAUNCH_SPEED ?? 0) * maxFlightTime,
  );
}

/**
 * The reach (metres) of the net the N key fires at a piece of this mass: the lasso (<= 10 kg: LASSO_RANGE, 90 m) or the
 * mother's large net (netMaxReachM, 100 m). The N fire gates (InputManager) and the reticle's yellow OUT OF RANGE
 * (AutoLockController) both read THIS, so the number on screen is the number that refuses a shot.
 * @param {number} [mass] — target mass (kg); unknown reads as the lasso, as fireLasso routes it
 * @returns {number}
 */
export function netReachForMassM(mass) {
  return classifyNetTarget(mass || 0).band === 'lasso'
    ? Constants.LASSO_RANGE
    : netMaxReachM(Constants.CAPTURE_NET.LARGE);
}

/** Net flight speed in apparent m/s (per real second) for the net N fires at this mass: the lasso flies LASSO_SPEED x the
 *  game-time scale (100 m/s), the large net LAUNCH_SPEED (10 m/s; CaptureNet.update runs on real dt). */
export function netFlightSpeedMps(mass) {
  return classifyNetTarget(mass || 0).band === 'lasso'
    ? Constants.LASSO_SPEED * TimeAuthority.BASE_SCALE
    : (Constants.CAPTURE_NET.LARGE.LAUNCH_SPEED || 10);
}

/**
 * Where the piece will be, as a distance from the ship centre, when the net gets there. The same linear lead the aim
 * uses (computeLeadAim): flight time = distance now / net speed, piece moves by relVel x that time. Pure; units are
 * scene units and scene units per real second in, metres out.
 * @param {{x,y,z}} shipPos
 * @param {{x,y,z}} targetPos
 * @param {{x,y,z}|null} relVelScenePerS — piece velocity relative to the ship (null: unknown, reads as not moving)
 * @param {number} netSpeedMps — see netFlightSpeedMps
 * @returns {number} metres (Infinity when a position is missing)
 */
export function predictedRangeAtArrivalM(shipPos, targetPos, relVelScenePerS, netSpeedMps) {
  if (!shipPos || !targetPos) return Infinity;
  const M = Constants.SCENE_UNITS_PER_METER;
  const rx = targetPos.x - shipPos.x, ry = targetPos.y - shipPos.y, rz = targetPos.z - shipPos.z;
  const nowM = Math.sqrt(rx * rx + ry * ry + rz * rz) / M;
  if (!relVelScenePerS || !(netSpeedMps > 0)) return nowM;
  const tof = nowM / netSpeedMps;   // seconds, as computeLeadAim: |bearing| / launch speed
  const ax = rx + relVelScenePerS.x * tof, ay = ry + relVelScenePerS.y * tof, az = rz + relVelScenePerS.z * tof;
  const leadM = Math.sqrt(ax * ax + ay * ay + az * az) / M;
  if (!(nowM > 0)) return leadM;
  // A piece moving AWAY: the net chases it at its own speed v, so the catch happens at r*v/(v - vr), not at the aim lead's
  // r + vr*r/v (an under-estimate: the piece keeps moving while the net flies the longer way). vr >= v: never caught.
  const vr = (relVelScenePerS.x * rx + relVelScenePerS.y * ry + relVelScenePerS.z * rz) / (nowM * M) / M;   // m/s along the line of sight
  if (!(vr > 0)) return leadM;
  if (vr >= netSpeedMps) return Infinity;
  const radialM = nowM * netSpeedMps / (netSpeedMps - vr);
  // lateral part as before: the sideways drift over the aim's flight time
  const vx = relVelScenePerS.x / M, vy = relVelScenePerS.y / M, vz = relVelScenePerS.z / M;
  const v2 = vx * vx + vy * vy + vz * vz;
  const latM = Math.sqrt(Math.max(0, v2 - vr * vr)) * tof;
  return Math.sqrt(radialM * radialM + latM * latM);
}

/** The ONE line when the piece will have drifted out of the net's reach before the net gets there (T2). */
export function driftOutOfReachLine(predictedM) {
  if (!Number.isFinite(predictedM)) return 'It is moving away faster than the net flies. Close in.';
  return `It would drift out of reach before the net gets there (about ${Math.round(predictedM)} m). Close in.`;
}

// ── hints-scan D1/D3 (owner 2026-10-26): a line never names a key that won't do it ──────────────────────────────────
// "Press N to <verb>" is true for a daughter only when N goes to HER (InputManager.nWorksDaughter). main.js registers
// that answer here; the lines said for a daughter (Comms' in-position line, ArmUnit's retry lines, the idle chips of
// ArmIdleAdvisor) read it. With nothing registered (headless tests, menus) N is assumed to work her, as it always did.
let _nResolver = null;

/**
 * @param {{works: (arm:object|string, holdPiece?:object|null) => boolean, digit: (arm:object|string) => (number|null),
 *   isPiloted?: () => boolean, escLeaves?: () => boolean}|null} r
 *   works(armOrId, holdPiece): does N work her tool (holdPiece = "as if she were holding station on this piece", for a line said
 *   just before she gets there); digit(armOrId): the 1-based number key that flies her.
 *   OPTIONAL (n-leftovers L1): isPiloted(): is he flying a daughter now (then N works HER tool, not the mother's net);
 *   escLeaves(): does Esc leave her for the mother now (ladder engaged, or she is not holding station: else Esc recalls her).
 *   Absent = not piloted / Esc leaves, so old registrations and headless tests behave as before.
 */
export function setNResolver(r) { _nResolver = r || null; }

/** Does N work this daughter's tool now? True when no resolver is registered or it cannot tell. */
export function nWorksFor(armOrId, holdPiece = null) {
  if (!_nResolver || armOrId == null) return true;
  try { return _nResolver.works(armOrId, holdPiece) !== false; } catch (_e) { return true; }
}

/** The 1-based number key that flies her, or null. */
export function flyDigitFor(armOrId) {
  if (armOrId && typeof armOrId === 'object' && Number.isInteger(armOrId.index)) return armOrId.index + 1;
  if (!_nResolver || armOrId == null) return null;
  try { const n = _nResolver.digit(armOrId); return Number.isInteger(n) && n >= 1 ? n : null; } catch (_e) { return null; }
}

/**
 * The key words of a line that tells the player to work a daughter's tool: "Press N to <what>" when N does it, else
 * "Press <n> to fly her, then N to <what>" (D3). `what` is the verb phrase without "to" ("retry", "stick the pad on").
 * No number known: plain "Press N to ..." (the old line).
 */
export function pressNToLine(armOrId, what, holdPiece = null) {
  if (nWorksFor(armOrId, holdPiece)) return `Press N to ${what}`;
  const n = flyDigitFor(armOrId);
  return n ? `Press ${n} to fly her, then N to ${what}` : `Press N to ${what}`;
}

/**
 * A whole line that says "Press N to ...": returned as it is when N works her, else its first "Press N to" becomes
 * "Press <n> to fly her, then N to" (D3). For lines kept as whole literals (Comms' in-position line per tool).
 */
export function flyFirstLine(armOrId, text, holdPiece = null) {
  if (nWorksFor(armOrId, holdPiece)) return text;
  const n = flyDigitFor(armOrId);
  return n ? text.replace('Press N to ', `Press ${n} to fly her, then N to `) : text;
}

// ── n-leftovers L1 (owner 2026-10-27): a line that names the MOTHER'S net says what N does when it is shown ──────────
/** Is he flying a daughter now? False when no resolver, or one without `isPiloted`. */
function _piloted() {
  if (!_nResolver || typeof _nResolver.isPiloted !== 'function') return false;
  try { return !!_nResolver.isPiloted(); } catch (_e) { return false; }
}

/** Does N work the mother's net now? False only while he flies a daughter (N goes to HER tool). */
export function motherNWorks() { return !_piloted(); }

/** Flying a daughter and Esc would recall her instead of leaving her: a mother-net line is held back, not reworded. */
export function motherNHeldBack() {
  if (!_piloted()) return false;
  if (typeof _nResolver.escLeaves !== 'function') return false;
  try { return _nResolver.escLeaves() === false; } catch (_e) { return false; }
}

/**
 * A line that says "N to <verb>" for the mother's net: unchanged when N works it; while he flies a daughter, its first
 * "N to " becomes "Esc, then N to " ("In range. Esc, then N to cast", "Press Esc, then N to cast."). null = hold the
 * line back (Esc would recall her).
 */
export function motherNLine(text) {
  if (motherNWorks()) return text;
  if (motherNHeldBack()) return null;
  return String(text).replace(/\bN to /, 'Esc, then N to ');
}
