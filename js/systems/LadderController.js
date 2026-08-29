/**
 * LadderController.js — S2 glue between the pure ZoomLadder core and the game.
 *
 * Owns the headless ZoomLadder core (js/core/ZoomLadder.js), feeds it
 * router-normalized wheel events + a per-frame `update(tMs)` tick, and
 * translates the core's Decision union (docs/ladder/06-core-api.md) into:
 *   - camera moves + crossing/mini rides via the CameraSystem ride engine
 *     (ceremony-BEAT pattern, T6 — able to aim Earth-fixed frames);
 *   - per-floor render-block swaps via SceneManager (T1);
 *   - the rail indicator stub (charge fill / current floor).
 * It calls `ladder.rideFinished({tMs})` when a ride completes.
 *
 * This module is NOT a hub file and touches no THREE/DOM directly — every side
 * effect goes through injected deps whose methods are all optional, so the
 * controller is unit-testable with plain stubs.
 *
 * Activation: the ladder lives entirely INSIDE gameplay states (T4). It engages
 * when `Constants.LADDER.ENABLED` and `gameState.isGameplay()`, and disengages
 * otherwise — restoring the shipped camera. With the flag off it never engages,
 * so shipped behavior is byte-identical.
 *
 * @module systems/LadderController
 */

import { ZoomLadder, distanceFromZ01 } from '../core/ZoomLadder.js';
import { FloorContract } from '../core/FloorContract.js';
import { Constants } from '../core/Constants.js';

/** Crossing-ride duration: midpoint of the locked 450–650 ms window. */
const CROSS_RIDE_MS = 550;

export class LadderController {
  /**
   * @param {object} deps
   * @param {object} [deps.cameraSystem] - ride engine: ladderEngage/ladderDisengage/
   *   ladderSetTarget/ladderStartRide (all optional)
   * @param {object} [deps.sceneManager] - per-floor render block: setLadderFloorFidelity(fid|null)
   * @param {object} [deps.gameState]    - isGameplay() gate
   * @param {object} [deps.rail]         - rail indicator stub: show/hide/refresh(state)/flashDenied(hint)
   * @param {object} [deps.navcom]       - F6 (NAVCOM) content controller (NavcomFloor):
   *   activate/deactivate/isActive/update/planTransfer. Optional — no-op without it.
   * @param {function} [deps.now]        - monotonic clock (ms); defaults to performance.now
   * @param {object} [deps.ladder]       - injectable ZoomLadder (tests); defaults to a fresh core
   */
  constructor(deps = {}) {
    this._cameraSystem = deps.cameraSystem || null;
    this._sceneManager = deps.sceneManager || null;
    this._gameState = deps.gameState || null;
    this._rail = deps.rail || null;
    this._navcom = deps.navcom || null;
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._ladder = deps.ladder || new ZoomLadder();
    this._engaged = false;
  }

  /** The underlying pure core (read-only use — rail/tests). */
  get ladder() { return this._ladder; }

