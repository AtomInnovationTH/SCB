/**
 * test-AutopilotSystem.js — Trailing-rendezvous autopilot unit tests.
 *
 * Covers (AUTOPILOT_ANALYSIS.md §D.5):
 *   1. Engage-with-no-target contract (AUTOPILOT_NO_TARGET emission).
 *   2. Engage-with-valid-target contract (AUTOPILOT_ENGAGE + AUTOPILOT_TARGET_LOCK).
 *   3. Disengage contract (AUTOPILOT_DISENGAGE + AUTOPILOT_TARGET_UNLOCK).
 *   4. Forward phase transitions: RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD → ARRIVED.
 *   5. Hysteresis regressions (HOLD→TRAIL, TRAIL→MATCH, MATCH→FAR).
 *   6. Tool-aware D_trail (lasso / spinner / weaver / trawl / default).
 *   7. Target lost mid-flight.
 *   8. Manual thrust / arrow-input override disengage (direct call, not event).
 *   9. CONJUNCTION_WARNING tier ≥ 2 disengage.
 *  10. HOLD geometry: debris in forward cone (angle < ANG_TOL).
 *  11. Isolated PlayerSatellite.applyCartesianImpulse algebra.
 *  12. No silent fallback: update() never calls thrustIon / _applyThrust.
 *
 * Runs in Node and browser (no THREE-DOM, no document). State machine driven
 * by overriding `_resolveTargetState` — a plain-object test seam.
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { AutopilotSystem } from '../systems/AutopilotSystem.js';
import { PlayerSatellite } from '../entities/PlayerSatellite.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';

const AP = Constants.AUTOPILOT;
const M = 0.00001;                                 // 1 metre in scene units
const ANG_TOL = AP.ANG_TOL_DEG * Math.PI / 180;

// ============================================================================
// MOCK FACTORIES
// ============================================================================

/**
 * Create a plain-object player with a valid LEO position and identity
 * attitude (nose = +Z world). `applyCartesianImpulse`, `thrustIon`, and
 * `_applyThrust` are spies recording all invocations.
 */
function makePlayer(
  pos = { x: 67.21, y: 0, z: 0 },           // LEO radial-X
  vel = { x: 0, y: 0, z: 7.5 },              // 7.5 km/s prograde (+Z)
) {
  const posVec = new THREE.Vector3(pos.x, pos.y, pos.z);
  const quat = new THREE.Quaternion();       // identity → nose = +Z world
  const manRot = new THREE.Quaternion();
  const apCalls = [];
  const thrustIonCalls = [];
  const applyThrustCalls = [];

  const p = {
    _pos: posVec,
    _vel: { ...vel },
    getPosition: () => posVec.clone(),
    getVelocity: () => ({ ...p._vel }),
    getForwardVector: () => new THREE.Vector3(0, 0, 1).applyQuaternion(quat),
    applyCartesianImpulse: (dv, dt) => {
      apCalls.push({ dv: new THREE.Vector3(dv.x, dv.y, dv.z), dt });
    },
    thrustIon: (...args) => { thrustIonCalls.push(args); },
    _applyThrust: (...args) => { applyThrustCalls.push(args); },
    quaternion: quat,
    _manualRotation: manRot,
    autopilotEngaged: false,
    orbit: {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE,
      eccentricity: 0.001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
    },
    resources: { xenon: 100, battery: 100 },
  };
  p.applyCartesianImpulse.calls = apCalls;
  p.thrustIon.calls = thrustIonCalls;
  p._applyThrust.calls = applyThrustCalls;
  return p;
}

function makeTarget(overrides = {}) {
  return {
    id: overrides.id ?? 42,
    alive: overrides.alive ?? true,
    type: overrides.type ?? 'defunctSat',
    orbit: overrides.orbit || {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE + 0.01,
      eccentricity: 0.001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 0.01, meanMotion: 0,
    },
  };
}

function makeTargetSelector({ active = null, recommendedTool = null, mode = 'TARGET' } = {}) {
  return {
    _active: active,
    _recommendedTool: recommendedTool,
    _mode: mode,
    getActiveTarget() { return this._active; },
    getActiveMode() { return this._mode; },
  };
}

function makeDebrisField(list = []) {
  return {
    debrisList: list,
    getDebrisById: (id) => list.find(d => d.id === id) || null,
  };
}

function makeArmManager(deltaV = 1000) {
  return {
    arms: [],
    getMassBudget: () => ({ deltaV, totalMass: 500, percentage: 0.8 }),
  };
}

function makeAP(opts = {}) {
  eventBus.clear();
  const ap = new AutopilotSystem();
  ap.init({
    player: opts.player || makePlayer(),
    targetSelector: opts.targetSelector || makeTargetSelector(),
    trawlManager: opts.trawlManager || null,
    debrisField: opts.debrisField || makeDebrisField(),
    armManager: opts.armManager || makeArmManager(1000),
  });
  return ap;
}

/**
 * Override the autopilot's target-state resolution so phase-transition logic
 * can be exercised with deterministic Pd, Vd. This is the cleanest seam:
 * it bypasses orbitToSceneCartesian and the DEBRIS/TRAWL/TARGET priority
 * chain entirely.
 */
function setTargetState(ap, { Pd, Vd, mode = 'TARGET' }) {
  const _Pd = Pd.clone ? Pd.clone() : new THREE.Vector3(Pd.x, Pd.y, Pd.z);
  const _Vd = Vd.clone ? Vd.clone() : new THREE.Vector3(Vd.x, Vd.y, Vd.z);
  ap._resolveTargetState = () => ({ Pd: _Pd.clone(), Vd: _Vd.clone(), mode });
}

function trackEvents(...names) {
  const log = [];
  names.forEach(n => eventBus.on(n, (data) => log.push({ event: n, data })));
  return log;
}

/**
 * Build a Pd that sits `metresAhead` metres ahead of the player along vHat.
 */
function pdAhead(player, vHat, metresAhead) {
  return player.getPosition().add(vHat.clone().multiplyScalar(metresAhead * M));
}

// ============================================================================
// SUITE 1: ENGAGE / DISENGAGE CONTRACT
// ============================================================================

