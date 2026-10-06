/**
 * HotkeyOverlay.js — DOM overlay listing all keyboard shortcuts, grouped by
 * category. Toggle with the ? key (Slash). Escape or ? closes.
 *
 * Layout: full-screen overlay → centered panel → responsive grid of group
 * cards, each card a labelled list of (key chip → description) rows.
 * Mirrors the visual language of CodexViewerUI (dark panel, cyan accents,
 * the house mono token) so it feels native to the HUD.
 *
 * @module ui/HotkeyOverlay
 */

// Grouped hotkey reference. Each group → list of [keys, description] rows.
// `keys` is an array of chips; a chip may itself contain a separator like
// '/' which is rendered as plain text between two key caps.
//
// Hotkey reorg 2026-06-14: mode-based three-card layout (was topic-based
// Essentials / Views & Maps / Advanced).
//   • Mother — verbs issued from the command chair (incl. fleet commands:
//     D deploy, R recall, and their Shift "all" variants).
//   • Daughter — selecting / operating a deployed arm.
//   • Advanced + Maps — cross-mode controls: maps, overlays, panes, ship
//     systems, deep tools.
//   Originated as a pure regroup of the older topic cards; labels have since
//   been hand-tuned. Full hotkey audit + Daughter-card rewrite 2026-07-23:
//   the Daughter card now lists ONLY keys that genuinely act on the piloted
//   daughter (mother verbs S/T/A/D/E were removed).
//   Rebuilt from the real bindings 2026-10-06 (w1-first-minute D2, owner
//   2026-09-30 "Help menu needs updating. Some commands are obsolete."): rows
//   describe what the key does TODAY with the zoom ladder on (the default) —
//   ␣ is the view's main action, Esc / PgUp / PgDn move between views, V (not
//   Esc) takes you back to the ship — in plain words. Added the bound but
//   unlisted keys: [ ] and Shift+1–3 (power lines), ; ' (launch speed),
//   PgUp / PgDn, Ctrl+Shift+D (deorbit), + − while holding station.
// The live bindings are owned by InputManager._handleKeyDown; test-HelpTruth.js
// fails when a bound key is missing here or a chip names an unbound key.
export const HOTKEY_GROUPS = [
  {
    // Mother command-chair verbs, in onboarding teach order (orient → look →
    // target → capture → scan → deploy), then the Shift fleet commands.
    title: 'Mother',
    rows: [
      [['↑ ↓ ← →'], 'Turn the ship'],
      [['V'], 'View — fly / look around'],
      [['␣'], 'Main action for this view (e.g. autopilot)'],
      [['S'], 'Scan nearby'],
      [['T'], 'Next debris target'],
      [['Tab'], 'Next target (net / map views: next choice)'],
      [['A'], 'Autopilot on / off — flies to the target'],
      [['Enter'], 'Start the approach (needs a target)'],
      [['N'], 'Fire the net'],
      [['D'], 'Launch a daughter (pick one with 1–4)'],
      [['R'], 'Reel a daughter in'],
      [['K'], 'Drop the catch held at the nose'],
      'spacer',
      [['Shift V'], 'Big-picture map'],
      [['Shift S'], 'Scan a wide area'],
      [['Shift A'], 'Fly to the thickest debris, fire the net, send every daughter'],
      [['Shift N'], 'Pick the best debris in reach, send every daughter'],
      [['Shift D'], 'Launch every daughter at the target'],
      [['Shift R'], 'Reel every daughter in'],
      [['Shift G'], 'Sweep the net through a cloud of small pieces'],
      [['Shift −', 'Shift +'], 'Engine throttle down / up'],
    ],
  },
  {
    // Operating the daughter you are piloting. Only keys that act on/around
    // her are listed (mother verbs live on the Mother card).
    title: 'Daughter',
    rows: [
      [['1', '–', '4'], 'Pick / fly a daughter (again: back to the ship)'],
      [['↑ ↓ ← →'], 'Circle the debris, holding station'],
      [['+', '−'], 'Closer / farther, holding station'],
      [['`'], 'Next tool (net / magnet / gripper / pad)'],
      [['N'], 'Use the tool / fire the net'],
      [['L'], 'Hold: laser slows the target’s spin'],
      [['R'], 'Reel this daughter in'],
      [['X'], 'Cut the tether (let her go)'],
      [['F2'], 'Switch thruster metal'],
      [['Shift'], 'Hold: reel in faster'],
      [['V'], 'Back to the ship (she keeps working)'],
      [['Ctrl', 'Shift D'], 'Take the catch down to burn up (daughter lost)'],
    ],
  },
  {
    // Cross-mode controls: maps & overlays first, then ship systems / deep
    // tools. Behaves the same in both Mother and Daughter modes.
    title: 'Advanced',
    rows: [
      [['B'], 'Shop — buy upgrades'],
      [['F'], 'Furnace: refine metal (again: make fuel; 3rd: cancel)'],
      [['J'], 'Journal — discoveries'],
      [['I'], 'Info library'],
      [['M', '/', '`'], 'Debris map'],
      [['?'], 'This help'],
      [['Esc'], 'Back — close the panel, else zoom out'],
      [['PgUp', 'PgDn'], 'Zoom out / in one level'],
      'spacer',
      [['5', '6'], 'City / constellation names on / off'],
      [['7'], 'Open the radio log'],
      [['8'], 'Nav ball: show / shrink'],
      [['9', '0'], 'Debris / target panel on / off'],
      [['−', '+'], 'Fewer / more panels on screen'],
      [['Shift 1–3'], 'Power line: engine / sensors / daughters'],
      [['[', ']'], 'Less / more power on that line'],
      [[';', '\''], 'Daughter launch speed down / up'],
      [['E'], 'Electric tether out / in'],
      [['Z'], 'Debris close-up: next part (Shift: back)'],
      [['.'], 'Swing the struts out / in'],
      [[','], 'Roll the solar panels up / out'],
      [['Shift ,'], 'Solar panels edge-on (quick dodge)'],
      [['O'], 'Rear radiator open / fold (once bought)'],
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
    this._overlay.style.display = 'flex';
    requestAnimationFrame(() => { this._overlay.style.opacity = '1'; });
  }

  hide() {
    this._visible = false;
    this._overlay.style.opacity = '0';
    setTimeout(() => { if (!this._visible) this._overlay.style.display = 'none'; }, 200);
  }

  isVisible() { return this._visible; }

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
        <span style="font-size:16px;color:#00d4ff;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">⌨ KEYBOARD SHORTCUTS</span>
        <span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#888;">press ? or ESC to close</span>
      </div>
      <button id="hotkey-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#aaa;font-size:16px;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;padding:4px 12px;border-radius:3px;
        font-family: var(--font-mono);">ESC ×</button>
    `;

    const body = document.createElement('div');
    Object.assign(body.style, {
      // Three mode cards (Mother / Daughter / Advanced+Maps); Advanced+Maps
      // gets the widest track for single-line labels. One page on a big
      // screen; scrolls vertically when it does not fit (2026-10-06, measured
      // in headless Chromium: the old overflow:hidden clipped 4–5 Mother rows
      // at 1024×768 and the last Mother row even at 1920×1080).
      flex: '1', overflowX: 'hidden', overflowY: 'auto', padding: '16px 18px',
      display: 'grid', gridTemplateColumns: '1.1fr 0.85fr 1.15fr',
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
    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid rgba(0,212,255,0.15)', borderRadius: '4px',
      background: 'rgba(0,212,255,0.03)', padding: '12px 14px',
    });

    const title = document.createElement('div');
    Object.assign(title.style, {
      fontSize: '12px', fontWeight: '700', color: '#00d4ff',
      letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '10px',
      borderBottom: '1px solid rgba(0,212,255,0.12)', paddingBottom: '6px',
    });
    // Text only: a group's title is its name (no glyph — Session L, plan D-J).
    title.textContent = group.title;
    card.appendChild(title);

    for (const row of group.rows) {
      if (row === 'spacer') {
        card.appendChild(this._makeSpacer());
        continue;
      }
      const [keys, desc] = row;
      card.appendChild(this._makeRow(keys, desc));
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
  _makeRow(keys, desc) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '7px',
      margin: '3px 0', fontSize: '13px',
    });

    const keyWrap = document.createElement('div');
    Object.assign(keyWrap.style, {
      display: 'flex', alignItems: 'center', gap: '4px',
      flex: '0 0 96px', flexWrap: 'wrap',
    });
    for (const k of keys) {
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
    label.textContent = desc;

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
