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
 * Every dep is optional/injected; absent deps make every method a byte-identical
 * no-op (parallel-track law). No DOM, no THREE, no clock — pure orchestration.
 */

export class ArchiveFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.codex]    - CodexViewerUI: setHosted(host|null)/show()/
   *   hide()/isVisible(). Optional — absent it activate/deactivate are no-ops.
   * @param {Function} [deps.onExitUp] - the viewer's hosted close verb: ride one
   *   floor up (main.js injects `() => ladderController.command({ type: 'esc' })`).
   *   Optional — absent it hosted close requests are swallowed (the ladder's own
   *   ESC/PgUp bindings still work; nothing can strand the player).
   */
  constructor(deps = {}) {
    this._codex = deps.codex || null;
    this._onExitUp = deps.onExitUp || null;
    this._active = false;
    // One stable host object (identity matters only for debugging; setHosted
    // replaces wholesale). Bound once so activate() allocates nothing.
    this._host = { onRequestClose: () => { if (this._onExitUp) this._onExitUp(); } };
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /**
   * F1 arrival: host the viewer (close paths become ride-up), then show it.
   * Order matters — hosting first means a pathological synchronous close event
   * during show() already routes to the ladder, never a self-hide.
   */
  activate() {
    if (this._active) return;
    this._active = true;
    if (!this._codex) return;
    if (this._codex.setHosted) this._codex.setHosted(this._host);
    if (this._codex.show) this._codex.show();
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

  dispose() { this.deactivate(); }
}
