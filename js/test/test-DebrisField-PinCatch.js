/**
 * test-DebrisField-PinCatch.js — Authoritative capture pin (reel-in fix).
 *
 * Reproduces the real reel-in bug: the debris object an arm holds as
 * `capturedDebris` was NOT the same object DebrisField rendered (same id,
 * different reference), so position pins set by the arm never reached the
 * rendered instance and the catch drifted ~600 m away on its orbit, vanishing
 * at dock. `pinCapturedDebris` reconciles BOTH references by canonical id.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { DebrisField } from '../entities/DebrisField.js';

describe('DebrisField.pinCapturedDebris — authoritative catch pin', () => {
  it('pins BOTH the arm-held ref and the canonical field object (same id, different refs)', () => {
    // Minimal stub: no instance meshes (pin returns after position sync).
    const field = {
      debrisMap: new Map(),
      _instanceLookup: new Map(),
    };
    // Canonical rendered object (what DebrisField iterates) — drifting on orbit.
    const canonical = { id: 1, _scenePosition: new THREE.Vector3(900, 900, 900) };
    field.debrisMap.set(1, canonical);

    // The DIFFERENT object the arm captured (the bug: separate ref, same id).
    const armRef = { id: 1 };
    const armPos = new THREE.Vector3(1, 2, 3);

    DebrisField.prototype.pinCapturedDebris.call(field, armRef, armPos);

    // Arm-held ref (net visual + camera read this) is forced to the arm.
    assert.ok(armRef._scenePosition, 'arm ref got a scene position');
    assert.ok(armRef._scenePosition.distanceTo(armPos) < 1e-9, 'arm ref pinned to arm');
    assert.equal(armRef._armPinned, true, 'arm ref flagged pinned');

    // Canonical rendered object is also forced to the arm (no orbit drift).
    assert.ok(canonical._scenePosition.distanceTo(armPos) < 1e-9, 'canonical pinned to arm');
    assert.equal(canonical._armPinned, true, 'canonical flagged pinned');
  });

  it('is a safe no-op with null inputs', () => {
    const field = { debrisMap: new Map(), _instanceLookup: new Map() };
    // Should not throw.
    DebrisField.prototype.pinCapturedDebris.call(field, null, new THREE.Vector3());
    DebrisField.prototype.pinCapturedDebris.call(field, { id: 1 }, null);
    assert.ok(true, 'no throw on null inputs');
  });

  it('handles the common case where arm ref IS the canonical object', () => {
    const field = { debrisMap: new Map(), _instanceLookup: new Map() };
    const obj = { id: 5, _scenePosition: new THREE.Vector3(50, 0, 0) };
    field.debrisMap.set(5, obj);
    const armPos = new THREE.Vector3(7, 8, 9);
    DebrisField.prototype.pinCapturedDebris.call(field, obj, armPos);
    assert.ok(obj._scenePosition.distanceTo(armPos) < 1e-9, 'pinned to arm');
    assert.equal(obj._armPinned, true, 'flagged pinned');
  });
});

describe('DebrisField._advanceTumble — a captured catch stops rotating', () => {
  it('advances tumble for a free (uncaptured) debris', () => {
    const d = { tumbleRate: 0.1, tumbleAngle: 0 };
    DebrisField._advanceTumble(d, 1.0, 999);
    const expected = Math.min(0.1 * Constants.TIME_SCALE_GAMEPLAY, 999) * 1.0;
    assert.ok(d.tumbleAngle > 0, 'free debris tumbles');
    assert.ok(Math.abs(d.tumbleAngle - expected) < 1e-9, 'advanced by clamped visual rate');
  });

  it('freezes tumble while held by an arm (_capturedByArm) — reeling in', () => {
    const d = { tumbleRate: 0.1, tumbleAngle: 1.23, _capturedByArm: {} };
    DebrisField._advanceTumble(d, 1.0, 999);
    assert.equal(d.tumbleAngle, 1.23, 'a reeled-in catch does not rotate');
  });

  it('freezes tumble while pinned to the strut (_armPinned) — parked', () => {
    const d = { tumbleRate: 0.1, tumbleAngle: 2.5, _armPinned: true };
    DebrisField._advanceTumble(d, 1.0, 999);
    assert.equal(d.tumbleAngle, 2.5, 'a parked catch does not rotate');
  });

  it('resumes tumbling once released (flags cleared)', () => {
    const d = { tumbleRate: 0.1, tumbleAngle: 2.5, _armPinned: true };
    DebrisField._advanceTumble(d, 1.0, 999);
    assert.equal(d.tumbleAngle, 2.5, 'frozen while pinned');
    d._armPinned = false;
    DebrisField._advanceTumble(d, 1.0, 999);
    assert.ok(d.tumbleAngle > 2.5, 'tumbles again after release');
  });

  it('clamps the visual rate to maxVisualRad', () => {
    const d = { tumbleRate: 1000, tumbleAngle: 0 };
    DebrisField._advanceTumble(d, 1.0, 0.5);
    assert.ok(Math.abs(d.tumbleAngle - 0.5) < 1e-9, 'clamped to maxVisualRad * dt');
  });
});
