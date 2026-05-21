/**
 * test-PowerDistribution.js — Power allocation tests
 */
import { describe, it, assert } from './TestRunner.js';
import { powerDistribution, PowerBuses } from '../systems/PowerDistribution.js';

// ── Allocation Multiplier ──────────────────────────────────────
describe('PowerDistribution - Allocation Multiplier', () => {
    it('0% allocation gives 0 multiplier', () => {
        assert.equal(powerDistribution._allocationToMultiplier(0), 0.0);
    });

    it('10% allocation gives 0.3 multiplier', () => {
        assert.closeTo(powerDistribution._allocationToMultiplier(10), 0.3, 0.001);
    });

    it('30% allocation gives 0.7 multiplier', () => {
        assert.closeTo(powerDistribution._allocationToMultiplier(30), 0.7, 0.001);
    });

    it('50% allocation gives 1.0 multiplier', () => {
        assert.closeTo(powerDistribution._allocationToMultiplier(50), 1.0, 0.001);
    });

    it('100% allocation gives 1.3 multiplier', () => {
        assert.closeTo(powerDistribution._allocationToMultiplier(100), 1.3, 0.001);
    });

    it('negative values clamp to 0', () => {
        assert.equal(powerDistribution._allocationToMultiplier(-10), 0.0);
    });

    it('midpoint interpolation: 20% gives 0.5', () => {
        // 10→0.3, 30→0.7, midpoint 20 → 0.3 + (10/20)*0.4 = 0.5
        assert.closeTo(powerDistribution._allocationToMultiplier(20), 0.5, 0.001);
    });
});

// ── Bus Invariant ──────────────────────────────────────────────
describe('PowerDistribution - Bus Invariant', () => {
    it('default allocations sum to 100%', () => {
        powerDistribution.reset();
        const sum = powerDistribution.thrust + powerDistribution.sensors + powerDistribution.arms;
        assert.equal(sum, 100);
    });

    it('after increasing thrust, total still sums to 100%', () => {
        powerDistribution.reset();
        powerDistribution.selectBus(PowerBuses.THRUST);
        powerDistribution.increaseSelected();
        const sum = powerDistribution.thrust + powerDistribution.sensors + powerDistribution.arms;
        assert.equal(sum, 100);
    });

    it('after decreasing sensors, total still sums to 100%', () => {
        powerDistribution.reset();
        powerDistribution.selectBus(PowerBuses.SENSORS);
        powerDistribution.decreaseSelected();
        const sum = powerDistribution.thrust + powerDistribution.sensors + powerDistribution.arms;
        assert.equal(sum, 100);
    });

    it('increasing one bus decreases others', () => {
        powerDistribution.reset();
        const beforeSensors = powerDistribution.sensors;
        const beforeArms = powerDistribution.arms;
        powerDistribution.selectBus(PowerBuses.THRUST);
        powerDistribution.increaseSelected();
        const afterSensors = powerDistribution.sensors;
        const afterArms = powerDistribution.arms;
        assert.ok(
            afterSensors < beforeSensors || afterArms < beforeArms,
            'at least one other bus should decrease'
        );
    });

    it('multipliers update after allocation change', () => {
        powerDistribution.reset();
        const beforeMult = powerDistribution.thrustMultiplier;
        powerDistribution.selectBus(PowerBuses.THRUST);
        powerDistribution.increaseSelected();
        assert.ok(
            powerDistribution.thrustMultiplier > beforeMult,
            `thrust multiplier should increase (was ${beforeMult}, now ${powerDistribution.thrustMultiplier})`
        );
    });

    it('reset restores defaults', () => {
        powerDistribution.selectBus(PowerBuses.ARMS);
        powerDistribution.increaseSelected();
        powerDistribution.increaseSelected();
        powerDistribution.reset();
        assert.equal(powerDistribution.thrust, 40);
        assert.equal(powerDistribution.sensors, 30);
        assert.equal(powerDistribution.arms, 30);
    });
});
