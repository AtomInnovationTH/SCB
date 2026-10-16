/**
 * StrutAuto.js — the daughter arms mostly move themselves (lane arms-auto;
 * DECISIONS §25 ruling 5, owner 2026-10-15), and the player can take over.
 *
 *   1. Flat (0°) while nothing is near.
 *   2. Swept back 34° when a piece is within the 90 m ring or a catch is under way.
 *   3. The launching arm aims itself: the launch (aim ceremony / number-key gate)
 *      owns its struts; this module keeps its hands off until 3 s after it ends,
 *      then brings a re-docked strut to the due angle.
 *   4. Arms dodge an inbound catch (the lean-aside duck, now also triggered by
 *      the mother net's own approach, not only by LASSO_CAPTURED).
 *   5. A manual move ("." key, DAUGHTERS tile) holds for 10 s after the arm
 *      ARRIVES, then eases back to automatic.
 *   6. The full range of motion is shown once per player, the first time the
 *      struts leave closed.
 *
 * Everything moves at the real hinge rate: this module only writes the same
 * `arm._strutTargetAlpha` latch the "." key writes; the ship's per-frame driver
 * (PlayerSatellite._updateStruts) slews it at STRUT_SLEW_RATE. Nothing here
 * teleports, emits STRUT_DEPLOY_INPUT, or touches an arm that is not DOCKED.
 *
 * Split for testability: `autoPoseFor` (pure), `StrutAutoStore` (the
 * once-per-player record, the TouchMapStore idiom) and `StrutAutoController`
 * (per-frame logic over a small `view` the ArmManager builds).
 *
 * @module systems/StrutAuto
 */

import { Constants } from '../core/Constants.js';
import { StorageKeys } from '../core/StorageKeys.js';

/** Envelope version of the stored record. */
export const STRUT_AUTO_VERSION = 1;

/**
 * The due angle: swept back (STRUT_REST_ALPHA, 34°) while a piece is near,
 * flat (0°) otherwise.
 * @param {boolean} near
 * @returns {number} radians
 */
export function autoPoseFor(near) {
  return near ? Constants.OCTOPUS_V5.STRUT_REST_ALPHA : 0;
}

/** @private default storage: the global localStorage when present. */
function _defaultStorage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_e) {
    return null;
  }
}

/**
 * The once-per-player record: has the full-range show been seen? One
 * localStorage key (StorageKeys.STRUT_AUTO), envelope `{ v: 1, seen: true }`.
 * Outside the run save, so a New Game does not repeat the show. Private-mode
 * safe: any storage failure → unseen / in-memory only, never a throw.
 * Write-on-change only.
 */
export class StrutAutoStore {
  /**
   * @param {object} [deps]
   * @param {object|null} [deps.storage] localStorage-shaped; default the global
   *   localStorage, or null (in-memory only).
   */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    this._seen = false;
    this._lastJson = null;
    this._writes = 0;
    this._load();
  }

  /** @returns {boolean} whether this player has seen the show */
  get seen() { return this._seen; }

  /** Record that the show has been seen. Writes once; later calls are no-ops. */
  markSeen() {
    if (this._seen) return;
    this._seen = true;
    this._save();
  }

  /** @private */
  _load() {
    if (!this._storage) return;
    let raw = null;
    try { raw = this._storage.getItem(StorageKeys.STRUT_AUTO); } catch (_e) { return; }
    if (typeof raw !== 'string' || !raw) return;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && o.v === STRUT_AUTO_VERSION && o.seen === true) {
        this._seen = true;
        this._lastJson = raw;
      }
    } catch (_e) { /* corrupt → unseen */ }
  }

  /** @private */
  _save() {
    const json = JSON.stringify({ v: STRUT_AUTO_VERSION, seen: this._seen });
    if (json === this._lastJson) return;
    this._lastJson = json;
    if (!this._storage) return;
    try {
      this._storage.setItem(StorageKeys.STRUT_AUTO, json);
      this._writes++;
    } catch (_e) { /* private mode / quota: remembered for this session only */ }
  }
}

/** One arm's private bookkeeping (WeakMap-keyed; never stored on the arm). @private */
const _newArmState = () => ({ mine: null });

