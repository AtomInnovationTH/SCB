#!/usr/bin/env node
/**
 * Node.js test runner for Space Cowboy.
 * Run: node js/test/run-tests.js
 */

// Import test framework
import { summary } from './TestRunner.js';

// Import test suites (order doesn't matter — each is self-contained)
import './test-Constants.js';
import './test-EventBus.js';
import './test-OrbitalMechanics.js';
import './test-OrbitalMechanics-scratch.js';   // Sprint 2 / PR A — scratch-output variants

// S8-B: New test suites
import './test-GameState.js';
import './test-ScoringSystem.js';
import './test-PowerDistribution.js';

// V5 Crossbow tests
import './test-Crossbow-Constants.js';
import './test-Crossbow-ArmUnit.js';

// Collision Avoidance AI tests
import './test-CollisionAvoidance.js';

// Autopilot (trailing-rendezvous) tests
import './test-AutopilotSystem.js';

// Skills System tests
import './test-SkillsSystem.js';

// LassoSystem — ST-1.2 speed + TIME_SCALE_GAMEPLAY fix
import './test-LassoSystem.js';

// Tether catenary sag direction — ST-1.4 perpendicular projection fix
import './test-ArmUnit-tether.js';

// Conjunction alert gating — ST-2.1 capture-count + elapsed gating
import './test-ConjunctionGating.js';

// Debris 3-D visual parity — ST-2.3 wireframe-derived geometry + materials
import './test-DebrisVisuals.js';

// Bolas visuals — ST-2.4 bolas head, tube tether, radial sparks
import './test-BolasVisuals.js';

// Sprint 3: No Tutorial Legacy — grep assertion that TutorialSystem is fully removed
import './test-no-tutorial-legacy.js';

// ST-3.3: Dormant panel corner-glyph affordance — activate-key attributes + CSS
import './test-hud-activate-keys.js';

// ST-4.A: Debris Map — cluster scoring, engageCluster, constants
import './test-DebrisMap.js';

// ST-4.C: Mission Spawn Difficulty Profiles
import './test-MissionProfiles.js';

// ST-4.D: Dynamic Mid-Mission Events
import './test-MissionEvents.js';

// ST-5.3: Earth texture LOD selector + Camera FOV constants
import './test-EarthLOD.js';
import './test-CameraFOV.js';

// ST-5.4: NavSphere stalks, lock-on ring, geolocation, velocity arrows
import './test-NavSphere.js';

// ST-5.2: TrailSystem — ring buffer, colour classification, fade, arm lifecycle, sample gating
import './test-TrailSystem.js';

// ST-5.1: Comms System — 6-channel classifier + coalescing
import './test-CommsSystem.js';

// ST-5.1: CommsPanel — tap/hold discrimination, filter persistence, pane dimensions
import './test-CommsPanel.js';

// ST-5.1: RadialMenu — arm gating, equal angles, channel stripe colours
import './test-RadialMenu.js';

// ST-6.6: TRL annotation + badge helpers — Codex + Shop integrity, distribution
import './test-TRL.js';

// ST-6.1: CatalogLoader + hybrid DebrisField + seeded Space Weather + active-sat guard
import './test-CatalogLoader.js';

// ST-6.3: MOID Calculator — 8-point sampled approximation + classify + rankByMOID
import './test-MoidCalculator.js';

// ST-6.3: Conjunction MOID badges — tier transition de-bounce, CA speed-up, RED coexistence
import './test-ConjunctionMOID.js';

// ST-6.2: Debris Texture Atlas + Flag Decal System — UV math, colours, flag checks, MOID emissive
import './test-DebrisTextureAtlas.js';

// ST-6.5: TeachingSystem — first-encounter contextual overlays, 14 moments, persistence
import './test-TeachingSystem.js';

// ST-6.7: EnvironmentSystem — AO, MMOD, Safe-Mode, Radiation Belt, Battery DOD
import './test-EnvironmentSystem.js';

// ST-6.4: StrategicMap — orbit ellipse, lat/lon, dot colours, toggle state, threats
import './test-StrategicMap.js';

