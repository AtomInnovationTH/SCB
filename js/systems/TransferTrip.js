/**
 * TransferTrip - the burn to the next debris field (lane trip-melt-1, owner 2026-10-19, DECISIONS §29 rows 1 and 4:
 * "they need to be melted down in the furnace during the long ion burn/transition to next debris field").
 *
 * What the player sees: a mission ends, the daughters come home, the ship turns to the way it is going and burns for
 * a while with the world clock at 100x, the four radiator-tip furnaces melt the catches parked on them, and the next
 * field appears when the burn ends. Nothing is unloaded by a station any more.
 *
 * What this module owns (GameFlowManager creates it, feeds it `update(dt)` and clears it on a reset):
 *   - the state machine  idle -> wait (daughters first) -> burn -> idle, and the one callback that runs when the burn
 *     ends (`start()` of the mission, i.e. scoringSystem.checkMissionTransition() -> MISSION_START);
 *   - the end rule (DECISIONS: ends when no tip catch is melting and nothing waiting can move to a tip, after
 *     TRIP.MIN_REAL_S, or at TRIP.MAX_REAL_S);
 *   - the gas bill (TRIP.DV_MPS, once per trip, through the ship's own Δv -> gas conversion), the plume, the words;
 *   - the module-level answers other systems ask while it burns: `tripMelting()` (TipCargo's cook gate),
 *     `tripRefuses(kind)` (the launch / net / lasso / autopilot guards), `isTripBurning()` and `tripWarpArgs()`
 *     (main.js: the world-clock target).
 *
 * It imports only core modules, TimeAuthority and the pure TripProfile, so the entities that ask it things (ArmManager,
 * CaptureNet, TipCargo) never form an import cycle with it. Every other collaborator is injected (`setDeps`).
 *
 * FIELDS BY HEIGHT (Nets step 3 slice 2b, FEATURE_FLAGS.FIELDS_BY_HEIGHT, plan decisions G-K): `begin(onArrive, { field })`
 * with the flag on and the `fields` dep set flies her to another debris field. The burn then PLAYS TripProfile's climb or
 * descent for her real thruster: P real seconds (clamp(60 + 1.5 x days, 60, 120)), each frame her orbit's semi-major axis
 * is set from the profile at the fraction played (eccentricity eased to 0, tilt and node held at their departure values, the
 * anomaly runs on), the strip reads "Climbing to 425 km · day d of D", and the burn ends when the profile has played (a carry
 * still running extends it). A descent holds her nose against her motion.
 *
 * The push follows where her nose really points, ALL the way (review F6, decision I; Ruling 0): the profile is computed once,
 * at burn start, for the push she was planned with (`_planCos`: 1 when she can turn, her measured angle when a daughter out
 * keeps her where she points). Each frame the fraction played advances by (her cosine to the way she goes now / the planned
 * one) x dt / P: a nose 60 deg off plays at half pace, one that comes round plays faster, one at 90 deg or more plays
 * nothing (no push, no gas, the strip says so) until it comes back - for ever once she has pushed (the player can turn her);
 * a trip that has not pushed once waits TURN_WAIT_MAX_S and then stays, as at burn start. The gas is billed by the time the
 * engine really pushed, at the profile's steady flow (its kg / P per real second), and the ship's clock gets the whole burn's
 * real time x days / P (a pause counts: her orbit moves while she waits), so a slow push costs more gas and more days. The flat
 * 20 m/s trip that does not move her is untouched (flag off, or no field given).
 *
 * Power (review R1, Ruling 0): at an empty battery she cannot hold her nose, the autopilot's trip hold lets go of its turn, and a
 * descent (which needs the nose against her motion) pauses with the strip saying "no power to turn". The hold asks for the turn
 * again once the battery holds TRIP.TURN_POWER_WH, and she turns and pushes on. That wait has NO time limit (the bound above is
 * for a turn that is not waiting for power).
 *
 * The resupply satellite (Nets step 3 slice 3, lane 3a): a trip to it is a field trip to a place at 500 km (`begin(onArrive, {field:
 * satellite})`, `Constants.RESUPPLY`); only its words differ (`isSatelliteTarget`: "Climbing to the resupply satellite.", "Arrived at the
 * resupply satellite.", the gas and the nose refusals). `_end` hands the registry the satellite's id: it berths her there.
 *
 * A CALLED satellite (lane 3c, DECISIONS §33 row 7 "Stuck: call it to you for 1,000 credits"): phase `call`, `beginCall(onArrive, {sat, days})`.
 * No burn, no gas, no clock warp: she holds where she is while the satellite comes to her. It plays `playSeconds(days)` real seconds
 * (the same rule as a trip: 60-120 s), the strip reads "Resupply satellite on its way · day d of N", `RESUPPLY_BERTH {phase: 'coming',
 * satId, altKm, playS}` goes out once (lane 3b's look: it approaches over those seconds), and at the end the registry berths her where
 * she is (`fields.arrive(id, {here: true})`), `lastLeg` carries the N days and `onArrive` runs (GameFlowManager: the berth proper).
 * `isActive()` is true meanwhile, so every credit guard that holds while a trip is on holds here too.
 *
 * Where next (Nets step 3 slice 2b, lane 2b-2): with the flag on and floor 4 there to ask on, a mission boundary does not pick the
 * field for her. The trip waits in phase `choose` (before `wait`): `isActive()` is true, so every credit guard that waits while a
 * trip is on (a catch landing while she chooses starts no mission, the stop stays open, a boundary reached is deferred) holds,
 * `update()` does nothing, nothing burns, saves are written. GameFlowManager keeps what happens after the pick in the payload it
 * hands `choose()`; `Events.WHERE_NEXT` says when the list opens and closes (js/ui/WhereNextList.js). `abort()` drops a pending
 * choice, so game over, a win, the menu and a new run leave nothing behind.
 *
 * Time: `update(dt)` takes REAL seconds and GameFlowManager hands it 0 while the world is held (the workbench drawer),
 * so the trip timer, the gas bill and the melt (TipCargo.update gets the same 0) all pause together. The 100x world
 * clock does not speed any of them: melting is `dt x BASE_SCALE x sun`, real dt.
 */
