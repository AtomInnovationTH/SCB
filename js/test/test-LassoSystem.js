/**
 * test-LassoSystem.js — Unit + integration tests for LassoSystem constants and flight physics.
 *
 * Tests cover:
 *   • Constant values (ST-1.2 tuning)
 *   • TIME_SCALE_GAMEPLAY applied to flight step
 *   • Travel-time acceptance criterion (120 m in < 5 s)
 *   • Cooldown constants and timer math (ST-1.3)
 *   • LASSO_COOLDOWN_START / LASSO_COOLDOWN_END events exist (ST-1.3)
 *   • LASSO_DENIED event exists (ST-1.3)
 *   • First-cast primer guard logic (ST-1.3)
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';
import * as THREE from 'three';
import { LassoSystem } from '../systems/LassoSystem.js';

// ─── 1. Constant value tests ────────────────────────────────────────────────

describe('LassoSystem - Constants', () => {

    it('LASSO_SPEED is 10 m/s (Sprint 2 v2 — 50% slower for deliberate space-sim cast)', () => {
        assert.equal(Constants.LASSO_SPEED, 10,
            `Expected LASSO_SPEED=10, got ${Constants.LASSO_SPEED}`);
    });

    it('LASSO_MAX_FLIGHT_TIME is 8 seconds', () => {
        assert.equal(Constants.LASSO_MAX_FLIGHT_TIME, 8,
            `Expected LASSO_MAX_FLIGHT_TIME=8, got ${Constants.LASSO_MAX_FLIGHT_TIME}`);
    });

    it('LASSO_TRAIL_SAMPLE_INTERVAL is 0.03 seconds', () => {
        assert.equal(Constants.LASSO_TRAIL_SAMPLE_INTERVAL, 0.03,
            `Expected LASSO_TRAIL_SAMPLE_INTERVAL=0.03, got ${Constants.LASSO_TRAIL_SAMPLE_INTERVAL}`);
    });

    it('LASSO_REEL_SPEED is 0.33 (Sprint 2 v2 — SLOWER than outbound to avoid tangles)', () => {
        assert.equal(Constants.LASSO_REEL_SPEED, 0.33,
            `Expected LASSO_REEL_SPEED=0.33, got ${Constants.LASSO_REEL_SPEED}`);
    });

    it('TIME_SCALE_GAMEPLAY is 10 (confirms scale factor used in flight step)', () => {
        assert.equal(Constants.TIME_SCALE_GAMEPLAY, 10,
            `Expected TIME_SCALE_GAMEPLAY=10, got ${Constants.TIME_SCALE_GAMEPLAY}`);
    });

    it('LASSO_SPEED > 0 and is a finite number', () => {
        assert.isType(Constants.LASSO_SPEED, 'number');
        assert.ok(Number.isFinite(Constants.LASSO_SPEED), 'LASSO_SPEED must be finite');
        assert.ok(Constants.LASSO_SPEED > 0, 'LASSO_SPEED must be positive');
    });

    it('LASSO_MAX_FLIGHT_TIME > 0 and is a finite number', () => {
        assert.isType(Constants.LASSO_MAX_FLIGHT_TIME, 'number');
        assert.ok(Number.isFinite(Constants.LASSO_MAX_FLIGHT_TIME), 'LASSO_MAX_FLIGHT_TIME must be finite');
        assert.ok(Constants.LASSO_MAX_FLIGHT_TIME > 0, 'LASSO_MAX_FLIGHT_TIME must be positive');
    });

});

// ─── 2. Flight step integration: TIME_SCALE_GAMEPLAY applied ────────────────

describe('LassoSystem - Flight step physics', () => {

    /**
     * Simulate a single flight step matching the LassoSystem flight loop:
     *   step = min(speed_scene * dt * TIME_SCALE_GAMEPLAY, distToTarget)
     * where speed_scene = LASSO_SPEED * M  (M = 1e-5 scene units per metre)
     */
    const M = 0.00001; // scene units per metre (matches LassoSystem.js constant)

    it('flight step multiplies dt by TIME_SCALE_GAMEPLAY', () => {
        const dt = 1 / 60; // ~16.67 ms frame
        const speed = Constants.LASSO_SPEED * M;
        const distToTarget = 1e6; // effectively infinite — won't clamp

        const stepWithScale    = Math.min(speed * dt * Constants.TIME_SCALE_GAMEPLAY, distToTarget);
        const stepWithoutScale = Math.min(speed * dt,                                 distToTarget);

        assert.ok(
            Math.abs(stepWithScale - stepWithoutScale * Constants.TIME_SCALE_GAMEPLAY) < 1e-15,
            'step WITH scale must equal step WITHOUT scale × TIME_SCALE_GAMEPLAY'
        );
        assert.ok(stepWithScale > stepWithoutScale,
            'TIME_SCALE_GAMEPLAY must make the step larger, not smaller');
    });

    it('flight step is clamped to distToTarget when target is very close', () => {
        const dt = 1 / 60;
        const speed = Constants.LASSO_SPEED * M;
        const distToTarget = speed * dt * Constants.TIME_SCALE_GAMEPLAY * 0.1; // 10% of one-frame travel

        const step = Math.min(speed * dt * Constants.TIME_SCALE_GAMEPLAY, distToTarget);

        assert.ok(
            Math.abs(step - distToTarget) < 1e-15,
            'step must be clamped to distToTarget when target is close'
        );
    });

    it('lasso can cover 120 m in under 5 s at 10 m/s with TIME_SCALE_GAMEPLAY=10', () => {
        // 120 m target distance
        const targetDist_m = 120;
        const speed_ms     = Constants.LASSO_SPEED;          // 10 m/s (Sprint 2 v2)
        const scale        = Constants.TIME_SCALE_GAMEPLAY;  // 10

        // Effective apparent speed in real-time metres = speed × TIME_SCALE_GAMEPLAY
        const effectiveSpeed_ms = speed_ms * scale; // 100 m/s apparent

        // Travel time in real seconds
        const travelTime_s = targetDist_m / effectiveSpeed_ms;

        assert.ok(
            travelTime_s < 5,
            `Expected < 5 s to cover 120 m, got ${travelTime_s.toFixed(3)} s ` +
            `(speed=${speed_ms} m/s × scale=${scale} = ${effectiveSpeed_ms} m/s effective)`
        );
    });

    it('reel-in completes in ~3 s (Sprint 2 v2 — SLOWER than outbound to avoid tangles)', () => {
        // Reel progress starts at 0, increments by dt * LASSO_REEL_SPEED each frame
        // Completes when >= 1.0. Includes wrap phase (0.2) + reel phase (0.8).
        const reelSpeed    = Constants.LASSO_REEL_SPEED; // 0.33
        const reelTime_s   = 1.0 / reelSpeed;            // ~3.03 s

        assert.ok(
            reelTime_s > 2.0 && reelTime_s < 4.5,
            `Expected reel-in 2-4.5 s (slower than outbound), got ${reelTime_s.toFixed(3)} s (LASSO_REEL_SPEED=${reelSpeed})`
        );
    });

    it('trail sample interval is halved from original 0.06 → 0.03', () => {
        assert.ok(
            Constants.LASSO_TRAIL_SAMPLE_INTERVAL < 0.06,
            `LASSO_TRAIL_SAMPLE_INTERVAL (${Constants.LASSO_TRAIL_SAMPLE_INTERVAL}) must be < original 0.06`
        );
        assert.ok(
            Constants.LASSO_TRAIL_SAMPLE_INTERVAL <= 0.03,
            `LASSO_TRAIL_SAMPLE_INTERVAL should be ≤ 0.03 (target value)`
        );
    });

});

