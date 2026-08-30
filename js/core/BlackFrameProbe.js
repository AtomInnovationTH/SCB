/**
 * BlackFrameProbe.js — in-page black-flicker triage instrument (dev-only).
 *
 * CONTEXT (black-flicker triage, 2026-08): on ladder floors F6/F7 a large black
 * rectangle intermittently covers most of the WebGL canvas on the user's
 * machine (Brave / ANGLE-Metal / dpr2 / 120 Hz). It flickers frame-to-frame,
 * DOM renders fine on top, and ANY window resize heals it instantly. It has
 * NEVER reproduced headless (SwiftShader renders F6/F7 flawlessly), and the
 * user is done running console snippets — so this probe is fully self-serve:
 * add `?bfp=2` to the URL and play; it renders its own verdict badge.
 *
 * THE ONE QUESTION IT ANSWERS: when the screen shows black, is the black
 * actually IN the GL drawing buffer (JS/GL-level bug: pass sequence, dead
 * targets, scissor/viewport leak, dead textures), or is the buffer CORRECT and
 * only the PRESENTED CALayer black (ANGLE-Metal partial-present family)?
 *
 * How: after the composer finishes each frame (same rAF task, before present —
 * legal regardless of preserveDrawingBuffer):
 *   1. mode 2 paints a small GREEN REFERENCE SWATCH into the bottom-left
 *      corner of the DEFAULT framebuffer via a scissored clear (three.js state
 *      APIs only, saved/restored — the renderer's cached GL state stays true);
 *   2. mode 2 reads back tiny pixel patches (center, left/right strips, the
 *      swatch) every READ_EVERY frames and shows their luminance in a DOM
 *      badge (DOM provably renders above the artifact);
 *   3. every CHECK_EVERY frames it samples GL/renderer state: context-lost,
 *      drawingBuffer-vs-canvas size, end-of-frame viewport/scissor, composer +
 *      bloom render-target GL liveness, Earth day/night/cloud texture GL
 *      liveness, info.memory counts, tier/near/far/floor — and console.warns
 *      one rate-limited line whenever any of it turns anomalous.
 *
 * Verdict table for a visible black episode (user just reads the badge):
 *   - badge `sw` high + green corner swatch NOT visible under the black
 *       → presentation path convicted (H2: ANGLE-Metal partial present).
 *   - badge `sw` high + swatch visible + `c/l/r` ≈ 0 on a lit view
 *       → composer output really is black (H1/H3/state leak) — read the
 *         alerts field for which subsystem (rt/tex/sciss/vp/nf).
 *   - badge `sw` ≈ 0 → even a direct scissored clear can't reach the buffer
 *       → drawable/context-level failure (check ctx flag + buffer sizes).
 *
 * Modes (`?bfp=N`, parse-once DevShotGate idiom, default OFF, ships dark):
 *   1 — state sampling + badge + transition warns only (zero readbacks: use if
 *       the mere readback perturbs the bug — that outcome itself implicates
 *       the present path, same family as the `?shot=1` discriminator).
 *   2 — mode 1 + reference swatch + pixel readbacks (the full verdict).
 *
 * Zero cost when off (installer returns null; one `if` per frame in the loop).
 * Never enable by default; never ship URLs with it. tmp/-grade tool that lives
 * in js/ only because it must be importable by main.js without a build step.
 *
 * @module core/BlackFrameProbe
 */

import * as THREE from 'three';

/** State-sample cadence in frames (~8 Hz at 120 Hz). */
const CHECK_EVERY = 15;
/** Pixel-readback cadence in frames (~4 Hz at 120 Hz; keeps sync stalls rare). */
const READ_EVERY = 30;
/** Reference swatch size in DEVICE pixels (scissored clear, bottom-left). */
const SWATCH_PX = 14;
/** Sampled patch size in device pixels (patch mean luma is the signal). */
const PATCH = 4;
/** Below this mean luma a patch counts as "black" (8-bit noise floor). */
const BLACK_LUMA = 0.004;
/** Min ms between console.warn lines (ctx-lost/tier/composer bypass this). */
const WARN_MIN_MS = 500;
/**
 * rAF gap / visible-tab starvation threshold (ms). Must sit ABOVE the §14.1-K
 * blur keepalive cadence (main.js re-presents every ~2000 ms while the window
 * is blurred) so deliberate keepalive frames are not logged as starvation;
 * anything longer than this while 'visible' is a real frame-delivery failure.
 */
