/**
 * CodexViewerUI.js — DOM overlay modal for browsing the codex entries. Toggle with I; Escape closes.
 *
 * Full-screen overlay → centred panel with a 3-column master-detail interior:
 *   - sidebar (categories + learning paths)
 *   - compact entry list (title, one-line hook, NEW/LOCKED pip)
 *   - persistent reading pane (QUICK LOOK, BRIEFING, TECH LEVEL, REAL WORLD, FORMULA, RELATED, prev/next, WARNING:
 *     the manual's authored red box, entries carrying `i18n.warning`, unlocked only). An unlocked HARDWARE entry also
 *     floats its rendered part portrait right of the prose with a HARDWARE facts block: one render per entry through
 *     the injected `portraitFor`, text-only on a miss.
 *
 * Reading follows selection: up/down move the list AND re-render the pane, so it is never empty. Below ~1000 px
 * the interior collapses to a 2-pane swap (list / reading).
 *
 * Deep links: `openEntry(id, { anchor })` (the CODEX_OPEN_ENTRY route every glossary term rides).
 * `anchor: 'warning'` scrolls to the WARNING box and gives it a steady brighter frame for WARNING_LANDED_MS.
 *
 * @module ui/CodexViewerUI
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { entryMatchesQuery, ALIASES } from '../systems/CodexSystem.js';
import { GestureHints } from './hud/GestureHints.js';
import { decorateGlossary, escapeHtml } from '../systems/codex/glossary.js';
import { layoutEgoMap, EGO_LAYOUT_VIEW } from '../systems/codex/egoLayout.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';
import {
  Constants, trlToBadgeColor, trlToLabel, techLevelBadgeText,
} from '../core/Constants.js';

// Fallback labels, used only if the system supplies no meta (codex.json failed to load). Authoritative meta,
// including colour, comes from codexSystem.getCategories(). The data's `icon` fields are inert here: a category is
// a colour swatch + a small-caps label, an entry its title.
const CATEGORY_META_FALLBACK = {
  ORBITAL_MECHANICS: { label: 'Orbital Mechanics' },
  PROPULSION:        { label: 'Propulsion' },
  POWER:             { label: 'Power' },
  SPACE_ENVIRONMENT: { label: 'Environment' },
  MATERIALS:         { label: 'Materials' },
  TETHERS:           { label: 'Tethers' },
  DEBRIS:            { label: 'Debris' },
  SENSORS:           { label: 'Sensors' },
  ATTITUDE:          { label: 'Attitude Control' },
  AVIONICS:          { label: 'Avionics' },
  COMMS:             { label: 'Communications' },
  CATALOG:           { label: 'Catalog' },
  HERITAGE:          { label: 'Heritage' },
  WORLD_INDUSTRY:    { label: 'World & Industry' },
  NEWS:              { label: 'News & Events' },
  PLAYBOOK:          { label: 'Playbook' },
};

/** A CSS colour TOKEN and nothing else (hex, rgb()/hsl(), colour word; no `;`, `url(`, quotes): the data colour is
 *  interpolated into an inline style, so a non-token falls back to the hash hue. */
const SWATCH_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/deg]+\)|[a-z]{3,20})$/i;

/**
 * Swatch colour for a category (or a `track:`/`map:` pseudo-category): the data colour when it is a token, else a
 * deterministic hue, FNV-1a over the key's UTF-16 code units, hue = hash mod 360, fixed 60% / 55% saturation /
 * lightness. Pure.
 * @param {string} key
 * @param {string} [color] - the data colour, if any
 * @returns {string} a CSS colour
 */
