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
 * per pane and every party composes on it. The one §4 pane with no rung
 * (the debris-targeting reticle canvas) gets a mask-owned attribute
 * (`data-floor-gone`) with the same `!important` discipline.
 *
 * D5 (per-floor player memory — "rooms you can rearrange"): on every floor
 * change the mask first CAPTURES the departing floor's live pane visibility
 * (rung.isVisible(), the same source PaneDensity trusts), then applies the
 * arrival floor's layout = player memory where it exists, the §4 default
 * room otherwise. A pane re-shown with its own key (which clears the
 * attribute) is therefore remembered for THAT floor and reapplied on return;
 * global toggles apply within the mask. In-memory this wave; the state shape
 * (exportMemory/importMemory: plain JSON booleans keyed floor → pane) is the
 * Wave-5 persistence surface.
 *
 * D7 + vitals (the always set): alerts (warnings strip, conjunction panel,
 * comms), the rail, the score strip, and the vitals line are NEVER masked on
 * any floor, regardless of tier tables or player memory — the engine never
 * references their rungs or elements at all (ALWAYS_ON below is the pinned
 * list). The VitalsLine (fuel/ΔV · power · time rate) is constructed/owned
 * here as part of that always set: faint by default, hover/tap brightens,
 * shown on engage, hidden on disengage (the shipped cockpit has no vitals
 * line, so flag-off/unwired stays byte-identical).
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
 * with the live `hud` + a time-rate getter and injects it into
 * LadderController, which calls setFloor(floor) at the END of
 * _applyFloorContent and setFloor(null) in _disengage — the audioBeds rows.
 *
 * @module ui/hud/FloorMask
 */

import { VitalsLine } from '../VitalsLine.js';

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
 */
export const MASK_PANES = Object.freeze({
  targets:     Object.freeze({ rung: 'targets',     els: Object.freeze(['#hud-targets-panel']),      memory: true }),
  debris:      Object.freeze({ rung: 'debris',      els: Object.freeze(['#hud-wireframe-container']), memory: true }),
  navsphere:   Object.freeze({ rung: 'navsphere',   els: Object.freeze([]),                           memory: true }),
  pin:         Object.freeze({ rung: 'pin',         els: Object.freeze(['#hud-pin-widget']),          memory: true }),
  discoveries: Object.freeze({ rung: 'discoveries', els: Object.freeze(['.skills-pane']),             memory: true }),
  mother:      Object.freeze({ rung: 'mother',      els: Object.freeze(['#hud-mother-panel']),        memory: true }),
  arms:        Object.freeze({ rung: 'arms',        els: Object.freeze(['#hud-arms-panel']),          memory: true }),
  reticles:    Object.freeze({ rung: null,          els: Object.freeze(['#reticle-canvas']),          memory: false }),
});

/**
 * ALWAYS_ON — the D7 + vitals always set, pinned for tests. The engine never
 * touches these: no rung call, no element query, no attribute — on any floor,
 * under any player memory. (Display counterpart of "alarms always land at 1×".)
 */
export const ALWAYS_ON = Object.freeze([
  'alerts',      // #hud-warnings-panel, #hud-conjunction-panel — never referenced
  'comms',       // comms pane/rung — alerts channel, sits on top of every floor
  'rail',        // #ladder-rail — the ladder's own instrument
  'score',       // score strip rung — "it is the score", every zoom
  'vitals',      // the VitalsLine — faint by default, NEVER gone (D6)
]);

/**
 * DEFAULT_ROOMS — the §4 default-rooms table, floor → pane → tier.
 * Exhaustive over MASK_PANES for floors 3–7 (the F3–F7 ladder, D1); floors
 * without a row (F1/F2 — retired as floors, rail notches remain until the
 * deferred 7→5 contract change) fall back to all-'shown' (full cockpit under
 * their DOM overlays). Edit per D5 as you play — player memory wins.
 *
 *   F3 ship close-up  (inspect/refit):  hull is the index; EVERY pane clears
 *                                        out — discoveries too (owner, 2026-09-02
 *                                        evening, from the restore witnesses: the
 *                                        skills it lists teach the flying view,
 *                                        MotherCallouts' cards are the learning
 *                                        aid at the hull, and its top-left slot is
 *                                        exactly where the left callout rail
 *                                        paints; skill toasts land regardless).
 *   F4 flying view    (capture):        everything shipped — the home floor.
 *   F5 approach view  (insertion):      corner orb + daughters; lists go.
 *   F6 route planning (transfer):       daughters faint (out flying); rest go.
 *   F7 whole-Earth chart (survey):      chart + score + alerts only.
 */
