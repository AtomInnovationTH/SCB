/**
 * TouchActionChip.js — u11 D1/D2: on glass, every game line that asks for an action with a key has a button.
 *
 * The comms lines say "Launch the net" / "Tap SEND DAUGHTER" (GestureHints.chipPhrase). A touch player has no N or D
 * key, so this module keeps ONE tappable step chip on screen while the action is on offer:
 *   · a piece is within net reach, a mother net is left, none is in flight  → LAUNCH NET  (KeyN)
 *   · the mother has no nets left, or N was refused as "out of net range"   → SEND DAUGHTER (KeyD)
 *   · a daughter holds station on the piece ("Daughter in position. Press N…") → LAUNCH NET / STICK PAD / CLOSE GRIPPER / USE MAGNET (KeyN: her tool, u18c)
 * It reuses the ticker's step-chip mechanism (HINT_POSTED step:true + press + button): a tap takes exactly the
 * keyboard's path, refusals included. It never covers a teaching-beat chip (HintTicker.hasStepChip) and takes its
 * own chip down the moment its condition ends. Driven by events and live state, never by matching comms text
 * (R3 below is the one exception: it is told WHICH KEY a shown line named, not what the line said). Glass only (the
 * caller constructs it inside the TouchControls.detect() block); floors 2-3 only.
 *
 * u11 fix round R1-R4 (2026-10-21):
 *   R1 "a daughter is holding" is read from the arms' state (STATION_KEEP) on the 500 ms poll, not from enter/exit
 *      events: a daughter that returns to station after a missed net never emits STATION_KEEP_ENTERED.
 *   R2 out of net reach with a piece selected (tutorial over, no beat chip): SEND DAUGHTER when a docked daughter with
 *      nets can reach it (main.js `getFarState().daughterCan`), else AUTOPILOT. Gone when the piece is in reach.
 *   R3 every comms line that says "Tap X" (CommsSystem -> GestureHints.noteChipLine -> this class) brings X's chip up
 *      for 30 s (gone on that key's press, target cleared, floor left). A line chip outranks a state chip.
 *   R8/R9 (2026-10-21) REEL (KeyR): a "Press R" line gets the same line chip as the other keys; and the state rule: a
 *      piece that needs a daughter (beyond net reach, or no mother nets), no daughter can launch, and one is out and
 *      idle (adrift / on station / trawling: `getReelable`) -> REEL, ahead of AUTOPILOT. A daughter mid-flight is
 *      never offered (REEL would cancel the catch she was sent for). Gone when she docks / can launch.
 *   R13 (2026-10-21) the spaced-repetition reminders (OnboardingDirector `remind_<skillId>` hints: "Press N to launch the
 *      net." ...) bring their chip too, but ONLY when the key would act now: net = a daughter holds the piece, or a
 *      piece is in net reach with a mother net left and none in flight; daughter = the daughter D would launch can go
 *      (R12); autopilot = a piece is selected; scan as for any line. Other lines keep R3's rule (they are said by the
 *      game at the moment the action is on offer).
 *   R14 (2026-10-21) a reminder whose chip its gate holds back is taken down (HINT_SATISFIED for its id), so no text
 *      names a button that is not on screen; when the gate is open the reminder stays, with its chip. Glass only.
 *   u14b (2026-10-21) B1 K: a line that names K ("Press K to let it go.") brings the LET GO chip (KeyK), R3 rules except
 *      that it does NOT end on "target cleared" (the target is cleared when the catch berths, which can come before
 *      the line): it ends when THAT catch leaves the collar (released, taken by the furnace, handed to a daughter or a
 *      radiator), on KeyK, on floor left, or after 30 s. So a LET GO tap never lets go of a different, later catch.
 *      B2 I: a line that names I brings READ MORE (KeyI), plain R3 rules (the SPECS tab opens a different view).
 *   fix round 1 (2026-10-22) R3: a missing debris id is never "the same catch" (no LET GO chip for a catch with no id; a new berth
 *      ends the line). R4: LET GO takes the step slot from a teaching step chip (the ticker shelves the beat's chip and brings it
 *      back when LET GO leaves; a beat chip posted meanwhile is answered by re-posting LET GO on top).
 *   u15a A-T2 / A-T4 (2026-10-22) BEAT CHIPS: a mission-coach lesson whose trigger event only a key press makes
 *      (BEAT_CHIPS: ch2_manual_capture N, ch3_wide_scan Shift+S, ch3_codex I, ch5_burn Shift+=) brings its button from
 *      MISSION_BEAT_STARTED (payload `beatId`) until MISSION_BEAT_SATISFIED for it, GAME_RESET, or another beat starting.
 *      Unlike a line chip it is never timed out, never ends on a floor change (it is only held back while the floor is
 *      not 2-3, and comes back), and no later line or state chip replaces it. WIDE SCAN presses 'Shift+KeyS' (KeyDispatch
 *      parses the Shift form), so InputManager emits SCAN_WIDE exactly as the keyboard does.
 *   R4 (a) HINT_SATISFIED is re-read one tick later (a beat chip leaving and the next arriving in the same tick must
 *      not flash ours); (b) only a MOTHER shot counts as "in flight".
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
  // u18c D5: the other two daughter tools. N works whichever tool she holds (ArmUnit.dispatchSelectedTool), so each tool has its
  // own true word; `net` stays the mother's net AND the daughter's net.
  grip: Object.freeze({ text: 'Close the gripper', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'CLOSE GRIPPER' }),
  magnet: Object.freeze({ text: 'Use the magnet', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'USE MAGNET' }),
  daughter: Object.freeze({ text: 'Send a daughter', glyph: 'D', keys: Object.freeze(['KeyD']), press: 'KeyD', button: 'SEND DAUGHTER' }),
  autopilot: Object.freeze({ text: 'Autopilot in', glyph: 'A', keys: Object.freeze(['KeyA']), press: 'KeyA', button: 'AUTOPILOT' }),
  scan: Object.freeze({ text: 'Scan', glyph: 'S', keys: Object.freeze(['KeyS']), press: 'KeyS', button: 'SCAN' }),
  // R8: the radial's REEL (TouchControls RADIAL_VERBS) - KeyR recalls the selected daughter if eligible, else the closest.
  reel: Object.freeze({ text: 'Reel her home', glyph: 'R', keys: Object.freeze(['KeyR']), press: 'KeyR', button: 'REEL' }),
  // u14b B1: K lets the catch at the collar go (CaptureNet.releaseDockedCatch, refusals included).
  letgo: Object.freeze({ text: 'Let the catch go', glyph: 'K', keys: Object.freeze(['KeyK']), press: 'KeyK', button: 'LET GO' }),
  // u14b B2: I opens the full-screen library; the SPECS tab opens a different (side) view, so it needs its own button.
  read: Object.freeze({ text: 'Read more', glyph: 'I', keys: Object.freeze(['KeyI']), press: 'KeyI', button: 'READ MORE' }),
  // u15a A-T2: mission 3's wide-scan lesson. Shift+S is the only way to a wide scan; a touch player had no key for it
  // (D2 label WIDE SCAN). The Shift form is parsed by KeyDispatch.pressKey. Beat chip only; outside the lesson the WIDE SCAN button (u16b, TouchVerbButton) carries it, after a first wide scan.
  widescan: Object.freeze({ text: 'Wide scan', glyph: 'S', keys: Object.freeze(['Shift+KeyS']), press: 'Shift+KeyS', button: 'WIDE SCAN' }),
  // u15a A-T4: mission 5's burn lesson waits for THROTTLE_CHANGE; the throttle is Shift+= (+10 %), no touch control exists.
  throttle: Object.freeze({ text: 'Throttle up', glyph: '+', keys: Object.freeze(['Shift+Equal']), press: 'Shift+Equal', button: 'THROTTLE UP' }),
});

/**
 * u15a A-T4: the lessons (BEATS_BY_MISSION ids) whose trigger event only a key press makes on glass, by chip kind.
 * `needs` names a state the key needs to do the lesson's thing (the chip is held back, not removed, while it is false):
 * 'pilot' = a piloted daughter in flight (TRANSIT / APPROACH) - N then deploys the MANUAL net (ArmUnit.manualNetDeploy,
 * the only source of ARM_CAPTURED manual:true); with no pilot N would fire the mother's net and teach nothing.
 */
