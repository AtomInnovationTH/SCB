/**
 * test-SkillsSystem.js — Comprehensive tests for the SkillsSystem
 *
 * Tests skill discovery, state transitions (undiscovered→discovered→practiced→mastered),
 * prerequisites, safety gates, spaced-repetition reminders, persistence, blitz detection,
 * suggestions, and reset behavior.
 *
 * Node-safe: no DOM, no THREE.js dependencies.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { SkillsSystem } from '../systems/SkillsSystem.js';

const S = Constants.SKILLS;

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh SkillsSystem with a clean EventBus. Returns the system. */
function makeSystem() {
    eventBus.clear();
    return new SkillsSystem();
}

/** Track emitted events — returns a growing array of { event, data } */
function trackEvents(...eventNames) {
    const log = [];
    eventNames.forEach(name => {
        eventBus.on(name, (data) => log.push({ event: name, data }));
    });
    return log;
}

/**
 * Trigger a skill N times via its Events constant.
 * @param {string} eventKey - Events.js key (e.g. 'SCAN_QUICK')
 * @param {number} n - How many times to emit
 */
function triggerN(eventKey, n) {
    const eventName = Events[eventKey];
    for (let i = 0; i < n; i++) {
        eventBus.emit(eventName);
    }
}

// ── Suite 1: Construction & Initialization ──────────────────────────────
describe('SkillsSystem — Construction & Initialization', () => {
    const sys = makeSystem();

    it('constructor creates entries for all skills from CATALOG', () => {
        // Delegation 4 (2026-05-31): Catalog grew from 33 → 35 (+arm_struts, +inspect_mother).
        // Assert against the live catalog length so future additions are not blocked.
        const expected = Constants.SKILLS.CATALOG.length;
        assert.equal(sys._skills.size, expected,
            `Expected ${expected} skills, got ${sys._skills.size}`);
    });

    it('all skills start as undiscovered', () => {
        let allUndiscovered = true;
        for (const rec of sys._skills.values()) {
            if (rec.state !== 'undiscovered') {
                allUndiscovered = false;
                break;
            }
        }
        assert.ok(allUndiscovered, 'Every skill should start as undiscovered');
    });

    it('getProgress() returns { discovered: 0, total: <catalog length>, percent: 0 }', () => {
        // Delegation 4 (2026-05-31): assert against the live catalog length.
        const expected = Constants.SKILLS.CATALOG.length;
        const p = sys.getProgress();
        assert.equal(p.discovered, 0);
        assert.equal(p.total, expected);
        assert.equal(p.percent, 0);
    });

    it('constructor does NOT emit TUTORIAL_STAGE_CHANGED (Sprint 3)', () => {
        // Create a fresh system — verify no tutorial compat bridge
        eventBus.clear();
        const log = trackEvents(Events.TUTORIAL_STAGE_CHANGED);
        const sys2 = new SkillsSystem();
        assert.equal(log.length, 0, 'Should NOT emit TUTORIAL_STAGE_CHANGED');
        sys2.dispose();
    });

    it('getTotalCatches() returns 0 initially', () => {
        const sys2 = makeSystem();
        assert.equal(sys2.getTotalCatches(), 0);
        sys2.dispose();
    });

    it('getTotalCatches() increments on LASSO_CAPTURED and ARM_CAPTURED', () => {
        const sys2 = makeSystem();
        eventBus.emit(Events.LASSO_CAPTURED, { debrisId: 1 });
        assert.equal(sys2.getTotalCatches(), 1);
        eventBus.emit(Events.ARM_CAPTURED, { armId: 0, debrisId: 2 });
        assert.equal(sys2.getTotalCatches(), 2);
        sys2.dispose();
    });

    it('getSessionElapsed() returns >= 0 and increases monotonically', () => {
        const sys2 = makeSystem();
        const t1 = sys2.getSessionElapsed();
        assert.ok(t1 >= 0, `elapsed should be >= 0, got ${t1}`);
        // A trivial spin to ensure time passes
        const start = Date.now();
        while (Date.now() - start < 5) { /* busy wait 5ms */ }
        const t2 = sys2.getSessionElapsed();
        assert.ok(t2 >= t1, `elapsed should increase: ${t2} >= ${t1}`);
        sys2.dispose();
    });

    it('each skill record has required mutable fields', () => {
        const rec = sys._skills.values().next().value;
        assert.ok('state' in rec, 'has state');
        assert.ok('count' in rec, 'has count');
        assert.ok('discoveredAt' in rec, 'has discoveredAt');
        assert.ok('lastUsedAt' in rec, 'has lastUsedAt');
        assert.ok('nextReminderAt' in rec, 'has nextReminderAt');
        assert.ok('reminderInterval' in rec, 'has reminderInterval');
        assert.ok('easeFactor' in rec, 'has easeFactor');
        assert.ok('gateUnlocked' in rec, 'has gateUnlocked');
        assert.ok('def' in rec, 'has def');
    });

    it('safety-gated skills start with gateUnlocked = false', () => {
        const rec = sys._skills.get('mastery_detach');
        assert.equal(rec.gateUnlocked, false,
            'mastery_detach should start locked');
    });

    it('non-gated skills start with gateUnlocked = true', () => {
        const rec = sys._skills.get('scan_quick');
        assert.equal(rec.gateUnlocked, true,
            'scan_quick has no safety gate, should be unlocked');
    });

    sys.dispose();
});

