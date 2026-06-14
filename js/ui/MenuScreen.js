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
        /* ── Full-bleed 3D hero (background layer) ── */
        #menu-scene-3d {
          position: absolute; inset: 0;
          width: 100%; height: 100%;
          display: block;
          z-index: 0;
          pointer-events: none;   /* let clicks reach the buttons / page */
        }
        /* Vignette + edge falloff over the scene to focus the centerpiece and
           keep overlaid text legible at the corners. */
        #menu-vignette {
          position: absolute; inset: 0;
          z-index: 1;
          pointer-events: none;
          background:
            radial-gradient(ellipse 72% 62% at 54% 46%, rgba(0,0,0,0) 42%, rgba(2,6,18,0.55) 100%),
            linear-gradient(to bottom, rgba(2,6,18,0.40) 0%, rgba(0,0,0,0) 22%,
                            rgba(0,0,0,0) 68%, rgba(1,3,10,0.55) 100%);
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
      </style>

      <div id="menu-content">

        <!-- ══ Full-bleed 3D hero: EVA astronaut welding the Mother satellite ══ -->
        <canvas id="menu-scene-3d"></canvas>
        <div id="menu-vignette"></div>

        <!-- ══ HEADER (full-width, centered) ══ -->
        <div id="menu-header">
          <h1 style="font-family:'Courier New',monospace; font-size:3.5rem; color:#00ff88;
                      letter-spacing:0.3em; margin-bottom:0.5rem; white-space:nowrap;
                      text-shadow: 0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3);">
            SPACE COWBOY<span style="font-size:0.5em; letter-spacing:0.1em; margin-left:0.4em; vertical-align:0.15em; color:rgba(0,255,136,0.6);">v.96</span>
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
            <div style="margin-bottom:1.9rem; font-size:0.92rem; color:rgba(0,255,136,0.72);
                         line-height:1.7; padding:0 2px;">
              <p style="margin:0 0 0.3rem;">
                40,000 pieces of <span class="adr-name" title="Dead satellites, spent rocket stages and collision fragments — much of it moving at 7–8 km/s. See the Kessler syndrome section below.">space junk</span> threaten every orbit.
              </p>
              <p style="margin:0 0 0.3rem;">
                Removing 5 big ones a year could stabilize Low Earth Orbit.
              </p>
              <p style="margin:0; color:#00ff88; font-weight:bold; letter-spacing:0.06em;">
                Space Cowboys wanted.
              </p>
            </div>

            <!-- Kessler syndrome -->
            <details class="adr-group">
              <summary>Kessler syndrome<span class="adr-count">1978</span></summary>
              <ul class="adr-list">
              <li style="color:rgba(0,255,136,0.72); padding-left:0; margin-bottom:0.35rem;">Proposed by NASA's Donald Kessler in 1978: once orbital junk gets dense enough, each collision throws off fragments that cause more collisions — a runaway cascade that can make whole orbits unusable for generations. Every dead satellite left up there raises the odds.</li>
              <li><span class="adr-name" title="China destroyed its own Fengyun-1C weather satellite with a missile at ~865 km — the worst single debris event in history, and most of those fragments will linger for decades.">2007 — Chinese anti-satellite test</span> <span class="adr-sub">3,000+ pieces</span></li>
              <li><span class="adr-name" title="The defunct Russian Cosmos 2251 slammed into the active Iridium 33 communications satellite — the first accidental crash between two whole satellites.">2009 — Iridium–Cosmos crash</span> <span class="adr-sub">2,000+ pieces</span></li>
              <li><span class="adr-name" title="Russia destroyed the defunct Cosmos 1408 satellite in a weapons test, scattering fragments that forced the ISS crew to shelter in their capsules.">2021 — Russian anti-satellite test</span> <span class="adr-sub">1,500+ pieces</span></li>
              <li><span class="adr-name" title="The US Space Surveillance Network watches for close passes; the ISS fires its thrusters to dodge when collision odds exceed 1 in 10,000 — about once a year on average (NASA), and rising. Its hull is shielded against debris up to ~1 cm; for anything bigger spotted too late, the crew shelters in their return capsules.">ISS dodges debris</span> <span class="adr-sub">~1× / year</span></li>
              </ul>
            </details>

            <!-- The new rules -->
            <details class="adr-group">
              <summary>Cleanup is now mandatory<span class="adr-count">5</span></summary>
              <ul class="adr-list">
              <li><span class="adr-name" title="US Federal Communications Commission, 2022. Satellites in low orbit must now be removed within 5 years of mission end — replacing the old 25-year guideline. First fine: Dish Network, $150,000 (2023).">FCC 5-year rule</span> <span class="adr-sub">USA · 2022</span></li>
              <li><span class="adr-name" title="European Space Agency's Zero Debris Charter (2023): no new debris generated by participating missions by 2030, with disposal success above 90% and orbital clearance in under 5 years.">ESA Zero Debris</span> <span class="adr-sub">Europe · by 2030</span></li>
              <li><span class="adr-name" title="ISRO's Debris-Free Space Missions pledge (2024): all Indian space activity — government and private — to be debris-free by 2030.">Debris-Free Space Missions</span> <span class="adr-sub">India · by 2030</span></li>
              <li><span class="adr-name" title="Proposed EU-wide Space Act (June 2025): would require debris-mitigation plans, collision avoidance and end-of-life deorbiting for any operator serving the EU market. Targeted to apply from 2030.">EU Space Act</span> <span class="adr-sub">EU · proposed 2025</span></li>
              <li><span class="adr-name" title="The UN Committee on the Peaceful Uses of Outer Space (2007 guidelines) and the Inter-Agency Space Debris Coordination Committee — the technical origin of the original 25-year disposal rule that national laws build on.">UN COPUOS / IADC</span> <span class="adr-sub">global</span></li>
              </ul>
            </details>

            <!-- Companies list -->
            <div style="font-size:0.88rem; color:rgba(0,255,136,0.6); line-height:1.5;">
              <details class="adr-group" open>
                <summary>Who removes debris<span class="adr-count">6</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Tokyo-based pure-play debris remover, listed on the Tokyo Stock Exchange since 2024 (valued roughly $1 billion). In 2024 its ADRAS-J spacecraft flew within ~15 m of a discarded Japanese rocket stage — the closest a private craft has come to large debris. Its ADRAS-J2 follow-up will grab and de-orbit that stage (~2027).">Astroscale</span> <span class="adr-sub">Japan · public</span></li>
                <li><span class="adr-name" title="Subsidiary of Northrop Grumman, and the only company doing this routinely today. Its Mission Extension Vehicles docked with live Intelsat satellites (2020–21) to add years of life — the first commercial servicing in orbit.">Northrop Grumman SpaceLogistics</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Swiss start-up building Europe's first debris-removal mission for the European Space Agency. Its original target — a leftover rocket adapter — was itself hit by other debris, so the mission was redirected to capture and de-orbit the retired PROBA-1 satellite instead. Launch ~2028.">ClearSpace</span> <span class="adr-sub">Switzerland</span></li>
                <li><span class="adr-name" title="Italian space-logistics firm. Its ION space tug has flown since 2020; it won a ~€120 million ESA contract (the RISE mission) to service a satellite in geostationary orbit, around 2028.">D-Orbit</span> <span class="adr-sub">Italy</span></li>
                <li><span class="adr-name" title="Seattle start-up (raised $100 million+). Its Otter vehicle is designed to dock with satellites that were never built to be caught; it won a US Space Force contract to de-orbit a retired satellite.">Starfish Space</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Pioneer of in-orbit refuelling — 'gas stations in space'. Its RAFTI fuel port is becoming a de-facto industry standard for refuellable satellites.">Orbit Fab</span> <span class="adr-sub">USA</span></li>
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
                <li><span class="adr-name" title="The European Union Space Surveillance and Tracking partnership — radars and telescopes shared by 15 EU nations, with the catalogue hosted in Germany. Safeguards 600+ satellites.">EU SST</span> <span class="adr-sub">Europe</span></li>
                <li><span class="adr-name" title="Menlo Park, California. A commercial network of phased-array radars — 11 radars across 7 sites worldwide — tracking objects as small as 2 cm in low orbit.">LeoLabs</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="El Segundo, California. A global optical-sensor network paired with AI analytics for tracking objects and issuing collision warnings.">Slingshot Aerospace</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Montreal. Operates the first commercial space-based tracking system — its Skylark satellites watch other objects from orbit rather than from the ground.">NorthStar Earth &amp; Space</span> <span class="adr-sub">Canada</span></li>
                <li><span class="adr-name" title="Foothill Ranch, California. Runs the world's largest commercial telescope network — 350+ scopes — watching the higher orbits, including geostationary.">ExoAnalytic Solutions</span> <span class="adr-sub">USA</span></li>
                <li style="color:rgba(0,255,136,0.62);">Collision-avoidance software:
                  <span class="adr-name" title="Munich, Germany. Space-traffic management and a ground-sensor network, with in-orbit sensors planned.">Vyoma</span>,
                  <span class="adr-name" title="Coimbra, Portugal. AI that assesses collision risk and suggests avoidance manoeuvres days in advance.">Neuraspace</span>,
                  <span class="adr-name" title="Colorado, USA. 'Pathfinder' autonomy and collision-avoidance tools; supports the US Office of Space Commerce's traffic-coordination system.">Kayhan Space</span>.</li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>Space agencies<span class="adr-count">4</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="America's space agency. Its Orbital Debris Program Office (founded 1979) was the first of its kind and writes the US debris-mitigation standards (ODMSP).">NASA</span> <span class="adr-sub">USA</span></li>
                <li><span class="adr-name" title="Runs the Clean Space initiative and funds ClearSpace-1 (€86 million). Its Space Debris Office in Darmstadt, Germany tracks debris using partner radars such as the giant TIRA dish, plus new Flyeye survey telescopes.">European Space Agency</span> <span class="adr-sub">ESA</span></li>
                <li><span class="adr-name" title="Japan's space agency. Runs the Commercial Removal of Debris Demonstration (CRD2) with Astroscale: Phase 1 (ADRAS-J) inspected a spent rocket stage; Phase 2 will capture and de-orbit it, ~2027.">Japan Aerospace Exploration Agency</span> <span class="adr-sub">JAXA · CRD2</span></li>
                <li><span class="adr-name" title="India's space agency. Its IS4OM centre and Project NETRA track debris and run collision avoidance, backing the national Debris-Free Space Missions goal for 2030.">ISRO</span> <span class="adr-sub">India · IS4OM</span></li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>India's ecosystem<span class="adr-count">6</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Hyderabad start-up leading an in-orbit debris-removal demonstration, with Pixxel building the satellite for it (announced March 2026).">Cosmoserve Space</span> <span class="adr-sub">Hyderabad</span></li>
                <li><span class="adr-name" title="Bengaluru-and-California company flying the 'Fireflies' hyperspectral Earth-imaging satellites (first ones launched in 2025). It is building the satellite platform for Cosmoserve's debris-removal demo — its first move into debris work.">Pixxel</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru start-up that tracks and catalogues objects in orbit (space-traffic awareness) and is deploying its own space-tracking satellites — the data needed to spot debris and avoid collisions.">Digantara</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru propulsion specialist (founded 2015). Its thrusters have flown on Indian (ISRO) missions, and its Pushpak 'space tug' is designed to move satellites between orbits — the kind of mobility a debris-hunting servicer needs.">Bellatrix Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Bengaluru start-up (founded 2021 by Indian Institute of Science alumni) building an in-orbit docking-and-refuelling module to refuel, repair and reposition satellites — extending their working life and cutting future debris.">OrbitAID Aerospace</span> <span class="adr-sub">Bengaluru</span></li>
                <li><span class="adr-name" title="Indian start-up making clean, non-toxic satellite propulsion and collision-avoidance thrusters (its 'I-Booster' for 100–500 kg satellites) — focused on preventing debris rather than removing it.">Manastu Space</span> <span class="adr-sub">India</span></li>
                </ul>
              </details>

              <details class="adr-group">
                <summary>2026 events<span class="adr-count">4</span></summary>
                <ul class="adr-list">
                <li><span class="adr-name" title="Inter-Agency Space Debris Coordination Committee — the 44th annual meeting of the world's space agencies, held at the ESA campus in Harwell, UK (April 2026).">IADC 44th meeting</span> <span class="adr-sub">Harwell, UK · Apr</span></li>
                <li><span class="adr-name" title="Advanced Maui Optical and Space Surveillance Technologies conference — the premier technical event for space-tracking and space domain awareness.">AMOS Conference</span> <span class="adr-sub">Maui · Sep</span></li>
                <li><span class="adr-name" title="The 77th International Astronautical Congress — the world's largest space gathering (6,000+ delegates), with major debris and sustainability tracks.">Int'l Astronautical Congress</span> <span class="adr-sub">Antalya · Oct</span></li>
                <li><span class="adr-name" title="Secure World Foundation's flagship policy event on keeping orbit usable — the 8th edition, in Brasília, Brazil (November 2026).">Summit for Space Sustainability</span> <span class="adr-sub">Brasília · Nov</span></li>
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
