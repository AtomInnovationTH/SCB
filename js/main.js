/**
 * main.js — Game bootstrap: initializes renderer, scene, game loop,
 * and delegates game flow to GameFlowManager.
 * @module main
 */

import * as THREE from 'three';

// [DBG-KEY-CAPTURE] window-level keydown sniffer removed (noise on every keystroke).
// Re-enable only when diagnosing ASR / accessibility / focus key-injection issues.

import { Constants } from './core/Constants.js';
import { eventBus } from './core/EventBus.js';
import { Events } from './core/Events.js';
import { gameState, GameStates } from './core/GameState.js';

import { SceneManager } from './scene/SceneManager.js';
import { Earth } from './scene/Earth.js';
import { Starfield } from './scene/Starfield.js';
import { SunLight } from './scene/SunLight.js';
import { launchCinematic } from './scene/LaunchCinematic.js';
import { tierVisualManager } from './scene/TierVisualManager.js';

import { PlayerSatellite } from './entities/PlayerSatellite.js';
import { DebrisField } from './entities/DebrisField.js';
import { ActiveSatellites } from './entities/ActiveSatellite.js';
import { ArmManager } from './entities/ArmManager.js';
import { orbitToSceneCartesian } from './entities/OrbitalMechanics.js';

// Systems
import { scoringSystem } from './systems/ScoringSystem.js';
import { targetSelector } from './systems/TargetSelector.js';
import { audioSystem } from './systems/AudioSystem.js';
import { CameraSystem } from './systems/CameraSystem.js';
import { CommsSystem } from './systems/CommsSystem.js';
import { ResourceSystem } from './systems/ResourceSystem.js';
import { SensorSystem } from './systems/SensorSystem.js';
import { kesslerSystem } from './systems/KesslerSystem.js';
import { CargoSystem } from './systems/CargoSystem.js';
import { ForgeSystem } from './systems/ForgeSystem.js';
import { ConjunctionSystem } from './systems/ConjunctionSystem.js';
import { InputManager } from './systems/InputManager.js';
import { gameFlowManager } from './systems/GameFlowManager.js';
import { powerDistribution } from './systems/PowerDistribution.js';
import { launchSequence } from './systems/LaunchSequence.js';
import { trawlManager } from './systems/TrawlManager.js';
import { AutopilotSystem } from './systems/AutopilotSystem.js';
import { SkillsSystem } from './systems/SkillsSystem.js';
import { LassoSystem } from './systems/LassoSystem.js';
import { RewardSystem } from './systems/RewardSystem.js';
import { CodexSystem } from './systems/CodexSystem.js';
import { SpaceWeatherSystem } from './systems/SpaceWeatherSystem.js';
import { SubsystemEvents } from './systems/SubsystemEvents.js';
import { CollisionAvoidanceSystem } from './systems/CollisionAvoidanceSystem.js';
import { MissionEventSystem } from './systems/MissionEventSystem.js';
import { ReputationSystem } from './systems/ReputationSystem.js';
import { EnvironmentSystem } from './systems/EnvironmentSystem.js';
import { catalogLoader } from './systems/CatalogLoader.js';

// UI
import { HUD } from './ui/HUD.js';
import { MenuScreen } from './ui/MenuScreen.js';
import { BriefingScreen } from './ui/BriefingScreen.js';
import { ShopScreen } from './ui/ShopScreen.js';
import { GameOverScreen } from './ui/GameOverScreen.js';
import { TargetReticle } from './ui/TargetReticle.js';
import { NavSphere } from './ui/NavSphere.js';
import { OrbitMFD } from './ui/OrbitMFD.js';
import { DebrisMap } from './ui/DebrisMap.js';
// DebrisWireframe is now created by HUD.js (integrated right-column layout)
import { DockingReticle } from './ui/DockingReticle.js';
import { VelocityStreaks } from './ui/VelocityStreaks.js';
import { TrailSystem } from './ui/TrailSystem.js';
import { DebugOverlay } from './ui/DebugOverlay.js';
import { SweepReportUI } from './ui/SweepReportUI.js';
import { CodexViewerUI } from './ui/CodexViewerUI.js';
import { SkillsPane } from './ui/hud/SkillsPane.js';
import { TeachingSystem } from './systems/TeachingSystem.js';
import { TeachingOverlay } from './ui/TeachingOverlay.js';
import { StrategicMap } from './ui/StrategicMap.js';
import { captureNetVisual } from './ui/CaptureNetVisual.js';
import { captureNetSystem } from './entities/CaptureNet.js';


