/**
 * CodexViewerUI.js — DOM overlay modal for browsing the 45 codex entries.
 * Toggle with L key ("Library"). Escape closes.
 *
 * Layout: full-screen overlay → centered panel with category sidebar + entry grid/detail.
 * @module ui/CodexViewerUI
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CodexCategory } from '../systems/CodexSystem.js';
import { Constants, trlToBadgeColor, trlToLabel } from '../core/Constants.js';

// Human-readable category labels + icons
const CATEGORY_META = {
  ORBITAL_MECHANICS: { label: 'Orbital Mechanics', icon: '🌍' },
  PROPULSION:        { label: 'Propulsion',        icon: '🔥' },
  POWER:             { label: 'Power',              icon: '⚡' },
  SPACE_ENVIRONMENT: { label: 'Environment',        icon: '🌌' },
  MATERIALS:         { label: 'Materials',           icon: '🔩' },
  TETHERS:           { label: 'Tethers',             icon: '🪢' },
  DEBRIS:            { label: 'Debris',              icon: '💥' },
  SENSORS:           { label: 'Sensors & Avionics',  icon: '📡' },
  COMMS:             { label: 'Communications',      icon: '📶' },
};

export class CodexViewerUI {
  /**
   * @param {import('../systems/CodexSystem.js').CodexSystem} codexSystem
   */
  constructor(codexSystem) {
    this._codex = codexSystem;
    this._visible = false;
    this._selectedCategory = null; // null = ALL
    this._selectedEntry = null;
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
    this._selectedEntry = null;
    this._overlay.style.display = 'flex';
    requestAnimationFrame(() => { this._overlay.style.opacity = '1'; });
    this._renderHeader();
    this._renderEntryList();
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
    // --- Overlay ---
    const overlay = document.createElement('div');
    overlay.id = 'codex-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.92)', zIndex: '9999',
      display: 'none', opacity: '0', transition: 'opacity 0.2s ease',
      justifyContent: 'center', alignItems: 'center',
      fontFamily: "'Courier New', monospace", color: '#ccc',
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.hide(); });

    // --- Panel ---
    const panel = document.createElement('div');
    panel.id = 'codex-panel';
    Object.assign(panel.style, {
      width: '82%', maxWidth: '960px', height: '80%', maxHeight: '700px',
      background: '#1a1a2e', border: '1px solid rgba(0,212,255,0.3)',
      borderRadius: '6px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 0 40px rgba(0,212,255,0.12)', overflow: 'hidden',
    });

    // --- Header ---
    const header = document.createElement('div');
    header.id = 'codex-header';
    Object.assign(header.style, {
      padding: '12px 18px', borderBottom: '1px solid rgba(0,212,255,0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0',
    });
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:16px;color:#00d4ff;font-weight:bold;letter-spacing:2px;">🔧 TECH LIBRARY</span>
        <span id="codex-progress" style="font-size:11px;color:#888;"></span>
      </div>
      <button id="codex-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#888;font-size:14px;cursor:pointer;padding:2px 10px;border-radius:3px;
        font-family:'Courier New',monospace;">ESC ✕</button>
    `;

    // --- Body (sidebar + content) ---
    const body = document.createElement('div');
    body.id = 'codex-body';
    Object.assign(body.style, {
      display: 'flex', flex: '1', overflow: 'hidden',
    });

    // --- Sidebar ---
    const sidebar = document.createElement('div');
    sidebar.id = 'codex-sidebar';
    Object.assign(sidebar.style, {
      width: '150px', minWidth: '130px', borderRight: '1px solid rgba(0,212,255,0.15)',
      overflowY: 'auto', padding: '8px 0', flexShrink: '0',
    });
    this._buildSidebar(sidebar);

    // --- Content area ---
    const content = document.createElement('div');
    content.id = 'codex-content';
    Object.assign(content.style, {
      flex: '1', overflow: 'hidden', display: 'flex', flexDirection: 'column',
    });

    // Entry list (grid)
    const entryList = document.createElement('div');
    entryList.id = 'codex-entry-list';
    Object.assign(entryList.style, {
      flex: '1', overflowY: 'auto', padding: '12px',
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: '10px', alignContent: 'start',
    });

    // Entry detail (hidden by default)
    const entryDetail = document.createElement('div');
    entryDetail.id = 'codex-entry-detail';
    Object.assign(entryDetail.style, {
      flex: '1', overflowY: 'auto', padding: '16px 20px', display: 'none',
    });

    content.appendChild(entryList);
    content.appendChild(entryDetail);
    body.appendChild(sidebar);
    body.appendChild(content);
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this._overlay = overlay;

    // Close button
    overlay.querySelector('#codex-close-btn').addEventListener('click', () => this.hide());
  }

  /** @private Build the category sidebar tabs */
  _buildSidebar(sidebar) {
    // "ALL" tab
    const allTab = this._makeSidebarTab('ALL', '📚', 'All Entries', null);
    sidebar.appendChild(allTab);

    // Category tabs
    for (const key of Object.keys(CodexCategory)) {
      const meta = CATEGORY_META[key] || { label: key, icon: '📄' };
      const tab = this._makeSidebarTab(key, meta.icon, meta.label, key);
      sidebar.appendChild(tab);
    }
  }

  /** @private Create a sidebar tab element */
  _makeSidebarTab(key, icon, label, category) {
    const tab = document.createElement('div');
    tab.dataset.category = category || 'ALL';
    Object.assign(tab.style, {
      padding: '6px 12px', cursor: 'pointer', fontSize: '11px',
      borderLeft: '3px solid transparent', transition: 'all 0.15s ease',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    tab.innerHTML = `${icon} ${label}`;
    tab.addEventListener('mouseenter', () => {
      if (tab.dataset.category !== (this._selectedCategory || 'ALL')) {
        tab.style.background = 'rgba(0,212,255,0.06)';
      }
    });
    tab.addEventListener('mouseleave', () => {
      if (tab.dataset.category !== (this._selectedCategory || 'ALL')) {
        tab.style.background = 'none';
      }
    });
    tab.addEventListener('click', () => {
      this._selectedCategory = category;
      this._selectedEntry = null;
      this._renderSidebarActive();
      this._renderEntryList();
    });
    return tab;
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  /** @private Update header progress counter */
  _renderHeader() {
    const prog = this._codex.getProgress();
    const el = document.getElementById('codex-progress');
    if (el) el.textContent = `${prog.unlocked}/${prog.total} entries unlocked (${prog.percentage}%)`;
  }

  /** @private Highlight the active sidebar tab */
  _renderSidebarActive() {
    const sidebar = document.getElementById('codex-sidebar');
    if (!sidebar) return;
    const tabs = sidebar.children;
    const active = this._selectedCategory || 'ALL';
    for (const tab of tabs) {
      const isSel = tab.dataset.category === active;
      tab.style.borderLeftColor = isSel ? '#00d4ff' : 'transparent';
      tab.style.background = isSel ? 'rgba(0,212,255,0.1)' : 'none';
      tab.style.color = isSel ? '#00d4ff' : '#aaa';
    }
  }

  /** @private Render the entry card grid */
  _renderEntryList() {
    const listEl = document.getElementById('codex-entry-list');
    const detailEl = document.getElementById('codex-entry-detail');
    if (!listEl || !detailEl) return;

    listEl.style.display = 'grid';
    detailEl.style.display = 'none';

    const entries = this._selectedCategory
      ? this._codex.getCategory(this._selectedCategory)
      : this._codex.entries;

    listEl.innerHTML = '';
    for (const entry of entries) {
      listEl.appendChild(this._makeCard(entry));
    }

    this._renderSidebarActive();
  }

  /** @private Create a single entry card */
  _makeCard(entry) {
    const card = document.createElement('div');
    card.className = 'codex-card';

    const isLocked = !entry.unlocked;
    const isNew = entry.unlocked && !entry.seen;

    Object.assign(card.style, {
      padding: '10px 12px', borderRadius: '4px', cursor: isLocked ? 'default' : 'pointer',
      border: `1px solid ${isLocked ? 'rgba(255,255,255,0.06)' : isNew ? 'rgba(0,212,255,0.4)' : 'rgba(0,212,255,0.15)'}`,
      background: isLocked ? 'rgba(255,255,255,0.02)' : isNew ? 'rgba(0,212,255,0.06)' : 'rgba(0,212,255,0.03)',
      transition: 'all 0.15s ease', position: 'relative', overflow: 'hidden',
      boxShadow: isNew ? '0 0 12px rgba(0,212,255,0.15)' : 'none',
    });

    const title = isLocked ? '???' : entry.title;
    const icon = isLocked ? '🔒' : entry.icon;
    const catMeta = CATEGORY_META[entry.category] || { label: entry.category };
    const shortText = isLocked
      ? '<span style="opacity:0.3;font-style:italic;">Discover through gameplay</span>'
      : `<span style="opacity:0.7;">${entry.shortText}</span>`;
    const newBadge = isNew
      ? '<span style="position:absolute;top:6px;right:8px;font-size:9px;color:#00d4ff;font-weight:bold;text-shadow:0 0 6px rgba(0,212,255,0.5);">NEW</span>'
      : '';

    // ST-6.6: Colour-coded TRL badge on card (small, bottom-left corner style)
    const trl = entry.trl;
    const trlBadge = (!isLocked && typeof trl === 'number')
      ? `<span title="TRL ${trl} — ${trlToLabel(trl, Constants.TRL)}${entry.trlRationale ? '\n' + entry.trlRationale : ''}"
              style="position:absolute;bottom:6px;right:8px;font-size:9px;font-weight:bold;
                     padding:1px 5px;border-radius:2px;letter-spacing:0.05em;
                     color:${trlToBadgeColor(trl, Constants.TRL)};
                     border:1px solid ${trlToBadgeColor(trl, Constants.TRL)};
                     background:rgba(0,0,0,0.45);">TRL ${trl}</span>`
      : '';

    card.innerHTML = `
      ${newBadge}
      <div style="font-size:18px;margin-bottom:4px;">${icon}</div>
      <div style="font-size:12px;font-weight:bold;color:${isLocked ? '#555' : '#eee'};margin-bottom:3px;
        ${isLocked ? 'filter:blur(2px);user-select:none;' : ''}">${title}</div>
      <div style="font-size:9px;color:${isLocked ? '#444' : '#00d4ff'};margin-bottom:4px;opacity:0.7;">${catMeta.label}</div>
      <div style="font-size:10px;line-height:1.4;padding-bottom:14px;">${shortText}</div>
      ${trlBadge}
    `;

    if (!isLocked) {
      card.addEventListener('mouseenter', () => {
        card.style.borderColor = '#00d4ff';
        card.style.background = 'rgba(0,212,255,0.1)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.borderColor = isNew ? 'rgba(0,212,255,0.4)' : 'rgba(0,212,255,0.15)';
        card.style.background = isNew ? 'rgba(0,212,255,0.06)' : 'rgba(0,212,255,0.03)';
      });
      card.addEventListener('click', () => this._showDetail(entry));
    } else {
      card.addEventListener('click', () => this._showLockedMessage(card));
    }

    return card;
  }

  /** @private Brief flicker message on locked card click */
  _showLockedMessage(card) {
    const existing = card.querySelector('.locked-msg');
    if (existing) return;
    const msg = document.createElement('div');
    msg.className = 'locked-msg';
    Object.assign(msg.style, {
      position: 'absolute', bottom: '4px', left: '0', right: '0', textAlign: 'center',
      fontSize: '9px', color: '#ffaa00', padding: '2px', background: 'rgba(0,0,0,0.7)',
    });
    msg.textContent = '🔒 Discover this through gameplay';
    card.appendChild(msg);
    setTimeout(() => { if (msg.parentNode) msg.parentNode.removeChild(msg); }, 2000);
  }

  /** @private Show the full entry detail view */
  _showDetail(entry) {
    const listEl = document.getElementById('codex-entry-list');
    const detailEl = document.getElementById('codex-entry-detail');
    if (!listEl || !detailEl) return;

    this._selectedEntry = entry;
    listEl.style.display = 'none';
    detailEl.style.display = 'block';

    // Mark as viewed
    if (entry.unlocked && !entry.seen) {
      eventBus.emit(Events.CODEX_VIEWED, { id: entry.id });
    }

    const catMeta = CATEGORY_META[entry.category] || { label: entry.category, icon: '📄' };

    // ST-6.6: Larger TRL badge + label + rationale in detail view
    const dTrl = entry.trl;
    let trlDetailHtml = '';
    if (typeof dTrl === 'number') {
      const col = trlToBadgeColor(dTrl, Constants.TRL);
      const lbl = trlToLabel(dTrl, Constants.TRL);
      const rat = entry.trlRationale ? entry.trlRationale : '';
      trlDetailHtml = `
        <div title="NASA Technology Readiness Level ${dTrl} — ${lbl}"
             style="display:flex;align-items:center;gap:10px;margin-bottom:12px;
                    padding:6px 10px;border:1px solid ${col};border-radius:3px;
                    background:rgba(0,0,0,0.35);font-size:11px;">
          <span style="font-weight:bold;letter-spacing:0.05em;color:${col};
                       padding:2px 8px;border:1px solid ${col};border-radius:2px;
                       background:rgba(0,0,0,0.35);">TRL ${dTrl}</span>
          <span style="color:${col};font-weight:bold;letter-spacing:0.04em;">${lbl}</span>
          ${rat ? `<span style="color:#888;font-style:italic;flex:1;">${rat}</span>` : ''}
        </div>`;
    }

    detailEl.innerHTML = `
      <div id="codex-back-btn" style="cursor:pointer;color:#00d4ff;font-size:12px;margin-bottom:14px;
        display:inline-block;padding:3px 8px;border:1px solid rgba(0,212,255,0.2);border-radius:3px;
        transition:background 0.15s;">← Back</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <span style="font-size:32px;">${entry.icon}</span>
        <div>
          <div style="font-size:16px;font-weight:bold;color:#eee;">${entry.title}</div>
          <div style="font-size:10px;color:#00d4ff;opacity:0.8;">${catMeta.icon} ${catMeta.label}</div>
        </div>
      </div>
      ${trlDetailHtml}
      <div style="font-size:12px;color:#aaddff;line-height:1.4;margin-bottom:16px;
        padding:8px 12px;background:rgba(0,212,255,0.05);border-left:3px solid rgba(0,212,255,0.3);
        border-radius:2px;">${entry.shortText}</div>
      <div style="font-size:12px;color:#ccc;line-height:1.7;white-space:pre-wrap;">${entry.fullText}</div>
    `;

    const backBtn = detailEl.querySelector('#codex-back-btn');
    backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'rgba(0,212,255,0.1)'; });
    backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none'; });
    backBtn.addEventListener('click', () => {
      this._selectedEntry = null;
      this._renderEntryList();
      this._renderHeader();
    });
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // ESC closes codex (capture phase intercepts before InputManager)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._visible) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.hide();
      }
    }, true);

    // Re-render when new entry unlocked (player might have codex open)
    eventBus.on(Events.CODEX_UNLOCKED, () => {
      if (this._visible) {
        this._renderHeader();
        if (!this._selectedEntry) this._renderEntryList();
      }
    });
  }
}

export default CodexViewerUI;
