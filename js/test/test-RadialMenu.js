/**
 * test-RadialMenu.js — ST-5.1: Radial menu gating, angles, colour stripes
 * Tests pure helpers from RadialMenu.js.
 *
 * Functions are copied from RadialMenu.js since that module imports
 * DOM/EventBus (unavailable in Node). Tests validate the algorithms.
 * @module test/test-RadialMenu
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

const COMMS = Constants.COMMS;

// ============================================================================
// ALGORITHM COPIES (mirror RadialMenu.js module-level helpers exactly)
// ============================================================================

const RADIAL_OPTIONS = [
  { label: 'Deploy Weaver', cmdIndex: 1, channel: 'CMD', gatingKey: 'deployWeaver' },
  { label: 'Deploy Spinner', cmdIndex: 2, channel: 'CMD', gatingKey: 'deploySpinner' },
  { label: 'Fish (cast all)', cmdIndex: 3, channel: 'CMD', gatingKey: 'fish' },
  { label: 'Recall All', cmdIndex: 4, channel: 'CMD', gatingKey: 'recallAll' },
  { label: 'Pilot Arm [P]', cmdIndex: 5, channel: 'CMD', gatingKey: 'pilotArm' },
  { label: 'DEORBIT [D]', cmdIndex: 6, channel: 'ALERT', gatingKey: 'deorbit' },
];

function computeArmGating(armStatus) {
  return {
    deployWeaver: !!armStatus.weaverDocked,
    deploySpinner: !!armStatus.spinnerDocked,
    fish: !!armStatus.anyDocked,
    recallAll: !!armStatus.anyDeployed,
    pilotArm: !!armStatus.anyPilotable,
    deorbit: true,
  };
}

function getOptionAngles(n) {
  const step = (2 * Math.PI) / n;
  const angles = [];
  for (let i = 0; i < n; i++) {
    angles.push(-Math.PI / 2 + i * step);
  }
  return angles;
}

function getOptionAtAngle(angle, n) {
  const step = (2 * Math.PI) / n;
  let rel = angle - (-Math.PI / 2);
  rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(rel / step) % n;
}

function getOptionChannelColor(optionIndex) {
  const opt = RADIAL_OPTIONS[optionIndex];
  if (!opt) return COMMS.CHANNEL_COLORS.FLAVOR;
  return COMMS.CHANNEL_COLORS[opt.channel] || COMMS.CHANNEL_COLORS.FLAVOR;
}

// ============================================================================
// Arm-state gating
// ============================================================================

describe('RadialMenu – arm-state gating', () => {
  it('all arms docked → Deploy enabled, Reel disabled, Recall disabled', () => {
    const gating = computeArmGating({
      weaverDocked: true,
      spinnerDocked: true,
      anyDocked: true,
      anyDeployed: false,
      anyPilotable: false,
    });
    assert.equal(gating.deployWeaver, true);
    assert.equal(gating.deploySpinner, true);
    assert.equal(gating.recallAll, false);
    assert.equal(gating.pilotArm, false);
  });

  it('all arms deployed → Deploy disabled, Recall enabled', () => {
    const gating = computeArmGating({
      weaverDocked: false,
      spinnerDocked: false,
      anyDocked: false,
      anyDeployed: true,
      anyPilotable: true,
    });
    assert.equal(gating.deployWeaver, false);
    assert.equal(gating.deploySpinner, false);
    assert.equal(gating.recallAll, true);
    assert.equal(gating.pilotArm, true);
  });

  it('mixed state: some docked, some deployed', () => {
    const gating = computeArmGating({
      weaverDocked: true,
      spinnerDocked: false,
      anyDocked: true,
      anyDeployed: true,
      anyPilotable: true,
    });
    assert.equal(gating.deployWeaver, true);
    assert.equal(gating.deploySpinner, false);
    assert.equal(gating.fish, true);
    assert.equal(gating.recallAll, true);
    assert.equal(gating.pilotArm, true);
  });
});

// ============================================================================
// Equal-angle distribution
// ============================================================================

describe('RadialMenu – option angles', () => {
  it('6 options at 60° increments', () => {
    const angles = getOptionAngles(6);
    assert.equal(angles.length, 6);
    const sixtyDeg = Math.PI / 3;
    for (let i = 1; i < angles.length; i++) {
      const diff = Math.abs(angles[i] - angles[i - 1] - sixtyDeg);
      assert.ok(diff < 0.001, `Angle gap ${i} should be ~60° (π/3 rad), diff=${diff}`);
    }
  });

  it('first option starts at -π/2 (top of circle)', () => {
    const angles = getOptionAngles(6);
    const diff = Math.abs(angles[0] - (-Math.PI / 2));
    assert.ok(diff < 0.001, `First angle should be -π/2, got ${angles[0]}`);
  });
});

// ============================================================================
// Option-at-angle lookup
// ============================================================================

describe('RadialMenu – getOptionAtAngle', () => {
  it('angle near first option → index 0', () => {
    const idx = getOptionAtAngle(-Math.PI / 2 + 0.01, 6);
    assert.equal(idx, 0);
  });

  it('angle near second option → index 1', () => {
    const idx = getOptionAtAngle(-Math.PI / 2 + Math.PI / 3 + 0.01, 6);
    assert.equal(idx, 1);
  });

  it('angle near last option → index 5', () => {
    const idx = getOptionAtAngle(-Math.PI / 2 + 5 * Math.PI / 3 - 0.01, 6);
    assert.equal(idx, 5);
  });
});

// ============================================================================
// Channel-stripe colour assignment
// ============================================================================

describe('RadialMenu – option channel colours', () => {
  it('Deploy Weaver → CMD amber', () => {
    assert.equal(getOptionChannelColor(0), COMMS.CHANNEL_COLORS.CMD);
  });

  it('Deploy Spinner → CMD amber', () => {
    assert.equal(getOptionChannelColor(1), COMMS.CHANNEL_COLORS.CMD);
  });

  it('Fish → CMD amber', () => {
    assert.equal(getOptionChannelColor(2), COMMS.CHANNEL_COLORS.CMD);
  });

  it('Recall All → CMD amber', () => {
    assert.equal(getOptionChannelColor(3), COMMS.CHANNEL_COLORS.CMD);
  });

  it('Pilot Arm → CMD amber', () => {
    assert.equal(getOptionChannelColor(4), COMMS.CHANNEL_COLORS.CMD);
  });

  it('DEORBIT → ALERT red', () => {
    assert.equal(getOptionChannelColor(5), COMMS.CHANNEL_COLORS.ALERT);
  });
});
