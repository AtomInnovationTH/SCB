/**
 * LibraryPane.js — Wave 5 (Session B): the SPECS dossier — since Session U a
 * HOSTED SECTION ENGINE inside the ONE workbench pane (docs/ladder/08-workbench.md
 * §2 "TECH LIBRARY pane" + §3; 01-numbers.md "Workbench panes"; 03-plan.md
 * "Wave 5 — GO"; plan 1788954873769-one-workbench-pane §3 "LibraryPane (A2)").
 *
 * Built on the RefitPane/ProxContextPanel house pattern: pure static
 * formatters that are headless-testable, the G1 innerHTML cache + the static
 * `shouldWrite` 250 ms DOM-write cap, and an injectable `now` clock. NO
 * eventBus/Events import and NO live singletons — every live read (the codex
 * entries) and every routed action (maximize, unlock request, seen mark)
 * arrives through injected deps, all optional, so the module is headless-safe
 * and the flag-off boot never constructs it.
 *
 * HOSTED BY WorkbenchPane (Session U — plan 1788954873769-one-workbench-pane
 * §3, decisions D1 / D5 / D6 / D7): this module owns NO root, tab, slide, idle
 * fade, edge-chrome phase, reduced-motion swap, RTL variable or open-signal any
 * more — that chrome moved verbatim into js/ui/WorkbenchPane.js (the ONE
 * right-side drawer, with the constants PANE_SLIDE_MS, IDLE_FADE_OPACITY,
 * IDLE_FADE_MS, PANE_Z_INDEX, ROOT_BOTTOM_PX, TAB_PULSE_MS; the below-1100-px
 * ONE_PANE_BREAKPOINT_PX rule retired, D9). The engine is DOM-LESS UNTIL
 * MOUNTED: the shell calls `mount({ head, tail, onRefresh })` with the two
 * elements it renders into —
 *   - HEAD (`.workbench-head`, above the shell's REFIT slot): the header row
 *     `.library-header` (SPECS … MAXIMIZE — the PaneHelp [?] anchor), the
 *     `.library-empty` prompt (no-entry state only), the `.library-photo`
 *     16:10 banner, `.library-title` / `.library-sub`, `.library-note` +
 *     `.library-short`, and the `.library-locked` stub (locked entries);
 *   - TAIL (`.workbench-tail`, below the REFIT slot): the `.library-specs`
 *     table (HARDWARE · TECH LEVEL · FORMULA), the `.library-related` chips
 *     and the manual's `.library-warning` — the D1 order Identity → Upgrade →
 *     Learn, the REFIT block sitting between the two halves on F1.
 * Two G1 write-on-change caches (one per container) behind ONE `shouldWrite`
 * gate (the model's struct key + the 250 ms cap): a landed photo rewrites the
 * head alone, a chip never repaints the header. Delegated clicks on BOTH
 * containers (`[data-max]` → onMaximize, `[data-rel]` → the related entry).
 * `onRefresh` fires once after every `refresh()` whose gate opened (= every
 * repaint) so the shell's tab count follows on the same edge (a related
 * click, the seen dwell, a landed photo — never a per-frame call; the shell's
 * paint is write-on-change). `unreadCount()` is the number the shell's tab
 * shows off F1 (D3). Every public method is a no-op-safe read/write before
 * mount (state only) and touches NO root / tab / slide: `open()` (entry-less —
 * drops the click anchor, adopts the subject), `openEntry()` (keeps the
 * anchor), `close()`, `isOpen()`, `forgetEntry()`, `scanPart()`, `refresh()`,
 * `setEnabled()`, `dispose()` keep their semantics and are called ONLY by the
 * shell, which slides, signals `onOpenChange` once and paints the ONE tab.
 *
 * CONTENT: the shipped viewer's ENTRY rendered as a side pane (the adapter
 * over the shipped viewer 08-workbench §10 names) —
 *   - header: a LEAD line + a subtitle (no glyph — the entry's data `icon`
 *     is never rendered, plan D-J). A HARDWARE
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
 *     rendering reads blank), and on any failure the text header stands
 *     alone — the sanctioned fallback, byte-identical to Session B's header.
 *     The source (canvas + subject point) arrives through the injected
 *     `photoSource` getter; the frame scheduler through `raf`/`cancelRaf`
 *     (window's by default; absent headless → no photo, no throw). **Session
 *     D — the photo on the clicked PART:** `openEntry(id, { anchor })` carries
 *     the hull-click record's screen point + projected pick-mesh bounds
 *     (drawing-buffer px, from MotherCallouts.getHoveredPart); the photo
 *     taken for that edge crops PHOTO_CROP_H_FRAC_PART of the height around
 *     the part (grown to its bounds, capped at the ship crop) and the banner
 *     flashes once on arrival (reduced motion: none). Entry-less opens (the
 *     shell's tab / Space / swipe / restore) and un-anchored openEntry calls
 *     (REFIT title, chips) frame the ship exactly as Session C shipped — the
 *     anchor rides ONE edge and can never go stale under a later camera move.
 *     **Session T — the framed PART PORTRAIT (plan tmp/plans/1788863200000-
 *     specs-pane-part-imagery.md, option E):** the anchor also carries the
 *     clicked part's `partId`, and the photo edge's FIRST read asks
 *     `photoSource(anchor)` for a framed picture — the hub renders the part
 *     once, callout-free, from a camera aimed at its pick-mesh box
 *     (SceneManager.renderPartPortrait) and answers `{ canvas, framed: true }`,
 *     which the pane draws WHOLE (no crop law — the render is the picture; the
 *     banner keeps its 16:10 through `aspect-ratio`). Any framed miss — the
 *     hub answers a live source (a card-only part, no callouts), or the framed
 *     read comes back blank / sizeless / throws — falls to the live crop: the
 *     remaining tries of the edge ask `photoSource(anchor, 'live')`,
 *     byte-identical to Session D. One framed attempt per edge, never per frame.
 *   - `shortText` — the plain-English "why it matters" line every entry has.
 *   - a generated SPECS block for HARDWARE entries (entries carrying
 *     `hardwareNames`), from the entry's EXISTING fields only (no invented
 *     data): HARDWARE (the in-game hardware names), TECH LEVEL (trl + the
 *     Constants tier label), FORMULA. Unlocked depth only, like the viewer.
 *     Rendered in the TAIL (Session U).
 *   - `related` chips — click navigates the PANE to that entry (locked
 *     relateds show a LOCKED tag and navigate to the locked stub, viewer
 *     parity). In the TAIL; on glass (`deps.glass`, D10) each chip is a
 *     44 pt-tall touch target (RELATED_CHIP_GLASS_MIN_H_PX — the
 *     actuator-chip law), desktop keeps the shipped size.
 *   - the manual's WARNING (the FURNACE gag, plan 1788957399035 §1.24): an
 *     entry carrying an authored `warning` prints it LAST, after RELATED, as
 *     a steady THREAT-red box with a caps WARNING label — print, not a live
 *     alarm (never pulses). Unlocked depth only; absent → nothing; the
 *     `.library-empty` landing is untouched. The TAIL's last block.
 *   - MAXIMIZE — the full-screen viewer on this entry through the injected
 *     `onMaximize` (main.js routes it over the EXACT CODEX_OPEN_ENTRY path
 *     every deep link rides today; never a fork).
 *   - the Subnautica rule (§2 "clicking a locked part's card unlocks its
 *     entry"): `scanPart(part)` requests the unlock of a LOCKED part's entry
 *     through the injected `requestUnlock` — main.js routes it over the ONE
 *     existing unlock path (CODEX_UNLOCK_REQUEST → CodexSystem's queue → the
 *     ticker ack chip → CODEX_UNLOCKED). Never a second unlock mechanism;
 *     already-unlocked / unknown / briefing-less parts are safe no-ops.
 *   - locked entries render the viewer's honest locked stub: LOCKED + the
 *     entry's own `unlockHint` (full briefing stays MAXIMIZE-away once
 *     unlocked). The stub stays in the HEAD (Session U).
 *
 * THE DOSSIER FOLLOWS CLICKS (Wave 5 Session C — the 2026-09-03 playtest
 * "Library is blank" bug — and Session U's D6 click verb):
 *   - every hull part / callout-card click reaches this engine through the
 *     SAME `openEntry(codexId, { via, anchor })` path the REFIT title rides —
 *     since Session U the shell's `showPart(part)` (D6) calls it and OPENS the
 *     pane when it was closed (Session C's "a closed library is never opened
 *     by a part click" retired with the one pane; the engine itself still
 *     only stores the entry while disabled).
 *   - opening with NO entry (the shell's tab / Space / swipe / restore) lands
 *     on something real instead of the prompt: the injected `subject` getter
 *     answers "what is the player looking at" — main.js chains the focused
 *     hull part's codexId (MotherCallouts.getFocusedPart, COMPONENT band)
 *     then the REFIT card's manifest deep link (RefitPane.focusedCodexId) —
 *     consulted ONLY when the pane has no entry (a shown entry survives close
 *     → re-open); unknown / null / throwing → the prompt copy stays. The
 *     engine stays eventless: it never reads MotherCallouts or the REFIT.
 *
 * READ = SEEN: an entry resting open ≥ SEEN_DWELL_MS (1500 — the shipped
 * CodexViewerUI dwell) fires the injected `onViewed(id)` once for unlocked,
 * unseen entries — main.js routes it over the SAME CODEX_VIEWED event the
 * viewer emits, so CodexSystem.markSeen is the one seen-writer and the
 * shell's tab count (`unreadCount()`) drops when the player actually reads.
 * Scrubbing to another entry before the dwell cancels it (the viewer's
 * contract).
 *
 * @module ui/LibraryPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { trlToLabel, techLevelBadgeText } from '../core/Constants.js';

/** Dwell before an open entry is marked seen — the shipped CodexViewerUI
 *  SEEN_DWELL_MS (CodexViewerUI.js:58), mirrored so the pane and the viewer
 *  share one reading contract. */
