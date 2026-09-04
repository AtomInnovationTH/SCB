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
 *   - header: the entry's emoji icon + a LEAD line + a subtitle. A HARDWARE
 *     entry (one with `hardwareNames`, the callout vocabulary) leads with the
 *     PART — the clicked callout name (`openEntry(id, { via })`, honoured
 *     only when it is one of the entry's own names) else every name it
 *     documents — and carries "briefing · <entry title> · <category>" as the
 *     subtitle, so a click on SPIN-BRAKE LASER lands on "SPIN-BRAKE LASER /
 *     briefing · Detumbling Captured Debris · Attitude" and the page confirms
 *     the click before it teaches (owner review 2026-09-03). Concept entries
 *     keep title-then-category. **The bridge line (Session D):** a HARDWARE
 *     entry's authored `hardwareNote` — one sentence naming the part and what
 *     it does on THIS ship, then handing off to the concept — renders under
 *     the header, above `shortText`; absent → nothing (never the shortText
 *     twice, never a stub); concept entries carry none. The header is topped — when the
 *     frame could be read — by **the photo you just took** (08-workbench §2;
 *     Session C, owner decision 2): a crop of the live frame around the
 *     subject, taken ONCE per open / entry change, never per frame. The
 *     read is DEFERRED ONE ANIMATION FRAME: a synchronous `drawImage` /
 *     `toDataURL` in the click task is BLANK on the shipped renderer
 *     (`preserveDrawingBuffer` is false — probed 2026-09-03: 0 of 16000
 *     crop pixels lit), while the same read inside the next rAF callback —
 *     after the game's render in that frame, before present — is the
 *     BlackFrameProbe-legal read and is valid (16000/16000) with no
 *     SceneManager change. The crop is composited onto black (the WebGL
 *     frame carries alpha 0 — the `__netShot` precedent), sampled for
 *     blankness, retried up to PHOTO_TRIES frames (a frame the loop skipped
 *     rendering reads blank), and on any failure the emoji header stands
 *     alone — the sanctioned fallback, byte-identical to Session B's header.
 *     The source (canvas + subject point) arrives through the injected
 *     `photoSource` getter; the frame scheduler through `raf`/`cancelRaf`
 *     (window's by default; absent headless → no photo, no throw).
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
 * THE LIBRARY FOLLOWS CLICKS (Wave 5 Session C — the 2026-09-03 playtest
 * "Library is blank" bug, a one-element deep-link surface, fixed at the hub):
 *   - while the pane is OPEN, every hull part / callout-card click retargets
 *     it through the SAME `openEntry(codexId)` path the REFIT title rides
 *     (main.js's flag-gated onPartClick hook — one line, no second path); a
 *     CLOSED library is never opened by a part click (D-a: the click's
 *     visible verb stays the REFIT card, 08-workbench §3 unchanged).
 *   - opening with NO entry (tab click / toggle) lands on something real
 *     instead of the prompt: the injected `subject` getter answers "what is
 *     the player looking at" — main.js chains the focused hull part's
 *     codexId (MotherCallouts.getFocusedPart, COMPONENT band) then the REFIT
 *     card's manifest deep link (RefitPane.focusedCodexId) — consulted ONLY
 *     when the pane has no entry (a shown entry survives close → re-open);
 *     unknown / null / throwing → the prompt copy stays. The pane stays
 *     eventless: it never reads MotherCallouts or the REFIT itself.
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
 * count changes, no animation). The tab sits ONE z step above the root
 * (TAB_Z_INDEX 36 over PANE_Z_INDEX 35 — Session C): the open pane slides
 * in under the tab, so the tab stays visible (08-workbench §2 "edge tabs
 * are always visible in the workbench") and a click on it toggles the pane
 * closed. ONE CSS variable (`--library-dir`, default 1)
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
/** Pane root stacking (the shipped workbench-pane layer). */
export const PANE_Z_INDEX = 35;
/** Edge tab stacking — ONE step above the root so the open pane never paints
 *  over its own tab (08-workbench §2 "edge tab always visible"; Session C). */
export const TAB_Z_INDEX = 36;
/** The photo crop: source region height as a fraction of the canvas height
 *  (16:10 — PHOTO_W × PHOTO_H output px), centred on the subject point. */
export const PHOTO_CROP_H_FRAC = 0.42;
/** Photo output size (device px of the thumbnail canvas). */
export const PHOTO_W = 320;
export const PHOTO_H = 200;
/** Frames the photo read is retried when the buffer reads blank (a frame the
 *  loop skipped rendering) before the emoji header stands alone. */
export const PHOTO_TRIES = 3;
/** Blank test: a sampled pixel "lights" when r+g+b exceeds this (the
 *  crop-probe threshold, 2026-09-03). */
const PHOTO_LIT_SUM = 24;
/** Blank test sampling stride (px) — a coarse grid, never the full crop. */
const PHOTO_SAMPLE_STRIDE = 8;

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
   * @param {function} [deps.subject] - () => codexId|null (Session C): what
   *   the player is looking at — main.js chains the focused hull part's
   *   codexId, then the REFIT card's manifest deep link. Consulted ONLY when
   *   the pane opens with NO entry (tab click / toggle); a null / unknown /
   *   throwing answer keeps the prompt copy.
   * @param {function} [deps.photoSource] - () => ({ canvas, x, y })|null
   *   (Session C, decision 2): the live render canvas + the subject's point
   *   in CANVAS (drawing-buffer) px to crop around — main.js projects the
   *   ship. Read once per photo, on the open / entry edge only.
   * @param {function} [deps.raf] - (cb) => handle: the frame scheduler for
   *   the deferred photo read (default window.requestAnimationFrame; absent →
   *   no photo, the emoji header stands alone)
   * @param {function} [deps.cancelRaf] - (handle) => void (default
   *   window.cancelAnimationFrame)
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
    this._subject = deps.subject || null;
    this._photoSource = deps.photoSource || null;
    this._raf = deps.raf !== undefined ? deps.raf
      : (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
    this._cancelRaf = deps.cancelRaf !== undefined ? deps.cancelRaf
      : (typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h) : null);
    this._reducedMotionDep = deps.reducedMotion;

    this._enabled = false;
    this._open = false;
    this._entryId = null;         // the entry the pane is showing (null = prompt)
    this._via = null;             // the clicked part's callout name behind the entry (header lead), else null
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
    // The photo you just took (Session C): { id, url } for the entry it was
    // taken for (shown only while that entry is the one on screen), the
    // pending deferred-read handle, the retry count, and the ONE reused
    // thumbnail canvas (built lazily on the first photo).
    this._photo = null;
    this._photoHandle = null;
    this._photoTry = 0;
    this._photoCanvas = null;
    this._photoCount = 0;         // photos taken (tests/witness probe)
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
   * (the MotherCallouts vocabulary — the search bridge CodexSystem uses).
   * @param {object} entry
   * @returns {boolean}
   */
  static isHardware(entry) {
    return !!(entry && Array.isArray(entry.hardwareNames) && entry.hardwareNames.length > 0);
  }

  /**
   * The entry header's two lines (owner review 2026-09-03, "labels ↔ library"
   * item 1). Players click a PART and expect the page to be about that part;
   * the codex is a concept library ("Detumbling Captured Debris" behind the
   * SPIN-BRAKE LASER), so a concept title reads as a wrong link. For a
   * hardware entry the header LEADS with the part name — the one clicked
   * (`via`, honoured only when it is one of the entry's own `hardwareNames`;
   * never arbitrary text) else every name the entry documents — and carries
   * the briefing's own title + category as the subtitle: the page confirms
   * the click before it teaches. Concept entries keep the shipped header
   * (title, then category). Pure; the data already carries the bridge
   * (`hardwareNames`), nothing is invented.
   * @param {object} entry - codex entry (title, hardwareNames)
   * @param {string|null} via - the clicked part's callout name, if any
   * @param {string} categoryLabel - the entry's category label
   * @returns {{ lead: string, sub: string, hardware: boolean }}
   */
  static headerLead(entry, via, categoryLabel) {
    const title = (entry && (entry.title || entry.id)) || '';
    const cat = categoryLabel || '';
    if (!LibraryPane.isHardware(entry)) return { lead: title, sub: cat, hardware: false };
    const names = entry.hardwareNames.filter((n) => typeof n === 'string' && n.length > 0);
    const lead = (typeof via === 'string' && names.includes(via)) ? via : names.join(' \u00b7 ');
    return {
      lead: lead || title,
      sub: cat ? `briefing \u00b7 ${title} \u00b7 ${cat}` : `briefing \u00b7 ${title}`,
      hardware: true,
    };
  }

  /**
   * The bridge line under the header (Session D): the entry's authored
   * `hardwareNote` for a HARDWARE entry only — a non-empty string, trimmed;
   * anything else (a concept entry, an absent / empty / non-string note) →
   * null and the pane renders nothing there. Pure.
   * @param {object|null} entry
   * @returns {string|null}
   */
  static hardwareNote(entry) {
    if (!LibraryPane.isHardware(entry)) return null;
    const n = entry.hardwareNote;
    if (typeof n !== 'string') return null;
    const t = n.trim();
    return t.length ? t : null;
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

  /** Open the pane (no-op while disabled). Fires onOpenChange(true) once.
   *  An ENTRY-LESS open (tab click / toggle — never openEntry, which has its
   *  entry) first adopts the injected `subject` so the pane lands on the part
   *  the player is looking at instead of the prompt (Session C). */
  open() {
    if (!this._enabled || this._open) return;
    if (this._entryId == null) this._adoptSubject();
    this._open = true;
    this._applyOpenState();
    this._wake();
    this.refresh();
    this._armSeenTimer();
    this._takePhoto();
    if (this._onOpenChange) { try { this._onOpenChange(true); } catch (_e) { /* dep */ } }
  }

  /** Close the pane. Fires onOpenChange(false) once. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._applyOpenState();
    this._clearIdleTimer();
    this._clearSeenTimer();
    this._cancelPhoto();
    if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
  }

  /** Edge-tab click: toggle. */
  toggle() { if (this._open) this.close(); else this.open(); }

  /**
   * Deep-link into the pane: show one entry and open (the REFIT card title /
   * spec term route — 03-plan §3 "tap → TECH LIBRARY slides in"; also the
   * related-chip navigation, and — Session C — the hull part / callout-card
   * click while the pane is already open: main.js's onPartClick hook calls
   * this ONE path with the part's codexId, so an open library FOLLOWS every
   * click in place, entry + seen dwell retargeted, no second open edge).
   * Unknown ids keep the current view and still
   * open (never a throw, never a blank crash — the viewer's "safe no-op"
   * contract). While disabled the entry is stored for the next open.
   * @param {string} id - codex entry id
   * @param {{ via?: string }} [opts] - `via`: the clicked part's callout name
   *   (main.js passes `part.name`); the header leads with it when it is one
   *   of the entry's own `hardwareNames`. Absent (REFIT title, related chip,
   *   MAXIMIZE) → the header leads with every name the entry documents.
   * @returns {boolean} true when the entry resolved
   */
  openEntry(id, opts = {}) {
    const entry = this._entry(id);
    let changed = false;
    if (entry) {
      const via = (opts && typeof opts.via === 'string') ? opts.via : null;
      if (entry.id !== this._entryId) {
        this._entryId = entry.id;
        this._clearSeenTimer();
        changed = true;
      }
      if (via !== this._via) { this._via = via; changed = true; }   // a sibling part of the same entry: new lead, new photo
    }
    const wasOpen = this._open;
    this.open();                       // a fresh open takes its own photo
    this.refresh();
    if (this._open) {
      this._armSeenTimer();
      // Already open and the entry changed (the hull-click follow / a
      // related chip): the photo you just took is THIS click's frame.
      if (wasOpen && changed) this._takePhoto();
    }
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
    this._cancelPhoto();
    this._photo = null;
    this._photoCanvas = null;
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

  /**
   * @private The entry-less open lands on the player's subject (Session C):
   * read the injected `subject` getter ONCE, adopt its id when the codex
   * resolves it. Null / unknown / throwing → nothing adopted, the prompt copy
   * stays. Never called while an entry is shown (the caller gates on it).
   * @returns {boolean} true when an entry was adopted
   */
  _adoptSubject() {
    if (!this._subject) return false;
    let id = null;
    try { id = this._subject(); } catch (_e) { id = null; }
    const entry = (typeof id === 'string') ? this._entry(id) : null;
    if (!entry) return false;
    this._entryId = entry.id;
    this._via = null;               // adopted, not clicked: the header leads with every name the entry documents
    this._clearSeenTimer();
    return true;
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
    // The bridge line (Session D): hardware entries only, authored data.
    const note = LibraryPane.hardwareNote(entry);
    // The photo shows only for the entry it was taken for (never a stale
    // frame under a newer entry); absent → the emoji header stands alone.
    const photo = (entry && this._photo && this._photo.id === entry.id) ? this._photo.url : null;
    let unread = 0;
    try {
      unread = LibraryPane.unreadCount(this._codex ? this._codex.entries : null);
    } catch (_e) { unread = 0; }
    const structKey = [
      this._open ? 1 : 0,
      entry ? entry.id : '',
      entry ? (entry.unlocked ? 1 : 0) : 0,
      photo ? 1 : 0,
      this._via || '',
      unread,
      note || '',
      specs.map((s) => `${s.k}:${s.v}`).join('|'),
      related.map((r) => `${r.id}:${r.unlocked ? 1 : 0}`).join('|'),
    ].join('\u0001');
    return {
      entry,
      category: entry ? this._categoryLabel(entry.category) : '',
      specs,
      related,
      photo,
      note,
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
    // "LIBRARY: unread count, pulses once on a new unlock"). ONE z step above
    // the root (Session C): the open pane slides in UNDER the tab, so the tab
    // never disappears behind its own pane and a click toggles it closed.
    const tab = doc.createElement('div');
    tab.id = 'ladder-library-tab';
    tab.style.cssText = [
      'position:absolute', 'right:0', 'top:38%', `z-index:${TAB_Z_INDEX}`,
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
      'position:absolute', 'right:0', 'top:56px', 'bottom:96px', `z-index:${PANE_Z_INDEX}`,
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
    // The photo you just took (Session C): a banner above the entry header
    // when the deferred frame read succeeded; otherwise nothing here and the
    // emoji header below stands alone (the fallback = Session B's header).
    if (m.photo) {
      parts.push(
        `<img class="library-photo" alt="" src="${m.photo}" style="display:block;width:100%;height:110px;object-fit:cover;border:1px solid rgba(0,204,255,0.35);border-radius:4px;margin-bottom:8px${locked ? ';opacity:0.7' : ''}">`,
      );
    }
    // Entry header: emoji icon (the codex's own icon vocabulary; alone when
    // no photo could be read) + the lead line + the subtitle. Hardware entries
    // lead with the PART (the clicked callout name when known) and carry the
    // briefing's title as the subtitle — see headerLead().
    const head = LibraryPane.headerLead(e, this._via, m.category);
    parts.push(
      '<div class="library-entry-header" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">' +
      `<span style="font-size:1.6rem;line-height:1.2${locked ? ';opacity:0.6' : ''}">${e.icon}</span>` +
      '<span style="flex:1;min-width:0">' +
      `<span class="library-title" style="display:block;color:${locked ? C.INFO : C.SELECTION};font-weight:bold">${head.lead}${locked ? ' \ud83d\udd12' : ''}</span>` +
      `<span class="library-sub" style="display:block;opacity:${head.hardware ? 0.8 : 0.6}">${head.sub}</span>` +
      '</span>' +
      '</div>',
    );
    // The bridge line (Session D): the authored hardwareNote — the part and
    // what it does on THIS ship, then the hand-off to the concept — under the
    // header for HARDWARE entries only; absent → nothing here (never the
    // shortText twice). Rendered even while locked: it names hardware the
    // player is looking at, not the briefing's depth.
    if (m.note) {
      parts.push(
        `<div class="library-note" style="color:${C.INFO};line-height:1.5;margin:-2px 0 8px 0;opacity:${locked ? 0.7 : 0.9}">${m.note}</div>`,
      );
    }
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

  // ── The photo you just took (Session C, decision 2 — 08-workbench §2) ─────

  /** @private Drop a pending deferred read (entry change / close / dispose). */
  _cancelPhoto() {
    if (this._photoHandle != null) {
      if (this._cancelRaf) { try { this._cancelRaf(this._photoHandle); } catch (_e) { /* dep */ } }
      this._photoHandle = null;
    }
    this._photoTry = 0;
  }

  /**
   * @private Arm ONE deferred frame read for the current entry (called on the
   * open edge and on an in-place entry change — never per frame, never from
   * refresh()). Requires an entry, an open pane, a source getter and a frame
   * scheduler; otherwise the emoji header stands alone. A pending read is
   * replaced (the newest edge owns the photo).
   */
  _takePhoto() {
    this._cancelPhoto();
    if (!this._open || this._disposed || !this._entryId || !this._photoSource || !this._raf) return;
    this._photoTry = 0;
    this._armPhotoFrame();
  }

  /** @private */
  _armPhotoFrame() {
    try {
      this._photoHandle = this._raf(() => this._photoTick());
    } catch (_e) {
      this._photoHandle = null;
    }
  }

  /**
   * @private The deferred read (rAF-fired; tests drive it directly): runs
   * AFTER the game loop's render in this frame and BEFORE present, so the
   * drawing buffer is readable without preserveDrawingBuffer (the
   * BlackFrameProbe legality). Crop PHOTO_CROP_H_FRAC of the canvas height
   * (16:10) around the subject point, clamped inside the canvas, composited
   * onto black (the frame's alpha is 0 — the __netShot precedent), sampled on
   * a coarse grid: a blank read (a frame the loop skipped) is retried next
   * frame up to PHOTO_TRIES, then dropped — the emoji header stands alone.
   * Any throw (a tainted canvas, a missing 2D context) drops it the same way.
   */
  _photoTick() {
    this._photoHandle = null;
    if (!this._open || this._disposed || !this._entryId) return;
    let ok = false;
    try { ok = this._readPhoto(); } catch (_e) { ok = false; }
    if (ok) return;
    if (++this._photoTry < PHOTO_TRIES) this._armPhotoFrame();
    else this._photoTry = 0;
  }

  /** @private One read attempt. @returns {boolean} true when a photo landed. */
  _readPhoto() {
    const src = this._photoSource ? this._photoSource() : null;
    const cv = src && src.canvas;
    const W = cv ? Number(cv.width) : 0, H = cv ? Number(cv.height) : 0;
    if (!cv || !(W > 0) || !(H > 0)) return false;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (!this._photoCanvas) {
      this._photoCanvas = doc.createElement('canvas');
      this._photoCanvas.width = PHOTO_W;
      this._photoCanvas.height = PHOTO_H;
    }
    const ctx = this._photoCanvas.getContext('2d');
    if (!ctx) return false;
    // Source crop: PHOTO_CROP_H_FRAC of the height, 16:10, centred on the
    // subject, clamped inside the canvas (a subject near an edge slides the
    // crop rather than shrinking it).
    const ch = Math.min(H, Math.max(1, Math.round(H * PHOTO_CROP_H_FRAC)));
    const cw = Math.min(W, Math.round(ch * PHOTO_W / PHOTO_H));
    const cx = Number.isFinite(src.x) ? src.x : W / 2;
    const cy = Number.isFinite(src.y) ? src.y : H / 2;
    const sx = Math.max(0, Math.min(W - cw, Math.round(cx - cw / 2)));
    const sy = Math.max(0, Math.min(H - ch, Math.round(cy - ch / 2)));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
    ctx.drawImage(cv, sx, sy, cw, ch, 0, 0, PHOTO_W, PHOTO_H);
    if (!LibraryPane.photoLit(ctx.getImageData(0, 0, PHOTO_W, PHOTO_H))) return false;
    const url = this._photoCanvas.toDataURL('image/jpeg', 0.8);
    if (typeof url !== 'string' || url.length < 64) return false;
    this._photo = { id: this._entryId, url };
    this._photoCount++;
    this.refresh();                    // structural (photo 0 → 1): writes at once
    return true;
  }

  /**
   * Blank test over an ImageData: true when ANY pixel on the coarse
   * PHOTO_SAMPLE_STRIDE grid lights (r+g+b > PHOTO_LIT_SUM). Pure + exported
   * for the suite; a cleared drawing buffer (the synchronous read without
   * preserveDrawingBuffer, or a frame the loop skipped) reads all-black after
   * the black composite and fails it.
   * @param {{ data: Uint8ClampedArray|number[], width: number, height: number }} img
   * @returns {boolean}
   */
  static photoLit(img) {
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return false;
    const d = img.data, w = img.width, h = img.height, s = PHOTO_SAMPLE_STRIDE;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        const i = (y * w + x) * 4;
        if ((d[i] + d[i + 1] + d[i + 2]) > PHOTO_LIT_SUM) return true;
      }
    }
    return false;
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
