/**
 * FloorMask.js — the Zoom Ladder's map-rule engine for HUD panes
 * (docs/ladder/08-workbench.md D8 + §4 "The map rule for panes").
 *
 * As on a map, what is labeled depends on how far you have zoomed — house
 * numbers up close, city names far out, never both. Each floor shows only the
 * panes that make sense at its scale; zooming out makes the screen CALMER,
 * not busier. This module is the first consumer of the costume idea the
 * contract has carried unconsumed (FloorContract costume.leave/arrive): a
 * per-floor DENSITY MASK over the shipped HUD panes, in three tiers —
 *   'shown'  — the pane participates as shipped;
 *   'faint'  — visible at ~30 % opacity, hover-to-brighten (D6 safety
 *              readouts; dims, never gone);
 *   'gone'   — not part of this floor's room (the map rule).
 *
 * THE VISIBILITY LAYER (T8 "don't fight the inline writes"): tier visibility
 * is applied through the EXISTING pane-density rung adapters
 * (HUD._initPaneDensity → hud.paneDensity.rungs — {id, isVisible, setVisible}
 * live-state adapters). DOM rungs hide via the `data-density-hidden`
 * attribute whose CSS `!important` beats every inline `display` write from
 * view-switch / update code, and the pane's own keys (7/8/9/0, the density
 * `+`) already clear that attribute — so there is exactly ONE visibility bit
 * per pane and every party composes on it. The §4 panes with no rung of
 * their own (the debris-targeting reticle canvas; since 2026-09-02 evening the
 * hint-ticker strip) get a mask-owned attribute (`data-floor-gone`) with the
 * same `!important` discipline.
 *
 * D5 (per-floor player memory — "rooms you can rearrange"): on every floor
 * change the mask first CAPTURES the departing floor's pane INTENT (the ONE
 * density bit on each pane's elements — `_isVisible`; never on-screen
 * presence, which the rung adapters fold in for PaneDensity's own reasons),
 * then applies the arrival floor's layout = player memory where it exists,
 * the §4 default room otherwise. A pane re-shown with its own key (which
 * clears the attribute) is therefore remembered for THAT floor and reapplied
 * on return; global toggles apply within the mask. Persisted since Wave 5
 * Session G (2026-09-04): the state shape (exportMemory/importMemory: plain
 * JSON booleans keyed floor → pane) rides the player store `sc_ladder_view_v1`
 * through LadderController + LadderViewStore.
 *
 * D7 (the always set): alerts (warnings strip, conjunction panel, comms),
 * the rail, and the score strip are NEVER masked on any floor, regardless of
 * tier tables or player memory — the engine never references their rungs or
 * elements at all (ALWAYS_ON below is the pinned list). The VitalsLine left
 * this set in Session O (plan D8, owner 2026-09-07): cryptic, every number
 * duplicated elsewhere — the module + its test stay dormant in the tree,
 * unwired.
 *
 * PURE SCENERY (Session N.=5 D7, owner​ 2026-09-07):when the the `-` walk cleared every rung and
 * bowed the rails out,the hub also sets `body[data-pure-scenery]` (index.html
 * CSS hides the SPECS/REFIT tabs and `#build-stamp`; the vitals line and the
 * glass STORE chip left the rule — and the cockpit — in Session O, D8/D10).
 * Transient view state, never a room edit; `+`, any ride, or
 * a fresh engage clears it. The mask itself is untouched by it.

 *
 * Transition at ride start: LadderController calls setFloor(floor) from
 * _applyFloorContent (which runs on engage AND at every ride START — the T1
 * content-swap idiom), so the destination floor's panes fade in during the
 * ~550 ms flight (TRANSITION_FADE_MS). Reduced motion swaps the flight fade
 * for a short crossfade (REDUCED_CROSSFADE_MS — 00-spec §6 "crossfades
 * replace rides"). G1: DOM writes happen only on floor changes, never per
 * frame.
 *
 * API mirrors LadderAudioBeds exactly: setFloor(floorId|null) — null =
 * disengage → restore the shipped fully-visible cockpit; setEnabled(bool)
 * master gate (disabled remembers the floor, restores the cockpit);
 * dispose(). All deps injected/optional ⇒ absent deps = every method is a
 * state-only no-op (headless-safe, byte-identical when unwired).
 *
 * Wiring (serial track — see the FloorMask HANDOFF): main.js constructs it
 * with the live `hud` and injects it into LadderController, which calls
 * setFloor(floor) at the END of _applyFloorContent and setFloor(null) in
 * _disengage — the audioBeds rows.
 *
 * @module ui/hud/FloorMask
 */

