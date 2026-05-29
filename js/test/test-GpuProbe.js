/**
 * test-GpuProbe.js — PR 6 / P3.11: GPU runtime probe tests.
 *
 * WebGL2 contexts don't exist in Node, so we mock a minimal `gl` stub with
 * the EXT_disjoint_timer_query_webgl2 extension and required constants.
 *
 * Verifies:
 *   - Without extension, isSupported === false and methods are no-ops.
 *   - With extension, samples ring-buffer correctly.
 *   - getMedianMs returns correct median.
 *   - Disjoint samples are discarded.
 *   - dispose() cleans up pending queries.
 */

import { describe, it, assert } from './TestRunner.js';
import { GpuProbe } from '../systems/GpuProbe.js';

// ==========================================================================
// MOCK GL HELPERS
// ==========================================================================

/** Create a minimal WebGL2 mock that does NOT have the timer extension. */
function createMockGlNoExtension() {
  return {
    getExtension: () => null,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
  };
}

/**
 * Create a full mock GL with EXT_disjoint_timer_query_webgl2.
 * @param {{ disjoint?: boolean }} [opts]
 */
function createMockGl(opts = {}) {
  let queryCounter = 0;
  /** @type {Map<number, { begun: boolean, ended: boolean, resultNs: number }>} */
  const queries = new Map();
  let activeQueryId = null;

  const ext = {
    TIME_ELAPSED_EXT: 0x88BF,
    GPU_DISJOINT_EXT: 0x8FBB,
  };

  const gl = {
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,

    _disjoint: opts.disjoint || false,
    _queries: queries,

    getExtension(name) {
      if (name === 'EXT_disjoint_timer_query_webgl2') return ext;
      return null;
    },

    createQuery() {
      const id = ++queryCounter;
      queries.set(id, { begun: false, ended: false, resultNs: 0 });
      return id;
    },

    beginQuery(target, queryId) {
      const q = queries.get(queryId);
      if (q) {
        q.begun = true;
        activeQueryId = queryId;
      }
    },

    endQuery(_target) {
      if (activeQueryId != null) {
        const q = queries.get(activeQueryId);
        if (q) {
          q.ended = true;
          // Simulate a GPU time: default 8ms (8,000,000 ns)
          q.resultNs = 8_000_000;
        }
        activeQueryId = null;
      }
    },

    getParameter(pname) {
      if (pname === ext.GPU_DISJOINT_EXT) return gl._disjoint;
      return 0;
    },

    getQueryParameter(queryId, pname) {
      const q = queries.get(queryId);
      if (!q) return 0;
      if (pname === gl.QUERY_RESULT_AVAILABLE) return q.ended;
      if (pname === gl.QUERY_RESULT) return q.resultNs;
      return 0;
    },

    deleteQuery(queryId) {
      queries.delete(queryId);
    },
  };

  return { gl, ext };
}

// ==========================================================================
// TESTS
// ==========================================================================

describe('GpuProbe — no extension (Firefox / Safari fallback)', () => {
  it('isSupported === false when extension is absent', () => {
    const gl = createMockGlNoExtension();
    const probe = new GpuProbe(gl);
    assert.equal(probe.isSupported, false, 'should be unsupported');
  });

  it('beginFrame/endFrame/poll are no-ops when unsupported', () => {
    const gl = createMockGlNoExtension();
    const probe = new GpuProbe(gl);
    probe.beginFrame(); // should not throw
    probe.endFrame();   // should not throw
    const samples = probe.poll();
    assert.ok(Array.isArray(samples), 'poll returns an array');
    assert.equal(samples.length, 0, 'no samples when unsupported');
    assert.equal(probe.getSampleCount(), 0, 'sample count is 0');
    assert.ok(Number.isNaN(probe.getMedianMs()), 'median is NaN with no samples');
  });

  it('null gl argument does not throw', () => {
    const probe = new GpuProbe(null);
    assert.equal(probe.isSupported, false, 'null gl → unsupported');
    probe.beginFrame();
    probe.endFrame();
    probe.poll();
    probe.dispose();
  });
});

