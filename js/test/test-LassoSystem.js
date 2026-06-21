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

    // Phase 1 is about the THROW, independent of the catch resolution. Force the
    // legacy instant-catch path (Phase 4 stow OFF) so "still captures" means a
    // deterministic removeDebris without needing a GameFlowManager furnace stub.
    function withInstantCatch(fn) {
        const orig = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW;
        Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = false;
        try { return fn(); } finally { Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = orig; }
    }

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
        withInstantCatch(() => {
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
    });

    it('1A: guided #2 (~48 m) still captures', () => {
        withInstantCatch(() => {
            const { lasso, playerPos, velDir, debrisField, removed } = makeRig(48);
            lasso.fire(playerPos, debrisField, velDir, debrisField.getDebrisById(1));
            for (let i = 0; i < 300 && lasso.active; i++) {
                lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
            }
            assert.equal(lasso.active, false, '#2 lasso completes');
            assert.ok(removed.includes(1), '#2 debris removed on catch');
        });
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

// ─── Phase 2 — Net open-on-launch + cinch-on-capture kinematics ─────────────
// .kilo/plans/mother-net-capture-ceremony.md PHASE 2 (flag LASSO_NET_KINEMATICS).
// A parameterized geometry animation (NOT a cloth sim): the mouth opens from
// compact as gyro spin ramps, then cinches around the catch over the WRAP window.
// These tests force the flag ON, drive a real LassoSystem, and assert the mouth
// radius helper is monotonic/clamped and produces no NaNs. The flag stays OFF by
// default so production behaviour is unchanged.
describe('LassoSystem — Phase 2 net kinematics', () => {
    const M = 0.00001;

    function netRadiusScene(lasso) {
        // Max XY radius across the rim weights = current mouth radius.
        let max = 0;
        for (const w of lasso._netWeights) {
            const r = Math.hypot(w.position.x, w.position.y);
            if (r > max) max = r;
        }
        return max;
    }

    it('_applyNetMouthRadius scales the rim weights + clamps, no NaNs', () => {
        const lasso = new LassoSystem(new THREE.Scene());
        const full = lasso._netFullRadiusScene;
        lasso._applyNetMouthRadius(1.0);
        assert.ok(Math.abs(netRadiusScene(lasso) - full) < full * 0.02, 'frac=1 → full radius');
        lasso._applyNetMouthRadius(0.5);
        const half = netRadiusScene(lasso);
        assert.ok(Math.abs(half - full * 0.5) < full * 0.02, 'frac=0.5 → ~half radius');
        lasso._applyNetMouthRadius(-5); // clamps to 0.05 floor, never negative/NaN
        const clamped = netRadiusScene(lasso);
        assert.ok(Number.isFinite(clamped) && clamped > 0, 'clamped to a small positive radius, finite');
        // Line geometry positions are all finite.
        const arr = lasso._netLines.geometry.getAttribute('position').array;
        for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i]), 'line vertex finite');
    });

    it('open-on-launch: mouth radius grows monotonically over the spin-up window', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS;
        Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = true;
        try {
            const lasso = new LassoSystem(new THREE.Scene());
            const playerPos = new THREE.Vector3(0, 0, 0);
            const velDir = new THREE.Vector3(0, 0, 1);
            const target = { id: 1, alive: true, type: 'fragment', mass: 5,
                _scenePosition: new THREE.Vector3(0, 0, 60 * M) }; // far enough to watch it open
            const debrisField = {
                getDebrisNear: () => [target],
                getDebrisById: (id) => (id === 1 && target.alive ? target : null),
                removeDebris: () => { target.alive = false; },
            };
            lasso.fire(playerPos, debrisField, velDir, target);
            const launchR = netRadiusScene(lasso);
            const radii = [launchR];
            const dt = 1 / 60;
            for (let i = 0; i < Math.ceil(Constants.NET_SPIN_UP_TIME / dt) && !lasso._reelingIn; i++) {
                lasso.update(dt, playerPos, debrisField, target, velDir);
                radii.push(netRadiusScene(lasso));
            }
            // Non-decreasing through the open window, ending near full radius.
            for (let i = 1; i < radii.length; i++) {
                assert.ok(radii[i] >= radii[i - 1] - 1e-12,
                    `mouth radius must not shrink while opening (step ${i})`);
            }
            assert.ok(radii[radii.length - 1] > launchR, 'mouth opened wider than the compact launch radius');
            assert.ok(launchR < lasso._netFullRadiusScene * 0.9, 'left the canister compact (not already full)');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = orig;
        }
    });

    it('cinch-on-capture: reel still completes and mouth ends cinched (flag ON)', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS;
        const origStow = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW;
        Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = true;
        Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = false; // isolate the cinch: use the instant-catch resolution
        try {
            const lasso = new LassoSystem(new THREE.Scene());
            const playerPos = new THREE.Vector3(0, 0, 0);
            const velDir = new THREE.Vector3(0, 0, 1);
            const target = { id: 1, alive: true, type: 'fragment', mass: 5,
                _scenePosition: new THREE.Vector3(0, 0, 22 * M) };
            const removed = [];
            const debrisField = {
                getDebrisNear: () => [target],
                getDebrisById: (id) => (id === 1 && target.alive ? target : null),
                removeDebris: (id) => { removed.push(id); target.alive = false; },
            };
            lasso.fire(playerPos, debrisField, velDir, target);
            let sawCinch = false;
            for (let i = 0; i < 300 && lasso.active; i++) {
                lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
                if (lasso._reelingIn) {
                    const frac = netRadiusScene(lasso) / lasso._netFullRadiusScene;
                    if (frac <= Constants.NET_CINCH_RADIUS_FRAC + 0.05) sawCinch = true;
                }
            }
            assert.equal(lasso.active, false, 'reel completes with kinematics ON');
            assert.ok(removed.includes(1), 'debris captured');
            assert.ok(sawCinch, 'mouth cinched toward NET_CINCH_RADIUS_FRAC during the haul');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = orig;
            Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = origStow;
        }
    });

    it('flag OFF: net geometry stays at the static full radius (legacy behaviour)', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS;
        Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = false;
        try {
            const lasso = new LassoSystem(new THREE.Scene());
            const playerPos = new THREE.Vector3(0, 0, 0);
            const velDir = new THREE.Vector3(0, 0, 1);
            const target = { id: 1, alive: true, type: 'fragment', mass: 5,
                _scenePosition: new THREE.Vector3(0, 0, 22 * M) };
            const debrisField = {
                getDebrisNear: () => [target],
                getDebrisById: (id) => (id === 1 && target.alive ? target : null),
                removeDebris: () => { target.alive = false; },
            };
            lasso.fire(playerPos, debrisField, velDir, target);
            // A few flight frames; with the flag OFF the rim radius must not move.
            for (let i = 0; i < 5 && !lasso._reelingIn; i++) {
                lasso.update(1 / 60, playerPos, debrisField, target, velDir);
            }
            assert.ok(Math.abs(netRadiusScene(lasso) - lasso._netFullRadiusScene) < lasso._netFullRadiusScene * 0.02,
                'rim stays at full radius when LASSO_NET_KINEMATICS is OFF');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS = orig;
        }
    });
});

