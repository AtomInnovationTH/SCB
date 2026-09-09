/**
 * PaneDensity.js — the HUD pane-priority "density ladder" (rev 3).
 *
 * ONE ordered array (`this.rungs`). Slider level k shows the last k rungs:
 * index 0 sheds first on `-`, the right end is full clutter. 15 rungs →
 * 16 detents (level 0 = empty view: no HUD, no sky labels, no city names, no
 * ships). Plan: tmp/plans/1788867799156-hud-pane-ladder-reorder.md
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
 * Composite rungs (`compositeRung`, `members`): isVisible = ANY member;
 * setVisible(v) fans out to every member; onFlip fires ONCE with the
 * composite's id (never per member) on every path (down / up / setLevel /
 * clearAll / restore). Members are ordinary rungs and may be missing from the
 * top-level ladder — FloorMask addresses them by their own ids. A composite
 * with zero members reads not-visible; setVisible is a no-op. `addMember`
 * appends (main.js drops the Override gag into `experimental` at the ladder
 * gate).
 *
 * World rungs (`world: true` — sky labels, ships, city pills) are scene
 * objects, not HUD chrome. `hudClear()` is true iff every non-world rung is
 * currently hidden (slider level 2 of the final ladder: only `citypills` +
 * `craft`; level 3 with `reticles` visible is false; level 0 is true).
 *
 * The ladder is ONE array, edited in place by the hub before the FloorMask
 * caches it: `insertBefore(anchorId, rung)` splices an instrument ahead of a
 * named rung (throws on an unknown anchor — a silent append would renumber
 * the slider), `find(id)` looks a rung up top-level AND inside composites.
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
 * @property {boolean} [world]            Scene/world rung — does NOT count as
 *   HUD chrome (`hudClear()` ignores it).
 * @property {DensityRung[]} [members]    Composite members (absent on a leaf).
 * @property {(rung: DensityRung) => void} [addMember]  Append a member
 *   (composites only; used by main.js for the Override gag).
 */

/**
 * Composite rung — one ladder slot that fans out to several member rungs.
 * isVisible = ANY member visible; setVisible(v) writes every member; addMember
 * appends (main.js uses this at the ladder gate to drop the Override gag into
 * `experimental`). Members are ordinary rungs and may themselves be missing
 * from the top-level ladder. A composite with zero members reads not-visible
 * and setVisible is a no-op. PaneDensity.onFlip fires the composite's id once,
 * never per member (ladder reorder rev 3,
 * tmp/plans/1788867799156-hud-pane-ladder-reorder.md).
 *
 * @param {string} id
 * @param {string} label
 * @param {DensityRung[]} [members]
 * @returns {DensityRung}
 */
export function compositeRung(id, label, members) {
  return {
    id,
    label,
    members: Array.isArray(members) ? members.slice() : [],
    isVisible() {
      const list = this.members || [];
      return list.some((m) => {
        try { return !!(m && m.isVisible()); } catch (_e) { return false; }
      });
    },
    setVisible(v) {
      const list = this.members || [];
      for (const m of list) {
        try { if (m && m.setVisible) m.setVisible(!!v); } catch (_e) { /* member refused */ }
      }
    },
    addMember(rung) {
      if (!rung) return;
      if (!Array.isArray(this.members)) this.members = [];
      this.members.push(rung);
    },
  };
}

