/**
 * test-LaunchSequence.js — ST-9.11 C-5 Launch Sequence tests
 *
 * Covers: 9-phase state machine, tick-driven transitions, launch-lock release
 *         with per-arm stagger, ROSA power ramp, skipToReady, persistence
 *         resume rules, feature-flag gating, arm-input blocking, event emissions.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import { launchSequence, LAUNCH_PHASES } from '../systems/LaunchSequence.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const DS = Constants.DEPLOY_STATES;

/** Save & restore feature flags. */
let _savedFlags = {};
function saveFlagsAndEnable() {
  _savedFlags.LAUNCH = Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE;
  _savedFlags.STOW   = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE;
  Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = true;
  Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = true;
}
function restoreFlags() {
  Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = _savedFlags.LAUNCH;
  Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = _savedFlags.STOW;
}

/** Create a mock arm that mimics ArmUnit's deploy-state API. */
function mockArm(index, initialState) {
  return {
    index,
    _deployState: initialState || DS.LOCKED,
    strutUnlock() {
      if (this._deployState === DS.LOCKED) {
        this._deployState = DS.STOWED;
      }
    },
    strutDeploy(alpha) {
      if (this._deployState === DS.STOWED) {
        this._deployState = DS.DEPLOYING;
        // Simulate immediate complete for test
        this._deployState = DS.DEPLOYED;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Cannot deploy from ${this._deployState}`));
    },
    strutStow() {
      if (this._deployState === DS.DEPLOYED) {
        this._deployState = DS.STOWED;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Cannot stow from ${this._deployState}`));
    },
  };
}

/** Create a mock ArmManager. */
function mockArmManager(armCount = 4) {
  const arms = [];
  for (let i = 0; i < armCount; i++) {
    arms.push(mockArm(i));
  }
  return {
    arms,
    _launchLock: false,
    setLaunchLock(v) { this._launchLock = !!v; },
    isLaunchLocked() { return this._launchLock; },
    fireDualPair(pairIndex) {
      if (this._launchLock) return { success: false, reason: 'launch_sequence_active' };
      return { success: true };
    },
    strutDeployArm(armIndex) {
      if (this._launchLock) return Promise.reject(new Error('Launch sequence active'));
      return this.arms[armIndex].strutDeploy();
    },
    strutStowArm(armIndex) {
      if (this._launchLock) return Promise.reject(new Error('Launch sequence active'));
      return this.arms[armIndex].strutStow();
    },
  };
}

/** Create a mock PersistenceManager. */
function mockPersistence() {
  let _phase = 'READY';
  return {
    setLaunchPhase(p) { _phase = p; return true; },
    getLaunchPhase() { return _phase; },
    _getStored() { return _phase; },
  };
}

/** Tick the launch sequence N times at given dt. */
function tickN(n, dt = 1 / 60) {
  for (let i = 0; i < n; i++) {
    launchSequence.tick(dt);
  }
}

/** Tick until a specific phase is reached (with safety cap). */
function tickToPhase(targetPhase, dt = 1.0, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    if (launchSequence.getCurrentPhase() === targetPhase) return true;
    launchSequence.tick(dt);
  }
  return launchSequence.getCurrentPhase() === targetPhase;
}

/** Clean state before each suite. */
function freshStart(armCount = 4) {
  eventBus.clear();
  launchSequence.reset();
  powerDistribution.reset();
  saveFlagsAndEnable();
  const am = mockArmManager(armCount);
  const pm = mockPersistence();
  return { am, pm };
}

function cleanup() {
  restoreFlags();
  eventBus.clear();
  launchSequence.reset();
  powerDistribution.reset();
}