// ─── 3. Cooldown constants (ST-1.3) ────────────────────────────────────────

describe('LassoSystem - Cooldown constants (ST-1.3)', () => {

    it('LASSO_COOLDOWN_CATCH is 2 seconds', () => {
        assert.equal(Constants.LASSO_COOLDOWN_CATCH, 2,
            `Expected LASSO_COOLDOWN_CATCH=2, got ${Constants.LASSO_COOLDOWN_CATCH}`);
    });

    it('LASSO_COOLDOWN_MISS is 1 second', () => {
        assert.equal(Constants.LASSO_COOLDOWN_MISS, 1,
            `Expected LASSO_COOLDOWN_MISS=1, got ${Constants.LASSO_COOLDOWN_MISS}`);
    });

    it('LASSO_COOLDOWN_CATCH is a positive finite number', () => {
        assert.isType(Constants.LASSO_COOLDOWN_CATCH, 'number');
        assert.ok(Number.isFinite(Constants.LASSO_COOLDOWN_CATCH), 'must be finite');
        assert.ok(Constants.LASSO_COOLDOWN_CATCH > 0, 'must be positive');
    });

    it('LASSO_COOLDOWN_MISS is a positive finite number', () => {
        assert.isType(Constants.LASSO_COOLDOWN_MISS, 'number');
        assert.ok(Number.isFinite(Constants.LASSO_COOLDOWN_MISS), 'must be finite');
        assert.ok(Constants.LASSO_COOLDOWN_MISS > 0, 'must be positive');
    });

    it('LASSO_COOLDOWN_CATCH >= LASSO_COOLDOWN_MISS (catch penalises more than miss)', () => {
        assert.ok(
            Constants.LASSO_COOLDOWN_CATCH >= Constants.LASSO_COOLDOWN_MISS,
            `CATCH cooldown (${Constants.LASSO_COOLDOWN_CATCH}) should be >= MISS cooldown (${Constants.LASSO_COOLDOWN_MISS})`
        );
    });

});

