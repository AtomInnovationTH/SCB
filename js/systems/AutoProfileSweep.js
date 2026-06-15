/**
 * AutoProfileSweep.js — Sprint 3 GPU profiling automated capture.
 *
 * Cycles through a fixed list of render configurations in a **single** browser
 * session, capturing a 60-sample GPU median for each one. Dumps the result
 * as JSON to:
 *   1. `console.log` (always, formatted),
 *   2. `window.__autoProfileResult` (for devtools fetch),
 *   3. an auto-downloaded `.json` blob (clipboard fallback otherwise).
 *
 * Activated by [`?autoProfile=1`](js/core/ProfileFlags.js:1). The sweep runs
 * in whatever game state the user is in when the page settles — so to capture
 * both MENU and IN-MISSION cells the user reloads twice (once on the menu,
 * once after launching into a mission). **Two sessions total instead of 14.**
 *
 * Per-config flow:
 *   1. Apply config via [`SceneManager.applyTierWithOverrides`](js/scene/SceneManager.js:1)
 *   2. Settle for `SETTLE_FRAMES` (composer rebuild causes a 1-frame stutter
 *      + driver shader-recompile spike on the very first frame).
 *   3. `gpuProbe.resetSamples()` to drop the settle window.
 *   4. Wait until `gpuProbe.getSampleCount() >= SAMPLES_PER_CONFIG`.
 *   5. Read median, draw counts, per-pass medians (if `profilePasses` config),
 *      record snapshot.
 *
 * Total wall-clock per session at 120 fps:
 *   ~9 configs × (30 settle + 60 sample) / 120 = **~7 s of measurement**,
 *   plus ~2 s of initial settle + JSON dump. Well under a minute.
 *
 * Pure orchestrator — depends only on the public APIs of `SceneManager`,
 * `Earth`, and `GpuProbe`. No THREE imports, no scene mutations beyond what
 * those APIs offer.
 *
 * @module systems/AutoProfileSweep
 */

import { profileFlags } from '../core/ProfileFlags.js';

/**
 * Number of frames to wait after each config change before resetting the
 * sample window. Composer rebuild causes a 1-frame stutter and driver shader
 * compilation spike on the very first frame after a rebuild, so we drop those
 * by hand.
 */
const SETTLE_FRAMES = 30;

/**
 * Number of GPU samples to collect for each config's median. With a 120 Hz
 * display this is ~0.5 s of measurement — long enough to drown out driver
 * scheduler jitter but short enough that a 9-config sweep finishes in <10 s.
 */
const SAMPLES_PER_CONFIG = 60;

/**
 * Maximum frames to wait for `SAMPLES_PER_CONFIG` before giving up on this
 * config and recording whatever we have. Prevents the sweep wedging if the
 * disjoint flag fires repeatedly (or the platform never supplied the GPU
 * extension in the first place — in which case the sweep emits an
 * `unsupported` snapshot rather than hanging forever).
 */
const MAX_FRAMES_PER_CONFIG = 600; // 5 s at 120 Hz

/**
 * Fixed sweep order. Each entry is `{ id, overrides }`; `overrides` is the
 * full payload handed to [`SceneManager.applyTierWithOverrides`](js/scene/SceneManager.js:1).
 *
 * Keep `baseline` first so the very first measurement establishes the per-
 * session anchor that every other row is compared against.
 *
 * @type {ReadonlyArray<{id: string, overrides: object}>}
 */
