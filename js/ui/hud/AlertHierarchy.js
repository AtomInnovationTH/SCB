/**
 * AlertHierarchy.js — the ALERT HIERARCHY (Session Q, plan D12 / D12c, owner
 * 2026-09-07 — "too many toasts and distractions"). Airbus A3 / A5 borrowed as
 * a practice: three levels, an inhibit during high workload, one transient
 * visible at a time, a lower level never replacing a higher one.
 *
 * This module is the PURE CORE — timestamps in, decisions out. No DOM, no
 * timers, no imports. The consumer (HUD, engaged policy only) offers every
 * bottom-centre transient here, calls `next(now)` once per frame, mirrors
 * `visible(now)` into its two sinks write-on-change (the notification zone for
 * level 1, the warning strip for levels 2–3) and never runs its own timers
 * while engaged. With the policy null the consumer keeps every shipped path
 * byte for byte and this class is never asked.
 *
 * THE LEVELS (`ALERT_LEVEL`): `alert-red` 3 (act now — the strip's `critical`),
 * `alert-amber` 2 (abnormal, finish your task first — the strip's `warning`),
 * `prompt` 1 (an actionable game notice; unknown / untagged kinds read 1).
 * `force` on a level-1 item = "answers the player's own input" (the density
 * toasts' flag; commsSuppression's `_reactive`): never inhibited, only deferred
 * behind a visible higher level.
 *
 * THE TABLE — arriving kind × state:
 *   red (3)            inhibited: show · higher visible: —    · else: show (replaces anything)
 *   amber (2)          inhibited: hold · higher visible: hold · else: show (replaces amber / prompt)
 *   prompt + force (1) inhibited: show unless a higher is visible · higher visible: hold · else: show
 *   prompt (1)         inhibited: hold · higher visible: hold · else: show (replaces a prompt)
 * HELD = one slot per kind, the newest replaces (an inhibited alert appears
 * when the phase ends — no expiry). `next(now)` promotes when nothing is
 * visible: the highest held level whose admission is allowed NOW (a held amber
 * / non-force prompt waits for the window to close; a held force prompt only
 * for the higher toast to end). A higher arrival PRE-EMPTS a visible lower
 * one, which is re-held and replays for its full duration afterwards (owner
 * call 13.9 #3: replay, the Airbus list). `visible.until = now + durationMs`;
 * the same kind replaces and restarts the clock; a kind that shows drops its
 * own held slot (a newer word beat the older one).
 *
 * @module ui/hud/AlertHierarchy
 */

/** Kind → level. Anything else reads level 1 (the safe default: shown as a prompt). */
export const ALERT_LEVEL = Object.freeze({ 'alert-red': 3, 'alert-amber': 2, prompt: 1 });

/** While inhibited, every level below this is held (force prompts excepted). */
export const INHIBIT_BELOW = 3;

/** showWarning severity → kind (the strip's two severities ARE the L3 / L2 kinds). */
export const STRIP_KIND = Object.freeze({ critical: 'alert-red', warning: 'alert-amber' });

/** The default duration when the caller gives none (showNotification's 2500). */
export const DEFAULT_DURATION_MS = 2500;

/**
 * @param {string} kind
 * @returns {number} 3 | 2 | 1
 */
export function levelOf(kind) {
  const l = ALERT_LEVEL[kind];
  return (typeof l === 'number') ? l : 1;
}

/** @private A finite, non-negative duration or the default. */
function _duration(v) {
  const n = (typeof v === 'number') ? v : ((v == null || typeof v === 'boolean' || typeof v === 'symbol') ? NaN : Number(v));
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_DURATION_MS;
}

