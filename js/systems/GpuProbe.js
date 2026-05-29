/**
 * GpuProbe.js — GPU frame-time measurement via EXT_disjoint_timer_query_webgl2.
 *
 * PR 6 / P3.11: One-shot startup probe that measures real GPU render time
 * over a configurable window. If the median exceeds the threshold, the caller
 * (main.js) can trigger a quality-tier downshift.
 *
 * Sprint 3 / GPU profiling: Extended with **named channels** so each
 * `EffectComposer` pass (and, optionally, per-mesh probes) can be timed
 * independently. WebGL2 disallows nested `TIME_ELAPSED` queries, so consumers
 * must arrange channel `begin`/`end` calls sequentially within a frame and
 * **skip the per-frame `beginFrame`/`endFrame` calls** while channels are in
 * use. The channel sums then approximate the per-frame total.
 *
 * Pure-ish: depends on a WebGL2RenderingContext but no THREE imports.
 * Firefox / Safari do not expose the extension — `isSupported` will be false
 * and all methods become no-ops.
 *
 * @module systems/GpuProbe
 */

/**
 * @typedef {object} GpuProbeOptions
 * @property {number} [windowSize=60] — Rolling sample window size (frames).
 */

/**
 * Internal per-channel ring-buffer entry.
 * @typedef {object} ChannelState
 * @property {Array<WebGLQuery>} pending  — queries awaiting GPU completion (FIFO)
 * @property {number[]} samples           — completed sample times in ms
 * @property {boolean} active             — true between begin/end for this channel
 */

export class GpuProbe {
  /**
   * @param {WebGL2RenderingContext} gl — WebGL2 context from the renderer.
   * @param {GpuProbeOptions} [opts]
   */
  constructor(gl, opts = {}) {
    this._gl = gl;
    this._windowSize = opts.windowSize || 60;

    /** @type {boolean} Whether the timer query extension is available */
    this.isSupported = false;

    /** @type {object|null} EXT_disjoint_timer_query_webgl2 extension handle */
    this._ext = null;

    /** @type {number} GL constant for TIME_ELAPSED_EXT */
    this._TIME_ELAPSED = 0;

    /** @type {number} GL constant for GPU_DISJOINT_EXT */
    this._GPU_DISJOINT = 0;

    /** @type {number} GL constant for QUERY_RESULT_AVAILABLE */
    this._QUERY_RESULT_AVAILABLE = 0;

    /** @type {number} GL constant for QUERY_RESULT */
    this._QUERY_RESULT = 0;

    /**
     * Ring buffer of pending queries (oldest first) — frame-level only.
     * Channel queries live in {@link ChannelState.pending}.
     * @type {Array<WebGLQuery>}
     */
    this._pendingQueries = [];

    /**
     * Completed sample times in ms (rolling window) — frame-level only.
     * @type {number[]}
     */
    this._samples = [];

    /** @type {boolean} Whether a frame-level query is active (between begin/end) */
    this._queryActive = false;

    /**
     * Named-channel state. Channels are created lazily on first `beginChannel`
     * call. Per-channel ring buffers are sized to {@link _windowSize}.
     * @type {Map<string, ChannelState>}
     */
    this._channels = new Map();

    /** @type {boolean} Whether any channel currently has an active begin (WebGL2 forbids nesting). */
    this._anyChannelActive = false;

    // Attempt to acquire the extension
    if (gl) {
      try {
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        if (ext) {
          this.isSupported = true;
          this._ext = ext;
          this._TIME_ELAPSED = ext.TIME_ELAPSED_EXT;
          this._GPU_DISJOINT = ext.GPU_DISJOINT_EXT;
          // These are standard WebGL2 constants (not on the extension object)
          this._QUERY_RESULT_AVAILABLE = gl.QUERY_RESULT_AVAILABLE || 0x8867;
          this._QUERY_RESULT = gl.QUERY_RESULT || 0x8866;
        }
      } catch (_e) {
        // Extension not available — isSupported stays false
      }
    }
  }

