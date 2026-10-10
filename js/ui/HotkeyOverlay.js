/**
 * HotkeyOverlay.js — DOM overlay listing the keys and controls, grouped by
 * category. Toggle with the ? key (Slash), the menu's ? button or the ? button
 * at the top right of floor 1 (mountF1Button). Escape or ? closes.
 *
 * Layout: full-screen overlay → centered panel → a grid of group cards (each a
 * labelled list of key chip → description rows) plus a closed, expandable
 * Advanced section.
 * Mirrors the visual language of CodexViewerUI (dark panel, cyan accents,
 * the house mono token) so it feels native to the HUD.
 *
 * @module ui/HotkeyOverlay
 */

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
//   ␣ is the view's main action, Esc / PgUp / PgDn move between views — in
//   plain words.
//   H1 2026-10-09 (owner rulings, DECISIONS "Owner answers 2026-10-09"): ONE
//   list, opened by the menu's ? and a ? at the top right of floor 1 (and the
//   ? key). Groups are now Basics / Daughters / Ship / Advanced, rare keys sit
//   in the closed Advanced section, unbuilt ones are greyed. Gone from the page
//   because the key does nothing now: V on the mother, Enter, M, ` as a map,
//   Shift V.
// The live bindings are owned by InputManager._handleKeyDown; test-HelpTruth.js
// fails when a bound key is missing here or a chip names an unbound key.
export const HOTKEY_GROUPS = [
  {
    // What a new player needs: mouse / touch first, then the keys of the mother's
    // command chair in onboarding teach order (orient → scan → target → act).
    title: 'Basics',
    rows: [
      // Mouse / touch rows (H1 D3). Kept only where the 2026-10-09 probe or the
      // TouchControls source backs them; the rail is NOT clickable (pointer-events
      // none) so "click the rail" is not listed.
      [['Wheel · pinch'], 'Zoom in / out', { pointer: true }],
      [['Drag'], 'Turn the view (debris and orbit floors; floors 1–2 with a drawer open)', { pointer: true }],
      [['Point · click'], 'Floor 1: see what a part does, click it to upgrade', { pointer: true }],
      [['Tap · hold'], 'Touch: tap a piece to target it (empty space scans); hold it for the action ring', { pointer: true }],
      [['↑ ↓ ← →'], 'Turn the ship'],
      [['S'], 'Scan nearby (uses battery)'],
      [['T', '/', 'Tab'], 'Next target'],
      [['␣'], 'Main action for this view (e.g. autopilot)'],
      [['A'], 'Autopilot on / off — flies to the target'],
      [['N'], 'Fire the net'],
      [['Esc'], 'Back — close the panel, else zoom out'],
      [['PgUp', 'PgDn'], 'Zoom out / in one floor'],
      [['B'], 'Upgrades (floor 1)'],
      [['I'], 'Tech library'],
      [['J'], 'Journal — discoveries'],
      [['?'], 'This help'],
    ],
  },
  {
    // Fly and run the daughters. Mother verbs that act on them (D, R, Shift R)
    // sit here too, so the whole daughter story is one card.
    title: 'Daughters',
    rows: [
      [['1', '–', '4'], 'Fly a daughter (again: back to the mother)'],
      [['V'], 'Back to the mother (she keeps working)'],
      [['D'], 'Launch a daughter (pick one with 1–4)'],
      [['R'], 'Reel a daughter in'],
      [['Shift R'], 'Reel every daughter in'],
      [['↑ ↓ ← →'], 'Circle the debris, holding station'],
      [['`'], 'Next tool (net / magnet / gripper / pad)'],
      [['N'], 'Use the tool / fire the net'],
      [['X'], 'Cut the tether (let her go)'],
    ],
  },
  {
    // The mother's own hardware.
    title: 'Ship',
    rows: [
      [['.'], 'Swing the struts out / in'],
      [['O'], 'Radiator open / fold (opens by itself when hot)'],
      [[','], 'Roll the solar wings up / out'],
      [['Shift ,'], 'Solar wings edge-on (quick dodge)'],
      [['F'], 'Furnace — not built yet, try it'],
    ],
  },
  {
    // Rare keys, dev keys and unbuilt features: closed until opened, so the
    // page stays short ("so devs can remember and clutter is reduced").
    title: 'Advanced',
    collapsed: true,
    rows: [
      [['Shift A'], 'Dev: fly to the thickest debris, net a piece, send every daughter'],
      [['Shift N'], 'Pick the best debris in reach, send every daughter'],
      [['Shift D'], 'Launch every daughter at the target'],
      [['Shift S'], 'Scan a wide area (more battery)'],
      [['Shift −', 'Shift +'], 'Engine throttle down / up'],
      [['K'], 'Drop the catch held at the nose'],
      [['L'], 'Hold: laser slows the target’s spin'],
      [['+', '−'], 'Daughter: closer / farther, holding station'],
      [['Shift'], 'Hold: reel in faster'],
      [['Ctrl Shift D'], 'Take the catch down to burn up (daughter lost)'],
      [['Z'], 'Debris close-up: next part (Shift: back)'],
      [['E'], 'Electric tether out / in'],
      [['Shift 1–3'], 'Power line: engine / sensors / daughters'],
      [['[', ']'], 'Less / more power on that line'],
      [[';', '\''], 'Daughter launch speed down / up'],
      [['5', '6'], 'City / constellation names on / off'],
      [['7'], 'Open the radio log'],
      [['8'], 'Nav ball: show / shrink'],
      [['9', '0'], 'Debris / target panel on / off'],
      [['−', '+'], 'Fewer / more panels on screen'],
      [['F2'], 'Switch thruster metal', { grey: 'comes with the furnace' }],
      [['Shift G'], 'Sweep the net through a cloud of small pieces', { grey: 'unlocks later' }],
    ],
  },
];