/** @private A finite clock or 0 (the tests always pass one; the consumer passes performance.now()). */
function _now(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

/** @private Normalise an offered item into the arbiter's own record. */
function _item(o) {
  const src = (o && typeof o === 'object') ? o : {};
  const kind = (typeof src.kind === 'string' && src.kind) ? src.kind : 'prompt';
  return {
    kind,
    level: levelOf(kind),
    text: (src.text == null) ? '' : String(src.text),
    durationMs: _duration(src.durationMs),
    force: !!src.force,
  };
}

export class AlertArbiter {
  constructor() {
    /** @type {{kind:string, level:number, text:string, durationMs:number, force:boolean, until:number}|null} */
    this._visible = null;
    /** @type {Map<string, {kind:string, level:number, text:string, durationMs:number, force:boolean}>} one slot per kind, insertion-ordered */
    this._held = new Map();
    this._inhibited = false;
  }

  /**
   * The inhibit window (intro flyby, live approach). Write-on-change.
   * @param {boolean} on
   * @returns {boolean} changed
   */
  setInhibited(on) {
    const next = !!on;
    if (next === this._inhibited) return false;
    this._inhibited = next;
    return true;
  }

  /** @returns {boolean} */
  inhibited() { return this._inhibited; }

  /** @private Drop the visible item once its clock has run out. */
  _expire(now) {
    if (this._visible && now >= this._visible.until) this._visible = null;
  }

  /**
   * @private May `item` become visible NOW? The table's admission column.
   * A higher visible level always defers; the inhibit holds levels below
   * INHIBIT_BELOW unless the item is a force prompt.
   */
  _admits(item) {
    if (this._visible && this._visible.level > item.level) return false;
    if (this._inhibited && item.level < INHIBIT_BELOW && !item.force) return false;
    return true;
  }

  /**
   * Offer a transient.
   * @param {{kind?:string, text?:string, durationMs?:number, force?:boolean}} o
   * @param {number} nowMs
   * @returns {'show'|'hold'}
   */
  offer(o, nowMs) {
    const now = _now(nowMs);
    this._expire(now);
    const item = _item(o);
    if (!this._admits(item)) {
      this._held.set(item.kind, item);          // one slot per kind, the newest replaces
      return 'hold';
    }
    const cur = this._visible;
    if (cur && cur.level < item.level) {
      // Pre-emption: the lower one is re-held and replays for its full duration afterwards.
      this._held.set(cur.kind, { kind: cur.kind, level: cur.level, text: cur.text, durationMs: cur.durationMs, force: cur.force });
    }
    this._held.delete(item.kind);               // the kind that shows drops its own older held word
    this._visible = { ...item, until: now + item.durationMs };
    return 'show';
  }

  /**
   * Per frame: promote the highest held item whose admission is allowed now,
   * once nothing is visible.
   * @param {number} nowMs
   * @returns {{kind:string, level:number, text:string, durationMs:number, force:boolean, until:number}|null} the promoted item, or null
   */
  next(nowMs) {
    const now = _now(nowMs);
    this._expire(now);
    if (this._visible || this._held.size === 0) return null;
    // Highest admitted level wins; ties keep arrival order (the Map iterates in
    // insertion order and only a STRICTLY higher level replaces the pick). No
    // per-frame allocation while items wait — this runs every frame under an
    // inhibit window.
    let best = null;
    for (const h of this._held.values()) {
      if ((best === null || h.level > best.level) && this._admits(h)) best = h;
    }
    if (best === null) return null;
    this._held.delete(best.kind);
    this._visible = { ...best, until: now + best.durationMs };
    return { ...this._visible };
  }

  /**
   * The visible item (a copy), or null once its clock has run out.
   * @param {number} nowMs
   * @returns {{kind:string, level:number, text:string, durationMs:number, force:boolean, until:number}|null}
   */
  visible(nowMs) {
    this._expire(_now(nowMs));
    return this._visible ? { ...this._visible } : null;
  }

  /**
   * The held items (copies), highest level first; ties keep arrival order.
   * @returns {Array<{kind:string, level:number, text:string, durationMs:number, force:boolean}>}
   */
  held() {
    const out = [];
    for (const h of this._held.values()) out.push({ ...h });
    out.sort((a, b) => b.level - a.level);      // stable: ties keep insertion order
    return out;
  }

  /** Back to birth: nothing visible, nothing held, not inhibited. */
  clear() {
    this._visible = null;
    this._held.clear();
    this._inhibited = false;
  }
}
