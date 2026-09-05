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
import { Starfield, raDec2xyz } from './scene/Starfield.js';
import { BRIGHT_STARS, CONSTELLATION_FIGURES, galacticBasis } from './scene/starCatalog.js';
import { SunLight } from './scene/SunLight.js';
import { launchCinematic } from './scene/LaunchCinematic.js';
import { tierVisualManager } from './scene/TierVisualManager.js';

import { PlayerSatellite } from './entities/PlayerSatellite.js';
import { DebrisField } from './entities/DebrisField.js';
import { regimeFromStartOrbit } from './entities/CatalogConverter.js';
import { computeStartOrbit } from './systems/startOrbitMath.js';
import { ActiveSatellites } from './entities/ActiveSatellite.js';
import { ArmManager } from './entities/ArmManager.js';
import { orbitToSceneCartesianInto } from './entities/OrbitalMechanics.js';
import { CeremonyTimeScale } from './systems/CeremonyTimeScale.js';

// Systems
import { scoringSystem } from './systems/ScoringSystem.js';
import { targetSelector } from './systems/TargetSelector.js';
import { audioSystem } from './systems/AudioSystem.js';
import { CameraSystem } from './systems/CameraSystem.js';
import { CommsSystem } from './systems/CommsSystem.js';
import { ResourceSystem } from './systems/ResourceSystem.js';
import { SensorSystem } from './systems/SensorSystem.js';
import { dossierSystem } from './systems/DossierSystem.js';
import { kesslerSystem } from './systems/KesslerSystem.js';
import { CargoSystem } from './systems/CargoSystem.js';
import { ForgeSystem } from './systems/ForgeSystem.js';
import { ConjunctionSystem } from './systems/ConjunctionSystem.js';
import { InputManager } from './systems/InputManager.js';
import { gameFlowManager } from './systems/GameFlowManager.js';
import { AutoLockController } from './systems/AutoLockController.js';
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
import { tetherReel } from './systems/TetherReel.js';
import { RewardSystem } from './systems/RewardSystem.js';
import { CodexSystem } from './systems/CodexSystem.js';import { loadCodexData } from './systems/codex/codexData.js';
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
// Whale-in-cone phase 3: main ALSO imports it directly for the scenario probe's
// bounding-radius reads (getBoundingRadius is a static cached accessor).
import { DebrisWireframe } from './ui/DebrisWireframe.js';
import { drawnRimRadiusAtDepth, contentsFloorRadius, contentsFloorRadiusBox, contentsFloorClamped, contentsBoxValid, chordBoxPenetration } from './ui/NetMeshKit.js';
import { DockingReticle } from './ui/DockingReticle.js';
import { VelocityStreaks } from './ui/VelocityStreaks.js';
import { TrailSystem } from './ui/TrailSystem.js';
import { DebugOverlay } from './ui/DebugOverlay.js';
import { SweepReportUI } from './ui/SweepReportUI.js';
import { CodexViewerUI } from './ui/CodexViewerUI.js';
import { GlossaryState } from './systems/codex/GlossaryState.js';
import { HotkeyOverlay } from './ui/HotkeyOverlay.js';
import { SkillsPane } from './ui/hud/SkillsPane.js';
import { TeachingSystem } from './systems/TeachingSystem.js';
import { armIdleAdvisor } from './systems/ArmIdleAdvisor.js';
import { guidanceTelemetry } from './systems/GuidanceTelemetry.js';
import { navRecoveryAdvisor } from './systems/NavRecoveryAdvisor.js';
import { targetAcquisition } from './systems/TargetAcquisition.js';
import { missionMilestones } from './systems/MissionMilestones.js';
import { cityLabels } from './scene/CityLabels.js';
import { launchCameo } from './scene/LaunchCameo.js';
import { menuOrbitPreview } from './systems/MenuOrbitPreview.js';
import { ambientLaunchScheduler } from './systems/AmbientLaunchScheduler.js';
import { TeachingOverlay } from './ui/TeachingOverlay.js';
import { OnboardingDirector } from './systems/OnboardingDirector.js';
import { GuidanceDirector } from './systems/GuidanceDirector.js';
import { settingsManager } from './systems/SettingsManager.js';
import { persistenceManager } from './systems/PersistenceManager.js';
import { StrategicMap } from './ui/StrategicMap.js';
import { WheelRouter } from './systems/WheelRouter.js';
import { LadderController } from './systems/LadderController.js';
import { LadderAudioBeds } from './systems/LadderAudioBeds.js';
import { FloorMask } from './ui/hud/FloorMask.js';
import { LadderViewStore } from './systems/LadderViewStore.js';
import { LadderSfx } from './systems/LadderSfx.js';
import { NavcomFloor } from './systems/NavcomFloor.js';
import { ProxNetFloor } from './systems/ProxNetFloor.js';
import { SdaFloor } from './systems/SdaFloor.js';
import { HullCamFloor } from './systems/HullCamFloor.js';
import { RefitPane } from './ui/RefitPane.js';
import { LibraryPane, ONE_PANE_BREAKPOINT_PX } from './ui/LibraryPane.js';
import { ArchiveFloor } from './systems/ArchiveFloor.js';
import { TimeAuthority } from './systems/TimeAuthority.js';
import { FloorContract } from './core/FloorContract.js';
import { RailIndicator } from './ui/RailIndicator.js';
import { TouchControls } from './ui/TouchControls.js';
import { TouchTelemetry } from './ui/touchTelemetry.js';
import { captureNetVisual, worldTumbleForKitAttitude, boxRowsForKitAttitude } from './ui/CaptureNetVisual.js';
import { furnaceBreakdownVisual } from './ui/FurnaceBreakdownVisual.js';
import { captureNetSystem, isInsideCone, coneRadiusAtDepth } from './entities/CaptureNet.js';
import perfReportOverlay, { captureBootInfo } from './ui/PerfReportOverlay.js';
import { isAvifSupported } from './scene/Earth.js';
import { profileFlags } from './core/ProfileFlags.js';
import { devShotGate } from './core/DevShotGate.js';
import { installBlackFrameProbe } from './core/BlackFrameProbe.js';
import { viewCover, coverSkipsPaint } from './ui/viewCover.js';
import { AutoProfileSweep } from './systems/AutoProfileSweep.js';
import { gameState as _gameStateRefForProfile } from './core/GameState.js';


// ============================================================================
// GLOBALS
// ============================================================================
let sceneManager;
let earth;
let starfield;
let sunLight;
// Black-flicker triage: `?bfp=1|2` in-page probe (js/core/BlackFrameProbe.js).
// Null in normal play — the per-frame hook below is a single falsy check.
let blackFrameProbe = null;
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
  console.info('[logPause] enabled via ?logPause=1. Per-second pause/state diagnostic active');
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
  console.group(`[logBoot] BOOT TIMELINE. ${reason} (T0 = main.js eval, after imports)`);
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
  console.info('[logBoot] enabled via ?logBoot=1. Boot timeline diagnostic active. Call window.__dumpBootTimeline() from DevTools at any moment to snapshot.');
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
// §14.1-K (2026-08-30 black-rectangle root cause): last keepalive present
// timestamp while blurred. See the gameLoop blurred branch.
let _blurKeepalivePresentTs = 0;
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
 // §14.1 (revision 4, 2026-08-31) Window blurred (Cmd-Tab / click into another
 // app): the window is still ON-SCREEN, so run at ~30 fps — bfp evidence
 // (dump-1788177490) showed black-rectangle flicker persisting even with 5 Hz
 // keepalive presents; a 30 fps present cadence leaves the compositor no purge
 // window at all. The sim stays frozen (gameLoop blurred branch); only
 // present cost remains. Truly hidden tabs still fully halt above.
 if (_windowBlurred) return 33;
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

// Zoom Ladder G1 (post-M3 play-test): runtime-adapt holdoff while the ladder is
// actually moving (mid-ride, or within the derived 900 ms gesture+settle window
// of the last ladder input — LadderController.ADAPT_HOLDOFF_MS). Ride frames
// are camera-flight transients (FOV/near/far swaps, full-disc Earth fill,
// first-use texture binds); feeding them to runtimeAdapt flip-flops the tier on
// boundary machines (play-test log: GPU probe median 7.53 ms vs 7 ms threshold,
// HIGH→MEDIUM→HIGH inside 40 s) and every applyTier() rebuild is a visible
// full-screen flash. While held off we neither SAMPLE fps history nor RUN the
// check, so a post-ride decision can't be made from mid-ride frames either.
// Flag-off byte-identical: Constants.LADDER.ENABLED short-circuits first, and
// with the flag off the controller can never engage anyway.
const _ladderAdaptHoldoff = (nowMs) => !!(Constants.LADDER && Constants.LADDER.ENABLED &&
  ladderController && ladderController.adaptHoldoff && ladderController.adaptHoldoff(nowMs));

// PR 6 / P3.15 — Draw-call profiling frame counter (separate from _ADAPT_CHECK_INTERVAL).
let _profileFrameCount = 0;

// PR 6 / P3.11 — GPU probe one-shot flag. Once the probe window completes
// (GPU_PROBE_FRAMES samples), we check the median and optionally downshift.
// After that, the flag flips true and the probe is disabled for the session.
let _gpuProbeComplete = false;

// Perf warmup/settle guard (Constants.PERF.ADAPT_WARMUP_MS). Timestamp (rAF /
// performance.now clock) before which adaptive tier changes are suppressed, so
// one-time startup transients (shader compile, texture upload, scene build)
// can't trigger a spurious permanent downgrade. Initialised on the first active
// frame and re-armed on each GAME_STATE_CHANGE into a heavier (non-MENU) state.
let _perfSettleUntil = 0;

// Catch slo-mo state (Phase 1C)
let slowMoTimer = 0;
let slowMoFactor = 1.0;

// Sprint 2 / PR A — scratch outputs for `orbitToSceneCartesianInto` in the
// approach-distance check (per-frame while in APPROACH state).
const _approachCartPos = { x: 0, y: 0, z: 0 };
const _approachCartVel = { x: 0, y: 0, z: 0 };
const _approachTargetVec3 = new THREE.Vector3();
// Scratch for the per-frame lasso forward-dir (avoids a Vector3 alloc each frame).
const _lassoVelScratch = new THREE.Vector3();

// Entities
let player;
let debrisField;
let activeSatellites;
let armManager;
let motherCallouts;
// Systems (targetSelector, kesslerSystem, trawlManager imported as singletons above)
let cameraSystem;
let commsSystem;
let autoLockController;
/** Reward-first spine: live OUT-OF-RANGE flag for the selected target, fed into
 *  the OnboardingDirector contextProvider for the `range_wall` gate. */
let _onboardingTargetOutOfRange = false;
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
let glossaryState;
let hotkeyOverlay;
let teachingSystem;
let teachingOverlay;
let onboardingDirector;
let guidanceDirector;
let strategicMap;

// Zoom Ladder (S2 skeleton — behind Constants.LADDER.ENABLED)
let wheelRouter;
let ladderController;
let railIndicator;
let touchControls;

// Zoom Ladder S3 — the ONE world-time choke point (T2). Owns dtWorld/warp; pins
// the shipped base rate whenever the ladder is disengaged (byte-identical).
let timeAuthority;
// Reused per-frame arg object for timeAuthority.update (M3 review: the update
// runs on the shipped flag-off path too, so the args must not allocate per
// frame; TimeAuthority.update destructures synchronously and retains nothing).
const _taFrameArgs = { dtReal: 0, active: false, targetCap: 1, dangerActive: false };
// D10 pane-open signal (08-workbench §1): true while a workbench pane (REFIT /
// TECH LIBRARY) is open — feeds TimeAuthority.calmCap so time settles to 1×
// while reading. Written by _syncWorkbenchPanes (the ONE pane edge, Session B)
// from both panes' onOpenChange; false whenever the ladder is off (the sync
// helper only exists inside the LADDER.ENABLED gate).
let _workbenchPaneOpen = false;
// Q10 level-phase sound edge state: last frame's camera leveling flag (rise
// edge → one LadderSfx settle cue). False whenever the ladder is disengaged.
let _ladderLevelingPrev = false;

// Zoom Ladder F6 (NAVCOM) floor content orchestrator (S5). Constructed in the
// ladder block, injected into LadderController (activates/ticks on F6), and
// ticked explicitly from the loop with the live projector below.
let navcomFloor;

// Zoom Ladder Wave-2 floor content orchestrators (S4 serial hub wire): F5
// (PROX NET), F7 (SDA), F3 (HULL CAM). Same lifecycle as navcomFloor —
// constructed in the ladder block, injected into LadderController (which owns
// activate/deactivate + Space verbs), ticked from the loop below (single-ticker
// pattern). Inert while LADDER.ENABLED is false (never activated).
let proxNetFloor;
let sdaFloor;
let hullcamFloor;
let archiveFloor;
// Zoom Ladder Wave 5 (2) — the F3 REFIT pane (08-workbench §2, left pane on
// the seven-subsystem index). UNLIKE the floor orchestrators above it is only
// CONSTRUCTED while Constants.LADDER.ENABLED is true (the same live flag every
// ladder gate reads): a ?ladder=0 boot builds no pane, wires no onPartClick,
// and the shipped part-click → Library path stays byte-identical (pinned in
// test-LadderController).
let refitPane;
// Zoom Ladder Wave 5 (Session B) — the F3 TECH LIBRARY pane (08-workbench §2,
// right pane: the shipped viewer's entry as a side pane). Same construction
// law as refitPane: built ONLY while Constants.LADDER.ENABLED is true, so a
// ?ladder=0 boot builds no pane and every shipped codex path (part click →
// full-screen Library, I key, deep links) stays byte-identical (pinned in
// test-LadderController).
let libraryPane;
// Zoom Ladder Wave 5 (Session G) — the PLAYER-owned view store (D5 "rooms you
// can rearrange": FloorMask's per-floor room memory + the F3 pane open-state,
// its own key `sc_ladder_view_v1`, separate from the run save — the
// SettingsManager rule). Same construction law as the panes: built ONLY while
// Constants.LADDER.ENABLED is true, so a ?ladder=0 boot never reads or writes
// the key (pinned in test-LadderController).
let ladderViewStore;

// Zoom Ladder per-floor audio beds (S6, Wave-3 serial hub wire): constructed
// in the ladder block against AudioSystem GETTERS (the unlock pattern) and
// injected into LadderController, which crossfades beds on floor arrivals and
// fades to silence on disengage. Inert while LADDER.ENABLED is false.
let ladderAudioBeds;
// Zoom Ladder Wave-4 FloorMask (08-workbench D8/§4 map rule): per-floor HUD
// pane tiers (shown/faint/gone) over the pane-density rung layer + the
// always-on vitals line. Constructed in the ladder block against the live
// hud; injected into LadderController (applies rooms on floor arrivals,
// restores the shipped cockpit on disengage). Inert while LADDER.ENABLED is
// false (never driven).
let ladderFloorMask;
// Zoom Ladder interaction sfx (S4 Wave 4, serial hub wire): constructed in the
// ladder block against AudioSystem GETTERS (the unlock pattern) and injected
// into LadderController as the optional `sfx` dep — ratchet from `charge`,
// clunk from `cross.direction`, flick tick, undo chime (06-core-api: audio is
// not a decision type). Inert while LADDER.ENABLED is false.
let ladderSfx;

// Zoom Ladder F6 world→screen projector, built off the live ladder camera.
// NavcomFloor consumes it to place the cluster ring+count icons and the ship
// chevron; |z| <= 1 keeps only points inside the camera near/far planes visible.
const _navProjV = new THREE.Vector3();
function navcomProject(worldVec3) {
  const cam = cameraSystem && cameraSystem.camera;
  if (!cam) return { x: 0, y: 0, visible: false };
  const v = _navProjV.copy(worldVec3).project(cam);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    visible: Math.abs(v.z) <= 1,
  };
}

