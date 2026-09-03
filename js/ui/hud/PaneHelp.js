/**
 * PaneHelp.js — "what is this pane?" help affordance for every HUD pane header
 * (Zoom Ladder Wave 4, docs/ladder/08-workbench.md §11: "HUD `data-help`
 * mechanism + 9 PLAYBOOK entries + the `[?]` deep link").
 *
 * Every covered pane (header where one exists, stable root where none does)
 * carries `data-help="<codexId>"` pointing at a REAL Tech Library entry.
 * ONE delegated handler set on the document — the glossaryDom pattern, never
 * per-element listeners — serves all of them:
 *
 *   • hover  → after 120 ms the pane header brightens (`pane-help-hot`);
 *              after 400 ms ONE reused tooltip shows the entry's `shortText`
 *              plus the pane's toggle key (7/9/0 family, where applicable) and
 *              its pane-density rung (the −/+ ladder position).
 *              (08-workbench §2 Motion: "Hover: 120 ms delay …; tooltip = the
 *              entry's shortText after 400 ms.")
 *   • click  → CODEX_OPEN_ENTRY deep link to the entry (main.js routes it to
 *              CodexViewerUI.openEntry). Clicks on interactive descendants
 *              (glossary terms, pane badges, sort buttons, target rows, the
 *              Discoveries header toggle) keep their own behavior.
 *   • touch  → long-press = hover (gated behind the house TouchControls.detect()
 *              real-touch detection); a plain tap still deep-links. The tooltip
 *              lingers briefly after release so it can be read.
 *
 * G1: no per-frame DOM churn — every write here is event-driven and the
 * tooltip is one reused element. Tagging is idempotent (rescan() only writes
 * missing attributes); lazily-built ladder panes (rail / transfer windows /
 * tactical approach mount on first show) are picked up by a throttled
 * rescan-on-miss inside the delegated hover/touch handlers.
 *
 * Tunables live in-module (house rule — never FloorContract/Constants); the
 * hover/tooltip numbers reuse 08-workbench §2.
 *
 * Node-safe: importing this file touches no window/document. All DOM work is
 * inside install()/rescan()/handlers, every step guarded, so the Node suite
 * drives it through minimal shims (test-PaneHelp.js).
 *
 * @module ui/hud/PaneHelp
 */

import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { TouchControls } from '../TouchControls.js';

/**
 * Tunables (module-local, house rule). Hover + tooltip reuse the 08-workbench
 * §2 Motion numbers; the long-press threshold matches the house tap ceiling
 * (MotherCallouts treats > 400 ms as a long-press, not a tap).
 */
export const HELP_TUNE = {
  HOVER_DELAY_MS: 120,    // §2: hover cue (brighten) after 120 ms
  TOOLTIP_DELAY_MS: 400,  // §2: tooltip = shortText after 400 ms
  LONG_PRESS_MS: 500,     // touch long-press ≈ hover (house tap ceiling is 400 ms)
  TOUCH_LINGER_MS: 2500,  // tooltip stays readable after the finger lifts
  MOVE_CANCEL_PX: 8,      // finger drift beyond this cancels the long-press
  MISS_RESCAN_MS: 500,    // throttle for rescan-on-miss (lazy ladder panes)
  CLICK_SUPPRESS_MS: 700, // swallow the synthetic click that follows a long-press
};

/**
 * The pane → codex table (SSOT). Every HUD pane with a header is listed here;
 * `selector` targets the header element where one exists and the stable pane
 * root where the pane has none (or rewrites its innerHTML wholesale —
 * conjunction header, transfer windows, tactical approach).
 *
 * key:  the pane's toggle key from the 5/6/7/8/9/0 display-toggle family
 *       (null where the family has no key for this pane).
 * rung: the pane-density ladder position (HUD._initPaneDensity order,
 *       12 rungs, rung 1 hides first on `-`), or a plain-language placement
 *       note for panes outside the ladder (the rail never hides — D7; the two
 *       floor instruments belong to their zoom level — the map rule).
 *
 * test-PaneHelp.js walks this table against data/codex.json — a typo'd
 * codexId fails the suite.
 */