// ══════════════════════════════════════════════════════════════════════════
// Suite: LAUNCH_PHASES constant
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: LAUNCH_PHASES constant', () => {
  it('has 9 phases in canonical order', () => {
    assert.equal(LAUNCH_PHASES.length, 9);
    assert.equal(LAUNCH_PHASES[0], 'STOWED_IN_FAIRING');
    assert.equal(LAUNCH_PHASES[LAUNCH_PHASES.length - 1], 'READY');
  });

  it('is frozen (immutable)', () => {
    assert.equal(Object.isFrozen(LAUNCH_PHASES), true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Events constant registration
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Launch sequence events exist in Events.js', () => {
  it('LAUNCH_PHASE_CHANGED is defined', () => {
    assert.equal(typeof Events.LAUNCH_PHASE_CHANGED, 'string');
  });
  it('LAUNCH_LOCK_RELEASED is defined', () => {
    assert.equal(typeof Events.LAUNCH_LOCK_RELEASED, 'string');
  });
  it('ROSA_DEPLOY_STARTED is defined', () => {
    assert.equal(typeof Events.ROSA_DEPLOY_STARTED, 'string');
  });
  it('ROSA_DEPLOY_COMPLETED is defined', () => {
    assert.equal(typeof Events.ROSA_DEPLOY_COMPLETED, 'string');
  });
  it('LAUNCH_SEQUENCE_COMPLETE is defined', () => {
    assert.equal(typeof Events.LAUNCH_SEQUENCE_COMPLETE, 'string');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Constants additions
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Constants — ROSA + Launch timing', () => {
  it('ROSA_DEPLOY_DURATION_S is 6.0', () => {
    assert.equal(Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S, 6.0);
  });
  it('FAIRING_SEP_DELAY_S defaults to 4.0', () => {
    assert.equal(Constants.FAIRING_SEP_DELAY_S, 4.0);
  });
  it('ORBIT_INSERTION_DELAY_S defaults to 4.0', () => {
    assert.equal(Constants.ORBIT_INSERTION_DELAY_S, 4.0);
  });
  it('LAUNCH_LOCK_STAGGER_S defaults to 0.1', () => {
    assert.equal(Constants.LAUNCH_LOCK_STAGGER_S, 0.1);
  });
  it('LAUNCH_PYRO_DELAY is 40', () => {
    assert.equal(Constants.LAUNCH_PYRO_DELAY, 40);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Feature flag gating
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Feature flag gating — LAUNCH_SEQUENCE', () => {
  it('start() is no-op when flag is false', () => {
    eventBus.clear();
    launchSequence.reset();
    Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = false;
    const am = mockArmManager();
    launchSequence.start(am, null);
    assert.equal(launchSequence.getCurrentPhase(), null);
    assert.equal(launchSequence.isActive(), false);
    restoreFlags();
  });

  it('skipToReady() is no-op when flag is false', () => {
    eventBus.clear();
    launchSequence.reset();
    Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = false;
    launchSequence.skipToReady();
    assert.equal(launchSequence.getCurrentPhase(), null);
    restoreFlags();
  });

  it('tick() is no-op when not started', () => {
    eventBus.clear();
    launchSequence.reset();
    launchSequence.tick(1.0);
    assert.equal(launchSequence.getCurrentPhase(), null);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Phase progression (time-driven)
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Phase progression — time-driven via tick(dt)', () => {
  it('start() enters STOWED_IN_FAIRING', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    assert.equal(launchSequence.getCurrentPhase(), 'STOWED_IN_FAIRING');
    cleanup();
  });

  it('first tick advances STOWED_IN_FAIRING → LIFTOFF (immediate)', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.tick(0.016);
    assert.equal(launchSequence.getCurrentPhase(), 'LIFTOFF');
    cleanup();
  });

  it('LIFTOFF → FAIRING_SEPARATION after FAIRING_SEP_DELAY_S', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('LIFTOFF');
    // Tick just under the delay — should still be LIFTOFF
    launchSequence.tick(Constants.FAIRING_SEP_DELAY_S - 0.1);
    assert.equal(launchSequence.getCurrentPhase(), 'LIFTOFF');
    // Pass the threshold
    launchSequence.tick(0.2);
    assert.equal(launchSequence.getCurrentPhase(), 'FAIRING_SEPARATION');
    cleanup();
  });

  it('FAIRING_SEPARATION → ORBIT_INSERTION after ORBIT_INSERTION_DELAY_S', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('FAIRING_SEPARATION');
    launchSequence.tick(Constants.ORBIT_INSERTION_DELAY_S + 0.1);
    assert.equal(launchSequence.getCurrentPhase(), 'ORBIT_INSERTION');
    cleanup();
  });

  it('ORBIT_INSERTION → LAUNCH_LOCK_RELEASE after LAUNCH_PYRO_DELAY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('ORBIT_INSERTION');
    // Tick most of the 40s
    tickN(39, 1.0);
    assert.equal(launchSequence.getCurrentPhase(), 'ORBIT_INSERTION');
    launchSequence.tick(2.0);
    assert.equal(launchSequence.getCurrentPhase(), 'LAUNCH_LOCK_RELEASE');
    cleanup();
  });

  it('all transitions emit LAUNCH_PHASE_CHANGED with correct payload', () => {
    const { am, pm } = freshStart();
    const events = [];
    eventBus.on(Events.LAUNCH_PHASE_CHANGED, (d) => events.push(d));
    launchSequence.start(am, pm);
    // First event is initial: null → STOWED_IN_FAIRING
    assert.equal(events.length, 1);
    assert.equal(events[0].fromPhase, null);
    assert.equal(events[0].toPhase, 'STOWED_IN_FAIRING');
    // Tick to advance through phases
    launchSequence.tick(0.016); // → LIFTOFF
    assert.equal(events.length, 2);
    assert.equal(events[1].fromPhase, 'STOWED_IN_FAIRING');
    assert.equal(events[1].toPhase, 'LIFTOFF');
    assert.equal(typeof events[1].elapsedTotalS, 'number');
    cleanup();
  });

  it('LAUNCH_PHASE_CHANGED includes phaseDurationS and nextPhase for countdown', () => {
    const { am, pm } = freshStart();
    const events = [];
    eventBus.on(Events.LAUNCH_PHASE_CHANGED, (d) => events.push(d));
    launchSequence.start(am, pm);
    launchSequence.tick(0.016); // → LIFTOFF
    const liftoffEvt = events.find(e => e.toPhase === 'LIFTOFF');
    assert.notEqual(liftoffEvt, undefined, 'LIFTOFF event should exist');
    assert.equal(liftoffEvt.phaseDurationS, Constants.FAIRING_SEP_DELAY_S,
      'LIFTOFF duration should be FAIRING_SEP_DELAY_S');
    assert.equal(liftoffEvt.nextPhase, 'FAIRING_SEPARATION',
      'LIFTOFF nextPhase should be FAIRING_SEPARATION');
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Launch lock release — per-arm stagger
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Launch lock release — per-arm strut unlock stagger', () => {
  it('arms start as LOCKED', () => {
    const { am } = freshStart();
    for (const arm of am.arms) {
      assert.equal(arm._deployState, DS.LOCKED);
    }
    cleanup();
  });

  it('LAUNCH_LOCK_RELEASE phase unlocks all arms to STOWED', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    const reached = tickToPhase('LAUNCH_LOCK_RELEASE');
    assert.equal(reached, true);
    // Tick enough for all arms to be unlocked (4 arms × 0.1s = 0.4s)
    launchSequence.tick(0.5);
    for (const arm of am.arms) {
      assert.equal(arm._deployState, DS.STOWED,
        `Arm ${arm.index} should be STOWED after lock release`);
    }
    cleanup();
  });

  it('stagger: arms unlock at progressive intervals', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('LAUNCH_LOCK_RELEASE');
    // After 0.05s — only arm 0 should be unlocked (stagger=0.1, arm 0 at 0s)
    launchSequence.tick(0.05);
    assert.equal(am.arms[0]._deployState, DS.STOWED, 'arm 0 unlocked at 0s');
    assert.equal(am.arms[1]._deployState, DS.LOCKED, 'arm 1 still locked at 0.05s');
    // After 0.15s total — arms 0 and 1 unlocked
    launchSequence.tick(0.1);
    assert.equal(am.arms[1]._deployState, DS.STOWED, 'arm 1 unlocked at 0.1s');
    assert.equal(am.arms[2]._deployState, DS.LOCKED, 'arm 2 still locked at 0.15s');
    cleanup();
  });

  it('emits LAUNCH_LOCK_RELEASED per arm', () => {
    const { am, pm } = freshStart();
    const lockEvents = [];
    eventBus.on(Events.LAUNCH_LOCK_RELEASED, (d) => lockEvents.push(d));
    launchSequence.start(am, pm);
    tickToPhase('LAUNCH_LOCK_RELEASE');
    launchSequence.tick(0.5); // Enough time for all 4 arms
    assert.equal(lockEvents.length, 4);
    assert.equal(lockEvents[0].armIndex, 0);
    assert.equal(lockEvents[1].armIndex, 1);
    assert.equal(lockEvents[2].armIndex, 2);
    assert.equal(lockEvents[3].armIndex, 3);
    cleanup();
  });

  it('advances to ROSA_DEPLOY_PRIMARY after all arms STOWED', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('LAUNCH_LOCK_RELEASE');
    launchSequence.tick(0.5);
    assert.equal(launchSequence.getCurrentPhase(), 'ROSA_DEPLOY_PRIMARY');
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ROSA deployment — power ramp
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: ROSA deployment — linear power ramp', () => {
  it('emits ROSA_DEPLOY_STARTED for wing 1 on entering ROSA_DEPLOY_PRIMARY', () => {
    const { am, pm } = freshStart();
    let rosaStarted = null;
    eventBus.on(Events.ROSA_DEPLOY_STARTED, (d) => { rosaStarted = d; });
    launchSequence.start(am, pm);
    tickToPhase('ROSA_DEPLOY_PRIMARY');
    assert.notEqual(rosaStarted, null, 'ROSA_DEPLOY_STARTED should fire');
    assert.equal(rosaStarted.wing, 1);
    cleanup();
  });

  it('wing 1 power ramps linearly during ROSA_DEPLOY_PRIMARY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('ROSA_DEPLOY_PRIMARY');
    const duration = Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S;
    const totalPower = Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER;
    const perWing = totalPower / 2;
    // At 50% through wing 1
    launchSequence.tick(duration / 2);
    const rosa = launchSequence.getRosaProgress();
    assert.closeTo(rosa.wing1, 0.5, 0.02);
    assert.closeTo(rosa.totalPowerW, perWing * 0.5, 20);
    cleanup();
  });

  it('wing 1 completes at ROSA_DEPLOY_DURATION_S, emits ROSA_DEPLOY_COMPLETED', () => {
    const { am, pm } = freshStart();
    let completed = null;
    eventBus.on(Events.ROSA_DEPLOY_COMPLETED, (d) => { completed = d; });
    launchSequence.start(am, pm);
    tickToPhase('ROSA_DEPLOY_PRIMARY');
    launchSequence.tick(Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S + 0.1);
    assert.notEqual(completed, null, 'ROSA_DEPLOY_COMPLETED should fire');
    assert.equal(completed.wing, 1);
    const perWing = Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER / 2;
    assert.equal(completed.powerW, perWing);
    cleanup();
  });

  it('wing 2 follows wing 1 — total power reaches TOTAL_SOLAR_POWER', () => {
    const { am, pm } = freshStart();
    const completedEvents = [];
    eventBus.on(Events.ROSA_DEPLOY_COMPLETED, (d) => completedEvents.push(d));
    launchSequence.start(am, pm);
    tickToPhase('ROSA_DEPLOY_PRIMARY');
    launchSequence.tick(Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S + 0.1);
    // Should now be in ROSA_DEPLOY_SECONDARY
    assert.equal(launchSequence.getCurrentPhase(), 'ROSA_DEPLOY_SECONDARY');
    launchSequence.tick(Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S + 0.1);
    // Both wings done
    assert.equal(completedEvents.length, 2);
    assert.equal(completedEvents[1].wing, 2);
    assert.equal(completedEvents[1].powerW, Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER);
    const rosa = launchSequence.getRosaProgress();
    assert.equal(rosa.wing1, 1);
    assert.equal(rosa.wing2, 1);
    assert.equal(rosa.totalPowerW, Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER);
    cleanup();
  });

  it('setSolarInput is called on PowerDistribution during ramp', () => {
    const { am, pm } = freshStart();
    powerDistribution.reset();
    launchSequence.start(am, pm);
    tickToPhase('ROSA_DEPLOY_PRIMARY');
    launchSequence.tick(3.0); // Halfway through wing 1
    const solar = powerDistribution.getSolarInput();
    assert.equal(solar > 0, true, `Solar input should be > 0, got ${solar}`);
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Full sequence → READY
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Full sequence reaches READY', () => {
  it('sequence completes to READY after all phases', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    // Drive through all phases with large dt
    const reached = tickToPhase('READY', 1.0, 300);
    assert.equal(reached, true, 'Should reach READY phase');
    assert.equal(launchSequence.isReady(), true);
    assert.equal(launchSequence.isActive(), false);
    cleanup();
  });

  it('emits LAUNCH_SEQUENCE_COMPLETE on entering READY', () => {
    const { am, pm } = freshStart();
    let completeFired = false;
    eventBus.on(Events.LAUNCH_SEQUENCE_COMPLETE, () => { completeFired = true; });
    launchSequence.start(am, pm);
    tickToPhase('READY', 1.0, 300);
    assert.equal(completeFired, true, 'LAUNCH_SEQUENCE_COMPLETE should fire');
    cleanup();
  });

  it('READY persists via persistenceManager.setLaunchPhase', () => {
    const { am, pm } = freshStart();
    pm.setLaunchPhase('STOWED_IN_FAIRING'); // Pre-set non-READY
    launchSequence.start(am, pm);
    tickToPhase('READY', 1.0, 300);
    assert.equal(pm._getStored(), 'READY');
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: skipToReady()
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: skipToReady() debug bypass', () => {
  it('jumps directly to READY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.tick(0.016); // Advance past STOWED_IN_FAIRING
    launchSequence.skipToReady();
    assert.equal(launchSequence.getCurrentPhase(), 'READY');
    assert.equal(launchSequence.isReady(), true);
    cleanup();
  });

  it('unlocks all arms to STOWED', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.skipToReady();
    for (const arm of am.arms) {
      assert.equal(arm._deployState, DS.STOWED,
        `Arm ${arm.index} should be STOWED after skipToReady`);
    }
    cleanup();
  });

  it('sets ROSA to 100% and solar power to TOTAL_SOLAR_POWER', () => {
    const { am, pm } = freshStart();
    powerDistribution.reset();
    launchSequence.start(am, pm);
    launchSequence.skipToReady();
    const rosa = launchSequence.getRosaProgress();
    assert.equal(rosa.wing1, 1);
    assert.equal(rosa.wing2, 1);
    assert.equal(rosa.totalPowerW, Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER);
    assert.equal(powerDistribution.getSolarInput(), Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER);
    cleanup();
  });

  it('emits LAUNCH_PHASE_CHANGED + LAUNCH_SEQUENCE_COMPLETE', () => {
    const { am, pm } = freshStart();
    const phaseEvents = [];
    let completeCount = 0;
    eventBus.on(Events.LAUNCH_PHASE_CHANGED, (d) => phaseEvents.push(d));
    eventBus.on(Events.LAUNCH_SEQUENCE_COMPLETE, () => completeCount++);
    launchSequence.start(am, pm);
    launchSequence.skipToReady();
    // Find the READY phase event
    const readyEvent = phaseEvents.find(e => e.toPhase === 'READY');
    assert.notEqual(readyEvent, undefined, 'Should emit phase change to READY');
    assert.equal(completeCount, 1);
    cleanup();
  });

  it('clears launch lock on armManager', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    assert.equal(am._launchLock, true, 'Lock should be set after start');
    launchSequence.skipToReady();
    assert.equal(am._launchLock, false, 'Lock should be cleared after skipToReady');
    cleanup();
  });

  it('persists READY phase', () => {
    const { am, pm } = freshStart();
    pm.setLaunchPhase('LIFTOFF');
    launchSequence.start(am, pm);
    launchSequence.skipToReady();
    assert.equal(pm._getStored(), 'READY');
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Arm input blocking during sequence
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Arm input blocked during launch sequence', () => {
  it('armManager.setLaunchLock(true) called on start', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    assert.equal(am.isLaunchLocked(), true);
    cleanup();
  });

  it('fireDualPair returns failure during sequence', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    const result = am.fireDualPair(0);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'launch_sequence_active');
    cleanup();
  });

  it('strutDeployArm rejects during sequence', async () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    let rejected = false;
    try {
      await am.strutDeployArm(0);
    } catch (e) {
      rejected = true;
    }
    assert.equal(rejected, true, 'strutDeployArm should reject during launch');
    cleanup();
  });

  it('launch lock cleared when sequence reaches READY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    assert.equal(am.isLaunchLocked(), true);
    tickToPhase('READY', 1.0, 300);
    assert.equal(am.isLaunchLocked(), false);
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Persistence — resume rules
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Persistence — mid-sequence resume rules', () => {
  it('default getLaunchPhase returns READY for missing saves', () => {
    const pm = mockPersistence();
    assert.equal(pm.getLaunchPhase(), 'READY');
  });

  it('early phases (≤ LAUNCH_LOCK_RELEASE) restart from fresh', () => {
    const earlyPhases = ['STOWED_IN_FAIRING', 'LIFTOFF', 'FAIRING_SEPARATION',
                         'ORBIT_INSERTION', 'LAUNCH_LOCK_RELEASE'];
    for (const phase of earlyPhases) {
      const idx = LAUNCH_PHASES.indexOf(phase);
      assert.equal(idx >= 0, true, `${phase} should be in LAUNCH_PHASES`);
      assert.equal(idx <= LAUNCH_PHASES.indexOf('LAUNCH_LOCK_RELEASE'), true,
        `${phase} should be ≤ LAUNCH_LOCK_RELEASE`);
    }
  });

  it('late phases (≥ ROSA_DEPLOY_PRIMARY) should snap to READY', () => {
    const latePhases = ['ROSA_DEPLOY_PRIMARY', 'ROSA_DEPLOY_SECONDARY', 'POWER_NOMINAL'];
    for (const phase of latePhases) {
      const idx = LAUNCH_PHASES.indexOf(phase);
      assert.equal(idx >= LAUNCH_PHASES.indexOf('ROSA_DEPLOY_PRIMARY'), true,
        `${phase} should be ≥ ROSA_DEPLOY_PRIMARY`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: PowerDistribution.setSolarInput
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: PowerDistribution — setSolarInput / getSolarInput', () => {
  it('default solar input is 0', () => {
    powerDistribution.reset();
    assert.equal(powerDistribution.getSolarInput(), 0);
  });

  it('setSolarInput sets the value', () => {
    powerDistribution.reset();
    powerDistribution.setSolarInput(1120);
    assert.equal(powerDistribution.getSolarInput(), 1120);
    powerDistribution.reset();
  });

  it('reset() clears solar input to 0', () => {
    powerDistribution.setSolarInput(2240);
    powerDistribution.reset();
    assert.equal(powerDistribution.getSolarInput(), 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: API methods
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: LaunchSequence API', () => {
  it('getCurrentPhase() returns null before start', () => {
    launchSequence.reset();
    assert.equal(launchSequence.getCurrentPhase(), null);
  });

  it('getElapsedSecondsInPhase() tracks phase time', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    tickToPhase('LIFTOFF');
    launchSequence.tick(2.5);
    assert.closeTo(launchSequence.getElapsedSecondsInPhase(), 2.5, 0.05);
    cleanup();
  });

  it('getRosaProgress() returns zeros before ROSA phase', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    const rosa = launchSequence.getRosaProgress();
    assert.equal(rosa.wing1, 0);
    assert.equal(rosa.wing2, 0);
    assert.equal(rosa.totalPowerW, 0);
    cleanup();
  });

  it('isReady() returns false during sequence, true at READY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    assert.equal(launchSequence.isReady(), false);
    launchSequence.skipToReady();
    assert.equal(launchSequence.isReady(), true);
    cleanup();
  });

  it('isActive() returns true during sequence, false after', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.tick(0.016);
    assert.equal(launchSequence.isActive(), true);
    launchSequence.skipToReady();
    assert.equal(launchSequence.isActive(), false);
    cleanup();
  });

  it('reset() clears all state', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.tick(1.0);
    launchSequence.reset();
    assert.equal(launchSequence.getCurrentPhase(), null);
    assert.equal(launchSequence.isActive(), false);
    assert.equal(launchSequence.isReady(), false);
    assert.equal(launchSequence.getElapsedSecondsInPhase(), 0);
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Zero arms edge case
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Edge case — zero arms', () => {
  it('LAUNCH_LOCK_RELEASE advances past with no arms (one tick)', () => {
    const { am, pm } = freshStart(0);
    am.arms = []; // Empty arms
    launchSequence.start(am, pm);
    const reached = tickToPhase('LAUNCH_LOCK_RELEASE');
    assert.equal(reached, true, 'Should reach LAUNCH_LOCK_RELEASE');
    // One more tick: empty-arms is vacuously all-STOWED → advances to ROSA
    launchSequence.tick(0.016);
    assert.equal(launchSequence.getCurrentPhase(), 'ROSA_DEPLOY_PRIMARY');
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Multiple tick() after READY is safe
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: tick() after READY is a no-op', () => {
  it('no errors or state changes after reaching READY', () => {
    const { am, pm } = freshStart();
    launchSequence.start(am, pm);
    launchSequence.skipToReady();
    const phaseBefore = launchSequence.getCurrentPhase();
    launchSequence.tick(10.0);
    launchSequence.tick(100.0);
    assert.equal(launchSequence.getCurrentPhase(), phaseBefore);
    assert.equal(launchSequence.isReady(), true);
    cleanup();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Hex/Octo arm counts
// ══════════════════════════════════════════════════════════════════════════
describe('C-5: Multi-arm count — Hex (6 arms)', () => {
  it('all 6 arms unlock during LAUNCH_LOCK_RELEASE', () => {
    const { am, pm } = freshStart(6);
    launchSequence.start(am, pm);
    tickToPhase('LAUNCH_LOCK_RELEASE');
    // 6 arms × 0.1 stagger = 0.6s needed
    launchSequence.tick(0.7);
    for (const arm of am.arms) {
      assert.equal(arm._deployState, DS.STOWED,
        `Arm ${arm.index} should be STOWED`);
    }
    cleanup();
  });

  it('emits 6 LAUNCH_LOCK_RELEASED events', () => {
    const { am, pm } = freshStart(6);
    const events = [];
    eventBus.on(Events.LAUNCH_LOCK_RELEASED, (d) => events.push(d));
    launchSequence.start(am, pm);
    tickToPhase('LAUNCH_LOCK_RELEASE');
    launchSequence.tick(0.7);
    assert.equal(events.length, 6);
    cleanup();
  });
});
