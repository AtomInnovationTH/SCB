/**
 * InputManager.js — keyboard input: key state, arm pilot mode, target cycling; routes input to game systems via
 * injected deps.
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
import { persistenceManager } from './PersistenceManager.js';
import { CeremonyTimeScale } from './CeremonyTimeScale.js';
import { despinLaser } from './DespinLaser.js';
import { DEV_ACTIONS, resolveNextDevAction } from './DevSequenceAdvancer.js';
import {
  classifyNetTarget, OUT_OF_MOTHER_NETS_LINE, OUT_OF_NET_RANGE_LINE, collarBusyLine, collarBusyState, targetRangeM, netRangeLine, dInviteLine,
  netReachForMassM, driftOutOfReachLine, netFlightClockScale,
} from './netRouting.js';
import { computeLeadAim, netMaxReachM, overCatchLimit, catchLimitLine } from '../entities/CaptureNet.js';
import { buildLineupSnapshot } from './NetLineupOdds.js';

/** Scratch for the line-up's nose reading (one per module: the line-up ticks once a frame). */
const _lineupNose = new THREE.Vector3();

/**
 * A catch chance (0..1) as the whole number the panel and the ring show: "100" only when exactly 1.0 (a rolled certainty),
 * else at most 99 (`TOOL_ODDS.DISPLAY_CAP`), the rule TargetPanel's badge uses.
 * @param {number} p
 * @returns {number}
 */
