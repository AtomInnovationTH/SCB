/**
 * test-CollisionAvoidance.js — CollisionAvoidanceSystem unit tests
 *
 * Tests the semi-autonomous evasive manoeuvre system: threat detection (TCA
 * prediction), RCS dodge execution, suppression logic (ARM_PILOT, WASD
 * override, trawl mode), and full threat lifecycle events.
 *
 * Requires Three.js (installed via package.json for Node, import map for browser).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CollisionAvoidanceSystem } from '../systems/CollisionAvoidanceSystem.js';

const CA = Constants.COLLISION_AVOIDANCE;
const M = 0.00001; // 1 metre in scene units (same as CollisionAvoidanceSystem.js)

// ============================================================================
// MOCK FACTORIES
// ============================================================================

/** Create a mock player satellite at LEO distance (+x radial) */
function makePlayer(pos = { x: 0.065, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 7.5 }) {
  return {
    getPosition: () => new THREE.Vector3(pos.x, pos.y, pos.z),
    getVelocity: () => vel,
    _rcsVelocity: new THREE.Vector3(0, 0, 0),
    _fireRcsPuff: () => {},
    _cartesian: { velocity: vel },
  };
}

/** Create a mock debris field */
function makeDebrisField(debrisList = []) {
  return { debrisList };
}

/** Create a mock input manager */
function makeInputManager(keys = {}) {
  return { keys };
}

/** Create a mock arm manager */
function makeArmManager(arms = []) {
  return { arms };
}

/** Create a fresh CollisionAvoidanceSystem with mocked dependencies */
function makeSystem(opts = {}) {
  eventBus.clear();
  const sys = new CollisionAvoidanceSystem();
  sys.init({
    player: opts.player || makePlayer(),
    debrisField: opts.debrisField || makeDebrisField(),
    armManager: opts.armManager || makeArmManager(),
    inputManager: opts.inputManager || makeInputManager(),
  });
  return sys;
}

/** Build a mock threat object (same shape as _scanForThreats returns) */
function makeThreat(overrides = {}) {
  return {
    debrisId: 42,
    tca: 3.0,
    missDistScene: CA.AVOIDANCE_RADIUS * 0.5,
    missDistM: 50,
    threatDir: { x: 1, y: 0, z: 0 },
    evasionDir: { x: 0, y: 1, z: 0 },
    ...overrides,
  };
}

/** Track emitted events — returns a growing array of { event, data } */
function trackEvents(...eventNames) {
  const log = [];
  eventNames.forEach(name => {
    eventBus.on(name, (data) => log.push({ event: name, data }));
  });
  return log;
}

