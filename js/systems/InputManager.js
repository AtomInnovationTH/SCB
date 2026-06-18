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
import timerManager from './TimerManager.js';
import { despinLaser } from './DespinLaser.js';
import { DEV_ACTIONS, resolveNextDevAction } from './DevSequenceAdvancer.js';

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
    this._onWheel = this._handleWheel.bind(this);
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
   * @param {object} deps.orbitMFD
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

    // V-7: Ceremony complete — restore FOV unless entering ARM_PILOT tracking.
    // When ceremony → ARM_PILOT (auto-entry path so the camera stays on the
    // daughter for debris inspection), keep the narrow ~40° FOV and ALSO turn
    // on armPilotMode so arrow-key SK orbit controls + WASD manual thrust work
    // immediately (the player did not have to enter pilot mode manually — the
    // ceremony hands them straight into the daughter).
    // When skipLaunchCeremony → CHASE, snap FOV back to COMMAND default.
    eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, () => {
      const cam = this._deps?.cameraSystem;
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

        if (targets.length > 0) {
          // FIX_PLAN §4: best target = lowest TPI (composite score)
          const next = targets[0];
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
  // PR 6 / P3.13: Audio unlock self-test
  // ========================================================================

  /**
   * On first user gesture (keydown or pointerdown), resume AudioContext and
   * schedule a 200 ms self-test. If still suspended after 200 ms, emit
   * AUDIO_UNLOCK_FAILED so the HUD can display a user-facing toast.
   * @private
   */
  _tryAudioUnlock() {
    if (this._firstGestureHandled) return;
    this._firstGestureHandled = true;

    const audio = this._deps?.audioSystem;
    if (!audio) return;

    // Ensure AudioContext is initialized + resumed
    if (typeof audio.init === 'function') audio.init();
    if (typeof audio.resume === 'function') audio.resume();

    // Schedule a 200 ms verification
    const ctx = audio.ctx;
    if (ctx) {
      this._audioUnlockTimerId = timerManager.setTimeout(() => {
        this._audioUnlockTimerId = null;
        if (ctx.state === 'suspended') {
          console.warn('[Audio] AudioContext still suspended 200ms after user gesture');
          eventBus.emit(Events.AUDIO_UNLOCK_FAILED);
        }
      }, 200, { owner: this });
    }
  }

  /**
   * Pointerdown handler — triggers audio unlock on first click/tap.
   * @param {PointerEvent} _e
   * @private
   */
  _handlePointerDown(_e) {
    this._tryAudioUnlock();
  }

  /** Start listening for keyboard events */
  start() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // SK mouse-wheel zoom (debug session 2026-05-15 polish).
    // Capture-phase so we can preventDefault before CameraSystem's canvas
    // wheel handler (registered separately on the canvas at
    // CameraSystem.js:1519). We only consume the event when armPilotMode
    // && SK active — otherwise we pass through so the camera handler
    // keeps working for the orbital/inspection views.
    window.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
    window.addEventListener('pointerdown', this._onPointerDown);
  }

  /** Stop listening */
  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('pointerdown', this._onPointerDown);
    // PR 6 / P3.13: Clear pending audio unlock timer on teardown
    if (this._audioUnlockTimerId !== null) {
      timerManager.clear(this._audioUnlockTimerId);
      this._audioUnlockTimerId = null;
    }
  }

  /**
   * Mouse-wheel handler — gated to SK arm-pilot mode.
   * Emits one ARM_ORBIT_ADJUST per wheel tick with a `radiusStep`
   * (instantaneous metres delta), NOT a rate. See ArmUnit listener
   * at line ~285 for handling. Direction convention matches the
   * +/- keys: scroll-up → closer (negative step), scroll-down →
   * farther (positive step).
   * @param {WheelEvent} e
   * @private
   */
  _handleWheel(e) {
    // Delegation 2 (2026-05-31) — emit CAMERA_ZOOM_INPUT for the
    // OnboardingDirector regardless of mode.  The actual zoom action is still
    // owned by CameraSystem (chase / inspection) or the SK orbit controls
    // below.  Fire-and-forget; no preventDefault here.
    if (this._deps) {
      eventBus.emit(Events.CAMERA_ZOOM_INPUT);
    }

    if (!this.armPilotMode) return;
    const d = this._deps;
    const skArm = d?.cameraSystem?.getPilotedArm?.();
    if (!skArm || skArm.state !== Constants.ARM_STATES.STATION_KEEP) return;

    // Consume the wheel — prevent page scroll AND the camera's own
    // wheel handler from also zooming the chase camera.
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
   * Handle keydown events — routes to game systems.
   * @param {KeyboardEvent} e
   */
  _handleKeyDown(e) {
    // PR 6 / P3.13: Audio unlock on first keydown gesture
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

    this.keys[e.code] = true;
    const d = this._deps;
    const currentState = d.gameState.currentState;
    const isGameplay = d.gameState.isGameplay();

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
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) {
      if (e.code === 'KeyI') {
        d.codexViewerUI.toggle();
        d.audioSystem.playClick();
        e.preventDefault();
      }
      // ESC is handled by CodexViewerUI's own capture-phase listener
      return; // block all other keys while codex is open
    }

    // --- ST-6.4: Strategic Map intercept — suppress all gameplay input while map is open ---
    if (d.strategicMap && d.strategicMap.isOpen()) {
      if (e.code === 'Escape') {
        d.strategicMap.close();
        d.audioSystem?.playClick();
        e.preventDefault();
      } else if (e.code === 'KeyV' && e.shiftKey) {
        // Shift+V closes the map
        eventBus.emit(Events.STRATEGIC_MAP_TOGGLE);
        d.audioSystem?.playClick();
        e.preventDefault();
      }
      // Block all other keys while strategic map is open
      return;
    }

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

    // ST-5.1: Comms menu intercept removed — center popup deleted.
    // UX-11 #9: the C-hold RadialMenu was also removed. Bare C is now unbound
    // (2026-06-16 cleanup); comms expand lives on the 7 key.

    switch (e.code) {
      // Confirm / Enter action (gameplay only — menu/briefing handle their own Enter)
      case 'Enter':
        if (isGameplay) {
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
      case 'Escape':
        // (ST-6.4: Strategic map Escape handled by top-level intercept above)
        // Debris Map intercept: Escape closes map before other handling
        if (d.debrisMap && d.debrisMap.isVisible()) {
          d.debrisMap.hide();
          e.preventDefault();
          break;
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
            const wasPaused = d.getPaused();
            d.setPaused(!wasPaused);
            if (!wasPaused) {
              // Just paused — show pause overlay
              if (d.hud) d.hud.showPause();
            } else {
              // Unpaused — hide overlay + reset timer
              if (d.hud) d.hud.hidePause();
              d.setLastTime(performance.now());
              // Emit PAUSE_RESUME so the rAF loop in main.js gets woken back
              // up. Without this the gameLoop stays asleep after ESC-unpause
              // (the `_scheduleNextFrame()` wake hook lives behind this event).
              // Symptom prior to this emit: screen froze after pressing ESC
              // to resume because nothing scheduled the next rAF callback.
              eventBus.emit(Events.PAUSE_RESUME);
            }
          }
        }
        break;

      // Camera view toggle (V key) / Strategic Map (Shift+V).
      // 2026-06-15 (2-cycle): V toggles FLY ↔ LOOK AROUND in BOTH mother and
      // daughter (ARM_PILOT) modes — the menu lists "View" as a daughter verb
      // too. Close inspection is no longer a cycle stop; it engages by zooming
      // in while in LOOK AROUND. Backing out of piloting is done by re-pressing
      // the active digit or pressing Esc (the old "V exits pilot" special-case
      // was removed).
      case 'KeyV':
        if (isGameplay) {
          if (e.shiftKey) {
            // ST-6.4: Shift+V → toggle strategic map
            eventBus.emit(Events.STRATEGIC_MAP_TOGGLE);
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (d.cameraSystem) {
            const lockedId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
            d.cameraSystem.cycleView(lockedId);
            d.audioSystem.playClick();
          }
        }
        break;

      // O key — FREED (hotkey revamp 2026-06-14). NavSphere toggle moved to the
      // 8 key (Advanced toggle row). O is currently unbound.

      // Open shop (B key during orbital)
      case 'KeyB':
        if (currentState === GameStates.ORBITAL_VIEW) {
          d.transitionToState(GameStates.SHOP);
        }
        break;

      // M key — "Map" (hotkey revamp 2026-06-14): toggle the Debris Map. The
      // old MPD-armed / Orbit-MFD role on M lost its key in the revamp (not in
      // the help menu). ` (backtick) remains an undocumented Debris-Map alias.
      case 'KeyM':
        if (isGameplay && d.debrisMap && !e.repeat) {
          d.debrisMap.toggle();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // R key — Reel-in, consistent across BOTH mother and daughter modes
      // (2026-06-14 reel-in fix). The help pane labels R "Reel-in" in both
      // cards, so reeling ALWAYS takes priority — the old behavior where a
      // mother-mode R with autopilot engaged silently aborted the AP and
      // reeled NOTHING (the AP-abort branch sat ahead of the recall branch)
      // made R feel dead for the deployed daughter. Order now:
      //   (1) ARM_PILOT       → reel the piloted daughter home (any live state)
      //   (2) Mother + deployed → recall closest deployed daughter
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
                    : 'No deployed daughters to reel in.',
                  priority: 'info',
                });
              }
            }
            break;
          }
          // (1) ARM_PILOT: reel the piloted daughter home — from ANY state.
          // recall() routes STATION_KEEP through reelFromStationKeep and sends
          // every other live state (TRANSIT / APPROACH / HOLDING_CATCH / …) into
          // a zero-fuel REELING return on the mother's tether motor, so R always
          // brings the daughter you're flying back home (was SK-only — R did
          // nothing mid-flight, 2026-06-14 fix).
          if (this.armPilotMode) {
            const pilotArmR = d.cameraSystem?.getPilotedArm?.();
            if (pilotArmR && typeof pilotArmR.recall === 'function'
                && pilotArmR.state !== Constants.ARM_STATES.DOCKED
                && pilotArmR.state !== Constants.ARM_STATES.EXPENDED) {
              pilotArmR.recall({ motherInitiated: true });
              d.audioSystem?.playClick();
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
          // (2) Mother mode: reel the closest deployed daughter FIRST. Reeling
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
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'SPACECRAFT', channel: 'CMD',
              text: 'Autopilot aborted by command.',
              priority: 'info',
            });
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
            d.audioSystem?.playClickFail?.();
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
      //   Ctrl+D       → debug overlay (unchanged)
      //   Ctrl+Shift+D → deorbit sacrifice (unchanged)
      case 'KeyD':
        if (e.ctrlKey && e.shiftKey && isGameplay) {
          e.preventDefault();
          eventBus.emit(Events.ARM_DEORBIT_CMD);
        } else if (e.ctrlKey) {
          e.preventDefault();
          if (d.debugOverlay) d.debugOverlay.toggle();
        } else if (e.shiftKey && isGameplay && d.armManager && !e.repeat) {
          // Shift+D: deploy all docked arms to selected target
          const allTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          d.armManager.deployAllToTarget(allTarget);
          d.audioSystem?.playClick();
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
          if (selArm && selArm.state === Constants.ARM_STATES.DOCKED) {
            deployedOk = am.deployArmByIndex(selIdx, target);
          } else {
            d.deployArm();   // auto-pick best docked arm
            deployedOk = true;
          }
          // Notify tutorial / discovery before the ceremony for ordering.
          eventBus.emit(Events.TUTORIAL_DEPLOY_INPUT);
          if (deployedOk && am) {
            const deployed = am.arms.filter(a =>
              a.state !== 'DOCKED' && a.state !== 'EXPENDED' &&
              a.state !== 'RETURNING' && a.state !== 'DOCKING'
            );
            if (deployed.length > 0) {
              const arm = deployed[deployed.length - 1];
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: `Daughter ${arm.id} deployed. Tracking…`,
                priority: 'info',
              });
              eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
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

      // F key — "Forge" (hotkey revamp 2026-06-14): toggle the Forge/Kiln. The
      // old Focus Action role lost its key (not in the help menu). Works in
      // both mother and daughter modes.
      case 'KeyF':
        if (isGameplay && !e.repeat) {
          eventBus.emit(Events.FORGE_TOGGLE);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // C key — FREED (hotkey cleanup 2026-06-16). Bare C used to duplicate the
      // 7 key's comms expand (both emitted COMMS_FOCUS + COMMS_OPENED), so the
      // redundant binding was removed: 7 is the single comms key now. C is left
      // unbound/available (joining the already-free W, Y, O, ',').
      // Shift+C city-labels moved to 5 in the 2026-06-14 revamp and is also free.

      // ST-5.1: PageUp / PageDown — comms history scrolling
      case 'PageUp':
        if (isGameplay) {
          eventBus.emit(Events.COMMS_SCROLL_UP);
          e.preventDefault();
        }
        break;
      case 'PageDown':
        if (isGameplay) {
          eventBus.emit(Events.COMMS_SCROLL_DOWN);
          e.preventDefault();
        }
        break;

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
          const arms = d.armManager.arms;
          // Toggle: if any docked strut is past halfway-deployed, stow all;
          // otherwise deploy all (α → π zenith).
          const anyDeployed = arms.some(a =>
            a.state === Constants.ARM_STATES.DOCKED && (a._strutTargetAlpha ?? 0) >= Math.PI / 2);
          const targetAlpha = anyDeployed ? 0 : Math.PI;
          for (const arm of arms) {
            if (arm.state === Constants.ARM_STATES.DOCKED) {
              arm._strutTargetAlpha = targetAlpha;
            }
          }
          d.audioSystem?.playClick();
          // Delegation 2 onboarding (2026-05-31): notify the OnboardingDirector.
          eventBus.emit(Events.STRUT_DEPLOY_INPUT);
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
        if (isGameplay) {
          eventBus.emit(Events.CITY_LABELS_TOGGLE);
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;
      case 'Digit6':
        if (isGameplay && d.starfield && typeof d.starfield.toggleConstellations === 'function') {
          d.starfield.toggleConstellations();
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

      // --- F14: Throttle level +/- in 10% increments ---
      case 'Equal':      // + key (=/+ on US keyboards)
      case 'NumpadAdd':   // Numpad +
        if (isGameplay && d.player) {
          // ST-8.2.1: +/- reused for orbital radius in STATION_KEEP
          const _skPlus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skPlus && _skPlus.state === Constants.ARM_STATES.STATION_KEEP) break;
          const newUp = Math.min(1.0, d.player.throttleLevel + 0.1);
          d.player.setThrottleLevel(Math.round(newUp * 10) / 10);
          d.audioSystem.playClick();
          e.preventDefault();
          // Phase C: Notify tutorial of throttle change
          eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
          // Delegation 2 onboarding (2026-05-31): +/- doubles as a zoom verb
          // for the camera-zoom beat (mouse wheel is canonical, but the
          // keyboard alias should also satisfy the beat).
          eventBus.emit(Events.CAMERA_ZOOM_INPUT);
        }
        break;
      case 'Minus':       // - key
      case 'NumpadSubtract': // Numpad -
        if (isGameplay && d.player) {
          // ST-8.2.1: +/- reused for orbital radius in STATION_KEEP
          const _skMinus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skMinus && _skMinus.state === Constants.ARM_STATES.STATION_KEEP) break;
          const newDown = Math.max(0.0, d.player.throttleLevel - 0.1);
          d.player.setThrottleLevel(Math.round(newDown * 10) / 10);
          d.audioSystem.playClick();
          e.preventDefault();
          // Phase C: Notify tutorial of throttle change
          eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
          // Delegation 2 onboarding (2026-05-31): see Equal case above.
          eventBus.emit(Events.CAMERA_ZOOM_INPUT);
        }
        break;

      // --- Backtick: Toggle Debris Map (strategic overlay). In ARM_PILOT
      //     STATION_KEEP it cycles the piloted arm's tool instead. The old
      //     Shift+` mother-side tool cycle was removed (hotkey cleanup
      //     2026-06-13b) — that verb now lives on T. ---
      case 'Backquote':
        if (isGameplay && !e.repeat) {
          // CP-1 / P2: plain backtick in STATION_KEEP cycles the piloted arm's
          // tool (NET → … → MAGNET). Captured before the Debris-Map toggle.
          const tcArm = this.armPilotMode && d.cameraSystem?.getPilotedArm?.();
          if (tcArm && tcArm.state === Constants.ARM_STATES.STATION_KEEP
              && Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')
              && typeof tcArm.cycleTool === 'function') {
            tcArm.cycleTool();
            e.preventDefault();
            break;
          }
          if (d.debrisMap) {
            d.debrisMap.toggle();
          }
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // --- F17: Toggle Codex Library / Info (I key) ---
      case 'KeyI':
        if (isGameplay && d.codexViewerUI) {
          d.codexViewerUI.toggle();
          d.audioSystem.playClick();
          // Skills discovery: codex opened
          eventBus.emit(Events.CODEX_OPENED);
          e.preventDefault();
        }
        break;

      // --- ? (Slash) — Toggle the grouped keyboard-shortcut reference overlay.
      //     Backquote (~) is already the Debris Map toggle, so the help list
      //     uses the conventional "?" key instead. ---
      case 'Slash':
        if (isGameplay && d.hotkeyOverlay && !e.repeat) {
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
   * Shift+N "Auto-target + launch at debris in range" (hotkey revamp
   * 2026-06-14): acquire the best in-range debris (top of the TPI-sorted HUD
   * list, honoring the tracked/IR filter), make it the active target, then
   * deploy ALL docked daughters at it. Warns via comms when nothing is in
   * range or no arms are available.
   * @private
   */
  _autoTargetAndLaunch() {
    const d = this._deps;
    let acquired = null;
    try {
      const list = d.debrisField.getEnhancedTargetList(
        d.player.getPosition(), d.player.getOrbitalElements()
      );
      const canDetect = d.sensorSystem && d.sensorSystem.canDetectUntracked;
      const eligible = list.filter(t => t.tracked !== false || canDetect);
      if (eligible.length > 0) {
        const t = eligible[0]; // best TPI rank
        const debris = d.debrisField.getDebrisById(t.id);
        if (debris) {
          d.targetSelector.setTarget(debris, { distanceKm: t.distanceKm, deltaV: t.deltaV });
          if (d.debrisWireframe) d.debrisWireframe.setTarget(debris);
          d.hud.setSelectedTarget(t.id);
          if (d.targetReticle) d.targetReticle.setSelectedTarget(t.id);
          if (d.navSphere) d.navSphere.setSelectedTarget(t.id);
          acquired = debris;
        }
      }
    } catch (err) {
      console.error('[auto-target-launch] error:', err);
    }
    if (!acquired) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD',
        text: 'No debris in range to auto-target.',
        priority: 'warning',
      });
      return;
    }
    if (d.armManager && typeof d.armManager.deployAllToTarget === 'function') {
      d.armManager.deployAllToTarget(acquired);
    }
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

    // (1) Mother → field center. Prefer the "best cluster" helper; fall back to
    // the currently-selected cluster for older DebrisMap stubs.
    if (d.debrisMap) {
      if (typeof d.debrisMap.engageBestCluster === 'function') {
        d.debrisMap.engageBestCluster();
      } else if (typeof d.debrisMap.engageSelectedCluster === 'function') {
        d.debrisMap.engageSelectedCluster();
      }
    }

    // Build the TPI-sorted, tracked/IR-filtered eligible debris list once.
    let eligible = [];
    try {
      const list = d.debrisField.getEnhancedTargetList(
        d.player.getPosition(), d.player.getOrbitalElements()
      );
      const canDetect = d.sensorSystem && d.sensorSystem.canDetectUntracked;
      eligible = list.filter(t => t.tracked !== false || canDetect);
    } catch (err) {
      console.error('[field-center-salvage] target list error:', err);
    }

    // Count docked, spring-charged daughters so we can carve out distinct
    // targets for them and reserve a SEPARATE one for the mother net.
    const arms = (d.armManager && Array.isArray(d.armManager.arms)) ? d.armManager.arms : [];
    const dockedCount = arms.filter(a =>
      a && a.state === Constants.ARM_STATES.DOCKED && a.springCharged).length;

    // Resolve debris objects for the top-N (one per docked daughter).
    const daughterDebris = [];
    const claimedIds = new Set();
    for (const t of eligible) {
      if (daughterDebris.length >= dockedCount) break;
      const debris = d.debrisField.getDebrisById(t.id);
      if (debris) {
        daughterDebris.push(debris);
        claimedIds.add(t.id);
      }
    }

    // (3) Pick the mother-net target: best in-range debris NOT claimed by a
    // daughter (separate target). Falls back to none when the field is small.
    let netTarget = null;
    for (const t of eligible) {
      if (claimedIds.has(t.id)) continue;
      const debris = d.debrisField.getDebrisById(t.id);
      if (debris) { netTarget = debris; break; }
    }

    // (2) Fan the daughters out to distinct debris. Surplus daughters (more
    // daughters than debris) fall back to the mother's active target.
    if (d.armManager && typeof d.armManager.deployAllToDistinctTargets === 'function') {
      const fallback = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
      d.armManager.deployAllToDistinctTargets(daughterDebris, fallback);
    } else if (d.armManager && typeof d.armManager.deployAllToTarget === 'function') {
      // Legacy fallback: single-target deploy-all.
      d.armManager.deployAllToTarget(daughterDebris[0] || (d.targetSelector ? d.targetSelector.getActiveTarget() : null));
    }

    // (3 cont.) Fire the mother net at its separate target. Make it the active
    // target so fireLasso() casts at it, then fire.
    if (netTarget && d.lassoSystem) {
      if (d.targetSelector && typeof d.targetSelector.setTarget === 'function') {
        d.targetSelector.setTarget(netTarget);
        if (d.debrisWireframe) d.debrisWireframe.setTarget(netTarget);
        if (d.hud) d.hud.setSelectedTarget(netTarget.id);
        if (d.targetReticle) d.targetReticle.setSelectedTarget(netTarget.id);
        if (d.navSphere) d.navSphere.setSelectedTarget(netTarget.id);
      }
      this.fireLasso();
    } else if (!netTarget && daughterDebris.length === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD',
        text: 'No debris in range. Closing on field center.',
        priority: 'warning',
      });
    }
  }

  /**
   * (hotkey revamp 2026-06-14, "spinning plates"; P / Shift+P removed):
   *   • DOCKED   → SELECT only (glow/flash via ARM_SELECT). Mother stays in
   *     view; the player then launches the selected daughter with D. NO deploy,
   *     NO camera switch (D1).
   *   • DEPLOYED → SELECT + switch camera to that daughter (pilot it).
   *   • EXPENDED → warn.
   *   • Re-press the ACTIVE daughter's digit → return to mother: exit the pilot
   *     camera + deselect WITHOUT recalling (the daughter keeps working — this
   *     is the canonical "pop back" toggle that replaced P's exit role).
   * Arms 5-8 are deferred until tiers ship (D2) — only digits 1-4 exist today.
   * @private
   * @param {number} armIndex - 0-based arm index
   */
  _handleArmKey(armIndex) {
    const d = this._deps;
    if (!d.armManager) return;

    const arm = d.armManager.arms[armIndex];
    if (!arm) return;

    // Toggle: re-pressing the active daughter's digit returns to mother.
    // Exit the pilot camera (if piloting) and deselect — but do NOT recall;
    // a launched daughter keeps station-keeping / working ("spinning plates").
    if (d.armManager.selectedArmIndex === armIndex) {
      this._exitArmPilotCamera();
      d.armManager.deselectArm();
      return;
    }

    if (arm.state === Constants.ARM_STATES.DOCKED) {
      // SELECT only (D1) — the docked arm glows/flashes (ARM_SELECT). Mother
      // stays in view; launch the selected daughter with D (pick-then-launch).
      d.armManager.selectArm(armIndex);
    } else if (arm.state === Constants.ARM_STATES.EXPENDED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.id} is expended. Not available`,
        priority: 'warning',
      });
    } else {
      // Arm is deployed — select it for piloting + camera follow.
      d.armManager.selectArm(armIndex);
      this._enterArmPilotCamera(arm);
    }
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

    // Unambiguous get-out guidance: in ARM_PILOT the V key does NOT toggle to
    // Overview — it backs the camera out to Command view (and releases the
    // daughter). New players can otherwise feel "stuck" piloting the daughter,
    // so spell out the way home the moment they enter.
    if (!wasPiloting) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Piloting ${arm.id}. Arrow keys fly it · press V to back out to Command view.`,
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
    const nearby = debrisField.getDebrisNear(arm.position, captureRange);
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
      || (d.debrisMap && d.debrisMap.isVisible && d.debrisMap.isVisible())
      || (d.strategicMap && d.strategicMap.isOpen && d.strategicMap.isOpen()));
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

    // ST-6.4: Suppress continuous input while strategic map is open
    if (d.strategicMap && d.strategicMap.isOpen()) return;

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

    if (!apEngaged && !_inStationKeep) {
      // FIX_PLAN §3: Tether-aware rotation with exponential spring resistance.
      //   effectiveRate = baseRate · (1 − |θ|/θ_max)^STIFFNESS    (when pushing toward limit)
      //   effectiveRate = baseRate                                 (when relieving toward neutral)
      // On no-input frames, displacement bleeds toward 0 at SPRINGBACK_RATE.
      const tier     = d.armManager?.getRotationLockTier?.() || 'none';
      const baseRate = Constants.SATELLITE_ROTATION_RATE;

      if (tier === 'none') {
        // Free flight — reset spring bookkeeping so next deployment starts at neutral
        this._tetherPitchDisp = 0;
        this._tetherYawDisp   = 0;
        if (this.keys['ArrowUp'])    { d.player.rotatePitch( baseRate * dt); d.player.setThrusterFire('pitch',  1, 1); }
        if (this.keys['ArrowDown'])  { d.player.rotatePitch(-baseRate * dt); d.player.setThrusterFire('pitch', -1, 1); }
        if (this.keys['ArrowLeft'])  { d.player.rotateYaw( baseRate * dt);  d.player.setThrusterFire('yaw',    1, 1); }
        if (this.keys['ArrowRight']) { d.player.rotateYaw(-baseRate * dt);  d.player.setThrusterFire('yaw',   -1, 1); }
      } else {
        const TR         = Constants.TETHER_ROTATION;
        const maxDisp    = (tier === 'block') ? TR.MAX_DISPLACEMENT_BLOCK : TR.MAX_DISPLACEMENT_SOFT;
        const springback = (tier === 'block') ? TR.SPRINGBACK_RATE_BLOCK   : TR.SPRINGBACK_RATE_SOFT;
        const stiffness  = TR.STIFFNESS_EXPONENT;

        // Lazy-init per-axis displacement bookkeeping
        if (this._tetherPitchDisp === undefined) this._tetherPitchDisp = 0;
        if (this._tetherYawDisp   === undefined) this._tetherYawDisp   = 0;

        // Net per-axis input direction (+1 / 0 / -1)
        let pitchIn = 0, yawIn = 0;
        if (this.keys['ArrowUp'])    pitchIn += 1;
        if (this.keys['ArrowDown'])  pitchIn -= 1;
        if (this.keys['ArrowLeft'])  yawIn   += 1;
        if (this.keys['ArrowRight']) yawIn   -= 1;

        // Closure: compute (rotation delta, new displacement) for one axis
        const applyAxis = (disp, input) => {
          if (input === 0) {
            // No input → spring-back decay toward 0
            const decay = springback * dt;
            if (Math.abs(disp) <= decay) return { delta: 0, newDisp: 0 };
            return { delta: 0, newDisp: disp - Math.sign(disp) * decay };
          }
          // Input present — relief or resistance?
          const movingTowardCenter = (disp !== 0) && (Math.sign(disp) !== input);
          let rate;
          if (movingTowardCenter) {
            rate = baseRate; // unconstrained re-centering
          } else {
            const norm = Math.min(1, Math.abs(disp) / maxDisp);
            rate = baseRate * Math.pow(1 - norm, stiffness);
          }
          const delta   = input * rate * dt;
          const newDisp = Math.max(-maxDisp, Math.min(maxDisp, disp + delta));
          return { delta, newDisp };
        };

        const pitchRes = applyAxis(this._tetherPitchDisp, pitchIn);
        const yawRes   = applyAxis(this._tetherYawDisp,   yawIn);
        if (pitchRes.delta !== 0) {
          d.player.rotatePitch(pitchRes.delta);
          // Differential plume: magnitude = fraction of baseRate actually applied (spring reduces it)
          const pMag = dt > 0 ? Math.min(1, Math.abs(pitchRes.delta) / (baseRate * dt)) : 0;
          d.player.setThrusterFire('pitch', Math.sign(pitchRes.delta), pMag);
        }
        if (yawRes.delta !== 0) {
          d.player.rotateYaw(yawRes.delta);
          const yMag = dt > 0 ? Math.min(1, Math.abs(yawRes.delta) / (baseRate * dt)) : 0;
          d.player.setThrusterFire('yaw', Math.sign(yawRes.delta), yMag);
        }
        this._tetherPitchDisp = pitchRes.newDisp;
        this._tetherYawDisp   = yawRes.newDisp;

        // Comms warning — only when actively pushing into a saturated limit
        const satThresh     = TR.SATURATION_THRESHOLD;
        const pitchSat      = Math.abs(this._tetherPitchDisp) >= maxDisp * satThresh;
        const yawSat        = Math.abs(this._tetherYawDisp)   >= maxDisp * satThresh;
        const fightingPitch = pitchIn !== 0 && Math.sign(this._tetherPitchDisp) === pitchIn;
        const fightingYaw   = yawIn   !== 0 && Math.sign(this._tetherYawDisp)   === yawIn;
        if ((pitchSat && fightingPitch) || (yawSat && fightingYaw)) {
          this._maybeEmitTetherLockMsg();
        }
      }
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
    this._lassoWindingUp = true;
    d.audioSystem?.playClick?.();
    const windupMs = (Constants.LASSO_CAST_WINDUP || 0.15) * 1000;
    this._lassoWindupTimeout = setTimeout(() => {
      this._lassoWindingUp = false;
      this._lassoWindupTimeout = null;
      const vel = d.player.getVelocity();
      const velDir = new THREE.Vector3(vel.x, vel.y, vel.z);
      if (velDir.lengthSq() > 0) velDir.normalize();
      const activeTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
      d.lassoSystem.fire(d.player.getPosition(), d.debrisField, velDir, activeTarget);
    }, windupMs);
  }

  /** Smart-default helper — deploys the next docked daughter (mirrors `case 'KeyD':`). */
  deployDaughter() {
    const d = this._deps; if (!d) return;
    if (this.armPilotMode) return;
    if (typeof d.deployArm !== 'function') return;
    d.deployArm();
    eventBus.emit(Events.TUTORIAL_DEPLOY_INPUT);
    if (d.armManager) {
      const deployed = d.armManager.arms.filter(a =>
        a.state !== 'DOCKED' && a.state !== 'EXPENDED' &&
        a.state !== 'RETURNING' && a.state !== 'DOCKING'
      );
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
      // Multi-tool dispatch (NET → net capture, MAGNET/GRIPPER/PAD → respective
      // grapple) when DAUGHTER_MULTITOOL is on; else plain net.
      if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')
          && typeof arm.dispatchSelectedTool === 'function') {
        arm.dispatchSelectedTool();
      } else {
        arm.captureFromStationKeep();
      }
      d.audioSystem?.playClick();
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
      const rangeM = Number.isFinite(Constants.LASSO_RANGE) ? Constants.LASSO_RANGE : 200;
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
    const dx = p.x - tgtPos.x, dy = p.y - tgtPos.y, dz = p.z - tgtPos.z;
    const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const scale = Number.isFinite(Constants.SCENE_SCALE) && Constants.SCENE_SCALE > 0
      ? Constants.SCENE_SCALE : 0.01;
    return (distScene / scale) * 1000; // scene → km → metres
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
