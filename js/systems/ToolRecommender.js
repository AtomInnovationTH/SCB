/**
 * ToolRecommender.js — pure per-arm capture-tool recommender: scores the verbs in a daughter's toolset
 * (NET / MAGNET / GRIPPER / PAD) against the active target so the STATION_KEEP tool-selection HUD can show a ▶
 * recommendation and star scores (archive/DAUGHTER_MULTITOOL_SPEC.md §7).
 *
 *   • PURE + Node-safe: no THREE, no DOM, no eventBus.
 *   • Graceful degradation: when `ferromagnetic` is absent the magnet fork is skipped and the
 *     net-first recommendation stands.
 *   • Phase-gated: GRIPPER and PAD are only scored when their FEATURE_FLAGS are ON, so an unbuilt verb is never
 *     recommended.
 *
 * @module ToolRecommender
 */

import { Constants } from '../core/Constants.js';
import { computeToolOdds, computeBestTool } from './ToolOdds.js';

/**
 * @typedef {Object} ToolRecommendation
 * @property {string}                 recommended   - top tool kind (defaults 'NET')
 * @property {string[]}               alternatives  - the arm's toolset in cycle order
 * @property {Object<string,number>}  scores        - kind → star score (0..3)
 * @property {Object<string,string>}  hints         - kind → short reason string
 */

/**
 * Recommend a capture tool for one daughter against one target.
 *
 * @param {Object} opts
 * @param {'weaver'|'spinner'} opts.armType            - daughter class (drives toolset + net cap)
 * @param {number}  [opts.mass=0]                      - target mass (kg)
 * @param {number}  [opts.sizeMeter=0]                 - target max width (m)
 * @param {string}  [opts.debrisType]                  - 'rocketBody'|'defunctSat'|'fragment'|...
 * @param {boolean} [opts.ferromagnetic=false]         - pure-steel hull (direct EPM grip; the magnet takes steel only)
 * @param {boolean} [opts.hasGrappleFixture=false]      - protruding fixture for the gripper (P3)
 * @param {boolean} [opts.netDepleted=false]            - this arm's net magazine is empty
 * @param {number}  [opts.coldGasKg]                    - her cold gas now (kg); a tool whose spin her gas cannot stop scores 0 (absent = no check)
 * @param {number}  [opts.trueTumbleRate]               - the piece's own spin (rad/s) when `tumbleRate` is the relative one
 * @returns {ToolRecommendation}
 */