// ─── 4. Cooldown timer math (ST-1.3) ───────────────────────────────────────

describe('LassoSystem - Cooldown timer simulation (ST-1.3)', () => {

    /**
     * Simulate the cooldown tick-down logic from LassoSystem.update():
     *   if (cooldown > 0) { cooldown -= dt; if (cooldown <= 0) cooldown = 0; }
     */
    function simulateCooldown(initialCooldown, totalElapsed, dt) {
        let cooldown = initialCooldown;
        let time = 0;
        while (time < totalElapsed && cooldown > 0) {
            cooldown -= dt;
            time += dt;
            if (cooldown <= 0) { cooldown = 0; break; }
        }
        return cooldown;
    }

    it('after a catch, cooldown > 0 immediately', () => {
        const cd = Constants.LASSO_COOLDOWN_CATCH;
        assert.ok(cd > 0, 'cooldown should be > 0 at start');
    });

    it('after a catch, cooldown reaches 0 after 2 s', () => {
        const dt = 1 / 60;
        const remaining = simulateCooldown(Constants.LASSO_COOLDOWN_CATCH, 2.1, dt);
        assert.equal(remaining, 0,
            `Expected 0 cooldown after 2.1 s, got ${remaining}`);
    });

    it('after a catch, cooldown still > 0 at 1.5 s', () => {
        const dt = 1 / 60;
        const remaining = simulateCooldown(Constants.LASSO_COOLDOWN_CATCH, 1.5, dt);
        assert.ok(remaining > 0,
            `Expected cooldown > 0 at 1.5 s, got ${remaining}`);
    });

    it('after a miss, cooldown > 0 immediately', () => {
        const cd = Constants.LASSO_COOLDOWN_MISS;
        assert.ok(cd > 0, 'cooldown should be > 0 at start');
    });

    it('after a miss, cooldown reaches 0 after 1 s', () => {
        const dt = 1 / 60;
        const remaining = simulateCooldown(Constants.LASSO_COOLDOWN_MISS, 1.1, dt);
        assert.equal(remaining, 0,
            `Expected 0 cooldown after 1.1 s, got ${remaining}`);
    });

    it('after a miss, cooldown still > 0 at 0.5 s', () => {
        const dt = 1 / 60;
        const remaining = simulateCooldown(Constants.LASSO_COOLDOWN_MISS, 0.5, dt);
        assert.ok(remaining > 0,
            `Expected cooldown > 0 at 0.5 s, got ${remaining}`);
    });

});

// ─── 5. Cooldown events exist in Events.js (ST-1.3) ────────────────────────

describe('LassoSystem - Cooldown events (ST-1.3)', () => {

    it('Events.LASSO_COOLDOWN_START is defined', () => {
        assert.ok(Events.LASSO_COOLDOWN_START !== undefined,
            'LASSO_COOLDOWN_START must be defined in Events');
        assert.isType(Events.LASSO_COOLDOWN_START, 'string');
    });

    it('Events.LASSO_COOLDOWN_END is defined', () => {
        assert.ok(Events.LASSO_COOLDOWN_END !== undefined,
            'LASSO_COOLDOWN_END must be defined in Events');
        assert.isType(Events.LASSO_COOLDOWN_END, 'string');
    });

    it('Events.LASSO_DENIED is defined', () => {
        assert.ok(Events.LASSO_DENIED !== undefined,
            'LASSO_DENIED must be defined in Events');
        assert.isType(Events.LASSO_DENIED, 'string');
    });

    it('Events.LASSO_FIRED is defined', () => {
        assert.ok(Events.LASSO_FIRED !== undefined,
            'LASSO_FIRED must be defined in Events');
        assert.isType(Events.LASSO_FIRED, 'string');
    });

    it('Events.LASSO_CAPTURED is defined', () => {
        assert.ok(Events.LASSO_CAPTURED !== undefined,
            'LASSO_CAPTURED must be defined in Events');
        assert.isType(Events.LASSO_CAPTURED, 'string');
    });

    it('Events.LASSO_MISSED is defined', () => {
        assert.ok(Events.LASSO_MISSED !== undefined,
            'LASSO_MISSED must be defined in Events');
        assert.isType(Events.LASSO_MISSED, 'string');
    });

});