/**
 * Per-frame logic. Construct once; call `update(dt, view)` every frame.
 *
 * `view` (built by ArmManager, read-only snapshot + a few actions):
 *   arms                    ArmUnit[]            the manager's arms
 *   inert()                 boolean              flag off / launch lock / dance / safe mode …
 *   busy()                  boolean              a launch, aim, duck, leash … owns the struts
 *   nearestPieceM()         number               metres to the nearest free discovered piece (Infinity if none)
 *   catchActive()           boolean              a catch is under way
 *   netInFlight()           boolean              optional: any net (mother or daughter) out or reeling
 *   inboundNetRadiusM()     number|null          berth-corridor radius of an inbound mother catch, else null
 *   duck(radiusM)           void                 the lean-aside duck for struts that foul that radius
 *   pressCount()            number               "." presses so far (toggleStruts counts them)
 *   headless                boolean              no ship strut driver: the controller slews the latches it owns
 *   gapAt(arm, alphaRad)    number               optional: clearance in metres of that arm at that angle (Infinity if unknown)
 *   say(text)               void                 one info line
 *   store                   StrutAutoStore|null  null → the show never runs
 */
export class StrutAutoController {
  constructor() {
    this._arm = new WeakMap();
    this.reset();
  }

  /** Forget everything (ArmManager.reset / a new game). */
  reset() {
    this._near = false;
    this._farS = 0;
    this._scanS = Infinity;      // scan on the first live frame
    this._coolS = 0;
    this._hadMarkers = false;
    this._expired = false;
    this._prevClosed = true;
    this._showPending = false;
    this._show = null;
    this._checkS = 0;
    this._retry = false;         // a show was cut short: try again at the next quiet chance
    this._retryPress = 0;        // "." presses at the cut; a LATER press is a chance
    this._lastPress = 0;
    this._arm = new WeakMap();
  }

  /**
   * Play is not running (menu, briefing, shop): stop a show where it is. Not marked seen;
   * it retries at the next quiet chance. Called by ArmManager instead of `update`.
   */
  suspend() {
    if (this._show) this._cancelShow();
  }

  /** @returns {boolean} whether a piece/catch currently counts as near (hysteresis applied) */
  get near() { return this._near; }
  /** @returns {object|null} the running show, if any */
  get show() { return this._show; }

  /** @private */
  _st(arm) {
    let s = this._arm.get(arm);
    if (!s) { s = _newArmState(); this._arm.set(arm, s); }
    return s;
  }