// ── Tunables (own-module exports; house rule: never FloorContract/Constants) ─

/** Faint-tier resting opacity (D6 "~30 %"). */
export const FAINT_OPACITY = 0.3;

/** Faint↔bright hover ease (08-workbench §2 motion: one curve, 240–300 ms). */
export const FAINT_TRANSITION_MS = 240;

/** Arrival fade-in — the destination panes fade in during the ~550 ms flight. */
export const TRANSITION_FADE_MS = 550;

/** Reduced-motion arrival crossfade (00-spec §6: crossfades replace rides). */
export const REDUCED_CROSSFADE_MS = 200;

/**
 * MASK_PANES — the maskable pane vocabulary (plain names from the §4 table).
 *
 * rung:   pane-density rung id (hud.paneDensity.rungs) that owns the pane's
 *         ONE visibility bit; null = mask-owned attribute pane.
 * els:    DOM selectors for the faint/fade treatments (and for attribute
 *         panes, the visibility itself). '#id' or a class selector.
 * memory: participates in D5 per-floor player memory. The reticle canvas has
 *         no player toggle, so its state is table-driven only.
 *
 * Deliberately NOT here (the always set + world rungs): the 'score' and
 * 'comms' rungs (D7 — alerts/score never masked), the 'reticles' DENSITY
 * flag-rung (it bundles the warnings/conjunction chrome — hiding it would
 * violate D7; the mask's 'reticles' pane touches ONLY the targeting-bracket
 * canvas), and the 'skylabels'/'craft' world rungs (scene objects, owned by
 * their own floor systems — the map rule here governs PANES).
 *
 * 'hints' (2026-09-02 evening, owner): the bottom-screen HintTicker strip —
 * onboarding beats ("Launch net (N)"), scan/lasso verbs, the codex ack chip.
 * Every chip it carries teaches or acknowledges the FLYING view, and in the F1
 * restore witnesses the tease_lock beat sat over the hull. Same shape as the
 * reticles pane: an ATTRIBUTE pane on the strip element only (the density
 * 'score' rung bundles the strip with the score panel for the 0-key
 * convenience — that rung is never driven, and the score panel itself is never
 * touched, so D7 holds). The ticker keeps its items and timers while hidden;
 * whatever is still alive reappears on the next floor.
 *
 * 'cargo' (2026-09-06, Session K): the CARGO pane (js/ui/hud/CargoPane.js) —
 * the manifest with SELL / SELL ALL / -> ELEVATOR over CargoSystem through
 * ShopScreen's public wrappers. A RUNG pane like the others: the pane owns a
 * pane-density rung ('cargo', pushed into hud.paneDensity.rungs by main.js
 * BEFORE the first setFloor) whose ONE bit is `data-density-hidden` on the
 * root `#hud-cargo-pane` (a direct child of #hud-overlay), so the DISPLAY rail
 * lists it as a notch and D5 remembers it per floor.
 *
 * 'orbit' / 'copilot' / 'next' (2026-09-06, Session M — Instruments): three
 * more RUNG panes of the same shape. ORBIT (js/ui/hud/OrbitPane.js,
 * `#hud-orbit-pane`, bottom-left right of the DISPLAY rail: the fixed
 * instrument slots + the OrbitMFD plot as its track view), COPILOT
 * (js/ui/hud/FmaStrip.js, `#hud-fma-strip`, the flight-mode annunciator that
 * rides as the LAST child of #hud-left-column — the DISPLAY rail dodges the
 * column, so nothing else moves) and NEXT (js/ui/hud/NextPane.js,
 * `#hud-next-pane`, the right edge above the CARGO slot: transfer window /
 * TCA / shadow / ground pass). Each pushes its rung into
 * hud.paneDensity.rungs from main.js BEFORE the first setFloor.
 */
/**
 * The pane-density rungs' OWN hide bit (HUD._initPaneDensity domRung): set on
 * a pane's elements by `rung.setVisible(false)`, cleared by `setVisible(true)`
 * and by the pane's keys. The mask READS it (intent — see `_isVisible`) and
 * never writes it: every write goes through the rung adapter, the one writer.
 */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';

