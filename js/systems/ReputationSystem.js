import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/**
 * ReputationSystem — tracks standing with 5 partner entities.
 * News-event captures boost partner rep. Generic captures boost India (home base).
 * Tier thresholds unlock perks (refuel discounts, priority contracts, cosmetic flags).
 *
 * Epic 8 — ST-8.4.8
 */
export class ReputationSystem {
  constructor() {
    /** @type {Object<string, {rep: number, name: string}>} */
    this.partners = {
      USA:      { rep: 20, name: 'United States (NASA/USSF)' },
      SpaceX:   { rep: 10, name: 'SpaceX' },
      Thailand: { rep: 0,  name: 'Thailand (NBTC/GISTDA)' },
      ESA:      { rep: 15, name: 'European Space Agency' },
      India:    { rep: 30, name: 'India (ISRO)' },  // Mother launches from India
    };

    /** Tier definitions — threshold is minimum rep to reach that tier */
    this.tiers = [
      { threshold: 0,  label: 'Unknown',   perks: [] },
      { threshold: 25, label: 'Trusted',   perks: ['discount_refuel_10'] },
      { threshold: 50, label: 'Preferred', perks: ['discount_refuel_20', 'priority_contracts'] },
      { threshold: 75, label: 'Allied',    perks: ['discount_refuel_30', 'priority_contracts', 'cosmetic_flag'] },
    ];

    this._unsubs = [];
    this._setupListeners();
  }

  _setupListeners() {
    // News event captures — the NEWS_EVENT_TRIGGERED carries partner info
    // The actual rep boost happens when the player COMPLETES the news mission (captures the target).
    // We listen for INTERACTION_CAPTURE with a newsPartner field set by MissionEventSystem.
    // For now, we also listen for NEWS_EVENT_TRIGGERED to award a small "mission accepted" bonus.
    this._unsubs.push(eventBus.on(Events.NEWS_EVENT_TRIGGERED, (data) => {
      // Small rep boost just for unlocking the mission
      if (data.partner) {
        this._addRep(data.partner, 5);
      }
    }));

    // Generic captures boost India (home base) by 1
    this._unsubs.push(eventBus.on(Events.INTERACTION_CAPTURE, () => {
      this._addRep('India', 1);
    }));

    this._unsubs.push(eventBus.on(Events.INTERACTION_DEORBIT, () => {
      this._addRep('India', 1);
    }));

    // Reset on game reset
    this._unsubs.push(eventBus.on(Events.GAME_RESET, () => {
      this.reset();
    }));
  }

  /**
   * Add reputation to a partner. Emits 'reputation:tierUp' on tier change.
   * @param {string} partnerId — key in this.partners
   * @param {number} amount — rep points to add (can be negative)
   */
  _addRep(partnerId, amount) {
    const partner = this.partners[partnerId];
    if (!partner) return;

    const oldTier = this._getTier(partner.rep);
    partner.rep = Math.max(0, Math.min(100, partner.rep + amount));
    const newTier = this._getTier(partner.rep);

    if (newTier > oldTier) {
      eventBus.emit('reputation:tierUp', {
        partner: partnerId,
        tier: newTier,
        label: this.tiers[newTier].label,
        perks: this.tiers[newTier].perks
      });
    }
  }

  /**
   * Return tier index for a given rep value.
   */
  _getTier(rep) {
    let tier = 0;
    for (let i = this.tiers.length - 1; i >= 0; i--) {
      if (rep >= this.tiers[i].threshold) { tier = i; break; }
    }
    return tier;
  }

  /**
   * Get full info for a partner including tier/perks.
   */
  getPartnerInfo(partnerId) {
    const partner = this.partners[partnerId];
    if (!partner) return null;
    const tier = this._getTier(partner.rep);
    return {
      rep: partner.rep,
      name: partner.name,
      tier,
      tierLabel: this.tiers[tier].label,
      perks: this.tiers[tier].perks
    };
  }

  /**
   * Get all partners with full info.
   */
  getAllPartners() {
    return Object.entries(this.partners).map(([id, _p]) => ({
      id, ...this.getPartnerInfo(id)
    }));
  }

  reset() {
    this.partners.USA.rep = 20;
    this.partners.SpaceX.rep = 10;
    this.partners.Thailand.rep = 0;
    this.partners.ESA.rep = 15;
    this.partners.India.rep = 30;
  }

  dispose() {
    this._unsubs.forEach(fn => typeof fn === 'function' && fn());
    this._unsubs = [];
  }
}
