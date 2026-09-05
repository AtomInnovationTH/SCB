/**
 * SpecsSubject.js — the per-floor SUBJECT resolver for the SPECS pane
 * (Wave 5 Session J, plan D-C item 3: "SPECS on every floor — the
 * learning-friction fix").
 *
 * The SPECS drawer (LibraryPane — code keeps `codex`/`library`) used to live
 * on the workbench floor only, so an unlock earned on floor 4 meant "ride
 * down to read, ride back" — a notification turned into a chore. Session J
 * enables the pane on EVERY floor, and this module answers the one question
 * an entry-less open (tab click, Space, the swipe) has to ask: **what is the
 * player looking at?** — per floor, from live reads the hub gathers on the
 * open edge (never per frame):
 *
 *   floor 1 (UPGRADE, the hull)  → the focused hull part's entry, else the
 *                                  REFIT card's manifest entry (as shipped
 *                                  since Session C — unchanged);
 *   floors 2–3 (CATCH / DEBRIS)  → the SELECTED TARGET's entry: a real
 *                                  catalog object is matched BY NAME to the
 *                                  ten `catalog_*` entries (debris carry NO
 *                                  codex id — survey finding), an untracked
 *                                  piece → the dark-debris entry, else the
 *                                  MASS BAND → the tool that catches it (the
 *                                  "net-rule" entry; the bands are
 *                                  Constants.TOOL_RECOMMENDATION, never a
 *                                  second copy of the numbers); no target →
 *                                  floor 2 reads the HUD primer, floor 3 the
 *                                  approach pane's own entry;
 *   floor 4 (LEO, NAVCOM)        → a focused cluster → the transfer physics
 *                                  (Hohmann), else the transfer-window
 *                                  concept (no per-cluster entries exist —
 *                                  03-plan Session J FINDINGS);
 *   floor 5 (GEO, SDA)           → the chart LENS: THREAT → Kessler, VALUE
 *                                  → the chart's own entry.
 *
 * Pure: no DOM, no EventBus, no floor names in strings (FloorContract owns
 * those). Every input optional — an unknown floor / no reads → null, and the
 * pane's shipped fallback (its index) stands. The tables are data: the owner
 * retunes an id here and the pin in test-SpecsSubject follows.
 *
 * @module systems/SpecsSubject
 */

import { Constants } from '../core/Constants.js';

/**
 * Real-catalog NAME fragments → the codex `catalog_*` entry. Upper-case
 * `includes` on the debris `name` (CatalogConverter carries the TLE name);
 * first match wins, so the more specific fragment sits first where two could
 * overlap. Procedural debris has generic names and never matches.
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

/** Untracked ("dark") debris → the tracking entry (what the HEAT CAM sees). */
export const DARK_ENTRY = 'trackable_vs_dark';

/**
 * The mass-band → tool entries ("which net catches this?"). Bands read
 * Constants.TOOL_RECOMMENDATION at call time: ≤ LASSO_MAX_MASS the mother's
 * net, ≤ SPINNER_MAX_MASS the small daughter, ≤ GRAPPLE_MAX_MASS the large
 * daughter's gripper, above that the tool-choice primer (nothing aboard
 * catches it whole).
 */
export const TOOL_ENTRIES = Object.freeze({
  lasso: 'miura_ori_net',
  spinner: 'spinner_pad',
  grapple: 'weaver_gripper',
  beyond: 'tool_choice',
});

/** Per-floor defaults / lens rows (ids are codex entry ids, never names). */
export const FLOOR_ENTRIES = Object.freeze({
  2: Object.freeze({ idle: 'reading_the_hud' }),
  3: Object.freeze({ idle: 'pane_tactical_approach' }),
  4: Object.freeze({ cluster: 'hohmann_transfer', idle: 'pane_transfer_windows' }),
  5: Object.freeze({ THREAT: 'kessler_syndrome', VALUE: 'pane_debris_chart' }),
});

/**
 * The entry a debris TARGET documents, or null for no target.
 * @param {{ name?: string, tracked?: boolean, mass?: number }|null|undefined} target
 *   the TargetSelector's active debris (DebrisField shape: `name`, `tracked`,
 *   `mass` kg)
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
 * @param {boolean} [view.clusterFocused]   - floor 4: a NAVCOM cluster is focused
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
    return view.clusterFocused ? FLOOR_ENTRIES[4].cluster : FLOOR_ENTRIES[4].idle;
  }
  if (floor === 5) {
    const lens = (typeof view.lens === 'string') ? view.lens.toUpperCase() : null;
    return (lens && FLOOR_ENTRIES[5][lens]) || FLOOR_ENTRIES[5].VALUE;
  }
  return null;
}

export const SpecsSubject = Object.freeze({
  CATALOG_NAMES,
  DARK_ENTRY,
  TOOL_ENTRIES,
  FLOOR_ENTRIES,
  targetEntry,
  resolveSubject,
});

export default SpecsSubject;