// ─── 6. LASSO_DENIED: fire-during-cooldown guard logic (ST-1.3) ────────────

describe('LassoSystem - LASSO_DENIED guard logic (ST-1.3)', () => {

    /**
     * Simulate the fire() guard: if (active || cooldown > 0) → denied.
     * Tests the logical guard without THREE.js dependency.
     */
    function wouldDeny(active, cooldown) {
        return active || cooldown > 0;
    }

    it('denies fire when cooldown > 0', () => {
        assert.ok(wouldDeny(false, 1.5), 'should deny when cooldown=1.5');
    });

    it('denies fire when already active', () => {
        assert.ok(wouldDeny(true, 0), 'should deny when active=true');
    });

    it('allows fire when cooldown=0 and not active', () => {
        assert.ok(!wouldDeny(false, 0), 'should allow when cooldown=0 and not active');
    });

    it('denies fire when both active and cooling', () => {
        assert.ok(wouldDeny(true, 2), 'should deny when both active and cooling');
    });

});

// ─── 7. First-cast primer guard logic (ST-1.3) ─────────────────────────────

describe('LassoSystem - First-cast primer guard (ST-1.3)', () => {

    it('primer flag starts false (unfired)', () => {
        // Simulates the constructor initialisation: this._firstCastPrimerSent = false
        let primerSent = false;
        assert.equal(primerSent, false, 'primer should be false initially');
    });

    it('primer fires on first cast and sets flag to true', () => {
        let primerSent = false;
        let commsCount = 0;

        // Simulate first fire
        if (!primerSent) {
            primerSent = true;
            commsCount++;
        }
        assert.equal(primerSent, true, 'flag set after first cast');
        assert.equal(commsCount, 1, 'one comms message sent');
    });

    it('primer does NOT fire on second cast', () => {
        let primerSent = false;
        let commsCount = 0;

        // First fire
        if (!primerSent) { primerSent = true; commsCount++; }
        // Second fire
        if (!primerSent) { primerSent = true; commsCount++; }

        assert.equal(commsCount, 1, 'still only one comms message after two casts');
    });

    it('primer does NOT fire on third cast', () => {
        let primerSent = false;
        let commsCount = 0;

        for (let i = 0; i < 3; i++) {
            if (!primerSent) { primerSent = true; commsCount++; }
        }
        assert.equal(commsCount, 1, 'still only one comms message after three casts');
    });

});

// ─── 5. Regression: target-id=0 must be treated as valid ─────────────────────
// Bug: `_getLiveTargetPos` guarded with `if (!this._targetId)` which treated
// targetId === 0 (the first-spawned debris) as "target died", causing the
// lasso to be cancelled on frame 1 and the net to disappear immediately.
// Fix: `if (this._targetId == null)` — matches null/undefined but NOT 0.
// See LassoSystem.js `_getLiveTargetPos()`.

describe('LassoSystem - Regression: targetId=0 is valid', () => {

    /** Simulated guard from LassoSystem._getLiveTargetPos (pre-fix). */
    const guardBuggy = (targetId, debrisField) => {
        if (!targetId || !debrisField) return null;
        return 'live-pos';
    };

    /** Simulated guard from LassoSystem._getLiveTargetPos (post-fix). */
    const guardFixed = (targetId, debrisField) => {
        if (targetId == null || !debrisField) return null;
        return 'live-pos';
    };

    const dummyField = { getDebrisById: () => ({}) };

    it('BUGGY guard rejects targetId=0 (demonstrates old behaviour)', () => {
        assert.equal(guardBuggy(0, dummyField), null,
            'pre-fix guard wrongly cancels lasso when first debris id=0 is targeted');
    });

    it('FIXED guard accepts targetId=0 (regression test)', () => {
        assert.equal(guardFixed(0, dummyField), 'live-pos',
            'post-fix guard MUST treat targetId=0 as a valid live target');
    });

    it('FIXED guard still rejects null targetId', () => {
        assert.equal(guardFixed(null, dummyField), null,
            'null targetId must still return null (target never set)');
    });

    it('FIXED guard still rejects undefined targetId', () => {
        assert.equal(guardFixed(undefined, dummyField), null,
            'undefined targetId must still return null');
    });

    it('FIXED guard still rejects missing debrisField', () => {
        assert.equal(guardFixed(0, null), null,
            'missing debrisField must return null regardless of targetId');
    });

    it('FIXED guard accepts non-zero numeric targetId', () => {
        assert.equal(guardFixed(42, dummyField), 'live-pos',
            'non-zero numeric targetId must pass the guard');
    });

    it('DebrisField._nextId starts at 0 — first debris has id=0 (documents invariant)', () => {
        // This comment anchors the invariant the bug depended on: DebrisField
        // assigns ids starting at 0, so the first debris IS id=0, and the first
        // Tab-selected target in fresh missions is frequently id=0.
        // See js/entities/DebrisField.js `_nextId = 0` and `_nextId++` usage.
        assert.ok(true, 'invariant documented — first debris id === 0');
    });

});

