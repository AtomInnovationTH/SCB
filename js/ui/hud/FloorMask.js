/**
 * FloorMask.js — the Zoom Ladder's map-rule engine for HUD panes (docs/ladder/08-workbench.md D8 + §4 "The map rule
 * for panes").
 *
 * As on a map, what is labeled depends on how far you have zoomed. Each floor shows only the panes that make sense
 * at its scale; zooming out makes the screen CALMER. A per-floor DENSITY MASK over the shipped HUD panes, in three tiers:
 *   'shown' — the pane participates as shipped;
 *   'faint' — visible at ~30 % opacity, hover-to-brighten (D6 safety readouts; dims, never gone);
 *   'gone'  — not part of this floor's room.
 *
 * VISIBILITY LAYER ("don't fight the inline writes"): tier visibility goes through the EXISTING pane-density rung
 * adapters (HUD._initPaneDensity → hud.paneDensity.rungs, {id, isVisible, setVisible}). DOM rungs hide via the
 * `data-density-hidden` attribute, whose CSS `!important` beats every inline `display` write from view-switch / update
 * code, and the pane's own keys (7/8/9/0, the density `+`) already clear it: exactly ONE visibility bit per pane and
 * every party composes on it. Panes with no rung of their own (the debris-targeting reticle canvas, the hint-ticker
 * strip) get a mask-owned attribute (`data-floor-gone`) with the same `!important` discipline.
 *
 * D5 (per-floor player memory): on every floor change the mask first CAPTURES the departing floor's pane INTENT (the
 * ONE density bit on each pane's elements — `_isVisible`; never on-screen presence), then applies the arrival floor's
 * layout = player memory where it exists, the default room otherwise. A pane re-shown with its own key is remembered
 * for THAT floor. Persisted: exportMemory/importMemory (plain JSON booleans, floor → pane) ride the player store
 * `sc_ladder_view_v3` through LadderController + LadderViewStore.
 *
 * D7 (the always set): alerts (warnings strip, conjunction panel) and the rail are NEVER masked on any floor,
 * regardless of tier tables or player memory — the engine never references their rungs or elements (ALWAYS_ON is the
 * pinned list). The score strip and comms are maskable room panes.
 *
 * PURE SCENERY (owner 2026-09-07): when the `-` walk cleared every rung and bowed the rails out, the hub also sets
 * `body[data-pure-scenery]` (index.html CSS hides the SPECS/REFIT tabs and `#build-stamp`). Transient view state,
 * never a room edit; `+`, any ride, or a fresh engage clears it. The mask itself is untouched by it.
 *
 * Ride start: LadderController calls setFloor(floor) from _applyFloorContent (on engage AND at every ride START), so
 * the destination floor's panes fade in during the ~550 ms flight (TRANSITION_FADE_MS). Reduced motion swaps the
 * flight fade for a short crossfade (REDUCED_CROSSFADE_MS — 00-spec §6). DOM writes happen only on floor changes,
 * never per frame.
 *
 * API mirrors LadderAudioBeds: setFloor(floorId|null) — null = disengage → restore the SHIPPED cockpit
 * (hidden-by-default rungs stay hidden, see `shipped`); setEnabled(bool) master gate (disabled remembers the floor,
 * restores the cockpit); dispose(). All deps injected/optional ⇒ absent deps = state-only no-ops.
 *
 * Wiring: main.js constructs it with the live `hud` and injects it into LadderController, which calls setFloor(floor)
 * at the END of _applyFloorContent and setFloor(null) in _disengage.
 *
 * @module ui/hud/FloorMask
 */

/** Faint-tier resting opacity (D6 "~30 %"). */
export const FAINT_OPACITY = 0.3;

/** Faint↔bright hover ease (08-workbench §2: one curve, 240–300 ms). */
export const FAINT_TRANSITION_MS = 240;

/** Arrival fade-in: the destination panes fade in during the ~550 ms flight. */
export const TRANSITION_FADE_MS = 550;

/** Reduced-motion arrival crossfade (00-spec §6). */
export const REDUCED_CROSSFADE_MS = 200;

