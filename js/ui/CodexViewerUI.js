/**
 * CodexViewerUI.js — DOM overlay modal for browsing the codex entries.
 * Toggle with I key ("Info"). Escape closes.
 *
 * Layout: full-screen overlay → centered panel with category sidebar + entry grid/detail.
 * @module ui/CodexViewerUI
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { entryMatchesQuery } from '../systems/CodexSystem.js';
import {
  Constants, trlToBadgeColor, trlToLabel, techLevelBadgeText,
} from '../core/Constants.js';

// Fallback category labels/icons used only if the system supplies no meta
// (e.g. codex.json failed to load). Authoritative meta — including per-category
// colour — comes from data/codex.json via codexSystem.getCategories().
const CATEGORY_META_FALLBACK = {
  ORBITAL_MECHANICS: { label: 'Orbital Mechanics', icon: '🌍' },
  PROPULSION:        { label: 'Propulsion',        icon: '🔥' },
  POWER:             { label: 'Power',              icon: '⚡' },
  SPACE_ENVIRONMENT: { label: 'Environment',        icon: '🌌' },
  MATERIALS:         { label: 'Materials',           icon: '🔩' },
  TETHERS:           { label: 'Tethers',             icon: '🪢' },
  DEBRIS:            { label: 'Debris',              icon: '💥' },
  SENSORS:           { label: 'Sensors',             icon: '📡' },
  ATTITUDE:          { label: 'Attitude Control',    icon: '🌀' },
  AVIONICS:          { label: 'Avionics',            icon: '🖥️' },
  COMMS:             { label: 'Communications',      icon: '📶' },
  CATALOG:           { label: 'Catalog',             icon: '🛰️' },
  HERITAGE:          { label: 'Heritage',            icon: '🏛️' },
  WORLD_INDUSTRY:    { label: 'World & Industry',    icon: '🌐' },
  NEWS:              { label: 'News & Events',       icon: '📰' },
  PLAYBOOK:          { label: 'Playbook',            icon: '🎮' },
};

export class CodexViewerUI {
  /**
   * @param {import('../systems/CodexSystem.js').CodexSystem} codexSystem
   */
  constructor(codexSystem) {
    this._codex = codexSystem;
    this._visible = false;
    this._selectedCategory = null; // set to the first category on first show()
    this._selectedEntry = null;
    this._overlay = null;
    /** @type {string} UX-11 #10: live search query (overrides sidebar while set) */
    this._searchQuery = '';
    /** @type {number|null} debounce handle for the search input */
    this._searchDebounce = null;

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
    // No "All" view — land on a category (the first newbie-friendly one) so the
    // list is focused and readable on open.
    if (!this._selectedCategory) this._selectedCategory = this._firstCategoryKey();
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
      width: '94%', maxWidth: '1400px', height: '90%', maxHeight: '1000px',
      background: '#1a1a2e', border: '1px solid rgba(0,212,255,0.3)',
      borderRadius: '6px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 0 40px rgba(0,212,255,0.12)', overflow: 'hidden',
    });

    // --- Header ---
    const header = document.createElement('div');
    header.id = 'codex-header';
    Object.assign(header.style, {
      padding: '16px 24px', borderBottom: '1px solid rgba(0,212,255,0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0',
    });
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
        <span style="font-size:20px;color:#00d4ff;font-weight:bold;letter-spacing:2px;white-space:nowrap;">🔧 TECH LIBRARY</span>
        <span id="codex-progress" style="font-size:13px;color:#888;white-space:nowrap;"></span>
        <input id="codex-search" type="text" placeholder="🔍 search topics…" spellcheck="false"
          style="flex:1;max-width:320px;margin-left:8px;background:rgba(0,0,0,0.4);
                 border:1px solid rgba(0,212,255,0.25);border-radius:3px;color:#cfefff;
                 font-family:'Courier New',monospace;font-size:14px;padding:6px 10px;outline:none;" />
      </div>
      <button id="codex-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#888;font-size:16px;cursor:pointer;padding:4px 12px;border-radius:3px;
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
      width: '210px', minWidth: '180px', borderRight: '1px solid rgba(0,212,255,0.15)',
      overflowY: 'auto', padding: '10px 0', flexShrink: '0',
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
      flex: '1', overflowY: 'auto', padding: '16px',
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      gap: '14px', alignContent: 'start',
    });

    // Entry detail (hidden by default)
    const entryDetail = document.createElement('div');
    entryDetail.id = 'codex-entry-detail';
    Object.assign(entryDetail.style, {
      flex: '1', overflowY: 'auto', padding: '22px 28px', display: 'none',
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

    // UX-11 #10: live search — filters across ALL categories as you type;
    // sidebar selection is ignored while a query is active. Debounced
    // (review fix): each render rebuilds every card, so don't do it
    // per keystroke.
    const searchInput = overlay.querySelector('#codex-search');
    searchInput.addEventListener('input', () => {
      if (this._searchDebounce) clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => {
        this._searchDebounce = null;
        this._searchQuery = searchInput.value.trim();
        this._selectedEntry = null;
        this._renderEntryList();
      }, 120);
    });
    // Keep keystrokes (incl. game hotkeys like L/S/W) inside the search box.
    searchInput.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { searchInput.blur(); return; }
      e.stopPropagation();
    });
  }

  /** @private Resolve category meta {label, icon, color} from the system, with fallback. */
  _catMeta(key) {
    const m = (typeof this._codex.getCategoryMeta === 'function') ? this._codex.getCategoryMeta(key) : null;
    const fb = CATEGORY_META_FALLBACK[key] || { label: key, icon: '📄' };
    return {
      label: (m && m.label) || fb.label,
      icon: (m && m.icon) || fb.icon,
      color: (m && m.color) || '#00d4ff',
    };
  }

  /** @private Build the category sidebar tabs */
  _buildSidebar(sidebar) {
    // Category tabs — ordered, data-driven; skip categories with no entries yet.
    // (No "All Entries" tab: a category is always selected so new players land
    // on a focused, readable list rather than the full firehose.)
    const cats = (typeof this._codex.getCategories === 'function')
      ? this._codex.getCategories()
      : Object.keys(CATEGORY_META_FALLBACK).map(key => ({ key, ...this._catMeta(key) }));
    for (const c of cats) {
      const hasEntries = this._codex.getCategoryProgress
        ? this._codex.getCategoryProgress(c.key).total > 0
        : true;
      if (!hasEntries) continue;
      const tab = this._makeSidebarTab(c.key, c.icon, c.label, c.key);
      sidebar.appendChild(tab);
    }
  }

  /** @private First category key (by order) that has at least one entry. */
  _firstCategoryKey() {
    const cats = (typeof this._codex.getCategories === 'function')
      ? this._codex.getCategories()
      : Object.keys(CATEGORY_META_FALLBACK).map(key => ({ key }));
    for (const c of cats) {
      const hasEntries = this._codex.getCategoryProgress
        ? this._codex.getCategoryProgress(c.key).total > 0
        : true;
      if (hasEntries) return c.key;
    }
    return cats.length ? cats[0].key : null;
  }

  /** @private Create a sidebar tab element */
  _makeSidebarTab(key, icon, label, category) {
    const tab = document.createElement('div');
    tab.dataset.category = category;
    Object.assign(tab.style, {
      padding: '9px 14px', cursor: 'pointer', fontSize: '13px',
      borderLeft: '3px solid transparent', transition: 'all 0.15s ease',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px',
    });
    // Per-category progress counter, refreshed on every render.
    tab.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">${icon} ${label}</span>` +
      `<span class="codex-tab-count" style="font-size:11px;color:#557;flex-shrink:0;"></span>`;
    tab.addEventListener('mouseenter', () => {
      if (tab.dataset.category !== this._selectedCategory) {
        tab.style.background = 'rgba(0,212,255,0.06)';
      }
    });
    tab.addEventListener('mouseleave', () => {
      if (tab.dataset.category !== this._selectedCategory) {
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
    if (el) el.textContent = `${prog.unlocked}/${prog.total} briefings unlocked (${prog.percentage}%)`;
  }

  /** @private Highlight the active sidebar tab + refresh per-category counts */
  _renderSidebarActive() {
    const sidebar = document.getElementById('codex-sidebar');
    if (!sidebar) return;
    const tabs = sidebar.children;
    const active = this._selectedCategory;
    for (const tab of tabs) {
      const isSel = tab.dataset.category === active;
      tab.style.borderLeftColor = isSel ? '#00d4ff' : 'transparent';
      tab.style.background = isSel ? 'rgba(0,212,255,0.1)' : 'none';
      tab.style.color = isSel ? '#00d4ff' : '#aaa';

      // Per-category progress (e.g. "3/7").
      const countEl = tab.querySelector('.codex-tab-count');
      if (countEl) {
        if (typeof this._codex.getCategoryProgress === 'function') {
          const p = this._codex.getCategoryProgress(tab.dataset.category);
          countEl.textContent = `${p.unlocked}/${p.total}`;
        }
        countEl.style.color = isSel ? '#00d4ff' : '#557';
      }
    }
  }

  /** @private Render the entry card grid */
  _renderEntryList() {
    const listEl = document.getElementById('codex-entry-list');
    const detailEl = document.getElementById('codex-entry-detail');
    if (!listEl || !detailEl) return;

    listEl.style.display = 'grid';
    detailEl.style.display = 'none';

    // UX-11 #10: an active search query searches ALL categories and ignores
    // the sidebar selection until cleared.
    let entries;
    if (this._searchQuery) {
      entries = (typeof this._codex.searchEntries === 'function')
        ? this._codex.searchEntries(this._searchQuery)
        : this._codex.entries.filter(e => entryMatchesQuery(e, this._searchQuery));
    } else {
      entries = this._selectedCategory
        ? this._codex.getCategory(this._selectedCategory)
        : this._codex.entries;
    }

    listEl.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { color: '#667', fontSize: '14px', padding: '24px' });
      empty.textContent = `No topics match “${this._searchQuery}”.`;
      listEl.appendChild(empty);
    }
    for (const entry of entries) {
      listEl.appendChild(this._makeCard(entry));
    }

    this._renderSidebarActive();
  }

  /** @private Create a single entry card.
   * UX-11 #10 reveal model: title + icon + category + one-liner are ALWAYS
   * visible — the library is a syllabus. Depth (full briefing + rationale)
   * unlocks through play. Locked cards are readable but visibly
   * "not-yet-detailed": dimmed border + 🔒 on the Tech-Level badge.
   */
  _makeCard(entry) {
    const card = document.createElement('div');
    card.className = 'codex-card';

    const isLocked = !entry.unlocked;
    const isNew = entry.unlocked && !entry.seen;

    Object.assign(card.style, {
      padding: '14px 16px', borderRadius: '4px', cursor: 'pointer',
      border: `1px solid ${isLocked ? 'rgba(255,255,255,0.08)' : isNew ? 'rgba(0,212,255,0.4)' : 'rgba(0,212,255,0.15)'}`,
      background: isLocked ? 'rgba(255,255,255,0.02)' : isNew ? 'rgba(0,212,255,0.06)' : 'rgba(0,212,255,0.03)',
      transition: 'all 0.15s ease', position: 'relative', overflow: 'hidden',
      boxShadow: isNew ? '0 0 12px rgba(0,212,255,0.15)' : 'none',
    });

    const catMeta = this._catMeta(entry.category);
    const shortText = `<span style="opacity:${isLocked ? 0.55 : 0.7};">${entry.shortText}</span>`;
    const newBadge = isNew
      ? '<span style="position:absolute;top:8px;right:10px;font-size:11px;color:#00d4ff;font-weight:bold;text-shadow:0 0 6px rgba(0,212,255,0.5);">NEW</span>'
      : '';

    // Tech-Level is intentionally NOT shown on cards: flagging it (especially
    // the flight-proven majority) is noise. It surfaces only in the detail view
    // and only for not-yet-proven tech — see _showDetail.
    card.innerHTML = `
      ${newBadge}
      <div style="font-size:24px;margin-bottom:6px;${isLocked ? 'opacity:0.65;' : ''}">${entry.icon}</div>
      <div style="font-size:15px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};margin-bottom:4px;">${entry.title}</div>
      <div style="font-size:11px;color:${isLocked ? '#357' : '#00d4ff'};margin-bottom:6px;opacity:0.7;">${catMeta.label}</div>
      <div style="font-size:13px;line-height:1.5;">${shortText}</div>
    `;

    card.addEventListener('mouseenter', () => {
      card.style.borderColor = isLocked ? 'rgba(0,212,255,0.3)' : '#00d4ff';
      card.style.background = 'rgba(0,212,255,0.1)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.borderColor = isLocked ? 'rgba(255,255,255,0.08)'
        : (isNew ? 'rgba(0,212,255,0.4)' : 'rgba(0,212,255,0.15)');
      card.style.background = isLocked ? 'rgba(255,255,255,0.02)'
        : (isNew ? 'rgba(0,212,255,0.06)' : 'rgba(0,212,255,0.03)');
    });
    card.addEventListener('click', () => this._showDetail(entry));

    return card;
  }

  // (UX-11 #10: _showLockedMessage removed — locked cards open the detail
  // view, which shows the how-to-unlock hint instead of a flicker message.)

  /** @private Show the full entry detail view.
   * UX-11 #10: locked entries open too — they show the one-liner, the
   * how-to-unlock hint, and a greyed "full briefing unlocks when…" panel
   * instead of the fullText.
   */
  _showDetail(entry) {
    const listEl = document.getElementById('codex-entry-list');
    const detailEl = document.getElementById('codex-entry-detail');
    if (!listEl || !detailEl) return;

    this._selectedEntry = entry;
    listEl.style.display = 'none';
    detailEl.style.display = 'block';

    const isLocked = !entry.unlocked;

    // Mark as viewed
    if (entry.unlocked && !entry.seen) {
      eventBus.emit(Events.CODEX_VIEWED, { id: entry.id });
    }

    const catMeta = this._catMeta(entry.category);

    // Tech-Level row: shown ONLY when the tech is not yet flight-proven.
    // TRL 9 (established/operational) is the unremarkable default — flagging it
    // everywhere is noise — so the row appears only for Mature/Research/
    // Speculative tech, where "how real is this?" is genuinely useful signal.
    const dTrl = entry.trl;
    let trlDetailHtml = '';
    if (typeof dTrl === 'number' && dTrl < Constants.TRL.FLIGHT_PROVEN_MIN) {
      const col = trlToBadgeColor(dTrl, Constants.TRL);
      const lbl = trlToLabel(dTrl, Constants.TRL);
      const rat = (!isLocked && entry.trlRationale) ? entry.trlRationale : '';
      trlDetailHtml = `
        <div title="Tech Level (real-world readiness) ${dTrl}. ${lbl}"
             style="display:flex;align-items:center;gap:10px;margin-bottom:14px;
                    padding:8px 12px;border:1px solid ${col};border-radius:3px;
                    background:rgba(0,0,0,0.35);font-size:13px;${isLocked ? 'opacity:0.7;' : ''}">
          <span style="font-weight:bold;letter-spacing:0.05em;color:${col};
                       padding:2px 8px;border:1px solid ${col};border-radius:2px;
                       background:rgba(0,0,0,0.35);">${techLevelBadgeText(dTrl)}</span>
          <span style="color:${col};font-weight:bold;letter-spacing:0.04em;">${lbl}</span>
          ${rat ? `<span style="color:#888;font-style:italic;flex:1;">${rat}</span>` : ''}
          ${isLocked ? '<span style="color:#667;font-style:italic;flex:1;text-align:right;">🔒 details locked</span>' : ''}
        </div>`;
    }

    // Body: full briefing when unlocked; hint + greyed unlock line when locked.
    const hint = entry.unlockHint || 'Discover through gameplay.';
    const bodyHtml = isLocked
      ? `
        <div style="font-size:13px;color:#ffaa00;line-height:1.6;margin-bottom:14px;
          padding:10px 14px;border:1px dashed rgba(255,170,0,0.4);border-radius:3px;">
          🔒 <b>How to unlock:</b> ${hint}
        </div>
        <div style="font-size:14px;color:#667;font-style:italic;line-height:1.6;">
          Full briefing unlocks when you encounter this in flight.
        </div>`
      : `<div style="font-size:15px;color:#ccc;line-height:1.75;white-space:pre-wrap;">${entry.fullText}</div>`;

    detailEl.innerHTML = `
      <div id="codex-back-btn" style="cursor:pointer;color:#00d4ff;font-size:14px;margin-bottom:16px;
        display:inline-block;padding:5px 12px;border:1px solid rgba(0,212,255,0.2);border-radius:3px;
        transition:background 0.15s;">← Back</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">
        <span style="font-size:42px;${isLocked ? 'opacity:0.65;' : ''}">${entry.icon}</span>
        <div>
          <div style="font-size:20px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};">${entry.title}</div>
          <div style="font-size:12px;color:#00d4ff;opacity:0.8;">${catMeta.icon} ${catMeta.label}</div>
        </div>
      </div>
      ${trlDetailHtml}
      <div style="font-size:15px;color:#aaddff;line-height:1.55;margin-bottom:18px;
        padding:10px 14px;background:rgba(0,212,255,0.05);border-left:3px solid rgba(0,212,255,0.3);
        border-radius:2px;">${entry.shortText}</div>
      ${bodyHtml}
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
