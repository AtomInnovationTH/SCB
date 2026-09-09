/**
 * RefitPane.js — Wave 5 (2): the REFIT section of the ONE workbench pane — a
 * HOSTED SECTION ENGINE, rendered into the slot WorkbenchPane mounts it in
 * (docs/ladder/08-workbench.md §2 "REFIT card" + §3; 00-spec.md §3 F3
 * amendment; 01-numbers.md "Workbench panes"; 03-plan.md "Wave 5 — GO" (2);
 * Session U, plan .kilo/plans/1788954873769-one-workbench-pane.md §3 "Hosted
 * engine contracts — RefitPane (A3)", D10 / D12 / D13).
 *
 * HOSTED BY WorkbenchPane (Session U 2026-09-09, plan D5): this module owns
 * CONTENT only — the model, the markup, the delegated interactions and the
 * hull-ghost routing. The root, the footer tab (SPECS + the gold count of
 * affordable refits), the slide, the idle fade, reduced motion, the RTL
 * variable, the depot-invitation glow and the ONE open state / onOpenChange
 * edge all live in js/ui/WorkbenchPane.js (with the moved constants
 * PANE_SLIDE_MS / IDLE_FADE_* / PANE_Z_INDEX / ROOT_BOTTOM_PX / INVITE_HALO).
 * The shell calls `mount(el, { onRefresh })` ONCE with its `.workbench-refit`
 * slot and then drives `setEnabled` (F1 only — off F1 the slot hides),
 * `open({ firstVisit })` / `close()`, `focusPart` (the D6 click verb),
 * `refresh` and `dispose`. `affordableCount()` is the number the shell's tab
 * shows; `onRefresh` fires after every repaint so the tab follows a BUY / a
 * chip tap on the same edge. DOM-less until mounted: every public method is a
 * no-op-safe read/write before `mount` and after `dispose` (the model still
 * computes headless — the ProxContextPanel house pattern: pure static
 * rankers/formatters, the G1 innerHTML cache + the static `shouldWrite` 250 ms
 * DOM-write cap, an injectable `now` clock). NO eventBus/Events import and NO
 * live singletons — every live read (credits, avg credits/catch, upgrade
 * levels, provider rows) and every routed action (purchase, ghost outline,
 * Library deep link) arrives through injected deps, all optional, so the
 * module is headless-safe and the flag-off boot never constructs it.
 * (fittingCatalog's pure-data import chain is the one sanctioned data source.)
 *
 * CONTENT: the header `REFIT · <SUBSYSTEM>` (`.refit-header`, the PaneHelp
 * anchor; the title is the section's ONE Tech Library deep link —
 * `.refit-title[data-codex]` = the manifest codexId, also read by
 * `focusedCodexId()`; alternative rows carry no data-codex — shop rows have
 * no entries and none are invented, Session C decision d), the
 * seven-subsystem INDEX (blueprintSubsystems, priority order) → one focused
 * per-subsystem CARD:
 *   - the INSTALLED model pinned at top with live rows from
 *     `providers[readout]()` — the SAME providers object main.js builds for
 *     HullCamFloor (`() => string[]`, or an object rendered as 'KEY: value'
 *     rows); an absent or throwing provider degrades to the manifest `spec`
 *     rows (never blank, never a crash);
 *   - EXACTLY three alternatives from `groupBySubsystem()[sub]`, ranked
 *     affordable-now → next-affordable → aspirational (ties: lower cost, then
 *     catalog order); OWNED-at-maxLevel entries are never offered; fewer than
 *     three candidates → fewer rows; an empty subsystem reads "nothing to
 *     refit yet" (Q3 graceful).
 *   - Row = name · the one number (display.param/base/unit/op via the
 *     `current` adapter) with a delta arrow · cost · state chip
 *     (`BUY` / `N catches away` / `needs <prereq>` / `OWNED n/n`).
 *     N = ceil((cost − credits) / avg) from getAvgCreditsPerCatch(); a null
 *     avg falls back to the plain cost chip. Prereqs go through the SAME
 *     `upgradePrereqsMet` predicate ShopScreen's purchase guard uses.
 *   - BUY is ONE click (no confirm(), no undo; LIVE allowed —
 *     08-workbench.md:102-104) through the injected `purchase`
 *     (ShopScreen.purchaseUpgrade); the section then re-renders from the
 *     injected getUpgradeLevel/getCredits TRUTH, never from optimism.
 *   - Session L (plan item 4): the INSTALLED block of the OWNING card carries
 *     the actuator TOGGLE chips (POWER: arrays furl + feather; BERTHS: struts;
 *     THERMAL: flower) through the injected `actuators` dep — the SAME actions
 *     the `,` / Shift+`,` / `.` / `O` hotkeys drive; a tap toggles, then the
 *     section re-reads truth (see ACTUATOR_CHIPS and the ctor doc).
 *   - D12 (Session U) — a DETACHED part: a hull part with no refit group
 *     (`subsystemForPart` → null: PAYLOAD / DAUGHTERS) renders `REFIT` + the
 *     seven chips + ONE `.refit-detached` line `no refit fits <PART NAME> —
 *     pick a subsystem` and HIDES INSTALLED / the alternatives / the wallet —
 *     never a stale card under another part's head. A chip tap or a mapped
 *     part clears it. (D13: the THERMAL callout group is a MAPPED group now —
 *     refitIndex.js — so the flower parts land on the THERMAL card.)
 *   - D10 (Session U) — glass touch targets: with `deps.glass` the BUY buttons
 *     and the alternative rows wear `align-items:center; min-height:44px` and
 *     the subsystem / RECOMMENDED chips ride the actuator-chip law
 *     (ACTUATOR_CHIP_GLASS_MIN_H_PX, the 44 pt HIG box); desktop keeps the
 *     shipped sizes byte-for-byte.
 * Fonts: the section inherits the shell body's `var(--font-mono)`; its own
 * buttons say `font:inherit` (test-Fonts). Colours: VisualLaw only (the chips
 * read C.LABEL — test-SessionQ-wiring pins the reader list).
 *
 * @module ui/RefitPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { Constants } from '../core/Constants.js';
import { FITTING_CATALOG, groupBySubsystem } from '../data/fittingCatalog.js';
import { BLUEPRINT_SUBSYSTEMS } from '../data/blueprintSubsystems.js';
import { subsystemForPart, partsForSubsystem } from '../data/refitIndex.js';
import { upgradePrereqsMet } from './shopGating.js';

/** G1 write cap — the ProxContextPanel/TransferWindows house value. */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The seven subsystems in blueprintSubsystems PRIORITY order (higher first —
 *  the manifest's own carousel law), resolved once at import (pure data). */
export const SUBSYSTEM_ORDER = Object.freeze(
  [...BLUEPRINT_SUBSYSTEMS].sort((a, b) => b.priority - a.priority).map((s) => s.id),
);

/** Manifest entry by subsystem id (pure data). @private */
const MANIFEST_BY_ID = new Map(BLUEPRINT_SUBSYSTEMS.map((s) => [s.id, s]));
/** Catalog entry by upgrade id (name lookups for prereq chips). @private */
const CATALOG_BY_ID = new Map(FITTING_CATALOG.map((e) => [e.id, e]));

/**
 * Session L (plan item 4): the actuator TOGGLE chips — the hotkey actions
 * (`,` arrays furl / Shift+`,` feather, `.` struts, `O` flower) reachable
 * from the card of the subsystem that OWNS the hardware, through the
 * injected `actuators` dep (the hub wires each `get`/`toggle` onto the SAME
 * player / ArmManager methods InputManager calls — never a second path).
 * Keyed by the dep field name; `sub` = the hosting blueprintSubsystems id,
 * `name` = the chip's hardware word, `on` = the state that reads
 * aria-pressed="true" (the actuated pose), `words` = the house voice per
 * `get()` value (STATE-first: 'ARRAYS · FURLED'). Pure data.
 */
export const ACTUATOR_CHIPS = Object.freeze({
  rosaFurl:    Object.freeze({ sub: 'POWER',   name: 'ARRAYS',  on: 'FURLED',    words: Object.freeze({ FURLED: 'FURLED', DEPLOYED: 'DEPLOYED' }) }),
  rosaFeather: Object.freeze({ sub: 'POWER',   name: 'FEATHER', on: 'FEATHERED', words: Object.freeze({ FEATHERED: 'ON', FLAT: 'FLAT' }) }),
  struts:      Object.freeze({ sub: 'BERTHS',  name: 'STRUTS',  on: 'DEPLOYED',  words: Object.freeze({ DEPLOYED: 'DEPLOYED', STOWED: 'STOWED' }) }),
  flower:      Object.freeze({ sub: 'THERMAL', name: 'FLOWER',  on: 'OPEN',      words: Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED' }) }),
});
/** The present-but-unowned `get()` value: a DISABLED chip with that text. */
export const ACTUATOR_NOT_FITTED = 'NOT FITTED';
/** Chip minimum height (px): the desktop row, and the 44 pt HIG box on glass
 *  (`deps.glass` — the house idiom; main.js passes the boot's `_glassBoot`).
 *  Owner law 2026-09-06: a new touch target ships at 44 pt on the iPad.
 *  Session U (plan D10): the SAME 44 also sizes the BUY buttons, the
 *  alternative rows and the subsystem / RECOMMENDED chips on glass. */
export const ACTUATOR_CHIP_MIN_H_PX = 28;
export const ACTUATOR_CHIP_GLASS_MIN_H_PX = 44;

/** The glass touch rules every tap target carries (the actuator-chip set). @private */
const GLASS_TOUCH_CSS = 'touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;';

/** Minimal HTML escape for a duck-typed dep string (a pass-through state). @private */
const _esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class RefitPane {
  /**
   * Every dep optional; the engine is inert headless (no DOM at import, no
   * DOM of its own EVER — it renders into the slot the shell mounts) and never
   * throws on a missing dep.
   * Session U: `doc`, `footerBottomPx`, `reducedMotion` and `onOpenChange` are
   * the shell's concerns now and are IGNORED here (a hub still passing them
   * is harmless — no DOM is built from them and no callback is kept).
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.providers] - HullCamFloor's SAME live-row providers,
   *   keyed by the manifest `readout` (main.js:1340)
   * @param {function} [deps.getCredits] - () => number (live wallet)
   * @param {function} [deps.getAvgCreditsPerCatch] - () => number|null
   * @param {function} [deps.getUpgradeLevel] - (id) => number (0 = unowned)
   * @param {function} [deps.purchase] - (id) => void (ShopScreen.purchaseUpgrade)
   * @param {function} [deps.onGhost] - (partIds|null) => void (MotherCallouts.setGhostOutline)
   * @param {function} [deps.onOpenEntry] - (codexId) => void (the Library deep link)
   * @param {function} [deps.adapterDeps] - () => object: the fittingCatalog
   *   `current`-adapter deps ({ player, resourceSystem, kesslerSystem,
   *   sensorSystem, cargoSystem, armManager, captureNetSystem, hasUpgrade })
   *   — a GETTER, resolved per refresh, because some systems construct after
   *   the pane (Session B commit 4; see _adapterDeps). Absent/throwing → {}
   *   (the static catalog base — the honest headless fallback).
   * @param {boolean} [deps.glass] - the boot's glass answer (Session L / D10):
   *   the actuator chips, the subsystem chips, the BUY buttons and the
   *   alternative rows wear the 44 pt HIG box on glass; desktop sizes otherwise
   * @param {function} [deps.getRecommended] - () => (string|null): the shop's
   *   recommended-starter id for a FIRST depot visit (ShopScreen's pure
   *   `recommendedStarter`) — Wave 5 Session K: the one-shop REFIT drawer hosts
   *   the first-visit framing the full-screen shop used to (plan D-B; owner
   *   2026-09-06: "the first-depot RECOMMENDED chip = the REFIT header chip").
   *   Read on `open({ firstVisit: true })` only; absent → no chip.
   * @param {object} [deps.actuators] - Session L (plan item 4): the actuator
   *   toggles, all optional, duck-typed, never trusted to not throw:
   *   `{ rosaFurl: { get(): 'FURLED'|'DEPLOYED'|null, toggle() },
   *      rosaFeather: { get(): 'FEATHERED'|'FLAT'|null, toggle() },
   *      struts: { get(): 'DEPLOYED'|'STOWED'|null, toggle() },
   *      flower: { get(): 'OPEN'|'CLOSED'|'NOT FITTED'|null, toggle() } }`.
   *   `get()` null (or absent / throwing) = the hardware is not present → no
   *   chip; 'NOT FITTED' = present-but-unowned → a disabled chip. A tap calls
   *   `toggle()` then re-reads truth (no optimistic flip). The hub wires each
   *   onto the SAME methods the hotkeys call and emits the input events itself.
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._providers = deps.providers || null;
    this._getCredits = deps.getCredits || null;
    this._getAvg = deps.getAvgCreditsPerCatch || null;
    this._getLevel = deps.getUpgradeLevel || null;
    this._purchase = deps.purchase || null;
    this._onGhost = deps.onGhost || null;
    this._onOpenEntry = deps.onOpenEntry || null;
    this._adapterDepsFn = deps.adapterDeps || null;
    this._getRecommended = deps.getRecommended || null;
    /** Session L / D10: glass boot → every tap target wears the 44 pt HIG box. */
    this._glass = !!deps.glass;
    this._actuators = (deps.actuators && typeof deps.actuators === 'object') ? deps.actuators : null;
    // (deps.doc / deps.footerBottomPx / deps.reducedMotion / deps.onOpenChange:
    // the shell's — ignored, see the ctor doc.)

    /** Session K: the first-visit framing — true from open({firstVisit}) to close(). */
    this._firstVisit = false;
    this._enabled = false;        // the shell's floor gate (F1 only): hides the slot when off
    this._open = false;           // the shell's told-state (open({...}) … close())
    this._focused = SUBSYSTEM_ORDER[0];   // POWER — the highest-priority card
    /** D12: `{ id, name }` of a clicked hull part with NO refit group, else null. */
    this._detached = null;
    // Hosting: the slot the shell mounted us in + its refresh hook.
    this._el = null;
    this._onRefresh = null;
    this._handlers = null;        // the delegated listeners on the slot (removed on dispose)
    this._mounting = false;       // true during mount()'s first paint (no onRefresh for it)
    /** The last model's affordable count — what the shell's tab shows. */
    this._affordable = 0;
    // G1 cache.
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    // Ghost bookkeeping: true while an alternative hover holds hull ghosts on.
    this._ghosting = false;
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
   * The ranking law (08-workbench §2): affordable-now → next-affordable →
   * aspirational; ties by lower cost, then catalog order. OWNED-at-maxLevel
   * never offered (consumables never max). Pure — returns the FULL ranked
   * candidate list; the card renders the first three.
   * @param {Array<object>} entries - fitting entries (subsystem group, catalog order)
   * @param {{ credits:number, levelOf:function, prereqsMet:function }} ctx
   * @returns {Array<{ entry:object, cls:number }>}
   */
  static rankAlternatives(entries, ctx) {
    const ranked = [];
    (entries || []).forEach((entry, i) => {
      const shop = entry.shop || {};
      const level = ctx.levelOf ? (ctx.levelOf(entry.id) || 0) : 0;
      const maxed = !shop.consumable && Number.isFinite(shop.maxLevel) && level >= shop.maxLevel;
      if (maxed) return;                       // OWNED at maxLevel: never offered
      const prereqs = ctx.prereqsMet ? !!ctx.prereqsMet(shop) : true;
      const affordable = (shop.cost ?? Infinity) <= (ctx.credits ?? 0);
      const cls = prereqs ? (affordable ? 0 : 1) : 2;
      ranked.push({ entry, cls, _cost: shop.cost ?? Infinity, _i: i });
    });
    ranked.sort((a, b) => (a.cls - b.cls) || (a._cost - b._cost) || (a._i - b._i));
    return ranked.map(({ entry, cls }) => ({ entry, cls }));
  }

  /**
   * "N catches away": ceil((cost − credits) / avg) with a 1 floor; null when
   * the average is unknown (no catches yet) or non-positive.
   * @param {number} cost @param {number} credits @param {number|null} avg
   * @returns {number|null}
   */
  static catchesAway(cost, credits, avg) {
    if (!Number.isFinite(avg) || avg <= 0) return null;
    return Math.max(1, Math.ceil((cost - credits) / avg));
  }

  /**
   * The state chip for one candidate (08-workbench §2 grammar):
   * `BUY` / `N catches away` / `needs <prereq>` / `OWNED n/n`; a null avg
   * falls back to the plain cost chip.
   * @param {object} entry - fitting entry
   * @param {{ credits:number, avg:(number|null), levelOf:function,
   *           prereqsMet:function, nameOf:function, ownedHas:function }} ctx
   * @returns {{ kind:'buy'|'wait'|'needs'|'owned'|'cost', text:string }}
   */
  static chipFor(entry, ctx) {
    const shop = entry.shop || {};
    const level = ctx.levelOf ? (ctx.levelOf(entry.id) || 0) : 0;
    if (!shop.consumable && Number.isFinite(shop.maxLevel) && level >= shop.maxLevel) {
      return { kind: 'owned', text: `OWNED ${level}/${shop.maxLevel}` };
    }
    if (ctx.prereqsMet && !ctx.prereqsMet(shop)) {
      const ids = [];
      if (shop.requires) ids.push(shop.requires);
      if (Array.isArray(shop.requiresAll)) ids.push(...shop.requiresAll);
      const missing = ids.find((id) => !(ctx.ownedHas && ctx.ownedHas(id)));
      const name = (missing && ctx.nameOf && ctx.nameOf(missing)) || missing || 'prerequisite';
      return { kind: 'needs', text: `needs ${name}` };
    }
    const cost = shop.cost ?? 0;
    if (cost <= (ctx.credits ?? 0)) return { kind: 'buy', text: 'BUY' };
    const n = RefitPane.catchesAway(cost, ctx.credits ?? 0, ctx.avg);
    if (n != null) return { kind: 'wait', text: n === 1 ? '1 catch away' : `${n} catches away` };
    return { kind: 'cost', text: `${cost} cr` };
  }

  /**
   * Delta arrow from the display op grammar ('×N' multiply, '+N' add,
   * '=N' absolute set, 'ON' enable): the direction the NUMBER moves.
   * @param {{op:string, base:*}|null} display
   * @param {*} current - live adapter value (undefined → compare '=' to base)
   * @returns {'↑'|'↓'|''}
   */
  static deltaArrow(display, current) {
    if (!display || typeof display.op !== 'string') return '';
    const op = display.op;
    if (op === 'ON') return '\u2191';
    const n = parseFloat(op.slice(1));
    if (!Number.isFinite(n)) return '';
    if (op[0] === '+') return n > 0 ? '\u2191' : (n < 0 ? '\u2193' : '');
    if (op[0] === '\u00d7') return n > 1 ? '\u2191' : (n < 1 ? '\u2193' : '');
    if (op[0] === '=') {
      const ref = (typeof current === 'number' && Number.isFinite(current)) ? current
        : (typeof display.base === 'number' ? display.base : null);
      if (ref == null) return '';
      return n > ref ? '\u2191' : (n < ref ? '\u2193' : '');
    }
    return '';
  }

  /**
   * Provider result → display rows: `string[]` passes through; a plain object
   * renders 'KEY: value' rows; anything else → null (caller falls back to the
   * manifest spec rows). Empty arrays count as "no live rows" → null.
   * @param {*} res
   * @returns {string[]|null}
   */
  static liveRows(res) {
    if (Array.isArray(res)) return res.length ? res.map(String) : null;
    if (res && typeof res === 'object') {
      const rows = Object.entries(res).map(([k, v]) => `${String(k).toUpperCase()}: ${v}`);
      return rows.length ? rows : null;
    }
    return null;
  }

  /**
   * The tab's GOLD count (the shell paints it): candidates purchasable RIGHT
   * NOW (not maxed, prereqs met, cost ≤ credits) across the whole catalog. Pure.
   * @param {Array<object>} catalog @param {object} ctx (rankAlternatives ctx)
   * @returns {number}
   */
  static countAffordable(catalog, ctx) {
    let n = 0;
    for (const entry of (catalog || [])) {
      const shop = entry.shop || {};
      const level = ctx.levelOf ? (ctx.levelOf(entry.id) || 0) : 0;
      if (!shop.consumable && Number.isFinite(shop.maxLevel) && level >= shop.maxLevel) continue;
      if (ctx.prereqsMet && !ctx.prereqsMet(shop)) continue;
      if ((shop.cost ?? Infinity) <= (ctx.credits ?? 0)) n++;
    }
    return n;
  }

  /** Short number formatting for the one-number column. @private */
  static fmtValue(v) {
    if (v === undefined || v === null) return '\u2014';
    if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '\u2014';
      return String(Math.round(v * 100) / 100);
    }
    return String(v);
  }

  /**
   * Session L: one actuator chip from a dep `get()` value. Pure. null when
   * the key is unknown or the state is null/undefined (hardware absent → no
   * chip); 'NOT FITTED' → a disabled chip; a known state → the house word
   * ('FEATHERED' reads 'FEATHER · ON'); an unknown non-null state passes
   * through uppercased (truth is shown, never invented) and reads unpressed.
   * @param {string} key - ACTUATOR_CHIPS key
   * @param {*} state - the dep's get() value
   * @returns {{ key:string, text:string, pressed:boolean, disabled:boolean }|null}
   */
  static actuatorChip(key, state) {
    const def = ACTUATOR_CHIPS[key];
    if (!def || state === null || state === undefined) return null;
    const s = String(state).toUpperCase();
    if (s === ACTUATOR_NOT_FITTED) {
      return { key, text: `${def.name} \u00b7 ${ACTUATOR_NOT_FITTED}`, pressed: false, disabled: true };
    }
    const word = Object.prototype.hasOwnProperty.call(def.words, s) ? def.words[s] : _esc(s);
    return { key, text: `${def.name} \u00b7 ${word}`, pressed: s === def.on, disabled: false };
  }

  // ── Hosting (the shell's calls) ────────────────────────────────────────────

  /**
   * Session U: render into the shell's slot. Called ONCE by WorkbenchPane's
   * build with its `.workbench-refit` element; the engine paints its markup
   * into `el.innerHTML`, listens for click / pointerover / pointerout on `el`
   * (one delegated set — BUY, actuator chips, subsystem chips, RECOMMENDED,
   * the REFIT title deep link, the alternative-row hover ghost) and applies
   * the current enabled state to `el.style.display`. `onRefresh` is stored
   * and called after EVERY later repaint (a BUY, a chip tap, a card switch,
   * a refresh that changed the markup) so the shell's tab count follows on
   * the same edge — the FIRST paint inside mount() itself does NOT fire it
   * (the shell is mid-build; it paints its tab when its build finishes).
   * A second mount moves the engine to the new slot (the old listeners go).
   * No-op after dispose() or without an element.
   * @param {HTMLElement} el - the slot
   * @param {{ onRefresh?: function }} [opts]
   */
  mount(el, opts) {
    if (this._disposed || !el) return;
    if (this._el) this._unmount();
    this._el = el;
    this._onRefresh = (opts && typeof opts.onRefresh === 'function') ? opts.onRefresh : null;
    const h = {
      click: (e) => this._onClick(e),
      pointerover: (e) => this._onPointerOver(e),
      pointerout: (e) => this._onPointerOut(e),
    };
    if (typeof el.addEventListener === 'function') {
      for (const type of Object.keys(h)) el.addEventListener(type, h[type]);
    }
    this._handlers = h;
    this._lastHtml = null;            // a fresh slot: the first refresh must write
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    this._applyDisplay();
    this._mounting = true;
    try { this.refresh(); } finally { this._mounting = false; }
  }

  /** @returns {boolean} true while mounted in a slot. */
  isMounted() { return !!this._el; }

  /**
   * The number the shell's tab shows on F1: the affordable-refit count of
   * the LAST computed model (cached on every refresh — a pure read, never a
   * recompute; 0 before the first refresh).
   * @returns {number}
   */
  affordableCount() { return this._affordable; }

  /**
   * The shell's floor gate (Session U): the REFIT section is a floor-1 place.
   * On: the slot shows (`display:''`) and the content refreshes. Off: the slot
   * hides (`display:none`) and any live alternative-hover ghost clears — a
   * pane that rides along to F2 with a THERMAL alternative hovered must not
   * keep the hull pulsing. Never touches the open state (the shell's close()
   * does). Headless: the flag + the ghost edge only.
   * @param {boolean} on
   */
  setEnabled(on) {
    on = !!on;
    this._enabled = on;
    this._applyDisplay();
    if (on) this.refresh();
    else this._setGhosting(false);
  }

  /** @private The slot follows the enabled flag. */
  _applyDisplay() {
    const el = this._el;
    if (el && el.style) el.style.display = this._enabled ? '' : 'none';
  }

  /** @private Drop the delegated listeners and forget the slot. */
  _unmount() {
    const el = this._el;
    if (el && this._handlers && typeof el.removeEventListener === 'function') {
      for (const type of Object.keys(this._handlers)) el.removeEventListener(type, this._handlers[type]);
    }
    this._handlers = null;
    this._el = null;
  }

  // ── Lifecycle (shell-called) ───────────────────────────────────────────────

  /** @returns {boolean} the shell's told-state: open({…}) … close(). */
  isOpen() { return this._open; }
  /** @returns {boolean} */
  isEnabled() { return this._enabled; }
  /** @returns {string} the focused subsystem id (always one of the seven — the last card, even while detached) */
  focusedSubsystem() { return this._focused; }
  /**
   * The focused card's Tech Library deep link — the blueprint manifest's own
   * `codexId` for the focused subsystem, EXACTLY the id the header's
   * `.refit-title[data-codex]` carries (one mapping, never a second table).
   * Session C: main.js chains it behind the focused hull part as the
   * LibraryPane `subject` so an entry-less library open lands on the card
   * the player is fitting instead of the prompt. Pure read. D12: null while a
   * DETACHED part is showing — the header carries no title then (no card is
   * in view; the SpecsSubject table falls through to its own fallback).
   * @returns {string|null}
   */
  focusedCodexId() {
    if (this._detached) return null;
    const m = MANIFEST_BY_ID.get(this._focused);
    return (m && typeof m.codexId === 'string') ? m.codexId : null;
  }

  /**
   * The shell opened (no-op while disabled or already open). Wave 5 Session
   * K: `{ firstVisit: true }` (the hub, from WORKBENCH_STOP's `firstDepotVisit`
   * — the ONE first-depot grant rule in GameFlowManager) dresses the header
   * with the RECOMMENDED chip for the shop's starter pick and focuses that
   * starter's card, so the first fit is one tap away — the full-screen shop's
   * first-visit framing, hosted here. The shell calls this BEFORE
   * library.open() so the subject read (focusedCodexId) sees the starter's
   * card. One-time: close() clears it. Already open → nothing changes (the
   * player is already here).
   * @param {{ firstVisit?: boolean }} [opts]
   */
  open(opts) {
    if (!this._enabled || this._open) return;
    this._open = true;
    this._firstVisit = !!(opts && opts.firstVisit);
    if (this._firstVisit) {
      const reco = this._recommended();
      if (reco && reco.sub && MANIFEST_BY_ID.has(reco.sub)) this._setFocus(reco.sub);
    }
    this.refresh();
  }

  /** The shell closed: clears any live ghost + the first-visit framing. Idempotent. */
  close() {
    this._open = false;
    this._firstVisit = false;
    this._setGhosting(false);
  }

  /** @returns {boolean} Session K: true while the first-visit framing is showing. */
  isFirstVisit() { return this._open && this._firstVisit; }

  /**
   * Focus one subsystem card (index chip / RECOMMENDED chip / focusPart).
   * Unknown ids keep the current focus. Clears a D12 detached part ("a chip
   * tap … clears it"). Refreshes; never opens by itself.
   * @param {string} id - one of the seven subsystem ids
   */
  focusSubsystem(id) {
    if (!MANIFEST_BY_ID.has(id)) return;
    this._setFocus(id);
    this.refresh();
  }

  /** @private Card focus: drops the detached part; a NEW card clears a stale alt-hover ghost. */
  _setFocus(id) {
    this._detached = null;
    if (id !== this._focused) {
      this._focused = id;
      this._setGhosting(false);   // a new card: any old alt-hover ghost is stale
    }
  }

  /**
   * D-a / D6: focus the card for a clicked hull part (MotherCallouts record
   * shape) through the 8→7 refitIndex (D13: the flower parts → THERMAL).
   * D12: a part with NO refit group (PAYLOAD / DAUGHTERS: subsystemForPart →
   * null) becomes the DETACHED part — the section renders REFIT + the chips
   * + `no refit fits <PART NAME> — pick a subsystem` and hides the card rows
   * until a chip tap or a mapped part clears it. A null part (or a record
   * with neither name nor id) is a no-op; never throws.
   * @param {{ id?:string, name?:string, systemId?:string }|null} part
   */
  focusPart(part) {
    if (!part || typeof part !== 'object') return;
    const sub = subsystemForPart(part);
    if (sub) { this.focusSubsystem(sub); return; }
    const name = part.name != null ? String(part.name) : (part.id != null ? String(part.id) : '');
    if (!name) return;
    this._detached = { id: part.id != null ? String(part.id) : null, name };
    this._setGhosting(false);     // no card in view → no ghost target
    this.refresh();
  }

  /**
   * Recompute + repaint (G1: innerHTML cache + the 250 ms cap; structural
   * changes write immediately). Caches the affordable count; a write fires
   * `onRefresh` (except mount()'s own first paint). Headless / unmounted:
   * computes and returns the model. Safe to call at any cadence — the engine
   * itself only calls it on interaction edges (open/focus/buy/enable), never
   * per frame.
   * @returns {object} the display model
   */
  refresh() {
    const model = this._model();
    this._affordable = model.affordable;
    const el = this._el;
    if (!el) return model;
    const structKey = model.structKey;
    const now = this._now();
    if (!RefitPane.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    const html = this._html(model);
    if (html !== this._lastHtml) {
      el.innerHTML = html;
      this._lastHtml = html;
      this._lastStructKey = structKey;
      this._lastWriteMs = now;
      if (!this._mounting && this._onRefresh) { try { this._onRefresh(); } catch (_e) { /* dep */ } }
    }
    return model;
  }

  /** Drop the listeners, empty the slot, clear any ghost; the instance stays inert afterwards. */
  dispose() {
    this._disposed = true;
    this._open = false;
    this._firstVisit = false;
    this._setGhosting(false);
    const el = this._el;
    this._unmount();
    if (el && typeof el === 'object' && 'innerHTML' in el) el.innerHTML = '';
    this._onRefresh = null;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
  }

  // ── Model (pure per-call reads of the injected truth) ─────────────────────

  /** @private Injected-truth context for the rankers/chips. */
  _ctx() {
    const levelOf = (id) => {
      try { return this._getLevel ? (this._getLevel(id) || 0) : 0; } catch (_e) { return 0; }
    };
    const ownedShim = { has: (id) => levelOf(id) > 0 };
    let credits = 0;
    try { credits = this._getCredits ? (this._getCredits() || 0) : 0; } catch (_e) { credits = 0; }
    let avg = null;
    try {
      const a = this._getAvg ? this._getAvg() : null;
      avg = Number.isFinite(a) ? a : null;
    } catch (_e) { avg = null; }
    return {
      credits,
      avg,
      levelOf,
      ownedHas: (id) => ownedShim.has(id),
      nameOf: (id) => CATALOG_BY_ID.get(id)?.shop?.name || null,
      // The SAME predicate ShopScreen's purchase guard runs (shopGating E5).
      prereqsMet: (shop) => upgradePrereqsMet(shop, ownedShim, (f) => Constants.isFeatureEnabled(f)),
    };
  }

  /**
   * @private Session K: the first-visit RECOMMENDED pick, resolved against the
   * fitting catalog — `{ id, name, sub }` or null (no dep / nothing to
   * recommend / an id the catalog does not carry). Never throws.
   */
  _recommended() {
    if (!this._firstVisit || typeof this._getRecommended !== 'function') return null;
    let id = null;
    try { id = this._getRecommended(); } catch (_e) { id = null; }
    if (!id) return null;
    const entry = CATALOG_BY_ID.get(id);
    if (!entry) return null;
    return { id, name: entry.shop?.name || id, sub: entry.subsystem || null };
  }

  /** @private Adapter deps for fittingCatalog `current` reads (Session B
   *  commit 4 — the Wave-5 (2) FINDINGS, closed): main.js injects a GETTER
   *  returning { player, resourceSystem, kesslerSystem, sensorSystem,
   *  cargoSystem, armManager, captureNetSystem, hasUpgrade } so every
   *  alternative row shows the LIVE number and the delta arrow compares
   *  live → new. Resolved per refresh (never cached — some systems construct
   *  after the pane); absent or throwing → {} and the catalog's safeAdapter
   *  wrapper returns undefined → the row shows the static base (the honest
   *  headless fallback, exactly the pre-commit-4 behaviour). */
  _adapterDeps() {
    if (!this._adapterDepsFn) return {};
    try { return this._adapterDepsFn() || {}; } catch (_e) { return {}; }
  }

  /** @private Live rows for a manifest entry, falling back to its spec. */
  _rowsFor(sub) {
    let rows = null;
    const prov = this._providers && this._providers[sub.readout];
    if (typeof prov === 'function') {
      try { rows = RefitPane.liveRows(prov()); } catch (_e) { rows = null; }
    }
    return { rows: rows || sub.spec || [], live: !!rows };
  }

  /** @private One actuator's `get()` — null on a missing dep / a throw. */
  _readActuator(key) {
    const dep = this._actuators && this._actuators[key];
    if (!dep || typeof dep.get !== 'function') return null;
    try { const v = dep.get(); return v === undefined ? null : v; } catch (_e) { return null; }
  }

  /** @private The chips hosted by one subsystem card (ACTUATOR_CHIPS order). */
  _actuatorChipsFor(sub) {
    if (!this._actuators) return [];
    const chips = [];
    for (const key of Object.keys(ACTUATOR_CHIPS)) {
      if (ACTUATOR_CHIPS[key].sub !== sub) continue;
      const chip = RefitPane.actuatorChip(key, this._readActuator(key));
      if (chip) chips.push(chip);
    }
    return chips;
  }

  /**
   * Session L: route one actuator tap — `toggle()` through the dep, then
   * re-read truth (the pane never flips a label optimistically). Inert for a
   * missing / absent (null) / NOT FITTED actuator — a disabled <button> drops
   * the browser click, but the delegated handler guards it again so a synthetic
   * or stale target can never fire a toggle. Never throws.
   * @param {string} key - ACTUATOR_CHIPS key
   */
  _actuate(key) {
    const dep = this._actuators && this._actuators[key];
    const chip = RefitPane.actuatorChip(key, this._readActuator(key));
    if (dep && chip && !chip.disabled && typeof dep.toggle === 'function') {
      try { dep.toggle(); } catch (_e) { /* dep */ }
    }
    this.refresh();
  }

  /** @private The full display model (pure reads; no DOM). */
  _model() {
    const ctx = this._ctx();
    const groups = groupBySubsystem();
    const focused = MANIFEST_BY_ID.get(this._focused);
    const detached = this._detached;
    const installed = this._rowsFor(focused);
    const ranked = RefitPane.rankAlternatives(groups[this._focused] || [], ctx).slice(0, 3);
    const alts = ranked.map(({ entry }) => {
      const level = ctx.levelOf(entry.id);
      const chip = RefitPane.chipFor(entry, ctx);
      const display = entry.display;
      let current;
      try { current = entry.current(this._adapterDeps()); } catch (_e) { current = undefined; }
      const value = (current !== undefined) ? current : display?.base;
      return {
        id: entry.id,
        name: entry.shop?.name || entry.id,
        num: display ? `${RefitPane.fmtValue(value)} ${display.unit} ${display.op}` : '',
        arrow: RefitPane.deltaArrow(display, current),
        cost: entry.shop?.cost ?? 0,
        level,
        maxLevel: entry.shop?.maxLevel,
        chip,
      };
    });
    const affordable = RefitPane.countAffordable(FITTING_CATALOG, ctx);
    const recommended = this._recommended();
    const acts = this._actuatorChipsFor(this._focused);
    const structKey = [
      this._focused,
      // D12: the detached part rides the key — a detached click / a clearing tap re-renders at once.
      detached ? `det:${detached.id ?? ''}:${detached.name}` : '',
      ctx.credits, affordable,
      installed.rows.join('|'), installed.live ? 1 : 0,
      alts.map((a) => `${a.id}:${a.chip.kind}:${a.chip.text}:${a.num}${a.arrow}`).join('|'),
      recommended ? `reco:${recommended.id}` : '',
      // Session L: the actuator states ride the key so a toggle re-renders at once.
      acts.map((a) => `act:${a.key}:${a.text}${a.disabled ? ':off' : ''}`).join('|'),
    ].join('\u0001');
    return {
      focused: this._focused,
      label: focused.label,
      codexId: detached ? null : focused.codexId,
      detached: !!detached,
      partName: detached ? detached.name : null,
      partId: detached ? detached.id : null,
      installed,
      acts,
      alts,
      empty: (groups[this._focused] || []).length === 0,
      credits: ctx.credits,
      affordable,
      order: SUBSYSTEM_ORDER,
      recommended,
      structKey,
    };
  }

  // ── Markup (into the shell's slot; nothing at import) ──────────────────────

  /** @private Markup for the model (VisualLaw colors; inline styles). */
  _html(m) {
    const C = VisualLaw.COLORS;
    const glass = this._glass;
    const H = ACTUATOR_CHIP_GLASS_MIN_H_PX;
    const parts = [];
    // Header (.refit-header — the PaneHelp anchor): the section name + the
    // focused card title. The title deep-links (D-a: "the REFIT card's title …
    // open the Library"). D12: a detached part shows `REFIT` alone — no card,
    // no deep link.
    parts.push(
      `<div class="refit-header" style="color:${C.PLAYER};border-bottom:1px solid rgba(0,204,255,0.25);padding-bottom:6px;margin-bottom:6px">` +
      (m.detached
        ? 'REFIT'
        : `REFIT \u00b7 <span class="refit-title" data-codex="${m.codexId}" style="cursor:pointer;text-decoration:underline">${m.label}</span>`) +
      '</div>',
    );
    // Session K (one shop): the FIRST-VISIT framing the full-screen shop used
    // to carry — the RECOMMENDED chip (VALUE gold, the header chip; a tap
    // focuses the starter's card through the [data-sub] grammar) and the
    // one-line budget note. Only while open({ firstVisit }) — see open().
    // D10: the chip is a tap target — the 44 pt box on glass.
    if (m.recommended) {
      const r = m.recommended;
      const box = glass
        ? `display:inline-flex;align-items:center;min-height:${H}px;box-sizing:border-box;padding:0 8px;${GLASS_TOUCH_CSS}`
        : 'padding:1px 6px;';
      parts.push(
        `<div class="refit-firstvisit" style="margin:-2px 0 8px;color:${C.VALUE}">` +
        `<span class="refit-reco" data-sub="${r.sub || ''}" style="cursor:pointer;${box}border:1px solid ${C.VALUE};border-radius:3px">RECOMMENDED \u00b7 ${r.name}</span>` +
        '<div style="margin-top:4px;opacity:0.85">credits are your refit budget \u2014 pick one fit that pays for itself</div>' +
        '</div>',
      );
    }
    // The seven-subsystem index, manifest priority order. D12: no chip is lit
    // while a detached part shows ("pick a subsystem"). D10: the chips ride
    // the actuator-chip law on glass (44 pt tall); desktop keeps the row.
    const chipBox = glass
      ? `display:inline-flex;align-items:center;min-height:${H}px;box-sizing:border-box;padding:0 8px;${GLASS_TOUCH_CSS}`
      : 'padding:1px 5px;';
    parts.push('<div class="refit-index" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">');
    for (const id of m.order) {
      const on = !m.detached && id === m.focused;
      parts.push(
        `<span class="refit-sub" data-sub="${id}" style="cursor:pointer;${chipBox}border:1px solid ` +
        `${on ? C.LABEL : 'rgba(0,204,255,0.35)'};border-radius:3px;` +
        `${on ? `color:${C.LABEL}` : 'opacity:0.75'}">${id}</span>`,
      );
    }
    parts.push('</div>');
    // D12: the detached line — and NOTHING below it (no INSTALLED, no
    // alternatives, no wallet: never a stale card under another part's head).
    if (m.detached) {
      parts.push(
        `<div class="refit-detached" style="opacity:0.85;padding:2px 0">no refit fits ${_esc(m.partName)} \u2014 pick a subsystem</div>`,
      );
      return parts.join('');
    }
    // Installed model, pinned at top: live rows (providers) or manifest spec.
    parts.push('<div class="refit-installed" style="margin-bottom:8px">');
    parts.push(`<div style="color:${C.PLAYER}">INSTALLED${m.installed.live ? '' : ' \u00b7 spec'}</div>`);
    for (const row of m.installed.rows) {
      parts.push(`<div style="opacity:0.85;padding-left:8px">${row}</div>`);
    }
    // Session L: the actuator toggle chips — real <button>s (aria-pressed =
    // the actuated pose), STATE-first labels, one per actuator the hub
    // reports present on THIS card's hardware. A tap routes through
    // [data-act] → _actuate → toggle() → refresh (truth re-read). NOT FITTED
    // = present-but-unowned: disabled + aria-disabled, the purchase row
    // below is the way in. 28 px on desktop, the 44 pt HIG box on glass.
    if (m.acts && m.acts.length) {
      const minH = glass ? H : ACTUATOR_CHIP_MIN_H_PX;
      parts.push('<div class="refit-acts" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;padding-left:8px">');
      for (const a of m.acts) {
        const frame = a.disabled ? 'rgba(0,204,255,0.25)' : (a.pressed ? C.INFO : 'rgba(0,204,255,0.45)');
        parts.push(
          `<button class="refit-act" data-act="${a.key}" aria-pressed="${a.pressed ? 'true' : 'false'}"` +
          (a.disabled ? ' disabled aria-disabled="true"' : '') +
          ` style="min-height:${minH}px;min-width:${glass ? H : 0}px;box-sizing:border-box;padding:0 8px;border-radius:3px;font:inherit;letter-spacing:inherit;${GLASS_TOUCH_CSS}` +
          `border:1px solid ${frame};color:${C.INFO};background:${a.pressed && !a.disabled ? 'rgba(0,204,255,0.15)' : 'transparent'};` +
          `${a.disabled ? 'opacity:0.5;cursor:default' : 'cursor:pointer'}">${a.text}</button>`,
        );
      }
      parts.push('</div>');
    }
    parts.push('</div>');
    // Exactly three ranked alternatives (fewer when fewer candidates exist).
    // D10: on glass every row is a 44 pt band (align-items:center) and the BUY
    // button a 44 × ≥44 box; desktop keeps the baseline row.
    if (m.empty) {
      parts.push('<div class="refit-empty" style="opacity:0.7">nothing to refit yet</div>');
    } else if (!m.alts.length) {
      parts.push('<div class="refit-empty" style="opacity:0.7">every fit owned \u2014 nothing to refit yet</div>');
    } else {
      const rowAlign = glass ? `align-items:center;min-height:${H}px` : 'align-items:baseline';
      const buyBox = glass
        ? `display:inline-flex;align-items:center;justify-content:center;min-height:${H}px;min-width:${H}px;box-sizing:border-box;${GLASS_TOUCH_CSS}`
        : '';
      parts.push('<div class="refit-alts">');
      for (const a of m.alts) {
        const buy = a.chip.kind === 'buy';
        const chipColor = buy ? C.PLAYER : (a.chip.kind === 'needs' ? C.THREAT : C.VALUE);
        parts.push(
          `<div class="refit-alt" data-alt="${a.id}" style="display:flex;gap:6px;${rowAlign};padding:3px 0;border-top:1px solid rgba(0,204,255,0.12)">` +
          `<span style="flex:1">${a.name}${a.level > 0 ? ` <span style="opacity:0.6">lvl ${a.level}/${a.maxLevel}</span>` : ''}</span>` +
          `<span style="opacity:0.85">${a.num}${a.arrow ? ` <span style="color:${C.VALUE}">${a.arrow}</span>` : ''}</span>` +
          `<span style="color:${C.VALUE}">${a.cost} cr</span>` +
          (buy
            ? `<button class="refit-chip" data-buy="${a.id}" style="cursor:pointer;background:rgba(0,255,136,0.15);border:1px solid ${C.PLAYER};color:${C.PLAYER};font:inherit;padding:0 6px;border-radius:3px;${buyBox}">${a.chip.text}</button>`
            : `<span class="refit-chip" style="color:${chipColor};opacity:0.9">${a.chip.text}</span>`) +
          '</div>',
        );
      }
      parts.push('</div>');
    }
    // Wallet line (the score is always the context for a fitting decision).
    parts.push(`<div class="refit-credits" style="margin-top:8px;color:${C.VALUE}">${m.credits} cr</div>`);
    return parts.join('');
  }

  // ── Interaction (delegated on the slot) ────────────────────────────────────

  /** @private */
  _closest(el, sel) {
    return (el && typeof el.closest === 'function') ? el.closest(sel) : null;
  }

  /** @private */
  _onClick(e) {
    const target = e && e.target;
    // Session L: an actuator chip toggles through the dep and re-renders from truth.
    const act = this._closest(target, '[data-act]');
    if (act) {
      this._actuate(act.getAttribute('data-act'));
      return;
    }
    const buy = this._closest(target, '[data-buy]');
    if (buy) {
      const id = buy.getAttribute('data-buy');
      // ONE click, no confirm(), no undo (08-workbench §2); the injected
      // purchase is ShopScreen.purchaseUpgrade — its own guards (maxLevel /
      // prereqs / wallet) run there. The section re-renders from TRUTH (and
      // the repaint fires onRefresh, so the shell's gold count follows).
      if (this._purchase) { try { this._purchase(id); } catch (_e) { /* dep */ } }
      this.refresh();
      return;
    }
    const codex = this._closest(target, '[data-codex]');
    if (codex) {
      const id = codex.getAttribute('data-codex');
      if (id && this._onOpenEntry) { try { this._onOpenEntry(id); } catch (_e) { /* dep */ } }
      return;
    }
    const sub = this._closest(target, '[data-sub]');
    if (sub) this.focusSubsystem(sub.getAttribute('data-sub'));
  }

  /** @private Alternative hover → ghost the focused subsystem's hull parts. */
  _onPointerOver(e) {
    if (this._closest(e && e.target, '[data-alt]')) this._setGhosting(true);
  }

  /** @private Leaving the alternatives clears the ghost. */
  _onPointerOut(e) {
    if (!this._ghosting) return;
    const to = e && e.relatedTarget;
    if (!this._closest(to, '[data-alt]')) this._setGhosting(false);
  }

  /** @private Edge-triggered onGhost routing (never repeats a state). */
  _setGhosting(on) {
    on = !!on;
    if (on === this._ghosting) return;
    this._ghosting = on;
    if (!this._onGhost) return;
    try {
      this._onGhost(on ? partsForSubsystem(this._focused) : null);
    } catch (_e) { /* dep */ }
  }
}

export default RefitPane;
