/**
 * ShopScreen.js — Upgrade shop between missions + cargo selling + elevator contract
 * @module ui/ShopScreen
 */

import { Constants, trlToBadgeColor, trlToTechLevelLabel, techLevelBadgeText } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { scoringSystem, computeContributionPayout } from '../systems/ScoringSystem.js';
import { decorateGlossary } from '../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { upgradePrereqsMet } from './shopGating.js';
import {
  getAvailableTiers,
  getCurrentTier,
  getUpgradePath,
  canUpgrade,
  executeUpgrade,
  buildGameState,
  getEffectiveTRL,
} from '../systems/ArmTierCatalog.js';

/**
 * Upgrade definitions — 32 items across 8 categories, all wired to live systems.
 * ST-6.6: Each upgrade carries a `trl` (NASA TRL 1-9) and optional `trlRationale`
 * for colour-coded badge display. TRL is display-only — NEVER used in gating.
 * Exported for Node.js test harness (test-TRL.js integrity check).
 */
export const UPGRADES = [
  // Propulsion (6)
  { id: 'efficient_ion', cat: 'Propulsion', name: 'Efficient Ion Drive', cost: 500,
    desc: '-20% xenon consumption', effect: 'xenonEfficiency', value: 0.8, maxLevel: 1,
    trl: 9, trlRationale: 'Xenon ion drives flown since Deep Space 1 (1998)' },
  { id: 'high_thrust_ion', cat: 'Propulsion', name: 'High-Thrust Ion', cost: 800,
    desc: '+50% thrust power', effect: 'thrustMultiplier', value: 1.5, maxLevel: 1,
    trl: 8, trlRationale: 'High-power Hall thrusters flown on Starlink, AEHF; kW-class ion still maturing' },
  { id: 'extra_xenon', cat: 'Propulsion', name: 'Extra Xenon Tank', cost: 600,
    desc: '+50 max xenon', effect: 'xenonMax', value: 50, maxLevel: 2,
    trl: 9, trlRationale: 'COPV xenon tanks flight-proven since 1990s' },
  { id: 'extra_coldgas', cat: 'Propulsion', name: 'Extra Cold Gas', cost: 400,
    desc: '+10 max cold gas', effect: 'coldGasMax', value: 10, maxLevel: 2,
    trl: 9, trlRationale: 'Cold gas tanks ubiquitous since 1960s' },
  { id: 'mpd_thruster', cat: 'Propulsion', name: 'MPD Thruster', cost: 3000,
    desc: 'Magnetoplasmadynamic drive. Runs passively alongside the ion engine for +50% primary thrust — cuts long transfer burns like the GEO climb. Draws on lithium reserves and heavy power.',
    effect: 'mpdThruster', value: true, maxLevel: 1,
    requiresAll: ['solid_state_battery', 'multi_junction_solar'],
    trl: 4, trlRationale: 'Lab-tested at NASA Glenn & JAXA; no kW-class flight heritage' },
  { id: 'hardened_cathode', cat: 'Propulsion', name: 'Hardened Cathode', cost: 1500,
    desc: 'Tungsten-rhenium cathode. Doubles MPD thruster lifetime to 1,200s.',
    effect: 'mpdCathodeLife', value: 1200, maxLevel: 1,
    requiresAll: ['mpd_thruster'],
    trl: 5, trlRationale: 'Tungsten-rhenium cathodes tested in vacuum chambers; on-orbit erosion unverified' },

  // Power (8) — includes S3b MPD infrastructure chain
  { id: 'efficient_panels', cat: 'Power', name: 'Efficient Panels', cost: 500,
    desc: '+30% solar efficiency', effect: 'solarEfficiency', value: 1.3, maxLevel: 1,
    trl: 9, trlRationale: 'Triple-junction GaAs standard on every modern satellite' },
  { id: 'extra_battery', cat: 'Power', name: 'Extra Battery', cost: 400,
    desc: '+50 max battery', effect: 'batteryMax', value: 50, maxLevel: 2,
    trl: 9, trlRationale: 'Space-grade Li-ion flown since 1990s' },
  { id: 'rad_hard_panels', cat: 'Power', name: 'Rad-Hard Panels', cost: 700,
    desc: '-50% panel degradation', effect: 'panelDegradation', value: 0.5, maxLevel: 1,
    trl: 9, trlRationale: 'Rad-hard cover glass + coverslips used on GEO sats for decades' },

  // S3b: Power infrastructure chain for MPD Ludicrous Mode
  { id: 'multi_junction_solar', cat: 'Power', name: 'Multi-Junction Solar', cost: 1200,
    desc: 'GaInP/GaAs/Ge triple-junction. +100% solar efficiency.',
    effect: 'solarEfficiency', value: 2.0, maxLevel: 1,
    requiresAll: ['efficient_panels'],
    trl: 9, trlRationale: 'Triple-junction GaAs on every GEO satellite and Mars rover' },
  { id: 'solid_state_battery', cat: 'Power', name: 'Solid-State Battery', cost: 1500,
    desc: 'Ceramic electrolyte. +150 Wh capacity. No fire risk.',
    effect: 'batteryMax', value: 150, maxLevel: 1,
    requiresAll: ['extra_battery'],
    trl: 5, trlRationale: 'QuantumScape & Toyota prototypes emerging; not yet space-qualified' },
  { id: 'graphene_supercap', cat: 'Power', name: 'Graphene Supercapacitor', cost: 2500,
    desc: 'HBN-dielectric graphene. +100 Wh burst. Faster MPD cooling.',
    effect: 'supercapUpgrade', value: 100, maxLevel: 1,
    requiresAll: ['solid_state_battery'],
    trl: 3, trlRationale: 'Graphene-HBN supercaps demonstrated in lab; no flight heritage' },
  { id: 'rtg_module', cat: 'Power', name: 'RTG Module', cost: 3500,
    desc: 'Pu-238 radioisotope. +2 kW constant. Even in eclipse.',
    effect: 'rtgPower', value: 2.0, maxLevel: 1,
    requiresAll: ['multi_junction_solar'],
    trl: 9, trlRationale: 'RTGs flown since SNAP-3 (1961); MMRTG on Curiosity, Perseverance' },
  { id: 'power_beaming', cat: 'Power', name: 'Power Beaming Receiver', cost: 2000,
    desc: 'Rectenna array. +5 kW during ground station passes.',
    effect: 'powerBeaming', value: 5.0, maxLevel: 1,
    requiresAll: ['multi_junction_solar'],
    trl: 5, trlRationale: 'JAXA (2015) demonstrated 1.8 kW over 55 m ground-to-ground; no orbital link yet' },

  // Sensors (4)
  { id: 'enhanced_eo', cat: 'Sensors', name: 'Enhanced EO', cost: 500,
    desc: '+50% detection range', effect: 'sensorRange', value: 1.5, maxLevel: 1,
    trl: 9, trlRationale: 'Electro-optical telescopes flown on every imaging sat' },
  { id: 'ir_scanner', cat: 'Sensors', name: 'IR Scanner', cost: 600,
    desc: 'Detect untracked debris', effect: 'detectUntracked', value: true, maxLevel: 1,
    trl: 8, trlRationale: 'IR debris tracking (SBV, WISE) demonstrated; ADR-specific arrays still maturing' },
  { id: 'advanced_lidar', cat: 'Sensors', name: 'Advanced LIDAR', cost: 800,
    desc: '+100% scan range', effect: 'scanRange', value: 2.0, maxLevel: 1,
    trl: 9, trlRationale: 'Flash LIDAR flown on Dragon, Cygnus since 2012' },
  { id: 'salvage_scanner', cat: 'Sensors', name: 'Salvage Scanner', cost: 700,
    desc: 'Reveal salvage contents at range', effect: 'salvageScan', value: true, maxLevel: 1,
    trl: 4, trlRationale: 'Remote spectral composition analysis demonstrated on lab targets; no ADR heritage' },

  // Arms (6) — replaces deleted Capture category (laser, ion beam, magnetic, harpoon, net)
  { id: 'long_tether', cat: 'Daughters', name: 'Extended Tether', cost: 600,
    desc: '2× tether range', effect: 'tetherRange', value: 2.0, maxLevel: 1,
    trl: 3, trlRationale: 'Multi-km daughter-mounted tether is game-speculative; RemoveDEBRIS tether was passive' },
  { id: 'fast_reel', cat: 'Daughters', name: 'Fast Reel Motor', cost: 500,
    desc: '+50% reel speed', effect: 'reelSpeed', value: 1.5, maxLevel: 1,
    trl: 4, trlRationale: 'Motorised space reels demonstrated on SFU (1995), not yet for capture ops' },
  { id: 'arm_fuel', cat: 'Daughters', name: 'Daughter Fuel Reserve', cost: 700,
    desc: '+50% daughter FEEP fuel', effect: 'armFuelMax', value: 1.5, maxLevel: 1,
    trl: 7, trlRationale: 'FEEP thrusters flown on Gaia, LISA Pathfinder; miniaturised variants emerging' },
  { id: 'capture_net', cat: 'Daughters', name: 'Reinforced Nets', cost: 800,
    desc: '+20% capture success', effect: 'captureRate', value: 0.2, maxLevel: 1,
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  // Net ladder Phase B: consumable Mother Large Net restock. Repeatable (no
  // maxLevel gate — see _purchaseUpgrade consumable branch). Each buy loads one
  // net (250 cr) into the emptiest pod, up to 2 pods × 2. Whale-hunt magazine
  // only; no in-mission resupply. Gated by CAPTURE_NET (filtered at render).
  { id: 'mother_net_restock', cat: 'Daughters', name: 'Mother Large Net (restock)',
    cost: Constants.CAPTURE_NET.LARGE.REPLACEMENT_COST,
    desc: 'Load one Large Net into a Mother pod (whale hunts). Buy up to 2 pods × 2.',
    effect: 'motherNetRestock', value: 1, maxLevel: Infinity, consumable: true,
    requiresFeature: 'CAPTURE_NET',
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  { id: 'hazmat_handler', cat: 'Daughters', name: 'Hazmat Handler', cost: 1200,
    desc: 'Recover hydrazine → cold gas', effect: 'hazmatRecovery', value: true, maxLevel: 1,
    trl: 2, trlRationale: 'On-orbit hazmat recovery from derelicts is fully speculative' },
  { id: 'refinery_arm', cat: 'Daughters', name: 'Micro-Refinery', cost: 1500,
    desc: '+50% salvage yield', effect: 'refineryEfficiency', value: 1.5, maxLevel: 1,
    trl: 2, trlRationale: 'Orbital micro-refinery is game-speculative; no on-orbit metal processing' },

  // Automation (1)
  { id: 'kessler_warning', cat: 'Automation', name: 'Kessler Warning', cost: 500,
    desc: 'Brittleness warnings', effect: 'kesslerWarning', value: true, maxLevel: 1,
    trl: 7, trlRationale: 'LeoLabs, ExoAnalytic provide real collision-risk alerts; onboard analysis still maturing' },

  // Hull (2) — replaces deleted GNC automation items
  { id: 'whipple_shield', cat: 'Hull', name: 'Whipple Shield', cost: 1000,
    desc: 'Survive 1 fragment hit', effect: 'shieldHits', value: 1, maxLevel: 1,
    trl: 9, trlRationale: 'Whipple shields flown on ISS and every crewed spacecraft since 1970s' },
  { id: 'auto_dock', cat: 'Hull', name: 'Auto-Dock Assist', cost: 600,
    desc: 'Faster daughter docking', effect: 'autoDock', value: 0.5, maxLevel: 1,
    trl: 8, trlRationale: 'Auto-docking flown on Progress, Dragon-2; ADR-specific autonomy still emerging' },

  // Graphene (3) — V4 GSL upgrade path (Sprint D5)
  { id: 'gsl_tether_v4', cat: 'Graphene', name: 'GSL Tether v4', cost: 3000,
    desc: 'Graphene tether extends reach to 12.5km', effect: 'v4TetherRange',
    value: Constants.V4_TETHER_LENGTH_MULT, maxLevel: 1,
    trl: 2, trlRationale: 'Graphene Super Laminate. Paper-stage; HBN-coated Dyneema arriving 2026' },
  { id: 'gsl_net_v4', cat: 'Graphene', name: 'GSL Net v4', cost: 3500,
    desc: '10× capture net area', effect: 'v4NetArea',
    value: Math.sqrt(Constants.V4_NET_SIZE_MULT), maxLevel: 1,
    trl: 2, trlRationale: 'Graphene-reinforced capture net. Speculative; no space heritage' },
  { id: 'gsl_electrostatic_v4', cat: 'Graphene', name: 'GSL Electrostatic v4', cost: 4000,
    desc: '160N electrostatic grip. 5× capture mass', effect: 'v4GripForce',
    value: 5.0, maxLevel: 1,
    trl: 3, trlRationale: 'Electrostatic capture demonstrated on CubeSats; 160N force is game-speculative' },

  // Cargo (2) — E2 elevator-throughput fix. The hold caps how much refined
  // salvage each depot run can deliver to the space-elevator contract. Absolute
  // capacity targets live in Constants (SSOT); the effect value is the target kg.
  // Prices are a Phase-4 balance concern (tuned against catalog total).
  { id: 'cargo_bay_2', cat: 'Cargo', name: 'Cargo Bay II', cost: 1800,
    desc: 'Expanded hold: +1,000 kg (500 → 1,500). More salvage per depot run.',
    effect: 'cargoCapacity', value: Constants.CARGO_BAY_TIER2_KG, maxLevel: 1,
    trl: 6, trlRationale: 'Deployable/expandable cargo modules (BEAM, Cygnus) have flight heritage' },
  { id: 'cargo_bay_3', cat: 'Cargo', name: 'Cargo Bay III', cost: 3600,
    desc: 'Whale-class hold: +1,500 kg (1,500 → 3,000). Sized for rocket-body salvage.',
    effect: 'cargoCapacity', value: Constants.CARGO_BAY_TIER3_KG, maxLevel: 1,
    requiresAll: ['cargo_bay_2'],
    trl: 4, trlRationale: 'Large pressurised cargo volumes demonstrated; 3 t ADR hold is game-speculative' },
];

/**
 * Recommended-starter highlight (early-shop tension plan). Ordered preference;
 * the shop ⭐-marks the first item here that is (a) un-owned and (b) affordable.
 * The badge persists on early visits until the player owns ANY starter, then
 * fades. Cosmetic only — buying still flows through _purchaseUpgrade.
 * Falls back to Constants.SHOP.RECOMMENDED_STARTERS so tuning lives in one place.
 */
export const STARTER_PREFERENCE =
  (Constants.SHOP && Constants.SHOP.RECOMMENDED_STARTERS)
  || ['capture_net', 'fast_reel', 'enhanced_eo', 'efficient_ion'];

/** One-line "why" per starter, shown next to the ⭐ badge. */
const STARTER_WHY = {
  capture_net:  'Miss fewer catches',
  fast_reel:    'Reel in faster, retry sooner',
  enhanced_eo:  'Spot debris from farther out',
  efficient_ion:'Stretch every drop of xenon',
};

/**
 * Pick the recommended starter id: the first preference that is BOTH un-owned
 * and affordable at the given credits. Returns null when none qualify or when
 * the player already owns any starter (the ⭐ has served its purpose).
 * Pure — exported for tests.
 * @param {Array<{id:string,cost:number}>} upgrades — upgrade catalog
 * @param {Map<string,number>|Set<string>|Iterable} owned — owned upgrade ids
 * @param {number} credits — current spendable credits
 * @param {string[]} [preference] — ordered preference list
 * @returns {string|null}
 */
export function recommendedStarter(upgrades, owned, credits, preference = STARTER_PREFERENCE) {
  const ownsId = (id) => {
    if (!owned) return false;
    if (owned instanceof Map || owned instanceof Set) return owned.has(id);
    if (typeof owned.has === 'function') return owned.has(id);
    if (Array.isArray(owned)) return owned.includes(id);
    return false;
  };
  // Once the player owns any starter, the highlight fades entirely.
  if (preference.some(ownsId)) return null;
  const byId = new Map((upgrades || []).map(u => [u.id, u]));
  for (const id of preference) {
    const u = byId.get(id);
    if (!u) continue;
    if (ownsId(id)) continue;
    if (credits >= u.cost) return id;
  }
  return null;
}

// S1 retention: pinned "next upgrade" chase-target math lives in the pure
// ./shopPin.js module (shared with the HUD, DOM-free). Re-exported here so the
// existing `../ui/ShopScreen.js` import sites (and tests) keep working.
export { pinProgress, cheapestChaseTarget } from './shopPin.js';

/** Spring tier descriptions for shop display */
const SPRING_DESCRIPTIONS = [
  "Factory steel springs. Reliable but slow.",
  "Maraging steel. Premium alloy, higher energy storage.",
  "Composite laminate springs with carbon fiber reinforcement.",
  "Nanolaminate metamaterial with programmable stiffness.",
  "Metamaterial quantum lattice. Maximum energy density.",
];

/** Tether tier descriptions for shop display */
const TETHER_DESCRIPTIONS = [
  "Ultra-high molecular weight polyethylene. Industry standard.",
  "PBO fiber. High modulus, UV sensitive. Handle with care.",
  "Carbon nanotube yarn. Aerospace grade.",
  "Graphene Superlattice 50 GPa. First-gen GSL technology.",
  "Graphene Superlattice 100 GPa. Carries power, data, and steering.",
];

export class ShopScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this.purchasedUpgrades = new Map(); // upgradeId → level
    // S1 retention (2026-07-23): the pinned "next upgrade" chase target (id or
    // null). Persisted via the serialized-upgrade array (sentinel). Drives the
    // pinned-next-upgrade HUD widget between depots.
    this.pinnedUpgradeId = null;
    this._lastPurchasedId = null; // for flash animation
    this._springTier = 0;  // Current spring tier index (0 = T1 starter)
    this._tetherTier = 0;  // Current tether tier index (0 = T1 starter)
    // True only while showing the player's first depot visit (set from the
    // GAME_STATE_CHANGE payload). Drives the one-time first-visit framing + ⭐.
    this._firstDepotVisit = false;

    // Phase 5: system references for cargo selling
    this._cargoSystem = null;
    this._scoringSystem = null;
    this._contractMassKg = 0;

    // C-10: arm tier upgrade references
    this._armManager = null;
    this._launchSequence = null;
    this._persistenceManager = null;

    this._injectStyles();
    this._build();

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to, firstDepotVisit }) => {
      if (to === GameStates.SHOP) {
        // GameFlowManager persists FIRST_DEPOT_VISITED before this event fires,
        // so the flag would already read true here. It passes the pre-write
        // signal through the payload instead — capture it for refresh() to use.
        this._firstDepotVisit = !!firstDepotVisit;
        this.show();
      } else {
        this._firstDepotVisit = false;
        this.hide();
      }
    });
  }

  // ========================================================================
  // Phase 5: System Setters & Contract State
  // ========================================================================

  /** Set CargoSystem reference for cargo manifest access. */
  setCargoSystem(cs) { this._cargoSystem = cs; }

  /** Set ScoringSystem reference for addCredits. */
  setScoringSystem(ss) { this._scoringSystem = ss; }

  /** Set contract mass (from save restore). */
  setContractMass(kg) { this._contractMassKg = kg || 0; }

  /** Get contract mass (for save serialization). */
  getContractMass() { return this._contractMassKg || 0; }

  // C-10: Arm tier upgrade setters
  /** Set ArmManager reference for tier upgrades. */
  setArmManager(am) { this._armManager = am; }

  /** Set LaunchSequence reference for tier upgrade gating. */
  setLaunchSequence(ls) { this._launchSequence = ls; }

  /** Set PersistenceManager reference for tier upgrades. */
  setPersistenceManager(pm) { this._persistenceManager = pm; }

  // ========================================================================
  // STYLES
  // ========================================================================

  /** @private Inject CSS for purchase flash animation */
  _injectStyles() {
    if (document.getElementById('shop-flash-style')) return;
    const style = document.createElement('style');
    style.id = 'shop-flash-style';
    style.textContent = `
      @keyframes shop-purchase-flash {
        0%   { background: rgba(0,255,136,0.35); box-shadow: 0 0 20px rgba(0,255,136,0.4); }
        50%  { background: rgba(0,255,136,0.15); box-shadow: 0 0 10px rgba(0,255,136,0.2); }
        100% { background: rgba(0,20,40,0.5); box-shadow: none; }
      }
      .shop-card-flash {
        animation: shop-purchase-flash 0.8s ease-out !important;
      }
      .shop-buy-btn:hover,
      .shop-tier-buy-btn:hover {
        filter: brightness(1.3);
      }
    `;
    document.head.appendChild(style);
  }

  // ========================================================================
  // BUILD DOM
  // ========================================================================

  /** @private */
  _build() {
    this.element = document.createElement('div');
    this.element.id = 'shop-screen';
    this.element.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: rgba(0,5,15,0.92); z-index: 50; pointer-events: auto;
      transition: opacity 0.3s;
    `;

    this.element.innerHTML = `
      <div style="max-width:800px;width:95%;max-height:90vh;overflow-y:auto;padding:20px;">
        <div style="text-align:center;margin-bottom:1.5rem;">
          <h2 style="font-size:1.4rem;color:#00ff88;letter-spacing:0.15em;
                      text-shadow:0 0 15px rgba(0,255,136,0.4);">
            ORBITAL SUPPLY DEPOT
          </h2>
          <div style="font-size:0.95rem;color:rgba(0,255,136,0.6);margin-top:6px;">
            💰 Credits: <b id="shop-credits" style="color:#f0c040;font-size:1.1rem;">0</b>
            <span style="font-size:0.7rem;color:rgba(0,255,136,0.35);margin-left:12px;">
              Upgrades owned: <b id="shop-upgrade-count" style="color:rgba(0,255,136,0.6);">0</b>
            </span>
          </div>
          <div id="shop-firstvisit-note" style="display:none;font-size:0.78rem;
                color:rgba(240,192,64,0.85);margin-top:8px;max-width:560px;
                margin-left:auto;margin-right:auto;line-height:1.35;">
            Credits are your refit budget — gear that pays for itself. Pick one upgrade that fits your run.
          </div>
        </div>

        <div id="shop-categories"></div>

        <div id="shop-cargo-anchor"></div>

        <div style="text-align:center;margin-top:1.5rem;">
          <button id="shop-deploy-btn" style="
            font-family:'Courier New',monospace; font-size:1rem; color:#00ff88;
            background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.4);
            padding: 10px 40px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.15em; transition: all 0.3s;
          ">DEPLOY</button>
        </div>
      </div>
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Deploy button
    const deployBtn = this.element.querySelector('#shop-deploy-btn');
    deployBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.SHOP_DEPLOY);
    });
    deployBtn.addEventListener('mouseenter', () => {
      deployBtn.style.background = 'rgba(0,255,136,0.25)';
      deployBtn.style.boxShadow = '0 0 15px rgba(0,255,136,0.3)';
    });
    deployBtn.addEventListener('mouseleave', () => {
      deployBtn.style.background = 'rgba(0,255,136,0.1)';
      deployBtn.style.boxShadow = 'none';
    });

    // Build and append cargo section
    const cargoSection = this._buildCargoSection();
    const anchor = this.element.querySelector('#shop-cargo-anchor');
    if (anchor) anchor.appendChild(cargoSection);
  }

  // ========================================================================
  // CARGO SECTION (Phase 5)
  // ========================================================================

  /** @private Build the cargo bay + elevator contract UI section */
  _buildCargoSection() {
    const section = document.createElement('div');
    section.id = 'shop-cargo-section';
    Object.assign(section.style, {
      marginTop: '20px',
      padding: '15px',
      background: 'rgba(0,0,0,0.6)',
      border: '1px solid #555',
      borderRadius: '8px',
    });

    section.innerHTML = `
      <h3 style="color:#ff9800;margin:0 0 10px 0;font-size:14px">📦 CARGO BAY</h3>
      <div id="cargo-manifest" style="max-height:200px;overflow-y:auto"></div>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
        <button id="sell-all-cargo-btn" style="
          padding:8px 16px;background:#ff9800;color:#000;border:none;
          border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;
        ">Sell All Cargo</button>
        <span id="cargo-total-value" style="color:#4f4;font-size:12px"></span>
      </div>
      <div style="margin-top:15px;border-top:1px solid #444;padding-top:10px">
        <h4 style="color:#81c784;margin:0 0 8px 0;font-size:12px">
          🏗️ SPACE ELEVATOR CONTRACT
        </h4>
        <div id="elevator-progress-section"></div>
      </div>
    `;

    return section;
  }

  /** @private Refresh the cargo manifest, sell buttons, and elevator progress */
  _refreshCargoManifest() {
    const manifestEl = document.getElementById('cargo-manifest');
    const totalEl = document.getElementById('cargo-total-value');
    const sellBtn = document.getElementById('sell-all-cargo-btn');
    const elevatorSection = document.getElementById('elevator-progress-section');

    if (!manifestEl) return;

    // Get cargo from CargoSystem
    const cargoStatus = this._cargoSystem ? this._cargoSystem.getStatus() : null;

    if (!cargoStatus || cargoStatus.manifest.length === 0) {
      manifestEl.innerHTML = '<div style="color:#666;font-style:italic">Cargo hold empty</div>';
      if (totalEl) totalEl.textContent = '';
      if (sellBtn) sellBtn.disabled = true;
    } else {
      let html = '';
      const sellMod = (Constants.MARKET && Constants.MARKET.SELL_PRICE_MODIFIER) || 0.85;

      for (const item of cargoStatus.manifest) {
        // Defensive: skip any malformed manifest entry (missing metalId) rather
        // than crashing the whole shop on item.metalId.startsWith.
        if (!item || typeof item.metalId !== 'string') continue;
        const sellValue = Math.round(item.value * sellMod);
        const isRefined = item.metalId.startsWith('refined_');
        const isProp = item.metalId.startsWith('prop_');
        const tag = isRefined ? ' ✧' : isProp ? ' ⚗' : '';

        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;
            padding:4px 8px;margin:2px 0;background:rgba(255,255,255,0.05);border-radius:4px">
            <span style="color:${item.color};font-size:11px">
              ${item.name}${tag}. ${item.massKg}kg
            </span>
            <span style="display:flex;gap:8px;align-items:center">
              <span style="color:#4f4;font-size:10px">${sellValue}¢</span>
              <button class="sell-item-btn" data-metal-id="${item.metalId}"
                style="padding:2px 8px;background:#666;color:#fff;border:none;
                border-radius:3px;cursor:pointer;font-size:10px">Sell</button>
              ${isRefined ? `<button class="contribute-item-btn" data-metal-id="${item.metalId}"
                data-mass="${item.massKg}"
                style="padding:2px 8px;background:#81c784;color:#000;border:none;
                border-radius:3px;cursor:pointer;font-size:10px">→ Elevator</button>` : ''}
            </span>
          </div>
        `;
      }
      manifestEl.innerHTML = html;

      const totalValue = Math.round(cargoStatus.totalValue * sellMod);
      if (totalEl) totalEl.textContent = `Total: ${totalValue}¢ (${cargoStatus.totalMassKg}kg / ${cargoStatus.capacityKg}kg)`;
      if (sellBtn) sellBtn.disabled = false;

      // Attach sell handlers
      manifestEl.querySelectorAll('.sell-item-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const metalId = btn.dataset.metalId;
          this._sellCargo(metalId);
        });
      });

      // Attach contribute handlers
      manifestEl.querySelectorAll('.contribute-item-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const metalId = btn.dataset.metalId;
          const mass = parseFloat(btn.dataset.mass);
          this._contributeToElevator(metalId, mass);
        });
      });
    }

    if (sellBtn) {
      sellBtn.onclick = () => this._sellAllCargo();
    }

    // Elevator progress
    if (elevatorSection) {
      const progress = this._contractMassKg || 0;
      const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
      const pct = Math.min(100, (progress / target * 100));
      const bonusPerKg = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG) || 5;
      elevatorSection.innerHTML = `
        <div style="color:#aaa;font-size:11px;margin-bottom:4px">
          ${progress.toFixed(1)} / ${target} kg contributed
        </div>
        <div style="background:#333;border-radius:3px;height:8px;overflow:hidden">
          <div style="height:100%;background:linear-gradient(90deg,#81c784,#4caf50);
            width:${pct.toFixed(1)}%;transition:width 0.5s"></div>
        </div>
        <div style="color:#666;font-size:9px;margin-top:2px">
          Contribute refined metals to earn ${bonusPerKg}¢/kg bonus
        </div>
      `;
    }
  }

  // ========================================================================
  // SELL / CONTRIBUTE (Phase 5)
  // ========================================================================

  /** @private Sell a single cargo item for credits */
  _sellCargo(metalId) {
    if (!this._cargoSystem) return;
    const manifest = this._cargoSystem.getManifest();
    const item = manifest.find(m => m.metalId === metalId);
    if (!item) return;

    this._cargoSystem.removeMetal(metalId, item.massKg);

    // E6: single sale-value SSOT. Route through ScoringSystem.processSale
    // (market spread + bulk bonus + credit + BULK comms) instead of the local
    // copy that had drifted from the canonical pipeline.
    const ss = this._scoringSystem || scoringSystem;
    const credits = (ss && ss.processSale)
      ? ss.processSale({ totalValue: item.value, totalMassKg: item.massKg })
      : 0;

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: `Sold ${item.massKg}kg ${item.name} for ${credits}¢`,
      priority: 'info'
    });

    this.refresh();
  }

  /** @private Sell all cargo for credits (with bulk bonus on total) */
  _sellAllCargo() {
    if (!this._cargoSystem) return;
    const manifest = this._cargoSystem.getManifest();
    if (manifest.length === 0) return;

    let totalValue = 0;
    let totalMass = 0;
    for (const item of [...manifest]) {
      totalValue += item.value;
      totalMass += item.massKg;
      this._cargoSystem.removeMetal(item.metalId, item.massKg);
    }

    // E6: route through the shared sale pipeline (spread + bulk-on-total + credit).
    const ss = this._scoringSystem || scoringSystem;
    const credits = (ss && ss.processSale)
      ? ss.processSale({ totalValue, totalMassKg: totalMass })
      : 0;

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: `Sold all cargo (${totalMass.toFixed(1)}kg) for ${credits}¢`,
      priority: 'info'
    });

    this.refresh();
  }

  /** @private Contribute refined metal to the space elevator contract */
  _contributeToElevator(metalId, massKg) {
    if (!this._cargoSystem) return;

    // Read the item BEFORE removal so we can value the contribution at market.
    const item = this._cargoSystem.getManifest().find(m => m.metalId === metalId);

    const removed = this._cargoSystem.removeMetal(metalId, massKg);
    if (removed < 0.01) return;

    this._contractMassKg = (this._contractMassKg || 0) + removed;

    // E3: a contribution pays the metal's SELL VALUE (market spread + bulk
    // bonus — the same credits selling it would earn) PLUS the elevator's
    // per-kg bonus, which the constant documents as being "on top of selling
    // price". Before this fix it paid ONLY the 5¢/kg bonus, so contributing
    // forfeited ~20¢/kg vs selling and the elevator win was strictly dominated.
    const perKgValue = (item && item.massKg > 0) ? (item.value / item.massKg) : 0;
    const { saleValue, bonus, payout } = computeContributionPayout(perKgValue * removed, removed);

    const ss = this._scoringSystem || scoringSystem;
    if (ss && ss.addCredits) {
      ss.addCredits(payout);
    }

    const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;

    eventBus.emit(Events.CONTRACT_UPDATE, {
      contractMassKg: this._contractMassKg,
      targetMassKg: target,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'ELEVATOR',
      text: `+${removed.toFixed(1)}kg contributed (+${payout}¢: ${saleValue} sale + ${bonus} bonus). Total: ${this._contractMassKg.toFixed(1)}kg`,
      priority: 'info'
    });

    // Check win condition
    if (this._contractMassKg >= target) {
      const winBonus = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.WIN_BONUS) || 50000;
      if (ss && ss.addCredits) {
        ss.addCredits(winBonus);
      }
      eventBus.emit(Events.CONTRACT_COMPLETE, {
        totalMassKg: this._contractMassKg,
        bonusCredits: winBonus,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'ELEVATOR',
        text: `🏆 CONTRACT COMPLETE! ${winBonus}¢ bonus! Space elevator anchor mass achieved!`,
        priority: 'critical'
      });
    }

    this.refresh();
  }

  // ========================================================================
  // REFRESH
  // ========================================================================

  /** Refresh shop with current credits */
  refresh() {
    const creditsEl = this.element.querySelector('#shop-credits');
    if (creditsEl) creditsEl.textContent = scoringSystem.credits.toLocaleString();

    // Show upgrade count
    const upgradeCountEl = this.element.querySelector('#shop-upgrade-count');
    if (upgradeCountEl) {
      let totalOwned = 0;
      for (const [, lvl] of this.purchasedUpgrades) totalOwned += lvl;
      totalOwned += this._springTier + this._tetherTier;
      upgradeCountEl.textContent = totalOwned;
    }

    const catContainer = this.element.querySelector('#shop-categories');
    if (!catContainer) return;

    // First-depot framing + recommended-starter highlight (early-shop tension).
    // The investment-framing header and ⭐ both key off "first depot visit";
    // the ⭐ additionally requires the player to own no starter yet. Use the
    // in-memory signal from GAME_STATE_CHANGE — the persisted FIRST_DEPOT_VISITED
    // flag is already true by the time the shop renders, so re-reading it here
    // would never show the framing on the actual first visit.
    const firstDepot = this._firstDepotVisit;
    const noteEl = this.element.querySelector('#shop-firstvisit-note');
    if (noteEl) noteEl.style.display = firstDepot ? 'block' : 'none';
    const recommendedId = firstDepot
      ? recommendedStarter(UPGRADES, this.purchasedUpgrades, scoringSystem.credits)
      : null;

    // Group by category
    const categories = {};
    UPGRADES.forEach(u => {
      // Net ladder: hide feature-gated items (e.g. Mother net restock) when the
      // gating flag is off.
      if (u.requiresFeature && !Constants.isFeatureEnabled(u.requiresFeature)) return;
      if (!categories[u.cat]) categories[u.cat] = [];
      categories[u.cat].push(u);
    });

    let html = Object.entries(categories).map(([cat, upgrades]) => `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          ${cat.toUpperCase()}
        </div>
        ${upgrades.map(u => this._renderUpgradeCard(u, recommendedId)).join('')}
      </div>
    `).join('');

    // Append crossbow spring & tether material tier sections
    html += this._renderTierSection('spring', '🛰️ CRADLE SPRINGS', Constants.SPRING_TIERS, SPRING_DESCRIPTIONS, this._springTier);
    html += this._renderTierSection('tether', '🧵 TETHER MATERIALS', Constants.TETHER_TIERS, TETHER_DESCRIPTIONS, this._tetherTier);

    // C-10: Arm tier upgrade section (gated by feature flag)
    if (Constants.FEATURE_FLAGS.TIER_UPGRADES) {
      html += this._renderArmTierSection();
    }

    catContainer.innerHTML = html;

    // Inline-glossary affordances: decorated jargon in upgrade/tier descriptions
    // deep-links to its Tech Library entry (idempotent CSS + delegated click).
    ensureGlossaryCss();
    delegateGlossaryClicks(catContainer);

    // Buy button handlers
    catContainer.querySelectorAll('.shop-buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        this._purchaseUpgrade(id);
      });
    });

    // S1 retention: pin toggle handlers
    catContainer.querySelectorAll('.shop-pin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePin(btn.dataset.pinId);
        this.refresh();
      });
    });

    // Tier buy button handlers (springs & tethers)
    catContainer.querySelectorAll('.shop-tier-buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tierType = btn.dataset.tierType;
        const tierIndex = parseInt(btn.dataset.tierIndex, 10);
        this._purchaseTierUpgrade(tierType, tierIndex);
      });
    });

    // C-10: Arm tier buy button handlers
    if (Constants.FEATURE_FLAGS.TIER_UPGRADES) {
      catContainer.querySelectorAll('.shop-arm-tier-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetTier = btn.dataset.targetTier;
          this._purchaseArmTier(targetTier);
        });
      });
    }

    // Apply flash animation to last purchased card
    if (this._lastPurchasedId) {
      const card = catContainer.querySelector(`[data-upgrade-id="${this._lastPurchasedId}"]`)
                || catContainer.querySelector(`[data-tier-id="${this._lastPurchasedId}"]`);
      if (card) {
        card.classList.add('shop-card-flash');
        // Remove after animation completes
        setTimeout(() => card.classList.remove('shop-card-flash'), 800);
      }
      this._lastPurchasedId = null;
    }

    // Phase 5: Refresh cargo manifest
    this._refreshCargoManifest();
  }

  // ========================================================================
  // UPGRADE CARDS
  // ========================================================================

  /** @private Render a single upgrade card */
  _renderUpgradeCard(upgrade, recommendedId = null) {
    const currentLevel = this.purchasedUpgrades.get(upgrade.id) || 0;
    const maxed = currentLevel >= upgrade.maxLevel;
    const canAfford = scoringSystem.credits >= upgrade.cost;
    const isRecommended = recommendedId === upgrade.id;
    // Prerequisite gate (E5 SSOT): shared with the purchase guard in
    // _purchaseUpgrade so the render's disabled-state and the actual purchase
    // enforcement can't drift. Handles requires / requiresAll / requiresFeature.
    const requiresMet = upgradePrereqsMet(upgrade, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f));
    // Consumable restock with no remaining capacity (both Mother pods full) is
    // unavailable — don't let the player pay for a net that can't be loaded.
    const consumableFull = upgrade.effect === 'motherNetRestock'
      && !captureNetSystem.hasMotherPodSpace();
    const available = !maxed && canAfford && requiresMet && !consumableFull;
    // S1 retention: pinnable = gated-open, not-maxed, non-consumable.
    const pinnable = !maxed && requiresMet && !upgrade.consumable && upgrade.maxLevel !== Infinity;
    const isPinned = this.pinnedUpgradeId === upgrade.id;

    const opacity = maxed ? 0.5 : (available ? 1.0 : 0.5);
    const borderColor = maxed ? 'rgba(0,255,136,0.2)' : (available ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,68,0.15)');
    const bgColor = maxed ? 'rgba(0,255,136,0.05)' : 'rgba(0,20,40,0.5)';

    // Level indicator for multi-level upgrades (consumables show no level badge).
    const levelBadge = (!upgrade.consumable && upgrade.maxLevel > 1)
      ? `<span style="font-size:0.65rem;color:${maxed ? '#00ff88' : '#f0c040'};margin-left:6px;
                       padding:1px 5px;border-radius:2px;border:1px solid ${maxed ? 'rgba(0,255,136,0.3)' : 'rgba(240,192,64,0.3)'};
                       background:${maxed ? 'rgba(0,255,136,0.1)' : 'rgba(240,192,64,0.08)'};">
           LVL ${currentLevel}/${upgrade.maxLevel}</span>`
      : (maxed ? `<span style="font-size:0.65rem;color:#00ff88;margin-left:6px;">✓</span>` : '');

    // Cost display with insufficient funds styling
    const costColor = maxed ? 'rgba(0,255,136,0.4)' : (canAfford ? '#f0c040' : '#ff4444');
    const costStrike = !canAfford && !maxed ? 'text-decoration:line-through;opacity:0.6;' : '';

    // ST-6.6 / UX-11 #10: Tech-Level badge — colour-coded, tooltipped with rationale
    const trlBadge = (typeof upgrade.trl === 'number')
      ? `<span title="${trlToTechLevelLabel(upgrade.trl, Constants.TRL)}${upgrade.trlRationale ? '\n' + upgrade.trlRationale : ''}"
              style="display:inline-block;margin-left:6px;font-size:0.6rem;font-weight:bold;
                     padding:1px 5px;border-radius:2px;letter-spacing:0.05em;
                     color:${trlToBadgeColor(upgrade.trl, Constants.TRL)};
                     border:1px solid ${trlToBadgeColor(upgrade.trl, Constants.TRL)};
                     background:rgba(0,0,0,0.3);">${techLevelBadgeText(upgrade.trl)}</span>`
      : '';

    // Recommended-starter ⭐ badge + one-line "why" (early-shop tension).
    const starBadge = isRecommended
      ? `<span title="Recommended starter" style="margin-left:6px;font-size:0.75rem;
               color:#f0c040;">★</span>`
      : '';
    // S1 retention: pin toggle badge (📌) on the name row for pinnable items.
    const pinBadge = pinnable
      ? `<span class="shop-pin-btn" data-pin-id="${upgrade.id}"
              title="${isPinned ? 'Unpin chase target' : 'Pin as next-upgrade goal'}"
              style="margin-left:6px;font-size:0.72rem;cursor:pointer;user-select:none;
                     opacity:${isPinned ? 1 : 0.4};color:${isPinned ? '#f0c040' : 'rgba(0,255,136,0.6)'};">📌</span>`
      : '';
    const whyLine = isRecommended && STARTER_WHY[upgrade.id]
      ? `<div style="font-size:0.65rem;color:rgba(240,192,64,0.85);margin-top:2px;">
           ★ ${STARTER_WHY[upgrade.id]}</div>`
      : '';

    return `
      <div data-upgrade-id="${upgrade.id}" style="display:flex;justify-content:space-between;align-items:center;
                  padding:8px 12px;margin:4px 0;border-radius:3px;
                  background:${isRecommended ? 'rgba(240,192,64,0.06)' : bgColor};
                  border:1px solid ${isRecommended ? 'rgba(240,192,64,0.45)' : borderColor};
                  opacity:${opacity};transition:all 0.3s;">
        <div style="flex:1;">
          <div style="font-size:0.85rem;color:${maxed ? 'rgba(0,255,136,0.6)' : '#00ff88'};">
            ${upgrade.name}${levelBadge}${trlBadge}${starBadge}${pinBadge}
          </div>
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${decorateGlossary(upgrade.desc, { once: true })}</div>
          ${whyLine}
          ${upgrade.requires && !requiresMet ? `<div style="font-size:0.65rem;color:#ff6644;">Requires: ${UPGRADES.find(u => u.id === upgrade.requires)?.name}</div>` : ''}
          ${upgrade.requiresAll && !requiresMet ? `<div style="font-size:0.65rem;color:#ff6644;">Requires: ${upgrade.requiresAll.map(id => UPGRADES.find(u => u.id === id)?.name || id).join(' + ')}</div>` : ''}
          ${!canAfford && !maxed ? `<div style="font-size:0.6rem;color:rgba(255,68,68,0.5);margin-top:2px;">Need ${(upgrade.cost - scoringSystem.credits).toLocaleString()} more cr</div>` : ''}
        </div>
        <div style="text-align:right;min-width:90px;">
          ${maxed
            ? `<span style="color:rgba(0,255,136,0.5);font-size:0.75rem;">✓ OWNED</span>`
            : `<div style="font-size:0.8rem;color:${costColor};${costStrike}">${upgrade.cost.toLocaleString()} cr</div>
               <button class="shop-buy-btn" data-id="${upgrade.id}" style="
                 font-family:'Courier New',monospace; font-size:0.7rem; color:${available ? '#00ff88' : 'rgba(0,255,136,0.3)'};
                 background: ${available ? 'rgba(0,255,136,0.15)' : 'transparent'};
                 border: 1px solid ${available ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.15)'};
                 padding: 3px 12px; cursor: ${available ? 'pointer' : 'default'}; border-radius: 2px;
                 pointer-events: ${available ? 'auto' : 'none'}; transition: all 0.2s;
               ">BUY</button>`
          }
        </div>
      </div>
    `;
  }

  // ========================================================================
  // TIER UPGRADE CARDS (Crossbow Springs & Tether Materials)
  // ========================================================================

  /**
   * @private Render an entire tier upgrade section (springs or tethers).
   * @param {string} tierType - 'spring' or 'tether'
   * @param {string} headerLabel - Section header text
   * @param {Array} tiers - Tier data from Constants
   * @param {string[]} descriptions - Human descriptions per tier
   * @param {number} currentTier - Currently owned tier index
   */
  _renderTierSection(tierType, headerLabel, tiers, descriptions, currentTier) {
    const cards = tiers.map((tier, i) =>
      this._renderTierCard(tierType, tier, i, descriptions[i], currentTier)
    ).join('');

    return `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          ${headerLabel}
        </div>
        ${cards}
      </div>
    `;
  }

  /**
   * @private Render a single tier upgrade card.
   * @param {string} tierType - 'spring' or 'tether'
   * @param {Object} tier - Tier data object from Constants
   * @param {number} tierIndex - Index into the tiers array
   * @param {string} desc - Human-readable description
   * @param {number} currentTier - Currently owned tier index
   */
  _renderTierCard(tierType, tier, tierIndex, desc, currentTier) {
    const isOwned = tierIndex < currentTier;
    const isCurrent = tierIndex === currentTier;
    const isNext = tierIndex === currentTier + 1;
    const isLocked = tierIndex > currentTier + 1;
    const canAfford = scoringSystem.credits >= tier.cost;
    const available = isNext && canAfford;

    // Visual states
    let borderColor, bgColor, opacity;
    if (isCurrent) {
      borderColor = 'rgba(0,255,136,0.5)';
      bgColor = 'rgba(0,255,136,0.08)';
      opacity = 1.0;
    } else if (isOwned) {
      borderColor = 'rgba(0,255,136,0.2)';
      bgColor = 'rgba(0,255,136,0.05)';
      opacity = 0.5;
    } else if (isNext) {
      borderColor = available ? 'rgba(240,192,64,0.4)' : 'rgba(255,68,68,0.15)';
      bgColor = 'rgba(0,20,40,0.5)';
      opacity = available ? 1.0 : 0.6;
    } else {
      borderColor = 'rgba(100,100,100,0.2)';
      bgColor = 'rgba(0,10,20,0.3)';
      opacity = 0.35;
    }

    // Stats line differs by tier type
    let statsLine;
    if (tierType === 'spring') {
      statsLine = `Max ${tier.maxSpeed} m/s`;
    } else {
      statsLine = `${tier.breakStrength}N break · ${(tier.maxLength / 1000).toFixed(0)}km max`;
    }

    // Status badge / action area
    let statusHtml;
    if (isCurrent) {
      statusHtml = `<span style="color:#00ff88;font-size:0.75rem;">▶ EQUIPPED</span>`;
    } else if (isOwned) {
      statusHtml = `<span style="color:rgba(0,255,136,0.5);font-size:0.75rem;">✓ OWNED</span>`;
    } else if (isLocked) {
      statusHtml = `<span style="color:rgba(100,100,100,0.5);font-size:0.75rem;">🔒 LOCKED</span>`;
    } else {
      // isNext — purchasable
      const costColor = canAfford ? '#f0c040' : '#ff4444';
      const costStrike = !canAfford ? 'text-decoration:line-through;opacity:0.6;' : '';
      statusHtml = `
        <div style="font-size:0.8rem;color:${costColor};${costStrike}">${tier.cost.toLocaleString()} cr</div>
        <button class="shop-tier-buy-btn" data-tier-type="${tierType}" data-tier-index="${tierIndex}" style="
          font-family:'Courier New',monospace; font-size:0.7rem; color:${available ? '#00ff88' : 'rgba(0,255,136,0.3)'};
          background: ${available ? 'rgba(0,255,136,0.15)' : 'transparent'};
          border: 1px solid ${available ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.15)'};
          padding: 3px 12px; cursor: ${available ? 'pointer' : 'default'}; border-radius: 2px;
          pointer-events: ${available ? 'auto' : 'none'}; transition: all 0.2s;
        ">BUY</button>
      `;
      if (!canAfford) {
        statusHtml += `<div style="font-size:0.6rem;color:rgba(255,68,68,0.5);margin-top:2px;">Need ${(tier.cost - scoringSystem.credits).toLocaleString()} more cr</div>`;
      }
    }

    const tierLabel = `T${tierIndex + 1}`;

    return `
      <div data-tier-id="${tierType}-${tierIndex}" style="display:flex;justify-content:space-between;align-items:center;
                  padding:8px 12px;margin:4px 0;border-radius:3px;
                  background:${bgColor};border:1px solid ${borderColor};
                  opacity:${opacity};transition:all 0.3s;">
        <div style="flex:1;">
          <div style="font-size:0.85rem;color:${isCurrent ? '#00ff88' : isOwned ? 'rgba(0,255,136,0.6)' : isLocked ? 'rgba(100,100,100,0.5)' : '#00ff88'};">
            <span style="font-size:0.65rem;color:${isCurrent ? '#f0c040' : 'rgba(0,255,136,0.4)'};
                         padding:1px 5px;border-radius:2px;border:1px solid ${isCurrent ? 'rgba(240,192,64,0.3)' : 'rgba(0,255,136,0.15)'};
                         background:${isCurrent ? 'rgba(240,192,64,0.08)' : 'transparent'};margin-right:6px;">${tierLabel}</span>
            ${tier.name}
          </div>
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${statsLine}</div>
          <div style="font-size:0.65rem;color:rgba(0,255,136,0.35);margin-top:1px;">${decorateGlossary(desc, { once: true })}</div>
        </div>
        <div style="text-align:right;min-width:90px;">
          ${statusHtml}
        </div>
      </div>
    `;
  }

  // ========================================================================
  // ARM TIER SECTION (C-10)
  // ========================================================================

  /**
   * @private Render the arm tier upgrade section.
   * Shows all 3 tiers: current (✓), available (price + buy), locked (TRL hint).
   */
  _renderArmTierSection() {
    const currentTier = this._armManager ? getCurrentTier(this._armManager) : 'Y0_QUAD';
    const tiers = getAvailableTiers();
    const gs = this._armManager
      ? buildGameState({
          scoringSystem,
          armManager: this._armManager,
          launchSequence: this._launchSequence,
        })
      : { credits: scoringSystem.credits, debrisCleared: scoringSystem.debrisCleared || 0,
          launchReady: true, allArmsStowed: true, noActiveOps: true };

    const cards = tiers.map(tier => {
      const isCurrent = tier.tierKey === currentTier;
      const isPast = tier.tierKey !== currentTier &&
        getAvailableTiers().findIndex(t => t.tierKey === tier.tierKey) <
        getAvailableTiers().findIndex(t => t.tierKey === currentTier);
      const isNext = !isCurrent && !isPast && tier.prereqTier === currentTier;
      const isLocked = !isCurrent && !isPast && !isNext;

      const check = isNext ? canUpgrade(currentTier, tier.tierKey, gs) : { allowed: false, reason: null };
      const canAfford = isNext && check.allowed;

      // Visual states
      let borderColor, bgColor, opacity;
      if (isCurrent) {
        borderColor = 'rgba(0,255,136,0.5)';
        bgColor = 'rgba(0,255,136,0.08)';
        opacity = 1.0;
      } else if (isPast) {
        borderColor = 'rgba(0,255,136,0.2)';
        bgColor = 'rgba(0,255,136,0.05)';
        opacity = 0.5;
      } else if (isNext) {
        borderColor = canAfford ? 'rgba(240,192,64,0.4)' : 'rgba(255,68,68,0.15)';
        bgColor = 'rgba(0,20,40,0.5)';
        opacity = canAfford ? 1.0 : 0.6;
      } else {
        borderColor = 'rgba(100,100,100,0.2)';
        bgColor = 'rgba(0,10,20,0.3)';
        opacity = 0.35;
      }

      const statsLine = `${tier.armCount} daughters · ${tier.massDryKg} kg dry · ${tier.massWetKg} kg wet`;
      const featuresLine = tier.features.join(' · ');

      let statusHtml;
      if (isCurrent) {
        statusHtml = `<span style="color:#00ff88;font-size:0.75rem;">▶ EQUIPPED</span>`;
      } else if (isPast) {
        statusHtml = `<span style="color:rgba(0,255,136,0.5);font-size:0.75rem;">✓ OWNED</span>`;
      } else if (isLocked) {
        const needed = tier.prereqTier
          ? getAvailableTiers().find(t => t.tierKey === tier.prereqTier)?.displayName || tier.prereqTier
          : '';
        statusHtml = `<span style="color:rgba(100,100,100,0.5);font-size:0.75rem;">🔒 Requires ${needed}</span>`;
      } else {
        // isNext — purchasable or error
        const costColor = canAfford ? '#f0c040' : '#ff4444';
        statusHtml = `
          <div style="font-size:0.8rem;color:${costColor};">${tier.costCredits.toLocaleString()} cr</div>
          <button class="shop-arm-tier-btn" data-target-tier="${tier.tierKey}" style="
            font-family:'Courier New',monospace; font-size:0.7rem; color:${canAfford ? '#00ff88' : 'rgba(0,255,136,0.3)'};
            background: ${canAfford ? 'rgba(0,255,136,0.15)' : 'transparent'};
            border: 1px solid ${canAfford ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.15)'};
            padding: 3px 12px; cursor: ${canAfford ? 'pointer' : 'default'}; border-radius: 2px;
            pointer-events: ${canAfford ? 'auto' : 'none'}; transition: all 0.2s;
          ">UPGRADE</button>
        `;
        if (!canAfford && check.reason) {
          statusHtml += `<div style="font-size:0.6rem;color:rgba(255,68,68,0.5);margin-top:2px;">${check.reason}</div>`;
        }
      }

      // UX-11 #10: Tech-Level badge for the tier (player-facing relabel of TRL)
      const trlValue = tier.unlockTRL;
      const effectiveTRL = getEffectiveTRL(gs.debrisCleared || 0);
      const trlMet = effectiveTRL >= trlValue;
      const trlColor = trlMet ? '#22dd44' : '#ff6644';

      return `
        <div data-tier-id="arm-${tier.tierKey}" style="display:flex;justify-content:space-between;align-items:center;
                    padding:8px 12px;margin:4px 0;border-radius:3px;
                    background:${bgColor};border:1px solid ${borderColor};
                    opacity:${opacity};transition:all 0.3s;">
          <div style="flex:1;">
            <div style="font-size:0.85rem;color:${isCurrent ? '#00ff88' : isPast ? 'rgba(0,255,136,0.6)' : isLocked ? 'rgba(100,100,100,0.5)' : '#00ff88'};">
              ${tier.displayName}
              <span style="font-size:0.6rem;font-weight:bold;padding:1px 5px;border-radius:2px;
                           letter-spacing:0.05em;color:${trlColor};border:1px solid ${trlColor};
                           background:rgba(0,0,0,0.3);margin-left:6px;">${techLevelBadgeText(trlValue)}</span>
              ${tier.endFaceArms > 0 ? '<span style="font-size:0.6rem;color:#ff8800;margin-left:6px;">+END-FACE</span>' : ''}
            </div>
            <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${statsLine}</div>
            <div style="font-size:0.65rem;color:rgba(0,255,136,0.35);margin-top:1px;">${featuresLine}</div>
            <div style="font-size:0.6rem;color:rgba(0,255,136,0.25);margin-top:1px;font-style:italic;">${decorateGlossary(tier.description, { once: true })}</div>
          </div>
          <div style="text-align:right;min-width:100px;">
            ${statusHtml}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          🐙 DAUGHTER CONFIGURATION
        </div>
        ${cards}
      </div>
    `;
  }

  /**
   * @private Purchase an arm tier upgrade (C-10).
   * Shows confirmation modal, then executes via ArmTierCatalog.executeUpgrade.
   */
  _purchaseArmTier(targetTier) {
    if (!this._armManager) return;

    const currentTier = getCurrentTier(this._armManager);
    const gs = buildGameState({
      scoringSystem,
      armManager: this._armManager,
      launchSequence: this._launchSequence,
    });

    const check = canUpgrade(currentTier, targetTier, gs);
    if (!check.allowed) {
      audioSystem.playWarning(0.3);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'SHIPYARD',
        text: `Tier upgrade denied: ${check.reason}`,
        priority: 'warning',
      });
      return;
    }

    const target = getAvailableTiers().find(t => t.tierKey === targetTier);
    if (!target) return;

    // Simple confirmation via browser confirm (no custom modal needed)
    const msg = `UPGRADE TO ${target.displayName}?\n\n` +
      `Daughters: ${target.armCount} (${target.features[0]})\n` +
      `Mass: ${target.massDryKg} kg dry / ${target.massWetKg} kg wet\n` +
      `Cost: ${target.costCredits.toLocaleString()} credits\n\n` +
      `This replaces ALL current daughters with the new configuration.\n` +
      `Per-daughter state (nets, tethers, bridle) will be reset.`;

    if (!confirm(msg)) return;

    const result = executeUpgrade(currentTier, targetTier, gs, {
      armManager: this._armManager,
      scoringSystem,
      persistenceManager: this._persistenceManager,
    });

    if (result.success) {
      this._lastPurchasedId = `arm-${targetTier}`;
      audioSystem.playCaptureSuccess();
    } else {
      audioSystem.playWarning(0.3);
    }

    this.refresh();
  }

  // ========================================================================
  // PURCHASE
  // ========================================================================

  /** @private Purchase an upgrade */
  _purchaseUpgrade(upgradeId) {
    const upgrade = UPGRADES.find(u => u.id === upgradeId);
    if (!upgrade) return;

    // Consumables (e.g. Mother Large Net restock) are repeatable — no maxLevel
    // gate, no ownership record. They just spend credits and emit the effect.
    if (upgrade.consumable) {
      if (upgrade.requiresFeature && !Constants.isFeatureEnabled(upgrade.requiresFeature)) return;
      // Don't charge for a net that can't be loaded (both pods already full).
      if (upgrade.effect === 'motherNetRestock' && !captureNetSystem.hasMotherPodSpace()) {
        audioSystem.playWarning(0.3);
        return;
      }
      if (!scoringSystem.spendCredits(upgrade.cost)) {
        audioSystem.playWarning(0.3);
        return;
      }
      this._lastPurchasedId = upgradeId;
      audioSystem.playCaptureSuccess();
      eventBus.emit(Events.UPGRADE_PURCHASED, {
        id: upgradeId,
        effect: upgrade.effect,
        value: upgrade.value,
        consumable: true,
      });
      this.refresh();
      return;
    }

    const currentLevel = this.purchasedUpgrades.get(upgradeId) || 0;
    if (currentLevel >= upgrade.maxLevel) return;

    // E5: enforce prerequisites at PURCHASE time, not just in the render's
    // disabled-state. Without this a mis-ordered / scripted buy could acquire a
    // locked upgrade (e.g. graphene_supercap before solid_state_battery) and
    // spend the credits anyway. Refuse before charging — wallet untouched.
    if (!upgradePrereqsMet(upgrade, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f))) {
      audioSystem.playWarning(0.3);
      return;
    }

    if (!scoringSystem.spendCredits(upgrade.cost)) {
      audioSystem.playWarning(0.3);
      return;
    }

    this.purchasedUpgrades.set(upgradeId, currentLevel + 1);
    this._lastPurchasedId = upgradeId; // trigger flash on next refresh
    audioSystem.playCaptureSuccess();

    // S1 retention: clear the pin when the pinned item is purchased (or once it
    // reaches maxLevel); the HUD re-advances to a fresh chase target on next hide.
    if (this.pinnedUpgradeId === upgradeId) {
      this.pinnedUpgradeId = null;
      this._emitPinnedUpgrade();
    }

    // Emit upgrade event for game to apply
    eventBus.emit(Events.UPGRADE_PURCHASED, {
      id: upgradeId,
      effect: upgrade.effect,
      value: upgrade.value,
      level: currentLevel + 1,
    });

    // Refresh display (will apply flash animation)
    this.refresh();
  }

  /**
   * @private Purchase a tier upgrade (spring or tether).
   * @param {string} tierType - 'spring' or 'tether'
   * @param {number} tierIndex - Target tier index
   */
  _purchaseTierUpgrade(tierType, tierIndex) {
    const tiers = tierType === 'spring' ? Constants.SPRING_TIERS : Constants.TETHER_TIERS;
    const currentTier = tierType === 'spring' ? this._springTier : this._tetherTier;

    // Must be the next tier in sequence
    if (tierIndex !== currentTier + 1) return;
    if (tierIndex >= tiers.length) return;

    const tier = tiers[tierIndex];
    if (!scoringSystem.spendCredits(tier.cost)) {
      audioSystem.playWarning(0.3);
      return;
    }

    // Advance to new tier
    if (tierType === 'spring') {
      this._springTier = tierIndex;
    } else {
      this._tetherTier = tierIndex;
    }

    this._lastPurchasedId = `${tierType}-${tierIndex}`; // trigger flash on next refresh
    audioSystem.playCaptureSuccess();

    // Emit upgrade event — ArmManager.applyUpgrade() handles springTier / tetherTier
    eventBus.emit(Events.UPGRADE_PURCHASED, {
      type: tierType === 'spring' ? 'springTier' : 'tetherTier',
      effect: tierType === 'spring' ? 'springTier' : 'tetherTier',
      value: tierIndex,
      level: tierIndex,
      name: tier.name,
      cost: tier.cost,
    });

    this.refresh();
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Get all purchased upgrades.
   * @returns {Map<string, number>}
   */
  getPurchasedUpgrades() {
    return this.purchasedUpgrades;
  }

  /**
   * Get a specific upgrade effect value if purchased.
   * @param {string} effectName
   * @returns {*} Upgrade value or null
   */
  getUpgradeEffect(effectName) {
    for (const upgrade of UPGRADES) {
      if (upgrade.effect === effectName && this.purchasedUpgrades.has(upgrade.id)) {
        return upgrade.value;
      }
    }
    return null;
  }

  /**
   * Get purchased upgrade IDs as a serializable array for persistence.
   * Multi-level upgrades appear multiple times (once per level).
   * @returns {string[]}
   */
  getSerializableUpgrades() {
    const ids = [];
    for (const [id, level] of this.purchasedUpgrades) {
      for (let i = 0; i < level; i++) {
        ids.push(id);
      }
    }
    // Serialize tier upgrades (tier 0 is free starter, store purchased tiers)
    for (let i = 0; i < this._springTier; i++) ids.push('_springTier');
    for (let i = 0; i < this._tetherTier; i++) ids.push('_tetherTier');
    // S1 retention: persist the pinned chase target as a sentinel token so it
    // survives save/load through the existing upgrade-array channel.
    if (this.pinnedUpgradeId) ids.push(`__pin__${this.pinnedUpgradeId}`);
    return ids;
  }

  /**
   * Restore purchases from a saved array of upgrade IDs.
   * @param {string[]} upgradeIds - Array of upgrade IDs (duplicates = multi-level)
   */
  restorePurchases(upgradeIds) {
    this.purchasedUpgrades.clear();
    this._springTier = 0;
    this._tetherTier = 0;
    this.pinnedUpgradeId = null;
    if (!Array.isArray(upgradeIds)) return;
    let restoredPin = null;
    for (const id of upgradeIds) {
      if (id === '_springTier') {
        this._springTier++;
      } else if (id === '_tetherTier') {
        this._tetherTier++;
      } else if (typeof id === 'string' && id.startsWith('__pin__')) {
        restoredPin = id.slice('__pin__'.length);
      } else {
        const current = this.purchasedUpgrades.get(id) || 0;
        this.purchasedUpgrades.set(id, current + 1);
      }
    }
    // Stale-save safety: drop the pin if it no longer exists in UPGRADES or is
    // already maxed after restoring purchases.
    if (restoredPin) {
      this.pinnedUpgradeId = restoredPin;
      this._clearStalePin();
    }
  }

  /**
   * Iterate all purchased upgrades, calling the callback with the full
   * upgrade data object for each level purchased. Used to re-apply
   * effects after restoring from a save.
   * @param {function({id:string, effect:string, value:*, level:number}):void} callback
   */
  forEachPurchasedUpgrade(callback) {
    for (const [id, level] of this.purchasedUpgrades) {
      const upgrade = UPGRADES.find(u => u.id === id);
      if (!upgrade) continue;
      for (let i = 1; i <= level; i++) {
        callback({
          id: id,
          effect: upgrade.effect,
          value: upgrade.value,
          level: i,
        });
      }
    }
    // Re-apply tier upgrades on restore
    if (this._springTier > 0) {
      callback({ id: '_springTier', effect: 'springTier', value: this._springTier, level: this._springTier });
    }
    if (this._tetherTier > 0) {
      callback({ id: '_tetherTier', effect: 'tetherTier', value: this._tetherTier, level: this._tetherTier });
    }
  }

  /** Get the current spring tier index (0-based). */
  getSpringTier() { return this._springTier; }

  /** Get the current tether tier index (0-based). */
  getTetherTier() { return this._tetherTier; }

  show() {
    this.visible = true;
    this.refresh();
    this.element.style.display = 'flex';
    this.element.style.opacity = '1';
    eventBus.emit(Events.SHOP_OPENED);
  }

  hide() {
    this.visible = false;
    // S1 retention: ensure the chase target is never empty when leaving the shop
    // with unaffordable items remaining, then broadcast the current pin so the
    // HUD widget shows live progress until the next depot.
    this._autoPinIfNeeded();
    this._emitPinnedUpgrade();
    this.element.style.opacity = '0';
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 300);
  }

  // ========================================================================
  // S1 retention: pinned "next upgrade" chase target
  // ========================================================================

  /**
   * Resolve the pinned upgrade catalog row, or null if unset/stale/maxed.
   * Pure read — does NOT mutate `pinnedUpgradeId` (use `_clearStalePin()` to
   * drop an invalid pin).
   */
  getPinnedUpgrade() {
    if (!this.pinnedUpgradeId) return null;
    const u = UPGRADES.find((x) => x.id === this.pinnedUpgradeId);
    if (!u) return null;
    const level = this.purchasedUpgrades.get(u.id) || 0;
    if (level >= (u.maxLevel || 1)) return null;
    return u;
  }

  /** @private Drop the pin if it is stale (unknown id) or already maxed. */
  _clearStalePin() {
    if (this.pinnedUpgradeId && !this.getPinnedUpgrade()) {
      this.pinnedUpgradeId = null;
    }
  }

  /**
   * Pin (or re-pin) an upgrade as the chase target. Only gated-open, not-maxed,
   * non-consumable items are pinnable. Emits UPGRADE_PINNED.
   * @param {string} id
   * @returns {boolean} whether the pin was set
   */
  pinUpgrade(id) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u || u.consumable || u.maxLevel === Infinity) return false;
    const level = this.purchasedUpgrades.get(u.id) || 0;
    if (level >= (u.maxLevel || 1)) return false;
    if (!upgradePrereqsMet(u, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f))) return false;
    this.pinnedUpgradeId = id;
    this._emitPinnedUpgrade();
    return true;
  }

  /** Toggle the pin on an upgrade (unpins if already pinned). */
  togglePin(id) {
    if (this.pinnedUpgradeId === id) {
      this.pinnedUpgradeId = null;
      this._emitPinnedUpgrade();
      return false;
    }
    return this.pinUpgrade(id);
  }

  /** @private Auto-pin the cheapest gated-open unaffordable upgrade if unset/stale. */
  _autoPinIfNeeded() {
    this._clearStalePin();
    if (this.getPinnedUpgrade()) return; // valid pin already set
    const credits = this._scoringSystem ? this._scoringSystem.credits : scoringSystem.credits;
    const id = cheapestChaseTarget(UPGRADES, this.purchasedUpgrades, credits,
      (f) => Constants.isFeatureEnabled(f));
    this.pinnedUpgradeId = id;
  }

  /** @private Emit UPGRADE_PINNED with the current pin (or a cleared payload). */
  _emitPinnedUpgrade() {
    this._clearStalePin();
    const u = this.getPinnedUpgrade();
    const credits = this._scoringSystem ? this._scoringSystem.credits : scoringSystem.credits;
    eventBus.emit(Events.UPGRADE_PINNED, u
      ? { id: u.id, name: u.name, cost: u.cost, credits }
      : { id: null, name: null, cost: 0, credits });
  }
}

export default ShopScreen;
