/**
 * SpecsSubject.js — the per-floor SUBJECT resolver for the SPECS pane (LibraryPane; code keeps `codex`/`library`).
 *
 * Answers what an entry-less open (tab click, Space, the swipe) has to ask: **what is the player looking at?** —
 * per floor, from live reads the hub gathers on the open edge (never per frame):
 *
 *   floor 1 (UPGRADE, the hull)  → the focused hull part's entry, else the REFIT card's manifest entry;
 *   floors 2–3 (CATCH / DEBRIS)  → the SELECTED TARGET's entry: a real catalog object is matched BY NAME to the
 *                                  `catalog_*` entries (debris carry NO codex id), an untracked piece → the
 *                                  dark-debris entry, else the MASS BAND → the tool that catches it (bands are
 *                                  Constants.TOOL_RECOMMENDATION, never a second copy of the numbers); no target →
 *                                  floor 2 reads the HUD primer, floor 3 the approach pane's own entry;
 *   floor 4 (LEO, NAVCOM)        → the FOCUSED CLUSTER's inclination-FAMILY entry (`cluster_*`, from the cluster id's
 *                                  `<family>-<altMin>` prefix — DebrisField INC_NAMES), with the ALTITUDE-BAND entry
 *                                  (`band_*`, from the `<altMin>` suffix — Constants.DEBRIS.ALT_BANDS) as the
 *                                  SECONDARY (resolveSubjectDetail); a cluster the hub reports only as a flag (or an
 *                                  unrecognised family) → the transfer physics (Hohmann), none → the
 *                                  transfer-window concept;
 *   floor 5 (GEO, SDA)           → the chart LENS: THREAT → Kessler, VALUE → the chart's own entry.
 *
 * Pure: no DOM, no EventBus, no floor names in strings (FloorContract owns those). Every input optional — an
 * unknown floor / no reads → null, and the pane's fallback (its index) stands. The tables are data; test-SpecsSubject
 * pins them.
 *
 * @module systems/SpecsSubject
 */

import { Constants } from '../core/Constants.js';

/**
 * Real-catalog NAME fragments → the codex `catalog_*` entry. Upper-case `includes` on the debris `name`
 * (CatalogConverter carries the TLE name); first match wins, so a more specific fragment sits first. Procedural
 * debris has generic names and never matches.
 */
export const CATALOG_NAMES = Object.freeze([
  ['ENVISAT', 'catalog_envisat'],
  ['VANGUARD 1', 'catalog_vanguard1'],
  ['LES-1', 'catalog_les1'],
  ['LES 1', 'catalog_les1'],
  ['COSMOS 2251', 'catalog_cosmos_iridium'],
  ['IRIDIUM 33', 'catalog_cosmos_iridium'],
  ['FENGYUN', 'catalog_fengyun1c'],
  ['KOSMOS 482', 'catalog_kosmos482'],
  ['COSMOS 482', 'catalog_kosmos482'],
  ['TELSTAR 1', 'catalog_telstar1'],
  ['SL-16', 'catalog_sl16'],
  ['ZENIT', 'catalog_sl16'],
  ['CZ-5B', 'catalog_cz5b'],
  ['KOSMOS 1408', 'catalog_kosmos1408'],
  ['COSMOS 1408', 'catalog_kosmos1408'],
]);

/** Untracked ("dark") debris → the tracking entry. */
export const DARK_ENTRY = 'trackable_vs_dark';

/**
 * Mass-band → tool entries. Bands read Constants.TOOL_RECOMMENDATION at call time: ≤ LASSO_MAX_MASS the mother's
 * net, ≤ SPINNER_MAX_MASS the small daughter, ≤ GRAPPLE_MAX_MASS the large daughter's gripper, above that the
 * tool-choice primer (nothing aboard catches it whole).
 */
export const TOOL_ENTRIES = Object.freeze({
  lasso: 'miura_ori_net',
  spinner: 'spinner_pad',
  grapple: 'weaver_gripper',
  beyond: 'tool_choice',
});

/** Per-floor defaults / lens rows (codex entry ids). */
export const FLOOR_ENTRIES = Object.freeze({
  2: Object.freeze({ idle: 'reading_the_hud' }),
  3: Object.freeze({ idle: 'pane_tactical_approach' }),
  4: Object.freeze({ cluster: 'hohmann_transfer', idle: 'pane_transfer_windows' }),
  5: Object.freeze({ THREAT: 'kessler_syndrome', VALUE: 'pane_debris_chart' }),
});

/**
 * Floor 4 — the cluster id's FAMILY prefix (DebrisField INC_NAMES `name`, the part before the last '-') → the codex
 * `cluster_*` entry. An unlisted family falls back to FLOOR_ENTRIES[4].cluster, never to `cluster_scattered`
 * (a real family with its own meaning).
 */
export const CLUSTER_FAMILIES = Object.freeze({
  canaveral: 'cluster_canaveral',
  iss: 'cluster_iss',
  russian65: 'cluster_russian65',
  russian72: 'cluster_russian72',
  russianSSO: 'cluster_russian_sso',
  sso: 'cluster_sso',
  scattered: 'cluster_scattered',
});

/**
 * Floor 4 — the cluster id's ALTITUDE-BAND suffix (Constants.DEBRIS.ALT_BANDS `min`, km) → the codex `band_*`
 * entry: the five low-orbit bands only. MEO / GEO cells have none (secondary null).
 */