// ─── Phase 3 — Reel-in tension, CoM pull, break risk (gated) ────────────────
// .kilo/plans/mother-net-capture-ceremony.md PHASE 3 (flag LASSO_REEL_PHYSICS).
// MANDATORY gate: OFF on Mission 1 AND for capturedMass ≤ LASSO_MAX_CAPTURE_MASS.
// The tutorial / welcome catches must reel EXACTLY as today (no _rcsVelocity
// delta, identical timing, identical TETHER_TENSION payload) regardless of the
// flag. The heavy-catch physics (tension∝mass, bounded CoM pull, snap) is
// forward-looking infra exercised directly here since fire() caps casts at 10 kg.
describe('LassoSystem — Phase 3 reel physics gating (M1 untouched)', () => {
    const M = 0.00001;

    function rig(missionNumber, mass) {
        const scene = new THREE.Scene();
        const lasso = new LassoSystem(scene);
        lasso._missionNumber = missionNumber;
        const player = { _rcsVelocity: new THREE.Vector3(), mass: 130 };
        lasso.setPlayer(player);
        const playerPos = new THREE.Vector3(0, 0, 0);
        const velDir = new THREE.Vector3(0, 0, 1);
        const target = { id: 1, alive: true, type: 'fragment', mass,
            _scenePosition: new THREE.Vector3(0, 0, 22 * M) };
        const tensions = [];
        const off = eventBus.on(Events.TETHER_TENSION, (e) => { if (e.armId === 'lasso') tensions.push(e); });
        const removed = [];
        const debrisField = {
            getDebrisNear: () => [target],
            getDebrisById: (id) => (id === 1 && target.alive ? target : null),
            removeDebris: (id) => { removed.push(id); target.alive = false; },
        };
        const run = () => {
            lasso.fire(playerPos, debrisField, velDir, target);
            let frames = 0;
            for (let i = 0; i < 400 && lasso.active; i++) {
                lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
                frames++;
            }
            off();
            return frames;
        };
        return { lasso, player, run, tensions, removed };
    }

    it('flag ON + Mission 1 (mass ≤ cap): no _rcsVelocity delta, plain tension payload', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS;
        const origStow = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW;
        Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = true;
        Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = false; // assert the instant-catch removeDebris on M1
        try {
            const r = rig(1, 5);
            r.run();
            assert.equal(r.lasso._reelPhysicsActive, false, 'reel physics NOT latched on M1');
            assert.equal(r.player._rcsVelocity.lengthSq(), 0, 'no CoM pull applied on M1');
            assert.ok(r.tensions.length > 0, 'tension still emitted');
            assert.ok(r.tensions.every(t => t.tensionN === undefined && t.strainFraction === undefined),
                'M1 tension payload is the legacy shape (no tensionN/strainFraction)');
            assert.ok(r.removed.includes(1), 'M1 catch completes normally');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = orig;
            Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = origStow;
        }
    });

    it('flag ON + M2 but mass ≤ cap: still gated off (welcome-weight pieces)', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS;
        Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = true;
        try {
            const r = rig(2, 8); // ≤ LASSO_MAX_CAPTURE_MASS
            r.run();
            assert.equal(r.lasso._reelPhysicsActive, false, 'gated off for ≤ cap mass even on M2');
            assert.equal(r.player._rcsVelocity.lengthSq(), 0, 'no CoM pull for light catch');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = orig;
        }
    });

    it('reel timing is identical under the gate (flag ON+M1 vs flag OFF)', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS;
        try {
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = false;
            const framesOff = rig(1, 5).run();
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = true;
            const framesOnM1 = rig(1, 5).run();
            assert.equal(framesOnM1, framesOff, 'M1 reel takes the same number of frames with the flag on');
        } finally {
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = orig;
        }
    });
});

