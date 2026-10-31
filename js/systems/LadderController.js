/**
 * LadderController.js — glue between the pure ZoomLadder core (js/core/ZoomLadder.js) and the game.
 *
 * Feeds the core router-normalized wheel events + a per-frame `update(tMs)`, and translates its Decision union
 * (archive/ladder/06-core-api.md) into:
 *   - camera moves + crossing/mini rides (CameraSystem ride engine);
 *   - per-floor render-block swaps (SceneManager);
 *   - the rail indicator.
 * `ladder.rideFinished({tMs})` is called when a ride completes, via a ride SEQUENCE TOKEN: flick upgrades, reversals
 * and undos replace rides mid-flight, and only the LATEST ride's completion may reach the core (a stale rideFinished
 * would clear the replacement ride). flickWall rides are ordinary 'ride' decisions with kind 'flickWall' and miniMs
 * FLICK_RIDE_MS (same-floor flights to a wall edge).
 *
 * Not a hub file; touches no THREE/DOM directly — every side effect goes through injected deps whose methods are all
 * optional, so it is unit-testable with plain stubs.
 *
 * The ladder is FIVE floors, ids 1..5: 1 HULL CAM (the workbench: the ONE SPECS pane with its REFIT block), 2 COMMAND
 * (the shipped flying view), 3 PROX NET, 4 NAVCOM, 5 SDA DOWNLINK. The SHOP GameState arrives through
 * GameFlowManager's own transitions (mission boundaries, the B key), never through a ladder ride.
 * The controller sees ONE duck-typed `workbench` dep (setEnabled / setFloor / open / close / toggle / isOpen); it
 * never imports js/ui/WorkbenchPane.js.
 *
 * Activation: the ladder lives entirely INSIDE gameplay states. It engages when `Constants.LADDER.ENABLED` and
 * `gameState.isGameplay()`, and disengages otherwise (restoring the shipped camera). Flag off: never engages, so
 * shipped behavior is byte-identical.
 *
 * @module systems/LadderController
 */

import { ZoomLadder, distanceFromZ01, z01FromDistance } from '../core/ZoomLadder.js';
import { FloorContract } from '../core/FloorContract.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { Constants } from '../core/Constants.js';
import { prefersReducedMotion } from '../ui/hudPulse.js';
import { cubicInOut } from './CameraSystem.js';
import { clamp01 } from '../core/MathUtil.js';

/** Crossing-ride duration: midpoint of the locked 450–650 ms window. */
const CROSS_RIDE_MS = 550;
/**
 * After a ride lands on floor 4, wheel events that follow the previous wheel event by less than this are the tail of the
 * gesture that started the ride (a trackpad's momentum): ignored entirely, see `wheel()` (owner 2026-10-31).
 */
export const RIDE_TAIL_SWALLOW_MS = 200;

/** The fastest the camera may fly out from a daughter's limit when the follow ends, metres per second (peak). */
const DZ_RETURN_PEAK_MPS = 20;

/**
 * The INTRO RIDE's duration: one continuous descent from the TOP floor to the workbench at the first engage of a New
 * Game entered from the menu. Longer than a crossing (550) because it spans the whole ladder and is watched, not
 * commanded; short enough that the first beat is on screen within three seconds of START.
 */
export const INTRO_RIDE_MS = 2400;

/** Intro FLYBY follow-ups: the breath at the hull after the dive lands, and the silent pull-back up to INTRO_LANDING_FLOOR. */
export const INTRO_DWELL_MS = 800;
export const INTRO_PULLBACK_MS = 800;

/**
 * Opening-dance flyby camera figures, passed by the hub to `armIntroRide`. They are CAMERA numbers (the dance owns
 * WHEN, the ladder owns WHERE), quoted against the 7 m F1/F2 boundary.
 *
 * Landing z01 0.23 → 2.67 m on F1; drift end 0.82 → 5.59 m; both strictly inside the free zone (0.15–0.85) so the
 * settle-back rule never yanks them to a wall edge. The dolly is 2.0 s (DECISIONS §15 row 4): it must END before the
 * dance's hand-over (8.70 s), which pulls the camera back. Measured: the dive engages ~1.0 s after the cut and lands
 * near dance t 6.1, so a 2.0 s drift ends ~8.1 (0.6 s margin). test-StartPose pins the budget.
 */
export const INTRO_DANCE_LANDING_Z01 = 0.23;
export const INTRO_DANCE_DRIFT_Z01 = 0.82;
export const INTRO_DANCE_DOLLY_MS = 2000;
/** Measured engage lag of the intro dive after the cut, ms — the dolly budget's input. */
export const INTRO_DANCE_ENGAGE_LAG_MS = 1000;
/**
 * Where the pull-back leaves the camera when the player takes the wheel: z01 0.17 on F2 = **11 m** (owner 2026-09-21:
 * "closer", asked for 10 m). Not 10 m: F2 runs 7–100 m, so 10 m is z01 0.134, INSIDE the lower wall zone
 * (`WALL_ZONE_FRAC` 0.15); settle-back (`ZoomLadder._tick`) would snap an idle wall-zone position to the wall edge after
 * `SETTLE_IDLE_MS` (250 ms), a visible creep to 10.43 m. 10.431 m is the hard floor; 11 m clears it by z01 0.02 (10.5 m
 * by 0.0025, float dust). Measured: `distanceFromZ01(F2, 0.17)`.
 * Default (non-dance) intro rides keep the contract's ENTRY_Z01_FROM_BELOW 0.25 → 13.61 m.
 */
export const INTRO_DANCE_HANDOVER_Z01 = 0.17;
/**
 * The dance's final PULL-BACK duration: the flyby's `INTRO_PULLBACK_MS` (800) slowed 50% (owner 2026-09-21: "too fast").
 * Separate constant because INTRO_PULLBACK_MS is shared with the ordinary intro fly-in and must stay as shipped.
 */
export const INTRO_DANCE_PULLBACK_MS = 1200;
/**
 * The dwell CEILING, never the exact duration: the dance's hand-over (wing 2 seated, 8700 ms, DECISIONS §15 row 4) plus
 * a 2 s drift margin. The dwell really ends on OPENING_DANCE_HANDOVER (`endIntroDwellEarly`); the ceiling only fires
 * the pull-back if that event is dropped, so the camera never squats at the hull forever.
 */
export const INTRO_DANCE_DWELL_CEILING_MS = 10700;

/** The WORKBENCH floor id (where the REFIT block lives; the shell's `setFloor` keys on it). An id, never a name. */
const WORKBENCH_FLOOR = 1;

/**
 * Where the intro ride LANDS: the flying floor, not the workbench (owner 2026-09-07: "First make me care"). The workbench
 * waits until the first mission break rides the player down (WORKBENCH_STOP opens the pane). An id, never a name.
 */
const INTRO_LANDING_FLOOR = 2;

/**
 * Is `z01` a FREE-zone rest, strictly between the wall edges (`WALL_ZONE_FRAC` … 1 − `WALL_ZONE_FRAC`)? The last such
 * position per applied floor is the player's WORKING position (`_restZ01`); wall edges (flick-to-wall landing,
 * settle-back) and band creep are the GESTURE of leaving a floor (archive/ladder/02-traps.md T6: re-entering must not
 * resume inside the wall band). Nothing reads it now; kept for the intro-ride landing.
 */
function isFreeRest(z01) {
  const w = FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC;
  return typeof z01 === 'number' && Number.isFinite(z01) && z01 > w && z01 < 1 - w;
}

/**
 * Runtime-adapt holdoff after the last ladder input. DERIVED: RIDE_MAX_MS (650, VisualLaw.TIMINGS) + SETTLE_IDLE_MS
 * (250, FloorContract.HUMP_SPRING) = 900 ms, the longest a wheel event can still drive camera motion plus the settle
 * tail. See docs/ladder/01-numbers.md §"Post-M3 glue".
 */
const ADAPT_HOLDOFF_MS =
  VisualLaw.TIMINGS.RIDE_MAX_MS + FloorContract.HUMP_SPRING.SETTLE_IDLE_MS;

/**
 * Floor-4 framing glide length, ms (owner 2026-10-20: "Floor 4 easier to read"): the same 1 s as the camera's turn
 * (EarthTurn.EARTH_TURN_S; test-F4Readable pins the two equal), so spin and zoom start and end together.
 */
export const FRAME_GLIDE_MS = 1000;

function glideEase(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Held-arrow orbit rate in pointer-equivalent px/s, so the camera's one drag feel applies (CameraSystem drag.rotateSpeed
 * 0.005 rad/px → 240 px/s ≈ 1.2 rad/s ≈ 69°/s yaw, dt-scaled so frame-rate independent). Tuned at a picture gate.
 */
const ARROW_TURN_PX_PER_S = 240;