export const SEEN_DWELL_MS = 1500;
/** RELATED chip minimum height on glass (px): the 44 pt HIG box — the
 *  actuator-chip law (RefitPane ACTUATOR_CHIP_GLASS_MIN_H_PX; plan D10).
 *  Desktop chips keep the shipped padding-only size. */
export const RELATED_CHIP_GLASS_MIN_H_PX = 44;
/** The photo crop: source region height as a fraction of the canvas height
 *  (16:10 — PHOTO_W × PHOTO_H output px), centred on the subject point — the
 *  SHIP's projection (the tab / REFIT-title / chip opens). */
export const PHOTO_CROP_H_FRAC = 0.42;
/** The photo crop when ANCHORED on a clicked part (Session D, owner decision
 *  2): tighter than the ship crop; grows to fit the part's projected bounds
 *  (× PHOTO_BOUNDS_PAD) but never past PHOTO_CROP_H_FRAC. */
export const PHOTO_CROP_H_FRAC_PART = 0.26;
/** Padding factor applied to the part's bounds when the anchored crop grows. */
export const PHOTO_BOUNDS_PAD = 1.15;
/** The one-shot banner flash when a photo lands (ms) — reduced motion: none. */
export const PHOTO_FLASH_MS = 600;
/** Photo output size (device px of the thumbnail canvas). */
export const PHOTO_W = 320;
export const PHOTO_H = 200;
/** Frames the photo read is retried when the buffer reads blank (a frame the
 *  loop skipped rendering) before the text header stands alone. */
