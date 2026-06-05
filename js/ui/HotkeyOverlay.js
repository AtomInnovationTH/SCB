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
const HOTKEY_GROUPS = [
  {
    // The core loop a new pilot actually needs: let the autopilot fly, deploy a
    // daughter, scan for debris. Everything below is optional/advanced.
    title: 'Essentials',
    icon: '⭐',
    rows: [
      [['A'], 'Autopilot — fly to target (your main pilot)'],
      [['Tab'], 'Pick / cycle a target'],
      [['D'], 'Deploy a daughter'],
      [['S'], 'Quick scan'],
      [['W'], 'Wide scan'],
      [['B'], 'Open shop'],
    ],
  },
  {
    title: 'Steering (manual)',
    icon: '🛰️',
    rows: [
      [['↑', '↓', '←', '→'], 'Steer the mothership (autopilot off)'],
      [['='], 'Throttle +10%'],
      [['−'], 'Throttle −10%'],
      [['Enter'], 'Approach selected target'],
      [['R'], 'Abort autopilot / recall'],
      [['Shift', 'A'], 'Engage debris-map cluster'],
    ],
  },
  {
    title: 'Camera & Views',
    icon: '🎥',
    rows: [
      [['V'], 'Cycle camera (Command / Overview)'],
      [['I'], 'Toggle inspection view'],
      [['Shift', 'V'], 'Strategic map'],
      [['`'], 'Debris map'],
      [['L'], 'Tech library (Codex)'],
      [['Shift', 'N'], 'Toggle NavSphere'],
      [['M'], 'Orbit display'],
    ],
  },
  {
    title: 'Daughters & Arms',
    icon: '🦾',
    rows: [
      [['D'], 'Deploy a daughter'],
      [['O'], 'Deploy all arms to target'],
      [['Shift', 'O'], 'Recall all arms'],
      [['H'], 'Recall all arms'],
      [['R'], 'Reel-in / recall / abort autopilot'],
      [['1', '–', '6'], 'Select / deploy arm'],
      [['P'], 'Pilot a daughter (on / off)'],
      [['X'], 'Tether detach'],
      [['Ctrl', 'Shift', 'D'], 'Deorbit sacrifice'],
    ],
  },
  {
    title: 'Capture & Tools',
    icon: '🪝',
    rows: [
      [['Space'], 'Smart action / fire lasso'],
      [['N'], 'Fire lasso / net'],
      [['F'], 'Focus action'],
      [['T'], 'Deploy tool'],
      [['Shift', '`'], 'Cycle tool'],
      [['Y'], 'Electrodynamic tether'],
      [['Shift', 'G'], 'Trawl'],
      [[','], 'Stow struts'],
      [['.'], 'Deploy struts'],
      [['Z', '/', 'Shift', 'Z'], 'Cycle analysis zones'],
    ],
  },
  {
    title: 'Power Distribution',
    icon: '⚡',
    rows: [
      [['Shift', '1'], 'Select Thrust bus'],
      [['Shift', '2'], 'Select Sensors bus'],
      [['Shift', '3'], 'Select Arms bus'],
      [['['], 'Decrease selected bus'],
      [[']'], 'Increase selected bus'],
    ],
  },
  {
    title: 'Comms',
    icon: '📶',
    rows: [
      [['C'], 'Tap: expand comms'],
      [['C'], 'Hold: comms radial menu'],
      [['PgUp'], 'Scroll comms up'],
      [['PgDn'], 'Scroll comms down'],
    ],
  },
  {
    // Advanced: only while you have taken manual control of a daughter (P key).
    // This is the one place WASD is used — the mothership itself steers with
    // the arrow keys, not WASD.
    title: 'Piloting a daughter (advanced)',
    icon: '🕹️',
    rows: [
      [['W', 'A', 'S', 'D'], 'Thrust the daughter'],
      [['Q', 'E'], 'Thrust up / down'],
      [['↑', '↓', '←', '→'], 'Orbit (station-keep)'],
      [['Shift'], 'Fine control (hold)'],
      [['F'], 'Net deploy / capture'],
      [['='], 'Station-keep radius'],
      [['F2'], 'Cycle thruster metal'],
      [['7'], 'Return to mothership'],
    ],
  },
  {
    title: 'System',
    icon: '🔧',
    rows: [
      [['F4'], 'Forge (Kiln)'],
      [['F5'], 'Thruster fuel cycle'],
      [['J'], 'Journal / skills'],
      [['Esc'], 'Pause / back / exit mode'],
      [['Ctrl', 'D'], 'Debug overlay'],
      [['?'], 'Show / hide this list'],
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
      width: '88%', maxWidth: '1100px', height: '84%', maxHeight: '760px',
      background: '#1a1a2e', border: '1px solid rgba(0,212,255,0.3)',
      borderRadius: '6px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 0 40px rgba(0,212,255,0.12)', overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '12px 18px', borderBottom: '1px solid rgba(0,212,255,0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0',
    });
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:16px;color:#00d4ff;font-weight:bold;letter-spacing:2px;">⌨ KEYBOARD SHORTCUTS</span>
        <span style="font-size:11px;color:#888;">press ? or ESC to close</span>
      </div>
      <button id="hotkey-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#888;font-size:14px;cursor:pointer;padding:2px 10px;border-radius:3px;
        font-family:'Courier New',monospace;">ESC ✕</button>
    `;

    const body = document.createElement('div');
    Object.assign(body.style, {
      flex: '1', overflowY: 'auto', padding: '16px',
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
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
      background: 'rgba(0,212,255,0.03)', padding: '10px 12px',
    });

    const title = document.createElement('div');
    Object.assign(title.style, {
      fontSize: '12px', fontWeight: 'bold', color: '#00d4ff',
      letterSpacing: '0.05em', marginBottom: '8px',
      borderBottom: '1px solid rgba(0,212,255,0.12)', paddingBottom: '5px',
    });
    title.textContent = `${group.icon} ${group.title}`;
    card.appendChild(title);

    for (const [keys, desc] of group.rows) {
      card.appendChild(this._makeRow(keys, desc));
    }
    return card;
  }

  /** @private Build a single key→description row */
  _makeRow(keys, desc) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      margin: '4px 0', fontSize: '11px',
    });

    const keyWrap = document.createElement('div');
    Object.assign(keyWrap.style, {
      display: 'flex', alignItems: 'center', gap: '3px',
      flex: '0 0 122px', flexWrap: 'wrap',
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
    Object.assign(label.style, { color: '#bbb', flex: '1', lineHeight: '1.3' });
    label.textContent = desc;

    row.appendChild(keyWrap);
    row.appendChild(label);
    return row;
  }

  /** @private A single keyboard key cap */
  _makeKeyCap(text) {
    const cap = document.createElement('span');
    Object.assign(cap.style, {
      display: 'inline-block', minWidth: '14px', textAlign: 'center',
      padding: '1px 6px', fontSize: '10px', color: '#eee',
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