export const SWEEP_CONFIGS = Object.freeze([
  // --- Anchor + per-pass profiling ---
  { id: 'baseline',              overrides: {} },
  { id: 'profilePasses',         overrides: { profilePasses: true } },

  // --- Single-disable rows (round-1) ---
  { id: 'disableEarthNoise',     overrides: { earthLowDetail: true } },
  { id: 'disableBloom',          overrides: { enableBloom: false } },
  { id: 'disableSMAA',           overrides: { enableSMAA: false } },
  { id: 'disableClouds',         overrides: { cloudsVisible: false } },
  { id: 'disableAtmosphere',     overrides: { atmosphereVisible: false } },
  { id: 'msaa=0',                overrides: { msaaSamples: 0 } },
  { id: 'pixelRatio=1',          overrides: { pixelRatioCap: 1 } },

  // --- Round-2 multi-disable rows: find the realistic post-process floor ---
  // The round-1 sum of singles (bloom 19 + smaa 16 + msaa 16 = 51 ms) far
  // exceeds the 23.65 ms baseline, which means at least two of the three
  // are bottlenecked on shared work (most likely HalfFloat customRT
  // bandwidth). Pair-Δ vs sum-of-singles tells us *how* shared:
  //   pair-Δ ≈ max(single-Δ)           → fully shared
  //   pair-Δ ≈ single1 + single2       → fully independent
  //   anything in between               → partial overlap
  { id: 'disableBloomAndSMAA',   overrides: { enableBloom: false, enableSMAA: false } },
  { id: 'disableBloomAndMSAA',   overrides: { enableBloom: false, msaaSamples: 0 } },
  { id: 'disableSMAAAndMSAA',    overrides: { enableSMAA: false, msaaSamples: 0 } },
  // disableAllPost is the realistic floor: RenderPass becomes the *only*
  // pass, so EffectComposer sets renderToScreen=true on it and the HalfFloat
  // customRT is never written. Frame cost should approximate just the Earth
  // FS work + canvas blit.
  { id: 'disableAllPost',        overrides: { enableBloom: false, enableSMAA: false, msaaSamples: 0 } },
]);

/**
 * Read fresh game state from the supplied refs each call so the snapshot
 * reflects what the player was actually doing at the moment of capture.
 *
 * @param {object} refs
 * @returns {string}
 */
function readGameState(refs) {
  try {
    // Primary source: [`gameState`](js/core/GameState.js:1) singleton — that's
    // what the rest of the engine reads. `gameFlowManager` mutates it via
    // `gameState.setState`.
    const gs = refs?.gameState;
    if (gs) {
      if (typeof gs.getState === 'function') return String(gs.getState());
      if (gs.currentState) return String(gs.currentState);
    }
    if (typeof window !== 'undefined' && window.__currentGameState) {
      return String(window.__currentGameState);
    }
  } catch (_e) { /* swallow */ }
  return 'UNKNOWN';
}

/**
 * Read fresh per-pass channel medians from a {@link GpuProbe}.
 *
 * @param {any} gpuProbe
 * @returns {Record<string, { medianMs: number|null, samples: number }>}
 */
function readChannels(gpuProbe) {
  /** @type {Record<string, { medianMs: number|null, samples: number }>} */
  const out = {};
  if (!gpuProbe || typeof gpuProbe.getChannelNames !== 'function') return out;
  let names = [];
  try { names = gpuProbe.getChannelNames(); } catch (_e) { return out; }
  for (const name of names) {
    let m = NaN, c = 0;
    try { m = gpuProbe.getChannelMedianMs(name); } catch (_e) {}
    try { c = gpuProbe.getChannelSampleCount(name); } catch (_e) {}
    out[name] = {
      medianMs: Number.isFinite(m) ? Number(m.toFixed(3)) : null,
      samples: Number.isFinite(c) ? c : 0,
    };
  }
  return out;
}

/**
 * Sleep for `n` requestAnimationFrame ticks. Resolves on the rAF callback
 * after the `n`-th tick has fired — so the caller's continuation runs in the
 * frame *after* the wait completes.
 *
 * @param {number} n
 * @returns {Promise<void>}
 */
