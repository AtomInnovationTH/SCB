/**
 * ToolRecommender.js — pure per-arm capture-tool recommender (CP-1 / P2).
 *
 * Scores the verbs in a daughter's toolset (NET / MAGNET / GRIPPER / PAD)
 * against the active target so the STATION_KEEP tool-selection HUD can show a
 * ▶ recommendation and ★ scores, per DAUGHTER_MULTITOOL_SPEC §7.
 *
 * Design notes:
 *   • PURE + Node-safe — no THREE, no DOM, no eventBus. Fully unit-testable.
 *   • GRACEFUL DEGRADATION — when `ferromagnetic` / `hasFerrousFasteners` are
 *     absent (catalog rows pre-§6 migration), the magnet fork is simply skipped
 *     and the engine falls through to the net-first recommendation. No catalog
 *     migration is required to ship P2.
 *   • PHASE-GATED — GRIPPER (P3) and PAD (P4) are only scored when their
 *     FEATURE_FLAGS are ON, so P2 never recommends an unbuilt verb.
 *
 * @module ToolRecommender
 */

import { Constants } from '../core/Constants.js';
import { computeToolOdds, computeBestTool } from './ToolOdds.js';

/**
 * @typedef {Object} ToolRecommendation
 * @property {string}                 recommended   - top tool kind (defaults 'NET')
 * @property {string[]}               alternatives  - the arm's toolset in cycle order
 * @property {Object<string,number>}  scores        - kind → ★ score (0..3)
 * @property {Object<string,string>}  hints         - kind → short reason string
 */

/**
 * Recommend a capture tool for one daughter against one target.
 *
 * @param {Object} opts
 * @param {'weaver'|'spinner'} opts.armType            - daughter class (drives toolset + net cap)
 * @param {number}  [opts.mass=0]                      - target mass (kg)
 * @param {number}  [opts.sizeMeter=0]                 - target max width (m) — Item 4 width fork
 * @param {string}  [opts.debrisType]                  - 'rocketBody'|'defunctSat'|'fragment'|...
 * @param {boolean} [opts.ferromagnetic=false]         - pure-steel hull (direct EPM grip)
 * @param {boolean} [opts.hasFerrousFasteners=false]   - steel bolts/brackets (bolt-latch)
 * @param {boolean} [opts.hasGrappleFixture=false]      - protruding fixture for the gripper (P3)
 * @param {boolean} [opts.netDepleted=false]            - this arm's net magazine is empty
 * @returns {ToolRecommendation}
 */