export const MASK_PANES = Object.freeze({
  targets:     Object.freeze({ rung: 'targets',     els: Object.freeze(['#hud-targets-panel']),      memory: true }),
  debris:      Object.freeze({ rung: 'debris',      els: Object.freeze(['#hud-wireframe-container']), memory: true }),
  navsphere:   Object.freeze({ rung: 'navsphere',   els: Object.freeze([]),                           memory: true }),
  pin:         Object.freeze({ rung: 'pin',         els: Object.freeze(['#hud-pin-widget']),          memory: true }),
  discoveries: Object.freeze({ rung: 'discoveries', els: Object.freeze(['.skills-pane']),             memory: true }),
  mother:      Object.freeze({ rung: 'mother',      els: Object.freeze(['#hud-mother-panel']),        memory: true }),
  arms:        Object.freeze({ rung: 'arms',        els: Object.freeze(['#hud-arms-panel']),          memory: true }),
  reticles:    Object.freeze({ rung: null,          els: Object.freeze(['#reticle-canvas']),          memory: false }),
  hints:       Object.freeze({ rung: null,          els: Object.freeze(['#hud-hint-ticker']),         memory: false }),
  cargo:       Object.freeze({ rung: 'cargo',       els: Object.freeze(['#hud-cargo-pane']),          memory: true }),
  orbit:       Object.freeze({ rung: 'orbit',       els: Object.freeze(['#hud-orbit-pane']),          memory: true }),
  copilot:     Object.freeze({ rung: 'copilot',     els: Object.freeze(['#hud-fma-strip']),           memory: true }),
  next:        Object.freeze({ rung: 'next',        els: Object.freeze(['#hud-next-pane']),           memory: true }),
  // Session N.5 (owner 2026-09-07): comms leaves ALWAYS_ON — the workbench is
  // the ship and its callouts, no radio chatter. A room pane like the rest:
  // gone on F1 by default, shown on floors 2-5, the rail toggles it, D5
  // remembers.
  comms:       Object.freeze({ rung: 'comms',       els: Object.freeze(['#hud-comms-panel']),         memory: true }),
  // SAFETY OVERRIDE panel (owner 2026-09-07.home/.kilo/plans/1788703905516-safety-override-panel.md
  // D3):the demo cockpit button at bottom-centre. A pane-density rung at
  // index 0 — hidden by default on EVERY floor (every DEFAULT_ROOMS row says
  // 'gone');the last `+` reveals it,the first `-` sheds it; D5 remembers it
  // per floor once pulled out.
  override:    Object.freeze({ rung: 'override',    els: Object.freeze(['#hud-override-pane']),     memory: true }),
});

/**
 * ALWAYS_ON — the D7 always set, pinned for tests. The engine never touches
 * these: no rung call, no element query, no attribute — on any floor, under
 * any player memory. (Display counterpart of "alarms always land at 1×".)
 * The VitalsLine left this set in Session O (plan D8, owner 2026-09-07):
 * cryptic, every number duplicated elsewhere; module + test stay dormant.
 */
export const ALWAYS_ON = Object.freeze([
  'alerts',      // #hud-warnings-panel, #hud-conjunction-panel — never referenced
  'rail',        // #ladder-rail — the ladder's own instrument
  'score',       // score strip rung — "it is the score", every zoom
  // 'comms' left for MASK_PANES in Session N.5 (owner 2026-09-07): gone on
  // the F1 workbench by default, shown on floors 2-5.
]);