// ── Suite 2: Skill Discovery via Events ─────────────────────────────────
describe('SkillsSystem — Skill Discovery via Events', () => {

    it('emitting triggerEvent transitions skill from undiscovered to discovered', () => {
        const sys = makeSystem();
        assert.equal(sys.getState('scan_quick'), 'undiscovered');
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.getState('scan_quick'), 'discovered');
        sys.dispose();
    });

    it('SKILL_DISCOVERED event is emitted with correct payload', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_DISCOVERED);
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(log.length, 1);
        assert.equal(log[0].data.skillId, 'scan_quick');
        assert.equal(log[0].data.tier, 1);
        assert.equal(log[0].data.label, 'Quick Scan');
        sys.dispose();
    });

    it('SKILL_STATE_CHANGED event is emitted for discovery', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_STATE_CHANGED);
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(log.length, 1);
        assert.equal(log[0].data.skillId, 'scan_quick');
        assert.equal(log[0].data.from, 'undiscovered');
        assert.equal(log[0].data.to, 'discovered');
        sys.dispose();
    });

    it('getState() returns discovered after first trigger', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.getState('scan_quick'), 'discovered');
        sys.dispose();
    });

    it('isDiscovered() returns true after first trigger', () => {
        const sys = makeSystem();
        assert.equal(sys.isDiscovered('scan_quick'), false);
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.isDiscovered('scan_quick'), true);
        sys.dispose();
    });

    it('getProgress() updates after discovery', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        const p = sys.getProgress();
        assert.equal(p.discovered, 1);
        assert.ok(p.percent > 0, `percent should be > 0, got ${p.percent}`);
        sys.dispose();
    });

    it('discovering multiple skills increments progress correctly', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_WIDE);
        eventBus.emit(Events.ARM_DEPLOYED);
        const p = sys.getProgress();
        assert.equal(p.discovered, 3);
        sys.dispose();
    });

    it('duplicate triggers do not re-emit SKILL_DISCOVERED', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_DISCOVERED);
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(log.length, 1, 'SKILL_DISCOVERED should only fire once');
        sys.dispose();
    });
});

// ── Suite 3: Skill Progression (discovered → practiced → mastered) ──────
describe('SkillsSystem — Skill Progression', () => {

    it('collect skill reaches practiced after PRACTICE_COUNT_CATCH triggers', () => {
        const sys = makeSystem();
        // collect_deploy: category 'collect', PRACTICE_COUNT_CATCH = 3
        for (let i = 0; i < S.PRACTICE_COUNT_CATCH; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }
        assert.equal(sys.getState('collect_deploy'), 'practiced',
            `Expected practiced after ${S.PRACTICE_COUNT_CATCH} triggers`);
        sys.dispose();
    });

    it('scan skill reaches practiced after PRACTICE_COUNT_SCAN triggers', () => {
        const sys = makeSystem();
        // scan_quick: category 'scan', PRACTICE_COUNT_SCAN = 3
        for (let i = 0; i < S.PRACTICE_COUNT_SCAN; i++) {
            eventBus.emit(Events.SCAN_QUICK);
        }
        assert.equal(sys.getState('scan_quick'), 'practiced',
            `Expected practiced after ${S.PRACTICE_COUNT_SCAN} triggers`);
        sys.dispose();
    });

    it('manage skill reaches practiced after PRACTICE_COUNT_COMPLEX triggers', () => {
        const sys = makeSystem();
        // manage_power: category 'manage', PRACTICE_COUNT_COMPLEX = 2
        for (let i = 0; i < S.PRACTICE_COUNT_COMPLEX; i++) {
            eventBus.emit(Events.POWER_BUS_SELECTED);
        }
        assert.equal(sys.getState('manage_power'), 'practiced',
            `Expected practiced after ${S.PRACTICE_COUNT_COMPLEX} triggers`);
        sys.dispose();
    });

    it('SKILL_STATE_CHANGED emitted for discovered→practiced transition', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_STATE_CHANGED);
        for (let i = 0; i < S.PRACTICE_COUNT_CATCH; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }
        // First event: undiscovered→discovered, second: discovered→practiced
        assert.ok(log.length >= 2, `Expected ≥2 state changes, got ${log.length}`);
        const practiced = log.find(e => e.data.to === 'practiced');
        assert.ok(practiced, 'Should have a transition to practiced');
        assert.equal(practiced.data.from, 'discovered');
        sys.dispose();
    });

    it('collect skill reaches mastered after threshold + time', () => {
        const sys = makeSystem();
        // First trigger → discovered (count: 1)
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.equal(sys.getState('collect_deploy'), 'discovered');

        // Triggers 2-3 → practiced (count: 3)
        eventBus.emit(Events.ARM_DEPLOYED);
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.equal(sys.getState('collect_deploy'), 'practiced');

        // Backdate discoveredAt to satisfy MASTERY_MIN_TIME
        const rec = sys._skills.get('collect_deploy');
        rec.discoveredAt = Date.now() - (S.MASTERY_MIN_TIME + 100) * 1000;

        // Triggers 4-10 → count reaches MASTERY_COUNT_CATCH (10)
        for (let i = 0; i < S.MASTERY_COUNT_CATCH - 3; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }
        assert.equal(sys.getState('collect_deploy'), 'mastered',
            `Expected mastered after ${S.MASTERY_COUNT_CATCH} triggers`);
        sys.dispose();
    });

    it('mastery blocked if MASTERY_MIN_TIME not elapsed', () => {
        const sys = makeSystem();
        // Trigger enough times for mastery count
        for (let i = 0; i < S.MASTERY_COUNT_CATCH; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }
        // discoveredAt is very recent (~now), so MASTERY_MIN_TIME (300s) not met
        assert.equal(sys.getState('collect_deploy'), 'practiced',
            'Should stay practiced when time threshold not met');
        sys.dispose();
    });

    it('isMastered() returns true only after mastery', () => {
        const sys = makeSystem();
        assert.equal(sys.isMastered('collect_deploy'), false);
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.equal(sys.isMastered('collect_deploy'), false);
        sys.dispose();
    });

    it('SKILL_STATE_CHANGED emitted for practiced→mastered transition', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_STATE_CHANGED);

        // Drive to practiced
        for (let i = 0; i < S.PRACTICE_COUNT_CATCH; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }
        // Backdate for mastery time
        sys._skills.get('collect_deploy').discoveredAt =
            Date.now() - (S.MASTERY_MIN_TIME + 100) * 1000;

        // Drive to mastered
        for (let i = 0; i < S.MASTERY_COUNT_CATCH - S.PRACTICE_COUNT_CATCH; i++) {
            eventBus.emit(Events.ARM_DEPLOYED);
        }

        const mastered = log.find(e => e.data.to === 'mastered');
        assert.ok(mastered, 'Should have a transition to mastered');
        assert.equal(mastered.data.from, 'practiced');
        assert.equal(mastered.data.skillId, 'collect_deploy');
        sys.dispose();
    });
});

