/**
 * The F3 (HULL CAM) blueprint anchor manifest (FloorContract.FLOORS[2], docs/ladder/00-spec.md §3,
 * docs/ladder/08-workbench.md §1 D9).
 *
 * PURE DATA. Seven labeled subsystems for the BlueprintOverlay callouts: ENGINEERING, POWER, COMMS, THERMAL, CARGO, and
 * (D9, owner 2026-09-02) SENSORS and BERTHS, so each of the 33 purchasable items has a part to click. Seven is exactly
 * the F3 labelBudget: nothing is culled, and rank is the carousel order. Anchors are ship-LOCAL offsets in METRES
 * (PlayerSatellite model convention, see js/ui/MotherCallouts.js: +Z fore, -Z aft, XY radial; barrel r = 0.40 m, L =
 * 2.0 m, caps at z = +-1.0), taken from the verified MotherCallouts anchor table so the blueprint points at the same
 * hardware as the inspection callouts:
 *   - ENGINEERING -> FEEP ion-thruster cluster under the aft deck
 *   - POWER       -> ROSA wing root (+X is the ROSA azimuth)
 *   - BERTHS      -> az-64° daughter-berth pocket. The carved groove has no mesh: the live anchor is the strut-riding
 *                    reel cartridge (ReelCartridge_0, stowed AT the berth), the static fallback is the pocket's aft
 *                    hull rim (MotherCallouts `berths`)
 *   - COMMS       -> S-band omni pair on the fore barrel
 *   - CARGO       -> nose berthing collar (BerthCollarRing, z = +1.30 = Constants.OCTOPUS_V5.BERTH_COLLAR_Z_M): caught
 *                    nets mate on-axis there ("the berth IS the corridor"), so it is the visible cargo mouth; kept off
 *                    the berth rim so two cards do not say the same thing
 *   - SENSORS     -> fixed sensor deck annulus behind the fore cap (SensorDeck: daylight/heat/laser-ranging turret +
 *                    star trackers)
 *   - THERMAL     -> bare-MLI shoulder band. NOT the aft flower radiators: they are purchase-gated, so anchoring there
 *                    would point at empty rim pre-purchase (the trap MotherCallouts' flowerGated idiom avoids)
 *
 * `mesh` names an optional live PlayerSatellite mesh: with a shipMeshSource adapter (HullCamFloor deps) the anchor
 * re-resolves from the live mesh position (MotherCallouts T1 pattern); otherwise the static offset is the anchor. Both
 * ship-local. `meshOffsetM` [x, y, z] in METRES (ship frame): HullCamFloor._anchorU adds it to the LIVE mesh position
 * only, to point at a feature when the mesh origin is not it. The static `anchorM` is never offset; ignored without
 * `mesh`.
 *
 * `readout` keys the HullCamFloor detail-lens provider (deps.providers[readout]) whose live rows expand the focused
 * card; `spec` rows are the static fallback. main.js ships no 'cargo' or 'power' provider, so BERTHS ('cargo') and
 * CARGO ('cargoBay') show static rows.
 *
 * `codexId` is the Tech Library deep-link a title click opens (CODEX_OPEN_ENTRY, the MotherCallouts grammar); ids are
 * reused from the MotherCallouts part map where a part exists. CARGO anchors on the nose collar, so it deep-links
 * 'capture_collar'. Every id resolves in data/codex.json (pinned by test).
 *
 * @module data/blueprintSubsystems
 */

/** 1 metre in scene units (1 scene unit = 100 km — PlayerSatellite's M). */
export const M_TO_U = 0.00001;

/**
 * The seven blueprint subsystems (D9), priority-ranked (higher = kept first when a label budget culls, and the lens-toggle
 * carousel order). Seven = VisualLaw.LABELS.MAX_WORLD = F3 labelBudget.
 */