// ============================================================================
// GLOBALS
// ============================================================================
let sceneManager;
let earth;
let starfield;
let sunLight;
let lastTime = 0;

// 60 fps frame limiter
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
let lastFrameTime = 0;
let frameCount = 0;

// Catch slo-mo state (Phase 1C)
let slowMoTimer = 0;
let slowMoFactor = 1.0;

// Entities
let player;
let debrisField;
let activeSatellites;
let armManager;

// Systems (targetSelector, kesslerSystem, trawlManager imported as singletons above)
let cameraSystem;
let commsSystem;
let resourceSystem;
let sensorSystem;
let cargoSystem;
let forgeSystem;
let conjunctionSystem;
let skillsSystem;
let skillsPane;
let lassoSystem;
let rewardSystem;
let codexSystem;
let spaceWeatherSystem;
let subsystemEvents;
let autopilotSystem;
let collisionAvoidanceSystem;
let missionEventSystem;
let reputationSystem;
let environmentSystem;

// UI
let hud;
let menuScreen;
let briefingScreen;
let shopScreen;
let gameOverScreen;
let targetReticle;
let navSphere;
let orbitMFD = null;
let debrisMap = null;
let debrisWireframe;
let dockingReticle;
let velocityStreaks;
let trailSystem;
let debugOverlay;
let sweepReportUI;
let codexViewerUI;
let teachingSystem;
let teachingOverlay;
let strategicMap;