export const PHOTO_TRIES = 3;
/** Blank test: a sampled pixel "lights" when r+g+b exceeds this (the
 *  crop-probe threshold, 2026-09-03). */
const PHOTO_LIT_SUM = 24;
/** Blank test sampling stride (px) — a coarse grid, never the full crop. */
const PHOTO_SAMPLE_STRIDE = 8;
/** The LOCKED marker after a locked entry's title (Session L, plan D-J: no
 *  glyphs in chrome): a small letter-spaced text chip, `.library-lock`. */
const LOCK_CHIP_HTML = ' <span class="library-lock" style="display:inline-block;vertical-align:middle;font-size:0.7em;letter-spacing:0.1em;padding:0 4px;border:1px solid currentColor;border-radius:2px;opacity:0.85">LOCKED</span>';
/** The same marker inside a RELATED chip (already a bordered pill): text only. */
const LOCK_TAG_HTML = ' <span class="library-lock" style="font-size:0.75em;letter-spacing:0.1em;opacity:0.85">LOCKED</span>';
/** The no-entry prompt (Session U, D6: the click verb is the part's dossier). */
const EMPTY_COPY = 'Click a hull part or its card to read about it.';

/** G1 write cap — the ProxContextPanel/TransferWindows house value. */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** House reduced-motion probe (the FloorMask.js:188-196 shape) — the banner
 *  flash is the engine's ONLY motion; every other reduced-motion swap (slide
 *  → fade, tab flip, no pulse) is the shell's. */
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
   * Every dep optional; the engine is inert headless (no DOM at import, no
   * DOM until `mount`) and never throws on a missing dep.
   * Session U (plan 1788954873769 §3): `footerBottomPx`, `reducedMotion` and
   * `onOpenChange` are the SHELL's (WorkbenchPane) and are IGNORED here when
   * an older hub still passes them.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document for the photo thumbnail canvas (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.codex] - the CodexSystem instance (getEntry /
   *   getRelated / getCategoryMeta / entries) — read-only truth
   * @param {function} [deps.onMaximize] - (id) => void (main.js: the exact
   *   CODEX_OPEN_ENTRY deep-link emit → the full-screen viewer)
   * @param {function} [deps.requestUnlock] - (id) => void (main.js: the ONE
   *   unlock path, CODEX_UNLOCK_REQUEST → CodexSystem's queue + ack chip)
   * @param {function} [deps.onViewed] - (id) => void (main.js: the shipped
   *   CODEX_VIEWED emit → CodexSystem.markSeen, the one seen-writer)
   * @param {function} [deps.subject] - () => codexId|null (Session C): what
   *   the player is looking at — main.js chains the focused hull part's
   *   codexId, then the REFIT card's manifest deep link. Consulted ONLY when
   *   the pane opens with NO entry (the shell's entry-less open); a null /
   *   unknown / throwing answer keeps the prompt copy.
   * @param {function} [deps.photoSource] - (anchor, hint) => ({ canvas, x, y }|{ canvas, framed: true })|null
   *   (Session C, decision 2 → Session T): the picture source for the photo
   *   edge. `anchor` is THIS edge's click anchor ({ x, y, bounds, partId } |
   *   { partId } | null — null on an entry-less open); `hint` is `undefined`
   *   (a framed part portrait is welcome) or `'live'` (the live crop only —
   *   this edge's framed attempt already ran). A LIVE answer is the render
   *   canvas + the subject's point in CANVAS (drawing-buffer) px to crop
   *   around — main.js projects the ship; a FRAMED answer (`framed: true`) is
   *   a canvas that IS the picture (the hub's one-shot part render, 16:10) and
   *   is drawn whole, no crop. Read once per photo try, on the open / entry
   *   edge only.
   * @param {function} [deps.raf] - (cb) => handle: the frame scheduler for
   *   the deferred photo read (default window.requestAnimationFrame; absent →
   *   no photo, the text header stands alone)
   * @param {function} [deps.cancelRaf] - (handle) => void (default
   *   window.cancelAnimationFrame)
   * @param {boolean} [deps.glass] - the boot's glass answer (plan D10): the
   *   RELATED chips are 44 pt tall on glass (RELATED_CHIP_GLASS_MIN_H_PX),
   *   the shipped padding-only size on desktop
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
    /** Session U (D10): glass boot → the RELATED chips wear the 44 pt HIG box. */
    this._glass = !!deps.glass;
    // deps.footerBottomPx / deps.reducedMotion / deps.onOpenChange: the
    // shell's (Session U) — deliberately not read.

    this._enabled = false;
    this._open = false;
    this._entryId = null;         // the entry the pane is showing (null = prompt)
    this._via = null;             // the clicked part's callout name behind the entry (header lead), else null
    // Mount state (Session U): the two containers the shell hands over, the
    // shell's repaint hook, and the ONE bound delegated-click handler shared
    // by both containers (kept so dispose can remove it).
    this._head = null;
    this._tail = null;
    this._onRefresh = null;
    this._mounted = false;
    this._onClickBound = (e) => this._onClick(e);
    // G1: one struct-key gate, two write-on-change caches (head / tail).
    this._lastHeadHtml = null;
    this._lastTailHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
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
    // The click anchor behind the CURRENT openEntry edge (Session D): { x, y,
    // bounds } in drawing-buffer px from the shell's showPart — the photo
    // crops around the clicked PART instead of the ship. Set by openEntry,
    // cleared by every entry-less open() so it can never go stale under a
    // later camera move; read at frame time by _readPhoto.
    this._photoAnchor = null;
    // Session T: true once THIS edge's framed portrait attempt has run (blank,
    // sizeless or thrown) — the remaining tries ask the source for the live
    // crop ('live'). Reset by every _takePhoto (one framed attempt per edge).
    this._photoLiveOnly = false;
    this._photoFlashes = 0;       // banner flashes fired (tests/witness probe)
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
   * The tab's UNREAD count: unlocked entries not yet seen, EXCLUDING the
   * `startUnlocked` set (Session O, plan D16b, owner 2026-09-07): those 74
   * are PLAYBOOK + WORLD_INDUSTRY + the 12 cornerstones (`codexTriggers.js:42`)
   * and are readable from the first library open — counting them made the badge read
   * "74" forever and teach nothing ("the 74 only distract"). The badge therefore
   * counts REAL unlocks only — a small deviation from the viewer's NEW-pip
   * predicate (which still includes startUnlocked entries); the viewer's pips
   * are NOT changed by this rule. Pure. The instance read `unreadCount()`
   * (no argument) applies it to the injected codex — the shell's tab number.
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

  // ── Lifecycle (state-only until mounted; the shell drives every edge) ──────

  /** @returns {boolean} */
  isOpen() { return this._open; }
  /** @returns {boolean} */
  isEnabled() { return this._enabled; }
  /** @returns {boolean} true between mount() and dispose() */
  isMounted() { return this._mounted; }
  /** @returns {string|null} the entry the pane is showing (null = the prompt) */
  currentEntryId() { return this._entryId; }

  /**
   * Session U (plan D3): the number the shell's ONE tab shows off F1 (and on
   * F1 when no refit is affordable) — the static `unreadCount` law over the
   * injected codex, read live (232 entries; edges only, never per frame).
   * Absent / throwing codex → 0.
   * @returns {number}
   */
  unreadCount() { return this._unread(); }

  /**
   * Session U (plan 1788954873769 §3): the shell hands over the two elements
   * this engine renders into — HEAD (`.workbench-head`) and TAIL
   * (`.workbench-tail`) — and its repaint hook. Attaches ONE delegated click
   * listener to each container (`[data-max]` → onMaximize, `[data-rel]` → the
   * related entry), cold-starts both write-on-change caches and paints the
   * current model at once (silently — the shell paints its own tab when its
   * build finishes; `onRefresh` fires from `refresh()` edges). Re-mounting
   * detaches from the previous containers first. Disposed engines refuse.
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
   * Enable on controller engage / disable on disengage — the SHELL calls it
   * (`WorkbenchPane.setEnabled`; the engine stays enabled on every floor —
   * deep links work everywhere, D7 hides only the REFIT slot). Enabled →
   * repaint; disabled → close. Idempotent; no chrome, no container display
   * writes (the shell hides the whole pane).
   * @param {boolean} on
   */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (on) this.refresh();
    else this.close();
  }

  /** Open the dossier (no-op while disabled; the shell slides + signals).
   *  An ENTRY-LESS open (the shell's tab / Space / swipe / flick / restore —
   *  never openEntry, which has its entry) first adopts the injected `subject`
   *  so the pane lands on the part the player is looking at instead of the
   *  prompt (Session C). No click is behind it, so any click anchor from an
   *  earlier openEntry is dropped: the photo frames the ship (Session D). The
   *  shell must never call this on the showPart / openEntry paths (plan §7). */
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

  /** Close the dossier: the seen dwell and any pending photo read are
   *  dropped; the shown entry is remembered (close → re-open returns to it).
   *  Idempotent. The shell slides out and signals. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._clearSeenTimer();
    this._cancelPhoto();
  }

  /**
   * Session J (plan D-C, "SPECS opens on the floor's subject"): forget the
   * remembered entry while CLOSED, so the NEXT entry-less open adopts the
   * injected `subject` instead of re-showing a page from another floor. The
   * hub calls it (through the shell) on a floor arrival / a selection change
   * while the pane is shut (an OPEN pane is retargeted through openEntry
   * instead — the follow). Session C's rule stands on the same floor: nothing
   * here runs without a subject change, so close → re-open still returns to
   * the shown entry. No-op while open (never a cut under the reader) or
   * disabled-with-nothing.
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
   * Deep-link into the dossier: show one entry and open (the REFIT card title
   * / RELATED chip / ticker chip route — 03-plan §3 "tap → TECH LIBRARY
   * slides in" — and, since Session U, the shell's `showPart(part)` for every
   * hull part / callout-card click (D6), which passes the part's name + click
   * anchor). An open pane FOLLOWS every call in place: entry + seen dwell
   * retargeted, no second open edge. Unknown ids keep the current view and
   * still open (never a throw, never a blank crash — the viewer's "safe no-op"
   * contract). While disabled the entry is stored for the next open. The
   * click anchor is KEPT (it rides this edge's photo) — only the entry-less
   * open() drops it.
   * @param {string} id - codex entry id
   * @param {{ via?: string, anchor?: {x?:number,y?:number,bounds?:object,partId?:string}|null }} [opts]
   *   `via`: the clicked part's callout name (the shell passes `part.name`);
   *   the header leads with it when it is one of the entry's own
   *   `hardwareNames`. `anchor` (Session D): the clicked part's screen point
   *   (+ its projected pick-mesh `bounds`) in DRAWING-BUFFER px — the shell
   *   passes `part.screen` / `part.bounds` from the hull-click record; the
   *   photo taken for THIS edge crops around it (PHOTO_CROP_H_FRAC_PART,
   *   grown to the bounds, capped at the ship crop). Session T: `partId` (the
   *   record's `id`) rides it too — with or without a screen point — and is
   *   what the hub frames the part portrait from. Absent (REFIT title,
   *   related chip, MAXIMIZE) → the header leads with every name the entry
   *   documents and the photo frames the ship.
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
    // The click anchor rides THIS edge only (the newest edge owns the photo):
    // a finite point is kept with its bounds; anything else → the ship.
    // Session T: the part id rides it too (`partId` — the hub's framed portrait
    // needs no screen point), with or without a finite point; a malformed
    // anchor carrying no id is still null.
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
      // Already open and the entry changed (the hull-click follow / a
      // related chip): the photo you just took is THIS click's frame.
      if (wasOpen && changed) this._takePhoto();
    }
    return !!entry;
  }

  /**
   * The Subnautica rule (08-workbench §2: "Clicking a locked part's card
   * unlocks its entry — exploration is how the library fills"): called by the
   * shell's showPart on a HULL part/card click. A resolved, LOCKED entry fires
   * the injected requestUnlock — the ONE existing unlock path (CodexSystem's
   * queue: ticker ack chip now, chime + CODEX_UNLOCKED on the queue's own
   * schedule; the shell's tab pulses when the unlock lands). Unlocked /
   * unknown / briefing-less parts are safe no-ops. Never opens the pane (the
   * shell decides that).
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
   * Recompute + repaint (G1: the struct-key gate + the 250 ms cap; structural
   * changes write immediately; each container is written only when its own
   * HTML changed). Unmounted: computes and returns the model. After every
   * repaint (= every refresh whose gate opened) the shell's `onRefresh` fires
   * once, so the tab count follows on the same edge. Called on interaction
   * edges + the shell's refresh (CODEX_UNLOCKED / CODEX_VIEWED) — never per
   * frame.
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

  /** @private The raw writer behind mount() / refresh(): both halves through
   *  their own write-on-change cache; the gate state records this paint. */
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

  /** Drop every timer + pending read, blank the two containers this engine
   *  painted, remove its listeners; the instance stays inert afterwards. The
   *  containers themselves are the shell's (it removes its root); no
   *  open-signal — the shell emits that once, after its own `_open` flip. */
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

  // ── Model (pure per-call reads of the injected truth) ─────────────────────

  /** @private Guarded entry read (unknown/absent codex → null, never throws). */
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
      id: r.id, title: r.title, unlocked: !!r.unlocked,
    })) : [];
    const specs = (entry && entry.unlocked) ? LibraryPane.specsFor(entry) : [];
    // The bridge line (Session D): hardware entries only, authored data.
    const note = LibraryPane.hardwareNote(entry);
    // The manual's warning (plan 1788957399035 §1.24): authored data, read
    // straight off the entry by _htmlTail; rides the struct key beside the
    // note so a re-authored line repaints at once (symmetry with hardwareNote).
    const warning = (entry && typeof entry.warning === 'string') ? entry.warning : '';
    // The photo shows only for the entry it was taken for (never a stale
    // frame under a newer entry); absent → the text header stands alone.
    const photo = (entry && this._photo && this._photo.id === entry.id) ? this._photo.url : null;
    // The unread count rides the struct key so a count change opens the gate
    // (→ onRefresh → the shell's tab) even when no rendered byte moved.
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

  // ── Markup (VisualLaw colors; inline styles; nothing at import) ────────────

  /** @private Reduced-motion read for the ONE motion this engine owns (the
   *  banner flash): the house matchMedia probe. Tests override the method. */
  _reducedMotion() {
    return _prefersReducedMotion();
  }

  /**
   * @private The HEAD half (Session U, plan §2 `.workbench-head`): the header
   * row, the no-entry prompt, the photo banner, the entry header, the bridge
   * line, the shortText and the LOCKED stub — everything that identifies the
   * part, above the shell's REFIT slot.
   */
  _htmlHead(m) {
    const C = VisualLaw.COLORS;
    const parts = [];
    // Header (.library-header): the pane name + MAXIMIZE (the full-screen
    // viewer — the old F1 — one click away, never hidden). PaneHelp's [?]
    // anchor (`#ladder-workbench .library-header`).
    parts.push(
      `<div class="library-header" style="display:flex;justify-content:space-between;align-items:baseline;color:${C.PLAYER};border-bottom:1px solid rgba(0,204,255,0.25);padding-bottom:6px;margin-bottom:8px">` +
      '<span>SPECS</span>' +
      (m.entry
        ? `<button class="library-max" data-max="${m.entry.id}" style="cursor:pointer;background:none;border:1px solid rgba(0,204,255,0.4);color:${C.INFO};font:inherit;padding:0 6px;border-radius:3px">MAXIMIZE \u2197</button>`
        : '') +
      '</div>',
    );
    if (!m.entry) {
      // The no-entry landing (D6: the click verb is the part's dossier).
      parts.push(`<div class="library-empty" style="opacity:0.7">${EMPTY_COPY}</div>`);
      return parts.join('');
    }
    const e = m.entry;
    const locked = !e.unlocked;
    // The photo you just took (Session C): a banner above the entry header
    // when the deferred frame read succeeded; otherwise nothing here and the
    // text header below stands alone (the fallback = Session B's header).
    // Session T (owner Q1): the banner keeps the photo's own 16:10
    // (PHOTO_W × PHOTO_H) through `aspect-ratio` instead of a fixed 110 px
    // height — a framed part portrait is composed for that frame and must not
    // be cropped by the pane's width (01-numbers.md "Workbench panes").
    if (m.photo) {
      parts.push(
        `<img class="library-photo" alt="" src="${m.photo}" style="display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border:1px solid rgba(0,204,255,0.35);border-radius:4px;margin-bottom:8px${locked ? ';opacity:0.7' : ''}">`,
      );
    }
    // Entry header: the lead line + the subtitle, text only — the entry's data
    // `icon` is never rendered (plan D-J); a locked entry carries a LOCKED text
    // chip (.library-lock) after the title span. Hardware entries lead with the
    // PART (the clicked callout name when known) and carry the briefing's
    // title as the subtitle — see headerLead().
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
      // The viewer's honest locked stub: how to unlock, nothing invented. It
      // stays in the HEAD — the identity half says why there is no depth yet.
      parts.push(
        `<div class="library-locked" style="color:${C.VALUE};border:1px dashed rgba(255,209,102,0.5);border-radius:3px;padding:6px 8px;margin-bottom:8px">` +
        `LOCKED \u00b7 How to unlock: ${e.unlockHint || 'Discover through gameplay.'}` +
        '</div>',
      );
    }
    return parts.join('');
  }

  /**
   * @private The TAIL half (Session U, plan §2 `.workbench-tail`): the deeper
   * reading below the shell's REFIT slot — the generated SPECS table, the
   * RELATED chips and the manual's WARNING. Empty for the prompt and for a
   * locked entry without relateds.
   */
  _htmlTail(m) {
    const e = m.entry;
    if (!e) return '';
    const C = VisualLaw.COLORS;
    const parts = [];
    const locked = !e.unlocked;
    if (!locked && m.specs.length) {
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
    // Related chips — click navigates the PANE (locked relateds carry the
    // viewer's LOCKED text tag and navigate to the locked stub; no entry icon).
    // Glass (D10): a 44 pt-tall flex pill (the actuator-chip law) so a thumb
    // lands it; desktop keeps the shipped padding-only size, byte-identical.
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
    // WARNING — the manual's authored notice (the FURNACE gag, plan
    // 1788957399035 §1.24): a STEADY red box after RELATED, the foot of the
    // page — print, not a live alarm (THREAT is the ink here; it never
    // pulses). Unlocked depth only, and only when the data carries one
    // (`e.warning`, flattened by CodexSystem._buildEntry); absent → nothing.
    // The `.library-empty` landing is untouched (page one of the manual is
    // the I-key viewer's first entry, not this drawer).
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

  // ── Interaction (delegated — one handler, both containers) ─────────────────

  /** @private */
  _closest(el, sel) {
    return (el && typeof el.closest === 'function') ? el.closest(sel) : null;
  }

  /** @private */
  _onClick(e) {
    const max = this._closest(e && e.target, '[data-max]');
    if (max) {
      const id = max.getAttribute('data-max');
      // MAXIMIZE = the full-screen viewer on this entry — main.js routes it
      // over the exact CODEX_OPEN_ENTRY deep-link path (never a fork).
      if (id && this._onMaximize) { try { this._onMaximize(id); } catch (_e) { /* dep */ } }
      return;
    }
    const rel = this._closest(e && e.target, '[data-rel]');
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
   *  count drop reaches the shell's tab at once (onRefresh). */
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
   * scheduler; otherwise the text header stands alone. A pending read is
   * replaced (the newest edge owns the photo).
   */
  _takePhoto() {
    this._cancelPhoto();
    if (!this._open || this._disposed || !this._entryId || !this._photoSource || !this._raf) return;
    this._photoTry = 0;
    this._photoLiveOnly = false;       // Session T: every edge gets ONE framed attempt first
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
   * frame up to PHOTO_TRIES, then dropped — the text header stands alone.
   * Any throw (a tainted canvas, a missing 2D context) drops it the same way.
   * Session T: the first attempt asks the source for the FRAMED part portrait;
   * once a framed read has been attempted (blank, sizeless, or a throw) every
   * remaining try of this edge asks for the live crop instead (`'live'`).
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
   * @private One read attempt. The source is asked with THIS edge's anchor and
   * a hint: `undefined` = the framed portrait is welcome, `'live'` = the live
   * crop only (a framed attempt already ran for this edge). A FRAMED source
   * (`{ canvas, framed: true }` — the hub's one-shot part render) is drawn
   * WHOLE (no crop law: the render is already the picture); a live source is
   * cropped by `photoCrop`. Either way the blank test decides.
   * @returns {boolean} true when a photo landed.
   */
  _readPhoto() {
    const src = this._photoSource ? this._photoSource(this._photoAnchor, this._photoLiveOnly ? 'live' : undefined) : null;
    const framed = !!(src && src.framed);
    // One framed attempt per edge: whatever happens below (blank / sizeless /
    // a throw in drawImage), the next try of this edge asks for the live crop.
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
    // Source crop (the pure law, pinned): the ship crop centred on the
    // source point, or — when this edge came from a hull click — the tighter
    // PART crop centred on the clicked part, grown to its bounds. A framed
    // portrait is the whole canvas.
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
    this._flashBanner();               // the one-shot arrival flash (reduced motion: none)
    return true;
  }

  /**
   * The photo crop law (pure, exported for the suite). A 16:10 source rect
   * (PHOTO_W × PHOTO_H output) inside a W × H canvas:
   *   - no anchor → PHOTO_CROP_H_FRAC of the height, centred on the source
   *     point (the ship's projection; an unprojectable point → the centre);
   *   - anchor (a hull click, Session D) → PHOTO_CROP_H_FRAC_PART of the
   *     height, centred on the PART's screen point; when the anchor carries
   *     the part's projected bounds the crop grows so the whole part fits
   *     (the farthest bounds edge from the anchor, × PHOTO_BOUNDS_PAD, in
   *     either axis) but never past the ship crop — a small sensor gets the
   *     tight frame, a wing gets the ship's.
   * The rect is CLAMPED inside the canvas (an edge subject slides the crop,
   * never shrinks it). Owner decision 2 (2026-09-04): PART fraction 0.26.
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
    const sx = Math.max(0, Math.min(W - cw, Math.round(cx - cw / 2)));
    const sy = Math.max(0, Math.min(H - ch, Math.round(cy - ch / 2)));
    return { sx, sy, cw, ch, anchored };
  }

  /** @private A bounds box with four finite edges, else null. */
  static _finiteBounds(b) {
    if (!b || !Number.isFinite(b.x0) || !Number.isFinite(b.y0) || !Number.isFinite(b.x1) || !Number.isFinite(b.y1)) return null;
    return { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
  }

  /**
   * @private The one-shot arrival flash on the banner (Session D): right after
   * the structural repaint that inserted `.library-photo` into the HEAD, run
   * a PHOTO_FLASH_MS brightness/ring animation on it through the Web
   * Animations API — no stylesheet, no second style write, no timer, the
   * element returns to its inline style by itself. Reduced motion → none (the
   * banner's arrival is the signal). Headless / unmounted (no querySelector /
   * no animate) → counted, not drawn. Never per frame: once per photo landed.
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
}

export default LibraryPane;