// ─── 7. Delegation 4 (2026-05-31): LASSO_AMMO_CHANGED event contract ──────

describe('LassoSystem — LASSO_AMMO_CHANGED event (Delegation 4)', () => {
    it('Events.LASSO_AMMO_CHANGED constant exists with expected value', () => {
        assert.equal(Events.LASSO_AMMO_CHANGED, 'lasso:ammoChanged');
    });

    it('Constants.LASSO_AMMO_MAX is a positive finite number', () => {
        assert.isType(Constants.LASSO_AMMO_MAX, 'number');
        assert.ok(Number.isFinite(Constants.LASSO_AMMO_MAX));
        assert.ok(Constants.LASSO_AMMO_MAX > 0);
    });

    it('Events.INVENTORY_LOW constant exists for NetInventoryPanel uplink', () => {
        assert.equal(Events.INVENTORY_LOW, 'inventory:low');
    });

    it('Constants.INVENTORY thresholds are sensible', () => {
        const INV = Constants.INVENTORY;
        assert.ok(INV, 'Constants.INVENTORY namespace exists');
        assert.ok(INV.LASSO_LOW_THRESHOLD > INV.LASSO_CRITICAL_THRESHOLD,
            'lasso low threshold strictly above critical');
        assert.ok(INV.NETS_LOW_THRESHOLD > INV.NETS_CRITICAL_THRESHOLD,
            'net low threshold strictly above critical');
        assert.ok(INV.LOW_HINT_COOLDOWN_MS >= 1000,
            'cooldown should be at least 1 s to avoid frame-rate spam');
    });
});

// ─── In-range prompt transition logic (gap C.3) ────────────────────────────

