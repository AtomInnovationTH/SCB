/**
 * AutoLockController.js — reward-first front-arc autolock + range tracking.
 *
 * Part of the reward-first onboarding spine
 * (.kilo/plans/new-player-onboarding-flow.md, Phase 1).
 *
 * Responsibilities:
 *   1. Auto-select the nearest debris inside the forward arc so a new player
 *      gets the satisfying lock + first catch in the first ~10 s. Permanent
 *      assist for all players; a Settings toggle can disable it, and any manual
 *      T/click selection (or a deliberate direction input) suppresses it for
 *      that target. In a GUIDED chapter (missions 1–3, the profile's
 *      `guidedCluster` flag via DebrisField.isGuidedChapter()) an empty forward
 *      arc falls back to the nearest alive piece anywhere within
 *      AUTOLOCK.GUIDED_FALLBACK_RANGE_M, so a cluster that drifted behind the
 *      mother is still pointed at (M1 guidance, T5).
 *   2. Track whether the *selected* target is inside NET_LOCK_RANGE_M and emit
 *      Events.TARGET_IN_RANGE / Events.TARGET_OUT_OF_RANGE on the crossing.
 *      These drive the cyan↔yellow reticle flip, the in-range-only lock earcon,
 *      and the range→autopilot teaching gate.
 *   3. Re-acquire the next forward candidate a short beat after a capture, so
 *      the reward registers before the reticle hops to the next piece.
 *
 * "Forward" = the player's prograde (velocity) direction, the natural front of
 * the ship in this sim. Candidates are scored by distance within the arc.
 *
 * Design notes:
 *   - Lock-sound gating: AudioSystem plays playTargetLock on TARGET_SELECTED.
 *     To keep that earcon a trustworthy "you can act on this now" signal, we
 *     suppress it for out-of-range selections by tagging the TARGET_SELECTED
 *     context with `_suppressLockSound:true` and re-firing the lock cue on the
 *     yellow→cyan range flip via Events.TARGET_IN_RANGE.
 *   - Allocation-free hot path: no per-frame Vector3 churn.
 *
 * @module systems/AutoLockController
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { targetSelector } from './TargetSelector.js';

export class AutoLockController {
  /**
   * @param {object} deps
   * @param {object} deps.player        — PlayerSatellite (getPosition/getVelocity)
   * @param {object} deps.debrisField   — DebrisField (getDebrisNear)
   * @param {object} [deps.settingsManager] — persistent autolock pref
   */
  constructor(deps = {}) {
    this._player = deps.player || null;
    this._debrisField = deps.debrisField || null;
    this._settings = deps.settingsManager || null;

    /** @type {boolean} player/setting master enable. */
    this._enabled = !!(Constants.AUTOLOCK && Constants.AUTOLOCK.ENABLED);
    if (this._settings && typeof this._settings.getAutolock === 'function') {
      this._enabled = this._settings.getAutolock();
    }

    /** @type {boolean} true once the player took manual control of selection. */
    this._manualOverride = false;

    /** @type {number} timestamp (ms) until which reacquire is paused. */
    this._reacquireBlockedUntil = 0;

    /** @type {'in'|'out'|null} last emitted range state for the active target. */
    this._lastRangeState = null;
    /** @type {*} id the range state is tracking (reset on target switch). */
    this._rangeTargetId = null;

    // Pre-allocated scratch objects — the acquire/track paths run per-frame and
    // must not churn the GC (allocation-free hot path). _tryAcquire and
    // _trackRange never run in the same frame, so a shared scratch is safe.
    this._fwdScratch = { x: 0, y: 0, z: 0 };
    this._scenePosScratch = { x: 0, y: 0, z: 0 };

    this._unsubs = [];
    this._setupListeners();
  }

  setRefs({ player, debrisField } = {}) {
    if (player) this._player = player;
    if (debrisField) this._debrisField = debrisField;
  }

  /** Enable/disable the assist (Settings toggle). */
  setEnabled(on) { this._enabled = !!on; }
  isEnabled() { return this._enabled; }

  // ─── INTERNAL — WIRING ─────────────────────────────────────────────────

  _setupListeners() {
    const on = (evt, h) => {
      if (!evt) return;
      const u = eventBus.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };

    // Manual selection (T / HUD click) takes over: stop fighting the player.
    // We distinguish autolock's own selections via the `autoLock` context flag.
    on(Events.TARGET_SELECTED, (d) => {
      if (d && d.autoLock) return;          // our own pick — not a manual override
      if (d && d.autoTarget) return;        // legacy welcome auto-target — also ours
      if (d && d.autoAcquire) return;       // TargetAcquisition programmatic pick — also ours
      this._manualOverride = true;
    });

    // Cleared target → allow autolock to reacquire.
    on(Events.TARGET_CLEARED, () => {
      this._lastRangeState = null;
      this._rangeTargetId = null;
    });

    // After a capture, pause briefly so the reward registers, then reacquire —
    // but only if REACQUIRE auto-advance is enabled. When it's off, suppress
    // autolock until the player makes a manual selection (treat the post-capture
    // state as a manual override) so we don't auto-advance to the next contact.
    on(Events.DEBRIS_CAPTURED, () => {
      const cfg = Constants.AUTOLOCK || {};
      const reacquire = cfg.REACQUIRE !== false;
      this._manualOverride = !reacquire; // reacquire? resume assisted flow : hold
      const delay = cfg.REACQUIRE_DELAY_MS || 800;
      this._reacquireBlockedUntil = Date.now() + delay;
      this._lastRangeState = null;
      this._rangeTargetId = null;
    });

    if (Events.GAME_RESET) {
      on(Events.GAME_RESET, () => this.reset());
    }

    // Scan is the player's explicit "I'm lost, help" action (scan auto-select,
    // TargetAcquisition). Re-arm ambient assist by clearing any sticky manual
    // override so the reticle resumes picking in-arc contacts. Fill-only
    // precedence (by design): after this re-arm, _tryAcquire may grab an in-arc
    // ≤5 km piece during the ~0-1.2 s reveal stagger before SCAN_REVEALS_SETTLED
    // fires; the scan acquire then finds a target present and skips. Both picks
    // are "assisted flow" — no fight.
    if (Events.SCAN_COMPLETE) {
      on(Events.SCAN_COMPLETE, () => { this._manualOverride = false; });
    }

    // Settings toggle honors the autolock assist enable/disable.
    if (Events.AUTOLOCK_SETTING_CHANGED) {
      on(Events.AUTOLOCK_SETTING_CHANGED, (d) => { this._enabled = !!(d && d.enabled); });
    }
  }

  reset() {
    this._manualOverride = false;
    this._reacquireBlockedUntil = 0;
    this._lastRangeState = null;
    this._rangeTargetId = null;
    if (this._settings && typeof this._settings.getAutolock === 'function') {
      this._enabled = this._settings.getAutolock();
    } else {
      this._enabled = !!(Constants.AUTOLOCK && Constants.AUTOLOCK.ENABLED);
    }
  }

  dispose() {
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }

  // ─── PER-FRAME ─────────────────────────────────────────────────────────

  /**
   * @param {number} _dt
   */
  update(_dt) {
    if (!this._player || !this._debrisField) return;

    const active = targetSelector.getActiveTarget();

    // 1) Acquire a target if none selected (and assist is on / not overridden).
    if (!active) {
      this._tryAcquire();
      return;
    }

    // 2) Track range crossings for the live selected target.
    this._trackRange(active);
  }

  /** @private Attempt to autolock the nearest forward, alive candidate — or,
   *  in a guided chapter with an empty forward arc, the nearest alive piece
   *  anywhere (see _guidedFallbackPick). */
  _tryAcquire() {
    if (!this._enabled) return;
    if (this._manualOverride) return;
    if (Date.now() < this._reacquireBlockedUntil) return;

    const playerPos = this._player.getPosition && this._player.getPosition();
    if (!playerPos) return;

    const cfg = Constants.AUTOLOCK || {};
    const radiusScene = ((cfg.RANGE_M || 5000) / 1000) * Constants.SCENE_SCALE; // m→km→scene
    const nearby = this._debrisField.getDebrisNear(playerPos, radiusScene);

    // Forward = prograde (velocity) direction.
    const vel = this._player.getVelocity && this._player.getVelocity();
    const fwd = this._normalize(vel);
    const arcDot = Number.isFinite(cfg.ARC_DOT) ? cfg.ARC_DOT : 0.5;

    // nearby is sorted nearest-first. Pick nearest within the forward arc.
    let pick = null;
    if (nearby && nearby.length > 0) {
      for (const d of nearby) {
        if (!d || !d.alive || d._captured) continue;
        const sp = d._scenePosition;
        if (fwd && sp) {
          const tx = sp.x - playerPos.x;
          const ty = sp.y - playerPos.y;
          const tz = sp.z - playerPos.z;
          const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          const dot = (tx * fwd.x + ty * fwd.y + tz * fwd.z) / tlen;
          if (dot < arcDot) continue; // outside forward arc
        }
        pick = d;
        break;
      }
    }
    // Empty forward arc (nothing within RANGE_M, or everything behind /
    // abeam): in a guided chapter, fall back to the nearest piece anywhere.
    if (!pick) pick = this._guidedFallbackPick(playerPos, cfg);
    if (!pick) return;

    const debris = this._debrisField.getDebrisById
      ? this._debrisField.getDebrisById(pick.id)
      : pick;
    if (!debris) return;

    // Autolock always suppresses the SELECTED earcon: the lock cue fires from
    // the TARGET_IN_RANGE crossing emitted by _trackRange next frame (in-range
    // pick → immediate cue; out-of-range pick → cue only once it comes in
    // range). This keeps exactly one lock sound per "now actionable" event and
    // avoids a double-fire (SELECTED + IN_RANGE) on an in-range autolock.
    targetSelector.setTarget(debris, {
      autoLock: true,
      _suppressLockSound: true,
    });

    // Seed range tracking so the first emit fires correctly next frame.
    this._rangeTargetId = debris.id;
    this._lastRangeState = null;
  }

  /**
   * @private Guided-chapter fallback (M1 guidance, T5): when the forward arc
   * holds nothing, lock the nearest alive piece ANYWHERE within
   * AUTOLOCK.GUIDED_FALLBACK_RANGE_M — no arc test. Only in a GUIDED chapter
   * (missions 1–3, `DebrisField.isGuidedChapter()` → the profile's
   * `guidedCluster` flag): there the welcome cluster is the whole mission. All
   * seven pieces are authored AHEAD of the mother since the T1 cone fan (the
   * pre-T1 layout put #4/#6 behind), but a player who overshoots, turns, or is
   * moved by an unforeseen impulse can still leave the whole cluster outside
   * the forward arc — and a silent reticle reads as "the debris vanished".
   * With a target selected, the off-screen arrow (TargetReticle, behind-camera
   * via _getEdgePosition) points at it and the OUT OF RANGE state says
   * "press A". From mission 4 on the arc rule stands (pieces drift; accepted
   * there).
   *
   * Cost: one extra O(n) getDebrisNear pass, only on frames with no target
   * and an empty arc. Note DebrisField's same-frame query cache keys on
   * "same/smaller radius" — a later, smaller same-frame query reuses this
   * wider result set (pre-existing cache semantics; callers filter by
   * distance where it matters).
   *
   * @param {{x:number,y:number,z:number}} playerPos — scene units
   * @param {object} cfg — Constants.AUTOLOCK
   * @returns {object|null} the nearest alive snapshot, or null
   */
  _guidedFallbackPick(playerPos, cfg) {
    if (cfg.GUIDED_FALLBACK_ANY_ARC === false) return null;
    // Older / minimal DebrisField mocks may lack the predicate → not guided.
    const field = this._debrisField;
    if (!field || typeof field.isGuidedChapter !== 'function' || !field.isGuidedChapter()) return null;
    const rangeM = Number.isFinite(cfg.GUIDED_FALLBACK_RANGE_M) ? cfg.GUIDED_FALLBACK_RANGE_M : 100000;
    const radiusScene = (rangeM / 1000) * Constants.SCENE_SCALE; // m→km→scene
    const anywhere = field.getDebrisNear(playerPos, radiusScene);
    if (!anywhere || anywhere.length === 0) return null;
    // Sorted nearest-first; the first alive, uncaptured entry is the pick.
    for (const d of anywhere) {
      if (d && d.alive && !d._captured) return d;
    }
    return null;
  }

  /** @private Emit IN/OUT range crossings for the selected target. */
  _trackRange(active) {
    // Hot path (runs every frame while a target is locked): read the live
    // position vector directly to honor this module's allocation-free contract.
    // PlayerSatellite.getPosition() clones a THREE.Vector3 — only used as a
    // fallback for duck-typed players that don't expose `.position`.
    const playerPos = this._player.position
      || (this._player.getPosition && this._player.getPosition());
    const sp = active._scenePosition || this._targetScenePos(active);
    if (!playerPos || !sp) return;

    if (active.id !== this._rangeTargetId) {
      this._rangeTargetId = active.id;
      this._lastRangeState = null;
    }

    const dx = sp.x - playerPos.x;
    const dy = sp.y - playerPos.y;
    const dz = sp.z - playerPos.z;
    const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distM = (distScene / Constants.SCENE_SCALE) * 1000;
    const netRangeM = Constants.NET_LOCK_RANGE_M || 90;
    const inRange = distM <= netRangeM;
    const state = inRange ? 'in' : 'out';

    // P6 — throttled (~4 Hz) range readout feeding the audio range-ticker. Only
    // meaningful while out of net range (the closing approach); the in-range
    // lock ping takes over inside netRangeM. AudioSystem kills the ticker on
    // capture/clear/in-range, so a coarse emit here is enough.
    const nowMs = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    if (!inRange && (nowMs - (this._lastRangeEmit || 0) >= 250)) {
      this._lastRangeEmit = nowMs;
      eventBus.emit(Events.TARGET_RANGE, { id: active.id, distM, netRangeM });
    }

    if (state === this._lastRangeState) return;
    this._lastRangeState = state;

    if (inRange) {
      // autoLock: this crossing came from the automatic assist (not a manual
      // pick), so the audio layer suppresses the lock earcon — an unprompted
      // ping teaches the player nothing.
      eventBus.emit(Events.TARGET_IN_RANGE, { id: active.id, distanceM: distM, autoLock: !this._manualOverride });
    } else {
      eventBus.emit(Events.TARGET_OUT_OF_RANGE, { id: active.id, distanceM: distM });
    }
  }

  /** @private Resolve a target's scene position via TargetSelector helper.
   *  Returns a shared scratch object (do not retain across frames) or null. */
  _targetScenePos(active) {
    const p = targetSelector.getActiveTargetPosition
      ? targetSelector.getActiveTargetPosition()
      : null;
    if (!p) return null;
    this._scenePosScratch.x = p.x;
    this._scenePosScratch.y = p.y;
    this._scenePosScratch.z = p.z;
    return this._scenePosScratch;
  }

  /** @private Normalize a {x,y,z} into the shared forward scratch; returns it,
   *  or null if zero-length. Do not retain the result across frames. */
  _normalize(v) {
    if (!v) return null;
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (!(len > 1e-9)) return null;
    this._fwdScratch.x = v.x / len;
    this._fwdScratch.y = v.y / len;
    this._fwdScratch.z = v.z / len;
    return this._fwdScratch;
  }
}

export default AutoLockController;

// CJS guard for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutoLockController };
}
