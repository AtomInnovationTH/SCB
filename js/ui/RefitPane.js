/**
 * RefitPane.js — Wave 5 (2): the REFIT pane, the left workbench pane on F3
 * (docs/ladder/08-workbench.md §2 "REFIT card" + §3; 00-spec.md §3 F3
 * amendment; 01-numbers.md "Workbench panes"; 03-plan.md "Wave 5 — GO" (2)).
 *
 * Built on the ProxContextPanel house pattern: a SELF-CONTAINED DOM pane
 * (build lazily, never at import), pure static rankers/formatters that are
 * headless-testable, the G1 innerHTML cache + the static `shouldWrite` 250 ms
 * DOM-write cap, and an injectable `now` clock. NO eventBus/Events import and
 * NO live singletons — every live read (credits, avg credits/catch, upgrade
 * levels, provider rows) and every routed action (purchase, ghost outline,
 * Library open, D10 open-signal) arrives through injected deps, all optional,
 * so the module is headless-safe and the flag-off boot never constructs it.
 * (fittingCatalog's pure-data import chain is the one sanctioned data source.)
 *
 * CONTENT: the seven-subsystem INDEX (blueprintSubsystems, priority order) →
 * one focused per-subsystem CARD:
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
 *     (ShopScreen.purchaseUpgrade); the pane then re-renders from the
 *     injected getUpgradeLevel/getCredits TRUTH, never from optimism.
 *
 * TIMINGS (module constants — VisualLaw has no pane-timing entry yet; the
 * 01-numbers "Workbench panes" table is the canonical source until the
 * VisualLaw entries land with a later consumer per 08-workbench §9; do NOT
 * add one here): PANE_SLIDE_MS = 270 (inside the 240–300 ms law),
 * IDLE_FADE_OPACITY = 0.7 / IDLE_FADE_MS = 6000 ("idle panes fade to 70 %,
 * never vanish" — pointer wakes it), and the reduced-motion probe swaps the
 * slide for a fade (the FloorMask.js house matchMedia shape).
 *
 * LAYOUT: LEFT pane, width clamp(300px, 24vw, 340px) (01-numbers), root
 * `#ladder-refit`, header `.refit-header`, edge tab `#ladder-refit-tab`
 * always visible while enabled carrying the GOLD count of affordable refits.
 * ONE CSS variable (`--refit-dir`, default 1) mirrors the slide direction for
 * RTL: an RTL boot sets `--refit-dir:-1` (and right-anchors the pane) and
 * every transform follows.
 *
 * @module ui/RefitPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { Constants } from '../core/Constants.js';
import { FITTING_CATALOG, groupBySubsystem } from '../data/fittingCatalog.js';
import { BLUEPRINT_SUBSYSTEMS } from '../data/blueprintSubsystems.js';
import { subsystemForPart, partsForSubsystem } from '../data/refitIndex.js';
import { upgradePrereqsMet } from './shopGating.js';

/** Pane slide duration (ms) — inside the 240–300 ms house window
 *  (01-numbers "Workbench panes"; VisualLaw pane-timing entry pending). */
export const PANE_SLIDE_MS = 270;
/** Idle panes fade to 70 %, never vanish (08-workbench §2 Motion). */
export const IDLE_FADE_OPACITY = 0.7;
/** Idle threshold before the fade applies (ms). */
export const IDLE_FADE_MS = 6000;

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

/** The seven subsystems in blueprintSubsystems PRIORITY order (higher first —
 *  the manifest's own carousel law), resolved once at import (pure data). */
export const SUBSYSTEM_ORDER = Object.freeze(
  [...BLUEPRINT_SUBSYSTEMS].sort((a, b) => b.priority - a.priority).map((s) => s.id),
);

