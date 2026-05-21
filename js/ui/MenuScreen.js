/**
 * MenuScreen.js — Main menu / start screen overlay
 * Supports Enter key to start, F key for Fast Start (skip briefing).
 * @module ui/MenuScreen
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { persistenceManager } from '../systems/PersistenceManager.js';

export class MenuScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this._boundKeyHandler = this._onKeyDown.bind(this);
    this._build();

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      if (to === GameStates.MENU) this.show();
      else this.hide();
    });
  }

  /** @private */
  _build() {
    this.element = document.createElement('div');
    this.element.id = 'menu-screen';
    this.element.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: radial-gradient(ellipse at center, rgba(6,24,60,0.55) 0%, rgba(2,12,35,0.68) 50%, rgba(0,6,20,0.78) 100%);
      z-index: 50; pointer-events: auto; transition: opacity 0.5s;
    `;

    this.element.innerHTML = `
      <div style="text-align:center;max-width:600px;padding:20px;">
        <h1 style="font-family:'Courier New',monospace; font-size:3.5rem; color:#00ff88;
                    letter-spacing:0.3em; margin-bottom:0.5rem;
                    text-shadow: 0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3);">
          SPACE COWBOY
        </h1>
        <div style="font-size:1.1rem; color:rgba(0,255,136,0.6); letter-spacing:0.15em;
                     margin-bottom:2rem;">
          Active Debris Remediation
        </div>

        <div style="margin:2rem 0;">
          <button id="menu-start-btn" style="
            font-family:'Courier New',monospace; font-size:1.2rem; color:#00ff88;
            background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.5);
            padding: 14px 48px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.2em; transition: all 0.3s;
            text-shadow: 0 0 10px rgba(0,255,136,0.5);
          ">
            START MISSION
          </button>
        </div>

        <div id="menu-continue-wrapper" style="margin:0.5rem 0;display:none;">
          <button id="menu-continue-btn" style="
            font-family:'Courier New',monospace; font-size:1.0rem; color:#ffaa00;
            background: rgba(255,170,0,0.08); border: 2px solid rgba(255,170,0,0.4);
            padding: 10px 40px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.15em; transition: all 0.3s;
            text-shadow: 0 0 10px rgba(255,170,0,0.3);
          ">
            CONTINUE
          </button>
        </div>

        <!-- Prominent "Press Return to start" prompt -->
        <div id="menu-enter-prompt" class="glow-text" style="
          font-size:1.0rem; color:#00ff88; letter-spacing:0.15em;
          margin-top:0.5rem; margin-bottom:1.5rem;
          text-shadow: 0 0 15px rgba(0,255,136,0.5);
        ">
          ▶ Press Return to start
        </div>

        <!-- ADR ecosystem credits — mouse over each name for details
             (uses the browser-native 'title' tooltip; zero-JS, accessible). -->
        <style>
          .adr-name {
            color: rgba(0,255,136,0.78);
            cursor: help;
            border-bottom: 1px dotted rgba(0,255,136,0.3);
            display: inline-block;
            padding: 1px 2px;
            transition: color 0.15s, text-shadow 0.15s;
          }
          .adr-name:hover {
            color: #00ff88;
            text-shadow: 0 0 6px rgba(0,255,136,0.5);
          }
          .adr-section {
            font-size: 0.65rem;
            color: rgba(0,255,136,0.35);
            letter-spacing: 0.1em;
            text-transform: uppercase;
            margin: 0.6rem 0 0.2rem;
          }
          .adr-list { margin: 0; padding: 0; list-style: none; line-height: 1.6; }
          .adr-list li { font-size: 0.78rem; }
          .adr-sub { color: rgba(0,255,136,0.4); font-size: 0.7rem; margin-left: 4px; }
        </style>
        <div style="margin-top:1.2rem; font-size:0.8rem; color:rgba(0,255,136,0.4);
                     line-height:1.5; max-width:560px; text-align:center;">
          <p style="margin-bottom:0.4rem;">
            Inspired by Active Debris Removal (ADR) companies and missions:
          </p>

          <div class="adr-section">Pioneers</div>
          <ul class="adr-list">
            <li><span class="adr-name" title="Tokyo-HQ commercial ADR pure-play. ADRAS-J completed close-proximity inspection of a derelict H-IIA upper stage; ELSA-M launch contract signed with Isar Aerospace. Holdings + Japan + UK + US.">Astroscale</span></li>
            <li><span class="adr-name" title="Swiss start-up developing ClearSpace-1 — the first commercial mission to capture and deorbit a real piece of space debris (VESPA payload adapter). ESA-contracted.">ClearSpace</span></li>
            <li><span class="adr-name" title="European Space Agency — funded ClearSpace-1 (€86 M) and runs the Clean Space initiative on debris mitigation, design-for-demise and active removal.">ESA</span></li>
          </ul>

          <div class="adr-section">International programs</div>
          <ul class="adr-list">
            <li><span class="adr-name" title="Japan Aerospace Exploration Agency — sponsors the Commercial Removal of Debris Demonstration (CRD2). Phase II will capture and deorbit the H-IIA upper stage following ADRAS-J. Ongoing program with Astroscale.">JAXA</span> <span class="adr-sub">CRD2 program</span></li>
          </ul>

          <div class="adr-section">India's ADR ecosystem</div>
          <ul class="adr-list">
            <li><span class="adr-name" title="Hyderabad. Lead developer of an in-orbit debris-removal demonstration mission. Partnered with Pixxel for the satellite bus; mission announced 31 Mar 2026.">Cosmoserve Space</span> <span class="adr-sub">Hyderabad</span></li>
            <li><span class="adr-name" title="Bengaluru. Supplying the satellite bus for Cosmoserve's ADR demo mission. Best known for the hyperspectral Earth-observation constellation; this is its first ADR involvement.">Pixxel Space</span> <span class="adr-sub">Bengaluru</span></li>
            <li><span class="adr-name" title="Bengaluru. Space Situational Awareness (SSA) — debris tracking & cataloguing. Signed an MoU with Astroscale Japan in March 2025 to jointly pursue ADR & in-orbit servicing.">Digantara</span> <span class="adr-sub">Bengaluru</span></li>
            <li><span class="adr-name" title="Bengaluru. Propulsion + orbital mobility for servicer spacecraft. Partnered with Astroscale Japan (March 2025) for debris removal and sustainable in-orbit mobility.">Bellatrix Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
            <li><span class="adr-name" title="Bengaluru. Founded 2021 by IISc alumni. Building an orbital module to refuel, repair, reposition and de-orbit satellites. Reduces debris by extending satellite life.">OrbitAID Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
            <li><span class="adr-name" title="India. Green propulsion + debris collision-avoidance modules ('I-Booster' for 100–500 kg LEO sats). Focus is debris prevention/avoidance rather than removal.">Manastu Space</span> <span class="adr-sub">India</span></li>
          </ul>

          <div class="adr-section">Partnerships</div>
          <ul class="adr-list">
            <li><span class="adr-name" title="Cross-border MoUs (March 2025) targeting joint ADR & in-orbit servicing offerings, with Astroscale Japan explicitly eyeing the Indian market. Active partnership.">Astroscale ↔ Digantara / Bellatrix</span> <span class="adr-sub">JP ↔ IN</span></li>
          </ul>

          <p style="color:rgba(0,255,136,0.35); margin-top:0.8rem; font-size:0.7rem; font-style:italic;">
            India's ADR ecosystem is at an early demonstration / partnership stage — no Indian-led ADR mission has flown yet. ISRO has stated debris-mitigation goals; operational activity is driven by these private start-ups and collaborations with Astroscale Japan.
          </p>
          <p style="color:rgba(0,255,136,0.35); margin-top:0.8rem; font-size:0.72rem;">
            ⚠ 35,000+ tracked debris objects threaten $1T+ in orbital assets.
            Removing just 5 large objects per year could stabilize the orbital environment.
          </p>
        </div>

        <div style="margin-top:3rem; font-size:0.7rem; color:rgba(0,255,136,0.2);">
          WASD to fly • G deploy arm • Tab to target • P pilot arm
        </div>
        <div style="margin-top:0.3rem; font-size:0.7rem; color:rgba(0,255,136,0.3);">
          M = Orbit View • V = Cycle Camera • N = Radar • B = Shop
        </div>
      </div>
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Button interactions — Start
    const btn = this.element.querySelector('#menu-start-btn');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(0,255,136,0.25)';
      btn.style.borderColor = '#00ff88';
      btn.style.boxShadow = '0 0 20px rgba(0,255,136,0.3)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(0,255,136,0.1)';
      btn.style.borderColor = 'rgba(0,255,136,0.5)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => {
      this._startGame();
    });

    // Button interactions — Continue
    const continueBtn = this.element.querySelector('#menu-continue-btn');
    if (continueBtn) {
      continueBtn.addEventListener('mouseenter', () => {
        continueBtn.style.background = 'rgba(255,170,0,0.2)';
        continueBtn.style.borderColor = '#ffaa00';
        continueBtn.style.boxShadow = '0 0 20px rgba(255,170,0,0.3)';
      });
      continueBtn.addEventListener('mouseleave', () => {
        continueBtn.style.background = 'rgba(255,170,0,0.08)';
        continueBtn.style.borderColor = 'rgba(255,170,0,0.4)';
        continueBtn.style.boxShadow = 'none';
      });
      continueBtn.addEventListener('click', () => {
        this._continueGame();
      });
    }
  }

  /** @private Handle keyboard when menu is visible */
  _onKeyDown(e) {
    if (!this.visible) return;

    // 2026-05-17 rollback: revert from "any key" to "Press Return to start".
    // The any-key behaviour was too easy to trigger by accident (e.g. the
    // user tapping Cmd+Shift+R for a hard refresh would blow past the menu).
    // Enter/Return (or NumpadEnter) starts normally; KeyF keeps its
    // dedicated "fast start" shortcut (skip briefing).
    if (e.code === 'KeyF' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this._fastStart();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this._startGame();
    }
  }

  /** @private Start game (go to briefing) */
  _startGame() {
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    eventBus.emit(Events.MENU_START);
  }

  /** @private Fast start — skip briefing, pick nearest easy target */
  _fastStart() {
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    eventBus.emit(Events.MENU_FAST_START);
  }

  /** @private Continue from saved game */
  _continueGame() {
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    eventBus.emit(Events.MENU_CONTINUE);
  }

  show() {
    this.visible = true;
    // Toggle Continue button visibility based on whether a save exists
    const continueWrapper = this.element.querySelector('#menu-continue-wrapper');
    if (continueWrapper) {
      continueWrapper.style.display = persistenceManager.hasSave() ? 'block' : 'none';
    }
    this.element.style.display = 'flex';
    this.element.style.opacity = '1';
    // Listen for keyboard input while menu is shown
    window.addEventListener('keydown', this._boundKeyHandler);
  }

  hide() {
    this.visible = false;
    this.element.style.opacity = '0';
    window.removeEventListener('keydown', this._boundKeyHandler);
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 500);
  }
}

export default MenuScreen;
