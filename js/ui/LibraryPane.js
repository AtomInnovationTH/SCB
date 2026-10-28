/**
 * @module ui/LibraryPane — the SPECS dossier: a HOSTED SECTION ENGINE inside the ONE workbench pane
 * (docs/ladder/08-workbench.md §2 + §3; docs/ladder/01-numbers.md "Workbench panes").
 *
 * HOSTED BY WorkbenchPane (Session U — plan 1788954873769-one-workbench-pane §3, D1 / D5 / D6 / D7): this module owns
 * NO root, tab, slide, idle fade, edge-chrome phase, reduced-motion swap, RTL variable or open-signal; all of that is
 * js/ui/WorkbenchPane.js (the ONE drawer, LEFT on every floor, DECISIONS §13 r5). The engine is DOM-LESS UNTIL
 * MOUNTED: the shell calls `mount({ head, tail, onRefresh })` with the two elements it renders into:
 *   - HEAD (`.workbench-head`, above the shell's REFIT slot): `.library-header` (SPECS … MAXIMIZE, the PaneHelp [?]
 *     anchor), `.library-empty` (no-entry state), the `.library-photo` 16:10 banner, `.library-title` /
 *     `.library-sub`, `.library-note` + `.library-short`, and the `.library-locked` stub;
 *   - TAIL (`.workbench-tail`, below the REFIT slot): `.library-specs` (HARDWARE · TECH LEVEL · FORMULA),
 *     `.library-related` chips and the manual's `.library-warning` (order Identity → Upgrade → Learn).
 * Same house pattern as RefitPane/ProxContextPanel: pure static formatters (headless-testable), an innerHTML cache
 * with the static `shouldWrite` 250 ms DOM-write cap, an injectable `now`. NO eventBus/Events import and NO live
 * singletons: every live read and routed action arrives through optional injected deps.
 * Two write-on-change caches (head / tail) sit behind ONE `shouldWrite` gate (struct key + 250 ms cap), so a landed
 * photo rewrites the head alone. Clicks are delegated on BOTH containers (`[data-max]` → onMaximize, `[data-rel]` →
 * related entry). `onRefresh` fires after every repaint so the shell's tab count follows; `unreadCount()` is that
 * number. Every public method is no-op-safe before mount; the shell calls open()/openEntry()/close()/isOpen()/
 * forgetEntry()/scanPart()/refresh()/setEnabled()/dispose().
 *
 * CONTENT (the shipped viewer's ENTRY as a side pane):
 *   - header: a LEAD line + subtitle, no glyph (the entry's data `icon` is never rendered). A HARDWARE entry (has
 *     `hardwareNames`) leads with the PART: the clicked callout name (`openEntry(id, { via })`, honoured only when it is
 *     one of the entry's own names), else every name it documents. Subtitle "briefing · <entry title> · <category>",
 *     so the page confirms the click before it teaches. Concept entries keep title-then-category. A HARDWARE
 *     entry's authored `hardwareNote` (one sentence: the part on THIS ship, handing off to the concept) renders
 *     above `shortText`; absent → nothing.
 *   - the PHOTO banner, taken ONCE per open / entry change (never per frame): a crop of the live frame around the
 *     subject. The read is DEFERRED ONE ANIMATION FRAME: a synchronous `drawImage` / `toDataURL` in the click task
 *     is BLANK (`preserveDrawingBuffer` is false), while the read inside the next rAF callback (after the game's
 *     render, before present) is the BlackFrameProbe-legal one. The crop is composited onto black (the WebGL frame
 *     has alpha 0), sampled for blankness, retried up to PHOTO_TRIES frames, and on any failure the text header
 *     stands alone. Source (canvas + subject point) = injected `photoSource`; scheduler = `raf`/`cancelRaf`
 *     (absent headless → no photo, no throw).
 *   - Part anchor: `openEntry(id, { anchor })` carries the hull-click screen point + projected pick-mesh bounds
 *     (drawing-buffer px, MotherCallouts.getHoveredPart); that edge's crop takes PHOTO_CROP_H_FRAC_PART of the height
 *     around the part (grown to its bounds, capped at the ship crop) and the banner flashes once (reduced motion:
 *     none). Entry-less opens and un-anchored openEntry calls frame the ship. The anchor rides ONE edge so it can
 *     never go stale under a later camera move.
 *   - Framed PART PORTRAIT: the anchor also carries `partId`; the edge's FIRST read asks `photoSource(anchor)` for a
 *     framed picture (hub renders the part once, callout-free: SceneManager.renderPartPortrait → `{ canvas,
 *     framed: true }`), drawn WHOLE with no crop law (banner keeps 16:10 via `aspect-ratio`). Any framed miss
 *     (live source answered, blank, sizeless, throws) falls to the live crop: remaining tries ask
 *     `photoSource(anchor, 'live')`. One framed attempt per edge.
 *   - `shortText`, the plain-English "why it matters" line every entry has.
 *   - a generated SPECS block for HARDWARE entries from the entry's EXISTING fields only: HARDWARE (names), TECH
 *     LEVEL (trl + the Constants tier label), FORMULA. Unlocked depth only. In the TAIL.
 *   - `related` chips navigate the PANE to that entry (locked ones show a LOCKED tag and open the locked stub). On
 *     glass (`deps.glass`) each chip is 44 pt tall (RELATED_CHIP_GLASS_MIN_H_PX); desktop keeps the shipped size.
 *   - the manual's WARNING: an entry's authored `warning` prints LAST, after RELATED, as a steady THREAT-red box with
 *     a caps WARNING label (print, never a pulsing alarm). Unlocked depth only.
 *   - MAXIMIZE: the full-screen viewer through the injected `onMaximize` (main.js: the EXACT CODEX_OPEN_ENTRY path).
 *   - Subnautica rule: `scanPart(part)` requests the unlock of a LOCKED part's entry through the injected
 *     `requestUnlock` (main.js: the ONE unlock path, CODEX_UNLOCK_REQUEST → ticker ack chip → CODEX_UNLOCKED).
 *     Already-unlocked / unknown / briefing-less parts are safe no-ops.
 *   - locked entries render the honest locked stub: LOCKED + the entry's `unlockHint`; it stays in the HEAD.
 *
 * THE DOSSIER FOLLOWS CLICKS: every hull part / callout-card click reaches this engine through the SAME
 * `openEntry(codexId, { via, anchor })` the REFIT title rides; the shell's `showPart(part)` calls it and OPENS the pane
 * when closed (the engine itself only stores the entry while disabled). Opening with NO entry lands on the injected
 * `subject` getter's answer (main.js chains the focused hull part's codexId, then the REFIT card's manifest deep
 * link), consulted ONLY when the pane has no entry (a shown entry survives close → re-open); unknown / null / throwing
 * → the prompt copy stays. The engine never reads MotherCallouts or the REFIT.
 *
 * READ = SEEN: an entry resting open ≥ SEEN_DWELL_MS fires the injected `onViewed(id)` once for unlocked, unseen
 * entries (main.js: the same CODEX_VIEWED the viewer emits, so CodexSystem.markSeen stays the one seen-writer).
 * Scrubbing to another entry before the dwell cancels it.
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { GestureHints } from './hud/GestureHints.js';
import { trlToLabel, techLevelBadgeText } from '../core/Constants.js';
import { clamp } from '../core/MathUtil.js';

/** Dwell (ms) before an open entry is marked seen; mirrors CodexViewerUI SEEN_DWELL_MS (one reading contract). */
export const SEEN_DWELL_MS = 1500;
/** RELATED chip minimum height on glass (px): the 44 pt HIG box (RefitPane ACTUATOR_CHIP_GLASS_MIN_H_PX). */
export const RELATED_CHIP_GLASS_MIN_H_PX = 44;
/** Photo crop: source height as a fraction of the canvas height (16:10, PHOTO_W × PHOTO_H out), centred on the SHIP's projection. */
export const PHOTO_CROP_H_FRAC = 0.42;
/**
 * Photo crop when ANCHORED on a clicked part: tighter; grows to the part's bounds (× PHOTO_BOUNDS_PAD), never past
 * PHOTO_CROP_H_FRAC. owner 2026-09-04: part crop 0.26.
 */
