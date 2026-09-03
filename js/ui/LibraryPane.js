/**
 * LibraryPane.js — Wave 5 (Session B): the TECH LIBRARY pane, the right
 * workbench pane on F3 (docs/ladder/08-workbench.md §2 "TECH LIBRARY pane" +
 * §3; 01-numbers.md "Workbench panes"; 03-plan.md "Wave 5 — GO").
 *
 * Built on the RefitPane/ProxContextPanel house pattern: a SELF-CONTAINED DOM
 * pane (build lazily, never at import), pure static formatters that are
 * headless-testable, the G1 innerHTML cache + the static `shouldWrite` 250 ms
 * DOM-write cap, and an injectable `now` clock. NO eventBus/Events import and
 * NO live singletons — every live read (the codex entries) and every routed
 * action (maximize, unlock request, seen mark, D10 open-signal) arrives
 * through injected deps, all optional, so the module is headless-safe and the
 * flag-off boot never constructs it.
 *
 * CONTENT: the shipped viewer's ENTRY rendered as a side pane (the adapter
 * over the shipped viewer 08-workbench §10 names) —
 *   - header: the entry's emoji icon + title + category. The §2 "photo you
 *     just took" live-frame crop is NOT built (it needs a renderer readback
 *     per open — see the Wave-5 Session-B FINDINGS); the emoji icon is the
 *     sanctioned fallback.
 *   - `shortText` — the plain-English "why it matters" line every entry has.
 *   - a generated SPECS block for HARDWARE entries (entries carrying
 *     `hardwareNames`), from the entry's EXISTING fields only (no invented
 *     data): HARDWARE (the in-game hardware names), TECH LEVEL (trl + the
 *     Constants tier label), FORMULA. Unlocked depth only, like the viewer.
 *   - `related` chips — click navigates the PANE to that entry (locked
 *     relateds show 🔒 and navigate to the locked stub, viewer parity).
 *   - MAXIMIZE — the full-screen viewer on this entry through the injected
 *     `onMaximize` (main.js routes it over the EXACT CODEX_OPEN_ENTRY path
 *     every deep link rides today; never a fork).
 *   - the Subnautica rule (§2 "clicking a locked part's card unlocks its
 *     entry"): `scanPart(part)` requests the unlock of a LOCKED part's entry
 *     through the injected `requestUnlock` — main.js routes it over the ONE
 *     existing unlock path (CODEX_UNLOCK_REQUEST → CodexSystem's queue → the
 *     ticker ack chip → CODEX_UNLOCKED). Never a second unlock mechanism;
 *     already-unlocked / unknown / briefing-less parts are safe no-ops.
 *   - locked entries render the viewer's honest locked stub: 🔒 + the
 *     entry's own `unlockHint` (full briefing stays MAXIMIZE-away once
 *     unlocked).
 *
 * READ = SEEN: an entry resting open ≥ SEEN_DWELL_MS (1500 — the shipped
 * CodexViewerUI dwell) fires the injected `onViewed(id)` once for unlocked,
 * unseen entries — main.js routes it over the SAME CODEX_VIEWED event the
 * viewer emits, so CodexSystem.markSeen is the one seen-writer and the tab's
 * unread count drops when the player actually reads. Scrubbing to another
 * entry before the dwell cancels it (the viewer's contract).
 *
 * TIMINGS (module constants — VisualLaw has no pane-timing entry yet; the
 * 01-numbers "Workbench panes" table is the canonical source until the
 * VisualLaw entries land with a later consumer per 08-workbench §9; do NOT
 * add one here): PANE_SLIDE_MS = 270 (inside the 240–300 ms law),
 * IDLE_FADE_OPACITY = 0.7 / IDLE_FADE_MS = 6000 ("idle panes fade to 70 %,
 * never vanish" — pointer wakes it), and the reduced-motion probe swaps the
 * slide for a fade (the FloorMask.js house matchMedia shape).
 *
 * LAYOUT: RIGHT pane, width clamp(380px, 28vw, 440px) (01-numbers), root
 * `#ladder-library`, header `.library-header`, edge tab `#ladder-library-tab`
 * always visible while enabled carrying the UNREAD count (unlocked, not yet
 * seen), which PULSES ONCE when a new unlock lands (reduced motion: the
 * count changes, no animation). ONE CSS variable (`--library-dir`, default 1)
 * mirrors the slide direction for RTL (the `--refit-dir` law): an RTL boot
 * sets `--library-dir:-1` (and left-anchors the pane) and every transform
 * follows. ONE_PANE_BREAKPOINT_PX = 1100 is exported for the hub's
 * below-~1100-px one-pane rule (01-numbers "One-pane breakpoint").
 *
 * @module ui/LibraryPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { trlToLabel, techLevelBadgeText } from '../core/Constants.js';

/** Pane slide duration (ms) — inside the 240–300 ms house window
 *  (01-numbers "Workbench panes"; VisualLaw pane-timing entry pending). */
