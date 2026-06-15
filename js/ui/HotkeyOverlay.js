/**
 * HotkeyOverlay.js — DOM overlay listing all keyboard shortcuts, grouped by
 * category. Toggle with the ? key (Slash). Escape or ? closes.
 *
 * Layout: full-screen overlay → centered panel → responsive grid of group
 * cards, each card a labelled list of (key chip → description) rows.
 * Mirrors the visual language of CodexViewerUI (dark panel, cyan accents,
 * Courier New) so it feels native to the HUD.
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
//   been hand-tuned (2026-06-14). Several rows are descriptive/cosmetic — the
//   live bindings are owned by InputManager, not this list.
// Keep in sync with InputManager._handleKeyDown and ARCHITECTURE §6.
const HOTKEY_GROUPS = [
  {
    // Mother command-chair verbs, in onboarding teach order (orient → look →
    // target → capture → scan → deploy), then the Shift fleet commands.
    title: 'Mother',
    icon: '🛰',
    rows: [
      [['↑ ↓ ← →'], 'Rotate'],
      [['V'], 'View'],
      [['S'], 'Scan'],
      [['T'], 'Target debris'],
      [['A'], 'Autopilot to target'],
      [['N'], 'Net launch'],
      [['D'], 'Daughter launch'],
      [['R'], 'Reel-in'],
      'spacer',
      [['V', 'Shift'], 'View big picture'],
      [['S', 'Shift'], 'Scan big area'],
      [['A', 'Shift'], 'Autopilot to field center + net + fan out daughters'],
      [['N', 'Shift'], 'Auto-target + launch at debris in range'],
      [['D', 'Shift'], 'Daughters launch all'],
      [['R', 'Shift'], 'Reel-in all'],
    ],
  },
  {
    // Selecting / operating a deployed daughter arm.
    title: 'Daughter',
    rows: [
      [['↑ ↓ ← →'], 'Rotate around debris'],
      [['V'], 'View'],
      [['S'], 'Scan'],
      [['T'], 'Target debris with tools'],
      [['A'], 'Autopilot to target'],
      [['N'], 'Net launch'],
      [['D'], 'Daughter launch'],
      [['R'], 'Reel-in'],
      'spacer',
      [['1', '–', '4'], 'Select daughter'],
      [['L'], 'Hold steady with laser'],
      [['E'], 'Electro Dynamic Tether'],
      [['X'], 'Tether detach'],
    ],
  },
  {
    // Cross-mode controls: maps & overlays first, then ship systems / deep
    // tools. Behaves the same in both Mother and Daughter modes.
    title: 'Advanced',
    rows: [
      [['B'], 'Buy'],
      [['F'], 'Forge'],
      [['J'], 'Journal'],
      [['I'], 'Info'],
      [['M'], 'Map'],
      [['?'], 'Help'],
      [['Esc'], 'Pause / back'],
      'spacer',
      [['5'], 'toggle: City names'],
      [['6'], 'toggle: Constellation names'],
      [['7'], 'toggle: Comms'],
      [['8'], 'toggle: NavSphere'],
      [['9'], 'toggle: Debris pane'],
      [['0'], 'toggle: Target pane'],
      [['.'], 'toggle: Struts'],
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
      fontFamily: "'Courier New', monospace", color: '#ccc',
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
        <span style="font-size:21px;color:#00d4ff;font-weight:bold;letter-spacing:2px;">⌨ KEYBOARD SHORTCUTS</span>
        <span style="font-size:13px;color:#888;">press ? or ESC to close</span>
      </div>
      <button id="hotkey-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#aaa;font-size:16px;cursor:pointer;padding:4px 12px;border-radius:3px;
        font-family:'Courier New',monospace;">ESC ✕</button>
    `;

    const body = document.createElement('div');
    Object.assign(body.style, {
      // One page, no scrollbar. Three mode cards (Mother / Daughter /
      // Advanced+Maps). Daughter is short (5 rows); Advanced+Maps is tallest,
      // so it gets the widest track for single-line labels.
      flex: '1', overflow: 'hidden', padding: '16px 18px',
      display: 'grid', gridTemplateColumns: '1.1fr 0.85fr 1.15fr',
      gap: '14px', alignContent: 'start',
    });

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
      fontSize: '15px', fontWeight: 'bold', color: '#00d4ff',
      letterSpacing: '0.05em', marginBottom: '10px',
      borderBottom: '1px solid rgba(0,212,255,0.12)', paddingBottom: '6px',
    });
    title.textContent = group.icon ? `${group.icon} ${group.title}` : group.title;
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
      margin: '18px 0',
    });
    return hr;
  }

  /** @private Build a single key→description row */
  _makeRow(keys, desc) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '7px',
      margin: '5px 0', fontSize: '13px',
    });

    const keyWrap = document.createElement('div');
    Object.assign(keyWrap.style, {
      display: 'flex', alignItems: 'center', gap: '4px',
      flex: '0 0 96px', flexWrap: 'wrap',
    });
    for (const k of keys) {
      // Separators ('/', '–', '+') render as plain dim text, not key caps.
      if (k === '/' || k === '–' || k === '+') {
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
      padding: '3px 8px', fontSize: '12.5px', color: '#fff',
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
    // ESC closes (capture phase intercepts before InputManager). The ?/Slash
    // toggle itself is driven by InputManager so it can respect game state.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._visible) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.hide();
      }
    }, true);
  }
}

export default HotkeyOverlay;
