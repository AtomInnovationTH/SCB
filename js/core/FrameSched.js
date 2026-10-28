/**
 * @module core/FrameSched — the adaptive frame-rate POLICY. Pure static rules, no imports, no state
 * (the TimeAuthority pattern): main.js owns the loop and feeds plain numbers; tests drive the laws
 * directly. The live decision is published per frame as `window.__frameSched = { mode, n }`
 * (the headless gate asserts POLICY, never fps: SwiftShader runs ~4 fps).
 *
 * MECHANISM — "draw every Nth refresh" by FRAME COUNTING, never a time threshold
 * (a ms-interval gate against a 120 Hz rAF stream skips every other frame unevenly: judder). A skipped refresh skips
 * the WHOLE tick (sim + render): `dt` accumulates to the drawn frame, identical to a display refreshing N× slower. The
 * rAF period is MEASURED (median of the last `SAMPLE_WINDOW` deltas) and `N = max(1, round(measuredHz / targetFps))`: a
 * display at or below the target NEVER skips (headless SwiftShader ~4 fps → N = 1).
 *
 * POLICY:
 *   'hold'  — a workbench drawer is open (viewCover 'partial'): the world clock is 0 (TimeAuthority.calmCap), the
 *   picture needs only a heartbeat — HOLD_FPS (10). Input boosts to native for
 *             HOLD_BOOST_MS (500) so hover/turntable feel live; a turntable fling extends the boost so momentum never
 *             looks steppy.
 *   'boost' — native refresh: within BOOST_MS (1000) of input in gameplay (HOLD_BOOST_MS under a drawer), or while a
 *   ladder camera ride / the intro launch ceremony is in flight.
 *   'rest'  — plain gameplay, no recent input: REST_FPS (60). 60 Hz → N = 1; 120 Hz → N = 2.
 *
 * Non-gameplay states never reach this policy: the shipped interval throttles own them
 * (pause halts the loop, hidden halts, blurred ~30 fps keepalive, menus ~30 fps via _getScheduleIntervalMs).
 */

/** rAF-period sample window (median of the last N deltas). */
export const SAMPLE_WINDOW = 30;

/** Ignore rAF deltas above this (tab switches, debugger stalls): scheduling gaps, not display cadence. */
export const MAX_SAMPLE_MS = 250;

export class FrameSched {
  /**
   * Median of the sampled rAF deltas (caller-bounded), in ms; null until the window is FULL
   * (during warmup the caller must not skip, so a misread first second can't judder the boot).
   */
  static medianPeriodMs(deltasMs) {
    if (!Array.isArray(deltasMs) || deltasMs.length < SAMPLE_WINDOW) return null;
    const s = [...deltasMs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return (s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** The skip factor: draw every Nth refresh to approximate `targetFps` (REST_FPS or HOLD_FPS) on a display measured at
   *  `periodMs` (null = warming up). The clamp guarantees a headless / slow display at or below the target never skips.
   *  @returns {number} integer N ≥ 1 */
  static skipFactor(periodMs, targetFps) {
    if (periodMs == null || !(periodMs > 0) || !(targetFps > 0)) return 1;
    const measuredHz = 1000 / periodMs;
    return Math.max(1, Math.round(measuredHz / targetFps));
  }

  /**
   * The per-frame decision, pure over plain inputs (main.js publishes it as `window.__frameSched`). q: cover
   * 'full'|'partial'|'none' (viewCover() this frame); nowMs (rAF timestamp); lastInputMs
   * (last pointer/touch/wheel/key/pane/purchase); riding (ladder ride in flight / intro launch ceremony); dragLive
   * (turntable drag pressed or velocity > ε); mechLive (a mother actuator — flower/ROSA/struts — actually moving now;
   * same tier as dragLive); periodMs (medianPeriodMs()); perf {REST_FPS, BOOST_MS, HOLD_FPS, HOLD_BOOST_MS}.
   * @returns {{ mode: 'rest'|'boost'|'hold', n: number }}
   */
  static plan({ cover, nowMs, lastInputMs, riding, dragLive, mechLive, periodMs, perf }) {
    if (cover === 'partial') {
      // Held world (drawer open): heartbeat unless the player is touching it.
      const boosted = (nowMs - lastInputMs) < perf.HOLD_BOOST_MS || dragLive || mechLive || riding;
      if (boosted) return { mode: 'boost', n: 1 };
      return { mode: 'hold', n: FrameSched.skipFactor(periodMs, perf.HOLD_FPS) };
    }
    // Plain gameplay: native within the input window and during rides.
    const boosted = (nowMs - lastInputMs) < perf.BOOST_MS || riding;
    if (boosted) return { mode: 'boost', n: 1 };
    return { mode: 'rest', n: FrameSched.skipFactor(periodMs, perf.REST_FPS) };
  }

  /**
   * Did any tracked live value move by more than `eps` since the previous drawn frame? Detects `mechLive`
   * (moving hardware) without reading intent/target latches, which can get stuck true. True if the arrays differ in
   * length (an actuator appeared/vanished: treat as motion, don't throw).
   */
  static anyMoved(prev, cur, eps = 1e-4) {
    if (!Array.isArray(prev) || !Array.isArray(cur)) return false;
    if (prev.length !== cur.length) return true;
    for (let i = 0; i < cur.length; i++) {
      if (Math.abs(cur[i] - prev[i]) > eps) return true;
    }
    return false;
  }

  /**
   * Should this refresh draw? Frame counting: the caller increments `tick` once per rAF entry and draws when it lands
   * on the Nth beat (N from plan(); N = 1 draws every refresh).
   */
  static shouldDraw(tick, n) {
    return n <= 1 || (tick % n) === 0;
  }
}
