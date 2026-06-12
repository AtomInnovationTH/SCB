/**
 * test-NavRecoveryAdvisor.js — UX-11 #11 lost-in-space recovery guidance.
 *
 * Covers:
 *   1. Pure helpers: classifyBearing (along-track/radial labels + km conversion),
 *      formatDistanceKm, findNearestLiveDebris (alive + mass filters, nearest pick).
 *   2. Watchdog trigger: no target + nothing in reach for LOST_DWELL_S → exactly
 *      one throttled hint; cooldown respected; veteran-gated.
 *   3. Empty-scan routing: SCAN_COMPLETE { rewardKind:'empty' } → bearing guidance;
 *      non-empty kinds are ignored.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  NavRecoveryAdvisor,
  findNearestLiveDebris,
  classifyBearing,
  formatDistanceKm,
} from '../systems/NavRecoveryAdvisor.js';

const LEO_SMA = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;

function makeOrbit(trueAnomaly = 0, smaOffset = 0) {
  return {
    semiMajorAxis: LEO_SMA + smaOffset,
    eccentricity: 0.001,
    inclination: 51.6 * Math.PI / 180,
    raan: 0, argPerigee: 0, trueAnomaly, meanMotion: 0,
  };
}

function makePlayer(pos = { x: LEO_SMA, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 7.5 }) {
  return {
    getPosition: () => ({ ...pos }),
    getVelocity: () => ({ ...vel }),
  };
}

function makeAdvisor({ debrisList = [], target = null, veteran = false, player = makePlayer() } = {}) {
  eventBus.clear();
  const adv = new NavRecoveryAdvisor();
  adv.init({
    player,
    debrisField: { debrisList },
    targetSelector: { getActiveTarget: () => target },
    skillsSystem: { isVeteran: () => veteran },
  });
  return adv;
}

function trackComms() {
  const log = [];
  eventBus.on(Events.COMMS_MESSAGE, (d) => log.push(d));
  return log;
}

// ============================================================================
// PURE HELPERS
// ============================================================================

describe('NavRecoveryAdvisor — pure bearing/nearest helpers', () => {

  it('classifyBearing labels a target ahead along velocity as prograde', () => {
    const b = classifyBearing(
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 0, z: 7.5 },
      { x: 100, y: 0, z: 0.5 },   // 0.5 scene units ahead (+Z)
    );
    assert.equal(b.label, 'prograde');
    assert.ok(Math.abs(b.distKm - 50) < 0.001, `0.5 scene = 50 km, got ${b.distKm}`);
  });

  it('classifyBearing labels a target behind as retrograde', () => {
    const b = classifyBearing(
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 0, z: 7.5 },
      { x: 100, y: 0, z: -1 },
    );
    assert.equal(b.label, 'retrograde');
  });

  it('classifyBearing labels a radially-outward target as abeam-high', () => {
    const b = classifyBearing(
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 0, z: 7.5 },
      { x: 101, y: 0, z: 0 },     // straight up the radial
    );
    assert.equal(b.label, 'abeam-high');
  });

  it('classifyBearing labels a radially-inward target as abeam-low', () => {
    const b = classifyBearing(
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 0, z: 7.5 },
      { x: 99, y: 0, z: 0 },
    );
    assert.equal(b.label, 'abeam-low');
  });

  it('formatDistanceKm picks sensible units', () => {
    assert.equal(formatDistanceKm(0.5), '500 m');
    assert.equal(formatDistanceKm(4.23), '4.2 km');
    assert.equal(formatDistanceKm(38.6), '39 km');
    assert.equal(formatDistanceKm(312), '312 km');
  });

  it('findNearestLiveDebris picks the nearest alive entry and respects filters', () => {
    const player = { x: LEO_SMA, y: 0, z: 0 };
    const near = { id: 1, alive: true, mass: 10, orbit: makeOrbit(0.01) };
    const far = { id: 2, alive: true, mass: 500, orbit: makeOrbit(1.0) };
    const dead = { id: 3, alive: false, mass: 500, orbit: makeOrbit(0.001) };

    const any = findNearestLiveDebris(player, [far, dead, near]);
    assert.equal(any.debris.id, 1, 'nearest alive must win; dead skipped');

    const large = findNearestLiveDebris(player, [far, dead, near], 50);
    assert.equal(large.debris.id, 2, 'mass filter must exclude the small one');

    assert.equal(findNearestLiveDebris(player, [dead]), null, 'no live debris → null');
  });
});

// ============================================================================
// WATCHDOG
// ============================================================================

describe('NavRecoveryAdvisor — out-of-range watchdog', () => {

  it('fires exactly one hint after dwell, then respects cooldown', () => {
    // Single live debris on the far side of the orbit (way out of reach)
    const farDebris = { id: 9, alive: true, mass: 100, orbit: makeOrbit(Math.PI) };
    const adv = makeAdvisor({ debrisList: [farDebris] });
    const comms = trackComms();

    for (let i = 0; i < 25; i++) adv.update(1.0);   // > LOST_DWELL_S
    assert.equal(comms.length, 1, 'exactly one hint after dwell');
    assert.ok(comms[0].text.includes('Nearest contact'), `hint text: ${comms[0].text}`);
    assert.ok(comms[0].text.includes('press A'), 'must include the one-tap affordance');
    assert.equal(comms[0]._postOnboarding, true, 'must carry the suppression-arbiter tag');

    for (let i = 0; i < 60; i++) adv.update(1.0);   // still inside 120 s cooldown
    assert.equal(comms.length, 1, 'cooldown must prevent a second hint');
  });

  it('does not fire when a target is selected or debris is in reach', () => {
    const nearDebris = { id: 5, alive: true, mass: 100, orbit: makeOrbit(0.001) };
    const advNear = makeAdvisor({ debrisList: [nearDebris] });
    const commsNear = trackComms();
    for (let i = 0; i < 30; i++) advNear.update(1.0);
    assert.equal(commsNear.length, 0, 'in-reach debris → no hint');

    const farDebris = { id: 6, alive: true, mass: 100, orbit: makeOrbit(Math.PI) };
    const advTgt = makeAdvisor({ debrisList: [farDebris], target: { id: 6, alive: true } });
    const commsTgt = trackComms();
    for (let i = 0; i < 30; i++) advTgt.update(1.0);
    assert.equal(commsTgt.length, 0, 'selected target → no hint');
  });

  it('veterans never see the watchdog', () => {
    const farDebris = { id: 9, alive: true, mass: 100, orbit: makeOrbit(Math.PI) };
    const adv = makeAdvisor({ debrisList: [farDebris], veteran: true });
    const comms = trackComms();
    for (let i = 0; i < 40; i++) adv.update(1.0);
    assert.equal(comms.length, 0, 'veteran-gated');
  });

  it('field genuinely empty → routes to the Debris Map instead of a bearing', () => {
    const adv = makeAdvisor({ debrisList: [] });
    const comms = trackComms();
    for (let i = 0; i < 25; i++) adv.update(1.0);
    assert.equal(comms.length, 1);
    assert.ok(comms[0].text.includes('Debris Map'), `text: ${comms[0].text}`);
  });
});

// ============================================================================
// EMPTY-SCAN ROUTING
// ============================================================================

describe('NavRecoveryAdvisor — empty-scan guidance', () => {

  it("SCAN_COMPLETE rewardKind:'empty' posts bearing guidance (throttled)", () => {
    const farDebris = { id: 9, alive: true, mass: 100, orbit: makeOrbit(Math.PI) };
    // Selected target keeps the watchdog quiet — isolates the scan path.
    const adv = makeAdvisor({ debrisList: [farDebris], target: { id: 9, alive: true } });
    const comms = trackComms();

    eventBus.emit(Events.SCAN_COMPLETE, { type: 'quick', rewardKind: 'empty' });
    assert.equal(comms.length, 1, 'empty scan → guidance');
    assert.ok(comms[0].text.includes('Nearest contact'));

    eventBus.emit(Events.SCAN_COMPLETE, { type: 'quick', rewardKind: 'empty' });
    assert.equal(comms.length, 1, 'second empty scan inside cooldown → throttled');

    adv.update(25);  // advance past SCAN_HINT_COOLDOWN_S
    eventBus.emit(Events.SCAN_COMPLETE, { type: 'quick', rewardKind: 'empty' });
    assert.equal(comms.length, 2, 'after cooldown → fires again');
  });

  it('non-empty scan kinds are ignored', () => {
    const farDebris = { id: 9, alive: true, mass: 100, orbit: makeOrbit(Math.PI) };
    makeAdvisor({ debrisList: [farDebris] });
    const comms = trackComms();
    eventBus.emit(Events.SCAN_COMPLETE, { type: 'quick', rewardKind: 'fresh' });
    eventBus.emit(Events.SCAN_COMPLETE, { type: 'wide', rewardKind: 'stale' });
    eventBus.emit(Events.SCAN_COMPLETE, { type: 'wide' });
    assert.equal(comms.length, 0);
  });
});