// Input
let inputManager;

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    console.error('[main] #game-canvas not found');
    return;
  }

  // --- ST-6.1: Offline Catalogue — fetch before entities so DebrisField can
  //     populate real NORAD-tagged debris in hybrid mode. On fetch failure
  //     catalogLoader.init() resolves false and DebrisField transparently
  //     falls back to pure procedural generation.
  try {
    await catalogLoader.init();
  } catch (e) {
    console.warn('[main] CatalogLoader init threw unexpectedly:', e);
  }

  // --- Scene Manager (renderer, camera, post-processing) ---
  sceneManager = new SceneManager(canvas);
  const scene = sceneManager.getScene();
  const camera = sceneManager.getCamera();

  // --- Earth (visual centerpiece) ---
  earth = new Earth(scene);

  // --- Starfield (background) ---
  starfield = new Starfield(scene);

  // --- Sun Light (dynamic day/night) ---
  sunLight = new SunLight(scene, sceneManager);

  // --- Player Satellite ---
  player = new PlayerSatellite(scene);

  // --- Debris Field (ST-6.1: hybrid mode consumes catalogLoader if ready) ---
  debrisField = new DebrisField(scene, { catalogLoader });

  // --- Active Satellites ---
  activeSatellites = new ActiveSatellites(scene);

  // --- V3 Octopus Arm Manager (6 arms: 3 Weaver + 3 Spinner) ---
  armManager = new ArmManager(scene, player);
  armManager.setDebrisField(debrisField);
  armManager.setCatalogLoader(catalogLoader);    // ST-6.1: active-sat treaty guard

  // --- Target Selector: imported singleton from TargetSelector.js ---

  // --- Extracted Systems (Sprint 4A) ---
  resourceSystem = new ResourceSystem();
  resourceSystem.setPlayer(player);
  scoringSystem.setPlayer(player);  // ST-4.E: Wire player ref for ΔV tracking
  armManager.setResourceSystem(resourceSystem);
  sensorSystem = new SensorSystem();
  // kesslerSystem: imported singleton from KesslerSystem.js
  cargoSystem = new CargoSystem();
  forgeSystem = new ForgeSystem(cargoSystem, resourceSystem);
  conjunctionSystem = new ConjunctionSystem();
  // trawlManager: imported singleton from TrawlManager.js
  autopilotSystem = new AutopilotSystem();
  collisionAvoidanceSystem = new CollisionAvoidanceSystem();

  // --- Phase 4A: Skills + Lasso systems ---
  skillsSystem = new SkillsSystem();
  lassoSystem = new LassoSystem(scene);

  // --- Phase 5 Rewards: RewardSystem + SweepReportUI ---
  rewardSystem = new RewardSystem();
  sweepReportUI = new SweepReportUI();

  // --- Phase 7: Learning Systems (Codex + Space Weather + Subsystem Events) ---
  codexSystem = new CodexSystem();
  // ST-6.1: seeded replay if catalogLoader is ready
  spaceWeatherSystem = new SpaceWeatherSystem({ catalogLoader });
  subsystemEvents = new SubsystemEvents();

  // --- ST-4.D: Dynamic Mid-Mission Events ---
  missionEventSystem = new MissionEventSystem();
  reputationSystem = new ReputationSystem();

  // Load news events (offline-first, graceful failure)
  missionEventSystem.loadNewsEvents();

  // --- ST-6.7: Environment Hazards (AO, MMOD, Safe-Mode, Radiation, Battery DOD) ---
  environmentSystem = new EnvironmentSystem(eventBus, player, powerDistribution, resourceSystem, skillsSystem);
  environmentSystem.init();

  // --- F17: Codex Viewer UI (browse unlocked entries) ---
  codexViewerUI = new CodexViewerUI(codexSystem);

  // --- ST-6.5: Teaching System (first-encounter contextual overlays) ---
  teachingOverlay = new TeachingOverlay(document.body);
  teachingSystem = new TeachingSystem(eventBus);
  teachingSystem.onShow = (moment) => teachingOverlay.show(moment);
  teachingSystem.init();

  // Phase 4: Wire cargo system to resource system for dual-mode fuel
  resourceSystem.setCargoSystem(cargoSystem);
  player.setResourceSystem(resourceSystem);
  player.setCargoSystem(cargoSystem);

  // --- Camera System (replaces old manual follow) ---
  cameraSystem = new CameraSystem(camera, canvas, scene);

  // --- Camera: start following the player ---
  const startPos = player.getPosition();
  camera.position.copy(startPos);
  camera.position.y += 0.00008;

  // --- Comms System ---
  commsSystem = new CommsSystem();

  // --- Build UI ---
  hud = new HUD();
  menuScreen = new MenuScreen();
  briefingScreen = new BriefingScreen();
  shopScreen = new ShopScreen();
  gameOverScreen = new GameOverScreen();

  // --- Target Reticle (Canvas 2D overlay) ---
  targetReticle = new TargetReticle(camera);
  targetReticle.setVisible(false);

  // --- Nav Sphere (Canvas 2D 3D-radar) ---
  navSphere = new NavSphere(camera);
  navSphere.setVisible(false);

  // --- Debris Wireframe — now created by HUD (integrated right-column layout) ---
  debrisWireframe = hud.debrisWireframe;

  // --- Docking Reticle (Canvas 2D ARM PILOT overlay) ---
  dockingReticle = new DockingReticle(camera, scene);
  dockingReticle.setVisible(false);

  // --- Velocity Streaks (Canvas 2D acceleration overlay — Phase 4) ---
  velocityStreaks = new VelocityStreaks();
  // Canvas starts visible — empty overlay is transparent, no visual impact;
  // STATE_CHANGE listener hides/clears when leaving gameplay states

  // --- ST-5.2: Trail System (3-D world-space historical trajectory ribbons) ---
  trailSystem = new TrailSystem(scene, eventBus);

  // --- Orbit MFD (Keplerian orbit display) ---
  orbitMFD = new OrbitMFD();

  // --- Debris Map (ST-4.A — full-screen strategic sweep planning overlay) ---
  debrisMap = new DebrisMap();

  // --- Debug Overlay (Ctrl+D toggle) ---
  debugOverlay = new DebugOverlay();

  // --- Connect comms to HUD ---
  hud.setCommsSystem(commsSystem);

  // --- Connect V3 arm manager to HUD + player satellite ---
  if (armManager) hud.setArmManager(armManager);
  if (armManager) player.setArmManager(armManager);

  // V-7: Launch cinematic visual effects (flag-gated internally)
  if (Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
    launchCinematic.init(scene, player);
  }

  // V-8: Capture net system + visual effects
  if (Constants.FEATURE_FLAGS.CAPTURE_NET) {
    captureNetSystem.init();   // ST-9.4: initialize mother pod inventory + set _initialized
    captureNetVisual.init(scene, player, captureNetSystem);
  }

  // V-9: Tier progression visual (flag-gated internally)
  if (Constants.FEATURE_FLAGS.TIER_UPGRADES) {
    tierVisualManager.init(scene, player, armManager);
  }

  // --- F17: Connect codex system to HUD badge + badge click toggle ---
  hud.setCodexSystem(codexSystem);
  eventBus.on('codex:toggleUI', () => { if (codexViewerUI) codexViewerUI.toggle(); });

  // --- Connect shop screen to game over screen (for upgrade count display) ---
  gameOverScreen.setShopScreen(shopScreen);

  // --- Phase 5: Wire cargo & scoring refs into shop for sell/contribute ---
  shopScreen.setCargoSystem(cargoSystem);
  shopScreen.setScoringSystem(scoringSystem);

  // --- GameFlowManager: init with reduced refs (13 decoupled via EventBus) ---
  // Removed: menuScreen, gameOverScreen (GAME_STATE_CHANGE)
  //          targetReticle, navSphere, dockingReticle, orbitMFD (VIEW_CONFIG_CHANGE / GAME_STATE_CHANGE)
  //          sensorSystem (SENSOR_UPGRADE)
  //          commsSystem (GAME_STATE_CHANGE + COMMS_SEND + GAME_RESET), inputManager (ARM_RETURNED + ARM_EXPENDED)
  //          hud (GAME_STATE_CHANGE + VIEW_CONFIG_CHANGE + HUD_TARGET_CLICK + PAUSE events)
  //          briefingScreen (GAME_STATE_CHANGE payload.targets)
  //          subsystemEvents (PERSISTENCE_LOADED + PERSISTENCE_GATHER)
  //          debrisWireframe (TARGET_SELECTED/CLEARED + GAME_RESET + DEBRIS_REMOVED + WIREFRAME_ASSESSED)
  //          kesslerSystem (COLLISION_GAME_OVER + GAME_RESET + GAMEOVER_CONTINUE — imported singleton)
  //          targetSelector (imported singleton)
  //          trawlManager (GAME_STATE_CHANGE + TRAWL_START — imported singleton)
  gameFlowManager.init({
    player, debrisField, armManager, cameraSystem,
    shopScreen,
    resourceSystem,
  });

  // --- F15: Wire autopilot dependencies ---
  autopilotSystem.init({
    player, targetSelector, trawlManager, debrisField, armManager,
  });

  // --- ST-6.4: Strategic Map (Shift+V orbital overview) ---
  strategicMap = new StrategicMap({
    scene: sceneManager.getScene(),
    renderer: sceneManager.getRenderer(),
    catalogLoader,
    debrisField,
    playerSatellite: player,
    conjunctionSystem,
    environmentSystem,
    eventBus,
  });
  strategicMap.init();

  // --- Input Manager ---
  inputManager = new InputManager();
  // --- Skills Pane (mounted on #hud-overlay, after HUD build) ---
  const hudOverlay = document.getElementById('hud-overlay');
  skillsPane = new SkillsPane(hudOverlay);
  // Enable skill-based progressive HUD revelation
  hud.enableSkillReveal();

  inputManager.init({
    gameState, player, armManager, cameraSystem, targetSelector,
    debrisField, debrisWireframe, dockingReticle, hud, targetReticle,
    navSphere, orbitMFD, debrisMap, audioSystem, debugOverlay, sensorSystem,
    lassoSystem, autopilotSystem, codexViewerUI, strategicMap,
    transitionToState: (s, p) => gameFlowManager.transitionToState(s, p),
    deployArm: () => gameFlowManager.deployArm(),
    applyUpgrades: () => gameFlowManager.applyUpgrades(),
    setPaused: (val) => { gameFlowManager.paused = val; },
    getPaused: () => gameFlowManager.paused,
    setLastTime: (t) => { lastTime = t; },
    setApproachTarget: (t) => { gameFlowManager.approachTarget = t; },
    setApproachComplete: (v) => { gameFlowManager.approachComplete = v; },
  });
  inputManager.start();

  // --- Collision Avoidance System (after inputManager so ref is valid) ---
  collisionAvoidanceSystem.init({
    player, debrisField, armManager, inputManager,
  });

  // --- Event listeners for game flow (delegated to GameFlowManager) ---
  gameFlowManager.setupEventHandlers();

  // Sim mode: NO slo-mo on capture. Previously triggered CATCH_SLOWMO on
  // ARM_CAPTURED and LASSO_CAPTURED ("catch juice"). Arcade behaviour; removed
  // per user feedback — real capture is unremarkable momentum transfer.
  // Detach slo-mo below is retained (losing an arm is a significant event).

  // --- Phase 6: Tether detach slo-mo + dramatic moment ---
  eventBus.on(Events.ARM_DETACHED, () => {
    slowMoTimer = Constants.DETACH_SLOWMO_DURATION;
    slowMoFactor = Constants.DETACH_SLOWMO_FACTOR;
  });

  // --- ST-6.4: Strategic Map toggle ---
  eventBus.on(Events.STRATEGIC_MAP_TOGGLE, () => {
    if (strategicMap) {
      strategicMap.isOpen() ? strategicMap.close() : strategicMap.open();
    }
  });

  // --- Pause overlay: reset lastTime to avoid time-jump on unpause ---
  eventBus.on(Events.PAUSE_RESUME, () => { lastTime = performance.now(); });
  eventBus.on(Events.PAUSE_MENU, () => { lastTime = performance.now(); });

  window.addEventListener('resize', onResize);

  // --- Hide loading screen ---
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('hidden');
    setTimeout(() => loadingScreen.remove(), 1500);
  }

  // --- Start in MENU state ---
  gameState.currentState = GameStates.MENU;
  gameFlowManager.transitionToState(GameStates.MENU);

  console.log('[Space Cowboy] Engine initialized. Starting game loop…');
  requestAnimationFrame(gameLoop);
}