export const PHOTO_CROP_H_FRAC_PART = 0.26;
export const PHOTO_BOUNDS_PAD = 1.15;
/** The one-shot banner flash when a photo lands (ms); none under reduced motion. */
export const PHOTO_FLASH_MS = 600;
/** Photo output size (device px). */
export const PHOTO_W = 320;
export const PHOTO_H = 200;
/** Frames the photo read is retried when the buffer reads blank (a skipped frame) before the text header stands alone. */
export const PHOTO_TRIES = 3;
/** Blank test: a sampled pixel "lights" when r+g+b exceeds this (the crop-probe threshold). */
const PHOTO_LIT_SUM = 24;
/** Blank test sampling stride (px): a coarse grid, never the full crop. */
const PHOTO_SAMPLE_STRIDE = 8;
/** The LOCKED marker after a locked entry's title: a small letter-spaced text chip (no glyphs in chrome). */
const LOCK_CHIP_HTML = ' <span class="library-lock" style="display:inline-block;vertical-align:middle;font-size:0.7em;letter-spacing:0.1em;padding:0 4px;border:1px solid currentColor;border-radius:2px;opacity:0.85">LOCKED</span>';
/** The same marker inside a RELATED chip (already a bordered pill): text only. */
const LOCK_TAG_HTML = ' <span class="library-lock" style="font-size:0.75em;letter-spacing:0.1em;opacity:0.85">LOCKED</span>';
/** The no-entry prompt. */
const EMPTY_COPY = 'Click a hull part or its card to read about it.';