// ── Suite 4: Prerequisites ──────────────────────────────────────────────
describe('SkillsSystem — Prerequisites', () => {

    it('hard prereq skill does NOT trigger if prereqs unmet', () => {
        const sys = makeSystem();
        // collect_lasso_miss: prereqType='hard', prereqs=['collect_lasso']
        eventBus.emit(Events.LASSO_MISSED);
        assert.equal(sys.getState('collect_lasso_miss'), 'undiscovered',
            'Should remain undiscovered without prereq');
        sys.dispose();
    });

    it('hard prereq skill DOES trigger once prereqs are discovered', () => {
        const sys = makeSystem();
        // First discover collect_lasso
        eventBus.emit(Events.LASSO_FIRED);
        assert.equal(sys.isDiscovered('collect_lasso'), true);
        // Now collect_lasso_miss should trigger
        eventBus.emit(Events.LASSO_MISSED);
        assert.equal(sys.getState('collect_lasso_miss'), 'discovered',
            'Should discover after prereq met');
        sys.dispose();
    });

    it('soft prereq skills always trigger regardless of prereqs', () => {
        const sys = makeSystem();
        // nav_target: prereqType='soft', can trigger anytime
        eventBus.emit(Events.TARGET_SELECTED);
        assert.equal(sys.getState('nav_target'), 'discovered',
            'Soft prereq skills should always trigger');
        sys.dispose();
    });

    it('none prereqType skills always trigger', () => {
        const sys = makeSystem();
        // scan_quick: prereqType='none'
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.getState('scan_quick'), 'discovered');
        sys.dispose();
    });

    it('hard prereq with empty prereqs array always triggers', () => {
        const sys = makeSystem();
        // collect_dual_fire: prereqType='hard', prereqs=[]
        // [].every() returns true
        eventBus.emit(Events.DUAL_FIRE);
        assert.equal(sys.getState('collect_dual_fire'), 'discovered',
            'Hard prereq with empty array should trigger (vacuous truth)');
        sys.dispose();
    });
});

// ── Suite 5: Safety Gates ───────────────────────────────────────────────
describe('SkillsSystem — Safety Gates', () => {

    it('mastery_detach does NOT trigger before minCatches met', () => {
        const sys = makeSystem();
        eventBus.emit(Events.ARM_DETACHED);
        assert.equal(sys.getState('mastery_detach'), 'undiscovered',
            'Should not discover without enough catches');
        sys.dispose();
    });

    it('ARM_CAPTURED increments catch count', () => {
        const sys = makeSystem();
        assert.equal(sys._totalCatches, 0);
        eventBus.emit(Events.ARM_CAPTURED);
        assert.equal(sys._totalCatches, 1);
        sys.dispose();
    });

    it('LASSO_CAPTURED also increments catch count', () => {
        const sys = makeSystem();
        eventBus.emit(Events.LASSO_CAPTURED);
        assert.equal(sys._totalCatches, 1);
        sys.dispose();
    });

    it('SKILL_GATE_UNLOCKED emitted when gate threshold reached', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_GATE_UNLOCKED);
        // mastery_detach needs DETACH_MIN_CATCHES = 2
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.ARM_CAPTURED);
        const detachGate = log.find(e => e.data.skillId === 'mastery_detach');
        assert.ok(detachGate, 'Should emit SKILL_GATE_UNLOCKED for mastery_detach');
        sys.dispose();
    });

    it('mastery_detach triggers after gate is unlocked', () => {
        const sys = makeSystem();
        // Unlock gate with 2 catches
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.ARM_CAPTURED);
        assert.equal(sys._skills.get('mastery_detach').gateUnlocked, true);
        // Now trigger
        eventBus.emit(Events.ARM_DETACHED);
        assert.equal(sys.getState('mastery_detach'), 'discovered',
            'Should discover after gate unlocked');
        sys.dispose();
    });

    it('mixed ARM_CAPTURED + LASSO_CAPTURED both count toward gate', () => {
        const sys = makeSystem();
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.LASSO_CAPTURED);
        assert.equal(sys._totalCatches, 2);
        assert.equal(sys._skills.get('mastery_detach').gateUnlocked, true,
            'Gate should unlock with mixed capture types');
        sys.dispose();
    });
});

// ── Suite 6: getNextSuggestions() ───────────────────────────────────────
describe('SkillsSystem — getNextSuggestions()', () => {

    it('returns undiscovered skills with met prereqs', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions(50);
        assert.ok(suggestions.length > 0, 'Should have suggestions');
        // All suggestions should be for undiscovered skills
        for (const s of suggestions) {
            assert.equal(sys.getState(s.id), 'undiscovered',
                `${s.id} should be undiscovered`);
        }
        sys.dispose();
    });

    it('sorted by tier (lower first), then alphabetically by label', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions(50);
        for (let i = 1; i < suggestions.length; i++) {
            const prev = suggestions[i - 1];
            const curr = suggestions[i];
            if (prev.tier === curr.tier) {
                assert.ok(prev.label.localeCompare(curr.label) <= 0,
                    `"${prev.label}" should come before "${curr.label}" alphabetically`);
            } else {
                assert.ok(prev.tier <= curr.tier,
                    `tier ${prev.tier} should come before tier ${curr.tier}`);
            }
        }
        sys.dispose();
    });

    it('skips noReminder skills', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions(50);
        const noReminderIds = S.CATALOG
            .filter(d => d.noReminder)
            .map(d => d.id);
        for (const s of suggestions) {
            assert.ok(!noReminderIds.includes(s.id),
                `${s.id} has noReminder=true and should be excluded`);
        }
        sys.dispose();
    });

    it('respects the n parameter', () => {
        const sys = makeSystem();
        const two = sys.getNextSuggestions(2);
        assert.equal(two.length, 2, 'Should return exactly 2');
        const one = sys.getNextSuggestions(1);
        assert.equal(one.length, 1, 'Should return exactly 1');
        sys.dispose();
    });

    it('defaults to n=3', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions();
        assert.equal(suggestions.length, 3, 'Default should return 3');
        sys.dispose();
    });

    it('updates as skills are discovered (fewer suggestions)', () => {
        const sys = makeSystem();
        const before = sys.getNextSuggestions(50).length;
        eventBus.emit(Events.SCAN_QUICK);
        const after = sys.getNextSuggestions(50).length;
        assert.equal(after, before - 1,
            'Discovering a non-noReminder skill should reduce suggestions by 1');
        sys.dispose();
    });

    it('safety-prereq skills excluded when prereqs unmet', () => {
        const sys = makeSystem();
        // mastery_detach: prereqType='safety', prereqs=['collect_deploy'], noReminder=false
        // collect_deploy is undiscovered → _prereqsMet returns false → excluded
        const suggestions = sys.getNextSuggestions(50);
        const hasDetach = suggestions.find(s => s.id === 'mastery_detach');
        assert.ok(!hasDetach,
            'mastery_detach should be excluded (prereq collect_deploy unmet)');
        sys.dispose();
    });

    it('safety-prereq skills included when prereqs met', () => {
        const sys = makeSystem();
        // Discover the prereq (collect_deploy)
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.ok(sys.isDiscovered('collect_deploy'), 'prereq should be discovered');
        const suggestions = sys.getNextSuggestions(50);
        const hasDetach = suggestions.find(s => s.id === 'mastery_detach');
        assert.ok(hasDetach,
            'mastery_detach should be included after prereq collect_deploy discovered');
        sys.dispose();
    });

    it('returns exactly 3 at fresh session (ST-3.1 NOVICE checklist requirement)', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions(3);
        assert.equal(suggestions.length, 3,
            `NOVICE checklist requires 3 suggestions, got ${suggestions.length}`);
        sys.dispose();
    });

    it('returns ≥1 suggestion at fresh session start', () => {
        const sys = makeSystem();
        const suggestions = sys.getNextSuggestions(1);
        assert.ok(suggestions.length >= 1,
            'Should always have at least 1 suggestion at start');
        sys.dispose();
    });
});

