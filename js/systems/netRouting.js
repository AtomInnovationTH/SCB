/**
 * @module systems/netRouting — net-ladder mass routing (single source of truth). Pure helper shared by the Mother fire
 * verb (InputManager.fireLasso), the lasso's own too-heavy rejection (LassoSystem.fire) and any HUD needing the routing
 * copy; also home of the shared mother-net lines. Constants only (no THREE / NetProjectile deps) so the input/lasso
 * layers don't pull the heavy CaptureNet module for a mass comparison.
 */

import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';

/** The ONE line for N with no mother nets left (DECISIONS §33 row 3). Every empty-magazine refusal says exactly this. */
export const OUT_OF_MOTHER_NETS_LINE = 'Out of mother nets. Press D to send a daughter.';

/** N while the nose collar holds a catch, a net is away, or a leash hand-off runs. One home for the line the lasso and
 *  InputManager (the pre-turn refusal) both say; `waitS` (the hand-off's time left, when known) is appended in plain words. */
export const COLLAR_BUSY_LINE = 'Cargo berth busy. Wait for the nose collar to clear.';
export function collarBusyLine(waitS) {
  return Number.isFinite(waitS) && waitS >= 2
    ? `${COLLAR_BUSY_LINE.slice(0, -1)}, about ${Math.ceil(waitS)} s.`
    : COLLAR_BUSY_LINE;
}

/**
 * THE one answer to "would N be refused for the cargo berth right now?" (Ruling 0: no line may invite N while this is true).
 * Busy = a leash hand-off running, or (not `leashOnly`) a catch on the collar, a mother net away, or a lasso catch waiting for
 * the collar. `leashOnly` is the large net, which may fire past a catch on the collar: its aim turn would only replace the
 * hand-off's own turn and hold. `waitS` is the hand-off's seconds left where the driver can say it truly (NaN elsewhere).
 * Read by N's own refusals (InputManager._refuseCollarBusy, LassoSystem.fire) and by every line that invites N
 * (lasso-range hint, the autopilot's pinned-piece and arrival lines). Pure: callers pass what they have, missing parts are free.
 * @param {{leashDriver?: object|null, captureNetSystem?: object|null, pendingAdoption?: boolean, leashOnly?: boolean}} [src]
 * @returns {{busy: boolean, leashBusy: boolean, waitS: number, noseFull: string|null}} `noseFull`: the nose-full refusal line
 *   (CaptureNet.getNoseFullLine) when the catch on the collar can never leave by itself: N is refused for good, so an
 *   invitation says this line, never "then press N".
 */
export function collarBusyState(src) {
  const s = src || {};
  const drv = s.leashDriver || null;
  const cns = s.captureNetSystem || null;
  const leashBusy = !!(drv && (drv.busy === true || (typeof drv.isActive === 'function' && drv.isActive())));
  let busy = leashBusy;
  if (!s.leashOnly && !busy && cns) {
    busy = !!((typeof cns.getDockedCatch === 'function' && cns.getDockedCatch())
      || (typeof cns.hasMotherNetInFlight === 'function' && cns.hasMotherNetInFlight())
      || s.pendingAdoption);
  }
  // The driver gives a number only in the stage where it is true: counted through the line out, the turns, the reel, the latch
  // and the radiator's unfold (LeashDriver.handoffSecondsLeft); NaN in the nose pull-in and in the recovery.
  const waitS = leashBusy && typeof drv.handoffSecondsLeft === 'function' ? drv.handoffSecondsLeft() : NaN;
  // Nose full (a catch on the collar with no furnace, no free tip and no free daughter cell): N is refused for good, not for a
  // wait, so no line may say "then press N". `noseFull` is the refusal's own text; every invitation says it instead.
  const noseFull = !s.leashOnly && busy && cns && typeof cns.getNoseFullLine === 'function'
    ? (cns.getNoseFullLine() || null) : null;
  return { busy, leashBusy, waitS, noseFull };
}

/**
 * The plain-words wait an invitation says while the berth is busy: "The cargo berth is busy for about 20 s" (no seconds part
 * when the driver cannot say them; same under-2 s rule as `collarBusyLine`). No sentence end: the caller adds "; then press N ...".
 * @param {number} waitS
 * @param {boolean} [midSentence] lower-case "the" (the phrase follows a dash, not a full stop)
 * @returns {string}
 */