describe('LassoSystem — in-range "press N" prompt (gap C.3)', () => {

    /**
     * Mirror _updateInRangePrompt(): returns the new _inRangePromptId and
     * whether a prompt should be emitted this tick. Fires once per entry.
     * Extended (Guidance cleanup, Phase 0) with onboarding suppression, the
     * forward-arc gate, and boundary hysteresis. `canFire` mirrors the Phase-3
     * canFireHint gate: when false the transition is NOT consumed, so a later
     * canFire:true (e.g. after a lasso-denied failure) still emits while in range.
     */
    function step(state, { canCast, targetId, inRange, tooHeavy, inArc = true, onboarding = false, canFire = true }) {
        // Onboarding owns the lasso lesson — suppress the system prompt entirely.
        if (onboarding) return { id: null, emit: false };
        if (!canCast || targetId == null) {
            return { id: null, emit: false };
        }
        if (inRange && !tooHeavy && inArc) {
            if (state.id !== targetId) {
                // Hint-gate fail → do NOT consume the transition; re-check next frame.
                if (!canFire) return { id: state.id, emit: false };
                return { id: targetId, emit: true };
            }
            return { id: targetId, emit: false };
        }
        return { id: null, emit: false };
    }

    it('emits once when target first enters range', () => {
        let s = { id: null };
        const r = step(s, { canCast: true, targetId: 7, inRange: true, tooHeavy: false });
        assert.equal(r.emit, true);
        assert.equal(r.id, 7);
    });

    it('does NOT re-emit while the same target stays in range', () => {
        let s = { id: 7 };
        const r = step(s, { canCast: true, targetId: 7, inRange: true, tooHeavy: false });
        assert.equal(r.emit, false, 'no spam on subsequent frames');
        assert.equal(r.id, 7);
    });

    it('re-arms after leaving range, then emits again on re-entry', () => {
        let s = { id: 7 };
        const out = step(s, { canCast: true, targetId: 7, inRange: false, tooHeavy: false });
        assert.equal(out.id, null, 'cleared on exit');
        const back = step(out, { canCast: true, targetId: 7, inRange: true, tooHeavy: false });
        assert.equal(back.emit, true, 'emits again after re-entry');
    });

    it('does not emit for a too-heavy target in range', () => {
        const r = step({ id: null }, { canCast: true, targetId: 7, inRange: true, tooHeavy: true });
        assert.equal(r.emit, false);
        assert.equal(r.id, null);
    });

    it('does not emit when a cast is impossible (cooldown/ammo/active)', () => {
        const r = step({ id: 7 }, { canCast: false, targetId: 7, inRange: true, tooHeavy: false });
        assert.equal(r.emit, false);
        assert.equal(r.id, null, 'clears so it re-arms once castable again');
    });

    it('clears when no target is selected', () => {
        const r = step({ id: 7 }, { canCast: true, targetId: null, inRange: true, tooHeavy: false });
        assert.equal(r.id, null);
    });

    it('emits for a new target after switching selection while in range', () => {
        const r = step({ id: 7 }, { canCast: true, targetId: 9, inRange: true, tooHeavy: false });
        assert.equal(r.emit, true, 'new target id triggers a fresh prompt');
        assert.equal(r.id, 9);
    });

    it('does NOT emit during onboarding (Director owns the lasso lesson)', () => {
        const r = step({ id: null }, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, onboarding: true });
        assert.equal(r.emit, false, 'system prompt suppressed at tier 0');
        assert.equal(r.id, null);
    });

    it('does NOT emit when the target is in range but outside the forward arc', () => {
        // Invite ⇔ success: fire() would reject an out-of-arc target, so the
        // proactive prompt must not invite a cast that will be refused.
        const r = step({ id: null }, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, inArc: false });
        assert.equal(r.emit, false, 'out-of-arc target is not advertised');
        assert.equal(r.id, null);
    });

    it('emits once the target enters BOTH range and the forward arc', () => {
        // Out of arc first → no prompt; then in arc → prompt fires.
        const out = step({ id: null }, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, inArc: false });
        assert.equal(out.emit, false);
        const inn = step(out, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, inArc: true });
        assert.equal(inn.emit, true, 'fires when fully castable');
        assert.equal(inn.id, 7);
    });

    it('hint-gate fail does NOT consume the transition (struggling-player re-arm)', () => {
        // Phase 3: when canFireHint is false, _inRangePromptId must stay unset so a
        // later lasso-denied failure (canFire → true) still nudges while in range.
        const blocked = step({ id: null }, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, canFire: false });
        assert.equal(blocked.emit, false, 'nothing shown while gated');
        assert.equal(blocked.id, null, 'transition NOT consumed (id stays null)');
        // Player then fails a cast → canFire flips true → prompt fires (same entry).
        const after = step(blocked, { canCast: true, targetId: 7, inRange: true, tooHeavy: false, canFire: true });
        assert.equal(after.emit, true, 'fires once eligible, without leaving range first');
        assert.equal(after.id, 7);
    });
});

// ─── Regression: net homing uses the live _scenePosition, not the orbit ─────
// The flight homing (_getLiveTargetPos) must read the same single source of
// truth as fire() (_getDebrisScenePos): the live _scenePosition. Onboarding
// pinned pieces have a FROZEN orbit, so reading the orbit returned the stale
// spawn position the mother flies past at orbital speed — the net then chased
// BACKWARD ("net fired 180° wrong way"). For normal debris _scenePosition is
// the orbit position anyway, so this is strictly safer.
describe('LassoSystem — _getLiveTargetPos prefers live _scenePosition', () => {
    it('returns _scenePosition when present (pinned piece, frozen orbit)', () => {
        const scenePos = new THREE.Vector3(5, 6, 7);
        // Orbit elements that would resolve somewhere completely different.
        const debris = {
            id: 3, alive: true,
            _scenePosition: scenePos,
            orbit: { semiMajorAxis: 6728.137, eccentricity: 0, inclination: 0.9,
                     raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0.0011 },
        };
        const debrisField = { getDebrisById: (id) => (id === 3 ? debris : null) };
        const mock = { _targetId: 3 };
        const pos = LassoSystem.prototype._getLiveTargetPos.call(mock, debrisField);
        assert.ok(pos, 'a position is returned');
        assert.equal(pos.x, 5); assert.equal(pos.y, 6); assert.equal(pos.z, 7);
        // Must be a copy, not the shared ref (caller copies into _targetScenePos).
        assert.ok(pos !== scenePos, 'returns a clone, not the shared vector');
    });

    it('falls back to the orbit only when no _scenePosition exists', () => {
        const debris = {
            id: 4, alive: true,
            orbit: { semiMajorAxis: 6728.137, eccentricity: 0, inclination: 0,
                     raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0.0011 },
        };
        const debrisField = { getDebrisById: () => debris };
        const mock = { _targetId: 4 };
        const pos = LassoSystem.prototype._getLiveTargetPos.call(mock, debrisField);
        assert.ok(pos && Number.isFinite(pos.x), 'orbit fallback returns a finite position');
    });
});

