/**
 * TouchActionChip.js — on glass, every game line that asks for an action with a key has a button.
 *
 * The comms lines say "Launch the net" / "Tap SEND DAUGHTER" (GestureHints.chipPhrase). A touch player has no N or D
 * key, so this module keeps ONE tappable step chip on screen while the action is on offer:
 *   · a piece is within net reach, a mother net is left, none is in flight  → LAUNCH NET  (KeyN)
 *   · the mother has no nets left, or N was refused as "out of net range"   → SEND DAUGHTER (KeyD)
 *   · a daughter holds station on the piece ("Daughter in position. Press N…")
 *     → LAUNCH NET / STICK PAD / CLOSE GRIPPER / USE MAGNET (KeyN: her tool)
 * It reuses the ticker's step-chip mechanism (HINT_POSTED step:true + press + button): a tap takes exactly the
 * keyboard's path, refusals included. It never covers a teaching-beat chip (HintTicker.hasStepChip) and takes its
 * own chip down the moment its condition ends. Driven by events and live state, never by matching comms text
 * (the one exception is a line chip: it is told WHICH KEY a shown line named, not what the line said). Glass only (the
 * caller constructs it inside the TouchControls.detect() block); floors 2-3 only.
 *
 * Rules (details at the methods):
 *   - "A daughter is holding" is read from the arms' state (STATION_KEEP) on the poll, not from enter/exit events: a
 *     daughter that returns to station after a missed net never emits STATION_KEEP_ENTERED.
 *   - A line chip lasts 30 s (gone on that key's press, target cleared, floor left) and outranks a state chip. LET GO is
 *     the exception: it does NOT end on "target cleared" (cleared when the catch berths, maybe before the line).
 *   - A beat chip (BEAT_CHIPS) is never timed out, never ends on a floor change (only held back while the floor is not
 *     2-3), and no later line or state chip replaces it.
 *
 * @module ui/TouchActionChip
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GestureHints } from './hud/GestureHints.js';
import { captureNetSystem } from '../entities/CaptureNet.js';

export const TOUCH_ACTION_CHIP_ID = 'touch_action_chip';

/** The two chips, same wording as the teaching beats' chips (OnboardingDirector IN_REACH_NUDGE / MOTHER_EMPTY_CHIP). */
const CHIPS = Object.freeze({
  net: Object.freeze({ text: 'Launch the net', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'LAUNCH NET' }),
  pad: Object.freeze({ text: 'Stick the pad on', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'STICK PAD' }),
  // N works whichever tool she holds (ArmUnit.dispatchSelectedTool), so each tool has its own word; `net` is both nets.
  grip: Object.freeze({ text: 'Close the gripper', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'CLOSE GRIPPER' }),
  magnet: Object.freeze({ text: 'Use the magnet', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'USE MAGNET' }),
  daughter: Object.freeze({ text: 'Send a daughter', glyph: 'D', keys: Object.freeze(['KeyD']), press: 'KeyD', button: 'SEND DAUGHTER' }),
  autopilot: Object.freeze({ text: 'Autopilot in', glyph: 'A', keys: Object.freeze(['KeyA']), press: 'KeyA', button: 'AUTOPILOT' }),
  scan: Object.freeze({ text: 'Scan', glyph: 'S', keys: Object.freeze(['KeyS']), press: 'KeyS', button: 'SCAN' }),
  reel: Object.freeze({ text: 'Reel her home', glyph: 'R', keys: Object.freeze(['KeyR']), press: 'KeyR', button: 'REEL' }),
  letgo: Object.freeze({ text: 'Let the catch go', glyph: 'K', keys: Object.freeze(['KeyK']), press: 'KeyK', button: 'LET GO' }),
  // K lets go of a no-salvage bag a daughter holds on her rack (GameFlowManager.letGoRackBag). Its own kind so it never
  // takes the slot from a teaching step chip the way the collar's LET GO does.
  letgobag: Object.freeze({ text: 'Let the bag go', glyph: 'K', keys: Object.freeze(['KeyK']), press: 'KeyK', button: 'LET GO' }),
  choose: Object.freeze({ text: 'Choose what to do with it', glyph: 'U', keys: Object.freeze(['KeyU']), press: 'KeyU', button: 'CHOOSE' }),
  // I opens the full-screen library; the SPECS tab opens a different (side) view, so it needs its own button.
  read: Object.freeze({ text: 'Read more', glyph: 'I', keys: Object.freeze(['KeyI']), press: 'KeyI', button: 'READ MORE' }),
  // Shift+S is the only way to a wide scan (KeyDispatch.pressKey parses the Shift form). Beat chip only; outside the lesson
  // the WIDE SCAN button (TouchVerbButton) carries it, after a first wide scan.
  widescan: Object.freeze({ text: 'Wide scan', glyph: 'S', keys: Object.freeze(['Shift+KeyS']), press: 'Shift+KeyS', button: 'WIDE SCAN' }),
  // The burn lesson waits for THROTTLE_CHANGE; the throttle is Shift+= (+10 %), no touch control exists.
  throttle: Object.freeze({ text: 'Throttle up', glyph: '+', keys: Object.freeze(['Shift+Equal']), press: 'Shift+Equal', button: 'THROTTLE UP' }),
});