export function berthBusyPhrase(waitS, midSentence = false) {
  const t = Number.isFinite(waitS) && waitS >= 2
    ? `The cargo berth is busy for about ${Math.ceil(waitS)} s`
    : 'The cargo berth is busy';
  return midSentence ? `t${t.slice(1)}` : t;
}

/**
 * N on a piece beyond the reach of the net that would fire, but inside a docked daughter's reach (DECISIONS §33 row 3).
 * Not said while the mission-1 tutorial runs (its range beat teaches the autopilot instead).
 */
export const OUT_OF_NET_RANGE_LINE = 'Out of net range. Press D to send a daughter.';

/** A daughter with no nets: they refill only at the resupply stop (DECISIONS §33 rows 5 and 8). The map-off words; read
 *  through `daughterOutOfNetsLine()` where the line is said ("resupply satellite" with the map on). */
export const DAUGHTER_OUT_OF_NETS_LINE = 'Out of nets. Restock at the resupply stop.';
export { daughterOutOfNetsLine } from './resupplyWords.js';

/** The ONE line when a shot leaves a single mother net. */
export const ONE_MOTHER_NET_LEFT_LINE = 'One mother net left.';

/**
 * Mass routing for the Mother fire verb (N). One count of mother nets feeds both paths (DECISIONS §33 row 1);
 * the band only says which launcher carries the shot:
 *   ≤ LASSO_MAX_CAPTURE_MASS (10 kg)   → 'lasso'  — the small point-blank net (LassoSystem)
 *   ≤ WEAVER_MAX_CAPTURE_MASS (500 kg) → 'mother' — the mother's large net; a daughter could hold it too
 *   otherwise                          → 'whale'  — the mother's large net; no daughter can hold it
 * N fires at any piece in range while nets remain.
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

// One range truth (owner 2026-10-24: "mother net allows capturing debris more than 100 meters away").
// The HUD distance for a target is the straight line from the ship's centre (player.getPosition()) to the piece's live
// scene position. Every net fire gate and in-flight check uses THIS function, so the number on screen is the number
// that refuses a shot.

/**
 * Distance in metres from the ship's centre to a piece, both in scene units (1 m = SCENE_UNITS_PER_METER).
 * @returns {number} metres (Infinity when either position is missing)
 */
export function targetRangeM(shipPos, targetPos) {
  if (!shipPos || !targetPos) return Infinity;
  const dx = targetPos.x - shipPos.x, dy = targetPos.y - shipPos.y, dz = targetPos.z - shipPos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_UNITS_PER_METER;
}

/** A distance as the HUD writes it (TargetPanel target rows; TargetPanel._formatDist calls this): metres to the nearest, km above 1 km. */
export function hudDistText(distKm) {
  if (distKm < 1) return `${(distKm * 1000).toFixed(0)}m`;
  if (distKm < 10) return `${distKm.toFixed(2)}km`;
  if (distKm < 100) return `${distKm.toFixed(1)}km`;
  return `${distKm.toFixed(0)}km`;
}

/**
 * The refusal line for a shot beyond the net's advertised reach: names the distance (as the HUD writes it) and the
 * limit. When the HUD's rounding would read the same as the limit (100.4 m shows "100m"), one decimal is used instead.
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

// One reach, on screen and at the trigger (DECISIONS §45)

/**
 * Single source of truth for "how far can this net class reach" (metres). Reach is tether-limited AND flight-time-limited:
 * the projectile misses with 'timeout' at MAX_FLIGHT_TIME (per-class override, else the shared default) and with
 * 'tether_limit' at TETHER_MAX, whichever comes first (NetProjectile._updateFlight). Lives here so the reticle can read
 * it without the heavy CaptureNet module; CaptureNet re-exports it.
 * @param {object} netClass — one of CN.LARGE / CN.MEDIUM / CN.SMALL
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
 * (AutoLockController) both read THIS (DECISIONS §45).
 * @param {number} [mass] — target mass (kg); unknown reads as the lasso, as fireLasso routes it
 */
