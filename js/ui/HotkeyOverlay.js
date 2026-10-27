/**
 * HotkeyOverlay.js — DOM overlay listing the keys and controls, grouped by
 * category. Toggle with the ? key (Slash), the menu's ? button or the ? button
 * at the top right of floor 1 (mountF1Button). Escape or ? closes.
 *
 * Layout: full-screen overlay → centered panel → a short overview (what you are
 * doing and why, the reward, the next key), then a grid of
 * group cards (Start here / Daughters / Ship & views; each a labelled list of
 * key chip → description rows) plus two closed, expandable sections: Stuck?
 * and Advanced.
 * Mirrors the visual language of CodexViewerUI (dark panel, cyan accents,
 * the house mono token) so it feels native to the HUD.
 *
 * Language (DECISIONS §44, owner 2026-10-27): the page shows in the language
 * the menu picker holds (settingsManager.getLanguage()). The English words are
 * the rows below; the other six languages come from helpText.js, keyed by each
 * row's `id`. The page is read again on every show() and rebuilt on
 * Events.LANGUAGE_CHANGED.
 *
 * @module ui/HotkeyOverlay
 */
import { wordsFor, satelliteIsTheStop } from '../systems/resupplyWords.js';
import { settingsManager } from '../systems/SettingsManager.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { helpTextFor } from './helpText.js';

// Scripts that join letters or have no capitals: wide letter spacing and CSS upper-casing would break them, so the
// title, hint and group names drop both for these languages (DECISIONS §44).
const UNSPACED_LANGUAGES = new Set(['th', 'ja', 'hi', 'ta']);

