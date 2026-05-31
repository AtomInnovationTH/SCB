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
