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
    /** @type {string} Current WASD control mode — 'RCS'|'COLD_GAS'|'ARM_PILOT'|'MPD_BURST' */
    this._controlMode = 'RCS';

    // S4: Lasso windup state
    /** @type {boolean} Whether lasso is in windup phase */
    this._lassoWindingUp = false;
    /** @type {number|null} Windup timeout handle */
    this._lassoWindupTimeout = null;

    // ST-5.1: C-key tap/hold discrimination
    /** @type {number|null} C keydown timestamp */
    this._cKeyDownTs = null;
    /** @type {number|null} C-hold timeout handle */
    this._cHoldTimeout = null;
    /** @type {boolean} Whether radial menu is currently open from C-hold */
    this._cRadialOpen = false;

    // Bind handlers for add/removeEventListener
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);
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
            text: 'ARM PILOT disengaged — arm expended',
            priority: 'warning',
          });
        }
      }
    };
    eventBus.on(Events.ARM_RETURNED, (data) => handleArmPilotExit(data, false));
    eventBus.on(Events.ARM_EXPENDED, (data) => handleArmPilotExit(data, true));

    // V-7: Ceremony complete — restore FOV unless entering ARM_PILOT tracking.
    // When ceremony → ARM_PILOT (auto-entry path so the camera stays on the
    // daughter for debris inspection), keep the narrow ~40° FOV and ALSO turn
    // on armPilotMode so arrow-key SK orbit controls + WASD manual thrust work
    // immediately without requiring the player to press P.
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
      if (capturedId == null) {
        console.log('[AUTO-TARGET] handleCaptureAdvance: skipped — capturedId is null/undefined');
        return;
      }
      console.log('[AUTO-TARGET] handleCaptureAdvance: entry, capturedId=', capturedId);

      const d = this._deps;
      if (!d.targetSelector || !d.debrisField || !d.player) {
        console.log('[AUTO-TARGET] handleCaptureAdvance: skipped — missing deps (targetSelector=%s, debrisField=%s, player=%s)',
          !!d.targetSelector, !!d.debrisField, !!d.player);
        return;
      }

      // Mark the captured debris so reticle stops rendering it immediately
      const capturedDebris = d.debrisField.getDebrisById(capturedId);
      if (capturedDebris) capturedDebris._captured = true;

      // Clear current target if it matches captured debris
      const current = d.targetSelector.getActiveTarget();
      if (current && current.id === capturedId) {
        console.log('[AUTO-TARGET] handleCaptureAdvance: clearing current target (matches captured)');
        d.targetSelector.clearTarget();
      }

      // If a valid (non-captured) target already exists, skip re-selection.
      // This prevents double TARGET_SELECTED emissions when both LASSO_CAPTURED
      // and ARM_CAPTURED call handleCaptureAdvance for the same debris, while
      // still allowing retries when the primary path failed (no target set).
      const existingTarget = d.targetSelector.getActiveTarget();
      if (existingTarget) {
        console.log('[AUTO-TARGET] handleCaptureAdvance: skipped — already has target id=%s', existingTarget.id);
        return;
      }

      // Auto-select next best target (keeps gameplay flowing)
      try {
        const playerPos = d.player.getPosition();
        const playerOrbit = d.player.getOrbitalElements();
        if (!playerPos || !playerOrbit) {
          console.log('[AUTO-TARGET] handleCaptureAdvance: no playerPos/playerOrbit');
          return;
        }

        const targets = d.debrisField.getEnhancedTargetList(playerPos, playerOrbit)
          .filter(t => t.id !== capturedId && !t._captured &&
            (t.tracked !== false || (d.sensorSystem && d.sensorSystem.canDetectUntracked)));

        console.log('[AUTO-TARGET] handleCaptureAdvance: candidates=%d', targets.length);

        if (targets.length > 0) {
          const next = targets[0]; // Best target (sorted by deltaV)
          const debris = d.debrisField.getDebrisById(next.id);
          if (debris) {
            console.log('[AUTO-TARGET] handleCaptureAdvance: selecting next target id=%s type=%s deltaV=%s',
              next.id, debris.type, next.deltaV?.toFixed(3));
            d.targetSelector.setTarget(debris, { distanceKm: next.distanceKm, deltaV: next.deltaV });
            // UI updates in separate try/catch — must not prevent target selection
            try {
              if (d.debrisWireframe) d.debrisWireframe.setTarget(debris);
              if (d.hud) d.hud.setSelectedTarget(next.id);
              if (d.targetReticle) d.targetReticle.setSelectedTarget(next.id);
              if (d.navSphere) d.navSphere.setSelectedTarget(next.id);
              console.log('[AUTO-TARGET] handleCaptureAdvance: UI sync done (hud=%s, reticle=%s, navSphere=%s)',
                !!d.hud, !!d.targetReticle, !!d.navSphere);
            } catch (uiErr) {
              console.warn('[AUTO-TARGET] handleCaptureAdvance: UI sync failed:', uiErr.message);
            }
            this.targetIndex = 0;
          } else {
            console.log('[AUTO-TARGET] handleCaptureAdvance: getDebrisById(%s) returned null', next.id);
          }
        } else {
          console.log('[AUTO-TARGET] handleCaptureAdvance: no candidates after filtering');
        }
      } catch (err) {
        console.warn('[AUTO-TARGET] handleCaptureAdvance: exception:', err.message, err.stack);
      }
    };

    // FIX: ARM_CAPTURED from LassoSystem uses { debrisId } not { targetId }.
    // Accept both keys so lasso captures have a backup auto-advance path.
    // FIX: Use != null checks so debris ID 0 is valid (0 is falsy but a valid ID).
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      const id = data && (data.targetId != null ? data.targetId : data.debrisId);
      if (id != null) {
        console.log('[AUTO-TARGET] ARM_CAPTURED handler: id=', id);
        handleCaptureAdvance(id);
      }
    });
    eventBus.on(Events.LASSO_CAPTURED, (data) => {
      if (data && data.debrisId != null) {
        console.log('[AUTO-TARGET] LASSO_CAPTURED handler: debrisId=', data.debrisId);
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
        console.log('[AUTO-TARGET] DEBRIS_REMOVED microtask fallback: no target set, retrying with removedId=', removedId);
        handleCaptureAdvance(removedId);
      });
    });

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
  }

  /** Stop listening */
  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('wheel', this._onWheel, { capture: true });
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
    // Bare KeyI is dropped to defeat phantom keystrokes from macOS
    // Voice Control / dictation ASR misrecognizing in-game audio as 'i'
    // (debug session 2026-05-10 — events arrive with `isTrusted: true`
    // because ASR injects through the OS HID layer). Inspection mode
    // now requires Shift+I (handled in the KeyI case below).
    if (e.code === 'KeyI' && !e.shiftKey) {
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
      if (d.autopilotSystem && d.autopilotSystem.engaged && !_inSkForGuard) {
        console.warn('[DBG-ARROW-AP] Arrow key disengaging autopilot!',
          'code=', e.code,
          'armPilotMode=', this.armPilotMode,
          'cameraView=', d.cameraSystem?.getView?.(),
          'pilotedArmState=', d.cameraSystem?.getPilotedArm?.()?.state);
        d.autopilotSystem.disengage('ARROW_INPUT');
      } else if (_inSkForGuard && d.autopilotSystem && d.autopilotSystem.engaged) {
        // Verbose-but-useful: confirm the guard fired so future regressions
        // are easy to spot. keydown is one-shot, no throttle needed.
        console.log('[DBG-ARROW-AP] Arrow consumed by SK orbit controls; mother AP preserved.',
          'arm=', _skArmForGuard.id);
      }
      // Phase C: Notify tutorial of arrow key press
      eventBus.emit(Events.TUTORIAL_ARROW_INPUT);
    }

    // --- F17: Codex overlay intercept — suppress all input except L (toggle) and ESC (close) ---
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) {
      if (e.code === 'KeyL') {
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
    // ST-5.1: Pass through C-hold, PageUp, PageDown for comms pane interaction
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
        case 'KeyC':
        case 'PageUp':
        case 'PageDown':
          break; // fall through to normal handling
        default:
          return; // block all other keys while debris map is open
      }
    }

    // V-7: Launch ceremony — ESC aborts to CHASE, G deploys another arm,
    // Space/Enter skip ahead to ARM_PILOT. All other keys are blocked
    // so the player watches the daughter deploy without accidental skip.
    if (d.cameraSystem?._launchCeremony?.active) {
      if (e.code === 'Escape') {
        d.cameraSystem.skipLaunchCeremony(false); // return to CHASE
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyG') {
        // Second G press: skip ceremony, new deploy will start its own ceremony
        d.cameraSystem.skipLaunchCeremony(false);
        // Fall through to KeyG handler to deploy new arm
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
    // RadialMenu handles command selection via C-hold + mouse.

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

      // Cycle targets
      case 'Tab':
        if (isGameplay) {
          try {
            // Use same target list as HUD (tracked debris sorted by delta-V)
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
            console.error('[Tab] target cycling error:', err);
          }
          // Notify tutorial of Tab press
          eventBus.emit(Events.TUTORIAL_TAB_INPUT);
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
            }
          }
        }
        break;

      // Camera view cycling (V key) / Strategic Map (Shift+V)
      case 'KeyV':
        if (isGameplay) {
          if (e.shiftKey) {
            // ST-6.4: Shift+V → toggle strategic map
            eventBus.emit(Events.STRATEGIC_MAP_TOGGLE);
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (d.cameraSystem) {
            // Plain V → camera cycle (existing behaviour)
            if (this.armPilotMode) {
              this._exitArmPilotCamera();
              if (d.armManager) d.armManager.deselectArm();
            } else if (d.cameraSystem.currentView === 'INSPECTION') {
              // S2.1: exit inspection before cycling
              d.cameraSystem.exitInspection();
            } else {
              d.cameraSystem.cycleView();
            }
            d.audioSystem.playClick();
          }
        }
        break;

      // Inspection camera toggle (Shift+I key) — bare 'i' dropped above to
      // defeat ASR/dictation phantom keystrokes (debug session 2026-05-10).
      case 'KeyI':
        if (isGameplay && d.cameraSystem && !this.armPilotMode && !e.repeat && e.shiftKey) {
          if (d.cameraSystem.currentView === 'INSPECTION') {
            d.cameraSystem.exitInspection();
          } else {
            d.cameraSystem.enterInspection();
          }
          d.audioSystem?.playClick();
        }
        break;

      // S2.2: Deploy all arms (O key) / Recall all (Shift+O)
      case 'KeyO':
        if (isGameplay && d.armManager && !this.armPilotMode && !e.repeat) {
          if (e.shiftKey) {
            // Shift+O: recall all deployed arms
            d.armManager.recallAll();
          } else {
            // O: deploy all docked arms to selected target
            const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
            d.armManager.deployAllToTarget(target);
          }
          d.audioSystem?.playClick();
        }
        break;

      // Open shop (B key during orbital)
      case 'KeyB':
        if (currentState === GameStates.ORBITAL_VIEW) {
          d.transitionToState(GameStates.SHOP);
        }
        break;

      // M key: MPD Armed toggle (S3b) — falls back to Orbit MFD if no MPD
      case 'KeyM':
        if (isGameplay && d.player && d.player.hasMPD) {
          d.player.toggleMPDArmed();
          d.audioSystem.playClick();
        } else if (d.orbitMFD) {
          d.orbitMFD.toggle();
          // Skills discovery: orbit MFD toggled
          eventBus.emit(Events.ORBIT_MFD_TOGGLE);
        }
        break;

      // R key — Forge toggle (Phase R3), BUT recall/reel-in during SK
      case 'KeyR':
        if (isGameplay) {
          // During STATION_KEEP: R = reel in (zero-fuel strut motor).
          // Use case: daughter missed target, out of nets, or out of fuel.
          const _skArmR = this.armPilotMode && d.cameraSystem?.getPilotedArm?.();
          if (_skArmR && _skArmR.state === Constants.ARM_STATES.STATION_KEEP) {
            _skArmR.reelFromStationKeep();
            e.preventDefault();
            break;
          }
          eventBus.emit(Events.FORGE_TOGGLE);
          d.audioSystem.playClick();
          e.preventDefault();
        }
        break;

      // Toggle ARM PILOT mode (P key)
      case 'KeyP':
        if (isGameplay) {
          // [DBG-ARM] Log P-key entry state
          console.log(
            `[DBG-ARM] P-KEY pressed armPilotMode=${this.armPilotMode} ` +
            `hasArmManager=${!!d.armManager} ` +
            `selectedArmIndex=${d.armManager?.selectedArmIndex}`
          );
          if (this.armPilotMode) {
            // Exit arm pilot mode
            console.log(`[DBG-ARM] P-KEY → exit arm pilot mode`);
            this._exitArmPilotCamera();
            if (d.armManager) d.armManager.deselectArm();
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: 'ARM PILOT disengaged',
              priority: 'info',
            });
          } else {
            // Enter arm pilot mode — prefer selected arm, fallback to first deployed
            if (d.armManager) {
              let arm = d.armManager.getSelectedDeployedArm();
              // [DBG-ARM] log getSelectedDeployedArm result
              console.log(
                `[DBG-ARM] P-KEY getSelectedDeployedArm() → ` +
                `${arm ? `${arm.id} state=${arm.state}` : 'null'}`
              );
              if (!arm) {
                // V-8 fix: include STATION_KEEP so P-key works after daughter
                // reaches station-keeping orbit (previously excluded, causing
                // "No deployed arms" when user follows "press P" prompt).
                const S = Constants.ARM_STATES;
                const deployed = d.armManager.arms.filter(a =>
                  a.state !== S.DOCKED && a.state !== S.EXPENDED &&
                  (a.state === S.TRANSIT || a.state === S.APPROACH ||
                   a.state === S.FISHING || a.state === S.STATION_KEEP)
                );
                // [DBG-ARM] log fallback filter result
                console.log(
                  `[DBG-ARM] P-KEY fallback filter — totalArms=${d.armManager.arms.length} ` +
                  `eligible=${deployed.length} ` +
                  `states=[${d.armManager.arms.map(a => `${a.id}:${a.state}`).join(',')}]`
                );
                arm = deployed.length > 0 ? deployed[0] : null;
              }
              if (arm) {
                console.log(
                  `[DBG-ARM] P-KEY → _enterArmPilotCamera(${arm.id}) state=${arm.state} ` +
                  `pos=(${(arm.position.x/0.00001).toFixed(1)},${(arm.position.y/0.00001).toFixed(1)},${(arm.position.z/0.00001).toFixed(1)})m`
                );
                this._enterArmPilotCamera(arm);
                eventBus.emit(Events.COMMS_MESSAGE, {
                  text: `ARM PILOT engaged — controlling ${arm.id}`,
                  priority: 'info',
                });
              } else {
                console.log(`[DBG-ARM] P-KEY → no eligible arm — comms warning`);
                eventBus.emit(Events.COMMS_MESSAGE, {
                  text: 'No deployed arms available for piloting',
                  priority: 'warning',
                });
              }
            }
          }
          d.audioSystem.playClick();
        }
        break;

      // Deploy V3 Octopus arm (G key) / Trawl net (Shift+G)
      case 'KeyG':
        if (isGameplay) {
          if (e.shiftKey) {
            // Deploy trawl net (Phase 6)
            eventBus.emit(Events.TRAWL_START);
          } else {
            // FIX: If already in ARM_PILOT mode, exit it first so the new arm
            // gets its own ceremony with smooth camera transition + strut aiming.
            // Previously, the ceremony block was skipped when armPilotMode was true,
            // causing the camera to stay on the old arm and the new strut to never
            // get aimed toward the target (Bug 1 regression + Bug 2).
            if (this.armPilotMode) {
              this._exitArmPilotCamera();
            }
            d.deployArm();
            // S2.3: Gradual daughter launch transition
            // Auto-enter ARM PILOT after a longer delay so player notices the
            // arm detach and watches it begin its journey before camera follows.
            // V-7: Launch ceremony replaces setTimeout camera transition (§14.8.11.12)
            if (d.armManager && !this.armPilotMode) {
              const deployed = d.armManager.arms.filter(a =>
                a.state !== 'DOCKED' && a.state !== 'EXPENDED' &&
                a.state !== 'RETURNING' && a.state !== 'DOCKING'
              );
              if (deployed.length > 0) {
                const arm = deployed[deployed.length - 1];
                eventBus.emit(Events.COMMS_MESSAGE, {
                  text: `Arm ${arm.id} deployed — tracking…`,
                  priority: 'info',
                });
                eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
              }
            }
          }
          e.preventDefault();
        }
        break;

      // Toggle EDT — Electrodynamic Tether (Y key, Phase 6)
      case 'KeyY':
        if (isGameplay) {
          eventBus.emit(Events.EDT_DEPLOY);
          d.audioSystem.playClick();
          e.preventDefault();
        }
        break;

      // Recall all arms (H key)
      case 'KeyH':
        if (isGameplay) {
          if (d.armManager) d.armManager.recallAll();
        }
        break;

      // D key: Deploy recommended tool (normal); Ctrl+D = debug; Ctrl+Shift+D = deorbit
      case 'KeyD':
        if (e.ctrlKey && e.shiftKey && isGameplay) {
          e.preventDefault();
          eventBus.emit(Events.ARM_DEORBIT_CMD);
        } else if (e.ctrlKey) {
          e.preventDefault();
          if (d.debugOverlay) d.debugOverlay.toggle();
        } else if (isGameplay && !e.repeat) {
          if (this.armPilotMode) {
            // WASD thrust handled in processInput — do nothing in keydown
          } else {
            eventBus.emit(Events.TOOL_DEPLOY);
            eventBus.emit(Events.TUTORIAL_DEPLOY_INPUT);
            d.audioSystem?.playClick();
            e.preventDefault();
          }
        }
        break;

      // A key: Shift+A = engage Debris Map cluster AP; plain A = autopilot toggle; WASD in arm pilot
      case 'KeyA':
        if (isGameplay && !e.repeat) {
          if (e.shiftKey && d.debrisMap) {
            d.debrisMap.engageSelectedCluster();
            d.audioSystem?.playClick();
          } else if (this.armPilotMode) {
            // WASD thrust handled in processInput — do nothing in keydown
          } else if (d.autopilotSystem) {
            d.autopilotSystem.toggle();
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        }
        break;

      // S key: Quick Scan (normal mode); WASD thrust in arm pilot
      case 'KeyS':
        if (isGameplay && !e.repeat) {
          if (this.armPilotMode) {
            // WASD thrust handled in processInput — do nothing in keydown
          } else {
            eventBus.emit(Events.SCAN_QUICK);
            eventBus.emit(Events.TUTORIAL_SCAN_INPUT);
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        }
        break;

      // W key: Wide Scan (normal mode); WASD thrust in arm pilot
      case 'KeyW':
        if (isGameplay && !e.repeat) {
          if (this.armPilotMode) {
            // WASD thrust handled in processInput — do nothing in keydown
          } else {
            eventBus.emit(Events.SCAN_WIDE);
            eventBus.emit(Events.TUTORIAL_SCAN_INPUT);
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        }
        break;

      // F key: Net deploy (ARM PILOT) or Focus Action (normal mode)
      case 'KeyF':
        if (isGameplay && !e.repeat) {
          if (this.armPilotMode) {
            // ST-8.2.1: F from STATION_KEEP → capture debris
            const fArm = d.cameraSystem?.getPilotedArm();
            if (fArm && fArm.state === Constants.ARM_STATES.STATION_KEEP) {
              fArm.captureFromStationKeep();
              e.preventDefault();
              return;
            }
            // ARM PILOT mode: manual net deploy on piloted arm
            const pilotArmF = d.cameraSystem ? d.cameraSystem.getPilotedArm() : null;
            if (pilotArmF && (pilotArmF.state === 'TRANSIT' || pilotArmF.state === 'APPROACH')) {
              // Find nearby debris if arm has no target
              const captureTarget = pilotArmF.target || this._findNearestDebrisToArm(pilotArmF, d.debrisField);
              if (captureTarget) {
                // Set target if arm didn't have one (free-fly scenario)
                if (!pilotArmF.target) pilotArmF.target = captureTarget;
                // manualNetDeploy() emits its own comms message
                if (!pilotArmF.manualNetDeploy()) {
                  d.audioSystem.playClick(); // deploy failed (edge case)
                }
              } else {
                // No target in range — rejection
                d.audioSystem.playClick();
                eventBus.emit(Events.COMMS_MESSAGE, {
                  text: 'No debris in capture range',
                  priority: 'warning',
                });
              }
            } else if (pilotArmF) {
              // Arm not in a deployable state
              d.audioSystem.playClick();
            }
          } else {
            // Focus Action — context-sensitive smart button
            eventBus.emit(Events.FOCUS_ACTION);
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        }
        break;

      // ST-5.1: C key — tap/hold discrimination (replaces toggleComms)
      case 'KeyC':
        if (!e.repeat) {
          this._cKeyDownTs = Date.now();
          // Start hold timer — if held ≥ C_HOLD_THRESHOLD_MS, open radial
          if (this._cHoldTimeout) clearTimeout(this._cHoldTimeout);
          this._cHoldTimeout = setTimeout(() => {
            this._cRadialOpen = true;
            // Compute anchor position: target reticle or screen center
            let ax = window.innerWidth / 2;
            let ay = window.innerHeight / 2;
            if (d.targetReticle && d.targetReticle.getScreenPosition) {
              const sp = d.targetReticle.getScreenPosition();
              if (sp) { ax = sp.x; ay = sp.y; }
            }
            eventBus.emit(Events.COMMS_RADIAL_OPEN, { x: ax, y: ay });
            d.audioSystem?.playClick();
          }, Constants.COMMS.C_HOLD_THRESHOLD_MS);
          // Skills discovery: comms opened
          eventBus.emit(Events.COMMS_OPENED);
        }
        break;

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

      // Toggle NavSphere (N key)
      case 'KeyN':
        if (d.navSphere) {
          d.navSphere.toggleVisibility();
          d.audioSystem.playClick();
        }
        break;

      // Comma (,): Stow all struts gradually (α → 0). Debris Map prev if map is open.
      case 'Comma':
        if (isGameplay && d.armManager && !(d.debrisMap && d.debrisMap.isVisible())) {
          // Set gradual target: struts close toward 0 at STRUT_SLEW_RATE per frame
          // (driven by _updateStruts checking arm._strutTargetAlpha each tick)
          const arms = d.armManager.arms;
          for (const arm of arms) {
            if (arm.state === Constants.ARM_STATES.DOCKED) {
              arm._strutTargetAlpha = 0;
            }
          }
          d.audioSystem?.playClick();
          e.preventDefault();
        } else if (isGameplay && d.debrisMap) {
          d.debrisMap.selectPrev();
          e.preventDefault();
        }
        break;
      // Period (.): Deploy all struts gradually (α → π). Debris Map next if map is open.
      case 'Period':
        if (isGameplay && d.armManager && !(d.debrisMap && d.debrisMap.isVisible())) {
          // Set gradual target: struts open toward π (180° zenith) at STRUT_SLEW_RATE
          const arms = d.armManager.arms;
          for (const arm of arms) {
            if (arm.state === Constants.ARM_STATES.DOCKED) {
              arm._strutTargetAlpha = Math.PI;
            }
          }
          d.audioSystem?.playClick();
          e.preventDefault();
        } else if (isGameplay && d.debrisMap) {
          d.debrisMap.selectNext();
          e.preventDefault();
        }
        break;

      // Cycle fuel type (T key) — dual-metal FEEP thruster (Phase 4)
      case 'KeyT':
        if (isGameplay) {
          eventBus.emit(Events.FUEL_CYCLE);
          d.audioSystem.playClick();
          e.preventDefault();
        }
        break;

      // Space — deploy net in ARM PILOT mode, or fire lasso otherwise
      case 'Space':
        if (this.armPilotMode && d.cameraSystem) {
          e.preventDefault(); // always prevent scroll when in arm pilot
          const pilotArmForNet = d.cameraSystem.getPilotedArm();
          if (pilotArmForNet && pilotArmForNet.isManual()) {
            if (d.dockingReticle && d.dockingReticle.isNetReady()) {
              // Manual net deploy — transition arm to NETTING state
              pilotArmForNet.manualNetDeploy();
              // Exit arm pilot mode since arm is now in capture sequence
              this.armPilotMode = false;
              d.cameraSystem.clearPilotArm();
            } else {
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Too far for net deployment — get closer',
                priority: 'warning',
              });
            }
          }
        } else if (isGameplay && d.lassoSystem) {
          // S4: Lasso cast windup — brief delay before firing for "cast" feel
          e.preventDefault();
          if (!this._lassoWindingUp && !d.lassoSystem.active) {
            this._lassoWindingUp = true;
            d.audioSystem.playClick(); // immediate feedback: charging thunk
            const windupMs = (Constants.LASSO_CAST_WINDUP || 0.15) * 1000;
            this._lassoWindupTimeout = setTimeout(() => {
              this._lassoWindingUp = false;
              this._lassoWindupTimeout = null;
              // Compute fresh position/direction at actual fire time
              const vel = d.player.getVelocity();
              const velDir = new THREE.Vector3(vel.x, vel.y, vel.z);
              if (velDir.lengthSq() > 0) velDir.normalize();
              const activeTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
              const fired = d.lassoSystem.fire(
                d.player.getPosition(),
                d.debrisField,
                velDir,
                activeTarget,
              );
              if (fired) {
                // (Tutorial hint auto-hide removed Sprint 3)
              }
            }, windupMs);
          }
        }
        break;

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
              text: 'No arm available for detach.',
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
      case 'Digit5':
        if (isGameplay) {
          this._handleArmKey(4);
          d.audioSystem.playClick();
        }
        break;
      case 'Digit6':
        if (isGameplay) {
          this._handleArmKey(5);
          d.audioSystem.playClick();
        }
        break;
      case 'Digit7':
        if (isGameplay) {
          // Return to mothership — exit arm pilot + restore camera
          this._exitArmPilotCamera();
          if (d.armManager) d.armManager.deselectArm();
          d.audioSystem.playClick();
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
        }
        break;

      // --- Backtick: Toggle Debris Map (strategic overlay); Shift+` = Cycle tool alternatives ---
      case 'Backquote':
        if (isGameplay && !e.repeat) {
          if (e.shiftKey) {
            // Tool cycling (relocated from plain Backquote)
            eventBus.emit(Events.TOOL_CYCLE);
          } else if (d.debrisMap) {
            d.debrisMap.toggle();
          }
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // --- F17: Toggle Codex Library (L key) ---
      case 'KeyL':
        if (isGameplay && d.codexViewerUI) {
          d.codexViewerUI.toggle();
          d.audioSystem.playClick();
          // Skills discovery: codex opened
          eventBus.emit(Events.CODEX_OPENED);
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

    // ST-5.1: C key release — discriminate tap vs hold
    if (e.code === 'KeyC') {
      if (this._cHoldTimeout) {
        clearTimeout(this._cHoldTimeout);
        this._cHoldTimeout = null;
      }
      if (this._cRadialOpen) {
        // Hold release — close radial (select highlighted option)
        this._cRadialOpen = false;
        eventBus.emit(Events.COMMS_RADIAL_CLOSE, { select: true });
      } else if (this._cKeyDownTs != null) {
        // Tap — expand comms pane
        const elapsed = Date.now() - this._cKeyDownTs;
        if (elapsed < (Constants.COMMS.C_HOLD_THRESHOLD_MS || 300)) {
          eventBus.emit(Events.COMMS_FOCUS);
          this._deps?.audioSystem?.playClick();
        }
      }
      this._cKeyDownTs = null;
    }
  }

  // ==========================================================================
  // ARM KEY HELPERS (Phase 1B)
  // ==========================================================================

  /**
   * Handle arm number key press (1-6): deploy if docked, select if deployed,
   * warn if expended. UX-3 #8: deploy does NOT auto-switch camera — press P to pilot.
   * @private
   * @param {number} armIndex - 0-based arm index
   */
  _handleArmKey(armIndex) {
    const d = this._deps;
    if (!d.armManager) return;

    const arm = d.armManager.arms[armIndex];
    if (!arm) return;

    // Toggle: re-pressing the same arm key exits pilot mode & deselects
    if (d.armManager.selectedArmIndex === armIndex) {
      this._exitArmPilotCamera();
      d.armManager.deselectArm();
      return;
    }

    if (arm.state === Constants.ARM_STATES.DOCKED) {
      // Deploy the arm — UX-3 #8: camera stays on current view
      const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
      const deployed = d.armManager.deployArmByIndex(armIndex, target);
      if (deployed) {
        d.armManager.selectArm(armIndex);
        // UX-3 #8: Emit hint instead of auto-switching camera
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Arm ${arm.id} deployed — press P to pilot`,
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'info',
        });
      }
    } else if (arm.state === Constants.ARM_STATES.EXPENDED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.id} is expended — not available`,
        priority: 'warning',
      });
    } else {
      // Arm is deployed — select it for piloting + camera follow
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
   * Used by F-key manual net deploy when arm has no assigned target (free-fly mode).
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
   * Process held keys into thrust commands.
   * @param {number} dt - Real-time delta (seconds)
   */
  processInput(dt) {
    const d = this._deps;

    // F17: Suppress continuous input while codex overlay is open
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) return;

    // Suppress continuous input while debris map is open
    if (d.debrisMap && d.debrisMap.isVisible()) return;

    // ST-6.4: Suppress continuous input while strategic map is open
    if (d.strategicMap && d.strategicMap.isOpen()) return;

    const ionDir = { x: 0, y: 0, z: 0 };
    let hasIon = false;
    let thrustType = 'ion';

    // WASD thrust: ARM PILOT mode only (mothership thrust removed from normal play)
    const apEngaged = d.autopilotSystem && d.autopilotSystem.engaged;

    if (this.armPilotMode && !apEngaged) {
      if (this.keys['KeyW'])  { ionDir.z += 1; hasIon = true; }
      if (this.keys['KeyS'])  { ionDir.z -= 1; hasIon = true; }
      if (this.keys['KeyA'])  { ionDir.x -= 1; hasIon = true; }
      if (this.keys['KeyD'])  { ionDir.x += 1; hasIon = true; }
      if (this.keys['KeyQ'])  { ionDir.y += 1; hasIon = true; }
      if (this.keys['KeyE'])  { ionDir.y -= 1; hasIon = true; }
    }

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
      // Priority 1: ARM PILOT mode via P key (camera follows arm)
      // Priority 2: Arm selected via number keys 1-6 and deployed/pilotable
      // ================================================================

      if (this.armPilotMode && d.cameraSystem) {
        // P-key ARM PILOT: route to the camera-tracked piloted arm
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
          // Auto-enable manual piloting (no P key required)
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
    } else if (d.player && d.player.isMPDArmed && d.player.hasMPD) {
      newMode = 'MPD_BURST';
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
      const rotRate = Constants.SATELLITE_ROTATION_RATE; // rad/s — tunable in Constants.js
      if (this.keys['ArrowUp'])    { d.player.rotatePitch( rotRate * dt); }
      if (this.keys['ArrowDown'])  { d.player.rotatePitch(-rotRate * dt); }
      if (this.keys['ArrowLeft'])  { d.player.rotateYaw( rotRate * dt); }
      if (this.keys['ArrowRight']) { d.player.rotateYaw(-rotRate * dt); }
    }
  }
}