export const BLUEPRINT_SUBSYSTEMS = [
  {
    id: 'ENGINEERING',
    label: 'ENGINEERING',
    anchorM: [0, -0.20, -1.05],       // FEEP emitter cluster (aft, below axis)
    mesh: 'AftThrusterDeck',          // live aft-deck mesh (static plate)
    priority: 8,
    readout: 'engineering',
    codexId: 'feep_thruster',         // MotherCallouts `feep`
    spec: ['4\u00d7 FEEP ion clusters \u00b7 specific impulse ~4000 s', 'cold-gas steering ring (nitrogen)'],
  },
  {
    id: 'POWER',
    label: 'POWER',
    anchorM: [1.1, 0, 0],             // ROSA wing, outboard of the spool
    mesh: null,                       // wings articulate; static root is honest
    priority: 9,
    readout: 'power',
    codexId: 'rosa_solar_array',      // MotherCallouts `rosa_wings`
    spec: ['2\u00d7 1\u00d72 m roll-out arrays', '~2.2 kW peak (beginning of life)'],
  },
  {
    id: 'BERTHS',
    label: 'BERTHS',
    anchorM: [0.0512, 0.3967, -0.85],  // az-64° pocket's aft-lip corner (DECISIONS §11; matches MotherCallouts `berths`)
    mesh: 'ReelCartridge_0',          // strut-riding cartridge, stowed AT the berth; static rim is the fallback
    priority: 7,
    readout: 'cargo',                 // no shipped provider: the static spec rows show
    codexId: 'docking_berthing',      // MotherCallouts `berths`
    spec: ['4\u00d7 daughter berths \u00b7 2 large, 2 small', 'Dyneema tether winches'],
  },
  {
    id: 'COMMS',
    label: 'COMMS',
    anchorM: [0, -0.40, 0.92],        // S-band omni pair, fore barrel
    mesh: null,
    priority: 6,
    readout: 'comms',
    codexId: 'frequency_bands',       // MotherCallouts `ttc`
    spec: ['S-band omni pair \u00b7 cmd + telemetry', 'Medium-gain patch antenna'],
  },
  {
    id: 'CARGO',
    label: 'CARGO',
    anchorM: [0, 0, 1.30],            // nose berthing collar seat plane (fore)
    mesh: 'BerthCollarRing',          // the capture ring (fixed hull hardware)
    priority: 5,
    readout: 'cargoBay',              // no provider: static rows
    codexId: 'capture_collar',      // the nose collar's own briefing
    spec: ['Nose berthing collar \u00b7 0.32 m bore', 'Caught debris mates on-axis'],
  },
  {
    id: 'SENSORS',
    label: 'SENSORS',
    anchorM: [0, 0.30, 1.03],         // fixed sensor-deck annulus rim (fore)
    mesh: 'SensorDeck',               // the deck plate (fixed)
    meshOffsetM: [0, 0.37, 0],        // mesh origin is the bore centre (inside the collar bore): point at the deck lip (r 0.34-0.38) at az 90
    priority: 4,
    readout: 'sensors',
    codexId: 'lidar_ranging',         // MotherCallouts `lidar` (codex cat SENSORS)
    spec: ['Daylight + heat cameras + flash laser-ranging turret', 'Star trackers \u00b7 sun sensors'],
  },
  {
    id: 'THERMAL',
    label: 'THERMAL',
    anchorM: [0.404, 0, 0.78],        // bare-MLI shoulder band (always present)
    mesh: null,
    priority: 3,
    readout: 'thermal',
    codexId: 'mli_insulation',        // MotherCallouts `mli`
    spec: ['Multi-layer insulation blankets', 'Passive radiative rejection'],
  },
];

/** A subsystem's static anchor in ship-local SCENE UNITS (the space the injected `project()` consumes). Pure; fresh object per call. */
export function anchorLocalU(sub) {
  return {
    x: sub.anchorM[0] * M_TO_U,
    y: sub.anchorM[1] * M_TO_U,
    z: sub.anchorM[2] * M_TO_U,
  };
}
