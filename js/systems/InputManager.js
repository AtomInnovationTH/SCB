/**
 * InputManager.js — Keyboard input handling extracted from main.js
 * Manages key state, arm pilot mode, target cycling, and routes input
 * to game systems via dependency injection.
 * @module systems/InputManager
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { Constants } from '../core/Constants.js';
import { powerDistribution, PowerBuses } from './PowerDistribution.js';
import { settingsManager } from './SettingsManager.js';
import timerManager from './TimerManager.js';
import { despinLaser } from './DespinLaser.js';
import { DEV_ACTIONS, resolveNextDevAction } from './DevSequenceAdvancer.js';
import { classifyNetTarget, OUT_OF_MOTHER_NETS_LINE, OUT_OF_NET_RANGE_LINE, targetRangeM, netRangeLine } from './netRouting.js';
import { computeLeadAim, netMaxReachM } from '../entities/CaptureNet.js';
import { tripRefuses } from './TransferTrip.js';
import { isFree, samePiece, netRefusalLine, wrapRefusalLine, SCAN_FIRST_LINE, DAUGHTERS_ONLY_LINE, fanOutNoneText, daughtersHeldBackLine } from './PieceClaim.js';
import { openingDance } from './OpeningDance.js';
import { GestureHints } from '../ui/hud/GestureHints.js';

/**
 * u15b B-T2: the line posted when a daughter's pilot view opens. It says only what works: the arrow keys (the turn pad on
 * glass) steer her only while she holds station (the STATION_KEEP block of update()); the way out is Esc / V / her number
 * again on a keyboard, a tap on her row in DAUGHTERS again on glass. Glass is read now (D7).
 * @param {string} name
 * @returns {string}
 */
export function pilotLine(name) {
  return GestureHints.isGlass()
    ? `Piloting ${name}. The turn pad steers her once she holds station · tap her row in DAUGHTERS again: back to the mother.`
    : `Piloting ${name}. Arrow keys steer her once she holds station · Esc, V or her number again: back to the mother.`;
}

/** F19: the reason text `AutopilotSystem._rejectAim` sends when the player's own steering ended the turn (AutopilotSystem.js `onManualRotate`). */
export const MANUAL_AIM_REASON = 'Manual attitude input';

/**
 * u18a (D1): the arm states in which a daughter is NOT out flying on her tether: at home (docked, parked with a catch,
 * reloading, docking), lost, or on a radiator carry. A selected daughter in one of these has her digit deselect her;
 * a selected daughter in any other state that is not piloted gets piloted by her digit.
 * @param {string} state - ARM_STATES value
 * @returns {boolean}
 */
function isHomeOrBusyArmState(state) {
  const S = Constants.ARM_STATES;
  return state === S.DOCKED || state === S.HOLDING_CATCH || state === S.RELOADING || state === S.DOCKING
    || state === S.EXPENDED || state === S.CARRY_PREP || state === S.CARRY_OUT
    || state === S.CARRY_HANDOFF || state === S.CARRY_BACK;
}

export class InputManager {
  constructor() {
    /** @type {Object<string, boolean>} Key state map */
    this.keys = {};

    /** @type {boolean} ARM PILOT mode active */
    this.armPilotMode = false;

    /** @type {number} Current target index for Tab cycling */
    this.targetIndex = 0;

    /** @type {Array} Nearby targets list for Tab cycling */
    this.nearbyTargets = [];

    /** @type {number} Target cycle cooldown timer */
    this.targetCycleTimer = 0;

    // Dependencies (set via init)
    this._deps = null;

    // S4: Control mode tracking for HUD indicator
    /** @type {string} Current WASD control mode — 'RCS'|'COLD_GAS'|'ARM_PILOT' */
    this._controlMode = 'RCS';

    // S4: Lasso windup state
    /** @type {boolean} Whether lasso is in windup phase */
    this._lassoWindingUp = false;
    /** @type {object|null} F14: the Shift+A daughters' wait for the net's turn (see _afterNetSettles) */
    this._netWait = null;
    /** @type {number|null} Windup timeout handle */
    this._lassoWindupTimeout = null;

    // UX-11 #9 (2026-06-11): the ST-5.1 C-key tap/hold state
    // (_cKeyDownTs/_cHoldTimeout/_cRadialOpen) was removed with the radial menu.

    // PR 6 / P3.13: Audio unlock self-test state
    /** @type {boolean} Whether first user gesture has been handled for audio unlock */
    this._firstGestureHandled = false;
    /** @type {number|null} TimerManager id for audio unlock check */
    this._audioUnlockTimerId = null;

    // Bind handlers for add/removeEventListener
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
  }