/**
 * Lessons (BEATS_BY_MISSION ids) whose trigger event only a key press makes on glass, by chip kind. `needs` = a state the
 * key needs (the chip is held back, not removed, while false): 'pilot' = a piloted daughter in flight (TRANSIT /
 * APPROACH), where N deploys the MANUAL net (ArmUnit.manualNetDeploy, the only source of ARM_CAPTURED manual:true).
 */
export const BEAT_CHIPS = Object.freeze({
  ch2_manual_capture: Object.freeze({ kind: 'net', needs: 'pilot' }),
  ch3_wide_scan: Object.freeze({ kind: 'widescan', needs: null }),
  ch3_codex: Object.freeze({ kind: 'read', needs: null }),
  ch5_burn: Object.freeze({ kind: 'throttle', needs: null }),
});

const KIND_KEY = Object.freeze({ net: 'KeyN', pad: 'KeyN', grip: 'KeyN', magnet: 'KeyN', daughter: 'KeyD', autopilot: 'KeyA', scan: 'KeyS', reel: 'KeyR', letgo: 'KeyK', letgobag: 'KeyK', choose: 'KeyU', read: 'KeyI', widescan: 'Shift+KeyS', throttle: 'Shift+Equal' });

/** Chip kinds that are KeyN; a daughter holding the piece decides which one is true now. */
const N_KINDS = Object.freeze(['net', 'pad', 'grip', 'magnet']);
/** Chip kinds that name HER tool (only true while she holds station). */
const TOOL_KINDS = Object.freeze(['pad', 'grip', 'magnet']);

/** The chip kind for the tool a station-keeping daughter holds ('NET' | 'PAD' | 'GRIPPER' | 'MAGNET'; anything else = the net). */
function toolKind(tool) {
  return tool === 'PAD' ? 'pad' : tool === 'GRIPPER' ? 'grip' : tool === 'MAGNET' ? 'magnet' : 'net';
}

/** Daughter states in which N deploys a MANUAL net (ArmUnit.manualNetDeploy). */
const MANUAL_NET_STATES = Object.freeze(['TRANSIT', 'APPROACH']);

/**
 * The skill reminders that name an action key (SKILLS.CATALOG `say`, posted by OnboardingDirector._onSkillReminded
 * as HINT_POSTED id 'remind_<skillId>'), by the chip kind their key has.
 */
export const REMINDER_KIND = Object.freeze({
  scan_quick: 'scan', collect_lasso: 'net', arm_pilot_capture: 'net', collect_deploy: 'daughter', nav_autopilot: 'autopilot',
  manage_codex: 'read',   // "Tap READ MORE." - the reminder's chip is always actionable
});

export const LINE_CHIP_MS = 30000;

/** Poll period for what no event announces (floor, the ticker's beat chip leaving, the arms). */
const POLL_MS = 500;

