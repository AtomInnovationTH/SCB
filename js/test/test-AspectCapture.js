/**
 * test-AspectCapture.js — orientation-based capture
 * (capture-feedback overhaul Phase 2, FEATURE_FLAGS.ASPECT_CAPTURE).
 *
 * Coverage: presentedWidth math, worldLongAxis rotation, end-on vs broadside
 * fit verdicts, contact-time oversize_aspect miss, tumbling θ-sweep odds
 * oscillation + despun freeze, miss-reason text.
 */
import { describe, it, assert } from './TestRunner.js';
import {
  presentedWidth,
  worldLongAxis,
  presentedWidthForApproach,
  assessNetFit,
  missReasonToText,
  NetProjectile,
} from '../entities/CaptureNet.js';
import { computeToolOdds } from '../systems/ToolOdds.js';
import { Constants } from '../core/Constants.js';

const CN = Constants.CAPTURE_NET;

/** 7 m rocket body, 2 m cross-section, no tumble rotation by default. */
function rocketBody(over = {}) {
  return {
    id: 1, type: 'rocketBody',
    sizeMeter: 7, lengthM: 7, widthM: 2,
    mass: 400,
    tumbleAxis: { x: 0, y: 0, z: 1 },
    tumbleAngle: 0,
    surfaceRoughness: 1.0,
    ...over,
  };
}

describe('AspectCapture — presentedWidth math (2b)', () => {
  it('end-on (θ=0) presents widthM; broadside (θ=90°) presents lengthM', () => {
    assert.equal(presentedWidth(7, 2, 1.0), 2, 'cosθ=1 → end-on → width');
    assert.equal(presentedWidth(7, 2, 0.0), 7, 'cosθ=0 → broadside → length');
  });

  it('intermediate angles never present less than widthM', () => {
    const p30 = presentedWidth(7, 2, Math.cos(Math.PI / 6));
    assert.ok(Math.abs(p30 - 3.5) < 1e-9, '30° off-axis → length·sin30 = 3.5');
    const p10 = presentedWidth(7, 2, Math.cos(10 * Math.PI / 180));
    assert.ok(p10 >= 2, 'floor at widthM');
  });

  it('worldLongAxis rotates the local long axis by quat(tumbleAxis, tumbleAngle)', () => {
    // rocketBody local long axis = +Y. Rotate 90° about Z → +Y becomes −X.
    const d = rocketBody({ tumbleAngle: Math.PI / 2 });
    const a = worldLongAxis(d);
    assert.ok(Math.abs(a.x - (-1)) < 1e-9 && Math.abs(a.y) < 1e-9, `Y→−X (got ${a.x},${a.y},${a.z})`);
    // defunctSat local long axis = +X. Rotate 90° about Z → +X becomes +Y.
    const s = worldLongAxis({ type: 'defunctSat', tumbleAxis: { x: 0, y: 0, z: 1 }, tumbleAngle: Math.PI / 2 });
    assert.ok(Math.abs(s.y - 1) < 1e-9, `X→+Y (got ${s.x},${s.y},${s.z})`);
  });

  it('presentedWidthForApproach: end-on along the axis, broadside across it', () => {
    const d = rocketBody();           // long axis +Y (no rotation)
    const endOn = presentedWidthForApproach(d, { x: 0, y: 1, z: 0 });
    const broad = presentedWidthForApproach(d, { x: 1, y: 0, z: 0 });
    assert.equal(endOn, 2);
    assert.equal(broad, 7);
  });

  it('falls back to sizeMeter when aspect data is missing (graceful)', () => {
    const legacy = { sizeMeter: 6 };
    assert.equal(presentedWidthForApproach(legacy, { x: 1, y: 0, z: 0 }), 6);
  });
});