export class LadderController {
  /**
   * Every dep is optional and duck-typed (absent = no-op).
   * @param {object} deps
   * @param {object} [deps.cameraSystem] - ride engine: ladderEngage/ladderDisengage/ladderSetTarget/ladderStartRide
   * @param {object} [deps.sceneManager] - per-floor render block: setLadderFloorFidelity(fid|null)
   * @param {object} [deps.gameState]    - isGameplay() gate
   * @param {object} [deps.rail]         - rail indicator: show/hide/refresh(state)/flashDenied(hint, floor)
   * @param {object} [deps.navcom]       - F4 content controller (NavcomFloor): activate/deactivate/isActive/update/planTransfer
   * @param {object} [deps.proxNet]      - F3 (ProxNetFloor): activate/deactivate/isActive/update/approach
   * @param {object} [deps.sdaFloor]     - F5 (SdaFloor): activate/deactivate/isActive/update/flipLens
   * @param {object} [deps.hullcam]      - F1 (HullCamFloor): activate/deactivate/isActive/update/lensToggle
   * @param {object} [deps.workbench]    - the ONE workbench pane (WorkbenchPane: SPECS + the F1 REFIT block):
   *   setEnabled/setFloor/open/close/toggle/isOpen. Enabled on EVERY floor while engaged: each floor apply
   *   (`_applyFloorContent`) calls setEnabled(true) THEN setFloor(floor), before any open, so the shell shows REFIT on
   *   floor 1 only. An open pane stays open across a ride; only disengage disables it (setEnabled(false) closes it).
   *   It claims the F1 'lens-toggle' Space verb (toggle()); absent, the verb falls through to the hullcam branch. Esc
   *   reaches it through closeTopPane(). It also pages from the horizontal two-finger swipe: WheelRouter asks
   *   `wantsPaneSwipe()` and emits ONE `pagePane({toward})` per flick; the carousel is TWO-POSITION on every floor:
   *   [view] — [SPECS] ('left' opens, 'right' closes; the drawer is left on every floor, DECISIONS §13 row 5; gestures
   *   follow it, row 6).
   * @param {function} [deps.onSubjectChange] - called with the floor id after every floor ARRIVAL (_applyFloorContent)
   *   and after a subject-changing Space verb (SDA lens flip, NAVCOM plan) so the hub can retarget an OPEN SPECS pane
   *   through its ONE `openEntry` path (SpecsSubject resolves what).
   * @param {object} [deps.autopilot]    - AutopilotSystem: toggle(); floor 2's 'approach-autopilot' Space verb is the `A` path
   * @param {object} [deps.detailSlider] - js/ui/DetailSlider.js: `setShown(on)`. Shown on every floor but the workbench,
   *   hidden at disengage. Its edge-chrome phase is the hub's per-frame write, not the controller's.
   * @param {object} [deps.edgeChrome]   - EDGE-CHROME core (js/ui/EdgeChrome.js, pure timestamps: wake(member?)/box(name)/
   *   sleep()). The controller wakes it for FLOOR events: every floor apply wakes all chrome and boxes the arrival notch
   *   ('floor'); a ride start wakes the rail; rails-shy (`setRailsShy(true)`) puts chrome to SLEEP instead of hiding the
   *   WHERE rail (asleep is wakeable: an edge touch is the way back on glass); un-shy wakes it. The SPECS tab + stamp are
   *   `setHudClear`, not this. Absent → the hide()/show() path.
   * @param {object} [deps.audioBeds]    - LadderAudioBeds: setFloor(floorId|null)
   * @param {object} [deps.floorMask]    - FloorMask (08-workbench D8/§4): setFloor(floorId|null). With a `viewStore`, its D5
   *   memory is imported at construction and exported on every floor change.
   * @param {object} [deps.viewStore]    - the PLAYER-owned LadderViewStore (D5 persistence): rooms()/setRooms() round-trip
   *   FloorMask's exportMemory/importMemory; panes()/setPanes() hold the workbench pane open-state, written on the pane's
   *   open/close edge (main.js's ONE `_syncWorkbenchPanes` calls `notePaneChange()`) while engaged, and re-applied at
   *   ENGAGE. Absent: rooms stay in-memory and the pane closes. main.js constructs it only inside the LADDER.ENABLED gate.
   * @param {object} [deps.sfx]          - LadderSfx: onCharge/onCross/onRide/onUndoWindow/reset
   * @param {object} [deps.starfield]    - Starfield: isConstellationsVisible()/setConstellationsVisible(bool). F5 hides the
   *   constellation figures under the SDA chart and restores the player's prior on leave.
   * @param {object} [deps.cityLabels]   - CityLabels: setSuppressed(bool). F5 suppresses the pills under the SDA chart; F1
   *   suppresses them at the hull (map rule, D8: city names never among house numbers). Transient by contract (never
   *   persists), so the player's 5-key preference owns the resting state on leave/disengage.
   * @param {object} [deps.targetReticle]  - TargetReticle: setVisible(bool). Suppressed on F4/F5, restored on floors <= 3 / disengage.
   * @param {object} [deps.dockingReticle] - DockingReticle: setVisible(bool). Same suppression; its re-show is owned per-frame
   *   by main.js's ARM PILOT block, which consults reticlesSuppressed().
   * @param {function} [deps.now]        - monotonic clock (ms); defaults to performance.now
   * @param {object} [deps.inputKeys]    - InputManager's PUBLIC `keys` map (turntable: held arrows → camera drag nudge, see turntableActive)
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
    this._workbench = deps.workbench || null;
    this._onSubjectChange = (typeof deps.onSubjectChange === 'function') ? deps.onSubjectChange : null;
    this._autopilot = deps.autopilot || null;
    this._detailSlider = deps.detailSlider || null;
    this._edgeChrome = deps.edgeChrome || null;
    /** Optional `{ hide(), show() }` hook the hub binds to `body[data-pure-scenery]` (index.html hides the SPECS tab and
     * #build-stamp under it). Owned exclusively by `setHudClear`: density flips, never rails. */
    this._pureScenery = deps.pureScenery || null;
    this._audioBeds = deps.audioBeds || null;
    this._floorMask = deps.floorMask || null;
    this._viewStore = deps.viewStore || null;
    this._sfx = deps.sfx || null;
    this._starfield = deps.starfield || null;
    this._cityLabels = deps.cityLabels || null;
    this._targetReticle = deps.targetReticle || null;
    this._dockingReticle = deps.dockingReticle || null;
    // The PUBLIC key-state map (inputManager.keys; InputManager is never edited). While the turntable is live, held arrows
    // are read each update and mapped to CameraSystem.ladderDragNudge: the camera orbits the ship, never the ship itself
    // (main.js blanks the arrows around processInput for that window). Absent ⇒ no turntable arrows (pointer drag still works).
    this._inputKeys = deps.inputKeys || null;
    /** Last update clock for the arrow-nudge dt (ms; null until first update). */
    this._turnPrevMs = null;
    /** True while the engaged floor (>= 4) suppresses the aiming reticles. */
    this._reticlesHidden = false;
    /** True while F5 suppresses the constellation figures (mirrors _reticlesHidden). */
    this._constellationsHidden = false;
    /** Player's 6-key visibility captured when F5 hid the figures (restored on leave). */
    this._constellationsPrior = null;
    /** True while F5 or F1 suppresses the city/landmark pills (mirrors _reticlesHidden). */
    this._cityLabelsHidden = false;
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // The default core forwards Constants.LADDER.DEV_FULL_ACCESS (00-spec §9). INERT since the F2 dock gate it bypassed
    // left, but the wire keeps its pinned shape.
    this._ladder = deps.ladder || new ZoomLadder({
      rules: { devFullAccess: !!(Constants.LADDER && Constants.LADDER.DEV_FULL_ACCESS) },
    });
    // Owner 2026-10-27: a zoom in on floor 2 never swings to the mother's close-up while the camera rides a daughter
    // (the extra zoom below is the daughter limit's own). Asked only by a wheel/flick crossing. Set after the core is
    // built so the pinned `rules: {...}` line above (test-LadderController) stays as it is; injected cores get it too.
    if (typeof this._ladder.setCrossBlock === 'function') {
      this._ladder.setCrossBlock((from, dest) => from === FloorContract.DAUGHTER_ZOOM.FLOOR && dest === from - 1 && this._daughterFollowed());
    }
    /** Reduced-motion probe for the follow-end ease (a cut under it). Injectable for tests. */
    this._reducedMotion = (typeof deps.reducedMotion === 'function') ? deps.reducedMotion : prefersReducedMotion;
    /**
     * Daughter zoom (owner 2026-10-27, FloorContract.DAUGHTER_ZOOM): while the camera rides a daughter on floor 2 the zoom
     * continues past the free zone in the SAME log steps down to her limit, without leaving floor 2. `z` = that extended
     * position in floor-2 z01 units (below the wall zone's edge, may be negative; null = not deep); the core's own z01 stays
     * put. `ease` = {from, to, t0, ms} while the camera comes back after the follow ended.
     */
    this._dz = { z: null, ease: null };
    /** True while the small near plane (FloorContract.DAUGHTER_ZOOM.NEAR_FLOOR's) is pushed to the scene for the deep zoom. */
    this._dzNearSmall = false;
    this._engaged = false;
    this._lastInputMs = -Infinity; // last wheel/command/jump — adaptHoldoff()
    // Monotone ride token: a new ladderStartRide supersedes the core's ride mid-flight, so a stale onDone must never reach
    // ladder.rideFinished (it would clear the NEW ride and could wrongly arm the flick-undo window). CameraSystem already
    // swaps onDone; the token also covers a camera/stub that fires a superseded one.
    this._rideSeq = 0;
    /** Time of the last wheel event wheel() saw (ms, the events' own clock): the tail filter's gap. */
    this._lastWheelMs = -Infinity;
    /** True from a camera ride's landing on floor 4 until the first wheel event after a quiet gap (RIDE_TAIL_SWALLOW_MS). */
    this._rideTailArmed = false;
    /** The floor whose content is on screen (set by _applyFloorContent at engage and every ride START): the ORIGIN of the next ride. */
    this._floorApplied = null;
    /**
     * The armed intro ride's duration (ms): set by armIntroRide() before the first engage of a New Game entered from the
     * menu, consumed by _engage(), cleared by disarmIntroRide() (a CONTINUE restores a saved view instead).
     */
    this._introPending = null;
    /**
     * Armed by resetView() (GAME_RESET), disarmed by restoreView() (PERSISTENCE_LOADED = a continue), spent by the next
     * _engage(): the mask first drops the reveals of default-hidden panes on every floor. Its own field: _disengage clears
     * _introPending, and a new game must forget even without an intro ride.
     */
    this._forgetRevealsPending = false;
    /**
     * RAILS SHY (owner 2026-09-07): true after a `-` press found the density rungs already clear and bowed the RAILS out
     * too. Transient view state (never persisted, not a room edit); any `+`, ride or fresh engage drops it (setRailsShy).
     */
    this._railsShy = false;
    /** True while `setHudClear(true)` has hidden the SPECS tab + build stamp. Engaged-only; engage, disengage, ride or floor apply reset it. */
    this._hudClear = false;
    /** The intro FLYBY phase: null | 'dive' | 'dwell' | 'pull'. Set by _engage when it flies an armed dive; advanced by
     * _introTick; cleared by landing, player input after the dive started, or disengage. */
    this._introPhase = null;
    this._introDwellUntil = null;
    this._introDiveStartMs = null;
    /**
     * The armed flyby's dance options: the dive's entryZ01 override (null → geometry default), the dwell CEILING
     * (INTRO_DWELL_MS when unarmed), the dolly `{ toZ01, rideMs }` fired once at the dwell's start, and the early-end latch
     * set by endIntroDwellEarly() (a skip's hand-over can arrive while the dive is still flying). Cleared on
     * disarm/disengage; rewritten by every armIntroRide.
     */
    this._introEntryZ01 = null;
    this._introHandoverZ01 = null;
    this._introPullbackMs = INTRO_PULLBACK_MS;
    this._introDwellMs = INTRO_DWELL_MS;
    this._introDolly = null;
    this._introDwellEarly = false;
    /**
     * The last FREE-zone rest z01 on the applied floor: the player's working position (see `isFreeRest`). Seeded at engage
     * and every floor ARRIVAL from the entry z01, advanced by every free `move`, untouched by flick-to-wall landings,
     * settles and creep. No current reader; kept for the intro-ride landing.
     */
    this._restZ01 = null;
    /**
     * The working position as it stood BEFORE the current wheel drive (a same-direction run of free moves with gaps <
     * GESTURE_LOCK_SILENCE_MS, the core's gesture boundary). A flick's driven phase emits a few free `move`s before the
     * detector fires; they belong to the LEAVING gesture, so when the drive ends in a flick-to-wall ride `_restZ01` rolls back
     * to this (0.75 → ramp 0.68 → flick → the return lands at 0.75). `_lastMoveT` / `_lastMoveDir` delimit the drive.
     */
    this._restBeforeDrive = null;
    this._lastMoveT = -Infinity;
    this._lastMoveDir = 0;
    /**
     * The core's z01 as last seen (every move incl. wall creep, settle, ride landing, engage/arrival seed): the PREVIOUS
     * POSITION a free move's direction is measured against. Never the rest: after a rollback that is the pre-gesture value
     * and mis-signs the first move of the next opposite drive.
     */
    this._lastPosZ01 = null;
    /** True while `_restorePanes` drives the pane itself (its edge is not player intent). */
    this._paneRestoring = false;
    /** The running floor-4 framing glide `{ floor, fromZ01, toZ01, t0, ms, cancels0 }` or null; ended by wheel/pinch, a ride,
     * a floor change or a camera drag (CameraSystem.ladderEarthFrameCancels moved). */
    this._glide = null;
    /**
     * The shipped initial view, captured at construction: `resetView()` (GAME_RESET) places the core back here so a NEW run
     * starts on the shipped floor whatever floor the last run ended on. Rooms (FloorMask memory / view store) survive a
     * reset except the reveals of default-hidden panes: a NEW game forgets those at its first engage
     * (`_forgetRevealsPending`), a continue keeps the room exactly.
     */
    const s0 = (this._ladder && this._ladder.getState) ? this._ladder.getState() : null;
    this._initialView = s0 ? { floor: s0.floor, z01: s0.z01 } : null;
    // The player's rooms ride in from the store ONCE, before the first setFloor (FloorMask.importMemory validates its half).
    if (this._viewStore && this._floorMask && typeof this._floorMask.importMemory === 'function' &&
        typeof this._viewStore.rooms === 'function') {
      const rooms = this._viewStore.rooms();
      if (rooms) this._floorMask.importMemory(rooms);
    }
  }

  /** The underlying pure core (read-only use — rail/tests). */
  get ladder() { return this._ladder; }

  /**
   * True while the engaged floor iconizes the ship (F4/F5) and the aiming reticles are suppressed. main.js's per-frame
   * ARM PILOT DockingReticle re-show consults it — allocation-free (hot path; no getState() snapshot).
   */
  reticlesSuppressed() { return this._reticlesHidden; }

  /** Current ladder floor id (1..5), or null. Read-only probe for the iPad zoom-feel telemetry (ui/touchTelemetry.js); never throws. */
  currentFloor() {
    try {
      return (this._ladder && this._ladder.getState) ? this._ladder.getState().floor : null;
    } catch (_) {
      return null;
    }
  }

  static get ADAPT_HOLDOFF_MS() { return ADAPT_HOLDOFF_MS; }

  /** True while the ladder owns input/camera (flag on + gameplay + engaged). */
  isActive() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._gameState && this._gameState.isGameplay && this._gameState.isGameplay() &&
      this._engaged);
  }

  /**
   * Should the runtime quality adapt HOLD OFF this frame? True while a ride is in flight or within ADAPT_HOLDOFF_MS of the
   * last ladder input. WHY: rides + wheel bursts are transient (FOV/near/far swaps, Earth fill changes, first-use texture
   * binds) yet land in the runtimeAdapt fps history, which is CLEARED on every tier change; the next 60-frame check
   * window can then be 100% transient frames, and a machine at the tier boundary flip-flops the tier DURING zooming
   * (every applyTier() is a full composer rebuild + resize: a visible flash). Flag-off: always false.
   * @param {number} [nowMs] - monotonic clock; defaults to now()
   */
  adaptHoldoff(nowMs) {
    if (!this.isActive()) return false;
    // isRiding() is the allocation-free probe: this runs once per gameLoop frame and must not materialize a getState()
    // snapshot (guarded for injected ladder stubs that pre-date the accessor).
    if (this._ladder.isRiding ? this._ladder.isRiding()
      : this._ladder.getState().mode === 'riding') return true;
    const t = (nowMs === undefined) ? this._now() : nowMs;
    return (t - this._lastInputMs) < ADAPT_HOLDOFF_MS;
  }

  _wantEngaged() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._gameState && this._gameState.isGameplay && this._gameState.isGameplay());
  }

  /**
   * Is a ladder camera ride in flight? The frame scheduler's ride signal (rides run at native refresh). The truth is the
   * CORE's ride token (set by `rideStarted` in `_startRide`, cleared by `rideFinished`; the `_rideSeq` guard drops
   * superseded completions). Allocation-free; guarded for stubs that pre-date the accessor. Disengaged/flag-off: false.
   */
  isRiding() {
    if (!this._engaged) return false;
    return !!(this._ladder.isRiding ? this._ladder.isRiding()
      : this._ladder.getState().mode === 'riding');
  }

  /** Per-frame tick: engage/disengage lifecycle, the core's escalation timers (charge decay, settle-back, alarms), rail refresh. */
  update(tMs) {
    const t = (tMs === undefined) ? this._now() : tMs;
    const want = this._wantEngaged();
    if (want && !this._engaged) this._engage(t);
    else if (!want && this._engaged) this._disengage();
    if (!this._engaged) return [];

    const decisions = this._ladder.update(t);
    this._apply(decisions, t);
    // Intro FLYBY state machine (owner 2026-09-07): dive (5 → the hull) → one breath (INTRO_DWELL_MS) → silent pull-back up to
    // INTRO_LANDING_FLOOR. Any player input after the dive started cancels the remaining phases.
    this._introTick(t);
    // NOTE: the NAVCOM floor content is NOT ticked here — main.js is the SINGLE navcom ticker (navcom.update({project,shipPos,
    // shipAngleRad}) with the live camera projector right after cameraSystem.update, so icons read this frame's pose and never
    // render twice). This controller owns only the activate/deactivate lifecycle (_applyFloorContent / _disengage).
    //
    // Reticle re-assert: TargetReticle self-SHOWS on any gameplay-entering GAME_STATE_CHANGE (its listener in the
    // TargetReticle.js constructor), so a gameplay↔gameplay transition (e.g. ORBITAL_VIEW→APPROACH) on F4/F5 would
    // resurrect it. This class has no EventBus
    // dep, so re-assert the hide per frame (setVisible(false) is one style assignment). DockingReticle needs none: its
    // listener only HIDES, and its per-frame owner (main.js ARM PILOT) honours reticlesSuppressed().
    if (this._reticlesHidden && this._targetReticle && this._targetReticle.setVisible) {
      this._targetReticle.setVisible(false);
    }
    this._turntableArrows(t);
    this._syncTakeover();   // a camera input took the focus pose over (a drag): the ladder's zoom state follows it
    this._dzTick(t);        // daughter zoom: the camera comes back from her limit when the follow has ended
    this._glideTick(t);
    this._refreshRail();
    return decisions;
  }


  /** @private The camera's drag/ride/disengage cancel count (0 without the camera API). */
  _frameCancels() {
    const cs = this._cameraSystem;
    return (cs && typeof cs.ladderEarthFrameCancels === 'function') ? cs.ladderEarthFrameCancels() : 0;
  }

  /**
   * The floor-4 framing's zoom: glide the view to `distU`, eased over `ms` (default: the camera's running turn length,
   * `ladderEarthTurnMs()`, 1-1.5 s; FRAME_GLIDE_MS without one), never closer than now and never past the floor's free
   * zone (no wall creep, no settle-back). Not a ride, not player input. Ended where it is by the wheel/pinch (the player
   * wins), a ride, a floor change or a camera drag (ladderCancelEarthTurn bumps the count this watches).
   * @param {{distU:number, ms?:number, tMs?:number}} arg
   * @returns {boolean} true when a glide started
   */
  frameZoomTo({ distU, ms, tMs } = {}) {
    if (!this._engaged || this.isRiding() || typeof this._ladder.glide !== 'function') return false;
    if (ms === undefined) {   // the camera's turn length (a long turn is stretched to <= 1.5 s), else 1 s
      const cs = this._cameraSystem;
      const turnMs = (cs && typeof cs.ladderEarthTurnMs === 'function') ? cs.ladderEarthTurnMs() : 0;
      ms = turnMs > 0 ? turnMs : FRAME_GLIDE_MS;
    }
    const s = this._ladder.getState();
    // Floor 4 only (as Tab's focus step): floors 2, 3 and 5 never glide.
    const f = (s && s.floor === 4) ? FloorContract.byId(s.floor) : null;
    if (!f || !(distU > 0) || !Number.isFinite(distU)) return false;
    const w = FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC;
    const to = Math.min(1 - w, Math.max(s.z01, z01FromDistance(f, distU)));
    if (!(to > s.z01 + 1e-6)) { this._glide = null; return false; }
    this._glide = {
      floor: s.floor, fromZ01: s.z01, toZ01: to,
      t0: (tMs === undefined) ? this._now() : tMs,
      ms: (Number.isFinite(ms) && ms > 0) ? ms : FRAME_GLIDE_MS,
      cancels0: this._frameCancels(),
    };
    return true;
  }

  /** The farthest the framing may glide on the current floor (the free zone's top), scene units. */
  frameMaxDistU() {
    const s = this._ladder.getState();
    const f = s ? FloorContract.byId(s.floor) : null;
    return f ? distanceFromZ01(f, 1 - FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC) : NaN;
  }

  isFrameZooming() { return !!this._glide; }

  /** @private Advance the glide one frame (or end it on a ride, a floor change, a camera drag). */
  _glideTick(t) {
    const g = this._glide;
    if (!g) return;
    const s = this._ladder.getState();
    if (!s || s.floor !== g.floor || s.mode === 'riding' || this._frameCancels() !== g.cancels0) {
      this._glide = null;
      return;
    }
    const u = clamp01((t - g.t0) / g.ms);
    const z01 = g.fromZ01 + (g.toZ01 - g.fromZ01) * glideEase(u);
    this._apply(this._ladder.glide({ tMs: t, z01 }), t);
    if (u >= 1) this._glide = null;
  }

  /**
   * Is the TURNTABLE live? Engaged, on a SHIP-anchored floor (1 workbench, 2 flying view: owner lifted the
   * workbench-only limit) with the workbench pane open.
   * Allocation-free (floorId probe). main.js consults it per frame to blank the arrows around processInput so they never
   * steer the SHIP; _turntableArrows maps them to the camera drag; routeKeyDown consumes them ahead of InputManager.
   * Touch doesn't depend on it: a one-finger drag turns the view on floors 1–4 and the turn pad writes the keys.
   * CameraSystem._ladderDragEnabledFor is the mouse-side rule (the mouse also drags on floor 2 without a drawer).
   * @returns {boolean}
   */
  turntableActive() {
    if (!this._engaged) return false;
    const f = this._ladder.floorId ? this._ladder.floorId() : this._ladder.getState().floor;
    if (f !== 1 && f !== 2) return false;
    const w = this._workbench;
    return !!(w && w.isOpen && w.isOpen());
  }

  /**
   * @private Map held arrows to a camera drag nudge through the camera's OWN drag mechanism (velocity + damping: one feel
   * for pointer and keys), scaled by ARROW_TURN_PX_PER_S and dt so it is frame-rate independent. Counts as ladder input
   * for adaptHoldoff. No-ops without the keys map / camera nudge, off the turntable, and while riding (rides own the camera).
   * @param {number} tMs
   */
  _turntableArrows(tMs) {
    const prev = this._turnPrevMs;
    this._turnPrevMs = tMs;
    const k = this._inputKeys;
    if (!k || !this._cameraSystem || !this._cameraSystem.ladderDragNudge) return;
    if (!this.turntableActive()) return;
    const dx = (k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0);
    const dy = (k.ArrowDown ? 1 : 0) - (k.ArrowUp ? 1 : 0);
    if (dx === 0 && dy === 0) return;
    const dtS = (prev == null) ? 0 : Math.min(0.1, Math.max(0, (tMs - prev) / 1000));
    if (dtS === 0) return;
    const px = ARROW_TURN_PX_PER_S * dtS;
    this._cameraSystem.ladderDragNudge(dx * px, dy * px);
    this._lastInputMs = tMs;
    this._endCatchFocus();
  }

  /**
   * Any camera input of the player's ends the catch focus (CameraSystem CATCH_FOCUS) at once; the ladder state the input is
   * about to change is the camera's own, which the focus never wrote.
   * @private
   */
  _endCatchFocus(cause) {
    const cs = this._cameraSystem;
    if (cs && typeof cs.ladderCancelCatchFocus === 'function') cs.ladderCancelCatchFocus(cause);
    this._syncTakeover();
  }

  /**
   * When a camera input has taken the catch focus's drawn pose over (CameraSystem `ladderTakeoverDistU`), put the core's z01
   * on the camera's real distance, clamped into the floor's range (the camera eases there if the clamp moves it). Otherwise
   * the core holds the pre-focus distance and the next wheel notch steps from THAT: a dolly of up to ~90 m in ~0.2 s.
   * @private
   */
  _syncTakeover() {
    const cs = this._cameraSystem;
    if (!cs || typeof cs.ladderTakeoverDistU !== 'function') return;
    const distU = cs.ladderTakeoverDistU();
    if (!(distU > 0) || !this._engaged || this.isRiding()) return;
    const st = this._ladder.getState();
    const f = st ? FloorContract.byId(st.floor) : null;
    if (!f || f.anchor === 'earth') return;
    // Daughter zoom: a takeover (a drag in the wait view, never a piloted daughter's) is measured from the mother, so it ends
    // any deep position / follow-end ease: `_frame` must not draw that stale close distance again.
    this._dz.z = null; this._dz.ease = null;
    // A distance outside this floor's range is NOT clamped into it (the camera would fly there, ~0.2 s, mostly floors 1 and 3):
    // put the ladder on the floor among 1-3 whose range holds it, so the camera does not move. Clamp only when no floor 1-3
    // holds it (< 2 m, > 12 km).
    let floorId = st.floor, fl = f;
    const holds = (row) => !!row && row.anchor !== 'earth' && distU >= row.camera.distU[0] * (1 - 1e-6) && distU <= row.camera.distU[1] * (1 + 1e-6);
    if (!holds(f)) {
      for (const id of [1, 2, 3]) {
        const row = FloorContract.byId(id);
        if (holds(row)) { floorId = id; fl = row; break; }
      }
    }
    const z01 = z01FromDistance(fl, distU);
    if (!this._ladder.place({ tMs: this._now(), floor: floorId, z01 })) return;
    if (floorId !== st.floor) {
      // a floor change without a ride: what _startRide does for the destination (rest memory, fidelity block, floor content)
      this._seedRest(z01);
      this._dzNearSmall = false;
      this._applyFidelity(floorId);
      this._applyFloorContent(floorId);
    }
    this._lastPosZ01 = z01;
    if (cs.ladderSetTarget) cs.ladderSetTarget(this._frame(floorId, z01));
  }

  /** Router entry: one router-normalized wheel event. */
  wheel({ tMs, dir, mag }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    // The tail of the gesture that brought her to floor 4 (owner 2026-10-31): a ride has just landed there and the wheel has
    // not been quiet for RIDE_TAIL_SWALLOW_MS since its last event, so this is the same push's momentum, not a new request. It does
    // nothing (no zoom, no glide or turn cancel, no input stamp) and keeps the tail going; the first event after a longer
    // gap disarms the filter and is handled normally. The core's own tail logic only covers the wall-zone spring.
    const tailGap = t - this._lastWheelMs;
    this._lastWheelMs = t;
    if (this._rideTailArmed) {
      if (tailGap < RIDE_TAIL_SWALLOW_MS) return [];
      this._rideTailArmed = false;
    }
    this._lastInputMs = t;
    // Daughter focus (wait view / her haul / her reel view; owner 2026-10-27): a zoom moves in or out on her and keeps the
    // view; only a zoom out past floor 3's edge ends it (after the ladder is put on that distance).
    const fz = this._focusZoomWheel(dir, mag, t);
    if (fz === true) { this._refreshRail(); return []; }
    this._endCatchFocus();
    // The wheel AND the pinch (TouchControls → WheelRouter.routeSyntheticWheel) end the floor-4 re-frame's zoom glide, and
    // only that. They do NOT stop the camera's turn to the lifted default view (owner 2026-10-31: a trackpad's coasting tail
    // after the ride into floor 4 cancelled it, nothing asked again and she saw the ring edge-on). Leaving floor 4 is a ride,
    // and ladderStartRide cancels the turn; a drag still stops it (CameraSystem).
    this._glide = null;
    if (this._daughterZoomWheel(dir, mag, t)) {
      this._refreshRail();
      return [];
    }
    const decisions = this._ladder.wheel({ tMs: t, dir, mag });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }


  /**
   * @private Offer a zoom notch to a daughter's catch focus (CameraSystem.ladderCatchFocusZoom). True: taken, the view stays
   * on her. False: not a daughter focus. At floor 3's outer edge a notch OUT ends the focus: the ladder is first put on that
   * distance so the camera does not jump, then false is returned and the wheel goes on as usual.
   */
  _focusZoomWheel(dir, mag, tMs) {
    const cs = this._cameraSystem;
    if (!cs || typeof cs.ladderCatchFocusZoom !== 'function' || this.isRiding() || (dir !== 'in' && dir !== 'out')) return false;
    const st = this._ladder.getState();
    const row = st ? FloorContract.byId(st.floor) : null;
    if (!row || row.anchor === 'earth') return false;
    const [lo, hi] = row.camera.rangeLog10;
    const step = (typeof this._ladder.wheelZ01Step === 'function') ? this._ladder.wheelZ01Step() : 0.04;
    const r = cs.ladderCatchFocusZoom({ dir, mag, stepDecades: step * (hi - lo) });
    if (r === 'edge') {
      const f3 = FloorContract.byId(3);
      const z01 = 1 - FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC;
      this._dz.z = null; this._dz.ease = null;
      if (this._ladder.place({ tMs, floor: f3.id, z01 })) {
        if (st.floor !== f3.id) {
          this._seedRest(z01);
          this._dzNearSmall = false;
          this._applyFidelity(f3.id);
          this._applyFloorContent(f3.id);
        }
        this._lastPosZ01 = z01;
        if (cs.ladderSetTarget) cs.ladderSetTarget(this._frame(f3.id, z01));
      }
      return false;
    }
    return r === true;
  }

  /** @private true while the camera rides a piloted daughter (floors 2-3). */
  _daughterFollowed() {
    const cs = this._cameraSystem;
    return !!(cs && typeof cs.ladderFollowedDaughter === 'function' && cs.ladderFollowedDaughter());
  }

  /** @private floor 2's row + its z01 numbers: { row, lo, span, wallLo, wallHi, step, minZ }. */
  _dzGeometry() {
    const row = FloorContract.byId(FloorContract.DAUGHTER_ZOOM.FLOOR);
    const [lo, hi] = row.camera.rangeLog10;
    const span = hi - lo;
    const wallLo = FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC;
    const step = (typeof this._ladder.wheelZ01Step === 'function') ? this._ladder.wheelZ01Step() : 0.04;
    const minZ = (Math.log10(FloorContract.daughterZoomLimitU()) - lo) / span;
    return { row, lo, span, wallLo, wallHi: 1 - wallLo, step, minZ };
  }

  /**
   * @private A wheel event while the camera rides a daughter on floor 2: handle the part of the zoom below the free
   * zone here (the core would charge its wall and cross to floor 1). Returns true when the event is consumed.
   *   in : past the free zone's inner edge → deeper, step by step, stopping at her limit;
   *   out: while deep → back up the same steps; past the edge the core takes over again (placed on the edge).
   * Anything else (not floor 2, nothing followed, mid-ride, a normal free-zone step) → false: the core as before.
   */
  _daughterZoomWheel(dir, mag, tMs) {
    const st = this._ladder.getState();
    if (!st || st.floor !== FloorContract.DAUGHTER_ZOOM.FLOOR || this.isRiding()) return false;
    const dz = this._dz;
    if (!this._daughterFollowed()) {
      // she is gone and the camera is coming back: a wheel notch ends the ease where the core can take over
      if (dz.z != null) this._dzHandBack(tMs);
      return false;
    }
    const g = this._dzGeometry();
    dz.ease = null;
    const z0 = dz.z != null ? dz.z : st.z01;
    if (dir === 'in') {
      const target = z0 - mag * g.step;
      if (dz.z == null && target >= g.wallLo) return false;      // an ordinary free-zone step
      dz.z = Math.max(g.minZ, target);
    } else {
      if (dz.z == null) return false;
      const target = z0 + mag * g.step;
      if (target >= g.wallLo) {
        this._dzHandBack(tMs, Math.min(g.wallHi, target));
        return true;
      }
      dz.z = target;
    }
    this._dzApply(st);
    return true;
  }

  /** @private push the camera target for the current deep position (the camera's own ease does the rest). */
  _dzApply(st) {
    this._dzNearTick();   // the small near plane goes in with the same step that brings the camera in (not a frame later)
    const cs = this._cameraSystem;
    if (cs && cs.ladderSetTarget) cs.ladderSetTarget(this._frame(st.floor, st.z01));
  }

  /**
   * @private leave the deep zoom: the core is placed on floor 2 at `z01` (default: the free zone's inner edge, the
   * nearest rest the floor has) and the camera target follows. The distance is continuous when `z01` is where the
   * deep position was; otherwise the camera's ease carries it.
   */
  _dzHandBack(tMs, z01) {
    const g = this._dzGeometry();
    this._dz.z = null;
    this._dz.ease = null;
    this._ladder.place({ tMs, floor: FloorContract.DAUGHTER_ZOOM.FLOOR, z01: z01 != null ? z01 : g.wallLo });
    const st = this._ladder.getState();
    this._dzApply(st);
  }

  /**
   * @private Near plane for the deep zoom (owner 2026-10-27: "about 1.5 m"). Floor 2's own near plane is 3 m, so with the
   * camera closer than where her nearest point clears it (`daughterZoomLimitU(floor 2)`, 4.0 m) she would be cut (a catch
   * focus zoomed in on a daughter has the same need). While the deep position is held (it starts 9.2 m out, its zone's inner
   * edge, and every exit ends at or beyond that edge), FloorContract.DAUGHTER_ZOOM.NEAR_FLOOR's near plane (floor 1's, 0.04 m)
   * is pushed; floor 2's own returns as the deep position ends. A floor change or a ride pushes the new floor's own near
   * plane (and clears the flag).
   */
  _dzNearTick() {
    const cs = this._cameraSystem;
    // deep follow zoom (floor 2), or the catch focus zoomed in on a daughter (any of floors 1-3)
    const want = this._dz.z != null || !!(cs && typeof cs.catchFocusZoomIn === 'function' && cs.catchFocusZoomIn());
    if (want === this._dzNearSmall) return;
    this._dzNearSmall = want;
    this._applyFidelity(this._ladder.getState().floor,
      want ? FloorContract.byId(FloorContract.DAUGHTER_ZOOM.NEAR_FLOOR).camera.near : undefined);
  }

  /**
   * @private Per frame: when the follow ended while the camera sat inside the free zone's inner edge (she docked, Esc,
   * the view went back to the mother), ease the distance out to that edge over the re-aim time (cubic in-out, the
   * same time the anchor takes back to the mother), never a one-frame jump; a cut only under reduced motion.
   * (The mother's own hard bottom is 6 m; the edge, 9.2 m, is where she can rest, so the ease ends there.)
   */
  _dzTick(tMs) {
    this._dzNearTick();
    const dz = this._dz;
    if (dz.z == null) return;
    if (this._daughterFollowed()) { dz.ease = null; return; }
    const g = this._dzGeometry();
    if (!dz.ease) {
      if (this._reducedMotion()) { this._dzHandBack(tMs); return; }
      // Eased in METRES (not z01: the floor's scale is logarithmic, so a z01 ease runs fastest at the far end), over the
      // re-aim time or longer: a cubic in-out peaks at 3x its mean speed, so the time is stretched until the peak is
      // DZ_RETURN_PEAK_MPS (measured at 60 Hz: 4 m -> 9.2 m over 300 ms peaked at 0.52 m in one frame, over the
      // 0.5 m the owner's "no jarring jump" allows; over the stretched time it is 0.27 m).
      const from = Math.pow(10, g.lo + dz.z * g.span), to = Math.pow(10, g.lo + g.wallLo * g.span);
      const ms = Math.max(VisualLaw.TIMINGS.SUBJECT_REAIM_MS, 3 * Math.abs(to - from) / Constants.SCENE_UNITS_PER_METER / DZ_RETURN_PEAK_MPS * 1000);
      dz.ease = { from, to, t0: tMs, ms };
    }
    const e = dz.ease;
    const k = (tMs - e.t0) / e.ms;
    if (k >= 1) { this._dzHandBack(tMs); return; }
    dz.z = (Math.log10(e.from + (e.to - e.from) * cubicInOut(clamp01(k))) - g.lo) / g.span;
    this._dzApply(this._ladder.getState());
  }

  /** Discrete command passthrough (Esc/PgUp/PgDn/Space). */
  command({ tMs, type }) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
    this._endCatchFocus('ladder command');
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
    this._endCatchFocus('floor jump');
    const decisions = this._ladder.jump({ tMs: t, toFloor });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /**
   * The CEREMONY ride to the workbench. The hub calls it on WORKBENCH_STOP (GameFlowManager's ONE ladder-on depot entry: the
   * chapter dwell, the B key, the STORE chip), then opens the workbench pane. The core's `ceremonyRide` flies floor 1 at the
   * CROSSING duration (no miniMs, so `_apply` uses CROSS_RIDE_MS 550, not the 200 ms hotkey mini-ride: the break is seen),
   * superseding a ride in flight, through the SAME `_apply` → `_startRide` path as every ride. Already on floor 1 → [] (the
   * pane simply opens). Disengaged → [] (the hub's stop handler releases the break).
   * @param {{ tMs?: number }} [arg]
   * @returns {Array} the decisions applied (jump()'s shape)
   */
  rideToWorkbench({ tMs } = {}) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
    // The B key / STORE chip is his input like a jump: a zoomed daughter view hands its distance to the ladder first, else the
    // ride (which ends the focus with no hand-off) starts from a stale floor and the camera flies the whole distance.
    this._endCatchFocus('workbench ride');
    const decisions = (typeof this._ladder.ceremonyRide === 'function')
      ? this._ladder.ceremonyRide({ tMs: t, toFloor: WORKBENCH_FLOOR })
      : this._ladder.jump({ tMs: t, toFloor: WORKBENCH_FLOOR });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /**
   * Esc grammar (08-workbench §2: "Esc closes the topmost pane first, then rides up"). Close the workbench pane when OPEN and
   * report whether it was: InputManager calls this ONCE before it would command 'esc' and returns on true, so the ride-up is
   * the NEXT Esc. Absent dep / closed pane / disengaged → false. The pane's own close() fires its onOpenChange edge (D10 calm
   * cap + camera inset release): no second signal here. Not a ladder input for adaptHoldoff (no camera flight).
   * @returns {boolean} true when the pane was open and is now closed
   */
  closeTopPane() {
    if (!this._engaged) return false;
    const w = this._workbench;
    if (w && w.isOpen && w.isOpen()) {
      if (w.close) w.close();
      return true;
    }
    return false;
  }

  /**
   * Horizontal-swipe eligibility (08-workbench §2 "Horizontal = what (panes)"): true while engaged with the workbench pane
   * dep, on EVERY floor (the SPECS tab lives on every floor; REFIT is a block inside the pane). WheelRouter consults it per
   * HORIZONTAL-dominant wheel event (|deltaX| > |deltaY|) before claiming the event from the zoom feed: never per frame,
   * never for a vertical event. Elsewhere the router leaves the axis as shipped.
   * @returns {boolean}
   */
  wantsPaneSwipe() {
    if (!this._engaged) return false;
    return !!this._workbench;
  }

  /**
   * Read-only pane probe for the `?trace=1` FlickTraceRecorder (07-flick-tuning §5): the pane's open state and the live
   * swipe-claim verdict, so a recorded trace replays `_claimPaneSwipe` as it ran live. The SHAPE `{ refit, library,
   * wantsPaneSwipe }` is kept so recorded traces keep replaying: `library` is the ONE pane's isOpen() (null when the dep is
   * absent or lacks isOpen), `refit` is always null (no second pane), `wantsPaneSwipe` is WheelRouter's answer. Event rate:
   * never per frame, never a write, never a throw.
   * @returns {{ refit: null, library: boolean|null, wantsPaneSwipe: boolean }}
   */
  paneState() {
    const isOpen = (p) => (p && typeof p.isOpen === 'function') ? !!p.isOpen() : null;
    let wants = false;
    try { wants = this.wantsPaneSwipe(); } catch (_e) { wants = false; }
    return { refit: null, library: isOpen(this._workbench), wantsPaneSwipe: wants };
  }

  /**
   * The ONE horizontal page verb: step the workbench carousel one position toward a screen side. WheelRouter's accumulator
   * decides WHEN (one call per flick); this decides WHAT, through the pane's own open()/close() (whose onOpenChange edge
   * carries the D10 calm cap + camera inset as a tab click would; no signal added here).
   *
   * ONE pane, so the carousel is TWO-POSITION on EVERY floor: **[view] — [SPECS]**. The drawer is left on every floor
   * (DECISIONS §13 row 5); gestures follow it (row 6):
   *
   *   toward 'left'  (the pane's side): a closed pane opens, else nothing (wall).
   *   toward 'right' (away from it):    an open pane closes, else nothing.
   *
   * 'left'/'right' are SCREEN sides: the pane's RTL mirror is its own CSS variable. Disengaged or an unknown `toward` → null,
   * pane untouched; an absent dep is skipped. Like closeTopPane(), NOT a ladder input for adaptHoldoff.
   * @param {{ tMs?: number, toward: 'left'|'right' }} arg
   * @returns {'open-workbench'|'close-workbench'|null} the action taken (null = nothing to do)
   */
  pagePane({ toward } = {}) {
    if (!this._engaged) return null;
    const w = this._workbench;
    const open = !!(w && w.isOpen && w.isOpen());
    if (toward === 'left') {
      if (w && !open) { if (w.open) w.open(); return 'open-workbench'; }
      return null;
    }
    if (toward === 'right') {
      if (open) { if (w.close) w.close(); return 'close-workbench'; }
      return null;
    }
    return null;
  }


  /**
   * The pane's open/close EDGE, from main.js's ONE `_syncWorkbenchPanes` (the same edge that feeds the D10 calm cap + camera
   * inset). Records the pane's open-state into the player store as the player's intent, ONLY while engaged and not driven by
   * the controller: `_disengage` clears `_engaged` BEFORE its teardown close fires, and `_restorePanes` sets `_paneRestoring`,
   * so the controller's own close/re-open are never mistaken for the player. Write-on-change (the store compares). No
   * store → nothing. Never throws.
   *
   * The store SHAPE `{ refit, library }` is kept: `library` is the ONE pane's open bit (every floor), `refit` is a DEAD BIT
   * written `false`; old stores with `refit: true` are honoured by `_restorePanes` (it opens the pane when EITHER bit is
   * set) and converge on their next write.
   */
  notePaneChange() {
    if (!this._viewStore || this._paneRestoring) return;
    if (!this._engaged) return;
    if (typeof this._viewStore.setPanes !== 'function') return;
    const isOpen = (p) => !!(p && typeof p.isOpen === 'function' && p.isOpen());
    this._viewStore.setPanes({ refit: false, library: isOpen(this._workbench) });
  }

  /**
   * The HUD pane-visibility EDGE (D5 room-memory write): a pane was shown/hidden by a PLAYER key (0/9/8, density `-`/`+`/the
   * iPad slider; Events.HUD_PANE_VISIBILITY, emitted AFTER the bit flips) with no floor change to capture it. Capture the
   * applied floor's room NOW and export it to the player store, at event rate, never per frame (the store compares, so an
   * unchanged room writes nothing). The mask's capture() guards make a mask-less / disabled / never-applied state a no-op;
   * disengaged returns before touching either dep; flag-off never reaches here (the ONE listener lives inside main.js's
   * LADDER.ENABLED gate). Never throws.
   */
  noteRoomChange() {
    if (!this._engaged || !this._floorMask) return;
    if (typeof this._floorMask.capture !== 'function') return;
    this._floorMask.capture();
    this._persistRooms();
  }

  /**
   * RESET ROOM: forget the applied floor's remembered pane layout, re-apply its default room, then export (the store learns
   * the reset). No rail calls it now; the verb stays as a hub/probe entry (the DETAIL slider follows the re-applied room
   * through the pane-visibility edge). No-op disengaged, without a mask, or before the mask learned resetRoom. Event-rate only.
   * @returns {boolean} true when a room was reset
   */
  resetRoom() {
    if (!this._engaged || !this._floorMask) return false;
    if (typeof this._floorMask.resetRoom !== 'function') return false;
    const floor = this._floorApplied;
    if (floor == null) return false;
    this._floorMask.resetRoom(floor);
    this._persistRooms();
    return true;
  }

  /**
   * The CAPTURE-phase keydown router the hub installs on window inside the LADDER.ENABLED gate, ahead of InputManager's
   * bubble-phase handler (InputManager is do-not-edit; its `keys` map is the public seam). Returns true when the key was
   * CONSUMED (the hub then `stopImmediatePropagation()`s). Every rule is floor-gated and inert when disengaged:
   *
   *   1. ARROWS under the TURNTABLE: InputManager's handler disengages autopilot on the FIRST arrow press before any frame
   *      runs, so the per-frame blanking shim is too late. While `turntableActive()` the arrow keydown writes the SAME public
   *      key bit InputManager would (`keys[code] = true`, so _turntableArrows still reads it) and is consumed; keyup is left
   *      to InputManager (it only clears the bit). preventDefault keeps the page from scrolling.
   *   2. TAB on floor 3 (DEBRIS / PROX NET): cycles the insertion candidates (`proxNet.cycleInsertion(±1)`, Shift reverses).
   *      Consumed only when a candidate was cycled; with no plan the shipped debris cycle runs untouched.
   *   3. TAB on floor 4 (LEO / NAVCOM): steps the focused cluster (`navcom.focusStep(±1)`); consumed when a cluster is focused
   *      after the step. While the "where next" list is open (`navcom.choosing()`) it steps the list's rows instead, always
   *      consumed.
   *
   * A key aimed at a text field (INPUT / TEXTAREA / contentEditable: the Codex search box) is never routed (InputManager's
   * own guard, mirrored), so a capture-phase router cannot swallow a caret's arrows or Tab. Never throws; never a ladder
   * input for adaptHoldoff (the arrows' own nudge counts inside _turntableArrows).
   * @param {{ code?: string, shiftKey?: boolean, target?: object, preventDefault?: function }} e
   * @returns {boolean} true when consumed
   */
  routeKeyDown(e) {
    if (!this._engaged || !e || typeof e.code !== 'string') return false;
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return false;
    const code = e.code;
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight') {
      if (!this.turntableActive()) return false;
      if (this._inputKeys) this._inputKeys[code] = true;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      return true;
    }
    if (code === 'Tab') {
      const f = this._ladder.floorId ? this._ladder.floorId() : this._ladder.getState().floor;
      const dir = e.shiftKey ? -1 : 1;
      if (f === 3 && this._proxNet && typeof this._proxNet.cycleInsertion === 'function') {
        const c = this._proxNet.cycleInsertion(dir);
        if (!c) return false;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      }
      // While the "where next" list is open on floor 4, Tab steps over its rows, not the clusters.
      if (f === 4 && this._navcom && typeof this._navcom.choosing === 'function' && this._navcom.choosing()) {
        this._navcom.choiceStep(dir);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      }
      if (f === 4 && this._navcom && typeof this._navcom.focusStep === 'function') {
        this._navcom.focusStep(dir);
        const focused = (typeof this._navcom.getFocusedCluster === 'function')
          ? this._navcom.getFocusedCluster() : null;
        if (!focused) return false;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      }
    }
    return false;
  }

  /**
   * The run-scoped half of D5 for the RUN SAVE (main.js gathers it on PERSISTENCE_GATHER as `save.ladder`, inside the
   * LADDER.ENABLED gate): the core's live `(floor, z01)`. A plain fresh object; null if the core has no snapshot; never throws.
   * @returns {{floor: number, z01: number}|null}
   */
  viewState() {
    try {
      const s = this._ladder.getState();
      return (s && Number.isFinite(s.floor) && Number.isFinite(s.z01)) ? { floor: s.floor, z01: s.z01 } : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Restore a saved view (`save.ladder`, main.js on PERSISTENCE_LOADED) into the core BEFORE the first engage of a continued
   * run; the next `_engage` re-engages where the player left. Validated: `floor` ∈ FloorContract.FLOORS and a finite `z01`
   * (ZoomLadder.place clamps to [0,1]); anything else → the shipped default stands, no throw. Refused while engaged in
   * gameplay (a cut under a live camera is never invisible; 06-core-api "place"); a controller left engaged because gameplay
   * ended without a frame yet is disengaged first. A ride the core still reports while disengaged is stale by construction
   * (the camera dropped its completion at disengage) and is settled before the placement.
   * @param {{floor?: number, z01?: number}|null|undefined} saved
   * @returns {boolean} true when the core was placed
   */
  restoreView(saved) {
    this._forgetRevealsPending = false;   // a continue keeps the room exactly
    if (!saved || typeof saved !== 'object') return false;
    const floor = saved.floor, z01 = saved.z01;
    if (!Number.isFinite(floor) || !FloorContract.FLOORS.some((f) => f.id === floor)) return false;
    if (typeof z01 !== 'number' || !Number.isFinite(z01)) return false;
    return this._placeWhileHidden(floor, z01);
  }

  /**
   * GAME_RESET (main.js, inside the LADDER.ENABLED gate): the core goes back to the shipped initial view captured at
   * construction, so a NEW game starts on the shipped floor with the intro ride, whatever floor the last run ended on. A
   * CONTINUE restores the saved view right after (GameFlowManager emits PERSISTENCE_LOADED after resetGame()). Arms the
   * forget-reveals drop: the player's rooms stay (D5: they belong to the player, not the run) except the panes a `+` revealed
   * past a floor's default, which the first engage of this run drops from the mask's memory. restoreView() disarms it. Same
   * engaged-in-gameplay refusal as restoreView (nothing is armed then: the live room stands).
   * @returns {boolean} true when the core was placed
   */
  resetView() {
    let placed = false;
    if (this._initialView) placed = this._placeWhileHidden(this._initialView.floor, this._initialView.z01);
    // Armed AFTER the placement: _placeWhileHidden may _disengage, which captures and persists the live layout.
    if (!this._engaged) this._forgetRevealsPending = true;
    return placed;
  }

  /**
   * The INTRO RIDE. The hub calls this right after resetView() on GAME_RESET for EVERY New Game entered from the MENU (owner
   * 2026-09-09: "fly-by every time"; never under the ?shot harness unless asked with &intro=1; the hub's once-per-menu-departure
   * latch keeps a GAMEOVER retry from replaying it; a CONTINUE disarms it). The core is PLACED (a cut while hidden, the same
   * invisible path as restoreView) on the TOP floor, and the ride to the FLYING floor (INTRO_LANDING_FLOOR) is ARMED: `_engage`
   * starts it the moment the ladder owns the screen, at INTRO_RIDE_MS (or `rideMs`), through the same `_apply` → `_startRide`
   * path as every ride, silently (watched, not commanded). Under REDUCED MOTION (`reducedMotion: true`) the core is placed on
   * the landing floor itself and nothing is armed. Refused (false, nothing armed) while engaged in gameplay, when the contract
   * has no top / landing floor, or when the placement fails.
   *
   * Opening-dance options; absent → the plain flyby (pinned):
   *   `entryZ01` — the DIVE's landing z01 (null → the floor rule); the dance arms 0.23 (2.67 m on F1).
   *   `dwellMs` — the dwell CEILING, not its duration (INTRO_DWELL_MS when absent): the hand-over event ends the dwell via
   *     endIntroDwellEarly(); this only fires the pull-back if the event is dropped. The dance arms dance-total + 2 s.
   *   `dolly` — `{ toZ01, rideMs }`: a silent within-floor ride (ZoomLadder.dollyTo) fired by _introTick ITSELF on the
   *     dive→dwell transition (nobody else knows when the dive lands). One shot; not fired when the dwell was already ended
   *     early (a skip's hand-over arrived mid-dive).
   *   `handoverZ01` — where the PULL-BACK leaves the camera (where the player takes the wheel). Absent: the contract's own
   *     ENTRY_Z01_FROM_BELOW.
   *   `pullbackMs` — the pull-back's duration. Absent ⇒ INTRO_PULLBACK_MS.
   * @param {{ rideMs?: number, entryZ01?: number, dwellMs?: number,
   *           dolly?: { toZ01: number, rideMs?: number },
   *           handoverZ01?: number, pullbackMs?: number,
   *           reducedMotion?: boolean }} [arg]
   * @returns {boolean} whether the intro was armed (or, reduced, placed)
   */
  armIntroRide({ rideMs, entryZ01, dwellMs, dolly, handoverZ01, pullbackMs, reducedMotion = false } = {}) {
    this._introPending = null;
    // Dance options reset FIRST: every early return below leaves nothing dance-shaped armed.
    this._introEntryZ01 = null;
    this._introHandoverZ01 = null;
    this._introPullbackMs = INTRO_PULLBACK_MS;
    this._introDwellMs = INTRO_DWELL_MS;
    this._introDolly = null;
    this._introDwellEarly = false;
    const ids = FloorContract.FLOORS.map((f) => f.id).filter((id) => Number.isFinite(id));
    if (!ids.length || !ids.includes(INTRO_LANDING_FLOOR)) return false;
    if (reducedMotion) return this._placeWhileHidden(INTRO_LANDING_FLOOR, 0.5);
    const top = Math.max(...ids);
    // The flyby needs a hull to dive to and headroom to dive from; otherwise just place on the landing floor (no ride).
    if (top === INTRO_LANDING_FLOOR || !ids.includes(WORKBENCH_FLOOR)) return this._placeWhileHidden(INTRO_LANDING_FLOOR, 0.5);
    if (!this._placeWhileHidden(top, 0.5)) return false;
    const ms = Number(rideMs);
    this._introPending = (Number.isFinite(ms) && ms > 0) ? ms : INTRO_RIDE_MS;
    if (typeof entryZ01 === 'number' && Number.isFinite(entryZ01)) {
      this._introEntryZ01 = clamp01(entryZ01);
    }
    if (typeof handoverZ01 === 'number' && Number.isFinite(handoverZ01)) {
      this._introHandoverZ01 = clamp01(handoverZ01);
    }
    const pbm = Number(pullbackMs);
    if (Number.isFinite(pbm) && pbm > 0) this._introPullbackMs = pbm;
    const dm = Number(dwellMs);
    if (Number.isFinite(dm) && dm >= 0) this._introDwellMs = dm;
    if (dolly && typeof dolly === 'object' && typeof dolly.toZ01 === 'number' &&
        Number.isFinite(dolly.toZ01)) {
      const drm = Number(dolly.rideMs);
      this._introDolly = {
        toZ01: clamp01(dolly.toZ01),
        rideMs: (Number.isFinite(drm) && drm > 0) ? drm : null,
      };
    }
    return true;
  }

  /** A CONTINUE (PERSISTENCE_LOADED) is not a new game — drop an armed intro ride. */
  disarmIntroRide() {
    this._introPending = null;
    this._introPhase = null;
    // Drop the dance options with the arm: a later run's flyby is whatever ITS armIntroRide says.
    this._introEntryZ01 = null;
    this._introHandoverZ01 = null;
    this._introPullbackMs = INTRO_PULLBACK_MS;
    this._introDwellMs = INTRO_DWELL_MS;
    this._introDolly = null;
    this._introDwellEarly = false;
  }

  /**
   * True from an armed intro until the flyby fully lands (or is cancelled): the hub's MAP floor getter reads null through the
   * WHOLE flyby, so the dwell's settled hull floor never becomes the checklist's ride baseline.
   */
  introInFlight() { return this._introPending !== null || this._introPhase !== null; }

  /**
   * End the intro dwell at the dance's hand-over (the hub wires this to Events.OPENING_DANCE_HANDOVER): ONE path for normal
   * completion and skip, immune to clock drift between the two systems; the dwellMs ceiling is only the dropped-event
   * fallback. In the dwell the ceiling drops to now, so the pull-back fires on the next tick. Called earlier (a skip's
   * hand-over can land mid-dive, or before the engage consumes the arm) it latches, and the dive→dwell transition makes the
   * dwell zero-length and fires no dolly (nothing left to watch). No-op when no flyby is in flight.
   */
  endIntroDwellEarly() {
    if (this._introPhase === 'dwell') {
      this._introDwellUntil = this._now();
    } else if (this._introPhase === 'dive' || this._introPending !== null) {
      this._introDwellEarly = true;   // consumed by the dive→dwell transition
    }
  }

  /**
   * @private Advance the intro FLYBY: dive lands → one breath at the hull (INTRO_DWELL_MS) → the silent pull-back to
   * INTRO_LANDING_FLOOR → done. Player input after the dive started (any verb that stamps _lastInputMs) cancels the rest.
   * With dance options the breath is the DANCE's dwell (`dwellMs` = its CEILING, see endIntroDwellEarly) and the transition
   * fires the armed DOLLY itself (ZoomLadder.dollyTo, the flickWall precedent) to the drift z01: one shot, suppressed when
   * the dwell was already ended early (the camera goes straight to the pull-back).
   */
  _introTick(t) {
    if (this._introPhase === null || !this._engaged) return;
    if (Number.isFinite(this._lastInputMs) && this._introDiveStartMs !== null && this._lastInputMs > this._introDiveStartMs) {
      this._introPhase = null;                 // the player took the wheel
      return;
    }
    if (this._introPhase === 'dive') {
      if (!this.isRiding()) {
        this._introPhase = 'dwell';
        const early = this._introDwellEarly;
        this._introDwellEarly = false;
        this._introDwellUntil = early ? t : t + this._introDwellMs;
        if (!early && this._introDolly) {
          const d = this._introDolly;
          this._introDolly = null;             // one shot
          if (typeof this._ladder.dollyTo === 'function') {
            const decisions = this._ladder.dollyTo({ tMs: t, z01: d.toZ01, rideMs: d.rideMs });
            this._apply(decisions, t, { silent: true });
          }
        }
      }
    } else if (this._introPhase === 'dwell') {
      if (t >= this._introDwellUntil) {
        // handoverZ01: where the player is LEFT; absent → the contract's own ENTRY_Z01_FROM_BELOW.
        const hz = this._introHandoverZ01;
        const decisions = (typeof this._ladder.ceremonyRide === 'function')
          ? this._ladder.ceremonyRide({ tMs: t, toFloor: INTRO_LANDING_FLOOR, entryZ01: hz ?? undefined })
          : this._ladder.jump({ tMs: t, toFloor: INTRO_LANDING_FLOOR });
        this._apply(decisions, t, { rideMs: this._introPullbackMs, silent: true });
        this._introPhase = 'pull';
        this._refreshRail();
      }
    } else if (this._introPhase === 'pull') {
      if (!this.isRiding()) this._introPhase = null;
    }
  }

  /**
   * RAILS SHY (owner 2026-09-07): when the `-` walk has already cleared every density rung, the hub bows the RAILS out too;
   * `+` (the hub), any ride, or a fresh engage brings them back. Transient view state: never persisted, never a room edit
   * (D5 capture reads pane flips, and rails are not panes). Edge chrome only; the SPECS tab + stamp are `setHudClear`.
   * With an `edgeChrome` dep the WHERE rail is not `hide()`-hidden: the chrome goes to SLEEP (`edgeChrome.sleep()`: the fade
   * starts now, `visibility:hidden` lands after it) and stays WAKEABLE, so on glass an edge touch brings the rail back from
   * level 0 (there is no `+` key on glass). Un-shy → `wake()`. The DETAIL slider needs nothing here: level 0 IS this state,
   * and it sleeps and wakes with the chrome. Without the dep: plain hide()/show().
   * @param {boolean} shy
   */
  setRailsShy(shy) {
    const want = !!shy;
    if (want === this._railsShy) return;
    this._railsShy = want;
    if (!this._engaged) return;
    if (want) {
      if (this._edgeChrome && typeof this._edgeChrome.sleep === 'function') this._edgeChrome.sleep(this._now());
      else if (this._rail && this._rail.hide) this._rail.hide();
    } else {
      if (this._edgeChrome && typeof this._edgeChrome.wake === 'function') this._edgeChrome.wake(undefined, this._now());
      else if (this._rail && this._rail.show) this._rail.show();
    }
  }

  /**
   * Owns the `pureScenery` hook exclusively: `true` hides the SPECS tab + build stamp (`body[data-pure-scenery]`), `false`
   * restores them. Density flips only (main.js calls it on every HUD_PANE_VISIBILITY); rails sleep at level 0 via
   * `setRailsShy`. Idempotent. Engaged-only: otherwise stores nothing and doesn't call the hook. The controller never calls
   * `setHudClear(true)` itself (FloorMask applies keep SPECS pinned on F1: main.js's concern).
   * @param {boolean} clear
   */
  setHudClear(clear) {
    if (!this._engaged) return;
    const want = !!clear;
    if (want === this._hudClear) return;
    this._hudClear = want;
    this._callPureScenery(want);
  }

  isHudClear() { return this._hudClear; }

  /** @private Drive the optional `{ hide(), show() }` hook; swallow throws so a broken binding cannot stall the ladder. */
  _callPureScenery(hide) {
    if (!this._pureScenery) return;
    try {
      if (hide) {
        if (typeof this._pureScenery.hide === 'function') this._pureScenery.hide();
      } else if (typeof this._pureScenery.show === 'function') {
        this._pureScenery.show();
      }
    } catch (_e) { /* hook */ }
  }

  /**
   * @private Engage / disengage / ride / floor-apply reset: tabs + stamp back, flag false. Always `show()`s (even if already
   * clear) so a floor change never leaves the tabs hidden; the next density flip re-evaluates.
   */
  _resetHudClear() {
    this._hudClear = false;
    this._callPureScenery(false);
  }

  /**
   * @private The DETAIL slider's floor rule: never on the workbench (F1 is the ship, its callouts and the SPECS drawer; the
   * WHERE rail stays: it is the way back up). Everywhere else the slider shows.
   */
  _detailSliderAllowed(floor) { return floor !== WORKBENCH_FLOOR; }

  introRidePending() { return this._introPending !== null; }

  /** @private The ONE invisible placement path for restoreView/resetView: refuse while engaged in gameplay; disengage a stale
   * engagement; settle a stale ride; place. */
  _placeWhileHidden(floor, z01) {
    if (typeof this._ladder.place !== 'function') return false;
    if (this._engaged) {
      if (this._wantEngaged()) return false;   // a live camera — never a cut
      this._disengage();                        // gameplay already ended; the next update() would do this
    }
    this._settleStaleRide();
    return !!this._ladder.place({ tMs: this._now(), floor, z01 });
  }

  /**
   * @private A core that reports `riding` while DISENGAGED can never be completed by the camera (CameraSystem.ladderDisengage
   * drops `onDone`; the headless path completes synchronously): stale by construction, so report it finished or the placement
   * is refused.
   */
  _settleStaleRide() {
    if (this._engaged) return;
    const riding = this._ladder.isRiding ? this._ladder.isRiding()
      : (this._ladder.getState && this._ladder.getState().mode === 'riding');
    if (riding && typeof this._ladder.rideFinished === 'function') {
      this._ladder.rideFinished({ tMs: this._now() });
    }
  }

  /** @private D5: export FloorMask's memory to the player store (write-on-change inside the store). */
  _persistRooms() {
    if (!this._viewStore || !this._floorMask) return;
    if (typeof this._floorMask.exportMemory !== 'function' || typeof this._viewStore.setRooms !== 'function') return;
    this._viewStore.setRooms(this._floorMask.exportMemory());
  }

  /** @private D5: (re)seed the working-position memory at an engage or floor arrival: `z01` is the rest (null when not a free
   * rest), no drive in progress. */
  _seedRest(z01) {
    this._restZ01 = isFreeRest(z01) ? z01 : null;
    this._restBeforeDrive = this._restZ01;
    this._lastMoveT = -Infinity;
    this._lastMoveDir = 0;
    this._lastPosZ01 = (typeof z01 === 'number' && Number.isFinite(z01)) ? z01 : null;
  }

  /**
   * @private D5: a free-zone `move` on the applied floor at `tMs`. A new DRIVE begins when the gap since the last free move
   * reaches GESTURE_LOCK_SILENCE_MS or the direction flips; the working position as it stood then is kept in
   * `_restBeforeDrive` so a flick growing out of this drive can roll back its ramp-up moves. Direction is measured against
   * the PREVIOUS POSITION (`_lastPosZ01`), never the rest.
   */
  _noteFreeMove(z01, tMs) {
    const silence = FloorContract.HUMP_SPRING.GESTURE_LOCK_SILENCE_MS;
    const prev = this._lastPosZ01;
    const dir = (prev == null || z01 >= prev) ? 1 : -1;
    const newDrive = !(tMs - this._lastMoveT < silence) || dir !== this._lastMoveDir;
    if (newDrive) this._restBeforeDrive = this._restZ01;
    this._restZ01 = z01;
    this._lastMoveT = tMs;
    this._lastMoveDir = dir;
  }

  /**
   * @private D5: a flick-to-wall ride at `tMs` in direction `flickDir` (+1 out / −1 in). If it grew out of the drive in
   * progress (the last free move is inside the gesture boundary AND went the same way: a flick's ramp is same-direction by
   * construction), its ramp-up moves were the leaving gesture, so the working position rolls back to before that drive. A
   * flick with no ramp (a single big event after a pause) or one that REVERSES a drive (the scroll was the player's) rolls
   * nothing back.
   */
  _rollBackDrive(tMs, flickDir) {
    const silence = FloorContract.HUMP_SPRING.GESTURE_LOCK_SILENCE_MS;
    if (Number.isFinite(this._lastMoveT) && tMs - this._lastMoveT < silence &&
        this._lastMoveDir === flickDir && this._restBeforeDrive != null) {
      this._restZ01 = this._restBeforeDrive;
    }
    this._lastMoveT = -Infinity;
    this._lastMoveDir = 0;
  }

  /**
   * @private D5 (owner decision 3): re-open the workbench pane as the player left it, at ENGAGE (the SHOP return, a continued
   * run), after `_applyFloorContent` has enabled the shell and told it the floor (open() is a no-op while disabled; setFloor
   * before any open). The ONE pane opens when EITHER stored bit is true: `library` is the live bit, `refit` a legacy one (a
   * store from before the pane merge that remembered an open REFIT drawer still re-opens the workbench). The pane's own
   * open() fires its onOpenChange edge (D10 calm cap + camera inset, as a tab click would); `_paneRestoring` keeps
   * notePaneChange from re-recording it.
   */
  _restorePanes() {
    if (!this._viewStore || typeof this._viewStore.panes !== 'function') return;
    const want = this._viewStore.panes();
    if (!want) return;
    this._paneRestoring = true;
    try {
      if ((want.refit || want.library) && this._workbench && this._workbench.open) this._workbench.open();
    } finally {
      this._paneRestoring = false;
    }
    // Converge the store to what actually stands: a legacy `{ refit: true, library: false }` is rewritten as `refit` false,
    // `library` the live bit; a shell that refused the open (disabled) records closed. Write-on-change.
    this.notePaneChange();
  }


  _engage(tMs) {
    // A ride in flight when the controller DISENGAGED (gameplay ended mid-ride) can never complete (CameraSystem.ladderDisengage
    // dropped onDone), so the core still reports `riding` at the next engage; left alone, isRiding() stays true and the frame
    // scheduler boosts to native refresh forever. Settle it FIRST: the helper is a no-op while engaged, so it must run before
    // the flag.
    this._settleStaleRide();
    // A NEW run's first engage drops the reveals of default-hidden panes BEFORE _applyFloorContent applies the room (which
    // persists the result).
    if (this._forgetRevealsPending) {
      this._forgetRevealsPending = false;
      if (this._floorMask && typeof this._floorMask.forgetReveals === 'function') this._floorMask.forgetReveals();
    }
    this._engaged = true;
    this._dz.z = null; this._dz.ease = null; this._dzNearSmall = false;   // daughter zoom: a fresh engage starts on the core's z01
    this._railsShy = false;
    this._resetHudClear();
    const s = this._ladder.getState();
    const frame = this._frame(s.floor, s.z01);
    if (this._cameraSystem && this._cameraSystem.ladderEngage) {
      this._cameraSystem.ladderEngage(frame);
    }
    // The engage position seeds the working-position memory (a restored save re-engages exactly here).
    this._seedRest(s.z01);
    this._applyFidelity(s.floor);
    this._applyFloorContent(s.floor);
    // An ENGAGE is an arrival even on the floor the last engagement left: wake the chrome and box the notch regardless.
    this._wakeFloorChrome();
    // D5: the pane as the player left it re-opens at ENGAGE (the SHOP return; a continued run), never at a ride arrival, on
    // EVERY floor (the SPECS drawer rides along, so its memory is floor-free; its REFIT block is the shell's floor-1 business).
    this._restorePanes();
    if (this._rail && this._rail.show) this._rail.show();
    this._refreshRail();
    // An ARMED intro flies now: the core was placed on the top floor while hidden; the DIVE rides to the HULL (the shot; owner
    // 2026-09-07: "you had great visuals from menu to f1") at the intro duration, silent; _introTick then breathes at the hull
    // and pulls back up to INTRO_LANDING_FLOOR where the game starts.
    if (this._introPending !== null) {
      const ms = this._introPending;
      this._introPending = null;
      const t = (tMs === undefined) ? this._now() : tMs;
      // The dive's landing z01 override: null passes the core its geometry default; 0.23 lands close on the hull (2.67 m).
      const entryZ01 = this._introEntryZ01;
      this._introEntryZ01 = null;
      const decisions = (typeof this._ladder.ceremonyRide === 'function')
        ? this._ladder.ceremonyRide({ tMs: t, toFloor: WORKBENCH_FLOOR, entryZ01 })
        : this._ladder.jump({ tMs: t, toFloor: WORKBENCH_FLOOR });
      this._apply(decisions, t, { rideMs: ms, silent: true });
      this._introPhase = 'dive';
      this._introDiveStartMs = t;
      this._refreshRail();
    }
  }

  _disengage() {
    this._engaged = false;
    this._dz.z = null; this._dz.ease = null; this._dzNearSmall = false;
    this._introPending = null;   // an arm that never engaged does not survive into a later run
    this._introPhase = null;     // nor does a mid-flyby phase (a cut mid-dwell never pulls back in a later run)
    this._introEntryZ01 = null;
    this._introDwellMs = INTRO_DWELL_MS;
    this._introDolly = null;
    this._introDwellEarly = false;
    if (this._cameraSystem && this._cameraSystem.ladderDisengage) {
      this._cameraSystem.ladderDisengage();
    }
    // Clearing the fidelity request makes SceneManager.applyTier() byte-identical to the shipped path (no re-assertion).
    if (this._sceneManager && this._sceneManager.setLadderFloorFidelity) {
      this._sceneManager.setLadderFloorFidelity(null);
    }
    if (this._navcom && this._navcom.deactivate) this._navcom.deactivate();
    if (this._proxNet && this._proxNet.deactivate) this._proxNet.deactivate();
    if (this._sdaFloor && this._sdaFloor.deactivate) this._sdaFloor.deactivate();
    if (this._hullcam && this._hullcam.deactivate) this._hullcam.deactivate();
    // The ONE workbench pane closes with the ladder: setEnabled(false) shuts it (its close() fires the D10 open-signal false
    // edge), disables both hosted engines and hides the tab. The ONE place it is disabled.
    if (this._workbench && this._workbench.setEnabled) this._workbench.setEnabled(false);
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(null);
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(null);
    // setFloor(null) captured the departing floor's live room into the mask's memory: export it now (write-on-change; never per frame).
    this._persistRooms();
    // Clear transient gesture state (ratchet step / armed undo window) so a re-engage starts clean.
    if (this._sfx && this._sfx.reset) this._sfx.reset();
    // Restore the reticles the icon floors hid. On a disengage by LEAVING gameplay the restore resolves to hidden, matching
    // TargetReticle's own GAME_STATE_CHANGE rule (see _setReticlesHidden).
    this._setReticlesHidden(false);
    this._setConstellationsHidden(false);
    // Clear the city/landmark-pill suppression (the 5-key preference decides whether the pills reappear).
    this._setCityLabelsHidden(false);
    if (this._rail && this._rail.hide) this._rail.hide();
    if (this._detailSlider && typeof this._detailSlider.setShown === 'function') this._detailSlider.setShown(false);
    // Leaving gameplay clears hud-clear too: it is a view state of the ENGAGED ladder only (Ipad.md §2.5: build stamp / tabs
    // hidden ONLY inside the transient HUD-clear view).
    this._resetHudClear();
  }


  _apply(decisions, tMs, opts = null) {
    // The intro ride overrides the ride duration and mutes the sfx (`{ rideMs, silent }`); every other caller passes nothing.
    const rideOverride = (opts && Number.isFinite(opts.rideMs) && opts.rideMs > 0) ? opts.rideMs : null;
    const silent = !!(opts && opts.silent);
    for (const d of decisions) {
      switch (d.type) {
        case 'move':
        case 'settle':
          if (this._cameraSystem && this._cameraSystem.ladderSetTarget) {
            this._cameraSystem.ladderSetTarget(this._frame(d.floor, d.z01));
          }
          // D5 working-position memory: only a free-zone move on the applied floor counts. Wall creep (move.inWall), the
          // settle-back to an edge and the framing glide (move.glide, not the player's drive) never do; all of them are the
          // PREVIOUS POSITION for the next move's direction, so _lastPosZ01 follows them all.
          if (d.type === 'move' && !d.inWall && !d.glide && d.floor === this._floorApplied && isFreeRest(d.z01)) {
            this._noteFreeMove(d.z01, tMs);
          }
          this._lastPosZ01 = d.z01;
          break;

        case 'cross':
          // 00-spec §4: the clunk derives from cross.direction ('out' ↑ / 'in' ↓). The intro's `silent` / `rideMs` reach
          // here too (latent: the ceremony decision is always a 'ride').
          if (!silent && this._sfx && this._sfx.onCross) this._sfx.onCross(d.direction);
          this._startRide(d.toFloor, d.entryZ01, rideOverride !== null ? rideOverride : CROSS_RIDE_MS, tMs, true);
          break;

        case 'ride':
          // G3 flick-to-wall soft tick (LadderSfx only sounds kind 'flickWall').
          if (!silent && this._sfx && this._sfx.onRide) this._sfx.onRide(d.kind);
          // The ceremony ride is a crossing in all but name (CROSS_RIDE_MS, lands on a new floor): it gets the descending clunk too.
          if (!silent && d.kind === 'ceremony' && this._sfx && this._sfx.onCross) this._sfx.onCross('in');
          // A flick-to-wall ride ends the drive whose ramp-up moves just landed: roll the working position back. The flick's
          // direction is the wall it landed on (lower edge = in).
          if (d.kind === 'flickWall') this._rollBackDrive(tMs, d.entryZ01 <= 0.5 ? -1 : 1);
          this._startRide(d.toFloor, d.entryZ01,
            rideOverride !== null ? rideOverride : (d.miniMs != null ? d.miniMs : CROSS_RIDE_MS), tMs);
          break;

        case 'denied':
          // Pass the BLOCKED floor too so the rail can flash its notch (hint from FloorContract humps.deniedHint, or null at
          // the ladder ends).
          if (this._rail && this._rail.flashDenied) this._rail.flashDenied(d.hint || null, d.floor);
          break;

        case 'verb':
          this._dispatchVerb(d.verb);
          break;

        // charge → rail fill (handled by _refreshRail) + the ratchet ticks (06-core-api: ratchet derives from charge).
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
   * @private Start a camera ride to (toFloor, entryZ01). The core has already advanced to the destination and is `riding`
   * until rideFinished(); the destination floor's render block is swapped immediately and completion is reported via a
   * callback. Each start claims a fresh ride token: a superseded ride's onDone (replaced mid-flight by a flick upgrade /
   * reversal / undo) is dropped instead of delivering a STALE rideFinished.
   */
  _startRide(toFloor, entryZ01, rideMs, tMs, isCross) {
    this._dz.z = null;      // a ride starts from where the camera is; the deep position is spent
    this._dz.ease = null;
    this._dzNearSmall = false;   // (this ride's _applyFidelity pushes the destination floor's own near plane)
    // The ORIGIN floor, read BEFORE the destination's content lands below.
    const fromFloor = this._floorApplied;
    if (toFloor !== fromFloor) {
      // A floor change re-seeds the working position from the arrival entry (0.25 / 0.75, always a free rest). A same-floor
      // flickWall ride lands on a wall EDGE and leaves the memory alone (_rollBackDrive already discounted its ramp-up).
      this._seedRest(entryZ01);
    }
    // Every ride lands the core at entryZ01: the previous position for the next free move's direction (flickWall too).
    this._lastPosZ01 = entryZ01;
    // A RIDE wakes the WHERE rail (the floor content below wakes everything on a floor change; a same-floor flickWall ride
    // still lights the rail being pushed against).
    if (this._edgeChrome && typeof this._edgeChrome.wake === 'function') this._edgeChrome.wake('rail', tMs !== undefined ? tMs : this._now());
    this._applyFidelity(toFloor);
    this._applyFloorContent(toFloor);
    const frame = this._frame(toFloor, entryZ01);
    const seq = ++this._rideSeq;
    const done = (viaCamera = true) => {
      if (seq !== this._rideSeq) return;   // superseded — the new ride owns completion
      const t = this._now();
      this._ladder.rideFinished({ tMs: t });
      // A landing on floor 4 (the framing turn and zoom glide start there): the gesture that started the ride may still be
      // coasting (see wheel()). Floor 4 only: on the ship floors a steady push legitimately goes on across a crossing
      // (test-DaughterZoomFloor: a piloted daughter's zoom from floor 3 down to her limit) and would stall until a 200 ms pause.
      if (viaCamera && toFloor === 4) this._rideTailArmed = true;
      // A completed CROSS arms the 800 ms FLICK_UNDO_WINDOW ("↶" undo chime). Superseded rides never arm (seq guard above).
      if (isCross && this._sfx && this._sfx.onUndoWindow) this._sfx.onUndoWindow(true);
      this._refreshRail();
    };
    if (this._cameraSystem && this._cameraSystem.ladderStartRide) {
      this._cameraSystem.ladderStartRide({ ...frame, rideMs, onDone: done });
    } else {
      // No camera (headless without a ride engine): complete synchronously so the core never wedges in `riding`.
      done(false);
    }
  }

  /** Push a floor's fidelity block to SceneManager (T1). `nearOverride` (daughter zoom) replaces the floor's near plane. @private */
  _applyFidelity(floor, nearOverride) {
    if (!this._sceneManager || !this._sceneManager.setLadderFloorFidelity) return;
    const f = FloorContract.byId(floor);
    if (!f) return;
    this._sceneManager.setLadderFloorFidelity({
      nearField: f.fidelity.nearField,
      near: nearOverride != null ? nearOverride : f.camera.near,
      far: f.camera.far,
      debrisMode: f.fidelity.debrisMode,
      floor,
    });
  }

  /**
   * @private Consume the arrival floor's `fidelity.debrisMode` to drive the floor content controllers: F4 'clusters' → the
   * NAVCOM cluster-icon + transfer-window costume; F3 'tactical' → the PROX NET corridor costume; F5 'massBands' → the SDA
   * chart (and hides the constellation figures under it); F1 (HULL CAM) keys on the floor ID, since its debrisMode 'full'
   * is shared with F2. Every other floor deactivates each. Also gates the aiming reticles on the icon floors (>= 4). Every
   * dep is optional; absent deps make each part a no-op.
   */
  _applyFloorContent(floor) {
    // A FLOOR CHANGE is a wake source: record the arrival before the origin-floor record below is overwritten.
    const floorChanged = (this._floorApplied !== floor);
    this._floorApplied = floor;
    // Reticle gating: the target + docking reticles aim at subjects that are icons at Earth-anchored ranges, so both hide
    // while the engaged floor is >= 4 and restore on floors <= 3 (and on disengage). Keyed on the floor number, not
    // debrisMode (F5 'massBands' must suppress too); independent of the content deps so the reticle deps work standalone.
    this._setReticlesHidden(floor >= 4);
    const f = FloorContract.byId(floor);
    if (this._navcom) {
      const clusters = !!(f && f.fidelity && f.fidelity.debrisMode === 'clusters');
      if (clusters) {
        if (this._navcom.activate) this._navcom.activate();
      } else if (this._navcom.deactivate) {
        this._navcom.deactivate();
      }
    }
    if (this._proxNet) {
      const tactical = !!(f && f.fidelity && f.fidelity.debrisMode === 'tactical');
      if (tactical) {
        if (this._proxNet.activate) this._proxNet.activate();
      } else if (this._proxNet.deactivate) {
        this._proxNet.deactivate();
      }
    }
    // F5 (SDA): 'massBands' drives the full-screen chart; the constellation figures hide under it (screen-space chart: the
    // star figures would read as chart strokes) and restore on any other floor / disengage. Hidden on F1 too (HULL CAM,
    // owner 2026-09-16: "the focus is on Mother").
    const massBands = !!(f && f.fidelity && f.fidelity.debrisMode === 'massBands');
    if (this._sdaFloor) {
      if (massBands) {
        if (this._sdaFloor.activate) this._sdaFloor.activate();
      } else if (this._sdaFloor.deactivate) {
        this._sdaFloor.deactivate();
      }
    }
    this._setConstellationsHidden(massBands || floor === 1);
    // City/landmark pills hide on F5 AND on F1 (owner 2026-09-02, the map rule, 08-workbench D8: "house numbers up close,
    // city names far out, never both"): at the hull Earth is a backdrop 2–7 m behind the ship and the pills would land among
    // the hull callout cards. F1 is keyed on FLOOR ID (debrisMode is 'full' on both F1 and F2); F2 keeps the shipped pills
    // (the player's 5-key choice). Same transient gate, restore on leave/disengage; F3/F4 untouched.
    this._setCityLabelsHidden(massBands || floor === 1);
    // F1 (HULL CAM): keyed on FLOOR ID 1, NOT fidelity.debrisMode ('full' on both F1 and F2).
    if (this._hullcam) {
      if (floor === 1) { if (this._hullcam.activate) this._hullcam.activate(); }
      else if (this._hullcam.deactivate) this._hullcam.deactivate();
    }
    // The ONE workbench pane (SPECS + the F1 REFIT block; drawer left on every floor, DECISIONS §13 row 5; gestures follow
    // it, row 6). Enabled on EVERY floor: an open pane RIDES ALONG (the world stays held under it; the camera inset bias
    // applies on every floor); only _disengage disables it. Then the floor, at EVERY apply and BEFORE any open (the restore
    // at engage, the WORKBENCH_STOP open): the shell shows the REFIT block on floor 1 only (off F1 it hides the block and
    // clears the alternative-hover ghosting) and pins the tab awake on F1 only (elsewhere the tab is EDGE CHROME in the
    // footer band, following the hub's per-frame EdgeChrome phase while closed; an open pane's tab is awake on every
    // floor). The floor rule lives here, in the floor content, not in the shell. Duck-typed: both calls optional.
    if (this._workbench) {
      if (this._workbench.setEnabled) this._workbench.setEnabled(true);
      if (this._workbench.setFloor) this._workbench.setFloor(floor);
    }
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(floor);
    // Per-floor HUD pane mask (08-workbench D8/§4 map rule): apply the arrival floor's room LAST, after every floor system
    // above has landed, so the destination panes fade in with the ride (runs on _engage and every _startRide start).
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(floor);
    // The mask just captured the departing floor's room: export it to the player store (write-on-change).
    this._persistRooms();
    // The DETAIL slider's floor rule (hidden on the workbench, shown elsewhere); its thumb follows the applied room through
    // the hub's pane-visibility edge, its opacity is EdgeChrome's.
    if (this._detailSlider && typeof this._detailSlider.setShown === 'function') {
      this._detailSlider.setShown(this._detailSliderAllowed(floor));
    }
    // Riding the ladder ends rails-shy: the rails come back with the floor content.
    if (this._railsShy) this.setRailsShy(false);
    // A floor change / ride never leaves the tabs hidden; the next density flip re-evaluates via setHudClear.
    this.setHudClear(false);
    // The floor changed → all edge chrome wakes and the arrival notch wears the BOX for BOX_MS (the WHERE rail paints it from
    // `isBoxed('floor')`). `_engage` fires the same wake unconditionally (a re-engage on the same floor is still an arrival).
    if (floorChanged) this._wakeFloorChrome();
    // The floor's SUBJECT changed: the hub retargets an open SPECS pane (never opens one; SpecsSubject decides what).
    this._noteSubjectChange(floor);
  }

  /** @private The FLOOR wake: all edge chrome awake for IDLE_FADE_MS, the arrival notch boxed. Absent dep → no-op. */
  _wakeFloorChrome() {
    const ec = this._edgeChrome;
    if (!ec) return;
    const t = this._now();
    if (typeof ec.wake === 'function') ec.wake(undefined, t);
    if (typeof ec.box === 'function') ec.box('floor', t);
  }

  /** @private Fire the optional subject hook, never throw. */
  _noteSubjectChange(floor) {
    if (!this._onSubjectChange) return;
    try { this._onSubjectChange(floor); } catch (_e) { /* dep */ }
  }

  /**
   * @private Hide/restore the aiming reticles for the ship-is-icon floors (F4/F5). Idempotent (guarded on the flag flip);
   * absent deps make it a pure flag write.
   * Hide: setVisible(false) on both.
   * Restore: TargetReticle mirrors its own GAME_STATE_CHANGE rule (visible exactly when gameplay), so a mid-gameplay floor
   * change restores it and a disengage-by-leaving-gameplay keeps it hidden.
   * DockingReticle is deliberately NOT force-shown: the main.js ARM PILOT block owns it PER FRAME and re-shows it the moment
   * reticlesSuppressed() clears; forcing it here could flash it for a frame outside ARM_PILOT mode.
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
   * @private Hide/restore the constellation figures for the F5 SDA chart and the F1 hull floor (mirror of
   * _setReticlesHidden). Idempotent; the starfield dep is optional.
   * Hide: capture the player's current 6-key visibility ONCE into _constellationsPrior, then setConstellationsVisible(false).
   * Restore: put back the captured prior and null it: the player's 6-key toggle owns the resting state, so F5/F1 never
   * force-show figures the player had off (nor strand them hidden after leaving).
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
   * @private Suppress/clear the Earth city + landmark pills for the F5 SDA chart and the F1 hull floor (map rule: never city
   * names among house numbers); mirror of _setReticlesHidden. Idempotent; the cityLabels dep is optional.
   * No prior capture needed: CityLabels.setSuppressed is a TRANSIENT gate orthogonal to the persisted 5-key preference
   * (`visible && !suppressed` shows a layer; suppression never writes localStorage), so clearing it restores exactly the
   * player's resting state. setVisible() would persist and is deliberately NOT used here.
   */
  _setCityLabelsHidden(hidden) {
    if (hidden === this._cityLabelsHidden) return;
    this._cityLabelsHidden = hidden;
    if (this._cityLabels && this._cityLabels.setSuppressed) {
      this._cityLabels.setSuppressed(hidden);
    }
  }

  /**
   * @private Dispatch a per-floor Space verb decision (FloorContract spaceVerb): F4 'plan-transfer', F3 'approach', F5
   * 'flip-lens', F1 'lens-toggle', F2 'approach-autopilot' (the `A` path: AutopilotSystem.toggle() resolves the selected
   * target itself and re-acquires the best one when none is selected; a second press disengages, like the key). The two
   * verbs that change the floor's SUBJECT (the lens flip, the plan) fire the subject hook afterwards so an open SPECS pane
   * follows.
   */
  _dispatchVerb(verb) {
    // While the "where next" list is open Space picks its focused row; planning a transfer to a cluster waits (the FLY THERE
    // chip's tap is this same Space).
    if (verb === 'plan-transfer' && this._navcom && typeof this._navcom.choosing === 'function' && this._navcom.choosing()) {
      this._navcom.choicePick();
      return;
    }
    if (verb === 'plan-transfer' && this._navcom && this._navcom.planTransfer) {
      this._navcom.planTransfer();
      this._noteSubjectChange(4);
    }
    // F3: commit the selected insertion point (ProxNetFloor.approach() → onApproach → autopilot).
    if (verb === 'approach' && this._proxNet && this._proxNet.approach) {
      this._proxNet.approach();
    }
    // F2: autopilot to the selected target via the injected AutopilotSystem: the same toggle() the A key calls (InputManager
    // KeyA), so target resolution, re-acquire and disengage-on-second-press are the shipped ones.
    if (verb === 'approach-autopilot' && this._autopilot && typeof this._autopilot.toggle === 'function') {
      this._autopilot.toggle();
    }
    if (verb === 'flip-lens' && this._sdaFloor && this._sdaFloor.flipLens) {
      this._sdaFloor.flipLens();
      this._noteSubjectChange(5);
    }
    // F1: the workbench pane claims it when injected (owner 2026-09-03: "Space toggles the REFIT pane"; the REFIT block lives
    // inside the ONE pane, so Space toggles that pane). FloorContract's verb string stays 'lens-toggle'. main.js injects the
    // workbench; the hullcam branch below is the pane-less fallback and HULLCAM is deliberately not injected (owner
    // 2026-09-02), so with neither dep the verb is a silent no-op.
    if (verb === 'lens-toggle') {
      if (this._workbench && this._workbench.toggle) {
        this._workbench.toggle();
      } else if (this._hullcam && this._hullcam.lensToggle) {
        this._hullcam.lensToggle();
      }
    }
  }

  /**
   * @private Resolve a (floor, z01) into a camera frame: distance from anchor, FOV, anchor kind. F1's 'subject' anchor maps
   * to 'ship'; the F4/F5 'earth' anchor lets the ride engine aim Earth-fixed.
   */
  _frame(floor, z01) {
    const f = FloorContract.byId(floor);
    let distU = distanceFromZ01(f, z01);
    if (this._dz.z != null && floor === FloorContract.DAUGHTER_ZOOM.FLOOR) {
      // daughter zoom: the deep position, the floor's own log scale carried on below its wall zone
      const [lo, hi] = f.camera.rangeLog10;
      distU = Math.pow(10, lo + this._dz.z * (hi - lo));
    }
    const anchor = (f.anchor === 'earth') ? 'earth' : 'ship';
    const fov = (f.camera.fov != null) ? f.camera.fov : Constants.CAMERA_FOV;
    return { distU, fov, anchor, floor, z01 };
  }

  _refreshRail() {
    if (this._rail && this._rail.refresh) this._rail.refresh(this._ladder.getState());
  }
}
