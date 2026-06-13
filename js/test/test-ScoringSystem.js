/**
 * test-ScoringSystem.js — Score calculation tests
 */
import { describe, it, assert } from './TestRunner.js';
import { ScoringSystem, CAPTURE_TIERS } from '../systems/ScoringSystem.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// Fresh instance for tests (avoids singleton event side-effects)
const scoring = new ScoringSystem();

function makeDebris(type = 'fragment', mass = 1, tumbleRate = 0) {
    return { type, mass, tumbleRate };
}

// ── calculateScore ─────────────────────────────────────────────
describe('ScoringSystem - calculateScore', () => {
    scoring.reset();

    it('returns a positive number for basic capture', () => {
        const score = scoring.calculateScore({
            debris: makeDebris('fragment', 1),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        assert.ok(score > 0, `score should be > 0, got ${score}`);
        assert.isType(score, 'number');
    });

    it('larger debris gives higher score', () => {
        const small = scoring.calculateScore({
            debris: makeDebris('fragment', 1),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        const big = scoring.calculateScore({
            debris: makeDebris('rocketBody', 5000),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        assert.ok(big > small, `big(${big}) should exceed small(${small})`);
    });

    it('zero fragments gives no penalty (divisor = 1)', () => {
        const clean = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
            fragmentsCreated: 0,
        });
        const messy = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
            fragmentsCreated: 3,
        });
        assert.ok(clean > messy, `clean(${clean}) should exceed messy(${messy})`);
    });

    it('streak multiplier increases score', () => {
        scoring.reset();
        scoring.currentStreak = 0;
        const base = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        scoring.currentStreak = 5;
        const streaked = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        assert.ok(streaked >= base, `streaked(${streaked}) should be >= base(${base})`);
        scoring.currentStreak = 0;
    });

    it('different capture tiers have different base values', () => {
        const data = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.DATA,
        });
        const capture = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        assert.ok(capture > data, `capture(${capture}) should exceed data(${data})`);
    });

    it('method bonus affects score', () => {
        const arm = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'arm',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        const ionBeam = scoring.calculateScore({
            debris: makeDebris('fragment', 10),
            method: 'ionBeam',
            captureTier: CAPTURE_TIERS.CAPTURE,
        });
        assert.ok(ionBeam > arm, `ionBeam(${ionBeam}) should exceed arm(${arm})`);
    });

    it('minimum score is 10', () => {
        const score = scoring.calculateScore({
            debris: makeDebris('fragment', 0.001),
            method: 'arm',
            captureTier: CAPTURE_TIERS.DATA,
            fragmentsCreated: 100,
        });
        assert.ok(score >= 10, `score should be >= 10, got ${score}`);
    });
});

// ── Tool-Tier Efficiency (ST-4.E) ──────────────────────────────