describe('AspectCapture — fit verdicts (2c)', () => {
  it('fits end-on only → ASPECT (static, no approach dir)', () => {
    const fit = assessNetFit(rocketBody(), CN.MEDIUM);   // 5 m mouth ∈ (2, 7)
    assert.equal(fit.fit, 'ASPECT');
    assert.equal(fit.label, 'END-ON ONLY');
  });

  it('even end-on too wide → TOO_WIDE', () => {
    const fit = assessNetFit(rocketBody({ widthM: 6 }), CN.MEDIUM);
    assert.equal(fit.fit, 'TOO_WIDE');
  });

  it('live approach dir: broadside → ASPECT, end-on → falls through to OK', () => {
    const d = rocketBody();   // long axis +Y
    const broad = assessNetFit(d, CN.MEDIUM, { x: 1, y: 0, z: 0 });
    assert.equal(broad.fit, 'ASPECT', 'broadside presentation gates');
    const endOn = assessNetFit(d, CN.MEDIUM, { x: 0, y: 1, z: 0 });
    assert.equal(endOn.fit, 'OK', 'end-on presentation fits');
  });

  it('flag OFF → legacy scalar behaviour (sizeMeter vs mouth)', () => {
    const prev = Constants.FEATURE_FLAGS.ASPECT_CAPTURE;
    try {
      Constants.FEATURE_FLAGS.ASPECT_CAPTURE = false;
      const fit = assessNetFit(rocketBody(), CN.MEDIUM);
      assert.equal(fit.fit, 'TOO_WIDE', '7 m > 5 m mouth, no aspect escape');
    } finally {
      Constants.FEATURE_FLAGS.ASPECT_CAPTURE = prev;
    }
  });
});

describe('AspectCapture — contact-time resolution (2c)', () => {
  function fireAt(debris, launchDirection) {
    return new NetProjectile({
      netClass: CN.MEDIUM,
      armIndex: 0,
      launchPosition: { x: 0, y: 0, z: 0 },
      launchDirection,
      targetDebris: debris,
      captureMode: CN.MODES.SLAM_WRAP,
    });
  }

  it('broadside contact on an oversize presentation → deterministic oversize_aspect miss', () => {
    const net = fireAt(rocketBody(), { x: 1, y: 0, z: 0 });   // across the long axis
    net._resolveCatch();
    assert.equal(net.catchResult, 'miss');
    assert.ok(net._presentedWidthM > CN.MEDIUM.DIAMETER, 'presented width recorded');
  });

  it('end-on contact passes the gate and rolls cling normally', () => {
    const net = fireAt(rocketBody(), { x: 0, y: 1, z: 0 });   // along the long axis
    net._resolveCatch();
    assert.ok(net._presentedWidthM <= CN.MEDIUM.DIAMETER, 'end-on presentation fits');
    assert.ok(net.catchResult === 'success' || net.catchResult === 'miss', 'normal roll happened');
    assert.ok(net._clingProbability > 0, 'cling probability was computed (not a width gate)');
  });

  it('miss reason text teaches the orientation fix; unknown reasons get a generic line', () => {
    assert.ok(missReasonToText('oversize_aspect').includes('end-on'));
    assert.ok(missReasonToText('mystery_reason'), 'generic default instead of silent null');
    assert.equal(missReasonToText('forced'), null, 'forced stays silent');
  });
});

describe('AspectCapture — odds oscillation with tumble (2d)', () => {
  it('NET odds swing 0 ↔ >0 as the long axis sweeps; despin freezes the verdict', () => {
    const d = rocketBody();
    const approach = { x: 1, y: 0, z: 0 };
    // Sweep tumbleAngle: long axis +Y rotated about Z by α gives axis
    // (−sinα, cosα, 0); approach +X. Broadside at α=0 (axis ⊥ approach)…
    const at = (angle) => {
      d.tumbleAngle = angle;
      return computeToolOdds({
        armType: 'weaver', range: 20, target: d,
        presentedWidthM: presentedWidthForApproach(d, approach),
      }).NET.p;
    };
    const broadside = at(0);             // axis +Y ⊥ approach +X → presents 7 m
    const endOn = at(Math.PI / 2);       // axis −X ∥ approach → presents 2 m
    assert.equal(broadside, 0, 'broadside window: 0%');
    assert.ok(endOn > 0.5, `end-on window: real odds (got ${endOn})`);
    // Despun target: tumbleAngle frozen → the verdict stops sweeping.
    assert.equal(at(Math.PI / 2), endOn, 'frozen angle → stable odds');
  });
});
