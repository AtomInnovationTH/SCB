/**
 * TargetAcquisition.js — the single "acquire the best contact" helper.
 *
 * Unifies every *programmatic* acquire (AutoLockController's in-arc pick, AutopilotSystem's reacquire,
 * InputManager's Shift+N/Shift+A) behind one rule: the top of `DebrisField.getEnhancedTargetList`, the same list
 * the Tracked Targets pane renders, so the pane highlight and every verb (N / D / A) agree on the target.
 *
 * Two entry points:
 *   1. `acquireBestTarget(context)` — scan auto-select, autopilot's no-target fallback, Shift+N, Shift+A. Fill
 *      decisions (never stomp a live selection) are the caller's concern except for the scan listener.
 *   2. `SCAN_REVEALS_SETTLED` listener — the "I'm lost, help" flow: after a scan settles, if nothing is selected
 *      and the pane has contacts, select the best and post a context-aware verb hint (N/D in range, A out of range).
 *
 * Notes (mirrors AutoLockController / NavRecoveryAdvisor):
 *   - `_suppressLockSound:true` on the setTarget context keeps the lock earcon honest: AutoLockController's range
 *     tracker re-fires the cue on the in-range crossing (rationale in AutoLockController's header).
 *   - `autoAcquire:true` marks the selection as programmatic so AutoLockController does not treat it as a manual override.
 *   - Every dependency is null-safe for headless Node tests; singleton + `init(deps)` wiring (NavRecoveryAdvisor).
 *
 * @module systems/TargetAcquisition
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { formatDistanceKm } from './NavRecoveryAdvisor.js';
import { motherNWorks, motherNHeldBack } from './netRouting.js';

// Min seconds between scan-sourced verb hints.
const VERB_HINT_COOLDOWN_S = 30;

/** Sources that pick on the player's behalf (range-bounded); everything else is the player's own pick. */
const AUTOMATIC_SOURCES = new Set(['scan', 'autopilot_reacquire']);

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

    /** ms timestamp of the last scan-sourced verb hint. */
    this._lastVerbHintAt = -Infinity;

    this._onRevealsSettled = this._onRevealsSettled.bind(this);
    this._unsubs = [];
  }

  /** @param {object} deps every field optional / null-safe: player, debrisField, sensorSystem, targetSelector, hud,
   *  targetReticle, navSphere, debrisWireframe, skillsSystem (canFireHint/noteNudgeShown), guidanceDirector (isMinimal). */
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


  /**
   * The pane's eligible contacts: `getEnhancedTargetList` (discovered-only, welcomeSpawn-gated on M1; TPI/near sorted
   * upstream) filtered by the tracked/IR rule: only tracked debris unless the IR Scanner is active (mirrors
   * InputManager._cycleTarget). O(N) per call (full debris list + a ΔV estimate per entry): event-driven callers
   * only, NEVER per frame. Returns entries best-first, or [].
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

  /**
   * Select the best eligible contact (top of the pane list) and sync every selection consumer (pane/wireframe
   * self-heal from TARGET_SELECTED; NavSphere and HUD need explicit setSelectedTarget). Fill-only callers guard on
   * targetSelector.getActiveTarget(). `context` merges into the setTarget context (add a `source` tag for tracing);
   * `eligible` is an optional precomputed list. Returns the debris object, or null when empty / deps unavailable.
   */
  acquireBestTarget(context = {}, eligible = null) {
    if (!this._targetSelector || typeof this._targetSelector.setTarget !== 'function') return null;
    const list = Array.isArray(eligible) ? eligible : this.getEligibleTargets();
    if (list.length === 0) return null;

    // An AUTOMATIC pick stays within AUTOLOCK.RANGE_M (a 385 km auto-pick emptied the argon). `maxRangeM` is read here
    // and kept out of the setTarget context; the two automatic sources default to AUTOLOCK.RANGE_M, a player's own
    // pick (e.g. 'shift_n') is unbounded.
    const { maxRangeM: explicitRangeM, ...ctx } = context;
    const maxRangeM = Number.isFinite(explicitRangeM)
      ? explicitRangeM
      : (AUTOMATIC_SOURCES.has(ctx.source) ? Constants.AUTOLOCK.RANGE_M : Infinity);
    // best rank first (near-first on M1, TPI later) among entries in range
    const t = maxRangeM === Infinity ? list[0] : list.find(e => e.distanceKm * 1000 <= maxRangeM);
    if (!t) return null;
    const debris = (this._debrisField && typeof this._debrisField.getDebrisById === 'function')
      ? this._debrisField.getDebrisById(t.id)
      : null;
    if (!debris) return null;

    this._targetSelector.setTarget(debris, {
      distanceKm: t.distanceKm,
      deltaV: t.deltaV,
      autoAcquire: true,
      _suppressLockSound: true,
      ...ctx,
    });

    // Sync the consumers that don't self-heal from TARGET_SELECTED (as InputManager does after setTarget).
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


  /**
   * SCAN_REVEALS_SETTLED handler, the "I'm lost, help" flow. Fill-only: never stomps a live selection. Fires
   * regardless of the autolock Settings toggle (explicit player action); only the verb hint is gated.
   * @private
   */
  _onRevealsSettled() {
    if (!this._targetSelector || typeof this._targetSelector.getActiveTarget !== 'function') return;
    if (this._targetSelector.getActiveTarget()) return; // fill-only — respect a live pick
    const eligible = this.getEligibleTargets();
    if (eligible.length === 0) return; // nothing to fill (empty pane) — no hint

    // Reuse the list (no second O(N) rebuild). Bounded to AUTOLOCK.RANGE_M (see acquireBestTarget); the hint describes
    // the piece actually picked, not eligible[0].
    const debris = this.acquireBestTarget({ source: 'scan', maxRangeM: Constants.AUTOLOCK.RANGE_M }, eligible);
    if (!debris) return;
    this._postVerbHint(debris, eligible.find(e => e.id === debris.id) || eligible[0]);
  }


  /**
   * After a scan-sourced acquire: coach toward the next verb. In net range "[N] net · [D] daughter"; out of range
   * "[A] to approach". Gates: not minimal guidance, SkillsSystem.canFireHint for the skill, and >= VERB_HINT_COOLDOWN_S
   * since the last verb hint. `entry` is the eligible-list entry (carries distanceKm).
   * @private
   */
  _postVerbHint(debris, entry) {
    if (this._guidanceDirector && typeof this._guidanceDirector.isMinimal === 'function'
      && this._guidanceDirector.isMinimal()) {
      return;
    }

    // cooldown so scan-spamming doesn't repeat the chip
    const now = Date.now();
    if (now - this._lastVerbHintAt < VERB_HINT_COOLDOWN_S * 1000) return;

    // in range = inside the net-lock envelope (90 m)
    const distanceKm = this._resolveDistanceKm(debris, entry);
    const inRange = distanceKm != null
      && (distanceKm * 1000) <= (Constants.NET_LOCK_RANGE_M || 90);

    // Flying a daughter, N works HER tool. In range the line says "Esc, then N" (Esc leaves her), or, when Esc would
    // recall her, waits (D and A stay true). Picked now, as the hint is posted.
    const piloted = inRange && !motherNWorks();
    if (piloted && motherNHeldBack()) return;

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

    // Spacecraft (V5) voice: scan feedback is the ship talking to the pilot.
    const commsText = inRange
      ? (piloted
        ? `Contact locked: ${contactLabel}. Esc, then [N] net · [D] daughter.`
        : `Contact locked: ${contactLabel}. [N] net · [D] daughter.`)
      : `Contact locked: ${contactLabel}. [A] autopilot to close.`;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: commsText,
      priority: 'info',
      _postOnboarding: true,
    });

    eventBus.emit(Events.HINT_POSTED, {
      id: 'scan_lock_verbs',
      text: piloted ? 'In range — Esc, then N to net it.' : (inRange ? 'In range — capture it.' : 'Out of range — close in.'),
      ...(piloted ? { glyph: 'Esc' } : {}),
      keys: piloted ? ['KeyD'] : (inRange ? ['KeyN', 'KeyD'] : ['KeyA']),
      skillId,
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
    });
  }

  /** Km distance to a target: the eligible-list value if fresh, else a live scene-position measurement. @private */
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

/** Singleton (wired in main.js, imported by InputManager/AutopilotSystem). */
export const targetAcquisition = new TargetAcquisition();

export default TargetAcquisition;

// CJS guard for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TargetAcquisition, targetAcquisition };
}