// ── Suite 24: CA — Initialization & Lifecycle ──────────────────────────
describe('CA — Initialization & Lifecycle', () => {

  it('system initializes enabled by default', () => {
    const sys = makeSystem();
    assert.equal(sys.enabled, true);
    assert.equal(sys.enabled, CA.ENABLED_DEFAULT);
  });

  it('no active threats on init', () => {
    const sys = makeSystem();
    const status = sys.getStatus();
    assert.equal(status.currentThreat, null);
  });

  it('getStatus() returns correct shape', () => {
    const sys = makeSystem();
    const s = sys.getStatus();
    assert.ok('enabled' in s, 'status has enabled');
    assert.ok('currentThreat' in s, 'status has currentThreat');
    assert.ok('lastDodgeTime' in s, 'status has lastDodgeTime');
    assert.ok('trawlActive' in s, 'status has trawlActive');
    assert.ok('armPilotMode' in s, 'status has armPilotMode');
  });

  it('reset() clears all state', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 5 };
    sys._elapsedTime = 100;
    sys._activeTargetId = 42;
    sys._trawlActive = true;
    sys._armPilotMode = true;
    sys._lastSuppressedReason = 'arm_pilot';
    sys.reset();
    assert.equal(sys._currentThreat, null);
    assert.equal(sys._elapsedTime, 0);
    assert.equal(sys._activeTargetId, null);
    assert.equal(sys._trawlActive, false);
    assert.equal(sys._armPilotMode, false);
    assert.equal(sys._lastSuppressedReason, null);
  });

  it('GAME_RESET event triggers reset()', () => {
    const sys = makeSystem();
    sys._elapsedTime = 999;
    sys._trawlActive = true;
    sys._currentThreat = { debrisId: 1 };
    eventBus.emit(Events.GAME_RESET);
    assert.equal(sys._elapsedTime, 0);
    assert.equal(sys._trawlActive, false);
    assert.equal(sys._currentThreat, null);
  });

  it('non-gameplay state (MENU) clears threat and scan timer', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 1 };
    sys._scanTimer = 0.2;
    eventBus.emit(Events.GAME_STATE_CHANGE, { to: 'MENU' });
    assert.equal(sys._currentThreat, null);
    assert.equal(sys._scanTimer, 0);
  });

  it('non-gameplay state (SHOP) clears threat', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 2 };
    eventBus.emit(Events.GAME_STATE_CHANGE, { to: 'SHOP' });
    assert.equal(sys._currentThreat, null);
  });

  it('gameplay state ORBITAL_VIEW preserves threat', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 3 };
    eventBus.emit(Events.GAME_STATE_CHANGE, { to: 'ORBITAL_VIEW' });
    assert.ok(sys._currentThreat !== null, 'threat should persist in ORBITAL_VIEW');
  });

  it('gameplay state APPROACH preserves threat', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 4 };
    eventBus.emit(Events.GAME_STATE_CHANGE, { to: 'APPROACH' });
    assert.ok(sys._currentThreat !== null, 'threat should persist in APPROACH');
  });

  it('gameplay state INTERACTION preserves threat', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 5 };
    eventBus.emit(Events.GAME_STATE_CHANGE, { to: 'INTERACTION' });
    assert.ok(sys._currentThreat !== null, 'threat should persist in INTERACTION');
  });

  it('toggle() inverts enabled and emits CA_TOGGLED', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_TOGGLED);
    sys.toggle();
    assert.equal(sys.enabled, false);
    assert.equal(log.length, 1);
    assert.equal(log[0].data.enabled, false);
  });

  it('CA_TOGGLED event updates enabled state', () => {
    const sys = makeSystem();
    eventBus.emit(Events.CA_TOGGLED, { enabled: false });
    assert.equal(sys.enabled, false);
    eventBus.emit(Events.CA_TOGGLED, { enabled: true });
    assert.equal(sys.enabled, true);
  });
});

