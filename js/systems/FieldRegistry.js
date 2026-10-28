/**
 * FieldRegistry — the debris fields, stacked by height, and which of their pieces are still there
 * (DECISIONS §33 row 6; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * `Constants.FIELDS.LIST` names the fields: an id, a height, a seed and a kind. The start field (350 km) is mission 1's
 * welcome field and holds `FIELDS.PIECES` pieces, laid out like DebrisField's WELCOME_FIELD rows (row i = the i-th row
 * of that table); every other `low` field holds one small-piece group (`Constants.smallGroupCount(seed)` rows:
 * `fieldLayout`); a `high` field (750-900 km) holds one piece per row of `Constants.HIGH_FIELD` (`fieldRowCount(field)`),
 * laid out by the same spawn path from parked heavy spares. The registry keeps, per field, the ROWS nobody has caught
 * yet. A caught piece stays gone: a row leaves its field at the credit (`markCaught(piece)`, called by
 * GameFlowManager's CATCH_PROCESSED handler: a catch kept aboard, mated at the nose or parked on a rack, is paid but not
 * removed) or at the removal (Events.DEBRIS_REMOVED: a burn, a digest), whichever comes first; the second is a no-op.
 * A field that is left keeps its other pieces (DebrisField stores them on `depart()` and puts them back on the next
 * visit).
 *
 * What it does NOT do: fly the trip (TransferTrip), draw or place pieces (DebrisField asks `spawnPlan()`), or ask the
 * player where to go (`defaultNext()` is the one-button pick, the nearest other field she can reach).
 *
 * Everything is a no-op while FEATURE_FLAGS.FIELDS_BY_HEIGHT is off: `spawnPlan()` answers null (DebrisField then spawns
 * the welcome field exactly as before), `serialize()` answers null (the save blob stays byte-identical),
 * `defaultNext()` null.
 *
 * THE SATELLITE (DECISIONS §33 row 7; `Constants.RESUPPLY`): she is at a field OR berthed at the resupply satellite
 * (500 km), never both. `arrive('sat500')` berths her; her field id is kept for the fields' state (the pieces she left
 * stay stored as left), `arrive(fieldId)` and `reset()` end the berth. While berthed no field is laid out
 * (`spawnPlan()` answers no rows, and counts as laid out so a load can open the list), no field is "hers", and
 * `defaultNext()` is the nearest field by height from the satellite. `serialize()` adds `berth: 'sat500'` only while
 * berthed.
 *
 * THE FREE PLACE (DECISIONS §33 rows 16-17): a push-down trip ends at a height that is no field and no satellite
 * (`FREE_ID` 'free', `arrive('free', {altKm})`): she is there with nothing laid out (`spawnPlan()` answers no rows, as
 * at the satellite), `currentField()` answers a field-shaped place `{id: 'free', altKm, free: true}` (so
 * `defaultNext()` and the where-next rows count every field from that height, with no Stay: the place has no pieces),
 * `serialize()` adds `freeKm` and keeps `current: 'free'`, and `restore()` puts her back there. Arriving at a field or
 * flying to the satellite ends it (a CALLED satellite keeps it: it comes to her where she is).
 *
 * A CALLED satellite (§33 row 7 "Stuck: call it to you for 1,000 credits") comes to HER: `arrive('sat500', { here: true })`
 * berths her where she is (`berthKm` = her height then). Her field stays hers and stays laid out around her (a mission
 * may still be going on), the satellite's height is hers (`berthedSatellite().altKm`), and `serialize()` adds `berthKm`
 * beside `berth`: a called berth saves and reloads at her height, not at 500 km. `atSatellite()` is the other kind: she
 * flew there and no field is hers.
 *
 * Save: `serialize()` -> `{ v: 1, current: 'f425', remaining: { f350: [0, 2, 3], ... }, at: 2 }`. `at` is the number of
 * the last mission that STARTED (MISSION_START: an arrival, or a Stay); a mission boundary credit writes its save while
 * the trip to the next field is still to be flown, so a save whose mission number (from the catches) is above `at` has
 * a trip owing. Load: `restore(saved, ...)` sets the current field and the pieces, validates everything (an unknown id,
 * a row out of range or a repeated row is dropped; a missing or broken block means "all fresh, at the start field"),
 * and puts her at the field's height. A trip owing is handed back once the field is laid out (`takeResumeTrip()`): the
 * flow manager flies it.
 * @module systems/FieldRegistry
 */
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { engineGasKg } from './ResourceSystem.js';
import { tripProfile, realThrustN, playSeconds, tripDragAreaM2 } from './TripProfile.js';

