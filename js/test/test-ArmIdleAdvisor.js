/**
 * test-ArmIdleAdvisor.js — anti-stuck idle watchdog (Item 3, 2026-06-11).
 *
 * Verifies the data-driven advisor fires after the threshold, once per
 * deployment, respects the veteran gate, and resets on state change.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmIdleAdvisor } from '../systems/ArmIdleAdvisor.js';

const S = Constants.ARM_STATES;

function captureForce(fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(Events.TEACHING_MOMENT_FORCE, h);
  try { fn(); } finally { eventBus.off(Events.TEACHING_MOMENT_FORCE, h); }
  return got;
}

function makeArm(overrides = {}) {
  return {
    id: 'weaver-1', index: 0, state: S.STATION_KEEP,
    _firedNet: null, _netInventory: 3,
    getNetInventory() { return this._netInventory; },
    ...overrides,
  };
}

function makeAdvisor(arm, deps = {}) {
  const advisor = new ArmIdleAdvisor();
  advisor.init({
    armManager: { arms: [arm] },
    skillsSystem: deps.skillsSystem || { isVeteran: () => false },
    getPilotMode: deps.getPilotMode || (() => 'RCS'),
    getActiveNetForArm: deps.getActiveNetForArm || (() => null),
  });
  return advisor;
}

describe('ArmIdleAdvisor — SK idle fire-or-pilot hint', () => {
  it('fires after the idle threshold (20 s), not before', () => {
    eventBus.clear();
    const arm = makeArm();
    const advisor = makeAdvisor(arm);

    const got = captureForce(() => {
      for (let i = 0; i < 19; i++) advisor.update(1.0);   // 19 s
    });
    assert.equal(got.length, 0, 'no hint before 20 s idle');

    const got2 = captureForce(() => { advisor.update(1.0); });  // 20 s
    assert.equal(got2.length, 1, 'hint fires at the threshold');
    assert.equal(got2[0].id, 'sk_idle_fire_or_pilot', 'correct hint id');
    assert.equal(got2[0]._postOnboarding, true, 'tagged _postOnboarding');
  });

  it('fires only ONCE per deployment (no repeat while idle continues)', () => {
    eventBus.clear();
    const arm = makeArm();
    const advisor = makeAdvisor(arm);
    const got = captureForce(() => {
      for (let i = 0; i < 40; i++) advisor.update(1.0);   // 40 s idle
    });
    const fires = got.filter((g) => g.id === 'sk_idle_fire_or_pilot');
    assert.equal(fires.length, 1, 'exactly one hint despite continued idle');
  });

  it('resets on state change and can re-arm next deployment', () => {
    eventBus.clear();
    const arm = makeArm();
    const advisor = makeAdvisor(arm);
    captureForce(() => { for (let i = 0; i < 21; i++) advisor.update(1.0); });

    // Daughter fires + redocks + redeploys → back to STATION_KEEP (new deploy).
    const got = captureForce(() => {
      arm.state = S.NETTING; advisor.update(1.0);
      arm.state = S.STATION_KEEP;
      for (let i = 0; i < 21; i++) advisor.update(1.0);
    });
    const fires = got.filter((g) => g.id === 'sk_idle_fire_or_pilot');
    assert.equal(fires.length, 1, 're-arms after a state change (once per new deployment)');
  });

  it('does NOT fire if a net is in flight', () => {
    eventBus.clear();
    const arm = makeArm({ _firedNet: { state: 'FLIGHT' } });
    const advisor = makeAdvisor(arm);
    const got = captureForce(() => { for (let i = 0; i < 25; i++) advisor.update(1.0); });
    assert.equal(got.filter((g) => g.id === 'sk_idle_fire_or_pilot').length, 0,
      'no fire-the-net nudge while a net is already in flight');
  });
});

describe('ArmIdleAdvisor — out-of-nets hint', () => {
  it('fires the restock hint when the magazine is empty', () => {
    eventBus.clear();
    const arm = makeArm({ _netInventory: 0 });
    const advisor = makeAdvisor(arm);
    const got = captureForce(() => { for (let i = 0; i < 7; i++) advisor.update(1.0); });
    const fires = got.filter((g) => g.id === 'sk_out_of_nets');
    assert.equal(fires.length, 1, 'out-of-nets hint fires');
    assert.ok(/reel/i.test(fires[0].body), 'tells the player to reel her in');
  });
});

describe('ArmIdleAdvisor — veteran gate', () => {
  it('never fires for a veteran player', () => {
    eventBus.clear();
    const arm = makeArm();
    const advisor = makeAdvisor(arm, { skillsSystem: { isVeteran: () => true } });
    const got = captureForce(() => { for (let i = 0; i < 60; i++) advisor.update(1.0); });
    assert.equal(got.length, 0, 'veterans are skipped entirely');
  });
});

describe('ArmIdleAdvisor — ARM_PILOT return hint', () => {
  it('fires the return-to-mothership hint after the pilot-idle threshold', () => {
    eventBus.clear();
    const arm = makeArm({ state: S.STATION_KEEP });
    const cfg = Constants.ARM_PILOT_IDLE;
    const advisor = makeAdvisor(arm, { getPilotMode: () => 'ARM_PILOT' });
    const got = captureForce(() => {
      for (let i = 0; i < cfg.idleS + 1; i++) advisor.update(1.0);
    });
    const fires = got.filter((g) => g.id === cfg.hintId);
    assert.equal(fires.length, 1, 'pilot-return hint fires once');
    assert.ok(/1-4|Esc|V/.test(fires[0].body), 'mentions the return-to-mother controls');
  });

  it('does not fire the pilot hint when not in ARM_PILOT mode', () => {
    eventBus.clear();
    const arm = makeArm();
    const cfg = Constants.ARM_PILOT_IDLE;
    const advisor = makeAdvisor(arm, { getPilotMode: () => 'RCS' });
    const got = captureForce(() => {
      for (let i = 0; i < cfg.idleS + 5; i++) advisor.update(1.0);
    });
    assert.equal(got.filter((g) => g.id === cfg.hintId).length, 0, 'no pilot hint outside ARM_PILOT');
  });
});