// ── Suite 25: CA — Threat Detection (TCA Prediction) ───────────────────
describe('CA — Threat Detection', () => {

  it('predicts TCA for head-on collision course', () => {
    const sys = makeSystem();
    // Debris 0.001 scene units away (+x), closing at 1 km/s toward player at origin
    const dPos = { x: 0.001, y: 0, z: 0 };
    const dVel = { x: -1.0, y: 0, z: 0 };
    const pPos = { x: 0, y: 0, z: 0 };
    const pVel = { x: 0, y: 0, z: 0 };
    const result = sys._predictClosestApproach(dPos, dVel, pPos, pVel);
    assert.ok(result !== null, 'should return prediction');
    assert.ok(result.tca > 0, `TCA should be > 0, got ${result.tca}`);
    assert.closeTo(result.minDist, 0, 0.0001, 'miss distance should be ~0 for head-on');
  });

  it('returns null for negligible relative velocity', () => {
    const sys = makeSystem();
    const dPos = { x: 0.001, y: 0, z: 0 };
    const dVel = { x: 0, y: 0, z: 0 };
    const pPos = { x: 0, y: 0, z: 0 };
    const pVel = { x: 0, y: 0, z: 0 };
    const result = sys._predictClosestApproach(dPos, dVel, pPos, pVel);
    assert.equal(result, null, 'should return null when objects co-moving');
  });

  it('TCA clamped to LOOK_AHEAD_S for distant slow debris', () => {
    const sys = makeSystem();
    // Very far debris, very slow approach → natural TCA >> LOOK_AHEAD_S
    const dPos = { x: 10.0, y: 0, z: 0 };
    const dVel = { x: -0.0001, y: 0, z: 0 };
    const pPos = { x: 0, y: 0, z: 0 };
    const pVel = { x: 0, y: 0, z: 0 };
    const result = sys._predictClosestApproach(dPos, dVel, pPos, pVel);
    assert.ok(result !== null);
    assert.ok(result.tca <= CA.LOOK_AHEAD_S,
      `TCA ${result.tca} should be clamped to ${CA.LOOK_AHEAD_S}`);
  });

  it('TCA = 0 when objects are separating', () => {
    const sys = makeSystem();
    // Debris to the right, moving further right → separating
    const dPos = { x: 0.001, y: 0, z: 0 };
    const dVel = { x: 1.0, y: 0, z: 0 };
    const pPos = { x: 0, y: 0, z: 0 };
    const pVel = { x: 0, y: 0, z: 0 };
    const result = sys._predictClosestApproach(dPos, dVel, pPos, pVel);
    assert.ok(result !== null);
    // rpDotRv > 0 → tca = negative → clamped to 0
    assert.equal(result.tca, 0, 'TCA should be 0 for separating objects');
  });

  it('threatDir is normalised', () => {
    const sys = makeSystem();
    const dPos = { x: 0.003, y: 0.004, z: 0 };
    const dVel = { x: -1, y: -1, z: 0 };
    const pPos = { x: 0, y: 0, z: 0 };
    const pVel = { x: 0, y: 0, z: 0 };
    const result = sys._predictClosestApproach(dPos, dVel, pPos, pVel);
    assert.ok(result !== null);
    const len = Math.sqrt(result.threatDir.x ** 2 + result.threatDir.y ** 2 + result.threatDir.z ** 2);
    assert.closeTo(len, 1.0, 0.001, `threatDir length should be ~1.0, got ${len}`);
  });

  it('scan timer accumulator respects SCAN_INTERVAL', () => {
    const sys = makeSystem();
    let scanCount = 0;
    sys._scanForThreats = () => { scanCount++; return null; };

    // 0.1s — below SCAN_INTERVAL (0.25)
    sys.update(0.1);
    assert.equal(scanCount, 0, 'no scan at 0.1s');

    // 0.2s cumulative
    sys.update(0.1);
    assert.equal(scanCount, 0, 'no scan at 0.2s');

    // 0.3s cumulative — exceeds 0.25s threshold
    sys.update(0.1);
    assert.equal(scanCount, 1, 'should scan after 0.3s');
  });

  it('TARGET_SELECTED sets active target exemption', () => {
    const sys = makeSystem();
    eventBus.emit(Events.TARGET_SELECTED, { id: 42 });
    assert.equal(sys._activeTargetId, 42);
  });

  it('TARGET_CLEARED removes active target exemption', () => {
    const sys = makeSystem();
    eventBus.emit(Events.TARGET_SELECTED, { id: 42 });
    eventBus.emit(Events.TARGET_CLEARED);
    assert.equal(sys._activeTargetId, null);
  });

  it('_isArmTarget() returns true for arm-targeted debris', () => {
    const sys = makeSystem({
      armManager: makeArmManager([
        { target: { id: 7 } },
        { target: null },
        { target: { id: 99 } },
      ]),
    });
    assert.equal(sys._isArmTarget(7), true);
    assert.equal(sys._isArmTarget(99), true);
    assert.equal(sys._isArmTarget(50), false);
  });

  it('_isArmTarget() returns false without arm manager', () => {
    const sys = makeSystem();
    sys._armManager = null;
    assert.equal(sys._isArmTarget(1), false);
  });

  it('update() returns early when disabled', () => {
    const sys = makeSystem();
    sys._enabled = false;
    let scanCalled = false;
    sys._scanForThreats = () => { scanCalled = true; return null; };
    sys.update(1.0);
    assert.equal(scanCalled, false, 'scan should not run when disabled');
  });

  it('update() returns early without player reference', () => {
    const sys = makeSystem();
    sys._player = null;
    let scanCalled = false;
    sys._scanForThreats = () => { scanCalled = true; return null; };
    sys.update(1.0);
    assert.equal(scanCalled, false);
  });
});

