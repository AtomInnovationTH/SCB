/**
 * PerfReportOverlay.js — Sprint 2 / Phase A
 *
 * Fixed-position top-right diagnostic panel activated by `?perfReport=1`.
 * Surfaces every "🟡" datum from [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1)
 * (initial-tier reason, GPU median ms, live FPS + p99 frame time, draw-call
 * counters, JS heap, TimerManager active count, alive debris) so the user can
 * capture a single browser session and paste the result into a follow-up issue.
 *
 * The overlay updates at 1 Hz to stay out of the hot path. A "📋 COPY SNAPSHOT"
 * button serializes the current state as JSON to the clipboard.
 *
 * Wired from [`main.js`](js/main.js:1) when the URL flag is set. Pure DOM —
 * no THREE imports, no game-state coupling beyond the refs handed in via
 * [`PerfReportOverlay.attach()`](js/ui/PerfReportOverlay.js:1).
 *
 * @module ui/PerfReportOverlay
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import timerManager from '../systems/TimerManager.js';

const STYLE_ID = 'perf-report-overlay-style';
const ROOT_ID = 'perf-report-overlay';

const CSS = `
#${ROOT_ID} {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 99999;
  width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.82);
  color: #b8f6c4;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.45;
  border: 1px solid #2d5a3a;
  border-radius: 4px;
  pointer-events: auto;
  user-select: text;
}
#${ROOT_ID} h4 {
  margin: 0 0 6px;
  font-size: 11px;
  color: #5dffaf;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-bottom: 1px solid #2d5a3a;
  padding-bottom: 3px;
}
#${ROOT_ID} table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 4px;
}
#${ROOT_ID} td {
  padding: 1px 4px 1px 0;
  vertical-align: top;
  white-space: nowrap;
}
#${ROOT_ID} td.k { color: #7fcc8f; width: 42%; }
#${ROOT_ID} td.v { color: #d6ffd9; text-align: right; }
#${ROOT_ID} button {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 5px 6px;
  font: inherit;
  color: #000;
  background: #5dffaf;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}
#${ROOT_ID} button:hover { background: #b8f6c4; }
#${ROOT_ID} button:disabled { background: #2d5a3a; color: #5dffaf; }
#${ROOT_ID} .status { font-size: 10px; color: #7fcc8f; margin-top: 4px; }
`;

/**
 * Module-scoped boot snapshot — captured the first time
 * [`PerfReportOverlay.attach()`](js/ui/PerfReportOverlay.js:1) runs so it
 * survives later mutations (renderer.info accumulates over time).
 * @type {object|null}
 */
let _bootSnapshot = null;

/**
 * Most recent reason for a tier change, tracked via `Events.PERF_TIER_CHANGED`.
 * Defaults to the initial-detection reason.
 * @type {{ tier: string, reason: string }}
 */
let _tierState = { tier: 'UNKNOWN', reason: 'initial-detection' };

/**
 * Format a number with N decimals, or '--' if not finite.
 * @param {number} n
 * @param {number} [digits=1]
 * @returns {string}
 */
function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

/**
 * Format a byte count as MB.
 * @param {number} bytes
 * @returns {string}
 */