/**
 * `tripProfile` is pure but costs up to ~10 ms for a 40-day trip and builds ~1200 sample objects; the where-next list
 * plans every field (and `defaultNext` plans them all again), and the four high fields are 25-46 day trips. So the
 * profile is remembered per full input set (every number the function reads, the constants included); callers only
 * read it. Her mass and gas change as she burns, so a changed state is a different key, never a stale answer.
 */
const PROFILE_CACHE_MAX = 64;
const _profileCache = new Map();
function cachedTripProfile(args) {
  const C = Constants;
  const key = [args.fromKm, args.toKm, args.massKg, args.thrustN, args.ispS, args.areaM2, args.cos,
    C.TRIP.PROFILE_STEP_S, C.TRIP.PROFILE_MAX_DAYS, C.EARTH_RADIUS_KM, C.MU_EARTH, C.G0].join('|');
  let hit = _profileCache.get(key);
  if (hit === undefined) {
    hit = tripProfile(args);
    if (_profileCache.size >= PROFILE_CACHE_MAX) _profileCache.delete(_profileCache.keys().next().value);
    _profileCache.set(key, hit);
  }
  return hit;
}

const SAVE_VERSION = 1;

/** The id of the free place a push-down trip ends at (a height that is no field and no satellite). */
export const FREE_ID = 'free';
const FREE_KM_MIN = 100;      // a free height is a real orbit: the saved one is validated against these
const FREE_KM_MAX = 2000;

/**
 * How a field is laid out: 'high' (the HIGH_FIELD rows), 'welcome' (the start field: WELCOME_FIELD's seven rows) or
 * 'group' (a low field that is not the start field: one small-piece group, DECISIONS §38 row 4; the count is
 * `Constants.smallGroupCount(field.seed)`, a pure function of the field's seed, so the registry never imports
 * DebrisField). DebrisField resolves a row's spec by this layout (`DebrisField.fieldRowSpec`).
 * @param {{kind?: string, start?: boolean}|null} field a `FIELDS.LIST` entry
 * @returns {'high'|'welcome'|'group'}
 */
export function fieldLayout(field) {
  if (field && field.kind === 'high') return 'high';
  return field && !field.start ? 'group' : 'welcome';
}

/**
 * How many BASE rows (pieces) a field holds, its own table's: the HIGH_FIELD table's for a `high` field, the group's
 * count for a 'group' field, `FIELDS.PIECES` (the WELCOME_FIELD rows) otherwise. The mission extras (a group or a
 * satellite a mission from 4 on adds, rows `SMALL_GROUP.EXTRA_ROW0` and up) are NOT counted here: they live in the
 * field's saved rows, beyond its table. Read at use time, never cached: there is no global row count.
 */
export function fieldRowCount(field) {
  const layout = fieldLayout(field);
  if (layout === 'high') return Constants.HIGH_FIELD.length;
  if (layout === 'group') return Constants.smallGroupCount(field.seed, 0);
  return Constants.FIELDS.PIECES;
}

/** A paired piece's row (`Constants.PAIR_FIELDS`: the pairs a mission from 2 on adds), valid on any field. */
export function isPairRow(row) {
  const P = Constants.PAIR_FIELDS;
  return Number.isInteger(row) && row >= P.ROW0 && row < P.ROW0 + P.PAIRS * 2;
}

/** A mission extra row (the extra group's pieces, the extra satellite or a paired piece), valid on any field. */
export function isExtraRow(row) {
  const G = Constants.SMALL_GROUP;
  return Number.isInteger(row) && ((row >= G.EXTRA_ROW0 && row < G.EXTRA_ROW0 + G.COUNT_MAX) || row === G.SAT_ROW || isPairRow(row));
}

/** A row that is a piece of a small-piece group on this field (its own group, or the extra one). */
function isGroupRow(field, row) {
  const G = Constants.SMALL_GROUP;
  if (row >= G.EXTRA_ROW0 && row < G.EXTRA_ROW0 + G.COUNT_MAX) return true;
  return fieldLayout(field) === 'group' && row >= 0 && row < fieldRowCount(field);
}

function allRows(field) {
  const out = [];
  for (let i = 0, n = fieldRowCount(field); i < n; i++) out.push(i);
  return out;
}