export const PANE_HELP = [
  { pane: 'comms log',          selector: '#hud-comms-panel',                        codexId: 'pane_comms_log',          key: '7',  rung: 'Comms (rung 8/12)' },
  { pane: 'discoveries/skills', selector: '.skills-pane',                            codexId: 'pane_discoveries',        key: null, rung: 'Discoveries (rung 4/12)' },
  { pane: 'upgrade pin',        selector: '#hud-pin-widget',                         codexId: 'pane_upgrade_pin',        key: null, rung: 'Upgrade goal (rung 2/12)' },
  { pane: 'status/vitals',      selector: '#hud-mother-panel .mother-header',        codexId: 'reading_the_hud',         key: null, rung: 'Mother pane (rung 10/12)' },
  { pane: 'daughters/fleet',    selector: '#fleet-header',                           codexId: 'tool_choice',             key: null, rung: 'Fleet pane (rung 9/12)' },
  { pane: 'score strip',        selector: '#hud-score-panel',                        codexId: 'core_loop',               key: null, rung: 'Score strip (rung 7/12)' },
  { pane: 'target list',        selector: '#hud-targets-panel .target-section-header', codexId: 'ssa_network',           key: '0',  rung: 'Target pane (rung 6/12)' },
  { pane: 'conjunction alerts', selector: '#hud-conjunction-panel',                  codexId: 'pane_conjunction_alerts', key: null, rung: 'Reticles & alerts (rung 11/12)' },
  { pane: 'space weather',      selector: '#hud-weather-indicator',                  codexId: 'pane_space_weather',      key: null, rung: 'Reticles & alerts (rung 11/12)' },
  { pane: 'debris chart',       selector: '#hud-wireframe-container',                codexId: 'pane_debris_chart',       key: '9',  rung: 'Debris pane (rung 5/12)' },
  { pane: 'ladder rail',        selector: '#ladder-rail',                            codexId: 'pane_ladder_rail',        key: null, rung: 'always shown' },
  { pane: 'transfer windows',   selector: '#ladder-transfer-windows',                codexId: 'pane_transfer_windows',   key: null, rung: 'route-planning instrument' },
  { pane: 'tactical approach',  selector: '#ladder-prox-context',                    codexId: 'pane_tactical_approach',  key: null, rung: 'approach instrument' },
  { pane: 'refit',              selector: '#ladder-refit .refit-header',             codexId: 'pane_refit',              key: null, rung: 'refit instrument' },
  { pane: 'library',            selector: '#ladder-library .library-header',         codexId: 'pane_library',            key: null, rung: 'library instrument' },
];

/**
 * Clicks on these keep their own behavior (never hijacked into a deep link):
 * glossary terms already deep-link themselves; pane badges resize; the sort
 * button sorts; target rows select; the Discoveries header toggles the tree.
 */
export const INTERACTIVE_GUARD =
  'button, a, input, select, textarea, .glossary-term, .hud-pane-badge, .sp-header, .target-row, .target-sort-btn';

/**
 * Pure tooltip content model (Node-tested): the entry's shortText plus the
 * pane's toggle key and density rung.
 * @param {{icon?:string,title?:string,shortText?:string}|null} entry
 * @param {{key:(string|null), rung:string}} row
 * @returns {{title:string, short:string, meta:string}|null} null without an entry
 */
export function helpTooltipModel(entry, row) {
  if (!entry) return null;
  const metaParts = [];
  if (row && row.key) metaParts.push(`[${row.key}] toggles`);
  if (row && row.rung) metaParts.push(`density: ${row.rung}`);
  metaParts.push('click for the Library page');
  return {
    title: `${entry.icon ? entry.icon + ' ' : ''}${entry.title || ''}`.trim(),
    short: entry.shortText || '',
    meta: metaParts.join(' · '),
  };
}

const CSS_ID = 'pane-help-css';

/**
 * Inject the shared pane-help stylesheet exactly once (glossaryDom pattern).
 * @param {Document} [doc=document]
 */
export function ensurePaneHelpCss(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(CSS_ID)) return;
  const mount = doc.head || doc.documentElement || doc.body;
  if (!mount || typeof mount.appendChild !== 'function') return;
  const style = doc.createElement('style');
  style.id = CSS_ID;
  style.textContent = `
    [data-help] { cursor: help; }
    [data-help].pane-help-hot {
      outline: 1px solid rgba(0, 212, 255, 0.45);
      outline-offset: -1px;
      transition: outline-color 0.15s ease;
    }
  `;
  mount.appendChild(style);
}