export const PANE_SLIDE_MS = 270;
/** Idle panes fade to 70 %, never vanish (08-workbench §2 Motion). */
export const IDLE_FADE_OPACITY = 0.7;
/** Idle threshold before the fade applies (ms). */
export const IDLE_FADE_MS = 6000;
/** Tab pulse length (ms) — the ONE pulse a new unlock earns (§2 Grammar). */
export const TAB_PULSE_MS = 900;
/** Below this viewport width only one workbench pane opens at a time
 *  (01-numbers "One-pane breakpoint" ~1100 px); the hub enforces it. */
export const ONE_PANE_BREAKPOINT_PX = 1100;
/** Dwell before an open entry is marked seen — the shipped CodexViewerUI
 *  SEEN_DWELL_MS (CodexViewerUI.js:58), mirrored so the pane and the viewer
 *  share one reading contract. */
export const SEEN_DWELL_MS = 1500;

/** G1 write cap — the ProxContextPanel/TransferWindows house value. */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** House reduced-motion probe (the FloorMask.js:188-196 shape). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

export class LibraryPane {
  /**
   * Every dep optional; the pane is inert headless (no DOM at import, no DOM
   * without a usable doc) and never throws on a missing dep.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document to build into (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.codex] - the CodexSystem instance (getEntry /
   *   getRelated / getCategoryMeta / entries) — read-only truth
   * @param {function} [deps.onMaximize] - (id) => void (main.js: the exact
   *   CODEX_OPEN_ENTRY deep-link emit → the full-screen viewer)
   * @param {function} [deps.requestUnlock] - (id) => void (main.js: the ONE
   *   unlock path, CODEX_UNLOCK_REQUEST → CodexSystem's queue + ack chip)
   * @param {function} [deps.onViewed] - (id) => void (main.js: the shipped
   *   CODEX_VIEWED emit → CodexSystem.markSeen, the one seen-writer)
   * @param {function} [deps.onOpenChange] - (isOpen) => void (the D10
   *   calm-cap edge; main.js fans it into _syncWorkbenchPanes)
   * @param {boolean|function} [deps.reducedMotion] - override for the matchMedia probe
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = deps.now || _nowMs;
    this._codex = deps.codex || null;
    this._onMaximize = deps.onMaximize || null;
    this._requestUnlock = deps.requestUnlock || null;
    this._onViewed = deps.onViewed || null;
    this._onOpenChange = deps.onOpenChange || null;
    this._reducedMotionDep = deps.reducedMotion;

    this._enabled = false;
    this._open = false;
    this._entryId = null;         // the entry the pane is showing (null = prompt)
    this._built = false;
    this._root = null;
    this._tab = null;
    this._tabCount = null;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    this._lastTabText = null;
    // Unread/pulse state: baseline null so the FIRST refresh (boot state)
    // never pulses; only an INCREASE afterwards (= a new unlock) does.
    this._lastUnread = null;
    this._pulseTimer = null;
    this._pulseCount = 0;         // total pulses fired (tests/witness probe)
    // Idle fade state (open panes fade to 70 % after IDLE_FADE_MS, pointer wakes).
    this._lastActivityMs = this._now();
    this._idle = false;
    this._idleTimer = null;
    // Seen-dwell state (READ = SEEN, the viewer's contract).
    this._seenTimer = null;
    this._disposed = false;
  }

  // ── Static pure surface (headless-tested) ──────────────────────────────────

  /** G1 pin surface: the DOM-write cap (ms) — the house 250 ms / ≤4 Hz. */
  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /**
   * G1 pure gate (the ProxContextPanel.shouldWrite contract): structural
   * changes always write; identical structure is rate-capped.
   * @param {string} structKey @param {string|null} lastStructKey
   * @param {number} nowMs @param {number} lastWriteMs
   * @returns {boolean}
   */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  /**
   * A HARDWARE entry documents in-game hardware: it carries `hardwareNames`
   * (26 entries in data/codex.json — the callout-vocabulary bridge). Pure.
   * @param {object|null} entry
   * @returns {boolean}
   */
  static isHardware(entry) {
    return !!(entry && Array.isArray(entry.hardwareNames) && entry.hardwareNames.length > 0);
  }

