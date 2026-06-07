/**
 * debrisFerrous.js — shared ferrous-flag derivation for debris (CP-1 / P2).
 *
 * Single source of truth used by BOTH the procedural factory (DebrisField) and
 * the catalog converter (CatalogConverter) so the magnet recommender behaves
 * identically for procedural and real debris. Keep the rules here — do not
 * re-derive `ferromagnetic` / `hasFerrousFasteners` inline.
 *
 * @module entities/debrisFerrous
 */

/** Materials whose hull is directly grabbable by the EPM (pure-steel). */
export const FERROUS_HULL_MATERIALS = ['steel'];

/** Debris types that carry steel bolts/brackets even on Al/Ti hulls (§13 Q4). */
export const FERROUS_FASTENER_TYPES = ['rocketBody', 'defunctSat'];

/**
 * @param {string} material - debris material tag
 * @param {string} type     - internal DEBRIS_TYPES key
 * @returns {{ ferromagnetic: boolean, hasFerrousFasteners: boolean }}
 */
export function deriveFerrousFlags(material, type) {
  return {
    ferromagnetic: FERROUS_HULL_MATERIALS.includes(material),
    hasFerrousFasteners: FERROUS_FASTENER_TYPES.includes(type),
  };
}