export class PaneDensity {
  /**
   * @param {Object} opts
   * @param {DensityRung[]} opts.rungs  Ordered lowest-priority → highest-priority
   *   (index 0 is hidden FIRST by `-`, restored LAST by `+`).
   * @param {(text: string, kind: string) => void} [opts.notify]  Transient on-screen notice.
   *   Kind: 'confirm' = per-step/readout lines (the engaged policy drops them);
   *   'prompt' = the pure-scenery reminder ("HUD already clear · + restores"),
   *   the exit affordance (must always show — Session O, plan D12).
   * @param {(text: string) => void} [opts.log]     Reactive comms-history line.
   * @param {(paneId: string, shown: boolean) => void} [opts.onFlip]  Fired once
   *   per FLIPPED rung, AFTER its setVisible ran (Wave 5 Session H, Job A —
   *   the D5 room-memory write trigger). Injected like notify/log so this
   *   module stays pure/EventBus-free; HUD.js wires it to the ONE
   *   HUD_PANE_VISIBILITY emit. No-op presses (down() with nothing visible,
   *   up() with nothing hidden) never fire it; setLevel() fires it once per
   *   rung it actually flips (`_silent` silences notices, never this edge).
   */
  constructor({ rungs, notify, log, onFlip } = {}) {
    /** @type {DensityRung[]} */
    this.rungs = Array.isArray(rungs) ? rungs.slice() : [];
    this._notify = typeof notify === 'function' ? notify : () => {};
    this._log = typeof log === 'function' ? log : () => {};
    this._onFlip = typeof onFlip === 'function' ? onFlip : null;
    /** @private true while setLevel() walks — per-step notices are silenced. */
    this._silent = false;
    /**
     * CLEAN VIEW (owner, 2026-09-06; Zoom Ladder only — main.js flips this
     * inside the LADDER gate, so a `?ladder=0` boot keeps the shipped
     * one-rung `-`/`+`): while true the bus `-` CLEARS every pane in one
     * press (clearAll) and the bus `+` from a cleared screen RESTORES the
     * room that was showing (restore) — one press each way. Default false.
     * CLEAN VIEW IS A MODE, NOT A ROOM EDIT: while the stash is held the
     * hub's flip listener skips the D5 room capture (hasStash() is the
     * signal), FloorMask skips its departing-floor capture, so a reload or
     * the next floor brings the room back exactly as it was before `-`.
     * @type {boolean}
     */
    this.clearOnDown = false;
    /** @private the rung ids a clearAll() hid — what `+` brings back; null = none */
    this._stash = null;
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
   * True iff every non-world rung is currently hidden. World rungs (sky
   * labels, ships, city pills) are scene objects — they do not count as HUD
   * chrome. Slider level 2 of the final ladder (only `citypills` + `craft`,
   * both world) is true; level 3 (`reticles` visible) is false; level 0 is
   * true. Reads live via `_safeVisible`; does not recurse into members — a
   * visible composite (no `world` flag) is HUD chrome even if its only
   * showing member is a world leaf.
   * @returns {boolean}
   */
  hudClear() {
    return this.rungs.every((r) => !r || r.world === true || !this._safeVisible(r));
  }

  /**
   * Splice `rung` into `this.rungs` immediately before the top-level rung
   * whose id is `anchorId`. Returns the inserted index. Throws if the
   * anchor is unknown (main.js calls `insertBefore('debris', cargo)` etc.
   * before `new FloorMask(...)` — `_resolve` caches once).
   * @param {string} anchorId
   * @param {DensityRung} rung
   * @returns {number}
   */
  insertBefore(anchorId, rung) {
    const i = this.rungs.findIndex((r) => r && r.id === anchorId);
    if (i < 0) throw new Error(`PaneDensity.insertBefore: unknown anchor '${anchorId}'`);
    this.rungs.splice(i, 0, rung);
    return i;
  }

  /**
   * Rung by id, searching top-level AND composite members recursively.
   * @param {string} id
   * @returns {DensityRung|null}
   */
  find(id) {
    const walk = (list) => {
      if (!Array.isArray(list)) return null;
      for (const r of list) {
        if (!r) continue;
        if (r.id === id) return r;
        const nested = walk(r.members);
        if (nested) return nested;
      }
      return null;
    };
    return walk(this.rungs);
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
    this._notify(text, 'confirm');
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
      if (!this._silent) this._notify('HUD already clear · + restores', 'prompt');
      return null;
    }
    rung.setVisible(false);
    if (this._onFlip) this._onFlip(rung.id, false);   // AFTER the bit flip (Job A)
    const pure = this.rungs.every(r => !this._safeVisible(r));
    const text = pure
      ? 'HUD clear — pure scenery · + restores'
      : `HUD − · ${rung.label} hidden · + restores`;
    if (!this._silent) {
      this._notify(text, 'confirm');
      this._log(text);
    }
    return rung;
  }

  /**
   * `+` — restore the highest-priority currently-hidden rung. No-op (with a
   * notice) when every pane is already visible.
   *
   * SAFETY OVERRIDE witness (owner 2026-09-07): a rung whose pane CANNOT show
   * right now — NEXT with no room (`data-next-mode="hidden"`), an empty pin
   * widget, an absent `.skills-pane` — reads not-visible after its bit is
   * cleared, so the old scan re-picked it on every press ("HUD + · Next shown"
   * with nothing appearing) and every rung below it was unreachable. The scan
   * now clears such a rung's bit (it appears when its content arrives) and
   * keeps walking down until a pane actually shows; the notice names THAT rung,
   * or reads "All panes visible" when nothing more can show.
   * @returns {DensityRung|null} the rung shown (or the last bit cleared), or null on a no-op.
   */
  up() {
    // Scan from the highest-priority (last) rung down so `+` reverses `-`.
    let shown = null;      // the rung that actually became visible
    let flipped = null;    // the last rung whose bit was cleared
    for (let i = this.rungs.length - 1; i >= 0; i--) {
      const rung = this.rungs[i];
      if (this._safeVisible(rung)) continue;
      rung.setVisible(true);
      if (this._onFlip) this._onFlip(rung.id, true);    // AFTER the bit flip (Job A)
      flipped = rung;
      if (this._safeVisible(rung)) { shown = rung; break; }
      // Content/dodge-hidden: bit cleared, nothing to see yet — keep walking.
    }
    if (!flipped) {
      if (!this._silent) this._notify('All panes visible', 'confirm');
      return null;
    }
    const all = this.rungs.every(r => this._safeVisible(r));
    const text = (all || !shown) ? 'All panes visible' : `HUD + · ${shown.label} shown`;
    if (!this._silent) {
      this._notify(text, 'confirm');
      this._log(text);
    }
    return shown || flipped;
  }

