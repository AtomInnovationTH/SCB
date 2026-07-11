/**
 * BriefingScreen.js — Mission briefing / target selection screen
 * Supports Enter to launch, arrow/tab navigation, auto-select first target.
 * @module ui/BriefingScreen
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { scoringSystem } from '../systems/ScoringSystem.js';
import { decorateGlossary } from '../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';

const SDA_PROVIDERS = [
  'LeoLabs tracking data',
  'ExoAnalytic characterization',
  '18th Space Defense Squadron catalog',
  'ROSCOSMOS ASPOS OKP data',
  'ESA DISCOS database',
];

export class BriefingScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this._targets = [];
    this._selectedIdx = -1;
    this._boundKeyHandler = this._onKeyDown.bind(this);
    this._build();

    // Self-manage visibility + data via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to, payload }) => {
      if (to === GameStates.BRIEFING) {
        // Receive target data from GameFlowManager via GAME_STATE_CHANGE payload
        if (payload && payload.targets) {
          this.setTargets(payload.targets, payload.playerOrbit);
        }
        this.show();
      } else {
        this.hide();
      }
    });
  }

  /** @private */
  _build() {
    this.element = document.createElement('div');
    this.element.id = 'briefing-screen';
    // T9 — briefing is a bottom-third comms overlay over the LIVE scene, not a
    // full-screen blackout. Anchor content to the bottom; a gentle bottom-only
    // gradient scrim keeps the card legible over a bright day-Earth while the
    // top stays clear (scene reveal). pointer-events:none on the shell lets the
    // clear area pass through; the card itself re-enables pointer events.
    this.element.style.cssText = `
      position: absolute; inset: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
      background: linear-gradient(to bottom, rgba(0,0,0,0) 42%, rgba(0,6,18,0.55) 100%);
      z-index: 50; pointer-events: none;
      transition: opacity 0.3s;
    `;

    // NOTE: #briefing-card-panel has no CSS/JS consumer in the app (the panel
    // is styled inline). It is an intentional, stable hook for the local
    // capture/verification driver (tmp/scb_briefing.cjs) and future animation
    // targeting — do not strip it as "unused".
    this.element.innerHTML = `
      <div id="briefing-card-panel" style="pointer-events:auto;width:94%;max-width:900px;
           max-height:54vh;overflow-y:auto;margin:0 0 3vh 0;padding:14px 22px;
           background:rgba(2,12,26,0.82);border:1px solid rgba(0,255,136,0.28);
           border-radius:6px;box-shadow:0 0 30px rgba(0,0,0,0.5),0 0 22px rgba(0,255,136,0.08);
           backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);">
        <div style="text-align:center;margin-bottom:0.9rem;">
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.4);letter-spacing:0.2em;margin-bottom:4px;">
            ▲ GROUND STATION UPLINK ▲
          </div>
          <h2 style="font-size:1.25rem;color:#00ff88;letter-spacing:0.15em;margin:0;
                      text-shadow:0 0 15px rgba(0,255,136,0.4);">
            <span id="briefing-mission-title">MISSION BRIEFING</span>
          </h2>
          <div id="briefing-sda" style="font-size:0.7rem;color:rgba(0,255,136,0.3);margin-top:4px;"></div>
        </div>

        <!-- Mission Context Bar -->
        <div id="briefing-context" style="
          display:flex;justify-content:center;gap:20px;align-items:center;
          background:rgba(0,20,40,0.5);border:1px solid rgba(0,255,136,0.15);
          border-radius:4px;padding:6px 16px;margin-bottom:0.7rem;font-size:0.8rem;">
          <span id="briefing-objective" style="color:rgba(0,255,136,0.7);">Clear 5 debris to reach the depot</span>
          <span style="color:rgba(0,255,136,0.2);">│</span>
          <span style="color:#f0c040;">💰 <b id="briefing-credits">0</b> cr</span>
          <span style="color:rgba(0,255,136,0.2);">│</span>
          <span style="color:rgba(0,255,136,0.6);">Cleared: <b id="briefing-cleared">0</b>/<b>${Constants.WIN_DEBRIS_COUNT}</b></span>
        </div>

        <div style="font-size:0.72rem;color:rgba(0,255,136,0.4);text-align:center;margin-bottom:0.4rem;">
          ↑↓ Arrow keys or Tab to select target
        </div>

        <div id="briefing-targets" style="margin-bottom:0.8rem;"></div>

        <div style="text-align:center;margin-top:0.6rem;">
          <button id="briefing-commence-btn" style="
            font-family:'Courier New',monospace; font-size:1rem; color:#00ff88;
            background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.4);
            padding: 9px 34px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.15em; transition: all 0.3s; opacity: 0.4;
            pointer-events: none;
          ">COMMENCE APPROACH</button>

          <button id="briefing-quickstart-btn" style="
            font-family:'Courier New',monospace; font-size:0.8rem; color:#ffcc00;
            background: rgba(255,204,0,0.08); border: 1px solid rgba(255,204,0,0.3);
            padding: 8px 24px; cursor: pointer; border-radius: 4px;
            margin-left: 12px; transition: all 0.3s;
          ">⚡ QUICK START</button>

          <button id="briefing-skip-btn" style="
            font-family:'Courier New',monospace; font-size:0.8rem; color:rgba(0,255,136,0.5);
            background: transparent; border: 1px solid rgba(0,255,136,0.2);
            padding: 8px 24px; cursor: pointer; border-radius: 4px;
            margin-left: 12px; transition: all 0.3s;
          ">FREE ROAM</button>
        </div>

        <!-- Enter to launch prompt -->
        <div id="briefing-enter-prompt" class="glow-text" style="
          text-align:center; margin-top:0.6rem; font-size:0.85rem;
          color:#00ff88; letter-spacing:0.12em;
          text-shadow: 0 0 12px rgba(0,255,136,0.4);
          opacity: 0.5;
        ">
          ▶ Press ENTER to Launch
        </div>
      </div>
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Button events
    const commenceBtn = this.element.querySelector('#briefing-commence-btn');
    commenceBtn.addEventListener('click', () => {
      this._launchSelected();
    });
    commenceBtn.addEventListener('mouseenter', () => {
      if (this._selectedIdx >= 0) {
        commenceBtn.style.background = 'rgba(0,255,136,0.25)';
        commenceBtn.style.boxShadow = '0 0 15px rgba(0,255,136,0.3)';
      }
    });
    commenceBtn.addEventListener('mouseleave', () => {
      commenceBtn.style.background = 'rgba(0,255,136,0.1)';
      commenceBtn.style.boxShadow = 'none';
    });

    // Quick start button — picks nearest easy target and launches immediately
    const quickStartBtn = this.element.querySelector('#briefing-quickstart-btn');
    quickStartBtn.addEventListener('click', () => {
      this._quickStart();
    });
    quickStartBtn.addEventListener('mouseenter', () => {
      quickStartBtn.style.borderColor = 'rgba(255,204,0,0.6)';
      quickStartBtn.style.background = 'rgba(255,204,0,0.15)';
    });
    quickStartBtn.addEventListener('mouseleave', () => {
      quickStartBtn.style.borderColor = 'rgba(255,204,0,0.3)';
      quickStartBtn.style.background = 'rgba(255,204,0,0.08)';
    });

    const skipBtn = this.element.querySelector('#briefing-skip-btn');
    skipBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.BRIEFING_SKIP);
    });
    skipBtn.addEventListener('mouseenter', () => {
      skipBtn.style.borderColor = 'rgba(0,255,136,0.5)';
    });
    skipBtn.addEventListener('mouseleave', () => {
      skipBtn.style.borderColor = 'rgba(0,255,136,0.2)';
    });
  }

  /** @private Handle keyboard when briefing is visible */
  _onKeyDown(e) {
    if (!this.visible) return;

    switch (e.code) {
      case 'Enter':
        e.preventDefault();
        this._launchSelected();
        break;

      case 'ArrowDown':
        e.preventDefault();
        this._moveSelection(1);
        break;

      case 'ArrowUp':
        e.preventDefault();
        this._moveSelection(-1);
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          this._moveSelection(-1);
        } else {
          this._moveSelection(1);
        }
        break;

      case 'KeyQ':
        // Quick start shortcut
        e.preventDefault();
        this._quickStart();
        break;
    }
  }

  /** @private Move target selection by offset (+1 next, -1 previous) */
  _moveSelection(offset) {
    if (this._targets.length === 0) return;
    let newIdx = this._selectedIdx + offset;
    if (newIdx < 0) newIdx = this._targets.length - 1;
    if (newIdx >= this._targets.length) newIdx = 0;
    this._selectTarget(newIdx);
    audioSystem.playClick();
  }

  /** @private Launch with the currently selected target */
  _launchSelected() {
    if (this._selectedIdx < 0 || this._targets.length === 0) return;
    audioSystem.playClick();
    const target = this._targets[this._selectedIdx];
    eventBus.emit(Events.BRIEFING_COMMENCE, { target });
  }

  /** @private Quick start — pick the easiest nearby target and launch */
  _quickStart() {
    if (this._targets.length === 0) return;
    // Already sorted by deltaV (cheapest first), pick index 0
    this._selectTarget(0);
    audioSystem.playClick();
    const target = this._targets[0];
    eventBus.emit(Events.BRIEFING_COMMENCE, { target });
  }

  /**
   * Populate with available targets.
   * @param {Array} targets - Array of debris data sorted by delta-v
   * @param {object} playerOrbit - Player orbital elements
   */
  setTargets(targets, playerOrbit) {
    this._targets = targets.slice(0, 5); // Show top 5

    // SDA provider flavor text
    const sdaEl = this.element.querySelector('#briefing-sda');
    if (sdaEl) {
      sdaEl.textContent = SDA_PROVIDERS[Math.floor(Math.random() * SDA_PROVIDERS.length)];
    }

    // Update mission context from scoring system
    const stats = scoringSystem.getStats();
    const missionNum = Math.floor(stats.debrisCleared / 5) + 1;
    const debrisUntilShop = 5 - (stats.debrisCleared % 5);

    const titleEl = this.element.querySelector('#briefing-mission-title');
    if (titleEl) titleEl.textContent = `MISSION ${missionNum} BRIEFING`;

    const objectiveEl = this.element.querySelector('#briefing-objective');
    if (objectiveEl) {
      objectiveEl.textContent = debrisUntilShop === 5
        ? 'Clear 5 debris to reach the depot'
        : `Clear ${debrisUntilShop} more debris for depot visit`;
    }

    const creditsEl = this.element.querySelector('#briefing-credits');
    if (creditsEl) creditsEl.textContent = stats.credits.toLocaleString();

    const clearedEl = this.element.querySelector('#briefing-cleared');
    if (clearedEl) clearedEl.textContent = stats.debrisCleared;

    const container = this.element.querySelector('#briefing-targets');
    if (!container) return;

    container.innerHTML = this._targets.map((t, i) => {
      const typeName = t.type === 'rocketBody' ? 'Rocket Body' :
                       t.type === 'defunctSat' ? 'Defunct Satellite' :
                       t.type === 'missionDebris' ? 'Mission Related' : 'Fragment';
      const difficulty = t.deltaV < 0.1 ? 1 : t.deltaV < 0.3 ? 2 : t.deltaV < 0.6 ? 3 : t.deltaV < 1.0 ? 4 : 5;
      const stars = '★'.repeat(difficulty) + '☆'.repeat(5 - difficulty);
      const estFuel = (t.deltaV * 20).toFixed(1); // Rough fuel estimate

      return `
        <div class="briefing-card" data-idx="${i}" style="
          background: rgba(0,20,40,0.6); border: 1px solid rgba(0,255,136,0.2);
          border-radius: 4px; padding: 8px 14px; margin: 6px 0; cursor: pointer;
          transition: all 0.2s; display: flex; justify-content: space-between; align-items: center;
        ">
          <div style="flex:1;">
            <div style="font-size:0.9rem;color:#00ff88;font-weight:bold;">${typeName}</div>
            <div style="font-size:0.75rem;color:rgba(0,255,136,0.5);margin-top:2px;">
              Alt: ${t.altKm.toFixed(0)}km │ Size: ${t.sizeMeter.toFixed(1)}m │ ${t.tracked ? 'Tracked' : 'Untracked'}
            </div>
          </div>
          <div style="text-align:right;min-width:120px;">
            <div style="font-size:0.75rem;color:rgba(0,255,136,0.6);">${decorateGlossary('ΔV', { once: true })}: ${t.deltaV.toFixed(3)} km/s</div>
            <div style="font-size:0.75rem;color:rgba(0,255,136,0.4);">Fuel: ~${estFuel} kg Xe</div>
            <div style="font-size:0.85rem;color:#ffaa00;">${stars}</div>
          </div>
        </div>
      `;
    }).join('');

    // Inline-glossary affordances: the ΔV label deep-links to its Tech Library
    // entry. Capture phase so a term click wins over the card's own select
    // handler (the whole card is clickable).
    ensureGlossaryCss();
    delegateGlossaryClicks(container, { capture: true });

    // Card click selection
    container.querySelectorAll('.briefing-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx);
        this._selectTarget(idx);
        audioSystem.playClick();
      });
      card.addEventListener('mouseenter', () => {
        card.style.borderColor = 'rgba(0,255,136,0.5)';
        card.style.background = 'rgba(0,30,50,0.7)';
      });
      card.addEventListener('mouseleave', () => {
        const selected = parseInt(card.dataset.idx) === this._selectedIdx;
        card.style.borderColor = selected ? '#00ff88' : 'rgba(0,255,136,0.2)';
        card.style.background = selected ? 'rgba(0,255,136,0.1)' : 'rgba(0,20,40,0.6)';
      });
    });

    // Auto-select first target for quick Enter-Enter flow
    if (this._targets.length > 0) {
      this._selectTarget(0);
    } else {
      this._selectedIdx = -1;
    }
  }

  /** @private */
  _selectTarget(idx) {
    this._selectedIdx = idx;

    // Update card visuals
    const cards = this.element.querySelectorAll('.briefing-card');
    cards.forEach((card, i) => {
      const selected = i === idx;
      card.style.borderColor = selected ? '#00ff88' : 'rgba(0,255,136,0.2)';
      card.style.background = selected ? 'rgba(0,255,136,0.1)' : 'rgba(0,20,40,0.6)';
    });

    // Enable commence button
    const btn = this.element.querySelector('#briefing-commence-btn');
    if (btn) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }

    // Update enter prompt visibility
    const enterPrompt = this.element.querySelector('#briefing-enter-prompt');
    if (enterPrompt) {
      enterPrompt.style.opacity = idx >= 0 ? '1' : '0.5';
    }
  }

  show() {
    this.visible = true;
    this.element.style.display = 'flex';
    this.element.style.opacity = '1';
    // Listen for keyboard input while briefing is shown
    window.addEventListener('keydown', this._boundKeyHandler);
  }

  hide() {
    this.visible = false;
    this.element.style.opacity = '0';
    window.removeEventListener('keydown', this._boundKeyHandler);
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 300);
  }
}

export default BriefingScreen;
