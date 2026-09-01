/**
 * blueprintSubsystems.js — the F3 (HULL CAM) blueprint anchor manifest
 * (S4, FloorContract.FLOORS[2], docs/ladder/00-spec.md §3).
 *
 * PURE DATA. Five labeled ship subsystems for the BlueprintOverlay callouts:
 * ENGINEERING (thruster block), POWER (solar arrays/battery), COMMS (antenna),
 * THERMAL, CARGO. Anchors are ship-LOCAL offsets in METRES (the PlayerSatellite
 * model convention documented in js/ui/MotherCallouts.js: +Z fore, −Z aft, XY
 * radial; barrel r = 0.40 m, L = 2.0 m → caps at z = ±1.0). Coordinates are
 * taken from the verified MotherCallouts anchor table so the blueprint points
 * at the same real hardware the inspection callouts do:
 *   - ENGINEERING → the FEEP ion-thruster cluster under the aft deck;
 *   - POWER      → the ROSA wing root (+X is the ROSA azimuth);
 *   - COMMS      → the S-band omni pair on the fore barrel;
 *   - THERMAL    → the bare-MLI shoulder band (the aft flower radiators are
 *                  PURCHASE-GATED hardware — anchoring THERMAL there would
 *                  point at empty rim pre-purchase, the exact trap
 *                  MotherCallouts' flowerGated idiom exists to avoid);
 *   - CARGO      → the daughter-berth groove rim (the visible cargo hardware).
 *
 * `mesh` names an optional live PlayerSatellite mesh: when the serial track
 * injects a shipMeshSource adapter (HullCamFloor deps), the anchor re-resolves
 * from the live mesh position (TierVisualManager / MotherCallouts T1 pattern);
 * otherwise the static offset here is the anchor. Both paths are ship-local.
 *
 * `readout` keys the HullCamFloor detail-lens provider (deps.providers[readout])
 * whose live rows expand the focused card; `spec` rows are the static fallback
 * so the card is never blank headless.
 *
 * @module data/blueprintSubsystems
 */

/** 1 metre in scene units (1 scene unit = 100 km — PlayerSatellite's M). */
export const M_TO_U = 0.00001;

/**
 * The five blueprint subsystems, priority-ranked (higher = kept first when a
 * label budget culls; VisualLaw.LABELS.MAX_WORLD / F3 labelBudget = 7 covers
 * all five today — the rank is the law, not a hope).
 */
export const BLUEPRINT_SUBSYSTEMS = [
  {
    id: 'ENGINEERING',
    label: 'ENGINEERING',
    anchorM: [0, -0.20, -1.05],       // FEEP emitter cluster (aft, below axis)
    mesh: 'AftThrusterDeck',          // live aft-deck mesh (static plate)
    priority: 8,
    readout: 'engineering',
    spec: ['4\u00d7 FEEP ion clusters \u00b7 Isp ~4000 s', 'GN2 cold-gas steering ring'],
  },
  {
    id: 'POWER',
    label: 'POWER',
    anchorM: [1.1, 0, 0],             // ROSA wing, outboard of the spool
    mesh: null,                       // wings articulate; static root is honest
    priority: 9,
    readout: 'power',
    spec: ['2\u00d7 1\u00d72 m roll-out arrays', '~2.2 kW peak (BOL)'],
  },
  {
    id: 'COMMS',
    label: 'COMMS',
    anchorM: [0, -0.40, 0.92],        // S-band omni pair, fore barrel
    mesh: null,
    priority: 6,
    readout: 'comms',
    spec: ['S-band omni pair \u00b7 cmd + telemetry', 'Medium-gain patch antenna'],
  },
  {
    id: 'CARGO',
    label: 'CARGO',
    anchorM: [0.20, 0.346, -0.85],    // az-60° berth pocket's aft hull rim
    mesh: null,
    priority: 5,
    readout: 'cargo',
    spec: ['4\u00d7 daughter berths \u00b7 2 large, 2 small', 'Dyneema tether winches'],
  },
  {
    id: 'THERMAL',
    label: 'THERMAL',
    anchorM: [0.404, 0, 0.78],        // bare-MLI shoulder band (always present)
    mesh: null,
    priority: 4,
    readout: 'thermal',
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
