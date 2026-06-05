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
import { MenuScene3D } from './MenuScene3D.js';

export class MenuScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this._menuScene3D = null;
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
      display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
      background: radial-gradient(ellipse at center, rgba(6,24,60,0.55) 0%, rgba(2,12,35,0.68) 50%, rgba(0,6,20,0.78) 100%);
      z-index: 50; pointer-events: auto; transition: opacity 0.5s; overflow-y: auto;
    `;

    this.element.innerHTML = `
      <style>
        /* ── MenuScreen layout ── */
        #menu-content {
          width: 100%;
          height: 100%;
          position: relative;
          box-sizing: border-box;
          font-family: 'Courier New', monospace;
        }
        #menu-header {
          text-align: center;
          position: absolute;
          top: 18%; left: 50%;
          transform: translate(-50%, 0);
          width: 40%;
          min-width: 320px;
        }
        #menu-body { display: contents; }
        #menu-left {
          position: absolute;
          top: 20px; left: 20px;
          width: 25%;
          max-height: calc(100% - 40px);
          overflow-y: auto;
        }
        #menu-right {
          position: absolute;
          top: 20px; right: 20px;
          width: 25%;
          max-height: calc(100% - 40px);
          overflow-y: auto;
        }
        @media (max-width: 900px) {
          #menu-header { position: relative; top: auto; left: auto; transform: none; width: 100%; padding: 16px; }
          #menu-body   { display: block; padding: 0 16px; }
          #menu-left   { position: relative; top: auto; left: auto; width: 100%; max-height: none; }
          #menu-right  { position: relative; top: auto; right: auto; width: 100%; max-height: none;
                         border-top: 1px solid rgba(0,255,136,0.15); padding-top: 1rem; margin-top: 1rem; }
        }
        /* ── ADR credits ── */
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
        .adr-list  { margin: 0; padding: 0; list-style: none; line-height: 1.6; }
        .adr-list li { font-size: 0.78rem; }
        .adr-sub   { color: rgba(0,255,136,0.4); font-size: 0.7rem; margin-left: 4px; }
      </style>

      <div id="menu-content">

        <!-- ══ HEADER (full-width, centered) ══ -->
        <div id="menu-header">
          <h1 style="font-family:'Courier New',monospace; font-size:3.5rem; color:#00ff88;
                      letter-spacing:0.3em; margin-bottom:0.5rem; white-space:nowrap;
                      text-shadow: 0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3);">
            SPACE COWBOY<span style="font-size:0.5em; letter-spacing:0.1em; margin-left:0.4em; vertical-align:0.15em; color:rgba(0,255,136,0.6);">v.92</span>
          </h1>
          <div style="font-size:1.1rem; color:rgba(0,255,136,0.6); letter-spacing:0.15em;
                       margin-bottom:1.5rem;">
            Active Debris Remediation (ADR)
          </div>

          <!-- START MISSION button — label carries both click and Enter hint -->
          <div style="margin:0 0 0.8rem;">
            <button id="menu-start-btn" style="
              font-family:'Courier New',monospace; color:#00ff88;
              background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.5);
              padding: 12px 48px 10px; cursor: pointer; border-radius: 4px;
              letter-spacing: 0.2em; transition: all 0.3s;
              text-shadow: 0 0 10px rgba(0,255,136,0.5);
              line-height: 1;
            ">
              <div style="font-size:1.2rem;">▶ START MISSION</div>
              <div style="font-size:0.72rem; opacity:0.55; letter-spacing:0.1em; margin-top:5px;">
                Press Enter or Click
              </div>
            </button>
          </div>

          <!-- CONTINUE button (hidden until a save exists) -->
          <div id="menu-continue-wrapper" style="margin:0.5rem 0; display:none;">
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
        </div><!-- /#menu-header -->

        <!-- ══ TWO-PANEL BODY ══ -->
        <div id="menu-body">

          <!-- ── LEFT PANEL (top-left 25%) ── -->
          <div id="menu-left">

            <!-- Story / overview text -->
            <div style="margin-bottom:1rem; font-size:0.78rem; color:rgba(0,255,136,0.45);
                         line-height:1.65; padding:0 2px;">
              <p style="color:rgba(0,255,136,0.6); margin:0 0 0.45rem; font-weight:bold;">
                35,000+ tracked debris objects threaten orbital assets.
              </p>
              <p style="margin:0;">
                Removing just 5 large objects per year could stabilize the orbital environment.
              </p>
            </div>

            <!-- Companies list -->
            <div style="font-size:0.8rem; color:rgba(0,255,136,0.4); line-height:1.5;">
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
            </div>

          </div><!-- /#menu-left -->

          <!-- ── RIGHT PANEL (top-right 25%) ── -->
          <div id="menu-right">

            <!-- 3D hero scene: astronaut repairing Mother Satellite -->
            <canvas id="menu-scene-3d" style="width:100%; height:100%; min-height:300px;
                     border-radius:4px; display:block;"></canvas>

          </div><!-- /#menu-right -->

        </div><!-- /#menu-body -->
      </div><!-- /#menu-content -->
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Initialise 3D hero scene
    const canvas3d = this.element.querySelector('#menu-scene-3d');
    if (canvas3d) {
      try {
        this._menuScene3D = new MenuScene3D();
        this._menuScene3D.init(canvas3d);
      } catch (err) {
        console.warn('MenuScene3D init failed (fallback to blank):', err);
        this._menuScene3D = null;
      }
    }

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
    // Start 3D scene
    if (this._menuScene3D) this._menuScene3D.start();
  }

  hide() {
    this.visible = false;
    this.element.style.opacity = '0';
    window.removeEventListener('keydown', this._boundKeyHandler);
    // Stop 3D scene
    if (this._menuScene3D) this._menuScene3D.stop();
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 500);
  }
}

export default MenuScreen;