export class FieldRegistry {
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

  /** FEATURE_FLAGS.FIELDS_BY_HEIGHT (REALITY_MODE can never turn it on). */
  isOn() { return Constants.isFeatureEnabled('FIELDS_BY_HEIGHT'); }

  fields() { return Constants.FIELDS.LIST.slice(); }

  fieldById(id) { return Constants.FIELDS.LIST.find((f) => f.id === id) || null; }

  /**
   * The field she is at (the start field until she arrives somewhere else). At the FREE place a field-shaped place that
   * is no field: `{id: 'free', altKm, seed: 0, kind: 'free', free: true}` (a copy; the table is never changed).
   */
  currentField() {
    if (this._state.freeKm != null) return { id: FREE_ID, altKm: this._state.freeKm, seed: 0, kind: 'free', free: true };
    return this.fieldById(this._state.currentId) || this._startField();
  }

  /**
   * Where she is, for the start lines' "Arrived ..." wording (OpeningDance.setFieldProvider): `{ start, altKm, free, berthed }`,
   * or null when the field map is off (then the field is unknown).
   */
  startLineField() {
    if (!this.isOn()) return null;
    const f = this.currentField();
    return { start: f.start === true, altKm: f.altKm, free: f.free === true, berthed: this.isBerthed() };
  }

  /** She is at the free place a push-down trip ended at (no field is hers, none is laid out). */
  isFree() { return this._state.freeKm != null; }

  currentId() { return this.currentField().id; }

  remainingRows(id) { return (this._state.remaining[id] || []).slice(); }

  remainingCount(id) { return (this._state.remaining[id] || []).length; }

  satellites() { return Constants.RESUPPLY.SATS.slice(); }

  satelliteById(id) { return Constants.RESUPPLY.SATS.find((s) => s.id === id) || null; }

  berthId() { return this._state.berthId; }

  isBerthed() { return this._state.berthId != null; }

  /**
   * The satellite she is berthed at, or null. A called satellite is where she is: its `altKm` is her height at the call
   * (a copy; the table's satellite is never changed).
   */
  berthedSatellite() {
    if (this._state.berthId == null) return null;
    const sat = this.satelliteById(this._state.berthId);
    return sat && this._state.berthKm != null ? { ...sat, altKm: this._state.berthKm } : sat;
  }

  /** Berthed at a satellite that was CALLED to her (she is where she was: her field is hers and stays laid out). */
  berthedHere() { return this._state.berthId != null && this._state.berthKm != null; }

  /** Berthed at the satellite she FLEW to (no field is hers, none is laid out). */
  atSatellite() { return this._state.berthId != null && this._state.berthKm == null; }

  /** The number of the last mission that started (a mission start is owed when the scorer's number is above it). */
  lastMissionStarted() { return this._state.at; }

  /** She lets go (a game over, a win, the menu, a Stay): no longer berthed. Her field and the pieces are as they were. */
  clearBerth() { this._state.berthId = null; this._state.berthKm = null; }

  /**
   * The field to put in front of her: which rows exist, which seed lays out the free rows. Null with the flag off (the
   * caller then spawns the welcome field). `missionNumber` is set once after a load (no MISSION_START fires then) and
   * consumed by the first spawn.
   * `kind` ('low' | 'high') says which table the rows index: WELCOME_FIELD or HIGH_FIELD (a field with no kind is low);
   * `layout` ('welcome' | 'high' | 'group') says it exactly: a row of `SMALL_GROUP.EXTRA_ROW0` or more is a mission extra.
   * @returns {{fieldId: string, altKm: number, rows: number[], seed: number, kind: string, layout: string, missionNumber: (number|null)}|null}
   */
  spawnPlan() {
    if (!this.isOn()) return null;
    this._laidOut = true;             // the field is being laid out now: a trip owing after a load may depart from it
    const f = this.currentField();
    // Berthed: no field is out, but this still counts as laid out (a load into the berth then opens the list from it);
    // a CALLED satellite is where she is: her field stays laid out around her at her own height
    const sat = this.berthedSatellite();
    const plan = {
      fieldId: f.id, altKm: sat ? sat.altKm : f.altKm, rows: this.atSatellite() ? [] : this.remainingRows(f.id), seed: f.seed,     // (the free place has no rows: `remainingRows('free')` is empty)
      kind: f.kind === 'high' ? 'high' : 'low', layout: fieldLayout(f), missionNumber: this._pendingMission,
    };
    this._pendingMission = null;
    return plan;
  }