export function recommendArmTool(opts = {}) {
  const armType  = opts.armType === 'spinner' ? 'spinner' : 'weaver';
  const mass     = Number.isFinite(opts.mass) ? opts.mass : 0;
  const sizeM    = Number.isFinite(opts.sizeMeter) ? opts.sizeMeter : 0;
  const dType    = opts.debrisType || null;
  const ferro    = opts.ferromagnetic === true;
  const fasten   = opts.hasFerrousFasteners === true;
  const fixture  = opts.hasGrappleFixture === true;
  const netGone  = opts.netDepleted === true;

  const TOOLSETS = Constants.DAUGHTER_TOOLSETS || {};
  const toolset  = (TOOLSETS[armType] || ['NET']).slice();

  // Per-class net mouth capacity (kg) — drives the NET self-demotion rule.
  const CN = Constants.CAPTURE_NET || {};
  const netClass = armType === 'weaver' ? CN.MEDIUM : CN.SMALL;
  const netCapKg = armType === 'weaver'
    ? (CN.MEDIUM && CN.MEDIUM.MAX_CAPTURE_MASS) || 500
    : (CN.SMALL && CN.SMALL.MAX_CAPTURE_MASS) || 50;
  const netOversize = mass > netCapKg;
  // Item 4 (2026-06-12): WIDTH fork — debris wider than the net mouth is a
  // deterministic reel-time failure (_checkNetIntegrityOnReel), so warn the
  // player BEFORE they commit: NET scores 0 and GRIPPER takes the ▶.
  const netDiaM = (netClass && netClass.DIAMETER) || 0;
  const netTooWide = netDiaM > 0 && sizeM > netDiaM;

  const MAG = Constants.MAGNETIC_GRAPPLE || {};
  const tooHeavyForMagnet = mass > ((MAG.MAX_DEBRIS_MASS_KG) || 500);
  const GRP = Constants.GRIPPER_GRAPPLE || {};
  const tooHeavyForGripper = mass > ((GRP.MAX_DEBRIS_MASS_KG) || 2000);

  const gripperOn = Constants.isFeatureEnabled('WEAVER_GRIPPER');
  const padOn     = Constants.isFeatureEnabled('SPINNER_PAD');

  /** @type {Object<string,number>} */ const scores = {};
  /** @type {Object<string,string>} */ const hints  = {};
  for (const k of toolset) { scores[k] = 0; hints[k] = ''; }

  // ── NET fork ──────────────────────────────────────────────────────────
  if ('NET' in scores) {
    if (netGone) {
      scores.NET = 0; hints.NET = 'magazine empty';
    } else if (netTooWide) {
      scores.NET = 0; hints.NET = 'too wide for net mouth';
    } else if (netOversize) {
      scores.NET = 1; hints.NET = 'class oversize — Mother only';
    } else {
      // A pure ferrous HULL is better grabbed directly by the EPM, so the net
      // self-demotes to "viable but not preferred" (magnet wins the ▶). For
      // fastener-only / non-ferrous targets the net stays primary.
      scores.NET = ferro ? 2 : 3;
      hints.NET = armType === 'weaver' ? 'Weaver LD-NET' : 'Spinner SD-NET';
    }
  }

  // ── MAGNET fork (§13 Q2 + Q4) — both classes, fastener-driven ──────────
  if ('MAGNET' in scores && (ferro || fasten) && !tooHeavyForMagnet) {
    scores.MAGNET = ferro ? 3 : 2;
    hints.MAGNET  = ferro ? 'ferrous hull — direct grip' : 'ferrous fasteners — bolt-latch';
  }

  // ── GRIPPER fork (P3, §13 Q1, flag-gated) — oversize / too-wide / awkward / fixture ──
  if ('GRIPPER' in scores && gripperOn) {
    const awkwardShape = dType === 'rocketBody' || (fixture && mass >= 50);
    if (!tooHeavyForGripper && (netOversize || netTooWide || awkwardShape)) {
      scores.GRIPPER = 3;
      hints.GRIPPER = netTooWide ? 'too wide for net — grip it'
        : netOversize ? 'oversize for net' : 'awkward shape / fixture';
    } else if (fixture) {
      scores.GRIPPER = 1; hints.GRIPPER = 'available';   // visible, not recommended
    }
  }

  // ── PAD fork (P4, flag-gated) — tiny fragments ─────────────────────────
  if ('PAD' in scores && padOn && mass <= 10 && dType === 'fragment') {
    scores.PAD = 3; hints.PAD = 'pad auto-resolves adhesion';
  }

  // ── Rank (capture-feedback overhaul Phase 1a): the ▶ is now a thin wrapper
  // over the unified ToolOdds model — argmax p with the preference-margin
  // stabiliser — so the ★ HUD, the odds strip, and the resolve rolls can never
  // disagree about which tool is the best bet. ★ scores above stay as the
  // coarse display tier; the recommendation itself comes from honest numbers.
  const odds = computeToolOdds({
    armType,
    toolset,
    target: {
      mass,
      sizeMeter: sizeM,
      type: dType,
      ferromagnetic: ferro,
      hasFerrousFasteners: fasten,
      hasGrappleFixture: fixture,
      tumbleRate: (typeof opts.tumbleRate === 'number') ? opts.tumbleRate : undefined,
      surfaceRoughness: opts.surfaceRoughness,
      material: opts.material,
    },
    range: (typeof opts.range === 'number') ? opts.range : undefined,
    netClass,
    netCount: netGone ? 0 : undefined,
  });
  const recommended = computeBestTool(odds, toolset);

  return { recommended, alternatives: toolset, scores, hints, odds };
}

export default { recommendArmTool };
