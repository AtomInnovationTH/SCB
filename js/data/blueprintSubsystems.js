/**
 * blueprintSubsystems.js — the F3 (HULL CAM) blueprint anchor manifest
 * (S4, FloorContract.FLOORS[2], docs/ladder/00-spec.md §3,
 * docs/ladder/08-workbench.md §1 D9).
 *
 * PURE DATA. Seven labeled ship subsystems for the BlueprintOverlay callouts:
 * ENGINEERING (thruster block), POWER (solar arrays/battery), COMMS (antenna),
 * THERMAL, CARGO, and — D9 (owner, 2026-09-02) — SENSORS and BERTHS, so every
 * one of the 33 purchasable items has a part to click (arms, nets and sensors
 * included). Seven is exactly the F3 labelBudget: the budget never culls, and
 * the rank is the carousel order. Anchors are ship-LOCAL offsets in METRES
 * (the PlayerSatellite model convention documented in js/ui/MotherCallouts.js:
 * +Z fore, −Z aft, XY radial; barrel r = 0.40 m, L = 2.0 m → caps at z = ±1.0).
 * Coordinates are taken from the verified MotherCallouts anchor table so the
 * blueprint points at the same real hardware the inspection callouts do:
 *   - ENGINEERING → the FEEP ion-thruster cluster under the aft deck;
 *   - POWER      → the ROSA wing root (+X is the ROSA azimuth);
 *   - BERTHS     → the az-60° daughter-berth pocket (where the daughters dock,
 *                  D9) — the carved groove has no mesh of its own, so the live
 *                  anchor is the strut-riding reel cartridge (ReelCartridge_0,
 *                  stowed AT the berth) and the static fallback is the pocket's
 *                  aft hull rim (the MotherCallouts `berths` anchor);
 *   - COMMS      → the S-band omni pair on the fore barrel;
 *   - CARGO      → the nose berthing collar (BerthCollarRing, z = +1.30 —
 *                  Constants.OCTOPUS_V5.BERTH_COLLAR_Z_M): caught nets mate
 *                  rigidly on-axis there ("the berth IS the corridor"), so it
 *                  is the visible cargo mouth. Re-anchored from the daughter-
 *                  berth rim when D9 split BERTHS into its own callout — two
 *                  cards on one rim would say the same thing twice;
 *   - SENSORS    → the fixed sensor deck annulus behind the fore cap
 *                  (SensorDeck; the EO/IR/LIDAR turret + star trackers mount
 *                  there — the D9 home for every shop sensor);
 *   - THERMAL    → the bare-MLI shoulder band (the aft flower radiators are
 *                  PURCHASE-GATED hardware — anchoring THERMAL there would
 *                  point at empty rim pre-purchase, the exact trap
 *                  MotherCallouts' flowerGated idiom exists to avoid).
 *
 * `mesh` names an optional live PlayerSatellite mesh: when the serial track
 * injects a shipMeshSource adapter (HullCamFloor deps), the anchor re-resolves
 * from the live mesh position (TierVisualManager / MotherCallouts T1 pattern);
 * otherwise the static offset here is the anchor. Both paths are ship-local.
 *
 * `readout` keys the HullCamFloor detail-lens provider (deps.providers[readout])
 * whose live rows expand the focused card; `spec` rows are the static fallback
 * so the card is never blank headless. NOTE: the shipped 'cargo' provider
 * (main.js) reports tether-winch activity ("REELS ACTIVE n/4") — that data
 * describes the winches at the daughter berths, so BERTHS keys it now; CARGO
 * keys 'cargoBay' (no provider yet → honest static rows until a hold/capacity
 * provider lands with the serial track).
 *
 * `codexId` is the Tech Library deep-link a title click opens
 * (CODEX_OPEN_ENTRY — the MotherCallouts grammar). Ids are reused from the
 * MotherCallouts part map wherever a part exists for the anchor (feep → 
 * 'feep_thruster', rosa_wings → 'rosa_solar_array', ttc → 'frequency_bands',
 * mli → 'mli_insulation', berths → 'docking_berthing', lidar →
 * 'lidar_ranging'); CARGO has no MotherCallouts hold part, so it links the
 * PLAYBOOK 'salvage_economy' entry (sell/contribute — what the cargo card is
 * FOR). Every id resolves in data/codex.json (pinned by test).
 *
 * @module data/blueprintSubsystems
 */

/** 1 metre in scene units (1 scene unit = 100 km — PlayerSatellite's M). */
export const M_TO_U = 0.00001;

/**
 * The seven blueprint subsystems (D9), priority-ranked (higher = kept first
 * when a label budget culls, and the lens-toggle carousel order;
 * VisualLaw.LABELS.MAX_WORLD / F3 labelBudget = 7 — seven callouts IS the
 * budget, exactly: the rank is the law, not a hope).
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
    spec: ['4\u00d7 FEEP ion clusters \u00b7 Isp ~4000 s', 'GN2 cold-gas steering ring'],
  },
  {
    id: 'POWER',
    label: 'POWER',
    anchorM: [1.1, 0, 0],             // ROSA wing, outboard of the spool
    mesh: null,                       // wings articulate; static root is honest
    priority: 9,
    readout: 'power',
    codexId: 'rosa_solar_array',      // MotherCallouts `rosa_wings`
    spec: ['2\u00d7 1\u00d72 m roll-out arrays', '~2.2 kW peak (BOL)'],
  },
  {
    id: 'BERTHS',
    label: 'BERTHS',
    anchorM: [0.20, 0.346, -0.85],    // az-60° berth pocket's aft hull rim
    mesh: 'ReelCartridge_0',          // strut-riding cartridge — stowed AT the
                                      // berth (deployed it walks out with the
                                      // strut; the static rim is the fallback)
    priority: 7,
    readout: 'cargo',                 // shipped provider: REELS ACTIVE n/4 —
                                      // winch activity, i.e. THIS hardware
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
    mesh: 'BerthCollarRing',          // the collar torus (fixed hull hardware)
    priority: 5,
    readout: 'cargoBay',              // no provider yet → static rows (the
                                      // winch readout moved home to BERTHS)
    codexId: 'salvage_economy',       // PLAYBOOK: sell / contribute — the card's job
    spec: ['Nose berthing collar \u00b7 0.32 m bore', 'Caught debris mates on-axis'],
  },
  {
    id: 'SENSORS',
    label: 'SENSORS',
    anchorM: [0, 0.30, 1.03],         // fixed sensor-deck annulus rim (fore)
    mesh: 'SensorDeck',               // the deck plate (fixed; turret articulates)
    priority: 4,
    readout: 'sensors',
    codexId: 'lidar_ranging',         // MotherCallouts `lidar` (codex cat SENSORS)
    spec: ['EO + IR + flash LIDAR turret', 'Star trackers \u00b7 sun sensors'],
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

/**
 * A subsystem's static anchor in ship-local SCENE UNITS (the coordinate space
 * the injected `project()` consumes). Pure; fresh object per call.
 * @param {{anchorM:number[]}} sub - a BLUEPRINT_SUBSYSTEMS entry
 * @returns {{x:number, y:number, z:number}}
 */
export function anchorLocalU(sub) {
  return {
    x: sub.anchorM[0] * M_TO_U,
    y: sub.anchorM[1] * M_TO_U,
    z: sub.anchorM[2] * M_TO_U,
  };
}