  /** Her height now, km above the surface (from her orbit), or null without a ship. */
  altitudeKm() {
    const o = this._player && this._player.orbit;
    if (!o || !Number.isFinite(o.semiMajorAxis)) return null;
    return o.semiMajorAxis / Constants.SCENE_SCALE - Constants.EARTH_RADIUS_KM;
  }

  /**
   * What the trip to `target` costs her NOW, with the real thruster and the gas in the tank: the profile, the gas aboard
   * and whether the gas is enough. `target`: a field id or a field, or a satellite (its id or the satellite). `cos` is
   * how much of the push goes the way she wants (1 = she can turn; TransferTrip passes less when a daughter out on her
   * line keeps her where she points).
   * @param {{cos?: number, fromKm?: number, thetaRad?: number, lessKg?: number}} [opts] `thetaRad`: the radiator angle the
   *   drag area is taken at (default her own now, `_flowerThetaRad`; capped at the burn band's edge, 146 deg:
   *   TripProfile.tripDragAreaM2); `lessKg`: plan the trip with her live mass less this much (the climb back up after a
   *   push-down is flown without the piece she let go)
   * @returns {{field: object, fromKm: number, profile: object, ispS: number, areaM2: number, gasAboardKg: number, enough: boolean,
   *   playS: number}|null} `ispS` is the Isp the profile was flown with (the gas's, divided by the gas multiplier c: the
 *   power share x the ion-drive upgrade)
   */
  planTo(target, opts = {}) {
    const field = typeof target === 'string' ? (this.fieldById(target) || this.satelliteById(target)) : target;
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
    // Her drag area is the one at her radiator angle (capped at 146 deg), nose-first, wings sun-tracking.
    const areaM2 = tripDragAreaM2(Number.isFinite(opts.thetaRad) ? opts.thetaRad : p._flowerThetaRad);
    const profile = cachedTripProfile({
      fromKm, toKm: field.altKm, massKg: Number.isFinite(opts.lessKg) && opts.lessKg > 0 ? Math.max(1, p.mass - opts.lessKg) : p.mass, thrustN: realThrustN(fuel), ispS, areaM2,
      cos: opts.cos === undefined ? 1 : opts.cos,
    });
    const gasAboardKg = engineGasKg(p.resources);
    const enough = profile.ok && profile.gasKg <= gasAboardKg + 1e-9;
    return { field, fromKm, profile, ispS, areaM2, gasAboardKg, enough, playS: playSeconds(profile.days) };
  }

  /**
   * The one-button pick: the NEAREST other field, by height from the one she is at, that still has pieces and that she
   * has the gas to reach. Ties go to the cheaper trip. Null = none (stay). Berthed at the satellite no field is hers:
   * every field counts, nearest by height from the satellite.
   * @returns {object|null} the field
   */
  defaultNext() {
    if (!this.isOn()) return null;
    const sat = this.atSatellite() ? this.berthedSatellite() : null;     // (a called satellite is where she is: her own field is hers)
    const here = sat || this.currentField();
    let best = null;
    for (const f of this.fields()) {
      if ((!sat && f.id === here.id) || this.remainingCount(f.id) === 0) continue;
      const plan = this.planTo(f);
      if (!plan || !plan.enough) continue;
      const gap = Math.abs(f.altKm - here.altKm);
      if (!best || gap < best.gap || (gap === best.gap && plan.profile.gasKg < best.gas)) best = { f, gap, gas: plan.profile.gasKg };
    }
    return best ? best.f : null;
  }

  /**
   * A load found a save written at a mission boundary whose trip was not flown: true ONCE, as soon as the field she is in
   * has been laid out (so the trip's departure stores those pieces and no new ones appear behind her), then false. A
   * mission start (the trip arrived, or she stayed) or a reset clears it.
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

  /**
   * She has arrived. A field: this is her field now, the berth ends, the next spawn lays out its pieces. A satellite: she
   * is berthed there (her field id stays as it was, the fields keep their state). An unknown id changes nothing.
   * `opts.here` (a CALLED satellite): it came to her, so she berths where she is: the berth remembers her height now, her
   * field stays hers (without a readable height the satellite is at its own).
   */
  arrive(id, opts) {
    // The free place a push-down trip ends at (`opts.altKm`: its height; an unusable height changes nothing)
    if (id === FREE_ID) {
      const km = opts && opts.altKm;
      if (!Number.isFinite(km) || km < FREE_KM_MIN || km > FREE_KM_MAX) return;
      this._state.freeKm = km; this._state.berthId = null; this._state.berthKm = null;
      return;
    }
    if (this.fieldById(id)) { this._state.currentId = id; this._state.berthId = null; this._state.berthKm = null; this._state.freeKm = null; return; }
    if (!this.satelliteById(id)) return;
    this._state.berthId = id;
    const km = opts && opts.here === true ? this.altitudeKm() : null;
    this._state.berthKm = Number.isFinite(km) ? km : null;
    if (this._state.berthKm == null) this._state.freeKm = null;       // she flew to the satellite: no free place any more (a called one came to her where she is)
  }