// Zoom Ladder F3 (HULL CAM) scratch vector: ship-local → world → screen
// projector composition + one-time anchor resolution (no per-frame allocation).
const _hullTmp = new THREE.Vector3();
// Session C: the LIBRARY pane's photo subject projection scratch (read on the
// pane's open / entry edge only — never per frame; one reused vector).
const _photoTmp = new THREE.Vector3();

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
    // Zoom Ladder per-boot override (iPad port, 2026-09-02). The shipped
    // source default is TRUE since 2026-09-02 (owner flip; test-FloorContract
    // pins it), so ?ladder=1 is a no-op and ?ladder=0 is the useful one: a
    // symmetric force-OFF for this boot only (A/B against the legacy zoom).
    // Every consumer (LadderController engage, WheelRouter ownership,
    // InputManager floor keys, CameraSystem anchors, main's adapt-holdoff)
    // reads Constants.LADDER.ENABLED LIVE, so a boot-time flip is
    // behaviorally identical to shipping the other value.
    {
      const lp = urlParams.get('ladder');
      if (lp === '1') {
        Constants.LADDER.ENABLED = true;
        console.info('[Ladder] enabled via ?ladder=1 (dev/test boot override)');
      } else if (lp === '0') {
        Constants.LADDER.ENABLED = false;
      }
    }
    // Guidance cleanup (Phase 4): ?guidanceLog=1 enables dev-only guidance
    // telemetry (prompt→action latency, contradiction + overlap counts).
    // No-op in the default build; snapshot via window.__dumpGuidanceLog().
    if (urlParams.get('guidanceLog') === '1') {
      guidanceTelemetry.enable();
    }
    // Sprint 3 GPU profiling: ?autoProfile=1 enables [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)
    // — scheduled near the end of init() once SceneManager + Earth exist.
    if (profileFlags.autoProfile) {
      console.info('[AutoProfile] scheduled via ?autoProfile=1. Will auto-start once scene settles. To re-run in another game state, call window.startAutoProfile() from DevTools.');
    }
  } catch (_e) {
    // Non-browser env or malformed URL — ignore.
  }

  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    console.error('[main] #game-canvas not found');
    // F7: this is a non-throwing early return, so the index.html error/rejection
    // handlers won't fire — surface the failure card explicitly so boot doesn't
    // hang on the loading screen with no feedback.
    if (typeof window !== 'undefined' && typeof window.__showBootFailure === 'function') {
      window.__showBootFailure('SYSTEMS OFFLINE', 'Render canvas missing — the page did not load correctly.');
    }
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
  // Black-flicker triage: `?bfp=1|2` installs the self-serve verdict probe
  // (badge + rate-limited console warns). Returns null when the flag is off.
  blackFrameProbe = installBlackFrameProbe({ sceneManager, earth });
  _bootMark('Earth constructor returned (textures still decoding async)');

  // --- Starfield (background) ---
  starfield = new Starfield(scene);

  // --- Sun Light (dynamic day/night) ---
  sunLight = new SunLight(scene, sceneManager);

  // --- Player Satellite ---
  player = new PlayerSatellite(scene);

  // P2 aft flower — ON by default (owner ruling 2026-08-27, FEATURE_FLAGS.
  // FLOWER_PREINSTALLED: "just flip it on. you can flip it off later p3").
  // Both pairs install at boot through the SAME applyUpgrade effect path a
  // shop purchase drives (stowed bud — press O). While the flag is ON the
  // two shop rows are hidden (ShopScreen) so nobody pays for hardware
  // already aboard. The `?flower` URL param remains as the preview override
  // for when P3 flips the flag off:
  //   ?flower or ?flower=2 → both pairs   ?flower=1 → pair A only
  //   ?flower=bloom        → both pairs + slews open to the 90° cargo bloom
  {
    const fp = new URLSearchParams(window.location.search).get('flower');
    const pre = Constants.FEATURE_FLAGS.FLOWER_PREINSTALLED;
    if (pre || fp !== null) {
      player.applyUpgrade({ effect: 'flowerPairA', value: 1 });
      if (!(fp === '1' && !pre)) player.applyUpgrade({ effect: 'flowerPairB', value: 1 });
      if (fp === 'bloom') player.setFlowerPose('CARGO');
    }
  }
  // MLI foil v6: per-material orbital envMap on the gold MLI (near-mirror foil
  // needs a contrasty environment to reflect, not the near-uniform RoomEnvironment
  // that leaves it a smooth brass pipe). scene.environment is unchanged for the
  // rest of the ship/debris. Per-material envMap ignores scene.environmentIntensity;
  // brightness set via envMapIntensity here.
  player.applyFoilEnv(sceneManager.getRenderer(), 1.0); // v6.1 calm: 1.4→1.0
  // Z-layer fix: render the ship in the near-field depth pass. At 1 unit = 100 km
  // with a log-depth buffer + far=500, the ~2 m ship sits on the flat toe of the
  // depth curve and its hull layers (PV cells, seams, caps…) z-fight. The
  // near-field pass re-renders it in a tight depth range (~500× more precision),
  // matching the clean look the menu gets from its ×1e5 scaled hero. Registered
  // AFTER SunLight so registerNearFieldRoot() can tag the scene lights too.
  // GUARDED: a stale service-worker-cached SceneManager.js (older than this
  // main.js) would lack this method — degrade gracefully (sim still boots; the
  // z-fix is simply inactive until the cache refreshes) instead of hard-crashing
  // init into "SYSTEMS OFFLINE". A hard refresh / SW cache bump restores it.
  if (typeof sceneManager.registerNearFieldRoot === 'function') {
    sceneManager.registerNearFieldRoot(player);
  } else {
    console.warn('[main] SceneManager.registerNearFieldRoot missing — likely a ' +
      'stale service-worker cache. Near-field z-fix inactive; hard-refresh to update.');
  }
  _bootMark('Starfield + SunLight + Player constructed');

  // --- Debris Field (ST-6.1: hybrid mode consumes catalogLoader if ready) ---
  // S11(a): the field is ONE orbital regime centred on the boot language's
  // start orbit — the same computeStartOrbit read that GameFlowManager's
  // _applyStartLocation makes on every start path, so the field is co-orbital
  // with the player by construction (register item 38). Register item 50: a
  // mid-menu language switch re-derives the regime on the start path —
  // _applyStartLocation calls DebrisField.reseatFieldRegime (orbits only,
  // same-regime no-op). Per-boot seed, logged so a reported field is
  // reproducible.
  let _fieldRegime = null;
  try {
    _fieldRegime = regimeFromStartOrbit(computeStartOrbit(settingsManager.getLanguageEntry()));
  } catch (e) {
    console.warn('[main] field regime derivation failed, DebrisField default applies:', e?.message);
  }
  const _fieldSeed = (Date.now() >>> 0);
  debrisField = new DebrisField(scene, { catalogLoader, seed: _fieldSeed, fieldRegime: _fieldRegime });
  _bootMark('DebrisField constructed (5 authored + ~795 hazard + 5000 background)');

  // --- Active Satellites ---
  activeSatellites = new ActiveSatellites(scene);

  // --- Config G Arm Manager (Y0 Quad: 4 arms — 2 Weaver + 2 Spinner) ---
  armManager = new ArmManager(scene, player);
  armManager.setDebrisField(debrisField);
  armManager.setCatalogLoader(catalogLoader);    // ST-6.1: active-sat treaty guard
  // z-layer fix (A.6): let docked/close daughters join the near-field depth pass
  // so they aren't occluded by it and don't z-fight the mother's strut-tip collars.
  if (typeof armManager.setSceneManager === 'function') {
    armManager.setSceneManager(sceneManager);
  }

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
  lassoSystem.setSkillsSystem(skillsSystem); // Phase 3 hint-gating + veteran downgrade
  lassoSystem.setPlayer(player); // Phase 1C — cosmetic launch-recoil mesh kick

  // --- Phase 5 Rewards: RewardSystem + SweepReportUI ---
  rewardSystem = new RewardSystem();
  sweepReportUI = new SweepReportUI();

  // --- Phase 7: Learning Systems (Codex + Space Weather + Subsystem Events) ---
  // Codex content is offline-first JSON (data/codex.json). Loaded here and
  // injected; on any failure the system constructs empty (graceful).
  const codexData = await loadCodexData();
  codexSystem = new CodexSystem(codexData);
  // Slice 8: let the manage_codex SM-2 reminder resurface unread entries.
  skillsSystem.setCodexSystem(codexSystem);
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

  // --- Inline glossary first-use seen-state (§11.8) — persists which terms the
  // player has already seen so the first-use cue stops nagging veterans. ---
  glossaryState = new GlossaryState();

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
  guidanceDirector = new GuidanceDirector({ skillsSystem, settingsManager });

  // Reward-first spine: track the live in/out-of-range state of the selected
  // target so the Director's `range_wall` beat (requiresOutOfRange) holds until
  // the reticle actually reports OUT OF RANGE. Updated by AutoLockController's
  // crossing events.
  //
  // IMPORTANT (ordering): these flag-setters MUST be registered BEFORE the
  // OnboardingDirector below. EventBus delivers in registration order, and the
  // Director re-checks the range_wall gate on TARGET_OUT_OF_RANGE via its
  // contextProvider (which reads this flag). If the Director's handler ran
  // first, it would read the stale `false`, leave the gate closed, and the gate
  // would only open on the next nudge event (AUTOPILOT_ENGAGE) — which is also
  // range_wall's trigger, collapsing the teach into a single tick. Setting the
  // flag first means the gate opens the instant the reticle reports OUT OF
  // RANGE, so the "too far — press A" coaching is shown before the player acts.
  eventBus.on(Events.TARGET_OUT_OF_RANGE, () => { _onboardingTargetOutOfRange = true; });
  eventBus.on(Events.TARGET_IN_RANGE, () => { _onboardingTargetOutOfRange = false; });
  eventBus.on(Events.TARGET_CLEARED, () => { _onboardingTargetOutOfRange = false; });
  if (Events.GAME_RESET) eventBus.on(Events.GAME_RESET, () => { _onboardingTargetOutOfRange = false; });

  onboardingDirector = new OnboardingDirector({
    eventBus,
    scoringSystem,
    skillsSystem,
    teachingSystem,
    persistenceManager,
    guidanceDirector,
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
      // Zoom Ladder (owner, 2026-09-02 evening): away from the flying view
      // (F3 hull / F5–F7 icon floors) the player is exploring, not stuck —
      // the Director defers its stall escalation and ignores ladder inputs.
      // ladderController is constructed later in boot; read live, guarded.
      let ladderAway = false;
      try {
        ladderAway = !!(ladderController && ladderController.isActive() && ladderController.currentFloor() !== 4);
      } catch (_e) { /* best-effort */ }
      return { trackedContacts, nearestDebrisM, hasTarget, targetOutOfRange: _onboardingTargetOutOfRange, ladderAway };
    },
  });


  // Phase 4: Wire cargo system to resource system for dual-mode fuel
  resourceSystem.setCargoSystem(cargoSystem);
  player.setResourceSystem(resourceSystem);
  player.setCargoSystem(cargoSystem);

  // --- Camera System (replaces old manual follow) ---
  cameraSystem = new CameraSystem(camera, canvas, scene, sceneManager);
  cameraSystem.setPlayer(player);   // mother-net-reel plan §11.1 — pod-muzzle anchor for the mother net ceremony

  // --- Mothership inspection callouts (in-world 3D labels; replaces the 2D
  // wireframe pane). Gated internally on the inspection events. ---
  motherCallouts = new MotherCallouts(player, camera, {
    canvas,
    // Wave 5 (2) D-a (owner, 2026-09-03): with the ladder ON, clicking a hull
    // part or its card opens its REFIT card — focusPart routes through the
    // 8→7 refitIndex, then the pane opens. refitPane is constructed in the
    // ladder block BELOW (late-binding closure, the getLadderController
    // style); the guard makes a pre-construction click a no-op. Flag-off
    // (?ladder=0): NO onPartClick key is passed at all, so MotherCallouts'
    // one CODEX_OPEN_ENTRY emitter runs exactly as shipped (byte-identical,
    // pinned in test-LadderController).
    ...((Constants.LADDER && Constants.LADDER.ENABLED) ? {
      onPartClick: (part) => {
        if (!refitPane) return;
        refitPane.focusPart(part);
        refitPane.open();
        // Wave 5 Session C (the 2026-09-03 "Library is blank" playtest bug):
        // while the TECH LIBRARY is OPEN, every part/card click retargets it
        // over the ONE openEntry path the REFIT title rides — the library
        // follows the hull. A CLOSED library is never opened here (D-a: the
        // click's visible verb stays the REFIT card). Runs AFTER refit.open()
        // so the <1100 px one-pane rule has settled first: below the
        // breakpoint that open just collapsed the library, isOpen() is false,
        // and the retarget is skipped — one pane, as documented. `via` is the
        // clicked callout name: the library header leads with it (owner
        // review 2026-09-03 — the page confirms the click before it teaches).
        // `anchor` (Session D): the clicked part's screen point + projected
        // pick-mesh bounds in drawing-buffer px (the getHoveredPart record) —
        // the pane's photo crops around the PART for this edge; the anchor
        // rides the call, so it can never go stale (no stored click state).
        if (libraryPane && libraryPane.isOpen() && part && part.codexId) libraryPane.openEntry(part.codexId, { via: part.name, anchor: part.screen ? { x: part.screen.x, y: part.screen.y, bounds: part.bounds } : null });
        // Subnautica rule (08-workbench §2 "clicking a locked part's card
        // unlocks its entry — exploration is how the library fills"): a
        // LOCKED entry gets an unlock request over the ONE existing path
        // (LibraryPane.scanPart → CODEX_UNLOCK_REQUEST → CodexSystem's
        // queue + ticker ack chip). Unlocked/unknown parts are no-ops; the
        // LIBRARY tab pulses once when the unlock lands.
        if (libraryPane) libraryPane.scanPart(part);
      },
    } : {}),
  });

  // --- Camera: start following the player ---
  const startPos = player.getPosition();
  camera.position.copy(startPos);
  camera.position.y += 0.00008;

  // --- Comms System ---
  commsSystem = new CommsSystem();

  // --- CP-4 MissionCoach (chapters 2+ coaching; chapter 1 stays with OnboardingDirector) ---
  // Wave 5 Session F (D4): the chapter onset keys on MISSION_START (the mission
  // boundary) and holds while a depot stop is pending — the predicate is
  // GameFlowManager's (the ONE depot decision per catch); gameFlowManager is the
  // imported singleton, read lazily per gameplay frame, so init() order is moot.
  const depotStopPending = () => gameFlowManager.isDepotStopPending();
  missionCoach = new MissionCoach({ eventBus, scoringSystem, persistenceManager, commsSystem, depotStopPending });
  missionCoach.init();

  // Late-bind live-data + codex context into the inspection callouts. Done here
  // (not in the constructor) because motherCallouts is built before commsSystem;
  // every reference is optional and cards degrade to static rows if missing.
  if (motherCallouts?.setLiveCtx) {
    motherCallouts.setLiveCtx({
      resourceSystem, commsSystem, codexSystem,
      powerDistribution, tetherReel, despinLaser, player, armManager,
    });
  }

  // --- Build UI ---
  hud = new HUD();
  // Delegation 4 (2026-05-31) — Browser-playtest: NetInventoryPanel is
  // SUSPENDED (never displayed) pending a UX redesign. See ROADMAP.md.
  // The panel still mounts so internal event tracking works, but setVisible
  // is never called.
  menuScreen = new MenuScreen(sceneManager ? sceneManager.currentTier : null);
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

  // --- Connect NavSphere to HUD so the right pane column reserves the correct
  //     vertical slot and reclaims it when the sphere is minimized/hidden ---
  if (typeof hud.setNavSphere === 'function') hud.setNavSphere(navSphere);

  // Pane-density pure-scenery rung also drops the constellation name labels.
  if (typeof hud.setStarfield === 'function') hud.setStarfield(starfield);

  // …and the Sun / Moon / planet name labels (sky-labels rung).
  if (typeof hud.setSunLight === 'function') hud.setSunLight(sunLight);

  // Pure-scenery rung can also hide the mother ship for an empty-orbit view.
  if (typeof hud.setMotherCraft === 'function') hud.setMotherCraft(player);

  // --- Connect V3 arm manager to HUD + player satellite ---
  if (armManager) hud.setArmManager(armManager);
  if (armManager) player.setArmManager(armManager);
  // Delegation 4 (2026-05-31): wire LassoSystem into HUD so NetInventoryPanel
  // can poll initial ammo state.
  if (lassoSystem && typeof hud.setLassoSystem === 'function') hud.setLassoSystem(lassoSystem);

  // V-7: Launch cinematic visual effects (flag-gated internally)
  if (Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
    launchCinematic.init(scene, player, sceneManager);
  }

  // V-8: Capture net system + visual effects
  if (Constants.FEATURE_FLAGS.CAPTURE_NET) {
    captureNetSystem.init({ player, debrisField, audioSystem, armManager, lassoSystem });   // ST-9.4: initialize mother pod inventory + set _initialized; deps back the mother-pod anchor provider + Phase-A pin API + Phase-B winch pitch + Phase C-lite corridor test
    player.setCaptureNetSystem(captureNetSystem);     // §4.4: berthed-mass translational scaling in _applyThrust
    lassoSystem.setCaptureNetSystem(captureNetSystem);   // Cargo-continuity S13(d): a lassoed catch adopts onto the nose-collar berth (the one holding model)
    cameraSystem.setLassoSystem(lassoSystem);   // 2026-08-26: the short lasso catch cut reads the live cast state
    captureNetVisual.init(scene, player, captureNetSystem, sceneManager);   // sceneManager backs the Phase D.8 LOW-tier garnish gate
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

  // Reward-first onboarding: front-arc autolock + net-range tracking.
  // Auto-selects the nearest forward debris so a new player gets the lock +
  // first catch in the first ~10 s; emits TARGET_IN_RANGE/OUT_OF_RANGE to drive
  // the reticle flip, the in-range-only lock earcon, and the range→AP gate.
  autoLockController = new AutoLockController({ player, debrisField, settingsManager });

  // --- F17: Connect codex system to HUD badge + badge click toggle ---
  hud.setCodexSystem(codexSystem);
  // Feed glossary seen-state to the comms panel so inline terms drop their
  // first-use cue once seen.
  if (glossaryState && hud.commsPanel && typeof hud.commsPanel.setGlossaryState === 'function') {
    hud.commsPanel.setGlossaryState(glossaryState);
  }
  eventBus.on('codex:toggleUI', () => { if (codexViewerUI) codexViewerUI.toggle(); });
  // Glossary deep-link (§11.8): a clicked inline term opens the viewer on its entry.
  eventBus.on(Events.CODEX_OPEN_ENTRY, (data) => {
    if (codexViewerUI && data && data.id) codexViewerUI.openEntry(data.id);
  });

  // --- Connect shop screen to game over screen (for upgrade count display) ---
  gameOverScreen.setShopScreen(shopScreen);

  // --- Phase 5: Wire cargo & scoring refs into shop for sell/contribute ---
  shopScreen.setCargoSystem(cargoSystem);
  shopScreen.setScoringSystem(scoringSystem);
  shopScreen.setPersistenceManager(persistenceManager);

  // --- CH5 ISS conjunction boss (MISSION_ARC §6) — protect-the-asset event ---
  // Needs the shop (elevator-mass award) + debrisField (ISS-track spawn), so it
  // is constructed after shopScreen is wired, unlike MissionCoach above. Onset:
  // MISSION_START into mission 5 + the same depotStopPending hold (D4).
  issConjunctionBoss = new IssConjunctionBoss({
    eventBus, scoringSystem, debrisField, shopScreen, persistenceManager, depotStopPending,
  });
  issConjunctionBoss.init();

  // --- CH9 Starlink fragmentation boss (MISSION_ARC §6) — race-the-cascade event ---
  starlinkCascadeBoss = new StarlinkCascadeBoss({
    eventBus, scoringSystem, debrisField, shopScreen, persistenceManager, depotStopPending,
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
    resourceSystem, cargoSystem,
    sunLight, // M1 opening-light staging (_stageOpeningLight, new-game paths only)
  });

  // --- F15: Wire autopilot dependencies ---
  autopilotSystem.init({
    player, targetSelector, trawlManager, debrisField, armManager,
    targetAcquisition,
  });
  // Aim-before-launch: give ArmManager the autopilot for the daughter ceremony.
  if (typeof armManager.setAutopilot === 'function') armManager.setAutopilot(autopilotSystem);

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

  // --- UX-11 #5: Earth city labels (5 key, off by default, persisted) ---
  // Offline-first local JSON; attaches to BOTH the command-view Earth and the
  // Strategic Map's wireframe Earth so one toggle drives both surfaces.
  cityLabels.load().then((count) => {
    if (!count) return;
    cityLabels.attach({
      parent: earth.getGroup(),
      radius: Constants.EARTH_RADIUS,
      camera,
      container: document.getElementById('hud-overlay'),
      // The command-view Earth uses a default SphereGeometry equirectangular
      // texture (prime meridian at +X, east toward -Z). latLonToPosition runs
      // east toward +Z, so mirror longitude to align labels with continents.
      mirrorLon: true,
      // Hide command-view labels while the Strategic Map covers the screen.
      isActive: () => !(strategicMap && strategicMap.isOpen()),
      // Selectivity caps: in-view peaks are 22-39 labels, so 28 binds only in
      // the densest stretches (Europe, East Asia, Ganges plain). 6 = measured
      // global peak pads-in-one-view, so pads are never truncated here.
      maxVisible: 28,
      maxVisibleLaunch: 6,
    });
    if (strategicMap && strategicMap._earthMesh && strategicMap._camera) {
      cityLabels.attach({
        parent: strategicMap._earthMesh,
        radius: Constants.EARTH_RADIUS,
        camera: strategicMap._camera,
        container: strategicMap._containerEl,
        isActive: () => strategicMap.isOpen(),
        // Mirror longitude to match the corrected ground stations + debris
        // (real world frame), so the wireframe map's geography matches reality
        // and the command view.
        mirrorLon: true,
        // The map camera orbits much farther out (initial ~12.5 Earth radii,
        // zoom range ~0.8–78 r) than the command view. Default zoom shows
        // tier 1 only; zoom in to reveal tiers 2–3.
        lodNear: Constants.EARTH_RADIUS * 6,
        lodFar: Constants.EARTH_RADIUS * 13,
        // The whole hemisphere is a candidate at default zoom; cap the mix so
        // it stays a strategic overview, with a bounded pad budget so the map
        // doesn't read pad-only.
        maxVisible: 30,
        maxVisibleLaunch: 8,
      });
    }

    // --- Launch cameo: a single plume rises from the player's home spaceport
    // during the opening pass. Anchored to the same Earth group + mirrorLon
    // convention as the city labels; fired by GameFlowManager on first ORBITAL_VIEW.
    launchCameo.attach({
      parent: earth.getGroup(),
      radius: Constants.EARTH_RADIUS,
      camera,
      mirrorLon: true,
      sunLight,
    });
    // A reset within the 16 s cameo window must clear _active, or the next
    // game's fire() is silently refused (review finding).
    eventBus.on(Events.GAME_RESET, () => launchCameo.reset());

    // --- Ambient launches: any pad fires a plume as it orbits into view
    // (e.g. Sriharikota rises ~30 s into the Thai orbit). Silent by design —
    // the pad's label pill pulses instead of a comms line. Cooldown-limited.
    ambientLaunchScheduler.init({
      camera,
      parent: earth.getGroup(),
      radius: Constants.EARTH_RADIUS,
      mirrorLon: true,
      cities: cityLabels.getCities(),
      canFire: () => !(strategicMap && strategicMap.isOpen()),
    });
  }).catch((e) => console.warn('[main] cityLabels:', e));

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
    // Scan auto-select: unified acquire helper (Shift+N / Shift+A route here).
    targetAcquisition,
    // Net ladder Phase B: Mother Large Net routing (>500 kg → fireMotherNet).
    captureNetSystem,
    // Hotkey revamp 2026-06-14: starfield (6 = constellation labels toggle).
    starfield,
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
    // Zoom Ladder key bindings (00-spec §5: Esc / PgUp / PgDn / Space ride or
    // verb the ladder). A closure, not a direct ref, because LadderController is
    // constructed in the ladder block BELOW this init call — same late-binding
    // style as the gameFlowManager closures above. InputManager forwards these
    // keys only while ladderController.isActive() (flag on + gameplay + engaged),
    // so with LADDER.ENABLED false the key handling is byte-identical.
    getLadderController: () => ladderController,
  });
  inputManager.start();
  // 2026-08-26: the lasso catch cut never STARTS over active piloting — a key
  // held before wrap contact produces no fresh keydown, so the cut's
  // any-input abort alone could not protect that player.
  cameraSystem.setLassoCutInputProbe(() => inputManager.anyKeyHeld());
  _bootMark('InputManager started + gameFlowManager.init');

  // --- Zoom Ladder (S2 walking skeleton — docs/ladder/03-plan.md M1) ---
  // The single WheelRouter (T3) owns ALL wheel input: it replaces the three
  // shipped listeners (InputManager window-capture, CameraSystem canvas,
  // StrategicMap own-canvas — all removed this commit) and dispatches to the
  // arm-SK branch, the ladder (flag on), or the legacy zoom (flag off).
  // LadderController owns the pure ZoomLadder core + the CameraSystem ride
  // engine + the per-floor render block; the rail is the S2 stub. Everything is
  // inert while Constants.LADDER.ENABLED is false (?ladder=0) — shipped
  // behavior stays byte-identical.
  railIndicator = new RailIndicator();
  // Zoom Ladder F6 (NAVCOM) content orchestrator (S5, M3). Constructed INSIDE the
  // ladder block (T8: EventBus/costume order = construction order) and injected
  // into LadderController, which activates/ticks it on F6 arrival and dispatches
  // its 'plan-transfer' Space verb. The live world→screen projector is built off
  // the ladder camera; onPlanTransfer routes the planned transfer into the
  // shipped approach autopilot. Inert while LADDER.ENABLED is false (never
  // activated), so shipped behavior stays byte-identical.
  navcomFloor = new NavcomFloor({
    clusterSource: debrisField,
    player,
    project: navcomProject,
    onPlanTransfer: (cluster) => autopilotSystem.engageCluster(cluster),
    // F6 FUEL-REACHABILITY: Tsiolkovsky remaining-ΔV SSOT. Optional dep — without it
    // the floor renders as before. armManager is constructed earlier (~:715). Inert
    // while LADDER.ENABLED is false.
    getMassBudget: () => armManager.getMassBudget(),
  });
  // Zoom Ladder F5 (PROX NET) content orchestrator (S4). Same contract as
  // navcomFloor: constructed inside the ladder block, injected into
  // LadderController (activates it on debrisMode 'tactical', dispatches its
  // 'approach' Space verb). getFocusedCluster is the F6→F5 HANDOFF — the
  // cluster focused on NAVCOM is the corridor target here. Inert while
  // LADDER.ENABLED is false (never activated): byte-identical.
  proxNetFloor = new ProxNetFloor({
    debrisSource: debrisField,
    player,
    // F5 corner minimap ('NavSphere:corner-minimap'): the SHIPPED orb,
    // re-mounted small while PROX NET is active (ProxMiniSphere adapter).
    navSphere,
    getFocusedCluster: () => navcomFloor.getFocusedCluster(),
    onApproach: (cluster, arrivalPoint) =>
      autopilotSystem.engageCluster(cluster, { arrivalPoint }),
  });
  // Zoom Ladder F7 (SDA) content orchestrator (S4): screen-space mass-band
  // chart over live cluster/active-sat/Kessler aggregates (both singletons
  // imported above). Activated on debrisMode 'massBands'; Space flips the
  // VALUE↔THREAT lens. Inert while LADDER.ENABLED is false.
  sdaFloor = new SdaFloor({
    clusterSource: debrisField,
    satSource: () => catalogLoader.getAllActiveSats(),
    kessler: kesslerSystem,
  });
  // Zoom Ladder F3 (HULL CAM) content orchestrator (S4): ship-local blueprint
  // callouts. The projector composes player.localToWorld with the SAME
  // world→screen projector navcomFloor uses; anchor positions resolve from the
  // live ship meshes once per name (MotherCallouts._resolveAnchor pattern —
  // the anchor meshes are static, e.g. AftThrusterDeck). Providers feed the
  // detail-lens live rows (MotherCallouts._liveRows sources); every ref
  // guarded, and HullCamFloor itself swallows provider throws (best-effort).
  // The providers object is HOISTED so the Wave-5 REFIT pane consumes the
  // SAME rows (one source of live-row truth — 08-workbench §2 "the providers
  // that already feed SOLAR / FUEL / LINK / REELS").
  const hullcamProviders = {
    power: () => (powerDistribution && powerDistribution.getSolarInput
      ? [`SOLAR ${Math.round(powerDistribution.getSolarInput())} W`] : []),
    engineering: () => {
      // Fuel row honesty rule (MotherCallouts 'feep' live row, R4): a
      // cargo-fed metal is NOT drawn from the xenon tank — never report
      // xenon kg under its name.
      if (!resourceSystem || !resourceSystem.getStatus) return [];
      const st = resourceSystem.getStatus();
      const fuel = resourceSystem.getCurrentFuel ? resourceSystem.getCurrentFuel() : null;
      if (fuel && !fuel.fromCargo) return [`FUEL ${st.currentFuelName} ${Math.round(st.xenon)}/${st.xenonMax} kg`];
      if (fuel) return [`FUEL ${st.currentFuelName} (CARGO)`];
      return [`FUEL ${Math.round(st.xenon)}/${st.xenonMax} kg`];
    },
    comms: () => (commsSystem && commsSystem.getSuppressionTier
      ? [`LINK: ${commsSystem.getSuppressionTier() > 0 ? 'SUPPRESSED' : 'NOMINAL'}`] : []),
    cargo: () => {
      if (!tetherReel || !tetherReel.getAllReelStates) return [];
      const states = tetherReel.getAllReelStates() || [];
      const active = states.filter((s) => s && s.state && s.state !== 'STOWED').length;
      return [`REELS ACTIVE ${active}/${states.length || 4}`];
    },
    // thermal: omitted until the flower refit lands — the static MLI spec
    // rows from the blueprint manifest carry that card.
  };
  hullcamFloor = new HullCamFloor({
    player,
    shipMeshSource: {
      _cache: new Map(),
      getAnchorLocalU(name) {
        if (this._cache.has(name)) return this._cache.get(name);
        const m = player.getObjectByName(name);
        let out = null;
        if (m) {
          m.getWorldPosition(_hullTmp);
          player.worldToLocal(_hullTmp);
          out = { x: _hullTmp.x, y: _hullTmp.y, z: _hullTmp.z };
        }
        this._cache.set(name, out);   // static mesh — resolve once per name
        return out;
      },
    },
    project: (localU) => {            // ship-local → world → the navcom projector
      _hullTmp.set(localU.x, localU.y, localU.z);
      player.localToWorld(_hullTmp);
      return navcomProject(_hullTmp);
    },
    providers: hullcamProviders,
  });
  // Zoom Ladder Wave 5 (2) — the REFIT pane (08-workbench §2: LEFT, the
  // seven-subsystem index, exactly three ranked alternatives, one-click BUY;
  // D-b: it claims Space on F3 via the controller's `refit` dep below).
  // Constructed ONLY while the ladder flag is on — the same live
  // Constants.LADDER.ENABLED every ladder consumer reads (?ladder=0 boots
  // build no pane; test-LadderController pins it). Beside hullcamFloor by
  // design: it shares hullcamProviders (the SAME live-row objects).
  // Wave 5 (Session B): the TECH LIBRARY pane joins it in the same gate.
  if (Constants.LADDER && Constants.LADDER.ENABLED) {
    // ONE workbench-pane edge, three consumers (Session B — never a second
    // signal path). Both panes' onOpenChange call this; it writes:
    //   1. `_workbenchPaneOpen` — the D10 calm-cap signal the loop already
    //      applies through TimeAuthority.calmCap (either pane open → 1×);
    //   2. the ONE `CameraSystem.setLadderPaneInset` value (Wave 5 (3)),
    //      NETTED per 08-workbench §2: REFIT open → +refit width (LEFT),
    //      LIBRARY open → −library width (RIGHT), BOTH open → 0 ("both panes
    //      open → centered"), none → 0. The camera does the rest (F3-only,
    //      270 ms ease, reduced-motion snap, released on ride/close/disengage);
    //   3. the MotherCallouts pane-edge inset pair (Session B commit 3) so
    //      the callout columns stay out from under the panes.
    // widthPx() is a layout read — edges only, never per frame (G1).
    const _syncWorkbenchPanes = () => {
      const refitOpen = !!(refitPane && refitPane.isOpen());
      const libraryOpen = !!(libraryPane && libraryPane.isOpen());
      _workbenchPaneOpen = refitOpen || libraryOpen;
      const inset = (refitOpen && libraryOpen) ? 0
        : (refitOpen ? refitPane.widthPx()
          : (libraryOpen ? -libraryPane.widthPx() : 0));
      cameraSystem.setLadderPaneInset(inset);
      // Consumer 3 (commit 3): the callout columns' pane-edge PAIR — unlike
      // the camera's netted single value, the cards need BOTH edges so
      // neither column ever sits under a pane (left edge = refit width,
      // right edge = W − library width; 06-core-api "Known non-consumer"
      // FINDINGS, now consumed).
      motherCallouts.setPaneInsets(
        refitOpen ? refitPane.widthPx() : 0,
        libraryOpen ? libraryPane.widthPx() : 0,
      );
      // Consumer 4 (Wave 5 Session G — D5 pane memory): the controller records
      // the F3 pane open-state into the player store as the player's intent —
      // only while engaged on F3 and never for its own teardown closes / the
      // engage re-open (it tells them apart itself). Same ONE edge, no second
      // signal path; write-on-change inside the store (G1). ladderController is
      // constructed below — read live, guarded (this closure runs on edges only).
      if (ladderController) ladderController.notePaneChange();
    };
    // The below-~1100-px one-pane rule (01-numbers "One-pane breakpoint",
    // exported by LibraryPane): opening one pane collapses the other to its
    // tab. The close() re-enters _syncWorkbenchPanes through its own
    // onOpenChange edge first; the opener's edge then settles the final
    // state — both writes idempotent, an interaction edge, never per frame.
    const _onePaneRule = (other) => {
      if (other && other.isOpen && other.isOpen() &&
        window.innerWidth < ONE_PANE_BREAKPOINT_PX) other.close();
    };
    refitPane = new RefitPane({
      providers: hullcamProviders,
      getCredits: () => scoringSystem.credits,
      // "N catches away" (08-workbench §2): average credits per catch from the
      // running totals; null before the first catch → the pane shows cost only.
      getAvgCreditsPerCatch: () => (gameState.debrisCleared > 0
        ? scoringSystem.captureCreditsEarned / gameState.debrisCleared
        : null),
      getUpgradeLevel: (id) => shopScreen.purchasedUpgrades.get(id) || 0,
      // One-click LIVE buy through the shop's own guarded flow (maxLevel /
      // E5 prereqs / wallet) — ShopScreen.purchaseUpgrade, the public wrapper.
      purchase: (id) => shopScreen.purchaseUpgrade(id),
      // Alternative hover → the hull hardware pulses cyan (MotherCallouts
      // ghost outlines, the one outline system).
      onGhost: (ids) => motherCallouts.setGhostOutline(ids),
      // Live alternative rows (Session B commit 4 — the Wave-5 (2) FINDINGS,
      // closed): the fittingCatalog `current` adapters read these deps. A
      // GETTER returning a fresh object, so every read resolves the LIVE
      // module bindings (kesslerSystem/captureNetSystem are imported
      // singletons; the rest are init()-order lets — some construct after
      // this pane). hasUpgrade mirrors the pane's own getUpgradeLevel truth
      // (ShopScreen.purchasedUpgrades — the same map GameFlowManager's
      // runtime checks walk). The catalog's safeAdapter wrapper turns any
      // missing/throwing read into undefined → the static base, never a
      // crash.
      adapterDeps: () => ({
        player, resourceSystem, kesslerSystem, sensorSystem, cargoSystem,
        armManager, captureNetSystem,
        hasUpgrade: (id) => (shopScreen.purchasedUpgrades.get(id) || 0) > 0,
      }),
      // Card title / spec term → the TECH LIBRARY PANE on that entry while
      // the pane exists (08-workbench §3 "tap → TECH LIBRARY slides in"; the
      // full-screen viewer stays one click away via MAXIMIZE). Without the
      // pane the emit below is the shipped deep-link path, byte-identical —
      // and it IS the flag-off path by construction (no pane is ever built
      // there, so onOpenEntry itself never exists).
      onOpenEntry: (codexId) => {
        if (!codexId) return;
        if (libraryPane) { libraryPane.openEntry(codexId); return; }
        eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: codexId });
      },
      // D10 + the camera inset + (commit 3) the callout insets: ONE edge,
      // fanned by _syncWorkbenchPanes above. The <1100 px one-pane rule runs
      // first so the sync sees the settled pair.
      onOpenChange: (isOpen) => {
        if (isOpen) _onePaneRule(libraryPane);
        _syncWorkbenchPanes();
      },
    });
    // The TECH LIBRARY pane (08-workbench §2 right pane; §10's LibraryPane —
    // the adapter over the shipped viewer). Reads the SAME codexSystem the
    // viewer reads; every routed action rides an EXISTING path:
    //   onMaximize    → the CODEX_OPEN_ENTRY deep link (the full-screen
    //                   viewer — the exact route every deep link uses today);
    //   requestUnlock → CODEX_UNLOCK_REQUEST (the ONE unlock path:
    //                   CodexSystem's queue → ticker ack chip → chime +
    //                   CODEX_UNLOCKED on its own schedule — Subnautica §2);
    //   onViewed      → CODEX_VIEWED (the viewer's own seen contract —
    //                   CodexSystem.markSeen stays the one seen-writer).
    libraryPane = new LibraryPane({
      codex: codexSystem,
      onMaximize: (id) => {
        if (id) eventBus.emit(Events.CODEX_OPEN_ENTRY, { id });
      },
      requestUnlock: (id) => {
        if (id) eventBus.emit(Events.CODEX_UNLOCK_REQUEST, { id });
      },
      onViewed: (id) => {
        if (id) eventBus.emit(Events.CODEX_VIEWED, { id });
      },
      // Session C: what the player is looking at, for an ENTRY-LESS open (tab
      // click / toggle) — the pane lands on it instead of the prompt. The
      // focused hull part first (MotherCallouts.getFocusedPart — live in the
      // COMPONENT band, null elsewhere; the same getter ArchiveFloor's F1
      // deep link reads), else the REFIT card's manifest deep link
      // (RefitPane.focusedCodexId — the id its title already carries; no new
      // mapping). A GETTER: read on the open edge only, never per frame; the
      // pane stays eventless and never sees either module.
      subject: () => {
        const part = (motherCallouts && motherCallouts.getFocusedPart) ? motherCallouts.getFocusedPart() : null;
        return (part && part.codexId) || (refitPane ? refitPane.focusedCodexId() : null);
      },
      // Session C, owner decision 2 — "the photo you just took" (08-workbench
      // §2): the pane crops the LIVE render canvas around the subject. The
      // subject point is the ship's projection (the F3 subject; the callout
      // anchor itself is not exposed — MotherCallouts is read-only here) in
      // drawing-buffer px (canvas.width/height, not CSS px — drawImage source
      // space). The pane defers the read ONE animation frame (a synchronous
      // read in the click task is blank on the shipped renderer —
      // preserveDrawingBuffer is false; the next rAF runs after this loop's
      // render, before present: the BlackFrameProbe legality) and falls back
      // to the emoji header on any failure. A GETTER, read per photo on the
      // open / entry edge only — never per frame. SceneManager untouched.
      photoSource: () => {
        _photoTmp.copy(player.getPosition()).project(camera);
        return {
          canvas,
          x: (_photoTmp.x * 0.5 + 0.5) * canvas.width,
          y: (-_photoTmp.y * 0.5 + 0.5) * canvas.height,
        };
      },
      onOpenChange: (isOpen) => {
        if (isOpen) _onePaneRule(refitPane);
        _syncWorkbenchPanes();
      },
    });
    // Tab truth on change, never per frame (G1): a landed unlock repaints the
    // unread count (and fires the pane's ONE pulse); a read entry drops it.
    // Registered inside the gate — a ?ladder=0 boot adds no listeners.
    eventBus.on(Events.CODEX_UNLOCKED, () => { if (libraryPane) libraryPane.refresh(); });
    eventBus.on(Events.CODEX_VIEWED, () => { if (libraryPane) libraryPane.refresh(); });
    // Wave 5 (Session E) — the depot INVITATION (08-workbench §5 D3): from
    // chapter 4 on GameFlowManager (the ONE depot decision per catch) emits
    // DEPOT_INVITATION instead of forcing the stop; the rail's DEPOT notch
    // glows (VALUE gold, steady) until { open: false } — entered / lapsed /
    // reset. The rail stays EventBus-free (this is its one feed); the
    // controller is not involved (no chapter knowledge in the hub). Inside
    // the gate: a ?ladder=0 boot adds no listener, and never emits it either.
    eventBus.on(Events.DEPOT_INVITATION, (d) => {
      if (railIndicator) railIndicator.setDepotInvitation(!!(d && d.open));
    });
    // Wave 5 (Session G) — D5 persistence of view prefs + floor (08-workbench
    // §11), two stores by ownership (owner decisions 1a / 1b, 2026-09-04):
    //   PLAYER store `sc_ladder_view_v1` (LadderViewStore — the SettingsManager
    //   pattern: own key, load in ctor, save on change, private-mode-safe):
    //   FloorMask's per-floor rooms + the F3 pane open-state. Survives New Game —
    //   a rearranged room belongs to the player, not the run. The controller
    //   imports the rooms at construction, exports them on every floor change,
    //   records the panes on the ONE edge above, re-opens them at engage on F3.
    //   RUN save `save.ladder = { floor, z01 }`: gathered here on
    //   PERSISTENCE_GATHER (LadderController.viewState — the hull, never the
    //   doorway mid-ride), restored on PERSISTENCE_LOADED into the core BEFORE
    //   the first engage (MENU_CONTINUE emits it before ORBITAL_VIEW), so a
    //   continue re-engages where the player left; a NEW game has no save →
    //   the intro ride as shipped. GAME_RESET clears the run's floor memory
    //   (the core back to the shipped initial view) but NOT the player's rooms.
    // All inside the gate: a ?ladder=0 boot constructs no store, registers no
    // listener, never writes the key, and its save never carries `ladder`
    // (PersistenceManager omits the key when absent) — byte-identical.
    ladderViewStore = new LadderViewStore();
    eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      if (!saveData || !ladderController) return;
      const view = ladderController.viewState();
      if (view) saveData.ladder = view;
    });
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      if (!ladderController) return;
      const save = persistenceManager.peek();
      ladderController.restoreView(save ? save.ladder : null);
    });
    eventBus.on(Events.GAME_RESET, () => {
      if (ladderController) ladderController.resetView();
    });
    // Wave 5 (Session H) — JOB A, the D5 room-memory WRITE GAP (03-plan
    // Session G FINDINGS (c)): a pane shown/hidden by its key (0/9/8, the
    // density -/+ or the iPad slider) and then a reload with NO floor change
    // in between was never persisted — FloorMask captures only inside
    // setFloor(). The four player edges emit ONE ladder-agnostic signal AFTER
    // the bit flips (Events.HUD_PANE_VISIBILITY); this ONE listener — inside
    // the gate, so a ?ladder=0 boot registers nothing and does no work —
    // captures the applied floor's room and exports it to the player store
    // (write-on-change inside the store; an event-rate edge, never per frame).
    // ladderController is constructed below — read live, guarded.
    eventBus.on(Events.HUD_PANE_VISIBILITY, () => {
      if (ladderController) ladderController.noteRoomChange();
    });
  }
  // Zoom Ladder F1 (ARCHIVE) bridge (Wave 3): arriving on the innermost floor
  // drops into the Tech Library — ArchiveFloor HOSTS the existing
  // codexViewerUI as the floor costume (00-spec §3/§11 "bridge, don't merge").
  // Hosted mode reroutes the viewer's every self-close path (ESC, backdrop,
  // CLOSE, I) to onExitUp = ride one floor up; leaving F1 un-hosts and closes.
  // TimeAuthority already pauses the world on F1 (timeCap 0). Inert while
  // LADDER.ENABLED is false (never activated): byte-identical.
  archiveFloor = new ArchiveFloor({
    codex: codexViewerUI,
    onExitUp: () => { if (ladderController) ladderController.command({ type: 'esc' }); },
    // Deep link (08-workbench D1/D2): the library opens FROM the part you were
    // looking at. The subject is MotherCallouts' focused part — the one nearest
    // screen-centre in its close (COMPONENT) band, the F3 costume's own lens
    // split — read at F1 arrival (ArchiveFloor.activate runs inside
    // _applyFloorContent, BEFORE the camera fires F3's departure signal, so the
    // focus is still live). Its codexId is the same string the card click
    // emits. Outside the close band there is no focus → null → the arrival is
    // a plain host + show. motherCallouts is constructed far above (the
    // inspection-callouts block); the guard keeps a missing getter harmless.
    // (Re-pointed 2026-09-02 from hullcamFloor.getFocusedSubsystem — the pill
    // focus — when the owner's playtest made MotherCallouts the F3 costume.)
    getSubject: () => (motherCallouts && motherCallouts.getFocusedPart ? motherCallouts.getFocusedPart() : null),
  });
  // Zoom Ladder per-floor audio beds (FloorContract audioBed). GETTERS, not
  // refs: audioSystem.ctx/padBus are null until the menu-click gesture runs
  // audioSystem.init() (unlock pattern) — the beds resolve them lazily on the
  // first post-unlock floor change. padBus ⇒ beds ride padBus → sfxBus →
  // master, so alarm ducking, setVolume, and the §12.12 suspend gate govern
  // them for free. Inert while LADDER.ENABLED is false (never driven).
  ladderAudioBeds = new LadderAudioBeds({
    context: () => audioSystem.ctx,
    destination: () => audioSystem.padBus || audioSystem.master,
  });
  // Zoom Ladder Wave-4 FloorMask: reads hud.paneDensity.rungs (the ONE pane
  // visibility bit, T8) and owns the always-set VitalsLine. GETTER for the
  // time rate, not a ref: timeAuthority is constructed AFTER this block (the
  // ladder-block order), so the vitals line resolves it lazily per 10 Hz beat.
  ladderFloorMask = new FloorMask({
    hud,
    getTimeRate: () => (timeAuthority ? timeAuthority.rate : 1),
  });
  // Zoom Ladder interaction sfx (00-spec §4 + 08-workbench §2 "Sound").
  // GETTERS, not refs (the unlock pattern above). tickBus, NOT padBus: these
  // are input confirms — the TICK family is where gameplay input-confirm cues
  // live (AudioSystem.playClick → tickBus; FAMILY_GAIN.tick 0.8) — riding
  // tickBus → sfxBus → master so alarm ducking, setVolume, and the §12.12
  // suspend gate govern them for free.
  ladderSfx = new LadderSfx({
    context: () => audioSystem.ctx,
    destination: () => audioSystem.tickBus || audioSystem.master,
  });
  ladderController = new LadderController({
    cameraSystem,
    sceneManager,
    gameState,
    rail: railIndicator,
    navcom: navcomFloor,
    proxNet: proxNetFloor,
    sdaFloor,
    // NO `hullcam` injection (owner, 2026-09-02): HullCamFloor/BlueprintOverlay
    // are NOT the F3 costume — MotherCallouts is (the shipped in-world cards:
    // 26 parts in 8 colour-coded systems, zoom bands = the 5 m lens split, live
    // rows, Library links; it activates itself on the camera's F3 arrival
    // signal, INSPECT_HULL_OUTLINE). The seven title pills the hullcam floor
    // painted on the hull leave with this line. hullcamFloor stays constructed
    // above as the seven-subsystem refit index (fittingCatalog imports its
    // manifest) for the Wave-5 REFIT pane, which decides whether to re-inject;
    // its per-frame tick below is guarded on isActive() and so stays inert.
    // The controller's `hullcam` seam itself is unchanged (pinned).
    // Wave 5 (2): the REFIT pane is the F3 floor-keyed dep instead — enabled
    // on floor 3, disabled+closed elsewhere/on disengage, and Space's
    // 'lens-toggle' now toggles it (D-b, owner 2026-09-03). Flag-off:
    // refitPane is undefined (never constructed) → the dep is null → every
    // controller path is byte-identical, and Space on F3 stays the shipped
    // silent no-op.
    refit: refitPane,
    // Wave 5 (Session B): the TECH LIBRARY pane — floor-3 keyed EXACTLY like
    // `refit` (enable on 3, disable + close elsewhere and on disengage) and
    // the TOPMOST pane in closeTopPane() (it opens FROM the REFIT card, so
    // Esc unwinds reading → fitting → ride up). Flag-off: libraryPane is
    // undefined (never constructed) → the dep is null → byte-identical.
    library: libraryPane,
    archive: archiveFloor,
    // Wave 5 (Session E): the F2 DEPOT doorway (08-workbench §5 D3). A ride
    // that arrives on floor 2 from above enters the SHOP GameState at ride
    // END — the ONE shipped SHOP transition, so ShopScreen's GAME_STATE_CHANGE
    // self-show and the firstDepotVisit payload ride it unchanged. The cross
    // clunk (LadderSfx, at the decision) leads the flip by the 550 ms ride
    // (T8: SHOP suspends the audio context synchronously). Flag-off: the
    // controller never engages → the host is never called → byte-identical.
    depot: { enter: () => gameFlowManager.transitionToState(GameStates.SHOP) },
    audioBeds: ladderAudioBeds,
    // Wave-4 map rule (D8/§4): per-floor pane rooms + the vitals always-set.
    floorMask: ladderFloorMask,
    // Wave 5 (Session G): the PLAYER-owned view store — FloorMask's rooms +
    // the F3 pane open-state persist through it (D5). Flag-off: ladderViewStore
    // is undefined (never constructed) → the dep is null → byte-identical.
    viewStore: ladderViewStore,
    sfx: ladderSfx,
    // F7 hides the constellation figures under the SDA chart and restores the
    // player's 6-key prior on leave/disengage.
    starfield,
    // F7 also suppresses the Earth city/landmark pills under the chart —
    // transient (never persisted), so the 5-key preference owns the resting
    // state on leave/disengage.
    cityLabels,
    // Reticle gating (F6/F7 ship-is-icon floors): the controller hides the
    // aiming reticles on floors >= 6 and restores them on <= 5 / disengage.
    // Optional deps — inert while LADDER.ENABLED is false (never engaged).
    targetReticle,
    dockingReticle,
  });
  // Zoom Ladder F6/F7 render-block content refs (T1 'ship-to-icon'): SceneManager
  // hides the full debris meshes + the world ship mesh on floors whose debrisMode
  // iconizes them (F6 'clusters'), and re-asserts the hide across applyTier().
  // The starfield ref drives the Earth-anchored floors' camera-follow star shell
  // (F6/F7 BLACK-SKY fix — SceneManager.setLadderFloorFidelity toggles
  // Starfield.setFollowCamera; the per-frame starfield.update() already receives
  // the camera). Storing refs mutates nothing and the hide/follow only fires from
  // an engaged floor's request, so with LADDER.ENABLED false this is byte-identical.
  if (sceneManager.setLadderContentRefs) {
    sceneManager.setLadderContentRefs({ debrisField, ship: player, starfield });
  }
  // S3 — the ONE dtReal/dtWorld choke point (T2). Ticked each frame from the
  // game loop; pins the shipped base rate while the ladder is disengaged.
  timeAuthority = new TimeAuthority();
  wheelRouter = new WheelRouter({
    canvas,
    inputManager,
    cameraSystem,
    strategicMap,
    ladderController,
  });
  wheelRouter.start();

  // --- iPad port (Ipad.md §4.5): touch controls, real-detection gated.
  // Desktop and headless contexts see zero listeners + zero DOM by
  // construction, so every existing suite stays byte-identical. Pinch
  // synthesizes wheel input through the SAME WheelRouter dispatch as the
  // physical wheel; a one-finger drag on the ladder rail drives
  // ladderController.jump({toFloor}) (its own rail-notch API); the pane slider
  // drives the PaneDensity ladder. An optional telemetry beacon logs zoom-feel
  // gestures + the floor crossings they cause to the cable server (touch-only).
  if (TouchControls.detect()) {
    const stampEl = (typeof document !== 'undefined') ? document.getElementById('build-stamp') : null;
    const touchTelemetry = new TouchTelemetry({
      build: stampEl ? stampEl.textContent : null,
      getFloor: () => (ladderController && ladderController.currentFloor
        ? ladderController.currentFloor() : null),
    });
    touchTelemetry.start();
    touchControls = new TouchControls({
      canvas,
      wheelRouter,
      ladderController,
      gameState,
      paneDensity: hud ? hud.paneDensity : null,
      // STORE / LIBRARY tap chips (iPad port 2026-09-02): glass has no KeyB /
      // KeyI, so the chips call the SAME paths the keys drive — the KeyB
      // ORBITAL_VIEW guard and the KeyI toggle + CODEX_OPENED-on-open-only
      // rule (InputManager) are mirrored here verbatim.
      openShop: () => {
        if (gameState.getState() === GameStates.ORBITAL_VIEW) {
          gameFlowManager.transitionToState(GameStates.SHOP);
          audioSystem?.playClick?.();
        }
      },
      toggleLibrary: () => {
        if (!codexViewerUI) return;
        codexViewerUI.toggle();
        audioSystem?.playClick?.();
        if (typeof codexViewerUI.isVisible !== 'function' || codexViewerUI.isVisible()) {
          eventBus.emit(Events.CODEX_OPENED);
        }
      },
      telemetry: touchTelemetry,
    });
    touchControls.start();
    _bootMark('TouchControls started');
  }

  // --- Item 3: anti-stuck idle watchdog (data-driven, veteran-gated) ---
  armIdleAdvisor.init({
    armManager,
    skillsSystem,
    getPilotMode: () => (inputManager ? inputManager._controlMode : null),
    getActiveNetForArm: (idx) => (captureNetSystem.getActiveNetForArm
      ? captureNetSystem.getActiveNetForArm(idx) : null),
  });

  // --- UX-11 #11: "you're lost" recovery advisor (empty-scan bearing + out-of-range watchdog) ---
  navRecoveryAdvisor.init({
    player,
    debrisField,
    targetSelector,
    skillsSystem,
  });

  // --- Scan auto-select: unify every programmatic acquire behind one helper ---
  // After a scan settles with nothing selected, auto-select the best pane
  // contact and coach the next verb (N/D in range, A out of range). Also backs
  // Shift+N / Shift+A and autopilot's no-target fallback. Purely event-driven —
  // no per-frame update. Wired after HUD/reticle/navSphere exist.
  targetAcquisition.init({
    player,
    debrisField,
    sensorSystem,
    targetSelector,
    hud,
    targetReticle,
    navSphere,
    debrisWireframe,
    skillsSystem,
    guidanceDirector,
  });

  // --- UX-11 #12: dual-objective milestone comms (25/50/75/90% of either win track) ---
  // Live getters keep the SHOP_DEPLOY recap correct across save restore
  // (event caches alone go stale — review fix).
  missionMilestones.init({
    getCleared: () => gameState.debrisCleared,
    getContractKg: () => (shopScreen && typeof shopScreen.getContractMass === 'function'
      ? shopScreen.getContractMass() : 0),
  });

  // --- Collision Avoidance System (after inputManager so ref is valid) ---
  collisionAvoidanceSystem.init({
    player, debrisField, armManager, inputManager, resourceSystem,
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

  // --- Backdrop reveal (Option A): hide the gameplay ship during MENU ---
  // The menu canvas is now transparent, so the live orbital scene (Earth,
  // constellations, background debris) shows through behind the MenuScene3D
  // hero plate. The gameplay PlayerSatellite would otherwise appear as a
  // "second Mother" behind the hero. Hide the player root (+ docked arm
  // visuals) on entering MENU and restore on ANY exit (start, continue, and
  // the pause→menu path). The slow follow-camera still frames Earth/debris
  // even with the ship hidden (it tracks the hidden ship's position).
  // Owned here (not in MenuScreen) so the screen doesn't touch gameplay entities.
  const _setPlayerShipHidden = (hide) => {
    if (player) player.visible = !hide;
    // Docked daughters are separate scene objects tracking the struts; at MENU
    // they're usually LOCKED/STOWED (already hidden), but hide their groups too
    // so nothing peeks out behind the hero if a save left one deployed.
    if (armManager && Array.isArray(armManager.arms)) {
      for (const arm of armManager.arms) {
        if (arm && arm.group) arm.group.visible = !hide;
      }
    }
  };
  eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
    const inMenu = to === GameStates.MENU;
    _setPlayerShipHidden(inMenu);
    // Boost the background debris cloud so it reads as a visible dust field
    // behind the transparent menu, and restore it on any exit. Restoring
    // re-applies whatever hidden state was active (e.g. the Mission-1 hide).
    if (debrisField && typeof debrisField.setMenuBackdropBoost === 'function') {
      debrisField.setMenuBackdropBoost(inMenu);
    }
    // Re-arm the perf warmup/settle guard when entering a heavier state (menu →
    // briefing → sim). Building the mission scene spikes GPU time / drops FPS
    // for a beat; the settle window suppresses both FPS sampling and runtimeAdapt
    // until it elapses (see gameLoop), so that transient never enters the history.
    // Also clear any stale pre-transition gameplay samples so the post-settle
    // window starts empty.
    if (!inMenu) {
      _perfSettleUntil = performance.now() + Constants.PERF.ADAPT_WARMUP_MS;
      _fpsHistory.length = 0;
    }
  });

  // T4: reveal the real player ship EARLY — at ~65% of the menu→sim pull-back,
  // while still in MENU — so it is rendered + lit behind the receding hero and
  // the swap at the cut has no visibility pop / first-render hitch. Idempotent
  // with the GAME_STATE_CHANGE unhide that follows at MENU_START.
  eventBus.on(Events.MENU_DEPARTURE_REVEAL, () => {
    _setPlayerShipHidden(false);
  });

  // #5 (deep-polish-4): power-up FLASH mask at the menu→sim cut — but ONLY for the
  // 'partial' orientation treatment. The randomly-chosen 'flyaround' treatment
  // arcs the camera behind + de-rolls the hull so the cut is already orientation-
  // seamless and needs no mask (a flash there would be gratuitous). MenuScene3D
  // announces the per-departure mode via MENU_ORIENT_MODE. A brief blue-white
  // "reactor ignition" surge, centered on the ship, spanning the handoff frame;
  // narratively the ship powering up. Gentler under prefers-reduced-motion.
  let _orientMode = 'partial';
  eventBus.on(Events.MENU_ORIENT_MODE, ({ mode } = {}) => { _orientMode = mode || 'partial'; });
  let _powerupFlashEl = null;
  const _triggerPowerupFlash = () => {
    if (_orientMode === 'flyaround') return;   // seamless — no mask needed
    if (!_powerupFlashEl) {
      _powerupFlashEl = document.createElement('div');
      _powerupFlashEl.id = 'powerup-flash';
      _powerupFlashEl.style.cssText = [
        'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:9998',
        'opacity:0', 'mix-blend-mode:screen',
        'background:radial-gradient(circle at 50% 58%,' +
          ' rgba(206,228,255,0.95) 0%, rgba(120,178,255,0.42) 34%, rgba(48,96,190,0) 70%)',
      ].join(';');
      document.body.appendChild(_powerupFlashEl);
    }
    const reduced = !!(window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const peak = reduced ? 0.34 : 0.92;
    const fade = reduced ? 0.28 : 0.42;
    const el = _powerupFlashEl;
    el.style.transition = 'none';
    el.style.opacity = String(peak);
    void el.offsetHeight;            // force reflow so the peak applies before the fade
    requestAnimationFrame(() => {
      el.style.transition = `opacity ${fade}s ease-out`;
      el.style.opacity = '0';
    });
  };
  eventBus.on(Events.MENU_START, _triggerPowerupFlash);
  eventBus.on(Events.MENU_CONTINUE, _triggerPowerupFlash);

  // iPad web-app (Ipad.md §3): viewport truth lives in visualViewport — bar
  // swipes and the home-screen container resize it without a window resize
  // event, so BOTH sources are wired. onResize renders synchronously (~2–3 ms
  // GPU, see its comment), and one rotation gesture fires both sources — the
  // size-key guard makes each effective size change pay exactly once.
  let _lastResizeKey = '';
  const _resizeDeduped = () => {
    const vv = window.visualViewport;
    const key = `${window.innerWidth}x${window.innerHeight}` +
      (vv ? `|${Math.round(vv.width)}x${Math.round(vv.height)}@${vv.scale}` : '');
    if (key === _lastResizeKey) return;
    _lastResizeKey = key;
    onResize();
  };
  window.addEventListener('resize', _resizeDeduped);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _resizeDeduped);
  }

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
        if (typeof audioSystem._stopNetLoops === 'function') audioSystem._stopNetLoops();   // mother net whistle + winch (Phase B)
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
      if (typeof audioSystem._stopNetLoops === 'function') audioSystem._stopNetLoops();   // mother net whistle + winch (Phase B)
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
  // F7 boot resilience: this is the ONE place the loading screen is dismissed —
  // it fires only after init() has succeeded this far, so a failed boot leaves
  // the screen up and the index.html error handler can surface a failure card.
  // The `__bootOk` flag tells those handlers boot succeeded, so post-boot
  // runtime errors don't get mistaken for a boot failure.
  if (typeof window !== 'undefined') window.__bootOk = true;
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('hidden');
    setTimeout(() => loadingScreen.remove(), 1500);
  }

  // --- Start in MENU state ---
  gameState.currentState = GameStates.MENU;
  gameFlowManager.transitionToState(GameStates.MENU);

  // --- Menu orbit preview: aim the live backdrop at the selected language's
  // home corridor, and re-aim it (rate-capped ramp up/down) on LANGUAGE_CHANGED.
  // Cosmetic only — game start paths re-stage the same orbit authoritatively.
  menuOrbitPreview.init({ player });

  console.log('[Space Cowboy] Engine initialized. Starting game loop…');

  // PR 3 / P1.6 — Pre-compile shaders before first RAF to avoid first-frame stutter
  // when materials are encountered for the first time during gameplay.
  _bootMark('renderer.compile(). START (synchronous shader compile of all materials + composer passes)');
  try {
    sceneManager.renderer.compile(sceneManager.scene, sceneManager.camera);
  } catch (e) {
    console.warn('[Perf] renderer.compile failed:', e);
  }
  _bootMark('renderer.compile(). END');

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
      console.info('[AutoProfile] ready. Auto-starting in 5 s. To re-run later: call window.startAutoProfile() from DevTools (e.g. after entering ORBITAL_VIEW).');
      setTimeout(() => { window.startAutoProfile(); }, 5000);
    } catch (e) {
      console.warn('[AutoProfile] init failed:', e);
    }
  }

  // ── Flick-trace recorder (?trace=1): read-only gesture instrument, docs/ladder/07-flick-tuning.md ──
  if (new URLSearchParams(window.location.search).get('trace') === '1') {
    import('./dev/FlickTraceRecorder.js')
      .then(({ FlickTraceRecorder }) => { new FlickTraceRecorder({ probe: ladderController }).start(); })   // publishes window.__FLICK_TRACE
      .catch((e) => console.warn('[FlickTrace] init failed:', e));
  }

  // --- Net-visual screenshot loop (Phase 0 + auto-capture) ---
  // Dev-only, gated by `?shot=1` or `?shotauto=1` — the ONE shared predicate
  // (js/core/DevShotGate.js), which also flips on `preserveDrawingBuffer`
  // in SceneManager. Closes the "blind agent" loop: an agent on this host can
  // read back the exact #game-canvas pixels — no screen-recording permission,
  // no foreground-window dependency, no pause overlay obscuring the net.
  //
  //   window.__netPause(true|false) → freeze / resume the current frame
  //   window.__netShot('name')      → download ~/Downloads/netshot-<name>-<ts>.png
  //   window.__netAuto(true|false)  → auto-capture at each net FSM key beat
  //
  // Auto-capture (on by default with `?shotauto=1`, or `__netAuto(true)`) snaps a
  // frame at the net's deterministic ceremony beats (fired / envelop / brake /
  // cinch / captured / reel / berth / reelin / secured) for BOTH the Mother
  // (lasso:*) and Daughter (net:*) — removing manual-timing guesswork. The last
  // three are the Phase D mother beats (berth, reel-in end, secured) this net
  // visual plan is judged on. Files: netshot-auto-<beat>-<ts>.png.
  try {
    if (devShotGate.requested) {
      const _netCapture = (name) => {
        const cv = document.getElementById('game-canvas');
        if (!cv) { console.error('[netShot] #game-canvas not found'); return; }
        // preserveDrawingBuffer (set by the same DevShotGate predicate) keeps
        // the last rendered frame readable even while paused. The WebGL
        // frame's alpha is 0 in most pixels (the composer writes colour
        // without alpha), so a direct
        // toDataURL() yields a *transparent* PNG viewers show as white —
        // composite onto opaque black first so the export matches the screen.
        const flat = document.createElement('canvas');
        flat.width = cv.width;
        flat.height = cv.height;
        const ctx = flat.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, flat.width, flat.height);
        ctx.drawImage(cv, 0, 0);
        const url = flat.toDataURL('image/png');
        if (url.length < 1000) {
          console.warn('[netShot] canvas read-back looks empty — is ?shot=1 or ?shotauto=1 set and a frame rendered?');
        }
        const safe = String(name || 'frame').replace(/[^a-z0-9_-]/gi, '');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `netshot-${safe}-${ts}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        console.info(`[netShot] saved ${a.download}`);
        return a.download;
      };

      window.__netPause = (val) => {
        const next = (val === undefined) ? !gameFlowManager.paused : !!val;
        gameFlowManager.paused = next;
        if (next) {
          if (hud) hud.showPause();
        } else {
          if (hud) hud.hidePause();
          lastTime = performance.now();
          eventBus.emit(Events.PAUSE_RESUME);
        }
        return next;
      };
      window.__netShot = _netCapture;

      // ── Inspection camera hook (round-5 visual QA) ──
      //   window.__scbInspect(thetaDeg, phiDeg, distM)
      //     → ORBIT view at the given orbit angles + camera-ship distance in
      //       metres; engages the zoom-inspection sub-state when distM < 12
      //       via the normal Schmitt trigger (so vignette/FOV/callouts all
      //       follow the real code path).
      //   window.__scbInspectView(distM)
      //     → discrete INSPECTION view at the given distance.
      // Distances map to callout bands: SYSTEM ≥ 9 m, PART 5.5–8 m,
      // COMPONENT < 5.5 m (BAND in ui/MotherCallouts.js).
      window.__scbInspect = (thetaDeg = 0, phiDeg = 90, distM = 10) => {
        if (!cameraSystem) return 'no cameraSystem';
        cameraSystem.setView('ORBIT');
        const o = cameraSystem.orbit;
        o.theta = thetaDeg * Math.PI / 180;
        o.phi = phiDeg * Math.PI / 180;
        o.distance = distM * 1e-5;
        o.velocityTheta = 0;
        o.velocityPhi = 0;
        cameraSystem._evaluateInspectZoom();
        return { view: cameraSystem.currentView, inspectActive: o.inspectActive, distM };
      };
      window.__scbInspectView = (distM = 7) => {
        if (!cameraSystem) return 'no cameraSystem';
        cameraSystem.setView('INSPECTION');
        cameraSystem.inspection.distance = distM * 1e-5;
        return { view: cameraSystem.currentView, distM };
      };

      // ── P2 flower portrait hook (charter TASK J harness) ──
      //   window.__scbFlower(pairs)   → install aft-flower pair A (≥1) /
      //     pairs A+B (≥2) through the SAME applyUpgrade effect path a shop
      //     purchase drives, then report getFlowerStatus().
      //   window.__scbFlowerPose(p)   → drive the slew latch to a named
      //     ladder pose ('STOW' | 'PARK' | 'CARGO').
      window.__scbFlower = (pairs = 2) => {
        if (!player) return 'no player';
        if (pairs >= 1) player.applyUpgrade({ effect: 'flowerPairA', value: 1 });
        if (pairs >= 2) player.applyUpgrade({ effect: 'flowerPairB', value: 1 });
        return player.getFlowerStatus();
      };
      window.__scbFlowerPose = (pose = 'CARGO') => {
        if (!player) return 'no player';
        return { target: player.setFlowerPose(pose), status: player.getFlowerStatus() };
      };

      // ── Sky-pose hook (Stage 1 sky realism) ──
      //   window.__scbSkyPose(target, distM)
      //     → ORBIT view centred on a fixed patch of sky. `target` is either
      //       { ra, dec } (RA hours, Dec degrees) or a figure name like
      //       'CYGNUS' — the name path averages that figure's star directions
      //       and normalizes, which is exactly what "frame the whole figure"
      //       needs. Unlike __scbInspect's raw theta/phi (interpreted in the
      //       ship's rotating LVLH frame), this points at a fixed patch of sky
      //       regardless of where the ship is in its orbit — the acceptance
      //       criteria need that reproducibility.
      //     Returns the solved { theta, phi } plus an `occluded` flag — true
      //     when the target's angle to the Earth-centre direction is inside the
      //     limb angle (a figure genuinely behind Earth is physics, not a
      //     tooling failure, and the flag stops that being debugged as one).
      window.__scbSkyPose = (target, distM = 60) => {
        if (!cameraSystem) return 'no cameraSystem';
        const R = Constants.STAR_SPHERE_RADIUS;
        // Resolve the target to a unit world-space sky direction, reusing
        // Starfield's raDec2xyz so the basis convention stays in one place.
        let dir;
        if (typeof target === 'string') {
          const fig = CONSTELLATION_FIGURES.find((f) => f.name === target.toUpperCase());
          if (!fig) return { error: `unknown figure "${target}"` };
          dir = new THREE.Vector3();
          for (const name of fig.stars) {
            const s = BRIGHT_STARS[name];
            dir.add(raDec2xyz(s.ra, s.dec, R));
          }
          dir.normalize();
        } else if (target && typeof target.ra === 'number' && typeof target.dec === 'number') {
          dir = raDec2xyz(target.ra, target.dec, R).normalize();
        } else {
          return { error: 'target must be { ra, dec } or a figure name' };
        }

        // Solve the orbit angles that centre `dir` and write them exactly as
        // __scbInspect does. The basis must be current — update() caches it
        // every frame, so by the time a capture harness can call this the
        // first frame has already run.
        const { theta, phi } = cameraSystem.solveOrbitAnglesForDirection(dir);
        cameraSystem.setView('ORBIT');
        const o = cameraSystem.orbit;
        o.theta = theta;
        o.phi = phi;
        o.distance = distM * 1e-5;
        o.velocityTheta = 0;
        o.velocityPhi = 0;

        // Occlusion: is the target inside the Earth limb as seen from the
        // camera? Reuses _limbFadeFactor's geometry — factor 0 means fully
        // inside the limb (hidden), 1 means clear. The star's world position
        // includes the shell group's offset: (0,0,0) world-fixed (shipped), or
        // the camera pose while the ladder's F6/F7 follow mode is on
        // (Starfield.setFollowCamera) — without the add, this hook desyncs
        // from the followed shell.
        let occluded = false;
        const cam = cameraSystem.camera;
        if (cam && starfield) {
          const worldPos = dir.clone().multiplyScalar(R).add(starfield.group.position);
          occluded = starfield._limbFadeFactor(worldPos, cam) === 0;
        }
        return { theta, phi, occluded };
      };

      // Renderer info snapshot for the sky perf baseline (doctrine A.4) —
      // draw calls / points / triangles, read at HIGH and LOW so later sky
      // stages have something to diff against.
      window.__scbRendererInfo = () => {
        if (!sceneManager || !sceneManager.renderer) return null;
        const r = sceneManager.renderer.info.render;
        return { calls: r.calls, points: r.points, triangles: r.triangles, lines: r.lines };
      };
      // Raw handle for the perf harness, which needs to control info.autoReset
      // to get clean per-frame totals across the composer's multiple passes.
      window.__scbSceneManager = () => sceneManager;

      // Project a sky direction (ra hours, dec degrees) to canvas pixels, so a
      // capture harness can aim a crop / measurement at an exact star without
      // re-deriving the sky basis. Returns { x, y, behind } in CSS pixels.
      // The shell-group offset keeps this honest in the ladder's F6/F7
      // camera-follow mode (Starfield.setFollowCamera): world-fixed (shipped)
      // the group sits at the origin and the add is a no-op.
      window.__scbProject = (ra, dec) => {
        const cam = cameraSystem && cameraSystem.camera;
        if (!cam) return null;
        const v = raDec2xyz(ra, dec, Constants.STAR_SPHERE_RADIUS)
          .add(starfield.group.position)
          .project(cam);
        const cv = document.getElementById('game-canvas');
        return {
          x: (v.x * 0.5 + 0.5) * cv.width,
          y: (-v.y * 0.5 + 0.5) * cv.height,
          behind: v.z > 1,
        };
      };

      // ── Body-info hook (sun/moon/planets cleanup, Stage 0) ──
      //   window.__scbBodyInfo()
      //     → for each of Sun / Moon / the 5 planets: world position, ra/dec
      //       (inverse of Starfield's raDec2xyz convention), live
      //       material.opacity + blending, geometry radius, computed angular
      //       diameter, and the projected screen x/y + px diameter. The
      //       measurement harness must never guess object names — the bodies
      //       are read straight out of SunLight's own structures. px/° uses the
      //       camera's *live* vertical FOV (the inspect zoom and ARM_PILOT view
      //       change it, so Constants.CAMERA_FOV is not safe here).
      window.__scbBodyInfo = () => {
        const cam = cameraSystem && cameraSystem.camera;
        const cv = document.getElementById('game-canvas');
        if (!cam || !cv || !sunLight) return null;
        const pxPerDeg = cv.height / cam.fov;   // live FOV — see note above
        const _v = new THREE.Vector3();
        const project = (mesh, radiusWorld) => {
          mesh.getWorldPosition(_v);
          const dist = _v.distanceTo(cam.position);
          const p = _v.clone().project(cam);
          // Inverse of raDec2xyz: +Y north, RA 0 at +X, Z negated.
          const dir = _v.clone().normalize();
          const raRad = Math.atan2(-dir.z, dir.x);
          const raH = ((raRad * 12 / Math.PI) % 24 + 24) % 24;
          const decDeg = Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI;
          const angDeg = 2 * Math.atan(radiusWorld / dist) * 180 / Math.PI;
          return {
            x: (p.x * 0.5 + 0.5) * cv.width,
            y: (-p.y * 0.5 + 0.5) * cv.height,
            behind: p.z > 1,
            dist,
            ra: raH,
            dec: decDeg,
            angularDiameterDeg: angDeg,
            pxDiameter: angDeg * pxPerDeg,
          };
        };
        const blendingName = (b) => ({
          [THREE.NormalBlending]: 'NormalBlending',
          [THREE.AdditiveBlending]: 'AdditiveBlending',
          [THREE.CustomBlending]: 'CustomBlending',
        })[b] || String(b);
        const out = { pxPerDeg, bodies: {} };

        // Sun: glare sprite scale is the full width at distance 450 (half-extent 7.5).
        if (sunLight.sunSprite) {
          out.bodies.Sun = Object.assign(project(sunLight.sunSprite, sunLight.sunSprite.scale.x / 2), {
            opacity: sunLight.sunSprite.material.opacity,
            blending: blendingName(sunLight.sunSprite.material.blending),
            geometryRadius: sunLight.sunSprite.scale.x / 2,
            visible: sunLight.sunSprite.visible,
            kind: 'glare-sprite',
          });
        }
        // Moon: CircleGeometry(radius 5.6).
        if (sunLight.moonMesh) {
          out.bodies.Moon = Object.assign(project(sunLight.moonMesh, sunLight.moonMesh.geometry.parameters.radius), {
            opacity: sunLight._moonMaterial.uniforms
              ? sunLight._moonMaterial.uniforms.uOpacity.value   // Stage 3 ShaderMaterial
              : sunLight._moonMaterial.opacity,
            blending: blendingName(sunLight._moonMaterial.blending),
            geometryRadius: sunLight.moonMesh.geometry.parameters.radius,
            visible: sunLight.moonMesh.visible,
            kind: 'disc',
          });
        }
        // Planets: SunLight._planets holds { name, disc, glow, label, depthMask, deg, radius }.
        // Saturn's disc is a PlaneGeometry(planeSize²) — report the globe radius
        // (radius) as the body's angular size, and the plane half-extent as the
        // ring span, since the two answer different questions.
        if (sunLight._planets) {
          for (const p of sunLight._planets) {
            const gp = p.disc.geometry.parameters;
            const isPlane = typeof gp.width === 'number';   // PlaneGeometry has .width, CircleGeometry has .radius
            const bodyRadius = p.radius;                    // the def's globe radius, always meaningful
            out.bodies[p.name] = Object.assign(project(p.disc, bodyRadius), {
              opacity: p.disc.material.opacity,
              blending: blendingName(p.disc.material.blending),
              geometryRadius: isPlane ? gp.width / 2 : gp.radius,
              kind: isPlane ? 'ring-plane' : 'disc',
              visible: p.disc.visible,
              // Ring span for the ring-plane bodies: the drawn rings end at
              // ~2.27 globe radii on a texture where globeR = 0.19 × size, so
              // the visible span is ~0.86 of the plane. Report the plane's
              // angular width; the harness measures the real span from pixels.
              planeAngularWidthDeg: isPlane
                ? 2 * Math.atan(gp.width / 2 / p.disc.position.distanceTo(cam.position)) * 180 / Math.PI
                : undefined,
            });
          }
        }
        return out;
      };

      // ── Moon-phase hook (sun/moon/planets cleanup, Stage 0) ──
      //   window.__scbSetMoonPhase(frac)
      //     → forces the moon's elongation so it can be captured at any phase
      //       without waiting days: 0 = new (beside the sun), 0.5 = full
      //       (opposite the sun). The lever already exists — _updateMoon builds
      //       the direction from `moonAngle = sunAngle + _moonAzOffset`, so
      //       _moonAzOffset *is* the elongation. Setting it to frac × 2π makes
      //       the existing dot-product phase math follow; there is no parallel
      //       phase variable. Returns the applied offset in degrees.
      window.__scbSetMoonPhase = (frac) => {
        if (!sunLight || typeof frac !== 'number' || !isFinite(frac)) return null;
        sunLight._moonAzOffset = frac * 2 * Math.PI;
        return { moonAzOffsetDeg: frac * 360 };
      };
      // Debug handle for click-path / layout introspection (codex click debug).
      window.__callouts = motherCallouts;
      // Wave 5 (2): the REFIT pane handle for the witness harness (undefined
      // on a ?ladder=0 boot — the pane is never constructed there).
      window.__refit = refitPane;
      // Wave 5 (Session B): the TECH LIBRARY pane handle, same contract.
      window.__library = libraryPane;
      // Debug handle for SunLight — lets a capture harness inspect bodies and
      // (for verification) temporarily reposition a body that is occluded all
      // session. Read-only intent; mutations are the harness's responsibility.
      window.__scbSunLight = sunLight;

      // ── Galactic-coordinate hook (Milky Way, Stage 6) ──
      //   window.__scbGalactic(L_deg, b_deg) → { ra, dec }
      //     Converts galactic longitude/latitude (degrees) to RA/Dec using the
      //     real galactic basis, so a capture harness can pose at / project any
      //     band point (the band centerline is b=0). Inverse of the basis that
      //     orients the band.
      window.__scbGalactic = (Ldeg, bdeg) => {
        const b = galacticBasis();
        const L = Ldeg * Math.PI / 180, lat = bdeg * Math.PI / 180;
        const cl = Math.cos(L) * Math.cos(lat), sl = Math.sin(L) * Math.cos(lat), sb = Math.sin(lat);
        const x = b.center.x * cl + b.e2.x * sl + b.pole.x * sb;
        const y = b.center.y * cl + b.e2.y * sl + b.pole.y * sb;
        const z = b.center.z * cl + b.e2.z * sl + b.pole.z * sb;
        // Inverse of raDec2xyz: +Y north, RA 0 at +X, Z negated.
        const ra = Math.atan2(-z, x) * 12 / Math.PI;
        const dec = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
        return { ra: ((ra % 24) + 24) % 24, dec };
      };

      // ── Deterministic auto-capture at net FSM key beats ──
      let _autoOn = devShotGate.shotautoRequested;
      const _beatsDone = new Set();   // debounce: one shot per beat per net cycle
      // Snap after the new state has had two frames to render (and a touch of
      // settle) so the captured frame shows the beat, not the transition into it.
      const _snap = (beat, delayMs = 140) => {
        if (!_autoOn || _beatsDone.has(beat)) return;
        _beatsDone.add(beat);
        setTimeout(() => {
          requestAnimationFrame(() => requestAnimationFrame(() => _netCapture(`auto-${beat}`)));
        }, delayMs);
      };
      const _resetCycle = () => { _beatsDone.clear(); };

      window.__netAuto = (on) => {
        _autoOn = (on === undefined) ? !_autoOn : !!on;
        console.info(`[netShot] auto-capture ${_autoOn ? 'ON' : 'OFF'}`);
        return _autoOn;
      };

      if (eventBus && Events) {
        // Mother (LassoSystem) — current production launch path
        if (Events.LASSO_FIRED)   eventBus.on(Events.LASSO_FIRED,   () => { _resetCycle(); _snap('fired', 550); });
        if (Events.LASSO_CONTACT) eventBus.on(Events.LASSO_CONTACT, () => _snap('contact'));
        if (Events.LASSO_CAPTURED)eventBus.on(Events.LASSO_CAPTURED,() => _snap('captured', 250));
        if (Events.LASSO_STOWED)  eventBus.on(Events.LASSO_STOWED,  () => _snap('reel', 250));
        // Daughter / unified (CaptureNet) ceremony beats
        if (Events.NET_FIRED)       eventBus.on(Events.NET_FIRED,       () => { _resetCycle(); _snap('fired', 550); });
        if (Events.NET_ENVELOP_PEAK)eventBus.on(Events.NET_ENVELOP_PEAK,() => _snap('envelop'));
        if (Events.NET_BRAKE_FIRED) eventBus.on(Events.NET_BRAKE_FIRED, () => _snap('brake'));
        if (Events.NET_CINCH_PROGRESS) eventBus.on(Events.NET_CINCH_PROGRESS, (p) => {
          if (p && typeof p.fraction === 'number' && p.fraction >= 0.85) _snap('cinch');
        });
        if (Events.NET_CATCH_SUCCESS) eventBus.on(Events.NET_CATCH_SUCCESS, () => _snap('captured', 250));
        if (Events.NET_REEL_STARTED)  eventBus.on(Events.NET_REEL_STARTED,  () => _snap('reel', 250));
        // Phase D mother beats (visual-centerpiece plan §5 S1) — the berth,
        // reel-in end, and secured beats this plan is judged on. NET_BERTHED
        // fires the clunk-settle at the launcher (the REEL_IN cinematic is
        // released here, so `berth` captures its resolved pose); NET_REEL_COMPLETED
        // marks the reel-in cinematic's end. `secured` is wired to NET_BERTHED +
        // HALF the securing timer — NOT NET_CEREMONY_COMPLETE: that event fires
        // at catch time, microseconds after NET_CATCH_SUCCESS, so the old wiring
        // made `secured` a misnamed duplicate of `captured` (P2.3). Mid-hold is
        // the truthful secured pose (catch settled at the pod) with a safe margin
        // before CATCH_PROCESSED removes it at the full BERTH_SECURE_S.
        if (Events.NET_BERTHED)         eventBus.on(Events.NET_BERTHED,         () => {
          _snap('berth', 350);
          _snap('secured', (Constants.CAPTURE_NET?.BERTH_SECURE_S ?? 4.0) * 500);
        });
        if (Events.NET_REEL_COMPLETED)  eventBus.on(Events.NET_REEL_COMPLETED,  () => _snap('reelin', 300));
      }

      // ── Deterministic whale-capture scenario (mother-net visual plan T2) ──
      //   window.__netScenario()
      //     → stages the identical mother-net capture every run: skips the
      //       intro zoom, pins a fixed rocketBody whale 25 m off the nose,
      //       fires pod 0 with every capture roll overridden (cling 0 =
      //       catch, frag/strain 1 = never), so before/after screenshots
      //       compare the LOOK, not the RNG. Pair with __netAuto(true) to
      //       collect the 9 ceremony beats.
      //     Returns { ok, whaleId, mass, distanceM, podIndex } or
      //     { ok: false, reason } — guarded, never throws.
      //     Options: `__netScenario({ tumble })` where `tumble` is 'nominal'
      //       (default), 'adverse', 'off', or { kitAxis, kitDeg } — register item
      //       13: the catch's tumble attitude is pinned in the KIT frame so both
      //       live gates measure one attitude instead of a per-run draw. Read the
      //       applied pin back with `__netScenarioTumblePin()`.
      let _scenarioPinReleaseOff = null;
      let _scenarioNet = null;
      let _scenarioAimInvariant = null;
      let _scenarioTumblePin = null;
      // ── Register item 13: the catch's pinned tumble presets ──────────────
      // Plan: .kilo/plans/1786017377440-pin-scenario-catch-tumble.md (D3/D4).
      // Attitudes are KIT-frame (kit −Z is the launch bearing, so X/Y lie across
      // the bag mouth), measured with tmp/g6-attitude-{sweep,local}.mjs over the
      // shared NetMeshKit.chordBoxPenetration export:
      //   nominal x@120° → chord 0.447 m, flat to ±10 mm per ±5°, presents 2.58 m
      //   adverse y@150° → chord 0.666 m (the box-core plateau), flat to ±1 mm
      // Never re-pick a preset by trying attitudes until a gate reads well: both
      // the pixel band and item 12's before/after are derived from these numbers,
      // so a move must re-run the sweep and be recorded in the plan.
      const _SCENARIO_TUMBLE_PRESETS = {
        nominal: { name: 'nominal', kitAxis: { x: 1, y: 0, z: 0 }, kitDeg: 120 },
        adverse: { name: 'adverse', kitAxis: { x: 0, y: 1, z: 0 }, kitDeg: 150 },
      };
      /** Resolve the `tumble` option: undefined ⇒ nominal, 'off'/null ⇒ no pin. */
      const _resolveScenarioTumble = (t) => {
        if (t === undefined) return _SCENARIO_TUMBLE_PRESETS.nominal;
        if (t === null || t === false || t === 'off' || t === 'none') return null;
        if (typeof t === 'string') return _SCENARIO_TUMBLE_PRESETS[t] || null;
        if (typeof t === 'object' && t.kitAxis) {
          const a = t.kitAxis;
          // Pass the numbers through UNCOERCED — `+x || 0` would turn a typo'd
          // angle into a silent 0° pin, which reads as a valid gate measurement
          // of the wrong attitude. worldTumbleForKitAttitude rejects anything
          // non-finite, so a bad custom spec becomes "no pin" and the harness
          // fails loudly instead.
          return {
            name: t.name || 'custom',
            kitAxis: { x: a.x ?? a[0], y: a.y ?? a[1], z: a.z ?? a[2] },
            kitDeg: Number(t.kitDeg),
          };
        }
        return null;
      };
      // Whale-in-cone plan Task 2.5 — read-back for the aim-invariant unit test.
      window.__netScenarioAimInvariant = () => _scenarioAimInvariant;
      // Register item 13 — read-back for the harness's provenance line and its
      // achieved-vs-intended attitude check (null ⇒ no pin was applied).
      window.__netScenarioTumblePin = () => _scenarioTumblePin;
      // ── Register item 14 (2026-08-07): the ship-attitude hold ─────────────
      // Plan: .kilo/plans/1786068498588-pin-scenario-ship-attitude.md.
      // The tumble pin (item 13) holds the CATCH's attitude exactly, but from
      // REELING on CaptureNet._applyCatchOrientation rewrites it every frame as
      // shipQuat ⊗ _qLocal, and the ship tracks PROGRADE (PlayerSatellite's
      // rigid path rebuilds quaternion = prograde ⊗ _manualRotation from the
      // live orbital velocity each frame). As the orbit propagates at 10× world
      // time, the ship's rotation conjugates the catch away from the pin —
      // measured ATTITUDE-DRIFT 4.5–9.0° by end of window, BERTHED chord max
      // 0.282–0.284 vs the stable REELING 0.159. Because the chord metric is a
      // MAX over the seated window and the berth hold's length is wall-clock/
      // frame-rate luck (setTimeout snaps under the dt cap), the headline max
      // was run-length-dependent on identical code. This hold removes the drift
      // at the root: latch the ship's quaternion at NET_CATCH_SUCCESS (the value
      // _qLocal is latched against at reel entry, so the catch's attitude stays
      // EXACTLY the pin in both auto-reel orderings) and overwrite the compose
      // every frame until CATCH_PROCESSED. Staging-only; zero production change.
      //   `ship` option: undefined ⇒ hold whenever a tumble pin is applied;
      //   'off'/null/false ⇒ never hold (the item-13-era control basis).
      //   TUMBLE off ⇒ never hold (the pre-item-13 lottery stays untouched).
      const _SHIP_HOLD = { armed: false, engaged: false, everEngaged: false, quat: null };
      let _scenarioShipHoldOff = null;
      const _resolveScenarioShip = (s) => {
        if (s === undefined) return true;    // default: hold when a tumble pin applies
        if (s === null || s === false || s === 'off' || s === 'none') return false;
        return s === true || s === 'hold';
      };
      // Smooth handback (plan D3): fold the held offset into _manualRotation so
      // the next prograde compose equals the held attitude and the RECENTER_RATE
      // servo eases it back to prograde — no ~10° snap in a long-lived dev page.
      // NOTE: everEngaged is deliberately NOT cleared here — it survives
      // disengagement so the harness's end-of-window check can distinguish
      // "held the whole window, then processed" from "never engaged" (a run that
      // reaches CATCH_PROCESSED before the drift read is a VALID held run).
      // It resets only where no held measurement can exist: re-staging,
      // fire-refusal, and a catch MISS (all start a fresh hold lifecycle).
      const _disengageShipHold = () => {
        try {
          if (_SHIP_HOLD.engaged && _SHIP_HOLD.quat && player?._manualRotation) {
            const pg = typeof player._progradeQuat === 'function'
              ? player._progradeQuat(new THREE.Quaternion()) : null;
            if (pg) player._manualRotation.copy(pg.invert()).multiply(_SHIP_HOLD.quat);
          }
        } catch (_e) { /* dev-only handback; never break the scenario */ }
        _SHIP_HOLD.armed = false; _SHIP_HOLD.engaged = false; _SHIP_HOLD.quat = null;
      };
      // Called once per frame from gameLoop, IMMEDIATELY after player.update —
      // the call site is load-bearing: the reel/berth ticks read
      // player.quaternion inside captureNetSystem.update later this frame, so
      // the overwrite must land after the prograde compose and before that read
      // (an end-of-loop site would be overwritten before the net ever sees it).
      // One null-check per frame when disarmed (the freeze hooks' cost contract).
      window.__netShipHoldTick = () => {
        if (!_SHIP_HOLD.armed) return;
        try {
          if (_SHIP_HOLD.engaged && _SHIP_HOLD.quat) player.quaternion.copy(_SHIP_HOLD.quat);
        } catch (_e) { /* dev-only hold must never break the game loop */ }
      };
      // Read-back for the harness's provenance line and its engaged check.
      window.__netScenarioShipHold = () => ({
        armed: _SHIP_HOLD.armed,
        engaged: _SHIP_HOLD.engaged,
        everEngaged: _SHIP_HOLD.everEngaged,
        quat: _SHIP_HOLD.quat
          ? { x: +_SHIP_HOLD.quat.x.toFixed(6), y: +_SHIP_HOLD.quat.y.toFixed(6), z: +_SHIP_HOLD.quat.z.toFixed(6), w: +_SHIP_HOLD.quat.w.toFixed(6) }
          : null,
      });
      // Dev-only live-net accessor for scenario forensics (same __net* hook
      // convention as __netScenarioProbe; read-only — never mutate through it).
      window.__scbScenarioNet = () => _scenarioNet;
      // Register item 9: the DRAWN catch scale, decomposed from the instance
      // matrix the pin actually wrote, beside the clamp-aware SSOT read — the
      // direct probe-vs-pixels agreement witness (i8a read probe 2.000 while the
      // unclamped pin drew 1.522). On-demand pure function, no tick, no
      // per-frame cost (the __net* cost contract).
      window.__netDrawnScale = () => {
        try {
          const M = 0.00001;
          const whale = _scenarioNet?.targetDebris;
          if (!whale || whale.id == null || !debrisField) return { ok: false, reason: 'no scenario catch' };
          const lookup = debrisField._instanceLookup?.get(whale.id);
          const mesh = lookup && debrisField.instancedMeshes?.[lookup.meshKey];
          if (!mesh) return { ok: false, reason: 'no instance slot' };
          const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          mesh.getMatrixAt(lookup.instanceIndex, m);
          m.decompose(p, q, s);
          DebrisWireframe.getGeometry(whale.type, whale.id);   // br cache (uncached ⇒ 1)
          const br = DebrisWireframe.getBoundingRadius(whale.type, whale.id) || 1;
          const probeScale = DebrisField.effectiveRenderScale(whale);
          return {
            ok: true,
            netState: _scenarioNet?.state ?? null,
            drawnScale: s.x,
            drawnRadiusM: +(s.x * br / M).toFixed(3),
            probeScale,
            probeRadiusM: +(probeScale * br / M).toFixed(3),
            agreeM: +((s.x - probeScale) * br / M).toFixed(4),
            catchRenderMin: typeof whale._catchRenderMin === 'number' ? whale._catchRenderMin : null,
          };
        } catch (e) { return { ok: false, reason: String(e) }; }
      };
      window.__netScenario = (opts) => {
        try {
          if (!player || !debrisField || !cameraSystem) return { ok: false, reason: 'sim not up' };
          const list = debrisField.debrisList || [];
          if (!list.length) return { ok: false, reason: 'debris field empty' };

          // ── Small-catch plan W1 (2026-08-25): `subject` option ──────────
          // 'whale' (default) = the historical ~2 m cubesat staging below,
          // byte-identical (the regression subject every recorded gate ran
          // against). 'fragment' = the owner's REAL catch class: a live
          // welcome-field icosahedron fragment, sub-metre logical size, real
          // fragment mass, and — deliberately — NO `_catchRenderMin` freeze:
          // the production readability floor (CN.MOTHER_CATCH_MIN_RENDER_M
          // ramp from reel entry) is part of the look under diagnosis (the
          // "geometric ball" IS the floored icosahedron). Everything else
          // (25 m prograde pin, aimed fire, roll overrides, tumble pin, ship
          // hold) is shared so the two subjects differ ONLY in the catch.
          const subject = (opts && opts.subject === 'fragment') ? 'fragment' : 'whale';

          // 1. The intro zoom eases over real dt — kill it so framing is fixed.
          cameraSystem.skipIntroZoom?.();

          // 2. Pick the whale deterministically from the LIVE welcome cluster.
          //
          //    MEASURED: on mission 1 DebrisField's enforcement pass kills
          //    every piece that is not `welcomeSpawn` — `alive = false`,
          //    `tracked = false`, instance scaled to zero (DebrisField.js
          //    :1428-1436 for the blanket hide, :1478-1487 for the distance
          //    cull). A naive `find(type === 'rocketBody')` therefore returns
          //    a CORPSE: dead pieces are skipped by the update loop, so their
          //    `_scenePosition` freezes (it read 5817 km out, drifting at the
          //    ship's own 7.7 km/s) and the net has nothing to fly at — a
          //    pre-flight range refusal, i.e. the missing envelop/brake/cinch
          //    beats. Restrict to live welcome pieces, prefer a rocketBody,
          //    else take the heaviest and raise its mass to whale grade.
          //    `_meshKey` is still NEVER reassigned (see Traps) — only mass,
          //    which is what MOTHER_MIN_MASS actually gates on.
          const live = list.filter(d => d && d.alive && d.welcomeSpawn);
          let whale;
          if (subject === 'fragment') {
            // W1: the welcome cluster is mostly `fragment` rows (#1–#6), so a
            // live pick always exists on mission 1. Prefer a CHUNK variant —
            // the plate variants are flat shards, and the diagnosis under
            // repro (D2's "geometric ball") is the icosahedron BODY read.
            // Deterministic: first match in list order, same idiom as the
            // whale's find().
            const NV = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
            const frags = live.filter(d => d.type === 'fragment');
            whale = frags.find(d => !DebrisWireframe.isPlateVariant((d.id >>> 0) % NV)) || frags[0];
          } else {
            whale = live.find(d => d.type === 'rocketBody')
              || live.slice().sort((a, b) => (b.mass || 0) - (a.mass || 0))[0];
          }
          if (!whale) return { ok: false, reason: 'no live welcome-field debris (mission-1 enforcement hides catalog pieces)' };

          // 3. Fixed silhouette + physics. Whale-in-cone phase 3 (D1):
          //    sizeMeter is NOT the rendered size — the renderer scales the
          //    instance by sceneSize, and the rendered extent is
          //    renderScale × DebrisWireframe.getBoundingRadius(type, id).
          //    Derive the size from a DESIRED RENDERED RADIUS, then raise it
          //    to CN.MOTHER_CATCH_MIN_RENDER_M so the net-held readability
          //    clamp (DebrisField._updateInstanceTransform, W5) is a no-op and
          //    the catch cannot pop 1.5× larger at the CAPTURED transition.
          //    (The old "7 m presents under the 8 m net diameter from any
          //    tumble angle" comment compared a logical sizeMeter against the
          //    mouth DIAMETER while the renderer read a different field
          //    entirely — right intent, wrong arithmetic — and ignored the
          //    drape/cinch shrink that decides what the beat shows.)
          //    600 kg clears the 500 kg whale threshold (MOTHER_MIN_MASS),
          //    ~12% of the LARGE net's 5000 kg rating so the strain roll never
          //    arms; oversize_aspect is safe (presentedWidthForApproach reads
          //    lengthM/sizeMeter — 2.0 m ≪ the 8 m DIAMETER). Knock-ons, both
          //    scenario-only: the berth standoff drops 4.5 m → 2.0 m (W12) and
          //    the HUD target panel / ToolOdds / ToolRecommender see a 2.0 m
          //    target instead of 7 m.
          //    Register item 7 (2026-08-10): that oversize line is now TRUE by
          //    the value it names — post-item-7 the setter re-derives
          //    lengthM/widthM (2.0 / 1.82) instead of leaving the stale 0.30 /
          //    0.27 this comment's claim accidentally relied on.
          if (subject === 'fragment') {
            // W1 fragment staging (small-catch plan, 2026-08-25) — production-
            // faithful on purpose, the OPPOSITE of the whale branch below:
            //   • 0.5 m logical size — the owner's 0.3–0.6 m band; rendered
            //     radius = 0.5 × br(variant) ≈ 0.5–0.65 m (sub-metre).
            //   • 2 kg — the real fragment mass band (0.01–5 kg), so the
            //     collar digestion runs the digestSpanS FLOOR (60 game-s ≈
            //     6 wall-s) and the filmstrip can include the whole chop/feed
            //     tail (D2/W3's subject) inside a sane CAP_MS.
            //   • NO `_catchRenderMin` freeze and NO mass raise — the
            //     production readability floor (CN.MOTHER_CATCH_MIN_RENDER_M
            //     ramp from reel entry, CaptureNet._catchFloorScale) and the
            //     real small-catch arithmetic ARE the look under diagnosis.
            //     Every recorded whale gate stays on the frozen branch below,
            //     bit-comparable with its own history.
            whale.mass = 2;
            DebrisField.setDebrisSize(whale, 0.5);
            whale.brittleness = 0.3;
          } else {
          whale.mass = 600;
          // Register item 8 (2026-08-07; plan 1786109997497): freeze the staged
          // whale's `_catchRenderMin` at 0 — swallow the per-frame floor writes
          // from the reel/berth ticks. The corrected floor (a true rendered-
          // radius floor in metres now) is a gameplay READABILITY aid that
          // deliberately draws a sub-floor held catch larger than physics and
          // fattens the bag's contents box to match (CaptureNetVisual reads the
          // clamp-aware effectiveRenderScale — W5 by design). The scenario's
          // measurement subject is the opposite contract (SCALE-GATE + popFactor
          // ≈ 1.00: the rendered whale IS the whale physics believes in), and
          // pre-item-8 D1's sizing made the buggy floor a no-op. Post-fix the
          // floor fires on the staged whale (measured live this session:
          // rendered radius 1.522 → 2.000 m at the catch, popFactor 1.314, and
          // the held-state chord family re-basing 0.159 → 0.208 as the box
          // fattens). A per-frame zeroing tick CANNOT work — the reel/berth
          // ticks rewrite the field later the same frame, before the visual's
          // floor read. Freezing the property on the staged object is the only
          // race-free opt-out: dev-only, per-debris, zero production code
          // change — every gate stays bit-comparable with the item-14 family
          // while production catches keep the corrected floor.
          // Register item 9 (2026-08-08; plan 1786153380617): the freeze now
          // covers BOTH matrix writers — `pinCapturedDebris` reads the floor
          // through `effectiveRenderScale` too, whose predicate reads this
          // getter's 0 exactly as `_updateInstanceTransform`'s does. So the
          // staged whale still draws at physics size on every frame, and the
          // measured gate family below is unchanged by that unification.
          try {
            Object.defineProperty(whale, '_catchRenderMin', {
              get: () => 0, set: () => {}, configurable: true,
            });
          } catch (_e) { /* non-configurable (paranoia) — the floor then fires as in production */ }
          const TARGET_RENDER_RADIUS_M = 1.5;
          DebrisWireframe.getGeometry(whale.type, whale.id);   // populate the br cache (uncached ⇒ 1)
          const br = DebrisWireframe.getBoundingRadius(whale.type, whale.id) || 1;
          DebrisField.setDebrisSize(whale, Math.max(
            TARGET_RENDER_RADIUS_M / br,
            Constants.CAPTURE_NET.MOTHER_CATCH_MIN_RENDER_M,
          ));                               // cubesat br 0.7610 ⇒ sizeMeter 2.0 ⇒ rendered radius 1.522 m
          whale.brittleness = 0.3;
          }   // end whale-subject staging (W1: fragment branch above)

          // 4. Put the whale 25 m ahead — CO-ORBITAL FIRST, then pinned.
          //
          //    MEASURED, not assumed: `_onboardingPinned` alone does NOT move
          //    a distant body. With every pin precondition satisfied
          //    (_onboardingPinned, _motherFwd/_motherRight, instance slot,
          //    canonical ref) a whale 5817 km away stayed 5817 km away while
          //    the pin arithmetic itself was correct (~60 m) — the orbit
          //    branch keeps authoring `_scenePosition`. The tease pin is a
          //    hold-in-place override for pieces ALREADY co-orbital with the
          //    mother (spawnWelcomeField repositions them first); it is not a
          //    teleport. So copy the mother's elements onto the whale and
          //    advance its true anomaly by the along-track angle for 25 m —
          //    then the orbit branch and the pin agree, and the net's 11 s
          //    flight envelope actually reaches it.
          //
          //    25 m, not 60: `launchDirection` is frozen at fire
          //    (CaptureNet.js:501) while the pinned whale rides the ROTATING
          //    LVLH frame, and the orbit propagates at TIME_SCALE_GAMEPLAY 10×
          //    wall while the net flies at ~0.5× ceremony dilation — per metre
          //    of flight the frame rotates ~2.3 mrad, so a 60 m stage lands
          //    ~7 m wide of the mouth (measured 2026-08-02: netToWhaleM min
          //    7.0 m vs the 4 m LARGE radius → deterministic miss, no contact
          //    beats ever fire). At 25 m the error is ~1.4 m ≪ 4 m, the shot
          //    is inside CN.CLOSE_RANGE (30 m) so CATCH_RADIUS_FORGIVENESS
          //    applies, and the catch resolves inside the ceremony beats.
          const M = 0.00001; // 1 metre in scene units (same M as InputManager)
          const pElems = (typeof player.getOrbitalElements === 'function')
            ? player.getOrbitalElements() : null;
          if (!pElems) return { ok: false, reason: 'no player orbit' };
          if (!whale.orbit) whale.orbit = {};
          whale.orbit.semiMajorAxis = pElems.semiMajorAxis;
          whale.orbit.eccentricity  = pElems.eccentricity;
          whale.orbit.inclination   = pElems.inclination;
          whale.orbit.raan          = pElems.raan;
          whale.orbit.argPerigee    = pElems.argPerigee;
          whale.orbit.meanMotion    = pElems.meanMotion;
          // Along-track angle for 25 m at this radius (elements are in scene
          // units: 1 scene unit = 100 km, so 25 m = 25e-5).
          const dNu = (25 * M) / Math.max(1e-9, pElems.semiMajorAxis);
          whale.orbit.trueAnomaly = pElems.trueAnomaly + dNu;
          // Pin as well: it holds the piece steady in the mother's frame for
          // the render/selection path, and registering the id is what makes
          // DebrisField compute the _motherFwd/_motherRight basis at all.
          whale._onboardingPinned = true;
          whale._onboardingPinFwd = 25 * M;
          whale._onboardingPinLat = 0;
          debrisField._onboardingPinIds?.add(whale.id);

          // 5. Select it so every aiming/reticle path agrees on the target.
          targetSelector.setTarget(whale);

          // 6. Fire pod 0 AT the pinned whale — not along ship +Z. The pin
          //    sits on the prograde axis, and nose ≠ prograde whenever the
          //    attitude is driven (launch cinematic, slews), so an aimed
          //    shot is the only attitude-independent fire. Compute the pin
          //    position analytically (same math as DebrisField's basis):
          //    pinnedPos = playerPos + prograde × 25 m; dir = muzzle → pin.
          const pOrbit = (typeof player.getOrbitalElements === 'function')
            ? player.getOrbitalElements() : null;
          if (!pOrbit) return { ok: false, reason: 'no player orbit' };
          // orbitToSceneCartesianInto needs a position write-slot, but only the
          // velocity (_cv) is consumed here — position comes from playerPos.
          // _cp is a throwaway required by the helper, never read.
          const _cp = { x: 0, y: 0, z: 0 }, _cv = { x: 0, y: 0, z: 0 };
          orbitToSceneCartesianInto(pOrbit, _cp, _cv);
          void _cp;
          const vl = Math.hypot(_cv.x, _cv.y, _cv.z) || 1;
          const playerPos = player.getPosition();
          const pinnedPos = {
            x: playerPos.x + (_cv.x / vl) * 25 * M,
            y: playerPos.y + (_cv.y / vl) * 25 * M,
            z: playerPos.z + (_cv.z / vl) * 25 * M,
          };
          // Whale-in-cone plan: freeze the whale's pin basis at FIRE-time prograde.
          // The ceremony runs ~19 s wall-clock but the world/orbit propagate at
          // TIME_SCALE_GAMEPLAY×10 (~190 s), slewing prograde ~12.5°. The pin
          // normally tracks live prograde (DebrisField._motherFwd rebuilt each
          // frame), so the whale would ride that slew and walk laterally out of
          // the frozen capture cone. Latching the fire-time basis keeps the
          // pinned target on the same frozen line the net flies. Build the basis
          // with DebrisField's exact construction (fwd = prograde, right = fwd×radial).
          const _rl = Math.hypot(playerPos.x, playerPos.y, playerPos.z) || 1;
          const _fx = _cv.x / vl, _fy = _cv.y / vl, _fz = _cv.z / vl;
          const _rx = playerPos.x / _rl, _ry = playerPos.y / _rl, _rz = playerPos.z / _rl;
          let _gx = _fy * _rz - _fz * _ry, _gy = _fz * _rx - _fx * _rz, _gz = _fx * _ry - _fy * _rx;
          const _gl = Math.hypot(_gx, _gy, _gz) || 1; _gx /= _gl; _gy /= _gl; _gz /= _gl;
          debrisField._onboardingPinBasisOverrides?.set(whale.id, {
            fwd: { x: _fx, y: _fy, z: _fz },
            right: { x: _gx, y: _gy, z: _gz },
          });
          const posScene = (typeof player.getNetPodPosition === 'function')
            ? player.getNetPodPosition(0) : playerPos;
          const b = new THREE.Vector3(pinnedPos.x - posScene.x, pinnedPos.y - posScene.y, pinnedPos.z - posScene.z);
          if (b.lengthSq() > 0) b.normalize();
          let dir = { x: b.x, y: b.y, z: b.z };
          // Whale-in-cone plan Task 2 (2026-08-04): the direct muzzle→pin bearing
          // IS the correct aim. The pinned whale's _scenePosition and this
          // pinnedPos are the same formula (playerPos + prograde×25 m,
          // DebrisField.js:1834-1841), both relative to playerPos, so ship
          // translation cancels exactly and the only residual target drift is
          // prograde rotation (~1.1e-3 rad/s × 25 m ≈ 0.03 m/s ≈ 7 cm over the
          // flight) — below any clearance threshold. The previous off-axis bias
          // (deleted here) flew the net ~4.9 m wide of the whale; it had been
          // tuned to satisfy a net-centre-range gate that could not see the
          // miss. A lead term here is unjustified and is the vector for that
          // regression — do not reintroduce one.
          // TRAP (plan §0): the pod accessor returns SCENE UNITS,
          // NetProjectile works in METRES — divide by M.
          const posMetres = { x: posScene.x / M, y: posScene.y / M, z: posScene.z / M };

          // 7. Release the pin the moment the catch resolves (either way):
          //    the reel/berth drives the whale via its own _armPinned pins,
          //    and _updateInstanceTransform checks _onboardingPinned FIRST —
          //    an unreleased tease pin would glue the whale at 25 m while
          //    the net package reels in empty (the LASSO_CONTACT hazard).
          //    BACKSTOP ONLY: DebrisField's own NET_CATCH_SUCCESS listener
          //    (DebrisField.js:633) already releases the pin on this event.
          //    An unconditional second _clearOnboardingPin re-syncs the orbit
          //    with _onboardingPinFwd already zeroed — trueAnomaly = the
          //    ship's exact phase — and TELEPORTS the whale onto the ship
          //    (measured 2026-08-05: spRelShip = 0 at REELING entry, so the
          //    reel seeded at the standoff and "completed" instantly, the
          //    REEL_IN beat never chained, and the berth camera geometry was
          //    measured against a catch that was never reeled). Gate on the
          //    pin still being held; _clearOnboardingPin is now idempotent
          //    too, but never rely on a double release being safe.
          if (typeof _scenarioPinReleaseOff === 'function') _scenarioPinReleaseOff();
          const release = () => {
            if (debrisField._onboardingPinIds?.has(whale.id)) {
              debrisField._clearOnboardingPin(whale.id);
            }
            debrisField._onboardingPinBasisOverrides?.delete(whale.id);   // un-freeze this whale's pin basis
            _scenarioPinReleaseOff = null;
          };
          const offOk  = eventBus.on(Events.NET_CATCH_SUCCESS, release);
          const offNo  = eventBus.on(Events.NET_CATCH_MISS, release);
          _scenarioPinReleaseOff = () => { offOk?.(); offNo?.(); };

          // ── Scenario fire-time forensics (net-look remediation Task 4) ──
          // The net flies a frozen world-space line, so WHICH point it aims at
          // decides whether the whale passes through the mouth. Report the lead
          // direction vs the direct bearing, and the resulting aimed world point
          // vs the whale's live rendered position, ship-relative metres.
          try {
            const ship = player.getPosition?.();
            const rel = (v) => (v && ship)
              ? [+((v.x - ship.x) / M).toFixed(2), +((v.y - ship.y) / M).toFixed(2), +((v.z - ship.z) / M).toFixed(2)]
              : null;
            const sp = whale?._scenePosition;
            const muzzRel = rel(posScene);
            const aimRel = rel(pinnedPos);
            const whaleRel = rel(sp);
            const leadPoint = { x: posScene.x + dir.x * 25 * M, y: posScene.y + dir.y * 25 * M, z: posScene.z + dir.z * 25 * M };
            const leadRel = rel(leadPoint);
            let whaleAimGap = null;
            if (sp && leadPoint) {
              whaleAimGap = +(Math.hypot(sp.x - leadPoint.x, sp.y - leadPoint.y, sp.z - leadPoint.z) / M).toFixed(2);
            }
            console.info(`[netScenario/fire] muzzle=${JSON.stringify(muzzRel)} aim(prograde+25m)=${JSON.stringify(aimRel)} leadDir=[${dir.x.toFixed(4)},${dir.y.toFixed(4)},${dir.z.toFixed(4)}] leadAim25m=${JSON.stringify(leadRel)} whaleLive=${JSON.stringify(whaleRel)} whaleAimGapM=${whaleAimGap}`);
          } catch (_e) { /* best-effort */ }

          // ── 7.5 Pin the catch's tumble (register item 13, 2026-08-06) ──
          // Plan: .kilo/plans/1786017377440-pin-scenario-catch-tumble.md.
          // MEASURED: the frozen attitude both live gates measure was FOUR
          // independent draws — spawn tumbleAxis, spawn tumbleAngle, spawn
          // tumbleRate and the frame-quantized time to capture. Nothing is
          // frozen before capture (DebrisField._advanceTumble only early-returns
          // on _capturedByArm/_armPinned, first set at REELING entry), so the
          // pixel gate's pinned CINCH still is grabbed off a live 10 °/s tumble
          // (the DEBRIS_MAX_VISUAL_TUMBLE_DEG_S clamp), and after capture
          // CaptureNet._applyCatchOrientation rewrites the attitude every frame
          // from the ship frame plus a spawn-rate-dependent carryover spin.
          // Cost, measured: whalePxFrac spanned [0.184, 0.361] and chordPierceM
          // 0.243–0.666 on IDENTICAL code (register items 5/13).
          //
          // The pin is three writes and no production change: rate 0 makes
          // _advanceTumble a no-op AND zeroes _tumbleCarryover (min(0, cap)), so
          // the attitude holds from staging through BERTHED. It is expressed in
          // the KIT frame — the frame the floor/chord maths and the CINCH camera
          // actually read (qB2K = qKit⁻¹ ⊗ tumble) — via the one shared
          // conversion in CaptureNetVisual, so the pinned number cannot drift if
          // the staging bearing ever moves. NOMINAL x@120° was chosen on a
          // 312-attitude sweep: chord 0.447 m (mid-family, 0.2 m under the live
          // 0.65 sanity bound) and the flattest neighbourhood measured (±10 mm
          // per ±5°); ADVERSE y@150° is the measured core plateau (0.666 ±1 mm),
          // kept selectable so pinning does not hide the worst case.
          // Trade recorded: the harness catch no longer spins down in the bag,
          // and one attitude is not orientation coverage — that lives in
          // tmp/g6-attitude-sweep.mjs and the ADVERSE pass.
          _scenarioTumblePin = null;
          try {
            const spec = _resolveScenarioTumble(opts && opts.tumble);
            if (spec) {
              const pin = worldTumbleForKitAttitude(dir, spec.kitAxis, spec.kitDeg * Math.PI / 180);
              if (pin) {
                if (whale.tumbleAxis && typeof whale.tumbleAxis.set === 'function') {
                  whale.tumbleAxis.set(pin.axis.x, pin.axis.y, pin.axis.z);
                } else {
                  whale.tumbleAxis = new THREE.Vector3(pin.axis.x, pin.axis.y, pin.axis.z);
                }
                whale.tumbleAngle = pin.angle;
                whale.tumbleRate = 0;            // holds the attitude AND kills the carryover
                whale._initialTumbleRate = 0;    // E1 despin doctrine stays coherent
                _scenarioTumblePin = {
                  preset: spec.name,
                  kitAxis: [spec.kitAxis.x, spec.kitAxis.y, spec.kitAxis.z],
                  kitDeg: spec.kitDeg,
                  worldAxis: { x: +pin.axis.x.toFixed(6), y: +pin.axis.y.toFixed(6), z: +pin.axis.z.toFixed(6) },
                  worldAngleDeg: +(pin.angle * 180 / Math.PI).toFixed(3),
                  // The rows the box spec will carry (v_box = R·v_kit ⇒ matrix of
                  // qB2K⁻¹): what the harness compares the LIVE spec against, so a
                  // convention slip or a lost pin fails loudly instead of silently
                  // returning both gates to a lottery.
                  boxInKitRows: boxRowsForKitAttitude(spec.kitAxis, spec.kitDeg * Math.PI / 180),
                };
              }
            }
          } catch (_e) { /* dev-only staging aid; never break the scenario */ }

          // ── 7.6 Arm the ship-attitude hold (register item 14, 2026-08-07) ──
          // Plan: .kilo/plans/1786068498588-pin-scenario-ship-attitude.md. The
          // latch listens for the SAME catch event the pin release above uses;
          // engagement is the latch + the per-frame overwrite in
          // __netShipHoldTick (call site there is load-bearing). Disengagement
          // at CATCH_PROCESSED hands back smoothly via _manualRotation (D3); a
          // miss (rolls are overridden, but hygiene) or a re-stage disarms.
          if (typeof _scenarioShipHoldOff === 'function') _scenarioShipHoldOff();
          _scenarioShipHoldOff = null;
          _disengageShipHold();   // smooth handback if a prior hold was engaged (D3); resets flags either way
          _SHIP_HOLD.everEngaged = false;   // a fresh staging starts a new hold lifecycle
          try {
            if (_scenarioTumblePin && _resolveScenarioShip(opts && opts.ship)) {
              _SHIP_HOLD.armed = true;
              // Filter by the scenario whale's id: a daughter-net catch/miss in a
              // busy dev page must not latch (or drop) the mother catch's hold.
              const engageHold = (e) => {
                if (e && e.debrisId !== undefined && e.debrisId !== whale.id) return;
                if (!_SHIP_HOLD.armed || _SHIP_HOLD.engaged) return;
                _SHIP_HOLD.quat = player.quaternion.clone();
                _SHIP_HOLD.engaged = true;
                _SHIP_HOLD.everEngaged = true;
              };
              const disarmHold = (e) => {
                if (e && e.debrisId !== undefined && e.debrisId !== whale.id) return;
                _SHIP_HOLD.armed = false; _SHIP_HOLD.engaged = false; _SHIP_HOLD.everEngaged = false; _SHIP_HOLD.quat = null;
                if (typeof _scenarioShipHoldOff === 'function') _scenarioShipHoldOff();
                _scenarioShipHoldOff = null;
              };
              const offHoldOk = eventBus.on(Events.NET_CATCH_SUCCESS, engageHold);
              const offHoldNo = eventBus.on(Events.NET_CATCH_MISS, disarmHold);
              const offHoldDone = eventBus.on(Events.CATCH_PROCESSED, (e) => {
                if (e && e.debrisId === whale.id) {
                  _disengageShipHold();   // keeps everEngaged — the run WAS held
                  if (typeof _scenarioShipHoldOff === 'function') _scenarioShipHoldOff();
                  _scenarioShipHoldOff = null;
                }
              });
              _scenarioShipHoldOff = () => { offHoldOk?.(); offHoldNo?.(); offHoldDone?.(); };
            }
          } catch (_e) { /* dev-only staging aid; never break the scenario */ }

          const net = captureNetSystem.fireMotherNet(0, posMetres, dir, whale);
          if (!net) {
            release();
            if (typeof _scenarioShipHoldOff === 'function') _scenarioShipHoldOff();
            _scenarioShipHoldOff = null;
            _SHIP_HOLD.armed = false; _SHIP_HOLD.engaged = false; _SHIP_HOLD.everEngaged = false; _SHIP_HOLD.quat = null;
            return { ok: false, reason: 'fire refused (magazine / cooldown / shot fouls collar cargo)' };
          }

          // 8. Override the rolls ON THE NET — never forceResolve(), which
          //    skips the flight/envelop/brake/cinch beats being photographed.
          net._clingRollOverride = 0;     // guaranteed catch
          net._fragRollOverride = 1.0;    // never fragments
          net._strainRollOverride = 1.0;  // never strain-slips
          _scenarioNet = net;

          // Whale-in-cone plan Task 2.5 — expose the invariant the harness unit
          // test asserts: the fired launchDirection must be within 0.5° of the
          // direct muzzle→pin bearing (a lead/bias would violate it). Fire-time
          // snapshot; never read back into gameplay.
          _scenarioAimInvariant = {
            launchDirection: { x: dir.x, y: dir.y, z: dir.z },
            muzzleScene: { x: posScene.x, y: posScene.y, z: posScene.z },
            pinnedPosScene: { x: pinnedPos.x, y: pinnedPos.y, z: pinnedPos.z },
          };

          const out = { ok: true, subject, whaleId: whale.id, type: whale.type,
            mass: whale.mass, sizeMeter: whale.sizeMeter, distanceM: 25, podIndex: 0 };
          console.info(`[netScenario] staged deterministic ${subject} capture: ${JSON.stringify(out)}`);
          return out;
        } catch (e) {
          console.warn('[netScenario] failed:', e);
          return { ok: false, reason: String((e && e.message) || e) };
        }
      };

      // Balloon→fabric (F5): the drawn rim at the whale's depth + the pierce
      // metric, computed ONLY through the NetMeshKit exports (with the identical
      // open-cone clamp the mesh uses — Task 7) so probe/recorder and mesh can
      // never drift. With a contentsBox on the handle the floor varies per spoke
      // angle, so the honest metric is per-angle: drawnRim = MIN over angles;
      // pierceM = MAX over angles of (hull surface distance − drawn rim), so a
      // positive pierceM still means the film cuts into the catch (the gate's
      // sign convention is unchanged). Sphere fallback keeps the original
      // bounding-sphere-vs-rim semantics. `natural` is drawnRimRadiusAtDepth at
      // the whale's depth (scene units); renderRadiusM is the bounding-sphere
      // render radius in METRES.
      // Returns the SHARED scratch `_netDp` (allocation-free per frame — the
      // recorder calls this every frame while enabled): callers read fields
      // immediately and never retain the reference.
      const _netDp = { drawnRimM: null, pierceM: null, fillFrac: null, boxFloorM: null, chordPierceM: null };
      const _netDpBox = [null, null, null];
      function _netDrawnRimPierce(kh, lpZ, natural, renderRadiusM, M) {
        // The open-cone clamp the mesh applies at the whale's depth: the cone
        // radius at the ring's DRAPED z — here the ring AT this depth, i.e. the
        // static cone radius mouthRadius·(a/H). Identical rule, identical maths
        // (probe/mesh never drift); mouthRadius at/past the mouth plane.
        const openCone = kh.mouthRadius * Math.min(1, Math.max(0, -lpZ / kh.coneHeight));
        const cB = kh._contentsBox ?? null;
        if (kh._drape > 0 && contentsBoxValid(cB)) {
          let drawnMin = Infinity, violMax = null, surfMax = 0;
          for (let s = 0; s < kh.radialSpokes; s++) {
            const a = (2 * Math.PI * s) / kh.radialSpokes;
            const ca = Math.cos(a), sa = Math.sin(a);
            const floorS = contentsFloorClamped(lpZ, ca, sa, openCone, kh._contentsZ ?? 0, kh._contentsR ?? 0, cB, Constants.CAPTURE_NET.NET_CEREMONY.CONTENTS_FLOOR_MARGIN, -kh.coneHeight);
            const drawnS = Math.max(natural, floorS);
            const surfS = contentsFloorRadiusBox(lpZ, ca, sa, cB, 1, -kh.coneHeight);   // margin 1 = the hull itself (incl. bicone)
            if (drawnS < drawnMin) drawnMin = drawnS;
            if (surfS > 0) {
              if (surfS > surfMax) surfMax = surfS;
              const viol = surfS - drawnS;
              if (violMax === null || viol > violMax) violMax = viol;
            }
          }
          _netDp.drawnRimM = +(drawnMin / M).toFixed(3);
          _netDp.pierceM = violMax === null ? null : +(violMax / M).toFixed(3);
          _netDp.fillFrac = (drawnMin > 0 && surfMax > 0) ? +(surfMax / drawnMin).toFixed(3) : null;
          _netDpBox[0] = +(cB.hx / M).toFixed(3);
          _netDpBox[1] = +(cB.hy / M).toFixed(3);
          _netDpBox[2] = +(cB.hz / M).toFixed(3);
          _netDp.boxFloorM = _netDpBox;
          // Follow-up 4: the DRAWN polyline, not just the envelope — worst
          // chord penetration into the UNMARGINED box over every lattice edge
          // (positive = the film touches the hull; same sign as pierceM). The
          // kit export reads the handle's LIVE membranePositions, so the
          // bicone tents are included by construction and probe ≡ mesh. ~17k
          // point evals; probe/recorder are dev-only, never a production cost.
          const chordWorst = chordBoxPenetration(kh.membranePositions, kh.rings, kh.radialSpokes, cB);
          _netDp.chordPierceM = chordWorst === null ? null : +(chordWorst / M).toFixed(3);
          return _netDp;
        }
        // F4 legacy sphere fallback — unreachable from the production drivers
        // (they always supply a valid box with contentsRadius); kept for parity
        // with the kit's sphere branch and the Task-5/7 test contract.
        const floor = (kh._drape > 0)
          ? Math.min(contentsFloorRadius(lpZ, kh._contentsZ ?? 0, kh._contentsR ?? 0), openCone)
          : 0;
        const drawn = Math.max(natural, floor) / M;
        _netDp.drawnRimM = +drawn.toFixed(3);
        _netDp.pierceM = +(renderRadiusM - drawn).toFixed(3);
        _netDp.fillFrac = drawn > 0 ? +(renderRadiusM / drawn).toFixed(3) : null;
        _netDp.boxFloorM = null;
        _netDp.chordPierceM = null;   // box-era metric; no chord hull on the sphere path
        return _netDp;
      }

      // ── Scenario probe (harness diagnostics) ──
      //   window.__netScenarioProbe()
      //     → live state of the staged scenario: the net's FSM state and
      //       flight progress, and the whale's ACTUAL distance from the pod
      //       muzzle. This is how you tell a real contact from a flight
      //       time-out: if whaleDistM is not ~25, the prograde pin never
      //       took, and the net is flying at empty space.
      window.__netScenarioProbe = () => {
        try {
          const M = 0.00001;
          const net = _scenarioNet;
          const whale = net?.targetDebris;
          const pod = (player && typeof player.getNetPodPosition === 'function')
            ? player.getNetPodPosition(0) : null;
          const sp = whale?._scenePosition;
          const whaleDistM = (pod && sp)
            ? Math.hypot(sp.x - pod.x, sp.y - pod.y, sp.z - pod.z) / M : null;
          return {
            netState:      net?.state ?? null,
            catchResult:   net?.catchResult ?? null,
            // Small-catch plan W1/W3: the collar digestion's live phase — the
            // filmstrip needs to know when the chop runs (D2's bare-shrink
            // window) and when the body is consumed (`_digestedOut`, set the
            // tick the net is spliced), so the capture loop can hold through
            // the whole tail instead of stopping at COLLARED entry.
            digestPhaseT:  net?._digestPhaseT != null ? +net._digestPhaseT.toFixed(2) : null,
            breakdownActive: !!whale?._breakdownActive,
            digested:      net?._digestedOut === true,
            // Live perf tier. Written in exactly two places, both inside
            // SceneManager (:95 initial via _detectInitialTier, :562 inside
            // applyTier), so a plain read here is race-free. Reported on every
            // probe call so a capture run cannot quietly drift back into
            // measuring the LOW-tier degraded path while claiming otherwise.
            tier:          sceneManager?.currentTier ?? null,
            flightTime:    net ? +net.flightTime.toFixed(2) : null,
            travelledM:    net ? +net.distanceTraveled.toFixed(1) : null,
            whaleDistM:    whaleDistM != null ? +whaleDistM.toFixed(1) : null,
            pinned:        !!whale?._onboardingPinned,
            pinFwdM:       whale ? +((whale._onboardingPinFwd || 0) / M).toFixed(1) : null,
            motherFwdSet:  !!debrisField?._motherFwd,
            motherRightSet: !!debrisField?._motherRight,
            pinIds:        debrisField?._onboardingPinIds?.size ?? null,
            clingOverride: net?._clingRollOverride ?? null,
            // Decisive: the net's OWN distance to the whale. If this stays
            // ~25 m while travelledM climbs, the net is flying off-axis.
            netToWhaleM: (() => {
              if (!net?.position || !sp) return null;
              return +(Math.hypot(sp.x / M - net.position.x, sp.y / M - net.position.y,
                                  sp.z / M - net.position.z)).toFixed(1);
            })(),
            // Cone-containment (net-fabric-look phase 2): the whale in the
            // ceremony bag's LOCAL frame (apex z=0, mouth z=-coneH). The whale
            // is visually inside the bag ⇔ zM ∈ [-coneH, 0] and rM (lateral
            // off-axis) ≤ mouthRadius × t. net-centre distance (netToWhaleM)
            // cannot see an off-axis whale; this can. The harness tracks the
            // min rM and whether insideCone was ever true through CONTACT→CINCH.
            whaleLocal: (() => {
              try {
                const vis0 = captureNetVisual?._activeVisuals?.get('pod_0')
                  ?? [...(captureNetVisual?._activeVisuals?.values() ?? [])].find(v => v?.useCeremony);
                const kh = vis0?.kitHandle;
                if (!kh || !sp) return null;
                kh.group.updateMatrixWorld(true);
                const lp = new THREE.Vector3(sp.x, sp.y, sp.z);
                kh.group.worldToLocal(lp);
                const zM = lp.z / M, rM = Math.hypot(lp.x, lp.y) / M;
                const mouthRM = kh.mouthRadius / M, coneHM = kh.coneHeight / M;
                // Containment is computed by the SHARED predicate (whale-in-cone
                // Task 1) so probe, harness and tests cannot drift.
                const coneR = coneRadiusAtDepth(mouthRM, coneHM, -zM);
                const clearance = coneR - rM;
                // Review §Minor: the deficit must use the RENDERED radius —
                // sizeMeter/2 is not the rendered size (W5), so the old
                // expression under-read by ~0.5 m on the ceremony whale.
                DebrisWireframe.getGeometry(whale.type, whale.id);
                const brL = DebrisWireframe.getBoundingRadius(whale.type, whale.id) || 1;
                const whaleHalfM = DebrisField.effectiveRenderScale(whale) * brL / M;
                return {
                  zM: +zM.toFixed(2), rM: +rM.toFixed(2),
                  aM: +(-zM).toFixed(2),
                  t: +(-zM / coneHM).toFixed(2),
                  coneRadiusAtZM: +coneR.toFixed(2),
                  insideCone: isInsideCone(zM, rM, mouthRM, coneHM),
                  clearanceM: +clearance.toFixed(2),
                  silhouetteDeficitM: +(rM + whaleHalfM - coneR).toFixed(2),
                };
              } catch (_e) { return null; }
            })(),
            // ── Whale-in-cone phase 3 (Task 2.1): scale-aware witness block ──
            // sizeMeter is NOT the rendered size — the renderer scales the
            // instance by sceneSize (raised to _catchRenderMin while _armPinned,
            // W5) and the rendered extent is renderScale × boundingRadius. This
            // block measures the RENDERED whale against the DRAWN bag rim, so a
            // sub-metre crumb can never again satisfy a 7 m gate. All metre
            // fields are true metres; renderScale/sceneSize are scene units.
            whaleScale: (() => {
              try {
                if (!whale) return null;
                // Populate the br cache FIRST — getBoundingRadius returns 1 for
                // an uncached key (W2 trap), which would mis-size everything
                // downstream by up to 31%.
                DebrisWireframe.getGeometry(whale.type, whale.id);
                const br = DebrisWireframe.getBoundingRadius(whale.type, whale.id) || 1;
                // Read the effective scale through the Task-3 SSOT helper so
                // probe and renderer cannot drift.
                const renderScale = DebrisField.effectiveRenderScale(whale);
                const renderRadiusM = renderScale * br / M;
                const sm = whale.sizeMeter ?? null;
                const ss = whale.sceneSize ?? null;
                const consistent = (typeof sm === 'number' && typeof ss === 'number')
                  ? Math.abs(ss - sm * 1e-5) < 1e-12 : null;
                // Drawn rim at the whale's depth, via the Task-1 NetMeshKit
                // exports — including the contents floor the Task-5 driver
                // stores on the handle (absent pre-Task-5 ⇒ floor 0 ⇒ the
                // natural drape/cinch radius, i.e. exactly what the mesh draws).
                let drapeFrac = null, cinchFrac = null, drawnRimM = null, pierceM = null, fillFrac = null, boxFloorM = null, chordPierceM = null;
                let membraneOpacity = null;
                const vis0 = captureNetVisual?._activeVisuals?.get('pod_0')
                  ?? [...(captureNetVisual?._activeVisuals?.values() ?? [])].find(v => v?.useCeremony);
                const kh = vis0?.kitHandle;
                if (kh && sp) {
                  kh.group.updateMatrixWorld(true);
                  const lp = new THREE.Vector3(sp.x, sp.y, sp.z);
                  kh.group.worldToLocal(lp);
                  drapeFrac = kh._drape ?? null;
                  cinchFrac = kh._cinchFrac ?? null;
                  // Small-catch plan W2a: the film's LIVE opacity — the welded
                  // fade is the lever under test, so the harness reads the
                  // material the mesh actually renders with, not a re-derived
                  // constant.
                  membraneOpacity = kh.membraneMat ? +kh.membraneMat.opacity.toFixed(4) : null;
                  const natural = drawnRimRadiusAtDepth(-lp.z, kh.mouthRadius, kh.coneHeight,
                    kh._drape ?? 0, kh._cinchFrac ?? 0,
                    Constants.CAPTURE_NET.NET_CEREMONY.DRAWSTRING_RADIUS_FRAC_CLOSED);
                  // F5: the shared helper applies the IDENTICAL floor + open-cone
                  // clamp the mesh uses (Task 7's rule, now box-aware) — probe
                  // and mesh must never drift (R1's apex balloon passed the gate
                  // that way).
                  const dp = _netDrawnRimPierce(kh, lp.z, natural, renderRadiusM, M);
                  drawnRimM = dp.drawnRimM;
                  pierceM = dp.pierceM;
                  fillFrac = dp.fillFrac;
                  boxFloorM = dp.boxFloorM;
                  chordPierceM = dp.chordPierceM;
                }
                return {
                  type: whale.type ?? null,
                  boundingRadius: +br.toFixed(4),
                  sizeMeter: sm, sceneSize: ss,
                  sceneSizeConsistent: consistent,
                  renderScale,
                  renderRadiusM: +renderRadiusM.toFixed(3),
                  drapeFrac, cinchFrac,
                  membraneOpacity,
                  drawnRimAtWhaleM: drawnRimM, pierceM, fillFrac,
                  boxFloorM,
                  chordPierceM,
                };
              } catch (_e) { return null; }
            })(),
            // Pin-branch forensics: is the whale the object the field
            // actually renders, and where would the pin put it?
            hasInstance:   !!debrisField?._instanceLookup?.has(whale?.id),
            sameAsMapRef:  debrisField?.debrisMap?.get(whale?.id) === whale,
            sameAsListRef: debrisField?.debrisList?.find(d => d && d.id === whale?.id) === whale,
            alive:         whale?.alive,
            // Validation: must read 1 after every scenario run (the ceremony
            // releases the time scale on exit; a stuck value would dilate the
            // whole world).
            ceremonyTimeScale: (typeof CeremonyTimeScale !== 'undefined' && CeremonyTimeScale.get)
              ? +CeremonyTimeScale.get().toFixed(3) : null,
            // P0a: sun state for the determinism contract. The capture scripts
            // pin _sunPhase0/_sunYaw0/elapsedTime before staging (the defaults
            // are seeded from the real wall clock — SunLight._seedSkyFromClock
            // — so unpinned runs are lit by luck of their capture date and S0
            // vs S1 A/B is meaningless). Logged so a silent regression is
            // visible in the probe output.
            sun: (() => {
              if (!sunLight) return null;
              const d = sunLight.sunDirection;
              return {
                phase0: +((sunLight._sunPhase0 ?? NaN).toFixed?.(4) ?? null),
                yaw0:   +((sunLight._sunYaw0 ?? NaN).toFixed?.(4) ?? null),
                elapsedS: +((sunLight.elapsedTime ?? NaN).toFixed?.(2) ?? null),
                dir: d ? [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)] : null,
              };
            })(),
            // Reel-internals forensics (P1 re-diagnosis): the post-catch pin
            // writes net.position AND whale._scenePosition to the same point
            // ~1.2e6 m off-ship. Name the garbage term: _remainingM (m),
            // _lateral (scene units), _fwdLagged (should be unit), and the
            // absolute magnitudes that expose a frame mix-up.
            reelRemainingM:  net?._remainingM != null ? +net._remainingM.toFixed(2) : null,
            reelLateralMag:  net?._lateral ? +net._lateral.length().toExponential(2) : null,
            reelFwdLaggedMag: net?._fwdLagged ? +net._fwdLagged.length().toFixed(4) : null,
            whaleAbsMagM:    sp ? +(Math.hypot(sp.x, sp.y, sp.z) / M).toFixed(0) : null,
            shipAbsMagM:     (() => { const pp = player?.getPosition?.(); return pp ? +(Math.hypot(pp.x, pp.y, pp.z) / M).toFixed(0) : null; })(),
            floatOriginMagM: (() => { const fo = debrisField?._floatingOrigin; return fo ? +(Math.hypot(fo.x, fo.y, fo.z) / M).toFixed(0) : null; })(),
            // Attitude-transient forensics (P1 re-diagnosis #3): the capture
            // tug's angular kick (CaptureNet.js:1786) injects _recoilPitchVel
            // with I = mShip×0.25 — a 0.5 m radius of gyration for a ~5 m
            // hull, ~100× under the real MOI. Watch the actual rad/s at catch.
            recoilPitchVel:   player?._recoilPitchVel   != null ? +player._recoilPitchVel.toFixed(4)   : null,
            recoilPitchAngle: player?._recoilPitchAngle != null ? +player._recoilPitchAngle.toFixed(4) : null,
            recoilYawVel:     player?._recoilYawVel     != null ? +player._recoilYawVel.toFixed(4)     : null,
            recoilYawAngle:   player?._recoilYawAngle   != null ? +player._recoilYawAngle.toFixed(4)   : null,
            whaleSma:      whale?.orbit ? +whale.orbit.semiMajorAxis.toFixed(4) : null,
            playerSma:     +((player?.orbit?.semiMajorAxis) ?? 0).toFixed(4),
            whaleInc:      whale?.orbit ? +whale.orbit.inclination.toFixed(4) : null,
            playerInc:     +((player?.orbit?.inclination) ?? 0).toFixed(4),
            expectedPinM:  (() => {
              const f = debrisField?._motherFwd, pp = player?.getPosition?.();
              if (!f || !pp || !pod) return null;
              const fwd = (whale?._onboardingPinFwd || 0);
              const ex = pp.x + f.x * fwd, ey = pp.y + f.y * fwd, ez = pp.z + f.z * fwd;
              return +(Math.hypot(ex - pod.x, ey - pod.y, ez - pod.z) / M).toFixed(1);
            })(),
            sceneVsExpectedM: (() => {
              const f = debrisField?._motherFwd, pp = player?.getPosition?.();
              if (!f || !pp || !sp) return null;
              const fwd = (whale?._onboardingPinFwd || 0);
              const ex = pp.x + f.x * fwd, ey = pp.y + f.y * fwd, ez = pp.z + f.z * fwd;
              return +(Math.hypot(sp.x - ex, sp.y - ey, sp.z - ez) / M).toFixed(1);
            })(),
            // ── Net-visual density forensics (net-look remediation, Task 0) ──
            // Per-visual web density + camera distance, keyed by visual key
            // ('pod_0', 'arm_1', …). Guards the V9 regression that this plan
            // fixed: the shipped web had been stuck at 12×4 (60 membrane verts)
            // instead of the 20×6 build density (140) because the density LOD
            // (since DELETED) forced LOW-tier nets to the far density. There is
            // no runtime LOD any more — density is fixed at build density — so
            // this block reports the raw kit density, not an LOD level. memVerts
            // is DERIVED from the membrane buffer (NetMeshKit sizes it
            // (rings+1) × radialSpokes × 3), not invented.
            nets: (() => {
              try {
                const cam = sceneManager?.camera;
                const shipP = player?.getPosition?.();
                const relM = (v) => (v && shipP)
                  ? [+((v.x - shipP.x) / M).toFixed(1), +((v.y - shipP.y) / M).toFixed(1), +((v.z - shipP.z) / M).toFixed(1)]
                  : null;
                const visuals = {};
                for (const [vKey, vis] of (captureNetVisual?._activeVisuals ?? [])) {
                  const kh = vis.kitHandle;
                  const gp = vis.group?.position;
                  visuals[vKey] = {
                    state: vis.detached ? 'detached'
                      : (captureNetVisual._getNet?.(vis.armIndex, vis.podIndex)?.state ?? null),
                    radialSpokes: kh?.radialSpokes ?? null,
                    rings: kh?.rings ?? null,
                    memVerts: kh?.membranePositions ? kh.membranePositions.length / 3 : null,
                    // Same expression the V9 LOD block used: vis.group is added
                    // directly to the scene, so .position IS world space.
                    camDM: (cam && gp) ? +(gp.distanceTo(cam.position) / M).toFixed(1) : null,
                    groupRelShipM: relM(gp),
                  };
                }
                return {
                  count: captureNetVisual?._activeVisuals?.size ?? 0,
                  cameraRelShipM: relM(cam?.position),
                  visuals,
                };
              } catch { return null; }
            })(),
            // ── P1.1 ceremony-camera forensics (harness-only) ──
            // The captured/reel/secured beats land inside SECURED_SETTLE, whose
            // mother-path pose is anchored 5 m BEHIND the pod muzzle (the shared
            // ARM_PILOT_START branch). Hypothesis: that puts the camera in/behind
            // the hull with the ship occluding the whale → black frames. Report
            // the geometry so the hypothesis is confirmed/refuted BEFORE the fix:
            //   camInsideHullConst — camera within the 12 m contact radius
            //   camBehindPodM     — signed distance along pod→whale (neg = behind)
            //   whaleOccluded     — cam→whale segment passes inside the hull radius
            ceremony: (() => {
              try {
                const cs = cameraSystem, c = cs?._netCeremony, cam = cs?.camera;
                if (!c || !cam || !player) return null;
                const beat = c.beats?.[c.beatIndex];
                const ship = player.getPosition?.();
                if (!ship) return { active: c.active, beatKey: beat?.key ?? null };
                const dxS = cam.position.x - ship.x, dyS = cam.position.y - ship.y, dzS = cam.position.z - ship.z;
                const camToShipM = Math.hypot(dxS, dyS, dzS) / M;
                const hullR = Constants?.COLLISION_MODEL?.HULL_RADIUS_M ?? 12;
                let boundR = null;
                try {
                  const sph = new THREE.Box3().setFromObject(player).getBoundingSphere(new THREE.Sphere());
                  if (isFinite(sph.radius) && sph.radius > 0) boundR = +(sph.radius / M).toFixed(1);
                } catch { /* measured bound is best-effort */ }
                let camBehindPodM = null, camToWhaleM = null, hullHitM = null, whaleOccluded = null;
                if (pod && sp) {
                  const pwX = sp.x - pod.x, pwY = sp.y - pod.y, pwZ = sp.z - pod.z;
                  const pwLen = Math.hypot(pwX, pwY, pwZ);
                  if (pwLen > 0) {
                    camBehindPodM = +(((cam.position.x - pod.x) * pwX + (cam.position.y - pod.y) * pwY
                                     + (cam.position.z - pod.z) * pwZ) / pwLen / M).toFixed(2);
                  }
                  camToWhaleM = +(Math.hypot(sp.x - cam.position.x, sp.y - cam.position.y, sp.z - cam.position.z) / M).toFixed(1);
                  // Decisive occlusion test: raycast camera→whale against the
                  // actual ship meshes. If a hull mesh is hit before the whale,
                  // the ship is genuinely between camera and catch (P1 black
                  // frames). The naive "segment passes near ship centre" proxy
                  // is useless here — near-hull cameras always trip it.
                  try {
                    const ray = new THREE.Raycaster(
                      cam.position.clone(),
                      new THREE.Vector3(sp.x - cam.position.x, sp.y - cam.position.y, sp.z - cam.position.z).normalize());
                    ray.params.Line.threshold = 0; ray.params.Points.threshold = 0;
                    const hits = ray.intersectObject(player, true).filter(h => h.object.isMesh);
                    if (hits.length) {
                      hullHitM = +(hits[0].distance / M).toFixed(2);
                      whaleOccluded = hullHitM < camToWhaleM - 0.5;
                    } else {
                      hullHitM = null; whaleOccluded = false;
                    }
                  } catch { /* raycast best-effort */ }
                }
                return {
                  active: c.active, beatKey: beat?.key ?? null, beatIndex: c.beatIndex,
                  beatTimer: +c.beatTimer.toFixed(2),
                  // P2.4: whether the trailing REEL_IN beat chained after the
                  // capture beats (CameraSystem._tryChainReelBeat). Reported so
                  // the chaining stays a measured fact, not an assumption.
                  reelBeatChained: c._reelBeatChained === true,
                  // P0b: the live beat list + the first-ever 7-beat contract.
                  // A reused browser profile (or a second net) gets the 5-beat
                  // highlights cut instead — different beats, different
                  // durations, uncomparable numbers. The capture script aborts
                  // loudly when this reads false.
                  beatKeys: (c.beats || []).map(b => b.key),
                  beatListOk: (() => {
                    const keys = (c.beats || []).map(b => b.key);
                    if (!keys.length) return null;
                    const WANT = ['POD_MUZZLE_PREFIRE', 'MUZZLE_EXIT_SPINUP', 'GLAMOUR_SHOT',
                                  'APPROACH_DOLLY', 'BRAKE_ENVELOP', 'CINCH', 'SECURED_SETTLE'];
                    return keys.length >= 7 && keys.slice(0, 7).every((k, i) => k === WANT[i]);
                  })(),
                  camToShipM: +camToShipM.toFixed(2), hullRadiusM: hullR, shipBoundRadiusM: boundR,
                  camInsideHullConst: camToShipM < hullR,
                  camInsideBound: boundR != null ? camToShipM < boundR : null,
                  camBehindPodM, camToWhaleM, hullHitM, whaleOccluded,
                  // Raw anchor forensics (ship-relative metres): whichever of
                  // these jumps to 1e5+ is the corrupted ceremony input. The
                  // post-catch SECURED_SETTLE window flings the camera across
                  // hundreds of km — name the field, don't guess.
                  _rel: (() => {
                    const rel = (v) => v ? [+((v.x - ship.x) / M).toFixed(1), +((v.y - ship.y) / M).toFixed(1), +((v.z - ship.z) / M).toFixed(1)] : null;
                    return {
                      cam: rel(cam.position),
                      pod: rel(pod),
                      armPos: rel(c._scratchLauncherPos),
                      netPos: rel(c._scratchNetPos),
                      debrisPos: rel(sp),
                    };
                  })(),
                };
              } catch { return null; }
            })(),
          };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      };

      // ── Lasso capture probe (2026-08-26 round 2 — dev-only, ?shot=1) ──
      // The lasso path has no __netScenario staging: real-play captures need a
      // stateless getter for the live cast + cut + adopted-bag geometry, all
      // ship-relative metres, so a film take can NAME the broken anchor
      // instead of eyeballing frames. Same devShotGate surface as the __net*
      // family above.
      window.__scbLassoProbe = () => {
        try {
          const M = 0.00001;
          const ship = player?.getPosition?.();
          if (!ship) return null;
          const rel = (v) => v
            ? [+((v.x - ship.x) / M).toFixed(1), +((v.y - ship.y) / M).toFixed(1), +((v.z - ship.z) / M).toFixed(1)]
            : null;
          const ls = lassoSystem;
          const lc = cameraSystem?._lassoCut;
          const cam = sceneManager?.camera;
          const piece = ls?.target || lc?.debris || null;
          const sp = piece?._scenePosition || null;
          const kh = ls?._netKit;
          const vis0 = captureNetVisual?._activeVisuals?.get('pod_0');
          return {
            lasso: ls ? {
              active: ls.active, reeling: ls._reelingIn,
              reelP: +(ls._reelProgress ?? 0).toFixed(3),
              proj: rel(ls.projectilePos),
              netVisible: ls._netGroup?.visible ?? null,
              seatD0M: +((ls._wrapSeatD0 ?? 0) / M).toFixed(2),
              webFade: !!ls._webFade,
              dbgContact: ls._dbgContact ?? null,
              dbgReel: ls._dbgReel ?? null,
            } : null,
            piece: sp ? { pos: rel(sp), pinned: piece._armPinned === true, alive: piece.alive !== false } : null,
            pieceToProjM: (sp && ls?.projectilePos)
              ? +(Math.hypot(sp.x - ls.projectilePos.x, sp.y - ls.projectilePos.y, sp.z - ls.projectilePos.z) / M).toFixed(2)
              : null,
            kit: kh ? {
              drape: +(kh._drape ?? 0).toFixed(2), cinch: +(kh._cinchFrac ?? 0).toFixed(2),
              contentsZM: +((kh._contentsZ ?? 0) / M).toFixed(2),
              contentsRM: +((kh._contentsR ?? 0) / M).toFixed(2),
              jiggle: +(kh._jiggleAmp ?? 0).toExponential(1),
              memOp: kh.membraneMat ? +kh.membraneMat.opacity.toFixed(3) : null,
            } : null,
            cut: lc ? {
              active: lc.active, t: +(lc.t ?? 0).toFixed(2),
              settleT: lc.settleT != null ? +lc.settleT.toFixed(2) : null,
              view: cameraSystem?.currentView ?? null,
            } : null,
            cam: cam ? {
              pos: rel(cam.position),
              toShipM: +(Math.hypot(cam.position.x - ship.x, cam.position.y - ship.y, cam.position.z - ship.z) / M).toFixed(1),
              toPieceM: sp ? +(Math.hypot(cam.position.x - sp.x, cam.position.y - sp.y, cam.position.z - sp.z) / M).toFixed(1) : null,
            } : null,
            adoptedBag: vis0 ? {
              detached: !!vis0.detached,
              groupPos: rel(vis0.group?.position),
              cinch: vis0.kitHandle ? +(vis0.kitHandle._cinchFrac ?? 0).toFixed(2) : null,
              contentsZM: vis0.kitHandle ? +((vis0.kitHandle._contentsZ ?? 0) / M).toFixed(2) : null,
              threadOp: vis0.kitHandle?.coneMesh?.material ? +vis0.kitHandle.coneMesh.material.opacity.toFixed(3) : null,
            } : null,
            netState: captureNetSystem?.getActiveNetForPod?.(0)?.state ?? null,
          };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      };

      // ── Lasso per-frame flight recorder (2026-08-26 round 3 — dev-only) ──
      // The 1 Hz LP lines named the ~7.7 km ghost but not its WRITER: one
      // clamped SwiftShader frame of apparent orbital travel IS ~7700 m, so a
      // one-frame-stale anchor and a genuine teleport look identical at
      // capture cadence. This ring buffer samples END-OF-FRAME truth every
      // rAF tick while armed (same call-site doctrine as __netProbeTick):
      // ship, camera, cut/view state, and the piece's anchors (rendered
      // _scenePosition, the lasso arm pin) — ship-relative metres, so the
      // frame the garbage lands names its source FIELD directly. Zero cost
      // beyond one boolean check unless __scbLassoRec(true).
      const _LREC = { on: false, buf: [], cap: 4000, n: 0 };
      window.__scbLassoRec = (on) => { _LREC.on = !!on; return _LREC.on; };
      window.__scbLassoRecDump = () => ({ n: _LREC.n, samples: _LREC.buf });
      window.__scbLassoRecClear = () => { _LREC.buf.length = 0; _LREC.n = 0; return true; };
      window.__scbLassoRecTick = (nowMs) => {
        if (!_LREC.on) return;
        try {
          const M = 0.00001;
          const ship = player?.getPosition?.();
          if (!ship) return;
          const rel = (v) => v
            ? [+((v.x - ship.x) / M).toFixed(1), +((v.y - ship.y) / M).toFixed(1), +((v.z - ship.z) / M).toFixed(1)]
            : null;
          const ls = lassoSystem;
          const lc = cameraSystem?._lassoCut;
          const cam = sceneManager?.camera;
          const piece = (ls && ls.target) || (lc && lc.debris) || null;
          const s = {
            i: _LREC.n, t: +(nowMs / 1000).toFixed(3),
            ship: [+ship.x.toFixed(5), +ship.y.toFixed(5), +ship.z.toFixed(5)],
            cam: cam ? rel(cam.position) : null,
            view: cameraSystem?.currentView ?? null,
            trans: cameraSystem && cameraSystem._transitioning
              ? +cameraSystem._transitionProgress.toFixed(2) : null,
            cut: lc && lc.active ? +(lc.t ?? 0).toFixed(2) : null,
            la: ls ? (ls.active ? (ls._reelingIn ? 'reel' : 'fly') : null) : null,
            reelP: ls && ls.active ? +(ls._reelProgress ?? 0).toFixed(3) : null,
            proj: ls && ls.active ? rel(ls.projectilePos) : null,
            sp: piece && piece._scenePosition ? rel(piece._scenePosition) : null,
            pin: piece && piece._armPinPos ? rel(piece._armPinPos) : null,
            ob: piece ? (piece._onboardingPinned === true) : null,
            ap: piece ? (piece._armPinned === true) : null,
          };
          _LREC.buf[_LREC.n % _LREC.cap] = s;
          _LREC.n++;
        } catch (_e) { /* the recorder must never break the loop */ }
      };

      // ── Per-frame probe recorder (whale-in-cone plan, Task 1.4) ──
      // `__netScenarioProbe()` is a stateless getter and the harness polls it at
      // 1 Hz — too coarse to see the brake instant, which is a single frame
      // inside a slow-motion beat. This recorder captures a SLIM sample every
      // frame while enabled. It deliberately does NOT call __netScenarioProbe()
      // per frame (~40 fields, includes a raycast) — it reuses the few fields
      // that actually matter. Ring buffer, capped; off by default; zero cost
      // beyond one boolean check when disabled.
      //   __netProbeRecord(true|false) → enable/disable capture
      //   __netProbeDump()             → { samples, dropped, startedAtMs, hz }
      //   __netProbeClear()            → empty the buffer
      const _PROBE_REC = {
        on: false,
        buf: [],
        dropped: 0,
        cap: 20000,          // ~5.5 min at 60 fps
        startedAtMs: null,
        lastTsMs: null,
      };
      window.__netProbeRecord = (on) => { _PROBE_REC.on = !!on; if (on) _PROBE_REC.startedAtMs ??= performance.now(); return _PROBE_REC.on; };
      window.__netProbeClear = () => { _PROBE_REC.buf.length = 0; _PROBE_REC.dropped = 0; _PROBE_REC.startedAtMs = null; _PROBE_REC.lastTsMs = null; return true; };
      window.__netProbeDump = () => {
        const n = _PROBE_REC.buf.length;
        const spanMs = (_PROBE_REC.lastTsMs != null && _PROBE_REC.startedAtMs != null)
          ? Math.max(0, _PROBE_REC.lastTsMs - _PROBE_REC.startedAtMs) : 0;
        return {
          samples: _PROBE_REC.buf,
          dropped: _PROBE_REC.dropped,
          startedAtMs: _PROBE_REC.startedAtMs,
          hz: spanMs > 0 ? +(n / (spanMs / 1000)).toFixed(1) : null,
        };
      };
      // Called once per frame from gameLoop (see end of gameLoop). Builds the
      // slim sample inline; any failure leaves the buffer untouched.
      window.__netProbeTick = (nowMs) => {
        if (!_PROBE_REC.on) return;
        try {
          const M = 0.00001;
          const net = _scenarioNet;
          const whale = net?.targetDebris;
          const sp = whale?._scenePosition;
          if (!net || !sp) return;
          const cs = cameraSystem, c = cs?._netCeremony;
          const beat = c?.beats?.[c.beatIndex];
          // Cone-local whale via the SHARED predicates (same frame as the probe).
          let aM = null, rM = null, zM = null, coneR = null, inside = null;
          // Whale-in-cone phase 3 (Task 2.1): scale-aware fields on the SLIM
          // sample. br via the cached accessor (getGeometry first — uncached
          // returns 1); render scale via the Task-3 SSOT helper.
          let whaleType = null, whaleRenderRadiusM = null, sceneSizeConsistent = null;
          let drapeFrac = null, cinchFrac = null, drawnRimAtWhaleM = null, pierceM = null, chordPierceM = null;
          const vis0 = captureNetVisual?._activeVisuals?.get('pod_0')
            ?? [...(captureNetVisual?._activeVisuals?.values() ?? [])].find(v => v?.useCeremony);
          const kh = vis0?.kitHandle;
          if (kh) {
            kh.group.updateMatrixWorld(true);
            const lp = new THREE.Vector3(sp.x, sp.y, sp.z);
            kh.group.worldToLocal(lp);
            zM = +(lp.z / M).toFixed(2);
            rM = +(Math.hypot(lp.x, lp.y) / M).toFixed(2);
            aM = +(-lp.z / M).toFixed(2);
            const mouthRM = kh.mouthRadius / M, coneHM = kh.coneHeight / M;
            coneR = +coneRadiusAtDepth(mouthRM, coneHM, aM).toFixed(2);
            inside = isInsideCone(zM, rM, mouthRM, coneHM);
            // Scale witness: rendered whale radius vs the DRAWN rim at its
            // depth (natural drape/cinch radius + the Task-5 contents floor
            // when the driver supplies one; absent ⇒ 0 ⇒ natural only).
            DebrisWireframe.getGeometry(whale.type, whale.id);
            const br = DebrisWireframe.getBoundingRadius(whale.type, whale.id) || 1;
            whaleType = whale.type ?? null;
            whaleRenderRadiusM = +(DebrisField.effectiveRenderScale(whale) * br / M).toFixed(3);
            const sm = whale.sizeMeter, ss = whale.sceneSize;
            sceneSizeConsistent = (typeof sm === 'number' && typeof ss === 'number')
              ? Math.abs(ss - sm * 1e-5) < 1e-12 : null;
            drapeFrac = kh._drape ?? null;
            cinchFrac = kh._cinchFrac ?? null;
            const natural = drawnRimRadiusAtDepth(-lp.z, kh.mouthRadius, kh.coneHeight,
              kh._drape ?? 0, kh._cinchFrac ?? 0,
              Constants.CAPTURE_NET.NET_CEREMONY.DRAWSTRING_RADIUS_FRAC_CLOSED);
            // F5: identical floor + open-cone clamp as the mesh, box-aware,
            // via the shared helper — probe/recorder and mesh must never drift.
            const dp = _netDrawnRimPierce(kh, lp.z, natural, whaleRenderRadiusM, M);
            drawnRimAtWhaleM = dp.drawnRimM;
            pierceM = dp.pierceM;
            chordPierceM = dp.chordPierceM;
          }
          // Anchor-drag witness: lateral displacement of the LIVE muzzle anchor
          // since fire, measured perpendicular to the frozen launchDirection.
          // Read the live anchor directly (pod muzzle scene position ÷ M →
          // metres) so units match net.position (metres). This is the single
          // moving term in the frozen-line update (CaptureNet.js:924): the
          // whale is pinned (sceneVsExpectedM = 0), launchDirection is frozen,
          // so ANY growth in the whale's cone-local lateral offset r is exactly
          // Wrap the per-frame recorder sample. (The former anchorDxM witness was
          // removed: it measured the anchor's huge absolute orbital drift — the
          // ship translates ~10× world-time — not the small lateral component,
          // so it was a red herring. cone-local rM/aM/clearanceM are the honest
          // containment witnesses.)
          const netToWhaleM = net.position
            ? +(Math.hypot(sp.x / M - net.position.x, sp.y / M - net.position.y, sp.z / M - net.position.z)).toFixed(2)
            : null;
          const s = {
            tMs: Math.round(nowMs),
            // Register item 11: the frame this sample belongs to. `tMs` is the
            // rAF timestamp and it is NOT unique — measured 2026-08-09, in
            // roughly half of the runs gameLoop runs TWICE per rAF (second pass
            // at dt ≈ 0), so two distinct frames share one timestamp and
            // per-timestamp reasoning cannot tell that from one frame recorded
            // twice. With `frameCount` (advanced once per pass, inside the
            // isActive block) the gate proves Δframe = 1 across the whole
            // buffer — no frame missed, none duplicated — and prints the
            // DUP-FRAMES witness. One number on an object literal that is
            // already built: no allocation, recorder-only.
            frame: frameCount,
            netState: net.state ?? null,
            beatKey: beat?.key ?? null,
            flightTime: +net.flightTime.toFixed(2),
            travelledM: +net.distanceTraveled.toFixed(1),
            netToWhaleM,
            aM, rM, zM,
            coneRadiusAtZM: coneR,
            clearanceM: (coneR != null && rM != null) ? +(coneR - rM).toFixed(2) : null,
            insideCone: inside,
            pinned: !!whale._onboardingPinned,
            // Whale-in-cone phase 3 scale witness (null when no kit handle).
            whaleType, whaleRenderRadiusM, sceneSizeConsistent,
            drapeFrac, cinchFrac, drawnRimAtWhaleM, pierceM,
            // Follow-up 4: drawn-polyline chord clearance (null off the box path).
            chordPierceM,
          };
          if (_PROBE_REC.buf.length >= _PROBE_REC.cap) { _PROBE_REC.dropped++; return; }
          _PROBE_REC.buf.push(s);
          _PROBE_REC.lastTsMs = nowMs;
          } catch (_e) { /* recorder must never break the game loop */ }
      };


      // ── Net-visual gate (net-fabric-look phase 2, Task 1) ──
      // Dev-only, same `window.__net*` convention as __netScenarioProbe. Three
      // hooks that make "looks like fabric" a measured number:
      //   __netFreeze(true|false)        → alias of __netPause (freeze the sim/
      //                                    sun/camera so two captures are the
      //                                    same instant; phase 1 C4 used this).
      //   __netVisualToggle(part, on)    → set .visible on kit meshes for
      //                                    part ∈ {membrane, web, nodes,
      //                                    tether, all}. The A/B differential
      //                                    C6 needed and never had.
      //   __netRoi()                     → project the ceremony bag's mouth-rim
      //                                    ring + apex into screen space and
      //                                    report a deterministic ROI, plus the
      //                                    membrane material/env instrumentation
      //                                    Task 2's H1–H5 forensics read.
      window.__netFreeze = (val) => window.__netPause(val);

      // Force one render while paused (the game loop early-returns before
      // render() when paused, so a visibility toggle would otherwise never
      // reach the canvas). Two calls flush the composer/renderer. Returns true.
      window.__netRender = () => {
        try { sceneManager?.render(); sceneManager?.render(); } catch (_e) {}
        return true;
      };

      // Grab the current #game-canvas as an opaque-black RGBA data URL. Used by
      // the gate harness to read back each toggle's frozen frame.
      window.__netGrab = () => {
        try {
          const cv = document.getElementById('game-canvas');
          if (!cv) return null;
          const flat = document.createElement('canvas');
          flat.width = cv.width; flat.height = cv.height;
          const ctx = flat.getContext('2d');
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, flat.width, flat.height);
          ctx.drawImage(cv, 0, 0);
          const url = flat.toDataURL('image/png');
          return url.length > 1000 ? url : null;
        } catch (_e) { return null; }
      };


      // Dev-only style override for live ceremony visuals (net-fabric-look Task
      // 3/4 + the gate's prove-fail): lineWidthPx sets the web thread width,
      // membraneOpacity sets the membrane material opacity directly. Passing a
      // field as null leaves it untouched (so one field can be A/B'd at a time).
      window.__netWebStyle = (cfg = {}) => {
        try {
          const snap = {};
          for (const [key, vis] of (captureNetVisual?._activeVisuals ?? [])) {
            if (!vis?.useCeremony || !vis.kitHandle) continue;
            if (typeof cfg.lineWidthPx === 'number') {
              vis.kitHandle.coneMesh.material.linewidth = cfg.lineWidthPx;
            }
            if (typeof cfg.membraneOpacity === 'number') {
              vis.kitHandle.membraneMat.opacity = cfg.membraneOpacity;
            }
            snap[key] = {
              linewidth: vis.kitHandle.coneMesh.material.linewidth,
              membraneOpacity: vis.kitHandle.membraneMat?.opacity ?? null,
            };
          }
          return snap;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };

      // Dev-only membrane configuration + visibility A/B for Task 2 forensics
      // (net-fabric-look). The as-shipped membrane mesh is built hidden and no
      // FSM ever shows it (filmShare measured 0). This forces it visible and
      // applies one material field at a time so the harness can settle H1–H5.
      // Fields: { visible, transmission, opacity, side('front'|'double'),
      //          renderOrder, depthWrite, roughness, sheen, envMapIntensity }.
      // Omitted fields are left untouched. Returns the applied values.
      window.__netMembraneCfg = (cfg = {}) => {
        try {
          const snap = {};
          for (const [key, vis] of (captureNetVisual?._activeVisuals ?? [])) {
            if (!vis?.useCeremony || !vis.kitHandle) continue;
            const mm = vis.kitHandle.membraneMesh, mat = vis.kitHandle.membraneMat;
            if (mm && typeof cfg.visible === 'boolean') mm.visible = cfg.visible;
            if (mat) {
              if (typeof cfg.transmission === 'number') mat.transmission = cfg.transmission;
              if (typeof cfg.opacity === 'number') mat.opacity = cfg.opacity;
              if (typeof cfg.renderOrder === 'number') mm.renderOrder = cfg.renderOrder;
              if (typeof cfg.depthWrite === 'boolean') mat.depthWrite = cfg.depthWrite;
              if (typeof cfg.roughness === 'number') mat.roughness = cfg.roughness;
              if (typeof cfg.sheen === 'number') mat.sheen = cfg.sheen;
              if (typeof cfg.envMapIntensity === 'number') mat.envMapIntensity = cfg.envMapIntensity;
              if (cfg.side === 'front') mat.side = 0;      // THREE.FrontSide
              else if (cfg.side === 'double') mat.side = 2; // THREE.DoubleSide
              mat.needsUpdate = true;
            }
            snap[key] = {
              visible: mm?.visible ?? null,
              opacity: mat ? +mat.opacity.toFixed(3) : null,
              transmission: mat ? +mat.transmission.toFixed(3) : null,
              side: mat ? mat.side : null,
              renderOrder: mm?.renderOrder ?? null,
            };
          }
          return snap;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };

      // Dev-only whale visibility toggle for the manual-gate pixel check
      // (net-fabric-look phase 2): zero-scales the scenario whale's instance so
      // |A − A_noWhale| isolates exactly the whale's pixels — the one way to
      // answer "is the whale visibly inside the net?" without eyes on the PNG.
      let _whaleSavedMatrix = null;
      window.__netWhaleToggle = (on) => {
        try {
          const whale = _scenarioNet?.targetDebris;
          const df = debrisField;
          if (!whale || !df) return { ok: false, reason: 'no whale/debrisField' };
          const lookup = df._instanceLookup?.get(whale.id);
          const mesh = lookup && df.instancedMeshes?.[lookup.meshKey];
          if (!mesh) return { ok: false, reason: 'no instance/mesh' };
          if (!on) {
            if (!_whaleSavedMatrix) _whaleSavedMatrix = new THREE.Matrix4();
            mesh.getMatrixAt(lookup.instanceIndex, _whaleSavedMatrix);
            mesh.setMatrixAt(lookup.instanceIndex, new THREE.Matrix4().makeScale(0, 0, 0));
          } else if (_whaleSavedMatrix) {
            mesh.setMatrixAt(lookup.instanceIndex, _whaleSavedMatrix);
          }
          mesh.instanceMatrix.needsUpdate = true;
          return { ok: true, on: !!on };
        } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
      };

      // Dev-only physics→screen projection for the manual gate (net-fabric-look
      // phase 2): projects net.position, whale._scenePosition and the pod
      // muzzle through the camera so the harness can tell whether the RENDERED
      // whale/bag sit where the physics says they should.
      window.__netProject = () => {
        try {
          const M = 1e-5; // 1 metre in scene units (same M as the probe)
          const cam = sceneManager?.camera;
          const renderer = sceneManager?.renderer;
          if (!cam || !renderer) return { error: 'no camera/renderer' };
          const bufW = renderer.domElement?.width ?? 0;
          const bufH = renderer.domElement?.height ?? 0;
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const proj = (x, y, z) => {
            const v = new THREE.Vector4(x, y, z, 1)
              .applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
            if (v.w <= 0) return null;
            return [Math.round((v.x / v.w * 0.5 + 0.5) * bufW), Math.round((1 - (v.y / v.w * 0.5 + 0.5)) * bufH)];
          };
          const net = _scenarioNet;
          const whale = net?.targetDebris;
          const sp = whale?._scenePosition;
          const pod = (player && typeof player.getNetPodPosition === 'function') ? player.getNetPodPosition(0) : null;
          // Cone-containment: the whale in the ceremony kit's LOCAL frame.
          // local -Z = launch axis; inside the bag ⇔ local z ∈ [-coneH, 0] and
          // local radius < mouthRadius(t). This is the deferred phase-1 metric.
          let whaleLocal = null, insideCone = null;
          try {
            const vis0 = captureNetVisual?._activeVisuals?.get('pod_0')
              ?? [...(captureNetVisual?._activeVisuals?.values() ?? [])].find(v => v?.useCeremony);
            const kh = vis0?.kitHandle;
            if (kh && sp) {
              kh.group.updateMatrixWorld(true);
              const lp = new THREE.Vector3(sp.x, sp.y, sp.z);
              kh.group.worldToLocal(lp);
              const zM = lp.z / M, rM = Math.hypot(lp.x, lp.y) / M;
              const mouthRM = kh.mouthRadius / M, coneHM = kh.coneHeight / M;
              const t = -zM / coneHM;
              whaleLocal = { zM: +zM.toFixed(2), rM: +rM.toFixed(2), t: +t.toFixed(2), mouthRadiusM: +mouthRM.toFixed(2), coneHeightM: +coneHM.toFixed(2) };
              // Use the SHARED predicate (same as probe + recorder) so the three
              // containment tools cannot drift.
              insideCone = isInsideCone(zM, rM, mouthRM, coneHM);
            }
          } catch (_e) {}
          return {
            bufW, bufH,
            netPos: net?.position ? proj(net.position.x * M, net.position.y * M, net.position.z * M) : null,
            whalePos: sp ? proj(sp.x, sp.y, sp.z) : null,
            podPos: pod ? proj(pod.x, pod.y, pod.z) : null,
            netToWhaleM: (net?.position && sp)
              ? +(Math.hypot(sp.x / M - net.position.x, sp.y / M - net.position.y, sp.z / M - net.position.z)).toFixed(2) : null,
            whaleLocal, insideCone,
          };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };

      window.__netVisualToggle = (part, on) => {
        try {
          const on2 = !!on;
          const snap = {};
          for (const [key, vis] of (captureNetVisual?._activeVisuals ?? [])) {
            if (!vis?.useCeremony || !vis.kitHandle) continue;
            const set = (m, v) => { if (m) m.visible = v; };
            if (part === 'all' || part === 'web') set(vis.kitHandle.coneMesh, on2);
            if (part === 'all' || part === 'membrane') set(vis.kitHandle.membraneMesh, on2);
            if (part === 'all' || part === 'nodes') {
              for (const w of vis.kitHandle.rimWeights) set(w, on2);
              set(vis.kitHandle.apexHub, on2);
            }
            if (part === 'all' || part === 'tether') set(vis.tetherLine, on2);
            snap[key] = {
              web: vis.kitHandle.coneMesh.visible,
              membrane: vis.kitHandle.membraneMesh?.visible ?? null,
              tether: vis.tetherLine.visible,
            };
          }
          return snap;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };

      window.__netRoi = () => {
        try {
          const cam = sceneManager?.camera;
          const renderer = sceneManager?.renderer;
          if (!cam || !renderer) return { error: 'no camera/renderer' };
          const bufW = renderer.domElement?.width
            ?? renderer.getSize(new THREE.Vector2()).width;
          const bufH = renderer.domElement?.height
            ?? renderer.getSize(new THREE.Vector2()).height;
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const proj = cam.projectionMatrix;
          const v4 = new THREE.Vector4();
          const lp = new THREE.Vector3();

          let best = null;
          const visuals = {};
          for (const [key, vis] of (captureNetVisual?._activeVisuals ?? [])) {
            if (!vis?.useCeremony || !vis.kitHandle) continue;
            const kh = vis.kitHandle;
            kh.group.updateMatrixWorld(true);
            const mat = kh.group.matrixWorld;

            const pts = [];
            pts.push([0, 0, 0]);                       // apex
            pts.push([0, 0, -kh.coneHeight]);          // mouth centre
            const spokes = Math.max(8, kh.radialSpokes || 20);
            for (let s = 0; s < spokes; s++) {
              const a = (2 * Math.PI * s) / spokes;
              pts.push([
                Math.cos(a) * kh.mouthRadius,
                Math.sin(a) * kh.mouthRadius,
                -kh.coneHeight,
              ]);
            }
            let minPxX = Infinity, minPxY = Infinity, maxPxX = -Infinity, maxPxY = -Infinity;
            let behind = 0, off = 0;
            for (const [x, y, z] of pts) {
              v4.set(x, y, z, 1).applyMatrix4(mat).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(proj);
              if (v4.w <= 0) { behind++; continue; }
              const nx = v4.x / v4.w, ny = v4.y / v4.w;
              if (nx < -1 || nx > 1 || ny < -1 || ny > 1) off++;
              const px = (nx * 0.5 + 0.5) * bufW;
              const py = (1 - (ny * 0.5 + 0.5)) * bufH;
              if (px < minPxX) minPxX = px;
              if (py < minPxY) minPxY = py;
              if (px > maxPxX) maxPxX = px;
              if (py > maxPxY) maxPxY = py;
            }
            if (!isFinite(minPxX)) continue;
            const x0 = Math.max(0, Math.round(minPxX - 1));
            const y0 = Math.max(0, Math.round(minPxY - 1));
            const x1 = Math.min(bufW, Math.round(maxPxX + 1));
            const y1 = Math.min(bufH, Math.round(maxPxY + 1));
            // camInsideBag: camera inside the cone (local z in [-coneH,0] and
            // local radius < mouthRadius at that z).
            let camInsideBag = false;
            try {
              lp.copy(cam.position);
              kh.group.worldToLocal(lp);
              const r = Math.hypot(lp.x, lp.y);
              const t = -lp.z / Math.max(1e-9, kh.coneHeight);
              if (t >= 0 && t <= 1 && r < kh.mouthRadius * (t + 0.05)) camInsideBag = true;
            } catch {}
            const entry = {
              key,
              roi: { x0, y0, x1, y1 },
              roiClipped: behind > 0 || off > 0,
              roiAreaPx: Math.max(0, (x1 - x0) * (y1 - y0)),
              camInsideBag,
              behindPoints: behind,
              offPoints: off,
              camDM: kh.group
                ? +((kh.group.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position)) / 1e-5).toFixed(1)
                : null,
            };
            visuals[key] = entry;
            if (!best || entry.roiAreaPx > best.roiAreaPx) best = entry;
          }
          const out = { bufW, bufH, visuals };
          if (best) {
            const kh = visuals[best.key] && captureNetVisual._activeVisuals.get(best.key)?.kitHandle;
            if (kh) {
              out.primary = best.key;
              out.roi = best.roi;
              out.roiClipped = best.roiClipped;
              out.camInsideBag = best.camInsideBag;
              out.membrane = {
                visible: kh.membraneMesh?.visible ?? null,
                opacity: kh.membraneMat ? +kh.membraneMat.opacity.toFixed(3) : null,
                transmission: kh.membraneMat ? +kh.membraneMat.transmission.toFixed(3) : null,
                roughness: kh.membraneMat ? +kh.membraneMat.roughness.toFixed(2) : null,
                envMapIntensity: kh.membraneMat ? +kh.membraneMat.envMapIntensity.toFixed(2) : null,
                envMapSet: !!kh.membraneMat?.envMap,
                sceneEnvSet: !!sceneManager?.scene?.environment,
              };
            }
          }
          return out;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };

      //   window.__netContentsBox() → the ceremony kit handle's stored contents
      //   spec EXACTLY as the floor/chord maths sees it: the 15-number box
      //   (metres for lengths, unitless rotation rows) + the full drape state
      //   (drape/cinch/jiggle). Follow-up 4 forensics: replay the LIVE spec
      //   through the kit exports offline (tmp instruments) so a gate reading
      //   can be dissected edge-by-edge without re-deriving anything.
      window.__netContentsBox = () => {
        try {
          const M = 0.00001;
          const vis0 = captureNetVisual?._activeVisuals?.get('pod_0')
            ?? [...(captureNetVisual?._activeVisuals?.values() ?? [])].find(v => v?.useCeremony);
          const kh = vis0?.kitHandle;
          if (!kh) return null;
          const b = kh._contentsBox;
          return {
            drape: kh._drape ?? 0,
            cinchFrac: kh._cinchFrac ?? 0,
            jigglePhase: kh._jigglePhase ?? 0,
            jiggleAmpM: +((kh._jiggleAmp ?? 0) / M).toFixed(4),
            contentsZM: +((kh._contentsZ ?? 0) / M).toFixed(4),
            contentsRadiusM: +((kh._contentsR ?? 0) / M).toFixed(4),
            box: b ? {
              ox: +(b.ox / M).toFixed(4), oy: +(b.oy / M).toFixed(4), oz: +(b.oz / M).toFixed(4),
              r00: b.r00, r01: b.r01, r02: b.r02,
              r10: b.r10, r11: b.r11, r12: b.r12,
              r20: b.r20, r21: b.r21, r22: b.r22,
              hx: +(b.hx / M).toFixed(4), hy: +(b.hy / M).toFixed(4), hz: +(b.hz / M).toFixed(4),
            } : null,
          };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      };
      // ── Follow-up 5 (2026-08-06): armed cinch freeze — pin the pixel gate's
      // capture instant to a probe quantity, never a wall-clock poll ──
      // Plan: .kilo/plans/1786005074767-pin-pixel-gate-capture-instant.md.
      // The CINCH still used to be grabbed when the harness's 300 ms poll first
      // saw beatKey 'CINCH', plus a 700 ms wall settle — under the 0.1 s dt cap
      // the beat's wall duration stretches 8–20+ s with headless frame rate, so
      // the freeze landed anywhere in the first ~40 % of the camera dolly and
      // whalePxFrac flaked ±30 % on identical code (0.217–0.402, register item
      // 5). This hook freezes the sim ITSELF on the first frame where the
      // ceremony kit's cinchFrac reaches the pinned target during the CINCH
      // beat — frame-quantized to ≤ 2.5 % of the cinch, never wall-clock.
      //   __netArmCinchFreeze(target) → arm (null/omitted disarms)
      //   __netCinchFreezeStatus()    → { armed, target, fired }
      // Dev-only; one boolean check per frame when disarmed (same cost contract
      // as the probe recorder).
      const _CINCH_FREEZE = { armed: false, target: 0, fired: null };
      window.__netArmCinchFreeze = (target) => {
        if (typeof target === 'number' && isFinite(target)) {
          _CINCH_FREEZE.armed = true;
          _CINCH_FREEZE.target = target;
          _CINCH_FREEZE.fired = null;
        } else {
          _CINCH_FREEZE.armed = false;
          _CINCH_FREEZE.fired = null;
        }
        return { armed: _CINCH_FREEZE.armed, target: _CINCH_FREEZE.target };
      };
      window.__netCinchFreezeStatus = () => ({
        armed: _CINCH_FREEZE.armed,
        target: _CINCH_FREEZE.target,
        fired: _CINCH_FREEZE.fired,
      });
      // Called once per frame from gameLoop, right after __netProbeTick — i.e.
      // after updateCamera + render, so the frame the freeze holds is exactly
      // the frame this check observes. The beatKey conjunct is load-bearing:
      // cinchFrac stays 1 through REELING/BERTHED, so without it a late cinch
      // would freeze a SECURED_SETTLE frame and call it CINCH.
      window.__netCinchFreezeTick = () => {
        if (!_CINCH_FREEZE.armed) return;
        try {
          const c = cameraSystem?._netCeremony;
          const beat = c?.beats?.[c.beatIndex];
          if (beat?.key !== 'CINCH') return;
          // Allocation-free kit-handle lookup (per-frame path): direct pod_0
          // hit, else scan values without the spread array.
          const av = captureNetVisual?._activeVisuals;
          let vis0 = av?.get('pod_0');
          if (!vis0 && av) for (const v of av.values()) { if (v?.useCeremony) { vis0 = v; break; } }
          const cinchFrac = vis0?.kitHandle?._cinchFrac;
          if (typeof cinchFrac !== 'number' || cinchFrac < _CINCH_FREEZE.target) return;
          _CINCH_FREEZE.fired = {
            cinchFrac: +cinchFrac.toFixed(3),
            beatKey: beat.key,
            beatPhase: +(c.beatTimer / beat.duration).toFixed(3),
            netState: _scenarioNet?.state ?? null,
          };
          _CINCH_FREEZE.armed = false;   // one-shot
          window.__netPause(true);       // the SAME pause path the manual freeze uses
        } catch (_e) { /* freeze hook must never break the game loop */ }
      };
      // ── Register item 6 (2026-08-07): armed beat-PHASE freeze — pin the
      // fabric gate's per-beat capture instants to the ceremony clock, never a
      // wall-clock poll. Plan:
      // .kilo/plans/1786058581397-pin-fabric-gate-capture-instants.md.
      // The fabric gate's four gated beats were grabbed on first-sight + 700 ms
      // wall — the same flake class follow-up 5 fixed for the pixel gate's
      // CINCH still (same-code re-checks failed filmShare by 0.0009). This hook
      // is the phase-keyed sibling of the cinch freeze: it pauses the sim on
      // the first frame where beatTimer/beat.duration reaches the pinned phase
      // DURING the named beat — frame-quantized to ≤ 0.1/duration of the phase.
      //   __netArmBeatFreeze(beatKey, targetPhase) → arm (null disarms)
      //   __netBeatFreezeStatus()                 → { armed, beatKey, targetPhase, fired }
      // Dev-only; one boolean check per frame when disarmed (same cost contract
      // as the cinch hook). CINCH keeps the cinch hook (cinchFrac is the
      // composition quantity there); this hook is for the other beats.
      const _BEAT_FREEZE = { armed: false, beatKey: null, targetPhase: 0, fired: null };
      window.__netArmBeatFreeze = (beatKey, targetPhase) => {
        if (typeof beatKey === 'string' && typeof targetPhase === 'number' && isFinite(targetPhase)) {
          _BEAT_FREEZE.armed = true;
          _BEAT_FREEZE.beatKey = beatKey;
          _BEAT_FREEZE.targetPhase = targetPhase;
          _BEAT_FREEZE.fired = null;
        } else {
          _BEAT_FREEZE.armed = false;
          _BEAT_FREEZE.beatKey = null;
          _BEAT_FREEZE.fired = null;
        }
        return { armed: _BEAT_FREEZE.armed, beatKey: _BEAT_FREEZE.beatKey, targetPhase: _BEAT_FREEZE.targetPhase };
      };
      window.__netBeatFreezeStatus = () => ({
        armed: _BEAT_FREEZE.armed,
        beatKey: _BEAT_FREEZE.beatKey,
        targetPhase: _BEAT_FREEZE.targetPhase,
        fired: _BEAT_FREEZE.fired,
      });
      // Same call-site and same-frame doctrine as the cinch tick (runs after
      // __netProbeTick, post updateCamera + render). The beatKey conjunct is
      // load-bearing: beatTimer keeps its value when a beat force-advances or
      // the ceremony exits, so without it a late arm could freeze a frame from
      // the WRONG beat. A beat whose phase never reaches the target (e.g.
      // APPROACH_DOLLY force-advancing on NET_BRAKE_FIRED below it) simply
      // never fires — the harness fails loudly instead of certifying a
      // mis-timed still.
      window.__netBeatFreezeTick = () => {
        if (!_BEAT_FREEZE.armed) return;
        try {
          const c = cameraSystem?._netCeremony;
          // `active` is load-bearing alongside the beatKey conjunct: beatIndex
          // and beatTimer KEEP their values when the ceremony exits, so an arm
          // that lands after the exit (or after the beat already passed the
          // target) would otherwise fire on a frame whose camera has moved on
          // and label it with the beat's name — certifying a still from outside
          // the beat. A missed target must fail loudly in the harness instead.
          if (c?.active !== true) return;
          const beat = c.beats?.[c.beatIndex];
          if (!beat || beat.key !== _BEAT_FREEZE.beatKey) return;
          if (!(beat.duration > 0)) return;          // no phase without a duration
          const phase = c.beatTimer / beat.duration;
          if (!(phase >= _BEAT_FREEZE.targetPhase)) return;
          _BEAT_FREEZE.fired = {
            beatKey: beat.key,
            beatPhase: +phase.toFixed(3),
            netState: _scenarioNet?.state ?? null,
          };
          _BEAT_FREEZE.armed = false;   // one-shot
          window.__netPause(true);       // the SAME pause path the manual freeze uses
        } catch (_e) { /* freeze hook must never break the game loop */ }
      };
      console.info('[netRoi] ready. __netRoi(), __netVisualToggle(part, on), __netFreeze(true).');


      // ── deep-polish-4 T2: menu→sim handoff apparent-size probe ──
      // Analytic (no pixel classification): projects each model's bounding
      // sphere through its own camera to a vertical screen-height fraction, so
      // the harness (tmp/scb_handoff.cjs) can gate the match-cut on a <20% size
      // discontinuity and read the INTRO_START_SCALE that makes hero≈ship.
      //   hero  = receding menu MenuScene3D Mother at the handoff (orbitR→8)
      //   ship  = sim PlayerSatellite in chase at INTRO_START_SCALE (the cut)
      // fracH  = 2·atan(radius / distance) / vFOV — units cancel per model.
      window.__handoffProbe = () => {
        const out = {};
        try {
          const ms = menuScreen && menuScreen._menuScene3D;
          if (ms && ms.camera && ms._mother) {
            const box = new THREE.Box3().setFromObject(ms._mother);
            const r = box.getBoundingSphere(new THREE.Sphere()).radius;
            const vfov = ms.camera.fov * Math.PI / 180;
            const dStart = ms._departureBaseOrbitR; // 5.5 (idle)
            const dEnd = ms._departureOrbitR;        // 8.0 (fully receded @ handoff)
            out.hero = {
              fovDeg: ms.camera.fov, radius: r, distIdle: dStart, distHandoff: dEnd,
              fracIdle: 2 * Math.atan(r / dStart) / vfov,
              fracHandoff: 2 * Math.atan(r / dEnd) / vfov,
            };
          }
          if (player && cameraSystem && cameraSystem.camera && cameraSystem.chase) {
            const box = new THREE.Box3().setFromObject(player);
            const r = box.getBoundingSphere(new THREE.Sphere()).radius;
            const vfov = (cameraSystem._baseFov || cameraSystem.camera.fov) * Math.PI / 180;
            const ob = cameraSystem.chase.offsetBehind;
            const oa = cameraSystem.chase.offsetAbove;
            const chaseDist = Math.hypot(ob, oa);
            const scale = Constants.EARTH.INTRO_START_SCALE;
            out.sim = {
              fovDeg: cameraSystem._baseFov || cameraSystem.camera.fov,
              radius: r, chaseDist, scale,
              distCut: chaseDist * scale, distSettled: chaseDist,
              fracCut: 2 * Math.atan(r / (chaseDist * scale)) / vfov,
              fracSettled: 2 * Math.atan(r / chaseDist) / vfov,
            };
          }
          if (out.hero && out.sim) {
            out.matchRatio = out.sim.fracCut / out.hero.fracHandoff; // want ≈1.0 (<20% off)
            // Solve the scale that makes ship apparent size == hero-at-handoff:
            // 2·atan(r/(chaseDist·s)) = fracHandoff·vfov → s = r / (chaseDist·tan(θ/2))
            const vfov = (cameraSystem._baseFov || cameraSystem.camera.fov) * Math.PI / 180;
            const theta = out.hero.fracHandoff * vfov;
            const t = Math.tan(theta / 2);
            out.suggestedScale = t > 0 ? out.sim.radius / (out.sim.chaseDist * t) : null;
          }
        } catch (e) {
          out.error = String(e && e.message || e);
        }
        return out;
      };
      console.info('[handoffProbe] ready. __handoffProbe() → analytic hero/ship apparent-size + suggestedScale.');
    }
  } catch (e) {
    console.warn('[netShot] hook setup failed:', e);
  }

  _bootMark('init() complete. First rAF scheduled');
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
  // §14.1 (revised 3, 2026-08-31) — Window blurred (user clicked another macOS
  // app; the browser window can still be fully VISIBLE beside it). The sim
  // halts (zero update work, dt frozen via lastTime), but the canvas layer is
  // KEPT ALIVE by re-presenting one frame on EVERY ~5 Hz wake while blurred:
  // after seconds with no present, Chromium's compositor purges the layer's
  // tiles and the visible-but-unfocused window shows a flickering BLACK
  // RECTANGLE over the canvas (the long-hunted "black flicker" — probe
  // evidence in js/core/BlackFrameProbe.js dumps: 12–28 s rAF starvations with
  // visibilityState 'visible' and zero occlusion events, healing on any
  // focus-restoring window event: resize, fullscreen, DevTools).
  // Revision 3 evidence (bfp-dump-1788174453, Chrome 152 / ANGLE-Metal M4 Max):
  // the revised-2 cadence of one present per 2 s STILL flickered black during a
  // 7.4 s blur window at F6/F7 — the compositor purged tiles between the 2 s
  // presents. Present-per-wake is ~5 fps ≈ 4 % of the 120 Hz frame budget, so
  // the §14.1 energy goal ("GPU idles when switching apps") still holds.
  // Revision 4 (2026-08-31, bfp-dump-1788177490): rev-3's 5 Hz presents STILL
  // flickered black (0 starve / 0 gap events, blur windows 3.2 s + 4.4 s) —
  // present cadence alone is not the whole story on Chrome 152 + ANGLE-Metal.
  // Now: render EVERY blurred wake at a ~30 fps schedule (see
  // _getScheduleIntervalMs) — no compositor purge window, sim still frozen.
  if (_windowBlurred) {
    lastTime = timestamp;
    _blurKeepalivePresentTs = timestamp;
    try {
      if (strategicMap && strategicMap.isOpen()) strategicMap.render();
      else if (sceneManager) sceneManager.render();
      if (blackFrameProbe) blackFrameProbe.tick(timestamp);
    } catch (_e) { /* keepalive must never break the halt path */ }
    _scheduleNextFrame(); // ~33 ms interval while blurred (_getScheduleIntervalMs)
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
    // Perf warmup/settle guard — start the clock on the first active frame so
    // the GPU probe + runtimeAdapt below ignore startup transients (see
    // Constants.PERF.ADAPT_WARMUP_MS).
    if (_perfSettleUntil === 0) _perfSettleUntil = timestamp + Constants.PERF.ADAPT_WARMUP_MS;
    const fps = 1 / realDt;
    // Only sample real gameplay frames, AND only after the warmup/settle window
    // has elapsed. Menu / briefing / shop / game-over are intentionally throttled
    // to ~30 fps (see _getScheduleIntervalMs), below the 50 fps downshift threshold
    // — feeding them to runtimeAdapt would read the deliberate throttle as a slow
    // GPU and downshift the tier on a static UI screen. The `timestamp >=
    // _perfSettleUntil` gate keeps one-time startup/mission-build transients
    // (shader compile, texture upload, scene build) OUT of the history entirely, so
    // the first post-settle decision can't be a median dominated by that jank.
    // Startup/non-gameplay assessment is the GPU probe's job (it measures per-frame
    // GPU ms, which the frame-schedule throttle does not skew).
    // Zoom Ladder G1: ladder ride/gesture frames are excluded the same way —
    // they are deliberate camera-flight transients, not steady state (see
    // _ladderAdaptHoldoff above).
    const _adaptHold = _ladderAdaptHoldoff(timestamp);
    if (gameState.isGameplay() && timestamp >= _perfSettleUntil && !_adaptHold && Number.isFinite(fps) && fps > 0) {
      _fpsHistory.push(fps);
      if (_fpsHistory.length > Constants.PERF.FPS_HISTORY_SIZE) _fpsHistory.shift();
    }
    _framesSinceLastTierChange++;
    // Cadence: every N frames since last tier change. Uses our own counter
    // (not `frameCount`, which only ticks during gameplay). runtimeAdapt is
    // gated on isGameplay() too (matching the sampling gate above), so a
    // throttled UI screen can never drive an FPS-based tier change.
    //
    // Sprint 3 GPU profiling: `?autoProfile=1` requires tier stability across
    // configurations (otherwise the disable-X delta-vs-baseline is measuring
    // tier-change drift instead of the toggled feature). Skip runtimeAdapt
    // entirely while a profile sweep session is live.
    if (sceneManager && gameState.isGameplay() && !profileFlags.autoProfile && !profileFlags.pinTier && timestamp >= _perfSettleUntil && !_adaptHold && (_framesSinceLastTierChange % _ADAPT_CHECK_INTERVAL) === 0) {
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

  // --- Zoom Ladder S3: the ONE world-time choke point (T2) ---------------
  // `dt` above is dtReal (real, slow-mo-scaled) — it drives camera, UI,
  // ceremonies, attitude, resources, animations. The TimeAuthority derives the
  // world-simulation delta `dtWorld = dtReal × BASE_SCALE × warp` from it, once
  // per frame, and hands it to the orbital/environmental systems below. Warp
  // only ever leaves 1× when the ladder is engaged (flag on + gameplay); while
  // disengaged the authority pins the shipped base rate with no ramp, so
  // `dtWorld === dt × Constants.TIME_SCALE_GAMEPLAY` bit-for-bit (byte-identical).
  //
  // The warp target is the CURRENT floor's timeCap; during a crossing the
  // ZoomLadder core already reports the DESTINATION floor as current, so this
  // pre-ramps toward the arrival rate during the ride. An active conjunction
  // alert is the danger signal that clamps warp back to 1× (S4 refines this to
  // the full alarm horizon).
  //
  // Q10 (docs/ladder/08-workbench.md §8, "the roll is its own phase"): while a
  // cross-anchor ride is going UP (F5→F6) — and until its post-ride level phase
  // completes — the camera reports the DEPARTURE floor as a hold, whose cap
  // wins, so the time-lapse engages only after arrival + leveling, never during
  // the flight. Down-rides report no hold: the existing destination pre-ramp
  // settles time first (TimeAuthority.ladderTargetCap is the pure rule).
  const _ladderActive = !!(ladderController && ladderController.isActive && ladderController.isActive());
  let _floorCap = 1;
  if (_ladderActive && ladderController.ladder && ladderController.ladder.getState) {
    const _lf = ladderController.ladder.getState().floor;
    const _lfRow = FloorContract.byId(_lf);
    _floorCap = _lfRow ? _lfRow.timeCap : 1;
    const _hold = (cameraSystem && cameraSystem.ladderWarpHoldFloor) ? cameraSystem.ladderWarpHoldFloor() : null;
    const _holdRow = (_hold != null) ? FloorContract.byId(_hold) : null;
    const _holdCap = _holdRow ? _holdRow.timeCap : null;
    _floorCap = TimeAuthority.ladderTargetCap(_floorCap, _holdCap);
    // D10 calm cap (00-spec §7): a workbench pane open settles time to 1× —
    // applied AFTER the Q10 hold rule; never raises (a cap-0 floor stays 0).
    _floorCap = TimeAuthority.calmCap(_floorCap, _workbenchPaneOpen);
  }
  // Q10 level-phase sound (S4): one settle cue on the RISE edge of the
  // camera's post-arrival level-to-north phase (~600 ms, "its own sound" —
  // 08-workbench §8 Q10). Flag-off/disengaged: _ladderActive false pins the
  // edge state false — zero work on the shipped path.
  const _leveling = _ladderActive &&
    !!(cameraSystem && cameraSystem.isLadderLeveling && cameraSystem.isLadderLeveling());
  if (_leveling && !_ladderLevelingPrev && ladderSfx) ladderSfx.onLevelPhase();
  _ladderLevelingPrev = _leveling;
  // Danger cap: only meaningful while warp can apply (ladder engaged), so skip
  // the getStatus() read entirely on the shipped flag-off path (no per-frame
  // allocation there). timeAuthority.update ignores dangerActive when inactive.
  const _danger = _ladderActive &&
    !!(conjunctionSystem && conjunctionSystem.getStatus && conjunctionSystem.getStatus().alertActive);
  _taFrameArgs.dtReal = dt;
  _taFrameArgs.active = _ladderActive;
  _taFrameArgs.targetCap = _floorCap;
  _taFrameArgs.dangerActive = _danger;
  timeAuthority.update(_taFrameArgs);
  const dtWorld = timeAuthority.dtWorld;
  // Rail warp readout (VisualLaw.RAIL.SHOWS 'warp-readout'; 08-workbench §2):
  // the live rate, only while the ladder is engaged. setRate is write-on-change
  // and ≤ 4 Hz internally (G1), so the per-frame call is free. Flag-off:
  // _ladderActive is false → never called.
  if (_ladderActive && railIndicator && railIndicator.setRate) railIndicator.setRate(timeAuthority.rate);

  const currentState = gameState.currentState;

  // Render policy (08-workbench §2): ONE viewCover signal per frame. Under a
  // 'full' cover (Tech Library open / ShopScreen plate — both ~opaque) the
  // scene paint and the HUD DOM writes are skipped below; the SIM POLICY IS
  // UNCHANGED (every system still ticks). MenuScreen is not a cover (its plate
  // is translucent; the live scene behind it is the design). Never skipped
  // while the BlackFrameProbe (?bfp) or the ?shot harness is armed — both read
  // the framebuffer and a skipped render would read as the black they triage.
  const _cover = viewCover({
    codexVisible: !!(codexViewerUI && codexViewerUI.isVisible && codexViewerUI.isVisible()),
    shopVisible: !!(shopScreen && shopScreen.visible),
  });
  const _skipPaint = coverSkipsPaint(_cover, { diagnosticsArmed: !!blackFrameProbe || !!devShotGate.requested });

  // --- Always update visuals (scene renders behind menus) ---
  const sunDir = sunLight.update(dt, player.getPosition());
  earth.setSunDirection(sunDir);
  earth.update(dt);
  // P2: bloom gate — skips the whole UnrealBloom mip chain on frames where
  // nothing can cross the threshold. NOT sun-only: Venus rides the brightness
  // ladder at 2.74 (> Constants.BLOOM_THRESHOLD) and its visibility is
  // independent of the sun's, so the gate asks SunLight for any visible
  // threshold-crossing source (see SunLight.isBloomSourceVisible).
  sceneManager.setBloomEnabled(sunLight.isBloomSourceVisible());
  // B2: feed the renderer's CAPPED pixel ratio (HIGH tier caps at 1.5), not
  // window.devicePixelRatio (=2.0), so gl_PointSize maps to the true physical
  // render-target and stars aren't ~33% oversized.
  starfield.update(dt, sceneManager.getRenderer().getPixelRatio(), sceneManager.getCamera());
  // UX-11 #5: city-label cull/fade (no-op while hidden)
  try { cityLabels.update(); } catch (e) { console.error('[GameLoop] cityLabels:', e); }
  try { launchCameo.update(dt); } catch (e) { console.error('[GameLoop] launchCameo:', e); }
  try { ambientLaunchScheduler.update(dt); } catch (e) { console.error('[GameLoop] ambientLaunch:', e); }
  try { menuOrbitPreview.update(dt); } catch (e) { console.error('[GameLoop] menuOrbitPreview:', e); }

  // --- Update entities only in active gameplay states ---
  const isActive = gameState.isGameplay();

  if (isActive) {
    // Advance frame counter + set on debrisField for spatial query caching
    frameCount++;
    debrisField.setFrameId(frameCount);

    // Process input
    inputManager.processInput(dt);

    // F15: Autopilot steering + thrust (before player.update applies thrustInput)
    try { autopilotSystem.update(dt, dtWorld); } catch (e) { console.error('[GameLoop] autopilotSystem:', e); }

    // Collision Avoidance — after autopilot, before player.update (dodge impulse applied to _rcsVelocity)
    try { collisionAvoidanceSystem.update(dt); } catch (e) { console.error('[GameLoop] collisionAvoidance:', e); }

    // Update game state timer
    gameState.update(dt);

    // Update entities (with error boundaries — single system crash won't freeze game)
    try { player.update(dt, sunDir, dtWorld); } catch (e) { console.error('[GameLoop] player.update:', e); }
    // Register item 14: ship-attitude hold. Runs IMMEDIATELY after the prograde
    // compose so the overwrite lands before the net's reel/berth ticks read
    // player.quaternion in captureNetSystem.update below — an end-of-loop site
    // (with the freeze ticks) would be overwritten by the next frame's compose
    // BEFORE the net sees it. One null-check per frame when disarmed. Dev-only.
    if (window.__netShipHoldTick) window.__netShipHoldTick();
    try { debrisField.update(dt, player.getPosition(), player.getOrbitalElements(), dtWorld); } catch (e) { console.error('[GameLoop] debrisField:', e); }
    try { activeSatellites.update(dt, player.getPosition(), dtWorld); } catch (e) { console.error('[GameLoop] activeSats:', e); }

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

    // UX-11 #11: lost-in-space recovery advisor (5 s scan cadence internally; veteran-gated watchdog)
    try { navRecoveryAdvisor.update(dt); } catch (e) { console.error('[GameLoop] navRecoveryAdvisor:', e); }

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

    // Reward-first autolock + net-range tracking (after targetSelector so a
    // dead target is cleared first, allowing immediate reacquire).
    try { if (autoLockController) autoLockController.update(dt); } catch (e) { console.error('[GameLoop] autoLockController:', e); }

    // Update extracted systems
    try { resourceSystem.update(dt); } catch (e) { console.error('[GameLoop] resourceSystem:', e); }
    try { sensorSystem.update(dt, player.getPosition(), debrisField); } catch (e) { console.error('[GameLoop] sensorSystem:', e); }
    // Phase 1.5 (capture-feedback overhaul): close-range survey → Full Profile
    try {
      dossierSystem.update(dt, {
        playerPos: player.getPosition(),
        armManager,
        target: targetSelector.getActiveTarget ? targetSelector.getActiveTarget() : null,
      });
    } catch (e) { console.error('[GameLoop] dossierSystem:', e); }
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
    try {
      // Aim-before-launch: the lasso geometry (muzzle, flight, reel-in
      // destination, cargo cells) is built around this "forward" dir. Feed it the
      // ship's actual NOSE (+Z) rather than the velocity vector, so after the
      // mother slews to face the debris the catch reels straight back to the
      // current nose instead of the old prograde-relative spot off to the side.
      // When idle the nose already tracks prograde, so idle behaviour is unchanged.
      const _noseDir = player.quaternion
        ? _lassoVelScratch.set(0, 0, 1).applyQuaternion(player.quaternion).normalize()
        : (() => { const _lv = player.getVelocity();
            return (_lv && (_lv.x || _lv.y || _lv.z))
              ? _lassoVelScratch.set(_lv.x, _lv.y, _lv.z).normalize() : null; })();
      lassoSystem.update(dt, player.getPosition(), debrisField, targetSelector.getActiveTarget(), _noseDir);
    } catch (e) { console.error('[GameLoop] lassoSystem:', e); }

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

    // Update conjunction alert system (Sprint C1). S3: dtWorld drives the MOID
    // timer; above ~10× warp detection switches to MOID screening (T2).
    try {
      conjunctionSystem.update(dt, gameState, debrisField.debrisList,
        player.getPosition(), player.getVelocity(), inputManager.isArmPilotMode(),
        dtWorld, timeAuthority.isMoidScreening());
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
    updateCamera(dt, timestamp);

    // HUD update — skipped under a 'full' viewCover (the HUD is invisible
    // behind the plate; it re-syncs on the first uncovered frame — its own
    // 10 Hz / 2 Hz timers keep polling, nothing is event-driven inside).
    if (!_skipPaint) hud.update(dt, {
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

    // Register item 43: the per-frame ΔV alarm poll is deleted — it read
    // `budget.percentage`, a field getMassBudget() has never had (NaN → tier 0
    // → the idempotence guard tore down the honest alarm every frame). The ONE
    // driver is StatusPanel's 10 Hz DELTAV_UPDATE event → AudioSystem's
    // listener (AudioSystem.js). Out-of-gameplay silencing is unchanged —
    // STATE_CHANGE / pause / blur / visibilitychange all call stopDeltaVAlarm().

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
      // Zoom Ladder F6/F7: while the engaged floor iconizes the ship, the
      // ladder suppresses the aiming reticles (LadderController._setReticlesHidden
      // owns the hide). This per-frame re-show must not fight it — while
      // suppressed, fall to the else branch so the overlay stays hidden every
      // frame. reticlesSuppressed() is allocation-free and false whenever the
      // ladder is off/disengaged, so the shipped path is byte-identical.
      const _ladderReticleSuppress = !!(ladderController
        && ladderController.reticlesSuppressed && ladderController.reticlesSuppressed());
      if (!_ladderReticleSuppress && inputManager.isArmPilotMode() && cameraSystem) {
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
    updateCamera(dt, timestamp);
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
      // Mission-1 welcome-field per-piece size/position/visibility diagnostics
      // (empty array on later missions). Lets us tune the first-mission cluster.
      welcomeDebris: (debrisField && typeof debrisField.getWelcomeFieldDiagnostics === 'function')
        ? debrisField.getWelcomeFieldDiagnostics(player ? player.getPosition() : null)
        : [],
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
    _bootMark('first sceneManager.render(). START');
  }
  if (strategicMap && strategicMap.isOpen()) {
    strategicMap.update(dt);
    if (!_skipPaint) strategicMap.render();
  } else if (!_skipPaint) {
    // viewCover 'full' (Tech Library / ShopScreen plate): the whole composer
    // pipeline is skipped — the canvas keeps its last presented frame under
    // the ~opaque plate. Never skipped while ?bfp / ?shot are armed.
    sceneManager.render();
  }
  if (_bootFirstRenderCall) {
    _bootMark('first sceneManager.render(). END');
  }
  if (_logBootEnabled) {
    _bootSpikeDetect(performance.now() - _bootRenderStart);
  }

  // Black-flicker triage (?bfp): must run INSIDE this rAF task, right after the
  // frame's final render, so its readbacks see this frame's buffer pre-present.
  if (blackFrameProbe) blackFrameProbe.tick(timestamp);

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
    if (timestamp < _perfSettleUntil && !profileFlags.autoProfile) {
      // Warmup: discard transient shader-compile / texture-upload / scene-build
      // samples so the probe window fills with steady-state frames only. Without
      // this the median of the first 60 frames is inflated by one-time load cost
      // and falsely downshifts a machine that holds the tier at steady state.
      probe.resetSamples();
    } else if (probe.getSampleCount() >= Constants.PERF.GPU_PROBE_FRAMES) {
      _gpuProbeComplete = true;
      const medianMs = probe.getMedianMs();
      const threshold = Constants.PERF.GPU_PROBE_THRESHOLD_MS;
      console.log(`[Perf] GPU probe complete: median=${medianMs.toFixed(2)}ms threshold=${threshold}ms (${probe.getSampleCount()} samples)`);
      // Sprint 3 GPU profiling: skip the tier-downshift action when
      // `?autoProfile=1` is set. The sweep must measure each config at a
      // fixed tier; an auto-downshift in the first 0.5 s of the session
      // would render every later config's delta meaningless. The downshift
      // recommendation is still logged for visibility.
      if (medianMs > threshold && sceneManager.currentTier !== 'LOW' && !profileFlags.autoProfile && !profileFlags.pinTier) {
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
      } else if (medianMs > threshold && (profileFlags.autoProfile || profileFlags.pinTier)) {
        console.log(`[Perf] GPU probe: median ${medianMs.toFixed(1)}ms > ${threshold}ms but tier downshift suppressed (?autoProfile=1 or ?pinTier=1)`);
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

  // Whale-in-cone Task 1.4: per-frame probe recorder. One boolean check when
  // disabled; builds a slim cone-containment sample when __netProbeRecord(true).
  if (window.__netProbeTick) window.__netProbeTick(timestamp);
  // Lasso flight recorder (round 3) — same end-of-loop doctrine: the sample
  // is END-OF-FRAME truth for exactly the rendered frame.
  if (window.__scbLassoRecTick) window.__scbLassoRecTick(timestamp);
  // Whale-in-cone follow-up 5: armed cinch freeze. Runs after the recorder tick
  // (end of loop, post-render) so the frame the freeze holds is exactly the
  // frame the check observes. One boolean check when disarmed.
  if (window.__netCinchFreezeTick) window.__netCinchFreezeTick();
  // Register item 6: armed beat-phase freeze. Same call-site doctrine as the
  // cinch tick above (end of loop, post-render ⇒ the frozen frame IS the
  // rendered frame). One boolean check when disarmed.
  if (window.__netBeatFreezeTick) window.__netBeatFreezeTick();
}

// ============================================================================
// CAMERA UPDATE
// ============================================================================

/**
 * Update camera via CameraSystem.
 * @param {number} dt - Delta time in seconds
 * @param {number} timestamp - rAF high-res timestamp (ms) — the monotonic clock
 *   the ladder core runs on (same domain as performance.now(); the WheelRouter
 *   feeds ladder.wheel() from the same clock).
 */
function updateCamera(dt, timestamp) {
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

  // Zoom Ladder (S2): tick the core (charge decay, settle-back, alarm/ride
  // escalation) + apply decisions BEFORE the camera update reads the ladder
  // frame. `timestamp` is the shared performance.now-based monotonic clock the
  // WheelRouter also feeds ladder.wheel(). Internally gated on the flag +
  // gameplay, so this is inert when Constants.LADDER.ENABLED is false.
  if (ladderController) ladderController.update(timestamp);

  // Update the camera system
  cameraSystem.update(dt, playerPos, playerVel, playerQuat);

  // Zoom Ladder F6 (NAVCOM): tick the floor content AFTER the camera update so
  // the cluster icons + ship chevron read THIS frame's camera pose (no one-frame
  // lag). This is the SINGLE navcom ticker (LadderController no longer ticks it).
  // NavcomFloor.update() self-gates on active; we ALSO gate the projector/heading
  // work on isActive() so the shipped flag-off path does zero extra per-frame work
  // (byte-identical). navcom is active only on F6 while the ladder is engaged.
  if (navcomFloor && navcomFloor.isActive()) {
    const shipPos = player.getPosition();
    const vel = player.getVelocity();
    const vmag = Math.hypot(vel.x, vel.y, vel.z) || 1;
    const eps = 0.05; // world-unit nudge along velocity (heading direction only, scale-free)
    const s0 = navcomProject(shipPos);
    const s1 = navcomProject({
      x: shipPos.x + (vel.x / vmag) * eps,
      y: shipPos.y + (vel.y / vmag) * eps,
      z: shipPos.z + (vel.z / vmag) * eps,
    });
    const shipAngleRad = Math.atan2(s1.y - s0.y, s1.x - s0.x);
    navcomFloor.update({ project: navcomProject, shipPos, shipAngleRad });
  }

  // Zoom Ladder F5 (PROX NET): same single-ticker pattern as navcom — after
  // cameraSystem.update so the overlay reads this frame's pose. F5 and F6
  // are never active together, so at most one block runs per frame.
  if (proxNetFloor && proxNetFloor.isActive()) {
    const shipPos = player.getPosition();
    const vel = player.getVelocity();
    const vmag = Math.hypot(vel.x, vel.y, vel.z) || 1;
    const eps = 0.05;
    const s0 = navcomProject(shipPos);
    const s1 = navcomProject({
      x: shipPos.x + (vel.x / vmag) * eps,
      y: shipPos.y + (vel.y / vmag) * eps,
      z: shipPos.z + (vel.z / vmag) * eps,
    });
    const shipAngleRad = Math.atan2(s1.y - s0.y, s1.x - s0.x);
    proxNetFloor.update({ project: navcomProject, shipPos, shipAngleRad });
  }

  // Zoom Ladder F7 (SDA): screen-space chart — no projector or ship pose
  // needed; the floor self-throttles its data refresh (2 s cadence).
  if (sdaFloor && sdaFloor.isActive()) sdaFloor.update();

  // Zoom Ladder F3 (HULL CAM): the camera→subject distance in METRES drives
  // the overview/detail lens split; centerX (the subject's screen x) picks the
  // rail side for the callout cards. Reads this frame's camera pose, so it
  // stays in the same after-cameraSystem.update slot as navcom.
  if (hullcamFloor && hullcamFloor.isActive()) {
    const _hcam = cameraSystem.camera;
    const distM = _hcam.position.distanceTo(playerPos) / Constants.SCENE_UNITS_PER_METER;
    hullcamFloor.update({ distM, centerX: navcomProject(playerPos).x });
  }

  // Detail-LOD cull (Phase 6): feed the fresh camera→craft distance (scene units)
  // to the Mother + daughters so their inert mm-scale hardware hides when far.
  // Craft code stays camera-agnostic; this is the single owner of the distance.
  const _cam = sceneManager.getCamera();
  if (_cam) {
    const camDist = _cam.position.distanceTo(playerPos);
    if (typeof player.setCameraDistance === 'function') player.setCameraDistance(camDist);
    if (typeof player.setCameraWorldPos === 'function') player.setCameraWorldPos(_cam.position);
    if (armManager && typeof armManager.setCameraDistance === 'function') {
      armManager.setCameraDistance(camDist);
    }
  }

  // Inspection callouts — run AFTER the camera so band/facing use this frame's
  // camera pose. Cheap no-op internally unless inspection is engaged.
  if (motherCallouts) {
    try { motherCallouts.update(dt); }
    catch (e) { console.error('[GameLoop] motherCallouts:', e); }
  }
}


// ============================================================================
// RESIZE HANDLER
// ============================================================================

function onResize() {
  sceneManager.resize();
  // Resize-tick repaint (2026-08-30): during a live window drag the compositor
  // rescales the LAST rendered frame into the new canvas box instantly (no JS),
  // while the screen-anchored DOM overlays (city/station labels) only move when
  // the next rAF frame reprojects them — so the Earth visibly stretches ahead
  // of its labels ("city names lag behind when shrinking horizontally").
  // Rendering + reprojecting synchronously in the SAME resize tick keeps the
  // canvas content and the DOM labels locked together. Cost: one extra render
  // per resize event (~2–3 ms GPU on the reference M4), only while resizing.
  try {
    if (strategicMap && strategicMap.isOpen()) strategicMap.render();
    else sceneManager.render();
    cityLabels.update();
  } catch (_e) { /* resize repaint must never break the handler */ }
}

// ============================================================================
// START
// ============================================================================

init();
