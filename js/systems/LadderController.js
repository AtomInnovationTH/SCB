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
 * It calls `ladder.rideFinished({tMs})` when a ride completes — via a ride
 * SEQUENCE TOKEN, because G3 flick upgrades/reversals/undos replace rides
 * mid-flight: only the LATEST ride's completion may reach the core (a stale
 * rideFinished would clear the replacement ride). flickWall rides (G3) are
 * ordinary 'ride' decisions with kind 'flickWall' and miniMs FLICK_RIDE_MS —
 * same-floor camera flights to a wall edge.
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
import { VisualLaw } from '../core/VisualLaw.js';
import { Constants } from '../core/Constants.js';

/** Crossing-ride duration: midpoint of the locked 450–650 ms window. */
const CROSS_RIDE_MS = 550;

/**
 * G1 (post-M3): runtime-adapt holdoff window after the last ladder input.
 * DERIVED, not a new tunable: RIDE_MAX_MS (650, VisualLaw.TIMINGS) +
 * SETTLE_IDLE_MS (250, FloorContract.HUMP_SPRING) = 900 ms — the longest a
 * single wheel event can still be driving camera motion (a triggered ride)
 * plus the gesture-settle tail. See docs/ladder/01-numbers.md §"Post-M3 glue".
 */
const ADAPT_HOLDOFF_MS =
  VisualLaw.TIMINGS.RIDE_MAX_MS + FloorContract.HUMP_SPRING.SETTLE_IDLE_MS;