  /**
   * Put her at a height (a load, or the end of a trip): the semi-major axis and mean motion follow, tilt, node, argument
   * of perigee and the anomaly stay where they are (she keeps her place along the orbit). A no-op without a ship.
   */
  setHeight(altKm) {
    const p = this._player;
    if (!p || !p.orbit || !Number.isFinite(altKm)) return;
    const aKm = Constants.EARTH_RADIUS_KM + altKm;
    p.orbit.semiMajorAxis = aKm * Constants.SCENE_SCALE;
    p.orbit.meanMotion = Math.sqrt(Constants.MU_EARTH / (aKm * aKm * aKm));
    if (typeof p._updateCartesian === 'function') p._updateCartesian();
  }

  serialize() {
    if (!this.isOn()) return null;
    const remaining = {};
    for (const f of this.fields()) remaining[f.id] = this.remainingRows(f.id);
    const out = { v: SAVE_VERSION, current: this.currentField().id, remaining, at: this._state.at };
    if (this._state.freeKm != null) out.freeKm = Math.round(this._state.freeKm * 1000) / 1000;  // only at the free place (`current` is then 'free')
    if (this._state.berthId != null) {                                    // only while berthed: today's saves stay byte-identical
      out.berth = this._state.berthId;
      if (this._state.berthKm != null) out.berthKm = Math.round(this._state.berthKm * 1000) / 1000;     // a called berth: her height, not the satellite's
    }
    return out;
  }

  /**
   * Load a saved block. Everything is validated; a missing or broken block gives a fresh registry at the start field.
   * With the flag on it also puts her at the field's height and arms `spawnPlan()` to tag the next spawn with the mission.
   * `saved` is `serialize()`'s answer as read from the save; `opts.missionNumber`: the mission the catches count says she
   * is in.
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
      // saved at the free place (a broken height is dropped: she is at the start field, as for any unknown place)
      if (saved.current === FREE_ID && Number.isFinite(saved.freeKm) && saved.freeKm >= FREE_KM_MIN && saved.freeKm <= FREE_KM_MAX) this._state.freeKm = saved.freeKm;
      if (Number.isInteger(saved.at) && saved.at > 0) this._state.at = saved.at;
      // a berth she was saved at (an unknown or broken one is dropped: she is at her saved field)
      if (typeof saved.berth === 'string' && this.satelliteById(saved.berth)) {
        this._state.berthId = saved.berth;
        // a called berth is at HER height (a broken height is dropped: a berth at the satellite's own)
        if (Number.isFinite(saved.berthKm) && saved.berthKm >= 100 && saved.berthKm <= 2000) this._state.berthKm = saved.berthKm;
        if (this._state.berthKm == null) this._state.freeKm = null;       // berthed at the satellite she flew to: not at the free place
      }
      const rem = saved.remaining;
      if (rem && typeof rem === 'object') {
        for (const f of this.fields()) {
          if (!Array.isArray(rem[f.id])) continue;
          const seen = new Set();
          const rowCount = fieldRowCount(f);      // this field's own table (a high field's is not the low field's)
          for (const r of rem[f.id]) if (Number.isInteger(r) && ((r >= 0 && r < rowCount) || isExtraRow(r))) seen.add(r);
          this._state.remaining[f.id] = [...seen].sort((a, b) => a - b);
        }
      }
    }
    if (!this.isOn()) return;
    const sat = this.berthedSatellite();
    this.setHeight(sat ? sat.altKm : this.currentField().altKm);
    // A boundary credit saves while the trip to the next field has not been flown (the daughters are still coming home): the
    // catches say mission N + 1, the last mission started is N. She is still in the field she left, and the trip is owed.
    // A berth always owes the list (she can only be berthed with a start owed, or a call mid-mission: lane 3c): the count says so.
    this._resume = (!!missionNumber && missionNumber > this._state.at) || !!sat || this.isFree();      // (the free place, like a berth, always owes the list)
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

  _startField() { return Constants.FIELDS.LIST.find((f) => f.start) || Constants.FIELDS.LIST[0]; }

  _fresh() {
    const remaining = {};
    for (const f of Constants.FIELDS.LIST) remaining[f.id] = allRows(f);
    return { currentId: this._startField().id, berthId: null, berthKm: null, freeKm: null, remaining, at: 1 };
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
    if (Number.isInteger(n) && n >= Constants.SMALL_GROUP.FROM_MISSION && this.isOn() && !this.isBerthed() && !this.isFree()) this._addMissionExtras(this.currentField());
    if (Number.isInteger(n) && n >= Constants.PAIR_FIELDS.FROM_MISSION && this.isOn() && !this.isBerthed() && !this.isFree()) this._addPairRows(this.currentField());
  }

  /**
   * DECISIONS §38 row 7 (`Constants.PAIR_FIELDS`): a mission from PAIR_FIELDS.FROM_MISSION on adds, to the field it starts
   * at, its pairs of paired pieces (rows ROW0 ..) unless the field still holds an uncaught one. Saved with the field's
   * rows, laid out by the next spawn, like the extras above. Never while berthed, never with the flag off, never before
   * the mission it starts at.
   * @private
   */
  _addPairRows(f) {
    const P = Constants.PAIR_FIELDS;
    const rows = this._state.remaining[f.id] || (this._state.remaining[f.id] = []);
    if (rows.some((r) => isPairRow(r))) return;
    for (let i = 0; i < P.PAIRS * 2; i++) rows.push(P.ROW0 + i);
    rows.sort((a, b) => a - b);
  }