// Grouped hotkey reference. Each group → list of rows
// `[chips, description, opts?]`. `chips` is an array; a chip may itself contain
// a separator like '/' which is rendered as plain text between two key caps.
// `opts` (H1, 2026-10-09):
//   • { grey: '<reason>' } — a bound key whose feature is not built / not
//     unlocked: shown greyed with "— <reason>" after the description. Advanced
//     only (test-HelpTruth pins that).
//   • { pointer: true }    — a mouse / touch row: its chips are words, not keys,
//     so the key-vs-binding checks skip it.
// A group with `collapsed: true` renders as a native closed <details> whose
// summary reads "<title> (<row count>)"; it is closed on every open.
//
// Hotkey reorg 2026-06-14: mode-based layout (was topic-based).
//   Rebuilt from the real bindings 2026-10-06 (w1-first-minute D2, owner
//   2026-09-30 "Help menu needs updating. Some commands are obsolete."): rows
//   describe what the key does TODAY with the zoom ladder on (the default) —
//   Space is the view's main action, Esc moves back between views — in
//   plain words.
//   H1 2026-10-09 (owner rulings, DECISIONS "Owner answers 2026-10-09"): ONE
//   list, opened by the menu's ? and a ? at the top right of floor 1 (and the
//   ? key). Groups are now Basics / Daughters / Ship / Advanced, rare keys sit
//   in the closed Advanced section, unbuilt ones are greyed. Gone from the page
//   because the key does nothing now: V on the mother, Enter, M, ` as a map,
//   Shift V.
//   H3 2026-10-10 (owner: "simplify help menu … one line is better than 2, make
//   help page wide, make descriptions brief"): one line per row, short words,
//   wide page; Space spelled out; the Shift , dodge row dropped (the key is
//   still bound). `keyWidth` is the key column of that card, measured so its
//   widest chip set fits (no runtime measuring: the tests build a fake DOM).
//   2026-10-10 owner: "remove: PgUp PgDn Zoom out / in" — the row is gone (the
//   wheel row covers zoom); the keys stay bound (test-HelpTruth allowlist).
//   H5 2026-10-12 (owner: rank by when the key is needed; a new player wants a
//   glance, a key, or a fix): columns run in the order the game first asks for
//   the key — Start here (the mission-1 keys, ≤ 7 rows; turning first because
//   players try to move first; the mother only turns by hand, autopilot moves
//   her) → Daughters (chapter 2) → Ship & views. Stuck? lines are the symptom as
//   a question, then the fix. Everything rare sits in Advanced, sorted the same
//   way; opening it is the full list. The ? row is gone (you are in help).
//   2026-10-12 owner: zoom and touch rows on top of Start here; "N Launch net";
//   B Buy upgrades moved to Ship & views; Stuck? closed and expandable like
//   Advanced (both full width under the three cards, closed on every open).
//   Later 2026-10-12 owner: "1 – 4 Select a daughter" tops Daughters; O . ,
//   (radiator, struts, wings) moved to the bottom of Ship & views. Then: cards
//   only as tall as their rows; "V Change view to mother" last in Daughters;
//   T / Tab first in Ship & views. A small blank gap ('gap' row) under
//   J Journal sets the hardware rows apart.
//   Advanced 2026-10-12 (owner "go"): three columns lined up under the three
//   cards, each continuing its card in order of need ('col' starts the next);
//   small gaps between clusters; unbuilt keys and the dev key last. Shorter
//   words so three columns fit 1180 wide; Shift Z still steps back a part.
//   2026-10-17 owner ruling (DECISIONS §26): B still opens the upgrade drawer to look, but buying and
//   selling happen only at the resupply stop after a mission, so the B row says so.
// The live bindings are owned by InputManager._handleKeyDown; test-HelpTruth.js
// fails when a bound key is missing here or a chip names an unbound key.
export const HOTKEY_GROUPS = [
  {
    // The mission-1 keys: zoom and touch on top (owner 2026-10-12), then in the
    // order the game first asks for them: turn (players try to move first),
    // scan, net, fly to it.
    // Every row's opts carries a stable `id` (js/ui/helpText.js keys its translations by it, DECISIONS §44);
    // every group carries one too.
    id: 'start',
    title: 'Start here',
    keyWidth: '112px',
    rows: [
      [['Wheel · pinch'], 'Zoom in / out', { pointer: true, id: 'zoom' }],
      [['Tap · hold'], 'Touch: scan / actions', { pointer: true, id: 'touch' }],
      [['↑ ↓ ← →'], 'Turn ship', { id: 'turn' }],
      [['Turn pad'], 'Turn ship (touch, lower left)', { pointer: true, id: 'turn_pad' }],
      [['S'], 'Scan', { id: 'scan' }],
      [['N'], 'Launch net', { id: 'net' }],
      [['A'], 'Fly to target (on / off)', { id: 'fly' }],
    ],
  },
  {
    // Chapter 2: select, launch and reel the daughters. 1–4 on top, "Select"
    // (owner 2026-10-12): D and R act on the selected one. V (back to the
    // mother's view) at the bottom, owner's words.
    id: 'daughters',
    title: 'Daughters',
    keyWidth: '112px',
    rows: [
      [['1', '–', '4'], 'Select a daughter', { id: 'select' }],
      [['D'], 'Launch selected daughter', { id: 'launch_d' }],
      [['Q'], 'Launch marked pair', { id: 'pair' }],
      [['R'], 'Reel selected daughter', { id: 'reel' }],
      [['`'], 'Next tool', { id: 'next_tool' }],
      [['N'], 'Use tool', { id: 'use_tool' }],
      [['C'], 'Move catch to radiator', { id: 'move_catch' }],
      [['V'], 'Change view to mother', { id: 'view_mother' }],
    ],
  },
  {
    // Next target on top, then the views and look-up keys, then the mother's
    // hardware at the bottom (owner 2026-10-12).
    id: 'ship',
    title: 'Ship & views',
    keyWidth: '112px',
    rows: [
      [['T', '/', 'Tab'], 'Next target', { id: 'next_target' }],
      [['Space'], 'Main action', { id: 'main_action' }],
      [['Esc'], 'Back', { id: 'back' }],
      [['P'], 'Pause', { id: 'pause' }],
      [['B'], 'Upgrades (buy at the stop)', { id: 'upgrades' }],
      [['I'], 'Info', { id: 'info' }],
      [['J'], 'Journal', { id: 'journal' }],
      'gap',
      [['O'], 'Radiator struts out / in', { id: 'radiator_out' }],
      [['.'], 'Struts out / in (picked / all)', { id: 'struts' }],
      [[','], 'Solar wings out / in', { id: 'wings' }],
    ],
  },
  {
    // Symptom as a question, then the fix. Closed until opened, like Advanced
    // (owner 2026-10-12).
    id: 'stuck',
    title: 'Stuck?',
    collapsed: true,
    keyWidth: '90px',
    rows: [
      [['S'], 'Nothing to catch? Scan', { id: 'stuck_scan' }],
      [['A'], "Net won't launch? Fly closer", { id: 'stuck_fly' }],
      [['O'], 'Too hot? Open radiator', { id: 'stuck_hot' }],
      [['Space'], 'Field empty? At LEO, press Space', { id: 'stuck_empty' }],
    ],
  },
  {
    // Rare keys, dev keys and unbuilt features: closed until opened, so the
    // page stays short. Sorted like the cards above: start keys, then daughter
    // keys, then ship / view keys.
    id: 'advanced',
    title: 'Advanced',
    collapsed: true,
    keyWidth: '112px',
    // Three columns under the three cards (owner 2026-10-12), each continuing
    // the card above it, rows in order of need; 'col' starts the next column,
    // 'gap' is a small blank space. Unbuilt keys and the dev key go last.
    rows: [
      // Each column follows the card above it (owner 2026-10-12): pick / look
      // first, then act, out / in switches and leave-type keys last.
      // More for Start here: look → scan → pick a part → net → fly / power.
      [['Drag'], 'Turn the view', { pointer: true, id: 'turn_view' }],
      [['Main menu'], 'Touch: drawer bottom, tap twice', { pointer: true, id: 'drawer' }],
      [['Hold RADIATORS'], 'Radiators to 180°', { pointer: true, id: 'hold_rad' }],
      [['Shift S'], 'Wide scan', { id: 'wide_scan' }],
      [['Z'], 'Next debris part', { id: 'next_part' }],
      [['L'], 'Hold: laser slows spin', { id: 'laser' }],
      [['K'], 'Drop nose catch', { id: 'nose_catch' }],
      'gap',
      [['Shift − +'], 'Throttle down / up', { id: 'throttle' }],
      [['Shift 1–3'], 'Pick power line', { id: 'power_line' }],
      [['[', ']'], 'Power less / more', { id: 'power_adj' }],
      [['E'], 'Electric tether out / in', { id: 'tether' }],
      'col',
      // More for Daughters: launch → fly → reel → cut (destructive last).
      [['Shift D'], 'Launch all, one per piece', { id: 'launch_all' }],
      [['Shift N'], 'Send all to best pieces', { id: 'send_all' }],
      [[';', '\''], 'Launch speed down / up', { id: 'launch_speed' }],
      'gap',
      [['↑ ↓ ← →'], 'Circle target', { id: 'circle' }],
      [['+', '−'], 'Closer / farther', { id: 'range' }],
      [['CHANGE TOOL'], 'Next tool (DAUGHTERS row)', { pointer: true, id: 'change_tool' }],
      [['Shift R'], 'Reel all daughters', { id: 'reel_all' }],
      [['Shift'], 'Hold: reel faster', { id: 'reel_fast' }],
      'gap',
      [['X'], 'Cut tether', { id: 'cut' }],
      [['Ctrl Shift D'], 'Burn up catch', { id: 'burn' }],
      'col',
      // More for Ship & views: inspect → panels (the two the game teaches
      // first) → unbuilt → the dev key, set apart.
      [['Point · click'], 'Inspect / upgrade a part', { pointer: true, id: 'inspect' }],
      [['−', '+'], 'Fewer / more panels', { id: 'panels' }],
      [['5', '6'], 'Cities / constellations', { id: 'cities' }],
      [['9', '0'], 'Target info / Targets panes', { id: 'info_panes' }],
      [['7'], 'Radio log', { id: 'radio' }],
      [['8'], 'Nav ball', { id: 'nav' }],
      [['U'], 'Big catch: pick what to do', { id: 'big_catch' }],
      'gap',
      [['F'], 'Furnace (not built)', { id: 'furnace' }],
      [['F2'], 'Thruster metal', { grey: 'not yet', id: 'thruster_metal' }],
      [['Shift G'], 'Net sweep', { grey: 'not yet', id: 'net_sweep' }],
      'gap',
      [['Shift A'], 'Dev: auto-play', { id: 'dev_auto' }],
    ],
  },
];