  /** True while the ladder owns input/camera (flag on + gameplay + engaged). */
  isActive() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._gameState && this._gameState.isGameplay && this._gameState.isGameplay() &&
      this._engaged);
  }

  /** Should the ladder be engaged this frame? (flag on + gameplay). */
  _wantEngaged() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._gameState && this._gameState.isGameplay && this._gameState.isGameplay());
  }

  /**
   * Per-frame tick. Handles engage/disengage lifecycle, the core's escalation
   * timers (charge decay, settle-back, alarms), and rail refresh.
   * @param {number} [tMs] - monotonic clock; defaults to now()
   * @returns {Array} decisions applied (for tests)
   */
  update(tMs) {
    const t = (tMs === undefined) ? this._now() : tMs;
    const want = this._wantEngaged();
    if (want && !this._engaged) this._engage(t);
    else if (!want && this._engaged) this._disengage();
    if (!this._engaged) return [];

    const decisions = this._ladder.update(t);
    this._apply(decisions, t);
    // Tick the active floor content (F6 NAVCOM cluster icons + transfer window).
    // NavcomFloor uses its own injected projector; the serial track supplies it.
    if (this._navcom && this._navcom.isActive && this._navcom.isActive() && this._navcom.update) {
      this._navcom.update();
    }
    this._refreshRail();
    return decisions;
  }

  /** Router entry: one router-normalized wheel event. */
  wheel({ tMs, dir, mag }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    const decisions = this._ladder.wheel({ tMs: t, dir, mag });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /** Discrete command passthrough (Esc/PgUp/PgDn/Space) — wired in a later milestone. */
  command({ tMs, type }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    const decisions = this._ladder.command({ tMs: t, type });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /** Hotkey / rail-notch jump passthrough. */
  jump({ tMs, toFloor }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    const decisions = this._ladder.jump({ tMs: t, toFloor });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _engage(tMs) {
    this._engaged = true;
    const s = this._ladder.getState();
    const frame = this._frame(s.floor, s.z01);
    if (this._cameraSystem && this._cameraSystem.ladderEngage) {
      this._cameraSystem.ladderEngage(frame);
    }
    this._applyFidelity(s.floor);
    this._applyFloorContent(s.floor);
    if (this._rail && this._rail.show) this._rail.show();
    this._refreshRail();
  }

  _disengage() {
    this._engaged = false;
    if (this._cameraSystem && this._cameraSystem.ladderDisengage) {
      this._cameraSystem.ladderDisengage();
    }
    // Clearing the fidelity request makes SceneManager.applyTier() byte-identical
    // to the shipped path again (no re-assertion).
    if (this._sceneManager && this._sceneManager.setLadderFloorFidelity) {
      this._sceneManager.setLadderFloorFidelity(null);
    }
    if (this._navcom && this._navcom.deactivate) this._navcom.deactivate();
    if (this._rail && this._rail.hide) this._rail.hide();
  }

  // ── Decision translation ───────────────────────────────────────────────────

  /**
   * @param {Array} decisions
   * @param {number} tMs
   * @private
   */
  _apply(decisions, tMs) {
    for (const d of decisions) {
      switch (d.type) {
        case 'move':
        case 'settle':
          if (this._cameraSystem && this._cameraSystem.ladderSetTarget) {
            this._cameraSystem.ladderSetTarget(this._frame(d.floor, d.z01));
          }
          break;

        case 'cross':
          this._startRide(d.toFloor, d.entryZ01, CROSS_RIDE_MS, tMs);
          break;

        case 'ride':
          this._startRide(d.toFloor, d.entryZ01, d.miniMs != null ? d.miniMs : CROSS_RIDE_MS, tMs);
          break;

        case 'denied':
          if (this._rail && this._rail.flashDenied) this._rail.flashDenied(d.hint || null);
          break;

        case 'verb':
          this._dispatchVerb(d.verb);
          break;

        // charge → rail fill (handled by _refreshRail); reaim → S4+.
        case 'charge':
        case 'reaim':
        case 'alarm':
        default:
          break;
      }
    }
  }

  /**
   * Start a camera ride to (toFloor, entryZ01). The core has already advanced
   * its state to the destination and is `riding` until rideFinished(); we swap
   * the destination floor's render block immediately (T1) and report the ride
   * complete via a completion callback.
   * @private
   */
  _startRide(toFloor, entryZ01, rideMs, tMs) {
    this._applyFidelity(toFloor);
    this._applyFloorContent(toFloor);
    const frame = this._frame(toFloor, entryZ01);
    const done = () => {
      const t = this._now();
      this._ladder.rideFinished({ tMs: t });
      this._refreshRail();
    };
    if (this._cameraSystem && this._cameraSystem.ladderStartRide) {
      this._cameraSystem.ladderStartRide({ ...frame, rideMs, onDone: done });
    } else {
      // No camera (headless without a ride engine): complete synchronously so
      // the core never wedges in `riding`.
      done();
    }
  }

  /** Push a floor's fidelity block to SceneManager (T1). @private */
  _applyFidelity(floor) {
    if (!this._sceneManager || !this._sceneManager.setLadderFloorFidelity) return;
    const f = FloorContract.FLOORS[floor - 1];
    if (!f) return;
    this._sceneManager.setLadderFloorFidelity({
      nearField: f.fidelity.nearField,
      near: f.camera.near,
      far: f.camera.far,
      debrisMode: f.fidelity.debrisMode,
      floor,
    });
  }

  /**
   * Consume the arrival floor's `fidelity.debrisMode` (T1 plumbing) to drive the
   * floor content controllers. F6's 'clusters' mode swaps the full debris meshes
   * for the NAVCOM cluster-icon + transfer-window costume; every other floor
   * deactivates it. No-op without a navcom dep (parallel track — the serial track
   * injects NavcomFloor). @private
   */
  _applyFloorContent(floor) {
    if (!this._navcom) return;
    const f = FloorContract.FLOORS[floor - 1];
    const clusters = !!(f && f.fidelity && f.fidelity.debrisMode === 'clusters');
    if (clusters) {
      if (this._navcom.activate) this._navcom.activate();
    } else if (this._navcom.deactivate) {
      this._navcom.deactivate();
    }
  }

  /**
   * Dispatch a per-floor Space verb decision (FloorContract spaceVerb). Only F6's
   * 'plan-transfer' is wired here (M3); F3/F4/F5/F7 verbs are S4/S5 follow-ups.
   * @private
   */
  _dispatchVerb(verb) {
    if (verb === 'plan-transfer' && this._navcom && this._navcom.planTransfer) {
      this._navcom.planTransfer();
    }
  }

  /**
   * Resolve a (floor, z01) into a camera frame: distance from anchor, FOV,
   * anchor kind. F3's 'subject' anchor maps to 'ship' in M1 (subject re-aim is
   * S4); F6/F7 'earth' anchor lets the ride engine aim Earth-fixed (T6).
   * @private
   */
  _frame(floor, z01) {
    const f = FloorContract.FLOORS[floor - 1];
    const distU = distanceFromZ01(f, z01);
    const anchor = (f.anchor === 'earth') ? 'earth' : 'ship';
    const fov = (f.camera.fov != null) ? f.camera.fov : Constants.CAMERA_FOV;
    return { distU, fov, anchor, floor, z01 };
  }

  /** @private */
  _refreshRail() {
    if (this._rail && this._rail.refresh) this._rail.refresh(this._ladder.getState());
  }
}
