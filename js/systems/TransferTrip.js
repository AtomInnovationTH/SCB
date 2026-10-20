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
 * It imports only core modules and TimeAuthority, so the entities that ask it things (ArmManager, CaptureNet,
 * TipCargo) never form an import cycle with it. Every other collaborator is injected (`setDeps`).
 *
 * Time: `update(dt)` takes REAL seconds and GameFlowManager hands it 0 while the world is held (the workbench drawer),
 * so the trip timer, the gas bill and the melt (TipCargo.update gets the same 0) all pause together. The 100x world
 * clock does not speed any of them: melting is `dt x BASE_SCALE x sun`, real dt.
 */
import { Constants } from '../core/Constants.js';
import { eventBus as defaultBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { TimeAuthority } from './TimeAuthority.js';

/** The plain words (DECISIONS §29; owner: plain language, no phase names). */
export const TRIP_LINES = Object.freeze({
  REFUSED: 'Burning to the next field.',
  ARRIVED: 'Arrived at the next field.',
  ARRIVED_LAST_GAS: 'Arrived on the last of the gas.',
});

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
    this._phase = 'idle';           // 'idle' | 'wait' | 'burn'
    this._onArrive = null;
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
   * @param {object} [deps.bus] event bus (tests)
   */
  setDeps(deps) {
    if (!deps) return;
    for (const k of ['player', 'armManager', 'autopilot', 'noseWaiting', 'carryBusy', 'rackCanCarry', 'describe']) {
      if (deps[k] !== undefined) this._d[k] = deps[k];
    }
    if (deps.bus) this._bus = deps.bus;
  }

  // ── asking ────────────────────────────────────────────────────────────────

  /** A trip is pending or burning (the mission start waits for it). */
  isActive() { return this._phase !== 'idle'; }
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

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * A mission boundary: begin a trip instead of starting the next mission at once. `onArrive` runs when the burn
   * ends (it starts the mission). A second call while a trip is pending or burning is ignored (the first one's
   * `onArrive` covers it: it asks the scorer, which starts whichever mission is due).
   * @param {function} [onArrive]
   * @returns {boolean} true = the trip was begun
   */
  begin(onArrive) {
    if (this._phase !== 'idle') return false;
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
    return true;
  }

  /**
   * One frame. `dt` is real seconds (0 while the world is held).
   * @param {number} dt
   */
  update(dt) {
    if (this._phase === 'idle' || !(dt > 0)) return;
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
    this._turned = turn;
    if (ap && typeof ap.holdPrograde === 'function') ap.holdPrograde({ turn });
    if (p && typeof p.setActiveThrustDirection === 'function') p.setActiveThrustDirection(PLUME_ON);

    this._phase = 'burn';
    this._elapsedS = 0;
    this._noteTips();
    _burning = this;
    const amB = this._d.armManager;
    if (amB && typeof amB.setTripPhase === 'function') amB.setTripPhase('burn');
    this._offProcessed = this._bus.on(Events.CATCH_PROCESSED, (e) => this._onProcessed(e));

    const n = this._tipCount() + (this._noseWaiting(true) ? 1 : 0);
    this._say(startLine(n), { _keep: true });
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
    if (this._elapsedS >= Constants.TRIP.MAX_REAL_S) return;      // the cap: no new carry
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
    // Whatever of the trip's gas was not billed yet (a frame that ended it early) is billed now: exactly one trip's worth.
    const rest = Constants.TRIP.DV_MPS - this._billedDv;
    if (rest > 1e-9) {
      this._billedDv = Constants.TRIP.DV_MPS;
      const p = this._d.player;
      if (p && typeof p.billBurnGas === 'function' && p.billBurnGas(rest) < 1 - 1e-9) this._gasShort = true;
    }
    const line = this._gasShort ? TRIP_LINES.ARRIVED_LAST_GAS : TRIP_LINES.ARRIVED;
    const cb = this._onArrive;
    this._onArrive = null;
    this._finish();             // idle and no longer "burning" BEFORE the mission starts (the field spawns, melting is off)
    this._say(line, { _keep: true });
    if (cb) cb();
  }

  /** @private Common tail of an arrival and an abort. */
  _finish() {
    this._phase = 'idle';
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