  /**
   * The generated SPECS block (§2 "a generated SPECS block for hardware
   * entries") — from the entry's EXISTING fields only, no invented data:
   *   HARDWARE   — the `hardwareNames` list (what this documents in-game)
   *   TECH LEVEL — `trl` through the Constants tier vocabulary
   *   FORMULA    — the entry's own formula string
   * Rows whose field is absent are omitted; a non-hardware entry returns [].
   * Pure — locked gating is the caller's (the viewer's "unlocked depth only").
   * @param {object|null} entry
   * @returns {Array<{ k:string, v:string }>}
   */
  static specsFor(entry) {
    if (!LibraryPane.isHardware(entry)) return [];
    const rows = [];
    rows.push({ k: 'HARDWARE', v: entry.hardwareNames.join(' \u00b7 ') });
    if (typeof entry.trl === 'number') {
      rows.push({ k: 'TECH LEVEL', v: `${techLevelBadgeText(entry.trl)} \u00b7 ${trlToLabel(entry.trl)}` });
    }
    if (entry.formula) rows.push({ k: 'FORMULA', v: String(entry.formula) });
    return rows;
  }

  /**
   * The edge tab's UNREAD count: unlocked entries not yet seen — exactly the
   * viewer's NEW-pip predicate (CodexViewerUI._makeRow `isNew`). Pure.
   * @param {Array<object>|null|undefined} entries
   * @returns {number}
   */
  static unreadCount(entries) {
    let n = 0;
    for (const e of (entries || [])) {
      if (e && e.unlocked && !e.seen) n++;
    }
    return n;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isOpen() { return this._open; }
  /** @returns {boolean} */
  isEnabled() { return this._enabled; }
  /** @returns {string|null} the entry the pane is showing (null = the prompt) */
  currentEntryId() { return this._entryId; }

  /**
   * The pane's laid-out width in CSS px (its box, border-box: the
   * clamp(380px, 28vw, 440px) of 01-numbers) — 0 headless or before the root
   * is built. The number main.js NETS into the ONE
   * `CameraSystem.setLadderPaneInset` value on the onOpenChange edge (RIGHT
   * pane → negative; both panes open → 0, §2 "both panes open → centered").
   * A layout read: call it on edges only, never per frame.
   * @returns {number}
   */
  widthPx() {
    const w = this._root ? this._root.offsetWidth : 0;
    return (Number.isFinite(w) && w > 0) ? w : 0;
  }

  /**
   * Enable on F3 arrival / disable on leave (LadderController `library` dep).
   * Enabled: the edge tab shows (always visible while enabled). Disabled:
   * tab hides and the pane closes. Idempotent; headless no-op beyond state.
   * @param {boolean} on
   */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (on) {
      this._build();
      if (this._tab) this._tab.style.display = 'block';
      this.refresh();
    } else {
      if (this._tab) this._tab.style.display = 'none';
      this.close();
    }
  }