/** DOM-write cap (ms): the ProxContextPanel/TransferWindows house value. */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Reduced-motion probe (FloorMask shape). The banner flash is the engine's ONLY motion; the shell owns the rest. */
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
   * Every dep optional; inert headless (no DOM at import, none until `mount`), never throws on a missing dep.
   * `footerBottomPx`, `reducedMotion` and `onOpenChange` are the SHELL's (WorkbenchPane) and IGNORED here.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document for the photo thumbnail canvas (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.codex] - the CodexSystem (getEntry / getRelated / getCategoryMeta / entries), read-only
   * @param {function} [deps.onMaximize] - (id) => void (main.js: the CODEX_OPEN_ENTRY emit → full-screen viewer)
   * @param {function} [deps.requestUnlock] - (id) => void (main.js: CODEX_UNLOCK_REQUEST → CodexSystem's queue)
   * @param {function} [deps.onViewed] - (id) => void (main.js: CODEX_VIEWED → CodexSystem.markSeen)
   * @param {function} [deps.subject] - () => codexId|null: what the player is looking at (focused hull part's
   *   codexId, then the REFIT card's manifest deep link). Consulted ONLY on an entry-less open; null / unknown /
   *   throwing keeps the prompt copy.
   * @param {function} [deps.photoSource] - (anchor, hint) => ({ canvas, x, y }|{ canvas, framed: true })|null
   *   the picture source for the photo edge. `anchor` is THIS edge's click anchor ({ x, y, bounds, partId } |
   *   { partId } | null on an entry-less open); `hint` is `undefined` (a framed part portrait is welcome) or
   *   `'live'` (live crop only: this edge's framed attempt already ran). A LIVE answer is the render canvas + the
   *   subject's point in CANVAS (drawing-buffer) px to crop around; a FRAMED answer (`framed: true`) IS the picture
   *   (the hub's one-shot part render, 16:10), drawn whole. Read once per photo try, on the open / entry edge only.
   * @param {function} [deps.raf] - (cb) => handle: scheduler for the deferred photo read (default
   *   window.requestAnimationFrame; absent → no photo)
   * @param {function} [deps.cancelRaf] - (handle) => void (default window.cancelAnimationFrame)
   * @param {boolean} [deps.glass] - the boot's glass answer: RELATED chips are 44 pt tall on glass
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = deps.now || _nowMs;
    this._codex = deps.codex || null;
    this._onMaximize = deps.onMaximize || null;
    this._requestUnlock = deps.requestUnlock || null;
    this._onViewed = deps.onViewed || null;
    this._subject = deps.subject || null;
    this._photoSource = deps.photoSource || null;
    this._raf = deps.raf !== undefined ? deps.raf
      : (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
    this._cancelRaf = deps.cancelRaf !== undefined ? deps.cancelRaf
      : (typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h) : null);
    /** Glass boot → the RELATED chips wear the 44 pt HIG box. */
    this._glass = !!deps.glass;
    // deps.footerBottomPx / reducedMotion / onOpenChange are the shell's: deliberately not read.

    this._enabled = false;
    this._open = false;
    this._entryId = null;         // the entry the pane is showing (null = prompt)
    this._via = null;             // the clicked part's callout name behind the entry (header lead), else null
    // Mount state: the two shell containers, the shell's repaint hook, and the ONE bound delegated-click handler
    // shared by both (kept so dispose can remove it).
    this._head = null;
    this._tail = null;
    this._onRefresh = null;
    this._mounted = false;
    this._onClickBound = (e) => this._onClick(e);
    // One struct-key gate, two write-on-change caches (head / tail).
    this._lastHeadHtml = null;
    this._lastTailHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    this._seenTimer = null;
    // The photo: { id, url } for the entry it was taken for (shown only while that entry is on screen), the pending
    // deferred-read handle, the retry count, and the ONE reused thumbnail canvas (built lazily).
    this._photo = null;
    this._photoHandle = null;
    this._photoTry = 0;
    this._photoCanvas = null;
    this._photoCount = 0;         // photos taken (tests/witness probe)
    // The click anchor behind the CURRENT openEntry edge: { x, y, bounds } in drawing-buffer px from the shell's
    // showPart. Set by openEntry, cleared by every entry-less open() so it never goes stale under a later camera
    // move; read at frame time by _readPhoto.
    this._photoAnchor = null;
    // True once THIS edge's framed portrait attempt has run (blank, sizeless or thrown): the remaining tries ask for
    // the live crop. Reset by every _takePhoto.
    this._photoLiveOnly = false;
    this._photoFlashes = 0;       // banner flashes fired (tests/witness probe)
    this._disposed = false;
  }

  /** Pin surface: the DOM-write cap (ms), the house 250 ms / ≤4 Hz. */
  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /** Pure write gate (ProxContextPanel.shouldWrite contract): structural changes always write; identical structure is rate-capped. */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  /** A HARDWARE entry carries `hardwareNames` (the MotherCallouts vocabulary, the search bridge CodexSystem uses). */
  static isHardware(entry) {
    return !!(entry && Array.isArray(entry.hardwareNames) && entry.hardwareNames.length > 0);
  }

  /**
   * The entry header's two lines. owner 2026-09-03: players click a PART and expect the page to be about that part
   * (a concept title like "Detumbling Captured Debris" behind the SPIN-BRAKE LASER reads as a wrong link). A hardware
   * entry LEADS with the clicked part name (`via`, honoured only when it is one of the entry's own `hardwareNames`)
   * else every name it documents, with the briefing's title + category as subtitle. Concept entries: title, then
   * category. Pure.
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

  /** The bridge line under the header: a HARDWARE entry's authored `hardwareNote` (non-empty, trimmed), else null. Pure. */
  static hardwareNote(entry) {
    if (!LibraryPane.isHardware(entry)) return null;
    const n = entry.hardwareNote;
    if (typeof n !== 'string') return null;
    const t = n.trim();
    return t.length ? t : null;
  }

  /**
   * The generated SPECS block, from the entry's EXISTING fields only: HARDWARE (`hardwareNames`), TECH LEVEL (`trl`
   * through the Constants tier vocabulary), FORMULA. Absent fields are omitted; a non-hardware entry returns [].
   * Pure; locked gating is the caller's.
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
   * The tab's UNREAD count: unlocked, unseen entries EXCLUDING the `startUnlocked` set. owner 2026-09-07: those 74
   * (PLAYBOOK + WORLD_INDUSTRY + the 12 cornerstones) are readable from the first open, so counting them kept the
   * badge at "74" and taught nothing. Deliberately differs from the viewer's NEW-pip predicate, which still includes
   * them. Pure; the instance `unreadCount()` applies it to the injected codex.
   * @param {Array<object>|null|undefined} entries
   * @returns {number}
   */
  static unreadCount(entries) {
    let n = 0;
    for (const e of (entries || [])) {
      if (e && e.unlocked && !e.seen && !(e.startUnlocked === true)) n++;
    }
    return n;
  }

  isOpen() { return this._open; }
  isEnabled() { return this._enabled; }
  /** @returns {boolean} true between mount() and dispose() */
  isMounted() { return this._mounted; }
  /** @returns {string|null} the entry the pane is showing (null = the prompt) */
  currentEntryId() { return this._entryId; }

  /**
   * The number the shell's ONE tab shows: the static `unreadCount` law over the injected codex, read live (edges
   * only, never per frame). Absent / throwing codex → 0.
   * @returns {number}
   */
  unreadCount() { return this._unread(); }

  /**
   * The shell hands over the two elements this engine renders into (HEAD `.workbench-head`, TAIL
   * `.workbench-tail`) and its repaint hook. Attaches ONE delegated click listener to each container, cold-starts
   * both caches and paints at once, silently (`onRefresh` fires only from `refresh()` edges). Re-mounting detaches
   * from the previous containers first. Disposed engines refuse.
   * @param {{ head: Element, tail: Element, onRefresh?: function }} opts
   * @returns {boolean} true when mounted
   */
  mount(opts = {}) {
    if (this._disposed) return false;
    const head = (opts && opts.head) || null;
    const tail = (opts && opts.tail) || null;
    if (!head && !tail) return false;
    this._detach();
    this._head = head;
    this._tail = tail;
    this._onRefresh = (opts && typeof opts.onRefresh === 'function') ? opts.onRefresh : null;
    this._mounted = true;
    for (const el of [head, tail]) {
      if (el && typeof el.addEventListener === 'function') el.addEventListener('click', this._onClickBound);
    }
    this._lastHeadHtml = null;
    this._lastTailHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    this._paint(this._model(), this._now());
    return true;
  }

  /**
   * Called by the SHELL (`WorkbenchPane.setEnabled`); the engine stays enabled on every floor (deep links work
   * everywhere). Enabled → repaint; disabled → close. Idempotent; writes no container display (the shell hides the pane).
   * @param {boolean} on
   */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (on) this.refresh();
    else this.close();
  }

  /** Open the dossier (no-op while disabled; the shell slides + signals). An ENTRY-LESS open first adopts the
   *  injected `subject` (so the pane lands on what the player is looking at, not the prompt) and drops any earlier
   *  click anchor, so the photo frames the ship. The shell must never call this on the showPart / openEntry paths. */
  open() {
    this._photoAnchor = null;
    this._openCore();
  }

  /** @private The open edge shared by open() and openEntry(). */
  _openCore() {
    if (!this._enabled || this._open) return;
    if (this._entryId == null) this._adoptSubject();
    this._open = true;
    this.refresh();
    this._armSeenTimer();
    this._takePhoto();
  }

  /** Close: drops the seen dwell and any pending photo read; the shown entry is remembered (close → re-open returns to it). Idempotent. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._clearSeenTimer();
    this._cancelPhoto();
  }

  /**
   * Forget the remembered entry while CLOSED, so the NEXT entry-less open adopts the injected `subject` instead of
   * re-showing a page from another floor. The hub calls it (through the shell) on a floor arrival / selection change
   * while the pane is shut (an OPEN pane is retargeted through openEntry). No-op while open (never a cut under the
   * reader) or with nothing remembered.
   * @returns {boolean} true when an entry was forgotten
   */
  forgetEntry() {
    if (this._open || this._entryId == null) return false;
    this._entryId = null;
    this._via = null;
    this._photoAnchor = null;
    this._clearSeenTimer();
    return true;
  }

  /**
   * Deep-link into the dossier: show one entry and open (REFIT card title / RELATED chip / ticker chip, and the shell's
   * `showPart(part)` for every hull part / callout-card click). An open pane FOLLOWS every call in place (entry + seen
   * dwell retargeted, no second open edge). Unknown ids keep the current view and still open (safe no-op, never a
   * throw). While disabled the entry is stored for the next open. The click anchor is KEPT (it rides this edge's
   * photo); only the entry-less open() drops it.
   * @param {string} id - codex entry id
   * @param {{ via?: string, anchor?: {x?:number,y?:number,bounds?:object,partId?:string}|null }} [opts]
   *   `via`: the clicked part's callout name (`part.name`); the header leads with it when it is one of the entry's own
   *   `hardwareNames`. `anchor`: the clicked part's screen point (+ projected pick-mesh `bounds`) in DRAWING-BUFFER
   *   px (`part.screen` / `part.bounds`); this edge's photo crops around it. `partId` (the record's `id`) rides it
   *   too, with or without a screen point, and is what the hub frames the part portrait from. Absent → the header
   *   leads with every name the entry documents and the photo frames the ship.
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
    // The anchor rides THIS edge only (the newest edge owns the photo): a finite point is kept with its bounds,
    // else the ship. `partId` rides it with or without a point; a malformed anchor carrying no id is null.
    const a = opts && opts.anchor;
    const partId = (a && typeof a.partId === 'string' && a.partId) ? a.partId : null;
    this._photoAnchor = (a && Number.isFinite(a.x) && Number.isFinite(a.y))
      ? { x: a.x, y: a.y, bounds: LibraryPane._finiteBounds(a.bounds), partId }
      : (partId ? { partId } : null);
    const wasOpen = this._open;
    this._openCore();                  // a fresh open takes its own photo (anchored when the click supplied one)
    this.refresh();
    if (this._open) {
      this._armSeenTimer();
      // Already open and the entry changed (hull-click follow / related chip): the photo is THIS click's frame.
      if (wasOpen && changed) this._takePhoto();
    }
    return !!entry;
  }

  /**
   * The Subnautica rule (08-workbench §2: clicking a locked part's card unlocks its entry), called by the shell's
   * showPart on a HULL part/card click. A resolved, LOCKED entry fires the injected requestUnlock (the ONE unlock
   * path: CodexSystem's queue). Unlocked / unknown / briefing-less parts are safe no-ops. Never opens the pane.
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
   * Recompute + repaint (struct-key gate + 250 ms cap; structural changes write at once; each container only when its
   * own HTML changed). Unmounted: just returns the model. After every repaint the shell's `onRefresh` fires once, so
   * the tab count follows. Called on interaction edges + the shell's refresh (CODEX_UNLOCKED / CODEX_VIEWED), never
   * per frame.
   * @returns {object} the display model
   */
  refresh() {
    const model = this._model();
    if (!this._mounted) return model;
    const now = this._now();
    if (!LibraryPane.shouldWrite(model.structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    this._paint(model, now);
    if (this._onRefresh) { try { this._onRefresh(); } catch (_e) { /* dep */ } }
    return model;
  }

  /** @private The writer behind mount() / refresh(): both halves through their own write-on-change cache. */
  _paint(model, now) {
    const headHtml = this._htmlHead(model);
    const tailHtml = this._htmlTail(model);
    if (this._head && headHtml !== this._lastHeadHtml) {
      this._head.innerHTML = headHtml;
      this._lastHeadHtml = headHtml;
    }
    if (this._tail && tailHtml !== this._lastTailHtml) {
      this._tail.innerHTML = tailHtml;
      this._lastTailHtml = tailHtml;
    }
    this._lastStructKey = model.structKey;
    this._lastWriteMs = now;
  }

  /** Drop every timer + pending read, blank the two containers, remove the listeners; inert afterwards. The containers
   *  are the shell's, and no open-signal is emitted here (the shell does that). */
  dispose() {
    this._disposed = true;
    this._clearSeenTimer();
    this._cancelPhoto();
    this._photo = null;
    this._photoCanvas = null;
    this._open = false;
    for (const el of [this._head, this._tail]) {
      if (el && 'innerHTML' in el) el.innerHTML = '';
    }
    this._detach();
    this._mounted = false;
    this._onRefresh = null;
    this._lastHeadHtml = null;
    this._lastTailHtml = null;
    this._lastStructKey = null;
  }

  /** @private Remove the delegated listeners + forget the containers. */
  _detach() {
    for (const el of [this._head, this._tail]) {
      if (el && typeof el.removeEventListener === 'function') el.removeEventListener('click', this._onClickBound);
    }
    this._head = null;
    this._tail = null;
  }

  /** @private Guarded entry read (unknown/absent codex → null). */
  _entry(id) {
    if (!id || !this._codex || typeof this._codex.getEntry !== 'function') return null;
    try { return this._codex.getEntry(id) || null; } catch (_e) { return null; }
  }

  /** @private The unread law over the injected codex (absent / throwing → 0). */
  _unread() {
    try {
      return LibraryPane.unreadCount(this._codex ? this._codex.entries : null);
    } catch (_e) { return 0; }
  }

  /**
   * @private The entry-less open lands on the player's subject: read the injected `subject` getter ONCE, adopt its id
   * when the codex resolves it; else the prompt stays. Never called while an entry is shown (the caller gates).
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

  /** @private Guarded related read (resolved entries only, as in the viewer). */
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

  /** @private The display model (pure reads; no DOM). */
  _model() {
    const entry = this._entry(this._entryId);
    const related = entry ? this._related(entry.id).map((r) => ({
      id: r.id, title: r.title, unlocked: !!r.unlocked,
    })) : [];
    const specs = (entry && entry.unlocked) ? LibraryPane.specsFor(entry) : [];
    const note = LibraryPane.hardwareNote(entry);
    // The manual's warning: read straight off the entry by _htmlTail; rides the struct key so a re-authored line repaints at once.
    const warning = (entry && typeof entry.warning === 'string') ? entry.warning : '';
    // The photo shows only for the entry it was taken for (never a stale frame under a newer entry).
    const photo = (entry && this._photo && this._photo.id === entry.id) ? this._photo.url : null;
    // The unread count rides the struct key so a count change opens the gate (→ onRefresh → the shell's tab) even
    // when no rendered byte moved.
    const unread = this._unread();
    const structKey = [
      this._open ? 1 : 0,
      entry ? entry.id : '',
      entry ? (entry.unlocked ? 1 : 0) : 0,
      photo ? 1 : 0,
      this._via || '',
      unread,
      note || '',
      warning,
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

  /** @private Reduced-motion read for the banner flash (the engine's ONE motion). Tests override it. */
  _reducedMotion() {
    return _prefersReducedMotion();
  }

  /** @private The HEAD half: header row, no-entry prompt, photo banner, entry header, bridge line, shortText, LOCKED stub. */
  _htmlHead(m) {
    const C = VisualLaw.COLORS;
    const parts = [];
    // .library-header: the pane name + MAXIMIZE (full-screen viewer, never hidden). PaneHelp's [?] anchor is
    // `#ladder-workbench .library-header`.
    parts.push(
      `<div class="library-header" style="display:flex;justify-content:space-between;align-items:baseline;color:${C.PLAYER};border-bottom:1px solid rgba(0,204,255,0.25);padding-bottom:6px;margin-bottom:8px">` +
      '<span>SPECS</span>' +
      (m.entry
        ? `<button class="library-max" data-max="${m.entry.id}" style="cursor:pointer;background:none;border:1px solid rgba(0,204,255,0.4);color:${C.INFO};font:inherit;padding:0 6px;border-radius:3px">MAXIMIZE \u2197</button>`
        : '') +
      '</div>',
    );
    if (!m.entry) {
      parts.push(`<div class="library-empty" style="opacity:0.7">${GestureHints.glassWords(EMPTY_COPY)}</div>`);
      return parts.join('');
    }
    const e = m.entry;
    const locked = !e.unlocked;
    // The photo banner (only when the deferred read succeeded; else the text header stands alone). It keeps the
    // photo's own 16:10 through `aspect-ratio`, not a fixed height: a framed part portrait is composed for that
    // frame and must not be cropped by the pane's width (01-numbers.md "Workbench panes").
    if (m.photo) {
      parts.push(
        `<img class="library-photo" alt="" src="${m.photo}" style="display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border:1px solid rgba(0,204,255,0.35);border-radius:4px;margin-bottom:8px${locked ? ';opacity:0.7' : ''}">`,
      );
    }
    // Entry header: lead line + subtitle, text only (the entry's data `icon` is never rendered); a locked entry gets
    // a LOCKED text chip after the title. See headerLead().
    const head = LibraryPane.headerLead(e, this._via, m.category);
    parts.push(
      '<div class="library-entry-header" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">' +
      '<span style="flex:1;min-width:0">' +
      `<span class="library-title" style="display:inline-block;color:${locked ? C.INFO : C.LABEL};font-weight:bold">${head.lead}</span>` +
      (locked ? LOCK_CHIP_HTML : '') +
      `<span class="library-sub" style="display:block;opacity:${head.hardware ? 0.8 : 0.6}">${head.sub}</span>` +
      '</span>' +
      '</div>',
    );
    // The bridge line (authored hardwareNote, HARDWARE entries only; never the shortText twice). Rendered even while
    // locked: it names hardware the player is looking at, not the briefing's depth.
    if (m.note) {
      parts.push(
        `<div class="library-note" style="color:${C.INFO};line-height:1.5;margin:-2px 0 8px 0;opacity:${locked ? 0.7 : 0.9}">${m.note}</div>`,
      );
    }
    parts.push(
      `<div class="library-short" style="color:#aaddff;line-height:1.5;padding:6px 8px;background:rgba(0,204,255,0.06);border-left:2px solid rgba(0,204,255,0.5);margin-bottom:8px">${GestureHints.glassWords(e.shortText || '')}</div>`,
    );
    if (locked) {
      // The honest locked stub: how to unlock, nothing invented.
      parts.push(
        `<div class="library-locked" style="color:${C.VALUE};border:1px dashed rgba(255,209,102,0.5);border-radius:3px;padding:6px 8px;margin-bottom:8px">` +
        `LOCKED \u00b7 How to unlock: ${GestureHints.glassWords(e.unlockHint || 'Discover through gameplay.')}` +
        '</div>',
      );
    }
    return parts.join('');
  }

  /** @private The TAIL half: generated SPECS table, RELATED chips, the manual's WARNING. Empty for the prompt. */
  _htmlTail(m) {
    const e = m.entry;
    if (!e) return '';
    const C = VisualLaw.COLORS;
    const parts = [];
    const locked = !e.unlocked;
    if (!locked && m.specs.length) {
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
    // Related chips navigate the PANE (locked ones carry a LOCKED text tag and open the locked stub). Glass: a 44 pt-tall
    // flex pill so a thumb lands it; desktop keeps the padding-only size.
    if (m.related.length) {
      const glassCss = this._glass
        ? `display:inline-flex;align-items:center;min-height:${RELATED_CHIP_GLASS_MIN_H_PX}px;box-sizing:border-box;touch-action:manipulation;`
        : '';
      parts.push('<div class="library-related" style="margin-top:8px">');
      parts.push(`<div style="color:${C.PLAYER};margin-bottom:4px">RELATED</div>`);
      parts.push('<div style="display:flex;flex-wrap:wrap;gap:4px">');
      for (const r of m.related) {
        parts.push(
          `<span class="library-rel" data-rel="${r.id}" style="cursor:pointer;padding:1px 6px;border:1px solid rgba(0,204,255,0.35);border-radius:3px;${glassCss}${r.unlocked ? '' : 'opacity:0.6'}">` +
          `${r.title}${r.unlocked ? '' : LOCK_TAG_HTML}` +
          '</span>',
        );
      }
      parts.push('</div></div>');
    }
    // WARNING: the manual's authored notice (the FURNACE gag): a STEADY red box after RELATED, print not a live alarm
    // (never pulses). Unlocked depth only, and only when the entry carries one (`e.warning`, flattened by
    // CodexSystem._buildEntry).
    if (e.warning && !locked) {
      parts.push(
        `<div class="library-warning" style="margin-top:8px;padding:6px 8px;border:1px solid rgba(255,68,34,0.6);border-left:3px solid ${C.THREAT};background:rgba(255,68,34,0.08);border-radius:3px;color:${C.THREAT}">` +
        '<span style="font-weight:bold;letter-spacing:0.14em;margin-right:8px">WARNING</span>' +
        `${e.warning}` +
        '</div>',
      );
    }
    return parts.join('');
  }

  _closest(el, sel) {
    return (el && typeof el.closest === 'function') ? el.closest(sel) : null;
  }

  /** @private */
  _onClick(e) {
    const max = this._closest(e && e.target, '[data-max]');
    if (max) {
      const id = max.getAttribute('data-max');
      if (id && this._onMaximize) { try { this._onMaximize(id); } catch (_e) { /* dep */ } }
      return;
    }
    const rel = this._closest(e && e.target, '[data-rel]');
    if (rel) {
      const id = rel.getAttribute('data-rel');
      if (id) this.openEntry(id);
    }
  }

  _clearSeenTimer() {
    if (this._seenTimer != null) {
      clearTimeout(this._seenTimer);
      this._seenTimer = null;
    }
  }

  /** @private (Re)arm the dwell for the current entry: unlocked + unseen + pane open. Scrubbing/closing cancels. */
  _armSeenTimer() {
    this._clearSeenTimer();
    if (!this._open || this._disposed) return;
    const entry = this._entry(this._entryId);
    if (!entry || !entry.unlocked || entry.seen) return;
    this._seenTimer = setTimeout(() => this._seenTick(), SEEN_DWELL_MS);
  }

  /** @private Dwell elapsed (tests drive it directly): mark the entry seen through onViewed, then repaint so the unread
   *  drop reaches the shell's tab at once. */
  _seenTick() {
    this._seenTimer = null;
    if (!this._open || this._disposed) return;
    const entry = this._entry(this._entryId);
    if (!entry || !entry.unlocked || entry.seen) return;
    if (this._onViewed) { try { this._onViewed(entry.id); } catch (_e) { /* dep */ } }
    this.refresh();
  }

  /** @private Drop a pending deferred read (entry change / close / dispose). */
  _cancelPhoto() {
    if (this._photoHandle != null) {
      if (this._cancelRaf) { try { this._cancelRaf(this._photoHandle); } catch (_e) { /* dep */ } }
      this._photoHandle = null;
    }
    this._photoTry = 0;
  }

  /**
   * @private Arm ONE deferred frame read for the current entry (open edge / in-place entry change; never per frame,
   * never from refresh()). Needs an entry, an open pane, a source and a scheduler. A pending read is replaced (the
   * newest edge owns the photo).
   */
  _takePhoto() {
    this._cancelPhoto();
    if (!this._open || this._disposed || !this._entryId || !this._photoSource || !this._raf) return;
    this._photoTry = 0;
    this._photoLiveOnly = false;       // every edge gets ONE framed attempt first
    this._armPhotoFrame();
  }

  _armPhotoFrame() {
    try {
      this._photoHandle = this._raf(() => this._photoTick());
    } catch (_e) {
      this._photoHandle = null;
    }
  }

  /**
   * @private The deferred read (rAF-fired; tests drive it directly): runs AFTER the game loop's render in this frame
   * and BEFORE present, so the drawing buffer is readable without preserveDrawingBuffer (BlackFrameProbe legality).
   * Crops, composites onto black (frame alpha is 0) and samples on a coarse grid: a blank read is retried next frame
   * up to PHOTO_TRIES, then dropped. Any throw (tainted canvas, missing 2D context) drops it the same way. The first
   * attempt asks for the FRAMED part portrait; after a framed attempt every remaining try asks for `'live'`.
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

  /**
   * @private One read attempt: the source is asked with THIS edge's anchor and a hint (`undefined` = framed portrait
   * welcome, `'live'` = live crop only). A FRAMED source is drawn WHOLE; a live source is cropped by `photoCrop`.
   * Either way the blank test decides.
   * @returns {boolean} true when a photo landed.
   */
  _readPhoto() {
    const src = this._photoSource ? this._photoSource(this._photoAnchor, this._photoLiveOnly ? 'live' : undefined) : null;
    const framed = !!(src && src.framed);
    // One framed attempt per edge: whatever happens below (blank / sizeless / throw), the next try asks for 'live'.
    if (framed) this._photoLiveOnly = true;
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
    // Source crop (pure law, pinned): ship crop, or the tighter PART crop for a hull click. A framed portrait is the
    // whole canvas.
    const c = framed
      ? { sx: 0, sy: 0, cw: W, ch: H, anchored: !!this._photoAnchor }
      : LibraryPane.photoCrop(W, H, src, this._photoAnchor);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
    ctx.drawImage(cv, c.sx, c.sy, c.cw, c.ch, 0, 0, PHOTO_W, PHOTO_H);
    if (!LibraryPane.photoLit(ctx.getImageData(0, 0, PHOTO_W, PHOTO_H))) return false;
    const url = this._photoCanvas.toDataURL('image/jpeg', 0.8);
    if (typeof url !== 'string' || url.length < 64) return false;
    this._photo = { id: this._entryId, url, anchored: c.anchored, framed };
    this._photoCount++;
    this.refresh();                    // structural (photo 0 → 1): writes the HEAD at once
    this._flashBanner();
    return true;
  }

  /**
   * The photo crop law (pure, exported for the suite): a 16:10 source rect inside a W × H canvas.
   *   - no anchor → PHOTO_CROP_H_FRAC of the height, centred on the source point (the ship's projection; an
   *     unprojectable point → the centre);
   *   - anchor (a hull click) → PHOTO_CROP_H_FRAC_PART of the height, centred on the PART's screen point; with
   *     projected bounds the crop grows so the whole part fits (farthest bounds edge, × PHOTO_BOUNDS_PAD, either
   *     axis) but never past the ship crop: a small sensor gets the tight frame, a wing the ship's.
   * The rect is CLAMPED inside the canvas (an edge subject slides the crop, never shrinks it).
   * owner 2026-09-04: part crop 0.26.
   * @param {number} W @param {number} H - canvas drawing-buffer size
   * @param {{x?:number,y?:number}|null} src - the photoSource point
   * @param {{x:number,y:number,bounds?:{x0,y0,x1,y1}|null}|null} anchor
   * @returns {{ sx:number, sy:number, cw:number, ch:number, anchored:boolean }}
   */
  static photoCrop(W, H, src, anchor) {
    const anchored = !!(anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y));
    const cx = anchored ? anchor.x : ((src && Number.isFinite(src.x)) ? src.x : W / 2);
    const cy = anchored ? anchor.y : ((src && Number.isFinite(src.y)) ? src.y : H / 2);
    const shipH = H * PHOTO_CROP_H_FRAC;
    let hPx = anchored ? H * PHOTO_CROP_H_FRAC_PART : shipH;
    const b = anchored ? LibraryPane._finiteBounds(anchor.bounds) : null;
    if (b) {
      const needH = 2 * Math.max(Math.abs(b.y0 - cy), Math.abs(b.y1 - cy)) * PHOTO_BOUNDS_PAD;
      const needW = 2 * Math.max(Math.abs(b.x0 - cx), Math.abs(b.x1 - cx)) * PHOTO_BOUNDS_PAD;
      hPx = Math.max(hPx, needH, needW * PHOTO_H / PHOTO_W);
      hPx = Math.min(hPx, shipH);
    }
    const ch = Math.min(H, Math.max(1, Math.round(hPx)));
    const cw = Math.min(W, Math.round(ch * PHOTO_W / PHOTO_H));
    const sx = clamp(Math.round(cx - cw / 2), 0, W - cw);
    const sy = clamp(Math.round(cy - ch / 2), 0, H - ch);
    return { sx, sy, cw, ch, anchored };
  }

  /** @private A bounds box with four finite edges, else null. */
  static _finiteBounds(b) {
    if (!b || !Number.isFinite(b.x0) || !Number.isFinite(b.y0) || !Number.isFinite(b.x1) || !Number.isFinite(b.y1)) return null;
    return { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
  }

  /**
   * @private One-shot arrival flash on the banner, right after the repaint that inserted `.library-photo`: a
   * PHOTO_FLASH_MS brightness/ring animation through the Web Animations API (no stylesheet, no timer; the element
   * returns to its inline style by itself). Reduced motion → none. Headless / unmounted → counted, not drawn.
   */
  _flashBanner() {
    this._photoFlashes++;
    if (this._reducedMotion()) return;
    const host = this._head;
    const img = (host && typeof host.querySelector === 'function') ? host.querySelector('.library-photo') : null;
    if (!img || typeof img.animate !== 'function') return;
    try {
      img.animate(
        [
          { filter: 'brightness(1.9)', boxShadow: `0 0 0 2px ${VisualLaw.COLORS.VALUE}` },
          { filter: 'brightness(1)', boxShadow: '0 0 0 0 rgba(0,0,0,0)' },
        ],
        { duration: PHOTO_FLASH_MS, easing: 'ease-out' },
      );
    } catch (_e) { /* an animation is a flourish, never a failure */ }
  }

  /**
   * Blank test over an ImageData: true when ANY pixel on the coarse PHOTO_SAMPLE_STRIDE grid lights (r+g+b >
   * PHOTO_LIT_SUM). Pure + exported; a cleared drawing buffer (synchronous read, or a skipped frame) reads all-black
   * after the black composite and fails it.
   * @param {{ data: Uint8ClampedArray|number[], width: number, height: number }} img
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
}

export default LibraryPane;
