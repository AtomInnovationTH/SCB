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
import { GestureHints } from './hud/GestureHints.js';
import { resolvePrimaryMenuAction, startRequiresConfirm, NEW_GAME_CONFIRM_MESSAGE } from './menuActions.js';
import { buildUpdateCard } from './UpdateCard.js';
import { applyUpdate } from '../core/UpdateWatch.js';
import { claimAutoApply } from '../core/UpdateWatch.js';   // the loop-guard claim (kept a separate line: test-UpdateCard.js pins the applyUpdate import)
import { buildWhatsNewCard, loadNotes, readNotice, markSeen, placeNotice } from './WhatsNewCard.js';   // the "what's new" notes card (owner 2026-10-26)

/** up1: the one line on the menu while the game switches to the new build by itself. */
const UPDATE_NOTICE_TEXT = 'Updating to the new version\u2026';
/** up1: if the page is still here this long after the switch was asked for, give up: drop the notice and show the card (ms). */
const AUTO_UPDATE_RELEASE_MS = 20000;

/**
 * Which events in the "Upcoming events" list are still ahead (menu-1025). Pure:
 * an event stays through its last day. A date that is not YYYY-MM-DD is kept
 * (a typo must never silently hide an event).
 * @param {Array<string|null|undefined>} endDates  each event's `data-end`, YYYY-MM-DD
 * @param {string} todayIso  today as YYYY-MM-DD (device clock, local date)
 * @returns {number[]} indexes of the events to show, in order
 */
export function upcomingEventIndexes(endDates, todayIso) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const out = [];
  (endDates || []).forEach((end, i) => {
    if (!iso.test(String(end || '')) || String(end) >= todayIso) out.push(i);
  });
  return out;
}

/** Today as YYYY-MM-DD in the device's local time. */
export function localIsoDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Which "(more)" in Countries a language flag opens (the id after `adr-more-`).
 * Owner 2026-10-26: "country selected in drop down box, opens that country in
 * menu. so users see info they care about." BRA has no country entry: null.
 */