// ── Suite 7: getDiscoveredSkills() ──────────────────────────────────────
describe('SkillsSystem — getDiscoveredSkills()', () => {

    it('returns empty array initially', () => {
        const sys = makeSystem();
        const discovered = sys.getDiscoveredSkills();
        assert.equal(discovered.length, 0);
        sys.dispose();
    });

    it('returns correct skills after discoveries', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.ARM_DEPLOYED);
        const discovered = sys.getDiscoveredSkills();
        assert.equal(discovered.length, 2);
        const ids = discovered.map(d => d.id);
        assert.ok(ids.includes('scan_quick'), 'Should include scan_quick');
        assert.ok(ids.includes('collect_deploy'), 'Should include collect_deploy');
        sys.dispose();
    });

    it('each returned object has id, label, tier, category, state, count', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        const discovered = sys.getDiscoveredSkills();
        const skill = discovered[0];
        assert.ok('id' in skill, 'has id');
        assert.ok('label' in skill, 'has label');
        assert.ok('tier' in skill, 'has tier');
        assert.ok('category' in skill, 'has category');
        assert.ok('state' in skill, 'has state');
        assert.ok('count' in skill, 'has count');
        assert.equal(skill.id, 'scan_quick');
        assert.equal(skill.state, 'discovered');
        assert.equal(skill.count, 1);
        sys.dispose();
    });

    it('count reflects multiple triggers', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_QUICK);
        const discovered = sys.getDiscoveredSkills();
        const skill = discovered.find(d => d.id === 'scan_quick');
        assert.equal(skill.count, 3);
        assert.equal(skill.state, 'practiced');
        sys.dispose();
    });
});

// ── Suite 8: Persistence (save/load) ────────────────────────────────────
describe('SkillsSystem — Persistence', () => {

    it('PERSISTENCE_GATHER handler adds skill data to saveData', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        const saveData = {};
        eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
        assert.ok(saveData.skills, 'saveData should have .skills');
        assert.equal(saveData.skills.version, 1);
        assert.ok(saveData.skills.skills.scan_quick,
            'Serialized data should include scan_quick');
        sys.dispose();
    });

    it('only non-undiscovered skills are serialized (sparse)', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        const saveData = {};
        eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
        const skillKeys = Object.keys(saveData.skills.skills);
        assert.equal(skillKeys.length, 1,
            'Only 1 discovered skill should be serialized');
        assert.equal(skillKeys[0], 'scan_quick');
        sys.dispose();
    });

    it('serialized skill has correct fields', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        const saveData = {};
        eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
        const saved = saveData.skills.skills.scan_quick;
        assert.equal(saved.state, 'discovered');
        assert.equal(saved.count, 1);
        assert.ok(typeof saved.discoveredAt === 'number');
        assert.ok(typeof saved.lastUsedAt === 'number');
        assert.ok(typeof saved.reminderInterval === 'number');
        assert.ok(typeof saved.easeFactor === 'number');
        sys.dispose();
    });

    it('totalCatches is serialized', () => {
        const sys = makeSystem();
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.ARM_CAPTURED);
        const saveData = {};
        eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
        assert.equal(saveData.skills.totalCatches, 2);
        sys.dispose();
    });

    it('activeGroups are serialized', () => {
        const sys = makeSystem();
        // scan_quick has hudGroup='targets'
        eventBus.emit(Events.SCAN_QUICK);
        const saveData = {};
        eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
        assert.ok(Array.isArray(saveData.skills.activeGroups));
        assert.ok(saveData.skills.activeGroups.includes('targets'),
            'Should include targets group');
        sys.dispose();
    });

    it('restore() correctly rehydrates skill states', () => {
        const sys = makeSystem();
        // Build save data manually
        const savedData = {
            version: 1,
            totalCatches: 5,
            activeGroups: ['targets', 'fleet'],
            skills: {
                scan_quick: {
                    state: 'practiced',
                    count: 4,
                    discoveredAt: Date.now() - 60000,
                    lastUsedAt: Date.now() - 10000,
                    reminderInterval: 90,
                    easeFactor: 2.6,
                },
            },
        };
        sys.restore(savedData);
        assert.equal(sys.getState('scan_quick'), 'practiced');
        assert.equal(sys._skills.get('scan_quick').count, 4);
        assert.equal(sys._totalCatches, 5);
        assert.ok(sys._activeGroups.has('targets'));
        assert.ok(sys._activeGroups.has('fleet'));
        sys.dispose();
    });

    it('restore() ignores data with wrong version', () => {
        const sys = makeSystem();
        sys.restore({ version: 99, skills: {} });
        // Should remain at initial state
        assert.equal(sys.getProgress().discovered, 0);
        sys.dispose();
    });

    it('restore() ignores null data', () => {
        const sys = makeSystem();
        sys.restore(null);
        assert.equal(sys.getProgress().discovered, 0);
        sys.dispose();
    });

    it('restore() rehydrates safety gate status from totalCatches', () => {
        const sys = makeSystem();
        const savedData = {
            version: 1,
            totalCatches: 5,
            activeGroups: [],
            skills: {},
        };
        sys.restore(savedData);
        const rec = sys._skills.get('mastery_detach');
        assert.equal(rec.gateUnlocked, true,
            'Gate should be unlocked when totalCatches >= minCatches');
        sys.dispose();
    });
});

