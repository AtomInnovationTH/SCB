/**
 * HullCamFloor.js — the Zoom Ladder F3 (HULL CAM) floor content orchestrator
 * (S4, FloorContract.FLOORS[2]).
 *
 * F3 is the subject-anchored close-inspection floor (2–12 m). This module is
 * the F3 "costume" controller: it owns the blueprint/inspect surface while the
 * ladder is on the floor (costume.transform 'lens-split-5m'):
 *   - the BlueprintOverlay callout layer — leader-lined labels on the seven
 *     manifest subsystems (ENGINEERING / POWER / BERTHS / COMMS / CARGO /
 *     SENSORS / THERMAL — D9, js/data/blueprintSubsystems.js), filling the
 *     floor's labelBudget (7) exactly;
 *   - the LENS SPLIT at 5 m (F3.lens.splitAtM, 00-spec.md §3): the camera
 *     distance picks the DEFAULT lens — *detail* below the split (ONE focused
 *     subsystem, expanded readout from real systems via injected providers)
 *     vs *overview* at/above it (all callouts, compact). Crossing the split
 *     re-arms the distance default (any toggle override clears);
 *   - the Space verb 'lens-toggle' (00-spec.md §5): one key cycles
 *     overview → detail(sub₁) → detail(sub₂) → … → detail(subₙ) → overview,
 *     so the verb both toggles the lens AND switches the focused subsystem —
 *     exposed as lensToggle() for the serial track to wire.
 *
 * DESIGN (docs/ladder/03-plan.md, this is the PARALLEL track — NavcomFloor is
 * the template):
 *   - Every dependency is INJECTED and optional, so the module is unit-testable
 *     headless (no THREE, no DOM, no EventBus). The projector
 *     `(shipLocalU) -> {x,y,visible}` is passed in (the serial track composes
 *     player.localToWorld ∘ world→screen); anchors resolve through an optional
 *     `shipMeshSource.getAnchorLocalU(meshName)` adapter (live-mesh anchors,
 *     the MotherCallouts/TierVisualManager T1 pattern) with the static manifest
 *     offset as the designed fallback — never a hole, never a throw.
 *   - `providers[readout]()` feeds the detail lens live rows (power/thermal/…
 *     numbers); absent or throwing providers degrade to the static spec rows
 *     (MotherCallouts._liveRows best-effort precedent).
 *   - CLICK (Wave 4, 08-workbench D2): the constructor wires the overlay's
 *     setOnSelect sink into focusById (the ClusterIcons → NavcomFloor shape),
 *     so a card click focuses that subsystem; title clicks deep-link the Tech
 *     Library from inside BlueprintOverlay (CODEX_OPEN_ENTRY — the
 *     MotherCallouts grammar). codexId rides the render items.
 *   - It emits NO events itself. The legacy inspect side-effects (FOV narrow,
 *     dynamic near-plane, background dim, hull-overlay events, onboarding
 *     signal — CameraSystem._setInspectZoom, 02-traps.md T6) are SERIAL-track
 *     territory: they become the 3/4 down-hump's arrival effects and are
 *     specced in HANDOFF.md, deliberately NOT reimplemented here.
 *
 * LadderController drives this (HANDOFF spec): it activates the floor content
 * on arrival at floor 3, deactivates on leaving, and dispatches the
 * 'lens-toggle' verb decision to lensToggle(). main.js is the single ticker
 * (update({distM, project}) once per frame after cameraSystem.update — the
 * NavcomFloor precedent).
 *
 * @module systems/HullCamFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { BlueprintOverlay, CARD_ROW_BUDGET } from '../ui/BlueprintOverlay.js';
import { BLUEPRINT_SUBSYSTEMS, anchorLocalU } from '../data/blueprintSubsystems.js';

/** The F1 (HULL CAM) contract row — by id, never by index (Session H). */
const F3 = FloorContract.byId(1);

/** The two lens modes, straight from the contract (['detail', 'overview']). */
const [LENS_DETAIL, LENS_OVERVIEW] = F3.lens.modes;