  /**
   * Begin a GPU timer query for this frame.
   * Call BEFORE the render call.
   *
   * No-op when any channel is currently active (WebGL2 forbids nested
   * TIME_ELAPSED queries — callers must use the channel API XOR the per-frame
   * API, not both at the same time).
   */
  beginFrame() {
    if (!this.isSupported || this._queryActive || this._anyChannelActive) return;
    const gl = this._gl;
    try {
      const q = gl.createQuery();
      if (!q) return;
      gl.beginQuery(this._TIME_ELAPSED, q);
      this._queryActive = true;
      this._pendingQueries.push(q);
    } catch (_e) {
      // Silently fail — don't break the render loop
    }
  }

  /**
   * End the current GPU timer query for this frame.
   * Call AFTER the render call.
   */
  endFrame() {
    if (!this.isSupported || !this._queryActive) return;
    try {
      this._gl.endQuery(this._TIME_ELAPSED);
    } catch (_e) {
      // Silently fail
    }
    this._queryActive = false;
  }

  // ==========================================================================
  // CHANNEL API (Sprint 3 GPU profiling)
  // ==========================================================================

  /**
   * Lazily fetch / create a channel state struct.
   * @private
   * @param {string} name
   * @returns {ChannelState}
   */
  _getChannel(name) {
    let ch = this._channels.get(name);
    if (!ch) {
      ch = { pending: [], samples: [], active: false };
      this._channels.set(name, ch);
    }
    return ch;
  }

  /**
   * Begin a named timer-query channel. Use to time a specific composer pass
   * or a single mesh's draw. Channel queries must be sequential (no nesting)
   * — call {@link endChannel} before starting the next one.
   *
   * Silently no-ops if the extension is unsupported, another query is active,
   * or the channel is already mid-begin.
   *
   * @param {string} name
   */
  beginChannel(name) {
    if (!this.isSupported) return;
    if (this._queryActive || this._anyChannelActive) return;
    const ch = this._getChannel(name);
    if (ch.active) return; // already begun (shouldn't happen given _anyChannelActive guard)
    const gl = this._gl;
    try {
      const q = gl.createQuery();
      if (!q) return;
      gl.beginQuery(this._TIME_ELAPSED, q);
      ch.active = true;
      ch.pending.push(q);
      this._anyChannelActive = true;
    } catch (_e) {
      // Silently fail
    }
  }

  /**
   * End the previously-begun channel. Must be paired with {@link beginChannel}.
   *
   * @param {string} name
   */
  endChannel(name) {
    if (!this.isSupported) return;
    const ch = this._channels.get(name);
    if (!ch || !ch.active) return;
    try {
      this._gl.endQuery(this._TIME_ELAPSED);
    } catch (_e) {
      // Silently fail
    }
    ch.active = false;
    this._anyChannelActive = false;
  }

  /**
   * @returns {string[]} Channel names with at least one completed sample.
   */
  getChannelNames() {
    const out = [];
    for (const [name, ch] of this._channels) {
      if (ch.samples.length > 0) out.push(name);
    }
    return out;
  }

