/**
 * GpuProbe.js — GPU frame-time measurement via EXT_disjoint_timer_query_webgl2.
 *
 * One-shot startup probe that measures real GPU render time over a configurable window. If the median exceeds the
 * threshold, the caller (main.js) can trigger a quality-tier downshift.
 *
 * **Named channels** time each `EffectComposer` pass (and, optionally, per-mesh probes) independently. WebGL2
 * disallows nested `TIME_ELAPSED` queries, so consumers must arrange channel `begin`/`end` calls sequentially within
 * a frame and **skip the per-frame `beginFrame`/`endFrame` calls** while channels are in use. The channel sums then
 * approximate the per-frame total.
 *
 * Depends on a WebGL2RenderingContext but no THREE imports. Firefox / Safari do not expose the extension:
 * `isSupported` will be false and all methods become no-ops.
 *
 * @module systems/GpuProbe
 */

/**
 * @typedef {object} GpuProbeOptions
 * @property {number} [windowSize=60] — Rolling sample window size (frames).
 */

/**
 * Per-channel ring-buffer entry.
 * @typedef {object} ChannelState
 * @property {Array<WebGLQuery>} pending  — queries awaiting GPU completion (FIFO)
 * @property {number[]} samples           — completed sample times in ms
 * @property {boolean} active             — true between begin/end for this channel
 */

export class GpuProbe {
  constructor(gl, opts = {}) {
    this._gl = gl;
    this._windowSize = opts.windowSize || 60;

    this.isSupported = false;

    this._ext = null;

    this._TIME_ELAPSED = 0;

    this._GPU_DISJOINT = 0;

    this._QUERY_RESULT_AVAILABLE = 0;

    this._QUERY_RESULT = 0;

    /**
     * Ring buffer of pending queries (oldest first), frame-level only. Channel queries live in ChannelState.pending.
     * @type {Array<WebGLQuery>}
     */
    this._pendingQueries = [];

    /**
     * Completed sample times in ms (rolling window), frame-level only.
     * @type {number[]}
     */
    this._samples = [];

    this._queryActive = false;

    /**
     * Named-channel state, created lazily on first `beginChannel`. Per-channel ring buffers are sized to _windowSize.
     * @type {Map<string, ChannelState>}
     */
    this._channels = new Map();

    /** @type {boolean} Whether any channel currently has an active begin (WebGL2 forbids nesting). */
    this._anyChannelActive = false;

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
      }
    }
  }

  /**
   * Begin a GPU timer query for this frame (call BEFORE the render call). No-op when any channel is active: WebGL2
   * forbids nested TIME_ELAPSED queries, so callers use the channel API XOR the per-frame API.
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

  /** End the current GPU timer query for this frame (call AFTER the render call). */
  endFrame() {
    if (!this.isSupported || !this._queryActive) return;
    try {
      this._gl.endQuery(this._TIME_ELAPSED);
    } catch (_e) {
      // Silently fail
    }
    this._queryActive = false;
  }

  /** Lazily fetch / create a channel state struct. */
  _getChannel(name) {
    let ch = this._channels.get(name);
    if (!ch) {
      ch = { pending: [], samples: [], active: false };
      this._channels.set(name, ch);
    }
    return ch;
  }

  /**
   * Begin a named timer-query channel (a composer pass or a single mesh's draw). Channel queries must be sequential
   * (no nesting): call endChannel before starting the next one. Silently no-ops if the extension is unsupported,
   * another query is active, or the channel is already mid-begin.
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

  /** End the previously-begun channel. Must be paired with beginChannel. */
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

  getChannelNames() {
    const out = [];
    for (const [name, ch] of this._channels) {
      if (ch.samples.length > 0) out.push(name);
    }
    return out;
  }

  /** @returns {number} Median in ms, NaN if no samples for this channel. */
  getChannelMedianMs(name) {
    const ch = this._channels.get(name);
    if (!ch || ch.samples.length === 0) return NaN;
    const sorted = ch.samples.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** @returns {number} Number of completed samples in this channel's window. */
  getChannelSampleCount(name) {
    const ch = this._channels.get(name);
    return ch ? ch.samples.length : 0;
  }

  /**
   * Poll all pending queries and drain finished results. Must be called each frame (from the game loop).
   *
   * @returns {number[]} newly completed **frame-level** sample times in ms. Channel samples are stored internally;
   *   use getChannelMedianMs to inspect them.
   */
  poll() {
    if (!this.isSupported) return [];
    const gl = this._gl;
    const completed = [];

    // A GPU disjoint invalidates ALL pending queries.
    const disjoint = gl.getParameter(this._GPU_DISJOINT);
    if (disjoint) {
      for (const q of this._pendingQueries) {
        try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
      }
      this._pendingQueries.length = 0;
      // Also discard pending channel queries (channel samples already recorded are kept: valid when they completed).
      for (const ch of this._channels.values()) {
        for (const q of ch.pending) {
          try { gl.deleteQuery(q); } catch (_e) { /* best effort */ }
        }
        ch.pending.length = 0;
        // Force-reset the active flag so a partially-begun query doesn't wedge the channel API after a disjoint event.
        ch.active = false;
      }
      this._anyChannelActive = false;
      return completed;
    }

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
   * Clear the rolling sample windows (frame-level + per-channel) **without** deleting in-flight pending queries. Use
   * between AutoProfileSweep configurations so each config measures from a clean slate while stragglers from the
   * previous config drain on the next `poll()` (they land in the next window: callers should wait ~30 frames of
   * settle time so the prev-config tail is outweighed by the 60+ new samples).
   */
  resetSamples() {
    if (!this.isSupported) return;
    this._samples.length = 0;
    for (const ch of this._channels.values()) {
      ch.samples.length = 0;
    }
  }

  getSampleCount() {
    return this._samples.length;
  }

  /** Median GPU frame time in ms from collected samples, or NaN if none. */
  getMedianMs() {
    const arr = this._samples;
    if (arr.length === 0) return NaN;
    const sorted = arr.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

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