describe('ScoringSystem - Tool-Tier Efficiency (ST-4.E)', () => {
    /** Create a fresh ScoringSystem for each isolation need */
    function freshSystem() {
        return new ScoringSystem();
    }

    it('getToolStats() returns empty array initially', () => {
        const sys = freshSystem();
        const stats = sys.getToolStats();
        assert.deepEqual(stats, [], 'Fresh system should return empty stats');
    });

    it('ΔV attribution per tool via lasso events', () => {
        const sys = freshSystem();
        let mockDV = 0;
        const mockPlayer = { getDeltaVSpent: () => mockDV };
        sys.setPlayer(mockPlayer);

        // Simulate lasso fire → ΔV increases → lasso capture
        mockDV = 10;
        eventBus.emit(Events.LASSO_FIRED);
        mockDV = 15; // 5 m/s spent during operation
        eventBus.emit(Events.LASSO_CAPTURED);

        const stats = sys.getToolStats();
        assert.equal(stats.length, 1, 'Should have 1 tool entry');
        assert.equal(stats[0].name, 'lasso');
        assert.equal(stats[0].catches, 1);
        assert.equal(stats[0].dvSpent, 5, 'Should track 5 m/s ΔV');
        assert.equal(stats[0].dvPerCatch, 5, 'dvPerCatch should be 5');
    });

    it('best tool (lowest dvPerCatch) gets isBest flag', () => {
        const sys = freshSystem();
        let mockDV = 0;
        const mockPlayer = { getDeltaVSpent: () => mockDV };
        sys.setPlayer(mockPlayer);

        // Lasso: 2 m/s per catch (efficient)
        mockDV = 0;
        eventBus.emit(Events.LASSO_FIRED);
        mockDV = 2;
        eventBus.emit(Events.LASSO_CAPTURED);

        // Arm: 10 m/s per catch (inefficient)
        mockDV = 20;
        eventBus.emit(Events.CROSSBOW_FIRE);
        mockDV = 30;
        eventBus.emit(Events.ARM_CAPTURED);

        const stats = sys.getToolStats();
        assert.equal(stats.length, 2, 'Should have 2 tool entries');
        assert.equal(stats[0].isBest, true, 'First entry (best) should have isBest');
        assert.ok(!stats[1].isBest, 'Second entry should not have isBest');
    });

    it('stats sorted ascending by dvPerCatch', () => {
        const sys = freshSystem();
        let mockDV = 0;
        const mockPlayer = { getDeltaVSpent: () => mockDV };
        sys.setPlayer(mockPlayer);

        // Arm: 8 m/s per catch
        mockDV = 0;
        eventBus.emit(Events.CROSSBOW_FIRE);
        mockDV = 8;
        eventBus.emit(Events.ARM_CAPTURED);

        // Lasso: 3 m/s per catch (more efficient — should sort first)
        mockDV = 10;
        eventBus.emit(Events.LASSO_FIRED);
        mockDV = 13;
        eventBus.emit(Events.LASSO_CAPTURED);

        const stats = sys.getToolStats();
        assert.equal(stats[0].name, 'lasso', 'Lasso (3 m/s) should sort before arm (8 m/s)');
        assert.equal(stats[1].name, 'arm');
        assert.ok(stats[0].dvPerCatch < stats[1].dvPerCatch, 'dvPerCatch should be ascending');
    });

    it('reset() clears tool stats', () => {
        const sys = freshSystem();
        let mockDV = 0;
        const mockPlayer = { getDeltaVSpent: () => mockDV };
        sys.setPlayer(mockPlayer);

        // Add some data
        mockDV = 0;
        eventBus.emit(Events.LASSO_FIRED);
        mockDV = 5;
        eventBus.emit(Events.LASSO_CAPTURED);

        assert.equal(sys.getToolStats().length, 1, 'Should have data before reset');

        sys.reset();
        const stats = sys.getToolStats();
        assert.deepEqual(stats, [], 'After reset, should return empty stats');
    });
});

// ── Penalty floor (fragmentation credit penalty must not go negative) ──────

describe('ScoringSystem - penalty awards are floored at 0', () => {
    it('a penalty larger than the balance floors credits/score at 0, never negative', () => {
        const sys = new ScoringSystem();
        sys.credits = 100;
        sys.totalScore = 100;
        // Fragmentation penalty: 12 frags × 50 = -600 (no debris object).
        sys.awardPoints({ points: -600, reason: 'Fragmentation penalty' });
        assert.equal(sys.credits, 0, 'credits floored at 0, not -500');
        assert.equal(sys.totalScore, 0, 'score floored at 0');
    });

    it('restore clamps a corrupt negative balance to 0', () => {
        const sys = new ScoringSystem();
        sys.restore({ credits: -250, totalScore: -250 });
        assert.equal(sys.credits, 0, 'negative saved credits clamp to 0');
        assert.equal(sys.totalScore, 0, 'negative saved score clamps to 0');
    });

    it('normal positive awards are unaffected', () => {
        const sys = new ScoringSystem();
        sys.credits = 100;
        sys.totalScore = 100;
        sys.awardPoints({ points: 75, reason: 'Survey bounty' });
        assert.equal(sys.credits, 175);
        assert.equal(sys.totalScore, 175);
    });
});
