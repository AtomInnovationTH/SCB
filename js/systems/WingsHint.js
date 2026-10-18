/**
 * WingsHint.js — the "open the wings" hint that STAYS until the wings are out
 * (m1-finish, owner 2026-10-17: new players lost the battery with nothing on
 * screen telling them how to stop it).
 *
 * A start (new game hand-over, CONTINUE, retry) leaves the wings rolled up and
 * the battery at half and falling (DECISIONS §15 row 4, §17 row 1). The comms
 * line says so once and scrolls away; this keeps ONE ticker row up until the
 * ship's wings are actually out.
 *
 *   • `post()` arms the hint and emits `HINT_POSTED { id:'wings_open',
 *     duration:0 }` (persistent: HintTicker only expires rows with a duration
 *     above 0). A later start re-arms it.
 *   • `update(ship, ticker)` once per frame, reading the wing value
 *     (`_rosaFurlProgress`) and the wing command (`_rosaFurlTarget`, 0 or 1).
 *     - Wings out (progress >= WINGS_OUT_PROGRESS): ONE `HINT_SATISFIED`,
 *       disarmed for good.
 *     - Commanded out but still rolling (the roll-out takes about 2.5 s and the
 *       comma key TOGGLES, so a row saying "press ," would invite a press that
 *       rolls them back): the row is taken down (one `HINT_SATISFIED`), the hint
 *       stays armed.
 *     - Commanded rolled up (also: rolled back mid-way): the row is up. If the
 *       ticker no longer holds it (it keeps only 4 rows and drops the oldest,
 *       and this row is posted first) it is posted again. That re-post is what
 *       makes it stay; there are no blind periodic re-emits, and a frame where
 *       nothing changed emits nothing.
 *   • `areOut()` / `needsOpening()` are what SensorSystem reads to word a
 *     refused scan. `needsOpening()` is true when the wings are commanded rolled
 *     up; both are `null` until a frame has seen a ship.
 *   • `reset()` takes the row down too, so a menu round-trip leaves no stale row.
 *
 * Not at the key press and not half-way: the wing value is the ship's single
 * `_rosaFurlProgress` (0..1). A roll-up in mid-flight does not re-arm the hint;
 * only a start or a battery-refused scan does.
 *
 * @module systems/WingsHint
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/** The ticker row id. */
export const WINGS_HINT_ID = 'wings_open';

/** Wing progress (0..1) at or above which the wings count as out. */
export const WINGS_OUT_PROGRESS = 0.98;

/**
 * The row's body (ASCII, u2-one-voice D2): the cap carries the key (`,`), the
 * body says what it does, the key once. On touch the row is the OPEN THE WINGS
 * button instead (HintTicker step button, `press: 'Comma'`).
 */
export const WINGS_HINT_TEXT = 'Open the wings (comma key)';

/** The touch button's label (HintTicker renders the row as this button on glass). */
export const WINGS_HINT_BUTTON = 'OPEN THE WINGS';

export class WingsHint {
  /** @param {{ on: Function, emit: Function }} [bus] */
  constructor(bus = eventBus) {
    this._bus = bus;
    this._armed = false;
    /** @type {boolean|null} */
    this._out = null;
    /** @type {boolean|null} wings commanded rolled up (target < 0.5); null until a ship is seen */
    this._needsOpening = null;
    /** We posted the row and have not taken it down (used when there is no ticker to ask). */
    this._rowUp = false;
  }

  /** Arm the hint and put the row up (a duplicate id is ignored by the ticker). */
  post() {
    this._armed = true;
    this._emitPost();
  }

  /**
   * Once per frame, no per-frame work unless armed. `ticker` is the HUD's
   * HintTicker (`getItemIds()`); absent = we go by what we last posted.
   * @param {{ _rosaFurlProgress?: number, _rosaFurlTarget?: number }|null} ship
   * @param {{ getItemIds?: () => string[] }|null} [ticker]
   */
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
      this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
      return;
    }
    const hasList = !!ticker && typeof ticker.getItemIds === 'function';
    const rowUp = hasList ? ticker.getItemIds().indexOf(WINGS_HINT_ID) >= 0 : this._rowUp;
    if (t >= 0.5) {
      // Commanded out, still rolling: the row comes down, the hint stays armed.
      if (rowUp) {
        this._rowUp = false;
        this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
      }
    } else if (!rowUp) {
      this._emitPost();
    }
  }

  /**
   * @returns {boolean|null} true / false once a frame has seen the ship's
   *   wings; null before that (unit tests, the menu hero) — callers treat null
   *   as "unknown, change nothing".
   */
  areOut() { return this._out; }

  /**
   * @returns {boolean|null} true when the wings are commanded rolled up (a
   *   scan refused for battery should say "open the wings"); false when they
   *   are commanded out; null before a frame has seen the ship.
   */
  needsOpening() { return this._needsOpening; }

  /** Take the row down, disarm and forget the ship (a new game, a retry, tests). */
  reset() {
    // The ticker ignores an unknown id, so this is safe when no row is up.
    this._bus.emit(Events.HINT_SATISFIED, { id: WINGS_HINT_ID });
    this._armed = false;
    this._out = null;
    this._needsOpening = null;
    this._rowUp = false;
  }

  /** @private */
  _emitPost() {
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

/** The shared instance (OpeningDance posts it, SensorSystem reads it, the game loop updates it). */
export const wingsHint = new WingsHint(eventBus);
if (Events.GAME_RESET) eventBus.on(Events.GAME_RESET, () => wingsHint.reset());
