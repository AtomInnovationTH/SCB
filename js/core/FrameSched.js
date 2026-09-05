/**
 * FrameSched.js — the adaptive frame-rate POLICY (Session I, plan D-G / D-F).
 *
 * Pure static rules, no imports, no state — the TimeAuthority pattern: main.js
 * owns the loop and feeds plain numbers; tests drive the laws directly. The
 * live decision is published per frame as `window.__frameSched = { mode, n }`
 * (the headless gate asserts POLICY, never fps — SwiftShader runs ~4 fps and
 * proves nothing by timing).
 *
 * THE MECHANISM — "draw every Nth refresh" by FRAME COUNTING, never a time
 * threshold (the old FRAME_CAP judder: a ms-interval gate against a 120 Hz
 * rAF stream skips every other frame unevenly — PERF_SPRINT_REPORT :166; the
 * FRAME_CAP mechanism is RETIRED with this module). A skipped refresh skips
 * the WHOLE tick (sim + render): `dt` simply accumulates to the drawn frame,
 * identical to a display that refreshes N× slower. The rAF period is MEASURED
 * (median of the last `SAMPLE_WINDOW` deltas), and the skip factor clamps at
 * `N = max(1, round(measuredHz / targetFps))` — a display at or below the
 * target NEVER skips (headless SwiftShader at ~4 fps → N = 1, every frame
 * drawn; the policy object is still the gate's witness).
 *
 * THE POLICY (plan D-G, D-F):
 *   'hold'  — a workbench drawer is open (viewCover 'partial'): the world
 *             clock is 0 (TimeAuthority.calmCap) and the picture only needs a
 *             heartbeat — HOLD_FPS (10). Input boosts to native for
 *             HOLD_BOOST_MS (500) so hover/turntable feel live; a turntable
 *             fling (drag velocity/press) extends the boost so momentum never
 *             looks steppy.
 *   'boost' — native refresh: within BOOST_MS (1000) of input in gameplay
 *             (HOLD_BOOST_MS under a drawer), or while a ladder camera ride /
 *             the intro launch ceremony is in flight.
 *   'rest'  — plain gameplay, no recent input: REST_FPS (60). On a 60 Hz
 *             display N = 1 (native); on 120 Hz N = 2.
 *
 * Non-gameplay states never reach this policy — the shipped interval
 * throttles own them (pause halts the loop, hidden halts, blurred ~30 fps
 * keepalive, menus ~30 fps via _getScheduleIntervalMs).
 *
 * @module core/FrameSched
 */

/** rAF-period sample window (median of the last N deltas). */
export const SAMPLE_WINDOW = 30;

/** Ignore rAF deltas above this (tab switches, debugger stalls) — they are
 *  scheduling gaps, not display cadence. */
export const MAX_SAMPLE_MS = 250;

export class FrameSched {
  /**
   * Median of the sampled rAF deltas. Null until the window is FULL — during
   * warmup the caller must not skip (N = 1), so a misread first second can
   * never judder the boot.
   * @param {number[]} deltasMs - rolling rAF-to-rAF deltas (caller-bounded)
   * @returns {number|null} median period in ms, or null while warming up
   */
  static medianPeriodMs(deltasMs) {
    if (!Array.isArray(deltasMs) || deltasMs.length < SAMPLE_WINDOW) return null;
    const s = [...deltasMs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return (s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * The skip factor: draw every Nth refresh to approximate `targetFps` on a
   * display measured at `periodMs` per refresh. The clamp is the headless /
   * slow-display guarantee: a display at or below the target never skips.
   * @param {number|null} periodMs - measured rAF period (null = warming up)
   * @param {number} targetFps - REST_FPS or HOLD_FPS
   * @returns {number} integer N ≥ 1
   */
  static skipFactor(periodMs, targetFps) {
    if (periodMs == null || !(periodMs > 0) || !(targetFps > 0)) return 1;
    const measuredHz = 1000 / periodMs;
    return Math.max(1, Math.round(measuredHz / targetFps));
  }

  /**
   * The per-frame decision. Pure over plain inputs; main.js publishes the
   * result as `window.__frameSched`.
   * @param {object} q
   * @param {'full'|'partial'|'none'} q.cover - viewCover() this frame
   * @param {number} q.nowMs - the rAF timestamp
   * @param {number} q.lastInputMs - last pointer/touch/wheel/key/pane/purchase
   * @param {boolean} q.riding - ladder ride in flight / intro launch ceremony
   * @param {boolean} q.dragLive - turntable drag pressed or velocity > ε
   * @param {number|null} q.periodMs - medianPeriodMs() of the rAF samples
   * @param {{REST_FPS:number, BOOST_MS:number, HOLD_FPS:number, HOLD_BOOST_MS:number}} q.perf
   * @returns {{ mode: 'rest'|'boost'|'hold', n: number }}
   */
  static plan({ cover, nowMs, lastInputMs, riding, dragLive, periodMs, perf }) {
    if (cover === 'partial') {
      // Held world (drawer open): heartbeat unless the player is touching it.
      const boosted = (nowMs - lastInputMs) < perf.HOLD_BOOST_MS || dragLive || riding;
      if (boosted) return { mode: 'boost', n: 1 };
      return { mode: 'hold', n: FrameSched.skipFactor(periodMs, perf.HOLD_FPS) };
    }
    // Plain gameplay: native within the input window and during rides.
    const boosted = (nowMs - lastInputMs) < perf.BOOST_MS || riding;
    if (boosted) return { mode: 'boost', n: 1 };
    return { mode: 'rest', n: FrameSched.skipFactor(periodMs, perf.REST_FPS) };
  }

  /**
   * Should this refresh draw? Frame counting, never a time threshold: the
   * caller increments `tick` once per rAF entry and draws when the counter
   * lands on the Nth beat. N = 1 draws every refresh.
   * @param {number} tick - monotonically increasing rAF-entry counter
   * @param {number} n - skip factor from plan()
   * @returns {boolean}
   */
  static shouldDraw(tick, n) {
    return n <= 1 || (tick % n) === 0;
  }
}