  /**
   * Initialize with game system dependencies.
   * @param {object} deps
   * @param {object} deps.gameState
   * @param {object} deps.player
   * @param {object} deps.armManager
   * @param {object} deps.cameraSystem
   * @param {object} deps.targetSelector
   * @param {object} deps.debrisField
   * @param {object} deps.debrisWireframe
   * @param {object} deps.dockingReticle
   * @param {object} deps.hud
   * @param {object} deps.targetReticle
   * @param {object} deps.navSphere
   * @param {object} deps.debrisMap
   * @param {object} deps.audioSystem
   * @param {object} deps.debugOverlay
   * @param {object} deps.sensorSystem
   * @param {object} deps.lassoSystem
   * @param {function} deps.transitionToState
   * @param {function} deps.deployArm
   * @param {function} deps.applyUpgrades
   * @param {function} deps.setPaused
   * @param {function} deps.getPaused
   * @param {function} deps.setLastTime
   * @param {function} deps.setApproachTarget
   * @param {function} deps.setApproachComplete
   */
  init(deps) {
    this._deps = deps;

    // interlocks-p2: the daughters' piece-owner check has to see the lasso too (it is not reachable from the ship).
    if (deps && deps.armManager && deps.lassoSystem && typeof deps.armManager.setLassoSystem === 'function') {
      deps.armManager.setLassoSystem(deps.lassoSystem);
    }

    // Self-manage: auto-exit arm pilot mode when piloted arm returns or is expended
    // (decoupled from GameFlowManager ARM_RETURNED / ARM_EXPENDED handlers)
    const handleArmPilotExit = (data, isExpended) => {
      const cam = this._deps?.cameraSystem;
      if (this.armPilotMode && cam?.getPilotedArm()?.id === data.armId) {
        this._exitArmPilotCamera();
        if (isExpended) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'DAUGHTER PILOT disengaged. Daughter expended',
            priority: 'warning',
          });
        }
      }
      // D4 (hotkey revamp 2026-06-14): clear the selection when the returning /
      // expended daughter is the selected one, so its 3D selection glow stops
      // (otherwise the body keeps pulsing cyan after it docks/expends, since
      // selection persists and nothing pressed a key). Runs regardless of
      // armPilotMode — a daughter selected (docked-glow) but never piloted must
      // also clear if it somehow returns/expends.
      const am = this._deps?.armManager;
      if (am && typeof am.getSelectedArm === 'function'
          && am.getSelectedArm()?.id === data.armId) {
        am.deselectArm();
      }
    };
    eventBus.on(Events.ARM_RETURNED, (data) => handleArmPilotExit(data, false));
    eventBus.on(Events.ARM_EXPENDED, (data) => handleArmPilotExit(data, true));

    // u17b (D7b): a piloted daughter that ends up PARKED WITH A CATCH by any path (a radiator carry that ends
    // with her still holding is the known one; a dock goes through ARM_RETURNED above) leaves pilot mode and
    // is deselected, exactly as a docked arrival: the pilot view has nothing to offer her (no net to launch,
    // no recall) and its range beeps would run against her own rack. Some ARM_STATE_CHANGE payloads carry only
    // `{ armId, manual }` (ArmUnit enableManual / disableManual), so test `to`.
    eventBus.on(Events.ARM_STATE_CHANGE, (data) => {
      if (!data || data.to !== Constants.ARM_STATES.HOLDING_CATCH) return;
      const cam = this._deps?.cameraSystem;
      if (!this.armPilotMode || cam?.getPilotedArm()?.id !== data.armId) return;
      this._exitArmPilotCamera();
      const am = this._deps?.armManager;
      if (am && typeof am.getSelectedArm === 'function' && am.getSelectedArm()?.id === data.armId) {
        am.deselectArm();
      }
    });

    // V-7: Ceremony complete — restore FOV unless entering ARM_PILOT tracking.
    // When ceremony → ARM_PILOT (auto-entry path so the camera stays on the
    // daughter for debris inspection), keep the narrow ~40° FOV and ALSO turn
    // on armPilotMode so arrow-key SK orbit controls + WASD manual thrust work
    // immediately (the player did not have to enter pilot mode manually — the
    // ceremony hands them straight into the daughter).
    // When skipLaunchCeremony → CHASE, snap FOV back to COMMAND default.
    eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, (payload) => {
      const cam = this._deps?.cameraSystem;
      // u20-ipad F2: bare D with nobody selected auto-picks a daughter, and the full ceremony pilots her here with no
      // selection ever made (the strip, her row and `R` then disagreed about who she was). Select her now, but only when
      // she is not already selected: ArmManager.selectArm TOGGLES a selected arm off.
      this._selectLaunched(payload && payload.arm);
      if (cam) {
        // Always record the normal FOV for later restore when exiting ARM_PILOT
        cam.armPilot.fovNormal = Constants.CAMERA_FOV;
        if (cam.currentView !== 'ARM_PILOT') {
          // Not entering ARM_PILOT tracking → snap FOV to COMMAND default
          cam._baseFov = Constants.CAMERA_FOV;
          cam.camera.fov = Constants.CAMERA_FOV;
          cam.camera.updateProjectionMatrix();
        } else if (!this.armPilotMode) {
          // Camera auto-entered ARM_PILOT view — bring input mode in sync so
          // arrow keys (SK orbit) and WASD (manual thrust) are wired up.
          this.armPilotMode = true;
          const pilotArm = cam.getPilotedArm?.();
          if (pilotArm && pilotArm.enableManual) pilotArm.enableManual();
        }
      }
    });

    // UX Fix E+: Auto-advance to next target when debris is captured.
    // No dedup guard — function is idempotent (re-selecting the same next
    // target is harmless) and retries are essential for the DEBRIS_REMOVED
    // safety net when the primary capture-event path silently fails.
    const handleCaptureAdvance = (capturedId) => {
      // FIX: Use != null instead of !capturedId so debris ID 0 is valid
      if (capturedId == null) return;

      const d = this._deps;
      if (!d.targetSelector || !d.debrisField || !d.player) return;

      // Mark the captured debris so reticle stops rendering it immediately
      const capturedDebris = d.debrisField.getDebrisById(capturedId);
      if (capturedDebris) capturedDebris._captured = true;

      // Clear current target if it matches captured debris
      const current = d.targetSelector.getActiveTarget();
      if (current && current.id === capturedId) {
        d.targetSelector.clearTarget();
      }

      // If a valid (non-captured) target already exists, skip re-selection.
      // This prevents double TARGET_SELECTED emissions when both LASSO_CAPTURED
      // and ARM_CAPTURED call handleCaptureAdvance for the same debris, while
      // still allowing retries when the primary path failed (no target set).
      const existingTarget = d.targetSelector.getActiveTarget();
      if (existingTarget) return;

      // Auto-select next best target (keeps gameplay flowing)
      try {
        const playerPos = d.player.getPosition();
        const playerOrbit = d.player.getOrbitalElements();
        if (!playerPos || !playerOrbit) return;

        const targets = d.debrisField.getEnhancedTargetList(playerPos, playerOrbit)
          .filter(t => t.id !== capturedId && !t._captured &&
            (t.tracked !== false || (d.sensorSystem && d.sensorSystem.canDetectUntracked)));

        // 2026-10-18: an automatic pick stays within AUTOLOCK.RANGE_M — a 385 km
        // auto-pick emptied the argon in mission 2. Keep the list's order (TPI),
        // take the first entry in range; none → select nothing.
        const rangeM = Constants.AUTOLOCK.RANGE_M;
        const next = targets.find(t => t.distanceKm * 1000 <= rangeM);
        if (next) {
          // FIX_PLAN §4: best target = lowest TPI (composite score)
          const debris = d.debrisField.getDebrisById(next.id);
          if (debris) {
            d.targetSelector.setTarget(debris, { distanceKm: next.distanceKm, deltaV: next.deltaV });
            // UI updates in separate try/catch — must not prevent target selection
            try {
              if (d.debrisWireframe) d.debrisWireframe.setTarget(debris);
              if (d.hud) d.hud.setSelectedTarget(next.id);
              if (d.targetReticle) d.targetReticle.setSelectedTarget(next.id);
              if (d.navSphere) d.navSphere.setSelectedTarget(next.id);
            } catch (uiErr) { /* non-fatal UI sync failure */ }
            this.targetIndex = 0;
          }
        }
      } catch (err) { /* auto-advance is best-effort */ }
    };

    // FIX: ARM_CAPTURED from LassoSystem uses { debrisId } not { targetId }.
    // Accept both keys so lasso captures have a backup auto-advance path.
    // FIX: Use != null checks so debris ID 0 is valid (0 is falsy but a valid ID).
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      const id = data && (data.targetId != null ? data.targetId : data.debrisId);
      if (id != null) {
        handleCaptureAdvance(id);
      }
    });
    eventBus.on(Events.LASSO_CAPTURED, (data) => {
      if (data && data.debrisId != null) {
        handleCaptureAdvance(data.debrisId);
      }
    });

    // Safety net: if DEBRIS_REMOVED cleared our target and no capture-event
    // handler managed to auto-advance (e.g. silent throw), pick next target
    // after all synchronous handlers have finished.
    // FIX: Use != null check so debris ID 0 is valid.
    eventBus.on(Events.DEBRIS_REMOVED, (data) => {
      if (!data || data.id == null) return;
      const removedId = data.id;
      queueMicrotask(() => {
        const d = this._deps;
        if (!d?.targetSelector || !d.debrisField || !d.player) return;
        if (d.targetSelector.getActiveTarget()) return; // already has a target — nothing to do
        // No target after all sync handlers ran — auto-advance as fallback
        handleCaptureAdvance(removedId);
      });
    });

  }

  // ========================================================================
  // Audio unlock — retried on EVERY gesture until the context runs
  // (owner 2026-09-30: "game should always have sound"; w1-first-minute D1)
  // ========================================================================

  /**
   * Gestures that ONLY retry the audio unlock. On touch, pointerdown is not a
   * user-activation event — activation comes from pointerup / touchend /
   * click / keydown — so the first try on an iPad usually fails and the
   * START click used to be the only thing that brought sound back. These
   * listeners never skip the opening dance (that stays on pointerdown).
   */
  static AUDIO_GESTURE_EVENTS = Object.freeze(['pointerup', 'touchend', 'click']);

  /**
   * Resume the AudioContext on a user gesture (keydown, pointerdown, pointerup,
   * touchend, click), retrying on every gesture until `ctx.state` is
   * 'running'. Then `_firstGestureHandled` latches — it is the short-circuit
   * several test files set to skip this path — and the audio-only listeners
   * come off. No user-facing message: the old AUDIO_UNLOCK_FAILED toast
   * reported a failure that the next tap fixes. One console.warn at most.
   * @private
   */
  _tryAudioUnlock() {
    if (this._firstGestureHandled) return;
    if (!this._deps) return;          // not wired yet — the next gesture tries again

    const audio = this._deps.audioSystem;
    if (!audio) { this._finishAudioUnlock(); return; }   // nothing to unlock

    if (typeof audio.init === 'function') audio.init();
    const ctx = audio.ctx;
    // No context (?noAudio=1, no Web Audio) or a closed one: nothing to unlock.
    if (!ctx || ctx.state === 'closed' || ctx.state === 'running') {
      this._finishAudioUnlock();
      return;
    }

    if (typeof audio.resume === 'function') audio.resume();
    if (ctx.state === 'running') { this._finishAudioUnlock(); return; }

    // A browser settles resume() asynchronously: look again shortly so the
    // audio-only listeners come off even if no further gesture arrives.
    if (this._audioUnlockTimerId !== null) timerManager.clear(this._audioUnlockTimerId);
    this._audioUnlockTimerId = timerManager.setTimeout(() => {
      this._audioUnlockTimerId = null;
      if (this._firstGestureHandled) return;
      if (ctx.state === 'running') { this._finishAudioUnlock(); return; }
      if (!this._audioUnlockWarned) {
        this._audioUnlockWarned = true;
        console.warn('[Audio] AudioContext still suspended after a gesture. Retrying on the next one');
      }
    }, 200, { owner: this });
  }

  /**
   * The context runs (or there is none to unlock): latch the short-circuit,
   * drop the pending check and the audio-only listeners.
   * @private
   */
  _finishAudioUnlock() {
    this._firstGestureHandled = true;
    if (this._audioUnlockTimerId !== null) {
      timerManager.clear(this._audioUnlockTimerId);
      this._audioUnlockTimerId = null;
    }
    this._removeAudioGestureListeners();
  }

  /** @private Detach the pointerup / touchend / click unlock listeners. */
  _removeAudioGestureListeners() {
    if (!this._audioGestureListening) return;
    this._audioGestureListening = false;
    if (typeof window === 'undefined') return;
    for (const type of InputManager.AUDIO_GESTURE_EVENTS) {
      window.removeEventListener(type, this._onAudioGesture, true);
    }
  }

  /**
   * Pointerdown handler — retries the audio unlock (every gesture until the
   * context runs) and fast-forwards the opening dance.
   * @param {PointerEvent} _e
   * @private
   */
  _handlePointerDown(_e) {
    this._tryAudioUnlock();
    // Opening dance: any input fast-forwards the remaining unfold. skip() is
    // internally refused before the cut AND for a moment after a menu skip
    // advanced the clock — MenuScreen's skip runs on window CAPTURE and this
    // handler on BUBBLE, so without that second guard the one click that skips
    // the MENU departure would also skip the dance.
    openingDance.skip();
  }

  /** Start listening for keyboard events */
  start() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // S2 (T3): the mouse wheel is now owned by the single WheelRouter (window
    // capture). The arm-pilot STATION_KEEP branch lives on in
    // handleArmPilotWheel(e), which the router calls first (highest priority) —
    // verbatim behavior, no separate listener here anymore.
    window.addEventListener('pointerdown', this._onPointerDown);
    // Audio-only unlock retries (D1). Capture phase, so a stopPropagation()
    // elsewhere cannot swallow the activating gesture.
    if (!this._firstGestureHandled && !this._audioGestureListening) {
      if (!this._onAudioGesture) this._onAudioGesture = () => this._tryAudioUnlock();
      for (const type of InputManager.AUDIO_GESTURE_EVENTS) {
        window.addEventListener(type, this._onAudioGesture, { capture: true, passive: true });
      }
      this._audioGestureListening = true;
    }
  }

  /** Stop listening */
  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('pointerdown', this._onPointerDown);
    this._removeAudioGestureListeners();
    // PR 6 / P3.13: Clear pending audio unlock timer on teardown
    if (this._audioUnlockTimerId !== null) {
      timerManager.clear(this._audioUnlockTimerId);
      this._audioUnlockTimerId = null;
    }
  }

  /**
   * Arm-pilot STATION_KEEP wheel branch — called by the single WheelRouter (S2,
   * T3) with highest priority. Behavior is preserved VERBATIM from the shipped
   * window-capture listener: when armPilotMode && the piloted arm is in
   * STATION_KEEP, consume the wheel (preventDefault + stopPropagation) and emit
   * one ARM_ORBIT_ADJUST with a `radiusStep` (instantaneous metres delta), NOT a
   * rate. Direction matches +/- keys: scroll-up → closer (negative step),
   * scroll-down → farther (positive step). Legacy CAMERA_ZOOM_INPUT emission
   * moved to the router (it fires for every wheel event, arm-SK included).
   * @param {WheelEvent} e
   * @returns {boolean} true if the event was consumed by the SK branch
   */
  handleArmPilotWheel(e) {
    if (!this.armPilotMode) return false;
    const d = this._deps;
    const skArm = d?.cameraSystem?.getPilotedArm?.();
    if (!skArm || skArm.state !== Constants.ARM_STATES.STATION_KEEP) return false;

    // Consume the wheel — prevent page scroll AND any downstream handler from
    // also zooming.
    e.preventDefault();
    e.stopPropagation();

    const step = Constants.STATION_KEEP.WHEEL_STEP_M || 0.5;
    // deltaY > 0 = scroll down/back = retreat (+radius)
    // deltaY < 0 = scroll up/forward = approach (-radius)
    const sign = (e.deltaY > 0) ? 1 : -1;
    const fine = e.shiftKey;
    const stepM = sign * step * (fine ? 0.5 : 1.0);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: skArm.id,
      theta: 0,
      phi: 0,
      radius: 0,
      radiusStep: stepM,
      fine,
    });
    return true;
  }

  /** @returns {boolean} */
  isArmPilotMode() {
    return this.armPilotMode;
  }

  /** @param {boolean} val */
  setArmPilotMode(val) {
    this.armPilotMode = val;
  }

  /**
   * 2026-08-26 — true while ANY key is currently held. The lasso catch cut
   * refuses to START over active piloting: a key held before contact never
   * produces a fresh keydown, so the cut's any-input abort alone could not
   * protect that player. Wired to CameraSystem via setLassoCutInputProbe.
   * @returns {boolean}
   */
  anyKeyHeld() {
    for (const code in this.keys) {
      if (this.keys[code]) return true;
    }
    return false;
  }

  /**
   * Zoom Ladder key bindings (00-spec §5): resolve the LadderController and
   * return it ONLY while it is engaged — `isActive()` is the controller's
   * documented engagement probe (flag on + gameplay + engaged), so with
   * `Constants.LADDER.ENABLED` false this always returns null and every key
   * below falls through to its legacy case byte-identically. The dep arrives
   * as a getter closure (`getLadderController`) because main.js constructs
   * the ladder block after `inputManager.init()`.
   * @private
   * @returns {object|null} the engaged LadderController, or null
   */
  _ladderIfEngaged() {
    const get = this._deps && this._deps.getLadderController;
    const lc = get ? get() : null;
    return (lc && lc.isActive && lc.isActive()) ? lc : null;
  }

  /**
   * Pause or resume the game — the ONE body behind Esc and the touch pause button (PauseButton). Gameplay only.
   * Pausing shows the pause overlay; resuming hides it, resets the frame timer and emits PAUSE_RESUME (the main.js
   * loop's wake hook: without it the screen froze after resuming). With the zoom ladder engaged Esc rides up a floor
   * instead of pausing, so the button calls this directly and never sends Esc.
   * @returns {boolean|null} true when now paused, false when now running, null when not in gameplay (nothing done)
   */
  togglePause() {
    const d = this._deps;
    if (!d || !d.gameState || !d.gameState.isGameplay()) return null;
    const wasPaused = d.getPaused();
    d.setPaused(!wasPaused);
    if (!wasPaused) {
      // Just paused — show pause overlay
      if (d.hud) d.hud.showPause();
      return true;
    }
    // Unpaused — hide overlay + reset timer
    if (d.hud) d.hud.hidePause();
    d.setLastTime(performance.now());
    // Emit PAUSE_RESUME so the rAF loop in main.js gets woken back
    // up. Without this the gameLoop stays asleep after ESC-unpause
    // (the `_scheduleNextFrame()` wake hook lives behind this event).
    // Symptom prior to this emit: screen froze after pressing ESC
    // to resume because nothing scheduled the next rAF callback.
    eventBus.emit(Events.PAUSE_RESUME);
    return false;
  }

  /**
   * Handle keydown events — routes to game systems.
   * @param {KeyboardEvent} e
   */
  _handleKeyDown(e) {
    // Audio unlock: retried on every gesture until the context runs (w1-first-minute D1)
    this._tryAudioUnlock();

    // UX-11 #10: never treat typing in a text field (e.g. the Codex search
    // box) as game hotkeys.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
      return;
    }

    // Anti-ASR guard for macOS Voice Control phantom "i" keystrokes.
    // Default OFF.  As of the 2026-06-15 hotkey remap, bare I = Info/Codex
    // toggle (was the de-spin laser hold, which moved to L; before that I was
    // Inspection).  Re-enable via Constants.INPUT.SUPPRESS_BARE_I if dictation
    // regressions reappear — note that doing so will also suppress the Info
    // (Codex) toggle.  Historical context: events arrived with `isTrusted:
    // true` because ASR injects through the OS HID layer (debug session
    // 2026-05-10).
    if (Constants.INPUT?.SUPPRESS_BARE_I === true
        && e.code === 'KeyI' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      return;
    }

    // Opening dance (2026-09-16, decision 10): any input fast-forwards the
    // remaining unfold over ~0.5 s, then control. The key is never eaten —
    // skip() is a side note, not a wall (the lasso-cut hook below follows the
    // same rule). Internally refused before the cut (t < 2.70 s), where input
    // belongs to MenuScreen's own departure skip instead.
    openingDance.skip();

    this.keys[e.code] = true;
    const d = this._deps;
    const currentState = d.gameState.currentState;
    const isGameplay = d.gameState.isGameplay();

    // 2026-08-26 — lasso catch cut: ANY key aborts it instantly and the key
    // still does its normal job (never eaten, never blocked — the cut is
    // garnish, not a wall; contrast the launch ceremony's blanket block).
    if (d.cameraSystem && typeof d.cameraSystem.lassoCutActive === 'function'
        && d.cameraSystem.lassoCutActive()) {
      d.cameraSystem.abortLassoCut();
    }

    // Prevent arrow keys from scrolling the page during gameplay
    if (isGameplay && (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      // F15: Arrow key input disengages autopilot — EXCEPT while a daughter
      // arm is in STATION_KEEP. The pilot's arrows are then consumed by the
      // SK θ/φ orbit controls (line ~1330 below), not by mothership
      // rotation. Disengaging the mother AP at that moment would let the
      // mother drift off-orbit, tug the tethered daughter off the debris,
      // and risk tether-tangle (CRITICAL failure scenario — debug session
      // 2026-05-15 polish task 3).
      const _skArmForGuard = this.armPilotMode && d.cameraSystem?.getPilotedArm?.();
      const _inSkForGuard  = _skArmForGuard && _skArmForGuard.state === Constants.ARM_STATES.STATION_KEEP;
      // FIX_PLAN §3: Use lockTier for AP-disengage guard — suppress on both soft and block tiers.
      const _lockTierForAP = d.armManager?.getRotationLockTier?.() ?? 'none';
      if (d.autopilotSystem && d.autopilotSystem.engaged && !_inSkForGuard) {
        if (_lockTierForAP === 'block' || _lockTierForAP === 'soft') {
          // Daughter tethered — preserve AP, emit throttled COMMS notice
          this._maybeEmitTetherLockMsg();
        } else {
          d.autopilotSystem.disengage('ARROW_INPUT');
        }
      }
      // Phase C: Notify tutorial of arrow key press
      eventBus.emit(Events.TUTORIAL_ARROW_INPUT);
    }

    // --- Hotkey reference overlay intercept — while the shortcut list is open,
    //     only ? (Slash, toggles closed) does anything; ESC is handled by the
    //     overlay's own capture-phase listener. Block all other gameplay keys. ---
    if (d.hotkeyOverlay && d.hotkeyOverlay.isVisible()) {
      if (e.code === 'Slash') {
        d.hotkeyOverlay.toggle();
        d.audioSystem?.playClick();
        e.preventDefault();
      }
      return;
    }

    // --- F17: Codex overlay intercept — suppress all input except I (toggle) and ESC (close) ---
    // ESC never reaches this handler: the viewer's capture-phase listener owns
    // it (and closes via the viewer's own _requestClose seam). The Zoom Ladder
    // hosted mode left with ArchiveFloor (Session H); its PgUp/PgDn/Space
    // fall-through was deleted with it (tidy-up (4), 2026-09-05) — while the
    // codex is open, every key but I is blocked here again.
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) {
      if (e.code === 'KeyI') {
        d.codexViewerUI.toggle();
        d.audioSystem?.playClick();
        e.preventDefault();
        return;
      }
      return; // block all other keys while codex is open
    }

    // Strategic Map (Shift+V) retired 2026-10-09 (H1, owner: players do not need
    // more keys to memorize; F4 shows the same). The module and its Events key
    // stay; nothing opens it, so the old open-map intercept is gone.

    // --- Debris Map intercept — suppress most input, allow cluster nav + close ---
    // ST-5.1: Pass through PageUp, PageDown for comms pane interaction
    if (d.debrisMap && d.debrisMap.isVisible()) {
      switch (e.code) {
        case 'Escape':
          d.debrisMap.hide();
          d.audioSystem?.playClick();
          e.preventDefault();
          return;
        case 'Backquote':
          if (!e.repeat) {
            d.debrisMap.hide();
            d.audioSystem?.playClick();
            e.preventDefault();
          }
          return;
        case 'KeyM':
          // D4: M opens the Debris Map — it must also CLOSE it (symmetry with
          // the Backquote alias). Without this the map-open intercept's default
          // branch swallowed KeyM, so the map could only be closed with Esc / `.
          if (!e.repeat) {
            d.debrisMap.hide();
            d.audioSystem?.playClick();
            e.preventDefault();
          }
          return;
        case 'Comma':
          d.debrisMap.selectPrev();
          e.preventDefault();
          return;
        case 'Period':
          d.debrisMap.selectNext();
          e.preventDefault();
          return;
        case 'KeyA':
          if (e.shiftKey) {
            d.debrisMap.engageSelectedCluster();
            d.audioSystem?.playClick();
            e.preventDefault();
          }
          return;
        // ST-5.1: Allow these keys through for comms pane
        case 'PageUp':
        case 'PageDown':
          break; // fall through to normal handling
        default:
          return; // block all other keys while debris map is open
      }
    }

    // V-7: Launch ceremony — ESC aborts to CHASE, D deploys another arm,
    // Space/Enter skip ahead to ARM_PILOT. All other keys are blocked so the
    // player watches the daughter deploy without accidental skip.
    // Delegation 1 (2026-05-31): "deploy another" key migrated from G → D
    // because the primary deploy verb moved to bare D.
    if (d.cameraSystem?._launchCeremony?.active) {
      if (e.code === 'Escape') {
        d.cameraSystem.skipLaunchCeremony(false); // return to CHASE
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyD' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        // Second D press: skip ceremony, new deploy will start its own ceremony
        d.cameraSystem.skipLaunchCeremony(false);
        // Fall through to KeyD handler to deploy new arm
      } else if (e.code === 'Space' || e.code === 'Enter') {
        d.cameraSystem.skipLaunchCeremony(false); // skip to CHASE (ARM_PILOT via V key)
        e.preventDefault();
        return;
      } else {
        // Block all other keys during ceremony — prevents accidental skip to FPV
        e.preventDefault();
        return;
      }
    }

    // Net ceremony (parent §11.2) — ESC / Space / Enter always release the
    // camera takeover, mirroring the launch-ceremony contract above. This is
    // the skip path for the REEL_IN beat (up to REEL_BEAT_MAX_S) and every
    // other net beat; skipNetCeremony() routes through _exitNetCeremony so the
    // saved view is restored and CeremonyTimeScale resets to 1.0×.
    //
    // Deliberately does NOT block other keys, unlike the launch-ceremony block.
    // The launch ceremony is a short, player-initiated deploy; the net ceremony
    // fires passively on a catch during active play and runs 15.2 s of beats
    // plus up to REEL_BEAT_MAX_S (12 s) of chained REEL_IN — up to ~27 s. A
    // blanket block there costs the player every discrete action (view, scan,
    // autopilot, deploy, power presets) for that whole window, which is a worse
    // failure than an accidental view change. Held/polled controls were never
    // affected either way (this.keys is written above, before these intercepts).
    if (d.cameraSystem?._netCeremony?.active
        && (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter')) {
      d.cameraSystem.skipNetCeremony();
      e.preventDefault();
      return;
    }

    // ST-5.1: Comms menu intercept removed — center popup deleted.
    // UX-11 #9: the C-hold RadialMenu was also removed. Bare C is now unbound
    // (2026-06-16 cleanup); comms expand lives on the 7 key.

    switch (e.code) {
      // Confirm / Enter action (gameplay only — menu/briefing handle their own Enter)
      case 'Enter':
        // H1 2026-10-09: with the zoom ladder engaged Enter does nothing — it
        // moved ORBITAL_VIEW → INTERACTION with no visible change and left B
        // dead until a net catch. Ladder off (?ladder=0) keeps the legacy approach.
        if (isGameplay && !this._ladderIfEngaged()) {
          // If we have a target selected and we're in orbital view, begin approach
          const target = d.targetSelector.getActiveTarget();
          if (target && currentState === GameStates.ORBITAL_VIEW) {
            d.setApproachTarget(target);
            d.setApproachComplete(false);
            d.transitionToState(GameStates.APPROACH);
          }
        }
        // Note: Menu and Briefing Enter handling is now in their own keydown listeners
        break;

      // Cycle targets — Tab (legacy alias) and T (the menu's "Target debris"
      // verb, 2026-06-14) both route through _cycleTarget().
      case 'Tab':
        if (isGameplay) {
          this._cycleTarget();
        }
        // Only prevent default during gameplay (briefing handles its own Tab)
        if (isGameplay) e.preventDefault();
        break;

      // Escape — pause or back
      case 'Escape': {
        // (ST-6.4: Strategic map Escape handled by top-level intercept above)
        // Debris Map intercept: Escape closes map before other handling
        if (d.debrisMap && d.debrisMap.isVisible()) {
          d.debrisMap.hide();
          e.preventDefault();
          break;
        }
        // Zoom Ladder (00-spec §5): "Esc = ride one floor up; if something modal
        // is open, cancel that instead." ORDERING: every modal/takeover Esc path
        // stays ABOVE this branch — the hotkey overlay, codex and strategic map
        // intercepts, the debris-map close (both the top-level intercept and the
        // in-case check just above), and the launch/net ceremony skips all return
        // before the ladder sees the key. The ladder branch then PRECEDES the
        // legacy state-transition + camera-view fallbacks (INTERACTION/APPROACH
        // exits, inspection exit, arm-pilot exit, pause), because while engaged
        // the ladder replaces those mode keys (00-spec §1). Alarm auto-ride
        // cancel lives inside the core (command 'esc' cancels it first). Engaged
        // only in gameplay with LADDER.ENABLED — flag-off is byte-identical.
        // Wave 5 (3) — 08-workbench §2 (the hosted-codex rule): "Esc closes the
        // topmost pane first, then rides up". ONE controller call decides — the
        // pane order (REFIT today, the TECH LIBRARY later) lives in
        // LadderController.closeTopPane(); this branch knows no pane by name.
        // true → a pane was open and is now closed: consume the key, the
        // ride-up is the NEXT Esc. false (no pane / closed / a controller
        // without the method) → the shipped ride-up, unchanged.
        // Paused: Esc resumes FIRST (the overlay says "RESUME [ESC]"), before any ride-up. Pausing itself is
        // Esc with the ladder off, or the touch pause button (togglePause) with it on.
        if (isGameplay && d.getPaused()) {
          this.togglePause();
          e.preventDefault();
          return;
        }
        const escLadder = this._ladderIfEngaged();
        if (escLadder) {
          if (typeof escLadder.closeTopPane === 'function' && escLadder.closeTopPane()) {
            e.preventDefault();
            return;
          }
          // H2 (owner 2026-10-09): piloting → the first Esc goes back to the
          // mother, the next one rides up. Like V, she keeps working (no recall).
          if (this.armPilotMode) {
            this._exitArmPilotCamera();
            d.armManager?.deselectArm();
            d.audioSystem?.playClick();
            e.preventDefault();
            return;
          }
          escLadder.command({ type: 'esc' });
          e.preventDefault();
          return;
        }
        if (currentState === GameStates.BRIEFING) {
          d.transitionToState(GameStates.MENU);
        } else if (currentState === GameStates.SHOP) {
          d.applyUpgrades();
          d.transitionToState(GameStates.ORBITAL_VIEW);
        } else if (currentState === GameStates.INTERACTION) {
          d.transitionToState(GameStates.ORBITAL_VIEW);
        } else if (currentState === GameStates.APPROACH) {
          d.transitionToState(GameStates.ORBITAL_VIEW);
        } else if (isGameplay) {
          // S2.1: ESC from INSPECTION → exit to ORBIT
          if (d.cameraSystem && d.cameraSystem.currentView === 'INSPECTION') {
            d.cameraSystem.exitInspection();
            break;
          }
          if (this.armPilotMode) {
            // ST-8.2.1: ESC from STATION_KEEP → recall arm (stay in ARM_PILOT)
            const escArm = d.cameraSystem?.getPilotedArm();
            if (escArm && escArm.state === Constants.ARM_STATES.STATION_KEEP) {
              escArm.recallFromStationKeep();
              return;  // Stay in ARM_PILOT mode but arm will transition to RETURNING
            }
            // ESC from arm pilot → return to mothership
            this._exitArmPilotCamera();
            if (d.armManager) d.armManager.deselectArm();
          } else {
            this.togglePause();
          }
        }
        break;
      }

      // P — pause / resume (owner 2026-10-22). The one key that pauses on every setup: with the zoom ladder on,
      // Esc rides up a floor and never pauses. Cmd/Ctrl/Alt+P stay the browser's. Works while piloting a daughter.
      // No guard above returns early while paused, so the same key resumes. A held key does not flicker it.
      case 'KeyP':
        if (isGameplay && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!e.repeat) this.togglePause();
          e.preventDefault();
        }
        break;

      // Camera view toggle (V key). Shift+V (strategic map) retired 2026-10-09.
      // 2026-07-23 audit: V in MOTHER mode cycles FLY ↔ LOOK AROUND (close
      // inspection engages by zooming in while in LOOK AROUND). V while PILOTING
      // a daughter = hop back to mother — camera AND input together, so we don't
      // strand the player in a hybrid state where the mother is on screen but the
      // invisible daughter still steers (deliberate reinstatement of the "V
      // exits pilot" behavior). Unlike Esc (which recalls from STATION_KEEP), V
      // exits cleanly from any state without recalling — the daughter keeps
      // working ("spinning plates"). H1 2026-10-09: with the zoom ladder engaged
      // V on the MOTHER does nothing (the ladder camera ignores currentView, so
      // the flip changed only the indicator); V while piloting still hops back.
      case 'KeyV':
        if (e.shiftKey) break;   // Shift+V retired 2026-10-09
        if (isGameplay) {
          if (this.armPilotMode) {
            // Hop back to mother: exit pilot camera + deselect, no recall.
            this._exitArmPilotCamera();
            d.armManager?.deselectArm();
            d.audioSystem?.playClick();
          } else if (d.cameraSystem && !this._ladderIfEngaged()) {
            const lockedId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
            d.cameraSystem.cycleView(lockedId);
            d.audioSystem.playClick();
          }
        }
        break;

      // O key — AFT FLOWER deploy/stow toggle (P2 thermal arc; assignment
      // ratified by the P1 ledger §4). Was FREED by the 2026-06-14 hotkey
      // revamp (NavSphere moved to 8). ROSA-furl input idiom: guard on the
      // live method, decide from the live pose (mid-swing press reverses —
      // player intent wins), click + event + comms line. Silent no-op until a
      // flower pair is purchased (pre-purchase behavior byte-identical to the
      // freed key).
      // SAFETY OVERRIDE sweep (owner 2026-09-09: "when player presses override
      // button, and press "O" or clicks radiator button, they need to see how
      // radiator struts move, full range of motion"): while
      // deps.isOverrideEngaged() (the OVERRIDE panel's grid is up) the key runs
      // player.toggleFlowerOverride — FOLDED (LAUNCH θ 0) ↔ DEPLOYED (STOW 146),
      // the whole travel — the same path the pane's RADIATOR chip takes
      // (main.js `flowerSweep`). Dep absent / pane collapsed → the plain
      // closed ↔ 146° handler (toggleFlowerDeploy).
      case 'KeyO':
        if (isGameplay && !e.repeat && d.player
            && typeof d.player.toggleFlowerDeploy === 'function'
            && typeof d.player.getFlowerPairCount === 'function'
            && d.player.getFlowerPairCount() > 0) {
          const overrideEngaged = typeof d.isOverrideEngaged === 'function' && d.isOverrideEngaged() === true;
          if (overrideEngaged && typeof d.player.toggleFlowerOverride === 'function') {
            // The OVERRIDE sweep: null = no hardware (silent, still consumed).
            const sweeping = d.player.toggleFlowerOverride();
            if (sweeping !== null) {
              d.audioSystem?.playClick();
              eventBus.emit(Events.THERMAL_FLOWER_INPUT, { deploying: sweeping, override: true });
              eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'THERMAL',
                text: sweeping
                  ? 'OVERRIDE — aft radiator deploying: swinging out the whole way to 146°, side panels opening between 60° and 90°.'
                  : 'OVERRIDE — aft radiator folding: swinging all the way in to the closed rest (0°), side panels folding between 90° and 60°. Engines keep working.',
                priority: 'info',
                _reactive: true,
              });
            }
          } else {
            const deploying = d.player.toggleFlowerDeploy();
            // null = radiators held for the catch hand-off: the ship already said so, announce nothing.
            const held = deploying === null;
            if (!held) d.audioSystem?.playClick();
            if (!held) eventBus.emit(Events.THERMAL_FLOWER_INPUT, { deploying });
            // A double tap that PUSHED THROUGH (to 180°, or past CLOSED into
            // the launch fold) is narrated by the ship itself, and the plain
            // line would then be false ("…opening to 146°" while heading for
            // 180°, "Engines still work" while folding into the lock). The ship
            // sets its own `_flowerPushedThrough` on exactly that branch
            // (not "the tap timer is clear": that clears on every double tap, pushed or not).
            const pushedThrough = d.player._flowerPushedThrough === true;
            if (!pushedThrough && !held) {
              eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'THERMAL',
                text: deploying
                  ? 'Radiator opening to 146° — the struts open LIKE A FLOWER.'
                  : 'Radiator closing — folding flat along the hull. Engines still work.',
                priority: 'info',
                _reactive: true,
              });
            }
          }
          e.preventDefault();
        }
        break;

      // Open shop (B key during orbital)
      case 'KeyB':
        if (currentState === GameStates.ORBITAL_VIEW) {
          d.transitionToState(GameStates.SHOP);
        }
        break;

      // M key — retired 2026-10-09 (H1): it opened the Debris Map; LEO (floor 4)
      // shows the same. Bare M is unbound.

      // R key — Reel-in, consistent across BOTH mother and daughter modes
      // (2026-06-14 reel-in fix). The help pane labels R "Reel-in" in both
      // cards, so reeling ALWAYS takes priority — the old behavior where a
      // mother-mode R with autopilot engaged silently aborted the AP and
      // reeled NOTHING (the AP-abort branch sat ahead of the recall branch)
      // made R feel dead for the deployed daughter. Order now:
      //   (1) ARM_PILOT       → reel the piloted daughter home (any live state)
      //   (2) Mother + deployed → recall SELECTED daughter if eligible, else closest
      //   (3) Mother + nothing to reel BUT autopilot engaged → abort autopilot
      //   (4) Otherwise        → "nothing to reel" comms (never silent)
      // Shift+R = recall ALL deployed daughters (mother AND daughter mode);
      // it always reports a result so it is never silent. Shift check FIRST.
      case 'KeyR':
        if (isGameplay) {
          e.preventDefault();
          const am = d.armManager;
          // (0) Shift+R: recall all deployed daughters (both modes). Use the
          // count returned by recallAllDeployed() to always emit feedback —
          // the old fire-and-forget ARM_RECALL_ALL claimed success even when
          // nothing was deployed, which read as "did nothing".
          if (e.shiftKey) {
            if (!e.repeat) {
              d.audioSystem?.playClick();
              const n = (am && typeof am.recallAllDeployed === 'function')
                ? am.recallAllDeployed()
                : (eventBus.emit(Events.ARM_RECALL_ALL), null);
              if (n != null) {
                eventBus.emit(Events.COMMS_MESSAGE, {
                  source: 'SPACECRAFT', channel: 'CMD',
                  text: n > 0
                    ? `Reeling in all daughters (${n}).`
                    : (am && Array.isArray(am.arms) && am.arms.some((a) => a && a.state === Constants.ARM_STATES.REELING)
                      ? 'Every daughter that is out is already reeling home.'   // fail-reel F4: a reel in progress is not "none out"
                      : 'No deployed daughters to reel in.'),
                  priority: 'info',
                });
              }
            }
            break;
          }
          // (1) ARM_PILOT: reel the piloted daughter home — from ANY state.
          // recall() routes STATION_KEEP through reelFromStationKeep and sends
          // every other live state (TRANSIT / APPROACH / …) into a zero-fuel
          // REELING return on the mother's tether motor, so R always brings the
          // daughter you're flying back home (was SK-only — R did nothing
          // mid-flight, 2026-06-14 fix). One exception: since cargo-continuity
          // S1 (2026-08-11), HOLDING_CATCH is a player-facing REFUSAL, not a
          // REELING — the pilot session survives dock completion
          // (CameraSystem.js re-latches armPilot.arm), so that path is
          // reachable from here.
          if (this.armPilotMode) {
            const pilotArmR = d.cameraSystem?.getPilotedArm?.();
            if (pilotArmR && typeof pilotArmR.recall === 'function'
                && pilotArmR.state !== Constants.ARM_STATES.DOCKED
                && pilotArmR.state !== Constants.ARM_STATES.EXPENDED) {
              const res = pilotArmR.recall();
              d.audioSystem?.playClick();
              // fail-reel: R is never silent. recall() says why itself when it refuses (holding a catch, carrying,
              // detached); the one case it stays quiet is "already on her line" - say so here.
              if (res === 'already') {
                eventBus.emit(Events.COMMS_MESSAGE, {
                  source: 'SPACECRAFT', channel: 'CMD',
                  text: `${pilotArmR.displayName || 'Daughter'} is already reeling home.`,
                  priority: 'info',
                });
              }
            } else {
              d.audioSystem?.playClick();
              eventBus.emit(Events.COMMS_MESSAGE, {
                source: 'SPACECRAFT', channel: 'CMD',
                text: 'No daughter to reel in.',
                priority: 'info',
              });
            }
            break;
          }
          // (2) Mother mode: reel the SELECTED deployed daughter FIRST (falls
          // back to the closest when nothing eligible is selected). Reeling
          // is R's documented job, so it wins over the autopilot-abort even
          // when the AP is engaged (the AP keeps the mother on-station while
          // the daughter comes home; abort it explicitly with Esc).
          if (am && typeof am.recallClosestDeployed === 'function') {
            const recalled = am.recallClosestDeployed();
            if (recalled !== null && recalled !== undefined) {
              d.audioSystem?.playClick();
              eventBus.emit(Events.COMMS_MESSAGE, {
                source: 'SPACECRAFT', channel: 'CMD',
                text: `Reeling in Daughter ${recalled + 1}.`,
                priority: 'info',
              });
              break;
            }
          }
          // (3) Nothing to reel — fall back to aborting an engaged autopilot
          // (so R still has a sensible mother-mode action when no daughter is
          // out), otherwise emit the gentle "nothing to reel" hint.
          if (d.autopilotSystem && d.autopilotSystem.engaged) {
            // No dedicated AUTOPILOT_ABORT event — call disengage() directly
            // (same path as A-key toggle when AP is on).  See Events.js note.
            d.autopilotSystem.disengage('MANUAL_REEL');
            d.audioSystem?.playClick();
            break;
          }
          // (4) Nothing to reel and no AP to abort — never silent.
          d.audioSystem?.playClick();
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: 'SPACECRAFT', channel: 'CMD',
            text: 'No deployed daughters to reel in.',
            priority: 'info',
          });
        }
        break;

      // P / Shift+P — REMOVED (hotkey revamp 2026-06-14). The ARM PILOT toggle
      // and Shift+P arm-cycle were retired: daughters are now managed directly
      // with the number row (1-4 = select/pilot), and re-pressing the active
      // digit returns to the mother. armPilotMode is now entered only by
      // digit-selecting a DEPLOYED arm and by LAUNCH_CEREMONY_COMPLETE. P is
      // left unbound.

      // G key — Shift+G = Trawl sweep (toggle). Bare G is unbound.
      case 'KeyG':
        if (isGameplay && e.shiftKey) {
          eventBus.emit(Events.TRAWL_START);
          e.preventDefault();
        }
        break;

      // Y key — FREED (hotkey revamp 2026-06-14). EDT moved to the E key (its
      // menu label is "Electro Dynamic Tether"). Y is currently unbound.

      // E key — Electrodynamic Tether (EDT) toggle. Moved off Y by the
      // 2026-06-14 hotkey revamp so it matches the menu's Daughter-card label.
      case 'KeyE':
        if (isGameplay) {
          eventBus.emit(Events.EDT_DEPLOY);
          d.audioSystem.playClick();
          e.preventDefault();
        }
        break;

      // L key — CP-2 de-spin laser (hold L). Migrated from H by the
      // 2026-06-15 hotkey remap (laser H → L; Codex/Info L → I; H freed).
      // The continuous beam is driven by the held-key poll in processInput();
      // this keydown only gives a no-target affordance. Also live in ARM_PILOT
      // when the piloted arm is station-keeping a target (the SK readout advises
      // "de-spin [L]").
      // (Recall-all moved to Shift+R in the 2026-06-12 cleanup; this key never
      // touches recall.)
      case 'KeyL':
        if (isGameplay && !e.repeat && Constants.isFeatureEnabled('LASER_DESPIN')) {
          let despinTarget = null;
          if (this.armPilotMode) {
            despinTarget = this._getPilotedSkDespinTarget();
          } else {
            despinTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          }
          if (!despinTarget) {
            d.audioSystem?.playDeny?.();
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'MOTHER',
              text: this.armPilotMode
                ? 'De-spin laser: piloted daughter must be station-keeping a target.'
                : 'De-spin laser: select a tumbling target first.',
              channel: 'CMD', priority: 'warning',
            });
          }
          e.preventDefault();
        }
        break;

      // D key — Delegation 1 (2026-05-31) onboarding rebind, refined by the
      // 2026-06-14 hotkey revamp (pick-then-launch, D1):
      //   Bare D in orbital view → Deploy the SELECTED docked daughter
      //     (1-4 picks which; D launches it) + start the launch ceremony.
      //     Falls back to auto-pick (best docked arm) when no docked arm is
      //     selected, preserving the old one-press deploy.
      //   Shift+D      → Deploy ALL docked arms to the selected target.
      //   Hotkey revamp 2026-06-14: D / Shift+D work the same whether or not a
      //   daughter is being piloted (WASD daughter thrust was removed, so the
      //   key is no longer consumed for thrust).
      //   Ctrl+D       → debug overlay, DEV ONLY (Constants.DEBUG.DEBUG_OVERLAY_HOTKEY,
      //     flipped by ?debug=1). Off in production so Ctrl+D stays the
      //     browser's bookmark shortcut.
      //   Ctrl+Shift+D → deorbit sacrifice (unchanged)
      case 'KeyD':
        if (e.ctrlKey && e.shiftKey && isGameplay) {
          e.preventDefault();
          eventBus.emit(Events.ARM_DEORBIT_CMD);
        } else if (e.ctrlKey) {
          // Dev-only: when the flag is off we do NOTHING — no preventDefault,
          // so the browser's Ctrl+D (bookmark) works normally. The branch still
          // CLAIMS the combo either way, so Ctrl+D can never fall through to
          // the bare-D deploy path below.
          if (Constants.DEBUG.DEBUG_OVERLAY_HOTKEY) {
            e.preventDefault();
            if (d.debugOverlay) d.debugOverlay.toggle();
          }
        } else if (e.shiftKey && isGameplay && d.armManager && !e.repeat) {
          // Shift+D (interlocks-p2 Q1): one daughter per piece, best first. The picked piece goes first (or, with none
          // picked, the best free one); the other docked daughters take the next free pieces.
          const picked = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          const { first, more, ownedOnly } = this._fanOutPieces(picked, 'shift_d');
          if (!first && ownedOnly) {
            // F1: pieces exist but every one has an owner: send nobody (the free-fly send below would put daughters out
            // with no piece) and say the same line Shift+N says.
            this._sayFanOutNone();
            d.audioSystem?.playDeny?.();
          } else {
            d.armManager.deployAllToTarget(first, more);
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        } else if (isGameplay && !e.repeat) {
          // D1 (pick-then-launch): if a DOCKED daughter is selected with 1-4,
          // launch THAT one by index; otherwise fall back to the auto-pick
          // deploy path (GameFlowManager.deployArm picks the best docked arm).
          const am = d.armManager;
          const selIdx = am ? am.selectedArmIndex : -1;
          const selArm = (am && selIdx >= 0) ? am.arms[selIdx] : null;
          const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          let deployedOk = false;
          let launchedByIndex = false;
          const dockedBefore = this._dockedArms(am);
          if (selArm && selArm.state === Constants.ARM_STATES.DOCKED) {
            // deployArmByIndex + arm.deploy/deployFreefly already emit a specific
            // refusal comms on every reachable failure (spring/fuel/power/
            // safe-mode/mass); the only silent path (not-DOCKED) is guarded
            // above, so no extra backstop is needed here.
            deployedOk = am.deployArmByIndex(selIdx, target, { announce: true });
            launchedByIndex = true;
          } else {
            // interlocks-p2: a piece that already has an owner, or every free strut crossing a line already out, is
            // refused here in one line (the auto-pick below would say the same, then add a generic second line).
            const refusal = (am && target && typeof am.interlockRefusal === 'function') ? am.interlockRefusal(target) : null;
            if (refusal) {
              eventBus.emit(Events.COMMS_MESSAGE, { text: refusal.text, priority: 'warning' });
              d.audioSystem?.playDeny?.();
              e.preventDefault();
              break;
            }
            d.deployArm();   // auto-pick best docked arm (backstops its own refusals)
            deployedOk = true;
          }
          // Notify tutorial / discovery before the ceremony for ordering.
          eventBus.emit(Events.TUTORIAL_DEPLOY_INPUT);
          if (deployedOk && am) {
            // L2: a launch the keep-out gate is holding back (or the aim ceremony,
            // which emits its own LAUNCH_CEREMONY_START when it fires) leaves the
            // selected daughter DOCKED for now — announce only a launch that has
            // happened, and only for the daughter that was actually selected.
            // Auto-pick: only an arm that was docked at the press and is not now (a daughter already out,
            // or a launch still waiting, must not be announced: the waiting one announces itself when it fires).
            const deployed = launchedByIndex
              ? (selArm.state !== 'DOCKED' ? [selArm] : [])
              : dockedBefore.filter(a => a.state !== 'DOCKED');
            if (deployed.length > 0) {
              const arm = deployed[deployed.length - 1];
              // launch-seq: no "deployed. Tracking…" line — the one launch line is "Spring released.
              // Separating" (ArmUnit, at ARM_SPRING_FIRED); only the cut-scene start is announced here.
              // u20-ipad F2: the auto-picked daughter is the selected one (the by-index launch already is), so the zoom
              // ladder's stand-down (no COMPLETE event ever comes) leaves her selected too.
              if (!launchedByIndex) this._selectLaunched(arm);
              eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
            } else if (!launchedByIndex && typeof am.isLaunchPending === 'function') {
              // Her launch waits for the mother's turn (or her strut's swing): she is the picked one too, as by index.
              const waiting = dockedBefore.find(a => am.isLaunchPending(a.index));
              if (waiting) this._selectLaunched(waiting);
            }
          }
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // A key: Shift+A = "go salvage the field" combo; plain A = autopilot
      // toggle. Hotkey revamp 2026-06-14: works in both mother and daughter
      // modes (WASD thrust removed).
      case 'KeyA':
        if (isGameplay && !e.repeat) {
          if (e.shiftKey) {
            // Shift+A (2026-06-14 high-risk-salvage rework): one press to
            //   (1) autopilot the MOTHER to the field center (densest/highest-
            //       value cluster),
            //   (2) fire the MOTHER NET at the best in-range debris that is NOT
            //       one of the daughters' targets, and
            //   (3) fan EVERY docked daughter out to a DISTINCT debris.
            this._fieldCenterSalvage();
            d.audioSystem?.playClick();
          } else if (d.autopilotSystem) {
            d.autopilotSystem.toggle();
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        }
        break;

      // S key: Quick Scan (bare S) / Wide Scan "scan big area" (Shift+S).
      // Hotkey revamp 2026-06-14: wide scan moved off bare W → Shift+S; both
      // work in mother and daughter modes (WASD thrust removed).
      case 'KeyS':
        if (isGameplay && !e.repeat) {
          if (e.shiftKey) {
            eventBus.emit(Events.SCAN_WIDE);
          } else {
            eventBus.emit(Events.SCAN_QUICK);
          }
          eventBus.emit(Events.TUTORIAL_SCAN_INPUT);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // W key — FREED (hotkey revamp 2026-06-14). Wide scan moved to Shift+S
      // and daughter WASD thrust was removed, so bare W is unbound.

      // F key — the furnace joke (H1 2026-10-09, owner: the old forge "doesn't
      // really work"). FORGE_TOGGLE is still emitted so the journal skill and
      // chapter beat that trigger on it stay reachable (the old forge module is
      // gone, nothing subscribes); then the F1-bar FURNACE gag runs. Both mother and daughter.
      case 'KeyF':
        if (isGameplay && !e.repeat) {
          eventBus.emit(Events.FORGE_TOGGLE);
          d.pressFurnace?.();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // C key — FREED (hotkey cleanup 2026-06-16). Bare C used to duplicate the
      // 7 key's comms expand (both emitted COMMS_FOCUS + COMMS_OPENED), so the
      // redundant binding was removed: 7 is the single comms key now. C is left
      // unbound/available (joining the already-free W, Y, O). Note: ',' is NOT
      // free — Comma is the ROSA furl/unfurl toggle (see the 'Comma' case).
      // Shift+C city-labels moved to 5 in the 2026-06-14 revamp and is also free.

      // ST-5.1: PageUp / PageDown — comms history scrolling.
      // Zoom Ladder (00-spec §5): PgUp/PgDn = ride one floor up/down, so the
      // engaged ladder claims both keys BEFORE the legacy comms scroll (the
      // debris-map intercept deliberately lets these two keys fall through to
      // here, so the engaged ladder also wins over the map's comms use — the
      // ladder is the primary navigation instrument while it is engaged).
      // Flag-off (never engaged) leaves the comms scroll byte-identical.
      case 'PageUp': {
        const puLadder = this._ladderIfEngaged();
        if (puLadder) {
          puLadder.command({ type: 'pageUp' });
          e.preventDefault();
          return;
        }
        if (isGameplay) {
          eventBus.emit(Events.COMMS_SCROLL_UP);
          e.preventDefault();
        }
        break;
      }
      case 'PageDown': {
        const pdLadder = this._ladderIfEngaged();
        if (pdLadder) {
          pdLadder.command({ type: 'pageDown' });
          e.preventDefault();
          return;
        }
        if (isGameplay) {
          eventBus.emit(Events.COMMS_SCROLL_DOWN);
          e.preventDefault();
        }
        break;
      }

      // N key — net/capture verb (hotkey cleanup 2026-06-13) + Shift+N
      // "Auto-target + launch at debris in range" (hotkey revamp 2026-06-14):
      //   Shift+N        → auto-acquire the best in-range debris target, then
      //     deploy ALL docked daughters at it.
      //   ARM_PILOT mode → Deploy net / capture (multi-tool dispatch in SK).
      //   Mother mode    → Lasso / Net fire.
      case 'KeyN':
        if (!isGameplay) break;
        if (e.shiftKey) {
          // Shift+N: auto-acquire nearest/best in-range target, launch all.
          e.preventDefault();
          this._autoTargetAndLaunch();
          d.audioSystem?.playClick();
          break;
        }
        // (0) A daughter already HOLDING the active target (station-keeping on it): N works her tool with no pilot
        // mode — the daughter-in-position line promises "Press N" (DECISIONS §33 row 6, 2026-10-20). Pilot mode
        // keeps working as before (the branch below); this one never fires the mother's nets.
        // (While piloting a daughter, the pilot-mode branch below owns N, exactly as before.)
        if (!(this.armPilotMode && d.cameraSystem)) {
          const holder = this.findHoldingDaughter();
          if (holder) {
            e.preventDefault();
            this.captureWithDaughter(holder);
            break;
          }
        }
        if (this.armPilotMode && d.cameraSystem) {
          // (1) DAUGHTER net/capture — the single capture verb (hotkey cleanup
          // 2026-06-13: F's old SK dispatch + TRANSIT net roles folded into N).
          e.preventDefault();
          this.captureWithPilotedArm();
          break;
        }
        // (2) MOTHER lasso fire. The Space alias was removed in the 2026-06-13
        // hotkey cleanup — N is the single lasso/net fire verb. Delegated to
        // fireLasso() (single implementation, also used by the onboarding
        // smart-default) so windup/fire tuning can't drift between paths.
        if (d.lassoSystem) {
          e.preventDefault();
          this.fireLasso();
        }
        break;

      // J key — Journal / Skills (Discoveries) toggle.  Delegation 1
      // (2026-05-31) onboarding rebind: SkillsPane previously listened on
      // bare K via its own document-level handler; that listener now keys
      // on KeyJ (see SkillsPane._onKeyDown).  This case exists so InputManager
      // explicitly claims J for the journal so the rebind is discoverable
      // when grepping for "case 'Key" mappings.  The actual toggle is owned
      // by SkillsPane.toggleExpanded() — we leave the no-op here as a marker.
      case 'KeyJ':
        // Toggle handled by SkillsPane._onKeyDown (document listener).
        break;

      // K: jettison the berthed mother catch (mother-net-reel plan §4.10).
      // Verified free in gameplay: no other case 'KeyK' and no module-level
      // KeyK listener anywhere in js/. The abort path for a slipped, dead or
      // mis-berthed catch — and for a player who wants the launcher back
      // before the securing timer commits the catch for score.
      case 'KeyK':
        if (isGameplay && !e.repeat && d.captureNetSystem
            && typeof d.captureNetSystem.releaseDockedCatch === 'function') {
          if (d.captureNetSystem.releaseDockedCatch()) {
            d.audioSystem?.playClick?.();
          }
          e.preventDefault();
        }
        break;

      // U: choose what to do with a big catch (Nets step 3 slice 5, lane 5c; plan C6). Opens (and closes) the fate list, the panel of
      // ui/FateList.js, only with a big piece aboard on floors 2-4 (the list decides: `toggleFromKey`); with nothing to choose for the key
      // does nothing. The list's own arrows / Enter / Esc are taken by its capture listener, not here.
      case 'KeyU':
        if (isGameplay && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const fateList = typeof d.getFateList === 'function' ? d.getFateList() : null;
          if (fateList && typeof fateList.toggleFromKey === 'function' && fateList.toggleFromKey()) {
            d.audioSystem?.playClick?.();
            e.preventDefault();
          }
        }
        break;

      // Comma (,): ROSA panel furl/unfurl toggle (mirrors "." struts). Rolls the
      // solar arrays up to dodge debris / tether strikes (at a power cost), or
      // unfurls them again. Shift+Comma feathers instead: parks the wings edge-on
      // (faster than a full furl, wings stay deployed) to dodge a hazard. (Debris
      // Map "previous" is handled by the map-open early-intercept near the top of
      // _handleKeyDown, which returns before this switch — so this case only runs
      // during normal gameplay.)
      case 'Comma':
        if (isGameplay && !e.repeat && d.player && e.shiftKey
            && typeof d.player.toggleRosaFeather === 'function') {
          const feathered = d.player.toggleRosaFeather();
          d.audioSystem?.playClick();
          eventBus.emit(Events.ROSA_FEATHER_INPUT, { feathered });
          e.preventDefault();
        } else if (isGameplay && !e.repeat && d.player
            && typeof d.player.toggleRosaFurl === 'function') {
          const target = d.player.toggleRosaFurl();
          d.audioSystem?.playClick();
          eventBus.emit(Events.ROSA_FURL_INPUT, { target });
          e.preventDefault();
        }
        break;
      // Period (.): "Struts" toggle (hotkey revamp 2026-06-14) — one key now
      // stows/deploys all docked struts (was Comma=stow / Period=deploy). Drives
      // Debris Map "next" while the map is open.
      case 'Period':
        if (isGameplay && d.debrisMap && d.debrisMap.isVisible()) {
          d.debrisMap.selectNext();
          e.preventDefault();
        } else if (isGameplay && d.armManager) {
          // ONE copy of the strut law. This case used to duplicate
          // ArmManager.toggleStruts()'s latch/guard inline, which is exactly
          // the shape that rots. Delegate; the angles (one press 34°, a quick
          // second press 90°, the next press 0°) and the double-tap timer
          // (STRUT_PUSH_WINDOW_MS) live there.
          // With a daughter selected (1-4) and docked, "." moves only her strut; with no
          // selection (or she is away) it moves every docked arm.
          const selStrutIdx = d.armManager.selectedArmIndex;
          d.armManager.toggleStruts(selStrutIdx >= 0 ? selStrutIdx : undefined);
          d.audioSystem?.playClick();
          // hold-catch: a press that moves nothing says why (a holding daughter's strut never goes below her hold pose)
          if (d.armManager.lastStrutPressNote) {
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'SPACECRAFT', channel: 'CMD',
              text: d.armManager.lastStrutPressNote,
              priority: 'info',
            });
          }
          // Delegation 2 onboarding (2026-05-31): notify the OnboardingDirector.
          eventBus.emit(Events.STRUT_DEPLOY_INPUT);
          e.preventDefault();
        }
        break;

      // C key — "Move a catch to a radiator" (hold-catch, owner 2026-10-22: "Transfer to radiator strut is risky, should be an
      // option when all daughters are full, not automatic"). Bare C only (Shift/Ctrl/Alt/Meta+C stay unbound). It starts ONE
      // hand-off through ArmManager.moveCatchToRadiator, which says in one comms line why when it does nothing (a daughter is
      // free, a hand-off runs, the trip does it by itself). Comms expand stays on the 7 key.
      case 'KeyC':
        if (isGameplay && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
            && d.armManager && typeof d.armManager.moveCatchToRadiator === 'function') {
          d.armManager.moveCatchToRadiator(d.armManager.selectedArmIndex);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // T key — "Target debris" (hotkey revamp 2026-06-14): cycle the active
      // debris target (same as the Tab alias) in BOTH mother and daughter
      // modes. The old "cycle capture tool" role lost its key (not in the help
      // menu — the tool system still auto-recommends).
      case 'KeyT':
        if (isGameplay && !e.repeat) {
          this._cycleTarget();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // F5 removed (UX-11 #8, 2026-06-11): FEEP fuel cycle now lives on Digit6
      // (number row, next to the Forge on 5). No alias retained.

      // Space — "do the next thing" rapid-advance (2026-06-15).
      // Onboarding still owns Space FIRST: while a beat is live the
      // OnboardingDirector smart-default dispatches that beat's primary key.
      // When it declines (post-onboarding, or no live beat), Space synthesizes
      // the next step of the core loop — Scan → Target → Autopilot →
      // Daughter launch → Capture — one step per press, so anyone can mash
      // Space to rip through a full capture cycle (daughter-first, net fallback).
      case 'Space': {
        // Zoom Ladder (00-spec §5): Space = the per-floor verb (F3 lens toggle,
        // F4 approach-autopilot, F5 approach, F6 plan transfer, F7 flip lens).
        // The engaged ladder claims Space BEFORE the legacy resolver below —
        // note the launch/net ceremony Space-skips (top-level intercepts) still
        // return before this, keeping their takeover-cancel priority. Flag-off
        // (never engaged) leaves the legacy chain byte-identical.
        const spaceLadder = this._ladderIfEngaged();
        if (spaceLadder) {
          spaceLadder.command({ type: 'space' });
          e.preventDefault();
          return;
        }
        if (!isGameplay) break;
        // Restrict to the loop-relevant states (launch-ceremony Space-skip is
        // handled earlier and returns before this switch).
        const spaceAllowed =
          currentState === GameStates.ORBITAL_VIEW ||
          currentState === GameStates.APPROACH ||
          this.armPilotMode;
        if (!spaceAllowed) break;

        // (1) Onboarding smart-default gets first crack.
        if (d.onboardingDirector && typeof d.onboardingDirector.pressActiveHint === 'function'
            && d.onboardingDirector.pressActiveHint(this)) {
          e.preventDefault();
          break;
        }

        // (2) Otherwise advance the dev sequence.
        const action = resolveNextDevAction(this._buildDevSnapshot());
        if (action) {
          this._dispatchDevAction(action);
          e.preventDefault();
        }
        break;
      }

      // (Ctrl+D debug overlay merged into KeyD case above — Phase 1A)

      // X key — TETHER DETACH (Phase 6 — Risk-Reward)
      case 'KeyX':
        if (isGameplay && d.armManager) {
          const detachCandidate = d.armManager.getActiveDetachCandidate();
          if (detachCandidate) {
            d.armManager.detachArm(detachCandidate.index);
            d.audioSystem.playClick();
          } else {
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: 'No daughter available for detach.',
              priority: 'warning',
            });
          }
        }
        break;

      // ST-8.3.6: F2 — Cycle FEEP metal on piloted arm
      case 'F2':
        if (isGameplay && this.armPilotMode && d.cameraSystem) {
          e.preventDefault();
          const feepArm = d.cameraSystem.getPilotedArm();
          if (feepArm) {
            const currentMetal = feepArm._currentMetal;
            const altMetal = feepArm._alternateMetal;
            if (altMetal && altMetal !== currentMetal) {
              feepArm.switchMetal(altMetal);
              d.audioSystem?.playClick();
            } else if (altMetal && altMetal === currentMetal && feepArm._currentMetal !== 'indium') {
              feepArm.switchMetal('indium');
              d.audioSystem?.playClick();
            }
          }
        }
        break;

      // Cycle wireframe analysis zones (Z / Shift+Z)
      case 'KeyZ':
        // h4b D2: Z is the game's analyse action — it opens target info in simple mode. Cmd/Ctrl+Z
        // (undo) is not analyse; text fields and menus never get here (the guards above).
        if (isGameplay && !e.metaKey && !e.ctrlKey && d.hud && typeof d.hud.noteAnalyse === 'function') d.hud.noteAnalyse();
        if (isGameplay && d.debrisWireframe) {
          if (e.shiftKey) {
            d.debrisWireframe.cycleZone(-1);
          } else {
            d.debrisWireframe.cycleZone(+1);
          }
          d.audioSystem.playClick();
        }
        break;

      // --- Arm selection (1-6) / Power Distribution (Shift+1-3) (Sprint C2) ---
      case 'Digit1':
        if (isGameplay) {
          if (e.shiftKey) {
            powerDistribution.selectBus(PowerBuses.THRUST);
          } else {
            this._handleArmKey(0);
          }
          d.audioSystem.playClick();
        }
        break;
      case 'Digit2':
        if (isGameplay) {
          if (e.shiftKey) {
            powerDistribution.selectBus(PowerBuses.SENSORS);
          } else {
            this._handleArmKey(1);
          }
          d.audioSystem.playClick();
        }
        break;
      case 'Digit3':
        if (isGameplay) {
          if (e.shiftKey) {
            powerDistribution.selectBus(PowerBuses.ARMS);
          } else {
            this._handleArmKey(2);
          }
          d.audioSystem.playClick();
        }
        break;
      case 'Digit4':
        if (isGameplay) {
          this._handleArmKey(3);
          d.audioSystem.playClick();
        }
        break;
      // Number-row toggles (hotkey revamp 2026-06-14) — the help menu's
      // Advanced card defines 5-0 as display toggles:
      //   5 City names · 6 Constellation names · 7 Comms · 8 NavSphere ·
      //   9 Debris pane · 0 Target pane.
      // (Forge moved to F, FEEP fuel cycle lost its key, NavSphere moved off O.)
      case 'Digit5':
        if (isGameplay && !e.repeat) {
          eventBus.emit(Events.CITY_LABELS_TOGGLE);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit6':
        if (isGameplay && !e.repeat && d.starfield && typeof d.starfield.toggleConstellations === 'function') {
          const on = d.starfield.toggleConstellations();
          // Session O (plan D11, owner 2026-09-07): remember the player's
          // 6-key choice in settings — rides the existing sc_settings_v1 blob
          // (no new storage key); no event is emitted (nothing listens). The
          // very first frame ships OFF by default; this only records an
          // explicit preference.
          settingsManager.setConstellations(on);
          // Reactive feedback (the player just pressed 6). Starfield is a
          // THREE object with no comms of its own, so InputManager narrates.
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: on ? 'Constellation names ON (6 to hide)' : 'Constellation names OFF (6 to show)',
            priority: 'info',
            _reactive: true,
          });
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit7':
        if (isGameplay) {
          eventBus.emit(Events.COMMS_FOCUS);
          eventBus.emit(Events.COMMS_OPENED);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit8':
        if (isGameplay && d.navSphere && typeof d.navSphere.toggleMinimized === 'function' && !e.repeat) {
          d.navSphere.toggleMinimized();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit9':
        if (isGameplay && d.debrisWireframe && typeof d.debrisWireframe.toggleMinimized === 'function' && !e.repeat) {
          d.debrisWireframe.toggleMinimized();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit0':
        if (isGameplay && d.hud && d.hud.targetPanel
            && typeof d.hud.targetPanel.toggleVisible === 'function' && !e.repeat) {
          d.hud.targetPanel.toggleVisible();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // --- Power Distribution: Adjust selected bus ---
      case 'BracketLeft':
        if (isGameplay) {
          powerDistribution.decreaseSelected();
          d.audioSystem.playClick();
        }
        break;
      case 'BracketRight':
        if (isGameplay) {
          powerDistribution.increaseSelected();
          d.audioSystem.playClick();
        }
        break;

      // --- Crossbow launch-speed dial (register item 100): `;` down / `'` up.
      //     Fleet-wide on the existing ArmManager API; the arm clamps to its
      //     spring tier's ceiling, so the default 10 m/s never overruns T1/T2.
      //     Repeat allowed (hold to sweep). Feedback rides LAUNCH_SPEED_CHANGED
      //     → the arms-panel header (the power-bus pattern: click + HUD, no
      //     comms spam). ---
      case 'Semicolon':
        if (isGameplay && d.armManager) {
          const am = d.armManager;
          am.setFleetLaunchSpeed(am.getFleetLaunchSpeed() - Constants.CROSSBOW_SPEED_STEP);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Quote':
        if (isGameplay && d.armManager) {
          const am = d.armManager;
          am.setFleetLaunchSpeed(am.getFleetLaunchSpeed() + Constants.CROSSBOW_SPEED_STEP);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // --- Pane density (bare +/-) · Mother throttle (Shift + +/-) ---
      // Hotkey pass (pane-priority ladder): bare +/- now drive the HUD pane
      // density ladder (hide/show panes one rung at a time). The Mother
      // throttle ±10% verb moved to Shift+=/Shift+-. The STATION_KEEP
      // standoff-distance reuse of bare +/- (while piloting a station-keeping
      // daughter) is preserved via the carve-out below; the held-key radius
      // loop lives in processInput.
      case 'Equal':      // + key (=/+ on US keyboards)
      case 'NumpadAdd':   // Numpad +
        if (isGameplay) {
          // Browser zoom (Cmd/Ctrl + =) belongs to the browser — bail BEFORE
          // the STATION_KEEP carve-out so no modifier combo is swallowed.
          // Clear the just-set held-key flag too: _handleKeyDown sets
          // keys[e.code] unconditionally at the top, and the continuous
          // STATION_KEEP radius poll in processInput reads raw held-key
          // state — without this clear it would emit ARM_ORBIT_ADJUST every
          // frame while the modifier is held (review should-fix #1).
          if (e.metaKey || e.ctrlKey) { this.keys[e.code] = false; break; }
          // ST-8.2.1: +/- reused for orbital radius in STATION_KEEP (carve-out
          // FIRST so piloting a station-keeping daughter is unchanged).
          const _skPlus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skPlus && _skPlus.state === Constants.ARM_STATES.STATION_KEEP) break;
          if (e.shiftKey) {
            // Mother throttle +10% (keeps the TUTORIAL/ZOOM aliases so the
            // onboarding camera-zoom + throttle beats still accept a keyboard).
            if (d.player) {
              const newUp = Math.min(1.0, d.player.throttleLevel + 0.1);
              d.player.setThrottleLevel(Math.round(newUp * 10) / 10);
              eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
              eventBus.emit(Events.CAMERA_ZOOM_INPUT);
            }
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (!e.repeat) {
            // Pane density: restore the highest-priority hidden pane.
            eventBus.emit(Events.HUD_DENSITY_UP);
            d.audioSystem?.playClick();
            e.preventDefault();
          }
        }
        break;
      case 'Minus':       // - key
      case 'NumpadSubtract': // Numpad -
        if (isGameplay) {
          // Browser zoom (Cmd/Ctrl + -) belongs to the browser — see the
          // Equal case above for why the bail also clears the held-key flag.
          if (e.metaKey || e.ctrlKey) { this.keys[e.code] = false; break; }
          // ST-8.2.1: +/- reused for orbital radius in STATION_KEEP
          const _skMinus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skMinus && _skMinus.state === Constants.ARM_STATES.STATION_KEEP) break;
          if (e.shiftKey) {
            // Mother throttle -10% (see Equal case above).
            if (d.player) {
              const newDown = Math.max(0.0, d.player.throttleLevel - 0.1);
              d.player.setThrottleLevel(Math.round(newDown * 10) / 10);
              eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
              eventBus.emit(Events.CAMERA_ZOOM_INPUT);
            }
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (!e.repeat) {
            // Pane density: hide the lowest-priority visible pane.
            eventBus.emit(Events.HUD_DENSITY_DOWN);
            d.audioSystem?.playClick();
            e.preventDefault();
          }
        }
        break;

      // --- Backtick: in ARM_PILOT STATION_KEEP it cycles the piloted arm's
      //     tool. The Debris-Map toggle was retired 2026-10-09 (H1); otherwise
      //     the key does nothing. The old Shift+` mother-side tool cycle was
      //     removed (hotkey cleanup 2026-06-13b) — that verb now lives on T. ---
      case 'Backquote':
        if (isGameplay && !e.repeat) {
          // CP-1 / P2: plain backtick in STATION_KEEP cycles the piloted arm's
          // tool (NET → … → MAGNET).
          const tcArm = this.armPilotMode && d.cameraSystem?.getPilotedArm?.();
          if (tcArm && tcArm.state === Constants.ARM_STATES.STATION_KEEP
              && Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')
              && typeof tcArm.cycleTool === 'function') {
            tcArm.cycleTool();
            e.preventDefault();
            break;
          }
        }
        break;

      // --- F17: Toggle Codex Library / Info (I key) ---
      // Phase 3: the Tech Library opens from ANY screen (menu, paused, win,
      // gameplay) — it's reference material, not a gameplay-only HUD. The
      // open-codex intercept above (lines ~438) already handles I/ESC while
      // open regardless of game state, so this only needs to drop isGameplay.
      case 'KeyI':
        if (d.codexViewerUI) {
          d.codexViewerUI.toggle();
          d.audioSystem?.playClick();
          // Skills discovery: emit CODEX_OPENED on OPEN only. toggle() also
          // closes; firing unconditionally mis-triggered TeachingSystem's
          // first_codex (and skills discovery) on close.
          if (typeof d.codexViewerUI.isVisible !== 'function' || d.codexViewerUI.isVisible()) {
            eventBus.emit(Events.CODEX_OPENED);
          }
          e.preventDefault();
        }
        break;

      // --- ? (Slash) — Toggle the grouped keyboard-shortcut reference overlay.
      //     Backquote (~) is already the Debris Map toggle, so the help list
      //     uses the conventional "?" key instead.
      //     Like the Codex (KeyI above), the shortcut list opens from ANY screen
      //     (menu, briefing, shop, paused, win, gameplay) — it's reference
      //     material, not a gameplay-only HUD, and a player on the menu asking
      //     "what are the controls?" is exactly the case to answer. The
      //     open-overlay intercept above (lines ~431) already handles ?/ESC while
      //     it's open regardless of game state, so this only needs to drop
      //     isGameplay. ---
      case 'Slash':
        if (d.hotkeyOverlay && !e.repeat) {
          d.hotkeyOverlay.toggle();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
    }
  }

  /**
   * Handle keyup events.
   * @param {KeyboardEvent} e
   */
  _handleKeyUp(e) {
    this.keys[e.code] = false;
    // No per-key keyup handling needed — the bare-C comms tap was removed in
    // the 2026-06-16 cleanup (7 is the single comms key) and the older C
    // tap/hold radial menu was retired earlier (UX-11 #9).
  }

  // ==========================================================================
  // ARM KEY HELPERS (Phase 1B)
  // ==========================================================================

  /**
   * Cycle the active debris target (TPI-sorted). Shared by the `Tab` legacy
   * alias and the `T` "Target debris" verb (hotkey revamp 2026-06-14). Mirrors
   * the HUD's enhanced target list so keyboard + HUD selection stay in lockstep.
   * @private
   */
  _cycleTarget() {
    const d = this._deps;
    try {
      // FIX_PLAN §4: Use same target list as HUD (sorted upstream by TPI)
      this.nearbyTargets = d.debrisField.getEnhancedTargetList(
        d.player.getPosition(), d.player.getOrbitalElements()
      );
      // Filter: only tracked debris unless IR Scanner is active
      const canDetect = d.sensorSystem && d.sensorSystem.canDetectUntracked;
      this.nearbyTargets = this.nearbyTargets.filter(t => t.tracked !== false || canDetect);
      if (this.nearbyTargets.length > 0) {
        this.targetIndex = (this.targetIndex + 1) % this.nearbyTargets.length;
        const t = this.nearbyTargets[this.targetIndex];
        const debris = d.debrisField.getDebrisById(t.id);
        if (debris) {
          d.targetSelector.setTarget(debris, { distanceKm: t.distanceKm, deltaV: t.deltaV });
          if (d.debrisWireframe) d.debrisWireframe.setTarget(debris);
          d.hud.setSelectedTarget(t.id);
          if (d.targetReticle) d.targetReticle.setSelectedTarget(t.id);
          if (d.navSphere) d.navSphere.setSelectedTarget(t.id);
        }
      }
    } catch (err) {
      console.error('[target-cycle] error:', err);
    }
    // Notify tutorial of target-cycle press (legacy event name)
    eventBus.emit(Events.TUTORIAL_TAB_INPUT);
  }

  /**
   * The pieces a one-per-piece send (Shift+D, Shift+N) hands the daughters, best first: `picked` (the player's pick) leads;
   * the rest are the eligible pieces (the pane's TPI-sorted, tracked/IR-filtered list) that nobody owns yet. With no pick,
   * the best free piece becomes the pick (selected, so the HUD agrees). interlocks-p2 Q1.
   * @param {object|null} picked the active target, or null
   * @param {string} source tag for the acquire (tracing only)
   * @returns {{first: (object|null), more: object[], ownedOnly: boolean}} `ownedOnly`: pieces exist but every one has an owner
   * @private
   */
  _fanOutPieces(picked, source) {
    const d = this._deps;
    const ta = d.targetAcquisition;
    const out = { first: picked || null, more: [], ownedOnly: false };
    let eligible = null;
    try {
      if (ta && typeof ta.getEligibleTargets === 'function') eligible = ta.getEligibleTargets();
    } catch (err) {
      console.error('[fan-out] eligible list error:', err);
    }
    if (!Array.isArray(eligible)) {
      // No pane helper (older mocks): the pick alone, or the legacy single acquire.
      if (!picked && ta && typeof ta.acquireBestTarget === 'function') out.first = ta.acquireBestTarget({ source });
      return out;
    }
    const pieceOf = (t) => (d.debrisField && typeof d.debrisField.getDebrisById === 'function') ? d.debrisField.getDebrisById(t.id) : null;
    const free = eligible.filter((t) => {
      const debris = pieceOf(t);
      if (!debris) return false;
      const c = this._pieceClaim(debris);
      return !c || isFree(c);
    });
    if (!picked) {
      out.ownedOnly = eligible.length > 0 && free.length === 0;
      if (free.length > 0 && ta && typeof ta.acquireBestTarget === 'function') {
        out.first = ta.acquireBestTarget({ source }, free);
      }
    }
    for (const t of free) {
      const debris = pieceOf(t);
      if (!debris || (out.first && (debris === out.first || debris.id === out.first.id))) continue;
      out.more.push(debris);
      if (out.more.length >= 8) break;
    }
    return out;
  }

  /**
   * Shift+N "Auto-target + launch at debris in range" (hotkey revamp 2026-06-14; interlocks-p2 Q1): acquire the best
   * in-range piece that nobody owns (top of the TPI-sorted HUD list, honoring the tracked/IR filter), make it the active
   * target, then send ONE daughter per piece, best first. Warns via comms when nothing is in range or no arms are available.
   * @private
   */
  _autoTargetAndLaunch() {
    const d = this._deps;
    let plan = { first: null, more: [], ownedOnly: false };
    try {
      // Unified acquire (top of the TPI-sorted, tracked/IR-filtered pane list),
      // so the pane highlight and the net target always agree.
      plan = this._fanOutPieces(null, 'shift_n');
    } catch (err) {
      console.error('[auto-target-launch] error:', err);
    }
    if (!plan.first) {
      if (plan.ownedOnly) this._sayFanOutNone();
      else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'SPACECRAFT', channel: 'CMD', text: 'No debris in range to auto-target.', priority: 'warning',
        });
      }
      return;
    }
    if (d.armManager && typeof d.armManager.deployAllToTarget === 'function') {
      d.armManager.deployAllToTarget(plan.first, plan.more);
    }
  }

  /** interlocks-p2 F1: Shift+D / Shift+N found pieces, but every one already has an owner: the one line, nobody sent. @private */
  _sayFanOutNone() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT', channel: 'CMD', text: fanOutNoneText(), priority: 'warning',
    });
  }

  /** interlocks-p2: who owns `piece` (the arm manager's answer, which sees daughters, nets and the lasso), or null. @private */
  _pieceClaim(piece, opts) {
    const am = this._deps && this._deps.armManager;
    return am && typeof am.pieceClaimOf === 'function' ? am.pieceClaimOf(piece, opts) : null;
  }

  /**
   * interlocks-p2 R1: N (the small net, the large net) at a piece a daughter is flying to or lining up a launch for, or a
   * net is already on its way to: say what to do instead and start nothing. A piece a daughter HOLDS is not refused here:
   * N works her tool before this is reached (findHoldingDaughter), and any other route to a held piece is refused like the rest.
   * @param {object|null} piece
   * @returns {boolean} true when refused
   * @private
   */
  _refuseNetAtOwnedPiece(piece) {
    if (!piece) return false;
    const claim = this._pieceClaim(piece);
    if (!claim || isFree(claim)) return false;
    const text = netRefusalLine(claim);
    if (!text) return false;
    eventBus.emit(Events.LASSO_DENIED, { reason: 'piece_owned' });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text, source: 'SYSTEM', channel: 'CMD', priority: 'warning', _lassoFeedback: true,
    });
    this._deps.audioSystem?.playDeny?.();
    return true;
  }

  /**
   * Shift+A "field-center salvage" combo (2026-06-14 high-risk-salvage rework).
   * One press maximizes quick salvage:
   *   1. Autopilot the MOTHER to the debris-field center (densest / highest-
   *      value cluster) via DebrisMap.engageBestCluster().
   *   2. Fan EVERY docked daughter out to a DISTINCT debris (best TPI-ranked,
   *      tracked/IR-filtered) via ArmManager.deployAllToDistinctTargets().
   *   3. Fire the MOTHER NET at a SEPARATE debris — the best in-range one that
   *      is NOT assigned to any daughter (user choice: net target is distinct
   *      from the fan-out). Falls through gracefully when nothing is in range
   *      or no daughters are available.
   * @private
   */
  _fieldCenterSalvage() {
    const d = this._deps;
    // interlocks-p2 F17: a newer Shift+A ends an older press's wait at once, before anything else. Whichever way this press goes (a refusal,
    // a daughters-only send that never reaches `_afterNetSettles`), the older press's daughters are never sent a second time.
    if (this._netWait) this._netWait.settle('drop');

    // Build the TPI-sorted, tracked/IR-filtered eligible debris list once, via
    // the unified helper so this shares the pane's exact eligibility rule.
    let eligible = [];
    try {
      if (d.targetAcquisition && typeof d.targetAcquisition.getEligibleTargets === 'function') {
        eligible = d.targetAcquisition.getEligibleTargets();
      } else {
        const list = d.debrisField.getEnhancedTargetList(
          d.player.getPosition(), d.player.getOrbitalElements()
        );
        const canDetect = d.sensorSystem && d.sensorSystem.canDetectUntracked;
        eligible = list.filter(t => t.tracked !== false || canDetect);
      }
    } catch (err) {
      console.error('[field-center-salvage] target list error:', err);
    }

    // interlocks-p2 R8: nothing is tracked yet (no scan): the daughters used to fly out with no piece and be reeled
    // straight back (measured S7b). Say what to do first and start nothing, not even the autopilot.
    if (!Array.isArray(eligible) || eligible.length === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD', text: SCAN_FIRST_LINE, priority: 'warning',
      });
      d.audioSystem?.playDeny?.();
      return;
    }

    // (1) Mother → field center. Prefer the "best cluster" helper; fall back to
    // the currently-selected cluster for older DebrisMap stubs.
    if (d.debrisMap) {
      if (typeof d.debrisMap.engageBestCluster === 'function') {
        d.debrisMap.engageBestCluster();
      } else if (typeof d.debrisMap.engageSelectedCluster === 'function') {
        d.debrisMap.engageSelectedCluster();
      }
    }

    // Count docked, spring-charged daughters so we can carve out distinct
    // targets for them and reserve a SEPARATE one for the mother net.
    const arms = (d.armManager && Array.isArray(d.armManager.arms)) ? d.armManager.arms : [];
    const dockedCount = arms.filter(a =>
      a && a.state === Constants.ARM_STATES.DOCKED && a.springCharged).length;

    // Resolve debris objects, best first, skipping any piece somebody already owns (a daughter, a net, a catch).
    const free = [];
    for (const t of eligible) {
      const debris = d.debrisField.getDebrisById(t.id);
      if (!debris) continue;
      const claim = this._pieceClaim(debris);
      if (claim && !isFree(claim)) continue;
      free.push(debris);
    }

    // (3) F9 (coordinator 2026-10-23): the NET takes the best free piece inside the reach of the net that would fire at it
    // (measured S7c: the daughters used to take the near pieces first and the net had nothing in reach); then the daughters take
    // the remaining free pieces, one each, best first. A daughter is never sent to the piece the net takes.
    let netTarget = null;
    for (const debris of free) {
      if (this._withinNetReach(debris)) { netTarget = debris; break; }
    }
    const daughterDebris = free.filter((x) => x !== netTarget).slice(0, dockedCount);

    // (2) Fan the daughters out to distinct debris. Surplus daughters (more daughters than debris) fall back to the
    // mother's active target, unless that is the piece the net will take.
    const sendDaughters = () => {
      if (d.armManager && typeof d.armManager.deployAllToDistinctTargets === 'function') {
        let fallback = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
        if (fallback && netTarget && fallback.id === netTarget.id) fallback = null;
        d.armManager.deployAllToDistinctTargets(daughterDebris, fallback);
      } else if (d.armManager && typeof d.armManager.deployAllToTarget === 'function') {
        // Legacy fallback: single-target deploy-all.
        d.armManager.deployAllToTarget(daughterDebris[0] || (d.targetSelector ? d.targetSelector.getActiveTarget() : null));
      }
    };

    // (3 cont.) The net goes FIRST (F10): make its piece the active target so fireLasso() casts at it, then fire. The ship's own
    // turn for the net happens before any daughter launches; they go once the ship has settled (their lines are judged
    // again at the spring). Ordering inside this key, not a new limit on the player.
    if (netTarget && d.lassoSystem) {
      if (d.targetSelector && typeof d.targetSelector.setTarget === 'function') {
        d.targetSelector.setTarget(netTarget);
        if (d.debrisWireframe) d.debrisWireframe.setTarget(netTarget);
        if (d.hud) d.hud.setSelectedTarget(netTarget.id);
        if (d.targetReticle) d.targetReticle.setSelectedTarget(netTarget.id);
        if (d.navSphere) d.navSphere.setSelectedTarget(netTarget.id);
      }
      this.fireLasso();
      this._afterNetSettles(sendDaughters);
      return;
    }
    sendDaughters();
    if (free.length > 0 && !netTarget) {
      // interlocks-p2 R8: pieces are left, all past what a net can reach: daughters only, and the line says so.
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD', text: DAUGHTERS_ONLY_LINE, priority: 'info',
      });
    } else if (!netTarget && daughterDebris.length === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD',
        text: free.length === 0 ? fanOutNoneText() : 'No debris in range. Closing on field center.',
        priority: 'warning',
      });
    }
  }

  /**
   * F10 / F14: run `send` (Shift+A's daughter launches) once the ship has settled after the net's own turn. Nothing to wait for
   * when the ship is not turning for the net and no lasso windup is pending (the net left at once, or was refused): `send`
   * runs now. Otherwise it runs, a tick later, when the net has left (NET_FIRED from the mother, LASSO_FIRED), was refused
   * (LASSO_DENIED), or the aim ended without it (AIM_SEQUENCE_END rejected; resolved -> a short grace for the net to leave),
   * and in any case after the aim's own time limit plus 3 s. Runs at most once, and:
   *   - the clock is GAME time (`_tickNetWait(dt)` from `processInput`, which does not run while paused), not the wall clock;
   *     when the limit is reached while the ship still turns for the net, the wait goes on in 3 s steps (twice at most);
   *   - GAME_RESET (a new game) cancels it: nothing is sent;
   *   - when the player's own steering ended the turn (the aim rejected after a MOTHER_MANUAL_ROTATE), the daughters stay
   *     docked and the line says how to send them;
   *   - the listeners are removed on every exit, in the tick after the decision (removing the manual-rotate listener inside
   *     the emit that is still walking its set would skip it).
   * @param {function(): void} send
   * @private
   */
  _afterNetSettles(send) {
    const d = this._deps || {};
    const ap = d.autopilotSystem;
    const turning = !!(ap && typeof ap.isAiming === 'function' && ap.isAiming());
    if (this._netWait) this._netWait.settle('drop');          // a new Shift+A: the older wait ends, its daughters are not sent twice
    if (!turning && !this._lassoWindingUp) { send(); return; }
    const wait = {
      elapsed: 0,                                                // game seconds since the wait began
      cap: ((Constants.AIM && Constants.AIM.AIM_TIMEOUT_S) || 30) + 3,
      extended: 0,
      graceAt: null,                                             // game second at which a resolved aim without a net lets them go
      done: false, rejected: false, steered: false, reason: null,   // reason: the text AIM_SEQUENCE_END carried when the turn was rejected
      settle: null,
    };
    const off = () => {
      eventBus.off(Events.NET_FIRED, onNet);
      eventBus.off(Events.LASSO_FIRED, onGo);
      eventBus.off(Events.LASSO_DENIED, onGo);
      eventBus.off(Events.AIM_SEQUENCE_END, onAim);
      eventBus.off(Events.MOTHER_MANUAL_ROTATE, onSteer);
      eventBus.off(Events.GAME_RESET, onReset);
      if (this._netWait === wait) this._netWait = null;
    };
    // `how`: 'send' | 'drop'. The steering check is made in the tick after, once every listener of this emit has run.
    wait.settle = (how) => {
      if (wait.done) return;
      wait.done = true;
      setTimeout(() => {                  // after the call that emitted this has unwound (the net is out, the turn is over)
        off();
        if (how === 'drop') return;
        // F19: the line is true only when the turn ended BECAUSE of the steering (the autopilot's 'Manual attitude input'); a turn
        // that ended for another reason after an arrow key (target changed, timeout) sends them as before.
        if (wait.rejected && wait.steered && wait.reason === MANUAL_AIM_REASON) this._sayDaughtersHeldBack();
        else send();
      }, 0);
    };
    const onNet = (e) => { if (e && e.source === 'mother') wait.settle('send'); };
    const onGo = () => wait.settle('send');
    const onSteer = () => { wait.steered = true; };
    const onReset = () => wait.settle('drop');
    const onAim = (e) => {
      if (e && e.mode !== 'net') return;
      if (e && e.result === 'rejected') { wait.rejected = true; wait.reason = e.reason === undefined ? null : e.reason; wait.settle('send'); return; }
      if (wait.graceAt === null) wait.graceAt = wait.elapsed + 1.5;
    };
    eventBus.on(Events.NET_FIRED, onNet);
    eventBus.on(Events.LASSO_FIRED, onGo);
    eventBus.on(Events.LASSO_DENIED, onGo);
    eventBus.on(Events.AIM_SEQUENCE_END, onAim);
    eventBus.on(Events.MOTHER_MANUAL_ROTATE, onSteer);
    eventBus.on(Events.GAME_RESET, onReset);
    this._netWait = wait;
  }

  /**
   * F14: the clock of `_afterNetSettles`, in game seconds. Called every frame from `processInput(dt)`, which the game loop
   * skips while paused, so paused time does not count.
   * @param {number} dt
   * @private
   */
  _tickNetWait(dt) {
    const w = this._netWait;
    if (!w || w.done || !(dt > 0)) return;
    w.elapsed += dt;
    if (w.graceAt !== null && w.elapsed >= w.graceAt) { w.settle('send'); return; }
    if (w.elapsed >= w.cap) {
      const ap = this._deps && this._deps.autopilotSystem;
      if (ap && typeof ap.isAiming === 'function' && ap.isAiming() && w.extended < 2) { w.extended++; w.cap += 3; return; }
      w.settle('send');
    }
  }

  /** F14: the player steered while the ship turned for the net: the daughters stay docked; how to send them. @private */
  _sayDaughtersHeldBack() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT', channel: 'CMD', priority: 'info',
      text: daughtersHeldBackLine(),   // F16: Shift+A on a keyboard; a row in DAUGHTERS + the SEND DAUGHTER chip on glass
    });
  }

  /**
   * (hotkey revamp 2026-06-14, "spinning plates"; P / Shift+P removed):
   *   • DOCKED   → SELECT only (glow/flash via ARM_SELECT). Mother stays in
   *     view; the player then launches the selected daughter with D. NO deploy,
   *     NO camera switch (D1).
   *   • DEPLOYED → SELECT + switch camera to that daughter (pilot it).
   *   • HOLDING_CATCH → SELECT only, like DOCKED (u17b): she is home on her strut, never piloted.
   *   • EXPENDED → warn.
   *   • Re-press the ACTIVE daughter's digit while she is PILOTED → return to mother: exit the pilot
   *     camera + deselect WITHOUT recalling (the daughter keeps working — this
   *     is the canonical "pop back" toggle that replaced P's exit role).
   *   • Re-press the active daughter's digit while she is out on her tether but NOT piloted (u18a: the state
   *     DEPLOY leaves her in under the zoom ladder) → pilot her, keep her selected.
   *     Home or busy states (docked, holding, reloading, docking, carry) still deselect.
   * Arms 5-8 are deferred until tiers ship (D2) — only digits 1-4 exist today.
   * @private
   * @param {number} armIndex - 0-based arm index
   */
  _handleArmKey(armIndex) {
    const d = this._deps;
    if (!d.armManager) return;

    const arm = d.armManager.arms[armIndex];
    if (!arm) return;

    // Re-pressing the active daughter's digit.
    if (d.armManager.selectedArmIndex === armIndex) {
      // u18a (D1): DEPLOY was pressed and the mother is still turning for her (or the gate holds her launch): she is
      // still DOCKED and selected, and her number must not deselect her now, or the owner's "two taps to fly her"
      // returns. A no-op: she stays selected; once she has launched, one tap pilots her (below).
      if (arm.state === Constants.ARM_STATES.DOCKED && typeof d.armManager.isLaunchPending === 'function'
          && d.armManager.isLaunchPending(armIndex)) return;
      // u18a (D1, owner 2026-10-22 "after DEPLOY the first row tap deselects her, two taps to fly her"): she is
      // selected, out on her tether, but NOT piloted. That is the state DEPLOY leaves her in under the zoom
      // ladder (the launch ceremony is stood down on its first frame: "press her number to ride with her"), so
      // her number now pilots her and keeps her selected. Never the toggling selectArm on a selected daughter.
      if (!this.armPilotMode && !isHomeOrBusyArmState(arm.state)) {
        this._enterArmPilotCamera(arm);
        if (arm.state === Constants.ARM_STATES.ADRIFT) this._postAdriftLine(arm);
        return;
      }
      // Piloted (or home / busy): return to mother. Exit the pilot camera (if piloting) and deselect — but do
      // NOT recall; a launched daughter keeps station-keeping / working ("spinning plates").
      this._exitArmPilotCamera();
      d.armManager.deselectArm();
      return;
    }

    if (arm.state === Constants.ARM_STATES.DOCKED) {
      // SELECT only (D1) — the docked arm glows/flashes (ARM_SELECT). Mother
      // stays in view; launch the selected daughter with D (pick-then-launch).
      // If another daughter is being piloted, leave pilot mode first (as for a holding daughter below), so the
      // camera, the strip, D and "." all refer to the daughter just selected. Nobody piloted: no-op, as before.
      this._exitArmPilotCamera();
      d.armManager.selectArm(armIndex);
    } else if (arm.state === Constants.ARM_STATES.HOLDING_CATCH) {
      // u17b (owner 2026-10-22 bug "press 1-4 for a daughter that has captured debris, the sonar ping is
      // still going and the bottom options are wrong"): a daughter parked on her strut with a catch is
      // HOME, like a docked one: SELECT only, never pilot (she cannot be flown, N and R do nothing for her,
      // and the pilot view's range beeps ran against the piece on her own rack). If another daughter is
      // being piloted right now, leave pilot mode first, so the view, the strip, C and "." refer to her.
      this._exitArmPilotCamera();
      d.armManager.selectArm(armIndex);
    } else if (arm.state === Constants.ARM_STATES.ADRIFT) {
      // Out of usable FEEP but STILL tethered and powered — select + pilot works
      // (avionics are live). Thrusters are dry, so nudge the player to reel her in.
      d.armManager.selectArm(armIndex);
      this._enterArmPilotCamera(arm);
      this._postAdriftLine(arm);
    } else if (arm.state === Constants.ARM_STATES.EXPENDED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName} is expended. Not available`,
        priority: 'warning',
      });
    } else {
      // Arm is deployed — select it for piloting + camera follow.
      d.armManager.selectArm(armIndex);
      this._enterArmPilotCamera(arm);
    }
  }

  /** The "adrift" comms line for a daughter whose number was just pressed (select + pilot, or pilot while selected). @private */
  _postAdriftLine(arm) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'CMD',
      text: `${arm.displayName} is adrift. Thrusters dry, avionics live. Press R to reel her home.`,
      priority: 'info',
    });
  }

  /**
   * Switch camera to ARM_PILOT mode following the specified arm.
   * Handles enabling manual control and switching from previous arm.
   * @private
   * @param {object} arm - ArmUnit to follow
   */
  _enterArmPilotCamera(arm) {
    const d = this._deps;
    if (!d.cameraSystem) return;

    // Track whether this is a fresh entry into ARM_PILOT (vs. switching the
    // piloted arm) so we only post the "how to get back" guidance once.
    const wasPiloting = this.armPilotMode;

    // If already piloting a different arm, disable its manual mode
    if (this.armPilotMode) {
      const prevArm = d.cameraSystem.getPilotedArm();
      if (prevArm && prevArm !== arm && prevArm.disableManual) {
        prevArm.disableManual();
      }
    }

    this.armPilotMode = true;
    if (arm.enableManual) arm.enableManual();
    d.cameraSystem.setPilotArm(arm);

    // Unambiguous get-out guidance: exits are Esc or re-pressing the active
    // digit (her number again). New players can otherwise feel "stuck" piloting
    // the daughter, so spell out the way home the moment they enter.
    if (!wasPiloting) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: pilotLine(arm.displayName),
        source: 'HOUSTON',
        channel: 'CMD',
        priority: 'info',
      });
    }
  }

  /**
   * Exit ARM_PILOT camera mode — restore FOV + return to CHASE.
   * @private
   */
  _exitArmPilotCamera() {
    const d = this._deps;
    if (!this.armPilotMode) return;

    this.armPilotMode = false;
    const pilotedArm = d.cameraSystem ? d.cameraSystem.getPilotedArm() : null;
    if (pilotedArm && pilotedArm.disableManual) pilotedArm.disableManual();
    if (d.cameraSystem) d.cameraSystem.clearPilotArm();
  }

  // ==========================================================================
  // DEBRIS PROXIMITY HELPERS (Phase 1C)
  // ==========================================================================

  /**
   * Find the nearest debris to a piloted arm within capture range (~50m = 0.0005 scene units).
   * Used by N-key manual net deploy when arm has no assigned target (free-fly mode).
   * @private
   * @param {object} arm - ArmUnit instance
   * @param {object} debrisField - DebrisField instance
   * @returns {object|null} Nearest debris object or null if none in range
   */
  _findNearestDebrisToArm(arm, debrisField) {
    if (!arm || !debrisField) return null;
    const captureRange = 0.0005; // ~50m in scene units (1 unit = 100km)
    // slice 5 (5d, D4): never a piece that was disposed of
    const nearby = (debrisField.getDebrisNear(arm.position, captureRange) || []).filter((p) => !(p && p._disposed));
    if (nearby && nearby.length > 0) {
      // getDebrisNear returns sorted by distance — first is closest
      // Find the actual debris object from debrisList for target assignment
      const closest = nearby[0];
      const debris = debrisField.getDebrisById
        ? debrisField.getDebrisById(closest.id)
        : closest;
      return debris || null;
    }
    return null;
  }

  /**
   * Resolve the de-spin laser's override target while piloting a daughter.
   * Eligible only when the piloted arm is in STATION_KEEP; returns its SK
   * target (or null). Single source of truth shared by the KeyL no-target
   * affordance and the processInput() laser steering, so the warning and
   * the actual beam eligibility can never drift apart.
   * @returns {object|null}
   */
  _getPilotedSkDespinTarget() {
    const pilotArm = this._deps.cameraSystem?.getPilotedArm?.();
    if (pilotArm && pilotArm.state === Constants.ARM_STATES.STATION_KEEP) {
      return pilotArm._stationKeepTarget || pilotArm.target || null;
    }
    return null;
  }

  /**
   * Process held keys into thrust commands.
   * @param {number} dt - Real-time delta (seconds)
   */
  processInput(dt) {
    const d = this._deps;
    this._tickNetWait(dt);       // F14: the Shift+A daughters' wait for the net's turn runs on game time

    // CP-2: mother-mounted de-spin laser — hold L. Set the fire intent every
    // frame BEFORE the overlay early-returns so it always releases when an
    // overlay opens or the key is let go.
    // Issue 5c/9 (2026-06-12): the laser ALSO works while piloting a daughter in
    // STATION_KEEP — the SK readout advises "de-spin [L]", so the advisory must
    // point at a live key. The laser is steered at the piloted arm's SK target
    // (override), not the Tab-locked selector target.
    // (Hotkey history: migrated U → H 2026-06-13, then H → L 2026-06-15.)
    const overlayOpen = !!((d.codexViewerUI && d.codexViewerUI.isVisible && d.codexViewerUI.isVisible())
      || (d.hotkeyOverlay && d.hotkeyOverlay.isVisible && d.hotkeyOverlay.isVisible())
      || (d.debrisMap && d.debrisMap.isVisible && d.debrisMap.isVisible()));
    let skDespinTarget = null;
    if (this.armPilotMode) {
      skDespinTarget = this._getPilotedSkDespinTarget();
    }
    despinLaser.setOverrideTarget(skDespinTarget);
    despinLaser.setFiring(
      !overlayOpen
      && (!this.armPilotMode || !!skDespinTarget)
      && (d.gameState && d.gameState.isGameplay && d.gameState.isGameplay())
      && this.keys['KeyL'] === true,
    );

    // Phase 3a (capture-feedback overhaul): hold Shift → BOOST reel ×2 on
    // reeling daughters. Set every frame (like the laser intent above) so the
    // boost always releases on keyup/overlay. Shift is otherwise only a
    // modifier (Shift+R/V/D/A/N/S/G), so a bare hold is conflict-free.
    if (d.armManager && typeof d.armManager.setReelBoost === 'function') {
      const boostHeld = !overlayOpen
        && (this.keys['ShiftLeft'] === true || this.keys['ShiftRight'] === true);
      d.armManager.setReelBoost(boostHeld);
    }

    // F17: Suppress continuous input while codex overlay is open
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) return;

    // Suppress continuous input while the hotkey reference overlay is open
    if (d.hotkeyOverlay && d.hotkeyOverlay.isVisible()) return;

    // Suppress continuous input while debris map is open
    if (d.debrisMap && d.debrisMap.isVisible()) return;

    const ionDir = { x: 0, y: 0, z: 0 };
    let hasIon = false;
    let thrustType = 'ion';

    // WASD daughter thrust REMOVED (hotkey revamp 2026-06-14): daughters are
    // flown with the arrow keys (station-keep orbit) only, and W/A/S/D now keep
    // their mother-mode meanings (wide/quick scan, autopilot, launch) even while
    // piloting. ionDir therefore stays zero from keyboard; ARM_MANUAL_THRUST is
    // no longer emitted from held keys.
    const apEngaged = d.autopilotSystem && d.autopilotSystem.engaged;

    // ── ST-8.2.1: STATION_KEEP orbital controls ──
    if (this.armPilotMode) {
      const skArm = d.cameraSystem?.getPilotedArm();
      if (skArm && skArm.state === Constants.ARM_STATES.STATION_KEEP) {
        // 'R' key: recall/reel-in is handled in _onKeyDown (one-shot).
        // Auto-return (dwell-then-ease) handles recentering automatically.
        // ── Screen-aligned axes (debug session 2026-05-15) ──
        // θ in the new frozen entry frame = YAW around the camera-up axis
        //   (horizontal screen motion), so it maps to ←/→ keys.
        // φ = PITCH around the camera-right axis (vertical screen motion),
        //   so it maps to ↑/↓ keys.
        // The previous mapping (Up/Down→theta, Left/Right→phi) was inherited
        // from the world-Y polar spherical model and felt swapped to the
        // pilot once the math was rewritten to screen-frame yaw/pitch.
        let theta = 0, phi = 0, radius = 0;
        if (this.keys['ArrowLeft'])  theta -= 1;   // yaw left
        if (this.keys['ArrowRight']) theta += 1;   // yaw right
        if (this.keys['ArrowUp'])    phi   += 1;   // pitch up
        if (this.keys['ArrowDown'])  phi   -= 1;   // pitch down
        if (this.keys['Equal'] || this.keys['NumpadAdd'])       radius -= 1;  // approach
        if (this.keys['Minus'] || this.keys['NumpadSubtract'])  radius += 1;  // retreat

        if (theta !== 0 || phi !== 0 || radius !== 0) {
          const fine = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
          eventBus.emit(Events.ARM_ORBIT_ADJUST, {
            armId: skArm.id,
            theta,
            phi,
            radius,
            fine,
          });
        }
      }
    }

    if (hasIon) {
      const mag = Math.sqrt(ionDir.x ** 2 + ionDir.y ** 2 + ionDir.z ** 2);
      if (mag > 0) {
        ionDir.x /= mag;
        ionDir.y /= mag;
        ionDir.z /= mag;
      }

      const fine = this.keys['ShiftLeft'] || this.keys['ShiftRight'];

      // ================================================================
      // WASD Context Switch — ARM PILOT only (mothership thrust removed)
      // Priority 1: ARM PILOT mode (camera-tracked piloted daughter)
      // Priority 2: Arm selected via number keys 1-4 and deployed/pilotable
      // ================================================================

      if (this.armPilotMode && d.cameraSystem) {
        // ARM PILOT: route to the camera-tracked piloted arm
        const arm = d.cameraSystem.getPilotedArm();
        if (arm) {
          eventBus.emit(Events.ARM_MANUAL_THRUST, {
            armId: arm.id,
            direction: ionDir,
            fine,
            dt,
          });
          thrustType = 'arm';
        }
      } else if (d.armManager && d.armManager.selectedArmIndex >= 0) {
        // Number-key selected arm: auto-enable manual mode + route thrust
        const selectedArm = d.armManager.getSelectedDeployedArm();
        if (selectedArm) {
          // Auto-enable manual piloting (selecting a deployed daughter pilots it)
          if (!selectedArm.isManual()) selectedArm.enableManual();
          eventBus.emit(Events.ARM_MANUAL_THRUST, {
            armId: selectedArm.id,
            direction: ionDir,
            fine,
            dt,
          });
          thrustType = 'arm';
        }
      }
    }

    // Phase 1: Classify thrust direction for audio differentiation
    let thrustAudioDir = 'lateral';
    if (ionDir.z > 0.5) thrustAudioDir = 'prograde';
    else if (ionDir.z < -0.5) thrustAudioDir = 'retrograde';

    // Continuous thruster audio
    if (hasIon) {
      const audioType = (thrustType === 'arm' || thrustType === 'rcs' || thrustType === 'mpd') ? 'ion' : thrustType;
      // Arm-pilot FEEPs are micro-newton thrusters — should sound much quieter
      // than the mothership's main bus. 0.4× intensity = ~−8 dB attenuation,
      // enough to fade into ambient mix during station-keeping without
      // disappearing completely (still provides feedback on input).
      const intensity = (thrustType === 'arm') ? 0.4 : 1.0;
      d.audioSystem.startThrusterHum(audioType, thrustAudioDir, intensity);
    } else if (apEngaged && !this.armPilotMode) {
      // F15: Autopilot is thrusting — play FEEP thruster hum.
      // Suppressed during ARM PILOT mode (mother is just holding station while
      // the daughter operates — the constant hum was reported as annoying).
      d.audioSystem.startThrusterHum('ion', 'prograde');
    } else {
      d.audioSystem.stopThrusterHum();
    }

    // ================================================================
    // S4: Compute and emit control mode for HUD indicator.
    // Determines what WASD *would* do right now, regardless of whether
    // the player is actively pressing keys.
    // ================================================================
    let newMode = 'RCS'; // default: mothership RCS fine positioning
    if (this.armPilotMode || (d.armManager && d.armManager.selectedArmIndex >= 0 && d.armManager.getSelectedDeployedArm())) {
      newMode = 'ARM_PILOT';
    } else if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) {
      newMode = 'COLD_GAS';
    }
    if (newMode !== this._controlMode) {
      this._controlMode = newMode;
      eventBus.emit(Events.CONTROL_MODE_CHANGE, { mode: newMode });
    }

    // ================================================================
    // F13: Arrow keys → Pitch / Yaw rotation (always controls mothership)
    // F15: Skip manual rotation while autopilot engaged (AP controls heading)
    // ================================================================
    // ST-8.2.1: Skip mothership rotation when piloted arm is in STATION_KEEP
    const _skGuardArm = this.armPilotMode && d.cameraSystem?.getPilotedArm();
    const _inStationKeep = _skGuardArm && _skGuardArm.state === Constants.ARM_STATES.STATION_KEEP;

    // A scripted whole-ship turn (leash hand-off) locks the arrows out: they take the
    // else branch below — no MOTHER_MANUAL_ROTATE, no commandAttitude (no gas, no plumes).
    if (!apEngaged && !_inStationKeep && !d.autopilotSystem?.isTurning?.()) {
      // Phase 3: attitude is now rate-commanded through the rigid-body integrator.
      // Derive per-axis input (+1/0/−1), emit the manual-rotate cancel on a fresh
      // press, pass the tether lock tier, and hand off to commandAttitude — the
      // hold controller (not an input-side stop-pulse) owns arrest now.
      if (!this._prevArrowKeys) this._prevArrowKeys = { up: false, down: false, left: false, right: false };
      const _pk = this._prevArrowKeys;
      const _prevUp = _pk.up, _prevDown = _pk.down, _prevLeft = _pk.left, _prevRight = _pk.right;
      _pk.up    = !!this.keys['ArrowUp'];
      _pk.down  = !!this.keys['ArrowDown'];
      _pk.left  = !!this.keys['ArrowLeft'];
      _pk.right = !!this.keys['ArrowRight'];

      // Aim-before-launch: a fresh manual attitude input cancels any active
      // auto-rotation aim sequence (nothing has been fired/spent yet).
      const _freshPress = (_pk.up && !_prevUp) || (_pk.down && !_prevDown) ||
          (_pk.left && !_prevLeft) || (_pk.right && !_prevRight);
      if (_freshPress) {
        eventBus.emit(Events.MOTHER_MANUAL_ROTATE);
        // RCS ignition accent — instant attack even though the hull is slow.
        d.audioSystem.playRcsPuff?.();
      }

      // Net per-axis rate demand (Up=pitch+, Down=pitch−, Left=yaw+, Right=yaw−).
      let pitchIn = 0, yawIn = 0;
      if (_pk.up)    pitchIn += 1;
      if (_pk.down)  pitchIn -= 1;
      if (_pk.left)  yawIn   += 1;
      if (_pk.right) yawIn   -= 1;

      // Tether lock tier gates the command magnitude AND drives the Phase 4
      // restoring-torque constraint on the satellite. Full authority when 'none'.
      const tier = d.armManager?.getRotationLockTier?.() || 'none';
      d.player.setAttitudeConstraintTier?.(tier);

      // Comms warning when pushing into a saturated tether limit (Phase 4 tracks
      // displacement on the satellite; here we only surface the message).
      if (tier !== 'none' && (pitchIn !== 0 || yawIn !== 0) &&
          d.player.isAttitudeConstraintSaturated?.(pitchIn, yawIn)) {
        this._maybeEmitTetherLockMsg();
      }

      d.player.commandAttitude(pitchIn, yawIn, dt);

      // Sustained RCS hiss driven at the REAL attitude-thrust level (post-gate
      // command + hold/arrest burn) — mirrors the ion hum above. Goes quiet while
      // coasting at the rate cap, swells during the arrest burn.
      const rcsLevel = d.player.getAttitudeThrustLevel?.() ?? 0;
      if (rcsLevel > 0) d.audioSystem.startRcsHiss?.(rcsLevel);
      else d.audioSystem.stopRcsHiss?.();
    } else {
      // AP / station-keep / scripted turn active: drop the held-key record so re-enabling manual
      // control can't fire a phantom command from a stale "held" state.
      this._prevArrowKeys = null;
      // Autopilot/station-keep owns attitude — the manual RCS hiss must not stick.
      d.audioSystem.stopRcsHiss?.();
    }
  }

  /**
   * FIX_PLAN §3: Rate-limited COMMS warning for tether rotation lock.
   * Called both from the AP-disengage guard (_handleKeyDown) and from the
   * spring-saturation check (processInput). Shared throttle state ensures
   * at most one message per COMMS_THROTTLE_MS regardless of call site.
   */
  _maybeEmitTetherLockMsg() {
    const now = performance.now();
    if (now - (this._lastTetherRotWarnMs ?? 0) < Constants.TETHER_ROTATION.COMMS_THROTTLE_MS) return;
    this._lastTetherRotWarnMs = now;
    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: 'warning',
      channel:  'FLIGHT',
      text:     'ATTITUDE LOCKED. Daughter under tether load',
    });
  }

  // ==========================================================================
  // Delegation 2 (2026-05-31) — public helpers for OnboardingDirector.pressActiveHint().
  // Each method performs the *same* game-side effect that the corresponding
  // raw key handler would.  We don't synthesize KeyboardEvents because every
  // listener that matters lives in this file — calling the action directly is
  // simpler and avoids accidental re-entry via the keydown router.
  //
  // Methods are no-ops when their dependencies aren't ready; the Director
  // gracefully falls back to "no action".
  // ==========================================================================

  /** Smart-default helper — fires a Quick Scan (mirrors `case 'KeyS':`). */
  fireScan() {
    const d = this._deps; if (!d) return;
    eventBus.emit(Events.SCAN_QUICK);
    eventBus.emit(Events.TUTORIAL_SCAN_INPUT);
    d.audioSystem?.playClick?.();
  }

  /** Smart-default helper — cycles the next target (mirrors `case 'Tab':`). */
  cycleTarget() {
    const d = this._deps; if (!d || !d.debrisField || !d.player) return;
    try {
      this.nearbyTargets = d.debrisField.getEnhancedTargetList(
        d.player.getPosition(), d.player.getOrbitalElements()
      );
      const canDetect = d.sensorSystem && d.sensorSystem.canDetectUntracked;
      this.nearbyTargets = this.nearbyTargets.filter(t => t.tracked !== false || canDetect);
      if (this.nearbyTargets.length > 0) {
        this.targetIndex = (this.targetIndex + 1) % this.nearbyTargets.length;
        const t = this.nearbyTargets[this.targetIndex];
        const debris = d.debrisField.getDebrisById(t.id);
        if (debris) {
          d.targetSelector?.setTarget(debris, { distanceKm: t.distanceKm, deltaV: t.deltaV });
          d.debrisWireframe?.setTarget(debris);
          d.hud?.setSelectedTarget(t.id);
          d.targetReticle?.setSelectedTarget(t.id);
          d.navSphere?.setSelectedTarget(t.id);
        }
      }
      eventBus.emit(Events.TUTORIAL_TAB_INPUT);
    } catch (_e) { /* defensive */ }
  }

  /** Smart-default helper — toggles autopilot (mirrors `case 'KeyA':`). */
  engageAutopilot() {
    const d = this._deps; if (!d) return;
    if (d.autopilotSystem && typeof d.autopilotSystem.toggle === 'function') {
      d.autopilotSystem.toggle();
      d.audioSystem?.playClick?.();
    }
  }

  /**
   * Fire the lasso (windup → cast). Single implementation for the KeyN
   * keyboard path and the OnboardingDirector smart-default — no duplicated
   * windup/fire logic to drift (2026-06-13 dedup).
   */
  fireLasso() {
    const d = this._deps; if (!d || !d.lassoSystem) return;
    if (this._lassoWindingUp || d.lassoSystem.active) return;

    // ── Mother nets: one count, two launchers (DECISIONS §33 row 1, 2026-10-20) ─────────────────────────────
    // The mother has 4 nets, owned by CaptureNetSystem. N fires one at any piece in range while nets remain:
    //   · a piece ≤ LASSO_MAX_CAPTURE_MASS (10 kg), or no Tab-selected target (the welcome field's auto-aim and
    //     the onboarding rely on this) → the small net (LassoSystem) below;
    //   · a heavier piece (classifyNetTarget band 'mother' or 'whale') → the large net (fireMotherNet).
    // Both paths spend from the same count at the moment the shot really launches, so a refused press costs
    // nothing. The old "daughter-sized, press D" refusal for 10–500 kg is gone. At 0 nets: one line, nothing starts
    // (no aim slew toward a shot that cannot be fired).
    const activeTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
    const cns = d.captureNetSystem;
    // interlocks-p2 R1: a piece a daughter is flying to / lining up a launch for, or a net is already flying at, is
    // somebody's: say what to do instead and start nothing (before any routing, so both nets are covered).
    if (activeTarget && this._refuseNetAtOwnedPiece(activeTarget)) return;
    if (cns && Constants.isFeatureEnabled('CAPTURE_NET')) {
      // (typeof guard: the net system always has the getter; the idiom keeps headless mocks without one working)
      if (typeof cns.getMotherNetCount === 'function' && cns.getMotherNetCount() <= 0) {
        eventBus.emit(Events.LASSO_DENIED, { reason: 'no_ammo' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: OUT_OF_MOTHER_NETS_LINE,
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'warning',
          _lassoFeedback: true,
        });
        d.audioSystem?.playDeny?.() ?? d.audioSystem?.playClick?.();
        return;
      }
      // N on a piece beyond the reach of the net that would fire, but a docked daughter can go that far: say so
      // once and start nothing (DECISIONS §33 row 8). Not while the mission-1 tutorial runs; beyond every reach the
      // path's own refusal speaks, as before.
      if (activeTarget && this._beyondNetReachButDaughterCan(activeTarget)) {
        eventBus.emit(Events.LASSO_DENIED, { reason: 'out_of_net_range' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: OUT_OF_NET_RANGE_LINE,
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'warning',
          _lassoFeedback: true,
        });
        d.audioSystem?.playDeny?.() ?? d.audioSystem?.playClick?.();
        return;
      }
      if (activeTarget && classifyNetTarget(activeTarget.mass || 0).band !== 'lasso') {
        this.fireMotherNet(activeTarget);
        return;
      }
    }

    // ── Aim-before-launch for the lasso cast ────────────────────────────────
    // The mother's net launcher physically points at the selected target before
    // casting (parity with the Large Net path). Only when a target is selected,
    // in lasso range, and we have autopilot + live attitude — the no-target
    // welcome-field auto-aim stays instant (nothing to aim at).
    const ap = d.autopilotSystem;
    if (ap && typeof ap.isAiming === 'function' && ap.isAiming()) {
      // A net aim is already slewing — don't double-book or bypass it.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info', source: 'HOUSTON',
      });
      return;
    }
    const canAim = ap && typeof ap.requestAimRotation === 'function'
      && d.player.quaternion && activeTarget
      && d.targetSelector && typeof d.targetSelector.getActiveTargetPosition === 'function';
    if (canAim) {
      const pos0 = d.player.getPosition();
      const tp0 = d.targetSelector.getActiveTargetPosition();
      const inRange = tp0 && targetRangeM(pos0, tp0) <= Constants.LASSO_RANGE;
      if (inRange) {
        // Scratch reused across ticks — the provider is polled every frame by
        // the aim coroutine during the slew, and the result is copied into
        // _aimTargetDir immediately (AutopilotSystem._tickAimCoroutine), so
        // returning the same mutated object is safe. Avoids one Vector3 clone
        // (getPosition) + one fresh direction object per frame.
        const dirOut = { x: 0, y: 0, z: 0 };
        const provider = () => {
          const pos = d.player.position || d.player.getPosition();
          const tp = d.targetSelector.getActiveTargetPosition();
          if (!tp) return null;
          const bx = tp.x - pos.x, by = tp.y - pos.y, bz = tp.z - pos.z;
          const len = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
          dirOut.x = bx / len; dirOut.y = by / len; dirOut.z = bz / len;
          return dirOut;
        };
        // Fast path: already aligned within tolerance → cast immediately.
        const aimDir = provider();
        let aligned = false;
        if (aimDir) {
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion).normalize();
          const dot = Math.max(-1, Math.min(1, fwd.dot(new THREE.Vector3(aimDir.x, aimDir.y, aimDir.z))));
          aligned = (Math.acos(dot) * 180 / Math.PI) <= Constants.AIM.NET_AIM_TOLERANCE_DEG;
        }
        if (!aligned) {
          // sloth mode (D7): the lasso's lock has the aim's own 30 s; a slow turn on the tail boxes is refused at once (`TOO_SLOW`)
          ap.requestAimRotation(provider, { mode: 'net', aimDir: aimDir || undefined, maxWaitS: Constants.AIM.AIM_TIMEOUT_S })
            .then(() => this._castLasso({ afterAim: true }))
            .catch((err) => {
              // aborted — nothing cast; a timed-out aim / lost target leaves the ship quiet (as the net does)
              if (err && (err.code === 'TIMEOUT' || err.code === 'TARGET_LOST')) d.player.holdHeadingAfterRefusal?.();
            });
          return;
        }
      }
    }

    this._castLasso();
  }

  /**
   * The lasso windup → cast, extracted so the aim-before-launch flow can defer
   * it until the mother has slewed to face the target. Safe to call directly
   * (headless mocks / no-target auto-aim / already-aligned fast path).
   * @param {{afterAim?: boolean}} [opts] — net-refuse-hold: `afterAim` = the ship has just turned to face the target;
   *   a cast refused after that turn leaves her pointed where she is instead of recentering toward prograde.
   */
  _castLasso(opts) {
    const d = this._deps; if (!d || !d.lassoSystem) return;
    const afterAim = !!(opts && opts.afterAim);
    if (this._lassoWindingUp || d.lassoSystem.active) return;
    // Hold attitude from the instant we commit to the cast — BEFORE the windup —
    // so the prograde auto-orient can't slew the nose off-target during the
    // windup gap (that was the ~5° backslide between aim-resolve and LASSO_FIRED).
    // Released on reel-in end (LASSO_STOWED/SNAPPED/MISSED) by AutopilotSystem.
    d.autopilotSystem?.holdAttitude?.();
    this._lassoWindingUp = true;
    d.audioSystem?.playClick?.();
    const windupMs = (Constants.LASSO_CAST_WINDUP || 0.15) * 1000;
    this._lassoWindupTimeout = setTimeout(() => {
      this._lassoWindingUp = false;
      this._lassoWindupTimeout = null;
      // Fire along the ship's actual NOSE (+Z) — the mother has slewed to face
      // the target, and the lasso geometry (muzzle/flight/reel) must use that
      // same frame so the catch reels back to the current nose, not the old
      // prograde spot. Falls back to velocity when there's no attitude (headless).
      let fwdDir;
      if (d.player.quaternion) {
        fwdDir = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion);
      } else {
        const vel = d.player.getVelocity();
        fwdDir = new THREE.Vector3(vel.x, vel.y, vel.z);
      }
      if (fwdDir.lengthSq() > 0) fwdDir.normalize();
      const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
      // interlocks-p2 R1: the piece may have been taken during the windup (a daughter's launch, a net): re-check at release.
      if (target && this._refuseNetAtOwnedPiece(target)) {
        d.autopilotSystem?.releaseAttitudeHold?.();
        if (afterAim) d.player.holdHeadingAfterRefusal?.();
        return;
      }
      // Review R2: the target is read again here, after the windup. If it is now a piece the small net cannot hold
      // (the player Tab-selected a heavier one in the meantime), hand it to the mother-net path exactly as fireLasso
      // routes it, instead of letting the lasso refuse it. Nothing was spent yet; the attitude hold is released first.
      if (target && d.captureNetSystem && Constants.isFeatureEnabled('CAPTURE_NET')
          && classifyNetTarget(target.mass || 0).band !== 'lasso') {
        d.autopilotSystem?.releaseAttitudeHold?.();
        this.fireMotherNet(target);
        return;
      }
      const cast = d.lassoSystem.fire(d.player.getPosition(), d.debrisField, fwdDir, target);
      // If the cast was refused (out of arc, cargo full, no ammo, cooldown…),
      // no reel-in end event will fire — release the attitude hold now so the
      // ship isn't frozen until the safety cap.
      if (cast === false) {
        d.autopilotSystem?.releaseAttitudeHold?.();
        if (afterAim) d.player.holdHeadingAfterRefusal?.();   // net-refuse-hold: no turn back after a refused cast
      }
    }, windupMs);
  }

  /**
   * Fire the Mother's Large Net launcher at a piece heavier than the small net
   * holds (> LASSO_MAX_CAPTURE_MASS, any mass up to the net's rating; DECISIONS §33). One launcher, on the axis (owner 2026-10-13), so podIndex is
   * always 0; fireMotherNet handles empty/cooldown comms.
   * @param {object} target — the selected debris (mass > 10 kg)
   */
  fireMotherNet(target) {
    const d = this._deps; if (!d || !d.captureNetSystem || !d.player) return;
    if (target && target._disposed === true) return;   // slice 5 (5d, D4): a piece that was disposed of is no catch (and is never aimed at)
    if (tripRefuses('net')) return;   // trip-melt G8: refused BEFORE the ship slews round to aim (CaptureNet would refuse after the turn)
    const cns = d.captureNetSystem;
    const ap = d.autopilotSystem;

    // One launcher: podIndex is always 0. When it is empty fireMotherNet's own
    // "magazine empty — restock at shop" comms fires (below).
    const podIndex = 0;

    // Empty-magazine pre-check FIRST — never start a rotation when there is
    // nothing to fire. The system emits the "empty / reloading" comms.
    if (cns.getMotherPodInventory(podIndex) <= 0 ||
        (typeof cns.isMotherPodOnCooldown === 'function' && cns.isMotherPodOnCooldown(podIndex))) {
      cns.fireMotherNet(podIndex, d.player.getPosition(), { x: 0, y: 0, z: 1 }, target);
      return;
    }

    // Re-press during an active aim sequence — ignore (don't double-book).
    if (ap && typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info', source: 'HOUSTON',
      });
      return;
    }

    const M = 0.00001; // 1 metre in scene units
    const netClass = (typeof cns.getMotherNetClass === 'function')
      ? cns.getMotherNetClass(podIndex) : null;
    const launchSpeedScene = ((netClass && netClass.LAUNCH_SPEED) || 10.0) * M;

    // ── Pre-flight refusals (mother-net-reel plan §7.5 / §4.1) ────────────
    // All scene-unit endpoint math lives HERE (InputManager owns both
    // endpoints); CaptureNetSystem keeps only frame-free gates so unit tests
    // that fire with metre positions are unaffected. Evaluated twice: now
    // (pre-slew, so a refused shot never starts a rotation) and again inside
    // fireNow() (so a shot that drifted out of envelope during the slew is
    // caught at fire time).
    const maxReachM = netClass ? netMaxReachM(netClass) : 0;
    const DRIFT_REFUSE_MS = 5.0; // apparent m/s — beyond this the lead solution is unreachable
    const refuse = (text) => {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text, source: 'SYSTEM', channel: 'CMD', priority: 'warning',
      });
      d.audioSystem?.playDeny?.();
    };
    // relVelScratch is filled by the lead provider's EMA on every provider
    // tick; the pre-slew check seeds it with one synchronous sample below.
    const checkRefusals = (relVelScenePerS) => {
      if (!target || target.alive === false) {
        refuse('Target lost.'); return true;
      }
      // interlocks-p2 R1: one owner per piece. Checked now (pre-slew) and again at fire time (a daughter's launch or a
      // lasso may have taken the piece during the slew).
      {
        const claim = this._pieceClaim(target);
        const owned = claim && !isFree(claim) ? netRefusalLine(claim) : null;
        if (owned) { refuse(owned); return true; }
      }
      // Mass rating — hard refuse above the net's rated mass (strain roll in
      // the 80–100% band lands with Phase A; a 23 t CZ-5B can never be held).
      const mass = target.mass || 0;
      const rated = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
      if (rated > 0 && mass > rated) {
        refuse(`Beyond net rating — ${mass >= 1000 ? `${(mass / 1000).toFixed(1)} t` : `${Math.round(mass)} kg`} exceeds the ${(rated / 1000).toFixed(0)} t ${(netClass && netClass.NAME) || 'Large Net'}.`);
        return true;
      }
      // Range — scene-unit distance / M → metres.
      const muzzle = (typeof d.player.getNetPodPositionInto === 'function')
        ? d.player.getNetPodPositionInto(podIndex, muzzleScratch)
        : (typeof d.player.getNetPodPosition === 'function')
          ? d.player.getNetPodPosition(podIndex) : d.player.getPosition();
      const tp = getTargetPos();
      if (tp && maxReachM > 0) {
        // net-range: the SAME distance the HUD shows (ship centre → piece, targetRangeM), not muzzle → piece.
        const rangeM = targetRangeM(d.player.getPosition(), tp);
        if (rangeM > maxReachM) {
          refuse(netRangeLine(rangeM, maxReachM, 'net'));
          return true;
        }
      }
      // Apparent drift — relVel is scene units/s; ÷ M → m/s apparent.
      if (relVelScenePerS) {
        const rv = relVelScenePerS;
        const driftMs = Math.sqrt(rv.x * rv.x + rv.y * rv.y + rv.z * rv.z) / M;
        if (driftMs > DRIFT_REFUSE_MS) {
          refuse('Match velocity first [A].');
          return true;
        }
      }
      // Launcher busy — a second mother net while one is airborne gets no
      // visual (the visual map is keyed per pod and early-returns) and the
      // HUD tracks the wrong net (§4.5).
      if (typeof cns.hasMotherNetInFlight === 'function' && cns.hasMotherNetInFlight()) {
        refuse('Net already away.');
        return true;
      }
      // no-melt: a catch at the collar with nowhere to go says so plainly, before any rotation starts.
      const noseFull = typeof cns.getNoseFullLine === 'function' ? cns.getNoseFullLine() : null;
      if (noseFull) { refuse(noseFull); return true; }
      // Shot fouls the mated cargo (S13(e): per-shot and geometric — the pods
      // are off the boresight, so collar occupancy is NEVER a refusal by
      // itself; only a shot whose corridor intersects the cargo refuses).
      // The pre-slew read uses the direct muzzle→target bearing; fireMotherNet
      // re-checks with the true fire-time direction (ship +Z).
      if (tp && typeof cns.getCollarShotFoul === 'function') {
        const pM = { x: muzzle.x / M, y: muzzle.y / M, z: muzzle.z / M };
        const dM = { x: (tp.x - muzzle.x) / M, y: (tp.y - muzzle.y) / M, z: (tp.z - muzzle.z) / M };
        const dl = Math.sqrt(dM.x * dM.x + dM.y * dM.y + dM.z * dM.z) || 1;
        if (cns.getCollarShotFoul(podIndex, pM, { x: dM.x / dl, y: dM.y / dl, z: dM.z / dl })) {
          refuse('This shot fouls the cargo at the collar — pull off the nose, or press K to let the catch go.');
          return true;
        }
      }
      // hold-clear D5 (owner 2026-10-23, "Net refuses, says why"): a holder whose catch cannot get out of this net's way without touching a
      // radiator wing holds the net back (every refused press says so; C may then move her catch). A pending wing profile is finished here if small.
      {
        const am = d.armManager;
        const blocked = am && typeof am.motherNetHolderBlock === 'function' ? am.motherNetHolderBlock(target) : -1;
        if (blocked >= 0) { refuse(am.motherNetBlockLine(blocked)); return true; }
      }
      return false;
    };

    // Lead-aim provider: recomputed per tick so it tracks the moving target.
    // relVel = target scene-velocity − mother scene-velocity (EMA-smoothed from
    // per-frame position deltas, same pattern as ArmUnit._updateNettingFSM).
    // Scratch objects are reused across ticks (no per-frame allocation): the
    // muzzle is written into muzzleScratch via getNetPodPositionInto().
    const muzzleScratch = new THREE.Vector3();
    const targetScratch = new THREE.Vector3();
    const lead = {
      prevT: { x: 0, y: 0, z: 0 }, prevM: { x: 0, y: 0, z: 0 }, prevTime: null,
      relVel: null, relVelBuf: { x: 0, y: 0, z: 0 },
      leadOut: { dir: { x: 0, y: 0, z: 0 }, offAxisDeg: 0 },
    };
    // Allocation-free target position (review fix: the provider is polled
    // every aim tick and previously cloned a Vector3 per call via
    // getActiveTargetPosition()).
    const getTargetPos = () => {
      const ts = d.targetSelector;
      if (!ts) return null;
      if (typeof ts.getActiveTargetPositionInto === 'function') {
        return ts.getActiveTargetPositionInto(targetScratch);
      }
      return ts.getActiveTargetPosition ? ts.getActiveTargetPosition() : null;
    };
    const provider = () => {
      const muzzle = (typeof d.player.getNetPodPositionInto === 'function')
        ? d.player.getNetPodPositionInto(podIndex, muzzleScratch)
        : (typeof d.player.getNetPodPosition === 'function')
          ? d.player.getNetPodPosition(podIndex) : d.player.getPosition();
      const tPos = getTargetPos();
      if (!tPos) return null;
      const now = performance.now() * 0.001;
      if (lead.prevTime != null) {
        const dtp = Math.max(1e-3, now - lead.prevTime);
        const rvx = (tPos.x - lead.prevT.x) / dtp - (muzzle.x - lead.prevM.x) / dtp;
        const rvy = (tPos.y - lead.prevT.y) / dtp - (muzzle.y - lead.prevM.y) / dtp;
        const rvz = (tPos.z - lead.prevT.z) / dtp - (muzzle.z - lead.prevM.z) / dtp;
        if (!lead.relVel) {
          lead.relVel = lead.relVelBuf;
          lead.relVel.x = rvx; lead.relVel.y = rvy; lead.relVel.z = rvz;
        } else {
          const a = 0.2; // EMA smoothing
          lead.relVel.x += a * (rvx - lead.relVel.x);
          lead.relVel.y += a * (rvy - lead.relVel.y);
          lead.relVel.z += a * (rvz - lead.relVel.z);
        }
      }
      lead.prevT.x = tPos.x; lead.prevT.y = tPos.y; lead.prevT.z = tPos.z;
      lead.prevM.x = muzzle.x; lead.prevM.y = muzzle.y; lead.prevM.z = muzzle.z;
      lead.prevTime = now;
      const { dir } = computeLeadAim(muzzle, tPos, lead.relVel, launchSpeedScene, lead.leadOut);
      return dir;
    };

    // Pre-slew refusal gate — seed the relVel EMA with one provider tick,
    // then run the checks. A refusal here must fire BEFORE any rotation is
    // requested (plan §7 acceptance).
    provider();
    if (checkRefusals(lead.relVel)) return;

    // Fire helper — launches along the ACTUAL ship +Z at fire time (honest to
    // attitude), from the current muzzle position. Falls back to a direct
    // bearing when no attitude is available (headless mocks).
    // Returns true when the net left, false when the shot was refused (net-refuse-hold: the caller that has just
    // turned the ship tells her to stay put).
    const fireNow = () => {
      // Fire-time re-check: the slew can take several seconds, during which
      // the range/drift picture changes (the AP's own VEL_TOL residual moves
      // the range ~45 m over a 9 s slew+flight — plan §3).
      if (checkRefusals(lead.relVel)) return false;
      const posScene = (typeof d.player.getNetPodPosition === 'function')
        ? d.player.getNetPodPosition(podIndex) : d.player.getPosition();
      // TRAP 2 (plan §0): NetProjectile works in METRES; the pod accessor
      // returns SCENE UNITS. Divide by M exactly as ArmUnit.js:4162 does —
      // skipping this is the live "net doesn't move / vanished instantly"
      // defect.
      const pos = { x: posScene.x / M, y: posScene.y / M, z: posScene.z / M };
      let dir;
      if (d.player.quaternion) {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion);
        if (fwd.lengthSq() > 0) fwd.normalize();
        dir = { x: fwd.x, y: fwd.y, z: fwd.z };
      } else {
        const tp = getTargetPos();
        if (tp) {
          const b = new THREE.Vector3(tp.x - posScene.x, tp.y - posScene.y, tp.z - posScene.z);
          if (b.lengthSq() > 0) b.normalize();
          dir = { x: b.x, y: b.y, z: b.z };
        } else {
          dir = { x: 0, y: 0, z: 1 };
        }
      }
      const net = cns.fireMotherNet(podIndex, pos, dir, target);
      if (net) {
        if (d.armManager && typeof d.armManager.clearNetBlocks === 'function') d.armManager.clearNetBlocks();   // hold-clear D6: a shot nobody blocked ends the marks
        d.audioSystem?.playClick?.();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Attitude locked — net away.', priority: 'info', source: 'HOUSTON',
        });
      }
      return !!net;
    };

    // No attitude-aware aiming available (no autopilot or no live attitude) →
    // immediate fire, preserving the pre-aim behavior for headless mocks.
    if (!ap || typeof ap.requestAimRotation !== 'function' || !d.player.quaternion) {
      fireNow();
      return;
    }

    // Fast path: already aligned within tolerance → fire immediately.
    const aimDir = provider();
    if (aimDir) {
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion).normalize();
      const dot = Math.max(-1, Math.min(1, fwd.dot(new THREE.Vector3(aimDir.x, aimDir.y, aimDir.z))));
      const errDeg = Math.acos(dot) * 180 / Math.PI;
      if (errDeg <= Constants.AIM.NET_AIM_TOLERANCE_DEG) { fireNow(); return; }
    }

    // interlocks-p2 R7 (owner Q3 A): the turn to the net's attitude is refused only when a daughter's line would then run
    // through the ship. (AutopilotSystem.requestAimRotation backstops any other net aim with the same test.)
    if (aimDir && d.armManager && typeof d.armManager.netTurnWraps === 'function') {
      const wrap = d.armManager.netTurnWraps(aimDir);
      if (wrap.wraps) {
        refuse(wrapRefusalLine((wrap.arm && wrap.arm.displayName) || 'A daughter'));
        return;
      }
    }

    // Otherwise rotate to attitude, then fire on resolve. Reject = no fire, no
    // inventory decrement (abort comms emitted by AutopilotSystem).
    // sloth mode (D7): the net's lock on a moving piece lasts the aim's own 30 s (AIM_TIMEOUT_S); a slow turn on the tail
    // boxes (the steering gas is out) is refused at once with the honest time (`TOO_SLOW`): nothing moves, no net is spent.
    ap.requestAimRotation(provider, { mode: 'net', aimDir: aimDir || undefined, maxWaitS: Constants.AIM.AIM_TIMEOUT_S })
      .then(() => {
        // §9.6: aim-resolve double-tick — the slew settled on the launch
        // attitude (the "locked, then confirmed" gesture before the thump).
        d.audioSystem?.playAimResolveTick?.();
        // net-refuse-hold: refused at fire time (the target left the envelope during the slew, the net system said
        // no) after the ship has turned: she stays where the turn left her, no thruster fires to turn her back.
        if (!fireNow()) d.player.holdHeadingAfterRefusal?.();
      })
      .catch((err) => {
        // Aborted — nothing fired/spent. A timed-out aim or a lost target is a refusal after the turn: the ship
        // stays where it turned (net-refuse-hold). Manual input / superseded / a deliberate target change keep the
        // normal recenter.
        if (err && (err.code === 'TIMEOUT' || err.code === 'TARGET_LOST')) d.player.holdHeadingAfterRefusal?.();
      });
  }

  /**
   * u20-ipad F2: make `arm` the selected daughter unless she already is. ArmManager.selectArm TOGGLES a selected arm off,
   * so the check comes first. Tolerates a bare arm manager and a missing arm.
   * @param {object} [arm] - an ArmUnit (has `index`)
   * @private
   */
  _selectLaunched(arm) {
    const am = this._deps?.armManager;
    if (!am || !arm || !Number.isInteger(arm.index) || typeof am.selectArm !== 'function') return;
    if (am.selectedArmIndex !== arm.index) am.selectArm(arm.index, { quiet: true });   // her launch line is enough (one comms line)
  }

  /** The arms docked right now: the auto-pick launch announces only one of these that has left the dock. @private */
  _dockedArms(am) {
    return am && am.arms ? am.arms.filter(a => a && a.state === Constants.ARM_STATES.DOCKED) : [];
  }

  /** Smart-default helper — deploys the next docked daughter (mirrors `case 'KeyD':`). */
  deployDaughter() {
    const d = this._deps; if (!d) return;
    if (this.armPilotMode) return;
    if (typeof d.deployArm !== 'function') return;
    const dockedBefore = this._dockedArms(d.armManager);
    d.deployArm();
    eventBus.emit(Events.TUTORIAL_DEPLOY_INPUT);
    if (d.armManager) {
      const deployed = dockedBefore.filter(a => a.state !== 'DOCKED');
      if (deployed.length > 0) {
        const arm = deployed[deployed.length - 1];
        eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
      }
    }
    d.audioSystem?.playClick?.();
  }

  /** Smart-default helper — toggles inspection. Legacy: no live key binding
   *  (the old bare-I inspection key now opens the Codex/Info viewer). Retained
   *  for the OnboardingDirector smart-default dispatcher. */
  toggleInspection() {
    const d = this._deps; if (!d || !d.cameraSystem) return;
    if (this.armPilotMode) {
      const tId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'debris', targetId: tId });
    } else if (d.cameraSystem.currentView === 'INSPECTION') {
      d.cameraSystem.exitInspection();
    } else {
      const lockedId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
      d.cameraSystem.enterInspection(lockedId != null ? 'debris' : 'mother', lockedId);
    }
    d.audioSystem?.playClick?.();
  }

  /** Smart-default helper — cycles the camera view (mirrors `case 'KeyV':`). */
  cycleView() {
    const d = this._deps; if (!d || !d.cameraSystem || this.armPilotMode) return;
    // COMMAND ↔ OVERVIEW toggle (2026-06-03 rev. 2). Inspection is no longer a
    // cycle slot, so no subject plumbing is needed here.
    const lockedId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
    d.cameraSystem.cycleView(lockedId);
    d.audioSystem?.playClick?.();
  }

  /**
   * Perform the daughter capture action with the currently-piloted arm — the
   * single implementation shared by the `KeyN` ARM_PILOT branch and the Space
   * rapid-advance resolver (2026-06-15 dedup, mirrors `fireLasso()`):
   *   STATION_KEEP        → multi-tool dispatch / net capture
   *   TRANSIT / APPROACH  → manual net deploy at the (or nearest) target
   * @returns {boolean} true if a capture action was dispatched.
   */
  captureWithPilotedArm() {
    const d = this._deps;
    if (!d || !this.armPilotMode || !d.cameraSystem) return false;
    const arm = d.cameraSystem.getPilotedArm?.();
    if (!arm) return false;

    if (arm.state === Constants.ARM_STATES.STATION_KEEP) {
      this.captureWithDaughter(arm);
      return true;
    }

    if (arm.state === 'TRANSIT' || arm.state === 'APPROACH') {
      const captureTarget = arm.target
        || this._findNearestDebrisToArm(arm, d.debrisField);
      if (captureTarget) {
        if (!arm.target) arm.target = captureTarget;
        if (!arm.manualNetDeploy()) {
          d.audioSystem?.playClick();
        }
        return true;
      }
      d.audioSystem?.playClick();
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No debris in capture range',
        priority: 'warning',
      });
      return false;
    }

    d.audioSystem?.playClick();
    return false;
  }

  /**
   * Is the piece beyond the reach of the net that N would fire at it, yet inside the reach of a docked daughter that
   * can hold its mass? (DECISIONS §33 row 8: then the one line points at D.)
   *   · the net's reach: the lasso's LASSO_RANGE for a piece ≤ 10 kg, the large net's netMaxReachM above that;
   *   · a daughter's reach: her tether x ARM_DEPLOY_RANGE_FRACTION (the ArmManager deploy-range rule);
   *   · "can hold": spinner <= SPINNER_MAX_CAPTURE_MASS, weaver <= WEAVER_MAX_CAPTURE_MASS.
   * False while the mission-1 tutorial is running (its range beat teaches the autopilot) and when the distance is unknown.
   * @param {object} target — the active target
   * @returns {boolean}
   * @private
   */
  _beyondNetReachButDaughterCan(target) {
    const d = this._deps || {};
    const dir = d.onboardingDirector;
    if (dir && typeof dir.isMastered === 'function' && !dir.isMastered()) return false;   // tutorial still running
    const mass = target.mass || 0;
    const reachM = classifyNetTarget(mass).band === 'lasso'
      ? Constants.LASSO_RANGE
      : netMaxReachM(Constants.CAPTURE_NET.LARGE);
    const distM = this._activeTargetDistanceM(target);
    if (distM == null || !(reachM > 0) || distM <= reachM) return false;
    const arms = d.armManager && d.armManager.arms;
    if (!Array.isArray(arms)) return false;
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      if (!a || a.state !== Constants.ARM_STATES.DOCKED || !a.config) continue;
      const cap = a.config.type === 'weaver' ? Constants.WEAVER_MAX_CAPTURE_MASS : Constants.SPINNER_MAX_CAPTURE_MASS;
      if (mass > cap) continue;
      if (distM <= a.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION) return true;
    }
    return false;
  }

  /**
   * interlocks-p2 R8: is the piece inside the reach of the net that N would fire at it (the lasso's LASSO_RANGE for a
   * piece <= 10 kg, the large net's netMaxReachM above)? True when the distance is unknown (headless mocks).
   * @private
   */
  _withinNetReach(piece) {
    const mass = piece.mass || 0;
    const reachM = classifyNetTarget(mass).band === 'lasso'
      ? Constants.LASSO_RANGE
      : netMaxReachM(Constants.CAPTURE_NET.LARGE);
    const d = this._deps || {};
    if (!piece._scenePosition || !d.player || typeof d.player.getPosition !== 'function') return true;
    const p = d.player.getPosition();
    if (!p) return true;
    const distM = targetRangeM(p, piece._scenePosition);   // net-range: the one shared distance
    return !(reachM > 0) || distM <= reachM;
  }

  /**
   * The daughter, if any, that is HOLDING the active target — N works her tool without pilot mode (DECISIONS §33 row 6).
   * Order: the selected daughter (`armManager.selectedArmIndex`) if she is in STATION_KEEP on the active target, else
   * the first of `armManager.arms` in STATION_KEEP whose `_stationKeepTarget || target` is the active target.
   * @returns {object|null} the ArmUnit, or null (no target, no holder, or no arm manager)
   */
  findHoldingDaughter() {
    const d = this._deps;
    const am = d && d.armManager;
    const target = d && d.targetSelector && typeof d.targetSelector.getActiveTarget === 'function'
      ? d.targetSelector.getActiveTarget() : null;
    if (!am || !Array.isArray(am.arms) || !target) return null;
    const SK = Constants.ARM_STATES.STATION_KEEP;
    // F2: by id, as the claim does - a Tab-selected snapshot of her piece is still her piece (identity `===` missed it
    // and the claim then refused N at a piece she holds).
    const holds = (a) => !!a && a.state === SK && samePiece(a._stationKeepTarget || a.target, target);
    const sel = (am.selectedArmIndex >= 0 && am.selectedArmIndex < am.arms.length) ? am.arms[am.selectedArmIndex] : null;
    if (holds(sel)) return sel;
    for (let i = 0; i < am.arms.length; i++) if (holds(am.arms[i])) return am.arms[i];
    return null;
  }

  /**
   * Work a station-keeping daughter's selected tool: multi-tool dispatch (NET → net capture, MAGNET/GRIPPER/PAD →
   * respective grapple) when DAUGHTER_MULTITOOL is on, else the plain net. The one dispatch shared by the pilot-mode
   * branch (captureWithPilotedArm) and the no-pilot-mode KeyN branch above.
   * @param {object} arm — an ArmUnit in STATION_KEEP
   */
  captureWithDaughter(arm) {
    const d = this._deps;
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')
        && typeof arm.dispatchSelectedTool === 'function') {
      arm.dispatchSelectedTool();
    } else {
      arm.captureFromStationKeep();
    }
    d?.audioSystem?.playClick();
  }

  // ==========================================================================
  // Space "do the next thing" rapid-advance (2026-06-15).
  // ==========================================================================

  /**
   * Build a snapshot of live game state for {@link resolveNextDevAction}.
   * Reads only the deps InputManager already holds; degrades gracefully when
   * any subsystem is missing. Target distance is resolved via
   * {@link _activeTargetDistanceM} (scene units → metres).
   * @returns {import('./DevSequenceAdvancer.js').DevSnapshot}
   * @private
   */
  _buildDevSnapshot() {
    const d = this._deps || {};
    const armPilotMode = !!this.armPilotMode;
    const pilotedArmState = (armPilotMode && d.cameraSystem?.getPilotedArm?.())
      ? d.cameraSystem.getPilotedArm().state : null;

    const activeTarget = d.targetSelector?.getActiveTarget?.() || null;
    const hasTarget = !!activeTarget;

    let trackedContacts = 0;
    try {
      // NOTE (drift): this mirrors the contact/target queries in main.js's
      // OnboardingDirector contextProvider (getDiscoveredCount(true) +
      // getActiveTarget). If the "what counts as a contact" semantics change
      // there, update both sites so the Space resolver and onboarding beat
      // gates stay in agreement.
      if (d.debrisField && typeof d.debrisField.getDiscoveredCount === 'function') {
        trackedContacts = d.debrisField.getDiscoveredCount(true) || 0;
      }
    } catch (_e) { /* best-effort */ }

    // In-range gate: live distance from the player to the active target.
    let inCaptureRange = false;
    if (hasTarget) {
      const rangeM = Number.isFinite(Constants.LASSO_RANGE) ? Constants.LASSO_RANGE : Constants.NET_LOCK_RANGE_M;
      const distM = this._activeTargetDistanceM(activeTarget);
      inCaptureRange = Number.isFinite(distM) && distM <= rangeM;
    }

    // A docked, spring-charged, fuelled daughter is launchable — mirror the
    // real deploy gate in ArmManager._findDockedArm (DOCKED && springCharged &&
    // fuel > 5). A looser check would make Space dispatch DEPLOY while a docked
    // daughter is still recharging, where deployDaughter() silently no-ops.
    let canDeployDaughter = false;
    if (!armPilotMode && d.armManager && Array.isArray(d.armManager.arms)) {
      canDeployDaughter = d.armManager.arms.some(a =>
        a && a.state === Constants.ARM_STATES.DOCKED && a.springCharged
        && (a.fuel == null || a.fuel > 5));
    }

    const autopilotActive = !!(d.autopilotSystem && d.autopilotSystem.engaged);

    return {
      armPilotMode,
      pilotedArmState,
      hasTarget,
      trackedContacts,
      inCaptureRange,
      canDeployDaughter,
      autopilotActive,
    };
  }

  /**
   * Live distance (metres) from the player to a target debris, or null when it
   * can't be resolved. Scene units are 100 km each (1 unit = 100 km), so the
   * canonical conversion is scene-units / SCENE_SCALE → km, ×1000 → metres
   * (matches DebrisField's `distanceKm = dist / SCENE_SCALE`).
   * @param {object} target
   * @returns {number|null}
   * @private
   */
  _activeTargetDistanceM(target) {
    const d = this._deps || {};
    if (!target || !d.player || typeof d.player.getPosition !== 'function') return null;
    let tgtPos = null;
    const ts = d.targetSelector;
    if (ts && typeof ts.getActiveTargetPosition === 'function') {
      tgtPos = ts.getActiveTargetPosition();
    }
    if (!tgtPos) {
      tgtPos = target._scenePosition || target.mesh?.position || null;
    }
    if (!tgtPos) return null;
    const p = d.player.getPosition();
    if (!p) return null;
    return targetRangeM(p, tgtPos);   // net-range: the one shared distance (scene units → metres)
  }

  /**
   * Dispatch the action id chosen by {@link resolveNextDevAction} to the
   * matching InputManager helper.
   * @param {string} action — a DEV_ACTIONS id
   * @private
   */
  _dispatchDevAction(action) {
    switch (action) {
      case DEV_ACTIONS.SCAN:      this.fireScan(); break;
      case DEV_ACTIONS.TARGET:    this.cycleTarget(); break;
      case DEV_ACTIONS.AUTOPILOT: this.engageAutopilot(); break;
      case DEV_ACTIONS.DEPLOY:    this.deployDaughter(); break;
      case DEV_ACTIONS.NET:       this.fireLasso(); break;
      case DEV_ACTIONS.CAPTURE:   this.captureWithPilotedArm(); break;
      default: break;
    }
  }
}