  /** Open the pane (no-op while disabled). Fires onOpenChange(true) once. */
  open() {
    if (!this._enabled || this._open) return;
    this._open = true;
    this._applyOpenState();
    this._wake();
    this.refresh();
    this._armSeenTimer();
    if (this._onOpenChange) { try { this._onOpenChange(true); } catch (_e) { /* dep */ } }
  }

  /** Close the pane. Fires onOpenChange(false) once. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._applyOpenState();
    this._clearIdleTimer();
    this._clearSeenTimer();
    if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
  }

  /** Edge-tab click: toggle. */
  toggle() { if (this._open) this.close(); else this.open(); }

  /**
   * Deep-link into the pane: show one entry and open (the REFIT card title /
   * spec term route — 03-plan §3 "tap → TECH LIBRARY slides in"; also the
   * related-chip navigation). Unknown ids keep the current view and still
   * open (never a throw, never a blank crash — the viewer's "safe no-op"
   * contract). While disabled the entry is stored for the next open.
   * @param {string} id - codex entry id
   * @returns {boolean} true when the entry resolved
   */
  openEntry(id) {
    const entry = this._entry(id);
    if (entry) {
      if (entry.id !== this._entryId) {
        this._entryId = entry.id;
        this._clearSeenTimer();
      }
    }
    this.open();
    this.refresh();
    if (this._open) this._armSeenTimer();
    return !!entry;
  }

  /**
   * The Subnautica rule (08-workbench §2: "Clicking a locked part's card
   * unlocks its entry — exploration is how the library fills"): called by the
   * hub on a HULL part/card click. A resolved, LOCKED entry fires the
   * injected requestUnlock — the ONE existing unlock path (CodexSystem's
   * queue: ticker ack chip now, chime + CODEX_UNLOCKED on the queue's own
   * schedule; the tab pulses when the unlock lands). Unlocked / unknown /
   * briefing-less parts are safe no-ops. Never opens the pane — the click's
   * visible verb stays the REFIT card (D-a).
   * @param {{ codexId?: string|null }|null} part - MotherCallouts record shape
   * @returns {boolean} true when an unlock was requested
   */
  scanPart(part) {
    const id = part && typeof part.codexId === 'string' ? part.codexId : null;
    if (!id) return false;
    const entry = this._entry(id);
    if (!entry || entry.unlocked) return false;
    if (!this._requestUnlock) return false;
    try { this._requestUnlock(entry.id); } catch (_e) { /* dep */ }
    return true;
  }