// ── Suite 26: CA — Dodge Execution ─────────────────────────────────────
describe('CA — Dodge Execution', () => {

  it('fires RCS dodge when threat within avoidance radius', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_DODGE_EXECUTED);
    const threat = makeThreat({ missDistScene: CA.AVOIDANCE_RADIUS * 0.5 });
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    assert.equal(log.length, 1, 'CA_DODGE_EXECUTED should fire');
    assert.equal(log[0].data.debrisId, 42);
  });

  it('CA_DODGE_EXECUTED includes direction and magnitude', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_DODGE_EXECUTED);
    sys._evaluateAndDodge(makeThreat(), sys._player.getPosition());
    assert.ok(log.length > 0);
    assert.isType(log[0].data.direction, 'string');
    assert.isType(log[0].data.magnitude, 'number');
    assert.ok(log[0].data.magnitude > 0, `magnitude should be > 0, got ${log[0].data.magnitude}`);
  });

  it('dodge magnitude scales with severity (closer = stronger)', () => {
    // Close threat → high severity
    const sys1 = makeSystem();
    const log1 = trackEvents(Events.CA_DODGE_EXECUTED);
    sys1._evaluateAndDodge(
      makeThreat({ missDistScene: CA.AVOIDANCE_RADIUS * 0.1 }),
      sys1._player.getPosition(),
    );

    // Far threat → low severity
    const sys2 = makeSystem();
    const log2 = trackEvents(Events.CA_DODGE_EXECUTED);
    sys2._evaluateAndDodge(
      makeThreat({ missDistScene: CA.AVOIDANCE_RADIUS * 0.9 }),
      sys2._player.getPosition(),
    );

    assert.ok(log1[0].data.magnitude > log2[0].data.magnitude,
      `close threat dv (${log1[0].data.magnitude}) should exceed far threat dv (${log2[0].data.magnitude})`);
  });

  it('respects cooldown between dodges', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_DODGE_EXECUTED);
    const threat = makeThreat();

    // First dodge
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    assert.equal(log.length, 1, 'first dodge fires');

    // Immediate retry — blocked by cooldown
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    assert.equal(log.length, 1, 'second dodge blocked by cooldown');

    // Advance past cooldown
    sys._elapsedTime += CA.COOLDOWN + 0.1;
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    assert.equal(log.length, 2, 'dodge fires after cooldown expires');
  });

  it('dodge applies impulse to player _rcsVelocity', () => {
    const sys = makeSystem();
    const player = sys._player;
    assert.equal(player._rcsVelocity.y, 0);

    // Evasion in +Y direction
    sys._evaluateAndDodge(
      makeThreat({ evasionDir: { x: 0, y: 1, z: 0 } }),
      player.getPosition(),
    );
    assert.ok(player._rcsVelocity.y > 0,
      `_rcsVelocity.y should increase, got ${player._rcsVelocity.y}`);
  });

  it('_rcsVelocity clamped to RCS_MAX_SPEED', () => {
    const sys = makeSystem();
    const player = sys._player;
    // Set existing velocity near max
    player._rcsVelocity.set(Constants.RCS_MAX_SPEED * 0.9, 0, 0);

    sys._evaluateAndDodge(
      makeThreat({ evasionDir: { x: 1, y: 0, z: 0 } }),
      player.getPosition(),
    );
    assert.ok(player._rcsVelocity.length() <= Constants.RCS_MAX_SPEED + 1e-15,
      `speed ${player._rcsVelocity.length()} should be <= RCS_MAX_SPEED ${Constants.RCS_MAX_SPEED}`);
  });

  it('evasion vector is perpendicular to threat direction (dot ≈ 0)', () => {
    const sys = makeSystem();
    const threatDir = { x: 1, y: 0, z: 0 };
    const evasion = sys._generateEvasionVector(threatDir, sys._player.getPosition());
    const dot = threatDir.x * evasion.x + threatDir.y * evasion.y + threatDir.z * evasion.z;
    assert.closeTo(dot, 0, 0.01, `dot product should be ~0, got ${dot}`);
  });

  it('evasion vector is normalised (length ≈ 1)', () => {
    const sys = makeSystem();
    const threatDir = { x: 0.577, y: 0.577, z: 0.577 };
    const evasion = sys._generateEvasionVector(threatDir, sys._player.getPosition());
    const len = Math.sqrt(evasion.x ** 2 + evasion.y ** 2 + evasion.z ** 2);
    assert.closeTo(len, 1.0, 0.01, `evasion length should be ~1.0, got ${len}`);
  });

  it('_fireRcsPuff called when available', () => {
    let puffCalled = false;
    const player = makePlayer();
    player._fireRcsPuff = () => { puffCalled = true; };
    const sys = makeSystem({ player });
    sys._evaluateAndDodge(makeThreat(), sys._player.getPosition());
    assert.equal(puffCalled, true, '_fireRcsPuff should have been called');
  });

  it('COMMS_MESSAGE emitted on dodge with warning priority (past mission gate)', () => {
    const sys = makeSystem();
    // Delegation 1 follow-up (2026-05-31): CA comms are silenced below
    // Constants.COLLISION_AVOIDANCE.COMMS_MIN_MISSION (default 3) to keep the
    // onboarding mission quiet.  Bypass that gate for this test by advancing
    // missionNumber past the threshold.
    sys._missionNumber = (Constants.COLLISION_AVOIDANCE.COMMS_MIN_MISSION ?? 3);
    const log = trackEvents(Events.COMMS_MESSAGE);
    sys._evaluateAndDodge(makeThreat(), sys._player.getPosition());
    // Two comms messages: threat warning (during detect) + dodge warning
    // But _evaluateAndDodge only emits the dodge comms message
    const dodgeMsg = log.find(e => e.data.priority === 'warning');
    assert.ok(dodgeMsg !== undefined, 'warning-priority COMMS_MESSAGE should fire');
    assert.equal(dodgeMsg.data.sender, 'CA');
  });

  it('CA comms are silenced on mission 1 (Delegation 1 follow-up)', () => {
    const sys = makeSystem();
    // missionNumber defaults to 1 — gate should suppress the dodge comms.
    const log = trackEvents(Events.COMMS_MESSAGE);
    sys._evaluateAndDodge(makeThreat(), sys._player.getPosition());
    const dodgeMsg = log.find(e =>
      e.data.priority === 'warning' && e.data.sender === 'CA');
    assert.equal(dodgeMsg, undefined,
      'mission 1 should NOT emit CA dodge comms');
  });
});