export function netReachForMassM(mass) {
  return classifyNetTarget(mass || 0).band === 'lasso'
    ? Constants.LASSO_RANGE
    : netMaxReachM(Constants.CAPTURE_NET.LARGE);
}

/** Net flight speed in apparent m/s on the NET'S OWN clock for the net N fires at this mass: the lasso flies LASSO_SPEED x
 *  the game-time scale (100 m/s), the large net LAUNCH_SPEED (10 m/s). The large net (and a daughter's) does not run on
 *  the wall clock while a net ceremony slows it: per WALL second multiply by `netFlightClockScale()` (the lasso is never
 *  slowed: no ceremony starts for it). */
export function netFlightSpeedMps(mass) {
  return classifyNetTarget(mass || 0).band === 'lasso'
    ? Constants.LASSO_SPEED * TimeAuthority.BASE_SCALE
    : (Constants.CAPTURE_NET.LARGE.LAUNCH_SPEED || 10);
}

/** @param {number} s @returns {number} s when a usable time scale, else 1 */
const goodScale = (s) => (typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1);

/**
 * The ceremony's beats as the camera builds them (`_onNetCeremonyStart`): wall seconds and the net's clock scale for each.
 * The full sequence for a first-ever shot, the highlights cut after it. The APPROACH_DOLLY beat's cap (it ends early when the
 * net makes contact) is `NET_CEREMONY.APPROACH_BEAT_CAP_S`, the number the camera reads; the camera's own `c.beats` are
 * compared with this table in test-NetCeremonyBeatsMirror.js.
 * @param {boolean} isFirstEver
 * @returns {{key:string, wallS:number, scale:number}[]}
 */
export function netCeremonyBeats(isFirstEver) {
  const NC = Constants.CAPTURE_NET.NET_CEREMONY;
  const BD = NC.BEAT_DURATIONS_S;
  const scaleOf = {
    POD_MUZZLE_PREFIRE: NC.TIME_SCALE_PRE_FLIGHT, MUZZLE_EXIT_SPINUP: NC.TIME_SCALE_PRE_FLIGHT,
    GLAMOUR_SHOT: NC.TIME_SCALE_GLAMOUR, APPROACH_DOLLY: NC.TIME_SCALE_APPROACH,
    BRAKE_ENVELOP: NC.TIME_SCALE_BRAKE, CINCH: NC.TIME_SCALE_CINCH, SECURED_SETTLE: 1,
  };
  const keys = isFirstEver
    ? ['POD_MUZZLE_PREFIRE', 'MUZZLE_EXIT_SPINUP', 'GLAMOUR_SHOT', 'APPROACH_DOLLY', 'BRAKE_ENVELOP', 'CINCH', 'SECURED_SETTLE']
    : (NC.HIGHLIGHTS_CUT_BEATS || []);
  const f = isFirstEver ? 1 : goodScale(NC.HIGHLIGHTS_TIME_SCALE);
  return keys.map((k) => ({ key: k, wallS: (k === 'APPROACH_DOLLY' ? NC.APPROACH_BEAT_CAP_S : (BD[k] || 0)) * f, scale: goodScale(scaleOf[k]) }));
}

/**
 * Wall seconds a net needs to run `internalS` seconds of its OWN clock through the ceremony's beats (the net advances
 * beat.wallS x beat.scale of its own time in each beat; past the last beat it runs at 1). Pure.
 * @param {number} internalS - the net's own seconds (launch delay + flight)
 * @param {boolean} [isFirstEver] - true: the full sequence; false: the highlights cut
 * @returns {number} wall seconds
 */
export function netCeremonyWallS(internalS, isFirstEver = true) {
  let left = Math.max(0, internalS || 0);
  let wall = 0;
  for (const b of netCeremonyBeats(isFirstEver)) {
    const own = b.wallS * b.scale;
    if (left <= own) return wall + left / b.scale;
    left -= own;
    wall += b.wallS;
  }
  return wall + left;
}

