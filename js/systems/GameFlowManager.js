/**
 * GameFlowManager.js — Manages game state transitions, event wiring,
 * save/load orchestration, and all game flow logic.
 * Extracted from main.js (Session 9, Phase 2C).
 * @module systems/GameFlowManager
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState, GameStates } from '../core/GameState.js';
import { getMissionProgress, isGuidedChapterNumber } from '../core/missionProgress.js';
import timerManager from './TimerManager.js';
import { CameraViews } from './CameraSystem.js';
import { scoringSystem, computeSaleValue } from './ScoringSystem.js';
import { audioSystem } from './AudioSystem.js';
import { persistenceManager } from './PersistenceManager.js';
import { powerDistribution } from './PowerDistribution.js';
import { targetSelector } from './TargetSelector.js';
import { kesslerSystem } from './KesslerSystem.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { DebrisField } from '../entities/DebrisField.js';
import { trawlManager } from './TrawlManager.js';
import { openingDance } from './OpeningDance.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { computeStartOrbit } from './startOrbitMath.js';
import { regimeFromStartOrbit } from '../entities/CatalogConverter.js';
import { settingsManager } from './SettingsManager.js';
import { TransferTrip } from './TransferTrip.js';
import { buildWhereNextRows, STAY_ID, CALL_ID, OPEN_LINE, BERTH_LINE, BERTH_MISSION_LINE, STUCK_CALL_LINE } from './WhereNextRows.js';
import { salvageGasKg } from './ResourceSystem.js';
import { UPGRADES } from '../ui/ShopScreen.js';
import { upgradePrereqsMet, upgradeCostNow } from '../ui/shopGating.js';
import { cityLabels } from '../scene/CityLabels.js';
import { launchCameo, padFor, LAUNCH_FLASH_S } from '../scene/LaunchCameo.js';
import { ambientLaunchScheduler } from './AmbientLaunchScheduler.js';
import { VIEW_INFO_LEVELS } from '../ui/HUD.js';
import {
  resolveEffectRoute,
  RESOURCE_SYSTEM, PLAYER, ARM_MANAGER, SENSOR_EVENT, DAUGHTER_NET, DAUGHTER_NET_EFFECT_TYPE,
  KESSLER_SYSTEM, CAPTURE_NET, RUNTIME, ARM_MANAGER_EVENT, CARGO_SYSTEM,
} from './upgradeEffectRoutes.js';

/**
 * Shop cadence — the depot stop fires at every MISSION boundary, i.e. every
 * DEBRIS_PER_MISSION credited clears. ONE source of truth
 * (Constants.MISSIONS.DEBRIS_PER_MISSION, the same number ScoringSystem's
 * mission counter and missionProgress.js divide by); the three former `% 5`
 * literals here were the T8 "shop cadence hardcoded" trap
 * (docs/ladder/02-traps.md). Exported so test-shop-cadence can pin the
 * equality with ScoringSystem's mission length.
 */
export const SHOP_CADENCE = Constants.MISSIONS.DEBRIS_PER_MISSION;

/**
 * Lane 3c: where the end of a mission leads, in the words of the lines that promise it ("Clear 4 more for ..."): the resupply satellite when
 * it is the stop (flag on, floor 4 there), else today's "depot resupply". `self` may be a test stub without the question (today's words).
 * @param {object} self a GameFlowManager @returns {string}
 */
function stopWords(self) {
  return self && typeof self._satelliteIsTheStop === 'function' && self._satelliteIsTheStop() ? 'the resupply satellite' : 'depot resupply';
}

export class GameFlowManager {
  constructor() {
    /** @type {boolean} */
    this.paused = false;

    /** @type {object|null} */
    this.approachTarget = null;

    /** @type {boolean} */
    this.approachComplete = false;

    /** @type {number|null} */
    this._shopTimeoutId = null;

    /**
     * Wave 5 Session K (plan D-B / D-E — one shop): true from the
     * WORKBENCH_STOP this manager emits (the ladder-on-gameplay depot entry,
     * `_stopAtWorkbench`) until the hub's WORKBENCH_RESUME (both drawers
     * closed) or any exit from gameplay. `isDepotStopPending()` reads it
     * alongside the dwell timer so the mission-keyed onsets (MissionCoach, the
     * bosses) hold through the break exactly as they held through the
     * full-screen SHOP. Never set with the ladder off.
     */
    this._workbenchBreak = false;

    /**
     * Wave 5 Session E (08-workbench §5 D3): the open depot INVITATION, or
     * null — `{ chapter, debrisCleared }` from the boundary catch that opened
     * it. In-memory only (never saved): a reload simply has no invitation
     * open. Closed by any SHOP entry ('entered'), the next credited catch
     * ('lapsed' — owner decision 2), terminal states and resetGame ('reset').
     */
    this._depotInvitation = null;

    /**
     * u1-resupply-stop D1 (owner ruling 2026-10-17, DECISIONS §26): true while the ship is "at the resupply stop"
     * — the only time credits may be spent or earned in the shop. OPENS when a mission is completed
     * (`_onMissionBoundary`), when GAMEOVER_CONTINUE sends the player to the shop, and when a save made at a mission
     * boundary is continued. CLOSES at the next credited catch, and on game over / win / menu / reset. Nothing else
     * closes it (not the invitation's 'entered', not WORKBENCH_RESUME, not SHOP_DEPLOY). Pushed to the shop through
     * `_setResupplyStop`; read by `atResupplyStop()`. In-memory: a reload re-derives it from the saved mission count.
     */
    this._atResupplyStop = false;

    /**
     * trip-melt D2 (owner 2026-10-19): the burn between missions. A completed mission begins this trip instead of
     * starting the next mission at once; the mission starts (MISSION_START, the next field) when the burn ends. The
     * station unloads nothing (the catches stay where they are parked and the tip furnaces melt them on the trip).
     * Created in `init` once the ship exists. In-memory only: a save holds no trip.
     * @type {TransferTrip}
     */
    this._trip = new TransferTrip();
    /** trip-melt-2 D12a: the boundary count a credit reached during a trip, run after the trip's mission start, or null. */
    this._deferredBoundary = null;
    /**
     * Nets step 3 slice 2b (lane 2b-2, FIELDS_BY_HEIGHT): floor 4 exists and hosts the "where next" list (main.js sets it once the
     * list is built, inside the ladder block). With the flag on and this set, a mission boundary opens the choice instead of
     * flying to `defaultNext()`; with `?ladder=0` (no floor 4) or in a rig that never wired it, `defaultNext()` as before.
     */
    this._whereNextOn = false;

    /**
     * w1-hud-calm review fix (2026-10-05): the first INVITATION pays the
     * first-depot floor and persists FIRST_DEPOT_VISITED, but the player has
     * not come down yet — so the first-visit framing (the REFIT drawer's
     * RECOMMENDED starter chip) is OWED to the next workbench stop.
     * `_stopAtWorkbench` consumes it (read + clear). In-memory only: a reload
     * between the invitation and the visit loses the chip, never the credits.
     */
    this._firstVisitOwed = false;

    /**
     * c2-fifth-catch D2: the next mission's start, held while the credited
     * catch is still sitting at the nose. `{ debrisId, elapsedS, start }` or null,
     * `start` being the continuation that fires the mission transition.
     * Only set for a PARKED credit that crosses a mission boundary with the
     * depot invitation branch live (ladder on). Released by the catch leaving
     * the nose (see `_releaseMissionStart`) or by `update(dt)` once
     * `Constants.MISSIONS.START_AFTER_CATCH_MAX_S` game seconds have passed.
     * In-memory only: a save during the hold is as safe as any Continue (the
     * mission number is derived from `debrisCleared`; loading emits no start).
     * @type {{debrisId: number|string, elapsedS: number, start: () => void}|null}
     */
    this._pendingMissionStart = null;

    /**
     * t1-stranded D1/D2: seconds of running gameplay the ship has been stranded (both gas tanks empty, no way to
     * buy a resupply — mid-mission, or at the stop with too little to pay — nothing under way that could pay). Ends the run at Constants.STRANDED_GRACE_S.
     * @type {number}
     */
    this._strandedS = 0;
    /**
     * Lane 3c (C3): this stranded spell has already been offered the call to the resupply satellite (the line was said and the list opened,
     * or she was choosing). Declined (she picked Stay), the countdown runs as it always did. Cleared when the spell ends and on a new run.
     * @type {boolean}
     */
    this._callOffered = false;

    /** @type {number|null} Timer for delayed score-group HUD activation in ORBITAL_VIEW */
    this._scoreGroupTimer = null;

    /** @type {object|null} */
    this._refs = null;

    /** @type {boolean} Guard: elevator contract win already triggered */
    this._elevatorWinTriggered = false;

    /** @type {boolean} S1 Fix L2: Guard against duplicate GAME_WIN handling */
    this._winTriggered = false;

    /** @type {boolean} Tracks wireframe assessment state (Batch 3 — replaces debrisWireframe.hasAssessedTarget()) */
    this._wireframeAssessed = false;

    // --- First Experience guidance state ---
    /** @type {boolean} First ORBITAL_VIEW entry this game (for auto-target + opening comms) */
    this._firstOrbitalView = true;
    /** @type {boolean} deep-polish-4: suppress the menu→sim intro zoom on the
     *  next new-game ORBITAL_VIEW entry (set when the player SKIPS the menu
     *  departure — MENU_START { skipped:true }). Consumed once, then reset. */
    this._suppressIntroZoom = false;
    /** @type {Set<string>} One-shot comms already sent this game */
    this._firstTimeComms = new Set();

    // --- Onboarding gating (Guidance cleanup, Phase 0) ---
    // Track whether the OnboardingDirector pipeline is running (used by opening
    // comms gating below). The reward-first spine (.kilo plan) hands target
    // acquisition to AutoLockController from the first frame, so the old
    // `target`-beat deferral + auto-target are gone (AutoLockController owns it).
    /** @type {boolean} */
    this._onboardingRunning = false;
    eventBus.on(Events.ONBOARDING_STARTED, () => {
      this._onboardingRunning = true;
    });
    eventBus.on(Events.ONBOARDING_COMPLETE, () => {
      this._onboardingRunning = false;
    });
    if (Events.GAME_RESET) {
      eventBus.on(Events.GAME_RESET, () => {
        this._onboardingRunning = false;
      });
    }
  }

  /**
   * Initialize with references to required game systems and entities.
   * Must be called after all systems are created in init().
   *
   * Remaining _refs (6):
   *   Core:     player, debrisField, armManager, cameraSystem
   *   Screens:  shopScreen (_hasUpgrade, saveGame)
   *   Systems:  resourceSystem
   *
   * Imported singletons (not in _refs):
   *   targetSelector  — imported from TargetSelector.js
   *   kesslerSystem   — imported from KesslerSystem.js
   *   trawlManager    — imported from TrawlManager.js (active check for deployTrawl guard)
   *
   * Decoupled via EventBus (17 removed):
   *   Screens:  menuScreen, gameOverScreen → GAME_STATE_CHANGE
   *             briefingScreen → GAME_STATE_CHANGE (payload.targets)
   *   UI:       hud → GAME_STATE_CHANGE + VIEW_CONFIG_CHANGE + HUD_TARGET_CLICK + PAUSE events
   *   Overlays: targetReticle, navSphere, dockingReticle, orbitMFD
   *             → VIEW_CONFIG_CHANGE / GAME_STATE_CHANGE / HUD_TARGET_CLICK
   *             debrisWireframe → TARGET_SELECTED/CLEARED + GAME_RESET + DEBRIS_REMOVED + WIREFRAME_ASSESSED
   *   Systems:  sensorSystem → SENSOR_UPGRADE (from applyUpgradeEffect)
   *             tutorialSystem → GAME_STATE_CHANGE + PERSISTENCE_LOADED
   *             commsSystem → GAME_STATE_CHANGE + COMMS_SEND + GAME_RESET
   *             inputManager → ARM_RETURNED + ARM_EXPENDED
   *             subsystemEvents → PERSISTENCE_LOADED + PERSISTENCE_GATHER
   *             kesslerSystem → COLLISION_GAME_OVER + GAME_RESET + GAMEOVER_CONTINUE (shield self-managed)
   *             trawlManager → GAME_STATE_CHANGE + TRAWL_START (self-managed toggle + auto-start)
   *
   * @param {object} refs
   */
  init(refs) {
    this._refs = refs;
    this._syncTripDeps();
    // u1-resupply-stop D1: the real game starts mid-mission — the shop's trade gate is closed until the first
    // completed mission (a shop that was never told stays permissive, so bare test rigs are unaffected).
    this._setResupplyStop(false);
  }

  /**
   * u1-resupply-stop D1: is the ship at the resupply stop right now (a completed mission, or the game-over
   * shop, and no credited catch since)? The shop's trade gate and the REFIT chips read this through the
   * shop's pushed flag; tests and the HUD may read it here.
   * @returns {boolean}
   */
  atResupplyStop() {
    return this._atResupplyStop;
  }

  /**
   * Is `count` credited clears exactly a completed mission (a positive multiple of the mission length)? The same
   * pure getMissionProgress pairing `_startMissionAfterCredit` uses — no second modulo.
   * @param {number} count
   * @returns {boolean}
   * @private
   */
  _isMissionBoundaryCount(count) {
    const { perMission, debrisUntilShop } = getMissionProgress(count);
    return count > 0 && debrisUntilShop === perMission;
  }

  /**
   * The ONE writer of the resupply-stop state: the flag here plus the guarded push to the shop
   * (many test rigs have no shop or a stub without the setter).
   * @param {boolean} open
   * @private
   */
  _setResupplyStop(open) {
    this._atResupplyStop = !!open;
    const shop = this._refs && this._refs.shopScreen;
    if (shop && typeof shop.setResupplyStop === 'function') shop.setResupplyStop(this._atResupplyStop);
    this._pushTradeWording();
  }

  /**
   * Nets step 3 slice 3 (S7; FEATURE_FLAGS.FIELDS_BY_HEIGHT; DECISIONS §33 row 7): is the resupply SATELLITE where buying happens?
   * True with the flag on AND floor 4 there to ask on (the "where next" list: with `?ladder=0` there is no list, so no satellite to
   * fly to and today's stop after every mission stays). Read live (the flags are flipped per rig).
   * @returns {boolean}
   * @private
   */
  _satelliteIsTheStop() {
    const reg = this._refs && this._refs.fieldRegistry;
    return !!(reg && typeof reg.isOn === 'function' && reg.isOn() && this._whereNextOn);
  }

  /** @private Tell the shop which place its trade refusal names (the stop after a mission, or the satellite). Guarded: many rigs have none. */
  _pushTradeWording() {
    const shop = this._refs && this._refs.shopScreen;
    if (shop && typeof shop.setSatelliteStop === 'function') shop.setSatelliteStop(this._satelliteIsTheStop());
  }

  // ==========================================================================
  // VIEW CONFIG
  // ==========================================================================

  /** Apply current camera-view info-level config to HUD + self-managing overlays. */
  applyViewConfig() {
    const { cameraSystem } = this._refs;
    const view = cameraSystem ? cameraSystem.getView() : 'CHASE';
    const config = VIEW_INFO_LEVELS[view] || VIEW_INFO_LEVELS.CHASE;
    // HUD + overlays self-manage visibility via this event
    eventBus.emit(Events.VIEW_CONFIG_CHANGE, config);
  }

  // ==========================================================================
  // STATE TRANSITIONS
  // ==========================================================================

