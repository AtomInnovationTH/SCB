/**
 * refitIndex.js — Wave 5 (2): the 8→7 lookup between MotherCallouts' EIGHT
 * hull-callout systems and the SEVEN refit subsystems of the blueprint
 * manifest / fittingCatalog (docs/ladder/08-workbench.md §2 "REFIT card",
 * docs/ladder/03-plan.md "Wave 5 — GO" item (2)).
 *
 * WHY A LOOKUP, NOT A SECOND INDEX: the hull's costume is MotherCallouts (8
 * colour-coded systems: POWER, PROPULSION, PAYLOAD, SENSORS, COMMS, CAPTURE,
 * THERMAL, DAUGHTERS) while the REFIT pane's data is keyed by the D9 seven
 * (fittingCatalog.SUBSYSTEMS: ENGINEERING, POWER, COMMS, THERMAL, CARGO,
 * SENSORS, BERTHS). The REFIT card needs ONE mapping between the two, not a
 * second index painted on the hull (03-plan.md:435-437).
 *
 * PURE DATA + pure functions. Imports NOTHING from js/ui (MotherCallouts is a
 * THREE-heavy UI module); instead this module carries its own literal copy of
 * the callout part ids per system, and test-refitIndex.js pins that copy
 * byte-for-byte against the live MOTHER_CALLOUT_SYSTEMS export
 * (MotherCallouts.js:2130) and fittingCatalog.SUBSYSTEMS — drift trips the
 * suite, never the game.
 *
 * The mapping (owner defaults, 2026-09-03):
 *   PROPULSION → ENGINEERING   (thruster block / bus structure)
 *   POWER      → POWER
 *   CAPTURE    → BERTHS        (berths, reels, springs — D9 "arms, nets …")
 *   COMMS      → COMMS
 *   SENSORS    → SENSORS
 *   PAYLOAD    → null          (net launcher / despin laser — no refit group)
 *   DAUGHTERS  → null          (docked craft, not Mother hardware)
 *   THERMAL    → null          (the aft FLOWER group — the manifest's THERMAL
 *                               is the MLI blanket, NOT the flower; the flower
 *                               pairs are bought under the pane's own THERMAL
 *                               card but their hull callouts are purchase-gated
 *                               hardware, not the blanket)
 * PART RULE (checked FIRST, before the system rule):
 *   mli        → THERMAL       (the MLI blanket part sits under PROPULSION in
 *                               the callout table, but it IS the manifest's
 *                               THERMAL subsystem — blueprintSubsystems.js:138)
 * And one subsystem no hull part reaches:
 *   CARGO      ← nothing       (the nose berthing collar has no MotherCallouts
 *                               part; the CARGO card is reachable only from
 *                               the pane's own index)
 *
 * @module data/refitIndex
 */

/**
 * MotherCallouts system id → refit subsystem id (or null = no refit group).
 * Every one of the EIGHT callout systems appears here, explicitly — the test
 * walks MOTHER_CALLOUT_SYSTEMS and fails on a missing key.
 * @type {Readonly<Object<string, string|null>>}
 */
export const SYSTEM_TO_SUBSYSTEM = Object.freeze({
  POWER: 'POWER',
  PROPULSION: 'ENGINEERING',
  PAYLOAD: null,
  SENSORS: 'SENSORS',
  COMMS: 'COMMS',
  CAPTURE: 'BERTHS',
  THERMAL: null,          // the flower group — see the header
  DAUGHTERS: null,
});

/**
 * Part-level overrides, checked BEFORE the system rule. Keyed by the
 * MotherCallouts part id.
 * @type {Readonly<Object<string, string|null>>}
 */
export const PART_TO_SUBSYSTEM = Object.freeze({
  mli: 'THERMAL',         // the blanket IS the manifest's THERMAL subsystem
});

/**
 * Literal copy of the MotherCallouts part ids per system (the 34-rec table),
 * so partsForSubsystem() stays pure without a js/ui import. PINNED against
 * the live MOTHER_CALLOUT_SYSTEMS table in test-refitIndex.js — edit the
 * callout table and this copy together or the suite fails loudly.
 * @type {Readonly<Object<string, ReadonlyArray<string>>>}
 */
export const PARTS_BY_SYSTEM = Object.freeze({
  POWER: Object.freeze(['rosa_wings', 'body_cells', 'array_roll']),
  PROPULSION: Object.freeze(['feep', 'rcs', 'mli', 'aft_deck']),
  PAYLOAD: Object.freeze(['despin', 'net_launcher']),
  SENSORS: Object.freeze([
    'gimbal', 'eo_cam', 'ir_cam', 'lidar', 'star_trackers',
    'fore_bulkhead', 'sensor_deck', 'sun_sensors', 'nav_lights',
  ]),
  COMMS: Object.freeze(['ttc', 'mga', 'gps', 'ttc_aft']),
  CAPTURE: Object.freeze(['berths', 'tether_reels', 'hinges', 'cradle_spring']),
  THERMAL: Object.freeze(['flower_plates', 'flower_struts', 'flower_tips', 'flower_hinges']),
  DAUGHTERS: Object.freeze(['daughter_0', 'daughter_1', 'daughter_2', 'daughter_3']),
});

/**
 * The refit subsystem a hull part belongs to — the D-a click grammar's first
 * hop (clicking a part opens ITS refit card). Part rule first (`mli`), then
 * the system rule; anything unknown maps to null (the pane then opens on its
 * index instead of a card — never throws).
 * @param {{ id?: string|null, systemId?: string|null }|null} part — the
 *   MotherCallouts.getHoveredPart()/getFocusedPart() record shape
 * @returns {string|null} one of fittingCatalog.SUBSYSTEMS, or null
 */
export function subsystemForPart(part) {
  if (!part) return null;
  const id = part.id;
  if (id != null && Object.prototype.hasOwnProperty.call(PART_TO_SUBSYSTEM, id)) {
    return PART_TO_SUBSYSTEM[id];
  }
  const sys = part.systemId;
  if (sys != null && Object.prototype.hasOwnProperty.call(SYSTEM_TO_SUBSYSTEM, sys)) {
    return SYSTEM_TO_SUBSYSTEM[sys];
  }
  return null;
}

/**
 * Inverse lookup: every MotherCallouts part id whose subsystemForPart() lands
 * on `subsystemId` — the REFIT pane's ghost-outline target set (hovering a
 * POWER alternative pulses rosa_wings + body_cells + array_roll on the hull).
 * CARGO returns [] (no hull part reaches it); unknown ids return [].
 * Allocates a fresh array per call — call on hover edges, never per frame.
 * @param {string} subsystemId — one of fittingCatalog.SUBSYSTEMS
 * @returns {string[]} MotherCallouts part ids (table order)
 */
export function partsForSubsystem(subsystemId) {
  const out = [];
  if (!subsystemId) return out;
  for (const [sysId, partIds] of Object.entries(PARTS_BY_SYSTEM)) {
    for (const id of partIds) {
      if (subsystemForPart({ id, systemId: sysId }) === subsystemId) out.push(id);
    }
  }
  return out;
}