function fmtMB(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compute median of a numeric array (non-mutating).
 * @param {number[]} arr
 * @returns {number}
 */
function median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute the value at the given percentile (0..1) of a numeric array.
 * @param {number[]} arr
 * @param {number} p — e.g. 0.99 for p99
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

export class PerfReportOverlay {
  constructor() {
    /** @type {HTMLDivElement|null} */
    this._root = null;
    /** @type {HTMLTableElement|null} */
    this._table = null;
    /** @type {HTMLButtonElement|null} */
    this._copyBtn = null;
    /** @type {HTMLDivElement|null} */
    this._status = null;

    /**
     * Refs to live game subsystems — supplied by
     * [`PerfReportOverlay.attach()`](js/ui/PerfReportOverlay.js:1).
     * @type {{ sceneManager: any, debrisField: any, fpsHistory: number[] }}
     */
    this._refs = { sceneManager: null, debrisField: null, fpsHistory: null };

    /**
     * Sliding 5-s window of frame times (ms) for p99 calculation.
     * Sized for ~5 s @ 120 fps = 600 samples; trimmed on every push.
     * @type {number[]}
     */
    this._frameTimes = [];
    this._MAX_FT_SAMPLES = 600;

    /** @type {number} performance.now() of the previous frame */
    this._lastTs = 0;

    /** @type {number} interval id (browser handle) for the 1 Hz refresh */
    this._refreshHandle = null;

    /** @type {Function|null} unsubscribe handler for tier-change events */
    this._unsubTier = null;

    /** @type {object|null} cached latest snapshot for COPY */
    this._latest = null;
  }

  /**
   * Attach the overlay to the document. Idempotent.
   *
   * @param {object} refs
   * @param {any} refs.sceneManager — exposes `currentTier`, `gpuProbe`, `renderer`
   * @param {any} refs.debrisField — exposes `debrisList`
   * @param {number[]} refs.fpsHistory — the same rolling buffer used by [`runtimeAdapt`](js/systems/QualityManager.js:116)
   * @param {object} [bootInfo] — one-shot boot diagnostics (see [`captureBootInfo`](js/ui/PerfReportOverlay.js:1))
   */
  attach(refs, bootInfo) {
    if (this._root) return; // idempotent

    this._refs = {
      sceneManager: refs?.sceneManager || null,
      debrisField: refs?.debrisField || null,
      fpsHistory: Array.isArray(refs?.fpsHistory) ? refs.fpsHistory : [],
    };
    if (bootInfo) _bootSnapshot = bootInfo;
    if (this._refs.sceneManager?.currentTier) {
      _tierState = {
        tier: this._refs.sceneManager.currentTier,
        reason: bootInfo?.initialTierReason || 'initial-detection',
      };
    }

    this._installStyle();
    this._buildDOM();
    this._subscribe();
    this._tick(); // first paint immediately
    // 1 Hz refresh — well off the hot path.
    this._refreshHandle = setInterval(() => this._tick(), 1000);

    // Frame-time sampler: we listen on rAF outside the game loop so we don't
    // perturb timing if the overlay is later toggled mid-session.
    const sampleLoop = (ts) => {
      if (!this._root) return; // detached
      if (this._lastTs > 0) {
        const dt = ts - this._lastTs;
        if (Number.isFinite(dt) && dt > 0 && dt < 1000) {
          this._frameTimes.push(dt);
          if (this._frameTimes.length > this._MAX_FT_SAMPLES) this._frameTimes.shift();
        }
      }
      this._lastTs = ts;
      requestAnimationFrame(sampleLoop);
    };
    requestAnimationFrame(sampleLoop);
  }

  /** Remove the overlay from the DOM and stop the refresh interval. */
  detach() {
    if (this._refreshHandle != null) {
      clearInterval(this._refreshHandle);
      this._refreshHandle = null;
    }
    if (this._unsubTier) {
      try { this._unsubTier(); } catch (_e) { /* noop */ }
      this._unsubTier = null;
    }
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._table = null;
    this._copyBtn = null;
  }

  _installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  _buildDOM() {
    const root = document.createElement('div');
    root.id = ROOT_ID;

    const h = document.createElement('h4');
    h.textContent = '🟢 perf report. 1 Hz';
    root.appendChild(h);

    const table = document.createElement('table');
    root.appendChild(table);
    this._table = table;

    const btn = document.createElement('button');
    btn.textContent = '📋 COPY SNAPSHOT';
    btn.addEventListener('click', () => this._copy());
    root.appendChild(btn);
    this._copyBtn = btn;

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = 'snapshot key: timestamp + tier + fps + draw + heap + boot';
    root.appendChild(status);
    this._status = status;

    document.body.appendChild(root);
    this._root = root;
  }

  _subscribe() {
    // Track tier-change reason. The bus fires with { from, to, reason }.
    const handler = (payload) => {
      if (!payload || !payload.to) return;
      _tierState = { tier: payload.to, reason: payload.reason || 'unknown' };
    };
    try {
      eventBus.on(Events.PERF_TIER_CHANGED, handler);
      this._unsubTier = () => { try { eventBus.off(Events.PERF_TIER_CHANGED, handler); } catch (_e) {} };
    } catch (_e) {
      // EventBus shape may differ across builds — best effort.
      this._unsubTier = null;
    }
  }

  /**
   * Recompute the latest snapshot and paint the DOM.
   * Cheap: median + percentile over <= 600 samples, plus a single
   * `renderer.info` read.
   */
  _tick() {
    const snap = this._buildSnapshot();
    this._latest = snap;
    this._paint(snap);
  }

  /**
   * Build the current state JSON. Pure read.
   * @returns {object}
   */
  _buildSnapshot() {
    const sm = this._refs.sceneManager;
    const renderer = sm?.renderer || null;
    const info = renderer ? renderer.info : null;

    // FPS — median of the shared rolling buffer in main.js.
    const fps = this._refs.fpsHistory;
    const fpsMed = median(fps);

    // p99 frame time (ms) from our own 5-s sliding window.
    const frameP99 = percentile(this._frameTimes, 0.99);
    const frameMed = median(this._frameTimes);

    // GPU probe median (ms). NaN before window completes.
    let gpuMedianMs = NaN;
    let gpuSamples = 0;
    /** @type {Record<string, { medianMs: number|null, samples: number }>} */
    const perPass = {};
    if (sm?.gpuProbe?.isSupported) {
      try {
        gpuMedianMs = sm.gpuProbe.getMedianMs();
        gpuSamples = sm.gpuProbe.getSampleCount();
      } catch (_e) { /* probe disposed */ }
      // Sprint 3 GPU profiling — surface per-pass channel medians when
      // [`?profilePasses=1`](js/core/ProfileFlags.js:1) is active. Empty
      // object in normal sessions (the channel API stays untouched).
      try {
        const names = (typeof sm.gpuProbe.getChannelNames === 'function')
          ? sm.gpuProbe.getChannelNames()
          : [];
        for (const name of names) {
          const m = sm.gpuProbe.getChannelMedianMs(name);
          const n = sm.gpuProbe.getChannelSampleCount(name);
          perPass[name] = {
            medianMs: Number.isFinite(m) ? Number(m.toFixed(3)) : null,
            samples: Number.isFinite(n) ? n : 0,
          };
        }
      } catch (_e) { /* channel API may be absent in older builds */ }
    }

    // JS heap (Chrome / Edge only).
    let heapUsed = NaN, heapTotal = NaN, heapLimit = NaN;
    if (typeof performance !== 'undefined' && performance.memory) {
      heapUsed = performance.memory.usedJSHeapSize;
      heapTotal = performance.memory.totalJSHeapSize;
      heapLimit = performance.memory.jsHeapSizeLimit;
    }

    // Alive debris.
    let aliveDebris = NaN;
    if (this._refs.debrisField?.debrisList) {
      // Fast count — avoid Array.filter allocation.
      let c = 0;
      const list = this._refs.debrisField.debrisList;
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].alive) c++;
      aliveDebris = c;
    }

    // Timer manager.
    let activeTimers = NaN;
    try { activeTimers = timerManager.activeCount(); } catch (_e) {}

    return {
      timestamp: new Date().toISOString(),
      tier: {
        current: sm?.currentTier || 'UNKNOWN',
        lastChangeReason: _tierState.reason,
      },
      gpu: {
        medianMs: Number.isFinite(gpuMedianMs) ? Number(gpuMedianMs.toFixed(3)) : null,
        sampleCount: gpuSamples,
        supported: !!sm?.gpuProbe?.isSupported,
        // Sprint 3 GPU profiling — empty object unless `?profilePasses=1` is set.
        perPass,
      },
      fps: {
        median: Number.isFinite(fpsMed) ? Number(fpsMed.toFixed(2)) : null,
        historyLen: fps.length,
        frameMs: {
          median: Number.isFinite(frameMed) ? Number(frameMed.toFixed(2)) : null,
          p99: Number.isFinite(frameP99) ? Number(frameP99.toFixed(2)) : null,
          windowSamples: this._frameTimes.length,
        },
      },
      render: info ? {
        calls: info.render?.calls || 0,
        triangles: info.render?.triangles || 0,
        points: info.render?.points || 0,
        lines: info.render?.lines || 0,
        geometries: info.memory?.geometries || 0,
        textures: info.memory?.textures || 0,
      } : null,
      heap: {
        usedBytes: Number.isFinite(heapUsed) ? heapUsed : null,
        totalBytes: Number.isFinite(heapTotal) ? heapTotal : null,
        limitBytes: Number.isFinite(heapLimit) ? heapLimit : null,
      },
      activeTimers: Number.isFinite(activeTimers) ? activeTimers : null,
      aliveDebris: Number.isFinite(aliveDebris) ? aliveDebris : null,
      boot: _bootSnapshot,
    };
  }

  /**
   * Render the snapshot into the table. Reuses rows.
   * @param {object} s
   */
  _paint(s) {
    if (!this._table) return;
    const rows = [
      ['Tier (current / reason)', `${s.tier.current} / ${s.tier.lastChangeReason}`],
      ['GPU median ms (samples)', s.gpu.supported
        ? `${s.gpu.medianMs ?? '--'} (${s.gpu.sampleCount})`
        : 'unsupported'],
      ['FPS median', `${s.fps.median ?? '--'} (n=${s.fps.historyLen})`],
      ['Frame ms median / p99', `${s.fps.frameMs.median ?? '--'} / ${s.fps.frameMs.p99 ?? '--'}`],
      ['Draw calls', s.render ? String(s.render.calls) : '--'],
      ['Triangles', s.render ? s.render.triangles.toLocaleString() : '--'],
      ['Points / Lines', s.render ? `${s.render.points} / ${s.render.lines}` : '--'],
      ['Heap used / total', s.heap.usedBytes != null
        ? `${fmtMB(s.heap.usedBytes)} / ${fmtMB(s.heap.totalBytes)}`
        : 'n/a (non-Chromium)'],
      ['Active timers', s.activeTimers != null ? String(s.activeTimers) : '--'],
      ['Alive debris', s.aliveDebris != null ? String(s.aliveDebris) : '--'],
    ];
    // Sprint 3 GPU profiling — per-pass median rows (only appear when
    // `?profilePasses=1` is set and the channels have collected samples).
    const passKeys = s.gpu?.perPass ? Object.keys(s.gpu.perPass) : [];
    if (passKeys.length > 0) {
      rows.push(['─── per-pass GPU ───', '']);
      // Stable ordering for readability — render → bloom → smaa → fxaa → rest.
      const order = ['render', 'bloom', 'smaa', 'fxaa'];
      const ordered = order.filter((k) => passKeys.includes(k));
      const extras = passKeys.filter((k) => !order.includes(k)).sort();
      for (const k of [...ordered, ...extras]) {
        const cell = s.gpu.perPass[k];
        rows.push([`pass: ${k}`, `${cell.medianMs ?? '--'} ms (n=${cell.samples})`]);
      }
    }
    if (s.boot) {
      rows.push(['─── boot ───', '']);
      rows.push(['SW state', s.boot.swState || 'none']);
      rows.push(['AVIF supported', String(s.boot.avifSupported)]);
      rows.push(['maxTex / dpr', `${s.boot.maxTextureSize || '?'} / ${fmt(s.boot.devicePixelRatio, 2)}`]);
      rows.push(['Apple GPU / mem GB', `${s.boot.isAppleGPU ? 'yes' : 'no'} / ${s.boot.deviceMemoryGB ?? '?'}`]);
    }

    // Reuse rows when possible to avoid layout thrash.
    const t = this._table;
    while (t.rows.length > rows.length) t.deleteRow(t.rows.length - 1);
    for (let i = 0; i < rows.length; i++) {
      const [k, v] = rows[i];
      let row = t.rows[i];
      if (!row) {
        row = t.insertRow(i);
        row.insertCell(0).className = 'k';
        row.insertCell(1).className = 'v';
      }
      row.cells[0].textContent = k;
      row.cells[1].textContent = String(v);
    }
  }

  /** Copy the latest snapshot JSON to the clipboard. */
  _copy() {
    if (!this._latest) return;
    const text = JSON.stringify(this._latest, null, 2);
    const finish = (ok, label) => {
      if (!this._status) return;
      this._status.textContent = ok ? `✓ copied (${label})` : `✗ copy failed (${label})`;
      // Also log so the user can grab from devtools if clipboard is blocked.
      try { console.log('[PerfReport] snapshot:\n' + text); } catch (_e) {}
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => finish(true, 'clipboard'),
          (err) => {
            console.warn('[PerfReport] clipboard.writeText rejected:', err);
            finish(false, 'see console');
          }
        );
        return;
      }
    } catch (_e) {
      // Fall through to legacy path
    }
    // Legacy fallback: textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      finish(ok, 'execCommand');
    } catch (_e) {
      finish(false, 'see console');
    }
  }
}

