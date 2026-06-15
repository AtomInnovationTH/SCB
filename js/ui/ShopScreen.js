/**
 * ShopScreen.js — Upgrade shop between missions + cargo selling + elevator contract
 * @module ui/ShopScreen
 */

import { Constants, trlToBadgeColor, trlToTechLevelLabel, techLevelBadgeText } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { scoringSystem } from '../systems/ScoringSystem.js';
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
 * Upgrade definitions — 30 items across 7 categories, all wired to live systems.
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
    desc: 'Magnetoplasmadynamic thruster. 25N thrust, Isp 3000s. Press [M] to arm burst mode. Requires lithium.',
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
    trl: 2, trlRationale: 'Graphene Structural Lattice. Paper-stage; HBN-coated Dyneema arriving 2026' },
  { id: 'gsl_net_v4', cat: 'Graphene', name: 'GSL Net v4', cost: 3500,
    desc: '10× capture net area', effect: 'v4NetArea',
    value: Math.sqrt(Constants.V4_NET_SIZE_MULT), maxLevel: 1,
    trl: 2, trlRationale: 'Graphene-reinforced capture net. Speculative; no space heritage' },
  { id: 'gsl_electrostatic_v4', cat: 'Graphene', name: 'GSL Electrostatic v4', cost: 4000,
    desc: '160N electrostatic grip. 5× capture mass', effect: 'v4GripForce',
    value: 5.0, maxLevel: 1,
    trl: 3, trlRationale: 'Electrostatic capture demonstrated on CubeSats; 160N force is game-speculative' },
];

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
    this._lastPurchasedId = null; // for flash animation
    this._springTier = 0;  // Current spring tier index (0 = T1 starter)
    this._tetherTier = 0;  // Current tether tier index (0 = T1 starter)

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
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      if (to === GameStates.SHOP) this.show();
      else this.hide();
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

    const sellMod = (Constants.MARKET && Constants.MARKET.SELL_PRICE_MODIFIER) || 0.85;
    let credits = Math.round(item.value * sellMod);

    // Bulk bonus for single large items
    const bulkThresh = (Constants.MARKET && Constants.MARKET.BULK_THRESHOLD_KG) || 50;
    const bulkMult = (Constants.MARKET && Constants.MARKET.BULK_BONUS_MULTIPLIER) || 1.15;
    if (item.massKg >= bulkThresh) {
      credits = Math.round(credits * bulkMult);
    }

    this._cargoSystem.removeMetal(metalId, item.massKg);

    // Add credits via scoring system
    const ss = this._scoringSystem || scoringSystem;
    if (ss && ss.addCredits) {
      ss.addCredits(credits);
    }

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

    let totalCredits = 0;
    let totalMass = 0;
    const sellMod = (Constants.MARKET && Constants.MARKET.SELL_PRICE_MODIFIER) || 0.85;

    for (const item of [...manifest]) {
      const credits = Math.round(item.value * sellMod);
      totalCredits += credits;
      totalMass += item.massKg;
      this._cargoSystem.removeMetal(item.metalId, item.massKg);
    }

    // Bulk bonus on total
    const bulkThresh = (Constants.MARKET && Constants.MARKET.BULK_THRESHOLD_KG) || 50;
    const bulkMult = (Constants.MARKET && Constants.MARKET.BULK_BONUS_MULTIPLIER) || 1.15;
    if (totalMass >= bulkThresh) {
      totalCredits = Math.round(totalCredits * bulkMult);
    }

    const ss = this._scoringSystem || scoringSystem;
    if (ss && ss.addCredits) {
      ss.addCredits(totalCredits);
    }

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: `Sold all cargo (${totalMass.toFixed(1)}kg) for ${totalCredits}¢`,
      priority: 'info'
    });

    this.refresh();
  }

  /** @private Contribute refined metal to the space elevator contract */
  _contributeToElevator(metalId, massKg) {
    if (!this._cargoSystem) return;

    const removed = this._cargoSystem.removeMetal(metalId, massKg);
    if (removed < 0.01) return;

    this._contractMassKg = (this._contractMassKg || 0) + removed;

    const bonusPerKg = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG) || 5;
    const bonus = Math.round(removed * bonusPerKg);

    const ss = this._scoringSystem || scoringSystem;
    if (ss && ss.addCredits) {
      ss.addCredits(bonus);
    }

    const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;

    eventBus.emit(Events.CONTRACT_UPDATE, {
      contractMassKg: this._contractMassKg,
      targetMassKg: target,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'ELEVATOR',
      text: `+${removed.toFixed(1)}kg contributed (+${bonus}¢ bonus). Total: ${this._contractMassKg.toFixed(1)}kg`,
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

    // Group by category
    const categories = {};
    UPGRADES.forEach(u => {
      if (!categories[u.cat]) categories[u.cat] = [];
      categories[u.cat].push(u);
    });

    let html = Object.entries(categories).map(([cat, upgrades]) => `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          ${cat.toUpperCase()}
        </div>
        ${upgrades.map(u => this._renderUpgradeCard(u)).join('')}
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

    // Buy button handlers
    catContainer.querySelectorAll('.shop-buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        this._purchaseUpgrade(id);
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
  _renderUpgradeCard(upgrade) {
    const currentLevel = this.purchasedUpgrades.get(upgrade.id) || 0;
    const maxed = currentLevel >= upgrade.maxLevel;
    const canAfford = scoringSystem.credits >= upgrade.cost;
    // Support both single `requires` (string) and `requiresAll` (array) prerequisites
    let requiresMet = true;
    if (upgrade.requires) {
      requiresMet = this.purchasedUpgrades.has(upgrade.requires);
    }
    if (upgrade.requiresAll) {
      requiresMet = upgrade.requiresAll.every(id => this.purchasedUpgrades.has(id));
    }
    const available = !maxed && canAfford && requiresMet;

    const opacity = maxed ? 0.5 : (available ? 1.0 : 0.5);
    const borderColor = maxed ? 'rgba(0,255,136,0.2)' : (available ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,68,0.15)');
    const bgColor = maxed ? 'rgba(0,255,136,0.05)' : 'rgba(0,20,40,0.5)';

    // Level indicator for multi-level upgrades
    const levelBadge = upgrade.maxLevel > 1
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

    return `
      <div data-upgrade-id="${upgrade.id}" style="display:flex;justify-content:space-between;align-items:center;
                  padding:8px 12px;margin:4px 0;border-radius:3px;
                  background:${bgColor};border:1px solid ${borderColor};
                  opacity:${opacity};transition:all 0.3s;">
        <div style="flex:1;">
          <div style="font-size:0.85rem;color:${maxed ? 'rgba(0,255,136,0.6)' : '#00ff88'};">
            ${upgrade.name}${levelBadge}${trlBadge}
          </div>
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${upgrade.desc}</div>
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
          <div style="font-size:0.65rem;color:rgba(0,255,136,0.35);margin-top:1px;">${desc}</div>
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
            <div style="font-size:0.6rem;color:rgba(0,255,136,0.25);margin-top:1px;font-style:italic;">${tier.description}</div>
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

    const currentLevel = this.purchasedUpgrades.get(upgradeId) || 0;
    if (currentLevel >= upgrade.maxLevel) return;

    if (!scoringSystem.spendCredits(upgrade.cost)) {
      audioSystem.playWarning(0.3);
      return;
    }

    this.purchasedUpgrades.set(upgradeId, currentLevel + 1);
    this._lastPurchasedId = upgradeId; // trigger flash on next refresh
    audioSystem.playCaptureSuccess();

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
    if (!Array.isArray(upgradeIds)) return;
    for (const id of upgradeIds) {
      if (id === '_springTier') {
        this._springTier++;
      } else if (id === '_tetherTier') {
        this._tetherTier++;
      } else {
        const current = this.purchasedUpgrades.get(id) || 0;
        this.purchasedUpgrades.set(id, current + 1);
      }
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
    this.element.style.opacity = '0';
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 300);
  }
}

export default ShopScreen;