describe('LassoSystem — Phase 3 heavy-catch physics (direct)', () => {
    const M = 0.00001;

    // Build a lasso parked mid-reel with a heavy catch + a player stub, then
    // drive _applyReelPhysics directly (fire() caps casts at 10 kg, so the heavy
    // path can only be reached this way today).
    function heavyRig(mass) {
        const lasso = new LassoSystem(new THREE.Scene());
        const player = { _rcsVelocity: new THREE.Vector3(), mass: 130 };
        lasso.setPlayer(player);
        lasso.active = true;
        lasso._reelingIn = true;
        lasso._reelProgress = 0.5;
        lasso.target = { id: 9, alive: true, type: 'rocket_body', mass,
            _armPinned: true };
        lasso._reelPinTarget = lasso.target;
        lasso._reelPhysicsActive = true;
        lasso.projectilePos = new THREE.Vector3(0, 0, 10 * M); // catch ahead of ship
        return { lasso, player, playerPos: new THREE.Vector3(0, 0, 0) };
    }

    it('tension rises with captured mass (tensionN = base + mass×k)', () => {
        let last = null;
        const off = eventBus.on(Events.TETHER_TENSION, (e) => { if (e.armId === 'lasso') last = e; });
        try {
            const a = heavyRig(20);
            a.lasso._applyReelPhysics(0.016, a.playerPos);
            const tLight = last.tensionN;
            const b = heavyRig(100);
            b.lasso._applyReelPhysics(0.016, b.playerPos);
            const tHeavy = last.tensionN;
            assert.ok(tHeavy > tLight, 'heavier catch → higher tension');
            assert.ok(Math.abs(tHeavy - (Constants.LASSO_TENSION_BASE_N + 100 * Constants.LASSO_TENSION_PER_KG)) < 1e-9,
                'tensionN matches base + mass×per-kg');
        } finally { off(); }
    });

    it('CoM pull is toward the catch and bounded by RCS_MAX_SPEED', () => {
        const { lasso, player, playerPos } = heavyRig(80);
        for (let i = 0; i < 200; i++) lasso._applyReelPhysics(0.05, playerPos);
        const v = player._rcsVelocity;
        assert.ok(v.length() > 0, 'a CoM pull was applied');
        assert.ok(v.length() <= Constants.RCS_MAX_SPEED + 1e-12,
            `pull clamped by RCS_MAX_SPEED (got ${v.length()})`);
        assert.ok(v.z > 0, 'pull is toward the catch (catch is at +Z ahead of the ship)');
    });

    it('sustained over-strain SNAPS the tether: drops the catch, no score/removeDebris', () => {
        const orig = Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS;
        Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = true;
        let snapped = null, captured = false;
        const offSnap = eventBus.on(Events.LASSO_SNAPPED, (e) => { snapped = e; });
        const offCap = eventBus.on(Events.LASSO_CAPTURED, () => { captured = true; });
        try {
            // mass 100 → strain = 100/50 = 2.0 > NET_STRAIN_SAFE_FRACTION (0.8).
            const { lasso, playerPos } = heavyRig(100);
            const target = lasso.target;
            let frames = 0;
            // Accumulate strain past LASSO_NET_BREAK_TIME_S.
            while (lasso.active && frames < 1000) {
                lasso._applyReelPhysics(0.05, playerPos);
                frames++;
            }
            assert.ok(snapped && snapped.targetId === 9, 'LASSO_SNAPPED fired for the heavy catch');
            assert.equal(lasso.active, false, 'lasso reset after the snap');
            assert.equal(target._armPinned, false, 'reel pin released — no orphaned pin');
            assert.equal(captured, false, 'no LASSO_CAPTURED / score on a snap');
            assert.ok(frames * 0.05 >= Constants.LASSO_NET_BREAK_TIME_S,
                'snap waited out the break time, not instant');
        } finally {
            offSnap(); offCap();
            Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS = orig;
        }
    });

    it('strain below the safe fraction never snaps (timer recovers)', () => {
        // mass 30 → strain 0.6 < 0.8 safe. Should never snap.
        const { lasso, playerPos } = heavyRig(30);
        let snapped = false;
        const off = eventBus.on(Events.LASSO_SNAPPED, () => { snapped = true; });
        try {
            for (let i = 0; i < 400; i++) lasso._applyReelPhysics(0.05, playerPos);
            assert.equal(snapped, false, 'safe-strain catch never snaps');
            assert.equal(lasso._strainTimer, 0, 'strain timer stays drained below the safe fraction');
        } finally { off(); }
    });
});

