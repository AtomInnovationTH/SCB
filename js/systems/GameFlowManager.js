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
import timerManager from './TimerManager.js';
import { CameraViews } from './CameraSystem.js';
import { scoringSystem } from './ScoringSystem.js';
import { audioSystem } from './AudioSystem.js';
import { persistenceManager } from './PersistenceManager.js';
import { powerDistribution } from './PowerDistribution.js';
import { targetSelector } from './TargetSelector.js';
import { kesslerSystem } from './KesslerSystem.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { trawlManager } from './TrawlManager.js';
import { launchSequence } from './LaunchSequence.js';
import { orbitToSceneCartesian, subPointToOrbit } from '../entities/OrbitalMechanics.js';
import { settingsManager } from './SettingsManager.js';
import { VIEW_INFO_LEVELS } from '../ui/HUD.js';
import {
  resolveEffectRoute,
  RESOURCE_SYSTEM, PLAYER, ARM_MANAGER, SENSOR_EVENT,
  KESSLER_SYSTEM, CAPTURE_NET, RUNTIME, ARM_MANAGER_EVENT,
} from './upgradeEffectRoutes.js';

class GameFlowManager {
  constructor() {
    /** @type {boolean} */
    this.paused = false;

    /** @type {object|null} */
    this.approachTarget = null;

    /** @type {boolean} */
    this.approachComplete = false;

    /** @type {number|null} */
    this._shopTimeoutId = null;

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

    // First-depot visit signal, computed BEFORE the flag is persisted so the
    // shop can render its one-time framing/⭐ on the actual first visit. Passed
    // through GAME_STATE_CHANGE (the flag write below would otherwise flip to
    // true before ShopScreen reads storage in its own handler).
    let firstDepotVisit = false;

    // Clear pending shop timeout on terminal states
    if (state === GameStates.GAME_OVER || state === GameStates.WIN) {
      if (this._shopTimeoutId) { timerManager.clear(this._shopTimeoutId); this._shopTimeoutId = null; }
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
            eventBus.emit(Events.COMMS_MESSAGE, {
              source: 'HOUSTON', channel: 'CMD', priority: 'info',
              text: 'Comms are up, Cowboy. We have you on telemetry.',
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
        firstDepotVisit = this._applyFirstDepotFloor();
        break;

      case GameStates.GAME_OVER:
        this.saveGame(); // Persist progress before game over
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
      this.resetGame();
      // deep-polish-4: if the player SKIPPED the menu departure, suppress the
      // sim intro zoom too (respect the skip). Set AFTER resetGame(), which
      // clears the flag. Read once by the ORBITAL_VIEW enter below.
      this._suppressIntroZoom = !!(data && data.skipped);
      this._applyStartLocation();   // place ground track over the player's home region
      gameState.currentState = GameStates.MENU; // Allow transition from MENU
      persistenceManager.backupSave(); // F1 save-guard: back up before New Game clears it
      persistenceManager.deleteSave(); // New Game clears any existing save
      // ST-9.11 C-5: Start launch sequence on new game (flag-gated)
      if (Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
        const { armManager } = this._refs;
        launchSequence.start(armManager, persistenceManager);
      }
      this.transitionToState(GameStates.ORBITAL_VIEW);
    });

    // Menu → Fast Start (LEGACY / reserved hook, 2026-07 menu overhaul).
    // The KeyF "fast start" shortcut was removed from MenuScreen — no emitter
    // remains for MENU_FAST_START. This handler is kept as a reserved hook
    // (matching the codebase convention of retaining unused Events constants,
    // e.g. PERSISTENCE_SAVED) and is byte-identical to MENU_START above.
    eventBus.on(Events.MENU_FAST_START, () => {
      this.resetGame();
      this._applyStartLocation();   // place ground track over the player's home region
      gameState.currentState = GameStates.MENU;
      persistenceManager.backupSave(); // F1 save-guard: back up before New Game clears it
      persistenceManager.deleteSave(); // New Game clears any existing save
      // ST-9.11 C-5: Start launch sequence on new game (flag-gated)
      if (Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
        const { armManager } = this._refs;
        launchSequence.start(armManager, persistenceManager);
      }
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
      gameState.currentState = GameStates.MENU; // Allow transition from MENU

      // Skip first-experience guidance for returning players
      // (must be AFTER resetGame which resets these flags)
      this._firstOrbitalView = false;
      this._firstTimeComms = new Set([
        'orbital_view_opening', 'first_target', 'autopilot_arrived',
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

      // Restore upgraded resource capacities (refills to max)
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

      // Rollout backfill: FIRST_DEPOT_VISITED is newer than some saves. Without
      // this, _applyFirstDepotFloor() (gated on that flag) would fire its
      // one-time "first cleanup contract settled" credit floor on the next depot
      // visit of every PRE-EXISTING player, mutating veteran wallets and showing
      // new-pilot framing. A loaded save with any progression (debris cleared or
      // upgrades bought) is by definition past its true first depot, so mark the
      // flag seen for them. Genuinely fresh profiles start via MENU_START and
      // still earn the bonus on their real first depot.
      const pastFirstDepot = (save.debrisCleared || 0) > 0
        || (Array.isArray(save.upgrades) && save.upgrades.length > 0);
      if (pastFirstDepot && !persistenceManager.getCeremonyFlag('FIRST_DEPOT_VISITED')) {
        persistenceManager.setCeremonyFlag('FIRST_DEPOT_VISITED', true);
      }

      // Sync to gameState
      gameState.debrisCleared = save.debrisCleared || 0;
      gameState.score = save.totalScore || 0;

      // Notify self-managing systems that a saved game was loaded
      // (TutorialSystem listens to skip tutorial for veterans)
      eventBus.emit(Events.PERSISTENCE_LOADED);

      // Returning players already know what the score bar is — activate it
      // immediately (no 5s delay). The ORBITAL_VIEW timer is gated behind
      // _firstOrbitalView (set false above) so it won't fire for this path.
      eventBus.emit(Events.HUD_GROUP_ACTIVATE, { group: 'score' });

      // ST-9.11 C-5: Resume launch sequence from persisted phase
      if (Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
        const savedPhase = persistenceManager.getLaunchPhase();
        const earlyPhases = ['STOWED_IN_FAIRING', 'LIFTOFF', 'FAIRING_SEPARATION',
                             'ORBIT_INSERTION', 'LAUNCH_LOCK_RELEASE'];
        if (savedPhase !== 'READY') {
          const { armManager } = this._refs;
          if (earlyPhases.includes(savedPhase)) {
            // Pre-ROSA: restart fresh launch (game-design choice — documented)
            launchSequence.start(armManager, persistenceManager);
          } else {
            // Mid/post-ROSA: snap to READY with full power + all arms STOWED
            launchSequence.start(armManager, persistenceManager);
            launchSequence.skipToReady();
          }
        }
      }

      this.transitionToState(GameStates.BRIEFING);
    });

    // ==================================================================
    // BRIEFING EVENTS
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
      if (this._elevatorWinTriggered) {
        // Phase E: tag the win so the GameOverScreen shows the anchor-run
        // (elevator) variant and the endgame codex unlocks gate correctly.
        const { shopScreen } = this._refs;
        const totalMassKg = (shopScreen && typeof shopScreen.getContractMass === 'function')
          ? shopScreen.getContractMass() : 0;
        eventBus.emit(Events.GAME_WIN, {
          ...scoringSystem.getStats(),
          winType: 'elevator',
          totalMassKg,
        });
      }
    });

    // ==================================================================
    // GAME OVER EVENTS
    // ==================================================================

    // Game over → Retry
    eventBus.on(Events.GAMEOVER_RETRY, () => {
      persistenceManager.deleteSave(); // clear stale save on retry
      this.resetGame();
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

      // Reset scoring, then restore carried credits
      scoringSystem.reset();
      scoringSystem.credits = carriedCredits;

      // Reset resources
      resourceSystem.reset();

      // Reset player orbit to starting position
      player.orbit.semiMajorAxis = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;
      player.orbit.trueAnomaly = 0;

      // Reset target selection (imported singleton — emits TARGET_CLEARED → DebrisWireframe self-clears)
      targetSelector.setTarget(null);

      // Reset arms (fresh ArmUnits — upgrades re-applied below)
      if (armManager) armManager.reset();

      this.approachTarget = null;
      this.approachComplete = false;

      // Reset camera to default chase view
      if (cameraSystem) cameraSystem.setView(CameraViews.CHASE);

      // KesslerSystem self-resets via GAMEOVER_CONTINUE listener (Batch 3)

      // Re-apply ALL purchased upgrade effects (systems were just reset)
      shopScreen.forEachPurchasedUpgrade((data) => {
        this.applyUpgradeEffect(data);
      });

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
          // Check for shop visit every 5 clears
          if (gameState.debrisCleared % 5 === 0 && gameState.debrisCleared > 0) {
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
          if (gameState.debrisCleared % 5 === 0 && gameState.debrisCleared > 0) {
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
    // ==================================================================

    eventBus.on(Events.CONTRACT_COMPLETE, () => {
      this._elevatorWinTriggered = true;
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

    // PARK-THE-CATCH delivery timing (HANDOFF §1.9): salvage + scoring + field
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

        // Award score via scoring system
        scoringSystem.awardPoints({
          debris: debris || { type: 'fragment', mass: 100, tumbleRate: 0, brittleness: 0 },
          method: 'arm',
          captureTier: 3, // CAPTURE tier (physical capture)
          tacticalAssessment: assessed,
          manualCapture: manualCapture,
          fuelEfficient: fuelEfficient,
          salvageRecovered: !!hasSalvage,
          detachedCapture: returningArm?.isDetached || false,
        });

        // Reset manual capture flag after scoring
        if (returningArm) {
          returningArm._manualCapture = false;
        }

        // Comms notification (via EventBus — CommsSystem self-manages)
        eventBus.emit(Events.COMMS_SEND, {
          source: (data.armId || 'DAUGHTER').toUpperCase(),
          text: 'Catch fully processed. Salvage in the bin',
          priority: 'INFO',
        });

        // --- SALVAGE RECOVERY (Session 10) ---
        if (hasSalvage) {
          const salvage = debris.salvage;
          const refineryMult = this._hasUpgrade('refinery_arm') ? 1.5 : 1.0;

          // Xenon → main satellite fuel
          if (salvage.xenon > 0 && resourceSystem) {
            resourceSystem.replenish('xenon', salvage.xenon * refineryMult);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `\u26CF Salvaged ${salvage.xenon.toFixed(1)} kg Xenon \u2014 \u0394V extended!`,
              priority: 'good',
            });
          }

          // Indium → refuel the arm that captured it
          if (salvage.indium > 0 && returningArm) {
            const C = Constants;
            const tankSize = returningArm.type === 'weaver'
              ? C.INDIUM_FULL_TANK_WEAVER
              : C.INDIUM_FULL_TANK_SPINNER;
            const fuelRestore = (salvage.indium * refineryMult / tankSize) * 100;
            returningArm.fuel = Math.min(100, returningArm.fuel + fuelRestore);
            eventBus.emit(Events.ARM_REFUELED, {
              armId: returningArm.id, amount: fuelRestore,
            });
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `\u26CF ${returningArm.displayName}: Indium recovered \u2014 FEEP fuel +${fuelRestore.toFixed(0)}%`,
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

        // Update game state debris counter (belt-and-suspenders with scoringSystem)
        gameState.clearDebris();

        // Furnace consumed the catch — remove it from the field (emits
        // DEBRIS_REMOVED; wireframe/pins self-clear). Deferred here from the old
        // ARM_RETURNED/DEBRIS_CAPTURED path under park-the-catch.
        if (debrisField && data.debrisId != null) {
          debrisField.removeDebris(data.debrisId);
        }

        // Auto-save after successful capture
        this.saveGame();

        // Wireframe self-clears via DEBRIS_REMOVED listener (Batch 3)

        // Auto-clear dead target — only if current target is the captured debris.
        // InputManager.handleCaptureAdvance already selects the next-best target
        // on ARM_CAPTURED / LASSO_CAPTURED. Only provide fallback if nothing selected.
        const currentTarget = targetSelector.activeTarget;
        if (currentTarget && debris && currentTarget.id === (debris.id ?? data.debrisId)) {
          targetSelector.setTarget(null);
        }
        if (!targetSelector.activeTarget) {
          const playerPos = player ? player.getPosition() : null;
          if (playerPos && debrisField) {
            const nearby = debrisField.getDebrisNear(playerPos, 0.5); // wide radius
            const nextTarget = nearby.find(d => d.discovered && d.alive);
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

        // ── Shop trigger: every 5 debris cleared ──
        const debrisCount = gameState.debrisCleared;
        const SHOP_INTERVAL = 5;
        if (debrisCount > 0 && debrisCount % SHOP_INTERVAL === 0) {
          if (gameState.isGameplay()) {
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `${debrisCount} debris cleared. Return to depot for resupply`,
              priority: 'high',
            });
            this._shopTimeoutId = timerManager.setTimeout(() => {
              if (gameState.isGameplay()) {
                this.transitionToState(GameStates.SHOP);
              }
              this._shopTimeoutId = null;
            }, 2500, { owner: this });
          }
        }
      }
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
      scoringSystem.awardPoints({
        debris: debris || { type: 'fragment', mass: 100, tumbleRate: 0, brittleness: 0 },
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

      // Comms: report ΔV and perigee lowering
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `\u0394V burn: ${deorbitDV.toFixed(1)} m/s. Perigee lowered ~${perigeeDropKm.toFixed(0)} km`,
        priority: 'info',
      });

      // Update game state
      gameState.clearDebris();
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
      if (to === 'ORBITAL_VIEW' && this._firstOrbitalView) {
        this._firstOrbitalView = false;

        // Opening comms hint — after the boot trickle (last boot line at 2600ms).
        timerManager.setTimeout(() => {
          const { debrisField, player } = this._refs;
          if (!player || !debrisField) return;

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

        // Landmark reference callout — points out the homeland feature visible
        // on the opening pass (Languages.sight). Staggered a beat after the
        // contacts hint so the arrival isn't a text wall. No-ops when the
        // language has no `sight`.
        timerManager.setTimeout(() => {
          const { player } = this._refs;
          if (!player) return;
          if (!this._firstTimeComms.has('orbital_view_landmark')) {
            this._firstTimeComms.add('orbital_view_landmark');
            const lang = settingsManager.getLanguageEntry();
            const sight = lang && lang.sight;
            if (sight) {
              eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'SPACECRAFT',
                text: `Off your port side: the ${sight}. Your reference point.`,
                priority: 'info',
              });
            }
          }
        }, 4400, { owner: this });
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
            text: `${typeLabel} locked. Press A to approach.`,
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
          text: 'DISCOVERY: Watch the net slow as it blossoms. No brakes involved. Angular momentum is conserved: the mouth opening grows its inertia (I ∝ r²), so spin falls. The yo-yo despin. Codex [I] updated.',
          priority: 'info',
        });
      }
    });

    // First autopilot arrival: teach the two capture paths (lasso vs arm).
    eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
      // During onboarding the Director's `decision` beat already teaches N vs D
      // (and the in-range prompt teaches N) — don't double-teach. Post-onboarding
      // this stays a useful one-shot reminder. (Guidance cleanup, Phase 2.)
      if (!this._onboardingRunning && !this._firstTimeComms.has('autopilot_arrived')) {
        this._firstTimeComms.add('autopilot_arrived');
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'SPACECRAFT',
          text: 'On station. Press N to lasso close debris, or D to deploy a daughter for distant or heavy targets.',
          priority: 'info',
        });
      }

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

  _applyStartLocation() {
    const { player } = this._refs;
    if (!player || !player.orbit) return;
    const lang = settingsManager.getLanguageEntry();
    const start = lang && lang.start;
    if (!start) return;

    // Inclination from launch geography (Languages.incDeg), default 51.6°.
    const incDeg = (lang && Number.isFinite(lang.incDeg)) ? lang.incDeg : 51.6;
    const inclination = incDeg * Math.PI / 180;
    const { raan, trueAnomaly } = subPointToOrbit(start.lat, start.lon, inclination);
    player.orbit.inclination = inclination;
    player.orbit.raan = raan;
    player.orbit.trueAnomaly = trueAnomaly;
  }

  /** Reset game state for new attempt */
  resetGame() {
    const {
      player, armManager,
      cameraSystem, resourceSystem,
    } = this._refs;
    // targetSelector: imported singleton
    // debrisWireframe: self-manages via GAME_RESET listener
    // kesslerSystem: self-manages via GAME_RESET listener

    // ST-9.11 C-5: Reset launch sequence state
    launchSequence.reset();

    // Notify self-resetting systems (CommsSystem, KesslerSystem,
    // TutorialSystem, TrawlManager, OrbitMFD listen for this)
    eventBus.emit(Events.GAME_RESET);

    gameState.reset();
    scoringSystem.reset();

    // Reset player resources (delegated to ResourceSystem)
    resourceSystem.reset();

    // Reset orbit to starting position
    player.orbit.semiMajorAxis = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;
    player.orbit.trueAnomaly = 0;

    // Reset ROSA furl state so a retry never inherits a furled array (the retry
    // path skips the launch sequence, which would otherwise re-deploy them).
    if (player.resetRosaFurlState) player.resetRosaFurlState();

    // Reset target selection (imported singleton — emits TARGET_CLEARED → DebrisWireframe self-clears)
    targetSelector.setTarget(null);

    // Reset V3 arm manager
    if (armManager) armManager.reset();

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
    const { player, armManager, resourceSystem } = this._refs;
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
          if (armManager) armManager.applyUpgrade(data);
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

  /** Save current game state to localStorage */
  saveGame() {
    const { shopScreen, resourceSystem } = this._refs;
    const scoring = scoringSystem.serialize();
    const resources = resourceSystem.serialize();
    const upgrades = shopScreen.getSerializableUpgrades();

    const saveData = {
      credits: scoring.credits,
      totalScore: scoring.totalScore,
      missionNumber: scoring.missionNumber,
      debrisCleared: scoring.debrisCleared,
      upgrades: upgrades,
      resourceMaxes: resources,
      power: powerDistribution.serialize(),
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

    // Let self-managing systems contribute their state (e.g. SubsystemEvents)
    eventBus.emit(Events.PERSISTENCE_GATHER, saveData);

    persistenceManager.save(saveData);
  }

  /**
   * First-depot settlement (first-credit legibility + early-shop tension plan).
   * On the player's true first depot visit only — gated by the profile-permanent
   * FIRST_DEPOT_VISITED ceremony flag — pay a one-time, on-theme "first cleanup
   * contract settled" bonus that tops the wallet UP TO Constants.SHOP.FIRST_DEPOT_FLOOR
   * if it is below that. This guarantees one ~500 starter is affordable without
   * gifting two upgrades or the 800 net. Runs once per profile and survives
   * GAMEOVER_CONTINUE (which resets debrisCleared but not the flag).
   * Called on SHOP entry (a depot arrival), never on SHOP_DEPLOY (exit).
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
        text: 'DAUGHTER: No target selected. Press [Tab] to cycle targets',
        priority: 'warning',
      });
      return;
    }
    if (!armManager) return;

    const deployed = armManager.deployArm(target);

    // UX: Confirm deployment via comms (ARM_PILOT is auto-entered by InputManager)
    if (deployed) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughter deployed. Arrow keys to steer; press its number again (or V) to back out to Fly view',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'info',
      });
    } else {
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