/** Manifest entry by subsystem id (pure data). @private */
const MANIFEST_BY_ID = new Map(BLUEPRINT_SUBSYSTEMS.map((s) => [s.id, s]));
/** Catalog entry by upgrade id (name lookups for prereq chips). @private */
const CATALOG_BY_ID = new Map(FITTING_CATALOG.map((e) => [e.id, e]));

export class RefitPane {
  /**
   * Every dep optional; the pane is inert headless (no DOM at import, no DOM
   * without a usable doc) and never throws on a missing dep.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document to build into (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.providers] - HullCamFloor's SAME live-row providers,
   *   keyed by the manifest `readout` (main.js:1340)
   * @param {function} [deps.getCredits] - () => number (live wallet)
   * @param {function} [deps.getAvgCreditsPerCatch] - () => number|null
   * @param {function} [deps.getUpgradeLevel] - (id) => number (0 = unowned)
   * @param {function} [deps.purchase] - (id) => void (ShopScreen.purchaseUpgrade)
   * @param {function} [deps.onGhost] - (partIds|null) => void (MotherCallouts.setGhostOutline)
   * @param {function} [deps.onOpenEntry] - (codexId) => void (the Library deep link)
   * @param {function} [deps.onOpenChange] - (isOpen) => void (the D10 calm-cap signal)
   * @param {function} [deps.adapterDeps] - () => object: the fittingCatalog
   *   `current`-adapter deps ({ player, resourceSystem, kesslerSystem,
   *   sensorSystem, cargoSystem, armManager, captureNetSystem, hasUpgrade })
   *   — a GETTER, resolved per refresh, because some systems construct after
   *   the pane (Session B commit 4; see _adapterDeps). Absent/throwing → {}
   *   (the static catalog base — the honest headless fallback).
   * @param {boolean|function} [deps.reducedMotion] - override for the matchMedia probe
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = deps.now || _nowMs;
    this._providers = deps.providers || null;
    this._getCredits = deps.getCredits || null;
    this._getAvg = deps.getAvgCreditsPerCatch || null;
    this._getLevel = deps.getUpgradeLevel || null;
    this._purchase = deps.purchase || null;
    this._onGhost = deps.onGhost || null;
    this._onOpenEntry = deps.onOpenEntry || null;
    this._onOpenChange = deps.onOpenChange || null;
    this._adapterDepsFn = deps.adapterDeps || null;
    this._reducedMotionDep = deps.reducedMotion;

    this._enabled = false;
    this._open = false;
    this._focused = SUBSYSTEM_ORDER[0];   // POWER — the highest-priority card
    this._built = false;
    this._root = null;
    this._tab = null;
    this._tabCount = null;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
    this._lastTabText = null;
    // Idle fade state (open panes fade to 70 % after IDLE_FADE_MS, pointer wakes).
    this._lastActivityMs = this._now();
    this._idle = false;
    this._idleTimer = null;
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
   * The edge tab's GOLD count: candidates purchasable RIGHT NOW (not maxed,
   * prereqs met, cost ≤ credits) across the whole catalog. Pure.
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

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isOpen() { return this._open; }
  /** @returns {boolean} */
  isEnabled() { return this._enabled; }
  /** @returns {string} the focused subsystem id (always one of the seven) */
  focusedSubsystem() { return this._focused; }
  /**
   * The pane's laid-out width in CSS px (its box, border-box: the
   * clamp(300px, 24vw, 340px) of 01-numbers) — 0 headless or before the root
   * is built. The ONE number main.js feeds `CameraSystem.setLadderPaneInset`
   * on the onOpenChange edge so the subject reframes toward the pane-free
   * centre (08-workbench §2, Wave 5 (3)). A layout read: call it on edges
   * only, never per frame.
   * @returns {number}
   */
  widthPx() {
    const w = this._root ? this._root.offsetWidth : 0;
    return (Number.isFinite(w) && w > 0) ? w : 0;
  }

