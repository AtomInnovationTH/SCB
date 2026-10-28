/**
 * @module systems/IdleReset — "the next person on a shared iPad gets a fresh game" (DECISIONS §52).
 * Two halves, both free of the DOM and of THREE (Node-safe):
 *
 *  1. THE NEW PLAYER RESET (`resetForNewPlayer`, `bootWipeIfPending`, `needsReset`): `CLEAR_KEYS` are every per-player
 *     key; `KEEP_KEYS` are the ones a reset leaves (device and diagnostics keys). test-StorageKeysCovered.js scans js/
 *     and fails for a key that is in neither list. The language goes back to DEFAULT_LANGUAGE, the other settings stay.
 *  2. THE IDLE CLOCK (`IdleReset`): real seconds since the last input, minus the time the game spent playing itself
 *     out (`isHeldByAutoPlay`). After IDLE_S it raises "Still playing?"; COUNTDOWN_S later it resets. Time is
 *     injected (fake clock in tests). It only runs while show mode is on (ShowMode.js).
 *
 * Idle time is WALL-CLOCK time since the last input (Date.now keeps ticking while a tab is hidden or an iPad is
 * auto-locked), minus held time. Coming back from a hidden tab is not input, so an iPad that woke after the lock shows
 * the card at once with its full 20 s.
 */

import { StorageKeys } from '../core/StorageKeys.js';
import { DEFAULT_LANGUAGE } from '../core/Languages.js';

/** Real seconds without an input before the "Still playing?" card shows. */
export const IDLE_S = 60;
/** Seconds the card waits for an answer before it resets (WCAG 2.2.1: at least 20 s to answer). */
export const COUNTDOWN_S = 20;
/** One continuous hold excuses at most this many real seconds. */
export const HOLD_MAX_S = 180;
/** A gap between two ticks longer than this (hidden tab, locked iPad) is wall-clock time that counts, never a hold. */
export const TICK_GAP_MAX_MS = 5000;

/** Every per-player localStorage key a New player reset removes. Reserved keys (no writer yet) are listed on purpose. */
export const CLEAR_KEYS = Object.freeze([
  StorageKeys.SAVE,
  StorageKeys.SAVE_BACKUP,
  StorageKeys.ONBOARDING,
  StorageKeys.TEACHING,
  StorageKeys.TOUCH_MAP,
  StorageKeys.STRUT_AUTO,
  StorageKeys.FLOOR_WORDS,
  StorageKeys.LADDER_VIEW,
  StorageKeys.COMMS_STEP,
  StorageKeys.CITY_LABELS,
  'spacecowboy_iss_boss_v1',
  'spacecowboy_starlink_boss_v1',
  'spacecowboy_mission_coach_v1',
]);

/**
 * Keys a reset never removes. SETTINGS is kept but its `language` goes back to the default. SHOW_MODE is the device's
 * switch; the what's-new pair stays so the next player gets no update card; the black-screen ring is diagnostics.
 * RESET_PENDING and AUTO_UPDATE are sessionStorage (the update loop guard must survive).
 */
export const KEEP_KEYS = Object.freeze([
  StorageKeys.SETTINGS,
  StorageKeys.WHATS_NEW_SHOWN,
  StorageKeys.WHATS_NEW_SEEN,
  StorageKeys.BLACK_HEAL,
  StorageKeys.SHOW_MODE,
  StorageKeys.RESET_PENDING,
  StorageKeys.AUTO_UPDATE,
]);

/** The page's localStorage; null when there is none or touching it throws. */
function defaultLocal() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}
/** Same for sessionStorage. */
function defaultSession() {
  try { return globalThis.sessionStorage || null; } catch (_) { return null; }
}

function wipe(ls) {
  if (!ls) return;
  for (const k of CLEAR_KEYS) {
    try { ls.removeItem(k); } catch (_) { /* private mode */ }
  }
  let blob = {};
  try {
    const raw = ls.getItem(StorageKeys.SETTINGS);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) blob = parsed;
  } catch (_) { blob = {}; }
  blob.language = DEFAULT_LANGUAGE;
  try { ls.setItem(StorageKeys.SETTINGS, JSON.stringify(blob)); } catch (_) { /* private mode */ }
}