// ── Suite 27: CA — Suppression Logic ───────────────────────────────────
describe('CA — Suppression Logic', () => {

  it('WASD input within OVERRIDE_WINDOW suppresses dodge', () => {
    const sys = makeSystem({ inputManager: makeInputManager({ KeyW: true }) });
    const dodgeLog = trackEvents(Events.CA_DODGE_EXECUTED);
    const suppressLog = trackEvents(Events.CA_SUPPRESSED);

    // Mock threat scan — update will call _detectPlayerInput then scan
    sys._scanForThreats = () => makeThreat();
    sys.update(CA.SCAN_INTERVAL + 0.01);

    assert.equal(dodgeLog.length, 0, 'dodge should NOT fire during manual override');
    assert.equal(suppressLog.length, 1, 'CA_SUPPRESSED should fire');
    assert.equal(suppressLog[0].data.reason, 'manual_override');
  });

  it('arrow key input also triggers manual override', () => {
    const sys = makeSystem({ inputManager: makeInputManager({ ArrowUp: true }) });
    const suppressLog = trackEvents(Events.CA_SUPPRESSED);
    sys._scanForThreats = () => makeThreat();
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(suppressLog.length, 1);
    assert.equal(suppressLog[0].data.reason, 'manual_override');
  });

  it('ARM_PILOT mode prevents scanning entirely', () => {
    const sys = makeSystem();
    eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });

    let scanCalled = false;
    sys._scanForThreats = () => { scanCalled = true; return null; };
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(scanCalled, false, 'scan should not run in ARM_PILOT mode');
  });

  it('ARM_PILOT emits CA_SUPPRESSED via _evaluateAndDodge safety net', () => {
    const sys = makeSystem();
    eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    const log = trackEvents(Events.CA_SUPPRESSED);

    // Call _evaluateAndDodge directly (bypassing update's early return)
    sys._evaluateAndDodge(makeThreat(), sys._player.getPosition());
    assert.equal(log.length, 1);
    assert.equal(log[0].data.reason, 'arm_pilot');
  });

  it('CONTROL_MODE_CHANGE to RCS clears ARM_PILOT flag', () => {
    const sys = makeSystem();
    eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    assert.equal(sys._armPilotMode, true);
    eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: 'RCS' });
    assert.equal(sys._armPilotMode, false);
  });

  it('trawl mode uses tighter TRAWL_AVOIDANCE_RADIUS', () => {
    const sys = makeSystem();
    assert.equal(sys._getAvoidanceRadius(), CA.AVOIDANCE_RADIUS);

    eventBus.emit(Events.TRAWL_START);
    assert.equal(sys._trawlActive, true);
    assert.equal(sys._getAvoidanceRadius(), CA.TRAWL_AVOIDANCE_RADIUS);
  });

  it('TRAWL_END restores normal avoidance radius', () => {
    const sys = makeSystem();
    eventBus.emit(Events.TRAWL_START);
    eventBus.emit(Events.TRAWL_END);
    assert.equal(sys._trawlActive, false);
    assert.equal(sys._getAvoidanceRadius(), CA.AVOIDANCE_RADIUS);
  });

  it('TRAWL_SWEEP_COMPLETE also restores normal radius', () => {
    const sys = makeSystem();
    eventBus.emit(Events.TRAWL_START);
    eventBus.emit(Events.TRAWL_SWEEP_COMPLETE);
    assert.equal(sys._trawlActive, false);
  });

  it('suppression debounce: CA_SUPPRESSED emitted once per reason', () => {
    const sys = makeSystem();
    eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    const log = trackEvents(Events.CA_SUPPRESSED);
    const threat = makeThreat();

    // Three consecutive calls — only first should emit
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    sys._evaluateAndDodge(threat, sys._player.getPosition());
    assert.equal(log.length, 1, 'should emit CA_SUPPRESSED only once for same reason');
  });

  it('CA always runs (tutorial gate removed Sprint 3)', () => {
    const sys = makeSystem();
    let scanCalled = false;
    sys._scanForThreats = () => { scanCalled = true; return null; };
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(scanCalled, true, 'scan should always run — no tutorial gate');
  });
});

