/**
 * avionicsMaterials.js — SSOT material *recipes* (`{ color, metalness, roughness }`)
 * for the mothership fore-end avionics and the daughter-arm mini net launcher.
 *
 * Recipes, NOT shared THREE.Material instances: the mother keeps its materials
 * for the session while daughter arms dispose theirs in ArmUnit.dispose(), so
 * each site builds its own `new THREE.MeshStandardMaterial({ ...recipe })`.
 *
 * @module scene/avionicsMaterials
 */

/** Machined gunmetal — housings, baffle tubes, launcher body. */
export const AVIONICS_GUNMETAL = { color: 0x55585f, metalness: 0.5, roughness: 0.55 };

/** Dark recessed optic — star-tracker/sun-sensor windows, net bores, primaries. */
export const AVIONICS_DARK_OPTIC = { color: 0x0a0a12, metalness: 0.4, roughness: 0.15 };

/** Pale thermal-white — MGA/GPS patches, Dyneema net caps. */
export const AVIONICS_THERMAL_WHITE = { color: 0xd8d8d0, metalness: 0.2, roughness: 0.7 };