describe('GpuProbe — with extension (Chrome / Edge)', () => {
  it('isSupported === true when extension is available', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl);
    assert.equal(probe.isSupported, true, 'should be supported');
  });

  it('single frame cycle: begin → end → poll yields one sample', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginFrame();
    probe.endFrame();
    const samples = probe.poll();
    assert.equal(samples.length, 1, `expected 1 sample, got ${samples.length}`);
    assert.equal(samples[0], 8, `expected 8ms, got ${samples[0]}`); // 8_000_000 ns → 8 ms
    assert.equal(probe.getSampleCount(), 1, 'sample count after 1 frame');
  });

  it('multiple frames accumulate in rolling window', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 5 });
    for (let i = 0; i < 7; i++) {
      probe.beginFrame();
      probe.endFrame();
      probe.poll();
    }
    // windowSize is 5, so only the last 5 samples survive
    assert.equal(probe.getSampleCount(), 5, `expected 5 capped samples, got ${probe.getSampleCount()}`);
  });

  it('getMedianMs returns correct median for odd count', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 100 });
    // Push 5 frames with different GPU times
    const times = [4, 12, 8, 16, 6]; // sorted: 4, 6, 8, 12, 16 → median = 8
    for (const t of times) {
      probe.beginFrame();
      probe.endFrame();
      // Mock: set resultNs AFTER endFrame (which sets a default value)
      const pending = probe._pendingQueries;
      const lastQ = pending[pending.length - 1];
      gl._queries.get(lastQ).resultNs = t * 1_000_000;
      probe.poll();
    }
    assert.equal(probe.getSampleCount(), 5, 'should have 5 samples');
    const median = probe.getMedianMs();
    assert.equal(median, 8, `expected median 8, got ${median}`);
  });

  it('getMedianMs returns correct median for even count', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 100 });
    const times = [4, 12, 8, 16]; // sorted: 4, 8, 12, 16 → median = (8+12)/2 = 10
    for (const t of times) {
      probe.beginFrame();
      probe.endFrame();
      // Mock: set resultNs AFTER endFrame (which sets a default value)
      const pending = probe._pendingQueries;
      const lastQ = pending[pending.length - 1];
      gl._queries.get(lastQ).resultNs = t * 1_000_000;
      probe.poll();
    }
    const median = probe.getMedianMs();
    assert.equal(median, 10, `expected median 10, got ${median}`);
  });
});

describe('GpuProbe — disjoint handling', () => {
  it('disjoint flag discards all pending queries', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });

    // Queue 3 frames
    probe.beginFrame(); probe.endFrame();
    probe.beginFrame(); probe.endFrame();
    probe.beginFrame(); probe.endFrame();

    // Before polling, set disjoint
    gl._disjoint = true;
    const samples = probe.poll();
    assert.equal(samples.length, 0, 'disjoint → 0 samples returned');
    assert.equal(probe.getSampleCount(), 0, 'disjoint → 0 in history');
    // Pending queue should be cleared
    assert.equal(probe._pendingQueries.length, 0, 'pending queries cleared on disjoint');
  });

  it('non-disjoint frames after disjoint still work', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });

    // Frame 1: disjoint
    probe.beginFrame(); probe.endFrame();
    gl._disjoint = true;
    probe.poll(); // discarded

    // Frame 2: normal
    gl._disjoint = false;
    probe.beginFrame(); probe.endFrame();
    const samples = probe.poll();
    assert.equal(samples.length, 1, 'normal frame after disjoint yields sample');
    assert.equal(probe.getSampleCount(), 1, 'sample count is 1');
  });
});

describe('GpuProbe — dispose', () => {
  it('dispose clears pending queries and samples', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginFrame(); probe.endFrame();
    probe.beginFrame(); probe.endFrame();
    probe.poll();
    assert.ok(probe.getSampleCount() > 0, 'has samples before dispose');
    probe.dispose();
    assert.equal(probe.getSampleCount(), 0, 'samples cleared after dispose');
    assert.equal(probe._pendingQueries.length, 0, 'pending cleared after dispose');
  });
});

// ==========================================================================
// SPRINT 3 — NAMED CHANNEL API (per-pass GPU timing)
// ==========================================================================

describe('GpuProbe — channels: basic sample collection', () => {
  it('beginChannel/endChannel/poll records a sample under the channel name', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('render');
    probe.endChannel('render');
    probe.poll();
    assert.equal(probe.getChannelSampleCount('render'), 1, 'one sample recorded');
    // Mock endQuery hard-codes 8 ms; getChannelMedianMs should reflect it.
    assert.equal(probe.getChannelMedianMs('render'), 8, 'median equals mocked 8 ms');
  });

  it('unknown channel returns NaN median and zero count', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    assert.equal(Number.isNaN(probe.getChannelMedianMs('does-not-exist')), true);
    assert.equal(probe.getChannelSampleCount('does-not-exist'), 0);
  });

  it('getChannelNames lists only channels with completed samples', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('a'); probe.endChannel('a');
    probe.beginChannel('b'); probe.endChannel('b');
    probe.poll();
    const names = probe.getChannelNames().sort();
    assert.equal(names.length, 2, 'two channels visible');
    assert.equal(names[0], 'a');
    assert.equal(names[1], 'b');
  });
});