const STARVE_MS = 2600;

/**
 * Ladder floor render-block pairs pinned by test-FloorContract — used only to
 * flag the "matches NO contract" mixed near/far state seen once in the field.
 * (Deliberately not imported from FloorContract: dev probe, no dep creep.)
 */
const FLOOR_CLIP = { 6: { near: 0.05, far: 500 }, 7: { near: 0.5, far: 2000 } };

/** @returns {0|1|2} parsed `?bfp=` mode (0 = off) */
function parseMode() {
  try {
    if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') return 0;
    const raw = new URLSearchParams(window.location.search).get('bfp');
    if (raw === '1') return 1;
    if (raw === '2') return 2;
    return 0;
  } catch (_e) {
    return 0;
  }
}

/**
 * Install the probe. Call once after SceneManager (+ Earth) exist; returns
 * null when `?bfp=` is absent so the per-frame hook stays a single falsy check.
 *
 * @param {{ sceneManager: object, earth?: object }} deps
 * @returns {{ tick: function(number): void }|null}
 */
export function installBlackFrameProbe({ sceneManager, earth } = {}) {
  const mode = parseMode();
  if (!mode || !sceneManager || typeof document === 'undefined' || !document.body) return null;

  const renderer = sceneManager.renderer;
  const gl = renderer.getContext();
  const canvas = renderer.domElement;

  // --- Context-loss tripwires (three logs these too, but we badge + dump) ---
  let ctxLost = false;
  let ctxEvents = 0;
  try {
    canvas.addEventListener('webglcontextlost', () => { ctxLost = true; ctxEvents++; }, false);
    canvas.addEventListener('webglcontextrestored', () => { ctxLost = false; ctxEvents++; }, false);
  } catch (_e) { /* non-DOM canvas — badge still works off gl.isContextLost() */ }

  // --- Badge (DOM renders above the artifact per the field reports) ---
  const badge = document.createElement('div');
  badge.id = 'bfp-badge';
  badge.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:4px', 'transform:translateX(-50%)',
    'z-index:2147483647', 'pointer-events:auto', 'cursor:pointer',
    'font:11px/1.35 ui-monospace,Menlo,monospace', 'white-space:pre',
    'color:#8f8', 'background:rgba(0,0,0,0.62)', 'padding:2px 8px',
    'border-radius:4px', 'border:1px solid rgba(140,255,140,0.35)',
  ].join(';');
  badge.title = 'BFP probe — click to save the full diagnostic dump (bfp-dump-*.json in Downloads)';
  badge.textContent = `BFP mode ${mode} armed`;
  document.body.appendChild(badge);

  // --- Preallocated scratch (no per-frame allocs) ---
  const pxBuf = new Uint8Array(PATCH * PATCH * 4);
  const savedScissor = new THREE.Vector4();
  const savedViewport = new THREE.Vector4();
  const savedClearColor = new THREE.Color();

  // --- Probe state ---
  let frame = 0;
  let lastTickTs = 0;
  let fpsEst = 0;
  let composerRef = sceneManager.composer;
  let composerGen = 0;
  let lastMemTex = -1;
  let memTexHighWater = -1;
  let lastNear = NaN;
  let lastFar = NaN;
  let lastAlerts = '';
  let lastWarnAt = 0;
  let anomalyLatchUntil = 0;
  const lumas = { c: -1, l: -1, r: -1, sw: -1 }; // -1 = not sampled yet
  /** Earth textures that have EVER been GL-live — dead-after-live detector. */
  const texWasLive = { day: false, night: false, clouds: false };
  /**
   * Composer/bloom RTs that have EVER been GL-live THIS composer generation.
   * Lazily-initialized targets can be legitimately unused by a tier's pass
   * chain (e.g. LOW = [render→rt2, output→screen] never binds renderTarget1),
   * so only dead-AFTER-live is an anomaly. Reset on composer rebuild.
   */
  const rtWasLive = { rt1: false, rt2: false, rtB: false };
  const ring = [];
  const alertLog = [];
  /** Capped alertLog append — soak sessions run for hours. */
  const logEvent = (e) => { alertLog.push(e); if (alertLog.length > 200) alertLog.shift(); };

  // --- Occlusion/visibility correlation (black-flicker trigger theory) ---
  // The black episodes depend on WINDOW presentation state (fullscreen /
  // DevTools toggle / resize all heal them), so record when the tab is hidden
  // or the compositor stops driving rAF (occluded windows get throttled or
  // paused on macOS; long gaps show as raf-gap events). If episodes always
  // start after a visibility/occlusion window, purged-surface pressure is the
  // trigger. `vis`/`gap` counters surface in the badge only after they fire.
  let visEvents = 0;
  let gapEvents = 0;
  let lastGapMs = 0;
  let lastVisFlipTs = -1;
  // Frame-starvation witness (the "frozen while visible" episodes): rAF stops
  // but TIMERS keep firing, so a 1 Hz interval can log the freeze from inside —
  // when it started, the visibility state during it, and (via starve-end in the
  // next tick) exactly how long the compositor starved a VISIBLE tab.
  let starveEvents = 0;
  let starveLogged = false;
  let starvedSinceTs = 0;
  // Window focus witnesses: §14.1 halts the game on window BLUR (not tab
  // hidden), which visibilitychange cannot see. Log both so dumps correlate
  // blur intervals with starvations/black episodes exactly.
  let blurEvents = 0;
  try {
    window.addEventListener('blur', () => {
      blurEvents++;
      logEvent({ ts: Math.round(performance.now()), kind: 'winfocus', state: 'blur', hasFocus: document.hasFocus() });
    }, false);
    window.addEventListener('focus', () => {
      blurEvents++;
      logEvent({ ts: Math.round(performance.now()), kind: 'winfocus', state: 'focus', hasFocus: true });
    }, false);
  } catch (_e) { /* noop */ }
  try {
    document.addEventListener('visibilitychange', () => {
      visEvents++;
      lastVisFlipTs = performance.now();
      logEvent({ ts: Math.round(lastVisFlipTs), kind: 'visibility', state: document.visibilityState });
      try { console.info(`[BFP] visibility → ${document.visibilityState} (v${visEvents})`); } catch (_e2) { /* noop */ }
    }, false);
  } catch (_e) { /* noop */ }
  try {
    setInterval(() => {
      if (lastTickTs <= 0 || starveLogged) return;
      const idleMs = performance.now() - lastTickTs;
      // Hidden tabs legitimately stop rAF; a VISIBLE tab starved beyond the
      // keepalive cadence (STARVE_MS > §14.1-K's 2 s) is the bug.
      if (idleMs > STARVE_MS && document.visibilityState === 'visible') {
        starveLogged = true;
        starvedSinceTs = lastTickTs;
        starveEvents++;
        logEvent({ ts: Math.round(performance.now()), kind: 'starve-start', idleMs: Math.round(idleMs), visState: 'visible' });
        try { console.warn(`[BFP] FRAME-STARVED while visible: no rAF for ${Math.round(idleMs)}ms (s${starveEvents})`); } catch (_e2) { /* noop */ }
      }
    }, 1000);
  } catch (_e) { /* noop */ }

  // Click-to-dump: the user is done with console work, so the badge itself
  // saves the evidence — one click downloads bfp-dump-<seconds>.json (ring +
  // alertLog + environment) to ~/Downloads where the debugging agent reads it.
  try {
    badge.addEventListener('click', () => {
      try {
        const dump = {
          mode,
          ts: Date.now(),
          ua: navigator.userAgent,
          dpr: window.devicePixelRatio,
          win: `${window.innerWidth}x${window.innerHeight}`,
          visState: document.visibilityState,
          counters: { visEvents, gapEvents, lastGapMs, starveEvents, blurEvents, ctxEvents },
          ring: ring.slice(),
          alertLog: alertLog.slice(),
        };
        const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bfp-dump-${Math.round(Date.now() / 1000)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        badge.textContent += ' [saved]';
      } catch (_e2) { /* diagnostics must never break the page */ }
    }, false);
  } catch (_e) { /* noop */ }

  const props = renderer.properties;
  /** @param {THREE.Texture|null|undefined} t */
  const glLive = (t) => {
    try { return !!(t && props.get(t) && props.get(t).__webglTexture); } catch (_e) { return false; }
  };

  /** Mean 0..1 luma of a PATCH×PATCH read at device-pixel (x, y). */
  function readLuma(x, y) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const rx = Math.max(0, Math.min(w - PATCH, Math.round(x)));
    const ry = Math.max(0, Math.min(h - PATCH, Math.round(y)));
    gl.readPixels(rx, ry, PATCH, PATCH, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf);
    let sum = 0;
    for (let i = 0; i < pxBuf.length; i += 4) {
      sum += 0.2126 * pxBuf[i] + 0.7152 * pxBuf[i + 1] + 0.0722 * pxBuf[i + 2];
    }
    return sum / ((pxBuf.length / 4) * 255);
  }

  /**
   * Paint the reference swatch into the default framebuffer via three's state
   * APIs (raw gl.* here would desync the renderer's cached scissor/clear state).
   */
  function paintSwatch() {
    const prevRT = renderer.getRenderTarget();
    if (prevRT !== null) renderer.setRenderTarget(null);
    const prevScissorTest = renderer.getScissorTest();
    renderer.getScissor(savedScissor);
    renderer.getClearColor(savedClearColor);
    const prevAlpha = renderer.getClearAlpha();
    const pr = renderer.getPixelRatio();
    // setScissor multiplies by pixelRatio → pass CSS units for SWATCH_PX device px.
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, SWATCH_PX / pr, SWATCH_PX / pr);
    renderer.setClearColor(0x00ff66, 1);
    renderer.clearColor();
    renderer.setScissor(savedScissor);
    renderer.setScissorTest(prevScissorTest);
    renderer.setClearColor(savedClearColor, prevAlpha);
    if (prevRT !== null) renderer.setRenderTarget(prevRT);
  }

  function sample(ts) {
    const sm = sceneManager;
    const cam = sm.camera;
    const comp = sm.composer;
    const dbw = gl.drawingBufferWidth;
    const dbh = gl.drawingBufferHeight;
    const lost = ctxLost || (typeof gl.isContextLost === 'function' && gl.isContextLost());

    // End-of-frame raw GL viewport/scissor truth (leak detector).
    let vp = null; let sc = null; let scTest = false;
    try {
      vp = gl.getParameter(gl.VIEWPORT);
      scTest = !!gl.getParameter(gl.SCISSOR_TEST);
      sc = gl.getParameter(gl.SCISSOR_BOX);
    } catch (_e) { /* context lost mid-sample */ }

    // Composer / bloom render-target GL liveness. Dead-AFTER-live only: a
    // fresh/rebuilt composer's targets initialize lazily on first bind, and
    // some are unused by design per tier (see rtWasLive). L=live, x=never
    // bound (benign), X=was live and its GL texture is now gone (anomaly).
    if (comp !== composerRef) {
      composerRef = comp;
      composerGen++;
      rtWasLive.rt1 = false; rtWasLive.rt2 = false; rtWasLive.rtB = false;
    }
    const rt1 = glLive(comp && comp.renderTarget1 && comp.renderTarget1.texture);
    const rt2 = glLive(comp && comp.renderTarget2 && comp.renderTarget2.texture);
    const rtB = sm.bloomPass
      ? glLive(sm.bloomPass.renderTargetBright && sm.bloomPass.renderTargetBright.texture)
      : null; // null = no bloom pass this tier
    const rtDied =
      (rtWasLive.rt1 && !rt1) || (rtWasLive.rt2 && !rt2) || (rtWasLive.rtB && rtB === false);
    rtWasLive.rt1 = rtWasLive.rt1 || rt1;
    rtWasLive.rt2 = rtWasLive.rt2 || rt2;
    rtWasLive.rtB = rtWasLive.rtB || rtB === true;
    const rtCh = (live, was) => (live ? 'L' : (was ? 'X' : 'x'));
    const rtStr = rtCh(rt1, rtWasLive.rt1) + rtCh(rt2, rtWasLive.rt2) +
      (rtB === null ? '-' : rtCh(rtB, rtWasLive.rtB));

    // Earth texture GL liveness (OPEN-2: night-side city lights black on 16k).
    const eDay = earth ? glLive(earth.dayTexture) : false;
    const eNight = earth ? glLive(earth.nightTexture) : false;
    const eClouds = earth ? glLive(earth.cloudTexture) : false;
    const deadAfterLive =
      (texWasLive.day && !eDay) || (texWasLive.night && !eNight) || (texWasLive.clouds && !eClouds);
    texWasLive.day = texWasLive.day || eDay;
    texWasLive.night = texWasLive.night || eNight;
    texWasLive.clouds = texWasLive.clouds || eClouds;
    const eCh = (live, was) => (live ? 'L' : (was ? 'X' : 'x')); // x = not uploaded yet (async decode), X = died
    const eStr = earth
      ? (eCh(eDay, texWasLive.day) + eCh(eNight, texWasLive.night) + eCh(eClouds, texWasLive.clouds))
      : '---';

    const memTex = renderer.info && renderer.info.memory ? renderer.info.memory.textures : -1;
    const programs = renderer.info && renderer.info.programs ? renderer.info.programs.length : -1;
    const floor = sm._ladderFidelity ? sm._ladderFidelity.floor : null;
    const nfOn = sm.renderPass ? !!sm.renderPass.nearFieldEnabled : null;

    // --- Anomaly classification ---
    const alerts = [];
    if (lost) alerts.push('ctxlost');
    if (dbw !== canvas.width || dbh !== canvas.height) alerts.push(`dbmm(${dbw}x${dbh}!=${canvas.width}x${canvas.height})`);
    if (rtDied) alerts.push(`rtdead(${rtStr})`);
    if (deadAfterLive) alerts.push(`texdead(${eStr})`);
    if (scTest) alerts.push(`sciss(${sc ? `${sc[0]},${sc[1]},${sc[2]}x${sc[3]}` : '?'})`);
    if (vp && (vp[2] !== dbw || vp[3] !== dbh)) alerts.push(`vp(${vp[0]},${vp[1]},${vp[2]}x${vp[3]})`);
    if (floor === 6 || floor === 7) {
      const want = FLOOR_CLIP[floor];
      if (cam.near !== want.near || cam.far !== want.far) {
        alerts.push(`clip(F${floor} ${cam.near}/${cam.far})`);
      }
      // nfOn=true here is either the T1 re-assert bug or a deliberate ?nf=1
      // run — visible in the badge as `nf1` on F6/F7, not alert-latched.
    }
    // memdrop: transition against the PREVIOUS sample (not high-water, which
    // would latch the alert forever after one drop); high-water kept for dumps.
    if (lastMemTex >= 0 && memTex >= 0 && memTex < lastMemTex - 2) alerts.push(`memdrop(${lastMemTex}->${memTex})`);
    lastMemTex = memTex;
    memTexHighWater = Math.max(memTexHighWater, memTex);
    if (!Number.isNaN(lastNear) && (cam.near !== lastNear || cam.far !== lastFar)) {
      logEvent({ ts: Math.round(ts), kind: 'clip-change', from: `${lastNear}/${lastFar}`, to: `${cam.near}/${cam.far}`, floor });
    }
    lastNear = cam.near; lastFar = cam.far;
    if (composerGen > 0 && ring.length > 0 && ring[ring.length - 1].compGen !== composerGen) {
      alerts.push(`comp(rebuild#${composerGen})`);
    }
    if (mode === 2 && lumas.sw >= 0 && lumas.sw < BLACK_LUMA) alerts.push('swatchdead');

    const snap = {
      ts: Math.round(ts), frame, fps: Math.round(fpsEst),
      floor, tier: sm.currentTier, nfOn,
      near: cam.near, far: cam.far,
      memTex, memHi: memTexHighWater, programs, compGen: composerGen,
      rt: rtStr, earthTex: eStr,
      db: `${dbw}x${dbh}`, cv: `${canvas.width}x${canvas.height}`,
      pr: renderer.getPixelRatio(), dpr: window.devicePixelRatio,
      vp: vp ? `${vp[0]},${vp[1]},${vp[2]}x${vp[3]}` : '?',
      scTest, sc: sc ? `${sc[0]},${sc[1]},${sc[2]}x${sc[3]}` : '?',
      luma: mode === 2 ? { c: lumas.c, l: lumas.l, r: lumas.r, sw: lumas.sw } : null,
      ctxEvents, vis: visEvents, gaps: gapEvents, lastGapMs,
      alerts: alerts.join(' '),
    };
    ring.push(snap);
    if (ring.length > 90) ring.shift();

    const alertsStr = alerts.join(' ');
    if (alertsStr) {
      anomalyLatchUntil = ts + 2000;
      const urgent = lost || alertsStr.indexOf('comp(') !== -1 || alertsStr !== lastAlerts;
      if (urgent && (ts - lastWarnAt >= WARN_MIN_MS || lost)) {
        lastWarnAt = ts;
        try { console.warn(`[BFP] ${alertsStr}`, JSON.stringify(snap)); } catch (_e) { /* noop */ }
        logEvent(snap);
      }
    }
    lastAlerts = alertsStr;

    // --- Badge ---
    const lumaStr = mode === 2
      ? ` c${lumas.c < 0 ? '?' : lumas.c.toFixed(2)} l${lumas.l < 0 ? '?' : lumas.l.toFixed(2)} r${lumas.r < 0 ? '?' : lumas.r.toFixed(2)} sw${lumas.sw < 0 ? '?' : lumas.sw.toFixed(2)}`
      : '';
    badge.textContent =
      `BFP${mode} F${floor || '-'} ${sm.currentTier} nf${nfOn === null ? '?' : (nfOn ? '1' : '0')}` +
      ` n${cam.near}/${cam.far} t${memTex} rt${rtStr} e${eStr} db${dbw}x${dbh}` +
      `${scTest ? ' SCISS' : ''}${lost ? ' CTXLOST' : ''}${lumaStr} f${Math.round(fpsEst)}` +
      (visEvents || gapEvents || starveEvents || blurEvents ? ` v${visEvents} g${gapEvents} s${starveEvents} b${blurEvents}` : '') +
      (alertsStr ? ` | ${alertsStr}` : '');
    const bad = ts < anomalyLatchUntil;
    badge.style.color = bad ? '#f77' : '#8f8';
    badge.style.borderColor = bad ? 'rgba(255,120,120,0.6)' : 'rgba(140,255,140,0.35)';
  }

  // Post-mortem dump for us; the user never has to touch it. `frame` and
  // `counters` are LIVE values (ring snaps lag by up to CHECK_EVERY frames —
  // at blur-keepalive cadence that is ~30 s, so harnesses must not read
  // liveness from the ring).
  try {
    window.__bfpDump = () => ({
      mode,
      frame,
      counters: { visEvents, gapEvents, lastGapMs, starveEvents, blurEvents, ctxEvents },
      ring: ring.slice(),
      alertLog: alertLog.slice(),
    });
  } catch (_e) { /* noop */ }

  try { console.info(`[BFP] black-frame probe installed (mode ${mode}, check ${CHECK_EVERY}f, read ${READ_EVERY}f)`); } catch (_e) { /* noop */ }

  return {
    /**
     * Call once per rendered frame, immediately after the composer/map render
     * inside the SAME rAF task (readbacks must precede the present).
     * @param {number} ts — rAF timestamp (ms)
     */
    tick(ts) {
      frame++;
      if (starveLogged) {
        // Frames resumed after a visible-tab starvation episode — close it out.
        starveLogged = false;
        logEvent({ ts: Math.round(ts), kind: 'starve-end', starvedMs: Math.round(ts - starvedSinceTs) });
        try { console.warn(`[BFP] frames resumed after ${Math.round(ts - starvedSinceTs)}ms starvation`); } catch (_e2) { /* noop */ }
      }
      if (lastTickTs > 0 && ts > lastTickTs) {
        const dtMs = ts - lastTickTs;
        const inst = 1000 / dtMs;
        fpsEst = fpsEst === 0 ? inst : fpsEst * 0.9 + inst * 0.1;
        if (dtMs > STARVE_MS) {
          gapEvents++;
          lastGapMs = Math.round(dtMs);
          // Correlate each starvation gap with the last visibility flip: gaps
          // that BEGIN while 'visible' with no recent flip are the pathological
          // frame-starvation; gaps right after hidden→visible are the broken
          // occlusion-resume. sinceVisMs = gap END minus last flip.
          logEvent({
            ts: Math.round(ts), kind: 'raf-gap', gapMs: lastGapMs,
            visState: document.visibilityState,
            sinceVisMs: lastVisFlipTs < 0 ? null : Math.round(ts - lastVisFlipTs),
          });
        }
      }
      lastTickTs = ts;

      const lost = ctxLost || (typeof gl.isContextLost === 'function' && gl.isContextLost());
      if (mode === 2 && !lost && gl.drawingBufferWidth > 0 && gl.drawingBufferHeight > 0) {
        try {
          paintSwatch(); // every frame → the corner swatch reads steady, not strobing
          if (frame % READ_EVERY === 0) {
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const midY = (h - PATCH) / 2;
            lumas.c = readLuma((w - PATCH) / 2, midY);
            lumas.l = readLuma(4, midY);
            lumas.r = readLuma(w - PATCH - 4, midY);
            lumas.sw = readLuma(2, 2);
          }
        } catch (_e) { /* never let diagnostics break the frame */ }
      }
      if (frame % CHECK_EVERY === 0) {
        try { sample(ts); } catch (_e) { /* noop */ }
      }
    },
  };
}

export default installBlackFrameProbe;