  /**
   * Enable on F3 arrival / disable on leave (LadderController `refit` dep).
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
    if (this._onOpenChange) { try { this._onOpenChange(true); } catch (_e) { /* dep */ } }
  }

  /** Close the pane. Clears any live ghost; fires onOpenChange(false) once. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._setGhosting(false);
    this._applyOpenState();
    this._clearIdleTimer();
    if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
  }

  /** Space on F3 (D-b): toggle. */
  toggle() { if (this._open) this.close(); else this.open(); }

  /**
   * Focus one subsystem card (index click / focusPart). Unknown ids keep the
   * current focus. Refreshes; never opens by itself.
   * @param {string} id - one of the seven subsystem ids
   */
  focusSubsystem(id) {
    if (!MANIFEST_BY_ID.has(id)) return;
    if (id !== this._focused) {
      this._focused = id;
      this._setGhosting(false);   // a new card: any old alt-hover ghost is stale
    }
    this.refresh();
  }

  /**
   * D-a: focus the card for a clicked hull part (MotherCallouts record shape)
   * through the 8→7 refitIndex. Parts with no refit group (PAYLOAD /
   * DAUGHTERS / flower) keep the current focus — the pane still opens on
   * whatever card was last shown, never throws.
   * @param {{ id?:string, systemId?:string }|null} part
   */
  focusPart(part) {
    const sub = subsystemForPart(part);
    if (sub) this.focusSubsystem(sub);
  }

  /**
   * Recompute + repaint (G1: innerHTML cache + the 250 ms cap; structural
   * changes write immediately). Headless: computes and returns the model.
   * Safe to call at any cadence — the pane itself only calls it on
   * interaction edges (open/focus/buy/enable), never per frame.
   * @returns {object} the display model
   */
  refresh() {
    const model = this._model();
    this._paintTab(model);
    if (!this._root) return model;
    const structKey = model.structKey;
    const now = this._now();
    if (!RefitPane.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
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
    if (this._open && this._onOpenChange) {
      try { this._onOpenChange(false); } catch (_e) { /* dep */ }
    }
    this._open = false;
    this._setGhosting(false);
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

  /** @private The full display model (pure reads; no DOM). */
  _model() {
    const ctx = this._ctx();
    const groups = groupBySubsystem();
    const focused = MANIFEST_BY_ID.get(this._focused);
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
    const structKey = [
      this._focused, this._open ? 1 : 0, ctx.credits, affordable,
      installed.rows.join('|'), installed.live ? 1 : 0,
      alts.map((a) => `${a.id}:${a.chip.kind}:${a.chip.text}:${a.num}${a.arrow}`).join('|'),
    ].join('\u0001');
    return {
      focused: this._focused,
      label: focused.label,
      codexId: focused.codexId,
      installed,
      alts,
      empty: (groups[this._focused] || []).length === 0,
      credits: ctx.credits,
      affordable,
      order: SUBSYSTEM_ORDER,
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
    // "Edge tabs are always visible in the workbench (REFIT: gold count of
    // affordable refits)").
    const tab = doc.createElement('div');
    tab.id = 'ladder-refit-tab';
    tab.style.cssText = [
      'position:absolute', 'left:0', 'top:38%', 'z-index:35',
      'padding:8px 6px 8px 4px', 'border:1px solid rgba(0,204,255,0.4)', 'border-left:none',
      'border-radius:0 6px 6px 0', 'background:rgba(0,16,32,0.85)',
      'color:' + VisualLaw.COLORS.INFO, 'cursor:pointer',
      'font-family:"Courier New",monospace', 'font-size:0.62rem', 'letter-spacing:0.08em',
      'writing-mode:vertical-rl', 'text-orientation:mixed', 'user-select:none',
      'display:none', 'pointer-events:auto',
    ].join(';');
    // Built as real children (never innerHTML) so the count node survives
    // every repaint and fake-DOM test docs need no querySelector.
    const tabLabel = doc.createElement('span');
    tabLabel.textContent = 'REFIT ';
    const tabCount = doc.createElement('span');
    tabCount.className = 'refit-tab-count';
    tabCount.style.cssText = `color:${VisualLaw.COLORS.VALUE};font-weight:bold`;
    tab.appendChild(tabLabel);
    tab.appendChild(tabCount);
    tab.addEventListener('click', () => { this._wake(); this.toggle(); });
    doc.body.appendChild(tab);
    this._tab = tab;
    this._tabCount = tabCount;

    // The pane root — LEFT, 300–340 px (01-numbers), slid fully off-canvas
    // while closed. --refit-dir is the ONE RTL mirror variable.
    const root = doc.createElement('div');
    root.id = 'ladder-refit';
    root.className = reduced ? 'refit-reduced' : '';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:56px', 'bottom:96px', 'z-index:35',
      'width:clamp(300px, 24vw, 340px)', 'box-sizing:border-box',
      'padding:10px 12px', 'overflow-y:auto',
      'border:1px solid rgba(0,204,255,0.4)', 'border-left:none', 'border-radius:0 6px 6px 0',
      'background:rgba(0,16,32,0.82)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family:"Courier New",monospace', 'font-size:0.68rem', 'letter-spacing:0.05em',
      'pointer-events:auto', '--refit-dir:1',
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
    root.addEventListener('pointerover', (e) => this._onPointerOver(e));
    root.addEventListener('pointerout', (e) => this._onPointerOut(e));
    root.addEventListener('pointermove', () => this._wake());
    root.addEventListener('pointerdown', () => this._wake());
  }

  /** @private Slide/fade the root + tab to the current open state. */
  _applyOpenState() {
    const root = this._root;
    if (!root) return;
    const reduced = this._reducedMotion();
    if (reduced) {
      root.className = 'refit-reduced';
      root.style.transform = 'none';
      root.style.opacity = this._open ? '1' : '0';
      root.style.visibility = this._open ? 'visible' : 'hidden';
    } else {
      root.className = '';
      // One CSS variable mirrors the slide for RTL (--refit-dir: -1 flips it).
      root.style.transform = this._open
        ? 'translateX(0)'
        : 'translateX(calc(var(--refit-dir, 1) * -110%))';
      root.style.opacity = this._open ? '1' : '0.999'; // keep painted for the slide
      root.style.visibility = 'visible';
    }
  }

  /** @private Tab count paint (write-on-change). */
  _paintTab(model) {
    if (!this._tabCount) return;
    const text = model.affordable > 0 ? String(model.affordable) : '';
    if (text !== this._lastTabText) {
      this._tabCount.textContent = text;
      this._lastTabText = text;
    }
  }

  /** @private Markup for the model (VisualLaw colors; inline styles). */
  _html(m) {
    const C = VisualLaw.COLORS;
    const parts = [];
    // Header (.refit-header): the pane name + the focused card title. The
    // title deep-links (D-a: "the REFIT card's title … open the Library").
    parts.push(
      `<div class="refit-header" style="color:${C.PLAYER};border-bottom:1px solid rgba(0,204,255,0.25);padding-bottom:6px;margin-bottom:6px">` +
      `REFIT \u00b7 <span class="refit-title" data-codex="${m.codexId}" style="cursor:pointer;text-decoration:underline">${m.label}</span>` +
      '</div>',
    );
    // The seven-subsystem index, manifest priority order.
    parts.push('<div class="refit-index" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">');
    for (const id of m.order) {
      const on = id === m.focused;
      parts.push(
        `<span class="refit-sub" data-sub="${id}" style="cursor:pointer;padding:1px 5px;border:1px solid ` +
        `${on ? C.SELECTION : 'rgba(0,204,255,0.35)'};border-radius:3px;` +
        `${on ? `color:${C.SELECTION}` : 'opacity:0.75'}">${id}</span>`,
      );
    }
    parts.push('</div>');
    // Installed model, pinned at top: live rows (providers) or manifest spec.
    parts.push('<div class="refit-installed" style="margin-bottom:8px">');
    parts.push(`<div style="color:${C.PLAYER}">INSTALLED${m.installed.live ? '' : ' \u00b7 spec'}</div>`);
    for (const row of m.installed.rows) {
      parts.push(`<div style="opacity:0.85;padding-left:8px">${row}</div>`);
    }
    parts.push('</div>');
    // Exactly three ranked alternatives (fewer when fewer candidates exist).
    if (m.empty) {
      parts.push('<div class="refit-empty" style="opacity:0.7">nothing to refit yet</div>');
    } else if (!m.alts.length) {
      parts.push('<div class="refit-empty" style="opacity:0.7">every fit owned \u2014 nothing to refit yet</div>');
    } else {
      parts.push('<div class="refit-alts">');
      for (const a of m.alts) {
        const buy = a.chip.kind === 'buy';
        const chipColor = buy ? C.PLAYER : (a.chip.kind === 'needs' ? C.THREAT : C.VALUE);
        parts.push(
          `<div class="refit-alt" data-alt="${a.id}" style="display:flex;gap:6px;align-items:baseline;padding:3px 0;border-top:1px solid rgba(0,204,255,0.12)">` +
          `<span style="flex:1">${a.name}${a.level > 0 ? ` <span style="opacity:0.6">lvl ${a.level}/${a.maxLevel}</span>` : ''}</span>` +
          `<span style="opacity:0.85">${a.num}${a.arrow ? ` <span style="color:${C.VALUE}">${a.arrow}</span>` : ''}</span>` +
          `<span style="color:${C.VALUE}">${a.cost} cr</span>` +
          (buy
            ? `<button class="refit-chip" data-buy="${a.id}" style="cursor:pointer;background:rgba(0,255,136,0.15);border:1px solid ${C.PLAYER};color:${C.PLAYER};font:inherit;padding:0 6px;border-radius:3px">${a.chip.text}</button>`
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

  // ── Interaction (delegated) ────────────────────────────────────────────────

  /** @private */
  _closest(el, sel) {
    return (el && typeof el.closest === 'function') ? el.closest(sel) : null;
  }

  /** @private */
  _onClick(e) {
    this._wake();
    const buy = this._closest(e.target, '[data-buy]');
    if (buy) {
      const id = buy.getAttribute('data-buy');
      // ONE click, no confirm(), no undo (08-workbench §2); the injected
      // purchase is ShopScreen.purchaseUpgrade — its own guards (maxLevel /
      // prereqs / wallet) run there. The pane re-renders from TRUTH.
      if (this._purchase) { try { this._purchase(id); } catch (_e) { /* dep */ } }
      this.refresh();
      return;
    }
    const codex = this._closest(e.target, '[data-codex]');
    if (codex) {
      const id = codex.getAttribute('data-codex');
      if (id && this._onOpenEntry) { try { this._onOpenEntry(id); } catch (_e) { /* dep */ } }
      return;
    }
    const sub = this._closest(e.target, '[data-sub]');
    if (sub) this.focusSubsystem(sub.getAttribute('data-sub'));
  }

  /** @private Alternative hover → ghost the focused subsystem's hull parts. */
  _onPointerOver(e) {
    this._wake();
    if (this._closest(e.target, '[data-alt]')) this._setGhosting(true);
  }

  /** @private Leaving the alternatives clears the ghost. */
  _onPointerOut(e) {
    if (!this._ghosting) return;
    const to = e.relatedTarget;
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
        if (this._root.classList && this._root.classList.remove) this._root.classList.remove('refit-idle');
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
      if (this._root.classList && this._root.classList.add) this._root.classList.add('refit-idle');
    } else {
      this._idleTimer = setTimeout(() => this._idleTick(), (IDLE_FADE_MS - since) + 20);
    }
  }
}

export default RefitPane;