// ============================================================================
// GAME LOOP
// ============================================================================

function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  // 60 fps frame limiter — skip frame if too soon
  if (timestamp - lastFrameTime < FRAME_INTERVAL) {
    return;
  }
  lastFrameTime = timestamp;

  // Debug: record frame time
  if (debugOverlay) {
    const frameTime = timestamp - (lastTime || timestamp);
    debugOverlay.recordFrame(frameTime);
  }

  if (gameFlowManager.paused) {
    audioSystem.stopThrusterHum();
    audioSystem.stopDeltaVAlarm();
    audioSystem.stopForgeHum();
    return;
  }

  // Delta time in seconds (cap to prevent spiral of death)
  const realDt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  // Apply slo-mo factor (Phase 1C — catch juice)
  let dt = realDt;
  if (slowMoTimer > 0) {
    slowMoTimer -= realDt;
    dt *= slowMoFactor;
    if (slowMoTimer <= 0) {
      slowMoFactor = 1.0;
    }
  }

  const currentState = gameState.currentState;

  // --- Always update visuals (scene renders behind menus) ---
  const sunDir = sunLight.update(dt, player.getPosition());
  earth.setSunDirection(sunDir);
  earth.update(dt);
  starfield.update(dt);

  // --- Update entities only in active gameplay states ---
  const isActive = gameState.isGameplay();

  if (isActive) {
    // Advance frame counter + set on debrisField for spatial query caching
    frameCount++;
    debrisField.setFrameId(frameCount);

    // Process input
    inputManager.processInput(dt);

    // F15: Autopilot steering + thrust (before player.update applies thrustInput)
    try { autopilotSystem.update(dt); } catch (e) { console.error('[GameLoop] autopilotSystem:', e); }

    // Collision Avoidance — after autopilot, before player.update (dodge impulse applied to _rcsVelocity)
    try { collisionAvoidanceSystem.update(dt); } catch (e) { console.error('[GameLoop] collisionAvoidance:', e); }

    // Update game state timer
    gameState.update(dt);

    // Update entities (with error boundaries — single system crash won't freeze game)
    try { player.update(dt, sunDir); } catch (e) { console.error('[GameLoop] player.update:', e); }
    try { debrisField.update(dt, player.getPosition(), player.getOrbitalElements()); } catch (e) { console.error('[GameLoop] debrisField:', e); }
    try { activeSatellites.update(dt, player.getPosition()); } catch (e) { console.error('[GameLoop] activeSats:', e); }

    // Update V3 arm manager
    if (armManager) { try { armManager.update(dt); } catch (e) { console.error('[GameLoop] armManager:', e); } }

    // V-4: Sync arm mesh visibility with deploy state (must run AFTER arm._updateDocked)
    try { player.postArmUpdate(); } catch (e) { console.error('[GameLoop] postArmUpdate:', e); }

    // ST-9.11 C-5: Tick launch sequence (flag-gated internally)
    try { launchSequence.tick(dt); } catch (e) { console.error('[GameLoop] launchSequence:', e); }

    // V-7: Drive launch cinematic visual effects (flag-gated internally)
    try { launchCinematic.update(dt); } catch (e) { console.error('[GameLoop] launchCinematic:', e); }

    // V-8: Capture net FSM + visual effects (flag-gated internally)
    try { captureNetSystem.update(dt); } catch (e) { console.error('[GameLoop] captureNetSystem:', e); }
    try { captureNetVisual.update(dt); } catch (e) { console.error('[GameLoop] captureNetVisual:', e); }

    // V-9: Tier progression visual transition animation
    try { tierVisualManager.update(dt); } catch (e) { console.error('[GameLoop] tierVisualManager:', e); }

    // Update target selector
    try { targetSelector.update(dt); } catch (e) { console.error('[GameLoop] targetSelector:', e); }

    // Update extracted systems
    try { resourceSystem.update(dt); } catch (e) { console.error('[GameLoop] resourceSystem:', e); }
    try { sensorSystem.update(dt, player.getPosition(), debrisField); } catch (e) { console.error('[GameLoop] sensorSystem:', e); }
    try { kesslerSystem.update(dt); } catch (e) { console.error('[GameLoop] kesslerSystem:', e); }

    // Update forge system
    try { forgeSystem.update(dt); } catch (e) { console.error('[GameLoop] forgeSystem:', e); }

    // Update trawl manager (Phase 2 — trawl system)
    try {
      trawlManager.update(dt, {
        playerPos: player.getPosition(),
        debrisField,
        armManager,
        player,
      });
    } catch (e) { console.error('[GameLoop] trawlManager:', e); }

    // Update skills system (Phase 4A — skill tracking)
    if (skillsSystem) {
      try { skillsSystem.update(dt); } catch (e) { console.error('[GameLoop] skillsSystem:', e); }
    }
    if (skillsPane) {
      try { skillsPane.update(dt); } catch (e) { console.error('[GameLoop] skillsPane:', e); }
    }

    // Update lasso system (Phase 4A — projectile flight + reel-in)
    try { lassoSystem.update(dt, player.getPosition(), debrisField); } catch (e) { console.error('[GameLoop] lassoSystem:', e); }

    // Update reward system (Phase 5 Rewards — milestone checks)
    try { rewardSystem.update(dt, armManager); } catch (e) { console.error('[GameLoop] rewardSystem:', e); }

    // Update mission event system (ST-4.D — mid-mission complications)
    try { missionEventSystem.update(dt); } catch (e) { console.error('[GameLoop] missionEventSystem:', e); }

    // Update learning systems (Phase 7 — Codex + Space Weather)
    try { codexSystem.update(dt); } catch (e) { console.error('[GameLoop] codexSystem:', e); }
    try {
      spaceWeatherSystem.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        sunDirection: sunDir,
      });
    } catch (e) { console.error('[GameLoop] spaceWeatherSystem:', e); }

    // Update environment hazards (ST-6.7 — AO, MMOD, Safe-Mode, Radiation, Battery DOD)
    if (environmentSystem) {
      try { environmentSystem.update(dt); } catch (e) { console.error('[GameLoop] environmentSystem:', e); }
    }

    // Update subsystem events (Phase 7B — spacecraft subsystem ambiance)
    try {
      subsystemEvents.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        armManager,
        deployedArms: armManager ? armManager.getDeployedCount() : 0,
        codexProgress: codexSystem ? codexSystem.getProgress().unlocked : 0,
      });
    } catch (e) { console.error('[GameLoop] subsystemEvents:', e); }

    // Update conjunction alert system (Sprint C1)
    try {
      conjunctionSystem.update(dt, gameState, debrisField.debrisList,
        player.getPosition(), player.getVelocity(), inputManager.isArmPilotMode());
    } catch (e) { console.error('[GameLoop] conjunctionSystem:', e); }

    // Update power distribution (warnings for dangerous configs)
    try {
      powerDistribution.update(dt, {
        armsDeployed: armManager ? armManager.getDeployedCount() : 0,
      });
    } catch (e) { console.error('[GameLoop] powerDistribution:', e); }

    // Check altitude game over
    const alt = player.getAltitudeKm();
    if (alt < Constants.LEO_MIN_ALT) {
      gameFlowManager.transitionToState(GameStates.GAME_OVER, 'reentry');
    }

    // Fuel game-over is now handled by ResourceSystem → Events.RESOURCE_DEPLETED event

    // Approach state logic
    if (currentState === GameStates.APPROACH && gameFlowManager.approachTarget && gameFlowManager.approachTarget.alive) {
      const targetCart = orbitToSceneCartesian(gameFlowManager.approachTarget.orbit);
      const targetPos = new THREE.Vector3(targetCart.position.x, targetCart.position.y, targetCart.position.z);
      const dist = player.getPosition().distanceTo(targetPos);

      // Update target lock position for camera
      if (cameraSystem) {
        cameraSystem.setLockTarget(targetPos);
      }

      if (dist < 0.005) { // Within 500m → enter interaction
        if (!gameFlowManager.approachComplete) {
          gameFlowManager.approachComplete = true;
          gameFlowManager.transitionToState(GameStates.INTERACTION);
        }
      }
    }

    // --- Camera update via CameraSystem ---
    updateCamera(dt);

    // HUD update
    hud.update(dt, {
      player,
      debrisField,
      activeSatellites,
      targetSelector,
      sensorSystem,
      autopilotSystem,
      cameraSystem,
      forgeState: forgeSystem.getState(),
      cargoStatus: cargoSystem.getStatus(),
    });

    // Orbit MFD update (Phase 6: pass cachedTargets for route planner)
    if (orbitMFD) {
      const target = targetSelector ? targetSelector.getActiveTarget() : null;
      orbitMFD.update(dt, {
        playerOrbit: player.getOrbitalElements(),
        targetOrbit: target ? target.orbit : null,
        selectedTargetId: target ? target.id : null,
        cachedTargets: hud.getCachedTargets(),
      });
    }

    // --- Debris Map update (ST-4.A) ---
    if (debrisMap) {
      debrisMap.update(dt, { debrisField, player, autopilotSystem });
    }

    // ΔV alarm monitoring
    if (armManager) {
      try {
        const budget = armManager.getMassBudget();
        audioSystem.updateDeltaVAlarm(budget.percentage);
      } catch(e) { /* ignore if not ready */ }
    }

    // --- Target Reticle update (Canvas 2D overlay) ---
    if (targetReticle) {
      // ARM PILOT: use daughter arm position/velocity so distances, closure
      // rates, and range indicators are accurate from the arm's perspective.
      let reticlePos = player.getPosition();
      let reticleVel = player.getVelocity();
      if (inputManager && inputManager.isArmPilotMode() && cameraSystem) {
        const pilotArm = cameraSystem.getPilotedArm();
        if (pilotArm && pilotArm.position) {
          reticlePos = pilotArm.position.clone();
          // Arm velocity is in scene units/s — convert to km/s like player velocity
          if (pilotArm.velocity) {
            const v = pilotArm.velocity;
            const toKmS = 1 / Constants.SCENE_SCALE;
            reticleVel = { x: v.x * toKmS, y: v.y * toKmS, z: v.z * toKmS };
          }
        }
      }
      // During ARM_PILOT + STATION_KEEP we want the on-screen target brackets
      // to fade away so the pilot can focus on the one piece of debris they're
      // working on (no visual clutter from neighbouring debris reticles).
      const _pilotArmForReticle = (inputManager.isArmPilotMode() && cameraSystem)
        ? cameraSystem.getPilotedArm() : null;
      const _skTargetIdForReticle = (_pilotArmForReticle
          && _pilotArmForReticle.state === Constants.ARM_STATES.STATION_KEEP
          && _pilotArmForReticle._stationKeepTarget)
        ? _pilotArmForReticle._stationKeepTarget.id : null;
      targetReticle.update(dt, {
        debrisField,
        activeSatellites,
        playerPos: reticlePos,
        playerVel: reticleVel,
        targetSelector,
        playerOrbit: player.orbit,
        skTargetId: _skTargetIdForReticle,
        telemetry: {
          deltaVSpent: player.getDeltaVSpent(),
          thrustDirection: player.getThrustDirection(),
          lastThrustType: player.getLastThrustType(),
        },
      });
    }

    // --- Nav Sphere update (Canvas 2D radar) ---
    if (navSphere) {
      const _pilotArm = (inputManager.isArmPilotMode() && cameraSystem) ? cameraSystem.getPilotedArm() : null;
      navSphere.update(dt, {
        playerPos: player.getPosition(),
        playerVel: player.getVelocity(),
        debrisField,
        activeSatellites,
        sunDirection: sunDir,
        targetSelector,
        sensorSystem,
        armManager,
        pilotedArmId: _pilotArm ? _pilotArm.id : null,
      });
    }

    // Debris Wireframe update is now handled by HUD.update() (integrated layout)

    // --- Docking Reticle update (ARM PILOT overlay) ---
    if (dockingReticle) {
      if (inputManager.isArmPilotMode() && cameraSystem) {
        const pilotArm = cameraSystem.getPilotedArm();
        if (pilotArm) {
          dockingReticle.setArmData(pilotArm, pilotArm.target);
          dockingReticle.setVisible(true);
        }
      } else {
        dockingReticle.setVisible(false);
      }
      dockingReticle.update(dt);
    }

    // --- Velocity Streaks update (Canvas 2D acceleration overlay) ---
    if (velocityStreaks) {
      velocityStreaks.update(dt);
    }

    // --- ST-5.2: Trail System update (3-D ribbon geometry rebuild) ---
    if (trailSystem) {
      try { trailSystem.update(dt); } catch (e) { console.error('[GameLoop] trailSystem:', e); }
    }

    // --- Comms System update ---
    if (commsSystem) {
      commsSystem.update(dt, { debrisField, player, activeSatellites });
    }
  } else {
    // Stop persistent audio when not in gameplay
    audioSystem.stopThrusterHum();
    audioSystem.stopDeltaVAlarm();
    audioSystem.stopForgeHum();

    // Menu/briefing/shop states — still animate scene slowly
    try { player.update(dt * 0.1, sunDir); } catch (e) { console.error('[GameLoop] player.update (bg):', e); }
    try { debrisField.update(dt * 0.1); } catch (e) { console.error('[GameLoop] debrisField (bg):', e); }
    try { activeSatellites.update(dt * 0.1); } catch (e) { console.error('[GameLoop] activeSats (bg):', e); }
    if (armManager) { try { armManager.update(dt * 0.1); } catch (e) { console.error('[GameLoop] armManager (bg):', e); } }
    try { player.postArmUpdate(); } catch (e) { /* bg visibility sync */ }

    // Camera still follows (slow) for nice menu background
    updateCamera(dt);
  }

  // --- Debug overlay update ---
  if (debugOverlay && debugOverlay.visible) {
    const renderer = sceneManager.getRenderer();
    const renderInfo = renderer ? renderer.info : {};
    debugOverlay.update({
      gameState: gameState.currentState,
      cameraView: cameraSystem ? cameraSystem.getView() : '?',
      debrisCount: debrisField ? debrisField.getAliveCount() : 0,
      bgDebrisCount: debrisField ? (debrisField.backgroundCount || 0) : 0,
      activeSatCount: activeSatellites ? activeSatellites.getCount() : 0,
      armsDeployed: armManager ? armManager.getDeployedCount() : 0,
      armsDocked: armManager ? armManager.getDockedCount() : 0,
      armsExpended: armManager ? armManager.getExpendedCount() : 0,
      drawCalls: renderInfo.render?.calls || 0,
      triangles: renderInfo.render?.triangles || 0,
      textures: renderInfo.memory?.textures || 0,
    });
  }

  // --- Render ---
  // ST-6.4: When strategic map is open, render map scene directly (no composer);
  // otherwise use normal EffectComposer pipeline.
  if (strategicMap && strategicMap.isOpen()) {
    strategicMap.update(dt);
    strategicMap.render();
  } else {
    sceneManager.render();
  }
}

// ============================================================================
// CAMERA UPDATE
// ============================================================================

/**
 * Update camera via CameraSystem.
 * @param {number} dt - Delta time in seconds
 */
function updateCamera(dt) {
  if (!cameraSystem) return;

  const playerPos = player.getPosition();
  const playerVel = player.getVelocity();
  const playerQuat = player.quaternion;

  // Compute thrust magnitude for head-bob
  const thrustMag = Math.sqrt(
    player.thrustInput.x ** 2 +
    player.thrustInput.y ** 2 +
    player.thrustInput.z ** 2
  );
  cameraSystem.setThrustMagnitude(Math.min(1.0, thrustMag * 1000));

  // Update the camera system
  cameraSystem.update(dt, playerPos, playerVel, playerQuat);
}


// ============================================================================
// RESIZE HANDLER
// ============================================================================

function onResize() {
  sceneManager.resize();
}

// ============================================================================
// START
// ============================================================================

init();
