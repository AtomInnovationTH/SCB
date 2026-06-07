/**
 * debrisFerrous.js — shared capture-metadata derivation for debris (CP-1).
 *
 * Single source of truth used by BOTH the procedural factory (DebrisField) and
 * the catalog converter (CatalogConverter) so the tool recommender + capture
 * sub-FSMs behave identically for procedural and real debris. Keep the rules
 * here — do not re-derive these flags inline.
 *
 * @module entities/debrisFerrous
 */

/** Materials whose hull is directly grabbable by the EPM (pure-steel). */
export const FERROUS_HULL_MATERIALS = ['steel', 'iron_alloy'];

/** Debris types that carry steel bolts/brackets even on Al/Ti hulls (§13 Q4). */
export const FERROUS_FASTENER_TYPES = ['rocketBody', 'defunctSat'];

/** Types likely to expose a grapple fixture (antenna stub / docking adapter). */
export const FIXTURE_TYPES = ['rocketBody', 'defunctSat'];

/** Min mass (kg) for the heuristic grapple-fixture default (§5.2). */
export const FIXTURE_MIN_MASS_KG = 50;

/** Material → surface roughness 0..1 for the P4 pad-mode resolver (§6.1). */
export const SURFACE_ROUGHNESS_BY_MATERIAL = {
  mli_mylar:  0.9,
  solar_cell: 0.2,
  aluminum:   0.4,
  titanium:   0.5,
  composite:  0.6,
  steel:      0.5,
};
const SURFACE_ROUGHNESS_FALLBACK = 0.5;

/**
 * Derive every capture-relevant flag for one debris object.
 * @param {string} material - debris material tag
 * @param {string} type     - internal DEBRIS_TYPES key
 * @param {number} mass     - debris mass (kg)
 * @returns {{ ferromagnetic: boolean, hasFerrousFasteners: boolean,
 *            hasGrappleFixture: boolean, surfaceRoughness: number }}
 */
export function deriveCaptureFlags(material, type, mass) {
  return {
    ferromagnetic: FERROUS_HULL_MATERIALS.includes(material),
    hasFerrousFasteners: FERROUS_FASTENER_TYPES.includes(type),
    hasGrappleFixture: FIXTURE_TYPES.includes(type) && (mass || 0) >= FIXTURE_MIN_MASS_KG,
    surfaceRoughness: (material in SURFACE_ROUGHNESS_BY_MATERIAL)
      ? SURFACE_ROUGHNESS_BY_MATERIAL[material]
      : SURFACE_ROUGHNESS_FALLBACK,
  };
}

/** @deprecated kept for callers that only need the ferrous pair. */
export function deriveFerrousFlags(material, type) {
  const f = deriveCaptureFlags(material, type, 0);
  return { ferromagnetic: f.ferromagnetic, hasFerrousFasteners: f.hasFerrousFasteners };
}
