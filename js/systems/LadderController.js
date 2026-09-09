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
 * Wave 5 Session H (the 7→5 renumber, plan D-A/D-B): the ladder is FIVE floors,
 * ids 1..5 — 1 HULL CAM (the workbench: REFIT/LIBRARY panes, callouts), 2
 * COMMAND (the shipped flying view), 3 PROX NET, 4 NAVCOM, 5 SDA DOWNLINK. The
 * old F1 ARCHIVE and F2 DEPOT interior rows are deleted: the Tech Library is
 * the pane + the full-screen reader, the shop is the REFIT drawer's job, and
 * the Session E doorway (`_enterDepot`) retired with its floor — the SHOP
 * GameState still arrives through GameFlowManager's own transitions (mission
 * boundaries, the B key), never through a ladder ride.
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
 * Wave 5 Session N (plan "Session N — Onboarding for glass + intro", item 2;
 * 08-workbench §8 Q6 "the intro ride ends on the ship close-up for mission
 * 1"): the INTRO RIDE's duration — one continuous descent from the TOP floor
 * to the workbench at the first engage of a first-time player's new game.
 * Longer than a crossing (550) because it spans the whole ladder and is the
 * one ride that is watched, not commanded; short enough that the workbench's
 * first beat (the MAP pane) is on screen within three seconds of START. A
 * controller ride number like CROSS_RIDE_MS (01-numbers "Session N").
 */
export const INTRO_RIDE_MS = 2400;

/**
 * Session N.5b (owner 2026-09-07): the intro FLYBY's two follow-up numbers —
 * the breath at the hull after the dive lands, and the silent pull-back ride
 * up to INTRO_LANDING_FLOOR. The dive keeps INTRO_RIDE_MS.
 */
export const INTRO_DWELL_MS = 800;
export const INTRO_PULLBACK_MS = 800;

/**
 * Wave 5 Session K: the WORKBENCH floor — where the REFIT drawer (the one
 * shop) lives; the same floor id `_applyFloorContent` keys the REFIT tab on.
 * An id, never a name (FloorContract owns the player labels).
 */
const WORKBENCH_FLOOR = 1;

/**
 * Session N.5 (owner 2026-09-07): where the FIRST-RUN intro ride LANDS — the
 * flying floor, not the workbench. "First make me care": a new player starts
 * where the game is played, with the TOUCH MAP checklist beside them; the
 * workbench (its 28 callouts, the REFIT shop, the specs) waits until the
 * first mission break rides them down (WORKBENCH_STOP opens REFIT itself,
 * which ticks the checklist's REFIT row without a swipe). An id, never a
 * name (FloorContract owns the player labels).
 */
const INTRO_LANDING_FLOOR = 2;

/**
 * D5 (Wave 5 Session G): is `z01` a FREE-zone rest on a floor — strictly
 * between the two wall edges (`WALL_ZONE_FRAC` … 1 − `WALL_ZONE_FRAC`)? The
 * controller remembers the last such position per applied floor as the
 * player's WORKING position (`_restZ01`): the wall edges themselves (a
 * flick-to-wall landing, a settle-back) and the creep inside a band are the
 * GESTURE of leaving a floor, not a place the player was working (02-traps T6:
 * re-entering a floor must not resume inside the wall band). Since the Session
 * H doorway retirement nothing reads it — kept for the Session N intro-ride
 * landing (03-plan Session H FINDINGS).
 * @param {number} z01
 * @returns {boolean}
 */
function isFreeRest(z01) {
  const w = FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC;
  return typeof z01 === 'number' && Number.isFinite(z01) && z01 > w && z01 < 1 - w;
}

/**
 * G1 (post-M3): runtime-adapt holdoff window after the last ladder input.
 * DERIVED, not a new tunable: RIDE_MAX_MS (650, VisualLaw.TIMINGS) +
 * SETTLE_IDLE_MS (250, FloorContract.HUMP_SPRING) = 900 ms — the longest a
 * single wheel event can still be driving camera motion (a triggered ride)
 * plus the gesture-settle tail. See docs/ladder/01-numbers.md §"Post-M3 glue".
 */
const ADAPT_HOLDOFF_MS =
  VisualLaw.TIMINGS.RIDE_MAX_MS + FloorContract.HUMP_SPRING.SETTLE_IDLE_MS;

/**
 * Session I (plan D-F, the TURNTABLE): held-arrow orbit rate, expressed as
 * pointer-equivalent px per second so the camera's ONE drag feel applies
 * (CameraSystem drag.rotateSpeed 0.005 rad/px → 240 px/s ≈ 1.2 rad/s ≈ 69°/s
 * steady yaw, frame-rate independent — the nudge is dt-scaled). Own-module
 * tunable (house rule); the owner tunes the number at a picture gate.
 */
const ARROW_TURN_PX_PER_S = 240;

export class LadderController {
  /**
   * @param {object} deps
   * @param {object} [deps.cameraSystem] - ride engine: ladderEngage/ladderDisengage/
   *   ladderSetTarget/ladderStartRide (all optional)
   * @param {object} [deps.sceneManager] - per-floor render block: setLadderFloorFidelity(fid|null)
   * @param {object} [deps.gameState]    - isGameplay() gate
   * @param {object} [deps.rail]         - rail indicator: show/hide/refresh(state)/flashDenied(hint, floor)
   * @param {object} [deps.navcom]       - F4 (NAVCOM) content controller (NavcomFloor):
   *   activate/deactivate/isActive/update/planTransfer. Optional — no-op without it.
   * @param {object} [deps.proxNet]      - F3 (PROX NET) content controller (ProxNetFloor):
   *   activate/deactivate/isActive/update/approach. Optional — no-op without it.
   * @param {object} [deps.sdaFloor]     - F5 (SDA) content controller (SdaFloor):
   *   activate/deactivate/isActive/update/flipLens. Optional — no-op without it.
   * @param {object} [deps.hullcam]      - F1 (HULL CAM) content controller (HullCamFloor):
   *   activate/deactivate/isActive/update/lensToggle. Optional — no-op without it.
   * @param {object} [deps.refit]        - F1 REFIT pane (RefitPane, Wave 5 (2)):
   *   setEnabled/open/close/toggle/isOpen. Optional — no-op without it. Floor-keyed
   *   like hullcam (F1's debrisMode 'full' is shared with F2): arriving on floor 1
   *   enables the edge tab, any other floor disables AND closes the pane, disengage
   *   closes it too. When present it claims the F1 'lens-toggle' Space verb
   *   (toggle()) — D-b, owner 2026-09-03; absent, the verb falls through to the
   *   hullcam branch exactly as shipped.
   * @param {object} [deps.library]      - the SPECS pane (LibraryPane, Wave 5
   *   Session B; player name SPECS since plan D-C): setEnabled/open/close/
   *   toggle/isOpen/openEntry. Optional — no-op without it. **Session J (D-C):
   *   enabled on EVERY floor** — arrival on any floor enables the edge tab and
   *   an open pane stays open across a ride (the world stays held, D-F); only
   *   disengage disables + closes it. It claims NO Space verb (D-b keeps
   *   Space = REFIT on floor 1); Esc reaches it first through closeTopPane() —
   *   the LIBRARY is the TOPMOST workbench pane (it opens FROM the REFIT card,
   *   08-workbench §3, so it is the most recently opened in the one flow that
   *   opens both; with both open Library-closes-first is the documented
   *   order). Session C: both panes also page from the horizontal two-finger
   *   swipe — WheelRouter asks `wantsPaneSwipe()` and emits ONE
   *   `pagePane({toward})` per flick; the carousel law lives there (floor 1:
   *   [REFIT] — [ship] — [SPECS]; every other floor: [view] — [SPECS]).
   * @param {function} [deps.onSubjectChange] - Session J (D-C, "the library
   *   follows"): called with the floor id after every floor ARRIVAL
   *   (_applyFloorContent) and after a subject-changing Space verb (the SDA
   *   lens flip, the NAVCOM plan) so the hub can retarget an OPEN SPECS pane
   *   through its ONE `openEntry` path (SpecsSubject resolves what). Optional.
   * @param {object} [deps.autopilot]    - AutopilotSystem: toggle(). Session J
   *   item 6 — floor 2's declared Space verb 'approach-autopilot' (a no-op
   *   since S4) is the `A` path: autopilot to the selected target. Optional.
   * @param {object} [deps.detailSlider] - Session P (plan D5): the DETAIL slider
   *   (js/ui/DetailSlider.js — the DISPLAY rail's successor in the left slot):
   *   `setShown(on)`. Shown on every floor but the workbench (F1 has the
   *   REFIT tab in that slot), hidden at disengage. Its edge-chrome phase is
   *   the hub's per-frame write, not the controller's. Duck-typed, optional.
   * @param {object} [deps.edgeChrome]   - Session P (plan D2/D3, owner 2026-09-07):
   *   the EDGE-CHROME core (js/ui/EdgeChrome.js — pure timestamps: wake(member?)
   *   / box(name) / sleep()). Duck-typed, optional. The controller is the wake
   *   source for FLOOR events: every floor apply wakes all chrome and boxes the
   *   arrival notch ('floor'); a ride start wakes the rail; rails-shy
   *   (`setRailsShy(true)`) puts the chrome to SLEEP instead of hiding the
   *   WHERE rail (asleep is wakeable — an edge touch is the way back on
   *   glass); un-shy wakes it. SPECS/REFIT tabs + stamp are `setHudClear`,
   *   not this. Absent → the Session N.5 hide()/show() path exactly
   *   (flag-off / older rigs).
   * @param {object} [deps.audioBeds]    - per-floor audio beds (LadderAudioBeds):
   *   setFloor(floorId|null). Optional — absent it beds are a no-op.
   * @param {object} [deps.floorMask]    - per-floor HUD pane mask (FloorMask,
   *   08-workbench D8/§4): setFloor(floorId|null). Optional — absent it the
   *   mask is a no-op (shipped cockpit byte-identical). With a `viewStore` its
   *   D5 memory is imported at construction and exported on every floor change.
   * @param {object} [deps.viewStore]    - the PLAYER-owned view store
   *   (LadderViewStore, Wave 5 Session G — D5 persistence): rooms()/setRooms()
   *   round-trip FloorMask's exportMemory/importMemory; panes()/setPanes() hold
   *   the F1 workbench pane open-state, written on the panes' open/close edge
   *   (main.js's ONE `_syncWorkbenchPanes` edge calls `notePaneChange()`) while
   *   engaged on F1, and re-applied at ENGAGE on F1 (the SHOP return, a
   *   continued run) — "the room as you left it". Optional — absent it rooms
   *   stay in-memory (FloorMask) and the panes close as shipped. main.js
   *   constructs it only inside the LADDER.ENABLED gate (flag-off: never read
   *   or written).
   * @param {object} [deps.sfx]          - interaction sfx (LadderSfx): onCharge/
   *   onCross/onRide/onUndoWindow/reset. Optional — absent it sfx are a no-op.
   * @param {object} [deps.starfield]    - Starfield: isConstellationsVisible()/
   *   setConstellationsVisible(bool). Optional — F5 hides the constellation figures
   *   under the full-screen SDA chart and restores the player's prior on leave.
   * @param {object} [deps.cityLabels]   - CityLabels: setSuppressed(bool). Optional —
   *   F5 suppresses the city/landmark pills under the SDA chart (they read as
   *   clutter over the altitude bands) and F1 suppresses them at the hull (the
   *   map rule, D8 — city names never among house numbers; 2026-09-02 evening).
   *   Suppression is transient by contract (CityLabels.setSuppressed never
   *   persists), so the player's 5-key preference owns the resting state on
   *   leave/disengage.
   * @param {object} [deps.targetReticle]  - TargetReticle: setVisible(bool). Optional —
   *   suppressed on the ship-is-icon floors (F4/F5), restored on floors <= 3 / disengage.
   * @param {object} [deps.dockingReticle] - DockingReticle: setVisible(bool). Optional —
   *   same F4/F5 suppression; its re-show is owned per-frame by main.js's ARM PILOT
   *   block, which consults reticlesSuppressed().
   * @param {function} [deps.now]        - monotonic clock (ms); defaults to performance.now
   * @param {object} [deps.inputKeys]    - InputManager's PUBLIC `keys` map (Session I
   *   turntable: held arrows → camera drag nudge while a drawer is open on floor 1)
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
    this._refit = deps.refit || null;
    this._library = deps.library || null;
    // Session J (D-C / item 6): the subject-change hook, the autopilot for
    // floor 2's Space verb. All optional (parallel tracks).
    this._onSubjectChange = (typeof deps.onSubjectChange === 'function') ? deps.onSubjectChange : null;
    this._autopilot = deps.autopilot || null;
    // Session P (plan D5): the DETAIL slider (the DISPLAY rail's `paneRail` dep
    // retired with the rail) — nullable, duck-typed: setShown(on).
    this._detailSlider = deps.detailSlider || null;
    // Session P (plan D2/D3): the edge-chrome core — nullable, duck-typed.
    this._edgeChrome = deps.edgeChrome || null;
    /**
     * HUD-clear / pure scenery (rev-3 ladder, plan 1788867799156 #4; was
     * plan D7): an optional `{ hide(), show() }` hook the hub binds to
     * `body[data-pure-scenery]` (index.html hides the SPECS/REFIT tabs and
     * #build-stamp under it). Owned exclusively by `setHudClear` — density
     * flips, never rails. Duck-typed; absent = no-op.
     */
    this._pureScenery = deps.pureScenery || null;
    this._audioBeds = deps.audioBeds || null;
    this._floorMask = deps.floorMask || null;
    this._viewStore = deps.viewStore || null;
    this._sfx = deps.sfx || null;
    this._starfield = deps.starfield || null;
    this._cityLabels = deps.cityLabels || null;
    this._targetReticle = deps.targetReticle || null;
    this._dockingReticle = deps.dockingReticle || null;
    // Session I (plan D-F, the TURNTABLE): the PUBLIC key-state map
    // (inputManager.keys — the D-I grammar; InputManager itself is never
    // edited). While a drawer is open on the workbench floor, held arrows are
    // read here each update and mapped to CameraSystem.ladderDragNudge — the
    // camera orbits the ship, never the ship itself (main.js blanks the
    // arrows around processInput for the same window). Absent ⇒ no turntable
    // arrows (pointer drag still works through the camera's own gate).
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
    // The DEFAULT core (the production path — main.js injects no ladder) still
    // forwards the dev-phase full-access flag: Constants.LADDER.DEV_FULL_ACCESS
    // (ships true until M6 campaign gating; 00-spec §9). INERT since the
    // Session H renumber — the F2 dock gate it bypassed left with that row —
    // but the wire keeps its pinned shape (03-plan Session H FINDINGS).
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
    /**
     * The floor whose content is on screen (written by _applyFloorContent at
     * engage and at every ride START) — the ORIGIN floor of the next ride.
     * null until the first engage.
     */
    this._floorApplied = null;
    /**
     * Session N: the armed intro ride's duration (ms) — set by armIntroRide()
     * before the first engage of a first-time player's new game, consumed by
     * _engage() (the ride starts the moment the ladder owns the screen),
     * cleared by disarmIntroRide() (a CONTINUE restores a saved view instead).
     */
    this._introPending = null;
    /**
     * Session N.5 (owner 2026-09-07): RAILS SHY — true after a `-` press
     * found the density rungs already clear and bowed the RAILS out too.
     * Transient view state: never persisted, never a room edit; any `+`,
     * ride, or fresh engage drops it (setRailsShy). SPECS/REFIT tabs +
     * stamp are `_hudClear` / `setHudClear`, not this.
     */
    this._railsShy = false;
    /**
     * Rev-3 ladder (plan 1788867799156 #4): true while `setHudClear(true)`
     * has hidden the SPECS/REFIT tabs + build stamp. Engaged-only; a
     * fresh engage, disengage, ride, or floor apply resets it.
     */
    this._hudClear = false;
    /**
     * Session N.5b: the intro FLYBY phase — null | 'dive' | 'dwell' | 'pull'.
     * Set by _engage when it flies an armed dive; advanced by _introTick;
     * cleared by landing, player input after the dive started, or disengage.
     */
    this._introPhase = null;
    this._introDwellUntil = null;
    this._introDiveStartMs = null;
    /**
     * D5 (Wave 5 Session G): the last FREE-zone rest z01 on the applied floor —
     * the player's working position (see `isFreeRest`). Seeded at engage and
     * at every floor ARRIVAL from the entry z01, advanced by every free `move`
     * decision, untouched by flick-to-wall landings / settles / creep. Its one
     * reader (the doorway park) retired with the Session H renumber — kept for
     * the Session N intro-ride landing (03-plan Session H FINDINGS).
     */
    this._restZ01 = null;
    /**
     * D5: the working position as it stood BEFORE the current wheel drive (a
     * same-direction run of free moves with gaps < GESTURE_LOCK_SILENCE_MS —
     * the core's own gesture boundary). A flick's driven phase emits a few
     * free `move`s before the detector fires (the accumulation ramp), and
     * those are part of the LEAVING gesture, not a place the player worked:
     * when the drive ends in a flick-to-wall ride, `_restZ01` rolls back to
     * this (the doorway witness: 0.75 → ramp 0.68 → flick → the return lands
     * at 0.75). `_lastMoveT` / `_lastMoveDir` delimit the drive.
     */
    this._restBeforeDrive = null;
    this._lastMoveT = -Infinity;
    this._lastMoveDir = 0;
    /**
     * The core's z01 as the controller last saw it (every move incl. wall
     * creep, every settle, every ride landing, the engage/arrival seed) — the
     * PREVIOUS POSITION a free move's direction is measured against. Never the
     * rest: after a rollback the rest is the pre-gesture value, and measuring
     * against it mis-signs the first move of the next opposite drive (review
     * finding, 2026-09-04 — the doorway return parked at a ramp position).
     */
    this._lastPosZ01 = null;
    /** True while `_restorePanes` drives the panes itself (its edges are not player intent). */
    this._paneRestoring = false;
    /**
     * D5: the shipped initial view, captured from the core at construction —
     * `resetView()` (GAME_RESET) places the core back here so a NEW run starts
     * on the shipped floor (the intro ride as shipped), whatever floor the last
     * run ended on. The player's rooms (FloorMask memory / the view store) are
     * NOT touched by a reset — they belong to the player, not the run.
     */
    const s0 = (this._ladder && this._ladder.getState) ? this._ladder.getState() : null;
    this._initialView = s0 ? { floor: s0.floor, z01: s0.z01 } : null;
    // D5: the player's rooms ride in from the store ONCE, before the first
    // setFloor (FloorMask.importMemory validates its half: pane names, booleans).
    if (this._viewStore && this._floorMask && typeof this._floorMask.importMemory === 'function' &&
        typeof this._viewStore.rooms === 'function') {
      const rooms = this._viewStore.rooms();
      if (rooms) this._floorMask.importMemory(rooms);
    }
  }

  /** The underlying pure core (read-only use — rail/tests). */
  get ladder() { return this._ladder; }

  /**
   * True while the engaged floor iconizes the ship (F4/F5) and the aiming
   * reticles are suppressed. main.js's per-frame ARM PILOT DockingReticle
   * re-show consults this — allocation-free (gameLoop hot path; no getState()
   * snapshot). Flag-off: never engaged → never set → always false.
   */
  reticlesSuppressed() { return this._reticlesHidden; }

  /**
   * Current ladder floor id (1..5), or null when unavailable. Read-only probe
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
   * Is a ladder camera ride in flight? (Session I — the frame scheduler's
   * ride signal: rides run at native refresh, plan D-G.) The truth is the
   * CORE's ride token — set by `rideStarted` in `_startRide`, cleared by
   * `rideFinished` in the ride's `done` (the `_rideSeq` guard drops
   * superseded completions, so a replacement ride keeps this true until ITS
   * end). Allocation-free (the adaptHoldoff law); guarded for injected
   * ladder stubs that pre-date the core accessor. Disengaged/flag-off: false.
   * @returns {boolean}
   */
  isRiding() {
    if (!this._engaged) return false;
    return !!(this._ladder.isRiding ? this._ladder.isRiding()
      : this._ladder.getState().mode === 'riding');
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
    // Session N.5b (owner 2026-09-07 — "you had great visuals from menu to
    // f1"): the intro FLYBY state machine. The dive (5 → the hull) is the
    // shot; the game starts on the flying floor — so the intro is dive →
    // one breath at the hull (INTRO_DWELL_MS) → a silent pull-back up to
    // INTRO_LANDING_FLOOR. Any player input after the dive started cancels
    // the remaining phases (they took the wheel; land where they say).
    this._introTick(t);
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
    // Session I turntable (D-F): held arrows orbit the camera while a drawer
    // is open on the workbench floor (dt-scaled; a no-op everywhere else).
    this._turntableArrows(t);
    this._refreshRail();
    return decisions;
  }

  /**
   * Session I (plan D-F) — is the TURNTABLE live? Engaged, standing on a
   * SHIP-anchored floor (the workbench, id 1 — Session I; the flying view,
   * id 2 — Session J.5, the owner's lift of D-F's "any ship-anchored floor"),
   * with a drawer (REFIT / SPECS) open. Allocation-free (the core's floorId
   * probe — the G4 law); main.js consults it per frame to blank the arrows
   * around processInput so they never steer the SHIP, _turntableArrows maps
   * them to the camera drag instead, routeKeyDown consumes them ahead of
   * InputManager, and TouchControls' one-finger drag orbits the camera
   * instead of writing the turn keys. CameraSystem._ladderDragEnabledFor is
   * the camera-side twin of this rule (floors 1–2 && paneOpen).
   * @returns {boolean}
   */
  turntableActive() {
    if (!this._engaged) return false;
    const f = this._ladder.floorId ? this._ladder.floorId() : this._ladder.getState().floor;
    if (f !== 1 && f !== 2) return false;
    const open = (p) => !!(p && p.isOpen && p.isOpen());
    return open(this._refit) || open(this._library);
  }

  /**
   * @private Map held arrows to a camera drag nudge (Session I, D-F). The
   * nudge rides the camera's OWN drag mechanism (velocity + damping — one
   * feel for pointer and keys), dt-scaled by ARROW_TURN_PX_PER_S so the rate
   * is frame-rate independent. Counts as ladder input for adaptHoldoff (a
   * turning camera is a transient, not steady state). No-ops without the
   * keys map / camera nudge, off the turntable, and while riding (the camera
   * ignores nudges mid-ride anyway — rides own the camera).
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

  /**
   * Wave 5 Session K (plan D-B / D-E — one shop): the CEREMONY ride to the
   * workbench. The hub calls this on WORKBENCH_STOP (GameFlowManager's ONE
   * ladder-on depot entry: the chapter dwell, the B key, the STORE chip) and
   * then opens the REFIT drawer. The ride is the core's `ceremonyRide` —
   * floor 1 at the CROSSING duration (the decision carries no miniMs, so
   * `_apply` flies it at CROSS_RIDE_MS 550, not the 200 ms hotkey mini-ride:
   * the break is seen), superseding a ride in flight — through the SAME
   * `_apply` → `_startRide` path as every ride (fidelity, floor content — the
   * REFIT tab enables on the floor-1 arrival — the mask, both rails). Already
   * on floor 1 → [] (the drawer simply opens). Disengaged → [] (the ladder
   * does not own the screen; the hub's stop handler releases the break).
   * @param {{ tMs?: number }} [arg]
   * @returns {Array} the decisions applied (jump()'s shape)
   */
  rideToWorkbench({ tMs } = {}) {
    if (!this._engaged) return [];
    const t = (tMs === undefined) ? this._now() : tMs;
    this._lastInputMs = t;
    const decisions = (typeof this._ladder.ceremonyRide === 'function')
      ? this._ladder.ceremonyRide({ tMs: t, toFloor: WORKBENCH_FLOOR })
      : this._ladder.jump({ tMs: t, toFloor: WORKBENCH_FLOOR });
    this._apply(decisions, t);
    this._refreshRail();
    return decisions;
  }

  /**
   * Esc grammar (08-workbench §2, the hosted-codex rule: "Esc closes the
   * topmost pane first, then rides up"). Close the topmost OPEN workbench pane
   * and report whether one was — InputManager calls this ONCE before it would
   * command 'esc', and returns on true, so the ride-up is the NEXT Esc. The
   * pane order lives here, never in InputManager: the TECH LIBRARY closes
   * FIRST (Wave 5 Session B — it is the topmost: it opens FROM the REFIT card
   * in the one flow that opens both, 08-workbench §3, so Esc unwinds
   * reading → fitting → ride up; with both open Library-first is the
   * DOCUMENTED order, 06-core-api "Camera + Esc"), then REFIT (`_refit`,
   * Wave 5 (2)). Absent deps / closed panes / disengaged → false (the shipped
   * ride-up runs). The pane's own close() fires its onOpenChange edge (D10
   * calm cap + the camera inset release) — no second signal here. Not a
   * ladder input for adaptHoldoff (no camera flight).
   * @returns {boolean} true when a pane was open and is now closed
   */
  closeTopPane() {
    if (!this._engaged) return false;
    const lib = this._library;
    if (lib && lib.isOpen && lib.isOpen()) {
      if (lib.close) lib.close();
      return true;
    }
    const r = this._refit;
    if (r && r.isOpen && r.isOpen()) {
      if (r.close) r.close();
      return true;
    }
    return false;
  }

  /**
   * Horizontal-swipe eligibility (Wave 5 Session C — 08-workbench §2
   * "Horizontal = what (panes)"): true while the ladder is engaged with at
   * least one pane dep to page ON THIS FLOOR — floor 1 pages REFIT and SPECS,
   * every other floor pages SPECS alone (Session J, D-C: the SPECS tab lives
   * on every floor; REFIT stays the floor-1 place you ride down to).
   * WheelRouter consults this per HORIZONTAL-dominant wheel event (|deltaX| >
   * |deltaY|) before it claims the event away from the zoom feed — never per
   * frame, never for a vertical event. Everywhere else (disengaged, no pane
   * for the floor) the router leaves the axis exactly as shipped. Reads the
   * core floor through `currentFloor()` (a getState snapshot — event-rate only).
   * @returns {boolean}
   */
  wantsPaneSwipe() {
    if (!this._engaged) return false;
    if (this.currentFloor() === 1) return !!(this._refit || this._library);
    return !!this._library;
  }

  /**
   * Read-only pane probe for the `?trace=1` FlickTraceRecorder (Wave 5
   * Session D — the swipe monitor, 07-flick-tuning §5 closed): the two
   * workbench panes' open state and the live swipe-claim verdict, so a
   * recorded trace can replay `_claimPaneSwipe` exactly as it ran live and a
   * 10 Hz sample shows which pane the player was in. `refit` / `library` are
   * null when the dep is absent (a boot without that pane); `wantsPaneSwipe`
   * is the same answer WheelRouter gets. A getState snapshot at event rate —
   * never per frame, never a write, never a throw.
   * @returns {{ refit: boolean|null, library: boolean|null, wantsPaneSwipe: boolean }}
   */
  paneState() {
    const isOpen = (p) => (p && typeof p.isOpen === 'function') ? !!p.isOpen() : null;
    let wants = false;
    try { wants = this.wantsPaneSwipe(); } catch (_e) { wants = false; }
    return { refit: isOpen(this._refit), library: isOpen(this._library), wantsPaneSwipe: wants };
  }

  /**
   * The ONE horizontal page verb (Wave 5 Session C): step the workbench
   * carousel **[REFIT] — [ship] — [LIBRARY]** one position toward a screen
   * side. WheelRouter's accumulator decides WHEN (one call per flick, never
   * per event); this method decides WHAT — the house pattern (the router
   * emits, the hub executes through the panes' own open()/close(), whose
   * onOpenChange edges carry the D10 calm cap + the camera inset exactly as
   * a tab click would; no signal is added here).
   *
   *   toward 'left'  (the REFIT side):  an open LIBRARY closes (paging away
   *                  from it), else a closed REFIT opens, else nothing (wall).
   *   toward 'right' (the LIBRARY side): an open REFIT closes, else a closed
   *                  LIBRARY opens, else nothing.
   *
   * The "away" pane is checked FIRST, so the both-open state (reachable only
   * by clicks — the swipe grammar stays 3-position) resolves to one pane on
   * the first swipe. 'left'/'right' are SCREEN sides: the panes' RTL mirror
   * is their own CSS variable, not this grammar. **Off floor 1 (Session J,
   * D-C) the carousel is two-position — [view] — [SPECS]: REFIT is never
   * touched there** ('left' closes an open SPECS, 'right' opens it). Guards:
   * disengaged or an unknown `toward` → null and no pane is touched; an
   * absent pane dep is skipped, never thrown on. Like closeTopPane(), NOT a
   * ladder input for adaptHoldoff (a 270 ms pane yaw, no floor flight).
   * @param {{ tMs?: number, toward: 'left'|'right' }} arg
   * @returns {'open-refit'|'close-refit'|'open-library'|'close-library'|null}
   *   the action taken (null = nothing to do)
   */
  pagePane({ toward } = {}) {
    if (!this._engaged) return null;
    const lib = this._library;
    const r = (this.currentFloor() === 1) ? this._refit : null;   // REFIT pages on floor 1 only
    const libOpen = !!(lib && lib.isOpen && lib.isOpen());
    const refitOpen = !!(r && r.isOpen && r.isOpen());
    if (toward === 'left') {
      if (libOpen) { if (lib.close) lib.close(); return 'close-library'; }
      if (r && !refitOpen) { if (r.open) r.open(); return 'open-refit'; }
      return null;
    }
    if (toward === 'right') {
      if (refitOpen) { if (r.close) r.close(); return 'close-refit'; }
      if (lib && !libOpen) { if (lib.open) lib.open(); return 'open-library'; }
      return null;
    }
    return null;
  }

  // ── D5 persistence (Wave 5 Session G — 08-workbench §11 "persistence of view prefs + floor") ──

  /**
   * The panes' open/close EDGE, from main.js's ONE `_syncWorkbenchPanes`
   * (the same edge that feeds the D10 calm cap + the camera inset — never a
   * second signal path). Records the F1 pane open-state into the player store
   * as the player's intent — ONLY while engaged on F1 and not driven by the
   * controller itself: `_disengage` clears `_engaged` and `_applyFloorContent`
   * writes `_floorApplied` BEFORE their teardown closes fire, and
   * `_restorePanes` sets `_paneRestoring`, so the controller's own closes and
   * re-opens are never mistaken for the player closing a pane. Write-on-change
   * (the store compares). No store → nothing. Never throws.
   */
  notePaneChange() {
    if (!this._viewStore || this._paneRestoring) return;
    if (!this._engaged) return;
    if (typeof this._viewStore.setPanes !== 'function') return;
    const isOpen = (p) => !!(p && typeof p.isOpen === 'function' && p.isOpen());
    // Session L (Session J FINDINGS (c) — "pane memory stays floor-1 keyed"):
    // the SPECS drawer RIDES ALONG across floors, so its bit is one bit and
    // it is recorded on EVERY floor (an open SPECS on floor 3 survives a
    // continue); REFIT is the floor-1 place — its bit is recorded only while
    // floor 1 is applied (the teardown close on a ride up is the controller's
    // act, not the player's; the memory keeps the room as the player LEFT it)
    // and carried over unchanged from every other floor.
    const prev = (typeof this._viewStore.panes === 'function' && this._viewStore.panes()) || null;
    const refit = (this._floorApplied === 1) ? isOpen(this._refit) : !!(prev && prev.refit);
    this._viewStore.setPanes({ refit, library: isOpen(this._library) });
  }

  /**
   * The HUD pane-visibility EDGE (Wave 5 Session H, Job A — the D5 room-memory
   * WRITE GAP, 03-plan Session G FINDINGS (c)): a pane was shown/hidden by a
   * PLAYER key (0/9/8, the density `-`/`+`/the iPad slider —
   * Events.HUD_PANE_VISIBILITY, emitted AFTER the bit flips) with no floor
   * change to capture it. Capture the applied floor's room NOW and export it
   * to the player store — the same capture-then-persist the floor-change
   * moments run, at event rate (a key press), never per frame (G1; the store
   * still compares, so an unchanged room writes nothing). The mask's own
   * capture() guards make a mask-less / disabled / never-applied state a no-op;
   * disengaged (the shipped cockpit — not a room) returns before touching
   * either dep; flag-off never reaches here (the ONE listener lives inside
   * main.js's LADDER.ENABLED gate). Never throws.
   */
  noteRoomChange() {
    if (!this._engaged || !this._floorMask) return;
    if (typeof this._floorMask.capture !== 'function') return;
    this._floorMask.capture();
    this._persistRooms();
  }

  /**
   * RESET ROOM (Session J, plan D-H: "long-press rail head = RESET ROOM"):
   * forget the applied floor's remembered pane layout and re-apply its
   * default room, then export (the store learns the reset — write-on-change).
   * Session P: the DISPLAY rail whose head long-press called this retired; the
   * verb stays (a hub / probe entry — the DETAIL slider's thumb follows the
   * re-applied room through the pane-visibility edge). No-op disengaged,
   * without a mask, or before the mask learned resetRoom. Event-rate only.
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
   * Session J input routing — the CAPTURE-phase keydown router the hub
   * installs on window inside the LADDER.ENABLED gate, ahead of InputManager's
   * bubble-phase handler (InputManager is do-not-edit; its `keys` map is the
   * D-I public seam). Returns true when the key was CONSUMED — the hub then
   * `stopImmediatePropagation()`s so InputManager never sees it. Three rules,
   * every one floor-gated and inert when disengaged (flag-off: never engaged,
   * never installed → byte-identical):
   *
   *   1. ARROWS under the TURNTABLE (Session I FINDINGS (b), closed here): the
   *      per-frame shim could blank the arrows around processInput, but the
   *      keydown-path side effect ran first — InputManager's handler disengages
   *      autopilot on the FIRST arrow press (:445–452) before any frame runs.
   *      While `turntableActive()` the arrow keydown writes the SAME public
   *      key bit InputManager would have (`keys[code] = true`, so
   *      _turntableArrows still reads it) and is consumed; keyup is left to
   *      InputManager (it only clears the bit — consistent either way, and a
   *      drawer closed mid-hold still releases cleanly). preventDefault keeps
   *      the page from scrolling, exactly as the shipped handler does.
   *   2. TAB on floor 3 (DEBRIS / PROX NET): cycles the insertion candidates
   *      (`proxNet.cycleInsertion(±1)`, Shift reverses) — the verb NO input
   *      produced (item 6). Consumed only when a candidate was cycled; with no
   *      plan the shipped debris cycle runs untouched.
   *   3. TAB on floor 4 (LEO / NAVCOM): steps the focused cluster
   *      (`navcom.focusStep(±1)`); consumed when a cluster is focused after
   *      the step.
   *
   * A key whose target is a text field (INPUT / TEXTAREA / contentEditable —
   * the Codex search box) is never routed: InputManager's own guard, mirrored,
   * so a capture-phase router cannot swallow a caret's arrows or Tab.
   * Never throws; never a ladder input for adaptHoldoff (no camera flight —
   * the arrows' own nudge already counts inside _turntableArrows).
   * @param {{ code?: string, shiftKey?: boolean, target?: object, preventDefault?: function }} e
   * @returns {boolean} true when consumed
   */
  routeKeyDown(e) {
    if (!this._engaged || !e || typeof e.code !== 'string') return false;
    // Never route a key aimed at a TEXT FIELD (the Codex search box opens
    // during gameplay) — the same guard InputManager applies before it reads
    // any key (:400–403); a capture-phase router that ran ahead of it would
    // otherwise eat the caret's arrows and Tab while the player types.
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
   * The run-scoped half of D5 for the RUN SAVE (main.js gathers it on
   * PERSISTENCE_GATHER as `save.ladder`, inside the LADDER.ENABLED gate): the
   * core's live `(floor, z01)`. A plain fresh object; never a throw (null if
   * the core has no snapshot). (The Session G doorway branch — "a save during
   * the ride into F2 records the hull" — retired with the doorway, Session H.)
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
   * Restore a saved view (`save.ladder`, from main.js on PERSISTENCE_LOADED)
   * into the core BEFORE the first engage of a continued run — the next
   * gameplay frame's `_engage` then reads the core and re-engages where the
   * player left. Validated: an object with `floor` ∈ FloorContract.FLOORS and
   * a finite `z01` (ZoomLadder.place clamps it to [0,1]); anything else → the
   * shipped default stands, no throw. Refused while engaged in gameplay (a cut
   * under a live camera is never invisible — 06-core-api "place"); a controller
   * left engaged because gameplay ended without a frame yet is disengaged
   * first (exactly what the next update() would do). A ride the core still
   * reports while disengaged is stale by construction (the camera dropped its
   * completion at disengage) and is settled before the placement.
   * @param {{floor?: number, z01?: number}|null|undefined} saved
   * @returns {boolean} true when the core was placed
   */
  restoreView(saved) {
    if (!saved || typeof saved !== 'object') return false;
    const floor = saved.floor, z01 = saved.z01;
    if (!Number.isFinite(floor) || !FloorContract.FLOORS.some((f) => f.id === floor)) return false;
    if (typeof z01 !== 'number' || !Number.isFinite(z01)) return false;
    return this._placeWhileHidden(floor, z01);
  }

  /**
   * GAME_RESET (main.js, inside the LADDER.ENABLED gate): the run's floor memory
   * is cleared — the core goes back to the shipped initial view captured at
   * construction, so a NEW game starts on the shipped floor with the intro ride
   * as shipped, whatever floor the last run ended on. A CONTINUE restores the
   * saved view again right after (GameFlowManager emits PERSISTENCE_LOADED after
   * resetGame()). The player's rooms and pane memory are NOT touched (D5: they
   * belong to the player, not the run). Same engaged-in-gameplay refusal as
   * restoreView.
   * @returns {boolean} true when the core was placed
   */
  resetView() {
    if (!this._initialView) return false;
    return this._placeWhileHidden(this._initialView.floor, this._initialView.z01);
  }

  /**
   * Wave 5 Session N — the INTRO RIDE (plan item 2; 08-workbench §8 Q6). The
   * hub calls this right after resetView() on GAME_RESET when the run is a
   * first-time player's NEW game (the MAP store's first-run bit; never under
   * the ?shot harness unless asked): the core is PLACED (a cut while hidden —
   * the same invisible path as restoreView) on the TOP floor of the contract,
   * and the ride to the FLYING floor (INTRO_LANDING_FLOOR — owner 2026-09-07;
   * it landed on the workbench through Session N) is ARMED — `_engage` starts
   * it the moment the ladder owns the screen, at INTRO_RIDE_MS (or `rideMs`),
   * through the same `_apply` → `_startRide` path as every ride (fidelity,
   * the floor content, the mask, both rails), silently (no clunk: it is
   * watched, not commanded). Under REDUCED MOTION (`reducedMotion: true`) the
   * core is placed on the landing floor itself and nothing is armed — the
   * first frame IS the flying floor. Refused (false, nothing armed) while
   * engaged in gameplay, when the contract has no top / landing floor, or
   * when the placement fails.
   * @param {{ rideMs?: number, reducedMotion?: boolean }} [arg]
   * @returns {boolean} whether the intro was armed (or, reduced, placed)
   */
  armIntroRide({ rideMs, reducedMotion = false } = {}) {
    this._introPending = null;
    const ids = FloorContract.FLOORS.map((f) => f.id).filter((id) => Number.isFinite(id));
    if (!ids.length || !ids.includes(INTRO_LANDING_FLOOR)) return false;
    if (reducedMotion) return this._placeWhileHidden(INTRO_LANDING_FLOOR, 0.5);
    const top = Math.max(...ids);
    // The flyby needs a hull to dive to and headroom to dive from; a contract
    // without either just places on the landing floor (no ride).
    if (top === INTRO_LANDING_FLOOR || !ids.includes(WORKBENCH_FLOOR)) return this._placeWhileHidden(INTRO_LANDING_FLOOR, 0.5);
    if (!this._placeWhileHidden(top, 0.5)) return false;
    const ms = Number(rideMs);
    this._introPending = (Number.isFinite(ms) && ms > 0) ? ms : INTRO_RIDE_MS;
    return true;
  }

  /** Session N: a CONTINUE (PERSISTENCE_LOADED) is not a new game — drop an armed intro ride. */
  disarmIntroRide() { this._introPending = null; this._introPhase = null; }

  /**
   * Session N.5b: true from an armed intro until the flyby fully lands (or is
   * cancelled) — the hub's MAP floor getter reads null through the WHOLE
   * flyby, so the dwell's settled hull floor never becomes the checklist's
   * ride baseline.
   */
  introInFlight() { return this._introPending !== null || this._introPhase !== null; }

  /**
   * @private Session N.5b — advance the intro FLYBY: dive lands → one breath
   * at the hull (INTRO_DWELL_MS) → the silent pull-back to
   * INTRO_LANDING_FLOOR → done. Player input after the dive started (any
   * verb that stamps _lastInputMs) cancels the remaining phases.
   */
  _introTick(t) {
    if (this._introPhase === null || !this._engaged) return;
    if (Number.isFinite(this._lastInputMs) && this._introDiveStartMs !== null && this._lastInputMs > this._introDiveStartMs) {
      this._introPhase = null;                 // the player took the wheel
      return;
    }
    if (this._introPhase === 'dive') {
      if (!this.isRiding()) { this._introPhase = 'dwell'; this._introDwellUntil = t + INTRO_DWELL_MS; }
    } else if (this._introPhase === 'dwell') {
      if (t >= this._introDwellUntil) {
        const decisions = (typeof this._ladder.ceremonyRide === 'function')
          ? this._ladder.ceremonyRide({ tMs: t, toFloor: INTRO_LANDING_FLOOR })
          : this._ladder.jump({ tMs: t, toFloor: INTRO_LANDING_FLOOR });
        this._apply(decisions, t, { rideMs: INTRO_PULLBACK_MS, silent: true });
        this._introPhase = 'pull';
        this._refreshRail();
      }
    } else if (this._introPhase === 'pull') {
      if (!this.isRiding()) this._introPhase = null;
    }
  }

  /**
   * Session N.5 (owner 2026-09-07): RAILS SHY — when the `-` walk has
   * already cleared every density rung, the hub bows the RAILS out too;
   * `+` (the hub), any ride, or a fresh engage brings them back. A transient
   * view state: never persisted, never a room edit (the D5 capture reads
   * pane flips, and rails are not panes). Edge chrome only — SPECS/REFIT
   * tabs + stamp are `setHudClear` (rev-3, plan 1788867799156 #4).
   *
   * Session P (plan D2): with an `edgeChrome` dep the WHERE rail is no longer
   * `hide()`-hidden here — the chrome goes to SLEEP (`edgeChrome.sleep()`:
   * the fade starts now, `visibility:hidden` lands after it) and stays
   * WAKEABLE, so on glass an edge touch brings the rail back from level 0
   * (the way back — there is no `+` key on glass). Un-shy → `wake()`. The
   * DETAIL slider (plan D5) needs nothing here: level 0 IS this state, and
   * the slider sleeps and wakes with the rest of the chrome. Without the
   * dep the Session N.5 hide()/show() path is byte-identical.
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
   * Rev-3 ladder (plan 1788867799156 #4): owns the `pureScenery` hook
   * exclusively — `true` hides SPECS/REFIT tabs + build stamp
   * (`body[data-pure-scenery]`), `false` restores them. Density flips only
   * (main.js calls this on every HUD_PANE_VISIBILITY); rails sleep at
   * level 0 via `setRailsShy`. Idempotent. Engaged-only: while not engaged
   * stores nothing and does not call the hook. The controller never calls
   * `setHudClear(true)` on its own (FloorMask applies keep SPECS pinned on
   * F1 — that is main.js's concern).
   * @param {boolean} clear
   */
  setHudClear(clear) {
    if (!this._engaged) return;
    const want = !!clear;
    if (want === this._hudClear) return;
    this._hudClear = want;
    this._callPureScenery(want);
  }

  /** @returns {boolean} true while the SPECS/REFIT tabs + stamp are hidden. */
  isHudClear() { return this._hudClear; }

  /**
   * Drive the optional `{ hide(), show() }` hook. Swallow throws so a
   * broken binding cannot stall the ladder.
   * @param {boolean} hide
   * @private
   */
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
   * Engage / disengage / ride / floor-apply reset: tabs + stamp back, flag
   * false. Always `show()`s (even if already clear) so a floor change never
   * leaves the tabs hidden; the next density flip re-evaluates.
   * @private
   */
  _resetHudClear() {
    this._hudClear = false;
    this._callPureScenery(false);
  }

  /**
   * @private Session P (plan D5): the DETAIL slider's floor rule — the
   * DISPLAY rail's Session N.5 rule carried over: never on the workbench (F1
   * is the ship, its callouts, and the two drawer tabs — the REFIT tab has the
   * footer's left slot there; the WHERE rail stays — it is the way back up).
   * Everywhere else the slider shows.
   */
  _detailSliderAllowed(floor) { return floor !== WORKBENCH_FLOOR; }

  /** Session N: true while an intro ride is armed and not yet flown. */
  introRidePending() { return this._introPending !== null; }

  /**
   * @private The ONE invisible placement path shared by restoreView/resetView:
   * refuse while engaged in gameplay; disengage a stale engagement; settle a
   * stale ride; place.
   */
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
   * @private A core that reports `riding` while the controller is DISENGAGED
   * can never be completed by the camera (CameraSystem.ladderDisengage drops
   * `onDone`; the headless path completes synchronously), so the ride is stale
   * by construction — report it finished so the placement is not refused.
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

  /**
   * @private D5: (re)seed the working-position memory at an engage or a floor
   * arrival — `z01` is the rest (null when not a free rest) and no drive is
   * in progress.
   */
  _seedRest(z01) {
    this._restZ01 = isFreeRest(z01) ? z01 : null;
    this._restBeforeDrive = this._restZ01;
    this._lastMoveT = -Infinity;
    this._lastMoveDir = 0;
    this._lastPosZ01 = (typeof z01 === 'number' && Number.isFinite(z01)) ? z01 : null;
  }

  /**
   * @private D5: a free-zone `move` on the applied floor at `tMs`. A new DRIVE
   * begins when the gap since the last free move reaches the core's gesture
   * boundary (GESTURE_LOCK_SILENCE_MS) or the direction flips — the working
   * position as it stood then is kept in `_restBeforeDrive` so a flick that
   * grows out of this drive can roll back its own ramp-up moves. Direction is
   * measured against the PREVIOUS POSITION (`_lastPosZ01`), never the rest.
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
   * @private D5: a flick-to-wall ride fired at `tMs` in direction `flickDir`
   * (+1 out / −1 in). If it grew out of the drive in progress (the last free
   * move is inside the gesture boundary AND went the same way — a flick's ramp
   * is same-direction by construction), its ramp-up moves were the leaving
   * gesture: the working position rolls back to where it stood before that
   * drive. A flick with no ramp (a single big event after a pause) or a flick
   * that REVERSES a drive (the scroll was the player's) rolls nothing back.
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
   * @private D5 (owner decision 3): re-open the F1 workbench panes as the
   * player left them — at ENGAGE on F1 (the SHOP return, a continued run),
   * after `_applyFloorContent(1)` has enabled the tabs (open() is a no-op while
   * disabled). REFIT first, then the LIBRARY (the one flow that opens both;
   * Esc unwinds library → refit). The panes' own open() fires their
   * onOpenChange edge (the D10 calm cap + the camera inset, exactly as a tab
   * click would); `_paneRestoring` keeps notePaneChange from re-recording it.
   */
  _restorePanes() {
    if (!this._viewStore || typeof this._viewStore.panes !== 'function') return;
    const want = this._viewStore.panes();
    if (!want) return;
    this._paneRestoring = true;
    try {
      if (want.refit && this._refit && this._refit.open) this._refit.open();
      if (want.library && this._library && this._library.open) this._library.open();
    } finally {
      this._paneRestoring = false;
    }
    // Converge the store to what actually stands: below the one-pane
    // breakpoint main.js's `_onePaneRule` closes the other pane on the second
    // open edge (its edge was suppressed above), and a both-open memory would
    // otherwise replay an open→close REFIT flash on every F3 engage while the
    // store never learned. Write-on-change: a wide viewport records nothing new.
    this.notePaneChange();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _engage(tMs) {
    // Session I follow-up (review, FINDINGS (f)): a ride that was in flight
    // when the controller DISENGAGED (gameplay ended mid-ride) can never be
    // completed — CameraSystem.ladderDisengage dropped the ride's onDone — so
    // the core still reports `riding` at the next engage. Left alone, that
    // stale token made isRiding() true for the rest of the session: the frame
    // scheduler read "ride in flight" and boosted to native refresh forever
    // (the same permanent-boost class as the ceremony leak). Settle it FIRST —
    // the helper is a no-op while engaged, so it must run before the flag.
    this._settleStaleRide();
    this._engaged = true;
    this._railsShy = false;                    // a fresh engagement is never shy (Session N.5)
    this._resetHudClear();                    // rev-3: a fresh engage never leaves the tabs hidden
    const s = this._ladder.getState();
    const frame = this._frame(s.floor, s.z01);
    if (this._cameraSystem && this._cameraSystem.ladderEngage) {
      this._cameraSystem.ladderEngage(frame);
    }
    // D5: the engage position seeds the working-position memory for this floor
    // (a parked depot return / a restored save re-engage exactly here).
    this._seedRest(s.z01);
    this._applyFidelity(s.floor);
    this._applyFloorContent(s.floor);
    // Session P (plan D3): an ENGAGE is an arrival even on the floor the last
    // engagement left — the chrome wakes and the notch is boxed regardless.
    this._wakeFloorChrome();
    // D5: the panes as the player left them re-open at ENGAGE (the SHOP
    // return; a continued run), never at a ride arrival. Session L (J
    // FINDINGS (c)): on EVERY floor — the SPECS drawer rides along, so its
    // memory is floor-free; REFIT's open() is a no-op off floor 1 (its tab is
    // enabled by _applyFloorContent(1) only), so a refit:true memory simply
    // waits for the next floor-1 engage.
    this._restorePanes();
    if (this._rail && this._rail.show) this._rail.show();
    // (The DETAIL slider's shown/hidden is owned by _applyFloorContent above —
    // the Session N.5 floor rule carried over: never on the workbench.)
    this._refreshRail();
    // Session N: an ARMED intro flies now — the core was placed on the top
    // floor while hidden; the DIVE rides to the HULL (the shot — owner
    // 2026-09-07b: "you had great visuals from menu to f1") at the intro
    // duration, silent; _introTick then breathes at the hull and pulls back
    // up to INTRO_LANDING_FLOOR where the game starts.
    if (this._introPending !== null) {
      const ms = this._introPending;
      this._introPending = null;
      const t = (tMs === undefined) ? this._now() : tMs;
      const decisions = (typeof this._ladder.ceremonyRide === 'function')
        ? this._ladder.ceremonyRide({ tMs: t, toFloor: WORKBENCH_FLOOR })
        : this._ladder.jump({ tMs: t, toFloor: WORKBENCH_FLOOR });
      this._apply(decisions, t, { rideMs: ms, silent: true });
      this._introPhase = 'dive';
      this._introDiveStartMs = t;
      this._refreshRail();
    }
  }

  _disengage() {
    this._engaged = false;
    this._introPending = null;   // Session N review: an arm that never engaged does not survive into a later run
    this._introPhase = null;     // Session N.5b: nor does a mid-flyby phase (a cut mid-dwell never pulls back in a later run)
    if (this._cameraSystem && this._cameraSystem.ladderDisengage) {
      this._cameraSystem.ladderDisengage();
    }
    // Clearing the fidelity request makes SceneManager.applyTier() byte-identical
    // to the shipped path again (no re-assertion).
    if (this._sceneManager && this._sceneManager.setLadderFloorFidelity) {
      this._sceneManager.setLadderFloorFidelity(null);
    }
    if (this._navcom && this._navcom.deactivate) this._navcom.deactivate();
    if (this._proxNet && this._proxNet.deactivate) this._proxNet.deactivate();
    if (this._sdaFloor && this._sdaFloor.deactivate) this._sdaFloor.deactivate();
    if (this._hullcam && this._hullcam.deactivate) this._hullcam.deactivate();
    // Wave 5 (2): the REFIT pane closes with the ladder — tab hidden, pane
    // shut (its own close() fires the D10 open-signal false edge).
    if (this._refit) {
      if (this._refit.setEnabled) this._refit.setEnabled(false);
      if (this._refit.close) this._refit.close();
    }
    // Wave 5 (Session B): the SPECS pane closes with the ladder too (the ONE
    // place it is disabled since Session J — every floor carries the tab).
    if (this._library) {
      if (this._library.setEnabled) this._library.setEnabled(false);
      if (this._library.close) this._library.close();
    }
    // Per-floor audio bed: fade to silence on disengage (optional dep).
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(null);
    // Per-floor HUD pane mask: restore the shipped fully-visible cockpit and
    // hide the vitals line on disengage (optional dep — the beds contract).
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(null);
    // D5: setFloor(null) captured the departing floor's live room into the
    // mask's memory — export it to the player store now (write-on-change; a
    // floor-change moment, never per frame — G1). The SHOP entry lands here.
    this._persistRooms();
    // Interaction sfx: clear transient gesture state (ratchet step / armed
    // undo window) so a re-engage starts clean (optional dep).
    if (this._sfx && this._sfx.reset) this._sfx.reset();
    // Restore the reticles the icon floors hid (no-op if not suppressed). On a
    // disengage caused by LEAVING gameplay, the restore resolves to hidden —
    // matching TargetReticle's own GAME_STATE_CHANGE rule (see _setReticlesHidden).
    this._setReticlesHidden(false);
    // Restore the constellation figures F7 hid (no-op if not suppressed).
    this._setConstellationsHidden(false);
    // Clear the F7/F3 city/landmark-pill suppression (no-op if not suppressed;
    // the 5-key preference decides whether the pills actually reappear).
    this._setCityLabelsHidden(false);
    if (this._rail && this._rail.hide) this._rail.hide();
    // Session P (plan D5): the DETAIL slider leaves with the ladder (the menu).
    if (this._detailSlider && typeof this._detailSlider.setShown === 'function') this._detailSlider.setShown(false);
    // Rev-3 (plan 1788867799156 #4): leaving gameplay clears hud-clear too —
    // the body attribute is a view state of the ENGAGED ladder only, so the
    // build stamp / tabs are back on the menu (Ipad.md §2.5: hidden ONLY
    // inside the transient HUD-clear view).
    this._resetHudClear();
  }

  // ── Decision translation ───────────────────────────────────────────────────

  /**
   * @param {Array} decisions
   * @param {number} tMs
   * @private
   */
  _apply(decisions, tMs, opts = null) {
    // Session N: the intro ride overrides the ride duration and mutes the sfx
    // (`{ rideMs, silent }`); every other caller passes nothing.
    const rideOverride = (opts && Number.isFinite(opts.rideMs) && opts.rideMs > 0) ? opts.rideMs : null;
    const silent = !!(opts && opts.silent);
    for (const d of decisions) {
      switch (d.type) {
        case 'move':
        case 'settle':
          if (this._cameraSystem && this._cameraSystem.ladderSetTarget) {
            this._cameraSystem.ladderSetTarget(this._frame(d.floor, d.z01));
          }
          // D5 working-position memory: a free-zone move on the applied floor
          // is where the player is working; wall creep (move.inWall) and the
          // settle-back to an edge are the leaving gesture and never count —
          // but every one of them is the PREVIOUS POSITION for the next move's
          // direction, so _lastPosZ01 follows them all.
          if (d.type === 'move' && !d.inWall && d.floor === this._floorApplied && isFreeRest(d.z01)) {
            this._noteFreeMove(d.z01, tMs);
          }
          this._lastPosZ01 = d.z01;
          break;

        case 'cross':
          // 00-spec §4: the clunk derives from cross.direction ('out' ↑ / 'in' ↓).
          // (The intro's `silent` / `rideMs` reach here too — latent: the
          // ceremony decision is always a 'ride'; Session N review.)
          if (!silent && this._sfx && this._sfx.onCross) this._sfx.onCross(d.direction);
          this._startRide(d.toFloor, d.entryZ01, rideOverride !== null ? rideOverride : CROSS_RIDE_MS, tMs, true);
          break;

        case 'ride':
          // G3 flick-to-wall soft tick (LadderSfx only sounds kind 'flickWall').
          if (!silent && this._sfx && this._sfx.onRide) this._sfx.onRide(d.kind);
          // Session K: the ceremony ride is a crossing in all but name — it
          // flies at CROSS_RIDE_MS and lands on a new floor — so it gets the
          // descending clunk (the same onCross the wheel crossing sounds).
          if (!silent && d.kind === 'ceremony' && this._sfx && this._sfx.onCross) this._sfx.onCross('in');
          // D5: a flick-to-wall ride ends the drive whose ramp-up moves just
          // landed — the working position rolls back to before that drive.
          // The flick's direction is the wall it landed on (lower edge = in).
          if (d.kind === 'flickWall') this._rollBackDrive(tMs, d.entryZ01 <= 0.5 ? -1 : 1);
          this._startRide(d.toFloor, d.entryZ01,
            rideOverride !== null ? rideOverride : (d.miniMs != null ? d.miniMs : CROSS_RIDE_MS), tMs);
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
    // The ORIGIN floor — read BEFORE the destination's content lands below.
    const fromFloor = this._floorApplied;
    if (toFloor !== fromFloor) {
      // A floor change re-seeds the working position from the arrival entry
      // (0.25 / 0.75 — always a free rest). A same-floor flickWall ride lands
      // on a wall EDGE and leaves the memory alone (the player is still here;
      // _rollBackDrive already discounted its ramp-up moves).
      this._seedRest(entryZ01);
    }
    // Every ride lands the core at entryZ01 — the previous position for the
    // next free move's direction (a flickWall landing included).
    this._lastPosZ01 = entryZ01;
    // Session P (plan D3): a RIDE wakes the WHERE rail (the floor content below
    // wakes everything when the floor actually changes; a same-floor flickWall
    // ride still lights the rail the player is pushing against).
    if (this._edgeChrome && typeof this._edgeChrome.wake === 'function') this._edgeChrome.wake('rail', tMs !== undefined ? tMs : this._now());
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
    const f = FloorContract.byId(floor);
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
   * floor content controllers. F4's 'clusters' mode swaps the full debris meshes
   * for the NAVCOM cluster-icon + transfer-window costume; F3's 'tactical' mode
   * drives the PROX NET corridor costume; F5's 'massBands' mode drives the SDA
   * chart (and hides the constellation figures under it); F1 (HULL CAM) keys on
   * the floor ID — its debrisMode 'full' is shared with F2 and cannot
   * discriminate. Every other floor deactivates each. Also gates the aiming
   * reticles on the icon floors (>= 4). Every content dep is optional (parallel
   * track — the serial track injects the floors + the reticles); absent deps
   * make each part a no-op. @private
   */
  _applyFloorContent(floor) {
    // Session P (plan D3/A4): a FLOOR CHANGE is a wake source — the arrival is
    // recorded before the origin-floor record below is overwritten.
    const floorChanged = (this._floorApplied !== floor);
    // The origin-floor record for the next ride (the depot doorway reads it).
    this._floorApplied = floor;
    // Reticle gating (F4/F5 'ship-to-icon' floors): the target + docking
    // reticles aim at subjects that are icons at Earth-anchored ranges, so both
    // hide while the engaged floor is >= 4 and restore on floors <= 3 (and on
    // disengage) — mirroring the navcom activate/deactivate pattern below.
    // Keyed on the floor number, not debrisMode: F5 ('massBands') must suppress
    // too. Independent of the content deps so the reticle deps work standalone.
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
    // F3 (PROX NET): the arrival floor's debrisMode 'tactical' drives the
    // ProxNetFloor costume — same activate/deactivate pattern as navcom.
    if (this._proxNet) {
      const tactical = !!(f && f.fidelity && f.fidelity.debrisMode === 'tactical');
      if (tactical) {
        if (this._proxNet.activate) this._proxNet.activate();
      } else if (this._proxNet.deactivate) {
        this._proxNet.deactivate();
      }
    }
    // F5 (SDA): 'massBands' drives the full-screen chart; the constellation
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
    // City/landmark pills hide on F5 (above) AND on F1 (owner, 2026-09-02
    // evening — the map rule, 08-workbench D8: "house numbers up close, city
    // names far out, never both"). At the hull, Earth is a backdrop 2–12 m
    // behind the ship and the pills land among the hull callout cards in the
    // same pill grammar. F1 is keyed on FLOOR ID (debrisMode is 'full' on both
    // F1 and F2); F2 keeps the shipped pills — the player's 5-key choice. Same
    // transient gate, same restore on leave/disengage; F3/F4 untouched.
    this._setCityLabelsHidden(massBands || floor === 1);
    // F1 (HULL CAM): keyed on FLOOR ID 1 — NOT fidelity.debrisMode, which is
    // 'full' on BOTH F1 and F2 and cannot discriminate.
    if (this._hullcam) {
      if (floor === 1) { if (this._hullcam.activate) this._hullcam.activate(); }
      else if (this._hullcam.deactivate) this._hullcam.deactivate();
    }
    // F1 REFIT pane (Wave 5 (2)): the same FLOOR-ID key as hullcam. Arrival
    // on 1 enables the edge tab (always visible while enabled — 08-workbench
    // §2); any other floor disables it AND closes the pane, so a ride away
    // never strands an open pane (the D10 calm cap releases with the close).
    if (this._refit) {
      if (floor === 1) {
        if (this._refit.setEnabled) this._refit.setEnabled(true);
      } else {
        if (this._refit.setEnabled) this._refit.setEnabled(false);
        if (this._refit.close) this._refit.close();
      }
    }
    // The SPECS pane (Wave 5 Session B; plan D-C since Session J): enabled on
    // EVERY floor — an open pane RIDES ALONG (the world stays held under it, D-F;
    // the camera inset bias applies on every floor since the CameraSystem :4384 lift);
    // only _disengage disables and closes it. Session O (plan D6, owner
    // 2026-09-07) → Session P (plan D2/D6): the edge TAB is PINNED awake on F1
    // only — the classic drawer tab that "opens SPECS" is a WORKBENCH affordance
    // (REFIT parity). Everywhere else it is EDGE CHROME in the footer band: it
    // follows the hub's per-frame EdgeChrome phase while closed (an edge touch
    // or hover wakes it), and the FAST answers — deep links (hint chips,
    // subject-follow, CODEX_OPEN_ENTRY, the glass right-edge swipe) that open
    // the pane from any floor — still work, because THE PANE IS NEVER DISABLED
    // and an open pane's tab is awake on every floor (the pane's own truth
    // table). The floor rule therefore lives here, in the floor content, not in
    // the pane: the pane just answers the floor's claim (setEnabled(true) +
    // setTabPinned(floor === WORKBENCH_FLOOR)).
    if (this._library) {
      if (this._library.setEnabled) this._library.setEnabled(true);
      if (this._library.setTabPinned) this._library.setTabPinned(floor === WORKBENCH_FLOOR);
    }
    // Per-floor audio bed (FloorContract audioBed): crossfade to the arrival
    // floor's bed. Optional dep — absent it this is a no-op (parallel track).
    if (this._audioBeds && this._audioBeds.setFloor) this._audioBeds.setFloor(floor);
    // Per-floor HUD pane mask (08-workbench D8/§4 map rule): apply the arrival
    // floor's room LAST, after every floor system above has landed, so the
    // destination panes fade in with the ride (this method runs on _engage and
    // at every _startRide start). Optional dep — absent it this is a no-op.
    if (this._floorMask && this._floorMask.setFloor) this._floorMask.setFloor(floor);
    // D5: the mask just captured the departing floor's room — export to the
    // player store (write-on-change inside the store; a floor-change moment).
    this._persistRooms();
    // Session P (plan D5): the DETAIL slider's floor rule — hidden on the
    // workbench, shown everywhere else (its thumb follows the applied room
    // through the hub's pane-visibility edge; its opacity is EdgeChrome's).
    if (this._detailSlider && typeof this._detailSlider.setShown === 'function') {
      this._detailSlider.setShown(this._detailSliderAllowed(floor));
    }
    // Session N.5: riding the ladder ends rails-shy — the rails come back
    // with the floor content (this method runs at engage and every ride start).
    if (this._railsShy) this.setRailsShy(false);
    // Rev-3 (plan 1788867799156 #4): a floor change / ride never leaves the
    // tabs hidden; the next density flip re-evaluates via setHudClear.
    this.setHudClear(false);
    // Session P (plan D3, Airbus A4): the floor changed → every piece of edge
    // chrome wakes and the arrival notch wears the BOX for BOX_MS (the WHERE
    // rail paints it from `isBoxed('floor')`). `_engage` fires the same wake
    // unconditionally (a re-engage on the same floor is still an arrival).
    if (floorChanged) this._wakeFloorChrome();
    // Session J (D-C): the floor's SUBJECT changed — the hub retargets an open
    // SPECS pane (never opens one; SpecsSubject decides what).
    this._noteSubjectChange(floor);
  }

  /**
   * @private Session P (plan D3): the FLOOR wake — all edge chrome awake for
   * IDLE_FADE_MS, the arrival notch boxed. Absent dep → no-op (flag-off).
   */
  _wakeFloorChrome() {
    const ec = this._edgeChrome;
    if (!ec) return;
    const t = this._now();
    if (typeof ec.wake === 'function') ec.wake(undefined, t);
    if (typeof ec.box === 'function') ec.box('floor', t);
  }

  /** @private Session J: fire the optional subject hook, never throw. */
  _noteSubjectChange(floor) {
    if (!this._onSubjectChange) return;
    try { this._onSubjectChange(floor); } catch (_e) { /* dep */ }
  }

  /**
   * Hide/restore the aiming reticles for the ship-is-icon floors (F4/F5).
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
   * Hide/restore the constellation figures for the F5 SDA chart — a mirror of
   * _setReticlesHidden. Idempotent (guarded on the flag flip); the starfield dep
   * is optional — absent it this is a pure flag write, byte-identical to the
   * pre-SDA controller.
   *
   * Hide: capture the player's current 6-key visibility ONCE into
   * _constellationsPrior, then setConstellationsVisible(false).
   * Restore: put back the captured prior and null it — the player's 6-key
   * toggle owns the resting state, so F5 never force-shows figures the player
   * had off (and never strands them hidden after leaving F5 / disengaging).
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
   * Suppress/clear the Earth city + landmark pills — for the F5 SDA chart and,
   * since 2026-09-02 (evening), for the F1 hull floor (the map rule: never
   * city names among house numbers). A mirror of _setReticlesHidden.
   * Idempotent (guarded on the flag flip); the cityLabels dep is optional —
   * absent it this is a pure flag write.
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
   * Dispatch a per-floor Space verb decision (FloorContract spaceVerb). Wired:
   * F4 'plan-transfer' (M3), F3 'approach', F5 'flip-lens', F1 'lens-toggle'
   * (S4 serial wiring), and — Session J item 6 — F2 'approach-autopilot' (the
   * `A` path: AutopilotSystem.toggle(), which resolves the selected target
   * itself and re-acquires the best one when none is selected — the smart
   * default; a second press disengages, exactly like the key). The two verbs
   * that change the floor's SUBJECT (the lens flip, the plan) fire the
   * subject hook afterwards so an open SPECS pane follows (D-C).
   * @private
   */
  _dispatchVerb(verb) {
    if (verb === 'plan-transfer' && this._navcom && this._navcom.planTransfer) {
      this._navcom.planTransfer();
      this._noteSubjectChange(4);
    }
    // F3 Space verb (FloorContract PROX NET row): commit the selected
    // insertion point — ProxNetFloor.approach() → onApproach → autopilot.
    if (verb === 'approach' && this._proxNet && this._proxNet.approach) {
      this._proxNet.approach();
    }
    // F2 Space verb (Session J item 6; a silent no-op since S4): autopilot to
    // the selected target through the injected AutopilotSystem — the same
    // toggle() the A key calls (InputManager KeyA), so the target resolution,
    // the re-acquire and the disengage-on-second-press are all the shipped ones.
    if (verb === 'approach-autopilot' && this._autopilot && typeof this._autopilot.toggle === 'function') {
      this._autopilot.toggle();
    }
    // F5 Space verb: flip the SDA chart lens (VALUE ↔ THREAT).
    if (verb === 'flip-lens' && this._sdaFloor && this._sdaFloor.flipLens) {
      this._sdaFloor.flipLens();
      this._noteSubjectChange(5);
    }
    // F1 Space verb: the REFIT pane claims it when injected (D-b, owner
    // 2026-09-03 — "Space toggles the REFIT pane"); FloorContract's verb
    // string stays 'lens-toggle'. Absent the pane, the shipped hullcam branch
    // runs (un-injected in production today → the silent no-op stands).
    if (verb === 'lens-toggle') {
      if (this._refit && this._refit.toggle) {
        this._refit.toggle();
      } else if (this._hullcam && this._hullcam.lensToggle) {
        // F1 Space verb: cycle the HULL CAM lens (overview → per-subsystem detail).
        this._hullcam.lensToggle();
      }
    }
  }

  /**
   * Resolve a (floor, z01) into a camera frame: distance from anchor, FOV,
   * anchor kind. F1's 'subject' anchor maps to 'ship' in M1 (subject re-aim is
   * S4); F4/F5 'earth' anchor lets the ride engine aim Earth-fixed (T6).
   * @private
   */
  _frame(floor, z01) {
    const f = FloorContract.byId(floor);
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