  /**
   * DECISIONS §38 rows 3 and 4: a mission from SMALL_GROUP.FROM_MISSION on adds, to the field it starts at, a small-piece
   * group unless the field already holds an uncaught one (a low non-start field's own group counts) and a dead satellite
   * unless it holds an uncaught one. The rows are appended to the field's saved rows (so they survive a trip away, a save
   * and a load) and laid out by the next spawn. Never while berthed, never with the flag off, never before the mission it
   * starts at.
   * @private
   */
  _addMissionExtras(f) {
    const G = Constants.SMALL_GROUP;
    const rows = this._state.remaining[f.id] || (this._state.remaining[f.id] = []);
    if (!rows.some((r) => isGroupRow(f, r))) {
      for (let i = 0, n = Constants.smallGroupCount(f.seed, 1); i < n; i++) rows.push(G.EXTRA_ROW0 + i);
    }
    if (!rows.includes(G.SAT_ROW)) {
      // a satellite row exists only when a body stands behind it (a mock debris field without the question has no pool to run dry)
      const free = !this._debris || typeof this._debris.hasFreeMissionBody !== 'function' || this._debris.hasFreeMissionBody();
      if (free) rows.push(G.SAT_ROW);
      else console.warn(`[FieldRegistry] no mission-satellite body is free: ${f.id} gets no satellite this mission`);
    }
    rows.sort((a, b) => a - b);
  }

  /**
   * A piece of a field has been caught and paid (a credited catch has left the field, even while it is still aboard): its
   * row leaves its field. No-op for null, a piece with no `fieldId`, an unknown field, or a row already gone (idempotent).
   * Rows update with the flag off too; `serialize()` answers null then.
   */
  markCaught(piece) {
    if (!piece || piece.fieldId == null) return;
    const rows = this._state.remaining[piece.fieldId];
    if (!rows) return;
    const i = rows.indexOf(piece.fieldRow);
    if (i >= 0) rows.splice(i, 1);
  }

  /** @private A piece left the sky (caught, burned, digested): its row leaves its field (a no-op if the credit already took it). */
  _onRemoved(d) {
    if (!d || !this._debris || typeof this._debris.getDebrisById !== 'function') return;
    this.markCaught(this._debris.getDebrisById(d.id));
  }

  _listen(event, fn) {
    if (!event || !this._bus || typeof this._bus.on !== 'function') return;
    const off = this._bus.on(event, fn);
    this._unsubs.push(typeof off === 'function' ? off : () => { if (this._bus.off) this._bus.off(event, fn); });
  }
}