  /**
   * @param {string} name
   * @returns {number} Median in ms, NaN if no samples for this channel.
   */
  getChannelMedianMs(name) {
    const ch = this._channels.get(name);
    if (!ch || ch.samples.length === 0) return NaN;
    const sorted = ch.samples.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * @param {string} name
   * @returns {number} Number of completed samples in this channel's window.
   */
  getChannelSampleCount(name) {
    const ch = this._channels.get(name);
    return ch ? ch.samples.length : 0;
  }

  // ==========================================================================
  // POLLING
  // ==========================================================================

  /**
   * Poll all pending queries and drain finished results.
   * Must be called each frame (from the game loop) to harvest completed queries.
   *
   * @returns {number[]} Array of newly completed **frame-level** sample times
   *                    in milliseconds. Channel samples are stored internally;
   *                    use {@link getChannelMedianMs} to inspect them.
   */
  poll() {
    if (!this.isSupported) return [];
    const gl = this._gl;
    const completed = [];

    // Check for GPU disjoint — if set, ALL pending queries are unreliable
    const disjoint = gl.getParameter(this._GPU_DISJOINT);
    if (disjoint) {
      // Discard all pending frame queries
      for (const q of this._pendingQueries) {
        try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
      }
      this._pendingQueries.length = 0;
      // Also discard pending channel queries (channel samples already recorded
      // are kept — they were valid at the time they completed).
      for (const ch of this._channels.values()) {
        for (const q of ch.pending) {
          try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
        }
        ch.pending.length = 0;
        // Force-reset active flag so a partially-begun query doesn't wedge
        // the channel API forever after a disjoint event.
        ch.active = false;
      }
      this._anyChannelActive = false;
      return completed;
    }

    // Drain frame-level queries
    while (this._pendingQueries.length > 0) {
      const q = this._pendingQueries[0];
      let available = false;
      try {
        available = gl.getQueryParameter(q, this._QUERY_RESULT_AVAILABLE);
      } catch (_e) {
        this._pendingQueries.shift();
        continue;
      }
      if (!available) break;
      this._pendingQueries.shift();
      try {
        const nsElapsed = gl.getQueryParameter(q, this._QUERY_RESULT);
        const ms = nsElapsed / 1e6;
        completed.push(ms);
        this._samples.push(ms);
        if (this._samples.length > this._windowSize) {
          this._samples.shift();
        }
      } catch (_e) { /* discard */ }
      try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
    }

    // Drain channel queries
    for (const ch of this._channels.values()) {
      while (ch.pending.length > 0) {
        const q = ch.pending[0];
        let available = false;
        try {
          available = gl.getQueryParameter(q, this._QUERY_RESULT_AVAILABLE);
        } catch (_e) {
          ch.pending.shift();
          continue;
        }
        if (!available) break;
        ch.pending.shift();
        try {
          const nsElapsed = gl.getQueryParameter(q, this._QUERY_RESULT);
          const ms = nsElapsed / 1e6;
          ch.samples.push(ms);
          if (ch.samples.length > this._windowSize) {
            ch.samples.shift();
          }
        } catch (_e) { /* discard */ }
        try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
      }
    }

    return completed;
  }

  /**
   * Clear the rolling sample windows (frame-level + per-channel) **without**
   * deleting in-flight pending queries. Use between
   * [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1) configurations so
   * each config measures from a clean slate while still letting straggler
   * queries from the previous config drain on the next `poll()` (those
   * post-reset samples are simply included in the next window — callers
   * should wait ~30 frames of settle time so the prev-config tail is
   * outweighed by the 60+ new samples).
   */
  resetSamples() {
    if (!this.isSupported) return;
    this._samples.length = 0;
    for (const ch of this._channels.values()) {
      ch.samples.length = 0;
    }
  }

  /**
   * @returns {number} Number of completed samples in the rolling window.
   */
  getSampleCount() {
    return this._samples.length;
  }

  /**
   * Compute the median GPU frame time from collected samples.
   * @returns {number} Median in milliseconds, or NaN if no samples.
   */
  getMedianMs() {
    const arr = this._samples;
    if (arr.length === 0) return NaN;
    const sorted = arr.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Clean up all pending queries. Call on dispose/teardown.
   */
  dispose() {
    if (!this._gl) return;
    for (const q of this._pendingQueries) {
      try { this._gl.deleteQuery(q); } catch (_e) { /* best effort */ }
    }
    this._pendingQueries.length = 0;
    this._samples.length = 0;
    for (const ch of this._channels.values()) {
      for (const q of ch.pending) {
        try { this._gl.deleteQuery(q); } catch (_e) { /* best effort */ }
      }
      ch.pending.length = 0;
      ch.samples.length = 0;
      ch.active = false;
    }
    this._channels.clear();
    this._anyChannelActive = false;
  }
}

export default GpuProbe;
