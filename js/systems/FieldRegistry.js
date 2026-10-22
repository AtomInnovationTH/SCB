/**
 * FieldRegistry - the debris fields, stacked by height, and which of their pieces are still there
 * (Nets step 3 slice 2b, DECISIONS §33 row 6; plan decisions G, H, K; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * `Constants.FIELDS.LIST` names the fields: an id, a height, a seed. The start field (350 km) is mission 1's welcome field.
 * Each field holds `FIELDS.PIECES` pieces, laid out like DebrisField's WELCOME_FIELD rows (row i = the i-th row of that
 * table); the registry keeps, per field, the ROWS nobody has caught yet. A caught piece stays gone: when a piece that carries
 * a `fieldId` is removed (Events.DEBRIS_REMOVED, the one path every catch ends in) its row leaves its field. A field that
 * is left keeps its other pieces (DebrisField stores them on `depart()` and puts them back on the next visit).
 *
 * What it does NOT do: fly the trip (TransferTrip), draw or place pieces (DebrisField asks `spawnPlan()`), or ask the player
 * where to go (lane 2b-2: `defaultNext()` is today's one-button pick, the nearest other field she can reach).
 *
 * Everything is a no-op while FEATURE_FLAGS.FIELDS_BY_HEIGHT is off: `spawnPlan()` answers null (DebrisField then spawns the
 * welcome field exactly as before), `serialize()` answers null (the save blob stays byte-identical), `defaultNext()` null.
 *
 * Save: `serialize()` -> `{ v: 1, current: 'f425', remaining: { f350: [0, 2, 3], ... }, at: 2 }`. `at` is the number of the
 * last mission that STARTED (MISSION_START: an arrival, or a Stay); a mission boundary credit writes its save while the trip
 * to the next field is still to be flown, so a save whose mission number (from the catches) is above `at` has a trip owing.
 * Load: `restore(saved, ...)` sets the current field and the pieces, validates everything (an unknown id, a row out of
 * range or a repeated row is dropped; a missing or broken block means "all fresh, at the start field"), and puts her at the
 * field's height. A trip owing is handed back once the field is laid out (`takeResumeTrip()`): the flow manager flies it.
 */
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { engineGasKg } from './ResourceSystem.js';
import { tripProfile, realThrustN, playSeconds, tripDragAreaM2 } from './TripProfile.js';

const SAVE_VERSION = 1;

function allRows() {
  const out = [];
  for (let i = 0; i < Constants.FIELDS.PIECES; i++) out.push(i);
  return out;
}

export class FieldRegistry {
  /**
   * @param {object} [deps]
   * @param {object} [deps.bus]          event bus (default the game's)
   * @param {object} [deps.debrisField]  DebrisField (getDebrisById, storeFieldPieces)
   * @param {object} [deps.player]       PlayerSatellite (orbit, mass, resources)
   */
  constructor(deps = {}) {
    this._bus = deps.bus || eventBus;
    this._debris = deps.debrisField || null;
    this._player = deps.player || null;
    this._unsubs = [];
    this._state = this._fresh();
    this._pendingMission = null;      // set by restore(): the mission number the next spawn tags its pieces with
    this._resume = false;             // set by restore(): the save was written at a boundary whose trip was never flown
    this._laidOut = false;            // restore() armed it and the first spawn has asked for the field (the pieces are out)
    this._listen(Events.DEBRIS_REMOVED, (d) => this._onRemoved(d));
    this._listen(Events.MISSION_START, (d) => this._onMissionStart(d));
    this._listen(Events.GAME_RESET, () => this.reset());
    this._listen(Events.GAMEOVER_CONTINUE, () => this.reset());
  }