/**
 * DEFAULT_ROOMS — the §4 default-rooms table, floor → pane → tier.
 * Exhaustive over MASK_PANES for every FloorContract floor (ids 1–5 since the
 * Session H 7→5 renumber; same physical rooms, new keys) — since Session K
 * (2026-09-06) that set includes the 'cargo' pane, so every row carries a
 * `cargo` tier. An id without a row (out-of-table — nothing ships one) falls
 * back to all-'shown' (full cockpit). Edit per D5 as you play — player memory
 * wins.
 *
 *   F1 ship close-up  (inspect/refit):  hull is the index; EVERY pane clears
 *                                        out — discoveries too (owner, 2026-09-02
 *                                        evening, from the restore witnesses: the
 *                                        skills it lists teach the flying view,
 *                                        MotherCallouts' cards are the learning
 *                                        aid at the hull, and its top-left slot is
 *                                        exactly where the left callout rail
 *                                        paints; skill toasts land regardless).
 *                                        The hint ticker goes too (same evening:
 *                                        its chips teach the flying view — the
 *                                        tease_lock "Launch net (N)" beat sat over
 *                                        the hull; it is back on F2 with whatever
 *                                        is still alive).
 *   F2 flying view    (capture):        the home floor — everything shipped
 *                                        EXCEPT the nav orb and the discoveries
 *                                        pane (owner, 2026-09-06, from the first
 *                                        screen look: both are tall, both sat
 *                                        where the mid-height rails land — the
 *                                        orb under the WHERE rail, discoveries
 *                                        under the DISPLAY rail. Gone by default
 *                                        saves the vertical space; 8 / the WHAT
 *                                        rail's dim notch bring either back and
 *                                        D5 remembers). The orb was off in the
 *                                        shipped cockpit too — F2 'shown' had
 *                                        been turning it ON.
 *   F3 approach view  (insertion):      corner orb + daughters; lists go.
 *   F4 route planning (transfer):       daughters faint (out flying); rest go.
 *   F5 whole-Earth chart (survey):      chart + score + alerts only.
 *   The hint ticker is gone on every floor but F2 (owner, 2026-09-02 evening:
 *   "same clean-up" for the far floors) — its chips teach the flying view.
 *   The CARGO pane (Session K, 2026-09-06, owner call by the 13-inch iPad
 *   numbers) is 'shown' on F1 only — the shop floor, where selling and
 *   contributing happen — and 'gone' on F2–F5: on F2 the bottom-right slot has
 *   8 px of slack under the SPECS tab at the default room, so the pane sits
 *   behind the DISPLAY rail's MORE there and D5 remembers it per room once
 *   flipped.
 *   The Session M instruments (2026-09-06, owner law: by the 13-inch iPad
 *   numbers): ORBIT and COPILOT are 'shown' on the two flying floors F2 + F3
 *   (the DISPLAY rail's eight room-default notches on F2 are then exactly pin,
 *   debris, targets, mother, arms, reticles, orbit, copilot — the sky-label
 *   and score extras move behind MORE); COPILOT stays 'faint' on F4 with the
 *   daughters rows (the autopilot can be flying a cluster leg while the player
 *   plans); NEXT is 'shown' on the approach and route floors F3 + F4 (TCA and
 *   the transfer window are their subjects) and 'gone' on the home floor F2
 *   (D-L: a later-wave pane — one dim notch away behind MORE, D5 remembers);
 *   all three 'gone' on the hull F1 and the chart F5.
 */
// `override` is 'gone' on every floor by design (D3) — `_applyRoom` defaults a MISSING
// key to 'shown', so every row must carry it (the exhaustive-row test pins that).
export const DEFAULT_ROOMS = Object.freeze({
  1: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
    pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone', hints: 'gone',
    // Session N.5 (owner 2026-09-07):the workbench is the SHIP — cargo (the
    // elevator/till) and comms leave the F1 defaults too. The first
    // WORKBENCH_STOP shows the till itself ((main.js)and D5 keeps it.
    cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'gone', override: 'gone',
  }),
  // Session N.5 (owner 2026-09-07) + Session O (owner 2026-09-07,
  // "LEFT: mother, daughters"): the flying floor greets a first-timer with
  // FOUR panes — what am I aiming at (targets), what is around me (reticles &
  // alerts), can I catch (mother) — plus her daughters rows, the fleet list
  // (arms) — plus the narrator (comms) and the hint ticker. The rest
  // (debris map, upgrade pin, orbit numbers, autopilot strip) wait behind
  // MORE / `+` until curiosity arrives; D5 remembers whatever a player pulls
  // out.
  2: Object.freeze({
    targets: 'shown', debris: 'gone', navsphere: 'gone', reticles: 'shown',
    pin: 'gone', mother: 'shown', arms: 'shown', discoveries: 'gone', hints: 'shown',
    cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'shown', override: 'gone',
  }),
3: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'shown', reticles: 'shown',
    pin: 'gone', mother: 'gone', arms: 'shown', discoveries: 'gone', hints: 'gone',
    cargo: 'gone', orbit: 'shown', copilot: 'shown', next: 'shown', comms: 'shown', override: 'gone',
  }),