function waitFrames(n) {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      if (++frames >= n) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Wait until `gpuProbe.getSampleCount() >= target` or `maxFrames` rAF ticks
 * have elapsed (whichever comes first). Resolves with `true` if the target
 * was reached, `false` on timeout.
 *
 * @param {any} gpuProbe
 * @param {number} target
 * @param {number} maxFrames
 * @returns {Promise<boolean>}
 */
function waitForSamples(gpuProbe, target, maxFrames) {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      let count = 0;
      try { count = gpuProbe.getSampleCount(); } catch (_e) {}
      if (count >= target) { resolve(true); return; }
      if (++frames >= maxFrames) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
/**
 * Lazy-install a single fixed-position overlay used both for live progress
 * (sweep is running) and final-result display (sweep is done). The overlay
 * is the primary delivery channel because browsers silently block download
 * blobs and clipboard writes that originate inside a rAF chain (no user
 * gesture). Manual copy-from-modal works regardless.
 *
 * @returns {{ root: HTMLDivElement, status: HTMLDivElement, pre: HTMLPreElement, copyBtn: HTMLButtonElement, closeBtn: HTMLButtonElement, downloadBtn: HTMLAnchorElement }}
 */
function ensureOverlay() {
  let root = document.getElementById('auto-profile-overlay');
  if (root) {
    return {
      root,
      status: /** @type {HTMLDivElement} */ (root.querySelector('.ap-status')),
      pre: /** @type {HTMLPreElement} */ (root.querySelector('.ap-pre')),
      copyBtn: /** @type {HTMLButtonElement} */ (root.querySelector('.ap-copy')),
      closeBtn: /** @type {HTMLButtonElement} */ (root.querySelector('.ap-close')),
      downloadBtn: /** @type {HTMLAnchorElement} */ (root.querySelector('.ap-download')),
    };
  }
  // Style block once.
  if (!document.getElementById('auto-profile-overlay-style')) {
    const style = document.createElement('style');
    style.id = 'auto-profile-overlay-style';
    style.textContent = `
#auto-profile-overlay {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 999999; max-width: 720px; width: calc(100vw - 32px);
  padding: 12px 14px; background: rgba(0,0,0,0.92); color: #b8f6c4;
  font: 12px/1.4 Menlo, Consolas, monospace; border: 1px solid #2d5a3a;
  border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,0.6);
}
#auto-profile-overlay .ap-status {
  font-size: 13px; color: #5dffaf; margin-bottom: 8px;
  letter-spacing: 0.04em; text-transform: uppercase;
}
#auto-profile-overlay .ap-pre {
  margin: 6px 0; padding: 8px; background: rgba(0,0,0,0.55);
  border: 1px solid #173821; border-radius: 4px;
  max-height: 38vh; overflow: auto; white-space: pre;
  font-size: 11px; color: #d6ffd9;
}
#auto-profile-overlay .ap-row { display: flex; gap: 8px; margin-top: 6px; }
#auto-profile-overlay button, #auto-profile-overlay a.ap-download {
  flex: 1; padding: 8px 10px; font: inherit; color: #000;
  background: #5dffaf; border: 0; border-radius: 4px; cursor: pointer;
  text-decoration: none; text-align: center;
}
#auto-profile-overlay button.ap-close { background: #2d5a3a; color: #b8f6c4; }
#auto-profile-overlay button:hover, #auto-profile-overlay a.ap-download:hover { filter: brightness(1.1); }
#auto-profile-overlay .ap-hint { font-size: 10px; color: #7fcc8f; margin-top: 6px; }
`;
    document.head.appendChild(style);
  }
  root = document.createElement('div');
  root.id = 'auto-profile-overlay';
  const status = document.createElement('div');
  status.className = 'ap-status';
  status.textContent = '🛰️ AutoProfileSweep starting…';
  root.appendChild(status);
  const pre = document.createElement('pre');
  pre.className = 'ap-pre';
  pre.style.display = 'none';
  root.appendChild(pre);
  const row = document.createElement('div');
  row.className = 'ap-row';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'ap-copy';
  copyBtn.textContent = '📋 Copy JSON';
  copyBtn.style.display = 'none';
  const downloadBtn = document.createElement('a');
  downloadBtn.className = 'ap-download';
  downloadBtn.textContent = '⬇ Download .json';
  downloadBtn.style.display = 'none';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ap-close';
  closeBtn.textContent = '✕ Close';
  closeBtn.style.display = 'none';
  row.appendChild(copyBtn);
  row.appendChild(downloadBtn);
  row.appendChild(closeBtn);
  root.appendChild(row);
  const hint = document.createElement('div');
  hint.className = 'ap-hint';
  hint.textContent = 'Auto-download may be blocked. Use the buttons above (each is a user gesture so clipboard / download will work).';
  hint.style.display = 'none';
  root.appendChild(hint);
  document.body.appendChild(root);
  return { root, status, pre, copyBtn, closeBtn, downloadBtn };
}

/**
 * Orchestrator. Construct once with refs; call `start()` to begin the sweep
 * (a no-op if `?autoProfile=1` is not set).
 */
export class AutoProfileSweep {
  /**
   * @param {object} refs
   * @param {any} refs.sceneManager — must expose `applyTierWithOverrides`,
   *                                  `currentTier`, `gpuProbe`, `renderer`.
   * @param {any} [refs.earth]
   * @param {any} [refs.gameState] — singleton from [`GameState.js`](js/core/GameState.js:1)
   */
  constructor(refs) {
    this._refs = refs || {};
    this._running = false;
    this._aborted = false;
    /** @type {Array<object>} */
    this._results = [];
  }

  /**
   * Begin the sweep. No-op if `?autoProfile=1` is not active or if a sweep
   * is already in flight.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!profileFlags.autoProfile) return;
    if (this._running) {
      console.warn('[AutoProfile] already running. Ignoring duplicate start()');
      return;
    }
    const sm = this._refs.sceneManager;
    if (!sm || typeof sm.applyTierWithOverrides !== 'function') {
      console.error('[AutoProfile] aborted: sceneManager.applyTierWithOverrides missing');
      return;
    }
    const probe = sm.gpuProbe;
    if (!probe || !probe.isSupported) {
      console.warn('[AutoProfile] EXT_disjoint_timer_query_webgl2 unavailable. Sweep would record null medians; aborting.');
      return;
    }
    // Defensive: if the startup probe completion path disabled the probe
    // (older builds, or a tier-downshift code path that ran before this
    // sweep started), force it back on so begin/end calls fire each render.
    // main.js's per-frame `probe.poll()` already runs whenever gpuProbeEnabled
    // is true, so this single flip restores the full measurement loop.
    if (!sm.gpuProbeEnabled) {
      console.info('[AutoProfile] re-enabling sceneManager.gpuProbeEnabled (was off)');
      sm.gpuProbeEnabled = true;
    }

    // Warn but proceed if user combined autoProfile with conflicting disable
    // flags — the sweep wins on a per-config basis but it's confusing.
    const conflicting = [
      'disableEarthNoise', 'disableBloom', 'disableSMAA',
      'disableClouds', 'disableAtmosphere',
    ].filter((k) => profileFlags[k] === true);
    if (conflicting.length > 0) {
      console.warn(
        `[AutoProfile] note: URL has both ?autoProfile=1 and ${conflicting.join(', ')}=1; ` +
        `sweep overrides will set these per-config, so the boot-time flags only matter for the "baseline" row.`,
      );
    }
    if (profileFlags.msaaOverride !== null || profileFlags.pixelRatioOverride !== null) {
      console.warn('[AutoProfile] note: ?msaa= / ?pixelRatio= URL flags will be overridden by the sweep configs.');
    }

    this._running = true;
    const sessionStart = Date.now();
    const initialState = readGameState(this._refs);
    console.info(`[AutoProfile] starting sweep. State=${initialState}, tier=${sm.currentTier}, configs=${SWEEP_CONFIGS.length}`);

    // Install the in-page overlay so the user can SEE progress + the final
    // JSON without needing DevTools. Browsers silently block auto-downloads
    // and clipboard writes from rAF chains; the overlay's buttons fire from
    // a real user gesture so they Just Work.
    const overlay = (typeof document !== 'undefined') ? ensureOverlay() : null;
    if (overlay) {
      overlay.status.textContent =
        `🛰️ AutoProfileSweep settling… (state=${initialState}, tier=${sm.currentTier})`;
    }

    // Settle the very first time so any post-load jank doesn't poison the
    // baseline measurement.
    await waitFrames(60);

    for (let i = 0; i < SWEEP_CONFIGS.length; i++) {
      const cfg = SWEEP_CONFIGS[i];
      if (this._aborted) break;
      if (overlay) {
        overlay.status.textContent =
          `🛰️ Profiling ${i + 1}/${SWEEP_CONFIGS.length}: ${cfg.id}`;
      }
      try {
        await this._captureConfig(cfg);
      } catch (e) {
        console.error(`[AutoProfile] config "${cfg.id}" threw:`, e);
        this._results.push({
          configId: cfg.id,
          error: String(e?.message || e),
        });
      }
    }

    // Restore baseline so the user can keep playing without the last sweep
    // config persisting.
    try {
      sm.applyTierWithOverrides({});
    } catch (e) {
      console.warn('[AutoProfile] failed to restore baseline:', e);
    }

    this._running = false;
    const wallMs = Date.now() - sessionStart;
    this._dumpResults(initialState, wallMs, overlay);
  }

  /**
   * Abort an in-flight sweep. The current config's measurement is discarded.
   */
  abort() {
    this._aborted = true;
  }

  /**
   * Apply one config, wait for samples, record a snapshot.
   *
   * @private
   * @param {{ id: string, overrides: object }} cfg
   * @returns {Promise<void>}
   */
  async _captureConfig(cfg) {
    const sm = this._refs.sceneManager;
    const probe = sm.gpuProbe;

    // 1. Apply.
    sm.applyTierWithOverrides(cfg.overrides);

    // 2. Settle — drop driver shader-compile + composer-rebuild stutter.
    await waitFrames(SETTLE_FRAMES);

    // 3. Reset sample windows. Stragglers from the previous config that get
    //    polled in over the next 1–2 frames will skew the median by <2 %.
    probe.resetSamples();

    // 4. Wait for fresh samples.
    const ok = await waitForSamples(probe, SAMPLES_PER_CONFIG, MAX_FRAMES_PER_CONFIG);

    // 5. Capture.
    const info = sm.renderer?.info || null;
    const gameState = readGameState(this._refs);
    const snapshot = {
      configId: cfg.id,
      gameState,
      tier: sm.currentTier,
      timedOut: !ok,
      frameMs: this._safeMedian(probe),
      sampleCount: this._safeSampleCount(probe),
      perPass: readChannels(probe),
      render: info ? {
        calls: info.render?.calls ?? null,
        triangles: info.render?.triangles ?? null,
        points: info.render?.points ?? null,
        lines: info.render?.lines ?? null,
      } : null,
      memory: info ? {
        geometries: info.memory?.geometries ?? null,
        textures: info.memory?.textures ?? null,
      } : null,
      ts: new Date().toISOString(),
    };
    this._results.push(snapshot);
    console.info(
      `[AutoProfile] ${cfg.id.padEnd(20)} ${snapshot.frameMs ?? '--'} ms  ` +
      `(n=${snapshot.sampleCount}${snapshot.timedOut ? ', TIMEOUT' : ''})  ` +
      `calls=${snapshot.render?.calls ?? '?'}`,
    );
  }

  /** @private */
  _safeMedian(probe) {
    try {
      const m = probe.getMedianMs();
      return Number.isFinite(m) ? Number(m.toFixed(3)) : null;
    } catch (_e) { return null; }
  }
  /** @private */
  _safeSampleCount(probe) {
    try { return probe.getSampleCount() | 0; } catch (_e) { return 0; }
  }

  /**
   * Emit the final JSON blob to console + window global + overlay modal +
   * (best-effort) downloaded file.
   *
   * @private
   * @param {string} state
   * @param {number} wallMs
   * @param {ReturnType<typeof ensureOverlay>|null} overlay
   */
  _dumpResults(state, wallMs, overlay) {
    const blob = {
      timestamp: new Date().toISOString(),
      gameState: state,
      tier: this._refs.sceneManager?.currentTier || 'UNKNOWN',
      wallClockMs: wallMs,
      configCount: this._results.length,
      results: this._results,
      deltasMs: this._computeDeltas(),
    };
    const text = JSON.stringify(blob, null, 2);

    console.log('[AutoProfile] === SWEEP COMPLETE ===');
    try { console.log(text); } catch (_e) {}

    if (typeof window !== 'undefined') {
      try { window.__autoProfileResult = blob; } catch (_e) {}
    }

    // Best-effort auto-download. Browsers may silently block this when the
    // anchor click originates inside a rAF chain (no user gesture). The
    // overlay's Copy / Download buttons below are the reliable path.
    let dataUrl = null;
    let downloadName = `gpu-profile-${state}-${Date.now()}.json`;
    try {
      dataUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = downloadName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch (_e) {}
      }, 250);
    } catch (e) {
      console.warn('[AutoProfile] auto-download failed (browser likely blocked it):', e);
    }

    // PRIMARY delivery channel — the in-page overlay. Buttons here all run
    // inside a real user gesture so clipboard + download work.
    if (overlay) {
      overlay.status.textContent =
        `✓ SWEEP COMPLETE. State=${state}, tier=${blob.tier}, ${wallMs} ms, ${this._results.length} configs`;
      overlay.pre.textContent = text;
      overlay.pre.style.display = 'block';
      overlay.copyBtn.style.display = 'inline-block';
      overlay.closeBtn.style.display = 'inline-block';
      const hint = overlay.root.querySelector('.ap-hint');
      if (hint) hint.style.display = 'block';
      if (dataUrl) {
        overlay.downloadBtn.href = dataUrl;
        overlay.downloadBtn.download = downloadName;
        overlay.downloadBtn.style.display = 'inline-block';
      }
      overlay.copyBtn.onclick = () => {
        try {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(
              () => { overlay.copyBtn.textContent = '✓ Copied'; },
              () => { overlay.copyBtn.textContent = '✗ blocked. Select & Cmd-C'; },
            );
          } else {
            const r = document.createRange();
            r.selectNodeContents(overlay.pre);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
            const ok = document.execCommand('copy');
            overlay.copyBtn.textContent = ok ? '✓ Copied' : '✗ select & Cmd-C';
          }
        } catch (e) {
          overlay.copyBtn.textContent = '✗ blocked. Select & Cmd-C';
          console.warn('[AutoProfile] copy failed:', e);
        }
      };
      overlay.closeBtn.onclick = () => {
        try { overlay.root.parentNode?.removeChild(overlay.root); } catch (_e) {}
        if (dataUrl) { try { URL.revokeObjectURL(dataUrl); } catch (_e) {} }
      };
    }

    console.info('[AutoProfile] Result is in the overlay modal at the TOP of the page (or window.__autoProfileResult).');
  }

  /**
   * Δ-vs-baseline table: every non-baseline config's `frameMs` minus the
   * baseline's. Positive Δ = savings. Returns null entries when either side
   * is null (e.g. timeout).
   *
   * @private
   */
  _computeDeltas() {
    const baseline = this._results.find((r) => r.configId === 'baseline');
    const baseMs = baseline ? baseline.frameMs : null;
    /** @type {Record<string, number|null>} */
    const out = {};
    for (const r of this._results) {
      if (r.configId === 'baseline') continue;
      if (baseMs == null || r.frameMs == null) {
        out[r.configId] = null;
      } else {
        out[r.configId] = Number((baseMs - r.frameMs).toFixed(3));
      }
    }
    return out;
  }
}

export default AutoProfileSweep;