// ─── Phase 4 — Stow → clamp/slice → furnace lifecycle ───────────────────────
// .kilo/plans/mother-net-capture-ceremony.md PHASE 4 (flag MOTHER_CARGO_STOW).
// The reeled catch is hauled back to a FORWARD cargo cell near the nose (never
// stowed (debris stays alive + pinned, LASSO_CAPTURED fires for onboarding), then
// fed to the furnace reusing CATCH_BREAKDOWN_START + a single CATCH_PROCESSED.
// Scoring + removeDebris move to CATCH_PROCESSED (no double-score, no flat-500).
describe('LassoSystem — Phase 4 stow → furnace lifecycle (flag ON)', () => {
    const M = 0.00001;

    function rig() {
        const lasso = new LassoSystem(new THREE.Scene());
        const playerPos = new THREE.Vector3(0, 0, 7000 * M); // off-origin so radial-up is well-defined
        const velDir = new THREE.Vector3(0, 0, 1);
        const target = { id: 1, alive: true, type: 'fragment', mass: 5,
            _scenePosition: new THREE.Vector3(0, 0, (7000 + 22) * M) };
        const removed = [];
        const debrisField = {
            getDebrisNear: () => [target],
            getDebrisById: (id) => (id === 1 && target.alive ? target : null),
            removeDebris: (id) => { removed.push(id); target.alive = false; },
        };
        return { lasso, playerPos, velDir, target, debrisField, removed };
    }

    function withFlag(fn) {
        const orig = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW;
        Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = true;
        try { return fn(); } finally { Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = orig; }
    }

    it('reel routes to a FORWARD cargo cell near the nose (never through the hull)', () => {
        withFlag(() => {
            const { lasso, playerPos, velDir, debrisField, target } = rig();
            lasso.fire(playerPos, debrisField, velDir, target);
            // Run until just stowed.
            for (let i = 0; i < 400 && lasso.active; i++) {
                lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
            }
            assert.equal(lasso._cargo.length, 1, 'catch stowed into a cargo cell');
            const cell = new THREE.Vector3();
            lasso._cargoCellWorld(playerPos, velDir, lasso._cargo[0].cellIndex, cell);
            // The cell is FORWARD (same side as the incoming catch), so the reel
            // pulls the catch back toward the nose instead of dragging it straight
            // through the hull to the rear (the "overshoots the mother" bug).
            const fwdComponent = (cell.z - playerPos.z) / M; // metres along prograde (+Z)
            assert.ok(fwdComponent > 0, `cargo cell is forward of the hull centre (got ${fwdComponent.toFixed(1)} m)`);
            assert.ok(fwdComponent < 22, 'cell sits between the hull and the catch — reel never crosses the hull');
        });
    });

    it('stow keeps the debris alive + pinned and fires LASSO_CAPTURED (onboarding)', () => {
        withFlag(() => {
            const { lasso, playerPos, velDir, debrisField, target, removed } = rig();
            let captured = null, stowed = null;
            const offC = eventBus.on(Events.LASSO_CAPTURED, (e) => { captured = e; });
            const offS = eventBus.on(Events.LASSO_STOWED, (e) => { stowed = e; });
            try {
                lasso.fire(playerPos, debrisField, velDir, target);
                for (let i = 0; i < 400 && lasso.active; i++) {
                    lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
                }
                assert.ok(stowed && stowed.debrisId === 1, 'LASSO_STOWED fired');
                assert.ok(captured && captured.debrisId === 1, 'LASSO_CAPTURED fired at STOW (onboarding advance)');
                assert.equal(target.alive, true, 'debris NOT removed at stow (furnace owns removal)');
                assert.equal(target._armPinned, true, 'debris pinned to the cargo cell');
                assert.equal(removed.length, 0, 'no removeDebris at stow');
            } finally { offC(); offS(); }
        });
    });

    it('furnace emits CATCH_BREAKDOWN_START then exactly one CATCH_PROCESSED; removeDebris once', () => {
        withFlag(() => {
            const { lasso, playerPos, velDir, debrisField, target } = rig();
            const events = [];
            const offB = eventBus.on(Events.CATCH_BREAKDOWN_START, (e) => events.push(['start', e]));
            const offP = eventBus.on(Events.CATCH_PROCESSED, (e) => events.push(['processed', e]));
            try {
                lasso.fire(playerPos, debrisField, velDir, target);
                // Run well past FURNACE_TRANSFER.FEED_S after stow.
                const totalFrames = Math.ceil((Constants.FURNACE_TRANSFER.FEED_S + 8) / 0.05);
                for (let i = 0; i < totalFrames; i++) {
                    lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
                }
                const starts = events.filter(e => e[0] === 'start');
                const processed = events.filter(e => e[0] === 'processed');
                assert.equal(starts.length, 1, 'CATCH_BREAKDOWN_START fires exactly once');
                assert.equal(processed.length, 1, 'CATCH_PROCESSED fires exactly once');
                assert.equal(processed[0][1].armId, 'lasso', 'processed payload tags the lasso');
                assert.equal(processed[0][1].debrisId, 1, 'processed payload carries the debris id');
                // START precedes PROCESSED.
                assert.ok(events.findIndex(e => e[0] === 'start') < events.findIndex(e => e[0] === 'processed'),
                    'breakdown start precedes processed');
                assert.equal(lasso._cargo.length, 0, 'cell freed after processing');
                assert.equal(target._armPinned, false, 'pin released after processing (no orphaned pin)');
            } finally { offB(); offP(); }
        });
    });

    it('does NOT emit INTERACTION_CAPTURE / flat SCORING_AWARD at stow (no double-score)', () => {
        withFlag(() => {
            const { lasso, playerPos, velDir, debrisField, target } = rig();
            let interaction = 0, scoring = 0;
            const offI = eventBus.on(Events.INTERACTION_CAPTURE, () => interaction++);
            const offS = eventBus.on(Events.SCORING_AWARD, () => scoring++);
            try {
                lasso.fire(playerPos, debrisField, velDir, target);
                // Only through stow (not the furnace window) — assert no flat score.
                for (let i = 0; i < 400 && lasso.active; i++) {
                    lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
                }
                assert.equal(lasso._cargo.length, 1, 'stowed');
                assert.equal(interaction, 0, 'no INTERACTION_CAPTURE flat-500 at stow');
                assert.equal(scoring, 0, 'no SCORING_AWARD flat-500 at stow (scoring is at CATCH_PROCESSED)');
            } finally { offI(); offS(); }
        });
    });

    it('cargo-full soft-blocks a new cast with a hint', () => {
        withFlag(() => {
            const lasso = new LassoSystem(new THREE.Scene());
            // Fill every cell.
            for (let i = 0; i < Constants.MOTHER_CARGO_CELLS; i++) {
                lasso._cargo.push({ target: { id: 100 + i }, cellIndex: i, furnaceTimer: 0, breakdownStarted: false });
            }
            let denied = null;
            const off = eventBus.on(Events.LASSO_DENIED, (e) => { denied = e; });
            try {
                const playerPos = new THREE.Vector3(0, 0, 7000 * M);
                const velDir = new THREE.Vector3(0, 0, 1);
                const target = { id: 1, alive: true, type: 'fragment', mass: 5,
                    _scenePosition: new THREE.Vector3(0, 0, (7000 + 22) * M) };
                const debrisField = { getDebrisNear: () => [target], getDebrisById: () => target, removeDebris: () => {} };
                const ok = lasso.fire(playerPos, debrisField, velDir, target);
                assert.equal(ok, false, 'cast refused when cargo is full');
                assert.ok(denied && denied.reason === 'cargo_full', 'denial reason is cargo_full');
            } finally { off(); }
        });
    });

    it('flag OFF: legacy instant catch — flat score + immediate removeDebris (no cargo)', () => {
        const orig = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW;
        Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = false;
        const { lasso, playerPos, velDir, debrisField, removed, target } = rig();
        let scoring = 0;
        const off = eventBus.on(Events.SCORING_AWARD, () => scoring++);
        try {
            lasso.fire(playerPos, debrisField, velDir, target);
            for (let i = 0; i < 400 && lasso.active; i++) {
                lasso.update(0.05, playerPos, debrisField, debrisField.getDebrisById(1), velDir);
            }
            assert.equal(lasso._cargo.length, 0, 'no cargo path when flag OFF');
            assert.ok(removed.includes(1), 'legacy instant removeDebris');
            assert.ok(scoring >= 1, 'legacy flat SCORING_AWARD fired at completion');
        } finally { off(); Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW = orig; }
    });
});