describe('Autopilot — Engage / Disengage contract', () => {

  it('engage with no target emits AUTOPILOT_NO_TARGET and does not engage', () => {
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: null }) });
    const noTargetLog = trackEvents(Events.AUTOPILOT_NO_TARGET);
    ap.engage();
    assert.equal(noTargetLog.length, 1, 'AUTOPILOT_NO_TARGET must be emitted');
    // AUTOPILOT_ANALYSIS.md §D.5 #1: engage without a target should not engage.
    assert.equal(ap.engaged, false,
      'AP must not engage without a valid target (spec §D.5 #1)');
  });

  it('engage with valid target emits AUTOPILOT_ENGAGE + AUTOPILOT_TARGET_LOCK', () => {
    const target = makeTarget({ id: 42 });
    const ts = makeTargetSelector({ active: target });
    const ap = makeAP({ targetSelector: ts });
    const engageLog = trackEvents(Events.AUTOPILOT_ENGAGE);
    const lockLog = trackEvents(Events.AUTOPILOT_TARGET_LOCK);
    ap.engage();
    assert.equal(ap.engaged, true);
    assert.ok(engageLog.length >= 1, 'AUTOPILOT_ENGAGE must be emitted');
    assert.equal(engageLog[0].data.mode, 'TARGET');
    assert.equal(engageLog[0].data.phase, 'RENDEZVOUS_FAR');
    assert.equal(lockLog.length, 1, 'AUTOPILOT_TARGET_LOCK must fire once on engage');
    assert.equal(lockLog[0].data.debrisId, 42);
  });

  it('disengage emits AUTOPILOT_DISENGAGE + AUTOPILOT_TARGET_UNLOCK', () => {
    const target = makeTarget({ id: 7 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    const unlockLog = trackEvents(Events.AUTOPILOT_TARGET_UNLOCK);
    ap.disengage('MANUAL');
    assert.equal(ap.engaged, false);
    assert.equal(disLog.length, 1);
    assert.equal(disLog[0].data.reason, 'MANUAL');
    assert.equal(unlockLog.length, 1, 'AUTOPILOT_TARGET_UNLOCK must fire on disengage');
    assert.equal(unlockLog[0].data.debrisId, 7);
  });

  it('getCurrentPhase() returns OFF when disengaged, RENDEZVOUS_FAR on engage', () => {
    const target = makeTarget({ id: 1 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    assert.equal(ap.getCurrentPhase(), 'OFF');
    ap.engage();
    assert.equal(ap.getCurrentPhase(), 'RENDEZVOUS_FAR');
    ap.disengage('MANUAL');
    assert.equal(ap.getCurrentPhase(), 'OFF');
  });
});

// ============================================================================
// SUITE 2: FORWARD PHASE TRANSITIONS
// ============================================================================

describe('Autopilot — Forward phase transitions', () => {

  function engageAP(opts = {}) {
    const target = makeTarget({ id: 1 });
    const ts = makeTargetSelector({ active: target, recommendedTool: opts.tool });
    const player = makePlayer();
    const ap = makeAP({ targetSelector: ts, player });
    ap.engage();
    return { ap, player, vHat: new THREE.Vector3(0, 0, 1) };
  }

  it('stays in RENDEZVOUS_FAR when posErr ≫ FAR_TO_MATCH_POS', () => {
    const { ap, player, vHat } = engageAP();
    // 10 km ahead — posErr ~ 9.92 km (after subtracting 80m default trail)
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 10_000),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'RENDEZVOUS_FAR');
  });

  it('RENDEZVOUS_FAR → MATCH_ORBIT when posErr < FAR_TO_MATCH_POS', () => {
    const { ap, player, vHat } = engageAP();
    // Pd 300 m ahead → goal 220 m ahead → posErr = 220 < 500
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 300),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'MATCH_ORBIT');
  });

  it('MATCH_ORBIT → TRAIL_ALIGN when velErr < 4·VEL_TOL and posErr < 2·D_trail', () => {
    const { ap, player, vHat } = engageAP();
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 300),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1); // FAR → MATCH

    // posErr ~50 m (goal = 50 m < 2·80=160), velErr = 0.
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 130),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'TRAIL_ALIGN');
  });

  it('TRAIL_ALIGN → HOLD + AUTOPILOT_ARRIVED when all three tolerances met', () => {
    const { ap, player, vHat } = engageAP();
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 300), Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 130), Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'TRAIL_ALIGN');

    const arrivedLog = trackEvents(Events.AUTOPILOT_ARRIVED);
    // Goal distance = 90 − 80 = 10 m (< POS_TOL=15). velErr=0. angle=0 (identity quat, vHat = +Z).
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 90), Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'HOLD');
    assert.equal(arrivedLog.length, 1, 'AUTOPILOT_ARRIVED must fire on HOLD entry');
  });

  // ── HOLD-phase auto-disengage contract (revised 2026-05-15) ─────────────
  // Original semantic: HOLD timer fires ARRIVED after HOLD_DURATION regardless.
  // Revised semantic (user reported mother-AP turning off mid-mission):
  //   • With a LOCKED TARGET alive    → AP holds INDEFINITELY (no auto-disengage).
  //     Pilot manually disengages, captures, or the target dies.
  //   • Without a locked target       → AP auto-disengages with ARRIVED after
  //     HOLD_DURATION (cluster / prograde modes).
  // See AutopilotSystem.js:660 suppression block for rationale.
  it('HOLD with LOCKED TARGET → AP stays engaged past HOLD_DURATION', () => {
    const { ap, player, vHat } = engageAP();
    setTargetState(ap, { Pd: pdAhead(player, vHat, 300), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    setTargetState(ap, { Pd: pdAhead(player, vHat, 130), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    setTargetState(ap, { Pd: pdAhead(player, vHat, 90), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'HOLD');
    assert.ok(ap._lockedTargetRef && ap._lockedTargetRef.alive,
      'precondition: locked target must be alive');

    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    // Pump well past HOLD_DURATION — should NOT disengage with a locked target.
    ap.update(AP.HOLD_DURATION * 3);
    assert.equal(ap.engaged, true,
      'AP must stay engaged while locked target is alive (UX contract)');
    assert.equal(disLog.length, 0,
      'no AUTOPILOT_DISENGAGE may fire when holding on a locked target');
  });

  it('HOLD without locked target → disengage with reason ARRIVED after HOLD_DURATION', () => {
    const { ap, player, vHat } = engageAP();
    setTargetState(ap, { Pd: pdAhead(player, vHat, 300), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    setTargetState(ap, { Pd: pdAhead(player, vHat, 130), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    setTargetState(ap, { Pd: pdAhead(player, vHat, 90), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'HOLD');

    // Simulate cluster / prograde-mode AP: clear the locked target so the
    // ARRIVED fallback applies (timer ticks → auto-disengage).
    ap._lockedTargetRef = null;

    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    ap.update(AP.HOLD_DURATION + 0.1);          // exceed HOLD_DURATION
    assert.equal(ap.engaged, false);
    assert.equal(disLog.length, 1);
    assert.equal(disLog[0].data.reason, 'ARRIVED');
  });
});

// ============================================================================
// SUITE 3: HYSTERESIS / REGRESSIONS
// ============================================================================

describe('Autopilot — Hysteresis regressions', () => {

  function driveTo(phase) {
    const target = makeTarget({ id: 1 });
    const player = makePlayer();
    const vHat = new THREE.Vector3(0, 0, 1);
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }), player });
    ap.engage();
    if (phase === 'RENDEZVOUS_FAR') return { ap, player, vHat };
    setTargetState(ap, { Pd: pdAhead(player, vHat, 300), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    if (phase === 'MATCH_ORBIT') return { ap, player, vHat };
    setTargetState(ap, { Pd: pdAhead(player, vHat, 130), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    if (phase === 'TRAIL_ALIGN') return { ap, player, vHat };
    setTargetState(ap, { Pd: pdAhead(player, vHat, 90), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    return { ap, player, vHat };
  }

  it('HOLD → TRAIL_ALIGN on posErr spike > 2·POS_TOL', () => {
    const { ap, player, vHat } = driveTo('HOLD');
    assert.equal(ap.getCurrentPhase(), 'HOLD');
    // goal offset = 280 − 80 = 200 m > 30 m (2·POS_TOL)
    setTargetState(ap, { Pd: pdAhead(player, vHat, 280), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'TRAIL_ALIGN');
  });

  it('TRAIL_ALIGN → MATCH_ORBIT on drift > 3·D_trail', () => {
    const { ap, player, vHat } = driveTo('TRAIL_ALIGN');
    assert.equal(ap.getCurrentPhase(), 'TRAIL_ALIGN');
    // goal = 400 − 80 = 320 m > 3·80 = 240 m
    setTargetState(ap, { Pd: pdAhead(player, vHat, 400), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'MATCH_ORBIT');
  });

  it('MATCH_ORBIT → RENDEZVOUS_FAR on drift > 1.5·FAR_TO_MATCH_POS', () => {
    const { ap, player, vHat } = driveTo('MATCH_ORBIT');
    assert.equal(ap.getCurrentPhase(), 'MATCH_ORBIT');
    // goal = 900 − 80 = 820 m > 1.5·500 = 750 m
    setTargetState(ap, { Pd: pdAhead(player, vHat, 900), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'RENDEZVOUS_FAR');
  });
});

// ============================================================================
// SUITE 4: TOOL-AWARE D_TRAIL
// ============================================================================

describe('Autopilot — Tool-aware D_trail', () => {

  /** Verify dv direction aligns with (Pd − v̂·D_trail) − Pm for the given tool. */
  function runToolCase(tool, expectedD) {
    const target = makeTarget({ id: 1 });
    const ts = makeTargetSelector({ active: target, recommendedTool: tool });
    const player = makePlayer();
    const ap = makeAP({ targetSelector: ts, player });
    ap.engage();

    // Pd 100 m ahead of player in +v̂ direction — chosen so that different
    // D_trail values produce different-sign goal-offsets:
    //   D_trail <  100 → goal ahead (+z)  → dv_z > 0
    //   D_trail >  100 → goal behind (-z) → dv_z < 0
    const vHat = new THREE.Vector3(0, 0, 1);
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 100),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    ap.update(0.1);

    const calls = player.applyCartesianImpulse.calls;
    assert.ok(calls.length > 0,
      `applyCartesianImpulse must be called (tool=${tool})`);
    const dv = calls[0].dv;

    // Expected relP = (Pd − v̂ · expectedD · M) − Pm
    const expected = player.getPosition()
      .multiplyScalar(-1)                    // −Pm
      .add(pdAhead(player, vHat, 100))       // + Pd
      .add(vHat.clone().multiplyScalar(-expectedD * M));
    const dot = dv.x * expected.x + dv.y * expected.y + dv.z * expected.z;
    assert.ok(dot > 0,
      `dv must align with (Pd − v̂·${expectedD} m) − Pm for tool='${tool}' (dot=${dot.toExponential(3)})`);
  }

  it("tool='lasso'   uses D_TRAIL_LASSO  (120 m)", () => runToolCase('lasso',   AP.D_TRAIL_LASSO));
  it("tool='spinner' uses D_TRAIL_ARMS   (35 m)",  () => runToolCase('spinner', AP.D_TRAIL_ARMS));
  it("tool='weaver'  uses D_TRAIL_ARMS   (35 m)",  () => runToolCase('weaver',  AP.D_TRAIL_ARMS));
  it("tool='trawl'   uses D_TRAIL_TRAWL  (150 m)", () => runToolCase('trawl',   AP.D_TRAIL_TRAWL));
  it("tool=null      uses D_TRAIL_DEFAULT (80 m)", () => runToolCase(null,      AP.D_TRAIL_DEFAULT));
});

// ============================================================================
// SUITE 5: SAFETY CANCELS
// ============================================================================

describe('Autopilot — Safety cancels', () => {

  it('target.alive = false mid-flight disengages with TARGET_LOST', () => {
    const target = makeTarget({ id: 99 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    const unlockLog = trackEvents(Events.AUTOPILOT_TARGET_UNLOCK);
    target.alive = false;
    ap.update(0.1);
    assert.equal(ap.engaged, false);
    assert.equal(disLog[0].data.reason, 'TARGET_LOST');
    assert.equal(unlockLog.length, 1, 'UNLOCK must fire on TARGET_LOST disengage');
    assert.equal(unlockLog[0].data.debrisId, 99);
  });

  it('arrow-input / manual thrust override disengages (direct call)', () => {
    // AutopilotSystem does not subscribe to any "thrust input" event; per
    // AutopilotSystem.js:720 only CONJUNCTION_WARNING / TRAWL_START /
    // TRAWL_SWEEP_COMPLETE / TUTORIAL_* are listened to. Arrow-key override
    // is implemented by InputManager.js:147 calling
    // `autopilotSystem.disengage('ARROW_INPUT')` directly.
    const target = makeTarget({ id: 1 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    ap.disengage('ARROW_INPUT');
    assert.equal(ap.engaged, false);
    assert.equal(disLog[0].data.reason, 'ARROW_INPUT');
  });

  it('CONJUNCTION_WARNING tier ≥ 2 disengages with reason COLLISION', () => {
    const target = makeTarget({ id: 1 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 2 });
    assert.equal(ap.engaged, false);
    assert.equal(disLog[0].data.reason, 'COLLISION');
  });

  it('CONJUNCTION_WARNING tier 1 is informational — AP remains engaged', () => {
    const target = makeTarget({ id: 1 });
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 1 });
    assert.equal(ap.engaged, true, 'tier-1 warnings are informational, not cancellations');
  });

  it('ΔV budget below DISENGAGE_DV_MIN on update causes disengage', () => {
    const target = makeTarget({ id: 1 });
    // ArmManager reports 20 m/s on update call — below DISENGAGE_DV_MIN=30
    const armManager = makeArmManager(1000);
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      armManager,
    });
    ap.engage(); // engage OK (1000 ≥ ENGAGE_DV_MIN=50)
    armManager.getMassBudget = () => ({ deltaV: 20 });
    const disLog = trackEvents(Events.AUTOPILOT_DISENGAGE);
    ap.update(0.1);
    assert.equal(ap.engaged, false);
    assert.equal(disLog[0].data.reason, 'DELTAV');
  });
});

// ============================================================================
// SUITE 6: HOLD GEOMETRY (debris in forward cone)
// ============================================================================

describe('Autopilot — HOLD geometry', () => {

  it('after HOLD, normalize(Pd − Pm) · v̂_d > cos(ANG_TOL_DEG)', () => {
    const target = makeTarget({ id: 1 });
    const player = makePlayer();
    const vHat = new THREE.Vector3(0, 0, 1);
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }), player });
    ap.engage();

    setTargetState(ap, { Pd: pdAhead(player, vHat, 300), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    setTargetState(ap, { Pd: pdAhead(player, vHat, 130), Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    const finalPd = pdAhead(player, vHat, 90);
    setTargetState(ap, { Pd: finalPd, Vd: new THREE.Vector3(0, 0, 7.5) });
    ap.update(0.1);
    assert.equal(ap.getCurrentPhase(), 'HOLD');

    const toTarget = finalPd.clone().sub(player.getPosition()).normalize();
    const dot = toTarget.dot(vHat);
    assert.ok(dot > Math.cos(ANG_TOL),
      `debris must be in forward cone: dot=${dot.toFixed(5)} > cos(${AP.ANG_TOL_DEG}°)=${Math.cos(ANG_TOL).toFixed(5)}`);
  });
});

// ============================================================================
// SUITE 7: NO SILENT FALLBACK
// ============================================================================

describe('Autopilot — No element-basis fallback', () => {

  it('update() commands via applyCartesianImpulse and NEVER thrustIon/_applyThrust', () => {
    const target = makeTarget({ id: 1 });
    const player = makePlayer();
    const ap = makeAP({ targetSelector: makeTargetSelector({ active: target }), player });
    ap.engage();

    const vHat = new THREE.Vector3(0, 0, 1);
    setTargetState(ap, {
      Pd: pdAhead(player, vHat, 500),
      Vd: new THREE.Vector3(0, 0, 7.5),
    });
    for (let i = 0; i < 10; i++) ap.update(0.1);

    assert.ok(player.applyCartesianImpulse.calls.length > 0,
      'autopilot must command via applyCartesianImpulse');
    assert.equal(player._applyThrust.calls.length, 0,
      '_applyThrust must never be called by autopilot');
    assert.equal(player.thrustIon.calls.length, 0,
      'thrustIon must never be called by autopilot');
  });
});

// ============================================================================
// SUITE 8: PlayerSatellite.applyCartesianImpulse — isolated algebra
// ============================================================================

describe('PlayerSatellite — applyCartesianImpulse', () => {

  /**
   * Minimal duck-typed `this` for prototype-call invocation. Avoids building
   * a full THREE.Group-backed PlayerSatellite in Node.
   */
  function makePlayerStub() {
    const orbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE,
      eccentricity: 0.001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
    };
    const cart = orbitToSceneCartesian(orbit);
    return {
      orbit,
      _cartesian: {
        position: { ...cart.position },
        velocity: { ...cart.velocity },
      },
      _thrusterInterlock: false,
      _resourceSystem: null,
      resources: { xenon: 100, battery: 100 },
      quaternion: new THREE.Quaternion(),
      _fireRcsPuff: () => {},
      _deltaVSpent: 0,
      _ionDeltaV: 0.0003,
      throttleLevel: 1.0,
      _ionThrustXenonRate: 0.02,
      _ionThrustPowerRate: 5.0,
      _lastThrustOfflineWarning: 0,
    };
  }

  it('prograde ΔV increases semi-major axis', () => {
    const p = makePlayerStub();
    const v = p._cartesian.velocity;
    const vMag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const dv = new THREE.Vector3(v.x / vMag, v.y / vMag, v.z / vMag).multiplyScalar(5);
    const sma0 = p.orbit.semiMajorAxis;
    PlayerSatellite.prototype.applyCartesianImpulse.call(p, dv, 0.1);
    assert.ok(p.orbit.semiMajorAxis > sma0,
      `SMA must increase on prograde burn: ${sma0} → ${p.orbit.semiMajorAxis}`);
  });

  it('retrograde ΔV decreases semi-major axis', () => {
    const p = makePlayerStub();
    const v = p._cartesian.velocity;
    const vMag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const dv = new THREE.Vector3(v.x / vMag, v.y / vMag, v.z / vMag).multiplyScalar(-5);
    const sma0 = p.orbit.semiMajorAxis;
    PlayerSatellite.prototype.applyCartesianImpulse.call(p, dv, 0.1);
    assert.ok(p.orbit.semiMajorAxis < sma0,
      `SMA must decrease on retrograde burn: ${sma0} → ${p.orbit.semiMajorAxis}`);
  });

  it('dv ≈ 0 produces no SMA / trueAnomaly drift', () => {
    const p = makePlayerStub();
    const sma0 = p.orbit.semiMajorAxis;
    const nu0 = p.orbit.trueAnomaly;
    PlayerSatellite.prototype.applyCartesianImpulse.call(p, new THREE.Vector3(0, 0, 0), 0.1);
    // Early-return branch — no mutation whatsoever.
    assert.closeTo(p.orbit.semiMajorAxis, sma0, 1e-12, 'zero dv must not change SMA');
    assert.closeTo(p.orbit.trueAnomaly, nu0, 1e-12, 'zero dv must not teleport trueAnomaly');
  });

  it('small impulse does NOT teleport trueAnomaly', () => {
    const p = makePlayerStub();
    const v = p._cartesian.velocity;
    const vMag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const dv = new THREE.Vector3(v.x / vMag, v.y / vMag, v.z / vMag).multiplyScalar(0.1); // 0.1 m/s
    const nu0 = p.orbit.trueAnomaly;
    PlayerSatellite.prototype.applyCartesianImpulse.call(p, dv, 0.1);
    const dNu = Math.abs(p.orbit.trueAnomaly - nu0);
    assert.ok(dNu < 0.01,
      `trueAnomaly must not teleport (|Δν|=${dNu.toExponential(3)} > 0.01)`);
  });

  // ==========================================================================
  // Regression guard: Y-up/Z-up frame bug (fixed 2026-04).
  // Before the fix, one round-trip through cartesianToKeplerian → orbit
  // elements → orbitToSceneCartesian teleported the ship ~1500 km because
  // the two functions used different axis conventions.
  // ==========================================================================
  it('round-trip preserves position (< 1 m drift per impulse)', () => {
    const p = makePlayerStub();
    // Non-trivial phase so the bug-path (which collapsed to trueAnomaly=0) would
    // have produced a large mismatch.
    p.orbit.trueAnomaly = 1.2;
    p._cartesian = orbitToSceneCartesian(p.orbit);

    const pos0 = { ...p._cartesian.position };
    // Apply a tiny impulse — post-fix, the resulting _cartesian.position must
    // equal (r_before + v_before·0 + dv_contribution≈0 over this instant) to
    // within floating-point noise.
    const dv = new THREE.Vector3(0.01, 0, 0); // 0.01 m/s
    PlayerSatellite.prototype.applyCartesianImpulse.call(p, dv, 0.1);
    const dx = p._cartesian.position.x - pos0.x;
    const dy = p._cartesian.position.y - pos0.y;
    const dz = p._cartesian.position.z - pos0.z;
    const driftM = Math.sqrt(dx * dx + dy * dy + dz * dz) / M;
    assert.ok(driftM < 1.0,
      `round-trip must be position-preserving: drift=${driftM.toFixed(3)} m (was ~1.5e6 m pre-fix)`);
  });
});

// ============================================================================
// SUITE 9: INTEGRATION — real PlayerSatellite.applyCartesianImpulse in a closed
// AutopilotSystem.update() loop. This is the guard that would have caught the
// Y-up/Z-up round-trip bug. It exercises the physics bridge end-to-end — no
// monkey-patched _resolveTargetState, no stubbed impulse sink.
// ============================================================================

describe('Autopilot — Integration with real applyCartesianImpulse', () => {

  /**
   * Build a duck-typed player that uses the real PlayerSatellite.prototype
   * methods for the physics-critical path (applyCartesianImpulse,
   * _updateCartesian, _applyPosition) while avoiding THREE.Group / scene deps.
   * The main game loop (propagate → sync cartesian → sync .position) is
   * emulated by the caller.
   */
  function makeRealishPlayer(orbit) {
    const cart = orbitToSceneCartesian(orbit);
    const position = new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
    const player = {
      orbit,
      _cartesian: { position: { ...cart.position }, velocity: { ...cart.velocity } },
      position,                            // Three.js-style .position (scene units)
      quaternion: new THREE.Quaternion(),
      _manualRotation: new THREE.Quaternion(),
      _thrusterInterlock: false,
      _resourceSystem: null,
      resources: { xenon: 100, battery: 100 },
      _fireRcsPuff: () => {},
      _deltaVSpent: 0,
      _ionDeltaV: 0.0003,
      throttleLevel: 1.0,
      _ionThrustXenonRate: 0.02,
      _ionThrustPowerRate: 5.0,
      _lastThrustOfflineWarning: 0,
      autopilotEngaged: false,
      applyCartesianImpulse(dv, dt) {
        // Delegate to the real method — this is what we are testing.
        PlayerSatellite.prototype.applyCartesianImpulse.call(this, dv, dt);
        // Real game loop keeps .position synced with _cartesian.position
        this.position.set(this._cartesian.position.x,
                          this._cartesian.position.y,
                          this._cartesian.position.z);
      },
      getPosition() { return this.position.clone(); },
      getVelocity() { return { ...this._cartesian.velocity }; },
    };
    return player;
  }

  it('posErr decreases over the first second of an engage (no divergence)', () => {
    // Player in circular LEO.
    const playerOrbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + 4.0,  // ~400 km alt (scene units)
      eccentricity: 0.0001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 1.0, meanMotion: 0,
    };
    const player = makeRealishPlayer(playerOrbit);

    // Target a bit ahead on the same orbit (a few hundred metres ahead).
    const targetOrbit = { ...playerOrbit, trueAnomaly: 1.00003 };
    const target = { id: 99, alive: true, type: 'defunctSat', orbit: targetOrbit };
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      player,
    });
    ap.engage();
    assert.equal(ap.engaged, true, 'AP should engage on valid target');

    // Run for ~1 second at 60 Hz and record posErr each tick.
    const dt = 1 / 60;
    const nTicks = 60;
    const posErrHistory = [];

    for (let i = 0; i < nTicks; i++) {
      // (In the real game, propagateOrbit advances both player & target each
      // frame. For this unit-level integration we disable that — the goal is
      // to validate the autopilot+impulse bridge, not Keplerian drift. The
      // bug we're guarding against was per-tick teleport, which is visible in
      // as few as 2-3 ticks.)
      ap.update(dt);

      const Pm = player.getPosition();
      const targetCart = orbitToSceneCartesian(target.orbit);
      const Pd = new THREE.Vector3(targetCart.position.x, targetCart.position.y, targetCart.position.z);
      const errScene = Pm.distanceTo(Pd);
      posErrHistory.push(errScene / M);

      // Sanity: posErr must never explode to >> starting range.
      assert.ok(isFinite(posErrHistory[i]),
        `posErr went NaN/Inf at tick ${i}`);
      assert.ok(posErrHistory[i] < 1e6,
        `posErr exploded at tick ${i}: ${posErrHistory[i]} m`);
    }

    // The pre-fix bug caused per-tick teleports of ~1.5M metres.
    // Post-fix the ship should at minimum not DIVERGE — first and last
    // samples within comparable range, and no individual tick should jump
    // more than a few kilometres (orbital motion between ticks is ~125 m
    // at 60 Hz for LEO; autopilot thrust adds < 0.04 m/tick).
    const maxJump = Math.max(...posErrHistory.map(
      (e, i) => i === 0 ? 0 : Math.abs(e - posErrHistory[i - 1])
    ));
    assert.ok(maxJump < 10000,
      `autopilot diverged — max per-tick posErr jump = ${maxJump.toFixed(0)} m ` +
      `(was ~1.5e6 m with the Y-up/Z-up bug)`);

    // SMA should never swing wildly (pre-fix bug scrambled the orbit every tick).
    const sma = player.orbit.semiMajorAxis;
    assert.ok(Math.abs(sma - playerOrbit.semiMajorAxis) < 0.5,
      `SMA drifted unreasonably: ${playerOrbit.semiMajorAxis} → ${sma}`);

    ap.disengage('MANUAL');
  });

  it('posErr strictly decreases over 0.5s when target is stationary in scene frame', () => {
    // Target a few hundred metres ahead — with no orbital propagation, the
    // trailing-rendezvous point is a fixed world-frame goal, and the
    // controller must drive posErr monotonically toward POS_TOL.
    const playerOrbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + 4.0,
      eccentricity: 0.0001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 1.0, meanMotion: 0,
    };
    const player = makeRealishPlayer(playerOrbit);
    const target = { id: 100, alive: true, type: 'defunctSat', orbit: { ...playerOrbit, trueAnomaly: 1.00003 } };

    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      player,
    });
    ap.engage();

    // Freeze the target state (so the goal pose is a single fixed point).
    // Use the goal pose that the AP would see after resolving the target.
    const targetCart = orbitToSceneCartesian(target.orbit);
    const Pd = new THREE.Vector3(targetCart.position.x, targetCart.position.y, targetCart.position.z);
    const Vd = new THREE.Vector3(targetCart.velocity.x, targetCart.velocity.y, targetCart.velocity.z);
    setTargetState(ap, { Pd, Vd });

    const dt = 1 / 60;
    const nTicks = 30; // 0.5 s
    const vHat = Vd.clone().normalize();
    const Dtrail_scene = AP.D_TRAIL_DEFAULT * M;
    const goalPos = Pd.clone().addScaledVector(vHat, -Dtrail_scene);

    let firstErr = null, lastErr = null;
    for (let i = 0; i < nTicks; i++) {
      ap.update(dt);
      const errM = player.getPosition().distanceTo(goalPos) / M;
      if (i === 0) firstErr = errM;
      lastErr = errM;
    }

    // Must make measurable progress toward the goal (not diverge, not stall).
    // This is the key anti-divergence guard: pre-fix, lastErr was essentially
    // random due to per-tick teleport.
    assert.ok(lastErr < firstErr,
      `posErr must decrease over 0.5 s: first=${firstErr.toFixed(1)} m, last=${lastErr.toFixed(1)} m`);
  });

  // ==========================================================================
  // Regression guard: overshoot-on-approach (fixed 2026-04).
  // Before the predictive-braking fix, a proportional KP_POS·r + KP_VEL·v law
  // built up 40–120 m/s closing velocity that it could not dissipate in time,
  // so the ship flew through the goal by 250+ m and receded. This test uses a
  // physics-integrating player (Cartesian state advanced via explicit Euler
  // each tick) to expose closed-loop controller dynamics without dragging in
  // the Keplerian propagator. The matching-frame approximation is valid for
  // the ≤ 30 s window tested (tidal drift < 1 m at LEO scales).
  // ==========================================================================
  /**
   * Cartesian-authoritative player stub for controller integration tests.
   * Unlike `makeRealishPlayer`, this one advances `position` via explicit
   * Euler integration of the current velocity — so thrust commands produce
   * observable displacement even without calling `propagateOrbit`.
   */
  function makeIntegratingPlayer(startPosM, startVelMps) {
    const pos = new THREE.Vector3(startPosM.x * M, startPosM.y * M, startPosM.z * M);
    const vel_kms = {
      x: startVelMps.x * 1e-3,
      y: startVelMps.y * 1e-3,
      z: startVelMps.z * 1e-3,
    };
    const quat = new THREE.Quaternion();
    const mr = new THREE.Quaternion();
    const impulses = [];
    return {
      _pos: pos, _vel: vel_kms, impulses,
      getPosition: () => pos.clone(),
      getVelocity: () => ({ ...vel_kms }),
      applyCartesianImpulse(dv, _dt) {
        impulses.push({ x: dv.x, y: dv.y, z: dv.z });
        vel_kms.x += dv.x * 1e-3;
        vel_kms.y += dv.y * 1e-3;
        vel_kms.z += dv.z * 1e-3;
      },
      thrustIon() { throw new Error('AP must not call thrustIon'); },
      _applyThrust() { throw new Error('AP must not call _applyThrust'); },
      integratePosition(dt) {
        pos.x += vel_kms.x * dt * Constants.SCENE_SCALE;
        pos.y += vel_kms.y * dt * Constants.SCENE_SCALE;
        pos.z += vel_kms.z * dt * Constants.SCENE_SCALE;
      },
      quaternion: quat,
      _manualRotation: mr,
      autopilotEngaged: false,
      orbit: {
        semiMajorAxis: Constants.EARTH_RADIUS + 4.0,
        eccentricity: 0.0001,
        inclination: 51.6 * Math.PI / 180,
        raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
      },
      resources: { xenon: 100, battery: 100 },
    };
  }

  it('approaches from 500 m without overshoot (closest-approach < POS_TOL, sustained)', () => {
    // Realistic LEO starting Cartesian state in scene units (avoids the
    // `_rotateTowardWorld` radial-normalise singularity at the origin).
    const R_LEO_M = (Constants.EARTH_RADIUS + 4.0) / M;   // metres
    const V_ORBITAL_MPS = 7500;                           // roughly circular LEO
    const player = makeIntegratingPlayer(
      { x: R_LEO_M, y: 0, z: 0 },
      { x: 0, y: 0, z: V_ORBITAL_MPS },
    );

    // Target 500 m ahead along +Z, co-moving at V_ORBITAL_MPS. Goal pose =
    // Pd − v̂·D_trail (80 m behind target). Initial posErr = 500 − 80 = 420 m.
    const Dtrail_m = AP.D_TRAIL_DEFAULT;
    const target = {
      id: 600, alive: true, type: 'defunctSat',
      orbit: { semiMajorAxis: 1, eccentricity: 0, inclination: 0,
               raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0 },
    };
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      player,
    });
    ap.engage();

    // Drive deterministic target state each tick via the same seam the other
    // suites use. Target drifts prograde at V_ORBITAL_MPS in matching frame.
    const targetPos_m = { x: R_LEO_M, y: 0, z: 500 };
    ap._resolveTargetState = () => ({
      Pd: new THREE.Vector3(targetPos_m.x * M, targetPos_m.y * M, targetPos_m.z * M),
      Vd: new THREE.Vector3(0, 0, V_ORBITAL_MPS * 1e-3),
      mode: 'TARGET',
    });

    // Run for 60 s at 60 Hz. The predictive-braking law produces an
    // asymptotic approach (v*(r) = √(2·A_BRAKE·r)) whose final-metres phase
    // takes O(√r) time to dissipate — 60 s comfortably covers the 420 m
    // approach used here.
    const dt = 1 / 60;
    const nTicks = 60 * 60;
    let minErr = Infinity;
    let minErrTick = 0;
    const errHistory = [];
    for (let i = 0; i < nTicks; i++) {
      ap.update(dt);
      // Propagate both target and player after AP reads a consistent state.
      targetPos_m.z += V_ORBITAL_MPS * dt;
      player.integratePosition(dt);

      // Compute posErr against the same goal geometry the AP uses.
      const goalZ_m = targetPos_m.z - Dtrail_m;
      const p = player.getPosition();
      const dx = (targetPos_m.x * M - p.x) / M;
      const dy = (targetPos_m.y * M - p.y) / M;
      const dz_goal = goalZ_m - p.z / M;
      const errM = Math.hypot(dx, dy, dz_goal);
      errHistory.push(errM);
      if (errM < minErr) { minErr = errM; minErrTick = i; }
    }

    // Primary overshoot guard: closest approach must land within POS_TOL.
    // Pre-fix closest approach was <1 m but with ~40-60 m/s residual velocity
    // that immediately flung the ship 250+ m past the goal.
    assert.ok(minErr < AP.POS_TOL,
      `closest-approach overshoot: min=${minErr.toFixed(2)} m exceeds POS_TOL=${AP.POS_TOL} m`);

    // Sustained-convergence guard: in the final 1 s the ship must remain
    // within 2·POS_TOL of the goal. Pre-fix the ship was receding at many m/s
    // indefinitely after overshoot.
    const tailErrs = errHistory.slice(-60);
    const maxTailErr = Math.max(...tailErrs);
    assert.ok(maxTailErr < 2 * AP.POS_TOL,
      `ship did not settle near goal: max posErr in final 1 s = ${maxTailErr.toFixed(2)} m`);

    // Phase guard: by the end of the run we should have advanced past
    // RENDEZVOUS_FAR and MATCH_ORBIT. TRAIL_ALIGN, HOLD, or OFF (disengaged
    // on HOLD_DURATION) all indicate successful convergence.
    const finalPhase = ap.getCurrentPhase();
    assert.ok(finalPhase === 'HOLD' || finalPhase === 'TRAIL_ALIGN' || finalPhase === 'OFF',
      `final phase should indicate convergence: got ${finalPhase} ` +
      `(minErrTick=${minErrTick}/${nTicks}, minErr=${minErr.toFixed(2)} m, maxTailErr=${maxTailErr.toFixed(2)} m)`);
  });
});

// ============================================================================
// SUITE: STATION-KEEPING RECOIL COMPENSATION (ST-4.B)
// ============================================================================

describe('Autopilot — Station-keeping recoil compensation', () => {

  it('LASSO_FIRED in HOLD → opposite impulse applied with correct magnitude', () => {
    const target = makeTarget({ id: 99 });
    const player = makePlayer();
    player.mass = 130;
    const ap = makeAP({ player, targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();

    // Force into HOLD phase
    ap._phase = 'HOLD';

    const launchDir = new THREE.Vector3(1, 0, 0); // fired along +X
    eventBus.emit(Events.LASSO_FIRED, {
      targetId: 99,
      projectileMass: 2.5,
      launchDirection: launchDir.clone(),
      speed: 10,
    });

    const calls = player.applyCartesianImpulse.calls;
    // Find the recoil call (dt === 0)
    const recoilCalls = calls.filter(c => c.dt === 0);
    assert.equal(recoilCalls.length, 1, 'exactly one recoil impulse should be applied');

    const dv = recoilCalls[0].dv;
    // Expected: -(2.5 * 10 / 130) * 0.85 ≈ -0.1635 m/s along X
    const expectedMag = (2.5 * 10 / 130) * 0.85;
    assert.ok(dv.x < 0, 'impulse must oppose +X launch direction');
    assert.ok(Math.abs(dv.x + expectedMag) < 0.001,
      `ΔV.x should be ~-${expectedMag.toFixed(4)}, got ${dv.x.toFixed(4)}`);
    assert.ok(Math.abs(dv.y) < 1e-6, 'no Y component expected');
    assert.ok(Math.abs(dv.z) < 1e-6, 'no Z component expected');
  });

  it('CROSSBOW_FIRE in HOLD → impulse applied', () => {
    const target = makeTarget({ id: 50 });
    const player = makePlayer();
    player.mass = 130;
    const ap = makeAP({ player, targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    ap._phase = 'HOLD';

    const launchDir = new THREE.Vector3(0, 1, 0).normalize(); // fired along +Y
    eventBus.emit(Events.CROSSBOW_FIRE, {
      armIndex: 0,
      speed: 5,
      springTier: 0,
      armMass: 8,
      launchDirection: launchDir.clone(),
    });

    const recoilCalls = player.applyCartesianImpulse.calls.filter(c => c.dt === 0);
    assert.equal(recoilCalls.length, 1, 'exactly one recoil impulse for crossbow');

    const dv = recoilCalls[0].dv;
    // Expected: -(8 * 5 / 130) * 0.85 ≈ -0.2615 m/s along Y
    const expectedMag = (8 * 5 / 130) * 0.85;
    assert.ok(dv.y < 0, 'impulse must oppose +Y launch direction');
    assert.ok(Math.abs(dv.y + expectedMag) < 0.001,
      `ΔV.y should be ~-${expectedMag.toFixed(4)}, got ${dv.y.toFixed(4)}`);
  });

  it('non-HOLD phase → no impulse applied', () => {
    const target = makeTarget({ id: 30 });
    const player = makePlayer();
    const ap = makeAP({ player, targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();

    // Phase is RENDEZVOUS_FAR (default after engage), NOT HOLD
    assert.ok(ap.getCurrentPhase() !== 'HOLD', 'sanity: phase must not be HOLD');

    eventBus.emit(Events.LASSO_FIRED, {
      targetId: 30,
      projectileMass: 2.5,
      launchDirection: new THREE.Vector3(1, 0, 0),
      speed: 10,
    });

    // Filter for recoil-specific calls (dt === 0)
    const recoilCalls = player.applyCartesianImpulse.calls.filter(c => c.dt === 0);
    assert.equal(recoilCalls.length, 0, 'no recoil impulse outside HOLD phase');
  });

  it('STATION_KEEP_COMPENSATION=false → no impulse applied', () => {
    const origVal = Constants.AUTOPILOT.STATION_KEEP_COMPENSATION;
    Constants.AUTOPILOT.STATION_KEEP_COMPENSATION = false;

    try {
      const target = makeTarget({ id: 20 });
      const player = makePlayer();
      const ap = makeAP({ player, targetSelector: makeTargetSelector({ active: target }) });
      ap.engage();
      ap._phase = 'HOLD';

      eventBus.emit(Events.LASSO_FIRED, {
        targetId: 20,
        projectileMass: 2.5,
        launchDirection: new THREE.Vector3(1, 0, 0),
        speed: 10,
      });

      const recoilCalls = player.applyCartesianImpulse.calls.filter(c => c.dt === 0);
      assert.equal(recoilCalls.length, 0, 'compensation disabled → no recoil impulse');
    } finally {
      Constants.AUTOPILOT.STATION_KEEP_COMPENSATION = origVal;
    }
  });

  it('stationKeepDeltaV accumulates across multiple firings', () => {
    const target = makeTarget({ id: 10 });
    const player = makePlayer();
    player.mass = 130;
    const ap = makeAP({ player, targetSelector: makeTargetSelector({ active: target }) });
    ap.engage();
    ap._phase = 'HOLD';

    assert.equal(ap.getStationKeepDeltaV(), 0, 'starts at zero');

    // First firing
    eventBus.emit(Events.LASSO_FIRED, {
      targetId: 10,
      projectileMass: 2.5,
      launchDirection: new THREE.Vector3(1, 0, 0),
      speed: 10,
    });
    const dv1 = (2.5 * 10 / 130) * 0.85;
    assert.ok(Math.abs(ap.getStationKeepDeltaV() - dv1) < 0.001,
      `after 1st fire: expected ~${dv1.toFixed(4)}, got ${ap.getStationKeepDeltaV().toFixed(4)}`);

    // Second firing (crossbow)
    eventBus.emit(Events.CROSSBOW_FIRE, {
      armIndex: 0,
      speed: 5,
      springTier: 0,
      armMass: 8,
      launchDirection: new THREE.Vector3(0, 0, 1),
    });
    const dv2 = (8 * 5 / 130) * 0.85;
    const totalExpected = dv1 + dv2;
    assert.ok(Math.abs(ap.getStationKeepDeltaV() - totalExpected) < 0.001,
      `after 2nd fire: expected ~${totalExpected.toFixed(4)}, got ${ap.getStationKeepDeltaV().toFixed(4)}`);
  });
});

// ============================================================================
// SUITE: TRAWL GATE — SELF-HEAL + ABORT-ON-SECOND-PRESS (UX-11 #4)
// ============================================================================

describe('Autopilot — Trawl gate self-heal + abort override', () => {

  it('stale _trawlActive with inactive TrawlManager self-heals and engages', () => {
    const target = makeTarget({ id: 42 });
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      trawlManager: { active: false },
    });
    ap._trawlActive = true;  // simulate stuck flag (sweep never completed)
    ap.engage();
    assert.equal(ap._trawlActive, false, 'stale flag must be cleared');
    assert.equal(ap.engaged, true, 'AP must engage after self-heal');
  });

  it('genuine trawl: first A denies + arms abort; second A emits TRAWL_ABORT and engages', () => {
    const target = makeTarget({ id: 42 });
    const trawlManager = { active: true };
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      trawlManager,
    });
    ap._trawlActive = true;

    // Simulate TrawlManager's abort handling: end sweep + emit completion
    eventBus.on(Events.TRAWL_ABORT, () => {
      trawlManager.active = false;
      eventBus.emit(Events.TRAWL_SWEEP_COMPLETE, { duration: 0, targetsEntered: 0 });
    });
    const abortLog = trackEvents(Events.TRAWL_ABORT);

    ap.engage();   // first press — denied, arms abort
    assert.equal(ap.engaged, false, 'first press must not engage');
    assert.equal(ap._trawlAbortArmed, true, 'first press must arm the abort');
    assert.equal(abortLog.length, 0, 'no abort on first press');

    ap.engage();   // second press — abort + engage
    assert.equal(abortLog.length, 1, 'second press must emit TRAWL_ABORT');
    assert.equal(ap._trawlActive, false, 'sweep-complete must clear the flag');
    assert.equal(ap.engaged, true, 'second press must engage');
  });

  it('TRAWL_SWEEP_COMPLETE disarms a pending abort', () => {
    const target = makeTarget({ id: 42 });
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      trawlManager: { active: true },
    });
    ap._trawlActive = true;
    ap.engage();   // denied → armed
    assert.equal(ap._trawlAbortArmed, true);
    eventBus.emit(Events.TRAWL_SWEEP_COMPLETE, {});
    assert.equal(ap._trawlAbortArmed, false, 'completion must disarm the abort');
    assert.equal(ap._trawlActive, false);
  });

  it('ΔV guard runs BEFORE the trawl abort — low-ΔV double-A never kills the sweep', () => {
    const target = makeTarget({ id: 42 });
    const trawlManager = { active: true };
    const ap = makeAP({
      targetSelector: makeTargetSelector({ active: target }),
      trawlManager,
      armManager: makeArmManager(10),   // ΔV far below ENGAGE_DV_MIN (50)
    });
    ap._trawlActive = true;
    const abortLog = trackEvents(Events.TRAWL_ABORT);

    ap.engage();   // denied on ΔV — must not arm the abort
    ap.engage();   // still denied on ΔV — must not emit TRAWL_ABORT
    assert.equal(abortLog.length, 0, 'no destructive abort while engage is ΔV-denied');
    assert.equal(ap._trawlAbortArmed, false, 'abort never armed under ΔV denial');
    assert.equal(ap._trawlActive, true, 'sweep untouched');
    assert.equal(ap.engaged, false);
  });
});

// ============================================================================
// SUITE: ONE-TAP RE-ACQUIRE (UX-11 #11 — A with no target)
// ============================================================================

describe('Autopilot — One-tap re-acquire with no target', () => {

  function makeSelectableTargetSelector() {
    const ts = makeTargetSelector({ active: null });
    ts.setTarget = function (debris, context = {}) {
      this._active = debris;
      this._lastContext = context;
    };
    return ts;
  }

  it('A with no target auto-selects nearest live large debris and engages', () => {
    const near = makeTarget({ id: 7 });
    near.mass = 120;
    const far = makeTarget({
      id: 8,
      orbit: {
        semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE + 0.5,
        eccentricity: 0.001, inclination: 51.6 * Math.PI / 180,
        raan: 0, argPerigee: 0, trueAnomaly: 1.5, meanMotion: 0,
      },
    });
    far.mass = 200;
    const ts = makeSelectableTargetSelector();
    const ap = makeAP({
      targetSelector: ts,
      debrisField: makeDebrisField([far, near]),
    });

    const noTargetLog = trackEvents(Events.AUTOPILOT_NO_TARGET);
    ap.engage();

    assert.equal(noTargetLog.length, 0, 'must NOT emit AUTOPILOT_NO_TARGET when a contact exists');
    assert.equal(ap.engaged, true, 'must engage in one press');
    assert.equal(ts.getActiveTarget()?.id, 7, 'nearest large debris must become the selected target');
    assert.equal(ap.headingMode, 'TARGET');
  });

  it('A with only small debris falls back to any-mass acquire (advisor parity)', () => {
    const small = makeTarget({ id: 9 });
    small.mass = 5;  // below LARGE_DEBRIS_MASS — fallback path must still engage
    const ts = makeSelectableTargetSelector();
    const ap = makeAP({
      targetSelector: ts,
      debrisField: makeDebrisField([small]),
    });
    const noTargetLog = trackEvents(Events.AUTOPILOT_NO_TARGET);
    ap.engage();
    assert.equal(noTargetLog.length, 0, 'small-only field must NOT dead-end');
    assert.equal(ap.engaged, true, 'fallback acquires any live debris');
    assert.equal(ts.getActiveTarget()?.id, 9);
  });

  it('A with a truly empty field emits AUTOPILOT_NO_TARGET', () => {
    const ts = makeSelectableTargetSelector();
    const ap = makeAP({
      targetSelector: ts,
      debrisField: makeDebrisField([]),
    });
    const noTargetLog = trackEvents(Events.AUTOPILOT_NO_TARGET);
    ap.engage();
    assert.equal(noTargetLog.length, 1, 'no live debris at all → AUTOPILOT_NO_TARGET');
    assert.equal(ap.engaged, false);
  });
});