/**
 * The "flight clock scale" of a net launched now (a mother's, or a piloted daughter's): its own seconds per wall second.
 * CaptureNet.update scales its dt by CeremonyTimeScale, so the launch delay (CAST_WINDUP + SPIN_UP_TIME run on the net's
 * own timer) and the flight take 1/scale times as many WALL seconds, while the piece keeps drifting on the world clock
 * (the unit its velocity is measured in). At press time no ceremony has started, so this mirrors what the start will do:
 *   - NET_CEREMONY off, a launch ceremony live, or a daughter with no piloted arm (no launcher): none starts, scale 1.
 *   - a net ceremony already running: it keeps its published scale (`st.runningScale`, the current beat's; an estimate,
 *     the later beats of that ceremony run at other scales).
 *   - under the zoom ladder (`st.ladder`) the ceremony is quiet and holds its FIRST beat's scale for the whole flight:
 *     the full sequence opens on 0.4, the highlights cut (first mother net already deployed) on 0.5.
 *   - otherwise the beats advance and the net runs 0.4 / 0.5 / 0.6 / 0.5 in turn: with `st.internalS` (the net's own
 *     seconds to contact) it is the flight's time-weighted scale, own seconds / wall seconds through the beat table.
 *     Without `internalS` it is the first beat's scale, which over-leads (about 1 m at 35 m, 3 m at 90 m on a first shot).
 * Not mirrored: the player skipping the ceremony (Esc) mid-flight, which returns the net to 1 at once; and the brake beat:
 * the camera moves to BRAKE_ENVELOP (scale `NET_CEREMONY.TIME_SCALE_BRAKE`, 0.5) on NET_BRAKE_FIRED, at the end of the flight
 * (`_onNetBrakeFired` sets the beat timer to its duration, so the next camera tick advances), where this table keeps the
 * approach beat's 0.6 until contact.
 * @param {boolean} [isFirstEver] - true: the full ceremony (default); false: the highlights cut
 * @param {{launchCeremonyActive?:boolean, noLauncher?:boolean, runningScale?:number|null, ladder?:boolean, internalS?:number}} [st]
 * @returns {number} multiplier in (0, 1]
 */
export function netFlightClockScale(isFirstEver = true, st = {}) {
  if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return 1;
  if (st.launchCeremonyActive || st.noLauncher) return 1;
  if (typeof st.runningScale === 'number' && st.runningScale > 0) return goodScale(st.runningScale);
  const NC = Constants.CAPTURE_NET.NET_CEREMONY;
  const first = goodScale(isFirstEver ? NC.TIME_SCALE_PRE_FLIGHT : NC.TIME_SCALE_GLAMOUR);
  if (st.ladder || !(st.internalS > 0)) return first;
  const wall = netCeremonyWallS(st.internalS, isFirstEver);
  const s = wall > 0 ? st.internalS / wall : first;
  return Math.min(1, Math.max(0.05, s));
}

/**
 * Where the piece will be, as a distance from the ship centre, when the net gets there. Same linear lead as the aim
 * (computeLeadAim): flight time = distance now / net speed, piece moves by relVel x that time. Pure; scene units and
 * scene units per real second in, metres out.
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
  // r + vr*r/v (an under-estimate). vr >= v: never caught.
  const vr = (relVelScenePerS.x * rx + relVelScenePerS.y * ry + relVelScenePerS.z * rz) / (nowM * M) / M;   // m/s along the line of sight
  if (!(vr > 0)) return leadM;
  if (vr >= netSpeedMps) return Infinity;
  const radialM = nowM * netSpeedMps / (netSpeedMps - vr);
  // lateral part: the sideways drift over the aim's flight time
  const vx = relVelScenePerS.x / M, vy = relVelScenePerS.y / M, vz = relVelScenePerS.z / M;
  const v2 = vx * vx + vy * vy + vz * vz;
  const latM = Math.sqrt(Math.max(0, v2 - vr * vr)) * tof;
  return Math.sqrt(radialM * radialM + latM * latM);
}

/** The ONE line when the piece will have drifted out of the net's reach before the net gets there. */
export function driftOutOfReachLine(predictedM) {
  if (!Number.isFinite(predictedM)) return 'It is moving away faster than the net flies. Close in.';
  return `It would drift out of reach before the net gets there (about ${Math.round(predictedM)} m). Close in.`;
}