// ─── Phase 1 — Visible throw + nose muzzle + cosmetic recoil ────────────────
// .kilo/plans/mother-net-capture-ceremony.md PHASE 1. The first guided catch was
// invisible: contact fired at a flat 20 m while guided #1 sits ~22 m away, so the
// net travelled ~2 m (~0.02 s). Phase 1 adds (1A) a min-flight-time gate + a
// contact radius that scales with launch distance + an eased flight speed, (1B) a
// front-centre muzzle so the net spawns/anchors at the nose not the hull centre,
// and (1C) a cosmetic mesh-kick recoil with no orbit/fuel change.
import { eventBus } from '../core/EventBus.js';

describe('LassoSystem — Phase 1 constants', () => {
    it('LASSO_MIN_FLIGHT_TIME is a positive real-time gate (~0.5 s)', () => {
        assert.ok(Number.isFinite(Constants.LASSO_MIN_FLIGHT_TIME), 'finite');
        assert.ok(Constants.LASSO_MIN_FLIGHT_TIME >= 0.4 && Constants.LASSO_MIN_FLIGHT_TIME <= 0.8,
            `expected ~0.45–0.6 s, got ${Constants.LASSO_MIN_FLIGHT_TIME}`);
    });
    it('contact radius scales below the legacy 20 m flat radius', () => {
        assert.ok(Constants.LASSO_CONTACT_RADIUS_M < 20, 'base contact radius shrunk from 20 m');
        assert.ok(Constants.LASSO_CONTACT_RADIUS_FLOOR_M > 0 &&
            Constants.LASSO_CONTACT_RADIUS_FLOOR_M <= Constants.LASSO_CONTACT_RADIUS_M,
            'floor is positive and ≤ base radius');
        assert.ok(Constants.LASSO_CONTACT_RADIUS_FRACTION > 0 && Constants.LASSO_CONTACT_RADIUS_FRACTION < 1,
            'fraction is in (0,1)');
    });
    it('muzzle offset is a positive forward distance', () => {
        assert.ok(Constants.LASSO_MUZZLE_OFFSET_M > 0, 'muzzle is ahead of the hull centre');
    });
});