export class HullCamFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.player]         - subject/ship ref (reserved for the
   *                 serial track's projector + daughter re-anchoring; unused
   *                 headless so tests need no stub)
   * @param {object} [deps.shipMeshSource] - OPTIONAL live-anchor adapter:
   *                 getAnchorLocalU(meshName) -> {x,y,z} ship-local scene units
   *                 (or null → static manifest fallback). The serial track
   *                 builds it from player.getObjectByName + worldToLocal.
   * @param {function} [deps.project]      - default projector (shipLocalU)->{x,y,visible}
   * @param {object} [deps.overlay]        - BlueprintOverlay instance (default: fresh)
   * @param {object} [deps.providers]      - detail-lens readout sources keyed by
   *                 the manifest `readout` ids ('power', 'thermal', 'comms',
   *                 'engineering', 'cargo'). Each is () => Array<string> row
   *                 lines (or a plain object → 'KEY: value' rows). Fake-able
   *                 in tests; absent/throwing → static spec rows only.
   */
  constructor(deps = {}) {
    this._player = deps.player || null;
    this._shipMeshSource = deps.shipMeshSource || null;
    this._project = deps.project || null;
    this._overlay = deps.overlay || new BlueprintOverlay();
    this._providers = deps.providers || null;

    // Card click → subsystem focus: the exact ClusterIcons →
    // NavcomFloor.focusById wiring shape (08-workbench §7). Title clicks
    // deep-link the codex inside the overlay itself (CODEX_OPEN_ENTRY, the
    // MotherCallouts grammar) — no wiring needed here. Changes nothing
    // headless and paints nothing extra.
    if (typeof this._overlay.setOnSelect === 'function') {
      this._overlay.setOnSelect((id) => this.focusById(id));
    }

    this._active = false;
    /** Priority-ranked manifest (the carousel + budget order — one law). */
    this._ranked = BlueprintOverlay.rank(BLUEPRINT_SUBSYSTEMS, BLUEPRINT_SUBSYSTEMS.length);
    this._focusId = this._ranked.length ? this._ranked[0].id : null;
    /** Distance-picked default lens. Arrival from above (entry z01 0.75 ≈ 7.9 m)
     *  is the common case, so the pre-first-sample default is overview. */
    this._lensDefault = LENS_OVERVIEW;
    /** Player toggle override; cleared whenever the distance default flips. */
    this._lensOverride = null;
  }

  /** The lens split boundary in metres (= FloorContract F3 lens.splitAtM). */
  static get SPLIT_M() { return F3.lens.splitAtM; }

  /**
   * The lens the camera distance picks by default: detail below the split,
   * overview at/above it (00-spec.md §3 F3). Pure + static.
   * @param {number} distM - camera→subject distance in metres
   * @returns {string} 'detail' | 'overview'
   */
  static lensDefaultForDistM(distM) {
    return (distM < F3.lens.splitAtM) ? LENS_DETAIL : LENS_OVERVIEW;
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** The view instance (for the serial track to mount / tests). */
  get overlay() { return this._overlay; }

  /** The effective lens: player override, else the distance default. */
  getLens() { return this._lensOverride || this._lensDefault; }

  /** @returns {object|null} the focused manifest subsystem. */
  getFocusedSubsystem() {
    return this._ranked.find((s) => s.id === this._focusId) || null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Enter F3: show the blueprint costume (state kept across re-entry). */
  activate() {
    if (this._active) return;
    this._active = true;
    if (this._overlay.show) this._overlay.show();
  }

  /** Leave F3: hide the costume. */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._overlay.hide) this._overlay.hide();
  }

  // ── Focus ──────────────────────────────────────────────────────────────────

  /** Focus a subsystem by id (click / re-aim). @returns {boolean} found */
  focusById(id) {
    if (!this._ranked.some((s) => s.id === id)) return false;
    this._focusId = id;
    return true;
  }

  /** Step focus through the ranked list (+1 / -1), clamped at the ends. */
  focusStep(dir) {
    if (this._ranked.length === 0) return;
    let i = this._ranked.findIndex((s) => s.id === this._focusId);
    if (i < 0) i = 0;
    i = Math.min(this._ranked.length - 1, Math.max(0, i + (dir < 0 ? -1 : 1)));
    this._focusId = this._ranked[i].id;
  }

  // ── The Space verb: lens-toggle ────────────────────────────────────────────

  /**
   * Dispatch the F3 Space verb (FloorContract.FLOORS[2].spaceVerb
   * 'lens-toggle'). One key cycles the whole inspection carousel:
   *   overview → detail(sub₁) → detail(sub₂) → … → detail(subₙ) → overview →…
   * so it toggles the lens (00-spec §3) AND switches the focused subsystem
   * within the detail lens. The override this sets is cleared whenever the
   * camera crosses the 5 m split (the distance re-picks the default).
   * @returns {{lens:string, focusId:*}} the post-toggle state
   */
  lensToggle() {
    if (this._ranked.length === 0) {
      return { lens: this.getLens(), focusId: null };
    }
    if (this.getLens() === LENS_OVERVIEW) {
      // Enter the detail carousel at its top (deterministic cycle).
      this._focusId = this._ranked[0].id;
      this._lensOverride = (this._lensDefault === LENS_DETAIL) ? null : LENS_DETAIL;
    } else {
      const i = this._ranked.findIndex((s) => s.id === this._focusId);
      if (i >= 0 && i < this._ranked.length - 1) {
        this._focusId = this._ranked[i + 1].id;      // next subsystem
      } else {
        // Wrapped past the last subsystem → back to the overview lens.
        this._focusId = this._ranked[0].id;
        this._lensOverride = (this._lensDefault === LENS_OVERVIEW) ? null : LENS_OVERVIEW;
      }
    }
    return { lens: this.getLens(), focusId: this._focusId };
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  /**
   * Render one frame of the F3 costume. No-op while inactive.
   * @param {object} [ctx]
   * @param {number} [ctx.distM]    - camera→subject distance in metres (drives
   *                 the lens default; non-finite → the last default holds)
   * @param {function} [ctx.project] - projector override for this frame
   * @param {number} [ctx.centerX]  - subject center screen x (rail-side split)
   * @returns {{lens:string, focusId:*, callouts:Array}|null} descriptors (tests)
   */
  update(ctx = {}) {
    if (!this._active) return null;
    this._noteDistance(ctx.distM);
    const lens = this.getLens();
    const project = ctx.project || this._project;

    // Overview: ALL callouts, compact. Detail: the ONE focused subsystem with
    // its expanded readout (00-spec §3 — the lens split's whole point).
    const source = (lens === LENS_DETAIL)
      ? this._ranked.filter((s) => s.id === this._focusId)
      : this._ranked;
    const items = source.map((sub) => ({
      id: sub.id,
      label: sub.label,
      priority: sub.priority,
      anchorU: this._anchorU(sub),
      focused: sub.id === this._focusId,
      rows: (lens === LENS_DETAIL) ? this._readoutRows(sub) : [],
      codexId: sub.codexId,       // title click → Tech Library deep-link (D2)
    }));

    const callouts = this._overlay.render(items, project, {
      lens,
      budget: F3.labelBudget,
      centerX: ctx.centerX,
    });
    return { lens, focusId: this._focusId, callouts };
  }

  /**
   * @private Track the distance-picked lens default. Crossing the 5 m split
   * flips the default AND clears any toggle override — "the camera distance
   * picks which one is the default" (00-spec §3). Non-finite samples (no
   * camera yet) leave the state untouched.
   */
  _noteDistance(distM) {
    if (!Number.isFinite(distM)) return;
    const def = HullCamFloor.lensDefaultForDistM(distM);
    if (def !== this._lensDefault) {
      this._lensDefault = def;
      this._lensOverride = null;
    }
  }

  /**
   * @private Resolve a subsystem's anchor in ship-local scene units: the live
   * mesh position via the optional shipMeshSource adapter when the manifest
   * names a mesh, else the static manifest offset (T1 fallback — silent by
   * design: the adapter is optional, headless is the fallback's home).
   */
  _anchorU(sub) {
    if (sub.mesh && this._shipMeshSource
      && typeof this._shipMeshSource.getAnchorLocalU === 'function') {
      const p = this._shipMeshSource.getAnchorLocalU(sub.mesh);
      if (p && Number.isFinite(p.x)) return p;
    }
    return anchorLocalU(sub);
  }

  /**
   * @private The focused card's rows: static spec first, then the injected
   * provider's live rows (real power/thermal/… numbers), sliced to the card
   * row budget. Best-effort — a missing or throwing provider degrades to the
   * static rows and never throws (MotherCallouts._liveRows precedent).
   */
  _readoutRows(sub) {
    const rows = [];
    if (Array.isArray(sub.spec)) rows.push(...sub.spec);
    const prov = this._providers && this._providers[sub.readout];
    if (typeof prov === 'function') {
      try {
        const live = prov();
        if (Array.isArray(live)) {
          for (const r of live) rows.push(String(r));
        } else if (live && typeof live === 'object') {
          for (const [k, v] of Object.entries(live)) rows.push(`${k}: ${v}`);
        }
      } catch (_e) { /* live data is best-effort; never throw from a card */ }
    }
    return rows.slice(0, CARD_ROW_BUDGET);
  }

  /** Tear down the owned view. */
  dispose() {
    if (this._overlay.dispose) this._overlay.dispose();
  }
}