/**
 * The New player reset. ORDER: (1) lock the save so a late timer cannot write the run back, (2) set the sessionStorage
 * marker so the next boot wipes again (OnboardingDirector, TeachingSystem, CommsPanel and the settings can all write
 * once more before the page is gone), (3) wipe, (4) reload, so every in-memory store starts fresh too.
 * @param {object} [d]
 * @param {object} [d.storage]   localStorage-like { getItem, setItem, removeItem }; omitted = the page's
 * @param {object} [d.session]   sessionStorage-like { setItem }; omitted = the page's
 * @param {Function} [d.reload]  () => void; omitted = location.reload()
 * @param {Function} [d.lockSaves] () => void (PersistenceManager.lockForReset)
 * @returns {{ cleared: string[] }}
 */
export function resetForNewPlayer({ storage, session, reload, lockSaves } = {}) {
  const ls = storage !== undefined ? storage : defaultLocal();
  const ss = session !== undefined ? session : defaultSession();
  try { if (typeof lockSaves === 'function') lockSaves(); } catch (_) { /* keep going: the wipe matters more */ }
  try { if (ss) ss.setItem(StorageKeys.RESET_PENDING, '1'); } catch (_) { /* private mode */ }
  wipe(ls);
  const go = typeof reload === 'function' ? reload : () => { globalThis.location && globalThis.location.reload(); };
  try { go(); } catch (_) { /* nothing more to do */ }
  return { cleared: CLEAR_KEYS.slice() };
}

/**
 * First thing at boot, before any store reads storage (ShowMode.js runs it from its module body; main.js imports that
 * module first): a pending marker means a reset ran just before this reload, so wipe again and remove the marker.
 * @param {{ storage?: object, session?: object }} [d]
 * @returns {boolean} true when a pending reset was finished
 */
export function bootWipeIfPending({ storage, session } = {}) {
  const ls = storage !== undefined ? storage : defaultLocal();
  const ss = session !== undefined ? session : defaultSession();
  let pending = null;
  try { pending = ss ? ss.getItem(StorageKeys.RESET_PENDING) : null; } catch (_) { return false; }
  if (pending == null) return false;
  wipe(ls);
  try { ss.removeItem(StorageKeys.RESET_PENDING); } catch (_) { /* private mode */ }
  return true;
}