// ── Suite 9: Reset ──────────────────────────────────────────────────────
describe('SkillsSystem — Reset', () => {

    it('reset() returns all skills to undiscovered', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.equal(sys.getProgress().discovered, 2);
        sys.reset();
        for (const rec of sys._skills.values()) {
            assert.equal(rec.state, 'undiscovered',
                `${rec.def.id} should be undiscovered after reset`);
        }
        sys.dispose();
    });

    it('getProgress() returns 0 after reset', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        sys.reset();
        const p = sys.getProgress();
        assert.equal(p.discovered, 0);
        assert.equal(p.percent, 0);
        sys.dispose();
    });

    it('previously discovered skills are cleared', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.isDiscovered('scan_quick'), true);
        sys.reset();
        assert.equal(sys.isDiscovered('scan_quick'), false);
        sys.dispose();
    });

    it('reset clears totalCatches', () => {
        const sys = makeSystem();
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.ARM_CAPTURED);
        assert.equal(sys._totalCatches, 2);
        sys.reset();
        assert.equal(sys._totalCatches, 0);
        sys.dispose();
    });

    it('reset clears active HUD groups', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK); // adds 'targets' group
        assert.ok(sys._activeGroups.has('targets'));
        sys.reset();
        assert.equal(sys._activeGroups.size, 0);
        sys.dispose();
    });

    it('reset re-locks safety gates', () => {
        const sys = makeSystem();
        eventBus.emit(Events.ARM_CAPTURED);
        eventBus.emit(Events.ARM_CAPTURED);
        assert.equal(sys._skills.get('mastery_detach').gateUnlocked, true);
        sys.reset();
        assert.equal(sys._skills.get('mastery_detach').gateUnlocked, false);
        sys.dispose();
    });

    it('GAME_RESET event triggers reset', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(sys.getProgress().discovered, 1);
        eventBus.emit(Events.GAME_RESET);
        assert.equal(sys.getProgress().discovered, 0);
        sys.dispose();
    });
});

// ── Suite 10: Spaced Repetition (Reminders) ─────────────────────────────
describe('SkillsSystem — Spaced Repetition Reminders', () => {

    it('emits SKILL_REMINDED for overdue discovered skill', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        // Discover scan_quick
        eventBus.emit(Events.SCAN_QUICK);
        // Set nextReminderAt to the past
        const rec = sys._skills.get('scan_quick');
        rec.nextReminderAt = Date.now() - 10000;
        // Manually call _checkReminders
        sys._checkReminders(Date.now());
        assert.equal(log.length, 1);
        assert.equal(log[0].data.skillId, 'scan_quick');
        sys.dispose();
    });

    it('mastered skills are NOT reminded', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        // Discover → practice → master scan_quick
        for (let i = 0; i < S.PRACTICE_COUNT_SCAN; i++) {
            eventBus.emit(Events.SCAN_QUICK);
        }
        // Force to mastered for simplicity
        const rec = sys._skills.get('scan_quick');
        rec.state = 'mastered';
        rec.nextReminderAt = Date.now() - 10000;
        sys._checkReminders(Date.now());
        assert.equal(log.length, 0,
            'Mastered skills should not get reminders');
        sys.dispose();
    });

    it('noReminder skills are NOT reminded', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        // awareness_mouse_look has noReminder: true — discover it manually
        const rec = sys._skills.get('awareness_mouse_look');
        rec.state = 'discovered';
        rec.count = 1;
        rec.nextReminderAt = Date.now() - 10000;
        sys._checkReminders(Date.now());
        assert.equal(log.length, 0,
            'noReminder skills should not get reminders');
        sys.dispose();
    });

    it('only one reminder at a time (most overdue)', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        // Discover two skills
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.ARM_DEPLOYED);
        // Make both overdue but scan_quick more overdue
        const recScan = sys._skills.get('scan_quick');
        const recDeploy = sys._skills.get('collect_deploy');
        recScan.nextReminderAt = Date.now() - 20000;
        recDeploy.nextReminderAt = Date.now() - 5000;
        sys._checkReminders(Date.now());
        assert.equal(log.length, 1, 'Only one reminder per check');
        assert.equal(log[0].data.skillId, 'scan_quick',
            'Most overdue skill should be reminded');
        sys.dispose();
    });

    it('reminder frequency cap limits reminders per window', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        // Discover multiple skills
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.ARM_DEPLOYED);
        eventBus.emit(Events.SCAN_WIDE);
        eventBus.emit(Events.LASSO_FIRED);
        // Make all overdue
        for (const [, rec] of sys._skills) {
            if (rec.state !== 'undiscovered') {
                rec.nextReminderAt = Date.now() - 10000;
            }
        }
        // Fire checks equal to cap + 1
        const now = Date.now();
        for (let i = 0; i < S.REMINDER_FREQUENCY_CAP + 1; i++) {
            sys._checkReminders(now);
        }
        assert.equal(log.length, S.REMINDER_FREQUENCY_CAP,
            `Should cap at ${S.REMINDER_FREQUENCY_CAP} reminders per window`);
        sys.dispose();
    });

    it('update() triggers _checkReminders when dt accumulates ≥ 1s', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        eventBus.emit(Events.SCAN_QUICK);
        sys._skills.get('scan_quick').nextReminderAt = Date.now() - 10000;
        // Small dt calls should NOT trigger (need ≥ 1.0 total)
        sys.update(0.3);
        sys.update(0.3);
        assert.equal(log.length, 0, 'Sub-second should not trigger');
        sys.update(0.5); // total = 1.1 → triggers
        assert.equal(log.length, 1, 'Should trigger after ≥1s accumulation');
        sys.dispose();
    });
});

