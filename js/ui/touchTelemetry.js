/**
 * touchTelemetry.js — iPad zoom-feel tuning beacon (Ipad.md §6).
 *
 * Touch-only, fire-and-forget. Batches two things and POSTs them to the cable
 * server's /telemetry sink (scripts/serve_ipad.py → tmp/ipad-telemetry.jsonl):
 *   • gesture events fed by TouchControls — `pinch` (with emitted wheel dy) and
 *     `rail` (with the floor a rail-drag jumped to);
 *   • floor CROSSINGS — sampled from a `getFloor()` probe on every log, emitted
 *     as `{k:'floor', from, to}` so a session reads as gestures interleaved
 *     with the floors they actually produced. That correlation is the whole
 *     point: it's how pinch gain / rail feel get tuned from real glass.
 *
 * Every batch carries the corner build stamp and a per-load session id so a
 * stale backgrounded tab's beacons are filterable (Ipad.md §7 trap 6 — stale
 * tabs beacon old builds forever).
 *
 * Constructed ONLY behind TouchControls.detect() (main.js), so it never runs on
 * desktop. Node-safe: no window/navigator/fetch touched at import or in the
 * buffering path; the network call is guarded and swallows every error. `now`
 * and `post` are injectable so the batching + crossing logic is unit-tested
 * without a clock or a socket.
 *
 * @module ui/touchTelemetry
 */

/** Build the floor-crossing delta for a sampled floor, or null when unchanged. */
export function floorCrossing(prevFloor, curFloor) {
  if (curFloor == null || curFloor === prevFloor) return null;
  if (prevFloor == null) return null;   // first sample seeds; no crossing yet
  return { from: prevFloor, to: curFloor };
}

export class TouchTelemetry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.endpoint='/telemetry']  POST target (same-origin cable server)
   * @param {string|null} [opts.build]             corner build stamp (filter key)
   * @param {(()=>number|null)|null} [opts.getFloor] current ladder floor probe
   * @param {number} [opts.flushMs=5000]           flush cadence
   * @param {number} [opts.maxBatch=250]           force a flush at this buffer size
   * @param {(()=>number)|null} [opts.now]         clock (tests)
   * @param {((batch:object)=>void)|null} [opts.post] transport (tests)
   */
  constructor({ endpoint = '/telemetry', build = null, getFloor = null,
                flushMs = 5000, maxBatch = 250, now = null, post = null } = {}) {
    this._endpoint = endpoint;
    this._build = build;
    this._getFloor = typeof getFloor === 'function' ? getFloor : null;
    this._flushMs = flushMs;
    this._maxBatch = maxBatch;
    this._now = typeof now === 'function' ? now : (() => Date.now());
    this._post = typeof post === 'function' ? post : null;
    this._buf = [];
    this._lastFloor = null;
    this._timer = null;
    this._fails = 0;
    this._maxFails = 3;   // consecutive failed sends → assume no sink, go quiet
    this._dead = false;
    this._session = Math.random().toString(36).slice(2, 10);
  }

  /**
   * Record one gesture. Samples the floor first so a crossing that this gesture
   * caused lands just before it in the stream.
   * @param {string} kind  'pinch' | 'rail' | …
   * @param {object} [data] gesture payload (dy, floor, …)
   */
  log(kind, data = {}) {
    const t = Math.round(this._now());
    this._sampleFloor(t);
    this._buf.push({ t, k: kind, ...data });
    if (this._buf.length >= this._maxBatch) this.flush();
  }

  /** @private Emit a crossing event when getFloor() changed since last sample. */
  _sampleFloor(t) {
    if (!this._getFloor) return;
    let f = null;
    try { f = this._getFloor(); } catch (_) { f = null; }
    const cross = floorCrossing(this._lastFloor, f);
    if (cross) this._buf.push({ t, k: 'floor', from: cross.from, to: cross.to });
    if (f != null) this._lastFloor = f;
  }

  /** Begin periodic flushing (browser only; a no-op sink still batches). */
  start() {
    if (this._timer || typeof setInterval !== 'function') return;
    this._timer = setInterval(() => this.flush(), this._flushMs);
    // Best-effort final drain when the tab is backgrounded/closed.
    if (typeof addEventListener === 'function') {
      this._onHide = () => this.flush();
      addEventListener('pagehide', this._onHide);
      addEventListener('visibilitychange', this._onHide);
    }
  }

  /** Stop flushing and drain once. */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._onHide && typeof removeEventListener === 'function') {
      removeEventListener('pagehide', this._onHide);
      removeEventListener('visibilitychange', this._onHide);
      this._onHide = null;
    }
    this.flush();
  }

  /** Ship the current batch (fire-and-forget) and clear it. */
  flush() {
    if (this._dead || !this._buf.length) return;
    const batch = { session: this._session, build: this._build, events: this._buf };
    this._buf = [];
    if (this._post) { this._post(batch); return; }   // injected transport (tests)
    try {
      if (typeof fetch !== 'function') return;
      const body = JSON.stringify(batch);
      // fetch (not sendBeacon) so a non-2xx is OBSERVABLE: a sink that isn't
      // there — offline play, or a static server with no /telemetry — trips the
      // backoff and the beacon goes quiet, instead of failing every flush
      // forever. keepalive lets the final drain survive page unload.
      fetch(this._endpoint, { method: 'POST', body, keepalive: true })
        .then((r) => { if (r && r.ok) this._fails = 0; else this._noteFail(); })
        .catch(() => this._noteFail());
    } catch (_) { this._noteFail(); }
  }

  /** @private Consecutive failures → assume no cable sink and stop trying. */
  _noteFail() {
    if (++this._fails >= this._maxFails) {
      this._dead = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }
  }
}

export default TouchTelemetry;
