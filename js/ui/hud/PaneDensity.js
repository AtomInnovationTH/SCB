/**
 * PaneDensity.js — the HUD pane-priority "density ladder".
 *
 * The bare `-` / `+` keys walk an ordered ladder of HUD panes, hiding the
 * lowest-priority visible pane on `-` and restoring the highest-priority hidden
 * pane on `+`. Repeated `-` presses strip the HUD down to pure space scenery
 * (warnings and all other chrome included — a deliberate design decision:
 * critical events in pure scenery stay pure, audio-only, no visual breakthrough).
 * One `+` restores in reverse.
 *
 * Design — NO COUNTER. The ladder holds no hidden-count state of its own; each
 * step reads the LIVE visibility of every rung via its injected `isVisible()`
 * adapter and acts on it:
 *   • `-` hides the lowest-priority (earliest) rung whose `isVisible()` is true.
 *   • `+` shows the highest-priority (latest) rung whose `isVisible()` is false.
 * This composes naturally with the individual pane toggles (7/8/9/0): if the
 * player re-shows a pane with its own key, the next `-`/`+` simply re-reads the
 * new live state and targets the right rung. NavSphere "starts hidden" falls out
 * for free — its `isVisible()` is already false, so `-` skips it.
 *
 * The rung adapters are INJECTED (not hard-wired) so this module is pure and
 * Node-testable: the DOM / canvas plumbing lives in HUD.js.
 *
 * @module ui/hud/PaneDensity
 */

/**
 * @typedef {Object} DensityRung
 * @property {string}  id                 Stable rung id (for tests / debugging).
 * @property {string}  label              Human label used in the feedback line.
 * @property {() => boolean} isVisible     Live "is this pane on screen right now?"
 * @property {(v: boolean) => void} setVisible  Show (true) / hide (false) the pane.
 */

export class PaneDensity {
  /**
   * @param {Object} opts
   * @param {DensityRung[]} opts.rungs  Ordered lowest-priority → highest-priority
   *   (index 0 is hidden FIRST by `-`, restored LAST by `+`).
   * @param {(text: string) => void} [opts.notify]  Transient on-screen notice.
   * @param {(text: string) => void} [opts.log]     Reactive comms-history line.
   */
  constructor({ rungs, notify, log } = {}) {
    /** @type {DensityRung[]} */
    this.rungs = Array.isArray(rungs) ? rungs.slice() : [];
    this._notify = typeof notify === 'function' ? notify : () => {};
    this._log = typeof log === 'function' ? log : () => {};
    /** @private true while setLevel() walks — per-step notices are silenced. */
    this._silent = false;
  }

  /** Total rung count — the touch slider's max (iPad port, Ipad.md §5.1). */
  get total() { return this.rungs.length; }

  /**
   * Live count of visible rungs. The slider's position source of truth — read
   * fresh every time (no counter), so it composes with the individual pane
   * toggles exactly like `-`/`+` do.
   * @returns {number}
   */
  visibleCount() {
    return this.rungs.reduce((n, r) => n + (this._safeVisible(r) ? 1 : 0), 0);
  }

  /**
   * Touch-slider entry (iPad port): walk the ladder until exactly `level`
   * rungs are visible. Each step is a real down()/up() that re-reads live
   * visibility, so out-of-band pane toggles compose. Per-step notices are
   * silenced; ONE summary notice/log fires if anything changed — unless
   * `quiet` is set (a live drag emits per-detent input events; the caller
   * then announces ONCE on release via announceLevel()).
   *
   * Bounded: stops when a step reports no rung OR when a step fails to change
   * the live count (a refusing/broken adapter must never loop forever).
   *
   * @param {number} level  target visible-rung count (clamped to 0..total)
   * @param {{quiet?: boolean}} [opts]
   * @returns {number} steps actually performed
   */
  setLevel(level, { quiet = false } = {}) {
    const target = Math.max(0, Math.min(this.rungs.length, Math.round(Number(level) || 0)));
    let cur = this.visibleCount();
    let steps = 0;
    this._silent = true;
    try {
      while (cur !== target) {
        const stepped = cur > target ? this.down() : this.up();
        if (!stepped) break;                     // ladder end / nothing to act on
        const next = this.visibleCount();
        if (next === cur) break;                 // adapter refused — no progress
        cur = next;
        steps++;
      }
    } finally {
      this._silent = false;
    }
    if (steps > 0 && !quiet) this.announceLevel();
    return steps;
  }

  /**
   * Emit the level summary (notice + comms log) from LIVE state. setLevel()
   * calls this itself unless quiet; a dragging slider calls it once on
   * release so an 11-detent slide is one line, not eleven.
   */
  announceLevel() {
    const cur = this.visibleCount();
    const text = cur === 0
      ? 'HUD clear — pure scenery · slide right to restore'
      : `HUD panes · ${cur}/${this.rungs.length} visible`;
    this._notify(text);
    this._log(text);
  }

  /**
   * `-` — hide the lowest-priority currently-visible rung. No-op (with a
   * notice) when the HUD is already pure scenery.
   * @returns {DensityRung|null} the rung hidden, or null on a no-op.
   */
  down() {
    const rung = this.rungs.find(r => this._safeVisible(r));
    if (!rung) {
      // Everything is already hidden — remind the player how to get it back.
      if (!this._silent) this._notify('HUD already clear · + restores');
      return null;
    }
    rung.setVisible(false);
    const pure = this.rungs.every(r => !this._safeVisible(r));
    const text = pure
      ? 'HUD clear — pure scenery · + restores'
      : `HUD − · ${rung.label} hidden · + restores`;
    if (!this._silent) {
      this._notify(text);
      this._log(text);
    }
    return rung;
  }

  /**
   * `+` — restore the highest-priority currently-hidden rung. No-op (with a
   * notice) when every pane is already visible.
   * @returns {DensityRung|null} the rung shown, or null on a no-op.
   */
  up() {
    // Scan from the highest-priority (last) rung down so `+` reverses `-`.
    let rung = null;
    for (let i = this.rungs.length - 1; i >= 0; i--) {
      if (!this._safeVisible(this.rungs[i])) { rung = this.rungs[i]; break; }
    }
    if (!rung) {
      if (!this._silent) this._notify('All panes visible');
      return null;
    }
    rung.setVisible(true);
    const all = this.rungs.every(r => this._safeVisible(r));
    const text = all ? 'All panes visible' : `HUD + · ${rung.label} shown`;
    if (!this._silent) {
      this._notify(text);
      this._log(text);
    }
    return rung;
  }

  /**
   * Wire the ladder to the event bus. Kept out of the constructor so tests can
   * drive `down()` / `up()` directly without an event bus.
   * @param {{on: Function}} bus
   * @param {{HUD_DENSITY_DOWN: string, HUD_DENSITY_UP: string}} events
   */
  attach(bus, events) {
    if (!bus || !events) return;
    bus.on(events.HUD_DENSITY_DOWN, () => this.down());
    bus.on(events.HUD_DENSITY_UP, () => this.up());
  }

  /** @private Defensive isVisible() — a throwing/absent adapter reads as hidden. */
  _safeVisible(rung) {
    try { return !!(rung && rung.isVisible()); } catch (_) { return false; }
  }
}

export default PaneDensity;