// ── Suite 11: Blitz Detection ───────────────────────────────────────────
describe('SkillsSystem — Blitz Detection', () => {

    it('_isBlitzing returns false with few discoveries', () => {
        const sys = makeSystem();
        sys._discoveryCount = 2;
        sys._firstDiscoveryTime = Date.now() - 1000;
        assert.equal(sys._isBlitzing(Date.now()), false,
            'Below BLITZ_THRESHOLD should not be blitzing');
        sys.dispose();
    });

    it('_isBlitzing returns true with rapid discoveries', () => {
        const sys = makeSystem();
        sys._discoveryCount = S.BLITZ_THRESHOLD;
        sys._firstDiscoveryTime = Date.now() - 10000; // 10s ago (within 300s window)
        assert.equal(sys._isBlitzing(Date.now()), true,
            'At threshold within window should be blitzing');
        sys.dispose();
    });

    it('_isBlitzing returns false if too much time elapsed', () => {
        const sys = makeSystem();
        sys._discoveryCount = S.BLITZ_THRESHOLD + 5;
        // First discovery was 400 seconds ago (beyond BLITZ_DETECTION_WINDOW of 300)
        sys._firstDiscoveryTime = Date.now() - 400000;
        assert.equal(sys._isBlitzing(Date.now()), false,
            'Beyond detection window should not be blitzing');
        sys.dispose();
    });

    it('rapid discoveries increment _discoveryCount', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK);
        eventBus.emit(Events.SCAN_WIDE);
        eventBus.emit(Events.ARM_DEPLOYED);
        assert.equal(sys._discoveryCount, 3);
        sys.dispose();
    });

    it('_firstDiscoveryTime set on first discovery only', () => {
        const sys = makeSystem();
        const beforeFirst = Date.now();
        eventBus.emit(Events.SCAN_QUICK);
        const firstTime = sys._firstDiscoveryTime;
        assert.ok(firstTime >= beforeFirst,
            'firstDiscoveryTime should be set on first discovery');
        eventBus.emit(Events.SCAN_WIDE);
        assert.equal(sys._firstDiscoveryTime, firstTime,
            'firstDiscoveryTime should NOT change on subsequent discoveries');
        sys.dispose();
    });
});

// ── Suite 12: Dispose & Cleanup ─────────────────────────────────────────
describe('SkillsSystem — Dispose & Cleanup', () => {

    it('dispose() removes all EventBus listeners', () => {
        const sys = makeSystem();
        sys.dispose();
        // After dispose, emitting trigger events should not change state
        const log = trackEvents(Events.SKILL_DISCOVERED);
        eventBus.emit(Events.SCAN_QUICK);
        assert.equal(log.length, 0,
            'No SKILL_DISCOVERED should fire after dispose');
        // But we can still query state (data persists, just no listeners)
        assert.equal(sys.getState('scan_quick'), 'undiscovered');
    });

    it('dispose() clears _unsubs array', () => {
        const sys = makeSystem();
        const beforeLen = sys._unsubs.length;
        assert.ok(beforeLen > 0, 'Should have unsubs before dispose');
        sys.dispose();
        assert.equal(sys._unsubs.length, 0, 'unsubs should be empty after dispose');
    });
});

// ── Suite 13: Mastery Celebration (ST-3.4) ──────────────────────────────
describe('SkillsSystem — Mastery Celebration (ST-3.4)', () => {

    /**
     * Helper: drive a skill to mastered via direct _transitionState call.
     * Sets up the rec as discovered+practiced first (bypassing time gates).
     */
    function forceToMastered(sys, skillId) {
        const rec = sys._skills.get(skillId);
        if (!rec) throw new Error(`Unknown skill: ${skillId}`);
        if (rec.state === 'undiscovered') {
            rec.state = 'discovered';
            rec.discoveredAt = Date.now() - 999999 * 1000;
        }
        if (rec.state === 'discovered') {
            rec.state = 'practiced';
        }
        sys._transitionState(rec, 'mastered');
    }

    it('MASTERED transition emits MASTERY_FANFARE with correct payload', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.MASTERY_FANFARE);

        forceToMastered(sys, 'collect_deploy');

        assert.equal(log.length, 1, 'Should emit exactly 1 MASTERY_FANFARE');
        const d = log[0].data;
        assert.equal(d.skillId, 'collect_deploy');
        assert.equal(d.label, 'Deploy Arm');
        assert.equal(d.tier, 2);
        assert.equal(d.category, 'collect');
        assert.equal(typeof d.largeToast, 'boolean');
        sys.dispose();
    });

    it('first 3 masteries have largeToast: true', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.MASTERY_FANFARE);

        forceToMastered(sys, 'collect_deploy');
        forceToMastered(sys, 'collect_lasso');
        forceToMastered(sys, 'collect_trawl');

        assert.equal(log.length, 3, 'Should have 3 MASTERY_FANFARE events');
        assert.equal(log[0].data.largeToast, true, '1st mastery → largeToast true');
        assert.equal(log[1].data.largeToast, true, '2nd mastery → largeToast true');
        assert.equal(log[2].data.largeToast, true, '3rd mastery → largeToast true');
        sys.dispose();
    });

    it('4th mastery has largeToast: false', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.MASTERY_FANFARE);

        forceToMastered(sys, 'collect_deploy');
        forceToMastered(sys, 'collect_lasso');
        forceToMastered(sys, 'collect_trawl');
        forceToMastered(sys, 'scan_quick');

        assert.equal(log.length, 4, 'Should have 4 MASTERY_FANFARE events');
        assert.equal(log[3].data.largeToast, false, '4th mastery → largeToast false');
        sys.dispose();
    });

    it('reset() clears mastery count — next mastery gets largeToast: true again', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.MASTERY_FANFARE);

        // Master 3
        forceToMastered(sys, 'collect_deploy');
        forceToMastered(sys, 'collect_lasso');
        forceToMastered(sys, 'collect_trawl');
        assert.equal(log.length, 3);

        // Reset (new game)
        sys.reset();
        log.length = 0; // clear log

        // Master another after reset — should be treated as 1st mastery
        forceToMastered(sys, 'scan_quick');
        assert.equal(log.length, 1, 'Should emit MASTERY_FANFARE after reset');
        assert.equal(log[0].data.largeToast, true,
            'After reset, mastery count resets so largeToast should be true');
        sys.dispose();
    });
});