/**
 * Build a one-shot boot snapshot covering SW status, AVIF support, and the
 * capability inputs that drove `selectInitialTier`. Mirrors the inputs in
 * [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:107).
 *
 * @param {object} ctx
 * @param {any} ctx.sceneManager
 * @param {boolean} ctx.avifSupported
 * @param {string} [ctx.initialTierReason]
 * @returns {object}
 */
export function captureBootInfo(ctx) {
  const sm = ctx?.sceneManager;
  const renderer = sm?.renderer;
  const caps = renderer?.capabilities;

  // SW status — best-effort
  let swState = 'none';
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      swState = navigator.serviceWorker.controller.state || 'active';
    } else if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      swState = 'no-controller';
    }
  } catch (_e) { /* noop */ }

  // Apple GPU detect (best effort — UNMASKED_RENDERER_WEBGL may be hidden).
  let isAppleGPU = false;
  let unmaskedRenderer = '';
  try {
    const gl = renderer?.getContext?.();
    const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
    if (dbg) {
      unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      isAppleGPU = /Apple/i.test(unmaskedRenderer);
    }
  } catch (_e) { /* noop */ }

  return {
    swState,
    avifSupported: ctx?.avifSupported === true,
    maxTextureSize: caps?.maxTextureSize ?? null,
    devicePixelRatio: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    deviceMemoryGB: (typeof navigator !== 'undefined' && navigator.deviceMemory) || null,
    isAppleGPU,
    unmaskedRenderer: unmaskedRenderer || null,
    isWebGL2: !!caps?.isWebGL2,
    maxAnisotropy: (() => { try { return caps?.getMaxAnisotropy?.() ?? null; } catch (_e) { return null; } })(),
    pickedTier: sm?.currentTier || null,
    tierConfig: sm?.tierConfig ? {
      pixelRatioCap: sm.tierConfig.pixelRatioCap,
      msaaSamples: sm.tierConfig.msaaSamples,
      enableBloom: sm.tierConfig.enableBloom,
      enableSMAA: sm.tierConfig.enableSMAA,
      useFXAAFallback: sm.tierConfig.useFXAAFallback,
    } : null,
    initialTierReason: ctx?.initialTierReason || 'capability-detect',
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    fpsHistorySize: Constants?.PERF?.FPS_HISTORY_SIZE ?? null,
    adaptFpsThreshold: Constants?.PERF?.ADAPT_FPS_THRESHOLD ?? null,
  };
}

/**
 * Singleton — wire-once style mirrored after AudioSystem / TimerManager.
 * Activated by [`main.js`](js/main.js:1) when `?perfReport=1` is set.
 */
const perfReportOverlay = new PerfReportOverlay();
export default perfReportOverlay;
