/**
 * main.js — Game bootstrap: initializes renderer, scene, game loop,
 * and delegates game flow to GameFlowManager.
 * @module main
 */

import * as THREE from 'three';

// [DBG-KEY-CAPTURE] window-level keydown sniffer removed (noise on every keystroke).
// Re-enable only when diagnosing ASR / accessibility / focus key-injection issues.

import { Constants } from './core/Constants.js';
import { eventBus } from './core/EventBus.js';
import { Events } from './core/Events.js';
import { gameState, GameStates } from './core/GameState.js';
import { runtimeAdapt, TIER_ORDER } from './systems/QualityManager.js';

import { SceneManager } from './scene/SceneManager.js';
import { Earth } from './scene/Earth.js';
import { Starfield } from './scene/Starfield.js';
import { SunLight } from './scene/SunLight.js';
import { launchCinematic } from './scene/LaunchCinematic.js';
import { tierVisualManager } from './scene/TierVisualManager.js';

import { PlayerSatellite } from './entities/PlayerSatellite.js';
import { DebrisField } from './entities/DebrisField.js';
import { ActiveSatellites } from './entities/ActiveSatellite.js';
import { ArmManager } from './entities/ArmManager.js';
import { orbitToSceneCartesianInto } from './entities/OrbitalMechanics.js';

// Systems
import { scoringSystem } from './systems/ScoringSystem.js';
import { targetSelector } from './systems/TargetSelector.js';
import { audioSystem } from './systems/AudioSystem.js';
import { CameraSystem } from './systems/CameraSystem.js';
import { CommsSystem } from './systems/CommsSystem.js';
import { ResourceSystem } from './systems/ResourceSystem.js';
import { SensorSystem } from './systems/SensorSystem.js';
import { kesslerSystem } from './systems/KesslerSystem.js';
import { CargoSystem } from './systems/CargoSystem.js';
import { ForgeSystem } from './systems/ForgeSystem.js';
import { ConjunctionSystem } from './systems/ConjunctionSystem.js';
import { InputManager } from './systems/InputManager.js';
import { gameFlowManager } from './systems/GameFlowManager.js';
import { powerDistribution } from './systems/PowerDistribution.js';
import { launchSequence } from './systems/LaunchSequence.js';
import { trawlManager } from './systems/TrawlManager.js';
import { AutopilotSystem } from './systems/AutopilotSystem.js';
import { SkillsSystem } from './systems/SkillsSystem.js';
import { MissionCoach } from './systems/MissionCoach.js';
import { IssConjunctionBoss } from './systems/IssConjunctionBoss.js';
import { StarlinkCascadeBoss } from './systems/StarlinkCascadeBoss.js';
import { LassoSystem } from './systems/LassoSystem.js';
import { despinLaser } from './systems/DespinLaser.js';
import { RewardSystem } from './systems/RewardSystem.js';
import { CodexSystem } from './systems/CodexSystem.js';
import { SpaceWeatherSystem } from './systems/SpaceWeatherSystem.js';
import { SubsystemEvents } from './systems/SubsystemEvents.js';
import { CollisionAvoidanceSystem } from './systems/CollisionAvoidanceSystem.js';
import { MissionEventSystem } from './systems/MissionEventSystem.js';
import { ReputationSystem } from './systems/ReputationSystem.js';
import { EnvironmentSystem } from './systems/EnvironmentSystem.js';
import { catalogLoader } from './systems/CatalogLoader.js';

// UI
import { HUD } from './ui/HUD.js';
import { MotherCallouts } from './ui/MotherCallouts.js';
import { MenuScreen } from './ui/MenuScreen.js';
import { BriefingScreen } from './ui/BriefingScreen.js';
import { ShopScreen } from './ui/ShopScreen.js';
import { GameOverScreen } from './ui/GameOverScreen.js';
import { TargetReticle } from './ui/TargetReticle.js';
import { NavSphere } from './ui/NavSphere.js';
import { OrbitMFD } from './ui/OrbitMFD.js';
import { DebrisMap } from './ui/DebrisMap.js';
// DebrisWireframe is now created by HUD.js (integrated right-column layout)
import { DockingReticle } from './ui/DockingReticle.js';
import { VelocityStreaks } from './ui/VelocityStreaks.js';
import { TrailSystem } from './ui/TrailSystem.js';
import { DebugOverlay } from './ui/DebugOverlay.js';
import { SweepReportUI } from './ui/SweepReportUI.js';
import { CodexViewerUI } from './ui/CodexViewerUI.js';
import { HotkeyOverlay } from './ui/HotkeyOverlay.js';
import { SkillsPane } from './ui/hud/SkillsPane.js';
import { TeachingSystem } from './systems/TeachingSystem.js';
import { armIdleAdvisor } from './systems/ArmIdleAdvisor.js';
import { TeachingOverlay } from './ui/TeachingOverlay.js';
import { OnboardingDirector } from './systems/OnboardingDirector.js';
import { persistenceManager } from './systems/PersistenceManager.js';
import { StrategicMap } from './ui/StrategicMap.js';
import { captureNetVisual } from './ui/CaptureNetVisual.js';
import { furnaceBreakdownVisual } from './ui/FurnaceBreakdownVisual.js';
import { captureNetSystem } from './entities/CaptureNet.js';
import perfReportOverlay, { captureBootInfo } from './ui/PerfReportOverlay.js';
import { isAvifSupported } from './scene/Earth.js';
import { profileFlags } from './core/ProfileFlags.js';
import { AutoProfileSweep } from './systems/AutoProfileSweep.js';
import { gameState as _gameStateRefForProfile } from './core/GameState.js';


// ============================================================================
// GLOBALS
// ============================================================================
let sceneManager;
let earth;
let starfield;
let sunLight;
let lastTime = 0;

// --- Diagnostic: ?logPause=1 — opt-in per-second pause/state log.
// Parsed once at module load; never spams logs by default. Set to true via
// `?logPause=1` URL flag. The gameLoop samples per-frame counters and emits
// a one-line summary every ~1 s while enabled. Use this to confirm which
// `gameState.currentState` value is live when the user thinks the game is
// "paused" but the GPU is still busy.
const _logPauseEnabled = (() => {
  try {
    return new URLSearchParams(window.location.search).get('logPause') === '1';
  } catch (_e) { return false; }
})();
let _logPauseLastEmit = 0;
let _logPauseFramesRendered = 0;
let _logPauseFramesSkipped = 0;
if (_logPauseEnabled) {
  console.info('[logPause] enabled via ?logPause=1 — per-second pause/state diagnostic active');
}

// --- Diagnostic: ?logBoot=1 — opt-in boot timeline profiler.
// Sprint 4 §13: investigate the "fan turns on before CPU/GPU has time to get
// hot" symptom. SMC fan controller responds to brief die-temp impulses (Energy
// Impact + dwell time, not just steady-state CPU%); once die temp crosses
// ~60-65 °C it ramps and hysteresis keeps it spinning 5-15 min.
//
// This profiler captures `performance.now()` deltas between every major init
// phase (catalog load, scene/earth construct, debris build, renderer.compile,
// first rAF, first frame, async texture loads), then dumps a sorted timeline
// summary so the dominant phase pops out.
//
// External modules call `window.__bootMark?.('phase')` (optional chaining =
// zero overhead when flag is off; we only attach the global when enabled).
const _logBootEnabled = (() => {
  try {
    return new URLSearchParams(window.location.search).get('logBoot') === '1';
  } catch (_e) { return false; }
})();
const _bootT0 = (typeof performance !== 'undefined') ? performance.now() : 0;
let _bootMarks = [];
let _bootFirstFrameMarked = false;
// §13 dropped the "single-emit" gate. The timeline is now continuous: marks
// keep being appended (init phases, audio lifecycle, per-frame spikes) and the
// user can call `window.__dumpBootTimeline()` from DevTools at any moment to
// snapshot. Bounded auto-capture window is 60 s (see _bootSpikeWindowOver).
const _bootSpikeWindowMs = 60_000;
const _bootSpikeThresholdMs = 30; // Any render() > 30 ms is recorded as a spike
let _bootSpikeCount = 0;
function _bootMark(phase) {
  if (!_logBootEnabled) return;
  const t = performance.now() - _bootT0;
  const prev = _bootMarks.length ? _bootMarks[_bootMarks.length - 1].t : 0;
  _bootMarks.push({ phase, t, dt: t - prev });
}
/**
 * §13 spike detector. Called from gameLoop with the elapsed render time. Adds
 * a timeline mark when render() exceeds the threshold so post-boot spikes
 * (e.g. entering ORBITAL_VIEW, opening Strategic Map, etc.) are also captured.
 * Auto-disables after 60 s to bound memory; the user can re-enable by reload.
 */
function _bootSpikeDetect(renderMs) {
  if (!_logBootEnabled) return;
  const t = performance.now() - _bootT0;
  if (t > _bootSpikeWindowMs) return;
  if (renderMs > _bootSpikeThresholdMs) {
    _bootSpikeCount++;
    _bootMark(`SPIKE: render() took ${renderMs.toFixed(1)} ms`);
  }
}
function _emitBootTimeline(reason) {
  if (!_logBootEnabled) return;
  const pad = (n, w) => String(Math.round(n)).padStart(w);
  console.group(`[logBoot] BOOT TIMELINE — ${reason} (T0 = main.js eval, after imports)`);
  for (const m of _bootMarks) {
    console.log(`[logBoot] T+${pad(m.t, 5)}ms  (+${pad(m.dt, 4)}ms)  ${m.phase}`);
  }
  const top = _bootMarks.slice().sort((a, b) => b.dt - a.dt).slice(0, 8);
  console.log('[logBoot] --- TOP 8 PHASES BY DURATION ---');
  for (const m of top) {
    console.log(`[logBoot]   +${pad(m.dt, 4)}ms  @ T+${pad(m.t, 5)}ms  ${m.phase}`);
  }
  console.log(`[logBoot] total marks=${_bootMarks.length} spike-detections=${_bootSpikeCount}`);
  console.groupEnd();
}
if (_logBootEnabled) {
  console.info('[logBoot] enabled via ?logBoot=1 — boot timeline diagnostic active. Call window.__dumpBootTimeline() from DevTools at any moment to snapshot.');
  if (typeof window !== 'undefined') {
    window.__bootMark = _bootMark;
    window.__dumpBootTimeline = () => _emitBootTimeline('on-demand dump');
  }
  _bootMark('main.js eval (post-imports, T0)');
}