/**
 * MASK_PANES — the maskable pane vocabulary.
 *
 * rung:   pane-density rung id (hud.paneDensity.rungs) that owns the pane's ONE visibility bit; null = mask-owned
 *         attribute pane.
 * els:    DOM selectors for the faint/fade treatments (and for attribute panes, the visibility itself).
 * memory: participates in D5 per-floor player memory.
 * shipped: the pane's state in the SHIPPED cockpit — what `_restoreAll` (disengage, setEnabled(false), dispose)
 *         restores. Absent = 'shown'. 'gone' marks the `experimental` members (`navsphere`, `discoveries`,
 *         `override`): hidden by default on EVERY floor (each root is BUILT with `data-density-hidden`), so a
 *         disengage must not reveal them. D5 memory is captured BEFORE the restore, so a player's `+` state returns.
 *
 * Deliberately NOT here: the 'alerts' and 'rail' members of the always set (D7); the 'reticles' DENSITY flag-rung
 * (it bundles the warnings/conjunction chrome — hiding it would violate D7; the mask's 'reticles' pane drives the
 * separate `targetmarks` step, which touches ONLY the targeting canvas); the 'skylabels'/'craft' world rungs (scene
 * objects, owned by their own floor systems).
 *
 * 'hints' (owner 2026-09-02): the bottom-screen HintTicker strip. Every chip it carries teaches or acknowledges the
 * FLYING view. An ATTRIBUTE pane on the strip element only (the density 'score' rung bundles the strip with the score
 * panel — that rung is never driven). The ticker keeps its items and timers while hidden.
 *
 * 'cargo' (js/ui/hud/CargoPane.js) / 'orbit' (OrbitPane.js, `#hud-orbit-pane`, bottom-left under the left column) /
 * 'copilot' (FmaStrip.js, `#hud-fma-strip`, the LAST child of #hud-left-column, so nothing else moves) / 'next'
 * (NextPane.js, `#hud-next-pane`, right edge above the CARGO slot): RUNG panes that each own a pane-density rung,
 * pushed into hud.paneDensity.rungs by main.js BEFORE the first setFloor. The ONE bit is `data-density-hidden` on the
 * root; D5 remembers them per floor.
 */
/**
 * The pane-density rungs' OWN hide bit: set by `rung.setVisible(false)`, cleared by `setVisible(true)` and the pane's
 * keys. The mask READS it (intent — see `_isVisible`) and never writes it: every write goes through the rung adapter.
 */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';