  /**
   * Recompute + repaint (G1: innerHTML cache + the 250 ms cap; structural
   * changes write immediately). Headless: computes and returns the model.
   * Called on interaction edges + the hub's CODEX_UNLOCKED refresh — never
   * per frame.
   * @returns {object} the display model
   */
  refresh() {
    const model = this._model();
    this._paintTab(model);
    if (!this._root) return model;
    const structKey = model.structKey;
    const now = this._now();
    if (!LibraryPane.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    const html = this._html(model);
    if (html !== this._lastHtml) {
      this._root.innerHTML = html;
      this._lastHtml = html;
      this._lastStructKey = structKey;
      this._lastWriteMs = now;
    }
    return model;
  }

  /** Remove every node + timer; the instance stays inert afterwards. */
  dispose() {
    this._disposed = true;
    this._clearIdleTimer();
    this._clearSeenTimer();
    this._clearPulseTimer();
    if (this._open && this._onOpenChange) {
      try { this._onOpenChange(false); } catch (_e) { /* dep */ }
    }
    this._open = false;
    if (this._root && this._root.remove) this._root.remove();
    if (this._tab && this._tab.remove) this._tab.remove();
    this._root = null;
    this._tab = null;
    this._tabCount = null;
    this._built = false;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastTabText = null;
  }

  // ── Model (pure per-call reads of the injected truth) ─────────────────────

  /** @private Guarded entry read (unknown/absent codex → null, never throws). */
  _entry(id) {
    if (!id || !this._codex || typeof this._codex.getEntry !== 'function') return null;
    try { return this._codex.getEntry(id) || null; } catch (_e) { return null; }
  }

  /** @private Guarded related read (viewer parity: resolved entries only). */
  _related(id) {
    if (!id || !this._codex || typeof this._codex.getRelated !== 'function') return [];
    try { return this._codex.getRelated(id) || []; } catch (_e) { return []; }
  }

  /** @private Category label via the codex meta (fallback: the raw key). */
  _categoryLabel(key) {
    if (!key) return '';
    try {
      const m = (this._codex && typeof this._codex.getCategoryMeta === 'function')
        ? this._codex.getCategoryMeta(key) : null;
      return (m && m.label) || String(key).replace(/_/g, ' ');
    } catch (_e) { return String(key).replace(/_/g, ' '); }
  }

  /** @private The full display model (pure reads; no DOM). */
  _model() {
    const entry = this._entry(this._entryId);
    const related = entry ? this._related(entry.id).map((r) => ({
      id: r.id, icon: r.icon, title: r.title, unlocked: !!r.unlocked,
    })) : [];
    const specs = (entry && entry.unlocked) ? LibraryPane.specsFor(entry) : [];
    let unread = 0;
    try {
      unread = LibraryPane.unreadCount(this._codex ? this._codex.entries : null);
    } catch (_e) { unread = 0; }
    const structKey = [
      this._open ? 1 : 0,
      entry ? entry.id : '',
      entry ? (entry.unlocked ? 1 : 0) : 0,
      unread,
      specs.map((s) => `${s.k}:${s.v}`).join('|'),
      related.map((r) => `${r.id}:${r.unlocked ? 1 : 0}`).join('|'),
    ].join('\u0001');
    return {
      entry,
      category: entry ? this._categoryLabel(entry.category) : '',
      specs,
      related,
      unread,
      structKey,
    };
  }

  // ── DOM (guarded; nothing at import) ───────────────────────────────────────

  /** @private Effective reduced-motion read (dep overrides the house probe). */
  _reducedMotion() {
    const dep = this._reducedMotionDep;
    if (typeof dep === 'function') { try { return !!dep(); } catch (_e) { return false; } }
    if (typeof dep === 'boolean') return dep;
    return _prefersReducedMotion();
  }

  /** @private */
  _build() {
    if (this._built || this._disposed) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return;
    this._built = true;
    const reduced = this._reducedMotion();

    // The edge tab — always visible while enabled (08-workbench §2 Grammar:
    // "LIBRARY: unread count, pulses once on a new unlock").
    const tab = doc.createElement('div');
    tab.id = 'ladder-library-tab';
    tab.style.cssText = [
      'position:absolute', 'right:0', 'top:38%', 'z-index:35',
      'padding:8px 4px 8px 6px', 'border:1px solid rgba(0,204,255,0.4)', 'border-right:none',
      'border-radius:6px 0 0 6px', 'background:rgba(0,16,32,0.85)',
      'color:' + VisualLaw.COLORS.INFO, 'cursor:pointer',
      'font-family:"Courier New",monospace', 'font-size:0.62rem', 'letter-spacing:0.08em',
      'writing-mode:vertical-rl', 'text-orientation:mixed', 'user-select:none',
      'display:none', 'pointer-events:auto',
      // The pulse animates through transition (reduced motion never sets it).
      reduced ? '' : `transition:box-shadow ${TAB_PULSE_MS / 3}ms ease`,
    ].join(';');
    // Built as real children (never innerHTML) so the count node survives
    // every repaint and fake-DOM test docs need no querySelector.
    const tabLabel = doc.createElement('span');
    tabLabel.textContent = 'LIBRARY ';
    const tabCount = doc.createElement('span');
    tabCount.className = 'library-tab-count';
    tabCount.style.cssText = `color:${VisualLaw.COLORS.VALUE};font-weight:bold`;
    tab.appendChild(tabLabel);
    tab.appendChild(tabCount);
    tab.addEventListener('click', () => { this._wake(); this.toggle(); });
    doc.body.appendChild(tab);
    this._tab = tab;
    this._tabCount = tabCount;

    // The pane root — RIGHT, 380–440 px (01-numbers), slid fully off-canvas
    // while closed. --library-dir is the ONE RTL mirror variable (the
    // --refit-dir law: an RTL boot flips it to -1 and left-anchors the pane).
    const root = doc.createElement('div');
    root.id = 'ladder-library';
    root.className = reduced ? 'library-reduced' : '';
    root.style.cssText = [
      'position:absolute', 'right:0', 'top:56px', 'bottom:96px', 'z-index:35',
      'width:clamp(380px, 28vw, 440px)', 'box-sizing:border-box',
      'padding:10px 12px', 'overflow-y:auto',
      'border:1px solid rgba(0,204,255,0.4)', 'border-right:none', 'border-radius:6px 0 0 6px',
      'background:rgba(0,16,32,0.82)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family:"Courier New",monospace', 'font-size:0.68rem', 'letter-spacing:0.05em',
      'pointer-events:auto', '--library-dir:1',
      // Slide (transform) in the normal path; the reduced-motion class swaps
      // the slide for a fade at the same duration (08-workbench §2 Motion).
      reduced
        ? `transition:opacity ${PANE_SLIDE_MS}ms ease`
        : `transition:transform ${PANE_SLIDE_MS}ms cubic-bezier(0.65,0,0.35,1), opacity 400ms ease`,
    ].join(';');
    doc.body.appendChild(root);
    this._root = root;
    this._applyOpenState();

    // Delegated interactions (one listener set — G1, the PaneHelp pattern):
    root.addEventListener('click', (e) => this._onClick(e));
    root.addEventListener('pointermove', () => this._wake());
    root.addEventListener('pointerdown', () => this._wake());
  }

  /** @private Slide/fade the root + tab to the current open state. */
  _applyOpenState() {
    const root = this._root;
    if (!root) return;
    const reduced = this._reducedMotion();
    if (reduced) {
      root.className = 'library-reduced';
      root.style.transform = 'none';
      root.style.opacity = this._open ? '1' : '0';
      root.style.visibility = this._open ? 'visible' : 'hidden';
    } else {
      root.className = '';
      // One CSS variable mirrors the slide for RTL (--library-dir: -1 flips
      // it); the RIGHT pane slides out toward +X.
      root.style.transform = this._open
        ? 'translateX(0)'
        : 'translateX(calc(var(--library-dir, 1) * 110%))';
      root.style.opacity = this._open ? '1' : '0.999'; // keep painted for the slide
      root.style.visibility = 'visible';
    }
  }

  /** @private Tab count paint (write-on-change) + the ONE new-unlock pulse. */
  _paintTab(model) {
    if (this._tabCount) {
      const text = model.unread > 0 ? String(model.unread) : '';
      if (text !== this._lastTabText) {
        this._tabCount.textContent = text;
        this._lastTabText = text;
      }
    }
    // Pulse ONCE when the unread count RISES (= a new unlock landed). The
    // boot baseline (null) never pulses; a drop (entry read) never pulses.
    if (this._lastUnread != null && model.unread > this._lastUnread) this._pulse();
    this._lastUnread = model.unread;
  }

  /** @private One tab pulse (§2: "pulses once on a new unlock"). Reduced
   *  motion: no animation — the count change is the whole signal. */
  _pulse() {
    this._pulseCount++;
    if (!this._tab || this._reducedMotion()) return;
    this._tab.style.boxShadow = `0 0 12px 2px ${VisualLaw.COLORS.VALUE}`;
    if (this._tab.classList && this._tab.classList.add) this._tab.classList.add('library-tab-pulse');
    this._clearPulseTimer();
    this._pulseTimer = setTimeout(() => this._pulseTick(), TAB_PULSE_MS);
  }

  /** @private Pulse end (timer-fired; tests drive it directly). */
  _pulseTick() {
    this._pulseTimer = null;
    if (!this._tab) return;
    this._tab.style.boxShadow = 'none';
    if (this._tab.classList && this._tab.classList.remove) this._tab.classList.remove('library-tab-pulse');
  }

  /** @private */
  _clearPulseTimer() {
    if (this._pulseTimer != null) {
      clearTimeout(this._pulseTimer);
      this._pulseTimer = null;
    }
  }

  /** @private Markup for the model (VisualLaw colors; inline styles). */
  _html(m) {
    const C = VisualLaw.COLORS;
    const parts = [];
    // Header (.library-header): the pane name + MAXIMIZE (the full-screen
    // viewer — the old F1 — one click away, never hidden).
    parts.push(
      `<div class="library-header" style="display:flex;justify-content:space-between;align-items:baseline;color:${C.PLAYER};border-bottom:1px solid rgba(0,204,255,0.25);padding-bottom:6px;margin-bottom:8px">` +
      '<span>TECH LIBRARY</span>' +
      (m.entry
        ? `<button class="library-max" data-max="${m.entry.id}" style="cursor:pointer;background:none;border:1px solid rgba(0,204,255,0.4);color:${C.INFO};font:inherit;padding:0 6px;border-radius:3px">MAXIMIZE \u2197</button>`
        : '') +
      '</div>',
    );
    if (!m.entry) {
      parts.push(
        '<div class="library-empty" style="opacity:0.7">Click a hull part or a REFIT card title to read about it.</div>',
      );
      return parts.join('');
    }
    const e = m.entry;
    const locked = !e.unlocked;
    // Entry header: emoji icon (the "photo you just took" crop is a FINDINGS
    // item — renderer readback per open) + title + category.
    parts.push(
      '<div class="library-entry-header" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">' +
      `<span style="font-size:1.6rem;line-height:1.2${locked ? ';opacity:0.6' : ''}">${e.icon}</span>` +
      '<span style="flex:1;min-width:0">' +
      `<span class="library-title" style="display:block;color:${locked ? C.INFO : C.SELECTION};font-weight:bold">${e.title}${locked ? ' \ud83d\udd12' : ''}</span>` +
      `<span style="display:block;opacity:0.6">${m.category}</span>` +
      '</span>' +
      '</div>',
    );
    // shortText — the one-line "why it matters" (always visible, the
    // syllabus rule).
    parts.push(
      `<div class="library-short" style="color:#aaddff;line-height:1.5;padding:6px 8px;background:rgba(0,204,255,0.06);border-left:2px solid rgba(0,204,255,0.5);margin-bottom:8px">${e.shortText || ''}</div>`,
    );
    if (locked) {
      // The viewer's honest locked stub: how to unlock, nothing invented.
      parts.push(
        `<div class="library-locked" style="color:${C.VALUE};border:1px dashed rgba(255,209,102,0.5);border-radius:3px;padding:6px 8px;margin-bottom:8px">` +
        `\ud83d\udd12 How to unlock: ${e.unlockHint || 'Discover through gameplay.'}` +
        '</div>',
      );
    } else if (m.specs.length) {
      // The generated SPECS block (hardware entries, unlocked depth only).
      parts.push('<div class="library-specs" style="margin-bottom:8px">');
      parts.push(`<div style="color:${C.PLAYER}">SPECS</div>`);
      for (const row of m.specs) {
        parts.push(
          `<div style="display:flex;gap:6px;padding:2px 0 2px 8px;border-top:1px solid rgba(0,204,255,0.12)">` +
          `<span style="opacity:0.6;flex-shrink:0">${row.k}</span>` +
          `<span style="opacity:0.9;overflow-wrap:anywhere">${row.v}</span>` +
          '</div>',
        );
      }
      parts.push('</div>');
    }
    // Related chips — click navigates the PANE (locked relateds keep the
    // viewer's 🔒 and navigate to the locked stub).
    if (m.related.length) {
      parts.push('<div class="library-related" style="margin-top:8px">');
      parts.push(`<div style="color:${C.PLAYER};margin-bottom:4px">RELATED</div>`);
      parts.push('<div style="display:flex;flex-wrap:wrap;gap:4px">');
      for (const r of m.related) {
        parts.push(
          `<span class="library-rel" data-rel="${r.id}" style="cursor:pointer;padding:1px 6px;border:1px solid rgba(0,204,255,0.35);border-radius:3px;${r.unlocked ? '' : 'opacity:0.6'}">` +
          `${r.icon || ''} ${r.title}${r.unlocked ? '' : ' \ud83d\udd12'}` +
          '</span>',
        );
      }
      parts.push('</div></div>');
    }
    return parts.join('');
  }

  // ── Interaction (delegated) ────────────────────────────────────────────────

  /** @private */
  _closest(el, sel) {
    return (el && typeof el.closest === 'function') ? el.closest(sel) : null;
  }

  /** @private */
  _onClick(e) {
    this._wake();
    const max = this._closest(e.target, '[data-max]');
    if (max) {
      const id = max.getAttribute('data-max');
      // MAXIMIZE = the full-screen viewer on this entry — main.js routes it
      // over the exact CODEX_OPEN_ENTRY deep-link path (never a fork).
      if (id && this._onMaximize) { try { this._onMaximize(id); } catch (_e) { /* dep */ } }
      return;
    }
    const rel = this._closest(e.target, '[data-rel]');
    if (rel) {
      const id = rel.getAttribute('data-rel');
      if (id) this.openEntry(id);
    }
  }

  // ── Seen dwell (READ = SEEN — the shipped viewer's contract) ──────────────

  /** @private */
  _clearSeenTimer() {
    if (this._seenTimer != null) {
      clearTimeout(this._seenTimer);
      this._seenTimer = null;
    }
  }

  /** @private (Re)arm the dwell for the current entry: unlocked + unseen +
   *  the pane actually open. Scrubbing/closing cancels (viewer parity). */
  _armSeenTimer() {
    this._clearSeenTimer();
    if (!this._open || this._disposed) return;
    const entry = this._entry(this._entryId);
    if (!entry || !entry.unlocked || entry.seen) return;
    this._seenTimer = setTimeout(() => this._seenTick(), SEEN_DWELL_MS);
  }

  /** @private Dwell elapsed (timer-fired; tests drive it directly): mark the
   *  rested entry seen through the injected onViewed (CODEX_VIEWED →
   *  CodexSystem.markSeen, the one seen-writer), then repaint — the unread
   *  count drop is visible at once. */
  _seenTick() {
    this._seenTimer = null;
    if (!this._open || this._disposed) return;
    const entry = this._entry(this._entryId);
    if (!entry || !entry.unlocked || entry.seen) return;
    if (this._onViewed) { try { this._onViewed(entry.id); } catch (_e) { /* dep */ } }
    this.refresh();
  }

  // ── Idle fade (open panes dim to 70 %, pointer wakes — §2 Motion) ─────────

  /** @private */
  _clearIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** @private Activity: restore full opacity + re-arm the idle window. */
  _wake() {
    this._lastActivityMs = this._now();
    if (this._idle) {
      this._idle = false;
      if (this._root) {
        this._root.style.opacity = this._open ? '1' : this._root.style.opacity;
        if (this._root.classList && this._root.classList.remove) this._root.classList.remove('library-idle');
      }
    }
    this._armIdleTimer();
  }

  /** @private */
  _armIdleTimer() {
    this._clearIdleTimer();
    if (!this._open || !this._root || this._disposed) return;
    this._idleTimer = setTimeout(() => this._idleTick(), IDLE_FADE_MS + 20);
  }

  /**
   * @private The idle beat (timer-fired; tests drive it directly with an
   * injected clock): past IDLE_FADE_MS of no activity while open → fade to
   * IDLE_FADE_OPACITY — never display:none, never visibility loss (the pane
   * "never vanishes"); otherwise re-arm for the remainder.
   */
  _idleTick() {
    this._idleTimer = null;
    if (!this._open || !this._root || this._disposed) return;
    const since = this._now() - this._lastActivityMs;
    if (since >= IDLE_FADE_MS) {
      this._idle = true;
      this._root.style.opacity = String(IDLE_FADE_OPACITY);
      if (this._root.classList && this._root.classList.add) this._root.classList.add('library-idle');
    } else {
      this._idleTimer = setTimeout(() => this._idleTick(), (IDLE_FADE_MS - since) + 20);
    }
  }
}

export default LibraryPane;