export class PaneHelp {
  /**
   * @param {object} [deps]
   * @param {(id:string)=>object|null} [deps.getEntry]  codex entry resolver
   *        (wired late — HUD.setCodexSystem lands after construction, so this
   *        is consulted at hover time, never cached).
   * @param {boolean} [deps.hasTouch]  house real-touch detection; defaults to
   *        TouchControls.detect() (Ipad.md §4.5). Injectable for tests.
   * @param {Document|null} [deps.doc]  document override for tests.
   * @param {Function} [deps.setTimeoutFn] / @param {Function} [deps.clearTimeoutFn]
   *        timer injection for tests (defaults to globals).
   * @param {()=>number} [deps.now]  clock injection for tests.
   */
  constructor({ getEntry = null, hasTouch = undefined, doc = undefined,
                setTimeoutFn = undefined, clearTimeoutFn = undefined, now = undefined } = {}) {
    this._getEntry = (typeof getEntry === 'function') ? getEntry : (() => null);
    this._hasTouch = (hasTouch !== undefined) ? !!hasTouch : TouchControls.detect();
    this._doc = (doc !== undefined) ? doc : (typeof document !== 'undefined' ? document : null);
    this._setTimeout = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = clearTimeoutFn || ((h) => clearTimeout(h));
    this._now = now || (() => Date.now());

    /** @type {Map<string, object>} codexId → PANE_HELP row (tooltip meta) */
    this._rowsById = new Map();
    for (const row of PANE_HELP) this._rowsById.set(row.codexId, row);

    this._installed = false;
    this._hotEl = null;          // element currently hovered/pressed
    this._hotTimer = null;       // 120 ms brighten timer
    this._tipTimer = null;       // 400 ms tooltip timer
    this._pressTimer = null;     // touch long-press timer
    this._lingerTimer = null;    // touch tooltip linger-hide timer
    this._tip = null;            // the ONE reused tooltip element
    this._touchStart = null;     // {x, y} of the active touch
    this._suppressClickUntil = 0; // swallow the post-long-press click
    this._lastMissScanAt = -Infinity;
    this._handlers = [];         // [type, fn, opts] for dispose()
  }

  /**
   * Tag panes and register the ONE delegated handler set on the document.
   * Idempotent: repeated calls never stack handlers (glossaryDom pattern —
   * the document root is marked).
   */
  install() {
    const doc = this._doc;
    if (!doc) return;
    const marker = doc.body || doc.documentElement;
    if (this._installed || (marker && marker.dataset && marker.dataset.paneHelpDelegated === '1')) return;
    this._installed = true;
    if (marker && marker.dataset) marker.dataset.paneHelpDelegated = '1';

    ensurePaneHelpCss(doc);
    this.rescan();

    const add = (type, fn, opts) => {
      if (typeof doc.addEventListener !== 'function') return;
      doc.addEventListener(type, fn, opts);
      this._handlers.push([type, fn, opts]);
    };
    add('mouseover', (e) => this._onOver(e));
    add('mouseout', (e) => this._onOut(e));
    add('click', (e) => this._onClick(e));
    if (this._hasTouch) {
      // Long-press = hover on touch (house HAS_TOUCH gate). Passive: we never
      // preventDefault — play gestures (pinch, rail drag) must keep working.
      add('touchstart', (e) => this._onTouchStart(e), { passive: true });
      add('touchmove', (e) => this._onTouchMove(e), { passive: true });
      add('touchend', (e) => this._onTouchEnd(e), { passive: true });
      add('touchcancel', (e) => this._onTouchEnd(e), { passive: true });
    }
  }

  /**
   * Tag every table pane that exists right now (idempotent, write-on-missing
   * only — G1-safe). Lazily-built ladder panes are caught by the throttled
   * rescan-on-miss in the hover/touch handlers.
   */
  rescan() {
    const doc = this._doc;
    if (!doc || typeof doc.querySelector !== 'function') return;
    for (const row of PANE_HELP) {
      let el = null;
      try { el = doc.querySelector(row.selector); } catch (_) { el = null; }
      if (!el || !el.dataset) continue;
      if (el.dataset.help === row.codexId) continue;
      el.dataset.help = row.codexId;
      // Panes default to pointer-events:none under #hud-overlay — the help
      // affordance needs hover/click on the tagged element itself.
      if (el.style) el.style.pointerEvents = 'auto';
    }
  }

  /** @private closest() with shim tolerance. */
  _closest(node, sel) {
    if (!node) return null;
    if (typeof node.closest === 'function') { try { return node.closest(sel); } catch (_) { return null; } }
    return null;
  }