  /**
   * @param {number} dt seconds (> 0)
   * @param {object} view see the class doc
   */
  update(dt, view) {
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    const arms = view.arms || [];

    // A zero-time frame (drawer open, game clock stopped) is skipped: it never cancels the show.
    if (!(dt > 0)) return;
    this._lastPress = view.pressCount();
    if (view.inert()) {
      if (this._show) this._cancelShow();
      return;
    }
    const docked = arms.filter((a) => a && a.state === Constants.ARM_STATES.DOCKED);

    // ── near / flat (item 1, 2) ────────────────────────────────────────────
    this._scanS += dt;
    if (this._scanS >= V.SCAN_INTERVAL_S) {
      const elapsed = Number.isFinite(this._scanS) ? this._scanS : 0;
      this._scanS = 0;
      const d = view.nearestPieceM();
      const ring = Constants.NET_LOCK_RANGE_M;
      const raw = view.catchActive() || d <= (this._near ? ring * V.LEAVE_FACTOR : ring);
      if (raw) {
        this._near = true;
        this._farS = 0;
      } else if (this._near) {
        this._farS += elapsed;
        if (this._farS >= V.FLAT_DWELL_S) this._near = false;
      }
    }

    // ── dodge an inbound catch (item 4) ───────────────────────────────────
    const radiusM = view.inboundNetRadiusM();
    if (radiusM != null) view.duck(radiusM);

    // ── manual override ageing (item 5) — runs even while busy ────────────
    this._ageMarkers(dt, docked, view);

    // ── trigger bookkeeping for the show (item 6), BEFORE any write ───────
    const eff = (a) => a._strutTargetAlpha ?? (a.getAimAlpha ? a.getAimAlpha() : 0);
    const thr = Constants.OCTOPUS_V5.STRUT_OPEN_THRESHOLD;
    const anyOpen = docked.some((a) => eff(a) >= thr);
    const allClosed = docked.length > 0 && !anyOpen;
    if (view.store && !view.store.seen && !this._show) {
      if (this._prevClosed && anyOpen) this._showPending = true;
      if (allClosed) this._showPending = false;
    }
    if (docked.length > 0) this._prevClosed = allClosed;

    // ── busy → hands off, 3 s cool-off (item 3) ───────────────────────────
    const busy = view.busy();
    if (busy) {
      this._coolS = V.HANDOFF_S;
      if (this._show) this._cancelShow();
      return;
    }
    if (this._coolS > 0) {
      this._coolS -= dt;
      if (this._show) this._cancelShow();
    }

    // ── the show owns the latch while it runs ─────────────────────────────
    if (this._show) {
      this._tickShow(dt, docked, view);
    } else if ((this._showPending || this._retryReady(view)) && this._coolS <= 0 && this._showMayStart(docked, view)) {
      this._startShow(docked, view);
    }

    // ── per-arm automatic pose (items 1–3) ────────────────────────────────
    const due = autoPoseFor(this._near);
    for (const arm of docked) {
      const st = this._st(arm);
      const latch = arm._strutTargetAlpha;
      // A latch someone else wrote (launch gate, duck, cargo re-pose, a "." press) is theirs.
      if (latch !== undefined && latch !== st.mine) { st.mine = null; continue; }
      if (latch === undefined) st.mine = null;
      if (this._show || this._coolS > 0 || arm._strutManual) continue;
      const live = arm.getAimAlpha();
      const want = due;
      if (latch === undefined) {
        if (Math.abs(live - want) > V.DEADBAND_RAD) { arm._strutTargetAlpha = want; st.mine = want; }
      } else if (Math.abs(latch - want) > V.DEADBAND_RAD) {   // mine, due changed mid-swing
        arm._strutTargetAlpha = want; st.mine = want;
      }
    }

    // Headless mocks have no ship driver: slew the latches this module owns / a "." press wrote.
    if (view.headless) this._slewHeadless(dt, docked);
  }

  // ── override markers ────────────────────────────────────────────────────

  /** @private */
  _ageMarkers(dt, docked, view) {
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    let any = false;
    for (const arm of view.arms || []) {
      const m = arm && arm._strutManual;
      if (!m) continue;
      if (arm.state !== Constants.ARM_STATES.DOCKED) { delete arm._strutManual; continue; }
      if (arm._strutTargetAlpha !== undefined) m.quietS = 0;
      else m.quietS += dt;
      if (m.quietS >= V.OVERRIDE_S) { delete arm._strutManual; this._expired = true; continue; }
      any = true;
    }
    if (any) this._hadMarkers = true;
    else if (this._hadMarkers) {
      this._hadMarkers = false;
      if (this._expired) view.say('Daughter arms back to automatic.');   // once per batch
      this._expired = false;
    }
  }

  // ── the full-range show ─────────────────────────────────────────────────

  /**
   * A cut-short show tries again when it is quiet and either a piece is within range (no
   * "." hold running) or the player presses "." again. @private
   */
  _retryReady(view) {
    if (!this._retry || !view.store || view.store.seen) return false;
    if (view.pressCount() !== this._retryPress) return true;
    return this._near && !(view.arms || []).some((a) => a && a._strutManual);
  }

  /**
   * Quiet: all daughters docked (every arm, not just some), none aiming, no net in flight or
   * reeling, no leash hand-off. @private
   */
  _showMayStart(docked, view) {
    if (!view.store || view.store.seen || docked.length === 0) return false;
    const arms = (view.arms || []).filter(Boolean);
    if (arms.length !== docked.length) return false;
    if (view.catchActive() || view.inboundNetRadiusM() != null) return false;
    if (typeof view.netInFlight === 'function' && view.netInFlight()) return false;
    return docked.every((a) => !a._aimReserved);
  }