export class LadderController {
  /**
   * @param {object} deps
   * @param {object} [deps.cameraSystem] - ride engine: ladderEngage/ladderDisengage/
   *   ladderSetTarget/ladderStartRide (all optional)
   * @param {object} [deps.sceneManager] - per-floor render block: setLadderFloorFidelity(fid|null)
   * @param {object} [deps.gameState]    - isGameplay() gate
   * @param {object} [deps.rail]         - rail indicator: show/hide/refresh(state)/flashDenied(hint, floor)
   * @param {object} [deps.navcom]       - F6 (NAVCOM) content controller (NavcomFloor):
   *   activate/deactivate/isActive/update/planTransfer. Optional — no-op without it.
   * @param {object} [deps.proxNet]      - F5 (PROX NET) content controller (ProxNetFloor):
   *   activate/deactivate/isActive/update/approach. Optional — no-op without it.
   * @param {object} [deps.sdaFloor]     - F7 (SDA) content controller (SdaFloor):
   *   activate/deactivate/isActive/update/flipLens. Optional — no-op without it.
   * @param {object} [deps.hullcam]      - F3 (HULL CAM) content controller (HullCamFloor):
   *   activate/deactivate/isActive/update/lensToggle. Optional — no-op without it.
   * @param {object} [deps.archive]      - F1 (ARCHIVE) content bridge (ArchiveFloor):
   *   activate/deactivate/isActive. Optional — no-op without it. Floor-keyed
   *   like hullcam (F1's debrisMode 'hidden' is shared with F2): arriving on
   *   floor 1 drops into the hosted Tech Library, any other floor closes it.
   * @param {object} [deps.audioBeds]    - per-floor audio beds (LadderAudioBeds):
   *   setFloor(floorId|null). Optional — absent it beds are a no-op.
   * @param {object} [deps.floorMask]    - per-floor HUD pane mask (FloorMask,
   *   08-workbench D8/§4): setFloor(floorId|null). Optional — absent it the
   *   mask is a no-op (shipped cockpit byte-identical).
   * @param {object} [deps.sfx]          - interaction sfx (LadderSfx): onCharge/
   *   onCross/onRide/onUndoWindow/reset. Optional — absent it sfx are a no-op.
   * @param {object} [deps.starfield]    - Starfield: isConstellationsVisible()/
   *   setConstellationsVisible(bool). Optional — F7 hides the constellation figures
   *   under the full-screen SDA chart and restores the player's prior on leave.
   * @param {object} [deps.cityLabels]   - CityLabels: setSuppressed(bool). Optional —
   *   F7 suppresses the city/landmark pills under the SDA chart (they read as
   *   clutter over the altitude bands). Suppression is transient by contract
   *   (CityLabels.setSuppressed never persists), so the player's 5-key
   *   preference owns the resting state on leave/disengage.
   * @param {object} [deps.motherCallouts] - MotherCallouts: setSuppressed(bool). Optional —
   *   F3's single costume (08-workbench §2): BlueprintOverlay + the cyan hull
   *   outline ARE the costume, so the in-world sprite cards are suppressed while
   *   the engaged floor is 3 (transient gate, same contract as cityLabels; the
   *   INSPECT_HULL_OUTLINE signal keeps firing so the outline stays).
   * @param {object} [deps.targetReticle]  - TargetReticle: setVisible(bool). Optional —
   *   suppressed on the ship-is-icon floors (F6/F7), restored on floors <= 5 / disengage.
   * @param {object} [deps.dockingReticle] - DockingReticle: setVisible(bool). Optional —
   *   same F6/F7 suppression; its re-show is owned per-frame by main.js's ARM PILOT
   *   block, which consults reticlesSuppressed().
   * @param {function} [deps.now]        - monotonic clock (ms); defaults to performance.now
   * @param {object} [deps.ladder]       - injectable ZoomLadder (tests); defaults to a fresh core
   */
  constructor(deps = {}) {
    this._cameraSystem = deps.cameraSystem || null;
    this._sceneManager = deps.sceneManager || null;
    this._gameState = deps.gameState || null;
    this._rail = deps.rail || null;
    this._navcom = deps.navcom || null;
    this._proxNet = deps.proxNet || null;
    this._sdaFloor = deps.sdaFloor || null;
    this._hullcam = deps.hullcam || null;
    this._archive = deps.archive || null;
    this._audioBeds = deps.audioBeds || null;
    this._floorMask = deps.floorMask || null;
    this._sfx = deps.sfx || null;
    this._starfield = deps.starfield || null;
    this._cityLabels = deps.cityLabels || null;
    this._motherCallouts = deps.motherCallouts || null;
    this._targetReticle = deps.targetReticle || null;
    this._dockingReticle = deps.dockingReticle || null;
    /** True while the engaged floor (>= 6) suppresses the aiming reticles. */
    this._reticlesHidden = false;
    /** True while F7 suppresses the constellation figures (mirrors _reticlesHidden). */
    this._constellationsHidden = false;
    /** Player's 6-key visibility captured when F7 hid the figures (restored on leave). */
    this._constellationsPrior = null;
    /** True while F7 suppresses the city/landmark pills (mirrors _reticlesHidden). */
    this._cityLabelsHidden = false;
    /** True while F3 suppresses MotherCallouts' sprite cards (mirrors _cityLabelsHidden). */
    this._motherCalloutsHidden = false;
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // The DEFAULT core (the production path — main.js injects no ladder) honors
    // the dev-phase full-access flag: Constants.LADDER.DEV_FULL_ACCESS (ships
    // true until M6 campaign gating) opens the F2 dock gate so every floor is
    // reachable in play-testing (00-spec §9). Injected ladders (tests) keep
    // strict gates unless their own rules say otherwise.
    this._ladder = deps.ladder || new ZoomLadder({
      rules: { devFullAccess: !!(Constants.LADDER && Constants.LADDER.DEV_FULL_ACCESS) },
    });
    this._engaged = false;
    this._lastInputMs = -Infinity; // last wheel/command/jump — adaptHoldoff()
    // G3: monotone ride token. Flick upgrades/reversals/undos REPLACE the
    // core's ride mid-flight (a new ladderStartRide supersedes the old one);
    // the old camera onDone must then never reach ladder.rideFinished — a
    // stale completion would clear the NEW ride (and could wrongly arm the
    // flick-undo window). CameraSystem.ladderStartRide already swaps its
    // params + onDone so the old callback normally never fires; this token
    // makes the controller safe even against a camera (or test stub) that
    // fires a superseded onDone anyway.
    this._rideSeq = 0;
  }

  /** The underlying pure core (read-only use — rail/tests). */
  get ladder() { return this._ladder; }