describe('GpuProbe — channels: nesting and isolation guards', () => {
  it('starting a second channel while one is active is a no-op (WebGL2 forbids nesting)', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('outer');
    // While `outer` is active, beginning another channel must be ignored.
    probe.beginChannel('inner');
    probe.endChannel('inner'); // no-op (never begun)
    probe.endChannel('outer');
    probe.poll();
    assert.equal(probe.getChannelSampleCount('outer'), 1, 'outer recorded');
    assert.equal(probe.getChannelSampleCount('inner'), 0, 'inner never began');
  });

  it('beginFrame is a no-op while a channel is active', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('render');
    probe.beginFrame();  // must be ignored
    probe.endFrame();    // also a no-op (no frame query was started)
    probe.endChannel('render');
    probe.poll();
    assert.equal(probe.getSampleCount(), 0, 'no frame samples');
    assert.equal(probe.getChannelSampleCount('render'), 1, 'channel still recorded');
  });

  it('beginChannel is a no-op while a frame query is active', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginFrame();
    probe.beginChannel('render');  // ignored
    probe.endChannel('render');    // no-op
    probe.endFrame();
    probe.poll();
    assert.equal(probe.getSampleCount(), 1, 'frame sample recorded');
    assert.equal(probe.getChannelSampleCount('render'), 0, 'channel did not record');
  });
});

describe('GpuProbe — channels: median + ring buffer + disjoint', () => {
  it('median is correct across multiple samples per channel', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    // Record three samples with different mock timings by writing resultNs
    // directly after each endChannel.
    const times = [4, 8, 12];
    for (const t of times) {
      probe.beginChannel('render');
      const activeId = Array.from(gl._queries.keys()).pop();
      probe.endChannel('render');
      // Overwrite the mock's default 8 ms result with the desired value.
      gl._queries.get(activeId).resultNs = t * 1_000_000;
      probe.poll();
    }
    assert.equal(probe.getChannelSampleCount('render'), 3, 'three samples');
    assert.equal(probe.getChannelMedianMs('render'), 8, 'median of [4,8,12] is 8');
  });

  it('disjoint flag discards pending channel queries and clears active flag', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('render');
    probe.endChannel('render');
    gl._disjoint = true;
    probe.poll();
    assert.equal(probe.getChannelSampleCount('render'), 0, 'sample discarded on disjoint');
    // After disjoint reset, normal channels should still work.
    gl._disjoint = false;
    probe.beginChannel('render');
    probe.endChannel('render');
    probe.poll();
    assert.equal(probe.getChannelSampleCount('render'), 1, 'subsequent sample recorded');
  });

  it('dispose clears channel pending queues and samples', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginChannel('render'); probe.endChannel('render');
    probe.poll();
    assert.ok(probe.getChannelSampleCount('render') > 0, 'has sample before dispose');
    probe.dispose();
    assert.equal(probe.getChannelSampleCount('render'), 0, 'channel cleared after dispose');
    assert.equal(Number.isNaN(probe.getChannelMedianMs('render')), true, 'median is NaN after dispose');
  });
});

describe('GpuProbe — channels: unsupported (no extension)', () => {
  it('all channel methods are no-ops without the extension', () => {
    const probe = new GpuProbe(createMockGlNoExtension());
    // Must not throw
    probe.beginChannel('render');
    probe.endChannel('render');
    probe.poll();
    assert.equal(probe.getChannelSampleCount('render'), 0);
    assert.equal(probe.getChannelNames().length, 0);
    assert.equal(Number.isNaN(probe.getChannelMedianMs('render')), true);
  });
});

describe('GpuProbe — resetSamples (Sprint 3 AutoProfileSweep helper)', () => {
  it('resetSamples clears frame samples and channel samples but not pending queries', () => {
    const { gl } = createMockGl();
    const probe = new GpuProbe(gl, { windowSize: 10 });
    probe.beginFrame(); probe.endFrame();
    probe.beginChannel('render'); probe.endChannel('render');
    probe.poll();
    assert.ok(probe.getSampleCount() > 0, 'has frame samples');
    assert.ok(probe.getChannelSampleCount('render') > 0, 'has channel samples');
    probe.resetSamples();
    assert.equal(probe.getSampleCount(), 0, 'frame samples cleared');
    assert.equal(probe.getChannelSampleCount('render'), 0, 'channel samples cleared');
    // Next sample after reset should land in the cleared buffers.
    probe.beginFrame(); probe.endFrame();
    probe.beginChannel('render'); probe.endChannel('render');
    probe.poll();
    assert.equal(probe.getSampleCount(), 1, 'new frame sample after reset');
    assert.equal(probe.getChannelSampleCount('render'), 1, 'new channel sample after reset');
  });

  it('resetSamples is a no-op when unsupported', () => {
    const probe = new GpuProbe(createMockGlNoExtension());
    probe.resetSamples();
    assert.equal(probe.getSampleCount(), 0);
  });
});