export const MASK_PANES = Object.freeze({
  targets:     Object.freeze({ rung: 'targets',     els: Object.freeze(['#hud-targets-panel']),      memory: true }),
  debris:      Object.freeze({ rung: 'debris',      els: Object.freeze(['#hud-wireframe-container']), memory: true }),
  navsphere:   Object.freeze({ rung: 'navsphere',   els: Object.freeze([]),                           memory: true, shipped: 'gone' }),
  pin:         Object.freeze({ rung: 'pin',         els: Object.freeze(['#hud-pin-widget']),          memory: true }),
  // The #hud-discoveries wrapper (chip + popover).
  discoveries: Object.freeze({ rung: 'discoveries', els: Object.freeze(['#hud-discoveries']),         memory: true, shipped: 'gone' }),
  // `mother` and `vitals` are the two MEMBERS of the ONE `motherbox` step (owner 2026-10-22: one `-`/`+` for the
  // section and the box): each stays the ONE writer of its own element's hide bit.
  mother:      Object.freeze({ rung: 'mother',      els: Object.freeze(['#hud-mother-panel']),        memory: true }),
  // Meters (DECISIONS §15 row 5): heat, battery, gas and ion, top left. Hidable (owner 2026-10-22: "the new and
  // improved mother pane should be hidable"): the `vitals` member of the `motherbox` step is its ONE hide writer.
  // Shown on F1-F4, gone on F5 by default.
  vitals:      Object.freeze({ rung: 'vitals',      els: Object.freeze(['#hud-vitals']),              memory: true }),
  arms:        Object.freeze({ rung: 'arms',        els: Object.freeze(['#hud-arms-panel']),          memory: true }),
  // Target marks: the whole #reticle-canvas. The `targetmarks` step is its ONE hide writer (the entry keeps the name
  // `reticles`, so no room table changes). Hidden before the daughters pane (owner 2026-10-22).
  reticles:    Object.freeze({ rung: 'targetmarks', els: Object.freeze(['#reticle-canvas']),          memory: true }),
  hints:       Object.freeze({ rung: null,          els: Object.freeze(['#hud-hint-ticker']),         memory: false }),
  // owner 2026-09-23: the score strip shows at every zoom EXCEPT the hull (gone on F1, shown on F2–F5). An ATTRIBUTE
  // pane like 'hints', never a rung pane: the density rung named 'score' also carries the hint ticker, which has a
  // pane of its own. Table-driven only (memory: false): the owner's rule, not a per-player preference.
  score:       Object.freeze({ rung: null,          els: Object.freeze(['#hud-score-panel']),         memory: false }),
  cargo:       Object.freeze({ rung: 'cargo',       els: Object.freeze(['#hud-cargo-pane']),          memory: true }),
  orbit:       Object.freeze({ rung: 'orbit',       els: Object.freeze(['#hud-orbit-pane']),          memory: true }),
  copilot:     Object.freeze({ rung: 'copilot',     els: Object.freeze(['#hud-fma-strip']),           memory: true }),
  next:        Object.freeze({ rung: 'next',        els: Object.freeze(['#hud-next-pane']),           memory: true }),
  // owner 2026-09-07: no radio chatter at the workbench — comms is a room pane (gone on F1, shown on floors 2-5).
  comms:       Object.freeze({ rung: 'comms',       els: Object.freeze(['#hud-comms-panel']),         memory: true }),
  // SAFETY OVERRIDE panel (owner 2026-09-07): the demo cockpit button at bottom-centre. A pane-density rung at index
  // 0, hidden by default on EVERY floor; the last `+` reveals it, the first `-` sheds it. `shipped: 'gone'`: a
  // disengage restores it HIDDEN.
  override:    Object.freeze({ rung: 'override',    els: Object.freeze(['#hud-override-pane']),     memory: true, shipped: 'gone' }),
  // F1 bar (DECISIONS §15 row 9): the 4-button bar at the bottom centre of F1 — shown there ALWAYS, gone on F2–F5 and
  // in the shipped cockpit. An ATTRIBUTE pane (rung: null) with memory: false, so the table is the whole truth and no
  // ROOMS_GENERATION bump is needed (memory: true would carry an old 'gone' into every returning player).
  // The floor-1 help "?" (#hud-f1-help, HotkeyOverlay.mountF1Button) rides this pane.
  f1bar:       Object.freeze({ rung: null,          els: Object.freeze(['#hud-f1-bar', '#hud-f1-help']),             memory: false, shipped: 'gone' }),
});

/**
 * The D7 always set, pinned for tests. The engine never touches these: no rung call, no element query, no
 * attribute — on any floor, under any player memory.
 */
export const ALWAYS_ON = Object.freeze([
  'alerts',      // #hud-warnings-panel, #hud-conjunction-panel — never referenced
  'rail',        // #ladder-rail — the ladder's own instrument
]);

/**
 * DEFAULT_ROOMS — the §4 default-rooms table, floor → pane → tier. Exhaustive over MASK_PANES for every
 * FloorContract floor (ids 1–5), so every row carries every pane. An id without a row falls back to all-'shown'.
 * Player memory wins over these (the score is memory:false — the owner's rule, not a preference).
 *
 *   F1 ship close-up (inspect/refit): hull is the index; EVERY pane clears out — discoveries too (its skills teach the
 *       flying view, MotherCallouts' cards are the learning aid at the hull, and its top-left slot is where the left
 *       callout rail paints; skill toasts land regardless). The hint ticker goes too (its chips teach the flying view).
 *       owner 2026-09-02: F1 clears every pane out, discoveries included.
 *   F2 flying view (capture): the home floor — everything shipped EXCEPT the nav orb and the discoveries pane (both
 *       tall, both where the mid-height rails land; the orb was off in the shipped cockpit too).
 *       owner 2026-09-06: gone by default on F2, from the first screen look.
 *   F3 approach view (insertion): corner orb + daughters; lists go.
 *   F4 route planning (transfer): daughters faint (out flying); rest go.
 *   F5 whole-Earth chart (survey): chart + score + alerts only.
 *   The hint ticker is gone on every floor but F2 (owner 2026-09-02: "same clean-up" for the far floors).
 *   CARGO is 'shown' on F1 only (the shop floor, where selling and contributing happen), by the 13-inch iPad numbers:
 *   on F2 the bottom-right slot has 8 px of slack under the SPECS tab (owner 2026-09-06).
 *   ORBIT and COPILOT are 'shown' on the two flying floors F2 + F3 (owner 2026-09-06: by the 13-inch iPad numbers);
 *   COPILOT stays 'faint' on F4 with the daughters rows (the autopilot can be flying a cluster leg while the player
 *   plans); NEXT is 'shown' on F3 + F4 (TCA and the transfer window are their subjects) and 'gone' on F2; all three
 *   'gone' on F1 and F5.
 */
