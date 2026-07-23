/**
 * GlintSystem.js — debris attention glint (fake, sun-plausible specular flash).
 *
 * Debris tumble is a single random axis/rate quaternion (DebrisField._advanceTumble)
 * with no per-facet normals, so a real specular sun-catch can't be aligned — and
 * the initial spin feeds despin-bonus scoring, so it's off-limits to retune. This
 * system instead flashes a single camera-facing additive halo sprite on a chosen
 * debris piece. Eclipse- and geometry-gated so it reads as a genuine sun catch.
 *
 * Two policies:
 *  - DIRECTED  — during Mission 1 onboarding, when the player idles on a beat,
 *                glint the beat's resolved target debris on a repeating cadence
 *                (fills the gap left by OnboardingDirector's one-shot escalation).
 *  - AMBIENT   — post-onboarding (and between beats), when the player has had no
 *                active target for a while, occasionally glint a viable nearby
 *                piece — soft wayfinding + world liveliness.
 *
 * NOT an engine: one shared sprite, O(1) math per frame, one candidate scan per
 * ambient trigger. See .kilo/plans/1784774215497-debris-attention-glint.md.
 *
 * @module systems/GlintSystem
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { makeLightHalo } from '../scene/glowSpriteTexture.js';

export class GlintSystem {
  /**
   * @param {object} deps
   * @param {THREE.Scene}  deps.scene
   * @param {THREE.Camera} deps.camera
   * @param {object} deps.debrisField        — getDebrisById(id)
   * @param {object} deps.targetSelector      — getActiveTarget()
   * @param {object} deps.sunLight            — isPointSunlit(pos)
   * @param {object} [deps.onboardingDirector]— getActiveBeatId()
   * @param {object} [deps.targetAcquisition] — getEligibleTargets() (read-only candidate scan)
   */
  constructor({ scene, camera, debrisField, targetSelector, sunLight, onboardingDirector = null, targetAcquisition = null } = {}) {
    this._scene = scene || null;
    this._camera = camera || null;
    this._debrisField = debrisField || null;
    this._targetSelector = targetSelector || null;
    this._sunLight = sunLight || null;
    this._onboarding = onboardingDirector || null;
    this._targetAcquisition = targetAcquisition || null;

    const G = Constants.GLINT || {};
    this._enabled = !!G.ENABLED && !!scene;

    // --- shared halo sprite (one, hidden when idle) ---
    this._sprite = null;
    if (this._enabled) {
      this._sprite = makeLightHalo(G.SPRITE_COLOR, G.SPRITE_SCALE_M, G.HDR_MUL, 0);
      if (this._sprite) {
        this._sprite.name = 'DebrisGlint';
        this._sprite.visible = false;
        scene.add(this._sprite);
      } else {
        // Headless / null texture with no sprite at all → disable cleanly.
        this._enabled = false;
      }
    }

    // --- clock (accumulated ms) ---
    this._nowMs = 0;

    // --- active ping state machine ---
    this._ping = null; // { debrisId, flashIndex, phase, t }

    // --- directed policy ---
    this._directedActive = true;   // false permanently once onboarding completes
    this._beatId = null;
    this._directedIdleMs = 0;
    this._lastDirectedGlintMs = -Infinity;
    this._forceDirected = false;   // set by escalation → glint ASAP

    // --- ambient policy ---
    this._noTargetMs = 0;
    this._lastAmbientGlintMs = -Infinity;

    this._reproject = new THREE.Vector3();
    this._subs = [];
    if (this._enabled) this._bind();
  }

  // ─── EVENT WIRING ──────────────────────────────────────────────────────

  _on(evt, fn) {
    eventBus.on(evt, fn);
    this._subs.push([evt, fn]);
  }

  _bind() {
    // beat entry → start directed idle timer for this beat
    this._on('onboarding:beatEnter', (p) => {
      this._beatId = (p && p.beatId) || null;
      this._directedIdleMs = 0;
      this._forceDirected = false;
    });

    // progress signals reset the directed idle timer (player is engaged)
    const resetDirected = () => { this._directedIdleMs = 0; this._forceDirected = false; };
    this._on(Events.TARGET_SELECTED, () => { resetDirected(); this._noTargetMs = 0; });
    this._on(Events.LASSO_FIRED, resetDirected);
    this._on(Events.LASSO_CONTACT, resetDirected);
    this._on(Events.DEBRIS_CAPTURED, resetDirected);

    // onboarding escalation → glint immediately (diegetic assist)
    this._on(Events.TEACHING_MOMENT_FORCE, (p) => {
      if (p && typeof p.id === 'string' && p.id.startsWith('onboarding_')) {
        this._forceDirected = true;
      }
    });

    // onboarding done → directed mode off for the rest of the session
    this._on(Events.ONBOARDING_COMPLETE, () => {
      this._directedActive = false;
      this._beatId = null;
    });

    // a piece leaving play mid-ping must abort the flash
    const abortIfActive = (p) => {
      const id = p && (p.id || p.debrisId || p.targetId);
      if (this._ping && id != null && this._ping.debrisId === id) this._endPing();
    };
    this._on(Events.DEBRIS_REMOVED, abortIfActive);
    this._on(Events.DEBRIS_CAPTURED, abortIfActive);
    this._on(Events.ARM_CAPTURED, abortIfActive);
    this._on(Events.LASSO_CAPTURED, abortIfActive);
  }

  dispose() {
    for (const [evt, fn] of this._subs) eventBus.off(evt, fn);
    this._subs.length = 0;
    if (this._sprite && this._scene) this._scene.remove(this._sprite);
    this._sprite = null;
    this._enabled = false;
  }

  // ─── UPDATE ────────────────────────────────────────────────────────────

  /** @param {number} dt — real seconds */
  update(dt) {
    if (!this._enabled) return;
    if (!(dt > 0)) dt = 0;
    this._nowMs += dt * 1000;

    // Advance an in-flight flash first (it may end this frame).
    if (this._ping) {
      this._advancePing(dt);
      if (this._ping) return; // one ping at a time — nothing else to trigger
    }

    const hasTarget = !!(this._targetSelector
      && typeof this._targetSelector.getActiveTarget === 'function'
      && this._targetSelector.getActiveTarget());

    const beatActive = this._directedActive && !!this._beatId
      && (!this._onboarding
        || typeof this._onboarding.getActiveBeatId !== 'function'
        || this._onboarding.getActiveBeatId() === this._beatId);

    if (beatActive) {
      // A live target means the player is engaged — keep the idle timer parked.
      if (hasTarget) this._directedIdleMs = 0;
      else this._directedIdleMs += dt * 1000;
      // Directed wins: ambient is fully suppressed while a beat is active.
      this._noTargetMs = 0;
      this._tryDirected();
    } else {
      // ambient no-target accrual
      if (hasTarget) this._noTargetMs = 0;
      else this._noTargetMs += dt * 1000;
      this._tryAmbient();
    }
  }

  // ─── DIRECTED POLICY ───────────────────────────────────────────────────

  _tryDirected() {
    const G = Constants.GLINT;
    const idleReady = this._directedIdleMs >= G.DIRECTED_IDLE_MS;
    if (!this._forceDirected && !idleReady) return;
    // Respect the repeat cadence (force bypasses it).
    if (!this._forceDirected
      && (this._nowMs - this._lastDirectedGlintMs) < G.DIRECTED_REPEAT_MS) return;

    const debris = this._resolveDirectedTarget();
    if (!debris) return; // no candidate yet — retry next tick

    // A candidate was resolved (the O(N) scan ran), so consume the repeat
    // cadence NOW — even if the gate below fails. Otherwise a persistently
    // eclipsed/off-screen target would re-run the scan every frame (the gate
    // never refreshes the timestamp), defeating the "one scan per trigger"
    // budget. Force is cleared here too so it can't bypass the cadence forever.
    this._forceDirected = false;
    this._lastDirectedGlintMs = this._nowMs;

    const pos = debris._scenePosition;
    if (!this._gateSunlit(pos)) return;      // eclipse → retry next repeat tick
    if (!this._onScreen(pos, true)) return;  // off-screen → reticle arrow covers it

    this._startPing(debris.id);
  }

  /**
   * Beats carry no debris id, so proxy the beat's target the same way main.js
   * does: the live selection if any, else the best eligible (near-first on M1).
   * @returns {object|null} debris object with `_scenePosition`
   */
  _resolveDirectedTarget() {
    const active = this._targetSelector && typeof this._targetSelector.getActiveTarget === 'function'
      ? this._targetSelector.getActiveTarget() : null;
    if (active && active.id != null && active._scenePosition) return active;
    const list = this._eligible();
    for (const t of list) {
      const d = this._debrisField.getDebrisById(t.id);
      if (d && d._scenePosition && !d._capturedByArm) return d;
    }
    return null;
  }

  // ─── AMBIENT POLICY ────────────────────────────────────────────────────

  _tryAmbient() {
    const G = Constants.GLINT;
    if (this._noTargetMs < G.AMBIENT_NO_TARGET_MS) return;
    if ((this._nowMs - this._lastAmbientGlintMs) < G.AMBIENT_MIN_GAP_MS) return;

    // Preconditions met and we're about to run the O(N) candidate scan — consume
    // the min-gap cadence NOW so a failed pick (all pieces eclipsed/off-screen/
    // out of range) throttles the next scan to AMBIENT_MIN_GAP_MS instead of
    // re-scanning every frame.
    this._lastAmbientGlintMs = this._nowMs;

    const debris = this._pickAmbientCandidate();
    if (!debris) return;

    this._noTargetMs = 0; // re-accrue toward the next eligibility window
    this._startPing(debris.id);
  }

  /**
   * Pick a visible, sunlit, capturable piece within range, weighted toward the
   * nearest. One O(N) scan (the eligible list) per trigger — never per frame.
   * @returns {object|null} debris object
   */
  _pickAmbientCandidate() {
    const G = Constants.GLINT;
    const maxKm = G.AMBIENT_MAX_RANGE_M / 1000;
    const list = this._eligible();

    const cands = [];
    for (const t of list) {
      if (t.distanceKm != null && t.distanceKm > maxKm) continue;
      const d = this._debrisField.getDebrisById(t.id);
      if (!d || !d._scenePosition || d._capturedByArm) continue;
      const pos = d._scenePosition;
      if (!this._gateSunlit(pos)) continue;
      if (!this._onScreen(pos, true)) continue;
      cands.push(d);
      if (cands.length >= 8) break; // enough to weight; keep it cheap
    }
    if (cands.length === 0) return null;

    // Weight the nearest (list[0]-ordered → cands[0]) more heavily.
    const weights = cands.map((_, i) => (i === 0 ? G.AMBIENT_NEAR_WEIGHT : 1));
    let total = 0;
    for (const w of weights) total += w;
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  /** Read-only best-first candidate list (or []). */
  _eligible() {
    if (this._targetAcquisition && typeof this._targetAcquisition.getEligibleTargets === 'function') {
      const list = this._targetAcquisition.getEligibleTargets();
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ─── GATING ────────────────────────────────────────────────────────────

  _gateSunlit(pos) {
    if (!Constants.GLINT.REQUIRE_SUNLIT) return true;
    if (!pos || !this._sunLight || typeof this._sunLight.isPointSunlit !== 'function') return true;
    return this._sunLight.isPointSunlit(pos);
  }

  /**
   * Frustum + edge test.
   * @param {THREE.Vector3} pos
   * @param {boolean} applyEdge — skip pieces already dead-center (no need to glint)
   * @returns {boolean} true if the piece should be glinted
   */
  _onScreen(pos, applyEdge) {
    if (!pos || !this._camera) return false;
    const ndc = this._reproject.copy(pos).project(this._camera);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1) return false;
    if (applyEdge && Math.max(Math.abs(ndc.x), Math.abs(ndc.y)) < Constants.GLINT.EDGE_NDC_MIN) return false;
    return true;
  }

  // ─── FLASH ENVELOPE ────────────────────────────────────────────────────

  _startPing(debrisId) {
    if (!this._sprite) return;
    this._ping = { debrisId, flashIndex: 0, phase: 'attack', t: 0 };
    this._sprite.visible = true;
    this._sprite.material.opacity = 0;
  }

  _endPing() {
    this._ping = null;
    if (this._sprite) {
      this._sprite.visible = false;
      this._sprite.material.opacity = 0;
    }
  }

  _advancePing(dt) {
    const G = Constants.GLINT;
    const p = this._ping;

    // Re-validate the piece every frame; abort if it left play or got eclipsed.
    const d = this._debrisField ? this._debrisField.getDebrisById(p.debrisId) : null;
    if (!d || !d._scenePosition || d._capturedByArm) { this._endPing(); return; }
    if (!this._gateSunlit(d._scenePosition)) { this._endPing(); return; }
    // Mid-ping we only abort if the piece leaves the frustum entirely (no edge test).
    if (!this._onScreen(d._scenePosition, false)) { this._endPing(); return; }

    // Pin the sprite to the live scene position.
    this._sprite.position.copy(d._scenePosition);

    p.t += dt;
    const base = G.SPRITE_SCALE_M;

    if (p.phase === 'attack') {
      const k = G.FLASH_ATTACK_S > 0 ? Math.min(p.t / G.FLASH_ATTACK_S, 1) : 1;
      this._sprite.material.opacity = k;
      // slight scale overshoot on attack → sparkle feel (1.3× → 1.0×)
      const s = base * (1 + 0.3 * (1 - k));
      this._sprite.scale.set(s, s, s);
      if (k >= 1) { p.phase = 'decay'; p.t = 0; }
    } else if (p.phase === 'decay') {
      const k = G.FLASH_DECAY_S > 0 ? Math.min(p.t / G.FLASH_DECAY_S, 1) : 1;
      this._sprite.material.opacity = 1 - k;
      this._sprite.scale.set(base, base, base);
      if (k >= 1) {
        p.flashIndex++;
        if (p.flashIndex >= G.FLASHES_PER_PING) { this._endPing(); return; }
        p.phase = 'gap'; p.t = 0;
        this._sprite.material.opacity = 0;
      }
    } else { // gap
      this._sprite.material.opacity = 0;
      if (p.t >= G.FLASH_GAP_S) { p.phase = 'attack'; p.t = 0; }
    }
  }
}

export default GlintSystem;
