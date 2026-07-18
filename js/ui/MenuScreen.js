/**
 * MenuScreen.js — Main menu / start screen overlay
 * Enter key (or the START MISSION button) begins the mission.
 * @module ui/MenuScreen
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { Constants } from '../core/Constants.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { settingsManager } from '../systems/SettingsManager.js';
import { LANGUAGES } from '../core/Languages.js';
import { FlagDecalSystem } from './FlagDecalSystem.js';
import { MenuScene3D } from './MenuScene3D.js';
import { resolvePrimaryMenuAction, startRequiresConfirm, NEW_GAME_CONFIRM_MESSAGE } from './menuActions.js';
export class MenuScreen {
  /**
   * @param {string|null} [initialTier] — current SceneManager quality tier so the
   *   menu renderer boots at the matching pixelRatio / MSAA / bloom settings.
   *   Live changes still arrive via Events.PERF_TIER_CHANGED (handled in MenuScene3D).
   */
  constructor(initialTier = null) {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this._menuScene3D = null;
    this._initialTier = initialTier;
    this._boundKeyHandler = this._onKeyDown.bind(this);
    // Departure sequence state (Item 6). While _departing is true the menu is
    // playing its exit cascade + 3D camera pull-back before MENU_START fires;
    // any further key/click fast-forwards it (skippable). _departTimer holds
    // the pending emit so a skip can cancel + fire it immediately.
    this._departing = false;
    this._departTimer = null;
    // T4: one-shot timer that fires MENU_DEPARTURE_REVEAL at ~65% of the
    // pull-back so the sim unhides the real ship while the hero still masks it.
    this._revealTimer = null;
    // Which event _finishDeparture emits (MENU_START for new game, MENU_CONTINUE
    // for a returning player — T8). Set when a departure begins.
    this._departEvent = null;
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
      background: radial-gradient(ellipse at center, rgba(6,24,60,0.20) 0%, rgba(2,12,35,0.30) 55%, rgba(0,6,20,0.40) 100%);
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
        /* ── Full-bleed 3D hero (background layer) ── */
        #menu-scene-3d {
          position: absolute; inset: 0;
          width: 100%; height: 100%;
          display: block;
          z-index: 0;
          pointer-events: none;   /* let clicks reach the buttons / page */
        }
        /* Vignette + edge falloff over the (now live) backdrop: focus the
           centerpiece and keep overlaid text legible at the corners without
           crushing the Earth limb along the bottom. Lightened for the reveal —
           the scene shows through, so the vignette is a gentle frame, not a
           blackout. */
        #menu-vignette {
          position: absolute; inset: 0;
          z-index: 1;
          pointer-events: none;
          background:
            radial-gradient(ellipse 74% 64% at 54% 46%, rgba(0,0,0,0) 48%, rgba(2,6,18,0.34) 100%),
            linear-gradient(to bottom, rgba(2,6,18,0.28) 0%, rgba(0,0,0,0) 24%,
                            rgba(0,0,0,0) 74%, rgba(1,3,10,0.30) 100%);
        }
        #menu-header {
          text-align: center;
          position: absolute;
          top: 3%; left: 50%;
          transform: translate(-50%, 0);
          width: 40%;
          min-width: 320px;
          z-index: 3;
        }
        #menu-body { display: contents; }
        #menu-left {
          position: absolute;
          top: 20px; left: 20px;
          width: 24%;
          max-width: 360px;
          max-height: calc(100% - 40px);
          overflow-y: auto;
          z-index: 3;
          background: rgba(4,12,30,0.52);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          border: 1px solid rgba(0,255,136,0.14);
          border-radius: 8px;
          padding: 14px 16px;
          box-sizing: border-box;
        }
        @media (max-width: 900px) {
          #menu-header { position: relative; top: auto; left: auto; transform: none; width: 100%; padding: 16px; }
          #menu-body   { display: block; padding: 0 16px; }
          #menu-left   { position: relative; top: auto; left: auto; width: 100%; max-width: none; max-height: none; }
        }
        /* ── ADR credits ── */
        .adr-name {
          color: rgba(0,255,136,0.95);
          cursor: help;
          border-bottom: 1px dotted rgba(0,255,136,0.45);
          display: inline-block;
          padding: 1px 2px;
          transition: color 0.15s, text-shadow 0.15s;
        }
        .adr-name:hover {
          color: #00ff88;
          text-shadow: 0 0 6px rgba(0,255,136,0.5);
        }
        /* Touch-friendly lore tooltip: the ADR factoids used native title=
           attributes, which never appear on touch devices. They now live in
           data-tip and surface via this styled popover — shown on hover for
           pointer devices AND on tap/click (toggle) for touch. */
        #menu-tip {
          position: fixed;
          z-index: 60;
          max-width: min(320px, 78vw);
          background: rgba(3,10,26,0.96);
          border: 1px solid rgba(0,255,136,0.35);
          border-radius: 6px;
          padding: 9px 12px;
          color: rgba(0,255,136,0.9);
          font-family: 'Courier New', monospace;
          font-size: 0.8rem;
          line-height: 1.5;
          letter-spacing: 0.01em;
          box-shadow: 0 8px 26px rgba(0,0,0,0.55), 0 0 14px rgba(0,255,136,0.12);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          pointer-events: none;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.14s, transform 0.14s;
        }
        #menu-tip.open { opacity: 1; transform: translateY(0); }
        .adr-name.tip-active {
          color: #00ff88;
          text-shadow: 0 0 6px rgba(0,255,136,0.5);
        }
        .adr-section {
          font-size: 0.72rem;
          color: rgba(0,255,136,0.55);
          letter-spacing: 0.1em;
          text-transform: uppercase;
          margin: 0.6rem 0 0.2rem;
        }
        .adr-list  { margin: 0; padding: 0; list-style: none; line-height: 1.65; }
        .adr-list li { font-size: 0.88rem; color: rgba(0,255,136,0.7); }
        .adr-sub   { color: rgba(0,255,136,0.6); font-size: 0.76rem; margin-left: 4px; }
        /* Collapsible reference groups (declutter via expand-on-click) */
        .adr-group { border-top: 1px solid rgba(0,255,136,0.12); }
        .adr-group > summary {
          list-style: none; cursor: pointer; user-select: none;
          display: flex; align-items: center; gap: 7px;
          font-size: 0.74rem; color: rgba(0,255,136,0.72);
          letter-spacing: 0.1em; text-transform: uppercase;
          padding: 0.5rem 0 0.45rem; transition: color 0.15s;
        }
        .adr-group > summary::-webkit-details-marker { display: none; }
        .adr-group > summary:hover { color: #00ff88; text-shadow: 0 0 6px rgba(0,255,136,0.35); }
        .adr-group > summary::before {
          content: '▸'; display: inline-block; font-size: 0.78rem;
          color: rgba(0,255,136,0.7); transition: transform 0.15s;
        }
        .adr-group[open] > summary::before { transform: rotate(90deg); }
        .adr-count {
          margin-left: auto; font-size: 0.64rem; color: rgba(0,255,136,0.7);
          border: 1px solid rgba(0,255,136,0.3); border-radius: 999px;
          padding: 0 6px; line-height: 1.4; letter-spacing: 0;
        }
        .adr-group .adr-list { padding-left: 15px; margin-bottom: 0.5rem; }
        /* ── Language / region selector (top-right) ── */
        #menu-lang {
          position: absolute; top: 16px; right: 18px;
          z-index: 6;
          font-family: 'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans',
                       'Noto Sans Thai', 'Noto Sans Devanagari', 'Noto Sans Tamil', sans-serif;
        }
        #menu-lang-btn {
          display: flex; align-items: center; gap: 8px;
          background: rgba(4,12,30,0.62); color: rgba(0,255,136,0.92);
          border: 1px solid rgba(0,255,136,0.4); border-radius: 6px;
          padding: 7px 11px; cursor: pointer; font: inherit; font-size: 0.86rem;
          letter-spacing: 0.02em; transition: all 0.2s;
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        }
        #menu-lang-btn:hover {
          border-color: #00ff88; background: rgba(0,255,136,0.12);
          box-shadow: 0 0 14px rgba(0,255,136,0.25);
        }
        #menu-lang-btn .menu-lang-caret { font-size: 0.7rem; opacity: 0.7; transition: transform 0.2s; }
        #menu-lang.open #menu-lang-btn .menu-lang-caret { transform: rotate(180deg); }
        .menu-lang-flag {
          width: 22px; height: 15px; border-radius: 2px; display: block;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.5); image-rendering: auto;
        }
        #menu-lang-menu {
          list-style: none; margin: 6px 0 0; padding: 5px;
          position: absolute; top: 100%; right: 0; min-width: 200px;
          background: rgba(4,12,30,0.92); border: 1px solid rgba(0,255,136,0.3);
          border-radius: 6px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none;
        }
        #menu-lang.open #menu-lang-menu { display: block; }
        #menu-lang-menu li {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; border-radius: 4px; cursor: pointer;
          color: rgba(0,255,136,0.82); transition: background 0.15s, color 0.15s;
        }
        #menu-lang-menu li:hover { background: rgba(0,255,136,0.14); color: #00ff88; }
        #menu-lang-menu li[aria-selected="true"] {
          background: rgba(0,255,136,0.08);
          box-shadow: inset 2px 0 0 #00ff88;
        }
        #menu-lang-menu .menu-lang-native { font-size: 0.92rem; }
        #menu-lang-menu .menu-lang-en {
          margin-left: auto; font-size: 0.7rem; opacity: 0.55; letter-spacing: 0.04em;
        }

        /* ── Departure cascade (Item 6 — menu→sim transition) ──
         * When START is pressed we add .menu-departing to #menu-content: the
         * DOM chrome (header, body/left column, language selector) staggers
         * out (fade + small slide) left column first, so the transparent 3D
         * hero + live gameplay scene behind become the focus while the menu
         * camera pulls back. The 3D canvas itself is NOT faded here — the
         * MenuScene3D.beginDeparture() camera pull-back handles the hero. */
        #menu-content.menu-departing #menu-left,
        #menu-content.menu-departing #menu-header,
        #menu-content.menu-departing #menu-lang,
        #menu-content.menu-departing #menu-tip {
          opacity: 0;
          transform: translateX(-24px);
          transition: opacity 0.42s ease, transform 0.42s ease;
          pointer-events: none;
        }
        /* Stagger: left column leads, header follows, chrome last. */
        #menu-content.menu-departing #menu-left   { transition-delay: 0s; }
        #menu-content.menu-departing #menu-header { transition-delay: 0.09s; }
        #menu-content.menu-departing #menu-lang   { transition-delay: 0.15s; }
        #menu-content.menu-departing #menu-tip    { transition-delay: 0.12s; }
        @media (prefers-reduced-motion: reduce) {
          #menu-content.menu-departing #menu-left,
          #menu-content.menu-departing #menu-header,
          #menu-content.menu-departing #menu-lang,
          #menu-content.menu-departing #menu-tip {
            transition: opacity 0.2s ease;
            transform: none;
            transition-delay: 0s;
          }
        }
        /* T6 — clear the backdrop DURING the pull-back. The radial-gradient
         * plate on #menu-screen and the #menu-vignette both stayed at full
         * strength until hide()'s trailing 0.5s fade, dimming the live-scene
         * reveal. Fade both over ~1.1s so the camera pull-back reveals a clean
         * scene. The plate background is set inline, so override with
         * !important; the vignette is a normal CSS child. */
        #menu-screen.menu-departing-plate {
          background: rgba(0,0,0,0) !important;
          transition: background 1.1s ease !important;
        }
        #menu-content.menu-departing #menu-vignette {
          opacity: 0;
          transition: opacity 1.1s ease;
        }
        @media (prefers-reduced-motion: reduce) {
          #menu-screen.menu-departing-plate {
            transition: background 0.2s ease !important;
          }
          #menu-content.menu-departing #menu-vignette {
            transition: opacity 0.2s ease;
          }
        }
      </style>

      <div id="menu-content">

        <!-- ══ Full-bleed 3D hero: EVA astronaut welding the Mother satellite ══ -->
        <canvas id="menu-scene-3d"></canvas>
        <div id="menu-vignette"></div>

        <!-- ══ LANGUAGE / REGION SELECTOR (top-right) ══ -->
        <div id="menu-lang">
          <button id="menu-lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
            <img class="menu-lang-flag" id="menu-lang-current-flag" alt="" />
            <span class="menu-lang-name" id="menu-lang-current-name">English</span>
            <span class="menu-lang-caret">▾</span>
          </button>
          <ul id="menu-lang-menu" role="listbox" aria-label="Language"></ul>
        </div>

        <!-- ══ HEADER (full-width, centered) ══ -->
        <div id="menu-header">
          <h1 style="font-family:'Courier New',monospace; font-size:3.5rem; color:#00ff88;
                      letter-spacing:0.3em; margin-bottom:0.5rem; white-space:nowrap;
                      text-shadow: 0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3);">
            SPACE COWBOY<span style="font-size:0.5em; letter-spacing:0.1em; margin-left:0.4em; vertical-align:0.15em; color:rgba(0,255,136,0.6);">${Constants.VERSION_LABEL || ''}</span>
          </h1>
          <div style="font-size:1.1rem; color:rgba(0,255,136,0.6); letter-spacing:0.15em;
                       margin-bottom:1.5rem;">
            Active Debris Remediation (ADR)
          </div>

          <!-- START MISSION button. Label carries both click and Enter hint -->
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
              <div id="menu-start-hint" style="font-size:0.72rem; opacity:0.55; letter-spacing:0.1em; margin-top:5px;">
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
            <div style="margin-bottom:1.9rem; font-size:0.92rem; color:rgba(0,255,136,0.72);
                         line-height:1.7; padding:0 2px;">
              <p style="margin:0 0 0.3rem;">
                <strong>40,000</strong> pieces of <span class="adr-name" title="Dead satellites, spent rocket stages and collision fragments. Much of it moving at 7–8 km/s. See the Kessler syndrome section below.">space junk</span> threaten every orbit, moving ten times faster than a bullet.
              </p>
              <p style="margin:0 0 0.3rem;">
                Removing 5 big ones a year could stabilize Low Earth Orbit.
              </p>
              <p style="margin:0; color:#00ff88; font-weight:bold; letter-spacing:0.06em;">
                Space Cowboys wanted.
              </p>
            </div>

            <!-- True stories from orbit (hook) -->
            <details class="adr-group">
              <summary>True stories from orbit<span class="adr-count">6</span></summary>
              <ul class="adr-list">
              <li><span class="adr-name" title="Launched in 1965 and long thought dead, the LES-1 satellite was detected transmitting again in 2013. Its tumbling likely switches its transmitter on and off. Nobody sent the command.">The zombie satellite</span> <span class="adr-sub">1967 → 2013</span></li>
              <li><span class="adr-name" title="A battery pallet jettisoned from the ISS survived reentry in 2024 and punched clean through the roof of a Florida home. It was supposed to burn up entirely.">A piece of the Station hits a house</span> <span class="adr-sub">Florida · 2024</span></li>
              <li><span class="adr-name" title="Kosmos 482 was a Soviet Venus lander stranded in Earth orbit by a 1972 launch failure. Built to survive Venus, it fell back to Earth intact 53 years later, in 2025.">The Venus lander that stayed</span> <span class="adr-sub">1972 → 2025</span></li>
              <li><span class="adr-name" title="In 2021 the working Yunhai 1-02 satellite was struck by a fragment of a Zenit rocket launched back in 1996. A 25-year-old piece of junk found its target.">Hit by a rocket from 1996</span> <span class="adr-sub">2021</span></li>
              <li><span class="adr-name" title="A minor solar storm in 2022 warmed and puffed up the upper atmosphere, adding just enough drag to pull 38 freshly-launched Starlink satellites back down before they reached their orbits.">A solar storm sinks 38 Starlinks</span> <span class="adr-sub">2022</span></li>
              <li><span class="adr-name" title="The nuclear-powered Kosmos 954 scattered radioactive debris across northern Canada in 1978. Canada billed the USSR under the 1972 Liability Convention, the only space-crash bill ever paid.">The only space-crash bill ever</span> <span class="adr-sub">Canada · 1978</span></li>
              </ul>
            </details>

            <!-- Kessler syndrome -->
            <details class="adr-group">
              <summary>Kessler syndrome<span class="adr-count">4</span></summary>
              <ul class="adr-list">
              <li style="color:rgba(0,255,136,0.72); padding-left:0; margin-bottom:0.35rem;">Proposed by NASA's Donald Kessler in 1978: once orbital junk gets dense enough, each collision throws off fragments that cause more collisions. A runaway cascade that can make whole orbits unusable for generations. Every dead satellite left up there raises the odds.</li>
              <li><span class="adr-name" title="China destroyed its own Fengyun-1C weather satellite with a missile at ~865 km. The worst single debris event in history, and most of those fragments will linger for decades.">2007. Chinese anti-satellite test</span> <span class="adr-sub">3,000+ pieces</span></li>
              <li><span class="adr-name" title="The defunct Russian Cosmos 2251 slammed into the active Iridium 33 communications satellite. The first accidental crash between two whole satellites.">2009. Iridium–Cosmos crash</span> <span class="adr-sub">2,000+ pieces</span></li>
              <li><span class="adr-name" title="Russia destroyed the defunct Cosmos 1408 satellite in a weapons test, scattering fragments that forced the ISS crew to shelter in their capsules.">2021. Russian anti-satellite test</span> <span class="adr-sub">1,500+ pieces</span></li>
              <li><span class="adr-name" title="The US Space Surveillance Network watches for close passes; the ISS fires its thrusters to dodge when collision odds exceed 1 in 10,000. About once a year on average (NASA), and rising. Its hull is shielded against debris up to ~1 cm; for anything bigger spotted too late, the crew shelters in their return capsules.">ISS dodges debris</span> <span class="adr-sub">~1× / year</span></li>
              </ul>
            </details>

            <!-- The new rules -->
            <details class="adr-group">
              <summary>Cleanup is now mandatory<span class="adr-count">5</span></summary>
              <ul class="adr-list">
              <li style="color:rgba(0,255,136,0.72); padding-left:0; margin-bottom:0.35rem;">Sixty years of leftovers plus mega-constellations adding satellites by the thousand turned &ldquo;someday&rdquo; into &ldquo;this decade.&rdquo; Regulators answered with hard deadlines.</li>
              <li><span class="adr-name" title="US Federal Communications Commission, 2022. Satellites in low orbit must now be removed within 5 years of mission end. Replacing the old 25-year guideline. First fine: Dish Network, $150,000 (2023).">FCC 5-year rule</span> <span class="adr-sub">USA · 2022</span></li>
              <li><span class="adr-name" title="European Space Agency's Zero Debris Charter (2023): no new debris generated by participating missions by 2030, with disposal success above 90% and orbital clearance in under 5 years.">ESA Zero Debris</span> <span class="adr-sub">Europe · by 2030</span></li>
              <li><span class="adr-name" title="ISRO's Debris-Free Space Missions pledge (2024): all Indian space activity. Government and private. To be debris-free by 2030.">Debris-Free Space Missions</span> <span class="adr-sub">India · by 2030</span></li>
              <li><span class="adr-name" title="Proposed EU-wide Space Act (June 2025): would require debris-mitigation plans, collision avoidance and end-of-life deorbiting for any operator serving the EU market. Targeted to apply from 2030.">EU Space Act</span> <span class="adr-sub">EU · proposed 2025</span></li>
              <li><span class="adr-name" title="The UN Committee on the Peaceful Uses of Outer Space (2007 guidelines) and the Inter-Agency Space Debris Coordination Committee. The technical origin of the original 25-year disposal rule that national laws build on.">UN COPUOS / IADC</span> <span class="adr-sub">global</span></li>
              </ul>
            </details>

            <!-- Companies list -->
            <div style="font-size:0.88rem; color:rgba(0,255,136,0.6); line-height:1.5;">
              <details class="adr-group">
                <summary>Who removes debris<span class="adr-count">6</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Tokyo-based pure-play debris remover, listed on the Tokyo Stock Exchange since 2024 (valued roughly $1 billion). In 2024 its ADRAS-J spacecraft flew within ~15 m of a discarded Japanese rocket stage. The closest a private craft has come to large debris. Its ADRAS-J2 follow-up will grab and de-orbit that stage (~2027).">Astroscale</span> <span class="adr-sub">Japan · public</span></li>
                <li><span class="adr-name" title="Subsidiary of Northrop Grumman, and the only company doing this routinely today. Its Mission Extension Vehicles docked with live Intelsat satellites (2020–21) to add years of life. The first commercial servicing in orbit.">Northrop Grumman SpaceLogistics</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Swiss start-up building Europe's first debris-removal mission for the European Space Agency. Its original target. A leftover rocket adapter. Was itself hit by other debris, so the mission was redirected to capture and de-orbit the retired PROBA-1 satellite instead. Launch ~2028.">ClearSpace</span> <span class="adr-sub">Switzerland</span></li>
                <li><span class="adr-name" title="Italian space-logistics firm. Its ION space tug has flown since 2020; it won a ~€120 million ESA contract (the RISE mission) to service a satellite in geostationary orbit, around 2028.">D-Orbit</span> <span class="adr-sub">Italy</span></li>
                <li><span class="adr-name" title="Seattle start-up (raised $100 million+). Its Otter vehicle is designed to dock with satellites that were never built to be caught; it won a US Space Force contract to de-orbit a retired satellite.">Starfish Space</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Pioneer of in-orbit refuelling. 'gas stations in space'. Its RAFTI fuel port is becoming a de-facto industry standard for refuellable satellites.">Orbit Fab</span> <span class="adr-sub">USA</span></li>
                <li style="color:rgba(0,255,136,0.62);">Also emerging:
                  <span class="adr-name" title="Los Angeles. Uses an inflatable 'capture bag' to scoop up debris and spent objects.">TransAstra</span>,
                  <span class="adr-name" title="Michigan. Gecko-adhesive and microspine gripper arms (REACCH) to grab tumbling, uncooperative debris.">Kall Morris</span>,
                  <span class="adr-name" title="Canada (Ottawa). Tether-net capture and the 'Puck' docking system for in-orbit servicing.">Obruta</span>.</li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>Who tracks debris<span class="adr-count">6</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Run by the US Space Force; catalogues 30,000+ objects larger than 10 cm. Its Space Fence radar on Kwajalein Atoll (Marshall Islands) can follow ~200,000 objects and is the most sensitive debris radar in the world.">US Space Surveillance Network</span> <span class="adr-sub">USA · Space Fence</span></li>
                <li><span class="adr-name" title="The European Union Space Surveillance and Tracking partnership. Radars and telescopes shared by 15 EU nations, with the catalogue hosted in Germany. Safeguards 600+ satellites.">EU SST</span> <span class="adr-sub">Europe</span></li>
                <li><span class="adr-name" title="Menlo Park, California. A commercial network of phased-array radars. 11 radars across 7 sites worldwide. Tracking objects as small as 2 cm in low orbit.">LeoLabs</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="El Segundo, California. A global optical-sensor network paired with AI analytics for tracking objects and issuing collision warnings.">Slingshot Aerospace</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Montreal. Operates the first commercial space-based tracking system. Its Skylark satellites watch other objects from orbit rather than from the ground.">NorthStar Earth &amp; Space</span> <span class="adr-sub">Canada</span></li>
                <li><span class="adr-name" title="Foothill Ranch, California. Runs the world's largest commercial telescope network. 350+ scopes. Watching the higher orbits, including geostationary.">ExoAnalytic Solutions</span> <span class="adr-sub">USA</span></li>
                <li style="color:rgba(0,255,136,0.62);">Collision-avoidance software:
                  <span class="adr-name" title="Munich, Germany. Space-traffic management and a ground-sensor network, with in-orbit sensors planned.">Vyoma</span>,
                  <span class="adr-name" title="Coimbra, Portugal. AI that assesses collision risk and suggests avoidance manoeuvres days in advance.">Neuraspace</span>,
                  <span class="adr-name" title="Colorado, USA. 'Pathfinder' autonomy and collision-avoidance tools; supports the US Office of Space Commerce's traffic-coordination system.">Kayhan Space</span>.</li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>Space agencies<span class="adr-count">10</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="America's space agency. Its Orbital Debris Program Office (founded 1979) was the first of its kind and writes the US debris-mitigation standards (ODMSP).">NASA</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Runs the Clean Space initiative and funds ClearSpace-1 (€86 million). Its Space Debris Office in Darmstadt, Germany tracks debris using partner radars such as the giant TIRA dish, plus new Flyeye survey telescopes.">European Space Agency</span> <span class="adr-sub">ESA</span></li>
                <li><span class="adr-name" title="Japan's space agency. Runs the Commercial Removal of Debris Demonstration (CRD2) with Astroscale: Phase 1 (ADRAS-J) inspected a spent rocket stage; Phase 2 will capture and de-orbit it, ~2027.">Japan Aerospace Exploration Agency</span> <span class="adr-sub">JAXA · CRD2</span></li>
                <li><span class="adr-name" title="India's space agency. Its IS4OM centre and Project NETRA track debris and run collision avoidance, backing the national Debris-Free Space Missions goal for 2030.">ISRO</span> <span class="adr-sub">India · IS4OM</span></li>
                <li><span class="adr-name" title="Hyderabad start-up leading an in-orbit debris-removal demonstration, with Pixxel building the satellite for it (announced March 2026).">Cosmoserve Space</span> <span class="adr-sub">Hyderabad</span></li>
                <li><span class="adr-name" title="Bengaluru-and-California company flying the 'Fireflies' hyperspectral Earth-imaging satellites (first ones launched in 2025). It is building the satellite platform for Cosmoserve's debris-removal demo. Its first move into debris work.">Pixxel</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru start-up that tracks and catalogues objects in orbit (space-traffic awareness) and is deploying its own space-tracking satellites. The data needed to spot debris and avoid collisions.">Digantara</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru propulsion specialist (founded 2015). Its thrusters have flown on Indian (ISRO) missions, and its Pushpak 'space tug' is designed to move satellites between orbits. The kind of mobility a debris-hunting servicer needs.">Bellatrix Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru start-up (founded 2021 by Indian Institute of Science alumni) building an in-orbit docking-and-refuelling module to refuel, repair and reposition satellites. Extending their working life and cutting future debris.">OrbitAID Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Indian start-up making clean, non-toxic satellite propulsion and collision-avoidance thrusters (its 'I-Booster' for 100–500 kg satellites). Focused on preventing debris rather than removing it.">Manastu Space</span> <span class="adr-sub">India</span></li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>2026 events<span class="adr-count">4</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Inter-Agency Space Debris Coordination Committee. The 44th annual meeting of the world's space agencies, held at the ESA campus in Harwell, UK (April 2026).">IADC 44th meeting</span> <span class="adr-sub">Harwell, UK · Apr</span></li>
                <li><span class="adr-name" title="Advanced Maui Optical and Space Surveillance Technologies conference. The premier technical event for space-tracking and space domain awareness.">AMOS Conference</span> <span class="adr-sub">Maui · Sep</span></li>
                <li><span class="adr-name" title="The 77th International Astronautical Congress. The world's largest space gathering (6,000+ delegates), with major debris and sustainability tracks.">Int'l Astronautical Congress</span> <span class="adr-sub">Antalya · Oct</span></li>
                <li><span class="adr-name" title="Secure World Foundation's flagship policy event on keeping orbit usable. The 8th edition, in Brasília, Brazil (November 2026).">Summit for Space Sustainability</span> <span class="adr-sub">Brasília · Nov</span></li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>Rawhide<span class="adr-count">2</span></summary>
                <ul class="adr-list">
                <li style="color:rgba(0,255,136,0.72); padding-left:0; margin-bottom:0.35rem;"><em>&ldquo;Rollin', rollin', rollin'&hellip; <strong>Rawhide!</strong>&rdquo;</em></li>
                <li><a class="adr-name" href="https://www.perplexity.ai/search/b8b73b32-67ff-4ae8-9930-22e451aae625?sm=v" target="_blank" rel="noopener noreferrer" style="color:#00ccff;" title="The Good Ole Boys / chicken-wire bar scene from The Blues Brothers (1980)">▶ The Blues Brothers &mdash; &ldquo;Rawhide&rdquo;</a></li>
                </ul>
              </details>
            </div>

          </div><!-- /#menu-left -->

        </div><!-- /#menu-body -->
      </div><!-- /#menu-content -->
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Initialise 3D hero scene
    const canvas3d = this.element.querySelector('#menu-scene-3d');
    if (canvas3d) {
      try {
        this._menuScene3D = new MenuScene3D(this._initialTier);
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
      this._requestStartGame();
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

    // Language / region selector
    this._buildLangSelector();

    // Touch-friendly lore tooltips (replaces native title= which is invisible
    // on touch). Converts .adr-name[title] → data-tip and wires tap/hover.
    this._initLoreTooltips();
  }

  /**
   * @private Migrate the lore panel's native `title=` tooltips to a styled,
   * tap-toggleable popover. Native `title` never shows on touch devices; this
   * gives the same factoids a tap target on touch and a hover on pointer
   * devices, in the menu's green/monospace aesthetic. Free-text only — these
   * are one-off factoids, NOT codex entries, so the glossary deep-link system
   * (glossaryDom.js → CODEX_OPEN_ENTRY) deliberately isn't used here.
   */
  _initLoreTooltips() {
    const left = this.element.querySelector('#menu-left');
    if (!left) return;

    // Shared floating tooltip element (one per screen).
    let tip = this.element.querySelector('#menu-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'menu-tip';
      tip.setAttribute('role', 'tooltip');
      this.element.appendChild(tip);
    }
    this._tipEl = tip;
    this._tipAnchor = null;   // currently tap-pinned .adr-name (null = none)
    this._describedEl = null; // anchor currently wired via aria-describedby
                              // (covers both hover and pin paths)

    // Move title → data-tip so the native tooltip never competes with ours.
    left.querySelectorAll('.adr-name[title]').forEach((el) => {
      const text = el.getAttribute('title');
      if (text) el.setAttribute('data-tip', text);
      el.removeAttribute('title');
    });

    const place = (anchor) => {
      const text = anchor.getAttribute('data-tip');
      if (!text) return;
      tip.textContent = text;
      tip.classList.add('open');
      // Measure after content set. Position above the anchor, clamped to viewport.
      const r = anchor.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const margin = 8;
      let left2 = r.left + r.width / 2 - tw / 2;
      left2 = Math.max(margin, Math.min(left2, window.innerWidth - tw - margin));
      let top2 = r.top - th - 8;
      if (top2 < margin) top2 = r.bottom + 8;   // flip below if no room above
      tip.style.left = `${Math.round(left2)}px`;
      tip.style.top = `${Math.round(top2)}px`;
      // a11y: associate the anchor with the tooltip. Track the anchor so hide()
      // can clear it (hover anchors aren't _tipAnchor, so this covers both paths).
      anchor.setAttribute('aria-describedby', 'menu-tip');
      this._describedEl = anchor;
    };

    const hide = () => {
      tip.classList.remove('open');
      if (this._describedEl) {
        this._describedEl.removeAttribute('aria-describedby');
        this._describedEl = null;
      }
      if (this._tipAnchor) {
        this._tipAnchor.classList.remove('tip-active');
        this._tipAnchor = null;
      }
    };
    this._hideLoreTip = hide;

    // Hover (pointer devices) — show while hovered, unless a tap-pin is active.
    left.addEventListener('mouseover', (e) => {
      const anchor = e.target.closest && e.target.closest('.adr-name[data-tip]');
      if (!anchor || this._tipAnchor) return;
      place(anchor);
    });
    left.addEventListener('mouseout', (e) => {
      const anchor = e.target.closest && e.target.closest('.adr-name[data-tip]');
      if (!anchor || this._tipAnchor) return;
      hide();
    });

    // Tap / click — toggle a pinned tooltip (touch-friendly). For real links
    // (the Rawhide anchor) let the navigation happen; only pin for spans.
    left.addEventListener('click', (e) => {
      const anchor = e.target.closest && e.target.closest('.adr-name[data-tip]');
      if (!anchor) return;
      if (anchor.tagName === 'A') return;   // real link — don't hijack navigation
      e.preventDefault();
      e.stopPropagation();
      if (this._tipAnchor === anchor) { hide(); return; }
      hide();
      this._tipAnchor = anchor;
      anchor.classList.add('tip-active');
      place(anchor);
    });

    // Dismiss a pinned tooltip on outside tap / Escape.
    this._tipOutsideHandler = (e) => {
      if (!this._tipAnchor) return;
      if (e.target.closest && e.target.closest('.adr-name[data-tip]')) return;
      hide();
    };
    document.addEventListener('click', this._tipOutsideHandler, true);

    // The lore panel scrolls independently — a pinned/hovered tooltip would
    // drift away from its anchor, so hide it on scroll (cheap + unobtrusive).
    left.addEventListener('scroll', hide, { passive: true });
    this._tipEscHandler = (e) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', this._tipEscHandler, true);
  }

  /**
   * @private Build the top-right language/region selector. Each option carries
   * a procedurally-painted flag swatch (same flag system as the EVA patch).
   * Selecting a language persists it, repaints the astronaut's shoulder patch,
   * and emits Events.LANGUAGE_CHANGED (consumed by GameFlowManager for the
   * regional start orbit, and available to a future i18n string layer).
   */
  _buildLangSelector() {
    const root = this.element.querySelector('#menu-lang');
    const btn = this.element.querySelector('#menu-lang-btn');
    const menu = this.element.querySelector('#menu-lang-menu');
    if (!root || !btn || !menu) return;

    // Procedural flag swatches as data-URLs (robust across platforms, unlike
    // flag emoji which render as letters on some OSes).
    const flagSystem = new FlagDecalSystem();
    const swatchCache = {};
    const swatchFor = (flagCode) => {
      if (swatchCache[flagCode]) return swatchCache[flagCode];
      const canvas = flagSystem.makeFlagCanvas(flagCode, 66, 45);
      const url = canvas ? canvas.toDataURL('image/png') : '';
      swatchCache[flagCode] = url;
      return url;
    };

    const currentFlagImg = this.element.querySelector('#menu-lang-current-flag');
    const currentName = this.element.querySelector('#menu-lang-current-name');

    const refreshCurrent = () => {
      const lang = settingsManager.getLanguageEntry();
      if (currentFlagImg) { currentFlagImg.src = swatchFor(lang.flag); currentFlagImg.alt = lang.label; }
      if (currentName) currentName.textContent = lang.native;
      // Reflect selection state in the list
      menu.querySelectorAll('li').forEach((li) => {
        li.setAttribute('aria-selected', li.dataset.code === lang.code ? 'true' : 'false');
      });
    };

    // Build option rows
    menu.innerHTML = '';
    for (const lang of LANGUAGES) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.code = lang.code;
      li.innerHTML = `
        <img class="menu-lang-flag" src="${swatchFor(lang.flag)}" alt="" />
        <span class="menu-lang-native">${lang.native}</span>
        <span class="menu-lang-en">${lang.label}</span>
      `;
      li.addEventListener('click', () => {
        audioSystem.playClick?.();
        const changed = settingsManager.setLanguage(lang.code);
        refreshCurrent();
        this._closeLangMenu();
        // Repaint the astronaut's shoulder patch immediately.
        if (changed && this._menuScene3D) this._menuScene3D.setFlag(lang.flag);
      });
      menu.appendChild(li);
    }

    const toggle = (e) => {
      e.stopPropagation();
      root.classList.contains('open') ? this._closeLangMenu() : this._openLangMenu();
    };
    btn.addEventListener('click', toggle);

    // Close on outside click / Escape
    this._langOutsideHandler = (e) => {
      if (!root.contains(e.target)) this._closeLangMenu();
    };
    this._langEscHandler = (e) => {
      if (e.key === 'Escape') this._closeLangMenu();
    };

    this._langRoot = root;
    refreshCurrent();
  }

  /** @private */
  _openLangMenu() {
    if (!this._langRoot) return;
    this._langRoot.classList.add('open');
    this._langRoot.querySelector('#menu-lang-btn')?.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', this._langOutsideHandler, true);
    document.addEventListener('keydown', this._langEscHandler, true);
  }

  /** @private */
  _closeLangMenu() {
    if (!this._langRoot) return;
    this._langRoot.classList.remove('open');
    this._langRoot.querySelector('#menu-lang-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', this._langOutsideHandler, true);
    document.removeEventListener('keydown', this._langEscHandler, true);
  }

  /** @private Handle keyboard when menu is visible */
  _onKeyDown(e) {
    if (!this.visible) return;

    // If a departure is already playing, ANY key fast-forwards it (skippable
    // per Item 6 guard — total added latency must be short & skippable).
    if (this._departing) {
      e.preventDefault();
      this._finishDeparture(true);
      return;
    }

    // 2026-05-17 rollback: revert from "any key" to "Press Return to start".
    // The any-key behaviour was too easy to trigger by accident (e.g. the
    // user tapping Cmd+Shift+R for a hard refresh would blow past the menu).
    // Only Enter/Return (or NumpadEnter) starts. (The KeyF "fast start"
    // shortcut was removed in the menu overhaul — START MISSION is the single
    // entry path; MENU_FAST_START remains a reserved event with no emitter.)
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      // F1 save-guard: with a save present, the primary key RESUMES the mission
      // (CONTINUE) — it must never silently start a new game that wipes the
      // save (that was the instant, no-confirm data loss). With no save it
      // starts as before.
      if (resolvePrimaryMenuAction(persistenceManager.hasSave()) === 'CONTINUE') {
        this._continueGame();
      } else {
        this._requestStartGame();
      }
    }
  }

  /**
   * @private F1 save-guard: entry point for the explicit START MISSION button.
   * Starting a NEW game clears any existing save (GameFlowManager MENU_START →
   * deleteSave). When a save exists this asks a single confirm that names the
   * loss and points at CONTINUE, so an intentional new game is still one click
   * away but an accidental one can't silently wipe progress. With no save (or
   * no window.confirm), it starts immediately. A skip during an in-flight
   * departure fast-forwards it without re-confirming.
   */
  _requestStartGame() {
    if (this._departing) { this._finishDeparture(true); return; }
    if (startRequiresConfirm(persistenceManager.hasSave())) {
      const canConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function';
      if (canConfirm && !window.confirm(NEW_GAME_CONFIRM_MESSAGE)) return;
    }
    this._startGame();
  }

  /**
   * @private Start game — plays the departure cinematic (Item 6), then emits
   * MENU_START. The menu chrome staggers out and the 3D hero camera pulls
   * back while the live gameplay scene behind the transparent menu takes over;
   * MENU_START fires at the end (or immediately, on skip / reduced motion).
   */
  _startGame() {
    if (this._departing) { this._finishDeparture(true); return; }
    // Note: the new-game save-wipe confirm lives in _requestStartGame() (the
    // button/key entry point). _startGame() is the confirmed departure path.
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    // New game → cinematic pull-back, then MENU_START. ~50% slower (2.1→3.15s;
    // cameraDur 2.0→3.0) so the astronaut exit + the orientation move (random
    // partial-flash or fly-around) play calmly. cameraDur also clamps the
    // fraction-based astronaut beat timeline.
    this._beginDeparture(Events.MENU_START, 3150, 3.0);
  }

  /**
   * @private Play the menu→sim departure cinematic then emit `event`. Shared by
   * new-game (MENU_START, full pull-back) and continue (MENU_CONTINUE, short
   * pull-back — T8). Honors reduced-motion with a quick straight cut.
   * @param {string} event — EventBus event to emit at the end (or on skip).
   * @param {number} durationMs — ms before the handoff emit.
   * @param {number} cameraDur — seconds for the 3D hero camera pull-back.
   */
  _beginDeparture(event, durationMs, cameraDur) {
    this._departEvent = event;

    const reduced = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // Reduced motion → skip the staged cinematic, straight cut (still gives
    // the DOM a brief fade via the departing class, but no camera move wait).
    // The audio pad swell accompanies the pull-back cinematic, so it is
    // skipped here too (emitting it would overrun the ~220ms cut — the swell
    // has a 0.4s floor — desyncing audio from the visual for reduced-motion
    // users).
    if (reduced) {
      const content = this.element.querySelector('#menu-content');
      if (content) content.classList.add('menu-departing');
      this._beginPlateDeparture();
      if (this._menuScene3D) this._menuScene3D.beginDeparture(0.4);
      this._departing = true;
      this._departTimer = setTimeout(() => this._finishDeparture(), 220);
      return;
    }

    // T10: cue the departure audio pad swell at the START of the pull-back
    // (MENU_START/MENU_CONTINUE fire at the END). Sized to the camera move.
    eventBus.emit(Events.MENU_DEPARTURE_START, { event, durationMs, cameraDur });

    // Stage 1: menu chrome stagger-fade (CSS cascade, left column first).
    const content = this.element.querySelector('#menu-content');
    if (content) content.classList.add('menu-departing');
    // T6: clear the plate + vignette and stop capturing pointer events so the
    // reveal isn't dimmed and post-departure clicks reach the game canvas.
    this._beginPlateDeparture();
    // Stage 2: 3D hero departure — weld arc/glow/sparks fade, camera pulls
    // back so the hero recedes toward the live scene.
    if (this._menuScene3D) this._menuScene3D.beginDeparture(cameraDur);
    this._departing = true;
    // T4: reveal the real player ship EARLY (~65% through the pull-back) so it is
    // rendered + lit behind the still-frame-filling hero — the cut then has no
    // visibility pop. One-shot; cleared by _resetDepartureState (skip cancels it,
    // and MENU_START's own GAME_STATE_CHANGE unhide covers the skipped path).
    this._revealTimer = setTimeout(() => {
      this._revealTimer = null;
      eventBus.emit(Events.MENU_DEPARTURE_REVEAL);
    }, Math.round(durationMs * 0.65));
    // Stage 3 handoff: emit the target event near the end of the pull-back. The
    // gameplay scene is already rendering behind the transparent menu; hide()
    // then cross-fades the plate to 0.
    this._departTimer = setTimeout(() => this._finishDeparture(), durationMs);
    this._armSkipClick();
  }

  /**
   * @private T6 — start the backdrop clear: fade the plate + vignette (via CSS
   * classes) and stop the menu from capturing pointer events so post-departure
   * clicks reach the game canvas ~0.5s sooner. The window-level capture-phase
   * skip handler still fires (capture precedes hit-testing), so pointer-events
   * off does not break skip-to-finish.
   */
  _beginPlateDeparture() {
    if (this.element) {
      this.element.classList.add('menu-departing-plate');
      this.element.style.pointerEvents = 'none';
    }
  }

  /** @private Any pointer press during departure fast-forwards it. */
  _armSkipClick() {
    if (this._skipClickHandler) return;
    this._skipClickHandler = () => this._finishDeparture(true);
    // capture-phase, one path; removed in _finishDeparture.
    window.addEventListener('pointerdown', this._skipClickHandler, true);
  }

  /**
   * @private Tear down the TRANSIENT departure state (pending timer, in-flight
   * flag, target event, and the window-level skip-click listener). Single
   * source of truth for the reset that show(), hide(), and _finishDeparture()
   * all need — keeps them from drifting as departure state grows.
   *
   * Deliberately does NOT touch the departure CSS/style side effects
   * (`menu-departing`, `menu-departing-plate`, inline pointer-events). Those
   * must PERSIST through hide()'s opacity fade so the reveal isn't re-dimmed
   * and clicks keep reaching the game canvas (T6); they are restored only in
   * show() when a fresh, interactive menu is being built.
   */
  _resetDepartureState() {
    if (this._departTimer) {
      clearTimeout(this._departTimer);
      this._departTimer = null;
    }
    if (this._revealTimer) {
      clearTimeout(this._revealTimer);
      this._revealTimer = null;
    }
    if (this._skipClickHandler) {
      window.removeEventListener('pointerdown', this._skipClickHandler, true);
      this._skipClickHandler = null;
    }
    this._departing = false;
    this._departEvent = null;
  }

  /**
   * @private Complete the departure: fire the target event exactly once. Called
   * at the end of the ramp OR early when the player skips (any key/click).
   * @param {boolean} [skipped=false] — true when triggered by a skip (key /
   *   pointer / re-press), so the sim side can suppress the intro camera zoom.
   */
  _finishDeparture(skipped = false) {
    // Capture emit intent BEFORE the reset clears _departing/_departEvent, so
    // the exactly-once guard and the target event survive the teardown.
    const wasDeparting = this._departing;
    const event = this._departEvent || Events.MENU_START; // default defensive
    // T5: on a skip, jump the 3D hero + astronaut exit to their end state so a
    // fast-forward doesn't freeze the astronaut mid-beat behind the revealed
    // sim ship (the DOM side is handled by the reset + emit below).
    if (skipped && wasDeparting && this._menuScene3D && this._menuScene3D.skipDeparture) {
      this._menuScene3D.skipDeparture();
    }
    this._resetDepartureState();
    if (!wasDeparting) return;
    eventBus.emit(event, { skipped: !!skipped });
  }

  /**
   * @private Continue from saved game (T8). Play a SHORT departure (0.6s) then
   * emit MENU_CONTINUE — replaces the previous hard cut so returning players
   * get the same live-scene handoff as a new game (albeit briefer, since the
   * destination is the BRIEFING card rather than straight to flight).
   */
  _continueGame() {
    if (this._departing) { this._finishDeparture(true); return; }
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    this._beginDeparture(Events.MENU_CONTINUE, 600, 0.6);
  }

  show() {
    this.visible = true;
    // Clear any leftover departure state from a prior run (e.g. returning to
    // the menu after a game) so the chrome is fully visible + interactive.
    this._resetDepartureState();
    const content = this.element.querySelector('#menu-content');
    if (content) content.classList.remove('menu-departing');
    // T6: restore the backdrop plate + pointer capture for the fresh menu.
    this.element.classList.remove('menu-departing-plate');
    this.element.style.pointerEvents = 'auto';
    // Toggle Continue button visibility based on whether a save exists
    const hasSave = persistenceManager.hasSave();
    const continueWrapper = this.element.querySelector('#menu-continue-wrapper');
    if (continueWrapper) {
      continueWrapper.style.display = hasSave ? 'block' : 'none';
    }
    // F1 save-guard: when a save exists, Enter maps to CONTINUE (the safe
    // action), so the START button's key hint must not claim Enter starts a
    // new game. Keep the copy honest with the actual key mapping.
    const startHint = this.element.querySelector('#menu-start-hint');
    if (startHint) {
      startHint.textContent = hasSave ? 'Click to start new (confirms)' : 'Press Enter or Click';
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
    // Defensive: if an external state change hides the menu mid-departure,
    // cancel the pending emit + clear the flags so the timer can't fire a stray
    // second event later. (Normal flow completes via _finishDeparture() before
    // any hide, so this only matters on odd paths.) NOTE: the departure CSS
    // (plate/pointer-events) is intentionally left in place — it must persist
    // through this opacity fade so the reveal stays clear; show() restores it.
    this._resetDepartureState();
    this._closeLangMenu();
    if (this._hideLoreTip) this._hideLoreTip();
    // Stop 3D scene
    if (this._menuScene3D) this._menuScene3D.stop();
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 500);
  }
}

export default MenuScreen;
