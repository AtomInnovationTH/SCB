/**
 * The 8->7 lookup between MotherCallouts' EIGHT hull-callout systems and the SEVEN refit subsystems of the blueprint manifest /
 * fittingCatalog (docs/ladder/08-workbench.md §2 "REFIT card", archive/ladder/03-plan.md "Wave 5 - GO" item (2)).
 *
 * A lookup, not a second index: the hull uses MotherCallouts (POWER, PROPULSION, PAYLOAD, SENSORS, COMMS, CAPTURE, THERMAL,
 * DAUGHTERS) while REFIT data is keyed by the D9 seven (fittingCatalog.SUBSYSTEMS: ENGINEERING, POWER, COMMS, THERMAL, CARGO,
 * SENSORS, BERTHS); the card needs one mapping between them (archive/ladder/03-plan.md).
 *
 * PURE DATA + pure functions. Imports NOTHING from js/ui (MotherCallouts is THREE-heavy): it carries its own literal copy of the
 * callout part ids per system, and test-refitIndex.js pins that copy against the live MOTHER_CALLOUT_SYSTEMS export and
 * fittingCatalog.SUBSYSTEMS, so drift trips the suite, never the game.
 *
 * The mapping (owner defaults 2026-09-03; THERMAL amended 2026-09-09, D13):
 *   PROPULSION -> ENGINEERING  (thruster block / bus structure)
 *   POWER      -> POWER
 *   CAPTURE    -> BERTHS       (berths, reels, springs; D9 "arms, nets ...")
 *   COMMS      -> COMMS
 *   SENSORS    -> SENSORS
 *   PAYLOAD    -> null         (net launcher / despin laser: no refit group; the REFIT section renders the D12 "detached" line)
 *   DAUGHTERS  -> null         (docked craft, not Mother hardware; D12 too)
 *   THERMAL    -> THERMAL      (D13: the callout THERMAL is the aft FLOWER group, the manifest's THERMAL is the MLI blanket, but
 *                               the THERMAL card already hosts the FLOWER actuator chip and flower-pair purchases, so a click on
 *                               any flower part opens the card that buys and drives it, and hovering a THERMAL alternative ghosts
 *                               the flower parts: partsForSubsystem('THERMAL') = mli + the four flower parts, skipping unbuilt ones.
 *                               Revert: THERMAL back to null + the test pins; flower parts then take D12)
 * PART RULE (checked FIRST, before the system rule):
 *   mli        -> THERMAL      (sits under PROPULSION in the callout table but IS the manifest's THERMAL subsystem)
 * One subsystem no hull part reaches:
 *   CARGO      <- nothing      (the nose berthing collar has no MotherCallouts part; the CARGO card opens only from the pane's index)
 *
 * @module data/refitIndex
 */

/**
 * MotherCallouts system id -> refit subsystem id (null = no refit group). All EIGHT callout systems appear; the test
 * fails on a missing key. @type {Readonly<Object<string, string|null>>}
 */
export const SYSTEM_TO_SUBSYSTEM = Object.freeze({
  POWER: 'POWER',
  PROPULSION: 'ENGINEERING',
  PAYLOAD: null,
  SENSORS: 'SENSORS',
  COMMS: 'COMMS',
  CAPTURE: 'BERTHS',
  THERMAL: 'THERMAL',     // D13: the flower group -> the THERMAL card (see header)
  DAUGHTERS: null,
});

/** Part-level overrides, checked BEFORE the system rule; keyed by MotherCallouts part id. @type {Readonly<Object<string, string|null>>} */
export const PART_TO_SUBSYSTEM = Object.freeze({
  mli: 'THERMAL',         // the blanket IS the manifest's THERMAL subsystem
});

/**
 * Literal copy of the MotherCallouts part ids per system, so partsForSubsystem() stays pure without a js/ui import. PINNED against
 * the live MOTHER_CALLOUT_SYSTEMS in test-refitIndex.js: edit both together.
 * @type {Readonly<Object<string, ReadonlyArray<string>>>}
 */
export const PARTS_BY_SYSTEM = Object.freeze({
  POWER: Object.freeze(['rosa_wings', 'body_cells', 'array_roll', 'wing_motor_box', 'battery']),
  PROPULSION: Object.freeze(['feep', 'rcs', 'mli', 'aft_deck', 'tanks', 'wheels']),
  PAYLOAD: Object.freeze(['despin', 'net_launcher', 'berth_collar']),
  SENSORS: Object.freeze([
    'gimbal', 'eo_cam', 'ir_cam', 'lidar', 'star_trackers',
    'fore_bulkhead', 'sensor_deck', 'sun_sensors', 'nav_lights',
  ]),
  COMMS: Object.freeze(['ttc', 'mga', 'gps', 'ttc_aft']),
  CAPTURE: Object.freeze(['berths', 'tether_reels', 'hinges', 'cradle_spring', 'daughter_struts']),
  THERMAL: Object.freeze(['flower_plates', 'flower_struts', 'flower_tips', 'flower_hinges', 'heaters']),
  DAUGHTERS: Object.freeze(['daughter_0', 'daughter_1', 'daughter_2', 'daughter_3']),
});

/**
 * The refit subsystem a hull part belongs to (a click on a part opens ITS refit card). Part rule first (`mli`), then the system
 * rule; unknown maps to null (the REFIT section shows the D12 "detached" line); never throws.
 * @param {{ id?: string|null, systemId?: string|null }|null} part MotherCallouts.getHoveredPart()/getFocusedPart() record shape
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
 * Inverse lookup: every MotherCallouts part id whose subsystemForPart() lands on `subsystemId` (the REFIT pane's ghost-outline
 * target set on hover). CARGO and unknown ids return []. Allocates per call: call on hover edges, never per frame.
 * @param {string} subsystemId one of fittingCatalog.SUBSYSTEMS
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