  /** @private Resolve the [data-help] pane for an event target, rescanning (throttled) on a miss. */
  _resolve(target) {
    let el = this._closest(target, '[data-help]');
    if (!el) {
      const t = this._now();
      if (t - this._lastMissScanAt >= HELP_TUNE.MISS_RESCAN_MS) {
        this._lastMissScanAt = t;
        this.rescan();
        el = this._closest(target, '[data-help]');
      }
    }
    return el;
  }

  // ── hover (mouse) ──────────────────────────────────────────────────────────

  /** @private */
  _onOver(e) {
    const el = this._resolve(e && e.target);
    if (!el || el === this._hotEl) return;
    this._clearHover();
    this._hotEl = el;
    this._hotTimer = this._setTimeout(() => {
      this._hotTimer = null;
      if (el.classList && typeof el.classList.add === 'function') el.classList.add('pane-help-hot');
    }, HELP_TUNE.HOVER_DELAY_MS);
    this._tipTimer = this._setTimeout(() => {
      this._tipTimer = null;
      this._showTip(el);
    }, HELP_TUNE.TOOLTIP_DELAY_MS);
  }

  /** @private */
  _onOut(e) {
    if (!this._hotEl) return;
    // Still inside the same pane (child → child moves) → keep the hover alive.
    const to = this._closest(e && e.relatedTarget, '[data-help]');
    if (to === this._hotEl) return;
    this._clearHover();
  }

  /** @private Cancel timers, cool the header, hide the tooltip. */
  _clearHover() {
    if (this._hotTimer) { this._clearTimeout(this._hotTimer); this._hotTimer = null; }
    if (this._tipTimer) { this._clearTimeout(this._tipTimer); this._tipTimer = null; }
    if (this._pressTimer) { this._clearTimeout(this._pressTimer); this._pressTimer = null; }
    const el = this._hotEl;
    if (el && el.classList && typeof el.classList.remove === 'function') el.classList.remove('pane-help-hot');
    this._hotEl = null;
    this._hideTip();
  }

  // ── click (deep link) ──────────────────────────────────────────────────────

