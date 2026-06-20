/**
 * CodexViewerUI.js — DOM overlay modal for browsing the codex entries.
 * Toggle with I key ("Info"). Escape closes.
 *
 * Layout: full-screen overlay → centered panel with category sidebar + entry grid/detail.
 * @module ui/CodexViewerUI
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { entryMatchesQuery, ALIASES } from '../systems/CodexSystem.js';
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
    /** @type {'all'|'unlocked'|'locked'} list filter (Phase 3 filter bar) */
    this._filter = 'all';
    /** @type {'default'|'az'|'trl'} list sort order (Phase 3 sort bar) */
    this._sort = 'default';
    /** @type {number} roving-focus index into the current grid (keyboard nav) */
    this._focusIdx = -1;

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

  /**
   * Deep-link: open the viewer directly on a specific entry by id (glossary
   * §11.8 / Phase 4). Resolves the id through save-migration ALIASES for
   * robustness, opens the overlay, selects the entry's real category, then
   * routes to its detail view. Unknown ids are a safe no-op. Locked entries are
   * fine — the Phase 3 viewer renders them with a how-to-unlock hint.
   * @param {string} id  codex entry id (possibly a retired alias)
   * @returns {boolean} true if an entry was opened
   */
  openEntry(id) {
    if (!id || !this._codex || typeof this._codex.getEntry !== 'function') return false;
    const resolvedId = (ALIASES && ALIASES[id]) || id;
    const entry = this._codex.getEntry(resolvedId);
    if (!entry) return false;
    this.show();
    // Land on a real category (not a `track:` pseudo-key) so the sidebar +
    // entry list resolve correctly when the user backs out of the detail view.
    this._selectedCategory = entry.category;
    if (typeof this._renderSidebarActive === 'function') this._renderSidebarActive();
    this._showDetail(entry);
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

    // Filter / sort bar (above the grid; hidden while a detail or search-empty
    // state is shown). Built once; its buttons mutate _filter/_sort and re-render.
    const filterBar = document.createElement('div');
    filterBar.id = 'codex-filter-bar';
    Object.assign(filterBar.style, {
      display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
      padding: '10px 16px', borderBottom: '1px solid rgba(0,212,255,0.1)',
      fontSize: '12px', color: '#889', flexShrink: '0',
    });
    this._buildFilterBar(filterBar);

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

    content.appendChild(filterBar);
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
      const tab = this._makeSidebarTab(c.key, c.icon, c.label, c.key, c.color);
      sidebar.appendChild(tab);
    }

    // --- Tracks: guided cross-category learning paths (e.g. "The Propellant
    // Story"). Rendered below the categories under a small divider. Selecting a
    // track key (prefixed "track:") switches the list into ordered-track mode. ---
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
  _makeSidebarTab(key, icon, label, category, color) {
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
        } else if (typeof this._codex.getCategoryProgress === 'function') {
          const p = this._codex.getCategoryProgress(cat);
          countEl.textContent = `${p.unlocked}/${p.total}`;
        }
        countEl.style.color = isSel ? accent : '#557';
      }
    }
  }

  /** @private Resolve the current list (search / track / category) with the
   * active filter+sort applied. Shared by the grid and Prev/Next so they stay
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

  /** @private Render the entry card grid */
  _renderEntryList() {
    const listEl = document.getElementById('codex-entry-list');
    const detailEl = document.getElementById('codex-entry-detail');
    if (!listEl || !detailEl) return;

    listEl.style.display = 'grid';
    detailEl.style.display = 'none';

    // Refactored: resolve + filter via the shared helper so Prev/Next mirrors
    // exactly what the grid shows.
    const { entries, isTrack } = this._currentListEntries();

    listEl.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { color: '#667', fontSize: '14px', padding: '24px' });
      empty.textContent = this._searchQuery
        ? `No topics match “${this._searchQuery}”.`
        : 'No topics match the current filter.';
      listEl.appendChild(empty);
    }
    for (const entry of entries) {
      listEl.appendChild(this._makeCard(entry));
    }

    // Reset roving keyboard focus to the top of the freshly-rendered grid.
    this._focusIdx = entries.length ? 0 : -1;
    this._applyGridFocus();

    this._renderSidebarActive();
    this._renderFilterBar(isTrack);
  }

  /** @private Highlight the keyboard-focused card (roving tabindex pattern). */
  _applyGridFocus() {
    const listEl = document.getElementById('codex-entry-list');
    if (!listEl) return;
    const cards = listEl.querySelectorAll('.codex-card');
    cards.forEach((card, i) => {
      if (i === this._focusIdx) {
        card.style.outline = '2px solid #00d4ff';
        card.style.outlineOffset = '1px';
      } else {
        card.style.outline = 'none';
      }
    });
  }

  /** @private Number of columns currently laid out in the grid (for up/down). */
  _gridColumns(listEl) {
    const cards = listEl.querySelectorAll('.codex-card');
    if (cards.length < 2) return 1;
    const firstTop = cards[0].offsetTop;
    let cols = 1;
    for (let i = 1; i < cards.length; i++) {
      if (cards[i].offsetTop === firstTop) cols++;
      else break;
    }
    return Math.max(1, cols);
  }

  /** @private Handle an arrow/Enter/Home/End keypress in the grid view. */
  _handleGridKey(code) {
    const listEl = document.getElementById('codex-entry-list');
    if (!listEl) return;
    const cards = listEl.querySelectorAll('.codex-card');
    if (!cards.length) return;
    if (this._focusIdx < 0) this._focusIdx = 0;

    if (code === 'Enter') {
      const card = cards[this._focusIdx];
      if (card) card.click();
      return;
    }

    const cols = this._gridColumns(listEl);
    let idx = this._focusIdx;
    switch (code) {
      case 'ArrowLeft':  idx = Math.max(0, idx - 1); break;
      case 'ArrowRight': idx = Math.min(cards.length - 1, idx + 1); break;
      case 'ArrowUp':    idx = Math.max(0, idx - cols); break;
      case 'ArrowDown':  idx = Math.min(cards.length - 1, idx + cols); break;
      case 'Home':       idx = 0; break;
      case 'End':        idx = cards.length - 1; break;
      default: break;
    }
    this._focusIdx = idx;
    this._applyGridFocus();
    const card = cards[idx];
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest' });
    }
  }

  /** @private Step Prev/Next within the current list while in the detail view.
   * @param {number} dir -1 for previous, +1 for next
   */
  _stepDetail(dir) {
    if (!this._selectedEntry) return;
    const { entries } = this._currentListEntries();
    const idx = entries.findIndex(e => e.id === this._selectedEntry.id);
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= entries.length) return;
    const detailEl = document.getElementById('codex-entry-detail');
    if (detailEl) detailEl.scrollTop = 0;
    this._showDetail(entries[nextIdx]);
  }

  /** @private Apply the locked/unlocked filter and the sort order.
   * A learning path ("track") is authored as an ordered narrative, so its
   * sequence is always preserved — the sort control is suppressed for tracks
   * (see _renderFilterBar) and ignored here. Category/search views honour the
   * active sort, defaulting to category order.
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
      Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '6px' });
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
          cursor: 'pointer', padding: '3px 9px', borderRadius: '11px',
          border: '1px solid rgba(255,255,255,0.12)', color: '#9ab',
          transition: 'all 0.15s', userSelect: 'none',
        });
        btn.addEventListener('click', () => {
          if (key === 'filter') this._filter = o.value;
          else this._sort = o.value;
          this._selectedEntry = null;
          this._renderEntryList();
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
   * @param {boolean} [isTrack=false] hide the Sort group for learning paths,
   *   whose authored order is fixed.
   */
  _renderFilterBar(isTrack = false) {
    const bar = document.getElementById('codex-filter-bar');
    if (!bar) return;
    bar.style.display = 'flex';
    // Sort is meaningless inside a track (order is authored) — hide that group.
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

    // Per-category accent (Phase 3 hue theming): unlocked cards are tinted with
    // their category colour; locked cards stay neutral/dim so they read as
    // "not yet detailed" regardless of category.
    const catMeta = this._catMeta(entry.category);
    const accent = catMeta.color || '#00d4ff';
    const rgb = this._hexToRgb(accent);
    const aBg = (a) => `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;

    const restBorder = isLocked ? 'rgba(255,255,255,0.08)' : (isNew ? aBg(0.55) : aBg(0.22));
    const restBg = isLocked ? 'rgba(255,255,255,0.02)' : (isNew ? aBg(0.08) : aBg(0.04));

    Object.assign(card.style, {
      padding: '14px 16px', borderRadius: '4px', cursor: 'pointer',
      border: `1px solid ${restBorder}`,
      borderLeft: `3px solid ${isLocked ? 'rgba(255,255,255,0.1)' : aBg(0.7)}`,
      background: restBg,
      transition: 'all 0.15s ease', position: 'relative', overflow: 'hidden',
      boxShadow: isNew ? `0 0 12px ${aBg(0.18)}` : 'none',
    });

    const shortText = `<span style="opacity:${isLocked ? 0.55 : 0.7};">${entry.shortText}</span>`;
    const newBadge = isNew
      ? `<span style="position:absolute;top:8px;right:10px;font-size:11px;color:${accent};font-weight:bold;text-shadow:0 0 6px ${aBg(0.5)};">NEW</span>`
      : '';

    // Tech-Level is intentionally NOT shown on cards: flagging it (especially
    // the flight-proven majority) is noise. It surfaces only in the detail view
    // and only for not-yet-proven tech — see _showDetail.
    card.innerHTML = `
      ${newBadge}
      <div style="font-size:24px;margin-bottom:6px;${isLocked ? 'opacity:0.65;' : ''}">${entry.icon}</div>
      <div style="font-size:15px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};margin-bottom:4px;">${entry.title}</div>
      <div style="font-size:11px;color:${isLocked ? '#566' : accent};margin-bottom:6px;opacity:${isLocked ? 0.7 : 0.85};">${catMeta.label}</div>
      <div style="font-size:13px;line-height:1.5;">${shortText}</div>
    `;

    card.addEventListener('mouseenter', () => {
      card.style.borderColor = isLocked ? aBg(0.3) : accent;
      card.style.background = aBg(0.12);
    });
    card.addEventListener('mouseleave', () => {
      card.style.borderColor = restBorder;
      card.style.background = restBg;
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
    const filterBar = document.getElementById('codex-filter-bar');
    if (filterBar) filterBar.style.display = 'none';

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

    // Accent hue for this category — tints the callout blocks and chips so the
    // detail view reads as "part of" its category (Phase 3 hue theming).
    const accent = catMeta.color || '#00d4ff';
    const accentRGB = this._hexToRgb(accent);
    const accentBg = (a) => `rgba(${accentRGB.r},${accentRGB.g},${accentRGB.b},${a})`;

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

    // Real-world callout + formula chip — only when unlocked (they're "depth"
    // that play reveals) and only when present. realWorld is the verified
    // source/figure line; formula is the physics relation.
    let extrasHtml = '';
    if (!isLocked) {
      if (entry.realWorld) {
        extrasHtml += `
          <div style="margin-top:18px;padding:12px 16px;border-radius:4px;
            background:${accentBg(0.06)};border:1px solid ${accentBg(0.25)};">
            <div style="font-size:11px;letter-spacing:0.12em;font-weight:bold;
              color:${accent};opacity:0.85;margin-bottom:6px;">🌍 IN THE REAL WORLD</div>
            <div style="font-size:14px;color:#cde;line-height:1.6;">${entry.realWorld}</div>
          </div>`;
      }
      if (entry.formula) {
        extrasHtml += `
          <div style="margin-top:14px;padding:10px 14px;border-radius:4px;
            background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.12);
            font-size:15px;color:#e8f4ff;letter-spacing:0.02em;
            font-family:'Courier New',monospace;overflow-x:auto;">
            <span style="color:#778;font-size:11px;letter-spacing:0.1em;
              display:block;margin-bottom:4px;">ƒ FORMULA</span>${entry.formula}</div>`;
      }
    }

    // Related cross-links — clickable chips that jump to the related entry's
    // detail (Outer-Wilds-style connection browsing). Resolved through the
    // system so dangling ids are dropped; locked relateds still navigate.
    const related = (typeof this._codex.getRelated === 'function')
      ? this._codex.getRelated(entry.id)
      : [];
    let relatedHtml = '';
    if (related.length) {
      const chips = related.map(r => {
        const rLocked = !r.unlocked;
        return `<span class="codex-related-chip" data-id="${r.id}"
          style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;
            padding:5px 11px;border-radius:14px;font-size:12px;
            border:1px solid ${rLocked ? 'rgba(255,255,255,0.14)' : accentBg(0.4)};
            background:${rLocked ? 'rgba(255,255,255,0.03)' : accentBg(0.08)};
            color:${rLocked ? '#89a' : '#cde'};transition:all 0.15s;">
          <span>${r.icon}</span>${r.title}${rLocked ? ' 🔒' : ''}</span>`;
      }).join('');
      relatedHtml = `
        <div style="margin-top:20px;">
          <div style="font-size:11px;letter-spacing:0.12em;color:#778;
            margin-bottom:8px;">🔗 RELATED</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>
        </div>`;
    }

    // Prev/Next within the current view — sequential browsing without bouncing
    // back to the grid. Mirrors the same list the grid shows (category OR
    // learning-path, with the active filter/sort applied) so order is coherent.
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
           margin-top:26px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);">
           ${navBtn(prev, `← ${prev ? prev.title : ''}`, 'left')}
           ${navBtn(next, `${next ? next.title : ''} →`, 'right')}
         </div>`
      : '';

    detailEl.innerHTML = `
      <div id="codex-back-btn" style="cursor:pointer;color:#00d4ff;font-size:14px;margin-bottom:16px;
        display:inline-block;padding:5px 12px;border:1px solid rgba(0,212,255,0.2);border-radius:3px;
        transition:background 0.15s;">← Back</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">
        <span style="font-size:42px;${isLocked ? 'opacity:0.65;' : ''}">${entry.icon}</span>
        <div>
          <div style="font-size:20px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};">${entry.title}</div>
          <div style="font-size:12px;color:${accent};opacity:0.85;">${catMeta.icon} ${catMeta.label}</div>
        </div>
      </div>
      ${trlDetailHtml}
      <div style="font-size:15px;color:#aaddff;line-height:1.55;margin-bottom:18px;
        padding:10px 14px;background:${accentBg(0.05)};border-left:3px solid ${accentBg(0.4)};
        border-radius:2px;">${entry.shortText}</div>
      ${bodyHtml}
      ${extrasHtml}
      ${relatedHtml}
      ${prevNextHtml}
    `;

    const backBtn = detailEl.querySelector('#codex-back-btn');
    backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'rgba(0,212,255,0.1)'; });
    backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none'; });
    backBtn.addEventListener('click', () => {
      this._selectedEntry = null;
      this._renderEntryList();
      this._renderHeader();
    });

    // Related chips + Prev/Next: jump straight to another entry's detail.
    // If the target lives in a different category, follow it there so its
    // own Prev/Next + sidebar highlight stay coherent.
    const jumpTo = (id) => {
      const target = this._codex.getEntry ? this._codex.getEntry(id) : null;
      if (!target) return;
      if (target.category !== this._selectedCategory && !this._searchQuery) {
        this._selectedCategory = target.category;
        this._renderSidebarActive();
      }
      detailEl.scrollTop = 0;
      this._showDetail(target);
    };
    detailEl.querySelectorAll('.codex-related-chip, .codex-nav-btn').forEach(el => {
      el.addEventListener('mouseenter', () => { el.style.background = accentBg(0.18); });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', () => jumpTo(el.dataset.id));
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
    // before InputManager's codex intercept). ESC always closes; the rest is
    // grid/detail navigation. Typing in the search box is left alone — ESC there
    // just blurs the input, and other keys fall through to the browser.
    window.addEventListener('keydown', (e) => {
      if (!this._visible) return;
      const tgt = e.target;
      const inSearch = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA');

      // ESC while typing in the search box: blur the field (don't close the
      // codex). This must precede the general ESC handling below, which runs in
      // capture phase and would otherwise swallow the keystroke before the
      // input's own listener could react.
      if (e.code === 'Escape' && inSearch) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (typeof tgt.blur === 'function') tgt.blur();
        return;
      }

      if (e.code === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        // ESC from a detail view returns to the grid; from the grid it closes.
        if (this._selectedEntry) {
          this._selectedEntry = null;
          this._renderEntryList();
          this._renderHeader();
        } else {
          this.hide();
        }
        return;
      }

      if (inSearch) return; // don't hijack typing

      // --- Detail view: ←/→ = Prev/Next sibling, Backspace = back to grid ---
      if (this._selectedEntry) {
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
          e.stopImmediatePropagation(); e.preventDefault();
          this._stepDetail(e.code === 'ArrowRight' ? 1 : -1);
        } else if (e.code === 'Backspace') {
          e.stopImmediatePropagation(); e.preventDefault();
          this._selectedEntry = null;
          this._renderEntryList();
          this._renderHeader();
        }
        return;
      }

      // --- Grid view: arrow keys move a roving focus, Enter opens detail ---
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Home', 'End'].includes(e.code)) {
        e.stopImmediatePropagation(); e.preventDefault();
        this._handleGridKey(e.code);
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
