/**
 * MissionGasTally - "this mission's" engine gas, for the range map's second gas line (range-map lane, D4; owner 2026-10-25 "keep it real":
 * only catches with leftover gas add range, and the map shows what the catches gave so the link is visible but small).
 *
 * Two numbers in kilograms since the last mark: `gainedKg` (what salvage loaded: `ResourceSystem.salvageGasKg`) and `usedKg` (what her own
 * moves drew from the engine pool: `ResourceSystem.xenonDrawnKg`: the autopilot's approach and hold, recoil, dodges, steering). A trip's burn is
 * NOT counted: it is the choice the map shows (the list prices it), not the mission's cost. The tally reads the cumulative counters each frame
 * and keeps its own baseline, so a counter that drops (ResourceSystem.reset() / restore() on a new game or a continue) never makes a number
 * negative: the drop is a rebase.
 *
 * Marks: a where-next pick (the mission is over, including "Stay here"), a new game, a continue. `undo()` puts back what the last mark cleared (a refused
 * pick re-opens the list).
 *
 * @module systems/MissionGasTally
 */

const finite = (v) => (Number.isFinite(v) ? v : null);

export class MissionGasTally {
  /**
   * @param {object} [deps]
   * @param {function} [deps.counters]  () => {xenonDrawnKg, salvageGasKg} (the ResourceSystem); null / missing = both stay 0
   * @param {function} [deps.isBurning] () => boolean: true while a trip burns (TransferTrip's `isTripBurning`)
   */
  constructor(deps = {}) {
    this._counters = typeof deps.counters === 'function' ? deps.counters : () => null;
    this._burning = typeof deps.isBurning === 'function' ? deps.isBurning : () => false;
    this._used = 0;
    this._gained = 0;
    this._prev = null;
    this._lastDrawn = null;
    this._lastSalvage = null;
    this._wasBurning = false;     // a trip burned on the previous look (F1.5: its last chunk is billed on the very frame it ends)
  }

  /** Kilograms her own moves drew since the mark (a trip's burn excluded). */
  get usedKg() { return this._used; }
  /** Kilograms salvage loaded since the mark. */
  get gainedKg() { return this._gained; }

  /** @private @returns {{drawn: number, salvage: number}|null} */
  _read() {
    let c = null;
    try { c = this._counters(); } catch (_e) { c = null; }
    if (!c) return null;
    const drawn = finite(c.xenonDrawnKg);
    const salvage = finite(c.salvageGasKg);
    return drawn === null || salvage === null ? null : { drawn, salvage };
  }

  /** A new mission: both numbers start at 0 from the counters as they are now. */
  mark() {
    this._prev = { used: this._used, gained: this._gained };
    this._used = 0;
    this._gained = 0;
    const c = this._read();
    this._lastDrawn = c ? c.drawn : null;
    this._lastSalvage = c ? c.salvage : null;
  }

  /** The last mark was a refused pick: the numbers it cleared come back (nothing else changed in between). */
  undo() {
    if (!this._prev) return;
    this._used += this._prev.used;
    this._gained += this._prev.gained;
    this._prev = null;
  }

  /**
   * Once per frame: take what the counters moved since the last look. A draw counts as her own move only if no trip burned on this frame or the
   * previous one: `TransferTrip._end` bills the trip's last chunk and clears `isTripBurning()` in the same frame, so the frame after a burn still
   * carries burn gas (F1.5; the first frame of a burn is covered by the flag already being set when the trip bills).
   */
  update() {
    const burning = !!this._burning();
    const burned = burning || this._wasBurning;
    this._wasBurning = burning;
    const c = this._read();
    if (!c) return;
    if (this._lastDrawn === null || this._lastSalvage === null) { this._lastDrawn = c.drawn; this._lastSalvage = c.salvage; return; }
    const dDrawn = Math.max(0, c.drawn - this._lastDrawn);        // a counter that dropped was reset: rebase, add nothing
    const dSalvage = Math.max(0, c.salvage - this._lastSalvage);
    this._lastDrawn = c.drawn;
    this._lastSalvage = c.salvage;
    if (dSalvage > 0) this._gained += dSalvage;
    if (dDrawn > 0 && !burned) this._used += dDrawn;
  }
}

/**
 * Wire a tally to the events that end or begin a mission (main.js, next to the range map): a where-next pick clears it (`WHERE_NEXT {open: false}`,
 * "Stay here" included), a refused pick that puts the list back (`{open: true, again: true}`) restores it, and a new game, a retry or a continue clear it.
 * @param {MissionGasTally} tally
 * @param {{on: function}} bus the event bus
 * @param {object} Events the Events table
 * @returns {function} unsubscribe all
 */
export function bindMissionGasTally(tally, bus, Events) {
  const offs = [
    bus.on(Events.WHERE_NEXT, (d) => {
      if (!d) return;
      if (d.open === false) tally.mark();
      else if (d.open === true && d.again) tally.undo();
    }),
    ...[Events.MENU_START, Events.MENU_CONTINUE, Events.GAME_RESET, Events.GAMEOVER_CONTINUE].map((e) => bus.on(e, () => tally.mark())),
  ];
  return () => { for (const off of offs) if (typeof off === 'function') off(); };
}