function readJson(ls, key) {
  try {
    const raw = ls.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * Is there anything on this device that a reset would clear? A save (or its backup), tutorial progress, any hint or
 * view memory, or a language other than the default. CITY_LABELS is deliberately left out, so a boot that ever touches
 * it cannot make an idle menu look used. A menu straight after boot answers false.
 * @param {object} [storage] localStorage-like { getItem }; omitted = the page's
 * @returns {boolean}
 */
export function needsReset(storage) {
  const ls = storage !== undefined ? storage : defaultLocal();
  if (!ls) return false;
  try {
    if (ls.getItem(StorageKeys.SAVE) != null || ls.getItem(StorageKeys.SAVE_BACKUP) != null) return true;
    const onb = readJson(ls, StorageKeys.ONBOARDING);
    if (onb && ((Array.isArray(onb.completedBeats) && onb.completedBeats.length)
      || (Array.isArray(onb.skippedBeats) && onb.skippedBeats.length) || onb.mastered || onb.detailHintShown)) return true;
    const seen = readJson(ls, StorageKeys.TEACHING);
    if (Array.isArray(seen) && seen.length) return true;
    for (const k of [StorageKeys.TOUCH_MAP, StorageKeys.STRUT_AUTO, StorageKeys.FLOOR_WORDS, StorageKeys.LADDER_VIEW, StorageKeys.COMMS_STEP]) {
      if (ls.getItem(k) != null) return true;
    }
    const st = readJson(ls, StorageKeys.SETTINGS);
    if (st && typeof st.language === 'string' && st.language !== DEFAULT_LANGUAGE) return true;
  } catch (_) { return false; }
  return false;
}

/** Daughter states that play out by themselves. */
export const HOLD_ARM_STATES = Object.freeze([
  'TRANSIT', 'REELING', 'HAULING', 'RETURNING', 'DOCKING', 'CARRY_OUT', 'CARRY_BACK',
]);

/**
 * Is the game playing itself out right now, with nothing for the player to do? Every source is optional (a missing
 * one holds nothing). Deliberately NOT a hold: the whole TransferTrip (`TransferTrip.isActive()`), because its `choose`
 * phase waits for the player and `wait` can wait for power with no limit; only the burn, the satellite call and the
 * ship's slow turn on the tail boxes are held.
 * @param {{ trip?: object, cameraSystem?: object, autopilot?: object, arms?: object[] }} src
 * @returns {boolean}
 */
export function isHeldByAutoPlay({ trip, cameraSystem, autopilot, arms } = {}) {
  try {
    if (trip && ((typeof trip.isBurning === 'function' && trip.isBurning()) || (typeof trip.isCalling === 'function' && trip.isCalling()))) return true;
    if (cameraSystem && typeof cameraSystem.isIonStartupActive === 'function' && cameraSystem.isIonStartupActive()) return true;
    if (autopilot && typeof autopilot.tripTurnIsSlow === 'function' && autopilot.tripTurnIsSlow()) return true;
    if (Array.isArray(arms)) {
      for (const a of arms) {
        if (a && (a.isReelingHome === true || HOLD_ARM_STATES.includes(a.state))) return true;
      }
    }
  } catch (_) { return false; }
  return false;
}

/**
 * Parse the test-only `?idleS=<seconds>` switch; honoured only while show mode is on.
 * @param {string} search  location.search
 * @param {boolean} showOn
 * @returns {number|null} seconds (1..3600) or null
 */
export function idleOverrideS(search, showOn) {
  if (!showOn || typeof search !== 'string') return null;
  const m = /[?&]idleS=([0-9]+(?:\.[0-9]+)?)(?:&|$)/.exec(search);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 1 && v <= 3600 ? v : null;
}

/** An untouched start screen becomes a still picture after this many real seconds (DECISIONS §52 row 5). */
export const MENU_FREEZE_S = 120;

/**
 * Seconds until the untouched menu freezes. `?idleS=N` (see `idleOverrideS`) makes it 2N, so `?idleS=5` freezes at
 * 10 s, after the card (5 s) as in the real 60 s / 120 s order.
 * @param {number|null|undefined} overrideS the parsed `?idleS=` value, or null/undefined
 * @returns {number}
 */
export function menuFreezeS(overrideS) {
  return Number.isFinite(overrideS) && overrideS > 0 ? overrideS * 2 : MENU_FREEZE_S;
}

/**
 * Should the start screen stop drawing (both loops) right now? True only with show mode on, the MENU state and
 * `freezeS` real seconds since the menu was last touched or entered. Its own timestamp, not `IdleReset.idleSeconds()`:
 * that clock restarts every tick on a clean menu (no save) and is cut short by the card and the reset on a used one.
 * @param {{ showOn: boolean, state: string, nowMs: number, menuUntouchedSince: number, freezeS: number }} a
 * @returns {boolean}
 */
export function shouldFreezeMenu({ showOn, state, nowMs, menuUntouchedSince, freezeS } = {}) {
  if (showOn !== true || state !== 'MENU') return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(menuUntouchedSince) || !Number.isFinite(freezeS)) return false;
  return (nowMs - menuUntouchedSince) / 1000 >= freezeS;
}

/** The idle clock and the card's state machine ('idle' | 'card'). The card's look is StillPlayingCard.js. */
export class IdleReset {
  /**
   * @param {object} d
   * @param {Function} [d.now]        () => ms, wall clock (default Date.now)
   * @param {Function} [d.enabled]    () => boolean: show mode on
   * @param {Function} [d.onMenu]     () => boolean: the menu is up (the clock then needs `needsReset`)
   * @param {Function} [d.needsReset] () => boolean (default: needsReset())
   * @param {Function} [d.holds]      () => boolean: the game is playing itself out
   * @param {Function} [d.reset]      () => void: the New player reset (resetForNewPlayer with the page's deps)
   * @param {Function} [d.onCard]     (remainingS) => void: the card must show
   * @param {Function} [d.onCountdown] (remainingS) => void: the card's line counts down
   * @param {Function} [d.onKeep]     () => void: the card must go (Keep playing)
   * @param {number} [d.idleS]
   * @param {number} [d.countdownS]
   * @param {number} [d.holdMaxS]
   */
  constructor(d = {}) {
    this._now = typeof d.now === 'function' ? d.now : () => Date.now();
    this._enabled = d.enabled || (() => false);
    this._onMenu = d.onMenu || (() => false);
    this._needsReset = d.needsReset || (() => needsReset());
    this._holds = d.holds || (() => false);
    this._reset = d.reset || (() => {});
    this._onCard = d.onCard || (() => {});
    this._onCountdown = d.onCountdown || (() => {});
    this._onKeep = d.onKeep || (() => {});
    this.idleS = Number.isFinite(d.idleS) ? d.idleS : IDLE_S;
    this.countdownS = Number.isFinite(d.countdownS) ? d.countdownS : COUNTDOWN_S;
    this.holdMaxS = Number.isFinite(d.holdMaxS) ? d.holdMaxS : HOLD_MAX_S;
    this.state = 'idle';
    this._resetDone = false;
    this._restart();
  }

  _restart() {
    const t = this._now();
    this._lastInput = t;
    this._lastTick = t;
    this._heldMs = 0;
    this._holdRunMs = 0;
    this._cardAt = 0;
    this._lastShown = null;
  }

  /** An input happened. Ignored while the card is up: the card answers for itself. */
  noteInput() {
    if (this.state === 'card') return;
    this._restart();
  }

  idleSeconds() {
    return Math.max(0, (this._now() - this._lastInput - this._heldMs) / 1000);
  }

  /** Seconds left on the card's countdown (countdownS when not showing). */
  remainingS() {
    if (this.state !== 'card') return this.countdownS;
    return Math.max(0, this.countdownS - (this._now() - this._cardAt) / 1000);
  }

  _counts() {
    if (!this._enabled()) return false;
    return !this._onMenu() || this._needsReset();
  }

  /**
   * Advance the clock: about four times a second, and when the page becomes visible again. A hold excuses the time
   * between two ticks only when the gap is short (longer than TICK_GAP_MAX_MS = hidden tab or locked iPad, always
   * counts), and one continuous hold excuses at most HOLD_MAX_S.
   */
  tick() {
    const t = this._now();
    const dt = Math.max(0, t - this._lastTick);
    this._lastTick = t;
    if (this._resetDone) return;
    if (this.state === 'card') {
      const rem = this.remainingS();
      if (rem <= 0) { this._doReset(); return; }
      const shown = Math.ceil(rem);
      if (shown !== this._lastShown) { this._lastShown = shown; this._onCountdown(shown); }
      return;
    }
    if (!this._counts()) { this._restart(); return; }
    let holding = false;
    try { holding = !!this._holds(); } catch (_) { holding = false; }
    if (holding && dt <= TICK_GAP_MAX_MS) {
      const room = Math.max(0, this.holdMaxS * 1000 - this._holdRunMs);
      const take = Math.min(dt, room);
      this._heldMs += take;
      this._holdRunMs += dt;
    } else if (!holding) {
      this._holdRunMs = 0;
    }
    if (this.idleSeconds() >= this.idleS) {
      this.state = 'card';
      this._cardAt = t;
      this._lastShown = Math.ceil(this.countdownS);
      this._onCard(this.countdownS);
    }
  }

  keepPlaying() {
    if (this.state !== 'card') return;
    this.state = 'idle';
    this._restart();
    this._onKeep();
  }

  /** The reset, once (button or countdown zero). */
  newPlayer() {
    if (this.state !== 'card') return;
    this._doReset();
  }

  _doReset() {
    if (this._resetDone) return;
    this._resetDone = true;
    this._reset();
  }
}

export default IdleReset;