  /** Late wiring (main.js builds the registry before the player exists in some rigs). */
  init(deps = {}) {
    if (deps.debrisField) this._debris = deps.debrisField;
    if (deps.player) this._player = deps.player;
    return this;
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch (_e) { /* gone */ } }
    this._unsubs = [];
  }

  /** @returns {boolean} FEATURE_FLAGS.FIELDS_BY_HEIGHT (REALITY_MODE can never turn it on). */
  isOn() { return Constants.isFeatureEnabled('FIELDS_BY_HEIGHT'); }

  // ── the table ────────────────────────────────────────────────────────────────

  /** @returns {Array<{id: string, altKm: number, seed: number, start?: boolean}>} the fields, low to high (the table's order). */
  fields() { return Constants.FIELDS.LIST.slice(); }

  /** @param {string} id @returns {object|null} */
  fieldById(id) { return Constants.FIELDS.LIST.find((f) => f.id === id) || null; }

  /** @returns {object} the field she is at (the start field until she arrives somewhere else). */
  currentField() { return this.fieldById(this._state.currentId) || this._startField(); }

  /** @returns {string} */
  currentId() { return this.currentField().id; }

  /** @param {string} id @returns {number[]} the rows of that field nobody has caught (a copy, ascending). */
  remainingRows(id) { return (this._state.remaining[id] || []).slice(); }

  /** @param {string} id @returns {number} pieces left in that field. */
  remainingCount(id) { return (this._state.remaining[id] || []).length; }

  // ── what DebrisField asks ────────────────────────────────────────────────────

  /**
   * The field to put in front of her: which rows exist, which seed lays out the free rows. Null with the flag off (the
   * caller then spawns today's welcome field). `missionNumber` is set once after a load (no MISSION_START fires then) and
   * consumed by the first spawn.
   * @returns {{fieldId: string, altKm: number, rows: number[], seed: number, missionNumber: (number|null)}|null}
   */
  spawnPlan() {
    if (!this.isOn()) return null;
    this._laidOut = true;             // the field is being laid out now: a trip owing after a load may depart from it
    const f = this.currentField();
    const plan = { fieldId: f.id, altKm: f.altKm, rows: this.remainingRows(f.id), seed: f.seed, missionNumber: this._pendingMission };
    this._pendingMission = null;
    return plan;
  }

  // ── a trip ───────────────────────────────────────────────────────────────────

  /** @returns {number|null} her height now, km above the surface (from her orbit), or null without a ship. */
  altitudeKm() {
    const o = this._player && this._player.orbit;
    if (!o || !Number.isFinite(o.semiMajorAxis)) return null;
    return o.semiMajorAxis / Constants.SCENE_SCALE - Constants.EARTH_RADIUS_KM;
  }

  /**
   * What the trip to `target` costs her NOW, with the real thruster and the gas in the tank: the profile, the gas aboard and
   * whether the gas is enough. `cos` is how much of the push goes the way she wants (1 = she can turn; TransferTrip passes
   * less when a daughter out on her line keeps her where she points).
   * @param {string|{id: string, altKm: number}} target a field id or a field
   * @param {{cos?: number, fromKm?: number, thetaRad?: number}} [opts] `thetaRad`: the radiator angle the drag area is taken
   *   at (default her own now, `_flowerThetaRad`; capped at the burn band's edge, 146 deg: TripProfile.tripDragAreaM2)
   * @returns {{field: object, fromKm: number, profile: object, ispS: number, areaM2: number, gasAboardKg: number, enough: boolean,
   *   playS: number}|null} `ispS` is the Isp the profile was flown with (the gas's, divided by the gas multiplier c: the power share x the ion-drive upgrade)
   */
  planTo(target, opts = {}) {
    const field = typeof target === 'string' ? this.fieldById(target) : target;
    const p = this._player;
    if (!field || !p) return null;
    const fromKm = Number.isFinite(opts.fromKm) ? opts.fromKm : this.altitudeKm();
    if (!Number.isFinite(fromKm)) return null;
    const fuel = this._loadedGas();
    // c (PlayerSatellite.getConsumptionMultiplier) is the gas multiplier: the power share given to the thrust bus (1 / its
    // multiplier, PowerDistribution._allocationToMultiplier: 1.18 = 1 / 0.85 at the default 40 % share, i.e. 18 % MORE gas than
    // the bare Isp says) times the paid Efficient Ion Drive upgrade (x 0.8). The same push costs c x the gas, i.e. an Isp of
    // isp / c. The trip bills through billBurnGas, which applies c, so the profile is flown with the same Isp.
    const c = typeof p.getConsumptionMultiplier === 'function' ? p.getConsumptionMultiplier() : 1;
    const ispS = fuel.isp / (c > 0 ? c : 1);
    // Her drag area is the one at her radiator angle (capped at 146 deg), nose-first, wings sun-tracking (review F3).
    const areaM2 = tripDragAreaM2(Number.isFinite(opts.thetaRad) ? opts.thetaRad : p._flowerThetaRad);
    const profile = tripProfile({
      fromKm, toKm: field.altKm, massKg: p.mass, thrustN: realThrustN(fuel), ispS, areaM2,
      cos: opts.cos === undefined ? 1 : opts.cos,
    });
    const gasAboardKg = engineGasKg(p.resources);
    const enough = profile.ok && profile.gasKg <= gasAboardKg + 1e-9;
    return { field, fromKm, profile, ispS, areaM2, gasAboardKg, enough, playS: playSeconds(profile.days) };
  }

  /**
   * Today's one-button pick (lane 2b-2 replaces it with a list): the NEAREST other field, by height from the one she is at,
   * that still has pieces and that she has the gas to reach. Ties go to the cheaper trip. Null = none (stay).
   * @returns {object|null} the field
   */
  defaultNext() {
    if (!this.isOn()) return null;
    const here = this.currentField();
    let best = null;
    for (const f of this.fields()) {
      if (f.id === here.id || this.remainingCount(f.id) === 0) continue;
      const plan = this.planTo(f);
      if (!plan || !plan.enough) continue;
      const gap = Math.abs(f.altKm - here.altKm);
      if (!best || gap < best.gap || (gap === best.gap && plan.profile.gasKg < best.gas)) best = { f, gap, gas: plan.profile.gasKg };
    }
    return best ? best.f : null;
  }

  /**
   * A load found a save written at a mission boundary whose trip was not flown (F1 of the 2b-1 review): true ONCE, as soon as
   * the field she is in has been laid out (so the trip's departure stores those pieces and no new ones appear behind her),
   * then false. A mission start (the trip arrived, or she stayed) or a reset clears it.
   * @returns {boolean}
   */
  takeResumeTrip() {
    if (!this._resume || !this._laidOut || !this.isOn()) return false;
    this._resume = false;
    return true;
  }

  /** She is leaving: DebrisField stores the field's pieces that are still free (a held catch keeps riding with her). */
  depart() {
    if (this._debris && typeof this._debris.storeFieldPieces === 'function') this._debris.storeFieldPieces();
  }

  /** She has arrived: this is the field now; the next spawn lays out its pieces. @param {string} id */
  arrive(id) {
    if (this.fieldById(id)) this._state.currentId = id;
  }

  /**
   * Put her at a height (a load, or the end of a trip): the semi-major axis and mean motion follow, tilt, node, argument of
   * perigee and the anomaly stay where they are (she keeps her place along the orbit). A no-op without a ship.
   * @param {number} altKm
   */
  setHeight(altKm) {
    const p = this._player;
    if (!p || !p.orbit || !Number.isFinite(altKm)) return;
    const aKm = Constants.EARTH_RADIUS_KM + altKm;
    p.orbit.semiMajorAxis = aKm * Constants.SCENE_SCALE;
    p.orbit.meanMotion = Math.sqrt(Constants.MU_EARTH / (aKm * aKm * aKm));
    if (typeof p._updateCartesian === 'function') p._updateCartesian();
  }

  // ── save and load ────────────────────────────────────────────────────────────

  /** @returns {{v: number, current: string, remaining: Object<string, number[]>}|null} null with the flag off. */
  serialize() {
    if (!this.isOn()) return null;
    const remaining = {};
    for (const f of this.fields()) remaining[f.id] = this.remainingRows(f.id);
    return { v: SAVE_VERSION, current: this.currentField().id, remaining, at: this._state.at };
  }

  /**
   * Load a saved block. Everything is validated; a missing or broken block gives a fresh registry at the start field.
   * With the flag on it also puts her at the field's height and arms `spawnPlan()` to tag the next spawn with the mission.
   * @param {object|null} saved `serialize()`'s answer, as read from the save
   * @param {{missionNumber?: number}} [opts] `missionNumber`: the mission the catches count says she is in
   */
  restore(saved, opts = {}) {
    this._state = this._fresh();
    this._resume = false;
    this._laidOut = false;
    const missionNumber = Number.isInteger(opts.missionNumber) && opts.missionNumber > 0 ? opts.missionNumber : null;
    // no block, a broken one, or none with an `at` (a save from before it): no trip owing - the mission the catches say started
    this._state.at = missionNumber || 1;
    if (saved && typeof saved === 'object' && saved.v === SAVE_VERSION) {
      if (typeof saved.current === 'string' && this.fieldById(saved.current)) this._state.currentId = saved.current;
      if (Number.isInteger(saved.at) && saved.at > 0) this._state.at = saved.at;
      const rem = saved.remaining;
      if (rem && typeof rem === 'object') {
        for (const f of this.fields()) {
          if (!Array.isArray(rem[f.id])) continue;
          const seen = new Set();
          for (const r of rem[f.id]) if (Number.isInteger(r) && r >= 0 && r < Constants.FIELDS.PIECES) seen.add(r);
          this._state.remaining[f.id] = [...seen].sort((a, b) => a - b);
        }
      }
    }
    if (!this.isOn()) return;
    this.setHeight(this.currentField().altKm);
    // A boundary credit saves while the trip to the next field has not been flown (the daughters are still coming home): the
    // catches say mission N + 1, the last mission started is N. She is still in the field she left, and the trip is owed.
    this._resume = !!missionNumber && missionNumber > this._state.at;
    // the field she is laid out in belongs to the mission that started there, not to the one the catches count has reached
    this._pendingMission = this._resume ? this._state.at : missionNumber;
  }

  /** A new run (GAME_RESET, GAMEOVER_CONTINUE): every field fresh, the start field, nothing pending. */
  reset() {
    this._state = this._fresh();
    this._pendingMission = null;
    this._resume = false;
    this._laidOut = false;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** @private */
  _startField() { return Constants.FIELDS.LIST.find((f) => f.start) || Constants.FIELDS.LIST[0]; }

  /** @private */
  _fresh() {
    const remaining = {};
    for (const f of Constants.FIELDS.LIST) remaining[f.id] = allRows();
    return { currentId: this._startField().id, remaining, at: 1 };
  }

  /** @private The gas that pushes her: the one in the tank (a cargo fuel's own Isp when she is burning cargo metal). */
  _loadedGas() {
    const p = this._player;
    const rs = p && p._resourceSystem;
    const live = rs && typeof rs.getCurrentFuel === 'function' ? rs.getCurrentFuel() : null;
    const fuels = Constants.FUELS || {};
    const id = (p && p.resources && p.resources.tankGasId) || Constants.DEFAULT_FUEL;
    return live || fuels[id] || fuels[Constants.DEFAULT_FUEL];
  }

  /** @private A mission started (she arrived, or stayed): the last mission started is this one, and no trip is owed. */
  _onMissionStart(d) {
    const n = d && d.missionNumber;
    if (Number.isInteger(n) && n > 0) this._state.at = n;
    this._resume = false;
  }

  /** @private A piece left the sky (caught, burned): its row leaves its field. */
  _onRemoved(d) {
    if (!d || !this._debris || typeof this._debris.getDebrisById !== 'function') return;
    const piece = this._debris.getDebrisById(d.id);
    if (!piece || piece.fieldId == null) return;
    const rows = this._state.remaining[piece.fieldId];
    if (!rows) return;
    const i = rows.indexOf(piece.fieldRow);
    if (i >= 0) rows.splice(i, 1);
  }

  /** @private */
  _listen(event, fn) {
    if (!event || !this._bus || typeof this._bus.on !== 'function') return;
    const off = this._bus.on(event, fn);
    this._unsubs.push(typeof off === 'function' ? off : () => { if (this._bus.off) this._bus.off(event, fn); });
  }
}
