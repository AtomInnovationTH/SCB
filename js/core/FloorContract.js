/**
 * FloorContract.js — the Zoom Ladder's canonical, machine-readable floor data.
 *
 * M0 (docs + stubs): PURE DATA. No behavior, no THREE, no DOM, no EventBus —
 * the only permitted import is Constants (for shared physical constants like
 * EARTH_RADIUS). Consumed from M1 on by the ZoomLadder core (S1), the
 * WheelRouter/ride engine (S2), the TimeAuthority (S3), and the floor
 * costumes (S4-S6).
 *
 * SSOT rules (docs/ladder/01-numbers.md):
 *   - This file and docs/ladder/01-numbers.md change in the SAME commit.
 *   - js/test/test-FloorContract.js pins the canonical values; a validator
 *     failure on a number change is the desired tripwire, not an obstacle.
 *   - Floor 7's mass table is MASS_BANDS below. Never reuse
 *     Constants.DEBRIS.ALT_BANDS (count-based spawn weights) or DebrisMap.js's
 *     private 5-band UI array for mass.
 *
 * The ladder position model:
 *   position = (floor, z01), z01 = normalized log10(camera distance) within
 *   the floor's [minDistU, maxDistU]. There is NO global continuous axis:
 *   floors 3-5 anchor to ship/subject, 6-7 to Earth center; the crossing ride
 *   performs the reframe. The outer WALL_ZONE_FRAC of z01 on each side is the
 *   spring-wall; after a crossing you enter at ENTRY_Z01_FROM_BELOW /
 *   ENTRY_Z01_FROM_ABOVE — that offset IS the hysteresis.
 *
 * @module core/FloorContract
 */

import { Constants } from './Constants.js';

/** Scene scale: metres → scene units (1 u = 100 km, so 1 m = 1e-5 u). */
const M = 1e-5;

/** log10 range helper — keeps rangeLog10 mechanically in sync with distU. */
function logRange(minU, maxU) {
  return [Math.log10(minU), Math.log10(maxU)];
}

