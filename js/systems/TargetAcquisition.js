/**
 * TargetAcquisition.js — the single "acquire the best contact" helper.
 *
 * The game historically shipped three divergent "nearest target" definitions
 * (AutoLockController's in-arc pick, AutopilotSystem's mass-based reacquire, and
 * InputManager's TPI-list Shift+N/Shift+A). This module unifies every
 * *programmatic* acquire behind one rule — the top of
 * [`DebrisField.getEnhancedTargetList`](js/entities/DebrisField.js:2825), the
 * same list the Tracked Targets pane renders — so the pane highlight and every
 * verb (N / D / A) always agree on the same target.
 *
 * Two entry points:
 *   1. `acquireBestTarget(context)` — used by scan auto-select, autopilot's
 *      no-target fallback, Shift+N, and Shift+A. Fill decisions (never stomp a
 *      live selection) are the caller's concern except for the scan listener.
 *   2. `SCAN_REVEALS_SETTLED` listener — the "I'm lost, help" flow: after a scan
 *      settles, if nothing is selected and the pane has contacts, auto-select
 *      the best one and post a context-aware verb hint (N/D in range, A out of
 *      range).
 *
 * Design notes (mirrors AutoLockController / NavRecoveryAdvisor):
 *   - `_suppressLockSound:true` on the setTarget context keeps the lock earcon
 *     honest — AutoLockController's range tracker re-fires the cue on the
 *     in-range crossing (same rationale as AutoLockController.js:213-221).
 *   - `autoAcquire:true` marks the selection as programmatic so AutoLockController
 *     does not treat it as a manual override.
 *   - Every dependency is null-safe for headless Node tests.
 *   - Singleton + `init(deps)` wiring pattern (NavRecoveryAdvisor).
 *
 * @module systems/TargetAcquisition
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { formatDistanceKm } from './NavRecoveryAdvisor.js';

/** Min seconds between scan-sourced verb hints (module-local cooldown). */
const VERB_HINT_COOLDOWN_S = 30;

export class TargetAcquisition {
  constructor() {
    this._player = null;
    this._debrisField = null;
    this._sensorSystem = null;
    this._targetSelector = null;
    this._hud = null;
    this._targetReticle = null;
    this._navSphere = null;
    this._debrisWireframe = null;
    this._skillsSystem = null;
    this._guidanceDirector = null;

    /** @type {number} timestamp (ms) of the last scan-sourced verb hint. */
    this._lastVerbHintAt = -Infinity;

    this._onRevealsSettled = this._onRevealsSettled.bind(this);
    this._unsubs = [];
  }

  /**
   * @param {object} deps — every field is optional / null-safe.
   * @param {object} [deps.player]           — getPosition/getOrbitalElements
   * @param {object} [deps.debrisField]      — getEnhancedTargetList/getDebrisById
   * @param {object} [deps.sensorSystem]     — canDetectUntracked flag
   * @param {object} [deps.targetSelector]   — getActiveTarget/setTarget
   * @param {object} [deps.hud]              — setSelectedTarget
   * @param {object} [deps.targetReticle]    — setSelectedTarget
   * @param {object} [deps.navSphere]        — setSelectedTarget
   * @param {object} [deps.debrisWireframe]  — setTarget
   * @param {object} [deps.skillsSystem]     — canFireHint/noteNudgeShown
   * @param {object} [deps.guidanceDirector] — isMinimal
   */
  init(deps = {}) {
    this._player = deps.player || null;
    this._debrisField = deps.debrisField || null;
    this._sensorSystem = deps.sensorSystem || null;
    this._targetSelector = deps.targetSelector || null;
    this._hud = deps.hud || null;
    this._targetReticle = deps.targetReticle || null;
    this._navSphere = deps.navSphere || null;
    this._debrisWireframe = deps.debrisWireframe || null;
    this._skillsSystem = deps.skillsSystem || null;
    this._guidanceDirector = deps.guidanceDirector || null;

    if (Events.SCAN_REVEALS_SETTLED) {
      const u = eventBus.on(Events.SCAN_REVEALS_SETTLED, this._onRevealsSettled);
      if (typeof u === 'function') this._unsubs.push(u);
    }
  }

  dispose() {
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }

  reset() {
    this._lastVerbHintAt = -Infinity;
  }

  // ─── ELIGIBLE LIST ───────────────────────────────────────────────────────

  /**
   * The pane's eligible contacts: `getEnhancedTargetList` (discovered-only,
   * M1-clamped, TPI/near sorted upstream) filtered by the tracked/IR rule —
   * only tracked debris unless the IR Scanner is active. Exact logic mirrors
   * InputManager._cycleTarget (js/systems/InputManager.js:1358-1363).
   *
   * Cost note: `getEnhancedTargetList` walks the full debris list and computes
   * a ΔV estimate per discovered entry — this is O(N) per call. All callers are
   * event-driven (scan settle, Shift+N/Shift+A, autopilot fallback); do NOT
   * call this per-frame.
   * @returns {Array<object>} eligible list entries (sorted best-first) or [].
   */
  getEligibleTargets() {
    if (!this._debrisField || typeof this._debrisField.getEnhancedTargetList !== 'function') return [];
    if (!this._player || typeof this._player.getPosition !== 'function') return [];
    try {
      const list = this._debrisField.getEnhancedTargetList(
        this._player.getPosition(),
        typeof this._player.getOrbitalElements === 'function' ? this._player.getOrbitalElements() : null
      );
      if (!Array.isArray(list)) return [];
      const canDetect = !!(this._sensorSystem && this._sensorSystem.canDetectUntracked);
      return list.filter(t => t && (t.tracked !== false || canDetect));
    } catch (err) {
      console.error('[target-acquisition] eligible list error:', err);
      return [];
    }
  }

  // ─── ACQUIRE ─────────────────────────────────────────────────────────────

  /**
   * Select the best eligible contact (top of the pane list) and sync every
   * selection consumer (pane/wireframe self-heal from TARGET_SELECTED; NavSphere
   * and HUD need explicit setSelectedTarget). Idempotent-friendly: callers that
   * want fill-only behavior should guard on targetSelector.getActiveTarget().
   *
   * @param {object} [context={}] — merged into the setTarget context; add a
   *        `source` tag ('scan'|'autopilot_reacquire'|'shift_n'...) for tracing.
   * @param {Array<object>} [eligible] — optional precomputed eligible list
   *        (from getEligibleTargets) to avoid recomputing the O(N) pane list.
   * @returns {object|null} the selected debris object, or null when the list is
   *        empty / deps unavailable.
   */
  acquireBestTarget(context = {}, eligible = null) {
    if (!this._targetSelector || typeof this._targetSelector.setTarget !== 'function') return null;
    const list = Array.isArray(eligible) ? eligible : this.getEligibleTargets();
    if (list.length === 0) return null;

    const t = list[0]; // best rank (near-first on M1, TPI later)
    const debris = (this._debrisField && typeof this._debrisField.getDebrisById === 'function')
      ? this._debrisField.getDebrisById(t.id)
      : null;
    if (!debris) return null;

    this._targetSelector.setTarget(debris, {
      distanceKm: t.distanceKm,
      deltaV: t.deltaV,
      autoAcquire: true,
      _suppressLockSound: true,
      ...context,
    });

    // Sync the consumers that don't self-heal from TARGET_SELECTED
    // (same block as InputManager.js:1404-1408). Null-safe on each.
    if (this._debrisWireframe && typeof this._debrisWireframe.setTarget === 'function') {
      this._debrisWireframe.setTarget(debris);
    }
    if (this._hud && typeof this._hud.setSelectedTarget === 'function') {
      this._hud.setSelectedTarget(t.id);
    }
    if (this._targetReticle && typeof this._targetReticle.setSelectedTarget === 'function') {
      this._targetReticle.setSelectedTarget(t.id);
    }
    if (this._navSphere && typeof this._navSphere.setSelectedTarget === 'function') {
      this._navSphere.setSelectedTarget(t.id);
    }

    return debris;
  }

  // ─── SCAN AUTO-SELECT ──────────────────────────────────────────────────────

