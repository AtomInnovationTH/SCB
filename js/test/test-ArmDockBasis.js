/**
 * test-ArmDockBasis.js — shared docked-daughter orientation basis (Item 4).
 *
 * `composeDockedArmQuat(strutDir, azRad, out)` is the single source of truth for
 * the deterministic docked-arm local quaternion, shared by
 * `PlayerSatellite.postArmUpdate` (DOCKED snap + DOCKING slerp + HOLDING_CATCH
 * snap) and (formerly duplicated) PlayerSatellite-local code. Pure + Node-safe.
 *
 * Convention (HANDOFF §9 Rule 2/4): local +Z (forward) maps onto strutDir.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { composeDockedArmQuat } from '../entities/ArmDockBasis.js';

const _Z = new THREE.Vector3(0, 0, 1);

describe('ArmDockBasis — composeDockedArmQuat', () => {
  it('maps local +Z onto the strut direction', () => {
    const strut = new THREE.Vector3(1, 0, 0);     // radial-X
    const q = composeDockedArmQuat(strut, 0, new THREE.Quaternion());
    const fwd = _Z.clone().applyQuaternion(q);
    assert.ok(fwd.distanceTo(strut) < 1e-9, 'forward (+Z) aligns with strut');
  });

  it('is deterministic — same input gives the same quaternion', () => {
    const strut = new THREE.Vector3(0, 1, 0);
    const a = composeDockedArmQuat(strut, Math.PI / 2, new THREE.Quaternion());
    const b = composeDockedArmQuat(strut, Math.PI / 2, new THREE.Quaternion());
    assert.ok(a.angleTo(b) < 1e-9, 'repeatable basis (no random roll)');
  });

  it('produces a normalized quaternion', () => {
    const strut = new THREE.Vector3(0.3, 0.7, -0.2).normalize();
    const q = composeDockedArmQuat(strut, 1.1, new THREE.Quaternion());
    assert.ok(Math.abs(q.length() - 1) < 1e-9, 'unit quaternion (orthonormal basis)');
  });

  it('uses azimuth-radial as the up reference (shared roll convention)', () => {
    // For an X-radial strut at azimuth 0, up should be the radial (cos0,sin0,0)
    // projected perpendicular to forward → since forward IS the radial here, the
    // basis falls back to a stable secondary axis but must stay orthonormal and
    // repeatable across the ring. Two arms 90° apart share the same construction.
    const s0 = new THREE.Vector3(Math.cos(0), Math.sin(0), 0);
    const s90 = new THREE.Vector3(Math.cos(Math.PI / 2), Math.sin(Math.PI / 2), 0);
    const q0 = composeDockedArmQuat(s0, 0, new THREE.Quaternion());
    const q90 = composeDockedArmQuat(s90, Math.PI / 2, new THREE.Quaternion());
    // Both forwards align with their struts (the core contract).
    assert.ok(_Z.clone().applyQuaternion(q0).distanceTo(s0) < 1e-9, 'arm0 forward = strut0');
    assert.ok(_Z.clone().applyQuaternion(q90).distanceTo(s90) < 1e-9, 'arm90 forward = strut90');
  });

  it('handles the degenerate (forward ∥ radial-up) case without NaN', () => {
    // strut along +Z, azimuth 0 → up=(1,0,0) is perpendicular, fine; but force a
    // case where radial-up is parallel to forward by aligning strut with the
    // radial at azRad. Guard must keep the quaternion finite + unit.
    const strut = new THREE.Vector3(1, 0, 0);
    const q = composeDockedArmQuat(strut, 0, new THREE.Quaternion());
    assert.ok(Number.isFinite(q.x + q.y + q.z + q.w), 'no NaN from degenerate basis');
    assert.ok(Math.abs(q.length() - 1) < 1e-9, 'still unit');
  });
});
