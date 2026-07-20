/**
 * GameOverScreen.js — Game over and victory screen
 * @module ui/GameOverScreen
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GameStates } from '../core/GameState.js';
import { getMissionProgress } from '../core/missionProgress.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { scoringSystem } from '../systems/ScoringSystem.js';

const GAME_OVER_REASONS = {
  kessler: 'KESSLER CASCADE EVENT',
  collision: 'COLLISION WITH ACTIVE SATELLITE',
  debris: 'CATASTROPHIC DEBRIS COLLISION',
  fuel: 'FUEL DEPLETED. STRANDED IN ORBIT',
  reentry: 'UNCONTROLLED REENTRY',
  // NOTE: no 'battery' reason. Battery depletion folds into 'fuel'
  // (ResourceSystem fires RESOURCE_DEPLETED{reason:'fuel'} only when xenon AND
  // coldGas AND battery are all 0; battery self-recharges in sunlight/RTG/beam,
  // so a battery-alone death is transient by design). A real power-failure
  // death mechanic is a backlog item (ROADMAP §7, via PowerDistribution).
};

const ADR_FACTS = [
  'In reality, removing just 5 large objects per year could stabilize the orbital environment.',
  'The Kessler Syndrome was first proposed by NASA scientist Donald J. Kessler in 1978.',
  'There are over 36,500 objects larger than 10cm tracked in Earth orbit.',
  'A 1cm paint fleck traveling at orbital velocity carries the energy of a hand grenade.',
  'Astroscale\'s ELSA-d mission demonstrated magnetic capture of a client satellite in 2021.',
  'ESA\'s ClearSpace-1 will be the first mission to remove an existing piece of debris.',
  'The 2009 Iridium 33 / Cosmos 2251 collision created over 2,300 tracked fragments.',
  'At LEO altitudes, orbital debris travels at approximately 7.8 km/s (17,500 mph).',
];

export class GameOverScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this._isWin = false;
    this._shopScreen = null;
    /** @type {'debris'|'elevator'} which win path triggered (Phase E). */
    this._winType = 'debris';
    /** @type {number} kg delivered to the GEO anchor (elevator win). */
    this._winTotalMassKg = 0;
    this._build();

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to, payload }) => {
      if (to === GameStates.GAME_OVER) this.showGameOver(payload);
      else if (to === GameStates.WIN) this.showVictory();
      else this.hide();
    });

    // Phase E: capture the win variant. GAME_WIN is emitted immediately before
    // the WIN state transition, so this runs before showVictory() reads it.
    eventBus.on(Events.GAME_WIN, (data) => {
      this._winType = (data && data.winType) || 'debris';
      this._winTotalMassKg = (data && typeof data.totalMassKg === 'number') ? data.totalMassKg : 0;
    });
  }

  /**
   * Set the shop screen reference for reading upgrade count.
   * @param {import('./ShopScreen.js').ShopScreen} shop
   */
  setShopScreen(shop) {
    this._shopScreen = shop;
  }

  /** @private */
  _build() {
    this.element = document.createElement('div');
    this.element.id = 'gameover-screen';
    this.element.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.9); z-index: 50; pointer-events: auto;
      transition: opacity 0.5s;
    `;

    this.element.innerHTML = `
      <div style="text-align:center;max-width:550px;padding:20px;">
        <h1 id="gameover-title" style="font-family:'Courier New',monospace; font-size:2.5rem;
            letter-spacing:0.2em; margin-bottom:0.5rem;
            text-shadow: 0 0 30px rgba(255,68,68,0.6);"></h1>
        <div id="gameover-reason" style="font-size:0.9rem;margin-bottom:1.5rem;"></div>

        <div id="gameover-stats" style="
          background: rgba(0,20,40,0.6); border: 1px solid rgba(0,255,136,0.2);
          border-radius: 4px; padding: 16px; margin: 1rem 0; text-align: left;
          font-size: 0.85rem; line-height: 1.8;
        "></div>

        <div id="gameover-fact" style="
          font-size: 0.75rem; color: rgba(0,255,136,0.4); margin: 1.5rem 0;
          font-style: italic; line-height: 1.5;
        "></div>

        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:1.5rem;">
          <button id="gameover-retry-btn" style="
            font-family:'Courier New',monospace; font-size:0.9rem; color:#00ff88;
            background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.4);
            padding: 10px 30px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.1em; transition: all 0.3s;
          ">TRY AGAIN</button>
          <button id="gameover-continue-btn" style="
            font-family:'Courier New',monospace; font-size:0.9rem; color:#ffaa00;
            background: rgba(255,170,0,0.1); border: 2px solid rgba(255,170,0,0.4);
            padding: 10px 30px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.1em; transition: all 0.3s;
          ">CONTINUE (KEEP UPGRADES)</button>
          <button id="gameover-menu-btn" style="
            font-family:'Courier New',monospace; font-size:0.9rem; color:rgba(0,255,136,0.6);
            background: transparent; border: 1px solid rgba(0,255,136,0.2);
            padding: 10px 30px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.1em; transition: all 0.3s;
          ">MAIN MENU</button>
        </div>
      </div>
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Button events
    const retryBtn = this.element.querySelector('#gameover-retry-btn');
    retryBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.GAMEOVER_RETRY);
    });
    retryBtn.addEventListener('mouseenter', () => {
      retryBtn.style.background = 'rgba(0,255,136,0.25)';
      retryBtn.style.boxShadow = '0 0 15px rgba(0,255,136,0.3)';
    });
    retryBtn.addEventListener('mouseleave', () => {
      retryBtn.style.background = 'rgba(0,255,136,0.1)';
      retryBtn.style.boxShadow = 'none';
    });

    const continueBtn = this.element.querySelector('#gameover-continue-btn');
    continueBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.GAMEOVER_CONTINUE);
    });
    continueBtn.addEventListener('mouseenter', () => {
      continueBtn.style.background = 'rgba(255,170,0,0.25)';
      continueBtn.style.boxShadow = '0 0 15px rgba(255,170,0,0.3)';
    });
    continueBtn.addEventListener('mouseleave', () => {
      continueBtn.style.background = 'rgba(255,170,0,0.1)';
      continueBtn.style.boxShadow = 'none';
    });

    const menuBtn = this.element.querySelector('#gameover-menu-btn');
    menuBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.GAMEOVER_MENU);
    });
    menuBtn.addEventListener('mouseenter', () => {
      menuBtn.style.borderColor = 'rgba(0,255,136,0.5)';
    });
    menuBtn.addEventListener('mouseleave', () => {
      menuBtn.style.borderColor = 'rgba(0,255,136,0.2)';
    });
  }

  /**
   * Show game over screen with reason.
   * @param {string} reason - Key from GAME_OVER_REASONS
   */
  showGameOver(reason) {
    this._isWin = false;

    const titleEl = this.element.querySelector('#gameover-title');
    const reasonEl = this.element.querySelector('#gameover-reason');
    const statsEl = this.element.querySelector('#gameover-stats');
    const factEl = this.element.querySelector('#gameover-fact');

    titleEl.textContent = 'MISSION FAILED';
    titleEl.style.color = '#ff4444';
    titleEl.style.textShadow = '0 0 30px rgba(255,68,68,0.6)';

    reasonEl.style.color = '#ff6644';
    reasonEl.textContent = GAME_OVER_REASONS[reason] || reason || 'Unknown failure';

    const stats = scoringSystem.getStats();
    const credits = scoringSystem.credits || 0;
    const carriedCredits = Math.floor(credits * 0.5);
    // Mission number shares the clamped mission-arc math with the Briefing card
    // and continue-flow comms via getMissionProgress (js/core/missionProgress.js)
    // so a boundary death at exactly WIN_DEBRIS_COUNT never drifts to "Mission 13".
    const { missionNum } = getMissionProgress(stats.debrisCleared);
    const upgradeCount = this._getUpgradeCount();
    statsEl.innerHTML = `
      <div style="color:#00ff88;font-size:0.95rem;margin-bottom:6px;">Mission ${missionNum} Summary</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;">
        <div>Score: <b style="color:#ffaa00;">${stats.totalScore.toLocaleString()}</b></div>
        <div>Credits: <b style="color:#f0c040;">${credits.toLocaleString()} cr</b></div>
        <div>Debris Cleared: <b>${stats.debrisCleared}</b></div>
        <div>Best Streak: <b>${stats.bestStreak}</b></div>
        <div>Upgrades: <b>${upgradeCount}</b></div>
        <div>Time: <b>${stats.timePlayed}</b></div>
      </div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,255,136,0.1);font-size:0.8rem;opacity:0.7;">
        ├ Data Captures: ${stats.debrisByTier.data}
        · Deorbits: ${stats.debrisByTier.deorbit}
        · Physical: ${stats.debrisByTier.capture}
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,170,0,0.2);">
        <span style="color:#f0c040;">Continue carries: <b>${carriedCredits.toLocaleString()} cr</b> (50%) + ${upgradeCount} upgrades</span>
      </div>
    `;

    // Show continue button on game over, reset retry button text (may say "PLAY AGAIN" after a win)
    const retryBtn = this.element.querySelector('#gameover-retry-btn');
    if (retryBtn) retryBtn.textContent = 'TRY AGAIN';
    const continueBtn = this.element.querySelector('#gameover-continue-btn');
    if (continueBtn) continueBtn.style.display = '';

    factEl.textContent = '💡 ' + ADR_FACTS[Math.floor(Math.random() * ADR_FACTS.length)];

    // Play game over sound
    audioSystem.playGameOver();

    this.show();
  }

  /**
   * Show victory screen.
   */
  showVictory() {
    this._isWin = true;
    if (this._winType === 'elevator') {
      this._showElevatorVictory();
    } else {
      this._showDebrisVictory();
    }
    // Rename retry button + hide continue (shared across both win variants)
    const retryBtn = this.element.querySelector('#gameover-retry-btn');
    if (retryBtn) retryBtn.textContent = 'PLAY AGAIN';
    const continueBtn = this.element.querySelector('#gameover-continue-btn');
    if (continueBtn) continueBtn.style.display = 'none';
    audioSystem.playVictory();
    this.show();
  }

  /**
   * @private Phase E — the anchor-run / elevator win cinematic. Headline is the
   * tonnage delivered to the GEO anchor; closes on the JWST narration.
   */
  _showElevatorVictory() {
    const titleEl = this.element.querySelector('#gameover-title');
    const reasonEl = this.element.querySelector('#gameover-reason');
    const statsEl = this.element.querySelector('#gameover-stats');
    const factEl = this.element.querySelector('#gameover-fact');

    titleEl.textContent = 'ANCHOR SET';
    titleEl.style.color = '#00ff88';
    titleEl.style.textShadow = '0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3)';

    reasonEl.style.color = '#00ff88';
    reasonEl.textContent = 'The GEO anchor contract is complete. The space elevator has its counterweight. Built from the sky you cleared.';

    const stats = scoringSystem.getStats();
    const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
    const massKg = Math.round(this._winTotalMassKg || target);
    statsEl.innerHTML = `
      <div style="color:#00ff88;font-size:1rem;margin-bottom:8px;">★ GEO Anchor Contract. Delivered ★</div>
      <div style="text-align:center;margin:10px 0;">
        <div style="font-size:2.2rem;color:#ffaa00;font-weight:bold;text-shadow:0 0 20px rgba(255,170,0,0.4);">${massKg.toLocaleString()} kg</div>
        <div style="font-size:0.8rem;opacity:0.75;">delivered to the GEO anchor</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;">
        <div>Final Score: <b style="color:#ffaa00;">${stats.totalScore.toLocaleString()}</b></div>
        <div>Credits: <b style="color:#f0c040;">${stats.credits.toLocaleString()} cr</b></div>
        <div>Debris Cleared: <b style="color:#00ff88;">${stats.debrisCleared}</b></div>
        <div>Time: <b>${stats.timePlayed}</b></div>
      </div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,255,136,0.15);font-size:0.85rem;color:#00ff88;">
        A million miles out at L2, JWST watches a sky you helped clear. That's the job, Cowboy. ★
      </div>
    `;

    factEl.textContent = '🌍 ' + ADR_FACTS[Math.floor(Math.random() * ADR_FACTS.length)];
  }

  /**
   * @private The standard (WIN_DEBRIS_COUNT) stabilization victory.
   */
  _showDebrisVictory() {
    const titleEl = this.element.querySelector('#gameover-title');
    const reasonEl = this.element.querySelector('#gameover-reason');
    const statsEl = this.element.querySelector('#gameover-stats');
    const factEl = this.element.querySelector('#gameover-fact');

    titleEl.textContent = 'MISSION COMPLETE';
    titleEl.style.color = '#00ff88';
    titleEl.style.textShadow = '0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3)';

    reasonEl.style.color = '#00ff88';
    reasonEl.textContent = 'The orbital environment has been stabilized. Outstanding work, Cowboy.';

    const stats = scoringSystem.getStats();
    // Missions completed — shares the clamped mission-arc math with the Briefing
    // card, death summary, and continue-flow comms via getMissionProgress
    // (js/core/missionProgress.js) so the victory count can never drift.
    const { missionsCompleted: missionCount } = getMissionProgress(stats.debrisCleared);
    const upgradeCount = this._getUpgradeCount();
    statsEl.innerHTML = `
      <div style="color:#00ff88;font-size:1rem;margin-bottom:8px;">★ Final Report ★</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;">
        <div>Final Score: <b style="color:#ffaa00;font-size:1.1rem;">${stats.totalScore.toLocaleString()}</b></div>
        <div>Credits Earned: <b style="color:#f0c040;">${stats.credits.toLocaleString()} cr</b></div>
        <div>Debris Cleared: <b style="color:#00ff88;">${stats.debrisCleared}</b></div>
        <div>Best Streak: <b>${stats.bestStreak}</b></div>
        <div>Missions: <b>${missionCount}</b></div>
        <div>Upgrades: <b>${upgradeCount}</b></div>
        <div>Time: <b>${stats.timePlayed}</b></div>
      </div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,255,136,0.1);font-size:0.8rem;opacity:0.7;">
        ├ Data: ${stats.debrisByTier.data}
        · Deorbits: ${stats.debrisByTier.deorbit}
        · Physical: ${stats.debrisByTier.capture}
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,255,136,0.2);">
        Rating: <b style="color:#ffaa00;">${this._getRating(stats)}</b>
      </div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,255,136,0.15);font-size:0.85rem;color:#00ff88;">
        Houston: That orbit's clear thanks to you. Take a breather, Cowboy. There's always another field of debris up there when you're ready. ★
      </div>
    `;

    factEl.textContent = '🌍 ' + ADR_FACTS[Math.floor(Math.random() * ADR_FACTS.length)];
  }

  /** @private Get total upgrade count from shop screen */
  _getUpgradeCount() {
    if (!this._shopScreen) return 0;
    let count = 0;
    for (const [, lvl] of this._shopScreen.purchasedUpgrades) count += lvl;
    return count;
  }

  /** @private Get rating based on stats */
  _getRating(stats) {
    // E1/E4 recalibration: bands re-derived from scripted full-run score data
    // AFTER the ledger split (sales no longer inflate score) AND the 60-clear
    // retune. Simulated full runs score ~53k (low skill) → ~96k (high skill), so
    // the old 8k/15k/30k/50k bands saturated at ACE for everyone. These bands
    // separate a died-early partial run (ROOKIE) from a skilled completion (ACE).
    const score = stats.totalScore;
    if (score >= 95000) return '★★★★★ ACE COWBOY';
    if (score >= 78000) return '★★★★☆ VETERAN';
    if (score >= 60000) return '★★★☆☆ PROFESSIONAL';
    if (score >= 45000) return '★★☆☆☆ APPRENTICE';
    return '★☆☆☆☆ ROOKIE';
  }

  show() {
    this.visible = true;
    this.element.style.display = 'flex';
    // Fade in
    this.element.style.opacity = '0';
    requestAnimationFrame(() => {
      this.element.style.opacity = '1';
    });
  }

  hide() {
    this.visible = false;
    this.element.style.opacity = '0';
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 500);
  }
}

export default GameOverScreen;