// ST-8.1 + ST-8.2: STATION_KEEP foundation + ARM_ORBIT_ADJUST controls
import './test-StationKeep.js';

// ST-8.3: Dual-Metal FEEP System — metal constants, switchMetal, thrust, forge yields
import './test-FEEPMetals.js';

// ST-8.4: News-driven missions + ReputationSystem
import './test-NewsEvents-epic8.js';

// ST-8.4b: Codex ISRO/news entries + CommsSystem ISRO routing
import './test-CodexISRO.js';

// ST-9.2: Config G geometry — collar hinge, azimuth docking, strut tip math, dual-fire pairs
import './test-ArmManager-ConfigG.js';

// ST-9.3 C-3: Config G Aim + Hinge + DualFire + Recoil + Decomposition
import './test-ArmUnit-ConfigG-Aim.js';

// ST-9.10 C-4: Deploy State Machine — strut deploy/stow, flag gating, persistence
import './test-ArmUnit-DeployState.js';

// ST-9.11 C-5: Launch Sequence — 9-phase state machine, lock release, ROSA power ramp
import './test-LaunchSequence.js';

// V-7: Launch Cinematic — visual driver for the 9-phase sequence
import './test-LaunchCinematic.js';

// ST-9.12 C-9: Center-of-Mass Tracking + Thruster Plume Interlock
import './test-CoMCalculator.js';

// ST-9.4 C-6: Capture Net System — projectile, catch, reel, inventory, persistence
import './test-CaptureNet.js';

// ST-9.5 C-7: Tether Reel — strut-mounted reel state machine, cable physics, persistence
import './test-TetherReel.js';

// ST-9.7 C-8: Bridle Ring — simplified strut-tip load distribution ring
import './test-BridleRing.js';

// ST-9.8 C-10: Arm Tier Catalog — tier upgrade shop entries, gating, execution
import './test-ArmTierCatalog.js';

// C-11: Epic 9 Integration — end-to-end tests with all feature flags ON
import './test-Epic9-Integration.js';

// Diagnostic: autopilot STATION_KEEP entry + camera drift
import './test-diagnostic-autopilot-sk.js';

// Daughter autopilot numerical simulation (orbital conditions)
import './test-daughter-autopilot-sim.js';

// V-8: Capture Net Visual — state-machine-driven 3D renderer
import './test-CaptureNetVisual.js';

// V-9: Tier Progression Visual — tier upgrade collar/strut rebuild + flash
import './test-TierVisualManager.js';

// V-10: Launch ceremony strut-alpha Y/Z swap regression
import './test-CeremonyAlpha.js';

// §13 Q5: Net Inventory — decrement, empty-click guard, FSM integration
import './test-ArmUnit-NetInventory.js';

// PR 4 / P1.5: QualityManager — selectInitialTier, runtimeAdapt, medianOf, TIER_ORDER
import './test-QualityManager.js';

// PR 5 / P2.8: TimerManager — central setTimeout/setInterval registry, tagged clearing, STATE_CHANGE auto-clear
import './test-TimerManager.js';

// PR 6 / P3.11: GpuProbe — EXT_disjoint_timer_query_webgl2 GPU frame-time probe
import './test-GpuProbe.js';

// Sprint 3 GPU profiling: ProfileFlags URL parser (?disable… / ?msaa= / ?pixelRatio=)
import './test-ProfileFlags.js';

// Sprint 3 GPU profiling: AutoProfileSweep delta computation + start() guards
import './test-AutoProfileSweep.js';

// Q2 Stage 1: Net Ceremony event emission from NetProjectile FSM
import './test-NetCeremonyEvents.js';

// Q2 Stage 3: NET_CINEMATIC camera view — 7-beat net ceremony cinematic
import './test-NetCinematic.js';

// Q2 Stage 4: Ceremony time-dilation plumbing (CeremonyTimeScale + orbital divergence safety)
import './test-NetCeremonyTimeScale.js';

// Q2 Stage 5: First-deploy persistence + end-to-end ceremony wire integrity
import './test-NetCeremonyFirstDeploy.js';

// Flush any pending async describes, then print summary
await Promise.resolve();
summary();