export class HotkeyOverlay {
  constructor() {
    this._visible = false;
    this._overlay = null;
    this._buildDOM();
    this._setupListeners();
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  toggle() { this._visible ? this.hide() : this.show(); }

  show() {
    this._visible = true;
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
      width: '92%', maxWidth: '1320px', height: '86%', maxHeight: '840px',
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
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;">
        <span style="font-size:16px;color:#00d4ff;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">KEYS &amp; CONTROLS</span>
        <span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;">press ? or ESC to close</span>
      </div>
      <button id="hotkey-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#aaa;font-size:16px;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;padding:4px 12px;border-radius:3px;
        font-family: var(--font-mono);">ESC ×</button>
    `;

    const body = document.createElement('div');
    Object.assign(body.style, {
      // Three cards (Basics / Daughters / Ship) side by side, then the closed
      // Advanced section full width below. Scrolls vertically when it does not
      // fit (2026-10-06, measured in headless Chromium: the old overflow:hidden
      // clipped rows at 1024×768 and even at 1920×1080).
      flex: '1', overflowX: 'hidden', overflowY: 'auto', padding: '16px 18px',
      display: 'grid', gridTemplateColumns: '1.15fr 1fr 0.85fr',
      gap: '14px', alignContent: 'start',
    });
    // The ladder's window-capture WheelRouter preventDefaults + zooms every
    // wheel in gameplay; this marker hands wheels over the cards back to the
    // page so the list scrolls (WheelRouter._inPassthrough).
    body.setAttribute('data-wheel-passthrough', '');

    for (const group of HOTKEY_GROUPS) {
      body.appendChild(this._makeGroupCard(group));
    }

    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this._overlay = overlay;
    overlay.querySelector('#hotkey-close-btn').addEventListener('click', () => this.hide());
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
    const rowCount = group.rows.filter(r => Array.isArray(r)).length;
    title.textContent = collapsed ? `${group.title} (${rowCount})` : group.title;
    card.appendChild(title);

    // Rows go straight into a plain card; an Advanced <details> wraps them in a
    // body that lays them out in as many columns as fit.
    let host = card;
    if (collapsed) {
      Object.assign(title.style, { cursor: 'pointer', minHeight: '24px' });
      card.style.gridColumn = '1 / -1';
      host = document.createElement('div');
      Object.assign(host.style, {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        columnGap: '28px', marginTop: '10px',
        borderTop: '1px solid rgba(0,212,255,0.12)', paddingTop: '6px',
      });
      card.appendChild(host);
    } else {
      Object.assign(title.style, {
        marginBottom: '10px', borderBottom: '1px solid rgba(0,212,255,0.12)', paddingBottom: '6px',
      });
    }

    for (const row of group.rows) {
      if (row === 'spacer') {
        host.appendChild(this._makeSpacer());
        continue;
      }
      const [keys, desc, opts] = row;
      host.appendChild(this._makeRow(keys, desc, opts));
    }
    return card;
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

  /** @private Build a single key→description row */
  _makeRow(keys, desc, opts = null) {
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
      flex: '0 0 96px', flexWrap: 'wrap',
    });
    for (const k of keys) {
      if (pointer) {
        // A mouse / touch gesture is words, not a key: plain text, may wrap.
        const word = document.createElement('span');
        word.textContent = k;
        Object.assign(word.style, { color: '#7fe3ff', fontSize: '12px', lineHeight: '1.3' });
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
    Object.assign(label.style, { color: '#cfcfcf', flex: '1', lineHeight: '1.35' });
    label.textContent = grey ? `${desc} — ${grey}` : desc;

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