// ── Suite 28: CA — Threat Lifecycle ────────────────────────────────────
describe('CA — Threat Lifecycle', () => {

  it('emits CA_THREAT_DETECTED with correct payload', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_THREAT_DETECTED);
    const threat = makeThreat({ debrisId: 77, tca: 5.0, missDistM: 80 });
    sys._scanForThreats = () => threat;
    sys.update(CA.SCAN_INTERVAL + 0.01);

    assert.equal(log.length, 1, 'CA_THREAT_DETECTED should fire');
    assert.equal(log[0].data.debrisId, 77);
    assert.isType(log[0].data.tca, 'number');
    assert.isType(log[0].data.missDistance, 'number');
    assert.ok(log[0].data.evasionVector !== undefined, 'should include evasionVector');
  });

  it('emits CA_THREAT_CLEARED when threat passes', () => {
    const sys = makeSystem();
    const detectLog = trackEvents(Events.CA_THREAT_DETECTED);
    const clearLog = trackEvents(Events.CA_THREAT_CLEARED);

    // Scan 1 — detect threat
    sys._scanForThreats = () => makeThreat({ debrisId: 77 });
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(detectLog.length, 1);
    assert.ok(sys._currentThreat !== null);

    // Scan 2 — no threat
    sys._scanForThreats = () => null;
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(clearLog.length, 1, 'CA_THREAT_CLEARED should fire');
    assert.equal(clearLog[0].data.debrisId, 77);
    assert.equal(sys._currentThreat, null);
  });

  it('COMMS_MESSAGE on threat clear says "Resume heading" (past mission gate)', () => {
    const sys = makeSystem();
    // Delegation 1 follow-up (2026-05-31): advance past CA comms gate.
    sys._missionNumber = (Constants.COLLISION_AVOIDANCE.COMMS_MIN_MISSION ?? 3);
    sys._scanForThreats = () => makeThreat();
    sys.update(CA.SCAN_INTERVAL + 0.01);

    // Allow rate-limiter clock to advance past the threat-detect emit so the
    // "Resume" emit isn't rate-limited away.  Push _lastCommsEmitMs into the
    // past by the configured rate limit (+ a tick of slack).
    const limMs = (Constants.COLLISION_AVOIDANCE.COMMS_RATE_LIMIT_S ?? 0) * 1000;
    sys._lastCommsEmitMs = -Infinity - limMs - 1;

    const commsLog = trackEvents(Events.COMMS_MESSAGE);
    sys._scanForThreats = () => null;
    sys.update(CA.SCAN_INTERVAL + 0.01);

    const clearMsg = commsLog.find(e => e.data.text && e.data.text.includes('Resume'));
    assert.ok(clearMsg !== undefined, 'should emit comms "Resume heading" on clear');
  });

  it('same debris ID does NOT re-emit CA_THREAT_DETECTED', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_THREAT_DETECTED);
    sys._scanForThreats = () => makeThreat({ debrisId: 50 });

    // Scan 1 — detect
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(log.length, 1);

    // Scan 2 — same debris still threatening → no new event
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(log.length, 1, 'should not re-emit for same debrisId');
  });

  it('different debris ID DOES emit new CA_THREAT_DETECTED', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_THREAT_DETECTED);

    sys._scanForThreats = () => makeThreat({ debrisId: 10 });
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(log.length, 1);

    // New worse threat replaces old
    sys._scanForThreats = () => makeThreat({ debrisId: 20 });
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(log.length, 2, 'new debrisId should trigger new detection event');
    assert.equal(log[1].data.debrisId, 20);
  });

  it('full cycle: detect → dodge → clear', () => {
    const sys = makeSystem();
    const detected = trackEvents(Events.CA_THREAT_DETECTED);
    const dodged = trackEvents(Events.CA_DODGE_EXECUTED);
    const cleared = trackEvents(Events.CA_THREAT_CLEARED);

    // Phase 1: Detect + dodge (threat close enough)
    sys._scanForThreats = () => makeThreat({
      debrisId: 99, missDistScene: CA.AVOIDANCE_RADIUS * 0.3,
    });
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(detected.length, 1, 'threat detected');
    assert.equal(dodged.length, 1, 'dodge executed');

    // Phase 2: Threat clears
    sys._scanForThreats = () => null;
    sys.update(CA.SCAN_INTERVAL + 0.01);
    assert.equal(cleared.length, 1, 'threat cleared');
    assert.equal(cleared[0].data.debrisId, 99);
  });

  it('_clearThreat is idempotent (no event when no threat)', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CA_THREAT_CLEARED);
    assert.equal(sys._currentThreat, null);
    sys._clearThreat();
    assert.equal(log.length, 0, 'should not emit when no threat active');
  });

  it('clearThreat resets _lastSuppressedReason', () => {
    const sys = makeSystem();
    sys._currentThreat = { debrisId: 1 };
    sys._lastSuppressedReason = 'manual_override';
    sys._clearThreat();
    assert.equal(sys._lastSuppressedReason, null);
  });
});