export const CLUSTER_BANDS = Object.freeze({
  180: 'band_180_400',
  400: 'band_400_600',
  600: 'band_600_900',
  900: 'band_900_1200',
  1200: 'band_1200_2000',
});

/**
 * A NAVCOM cluster's inclination FAMILY (the subject) and ALTITUDE BAND (the secondary), from the DebrisField
 * cluster id `${family}-${altMin}`.
 * @param {{ id?: string }|string|null|undefined} cluster - DebrisField.getDebrisClusters shape, or its id
 * @returns {{ family: string, band: string|null }|null} null for no cluster, a junk id, or an unrecognised family
 */
export function clusterEntries(cluster) {
  const id = (typeof cluster === 'string') ? cluster
    : (cluster && typeof cluster === 'object' && typeof cluster.id === 'string') ? cluster.id : '';
  if (!id) return null;
  const dash = id.lastIndexOf('-');
  const family = CLUSTER_FAMILIES[dash < 0 ? id : id.slice(0, dash)];
  if (!family) return null;
  const alt = dash < 0 ? NaN : Number(id.slice(dash + 1));
  return { family, band: (Number.isFinite(alt) && CLUSTER_BANDS[alt]) || null };
}

/**
 * The entry a debris TARGET documents, or null for no target.
 * @param {{ name?: string, tracked?: boolean, mass?: number }|null|undefined} target - DebrisField shape (`mass` kg)
 * @returns {string|null}
 */
export function targetEntry(target) {
  if (!target || typeof target !== 'object') return null;
  const name = (typeof target.name === 'string') ? target.name.toUpperCase() : '';
  if (name) {
    for (const [frag, id] of CATALOG_NAMES) {
      if (name.includes(frag)) return id;
    }
  }
  if (target.tracked === false) return DARK_ENTRY;
  const mass = Number(target.mass);
  if (!Number.isFinite(mass)) return TOOL_ENTRIES.beyond;
  const T = (Constants && Constants.TOOL_RECOMMENDATION) || {};
  const lasso = Number.isFinite(T.LASSO_MAX_MASS) ? T.LASSO_MAX_MASS : 10;
  const spinner = Number.isFinite(T.SPINNER_MAX_MASS) ? T.SPINNER_MAX_MASS : 50;
  const grapple = Number.isFinite(T.GRAPPLE_MAX_MASS) ? T.GRAPPLE_MAX_MASS : 500;
  if (mass <= lasso) return TOOL_ENTRIES.lasso;
  if (mass <= spinner) return TOOL_ENTRIES.spinner;
  if (mass <= grapple) return TOOL_ENTRIES.grapple;
  return TOOL_ENTRIES.beyond;
}

/**
 * Resolve the SPECS subject for a floor from the hub's live reads.
 * @param {object} view
 * @param {number|null} view.floor          - FloorContract floor id (1..5)
 * @param {string|null} [view.partCodexId]  - floor 1: the focused hull part's codexId
 * @param {string|null} [view.refitCodexId] - floor 1: the REFIT card's manifest entry
 * @param {object|null} [view.target]       - floors 2–3: the active debris target
 * @param {object|string|null} [view.cluster] - floor 4: NavcomFloor.getFocusedCluster (`{ id }` or the id)
 * @param {boolean} [view.clusterFocused]   - floor 4: flag-only read of a focused cluster (→ the transfer physics)
 * @param {string|null} [view.lens]         - floor 5: the SDA chart lens ('VALUE'|'THREAT')
 * @returns {string|null} a codex entry id, or null (the pane's own fallback stands)
 */
export function resolveSubject(view) {
  if (!view || typeof view !== 'object') return null;
  const floor = view.floor;
  if (floor === 1) {
    return (typeof view.partCodexId === 'string' && view.partCodexId)
      || (typeof view.refitCodexId === 'string' && view.refitCodexId)
      || null;
  }
  if (floor === 2 || floor === 3) {
    return targetEntry(view.target) || FLOOR_ENTRIES[floor].idle;
  }
  if (floor === 4) {
    const entries = clusterEntries(view.cluster);
    if (entries) return entries.family;
    return (view.cluster || view.clusterFocused) ? FLOOR_ENTRIES[4].cluster : FLOOR_ENTRIES[4].idle;
  }
  if (floor === 5) {
    const lens = (typeof view.lens === 'string') ? view.lens.toUpperCase() : null;
    return (lens && FLOOR_ENTRIES[5][lens]) || FLOOR_ENTRIES[5].VALUE;
  }
  return null;
}

/**
 * resolveSubject plus the optional SECONDARY entry: on floor 4 with a recognised cluster, its altitude-band
 * `band_*` entry; null elsewhere. `id` is exactly resolveSubject(view).
 * @returns {{ id: string|null, secondary: string|null }}
 */
export function resolveSubjectDetail(view) {
  const id = resolveSubject(view);
  const entries = (view && typeof view === 'object' && view.floor === 4) ? clusterEntries(view.cluster) : null;
  return { id, secondary: (entries && entries.band) || null };
}

export const SpecsSubject = Object.freeze({
  CATALOG_NAMES,
  DARK_ENTRY,
  TOOL_ENTRIES,
  FLOOR_ENTRIES,
  CLUSTER_FAMILIES,
  CLUSTER_BANDS,
  targetEntry,
  clusterEntries,
  resolveSubject,
  resolveSubjectDetail,
});

export default SpecsSubject;