function netPctText(p) {
  const cap = (Constants.TOOL_ODDS && Constants.TOOL_ODDS.DISPLAY_CAP) ?? 0.99;
  return p >= 1 ? 100 : Math.round(Math.min(p, cap) * 100);
}
import { tripRefuses } from './TransferTrip.js';
import { isFree, samePiece, netRefusalLine, wrapRefusalLine, SCAN_FIRST_LINE, DAUGHTERS_ONLY_LINE, fanOutNoneText, daughtersHeldBackLine } from './PieceClaim.js';
import { openingDance } from './OpeningDance.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { radToDeg } from '../core/MathUtil.js';
import { orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { TimeAuthority } from './TimeAuthority.js';
import { lassoFlightParams, lassoNoFixLine } from './LassoSystem.js';

/**
 * The line posted when a daughter's pilot view opens. Arrow keys (the turn pad on glass) steer her only while she holds
 * station (the STATION_KEEP block of update()); the way out is Esc / V / her number again, or a tap on her DAUGHTERS row on glass.
 * @param {string} name
 * @returns {string}
 */
export function pilotLine(name) {
  return GestureHints.isGlass()
    ? `Piloting ${name}. The turn pad steers her once she holds station · tap her row in DAUGHTERS again: back to the mother.`
    : `Piloting ${name}. Arrow keys steer her once she holds station · Esc, V or her number again: back to the mother.`;
}

/**
 * Where the piece will be, as a distance from the SHIP CENTRE (the HUD's and the in-flight check's basis), when a mother
 * net launched now makes contact. The real net, measured (test-NetReachGate.js): it sits on the ship for CAST_WINDUP +
 * SPIN_UP_TIME (`delayS`), then flies at `speedMps` from the muzzle and makes contact when its front is one mouth radius
 * (`catchRadiusM`) from the piece. The piece moves in a straight line at `relVel` (the aim's linear lead) for the whole
 * time. Pure; scene units and scene units per real second in, metres out. Matched the real NetProjectile to 0.01 m.
 * @param {{x,y,z}} shipPos - ship centre (scene units)
 * @param {{x,y,z}} muzzle - the pod's muzzle (scene units)
 * @param {{x,y,z}} piecePos - piece position now (scene units)
 * @param {{x,y,z}|null} relVel - the piece's velocity relative to the ship (scene units per real s); null reads as still
 * @param {number} speedMps - net launch speed (m/s)
 * @param {number} delayS - seconds between the press and the start of the flight
 * @param {number} catchRadiusM - mouth radius (m)
 * @param {number} [minFlightS] - the flight cannot end before this many seconds after it starts (the lasso's
 *   LASSO_MIN_FLIGHT_TIME; the large net has none)
 * @returns {number} metres; Infinity when a position is missing or the piece outruns the net
 */
export function netArrivalRangeM(shipPos, muzzle, piecePos, relVel, speedMps, delayS, catchRadiusM, minFlightS = 0) {
  if (!shipPos || !muzzle || !piecePos) return Infinity;
  const M = Constants.SCENE_UNITS_PER_METER;
  const px = (piecePos.x - muzzle.x) / M, py = (piecePos.y - muzzle.y) / M, pz = (piecePos.z - muzzle.z) / M;
  const r0 = Math.sqrt(px * px + py * py + pz * pz);
  const cx = (piecePos.x - shipPos.x) / M, cy = (piecePos.y - shipPos.y) / M, cz = (piecePos.z - shipPos.z) / M;
  if (!relVel || !(speedMps > 0)) return Math.sqrt(cx * cx + cy * cy + cz * cz);   // no velocity: the range now is all there is
  const vx = relVel.x / M, vy = relVel.y / M, vz = relVel.z / M;
  const vr = r0 > 0 ? (vx * px + vy * py + vz * pz) / r0 : 0;   // m/s along the muzzle -> piece line
  if (vr >= speedMps) return Infinity;
  // net front at speed * (t - delay) = piece range - mouth radius, the piece's range growing at vr
  const path = Math.max(0, r0 - catchRadiusM) + speedMps * delayS;
  const t = Math.max(delayS + minFlightS, path / (speedMps - vr));
  const ax = cx + vx * t, ay = cy + vy * t, az = cz + vz * t;
  return Math.sqrt(ax * ax + ay * ay + az * az);
}

/** The reason text `AutopilotSystem._rejectAim` sends when the player's own steering ended the turn (AutopilotSystem `onManualRotate`). */
export const MANUAL_AIM_REASON = 'Manual attitude input';

/**
 * The arm states in which a daughter is NOT out flying on her tether: at home (docked, parked with a catch,
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

/**
 * Is the piece inside the reach of the net that N would fire at it (the lasso's LASSO_RANGE for a piece <= 10 kg, the large
 * net's netMaxReachM above)? True when the distance is unknown (headless mocks). A module function so `findHoldingDaughter`
 * also works bound to a bare `{ _deps }` stand-in (test-ToolChipLive).
 * @param {object} deps - the InputManager `_deps`
 * @param {object} piece
 * @returns {boolean}
 */
function withinNetReach(deps, piece) {
  const mass = piece.mass || 0;
  const reachM = classifyNetTarget(mass).band === 'lasso'
    ? Constants.LASSO_RANGE
    : netMaxReachM(Constants.CAPTURE_NET.LARGE);
  const d = deps || {};
  if (!piece._scenePosition || !d.player || typeof d.player.getPosition !== 'function') return true;
  const p = d.player.getPosition();
  if (!p) return true;
  const distM = targetRangeM(p, piece._scenePosition);   // net-range: the one shared distance
  return !(reachM > 0) || distM <= reachM;
}

/**
 * True when the mother's net cannot do anything with this N press: there is no active target, the piece is
 * beyond the reach of the net that would fire at it, or the mother has no nets left.
 * @param {object} deps - the InputManager `_deps`
 * @param {object|null} target - the active target
 * @returns {boolean}
 */
function motherNetHasNothingToDo(deps, target) {
  if (!target) return true;
  const cns = (deps || {}).captureNetSystem;
  if (cns && Constants.isFeatureEnabled('CAPTURE_NET')
      && typeof cns.getMotherNetCount === 'function' && cns.getMotherNetCount() <= 0) return true;
  return !withinNetReach(deps, target);
}

/**
 * findHoldingDaughter's body, with an optional "as if": `hyp` = { arm, piece } treats that arm as already in STATION_KEEP on
 * `piece` (for a line said just before she gets there: the retry lines of a failed net).
 * @param {object} d - the InputManager `_deps`
 * @param {{arm: object, piece: object}|null} hyp
 * @returns {object|null}
 */
function holdingDaughter(d, hyp) {
  const am = d && d.armManager;
  const target = d && d.targetSelector && typeof d.targetSelector.getActiveTarget === 'function'
    ? d.targetSelector.getActiveTarget() : null;
  if (!am || !Array.isArray(am.arms)) return null;
  const SK = Constants.ARM_STATES.STATION_KEEP;
  const inSK = (a) => !!a && (a.state === SK || (!!hyp && a === hyp.arm));
  const pieceOf = (a) => (hyp && a === hyp.arm && hyp.piece) ? hyp.piece : (a._stationKeepTarget || a.target);
  // By id, as the claim does: a Tab-selected snapshot of her piece is still her piece (identity `===` missed it).
  const holds = (a) => inSK(a) && samePiece(pieceOf(a), target);
  // wait view (DECISIONS §46 row 2): N goes where the view is. With the camera on a daughter who waits for N, she is the
  // one N works, even when another in-reach piece is selected; Esc or a drag gives the view (and N) back to the mother.
  const viewArm = d && d.cameraSystem && typeof d.cameraSystem.getWaitViewArm === 'function' ? d.cameraSystem.getWaitViewArm() : null;
  if (viewArm && am.arms.includes(viewArm) && inSK(viewArm)) return viewArm;
  const sel = (am.selectedArmIndex >= 0 && am.selectedArmIndex < am.arms.length) ? am.arms[am.selectedArmIndex] : null;
  if (target) {
    if (holds(sel)) return sel;
    for (let i = 0; i < am.arms.length; i++) if (holds(am.arms[i])) return am.arms[i];
  }
  // When the mother's net has nothing to do, N works a daughter holding station (her own piece).
  if (!motherNetHasNothingToDo(d, target)) return null;
  if (inSK(sel)) return sel;
  for (let i = 0; i < am.arms.length; i++) if (inSK(am.arms[i])) return am.arms[i];
  return null;
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

    this._deps = null;

    /** @type {string} Current WASD control mode — 'RCS'|'COLD_GAS'|'ARM_PILOT' (HUD indicator) */
    this._controlMode = 'RCS';

    /** @type {boolean} Whether lasso is in windup phase */
    this._lassoWindingUp = false;
    /** @type {object|null} The Shift+A daughters' wait for the net's turn (see _afterNetSettles) */
    this._netWait = null;
    /**
     * @type {object|null} The mother Large Net's line-up (net-odds-1107 D9): `{ target, u, started, quickArmed, ... }` from the
     * first N on a heavy piece until the net leaves or the aim ends. Ticked by `_tickNetLineup`, read by `getNetLineup()`.
     */
    this._netLineup = null;
    /** @type {number|null} Windup timeout handle */
    this._lassoWindupTimeout = null;

    /** @type {boolean} Whether first user gesture has been handled for audio unlock */
    this._firstGestureHandled = false;
    /** @type {number|null} TimerManager id for audio unlock check */
    this._audioUnlockTimerId = null;

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

    // The daughters' piece-owner check has to see the lasso too (it is not reachable from the ship).
    if (deps && deps.armManager && deps.lassoSystem && typeof deps.armManager.setLassoSystem === 'function') {
      deps.armManager.setLassoSystem(deps.lassoSystem);
    }

    // Auto-exit arm pilot mode when the piloted arm returns or is expended (decoupled from GameFlowManager).
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
      // Clear the selection when the returning / expended daughter is the selected one (stops its 3D selection glow),
      // even if never piloted.
      const am = this._deps?.armManager;
      if (am && typeof am.getSelectedArm === 'function'
          && am.getSelectedArm()?.id === data.armId) {
        am.deselectArm();
      }
    };
    eventBus.on(Events.ARM_RETURNED, (data) => handleArmPilotExit(data, false));
    eventBus.on(Events.ARM_EXPENDED, (data) => handleArmPilotExit(data, true));

    // A piloted daughter that ends up PARKED WITH A CATCH by any path (a dock goes through ARM_RETURNED above) leaves pilot
    // mode and is deselected: the pilot view has nothing to offer her (no net, no recall) and its range beeps would run
    // against her own rack. Some ARM_STATE_CHANGE payloads carry only `{ armId, manual }`, so test `to`.
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

    // Ceremony complete: restore FOV unless entering ARM_PILOT tracking. Auto-entry (ceremony → ARM_PILOT) keeps the
    // narrow ~40° FOV and ALSO turns on armPilotMode so SK orbit arrows + WASD thrust work at once. skipLaunchCeremony →
    // CHASE snaps FOV back to the COMMAND default.
    eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, (payload) => {
      const cam = this._deps?.cameraSystem;
      // Bare D with nobody selected auto-picks a daughter and the ceremony pilots her with no selection ever made
      // (strip, her row and `R` disagreed). Select her now unless already selected: ArmManager.selectArm TOGGLES.
      this._selectLaunched(payload && payload.arm);
      if (cam) {
        // Always record the normal FOV for restore when exiting ARM_PILOT
        cam.armPilot.fovNormal = Constants.CAMERA_FOV;
        if (cam.currentView !== 'ARM_PILOT') {
          cam._baseFov = Constants.CAMERA_FOV;
          cam.camera.fov = Constants.CAMERA_FOV;
          cam.camera.updateProjectionMatrix();
        } else if (!this.armPilotMode) {
          // Camera auto-entered ARM_PILOT view: bring input mode in sync (SK orbit arrows, WASD manual thrust).
          this.armPilotMode = true;
          const pilotArm = cam.getPilotedArm?.();
          if (pilotArm && pilotArm.enableManual) pilotArm.enableManual();
        }
      }
    });

    // Auto-advance to the next target when debris is captured. No dedup guard: the function is idempotent and the
    // retries are essential for the DEBRIS_REMOVED safety net when the primary capture-event path silently fails.
    const handleCaptureAdvance = (capturedId) => {
      // `!= null`, not `!capturedId`: debris ID 0 is valid
      if (capturedId == null) return;

      const d = this._deps;
      if (!d.targetSelector || !d.debrisField || !d.player) return;

      const capturedDebris = d.debrisField.getDebrisById(capturedId);
      if (capturedDebris) capturedDebris._captured = true;

      const current = d.targetSelector.getActiveTarget();
      if (current && current.id === capturedId) {
        d.targetSelector.clearTarget();
      }

      // A valid (non-captured) target already exists: skip re-selection (avoids double TARGET_SELECTED when both
      // LASSO_CAPTURED and ARM_CAPTURED fire for the same debris, yet retries still work when no target was set).
      const existingTarget = d.targetSelector.getActiveTarget();
      if (existingTarget) return;

      try {
        const playerPos = d.player.getPosition();
        const playerOrbit = d.player.getOrbitalElements();
        if (!playerPos || !playerOrbit) return;

        const targets = d.debrisField.getEnhancedTargetList(playerPos, playerOrbit)
          .filter(t => t.id !== capturedId && !t._captured &&
            (t.tracked !== false || (d.sensorSystem && d.sensorSystem.canDetectUntracked)));

        // An automatic pick stays within AUTOLOCK.RANGE_M (a 385 km auto-pick emptied the argon). Keep the list's order
        // (TPI, lowest first), take the first entry in range; none → select nothing.
        const rangeM = Constants.AUTOLOCK.RANGE_M;
        const next = targets.find(t => t.distanceKm * 1000 <= rangeM);
        if (next) {
          const debris = d.debrisField.getDebrisById(next.id);
          if (debris) {
            d.targetSelector.setTarget(debris, { distanceKm: next.distanceKm, deltaV: next.deltaV, source: 'capture_advance' });
            // UI updates in a separate try/catch: must not prevent target selection
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

    // ARM_CAPTURED from LassoSystem uses { debrisId } not { targetId }: accept both keys so lasso captures have a
    // backup auto-advance path. `!= null` checks: debris ID 0 is valid.
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

    // Safety net: if DEBRIS_REMOVED cleared our target and no capture-event handler managed to auto-advance
    // (e.g. silent throw), pick the next target after all synchronous handlers have finished.
    eventBus.on(Events.DEBRIS_REMOVED, (data) => {
      if (!data || data.id == null) return;
      const removedId = data.id;
      queueMicrotask(() => {
        const d = this._deps;
        if (!d?.targetSelector || !d.debrisField || !d.player) return;
        if (d.targetSelector.getActiveTarget()) return;
        handleCaptureAdvance(removedId);
      });
    });

  }

  // Audio unlock: retried on EVERY gesture until the context runs (owner 2026-09-30: "game should always have sound")

  /**
   * Gestures that ONLY retry the audio unlock. On touch, pointerdown is not a user-activation event (activation comes
   * from pointerup / touchend / click / keydown), so the first try on an iPad usually fails. They never skip the opening
   * dance (that stays on pointerdown).
   */
  static AUDIO_GESTURE_EVENTS = Object.freeze(['pointerup', 'touchend', 'click']);

  /**
   * Resume the AudioContext on a user gesture, retrying on every gesture until `ctx.state` is 'running'. Then
   * `_firstGestureHandled` latches (several test files set it to skip this path) and the audio-only listeners come
   * off. No user-facing message (the next tap fixes a failure); one console.warn at most.
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

    // resume() settles asynchronously: look again shortly so the audio-only listeners come off without another gesture.
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

  /** The context runs (or there is none to unlock): latch the short-circuit, drop the pending check and the listeners. @private */
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
   * Pointerdown handler: retries the audio unlock and fast-forwards the opening dance.
   * @private
   * @param {PointerEvent} _e
   */
  _handlePointerDown(_e) {
    this._tryAudioUnlock();
    // skip() is internally refused before the cut AND for a moment after a menu skip advanced the clock: MenuScreen's
    // skip runs on window CAPTURE and this handler on BUBBLE, so without that second guard the one click that skips
    // the MENU departure would also skip the dance.
    openingDance.skip();
  }

  start() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // The mouse wheel is owned by the single WheelRouter (window capture): the arm-pilot STATION_KEEP branch is
    // handleArmPilotWheel(e), which the router calls first (highest priority).
    window.addEventListener('pointerdown', this._onPointerDown);
    // Audio-only unlock retries. Capture phase, so a stopPropagation() elsewhere cannot swallow the activating gesture.
    if (!this._firstGestureHandled && !this._audioGestureListening) {
      if (!this._onAudioGesture) this._onAudioGesture = () => this._tryAudioUnlock();
      for (const type of InputManager.AUDIO_GESTURE_EVENTS) {
        window.addEventListener(type, this._onAudioGesture, { capture: true, passive: true });
      }
      this._audioGestureListening = true;
    }
  }

  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('pointerdown', this._onPointerDown);
    this._removeAudioGestureListeners();
    if (this._audioUnlockTimerId !== null) {
      timerManager.clear(this._audioUnlockTimerId);
      this._audioUnlockTimerId = null;
    }
  }

  /**
   * Arm-pilot STATION_KEEP wheel branch, called by the single WheelRouter with highest priority. When armPilotMode and
   * the piloted arm is in STATION_KEEP, consume the wheel and emit one ARM_ORBIT_ADJUST with a `radiusStep`
   * (instantaneous metres delta), NOT a rate. Direction matches +/- keys: scroll-up → closer (negative step),
   * scroll-down → farther (positive step). The legacy CAMERA_ZOOM_INPUT emission is the router's.
   * @param {WheelEvent} e
   * @returns {boolean} true if the event was consumed by the SK branch
   */
  handleArmPilotWheel(e) {
    if (!this.armPilotMode) return false;
    const d = this._deps;
    const skArm = d?.cameraSystem?.getPilotedArm?.();
    if (!skArm || skArm.state !== Constants.ARM_STATES.STATION_KEEP) return false;

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

  /**
   * True only while the player is flying a daughter BY HAND: the pilot view is up AND one of the hand-flying keys that
   * emit ARM_ORBIT_ADJUST is held (arrows, `=`/`-`, numpad ±; see processInput). The pilot view alone is not hand
   * flying: the game enters it by itself after a launch (SimClock's `daughterByHand` gate reads this, t9-misc).
   * @returns {boolean}
   */
  isArmHandFlying() {
    if (!this.armPilotMode) return false;
    const k = this.keys;
    return !!(k.ArrowLeft || k.ArrowRight || k.ArrowUp || k.ArrowDown
      || k.Equal || k.NumpadAdd || k.Minus || k.NumpadSubtract);
  }

  /** @param {boolean} val */
  setArmPilotMode(val) {
    this.armPilotMode = val;
  }

  /**
   * True while ANY key is currently held. The lasso catch cut refuses to START over active piloting: a key held before
   * contact never produces a fresh keydown, so the cut's any-input abort alone could not protect that player. Wired to
   * CameraSystem via setLassoCutInputProbe.
   * @returns {boolean}
   */
  anyKeyHeld() {
    for (const code in this.keys) {
      if (this.keys[code]) return true;
    }
    return false;
  }

  /**
   * Zoom Ladder key bindings (00-spec §5): resolve the LadderController and return it ONLY while it is engaged
   * (`isActive()`: flag on + gameplay + engaged). With `Constants.LADDER.ENABLED` false this always returns null and every
   * key below falls through to its legacy case. The dep is a getter closure (`getLadderController`) because main.js
   * constructs the ladder block after `inputManager.init()`.
   * @private
   * @returns {object|null} the engaged LadderController, or null
   */
  _ladderIfEngaged() {
    const get = this._deps && this._deps.getLadderController;
    const lc = get ? get() : null;
    return (lc && lc.isActive && lc.isActive()) ? lc : null;
  }

  /**
   * Pause or resume the game — the ONE body behind P and Esc (and the pause card's lift). Gameplay only.
   * Pausing only sets the flag (the pause card is shown by the P / Esc key paths via `onKeyPause`, never here: show
   * mode's cards pause through this before their own card exists); resuming resets the frame timer and emits
   * PAUSE_RESUME (the main.js loop's wake hook: without it the screen froze after resuming).
   * @returns {boolean|null} true when now paused, false when now running, null when not in gameplay (nothing done)
   */
  togglePause() {
    const d = this._deps;
    if (!d || !d.gameState || !d.gameState.isGameplay()) return null;
    const wasPaused = d.getPaused();
    d.setPaused(!wasPaused);
    if (!wasPaused) return true;
    d.setLastTime(performance.now());
    // PAUSE_RESUME wakes the rAF loop in main.js (`_scheduleNextFrame()` hook); without it the screen froze after ESC-unpause.
    eventBus.emit(Events.PAUSE_RESUME);
    return false;
  }

  /** @param {KeyboardEvent} e */
  _handleKeyDown(e) {
    this._tryAudioUnlock();

    // Never treat typing in a text field (e.g. the Codex search box) as game hotkeys.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
      return;
    }

    // Cmd/Ctrl combos belong to the browser (reload, save, find, select all). Only the combos
    // HotkeyOverlay lists get through: only Ctrl+D while the dev overlay flag is on (Ctrl+Shift+D is nothing).
    if (e.metaKey || e.ctrlKey) {
      const listed = e.code === 'KeyD' && e.ctrlKey && !e.metaKey && !e.shiftKey && Constants.DEBUG?.DEBUG_OVERLAY_HOTKEY;
      if (!listed) { this.keys[e.code] = false; return; }
    }

    // Anti-ASR guard for macOS Voice Control phantom "i" keystrokes (events arrive with `isTrusted: true`: ASR injects
    // through the OS HID layer). Default OFF; bare I = Info/Codex toggle, so enabling it via Constants.INPUT.SUPPRESS_BARE_I
    // also suppresses that toggle.
    if (Constants.INPUT?.SUPPRESS_BARE_I === true
        && e.code === 'KeyI' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      return;
    }

    // Opening dance: any input fast-forwards the remaining unfold over ~0.5 s, then control. The key is
    // never eaten (the lasso-cut hook below follows the same rule). Internally refused before the cut (t < 2.70 s),
    // where input belongs to MenuScreen's own departure skip.
    openingDance.skip();

    this.keys[e.code] = true;
    const d = this._deps;
    const currentState = d.gameState.currentState;
    const isGameplay = d.gameState.isGameplay();

    // Lasso catch cut: ANY key aborts it instantly and still does its normal job (never eaten, never blocked;
    // contrast the launch ceremony's blanket block).
    if (d.cameraSystem && typeof d.cameraSystem.lassoCutActive === 'function'
        && d.cameraSystem.lassoCutActive()) {
      d.cameraSystem.abortLassoCut();
    }

    // Prevent arrow keys from scrolling the page during gameplay
    if (isGameplay && (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      // Arrow input disengages autopilot EXCEPT while a daughter arm is in STATION_KEEP: the pilot's arrows are then
      // consumed by the SK θ/φ orbit controls, not mothership rotation. Disengaging the mother AP then would let the
      // mother drift off-orbit, tug the tethered daughter off the debris, and risk tether-tangle (CRITICAL).
      const _skArmForGuard = this.armPilotMode && d.cameraSystem?.getPilotedArm?.();
      const _inSkForGuard  = _skArmForGuard && _skArmForGuard.state === Constants.ARM_STATES.STATION_KEEP;
      const _lockTierForAP = d.armManager?.getRotationLockTier?.() ?? 'none';
      if (d.autopilotSystem && d.autopilotSystem.engaged && !_inSkForGuard) {
        if (_lockTierForAP === 'block' || _lockTierForAP === 'soft') {
          // Daughter tethered: preserve AP, throttled COMMS notice
          this._maybeEmitTetherLockMsg();
        } else {
          d.autopilotSystem.disengage('ARROW_INPUT');
        }
      }
      eventBus.emit(Events.TUTORIAL_ARROW_INPUT);
    }

    // Hotkey reference overlay intercept: while the shortcut list is open only ? (Slash, toggles closed) does anything;
    // ESC is handled by the overlay's own capture-phase listener. Block all other gameplay keys.
    if (d.hotkeyOverlay && d.hotkeyOverlay.isVisible()) {
      if (e.code === 'Slash') {
        d.hotkeyOverlay.toggle();
        d.audioSystem?.playClick();
        e.preventDefault();
      }
      return;
    }

    // Codex overlay intercept: every key but I (toggle) is blocked. ESC never reaches this handler: the viewer's
    // capture-phase listener owns it (and closes via the viewer's own _requestClose seam).
    if (d.codexViewerUI && d.codexViewerUI.isVisible()) {
      if (e.code === 'KeyI') {
        d.codexViewerUI.toggle();
        d.audioSystem?.playClick();
        e.preventDefault();
        return;
      }
      return; // block all other keys while codex is open
    }

    // Strategic Map (Shift+V) retired 2026-10-09 (owner: players do not need more keys to memorize; F4 shows the same).
    // The module and its Events key stay; nothing opens it.

    // Debris Map intercept: suppress most input, allow cluster nav + close; PageUp/PageDown pass through for the comms pane
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
          // M opens the Debris Map, so it must also CLOSE it (symmetry with the Backquote alias).
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
        case 'PageUp':
        case 'PageDown':
          break; // fall through to normal handling
        default:
          return; // block all other keys while debris map is open
      }
    }

    // Launch ceremony: ESC aborts to CHASE, D deploys another arm, Space/Enter skip ahead. All other keys are
    // blocked so the player watches the daughter deploy without an accidental skip.
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
        e.preventDefault();
        return;
      }
    }

    // Net ceremony: ESC / Space / Enter always release the camera takeover (skip path for the REEL_IN beat and every
    // other net beat); skipNetCeremony() routes through _exitNetCeremony so the saved view is restored and
    // CeremonyTimeScale resets to 1.0×.
    //
    // Deliberately does NOT block other keys, unlike the launch ceremony: that one is a short, player-initiated deploy;
    // the net ceremony fires passively on a catch during active play and runs 15.2 s of beats plus up to
    // REEL_BEAT_MAX_S (12 s) of chained REEL_IN, up to ~27 s. A blanket block there costs the player every discrete
    // action (view, scan, autopilot, deploy, power presets) for that whole window, a worse failure than an
    // accidental view change. Held/polled controls are unaffected (this.keys is written above, before these
    // intercepts).
    if (d.cameraSystem?._netCeremony?.active
        && (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter')) {
      d.cameraSystem.skipNetCeremony();
      e.preventDefault();
      return;
    }

    // ST-5.1: Comms menu intercept removed — center popup deleted.
    // UX-11 #9: the C-hold RadialMenu was also removed. Bare C is now "Move a catch to a radiator" (case 'KeyC' below);
    // comms expand lives on the 7 key.

    switch (e.code) {
      // Confirm / Enter action (gameplay only — menu/briefing handle their own Enter)
      case 'Enter':
        // With the zoom ladder engaged Enter does nothing (it moved ORBITAL_VIEW → INTERACTION with no visible change
        // and left B dead until a net catch). Ladder off (?ladder=0) keeps the legacy approach.
        if (isGameplay && !this._ladderIfEngaged()) {
          const target = d.targetSelector.getActiveTarget();
          if (target && currentState === GameStates.ORBITAL_VIEW) {
            d.setApproachTarget(target);
            d.setApproachComplete(false);
            d.transitionToState(GameStates.APPROACH);
          }
        }
        break;

      // Cycle targets: Tab (legacy alias) and T (the menu's "Target debris" verb) both route through _cycleTarget().
      case 'Tab':
        if (isGameplay) {
          this._cycleTarget();
        }
        // Only prevent default during gameplay (briefing handles its own Tab)
        if (isGameplay) e.preventDefault();
        break;

      case 'Escape': {
        if (d.debrisMap && d.debrisMap.isVisible()) {
          d.debrisMap.hide();
          e.preventDefault();
          break;
        }
        // Zoom Ladder (00-spec §5): "Esc = ride one floor up; if something modal is open, cancel that instead."
        // ORDERING: every modal/takeover Esc path stays ABOVE this branch (hotkey overlay, codex, debris-map close, the
        // launch/net ceremony skips all return before the ladder sees the key). The ladder branch PRECEDES the legacy
        // state-transition + camera-view fallbacks, because while engaged the ladder replaces those mode keys
        // (00-spec §1). Alarm auto-ride cancel lives inside the core (command 'esc' cancels it first). Engaged only in
        // gameplay with LADDER.ENABLED.
        // 08-workbench §2 (the hosted-codex rule): "Esc closes the topmost pane first, then rides up". ONE controller
        // call decides; the pane order lives in LadderController.closeTopPane(). true → a pane was closed: consume the
        // key, the ride-up is the NEXT Esc. false (no pane / closed / no such method) → the ride-up.
        // Paused: Esc resumes FIRST (a pause that has no card, show mode's), before any ride-up. Pausing itself is Esc with the ladder off.
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
          // owner 2026-10-09: piloting → the first Esc goes back to the mother, the next one rides up. Like V, she
          // keeps working (no recall).
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
          if (d.cameraSystem && d.cameraSystem.currentView === 'INSPECTION') {
            d.cameraSystem.exitInspection();
            break;
          }
          if (this.armPilotMode) {
            // ESC from STATION_KEEP → recall arm (stay in ARM_PILOT)
            const escArm = d.cameraSystem?.getPilotedArm();
            if (escArm && escArm.state === Constants.ARM_STATES.STATION_KEEP) {
              escArm.recallFromStationKeep();
              return;  // Stay in ARM_PILOT mode but arm will transition to RETURNING
            }
            this._exitArmPilotCamera();
            if (d.armManager) d.armManager.deselectArm();
          } else if (this.togglePause()) {
            d.onKeyPause?.();   // Esc with the ladder off pauses: show the pause card
          }
        }
        break;
      }

      // P — pause / resume (owner 2026-10-22). The one key that pauses on every setup: with the zoom ladder on,
      // Esc rides up a floor and never pauses. Cmd/Ctrl/Alt+P stay the browser's. Works while piloting a daughter.
      // No guard above returns early while paused, so the same key resumes. A held key does not flicker it.
      case 'KeyP':
        if (isGameplay && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!e.repeat && this.togglePause()) d.onKeyPause?.();   // paused now: show the pause card (its lift resumes)
          e.preventDefault();
        }
        break;

      // Camera view toggle (V key). Shift+V (strategic map) retired 2026-10-09.
      // V in MOTHER mode cycles FLY ↔ LOOK AROUND (close inspection engages by zooming in while in LOOK AROUND).
      // V while PILOTING a daughter = hop back to mother, camera AND input together, so the player is not stranded in
      // a hybrid state where the mother is on screen but the invisible daughter still steers. Unlike Esc (which
      // recalls from STATION_KEEP), V exits cleanly from any state without recalling: the daughter keeps working
      // ("spinning plates"). With the zoom ladder engaged V on the MOTHER does nothing (the ladder camera ignores
      // currentView, so the flip changed only the indicator); V while piloting still hops back (owner 2026-10-09).
      case 'KeyV':
        if (e.shiftKey) break;
        if (isGameplay) {
          if (this.armPilotMode) {
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

      // O key — AFT FLOWER deploy/stow toggle. ROSA-furl input idiom: guard on the live method, decide from the live
      // pose (mid-swing press reverses: player intent wins), click + event + comms line. Silent no-op until a flower
      // pair is purchased.
      // SAFETY OVERRIDE sweep (owner 2026-09-09: "when player presses override button, and press "O" or clicks radiator
      // button, they need to see how radiator struts move, full range of motion"): while deps.isOverrideEngaged()
      // (the OVERRIDE panel's grid is up) the key runs player.toggleFlowerOverride, FOLDED (LAUNCH θ 0) ↔ DEPLOYED
      // (STOW 146), the whole travel, the same path the pane's RADIATOR chip takes (main.js `flowerSweep`). Dep absent /
      // pane collapsed → the plain closed ↔ 146° handler (toggleFlowerDeploy).
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
            // A double tap that PUSHED THROUGH (to 180°, or past CLOSED into the launch fold) is narrated by the ship
            // itself, and the plain line would then be false ("…opening to 146°" while heading for 180°, "Engines still
            // work" while folding into the lock). The ship sets its own `_flowerPushedThrough` on exactly that branch
            // (not "the tap timer is clear": that clears on every double tap, pushed or not).
            const pushedThrough = d.player._flowerPushedThrough === true;
            if (!pushedThrough && !held) {
              eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'THERMAL',
                text: deploying
                  ? 'Radiator opening to 146° — the struts swing out.'
                  : 'Radiator closing — folding flat along the hull. Engines still work.',
                priority: 'info',
                _reactive: true,
              });
            }
          }
          e.preventDefault();
        }
        break;

      case 'KeyB':
        if (currentState === GameStates.ORBITAL_VIEW) {
          d.transitionToState(GameStates.SHOP);
        }
        break;

      // M key retired 2026-10-09: it opened the Debris Map; LEO (floor 4) shows the same. Bare M is unbound.

      // R key — Reel-in, consistent across BOTH mother and daughter modes. The help pane labels R "Reel-in" in both
      // cards, so reeling ALWAYS takes priority over the autopilot abort. Order:
      //   (1) ARM_PILOT       → reel the piloted daughter home (any live state)
      //   (2) Mother + deployed → recall SELECTED daughter if eligible, else closest
      //   (3) Mother + nothing to reel BUT autopilot engaged → abort autopilot
      //   (4) Otherwise        → "nothing to reel" comms (never silent)
      // Shift+R = recall ALL deployed daughters (mother AND daughter mode); it always reports a result.
      // Shift check FIRST.
      case 'KeyR':
        if (isGameplay) {
          e.preventDefault();
          const am = d.armManager;
          // (0) Shift+R: recall all deployed daughters (both modes). Use the count returned by recallAllDeployed() to
          // always emit feedback (a fire-and-forget ARM_RECALL_ALL claimed success even when nothing was deployed).
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
                      ? 'Every daughter that is out is already reeling home.'   // a reel in progress is not "none out"
                      : 'No deployed daughters to reel in.'),
                  priority: 'info',
                });
              }
            }
            break;
          }
          // (1) ARM_PILOT: reel the piloted daughter home from ANY state. recall() routes STATION_KEEP through
          // reelFromStationKeep and sends every other live state (TRANSIT / APPROACH / …) into a zero-fuel REELING return
          // on the mother's tether motor. One exception: HOLDING_CATCH is a player-facing REFUSAL, not a REELING; the
          // pilot session survives dock completion (CameraSystem re-latches armPilot.arm), so that path is reachable here.
          if (this.armPilotMode) {
            const pilotArmR = d.cameraSystem?.getPilotedArm?.();
            if (pilotArmR && typeof pilotArmR.recall === 'function'
                && pilotArmR.state !== Constants.ARM_STATES.DOCKED
                && pilotArmR.state !== Constants.ARM_STATES.EXPENDED) {
              const res = pilotArmR.recall();
              d.audioSystem?.playClick();
              // R is never silent. recall() says why itself when it refuses (holding a catch, carrying,
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
          // (2) Mother mode: reel the SELECTED deployed daughter FIRST (the closest when nothing eligible is selected).
          // Reeling is R's documented job, so it wins over the autopilot abort even when the AP is engaged (the AP keeps
          // the mother on-station while the daughter comes home; abort it explicitly with Esc).
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
          // (3) Nothing to reel: abort an engaged autopilot, otherwise emit the gentle "nothing to reel" hint.
          if (d.autopilotSystem && d.autopilotSystem.engaged) {
            // No dedicated AUTOPILOT_ABORT event: call disengage() directly (same path as A-key toggle when AP is on).
            d.autopilotSystem.disengage('MANUAL_REEL');
            d.audioSystem?.playClick();
            break;
          }
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
      // digit-selecting a DEPLOYED arm and by LAUNCH_CEREMONY_COMPLETE. P was
      // left unbound then; it is pause / resume now (case 'KeyP' above).

      // G key — Shift+G = Trawl sweep (toggle). Bare G is unbound.
      case 'KeyG':
        if (isGameplay && e.shiftKey) {
          eventBus.emit(Events.TRAWL_START);
          e.preventDefault();
        }
        break;

      case 'KeyE':
        if (isGameplay) {
          eventBus.emit(Events.EDT_DEPLOY);
          d.audioSystem.playClick();
          e.preventDefault();
        }
        break;

      // L key — de-spin laser (hold L). The continuous beam is driven by the held-key poll in processInput(); this
      // keydown only gives a no-target affordance. Also live in ARM_PILOT when the piloted arm is station-keeping a
      // target (the SK readout advises "de-spin [L]"). This key never touches recall (that is Shift+R).
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

      // D key:
      //   Bare D in orbital view → Deploy the SELECTED docked daughter (1-4 picks which; D launches it) + start the
      //     launch ceremony. Falls back to auto-pick (best docked arm) when no docked arm is selected.
      //   Shift+D      → Deploy ALL docked arms to the selected target.
      //   D / Shift+D work the same whether or not a daughter is being piloted.
      //   Ctrl+D       → debug overlay, DEV ONLY (Constants.DEBUG.DEBUG_OVERLAY_HOTKEY, flipped by ?debug=1). Off in
      //     production so Ctrl+D stays the browser's bookmark shortcut.
      case 'KeyD':
        if (e.ctrlKey) {
          // Dev-only: when the flag is off we do NOTHING (no preventDefault, so the browser's Ctrl+D works). The
          // branch still CLAIMS the combo either way, so Ctrl+D can never fall through to the bare-D deploy path below.
          if (Constants.DEBUG.DEBUG_OVERLAY_HOTKEY) {
            e.preventDefault();
            if (d.debugOverlay) d.debugOverlay.toggle();
          }
        } else if (e.shiftKey && isGameplay && d.armManager && !e.repeat) {
          // Shift+D: one daughter per piece, best first: the picked piece (else the best free one) goes first, the other
          // docked daughters take the next free pieces.
          const picked = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          const { first, more, ownedOnly } = this._fanOutPieces(picked, 'shift_d');
          if (!first && ownedOnly) {
            // Pieces exist but every one has an owner: send nobody (the free-fly send below would put daughters out
            // with no piece) and say the same line Shift+N says.
            this._sayFanOutNone();
            d.audioSystem?.playDeny?.();
          } else {
            d.armManager.deployAllToTarget(first, more);
            d.audioSystem?.playClick();
          }
          e.preventDefault();
        } else if (isGameplay && !e.repeat) {
          // Pick-then-launch: if a DOCKED daughter is selected with 1-4, launch THAT one by index; otherwise fall back
          // to the auto-pick deploy path (GameFlowManager.deployArm picks the best docked arm).
          const am = d.armManager;
          const selIdx = am ? am.selectedArmIndex : -1;
          const selArm = (am && selIdx >= 0) ? am.arms[selIdx] : null;
          const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
          let deployedOk = false;
          let launchedByIndex = false;
          const dockedBefore = this._dockedArms(am);
          if (selArm && selArm.state === Constants.ARM_STATES.DOCKED) {
            // deployArmByIndex + arm.deploy/deployFreefly already emit a specific refusal comms on every reachable
            // failure (spring/fuel/power/safe-mode/mass); the only silent path (not-DOCKED) is guarded above.
            deployedOk = am.deployArmByIndex(selIdx, target, { announce: true });
            launchedByIndex = true;
          } else {
            // A piece that already has an owner, or every free strut crossing a line already out, is refused here in one
            // line (the auto-pick below would say the same, then add a generic second line).
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
            // A launch the keep-out gate (or the aim ceremony, which emits its own LAUNCH_CEREMONY_START) is holding
            // back leaves the selected daughter DOCKED for now: announce only a launch that has happened.
            // Auto-pick: only an arm that was docked at the press and is not now (a launch still waiting announces itself
            // when it fires).
            const deployed = launchedByIndex
              ? (selArm.state !== 'DOCKED' ? [selArm] : [])
              : dockedBefore.filter(a => a.state !== 'DOCKED');
            if (deployed.length > 0) {
              const arm = deployed[deployed.length - 1];
              // No "deployed. Tracking…" line: the one launch line is "Spring released. Separating" (ArmUnit, at
              // ARM_SPRING_FIRED); only the cut-scene start is announced here.
              // The auto-picked daughter is the selected one (the by-index launch already is), so the zoom
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

      // Q key (pair-shot, owner 2026-10-25 "2 a"): launch the PAIR the game has marked (a daughter and her
      // opposite partner, each at her own piece, in the same frame). The second piece shows a second reticle while a pair
      // is offered; with none offered the key says so in one line. D still launches the one selected daughter alone. The
      // touch PAIR button presses this same key (TouchControls).
      case 'KeyQ':
        if (isGameplay && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && d.armManager && typeof d.armManager.firePair === 'function') {
          const started = d.armManager.firePair();
          if (started) d.audioSystem?.playClick(); else d.audioSystem?.playDeny?.();
          e.preventDefault();
        }
        break;

      // A key: Shift+A = "go salvage the field" combo; plain A = autopilot toggle. Works in both mother and daughter modes.
      case 'KeyA':
        if (isGameplay && !e.repeat) {
          if (e.shiftKey) {
            // Shift+A: one press to
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

      // S key: Quick Scan (bare S) / Wide Scan "scan big area" (Shift+S); both work in mother and daughter modes.
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

      // F key — the furnace joke (owner 2026-10-09: the old forge "doesn't really work"). FORGE_TOGGLE is still emitted so
      // the journal skill and chapter beat that trigger on it stay reachable (the old forge module is gone, nothing
      // subscribes); then the F1-bar FURNACE gag runs. Both mother and daughter.
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
      // redundant binding was removed: 7 is the single comms key now. C was later rebound (see case 'KeyC').
      // Note: ',' is NOT
      // free — Comma is the ROSA furl/unfurl toggle (see the 'Comma' case).
      // Shift+C city-labels moved to 5 in the 2026-06-14 revamp and is also free.

      // PageUp / PageDown — comms history scrolling.
      // Zoom Ladder (00-spec §5): PgUp/PgDn = ride one floor up/down, so the engaged ladder claims both keys BEFORE the
      // legacy comms scroll (the debris-map intercept deliberately lets these two keys fall through to here, so the
      // engaged ladder also wins over the map's comms use).
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

      // N key — net/capture verb:
      //   Shift+N        → auto-acquire the best in-range debris target, then deploy ALL docked daughters at it.
      //   ARM_PILOT mode → Deploy net / capture (multi-tool dispatch in SK).
      //   Mother mode    → Lasso / Net fire.
      case 'KeyN':
        if (!isGameplay) break;
        if (e.shiftKey) {
          e.preventDefault();
          this._autoTargetAndLaunch();
          d.audioSystem?.playClick();
          break;
        }
        // (0) A daughter already HOLDING the active target (station-keeping on it): N works her tool with no pilot
        // mode — the daughter-in-position line promises "Press N" (DECISIONS §33 row 9, 2026-10-20). This branch never
        // fires the mother's nets; while piloting a daughter the pilot-mode branch below owns N.
        if (!(this.armPilotMode && d.cameraSystem)) {
          const holder = this.findHoldingDaughter();
          if (holder) {
            e.preventDefault();
            this.captureWithDaughter(holder);
            break;
          }
        }
        if (this.armPilotMode && d.cameraSystem) {
          e.preventDefault();
          this.captureWithPilotedArm();
          break;
        }
        // Key auto-repeat never counts as a press (net-odds-1107 D10): holding N must not become the quick shot of the line-up
        // the first press started, nor a new net after the last one left.
        if (e.repeat) { e.preventDefault(); break; }
        // (2) MOTHER lasso fire: N is the single lasso/net fire verb. Delegated to fireLasso() (also used by the
        // onboarding smart-default) so windup/fire tuning can't drift between paths.
        if (d.lassoSystem) {
          e.preventDefault();
          this.fireLasso();
        }
        break;

      // J key — Journal / Skills (Discoveries) toggle. The toggle is owned by SkillsPane.toggleExpanded() (document-level
      // _onKeyDown on KeyJ); this no-op case is a marker so grepping "case 'Key" finds J.
      case 'KeyJ':
        break;

      // K: jettison the berthed mother catch. The abort path for a slipped, dead or mis-berthed catch, and for a player
      // who wants the launcher back before the securing timer commits the catch for score.
      case 'KeyK':
        if (isGameplay && !e.repeat && d.captureNetSystem
            && typeof d.captureNetSystem.releaseDockedCatch === 'function') {
          // owner 2026-10-28: K falls through to the bag on a daughter's rack ONLY when the mother's collar holds nothing;
          // a refused mother let-go (a big piece, a hand-off in flight) is an answer, never a reason to let go of something else.
          const collar = typeof d.captureNetSystem.getDockedCatch === 'function' ? d.captureNetSystem.getDockedCatch() : null;
          if (collar || typeof d.letGoRackBag !== 'function') {
            if (d.captureNetSystem.releaseDockedCatch()) {
              d.audioSystem?.playClick?.();
            }
          } else if (d.letGoRackBag()) {
            d.audioSystem?.playClick?.();
          }
          e.preventDefault();
        }
        break;

      // U: choose what to do with a big catch. Opens (and closes) the fate list (ui/FateList.js), only with a big piece
      // aboard on floors 2-4 (the list decides: `toggleFromKey`). The list's own arrows / Enter / Esc are taken by its
      // capture listener, not here.
      case 'KeyU':
        if (isGameplay && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const fateList = typeof d.getFateList === 'function' ? d.getFateList() : null;
          if (fateList && typeof fateList.toggleFromKey === 'function' && fateList.toggleFromKey()) {
            d.audioSystem?.playClick?.();
            e.preventDefault();
          }
        }
        break;

      // Comma (,): ROSA panel furl/unfurl toggle: rolls the solar arrays up to dodge debris / tether strikes (at a power
      // cost), or unfurls them again. Shift+Comma feathers instead: parks the wings edge-on (faster than a full furl,
      // wings stay deployed). Debris Map "previous" is handled by the map-open intercept, which returns before this switch.
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
      // Period (.): "Struts" toggle: one key stows/deploys all docked struts. Drives Debris Map "next" while the map is open.
      case 'Period':
        if (isGameplay && d.debrisMap && d.debrisMap.isVisible()) {
          d.debrisMap.selectNext();
          e.preventDefault();
        } else if (isGameplay && d.armManager) {
          // ONE copy of the strut law: delegate to ArmManager.toggleStruts(); the angles (one press 34°, a quick
          // second press 90°, the next press 0°) and the double-tap timer (STRUT_PUSH_WINDOW_MS) live there.
          // With a daughter selected (1-4) and docked, "." moves only her strut; with no
          // selection (or she is away) it moves every docked arm.
          const selStrutIdx = d.armManager.selectedArmIndex;
          d.armManager.toggleStruts(selStrutIdx >= 0 ? selStrutIdx : undefined);
          d.audioSystem?.playClick();
          // A press that moves nothing says why (a holding daughter's strut never goes below her hold pose)
          if (d.armManager.lastStrutPressNote) {
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'SPACECRAFT', channel: 'CMD',
              text: d.armManager.lastStrutPressNote,
              priority: 'info',
            });
          }
          eventBus.emit(Events.STRUT_DEPLOY_INPUT);
          e.preventDefault();
        }
        break;

      // C key — "Move a catch to a radiator" (owner 2026-10-22: transfer to a radiator strut is risky, an option when all
      // daughters are full, not automatic). Bare C only (Shift/Ctrl/Alt/Meta+C stay unbound). It starts ONE
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

      // T key — "Target debris": cycle the active debris target (same as the Tab alias) in BOTH mother and daughter
      // modes.
      case 'KeyT':
        if (isGameplay && !e.repeat) {
          this._cycleTarget();
          d.audioSystem?.playClick();
          e.preventDefault();
        }
        break;

      // Space — "do the next thing" rapid-advance. Onboarding still owns Space FIRST: while a beat is live the
      // OnboardingDirector smart-default dispatches that beat's primary key. When it declines (post-onboarding, or no
      // live beat), Space synthesizes the next step of the core loop — Scan → Target → Autopilot → Daughter launch →
      // Capture — one step per press (daughter-first, net fallback).
      case 'Space': {
        // Zoom Ladder (00-spec §5): Space = the per-floor verb (F3 lens toggle, F4 approach-autopilot, F5 approach,
        // F6 plan transfer, F7 flip lens). The engaged ladder claims Space BEFORE the legacy resolver below; the
        // launch/net ceremony Space-skips (top-level intercepts) still return before this, keeping their takeover-cancel
        // priority.
        const spaceLadder = this._ladderIfEngaged();
        if (spaceLadder) {
          spaceLadder.command({ type: 'space' });
          e.preventDefault();
          return;
        }
        if (!isGameplay) break;
        const spaceAllowed =
          currentState === GameStates.ORBITAL_VIEW ||
          currentState === GameStates.APPROACH ||
          this.armPilotMode;
        if (!spaceAllowed) break;

        // Onboarding smart-default gets first crack.
        if (d.onboardingDirector && typeof d.onboardingDirector.pressActiveHint === 'function'
            && d.onboardingDirector.pressActiveHint(this)) {
          e.preventDefault();
          break;
        }

        const action = resolveNextDevAction(this._buildDevSnapshot());
        if (action) {
          this._dispatchDevAction(action);
          e.preventDefault();
        }
        break;
      }

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

      case 'KeyZ':
        // Z is the game's analyse action: it opens target info in simple mode. Cmd/Ctrl+Z (undo) is not analyse; text
        // fields and menus never get here (the guards above).
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

      // Arm selection (1-6) / Power Distribution (Shift+1-3)
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
      // Number-row toggles: the help menu's Advanced card defines 5-0 as display toggles:
      //   5 City names · 6 Constellation names · 7 Comms · 8 NavSphere ·
      //   9 Debris pane · 0 Target pane.
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
          // owner 2026-09-07: remember the player's 6-key choice in settings (rides the sc_settings_v1 blob); no event
          // is emitted (nothing listens). The first frame ships OFF; this only records an explicit preference.
          settingsManager.setConstellations(on);
          // Reactive feedback: Starfield is a THREE object with no comms of its own, so InputManager narrates.
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

      // Crossbow launch-speed dial: `;` down / `'` up. Fleet-wide on the ArmManager API; the arm clamps to its spring
      // tier's ceiling, so the default 10 m/s never overruns T1/T2. Repeat allowed (hold to sweep). Feedback rides
      // LAUNCH_SPEED_CHANGED → the arms-panel header (the power-bus pattern: click + HUD, no comms spam).
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

      // Pane density (bare +/-) · Mother throttle (Shift + +/-). Bare +/- drive the HUD pane density ladder; the
      // throttle ±10% verb is Shift+=/Shift+-. The STATION_KEEP standoff-distance reuse of bare +/- (while piloting a
      // station-keeping daughter) is the carve-out below; the held-key radius loop lives in processInput.
      case 'Equal':      // + key (=/+ on US keyboards)
      case 'NumpadAdd':   // Numpad +
        if (isGameplay) {
          // Browser zoom (Cmd/Ctrl + =) belongs to the browser: bail BEFORE the STATION_KEEP carve-out so no modifier
          // combo is swallowed. Clear the just-set held-key flag too: _handleKeyDown sets keys[e.code] unconditionally
          // at the top, and the continuous STATION_KEEP radius poll in processInput reads raw held-key state; without
          // this clear it would emit ARM_ORBIT_ADJUST every frame while the modifier is held.
          if (e.metaKey || e.ctrlKey) { this.keys[e.code] = false; break; }
          // +/- reused for orbital radius in STATION_KEEP (carve-out FIRST so piloting a station-keeping daughter is
          // unchanged).
          const _skPlus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skPlus && _skPlus.state === Constants.ARM_STATES.STATION_KEEP) break;
          if (e.shiftKey) {
            // Mother throttle +10% (keeps the TUTORIAL/ZOOM aliases so the onboarding camera-zoom + throttle beats
            // still accept a keyboard).
            if (d.player) {
              const newUp = Math.min(1.0, d.player.throttleLevel + 0.1);
              d.player.setThrottleLevel(Math.round(newUp * 10) / 10);
              eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
              eventBus.emit(Events.CAMERA_ZOOM_INPUT);
            }
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (!e.repeat) {
            eventBus.emit(Events.HUD_DENSITY_UP);
            d.audioSystem?.playClick();
            e.preventDefault();
          }
        }
        break;
      case 'Minus':       // - key
      case 'NumpadSubtract': // Numpad -
        if (isGameplay) {
          // Browser zoom (Cmd/Ctrl + -) belongs to the browser; see the Equal case above for why the bail also clears the
          // held-key flag.
          if (e.metaKey || e.ctrlKey) { this.keys[e.code] = false; break; }
          // +/- reused for orbital radius in STATION_KEEP
          const _skMinus = this.armPilotMode && d.cameraSystem?.getPilotedArm();
          if (_skMinus && _skMinus.state === Constants.ARM_STATES.STATION_KEEP) break;
          if (e.shiftKey) {
            if (d.player) {
              const newDown = Math.max(0.0, d.player.throttleLevel - 0.1);
              d.player.setThrottleLevel(Math.round(newDown * 10) / 10);
              eventBus.emit(Events.TUTORIAL_THROTTLE_INPUT);
              eventBus.emit(Events.CAMERA_ZOOM_INPUT);
            }
            d.audioSystem?.playClick();
            e.preventDefault();
          } else if (!e.repeat) {
            eventBus.emit(Events.HUD_DENSITY_DOWN);
            d.audioSystem?.playClick();
            e.preventDefault();
          }
        }
        break;

      // --- Backtick: in ARM_PILOT STATION_KEEP it cycles the piloted arm's
      //     tool. The Debris-Map toggle was retired 2026-10-09 (H1); otherwise
      //     the key does nothing. The old Shift+` mother-side tool cycle was
      //     removed (hotkey cleanup 2026-06-13b). ---
      case 'Backquote':
        if (isGameplay && !e.repeat) {
          // Plain backtick in STATION_KEEP cycles the piloted arm's tool (NET → … → MAGNET).
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

      // I key: toggle Codex Library / Info. The Tech Library opens from ANY screen (menu, paused, win, gameplay): it is
      // reference material, not a gameplay-only HUD; the open-codex intercept above handles I/ESC while open.
      case 'KeyI':
        if (d.codexViewerUI) {
          d.codexViewerUI.toggle();
          d.audioSystem?.playClick();
          // Emit CODEX_OPENED on OPEN only: toggle() also closes, and firing unconditionally mis-triggered
          // TeachingSystem's first_codex (and skills discovery) on close.
          if (typeof d.codexViewerUI.isVisible !== 'function' || d.codexViewerUI.isVisible()) {
            eventBus.emit(Events.CODEX_OPENED);
          }
          e.preventDefault();
        }
        break;

      // ? (Slash): toggle the keyboard-shortcut reference overlay. Like the Codex, it opens from ANY screen (menu,
      // briefing, shop, paused, win, gameplay); the open-overlay intercept above handles ?/ESC while open.
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
   * @param {KeyboardEvent} e
   */
  _handleKeyUp(e) {
    this.keys[e.code] = false;
  }

  /**
   * Cycle the active debris target (TPI-sorted), shared by the `Tab` alias and the `T` verb; same list as the HUD.
   * @private
   */
  _cycleTarget() {
    const d = this._deps;
    try {
      // FIX_PLAN §4: same target list as the HUD (sorted upstream by TPI)
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
    eventBus.emit(Events.TUTORIAL_TAB_INPUT);
  }

  /**
   * The pieces a one-per-piece send (Shift+D, Shift+N) hands the daughters, best first: `picked` (the player's pick) leads;
   * the rest are the eligible pieces (the pane's TPI-sorted, tracked/IR-filtered list) that nobody owns yet. With no pick,
   * the best free piece becomes the pick (selected, so the HUD agrees).
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
      // No pane helper (older mocks): the pick alone, or a single acquire.
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
   * Shift+N "Auto-target + launch at debris in range": acquire the best in-range piece that nobody owns (top of the
   * TPI-sorted HUD list, honoring the tracked/IR filter), make it the active target, then send ONE daughter per piece,
   * best first. Warns via comms when nothing is in range or no arms are available.
   * @private
   */
  _autoTargetAndLaunch() {
    const d = this._deps;
    let plan = { first: null, more: [], ownedOnly: false };
    try {
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

  /** Shift+D / Shift+N found pieces, but every one already has an owner: say so, send nobody. @private */
  _sayFanOutNone() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT', channel: 'CMD', text: fanOutNoneText(), priority: 'warning',
    });
  }

  /** Who owns `piece` (the arm manager's answer, which sees daughters, nets and the lasso), or null. @private */
  _pieceClaim(piece, opts) {
    const am = this._deps && this._deps.armManager;
    return am && typeof am.pieceClaimOf === 'function' ? am.pieceClaimOf(piece, opts) : null;
  }

  /**
   * N (the small net, the large net) at a piece a daughter is flying to or lining up a launch for, or a net is already
   * on its way to: say what to do instead and start nothing. A piece a daughter HOLDS is not refused here: N works her
   * tool before this is reached (findHoldingDaughter); any other route to a held piece is refused like the rest.
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
   * Shift+A "field-center salvage" combo. One press:
   *   1. Autopilot the MOTHER to the debris-field center (densest / highest-value cluster) via
   *      DebrisMap.engageBestCluster().
   *   2. Fan EVERY docked daughter out to a DISTINCT debris (best TPI-ranked, tracked/IR-filtered) via
   *      ArmManager.deployAllToDistinctTargets().
   *   3. Fire the MOTHER NET at a SEPARATE debris: the best in-range one not assigned to any daughter.
   *      Falls through gracefully when nothing is in range or no daughters are available.
   * @private
   */
  _fieldCenterSalvage() {
    const d = this._deps;
    // A newer Shift+A ends an older press's wait at once, before anything else: whichever way this press goes (a refusal,
    // a daughters-only send that never reaches `_afterNetSettles`), the older press's daughters are never sent twice.
    if (this._netWait) this._netWait.settle('drop');

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

    // Nothing is tracked yet (no scan): daughters would fly out with no piece and be reeled straight back.
    // Say what to do first and start nothing, not even the autopilot.
    if (!Array.isArray(eligible) || eligible.length === 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'SPACECRAFT', channel: 'CMD', text: SCAN_FIRST_LINE, priority: 'warning',
      });
      d.audioSystem?.playDeny?.();
      return;
    }

    // (1) Mother → field center; older DebrisMap stubs fall back to the selected cluster.
    if (d.debrisMap) {
      if (typeof d.debrisMap.engageBestCluster === 'function') {
        d.debrisMap.engageBestCluster();
      } else if (typeof d.debrisMap.engageSelectedCluster === 'function') {
        d.debrisMap.engageSelectedCluster();
      }
    }

    // Docked, spring-charged daughters: each gets a distinct target, and one SEPARATE piece is reserved for the net.
    const arms = (d.armManager && Array.isArray(d.armManager.arms)) ? d.armManager.arms : [];
    const dockedCount = arms.filter(a =>
      a && a.state === Constants.ARM_STATES.DOCKED && a.springCharged).length;

    const free = [];
    for (const t of eligible) {
      const debris = d.debrisField.getDebrisById(t.id);
      if (!debris) continue;
      const claim = this._pieceClaim(debris);
      if (claim && !isFree(claim)) continue;
      free.push(debris);
    }

    // (3) The NET takes the best free piece inside the reach of the net that would fire at it (else daughters taking the
    // near pieces first leave the net nothing in reach); then the daughters take the remaining free pieces, one each,
    // best first. A daughter is never sent to the piece the net takes.
    let netTarget = null;
    for (const debris of free) {
      if (this._withinNetReach(debris)) { netTarget = debris; break; }
    }
    const daughterDebris = free.filter((x) => x !== netTarget).slice(0, dockedCount);

    // (2) Daughters to distinct debris; surplus daughters fall back to the mother's active target, unless the net takes it.
    const sendDaughters = () => {
      if (d.armManager && typeof d.armManager.deployAllToDistinctTargets === 'function') {
        let fallback = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
        if (fallback && netTarget && fallback.id === netTarget.id) fallback = null;
        d.armManager.deployAllToDistinctTargets(daughterDebris, fallback);
      } else if (d.armManager && typeof d.armManager.deployAllToTarget === 'function') {
        d.armManager.deployAllToTarget(daughterDebris[0] || (d.targetSelector ? d.targetSelector.getActiveTarget() : null));
      }
    };

    // (3 cont.) The net goes FIRST: make its piece the active target so fireLasso() casts at it, then fire. The ship's own
    // turn for the net happens before any daughter launches; they go once the ship has settled (their lines are judged
    // again at the spring).
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
      // Pieces are left, all past what a net can reach: daughters only, and the line says so.
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
   * Run `send` (Shift+A's daughter launches) once the ship has settled after the net's own turn. Nothing to wait for
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
    if (this._netWait) this._netWait.settle('drop');          // a new Shift+A ends the older wait; its daughters are not sent twice
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
    // `how`: 'send' | 'drop'. The steering check runs in the tick after, once every listener of this emit has run.
    wait.settle = (how) => {
      if (wait.done) return;
      wait.done = true;
      setTimeout(() => {                  // after the call that emitted this has unwound (the net is out, the turn is over)
        off();
        if (how === 'drop') return;
        // The line is true only when the turn ended BECAUSE of the steering (the autopilot's 'Manual attitude input'); a turn
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
   * The clock of `_afterNetSettles`, in game seconds. Called every frame from `processInput(dt)`, which the game loop
   * skips while paused, so paused time does not count.
   * @param {number} dt
   * @private
   */
  _tickNetWait(dt) {
    const w = this._netWait;
    if (!w || w.done || !(dt > 0)) return;
    w.elapsed += dt;
    if (w.graceAt !== null && w.elapsed >= w.graceAt) { w.settle('send'); return; }
    const ap = this._deps && this._deps.autopilotSystem;
    // An aim on the reaction wheels is long by design (no 30 s wheel limit: about 151 s for 90° at radiators 146°): the cap
    // below is the gas aim's. While the wheels turn her the wait goes on (the aim's own end or time-out settles it: `onAim`); an aim the
    // wheels hand to the gas is a gas aim again, with the cap's seconds from then.
    if (ap && typeof ap.isAimOnWheels === 'function' && ap.isAimOnWheels()) { w.onWheels = true; return; }
    if (w.onWheels) {
      w.onWheels = false;
      w.cap = Math.max(w.cap, w.elapsed + ((Constants.AIM && Constants.AIM.AIM_TIMEOUT_S) || 30) + 3);
      return;
    }
    if (w.elapsed >= w.cap) {
      if (ap && typeof ap.isAiming === 'function' && ap.isAiming() && w.extended < 2) { w.extended++; w.cap += 3; return; }
      w.settle('send');
    }
  }

  /** The player steered while the ship turned for the net: the daughters stay docked; say how to send them. @private */
  _sayDaughtersHeldBack() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'SPACECRAFT', channel: 'CMD', priority: 'info',
      text: daughtersHeldBackLine(),   // Shift+A on a keyboard; a row in DAUGHTERS + the SEND DAUGHTER chip on glass
    });
  }

  /**
   * Number key for a daughter ("spinning plates"):
   *   • DOCKED   → SELECT only (glow/flash via ARM_SELECT). Mother stays in view; the player then launches the
   *     selected daughter with D. NO deploy, NO camera switch.
   *   • DEPLOYED → SELECT + switch camera to that daughter (pilot it).
   *   • HOLDING_CATCH → SELECT only, like DOCKED: she is home on her strut, never piloted.
   *   • EXPENDED → warn.
   *   • Re-press the ACTIVE daughter's digit while she is PILOTED → return to mother: exit the pilot camera + deselect
   *     WITHOUT recalling (the daughter keeps working; the canonical "pop back" toggle).
   *   • Re-press the active daughter's digit while she is out on her tether but NOT piloted (the state DEPLOY leaves
   *     her in under the zoom ladder) → pilot her, keep her selected.
   *     Home or busy states (docked, holding, reloading, docking, carry) still deselect.
   * Arms 5-8 are deferred until tiers ship: only digits 1-4 exist today.
   * @private
   * @param {number} armIndex - 0-based arm index
   */
  _handleArmKey(armIndex) {
    const d = this._deps;
    // DECISIONS §46 row 1: any number key ends the view that went to a waiting daughter (piloting follows as before)
    if (d && d.cameraSystem && typeof d.cameraSystem.endWaitView === 'function') d.cameraSystem.endWaitView('number key');
    if (!d.armManager) return;

    const arm = d.armManager.arms[armIndex];
    if (!arm) return;

    if (d.armManager.selectedArmIndex === armIndex) {
      // DEPLOY was pressed and the mother is still turning for her (or the gate holds her launch): she is still DOCKED
      // and selected; her number must not deselect her now (no-op). Once she has launched, one tap pilots her (below).
      if (arm.state === Constants.ARM_STATES.DOCKED && typeof d.armManager.isLaunchPending === 'function'
          && d.armManager.isLaunchPending(armIndex)) return;
      // owner 2026-10-22: after DEPLOY one tap on her number flies her (not "first tap deselects, two taps to fly").
      // She is selected, out on her tether, NOT piloted (the state DEPLOY leaves her in under the zoom ladder), so her
      // number pilots her and keeps her selected. Never the toggling selectArm on a selected daughter.
      if (!this.armPilotMode && !isHomeOrBusyArmState(arm.state)) {
        this._enterArmPilotCamera(arm);
        if (arm.state === Constants.ARM_STATES.ADRIFT) this._postAdriftLine(arm);
        return;
      }
      // Piloted (or home / busy): back to mother, deselect, but do NOT recall (a launched daughter keeps working).
      this._exitArmPilotCamera();
      d.armManager.deselectArm();
      return;
    }

    if (arm.state === Constants.ARM_STATES.DOCKED) {
      // If another daughter is being piloted, leave pilot mode first (as for a holding daughter below), so the
      // camera, the strip, D and "." all refer to the daughter just selected.
      this._exitArmPilotCamera();
      d.armManager.selectArm(armIndex);
    } else if (arm.state === Constants.ARM_STATES.HOLDING_CATCH) {
      // owner 2026-10-22: a daughter parked on her strut with a catch is HOME, like a docked one: SELECT only, never
      // pilot (she cannot be flown, N and R do nothing for her, and the pilot view's range beeps would run against the
      // piece on her own rack). If another daughter is being piloted, leave pilot mode first, so the view, the strip,
      // C and "." refer to her.
      this._exitArmPilotCamera();
      d.armManager.selectArm(armIndex);
    } else if (arm.state === Constants.ARM_STATES.ADRIFT) {
      // Out of usable FEEP but STILL tethered and powered (avionics live): select + pilot works; nudge her reel-in.
      d.armManager.selectArm(armIndex);
      this._enterArmPilotCamera(arm);
      this._postAdriftLine(arm);
    } else if (arm.state === Constants.ARM_STATES.EXPENDED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName} is expended. Not available`,
        priority: 'warning',
      });
    } else {
      d.armManager.selectArm(armIndex);
      this._enterArmPilotCamera(arm);
    }
  }

  /** The "adrift" comms line for a daughter whose number was just pressed (select + pilot, or pilot while selected). @private */
  _postAdriftLine(arm) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'CMD',
      text: arm._adriftCause === 'battery'
        ? `${arm.displayName} is adrift. Battery flat, thrusters off. Press R to reel her home.`   // DECISIONS §53 row 3: a flat pack, not a dry tank
        : `${arm.displayName} is adrift. Thrusters dry, avionics live. Press R to reel her home.`,
      priority: 'info',
    });
  }

  /**
   * Switch camera to ARM_PILOT mode following `arm`, enabling its manual control and releasing the previously piloted arm.
   * @private
   * @param {object} arm - ArmUnit to follow
   */
  _enterArmPilotCamera(arm) {
    const d = this._deps;
    if (!d.cameraSystem) return;

    // The "how to get back" line is posted on a fresh entry only (not when switching the piloted arm).
    const wasPiloting = this.armPilotMode;

    if (this.armPilotMode) {
      const prevArm = d.cameraSystem.getPilotedArm();
      if (prevArm && prevArm !== arm && prevArm.disableManual) {
        prevArm.disableManual();
      }
    }

    this.armPilotMode = true;
    if (arm.enableManual) arm.enableManual();
    d.cameraSystem.setPilotArm(arm);

    // Exits are Esc or her number again; spell them out on entry so new players don't feel stuck.
    if (!wasPiloting) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: pilotLine(arm.displayName),
        source: 'HOUSTON',
        channel: 'CMD',
        priority: 'info',
      });
    }
  }

  /** Exit ARM_PILOT camera mode (restore FOV, return to CHASE). @private */
  _exitArmPilotCamera() {
    const d = this._deps;
    if (!this.armPilotMode) return;

    this.armPilotMode = false;
    const pilotedArm = d.cameraSystem ? d.cameraSystem.getPilotedArm() : null;
    if (pilotedArm && pilotedArm.disableManual) pilotedArm.disableManual();
    if (d.cameraSystem) d.cameraSystem.clearPilotArm();
  }

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
    const nearby = (debrisField.getDebrisNear(arm.position, captureRange) || []).filter((p) => !(p && p._disposed));
    if (nearby && nearby.length > 0) {
      const closest = nearby[0];
      const debris = debrisField.getDebrisById
        ? debrisField.getDebrisById(closest.id)
        : closest;
      return debris || null;
    }
    return null;
  }

  /**
   * Resolve the de-spin laser's override target while piloting a daughter: eligible only when the piloted arm is in
   * STATION_KEEP; returns its SK target (or null). Shared by the KeyL no-target warning and the processInput() laser
   * steering, so the warning and the actual beam eligibility cannot drift apart.
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
    if (dt > 0) this._frameClockS = (this._frameClockS || 0) + dt;   // the lead provider's frame clock (game seconds: the loop's capped dt × SimClock k, ≤ 0.8 s; no cap here)
    this._tickNetWait(dt);       // the Shift+A daughters' wait for the net's turn runs on game time
    this._tickNetLineup(dt);     // the Large Net's line-up meter (net-odds-1107 D9) runs on game time too
    this._sampleReach(dt);       // the piece's velocity relative to the ship, for the reach-at-arrival check

    // De-spin laser (hold L): set the fire intent every frame BEFORE the overlay early-returns so it releases when an
    // overlay opens or the key is let go. Also live while piloting a daughter in STATION_KEEP (the SK readout advises
    // "de-spin [L]"), steered at the piloted arm's SK target (override), not the Tab-locked target.
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

    // Hold Shift: BOOST reel ×2 on reeling daughters. Set every frame (like the laser intent above) so it releases on
    // keyup/overlay. Shift is otherwise only a modifier (Shift+R/V/D/A/N/S/G), so a bare hold is conflict-free.
    if (d.armManager && typeof d.armManager.setReelBoost === 'function') {
      const boostHeld = !overlayOpen
        && (this.keys['ShiftLeft'] === true || this.keys['ShiftRight'] === true);
      d.armManager.setReelBoost(boostHeld);
    }

    if (d.codexViewerUI && d.codexViewerUI.isVisible()) return;
    if (d.hotkeyOverlay && d.hotkeyOverlay.isVisible()) return;
    if (d.debrisMap && d.debrisMap.isVisible()) return;

    const ionDir = { x: 0, y: 0, z: 0 };
    let hasIon = false;
    let thrustType = 'ion';

    // No WASD daughter thrust: daughters are flown with the arrow keys (station-keep orbit) only, and W/A/S/D keep their
    // mother-mode meanings (wide/quick scan, autopilot, launch) even while piloting. ionDir therefore stays zero from
    // the keyboard; ARM_MANUAL_THRUST is not emitted from held keys.
    const apEngaged = d.autopilotSystem && d.autopilotSystem.engaged;

    if (this.armPilotMode) {
      const skArm = d.cameraSystem?.getPilotedArm();
      if (skArm && skArm.state === Constants.ARM_STATES.STATION_KEEP) {
        // 'R' (recall/reel-in) is handled in _onKeyDown (one-shot); auto-return (dwell-then-ease) recenters.
        // Screen-aligned axes: θ in the frozen entry frame = YAW around the camera-up axis (horizontal screen motion)
        // → ←/→; φ = PITCH around the camera-right axis (vertical screen motion) → ↑/↓.
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

      // Context switch (ARM PILOT only; no mothership thrust). Priority 1: camera-tracked piloted daughter.
      // Priority 2: arm selected via number keys 1-4 and deployed/pilotable.
      if (this.armPilotMode && d.cameraSystem) {
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
        const selectedArm = d.armManager.getSelectedDeployedArm();
        if (selectedArm) {
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

    let thrustAudioDir = 'lateral';
    if (ionDir.z > 0.5) thrustAudioDir = 'prograde';
    else if (ionDir.z < -0.5) thrustAudioDir = 'retrograde';

    if (hasIon) {
      const audioType = (thrustType === 'arm' || thrustType === 'rcs' || thrustType === 'mpd') ? 'ion' : thrustType;
      // Arm-pilot FEEPs are micro-newton thrusters: much quieter than the mothership's main bus.
      // 0.4× intensity = ~−8 dB: fades into the ambient mix but still gives input feedback.
      const intensity = (thrustType === 'arm') ? 0.4 : 1.0;
      d.audioSystem.startThrusterHum(audioType, thrustAudioDir, intensity);
    } else if (apEngaged && !this.armPilotMode) {
      // Autopilot is thrusting: FEEP hum. Suppressed during ARM PILOT (mother just holds station; the constant
      // hum was reported as annoying).
      d.audioSystem.startThrusterHum('ion', 'prograde');
    } else {
      d.audioSystem.stopThrusterHum();
    }

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

    // Arrow keys: pitch / yaw of the mothership. Skipped while the autopilot is engaged (it controls heading) and
    // when the piloted arm is in STATION_KEEP (the arrows then orbit the daughter).
    const _skGuardArm = this.armPilotMode && d.cameraSystem?.getPilotedArm();
    const _inStationKeep = _skGuardArm && _skGuardArm.state === Constants.ARM_STATES.STATION_KEEP;

    // A scripted whole-ship turn (leash hand-off) locks the arrows out: they take the else branch below (no
    // MOTHER_MANUAL_ROTATE, no commandAttitude: no gas, no plumes).
    if (!apEngaged && !_inStationKeep && !d.autopilotSystem?.isTurning?.()) {
      // Attitude is rate-commanded through the rigid-body integrator: derive per-axis input (+1/0/−1), emit the
      // manual-rotate cancel on a fresh press, pass the tether lock tier, hand off to commandAttitude. The hold
      // controller (not an input-side stop-pulse) owns arrest.
      if (!this._prevArrowKeys) this._prevArrowKeys = { up: false, down: false, left: false, right: false };
      const _pk = this._prevArrowKeys;
      const _prevUp = _pk.up, _prevDown = _pk.down, _prevLeft = _pk.left, _prevRight = _pk.right;
      _pk.up    = !!this.keys['ArrowUp'];
      _pk.down  = !!this.keys['ArrowDown'];
      _pk.left  = !!this.keys['ArrowLeft'];
      _pk.right = !!this.keys['ArrowRight'];

      const _freshPress = (_pk.up && !_prevUp) || (_pk.down && !_prevDown) ||
          (_pk.left && !_prevLeft) || (_pk.right && !_prevRight);
      if (_freshPress) {
        eventBus.emit(Events.MOTHER_MANUAL_ROTATE);
        d.audioSystem.playRcsPuff?.();
      }

      // Per-axis rate demand: Up=pitch+, Down=pitch−, Left=yaw+, Right=yaw−.
      let pitchIn = 0, yawIn = 0;
      if (_pk.up)    pitchIn += 1;
      if (_pk.down)  pitchIn -= 1;
      if (_pk.left)  yawIn   += 1;
      if (_pk.right) yawIn   -= 1;

      // Tether lock tier gates the command magnitude AND drives the restoring-torque constraint on the satellite.
      // Full authority when 'none'.
      const tier = d.armManager?.getRotationLockTier?.() || 'none';
      d.player.setAttitudeConstraintTier?.(tier);

      // Comms warning when pushing into a saturated tether limit (the satellite tracks displacement; this only
      // surfaces the message).
      if (tier !== 'none' && (pitchIn !== 0 || yawIn !== 0) &&
          d.player.isAttitudeConstraintSaturated?.(pitchIn, yawIn)) {
        this._maybeEmitTetherLockMsg();
      }

      d.player.commandAttitude(pitchIn, yawIn, dt);

      // Sustained RCS hiss at the REAL attitude-thrust level (post-gate command + hold/arrest burn), like the ion hum
      // above: quiet while coasting at the rate cap, swells during the arrest burn.
      const rcsLevel = d.player.getAttitudeThrustLevel?.() ?? 0;
      if (rcsLevel > 0) d.audioSystem.startRcsHiss?.(rcsLevel);
      else d.audioSystem.stopRcsHiss?.();
    } else {
      // AP / station-keep / scripted turn active: drop the held-key record so re-enabling manual
      // control can't fire a phantom command from a stale "held" state.
      this._prevArrowKeys = null;
      // Autopilot/station-keep owns attitude: the manual RCS hiss must not stick.
      d.audioSystem.stopRcsHiss?.();
    }
  }

  /** Tether rotation-lock COMMS warning, shared by _handleKeyDown and processInput; one message per COMMS_THROTTLE_MS. */
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

  // --- OnboardingDirector.pressActiveHint() helpers: same effect as the raw key handler, no synthesized KeyboardEvents
  // (avoids re-entry via the keydown router); no-ops when dependencies aren't ready.

  fireScan() {
    const d = this._deps; if (!d) return;
    eventBus.emit(Events.SCAN_QUICK);
    eventBus.emit(Events.TUTORIAL_SCAN_INPUT);
    d.audioSystem?.playClick?.();
  }

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

  engageAutopilot() {
    const d = this._deps; if (!d) return;
    if (d.autopilotSystem && typeof d.autopilotSystem.toggle === 'function') {
      d.autopilotSystem.toggle();
      d.audioSystem?.playClick?.();
    }
  }

  /** Fire the lasso (windup → cast): the one implementation for the KeyN path and the OnboardingDirector smart-default. */
  fireLasso() {
    const d = this._deps; if (!d || !d.lassoSystem) return;
    if (this._lassoWindingUp || d.lassoSystem.active) return;

    // ── Mother nets: one count, two launchers (DECISIONS §33 row 1) ──
    // 4 nets, owned by CaptureNetSystem; N fires one at any piece in range while nets remain:
    //   · piece ≤ LASSO_MAX_CAPTURE_MASS (10 kg), or no Tab-selected target (welcome-field auto-aim) → small net below;
    //   · heavier (classifyNetTarget band 'mother' or 'whale') → the large net (fireMotherNet).
    // Both spend from the same count when the shot really launches, so a refused press costs nothing. At 0 nets: one
    // line, nothing starts (no aim slew toward an unfireable shot).
    const activeTarget = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
    const cns = d.captureNetSystem;
    // A piece a daughter is flying to / launching at, or a net is flying at, is taken: say what to do instead, start
    // nothing (before routing, so both nets are covered).
    if (activeTarget && this._refuseNetAtOwnedPiece(activeTarget)) return;
    if (cns && Constants.isFeatureEnabled('CAPTURE_NET')) {
      if (typeof cns.getMotherNetCount === 'function' && cns.getMotherNetCount() <= 0) {
        eventBus.emit(Events.LASSO_DENIED, { reason: 'no_ammo' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: this._dInviteText(OUT_OF_MOTHER_NETS_LINE, activeTarget),
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'warning',
          _lassoFeedback: true,
        });
        d.audioSystem?.playDeny?.() ?? d.audioSystem?.playClick?.();
        return;
      }
      // Beyond the reach of the net N would fire, but a docked daughter can go that far: say so once, start nothing
      // (DECISIONS §33 row 3). Not during the mission-1 tutorial; beyond every reach the path's own refusal speaks.
      if (activeTarget && this._beyondNetReachButDaughterCan(activeTarget)) {
        eventBus.emit(Events.LASSO_DENIED, { reason: 'out_of_net_range' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: this._dInviteText(OUT_OF_NET_RANGE_LINE, activeTarget),
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

    // Small net too: refuse (nothing spent) a piece that will have drifted past reach by the time the net gets there.
    if (activeTarget && this._refuseDriftOutOfReach(activeTarget)) return;

    // The nose collar (or a leash hand-off on it) is busy: LassoSystem.fire would refuse, but only AFTER the aim turn
    // (~16 s of ship turning, steering gas spent, the hand-off's own turn and hold stripped). Say so now, start nothing.
    if (this._refuseCollarBusy()) return;

    // ── Aim-before-launch (as the Large Net): only with a selected target in lasso range, autopilot and live attitude;
    // the no-target auto-aim stays instant.
    const ap = d.autopilotSystem;
    if (ap && typeof ap.isAiming === 'function' && ap.isAiming()) {
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
        // Scratch reused across ticks: the aim coroutine polls this every frame and copies the result into
        // _aimTargetDir immediately (AutopilotSystem._tickAimCoroutine), so returning the same object is safe.
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
        const aimDir = provider();
        let aligned = false;
        if (aimDir) {
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion).normalize();
          const dot = Math.max(-1, Math.min(1, fwd.dot(new THREE.Vector3(aimDir.x, aimDir.y, aimDir.z))));
          aligned = (radToDeg(Math.acos(dot))) <= Constants.AIM.NET_AIM_TOLERANCE_DEG;
        }
        if (!aligned) {
          // The wheels turn her however long it takes (no wheel limit: `AIM.WHEEL_LIMIT_S`; the aim's own time-out scales from its
          // wheel estimate); a slow turn on the tail boxes longer than the aim's 30 s (AIM_TIMEOUT_S) is refused at once (`TOO_SLOW`)
          ap.requestAimRotation(provider, { mode: 'net', aimDir: aimDir || undefined, maxWaitS: Constants.AIM.AIM_TIMEOUT_S, wheelLimitS: Constants.AIM.WHEEL_LIMIT_S })
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
   * N while the nose collar is busy: refuse BEFORE any aim turn, windup or gas (DECISIONS §61 row 1), with the lasso's own
   * `collar_busy` denial and line (LassoSystem.fire says the same, but only after the turn). Busy = a catch on the collar,
   * a mother net away, a lasso catch waiting for the collar, or a leash hand-off running; while the hand-off runs, the line adds
   * its time left (counted through the unfold; none in the nose pull-in or the recovery: no true count there). With the nose
   * full the line is the nose-full text. `leashOnly` (the large net, which may fire past a catch on the collar) checks the hand-off alone:
   * its aim turn would replace the hand-off's own turn and hold.
   * @param {{leashOnly?: boolean}} [opts]
   * @returns {boolean} true when refused (nothing started)
   */
  _refuseCollarBusy(opts) {
    const d = this._deps; if (!d) return false;
    const leashOnly = !!(opts && opts.leashOnly);
    const cns = d.captureNetSystem;
    const { busy, waitS } = collarBusyState({
      leashDriver: d.player && d.player.leashDriver, captureNetSystem: cns,
      pendingAdoption: !!(d.lassoSystem && d.lassoSystem._pendingAdoption), leashOnly,
    });
    if (!busy) return false;
    // `waitS` (the shared predicate): a number only in the stage where it is true (counted through the line out, the turns, the
    // reel, the latch and the radiator's unfold); none in the nose pull-in (its clock restarts) or in the recovery.
    const noseFull = !leashOnly && cns && typeof cns.getNoseFullLine === 'function' ? cns.getNoseFullLine() : null;
    eventBus.emit(Events.LASSO_DENIED, { reason: 'collar_busy' });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: noseFull || collarBusyLine(waitS),
      source: 'SYSTEM',
      channel: 'CMD',
      priority: 'warning',
      _lassoFeedback: true,
    });
    d.audioSystem?.playDeny?.();
    return true;
  }

  /**
   * Every frame, note the active piece's position relative to the ship centre and keep a smoothed velocity (scene
   * units per real second, the unit the aim's lead uses). Allocation-free; resets when the piece changes.
   * @param {number} dt real seconds
   */
  _sampleReach(dt) {
    const d = this._deps;
    const ts = d && d.targetSelector;
    const t = ts && typeof ts.getActiveTarget === 'function' ? ts.getActiveTarget() : null;
    const sp = t && t._scenePosition;
    const pp = d && d.player && (d.player.position || (typeof d.player.getPosition === 'function' ? d.player.getPosition() : null));
    // A long gap (pause / warp) starts over. The game loop hands up to 0.8 s (its 0.1 s cap × SimClock k 8 while the
    // wheels turn her): a frame, not a gap.
    if (!sp || !pp || dt > 1) { this._reachTrack = null; return; }   // nothing to track, or a long gap: start over
    if (!(dt > 1e-4)) return;
    const rx = sp.x - pp.x, ry = sp.y - pp.y, rz = sp.z - pp.z;
    const tr = this._reachTrack;
    if (tr && tr.id === t.id) {
      // Frame dt is capped (0.1 s), so a gap never shows in dt: a jump in the relative position (trip arrival, warp,
      // respawn) is the tell. 50 m in one 0.1 s frame is 500+ m/s relative, not motion: start over (the bound grows with
      // a longer game step, so ×8 frames keep the same 500 m/s line).
      const jx = rx - tr.rx, jy = ry - tr.ry, jz = rz - tr.rz;
      const jumpSc = 50 * Constants.SCENE_UNITS_PER_METER * Math.max(1, Math.max(dt, tr.dt || 0) / 0.1);
      if (jx * jx + jy * jy + jz * jz > jumpSc * jumpSc) { this._reachTrack = null; return this._startReachTrack(t.id, rx, ry, rz, dt); }
      // The position seen now was moved by the PREVIOUS frame's step, so its velocity is delta / that frame's dt.
      const mdt = tr.dt > 1e-4 ? tr.dt : dt;
      const ivx = jx / mdt, ivy = jy / mdt, ivz = jz / mdt;
      if (tr.n === 0) { tr.vx = ivx; tr.vy = ivy; tr.vz = ivz; } else {
        const a = 0.2;   // EMA, as the lead provider
        tr.vx += a * (ivx - tr.vx); tr.vy += a * (ivy - tr.vy); tr.vz += a * (ivz - tr.vz);
      }
      tr.rx = rx; tr.ry = ry; tr.rz = rz; tr.n++; tr.dt = dt;
      return;
    }
    this._startReachTrack(t.id, rx, ry, rz, dt);
  }

  _startReachTrack(id, rx, ry, rz, dt) {
    this._reachTrack = { id, rx, ry, rz, vx: 0, vy: 0, vz: 0, n: 0, dt, rv: { x: 0, y: 0, z: 0 } };
  }

  /** The tracked velocity of `piece` relative to the ship (scene units / real s), or null until a few frames have been seen. */
  _reachRelVel(piece) {
    const tr = this._reachTrack;
    if (!tr || !piece || tr.id !== piece.id || tr.n < 4) return null;
    tr.rv.x = tr.vx; tr.rv.y = tr.vy; tr.rv.z = tr.vz;
    return tr.rv;
  }

  /**
   * The piece's velocity relative to the ship from the two orbits (scene units / real s), for the first press after a pick,
   * before `_sampleReach` has 4 frames. Both are inertial km/s (debris `orbitToSceneCartesianInto`, ship `getVelocity`); one
   * real second is `TimeAuthority.BASE_SCALE` game seconds (the unit `netFlightSpeedMps` uses; a warp rate on top is not
   * read, and the tracker takes over after 4 frames). Null for a piece that does not follow its orbit (an onboarding or arm
   * pin, a captured piece, a position that is not on its orbit), no orbit, or a ship with no velocity. Matched to a finite difference of two propagated orbits in
   * test-NetReachGate.js.
   * @param {object} piece
   * @returns {{x:number,y:number,z:number}|null}
   */
  _orbitRelVel(piece) {
    const d = this._deps;
    const pl = d && d.player;
    if (!piece || !piece.orbit || piece._onboardingPinned || piece._armPinned || piece._capturedByArm || piece._captured) return null;
    if (!pl || typeof pl.getVelocity !== 'function') return null;
    const sv = pl.getVelocity();
    if (!sv || !Number.isFinite(sv.x + sv.y + sv.z)) return null;
    const pos = this._orbPos || (this._orbPos = { x: 0, y: 0, z: 0 });
    const vel = this._orbVel || (this._orbVel = { x: 0, y: 0, z: 0 });
    orbitToSceneCartesianInto(piece.orbit, pos, vel);
    if (!Number.isFinite(vel.x + vel.y + vel.z)) return null;
    // Only a piece that sits where its orbit says (DebrisField draws it there): a pin, a scenario override or a stand-in
    // is off its orbit by far more than this.
    const sp = piece._scenePosition;
    const tol = 2 * Constants.SCENE_UNITS_PER_METER;
    if (!sp || Math.abs(sp.x - pos.x) > tol || Math.abs(sp.y - pos.y) > tol || Math.abs(sp.z - pos.z) > tol) return null;
    const k = Constants.SCENE_SCALE * TimeAuthority.BASE_SCALE;   // km/s of game time -> scene units per real second
    const out = this._orbRel || (this._orbRel = { x: 0, y: 0, z: 0 });
    out.x = (vel.x - sv.x) * k; out.y = (vel.y - sv.y) * k; out.z = (vel.z - sv.z) * k;
    return out;
  }

  /**
   * The speed and launch delay of a large net (a mother's, or a daughter's) in WALL seconds, the unit the piece's drift is
   * measured in: its own LAUNCH_SPEED and (CAST_WINDUP + SPIN_UP_TIME) on its own clock, divided / multiplied by what the
   * net ceremony will do to that clock (`netFlightClockScale`, with the conditions the camera starts a ceremony under read
   * from the camera system). A daughter's net runs on the same ceremony clock (CaptureNet.update scales every net's dt),
   * but a ceremony only starts for her while the camera is piloting a daughter.
   * @param {boolean} isMother - a mother net (else a daughter's)
   * @param {number} nominalSpeedMps - the net class's LAUNCH_SPEED
   * @param {number} rangeM - launcher to piece now (the net's own seconds to contact depend on it)
   * @returns {{speedMps:number, delayS:number, scale:number}}
   */
  _netFlightClock(isMother, nominalSpeedMps, rangeM) {
    const CN = Constants.CAPTURE_NET;
    const rawDelayS = (CN.CAST_WINDUP || 0) + (CN.SPIN_UP_TIME || 0);
    const cam = this._deps && this._deps.cameraSystem;
    const piloted = cam && typeof cam.getPilotedArm === 'function' ? cam.getPilotedArm() : null;
    const scale = netFlightClockScale(
      !persistenceManager.getCeremonyFlag(isMother ? 'FIRST_MOTHER_NET_DEPLOY' : 'FIRST_NET_DEPLOY'),
      {
        launchCeremonyActive: !!(cam && cam._launchCeremony && cam._launchCeremony.active),
        noLauncher: !isMother && !(piloted && piloted.position),
        runningScale: cam && cam._netCeremony && cam._netCeremony.active ? CeremonyTimeScale.get() : null,
        ladder: !!(cam && typeof cam.isLadderActive === 'function' && cam.isLadderActive()),
        internalS: rawDelayS + (nominalSpeedMps > 0 && rangeM > 0 ? rangeM / nominalSpeedMps : 0),
      });
    return { speedMps: nominalSpeedMps * scale, delayS: rawDelayS / scale, scale };
  }

  /**
   * The small-net (lasso) fire gate for the player's own pick: one plain line, LASSO_DENIED, nothing spent or started
   * (no windup, no attitude hold), and N never re-aims at another piece (owner 2026-11-01: "N still launches mother net even
   * if debris is out of range"). Refuses a piece that (1) has no position, (2) is beyond the lasso's reach now, or (3) will
   * be beyond it when the net makes contact. (3) is the mother-net helper `netArrivalRangeM`: the launch delay, the lasso's
   * REAL flight (`lassoFlightParams`: eased speed, contact radius, LASSO_MIN_FLIGHT_TIME, the same numbers `fire()` uses), and
   * the piece's velocity relative to the ship: the tracked one, else the two orbits' on a fresh pick (`_orbitRelVel`). With
   * neither (a ship-relative pin rides the mother) the range now is right. The large net runs the same test in
   * fireMotherNet's refusals.
   * @param {object} piece - the active target
   * @param {number} [delayS] - seconds from now to the start of the flight: the cast windup at the press; 0 once it has run
   * @returns {boolean} true when refused
   */
  _refuseDriftOutOfReach(piece, delayS = Constants.LASSO_CAST_WINDUP || 0) {
    const d = this._deps;
    if (!piece || !d || !d.player || typeof d.player.getPosition !== 'function') return false;
    if (classifyNetTarget(piece.mass || 0).band !== 'lasso') return false;   // the large net's own gate handles those
    const deny = (reason, text) => {
      eventBus.emit(Events.LASSO_DENIED, { reason });
      eventBus.emit(Events.COMMS_MESSAGE, { text, source: 'SYSTEM', channel: 'CMD', priority: 'warning', _lassoFeedback: true });
      d.audioSystem?.playDeny?.();
      return true;
    };
    const ts = d.targetSelector;
    const sp = (ts && typeof ts.getActiveTargetPosition === 'function' ? ts.getActiveTargetPosition() : null)
      || piece._scenePosition || null;
    if (!sp) return deny('no_target', lassoNoFixLine());                    // no position, no judgement: never cast unjudged
    const reachM = netReachForMassM(piece.mass || 0);
    const ship = d.player.getPosition();
    const nowM = targetRangeM(ship, sp);
    if (nowM > reachM) return deny('no_target', netRangeLine(nowM, reachM, 'lasso'));
    const rv = this._reachRelVel(piece) || this._orbitRelVel(piece);
    if (!rv) return false;                                                   // nothing to predict from: the range now is all there is
    // The muzzle sits LASSO_MUZZLE_OFFSET_M ahead of the hull, toward the piece once the ship has turned to it.
    const M = Constants.SCENE_UNITS_PER_METER;
    const k = nowM > 0 ? Constants.LASSO_MUZZLE_OFFSET_M / nowM : 0;
    const muzzle = { x: ship.x + (sp.x - ship.x) * k, y: ship.y + (sp.y - ship.y) * k, z: ship.z + (sp.z - ship.z) * k };
    const launchM = Math.hypot(sp.x - muzzle.x, sp.y - muzzle.y, sp.z - muzzle.z) / M;
    const { contactRadiusM, speedMps } = lassoFlightParams(launchM);
    const arriveM = netArrivalRangeM(ship, muzzle, sp, rv, speedMps, delayS, contactRadiusM, Constants.LASSO_MIN_FLIGHT_TIME);
    if (!(arriveM > reachM)) return false;
    return deny('drift_out_of_reach', driftOutOfReachLine(arriveM));
  }

  /**
   * The lasso windup → cast, split out so aim-before-launch can defer it until the mother faces the target. Safe to
   * call directly (headless mocks, no-target auto-aim, already-aligned fast path).
   * @param {{afterAim?: boolean}} [opts] — `afterAim`: the ship has just turned to face the target; a cast refused
   *   after that turn leaves her pointed where she is instead of recentering toward prograde.
   */
  _castLasso(opts) {
    const d = this._deps; if (!d || !d.lassoSystem) return;
    const afterAim = !!(opts && opts.afterAim);
    if (this._lassoWindingUp || d.lassoSystem.active) return;
    // Hold attitude BEFORE the windup so the prograde auto-orient can't slew the nose off-target during it (~5°
    // backslide); AutopilotSystem releases it on reel-in end (LASSO_STOWED/SNAPPED/MISSED).
    d.autopilotSystem?.holdAttitude?.();
    this._lassoWindingUp = true;
    d.audioSystem?.playClick?.();
    const windupMs = (Constants.LASSO_CAST_WINDUP || 0.15) * 1000;
    this._lassoWindupTimeout = setTimeout(() => {
      this._lassoWindingUp = false;
      this._lassoWindupTimeout = null;
      // Fire along the ship's actual NOSE (+Z): the muzzle/flight/reel geometry must use the frame the mother slewed
      // to, so the catch reels back to the current nose. Falls back to velocity with no attitude (headless).
      let fwdDir;
      if (d.player.quaternion) {
        fwdDir = new THREE.Vector3(0, 0, 1).applyQuaternion(d.player.quaternion);
      } else {
        const vel = d.player.getVelocity();
        fwdDir = new THREE.Vector3(vel.x, vel.y, vel.z);
      }
      if (fwdDir.lengthSq() > 0) fwdDir.normalize();
      const target = d.targetSelector ? d.targetSelector.getActiveTarget() : null;
      // The piece may have been taken during the windup (a daughter's launch, a net): re-check at release.
      if (target && this._refuseNetAtOwnedPiece(target)) {
        d.autopilotSystem?.releaseAttitudeHold?.({ ifUnowned: true });
        if (afterAim) d.player.holdHeadingAfterRefusal?.();
        return;
      }
      // The target is re-read after the windup: if the player Tab-selected a piece the small net cannot hold meanwhile,
      // route it to the mother-net path as fireLasso does. Nothing spent yet; the attitude hold is released first.
      if (target && d.captureNetSystem && Constants.isFeatureEnabled('CAPTURE_NET')
          && classifyNetTarget(target.mass || 0).band !== 'lasso') {
        d.autopilotSystem?.releaseAttitudeHold?.({ ifUnowned: true });
        this.fireMotherNet(target);
        return;
      }
      if (target && this._refuseDriftOutOfReach(target, 0)) {   // the windup has run: no launch delay left
        d.autopilotSystem?.releaseAttitudeHold?.({ ifUnowned: true });
        if (afterAim) d.player.holdHeadingAfterRefusal?.();
        return;
      }
      const cast = d.lassoSystem.fire(d.player.getPosition(), d.debrisField, fwdDir, target);
      // A refused cast (out of arc, cargo full, no ammo, cooldown…) fires no reel-in end event: release the attitude
      // hold now, or the ship stays frozen until the safety cap.
      if (cast === false) {
        d.autopilotSystem?.releaseAttitudeHold?.({ ifUnowned: true });
        if (afterAim) d.player.holdHeadingAfterRefusal?.();
      }
    }, windupMs);
  }

  /**
   * Fire the Mother's Large Net launcher at a piece heavier than the small net holds (> LASSO_MAX_CAPTURE_MASS, up to
   * the net's rating; DECISIONS §33). One launcher, on the axis: podIndex is always 0.
   * @param {object} target — the selected debris (mass > 10 kg)
   */
  fireMotherNet(target) {
    const d = this._deps; if (!d || !d.captureNetSystem || !d.player) return;
    // A line-up is running (net-odds-1107 D10): this press is the quick shot, not a new net. Checked before the isAiming()
    // test below, which the line-up's own hold aim would trip. A line-up for another piece is stale: end it (no net) first.
    if (this._netLineup) {
      if (this._netLineup.target === target) { this._pressQuickShot(this._netLineup); return; }
      this._endNetLineup({ fire: false, reason: 'Target changed', code: 'TARGET_CHANGED' });
    }
    if (target && target._disposed === true) return;   // a disposed-of piece is no catch (never aimed at)
    if (tripRefuses('net')) return;   // refuse BEFORE the ship slews to aim (CaptureNet would refuse only after the turn)
    const cns = d.captureNetSystem;
    const ap = d.autopilotSystem;

    const podIndex = 0;

    // Empty-magazine pre-check FIRST: never rotate with nothing to fire (CaptureNetSystem emits the comms).
    if (cns.getMotherPodInventory(podIndex) <= 0 ||
        (typeof cns.isMotherPodOnCooldown === 'function' && cns.isMotherPodOnCooldown(podIndex))) {
      cns.fireMotherNet(podIndex, d.player.getPosition(), { x: 0, y: 0, z: 1 }, target);
      return;
    }

    // A leash hand-off is turning the ship / holding its attitude: the aim below would replace its turn and hold. Refuse now.
    if (this._refuseCollarBusy({ leashOnly: true })) return;

    if (ap && typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info', source: 'HOUSTON',
      });
      return;
    }

    const M = 0.00001; // 1 metre in scene units
    const netClass = (typeof cns.getMotherNetClass === 'function')
      ? cns.getMotherNetClass(podIndex) : null;
    // The net flies on its own slowed clock (netFlightClockScale), the piece drifts on the world clock: the lead, the launch
    // delay and the reach-at-contact check all use the net's speed and delay in WALL seconds, the unit the drift is in.
    // The scale depends on the range (a ceremony's later beats run at other scales), so each user asks for its own range.
    const nominalSpeedMps = (netClass && netClass.LAUNCH_SPEED) || 10.0;
    const flightClock = (rangeM) => this._netFlightClock(true, nominalSpeedMps, rangeM);
    // ── Pre-flight refusals: scene-unit endpoint math lives HERE; CaptureNetSystem keeps only frame-free gates (unit
    // tests use metre positions). Run pre-slew and again in fireNow() (the shot may leave the envelope during the slew).
    const maxReachM = netClass ? netMaxReachM(netClass) : 0;
    const DRIFT_REFUSE_MS = 5.0; // apparent m/s — beyond this the lead solution is unreachable
    const refuse = (text) => {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text, source: 'SYSTEM', channel: 'CMD', priority: 'warning',
      });
      d.audioSystem?.playDeny?.();
    };
    // lead.relVel is filled by the lead provider's EMA on every provider
    // tick; the pre-slew check seeds it with one synchronous sample below.
    const checkRefusals = (relVelScenePerS) => {
      if (!target || target.alive === false) {
        refuse('Target lost.'); return true;
      }
      // One owner per piece; a daughter's launch or a lasso may take it during the slew.
      {
        const claim = this._pieceClaim(target);
        const owned = claim && !isFree(claim) ? netRefusalLine(claim) : null;
        if (owned) { refuse(owned); return true; }
      }
      // Hard refuse above the net's rated mass (a 23 t CZ-5B can never be held).
      const mass = target.mass || 0;
      // The mother's catch limit (§49 row 1, 1,500 kg): the ship's limit, not the net's strength. Plain words, never a net rating.
      if (overCatchLimit(mass, netClass)) {
        refuse(catchLimitLine(mass, netClass));
        return true;
      }
      const rated = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
      if (rated > 0 && mass > rated) {
        refuse(`Beyond net rating — ${mass >= 1000 ? `${(mass / 1000).toFixed(1)} t` : `${Math.round(mass)} kg`} exceeds the ${(rated / 1000).toFixed(0)} t ${(netClass && netClass.NAME) || 'Large Net'}.`);
        return true;
      }
      const muzzle = (typeof d.player.getNetPodPositionInto === 'function')
        ? d.player.getNetPodPositionInto(podIndex, muzzleScratch)
        : (typeof d.player.getNetPodPosition === 'function')
          ? d.player.getNetPodPosition(podIndex) : d.player.getPosition();
      // The selector's position; the piece's own when the selector has none (the aim provider keeps reading the selector only,
      // so a piece the selector lost mid-slew still aborts the turn).
      const tp = getTargetPos() || (target && target._scenePosition) || null;
      if (!tp && maxReachM > 0) {
        // No position, no judgement: never launch unjudged (the range and the arrival test both need it).
        refuse(`Out of net envelope (${Math.round(maxReachM)}m): can't see where the piece is. Pick it again.`);
        return true;
      }
      if (tp && maxReachM > 0) {
        // The SAME distance the HUD shows (ship centre → piece, targetRangeM), not muzzle → piece.
        const rangeM = targetRangeM(d.player.getPosition(), tp);
        if (rangeM > maxReachM) {
          refuse(netRangeLine(rangeM, maxReachM, 'net'));
          return true;
        }
        // Inside reach NOW is not enough: the net sits on the ship for the launch delay (CAST_WINDUP + SPIN_UP_TIME), then
        // takes ~10 s to arrive. Predict the piece's range at contact (netArrivalRangeM: delay, flight from the muzzle to
        // one mouth radius short of the piece, straight-line drift). Velocity: the tracked one, else the lead provider's,
        // else the two orbits' (a fresh pick has no samples yet); none at all: the range now is all there is. Past reach:
        // refuse, no net spent.
        const rv = this._reachRelVel(target) || relVelScenePerS || this._orbitRelVel(target);
        const fc = flightClock(rangeM);
        const arriveM = netArrivalRangeM(d.player.getPosition(), muzzle, tp, rv,
          fc.speedMps, fc.delayS, ((netClass && netClass.DIAMETER) || 0) / 2);
        if (arriveM > maxReachM) {
          eventBus.emit(Events.LASSO_DENIED, { reason: 'drift_out_of_reach' });
          refuse(driftOutOfReachLine(arriveM));
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
      // Launcher busy: a second net while one is airborne gets no visual (keyed per pod, early-returns); the HUD tracks the wrong net.
      if (typeof cns.hasMotherNetInFlight === 'function' && cns.hasMotherNetInFlight()) {
        refuse('Net already away.');
        return true;
      }
      const noseFull = typeof cns.getNoseFullLine === 'function' ? cns.getNoseFullLine() : null;
      if (noseFull) { refuse(noseFull); return true; }
      // Shot fouls the mated cargo: per-shot and geometric. The pods are off the boresight, so collar occupancy alone
      // is NEVER a refusal; only a shot whose corridor crosses the cargo. Pre-slew uses the muzzle→target bearing;
      // fireMotherNet re-checks with the fire-time direction (ship +Z).
      if (tp && typeof cns.getCollarShotFoul === 'function') {
        const pM = { x: muzzle.x / M, y: muzzle.y / M, z: muzzle.z / M };
        const dM = { x: (tp.x - muzzle.x) / M, y: (tp.y - muzzle.y) / M, z: (tp.z - muzzle.z) / M };
        const dl = Math.sqrt(dM.x * dM.x + dM.y * dM.y + dM.z * dM.z) || 1;
        if (cns.getCollarShotFoul(podIndex, pM, { x: dM.x / dl, y: dM.y / dl, z: dM.z / dl })) {
          refuse('This shot fouls the cargo at the collar — pull off the nose, or press K to let the catch go.');
          return true;
        }
      }
      // A holder whose catch cannot clear this net's path without touching a radiator wing holds the net back (every
      // refused press says so; C may then move her catch). A pending wing profile is finished here if small.
      {
        const am = d.armManager;
        const blocked = am && typeof am.motherNetHolderBlock === 'function' ? am.motherNetHolderBlock(target) : -1;
        if (blocked >= 0) { refuse(am.motherNetBlockLine(blocked)); return true; }
      }
      return false;
    };

    // Lead-aim provider, recomputed per tick. relVel = target − mother scene velocity (EMA of per-frame position
    // deltas, as ArmUnit._updateNettingFSM). Scratch objects are reused (no per-frame allocation); the muzzle is
    // written into muzzleScratch via getNetPodPositionInto().
    const muzzleScratch = new THREE.Vector3();
    const targetScratch = new THREE.Vector3();
    const lead = {
      prevT: { x: 0, y: 0, z: 0 }, prevM: { x: 0, y: 0, z: 0 }, prevTime: null, advanced: { x: 0, y: 0, z: 0 },
      relVel: null, relVelBuf: { x: 0, y: 0, z: 0 },
      leadOut: { dir: { x: 0, y: 0, z: 0 }, offAxisDeg: 0 },
    };
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
      // The velocity is measured against the ship CENTRE, as the reach tracker does: the muzzle sits off the axis, so its
      // own motion while the ship slews is not a drift of the piece, and over the net's slow flight it would lead the aim
      // by metres (a still piece cost 30-65 % more cold gas to line up).
      const ctr = d.player.position || d.player.getPosition();
      // Time in FRAMES, not wall time: `_frameClockS` is the sum of the dt processInput was given (capped at 0.1 s, the
      // unit the reach tracker and the world run on). A second call in the same frame (pre-slew gate, then aimDir) sees
      // no new frame whatever the CPU did between the calls, and a slow frame reads its capped dt, not the wall gap.
      const clock = this._frameClockS || 0;
      // The reach tracker is this velocity already, on that clock: use it whenever it has frames (4 after a pick).
      const trk = this._reachRelVel(target);
      if (trk && Number.isFinite(trk.x + trk.y + trk.z)) {
        lead.relVel = lead.relVelBuf;
        lead.relVel.x = trk.x; lead.relVel.y = trk.y; lead.relVel.z = trk.z;
      } else {
        if (lead.prevTime == null && !lead.relVel) {
          // First call, no tracker yet: seed from the two orbits' velocity (scene units per real second, the unit of the
          // EMA below). Without it the first aim has no lead and a ship already on the bore sight fires at once.
          const sv = this._orbitRelVel(target);
          if (sv && Number.isFinite(sv.x + sv.y + sv.z)) {
            lead.relVel = lead.relVelBuf;
            lead.relVel.x = sv.x; lead.relVel.y = sv.y; lead.relVel.z = sv.z;
          }
        }
        // No tracker: a smoothed delta per frame, only once a frame has passed since the last sample.
        if (lead.prevTime != null && clock > lead.prevTime) {
          const dtp = clock - lead.prevTime;
          const rvx = (tPos.x - lead.prevT.x) / dtp - (ctr.x - lead.prevM.x) / dtp;
          const rvy = (tPos.y - lead.prevT.y) / dtp - (ctr.y - lead.prevM.y) / dtp;
          const rvz = (tPos.z - lead.prevT.z) / dtp - (ctr.z - lead.prevM.z) / dtp;
          if (!lead.relVel) {
            // No seed (nothing to read the piece's velocity from): the EMA starts from rest, so a still piece's turn
            // settles exactly as before.
            lead.relVel = lead.relVelBuf;
            lead.relVel.x = 0; lead.relVel.y = 0; lead.relVel.z = 0;
          }
          const a = 0.2; // EMA smoothing
          lead.relVel.x += a * (rvx - lead.relVel.x);
          lead.relVel.y += a * (rvy - lead.relVel.y);
          lead.relVel.z += a * (rvz - lead.relVel.z);
        }
      }
      if (lead.prevTime == null || clock > lead.prevTime) {
        lead.prevT.x = tPos.x; lead.prevT.y = tPos.y; lead.prevT.z = tPos.z;
        lead.prevM.x = ctr.x; lead.prevM.y = ctr.y; lead.prevM.z = ctr.z;
        lead.prevTime = clock;
      }
      // The net sits on the ship for the launch delay (wall seconds, on its slowed clock) while the piece drifts on: aim at
      // where the piece is when the net STARTS, then lead it over the flight.
      const fc = flightClock(Math.hypot(tPos.x - muzzle.x, tPos.y - muzzle.y, tPos.z - muzzle.z) / M);
      let aimAt = tPos;
      if (lead.relVel) {
        aimAt = lead.advanced;
        aimAt.x = tPos.x + lead.relVel.x * fc.delayS;
        aimAt.y = tPos.y + lead.relVel.y * fc.delayS;
        aimAt.z = tPos.z + lead.relVel.z * fc.delayS;
      }
      const { dir } = computeLeadAim(muzzle, aimAt, lead.relVel, fc.speedMps * M, lead.leadOut);
      return dir;
    };

    // Pre-slew gate: one provider tick seeds the relVel EMA; a refusal here must come BEFORE any rotation is requested.
    provider();
    if (checkRefusals(lead.relVel)) return;

    // Launches along the ACTUAL ship +Z at fire time from the current muzzle; direct bearing with no attitude
    // (headless mocks). Returns the net when it left, null when refused (the caller then tells her to stay put).
    // `fireOpts.lineup` = the line-up meter u the shot leaves with (net-odds-1107 D9; the odds snapshot at release reads it);
    // omitted = the call CaptureNet always had (a fully lined-up throw).
    const fireNow = (fireOpts) => {
      // Fire-time re-check: the slew takes seconds and the range/drift picture changes (the AP's VEL_TOL residual
      // moves the range ~45 m over a 9 s slew+flight).
      if (checkRefusals(lead.relVel)) return null;
      const posScene = (typeof d.player.getNetPodPosition === 'function')
        ? d.player.getNetPodPosition(podIndex) : d.player.getPosition();
      // TRAP: NetProjectile works in METRES, the pod accessor returns SCENE UNITS. Divide by M as
      // ArmUnit.js _updateNettingFSM does; skipping it is the "net doesn't move / vanished instantly" defect.
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
      const net = (fireOpts && typeof fireOpts.lineup === 'number')
        ? cns.fireMotherNet(podIndex, pos, dir, target, undefined, { lineup: fireOpts.lineup })
        : cns.fireMotherNet(podIndex, pos, dir, target);
      if (net) {
        if (d.armManager && typeof d.armManager.clearNetBlocks === 'function') d.armManager.clearNetBlocks();   // a shot nobody blocked ends the marks
        d.audioSystem?.playClick?.();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Attitude locked — net away.', priority: 'info', source: 'HOUSTON',
        });
      }
      return net || null;
    };

    // No attitude-aware aiming (no autopilot or live attitude): fire at once (headless mocks).
    if (!ap || typeof ap.requestAimRotation !== 'function' || !d.player.quaternion) {
      fireNow();
      return;
    }

    const aimDir = provider();
    const onLine = !!aimDir && this._netAimErrDeg(aimDir) <= Constants.AIM.NET_AIM_TOLERANCE_DEG;
    // A stand-in autopilot with no hold aim (`endAimHold`: headless mocks) cannot run a line-up: it keeps the instant throw.
    const canHold = typeof ap.endAimHold === 'function';
    if (!canHold && onLine) { fireNow(); return; }

    // owner 2026-10-22: refuse the turn to the net's attitude only if a daughter's line would then run through the
    // ship. (AutopilotSystem.requestAimRotation backstops any other net aim with the same test.) A press already on the
    // line needs no turn, so no wrap check either (it never moved the ship).
    if (aimDir && !onLine && d.armManager && typeof d.armManager.netTurnWraps === 'function') {
      const wrap = d.armManager.netTurnWraps(aimDir);
      if (wrap.wraps) {
        refuse(wrapRefusalLine((wrap.arm && wrap.arm.displayName) || 'A daughter'));
        return;
      }
    }

    // LINE-UP (net-odds-1107 D9): the ship turns to the lead aim (if it is not on it already) and then HOLDS it; the meter u
    // climbs while the error stays inside the tolerance, and the net leaves by itself at u = 1 (`_tickNetLineup`). A press
    // already on the line starts the meter at once, no instant throw. The wheels turn her however long it takes (no wheel
    // limit, `AIM.WHEEL_LIMIT_S`: the aim's time-out and gas hand-over scale from its wheel estimate); a slow turn on the tail
    // boxes (steering gas out, wheels unusable) longer than the aim's 30 s (AIM_TIMEOUT_S) is refused at once with the honest
    // time (`TOO_SLOW`): nothing moves, no net is spent. The lead (`provider`) is read again every frame and aims at where the
    // piece will be when the net leaves, so a long aim still meets it. Reject = no net, no inventory decrement
    // (AutopilotSystem emits the abort comms). A stand-in autopilot (`canHold` false) has no line-up: the aim resolves, the net
    // leaves on arrival, as before.
    const lu = !canHold ? null : {
      target, provider, fireNow,
      u: 0,                    // the meter, 0..1
      started: false,          // the error has been inside the tolerance once: u counts from then
      quickArmed: false,       // a second N came while the error was over the quick tolerance: it throws the first frame inside it
      ending: false,           // the line-up itself is ending the hold aim (its resolve is not an arrival)
      errDeg: Infinity,        // the error at the last tick
      p: null,                 // shown chance now (0..1), null with no honest range
    };
    if (lu) {
      this._netLineup = lu;
      const s0 = this._lineupSnapshot(lu, 0);
      lu.p = s0 ? s0.pShown : null;
    }
    ap.requestAimRotation(provider, { mode: 'net', aimDir: aimDir || undefined, maxWaitS: Constants.AIM.AIM_TIMEOUT_S, wheelLimitS: Constants.AIM.WHEEL_LIMIT_S, hold: !!lu })
      .then(() => {
        if (lu && (lu.ending || this._netLineup !== lu)) return;   // the line-up ended the hold aim itself (net away, or cancelled)
        // The aim resolved by itself: no hold in this autopilot, so today's flow, a throw on arrival (lineup 1).
        if (lu) this._netLineup = null;
        // §9.6: aim-resolve double-tick — the slew settled on the launch attitude ("locked, then confirmed" before the thump).
        d.audioSystem?.playAimResolveTick?.();
        // Refused at fire time (the target left the envelope during the slew, or the net system said no) after the
        // turn: she stays where the turn left her, no thruster fires to turn her back.
        if (!fireNow()) d.player.holdHeadingAfterRefusal?.();
      })
      .catch((err) => {
        // Aborted — nothing fired/spent. A timed-out aim or lost target is a refusal after the turn: the ship stays
        // where it turned. Manual input / superseded / a deliberate target change keep the normal recenter.
        if (lu && this._netLineup === lu) this._netLineup = null;   // the line-up ends with the aim: the ring goes
        if (err && (err.code === 'TIMEOUT' || err.code === 'TARGET_LOST')) d.player.holdHeadingAfterRefusal?.();
      });
    if (lu && this._netLineup === lu && typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Lining up: the net fires when the ring is full. N again throws now.', priority: 'info', source: 'HOUSTON',
      });
    }
  }

  /**
   * The angle (degrees) between the ship's nose (+Z) and a world direction. Infinity with no attitude. Scratch vector reused.
   * @param {{x,y,z}} dir
   * @returns {number}
   * @private
   */
  _netAimErrDeg(dir) {
    const q = this._deps && this._deps.player && this._deps.player.quaternion;
    if (!q || !dir) return Infinity;
    const f = _lineupNose.set(0, 0, 1).applyQuaternion(q).normalize();
    const dot = Math.max(-1, Math.min(1, f.x * dir.x + f.y * dir.y + f.z * dir.z));
    return radToDeg(Math.acos(dot));
  }

  /**
   * The line-up the reticle draws, or null (net-odds-1107 D11). `p` = the chance a shot now gets (0..1, null without an honest
   * range: the ring then draws with no %), the same snapshot the release takes.
   * @returns {{target: object, u: number, p: number|null, livePct: number|null, started: boolean, quickArmed: boolean, errDeg: number}|null}
   */
  getNetLineup() {
    const lu = this._netLineup;
    if (!lu) return null;
    // The aim is gone but the tick has not cleared the line-up yet (up to a frame): nothing runs, so the ring and the touch
    // chip ("Throw now") must not show it.
    const ap = this._deps && this._deps.autopilotSystem;
    if (ap && typeof ap.isAiming === 'function' && !ap.isAiming()) return null;
    return {
      target: lu.target, u: lu.u, p: lu.p, livePct: lu.p == null ? null : netPctText(lu.p),
      started: lu.started, quickArmed: lu.quickArmed, errDeg: lu.errDeg,
    };
  }

  /**
   * End the running line-up. `fire` false: nothing is thrown, the hold aim ends as a cancel (a "Launch aborted" line); the
   * line-up is already gone when the aim's catch runs.
   * @param {{fire?: boolean, reason?: string, code?: string}} [opts]
   * @returns {boolean} true when a hold aim was running and has been ended (false: no line-up, or its aim was already gone)
   * @private
   */
  _endNetLineup({ fire = false, reason = 'line-up ended', code = 'OTHER' } = {}) {
    const lu = this._netLineup;
    if (!lu) return false;
    lu.ending = true;
    this._netLineup = null;
    const ap = this._deps && this._deps.autopilotSystem;
    if (ap && typeof ap.endAimHold === 'function') return !!ap.endAimHold({ fire, reason, code });
    return false;
  }

  /**
   * The chance a shot gets right now: the odds snapshot at the live range (ship centre to the piece's rendered position, the
   * range the release uses) with the meter at `u`. Null when the piece has no rendered position (headless): no honest range.
   * @private
   */
  _lineupSnapshot(lu, u) {
    const d = this._deps;
    const tp = lu.target && lu.target._scenePosition;
    const pos = d && d.player && typeof d.player.getPosition === 'function' ? d.player.getPosition() : null;
    if (!tp || !pos) return null;
    const rangeM = targetRangeM(pos, tp);
    if (!Number.isFinite(rangeM)) return null;
    return buildLineupSnapshot(lu.target, rangeM, { lineup: u });
  }

  /**
   * Release the net of a line-up now with the meter at `u`: ends the hold aim (it resolves like an arrival: the launch follows at
   * once), then throws along the nose as it is. `quick` says the shot's chance in the comms. A refused throw (the piece left
   * the envelope, the net system said no) leaves her where she is, as an aim's refusal does.
   * @private
   */
  _releaseNetLineup(lu, u, quick) {
    const d = this._deps;
    // The hold aim may already be gone (cancelled earlier in this same handler, e.g. a same-target re-select sent
    // TARGET_SELECTED): then there is nothing to release and no one lined this throw up. The line-up is cleared, nothing fires.
    if (!this._endNetLineup({ fire: true })) return;
    d.audioSystem?.playAimResolveTick?.();
    const net = lu.fireNow({ lineup: u });
    if (!net) { d.player.holdHeadingAfterRefusal?.(); return; }
    if (quick) {
      const p = net._lineup && Number.isFinite(net._lineup.pShown) ? net._lineup.pShown : null;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: p == null ? 'Quick throw.' : `Quick throw: ${netPctText(p)}%.`, priority: 'info', source: 'HOUSTON',
      });
    }
  }

  /**
   * A second N while a line-up runs (net-odds-1107 D10): throw now at the meter's u when the error is inside
   * QUICK_AIM_TOL_DEG, else arm the throw for the first frame it is.
   * @private
   */
  _pressQuickShot(lu) {
    const err = this._netAimErrDeg(lu.provider());
    lu.errDeg = err;
    if (err <= Constants.NET_LINEUP.QUICK_AIM_TOL_DEG) { this._releaseNetLineup(lu, lu.u, true); return; }
    lu.quickArmed = true;
  }

  /**
   * One frame of the line-up (net-odds-1107 D9/D10), from processInput on game time: the error to the lead aim, the armed quick
   * shot, the meter (starts at 0 the first time the error is inside the tolerance, climbs LINEUP_S while it stays, holds
   * outside), the auto-throw at u = 1, and the shown % for the ring. A piece disposed of, or an aim that ended some other way,
   * ends it with no net.
   * @param {number} dt game seconds
   * @private
   */
  _tickNetLineup(dt) {
    const lu = this._netLineup;
    if (!lu) return;
    const d = this._deps;
    const ap = d && d.autopilotSystem;
    if (!d || !ap || (typeof ap.isAiming === 'function' && !ap.isAiming())) { this._netLineup = null; return; }
    if (lu.target && (lu.target._disposed === true || lu.target.alive === false)) {
      this._endNetLineup({ fire: false, reason: 'target lost', code: 'TARGET_LOST' });
      return;
    }
    const dir = lu.provider();
    if (!dir) return;                       // the aim itself rejects a lost target ("target lost")
    const L = Constants.NET_LINEUP;
    const err = this._netAimErrDeg(dir);
    lu.errDeg = err;
    if (lu.quickArmed && err <= L.QUICK_AIM_TOL_DEG) { this._releaseNetLineup(lu, lu.u, true); return; }
    if (err <= Constants.AIM.NET_AIM_TOLERANCE_DEG) {
      if (!lu.started) lu.started = true;                      // u starts at 0 here
      else if (dt > 0) lu.u = Math.min(1, lu.u + dt / L.LINEUP_S);
    }
    const snap = this._lineupSnapshot(lu, lu.u);
    lu.p = snap ? snap.pShown : null;
    if (lu.u >= 1) this._releaseNetLineup(lu, 1, false);
  }

  /**
   * True while a net line-up's meter is running (the aim has been within the tolerance once, the line-up has not ended).
   * Allocation-free; SimClock's `netLineup` gate reads it each frame so the automatic ×8 ends and the ring fills in 3 s.
   * @returns {boolean}
   */
  isNetLineupMeterRunning() {
    const lu = this._netLineup;
    return !!(lu && lu.started);
  }

  /**
   * Make `arm` the selected daughter unless she already is (ArmManager.selectArm TOGGLES a selected arm off, so the
   * check comes first). Tolerates a bare arm manager and a missing arm.
   * @param {object} [arm] - an ArmUnit (has `index`)
   */
  _selectLaunched(arm) {
    const am = this._deps?.armManager;
    if (!am || !arm || !Number.isInteger(arm.index) || typeof am.selectArm !== 'function') return;
    if (am.selectedArmIndex !== arm.index) am.selectArm(arm.index, { quiet: true });   // her launch line is enough (one comms line)
  }

  /** The arms docked right now: the auto-pick launch announces only one of these that has left the dock. */
  _dockedArms(am) {
    return am && am.arms ? am.arms.filter(a => a && a.state === Constants.ARM_STATES.DOCKED) : [];
  }

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

  /** Smart-default helper — toggles inspection. No live key binding (bare I opens the Codex); kept for OnboardingDirector. */
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

  cycleView() {
    const d = this._deps; if (!d || !d.cameraSystem || this.armPilotMode) return;
    const lockedId = d.targetSelector?.getActiveTarget?.()?.id ?? null;
    d.cameraSystem.cycleView(lockedId);
    d.audioSystem?.playClick?.();
  }

  /**
   * The daughter capture action with the piloted arm — shared by the `KeyN` ARM_PILOT branch and the Space
   * rapid-advance resolver (mirrors `fireLasso()`):
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
      this.captureWithDaughter(arm, { manual: true });   // the player flew her and pressed N: a manual catch, as in flight (training 2)
      return true;
    }

    if (arm.state === 'TRANSIT' || arm.state === 'APPROACH') {
      const captureTarget = arm.target
        || this._findNearestDebrisToArm(arm, d.debrisField);
      if (captureTarget) {
        // Her manual net is a net like any other (owner 2026-11-01 "Yes, same rule"): refuse, spend nothing, when the piece it is
        // aimed at is past her reach. Judged before `arm.target` is set, so a refusal leaves her exactly as she was.
        if (this._refuseDaughterNetOutOfReach(arm, captureTarget)) return true;
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
   * A line that ends "Press D to send a daughter." (out of nets, out of net range), said as the wait instead while D itself would be
   * refused because the ship must hold still: ArmManager.launchHoldRefusal is the D press's own answer, and the hand-off's seconds
   * come from the same predicate N's busy line reads (collarBusyState). No target or no answer = the line unchanged.
   * @param {string} line
   * @param {object|null} target the piece D would go to
   * @returns {string}
   */
  _dInviteText(line, target) {
    const d = this._deps;
    const am = d && d.armManager;
    const hold = target && am && typeof am.launchHoldRefusal === 'function' ? am.launchHoldRefusal(target) : null;
    if (!hold) return line;
    const { waitS } = collarBusyState({ leashDriver: d.player && d.player.leashDriver });
    return dInviteLine(line, hold, waitS);
  }

  /**
   * Is the piece beyond the reach of the net that N would fire at it, yet inside the reach of a docked daughter that
   * can hold its mass? (DECISIONS §33 row 3: then the one line points at D.)
   *   · the net's reach: the lasso's LASSO_RANGE for a piece ≤ 10 kg, the large net's netMaxReachM above that;
   *   · a daughter's reach: her tether x ARM_DEPLOY_RANGE_FRACTION (the ArmManager deploy-range rule);
   *   · "can hold": spinner <= SPINNER_MAX_CAPTURE_MASS, weaver <= WEAVER_MAX_CAPTURE_MASS.
   * False while the mission-1 tutorial is running (its range beat teaches the autopilot) and when the distance is unknown.
   * @param {object} target — the active target
   * @returns {boolean}
   */
  _beyondNetReachButDaughterCan(target) {
    const d = this._deps || {};
    const dir = d.onboardingDirector;
    if (dir && typeof dir.isMastered === 'function' && !dir.isMastered()) return false;   // tutorial still running
    const mass = target.mass || 0;
    const reachM = netReachForMassM(mass);   // the one reach function (also the reticle's)
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

  /** Inside the reach of the net N would fire at it (see above)? True when the distance is unknown (headless mocks). */
  _withinNetReach(piece) { return withinNetReach(this._deps, piece); }

  /**
   * The daughter, if any, that is HOLDING the active target — N works her tool without pilot mode (DECISIONS §33 row 9).
   * Order: the selected daughter (`armManager.selectedArmIndex`) if she is in STATION_KEEP on the active target, else
   * the first of `armManager.arms` in STATION_KEEP whose `_stationKeepTarget || target` is the active target.
   * With no holder of the active target: a daughter in STATION_KEEP (selected first, else the first in `arms` order)
   * when the mother's net has nothing to do (no active target, beyond net reach, or no mother nets).
   * @returns {object|null} the ArmUnit, or null (no holder, no fallback, or no arm manager)
   */
  findHoldingDaughter() { return holdingDaughter(this._deps, null); }

  /**
   * The daughter N works right now, pilot-aware: flying one → her if in STATION_KEEP, else null; not flying →
   * {@link findHoldingDaughter}. The touch button's lookup (main.js `getHolding`).
   * @returns {object|null} the ArmUnit, or null
   */
  nDaughter() {
    const d = this._deps;
    if (this.armPilotMode && d && d.cameraSystem) {
      const p = d.cameraSystem.getPilotedArm?.();
      return p && this.nWorksDaughter(p) ? p : null;
    }
    return this.findHoldingDaughter();
  }

  /**
   * Does N work THIS daughter's tool right now? The one answer every "Press N" promise for a daughter reads (the key
   * itself, the tool chips, the in-position and retry lines).
   *   · not piloting: she is the daughter findHoldingDaughter() returns (holding the active target, or the D2 fallback);
   *   · piloting: she is the piloted daughter and is in STATION_KEEP (captureWithPilotedArm's multi-tool branch).
   * @param {object} arm — an ArmUnit
   * @param {object|null} [holdPiece] — "as if she were holding station on this piece"
   * @returns {boolean}
   */
  nWorksDaughter(arm, holdPiece = null) {
    if (!arm) return false;
    const d = this._deps;
    const asIf = holdPiece ? { arm, piece: holdPiece } : null;   // a line said just before she holds station (retry lines)
    if (this.armPilotMode && d && d.cameraSystem) {
      const piloted = d.cameraSystem.getPilotedArm?.();
      return !!piloted && piloted === arm && (arm.state === Constants.ARM_STATES.STATION_KEEP || !!asIf);
    }
    return holdingDaughter(d, asIf) === arm;
  }

  /**
   * A daughter's NET follows the same reach rule as the mother's (owner 2026-11-01: "Yes, same rule"): refuse, spend nothing,
   * when the piece she holds station on is past HER net's reach now, or will be at contact. Her net class is the one
   * `fireDaughterNet` launches (weaver MEDIUM, else SMALL: 80 m by `netMaxReachM`, the number the docking reticle reads); the
   * delay is CAST_WINDUP + SPIN_UP_TIME, the speed LAUNCH_SPEED, the contact radius half her net's DIAMETER; the velocity is
   * the piece's relative to her (`_leadTargetVel`, ~0 in a settled station-keep, so this is a guard for a drifted one: she
   * holds 4-12 m off, STATION_KEEP.MIN/MAX_STANDOFF). Only her net (selectedTool NET, or multi-tool off); the gripper and
   * pad are not judged. The refusal lines are the mother's (§45 texts kept). Missing data (no position, no `config.type`)
   * means fire, as `withinNetReach` does for headless mocks.
   * A PILOTED daughter still flying in (TRANSIT / APPROACH) fires her net with `manualNetDeploy` (aimed at `arm.target`, else the
   * nearest piece, both set by captureWithPilotedArm); that path passes the piece it will use as `aimedPiece`, which is always a
   * net, so the tool check is skipped.
   * @param {object} arm - an ArmUnit in STATION_KEEP, or flying in with `aimedPiece`
   * @param {object|null} [aimedPiece] - the piece a manual net deploy is aimed at (flying-in path only)
   * @returns {boolean} true when refused
   */
  _refuseDaughterNetOutOfReach(arm, aimedPiece = null) {
    const d = this._deps;
    if (!arm || !d) return false;
    const multi = Constants.isFeatureEnabled('DAUGHTER_MULTITOOL') && typeof arm.dispatchSelectedTool === 'function';
    if (!aimedPiece && multi && arm.selectedTool && arm.selectedTool !== 'NET') return false;   // gripper / pad / magnet: not a net
    // No nets left: ArmUnit's own inventory gate (captureFromStationKeep / manualNetDeploy, the same test) speaks its out-of-nets
    // line; the reach line would hide it.
    if (Constants.isFeatureEnabled('CAPTURE_NET') && arm._netInventory <= 0) return false;
    const piece = aimedPiece || arm._stationKeepTarget || arm.target;           // HER piece, not the selected one
    const type = arm.config && arm.config.type;
    const armPos = arm.position;
    const piecePos = piece && piece._scenePosition;
    if (!type || !armPos || !piecePos) return false;
    const CN = Constants.CAPTURE_NET;
    const netClass = type === 'weaver' ? CN.MEDIUM : CN.SMALL;                  // fireDaughterNet's own rule
    const reachM = netMaxReachM(netClass);
    if (!(reachM > 0)) return false;
    const deny = (text, reason) => {
      if (reason) eventBus.emit(Events.LASSO_DENIED, { reason });
      eventBus.emit(Events.COMMS_MESSAGE, { text, source: 'SYSTEM', channel: 'CMD', priority: 'warning' });
      d.audioSystem?.playDeny?.();
      return true;
    };
    const nowM = targetRangeM(armPos, piecePos);
    if (nowM > reachM) return deny(netRangeLine(nowM, reachM, 'net'));
    const rv = arm._leadTargetVelValid && (!aimedPiece || aimedPiece === arm.target) ? arm._leadTargetVel : null;
    // A daughter's net flies on the same ceremony clock as the mother's (CaptureNet.update scales every net's dt), when a
    // ceremony starts for her: the same speed and delay in wall seconds, the unit her piece's drift is measured in.
    const fc = this._netFlightClock(false, netClass.LAUNCH_SPEED, nowM);
    const arriveM = netArrivalRangeM(armPos, armPos, piecePos, rv, fc.speedMps, fc.delayS, (netClass.DIAMETER || 0) / 2);
    if (arriveM > reachM) return deny(driftOutOfReachLine(arriveM), 'drift_out_of_reach');
    return false;
  }

  /**
   * Work a station-keeping daughter's selected tool (multi-tool dispatch when DAUGHTER_MULTITOOL is on, else the
   * plain net); shared by captureWithPilotedArm and the no-pilot-mode KeyN branch.
   * @param {object} arm — an ArmUnit in STATION_KEEP
   * @param {{manual?:boolean}} [opts] — `manual: true` only from the piloted-daughter N (captureWithPilotedArm): the catch then
   *   counts as manual (ARM_CAPTURED `manual:true`, the x2 score, the coach's manual-catch beat). Always assigned, so a no-pilot
   *   N never inherits an earlier piloted press's flag.
   */
  captureWithDaughter(arm, opts = {}) {
    const d = this._deps;
    if (this._refuseDaughterNetOutOfReach(arm)) return;
    arm._manualCapture = opts.manual === true;
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')
        && typeof arm.dispatchSelectedTool === 'function') {
      arm.dispatchSelectedTool();
    } else {
      arm.captureFromStationKeep();
    }
    d?.audioSystem?.playClick();
  }

  // --- Space "do the next thing" rapid-advance ---

  /**
   * Snapshot of live game state for {@link resolveNextDevAction}; degrades gracefully when a subsystem is missing.
   * @returns {import('./DevSequenceAdvancer.js').DevSnapshot}
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
      // NOTE (drift): mirrors main.js's OnboardingDirector contextProvider (getDiscoveredCount(true) + getActiveTarget);
      // if "what counts as a contact" changes there, update both so Space and the onboarding beat gates agree.
      if (d.debrisField && typeof d.debrisField.getDiscoveredCount === 'function') {
        trackedContacts = d.debrisField.getDiscoveredCount(true) || 0;
      }
    } catch (_e) { /* best-effort */ }

    let inCaptureRange = false;
    if (hasTarget) {
      const rangeM = Number.isFinite(Constants.LASSO_RANGE) ? Constants.LASSO_RANGE : Constants.NET_LOCK_RANGE_M;
      const distM = this._activeTargetDistanceM(activeTarget);
      inCaptureRange = Number.isFinite(distM) && distM <= rangeM;
    }

    // Mirrors the deploy gate ArmManager._findDockedArm (DOCKED && springCharged && fuel > 5); a looser check would
    // dispatch DEPLOY while a docked daughter recharges, where deployDaughter() silently no-ops.
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
   * Live distance (metres) from the player to a target debris, or null when it can't be resolved. 1 scene unit = 100 km:
   * scene-units / SCENE_SCALE → km, ×1000 → metres (matches DebrisField's `distanceKm = dist / SCENE_SCALE`).
   * @param {object} target
   * @returns {number|null}
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
    return targetRangeM(p, tgtPos);   // the one shared distance (scene units → metres)
  }

  /**
   * Dispatch the action id chosen by {@link resolveNextDevAction} to the matching helper.
   * @param {string} action — a DEV_ACTIONS id
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
