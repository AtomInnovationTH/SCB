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
   * @param {object} [deps.library]      - F1 TECH LIBRARY pane (LibraryPane,
   *   Wave 5 Session B): setEnabled/open/close/toggle/isOpen. Optional — no-op
   *   without it. Floor-1 keyed EXACTLY like `refit` (enable on 1, disable +
   *   close elsewhere and on disengage). It claims NO Space verb (D-b keeps
   *   Space = REFIT); Esc reaches it first through closeTopPane() — the
   *   LIBRARY is the TOPMOST workbench pane (it opens FROM the REFIT card,
   *   08-workbench §3, so it is the most recently opened in the one flow that
   *   opens both; with both open Library-closes-first is the documented
   *   order). Session C: both panes also page from the horizontal two-finger
   *   swipe — WheelRouter asks `wantsPaneSwipe()` (F1 + a pane dep) and emits
   *   ONE `pagePane({toward})` per flick; the carousel law lives there.
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
    this._audioBeds = deps.audioBeds || null;
    this._floorMask = deps.floorMask || null;
    this._viewStore = deps.viewStore || null;
    this._sfx = deps.sfx || null;
    this._starfield = deps.starfield || null;
    this._cityLabels = deps.cityLabels || null;
    this._targetReticle = deps.targetReticle || null;
    this._dockingReticle = deps.dockingReticle || null;
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
   * "Horizontal = what (panes)"): true while the ladder is engaged ON THE
   * WORKBENCH FLOOR (F1) with at least one pane dep to page. WheelRouter
   * consults this per HORIZONTAL-dominant wheel event (|deltaX| > |deltaY|)
   * before it claims the event away from the zoom feed — never per frame,
   * never for a vertical event. Everywhere else (other floors, disengaged,
   * no panes) the router leaves the axis exactly as shipped. Reads the core
   * floor through `currentFloor()` (a getState snapshot — event-rate only).
   * @returns {boolean}
   */
  wantsPaneSwipe() {
    if (!this._engaged || !(this._refit || this._library)) return false;
    return this.currentFloor() === 1;
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
   * is their own CSS variable, not this grammar. Guards: disengaged, off-F1
   * or an unknown `toward` → null and no pane is touched; an absent pane dep
   * is skipped, never thrown on. Like closeTopPane(), NOT a ladder input for
   * adaptHoldoff (a 270 ms pane yaw, no floor flight).
   * @param {{ tMs?: number, toward: 'left'|'right' }} arg
   * @returns {'open-refit'|'close-refit'|'open-library'|'close-library'|null}
   *   the action taken (null = nothing to do)
   */
  pagePane({ toward } = {}) {
    if (!this._engaged || this.currentFloor() !== 1) return null;
    const lib = this._library, r = this._refit;
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
    if (!this._engaged || this._floorApplied !== 1) return;
    if (typeof this._viewStore.setPanes !== 'function') return;
    const isOpen = (p) => !!(p && typeof p.isOpen === 'function' && p.isOpen());
    this._viewStore.setPanes({ refit: isOpen(this._refit), library: isOpen(this._library) });
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
    this._engaged = true;
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
    // D5: the F1 room as the player left it — the panes re-open at ENGAGE on
    // the hull (the SHOP return; a continued run), never at a ride arrival.
    if (s.floor === 1) this._restorePanes();
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
    if (this._proxNet && this._proxNet.deactivate) this._proxNet.deactivate();
    if (this._sdaFloor && this._sdaFloor.deactivate) this._sdaFloor.deactivate();
    if (this._hullcam && this._hullcam.deactivate) this._hullcam.deactivate();
    // Wave 5 (2): the REFIT pane closes with the ladder — tab hidden, pane
    // shut (its own close() fires the D10 open-signal false edge).
    if (this._refit) {
      if (this._refit.setEnabled) this._refit.setEnabled(false);
      if (this._refit.close) this._refit.close();
    }
    // Wave 5 (Session B): the TECH LIBRARY pane closes with the ladder too.
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
          if (this._sfx && this._sfx.onCross) this._sfx.onCross(d.direction);
          this._startRide(d.toFloor, d.entryZ01, CROSS_RIDE_MS, tMs, true);
          break;

        case 'ride':
          // G3 flick-to-wall soft tick (LadderSfx only sounds kind 'flickWall').
          if (this._sfx && this._sfx.onRide) this._sfx.onRide(d.kind);
          // D5: a flick-to-wall ride ends the drive whose ramp-up moves just
          // landed — the working position rolls back to before that drive.
          // The flick's direction is the wall it landed on (lower edge = in).
          if (d.kind === 'flickWall') this._rollBackDrive(tMs, d.entryZ01 <= 0.5 ? -1 : 1);
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
    // F1 TECH LIBRARY pane (Wave 5 Session B): keyed EXACTLY like `refit` —
    // enable the edge tab on floor 1, disable AND close anywhere else. Its
    // close() fires the pane's own onOpenChange edge (the calm cap + the
    // camera inset release ride that, never a controller signal).
    if (this._library) {
      if (floor === 1) {
        if (this._library.setEnabled) this._library.setEnabled(true);
      } else {
        if (this._library.setEnabled) this._library.setEnabled(false);
        if (this._library.close) this._library.close();
      }
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
   * (S4 serial wiring). F2's 'approach-autopilot' remains a follow-up.
   * @private
   */
  _dispatchVerb(verb) {
    if (verb === 'plan-transfer' && this._navcom && this._navcom.planTransfer) {
      this._navcom.planTransfer();
    }
    // F3 Space verb (FloorContract PROX NET row): commit the selected
    // insertion point — ProxNetFloor.approach() → onApproach → autopilot.
    if (verb === 'approach' && this._proxNet && this._proxNet.approach) {
      this._proxNet.approach();
    }
    // F5 Space verb: flip the SDA chart lens (VALUE ↔ THREAT).
    if (verb === 'flip-lens' && this._sdaFloor && this._sdaFloor.flipLens) {
      this._sdaFloor.flipLens();
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