  /** @private */
  _onClick(e) {
    const target = e && e.target;
    const el = this._closest(target, '[data-help]');
    if (!el || !el.dataset || !el.dataset.help) return;
    // The click that follows a long-press is the long-press, not an intent.
    if (this._suppressClickUntil && this._now() < this._suppressClickUntil) {
      this._suppressClickUntil = 0;
      return;
    }
    // Interactive descendants keep their own click behavior.
    const interactive = this._closest(target, INTERACTIVE_GUARD);
    if (interactive && interactive !== el) return;
    this._hideTip();
    eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: el.dataset.help });
  }

  // ── touch (long-press = hover; gated behind HAS_TOUCH) ────────────────────

  /** @private */
  _onTouchStart(e) {
    const touches = e && e.touches;
    if (!touches || touches.length !== 1) { this._cancelPress(); return; }
    const t0 = touches[0];
    const el = this._resolve(t0 && t0.target !== undefined ? t0.target : (e && e.target));
    if (!el) return;
    this._touchStart = { x: t0.clientX || 0, y: t0.clientY || 0 };
    this._hotEl = el;
    this._pressTimer = this._setTimeout(() => {
      this._pressTimer = null;
      this._suppressClickUntil = this._now() + HELP_TUNE.CLICK_SUPPRESS_MS;
      if (el.classList && typeof el.classList.add === 'function') el.classList.add('pane-help-hot');
      this._showTip(el);
    }, HELP_TUNE.LONG_PRESS_MS);
  }

  /** @private */
  _onTouchMove(e) {
    if (!this._pressTimer || !this._touchStart) return;
    const t0 = e && e.touches && e.touches[0];
    if (!t0) return;
    const dx = (t0.clientX || 0) - this._touchStart.x;
    const dy = (t0.clientY || 0) - this._touchStart.y;
    if ((dx * dx + dy * dy) > HELP_TUNE.MOVE_CANCEL_PX * HELP_TUNE.MOVE_CANCEL_PX) this._cancelPress();
  }

  /** @private */
  _onTouchEnd() {
    this._cancelPress();
    // Let a long-press tooltip linger so it can actually be read.
    if (this._tip && this._tip.style && this._tip.style.display !== 'none') {
      if (this._lingerTimer) this._clearTimeout(this._lingerTimer);
      this._lingerTimer = this._setTimeout(() => {
        this._lingerTimer = null;
        this._clearHover();
      }, HELP_TUNE.TOUCH_LINGER_MS);
    } else {
      const el = this._hotEl;
      if (el && el.classList && typeof el.classList.remove === 'function') el.classList.remove('pane-help-hot');
      this._hotEl = null;
    }
  }

  /** @private Cancel a pending (unfired) long-press. */
  _cancelPress() {
    if (this._pressTimer) { this._clearTimeout(this._pressTimer); this._pressTimer = null; }
    this._touchStart = null;
  }

  // ── the ONE reused tooltip ─────────────────────────────────────────────────

  /** @private Build (once) or fetch the tooltip element. */
  _ensureTip() {
    if (this._tip) return this._tip;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const mount = doc.body || doc.documentElement;
    if (!mount || typeof mount.appendChild !== 'function') return null;
    const tip = doc.createElement('div');
    tip.id = 'hud-pane-help-tip';
    if (tip.style) {
      Object.assign(tip.style, {
        position: 'fixed',
        display: 'none',
        maxWidth: '300px',
        padding: '6px 9px',
        background: 'rgba(2, 14, 26, 0.94)',
        border: '1px solid rgba(0, 212, 255, 0.45)',
        borderRadius: '4px',
        fontFamily: "'Courier New', monospace",
        fontSize: '11px',
        lineHeight: '1.45',
        color: '#bfe8f2',
        letterSpacing: '0.02em',
        pointerEvents: 'none',
        zIndex: '2000',
      });
    }
    const title = doc.createElement('div');
    if (title.style) Object.assign(title.style, { color: '#7fd4e8', fontWeight: 'bold', letterSpacing: '1px' });
    const short = doc.createElement('div');
    if (short.style) Object.assign(short.style, { marginTop: '3px' });
    const meta = doc.createElement('div');
    if (meta.style) Object.assign(meta.style, { marginTop: '4px', opacity: '0.65', fontSize: '10px' });
    tip.appendChild(title);
    tip.appendChild(short);
    tip.appendChild(meta);
    tip._title = title;
    tip._short = short;
    tip._meta = meta;
    mount.appendChild(tip);
    this._tip = tip;
    return tip;
  }

  /** @private Fill + place the tooltip next to the pane element. */
  _showTip(el) {
    const id = el && el.dataset && el.dataset.help;
    if (!id) return;
    const entry = this._getEntry(id);
    const row = this._rowsById.get(id) || { key: null, rung: '' };
    const model = helpTooltipModel(entry, row);
    if (!model) return; // codex not wired yet — no tooltip, click still works
    const tip = this._ensureTip();
    if (!tip) return;
    tip._title.textContent = model.title;
    tip._short.textContent = model.short;
    tip._meta.textContent = model.meta;
    if (tip.style) tip.style.display = 'block';

    // Position: below the pane element, clamped on-screen; above when the
    // bottom would clip. One-shot measure on an event — not per-frame (G1).
    if (typeof el.getBoundingClientRect === 'function' && tip.style) {
      const r = el.getBoundingClientRect();
      const win = (typeof window !== 'undefined') ? window : null;
      const vw = (win && win.innerWidth) || 1280;
      const vh = (win && win.innerHeight) || 800;
      const w = tip.offsetWidth || 260;
      const h = tip.offsetHeight || 70;
      let x = Math.max(8, Math.min(r.left, vw - w - 8));
      let y = r.bottom + 6;
      if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);
      tip.style.left = `${Math.round(x)}px`;
      tip.style.top = `${Math.round(y)}px`;
    }
  }

  /** @private */
  _hideTip() {
    if (this._lingerTimer) { this._clearTimeout(this._lingerTimer); this._lingerTimer = null; }
    if (this._tip && this._tip.style) this._tip.style.display = 'none';
  }

  /** Detach listeners and drop the tooltip (tests / teardown). */
  dispose() {
    const doc = this._doc;
    if (doc && typeof doc.removeEventListener === 'function') {
      for (const [type, fn, opts] of this._handlers) doc.removeEventListener(type, fn, opts);
    }
    this._handlers.length = 0;
    this._clearHover();
    if (this._tip && this._tip.remove) this._tip.remove();
    this._tip = null;
    const marker = doc && (doc.body || doc.documentElement);
    if (marker && marker.dataset && marker.dataset.paneHelpDelegated === '1') {
      delete marker.dataset.paneHelpDelegated;
    }
    this._installed = false;
  }
}

export default PaneHelp;