export const DEFAULT_ROOMS = Object.freeze({
  3: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
    pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone',
  }),
  4: Object.freeze({
    targets: 'shown', debris: 'shown', navsphere: 'shown', reticles: 'shown',
    pin: 'shown', mother: 'shown', arms: 'shown', discoveries: 'shown',
  }),
  5: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'shown', reticles: 'shown',
    pin: 'gone', mother: 'gone', arms: 'shown', discoveries: 'gone',
  }),
  6: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
    pin: 'gone', mother: 'gone', arms: 'faint', discoveries: 'gone',
  }),
  7: Object.freeze({
    targets: 'gone', debris: 'gone', navsphere: 'gone', reticles: 'gone',
    pin: 'gone', mother: 'gone', arms: 'gone', discoveries: 'gone',
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
   * @param {object}   [deps.vitals]      - injectable VitalsLine-shaped dep
   *   ({setVisible, dispose}). Omitted ⇒ the mask constructs its own
   *   VitalsLine lazily on first engage (doc required).
   * @param {function} [deps.getTimeRate] - forwarded to the owned VitalsLine
   *   (main.js wires `() => timeAuthority.rate`).
   * @param {function} [deps.reducedMotion] - zero-arg bool probe (default:
   *   the house matchMedia pattern) — picks the arrival fade length.
   */
  constructor(deps = {}) {
    this._hud = deps.hud || null;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._vitalsDep = deps.vitals || null;
    this._getTimeRate = deps.getTimeRate || null;
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
    this._vitals = null;
    this._ownVitals = false;
    this._styleInjected = false;
    this._disposed = false;
  }

  // ── Public API (the LadderAudioBeds shape) ─────────────────────────────────

  /**
   * Apply floor `floorId`'s room (player memory over §4 defaults), capturing
   * the departing floor's live layout into D5 memory first. null = disengage
   * → restore the shipped fully-visible cockpit and hide the vitals line.
   * Idempotent for the already-applied floor. While disabled only the floor
   * is remembered.
   * @param {number|null} floorId - FloorContract floor id (1..7) or null
   */
  setFloor(floorId) {
    if (this._disposed) return;
    this._floor = (typeof floorId === 'number') ? floorId : null;
    if (!this._enabled) return;             // remembered; applied on re-enable
    if (!this._resolve()) return;           // absent deps: state-only no-op
    if (this._floor === this._appliedFloor) return;   // idempotent
    this._captureMemory();
    if (this._floor === null) {
      this._restoreAll();
      return;
    }
    this._applyRoom(this._floor);
  }

  /**
   * Master gate. Disabling restores the shipped cockpit (mask off = no
   * masking; the vitals line hides with it) and remembers the floor;
   * re-enabling reapplies the remembered floor's room. Idempotent.
   * @param {boolean} on
   */
  setEnabled(on) {
    if (this._disposed) return;
    const want = !!on;
    if (want === this._enabled) return;
    this._enabled = want;
    if (!this._resolve()) return;
    if (!want) {
      this._captureMemory();                // keep the player's latest edits
      this._restoreAll();
    } else if (this._floor != null) {
      this._applyRoom(this._floor);
    }
  }

  /** Restore the cockpit, drop the owned vitals line; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    if (this._resolve()) {
      this._captureMemory();
      this._restoreAll();
    }
    if (this._vitals && this._ownVitals && this._vitals.dispose) {
      try { this._vitals.dispose(); } catch (_e) { /* stub */ }
    }
    this._vitals = null;
    this._disposed = true;
  }

  /** The currently applied floor id, or null (tests/debug). */
  getAppliedFloor() { return this._appliedFloor; }

  /** The last requested floor id, or null (tests/debug — beds parity). */
  getCurrentFloor() { return this._floor; }

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
    const room = DEFAULT_ROOMS[floor] || null;   // no row (F1/F2) → all shown
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
    this._ensureVitals();
    if (this._vitals && this._vitals.setVisible) this._vitals.setVisible(true);
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
    if (this._vitals && this._vitals.setVisible) this._vitals.setVisible(false);
  }

  /**
   * @private A pane's ONE live visibility bit. Rung panes read the rung
   * adapter (the same source PaneDensity trusts); attribute panes read the
   * mask-owned attribute. null = unknowable (no rung, no elements) — skipped.
   */
  _isVisible(id, pane) {
    if (pane.rung) {
      const rung = this._rungs.get(pane.rung);
      if (!rung) return null;
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

  /** @private Own the always-set VitalsLine (constructed lazily, once). */
  _ensureVitals() {
    if (this._vitals) return;
    if (this._vitalsDep) { this._vitals = this._vitalsDep; return; }
    if (!this._doc) return;
    this._vitals = new VitalsLine({ doc: this._doc, getTimeRate: this._getTimeRate });
    this._ownVitals = true;
  }

  /** @private Inject the mask stylesheet once (attribute laws + arrive fade). */
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
      [data-floor-faint]:hover, [data-floor-faint].vitals-bright {
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