export class TouchActionChip {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {{hasStepChip:(id?:string)=>boolean}|null} deps.ticker  HintTicker (or a stand-in with hasStepChip)
   * @param {() => (number|null)} [deps.getFloor]   live floor (2 and 3 only); omitted = no floor limit
   * @param {() => (number|undefined)} [deps.getMotherNets]  live mother-net count, read once at start
   * @param {() => boolean} [deps.hasDaughter]  a docked daughter with nets is ready (omitted = assume yes)
   * @param {() => (string|null)} [deps.getHolding]  the tool ('NET'|'PAD'|...) of a daughter in STATION_KEEP on the
   *        target, or null. When given it replaces the STATION_KEEP enter/exit events (read on every evaluate).
   * @param {() => boolean} [deps.getReelable]  a daughter is out and idle (reeling her home frees one); omitted = never
   * @param {() => ({daughterCan:boolean, autopilot:boolean}|null)} [deps.getFarState]  null = no piece selected;
   *        else whether a docked daughter with nets can reach it, and whether the autopilot is already flying.
   * @param {() => (object|null)} [deps.getCollarCatch]  the mother's docked catch (CaptureNet `getDockedCatch`; default: the
   *        captureNetSystem singleton). LET GO stands only while it is BERTHED or COLLARED with the debris the line was made
   *        for, even when no event says otherwise. `null` -> events only (tests).
   * @param {() => boolean} [deps.getChoosePending]  a big piece is aboard and the fate list is closed. While true, CHOOSE
   *        (KeyU) stands as a state chip on floors 2-4 (lowest priority); omitted = the line chip only (tests).
   * @param {() => boolean} [deps.getRackBag]  a daughter holds a bag on her rack that K would let go (no salvage in it). While
   *        true, LET GO (KeyK) stands as a state chip on floors 2-3, below every other chip; omitted = never (tests).
   * @param {() => (string|null)} [deps.getPilotState]  the state ('TRANSIT'|'APPROACH'|'STATION_KEEP'|...) of the daughter
   *        the player is piloting, or null when not piloting. Gates the ch2_manual_capture beat chip; omitted = never shown.
   * @param {() => number} [deps.now]  ms clock (tests)
   * @param {(fn:Function)=>void} [deps.schedule]  runs `fn` one tick later; tests pass a synchronous or queued one
   * @param {boolean} [deps.glass=true]  false -> never posts (desktop)
   * @param {boolean} [deps.poll=true]   false -> no timer (tests drive `evaluate()`)
   */
  constructor({ eventBus, ticker = null, getFloor = null, getMotherNets = null, hasDaughter = null, getHolding = null,
    getFarState = null, getReelable = null, getPilotState = null, getChoosePending = null, getRackBag = null, getCollarCatch = () => captureNetSystem.getDockedCatch(), now = null, schedule = null, glass = true, poll = true } = {}) {
    this._eb = eventBus;
    this._ticker = ticker;
    this._getFloor = getFloor;
    this._hasDaughter = hasDaughter;
    this._getHolding = getHolding;
    this._getFarState = getFarState;
    this._getReelable = getReelable;
    this._getPilotState = getPilotState;
    this._getChoosePending = typeof getChoosePending === 'function' ? getChoosePending : null;
    this._getRackBag = typeof getRackBag === 'function' ? getRackBag : null;
    this._getCollarCatch = typeof getCollarCatch === 'function' ? getCollarCatch : null;
    this._now = now || (() => Date.now());
    this._schedule = schedule || ((fn) => { if (typeof setTimeout === 'function') setTimeout(fn, 0); else fn(); });
    this._glass = glass !== false;
    this._inRange = false;
    this._rangeKnown = false;      // an IN/OUT crossing has been seen for the selected piece (no flash on select)
    this._selected = false;
    this._denied = false;          // N was refused as out_of_net_range: the game routes the player to a daughter
    this._inFlight = false;        // a MOTHER net is flying
    this._daughterOut = false;     // a daughter was just sent for this target
    this._wasHolding = false;      // a daughter was holding station at the last read (a tool line ends with her station)
    this._holding = new Map();     // armId -> tool: daughters holding station on the target (event fallback, no getHolding)
    this._line = null;             // { kind, until, gated, hintId, catchId } - a shown line named this key
    this._beat = null;             // { id, kind, needs } - the running lesson whose key has this chip
    this._collarId = null;         // debris id of the catch at the collar (from NET_BERTHED / the parked credit)
    this._nets = Constants?.CAPTURE_NET?.LARGE?.MAGAZINE_SIZE ?? 4;
    try {
      const n = getMotherNets ? getMotherNets() : undefined;
      if (Number.isFinite(n)) this._nets = n;
    } catch (_e) { /* best-effort */ }
    this._shown = null;            // chip kind we have posted
    this._unsubs = [];
    this._timer = null;
    this._disposed = false;
    this._busy = false;
    this._keyHandler = null;
    if (!this._glass || !this._eb) return;

    const on = (name, h) => {
      if (!name) return;
      const u = this._eb.on(name, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };
    const re = (fn) => (d) => { fn(d); this.evaluate(); };
    on(Events.TARGET_IN_RANGE, re(() => { this._inRange = true; this._rangeKnown = true; this._selected = true; }));
    on(Events.TARGET_OUT_OF_RANGE, re(() => { this._inRange = false; this._rangeKnown = true; this._selected = true; }));
    on(Events.TARGET_CLEARED, re(() => {
      this._inRange = false; this._rangeKnown = false; this._selected = false;
      this._denied = false; this._daughterOut = false;
      // Cleared when the catch berths: a LET GO line outlives that.
      if (!(this._line && this._line.kind === 'letgo')) this._line = null;
    }));
    on(Events.TARGET_SELECTED, re(() => { this._denied = false; this._rangeKnown = false; this._selected = true; }));
    on(Events.NET_INVENTORY_CHANGED, re((d) => {
      if (d && d.source === 'mother' && Number.isFinite(d.motherNets)) this._nets = d.motherNets;
    }));
    on(Events.LASSO_DENIED, re((d) => { if (d && d.reason === 'out_of_net_range') this._denied = true; }));
    // Only the MOTHER's shots count. The small lasso is always the mother's; a large net is hers when its
    // armIndex is negative (CaptureNet: -1 = the mother launcher) and NET_FIRED says source:'mother'.
    const motherNet = (d) => !d || !(d.armIndex >= 0);
    on(Events.LASSO_FIRED, re(() => { this._inFlight = true; }));
    on(Events.NET_FIRED, re((d) => { if (d && d.source === 'mother') this._inFlight = true; }));
    for (const n of ['LASSO_CAPTURED', 'LASSO_MISSED']) {
      on(Events[n], re(() => { this._inFlight = false; }));
    }
    for (const n of ['NET_CATCH_SUCCESS', 'NET_CATCH_MISS']) {
      on(Events[n], re((d) => { if (motherNet(d)) this._inFlight = false; }));
    }
    // Which catch sits at the collar, and when it leaves. A NEW berth while a LET GO line is up is a different catch: the line ends.
    on(Events.NET_BERTHED, re((d) => {
      this._collarId = d && d.debrisId != null ? d.debrisId : null;
      if (this._line && this._line.kind === 'letgo' && !this._sameCatch(this._line.catchId, this._collarId)) this._line = null;
    }));
    on(Events.CATCH_PROCESSED, re((d) => {
      if (!d || d.source !== 'mother') return;
      if (d.parked) this._collarId = d.debrisId != null ? d.debrisId : this._collarId;
      else if (d.digested) this._catchLeft(d.debrisId);
    }));
    on(Events.NET_RELEASED, re((d) => { this._catchLeft(d && d.debrisId); }));
    on(Events.NET_CONSUMED, re(() => {}));       // a rack gave her bag up: look again at once (LET GO leaves)
    on(Events.CARGO_TRANSFER_START, re((d) => { if (d && d.from && d.from.kind === 'collar') this._catchLeft(d.debrisId); }));
    on(Events.CARGO_TRANSFER_COMPLETE, re((d) => { this._catchLeft(d && d.debrisId); }));
    on(Events.ARM_DEPLOYED, re(() => { this._denied = false; this._daughterOut = true; }));
    if (!getHolding) {
      on(Events.STATION_KEEP_ENTERED, re((d) => { if (d && d.armId != null && d.inspect !== true) this._holding.set(d.armId, d.tool || null); }));   // an inspecting daughter is no net holder
      on(Events.STATION_KEEP_EXITED, re((d) => { if (d && d.armId != null) this._holding.delete(d.armId); }));
    }
    // An empty-canvas tap scan (SCAN_QUICK) sends no keydown but ends a "Tap SCAN" line chip like the key.
    on(Events.SCAN_QUICK, () => this._onKey('KeyS'));
    on(Events.ARM_DOCKED, re(() => { this._daughterOut = false; }));
    on(Events.ARM_RETURNED, re(() => { this._daughterOut = false; }));
    // A beat chip leaving frees the slot, but the next beat's chip often arrives in the same tick: look again one tick later.
    on(Events.HINT_SATISFIED, () => this._schedule(() => this.evaluate()));
    // A coach lesson whose key has a chip (BEAT_CHIPS); payload `beatId` (MissionCoach._postBeat). Another beat starting ends it.
    on(Events.MISSION_BEAT_STARTED, re((d) => {
      const id = d && typeof d.beatId === 'string' ? d.beatId : null;
      const row = id ? BEAT_CHIPS[id] : null;
      this._beat = row ? { id, kind: row.kind, needs: row.needs } : null;
    }));
    on(Events.MISSION_BEAT_SATISFIED, re((d) => {
      if (this._beat && d && d.beatId === this._beat.id) this._beat = null;
    }));
    on(Events.GAME_RESET, re(() => {
      this._beat = null;
      this._inRange = false; this._rangeKnown = false; this._selected = false; this._denied = false;
      this._inFlight = false; this._daughterOut = false; this._holding.clear(); this._line = null; this._collarId = null;
      this._nets = Constants?.CAPTURE_NET?.LARGE?.MAGAZINE_SIZE ?? 4;
    }));
    on(Events.HINT_POSTED, (d) => {
      // A beat's step chip posted while LET GO is up would shelve it: take the slot back.
      if (d && d.step === true && d.id !== TOUCH_ACTION_CHIP_ID && (this._shown === 'letgo' || (d.press === 'KeyN' && this._takesNSlot(this._shown)))) {
        this._schedule(() => this._reclaimSlot());
      }
      if (!d || typeof d.id !== 'string' || !d.id.startsWith('remind_')) return;
      const kind = REMINDER_KIND[d.skillId];
      if (kind) this.onLine([kind], true, d.id);
    });
    GestureHints.setChipLineListener((kinds) => this.onLine(kinds));
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      this._keyHandler = (e) => this._onKey(e && e.code);
      window.addEventListener('keydown', this._keyHandler);
    }
    if (poll !== false && typeof setInterval === 'function') {
      this._timer = setInterval(() => this.evaluate(), POLL_MS);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  /**
   * A comms line naming these chip kinds ('net'|'pad'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'read') was stored. The
   * first one gets a chip for LINE_CHIP_MS (it outranks the state chip), unless a beat chip holds the slot.
   * @param {string[]} kinds
   * @param {boolean} [gated=false]  a reminder: the chip comes (and stays) only while its key would act now
   * @param {string} [hintId]  the reminder's ticker hint id; taken down (HINT_SATISFIED) while its chip is held back
   */
  onLine(kinds, gated = false, hintId = null) {
    if (!this._glass || this._disposed || !Array.isArray(kinds) || !kinds.length) return;
    const kind = kinds.find(k => CHIPS[k]);
    if (!kind) return;
    let catchId = null;
    if (kind === 'choose' && !this._choosePending()) return;     // nothing waits for a pick: no button
    if (kind === 'letgo') {
      const st = this._collarState();
      if (st === null) return;                       // nothing is mated at the collar: nothing to let go
      catchId = st && st.id != null ? st.id : this._collarId;
      if (catchId == null) return;                   // a catch with no id cannot be told from a later one: no chip
    }
    this._line = { kind, until: this._now() + LINE_CHIP_MS, gated: gated === true, hintId: gated === true ? hintId : null, catchId };
    this.evaluate();
  }

  /**
   * @private A catch left the collar (released, digested, handed to a daughter or a radiator): ends a LET GO line made for
   * that catch (or with no known id). Other pieces (a cut piece flying off, a later catch) leave it standing.
   */
  _catchLeft(debrisId) {
    // A leave event with no id still ends the line (ending is the safe side: the tap would act on whatever is at the collar).
    const same = (a, b) => a == null || b == null || String(a) === String(b);
    if (same(this._collarId, debrisId)) this._collarId = null;
    if (this._line && this._line.kind === 'letgo' && same(this._line.catchId, debrisId)) this._line = null;
  }

  /** @private A missing id is never "the same catch" (LET GO presses K on whatever is docked). */
  _sameCatch(a, b) { return a != null && b != null && String(a) === String(b); }

  /**
   * @private The catch mated at the collar, from the game's own state. `{ id }` (debris id or null) while a mother
   * net is BERTHED or COLLARED; `null` when none is (gone, or already handed off: TRANSFERRING); `undefined` without a reader.
   */
  _collarState() {
    if (!this._getCollarCatch) return undefined;
    try {
      const n = this._getCollarCatch();
      if (!n || (n.state !== 'BERTHED' && n.state !== 'COLLARED')) return null;
      const d = n.targetDebris;
      return { id: d && d.id != null ? d.id : null };
    } catch (_e) { return undefined; }
  }

  /** @private This chip kind is KeyN's word for the tool a holding daughter has (N works HER tool, not the mother's net). */
  _takesNSlot(kind) {
    return N_KINDS.includes(kind) && this._holdingTool() != null;
  }

  /**
   * @private If a newer step chip took the slot from LET GO (or from her tool's button, against a KeyN beat chip that would
   * name the mother's net), post ours again on top.
   */
  _reclaimSlot() {
    if (this._disposed || !this._shown || this.wanted() !== this._shown) return;
    if (this._shown !== 'letgo' && !this._takesNSlot(this._shown)) return;
    this._shown = null;
    this._eb.emit(Events.HINT_SATISFIED, { id: TOUCH_ACTION_CHIP_ID });
    this.evaluate();
  }

  _onKey(code) {
    if (this._line && code && KIND_KEY[this._line.kind] === code) {
      this._line = null;
      this.evaluate();
    }
  }

  /** @private Floor 2 or 3; floor 4 too for the CHOOSE line chip; no getter = any. */
  _floorOk(kind = null) {
    if (!this._getFloor) return true;
    let f = null;
    try { f = this._getFloor(); } catch (_e) { f = null; }
    return f === 2 || f === 3 || (kind === 'choose' && f === 4);
  }

  // No reader = assume yes: the CHOOSE line only comes with the catch.
  _choosePending() {
    if (!this._getChoosePending) return true;
    try { return !!this._getChoosePending(); } catch (_e) { return false; }
  }

  _keyWouldAct(kind, holding) {
    if (N_KINDS.includes(kind)) {
      const p = this._pilotedN();
      if (p !== null) return !!holding || p;   // flying her: N is HER tool, never the mother's net
      return !!holding || (this._inRange && this._nets > 0 && !this._inFlight);
    }
    if (kind === 'daughter') { try { return this._hasDaughter ? !!this._hasDaughter() : true; } catch (_e) { return true; } }
    if (kind === 'autopilot') return this._selected;
    return true;
  }

  /**
   * @private The reminder's chip is held back by its gate, so its text ("Tap LAUNCH NET ...") would name a button that is
   * not on screen: take the hint down (HINT_SATISFIED), one tick later so it lands after the ticker stored the post.
   */
  _takeDownReminder() {
    const id = this._line && this._line.hintId;
    if (!id) return;
    this._line.hintId = null;
    this._schedule(() => { if (!this._disposed) this._eb.emit(Events.HINT_SATISFIED, { id }); });
  }

  _letGoOver() {
    const st = this._collarState();
    if (st === undefined) return false;
    if (st === null) return true;
    return !this._sameCatch(this._line.catchId, st.id);
  }

  /**
   * @private The chip kind of the running lesson, or null. A 'pilot' lesson waits for a piloted daughter in flight: N on
   * its own would fire the mother's net, which does not satisfy it. A running lesson outranks every other chip but LET GO.
   */
  _beatKind() {
    const b = this._beat;
    if (!b) return null;
    if (b.needs === 'pilot') {
      let st = null;
      try { st = this._getPilotState ? this._getPilotState() : null; } catch (_e) { st = null; }
      if (!MANUAL_NET_STATES.includes(st)) return null;
    }
    return b.kind;
  }

  /**
   * @private While he flies a daughter N is HER tool, not the mother's net. null = not flying one (or no reader);
   * true = N does something for her (a manual net in flight, ArmUnit.manualNetDeploy); false = N does nothing (not in
   * flight, not holding station), so a "launch the net" chip would be a dead button. Holding station: see `holding`.
   */
  _pilotedN() {
    if (!this._getPilotState) return null;
    let st = null;
    try { st = this._getPilotState(); } catch (_e) { st = null; }
    if (st == null) return null;
    return MANUAL_NET_STATES.includes(st) || st === 'STATION_KEEP';
  }

  /** @private A daughter is out and idle. One in flight never counts: REEL would cancel the catch she was sent for. */
  _reelable() {
    if (!this._getReelable) return false;
    try { return !!this._getReelable(); } catch (_e) { return false; }
  }

  /** @private The selected piece is one a daughter has to take (N refused for range, beyond reach, or no mother nets). */
  _needsDaughter() {
    if (this._denied) return true;
    if (this._inRange) return !(this._nets > 0);
    if (!(this._selected && this._rangeKnown && this._getFarState)) return false;
    try { return !!this._getFarState(); } catch (_e) { return false; }   // null = tutorial still teaches
  }

  _holdingTool() {
    if (this._getHolding) {
      try { return this._getHolding() || null; } catch (_e) { return null; }
    }
    return this._holding.size > 0 ? ([...this._holding.values()][0] || 'NET') : null;
  }

  /**
   * @private The CHOOSE button as a STATE chip: it stands whenever a big piece is aboard and the fate list is closed
   * (floors 2-4), whatever happened to the 30 s line. With no reader there is no state chip, only the line.
   */
  _chooseStanding() {
    if (!this._getChoosePending) return false;
    let f = null;
    if (this._getFloor) {
      try { f = this._getFloor(); } catch (_e) { f = null; }
      if (f !== 2 && f !== 3 && f !== 4) return false;
    }
    return this._choosePending();
  }

  /**
   * @returns {'net'|'pad'|'grip'|'magnet'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'letgobag'|'choose'|'read'|'widescan'|'throttle'|null} the chip the current state asks for (ignoring other chips on screen).
   * CHOOSE is the lowest-priority state chip: every other chip, line or beat outranks it, and it fills the gap when none is wanted.
   */
  wanted() {
    if (!this._glass) return null;
    return this._wantedFirst() || (this._rackBagStanding() ? 'letgobag' : null) || (this._chooseStanding() ? 'choose' : null);
  }

  _rackBagStanding() {
    if (!this._getRackBag || !this._floorOk()) return false;
    // K belongs to the mother's nose collar first: while it holds a catch the key lets THAT go, so no bag chip.
    try { if (this._getCollarCatch && this._getCollarCatch()) return false; } catch (_e) { /* no reading: the bag reader decides */ }
    try { return !!this._getRackBag(); } catch (_e) { return false; }
  }

  _wantedFirst() {
    if (!this._glass) return null;
    if (!this._floorOk(this._line ? this._line.kind : null)) { this._line = null; return null; }   // floor left: a line chip does not wait for the way back
    const canSend = () => { try { return this._hasDaughter ? !!this._hasDaughter() : true; } catch (_e) { return true; } };
    const holding = this._holdingTool();
    // A tool line ("Press N to grip it ...") was said for a daughter holding station. When she stops holding (docked,
    // reeled, the piece is gone) its button would name a tool N no longer works: the line ends with her station, not after 30 s.
    if (holding) this._wasHolding = true;
    else if (this._wasHolding) {
      this._wasHolding = false;
      if (this._line && TOOL_KINDS.includes(this._line.kind)) this._line = null;
    }
    if (this._line && this._line.kind === 'letgo' && (this._now() >= this._line.until || this._letGoOver())) this._line = null;
    // The CHOOSE line lives only while a big catch still waits for its pick.
    if (this._line && this._line.kind === 'choose' && !this._choosePending()) this._line = null;
    if (this._line && this._line.kind === 'choose' && this._now() >= this._line.until) this._line = null;
    // floor 4 holds the CHOOSE line chip and nothing else (the other chips live on floors 2-3)
    if (this._getFloor) {
      let f4 = null;
      try { f4 = this._getFloor(); } catch (_e) { f4 = null; }
      if (f4 === 4) return this._line && this._line.kind === 'choose' ? 'choose' : null;
    }
    if (!(this._line && this._line.kind === 'letgo')) {
      const beat = this._beatKind();
      if (beat) return beat;
    }
    if (this._line) {
      if (this._now() >= this._line.until) this._line = null;
      else if (this._line.kind === 'letgo' && this._letGoOver()) this._line = null;
      // "Press D to send a daughter" while both daughters hold catches: the launch would be refused, so no chip.
      else if (this._line.kind === 'daughter' && !canSend()) { /* no chip */ }
      else if (this._line.gated && !this._keyWouldAct(this._line.kind, holding)) this._takeDownReminder();
      // A daughter holding the piece decides the N word (her tool); with none, the line's own kind (mother net).
      else return (holding && N_KINDS.includes(this._line.kind)) ? toolKind(holding) : this._line.kind;
    }
    if (holding) return toolKind(holding);
    if (this._inFlight) return null;
    // ORDER: before the "daughter out" rule below, which keeps quiet for a daughter on her way (an adrift one is not).
    if (!canSend() && this._needsDaughter() && this._reelable()) return 'reel';
    if (this._daughterOut) return null;
    if (this._denied) return canSend() ? 'daughter' : null;
    if (this._inRange) {
      // Flying a daughter that cannot net by hand now (not in flight, not holding): N does nothing, no chip. In flight the
      // tap deploys HER manual net: the chip stays, with the same 'net' words.
      if (this._nets > 0) return this._pilotedN() === false ? null : 'net';
      return canSend() ? 'daughter' : null;
    }
    // Selected and beyond net reach (crossing seen, so a fresh pick does not flash).
    if (this._selected && this._rangeKnown && this._getFarState) {
      let far = null;
      try { far = this._getFarState(); } catch (_e) { far = null; }
      if (far) {
        if (far.daughterCan) return 'daughter';
        return far.autopilot ? null : 'autopilot';
      }
    }
    return null;
  }

  /**
   * The CHOOSE chip is on the ticker's screen right now (TouchVerbButton's CHOOSE button stays away on floor 2 then).
   * `_shown` only records that it was sent: a later step hint shelves it (HintTicker._shelveVisibleSteps), so the ticker
   * is asked too. A ticker without `isOnScreen` (a test stand-in) is taken at its word.
   */
  isChooseUp() {
    if (this._shown !== 'choose') return false;
    if (this._ticker && typeof this._ticker.isOnScreen === 'function') return !!this._ticker.isOnScreen(TOUCH_ACTION_CHIP_ID);
    return true;
  }

  /** Bring the chip in line with the state: post, swap or take down. Safe to call at any time. */
  evaluate() {
    if (this._disposed || this._busy) return;   // our own HINT_SATISFIED comes back through the listener
    this._busy = true;
    try { this._evaluate(); } finally { this._busy = false; }
  }

  /** @private */
  _evaluate() {
    const want = this.wanted();
    if (want === this._shown) return;
    if (this._shown) {
      this._shown = null;
      this._eb.emit(Events.HINT_SATISFIED, { id: TOUCH_ACTION_CHIP_ID });
    }
    if (!want) return;
    // One chip, one action: a teaching-beat chip (or any other step chip) on screen keeps the slot, except:
    // LET GO (a catch that cannot move on blocks the beat) and, with a daughter holding the piece, a KeyN chip (its
    // "LAUNCH NET" names the MOTHER's net, but N works HER tool). The ticker shelves the beat's chip and puts it back.
    if (want !== 'letgo' && this._ticker && typeof this._ticker.hasStepChip === 'function'
      && this._ticker.hasStepChip(TOUCH_ACTION_CHIP_ID, this._takesNSlot(want) ? 'KeyN' : undefined)) return;
    const c = CHIPS[want];
    this._eb.emit(Events.HINT_POSTED, {
      id: TOUCH_ACTION_CHIP_ID,
      text: c.text,
      glyph: c.glyph,
      keys: [...c.keys],
      duration: 0,           // stays until the action is done or no longer possible
      priority: 'normal',
      step: true,
      press: c.press,
      button: c.button,
    });
    this._shown = want;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._shown && this._eb) this._eb.emit(Events.HINT_SATISFIED, { id: TOUCH_ACTION_CHIP_ID });
    this._shown = null;
    for (const u of this._unsubs) { try { u(); } catch (_e) { /* ignore */ } }
    this._unsubs.length = 0;
    if (this._glass) GestureHints.setChipLineListener(null);
    if (this._keyHandler && typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('keydown', this._keyHandler);
    this._keyHandler = null;
    if (this._timer != null && typeof clearInterval === 'function') clearInterval(this._timer);
    this._timer = null;
  }
}

export default TouchActionChip;