// --- rAF gate: `_rafScheduled` debounce.
// Why this exists: the previous gameLoop unconditionally re-scheduled
// `requestAnimationFrame(gameLoop)` at the top of every tick. That meant
// even when `gameFlowManager.paused === true` and our render() was skipped,
// the rAF callback kept firing at the display's refresh rate (e.g. 120 Hz).
// The browser's compositor stays awake whenever rAF is pumping, which is
// what consumed ~40 % of the Renderer-process GPU on user's M4 Max during
// ESC pause (confirmed by `?logPause=1` showing `rendered/s=0 skipped/s=120`
// while Activity Monitor still reported 40 % on "Google Chrome Helper (Renderer)").
//
// Fix: gate the next-frame scheduling through `_scheduleNextFrame()`, which
// dedups concurrent requests via `_rafScheduled`. The gameLoop only
// re-schedules when there is real work to render. Wake hooks (visibility
// change, PAUSE_RESUME event) explicitly call `_scheduleNextFrame()` to
// restart the loop.
let _rafScheduled = false;
// §14.1 Window-blur throttle flag. `visibilitychange` only fires when the
// *tab* is hidden (e.g. switching to another browser tab). It does NOT fire
// when the user Cmd-Tabs to another macOS app — the browser window is still
// on-screen so `document.hidden` stays false. To pause the sim on app-switch
// we listen for `window blur/focus` and set this flag. The `document.hasFocus()`
// cross-check in the blur handler filters false positives from DevTools focus,
// iframe focus, or child-popup focus. See §14.1 in GPU_PROFILING_REPORT.md.
let _windowBlurred = false;
// Diagnostic: tracks every _scheduleNextFrame() invocation (caller + when).
// Emits a console row once per second under `?logPause=1`. Lets us find the
// rogue caller that keeps the loop alive while paused.
let _rafCallerCounts = Object.create(null);
let _rafLastReport = 0;
// §12.12 Pending throttle setTimeout handle. Tracked so STATE_CHANGE and
// PAUSE_RESUME can cancel the pending throttle and reschedule immediately at
// the new state's interval (otherwise the old throttle delays transitions by
// up to 200 ms).
let _scheduleTimeoutHandle = null;

/**
 * §12.12 State-aware rAF dispatch interval (ms).
 *   0   → follow display refresh (immediate rAF) — active gameplay only.
 *   >0  → throttle via setTimeout before rAF — for menu / pause / hidden.
 *
 * Rationale: anything > 0 lets the browser compositor and JS engine sleep
 * between dispatches. On macOS this is what allows Apple Silicon Efficiency
 * cores to reach deep c-states; the Energy Impact metric (which drives the
 * SMC fan controller) drops accordingly. Indistinguishable to the user for
 * UI screens since the camera barely moves and entity sim is already at 10 %.
 */
function _getScheduleIntervalMs() {
  // ESC pause: aggressive 5 Hz throttle (§12.4) — render() is skipped anyway.
  if (gameFlowManager.paused) return 200;
 // Tab hidden: also throttle defensively. In practice the gameLoop early-
 // returns at `document.hidden` without calling _scheduleNextFrame, so this
 // branch is only hit when an event listener wakes the loop while hidden.
 if (document.hidden) return 200;
 // §14.1 Window blurred (Cmd-Tab to another app): throttle identically to
 // hidden-tab. The browser window is still on-screen but the user is in
 // another application — no need for full frame rate.
 if (_windowBlurred) return 200;
  // Menu / Briefing / Shop / Game-over / Win — user is reading UI, not flying.
  // 30 Hz is indistinguishable from display refresh for static-camera
  // background scenes (entity sim already runs at 10 % speed in `!isActive`).
  // Cuts compositor + JS work 2-4× on 60/120 Hz displays.
  if (!gameState.isGameplay()) return 33; // ~30 fps
  // Active gameplay — display refresh.
  return 0;
}

function _scheduleNextFrame() {
  if (_logPauseEnabled) {
    // Two stack-frames up: line that called _scheduleNextFrame().
    // Take only the location portion so the histogram is readable.
    const stack = new Error().stack || '';
    const lines = stack.split('\n');
    // Skip the Error() row + this function's row → caller is index 2.
    const caller = (lines[2] || lines[1] || '?').trim().replace(/^at\s+/, '');
    _rafCallerCounts[caller] = (_rafCallerCounts[caller] || 0) + 1;
  }
  if (_rafScheduled) return;
  _rafScheduled = true;
  const intervalMs = _getScheduleIntervalMs();
  if (intervalMs > 0) {
    _scheduleTimeoutHandle = setTimeout(() => {
      _scheduleTimeoutHandle = null;
      requestAnimationFrame(gameLoop);
    }, intervalMs);
  } else {
    requestAnimationFrame(gameLoop);
  }
}

/**
 * §12.12 Cancel any pending throttle setTimeout and reschedule immediately at
 * the current state's interval. Call from event handlers that change the
 * required frame rate (STATE_CHANGE, PAUSE_RESUME, PAUSE_MENU, visibility).
 * Prevents up-to-200 ms latency on state transitions out of pause / menu.
 */
function _flushScheduledFrame() {
  if (_scheduleTimeoutHandle != null) {
    clearTimeout(_scheduleTimeoutHandle);
    _scheduleTimeoutHandle = null;
  }
  _rafScheduled = false;
  _scheduleNextFrame();
}

/**
 * §12.12 Predicate: should the AudioContext be in `'running'` state right now?
 * Returns false for any "user-idle" condition: paused, hidden tab, menu /
 * briefing / shop screens. Returns true for active gameplay AND end-screens
 * (GAME_OVER / WIN have death / victory stings that may still need to play).
 */
function _shouldAudioRun() {
  if (!audioSystem || !audioSystem.ctx) return false;
  if (gameFlowManager.paused) return false;
  if (document.hidden) return false;
  if (_windowBlurred) return false; // §14.1 — app-switch via Cmd-Tab
  if (gameState.isGameplay()) return true;
  // End-screens may have audio stings playing — keep ctx alive briefly.
  if (gameState.currentState === GameStates.GAME_OVER) return true;
  if (gameState.currentState === GameStates.WIN) return true;
  return false; // MENU, BRIEFING, SHOP
}

/**
 * §12.12 Single suspend/resume point for the AudioContext. Idempotent —
 * checks current `ctx.state` and only acts when it disagrees with policy.
 * Called from STATE_CHANGE, PAUSE_RESUME, PAUSE_MENU, visibilitychange,
 * window blur/focus (§14.1), and the pause branch in gameLoop.
 */
function _syncAudioCtxState() {
  if (!audioSystem || !audioSystem.ctx) return;
  const should = _shouldAudioRun();
  const state = audioSystem.ctx.state;
  if (should && state === 'suspended') {
    audioSystem.ctx.resume();
  } else if (!should && state === 'running') {
    audioSystem.ctx.suspend();
  }
}

/**
 * Hide the entire HUD overlay during pause to silence CSS animations and
 * any composite work on `.hud-panel` elements. Uses `visibility: hidden`
 * (not `display: none`) so we don't churn the layout engine on every
 * pause toggle. The pause overlay sits OUTSIDE `#hud-overlay`, so it
 * stays visible.
 * @param {boolean} hide
 */