import { Constants } from '../core/Constants.js';
import { eventBus as defaultBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { TimeAuthority } from './TimeAuthority.js';
import { profileAt, playSeconds } from './TripProfile.js';

/** The plain words (DECISIONS §29; owner: plain language, no phase names). */
export const TRIP_LINES = Object.freeze({
  REFUSED: 'Burning to the next field.',
  ARRIVED: 'Arrived at the next field.',
  ARRIVED_LAST_GAS: 'Arrived on the last of the gas.',
});

/** Nets step 3 slice 2b: the plain words of a trip to a named field (heights in km, as the strip says them). */
export function fieldStartLine(dir, toKm, n) {
  const go = `${dir < 0 ? 'Descending' : 'Climbing'} to the ${Math.round(toKm)} km field.`;
  if (!(n > 0)) return go;
  return `${go} The furnaces melt ${n} ${n === 1 ? 'catch' : 'catches'}.`;
}
/** @param {number} toKm */
export function fieldArrivedLine(toKm) { return `Arrived at the ${Math.round(toKm)} km field.`; }
/** @param {number} toKm */
export function fieldNoGasLine(toKm) { return `Not enough gas to reach the ${Math.round(toKm)} km field.`; }
/** Her nose cannot be pointed the way the push must go (review F2): `dir` +1 = along her motion (a climb), -1 = against it. */
export function fieldNoPointLine(dir, toKm) {
  return `Cannot point the ship ${dir < 0 ? 'against' : 'along'} its motion to reach the ${Math.round(toKm)} km field.`;
}

// ── the resupply satellite's words (Nets step 3 slice 3, Constants.RESUPPLY): a place, not "the 500 km field" ──────────────────
/** @param {{id?: string}|null} target @returns {boolean} the target of a trip is a resupply satellite (not a field) */
export function isSatelliteTarget(target) {
  const sats = Constants.RESUPPLY && Constants.RESUPPLY.SATS;
  return !!(target && Array.isArray(sats) && sats.some((s) => s.id === target.id));
}
/** @param {number} dir +1 climb, -1 descent @param {number} n catches the furnaces melt */
export function satelliteStartLine(dir, n) {
  const go = `${dir < 0 ? 'Descending' : 'Climbing'} to the resupply satellite.`;
  if (!(n > 0)) return go;
  return `${go} The furnaces melt ${n} ${n === 1 ? 'catch' : 'catches'}.`;
}
export const SATELLITE_ARRIVED_LINE = 'Arrived at the resupply satellite.';
export const SATELLITE_NO_GAS_LINE = 'Not enough gas to reach the resupply satellite.';
/** @param {number} dir +1 along her motion, -1 against it */
export function satelliteNoPointLine(dir) {
  return `Cannot point the ship ${dir < 0 ? 'against' : 'along'} its motion to reach the resupply satellite.`;
}
/** The one line when a called satellite sets out (lane 3c); the berth line follows when it arrives (GameFlowManager). @param {number} days */
export function calledStartLine(days) {
  const d = Math.max(1, Math.round(days));
  return `Resupply satellite called. It is about ${d} ${d === 1 ? 'day' : 'days'} out.`;
}
// the trip's own words for its destination (a field or a satellite)
const tripStartLine = (dir, f, n) => (isSatelliteTarget(f) ? satelliteStartLine(dir, n) : fieldStartLine(dir, f.altKm, n));
const tripArrivedLine = (f) => (isSatelliteTarget(f) ? SATELLITE_ARRIVED_LINE : fieldArrivedLine(f.altKm));
const tripNoGasLine = (f) => (isSatelliteTarget(f) ? SATELLITE_NO_GAS_LINE : fieldNoGasLine(f.altKm));
const tripNoPointLine = (dir, f) => (isSatelliteTarget(f) ? satelliteNoPointLine(dir) : fieldNoPointLine(dir, f.altKm));

/** "Burning to the next field. The furnaces melt N catches." (or just the first part with none). */
export function startLine(n) {
  if (!(n > 0)) return 'Burning to the next field.';
  return `Burning to the next field. The furnaces melt ${n} ${n === 1 ? 'catch' : 'catches'}.`;
}

/** "Radiator N furnace melted the <size> m <name>." (`what` is "<size> m <name>", or empty when unknown). */
export function meltLine(tipIndex, what) {
  return what
    ? `Radiator ${tipIndex + 1} furnace melted the ${what}.`
    : `Radiator ${tipIndex + 1} furnace melted a catch.`;
}

const CATCH_NAMES = Object.freeze({
  fragment: 'fragment',
  rocketBody: 'rocket body',
  defunctSat: 'dead satellite',
  missionDebris: 'piece of mission debris',
});

/**
 * "<size> m <name>" for a catch, in plain words (the size is the piece's long side, one decimal).
 * @param {{sizeMeter?: number, type?: string}|null} d
 * @returns {string} '' when nothing is known
 */
export function describeCatch(d) {
  if (!d) return '';
  const name = CATCH_NAMES[d.type] || 'piece of debris';
  const s = d.sizeMeter;
  return Number.isFinite(s) && s > 0 ? `${s.toFixed(1)} m ${name}` : name;
}

const SA = Constants.ARM_STATES;
/** A daughter in one of these is home (docked on her strut); the trip does not wait for her. */
const HOME_STATES = new Set([SA.DOCKED, SA.RELOADING, SA.HOLDING_CATCH]);
/** A daughter in one of these will never dock by herself (lost, sacrificed, or waiting for the player's reel). */
const NOT_WAITED_STATES = new Set([SA.EXPENDED, SA.DEORBITING, SA.ADRIFT]);

const PLUME_ON = Object.freeze({ x: 0, y: 0, z: 1 });
const PLUME_OFF = Object.freeze({ x: 0, y: 0, z: 0 });

/** The trip that is burning right now (module-level so the guards need no wiring), or null. */
let _burning = null;

/** True while a trip burns (after the daughters are home): the world clock runs at TRIP.TIME_RATE. */
export function isTripBurning() { return _burning !== null; }

/** The tip furnaces cook only while a trip burns (TipCargo's cook gate: `FURNACE_COOK || tripMelting()`). */
export function tripMelting() { return _burning !== null; }

/**
 * Refusal guard for the actions a burning ship cannot do (daughter launch, mother net, lasso, the player's
 * autopilot). Returns true (refuse) while a trip burns, and says "Burning to the next field." once per `kind` per
 * TRIP.REFUSAL_GAP_S of trip time, so a held key does not spam the comms. False when no trip burns.
 * @param {string} [kind] 'daughter' | 'net' | 'lasso' | 'autopilot' ...
 * @returns {boolean}
 */
export function tripRefuses(kind = 'action') {
  return _burning !== null ? _burning.refuse(kind) : false;
}

/**
 * The per-frame TimeAuthority arguments (main.js). With a trip burning the world clock targets TRIP.TIME_RATE
 * whatever the floor or the ladder state; the open drawer still holds it at 0 and a conjunction alert still clamps
 * it to 1x (safety wins). So does the full-screen shop (ladder off, any state that is not gameplay: `gameplay` false):
 * the trip is paused there like under the drawer (its timer and the melt get no time, see the header), so the clock is
 * held at 0 too - no 100x while shopping, and on leaving it ramps up from 0 instead of jumping. Without a trip: the
 * ladder's floor cap, as before. Fills `out` in place (hot path).
 * @param {object} out the reused TimeAuthority args object
 * @param {{dtReal:number, ladderActive:boolean, floorCap:number, workbenchOpen:boolean, alertActive:boolean, gameplay?:boolean}} p
 *   `gameplay` false = the game is in a non-gameplay state (the shop screen); omitted = gameplay
 * @returns {object} out
 */
export function tripWarpArgs(out, p) {
  const burning = _burning !== null;
  out.dtReal = p.dtReal;
  if (burning) {
    out.active = true;
    // trip-melt-2 D12b: while a leash hand-off or a carry runs, the target drops to the base rate (a hand-off holds a fixed
    // attitude in space; at TIME_RATE the orbit frame turns ~1.1 rad per real second under it) and returns after.
    const rate = _burning.clockSlow() ? Constants.TRIP.HANDOFF_RATE : Constants.TRIP.TIME_RATE;
    out.targetCap = TimeAuthority.calmCap(rate, !!p.workbenchOpen || p.gameplay === false);
  } else {
    out.active = !!p.ladderActive;
    out.targetCap = p.floorCap;
  }
  out.dangerActive = (burning || !!p.ladderActive) && !!p.alertActive;
  return out;
}

export class TransferTrip {
  /**
   * @param {object} [deps] see setDeps
   */
  constructor(deps = {}) {
    this._d = {};
    this._bus = deps.bus || defaultBus;
    this._phase = 'idle';           // 'idle' | 'choose' (waiting for the player's pick of the next field) | 'wait' | 'burn' | 'call' (a called satellite on its way)
    this._onArrive = null;
    this._choice = null;            // what the flow manager keeps while the player chooses (opaque here), or null
    this._waitS = 0;
    this._elapsedS = 0;
    this._billedDv = 0;
    this._gasShort = false;
    this._turned = false;
    this._refusedAt = Object.create(null);
    this._desc = new Map();         // debris id -> "<size> m <name>", noted while the bag is on the tip
    this._offProcessed = null;
    this._noseAgeS = 0;
    this._noseCached = false;
    this._carryAgeS = 0;            // trip-melt-2: s since the daughters were last looked at for a carry
    this._carrySaid = Object.create(null);   // '<arm>|<reason>' -> said this trip
    this._rackAgeS = 0;
    this._rackCached = false;
    this.melted = 0;                // catches melted by this trip so far
    // Nets step 3 slice 2b (fields by height): null/0 unless the trip flies to a field
    this._field = null;             // the destination field ({id, altKm, ...}) while a field trip is pending or burning
    this._profile = null;           // TripProfile's answer, fixed at burn start
    this._playP = 0;                // P: real seconds the profile plays in
    this._playS = 0;                // real seconds of the profile played so far (stands still while the push is blocked)
    this._overS = 0;                // real seconds since the profile ended (a carry still running holds the end)
    this._turnWaitS = 0;            // real seconds the push has waited for her nose to come round
    this._pausedS = 0;              // real seconds the push has waited with her nose not along the way she goes (cos <= 0)
    this._pushS = 0;                // real seconds the engine has really pushed (the gas is billed by this, not by the profile's fraction)
    this._flownS = 0;               // real seconds of the burn up to the end of the profile, pauses included (the ship's days follow this)
    this._wasPower = false;         // last frame the turn was let go of for want of power (its return gives the new turn its own wait)
    this._billedKg = 0;             // kg of the profile's gas billed so far
    this._veEff = 0;                // exhaust speed of the profile (m/s, the gas multiplier c folded in)
    this._dep = null;               // her tilt, node and perigee at departure (held for the whole trip)
    this._poseAsked = false;        // the radiators were asked to the burn angle (once per trip)
    this._planCos = 1;              // the share of the push along the way she wants that the profile was planned with (the pace is her cosine now over this)
    // lane 3c: a called satellite on its way (phase 'call')
    this._callSat = null;           // the satellite ({id, altKm, ...}) that is coming
    this._callDays = 0;             // the days it takes (the ship's clock gets them at the end)
    this._callPlayS = 0;            // real seconds the wait plays in
    this._callS = 0;                // real seconds played so far
    /** The last leg flown ({fieldId, altKm, days, gasKg}), set when a field trip arrives; GameFlowManager reads it in `onArrive`. */
    this.lastLeg = null;
    this.setDeps(deps);
  }

  /**
   * @param {object} deps
   * @param {object} [deps.player] the ship: tipCargo, setActiveThrustDirection(dir), billBurnGas(dvMps), leashDriver
   * @param {object} [deps.armManager] arms[], getRotationLockTier(), carryCheck/requestCarry/isCarrying/rackCanCarry
   * @param {object} [deps.autopilot] holdPrograde({turn}), releasePrograde(), engaged, disengage(reason)
   * @param {function} [deps.noseWaiting] () => true when a nose catch is waiting that can still move to a tip
   * @param {function} [deps.carryBusy] () => true while a daughter carries (default: armManager.isCarrying())
   * @param {function} [deps.rackCanCarry] () => true when a rack catch can still be carried, now or once its tip frees
   *   (default: armManager.rackCanCarry())
   * @param {function} [deps.describe] (debris) => "<size> m <name>"
   * @param {object} [deps.fields] Nets step 3 slice 2b: {planTo(field, {cos}), depart(), arrive(fieldId, {here})} (FieldRegistry's trip face; `here`: a called satellite)
   * @param {object} [deps.bus] event bus (tests)
   */
  setDeps(deps) {
    if (!deps) return;
    for (const k of ['player', 'armManager', 'autopilot', 'noseWaiting', 'carryBusy', 'rackCanCarry', 'describe', 'fields']) {
      if (deps[k] !== undefined) this._d[k] = deps[k];
    }
    if (deps.bus) this._bus = deps.bus;
  }

  // ── asking ────────────────────────────────────────────────────────────────

  /** A trip is pending or burning, or she is choosing where to go (the mission start waits for it). */
  isActive() { return this._phase !== 'idle'; }
  /** Nets step 3 slice 2b (lane 2b-2): the player is picking the next field (nothing burns, nothing waits for the daughters yet). */
  isChoosing() { return this._phase === 'choose'; }
  /** What was handed to `choose()` while the choice is pending, else null. */
  get choice() { return this._phase === 'choose' ? this._choice : null; }
  /** Lane 3c: a called resupply satellite is on its way (nothing burns; she holds where she is). */
  isCalling() { return this._phase === 'call'; }
  /** Waiting for the daughters to come home. */
  isWaiting() { return this._phase === 'wait'; }
  /** Burning: the clock runs at TRIP.TIME_RATE, the tip furnaces melt, launches are refused. */
  isBurning() { return this._phase === 'burn'; }
  /** Real seconds the burn has run (0 before / after). */
  get elapsedS() { return this._elapsedS; }
  /** Did the burn start with the ship turned to prograde (false: it burns as it points)? */
  get turned() { return this._turned; }
  /** Did the tank run short of the trip's gas? */
  get gasShort() { return this._gasShort; }
  /** Δv (m/s) billed so far this trip. */
  get billedDv() { return this._billedDv; }
  /** The field this trip flies to ({id, altKm, ...}), or null (a flat trip, or none). */
  get field() { return this._field; }
  /** The TripProfile this trip plays (fixed at burn start), or null. */
  get profile() { return this._profile; }
  /** Real seconds the profile takes to play (P), or 0. */
  get playSeconds() { return this._playP; }
  /** How far along the profile is, 0..1 (0 when there is none). */
  get progress() { return this._profile && this._playP > 0 ? Math.min(1, this._playS / this._playP) : 0; }
  /** kg of the profile's gas billed so far. */
  get billedKg() { return this._billedKg; }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * A mission boundary: begin a trip instead of starting the next mission at once. `onArrive` runs when the burn
   * ends (it starts the mission). A second call while a trip is pending or burning is ignored (the first one's
   * `onArrive` covers it: it asks the scorer, which starts whichever mission is due).
   * @param {function} [onArrive]
   * @param {{field?: object}} [opts] Nets step 3 slice 2b: `field` (a FieldRegistry field) flies her there with the flag on
   *   (FIELDS_BY_HEIGHT) and the `fields` dep set. False when the gas does not cover the whole profile (nothing begins, the
   *   words are said); without a field, or with the flag off, the flat trip as ever.
   * @returns {boolean} true = the trip was begun
   */
  begin(onArrive, opts) {
    if (this._phase !== 'idle') return false;
    let field = null;
    const want = opts && opts.field;
    if (want && this._d.fields && Constants.isFeatureEnabled('FIELDS_BY_HEIGHT')) {
      const plan = this._d.fields.planTo(want, { cos: 1 });
      if (!plan || !plan.enough) {
        this._say(tripNoGasLine(want), { _keep: true });
        return false;                // no start without the gas for the whole profile
      }
      field = want;
    }
    this._field = field;
    this._profile = null;
    this._poseAsked = false;
    this._onArrive = typeof onArrive === 'function' ? onArrive : null;
    this._phase = 'wait';
    this._waitS = 0;
    this._elapsedS = 0;
    this._billedDv = 0;
    this._gasShort = false;
    this._turned = false;
    this.melted = 0;
    this._refusedAt = Object.create(null);
    this._carrySaid = Object.create(null);
    this._carryAgeS = 0;
    this._rackAgeS = 0;
    this._rackCached = false;
    const am = this._d.armManager;
    if (am && typeof am.resetCarryGiveUps === 'function') am.resetCarryGiveUps();   // a daughter whose last carry failed may try again
    if (am && typeof am.setTripPhase === 'function') am.setTripPhase('wait');         // petal-single: the mission scheduler stands aside; no new carry starts until the burn
    this._desc.clear();
    if (field) this._askBurnPose();    // the radiators come to the burn band while the daughters come home
    return true;
  }

  /**
   * Nets step 3 slice 2b (lane 2b-2): the boundary asks the player where to go instead of picking for her. The trip waits in phase
   * `choose` until `leaveChoice()`; `Events.WHERE_NEXT {open: true}` tells the list to open. Only from idle.
   * @param {*} payload what the caller needs back after the pick (the mission start); read through `choice`
   * @param {{again?: boolean}} [opts] `again`: a refused pick puts the choice back (the list is rebuilt, not a first opening)
   * @returns {boolean} true = now choosing
   */
  choose(payload, opts) {
    if (this._phase !== 'idle') return false;
    this._phase = 'choose';
    this._choice = payload === undefined ? null : payload;
    this._bus.emit(Events.WHERE_NEXT, opts && opts.again ? { open: true, again: true } : { open: true });
    return true;
  }

  /**
   * The pick was made (or the choice is dropped): back to idle and `Events.WHERE_NEXT {open: false}`. The caller then begins a trip
   * or starts the mission; if its trip is refused it calls `choose(payload, {again: true})` to put the choice back.
   * @returns {*} the payload given to `choose()` (null when she was not choosing)
   */
  leaveChoice() {
    if (this._phase !== 'choose') return null;
    const payload = this._choice;
    this._choice = null;
    this._phase = 'idle';
    this._bus.emit(Events.WHERE_NEXT, { open: false });
    return payload;
  }

  /**
   * Lane 3c: a satellite was called to her (the 1,000 credits are paid by the caller). She holds where she is for `playSeconds(days)`
   * real seconds, then the registry berths her here and `onArrive` runs. Only from idle (after `leaveChoice()`).
   * @param {function} onArrive runs when the satellite has arrived (the berth proper)
   * @param {{sat: {id: string, altKm: number}, days: number}} opts the satellite and the days it takes (the ship's clock gets them)
   * @returns {boolean} true = the wait began
   */
  beginCall(onArrive, opts) {
    const sat = opts && opts.sat;
    const days = opts && opts.days;
    if (this._phase !== 'idle' || !sat || !(days > 0)) return false;
    this._phase = 'call';
    this._callSat = sat;
    this._callDays = days;
    this._callPlayS = playSeconds(days);
    this._callS = 0;
    this._onArrive = typeof onArrive === 'function' ? onArrive : null;
    this.lastLeg = null;
    // the strip: the trip's own hold word (TRANSFER) without turning her nose or pushing: she holds where she is
    const ap = this._d.autopilot;
    if (ap && typeof ap.holdPrograde === 'function') ap.holdPrograde({ turn: false });
    this._callStatus();
    this._bus.emit(Events.RESUPPLY_BERTH, { phase: 'coming', satId: sat.id, altKm: this._fromKm(), playS: this._callPlayS });
    this._say(calledStartLine(days), { _keep: true });
    return true;
  }

  /**
   * One frame. `dt` is real seconds (0 while the world is held).
   * @param {number} dt
   */
  update(dt) {
    if (this._phase === 'idle' || this._phase === 'choose' || !(dt > 0)) return;     // choosing: nothing runs, she waits for the player
    if (this._phase === 'call') { this._tickCall(dt); return; }
    if (this._phase === 'wait') {
      this._waitS += dt;
      const home = this.daughtersHome();
      if (home || this._waitS >= Constants.TRIP.WAIT_DOCK_MAX_S) this._startBurn(home);
      return;
    }
    this._tickBurn(dt);
  }

  /**
   * Stop without arriving (reset, game over, back to the menu): releases the hold and the plume, forgets the
   * callback - the mission is NOT started. Safe when idle.
   */
  abort() {
    if (this._phase === 'idle') return;
    if (this._phase === 'choose') { this.leaveChoice(); return; }      // nothing was set up yet: just drop the choice (and close the list)
    if (this._phase === 'call') { this._onArrive = null; this._finish(); return; }     // a called satellite that never comes: nothing burns, nothing to settle
    // trip-melt-2 D8: a game over / reset / load mid-carry: she snaps docked, her catches stay on her rack, the strut and
    // the radiators go back, the tip reservation is cleared (ArmUnit.abortCarry)
    const am = this._d.armManager;
    if (am && typeof am.abortAllCarries === 'function') am.abortAllCarries('trip abort');
    this._finish();
    this._onArrive = null;
  }

  /**
   * Is every daughter that can still come home home? Docked, reloading or holding a catch is home; lost, sacrificed,
   * detached and adrift ones are not waited for (they cannot dock by themselves); every other state ends in docking
   * and is waited for (launching, in transit, netting, hauling, reeling, returning, docking, ...). Unknown future
   * states are therefore waited for, bounded by TRIP.WAIT_DOCK_MAX_S.
   * @returns {boolean}
   */
  daughtersHome() {
    const arms = this._d.armManager && this._d.armManager.arms;
    if (!Array.isArray(arms)) return true;
    for (const a of arms) {
      if (!a || a.isDetached) continue;
      const s = a.state;
      if (HOME_STATES.has(s) || NOT_WAITED_STATES.has(s)) continue;
      return false;
    }
    return true;
  }

  /** The refusal (see `tripRefuses`): true while burning; says its line once per kind per REFUSAL_GAP_S. */
  refuse(kind) {
    if (this._phase !== 'burn') return false;
    const last = this._refusedAt[kind];
    if (last === undefined || this._elapsedS < last || this._elapsedS - last >= Constants.TRIP.REFUSAL_GAP_S) {
      this._refusedAt[kind] = this._elapsedS;
      this._say(TRIP_LINES.REFUSED, { _reactive: true });
    }
    return true;
  }

  // ── the burn ──────────────────────────────────────────────────────────────

  /** @private Turn (when nothing limits it), light the plume, say the start line, register as the burning trip. */
  _startBurn(allHome) {
    const p = this._d.player;
    const ap = this._d.autopilot;
    // The player's own autopilot would fly a rendezvous burn through applyCartesianImpulse (battery, orbit): off.
    if (ap && ap.engaged && typeof ap.disengage === 'function') ap.disengage('TRANSFER');
    // The prograde turn only when every daughter is home and the rotation lock lets the ship turn: a daughter
    // still on her line is never swung round (the 60 s cap case burns as the ship points).
    const turn = allHome && this._canTurn();
    // Nets step 3 slice 2b: a trip to a field is planned HERE, with her mass, radiators and attitude as they are now. When she
    // can turn the whole push goes the way she wants; when a daughter out on her line keeps her where she points, only the
    // share along her nose does (the profile still burns full thrust). No gas for it, or no push that way: she stays.
    let plan = null;
    if (this._field) {
      this._askBurnPose();
      const fields = this._d.fields;
      const dirWanted = this._field.altKm >= this._fromKm() ? 1 : -1;
      const cos = turn ? 1 : this._aimCos(dirWanted);
      if (!(cos > 1e-9)) {                // she cannot turn and her nose is not along (or against) her motion: no push that way, she stays (review F2)
        this._say(tripNoPointLine(dirWanted, this._field), { _keep: true });
        this._stay();
        return;
      }
      plan = fields && Constants.isFeatureEnabled('FIELDS_BY_HEIGHT') ? fields.planTo(this._field, { cos }) : null;
      this._planCos = cos;
      if (!plan || !plan.enough) {
        this._say(tripNoGasLine(this._field), { _keep: true });
        this._stay();
        return;
      }
    }
    this._turned = turn;
    if (ap && typeof ap.holdPrograde === 'function') ap.holdPrograde(plan ? { turn, retro: plan.profile.dir < 0, reask: true } : { turn });
    if (p && typeof p.setActiveThrustDirection === 'function') p.setActiveThrustDirection(PLUME_ON);

    this._phase = 'burn';
    this._elapsedS = 0;
    this._noteTips();
    _burning = this;
    const amB = this._d.armManager;
    if (amB && typeof amB.setTripPhase === 'function') amB.setTripPhase('burn');
    this._offProcessed = this._bus.on(Events.CATCH_PROCESSED, (e) => this._onProcessed(e));

    const n = this._tipCount() + (this._noseWaiting(true) ? 1 : 0);
    if (plan) {
      this._beginProfile(plan);
      this._say(tripStartLine(plan.profile.dir, this._field, n), { _keep: true });
    } else {
      this._say(startLine(n), { _keep: true });
    }
  }

  // ── fields by height (Nets step 3 slice 2b) ───────────────────────────────

  /** @private Her height now, km (from her orbit), or the destination's own when there is no orbit to read. */
  _fromKm() {
    const o = this._d.player && this._d.player.orbit;
    return o && Number.isFinite(o.semiMajorAxis)
      ? o.semiMajorAxis / Constants.SCENE_SCALE - Constants.EARTH_RADIUS_KM
      : (this._field ? this._field.altKm : (this._callSat ? this._callSat.altKm : 0));
  }

  /** @private The cosine of the angle between her nose (+Z) and her motion; null when either is unknown (a stub, no velocity). */
  _noseCos() {
    const p = this._d.player;
    if (!p || !p.quaternion || typeof p.getVelocity !== 'function') return null;
    let v;
    try { v = p.getVelocity(); } catch (_e) { return null; }
    const len = v ? Math.hypot(v.x, v.y, v.z) : 0;
    if (!(len > 0)) return null;
    const q = p.quaternion;
    const nx = 2 * (q.x * q.z + q.w * q.y);      // the third column of her rotation: her +Z in the world
    const ny = 2 * (q.y * q.z - q.w * q.x);
    const nz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return (nx * v.x + ny * v.y + nz * v.z) / len;
  }

  /**
   * @private How much of her thrust goes the way the trip wants, 0..1, from where her nose points RIGHT NOW: cos of the angle
   * between the nose and her motion (a climb pushes along it, a descent against it), nothing below zero. 1 when it cannot be read.
   * @param {number} dir +1 climb, -1 descent
   */
  _aimCos(dir) {
    const c = this._noseCos();
    return c === null ? 1 : Math.max(0, Math.min(1, dir * c));
  }

  /**
   * @private The radiators above the burn band's edge are brought down to it (the public pose command, once per trip). While a
   * petal is held for a catch hand-off or a daughter carries, the ship refuses every pose command and speaks the PLAYER's
   * refusal line ("Radiators held for the catch hand-off."): the trip does not ask then (as ThermalSystem's auto-open does not),
   * keeps the request unspent and asks again on a later frame (review F4; the push waits for the radiators meanwhile).
   */
  _askBurnPose() {
    const p = this._d.player;
    if (this._poseAsked || !p || typeof p.setFlowerPose !== 'function') return;
    if (!this._radiatorsAboveBurnBand()) return;
    if (p.flowerCommandsLocked === true) return;
    this._poseAsked = true;
    p.setFlowerPose('STOW');                     // 146 deg, the burn band's edge
  }

  /** @private The radiators are above the angle she can thrust at (no push then). */
  _radiatorsAboveBurnBand() {
    const p = this._d.player;
    const th = p && p._flowerThetaRad;
    return Number.isFinite(th) && th * 180 / Math.PI > Constants.TRIP.BURN_POSE_MAX_DEG + 0.01;
  }

  /** @private Fix the plan at burn start: the profile, how long it plays, her tilt and node, and the departure of the field. */
  _beginProfile(plan) {
    this._profile = plan.profile;
    this._playP = plan.playS;
    this._playS = 0;
    this._overS = 0;
    this._turnWaitS = 0;
    this._pausedS = 0;
    this._pushS = 0;
    this._flownS = 0;
    this._wasPower = false;
    this._billedKg = 0;
    this._veEff = plan.ispS * Constants.G0;
    const o = this._d.player && this._d.player.orbit;
    this._dep = o ? { e0: o.eccentricity || 0, inclination: o.inclination, raan: o.raan, argPerigee: o.argPerigee } : null;
    this._d.fields.depart();                     // the field she leaves keeps its pieces: stored, not simulated
    this._pushStatus(0);
  }

  /** @private The trip could not go (no gas for it once planned with the real mass and attitude): she stays, the mission starts. */
  _stay() {
    const cb = this._onArrive;
    this._onArrive = null;
    this._finish();
    if (cb) cb();
  }

  /** @private The strip while a called satellite is on its way: which day of how many (the same rounding as a trip's days). */
  _callStatus() {
    const ap = this._d.autopilot;
    if (!ap || typeof ap.setTripStatus !== 'function') return;
    const days = Math.max(1, Math.round(this._callDays));
    const f = this._callPlayS > 0 ? Math.min(1, this._callS / this._callPlayS) : 1;
    ap.setTripStatus({ call: true, day: Math.min(days, Math.floor(f * days) + 1), days });
  }

  /** @private One frame of the wait for a called satellite (real seconds; a held world gives 0). */
  _tickCall(dt) {
    this._callS += dt;
    this._callStatus();
    if (this._callS >= this._callPlayS) this._endCall();
  }

  /** @private The called satellite has come: the registry berths her where she is, the leg (days only) is kept for the caller, `onArrive` runs. */
  _endCall() {
    const sat = this._callSat;
    this.lastLeg = { fieldId: sat.id, altKm: this._fromKm(), days: this._callDays, gasKg: 0, called: true };
    if (this._d.fields) this._d.fields.arrive(sat.id, { here: true });
    const cb = this._onArrive;
    this._onArrive = null;
    this._finish();
    if (cb) cb();
  }

  /** @private No push while the radiators are above the burn band, or her nose is still coming round (bounded). */
  _pushBlocked(dt) {
    if (this._radiatorsAboveBurnBand()) { this._askBurnPose(); return true; }
    const ap = this._d.autopilot;
    if (ap && typeof ap.tripTurnErrorRad === 'function' && this._turnWaitS < Constants.TRIP.TURN_WAIT_MAX_S
        && ap.tripTurnErrorRad() > Constants.TRIP.TURN_OK_DEG * Math.PI / 180) {
      this._turnWaitS += dt;
      return true;
    }
    return false;
  }

  /** @private Set her orbit from the profile at `f` (0..1): height from the profile, shape and plane held, the anomaly runs on. */
  _applyProfile(f) {
    const o = this._d.player && this._d.player.orbit;
    const dep = this._dep;
    if (!o || !dep) return;
    const s = profileAt(this._profile, f);
    o.semiMajorAxis = s.a * Constants.SCENE_SCALE;
    o.meanMotion = Math.sqrt(Constants.MU_EARTH / (s.a * s.a * s.a));
    o.eccentricity = dep.e0 * (1 - f);
    o.inclination = dep.inclination;
    o.raan = dep.raan;
    // keep her place along the orbit (the argument of latitude) while the perigee is held: a push that nudged the shape
    // must not move her round the circle
    const u = o.argPerigee + o.trueAnomaly;
    o.argPerigee = dep.argPerigee;
    o.trueAnomaly = u - dep.argPerigee;
  }

  /**
   * @private Bill the gas for the time the engine has really pushed (review F6): the profile's steady flow, its kg / P per real
   * second, through the ship's own gas bill (`billBurnGas`). At the planned pace this IS the profile's mass drop at the fraction
   * played; a slow push burns for longer and so bills more, a pause bills nothing.
   */
  _billPush() {
    const p = this._d.player;
    if (!p || typeof p.billBurnGas !== 'function' || !(this._playP > 0)) return;
    const due = this._profile.gasKg * this._pushS / this._playP;
    const chunk = due - this._billedKg;
    if (!(chunk > 0)) return;
    const mNow = p.mass;
    this._billedKg = due;
    if (!(mNow > 0) || !(this._veEff > 0)) return;
    const dv = chunk * this._veEff / mNow;        // billBurnGas bills c * m_ship * dv / (Isp g0): this makes it `chunk` kg
    this._billedDv += dv;
    if (p.billBurnGas(dv) < 1 - 1e-9) this._gasShort = true;
  }

  /**
   * @private The days on the ship's clock: the burn's real time up to the end of the profile x the profile's days / P. A pause
   * counts (her orbit moves while she waits; review R3), a slow push takes longer. Time after the profile has played (a carry
   * still finishing) does not: she has arrived.
   */
  _flownDays() {
    return this._profile && this._playP > 0 ? this._profile.days * this._flownS / this._playP : 0;
  }

  /** @private The turn is let go of for want of power (the autopilot's trip hold waits for the battery: review R1). */
  _waitsForPower() {
    const ap = this._d.autopilot;
    return !!(ap && typeof ap.tripTurnWaitsForPower === 'function' && ap.tripTurnWaitsForPower());
  }

  /** @private The strip's words: where, and which day of how many; `paused` = the push waits for her nose (no thrust that way) or for power to turn. */
  _pushStatus(f, paused = false) {
    const ap = this._d.autopilot;
    if (!ap || typeof ap.setTripStatus !== 'function' || !this._profile) return;
    const days = Math.max(1, Math.round(this._profile.days));
    ap.setTripStatus({
      dir: this._profile.dir, toKm: this._field.altKm, day: Math.min(days, Math.floor(f * days) + 1), days,
      ...(paused ? { wait: this._waitsForPower() ? 'power' : 'nose' } : {}),
    });
  }

  /**
   * @private One frame of the profile burn (see the header): the fraction played advances by pace x dt / P, where the pace is her
   * nose's cosine to the way she goes NOW over the cosine the profile was planned with; the gas follows the time pushed. Ends the
   * trip once the profile has played.
   */
  _tickProfile(dt) {
    this._elapsedS += dt;
    this._noseAgeS += dt;
    let paused = false;
    if (this._playS < this._playP) {
      let used = dt;                              // real time flown this frame: all of it, a pause or a wait for the turn included (R3)
      const power = this._waitsForPower();
      if (this._wasPower && !power) this._turnWaitS = 0;   // the power is back and the turn is asked for again: it gets its own wait
      this._wasPower = power;
      if (!this._pushBlocked(dt)) {
        const cosNow = this._aimCos(this._profile.dir);
        if (cosNow > 1e-9) {                      // (the floor is numeric noise: an exact 90 deg reads +-1e-16)
          const pace = cosNow / this._planCos;
          const left = this._playP - this._playS;
          const adv = Math.min(left, pace * dt);
          this._playS += adv;
          this._pushS += adv / pace;              // (the last frame counts only the time it needed)
          used = adv / pace;
        } else {
          paused = true;                          // her nose is not along the way she goes: no push, no gas, until it is
          // A pause for want of power has no bound (R1: the turn comes back with the battery, and she turns and pushes on). A trip
          // that has not pushed once and cannot for another reason (the turn never completes) would wait for ever: after the turn
          // wait's own bound she stays, as at burn start (F2).
          if (!this._waitsForPower()) {
            this._pausedS += dt;
            if (this._pushS === 0 && this._pausedS >= Constants.TRIP.TURN_WAIT_MAX_S) {
              this._say(tripNoPointLine(this._profile.dir, this._field), { _keep: true });
              this._stay();
              return;
            }
          }
        }
      }
      this._flownS += used;
    }
    const f = this._playP > 0 ? this._playS / this._playP : 1;
    this._applyProfile(f);
    this._billPush();
    this._pushStatus(f, paused);
    this._noteTips();
    this._tickCarry(dt);
    if (this._playS < this._playP) return;
    // The profile is over. A carry still running holds the end (it finishes, CARRY_BACK to docked); one still running
    // FINISH_GRACE_S later (stuck) is aborted, she snaps docked.
    this._overS += dt;
    if (this._carryBusy()) {
      if (this._overS < Constants.CARRY.FINISH_GRACE_S) return;
      const am = this._d.armManager;
      if (am && typeof am.abortAllCarries === 'function') am.abortAllCarries('trip cap');
    }
    this._end();
  }

  /** @private Nothing limits the ship's turn: no daughter out on a tether, none clamped for a launch. */
  _canTurn() {
    const am = this._d.armManager;
    if (!am) return true;
    if (typeof am.getRotationLockTier === 'function' && am.getRotationLockTier() !== 'none') return false;
    const arms = am.arms;
    if (Array.isArray(arms) && arms.some((a) => a && a.state === SA.LAUNCHING)) return false;
    return true;
  }

  /** @private */
  _tickBurn(dt) {
    if (this._profile) { this._tickProfile(dt); return; }
    const T = Constants.TRIP;
    this._elapsedS += dt;
    this._noseAgeS += dt;
    this._billGas();
    this._noteTips();
    this._tickCarry(dt);
    if (this._elapsedS >= T.MAX_REAL_S) {
      // trip-melt-2 D8: at the cap no new carry starts, and a carry in flight finishes (CARRY_BACK to docked) before the
      // trip ends; a carry that is still running FINISH_GRACE_S later (stuck) is aborted, she snaps docked
      if (this._carryBusy()) {
        if (this._elapsedS < T.MAX_REAL_S + Constants.CARRY.FINISH_GRACE_S) return;
        const am = this._d.armManager;
        if (am && typeof am.abortAllCarries === 'function') am.abortAllCarries('trip cap');
      }
      this._end();
      return;
    }
    if (this._elapsedS >= T.MIN_REAL_S && this._tipCount() === 0 && !this._noseWaiting()
        && !this._carryBusy() && !this._rackCanCarry()) this._end();
  }

  // ── carries (trip-melt-2) ─────────────────────────────────────────────────

  /** @private A daughter is on a carry (or the injected answer says so). */
  _carryBusy() {
    const f = this._d.carryBusy;
    if (typeof f === 'function') return !!f();
    const am = this._d.armManager;
    return !!(am && typeof am.isCarrying === 'function' && am.isCarrying());
  }

  /** @private A rack catch can still be carried, now or once its tip / the bags / the hand-off free up (asked at most every 0.25 s). */
  _rackCanCarry(force = false) {
    const f = this._d.rackCanCarry;
    const am = this._d.armManager;
    const ask = typeof f === 'function' ? f : (am && typeof am.rackCanCarry === 'function' ? () => am.rackCanCarry() : null);
    if (!ask) return false;
    if (force || this._rackAgeS >= 0.25) {
      this._rackAgeS = 0;
      this._rackCached = !!ask();
    }
    return this._rackCached;
  }

  /**
   * @private Once per CARRY.CHECK_S (real) while burning, before the cap: if no daughter is carrying, start the first one
   * that can (first free tip first, ties by daughter index). A catch that will never carry (does not fit a tip, a row the
   * gate does not allow, no fuel) says so once per trip; the end rule ignores it. Waits for a busy tip or a hand-off are silent.
   */
  _tickCarry(dt) {
    this._rackAgeS += dt;
    const am = this._d.armManager;
    if (!am || typeof am.carryCheck !== 'function' || typeof am.requestCarry !== 'function') return;
    this._carryAgeS += dt;
    if (this._carryAgeS < Constants.CARRY.CHECK_S) return;
    this._carryAgeS = 0;
    // the cap: no new carry (a field trip's cap is the end of its profile, P)
    if (this._profile ? this._playS >= this._playP : this._elapsedS >= Constants.TRIP.MAX_REAL_S) return;
    if (this._carryBusy()) return;                                // one at a time
    // petal-single: the look itself is the arm manager's (the same one a mission uses); the trip owns when and what it says
    if (typeof am.scheduleCarry === 'function') {
      am.scheduleCarry({ mission: false, said: this._carrySaid, say: (text) => this._say(text, { _keep: true }) });
      return;
    }
    const tc = this._d.player && this._d.player.tipCargo;
    const arms = (am.arms || []).filter((a) => a && !a.isDetached);
    const tipTaken = (a) => (tc && typeof tc.debrisAt === 'function' && tc.debrisAt(a.index) ? 1 : 0);
    arms.sort((a, b) => tipTaken(a) - tipTaken(b) || a.index - b.index);
    for (const arm of arms) {
      const r = am.carryCheck(arm);
      if (r.ok) {
        am.requestCarry(arm);
        return;
      }
      const sayIt = r.text && (r.reason === 'fit' || r.reason === 'gate' || r.reason === 'fuel');
      if (sayIt) {
        const key = `${arm.index}|${r.reason}`;
        if (!this._carrySaid[key]) {
          this._carrySaid[key] = true;
          this._say(r.text, { _keep: true });
        }
      }
    }
  }

  /** True while a leash hand-off or a carry runs on the trip: the world clock drops to TRIP.HANDOFF_RATE (D12b). */
  clockSlow() {
    if (this._phase !== 'burn') return false;
    if (this._carryBusy()) return true;
    const drv = this._d.player && this._d.player.leashDriver;
    return !!(drv && drv.busy);
  }

  /**
   * @private Bill TRIP.DV_MPS of gas once per trip, spread over the first TRIP.MIN_REAL_S of the burn (the burn is
   * never shorter), with the ship's own Δv -> gas conversion (`player.billBurnGas`, the one `applyCartesianImpulse`
   * uses). A tank with less than that is drained and the trip still arrives (`gasShort`). No battery is drawn and
   * the orbit is not touched: this is not an impulse.
   */
  _billGas() {
    const T = Constants.TRIP;
    const want = T.DV_MPS * Math.min(1, this._elapsedS / Math.max(1e-6, T.MIN_REAL_S));
    const chunk = want - this._billedDv;
    if (!(chunk > 0)) return;
    this._billedDv = want;
    const p = this._d.player;
    if (!p || typeof p.billBurnGas !== 'function') return;
    const paid = p.billBurnGas(chunk);
    if (paid < 1 - 1e-9) this._gasShort = true;
  }

  /** @private Number of catches on the tips. */
  _tipCount() {
    const tc = this._d.player && this._d.player.tipCargo;
    return tc && typeof tc.count === 'function' ? tc.count() : 0;
  }

  /** @private A nose catch is waiting that can still move to a tip (asked at most every 0.25 s: it reads reach geometry). */
  _noseWaiting(force = false) {
    const f = this._d.noseWaiting;
    if (typeof f !== 'function') return false;
    if (force || this._noseAgeS >= 0.25) {
      this._noseAgeS = 0;
      this._noseCached = !!f();
    }
    return this._noseCached;
  }

  /** @private Remember what each tip bag holds, so the melt line can name it after the body is gone. */
  _noteTips() {
    const tc = this._d.player && this._d.player.tipCargo;
    const describe = this._d.describe || describeCatch;
    if (!tc || typeof tc.debrisAt !== 'function') return;
    for (let i = 0; i < 4; i++) {
      const d = tc.debrisAt(i);
      if (d && d.id !== undefined && !this._desc.has(d.id)) this._desc.set(d.id, describe(d) || '');
    }
  }

  /** @private A tip furnace finished a catch (TipCargo's own CATCH_PROCESSED): say which. */
  _onProcessed(e) {
    if (this._phase !== 'burn' || !e || e.source !== 'tip' || e.digested !== true) return;
    this.melted++;
    const what = this._desc.get(e.debrisId) || '';
    this._desc.delete(e.debrisId);
    this._say(meltLine(e.tipIndex >= 0 ? e.tipIndex : 0, what), { _keep: true });
  }

  /** @private The burn is over: settle the gas, say it, stop the plume and the hold, then run the callback. */
  _end() {
    let line;
    if (this._profile) {
      // Nets step 3 slice 2b: she lands exactly on the field's height (circular), the registry records the arrival (it lays the
      // field out at the mission start, not here), the leg is kept for the caller: the days of the whole burn, pauses included
      // (review R3), and the gas billed for the time the engine pushed (review F6: not the profile's, when her nose was off).
      this._applyProfile(1);
      this.lastLeg = { fieldId: this._field.id, altKm: this._field.altKm, days: this._flownDays(), gasKg: this._billedKg };
      if (this._d.fields) this._d.fields.arrive(this._field.id);
      line = this._gasShort ? TRIP_LINES.ARRIVED_LAST_GAS : tripArrivedLine(this._field);
    } else {
      // Whatever of the trip's gas was not billed yet (a frame that ended it early) is billed now: exactly one trip's worth.
      const rest = Constants.TRIP.DV_MPS - this._billedDv;
      if (rest > 1e-9) {
        this._billedDv = Constants.TRIP.DV_MPS;
        const p = this._d.player;
        if (p && typeof p.billBurnGas === 'function' && p.billBurnGas(rest) < 1 - 1e-9) this._gasShort = true;
      }
      line = this._gasShort ? TRIP_LINES.ARRIVED_LAST_GAS : TRIP_LINES.ARRIVED;
    }
    const cb = this._onArrive;
    this._onArrive = null;
    this._finish();             // idle and no longer "burning" BEFORE the mission starts (the field spawns, melting is off)
    this._say(line, { _keep: true });
    if (cb) cb();
  }

  /** @private Common tail of an arrival and an abort. */
  _finish() {
    this._phase = 'idle';
    this._field = null;
    this._profile = null;
    this._dep = null;
    this._callSat = null;
    if (_burning === this) _burning = null;
    const amF = this._d.armManager;
    if (amF && typeof amF.setTripPhase === 'function') amF.setTripPhase(null);      // petal-single: carries are a mission thing again
    if (this._offProcessed) { this._offProcessed(); this._offProcessed = null; }
    const ap = this._d.autopilot;
    if (ap && typeof ap.releasePrograde === 'function') ap.releasePrograde();
    const p = this._d.player;
    if (p && typeof p.setActiveThrustDirection === 'function') p.setActiveThrustDirection(PLUME_OFF);
    this._desc.clear();
  }

  /** @private */
  _say(text, tag) {
    this._bus.emit(Events.COMMS_MESSAGE, { text, priority: 'info', ...tag });
  }
}