// A line never names a key that won't do it (DECISIONS §46 row 2): "Press N to <verb>" is true for a daughter only when
// N goes to HER (InputManager.nWorksDaughter). main.js registers that answer here; the lines said for a daughter
// (Comms' in-position line, ArmUnit's retry lines, ArmIdleAdvisor's idle chips) read it. With nothing registered
// (headless tests, menus) N is assumed to work her.
let _nResolver = null;

/**
 * @param {{works: (arm:object|string, holdPiece?:object|null) => boolean, digit: (arm:object|string) => (number|null),
 *   isPiloted?: () => boolean, escLeaves?: () => boolean}|null} r
 *   works(armOrId, holdPiece): does N work her tool (holdPiece = "as if she were holding station on this piece", for a
 *   line said just before she gets there); digit(armOrId): the 1-based number key that flies her.
 *   OPTIONAL: isPiloted(): is he flying a daughter now (then N works HER tool, not the mother's net); escLeaves():
 *   does Esc leave her for the mother now (ladder engaged, or she is not holding station: else Esc recalls her).
 *   Absent = not piloted / Esc leaves.
 */
export function setNResolver(r) { _nResolver = r || null; }

/** Does N work this daughter's tool now? True when no resolver is registered or it cannot tell. */
export function nWorksFor(armOrId, holdPiece = null) {
  if (!_nResolver || armOrId == null) return true;
  try { return _nResolver.works(armOrId, holdPiece) !== false; } catch (_e) { return true; }
}

export function flyDigitFor(armOrId) {
  if (armOrId && typeof armOrId === 'object' && Number.isInteger(armOrId.index)) return armOrId.index + 1;
  if (!_nResolver || armOrId == null) return null;
  try { const n = _nResolver.digit(armOrId); return Number.isInteger(n) && n >= 1 ? n : null; } catch (_e) { return null; }
}

/**
 * The key words of a line that tells the player to work a daughter's tool: "Press N to <what>" when N does it, else
 * "Press <n> to fly her, then N to <what>". `what` is the verb phrase without "to" ("retry", "stick the pad on").
 * No number known: plain "Press N to ...".
 */
export function pressNToLine(armOrId, what, holdPiece = null) {
  if (nWorksFor(armOrId, holdPiece)) return `Press N to ${what}`;
  const n = flyDigitFor(armOrId);
  return n ? `Press ${n} to fly her, then N to ${what}` : `Press N to ${what}`;
}

/**
 * A whole line that says "Press N to ...": unchanged when N works her, else its first "Press N to" becomes
 * "Press <n> to fly her, then N to". For lines kept as whole literals (Comms' in-position line per tool).
 */
export function flyFirstLine(armOrId, text, holdPiece = null) {
  if (nWorksFor(armOrId, holdPiece)) return text;
  const n = flyDigitFor(armOrId);
  return n ? text.replace('Press N to ', `Press ${n} to fly her, then N to `) : text;
}

// A line that names the MOTHER'S net says what N does when it is shown (DECISIONS §46 row 4)
/** Is he flying a daughter now? False when no resolver, or one without `isPiloted`. */
function _piloted() {
  if (!_nResolver || typeof _nResolver.isPiloted !== 'function') return false;
  try { return !!_nResolver.isPiloted(); } catch (_e) { return false; }
}

export function motherNWorks() { return !_piloted(); }

/** Flying a daughter and Esc would recall her instead of leaving her: a mother-net line is held back, not reworded. */
export function motherNHeldBack() {
  if (!_piloted()) return false;
  if (typeof _nResolver.escLeaves !== 'function') return false;
  try { return _nResolver.escLeaves() === false; } catch (_e) { return false; }
}

/**
 * A line that says "N to <verb>" for the mother's net: unchanged when N works it; while he flies a daughter, its first
 * "N to " becomes "Esc, then N to ". null = hold the line back (Esc would recall her).
 */
export function motherNLine(text) {
  if (motherNWorks()) return text;
  if (motherNHeldBack()) return null;
  return String(text).replace(/\bN to /, 'Esc, then N to ');
}
