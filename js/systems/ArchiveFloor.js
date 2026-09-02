/**
 * ArchiveFloor.js — F1 (ARCHIVE) content bridge: the Tech Library IS the floor.
 *
 * The Zoom Ladder's innermost floor has no 3D camera at all (FloorContract F1:
 * anchor 'interior', fov/near/far null, timeCap 0 — TimeAuthority pauses the
 * world). Its costume is the existing CodexViewerUI ("Tech Library", I key):
 * arriving on F1 drops the player INTO the library, leaving closes it. This
 * module is the bridge — a floor controller on the NavcomFloor lifecycle
 * template that HOSTS the viewer rather than re-implementing it (00-spec §11
 * "bridge, don't merge").
 *
 * Hosted mode (CodexViewerUI.setHosted) is the Esc contract: while the viewer
 * is the F1 costume, every viewer self-close path (capture-phase ESC, backdrop
 * click, CLOSE button, I-key toggle) routes to `onRequestClose` — injected here
 * as the ladder's ride-one-floor-up — instead of a self-hide that would strand
 * an empty ARCHIVE floor and fight the ladder for ESC (00-spec §5: Esc rides up;
 * in-viewer modal-ish states like the narrow reading pane still cancel
 * themselves first, inside the viewer).
 *
 * Wiring (serial track, landed with this module):
 *   - LadderController activates on floor id 1 (F1's debrisMode 'hidden' is not
 *     unique — floor-keyed like F3), deactivates on every other floor and on
 *     disengage.
 *   - main.js constructs it with the codexViewerUI singleton and
 *     onExitUp = ladderController.command({ type: 'esc' }).
 *   - InputManager's codex full-keyboard intercept stands down while the viewer
 *     is HOSTED and the ladder is engaged, so PgUp/PgDn/I reach the ladder's
 *     own bindings.
 *
 * Deep link (Wave 4, 08-workbench D1/D2 — "the library is a tool that opens
 * FROM what you clicked"): the F3 workbench focus persists across floors, so
 * riding down to the library floor lands on THAT part's page. activate() takes
 * an optional `{ entryId }` (explicit deep link) and the constructor an optional
 * `getSubject` getter (main.js wires hullcamFloor.getFocusedSubsystem — the
 * focused manifest subsystem, whose `codexId` is the link). Order pinned:
 * host → show → openEntry — the viewer is hosted/visible before the entry
 * opens, so a re-entrant close during openEntry still routes through the host.
 * No entryId + no subject (or a subject without a codexId) ⇒ byte-identical to
 * the plain host + show.
 *
 * Every dep is optional/injected; absent deps make every method a byte-identical
 * no-op (parallel-track law). No DOM, no THREE, no clock — pure orchestration.
 */

export class ArchiveFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.codex]    - CodexViewerUI: setHosted(host|null)/show()/
   *   hide()/isVisible()/openEntry(id). Optional — absent it activate/deactivate
   *   are no-ops; openEntry is method-guarded (a viewer without it still hosts).
   * @param {Function} [deps.onExitUp] - the viewer's hosted close verb: ride one
   *   floor up (main.js injects `() => ladderController.command({ type: 'esc' })`).
   *   Optional — absent it hosted close requests are swallowed (the ladder's own
   *   ESC/PgUp bindings still work; nothing can strand the player).
   * @param {Function} [deps.getSubject] - zero-arg getter for the workbench
   *   subject: the F3 focused subsystem descriptor (`{ codexId, ... }`) or null.
   *   Its string `codexId` deep-links the arrival page. Optional — absent it (or
   *   returning null / no codexId) the arrival is the plain host + show.
   */
  constructor(deps = {}) {
    this._codex = deps.codex || null;
    this._onExitUp = deps.onExitUp || null;
    this._getSubject = deps.getSubject || null;
    this._active = false;
    // One stable host object (identity matters only for debugging; setHosted
    // replaces wholesale). Bound once so activate() allocates nothing.
    this._host = { onRequestClose: () => { if (this._onExitUp) this._onExitUp(); } };
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /**
   * F1 arrival: host the viewer (close paths become ride-up), then show it,
   * THEN deep-link the page. Order matters — hosting first means a pathological
   * synchronous close event during show() (or openEntry) already routes to the
   * ladder, never a self-hide.
   * @param {object} [opts]
   * @param {string} [opts.entryId] - explicit codex entry to open (wins over the
   *   getSubject subject). Absent ⇒ the subject's codexId, if any.
   */
  activate(opts) {
    if (this._active) return;
    this._active = true;
    if (!this._codex) return;
    if (this._codex.setHosted) this._codex.setHosted(this._host);
    if (this._codex.show) this._codex.show();
    const entryId = this._deepLinkId(opts);
    if (entryId && this._codex.openEntry) this._codex.openEntry(entryId);
  }

  /**
   * Leaving F1 / disengage: release hosted mode FIRST, then hide. Un-hosting
   * first makes the hide a plain free-standing hide — a re-entrant
   * onRequestClose during teardown (e.g. a queued click) can no longer bounce
   * into the ladder mid-deactivate.
   */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (!this._codex) return;
    if (this._codex.setHosted) this._codex.setHosted(null);
    if (this._codex.hide) this._codex.hide();
  }

  /**
   * Resolve the arrival deep link: an explicit string `opts.entryId` wins; else
   * the subject getter's `codexId` (string) — else null (plain arrival). The
   * getter is best-effort: a throwing subject source must never strand the F1
   * arrival (the HullCamFloor provider rule), so it resolves to "no link".
   * @param {object} [opts]
   * @returns {string|null}
   * @private
   */
  _deepLinkId(opts) {
    if (opts && typeof opts.entryId === 'string') return opts.entryId;
    if (!this._getSubject) return null;
    let subject = null;
    try { subject = this._getSubject(); } catch (_e) { subject = null; }
    return (subject && typeof subject.codexId === 'string') ? subject.codexId : null;
  }

  dispose() { this.deactivate(); }
}