export const BEAT_CHIPS = Object.freeze({
  ch2_manual_capture: Object.freeze({ kind: 'net', needs: 'pilot' }),
  ch3_wide_scan: Object.freeze({ kind: 'widescan', needs: null }),
  ch3_codex: Object.freeze({ kind: 'read', needs: null }),
  ch5_burn: Object.freeze({ kind: 'throttle', needs: null }),
});

/** The key each chip kind presses (a physical or tapped press of it ends a line chip). */
const KIND_KEY = Object.freeze({ net: 'KeyN', pad: 'KeyN', grip: 'KeyN', magnet: 'KeyN', daughter: 'KeyD', autopilot: 'KeyA', scan: 'KeyS', reel: 'KeyR', letgo: 'KeyK', read: 'KeyI', widescan: 'Shift+KeyS', throttle: 'Shift+Equal' });

/** u18c D5: the chip kinds that are KeyN (a tool word); a daughter holding the piece decides which one is true now. */
const N_KINDS = Object.freeze(['net', 'pad', 'grip', 'magnet']);
/** u18c D5: the chip kinds that name HER tool (only true while she holds station). */
const TOOL_KINDS = Object.freeze(['pad', 'grip', 'magnet']);

/** u18c D5: the chip kind for the tool a station-keeping daughter holds ('NET' | 'PAD' | 'GRIPPER' | 'MAGNET'; anything else = the net). */
function toolKind(tool) {
  return tool === 'PAD' ? 'pad' : tool === 'GRIPPER' ? 'grip' : tool === 'MAGNET' ? 'magnet' : 'net';
}