export class HotkeyOverlay {
  constructor() {
    this._visible = false;
    this._overlay = null;
    this._langCode = settingsManager.getLanguage();
    this._buildDOM();
    this._setupListeners();
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  toggle() { this._visible ? this.hide() : this.show(); }

  show() {
    this._visible = true;
    // A language picked while the page was hidden (or before it listened) shows on this open.
    this._syncLanguage();
    // Advanced is closed on every open (H1 D1).
    if (typeof this._overlay.querySelectorAll === 'function') {
      for (const d of this._overlay.querySelectorAll('details')) d.open = false;
    }
    this._overlay.style.display = 'flex';
    requestAnimationFrame(() => { this._overlay.style.opacity = '1'; });
  }

  hide() {
    this._visible = false;
    this._overlay.style.opacity = '0';
    setTimeout(() => { if (!this._visible) this._overlay.style.display = 'none'; }, 200);
  }

  isVisible() { return this._visible; }

  /**
   * Floor-1 help button (H1 2026-10-09): a ? at the top right of the screen that
   * opens this same list — the twin of the menu's #menu-help-btn, same look and
   * size. Built HIDDEN (`data-floor-gone`): FloorMask owns its one visibility
   * bit (the `f1bar` attribute pane: shown on F1, gone on F2–F5 and the menu).
   * @param {HTMLElement|null} parent  #hud-overlay
   * @returns {HTMLButtonElement|null}
   */
  mountF1Button(parent) {
    if (!parent) return null;
    if (this._f1Button) return this._f1Button;
    const doc = parent.ownerDocument || document;
    if (!doc.getElementById('hud-f1-help-style')) {
      const style = doc.createElement('style');
      style.id = 'hud-f1-help-style';
      // Same colours, weight, border and radius as #menu-help-btn (MenuScreen).
      // #hud-overlay is pointer-events:none, so the button turns them back on.
      style.textContent = `
        #hud-f1-help {
          position: fixed; top: max(16px, env(safe-area-inset-top)); right: max(18px, env(safe-area-inset-right));
          min-width: 44px; min-height: 44px; box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
          background: rgba(4,12,30,0.62); color: rgba(0,255,136,0.92);
          border: 1px solid rgba(0,255,136,0.4); border-radius: 6px;
          padding: 0 12px; cursor: pointer; font: inherit; font-size: 1.1rem; font-weight: 700;
          pointer-events: auto; touch-action: manipulation; z-index: 12;
          transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        }
        #hud-f1-help:hover {
          border-color: #00ff88; background: rgba(0,255,136,0.12);
          box-shadow: 0 0 14px rgba(0,255,136,0.25);
        }
        #hud-f1-help[data-floor-gone] { display: none !important; }
      `;
      (doc.head || parent).appendChild(style);
    }
    const btn = doc.createElement('button');
    btn.id = 'hud-f1-help';
    btn.type = 'button';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Help — keys and controls');
    btn.setAttribute('title', 'Help — keys and controls');
    btn.setAttribute('data-floor-gone', '');
    btn.textContent = '?';
    btn.addEventListener('click', () => { this.toggle(); btn.blur(); });
    parent.appendChild(btn);
    this._f1Button = btn;
    return btn;
  }

  // ==========================================================================
  // DOM CONSTRUCTION
  // ==========================================================================

  /** @private */
  _buildDOM() {
    const overlay = document.createElement('div');
    overlay.id = 'hotkey-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.92)', zIndex: '9999',
      display: 'none', opacity: '0', transition: 'opacity 0.2s ease',
      justifyContent: 'center', alignItems: 'center',
      fontFamily: "var(--font-mono)", color: '#ccc',
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.hide(); });