export const FloorContract = {
  /** Shared ladder geometry (docs/ladder/01-numbers.md "ladder position model"). */
  LADDER_GEOMETRY: {
    WALL_ZONE_FRAC: 0.15,        // outer z01 fraction that is spring-wall, each side
    ENTRY_Z01_FROM_BELOW: 0.25,  // arrival z01 after crossing upward (zoom-out)
    ENTRY_Z01_FROM_ABOVE: 0.75,  // arrival z01 after crossing downward (zoom-in)
  },

  /** Hump spring gesture physics (locked UX — docs/ladder/00-spec.md §4). */
  HUMP_SPRING: {
    CHARGE_TAU_MS: 250,          // exponential charge decay time constant
    EVENT_WINDOW_MS: 400,        // window for the deliberate-gesture event count
    MIN_EVENTS: 3,               // >= this many wheel events inside the window
    IN_FIRMNESS_RATIO: 1.6,      // inbound threshold = 1.6 x outbound (firm-in/soft-out)
    CREEP_FRAC: 0.20,            // camera creeps at most this far into the wall
    GESTURE_LOCK_SILENCE_MS: 180, // one crossing per gesture until this input silence
    SETTLE_IDLE_MS: 250,         // idle in a wall zone -> settle back to the wall edge
    PEEK_CHARGE_FRAC: 0.5,       // charge above this ghosts the next floor's UI
    MOMENTUM_TAIL_CHARGE: 0,     // monotonically-decaying delta tails charge nothing
  },

  /** Automatic time-warp rules (S3 TimeAuthority reads these + per-floor timeCap). */
  TIME_RULES: {
    AUTO_WARP: true,             // rate drifts toward floor cap; no manual control
    DANGER_RAMP_TO_1X: true,     // conjunction inside alarm horizon ramps to 1x BEFORE knock
    CROSS_DOWN_PRERAMP: true,    // riding down pre-ramps to the lower floor's cap
    MOID_SCREENING_ABOVE: 10,    // warp > this switches conjunctions to MOID screening
    DRAG_CHUNK_GAME_S: 60,       // atmospheric drag integrates in <= this game-sec chunks
  },

  /**
   * The seven floors, F1 (innermost) -> F7 (outermost).
   *
   * camera.distU are camera->anchor distances in scene units; F1/F2 are DOM
   * interiors whose distU is a VIRTUAL dolly (scroll feel + exit hump only,
   * hence camera.fov/near/far = null). near/far are S2 starting points
   * (docs/ladder/01-numbers.md "per-floor render block").
   *
   * fidelity.nearField MUST stay false on F6/F7 (T1: x1e5 bracket collapse +
   * ship-is-icon) and must be re-asserted after SceneManager.applyTier()
   * rebuilds the pass (NearFieldRenderPass.js:106 resets it to true).
   */
  FLOORS: [
    {
      id: 1,
      name: 'ARCHIVE',
      anchor: 'interior',
      camera: { distU: [1e-6, 5e-6], rangeLog10: logRange(1e-6, 5e-6), fov: null, near: null, far: null, upFrame: 'interior' },
      humps: { inFirmness: 1.6 },
      timeCap: 0, // codex pauses the world
      fidelity: { nearField: false, physicsMode: 'paused', debrisMode: 'hidden' },
      costume: { leave: [], arrive: ['CodexViewerUI'], transform: 'dom-codex' },
      contextPanel: 'codex',
      spaceVerb: null,
      labelBudget: 0,
      audioBed: 'archive-hush',
    },
    {
      id: 2,
      name: 'DEPOT',
      anchor: 'interior',
      camera: { distU: [5e-6, 2e-5], rangeLog10: logRange(5e-6, 2e-5), fov: null, near: null, far: null, upFrame: 'interior' },
      // Undocked: browse-only overlay, the F3->F2 hump is a HARD WALL w/ hint.
      // Docked: entry bridges into the real SHOP GameState (time 0 there is the
      // state's, not this floor's). Clunk plays BEFORE the state flip (T8).
      humps: { inFirmness: 1.6, entryRequiresDock: true, deniedHint: 'DOCK TO ENTER DEPOT' },
      timeCap: 1, // undocked overlay: sim keeps running, buying disabled
      fidelity: { nearField: false, physicsMode: 'realtime', debrisMode: 'hidden' },
      costume: { leave: [], arrive: ['ShopScreen:browse'], transform: 'dom-depot-overlay' },
      contextPanel: 'depot-browse',
      spaceVerb: null,
      labelBudget: 0,
      audioBed: 'depot-hum',
    },
    {
      id: 3,
      name: 'HULL CAM',
      anchor: 'subject',
      camera: { distU: [2e-5, 1.2e-4], rangeLog10: logRange(2e-5, 1.2e-4), fov: 35, near: 4e-7, far: 500, upFrame: 'ship' },
      humps: { inFirmness: 1.6 },
      timeCap: 1,
      fidelity: { nearField: true, physicsMode: 'realtime', debrisMode: 'full' },
      // Down-hump arrival absorbs the shipped inspect side-effects
      // (CameraSystem._setInspectZoom, see docs/ladder/02-traps.md T6).
      costume: { leave: ['HUD:capture'], arrive: ['DockingReticle', 'MotherCallouts', 'HullOverlays'], transform: 'lens-split-5m' },
      contextPanel: 'inspect-detail',
      spaceVerb: 'lens-toggle',
      labelBudget: 7,
      audioBed: 'hull-detail',
      /** Lens split: detail (<5 m default) vs overview; one key toggles, distance picks default. */
      lens: { splitAtM: 5, modes: ['detail', 'overview'] },
    },
    {
      id: 4,
      name: 'COMMAND',
      anchor: 'ship',
      // FOV 55 = today's Constants.CAMERA_FOV; near = Constants.CAMERA_NEAR (~3 m).
      camera: { distU: [1.2e-4, 1.2e-3], rangeLog10: logRange(1.2e-4, 1.2e-3), fov: 55, near: 3e-5, far: 500, upFrame: 'ship' },
      // The 12 m lower bound inherits the shipped inspect Schmitt (12 m/18 m);
      // the wall/entry rule replaces it (docs/ladder/00-spec.md §2).
      humps: { inFirmness: 1.6 },
      timeCap: 1,
      fidelity: { nearField: true, physicsMode: 'realtime', debrisMode: 'full' },
      costume: { leave: [], arrive: ['HUD', 'StatusPanel', 'TargetPanel', 'SkillsPane', 'CommsPanel', 'TargetReticle'], transform: null },
      contextPanel: 'capture-status',
      spaceVerb: 'approach-autopilot',
      labelBudget: 7,
      audioBed: 'command-deck',
    },
    {
      id: 5,
      name: 'PROX NET',
      anchor: 'ship',
      camera: { distU: [1.2e-3, 1.2], rangeLog10: logRange(1.2e-3, 1.2), fov: 60, near: 3e-5, far: 500, upFrame: 'ship' },
      humps: { inFirmness: 1.6 },
      timeCap: 4, // danger-capped: conjunction inside horizon ramps to 1x before the knock
      fidelity: { nearField: true, physicsMode: 'realtime', debrisMode: 'tactical' },
      costume: { leave: ['TargetReticle'], arrive: ['ThreatRings', 'ApproachPlanner', 'NavSphere:corner-minimap', 'OrbitMFD'], transform: 'navsphere-to-minimap' },
      contextPanel: 'tactical-approach',
      spaceVerb: 'approach',
      labelBudget: 7,
      audioBed: 'prox-tactical',
    },
    {
      id: 6,
      name: 'NAVCOM',
      anchor: 'earth',
      // 1.1-4 R_E: 70..255 u (R_E = Constants.EARTH_RADIUS = 63.71 u).
      camera: { distU: [70, 255], rangeLog10: logRange(70, 255), fov: 45, near: 0.05, far: 500, upFrame: 'earth-north' },
      humps: { inFirmness: 1.6 },
      timeCap: 20,
      fidelity: { nearField: false, physicsMode: 'warp-moid', debrisMode: 'clusters' },
      costume: { leave: ['NearFieldPass', 'ShipMesh'], arrive: ['ClusterIcons', 'TransferWindows'], transform: 'ship-to-icon' },
      contextPanel: 'transfer-planner',
      spaceVerb: 'plan-transfer',
      labelBudget: 7,
      audioBed: 'navcom-drone',
    },
    {
      id: 7,
      name: 'SDA DOWNLINK',
      anchor: 'earth',
      // far = 2000 u > Constants.CAMERA_FAR (500): S2 owns the per-floor far
      // plane AND the STAR_SPHERE_RADIUS < far constraint (Constants.js:333).
      camera: { distU: [500, 1300], rangeLog10: logRange(500, 1300), fov: 35, near: 0.5, far: 2000, upFrame: 'earth-north' },
      humps: { inFirmness: 1.6 },
      timeCap: 100,
      fidelity: { nearField: false, physicsMode: 'warp-moid', debrisMode: 'massBands' },
      costume: { leave: ['ClusterIcons'], arrive: ['SdaChart', 'KesslerTimeline', 'LensToggle'], transform: 'earth-to-chart' },
      contextPanel: 'sda-ledger',
      spaceVerb: 'flip-lens',
      labelBudget: 7,
      audioBed: 'downlink-static',
      /** Chart framing: 1020 u = 16 R_E default; MEO radially compressed so the
       *  GEO ring (6.6 R_E ~ 420 u) lands at the L/R screen edges — factor
       *  derived from viewport aspect, honest "MEO compressed" tag always on. */
      chart: {
        frameRadiusU: 1020,
        geoRingU: 6.6 * Constants.EARTH_RADIUS,
        meoCompressed: true,
        compressionTag: 'MEO compressed',
        lenses: ['VALUE', 'THREAT'],
      },
    },
  ],

  /**
   * MASS ON ORBIT (~17,000 t) — the F7 VALUE-lens table.
   * Sourced 2026: ESA DISCOSweb / Space Environment Report; NASA ODPO.
   * REGIMES are catalog-backed; LEO_SUB_BANDS are ESTIMATE-flagged derivations
   * (cite the estimate flag wherever they are shown — mass-honesty rule).
   */
  MASS_BANDS: {
    TOTAL_T_TARGET: 17000,       // regime sum 15,623 t + HEO/other remainder
    GEO_PAYLOAD_AVG_T: 3.4,
    REGIMES: [
      { id: 'LEO',           label: 'LEO 200-2,000 km', massT: 9875, estimate: false, source: 'ESA SER 2026' },
      { id: 'MEO',           label: 'MEO (non-GNSS)',   massT: 156,  estimate: false, source: 'ESA SER 2026' },
      { id: 'GNSS',          label: 'GNSS shells',      massT: 628,  estimate: false, source: 'ESA SER 2026' },
      { id: 'GEO_BELT',      label: 'GEO belt',         massT: 2887, estimate: false, source: 'ESA SER 2026', gold: true },
      { id: 'GEO_GRAVEYARD', label: 'GEO graveyard',    massT: 1497, estimate: false, source: 'ESA SER 2026', gold: true },
      { id: 'GTO',           label: 'GTO',              massT: 580,  estimate: false, source: 'ESA SER 2026' },
    ],
    // "Gold" = GEO belt + graveyard = 4,384 t of mass-value.
    LEO_SUB_BANDS: [
      { altKm: [180, 400],   massT: 200,  estimate: true, note: 'VLEO' },
      { altKm: [400, 600],   massT: 6000, estimate: true, note: 'Starlink ~10,400 sats @ ~550 km + ISS' },
      { altKm: [600, 800],   massT: 1200, estimate: true, note: 'Envisat 8.2 t @ 785 km' },
      { altKm: [800, 1000],  massT: 1800, estimate: true, note: '~20 Zenit-2 stages ~9 t @ 840 km; sun-sync fleet' },
      { altKm: [1000, 2000], massT: 900,  estimate: true, note: '' },
    ],
  },

  /**
   * KESSLER TIMELINE — the F7 THREAT-lens data. Tracked-object keyframes;
   * `tracked` = cumulative catalog count where sourced, `delta` = single-event
   * fragment injections (NASA ODPO). Years strictly increase.
   */
  KESSLER_KEYFRAMES: [
    { year: 1957, tracked: 0,     note: 'Sputnik epoch' },
    { year: 1981, tracked: 5000 },
    { year: 1998, tracked: 8500 },
    { year: 2005, tracked: 13000 },
    { year: 2007, delta: 3438, altKm: 865, note: 'Fengyun-1C ASAT test' },
    { year: 2009, delta: 2296, altKm: 789, note: 'Iridium 33 / Kosmos-2251 collision' },
    { year: 2011, tracked: 22000 },
    { year: 2026, tracked: 46000 },
  ],

  /** Projection branches to 2126 (the endings frame; ADR is the player's branch). */
  KESSLER_BRANCHES: [
    { id: 'NO_NEW_LAUNCHES', desc: '+30% over 200 yr; catastrophic collision every 5-9 yr', source: 'Liou & Johnson 2006', playerRole: false },
    { id: 'BAU',             desc: '~4x tracked by 2059',                                   source: 'Lewis 2009',          playerRole: false },
    { id: 'ADR',             desc: '5-10 removals/yr stabilizes the environment',           source: 'Liou 2011; IADC 2013', playerRole: true },
  ],

  /** Orbital-lifetime ladder (THREAT-lens annotations). yearsApprox null = centuries+. */
  DECAY_LADDER: [
    { altKm: 550,  yearsApprox: 15 },
    { altKm: 785,  yearsApprox: 150 },
    { altKm: 830,  yearsApprox: 200 },
    { altKm: 1000, yearsApprox: null, note: 'centuries+' },
  ],

  /** Mass/count honesty notes — must ship on the THREAT lens (00-spec.md §8). */
  HONESTY_NOTES: [
    'pre-2020 count jumps are partly better sensors, not only more debris',
    'cascade onset timing is disputed',
    'sub-LEO band masses are estimates (ESTIMATE flag shown)',
    'F7 MEO radial compression is tagged on screen',
  ],

  /** Scene-unit helpers mirrored for consumers that must not import THREE. */
  UNITS: {
    METERS_TO_UNITS: M,                      // 1 m = 1e-5 u (1 u = 100 km)
    EARTH_RADIUS_U: Constants.EARTH_RADIUS,  // 63.71 u
  },
};
