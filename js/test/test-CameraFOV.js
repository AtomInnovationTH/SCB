/**
 * test-CameraFOV.js — Camera FOV constant regression tests (ST-5.3)
 *
 * Verifies COMMAND/TACTICAL base FOV is 55°, ARM_PILOT remains 40°,
 * and documents the FOV breathe offset range (±2.5° around base).
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

describe('Camera FOV - COMMAND/TACTICAL base', () => {

  it('CAMERA_FOV equals 55 (ST-5.3 change from 65)', () => {
    assert.equal(Constants.CAMERA_FOV, 55,
      `CAMERA_FOV should be 55°, got ${Constants.CAMERA_FOV}°`);
  });

  it('CAMERA_FOV is a number', () => {
    assert.isType(Constants.CAMERA_FOV, 'number');
  });

  it('CAMERA_FOV is within sane range (30–90°)', () => {
    assert.ok(Constants.CAMERA_FOV >= 30 && Constants.CAMERA_FOV <= 90,
      `CAMERA_FOV ${Constants.CAMERA_FOV}° outside sane range 30–90°`);
  });
});

describe('Camera FOV - ARM_PILOT', () => {

  it('CAMERA_FOV_ARM_PILOT equals 40 (unchanged narrow FOV)', () => {
    assert.equal(Constants.CAMERA_FOV_ARM_PILOT, 40,
      `CAMERA_FOV_ARM_PILOT should be 40°, got ${Constants.CAMERA_FOV_ARM_PILOT}°`);
  });

  it('ARM_PILOT FOV is narrower than COMMAND FOV', () => {
    assert.ok(Constants.CAMERA_FOV_ARM_PILOT < Constants.CAMERA_FOV,
      `ARM_PILOT ${Constants.CAMERA_FOV_ARM_PILOT}° should be < COMMAND ${Constants.CAMERA_FOV}°`);
  });
});

describe('Camera FOV - Breathe range symmetry', () => {
  // CameraSystem.js line ~431: maxOffset = 2.5 * thrustMag * sustainFrac
  // At full sustained thrust (mag=1, sustainFrac=1), offset = ±2.5°
  const BREATHE_MAX_OFFSET = 2.5;

  it('breathe range is symmetric around base (52.5–57.5° at full thrust)', () => {
    const low  = Constants.CAMERA_FOV - BREATHE_MAX_OFFSET;
    const high = Constants.CAMERA_FOV + BREATHE_MAX_OFFSET;
    assert.equal(low, 52.5, `Low end should be 52.5°, got ${low}°`);
    assert.equal(high, 57.5, `High end should be 57.5°, got ${high}°`);
  });

  it('breathe max offset is within ±3° tolerance', () => {
    assert.ok(BREATHE_MAX_OFFSET <= 3,
      `Breathe offset ${BREATHE_MAX_OFFSET}° exceeds ±3° tolerance`);
    assert.ok(BREATHE_MAX_OFFSET >= 2,
      `Breathe offset ${BREATHE_MAX_OFFSET}° below ±2° minimum`);
  });
});