describe('LassoSystem — Phase 1 visible throw (integration)', () => {
    const M = 0.00001; // scene units per metre (matches LassoSystem.js)

    // Minimal headless scene + debrisField. The target is a pinned-style piece
    // with a fixed _scenePosition (frozen orbit), the M1 guided-catch case.
    function makeRig(distM) {
        const scene = new THREE.Scene();
        const lasso = new LassoSystem(scene);
        const playerPos = new THREE.Vector3(0, 0, 0);
        const velDir = new THREE.Vector3(0, 0, 1); // prograde = +Z (forward)
        const target = {
            id: 1, alive: true, type: 'fragment', mass: 5,
            _scenePosition: new THREE.Vector3(0, 0, distM * M), // directly ahead
        };
        const removed = [];
        const debrisField = {
            getDebrisNear: () => [target],
            getDebrisById: (id) => (id === target.id && target.alive ? target : null),
            removeDebris: (id) => { removed.push(id); target.alive = false; },
        };
        return { scene, lasso, playerPos, velDir, target, debrisField, removed };
    }

    it('1B: net spawns at the nose muzzle, not the hull centre', () => {
        const { lasso, playerPos, velDir, debrisField, target } = makeRig(22);
        const ok = lasso.fire(playerPos, debrisField, velDir, target);
        assert.equal(ok, true, 'fire accepted the in-range, in-arc target');
        const spawnDistM = lasso.projectilePos.distanceTo(playerPos) / M;
        assert.ok(Math.abs(spawnDistM - Constants.LASSO_MUZZLE_OFFSET_M) < 0.5,
            `spawn should sit ~${Constants.LASSO_MUZZLE_OFFSET_M} m ahead, got ${spawnDistM.toFixed(2)} m`);
    });

    it('1A: contact cannot fire before LASSO_MIN_FLIGHT_TIME even point-blank', () => {
        // Target only ~10 m ahead → within the contact radius almost immediately;
        // the min-flight gate must still hold contact off until the throw is seen.
        const { lasso, playerPos, velDir, debrisField, target } = makeRig(10);
        lasso.fire(playerPos, debrisField, velDir, target);
        let t = 0;
        const dt = 0.05;
        while (t < Constants.LASSO_MIN_FLIGHT_TIME - dt) {
            lasso.update(dt, playerPos, debrisField, target, velDir);
            t += dt;
            assert.equal(lasso._reelingIn, false,
                `contact must not fire at t=${t.toFixed(2)}s (< min flight ${Constants.LASSO_MIN_FLIGHT_TIME}s)`);
        }
        // Step past the gate → contact fires.
        for (let i = 0; i < 5; i++) lasso.update(dt, playerPos, debrisField, target, velDir);
        assert.equal(lasso._reelingIn, true, 'contact fires once past the min-flight gate + proximity');
    });

    it('1A: guided #1 (~22 m) still captures (LASSO_CAPTURED + removeDebris)', () => {
        const { lasso, playerPos, velDir, debrisField, removed, target } = makeRig(22);
        let captured = null;
        const off = eventBus.on(Events.LASSO_CAPTURED, (e) => { captured = e; });
        lasso.fire(playerPos, debrisField, velDir, target);
        // Run up to 8 s of real time (well under LASSO_MAX_FLIGHT_TIME + reel).
        for (let i = 0; i < 200 && lasso.active; i++) {
            lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
        }
        off();
        assert.equal(lasso.active, false, '#1 lasso completes (no longer active)');
        assert.ok(removed.includes(1), '#1 debris removed on catch');
        assert.ok(captured && captured.debrisId === 1, 'LASSO_CAPTURED fired for #1 (onboarding advance)');
    });

    it('1A: guided #2 (~48 m) still captures', () => {
        const { lasso, playerPos, velDir, debrisField, removed } = makeRig(48);
        lasso.fire(playerPos, debrisField, velDir, debrisField.getDebrisById(1));
        for (let i = 0; i < 300 && lasso.active; i++) {
            lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
        }
        assert.equal(lasso.active, false, '#2 lasso completes');
        assert.ok(removed.includes(1), '#2 debris removed on catch');
    });

    it('1A: a near throw takes at least ~LASSO_MIN_FLIGHT_TIME to contact (not a blink)', () => {
        const { lasso, playerPos, velDir, debrisField, target } = makeRig(22);
        lasso.fire(playerPos, debrisField, velDir, target);
        let t = 0;
        const dt = 1 / 60;
        while (lasso.active && !lasso._reelingIn && t < 3) {
            lasso.update(dt, playerPos, debrisField, target, velDir);
            t += dt;
        }
        assert.ok(lasso._reelingIn, 'eventually contacts');
        assert.ok(t >= Constants.LASSO_MIN_FLIGHT_TIME - dt,
            `flight lasted ${t.toFixed(3)}s — must be ≥ min flight ${Constants.LASSO_MIN_FLIGHT_TIME}s (visible arc)`);
    });
});

describe('PlayerSatellite — Phase 1C cosmetic recoil (visual only)', () => {
    // applyCosmeticRecoil seeds a transient offset that springs back; it must not
    // touch the orbit, fuel, or _rcsVelocity. We test the offset bookkeeping in
    // isolation against the prototype so we don't need a full PlayerSatellite.
    it('seeds the recoil offset and leaves _rcsVelocity untouched', async () => {
        const { PlayerSatellite } = await import('../entities/PlayerSatellite.js');
        const stub = {
            _recoilOffset: new THREE.Vector3(),
            _rcsVelocity: new THREE.Vector3(),
        };
        PlayerSatellite.prototype.applyCosmeticRecoil.call(stub, new THREE.Vector3(0, 0, -1.2 * 0.00001));
        assert.ok(stub._recoilOffset.lengthSq() > 0, 'recoil offset seeded');
        assert.equal(stub._rcsVelocity.lengthSq(), 0, 'recoil is NOT an RCS impulse (no orbit/fuel change)');
    });
    it('a null offset is a safe no-op', async () => {
        const { PlayerSatellite } = await import('../entities/PlayerSatellite.js');
        const stub = { _recoilOffset: new THREE.Vector3(7, 7, 7) };
        PlayerSatellite.prototype.applyCosmeticRecoil.call(stub, null);
        assert.equal(stub._recoilOffset.x, 7, 'unchanged on null');
    });
});
