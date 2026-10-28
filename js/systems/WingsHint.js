/**
 * WingsHint.js — the "open the wings" hint that STAYS until the wings are out (owner 2026-10-17).
 *
 * A start (new game hand-over, CONTINUE, retry) leaves the wings rolled up and
 * the battery at half and falling (DECISIONS §15 row 4, §17 row 1). The comms
 * line says so once and scrolls away; this keeps ONE ticker row up until the
 * ship's wings are actually out. (Owner 2026-10-28: at a start the ship opens
 * on the player's first action of any kind, so a START arms the hint WITHOUT a
 * row: nothing shows at the start, on keys or on glass, until the wings have
 * been commanded out and rolled back up.)
 *
 *   • `post()` arms the hint and emits `HINT_POSTED { id:'wings_open', duration:0 }` (persistent: HintTicker only
 *     expires rows with duration > 0). A later start re-arms it.
 *   • `update(ship, ticker)` per frame reads the wing value (`_rosaFurlProgress`, 0..1) and command
 *     (`_rosaFurlTarget`, 0 or 1):
 *     - Out (progress >= WINGS_OUT_PROGRESS): ONE `HINT_SATISFIED`, disarmed for good.
 *     - Commanded out, still rolling (~2.5 s; the comma key TOGGLES, so a "press ," row would invite a press that
 *       rolls them back): row taken down (one `HINT_SATISFIED`), hint stays armed.
 *     - Commanded rolled up (also rolled back mid-way): row up. If the ticker no longer holds it (it keeps 4 rows,
 *       drops the oldest, and this row is posted first) it is posted again. That re-post is what makes it stay;
 *       there are no blind periodic re-emits, and an unchanged frame emits nothing.
 *   • `areOut()` / `needsOpening()` are what SensorSystem reads to word a refused scan; both `null` until a frame
 *     has seen a ship.
 *   • `reset()` takes the row down too, so a menu round-trip leaves no stale row.
 *
 * A roll-up in mid-flight does not re-arm the hint; only a start or a battery-refused scan does.
 *
 * @module systems/WingsHint
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export const WINGS_HINT_ID = 'wings_open';

/** Wing progress (0..1) at or above which the wings count as out. */
export const WINGS_OUT_PROGRESS = 0.98;

// ASCII body (u2-one-voice D2): the cap carries the key, the body says what it does. On touch the row is the
// OPEN THE WINGS button instead (HintTicker step button, `press: 'Comma'`).
export const WINGS_HINT_TEXT = 'Open the wings (comma key)';

export const WINGS_HINT_BUTTON = 'OPEN THE WINGS';

export class WingsHint {
  constructor(bus = eventBus) {
    this._bus = bus;
    this._armed = false;
    /** @type {boolean|null} */
    this._out = null;
    /** wings commanded rolled up (target < 0.5); null until a ship is seen */
    this._needsOpening = null;
    /** We posted the row and have not taken it down (when there is no ticker to ask). */
    this._rowUp = false;
    /** A START armed the hint silently: no row until the wings are commanded out. */
    this._startQuiet = false;
  }

  /**
   * Arm the hint and put the row up (a duplicate id is ignored by the ticker).
   * @param {{ start?: boolean }} [opts] - `start: true` from a START (OpeningDance):
   *   arms the hint silently (no row) until the wings are commanded out; a plain
   *   `post()` (Director hold, refused scan) never clears that
   */
  post(opts) {
    this._armed = true;
    if (opts && opts.start === true) this._startQuiet = true;
    this._emitPost();
  }

  /** Per frame; no work unless armed. `ticker` is the HUD's HintTicker (`getItemIds()`); absent = go by what we posted. */
  update(ship, ticker) {
    if (!ship) return;
    const p = ship._rosaFurlProgress;
    if (typeof p !== 'number' || p !== p) return;
    let t = ship._rosaFurlTarget;
    if (typeof t !== 'number' || t !== t) t = 0;
    const out = p >= WINGS_OUT_PROGRESS;
    this._out = out;
    this._needsOpening = t < 0.5;
    if (!this._armed) return;
    if (out) {
      this._armed = false;
      this._rowUp = false;
      this._startQuiet = false;
      this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
      return;
    }
    const hasList = !!ticker && typeof ticker.getItemIds === 'function';
    const rowUp = hasList ? ticker.getItemIds().indexOf(WINGS_HINT_ID) >= 0 : this._rowUp;
    if (t >= 0.5) {
      // Commanded out, still rolling: the row comes down, the hint stays armed.
      this._startQuiet = false;   // the opening (or the player) has the wings: a later post is the comma key again
      if (rowUp) {
        this._rowUp = false;
        this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
      }
    } else if (!rowUp) {
      this._emitPost();
    }
  }

  /** true/false once a frame has seen the wings; null before (tests, menu hero): callers treat null as "unknown". */
  areOut() { return this._out; }

  /** true when the wings are commanded rolled up; false when commanded out; null before a frame has seen the ship. */
  needsOpening() { return this._needsOpening; }

  /** Take the row down, disarm, forget the ship. The ticker ignores an unknown id, so this is safe with no row up. */
  reset() {
    this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
    this._armed = false;
    this._out = null;
    this._needsOpening = null;
    this._rowUp = false;
    this._startQuiet = false;
  }

  _emitPost() {
    if (this._startQuiet) return;   // armed at a start: no row, `_rowUp` stays false
    this._rowUp = true;
    this._bus.emit(Events.HINT_POSTED, {
      id: WINGS_HINT_ID,
      text: WINGS_HINT_TEXT,
      glyph: ',',
      keys: ['Comma'],
      duration: 0,
      priority: 'normal',
      step: true,
      press: 'Comma',
      button: WINGS_HINT_BUTTON,
    });
  }
}

/** Shared instance: OpeningDance posts it, SensorSystem reads it, the game loop updates it. */
export const wingsHint = new WingsHint(eventBus);
if (Events.GAME_RESET) eventBus.on(Events.GAME_RESET, () => wingsHint.reset());
