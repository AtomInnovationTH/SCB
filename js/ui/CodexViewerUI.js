/**
 * CodexViewerUI.js — DOM overlay modal for browsing the codex entries.
 * Toggle with I key ("Info"). Escape closes.
 *
 * Layout (Slice 1 overhaul): full-screen overlay → centered panel with a
 * **3-column master-detail** interior:
 *   • sidebar (categories + learning paths)
 *   • compact entry list (dense rows — icon · title · one-line hook · NEW/🔒 pip)
 *   • persistent reading pane (QUICK LOOK → BRIEFING → TECH LEVEL → REAL WORLD →
 *     FORMULA → RELATED → prev/next)
 *
 * Reading follows selection: ↑/↓ move the list AND re-render the pane, so the
 * pane is never empty. Below ~1000px the interior collapses to a 2-pane swap
 * (list ⇄ reading), preserving the old Back behavior.
 *
 * @module ui/CodexViewerUI
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { entryMatchesQuery, ALIASES } from '../systems/CodexSystem.js';
import { decorateGlossary } from '../systems/codex/glossary.js';
import { layoutEgoMap, EGO_LAYOUT_VIEW } from '../systems/codex/egoLayout.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';
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

// Below this panel width the 3-column interior collapses to a 2-pane swap
// (list ⇄ reading), mirroring the pre-overhaul Back navigation.
const NARROW_BREAKPOINT = 1000;

// Dwell before an entry is marked seen. `CODEX_VIEWED` fires only once the
// selection has *rested* on an unlocked/unseen entry this long — arrow-scrubbing
// and transient renders (deep-link routing, filter churn) never mark seen.
const SEEN_DWELL_MS = 1500;

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
    /** @type {'all'|'unlocked'|'locked'} list filter (Phase 3 filter bar) */
    this._filter = 'all';
    /** @type {'default'|'az'|'trl'} list sort order (Phase 3 sort bar) */
    this._sort = 'default';
    /** @type {number} roving-focus index into the current entry list (keyboard nav) */
    this._focusIdx = -1;
    /** @type {boolean} true while the interior is in the narrow 2-pane swap mode */
    this._narrow = false;

    /**
     * Slice 8 — ego-map mode. When true the reading pane renders an SVG
     * connections map of `_selectedEntry` instead of the article. Transient
     * (never persisted); cleared on any selection/filter/track switch and hide().
     * @type {boolean}
     */
    this._mapMode = false;
    /** @type {?string} focus entry id for the map (may differ from selection after re-centering) */
    this._mapFocusId = null;

    /** @type {string|null} deep-link target id for the next show()'s auto-select */
    this._pendingOpenId = null;

    /** @type {*} debounce handle for the window resize listener */
    this._resizeDebounce = null;

    /** @type {*} pending seen-dwell timer handle (null when disarmed) */
    this._seenTimer = null;    /**
     * Injectable timer seam so the dwell logic is testable in the DOM-less Node
     * harness. Tests swap these for spies via `_setSeenTimerHooks`.
     * @type {(fn:Function, ms:number)=>*}
     */
    this._scheduleSeen = (fn, ms) => setTimeout(fn, ms);
    /** @type {(handle:*)=>void} */
    this._cancelSeen = (h) => clearTimeout(h);

    this._buildDOM();
    this._setupListeners();
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  toggle() { this._visible ? this.hide() : this.show(); }

  show() {
    this._visible = true;
    // No "All" view — land on a category (the first newbie-friendly one) so the
    // list is focused and readable on open.
    if (!this._selectedCategory) this._selectedCategory = this._firstCategoryKey();
    this._overlay.style.display = 'flex';
    requestAnimationFrame(() => { this._overlay.style.opacity = '1'; });
    this._applyResponsiveLayout();
    this._renderHeader();
    this._renderEntryList();
    // Auto-select the first entry so the reading pane is never empty on open.
    this._selectFirstEntry();
  }

  hide() {
    this._visible = false;
    // Slice 8: map mode is transient — never persists across a close.
    this._mapMode = false;
    // Cancel any pending seen-dwell emit — a fire after close would mark an
    // entry the player never actually read.
    this._clearSeenTimer();
    this._overlay.style.opacity = '0';
    setTimeout(() => { if (!this._visible) this._overlay.style.display = 'none'; }, 200);
  }

  isVisible() { return this._visible; }

  /**
   * Deep-link: open the viewer directly on a specific entry by id (glossary
   * §11.8 / Phase 4). Resolves the id through save-migration ALIASES for
   * robustness, opens the overlay, selects the entry's real category, then
   * routes to its reading pane. Unknown ids are a safe no-op. Locked entries are
   * fine — the viewer renders them with a how-to-unlock hint.
   * @param {string} id  codex entry id (possibly a retired alias)
   * @returns {boolean} true if an entry was opened
   */
  openEntry(id) {
    if (!id || !this._codex || typeof this._codex.getEntry !== 'function') return false;
    const resolvedId = (ALIASES && ALIASES[id]) || id;
    const entry = this._codex.getEntry(resolvedId);
    if (!entry) return false;
    // Land on the entry's real category (not a `track:` pseudo-key) BEFORE
    // show() so show()'s auto-select resolves the right list — no transient
    // render/mark-seen of the stale category's first entry. _pendingOpenId tells
    // _selectFirstEntry to route to this entry instead of position 0.
    this._selectedCategory = entry.category;
    this._pendingOpenId = resolvedId;
    this.show();
    this._pendingOpenId = null;
    return true;
  }

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
      width: '96vw', maxWidth: '1720px', height: '94vh', maxHeight: '1200px',
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
        <div id="codex-progress-bar" title="overall briefings unlocked"
          style="width:120px;height:6px;border-radius:3px;background:rgba(255,255,255,0.08);
                 overflow:hidden;flex-shrink:0;">
          <div id="codex-progress-fill" style="height:100%;width:0%;
            background:linear-gradient(90deg,#00d4ff,#7af);transition:width 0.3s ease;"></div>
        </div>
        <input id="codex-search" type="text" placeholder="🔍 search topics…" spellcheck="false"
          style="flex:1;max-width:320px;margin-left:8px;background:rgba(0,0,0,0.4);
                 border:1px solid rgba(0,212,255,0.25);border-radius:3px;color:#cfefff;
                 font-family:'Courier New',monospace;font-size:14px;padding:6px 10px;outline:none;" />
      </div>
      <button id="codex-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#888;font-size:16px;cursor:pointer;padding:4px 12px;border-radius:3px;
        font-family:'Courier New',monospace;">ESC ✕</button>
    `;

    // --- Body (sidebar + list + reading pane) ---
    const body = document.createElement('div');
    body.id = 'codex-body';
    Object.assign(body.style, {
      display: 'flex', flex: '1', overflow: 'hidden',
    });

    // --- Sidebar (column 1) ---
    const sidebar = document.createElement('div');
    sidebar.id = 'codex-sidebar';
    Object.assign(sidebar.style, {
      width: '200px', minWidth: '180px', borderRight: '1px solid rgba(0,212,255,0.15)',
      overflowY: 'auto', padding: '10px 0', flexShrink: '0',
    });
    this._buildSidebar(sidebar);

    // --- Middle column: filter bar + compact entry list (column 2) ---
    const middle = document.createElement('div');
    middle.id = 'codex-middle';
    Object.assign(middle.style, {
      width: '320px', minWidth: '300px', maxWidth: '340px',
      borderRight: '1px solid rgba(0,212,255,0.12)',
      display: 'flex', flexDirection: 'column', flexShrink: '0', overflow: 'hidden',
    });

    // Filter / sort bar (above the list). Built once; its buttons mutate
    // _filter/_sort and re-render.
    const filterBar = document.createElement('div');
    filterBar.id = 'codex-filter-bar';
    Object.assign(filterBar.style, {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '8px 12px', borderBottom: '1px solid rgba(0,212,255,0.1)',
      fontSize: '11px', color: '#889', flexShrink: '0',
    });
    this._buildFilterBar(filterBar);

    // Compact entry list (dense rows, replaces the old card grid).
    const entryList = document.createElement('div');
    entryList.id = 'codex-entry-list';
    Object.assign(entryList.style, {
      flex: '1', overflowY: 'auto', padding: '6px 0',
    });

    middle.appendChild(filterBar);
    middle.appendChild(entryList);

    // --- Reading pane (column 3) ---
    const reading = document.createElement('div');
    reading.id = 'codex-reading';
    // Focusable (programmatic only) so Enter can move reading focus off the
    // list and PgUp/PgDn scroll the briefing. tabIndex -1 keeps it out of the
    // Tab order while allowing reading.focus().
    reading.tabIndex = -1;
    reading.style.outline = 'none';
    Object.assign(reading.style, {
      flex: '1', overflowY: 'auto', padding: '26px 32px', minWidth: '0',
    });

    body.appendChild(sidebar);
    body.appendChild(middle);
    body.appendChild(reading);
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this._overlay = overlay;

    // Close button
    overlay.querySelector('#codex-close-btn').addEventListener('click', () => this.hide());

    // UX-11 #10: live search — filters across ALL categories as you type;
    // sidebar selection is ignored while a query is active. Debounced (each
    // render rebuilds every row, so don't do it per keystroke).
    const searchInput = overlay.querySelector('#codex-search');
    searchInput.addEventListener('input', () => {
      if (this._searchDebounce) clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => {
        this._searchDebounce = null;
        this._searchQuery = searchInput.value.trim();
        this._renderEntryList();
        this._selectFirstEntry();
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
    const cats = (typeof this._codex.getCategories === 'function')
      ? this._codex.getCategories()
      : Object.keys(CATEGORY_META_FALLBACK).map(key => ({ key, ...this._catMeta(key) }));
    for (const c of cats) {
      const hasEntries = this._codex.getCategoryProgress
        ? this._codex.getCategoryProgress(c.key).total > 0
        : true;
      if (!hasEntries) continue;
      const tab = this._makeSidebarTab(c.key, c.icon, c.label, c.key, c.color);
      sidebar.appendChild(tab);
    }

    // --- Tracks: guided cross-category learning paths. Rendered below the
    // categories under a small divider. Selecting a track key (prefixed
    // "track:") switches the list into ordered-track mode. ---
    const tracks = (typeof this._codex.getTracks === 'function') ? this._codex.getTracks() : null;
    const trackEntries = tracks ? Object.entries(tracks) : [];
    if (trackEntries.length) {
      const divider = document.createElement('div');
      divider.textContent = 'LEARNING PATHS';
      Object.assign(divider.style, {
        padding: '14px 14px 6px', fontSize: '10px', letterSpacing: '0.14em',
        color: '#566', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '8px',
      });
      sidebar.appendChild(divider);
      trackEntries
        .sort((a, b) => (a[1].order ?? 999) - (b[1].order ?? 999))
        .forEach(([tid, meta]) => {
          const tab = this._makeSidebarTab(
            `track:${tid}`, '🧭', meta.label || tid, `track:${tid}`, meta.color,
          );
          sidebar.appendChild(tab);
        });
    }

    // --- Slice 8: CONNECTIONS — the ego-map affordance. A `map:` pseudo-key tab
    // enters map mode on the current selection (fallback: first unlocked entry).
    // It never becomes the active category, so it's given a custom onClick that
    // enters map mode instead of switching the category. ---
    const mapDivider = document.createElement('div');
    mapDivider.textContent = 'CONNECTIONS';
    Object.assign(mapDivider.style, {
      padding: '14px 14px 6px', fontSize: '10px', letterSpacing: '0.14em',
      color: '#566', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '8px',
    });
    sidebar.appendChild(mapDivider);
    const mapTab = this._makeSidebarTab('map:', '🕸', 'Map', 'map:', '#8ab',
      () => this._openMapFromSidebar());
    sidebar.appendChild(mapTab);
  }

  /** @private Slice 8 — enter map mode from the sidebar Map tab. Uses the
   * current selection, falling back to the first unlocked entry. */
  _openMapFromSidebar() {
    let entry = this._selectedEntry;
    if (!entry || !entry.unlocked) {
      const unlocked = (typeof this._codex.getUnlockedEntries === 'function')
        ? this._codex.getUnlockedEntries()
        : (this._codex.entries || []).filter(e => e.unlocked);
      entry = unlocked && unlocked.length ? unlocked[0] : null;
    }
    if (!entry) return;
    this._selectedEntry = entry;
    this._enterMapMode(entry);
    if (this._narrow) this._applyResponsiveLayout();
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

  /** @private Create a sidebar tab element.
   * @param {string} key
   * @param {string} icon
   * @param {string} label
   * @param {string} category - dataset.category (may be a `track:`/`map:` pseudo-key)
   * @param {string} color
   * @param {Function} [onClick] - Slice 8: custom click handler; when supplied,
   *        replaces the default category-switch behaviour (used by the map tab).
   */
  _makeSidebarTab(key, icon, label, category, color, onClick) {
    const tab = document.createElement('div');
    tab.dataset.category = category;
    // Phase 3 hue theming: stash the category accent on the element so the
    // active-highlight + hover read in the category's own colour.
    tab.dataset.accent = color || '#00d4ff';
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
        const rgb = this._hexToRgb(tab.dataset.accent);
        tab.style.background = `rgba(${rgb.r},${rgb.g},${rgb.b},0.08)`;
      }
    });
    tab.addEventListener('mouseleave', () => {
      if (tab.dataset.category !== this._selectedCategory) {
        tab.style.background = 'none';
      }
    });
    tab.addEventListener('click', onClick || (() => {
      this._selectedCategory = category;
      this._renderSidebarActive();
      this._renderEntryList();
      this._selectFirstEntry();
    }));
    return tab;
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  /** @private Apply the panel-width responsive mode (3-column vs 2-pane swap). */
  _applyResponsiveLayout() {
    const panel = document.getElementById('codex-panel');
    const reading = document.getElementById('codex-reading');
    const middle = document.getElementById('codex-middle');
    if (!panel || !reading || !middle) return;
    const w = panel.getBoundingClientRect().width || panel.offsetWidth || 0;
    // Fall back to wide when width can't be measured (headless / not yet laid out).
    this._narrow = w > 0 && w < NARROW_BREAKPOINT;
    if (this._narrow) {
      // 2-pane swap: the middle list takes the remaining width; reading pane is
      // shown only when an entry is open (see _selectEntry / _showList).
      middle.style.width = 'auto';
      middle.style.maxWidth = 'none';
      middle.style.flex = '1';
      if (this._selectedEntry) {
        middle.style.display = 'none';
        reading.style.display = 'block';
      } else {
        middle.style.display = 'flex';
        reading.style.display = 'none';
      }
    } else {
      middle.style.width = '320px';
      middle.style.maxWidth = '340px';
      middle.style.flex = '0 0 auto';
      middle.style.display = 'flex';
      reading.style.display = 'block';
    }
  }

  /** @private Update header progress counter + overall progress bar */
  _renderHeader() {
    const prog = this._codex.getProgress();
    const el = document.getElementById('codex-progress');
    if (el) el.textContent = `${prog.unlocked}/${prog.total} briefings unlocked (${prog.percentage}%)`;
    const fill = document.getElementById('codex-progress-fill');
    if (fill) fill.style.width = `${prog.percentage}%`;
  }

  /** @private Highlight the active sidebar tab + refresh per-category counts */
  _renderSidebarActive() {
    const sidebar = document.getElementById('codex-sidebar');
    if (!sidebar) return;
    const tabs = sidebar.children;
    const active = this._selectedCategory;
    for (const tab of tabs) {
      const isSel = tab.dataset.category === active;
      const accent = tab.dataset.accent || '#00d4ff';
      const rgb = this._hexToRgb(accent);
      tab.style.borderLeftColor = isSel ? accent : 'transparent';
      tab.style.background = isSel ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.13)` : 'none';
      tab.style.color = isSel ? accent : '#aaa';

      // Per-category progress (e.g. "3/7"). Track tabs ("track:<id>") have no
      // category progress; show their entry count instead.
      const countEl = tab.querySelector('.codex-tab-count');
      if (countEl) {
        const cat = tab.dataset.category;
        if (cat.startsWith('track:')) {
          const tid = cat.slice('track:'.length);
          const track = (typeof this._codex.getTrack === 'function') ? this._codex.getTrack(tid) : null;
          const list = track ? track.entries : [];
          const unlocked = list.filter(e => e.unlocked).length;
          countEl.textContent = `${unlocked}/${list.length}`;
        } else if (cat === 'map:') {
          // Slice 8: the Map tab is an action, not a category — no progress badge.
          countEl.textContent = '';
        } else if (typeof this._codex.getCategoryProgress === 'function') {
          const p = this._codex.getCategoryProgress(cat);
          countEl.textContent = `${p.unlocked}/${p.total}`;
        }
        countEl.style.color = isSel ? accent : '#557';
      }
    }
  }

  /** @private Resolve the current list (search / track / category) with the
   * active filter+sort applied. Shared by the list and Prev/Next so they stay
   * in lockstep.
   * @returns {{ entries:Array<object>, isTrack:boolean }}
   */
  _currentListEntries() {
    let entries;
    let isTrack = false;
    if (this._searchQuery) {
      entries = (typeof this._codex.searchEntries === 'function')
        ? this._codex.searchEntries(this._searchQuery)
        : this._codex.entries.filter(e => entryMatchesQuery(e, this._searchQuery));
    } else if (this._selectedCategory && this._selectedCategory.startsWith('track:')) {
      isTrack = true;
      const tid = this._selectedCategory.slice('track:'.length);
      const track = (typeof this._codex.getTrack === 'function') ? this._codex.getTrack(tid) : null;
      entries = track ? track.entries : [];
    } else {
      entries = this._selectedCategory
        ? this._codex.getCategory(this._selectedCategory)
        : this._codex.entries;
    }
    return { entries: this._applyFilterSort(entries, isTrack), isTrack };
  }

  /** @private Render the compact entry list (dense rows). */
  _renderEntryList() {
    const listEl = document.getElementById('codex-entry-list');
    if (!listEl) return;

    const { entries, isTrack } = this._currentListEntries();

    listEl.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { color: '#667', fontSize: '13px', padding: '18px 14px' });
      empty.textContent = this._searchQuery
        ? `No topics match “${this._searchQuery}”.`
        : 'No topics match the current filter.';
      listEl.appendChild(empty);
    }
    entries.forEach((entry, i) => listEl.appendChild(this._makeRow(entry, i)));

    // Keep the roving-focus index within bounds of the freshly-rendered list.
    if (this._selectedEntry) {
      const sel = entries.findIndex(e => e.id === this._selectedEntry.id);
      this._focusIdx = sel >= 0 ? sel : (entries.length ? 0 : -1);
    } else {
      this._focusIdx = entries.length ? 0 : -1;
    }
    this._applyRowFocus();

    this._renderSidebarActive();
    this._renderFilterBar(isTrack);
  }

  /** @private Highlight the active/selected + keyboard-focused list row. */
  _applyRowFocus() {
    const listEl = document.getElementById('codex-entry-list');
    if (!listEl) return;
    const rows = listEl.querySelectorAll('.codex-row');
    rows.forEach((row, i) => {
      const isFocus = i === this._focusIdx;
      row.style.background = isFocus ? row.dataset.selBg : 'transparent';
      row.style.borderLeftColor = isFocus ? row.dataset.accent : 'transparent';
      if (isFocus && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /** @private Create a single compact entry row.
   * Reveal model (UX-11 #10): title + icon + one-liner are ALWAYS visible — the
   * library is a syllabus. Locked rows read as "not yet detailed": dimmed + 🔒.
   */
  _makeRow(entry, index) {
    const row = document.createElement('div');
    row.className = 'codex-row';
    row.dataset.id = entry.id;

    const isLocked = !entry.unlocked;
    const isNew = entry.unlocked && !entry.seen;

    const catMeta = this._catMeta(entry.category);
    const accent = catMeta.color || '#00d4ff';
    const rgb = this._hexToRgb(accent);
    const selBg = `rgba(${rgb.r},${rgb.g},${rgb.b},0.13)`;
    row.dataset.accent = accent;
    row.dataset.selBg = selBg;

    Object.assign(row.style, {
      display: 'flex', alignItems: 'flex-start', gap: '9px',
      padding: '8px 12px', cursor: 'pointer',
      borderLeft: '3px solid transparent', transition: 'background 0.12s ease',
    });

    const pip = isNew
      ? `<span title="new" style="flex-shrink:0;align-self:center;font-size:9px;font-weight:bold;color:${accent};letter-spacing:0.06em;text-shadow:0 0 6px ${accent};">NEW</span>`
      : (isLocked
        ? `<span title="locked" style="flex-shrink:0;align-self:center;font-size:12px;color:#667;">🔒</span>`
        : '');

    row.innerHTML = `
      <span style="font-size:17px;flex-shrink:0;line-height:1.3;${isLocked ? 'opacity:0.6;' : ''}">${entry.icon}</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-size:13px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${entry.title}</span>
        <span style="display:block;font-size:11px;line-height:1.35;color:#889;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:${isLocked ? 0.6 : 0.85};">${entry.shortText}</span>
      </span>
      ${pip}
    `;

    row.addEventListener('mouseenter', () => {
      if (index !== this._focusIdx) {
        const r = this._hexToRgb(accent);
        row.style.background = `rgba(${r.r},${r.g},${r.b},0.06)`;
      }
    });
    row.addEventListener('mouseleave', () => {
      if (index !== this._focusIdx) row.style.background = 'transparent';
    });
    row.addEventListener('click', () => {
      this._selectEntry(entry, { focusPane: this._narrow });
    });
    return row;
  }

  /** @private Auto-select an entry so the reading pane is never empty on open.
   * Normally lands on the first list entry; when a deep-link set `_pendingOpenId`
   * (openEntry), routes straight to that entry — even in narrow mode, where a
   * deep-link should open the reading pane rather than sit on the list. */
  _selectFirstEntry() {
    // Slice 8: category/track/search switches drop out of map mode.
    this._mapMode = false;
    const { entries } = this._currentListEntries();
    if (!entries.length) {
      this._selectedEntry = null;
      this._clearSeenTimer();
      this._renderEmptyReading();
      return;
    }
    // Deep-link routing: open the requested entry directly. In narrow mode the
    // deep-link intentionally opens the pane (focusPane), unlike a plain open.
    if (this._pendingOpenId) {
      const target = entries.find(e => e.id === this._pendingOpenId)
        || (this._codex.getEntry ? this._codex.getEntry(this._pendingOpenId) : null);
      if (target) {
        this._selectEntry(target, { focusPane: this._narrow });
        return;
      }
    }
    if (this._narrow) {
      // Narrow: show the list first; don't auto-open a reading pane.
      this._selectedEntry = null;
      this._clearSeenTimer();
      this._applyResponsiveLayout();
      return;
    }
    this._selectEntry(entries[0], { focusPane: false });
  }

  /** @private After a filter/sort change (same selection context), keep the
   * current reading position if the selected entry survives the new list;
   * otherwise fall back to the first entry. Category/track switches still jump
   * to first via _selectFirstEntry directly. */
  _reselectAfterListChange() {
    const { entries } = this._currentListEntries();
    if (this._selectedEntry && entries.some(e => e.id === this._selectedEntry.id)) {
      // Selection survived: _renderEntryList already recomputed _focusIdx +
      // applied row focus. Nothing else to do (don't re-arm the seen timer).
      return;
    }
    this._selectFirstEntry();
  }

  /** @private Select an entry: update focus, render its reading pane, and (in
   * narrow mode) swap the list out for the pane.
   * @param {object} entry
   * @param {{focusPane?:boolean}} [opts]
   */
  _selectEntry(entry, opts = {}) {
    if (!entry) return;
    // Slice 8: any fresh selection returns to the article (exits map mode).
    this._mapMode = false;
    this._selectedEntry = entry;
    const { entries } = this._currentListEntries();
    const idx = entries.findIndex(e => e.id === entry.id);
    // Fix #6: if the entry isn't in the current list (e.g. a RELATED chip jumped
    // to an entry filtered out by "Unlocked"), clear the roving index so
    // _applyRowFocus lights no row instead of a stale/wrong one.
    this._focusIdx = idx >= 0 ? idx : -1;
    this._applyRowFocus();
    this._renderReading(entry);
    // Seen dwell: (re)arm the timer for the newly-rested selection. Scrubbing
    // to another entry before it fires cancels the pending emit.
    this._armSeenTimer(entry);
    if (this._narrow) {
      this._applyResponsiveLayout(); // hides the list, shows the pane
    }
    if (opts.focusPane) {
      const reading = document.getElementById('codex-reading');
      if (reading && typeof reading.focus === 'function') { try { reading.focus(); } catch (_) {} }
    }
  }

  /** @private Test seam: swap the timer scheduler/canceller for spies.
   * @param {(fn:Function, ms:number)=>*} schedule
   * @param {(handle:*)=>void} cancel
   */
  _setSeenTimerHooks(schedule, cancel) {
    if (typeof schedule === 'function') this._scheduleSeen = schedule;
    if (typeof cancel === 'function') this._cancelSeen = cancel;
  }

  /** @private Arm the seen-dwell timer for a rested selection. Clears any
   * pending handle first (selection changed → previous dwell is void). Only
   * unlocked, unseen entries arm; locked / already-seen entries never do.
   * @param {object} entry
   */
  _armSeenTimer(entry) {
    this._clearSeenTimer();
    if (!entry || !entry.unlocked || entry.seen) return;
    const id = entry.id;
    this._seenTimer = this._scheduleSeen(() => {
      this._seenTimer = null;
      eventBus.emit(Events.CODEX_VIEWED, { id });
    }, SEEN_DWELL_MS);
  }

  /** @private Cancel any pending seen-dwell emit (selection change / hide). */
  _clearSeenTimer() {
    if (this._seenTimer != null) {
      this._cancelSeen(this._seenTimer);
      this._seenTimer = null;
    }
  }

  /** @private In narrow mode, return from the reading pane to the list. */
  _showList() {
    if (!this._narrow) return;
    this._selectedEntry = null;
    this._clearSeenTimer();
    this._applyResponsiveLayout();
    this._applyRowFocus();
  }

  /** @private Apply the locked/unlocked filter and the sort order.
   * A learning path ("track") is authored as an ordered narrative, so its
   * sequence is always preserved — the sort control is suppressed for tracks
   * (see _renderFilterBar) and ignored here.
   * @param {Array<object>} entries
   * @param {boolean} [isTrack=false] keep the authored order, ignoring _sort
   * @returns {Array<object>}
   */
  _applyFilterSort(entries, isTrack = false) {
    let out = entries;
    if (this._filter === 'unlocked') out = out.filter(e => e.unlocked);
    else if (this._filter === 'locked') out = out.filter(e => !e.unlocked);

    // Tracks keep their authored trackOrder regardless of the sort selection.
    if (isTrack) return out;

    if (this._sort === 'az') {
      out = out.slice().sort((a, b) => a.title.localeCompare(b.title));
    } else if (this._sort === 'trl') {
      // Highest readiness first; non-tech (null TRL) sinks to the end.
      out = out.slice().sort((a, b) => {
        const at = (typeof a.trl === 'number') ? a.trl : -1;
        const bt = (typeof b.trl === 'number') ? b.trl : -1;
        return bt - at;
      });
    }
    // 'default': category order — leave as-is.
    return out;
  }

  /** @private Build the filter/sort bar controls (once). */
  _buildFilterBar(bar) {
    const mkGroup = (label, key, opts) => {
      const wrap = document.createElement('span');
      wrap.className = 'codex-fs-group';
      wrap.dataset.group = key;
      Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '5px' });
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.color = '#667';
      wrap.appendChild(lbl);
      for (const o of opts) {
        const btn = document.createElement('span');
        btn.className = 'codex-fs-btn';
        btn.dataset.group = key;
        btn.dataset.value = o.value;
        btn.textContent = o.label;
        Object.assign(btn.style, {
          cursor: 'pointer', padding: '2px 7px', borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.12)', color: '#9ab',
          transition: 'all 0.15s', userSelect: 'none',
        });
        btn.addEventListener('click', () => {
          if (key === 'filter') this._filter = o.value;
          else this._sort = o.value;
          this._renderEntryList();
          // Preserve reading position across a filter/sort change when the
          // current selection survives the new list; only jump to first if it
          // was filtered out (or nothing was selected).
          this._reselectAfterListChange();
        });
        wrap.appendChild(btn);
      }
      return wrap;
    };

    bar.appendChild(mkGroup('Show', 'filter', [
      { value: 'all', label: 'All' },
      { value: 'unlocked', label: 'Unlocked' },
      { value: 'locked', label: 'Locked' },
    ]));
    bar.appendChild(mkGroup('Sort', 'sort', [
      { value: 'default', label: 'Default' },
      { value: 'az', label: 'A–Z' },
      { value: 'trl', label: 'Readiness' },
    ]));
  }

  /** @private Reflect current _filter/_sort selection on the bar's buttons.
   * @param {boolean} [isTrack=false] hide the Sort group for learning paths.
   */
  _renderFilterBar(isTrack = false) {
    const bar = document.getElementById('codex-filter-bar');
    if (!bar) return;
    bar.style.display = 'flex';
    bar.querySelectorAll('.codex-fs-group').forEach(g => {
      if (g.dataset.group === 'sort') g.style.display = isTrack ? 'none' : 'inline-flex';
    });
    bar.querySelectorAll('.codex-fs-btn').forEach(btn => {
      const active = (btn.dataset.group === 'filter')
        ? this._filter === btn.dataset.value
        : this._sort === btn.dataset.value;
      btn.style.background = active ? 'rgba(0,212,255,0.18)' : 'none';
      btn.style.borderColor = active ? 'rgba(0,212,255,0.5)' : 'rgba(255,255,255,0.12)';
      btn.style.color = active ? '#cfefff' : '#9ab';
    });
  }

  /** @private Render an empty-state reading pane (no entry selected). */
  _renderEmptyReading() {
    const reading = document.getElementById('codex-reading');
    if (!reading) return;
    reading.innerHTML = `
      <div style="max-width:700px;margin:0 auto;color:#667;font-size:14px;
        padding:40px 0;text-align:center;font-style:italic;">
        ${this._searchQuery ? `No topics match “${this._searchQuery}”.` : 'Select a topic to read its briefing.'}
      </div>`;
  }

  /** @private Render the persistent reading pane for an entry.
   * Sections top→bottom: QUICK LOOK → BRIEFING → TECH LEVEL (trl<9) →
   * IN THE REAL WORLD → FORMULA → RELATED → prev/next. Locked entries show only
   * QUICK LOOK + the how-to-unlock panel.
   */
  _renderReading(entry) {
    const reading = document.getElementById('codex-reading');
    if (!reading) return;

    const isLocked = !entry.unlocked;

    const catMeta = this._catMeta(entry.category);
    const accent = catMeta.color || '#00d4ff';
    const accentRGB = this._hexToRgb(accent);
    const accentBg = (a) => `rgba(${accentRGB.r},${accentRGB.g},${accentRGB.b},${a})`;

    // Slice 8 — ego-map mode short-circuits the article and renders the SVG
    // connections map instead. Unlocked entries only (map mode is never armed
    // for locked ones; guard anyway so a stray toggle can't strand the pane).
    if (this._mapMode && entry.unlocked) {
      this._renderEgoMap(entry, { accent, accentBg });
      return;
    }

    const sectionHeader = (text, color) =>
      `<div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;
        color:${color || '#778'};margin:0 0 8px;">${text}</div>`;

    // In narrow mode, offer a Back affordance to return to the list.
    const backHtml = this._narrow
      ? `<div id="codex-back-btn" style="cursor:pointer;color:#00d4ff;font-size:13px;margin-bottom:16px;
          display:inline-block;padding:5px 12px;border:1px solid rgba(0,212,255,0.2);border-radius:3px;
          transition:background 0.15s;">← Back to list</div>`
      : '';

    // Title header
    const titleHtml = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
        <span style="font-size:40px;${isLocked ? 'opacity:0.6;' : ''}">${entry.icon}</span>
        <div style="flex:1;">
          <div style="font-size:22px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};">${entry.title}</div>
          <div style="font-size:12px;color:${accent};opacity:0.85;">${catMeta.icon} ${catMeta.label}</div>
        </div>
        ${entry.unlocked ? this._mapToggleHtml('🕸 MAP', accent, accentBg) : ''}
      </div>`;

    // QUICK LOOK — the ELI5 lead, always shown (even when locked).
    const quickLookHtml = `
      <div style="margin-bottom:22px;">
        ${sectionHeader('QUICK LOOK', accent)}
        <div style="font-size:16px;color:#aaddff;line-height:1.6;
          padding:12px 16px;background:${accentBg(0.06)};border-left:3px solid ${accentBg(0.5)};
          border-radius:2px;">${decorateGlossary(entry.shortText, { once: true })}</div>
      </div>`;

    // TECH LEVEL — only when the tech is not yet flight-proven (trl<9).
    const dTrl = entry.trl;
    let trlHtml = '';
    if (typeof dTrl === 'number' && dTrl < Constants.TRL.FLIGHT_PROVEN_MIN) {
      const col = trlToBadgeColor(dTrl, Constants.TRL);
      const lbl = trlToLabel(dTrl, Constants.TRL);
      const rat = (!isLocked && entry.trlRationale) ? entry.trlRationale : '';
      trlHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('⚠ TECH LEVEL', col)}
          <div title="Tech Level (real-world readiness) ${dTrl}. ${lbl}"
               style="display:flex;align-items:center;gap:10px;
                      padding:8px 12px;border:1px solid ${col};border-radius:3px;
                      background:rgba(0,0,0,0.35);font-size:13px;${isLocked ? 'opacity:0.7;' : ''}">
            <span style="font-weight:bold;letter-spacing:0.05em;color:${col};
                         padding:2px 8px;border:1px solid ${col};border-radius:2px;
                         background:rgba(0,0,0,0.35);">${techLevelBadgeText(dTrl)}</span>
            <span style="color:${col};font-weight:bold;letter-spacing:0.04em;">${lbl}</span>
            ${rat ? `<span style="color:#888;font-style:italic;flex:1;">${rat}</span>` : ''}
            ${isLocked ? '<span style="color:#667;font-style:italic;flex:1;text-align:right;">🔒 details locked</span>' : ''}
          </div>
        </div>`;
    }

    // BRIEFING (fullText) — unlocked only; locked shows the how-to-unlock panel.
    const hint = entry.unlockHint || 'Discover through gameplay.';
    let briefingHtml;
    if (isLocked) {
      briefingHtml = `
        <div style="margin-bottom:22px;">
          <div style="font-size:13px;color:#ffaa00;line-height:1.6;
            padding:10px 14px;border:1px dashed rgba(255,170,0,0.4);border-radius:3px;">
            🔒 <b>How to unlock:</b> ${hint}
          </div>
          <div style="font-size:14px;color:#667;font-style:italic;line-height:1.6;margin-top:12px;">
            Full briefing unlocks when you encounter this in flight.
          </div>
        </div>`;
    } else {
      briefingHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('BRIEFING')}
          <div style="font-size:15px;color:#ccc;line-height:1.8;white-space:pre-wrap;">${decorateGlossary(entry.fullText, { once: true })}</div>
          ${this._verifiedStampHtml(entry)}
        </div>`;
    }

    // IN THE REAL WORLD + FORMULA — unlocked depth only.
    let realWorldHtml = '';
    let formulaHtml = '';
    if (!isLocked) {
      if (entry.realWorld) {
        realWorldHtml = `
          <div style="margin-bottom:22px;">
            ${sectionHeader('🌍 IN THE REAL WORLD', accent)}
            <div style="padding:12px 16px;border-radius:4px;
              background:${accentBg(0.06)};border:1px solid ${accentBg(0.25)};
              font-size:14px;color:#cde;line-height:1.6;">${decorateGlossary(entry.realWorld, { once: true })}</div>
          </div>`;
      }
      if (entry.formula) {
        formulaHtml = `
          <div style="margin-bottom:22px;">
            ${sectionHeader('ƒ FORMULA')}
            <div style="padding:10px 14px;border-radius:4px;
              background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.12);
              font-size:15px;color:#e8f4ff;letter-spacing:0.02em;
              font-family:'Courier New',monospace;overflow-x:auto;">${entry.formula}</div>
          </div>`;
      }
    }

    // RELATED — clickable chips (locked relateds still navigate).
    const related = (typeof this._codex.getRelated === 'function')
      ? this._codex.getRelated(entry.id)
      : [];
    let relatedHtml = '';
    if (related.length) {
      const chips = related.map(r => this._relatedChipHtml(r.id, !r.unlocked, accentBg,
        `<span>${r.icon}</span>${r.title}${!r.unlocked ? ' 🔒' : ''}`)).join('');
      relatedHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('🔗 RELATED')}
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>
        </div>`;
    }

    // Prev/Next within the current list.
    const siblings = this._currentListEntries().entries;
    const idx = siblings.findIndex(e => e.id === entry.id);
    const prev = idx > 0 ? siblings[idx - 1] : null;
    const next = (idx >= 0 && idx < siblings.length - 1) ? siblings[idx + 1] : null;
    const navBtn = (e, label, align) => e
      ? `<span class="codex-nav-btn" data-id="${e.id}"
          style="cursor:pointer;color:${accent};font-size:13px;padding:6px 12px;
            border:1px solid ${accentBg(0.25)};border-radius:3px;transition:background 0.15s;
            text-align:${align};max-width:48%;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;">${label}</span>`
      : '<span></span>';
    const prevNextHtml = (prev || next)
      ? `<div style="display:flex;justify-content:space-between;gap:10px;
           margin-top:8px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);">
           ${navBtn(prev, `← ${prev ? prev.title : ''}`, 'left')}
           ${navBtn(next, `${next ? next.title : ''} →`, 'right')}
         </div>`
      : '';

    reading.innerHTML = `
      <div style="max-width:700px;margin:0 auto;">
        ${backHtml}
        ${entry.unlocked ? this._completionBannerHtml(entry, accent) : ''}
        ${titleHtml}
        ${quickLookHtml}
        ${briefingHtml}
        ${trlHtml}
        ${realWorldHtml}
        ${formulaHtml}
        ${relatedHtml}
        ${entry.unlocked ? this._verifiedStampHtml(entry) : ''}
        ${entry.unlocked ? this._loggedLineHtml(entry) : ''}
        ${entry.unlocked ? this._curiousNextHtml(entry, { accent, accentBg }) : ''}
        ${prevNextHtml}
      </div>
    `;

    // Inline-glossary affordances inside the library itself.
    ensureGlossaryCss();
    delegateGlossaryClicks(reading);

    // Back button (narrow mode)
    const backBtn = reading.querySelector('#codex-back-btn');
    if (backBtn) {
      backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'rgba(0,212,255,0.1)'; });
      backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none'; });
      backBtn.addEventListener('click', () => this._showList());
    }

    // Slice 8 — MAP toggle: enter ego-map mode for this entry.
    const mapToggle = reading.querySelector('#codex-map-toggle');
    if (mapToggle) {
      mapToggle.addEventListener('mouseenter', () => { mapToggle.style.background = accentBg(0.15); });
      mapToggle.addEventListener('mouseleave', () => { mapToggle.style.background = ''; });
      const enterMap = () => this._enterMapMode(entry);
      mapToggle.addEventListener('click', enterMap);
      mapToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterMap(); }
      });
    }

    // Related chips + Prev/Next: jump straight to another entry.
    const jumpTo = (id) => {
      const target = this._codex.getEntry ? this._codex.getEntry(id) : null;
      if (!target) return;
      if (target.category !== this._selectedCategory && !this._searchQuery) {
        this._selectedCategory = target.category;
        this._renderSidebarActive();
        this._renderEntryList();
      }
      reading.scrollTop = 0;
      this._selectEntry(target);
    };
    reading.querySelectorAll('.codex-related-chip, .codex-nav-btn').forEach(el => {
      el.addEventListener('mouseenter', () => { el.style.background = accentBg(0.18); });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', () => jumpTo(el.dataset.id));
    });
  }

  /** @private VERIFIED micro-stamp for entries carrying a lastVerified date. */
  _verifiedStampHtml(entry) {
    const lv = entry.lastVerified;
    if (!lv || typeof lv !== 'string') return '';
    return `<div style="margin-top:10px;font-size:10px;letter-spacing:0.1em;
      color:#566;">VERIFIED ${lv}</div>`;
  }

  /** @private LOGGED anchor stamp: when/where this entry was first unlocked,
   * e.g. "LOGGED  T+02:14 · 782 km" (Slice 7). Empty for entries with no
   * captured unlock context (startUnlocked / reference / pre-Slice-7 saves). */
  _loggedLineHtml(entry) {
    const c = entry && entry.unlockContext;
    if (!c || typeof c !== 'object' || !Number.isFinite(c.tSim)) return '';
    const t = Math.max(0, Math.floor(c.tSim));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const clock = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
    const alt = Number.isFinite(c.altKm) ? ` · ${c.altKm} km` : '';
    return `<div style="margin-top:6px;font-size:10px;letter-spacing:0.1em;
      color:#566;">LOGGED  T+${clock}${alt}</div>`;
  }

  /** @private Completion banner shown when the entry's category is 100%
   * unlocked (Slice 7). Subtle, category-accent tinted, no reward grammar. */
  _completionBannerHtml(entry, accent) {
    if (!entry || !this._codex || typeof this._codex.getCategoryProgress !== 'function') return '';
    const p = this._codex.getCategoryProgress(entry.category);
    if (!p || p.total === 0 || p.unlocked < p.total) return '';
    const meta = (typeof this._codex.getCategoryMeta === 'function') ? this._codex.getCategoryMeta(entry.category) : null;
    const label = (meta && meta.label) || entry.category;
    const c = this._hexToRgb(accent || '#00d4ff');
    const tint = (a) => `rgba(${c.r},${c.g},${c.b},${a})`;
    return `<div style="margin:0 0 14px;padding:8px 12px;border-radius:6px;
      background:${tint(0.12)};border:1px solid ${tint(0.35)};
      font-size:11px;letter-spacing:0.08em;color:${accent || '#00d4ff'};">✓ ${label} — FILE COMPLETE</div>`;
  }

  /** @private Slice 8 — the map/read toggle pill, shared by the article header
   * (🕸 MAP) and the map header (📖 READ) so their styling never drifts. The two
   * render paths are mutually exclusive full-innerHTML replaces, so the shared
   * `codex-map-toggle` id never collides at runtime.
   * @param {string} label
   * @param {string} accent
   * @param {(a:number)=>string} accentBg
   * @returns {string}
   */
  _mapToggleHtml(label, accent, accentBg) {
    return `<span id="codex-map-toggle" tabindex="0" role="button"
      style="cursor:pointer;flex-shrink:0;color:${accent};font-size:12px;padding:6px 12px;
        border:1px solid ${accentBg(0.35)};border-radius:14px;transition:background 0.15s;
        white-space:nowrap;">${label}</span>`;
  }

  /** @private Slice 8 — "Curious next?" chips at the reading-pane foot. Up to 2,
   * chosen deterministically from `entry.related` in array order: locked entries
   * first (rendered as a question from the unlock hint), then unlocked-but-unseen.
   * Reuses the `.codex-related-chip` markup so click delegation keeps working.
   * Empty when nothing qualifies. Callers gate on `entry.unlocked`.
   * @param {object} entry
   * @param {{accent:string, accentBg:(a:number)=>string}} theme
   * @returns {string}
   */
  _curiousNextHtml(entry, { accent, accentBg }) {
    if (!entry || !entry.unlocked) return '';
    const related = (typeof this._codex.getRelated === 'function')
      ? (this._codex.getRelated(entry.id) || [])
      : [];
    if (!related.length) return '';

    const locked = related.filter(r => r && !r.unlocked);
    const unseen = related.filter(r => r && r.unlocked && !r.seen);
    // Locked prompts first, then unlocked-but-unread; array order preserved
    // within each group. Cap at 2 total.
    const picks = [];
    for (const r of locked) { if (picks.length >= 2) break; picks.push({ r, kind: 'locked' }); }
    for (const r of unseen) { if (picks.length >= 2) break; picks.push({ r, kind: 'unseen' }); }
    if (!picks.length) return '';

    const chips = picks.map(({ r, kind }) => {
      const hint = r.unlockHint || 'Discover through gameplay.';
      const text = (kind === 'locked')
        ? `What's behind 🔒 ${r.title}? — ${hint}`
        : `Haven't read ${r.title} yet — it's in your library.`;
      const inner = `<span>${r.icon || '📄'}</span><span>${text}</span>`;
      return this._relatedChipHtml(r.id, kind === 'locked', accentBg, inner,
        'gap:6px;padding:7px 12px;line-height:1.4;');
    }).join('');

    return `<div style="margin-top:18px;">
      <div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;color:${accent};
        margin:0 0 8px;">CURIOUS NEXT?</div>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;">${chips}</div>
    </div>`;
  }

  /** @private Slice 8 — shared clickable `.codex-related-chip` markup used by
   * both the RELATED section and the CURIOUS NEXT chips, so the chip's
   * border/background/color affordance never drifts between them. The class +
   * data-id keep click delegation working (jumpTo). `inner` is the pre-built
   * chip contents; `extraStyle` overrides gap/padding/line-height per caller.
   * @param {string} id
   * @param {boolean} locked
   * @param {(a:number)=>string} accentBg
   * @param {string} inner
   * @param {string} [extraStyle]
   * @returns {string}
   */
  _relatedChipHtml(id, locked, accentBg, inner, extraStyle = 'gap:5px;padding:5px 11px;') {
    return `<span class="codex-related-chip" data-id="${id}"
      style="display:inline-flex;align-items:center;cursor:pointer;
        border-radius:14px;font-size:12px;${extraStyle}
        border:1px solid ${locked ? 'rgba(255,255,255,0.14)' : accentBg(0.4)};
        background:${locked ? 'rgba(255,255,255,0.03)' : accentBg(0.08)};
        color:${locked ? '#89a' : '#cde'};transition:all 0.15s;">${inner}</span>`;
  }

  /** @private Slice 8 — enter ego-map mode focused on `entry`. Sets the map
   * focus id, flips `_mapMode`, and re-renders the reading pane as the SVG map.
   * Does NOT go through `_selectEntry` (which would exit map mode and re-arm the
   * seen-dwell timer). @param {object} entry */
  _enterMapMode(entry) {
    if (!entry || !entry.unlocked) return;
    this._mapMode = true;
    this._mapFocusId = entry.id;
    this._renderReading(entry);
  }

  /** @private Slice 8 — re-center the map on a node without leaving map mode.
   * Cheap: only recomputes the layout and re-renders the SVG (no scaffolding
   * rebuild, no dwell timer). @param {string} id */
  _recenterMap(id) {
    const target = (typeof this._codex.getEntry === 'function') ? this._codex.getEntry(id) : null;
    if (!target || !target.unlocked) return;
    this._mapFocusId = id;
    // Re-render via the focus entry; _mapMode is still true so _renderReading
    // routes back into _renderEgoMap.
    this._renderReading(target);
  }

  /** @private Slice 8 — render the reading pane as an SVG ego-map for `entry`.
   * Single-click a node → re-center (stay in map); dblclick / Enter → openEntry
   * (exits map). Nodes are focusable for Enter. Locked nodes dimmed with 🔒 and
   * a visible title. No physics/pan/zoom.
   * @param {object} entry
   * @param {{accent:string, accentBg:(a:number)=>string}} theme
   */
  _renderEgoMap(entry, { accent, accentBg }) {
    const reading = document.getElementById('codex-reading');
    if (!reading) return;

    const focusId = this._mapFocusId || entry.id;
    const { nodes, edges } = layoutEgoMap({
      focusId,
      getEntry: (id) => (this._codex.getEntry ? this._codex.getEntry(id) : null),
      getRelated: (id) => (this._codex.getRelated ? this._codex.getRelated(id) : []),
    });

    const VW = EGO_LAYOUT_VIEW.width;
    const VH = EGO_LAYOUT_VIEW.height;

    // Edges under nodes.
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edgeSvg = edges.map(e => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      const dim = (b.ring === 2) ? 0.18 : 0.4;
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"
        x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
        stroke="${accentBg(dim)}" stroke-width="${b.ring === 2 ? 1 : 1.5}" />`;
    }).join('');

    const nodeSvg = nodes.map(n => {
      const isFocus = n.ring === 0;
      const r = isFocus ? 34 : (n.ring === 1 ? 26 : 20);
      const op = n.ring === 2 ? 0.35 : 1;
      const stroke = isFocus ? accent : (n.locked ? '#556' : accentBg(0.6));
      const fill = isFocus ? accentBg(0.18) : 'rgba(10,14,20,0.9)';
      const iconSize = isFocus ? 26 : (n.ring === 1 ? 20 : 16);
      const labelY = n.y + r + 16;
      const label = `${n.locked ? '🔒 ' : ''}${n.title}`;
      const labelColor = n.locked ? '#89a' : (isFocus ? '#eee' : '#bcd');
      const cursor = isFocus ? 'default' : 'pointer';
      return `<g class="codex-map-node" data-id="${n.id}" data-ring="${n.ring}"
        tabindex="0" style="cursor:${cursor};outline:none;" opacity="${op}">
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}"
          fill="${fill}" stroke="${stroke}" stroke-width="${isFocus ? 2.5 : 1.5}"
          ${n.locked ? 'stroke-dasharray="4 3"' : ''} />
        <text x="${n.x.toFixed(1)}" y="${(n.y + iconSize * 0.35).toFixed(1)}"
          text-anchor="middle" font-size="${iconSize}"
          ${n.locked ? 'opacity="0.6"' : ''}>${n.icon}</text>
        <text x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle"
          font-size="12" fill="${labelColor}"
          style="font-family:inherit;">${label}</text>
      </g>`;
    }).join('');

    reading.innerHTML = `
      <div style="max-width:100%;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
          <div style="flex:1;">
            <div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;color:${accent};">CONNECTIONS</div>
            <div style="font-size:16px;font-weight:bold;color:#eee;">${entry.icon} ${entry.title}</div>
            <div style="font-size:11px;color:#889;margin-top:2px;">Click a node to re-center · double-click or Enter to open</div>
          </div>
          ${this._mapToggleHtml('📖 READ', accent, accentBg)}
        </div>
        <svg viewBox="0 0 ${VW} ${VH}" width="100%"
          style="display:block;max-height:70vh;background:rgba(0,0,0,0.25);
            border:1px solid ${accentBg(0.2)};border-radius:6px;"
          preserveAspectRatio="xMidYMid meet">
          <g>${edgeSvg}</g>
          <g>${nodeSvg}</g>
        </svg>
      </div>`;

    // READ toggle returns to the article (re-selects the focus entry, which
    // clears _mapMode and re-arms the seen timer as a normal read).
    const readToggle = reading.querySelector('#codex-map-toggle');
    if (readToggle) {
      readToggle.addEventListener('mouseenter', () => { readToggle.style.background = accentBg(0.15); });
      readToggle.addEventListener('mouseleave', () => { readToggle.style.background = ''; });
      const exit = () => { this._mapMode = false; this._selectEntry(entry); };
      readToggle.addEventListener('click', exit);
      readToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exit(); }
      });
    }

    // Node interactions: single-click re-centers (non-focus); dblclick/Enter opens.
    reading.querySelectorAll('.codex-map-node').forEach(g => {
      const id = g.dataset.id;
      const isFocus = g.dataset.ring === '0';
      if (!isFocus) {
        g.addEventListener('click', () => this._recenterMap(id));
      }
      g.addEventListener('dblclick', () => this.openEntry(id));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.openEntry(id); }
      });
    });
  }

  /** @private Parse a #rrggbb (or #rgb) hex colour to {r,g,b}; defaults to the
   * codex cyan if the input is malformed. Used for category-accent tinting. */
  _hexToRgb(hex) {
    const fallback = { r: 0, g: 212, b: 255 };
    if (typeof hex !== 'string') return fallback;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return fallback;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // Keyboard handling while the codex is open (capture phase, so it runs
    // before InputManager's codex intercept). ESC always closes; ↑/↓ move the
    // list selection AND the reading pane; Enter focuses the pane; / focuses
    // search. Typing in the search box is left alone.
    window.addEventListener('keydown', (e) => {
      if (!this._visible) return;
      const tgt = e.target;
      const inSearch = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA');

      // ESC while typing in the search box: blur the field (don't close).
      if (e.code === 'Escape' && inSearch) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (typeof tgt.blur === 'function') tgt.blur();
        return;
      }

      if (e.code === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        // Narrow mode with the reading pane open: ESC returns to the list.
        // Otherwise ESC closes the viewer.
        if (this._narrow && this._selectedEntry) {
          this._showList();
        } else {
          this.hide();
        }
        return;
      }

      if (inSearch) return; // don't hijack typing

      // '/' focuses the search box.
      if (e.code === 'Slash') {
        e.stopImmediatePropagation(); e.preventDefault();
        const input = document.getElementById('codex-search');
        if (input && typeof input.focus === 'function') input.focus();
        return;
      }

      // ↑/↓ move the list selection and re-render the reading pane (reading
      // follows selection). ←/→ step prev/next. Enter focuses the pane. Home/End
      // jump to list ends.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End', 'Backspace'].includes(e.code)) {
        e.stopImmediatePropagation(); e.preventDefault();
        this._handleListKey(e.code);
      }
    }, true);

    // Re-render when new entry unlocked (player might have codex open)
    eventBus.on(Events.CODEX_UNLOCKED, () => {
      if (this._visible) {
        this._renderHeader();
        this._renderEntryList();
      }
    });

    // Debounced resize: re-evaluate the 3-column ⇄ 2-pane breakpoint while open.
    // On a mode flip with an entry selected, re-render the reading pane so the
    // "← Back to list" affordance appears/disappears (it's only emitted while
    // _narrow at render time).
    window.addEventListener('resize', () => {
      if (!this._visible) return;
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        this._resizeDebounce = null;
        if (!this._visible) return;
        this._onResize();
      }, 150);
    });
  }

  /** @private Handle a settled window resize while the viewer is open. */
  _onResize() {
    const wasNarrow = this._narrow;
    this._applyResponsiveLayout();
    if (this._narrow !== wasNarrow && this._selectedEntry) {
      // Back-button affordance is narrow-only and baked in at render time.
      this._renderReading(this._selectedEntry);
    }
  }

  /** @private Keyboard navigation over the compact list + reading pane. */
  _handleListKey(code) {
    const { entries } = this._currentListEntries();
    if (!entries.length) return;

    // Backspace in narrow mode returns to the list.
    if (code === 'Backspace') {
      if (this._narrow && this._selectedEntry) this._showList();
      return;
    }

    // Enter focuses the reading pane (accessibility: move reading focus off the
    // list). In narrow mode, ensure the pane is shown.
    if (code === 'Enter') {
      if (this._focusIdx >= 0 && this._focusIdx < entries.length) {
        this._selectEntry(entries[this._focusIdx], { focusPane: true });
      }
      return;
    }

    let idx = this._focusIdx < 0 ? 0 : this._focusIdx;
    switch (code) {
      case 'ArrowUp':
      case 'ArrowLeft':  idx = Math.max(0, idx - 1); break;
      case 'ArrowDown':
      case 'ArrowRight': idx = Math.min(entries.length - 1, idx + 1); break;
      case 'Home':       idx = 0; break;
      case 'End':        idx = entries.length - 1; break;
      default: break;
    }
    this._focusIdx = idx;
    // Reading follows selection (in wide mode). In narrow mode, keep the list
    // visible while arrowing; only open the pane on Enter/click.
    if (this._narrow) {
      this._applyRowFocus();
    } else {
      this._selectEntry(entries[idx]);
    }
  }
}

export default CodexViewerUI;