export const COUNTRY_FOR_FLAG = Object.freeze({
  THA: 'thailand', JPN: 'japan', IND: 'india', USA: 'countries', ESP: 'countries', BRA: null,
});

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
    // Session J.5 — the menu UPDATE card. `_update` = the last UPDATE_AVAILABLE
    // payload ({ hash, tag, bullets }) or null; `_updateDismissed` = the hash
    // the player answered LATER to (never nag twice per build, this page
    // session). The card is built lazily and ONLY inside #menu-header.
    this._update = null;
    this._updateDismissed = null;
    this._updateCard = null;
    // up1: UPDATE_AUTO_APPLY — the game is switching to the new build by itself.
    // While `_autoUpdating` is true no departure can begin (every start path is
    // guarded), so a game never starts on the build being deleted.
    this._autoUpdating = false;
    this._autoUpdateTimer = null;
    this._autoAttempt = 0;         // which auto switch is current (a released one is cancelled for good)
    this._reloadIssued = false;    // _reload() ran: the page is going away, the failsafe must not open the lock
    this._updateNotice = null;
    // Update notice (owner 2026-10-26, DECISIONS §43): the version button's notes card. `_notes` = the running
    // build's { version, bullets } or null; `_notice` = { card, dot } from readNotice(), read once per page load.
    this._notes = null;
    this._notesPromise = null;
    this._notice = null;
    this._notesCard = null;
    this._onNotesResize = null;
    this._updateChecker = null;
    // w1-first-minute D3: what the "?" button opens (set by setHelpOpener).
    this._helpOpener = null;
    this._build();
    // u15b D7: the hub flips glass AFTER this screen is built (and the menu may already be showing), so the start hint is
    // re-worded the moment glass turns on, as well as on every show().
    this._offGlass = GestureHints.onGlassOn(() => this._syncStartHint());

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      if (to === GameStates.MENU) this.show();
      else this.hide();
    });
    // Session J.5: UpdateWatch → "NEW VERSION READY" (mounted now if visible,
    // else on the next show()). Flag-independent: no LADDER gate here.
    eventBus.on(Events.UPDATE_AVAILABLE, (p) => this._onUpdateAvailable(p));
    // up1: the same news, but the menu is up and no game has begun — switch now.
    eventBus.on(Events.UPDATE_AUTO_APPLY, (p) => this._onUpdateAutoApply(p));
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
          font-family: var(--font-mono);
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
          /* max-content, not 40%: the nowrap h1 is wider than a 40% box on
             every viewport under ~1700px, and an overflowing centred line
             start-aligns — the title sat right of centre. The version label
             rides in a zero-width inline-block inside the h1 so the box (and
             the centring) is the SPACE COWBOY glyph run alone. */
          width: max-content;
          max-width: 94vw;
          min-width: 320px;
          z-index: 3;
        }
        #menu-body { display: contents; }
        /* Library / Refit pane grammar (INFO family): opaque plate, hairline
           cyan border, NO backdrop-filter — the blur shader re-ran every
           composite frame over the live WebGL hero (index.html GPU note). */
        #menu-left {
          position: absolute;
          top: 20px; left: 20px;
          width: 24%;
          max-width: 360px;
          max-height: calc(100% - 40px);
          overflow-y: auto;
          z-index: 3;
          background: rgba(0,16,32,0.82);
          border: 1px solid rgba(0,204,255,0.4);
          border-radius: 8px;
          padding: 14px 16px;
          box-sizing: border-box;
        }
        @media (max-width: 900px) {
          #menu-header { position: relative; top: auto; left: auto; transform: none; width: 100%; padding: 16px; }
          #menu-body   { display: block; padding: 0 16px; }
          #menu-left   { position: relative; top: auto; left: auto; width: 100%; max-width: none; max-height: none; }
        }
        /* ── ADR credits — library INFO grammar: PLAYER-green group titles,
           INFO-cyan names / tags / badges / sub-headers, #aaddff prose in
           proportional B612 (--font-ui's first consumer). ── */
        .adr-name {
          color: rgba(0,204,255,0.95);
          cursor: help;
          border-bottom: 1px dotted rgba(0,204,255,0.45);
          display: inline-block;
          padding: 1px 2px;
          -webkit-tap-highlight-color: transparent;
          transition: color 0.15s, text-shadow 0.15s;
        }
        .adr-name:hover {
          color: #aaddff;
          text-shadow: 0 0 6px rgba(0,204,255,0.5);
        }
        /* Touch-friendly lore tooltip: the ADR factoids used native title=
           attributes, which never appear on touch devices. They now live in
           data-tip and surface via this styled popover — shown on hover for
           pointer devices AND on tap/click (toggle) for touch. Opaque plate,
           no blur (see #menu-left). */
        #menu-tip {
          position: fixed;
          z-index: 60;
          max-width: min(360px, 78vw);
          background: rgba(0,16,32,0.96);
          border: 1px solid rgba(0,204,255,0.4);
          border-radius: 6px;
          padding: 9px 12px;
          color: #aaddff;
          font-family: var(--font-ui);
          font-size: 0.9rem;
          line-height: 1.5;
          letter-spacing: 0;
          box-shadow: 0 8px 26px rgba(0,0,0,0.55), 0 0 14px rgba(0,204,255,0.12);
          pointer-events: none;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.14s, transform 0.14s;
        }
        #menu-tip.open { opacity: 1; transform: translateY(0); }
        .adr-name.tip-active {
          color: #aaddff;
          text-shadow: 0 0 6px rgba(0,204,255,0.5);
        }
        /* Prose (intro wrapper, group intros, the Rawhide quote). The
           .adr-list li.adr-prose twin outranks .adr-list li (0,1,1) — a
           bare .adr-prose (0,1,0) would lose colour and size to it. */
        .adr-prose, .adr-list li.adr-prose {
          font-family: var(--font-ui);
          color: #aaddff;
          font-size: 0.92rem;
          line-height: 1.5;
          letter-spacing: 0;
          padding-left: 0;
          margin-bottom: 0.35rem;
        }
        /* "Also…" / "Collision-avoidance software:" lead-ins. */
        .adr-nw { white-space: nowrap; }
        .adr-also, .adr-list li.adr-also { color: rgba(0,204,255,0.62); }
        /* "(more)" beside a country name: reveals that country's other names
           (owner 2026-10-25, less wall of text). Plain text look, dotted
           underline as the only hint it opens something. */
        .adr-more-btn {
          background: none; border: 0; padding: 0 2px; margin-left: 6px;
          font: inherit; font-family: var(--font-ui); font-size: 0.76rem;
          text-transform: none; letter-spacing: 0;
          color: rgba(0,204,255,0.8); cursor: pointer;
          text-decoration: underline dotted; text-underline-offset: 3px;
          -webkit-tap-highlight-color: transparent;
        }
        .adr-more-btn:focus { outline: none; }   /* index.html's green button:focus box is for real buttons */
        .adr-more-btn:hover, .adr-more-btn:focus-visible { color: #aaddff; }
        .adr-more-btn[aria-expanded="true"] { color: rgba(0,204,255,0.6); }
        .adr-section {
          font-size: 0.72rem;
          color: rgba(0,204,255,0.6);
          letter-spacing: 0.1em;
          text-transform: uppercase;
          margin: 0.6rem 0 0.2rem;
        }
        .adr-group > .adr-section:first-of-type { margin-top: 0.15rem; }
        .adr-list  { margin: 0; padding: 0; list-style: none; line-height: 1.65; }
        .adr-list[hidden] { display: none; }   /* a closed country's list */
        .adr-list li { font-size: 0.88rem; color: rgba(0,204,255,0.75); }
        .adr-sub   { color: rgba(0,204,255,0.6); font-size: 0.76rem; margin-left: 4px; }
        /* Collapsible reference groups (declutter via expand-on-click) */
        .adr-group { border-top: 1px solid rgba(0,204,255,0.18); }
        .adr-group > summary {
          list-style: none; cursor: pointer; user-select: none;
          display: flex; align-items: center; gap: 7px;
          font-size: 0.74rem; color: rgba(0,255,136,0.85);
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
          margin-left: auto; font-size: 0.64rem; color: rgba(0,204,255,0.75);
          border: 1px solid rgba(0,204,255,0.35); border-radius: 999px;
          padding: 0 6px; line-height: 1.4; letter-spacing: 0;
        }
        .adr-group .adr-list { padding-left: 15px; margin-bottom: 0.5rem; }
        /* Handheld (13" iPad, two-handed at ~40 cm): Ipad.md §3 touch law —
           44 px summary rows and a 44 px .adr-name hit box (negative margin
           keeps the row compact; neighbours overlap ~3 px, harmless). Gated on
           a coarse pointer above the stacked-layout breakpoint so the desktop
           look is byte-identical and phones keep the max-width: 900px block.
           Placed AFTER the base .adr-* rules: same specificity, so source
           order is what lets these win. */
        @media (pointer: coarse) and (min-width: 901px) {
          /* 27% of the viewport, but never under the centred title: the SPACE
             COWBOY glyph box is 638 px (3.5rem, 0.3em tracking), so its left
             edge sits at 50vw - 319px; 20px panel left + 13px gap → 352. On a
             1366 iPad that is 331 px (right edge 351, title at 364); 27% only
             wins above ~1530 px, and max-width caps it before that. */
          #menu-left { width: min(27%, calc(50vw - 352px)); max-width: 380px; padding: 16px 18px; }
          .adr-prose, .adr-list li.adr-prose { font-size: 1rem; }
          .adr-list li { font-size: 1rem; padding: 0.3rem 0; }
          .adr-sub { font-size: 0.85rem; }
          .adr-section { font-size: 0.8rem; }
          .adr-group > summary { font-size: 0.84rem; min-height: 44px; padding: 0.35rem 0; box-sizing: border-box; }
          .adr-count { font-size: 0.72rem; }
          .adr-name { padding: 0.55rem 2px; margin: -0.4rem 0; }
          /* The padded hit box pushed the dotted border a line below the name:
             underline the text itself instead. */
          .adr-name { border-bottom: 0; text-decoration: underline dotted rgba(0,204,255,0.45); text-underline-offset: 3px; }
          .adr-more-btn { font-size: 0.85rem; padding: 0.8rem 8px; margin: -0.8rem 0 -0.8rem 2px; }
          #menu-tip { font-size: 0.95rem; max-width: min(400px, 78vw); padding: 11px 14px; }
        }
        /* ── Version button (update notice, owner 2026-10-26): "V1.02 · What's new" + a dot until the notes were opened.
           index.html has a global button:focus green outline; this button keeps its quiet look and shows focus only
           from the keyboard. Coarse pointer: a 44 px hit box by padding, undone by a negative margin. ── */
        #menu-version-btn:focus { outline: none; }
        #menu-version-btn:focus-visible { color: #00ff88 !important; }
        @media (hover: hover) { #menu-version-btn:hover { color: #00ff88 !important; } }   /* not on touch: a tap must not leave it lit */
        #menu-version-btn:focus-visible { text-decoration: underline; text-underline-offset: 4px; }
        #menu-version-btn .menu-version-more { font-size: 0.6em; letter-spacing: 0.08em; }
        #menu-version-btn .menu-version-dot {
          display: none; width: 0.28em; height: 0.28em; margin-left: 0.4em; vertical-align: 0.5em;
          border-radius: 50%; background: #00ff88; box-shadow: 0 0 6px rgba(0,255,136,0.7);
        }
        #menu-version-btn.has-dot .menu-version-dot { display: inline-block; }
        @media (pointer: coarse) {
          #menu-version-btn { padding: 6px 10px !important; margin: -6px -10px -6px calc(0.4em - 10px) !important; }
        }
        /* ── Language / region selector (top-right) ── */
        /* right: 18 px edge + 44 px "?" + 8 px gap = 70 px, so the help button
         * sits to the RIGHT of the picker (owner 2026-10-06) at the old 18 px
         * screen margin. Narrow viewports restore 18 px (media query below). */
        #menu-lang {
          position: absolute; top: 16px; right: 70px;
          z-index: 6;
          font-family: 'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans',
                       'Noto Sans Thai', 'Noto Sans Devanagari', 'Noto Sans Tamil', sans-serif;
        }
        /* Help "?" to the right of the language picker (w1-first-minute D3;
         * owner 2026-09-30 "help button on menu", 2026-10-06 "right side of
         * the language dropdown"): opens the same key list as the ? key. 44 px
         * hit area for touch. Hidden until main.js wires the opener. Out of
         * flow (anchored to #menu-lang), so the picker and its list keep their
         * layout. */
        #menu-help-btn {
          position: absolute; top: 50%; left: calc(100% + 8px); transform: translateY(-50%);
          min-width: 44px; min-height: 44px; box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
          background: rgba(4,12,30,0.62); color: rgba(0,255,136,0.92);
          border: 1px solid rgba(0,255,136,0.4); border-radius: 6px;
          padding: 0 12px; cursor: pointer; font: inherit; font-size: 1.1rem; font-weight: 700;
          transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        }
        #menu-help-btn:hover {
          border-color: #00ff88; background: rgba(0,255,136,0.12);
          box-shadow: 0 0 14px rgba(0,255,136,0.25);
        }
        /* Narrower than ~1340 px there is no room for picker + "?" in one row:
         * shifting the picker left would put it on the version label (V. …)
         * that trails the title — measured 2026-10-06, a "?" beside the picker
         * overlapped it up to ~1284 px wide (52 px at 1180, iPad Air). Keep the
         * picker at the 18 px margin and hang the "?" under it instead. */
        @media (max-width: 1339px) {
          #menu-lang { right: 18px; }
          #menu-help-btn { top: calc(100% + 8px); left: auto; right: 0; transform: none; }
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
        #menu-lang.open #menu-lang-menu { display: block; z-index: 2; }
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
          <button id="menu-help-btn" type="button" aria-label="Help — keys and controls" title="Help — keys and controls" style="display:none">?</button>
          <button id="menu-lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
            <img class="menu-lang-flag" id="menu-lang-current-flag" alt="" />
            <span class="menu-lang-name" id="menu-lang-current-name">English</span>
            <span class="menu-lang-caret">▾</span>
          </button>
          <ul id="menu-lang-menu" role="listbox" aria-label="Language"></ul>
        </div>

        <!-- ══ HEADER (full-width, centered) ══ -->
        <div id="menu-header">
          <h1 style="font-family: var(--font-mono); font-size:3.5rem; font-weight:700; color:#00ff88;
                      letter-spacing:0.3em; margin-bottom:0.5rem; white-space:nowrap;
                      text-shadow: 0 0 30px rgba(0,255,136,0.6), 0 0 60px rgba(0,255,136,0.3);">
            SPACE COWBOY<span style="display:inline-block; width:0; white-space:nowrap; overflow:visible;"><button type="button" id="menu-version-btn" style="font-family:var(--font-ui); font-weight:inherit; font-size:0.5em; letter-spacing:0.1em; font-variant-numeric:tabular-nums; margin-left:0.4em; vertical-align:0.15em; color:rgba(0,255,136,0.6); background:none; border:none; padding:0; cursor:pointer; text-shadow:none; white-space:nowrap;">${Constants.VERSION_LABEL || ''}<span class="menu-version-more"> \u00B7 What's new</span><span class="menu-version-dot" aria-hidden="true"></span></button></span>
          </h1>
          <div style="font-size:1.1rem; color:rgba(0,255,136,0.6); letter-spacing:0.15em;
                       margin-bottom:1.5rem;">
            Active Debris Remediation (ADR)
          </div>

          <!-- START MISSION button. Label carries both click and Enter hint -->
          <div style="margin:0 0 0.8rem;">
            <button id="menu-start-btn" style="
              font-family: var(--font-mono); color:#00ff88;
              background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.5);
              padding: 12px 48px 10px; cursor: pointer; border-radius: 4px;
              letter-spacing: 0.15em; text-transform: uppercase; transition: all 0.3s;
              text-shadow: 0 0 10px rgba(0,255,136,0.5);
              line-height: 1;
            ">
              <div style="font-size:1.2rem;">▶ START MISSION</div>
              <div id="menu-start-hint" style="font-size:0.72rem; opacity:0.55; letter-spacing:0.08em; margin-top:5px;">
                Press Enter or Click
              </div>
            </button>
          </div>

          <!-- CONTINUE button (hidden until a save exists) -->
          <div id="menu-continue-wrapper" style="margin:0.5rem 0; display:none;">
            <button id="menu-continue-btn" style="
              font-family: var(--font-mono); font-size:1.0rem; color:#ffaa00;
              background: rgba(255,170,0,0.08); border: 2px solid rgba(255,170,0,0.4);
              padding: 10px 40px; cursor: pointer; border-radius: 4px;
              letter-spacing: 0.15em; text-transform: uppercase; transition: all 0.3s;
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

            <!-- Story / overview text — proportional B612 prose (.adr-prose); the
                 recruiting line below keeps the one PLAYER-green accent on purpose. -->
            <div class="adr-prose" style="margin-bottom:1.9rem; padding:0 2px;">
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

            <!-- Countries — Thailand, India, Japan, then Other: four header lines, each
                 a name and "(more)" flush left, the same markup. One is open at
                 a time (owner 2026-10-26): a closed country shows only its name and
                 "(more)"; open, its <ul id="adr-more-<country>"> shows three
                 organisations and the other names. "Other (more)" is the
                 fourth header (not a country, so no badge count) and shows
                 NASA and ESA. MenuScreen._toggleMore() opens one and closes the rest;
                 the language pick opens its country (_openCountryFor), on load too.
                 Country headers are .adr-section DIV siblings of each list
                 (.adr-list li outranks .adr-section, so never <li>s). Picks and
                 sources: docs/research/2026-10-menu-refresh.md (read 2026-10-25). -->
            <details class="adr-group" open>
              <summary>Countries<span class="adr-count">3</span></summary>
              <div class="adr-section">Thailand <button type="button" class="adr-more-btn" aria-expanded="false" aria-controls="adr-more-thailand">(more)</button></div>
              <ul class="adr-list" id="adr-more-thailand" hidden>
              <li><span class="adr-name" title="Thailand's space agency. Its GARNET and ZIRCON systems track objects in orbit and manage space traffic. THEOS-2 has flown since 2023; THEOS-2A was lost in the failed PSLV launch of 12 January 2026.">GISTDA</span> <span class="adr-sub">Space agency</span></li>
              <li><span class="adr-name" title="Thailand's national astronomy institute, in Chiang Mai. It has an agreement with the Royal Thai Air Force on space surveillance, backed by a system that tracks satellites, built up from its automated telescopes.">NARIT</span> <span class="adr-sub">Space watch</span></li>
              <li><span class="adr-name" title="Gulf Space Technology, Thailand's satellite operator, known as Thaicom until it renamed itself on 17 September 2026; its satellites keep the Thaicom name. Thaicom 9 may launch by March 2027; Thaicom 10 has bank financing for a 2027 launch.">Gulf Space Tech</span> <span class="adr-sub">Satcom</span></li>
              <li class="adr-also">
                <span class="adr-nw"><span class="adr-name" title="Thai science agencies, universities and the military building Thailand's own satellite. TSC-1, a microsatellite under 100 kg assembled at NARIT in Chiang Mai, passed thermal-vacuum, radiation and vibration tests in 2026; launch is aimed for 2027.">Thai Space Consortium</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Flies Thailand's military satellites: NAPA-1 went up on a Vega rocket in September 2020 and NAPA-2 on a Falcon 9 in June 2021. It works with NARIT on watching objects in orbit.">Royal Thai Air Force</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Bangkok space-tech company founded in 2017. In November 2024 it signed an agreement with ispace and GISTDA to study a Moon mission under Thailand's national space programme.">mu Space</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="King Mongkut's University of Technology North Bangkok built KNACKSAT-2, a 3U CubeSat (30 x 10 x 10 cm) with a radio relay for internet-of-things sensors. It was released from the International Space Station on 3 February 2026.">KMUTNB</span>.</span></li>
              </ul>
              <div class="adr-section">India <button type="button" class="adr-more-btn" aria-expanded="false" aria-controls="adr-more-india">(more)</button></div>
              <ul class="adr-list" id="adr-more-india" hidden>
              <li><span class="adr-name" title="Landed at the Moon's south pole in 2023. Its space-safety centre in Bengaluru (IS4OM) steers India's satellites clear of junk, and in 2024 it set the goal: every Indian mission debris-free by 2030.">ISRO</span> <span class="adr-sub">Space agency</span></li>
              <li><span class="adr-name" title="Hyderabad rocket company. On 18 July 2026 Vikram-1 reached orbit from Sriharikota on its first try: India's first private orbital launch, carrying a robot arm built to catch space junk.">Skyroot Aerospace</span> <span class="adr-sub">Launcher</span></li>
              <li><span class="adr-name" title="A Hyderabad start-up building a soft robotic hand to catch space junk. Its EMBRACE arm rode Vikram-1 in July 2026, but the petals did not open. Nothing was caught; the team still got data.">Cosmoserve Space</span> <span class="adr-sub">Catch arm</span></li>
              <li class="adr-also">
                <span class="adr-nw"><span class="adr-name" title="Bengaluru space-surveillance start-up. Its SCOT satellite, launched in January 2025, watches other objects in orbit; in August 2026 it added MOSAIC, a ground network of optical sensors.">Digantara</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Chennai (IIT Madras), founded 2017. On 30 May 2024 its Agnibaan flew with a single-piece 3D-printed engine from India's first private launchpad. Its first orbital launch is planned for 2027.">Agnikul Cosmos</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Bengaluru, founded 2019. Its Fireflies hyperspectral Earth-imaging satellites launched in January and August 2025 on Falcon 9 rockets from California.">Pixxel</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Bengaluru propulsion company, founded 2015. Its green and electric thrusters were qualified in space on ISRO's PSLV-C58 (January 2024), and Rudra flew again on POEM-4 (PSLV-C60, December 2024). Its Pushpak space tug is in development.">Bellatrix Aerospace</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Bengaluru start-up building in-orbit refuelling. Its AayulSAT demo was due to fly on PSLV-C62 on 12 January 2026; that launch failed. A new launch date is not confirmed.">OrbitAID Aerospace</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Founded 2017. Its green thruster Vyom 2U flew on ISRO's POEM-4 (PSLV-C60, December 2024); its I-Booster for 100-500 kg satellites was delivered to India's defence research agency DRDO in December 2024.">Manastu Space</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Bengaluru rocket company. Razor Crest is designed to lift 24.8 tonnes to orbit, or about 8 tonnes when both stages are reused. First demonstration flight: late 2027.">EtherealX</span>.</span></li>
              </ul>
              <div class="adr-section">Japan <button type="button" class="adr-more-btn" aria-expanded="false" aria-controls="adr-more-japan">(more)</button></div>
              <ul class="adr-list" id="adr-more-japan" hidden>
              <li><span class="adr-name" title="Japan's space agency. With Astroscale it runs the Commercial Removal of Debris Demonstration (CRD2): Phase 1 (ADRAS-J) inspected a spent rocket stage; Phase 2 will capture and de-orbit it, from Japan's 2027 fiscal year.">JAXA</span> <span class="adr-sub">Space agency</span></li>
              <li><span class="adr-name" title="Tokyo debris remover. In 2024 ADRAS-J flew within ~15 m of a spent Japanese rocket stage. ADRAS-J2 will capture and de-orbit it, launching in Japan's 2027 fiscal year (April 2027 to March 2028).">Astroscale</span> <span class="adr-sub">Debris remover</span></li>
              <li><span class="adr-name" title="Utsunomiya start-up. Its HORN is a fan-shaped film that unfolds to add drag, so dead satellites fall sooner. Two units flew on an H3 rocket on 12 June 2026; one re-entered after 76 days.">BULL</span> <span class="adr-sub">Drag film</span></li>
              <li class="adr-also">
                <span class="adr-nw"><span class="adr-name" title="Tokyo, founded 2024 as a SKY Perfect JSAT spin-out. Builds compact space lasers to stop a dead satellite's spin and, later, to remove debris. Closed its Series A in March 2026.">Orbital Lasers</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Japanese satellite operator. In May 2026 it invested in Astroscale and agreed a partnership on in-orbit servicing, and it backs Orbital Lasers.">SKY Perfect JSAT</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Japan's air force space unit, formed as the Space Operations Wing on 23 March 2026 (it was a group). Its job is space domain awareness: watching what is in orbit. It works from Fuchu, Tokyo, and Yamaguchi.">JASDF Space Operations Wing</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Tokyo start-up building a catalogue of objects in orbit, including debris under 10 cm that is hard to track today. Chosen for JAXA's Space Strategy Fund; signed a space-awareness agreement with Axelspace on 1 September 2026.">Star Signal Solutions</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Tokyo satellite maker. Seven GRUS-3 satellites launched on a Falcon 9 on 7 July 2026; in September it said four had lost their high-speed downlink and cannot be recovered.">Axelspace</span>,</span>
                <span class="adr-nw"><span class="adr-name" title="Japanese rocket company building ZERO, a two-stage rocket for up to 1,000 kg to low orbit. ZERO has not flown yet: its launch pad is due to be finished in early 2027, and seven satellites are booked for its first flight.">Interstellar Technologies</span>.</span></li>
              </ul>
              <div class="adr-section">Other <button type="button" class="adr-more-btn" aria-expanded="false" aria-controls="adr-more-countries">(more)</button></div>
              <ul class="adr-list" id="adr-more-countries" hidden>
              <li class="adr-also">
                <span class="adr-nw"><span class="adr-name" title="America's space agency. Its Orbital Debris Program Office wrote NASA's first debris-mitigation rules in 1995 and builds the ORDEM and LEGEND debris models.">NASA</span> (USA),</span>
                <span class="adr-nw"><span class="adr-name" title="Europe's space agency. Its Space Debris Office, mainly at ESOC in Darmstadt, coordinates European debris research; its Clean Space initiative covers zero-debris technology and in-orbit servicing.">ESA</span> (Europe),</span>
                <span class="adr-nw"><span class="adr-name" title="Chose ClearSpace UK for its Active Debris Removal mission: robotic arms grab two dead British satellites, then thrusters push each into a controlled re-entry. The public may name the mission; online suggestions are not the agency's choice.">UK Space Agency</span> (UK).</span></li>
              </ul>
            </details>

            <!-- Kessler syndrome — absorbs the former true-stories hook group:
                 11 entries, chronological, year in the .adr-sub tag. -->
            <details class="adr-group">
              <summary>Kessler syndrome<span class="adr-count">11</span></summary>
              <ul class="adr-list">
              <li class="adr-prose">Proposed by NASA's Donald Kessler in 1978: once orbital junk gets dense enough, each collision throws off fragments that cause more collisions. A runaway cascade that can make whole orbits unusable for generations. Every dead satellite left up there raises the odds. The record so far:</li>
              <li><span class="adr-name" title="The nuclear-powered Kosmos 954 scattered radioactive debris across northern Canada in 1978. Canada billed the USSR under the 1972 Liability Convention, the only space-crash bill ever paid.">The only space-crash bill ever</span> <span class="adr-sub">Canada · 1978</span></li>
              <li><span class="adr-name" title="China destroyed its own Fengyun-1C weather satellite with a missile at ~865 km. The worst single debris event in history, and most of those fragments will linger for decades.">Chinese anti-satellite test</span> <span class="adr-sub">2007 · 3,000+ pieces</span></li>
              <li><span class="adr-name" title="The defunct Russian Cosmos 2251 slammed into the active Iridium 33 communications satellite. The first accidental crash between two whole satellites.">Iridium–Cosmos crash</span> <span class="adr-sub">2009 · 2,000+ pieces</span></li>
              <li><span class="adr-name" title="Launched in 1965 and long thought dead, the LES-1 satellite was detected transmitting again in 2013. Its tumbling likely switches its transmitter on and off. Nobody sent the command.">The zombie satellite</span> <span class="adr-sub">1967 → 2013</span></li>
              <li><span class="adr-name" title="In 2021 the working Yunhai 1-02 satellite was struck by a fragment of a Zenit rocket launched back in 1996. A 25-year-old piece of junk found its target.">Hit by a rocket from 1996</span> <span class="adr-sub">2021</span></li>
              <li><span class="adr-name" title="Russia destroyed the defunct Cosmos 1408 satellite in a weapons test, scattering fragments that forced the ISS crew to shelter in their capsules.">Russian anti-satellite test</span> <span class="adr-sub">2021 · 1,500+ pieces</span></li>
              <li><span class="adr-name" title="A minor solar storm in 2022 warmed and puffed up the upper atmosphere, adding just enough drag to pull 38 freshly-launched Starlink satellites back down before they reached their orbits.">A solar storm sinks 38 Starlinks</span> <span class="adr-sub">2022</span></li>
              <li><span class="adr-name" title="A battery pallet jettisoned from the ISS survived reentry in 2024 and punched clean through the roof of a Florida home. It was supposed to burn up entirely.">A piece of the Station hits a house</span> <span class="adr-sub">Florida · 2024</span></li>
              <li><span class="adr-name" title="Kosmos 482 was a Soviet Venus lander stranded in Earth orbit by a 1972 launch failure. Built to survive Venus, it fell back to Earth intact 53 years later, in 2025.">The Venus lander that stayed</span> <span class="adr-sub">1972 → 2025</span></li>
              <li><span class="adr-name" title="Darren McKnight's 2025 paper: removing the 50 most dangerous objects in low orbit would halve their debris-making potential. 34 are Russian or Soviet, 10 Chinese; 88% are rocket bodies. The biggest old ones are the most valuable removals.">The 50 most dangerous objects</span> <span class="adr-sub">2025 · 88% rocket bodies</span></li>
              <li><span class="adr-name" title="The US Space Surveillance Network watches for close passes; the ISS fires its thrusters to dodge when collision odds exceed 1 in 10,000. About once a year on average (NASA). If a threat is spotted too late, the crew shelters in their return capsules.">ISS dodges debris</span> <span class="adr-sub">~1× / year</span></li>
              </ul>
            </details>

            <!-- The new rules — India first -->
            <details class="adr-group">
              <summary>Clean up is the law<span class="adr-count">6</span></summary>
              <ul class="adr-list">
              <li class="adr-prose">Sixty years of leftovers plus mega-constellations adding satellites by the thousand turned &ldquo;someday&rdquo; into &ldquo;this decade.&rdquo; Regulators answered with hard deadlines: some binding law, some pledges with a date.</li>
              <li><span class="adr-name" title="ISRO's pledge, made in April 2024 while India hosted the world's debris agencies in Bengaluru: every Indian space mission, government or private, debris-free by 2030. The new private rocket companies signed up alongside ISRO.">Debris-Free Space Missions</span> <span class="adr-sub">India · by 2030</span></li>
              <li><span class="adr-name" title="The 2023 policy that opened Indian space to private companies, and the 2024 rulebook that came with it: one regulator, one authorisation per launch or satellite, and a collision risk over the mission's life below 1 in 1,000.">Indian Space Policy 2023</span> <span class="adr-sub">India · IN-SPACe</span></li>
              <li><span class="adr-name" title="US Federal Communications Commission, 2022. Satellites in low orbit must now be removed within 5 years of mission end. Replacing the old 25-year guideline. First fine: Dish Network, $150,000 (2023).">FCC 5-year rule</span> <span class="adr-sub">USA · 2022</span></li>
              <li><span class="adr-name" title="European Space Agency's Zero Debris Charter (2023): no new debris generated by participating missions by 2030, with disposal success above 90% and orbital clearance in under 5 years.">ESA Zero Debris</span> <span class="adr-sub">Europe · by 2030</span></li>
              <li><span class="adr-name" title="Proposed EU-wide Space Act (June 2025): would require debris-mitigation plans, collision avoidance and end-of-life deorbiting for any operator serving the EU market. Targeted to apply from 2030.">EU Space Act</span> <span class="adr-sub">EU · proposed 2025</span></li>
              <li><span class="adr-name" title="The UN Committee on the Peaceful Uses of Outer Space (2007 guidelines) and the Inter-Agency Space Debris Coordination Committee. The technical origin of the original 25-year disposal rule that national laws build on.">UN COPUOS / IADC</span> <span class="adr-sub">global</span></li>
              </ul>
            </details>

            <!-- Who removes debris — Cosmoserve first -->
            <details class="adr-group">
              <summary>Who removes debris<span class="adr-count">7</span></summary>
              <ul class="adr-list">
              <li><span class="adr-name" title="Hyderabad start-up. EMBRACE is a soft robotic hand: petals that close gently around a dead satellite. It rode Vikram-1 into orbit in July 2026, but the petals did not open. Nothing was caught; the team still got data.">Cosmoserve Space</span> <span class="adr-sub">India · flew 2026, petals stuck</span></li>
              <li><span class="adr-name" title="Tokyo-based pure-play debris remover. In 2024 its ADRAS-J spacecraft flew within ~15 m of a discarded Japanese rocket stage. The follow-up ADRAS-J2 will grab and de-orbit that stage, launching in Japan's 2027 fiscal year (April 2027 to March 2028).">Astroscale</span> <span class="adr-sub">Japan · ADRAS-J</span></li>
              <li><span class="adr-name" title="Subsidiary of Northrop Grumman, and the only company doing this routinely today. Its Mission Extension Vehicles docked with live Intelsat satellites (2020–21) to add years of life. A new Mission Robotic Vehicle launched in July 2026.">Northrop Grumman SpaceLogistics</span> <span class="adr-sub">USA</span></li>
              <li><span class="adr-name" title="Swiss start-up. Its UK arm will lead the UK Space Agency's debris-removal mission: £61 million (about $81 million), launch 2029 from SaxaVord, Shetland, two dead British satellites removed by 2032. Its ESA mission targets PROBA-1.">ClearSpace</span> <span class="adr-sub">Switzerland · UK</span></li>
              <li><span class="adr-name" title="Italian space-logistics firm. Its ION space tug has flown since 2020; next, its RISE mission for ESA will service a satellite in geostationary orbit, around 2028.">D-Orbit</span> <span class="adr-sub">Italy</span></li>
              <li><span class="adr-name" title="Seattle start-up. Its Otter vehicle is designed to dock with satellites that were never built to be caught; it won a US Space Force contract to de-orbit a retired satellite.">Starfish Space</span> <span class="adr-sub">USA</span></li>
              <li><span class="adr-name" title="Pioneer of in-orbit refuelling. 'gas stations in space'. Its RAFTI fuel port is becoming a de-facto industry standard for refuellable satellites.">Orbit Fab</span> <span class="adr-sub">USA</span></li>
              <li class="adr-also">Also emerging:
                <span class="adr-name" title="Los Angeles. Uses an inflatable 'capture bag' to scoop up debris and spent objects.">TransAstra</span>,
                <span class="adr-name" title="Michigan. Gecko-adhesive and microspine gripper arms (REACCH) to grab tumbling, uncooperative debris.">Kall Morris</span>,
                <span class="adr-name" title="Canada (Ottawa). Tether-net capture and the 'Puck' docking system for in-orbit servicing.">Obruta</span>.</li>
              </ul>
            </details>

            <!-- Who tracks debris — Digantara first -->
            <details class="adr-group">
              <summary>Who tracks debris<span class="adr-count">7</span></summary>
              <ul class="adr-list">
              <li><span class="adr-name" title="Bengaluru's eyes in orbit. In January 2025 Digantara launched SCOT, India's first satellite built purely to watch other objects in space; it scans space junk down to 5 cm. In August 2026 it added MOSAIC, a ground network of optical sensors.">Digantara</span> <span class="adr-sub">India · 5 cm</span></li>
              <li><span class="adr-name" title="Run by the US Space Force; catalogues 34,000+ objects, generally larger than 10 cm. Its Space Fence radar on Kwajalein Atoll (Marshall Islands) was designed to follow about 200,000 objects; the Space Force calls it its most sensitive search radar.">US Space Surveillance Network</span> <span class="adr-sub">USA · Space Fence</span></li>
              <li><span class="adr-name" title="The European Union Space Surveillance and Tracking partnership. Radars and telescopes shared by 15 EU nations, with the catalogue hosted in Germany. Safeguards 600+ satellites.">EU SST</span> <span class="adr-sub">Europe</span></li>
              <li><span class="adr-name" title="Menlo Park, California. A commercial network of phased-array radars in Alaska, Texas, Costa Rica, the Azores, New Zealand and Australia, tracking objects in low orbit from the ground.">LeoLabs</span> <span class="adr-sub">USA</span></li>
              <li><span class="adr-name" title="El Segundo, California. A global optical-sensor network paired with AI analytics for tracking objects and issuing collision warnings.">Slingshot Aerospace</span> <span class="adr-sub">USA</span></li>
              <li><span class="adr-name" title="Montreal. Operates the first commercial space-based tracking system. Its Skylark satellites watch other objects from orbit rather than from the ground.">NorthStar Earth &amp; Space</span> <span class="adr-sub">Canada</span></li>
              <li><span class="adr-name" title="Foothill Ranch, California. Runs the world's largest commercial telescope network. 350+ scopes. Watching the higher orbits, including geostationary.">ExoAnalytic Solutions</span> <span class="adr-sub">USA</span></li>
              <li class="adr-also">Collision-avoidance software:
                <span class="adr-name" title="Munich, Germany. Space-traffic management and a ground-sensor network, with in-orbit sensors planned.">Vyoma</span>,
                <span class="adr-name" title="Coimbra, Portugal. AI that assesses collision risk and suggests avoidance manoeuvres days in advance.">Neuraspace</span>,
                <span class="adr-name" title="Colorado, USA. 'Pathfinder' autonomy and collision-avoidance tools; supports the US Office of Space Commerce's traffic-coordination system.">Kayhan Space</span>.</li>
              </ul>
            </details>

            <!-- Upcoming events — each <li> carries data-end (YYYY-MM-DD, last day);
                 MenuScreen._pruneEvents() hides the ones already over and sets
                 the badge, so this list never shows a past event. Last checked 2026-10-25. -->
            <details class="adr-group" data-group="events">
              <summary>Upcoming events<span class="adr-count">5</span></summary>
              <ul class="adr-list">
              <li data-end="2026-10-31"><span class="adr-name" title="Run by GISTDA, Thailand's space agency, at ICONSIAM with free entry: satellites, rockets and the region's space start-ups. Shares its week with the Asia-Pacific agency forum APRSAF-32.">Thailand Space Expo</span> <span class="adr-sub">Bangkok · 28-31 Oct</span></li>
              <li data-end="2026-11-05"><span class="adr-name" title="Secure World Foundation's flagship policy event on keeping orbit usable, with the Brazilian Space Agency. The 8th edition, and the first in Latin America.">Summit for Space Sustainability</span> <span class="adr-sub">Brasília · 4-5 Nov</span></li>
              <li data-end="2026-11-19"><span class="adr-name" title="Europe's trade show for the space supply chain. This is its last year in Bremen; from 2027 it moves to Frankfurt.">Space Tech Expo Europe</span> <span class="adr-sub">Bremen · 17-19 Nov</span></li>
              <li data-end="2027-02-26"><span class="adr-name" title="Singapore's space conference and exhibition for agencies, industry, investors and policymakers. Its second year; the first ran alongside the 2026 Singapore Airshow.">Singapore Space Summit</span> <span class="adr-sub">Singapore · 25-26 Feb 2027</span></li>
              <li data-end="2027-03-11"><span class="adr-name" title="The biggest satellite-industry show (SATELLITE, with GovMilSpace), including a space-domain-awareness track. Conference 8-11 March, exhibition 9-11 March.">SATShow Week</span> <span class="adr-sub">Washington · 8-11 Mar 2027</span></li>
              </ul>
            </details>

            <details class="adr-group">
              <summary>Rawhide<span class="adr-count">2</span></summary>
              <ul class="adr-list">
              <li class="adr-prose"><em>&ldquo;Rollin', rollin', rollin'&hellip; <strong>Rawhide!</strong>&rdquo;</em></li>
              <li><a class="adr-name" href="https://www.youtube.com/watch?v=RdR6MN2jKYs" target="_blank" rel="noopener noreferrer" title="The Good Ole Boys / chicken-wire bar scene from The Blues Brothers (1980), Movieclips upload on YouTube. Opens in a new tab.">▶ The Blues Brothers &mdash; &ldquo;Rawhide&rdquo;</a></li>
              </ul>
            </details>

          </div><!-- /#menu-left -->

        </div><!-- /#menu-body -->
      </div><!-- /#menu-content -->
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Initialise 3D hero scene
    this._ensureScene3D();

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

    // Help "?" beside it (D3) — inert and hidden until setHelpOpener().
    this._wireHelpButton();

    // The version button opens the notes card; the notes themselves load once, here (show() waits on them).
    this._wireVersionButton();

    // Touch-friendly lore tooltips (replaces native title= which is invisible
    // on touch). Converts .adr-name[title] → data-tip and wires tap/hover.
    this._initLoreTooltips();

    // Drop events that are already over, so the list never goes stale.
    this._pruneEvents();

    // "(more)" beside a country name shows that country's other names.
    const left = this.element.querySelector('#menu-left');
    if (left) {
      left.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.adr-more-btn');
        if (!btn) return;
        this._toggleMore(btn);
        // Drop focus so a later Enter starts the mission instead of re-toggling.
        if (typeof btn.blur === 'function') btn.blur();
      });
    }
  }

  /**
   * @private Show or hide what one "(more)" button controls (its aria-controls
   * element: a country's list, or the NASA/ESA row). Opening one closes every
   * other, so at most one is open. The button reads "(more)" while closed and
   * "(less)" while open; its first label is kept in data-label.
   */
  _toggleMore(btn) {
    const row = this.element.querySelector('#' + btn.getAttribute('aria-controls'));
    if (!row) return;
    const open = row.hidden;
    if (open) {
      this.element.querySelectorAll('.adr-more-btn').forEach((other) => {
        if (other !== btn) this._setMore(other, false);
      });
    }
    this._setMore(btn, open);
  }

  /** @private Set one "(more)" button open or closed (row, aria-expanded, label). */
  _setMore(btn, open) {
    const row = this.element.querySelector('#' + btn.getAttribute('aria-controls'));
    if (!row) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    row.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '(less)' : btn.dataset.label;
  }

  /**
   * @private Open the country a language flag stands for (COUNTRY_FOR_FLAG):
   * its Countries group opens and that country's list shows (organisations and
   * other names); every other country closes. An unknown flag or one with no
   * entry (BRA) closes them all.
   */
  _openCountryFor(flag) {
    const id = COUNTRY_FOR_FLAG[flag] || null;
    const want = id ? 'adr-more-' + id : null;
    this.element.querySelectorAll('.adr-more-btn').forEach((btn) => {
      this._setMore(btn, btn.getAttribute('aria-controls') === want);
    });
    if (want) {
      const group = this.element.querySelector('#' + want)?.closest('details');
      if (group) group.open = true;
    }
  }

  /**
   * @private Hide each past event in the "Upcoming events" group (by its
   * data-end date, device clock), set the badge to the number still shown and
   * hide the whole group when none are left. Runs before the tooltips matter:
   * hidden rows simply never get hovered.
   */
  _pruneEvents(now = new Date()) {
    const group = this.element.querySelector('details[data-group="events"]');
    if (!group) return;
    const rows = [...group.querySelectorAll('li[data-end]')];
    const keep = new Set(upcomingEventIndexes(rows.map((r) => r.getAttribute('data-end')), localIsoDate(now)));
    rows.forEach((r, i) => { r.hidden = !keep.has(i); });
    const badge = group.querySelector('.adr-count');
    if (badge) badge.textContent = String(keep.size);
    group.hidden = keep.size === 0;
  }

  /**
   * @private Migrate the lore panel's native `title=` tooltips to a styled,
   * tap-toggleable popover. Native `title` never shows on touch devices; this
   * gives the same factoids a tap target on touch and a hover on pointer
   * devices, in the library's INFO grammar (#aaddff prose, proportional B612,
   * opaque plate). Free-text only — these
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
   * and emits Events.LANGUAGE_CHANGED (consumed by MenuOrbitPreview to re-aim
   * the live backdrop toward the regional start orbit, and available to a
   * future i18n string layer).
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
        this._openCountryFor(lang.flag);
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
    this._openCountryFor(settingsManager.getLanguageEntry().flag);   // page load shows the saved pick's country
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

  /**
   * Inject what the menu "?" button opens (main.js passes the HotkeyOverlay
   * toggle — the same list the ? key opens). Reveals the button; until this is
   * called the button stays hidden, so it is never a dead control.
   * @param {(() => void)|null} fn
   */
  setHelpOpener(fn) {
    this._helpOpener = (typeof fn === 'function') ? fn : null;
    const btn = this.element && this.element.querySelector('#menu-help-btn');
    if (btn) btn.style.display = this._helpOpener ? '' : 'none';
  }

  /** @private Wire the "?" button's click to the injected opener (D3). */
  _wireHelpButton() {
    const btn = this.element && this.element.querySelector('#menu-help-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      if (!this._helpOpener) return;
      this._closeLangMenu();
      audioSystem.playClick?.();
      // Drop focus so a later Enter starts the mission instead of re-pressing "?".
      if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
      this._helpOpener();
    });
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
    if (this._autoUpdating) return;   // up1: the update switch is under way — no confirm, no start
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
    if (this._autoUpdating) return;
    if (this._departing) { this._finishDeparture(true); return; }
    this._closeNotes(false);   // the notes card folds away; START was never blocked by it
    // Note: the new-game save-wipe confirm lives in _requestStartGame() (the
    // button/key entry point). _startGame() is the confirmed departure path.
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    // New game → cinematic pull-back, then MENU_START. Extended to 3.65s
    // (cameraDur 3.5) so the astronaut exit drifts further from the mother and
    // the orientation move (random partial-flash or fly-around) plays calmly.
    // cameraDur also clamps the fraction-based astronaut beat timeline.
    this._beginDeparture(Events.MENU_START, 3650, 3.5);
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
    if (this._autoUpdating) return;   // up1: the backstop — no departure while the update switch is under way
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
   * get the same live-scene handoff as a new game. Continue now routes straight
   * to ORBITAL_VIEW flight (no BRIEFING card); mission context arrives as a
   * welcome-back comms trickle. The departure stays brief — returning players
   * value speed.
   */
  _continueGame() {
    if (this._autoUpdating) return;
    if (this._departing) { this._finishDeparture(true); return; }
    this._closeNotes(false);   // the notes card folds away on the way out
    audioSystem.init();
    audioSystem.resume();
    audioSystem.playClick();
    this._beginDeparture(Events.MENU_CONTINUE, 600, 0.6);
  }

  /**
   * Build the 3D hero scene if it does not already exist (idempotent). Normally
   * built once and kept alive across hide/show (stop/start), so this is a no-op
   * after construction; it exists so `show()` self-heals if the instance is ever
   * null (e.g. a failed initial init) rather than leaving a permanently blank
   * hero. Mirrors the original constructor build path + its try/catch.
   */
  _ensureScene3D() {
    if (this._menuScene3D) return;
    const canvas3d = this.element.querySelector('#menu-scene-3d');
    if (!canvas3d) return;
    try {
      this._menuScene3D = new MenuScene3D(this._initialTier);
      this._menuScene3D.init(canvas3d);
    } catch (err) {
      console.warn('MenuScene3D init failed (fallback to blank):', err);
      this._menuScene3D = null;
    }
  }

  // ── Session J.5 — the menu UPDATE card ─────────────────────────────────────

  /**
   * @private Events.UPDATE_AVAILABLE `{ hash, tag, bullets }` (UpdateWatch emits
   * it once per new hash). Remember it; mount now only while the menu is
   * visible — otherwise show() mounts it on the next menu visit.
   */
  _onUpdateAvailable(p) {
    if (!p || typeof p.hash !== 'string' || !p.hash) return;
    this._update = p;
    if (this.visible) this._mountUpdateCard();
  }

  /**
   * @private Build the card (ui/UpdateCard.js) and insert it into #menu-header
   * right AFTER #menu-continue-wrapper, so it sits centered under the START /
   * CONTINUE buttons and cascades out with the header on departure. Idempotent
   * per hash; a hash the player already answered LATER to never re-mounts.
   * The card never exists outside #menu-screen: the mount target is looked up
   * on this.element only.
   */
  _mountUpdateCard() {
    const p = this._update;
    if (!p || !this.element) return;
    if (this._autoUpdating) return;   // up1: the notice holds the place; the card returns only if the switch gives up
    if (this._updateDismissed === p.hash) return;
    if (this._updateCard && this._updateCard._hash === p.hash) return;
    this._closeNotes(false);          // the waiting build's card wins: one restart control on screen, never two
    this._unmountUpdateCard();
    const anchor = this.element.querySelector('#menu-continue-wrapper');
    if (!anchor || !anchor.insertAdjacentElement) return;
    const card = buildUpdateCard(document, {
      hash: p.hash,
      bullets: p.bullets,
      onUpdate: () => this._applyUpdate(),
      onLater: () => {
        this._updateDismissed = p.hash;   // remember for this page session only
        this._unmountUpdateCard();
        this._syncVersionDot();           // the version button's dot keeps the news one tap away
      },
    });
    card._hash = p.hash;
    anchor.insertAdjacentElement('afterend', card);
    this._updateCard = card;
  }

  /** @private Remove the card from the header (no-op when absent). */
  _unmountUpdateCard() {
    if (this._updateCard) {
      if (this._updateCard.remove) this._updateCard.remove();
      this._updateCard = null;
    }
  }

  /**
   * @private Events.UPDATE_AUTO_APPLY `{ hash, tag, bullets }` (UpdateWatch
   * emits it INSTEAD of UPDATE_AVAILABLE when a build is waiting, the state is
   * the menu, no game has begun, this is the only window and this build was not
   * tried yet): show one line and switch, through the same `_applyUpdate()` as
   * the tap, so `_reload()` stays the page's one reload site. While `_autoUpdating`
   * every start path returns early. If a departure is already playing (or the
   * menu is not up) it never switches: the card path takes over.
   */
  _onUpdateAutoApply(p) {
    if (!p || typeof p.hash !== 'string' || !p.hash) return;
    if (this._autoUpdating) return;
    if (!this.visible || this._departing || this._applyingUpdate) { this._onUpdateAvailable(p); return; }
    // D3: the loop-guard key is written HERE, only when the switch really starts; a menu
    // that fell back to the card above leaves the build "untried". No usable key → the card.
    if (!this._claimAutoApply(p.appBuild)) { this._onUpdateAvailable(p); return; }
    this._update = p;
    this._autoUpdating = true;
    const attempt = ++this._autoAttempt;
    this._closeNotes(false);
    this._unmountUpdateCard();
    this._mountUpdateNotice();
    this._armAutoUpdateRelease();
    // Cancellable: once the failsafe let go (or a later attempt began) a still-pending switch posts and reloads nothing.
    this._applyUpdate(() => !this._autoUpdating || this._autoAttempt !== attempt);
  }

  /** @private Take the one auto-apply attempt for this build (sessionStorage guard). Overridable for tests. */
  _claimAutoApply(appBuild) {
    return claimAutoApply(appBuild);
  }

  /**
   * @private The one-line notice, right after #menu-continue-wrapper (where the
   * card would sit), looked up on this.element only. Text via textContent.
   */
  _mountUpdateNotice() {
    if (!this.element) return;
    this._unmountUpdateNotice();
    const anchor = this.element.querySelector('#menu-continue-wrapper');
    if (!anchor || !anchor.insertAdjacentElement) return;
    const note = document.createElement('div');
    note.id = 'menu-update-notice';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    note.textContent = UPDATE_NOTICE_TEXT;
    note.style.cssText = `
      display: block; box-sizing: border-box; width: 100%; max-width: 420px;
      margin: 0.9rem auto 0; padding: 12px 16px; text-align: center;
      background: rgba(4,12,30,0.52); border: 1px solid rgba(0,255,136,0.14); border-radius: 8px;
      font-family: var(--font-mono); font-size: 0.95rem; letter-spacing: 0.12em; color: #00ff88;
    `;
    anchor.insertAdjacentElement('afterend', note);
    this._updateNotice = note;
  }

  /** @private Remove the notice (no-op when absent). */
  _unmountUpdateNotice() {
    if (this._updateNotice) {
      if (this._updateNotice.remove) this._updateNotice.remove();
      this._updateNotice = null;
    }
  }

  /** @private Failsafe: a switch that never lands must not lock the menu for good. */
  _armAutoUpdateRelease() {
    if (this._autoUpdateTimer) clearTimeout(this._autoUpdateTimer);
    this._autoUpdateTimer = setTimeout(() => this._releaseAutoUpdate(), AUTO_UPDATE_RELEASE_MS);
  }

  /**
   * @private The switch did not take the page away: open the lock, drop the
   * notice, let a tap try again, and show the card.
   */
  _releaseAutoUpdate() {
    this._autoUpdateTimer = null;
    if (this._reloadIssued) return;   // the page is already going away: do not open the lock under it
    if (!this._autoUpdating) return;
    this._autoUpdating = false;
    this._applyingUpdate = false;
    this._unmountUpdateNotice();
    if (this.visible && this._update) this._mountUpdateCard();
  }

  /**
   * @private RESTART NOW. The new build is installed and WAITING in the
   * service worker (it never takes over by itself): switch to it, and reload
   * once it has taken over. With no worker waiting this is a plain reload.
   * core/UpdateWatch.js applyUpdate() owns the order (listener first, then
   * SKIP_WAITING) and reloads through _reload(). Overridable for tests.
   */
  _applyUpdate(cancelled) {
    if (this._applyingUpdate) return;   // a second tap must not stack a second listener
    this._applyingUpdate = true;
    if (typeof cancelled === 'function') {
      // The automatic switch: it can be called off (see _onUpdateAutoApply), and then it never reloads.
      applyUpdate({ reload: () => this._reload(), cancelled }).catch(() => { if (!cancelled()) this._reload(); });
      return;
    }
    applyUpdate({ reload: () => this._reload() }).catch(() => this._reload());
  }

  /** @private The page's ONE reload site. Overridable for tests. */
  _reload() {
    this._reloadIssued = true;
    window.location.reload();
  }

  /**
   * @private The START button's hint line. Desktop: "Press Enter or Click" / "Click to start new (confirms)". Glass
   * (read now, D7): "Tap to start" / "Tap to start new (confirms)" - a tap on the button starts the same way.
   * @param {boolean} [hasSave] omit to ask the save store
   */
  _syncStartHint(hasSave) {
    if (!this.element) return;
    const startHint = this.element.querySelector('#menu-start-hint');
    if (!startHint) return;
    const saved = (hasSave === undefined) ? persistenceManager.hasSave() : hasSave;
    const glass = GestureHints.isGlass();
    startHint.textContent = saved
      ? (glass ? 'Tap to start new (confirms)' : 'Click to start new (confirms)')
      : (glass ? 'Tap to start' : 'Press Enter or Click');
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
    // The menu object lives for the whole session (built once at boot), so an
    // event that ends while the tab sits open must be hidden on every show().
    this._pruneEvents();
    // Toggle Continue button visibility based on whether a save exists
    const hasSave = persistenceManager.hasSave();
    const continueWrapper = this.element.querySelector('#menu-continue-wrapper');
    if (continueWrapper) {
      continueWrapper.style.display = hasSave ? 'block' : 'none';
    }
    // F1 save-guard: when a save exists, Enter maps to CONTINUE (the safe
    // action), so the START button's key hint must not claim Enter starts a
    // new game. Keep the copy honest with the actual key mapping.
    this._syncStartHint(hasSave);
    // Session J.5: an update that arrived while the menu was hidden (or that
    // the watcher found before the first show) mounts its card now.
    if (this._update) this._mountUpdateCard();
    this._showNotice();
    this.element.style.display = 'flex';
    this.element.style.opacity = '1';
    // Listen for keyboard input while menu is shown
    window.addEventListener('keydown', this._boundKeyHandler);
    // Start 3D scene — lazily rebuild it if a prior hide() disposed it.
    this._ensureScene3D();
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
    this._closeNotes(false);
    if (this._hideLoreTip) this._hideLoreTip();
    // Stop 3D scene. NOTE: we intentionally do NOT dispose()+rebuild the hero
    // here. A dispose/rebuild cycle would poison shared caches — ArmUnit.dispose()
    // frees the module-shared bridle geometry (`_sharedBridleGeo`) and the cached
    // additive-glow texture, and PlayerSatellite has no eventBus teardown — so the
    // rebuilt hero on a later menu visit would reference disposed GPU resources and
    // leak listeners. Keeping the single instance alive (stop on hide, start on
    // show) is the safe baseline; a true teardown needs hardened
    // ArmUnit/PlayerSatellite dispose() paths + menu QA (tracked as follow-up).
    if (this._menuScene3D) this._menuScene3D.stop();
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 500);
  }

  // ── Update notice: the version button + the notes card (owner 2026-10-26, DECISIONS §43) ─────────────────────
  // Non-modal: the card is a fixed child of #menu-screen (never inside the <h1>, never in the flow of
  // #menu-header, so START does not move), it takes no focus, and every departure folds it away.

  /**
   * Inject what the notes card's "Check for updates" runs (main.js passes UpdateWatch.checkNow). Without one the
   * link is not drawn. The checker resolves 'ready' | 'current' | 'offline'.
   * @param {(() => Promise<string>)|null} fn
   */
  setUpdateChecker(fn) {
    this._updateChecker = (typeof fn === 'function') ? fn : null;
  }

  /** @private Wire the version button; start the one read of the running build's notes. */
  _wireVersionButton() {
    const btn = this.element && this.element.querySelector('#menu-version-btn');
    const more = btn && btn.querySelector ? btn.querySelector('.menu-version-more') : null;
    // Until the notes are known the button is just the version (never a dead "What's new").
    if (more && more.style) more.style.display = 'none';
    if (btn && btn.addEventListener) {
      btn.addEventListener('click', (e) => {
        audioSystem.playClick?.();
        // Drop focus so a later Enter starts the mission instead of re-pressing the version (see _wireHelpButton).
        if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
        this._toggleNotes();
      });
    }
    this._notesPromise = loadNotes().then((n) => {
      this._notes = n;
      if (n && more && more.style) more.style.display = '';
      if (n && btn && btn.setAttribute) btn.setAttribute('aria-label', "What's new in this version");   // only when there are notes to open
      return n;
    });
  }

  /** @private The dot: notes not opened yet, or a waiting build the player answered LATER to. */
  _syncVersionDot() {
    const btn = this.element && this.element.querySelector ? this.element.querySelector('#menu-version-btn') : null;
    if (!btn || !btn.classList) return;
    const later = !!(this._update && this._updateDismissed === this._update.hash);
    const on = !!(this._notice && this._notice.dot) || later;
    if (on) btn.classList.add('has-dot'); else btn.classList.remove('has-dot');
  }

  /**
   * @private show(): once the notes are loaded, decide (readNotice, once per page load) whether the "Updated to"
   * card shows by itself and whether the dot is lit. A waiting build's card wins; the notes then stay one tap away.
   */
  _showNotice() {
    const ready = this._notesPromise;
    if (!ready || typeof ready.then !== 'function') return;
    ready.then((n) => {
      if (!n || !this.visible) return;
      if (!this._notice) this._notice = readNotice(undefined, n.version);
      const auto = this._notice.card;
      this._notice.card = false;   // once per page load
      this._syncVersionDot();
      if (auto && !this._update && !this._autoUpdating && !this._applyingUpdate && !this._departing) this._openNotes('updated');
    });
  }

  /** @private The version button: open the notes, or (second tap) fold them away. Writes `seen` either way. */
  _toggleNotes() {
    if (this._autoUpdating || this._departing) return;
    if (this._notesCard) { this._seenNotes(); this._closeNotes(); return; }
    if (!this._notes) {
      // No notes to show: the button only brings back a waiting build's card.
      if (this._update) { this._updateDismissed = null; this._mountUpdateCard(); this._syncVersionDot(); }
      return;
    }
    this._seenNotes();
    this._openNotes('opened');
  }

  /** @private These notes were opened or dismissed: remember it, put the dot out. */
  _seenNotes() {
    if (!this._notes) return;
    markSeen(undefined, this._notes.version);
    if (this._notice) this._notice.dot = false;
    this._syncVersionDot();
  }

  /**
   * @private Build, mount and place the notes card. A waiting build swaps "Check for updates" for
   * "New version ready" + RESTART NOW and takes its own card off the screen (one restart control, never two).
   * @param {'updated'|'opened'} mode
   */
  _openNotes(mode) {
    const n = this._notes;
    if (!n || !this.element || !this.element.appendChild) return;
    this._closeNotes(false);
    const updateReady = !!(this._update && !this._autoUpdating);
    if (updateReady) this._unmountUpdateCard();
    const checker = this._updateChecker;
    const card = buildWhatsNewCard(document, {
      version: n.version,
      bullets: n.bullets,
      mode,
      onGotIt: () => { this._seenNotes(); this._closeNotes(); },
      updateReady,
      onRestart: () => this._applyUpdate(),
      onCheck: checker ? () => checker() : null,
      onReady: () => this._onCheckReady(),
    });
    this.element.appendChild(card);
    this._notesCard = card;
    this._placeNotes();
    this._onNotesResize = () => this._placeNotes();
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', this._onNotesResize);
  }

  /** @private Sit the card just under the version button (fixed; re-run on resize). */
  _placeNotes() {
    const card = this._notesCard;
    const btn = this.element && this.element.querySelector ? this.element.querySelector('#menu-version-btn') : null;
    if (!card || !btn || typeof btn.getBoundingClientRect !== 'function') return;
    const p = placeNotice(btn.getBoundingClientRect(), window.innerWidth);
    card.style.top = `${Math.round(p.top)}px`;
    card.style.left = `${Math.round(p.left)}px`;
    card.style.width = `${Math.round(p.width)}px`;
  }

  /**
   * @private Fold the notes card away (no-op when absent). `remount` (default) brings back a waiting build's own
   * card, which the open notes had replaced; departures and hide() pass false.
   */
  _closeNotes(remount = true) {
    const card = this._notesCard;
    if (!card) return;
    this._notesCard = null;
    if (card.remove) card.remove();
    if (this._onNotesResize && typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', this._onNotesResize);
    this._onNotesResize = null;
    if (remount && this.visible && !this._departing && !this._autoUpdating && this._update && this._updateDismissed !== this._update.hash) this._mountUpdateCard();
  }

  /** @private "Check for updates" found a build: the notes card closes, the waiting build's card takes the place. */
  _onCheckReady() {
    this._closeNotes(false);
    // A late 'ready' (the menu left or hid meanwhile): never mount into a departure or a hidden menu. The build is
    // remembered by _onUpdateAvailable (this._update), and show() mounts its card on the next visit.
    if (!this.visible || this._departing) return;
    if (!this._update) return;
    this._updateDismissed = null;   // an explicit tap overrides an earlier LATER
    this._mountUpdateCard();
    this._syncVersionDot();
  }
}

export default MenuScreen;