  /**
   * True while the engaged floor iconizes the ship (F6/F7) and the aiming
   * reticles are suppressed. main.js's per-frame ARM PILOT DockingReticle
   * re-show consults this — allocation-free (gameLoop hot path; no getState()
   * snapshot). Flag-off: never engaged → never set → always false.
   */
  reticlesSuppressed() { return this._reticlesHidden; }

  /**
   * Current ladder floor id (1..7), or null when unavailable. Read-only probe
   * for the iPad zoom-feel telemetry beacon (ui/touchTelemetry.js); never
   * throws and allocates nothing beyond the core's own getState snapshot.
   */
  currentFloor() {
    try {
      return (this._ladder && this._ladder.getState) ? this._ladder.getState().floor : null;
    } catch (_) {
      return null;
    }
  }

  /** G1 pin surface: the derived holdoff window (ms). */
  static get ADAPT_HOLDOFF_MS() { return ADAPT_HOLDOFF_MS; }

  /** True while the ladder owns input/camera (flag on + gameplay + engaged). */
  isActive() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._gameState && this._gameState.isGameplay && this._gameState.isGameplay() &&
      this._engaged);
  }

  /**
   * G1 (post-M3 play-test): should the runtime quality adapt HOLD OFF this
   * frame? True while a ladder ride is in flight or within ADAPT_HOLDOFF_MS
   * (900 ms, derived — see module const) of the last ladder input.
   *
   * WHY: ladder rides + wheel bursts are transient camera flights (FOV/near/far
   * swaps, full-disc Earth fill changes, first-use texture binds). Their frame
   * times do not represent steady state, but they land in the runtimeAdapt fps
   * history — and because that history is CLEARED on every tier change, the
   * next 60-frame check window can be 100% transient frames. On a machine that
   * sits at the tier boundary (play-test log: GPU probe median 7.53 ms vs the
   * 7 ms threshold, HIGH→MEDIUM→HIGH within 40 s of boot) this flip-flops the
   * tier DURING zooming, and every applyTier() is a full composer rebuild +
   * renderer resize — a visible full-screen flash. Holding the adapt loop off
   * while the ladder is actually moving removes the trigger; steady-state
   * adaptation (the shipped behavior) is untouched.
   *
   * Flag-off: never engaged → isActive() false → always false → the shipped
   * adapt path is byte-identical.
   *
   * @param {number} [nowMs] - monotonic clock; defaults to now()
   * @returns {boolean}
   */
  adaptHoldoff(nowMs) {
    if (!this.isActive()) return false;
    // isRiding() is the allocation-free probe — this runs once per gameLoop
    // frame and must not materialize a getState() snapshot (G4 follow-up;
    // guarded for injected ladder stubs that pre-date the accessor).
    if (this._ladder.isRiding ? this._ladder.isRiding()
      : this._ladder.getState().mode === 'riding') return true;
    const t = (nowMs === undefined) ? this._now() : nowMs;
    return (t - this._lastInputMs) < ADAPT_HOLDOFF_MS;
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
    // NOTE: the F6 (NAVCOM) floor content is NOT ticked here — main.js is the
    // SINGLE navcom ticker (it ticks navcom.update({project,shipPos,shipAngleRad})
    // with the live camera projector right after cameraSystem.update, so the icons
    // read this frame's pose and never render twice). This controller only owns
    // the navcom activate/deactivate lifecycle (_applyFloorContent / _disengage).
    //
    // Reticle re-assert (F6/F7): TargetReticle self-SHOWS on any gameplay-entering
    // GAME_STATE_CHANGE (TargetReticle.js:253-256), so a gameplay↔gameplay
    // transition (e.g. ORBITAL_VIEW→APPROACH) mid-F6 would resurrect it between
    // floor changes. This class deliberately has no EventBus dep, so the minimal
    // robust counter is re-asserting the hide from the existing per-frame update —
    // setVisible(false) is a single style assignment (no DOM read, no layout).
    // DockingReticle needs no re-assert: its state-change listener only ever
    // HIDES, and its per-frame owner (main.js ARM PILOT block) consults
    // reticlesSuppressed() and keeps it hidden while suppressed.
    if (this._reticlesHidden && this._targetReticle && this._targetReticle.setVisible) {
      this._targetReticle.setVisible(false);
    }
    this._refreshRail();
    return decisions;
  }

  /** Router entry: one router-normalized wheel event. */
  wheel({ tMs, dir, mag }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
    const decisions = this._ladder.wheel({ tMs: t, dir, mag });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /** Discrete command passthrough (Esc/PgUp/PgDn/Space) — wired in a later milestone. */
  command({ tMs, type }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
    const decisions = this._ladder.command({ tMs: t, type });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /** Hotkey / rail-notch jump passthrough. */
  jump({ tMs, toFloor }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
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
    this._hullCostumeBeforeCamera(s.floor);
    if (this._cameraSystem && this._cameraSystem.ladderEngage) {
      this._cameraSystem.ladderEngage(frame);
    }
    this._hullCostumeAfterCamera(s.floor);
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
    // F3 costume: clear the sprite-card suppression AFTER the camera reverted
    // the inspect effects (its INSPECT_HULL_OUTLINE false already landed), so
    // the shipped Schmitt resumes with the cards free to follow it.
    this._hullCostumeAfterCamera(null);
    // Clearing the fidelity request makes SceneManager.applyTier() byte-identical
    // to the shipped path again (no re-assertion).
    if (this._sceneManager && this._sceneManager.setLadderFloorFidelity) {
      this._sceneManager.setLadderFloorFidelity(null);
    }
    if (this._navcom && this._navcom.deactivate) this._navcom.deactivate();
    if (this._proxNet && this._proxNet.deactivate) this._proxNet.deactivate();
    if (this._sdaFloor && this._sdaFloor.deactivate) this._sdaFloor.deactivate();
    if (this._hullcam && this._hullcam.deactivate) this._hullcam.deactivate();
    if (this._archive && this._archive.deactivate) this._archive.deactivate();
    // Per-floor audio bed: fade to silence on disengage (optional dep).
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(null);
    // Per-floor HUD pane mask: restore the shipped fully-visible cockpit and
    // hide the vitals line on disengage (optional dep — the beds contract).
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(null);
    // Interaction sfx: clear transient gesture state (ratchet step / armed
    // undo window) so a re-engage starts clean (optional dep).
    if (this._sfx && this._sfx.reset) this._sfx.reset();
    // Restore the reticles the icon floors hid (no-op if not suppressed). On a
    // disengage caused by LEAVING gameplay, the restore resolves to hidden —
    // matching TargetReticle's own GAME_STATE_CHANGE rule (see _setReticlesHidden).
    this._setReticlesHidden(false);
    // Restore the constellation figures F7 hid (no-op if not suppressed).
    this._setConstellationsHidden(false);
    // Clear the F7 city/landmark-pill suppression (no-op if not suppressed;
    // the 5-key preference decides whether the pills actually reappear).
    this._setCityLabelsHidden(false);
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
          // 00-spec §4: the clunk derives from cross.direction ('out' ↑ / 'in' ↓).
          if (this._sfx && this._sfx.onCross) this._sfx.onCross(d.direction);
          this._startRide(d.toFloor, d.entryZ01, CROSS_RIDE_MS, tMs, true);
          break;

        case 'ride':
          // G3 flick-to-wall soft tick (LadderSfx only sounds kind 'flickWall').
          if (this._sfx && this._sfx.onRide) this._sfx.onRide(d.kind);
          this._startRide(d.toFloor, d.entryZ01, d.miniMs != null ? d.miniMs : CROSS_RIDE_MS, tMs);
          break;

        case 'denied':
          // G2i: pass the BLOCKED floor too so the rail can flash its notch
          // (hint text comes from FloorContract humps.deniedHint, or null at
          // the ladder ends). Backward-compatible with the S2 stub signature.
          if (this._rail && this._rail.flashDenied) this._rail.flashDenied(d.hint || null, d.floor);
          break;

        case 'verb':
          this._dispatchVerb(d.verb);
          break;

        // charge → rail fill (handled by _refreshRail) + the ratchet ticks
        // (06-core-api: "S2 derives ratchet from charge"). reaim → S4+.
        case 'charge':
          if (this._sfx && this._sfx.onCharge) this._sfx.onCharge(d.charge, d.side);
          break;

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
   * complete via a completion callback. Each start claims a fresh ride token:
   * a superseded ride's onDone (replaced mid-flight by a flick upgrade /
   * reversal / undo) is dropped instead of delivering a STALE rideFinished.
   * @private
   */
  _startRide(toFloor, entryZ01, rideMs, tMs, isCross) {
    this._applyFidelity(toFloor);
    this._applyFloorContent(toFloor);
    const frame = this._frame(toFloor, entryZ01);
    const seq = ++this._rideSeq;
    const done = () => {
      if (seq !== this._rideSeq) return;   // superseded — the new ride owns completion
      const t = this._now();
      this._ladder.rideFinished({ tMs: t });
      // A completed CROSS arms the 800 ms FLICK_UNDO_WINDOW (G3) — the "↶"
      // undo-affordance chime. Superseded rides never arm (the seq guard
      // above): only the LATEST ride's completion counts, matching the core.
      if (isCross && this._sfx && this._sfx.onUndoWindow) this._sfx.onUndoWindow(true);
      this._refreshRail();
    };
    this._hullCostumeBeforeCamera(toFloor);
    if (this._cameraSystem && this._cameraSystem.ladderStartRide) {
      this._cameraSystem.ladderStartRide({ ...frame, rideMs, onDone: done });
    } else {
      // No camera (headless without a ride engine): complete synchronously so
      // the core never wedges in `riding`.
      done();
    }
    this._hullCostumeAfterCamera(toFloor);
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
   * for the NAVCOM cluster-icon + transfer-window costume; F5's 'tactical' mode
   * drives the PROX NET corridor costume; F7's 'massBands' mode drives the SDA
   * chart (and hides the constellation figures under it); F3 (HULL CAM) keys on
   * the floor ID — its debrisMode 'full' is shared with F4 and cannot
   * discriminate. Every other floor deactivates each. Also gates the aiming
   * reticles on the icon floors (>= 6). Every content dep is optional (parallel
   * track — the serial track injects the floors + the reticles); absent deps
   * make each part a no-op. @private
   */
  _applyFloorContent(floor) {
    // Reticle gating (F6/F7 'ship-to-icon' floors): the target + docking
    // reticles aim at subjects that are icons at Earth-anchored ranges, so both
    // hide while the engaged floor is >= 6 and restore on floors <= 5 (and on
    // disengage) — mirroring the navcom activate/deactivate pattern below.
    // Keyed on the floor number, not debrisMode: F7 ('massBands') must suppress
    // too. Independent of the content deps so the reticle deps work standalone.
    this._setReticlesHidden(floor >= 6);
    const f = FloorContract.FLOORS[floor - 1];
    if (this._navcom) {
      const clusters = !!(f && f.fidelity && f.fidelity.debrisMode === 'clusters');
      if (clusters) {
        if (this._navcom.activate) this._navcom.activate();
      } else if (this._navcom.deactivate) {
        this._navcom.deactivate();
      }
    }
    // F5 (PROX NET): the arrival floor's debrisMode 'tactical' drives the
    // ProxNetFloor costume — same activate/deactivate pattern as navcom.
    if (this._proxNet) {
      const tactical = !!(f && f.fidelity && f.fidelity.debrisMode === 'tactical');
      if (tactical) {
        if (this._proxNet.activate) this._proxNet.activate();
      } else if (this._proxNet.deactivate) {
        this._proxNet.deactivate();
      }
    }
    // F7 (SDA): 'massBands' drives the full-screen chart; the constellation
    // figures hide under it (screen-space chart — the star figures would read
    // as chart strokes) and restore on any other floor / disengage. The Earth
    // city/landmark pills hide with them (dozens of DOM pills over a chart-
    // scale Earth read as clutter over the altitude bands).
    const massBands = !!(f && f.fidelity && f.fidelity.debrisMode === 'massBands');
    if (this._sdaFloor) {
      if (massBands) {
        if (this._sdaFloor.activate) this._sdaFloor.activate();
      } else if (this._sdaFloor.deactivate) {
        this._sdaFloor.deactivate();
      }
    }
    this._setConstellationsHidden(massBands);
    this._setCityLabelsHidden(massBands);
    // F3 (HULL CAM): keyed on FLOOR ID 3 — NOT fidelity.debrisMode, which is
    // 'full' on BOTH F3 and F4 and cannot discriminate.
    if (this._hullcam) {
      if (floor === 3) { if (this._hullcam.activate) this._hullcam.activate(); }
      else if (this._hullcam.deactivate) this._hullcam.deactivate();
    }
    // F1 (ARCHIVE): keyed on FLOOR ID 1 — its debrisMode 'hidden' is shared
    // with F2 (DEPOT). Arrival hosts + opens the Tech Library (the codex IS
    // the floor costume, 00-spec §3); leaving / disengaging closes it.
    if (this._archive) {
      if (floor === 1) { if (this._archive.activate) this._archive.activate(); }
      else if (this._archive.deactivate) this._archive.deactivate();
    }
    // Per-floor audio bed (FloorContract audioBed): crossfade to the arrival
    // floor's bed. Optional dep — absent it this is a no-op (parallel track).
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(floor);
    // Per-floor HUD pane mask (08-workbench D8/§4 map rule): apply the arrival
    // floor's room LAST, after every floor system above has landed, so the
    // destination panes fade in with the ride (this method runs on _engage and
    // at every _startRide start). Optional dep — absent it this is a no-op.
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(floor);
  }

  /**
   * Hide/restore the aiming reticles for the ship-is-icon floors (F6/F7).
   * Idempotent (guarded on the flag flip). Both deps optional — absent deps
   * make this a pure flag write, byte-identical to the pre-reticle controller.
   *
   * Hide: setVisible(false) on both.
   * Restore: TargetReticle mirrors its own GAME_STATE_CHANGE rule — visible
   * exactly when gameplay (TargetReticle.js:253-256) — so a mid-gameplay floor
   * change restores it and a disengage-by-leaving-gameplay keeps it hidden.
   * DockingReticle is deliberately NOT force-shown: the main.js ARM PILOT
   * block owns it PER FRAME (setVisible every frame) and re-shows it the
   * moment reticlesSuppressed() clears — forcing it visible here could flash
   * it for a frame outside ARM_PILOT mode.
   * @private
   */
  _setReticlesHidden(hidden) {
    if (hidden === this._reticlesHidden) return;
    this._reticlesHidden = hidden;
    if (hidden) {
      if (this._targetReticle && this._targetReticle.setVisible) this._targetReticle.setVisible(false);
      if (this._dockingReticle && this._dockingReticle.setVisible) this._dockingReticle.setVisible(false);
    } else if (this._targetReticle && this._targetReticle.setVisible) {
      const gameplay = !!(this._gameState && this._gameState.isGameplay && this._gameState.isGameplay());
      this._targetReticle.setVisible(gameplay);
    }
  }

  /**
   * Hide/restore the constellation figures for the F7 SDA chart — a mirror of
   * _setReticlesHidden. Idempotent (guarded on the flag flip); the starfield dep
   * is optional — absent it this is a pure flag write, byte-identical to the
   * pre-SDA controller.
   *
   * Hide: capture the player's current 6-key visibility ONCE into
   * _constellationsPrior, then setConstellationsVisible(false).
   * Restore: put back the captured prior and null it — the player's 6-key
   * toggle owns the resting state, so F7 never force-shows figures the player
   * had off (and never strands them hidden after leaving F7 / disengaging).
   * @private
   */
  _setConstellationsHidden(hidden) {
    if (hidden === this._constellationsHidden) return;
    this._constellationsHidden = hidden;
    if (!this._starfield) return;
    if (hidden) {
      this._constellationsPrior = this._starfield.isConstellationsVisible
        ? this._starfield.isConstellationsVisible() : null;
      if (this._starfield.setConstellationsVisible) {
        this._starfield.setConstellationsVisible(false);
      }
    } else {
      if (this._constellationsPrior != null && this._starfield.setConstellationsVisible) {
        this._starfield.setConstellationsVisible(this._constellationsPrior);
      }
      this._constellationsPrior = null;
    }
  }

  /**
   * Suppress/clear the Earth city + landmark pills for the F7 SDA chart — a
   * mirror of _setReticlesHidden. Idempotent (guarded on the flag flip); the
   * cityLabels dep is optional — absent it this is a pure flag write.
   *
   * Simpler than the constellation pair by design: no prior capture is needed
   * because CityLabels.setSuppressed is a TRANSIENT gate orthogonal to the
   * persisted 5-key preference (`visible && !suppressed` shows a layer, and
   * suppression never writes localStorage). Clearing it therefore restores
   * exactly the player's own resting state — never a force-show, never a
   * clobbered preference. setVisible() would persist and is deliberately NOT
   * used here.
   * @private
   */
  _setCityLabelsHidden(hidden) {
    if (hidden === this._cityLabelsHidden) return;
    this._cityLabelsHidden = hidden;
    if (this._cityLabels && this._cityLabels.setSuppressed) {
      this._cityLabels.setSuppressed(hidden);
    }
  }

  /**
   * F3 single costume (docs/ladder/08-workbench.md §2 "F3 costume"): while the
   * engaged floor is 3, BlueprintOverlay's DOM cards + the cyan hull outline
   * ARE the costume, so MotherCallouts' in-world sprite cards are suppressed
   * (a transient gate with the cityLabels contract — the inspection signals
   * keep owning the resting state; the shipped Schmitt path never calls it).
   *
   * ORDER IS SEMANTIC. The camera's F3 arrival effect is the very signal that
   * activates the cards (INSPECT_HULL_OUTLINE {visible:true}, which must keep
   * firing — the outline is part of the costume), so the suppression must be
   * set BEFORE the camera applies F3's arrival effects and cleared AFTER it
   * applies the departure inverses; otherwise the cards flash active for one
   * synchronous call (pointer attach/detach, CALLOUT_BAND_CHANGE churn, the
   * guided-tour one-shot burned). Hence a before/after pair around every
   * camera call in _engage / _startRide, and after-only in _disengage.
   * Idempotent; the dep is optional (absent → pure flag write).
   * @private
   */
  _hullCostumeBeforeCamera(floor) {
    if (floor === 3) this._setMotherCalloutsHidden(true);
  }

  /** @private See _hullCostumeBeforeCamera. `null` (disengage) clears. */
  _hullCostumeAfterCamera(floor) {
    if (floor !== 3) this._setMotherCalloutsHidden(false);
  }

  /** @private Idempotent flag flip → MotherCallouts.setSuppressed (optional dep). */
  _setMotherCalloutsHidden(hidden) {
    if (hidden === this._motherCalloutsHidden) return;
    this._motherCalloutsHidden = hidden;
    if (this._motherCallouts && this._motherCallouts.setSuppressed) {
      this._motherCallouts.setSuppressed(hidden);
    }
  }

  /**
   * Dispatch a per-floor Space verb decision (FloorContract spaceVerb). Wired:
   * F6 'plan-transfer' (M3), F5 'approach', F7 'flip-lens', F3 'lens-toggle'
   * (S4 serial wiring). F4's 'approach-autopilot' remains a follow-up.
   * @private
   */
  _dispatchVerb(verb) {
    if (verb === 'plan-transfer' && this._navcom && this._navcom.planTransfer) {
      this._navcom.planTransfer();
    }
    // F5 Space verb (FloorContract.FLOORS[4].spaceVerb): commit the selected
    // insertion point — ProxNetFloor.approach() → onApproach → autopilot.
    if (verb === 'approach' && this._proxNet && this._proxNet.approach) {
      this._proxNet.approach();
    }
    // F7 Space verb: flip the SDA chart lens (VALUE ↔ THREAT).
    if (verb === 'flip-lens' && this._sdaFloor && this._sdaFloor.flipLens) {
      this._sdaFloor.flipLens();
    }
    // F3 Space verb: cycle the HULL CAM lens (overview → per-subsystem detail).
    if (verb === 'lens-toggle' && this._hullcam && this._hullcam.lensToggle) {
      this._hullcam.lensToggle();
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