  /**
   * Wire the ladder to the event bus. Kept out of the constructor so tests can
   * drive `down()` / `up()` directly without an event bus. The routing reads
   * `clearOnDown` LIVE at press time (main.js sets it after attach, inside the
   * LADDER gate): false → the shipped one-rung walk; true → the clean view.
   * @param {{on: Function}} bus
   * @param {{HUD_DENSITY_DOWN: string, HUD_DENSITY_UP: string}} events
   */
  attach(bus, events) {
    if (!bus || !events) return;
    bus.on(events.HUD_DENSITY_DOWN, () => (this.clearOnDown ? this.clearAll() : this.down()));
    bus.on(events.HUD_DENSITY_UP, () => ((this.clearOnDown && this._stash && this.visibleCount() === 0)
      ? this.restore() : this.up()));
  }

  /**
   * CLEAN VIEW `-` — hide EVERY visible rung in one press and remember which
   * they were (the stash `+` restores). Each hide is a real down() step (the
   * onFlip edge fires per rung → the D5 room memory records the clean room,
   * exactly as eight `-` presses would). Already clear → the shipped no-op
   * notice, and the previous stash is KEPT (a second `-` must not forget the
   * room). ONE notice.
   * @returns {number} rungs hidden
   */
  clearAll() {
    const shown = this.rungs.filter((r) => this._safeVisible(r)).map((r) => r.id);
    if (!shown.length) {
      this._notify('HUD already clear · + restores', 'prompt');
      return 0;
    }
    // The stash is set BEFORE the walk: the hub's flip listener reads
    // hasStash() to know these flips are the clean-view MODE (not remembered
    // — the room memory keeps the pre-clear room; owner 2026-09-06). A walk
    // that moved nothing (every adapter refused) leaves no stash behind.
    const prev = this._stash;
    this._stash = shown;
    const steps = this.setLevel(0, { quiet: true });
    if (steps === 0) this._stash = prev;
    const text = 'HUD clear — pure scenery · + restores';
    this._notify(text, 'confirm');
    this._log(text);
    return steps;
  }

  /**
   * CLEAN VIEW `+` — bring back the stashed room: every stashed rung that is
   * still hidden is shown (onFlip per rung), the stash is consumed, ONE
   * summary notice. Rungs the player re-showed by hand meanwhile are left
   * alone; a stashed id that no longer exists is skipped. No stash → 0 and
   * nothing happens (attach() falls through to the shipped up() instead).
   * @returns {number} rungs shown
   */
  restore() {
    const stash = this._stash;
    if (!stash || !stash.length) { this._stash = null; return 0; }
    let shown = 0;
    // Flips run WHILE the stash is set (still the mode → not remembered: the
    // room memory already holds this very room); the stash clears after.
    for (const id of stash) {
      const rung = this.rungs.find((r) => r && r.id === id);
      if (!rung || this._safeVisible(rung)) continue;
      rung.setVisible(true);
      if (this._onFlip) this._onFlip(rung.id, true);
      shown++;
    }
    this._stash = null;
    if (shown > 0) this.announceLevel();
    return shown;
  }

  /**
   * Forget the stash (the hub calls this on a FLOOR CHANGE: a room stashed on
   * floor 2 must never be restored onto floor 4 — the new floor's own room
   * applies and `+` walks the shipped ladder there).
   */
  dropStash() { this._stash = null; }

  /** @returns {boolean} true while a clearAll() stash is waiting for `+` */
  hasStash() { return !!(this._stash && this._stash.length); }

  /** @private Defensive isVisible() — a throwing/absent adapter reads as hidden. */
  _safeVisible(rung) {
    try { return !!(rung && rung.isVisible()); } catch (_) { return false; }
  }
}

export default PaneDensity;