/** The daughter states in which N deploys a MANUAL net (ArmUnit.manualNetDeploy). */
const MANUAL_NET_STATES = Object.freeze(['TRANSIT', 'APPROACH']);

/**
 * R13: the skill reminders that name an action key (SKILLS.CATALOG `say`, posted by OnboardingDirector._onSkillReminded
 * as HINT_POSTED id 'remind_<skillId>'), by the chip kind their key has.
 */
export const REMINDER_KIND = Object.freeze({
  scan_quick: 'scan', collect_lasso: 'net', arm_pilot_capture: 'net', collect_deploy: 'daughter', nav_autopilot: 'autopilot',
  manage_codex: 'read',   // u14b B2: "Tap READ MORE." - the reminder's chip is always actionable
});

/** R3: how long a line chip stays when nothing else ends it. */
export const LINE_CHIP_MS = 30000;

/** How often the state is re-read for what no event announces (floor, the ticker's beat chip leaving, the arms). */
const POLL_MS = 500;

export class TouchActionChip {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {{hasStepChip:(id?:string)=>boolean}|null} deps.ticker  HintTicker (or a stand-in with hasStepChip)
   * @param {() => (number|null)} [deps.getFloor]   live floor (2 and 3 only); omitted = no floor limit
   * @param {() => (number|undefined)} [deps.getMotherNets]  live mother-net count, read once at start
   * @param {() => boolean} [deps.hasDaughter]  a docked daughter with nets is ready (omitted = assume yes)
   * @param {() => (string|null)} [deps.getHolding]  R1: the tool ('NET'|'PAD'|...) of a daughter in STATION_KEEP on the
   *        target, or null. When given it replaces the STATION_KEEP enter/exit events (read on every evaluate).
   * @param {() => boolean} [deps.getReelable]  R9: a daughter is out and idle (reeling her home frees one); omitted = never
   * @param {() => ({daughterCan:boolean, autopilot:boolean}|null)} [deps.getFarState]  R2: null = no piece selected;
   *        else whether a docked daughter with nets can reach it, and whether the autopilot is already flying.
   * @param {() => (object|null)} [deps.getCollarCatch]  u14b B1: the mother's docked catch (CaptureNet `getDockedCatch`; default: the
   *        captureNetSystem singleton). LET GO stands only while it is BERTHED or COLLARED with the debris the line was made
   *        for: a hand-off to a radiator or a daughter (TRANSFERRING), a leash that is cut, a teardown or a later catch end it
   *        even when no event says so. `null` -> events only (tests).
   * @param {() => (string|null)} [deps.getPilotState]  u15a A-T4: the state ('TRANSIT'|'APPROACH'|'STATION_KEEP'|...) of the daughter
   *        the player is piloting, or null when not piloting. Gates the ch2_manual_capture beat chip; omitted = never shown.
   * @param {() => number} [deps.now]  ms clock (tests)
   * @param {(fn:Function)=>void} [deps.schedule]  runs `fn` one tick later (R4a); tests pass a synchronous or queued one
   * @param {boolean} [deps.glass=true]  false -> never posts (desktop)
   * @param {boolean} [deps.poll=true]   false -> no timer (tests drive `evaluate()`)
   */
  constructor({ eventBus, ticker = null, getFloor = null, getMotherNets = null, hasDaughter = null, getHolding = null,
    getFarState = null, getReelable = null, getPilotState = null, getCollarCatch = () => captureNetSystem.getDockedCatch(), now = null, schedule = null, glass = true, poll = true } = {}) {
    this._eb = eventBus;
    this._ticker = ticker;
    this._getFloor = getFloor;
    this._hasDaughter = hasDaughter;
    this._getHolding = getHolding;
    this._getFarState = getFarState;
    this._getReelable = getReelable;
    this._getPilotState = getPilotState;
    this._getCollarCatch = typeof getCollarCatch === 'function' ? getCollarCatch : null;
    this._now = now || (() => Date.now());
    this._schedule = schedule || ((fn) => { if (typeof setTimeout === 'function') setTimeout(fn, 0); else fn(); });
    this._glass = glass !== false;
    this._inRange = false;
    this._rangeKnown = false;      // an IN/OUT crossing has been seen for the selected piece (R2: no flash on select)
    this._selected = false;
    this._denied = false;          // N was refused as out_of_net_range: the game routes the player to a daughter
    this._inFlight = false;        // a MOTHER net is flying (R4b)
    this._daughterOut = false;     // a daughter was just sent for this target
    this._wasHolding = false;      // u18c D5: a daughter was holding station at the last read (a tool line ends with her station)
    this._holding = new Map();     // armId -> tool: daughters holding station on the target (event fallback, no getHolding)
    this._line = null;             // R3: { kind, until } - a shown line named this key
    this._beat = null;             // u15a A-T4: { id, kind, needs } - the running lesson whose key has this chip
    this._collarId = null;         // u14b B1: debris id of the catch at the collar (from NET_BERTHED / the parked credit)
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
      // u14b B1: the target is cleared when the catch berths - a LET GO line outlives that (it ends when the catch leaves).
      if (!(this._line && this._line.kind === 'letgo')) this._line = null;
    }));
    on(Events.TARGET_SELECTED, re(() => { this._denied = false; this._rangeKnown = false; this._selected = true; }));
    on(Events.NET_INVENTORY_CHANGED, re((d) => {
      if (d && d.source === 'mother' && Number.isFinite(d.motherNets)) this._nets = d.motherNets;
    }));
    on(Events.LASSO_DENIED, re((d) => { if (d && d.reason === 'out_of_net_range') this._denied = true; }));
    // R4b: only the MOTHER's shots count. The small lasso is always the mother's; a large net is hers when its
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
    // u14b B1: which catch sits at the collar, and when it leaves (any of these ends a LET GO line made for it).
    // A NEW berth while a LET GO line is up is a different catch (a missing id is no proof of the same one): the line ends.
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
    on(Events.CARGO_TRANSFER_START, re((d) => { if (d && d.from && d.from.kind === 'collar') this._catchLeft(d.debrisId); }));
    on(Events.CARGO_TRANSFER_COMPLETE, re((d) => { this._catchLeft(d && d.debrisId); }));
    on(Events.ARM_DEPLOYED, re(() => { this._denied = false; this._daughterOut = true; }));
    if (!getHolding) {
      on(Events.STATION_KEEP_ENTERED, re((d) => { if (d && d.armId != null) this._holding.set(d.armId, d.tool || null); }));
      on(Events.STATION_KEEP_EXITED, re((d) => { if (d && d.armId != null) this._holding.delete(d.armId); }));
    }
    // R7c: an empty-canvas tap scan (SCAN_QUICK) sends no keydown; it ends a "Tap SCAN" line chip like the key does.
    on(Events.SCAN_QUICK, () => this._onKey('KeyS'));
    on(Events.ARM_DOCKED, re(() => { this._daughterOut = false; }));
    on(Events.ARM_RETURNED, re(() => { this._daughterOut = false; }));
    // R4a: a beat chip leaving frees the slot - but the next beat's chip often arrives in the same tick (run-ipad.json
    // t=23314: ours was up and down within 1 ms). Look again one tick later.
    on(Events.HINT_SATISFIED, () => this._schedule(() => this.evaluate()));
    // u15a A-T4: a coach lesson whose key has a chip (BEAT_CHIPS). The payload carries `beatId` (MissionCoach._postBeat).
    // Any other beat starting means the chapter moved on; the satisfied event, a reset or a new game ends it too.
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
    // R13: a skill reminder that names an action key (gated by state: see wanted()).
    on(Events.HINT_POSTED, (d) => {
      // u14b R4: a beat's step chip posted while LET GO is up would shelve it (one step at a time): take the slot back.
      if (d && d.step === true && d.id !== TOUCH_ACTION_CHIP_ID && (this._shown === 'letgo' || (d.press === 'KeyN' && this._takesNSlot(this._shown)))) {
        this._schedule(() => this._reclaimSlot());
      }
      if (!d || typeof d.id !== 'string' || !d.id.startsWith('remind_')) return;
      const kind = REMINDER_KIND[d.skillId];
      if (kind) this.onLine([kind], true, d.id);
    });
    // R3: the comms store tells us which key(s) a line it just stored named.
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
   * R3: a comms line naming these chip kinds ('net'|'pad'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'read') was stored. The first one
   * gets a chip for LINE_CHIP_MS (it outranks the state chip), unless a beat chip holds the slot.
   * @param {string[]} kinds
   * @param {boolean} [gated=false]  R13: a reminder - the chip comes (and stays) only while its key would act now
   * @param {string} [hintId]  R14: the reminder's ticker hint id; taken down (HINT_SATISFIED) while its chip is held back
   */
  onLine(kinds, gated = false, hintId = null) {
    if (!this._glass || this._disposed || !Array.isArray(kinds) || !kinds.length) return;
    const kind = kinds.find(k => CHIPS[k]);
    if (!kind) return;
    let catchId = null;
    if (kind === 'letgo') {
      const st = this._collarState();
      if (st === null) return;                       // nothing is mated at the collar: nothing to let go
      catchId = st && st.id != null ? st.id : this._collarId;
      if (catchId == null) return;                   // u14b R3: a catch with no id cannot be told from a later one: no chip
    }
    this._line = { kind, until: this._now() + LINE_CHIP_MS, gated: gated === true, hintId: gated === true ? hintId : null, catchId };
    this.evaluate();
  }

  /**
   * @private u14b B1: a catch left the collar (released, digested, handed to a daughter or a radiator). It ends a LET GO
   * line made for that catch; a line made while the catch's id was unknown ends on any such departure. Other pieces
   * (a cut piece flying off, a later catch) leave a line for a different catch standing.
   */
  _catchLeft(debrisId) {
    // A leave event with no id still ends the line (ending is the safe side: the tap would act on whatever is at the collar).
    const same = (a, b) => a == null || b == null || String(a) === String(b);
    if (same(this._collarId, debrisId)) this._collarId = null;
    if (this._line && this._line.kind === 'letgo' && same(this._line.catchId, debrisId)) this._line = null;
  }

  /** @private u14b R3: both ids known and equal. A missing id is never "the same catch" (LET GO presses K on whatever is docked). */
  _sameCatch(a, b) { return a != null && b != null && String(a) === String(b); }

  /**
   * @private u14b B1: the catch mated at the collar, from the game's own state. `{ id }` (debris id or null) while a mother
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

  /** @private u18c D5: this chip kind is KeyN's word for the tool a holding daughter has (N works HER tool, not the mother's net). */
  _takesNSlot(kind) {
    return N_KINDS.includes(kind) && this._holdingTool() != null;
  }

  /**
   * @private u14b R4: LET GO is on screen only if it is the visible step: if a newer step chip took the slot, post ours again on top.
   * u18c D5: the same for her tool's button against a KeyN beat chip posted while she holds (it would name the mother's net).
   */
  _reclaimSlot() {
    if (this._disposed || !this._shown || this.wanted() !== this._shown) return;
    if (this._shown !== 'letgo' && !this._takesNSlot(this._shown)) return;
    this._shown = null;
    this._eb.emit(Events.HINT_SATISFIED, { id: TOUCH_ACTION_CHIP_ID });
    this.evaluate();
  }

  /** @private a key went down: it ends a line chip for that key */
  _onKey(code) {
    if (this._line && code && KIND_KEY[this._line.kind] === code) {
      this._line = null;
      this.evaluate();
    }
  }

  /** @private the floor is one where the chip lives (2 or 3; no getter = any) */
  _floorOk() {
    if (!this._getFloor) return true;
    let f = null;
    try { f = this._getFloor(); } catch (_e) { f = null; }
    return f === 2 || f === 3;
  }

  /**
   * @private R13: would this key do something now? net: a daughter holds the piece, or a piece is in net reach with a
   * mother net left and none in flight; daughter: R12's daughter can go; autopilot: a piece is selected; others: yes.
   */
  _keyWouldAct(kind, holding) {
    if (N_KINDS.includes(kind)) return !!holding || (this._inRange && this._nets > 0 && !this._inFlight);
    if (kind === 'daughter') { try { return this._hasDaughter ? !!this._hasDaughter() : true; } catch (_e) { return true; } }
    if (kind === 'autopilot') return this._selected;
    return true;
  }

  /**
   * @private R14: the reminder's chip is held back by its gate, so its text ("Tap LAUNCH NET ...") would name a button
   * that is not on screen: take the hint down (HINT_SATISFIED, as HintTicker removes any hint). One tick later, so it
   * lands after the ticker has stored the post this very event announced. Once per reminder.
   */
  _takeDownReminder() {
    const id = this._line && this._line.hintId;
    if (!id) return;
    this._line.hintId = null;
    this._schedule(() => { if (!this._disposed) this._eb.emit(Events.HINT_SATISFIED, { id }); });
  }

  /** @private u14b B1: the catch a LET GO line was made for is no longer mated at the collar */
  _letGoOver() {
    const st = this._collarState();
    if (st === undefined) return false;
    if (st === null) return true;
    return !this._sameCatch(this._line.catchId, st.id);
  }

  /**
   * @private u15a A-T4: the chip kind of the running lesson, or null. A lesson that needs a piloted daughter in flight
   * ('pilot') waits until she is: N on its own would fire the mother's net, which does not satisfy it.
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

  /** @private R9: a daughter is out and idle */
  _reelable() {
    if (!this._getReelable) return false;
    try { return !!this._getReelable(); } catch (_e) { return false; }
  }

  /** @private R9: the selected piece is one a daughter has to take (N was refused for range, beyond reach, or no mother nets) */
  _needsDaughter() {
    if (this._denied) return true;
    if (this._inRange) return !(this._nets > 0);
    if (!(this._selected && this._rangeKnown && this._getFarState)) return false;
    try { return !!this._getFarState(); } catch (_e) { return false; }   // null = tutorial still teaches
  }

  /** @private the tool ('NET'|'PAD'|'GRIPPER'|'MAGNET') of the daughter holding station on the target, or null (none holds). */
  _holdingTool() {
    if (this._getHolding) {
      try { return this._getHolding() || null; } catch (_e) { return null; }
    }
    return this._holding.size > 0 ? ([...this._holding.values()][0] || 'NET') : null;
  }

  /** @returns {'net'|'pad'|'grip'|'magnet'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'read'|'widescan'|'throttle'|null} the chip the current state asks for (ignoring other chips on screen) */
  wanted() {
    if (!this._glass) return null;
    if (!this._floorOk()) { this._line = null; return null; }   // floor left: a line chip does not wait for the way back
    const canSend = () => { try { return this._hasDaughter ? !!this._hasDaughter() : true; } catch (_e) { return true; } };
    const holding = this._holdingTool();
    // u18c D5: a tool line ("Press N to grip it ...") was said for a daughter holding station. When she stops holding (docked,
    // reeled, the piece is gone) its button would name a tool N no longer works: the line ends with her station, not after 30 s.
    if (holding) this._wasHolding = true;
    else if (this._wasHolding) {
      this._wasHolding = false;
      if (this._line && TOOL_KINDS.includes(this._line.kind)) this._line = null;
    }
    // u15a A-T4: a running lesson's button outranks every line and state chip, except LET GO (a catch that cannot move on
    // blocks the lesson too). It is never timed out; it only waits while its key would teach nothing (_beatKind).
    if (this._line && this._line.kind === 'letgo' && (this._now() >= this._line.until || this._letGoOver())) this._line = null;
    if (!(this._line && this._line.kind === 'letgo')) {
      const beat = this._beatKind();
      if (beat) return beat;
    }
    if (this._line) {
      if (this._now() >= this._line.until) this._line = null;
      // u14b B1: a LET GO line lives only while ITS catch is still mated at the collar (state, not only events).
      else if (this._line.kind === 'letgo' && this._letGoOver()) this._line = null;
      // R6 run: "Press D to send a daughter" while both daughters hold catches - the launch would be refused, so no chip.
      else if (this._line.kind === 'daughter' && !canSend()) { /* no chip */ }
      // R13: a reminder offers only what its key would do now.
      else if (this._line.gated && !this._keyWouldAct(this._line.kind, holding)) this._takeDownReminder();
      // u18c D5: a daughter holding the piece decides the N word (her tool); with none, the line's own kind (mother net).
      else return (holding && N_KINDS.includes(this._line.kind)) ? toolKind(holding) : this._line.kind;
    }
    if (holding) return toolKind(holding);
    if (this._inFlight) return null;
    // R9: the piece needs a daughter, none can launch, and one is out and idle: bringing her home is what frees one.
    // Before the "daughter out" rule below, which keeps quiet for a daughter that is on her way (adrift is not).
    if (!canSend() && this._needsDaughter() && this._reelable()) return 'reel';
    if (this._daughterOut) return null;
    if (this._denied) return canSend() ? 'daughter' : null;
    if (this._inRange) {
      if (this._nets > 0) return 'net';
      return canSend() ? 'daughter' : null;
    }
    // R2: a piece is selected and beyond net reach (the crossing has been seen, so a fresh pick does not flash).
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
    // One chip, one action: a teaching-beat chip (or any other step chip) on screen keeps the slot ...
    // ... except LET GO (u14b R4): a catch that cannot move on blocks the beat the chip belongs to, so LET GO takes the slot.
    // The ticker shelves the beat's chip (one step at a time) and puts it back when ours leaves.
    // ... and u18c D5 (live fix): a KeyN beat chip ("LAUNCH NET" of tease_lock / second_catch ...) names the MOTHER's net, but with a
    // daughter holding the piece N works HER tool, so that label is false (CLOSE GRIPPER was never shown while the lesson's chip held
    // the slot). Ours takes the slot from a KeyN chip then, the same way; chips of any other key still keep it.
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