// `override` is 'gone' on every floor by design — `_applyRoom` defaults a MISSING key to 'shown', so every row must
// carry it (the exhaustive-row test pins that).
export const DEFAULT_ROOMS = Object.freeze({
  1: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
    pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone', hints: 'gone',
    // The workbench is the SHIP (owner 2026-09-07): cargo, comms and the score strip are gone; the room table is the
    // one truth.
    cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'gone', override: 'gone', f1bar: 'shown',
    score: 'gone',
    // §15 row 5 "always on screen": measured clear of the F1 bar and the closed drawer at 1280×800 / 1366×768 /
    // 1376×1032; main.js hides it while the drawer is open.
    vitals: 'shown',
  }),
  // owner 2026-09-07 ("LEFT: mother, daughters"): the flying floor greets a first-timer with targets, reticles &
  // alerts, mother, the daughters rows (arms), comms and the hint ticker. The rest (debris map, upgrade pin, orbit
  // numbers, autopilot strip) wait behind `+`.
  2: Object.freeze({
    // owner 2026-10-13: TARGETS and TARGET INFO ('debris') are shown on F2; HUD._scanGateOn holds both back until the
    // first scan completes.
    targets: 'shown', debris: 'shown', navsphere: 'gone', reticles: 'shown',
    pin: 'gone', mother: 'shown', arms: 'shown', discoveries: 'gone', hints: 'shown',
    cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'shown', override: 'gone', f1bar: 'gone',
    score: 'shown',
    vitals: 'shown',
  }),
 3: Object.freeze({
    // owner 2026-10-18 ("what is noise"): ORBIT (LAT, LON, ALT, MET) is a Details pane on F3 too: 'gone' by default,
    // one `+` away.
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'shown',
    pin: 'gone', mother: 'gone', arms: 'shown', discoveries: 'gone', hints: 'gone',
    cargo: 'gone', orbit: 'gone', copilot: 'shown', next: 'shown', comms: 'shown', override: 'gone', f1bar: 'gone',
    score: 'shown',
    vitals: 'shown',
  }),
  4: Object.freeze({
targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
      pin: 'gone', mother: 'gone', arms: 'faint', discoveries: 'gone', hints: 'gone',
     cargo: 'gone', orbit: 'gone', copilot: 'faint', next: 'shown', comms: 'shown', override: 'gone', f1bar: 'gone',
    score: 'shown',
    vitals: 'shown',
  }),
  5: Object.freeze({
targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
      pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone', hints: 'gone',
     cargo: 'gone', orbit: 'gone', copilot: 'gone', next: 'gone', comms: 'shown', override: 'gone', f1bar: 'gone',
    score: 'shown',
    vitals: 'gone',
  }),
});

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
    /** Last requested floor (remembered while disabled/unresolved). */
    this._floor = null;
    /** Floor whose layout is APPLIED (null = shipped cockpit). */
    this._appliedFloor = null;
    /** @type {Map<number, Map<string, boolean>>} D5 memory: floor → pane → visible */
    this._memory = new Map();
    /** @type {Map<string, object>|null} rung id → rung, resolved lazily */
    this._rungs = null;
    this._styleInjected = false;
    this._disposed = false;
    // The HUD reads the pane level through this mask (`getCurrentFloor`) for the simple-first lists; test stubs lack `attachFloorMask`.
    if (this._hud && typeof this._hud.attachFloorMask === 'function') this._hud.attachFloorMask(this);
  }

  /**
   * Apply floor `floorId`'s room (player memory over defaults), capturing the departing floor's live layout into D5
   * memory first. null = disengage → restore the SHIPPED cockpit. Idempotent. While disabled only the floor is remembered.
   * @param {number|null} floorId - FloorContract floor id (1..5) or null
   */
  setFloor(floorId) {
    if (this._disposed) return;
    this._floor = (typeof floorId === 'number') ? floorId : null;
    if (!this._enabled) return;             // remembered; applied on re-enable
    if (!this._resolve()) return;           // absent deps: state-only no-op
    if (this._floor === this._appliedFloor) return;   // idempotent
    // CLEAN VIEW is a MODE, not a room edit (owner 2026-09-06): while the density holds a `-` stash the departing
    // floor's LIVE layout is the cleared screen, and capturing it would remember "everything hidden". Skip the
    // capture, then void the stash (it belonged to the departing room: floor 2's panes never land on floor 4).
    if (!this._inCleanView()) this._captureMemory();
    this._dropDensityStash();
    if (this._floor === null) {
      this._restoreAll();
      return;
    }
    this._applyRoom(this._floor);
  }

  /** @private Duck-typed; absent → false. */
  _inCleanView() {
    const pd = this._hud && this._hud.paneDensity;
    return !!(pd && typeof pd.hasStash === 'function' && pd.hasStash());
  }

  _dropDensityStash() {
    const pd = this._hud && this._hud.paneDensity;
    if (pd && typeof pd.dropStash === 'function') pd.dropStash();
  }

  /** Master gate. Disabling restores the shipped cockpit and remembers the floor; re-enabling reapplies it. Idempotent. */
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

  dispose() {
    if (this._disposed) return;
    if (this._resolve()) {
      if (!this._inCleanView()) this._captureMemory();   // a cleared screen is never a room
      this._restoreAll();
    }
    this._disposed = true;
  }

  getAppliedFloor() { return this._appliedFloor; }

  /**
   * Capture the APPLIED floor's live pane intent into D5 memory NOW, without a floor change (`_captureMemory`, the
   * ONE intent read). Without it a pane toggled by its own key and then a reload with no floor change was never
   * persisted. LadderController.noteRoomChange() calls this on the Events.HUD_PANE_VISIBILITY edge, then exports.
   * No-op while disposed / disabled (a key press with the cockpit restored is not a room edit) / unresolved /
   * disengaged. Event-rate only, never per frame.
   */
  capture() {
    if (this._disposed || !this._enabled) return;
    if (!this._resolve()) return;
    if (this._appliedFloor == null) return;
    this._captureMemory();
  }

  getCurrentFloor() { return this._floor; }

  /**
   * True when a pane the APPLIED floor's DEFAULT_ROOMS row marks 'gone' is visible now (the intent bit `_isVisible`):
   * one `+` past the room. Not the D5 memory (rewritten on every change) and not a rung count (target info waiting
   * for Z counts as hidden there). No mask applied = false. Read-only; polled at 2-10 Hz.
   */
  extraPaneShown() {
    if (this._disposed || !this._enabled || this._appliedFloor == null || !this._rungs) return false;
    const room = DEFAULT_ROOMS[this._appliedFloor];
    if (!room) return false;
    for (const [id, pane] of Object.entries(MASK_PANES)) {
      if (room[id] !== 'gone') continue;
      if (this._isVisible(id, pane) === true) return true;
    }
    return false;
  }

  /**
   * RESET ROOM (long-press rail head): forget floor `floor`'s D5 memory row and, when it is the APPLIED floor,
   * re-apply its DEFAULT_ROOMS row now (the arrival fade runs as on a ride). Other floors are untouched; a
   * non-applied floor only loses its row. LadderController.resetRoom() calls this and exports afterwards.
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
   * A NEW game forgets the player's reveals: drops, on EVERY floor, each D5 memory entry that shows a pane that
   * floor's DEFAULT_ROOMS row marks 'gone'. A pane the player hid, and every 'faint' / 'shown' row, stays. Memory
   * only: the caller runs it while disengaged, and the next `setFloor` applies the result.
   * @returns {boolean} true when an entry was dropped
   */
  forgetReveals() {
    if (this._disposed) return false;
    let changed = false;
    for (const [floor, panes] of Array.from(this._memory)) {
      const room = DEFAULT_ROOMS[floor];
      if (!room) continue;
      for (const [pane, vis] of Array.from(panes)) {
        if (vis === true && room[pane] === 'gone') { panes.delete(pane); changed = true; }
      }
      if (!panes.size) this._memory.delete(floor);
    }
    return changed;
  }

  /**
   * D5 memory as plain JSON: `{ floors: { "<floorId>": { "<paneId>": boolean } } }`.
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
   * Restore a D5 memory snapshot (exportMemory shape). Unknown panes and non-boolean values are dropped; ALWAYS_ON
   * can never ride in via memory (it is not part of MASK_PANES).
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

  /** @private Lazy, cached. Absent hud / paneDensity ⇒ false: the whole engine stays a no-op. */
  _resolve() {
    if (this._rungs) return true;
    const pd = this._hud && this._hud.paneDensity;
    const rungs = pd && Array.isArray(pd.rungs) ? pd.rungs : null;
    if (!rungs) return false;
    this._rungs = new Map();
    // A rung inside a composite's `members` (`override` / `navsphere` / `discoveries` in `experimental`; `skylabels` /
    // `pin` in `decor`) is addressable by its own id. Cached once: all splices / addMember happen before `new FloorMask`.
    const register = (r) => {
      if (!r || !r.id) return;
      this._rungs.set(r.id, r);
      if (Array.isArray(r.members)) {
        for (const m of r.members) register(m);
      }
    };
    for (const r of rungs) register(r);
    return true;
  }

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
    // The room apply just drove every rung's setVisible (incl. comms) with NO event, so the HUD's cached comms-bottom
    // rect is stale (the right column's top would be computed against a hidden pane → COMMS/TARGETS overlap). Null it
    // so the next update() frame recomputes; display flips immediately (no CSS transition), so that rect is final.
    // Only here, not in `_restoreAll`: the HUD is hidden in the menu then, and the next engage re-runs this apply.
    this._hud.invalidateCommsLayout?.();
    // A room that shows HUD panes ends a muted-alerts state (alerts ride the HUD). Show-only: a floor change never mutes.
    this._hud.paneDensity?.revealFollowers?.();
  }

  /**
   * @private Every pane back to its `shipped` state (the `experimental` members are `'gone'`, so hidden-by-default
   * rungs STAY hidden: a disengage must not reveal the DISCOVERIES chip, ORB chip or Override gag), treatments off.
   * Callers capture D5 memory FIRST. Write-on-change through the rung adapters.
   */
  _restoreAll() {
    this._appliedFloor = null;
    for (const [id, pane] of Object.entries(MASK_PANES)) {
      const want = pane.shipped !== 'gone';
      const live = this._isVisible(id, pane);
      if (live != null && live !== want) this._setVisible(id, pane, want);
      this._setFaint(pane, false);
      for (const el of this._els(pane)) {
        if (el.classList) el.classList.remove('floor-mask-arrive');
      }
    }
  }

  /**
   * @private A pane's ONE visibility bit — the player's INTENT, never on-screen presence. A rung pane whose elements
   * resolve reads the rung's own `data-density-hidden` attribute on them (the mask never writes it; the rung stays
   * the ONE writer). NOT the adapter's `isVisible()`: HUD's DOM rungs answer false for a pane that is merely OFF
   * SCREEN (getClientRects check), and reading that as "hidden" captured `pin: false` for every player who had not
   * pinned an upgrade goal yet (the widget is display:none until then), then density-hid it the moment they pinned
   * one. Element-less rungs (the navsphere orb — `isOrbVisible()` IS its intent flag) and headless runs fall back to
   * the adapter. Attribute panes read the mask-owned `data-floor-gone`. null = unknowable (no rung, no elements).
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

  _setFaint(pane, faint) {
    const els = this._els(pane);
    if (!els.length) return;
    if (faint) this._ensureStyle();
    for (const el of els) {
      if (faint) el.setAttribute('data-floor-faint', '');
      else el.removeAttribute('data-floor-faint');
    }
  }

  /** @private Restart the finite fade class with the flight (or reduced-motion crossfade) length. Floor changes only. */
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