  /**
   * SCAN_REVEALS_SETTLED handler — the "I'm lost, help" flow. Fill-only: never
   * stomps a live selection. Fires regardless of the autolock Settings toggle
   * (explicit player action, same policy as the autopilot fallback / recovery
   * advisor). The selection always happens; only the verb hint is gated.
   * @private
   */
  _onRevealsSettled() {
    if (!this._targetSelector || typeof this._targetSelector.getActiveTarget !== 'function') return;
    if (this._targetSelector.getActiveTarget()) return; // fill-only — respect a live pick
    const eligible = this.getEligibleTargets();
    if (eligible.length === 0) return; // nothing to fill (empty pane) — no hint

    // Reuse the list we just computed — avoids a second O(N) pane rebuild.
    const debris = this.acquireBestTarget({ source: 'scan' }, eligible);
    if (!debris) return;
    this._postVerbHint(debris, eligible[0]);
  }

  // ─── CONTEXT-AWARE VERB HINT ───────────────────────────────────────────────

  /**
   * After a scan-sourced acquire: coach the player toward the right next verb.
   * In net range → "[N] net · [D] daughter"; out of range → "[A] to approach".
   * Gating (all must pass): not minimal guidance, SkillsSystem.canFireHint for
   * the relevant skill, and ≥ VERB_HINT_COOLDOWN_S since the last verb hint.
   * @param {object} debris — the just-selected debris object
   * @param {object} entry  — its eligible-list entry (carries distanceKm)
   * @private
   */
  _postVerbHint(debris, entry) {
    // Minimal-guidance players get no ticker coaching.
    if (this._guidanceDirector && typeof this._guidanceDirector.isMinimal === 'function'
      && this._guidanceDirector.isMinimal()) {
      return;
    }

    // Module-local cooldown so scan-spamming doesn't repeat the chip.
    const now = Date.now();
    if (now - this._lastVerbHintAt < VERB_HINT_COOLDOWN_S * 1000) return;

    // Distance → in-range test against the net-lock envelope (90 m).
    const distanceKm = this._resolveDistanceKm(debris, entry);
    const inRange = distanceKm != null
      && (distanceKm * 1000) <= (Constants.NET_LOCK_RANGE_M || 90);

    const skillId = inRange ? 'collect_lasso' : 'nav_autopilot';
    if (this._skillsSystem && typeof this._skillsSystem.canFireHint === 'function'
      && !this._skillsSystem.canFireHint(skillId)) {
      return;
    }

    this._lastVerbHintAt = now;
    if (this._skillsSystem && typeof this._skillsSystem.noteNudgeShown === 'function') {
      this._skillsSystem.noteNudgeShown(skillId);
    }

    const type = debris.type || 'contact';
    const distStr = distanceKm != null ? formatDistanceKm(distanceKm) : '';
    const contactLabel = distStr ? `${type} ${distStr}` : type;

    // Spacecraft (V5) voice — scan feedback is the ship talking to the pilot.
    const commsText = inRange
      ? `Contact locked: ${contactLabel}. [N] net · [D] daughter.`
      : `Contact locked: ${contactLabel}. [A] autopilot to close.`;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: commsText,
      priority: 'info',
      _postOnboarding: true,
    });

    // Ticker chip so the key glyphs render in the HintTicker.
    eventBus.emit(Events.HINT_POSTED, {
      id: 'scan_lock_verbs',
      text: inRange ? 'In range — capture it.' : 'Out of range — close in.',
      keys: inRange ? ['KeyN', 'KeyD'] : ['KeyA'],
      skillId,
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
    });
  }

  /**
   * Resolve the km distance to a target, preferring the freshly-computed
   * eligible-list value and falling back to a live scene-position measurement.
   * @private
   * @returns {number|null}
   */
  _resolveDistanceKm(debris, entry) {
    if (entry && Number.isFinite(entry.distanceKm)) return entry.distanceKm;
    if (!this._player || typeof this._player.getPosition !== 'function') return null;
    const pp = this._player.getPosition();
    const sp = debris && debris._scenePosition;
    if (!pp || !sp) return null;
    const dx = sp.x - pp.x;
    const dy = sp.y - pp.y;
    const dz = sp.z - pp.z;
    const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distScene / (Constants.SCENE_SCALE || 0.01);
  }
}

/** Singleton instance (wired in main.js, imported by InputManager/AutopilotSystem). */
export const targetAcquisition = new TargetAcquisition();

export default TargetAcquisition;

// CJS guard for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TargetAcquisition, targetAcquisition };
}
