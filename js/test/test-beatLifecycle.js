/**
 * test-beatLifecycle.js — CP-4 BeatSequencer + pure helpers (Node-safe).
 */
import { describe, it, assert } from './TestRunner.js';
import { BeatSequencer, buildBeatComms, beatMatches } from '../systems/_beatLifecycle.js';

describe('_beatLifecycle — buildBeatComms', () => {
  it('always tags _postOnboarding and defaults to the MISSION channel', () => {
    const p = buildBeatComms({ text: 'hi' });
    assert.equal(p._postOnboarding, true);
    assert.equal(p.channel, 'MISSION');
    assert.equal(p.source, 'HOUSTON');
    assert.equal(p.text, 'hi');
  });

  it('honours explicit source/channel/priority', () => {
    const p = buildBeatComms({ text: 'x', source: 'BANGALORE', channel: 'HOUSTON', priority: 'warning' });
    assert.equal(p.source, 'BANGALORE');
    assert.equal(p.channel, 'HOUSTON');
    assert.equal(p.priority, 'warning');
  });
});

describe('_beatLifecycle — beatMatches', () => {
  it('no filter → always matches', () => {
    assert.equal(beatMatches({}, { mode: 'X' }), true);
  });
  it('filter gates on payload', () => {
    const beat = { triggerFilter: (d) => d && d.mode === 'ARM_PILOT' };
    assert.equal(beatMatches(beat, { mode: 'ARM_PILOT' }), true);
    assert.equal(beatMatches(beat, { mode: 'RCS' }), false);
  });
  it('a throwing filter is treated as no-match (safe)', () => {
    assert.equal(beatMatches({ triggerFilter: () => { throw new Error('boom'); } }, {}), false);
  });
});

describe('_beatLifecycle — BeatSequencer', () => {
  function makeBeats() {
    return [
      { id: 'n1', type: 'narrative', text: 'a' },
      { id: 'i1', type: 'interactive', text: 'b' },
    ];
  }

  it('start posts the first beat', () => {
    const posted = [];
    const seq = new BeatSequencer({ beats: makeBeats(), hooks: { onPost: (b) => posted.push(b.id) } });
    seq.start();
    assert.deepEqual(posted, ['n1']);
    assert.equal(seq.current().id, 'n1');
  });

  it('narrative beat auto-advances after the hold', () => {
    const posted = [];
    const seq = new BeatSequencer({
      beats: makeBeats(),
      timing: { narrativeHoldMs: 5000 },
      hooks: { onPost: (b) => posted.push(b.id) },
    });
    seq.start();
    seq.update(2);
    assert.deepEqual(posted, ['n1'], 'still on narrative before hold elapses');
    seq.update(4); // total 6s > 5s
    assert.deepEqual(posted, ['n1', 'i1'], 'advanced to interactive');
  });

  it('interactive beat waits for satisfy(), does not auto-advance', () => {
    const completed = [];
    const seq = new BeatSequencer({
      beats: [{ id: 'i1', type: 'interactive' }],
      hooks: { onComplete: () => completed.push(true) },
    });
    seq.start();
    seq.update(100); // long idle — must NOT advance
    assert.equal(completed.length, 0);
    const ok = seq.satisfy();
    assert.equal(ok, true);
    assert.equal(completed.length, 1, 'completes after satisfy');
    assert.equal(seq.running, false);
  });

  it('interactive beat escalates exactly once after escalateMs', () => {
    const escalations = [];
    const seq = new BeatSequencer({
      beats: [{ id: 'i1', type: 'interactive' }],
      timing: { escalateMs: 10000 },
      hooks: { onEscalate: (b) => escalations.push(b.id) },
    });
    seq.start();
    seq.update(11); // > 10s
    seq.update(11); // would escalate again — must not
    assert.deepEqual(escalations, ['i1'], 'escalates once only');
  });

  it('reset stops the sequence', () => {
    const seq = new BeatSequencer({ beats: makeBeats() });
    seq.start();
    seq.reset();
    assert.equal(seq.running, false);
    assert.equal(seq.current(), null);
  });

  it('empty beat list → not running, no onComplete', () => {
    let completed = false;
    const seq = new BeatSequencer({ beats: [], hooks: { onComplete: () => { completed = true; } } });
    seq.start();
    assert.equal(seq.running, false);
    assert.equal(completed, false);
  });
});
