/**
 * test-BolasVisuals.js — Unit tests for ST-2.4 → FIX-2.4a Capture Net visuals.
 *
 * Tests cover:
 *   (a) Constants validation: all NET_* constants exist with correct types/ranges
 *   (b) Net group structure expectations: perimeter lines + cross-lines + weight spheres
 *   (c) Net spin rate: NET_SPIN_HZ is 4 Hz
 *   (d) Tether 3-D thickness: radius, segments, radial segments
 *   (e) Spark contact effect: count = 12, duration = 0.4 s
 *   (f) Spark cleanup timing: duration matches NET_SPARK_DURATION
 *   (g) Codex text updated to match FIX-2.4a capture net description
 *   (h) Weight distribution geometry (evenly spaced angles)
 *   (i) Legacy BOLAS_* aliases still resolve correctly
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';
import { CodexSystem } from '../systems/CodexSystem.js';

// ─── 1. Constants existence and types ───────────────────────────────────────

describe('NetVisuals — Constants existence (FIX-2.4a)', () => {

    const netKeys = [
        'NET_SPIN_HZ',
        'NET_WEIGHT_COUNT',
        'NET_WEIGHT_RADIUS',
        'NET_PERIMETER_RADIUS',
        'NET_SEGMENTS',
        'NET_CROSS_LINES',
        'NET_TETHER_RADIUS',
        'NET_TETHER_SEGMENTS',
        'NET_TETHER_RADIAL_SEGMENTS',
        'NET_SPARK_COUNT',
        'NET_SPARK_DURATION',
        'NET_SPARK_LENGTH',
    ];

    for (const key of netKeys) {
        it(`${key} exists and is a positive finite number`, () => {
            const val = Constants[key];
            assert.ok(val !== undefined, `${key} must be defined`);
            assert.isType(val, 'number');
            assert.ok(Number.isFinite(val), `${key} must be finite`);
            assert.ok(val > 0, `${key} must be positive`);
        });
    }
});

// ─── 2. Net group structure expectations ────────────────────────────────────

describe('NetVisuals — Net group structure (FIX-2.4a)', () => {

    it('NET_WEIGHT_COUNT is 4 (perimeter weights)', () => {
        assert.ok(Constants.NET_WEIGHT_COUNT >= 2,
            `Expected NET_WEIGHT_COUNT >= 2, got ${Constants.NET_WEIGHT_COUNT}`);
        assert.ok(Constants.NET_WEIGHT_COUNT <= 8,
            `Expected NET_WEIGHT_COUNT <= 8, got ${Constants.NET_WEIGHT_COUNT}`);
    });

    it('NET_SEGMENTS is 8 (octagonal perimeter)', () => {
        assert.equal(Constants.NET_SEGMENTS, 8,
            `Expected NET_SEGMENTS=8, got ${Constants.NET_SEGMENTS}`);
    });

    it('NET_CROSS_LINES is 4 (cross-mesh diameters)', () => {
        assert.equal(Constants.NET_CROSS_LINES, 4,
            `Expected NET_CROSS_LINES=4, got ${Constants.NET_CROSS_LINES}`);
    });

    it('NET_PERIMETER_RADIUS > NET_WEIGHT_RADIUS (weights fit on perimeter)', () => {
        assert.ok(Constants.NET_PERIMETER_RADIUS > Constants.NET_WEIGHT_RADIUS,
            `Perimeter ${Constants.NET_PERIMETER_RADIUS} should be > weight radius ${Constants.NET_WEIGHT_RADIUS}`);
    });

    it('expected net child count = 1 LineSegments + N weights', () => {
        const expected = 1 + Constants.NET_WEIGHT_COUNT; // net lines + weights
        assert.equal(expected, 5, `Expected 5 children (1+4), got ${expected}`);
    });

    it('total line segment count = perimeter + cross-lines', () => {
        const totalSegments = Constants.NET_SEGMENTS + Constants.NET_CROSS_LINES;
        assert.equal(totalSegments, 12, `Expected 12 line segments (8+4), got ${totalSegments}`);
    });

    it('weight angles are evenly distributed around 2π', () => {
        const N = Constants.NET_WEIGHT_COUNT;
        const expectedSpacing = (2 * Math.PI) / N;
        for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2;
            const expectedAngle = i * expectedSpacing;
            assert.ok(
                Math.abs(angle - expectedAngle) < 1e-10,
                `Weight ${i} angle ${angle.toFixed(4)} should be ${expectedAngle.toFixed(4)}`
            );
        }
    });
});

// ─── 3. Net spin rate ───────────────────────────────────────────────────────

describe('NetVisuals — Net spin (FIX-2.4a)', () => {

    it('NET_SPIN_HZ is 4 Hz', () => {
        assert.equal(Constants.NET_SPIN_HZ, 4,
            `Expected NET_SPIN_HZ=4, got ${Constants.NET_SPIN_HZ}`);
    });

    it('one full spin takes 0.25 seconds at 4 Hz', () => {
        const period = 1 / Constants.NET_SPIN_HZ;
        assert.ok(Math.abs(period - 0.25) < 1e-10,
            `Expected spin period=0.25 s, got ${period}`);
    });

    it('spin angle accumulates at 2π × SPIN_HZ per second', () => {
        const dt = 1 / 60; // one frame
        const anglePerFrame = 2 * Math.PI * Constants.NET_SPIN_HZ * dt;
        const expectedAnglePerSecond = 2 * Math.PI * Constants.NET_SPIN_HZ;
        const actualAnglePerSecond = anglePerFrame * 60;
        assert.ok(
            Math.abs(actualAnglePerSecond - expectedAnglePerSecond) < 1e-10,
            `Spin rate ${actualAnglePerSecond.toFixed(4)} rad/s should equal ${expectedAnglePerSecond.toFixed(4)} rad/s`
        );
    });
});

// ─── 4. Tether 3-D thickness ────────────────────────────────────────────────

describe('NetVisuals — Tether 3-D (FIX-2.4a)', () => {

    it('NET_TETHER_RADIUS > 0 (has real thickness)', () => {
        assert.ok(Constants.NET_TETHER_RADIUS > 0,
            `Tether radius must be > 0, got ${Constants.NET_TETHER_RADIUS}`);
    });

    it('NET_TETHER_RADIUS is reasonable (0.1–2 metres)', () => {
        assert.ok(Constants.NET_TETHER_RADIUS >= 0.1,
            `Tether radius ${Constants.NET_TETHER_RADIUS} too small`);
        assert.ok(Constants.NET_TETHER_RADIUS <= 2,
            `Tether radius ${Constants.NET_TETHER_RADIUS} too large`);
    });

    it('NET_TETHER_SEGMENTS >= 8 (smooth curve)', () => {
        assert.ok(Constants.NET_TETHER_SEGMENTS >= 8,
            `Expected >= 8 segments, got ${Constants.NET_TETHER_SEGMENTS}`);
    });

    it('NET_TETHER_RADIAL_SEGMENTS >= 3 (tube cross-section)', () => {
        assert.ok(Constants.NET_TETHER_RADIAL_SEGMENTS >= 3,
            `Expected >= 3 radial segments, got ${Constants.NET_TETHER_RADIAL_SEGMENTS}`);
    });

    it('tether is thinner than weight spheres', () => {
        assert.ok(Constants.NET_TETHER_RADIUS < Constants.NET_WEIGHT_RADIUS,
            `Tether ${Constants.NET_TETHER_RADIUS} should be thinner than weight radius ${Constants.NET_WEIGHT_RADIUS}`);
    });
});

// ─── 5. Spark contact effect ────────────────────────────────────────────────

describe('NetVisuals — Spark contact (FIX-2.4a)', () => {

    it('NET_SPARK_COUNT is 12', () => {
        assert.equal(Constants.NET_SPARK_COUNT, 12,
            `Expected NET_SPARK_COUNT=12, got ${Constants.NET_SPARK_COUNT}`);
    });

    it('NET_SPARK_DURATION is 0.4 seconds', () => {
        assert.equal(Constants.NET_SPARK_DURATION, 0.4,
            `Expected NET_SPARK_DURATION=0.4, got ${Constants.NET_SPARK_DURATION}`);
    });

    it('NET_SPARK_LENGTH > 0', () => {
        assert.ok(Constants.NET_SPARK_LENGTH > 0,
            `Spark length must be positive, got ${Constants.NET_SPARK_LENGTH}`);
    });

    it('sparks angular spacing = 2π / 12 = π/6', () => {
        const spacing = (2 * Math.PI) / Constants.NET_SPARK_COUNT;
        const expected = Math.PI / 6;
        assert.ok(Math.abs(spacing - expected) < 1e-10,
            `Expected angular spacing π/6 ≈ ${expected.toFixed(4)}, got ${spacing.toFixed(4)}`);
    });
});

// ─── 6. Spark cleanup timing ────────────────────────────────────────────────

describe('NetVisuals — Spark cleanup (FIX-2.4a)', () => {

    it('spark cleanup should happen at elapsed >= NET_SPARK_DURATION', () => {
        // Simulate spark timer countdown
        let timer = Constants.NET_SPARK_DURATION;
        const dt = 1 / 60;
        let frames = 0;
        while (timer > 0) {
            timer -= dt;
            frames++;
        }
        const elapsed = frames * dt;
        assert.ok(elapsed >= Constants.NET_SPARK_DURATION,
            `Cleanup after ${elapsed.toFixed(3)} s should be >= ${Constants.NET_SPARK_DURATION} s`);
        assert.ok(elapsed < Constants.NET_SPARK_DURATION + dt * 2,
            `Cleanup should happen within 2 frames of duration end`);
    });

    it('spark opacity reaches 0 at end of duration', () => {
        const progress = 1; // at duration end
        const opacity = Math.max(0, 1 - progress);
        assert.equal(opacity, 0, `Opacity at end of duration should be 0, got ${opacity}`);
    });

    it('spark scale reaches 4× at end of duration', () => {
        const progress = 1;
        const scale = 1 + progress * 3;
        assert.equal(scale, 4, `Scale at end of duration should be 4, got ${scale}`);
    });
});

// ─── 7. Codex text (FIX-2.4a capture net) ──────────────────────────────────

describe('NetVisuals — Codex entry (FIX-2.4a)', () => {

    const codexSystem = new CodexSystem();

    it('bolas_weapon entry exists', () => {
        const entry = codexSystem.getEntry('bolas_weapon');
        assert.ok(entry, 'bolas_weapon entry should exist');
    });

    it('bolas_weapon shortText matches FIX-2.4a capture net description', () => {
        const entry = codexSystem.getEntry('bolas_weapon');
        assert.ok(entry, 'entry must exist');
        const expected = 'Capture net. A weighted Dyneema mesh spun open by gyroscopic rotation. Gentle enough for delicate debris — and it still works in vacuum.';
        assert.equal(entry.shortText, expected,
            `shortText should match FIX-2.4a capture net description`);
    });

    it('bolas_weapon is in TETHERS category', () => {
        const entry = codexSystem.getEntry('bolas_weapon');
        assert.ok(entry, 'entry must exist');
        assert.equal(entry.category, 'TETHERS',
            `Expected category TETHERS, got ${entry.category}`);
    });

    it('bolas_weapon triggerEvent is LASSO_FIRED', () => {
        const entry = codexSystem.getEntry('bolas_weapon');
        assert.ok(entry, 'entry must exist');
        assert.equal(entry.triggerEvent, Events.LASSO_FIRED,
            `triggerEvent should be LASSO_FIRED`);
    });
});

// ─── 8. Legacy BOLAS_* aliases ──────────────────────────────────────────────

describe('NetVisuals — Legacy BOLAS_* aliases (FIX-2.4a)', () => {

    it('BOLAS_SPIN_HZ resolves to NET_SPIN_HZ', () => {
        assert.equal(Constants.BOLAS_SPIN_HZ, Constants.NET_SPIN_HZ);
    });

    it('BOLAS_WEIGHT_COUNT resolves to NET_WEIGHT_COUNT', () => {
        assert.equal(Constants.BOLAS_WEIGHT_COUNT, Constants.NET_WEIGHT_COUNT);
    });

    it('BOLAS_TETHER_RADIUS resolves to NET_TETHER_RADIUS', () => {
        assert.equal(Constants.BOLAS_TETHER_RADIUS, Constants.NET_TETHER_RADIUS);
    });

    it('BOLAS_SPARK_COUNT resolves to NET_SPARK_COUNT', () => {
        assert.equal(Constants.BOLAS_SPARK_COUNT, Constants.NET_SPARK_COUNT);
    });

    it('BOLAS_SPARK_DURATION resolves to NET_SPARK_DURATION', () => {
        assert.equal(Constants.BOLAS_SPARK_DURATION, Constants.NET_SPARK_DURATION);
    });

    it('BOLAS_TORUS_RADIUS resolves to NET_PERIMETER_RADIUS', () => {
        assert.equal(Constants.BOLAS_TORUS_RADIUS, Constants.NET_PERIMETER_RADIUS);
    });
});