  /**
   * Transition to a new game state, managing UI visibility.
   * @param {string} state - Target GameState
   * @param {*} [payload] - Optional data
   */
  transitionToState(state, payload) {
    const {
      cameraSystem, debrisField, player,
    } = this._refs;
    // targetSelector: imported singleton
    // kesslerSystem: imported singleton
    // trawlManager: self-manages via GAME_STATE_CHANGE
    // debrisWireframe: self-manages via TARGET_SELECTED/CLEARED + GAME_RESET

    const from = gameState.currentState;

    // Wave 5 Session K (plan D-B — ONE SHOP; the granted GFM lift, site 1 of
    // 4): with the ladder on, GAMEPLAY never enters the SHOP GameState. Every
    // caller that asks for it from a gameplay state — the chapter 1–3 boundary
    // dwell (site 2 calls the same method directly), the B key (InputManager),
    // the glass STORE chip (main.js openShop), any legacy timer — is redirected
    // into the WORKBENCH BREAK: one event, the hub rides the player down to the
    // workbench and opens the REFIT drawer (the shop). Not gameplay (the
    // GAME_OVER → SHOP continue) or ladder off → the shipped state flip below,
    // byte-identical.
    if (state === GameStates.SHOP && this._ladderOn() && gameState.isGameplay()) {
      this._stopAtWorkbench(false);
      return;
    }
    // The break is a GAMEPLAY condition: any exit from gameplay (GAME_OVER /
    // WIN / the pause menu's MENU) ends it — the ladder disengages and closes
    // the drawer on its own; nothing may stay pending into the next run.
    if (state === GameStates.GAME_OVER || state === GameStates.WIN || state === GameStates.MENU) {
      this._workbenchBreak = false;
      this._setResupplyStop(false);   // u1-resupply-stop D1: game over / win / menu end the stop
      this._trip.abort();             // trip-melt D9: a trip belongs to the run that just ended (the mission is NOT started)
      this._deferredBoundary = null;  // trip-melt-2 D12a
      this._clearBerth();             // slice 3: nor does a berth at the resupply satellite
    }

    // First-depot visit signal, computed BEFORE the flag is persisted so the
    // shop can render its one-time framing/⭐ on the actual first visit. Passed
    // through GAME_STATE_CHANGE (the flag write below would otherwise flip to
    // true before ShopScreen reads storage in its own handler).
    let firstDepotVisit = false;

    // Clear pending shop timeout on terminal states (and any open depot invitation)
    if (state === GameStates.GAME_OVER || state === GameStates.WIN) {
      if (this._shopTimeoutId) { timerManager.clear(this._shopTimeoutId); this._shopTimeoutId = null; }
      this._closeDepotInvitation('reset');
      this._pendingMissionStart = null;   // c2-fifth-catch D2: a held start belongs to the run that just ended
    }

    // Force state for reset scenarios
    if (from === state && state === GameStates.MENU) {
      gameState.currentState = GameStates.MENU;
    } else if (from !== state) {
      // Use the state manager for validation where possible
      const valid = gameState.setState(state, payload);
      if (!valid) {
        console.warn(`[GameFlow] Rejected transition: ${from} → ${state}`);
        return; // Don't force invalid transitions
      }
    }

    switch (state) {
      case GameStates.MENU:
        // HUD self-manages visibility via GAME_STATE_CHANGE
        this.paused = false;
        break;

      case GameStates.BRIEFING: {
        // HUD self-manages visibility via GAME_STATE_CHANGE
        // BriefingScreen receives targets via GAME_STATE_CHANGE payload
        const targets = debrisField.getTargetList(player.getOrbitalElements());
        payload = { targets, playerOrbit: player.getOrbitalElements() };
        break;
      }

      case GameStates.ORBITAL_VIEW:
        // HUD self-manages visibility via GAME_STATE_CHANGE
        this.applyViewConfig();
        this.approachTarget = null;
        this.approachComplete = false;

        // Activate score-group HUD panel after a short delay (pacing).
        // Gated on _firstOrbitalView so the timer runs exactly once — on the
        // player's very first ORBITAL_VIEW entry of a new game. This prevents:
        //   (a) stacking duplicate timers on SHOP → ORBITAL_VIEW returns
        //   (b) re-firing on saved-game continues (MENU_CONTINUE sets
        //       _firstOrbitalView = false and emits HUD_GROUP_ACTIVATE directly)
        if (this._firstOrbitalView) {
          // deep-polish-4: menu→sim intro settle — chase offset starts scaled
          // and eases straight into formation (no dead hold). Skipped entirely
          // under reduced motion (a11y) or when the player skipped the menu
          // departure, so the scale stays at 1.0 in those paths.
          const reduced = this._prefersReducedMotion();
          if (cameraSystem) {
            if (reduced || this._suppressIntroZoom) {
              cameraSystem.skipIntroZoom();
            } else {
              cameraSystem.startIntroZoom();
            }
          }
          this._suppressIntroZoom = false;

          // Comms boot trickle — messages arrive during the ~1.5-2 s settle.
          // Retimed off the removed 4 s hold; staggered so nothing arrives as a
          // wall. owner=this for grouped teardown; inner guards no-op on state
          // change (these are first-run intro callbacks).
          // T6: "EVA crew clear." lands first (handoff+~0.3s) — the acknowledgment
          // that the astronaut cleared the hull, which is what UNLOCKS the power-up
          // (the existing "Powering up..." boot line then reads as the result).
          // Tagged _onboarding so it passes the tier-0 suppression gate during the
          // OnboardingDirector intro (raw HOUSTON lines are muted at tier 0).
          timerManager.setTimeout(() => {
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'HOUSTON', channel: 'CMD', priority: 'info',
              text: 'EVA crew clear.', _onboarding: true,
            });
          }, 300, { owner: this });
          timerManager.setTimeout(() => {
            eventBus.emit(Events.COMMS_OPENED);
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'SYSTEM', channel: 'CMD', priority: 'info',
              text: 'Comm link online',
            });
          }, 800, { owner: this });
          timerManager.setTimeout(() => {
            // De-collision (wave0): this line's job is "systems coming alive"
            // flavor ONLY. The telemetry call-out belongs to the Director's
            // `handshake` beat (telemetry + "Reticle is live" instruction),
            // which lands ~1.3 s later — do NOT reintroduce a telemetry clause
            // here or two near-identical lines stack in the comms panel.
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'HOUSTON', channel: 'CMD', priority: 'info',
              text: 'Comms are up, Cowboy. Loud and clear.', _onboarding: true,
            });
          }, 1700, { owner: this });
          timerManager.setTimeout(() => {
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'SYSTEM', channel: 'CMD', priority: 'info',
              text: 'Sensor array calibrating...',
            });
          }, 2600, { owner: this });

          // Score-group HUD panel powers on during the settle so the arrival is
          // one gesture (overlaps the camera easing into formation). Re-keyed
          // off the removed VLEO hold to a fixed settle-aligned delay.
          if (this._scoreGroupTimer !== null) timerManager.clear(this._scoreGroupTimer);
          this._scoreGroupTimer = timerManager.setTimeout(() => {
            this._scoreGroupTimer = null;
            eventBus.emit(Events.HUD_GROUP_ACTIVATE, { group: 'score' });
          }, 2000, { owner: this });
        }

        // Phase 2: Auto-start trawl — TrawlManager self-manages via GAME_STATE_CHANGE (Batch 3)
        break;

      case GameStates.APPROACH:
        // HUD self-manages visibility via GAME_STATE_CHANGE
        this.applyViewConfig();
        // Switch to target lock camera if we have a target
        if (this.approachTarget && cameraSystem) {
          const targetCart = orbitToSceneCartesian(this.approachTarget.orbit);
          const targetPos = new THREE.Vector3(targetCart.position.x, targetCart.position.y, targetCart.position.z);
          cameraSystem.setLockTarget(targetPos);
        }
        break;

      case GameStates.INTERACTION:
        // HUD self-manages visibility via GAME_STATE_CHANGE
        this.applyViewConfig();
        break;

      case GameStates.SHOP:
        // HUD self-manages visibility via GAME_STATE_CHANGE
        // u1-resupply-stop D4: the first-visit floor is paid at the resupply stop only (a mid-mission look at the
        // full-screen shop pays nothing — the first invitation pays it, and the framing is owed to the next stop).
        firstDepotVisit = this._atResupplyStop ? this._applyFirstDepotFloor() : false;
        // Any depot entry (the doorway, the B key, the iPad chip) takes the
        // open invitation up — the notch glow ends (Wave 5 Session E).
        this._closeDepotInvitation('entered');
        break;

      case GameStates.GAME_OVER:
        // t1-stranded D4: the ONLY save that carries the game-over flag; menu CONTINUE reads it
        this.saveGame({ gameOver: true }); // Persist progress before game over
        // HUD self-manages visibility via GAME_STATE_CHANGE
        break;

      case GameStates.WIN:
        this.saveGame(); // Persist final score on victory
        // HUD self-manages visibility via GAME_STATE_CHANGE
        break;
    }

    // Notify self-managing UI screens and overlays
    eventBus.emit(Events.GAME_STATE_CHANGE, { from, to: state, payload, firstDepotVisit });

    console.log(`[GameState] ${from} → ${state}`);
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  /** Wire up all EventBus handlers for game flow events. */
  setupEventHandlers() {
    const {
      debrisField, player, armManager, cameraSystem,
      resourceSystem,
      shopScreen,
    } = this._refs;
    // targetSelector: imported singleton
    // kesslerSystem: imported singleton
    // debrisWireframe: self-manages via events (Batch 3)
    // trawlManager: self-manages via events (Batch 3)

    // ==================================================================
    // MENU EVENTS
    // ==================================================================

    // Menu → Start (skip briefing, go straight to orbital gameplay)
    eventBus.on(Events.MENU_START, (data) => {
      // keepOpeningDance: inferred HERE, at the call site, where the inference
      // is actually sound — at MENU_START "a dance is running" means exactly
      // "the bind a few lines below takes it over", so resetGame must not land
      // it on endState. Every other caller (CONTINUE, GAMEOVER retry/menu)
      // leaves it false. It must NOT be a bare `true`: on a flag-off, reduced
      // motion or ?shot boot no dance is running, and resetGame is the ONLY
      // production endState call — passing true there booted the daughters
      // stowed at α 0 instead of the one open pose.
      this.resetGame({ keepOpeningDance: openingDance.isActive() });
      // deep-polish-4: if the player SKIPPED the menu departure, suppress the
      // sim intro zoom too (respect the skip). Set AFTER resetGame(), which
      // clears the flag. Read once by the ORBITAL_VIEW enter below.
      this._suppressIntroZoom = !!(data && data.skipped);
      this._applyStartLocation();   // place ground track over the player's home region
      this._stageOpeningLight();    // fresh M1 spawn opens sunlit (new-game paths only)
      gameState.currentState = GameStates.MENU; // Allow transition from MENU
      persistenceManager.backupSave(); // F1 save-guard: back up before New Game clears it
      persistenceManager.deleteSave(); // New Game clears any existing save
      // Opening dance (2026-09-16): the sim ship joins the unfold HERE — after
      // resetGame() (whose snapFlowerToStow / furl reset just ran) and in the
      // same tick, so no frame draws a deployed ship after the cut. A skipped
      // menu still starts the game side from the cut-time state (2.70 s). When
      // the dance is NOT running (?shot / harness, reduced motion, flag off),
      // resetGame() already landed the ship on openingDance.endState().
      if (openingDance.isActive()) {
        openingDance.advanceClockToCutTime();
        openingDance.bindShip(this._refs.player);
      }
      this.transitionToState(GameStates.ORBITAL_VIEW);
    });

    // Menu → Fast Start (LEGACY / reserved hook, 2026-07 menu overhaul).
    // The KeyF "fast start" shortcut was removed from MenuScreen — no emitter
    // remains for MENU_FAST_START. This handler is kept as a reserved hook
    // (matching the codebase convention of retaining unused Events constants,
    // e.g. PERSISTENCE_SAVED) and is byte-identical to MENU_START above.
    eventBus.on(Events.MENU_FAST_START, () => {
      // NOT keepOpeningDance: unlike MENU_START this reserved hook never binds
      // the sim ship to the dance, so it must land on the finished pose.
      this.resetGame();
      this._applyStartLocation();   // place ground track over the player's home region
      this._stageOpeningLight();    // fresh M1 spawn opens sunlit (new-game paths only)
      gameState.currentState = GameStates.MENU;
      persistenceManager.backupSave(); // F1 save-guard: back up before New Game clears it
      persistenceManager.deleteSave(); // New Game clears any existing save
      this.transitionToState(GameStates.ORBITAL_VIEW);
    });

    // Menu → Continue (load saved game)
    eventBus.on(Events.MENU_CONTINUE, () => {
      const save = persistenceManager.load();
      if (!save) {
        // No valid save — fall back to new game
        eventBus.emit(Events.MENU_START);
        return;
      }
      audioSystem.init();
      audioSystem.resume();

      // Clean slate first, then restore saved progression
      this.resetGame();
      this._applyStartLocation();   // place ground track over the player's home region
      gameState.currentState = GameStates.MENU; // Allow transition from MENU

      // Skip first-experience guidance for returning players
      // (must be AFTER resetGame which resets these flags)
      this._firstOrbitalView = false;
      this._firstTimeComms = new Set([
        'orbital_view_opening', 'first_target',
        'first_capture', 'drift_recovery',
      ]);

      // Restore scoring state
      scoringSystem.restore({
        totalScore: save.totalScore,
        credits: save.credits,
        debrisCleared: save.debrisCleared,
        currentStreak: 0,
        bestStreak: save.stats?.bestStreak || 0,
        debrisByTier: save.stats?.debrisByTier || { data: 0, deorbit: 0, capture: 0 },
      });

      // Restore upgraded resource capacities and the saved gas levels (s1-gas-survives-load; battery starts at half)
      resourceSystem.restore(save.resourceMaxes || {});

      // Restore power distribution allocations
      powerDistribution.restore(save.power || null);

      // Restore shop purchase history
      shopScreen.restorePurchases(save.upgrades || []);

      // Restore elevator contract mass (Phase 5)
      if (save.contractMassKg && shopScreen) {
        shopScreen.setContractMass(save.contractMassKg);
        // Emit update so HUD mini-indicator reflects restored state
        eventBus.emit(Events.CONTRACT_UPDATE, {
          contractMassKg: save.contractMassKg,
          targetMassKg: (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000,
        });
      }

      // Subsystem degradation trackers: SubsystemEvents self-restores via PERSISTENCE_LOADED

      // Re-apply all upgrade effects to game systems (PlayerSatellite, SensorSystem,
      // ArmManager, KesslerSystem). ResourceSystem maxes (xenonMax, coldGasMax,
      // batteryMax) — plus the power-infra effects supercapUpgrade/rtgPower/
      // powerBeaming — are already restored by resourceSystem.restore() above,
      // so the { restore: true } route skips their RESOURCE_SYSTEM leg to avoid
      // double-counting the cumulative += additions. Non-resource legs (e.g.
      // supercapUpgrade → player MPD-cooling flag) still re-apply.
      shopScreen.forEachPurchasedUpgrade((data) => {
        this.applyUpgradeEffect(data, { restore: true });
      });

      // Item 100: restore the launch-speed dial AFTER the upgrade replay so a
      // saved speed clamps to the restored spring tier's ceiling (old saves
      // carry no key → the clamped default stands).
      if (typeof save.launchSpeed === 'number' && this._refs.armManager) {
        this._refs.armManager.setFleetLaunchSpeed(save.launchSpeed);
      }

      // Nets step 3 lane 3f (§34 row 10): the daughters' ion fuel and cold gas, back on the daughters they were saved from. AFTER
      // resetGame's armManager.reset() (ArmUnit.reset() fills both tanks) and AFTER the upgrade replay (armFuelMax can raise a full
      // tank). An old save, and a game-over save, carry none: the tanks stay full, as they always were.
      if (save.gameOver !== true && Array.isArray(save.daughters) && this._refs.armManager
        && typeof this._refs.armManager.restoreSupplyState === 'function') {
        this._refs.armManager.restoreSupplyState(save.daughters);
      }

      // Rollout backfill: FIRST_DEPOT_VISITED is newer than some saves. Without
      // this, _applyFirstDepotFloor() (gated on that flag) would fire its
      // one-time "first cleanup contract settled" credit floor on the next depot
      // visit of every PRE-EXISTING player, mutating veteran wallets and showing
      // new-pilot framing. A loaded save with any progression (debris cleared or
      // upgrades bought) is by definition past its true first depot, so mark the
      // flag seen for them. Genuinely fresh profiles start via MENU_START and
      // still earn the bonus on their real first depot.
      // Nets step 3 slice 3, lane 3c (C4c, owed from the 3a review): with the satellite as the stop the first stop is the first BERTH, and a
      // reload before it must not mark it visited (the 600 floor still pays there). A berth marks it by paying (`_applyFirstDepotFloor`).
      const pastFirstDepot = !this._satelliteIsTheStop() && ((save.debrisCleared || 0) > 0
        || (Array.isArray(save.upgrades) && save.upgrades.length > 0));
      if (pastFirstDepot && !persistenceManager.getCeremonyFlag('FIRST_DEPOT_VISITED')) {
        persistenceManager.setCeremonyFlag('FIRST_DEPOT_VISITED', true);
      }

      // Sync to gameState
      gameState.debrisCleared = save.debrisCleared || 0;
      gameState.score = save.totalScore || 0;

      // Nets step 3 slice 2b (FIELDS_BY_HEIGHT): resetGame put her at the start altitude; with the flag on, the field the
      // save was made in puts her back at ITS height with ITS remaining pieces (DebrisField lays them out on its next
      // update: a load fires no MISSION_START). A game-over save restarts at the start field (the CONTINUE rule below).
      gameState.shipDays = Number.isFinite(save.shipDays) && save.shipDays > 0 ? save.shipDays : 0;
      if (save.gameOver !== true && this._refs.fieldRegistry && this._refs.fieldRegistry.isOn()) {
        // (the scorer's own, UNCAPPED mission number - the one MISSION_START carries and the registry's `at` follows; the arc's
        // `missionNum` stops at 12, so past 60 catches a boundary save would never look owed)
        this._refs.fieldRegistry.restore(save.fields, { missionNumber: scoringSystem.getMissionNumber() });
      }

      // Notify self-managing systems that a saved game was loaded
      // (TutorialSystem listens to skip tutorial for veterans)
      eventBus.emit(Events.PERSISTENCE_LOADED);

      // t1-stranded D4: a save written on entering GAME_OVER is continued by the SAME rule as the game-over
      // screen's CONTINUE — half the credits, fresh mission, start-fill gas, upgrades kept, then the shop.
      // The save is loaded exactly as above, then this hands off to the very same GAMEOVER_CONTINUE listeners
      // (no welcome-back comms, no flight route). MENU -> SHOP is not a valid transition and GAME_OVER -> SHOP
      // is, so the state is set by hand first (as at the top of this handler). The listener's own save carries
      // no flag, so a second menu CONTINUE does not halve again.
      if (save.gameOver === true) {
        gameState.currentState = GameStates.GAME_OVER;
        this._continueAfterGameOver();
        return;
      }

      // u1-resupply-stop D1: a save made at a mission boundary (a multiple of DEBRIS_PER_MISSION cleared, no catch
      // since) reloads AT the stop — closing the game must not close the shop. Any other count reloads mid-mission.
      // (resetGame above closed it; the gameOver save returned earlier and GAMEOVER_CONTINUE opens its own stop.)
      // F2: a save written inside the game-over shop carries `resupplyStop: true` (0 cleared, so the count cannot
      // say); old saves without the key keep the boundary-count rule.
      // Nets step 3 slice 3 (S7): with the satellite as the stop a boundary count opens nothing (the stop is at the satellite): only a save
      // that says so (`resupplyStop`: written berthed, or inside the game-over shop) or a registry that loaded berthed reopens buying.
      const loadedReg = this._refs.fieldRegistry;
      const berthedAtLoad = !!(loadedReg && loadedReg.isOn() && loadedReg.isBerthed());
      this._setResupplyStop(berthedAtLoad || save.resupplyStop === true
        || (!this._satelliteIsTheStop() && this._isMissionBoundaryCount(gameState.debrisCleared)));

      // Returning players already know what the score bar is — activate it
      // immediately (no 2 s settle delay). The ORBITAL_VIEW timer is gated behind
      // _firstOrbitalView (set false above) so it won't fire for this path.
      eventBus.emit(Events.HUD_GROUP_ACTIVATE, { group: 'score' });

      // Continue routes straight to flight (like new game) — no BRIEFING card
      // on startup. _firstOrbitalView is false (set above), so the ORBITAL_VIEW
      // entry skips the new-player intro zoom / boot trickle / score-group timer.
      // MENU → ORBITAL_VIEW is a valid transition (js/core/GameState.js:27).
      this.transitionToState(GameStates.ORBITAL_VIEW);

      // Welcome-back comms uplink — mission context (mission #, objective)
      // arrives as a short HOUSTON trickle AFTER the handoff, replacing the
      // BRIEFING card's decision UI. Emitted after the transition so CommsSystem
      // has self-started on GAME_STATE_CHANGE → ORBITAL_VIEW (js/systems/CommsSystem.js:404).
      //
      // Mission-arc math is shared with BriefingScreen via getMissionProgress
      // (js/core/missionProgress.js) so the comms line can never drift from the
      // briefing card. getStats() reads debrisCleared from gameState (set above),
      // so it reflects the restored save.
      const stats = scoringSystem.getStats();
      const { perMission, missionNum, debrisUntilShop } = getMissionProgress(stats.debrisCleared);
      const objectiveText = debrisUntilShop >= perMission
        ? (stopWords(this) === 'depot resupply' ? `Clear ${perMission} debris to reach the depot.` : `Clear ${perMission} debris, then pick your next field on the LEO map.`)
        : `Clear ${debrisUntilShop} more debris for ${stopWords(this)}.`;

      // Both lines tagged _onboarding to pass the tier-0 suppression gate: on
      // continue resetGame()'s GAME_RESET restarts the OnboardingDirector pipeline,
      // so comms may sit at tier 0 when these fire (all non-tagged lines muted,
      // js/systems/commsSuppression.js:59-62). channel: 'HOUSTON' passes at ramp
      // tier 1; the _onboarding tag covers tier 0 (same precedent as the boot
      // trickle's "EVA crew clear." line, GFM:233-238). owner=this for teardown.
      timerManager.setTimeout(() => {
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'HOUSTON', priority: 'info',
          text: `Welcome back, Cowboy. Resuming Mission ${missionNum}.`, _onboarding: true,
        });
      }, 900, { owner: this });
      timerManager.setTimeout(() => {
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'HOUSTON', priority: 'info',
          text: objectiveText, _onboarding: true,
        });
      }, 2200, { owner: this });
    });

    // ==================================================================
    // BRIEFING EVENTS (retry path only — GAMEOVER_RETRY → BRIEFING)
    // ==================================================================

    // Briefing → Approach with selected target
    eventBus.on(Events.BRIEFING_COMMENCE, (data) => {
      if (data.target) {
        const debris = debrisField.getDebrisById(data.target.id);
        if (debris) {
          this.approachTarget = debris;
          this.approachComplete = false;
          targetSelector.setTarget(debris);  // imported singleton
          this.transitionToState(GameStates.APPROACH);
        }
      }
    });

    // Briefing → Free roam (skip to orbital view)
    eventBus.on(Events.BRIEFING_SKIP, () => {
      this.transitionToState(GameStates.ORBITAL_VIEW);
    });

    // ==================================================================
    // SHOP EVENTS
    // ==================================================================

    // Shop → Deploy (back to orbital)
    eventBus.on(Events.SHOP_DEPLOY, () => {
      this.applyUpgrades();
      this.saveGame();
      this.transitionToState(GameStates.ORBITAL_VIEW);

      // Phase 5: Elevator contract win — trigger after returning to gameplay
      // (SHOP → WIN is not a valid state transition, so we go via ORBITAL_VIEW)
      if (this._elevatorWinTriggered) this._fireElevatorWin();
    });

    // Wave 5 Session K (GFM lift, site 4 of 4): the WORKBENCH BREAK ends — the
    // hub emits this when both drawers are closed after a WORKBENCH_STOP (a
    // ride up closes REFIT; leaving gameplay never gets here — the redirect's
    // exit rule releases the flag instead). The new home of what SHOP_DEPLOY
    // did for the full-screen shop: the save (upgrades already applied live on
    // UPGRADE_PURCHASED; `applyUpgrades` is the shipped no-op) and the release
    // of the onset hold. No state flip: the player never left ORBITAL_VIEW.
    // MissionMilestones keeps its own listener for the recap.
    eventBus.on(Events.WORKBENCH_RESUME, () => {
      if (!this._workbenchBreak) return;
      this._workbenchBreak = false;
      this.saveGame();
    });

    // ==================================================================
    // GAME OVER EVENTS
    // ==================================================================

    // Game over → Retry
    eventBus.on(Events.GAMEOVER_RETRY, () => {
      persistenceManager.deleteSave(); // clear stale save on retry
      this.resetGame();
      this._applyStartLocation();   // place ground track over the player's home region
      this.transitionToState(GameStates.BRIEFING);
    });

    // Game over → Main menu
    eventBus.on(Events.GAMEOVER_MENU, () => {
      this.resetGame();
      this.transitionToState(GameStates.MENU);
    });

    // Game over → Continue (roguelite: keep upgrades, 50% credit penalty)
    eventBus.on(Events.GAMEOVER_CONTINUE, () => {
      const carriedCredits = Math.floor(scoringSystem.credits * 0.5);

      // Reset game counters but keep gameState.currentState at GAME_OVER for valid → SHOP transition
      gameState.score = 0;
      gameState.debrisCleared = 0;
      gameState.missionTime = 0;
      gameState.shipDays = 0;   // slice 2b: the FieldRegistry resets itself on this event

      // Reset scoring, then restore carried credits
      scoringSystem.reset();
      scoringSystem.credits = carriedCredits;

      // Reset resources
      resourceSystem.reset();

      // Reset player orbit to starting position (over the player's home region)
      player.orbit.semiMajorAxis = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;
      player.orbit.trueAnomaly = 0;
      this._applyStartLocation();

      // Reset target selection (imported singleton — emits TARGET_CLEARED → DebrisWireframe self-clears)
      // silent: reset clear, not a real target loss — suppresses the audio earcon.
      targetSelector.setTarget(null, { silent: true });

      // Reset arms (field-resets the existing ArmUnit instances — stored upgrades re-applied below)
      if (armManager) armManager.reset();
      // turn-gas D3: nothing of the reel push (gathered Δv, the turn it kicked) survives into the next run
      if (player && player.clearReelPushState) player.clearReelPushState();

      // Opening dance: this is the ONE game-over exit that does its own partial
      // reset instead of calling resetGame(), so it needs the invariant call by
      // hand. A collision inside the ~17.5 s unfold is perfectly possible, and
      // without this the dance would keep running (and its wall clock keep
      // advancing) through the SHOP, then fire its hand-over — pose snap and
      // Houston line — on the first tick after the player redeploys.
      if (player) openingDance.endState(player);

      this.approachTarget = null;
      this.approachComplete = false;

      // Reset camera to default chase view
      if (cameraSystem) cameraSystem.setView(CameraViews.CHASE);

      // KesslerSystem self-resets via GAMEOVER_CONTINUE listener (Batch 3)

      // Re-apply ALL purchased upgrade effects (systems were just reset)
      shopScreen.forEachPurchasedUpgrade((data) => {
        this.applyUpgradeEffect(data);
      });

      // u1-resupply-stop D1/F2: the game-over shop is a resupply stop (open BEFORE the save, so a reload inside
      // the shop keeps it, and before the shop shows, so its first render already trades); it stays open through
      // SHOP_DEPLOY until the first credited catch.
      this._setResupplyStop(true);
      this.saveGame();

      // Comms notification
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Continuing mission. Upgrades retained, 50% credit penalty applied',
        priority: 'high',
      });

      this.transitionToState(GameStates.SHOP);
    });

    // ==================================================================
    // HUD / SCORING / INTERACTION EVENTS
    // ==================================================================

    // HUD target click → select target
    // TargetReticle, NavSphere & HUD self-manage via HUD_TARGET_CLICK listener
    // DebrisWireframe self-manages via TARGET_SELECTED listener (Batch 3)
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      const debris = debrisField.getDebrisById(data.id);
      if (debris) {
        targetSelector.setTarget(debris);  // imported singleton — emits TARGET_SELECTED → wireframe hears it
      }
    });

    // Scoring events
    eventBus.on(Events.SCORE_UPDATE, (data) => {
      gameState.score = data.total;
      gameState.debrisCleared = data.debrisCleared || gameState.debrisCleared;
    });

    // Interaction complete events → return to orbital view
    eventBus.on(Events.INTERACTION_DEORBIT, () => {
      gameState.clearDebris();
      timerManager.setTimeout(() => {
        if (gameState.currentState === GameStates.INTERACTION) {
          // Check for shop visit at every mission boundary (SHOP_CADENCE = the
          // mission length, Constants.MISSIONS.DEBRIS_PER_MISSION — T8 SSOT)
          if (gameState.debrisCleared % SHOP_CADENCE === 0 && gameState.debrisCleared > 0) {
            this.transitionToState(GameStates.SHOP);
          } else {
            this.transitionToState(GameStates.ORBITAL_VIEW);
          }
        }
      }, 1500, { owner: this });
    });

    eventBus.on(Events.INTERACTION_CAPTURE, () => {
      gameState.clearDebris();
      timerManager.setTimeout(() => {
        if (gameState.currentState === GameStates.INTERACTION) {
          if (gameState.debrisCleared % SHOP_CADENCE === 0 && gameState.debrisCleared > 0) {
            this.transitionToState(GameStates.SHOP);
          } else {
            this.transitionToState(GameStates.ORBITAL_VIEW);
          }
        }
      }, 1500, { owner: this });
    });

    // ==================================================================
    // GAME OVER CONDITIONS
    // ==================================================================

    // Shield absorption now self-managed by KesslerSystem (Batch 3).
    // KesslerSystem listens for GAME_KESSLER, GAME_COLLISION, ACTIVE_SAT_COLLISION
    // and emits COLLISION_GAME_OVER only when shields are depleted.
    eventBus.on(Events.COLLISION_GAME_OVER, ({ reason }) => {
      this.transitionToState(GameStates.GAME_OVER, reason);
    });

    eventBus.on(Events.GAME_WIN, () => {
      // S1 Fix L2: Idempotency guard — only handle win once
      if (this._winTriggered) return;
      this._winTriggered = true;
      this.transitionToState(GameStates.WIN);
    });

    // ==================================================================
    // ELEVATOR CONTRACT WIN CONDITION (Phase 5)
    // Second win path: accumulate ELEVATOR_CONTRACT.TARGET_MASS_KG of
    // refined metal via the space elevator to complete the contract.
    // ShopScreen._contributeToElevator() handles credit awards and emits
    // CONTRACT_COMPLETE when mass threshold is reached.  We only flag
    // for the win transition here — SHOP → WIN is invalid, so the actual
    // GAME_WIN fires in the SHOP_DEPLOY handler after returning to
    // ORBITAL_VIEW.
    // Wave 5 Session K (GFM lift, site 4 of 4 — the win RE-HOME): with one
    // shop the contribution comes from the CARGO pane IN gameplay (the drawer
    // holds no GameState), and a boss crossing the target (awardElevatorMass)
    // would otherwise never reach a SHOP_DEPLOY with the ladder on — so when
    // the contract completes in a gameplay state WITH THE LADDER ON the win
    // fires NOW (ORBITAL_VIEW → WIN is legal; 08 §2 "ORBITAL_VIEW → WIN").
    // Ladder off (K review): the shipped flag-and-wait, byte-identical — the
    // full-screen SHOP fires it on SHOP_DEPLOY. Contract-first ordering
    // survives: the flag is set before either fire, `_winTriggered` keeps the
    // WIN single (test-win-race).
    // ==================================================================

    eventBus.on(Events.CONTRACT_COMPLETE, () => {
      this._elevatorWinTriggered = true;
      if (this._ladderOn() && gameState.isGameplay()) this._fireElevatorWin();
    });

    // Resource depletion → game over (from ResourceSystem)
    eventBus.on(Events.RESOURCE_DEPLETED, (data) => {
      if (gameState.isGameplay()) {
        this.transitionToState(GameStates.GAME_OVER, data.reason || 'fuel');
      }
    });

    // ==================================================================
    // UPGRADE / SAVE EVENTS
    // ==================================================================

    // Upgrade purchased
    eventBus.on(Events.UPGRADE_PURCHASED, (data) => {
      this.applyUpgradeEffect(data);
      this.saveGame();
    });

    // ==================================================================
    // CAMERA EVENTS
    // ==================================================================

    // Camera view change → distribute info-level config
    eventBus.on(Events.CAMERA_VIEW_CHANGE, () => {
      this.applyViewConfig();
    });

    // ==================================================================
    // ARM DEPLOYMENT — engineered auto-failure + camera stay-in-place
    // (No auto-switch to TARGET_LOCK: the perpendicular framing caused a
    //  disorienting 90° CW camera swing every time G was pressed.)
    // ==================================================================

    eventBus.on(Events.ARM_DEPLOYED, (data) => {
      // Engineered auto-capture failure: after clearing 8+ debris,
      // give high-tumble targets a failure chance to teach manual piloting
      if (gameState.debrisCleared >= 8) {
        const arm = armManager ? armManager.arms.find(a => a.id === data.armId) : null;
        if (arm && !arm._manualCapture) {
          arm._autoFailChance = 0.7; // 70% chance of auto-failure on high-tumble targets
        }
      }
    });

    // ==================================================================
    // V3 ARM CAPTURE COMPLETION → score + debris removal
    // When an arm returns with captured debris, remove the debris from the
    // field, award score, and notify comms.
    // ==================================================================

    // Dock completion: ArmUnit._updateDocking emits DEBRIS_CAPTURED (parked:true)
    // once the daughter docks with her catch (~3s after arrival).
    //
    // PARK-THE-CATCH (2026-06-06): capturing no longer removes the debris at the
    // mother. The catch parks cinched in the net at the daughter's strut tip
    // (state HOLDING_CATCH) until a future furnace-transfer/breakdown step, which
    // will own the eventual field removal. So there is intentionally NO
    // removeDebris wired to DEBRIS_CAPTURED any more — the event is consumed only
    // as the capture-secured signal (e.g. the first_capture teaching beat, in
    // TeachingSystem). Scoring/salvage still happens in the ARM_RETURNED handler.

    // PARK-THE-CATCH delivery timing (ARCHITECTURE.md:277, Captured-debris lifecycle): salvage + scoring + field
    // removal no longer fire on ARM_RETURNED (dock ARRIVAL). They fire on
    // CATCH_PROCESSED — emitted by ArmUnit._updateHoldingCatch once the parked
    // catch finishes its furnace-transfer window. This defers the reward to the
    // processing step AND is the moment the parked catch clears (so the daughter
    // reloads — otherwise 4 parked catches stall capture). Arm pilot exit on
    // ARM_RETURNED remains self-managed by InputManager.
    // Staged furnace breakdown (Item 1, 2026-06-11): the chop begins ~2 s into the
    // park. Comms narrate the breakdown here (single owner); completion comms fire
    // on CATCH_PROCESSED below. Gameplay (salvage/score/remove) still keys off the
    // single CATCH_PROCESSED only — this handler is comms-only.
    eventBus.on(Events.CATCH_BREAKDOWN_START, (data) => {
      // no-melt: nothing is chopped for a furnace that does not exist (the event cannot fire with the cook off; the
      // guard keeps a stray emit from printing a line that promises one).
      if (!Constants.isFeatureEnabled('FURNACE_COOK')) return;
      eventBus.emit(Events.COMMS_SEND, {
        source: (data.armId || 'DAUGHTER').toUpperCase(),
        text: `Chopping the catch for the furnace. Feeding ${data.chunkCount || 5} sections`,
        priority: 'INFO',
      });
    });

    eventBus.on(Events.CATCH_PROCESSED, (data) => {
      if (data.debrisId != null) {
        // Get debris data before removal (for scoring)
        const debris = debrisField ? debrisField.getDebrisById(data.debrisId) : null;

        // Get arm data BEFORE removal (manual capture + fuel efficiency)
        const returningArm = armManager ? armManager.arms.find(a => a.id === data.armId) : null;
        const manualCapture = returningArm ? returningArm._manualCapture : false;

        // Fuel efficiency: compare fuel at deploy vs current
        let fuelEfficient = false;
        if (returningArm && manualCapture) {
          const fuelUsed = (returningArm._fuelAtDeploy || 100) - (returningArm.fuel || 0);
          const avgFuelPerCapture = 100 / Math.max(1, returningArm.config.capturesPerFuel || 3);
          fuelEfficient = fuelUsed < avgFuelPerCapture * 0.5; // Used less than 50% of average
        }

        // Field removal happens HERE (the furnace consumes the catch). It was
        // intentionally deferred off ARM_RETURNED / DEBRIS_CAPTURED under
        // park-the-catch; CATCH_PROCESSED is the step that owns it. The catch
        // stayed alive + pinned at the strut through the dock + transfer window;
        // now it is broken down for salvage and removed from the field.

        // Check tactical assessment bonus (tracked via WIREFRAME_ASSESSED event — Batch 3)
        const assessed = this._wireframeAssessed;

        // Check if debris has salvageable resources
        const hasSalvage = debris && debris.hasSalvage && debris.salvage;

        // Cargo-continuity register item 37 (2026-08-15): credit pays ONCE
        // per body, however many times CATCH_PROCESSED fires for it. A mated
        // body is KEPT ({ parked: true } skips the removal below) and stays
        // re-targetable: [K] re-seats its orbit and clears _captured, so a
        // re-capture mates it again and re-emits { parked: true }; and a
        // mated-then-S7-transferred piece later digests on a daughter rack,
        // whose feed-end emit carries no digested flag (the rack cannot know
        // the mate already paid). The emitter-side digested contract (S13(c))
        // cannot see either path, so the handler keeps its own ledger on the
        // body. The credit legs skip a body already paid; comms and field
        // removal still run — the consumption is real.
        const creditPaid = !!(debris && debris._credited);
        const payCredit = !data.digested && !creditPaid;

        // Nets step 3 (lane s3-field-credit): a credited catch has left its field, even one kept aboard ({ parked: true }: mated
        // at the nose collar or parked on a rack, paid but not removed below; the removal is the only other place a row leaves).
        // The row leaves HERE, before the credit legs, the boundary's where-next list and the credit's save read the rows in
        // this same handler; the later DEBRIS_REMOVED (a digest, a burn) finds it gone. Explicit, not a registry listener: that
        // would work only while main.js builds the registry before this handler's init. No field tag, no body: nothing changes.
        if (debris && this._refs && this._refs.fieldRegistry) this._refs.fieldRegistry.markCaught(debris);
        // u20-nets: a scoop bag has no field row of its own; each member's row leaves its field here, as a solo catch's does
        // (a member's live `fieldId` is parked while it is in the bag; its snapshot in `bagMembers` carries the row).
        const bodies = this._creditBodies(debris);
        if (debris && debris.isBag === true && this._refs && this._refs.fieldRegistry) {
          for (const m of (debris.bagMembers || [])) this._refs.fieldRegistry.markCaught(m);
        }

        // Cargo-continuity S13(c): a collar completion carries { digested: true } —
        // a SECOND CATCH_PROCESSED for a body already credited at the mate
        // ({ parked: true }). The comms split and the field removal still run
        // below (the body IS consumed now), but credit pays NOTHING twice:
        // score, manual-capture bookkeeping, salvage, the cleared counter and
        // the autosave all belong to the single credited event.
        if (payCredit) {
        // Award score via scoring system. `method` honours the emitter —
        // 'arm' for daughters, 'mother' for a berthed whale (§4.8/§19).
        // ScoringSystem's METHOD_BONUS[method] || 1.0 accepts any string, so
        // a new method needs no scoring-model change.
        // u20-nets (owner 2026-10-23, "pay per piece, one catch"): a scoop bag pays EVERY member exactly as if it had been caught
        // alone (one award each, with that member's own salvage flag); `gameState.clearDebris()` below still runs once, so the
        // bag is one of the mission's five catches.
        for (const body of bodies) {
          scoringSystem.awardPoints({
            debris: body || { type: 'fragment', mass: 100, tumbleRate: 0, brittleness: 0 },
            method: data.method || 'arm',
            captureTier: 3, // CAPTURE tier (physical capture)
            tacticalAssessment: assessed,
            manualCapture: manualCapture,
            fuelEfficient: fuelEfficient,
            salvageRecovered: !!(body && body.hasSalvage && body.salvage),
            detachedCapture: returningArm?.isDetached || false,
          });
          if (body && body !== debris) body._credited = true;      // a member: never paid again on its own
        }

        // Reset manual capture flag after scoring
        if (returningArm) {
          returningArm._manualCapture = false;
        }

        // Register item 37: mark the body paid — a re-mate after jettison +
        // re-capture, or the rack feed-end of a transferred piece, skips
        // every credit leg above and below.
        if (debris) debris._credited = true;
        } // end payCredit (credit legs)

        // Comms notification (via EventBus — CommsSystem self-manages).
        // §4.8: honour data.source so a mother catch stops reading "DAUGHTER".
        // Register item 26 (closed by cargo-continuity S8): a mother catch
        // emits CATCH_PROCESSED { parked: true } at the PARK boundary — credit
        // lands but the body is visibly still sitting at the nose in its net,
        // so "fully processed" ran ahead of the visual. Split the line:
        // parked → secured; digested (daughter furnace feed-end, or the
        // collar's digestion completion — S13(c)) → processed.
        // no-melt: a daughter's rack credit ({ parked: true, source: 'rack' }) is not "at the nose" (ArmUnit says its own
        // "Catch secured at the strut" line), and with no furnace "fully processed" is never true: say nothing.
        // nets-1b: a mother catch's "parked at the nose" line is no longer said here, at the mate, before anyone knows
        // where the catch goes (a radiator leash or a daughter's rack take it; the line then lied). R5: nothing says it
        // any more; when the catch really stays at the nose, CaptureNet's reason line (`_tryCargoTransfer`) says where.
        if (!data.parked && Constants.isFeatureEnabled('FURNACE_COOK')) {
          eventBus.emit(Events.COMMS_SEND, {
            source: (data.source || data.armId || 'DAUGHTER').toUpperCase(),
            text: 'Catch fully processed. Salvage in the bin',
            priority: 'INFO',
          });
        }

        // --- SALVAGE RECOVERY (Session 10) ---
        // u20-nets: one pass per paid body (a solo catch: itself; a scoop bag: each member, its own salvage; the bag's own is empty)
        for (const debris of (payCredit ? bodies : [])) {
        const hasSalvage = debris && debris.hasSalvage && debris.salvage;
        if (hasSalvage) {
          const salvage = debris.salvage;
          const refineryMult = this._hasUpgrade('refinery_arm') ? 1.5 : 1.0;

          // Xenon → main satellite fuel
          // g1-gas-upgrades D8: salvaged gas is MASS — today's argon amount in kg, loaded as kg of the gas
          // IN the tank (the resupply path, clamped to free space), named for the real gas and the real kg.
          if (salvage.xenon > 0 && resourceSystem) {
            const wantKg = salvageGasKg(salvage.xenon) * refineryMult;
            const gotKg = resourceSystem.resupplyEngineGas(wantKg);
            const gasName = (Constants.FUELS[resourceSystem.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL]).name;
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: gotKg > 0
                ? `\u26CF Salvaged ${gotKg.toFixed(1)} kg ${gasName} \u2014 \u0394V extended!`
                : `\u26CF Salvaged ${wantKg.toFixed(1)} kg ${gasName} \u2014 engine tank already full`,
              priority: 'good',
            });
          }

          // Indium → the mother's indium store (lane 3f, DECISIONS §4 "Docked servicing": salvaged indium goes to a mother-side
          // store, never straight into a daughter tank; a daughter's tank only fills through a docked cartridge swap). What
          // does not fit the store is lost, and one plain line says so.
          if (salvage.indium > 0 && resourceSystem) {
            const wantKg = salvage.indium * refineryMult;
            const gotKg = resourceSystem.addIndium(wantKg);
            const grams = (kg) => Math.round(kg * 1000);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: gotKg >= wantKg - 1e-9
                ? `\u26CF Indium recovered \u2014 ${grams(wantKg)} g into the ion-fuel store`
                : (gotKg > 0
                  ? `\u26CF Indium recovered \u2014 ${grams(gotKg)} g stored, ${grams(wantKg - gotKg)} g lost: the ion-fuel store is full`
                  : `\u26CF Indium recovered, but the ion-fuel store is full \u2014 ${grams(wantKg)} g lost`),
              priority: 'good',
            });
          }

          // GaAs → solar panel health restoration
          if (salvage.gaAs > 0 && resourceSystem) {
            resourceSystem.replenishPanelHealth(salvage.gaAs * refineryMult);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `\u26CF GaAs cells recovered \u2014 panel health +${(salvage.gaAs * 100).toFixed(1)}%`,
              priority: 'good',
            });
          }

          // Battery → direct charge
          if (salvage.battery > 0 && resourceSystem) {
            resourceSystem.replenish('battery', salvage.battery * refineryMult);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `\u26A1 Battery salvage \u2014 +${salvage.battery.toFixed(0)} Wh`,
              priority: 'info',
            });
          }

          // Hydrazine → cold gas (requires upgrade, handled by check)
          if (salvage.hydrazine > 0 && resourceSystem) {
            const hasHazmat = this._hasUpgrade('hazmat_handler');
            if (hasHazmat) {
              const coldGasGain = salvage.hydrazine * refineryMult * Constants.SALVAGE_HYDRAZINE_COLDGAS_RATIO;
              resourceSystem.replenish('coldGas', coldGasGain);
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: `\u26A0 Hazmat: ${salvage.hydrazine.toFixed(1)} kg N\u2082H\u2084 \u2192 ${coldGasGain.toFixed(1)} kg cold gas`,
                priority: 'warning',
              });
            } else {
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: `\u26A0 N\u2082H\u2084 detected but no Hazmat Handler \u2014 discarded safely`,
                priority: 'warning',
              });
            }
          }

          // F16: Lithium → MPD thruster propellant
          if (salvage.lithium > 0 && resourceSystem) {
            const liAmount = salvage.lithium * refineryMult;
            resourceSystem.addLithium(liAmount);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `⚗ Lithium salvaged. +${liAmount.toFixed(1)} units (MPD propellant)`,
              priority: 'good',
            });
          }

          // --- METAL CARGO STORAGE (Phase 2) ---
          const metalSalvage = (salvage.metals || []).filter(s => s.type === 'metal');
          for (const metal of metalSalvage) {
            eventBus.emit(Events.CARGO_STORE, {
              metalId: metal.subtype,
              name: metal.name,
              massKg: metal.amount,
              color: metal.color,
              ispAsThrust: metal.ispAsThrust,
              marketValue: metal.amount > 0 ? metal.value / metal.amount : 0, // per-kg value
            });
          }

          // Emit salvage recovered event
          eventBus.emit(Events.SALVAGE_RECOVERED, { debris, salvage });

          // Phase 8: Emit salvage reveal for loot popup + audio
          const revealMetals = (salvage.metals || []).map(m => ({
            name: m.name || m.subtype || 'Unknown',
            subtype: m.subtype,
            amount: m.amount || 0,
            massKg: m.amount || 0,
          }));
          const totalMass = revealMetals.reduce((sum, m) => sum + m.amount, 0);
          eventBus.emit(Events.SALVAGE_REVEAL, {
            metals: revealMetals,
            totalMass,
            debrisType: debris ? (debris.type || 'debris') : 'debris',
          });
        }
        }

        // trip-melt-2 D12a: was a trip ALREADY running when this credit landed? (Read before `_startMissionAfterCredit` below, which
        // begins the trip for a boundary credit: that credit's own boundary runs at once, as before.)
        const tripRunningBeforeCredit = this._trip.isActive();
        // Update game state debris counter (belt-and-suspenders with scoringSystem)
        if (payCredit) gameState.clearDebris();
        // Wave 5 Session F (D4): the mission boundary check runs HERE, right
        // after the increment — not inside awardPoints() above, where it read
        // the pre-catch count and fired MISSION_START one catch late (03-plan
        // Session E FINDINGS (f)). The 5th catch now starts mission 2 with
        // { missionNumber: 2 }; the ONE depot decision (_onMissionBoundary
        // below) follows it in the same tick. A digested / already-paid body
        // (payCredit false) moved no counter and starts nothing.
        // c2-fifth-catch D2: a parked boundary credit holds this start.
        if (payCredit) this._startMissionAfterCredit(data, () => { scoringSystem.checkMissionTransition(); });

        // Furnace consumed the catch — remove it from the field (emits
        // DEBRIS_REMOVED; wireframe/pins self-clear). Deferred here from the old
        // ARM_RETURNED/DEBRIS_CAPTURED path under park-the-catch.
        // Cargo-continuity S3: { parked: true } (a mother catch at the end of
        // its securing timer) keeps the body — credit landed, but the catch
        // MATES at the nose collar inside its net instead of being removed on
        // camera (S13(c)). The collar's digestion completion carries
        // { digested: true } — removal runs (the body IS consumed).
        if (debrisField && data.debrisId != null && !data.parked) {
          debrisField.removeDebris(data.debrisId);
        }

        // Auto-save after successful capture
        // (F2: this catch is about to close any open stop below, so the save must not carry it. trip-melt G1: during
        // the trip nothing closes it, so the save carries the stop as it is.)
        if (payCredit) this.saveGame({ resupplyStop: this._trip.isActive() && this._atResupplyStop === true });

        // Wireframe self-clears via DEBRIS_REMOVED listener (Batch 3)

        // Auto-clear dead target — only if current target is the captured debris.
        // InputManager.handleCaptureAdvance already selects the next-best target
        // on ARM_CAPTURED / LASSO_CAPTURED. Only provide fallback if nothing selected.
        const currentTarget = targetSelector.activeTarget;
        if (currentTarget && debris && currentTarget.id === (debris.id ?? data.debrisId)) {
          // Silent: this clear is capture bookkeeping — the capture voice
          // (clamp/success/ka-ching) already tells the story; a descending
          // "target lost" earcon here would contradict the reward.
          targetSelector.setTarget(null, { silent: true });
        }
        if (!targetSelector.activeTarget) {
          const playerPos = player ? player.getPosition() : null;
          if (playerPos && debrisField) {
            const nearby = debrisField.getDebrisNear(playerPos, 0.5); // wide radius
            // 2026-10-18: the NEAREST eligible piece within AUTOLOCK.RANGE_M, else
            // nothing — a 385 km auto-pick emptied the argon in mission 2.
            const rangeM = Constants.AUTOLOCK.RANGE_M;
            let nextTarget = null;
            for (const d of nearby) {
              if (!d || !d.discovered || !d.alive || d._captured || d.hazard === true) continue;
              if (!(d.distanceKm * 1000 <= rangeM)) continue;
              if (!nextTarget || d.distanceKm < nextTarget.distanceKm) nextTarget = d;
            }
            if (nextTarget) {
              const original = debrisField.getDebrisById(nextTarget.id);
              if (original) {
                targetSelector.setTarget(original, { autoTarget: true });
              }
            }
          }
        }

        // Auto-camera: return to COMMAND view after capture delivery.
        // NOTE (2026-06-03): TARGET_LOCK is currently unreachable (removed from
        // CameraSystem's VIEW_CYCLE), so this revert is a no-op today. Retained
        // intentionally so it keeps working if TARGET_LOCK is re-enabled.
        if (cameraSystem && cameraSystem.currentView === CameraViews.TARGET_LOCK) {
          timerManager.setTimeout(() => {
            if (cameraSystem.currentView === CameraViews.TARGET_LOCK) {
              cameraSystem.setView(CameraViews.CHASE);
            }
          }, 2000, { owner: this }); // 2 second delay for cinematic hold
        }

        // ── Mission boundary: every SHOP_CADENCE (= DEBRIS_PER_MISSION) debris cleared ──
        // (digested completions didn't advance the counter — the modulo would
        // re-fire on the mate's multiple; S13(c). Same for a body the
        // ledger already paid — register item 37.) The ONE depot decision per
        // catch lives in _onMissionBoundary (Wave 5 Session E).
        const debrisCount = gameState.debrisCleared;
        if (payCredit && debrisCount > 0 && debrisCount % SHOP_CADENCE === 0) {
          if (gameState.isGameplay()) {
            // trip-melt-2 D12a: a boundary reached by a credit while the trip waits or burns (five credits in one trip)
            // must not run mid-trip: the invitation, the stop and the saved state belong to the arrival. It runs after
            // the trip's mission start (`_beginTripThen`).
            if (tripRunningBeforeCredit) this._deferredBoundary = debrisCount;
            else this._onMissionBoundary(debrisCount);
          }
        } else if (payCredit) {
          // u1-resupply-stop D1: the player has flown out for the next mission — the stop closes at this credited
          // catch whether or not the invitation was still open (a visit closes the invitation as 'entered'; it
          // does not close the stop).
          // trip-melt G1 (DECISIONS §26): not while the trip waits or burns - the player has not flown anywhere yet;
          // the stop and its invitation close at the first credited catch AFTER the trip.
          if (!this._trip.isActive()) {
            this._setResupplyStop(false);
            // The invitation window is "until the next credited catch" (owner
            // decision 2, 2026-09-04): a catch that is not a boundary lapses it.
            this._closeDepotInvitation('lapsed');
          }
          // M1 guidance T7: the per-catch progress line (guided chapters only;
          // the boundary catch above is the ceremony's, not this line's).
          this._postMissionProgressLine();
        }
      }
    });

    // c2-fifth-catch D2: the credited catch leaving the nose releases a held
    // mission start. Registered AFTER the credit handler above, so on a
    // digestion the field removal has already run when the start fires. Ids
    // are matched: a piece cut off a big catch emits its own transferComplete
    // while the catch itself still sits at the nose — that must not start it.
    eventBus.on(Events.CATCH_PROCESSED, (data) => {
      if (data && data.digested) this._releaseMissionStartFor(data.debrisId);
    });
    eventBus.on(Events.CARGO_TRANSFER_COMPLETE, (data) => {
      this._releaseMissionStartFor(data && data.debrisId);
    });
    eventBus.on(Events.NET_RELEASED, (data) => {
      this._releaseMissionStartFor(data && data.debrisId);
    });

    // Arm pilot exit on ARM_EXPENDED now self-managed by InputManager

    // ==================================================================
    // ARM DEORBIT SACRIFICE — score + remove debris (Session 10)
    // ==================================================================

    eventBus.on(Events.ARM_DEORBIT, (data) => {
      const { armId, fuelAtStart, totalMass, debrisId } = data;

      // Get debris data before removal for scoring
      const debris = debrisField && debrisId != null
        ? debrisField.getDebrisById(debrisId) : null;

      // Calculate deorbit ΔV based on fuel and mass
      // Approximate: remaining impulse / total mass
      const arm = armManager ? armManager.arms.find(a => a.id === armId) : null;
      const totalImpulse = arm
        ? (arm.type === 'weaver' ? Constants.WEAVER_TOTAL_IMPULSE : Constants.SPINNER_TOTAL_IMPULSE)
        : 5500;
      const remainingImpulse = totalImpulse * (fuelAtStart / 100);
      const deorbitDV = remainingImpulse / totalMass; // m/s

      // Determine multiplier based on ΔV achieved
      let deorbitMult = Constants.DEORBIT_MULTIPLIER_BASE;
      if (fuelAtStart < 5) {
        deorbitMult = Constants.DEORBIT_MULTIPLIER_EMERGENCY;
      } else if (deorbitDV > Constants.DEORBIT_HIGH_DV_THRESHOLD) {
        deorbitMult = Constants.DEORBIT_MULTIPLIER_HIGH_DV;
      }
      // Approximate perigee lowering
      const vCircular = 7450; // m/s at ~800 km
      const perigeeDropKm = (2 * 7171 * deorbitDV) / vCircular;
      const estimatedPerigee = 800 - perigeeDropKm; // rough approximation
      if (estimatedPerigee < Constants.DEORBIT_REENTRY_PERIGEE) {
        deorbitMult = Constants.DEORBIT_MULTIPLIER_REENTRY;
      }

      // Remove debris from field
      if (debrisField && debrisId != null) {
        debrisField.removeDebris(debrisId);
      }

      // Award score with deorbit multiplier
      // Check tactical assessment bonus (tracked via WIREFRAME_ASSESSED event — Batch 3)
      const assessed = this._wireframeAssessed;
      // u20-nets: a scoop bag burns up as its members: each is paid as if it had been sacrificed alone and leaves its field row
      // (the bag has none of its own); the sacrifice is still ONE clear (`clearDebris()` below).
      const deorbitBodies = this._creditBodies(debris);
      if (debris && debris.isBag === true && this._refs && this._refs.fieldRegistry) {
        for (const m of (debris.bagMembers || [])) this._refs.fieldRegistry.markCaught(m);
      }
      for (const body of deorbitBodies) {
        scoringSystem.awardPoints({
          debris: body || { type: 'fragment', mass: 100, tumbleRate: 0, brittleness: 0 },
          method: 'arm',
          captureTier: 3,
          tacticalAssessment: assessed,
          manualCapture: false,
          fuelEfficient: false,
          salvageRecovered: false,
          deorbitSacrifice: true,
          deorbitMultiplier: deorbitMult,
          detachedSacrifice: arm?.isDetached || false,
        });
        if (body && body !== debris) body._credited = true;
      }
      if (debris && debris.isBag === true) debris._credited = true;

      // Comms: report ΔV and perigee lowering
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `\u0394V burn: ${deorbitDV.toFixed(1)} m/s. Perigee lowered ~${perigeeDropKm.toFixed(0)} km`,
        priority: 'info',
      });

      // Update game state
      gameState.clearDebris();
      const atBoundary = this._isMissionBoundaryCount(gameState.debrisCleared);
      // trip-melt G1: a sacrifice that lands while the trip waits or burns neither closes the stop nor starts a mission.
      const tripOn = this._trip.isActive();
      // u1 D1: a sacrifice that completes a mission opens the stop; any other closes it. Slice 3 (S7): with the satellite as the stop it opens nothing here.
      if (!tripOn) this._setResupplyStop(atBoundary && !this._satelliteIsTheStop());
      // Wave 5 Session F (D4): the second credited-clear path (Ctrl+Shift+D →
      // ARM_DEORBIT_CMD → ArmUnit.startDeorbit) — the mission boundary check
      // follows its increment too, so a sacrifice that lands the 5th clear
      // starts mission 2 on time. (This path has never carried the depot
      // decision — pre-existing, FINDINGS.)
      // trip-melt D2: at a boundary the trip begins instead, and the mission starts when it ends.
      if (atBoundary) this._beginTripThen(() => scoringSystem.checkMissionTransition());
      else if (!tripOn) scoringSystem.checkMissionTransition();
      // M1 guidance T7: the per-catch progress line rides this credited clear
      // too; its own boundary guard keeps a sacrifice that lands the 5th
      // clear quiet (there is no ceremony here to speak for it — FINDINGS).
      this._postMissionProgressLine();
      this.saveGame();

      // Wireframe self-clears via DEBRIS_REMOVED listener (Batch 3)

      // Play deorbit sound
      if (audioSystem) audioSystem.playDeorbitBurn();
    });

    // Phase 6: Tether Detach — ARM_LOST penalty
    eventBus.on(Events.ARM_LOST, (data) => {
      const penalty = Constants.DETACH_FAIL_PENALTY;
      scoringSystem.totalScore += penalty;
      scoringSystem.credits += penalty;
      eventBus.emit(Events.SCORE_UPDATE, {
        total: scoringSystem.totalScore,
        credits: scoringSystem.credits,
        delta: penalty,
      });
      console.log(`[GameFlow] Arm ${data.armId} lost. Penalty ${penalty}`);
    });

    // Debris removed externally — DebrisWireframe self-clears via DEBRIS_REMOVED listener (Batch 3)
    // TargetSelector auto-clears dead targets in update()

    // COMMS MENU ARM DEPLOY listener removed 2026-06-12 (UX-11 #9): its only
    // emitters (RadialMenu, CommsPanel.executeCommsCommand) were deleted.
    // preferType deploy still works via Events.ARM_DEPLOY_TO (TargetSelector).

    // ==================================================================
    // TRAWL DEPLOYMENT (Phase 6 / S7-B: wired to TrawlManager)
    // ==================================================================

    // TrawlManager self-manages toggle + start via TRAWL_START listener (Batch 3)
    // GFM only handles the legacy armManager.deployTrawl() call when trawl STARTS (not ends)
    eventBus.on(Events.TRAWL_START, (data) => {
      if (data && data.cluster) return;  // notification from TrawlManager auto-start
      if (data && data.armId) return;    // notification from an arm

      // Deploy physical trawl net only when trawl is starting (not ending).
      // TrawlManager's handler fires first (registered earlier), updating active state.
      if (trawlManager.active && armManager) {
        armManager.deployTrawl();
      }
    });

    // ==================================================================
    // WIREFRAME ASSESSMENT TRACKING (Batch 3 — replaces debrisWireframe.hasAssessedTarget())
    // ==================================================================
    eventBus.on(Events.WIREFRAME_ASSESSED, () => {
      this._wireframeAssessed = true;
    });
    eventBus.on(Events.TARGET_SELECTED, () => {
      this._wireframeAssessed = false;
    });
    eventBus.on(Events.TARGET_CLEARED, () => {
      this._wireframeAssessed = false;
    });

    // ==================================================================
    // TRAWL COMMS — target entering/exiting/window closing (Phase 2)
    // ==================================================================

    eventBus.on(Events.TRAWL_TARGET_ENTERING, ({ type, mass }) => {
      const typeName = type || 'debris';
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Target entering range. ${typeName}${mass ? ', ' + mass.toFixed(0) + ' kg' : ''}`,
        priority: 'info',
      });
    });

    eventBus.on(Events.TRAWL_TARGET_WINDOW_CLOSING, () => {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Target window closing. Capture now or lose it!',
        priority: 'warning',
      });
    });

    eventBus.on(Events.TRAWL_TARGET_EXITED, ({ debrisId }) => {
      // Silent — just track. Could add a subtle audio cue later.
    });

    // Pause menu events (S1 Fix L1: use Events constants instead of raw strings)
    eventBus.on(Events.PAUSE_RESUME, () => {
      this.paused = false;
      // HUD.hidePause() now self-managed via PAUSE_RESUME listener
    });

    eventBus.on(Events.PAUSE_MENU, () => {
      this.paused = false;
      // HUD.hidePause() now self-managed via PAUSE_MENU listener
      this.transitionToState(GameStates.MENU);
    });

    // ==================================================================
    // FIRST EXPERIENCE — Contextual Comms Guidance (§7)
    // One-shot messages keyed by _firstTimeComms Set. Resets on resetGame().
    // ==================================================================

    // First ORBITAL_VIEW: opening comms guidance. deep-polish-4: the 4 s VLEO
    // hold is gone; guidance now trickles in AFTER the boot comms + settle, and
    // the two lines are split into separate timers so they never land together.
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      // Any ORBITAL_VIEW entry WITHOUT the opening beats (Continue, or
      // returning from a screen): no scripted cameo is coming, so the ambient
      // scheduler's defer window is pointless — open it immediately. Without
      // this, Continue sessions waited out the 30 s defer and the watchable
      // window for pads like Sriharikota-on-th (~17–26 s) closed unfired.
      if (to === 'ORBITAL_VIEW' && !this._firstOrbitalView) {
        ambientLaunchScheduler.skipScriptedDefer();
      }
      if (to === 'ORBITAL_VIEW' && this._firstOrbitalView) {
        this._firstOrbitalView = false;

        // Opening comms hint — after the boot trickle (last boot line at 2600ms).
        timerManager.setTimeout(() => {
          const { debrisField, player } = this._refs;
          if (!player || !debrisField) return;

          // Opening dance: this fires at cut+3.6 s — mid-unfold. The dance is
          // wordless (decision 12: suppress at source, do NOT hold — a held
          // line would replay at hand-over); the onboarding pipeline that
          // starts at hand-over owns the teaching instead. Consumed, not
          // deferred, so it never lands later either.
          if (openingDance.isActive()) {
            this._firstTimeComms.add('orbital_view_opening');
            return;
          }

          // Target acquisition is owned by AutoLockController (reward-first
          // spine) from the first frame — no auto-target call needed here.
          if (!this._firstTimeComms.has('orbital_view_opening')) {
            this._firstTimeComms.add('orbital_view_opening');
            eventBus.emit(Events.COMMS_MESSAGE, {
              sender: 'SPACECRAFT',
              text: 'Multiple contacts nearby. Press S to scan.',
              priority: 'info',
            });
          }
        }, 3600, { owner: this });

        // u5-info-ap-hold D6: the one-time "Place names are on your Earth view. Press 5 to hide them."
        // line is gone (coordinator decision 2026-10-19): it names a key on a keyless device and sat
        // between the wings and the scan as noise. The 5 key stays in the Help list.

        // Launch cameo — a single plume rises from the player's home spaceport
        // during the opening pass. The pad may not be above the horizon at the
        // 7 s mark (e.g. en/Canaveral rises ~15 s in), so poll every 2 s for up
        // to 90 s and fire the moment it's in view; give up silently after that
        // (no distraction mid-game).
        timerManager.setTimeout(() => {
          if (this._firstTimeComms.has('orbital_view_cameo')) return;
          this._firstTimeComms.add('orbital_view_cameo');
          const lang = settingsManager.getLanguageEntry();
          // Pad coordinates resolve from the shared cities list (single source).
          const pad = padFor(lang && lang.code, cityLabels.getCities());
          if (!pad) return;
          const announce = () => {
            // Tie the 3D event to the reference layer: a short cyan flash on
            // the pad's pill at ignition ("launching NOW") — then the plume
            // itself holds the eye.
            cityLabels.pulse(pad.name, LAUNCH_FLASH_S);
            // Opening dance: the cameo poll first lands at cut+7 s — exactly
            // the hand-over instant. The plume still rises; only the comms
            // line waits (the dance is wordless, and the Houston hand-over
            // line + onboarding boot beat own that moment). A later poll
            // announces normally if the pad is still unfired.
            if (openingDance.isActive()) return;
            eventBus.emit(Events.COMMS_MESSAGE, {
              sender: 'SPACECRAFT',
              text: `${pad.vehicle} lifting off from ${pad.name} — 350 km below you.`,
              priority: 'info',
              _quiet: true,   // comms-after-tutorial D4: scenery stays hidden
            });
          };
          let tries = 0;
          const attempt = () => {
            if (launchCameo.fire(pad)) {
              // The scripted fire owns this pad for the pass — ambient must
              // not double-fire it when the pad's watchable edge registers.
              ambientLaunchScheduler.markFiredExternally(pad.name);
              announce();
              return;
            }
            // 45 × 2 s = 90 s of coverage — a pad rising from behind the limb
            // at spawn (en ≈ 15 s, ja ≈ 3 s) is caught well inside the pass.
            if (++tries < 45) timerManager.setTimeout(attempt, 2000, { owner: this });
          };
          attempt();
        }, 7000, { owner: this });
      }
    });

    // First target selected: hint approach (skip auto-target — only player-initiated)
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      if (data && data.autoTarget) return;
      if (!this._firstTimeComms.has('first_target')) {
        this._firstTimeComms.add('first_target');
        const target = targetSelector.getActiveTarget();
        if (target) {
          const typeLabel = target.type === 'fragment' ? 'Fragment' :
            target.type === 'defunctSat' ? 'Satellite' : 'Contact';
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'SPACECRAFT',
            // u2-one-voice D3: no key name - the Director's one step (the net chip) is the voice.
            text: `${typeLabel} locked.`,
            priority: 'info',
          });
        }
      }
    });

    // Item 3 (2026-06-12): first net launch — one SCI line teaching the yo-yo
    // despin physics the player just watched (canister blossoms open and the
    // spin visibly slows with NO thruster firing). Pairs with the Codex entry
    // 'net_yo_yo_despin' (also unlocked by NET_FIRED).
    eventBus.on(Events.NET_FIRED, () => {
      if (!this._firstTimeComms.has('first_net_physics')) {
        this._firstTimeComms.add('first_net_physics');
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'SCI', channel: 'SCI',
          // nets-1b (Ruling 0): two short plain sentences, no tag, no symbols, no bracketed key.
          text: 'Watch the net slow its spin as it opens, like a skater opening her arms. Press I to read more.',
          priority: 'info',
        });
      }
    });

    // Arrival advice (N lasso / D daughter) comes from AutopilotSystem's single "In position." line.
    eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
      // Drift recovery: one-shot 8s delayed check
      if (!this._firstTimeComms.has('drift_recovery')) {
        const arrivedTarget = targetSelector.getActiveTarget();
        if (arrivedTarget) {
          timerManager.setTimeout(() => {
            if (this._firstTimeComms.has('first_capture')) return; // already caught it
            if (this._firstTimeComms.has('drift_recovery')) return;
            if (!arrivedTarget.alive) return;

            const { player } = this._refs;
            if (!player) return;
            const cart = orbitToSceneCartesian(arrivedTarget.orbit);
            if (!cart || !cart.position) return;
            const targetPos = new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
            const dist = player.getPosition().distanceTo(targetPos);

            if (dist > 0.005) { // > ~500m = drifted significantly
              this._firstTimeComms.add('drift_recovery');
              eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'SPACECRAFT',
                text: 'Target drifting. Press A to re-approach.',
                priority: 'info',
                _keep: true,   // comms-after-tutorial D6: the next step - never folded into "x N queued"
              });
            }
          }, 8000, { owner: this });
        }
      }
    });

    // First capture: hint next target
    const onFirstCapture = () => {
      // During onboarding the Director owns the post-capture flow (`captured` →
      // `solo_intro` → `solo_practice` beats teach "find another"). Skip this
      // duplicate "Press T" line then. (Guidance cleanup, Phase 2.)
      if (this._onboardingRunning) return;
      if (!this._firstTimeComms.has('first_capture')) {
        this._firstTimeComms.add('first_capture');
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'HOUSTON',
          text: 'Got it! Press T for next target.',
          priority: 'info',
        });
      }
    };
    eventBus.on(Events.ARM_CAPTURED, onFirstCapture);
    eventBus.on(Events.LASSO_CAPTURED, onFirstCapture);
  }

  // ==========================================================================
  // GAME RESET
  // ==========================================================================

  /**
   * Place the player's starting orbit so its ground track passes over the home
   * region of the selected menu language (e.g. Japanese → over Japan, Thai →
   * over Thailand). Inclination is set from the language's `incDeg` (derived
   * from the nation's real launch latitude; default 51.6° ISS band), then RAAN
   * + true anomaly are aimed at the anchor sub-point via subPointToOrbit(). The
   * anchor latitude is ≤ incDeg by design (see Languages.js) so the pass is not
   * clamped. Setting inclination before MISSION_START means the welcome debris
   * field (spawned in the player's own orbit) inherits the chosen tilt. Called
   * on New Game after resetGame() (which zeroes trueAnomaly).
   */
  /**
   * @private Detect the OS/browser "reduce motion" accessibility preference.
   * Guarded for the Node test runner (no window/matchMedia). Used to skip the
   * menu→sim intro camera zoom for users who opt out of motion.
   * @returns {boolean}
   */
  _prefersReducedMotion() {
    try {
      return !!(typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_e) {
      return false;
    }
  }

  /**
   * Apply the per-language starting orbit (ground track over the player's home
   * region). Called on ALL restart paths — New Game (MENU_START/FAST_START),
   * Continue (MENU_CONTINUE), and game-over Continue/Retry — so language choice
   * always determines the start orbit regardless of whether a save exists.
   *
   * Two staging tweaks make the opening pass read well:
   *  • ABEAM (START_ABEAM_DEG): the track is re-aimed at a point offset
   *    perpendicular to the pass, so the home city slides by ~200 km off the
   *    STARBOARD side instead of vanishing under the nose — noticeable out the
   *    "right window", never shoved in the player's face, and visible for the
   *    whole pass.
   *  • LEAD (START_TRACK_LEAD_DEG): the spawn is backed off along-track so
   *    the city first appears AHEAD and then drifts past abeam.
   *
   * Branch selection: Languages.descending picks the southbound (descending)
   * solution of subPointToOrbit when the interesting corridor lies on that
   * half of the orbit (e.g. English over the Eastern Seaboard).
   *
   * Register item 50: the same orbit also re-derives the FIELD regime
   * (regimeFromStartOrbit → DebrisField.reseatFieldRegime) — a mid-menu
   * language switch otherwise leaves the assembled field on the boot
   * language's plane while the player starts on the live one. Orbits only
   * (sma/ecc preserved; cast/mesh slots are construction-bound); an
   * unchanged language is a value-compared no-op, so non-switch paths are
   * untouched. Runs after the player writes so the welcome cluster's lazy
   * first-frame spawn (player-frame copy) lands on the re-seated plane.
   */
  _applyStartLocation() {
    const { player, debrisField } = this._refs;
    if (!player || !player.orbit) return;
    const lang = settingsManager.getLanguageEntry();
    const orbit = computeStartOrbit(lang);
    if (!orbit) return;

    player.orbit.inclination = orbit.inclination;
    player.orbit.raan = orbit.raan;
    player.orbit.trueAnomaly = orbit.trueAnomaly;
    // subPointToOrbit() assumes a circular orbit with argPerigee=0
    // (OrbitalMechanics.js:229). Neither field is reset elsewhere on restart,
    // so a played (thrusted) session could mis-aim the anchor pass. Reset here
    // to keep this the one authoritative "starting orbit" function.
    player.orbit.eccentricity = 0.0001;
    player.orbit.argPerigee = 0;

    // The field shares the player's plane from the SAME orbit computation
    // (one read — no second computeStartOrbit call). The typeof guard keeps
    // legacy mocks (no reseatFieldRegime) byte-identical.
    if (debrisField && typeof debrisField.reseatFieldRegime === 'function') {
      debrisField.reseatFieldRegime(regimeFromStartOrbit(orbit));
    }
  }

  /**
   * Stage the opening light for a FRESH game start (the initial Mission-1
   * spawn). Called ONLY from the new-game menu paths (MENU_START /
   * MENU_FAST_START — the paths that delete the save), immediately after
   * _applyStartLocation, so the freshly-written start orbit IS the spawn
   * point. Deliberately NOT called on Continue (saved games keep the pure
   * real-clock sky), game-over Retry/Continue, or any mid-session path —
   * and the sun is never re-seeded mid-session, so the staged offset simply
   * becomes the new anchor the stylized day/night cycle runs forward from
   * (SunLight.stageOpeningLight — the sun is not frozen).
   *
   * The typeof guard keeps legacy mocks/tests (refs without sunLight)
   * byte-identical, matching the reseatFieldRegime convention above.
   */
  _stageOpeningLight() {
    const { player, sunLight } = this._refs;
    if (!sunLight || typeof sunLight.stageOpeningLight !== 'function') return;
    if (!player || !player.orbit) return;
    const cart = orbitToSceneCartesian(player.orbit);
    if (cart && cart.position) sunLight.stageOpeningLight(cart.position);
  }

  /**
   * Reset game state for new attempt.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepOpeningDance=false] — the caller is a NEW-GAME
   *   start that binds the sim ship to a live opening dance immediately after
   *   this returns (MENU_START / MENU_FAST_START), so the finished pose must
   *   NOT be applied here. Every other caller — CONTINUE, GAMEOVER retry,
   *   GAMEOVER menu — leaves this false and lands on `openingDance.endState()`,
   *   which also stops any dance still in flight. Inferring this from
   *   `openingDance.isActive()` is what it replaces: that could not tell a
   *   new-game start from a retry that happened to land mid-unfold, and the
   *   retry then kept a packed ship on screen.
   */
  resetGame(opts) {
    const keepOpeningDance = !!(opts && opts.keepOpeningDance);
    const {
      player, armManager,
      cameraSystem, resourceSystem,
    } = this._refs;
    // targetSelector: imported singleton
    // debrisWireframe: self-manages via GAME_RESET listener
    // kesslerSystem: self-manages via GAME_RESET listener

    // Notify self-resetting systems (CommsSystem, KesslerSystem,
    // TutorialSystem, TrawlManager listen for this)
    eventBus.emit(Events.GAME_RESET);

    gameState.reset();
    scoringSystem.reset();

    // Reset player resources (delegated to ResourceSystem)
    resourceSystem.reset();

    // Reset orbit to starting position
    player.orbit.semiMajorAxis = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;
    player.orbit.trueAnomaly = 0;

    // Reset ROSA furl state so a retry never inherits a furled array.
    if (player.resetRosaFurlState) player.resetRosaFurlState();
    // Owner amendment 2026-09-09 (OVERRIDE radiator sweep): the fold is now
    // reachable in play, so a run can end with the flower FOLDED (lock armed,
    // FEEP inhibited, ROSA held centred). The retry hand-off
    // snaps to the STOW bud, lock + hold cleared
    // (one THERMAL_FLOWER_RELEASED if the lock was armed). No-op unfitted.
    if (player.snapFlowerToStow) player.snapFlowerToStow();

    // Reset target selection (imported singleton — emits TARGET_CLEARED → DebrisWireframe self-clears)
    // silent: reset clear, not a real target loss — suppresses the audio earcon.
    targetSelector.setTarget(null, { silent: true });

    // Reset V3 arm manager
    if (armManager) armManager.reset();
    // turn-gas D3: nothing of the reel push (gathered Δv, the turn it kicked) survives into the next run
    if (player && player.clearReelPushState) player.clearReelPushState();

    // Opening dance (2026-09-16): every path that does NOT run the dance lands
    // on the open pose — CONTINUE, GAMEOVER retry, reduced motion, flag off,
    // the ?shot harness — so a ship is never seen packed outside a running
    // dance. AFTER armManager.reset() (which parks the daughters at α 0) so the
    // strut latch survives. The ONE exception is the new-game start, which
    // says so explicitly (`keepOpeningDance`) and binds the sim ship to the
    // live progress in the same tick.
    if (player && !keepOpeningDance) {
      openingDance.endState(player);
    }

    this.approachTarget = null;
    this.approachComplete = false;

    // Reset camera to default chase view
    if (cameraSystem) {
      cameraSystem.setView(CameraViews.CHASE);
    }

    // Reset power distribution to defaults
    powerDistribution.reset();

    // Reset elevator contract mass (Phase 5)
    const { shopScreen } = this._refs;
    if (shopScreen) shopScreen.setContractMass(0);
    this._elevatorWinTriggered = false;
    this._winTriggered = false;  // S1 Fix L2: reset guard on new game

    // Reset first-experience guidance
    this._firstOrbitalView = true;
    this._suppressIntroZoom = false;
    this._firstTimeComms = new Set();

    // Clear score-group activation timer
    if (this._scoreGroupTimer !== null) {
      timerManager.clear(this._scoreGroupTimer);
      this._scoreGroupTimer = null;
    }
    // PR 5 / P2.8: also kill the shop-trigger debounce and any other
    // pending timers owned by this GameFlowManager. Prevents a stale
    // "return to depot" auto-transition firing after a Game Over reset.
    if (this._shopTimeoutId !== null) {
      timerManager.clear(this._shopTimeoutId);
      this._shopTimeoutId = null;
    }
    // An open depot invitation belongs to the game that just ended.
    this._closeDepotInvitation('reset');
    this._setResupplyStop(false);         // u1-resupply-stop D1: a new run starts mid-mission
    this._pendingMissionStart = null;     // c2-fifth-catch D2: so does a held mission start
    this._trip.abort();                   // trip-melt D9: and a trip (no mission start, the plume and the hold released)
    this._deferredBoundary = null;        // trip-melt-2 D12a: a boundary deferred by that trip dies with it
    this._strandedS = 0;                  // t1-stranded: a new run starts with no stranded spell
    this._callOffered = false;            // lane 3c: nor an offered call
    timerManager.clearByOwner(this);
  }

  // ==========================================================================
  // UPGRADES
  // ==========================================================================

  /** Apply purchased upgrades to game systems */
  applyUpgrades() {
    // Upgrades are applied via individual events as they're bought
  }

  /**
   * The elevator-contract GAME_WIN (Phase 5 / Phase E), in ONE place since
   * Wave 5 Session K: fired from SHOP_DEPLOY after the full-screen shop (the
   * shipped path — SHOP → WIN is invalid, so it waits for ORBITAL_VIEW) and
   * directly from CONTRACT_COMPLETE when the contribution lands in gameplay
   * (the CARGO pane, one shop). The GAME_WIN handler's `_winTriggered` guard
   * keeps the WIN single whichever path fires first. Tags the win so the
   * GameOverScreen shows the anchor-run (elevator) variant and the endgame
   * codex unlocks gate correctly.
   * @private
   */
  _fireElevatorWin() {
    const { shopScreen } = this._refs || {};
    const totalMassKg = (shopScreen && typeof shopScreen.getContractMass === 'function')
      ? shopScreen.getContractMass() : 0;
    eventBus.emit(Events.GAME_WIN, {
      ...scoringSystem.getStats(),
      winType: 'elevator',
      totalMassKg,
    });
  }

  /**
   * Apply a specific upgrade effect — routes to the correct system(s) via the
   * exported EFFECT_ROUTES map (F4). Every catalog effect is guaranteed a route
   * by test-shop-effects.js, so a shop item can no longer be silently inert.
   * @param {object} data — { effect, value, id, ... } (the catalog row)
   * @param {{ restore?: boolean }} [opts] — restore=true is the MENU_CONTINUE
   *   load path, where ResourceSystem.restore() has already set absolute maxes;
   *   the RESOURCE_SYSTEM route is then skipped for RESOURCE_RESTORED_EFFECTS to
   *   avoid double-counting cumulative bumps (e.g. batteryMax). Purchase and
   *   GAMEOVER_CONTINUE (from a reset base) pass no opts → full route.
   */
  applyUpgradeEffect(data, opts = {}) {
    const { player, armManager, resourceSystem, cargoSystem } = this._refs;
    // kesslerSystem / captureNetSystem: imported singletons

    for (const target of resolveEffectRoute(data.effect, opts)) {
      switch (target) {
        case RESOURCE_SYSTEM:
          resourceSystem.applyUpgrade(data);
          break;
        case PLAYER:
          player.applyUpgrade(data);
          break;
        case ARM_MANAGER:
          if (armManager) armManager.applyUpgrade(data, opts);
          break;
        case CARGO_SYSTEM:
          if (cargoSystem) cargoSystem.applyUpgrade(data);
          break;
        case SENSOR_EVENT:
          eventBus.emit(Events.SENSOR_UPGRADE, data);
          break;
        case KESSLER_SYSTEM:
          kesslerSystem.applyUpgrade(data);
          break;
        case CAPTURE_NET:
          captureNetSystem.loadOneMotherNet();
          break;
        case DAUGHTER_NET:
          // One net into the first docked daughter of that type with room (a consumable: no ownership record).
          if (armManager) armManager.addDaughterNet(DAUGHTER_NET_EFFECT_TYPE[data.effect]);
          break;
        case RUNTIME:
          // No apply-time action — checked at runtime via _hasUpgrade.
          break;
        case ARM_MANAGER_EVENT:
          // Handled by ArmManager's own UPGRADE_PURCHASED listener — do not
          // re-dispatch here (would double-apply on purchase).
          break;
      }
    }

    // F6: UPGRADE_APPLIED had ZERO emitters, so codex entries keyed to it
    // (tether_materials, trackable_vs_dark, plus the mpd_burst fallback) were
    // permanently locked. Emit it here — the single point every applied upgrade
    // flows through (purchase, restore, gameover-continue) — so those unlock and
    // legacy saves repair on load. Codex unlock is idempotent, so re-emitting on
    // restore is harmless. Payload carries the id/effect the matchers key on.
    eventBus.emit(Events.UPGRADE_APPLIED, {
      id: data.id,
      effect: data.effect,
      name: data.name,
    });
  }

  // ==========================================================================
  // SAVE / LOAD
  // ==========================================================================

  /**
   * Save current game state to localStorage.
   * @param {{ gameOver?: boolean }} [opts] - t1-stranded D4: `gameOver: true` ONLY from the GAME_OVER entry; the
   *   save then carries `gameOver: true` so menu CONTINUE applies the game-over CONTINUE rule. Every other call
   *   writes no flag.
   */
  saveGame(opts) {
    // Nets step 3 slice 2b: a save written while she is flying to a field would hold the gas billed so far and the field she
    // LEFT (the trip is not saved as a trip). So none is written mid-flight: a reload then finds the save of the mission
    // boundary - at the field she left, with the gas she had before the trip - and the arrival writes the next one.
    // (A game-over save is always written.)
    // Lane 3c: nor while a called satellite is on its way (the 1,000 credits are paid in memory, the berth is not there yet): a reload
    // finds the save from before the call, with the credits she had, and the stuck spell offers the call again.
    if (this._trip && (this._trip.isCalling() || (this._trip.isBurning() && this._trip.field)) && !(opts && opts.gameOver === true)) return;
    const { shopScreen, resourceSystem } = this._refs;
    const scoring = scoringSystem.serialize();
    const resources = resourceSystem.serialize();
    // s1-gas-survives-load D3: a game-over save carries no gas levels — CONTINUE after a game over is a fresh
    // attempt (like retry), so the load falls back to the start fill. Every other save keeps the levels.
    if (gameState.currentState === GameStates.GAME_OVER) {
      delete resources.xenon;
      delete resources.coldGas;
      delete resources.indiumStoreKg;   // lane 3f: a fresh attempt starts the indium store empty too
    }
    const upgrades = shopScreen.getSerializableUpgrades();

    const saveData = {
      gameOver: !!(opts && opts.gameOver === true),
      // u1-resupply-stop F2: the stop survives a reload inside the game-over shop (see MENU_CONTINUE).
      resupplyStop: (opts && typeof opts.resupplyStop === 'boolean') ? opts.resupplyStop : this._atResupplyStop === true,
      credits: scoring.credits,
      totalScore: scoring.totalScore,
      missionNumber: scoring.missionNumber,
      debrisCleared: scoring.debrisCleared,
      upgrades: upgrades,
      resourceMaxes: resources,
      power: powerDistribution.serialize(),
      // Item 100: the fleet launch-speed dial setting (restored after the
      // upgrade replay so the equipped spring tier clamps it).
      launchSpeed: this._refs.armManager?.getFleetLaunchSpeed?.(),
      contractMassKg: shopScreen ? shopScreen.getContractMass() : 0,
      // Preserve profile-permanent ceremony flags across full saves. Without
      // this, saveGame() would reset the whitelist to defaults (false) and drop
      // flags like FIRST_NET_DEPLOY / FIRST_DEPOT_VISITED set via setCeremonyFlag.
      ceremonyFlags: persistenceManager.peek()?.ceremonyFlags || {},
      stats: {
        totalCaptures: scoring.totalCaptures,
        manualCaptures: scoring.manualCaptures,
        missionsCompleted: scoring.missionsCompleted,
        bestMissionScore: scoring.bestMissionScore,
        bestStreak: scoring.bestStreak,
        debrisByTier: scoring.debrisByTier,
      },
    };

    // Nets step 3 lane 3f (DECISIONS §34 row 10): each daughter's ion fuel and cold gas ride in the save, so a reload keeps the fuel she
    // had spent. A game-over save carries none (CONTINUE is a fresh attempt: every tank full, as the xenon and cold gas levels above).
    if (gameState.currentState !== GameStates.GAME_OVER && this._refs.armManager && typeof this._refs.armManager.getSupplyState === 'function') {
      saveData.daughters = this._refs.armManager.getSupplyState();
    }

    // Nets step 3 slice 2b (FIELDS_BY_HEIGHT): the field she is at, which pieces of each field are left, and the days the
    // trips have added. `serialize()` answers null with the flag off, so a flag-off save is exactly what it was.
    const fieldsSave = this._refs.fieldRegistry ? this._refs.fieldRegistry.serialize() : null;
    if (fieldsSave) {
      saveData.fields = fieldsSave;
      if (gameState.shipDays > 0) saveData.shipDays = gameState.shipDays;
    }

    // Let self-managing systems contribute their state (e.g. SubsystemEvents)
    eventBus.emit(Events.PERSISTENCE_GATHER, saveData);

    persistenceManager.save(saveData);
  }

  // ==========================================================================
  // DEPOT AND CHAPTERS (Wave 5 Session E — docs/ladder/08-workbench.md §5 D3)
  // ==========================================================================

  /**
   * Wave 5 Session F (D4): is a depot STOP pending — the boundary dwell timer
   * (`_shopTimeoutId`: the card's COMPLETE_CARD_MS with the ladder on, the
   * shipped silent 2500 ms with it off) scheduled and not yet fired? The
   * mission-keyed onsets (MissionCoach chapters, the ISS / Starlink bosses) ARM
   * on MISSION_START — which now fires on the boundary catch, in this same
   * handler, BEFORE `_onMissionBoundary` schedules the stop — and hold while
   * this is true, so a boss never starts under the depot overlay; they fire on
   * the first gameplay frame after the SHOP closes (the timer nulls itself when
   * it fires; DEPLOY or the Esc exit both resume gameplay). An invitation
   * (every chapter with the ladder on — owner 2026-10-05, DECISIONS §14 —
   * unless MISSIONS.FORCED_DEPOT_STOP is turned back on) schedules nothing → false →
   * the onset fires at once, invitation open or not. Wired to the three
   * consumers as a predicate by main.js (`_bossLifecycle.MissionOnset` is the
   * shared rule). Read-only; nothing else keys on it.
   *
   * Wave 5 Session K (GFM lift, site 3 of 4): with the ladder on the stop is
   * no longer a GameState — the break happens IN gameplay (the workbench
   * floor, the REFIT drawer open) — so the hold ALSO covers the WORKBENCH
   * BREAK: true from `_stopAtWorkbench` (WORKBENCH_STOP) until the hub's
   * WORKBENCH_RESUME (both drawers closed) or any exit from gameplay. Chapter
   * beats start only after the drawer closes, exactly as they started only
   * after the SHOP closed. Ladder off `_workbenchBreak` is never set: the
   * predicate reads the dwell timer alone, as shipped.
   * @returns {boolean}
   */
  isDepotStopPending() {
    return this._shopTimeoutId != null || this._workbenchBreak;
  }

  /** @private The ladder flag, read live (tests flip it per rig). */
  _ladderOn() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED);
  }

  /**
   * c2-fifth-catch D2 — what a credited catch does with the mission start.
   *
   * The credit tick pays, narrates and (on a boundary) invites; it does not
   * also start the next mission while the catch is still at the nose — that
   * piled the mission's pieces, its lines and a collision-avoidance burn on
   * top of the catch that was still being carried away
   * (docs/research/2026-10-capture-repros.md, Repro C). So a PARKED credit
   * (the catch sits at the nose) that lands on a mission boundary with the
   * depot-invitation branch live (the same test `_onMissionBoundary` applies)
   * keeps `start` — the continuation that fires the mission transition — until
   * the catch is off the nose (`_releaseMissionStartFor`) or the cap runs out
   * (`update`). Everything else — a daughter-fed catch, a non-boundary clear,
   * the forced stop, the ladder off — runs `start` at once, as it always did.
   * A credit arriving during a hold drops the old hold first and then goes
   * through the same decision itself (ScoringSystem's dedupe means one start).
   * @param {{debrisId?: number|string, parked?: boolean}} data - the CATCH_PROCESSED payload
   * @param {() => void} start - fires the mission transition (scoringSystem.checkMissionTransition)
   * @private
   */
  _startMissionAfterCredit(data, start) {
    // trip-melt G1: a catch credited while the trip waits for its daughters or burns (a daughter home with a catch, a
    // net that was already in flight) starts nothing: the burn's end runs the scorer (`start` of the trip), which
    // starts whichever mission is then due.
    if (this._trip.isActive()) return;
    this._pendingMissionStart = null;
    const M = Constants.MISSIONS;
    const debrisCount = gameState.debrisCleared;
    const { missionsCompleted, perMission, debrisUntilShop } = getMissionProgress(debrisCount);
    const atBoundary = debrisCount > 0 && debrisUntilShop === perMission;
    // trip-melt D2: at a boundary the next mission starts when the burn to it ends, not now. `go` is the continuation
    // a held start releases into as well (every release path ends in `p.start()`), so the hold and the trip compose:
    // hold until the catch is off the nose, then burn, then start.
    const go = atBoundary ? () => this._beginTripThen(start) : start;
    // Mirror of _onMissionBoundary's invitation test — keep the two in step
    // (test-FifthCatchCalm pins that they agree).
    const invites = this._ladderOn() &&
      (!M.FORCED_DEPOT_STOP || missionsCompleted > M.FORCED_DEPOT_CHAPTERS);
    // no-melt: a daughter's rack credit (source 'rack') is not a catch sitting at the nose: nothing to wait for.
    if (data && data.parked && data.source !== 'rack' && data.debrisId != null && atBoundary && invites && gameState.isGameplay()) {
      this._pendingMissionStart = { debrisId: data.debrisId, elapsedS: 0, start: go };
      return;
    }
    go();
  }

  /**
   * trip-melt D2: begin the transfer trip, with `start` (the mission transition) as what runs when the burn ends.
   * The trip needs a ship and gameplay; without them (or with FEATURE_FLAGS.TRANSFER_TRIP off) the mission starts
   * at once, as it did before the trip existed.
   * @param {() => void} start
   * @private
   */
  _beginTripThen(start) {
    const r = this._refs;
    if (!Constants.isFeatureEnabled('TRANSFER_TRIP') || !r || !r.player || !gameState.isGameplay()) { start(); return; }
    this._syncTripDeps();
    // Nets step 3 slice 2b (FIELDS_BY_HEIGHT): with the flag on the boundary flies her to another field: the one the player picks on
    // the "where next" list (lane 2b-2), or with no floor 4 to ask on the nearest one she can reach (`FieldRegistry.defaultNext`);
    // none = she stays and the next mission starts at once. The arrival adds the profile's days to the ship's clock, starts the
    // mission (MISSION_START lays the field out) and saves.
    const reg = r.fieldRegistry;
    if (reg && reg.isOn()) {
      if (this._trip.isActive()) return;           // a trip is already on its way (or she is choosing): its arrival starts whichever mission is due
      // Lane 2b-2: with floor 4 there to ask on, the player picks the field (or Stay) on the LEO map; the trip waits in phase `choose`.
      if (this._whereNextOn) { this._openWhereNext(start); return; }
      // Lane 3c (C4b, owed from the 3a review): a berthed save loaded with no list to ask on (`?ladder=0`) lets go of the satellite first, so
      // buying closes; the nearest field is read while she is still berthed (every field counts, from the satellite) and flown to with the
      // berth gone (a trip that cannot go would otherwise open a choice nobody can answer). With nowhere to fly she goes back to her field.
      const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
      const field = reg.defaultNext();
      if (berth) { this._leaveBerth(berth); this._clearBerth(); }
      if (!(field && this._flyToField(field, start))) {
        if (berth && typeof reg.setHeight === 'function') reg.setHeight(reg.currentField().altKm);
        start();
      }
      return;
    }
    // trip-melt-2 D12a: a credit that reached the next boundary DURING the trip ran no boundary then (see the credit
    // handler); it runs now, once the burn has ended and the mission it started has fired MISSION_START.
    this._trip.begin(() => {
      start();
      this._runDeferredBoundary();
    });
  }

  /**
   * @private Nets step 3 slice 2b: begin the trip to `field`. The arrival adds the profile's days to the ship's clock, starts the
   * mission (MISSION_START lays the field out), runs the boundary a mid-trip credit reached, and saves.
   * @param {object} field a FieldRegistry field
   * @param {() => void} start the mission transition
   * @returns {boolean} false = the gas does not cover the whole profile (nothing begins; the words were said)
   */
  _flyToField(field, start) {
    const reg = this._refs && this._refs.fieldRegistry;
    const toSat = !!(reg && typeof reg.satelliteById === 'function' && reg.satelliteById(field.id));
    const fromBerth = !!(reg && typeof reg.isBerthed === 'function' && reg.isBerthed());
    return !!this._trip.begin(() => {
      const leg = this._trip.lastLeg;
      this._trip.lastLeg = null;
      if (leg) gameState.shipDays += leg.days;
      // Nets step 3 slice 3: a trip that is not to a field she will start a mission at. A trip to the satellite that arrived berths her
      // (no mission starts: the same start waits for the field she picks from there); one that could not go (`_stay`: no gas once planned
      // with her real mass, her nose could not be pointed) is a refused pick, from the berth too: she is where she was and the list is back.
      if (toSat && leg) { this._arriveAtSatellite(field, start); return; }
      if (!leg && (toSat || fromBerth)) { this._tripCouldNotGo(start, fromBerth); return; }
      start();
      this._runDeferredBoundary();
      if (leg) this.saveGame();
    }, { field });
  }

  /**
   * @private Nets step 3 slice 3 (S4, S5): the trip to the resupply satellite has arrived (the registry has berthed her: `arrive`). She
   * is handed any catch still mated at her nose collar, the stop opens (buying), the first berth tops credits up, one line says what to
   * do, `RESUPPLY_BERTH {berthed}` goes out, the game saves, and the list opens again from here with the SAME mission start kept: no
   * mission starts at the satellite, and a boundary a mid-choice credit deferred waits for the field she picks.
   * @param {object} sat the satellite @param {() => void} start the mission transition kept for the field pick
   */
  _arriveAtSatellite(sat, start) {
    this._enterBerth(sat, false);
    this.saveGame();
    this._openWhereNext(start, { said: true });
  }

  /**
   * @private The berth proper (arrival, or a trip from it that could not go and put her back). `again`: the second kind (the floor and the
   * line were done at the first berth).
   * @param {object} sat @param {boolean} again
   */
  _enterBerth(sat, again) {
    this._handOverCollarCatches();
    this._setResupplyStop(true);                                         // buying and selling open (the same flag today's stop uses)
    if (!again) {
      // the first-depot floor moves here (the boundary no longer opens the invitation that paid it): once per profile, the framing owed
      if (this._applyFirstDepotFloor()) this._firstVisitOwed = true;
      eventBus.emit(Events.COMMS_MESSAGE, { text: this._berthLine(), priority: 'info', _keep: true });
    }
    eventBus.emit(Events.RESUPPLY_BERTH, { phase: 'berthed', satId: sat.id, altKm: sat.altKm });
  }

  /**
   * @private S5: a catch still mated at her nose collar (no free tip on the trip) goes to the satellite first. It was paid at the mate
   * (CATCH_PROCESSED { parked: true }), so the hand-over credits nothing: the net leaves the system (CaptureNet.handOverCollarCatch frees
   * the collar) and the body leaves the field (`removeDebris`: its row was already taken at the credit). Catches on the daughters' racks and
   * the radiator tips stay with her.
   */
  _handOverCollarCatches() {
    const cns = captureNetSystem;
    const df = this._refs && this._refs.debrisField;
    if (!cns || typeof cns.handOverCollarCatch !== 'function') return;
    for (let i = 0; i < 8; i++) {                                        // (one collar: the loop is only a bound)
      const id = cns.handOverCollarCatch();
      if (id == null) break;
      if (df && typeof df.removeDebris === 'function') df.removeDebris(id);
    }
  }

  /**
   * @private A trip begun from the list that did not go (the words were said by the trip): the choice is put back as after a refused pick,
   * rebuilt. From the berth she never left in fact: buying opens again and `RESUPPLY_BERTH {berthed}` says so (no line, no floor).
   * @param {() => void} start @param {boolean} fromBerth
   */
  _tripCouldNotGo(start, fromBerth) {
    const reg = this._refs && this._refs.fieldRegistry;
    const sat = fromBerth && reg ? reg.berthedSatellite() : null;
    if (sat) this._enterBerth(sat, true);
    this._trip.choose({ start }, { again: true });
  }

  /** @private Nets step 3 slice 3: she lets go of the satellite (the trip from it begins): buying closes, `RESUPPLY_BERTH {left}`. */
  _leaveBerth(sat) {
    this._setResupplyStop(false);
    eventBus.emit(Events.RESUPPLY_BERTH, { phase: 'left', satId: sat.id, altKm: sat.altKm });
  }

  /** @private A game over, a win or the menu: she is no longer berthed anywhere (the registry's reset follows on a new run). */
  _clearBerth() {
    const reg = this._refs && this._refs.fieldRegistry;
    if (reg && typeof reg.clearBerth === 'function') reg.clearBerth();
  }

  /** @private The mother nets aboard now (the list pre-focuses the satellite with none), or undefined when it cannot be read. */
  _motherNetsAboard() {
    return captureNetSystem && typeof captureNetSystem.getMotherNetCount === 'function' ? captureNetSystem.getMotherNetCount() : undefined;
  }

  /**
   * Lane 3c: is a mission start owed, i.e. did a boundary ask her where next (the scorer's mission number is above the last mission that
   * started)? False in the middle of a mission: the list opened because she is out of gas, and trips wait for the mission's end.
   * @returns {boolean}
   */
  missionStartOwed() {
    const reg = this._refs && this._refs.fieldRegistry;
    if (!reg || typeof reg.lastMissionStarted !== 'function') return true;
    return scoringSystem.getMissionNumber() > reg.lastMissionStarted();
  }

  /** Lane 3c: what the "where next" rows need besides the registry (main.js `getRows` and every list this class builds read it). */
  whereNextRowsOpts() {
    return {
      motherNets: this._motherNetsAboard(), credits: scoringSystem.credits, gasCredits: this._gasBuyPrice(), startOwed: this.missionStartOwed(),
      turnWaitS: this._turnWaitsS(),
    };
  }

  /**
   * @private Slice 4 (S2): the real seconds a trip begun now would wait for her nose, up and down (the autopilot reads her attitude): the list's
   * days include it, because the trip counts that wait as flown time. Undefined when the attitude cannot be read (the days are then the profile's).
   * @returns {{up: number, down: number}|undefined}
   */
  _turnWaitsS() {
    if (!this._shipCanTurn()) return { up: 0, down: 0 };       // a daughter still on her line: the trip flies no turn (TransferTrip._canTurn), so no wait
    const ap = this._refs && this._refs.autopilotSystem;
    return ap && typeof ap.tripTurnWaitsS === 'function' ? (ap.tripTurnWaitsS() || undefined) : undefined;
  }

  /**
   * @private Nothing limits the ship's turn: the same two limits `TransferTrip._canTurn` reads (a daughter out on a tether holds the rotation
   * lock; one clamped for a launch). Without the turn the trip flies no turn wait (fix round 1, F3), so the list adds none either.
   * @returns {boolean}
   */
  _shipCanTurn() {
    const am = this._refs && this._refs.armManager;
    if (!am) return true;
    if (typeof am.getRotationLockTier === 'function' && am.getRotationLockTier() !== 'none') return false;
    return !(Array.isArray(am.arms) && am.arms.some((a) => a && a.state === Constants.ARM_STATES.LAUNCHING));
  }

  /**
   * @private Review fix F1: what one engine-gas buy costs now (`upgradeCostNow`, the ONE price accessor): the call needs it on top of its own
   * price, because at the berth the stop rule "credits + cargo below the gas price = stranded" ends the run 15 s after an arrival without it.
   * @returns {number} credits (0 when the price cannot be read: the call then needs only its own price)
   */
  _gasBuyPrice() {
    const { resourceSystem } = this._refs || {};
    const row = UPGRADES.find((u) => u.id === 'gas_resupply');
    const price = row && resourceSystem ? upgradeCostNow(row, resourceSystem) : 0;
    return Number.isFinite(price) && price > 0 ? price : 0;
  }

  /** @private The berth line: a satellite called to her mid-mission sends her to Stay here (there is no field to fly to), else the usual. */
  _berthLine() {
    const reg = this._refs && this._refs.fieldRegistry;
    return reg && typeof reg.berthedHere === 'function' && reg.berthedHere() && !this.missionStartOwed() ? BERTH_MISSION_LINE : BERTH_LINE;
  }

  /** main.js: floor 4 exists and hosts the "where next" list (see `_whereNextOn`). @param {boolean} on */
  setWhereNextAvailable(on) {
    this._whereNextOn = !!on;
    this._pushTradeWording();                  // slice 3: with the list there the satellite is the stop: the shop's refusal names it
  }

  /**
   * @private Nets step 3 slice 2b, lane 2b-2 (decision K): open the "where next" choice. Nothing she can pick (no reachable field
   * and nothing left here) says so and starts the next mission where she is, as `defaultNext()` = none does; otherwise the trip
   * waits in phase `choose` with the mission start kept for the pick, one comms line says what to do, and `Events.WHERE_NEXT`
   * opens the list on floor 4 (main.js). The choice waits for her: no timeout.
   * Slice 3: berthed at the resupply satellite (the list reopened from it, or a load into the berth) nothing starts here ever: with
   * nothing she can pick the list stays open with the line "Buy gas at the workbench, then pick a field." and the opening line is the
   * berth's (not "Mission done").
   * @param {() => void} start the mission transition
   * @param {{said?: boolean}} [opts] `said`: the line was just said (the berth arrival says its own)
   */
  _openWhereNext(start, opts) {
    const reg = this._refs.fieldRegistry;
    const berthed = typeof reg.isBerthed === 'function' && reg.isBerthed();
    const rows = buildWhereNextRows(reg, this.whereNextRowsOpts());
    if (rows.line) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: rows.line, priority: 'info', _keep: true });
      if (!berthed) { start(); return; }
    }
    this._syncTripDeps();
    if (!(opts && opts.said)) eventBus.emit(Events.COMMS_MESSAGE, { text: berthed ? this._berthLine() : OPEN_LINE, priority: 'info', _keep: true });
    this._trip.choose({ start });
  }

  /**
   * Nets step 3 slice 2b, lane 2b-2: the player's pick on the "where next" list. A field id begins the trip to it (the arrival is as
   * after any trip); STAY_ID starts the next mission where she is, runs the boundary a mid-choice credit reached and always saves
   * (the boundary save says the trip is still owed). A pick that cannot be flown (the gas changed, the field was emptied) puts the
   * choice back and rebuilds the list; it never leaves the choice, or the next catch would start the mission unasked.
   * @param {string} id a field id ('f400') or STAY_ID
   * @returns {boolean} true = the trip began or the mission started here; false = nothing happened (not choosing, or refused)
   */
  pickWhereNext(id) {
    const trip = this._trip;
    const reg = this._refs && this._refs.fieldRegistry;
    if (!trip.isChoosing() || !reg) return false;
    const choice = trip.choice;
    const start = choice && typeof choice.start === 'function' ? choice.start : () => {};        // (`_openWhereNext` always hands one)
    // Nets step 3 slice 3: berthed at the satellite she FLEW to no field is hers and there is no Stay (S6); the satellite itself is a pick
    // only from a field (S4). A satellite CALLED to her (lane 3c) leaves her field hers: Stay lets go of it, the mission goes on here.
    const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
    const atSat = !!berth && !(typeof reg.berthedHere === 'function' && reg.berthedHere());
    const owed = this.missionStartOwed();
    if (id === CALL_ID) return this._callSatellite(choice, start);
    if (id === STAY_ID) {
      if (atSat) return false;                                             // no Stay at the satellite (the list has no such row)
      if (owed && reg.remainingCount(reg.currentId()) <= 0) return false;  // nothing here to stay for (the list has no such row; a mission going on always has one)
      trip.leaveChoice();
      if (berth) { this._leaveBerth(berth); this._clearBerth(); }          // a called satellite lets go: buying closes, the field is hers again
      start();
      this._runDeferredBoundary();
      this.saveGame();
      return true;
    }
    const sat = typeof reg.satelliteById === 'function' ? reg.satelliteById(id) : null;
    const field = sat || reg.fieldById(id);
    if (!field) return false;
    if (!owed) return false;                                               // trips wait for the end of a mission that is going on (the rows say so)
    if (sat ? !!(berth && berth.id === sat.id) : (!atSat && field.id === reg.currentId())) return false;     // (berthed: that satellite is where she is, the other one is a pick (fix round 1, F4); the field she left is a pick)
    if (!sat && reg.remainingCount(field.id) <= 0) return false;
    this._syncTripDeps();
    trip.leaveChoice();                                                    // idle again, so `begin` accepts the trip
    if (this._flyToField(field, start)) {
      if (berth) this._leaveBerth(berth);                                  // the trip began: buying closes, she lets go
      return true;
    }
    trip.choose(choice, { again: true });                                  // the gas changed: back to the list, rebuilt, with the refusal said
    return false;
  }

  /**
   * @private Lane 3c (C2; §33 row 7 "Stuck: call it to you for 1,000 credits"): the call row was picked. The row must be on the list and
   * selectable (the same rows the player sees: not berthed, the satellite cannot be flown to, the wallet covers the call); the credits go
   * at once; she holds where she is while the satellite comes (TransferTrip phase `call`, RESUPPLY_BERTH {coming}); when it arrives the
   * days go on the ship's clock and she is berthed here (`_arriveAtSatellite`: buying, the first-berth floor, the collar hand-over, the
   * line, the save, the list again with the SAME start kept). A call that cannot begin gives the credits back and puts the list back.
   * @param {object} choice the open choice (put back on a refusal) @param {() => void} start the mission transition kept for the pick
   * @returns {boolean} true = the satellite is on its way
   */
  _callSatellite(choice, start) {
    const trip = this._trip;
    const reg = this._refs && this._refs.fieldRegistry;
    if (!reg || !this._satelliteIsTheStop() || (typeof reg.isBerthed === 'function' && reg.isBerthed())) return false;
    const row = buildWhereNextRows(reg, this.whereNextRowsOpts()).rows.find((r) => r.id === CALL_ID);
    if (!row || !row.selectable) return false;
    const sat = reg.satelliteById(row.satId);
    const price = Constants.RESUPPLY.CALL_CREDITS;
    if (!sat || !scoringSystem.spendCredits(price)) return false;
    this._syncTripDeps();
    trip.leaveChoice();
    const began = trip.beginCall(() => {
      const leg = trip.lastLeg;
      trip.lastLeg = null;
      if (leg) gameState.shipDays += leg.days;
      this._arriveAtSatellite(reg.berthedSatellite() || sat, start);
    }, { sat, days: row.days });
    if (began) return true;
    scoringSystem.addCredits(price);
    trip.choose(choice, { again: true });
    return false;
  }

  /**
   * @private Nets step 3 slice 2b (FIELDS_BY_HEIGHT; review F1): the mission boundary credit writes its save while the trip to the
   * next field is still to be flown (the daughters are coming home), and a mid-flight save is skipped, so a reload of it finds her
   * at the field she left with the next mission's catch count. The save says so (`FieldRegistry` keeps the last mission that
   * started); after the load, once her field is laid out, the boundary is taken again: the trip begins from here, with the gas
   * she had before it. With floor 4 there to ask on (lane 2b-2) `_beginTripThen` opens the "where next" list here.
   * @param {number} dt real seconds (0 while the world is held)
   */
  _resumeOwedTrip(dt) {
    const reg = this._refs && this._refs.fieldRegistry;
    if (!reg || typeof reg.takeResumeTrip !== 'function' || !(dt > 0) || this._trip.isActive() || !gameState.isGameplay()) return;
    if (!reg.takeResumeTrip()) return;
    // (the one call site of the mission check that follows no clearDebris(): the start a load found owed; test-ScoringSystem pins it)
    this._beginTripThen(() => { scoringSystem.checkMissionTransition(); });
  }

  /** @private trip-melt-2 D12a: the boundary a mid-trip credit reached runs after the trip's mission start. */
  _runDeferredBoundary() {
    const n = this._deferredBoundary;
    this._deferredBoundary = null;
    if (n == null || !gameState.isGameplay()) return;
    this._onMissionBoundary(n);
  }

  /** @private Hand the trip the collaborators it reads (cheap; also run from init, tests set _refs directly). */
  _syncTripDeps() {
    const r = this._refs || {};
    const am = r.armManager;
    this._trip.setDeps({
      player: r.player,
      armManager: r.armManager,
      autopilot: r.autopilotSystem,
      noseWaiting: () => this._noseCanLeash(),
      carryBusy: () => !!(am && typeof am.isCarrying === 'function' && am.isCarrying()),
      rackCanCarry: () => !!(am && typeof am.rackCanCarry === 'function' && am.rackCanCarry()),
      // Nets step 3 slice 2b: the trip's face of the field registry (the piece store is DebrisField's; the selection is cleared
      // because a stored piece may be the target)
      fields: r.fieldRegistry ? {
        planTo: (f, o) => r.fieldRegistry.planTo(f, o),
        depart: () => { r.fieldRegistry.depart(); targetSelector.setTarget(null, { silent: true }); },
        arrive: (id, o) => r.fieldRegistry.arrive(id, o),
      } : null,
    });
  }

  /** The transfer trip (tests and main.js read its state). */
  get trip() { return this._trip; }

  /** True while a trip burns: the world clock targets Constants.TRIP.TIME_RATE (main.js). */
  isTripRunning() { return this._trip.isBurning(); }

  /** Nets step 3 slice 2b (lane 2b-2): the mission boundary is waiting for the player's pick on the "where next" list (the FMA strip's line). */
  isWhereNextPending() { return this._trip.isChoosing(); }

  /**
   * trip-melt D6: is a catch at the nose collar waiting to move to a radiator tip - one the hand-off can still take?
   * A hand-off under way counts. Read-only mirror of `CaptureNetSystem._tryLeash`'s preconditions (it fits a tip, a tip
   * is free, the tip is in reach, the gas is enough); a catch that fails one of them is not waited for. Rack
   * catches (trip-melt-2) are not asked here.
   * @returns {boolean}
   * @private
   */
  _noseCanLeash() {
    const player = this._refs && this._refs.player;
    const drv = player && player.leashDriver;
    const tc = player && player.tipCargo;
    const nets = captureNetSystem && captureNetSystem.activeNets;
    if (!drv || !tc || !Array.isArray(nets)) return false;
    const COLLARED = Constants.CAPTURE_NET.STATES.COLLARED;
    const cook = Constants.isFeatureEnabled('FURNACE_COOK');
    for (const net of nets) {
      if (!net || !net._isMother) continue;
      // a hand-off with the catch still on its way to a tip: the trip waits for it to land (once it has landed the
      // tip holds it, and a driver that is only putting the radiators back is not a reason to burn on)
      if (net._leash || net._leashNoseReel) return true;
      if (net.state !== COLLARED || net._leashFailed) continue;
      const d = net.targetDebris;
      if (!d) continue;
      if (!tc.fits(DebrisField.trueReachM(d, 2))) continue;
      const tip = tc.pickTip();
      if (tip == null) continue;
      if (!(drv.canReach(d, tip) || drv.canReachAtNose(net, d, tip))) continue;
      // trip-melt G3: a hand-off the driver refuses right now (a daughter out on her tether, the radiators busy, a turn
      // under way) is not waited for: `_tryLeash` would decline it too, and the trip would burn to its 120 s cap for nothing.
      if (typeof drv.refusal === 'function' && drv.refusal(net)) continue;
      if (!cook && typeof drv.gasShort === 'function' && drv.gasShort(net, d, tip, { noseReel: !drv.canReach(d, tip) })) continue;
      return true;
    }
    return false;
  }

  /**
   * u20-nets: the bodies a credit pays. A solo catch (or no body at all) is `[debris]`; a scoop bag is its members' own bodies
   * (`bagMembers[i].piece`), so every member is scored and salvaged exactly as if it had been caught alone, while the caller
   * still counts ONE catch (`gameState.clearDebris()` once). A member already paid is left out.
   * @param {object|null} debris the held body the credit came for
   * @returns {Array<object|null>}
   * @private
   */
  _creditBodies(debris) {
    if (debris && debris.isBag === true && Array.isArray(debris.bagMembers)) {
      return debris.bagMembers.map((m) => m.piece).filter((p) => p && !p._credited);
    }
    return [debris];
  }

  /**
   * Release the held mission start if `debrisId` is the catch it waits on.
   * Any other id (a piece cut off the catch, another net) is ignored.
   * @param {number|string|undefined} debrisId
   * @private
   */
  _releaseMissionStartFor(debrisId) {
    const p = this._pendingMissionStart;
    if (!p || debrisId == null || debrisId !== p.debrisId) return;
    this._releaseMissionStart();
  }

  /** @private Fire the held mission start now (clears the hold first). */
  _releaseMissionStart() {
    const p = this._pendingMissionStart;
    if (!p) return;
    this._pendingMissionStart = null;
    p.start();
  }

  /**
   * Per-frame tick (main.js, right after gameState.update): counts GAME time
   * toward the held mission start's cap. Never a timer — the hold must follow
   * a paused or held world (dt 0 counts nothing) and the depot flow pins that
   * no timer is created at a boundary.
   * @param {number} dt - seconds of game time this frame (0 while the world is held)
   */
  update(dt) {
    // t1-stranded D1: first, before the held-mission-start early return below (that one returns on almost every frame)
    this._updateStranded(dt);
    this._resumeOwedTrip(dt);
    // trip-melt D2/D6: the burn between missions (waits for the daughters, then burns; `dt` is 0 while the world is held)
    this._trip.update(dt);
    const p = this._pendingMissionStart;
    if (!p) return;
    if (!(dt > 0) || !gameState.isGameplay()) return;
    // no-melt: with no furnace a catch the nose cannot place never leaves it by itself, so the hold has nothing to wait
    // for once the hand-off has been tried and declined. (A hand-off still under way keeps the hold, and its cap.)
    if (!Constants.isFeatureEnabled('FURNACE_COOK') && typeof captureNetSystem.getNoseFullLine === 'function' && captureNetSystem.getNoseFullLine()) { this._releaseMissionStart(); return; }
    p.elapsedS += dt;
    // l5c-reach E6: while the leash hand-off carries the catch to a radiator tip the 20 s cap does not run
    // (the hand-off is ~45-120 s; the catch leaving the nose releases the start by itself). A safety cap of
    // LEASH.MISSION_WAIT_MAX_S game seconds in total still ends the wait if the hand-off never finishes.
    // Ref path: this._refs.player.leashDriver (built in main.js; absent in headless tests).
    if (p.elapsedS >= Constants.LEASH.MISSION_WAIT_MAX_S) { this._releaseMissionStart(); return; }
    const busy = !!(this._refs && this._refs.player && this._refs.player.leashDriver && this._refs.player.leashDriver.busy);
    if (busy) return;
    p.idleS = (p.idleS || 0) + dt;
    const cap = Constants.MISSIONS.START_AFTER_CATCH_MAX_S;
    if (p.idleS >= cap) this._releaseMissionStart();
  }

  /**
   * t1-stranded D4: menu CONTINUE of a game-over save hands off to the game-over screen's CONTINUE: the very same
   * listeners run (the GFM one above, KesslerSystem's self-reset). A method rather than an inline emit so the
   * GAMEOVER_CONTINUE listener stays the first place the event name appears in this file (test-OpeningDance and
   * test-SunStaging slice that listener's body by source text).
   * @private
   */
  _continueAfterGameOver() {
    eventBus.emit(Events.GAMEOVER_CONTINUE);
  }

  // ==========================================================================
  // STRANDED (t1-stranded) — out of gas and unable to pay for more ends the run
  // ==========================================================================

  /**
   * The two "empty" levels the thrust paths use, in the tanks' own units.
   *  - `ion`: engine pool units one second of full ion thrust costs. Mirrors ionGasUnits
   *    (PlayerSatellite.js:134): ṁ = c·m·Δv/(Isp·g0), pool = ṁ/kgFull·100, with Δv = the autopilot's thrust ceiling
   *    Constants.AUTOPILOT.MAX_ACCEL (× the tank gas's thrustScale) for 1 s, m = the ship's total mass
   *    (armManager.getMassBudget), c = the Efficient Ion Drive gain × the THRUST-bus split
   *    (PlayerSatellite.js:53 consumptionMultiplier).
   *  - `cold`: cold-gas units one second of full RCS attitude command costs: `_coldGasRate` × RCS_ATTITUDE_N2_FACTOR
   *    (PlayerSatellite.js:8934 / :8428). Below this the tank cannot pay a one-second command.
   * A float residue (1e-6) is below both, so it counts as empty.
   * @returns {{ion: number, cold: number}}
   * @private
   */
  _strandedThresholds() {
    return { ion: this._strandedIonThreshold(), cold: this._strandedColdThreshold() };
  }

  /** Cold-gas half of `_strandedThresholds` (no mass lookup). @private */
  _strandedColdThreshold() {
    const { player } = this._refs;
    const rate = player && Number.isFinite(player._coldGasRate) ? player._coldGasRate : 0.5;
    return rate * ((Constants.ATTITUDE && Constants.ATTITUDE.RCS_ATTITUDE_N2_FACTOR) ?? 1.0);
  }

  /** Engine-pool half of `_strandedThresholds` (does the `getMassBudget` lookup). @private */
  _strandedIonThreshold() {
    const { player, armManager, resourceSystem } = this._refs;
    const fuels = Constants.FUELS || {};
    const tank = fuels[resourceSystem.tankGasId] || fuels[Constants.DEFAULT_FUEL];
    let massKg = 0;
    try {
      const b = armManager && typeof armManager.getMassBudget === 'function' ? armManager.getMassBudget() : null;
      massKg = b && b.shipMassKg > 0 ? b.shipMassKg : 0;
    } catch (_) { massKg = 0; }
    if (!(massKg > 0)) massKg = Constants.OCTOPUS_V5.CORE_DRY_MASS;
    const base = player && player._baseIonXenonRate;
    const gain = base > 0 && Number.isFinite(player._ionThrustXenonRate) ? player._ionThrustXenonRate / base : 1;
    const tm = powerDistribution.thrustMultiplier;
    const c = gain * (tm > 0 ? 1 / tm : 1);
    const dv = Constants.AUTOPILOT.MAX_ACCEL * (tank.thrustScale > 0 ? tank.thrustScale : 1);   // m/s in 1 s
    const kg = c * massKg * dv / (tank.isp * Constants.G0);
    return tank.kgFull > 0 ? kg / tank.kgFull * 100 : 0;
  }

  /**
   * Credits the CARGO pane would pay right now for everything in the hold: SELL ALL (ShopScreen._sellAllCargo ->
   * computeSaleValue: SELL_PRICE_MODIFIER, plus the bulk bonus on the total), plus the elevator's per-kg bonus on
   * refined metal while the contract is still open (a contribution pays sale value + bonus). Needs neither depot
   * nor thrust. 0 with no cargo system.
   * @returns {number}
   * @private
   */
  _strandedCargoCredits() {
    const { cargoSystem } = this._refs;
    if (!cargoSystem || typeof cargoSystem.getManifest !== 'function') return 0;
    let totalValue = 0, totalMass = 0, bonus = 0;
    const perKg = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG) || 5;
    for (const item of cargoSystem.getManifest()) {
      if (!item || typeof item.metalId !== 'string') continue;
      totalValue += item.value || 0;
      totalMass += item.massKg || 0;
      if (!this._elevatorWinTriggered && item.metalId.startsWith('refined_')) bonus += Math.round((item.massKg || 0) * perKg);
    }
    return computeSaleValue(totalValue, totalMass).saleValue + bonus;
  }

  /**
   * x1-held-catch D1: has this held piece been paid for? A catch pays exactly once, in the CATCH_PROCESSED handler
   * above (`payCredit`): it marks the FIELD object `debris._credited = true` (looked up by id). A holder may keep a
   * shallow SNAPSHOT of that body instead (a mother net's `targetDebris`, and the very object `_stowHeldCatch` pushes
   * onto a daughter's rack after the cargo hand-off), so the field object is read first, then the piece's own flag.
   * A piece that is missing, or has no id to look up, counts as NOT paid: it keeps blocking, as before this rule.
   * @param {object|null|undefined} piece - a rack entry, a tip-cargo debris, a daughter's in-hand catch, a net's target
   * @returns {boolean}
   * @private
   */
  _piecePaid(piece) {
    if (!piece || piece.id == null) return false;
    const { debrisField } = this._refs || {};
    if (debrisField && typeof debrisField.getDebrisById === 'function') {
      const field = debrisField.getDebrisById(piece.id);
      if (field && field._credited === true) return true;
    }
    return piece._credited === true;
  }

  /**
   * D1 (d): is anything under way that could still pay credits or load gas without the mother thrusting?
   * Credits, salvage and gas all land in ONE place, the catch's CATCH_PROCESSED credit (see `_piecePaid`); a catch that
   * has been paid can never pay again, however long it takes to digest. So a held catch blocks only until it is paid
   * (x1-held-catch D1-D3). Predicates (each guarded: headless tests wire only some of these):
   *  - a daughter out: any arm whose state is not DOCKED / EXPENDED / ADRIFT / RELOADING / HOLDING_CATCH (ArmManager.js:2283
   *    getDeployedCount counts ADRIFT and RELOADING too, which the plan says must not block, so the filter is
   *    spelled out here). She winches home within seconds, so every other out state blocks. ADRIFT stays non-blocking:
   *    R drops an adrift daughter's catch unpaid (ArmUnit.recall).
   *  - a daughter holding a catch: any piece on her rack (arm.heldCatches) that is not yet paid; HOLDING_CATCH blocks
   *    only while a rack piece or her in-hand capturedDebris is unpaid. A rack digests in max(6 s, 2 s/kg) (up to
   *    2000 s, slower in eclipse) but pays nothing at its end once the mate or an earlier digestion has paid.
   *  - tip cargo: a piece on a radiator tip (player.tipCargo.debrisAt(i)) that is not yet paid; tip cargo is always
   *    already paid in the game, so this is the same rule, not a special case.
   *  - a mother-net catch or net in flight: any active mother net not in {FOLDED, STOWED, MISSED, RELEASED} - that
   *    is BERTHED / COLLARED / TRANSFERRING (ArmManager.js:2836-2890) and the flight states before them
   *    (ArmManager.js:2671-2672 netInFlight); CaptureNet.activeNets (CaptureNet.js:3370). A COLLARED or TRANSFERRING net
   *    blocks only while its catch is unpaid (`net._berthProcessed` is set when the mate pays, CaptureNet.js ~:3549);
   *    a paid catch can sit at the collar for good (over 2000 kg, no daughter to take it, a cut plan under way).
   *  - a leash hand-off carrying a catch: player.leashDriver.isActive() (LeashDriver.js:167).
   *  - the lasso: lassoSystem.active (LassoSystem.js:89).
   * @returns {boolean}
   * @private
   */
  _paymentUnderWay() {
    const { player, armManager, lassoSystem } = this._refs;
    const A = Constants.ARM_STATES;
    const arms = (armManager && Array.isArray(armManager.arms)) ? armManager.arms : [];
    for (const arm of arms) {
      if (!arm) continue;
      const rack = arm.heldCatches;
      if (rack && rack.length > 0) {
        for (let i = 0; i < rack.length; i++) if (!this._piecePaid(rack[i])) return true;
      }
      const st = arm.state;
      if (st === A.HOLDING_CATCH) {
        if (arm.capturedDebris && !this._piecePaid(arm.capturedDebris)) return true;
        continue;
      }
      if (st !== A.DOCKED && st !== A.EXPENDED && st !== A.ADRIFT && st !== A.RELOADING) return true;
    }
    const tc = player && player.tipCargo;
    const tipCount = (tc && typeof tc.count === 'function') ? tc.count() : 0;
    if (tipCount > 0) {
      // TipCargo has 4 slots (SLOT_COUNT, not exported); an empty slot reads null. Any bag this loop cannot read
      // (no debrisAt, a slot past the scan) counts as unpaid and blocks.
      let seen = 0;
      if (typeof tc.debrisAt === 'function') {
        for (let i = 0; i < 16 && seen < tipCount; i++) {
          const d = tc.debrisAt(i);
          if (!d) continue;
          if (!this._piecePaid(d)) return true;
          seen++;
        }
      }
      if (seen < tipCount) return true;
    }
    const S = Constants.CAPTURE_NET.STATES;
    const OVER = [S.FOLDED, S.STOWED, S.MISSED, S.RELEASED];
    const nets = Array.isArray(captureNetSystem.activeNets) ? captureNetSystem.activeNets : [];
    for (const n of nets) {
      if (!n || !n._isMother || OVER.includes(n.state)) continue;
      if ((n.state === S.COLLARED || n.state === S.TRANSFERRING) && (n._berthProcessed || this._piecePaid(n.targetDebris))) continue;
      return true;
    }
    const ld = player && player.leashDriver;
    if (ld && typeof ld.isActive === 'function' && ld.isActive()) return true;
    if (lassoSystem && lassoSystem.active) return true;
    return false;
  }

  /**
   * D1: is the ship stranded RIGHT NOW? All of (a)-(d) hold: gameplay; both tanks empty (below one second of thrust);
   * (c) the ship is not at the resupply stop (nothing can be bought mid-mission — u1-resupply-stop D6), or it is
   * and the credits plus the cargo's sale value cannot buy the engine-gas resupply row (or it is not purchasable);
   * nothing under way could still pay.
   * @returns {boolean}
   * @private
   */
  _isStranded() {
    if (!gameState.isGameplay()) return false;
    // Lane 3c: she has paid for the call and the satellite is on its way: she is not stranded, she is waiting for it (else the grace would
    // end the run mid-wait, with the credits gone and no gas bought yet).
    if (this._trip && this._trip.isCalling()) return false;
    const { resourceSystem, shopScreen } = this._refs || {};
    if (!resourceSystem) return false;
    const fuel = typeof resourceSystem.getCurrentFuel === 'function' ? resourceSystem.getCurrentFuel() : null;
    if (fuel && fuel.fromCargo) return false;                         // a cargo-fed fuel counts as engine gas present
    if (!(resourceSystem.coldGas < this._strandedColdThreshold())) return false;   // cold gas for >= 1 s
    const row = UPGRADES.find((u) => u.id === 'gas_resupply');
    const owned = shopScreen && shopScreen.purchasedUpgrades;
    const purchasable = !!row && upgradePrereqsMet(row, owned || new Map(), (f) => Constants.isFeatureEnabled(f));
    // u1-resupply-stop D6 (owner 2026-10-17: there is no store in the middle of space): credits and cargo can pay
    // for gas only AT the resupply stop. Mid-mission nothing can be bought, so condition (c) holds whatever the
    // wallet; at the stop it holds when credits plus the cargo's sale value fall short of the resupply price.
    if (purchasable && this._atResupplyStop) {
      const wealth = scoringSystem.credits + this._strandedCargoCredits();
      if (wealth >= upgradeCostNow(row, resourceSystem)) return false;
    }
    // Last of the tank checks: it needs the ship-mass lookup, so a frame with gas or money never pays for it.
    if (!(resourceSystem.xenon < this._strandedIonThreshold())) return false;   // engine gas for >= 1 s of thrust
    // Lane 3c (C2): while the list is open with a call she can pay for, she is not stranded: the call is the way out, and the choice
    // waits for her (declined, the stranded countdown below runs as it always did).
    if (this._trip && this._trip.isChoosing() && this._callSelectable()) return false;
    return !this._paymentUnderWay();
  }

  /**
   * @private Lane 3c: both tanks below one second of thrust, nothing else considered (the wallet, the stop, payments under way): what
   * `_isStranded` starts from. Ends an offered call's spell when gas comes back.
   * @returns {boolean}
   */
  _outOfGas() {
    const { resourceSystem } = this._refs || {};
    if (!resourceSystem) return false;
    const fuel = typeof resourceSystem.getCurrentFuel === 'function' ? resourceSystem.getCurrentFuel() : null;
    if (fuel && fuel.fromCargo) return false;
    return resourceSystem.coldGas < this._strandedColdThreshold() && resourceSystem.xenon < this._strandedIonThreshold();
  }

  /**
   * @private Lane 3c: would the list show a call row she can pick right now, for a ship that is OUT OF GAS (every caller has established
   * that: `_isStranded` past its tank checks, `_outOfGas`)? The satellite is the stop, she is not berthed, there is a satellite, and the
   * wallet covers the call. Out of gas the satellite row cannot be flown to (a trip needs gas for its whole profile; one second of
   * thrust is not that), so the call row is there and selectable: this needs no rows (they cost a trip plan per field, and this runs
   * every frame while she looks at the list). The pick itself (`_callSatellite`) asks the real rows.
   * @returns {boolean}
   */
  _callSelectable() {
    const reg = this._refs && this._refs.fieldRegistry;
    if (!reg || !this._satelliteIsTheStop() || (typeof reg.isBerthed === 'function' && reg.isBerthed())) return false;
    if (typeof reg.satellites !== 'function' || reg.satellites().length === 0) return false;
    return scoringSystem.credits >= Constants.RESUPPLY.CALL_CREDITS + this._gasBuyPrice();
  }

  /**
   * @private Lane 3c (C3; §33 row 7): out of gas away from the satellite with the call paid for by her wallet, the countdown does not run:
   * ONE line says she can call it, and the list opens (in the middle of a mission nothing is owed: the kept start is the scorer's own
   * check, a no-op unless a mission is due). Offered once per spell: she may stay (then the countdown runs as before). While a trip waits
   * or burns, today's rules hold.
   * @returns {boolean} true = she is being offered the call (no countdown)
   */
  _strandedCallOffer() {
    const trip = this._trip;
    if (trip.isActive()) return false;           // choosing: `_isStranded` already says "not stranded" while the call is on the list; waiting or burning: today's rules
    if (this._callOffered) return false;         // she was offered it and stayed
    if (!this._callSelectable()) return false;
    this._callOffered = true;
    eventBus.emit(Events.COMMS_MESSAGE, { text: STUCK_CALL_LINE, priority: 'high', _critical: true, _keep: true });
    this._openWhereNext(() => { scoringSystem.checkMissionTransition(); }, { said: true });
    return true;
  }

  /**
   * D1/D2 per-frame step: the stranded timer. A held world (dt 0) advances nothing and changes nothing. When any of
   * (a)-(d) stops holding the timer resets and the spell may announce again. At STRANDED_GRACE_S emits
   * RESOURCE_DEPLETED { reason: 'stranded' } once (the listener moves to GAME_OVER) and resets.
   * @param {number} dt - seconds of game time this frame
   * @private
   */
  _updateStranded(dt) {
    if (!this._refs) return;
    if (!(dt > 0)) return;
    if (!this._isStranded()) {
      this._strandedS = 0;
      // Lane 3c: an offered call's spell lasts while she is out of gas; a list that was already open at a boundary (nothing offered yet)
      // says the same line once, here, where the countdown would have started
      // (only while it matters - an offered call, or a list open - so a frame of normal flight never pays for the tank lookup)
      if (this._callOffered || this._trip.isChoosing()) {
        if (!this._outOfGas()) this._callOffered = false;
        else if (!this._callOffered && this._trip.isChoosing() && this._callSelectable()) {
          this._callOffered = true;
          eventBus.emit(Events.COMMS_MESSAGE, { text: STUCK_CALL_LINE, priority: 'high', _critical: true, _keep: true });
        }
      }
      return;
    }
    if (this._strandedCallOffer()) { this._strandedS = 0; return; }
    const grace = Constants.STRANDED_GRACE_S;
    if (this._strandedS === 0) {
      // D6: mid-mission the wallet is irrelevant (nothing can be bought); at the stop it is the reason.
      const why = this._atResupplyStop ? 'Out of gas, and not enough credits to buy more.' : 'Out of gas.';
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${why} The mission ends in ${grace} s unless a catch is under way.`,
        priority: 'high',
        _critical: true,                // pass the onboarding comms filter (commsSuppression)
      });
    }
    this._strandedS += dt;
    if (this._strandedS >= grace) {
      this._strandedS = 0;
      eventBus.emit(Events.RESOURCE_DEPLETED, { reason: 'stranded' });
    }
  }

  /**
   * Wave 5 Session K — the ONE ladder-on-gameplay depot entry (plan D-B: one
   * shop, one place). Called by the `transitionToState(SHOP)` redirect (site 1)
   * and by the boundary dwell (site 2); never with the ladder off, never
   * outside gameplay. Does what the SHOP entry did for the depot bookkeeping —
   * the first-depot grant (`_applyFirstDepotFloor`, the one rule) and the
   * invitation close ('entered') — then opens the break and emits
   * WORKBENCH_STOP for the hub (ride down at the crossing duration + open the
   * REFIT drawer with the first-visit chip). A stop while the break is already
   * open (B pressed at the workbench; the dwell landing after a B-key visit
   * that is still open) is a no-op: the player is already there.
   * @param {boolean} boundary - true from the chapter dwell, false from B /
   *   the STORE chip / a legacy caller
   * @private
   */
  _stopAtWorkbench(boundary) {
    if (this._workbenchBreak) return;
    // First visit = the floor pays now, OR the first invitation already paid it
    // and the framing is still owed (consumed here, once).
    // u1-resupply-stop D4: the floor is paid at the resupply stop only; a mid-mission look pays nothing.
    const floorPaid = this._atResupplyStop ? this._applyFirstDepotFloor() : false;
    const owed = this._firstVisitOwed;
    this._firstVisitOwed = false;
    const firstDepotVisit = floorPaid || owed;
    this._closeDepotInvitation('entered');
    const { missionsCompleted } = getMissionProgress(gameState.debrisCleared);
    this._workbenchBreak = true;
    eventBus.emit(Events.WORKBENCH_STOP, {
      chapter: missionsCompleted + 1,
      missionsCompleted,
      firstDepotVisit,
      boundary: !!boundary,
    });
  }

  /**
   * The ONE depot decision at a mission boundary — called by the CATCH_PROCESSED
   * handler when a credited catch lands exactly on a SHOP_CADENCE multiple while
   * in gameplay (the sole live SHOP-entry decision per catch; the legacy
   * INTERACTION_* timers below are production-unreachable — see
   * test-shop-cadence "legacy INTERACTION paths").
   *
   *   • Ladder OFF (`?ladder=0` / LADDER.ENABLED false): the shipped path,
   *     byte-identical — the comms line + the silent 2500 ms `_shopTimeoutId`
   *     → SHOP. Chapters and the doorway are workbench features built behind
   *     the ladder flag (08-workbench §10); without the rail and the F3
   *     doorway an invitation has nowhere to point.
   *   • Chapters 1..FORCED_DEPOT_CHAPTERS with `MISSIONS.FORCED_DEPOT_STOP`
   *     true (OFF since the owner ruling 2026-10-05 — docs/DECISIONS.md §14:
   *     after every mission the depot is an invitation, from chapter 1; this
   *     branch is kept behind the flag, not deleted; with the flag false the
   *     ladder-on boundary is the invitation path below for EVERY chapter) —
   *     the completed chapter, every boundary catch closes one): the forced stop made CEREMONIAL. The comms
   *     line stays; a "MISSION N COMPLETE" card lands on the shipped teaching
   *     toast (TEACHING_MOMENT_FORCE → TeachingSystem._forceShow →
   *     TeachingOverlay — owner decision 4: reuse, no new DOM surface) and
   *     the SAME `_shopTimeoutId` timer, now the card's dwell
   *     (MISSIONS.COMPLETE_CARD_MS — owner decision 1: a fixed 2.5 s, the old
   *     timer's length), flips into the SHOP as the card finishes fading (the
   *     card holds for dwell − TEACHING.FADE_OUT_MS). The card IS the cause:
   *     one timer, one number, no silent cut.
   *   • Every chapter (flag false, the default) or chapter
   *     FORCED_DEPOT_CHAPTERS+1 on (flag true): NO forced stop — the depot is an
   *     INVITATION (`_openDepotInvitation`): comms "UPGRADES AVAILABLE" (owner
   *     wording 2026-09-05 — the doorway is retired, Session H), ONE
   *     `DEPOT_INVITATION { open: true }` (the WHERE rail's notch 1 AND the
   *     REFIT tab glow — VisualLaw VALUE, steady), and the first-depot 600 cr
   *     floor moves to the first invitation if the depot was never entered
   *     (the SAME `_applyFirstDepotFloor` — one grant rule, one place, two
   *     callers). Getting there is the ordinary ride down to floor 1 — the
   *     shop is the REFIT drawer, one shop, one place; nothing in ZoomLadder
   *     softens. The window is "until the next credited catch" (owner decision
   *     2): the CATCH_PROCESSED handler lapses it; any SHOP entry closes it as
   *     'entered'.
   *
   *   • Nets step 3 slice 3 (S7; `_satelliteIsTheStop()`: flag on, floor 4 there): none of the above. The boundary opens NO stop and no
   *     invitation (buying moved to the resupply satellite, reached from the "where next" list); only the MISSION_COMPLETE headline stays.
   *
   * @param {number} debrisCount - gameState.debrisCleared at the boundary (a
   *   positive multiple of SHOP_CADENCE)
   * @private
   */
  _onMissionBoundary(debrisCount) {
    const M = Constants.MISSIONS;
    const ladderOn = !!(Constants.LADDER && Constants.LADDER.ENABLED);
    const { missionsCompleted } = getMissionProgress(debrisCount);
    // Nets step 3 slice 3 (S7; DECISIONS §33 row 7): with the resupply satellite as the stop (flag on, floor 4 there to ask on) a completed
    // mission opens NO stop and no depot invitation: all buying moved to the satellite, reached by the "where next" list the 5th catch
    // opens. The "MISSION N COMPLETE" headline and its cue stay (the same event the invitation used to carry).
    if (this._satelliteIsTheStop()) {
      eventBus.emit(Events.MISSION_COMPLETE, { mission: missionsCompleted, debrisCleared: debrisCount });
      return;
    }
    // u1-resupply-stop D1: a completed mission opens the resupply stop on EVERY path below (the ladder-on
    // invitation, the forced stop, the ladder-off boundary shop) — it stays open until the next credited catch.
    this._setResupplyStop(true);
    if (ladderOn && (!M.FORCED_DEPOT_STOP || missionsCompleted > M.FORCED_DEPOT_CHAPTERS)) {
      this._openDepotInvitation(debrisCount, missionsCompleted);
      return;
    }
    // The forced stop (every chapter with the ladder off; chapters 1..N with it
    // on). The comms line stays (shipped text, shipped priority).
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${debrisCount} debris cleared. Return to depot for resupply`,
      priority: 'high',
    });
    let dwellMs = 2500;   // the shipped silent cut (ladder off)
    if (ladderOn) {
      // The card ceremony — the dwell becomes the card's.
      dwellMs = M.COMPLETE_CARD_MS;
      const fadeMs = (Constants.TEACHING && Constants.TEACHING.FADE_OUT_MS) || 500;
      eventBus.emit(Events.TEACHING_MOMENT_FORCE, {
        id: `mission_complete_${missionsCompleted}`,
        title: `MISSION ${missionsCompleted} COMPLETE`,
        body: `${debrisCount} debris cleared. Opening the depot for resupply.`,
        duration: Math.max(0, dwellMs - fadeMs),
        icon: '\u25C6',
      });
    }
    this._shopTimeoutId = timerManager.setTimeout(() => {
      if (gameState.isGameplay()) {
        // Session K (GFM lift, site 2 of 4): the dwell lands on the WORKBENCH
        // with the ladder on — the ride down + the REFIT drawer, the boundary
        // flagged so the hub can tell the ceremony from a B-key visit. Ladder
        // off: the shipped SHOP flip, byte-identical.
        if (this._ladderOn()) this._stopAtWorkbench(true);
        else this.transitionToState(GameStates.SHOP);
      }
      this._shopTimeoutId = null;
    }, dwellMs, { owner: this });
  }

  /**
   * Open the depot invitation — after every mission with the ladder on (owner
   * ruling 2026-10-05, docs/DECISIONS.md §14; chapter FORCED_DEPOT_CHAPTERS+1 on
   * only when MISSIONS.FORCED_DEPOT_STOP is true).
   * A boundary landing while one is already open (only possible if the window
   * outlived a whole chapter — it cannot, the next catch lapses it) simply
   * re-opens it for the new chapter: the notch glow is idempotent.
   * @param {number} debrisCount
   * @param {number} missionsCompleted - the chapter just completed
   * @private
   */
  _openDepotInvitation(debrisCount, missionsCompleted) {
    // The first-depot floor moves to the first INVITATION when the depot was
    // never entered — the same one-shot rule + flag as the SHOP entry (a
    // visited profile returns false and pays nothing).
    const firstInvitation = this._applyFirstDepotFloor();
    if (firstInvitation) this._firstVisitOwed = true;   // the framing waits for the visit
    this._depotInvitation = { chapter: missionsCompleted + 1, debrisCleared: debrisCount };
    // m1-finish: the "mission complete" moment — a headline that fades by itself and one
    // success cue (HUD / AudioSystem listen). Not a stop: no card, no hold (DECISIONS §14).
    eventBus.emit(Events.MISSION_COMPLETE, { mission: missionsCompleted, debrisCleared: debrisCount });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `UPGRADES AVAILABLE \u2014 ${debrisCount} debris cleared. Come down when ready, or fly on. The stop closes at your next catch.`,
      priority: 'high',
      _keep: true,   // comms-after-tutorial D6: the next step - never folded into "x N queued"
    });
    eventBus.emit(Events.DEPOT_INVITATION, {
      open: true, chapter: missionsCompleted + 1, debrisCleared: debrisCount, firstInvitation,
    });
  }

  /**
   * Close the open depot invitation, if any: ONE `DEPOT_INVITATION { open:
   * false, reason }` so the rail's notch glow ends. Idempotent — nothing open,
   * nothing emitted (every caller is a "maybe": SHOP entry, the next catch,
   * terminal states, resetGame).
   * @param {'entered'|'lapsed'|'reset'} reason
   * @private
   */
  _closeDepotInvitation(reason) {
    if (!this._depotInvitation) return;
    const was = this._depotInvitation;
    this._depotInvitation = null;
    eventBus.emit(Events.DEPOT_INVITATION, { open: false, reason, chapter: was.chapter });
  }

  /**
   * Per-catch progress line (M1 guidance T7, missions 1–3 only): after each
   * credited clear that is NOT a mission boundary, one short HOUSTON line —
   * "Mission N: k/5 cleared. Clear m more for depot resupply." — so a new
   * player always knows where they stand in the chapter (the owner report was
   * a cluster that "drifts away / vanishes" with nothing telling the player
   * how much is left). Same vocabulary as the continue-flow objective line
   * above ("Clear N more debris for depot resupply."); no new terms.
   *
   *   • Guided chapters only: `isGuidedChapterNumber(missionNum)` — the
   *     profile's `guidedCluster` flag, missions 1–3 (FORCED_DEPOT_CHAPTERS).
   *     From mission 4 on the chapter count is ambient — no line. (The depot
   *     is an invitation after every mission since owner 2026-10-05,
   *     DECISIONS §14 — the line still says how far off the next one is.) The mission number comes from the pure
   *     `getMissionProgress(gameState.debrisCleared)`, which IS correct on a
   *     bare Continue (no MISSION_START fires on restore — DebrisField's
   *     profile-based isGuidedChapter() would read M1 there).
   *   • The boundary catch is skipped (debrisUntilShop === perMission ⇔ the
   *     count just landed on a multiple): `_onMissionBoundary` already shows
   *     the "UPGRADES AVAILABLE" invitation there (the "MISSION N COMPLETE"
   *     card only with MISSIONS.FORCED_DEPOT_STOP on). Callers: the CATCH_PROCESSED non-boundary
   *     branch (which never lands on a boundary, so the guard is belt-and-
   *     braces) and the ARM_DEORBIT sacrifice path (which has no boundary
   *     handling of its own — the guard is what keeps the 5th clear quiet).
   *   • Suppression: `_postOnboarding` — passes from tier 1 on (HOUSTON
   *     channel passes at ramp tier 1 anyway); at tier 0, while the Director's
   *     first beats run, it is muted BY DESIGN: `first_catch` / `second_catch`
   *     narrate those catches.
   * @private
   */
  _postMissionProgressLine() {
    const { perMission, missionNum, debrisUntilShop } = getMissionProgress(gameState.debrisCleared);
    if (debrisUntilShop >= perMission) return;           // a boundary — the ceremony owns it
    if (!isGuidedChapterNumber(missionNum)) return;      // missions 4+ — no line
    const cleared = perMission - debrisUntilShop;
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'HOUSTON', priority: 'info',
      text: `Mission ${missionNum}: ${cleared}/${perMission} cleared. Clear ${debrisUntilShop} more for ${stopWords(this)}.`,
      _postOnboarding: true,
      _keep: true,   // comms-after-tutorial D6: mission progress - never folded into "x N queued"
    });
  }

  /**
   * First-depot settlement (first-credit legibility + early-shop tension plan).
   * On the player's true first depot visit only — gated by the profile-permanent
   * FIRST_DEPOT_VISITED ceremony flag — pay a one-time, on-theme "first cleanup
   * contract settled" bonus that tops the wallet UP TO Constants.SHOP.FIRST_DEPOT_FLOOR
   * if it is below that. This guarantees one ~500 starter is affordable without
   * gifting two upgrades or the 800 net. Runs once per profile and survives
   * GAMEOVER_CONTINUE (which resets debrisCleared but not the flag).
   * Called on SHOP entry (a depot arrival), never on SHOP_DEPLOY (exit) — and,
   * since Wave 5 Session E, at the first depot INVITATION (after every mission
   * since owner 2026-10-05, DECISIONS §14 — so from mission 1): the floor moves
   * to the invitation when the depot was never entered, and the first-visit
   * framing is owed to the next workbench stop (`_firstVisitOwed`). ONE rule, ONE flag, two callers.
   * @returns {boolean} true when this was the first depot visit (so the shop can
   *   render its one-time first-visit framing + recommended-starter ⭐). The
   *   FIRST_DEPOT_VISITED flag is persisted here, so callers must use this
   *   return value rather than re-reading the flag afterward.
   * @private
   */
  _applyFirstDepotFloor() {
    if (persistenceManager.getCeremonyFlag('FIRST_DEPOT_VISITED')) return false;

    const FLOOR = (Constants.SHOP && Constants.SHOP.FIRST_DEPOT_FLOOR) || 600;
    const topUp = Math.max(0, FLOOR - scoringSystem.credits);
    if (topUp > 0) {
      scoringSystem.addCredits(topUp);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `First cleanup contract settled \u2014 +$${topUp} cr to your refit budget.`,
        priority: 'success',
      });
    }

    // Persist the new credits, then mark the flag (read-modify-write preserves
    // the freshly-saved wallet + other ceremony flags).
    this.saveGame();
    persistenceManager.setCeremonyFlag('FIRST_DEPOT_VISITED', true);
    return true;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================
  /**
   * Check if a specific upgrade has been purchased.
   * @param {string} upgradeId - e.g. 'hazmat_handler', 'salvage_scanner'
   * @returns {boolean}
   */
  _hasUpgrade(upgradeId) {
    const { shopScreen } = this._refs;
    if (!shopScreen) return false;
    let found = false;
    shopScreen.forEachPurchasedUpgrade((data) => {
      if (data.id === upgradeId) found = true;
    });
    return found;
  }

  // ==========================================================================
  // ARM DEPLOYMENT
  // ==========================================================================

  /**
   * Deploy a V3 Octopus arm to capture the selected debris target.
   */
  deployArm() {
    const { armManager } = this._refs;
    // targetSelector: imported singleton
    const target = targetSelector.getActiveTarget();
    if (!target || !target.alive) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'DAUGHTER: No target selected. Press [T] to cycle targets',
        priority: 'warning',
      });
      return;
    }
    if (!armManager) return;

    const dockedBefore = (armManager.arms || []).filter(a => a.state === Constants.ARM_STATES.DOCKED);
    const deployed = armManager.deployArm(target);

    // Aim-before-launch: when a rotation ceremony is in flight, deployArm returns
    // true at ceremony START (the daughter hasn't launched yet). Suppress the
    // premature "deployed" confirmation — AutopilotSystem already posted the
    // "Rotating to launch attitude" comms, and the real launch fires after the
    // slew resolves. Only confirm here for immediate (non-ceremony) deploys.
    // mother-aims: the same holds for a strut-only launch that waits for her strut to swing
    // (the mother cannot turn): deployArm is true, no arm has left the dock yet.
    const ceremonyInFlight = (armManager._autopilot
      && typeof armManager._autopilot.isAiming === 'function'
      && armManager._autopilot.isAiming())
      || (dockedBefore.length > 0 && dockedBefore.every(a => a.state === Constants.ARM_STATES.DOCKED));

    // UX: Confirm deployment via comms (ARM_PILOT is auto-entered by InputManager)
    if (deployed && !ceremonyInFlight) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughter deployed. Press her number to fly her.',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'info',
      });
    } else if (!deployed) {
      // H1 2026-10-09: `else if (!deployed)` — a ceremony-in-flight deploy
      // (deployed true, daughter not launched yet) used to fall in here and post
      // a false "Launch refused" while the daughter launched anyway.
      // 2026-05-15 polish task 5: G-key fail-quiet was the user-reported
      // bug. ArmManager.deployArm() already emits specific COMMS_MESSAGE
      // events for the common rejection paths (no-arm, safe-mode, no
      // power, mass exceeded, active-sat treaty, etc.). The one silent
      // path is when ArmManager finds a docked arm but ArmUnit.deploy()
      // returns false (state mismatch, spring uncharged via internal
      // check). We backstop with a generic-but-actionable fallback so
      // the player never wonders why nothing happened. The specific
      // ArmManager comms will still have fired first if applicable.
      // Inspect the fleet to give the most useful diagnostic when the
      // ArmManager path produced no signal.
      const arms = armManager.arms || [];
      const docked   = arms.filter(a => a.state === Constants.ARM_STATES.DOCKED);
      const charged  = docked.filter(a => a.springCharged !== false);
      let reason;
      if (arms.length === 0) {
        reason = 'No arms installed. Visit shipyard';
      } else if (docked.length === 0) {
        reason = 'All arms deployed or returning. Press [Shift+R] to reel in all';
      } else if (charged.length === 0) {
        reason = 'All docked arms are reloading springs. Wait for charge';
      } else if (target.mass && charged.every(a => target.mass > (a.config?.maxCaptureMass || 0))) {
        const maxCap = Math.max(...charged.map(a => a.config?.maxCaptureMass || 0));
        reason = `Target too massive (${Math.round(target.mass)} kg > ${maxCap} kg max capture)`;
      } else {
        reason = 'Launch refused. Check status panel';
      }
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `DAUGHTER: ${reason}`,
        priority: 'warning',
      });
    }
  }
}

export const gameFlowManager = new GameFlowManager();