  /** @private */
  _startShow(docked, view) {
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    // Return to what was due: the angle a "." press asked for, else the automatic one.
    let back = autoPoseFor(this._near);
    for (const a of docked) {
      if (a._strutManual && a._strutTargetAlpha !== undefined) { back = a._strutTargetAlpha; break; }
    }
    this._show = {
      phase: 'out', back, press: view.pressCount(), arms: docked.slice(), top: V.DEMO_TOP_RAD,
    };
    this._showPending = false;
    this._retry = false;
    this._checkS = 0;
    for (const a of docked) { a._strutTargetAlpha = V.DEMO_TOP_RAD; this._st(a).mine = V.DEMO_TOP_RAD; }
  }

  /**
   * Stop the show where it is: arms still heading for the show's angle are frozen
   * (a latch someone else wrote is theirs), then the automatic pose takes them to the
   * due angle at the real rate. @private
   */
  _cancelShow() {
    const s = this._show;
    if (s) {
      this._retry = true;                       // cut short: not marked seen, try again when quiet
      this._retryPress = this._lastPress;
      for (const a of s.arms) {
        const st = this._st(a);
        if (st.mine !== null && a._strutTargetAlpha === st.mine) a._strutTargetAlpha = undefined;
        st.mine = null;
      }
    }
    this._show = null;
    this._showPending = false;
  }

  /** @private */
  _tickShow(dt, docked, view) {
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    const s = this._show;
    // Cancelled by: a "." press, an arm leaving the dock, a reserved aim, an inbound catch, a foreign latch.
    if (view.pressCount() !== s.press
      || s.arms.some((a) => a.state !== Constants.ARM_STATES.DOCKED || a._aimReserved)
      || (view.arms || []).some((a) => a && a.state !== Constants.ARM_STATES.DOCKED)
      || view.catchActive() || view.inboundNetRadiusM() != null
      || (typeof view.netInFlight === 'function' && view.netInFlight())) {
      this._cancelShow();
      return;
    }
    const target = s.phase === 'out' ? s.top : s.back;
    for (const a of s.arms) {
      const l = a._strutTargetAlpha;
      if (l !== undefined && l !== target) { this._cancelShow(); return; }
    }

    if (s.phase === 'out') {
      // Re-check clearance 0.25 s apart, at the next 3° (the measured sweep is clear to 180°; this is the net).
      this._checkS += dt;
      if (this._checkS >= 0.25 && typeof view.gapAt === 'function') {
        this._checkS = 0;
        for (const a of s.arms) {
          const next = Math.min(s.top, a.getAimAlpha() + 3 * Math.PI / 180);
          if (next < V.DEMO_CHECK_FROM_RAD) continue;           // still in the rest cradle
          const gap = view.gapAt(a, next);
          if (gap < V.DEMO_CLEAR_M) { this._turnBack(s); return; }
        }
      }
      if (s.arms.every((a) => a._strutTargetAlpha === undefined)) this._turnBack(s);
      return;
    }

    // back leg
    if (s.arms.every((a) => a._strutTargetAlpha === undefined)) {
      this._show = null;
      view.store.markSeen();
      view.say('Daughter arms: full range, once. They will move on their own from now on; press . to take over for 10 s.');
    }
  }

  /** @private */
  _turnBack(s) {
    s.phase = 'back';
    for (const a of s.arms) {
      if (Math.abs(a.getAimAlpha() - s.back) > 1e-6) { a._strutTargetAlpha = s.back; this._st(a).mine = s.back; }
      else a._strutTargetAlpha = undefined;
    }
  }

  // ── headless slew ───────────────────────────────────────────────────────

  /** @private */
  _slewHeadless(dt, docked) {
    for (const arm of docked) {
      const t = arm._strutTargetAlpha;
      if (t === undefined || typeof arm.setAimAlpha !== 'function') continue;
      if (t !== this._st(arm).mine && !arm._strutManual) continue;
      arm.setAimAlpha(t, dt);
      if (Math.abs(arm.getAimAlpha() - t) < 0.01) arm._strutTargetAlpha = undefined;
    }
  }
}

export default StrutAutoController;