function _setHudHidden(hide) {
  const hud = document.getElementById('hud-overlay');
  if (hud) hud.style.visibility = hide ? 'hidden' : 'visible';
  // Body-mounted priority panels (mission objective + control mode) live OUTSIDE
  // #hud-overlay so they stay bright/un-occluded during play — but they must
  // still hide with the rest of the HUD on pause/menu.
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('.hud-top-priority').forEach((el) => {
      el.style.visibility = hide ? 'hidden' : 'visible';
    });
  }
}
function _emitRafCallerDiagnostic(timestamp) {
  if (!_logPauseEnabled) return;
  if (timestamp - _rafLastReport < 1000) return;
  _rafLastReport = timestamp;
  const entries = Object.entries(_rafCallerCounts);
  if (entries.length === 0) return;
  _rafCallerCounts = Object.create(null);
  const summary = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v}× ${k}`)
    .join(' | ');
  console.log(`[logPause] _scheduleNextFrame callers/s: ${summary}`);
}

// Frame pacing — opt-in cap via Constants.PERF.FRAME_CAP (null = native refresh).
// Historic FRAME_INTERVAL hard-gate to 60 fps removed: it caused every-other-frame
// judder on 120/144 Hz displays. See PR 3 / Subtask P1.7.
let lastFrameTime = 0;
let frameCount = 0;

// PR 4 / P1.5 — Quality tier auto-adapt rolling FPS history + cooldown counter.
// Owned here (not inside SceneManager) so the gameLoop owns both the producer
// (frame timing) and the consumer (runtimeAdapt call). SceneManager owns the
// renderer/post-processing state via sceneManager.applyTier().
const _fpsHistory = [];
let _framesSinceLastTierChange = Constants.PERF.ADAPT_COOLDOWN_FRAMES; // start "cooled down" so the first decision is gated only by history length
const _ADAPT_CHECK_INTERVAL = 60; // call runtimeAdapt every N frames

// PR 6 / P3.15 — Draw-call profiling frame counter (separate from _ADAPT_CHECK_INTERVAL).
let _profileFrameCount = 0;

// PR 6 / P3.11 — GPU probe one-shot flag. Once the probe window completes
// (GPU_PROBE_FRAMES samples), we check the median and optionally downshift.
// After that, the flag flips true and the probe is disabled for the session.
let _gpuProbeComplete = false;

// Catch slo-mo state (Phase 1C)
let slowMoTimer = 0;
let slowMoFactor = 1.0;

// Sprint 2 / PR A — scratch outputs for `orbitToSceneCartesianInto` in the
// approach-distance check (per-frame while in APPROACH state).
const _approachCartPos = { x: 0, y: 0, z: 0 };
const _approachCartVel = { x: 0, y: 0, z: 0 };
const _approachTargetVec3 = new THREE.Vector3();

// Entities
let player;
let debrisField;
let activeSatellites;
let armManager;
let motherCallouts;
// Systems (targetSelector, kesslerSystem, trawlManager imported as singletons above)
let cameraSystem;
let commsSystem;
let missionCoach;
let issConjunctionBoss;
let starlinkCascadeBoss;
let resourceSystem;
let sensorSystem;
let cargoSystem;
let forgeSystem;
let conjunctionSystem;
let skillsSystem;
let skillsPane;
let lassoSystem;
let rewardSystem;
let codexSystem;
let spaceWeatherSystem;
let subsystemEvents;
let autopilotSystem;
let collisionAvoidanceSystem;
let missionEventSystem;
let reputationSystem;
let environmentSystem;

// UI
let hud;
let menuScreen;
let briefingScreen;
let shopScreen;
let gameOverScreen;
let targetReticle;
let navSphere;
let orbitMFD = null;
let debrisMap = null;
let debrisWireframe;
let dockingReticle;
let velocityStreaks;
let trailSystem;
let debugOverlay;
let sweepReportUI;
let codexViewerUI;
let hotkeyOverlay;
let teachingSystem;
let teachingOverlay;
let onboardingDirector;
let strategicMap;

// Input
let inputManager;

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  _bootMark('init() entry');
  // PR 5 / P2.10 — URL flag parsing (must run before any module reads
  // Constants.DEBUG). SceneManager handles its own `?tier=` override; we
  // only handle `?debug=1` here so the diagnostics gate flips on for the
  // very first _logDiagnostics() / Earth LOD log call this session.
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === '1') {
      Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS = true;
      console.info('[Debug] verbose diagnostics enabled via ?debug=1');
    }
    // PR 6 / P3.15: ?profile=1 enables per-60-frame draw-call logging.
    if (urlParams.get('profile') === '1') {
      Constants.DEBUG.LOG_DRAW_CALLS = true;
      console.info('[Profile] draw-call profiling enabled via ?profile=1');
    }
    // Sprint 2 / Phase A: ?perfReport=1 — defer overlay attach until after the
    // SceneManager + DebrisField exist (handled near the end of init()).
    if (urlParams.get('perfReport') === '1') {
      Constants.DEBUG.PERF_REPORT_OVERLAY = true;
      console.info('[PerfReport] overlay scheduled via ?perfReport=1');
    }
    // Sprint 3 GPU profiling: ?autoProfile=1 enables [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)
    // — scheduled near the end of init() once SceneManager + Earth exist.
    if (profileFlags.autoProfile) {
      console.info('[AutoProfile] scheduled via ?autoProfile=1 — will auto-start once scene settles. To re-run in another game state, call window.startAutoProfile() from DevTools.');
    }
  } catch (_e) {
    // Non-browser env or malformed URL — ignore.
  }

  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    console.error('[main] #game-canvas not found');
    return;
  }

  // --- ST-6.1: Offline Catalogue — fetch before entities so DebrisField can
  //     populate real NORAD-tagged debris in hybrid mode. On fetch failure
  //     catalogLoader.init() resolves false and DebrisField transparently
  //     falls back to pure procedural generation.
  try {
    await catalogLoader.init();
  } catch (e) {
    console.warn('[main] CatalogLoader init threw unexpectedly:', e);
  }
  _bootMark('CatalogLoader.init complete');

  // --- Scene Manager (renderer, camera, post-processing) ---
  sceneManager = new SceneManager(canvas);
  const scene = sceneManager.getScene();
  const camera = sceneManager.getCamera();
  _bootMark('SceneManager constructed (renderer + composer + bloom)');

  // --- Earth (visual centerpiece) ---
  earth = new Earth(scene);
  // Sprint 2 / PR C — register so SceneManager.applyTier() can toggle the
  // LOW_DETAIL fragment-shader branch when the tier changes.
  sceneManager.setEarth(earth);
  _bootMark('Earth constructor returned (textures still decoding async)');

  // --- Starfield (background) ---
  starfield = new Starfield(scene);

  // --- Sun Light (dynamic day/night) ---
  sunLight = new SunLight(scene, sceneManager);

  // --- Player Satellite ---
  player = new PlayerSatellite(scene);
  _bootMark('Starfield + SunLight + Player constructed');

  // --- Debris Field (ST-6.1: hybrid mode consumes catalogLoader if ready) ---
  debrisField = new DebrisField(scene, { catalogLoader });
  _bootMark('DebrisField constructed (800 interactive + 5000 background)');

  // --- Active Satellites ---
  activeSatellites = new ActiveSatellites(scene);

  // --- Config G Arm Manager (Y0 Quad: 4 arms — 2 Weaver + 2 Spinner) ---
  armManager = new ArmManager(scene, player);
  armManager.setDebrisField(debrisField);
  armManager.setCatalogLoader(catalogLoader);    // ST-6.1: active-sat treaty guard

  // --- Target Selector: imported singleton from TargetSelector.js ---

  // --- Extracted Systems (Sprint 4A) ---
  resourceSystem = new ResourceSystem();
  resourceSystem.setPlayer(player);
  scoringSystem.setPlayer(player);  // ST-4.E: Wire player ref for ΔV tracking
  armManager.setResourceSystem(resourceSystem);
  sensorSystem = new SensorSystem();
  // kesslerSystem: imported singleton from KesslerSystem.js
  cargoSystem = new CargoSystem();
  forgeSystem = new ForgeSystem(cargoSystem, resourceSystem);
  conjunctionSystem = new ConjunctionSystem();
  // trawlManager: imported singleton from TrawlManager.js
  autopilotSystem = new AutopilotSystem();
  collisionAvoidanceSystem = new CollisionAvoidanceSystem();

  // --- Phase 4A: Skills + Lasso systems ---
  skillsSystem = new SkillsSystem();
  lassoSystem = new LassoSystem(scene);

  // --- Phase 5 Rewards: RewardSystem + SweepReportUI ---
  rewardSystem = new RewardSystem();
  sweepReportUI = new SweepReportUI();

  // --- Phase 7: Learning Systems (Codex + Space Weather + Subsystem Events) ---
  codexSystem = new CodexSystem();
  // ST-6.1: seeded replay if catalogLoader is ready
  spaceWeatherSystem = new SpaceWeatherSystem({ catalogLoader });
  subsystemEvents = new SubsystemEvents();

  // --- ST-4.D: Dynamic Mid-Mission Events ---
  missionEventSystem = new MissionEventSystem();
  reputationSystem = new ReputationSystem();

  // Load news events (offline-first, graceful failure)
  missionEventSystem.loadNewsEvents();

  // --- ST-6.7: Environment Hazards (AO, MMOD, Safe-Mode, Radiation, Battery DOD) ---
  environmentSystem = new EnvironmentSystem(eventBus, player, powerDistribution, resourceSystem, skillsSystem);
  environmentSystem.init();
  _bootMark('Subsystems constructed (resource/sensor/cargo/forge/conjunction/autopilot/skills/lasso/rewards/codex/spaceWeather/missionEvents/environment)');

  // --- F17: Codex Viewer UI (browse unlocked entries) ---
  codexViewerUI = new CodexViewerUI(codexSystem);

  // --- Keyboard shortcut reference overlay (? toggles a grouped hotkey list) ---
  hotkeyOverlay = new HotkeyOverlay();

  // --- ST-6.5: Teaching System (first-encounter contextual overlays) ---
  teachingOverlay = new TeachingOverlay(document.body);
  teachingSystem = new TeachingSystem(eventBus);
  teachingSystem.onShow = (moment) => teachingOverlay.show(moment);
  teachingSystem.setSkillsSystem(skillsSystem); // CP-4 §3.1 veteran downgrade + hint-gating
  teachingSystem.init();

  // --- Delegation 2 (2026-05-31): OnboardingDirector ---
  // Orchestrates the 16-beat first-experience pipeline (boot → handshake →
  // arrows → struts → zoom → inspect → scan → target → autopilot → decision
  // → lasso/daughter → complete).  Subscribes to MISSION_START and walks
  // each beat: emits HOUSTON comms, posts to bottom-screen ticker, soft
  // chime, brightens related HUD panel via SKILL_DISCOVERED.  Escalates
  // un-satisfied beats to TeachingSystem after 15 s.
  onboardingDirector = new OnboardingDirector({
    eventBus,
    scoringSystem,
    skillsSystem,
    teachingSystem,
    persistenceManager,
    // Live game context for conditional onboarding beats (#1 target gating,
    // #3 capture-proximity gating). Returns counts/distances the director uses
    // to decide whether a beat is actionable yet.
    contextProvider: () => {
      let trackedContacts = 0;
      let nearestDebrisM = null;
      try {
        if (debrisField && typeof debrisField.getDiscoveredCount === 'function') {
          trackedContacts = debrisField.getDiscoveredCount(true);
        }
        const playerPos = player && player.getPosition ? player.getPosition() : null;
        if (debrisField && playerPos && typeof debrisField.getDebrisNear === 'function') {
          // Nearest discovered debris distance (metres). 5 km search window.
          const near = debrisField.getDebrisNear(playerPos, 5.0);
          let bestKm = Infinity;
          for (const d of (near || [])) {
            if (d && d.discovered === false) continue;
            if (typeof d.distanceKm === 'number' && d.distanceKm < bestKm) bestKm = d.distanceKm;
          }
          if (bestKm < Infinity) nearestDebrisM = bestKm * 1000;
        }
      } catch (_e) { /* context is best-effort */ }
      const hasTarget = !!(targetSelector && targetSelector.getActiveTarget && targetSelector.getActiveTarget());
      return { trackedContacts, nearestDebrisM, hasTarget };
    },
  });

  // Phase 4: Wire cargo system to resource system for dual-mode fuel
  resourceSystem.setCargoSystem(cargoSystem);
  player.setResourceSystem(resourceSystem);
  player.setCargoSystem(cargoSystem);

  // --- Camera System (replaces old manual follow) ---
  cameraSystem = new CameraSystem(camera, canvas, scene);

  // --- Mothership inspection callouts (in-world 3D labels; replaces the 2D
  // wireframe pane). Gated internally on the inspection events. ---
  motherCallouts = new MotherCallouts(player, camera, { armManager });

  // --- Camera: start following the player ---
  const startPos = player.getPosition();
  camera.position.copy(startPos);
  camera.position.y += 0.00008;

  // --- Comms System ---
  commsSystem = new CommsSystem();

  // --- CP-4 MissionCoach (chapters 2+ coaching; chapter 1 stays with OnboardingDirector) ---
  missionCoach = new MissionCoach({ eventBus, scoringSystem, persistenceManager, commsSystem });
  missionCoach.init();

  // --- Build UI ---
  hud = new HUD();
  // Delegation 4 (2026-05-31) — Browser-playtest: NetInventoryPanel is
  // SUSPENDED (never displayed) pending a UX redesign. See ROADMAP.md.
  // The panel still mounts so internal event tracking works, but setVisible
  // is never called.
  menuScreen = new MenuScreen();
  briefingScreen = new BriefingScreen();
  shopScreen = new ShopScreen();
  gameOverScreen = new GameOverScreen();

  // --- Target Reticle (Canvas 2D overlay) ---
  targetReticle = new TargetReticle(camera);
  targetReticle.setVisible(false);

  // --- Nav Sphere (Canvas 2D 3D-radar) ---
  navSphere = new NavSphere(camera);
  navSphere.setVisible(false);

  // --- Debris Wireframe — now created by HUD (integrated right-column layout) ---
  debrisWireframe = hud.debrisWireframe;

  // --- Docking Reticle (Canvas 2D ARM PILOT overlay) ---
  dockingReticle = new DockingReticle(camera, scene);
  dockingReticle.setVisible(false);

  // --- Velocity Streaks (Canvas 2D acceleration overlay — Phase 4) ---
  velocityStreaks = new VelocityStreaks();
  // Canvas starts visible — empty overlay is transparent, no visual impact;
  // STATE_CHANGE listener hides/clears when leaving gameplay states

  // --- ST-5.2: Trail System (3-D world-space historical trajectory ribbons) ---
  trailSystem = new TrailSystem(scene, eventBus);

  // --- Orbit MFD (Keplerian orbit display) ---
  orbitMFD = new OrbitMFD();

  // --- Debris Map (ST-4.A — full-screen strategic sweep planning overlay) ---
  debrisMap = new DebrisMap();

  // --- Debug Overlay (Ctrl+D toggle) ---
  debugOverlay = new DebugOverlay();
  _bootMark('UI constructed (HUD/Menu/Briefing/Shop/GameOver/Reticles/NavSphere/OrbitMFD/DebrisMap/DebugOverlay)');

  // --- Connect comms to HUD ---
  hud.setCommsSystem(commsSystem);

  // --- Connect V3 arm manager to HUD + player satellite ---
  if (armManager) hud.setArmManager(armManager);
  if (armManager) player.setArmManager(armManager);
  // Delegation 4 (2026-05-31): wire LassoSystem into HUD so NetInventoryPanel
  // can poll initial ammo state.
  if (lassoSystem && typeof hud.setLassoSystem === 'function') hud.setLassoSystem(lassoSystem);

  // V-7: Launch cinematic visual effects (flag-gated internally)
  if (Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
    launchCinematic.init(scene, player);
  }

  // V-8: Capture net system + visual effects
  if (Constants.FEATURE_FLAGS.CAPTURE_NET) {
    captureNetSystem.init();   // ST-9.4: initialize mother pod inventory + set _initialized
    captureNetVisual.init(scene, player, captureNetSystem);
    // Item 1: staged furnace-breakdown choreography (chunks → furnace, net drawn in).
    furnaceBreakdownVisual.init(scene, player);
  }

  // CP-2: mother-mounted de-spin laser (flag-gated; operates on the active target)
  if (Constants.FEATURE_FLAGS.LASER_DESPIN) {
    despinLaser.init({ scene, player, targetSelector });
  }

  // V-9: Tier progression visual (flag-gated internally)
  if (Constants.FEATURE_FLAGS.TIER_UPGRADES) {
    tierVisualManager.init(scene, player, armManager);
  }

  // --- F17: Connect codex system to HUD badge + badge click toggle ---
  hud.setCodexSystem(codexSystem);
  eventBus.on('codex:toggleUI', () => { if (codexViewerUI) codexViewerUI.toggle(); });

  // --- Connect shop screen to game over screen (for upgrade count display) ---
  gameOverScreen.setShopScreen(shopScreen);

  // --- Phase 5: Wire cargo & scoring refs into shop for sell/contribute ---
  shopScreen.setCargoSystem(cargoSystem);
  shopScreen.setScoringSystem(scoringSystem);

  // --- CH5 ISS conjunction boss (MISSION_ARC §6) — protect-the-asset event ---
  // Needs the shop (elevator-mass award) + debrisField (ISS-track spawn), so it
  // is constructed after shopScreen is wired, unlike MissionCoach above.
  issConjunctionBoss = new IssConjunctionBoss({
    eventBus, scoringSystem, debrisField, shopScreen, persistenceManager,
  });
  issConjunctionBoss.init();

  // --- CH9 Starlink fragmentation boss (MISSION_ARC §6) — race-the-cascade event ---
  starlinkCascadeBoss = new StarlinkCascadeBoss({
    eventBus, scoringSystem, debrisField, shopScreen, persistenceManager,
  });
  starlinkCascadeBoss.init();

  // --- GameFlowManager: init with reduced refs (13 decoupled via EventBus) ---
  // Removed: menuScreen, gameOverScreen (GAME_STATE_CHANGE)
  //          targetReticle, navSphere, dockingReticle, orbitMFD (VIEW_CONFIG_CHANGE / GAME_STATE_CHANGE)
  //          sensorSystem (SENSOR_UPGRADE)
  //          commsSystem (GAME_STATE_CHANGE + COMMS_SEND + GAME_RESET), inputManager (ARM_RETURNED + ARM_EXPENDED)
  //          hud (GAME_STATE_CHANGE + VIEW_CONFIG_CHANGE + HUD_TARGET_CLICK + PAUSE events)
  //          briefingScreen (GAME_STATE_CHANGE payload.targets)
  //          subsystemEvents (PERSISTENCE_LOADED + PERSISTENCE_GATHER)
  //          debrisWireframe (TARGET_SELECTED/CLEARED + GAME_RESET + DEBRIS_REMOVED + WIREFRAME_ASSESSED)
  //          kesslerSystem (COLLISION_GAME_OVER + GAME_RESET + GAMEOVER_CONTINUE — imported singleton)
  //          targetSelector (imported singleton)
  //          trawlManager (GAME_STATE_CHANGE + TRAWL_START — imported singleton)
  gameFlowManager.init({
    player, debrisField, armManager, cameraSystem,
    shopScreen,
    resourceSystem,
  });

  // --- F15: Wire autopilot dependencies ---
  autopilotSystem.init({
    player, targetSelector, trawlManager, debrisField, armManager,
  });

  // --- ST-6.4: Strategic Map (Shift+V orbital overview) ---
  strategicMap = new StrategicMap({
    scene: sceneManager.getScene(),
    renderer: sceneManager.getRenderer(),
    catalogLoader,
    debrisField,
    playerSatellite: player,
    conjunctionSystem,
    environmentSystem,
    eventBus,
  });
  strategicMap.init();

  // --- Input Manager ---
  inputManager = new InputManager();
  // --- Skills Pane (mounted on #hud-overlay, after HUD build) ---
  const hudOverlay = document.getElementById('hud-overlay');
  skillsPane = new SkillsPane(hudOverlay);
  // Enable skill-based progressive HUD revelation
  hud.enableSkillReveal();

  inputManager.init({
    gameState, player, armManager, cameraSystem, targetSelector,
    debrisField, debrisWireframe, dockingReticle, hud, targetReticle,
    navSphere, orbitMFD, debrisMap, audioSystem, debugOverlay, sensorSystem,
    lassoSystem, autopilotSystem, codexViewerUI, strategicMap, hotkeyOverlay,
    // Delegation 2 (2026-05-31): smart-default Space key consults the Director.
    onboardingDirector,
    transitionToState: (s, p) => gameFlowManager.transitionToState(s, p),
    deployArm: () => gameFlowManager.deployArm(),
    applyUpgrades: () => gameFlowManager.applyUpgrades(),
    setPaused: (val) => { gameFlowManager.paused = val; },
    getPaused: () => gameFlowManager.paused,
    setLastTime: (t) => { lastTime = t; },
    setApproachTarget: (t) => { gameFlowManager.approachTarget = t; },
    setApproachComplete: (v) => { gameFlowManager.approachComplete = v; },
  });
  inputManager.start();
  _bootMark('InputManager started + gameFlowManager.init');

  // --- Item 3: anti-stuck idle watchdog (data-driven, veteran-gated) ---
  armIdleAdvisor.init({
    armManager,
    skillsSystem,
    getPilotMode: () => (inputManager ? inputManager._controlMode : null),
    getActiveNetForArm: (idx) => (captureNetSystem.getActiveNetForArm
      ? captureNetSystem.getActiveNetForArm(idx) : null),
  });

  // --- Collision Avoidance System (after inputManager so ref is valid) ---
  collisionAvoidanceSystem.init({
    player, debrisField, armManager, inputManager,
  });

  // --- Event listeners for game flow (delegated to GameFlowManager) ---
  gameFlowManager.setupEventHandlers();

  // Sim mode: NO slo-mo on capture. Previously triggered CATCH_SLOWMO on
  // ARM_CAPTURED and LASSO_CAPTURED ("catch juice"). Arcade behaviour; removed
  // per user feedback — real capture is unremarkable momentum transfer.
  // Detach slo-mo below is retained (losing an arm is a significant event).

  // --- Phase 6: Tether detach slo-mo + dramatic moment ---
  eventBus.on(Events.ARM_DETACHED, () => {
    slowMoTimer = Constants.DETACH_SLOWMO_DURATION;
    slowMoFactor = Constants.DETACH_SLOWMO_FACTOR;
  });

  // --- ST-6.4: Strategic Map toggle ---
  eventBus.on(Events.STRATEGIC_MAP_TOGGLE, () => {
    if (strategicMap) {
      strategicMap.isOpen() ? strategicMap.close() : strategicMap.open();
    }
  });

  // --- Delegation 2 (2026-05-31): Welcome field on first mission ever ---
  // On the player's very first MISSION_START we seed the curated 7–8 fragment
  // welcome cluster in the player's own orbit so the onboarding `scan` and
  // `target` beats have guaranteed contacts.  Subsequent missions / continues
  // skip the spawn (the legacy _spawnWelcomeField mission-1 gate also fires
  // — the public method is idempotent against _welcomeFieldSpawned).
  eventBus.on(Events.MISSION_START, (data) => {
    try {
      const firstEver = !(persistenceManager?.peek?.()?.stats?.missionsCompleted > 0);
      const forced = Constants.DEBUG?.FORCE_WELCOME_FIELD === true;
      const isMission1 = !data || data.missionNumber === 1 || data.missionNumber == null;
      if ((firstEver && isMission1) || forced) {
        const playerOrbit = player?.getOrbitalElements?.();
        if (playerOrbit && debrisField && typeof debrisField.spawnWelcomeField === 'function') {
          debrisField.spawnWelcomeField(playerOrbit);
        }
      }
    } catch (e) {
      console.warn('[main] welcome-field spawn failed:', e?.message);
    }
  });

  // --- Delegation 2 (2026-05-31): brighten struts when the `struts` beat enters ---
  eventBus.on('onboarding:beatEnter', (data) => {
    if (!data || data.beatId !== 'struts') return;
    if (player && typeof player.highlightStrutsForBeat === 'function') {
      player.highlightStrutsForBeat(4000);
    }
  });

  // --- Pause overlay: reset lastTime to avoid time-jump on unpause ---
  // Also wake the rAF loop AND restore HUD visibility — gameLoop is hard-
  // throttled to ~5 Hz while paused (see `_scheduleNextFrame()` design note),
  // and the HUD is hidden via `_setHudHidden()` to silence its CSS animations
  // and any composite work. PAUSE_RESUME and PAUSE_MENU are the unpause
  // channels; both must restore the HUD + wake the loop.
  // §12.12 Unified unpause path. _syncAudioCtxState() handles ctx.resume
  // (only if policy says we need audio — gameplay yes, transitioning to
  // menu no). _flushScheduledFrame cancels the 5 Hz pause throttle so the
  // next frame runs immediately rather than after the 200 ms setTimeout.
  eventBus.on(Events.PAUSE_RESUME, () => {
    lastTime = performance.now();
    _setHudHidden(false);
    _syncAudioCtxState();
    _flushScheduledFrame();
  });
  eventBus.on(Events.PAUSE_MENU, () => {
    lastTime = performance.now();
    _setHudHidden(false);
    _syncAudioCtxState();
    _flushScheduledFrame();
  });

  // §12.12 State-aware resource sync. Fires on every game-state transition.
  // Three responsibilities:
  //   (a) Stop looping audio when LEAVING a gameplay state, so a thruster
  //       hum or ΔV alarm doesn't drone over the briefing / shop / game-over
  //       screen. (Previously done per-frame in the !isActive branch — moved
  //       here so it fires once per transition instead of 120 ×/sec.)
  //   (b) _syncAudioCtxState — suspend ctx when entering menu / briefing / shop
  //       (no audio needed), resume when entering gameplay.
  //   (c) _flushScheduledFrame — the new state's frame interval is different
  //       (e.g. menu 30 fps → gameplay display-refresh); reschedule now rather
  //       than letting the old throttle's setTimeout(33 ms) delay the first
  //       gameplay frame.
  eventBus.on(Events.STATE_CHANGE, ({ from, to }) => {
    const gameplayStates = [
      GameStates.ORBITAL_VIEW,
      GameStates.APPROACH,
      GameStates.INTERACTION,
    ];
    const wasGameplay = gameplayStates.includes(from);
    const nowGameplay = gameplayStates.includes(to);
    if (wasGameplay && !nowGameplay && audioSystem) {
      // Leaving gameplay — kill loops defensively.
      if (typeof audioSystem.stopThrusterHum === 'function') audioSystem.stopThrusterHum();
      if (typeof audioSystem.stopDeltaVAlarm === 'function') audioSystem.stopDeltaVAlarm();
      if (typeof audioSystem.stopForgeHum === 'function') audioSystem.stopForgeHum();
    }
    _syncAudioCtxState();
    _flushScheduledFrame();
  });

  window.addEventListener('resize', onResize);

  // --- PR 3 / P1.4: Pause render loop on hidden tab to save CPU/GPU and prevent
  // dt-spike on resume. Also stop any looping audio so it doesn't drone in
  // background tabs. Uses only existing AudioSystem public methods.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // §12.12 Newly hidden — silence loops AND suspend the AudioContext.
      // (Previously only stopped loops; the ctx itself stayed `running` at
      // 44.1 kHz, keeping the audio thread warm. _syncAudioCtxState now
      // suspends it since _shouldAudioRun()→false when hidden.)
      if (audioSystem) {
        if (typeof audioSystem.stopThrusterHum === 'function') audioSystem.stopThrusterHum();
        if (typeof audioSystem.stopDeltaVAlarm === 'function') audioSystem.stopDeltaVAlarm();
        if (typeof audioSystem.stopForgeHum === 'function') audioSystem.stopForgeHum();
        if (typeof audioSystem.stopAmbientLoop === 'function') audioSystem.stopAmbientLoop();
        if (typeof audioSystem.stopLassoWireWhistle === 'function') audioSystem.stopLassoWireWhistle();
        if (typeof audioSystem.stopAlignmentTone === 'function') audioSystem.stopAlignmentTone();
      }
      _syncAudioCtxState();
    } else {
      // Newly visible — reset last-frame timers so next dt is small.
      const now = performance.now();
      lastTime = now;
      lastFrameTime = now;
      _syncAudioCtxState();   // resumes ctx if state policy says so
      _flushScheduledFrame(); // wakes loop (gameLoop's hidden early-return
                              // skipped scheduling the next rAF)
    }
  });

  // §14.1 Window blur/focus — pause sim when the user Cmd-Tabs to another
  // macOS application. `visibilitychange` does NOT fire in this scenario
  // because the browser tab is still on-screen (document.hidden stays false).
  // The `document.hasFocus()` cross-check filters false positives from
  // DevTools gaining focus, iframe focus, or child-popup focus — in those
  // cases the *window* receives `blur` but `document.hasFocus()` often
  // remains true because focus moved within the same browsing context.
  // NOTE: window.blur is not stub-able in the Node test runner (jsdom does
  // not implement the Page Visibility / Focus APIs). Manual browser testing
  // required. See §14.1 in GPU_PROFILING_REPORT.md.
  window.addEventListener('blur', () => {
    // Double-check: if the document still has focus, this is a false
    // positive (e.g. DevTools panel focused within the same window).
    if (document.hasFocus()) return;
    _windowBlurred = true;
    if (audioSystem) {
      if (typeof audioSystem.stopThrusterHum === 'function') audioSystem.stopThrusterHum();
      if (typeof audioSystem.stopDeltaVAlarm === 'function') audioSystem.stopDeltaVAlarm();
      if (typeof audioSystem.stopForgeHum === 'function') audioSystem.stopForgeHum();
      if (typeof audioSystem.stopAmbientLoop === 'function') audioSystem.stopAmbientLoop();
      if (typeof audioSystem.stopLassoWireWhistle === 'function') audioSystem.stopLassoWireWhistle();
      if (typeof audioSystem.stopAlignmentTone === 'function') audioSystem.stopAlignmentTone();
    }
    _syncAudioCtxState();
    // Do NOT call _setHudHidden(true) — when the user alt-tabs back the
    // HUD should still be visible (only hide on actual ESC pause).
    _flushScheduledFrame(); // reschedule at throttled 5 Hz interval
  });
  window.addEventListener('focus', () => {
    _windowBlurred = false;
    const now = performance.now();
    lastTime = now;
    lastFrameTime = now;
    _syncAudioCtxState();
    _flushScheduledFrame();
  });

  // --- Hide loading screen ---
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('hidden');
    setTimeout(() => loadingScreen.remove(), 1500);
  }

  // --- Start in MENU state ---
  gameState.currentState = GameStates.MENU;
  gameFlowManager.transitionToState(GameStates.MENU);

  console.log('[Space Cowboy] Engine initialized. Starting game loop…');

  // PR 3 / P1.6 — Pre-compile shaders before first RAF to avoid first-frame stutter
  // when materials are encountered for the first time during gameplay.
  _bootMark('renderer.compile() — START (synchronous shader compile of all materials + composer passes)');
  try {
    sceneManager.renderer.compile(sceneManager.scene, sceneManager.camera);
  } catch (e) {
    console.warn('[Perf] renderer.compile failed:', e);
  }
  _bootMark('renderer.compile() — END');

  // Sprint 2 / Phase A: attach Perf Report overlay if requested via ?perfReport=1.
  // Defers until SceneManager + DebrisField are constructed so refs are live.
  if (Constants.DEBUG && Constants.DEBUG.PERF_REPORT_OVERLAY) {
    try {
      const boot = captureBootInfo({
        sceneManager,
        avifSupported: isAvifSupported(),
        initialTierReason: (() => {
          try {
            const p = new URLSearchParams(window.location.search);
            return p.get('tier') ? 'url-override' : 'capability-detect';
          } catch (_e) { return 'capability-detect'; }
        })(),
      });
      console.info('[PerfReport] boot snapshot:', boot);
      perfReportOverlay.attach({
        sceneManager,
        debrisField,
        fpsHistory: _fpsHistory,
      }, boot);
    } catch (e) {
      console.warn('[PerfReport] overlay attach failed:', e);
    }
  }

  // Sprint 3 GPU profiling: wire [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)
  // when `?autoProfile=1`. Sweep auto-starts after a 5 s settle so the user
  // can transition to ORBITAL_VIEW first if they want the in-mission state.
  // Expose a global re-trigger so the user can run again in a different state
  // (e.g. captured MENU, now wants IN-MISSION) without reloading.
  if (profileFlags.autoProfile) {
    try {
      const sweep = new AutoProfileSweep({
        sceneManager,
        earth,
        gameState: _gameStateRefForProfile,
      });
      // Global trigger — call this from DevTools after switching game state.
      window.startAutoProfile = () => {
        sweep.start().catch((e) => console.error('[AutoProfile] start() rejected:', e));
      };
      console.info('[AutoProfile] ready — auto-starting in 5 s. To re-run later: call window.startAutoProfile() from DevTools (e.g. after entering ORBITAL_VIEW).');
      setTimeout(() => { window.startAutoProfile(); }, 5000);
    } catch (e) {
      console.warn('[AutoProfile] init failed:', e);
    }
  }

  _bootMark('init() complete — first rAF scheduled');
  _scheduleNextFrame();
}

// ============================================================================
// GAME LOOP
// ============================================================================

/**
 * Diagnostic emitter for `?logPause=1`. Flushes a one-line summary every ~1 s
 * with the current `gameFlowManager.paused` flag, `gameState.currentState`,
 * and the rendered/skipped frame counts since the last emit. Opt-in only
 * (gated by `_logPauseEnabled` at every call site); zero overhead in normal
 * play. Helper lives at module scope so it can be called from inside the
 * gameLoop without re-allocating per frame.
 *
 * @param {number} timestamp - rAF high-res timestamp (ms)
 * @param {boolean} skippedThisFrame - true if pause early-return fired
 */
function _emitPauseDiagnostic(timestamp, skippedThisFrame) {
  if (timestamp - _logPauseLastEmit < 1000) return;
  _logPauseLastEmit = timestamp;
  const rendered = _logPauseFramesRendered;
  const skipped = _logPauseFramesSkipped;
  _logPauseFramesRendered = 0;
  _logPauseFramesSkipped = 0;
  // §12.11 AudioContext state: 'running' while paused = audio scheduler ticking
  // at 44.1 kHz, keeping an efficiency core warm and preventing low-power state.
  const audioCtxState = (audioSystem && audioSystem.ctx)
    ? audioSystem.ctx.state
    : 'n/a';
  // §12.12 frameInterval shows the throttle target the schedule policy picked
  // for this state (0 = display refresh, 33 = 30 fps menu, 200 = 5 fps pause).
  const intervalMs = _getScheduleIntervalMs();
  console.log(
    `[logPause] state=${gameState.currentState} paused=${gameFlowManager.paused} `
    + `hidden=${document.hidden} blurred=${_windowBlurred} `
    + `lastFrameSkipped=${skippedThisFrame} rendered/s=${rendered} skipped/s=${skipped} `
    + `audioCtx=${audioCtxState} frameInterval=${intervalMs}ms`,
  );
}

function gameLoop(timestamp) {
  // §13 boot timeline (?logBoot=1) — one-shot mark on the very first rAF
  // dispatch. The delta from "init() complete — first rAF scheduled" to here
  // measures rAF latency (browser compositor / GPU process startup), separate
  // from the cost of the first render() call itself (marked below).
  if (_logBootEnabled && !_bootFirstFrameMarked) {
    _bootMark('first gameLoop() entry (rAF fired)');
  }
  // We're now running this tick — clear the dedup flag so wakeups can
  // re-schedule. Schedule the next frame only at the end (when we know
  // we want to keep running). Wake hooks call `_scheduleNextFrame()` to
  // restart the loop after an inert period.
  _rafScheduled = false;

  // PR 3 / P1.4 — Skip work entirely when tab is hidden. Reset lastTime so the
  // first frame after resume has a small dt (instead of a multi-second spike).
  // Note: we do NOT schedule the next frame — `visibilitychange` will wake us.
  if (document.hidden) {
    lastTime = timestamp;
    return;
  }
  // §14.1 (revised) — Window blurred (user Cmd-Tabbed to another macOS app).
  // Mirror the document.hidden path EXACTLY: zero work, no rAF rescheduling,
  // browser compositor sleeps. The window `focus` handler calls
  // _flushScheduledFrame() to wake the loop on focus return. The original
  // §14.1 fix only throttled to 5 Hz via _getScheduleIntervalMs(), which kept
  // the GPU busy — the user reported "GPU continues when switching apps".
  // This early-return is the actual pause.
  if (_windowBlurred) {
    lastTime = timestamp;
    return;
  }

  // PR 3 / P1.7 — Opt-in frame cap (default: null → no cap, follow display refresh).
  // Old hard-coded 60 fps gate caused judder on 120/144 Hz displays.
  const frameCap = Constants.PERF.FRAME_CAP;
  if (frameCap !== null) {
    const interval = 1000 / frameCap;
    if (timestamp - lastFrameTime < interval) return;
    // Drift correction: increment by interval, not assign timestamp, so the cap
    // averages cleanly. If we fell behind badly, snap forward to avoid
    // spiral-of-death.
    lastFrameTime += interval;
    if (timestamp - lastFrameTime > interval * 4) lastFrameTime = timestamp;
  } else {
    lastFrameTime = timestamp;
  }

  // Debug: record frame time (pre-existing — runs even when paused, like before)
  if (debugOverlay) {
    const frameTime = timestamp - (lastTime || timestamp);
    debugOverlay.recordFrame(frameTime);
  }

  if (gameFlowManager.paused) {
    audioSystem.stopThrusterHum();
    audioSystem.stopDeltaVAlarm();
    audioSystem.stopForgeHum();
    // §12.12 Suspend ctx via centralised policy helper. Previously inlined
    // the `if (ctx.state === 'running') ctx.suspend()` check; now the helper
    // covers all suspend / resume call sites consistently.
    _syncAudioCtxState();
    // Hide the HUD overlay so CSS animations + any composite work on
    // `.hud-panel` elements stop. Idempotent (no-op if already hidden).
    _setHudHidden(true);
    if (_logPauseEnabled) {
      _logPauseFramesSkipped++;
      _emitPauseDiagnostic(timestamp, true);
      _emitRafCallerDiagnostic(timestamp);
    }
    // Do NOT schedule next rAF — let the browser compositor sleep.
    // `PAUSE_RESUME` / `PAUSE_MENU` event handlers will wake the loop.
    // This is the fix for the "40 % GPU while paused" symptom: previously
    // the rAF callback kept pumping at the display refresh rate (e.g. 120 Hz)
    // even though `sceneManager.render()` was skipped, which kept the
    // browser's compositor in 120 Hz mode and consumed ~40 % of the
    // Renderer-process GPU on macOS.
    return;
  }
  if (_logPauseEnabled) {
    _logPauseFramesRendered++;
    _emitPauseDiagnostic(timestamp, false);
  }
  // Active frame — schedule the next rAF. Placed here (not at the top of
  // the function) so that the `document.hidden` and `gameFlowManager.paused`
  // early-returns above genuinely halt the loop.
  _scheduleNextFrame();

  // Delta time in seconds (cap to prevent spiral of death)
  const realDt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  // PR 4 / P1.5 — Quality tier FPS sampling + auto-adapt.
  // Placed AFTER the paused early-return so we never feed inflated
  // frametimes (pause keeps `lastTime` stale) into the runtimeAdapt window.
  // Uses fresh `realDt` (already cap-clamped) — getLastFps() on DebugOverlay
  // works on the same underlying sample but isn't gated on pause, so we
  // intentionally compute fps locally from realDt here.
  if (realDt > 0) {
    const fps = 1 / realDt;
    if (Number.isFinite(fps) && fps > 0) {
      _fpsHistory.push(fps);
      if (_fpsHistory.length > Constants.PERF.FPS_HISTORY_SIZE) _fpsHistory.shift();
    }
    _framesSinceLastTierChange++;
    // Cadence: every N frames since last tier change. Uses our own counter
    // (not `frameCount`, which only ticks during `isGameplay()` states), so
    // adapt also runs during MENU/BRIEFING where the scene is still rendering.
    //
    // Sprint 3 GPU profiling: `?autoProfile=1` requires tier stability across
    // configurations (otherwise the disable-X delta-vs-baseline is measuring
    // tier-change drift instead of the toggled feature). Skip runtimeAdapt
    // entirely while a profile sweep session is live.
    if (sceneManager && !profileFlags.autoProfile && (_framesSinceLastTierChange % _ADAPT_CHECK_INTERVAL) === 0) {
      const decision = runtimeAdapt({
        currentTier: sceneManager.currentTier,
        fpsHistory: _fpsHistory,
        framesSinceLastChange: _framesSinceLastTierChange,
        threshold: Constants.PERF.ADAPT_FPS_THRESHOLD,
        cooldownFrames: Constants.PERF.ADAPT_COOLDOWN_FRAMES,
        // Sprint 2 / PR B — auto-upshift gate. Wider cooldown + threshold
        // creates a hysteresis band that prevents tier ping-pong.
        upshiftThreshold: Constants.PERF.ADAPT_UPSHIFT_FPS_THRESHOLD,
        upshiftCooldownFrames: Constants.PERF.ADAPT_UPSHIFT_COOLDOWN_FRAMES,
        historySize: Constants.PERF.FPS_HISTORY_SIZE,
      });
      if (decision.changed) {
        const from = sceneManager.currentTier;
        const to = decision.nextTier;
        const reason = decision.direction === 'up' ? 'auto-upshift' : 'auto-downshift';
        const arrow = decision.direction === 'up' ? '↑' : '↓';
        console.log(`[Perf] tier ${reason} ${arrow}: ${from} → ${to} (median fps ${decision.medianFps.toFixed(1)})`);
        sceneManager.applyTier(to);
        _framesSinceLastTierChange = 0;
        // Clear history so the next decision uses post-change samples only.
        _fpsHistory.length = 0;
        eventBus.emit(Events.PERF_TIER_CHANGED, {
          from,
          to,
          reason,
        });
      }
    }
  }

  // Apply slo-mo factor (Phase 1C — catch juice)
  let dt = realDt;
  if (slowMoTimer > 0) {
    slowMoTimer -= realDt;
    dt *= slowMoFactor;
    if (slowMoTimer <= 0) {
      slowMoFactor = 1.0;
    }
  }

  const currentState = gameState.currentState;

  // --- Always update visuals (scene renders behind menus) ---
  const sunDir = sunLight.update(dt, player.getPosition());
  earth.setSunDirection(sunDir);
  earth.update(dt);
  starfield.update(dt);

  // --- Update entities only in active gameplay states ---
  const isActive = gameState.isGameplay();

  if (isActive) {
    // Advance frame counter + set on debrisField for spatial query caching
    frameCount++;
    debrisField.setFrameId(frameCount);

    // Process input
    inputManager.processInput(dt);

    // F15: Autopilot steering + thrust (before player.update applies thrustInput)
    try { autopilotSystem.update(dt); } catch (e) { console.error('[GameLoop] autopilotSystem:', e); }

    // Collision Avoidance — after autopilot, before player.update (dodge impulse applied to _rcsVelocity)
    try { collisionAvoidanceSystem.update(dt); } catch (e) { console.error('[GameLoop] collisionAvoidance:', e); }

    // Update game state timer
    gameState.update(dt);

    // Update entities (with error boundaries — single system crash won't freeze game)
    try { player.update(dt, sunDir); } catch (e) { console.error('[GameLoop] player.update:', e); }
    try { debrisField.update(dt, player.getPosition(), player.getOrbitalElements()); } catch (e) { console.error('[GameLoop] debrisField:', e); }
    try { activeSatellites.update(dt, player.getPosition()); } catch (e) { console.error('[GameLoop] activeSats:', e); }

    // Update V3 arm manager
    if (armManager) { try { armManager.update(dt); } catch (e) { console.error('[GameLoop] armManager:', e); } }

    // V-4: Sync arm mesh visibility with deploy state (must run AFTER arm._updateDocked)
    try { player.postArmUpdate(); } catch (e) { console.error('[GameLoop] postArmUpdate:', e); }

    // ST-9.11 C-5: Tick launch sequence (flag-gated internally)
    try { launchSequence.tick(dt); } catch (e) { console.error('[GameLoop] launchSequence:', e); }

    // V-7: Drive launch cinematic visual effects (flag-gated internally)
    try { launchCinematic.update(dt); } catch (e) { console.error('[GameLoop] launchCinematic:', e); }

    // V-8: Capture net FSM + visual effects (flag-gated internally)
    try { captureNetSystem.update(dt); } catch (e) { console.error('[GameLoop] captureNetSystem:', e); }
    try { captureNetVisual.update(dt); } catch (e) { console.error('[GameLoop] captureNetVisual:', e); }
    try { furnaceBreakdownVisual.update(dt); } catch (e) { console.error('[GameLoop] furnaceBreakdownVisual:', e); }

    // CP-2: mother-mounted de-spin laser (flag-gated internally)
    try { despinLaser.update(dt); } catch (e) { console.error('[GameLoop] despinLaser:', e); }

    // CP-4 §4: drain deferred teaching overlays (≤1 per QUEUE_DRAIN_INTERVAL_S)
    try { teachingSystem.update(dt); } catch (e) { console.error('[GameLoop] teachingSystem:', e); }

    // Item 3: anti-stuck idle watchdog (1 Hz internally; veteran-gated)
    try { armIdleAdvisor.update(dt); } catch (e) { console.error('[GameLoop] armIdleAdvisor:', e); }

    // CP-4: MissionCoach beat timers (narrative dwell + interactive escalation)
    try { if (missionCoach) missionCoach.update(dt); } catch (e) { console.error('[GameLoop] missionCoach:', e); }
    // CH5: ISS conjunction boss TCA countdown (game-time)
    try { if (issConjunctionBoss) issConjunctionBoss.update(dt); } catch (e) { console.error('[GameLoop] issConjunctionBoss:', e); }
    // CH9: Starlink cascade boss containment window (game-time)
    try { if (starlinkCascadeBoss) starlinkCascadeBoss.update(dt); } catch (e) { console.error('[GameLoop] starlinkCascadeBoss:', e); }

    // V-9: Tier progression visual transition animation
    try { tierVisualManager.update(dt); } catch (e) { console.error('[GameLoop] tierVisualManager:', e); }

    // Update target selector
    try { targetSelector.update(dt); } catch (e) { console.error('[GameLoop] targetSelector:', e); }

    // Update extracted systems
    try { resourceSystem.update(dt); } catch (e) { console.error('[GameLoop] resourceSystem:', e); }
    try { sensorSystem.update(dt, player.getPosition(), debrisField); } catch (e) { console.error('[GameLoop] sensorSystem:', e); }
    try { kesslerSystem.update(dt); } catch (e) { console.error('[GameLoop] kesslerSystem:', e); }

    // Update forge system
    try { forgeSystem.update(dt); } catch (e) { console.error('[GameLoop] forgeSystem:', e); }

    // Update trawl manager (Phase 2 — trawl system)
    try {
      trawlManager.update(dt, {
        playerPos: player.getPosition(),
        debrisField,
        armManager,
        player,
      });
    } catch (e) { console.error('[GameLoop] trawlManager:', e); }

    // Update skills system (Phase 4A — skill tracking)
    if (skillsSystem) {
      try { skillsSystem.update(dt); } catch (e) { console.error('[GameLoop] skillsSystem:', e); }
    }
    if (skillsPane) {
      try { skillsPane.update(dt); } catch (e) { console.error('[GameLoop] skillsPane:', e); }
    }

    // Update lasso system (Phase 4A — projectile flight + reel-in)
    try { lassoSystem.update(dt, player.getPosition(), debrisField, targetSelector.getActiveTarget()); } catch (e) { console.error('[GameLoop] lassoSystem:', e); }

    // Update reward system (Phase 5 Rewards — milestone checks)
    try { rewardSystem.update(dt, armManager); } catch (e) { console.error('[GameLoop] rewardSystem:', e); }

    // Update mission event system (ST-4.D — mid-mission complications)
    try { missionEventSystem.update(dt); } catch (e) { console.error('[GameLoop] missionEventSystem:', e); }

    // Update learning systems (Phase 7 — Codex + Space Weather)
    try { codexSystem.update(dt); } catch (e) { console.error('[GameLoop] codexSystem:', e); }
    try {
      spaceWeatherSystem.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        sunDirection: sunDir,
      });
    } catch (e) { console.error('[GameLoop] spaceWeatherSystem:', e); }

    // Update environment hazards (ST-6.7 — AO, MMOD, Safe-Mode, Radiation, Battery DOD)
    if (environmentSystem) {
      try { environmentSystem.update(dt); } catch (e) { console.error('[GameLoop] environmentSystem:', e); }
    }

    // Update subsystem events (Phase 7B — spacecraft subsystem ambiance)
    try {
      subsystemEvents.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        armManager,
        deployedArms: armManager ? armManager.getDeployedCount() : 0,
        codexProgress: codexSystem ? codexSystem.getProgress().unlocked : 0,
      });
    } catch (e) { console.error('[GameLoop] subsystemEvents:', e); }

    // Update conjunction alert system (Sprint C1)
    try {
      conjunctionSystem.update(dt, gameState, debrisField.debrisList,
        player.getPosition(), player.getVelocity(), inputManager.isArmPilotMode());
    } catch (e) { console.error('[GameLoop] conjunctionSystem:', e); }

    // Update power distribution (warnings for dangerous configs)
    try {
      powerDistribution.update(dt, {
        armsDeployed: armManager ? armManager.getDeployedCount() : 0,
      });
    } catch (e) { console.error('[GameLoop] powerDistribution:', e); }

    // Check altitude game over
    const alt = player.getAltitudeKm();
    if (alt < Constants.LEO_MIN_ALT) {
      gameFlowManager.transitionToState(GameStates.GAME_OVER, 'reentry');
    }

    // Fuel game-over is now handled by ResourceSystem → Events.RESOURCE_DEPLETED event

    // Approach state logic — Sprint 2 / PR A — scratch-output variant.
    if (currentState === GameStates.APPROACH && gameFlowManager.approachTarget && gameFlowManager.approachTarget.alive) {
      orbitToSceneCartesianInto(
        gameFlowManager.approachTarget.orbit, _approachCartPos, _approachCartVel
      );
      _approachTargetVec3.set(_approachCartPos.x, _approachCartPos.y, _approachCartPos.z);
      const targetPos = _approachTargetVec3;
      const dist = player.getPosition().distanceTo(targetPos);

      // Update target lock position for camera
      if (cameraSystem) {
        cameraSystem.setLockTarget(targetPos);
      }

      if (dist < 0.005) { // Within 500m → enter interaction
        if (!gameFlowManager.approachComplete) {
          gameFlowManager.approachComplete = true;
          gameFlowManager.transitionToState(GameStates.INTERACTION);
        }
      }
    }

    // --- Camera update via CameraSystem ---
    updateCamera(dt);

    // HUD update
    hud.update(dt, {
      player,
      debrisField,
      activeSatellites,
      targetSelector,
      sensorSystem,
      autopilotSystem,
      cameraSystem,
      armManager,                          // Delegation 3: daughter wireframe + arm count
      forgeState: forgeSystem.getState(),
      cargoStatus: cargoSystem.getStatus(),
    });

    // Orbit MFD update (Phase 6: pass cachedTargets for route planner)
    if (orbitMFD) {
      const target = targetSelector ? targetSelector.getActiveTarget() : null;
      orbitMFD.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        targetOrbit: target ? target.orbit : null,
        selectedTargetId: target ? target.id : null,
        cachedTargets: hud.getCachedTargets(),
      });
    }

    // --- Debris Map update (ST-4.A) ---
    if (debrisMap) {
      debrisMap.update(dt, { debrisField, player, autopilotSystem });
    }

    // ΔV alarm monitoring
    if (armManager) {
      try {
        const budget = armManager.getMassBudget();
        audioSystem.updateDeltaVAlarm(budget.percentage);
      } catch(e) { /* ignore if not ready */ }
    }

    // --- Target Reticle update (Canvas 2D overlay) ---
    if (targetReticle) {
      // ARM PILOT: use daughter arm position/velocity so distances, closure
      // rates, and range indicators are accurate from the arm's perspective.
      let reticlePos = player.getPosition();
      let reticleVel = player.getVelocity();
      if (inputManager && inputManager.isArmPilotMode() && cameraSystem) {
        const pilotArm = cameraSystem.getPilotedArm();
        if (pilotArm && pilotArm.position) {
          reticlePos = pilotArm.position.clone();
          // Arm velocity is in scene units/s — convert to km/s like player velocity
          if (pilotArm.velocity) {
            const v = pilotArm.velocity;
            const toKmS = 1 / Constants.SCENE_SCALE;
            reticleVel = { x: v.x * toKmS, y: v.y * toKmS, z: v.z * toKmS };
          }
        }
      }
      // During ARM_PILOT + STATION_KEEP we want the on-screen target brackets
      // to fade away so the pilot can focus on the one piece of debris they're
      // working on (no visual clutter from neighbouring debris reticles).
      const _pilotArmForReticle = (inputManager.isArmPilotMode() && cameraSystem)
        ? cameraSystem.getPilotedArm() : null;
      const _skTargetIdForReticle = (_pilotArmForReticle
          && _pilotArmForReticle.state === Constants.ARM_STATES.STATION_KEEP
          && _pilotArmForReticle._stationKeepTarget)
        ? _pilotArmForReticle._stationKeepTarget.id : null;
      targetReticle.update(dt, {
        debrisField,
        activeSatellites,
        playerPos: reticlePos,
        playerVel: reticleVel,
        targetSelector,
        playerOrbit: player.orbit,
        skTargetId: _skTargetIdForReticle,
        telemetry: {
          deltaVSpent: player.getDeltaVSpent(),
          thrustDirection: player.getThrustDirection(),
          lastThrustType: player.getLastThrustType(),
        },
      });
    }

    // --- Nav Sphere update (Canvas 2D radar) ---
    if (navSphere) {
      const _pilotArm = (inputManager.isArmPilotMode() && cameraSystem) ? cameraSystem.getPilotedArm() : null;
      navSphere.update(dt, {
        playerPos: player.getPosition(),
        playerVel: player.getVelocity(),
        debrisField,
        activeSatellites,
        sunDirection: sunDir,
        targetSelector,
        sensorSystem,
        armManager,
        pilotedArmId: _pilotArm ? _pilotArm.id : null,
      });
    }

    // Debris Wireframe update is now handled by HUD.update() (integrated layout)

    // --- Docking Reticle update (ARM PILOT overlay) ---
    if (dockingReticle) {
      if (inputManager.isArmPilotMode() && cameraSystem) {
        const pilotArm = cameraSystem.getPilotedArm();
        if (pilotArm) {
          dockingReticle.setArmData(pilotArm, pilotArm.target);
          dockingReticle.setVisible(true);
        }
      } else {
        dockingReticle.setVisible(false);
      }
      dockingReticle.update(dt);
    }

    // --- Velocity Streaks update (Canvas 2D acceleration overlay) ---
    if (velocityStreaks) {
      velocityStreaks.update(dt);
    }

    // --- ST-5.2: Trail System update (3-D ribbon geometry rebuild) ---
    if (trailSystem) {
      try { trailSystem.update(dt); } catch (e) { console.error('[GameLoop] trailSystem:', e); }
    }

    // --- Comms System update ---
    if (commsSystem) {
      commsSystem.update(dt, { debrisField, player, activeSatellites });
    }
  } else {
    // §12.12 Per-frame `stopThrusterHum / stopDeltaVAlarm / stopForgeHum`
    // calls removed from this branch — moved to the STATE_CHANGE listener
    // (init() block above) which fires once per transition instead of
    // 30-120 times per second across menu / briefing / shop screens. The
    // calls were idempotent (no-ops if already stopped), so removing them
    // here has no behavioural effect.

    // Menu/briefing/shop states — still animate scene slowly
    try { player.update(dt * 0.1, sunDir); } catch (e) { console.error('[GameLoop] player.update (bg):', e); }
    try { debrisField.update(dt * 0.1); } catch (e) { console.error('[GameLoop] debrisField (bg):', e); }
    try { activeSatellites.update(dt * 0.1); } catch (e) { console.error('[GameLoop] activeSats (bg):', e); }
    if (armManager) { try { armManager.update(dt * 0.1); } catch (e) { console.error('[GameLoop] armManager (bg):', e); } }
    try { player.postArmUpdate(); } catch (e) { /* bg visibility sync */ }

    // Camera still follows (slow) for nice menu background
    updateCamera(dt);
  }

  // --- Debug overlay update ---
  if (debugOverlay && debugOverlay.visible) {
    const renderer = sceneManager.getRenderer();
    const renderInfo = renderer ? renderer.info : {};
    debugOverlay.update({
      gameState: gameState.currentState,
      cameraView: cameraSystem ? cameraSystem.getView() : '?',
      debrisCount: debrisField ? debrisField.getAliveCount() : 0,
      bgDebrisCount: debrisField ? (debrisField.backgroundCount || 0) : 0,
      activeSatCount: activeSatellites ? activeSatellites.getCount() : 0,
      armsDeployed: armManager ? armManager.getDeployedCount() : 0,
      armsDocked: armManager ? armManager.getDockedCount() : 0,
      armsExpended: armManager ? armManager.getExpendedCount() : 0,
      drawCalls: renderInfo.render?.calls || 0,
      triangles: renderInfo.render?.triangles || 0,
      textures: renderInfo.memory?.textures || 0,
    });
  }

  // --- Render ---
  // ST-6.4: When strategic map is open, render map scene directly (no composer);
  // otherwise use normal EffectComposer pipeline.
  // §13 boot timeline (?logBoot=1) — bracket the first render() call to
  // separate "rAF dispatch latency" (gameLoop entry mark above) from the
  // actual GPU work on the first frame (lazy Metal pipeline state object
  // compile, 16K texture upload + mipmap-gen — both deferred by Three.js
  // until first use even though renderer.compile() was called at boot).
  // Also wrap EVERY render() to feed the spike-detector for post-boot spikes
  // (e.g. entering ORBITAL_VIEW, first time atmosphere/clouds bind, etc.).
  const _bootFirstRenderCall = (_logBootEnabled && !_bootFirstFrameMarked);
  const _bootRenderStart = _logBootEnabled ? performance.now() : 0;
  if (_bootFirstRenderCall) {
    _bootMark('first sceneManager.render() — START');
  }
  if (strategicMap && strategicMap.isOpen()) {
    strategicMap.update(dt);
    strategicMap.render();
  } else {
    sceneManager.render();
  }
  if (_bootFirstRenderCall) {
    _bootMark('first sceneManager.render() — END');
  }
  if (_logBootEnabled) {
    _bootSpikeDetect(performance.now() - _bootRenderStart);
  }

  // §13 boot-timeline: mark the very first rendered frame. Continuous capture
  // mode — user calls window.__dumpBootTimeline() from DevTools when they want
  // a snapshot; we still emit one auto-summary after 5 s to confirm the
  // diagnostic is working end-to-end. Idempotent via `_bootFirstFrameMarked`.
  if (_logBootEnabled && !_bootFirstFrameMarked) {
    _bootFirstFrameMarked = true;
    _bootMark('first frame rendered (top-of-gameLoop work + render() done)');
    setTimeout(() => _emitBootTimeline('first frame + 5 s settle (auto)'), 5000);
  }

  // PR 6 / P3.11: GPU probe — poll completed timer queries every frame
  // while the probe is enabled. Two phases:
  //   1. Startup probe (samples until GPU_PROBE_FRAMES, then evaluates tier).
  //   2. AutoProfileSweep (Sprint 3) — keeps the probe alive past the
  //      startup window when `?autoProfile=1` is set so the sweep can
  //      measure each config.
  if (sceneManager.gpuProbe && sceneManager.gpuProbeEnabled) {
    sceneManager.gpuProbe.poll();
  }
  if (!_gpuProbeComplete && sceneManager.gpuProbeEnabled && sceneManager.gpuProbe) {
    const probe = sceneManager.gpuProbe;
    if (probe.getSampleCount() >= Constants.PERF.GPU_PROBE_FRAMES) {
      _gpuProbeComplete = true;
      const medianMs = probe.getMedianMs();
      const threshold = Constants.PERF.GPU_PROBE_THRESHOLD_MS;
      console.log(`[Perf] GPU probe complete: median=${medianMs.toFixed(2)}ms threshold=${threshold}ms (${probe.getSampleCount()} samples)`);
      // Sprint 3 GPU profiling: skip the tier-downshift action when
      // `?autoProfile=1` is set. The sweep must measure each config at a
      // fixed tier; an auto-downshift in the first 0.5 s of the session
      // would render every later config's delta meaningless. The downshift
      // recommendation is still logged for visibility.
      if (medianMs > threshold && sceneManager.currentTier !== 'LOW' && !profileFlags.autoProfile) {
        // Find one step down from the current tier
        const idx = TIER_ORDER.indexOf(sceneManager.currentTier);
        const nextTier = (idx >= 0 && idx < TIER_ORDER.length - 1)
          ? TIER_ORDER[idx + 1]
          : 'LOW';
        const from = sceneManager.currentTier;
        console.log(`[Perf] GPU probe → tier downshift: ${from} → ${nextTier} (median ${medianMs.toFixed(1)}ms > ${threshold}ms)`);
        sceneManager.applyTier(nextTier);
        _framesSinceLastTierChange = 0;
        _fpsHistory.length = 0;
        eventBus.emit(Events.PERF_TIER_CHANGED, {
          from,
          to: nextTier,
          reason: 'gpu-probe',
        });
      } else if (medianMs > threshold && profileFlags.autoProfile) {
        console.log(`[Perf] GPU probe: median ${medianMs.toFixed(1)}ms > ${threshold}ms but tier downshift suppressed (?autoProfile=1)`);
      }
      // Sprint 3 GPU profiling: keep the probe alive when `?autoProfile=1`
      // is set. Otherwise dispose to free GL queries (the original PR 6
      // behaviour — startup probe is one-shot).
      if (profileFlags.autoProfile) {
        probe.resetSamples();
        console.log('[Perf] GPU probe kept alive for AutoProfileSweep (?autoProfile=1)');
      } else {
        sceneManager.gpuProbeEnabled = false; // Stop wrapping render with queries
        probe.dispose();
      }
    }
  }

  // PR 6 / P3.15: Draw-call profiling (every 60 frames when ?profile=1).
  if (Constants.DEBUG.LOG_DRAW_CALLS) {
    _profileFrameCount++;
    if (_profileFrameCount >= 60) {
      _profileFrameCount = 0;
      const info = sceneManager.renderer.info.render;
      console.log(`[Profile] calls=${info.calls} triangles=${info.triangles} points=${info.points} lines=${info.lines}`);
    }
  }
}

// ============================================================================
// CAMERA UPDATE
// ============================================================================

/**
 * Update camera via CameraSystem.
 * @param {number} dt - Delta time in seconds
 */
function updateCamera(dt) {
  if (!cameraSystem) return;

  const playerPos = player.getPosition();
  const playerVel = player.getVelocity();
  const playerQuat = player.quaternion;

  // Compute thrust magnitude for head-bob
  const thrustMag = Math.sqrt(
    player.thrustInput.x ** 2 +
    player.thrustInput.y ** 2 +
    player.thrustInput.z ** 2
  );
  cameraSystem.setThrustMagnitude(Math.min(1.0, thrustMag * 1000));

  // Update the camera system
  cameraSystem.update(dt, playerPos, playerVel, playerQuat);

  // Inspection callouts — run AFTER the camera so band/facing use this frame's
  // camera pose. Cheap no-op internally unless inspection is engaged.
  if (motherCallouts) {
    try { motherCallouts.update(dt, armManager); }
    catch (e) { console.error('[GameLoop] motherCallouts:', e); }
  }
}


// ============================================================================
// RESIZE HANDLER
// ============================================================================

function onResize() {
  sceneManager.resize();
}

// ============================================================================
// START
// ============================================================================

init();