// ── Suite: triggerFilter payload discrimination (GUIDANCE_ARBITER_SPEC §5) ──
//
// The arc needs payload-discriminated skills (e.g. "manual capture" =
// ARM_CAPTURED{manual:true}, "wide scan" = SCAN_INITIATED{type:'wide'}).
// CP-4 step 3 adds the OPTIONAL `triggerFilter(data) => boolean` to catalog
// defs: a def with a filter only triggers when the filter returns truthy for
// the event payload; a def WITHOUT a filter triggers on every event (no
// regression). The live catalog ships no filtered defs yet (the arc adds them
// later as data), so these tests inject temporary defs around a fresh system
// and restore the catalog afterwards.
describe('SkillsSystem — triggerFilter payload discrimination', () => {

    /**
     * Build a SkillsSystem whose catalog has been replaced with `defs`.
     * Restores the original catalog when `restore()` is called. Filtered defs
     * are evaluated against live event payloads by the system's listeners.
     */
    function makeSystemWithCatalog(defs) {
        eventBus.clear();
        const original = Constants.SKILLS.CATALOG;
        Constants.SKILLS.CATALOG = defs;
        const sys = new SkillsSystem();
        return {
            sys,
            restore() {
                sys.dispose();
                Constants.SKILLS.CATALOG = original;
            },
        };
    }

    const FILTERED_DEF = {
        id: 'test_manual_capture', label: 'Manual Capture', key: null,
        tier: 1, category: 'collect', hudGroup: null,
        prereqs: [], prereqType: 'none', noReminder: true,
        triggerEvent: 'ARM_CAPTURED',
        triggerFilter: (data) => !!(data && data.manual),
    };
    const UNFILTERED_DEF = {
        id: 'test_any_capture', label: 'Any Capture', key: null,
        tier: 1, category: 'collect', hudGroup: null,
        prereqs: [], prereqType: 'none', noReminder: true,
        triggerEvent: 'LASSO_FIRED',
    };

    it('filtered def triggers ONLY when payload matches the filter', () => {
        const { sys, restore } = makeSystemWithCatalog([FILTERED_DEF]);
        // Non-matching payloads must NOT discover the skill
        eventBus.emit(Events.ARM_CAPTURED, { manual: false });
        eventBus.emit(Events.ARM_CAPTURED, {});
        eventBus.emit(Events.ARM_CAPTURED);
        assert.equal(sys.getState('test_manual_capture'), 'undiscovered',
            'manual:false / empty / undefined payloads must not trigger the filtered skill');

        // Matching payload triggers discovery
        eventBus.emit(Events.ARM_CAPTURED, { manual: true });
        assert.equal(sys.getState('test_manual_capture'), 'discovered',
            'manual:true payload must trigger the filtered skill');
        restore();
    });

    it('filtered def counts only matching payloads', () => {
        const { sys, restore } = makeSystemWithCatalog([FILTERED_DEF]);
        eventBus.emit(Events.ARM_CAPTURED, { manual: true });
        eventBus.emit(Events.ARM_CAPTURED, { manual: false }); // ignored
        eventBus.emit(Events.ARM_CAPTURED, { manual: true });
        const rec = sys._skills.get('test_manual_capture');
        assert.equal(rec.count, 2, 'Only the two manual:true payloads should be counted');
        restore();
    });

    it('def WITHOUT a triggerFilter triggers on every event (no regression)', () => {
        const { sys, restore } = makeSystemWithCatalog([UNFILTERED_DEF]);
        // First event → discovery
        eventBus.emit(Events.LASSO_FIRED);
        assert.equal(sys.getState('test_any_capture'), 'discovered',
            'Unfiltered skill discovers on first event regardless of payload');
        // Further events all count, regardless of payload shape
        eventBus.emit(Events.LASSO_FIRED, { manual: false }); // payload ignored
        eventBus.emit(Events.LASSO_FIRED, { anything: 1 });
        const rec = sys._skills.get('test_any_capture');
        assert.equal(rec.count, 3, 'Unfiltered skill counts every event regardless of payload');
        assert.notEqual(rec.state, 'undiscovered',
            'Unfiltered skill never stays undiscovered after firing');
        restore();
    });

    it('filtered and unfiltered defs sharing nothing coexist correctly', () => {
        const { sys, restore } = makeSystemWithCatalog([FILTERED_DEF, UNFILTERED_DEF]);
        // Fire the unfiltered event — only the unfiltered skill reacts
        eventBus.emit(Events.LASSO_FIRED);
        assert.equal(sys.getState('test_any_capture'), 'discovered');
        assert.equal(sys.getState('test_manual_capture'), 'undiscovered');

        // Fire a non-matching filtered event — neither changes
        eventBus.emit(Events.ARM_CAPTURED, { manual: false });
        assert.equal(sys.getState('test_manual_capture'), 'undiscovered');

        // Fire a matching filtered event — only the filtered skill reacts
        eventBus.emit(Events.ARM_CAPTURED, { manual: true });
        assert.equal(sys.getState('test_manual_capture'), 'discovered');
        restore();
    });

    it('CP-4 ch2 catalog defs carry triggerFilter (arm_pilot, arm_pilot_capture)', () => {
        const withFilter = Constants.SKILLS.CATALOG.filter(d => d.triggerFilter);
        const ids = withFilter.map(d => d.id).sort();
        assert.deepEqual(ids, ['arm_pilot', 'arm_pilot_capture'],
            'ch2 daughter-piloting skills are the payload-discriminated defs');
        const pilot = Constants.SKILLS.CATALOG.find(d => d.id === 'arm_pilot');
        assert.equal(pilot.triggerFilter({ mode: 'ARM_PILOT' }), true);
        assert.equal(!!pilot.triggerFilter({ mode: 'RCS' }), false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
//  CP-4 — universal hint-gating rule + recent-failures + veteran downgrade
//  (GUIDANCE_ARBITER_SPEC §3 / §3.1)
// ════════════════════════════════════════════════════════════════════════════

describe('SkillsSystem — CP-4 recent-failure ring buffer', () => {
    it('recordFailure + failedRecently within TTL', () => {
        const sys = makeSystem();
        const now = Date.now();
        sys.recordFailure('net-fail', now);
        assert.equal(sys.failedRecently('net-fail', now), true);
        assert.equal(sys.failedRecently('lasso-miss', now), false, 'different cause');
        sys.dispose();
    });

    it('a failure older than RECENT_FAILURE_TTL_S is not "recent"', () => {
        const sys = makeSystem();
        const now = Date.now();
        sys.recordFailure('net-fail', now - (S.RECENT_FAILURE_TTL_S * 1000 + 5000));
        assert.equal(sys.failedRecently('net-fail', now), false);
        sys.dispose();
    });

    it('failure events are auto-wired into the buffer', () => {
        const sys = makeSystem();
        eventBus.emit(Events.NET_FAILED, {});
        assert.equal(sys.failedRecently('net-fail'), true, 'NET_FAILED → net-fail');
        sys.dispose();
    });

    it('ring buffer is bounded to RECENT_FAILURE_BUFFER', () => {
        const sys = makeSystem();
        for (let i = 0; i < S.RECENT_FAILURE_BUFFER + 8; i++) sys.recordFailure('net-fail');
        assert.ok(sys._recentFailures.length <= S.RECENT_FAILURE_BUFFER, 'buffer bounded');
        sys.dispose();
    });
});

describe('SkillsSystem — CP-4 universal hint-gating rule (canFireHint)', () => {
    it('undiscovered skill is always eligible (first-encounter teaching)', () => {
        const sys = makeSystem();
        assert.equal(sys.canFireHint('scan_quick'), true);
        sys.dispose();
    });

    it('discovered skill is gated unless failed-recently', () => {
        const sys = makeSystem();
        eventBus.emit(Events.SCAN_QUICK); // discover scan_quick
        assert.equal(sys.getState('scan_quick'), 'discovered');
        assert.equal(sys.canFireHint('scan_quick'), false, 'no recent failure → no nudge');
        sys.recordFailure('net-fail');
        assert.equal(sys.canFireHint('scan_quick'), true, 'recent failure → eligible');
        // With a specific cause that did NOT occur, still gated:
        assert.equal(sys.canFireHint('scan_quick', { cause: 'lasso-miss' }), false);
        sys.dispose();
    });

    it('mastered skill is never nudged', () => {
        const sys = makeSystem();
        const rec = sys._skills.get('scan_quick');
        rec.state = 'mastered';
        sys.recordFailure('net-fail');
        assert.equal(sys.canFireHint('scan_quick'), false);
        sys.dispose();
    });

    it('falls silent after MAX_UNHEEDED_NUDGES, re-arms when the skill is used', () => {
        const sys = makeSystem();
        for (let i = 0; i < S.MAX_UNHEEDED_NUDGES; i++) {
            assert.equal(sys.canFireHint('scan_quick'), true, `nudge ${i + 1} eligible`);
            sys.noteNudgeShown('scan_quick');
        }
        assert.equal(sys.canFireHint('scan_quick'), false, 'silent after the cap');
        eventBus.emit(Events.SCAN_QUICK); // player uses it → heeded
        assert.equal(sys.getUnheededCount('scan_quick'), 0, 'use resets the counter');
        sys.dispose();
    });
});

describe('SkillsSystem — CP-4 veteran downgrade', () => {
    it('isVeteran trips at VETERAN_SKILL_THRESHOLD and downgrades to ticker', () => {
        const sys = makeSystem();
        assert.equal(sys.isVeteran(), false, 'fresh player is not a veteran');
        assert.equal(sys.getHintPresentation(), 'modal');

        // Discover ≥ threshold fraction of skills directly on the records.
        const total = sys.getProgress().total;
        const need = Math.ceil(total * S.VETERAN_SKILL_THRESHOLD);
        let n = 0;
        for (const rec of sys._skills.values()) {
            if (n >= need) break;
            rec.state = 'discovered';
            n++;
        }
        assert.equal(sys.isVeteran(), true, 'veteran once ≥ threshold discovered');
        assert.equal(sys.getHintPresentation(), 'ticker', 'veteran gets ticker, not modal');
        sys.dispose();
    });
});

describe('SkillsSystem — CP-4 reminder cap (4th nudge never fires)', () => {
    it('a skill goes silent after MAX_UNHEEDED_NUDGES reminders', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        eventBus.emit(Events.SCAN_QUICK); // discover (resets unheeded)
        const rec = sys._skills.get('scan_quick');
        const base = Date.now();
        // Advance past the per-window freq cap each iteration to isolate the
        // per-skill unheeded cap; keep the skill overdue each time.
        for (let i = 0; i < S.MAX_UNHEEDED_NUDGES + 3; i++) {
            rec.nextReminderAt = 0;
            sys._checkReminders(base + i * (S.REMINDER_CAP_WINDOW * 1000 + 1000));
        }
        assert.equal(log.length, S.MAX_UNHEEDED_NUDGES,
            `at most ${S.MAX_UNHEEDED_NUDGES} reminders, then silent`);
        sys.dispose();
    });

    it('SKILL_REMINDED payload carries a presentation hint', () => {
        const sys = makeSystem();
        const log = trackEvents(Events.SKILL_REMINDED);
        eventBus.emit(Events.SCAN_QUICK);
        sys._skills.get('scan_quick').nextReminderAt = 0;
        sys._checkReminders(Date.now());
        assert.equal(log.length, 1);
        assert.ok(['ticker', 'modal'].includes(log[0].data.presentation), 'has presentation');
        sys.dispose();
    });
});