    const panel = document.createElement('div');
    panel.id = 'hotkey-panel';
    Object.assign(panel.style, {
      width: '96%', maxWidth: '1680px', height: 'auto', maxHeight: '92%',
      background: '#1a1a2e', border: '1px solid rgba(0,212,255,0.3)',
      borderRadius: '6px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 0 40px rgba(0,212,255,0.12)', overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '16px 22px', borderBottom: '1px solid rgba(0,212,255,0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0',
    });
    const T = this._text();
    const unspaced = UNSPACED_LANGUAGES.has(this._langCode);
    const left = document.createElement('div');
    Object.assign(left.style, { display: 'flex', alignItems: 'center', gap: '14px' });
    const titleEl = document.createElement('span');
    titleEl.id = 'hotkey-title';
    titleEl.textContent = T.title;
    Object.assign(titleEl.style, {
      fontSize: '16px', color: '#00d4ff', fontWeight: '700',
      letterSpacing: unspaced ? 'normal' : '0.14em', textTransform: unspaced ? 'none' : 'uppercase',
    });
    const hintEl = document.createElement('span');
    hintEl.id = 'hotkey-hint';
    hintEl.textContent = T.closeHint;
    Object.assign(hintEl.style, {
      fontSize: '11px', fontWeight: '700', color: '#888',
      letterSpacing: unspaced ? 'normal' : '0.08em', textTransform: unspaced ? 'none' : 'uppercase',
    });
    left.appendChild(titleEl);
    left.appendChild(hintEl);
    const closeBtn = document.createElement('button');
    closeBtn.id = 'hotkey-close-btn';
    closeBtn.textContent = 'ESC ×';
    closeBtn.setAttribute('aria-label', T.closeLabel);
    Object.assign(closeBtn.style, {
      background: 'none', border: '1px solid rgba(255,255,255,0.2)', color: '#aaa', fontSize: '16px',
      letterSpacing: '0.15em', textTransform: 'uppercase', cursor: 'pointer', padding: '4px 12px',
      borderRadius: '3px', fontFamily: 'var(--font-mono)',
    });
    header.appendChild(left);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    Object.assign(body.style, {
      // Three cards (Start here / Daughters / Ship & views) side by side; the
      // closed Stuck? and Advanced sections are full width below. Scrolls
      // vertically when it does not
      // fit (2026-10-06, measured in headless Chromium: the old overflow:hidden
      // clipped rows at 1024×768 and even at 1920×1080).
      flex: '1', minHeight: '0', overflowX: 'hidden', overflowY: 'auto', padding: '16px 18px',
      display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
      // alignItems start: each card is only as tall as its own rows (owner
      // 2026-10-12: shorter Start here / Daughters boxes), not stretched to
      // the tallest card in the row.
      gap: '14px', alignContent: 'start', alignItems: 'start',
    });
    // The ladder's window-capture WheelRouter preventDefaults + zooms every
    // wheel in gameplay; this marker hands wheels over the cards back to the
    // page so the list scrolls (WheelRouter._inPassthrough).
    body.setAttribute('data-wheel-passthrough', '');