export function categorySwatchColor(key, color) {
  if (typeof color === 'string' && SWATCH_COLOR_RE.test(color.trim())) return color.trim();
  const s = String(key || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hsl(${h % 360},60%,55%)`;
}

/**
 * The category marker: a 10x10 px colour swatch, then the name in small caps. Never a glyph.
 * `.codex-cat-swatch` / `.codex-cat-label` are the hooks tests read.
 * @param {string} swatch - a CSS colour (see categorySwatchColor)
 * @returns {string} HTML
 */
export function categoryLabelHtml(label, swatch) {
  // The label is data: escape it. The swatch is a token validated by categorySwatchColor.
  return `<span class="codex-cat-swatch" style="display:inline-block;width:10px;height:10px;` +
    `border-radius:2px;background:${swatch};flex-shrink:0;vertical-align:middle;"></span>` +
    `<span class="codex-cat-label" style="font-variant:small-caps;letter-spacing:0.06em;` +
    `overflow:hidden;text-overflow:ellipsis;">${escapeHtml(String(label ?? ''))}</span>`;
}

// Below this panel width the 3-column interior collapses to a 2-pane swap (list / reading).
const NARROW_BREAKPOINT = 1000;

// LOCKED tag trailing a locked entry's title; the leading space keeps it off the title.
const LOCKED_TAG_HTML = ' <span class="codex-locked-tag" style="font-size:10px;letter-spacing:0.08em;opacity:0.8;">LOCKED</span>';

// `CODEX_VIEWED` fires only once the selection has *rested* on an unlocked/unseen entry this long: arrow-scrubbing
// and transient renders (deep-link routing, filter churn) never mark seen.
const SEEN_DWELL_MS = 1500;
/** How long the overlay swallows clicks after an open from the connections map (a double-click / double-tap's second
 *  click). A real iPad finger's second tap can land after 400 ms and hit a link in the article that just opened. */
const MAP_OPEN_SWALLOW_MS = 600;

// A deep link to the WARNING box (Houston's "manual"): after the entry renders, `.codex-warning` is scrolled into
// view and wears `codex-warning--landed` this long: a STEADY brighter border (the one rule in
// CODEX_VIEWER_STYLE_ID; no pulse: THREAT pulses only for live alarms). Cleared by a tracked timer or on hide().
export const WARNING_LANDED_MS = 2000;
export const WARNING_LANDED_CLASS = 'codex-warning--landed';
/** The viewer's ONE stylesheet (everything else is inline style attributes). */
export const CODEX_VIEWER_STYLE_ID = 'codex-viewer-style';

export class CodexViewerUI {
  /**
   * @param {import('../systems/CodexSystem.js').CodexSystem} codexSystem
   * @param {{ portraitFor?: (entry:object) => ({canvas:*, massKg?:number, specs?:string[]}|null) }} [deps]
   *   `portraitFor`: the reader's ONE optional collaborator, a LAZY callback (never a captured reference) turning a
   *   codex entry into its rendered part portrait. Injected so this module imports NO MotherCallouts / main.js and
   *   holds no live singleton (headless-testable). Absent (or a `?ladder=0` boot) → the reader stays text-only.
   *   `onClose`: (lastEntryId) => void, called once when the open viewer closes, with the entry it was showing, so the
   *   drawer can follow the reader to the entry they jumped to (floor 1 wave 2, L8). Absent → nothing.
   */
  constructor(codexSystem, deps = {}) {
    this._codex = codexSystem;
    /** @type {?((entry:object) => ({canvas:*, massKg?:number, specs?:string[]}|null))} */
    this._portraitFor = (deps && typeof deps.portraitFor === 'function') ? deps.portraitFor : null;
    /** @type {?{id:string, result:({dataUrl:string, massKg?:number, specs?:string[]}|null)}}
     * One cached render per entry id, never per frame: a re-render of the SAME entry reuses the cached data URL. */
    this._portraitCache = null;
    /** @type {?((lastEntryId:string) => void)} */
    this._onClose = (deps && typeof deps.onClose === 'function') ? deps.onClose : null;
    /** @type {?string} the part name the reader came from (MAXIMIZE on a clicked part), shown as "from: <name>" */
    this._via = null;
    /** @type {?string} pending `via` for the next show()'s auto-select (consumed with `_pendingOpenId`) */
    this._pendingVia = null;
    this._visible = false;
    this._selectedCategory = null; // set to the first category on first show()
    this._selectedEntry = null;
    this._overlay = null;
    /** @type {string} live search query (overrides sidebar while set) */
    this._searchQuery = '';
    /** @type {number|null} debounce handle for the search input */
    this._searchDebounce = null;
    /** @type {'all'|'unlocked'|'locked'} list filter */
    this._filter = 'all';
    /** @type {'default'|'az'|'trl'} list sort order */
    this._sort = 'default';
    /** @type {number} roving-focus index into the current entry list (keyboard nav) */
    this._focusIdx = -1;
    /** @type {boolean} true while the interior is in the narrow 2-pane swap mode */
    this._narrow = false;

    /**
     * Ego-map mode: the reading pane renders an SVG connections map of `_selectedEntry` instead of the article.
     * Transient; cleared on any selection/filter/track switch and hide().
     * @type {boolean}
     */
    this._mapMode = false;
    /** @type {?string} focus entry id for the map (may differ from selection after re-centering) */
    this._mapFocusId = null;

    /** @type {string|null} deep-link target id for the next show()'s auto-select */
    this._pendingOpenId = null;
    /** @type {string|null} deep-link anchor (`'warning'`) for the pending open — consumed once that entry renders */
    this._pendingAnchor = null;
    /** @type {*} the one-shot WARNING_LANDED_CLASS timer (null when disarmed) */
    this._landedTimer = null;
    /** @type {?Element} the element wearing WARNING_LANDED_CLASS right now */
    this._landedEl = null;

    /** @type {*} debounce handle for the window resize listener */
    this._resizeDebounce = null;

    /** @type {*} pending seen-dwell timer handle (null when disarmed) */
    this._seenTimer = null;
    /** Timer seam for the Node harness; tests swap these via `_setSeenTimerHooks`. @type {(fn:Function, ms:number)=>*} */
    this._scheduleSeen = (fn, ms) => setTimeout(fn, ms);
    /** @type {(handle:*)=>void} */
    this._cancelSeen = (h) => clearTimeout(h);

    this._buildDOM();
    this._setupListeners();
  }

  toggle() { this._visible ? this._requestClose() : this.show(); }

  /** @private The single close decision for every self-close path (ESC, backdrop, CLOSE button, I key). */
  _requestClose() {
    this.hide();
  }

  show() {
    this._visible = true;
    // No "All" view: land on the first newbie-friendly category.
    if (!this._selectedCategory) this._selectedCategory = this._firstCategoryKey();
    this._overlay.style.display = 'flex';
    requestAnimationFrame(() => { this._overlay.style.opacity = '1'; });
    this._applyResponsiveLayout();
    this._renderHeader();
    this._renderEntryList();
    this._selectFirstEntry();
  }

  hide() {
    const wasVisible = this._visible;
    const lastId = this._selectedEntry ? this._selectedEntry.id : null;
    this._visible = false;
    this._mapMode = false;
    // A seen-dwell firing after close would mark an entry the player never read.
    this._clearSeenTimer();
    this._clearLanded();
    this._overlay.style.opacity = '0';
    setTimeout(() => { if (!this._visible) this._overlay.style.display = 'none'; }, 200);
    // The reader's last page goes back to the drawer (it decides whether to follow).
    if (wasVisible && lastId && this._onClose) { try { this._onClose(lastId); } catch (_e) { /* dep */ } }
  }

  isVisible() { return this._visible; }

  /**
   * Deep-link: open on entry `id`, resolved through save-migration ALIASES. Unknown ids are a safe no-op; locked
   * entries render with a how-to-unlock hint.
   *
   * `opts.anchor === 'warning'`: once the entry has rendered, its `.codex-warning` (the LAST block of the page) is
   * scrolled into view and wears WARNING_LANDED_CLASS for WARNING_LANDED_MS. No warning on the page: a plain open.
   * Any other anchor is ignored.
   *
   * `opts.via`: the callout name of the part the reader clicked before pressing MAXIMIZE; the page shows one line
   * "from: <via>" above the title until the reader moves to another entry.
   * @param {string} id  codex entry id (possibly a retired alias)
   * @param {{ anchor?: string, via?: string }} [opts]
   * @returns {boolean} true if an entry was opened
   */
  openEntry(id, opts = {}) {
    if (!id || !this._codex || typeof this._codex.getEntry !== 'function') return false;
    const resolvedId = (ALIASES && ALIASES[id]) || id;
    const entry = this._codex.getEntry(resolvedId);
    if (!entry) return false;
    // Clear search and filter so the target row is always on the list.
    this._searchQuery = '';
    this._filter = 'all';
    const searchInput = document.getElementById('codex-search');
    if (searchInput) searchInput.value = '';
    // Real category (not a `track:` pseudo-key) BEFORE show(), so there is no transient render/mark-seen of the stale
    // category's first entry. _pendingOpenId makes _selectFirstEntry route here; _selectEntry consumes the anchor.
    this._selectedCategory = entry.category;
    this._pendingOpenId = resolvedId;
    this._pendingAnchor = (opts && typeof opts.anchor === 'string') ? opts.anchor : null;
    this._pendingVia = (opts && typeof opts.via === 'string' && opts.via) ? opts.via : null;
    this.show();
    this._pendingOpenId = null;
    this._pendingAnchor = null;
    this._pendingVia = null;
    return true;
  }

  /** @private ms clock for the map-open click guard (tests replace it) */
  _nowMs() { return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now(); }

  /** @private Open `id` from the map and swallow overlay clicks for MAP_OPEN_SWALLOW_MS (double-click guard). */
  _openFromMap(id) {
    this._swallowClicksUntil = this._nowMs() + MAP_OPEN_SWALLOW_MS;
    return this.openEntry(id);
  }

  _swallowsClick() { return typeof this._swallowClicksUntil === 'number' && this._nowMs() < this._swallowClicksUntil; }

  _onOverlayClickCapture(e) {
    if (!this._swallowsClick() || !e) return;
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  /** @private */
  _buildDOM() {
    this._ensureStyle();
    const overlay = document.createElement('div');
    overlay.id = 'codex-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.92)', zIndex: '9999',
      display: 'none', opacity: '0', transition: 'opacity 0.2s ease',
      justifyContent: 'center', alignItems: 'center',
      fontFamily: "var(--font-mono)", color: '#ccc',
    });
    // Capture phase, so no link or node under the finger hears a click right after an open FROM THE MAP (the second
    // click of a double-click would land on the new article's text and could open a link).
    overlay.addEventListener('click', (e) => this._onOverlayClickCapture(e), true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._requestClose(); });

    const panel = document.createElement('div');
    panel.id = 'codex-panel';
    Object.assign(panel.style, {
      width: '96vw', maxWidth: '1720px', height: '94vh', maxHeight: '1200px',
      background: '#1a1a2e', border: '1px solid rgba(0,212,255,0.3)',
      borderRadius: '6px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 0 40px rgba(0,212,255,0.12)', overflow: 'hidden',
    });

    const header = document.createElement('div');
    header.id = 'codex-header';
    Object.assign(header.style, {
      padding: '16px 24px', borderBottom: '1px solid rgba(0,212,255,0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0',
    });
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
        <span style="font-size:16px;color:#00d4ff;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;white-space:nowrap;">SPECS</span>
        <span id="codex-progress" style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;font-variant-numeric:tabular-nums;color:#888;white-space:nowrap;"></span>
        <div id="codex-progress-bar" title="overall briefings unlocked"
          style="width:120px;height:6px;border-radius:3px;background:rgba(255,255,255,0.08);
                 overflow:hidden;flex-shrink:0;">
          <div id="codex-progress-fill" style="height:100%;width:0%;
            background:linear-gradient(90deg,#00d4ff,#7af);transition:width 0.3s ease;"></div>
        </div>
        <input id="codex-search" type="text" placeholder="search topics…" spellcheck="false"
          style="flex:1;max-width:320px;margin-left:8px;background:rgba(0,0,0,0.4);
                 border:1px solid rgba(0,212,255,0.25);border-radius:3px;color:#cfefff;
                 font-family: var(--font-mono);font-size:14px;padding:6px 10px;outline:none;" />
      </div>
      <button id="codex-close-btn" style="background:none;border:1px solid rgba(255,255,255,0.2);
        color:#888;font-size:16px;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;padding:4px 12px;border-radius:3px;
        font-family: var(--font-mono);">ESC ×</button>
    `;

    const body = document.createElement('div');
    body.id = 'codex-body';
    Object.assign(body.style, {
      display: 'flex', flex: '1', overflow: 'hidden',
    });

    const sidebar = document.createElement('div');
    sidebar.id = 'codex-sidebar';
    Object.assign(sidebar.style, {
      width: '200px', minWidth: '180px', borderRight: '1px solid rgba(0,212,255,0.15)',
      overflowY: 'auto', padding: '10px 0', flexShrink: '0',
    });
    this._buildSidebar(sidebar);

    const middle = document.createElement('div');
    middle.id = 'codex-middle';
    Object.assign(middle.style, {
      width: '320px', minWidth: '300px', maxWidth: '340px',
      borderRight: '1px solid rgba(0,212,255,0.12)',
      display: 'flex', flexDirection: 'column', flexShrink: '0', overflow: 'hidden',
    });

    // Built once; its buttons mutate _filter/_sort and re-render.
    const filterBar = document.createElement('div');
    filterBar.id = 'codex-filter-bar';
    Object.assign(filterBar.style, {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '8px 12px', borderBottom: '1px solid rgba(0,212,255,0.1)',
      fontSize: '11px', color: '#889', flexShrink: '0',
    });
    this._buildFilterBar(filterBar);

    const entryList = document.createElement('div');
    entryList.id = 'codex-entry-list';
    Object.assign(entryList.style, {
      flex: '1', overflowY: 'auto', padding: '6px 0',
    });

    middle.appendChild(filterBar);
    middle.appendChild(entryList);

    // Delegate row clicks to the stable container: the list is rebuilt on every debounced search keystroke, so a
    // mousedown/mouseup straddling a rebuild would lose a per-row 'click'.
    entryList.addEventListener('click', (e) => {
      const rowEl = e.target.closest && e.target.closest('.codex-row');
      if (!rowEl || !entryList.contains(rowEl)) return;
      const id = rowEl.dataset && rowEl.dataset.id;
      if (!id) return;
      const entry = this._codex && this._codex.getEntry ? this._codex.getEntry(id) : null;
      if (!entry) return;
      this._selectEntry(entry, { focusPane: this._narrow });
    });

    const reading = document.createElement('div');
    reading.id = 'codex-reading';
    // Programmatic focus only (tabIndex -1): Enter moves focus off the list, PgUp/PgDn scroll the briefing.
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

    // On glass there is no Esc key: "CLOSE ×" (re-applied when glass turns on).
    const closeBtn = overlay.querySelector('#codex-close-btn');
    closeBtn.addEventListener('click', () => this._requestClose());
    const closeLabel = () => { closeBtn.textContent = GestureHints.isGlass() ? 'CLOSE ×' : 'ESC ×'; };
    closeLabel();
    this._offGlassLabel = GestureHints.onGlassOn(closeLabel);

    // Live search across ALL categories (sidebar selection ignored while a query is active). Debounced: each render
    // rebuilds every row.
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
    // Keep keystrokes (incl. game hotkeys) inside the search box.
    searchInput.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { searchInput.blur(); return; }
      e.stopPropagation();
    });
  }

  /**
   * @private The viewer's ONE stylesheet, mounted once. A class toggle has to beat the WARNING box's inline border
   * (hence `!important`). `codex-warning--landed` is a STEADY brighter red frame, no transition or animation.
   */
  _ensureStyle() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (typeof document.getElementById === 'function' && document.getElementById(CODEX_VIEWER_STYLE_ID)) return;
    const mount = document.head || document.documentElement || document.body;
    if (!mount || typeof mount.appendChild !== 'function') return;
    const style = document.createElement('style');
    style.id = CODEX_VIEWER_STYLE_ID;
    style.textContent = `
      .codex-warning.${WARNING_LANDED_CLASS} {
        border-color: #ff4422 !important;
        box-shadow: 0 0 0 1px rgba(255,68,34,0.55), 0 0 18px rgba(255,68,34,0.35);
      }
    `;
    mount.appendChild(style);
  }

  /** @private Category meta {label, color, swatch}, with fallback. `color` is the accent (cyan default); `swatch`
   * is the data colour, else a key-derived hue (categorySwatchColor). The data's `icon` is deliberately not surfaced. */
  _catMeta(key) {
    const m = (typeof this._codex.getCategoryMeta === 'function') ? this._codex.getCategoryMeta(key) : null;
    const fb = CATEGORY_META_FALLBACK[key] || { label: key };
    return {
      label: (m && m.label) || fb.label,
      color: (m && m.color) || '#00d4ff',
      swatch: categorySwatchColor(key, m && m.color),
    };
  }

  _buildSidebar(sidebar) {
    // Ordered, data-driven; skip categories with no entries yet.
    const cats = (typeof this._codex.getCategories === 'function')
      ? this._codex.getCategories()
      : Object.keys(CATEGORY_META_FALLBACK).map(key => ({ key, ...this._catMeta(key) }));
    for (const c of cats) {
      const hasEntries = this._codex.getCategoryProgress
        ? this._codex.getCategoryProgress(c.key).total > 0
        : true;
      if (!hasEntries) continue;
      const tab = this._makeSidebarTab(c.key, c.label, c.key, c.color);
      sidebar.appendChild(tab);
    }

    // Learning paths: a `track:` key switches the list into ordered-track mode.
    const tracks = (typeof this._codex.getTracks === 'function') ? this._codex.getTracks() : null;
    const trackEntries = tracks ? Object.entries(tracks) : [];
    if (trackEntries.length) {
      const divider = document.createElement('div');
      divider.textContent = 'LEARNING PATHS';
      Object.assign(divider.style, {
        padding: '14px 14px 6px', fontSize: '11px', fontWeight: '700', letterSpacing: '0.14em',
        color: '#566', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '8px',
      });
      sidebar.appendChild(divider);
      trackEntries
        .sort((a, b) => (a[1].order ?? 999) - (b[1].order ?? 999))
        .forEach(([tid, meta]) => {
          const tab = this._makeSidebarTab(
            `track:${tid}`, meta.label || tid, `track:${tid}`, meta.color,
          );
          sidebar.appendChild(tab);
        });
    }

    // CONNECTIONS: the `map:` pseudo-key tab never becomes the active category; its custom onClick enters map mode.
    const mapDivider = document.createElement('div');
    mapDivider.textContent = 'CONNECTIONS';
    Object.assign(mapDivider.style, {
      padding: '14px 14px 6px', fontSize: '11px', fontWeight: '700', letterSpacing: '0.14em',
      color: '#566', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '8px',
    });
    sidebar.appendChild(mapDivider);
    const mapTab = this._makeSidebarTab('map:', 'Map', 'map:', '#8ab',
      () => this._openMapFromSidebar());
    sidebar.appendChild(mapTab);
  }

  /** @private Enter map mode on the current selection, falling back to the first unlocked entry. */
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

  /** @private A colour swatch + small-caps label tab (never a glyph).
   * @param {string} category - dataset.category (may be a `track:`/`map:` pseudo-key)
   * @param {Function} [onClick] - replaces the default category switch (the map tab)
   */
  _makeSidebarTab(key, label, category, color, onClick) {
    const tab = document.createElement('div');
    tab.dataset.category = category;
    // The active highlight and hover read the category's own accent.
    tab.dataset.accent = color || '#00d4ff';
    Object.assign(tab.style, {
      padding: '9px 14px', cursor: 'pointer', fontSize: '13px',
      borderLeft: '3px solid transparent', transition: 'all 0.15s ease',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px',
    });
    tab.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;">` +
      categoryLabelHtml(label, categorySwatchColor(key, color)) + '</span>' +
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

  /** @private Panel-width responsive mode (3-column vs 2-pane swap). */
  _applyResponsiveLayout() {
    const panel = document.getElementById('codex-panel');
    const reading = document.getElementById('codex-reading');
    const middle = document.getElementById('codex-middle');
    if (!panel || !reading || !middle) return;
    const w = panel.getBoundingClientRect().width || panel.offsetWidth || 0;
    // Wide when the width can't be measured (headless / not yet laid out).
    this._narrow = w > 0 && w < NARROW_BREAKPOINT;
    if (this._narrow) {
      // The list takes the remaining width; the reading pane shows only when an entry is open.
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

  _renderHeader() {
    const prog = this._codex.getProgress();
    const el = document.getElementById('codex-progress');
    if (el) el.textContent = `${prog.unlocked}/${prog.total} briefings unlocked (${prog.percentage}%)`;
    const fill = document.getElementById('codex-progress-fill');
    if (fill) fill.style.width = `${prog.percentage}%`;
  }

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

      // Track tabs have no category progress: show their entry count.
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
          // An action, not a category: no progress badge.
          countEl.textContent = '';
        } else if (typeof this._codex.getCategoryProgress === 'function') {
          const p = this._codex.getCategoryProgress(cat);
          countEl.textContent = `${p.unlocked}/${p.total}`;
        }
        countEl.style.color = isSel ? accent : '#557';
      }
    }
  }

  /** @private The current list (search / track / category) with filter+sort applied; shared by the list and
   * Prev/Next so they stay in lockstep.
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

  _renderEntryList() {
    const listEl = document.getElementById('codex-entry-list');
    if (!listEl) return;

    const { entries, isTrack } = this._currentListEntries();

    listEl.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { color: '#667', fontSize: '13px', padding: '18px 14px' });
      empty.textContent = this._searchQuery
        ? `No topics match “${this._searchQuery}”. Try a shorter word, or clear the search to browse by category.`
        : 'No topics match the current filter.';
      listEl.appendChild(empty);
    }
    // Dim reassurance banner when the whole list is locked (turns a wall of LOCKED into "these unlock as you fly").
    if (this._shouldShowZeroUnlockedBanner(entries)) {
      const banner = document.createElement('div');
      banner.className = 'codex-zero-unlocked-banner';
      Object.assign(banner.style, {
        color: '#7c9', fontSize: '12px', lineHeight: '1.4',
        padding: '10px 12px', margin: '2px 6px 6px',
        background: 'rgba(90,220,150,0.06)',
        border: '1px solid rgba(90,220,150,0.2)', borderRadius: '4px',
        pointerEvents: 'none',
      });
      banner.textContent = 'Locked for now. Entries unlock as you fly. Open one to see how.';
      listEl.appendChild(banner);
    }
    entries.forEach((entry, i) => listEl.appendChild(this._makeRow(entry, i)));

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

  /** @private Only for the default `all` filter with no search (elsewhere it would be noise), and only when EVERY
   * entry is locked. Pure.
   * @param {Array<object>} entries the already filter/sort-resolved list
   */
  _shouldShowZeroUnlockedBanner(entries) {
    if (this._searchQuery) return false;
    if (this._filter !== 'all') return false;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    return entries.every(e => !e.unlocked);
  }

  /** @private Hover `title` attribute (leading space) for a locked row; `` when unlocked. Double-quoted, `"` escaped
   * via escapeHtml. Pure.
   * @returns {string} e.g. ` title="How to unlock: Catch 3 debris."`
   */
  _lockedRowTitleAttr(entry) {
    const text = this._lockedRowTitleText(entry);
    return text ? ` title="${escapeHtml(text)}"` : '';
  }

  /** @private Plain tooltip text ('' when unlocked), so `_makeRow` can set row.title without attr escaping. Pure. */
  _lockedRowTitleText(entry) {
    if (!entry || entry.unlocked) return '';
    const hint = GestureHints.glassWords(entry.unlockHint || 'Discover through gameplay.');
    return `How to unlock: ${hint}`;
  }

  /** @private Title + one-liner are ALWAYS visible (the codex is a syllabus); locked rows are dimmed with a LOCKED
   * text pip. The entry's data `icon` is never rendered.
   */
  _makeRow(entry, index) {
    const row = document.createElement('div');
    row.className = 'codex-row';
    row.dataset.id = entry.id;

    const isLocked = !entry.unlocked;
    const isNew = entry.unlocked && !entry.seen;

    const titleText = this._lockedRowTitleText(entry);
    if (titleText) row.title = titleText;

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
      ? `<span title="new" style="flex-shrink:0;align-self:center;font-size:10px;font-weight:bold;color:${accent};letter-spacing:0.08em;text-shadow:0 0 6px ${accent};">NEW</span>`
      : (isLocked
        ? `<span title="locked" class="codex-locked-pip" style="flex-shrink:0;align-self:center;font-size:10px;font-weight:bold;color:#667;letter-spacing:0.08em;padding:0 4px;border:1px solid #445;border-radius:2px;">LOCKED</span>`
        : '');

    row.innerHTML = `
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-size:13px;font-weight:bold;color:${isLocked ? '#9ab' : '#eee'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${entry.title}</span>
        <span style="display:block;font-size:11px;line-height:1.35;color:#889;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:${isLocked ? 0.6 : 0.85};">${GestureHints.glassWords(entry.shortText)}</span>
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
    // Click is delegated on #codex-entry-list (see _buildDOM).
    return row;
  }

  /** @private Auto-select so the reading pane is never empty on open: the first list entry, or the `_pendingOpenId`
   * deep-link target (even in narrow mode, where it opens the reading pane). */
  _selectFirstEntry() {
    this._mapMode = false;
    const { entries } = this._currentListEntries();
    if (!entries.length) {
      this._selectedEntry = null;
      this._clearSeenTimer();
      this._renderEmptyReading();
      return;
    }
    if (this._pendingOpenId) {
      const target = entries.find(e => e.id === this._pendingOpenId)
        || (this._codex.getEntry ? this._codex.getEntry(this._pendingOpenId) : null);
      if (target) {
        this._selectEntry(target, { focusPane: this._narrow });
        return;
      }
    }
    if (this._narrow) {
      // Narrow: list first, no auto-opened reading pane.
      this._selectedEntry = null;
      this._clearSeenTimer();
      this._applyResponsiveLayout();
      return;
    }
    this._selectEntry(entries[0], { focusPane: false });
  }

  /** @private After a filter/sort change, keep the reading position if the selected entry survives the new list,
   * else fall back to the first entry. */
  _reselectAfterListChange() {
    const { entries } = this._currentListEntries();
    if (this._selectedEntry && entries.some(e => e.id === this._selectedEntry.id)) {
      // _renderEntryList already recomputed _focusIdx; don't re-arm the seen timer.
      return;
    }
    this._selectFirstEntry();
  }

  /** @private Select an entry: update focus, render its reading pane, and (narrow mode) swap the list for the pane.
   * @param {{focusPane?:boolean}} [opts]
   */
  _selectEntry(entry, opts = {}) {
    if (!entry) return;
    // Any fresh selection exits map mode.
    this._mapMode = false;
    this._selectedEntry = entry;
    // "from: <part>" belongs to the page the deep link opened; any other selection (a chip, the list) drops it.
    this._via = (this._pendingVia && this._pendingOpenId === entry.id) ? this._pendingVia : null;
    const { entries } = this._currentListEntries();
    const idx = entries.findIndex(e => e.id === entry.id);
    // Entry not in the current list (a RELATED chip to one the filter hides): -1, so no stale row lights.
    this._focusIdx = idx >= 0 ? idx : -1;
    this._applyRowFocus();
    this._renderReading(entry);
    if (this._pendingAnchor && this._pendingOpenId === entry.id) {
      const anchor = this._pendingAnchor;
      this._pendingAnchor = null;
      this._landAnchor(anchor);
    }
    // Scrubbing to another entry before the dwell fires cancels the emit.
    this._armSeenTimer(entry);
    if (this._narrow) {
      this._applyResponsiveLayout(); // hides the list, shows the pane
    }
    if (opts.focusPane) {
      const reading = document.getElementById('codex-reading');
      if (reading && typeof reading.focus === 'function') { try { reading.focus(); } catch (_) {} }
    }
  }

  /**
   * @private Land a deep link's anchor on the just-rendered page. Only `'warning'` is known: scroll `.codex-warning`
   * into view (`block: 'end'`, the LAST block of the page; scrollIntoView may be absent in a minimal DOM) and give it
   * WARNING_LANDED_CLASS for WARNING_LANDED_MS through a tracked timer (a second landing re-arms; hide() clears).
   */
  _landAnchor(anchor) {
    if (anchor !== 'warning') return;
    const reading = document.getElementById('codex-reading');
    const box = (reading && typeof reading.querySelector === 'function')
      ? reading.querySelector('.codex-warning') : null;
    if (!box) return;
    if (typeof box.scrollIntoView === 'function') {
      try { box.scrollIntoView({ block: 'end' }); } catch (_) { /* layout */ }
    }
    this._clearLanded();
    if (box.classList && typeof box.classList.add === 'function') box.classList.add(WARNING_LANDED_CLASS);
    this._landedEl = box;
    this._landedTimer = setTimeout(() => {
      this._landedTimer = null;
      this._clearLanded();
    }, WARNING_LANDED_MS);
  }

  _clearLanded() {
    if (this._landedTimer != null) {
      clearTimeout(this._landedTimer);
      this._landedTimer = null;
    }
    const el = this._landedEl;
    this._landedEl = null;
    if (el && el.classList && typeof el.classList.remove === 'function') el.classList.remove(WARNING_LANDED_CLASS);
  }

  /** @private Test seam: swap the timer scheduler/canceller for spies. */
  _setSeenTimerHooks(schedule, cancel) {
    if (typeof schedule === 'function') this._scheduleSeen = schedule;
    if (typeof cancel === 'function') this._cancelSeen = cancel;
  }

  /** @private Only unlocked, unseen entries arm; the previous dwell is void. */
  _armSeenTimer(entry) {
    this._clearSeenTimer();
    if (!entry || !entry.unlocked || entry.seen) return;
    const id = entry.id;
    this._seenTimer = this._scheduleSeen(() => {
      this._seenTimer = null;
      eventBus.emit(Events.CODEX_VIEWED, { id });
    }, SEEN_DWELL_MS);
  }

  _clearSeenTimer() {
    if (this._seenTimer != null) {
      this._cancelSeen(this._seenTimer);
      this._seenTimer = null;
    }
  }

  _showList() {
    if (!this._narrow) return;
    this._selectedEntry = null;
    this._clearSeenTimer();
    this._applyResponsiveLayout();
    this._applyRowFocus();
  }

  /** @private Locked/unlocked filter and sort. A learning path is an authored ordered narrative: its sequence is
   * always kept (`isTrack`; the sort control is hidden for tracks, see _renderFilterBar).
   */
  _applyFilterSort(entries, isTrack = false) {
    let out = entries;
    if (this._filter === 'unlocked') out = out.filter(e => e.unlocked);
    else if (this._filter === 'locked') out = out.filter(e => !e.unlocked);

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
    return out;
  }

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

  /** @private Reflect _filter/_sort on the bar's buttons; `isTrack` hides the Sort group. */
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

  _renderEmptyReading() {
    const reading = document.getElementById('codex-reading');
    if (!reading) return;
    reading.innerHTML = `
      <div style="max-width:700px;margin:0 auto;color:#667;font-size:14px;
        padding:40px 0;text-align:center;font-style:italic;">
        ${this._searchQuery ? `No topics match “${this._searchQuery}”.` : 'Select a topic to read its briefing.'}
      </div>`;
  }

  /** @private The reading pane. Locked entries show only QUICK LOOK + the how-to-unlock panel; WARNING is always LAST. */
  _renderReading(entry) {
    const reading = document.getElementById('codex-reading');
    if (!reading) return;

    const isLocked = !entry.unlocked;

    const catMeta = this._catMeta(entry.category);
    const accent = catMeta.color || '#00d4ff';
    const accentRGB = this._hexToRgb(accent);
    const accentBg = (a) => `rgba(${accentRGB.r},${accentRGB.g},${accentRGB.b},${a})`;

    // Ego-map mode replaces the article. Unlocked only: guarded so a stray toggle can't strand the pane.
    if (this._mapMode && entry.unlocked) {
      this._renderEgoMap(entry, { accent, accentBg });
      return;
    }

    const sectionHeader = (text, color) =>
      `<div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;
        color:${color || '#778'};margin:0 0 8px;">${text}</div>`;

    const backHtml = this._narrow
      ? `<div id="codex-back-btn" style="cursor:pointer;color:#00d4ff;font-size:13px;margin-bottom:16px;
          display:inline-block;padding:5px 12px;border:1px solid rgba(0,212,255,0.2);border-radius:3px;
          transition:background 0.15s;">← Back to list</div>`
      : '';

    const fromHtml = this._via
      ? `<div class="codex-from" style="font-size:12px;color:#889;margin-bottom:6px;">from: ${this._via}</div>`
      : '';
    const titleHtml = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
        <div style="flex:1;min-width:0;">
          ${fromHtml}
          <div style="font-family:var(--font-ui);font-size:22px;font-weight:700;color:${isLocked ? '#9ab' : '#eee'};">${entry.title}</div>
          <div class="codex-cat" style="display:flex;align-items:center;gap:6px;font-size:12px;color:${accent};opacity:0.85;">${categoryLabelHtml(catMeta.label, catMeta.swatch)}</div>
        </div>
        ${entry.unlocked ? this._mapToggleHtml('MAP', accent, accentBg) : ''}
      </div>`;

    // QUICK LOOK: the ELI5 lead, always shown (even when locked).
    const quickLookHtml = `
      <div style="margin-bottom:22px;">
        ${sectionHeader('QUICK LOOK', accent)}
        <div style="font-family:var(--font-ui);font-size:16px;color:#aaddff;line-height:1.6;
          padding:12px 16px;background:${accentBg(0.06)};border-left:3px solid ${accentBg(0.5)};
          border-radius:2px;">${decorateGlossary(GestureHints.glassWords(entry.shortText), { once: true })}</div>
      </div>`;

    // Part portrait via `portraitFor` (see _getPortrait); a miss renders nothing and the prose takes the full width.
    // Narrow mode stacks the image above the prose; wide mode floats it right of the QUICK LOOK / HARDWARE / BRIEFING lead.
    const portrait = this._getPortrait(entry);
    const portraitHtml = (portrait && portrait.dataUrl)
      ? `<img src="${portrait.dataUrl}" alt=""
           style="display:block;width:${this._narrow ? '100%' : '260px'};height:auto;
             ${this._narrow ? 'margin:0 0 18px;' : 'float:right;flex-shrink:0;margin:0 0 14px 22px;'}
             border:1px solid ${accentBg(0.35)};border-radius:4px;">`
      : '';

    // HARDWARE: the matched part's mass + spec lines, from the callout part's EXISTING fields only, never invented.
    // Absent fields are omitted; no facts, no section. Unlocked only (_getPortrait returns null while locked).
    let hardwareHtml = '';
    if (portrait) {
      const rows = [];
      if (typeof portrait.massKg === 'number') rows.push(`Mass: ${portrait.massKg} kg`);
      for (const s of (portrait.specs || [])) rows.push(s);
      if (rows.length) {
        hardwareHtml = `
          <div style="margin-bottom:22px;">
            ${sectionHeader('HARDWARE', accent)}
            <div style="padding:12px 16px;border-radius:4px;
              background:rgba(0,0,0,0.35);border:1px solid ${accentBg(0.25)};
              font-family:var(--font-mono);font-size:13px;color:#cde;line-height:1.7;">${rows.join('<br>')}</div>
          </div>`;
      }
    }

    // TECH LEVEL: only when not yet flight-proven (below Constants.TRL.FLIGHT_PROVEN_MIN).
    const dTrl = entry.trl;
    let trlHtml = '';
    if (typeof dTrl === 'number' && dTrl < Constants.TRL.FLIGHT_PROVEN_MIN) {
      const col = trlToBadgeColor(dTrl, Constants.TRL);
      const lbl = trlToLabel(dTrl, Constants.TRL);
      const rat = (!isLocked && entry.trlRationale) ? entry.trlRationale : '';
      trlHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('TECH LEVEL', col)}
          <div class="codex-related-chip" data-id="tech_level"
               title="Tech Level (real-world readiness) ${dTrl}. ${lbl}. Click to read 'Tech Level' in the Playbook."
               style="display:flex;align-items:center;gap:10px;cursor:pointer;
                      padding:8px 12px;border:1px solid ${col};border-radius:3px;
                      background:rgba(0,0,0,0.35);font-size:13px;${isLocked ? 'opacity:0.7;' : ''}">
            <span style="font-weight:bold;letter-spacing:0.05em;color:${col};
                         padding:2px 8px;border:1px solid ${col};border-radius:2px;
                         background:rgba(0,0,0,0.35);">${techLevelBadgeText(dTrl)}</span>
            <span style="color:${col};font-weight:bold;letter-spacing:0.04em;">${lbl}</span>
            ${rat ? `<span style="color:#888;font-style:italic;flex:1;">${rat}</span>` : ''}
            ${isLocked ? '<span style="color:#667;font-style:italic;flex:1;text-align:right;">details locked</span>' : ''}
          </div>
        </div>`;
    }

    // BRIEFING (fullText): unlocked only; locked shows the how-to-unlock panel.
    const hint = GestureHints.glassWords(entry.unlockHint || 'Discover through gameplay.');
    let briefingHtml;
    if (isLocked) {
      briefingHtml = `
        <div style="margin-bottom:22px;">
          <div style="font-size:13px;color:#ffaa00;line-height:1.6;
            padding:10px 14px;border:1px dashed rgba(255,170,0,0.4);border-radius:3px;">
            <b>LOCKED · How to unlock:</b> ${hint}
          </div>
          <div style="font-family:var(--font-ui);font-size:14px;color:#667;font-style:italic;line-height:1.6;margin-top:12px;">
            Full briefing unlocks when you encounter this in flight.
          </div>
        </div>`;
    } else {
      briefingHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('BRIEFING')}
          <div style="font-family:var(--font-ui);font-size:15px;color:#ccc;line-height:1.8;white-space:pre-wrap;">${decorateGlossary(GestureHints.glassWords(entry.fullText), { once: true })}</div>
          ${this._verifiedStampHtml(entry)}
        </div>`;
    }

    let realWorldHtml = '';
    let formulaHtml = '';
    if (!isLocked) {
      if (entry.realWorld) {
        realWorldHtml = `
          <div style="margin-bottom:22px;">
            ${sectionHeader('IN THE REAL WORLD', accent)}
            <div style="padding:12px 16px;border-radius:4px;
              background:${accentBg(0.06)};border:1px solid ${accentBg(0.25)};
              font-family:var(--font-ui);font-size:14px;color:#cde;line-height:1.6;">${decorateGlossary(GestureHints.glassWords(entry.realWorld), { once: true })}</div>
          </div>`;
      }
      if (entry.formula) {
        formulaHtml = `
          <div style="margin-bottom:22px;">
            ${sectionHeader('FORMULA')}
            <div style="padding:10px 14px;border-radius:4px;
              background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.12);
              font-size:15px;color:#e8f4ff;letter-spacing:0.02em;
              font-family: var(--font-mono);overflow-x:auto;">${entry.formula}</div>
          </div>`;
      }
    }

    // RELATED chips: locked relateds still navigate; a LOCKED text tag marks them, never a glyph.
    const related = (typeof this._codex.getRelated === 'function')
      ? this._codex.getRelated(entry.id)
      : [];
    let relatedHtml = '';
    if (related.length) {
      const chips = related.map(r => this._relatedChipHtml(r.id, !r.unlocked, accentBg,
        `${r.title}${!r.unlocked ? LOCKED_TAG_HTML : ''}`)).join('');
      relatedHtml = `
        <div style="margin-bottom:22px;">
          ${sectionHeader('RELATED')}
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>
        </div>`;
    }

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

    // WARNING: the manual's authored notice, a STEADY red box printed LAST (print, not a live alarm: no pulse, no
    // animation; THREAT red is the ink, not a channel). Unlocked only, when `entry.warning` exists (CodexSystem._buildEntry).
    const warningHtml = (!isLocked && entry.warning)
      ? `<div class="codex-warning" style="margin-top:18px;padding:10px 14px;
           border:1px solid rgba(255,68,34,0.6);border-left:4px solid #ff4422;
           background:rgba(255,68,34,0.08);border-radius:3px;font-family:var(--font-mono);
           font-size:13px;line-height:1.5;color:#ff4422;"><span style="font-weight:700;letter-spacing:0.14em;
           margin-right:10px;">WARNING</span>${entry.warning}</div>`
      : '';

    reading.innerHTML = `
      <div style="max-width:700px;margin:0 auto;">
        ${backHtml}
        ${entry.unlocked ? this._completionBannerHtml(entry, accent) : ''}
        ${titleHtml}
        ${portraitHtml}
        ${quickLookHtml}
        ${hardwareHtml}
        ${briefingHtml}
        ${trlHtml}
        ${realWorldHtml}
        ${formulaHtml}
        ${relatedHtml}
        ${entry.unlocked ? this._loggedLineHtml(entry) : ''}
        ${entry.unlocked ? this._curiousNextHtml(entry, { accent, accentBg }, new Set(related.map(r => r.id))) : ''}
        ${prevNextHtml}
        ${warningHtml}
      </div>
    `;

    ensureGlossaryCss();
    delegateGlossaryClicks(reading);

    const backBtn = reading.querySelector('#codex-back-btn');
    if (backBtn) {
      backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'rgba(0,212,255,0.1)'; });
      backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none'; });
      backBtn.addEventListener('click', () => this._showList());
    }

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

  _verifiedStampHtml(entry) {
    const lv = entry.lastVerified;
    if (!lv || typeof lv !== 'string') return '';
    return `<div style="margin-top:10px;font-size:10px;letter-spacing:0.08em;
      color:#566;">VERIFIED ${lv}</div>`;
  }

  /**
   * @private The entry's part portrait (JPEG data URL) + the matched part's `massKg` / `specs`, ONE render per entry
   * id (a re-render reuses the cache). Existing fields only, never invented (the LibraryPane rule). Three silent
   * text-only null paths:
   *   1. no `portraitFor` dep, a locked entry, or a concept entry the adapter cannot match to a hull part;
   *   2. `portraitFor` returns null (no near pass / near-field roots, e.g. the reader opened from the menu where no
   *      ship exists, or the near field is off on the floor);
   *   3. the callback throws (wrapped here AND at the call site: the reader must never show a broken frame).
   * @returns {{dataUrl:string, massKg?:number, specs?:string[]}|null}
   */
  _getPortrait(entry) {
    if (!this._portraitFor || !entry || !entry.unlocked) return null;
    if (this._portraitCache && this._portraitCache.id === entry.id) return this._portraitCache.result;
    let result = null;
    try {
      const r = this._portraitFor(entry);
      if (r && r.canvas && typeof r.canvas.toDataURL === 'function'
        && Number.isFinite(r.canvas.width) && r.canvas.width > 0
        && Number.isFinite(r.canvas.height) && r.canvas.height > 0) {
        const out = { dataUrl: r.canvas.toDataURL('image/jpeg', 0.85) };
        if (typeof r.massKg === 'number') out.massKg = r.massKg;
        if (Array.isArray(r.specs)) out.specs = r.specs.filter(s => typeof s === 'string' && s);
        result = out;
      }
    } catch (_) { result = null; /* text-only, silent */ }
    this._portraitCache = { id: entry.id, result };
    return result;
  }

  /** @private LOGGED stamp (when/where first unlocked), e.g. "LOGGED  T+02:14 · 782 km"; empty with no captured
   * unlock context (startUnlocked / reference entries, older saves). */
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
    return `<div style="margin-top:6px;font-size:10px;letter-spacing:0.08em;
      color:#566;">LOGGED  T+${clock}${alt}</div>`;
  }

  /** @private Banner when the entry's category is 100% unlocked. Subtle, accent tinted, no reward grammar. */
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

  /** @private The map/read toggle pill, shared by the article header (MAP) and the map header (READ). The two paths
   * are mutually exclusive full-innerHTML replaces, so the shared `codex-map-toggle` id never collides.
   * @param {(a:number)=>string} accentBg
   */
  _mapToggleHtml(label, accent, accentBg) {
    return `<span id="codex-map-toggle" tabindex="0" role="button"
      style="cursor:pointer;flex-shrink:0;color:${accent};font-size:12px;padding:6px 12px;
        border:1px solid ${accentBg(0.35)};border-radius:14px;transition:background 0.15s;
        white-space:nowrap;">${label}</span>`;
  }

  /** @private "Curious next?" chips at the pane foot: up to 2 from `entry.related` in array order, locked first
   * (from the unlock hint), then unlocked-but-unseen. Reuses `.codex-related-chip` so click delegation works.
   * Callers gate on `entry.unlocked`.
   * Picks already shown as RELATED chips on the same page are dropped (they were the same chips twice, L16); none left
   * → no strip.
   * @param {{accent:string, accentBg:(a:number)=>string}} theme
   * @param {Set<string>} [shownIds] ids of the RELATED chips on the page
   */
  _curiousNextHtml(entry, { accent, accentBg }, shownIds = new Set()) {
    if (!entry || !entry.unlocked) return '';
    const related = (typeof this._codex.getRelated === 'function')
      ? (this._codex.getRelated(entry.id) || [])
      : [];
    if (!related.length) return '';

    const locked = related.filter(r => r && !r.unlocked && !shownIds.has(r.id));
    const unseen = related.filter(r => r && r.unlocked && !r.seen && !shownIds.has(r.id));
    const picks = [];
    for (const r of locked) { if (picks.length >= 2) break; picks.push({ r, kind: 'locked' }); }
    for (const r of unseen) { if (picks.length >= 2) break; picks.push({ r, kind: 'unseen' }); }
    if (!picks.length) return '';

    const chips = picks.map(({ r, kind }) => {
      const hint = GestureHints.glassWords(r.unlockHint || 'Discover through gameplay.');
      const text = (kind === 'locked')
        ? `Locked: ${r.title}. To unlock: ${hint}`
        : `${r.title} is in SPECS, unread.`;
      const inner = `<span>${text}</span>`;
      return this._relatedChipHtml(r.id, kind === 'locked', accentBg, inner,
        'gap:6px;padding:7px 12px;line-height:1.4;');
    }).join('');

    return `<div style="margin-top:18px;">
      <div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;color:${accent};
        margin:0 0 8px;">CURIOUS NEXT?</div>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;">${chips}</div>
    </div>`;
  }

  /** @private Chip markup shared by RELATED and CURIOUS NEXT; the class + data-id keep click delegation (jumpTo)
   * working. `inner` is the pre-built contents; `extraStyle` overrides gap/padding/line-height.
   * @param {(a:number)=>string} accentBg
   */
  _relatedChipHtml(id, locked, accentBg, inner, extraStyle = 'gap:5px;padding:5px 11px;') {
    return `<span class="codex-related-chip" data-id="${id}"
      style="display:inline-flex;align-items:center;cursor:pointer;
        border-radius:14px;font-size:12px;${extraStyle}
        border:1px solid ${locked ? 'rgba(255,255,255,0.14)' : accentBg(0.4)};
        background:${locked ? 'rgba(255,255,255,0.03)' : accentBg(0.08)};
        color:${locked ? '#89a' : '#cde'};transition:all 0.15s;">${inner}</span>`;
  }

  /** @private Enter map mode on `entry`. Does NOT go through `_selectEntry` (it would exit map mode and re-arm the
   * seen-dwell timer). */
  _enterMapMode(entry) {
    if (!entry || !entry.unlocked) return;
    this._mapMode = true;
    this._mapFocusId = entry.id;
    this._renderReading(entry);
  }

  /** @private Re-centre the map on a node without leaving map mode (no dwell timer). */
  _recenterMap(id) {
    const target = (typeof this._codex.getEntry === 'function') ? this._codex.getEntry(id) : null;
    if (!target || !target.unlocked) return;
    this._mapFocusId = id;
    // _mapMode is still true, so _renderReading routes back into _renderEgoMap.
    this._renderReading(target);
  }

  /** @private The reading pane as an SVG ego-map. Click a node: re-centre; click the CENTRED node, dblclick or Enter:
   * openEntry (exits map). Nodes are focusable for Enter. Locked nodes are dimmed, dashed, labelled [LOCKED]. No
   * glyphs, physics, pan or zoom.
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

    // Two layers: every label is painted BEFORE (under) every circle, so a circle always wins a tap over another
    // node's label covering it (SVG hit-testing goes to the last-painted element). A label stays tappable where it
    // covers nothing.
    const nodeStyle = (n) => {
      const isFocus = n.ring === 0;
      const r = isFocus ? 34 : (n.ring === 1 ? 26 : 20);
      return { isFocus, r, op: n.ring === 2 ? 0.35 : 1, cursor: isFocus ? 'default' : 'pointer' };
    };
    const labelSvg = nodes.map(n => {
      const { isFocus, r, op, cursor } = nodeStyle(n);
      const labelY = n.y + r + 16;
      const label = `${n.locked ? '[LOCKED] ' : ''}${n.title}`;
      const labelColor = n.locked ? '#89a' : (isFocus ? '#eee' : '#bcd');
      return `<text class="codex-map-label" data-id="${n.id}" data-ring="${n.ring}"
        x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle"
        font-size="12" fill="${labelColor}" opacity="${op}"
        style="font-family:inherit;cursor:${cursor};">${label}</text>`;
    }).join('');

    const nodeSvg = nodes.map(n => {
      const { isFocus, r, op, cursor } = nodeStyle(n);
      const stroke = isFocus ? accent : (n.locked ? '#556' : accentBg(0.6));
      const fill = isFocus ? accentBg(0.18) : 'rgba(10,14,20,0.9)';
      // The text is on the label layer, so the focusable group carries the name itself (screen readers).
      const name = escapeHtml(`${n.locked ? '[LOCKED] ' : ''}${n.title}`);
      return `<g class="codex-map-node" data-id="${n.id}" data-ring="${n.ring}" aria-label="${name}"
        tabindex="0" style="cursor:${cursor};outline:none;" opacity="${op}">
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}"
          fill="${fill}" stroke="${stroke}" stroke-width="${isFocus ? 2.5 : 1.5}"
          ${n.locked ? 'stroke-dasharray="4 3"' : ''} />
      </g>`;
    }).join('');


    reading.innerHTML = `
      <div style="max-width:100%;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
          <div style="flex:1;">
            <div style="font-size:11px;letter-spacing:0.14em;font-weight:bold;color:${accent};">CONNECTIONS</div>
            <div style="font-size:16px;font-weight:bold;color:#eee;">${entry.title}</div>
            <div style="font-size:11px;color:#889;margin-top:2px;">${GestureHints.isGlass() ? 'Tap a node to center it · tap the center one to open' : 'Click a node to re-center · double-click or Enter to open'}</div>
          </div>
          ${this._mapToggleHtml('READ', accent, accentBg)}
        </div>
        <svg viewBox="0 0 ${VW} ${VH}" width="100%"
          style="display:block;max-height:70vh;background:rgba(0,0,0,0.25);
            border:1px solid ${accentBg(0.2)};border-radius:6px;"
          preserveAspectRatio="xMidYMid meet">
          <g>${edgeSvg}</g>
          <g class="codex-map-labels">${labelSvg}</g>
          <g class="codex-map-circles">${nodeSvg}</g>
        </svg>
      </div>`;

    // READ returns to the article: re-selecting the entry clears _mapMode and re-arms the seen timer.
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

    reading.querySelectorAll('.codex-map-node').forEach(g => {
      const id = g.dataset.id;
      const isFocus = g.dataset.ring === '0';
      // A tap on the centred node opens it (double-tap is unreliable on iPad Safari); a tap on any other node moves it
      // to the centre. A desktop double-click that opens twice is harmless (openEntry re-selects the same entry).
      if (isFocus) {
        g.addEventListener('click', () => this._openFromMap(id));
      } else {
        g.addEventListener('click', () => this._recenterMap(id));
      }
      g.addEventListener('dblclick', () => this._openFromMap(id));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._openFromMap(id); }
      });
    });

    // A label acts like its own node. Enter and focus stay on the circle's group (a <text> is not focusable).
    reading.querySelectorAll('.codex-map-label').forEach(t => {
      const id = t.dataset.id;
      const isFocus = t.dataset.ring === '0';
      t.addEventListener('click', () => (isFocus ? this._openFromMap(id) : this._recenterMap(id)));
      t.addEventListener('dblclick', () => this._openFromMap(id));
    });
  }

  /** @private #rrggbb / #rgb to {r,g,b}; the codex cyan if malformed. */
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

  /** @private */
  _setupListeners() {
    // Capture phase, so it runs before InputManager's codex intercept. Typing in the search box is left alone.
    window.addEventListener('keydown', (e) => {
      if (!this._visible) return;
      const tgt = e.target;
      const inSearch = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA');

      // ESC in the search box blurs the field instead of closing.
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
        if (this._narrow && this._selectedEntry) {
          this._showList();
        } else {
          this._requestClose();
        }
        return;
      }

      if (inSearch) return; // don't hijack typing

      if (e.code === 'Slash') {
        e.stopImmediatePropagation(); e.preventDefault();
        const input = document.getElementById('codex-search');
        if (input && typeof input.focus === 'function') input.focus();
        return;
      }

      // Arrows step the selection (reading follows); Enter focuses the pane; Home/End jump to the list ends.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End', 'Backspace'].includes(e.code)) {
        e.stopImmediatePropagation(); e.preventDefault();
        this._handleListKey(e.code);
      }
    }, true);

    eventBus.on(Events.CODEX_UNLOCKED, () => {
      if (this._visible) {
        this._renderHeader();
        this._renderEntryList();
      }
    });

    // Debounced: re-evaluate the 3-column / 2-pane breakpoint while open.
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

  _onResize() {
    const wasNarrow = this._narrow;
    this._applyResponsiveLayout();
    if (this._narrow !== wasNarrow && this._selectedEntry) {
      // The Back button is narrow-only and baked in at render time.
      this._renderReading(this._selectedEntry);
    }
  }

  _handleListKey(code) {
    const { entries } = this._currentListEntries();
    if (!entries.length) return;

    if (code === 'Backspace') {
      if (this._narrow && this._selectedEntry) this._showList();
      return;
    }

    // Enter moves reading focus off the list (accessibility); in narrow mode it shows the pane.
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
    // Narrow mode keeps the list visible while arrowing; only Enter/click opens the pane.
    if (this._narrow) {
      this._applyRowFocus();
    } else {
      this._selectEntry(entries[idx]);
    }
  }
}

export default CodexViewerUI;