4: Object.freeze({
targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
     pin: 'gone', mother: 'gone', arms: 'faint', discoveries: 'gone', hints: 'gone',
    cargo: 'gone', orbit: 'gone', copilot: 'faint', next: 'shown', comms: 'shown', override: 'gone',
  }),
5: Object.freeze({
targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
     pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone', hints: 'gone',
    cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'shown', override: 'gone',
  }),
});

/** @private House reduced-motion probe (GameFlowManager._prefersReducedMotion). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

export class FloorMask {
  /**
   * @param {object} [deps]
   * @param {object}   [deps.hud]         - the live HUD; the mask reads
   *   `hud.paneDensity.rungs` (the EXISTING visibility layer). Absent ⇒ every
   *   method is a state-only no-op (headless-safe, byte-identical unwired).
   * @param {Document} [deps.doc]         - document for the faint/fade/attribute
   *   treatments (default: the global one). Absent ⇒ rung-driven visibility
   *   still applies; DOM treatments no-op (Node tests drive stub rungs).
   * @param {function} [deps.reducedMotion] - zero-arg bool probe (default:
   *   the house matchMedia pattern) — picks the arrival fade length.
   */
  constructor(deps = {}) {
    this._hud = deps.hud || null;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._reducedMotion = deps.reducedMotion || _prefersReducedMotion;

    this._enabled = true;
    /** Last requested floor (remembered while disabled/unresolved — beds idiom). */
    this._floor = null;
    /** Floor whose layout is currently APPLIED (null = shipped cockpit). */
    this._appliedFloor = null;
    /** @type {Map<number, Map<string, boolean>>} D5 memory: floor → pane → visible */
    this._memory = new Map();
    /** @type {Map<string, object>|null} rung id → rung, resolved lazily */
    this._rungs = null;
    this._styleInjected = false;
    this._disposed = false;
  }

  // ── Public API (the LadderAudioBeds shape) ─────────────────────────────────

  /**
   * Apply floor `floorId`'s room (player memory over §4 defaults), capturing
   * the departing floor's live layout into D5 memory first. null = disengage
   * → restore the shipped fully-visible cockpit. Idempotent for the already-
   * applied floor. While disabled only the floor is remembered.
   * @param {number|null} floorId - FloorContract floor id (1..5) or null
   */
  setFloor(floorId) {
    if (this._disposed) return;
    this._floor = (typeof floorId === 'number') ? floorId : null;
    if (!this._enabled) return;             // remembered; applied on re-enable
    if (!this._resolve()) return;           // absent deps: state-only no-op
    if (this._floor === this._appliedFloor) return;   // idempotent
    // CLEAN VIEW is a MODE, not a room edit (owner 2026-09-06): while the
    // density holds a `-` stash the departing floor's LIVE layout is the
    // cleared screen — capturing it would remember "everything hidden".
    // Skip the capture (the memory keeps the pre-clear room), then void the
    // stash: it belonged to the departing room, and `+` on the arrival floor
    // walks that floor's ladder — floor 2's panes never land on floor 4.
    if (!this._inCleanView()) this._captureMemory();
    this._dropDensityStash();
    if (this._floor === null) {
      this._restoreAll();
      return;
    }
    this._applyRoom(this._floor);
  }

  /** @private true while PaneDensity holds a clean-view stash (duck-typed; absent → false). */
  _inCleanView() {
    const pd = this._hud && this._hud.paneDensity;
    return !!(pd && typeof pd.hasStash === 'function' && pd.hasStash());
  }

  /** @private PaneDensity.dropStash() when the injected HUD has it (duck-typed). */
  _dropDensityStash() {
    const pd = this._hud && this._hud.paneDensity;
    if (pd && typeof pd.dropStash === 'function') pd.dropStash();
  }

  /**
   * Master gate. Disabling restores the shipped cockpit (mask off = no
   * masking) and remembers the floor; re-enabling reapplies the remembered
   * floor's room. Idempotent.
   * @param {boolean} on
   */
  setEnabled(on) {
    if (this._disposed) return;
    const want = !!on;
    if (want === this._enabled) return;
    this._enabled = want;
    if (!this._resolve()) return;
    if (!want) {
      if (!this._inCleanView()) this._captureMemory();   // keep the player's latest edits (never a clean-view screen)
      this._dropDensityStash();
      this._restoreAll();
    } else if (this._floor != null) {
      this._applyRoom(this._floor);
    }
  }

  /** Restore the cockpit; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    if (this._resolve()) {
      if (!this._inCleanView()) this._captureMemory();   // a cleared screen is never a room
      this._restoreAll();
    }
    this._disposed = true;
  }

  /** The currently applied floor id, or null (tests/debug). */
  getAppliedFloor() { return this._appliedFloor; }

  /**
   * Capture the APPLIED floor's live pane intent into D5 memory NOW, without a
   * floor change — the same read `setFloor` performs at its capture moment
   * (`_captureMemory`, the ONE intent read). Wave 5 Session H (Job A — the D5
   * room-memory WRITE GAP, 03-plan Session G FINDINGS (c)): a pane shown or
   * hidden by its own key (0/9/8, the density `-`/`+`/slider) and then a
   * reload with NO floor change in between was never persisted, because the
   * mask captured only inside setFloor(). LadderController.noteRoomChange()
   * calls this on the Events.HUD_PANE_VISIBILITY edge, then exports. No-op
   * while disposed / disabled (the cockpit is restored — a key press there is
   * not a room edit) / unresolved (absent deps) / disengaged (no applied
   * floor). Event-rate only (a key press), never per frame — G1.
   */
  capture() {
    if (this._disposed || !this._enabled) return;
    if (!this._resolve()) return;
    if (this._appliedFloor == null) return;
    this._captureMemory();
  }

  /** The last requested floor id, or null (tests/debug — beds parity). */
  getCurrentFloor() { return this._floor; }

  /**
   * RESET ROOM (Wave 5 Session J, plan D-H "long-press rail head = RESET
   * ROOM"): forget floor `floor`'s D5 memory row and, when it is the APPLIED
   * floor, re-apply its DEFAULT_ROOMS row now (memory over defaults with no
   * memory = the defaults; the arrival fade runs as on a ride). Other floors'
   * rows are untouched. No-op while disposed; a non-applied floor only loses
   * its row (applied on the next arrival). LadderController.resetRoom() calls
   * this and exports afterwards. Event-rate only (a long-press).
   * @param {number} floor - FloorContract floor id
   * @returns {boolean} true when a row was dropped or the room re-applied
   */
  resetRoom(floor) {
    if (this._disposed || typeof floor !== 'number') return false;
    const had = this._memory.delete(floor);
    if (this._enabled && this._resolve() && this._appliedFloor === floor) {
      this._applyRoom(floor);
      return true;
    }
    return had;
  }

  /**
   * D5 memory as a plain-JSON persistence surface (Wave 5 serializes this):
   * `{ floors: { "<floorId>": { "<paneId>": boolean } } }`.
   * @returns {{floors: Object<string, Object<string, boolean>>}}
   */
  exportMemory() {
    const floors = {};
    for (const [floor, panes] of this._memory) {
      const row = {};
      for (const [pane, vis] of panes) row[pane] = !!vis;
      floors[floor] = row;
    }
    return { floors };
  }

  /**
   * Restore a D5 memory snapshot (exportMemory shape). Unknown panes and
   * non-boolean values are dropped; ALWAYS_ON can never ride in via memory
   * because the always set is not part of MASK_PANES at all.
   * @param {{floors?: Object<string, Object<string, boolean>>}} state
   */
  importMemory(state) {
    if (this._disposed || !state || typeof state !== 'object') return;
    const floors = state.floors;
    if (!floors || typeof floors !== 'object') return;
    this._memory.clear();
    for (const key of Object.keys(floors)) {
      const floor = Number(key);
      const row = floors[key];
      if (!Number.isFinite(floor) || !row || typeof row !== 'object') continue;
      const panes = new Map();
      for (const pane of Object.keys(row)) {
        if (MASK_PANES[pane] && MASK_PANES[pane].memory && typeof row[pane] === 'boolean') {
          panes.set(pane, row[pane]);
        }
      }
      if (panes.size) this._memory.set(floor, panes);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * @private Resolve the injected HUD's pane-density rungs (lazy, cached).
   * Absent hud / paneDensity ⇒ false — the whole engine stays a no-op.
   * @returns {boolean}
   */
  _resolve() {
    if (this._rungs) return true;
    const pd = this._hud && this._hud.paneDensity;
    const rungs = pd && Array.isArray(pd.rungs) ? pd.rungs : null;
    if (!rungs) return false;
    this._rungs = new Map();
    for (const r of rungs) if (r && r.id) this._rungs.set(r.id, r);
    return true;
  }

  /** @private Capture the applied floor's live layout into D5 memory. */
  _captureMemory() {
    const floor = this._appliedFloor;
    if (floor == null) return;
    let row = this._memory.get(floor);
    if (!row) { row = new Map(); this._memory.set(floor, row); }
    for (const [id, pane] of Object.entries(MASK_PANES)) {
      if (!pane.memory) continue;
      const vis = this._isVisible(id, pane);
      if (vis != null) row.set(id, vis);
    }
  }

  /** @private Apply floor `floor`'s room: memory over defaults, tiers, fade. */
  _applyRoom(floor) {
    this._appliedFloor = floor;
    const room = DEFAULT_ROOMS[floor] || null;   // no row (out-of-table id) → all shown
    const mem = this._memory.get(floor) || null;
    const fadeMs = this._reducedMotion() ? REDUCED_CROSSFADE_MS : TRANSITION_FADE_MS;
    for (const [id, pane] of Object.entries(MASK_PANES)) {
      const tier = (room && room[id]) || 'shown';
      const remembered = (pane.memory && mem && mem.has(id)) ? mem.get(id) : null;
      const wantVisible = remembered != null ? remembered : tier !== 'gone';
      const live = this._isVisible(id, pane);
      if (live != null && wantVisible !== live) {
        this._setVisible(id, pane, wantVisible);
        if (wantVisible) this._arriveFade(pane, fadeMs);
      }
      this._setFaint(pane, tier === 'faint' && wantVisible);
    }
    // Session O (plan D16 (a), owner 2026-09-07): the room apply just drove every
    // rung's setVisible (incl. comms — F1 hides it, F2+ shows it) — visibility
    // toggles that arrive with NO event, so the HUD's cached comms-bottom rect went
    // stale (the right column's top was computed against a hidden pane: bottom 0
    // → top ≈ 12 px → COMMS/TARGETS overlap, the owner's screenshot). Null it so
    // the next update() frame recomputes. The pane's hiding is the density attribute
    // (`data-density-hidden` → `display:none !important`) — display flips immediately,
    // no CSS transition on it, so the next-frame rect is already the final box (no
    // settle window like COMMS_PANEL_RESIZED's stepped sizes need). One call, at the
    // end of the floor apply only — `_restoreAll` (disengage) restores the shipped
    // cockpit the same rung writes, but the HUD is hidden in the menu then (update()
    // returns early), and the next engage re-runs this floor apply — cached values can
    // never be read stale across an engage.
    this._hud.invalidateCommsLayout?.();
  }

  /** @private Shipped fully-visible cockpit: every pane shown, treatments off. */
  _restoreAll() {
    this._appliedFloor = null;
    for (const [id, pane] of Object.entries(MASK_PANES)) {
      const live = this._isVisible(id, pane);
      if (live === false) this._setVisible(id, pane, true);
      this._setFaint(pane, false);
      for (const el of this._els(pane)) {
        if (el.classList) el.classList.remove('floor-mask-arrive');
      }
    }
  }

  /**
   * @private A pane's ONE visibility bit — the player's INTENT, never on-screen
   * presence. A rung pane whose elements resolve reads the rung's own
   * `data-density-hidden` attribute on them (set by the rung's setVisible — the
   * density `-`, this mask — and cleared by the pane's keys; the mask never
   * writes it directly, the rung stays the ONE writer). NOT the adapter's
   * `isVisible()`: HUD's DOM rungs answer false for a pane that is merely OFF
   * SCREEN (their getClientRects check — PaneDensity's "don't waste a rung"
   * rule), and reading that as "hidden" captured `pin: false` on the flying floor (pre-renumber F4, now F2) for every
   * player who had not pinned an upgrade goal yet (the widget is display:none
   * until then), then density-hid the widget the moment they pinned one (Wave 4
   * behaviour; fixed 2026-09-04, Session G review, once the D5 store began
   * persisting the capture). Element-less rungs (the navsphere orb —
   * `isOrbVisible()` IS its intent flag) and headless runs (no doc) fall back to
   * the adapter. Attribute panes read the mask-owned `data-floor-gone`.
   * null = unknowable (no rung, no elements) — skipped.
   */
  _isVisible(id, pane) {
    if (pane.rung) {
      const rung = this._rungs.get(pane.rung);
      if (!rung) return null;
      const els = this._els(pane);
      if (els.length) {
        return els.some((el) => !(el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR)));
      }
      try { return !!rung.isVisible(); } catch (_e) { return null; }
    }
    const els = this._els(pane);
    if (!els.length) return null;
    return els.every((el) => !(el.hasAttribute && el.hasAttribute('data-floor-gone')));
  }

  /** @private Drive the pane's ONE visibility bit (rung or mask attribute). */
  _setVisible(id, pane, visible) {
    if (pane.rung) {
      const rung = this._rungs.get(pane.rung);
      if (rung && rung.setVisible) {
        try { rung.setVisible(!!visible); } catch (_e) { /* adapter refused */ }
      }
      return;
    }
    this._ensureStyle();
    for (const el of this._els(pane)) {
      if (visible) el.removeAttribute('data-floor-gone');
      else el.setAttribute('data-floor-gone', '');
    }
  }

  /** @private Faint tier treatment (attribute + CSS hover — D6). */
  _setFaint(pane, faint) {
    const els = this._els(pane);
    if (!els.length) return;
    if (faint) this._ensureStyle();
    for (const el of els) {
      if (faint) el.setAttribute('data-floor-faint', '');
      else el.removeAttribute('data-floor-faint');
    }
  }

  /**
   * @private Arrival fade-in on a newly-revealed pane's elements: restart the
   * finite fade class with the flight (or reduced-motion crossfade) length.
   * Runs only on floor changes (G1 — no per-frame churn).
   */
  _arriveFade(pane, fadeMs) {
    const els = this._els(pane);
    if (!els.length) return;
    this._ensureStyle();
    for (const el of els) {
      if (!el.classList || !el.style) continue;
      el.classList.remove('floor-mask-arrive');
      void el.offsetHeight;                 // restart the finite animation
      el.style.animationDuration = `${fadeMs}ms`;
      el.classList.add('floor-mask-arrive');
    }
  }

  /** @private Resolve a pane's DOM elements (headless: always []). */
  _els(pane) {
    const doc = this._doc;
    if (!doc || !pane.els || !pane.els.length) return [];
    const out = [];
    for (const sel of pane.els) {
      try {
        if (sel.charCodeAt(0) === 35 /* '#' */) {
          const el = doc.getElementById(sel.slice(1));
          if (el) out.push(el);
        } else {
          const list = doc.querySelectorAll(sel);
          for (const el of list) out.push(el);
        }
      } catch (_e) { /* stub doc without that surface */ }
    }
    return out;
  }

  /** @private Inject the mask stylesheet once (attribute laws + arrive fade. */
  _ensureStyle() {
    if (this._styleInjected || !this._doc || !this._doc.head) return;
    this._styleInjected = true;
    if (this._doc.getElementById('floor-mask-style')) return;
    const style = this._doc.createElement('style');
    style.id = 'floor-mask-style';
    style.textContent = `
      /* Map rule (D8): a floor-gone pane is hard off. !important beats the
       * inline display writes from view-switch/update code (T8) — only the
       * mask itself clears it. */
      [data-floor-gone] { display: none !important; }
      /* D6 faint tier: dim, hoverable, NEVER gone. !important beats the
       * .hud-active opacity; hover (and the shared bright class) wins back. */
      [data-floor-faint] {
        opacity: ${FAINT_OPACITY} !important;
        transition: opacity ${FAINT_TRANSITION_MS}ms ease;
        pointer-events: auto;
      }
      [data-floor-faint]:hover {
        opacity: 1 !important;
      }
      /* Arrival: destination panes fade in during the flight. Duration is set
       * inline per application (flight vs reduced-motion crossfade). */
      @keyframes floor-mask-arrive { from { opacity: 0; } to { opacity: 1; } }
      .floor-mask-arrive { animation: floor-mask-arrive ${TRANSITION_FADE_MS}ms ease both; }
      @media (prefers-reduced-motion: reduce) {
        [data-floor-faint] { transition: none; }
        .floor-mask-arrive { animation-duration: ${REDUCED_CROSSFADE_MS}ms; }
      }
    `;
    this._doc.head.appendChild(style);
  }
}

export default FloorMask;
