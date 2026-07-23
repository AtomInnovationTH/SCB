/**
 * avionicsMaterials.js — SSOT material *recipes* for the mothership fore-end
 * avionics palette and the daughter-arm mini net launcher.
 *
 * These are plain `{ color, metalness, roughness }` recipes, NOT shared
 * THREE.Material instances: the mother keeps its materials for the session while
 * daughter arms dispose theirs in ArmUnit.dispose(), so each site constructs its
 * own `new THREE.MeshStandardMaterial({ ...recipe })`. Sharing the recipe (not
 * the instance) keeps the mother and daughters visually in lockstep without a
 * cross-entity dispose hazard. (2026-07-23, fore-end-hardware-labels-rework.)
 *
 * @module scene/avionicsMaterials
 */

/** Machined gunmetal — housings, baffle tubes, launcher body. */
export const AVIONICS_GUNMETAL = { color: 0x55585f, metalness: 0.5, roughness: 0.55 };

/** Dark recessed optic — star-tracker/sun-sensor windows, net bores, primaries. */
export const AVIONICS_DARK_OPTIC = { color: 0x0a0a12, metalness: 0.4, roughness: 0.15 };

/** Pale thermal-white — MGA/GPS patches, Dyneema net caps. */
export const AVIONICS_THERMAL_WHITE = { color: 0xd8d8d0, metalness: 0.2, roughness: 0.7 };