export function recommendArmTool(opts = {}) {
  const armType  = opts.armType === 'spinner' ? 'spinner' : 'weaver';
  const mass     = Number.isFinite(opts.mass) ? opts.mass : 0;
  const sizeM    = Number.isFinite(opts.sizeMeter) ? opts.sizeMeter : 0;
  const dType    = opts.debrisType || null;
  const ferro    = opts.ferromagnetic === true;
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
  // WIDTH fork: debris wider than the net mouth is a deterministic reel-time failure (_checkNetIntegrityOnReel), so
  // warn BEFORE the player commits: NET scores 0 and GRIPPER takes the ▶.
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

  if ('NET' in scores) {
    if (netGone) {
      scores.NET = 0; hints.NET = 'magazine empty';
    } else if (netTooWide) {
      scores.NET = 0; hints.NET = 'too wide for net mouth';
    } else if (netOversize) {
      // Net ladder: separate "wrong daughter for this catch" from a true whale. Above the Large Daughter ceiling (WEAVER
      // cap, 500 kg) only the Mother's Large Net holds it; between this arm's cap and 500 kg a bigger Daughter can. The
      // hint routes the player to the right platform.
      const whaleCap = (CN.MEDIUM && CN.MEDIUM.MAX_CAPTURE_MASS) || 500;
      scores.NET = 1;
      // Over the mother's own catch limit nothing catches it: inspect it (within 10 m)
      const limit = (CN.LARGE && CN.LARGE.CATCH_LIMIT_KG) || 0;
      hints.NET = limit > 0 && mass > limit
        ? 'Too big to catch: inspect it (within 10 m)'
        : mass > whaleCap
        ? 'whale — Mother\'s Large Net only'
        : (armType === 'spinner' ? 'too big — send a Large Daughter' : 'oversize for this net');
    } else {
      // A pure ferrous HULL is better grabbed directly by the EPM, so the net self-demotes to "viable but not
      // preferred" (magnet wins the ▶); non-ferrous targets keep the net primary.
      scores.NET = ferro ? 2 : 3;
      hints.NET = armType === 'weaver' ? 'Large LD-NET' : 'Small SD-NET';
    }
  }

  // MAGNET fork (§13 Q2, DECISIONS §111 row 1): both classes, steel hull only
  if ('MAGNET' in scores && ferro && !tooHeavyForMagnet) {
    scores.MAGNET = 3;
    hints.MAGNET  = 'ferrous hull. Direct grip';
  }

  // GRIPPER fork (§13 Q1, flag-gated): oversize / too-wide / awkward / fixture
  if ('GRIPPER' in scores && gripperOn) {
    const awkwardShape = dType === 'rocketBody' || (fixture && mass >= 50);
    if (!tooHeavyForGripper && (netOversize || netTooWide || awkwardShape)) {
      scores.GRIPPER = 3;
      hints.GRIPPER = netTooWide ? 'too wide for net. Grip it'
        : netOversize ? 'oversize for net' : 'awkward shape / fixture';
    } else if (fixture) {
      scores.GRIPPER = 1; hints.GRIPPER = 'available';   // visible, not recommended
    }
  }

  // PAD fork (flag-gated): tiny fragments
  if ('PAD' in scores && padOn && mass <= 10 && dType === 'fragment') {
    scores.PAD = 3; hints.PAD = 'pad auto-resolves adhesion';
  }

  // Rank: the ▶ is a thin wrapper over the unified ToolOdds model (argmax p with the preference-margin
  // stabiliser), so the star HUD, the odds strip and the resolve rolls can never disagree about the best bet. Star
  // scores above stay the coarse display tier.
  const odds = computeToolOdds({
    armType,
    toolset,
    target: {
      mass,
      sizeMeter: sizeM,
      type: dType,
      ferromagnetic: ferro,
      hasGrappleFixture: fixture,
      tumbleRate: (typeof opts.tumbleRate === 'number') ? opts.tumbleRate : undefined,
      // her gas pays the piece's TRUE spin even while she circles it in step (the stub's tumbleRate is the relative spin)
      trueTumbleRate: (typeof opts.trueTumbleRate === 'number') ? opts.trueTumbleRate : undefined,
      surfaceRoughness: opts.surfaceRoughness,
      material: opts.material,
    },
    range: (typeof opts.range === 'number') ? opts.range : undefined,
    netClass,
    netCount: netGone ? 0 : undefined,
    coldGasKg: (typeof opts.coldGasKg === 'number') ? opts.coldGasKg : undefined,
  });
  let recommended = computeBestTool(odds, toolset);

  // DECISIONS §33 row 2: the small daughter uses her pad by herself "on panels and foil": PAD is in her toolset, the pad is
  // on, the piece is within her rating (SPINNER_MAX_CAPTURE_MASS) and the surface is a panel (gecko adhesion: aluminium,
  // solar cells; odds.PAD.mode, the pure ToolOdds mirror of ArmUnit._resolvePadMode) or foil (mli_mylar, now a 70 %
  // static-charge grip, DECISIONS §111 row 3). A refused pad (her gas cannot stop the spin) has mode null and is never
  // picked. Otherwise the odds pick stands. The tool cycle (backtick) still lets the player change it.
  const padMode = odds.PAD ? odds.PAD.mode : null;
  const foil = opts.material === 'mli_mylar' && padMode === 'electrostatic';
  if ('PAD' in scores && padOn && mass <= (Constants.SPINNER_MAX_CAPTURE_MASS ?? 50)
      && (padMode === 'gecko' || foil)) {
    scores.PAD = 3; hints.PAD = `${padMode} pad. Stick it on`;
    recommended = 'PAD';
  }

  return { recommended, alternatives: toolset, scores, hints, odds };
}

export default { recommendArmTool };