    // The overview above the cards (H5 D3, reworded by DECISIONS §44 row 4): one or two plain sentences, static, in
    // the player's language. Quieter than the key rows (smaller, dimmer).
    const goal = document.createElement('div');
    goal.id = 'hotkey-goal';
    goal.textContent = T.overview;
    Object.assign(goal.style, {
      gridColumn: '1 / -1', fontSize: '12px', lineHeight: '1.5', color: '#9db0c2', marginBottom: '4px',
    });
    body.appendChild(goal);

    for (const group of HOTKEY_GROUPS) {
      body.appendChild(this._makeGroupCard(group));
    }

    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this._overlay = overlay;
    this._built = true;
    closeBtn.addEventListener('click', () => this.hide());
  }

  /** @private The text block for the language this page is showing (English when none was read yet). */
  _text() { return helpTextFor(this._langCode); }

  /**
   * @private Read the player's language again; when it changed, rebuild the page in it (keeping it shown or hidden).
   * An instance that never built a page (a test's Object.create) does nothing.
   * @returns {boolean} true when it rebuilt
   */
  _syncLanguage() {
    if (!this._built) return false;
    const code = settingsManager.getLanguage();
    if (code === this._langCode) return false;
    this._langCode = code;
    const old = this._overlay;
    const display = old.style.display;
    const opacity = old.style.opacity;
    this._buildDOM();
    if (typeof old.remove === 'function') old.remove();
    else if (old.parentNode) old.parentNode.removeChild(old);
    this._overlay.style.display = display;
    this._overlay.style.opacity = opacity;
    return true;
  }

  /** @private Build one group card */
  _makeGroupCard(group) {
    const collapsed = group.collapsed === true;
    const card = document.createElement(collapsed ? 'details' : 'div');
    Object.assign(card.style, {
      border: '1px solid rgba(0,212,255,0.15)', borderRadius: '4px',
      background: 'rgba(0,212,255,0.03)', padding: '12px 14px',
    });

    const title = document.createElement(collapsed ? 'summary' : 'div');
    const titleStyle = {
      fontSize: '12px', fontWeight: '700', color: '#00d4ff',
      letterSpacing: '0.14em', textTransform: 'uppercase',
    };
    Object.assign(title.style, titleStyle);
    // Text only: a group's title is its name (no glyph — Session L, plan D-J).
    const T = this._text();
    const rowCount = group.rows.filter(r => Array.isArray(r)).length;
    const groupTitle = T.groups[group.id] || group.title;
    if (UNSPACED_LANGUAGES.has(this._langCode)) Object.assign(title.style, { letterSpacing: 'normal', textTransform: 'none' });
    title.textContent = collapsed ? `${groupTitle} (${rowCount})` : groupTitle;
    card.appendChild(title);

    // Rows go straight into a plain card; a collapsed <details> wraps them in a
    // body. With 'col' marks (Advanced) the body is three columns lined up
    // under the three cards above; without (Stuck?) the rows flow into as many
    // columns as fit.
    const columns = group.rows.includes('col');
    let host = card;
    if (collapsed) {
      Object.assign(title.style, { cursor: 'pointer', minHeight: '24px' });
      card.style.gridColumn = '1 / -1';
      host = document.createElement('div');
      Object.assign(host.style, {
        // 44px = the cards' 14px gap + 2 × their 15px border-and-padding, so each
        // column's left edge sits under the rows of the card above it.
        display: 'grid',
        gridTemplateColumns: columns ? 'repeat(3, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(420px, 1fr))',
        columnGap: columns ? '44px' : '28px', marginTop: '10px',
        borderTop: '1px solid rgba(0,212,255,0.12)', paddingTop: '6px',
      });
      card.appendChild(host);
    } else {
      Object.assign(title.style, {
        marginBottom: '10px', borderBottom: '1px solid rgba(0,212,255,0.12)', paddingBottom: '6px',
      });
    }

    let target = host;
    if (columns) { target = document.createElement('div'); host.appendChild(target); }
    for (const row of group.rows) {
      if (row === 'col') {
        target = document.createElement('div');
        host.appendChild(target);
        continue;
      }
      if (row === 'spacer') {
        target.appendChild(this._makeSpacer());
        continue;
      }
      if (row === 'gap') {
        // A small blank space, no line (owner 2026-10-12: under J Journal).
        const gap = document.createElement('div');
        gap.style.height = '8px';
        target.appendChild(gap);
        continue;
      }
      const [keys, desc, opts] = row;
      target.appendChild(this._makeRow(...this._rowInLanguage(keys, desc, opts), group.keyWidth));
    }
    return card;
  }

  /**
   * @private One row's chips, description and opts in the page's language. English rows come back as they are; a
   * missing translation falls back to the English words. A key cap is never translated, only a pointer row's gesture
   * words (helpText `chips`); the grey reason "not yet" is.
   * @returns {[string[], string, object|null]}
   */
  _rowInLanguage(keys, desc, opts) {
    const T = this._text();
    const id = opts && opts.id;
    if (!id) return [keys, desc, opts];
    // The B row names the place buying happens: the stop after a mission, or the satellite with the range map on.
    const textId = id === 'upgrades' && satelliteIsTheStop() ? 'upgrades_map' : id;
    const text = T.rows[textId] || T.rows[id] || desc;
    let chips = keys;
    if (opts.pointer && Array.isArray(T.chips[id]) && T.chips[id].length === keys.length) chips = T.chips[id];
    let out = opts;
    if (typeof opts.grey === 'string' && opts.grey === helpTextFor('en').notYet) out = { ...opts, grey: T.notYet };
    return [chips, text, out];
  }

  /** @private A horizontal divider between row clusters */
  _makeSpacer() {
    const hr = document.createElement('div');
    Object.assign(hr.style, {
      height: '0', borderTop: '1px solid rgba(0,212,255,0.18)',
      margin: '10px 0',
    });
    return hr;
  }

  /**
   * @private Build a single key→description row: children[0] the keys,
   * children[1] the label. One line, never wraps (H3); `keyWidth` is the card's
   * measured key column (default 100px).
   */
  _makeRow(keys, desc, opts = null, keyWidth = '100px') {
    const pointer = !!(opts && opts.pointer);
    const grey = opts && typeof opts.grey === 'string' ? opts.grey : null;
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '7px',
      margin: '3px 0', fontSize: '13px',
    });
    if (grey) row.style.opacity = '0.5';

    const keyWrap = document.createElement('div');
    Object.assign(keyWrap.style, {
      display: 'flex', alignItems: 'center', gap: '4px',
      flex: `0 0 ${keyWidth}`, flexWrap: 'nowrap',
    });
    for (const k of keys) {
      if (pointer) {
        // A mouse / touch gesture is words, not a key: plain text.
        const word = document.createElement('span');
        word.textContent = k;
        Object.assign(word.style, { color: '#7fe3ff', fontSize: '12px', lineHeight: '1.3', whiteSpace: 'nowrap' });
        keyWrap.appendChild(word);
        continue;
      }
      // Separators ('/', '–') render as plain dim text, not key caps. A bare
      // '+' is a real key cap (the pane-density chip, paired with the '−' cap),
      // so it is NOT treated as a separator.
      if (k === '/' || k === '–') {
        const sep = document.createElement('span');
        sep.textContent = k;
        sep.style.color = '#666';
        keyWrap.appendChild(sep);
      } else {
        keyWrap.appendChild(this._makeKeyCap(k));
      }
    }

    const label = document.createElement('span');
    Object.assign(label.style, { color: '#cfcfcf', flex: '1', lineHeight: '1.35', whiteSpace: 'nowrap' });
    label.textContent = wordsFor(grey ? `${desc} — ${grey}` : desc);   // lane 3d: the B row says "resupply satellite" with the map on

    row.appendChild(keyWrap);
    row.appendChild(label);
    return row;
  }

  /** @private A single keyboard key cap */
  _makeKeyCap(text) {
    const cap = document.createElement('span');
    Object.assign(cap.style, {
      display: 'inline-block', minWidth: '18px', textAlign: 'center',
      padding: '3px 8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: '#fff',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(0,212,255,0.3)', borderRadius: '3px',
      boxShadow: '0 1px 0 rgba(0,0,0,0.4)', whiteSpace: 'nowrap',
    });
    cap.textContent = text;
    return cap;
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // Stored bound ref (MenuScreen / BriefingScreen convention) so a future
    // dispose() can actually detach this.
    this._boundKeyDown = this._onKeyDown.bind(this);
    window.addEventListener('keydown', this._boundKeyDown, true);
    // The picker's choice rebuilds the page at once, shown or hidden (DECISIONS §44).
    this._boundLanguage = () => this._syncLanguage();
    this._offLanguage = eventBus.on(Events.LANGUAGE_CHANGED, this._boundLanguage);
  }

  /** Detach the key and language listeners and take the page out of the document. */
  dispose() {
    window.removeEventListener('keydown', this._boundKeyDown, true);
    if (typeof this._offLanguage === 'function') this._offLanguage();
    this._offLanguage = null;
    const o = this._overlay;
    if (o && typeof o.remove === 'function') o.remove();
    this._overlay = null;
    this._built = false;
  }

  /**
   * @private Capture-phase key handling while the list is open.
   *
   * While visible this SWALLOWS every game/UI key (capture phase, so it runs
   * before everyone else) and only ESC (close) is acted on. The ?/Slash toggle
   * is deliberately passed through — InputManager's open-overlay intercept owns
   * the close-on-? path (and its click SFX).
   *
   * Why blanket-block rather than block a key list: since 2026-07-28 the list
   * opens from ANY screen, and several screens own their own window keydown
   * listeners that InputManager cannot suppress for us — MenuScreen starts the
   * mission on Enter, and BriefingScreen launches on Enter, quick-starts on Q,
   * and moves target selection on ↑/↓/Tab. All of those would otherwise fire
   * behind the open overlay. SkillsPane's expanded overlay uses the same
   * block-everything shape. Nothing is lost in gameplay: InputManager already
   * ignores every key while this overlay is visible.
   *
   * Modifier combos (Cmd/Ctrl/Alt) and F-keys are passed through untouched so
   * browser shortcuts (reload, devtools, tab switching) keep working.
   *
   * @param {KeyboardEvent} e
   */
  _onKeyDown(e) {
    if (!this._visible) return;

    // Browser-level shortcuts stay live.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^F\d{1,2}$/.test(e.code)) return;

    // InputManager owns ? → close (keeps the click SFX on that path).
    if (e.code === 'Slash') return;

    e.stopImmediatePropagation();
    e.preventDefault();

    if (e.code === 'Escape') this.hide();
  }
}

export default HotkeyOverlay;
