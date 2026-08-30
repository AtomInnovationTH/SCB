/**
 * RailIndicator.js — the Zoom Ladder rail indicator (S2 stub → G3 polish).
 *
 * Right-edge, 7 notches labelled with instrument names + a spring-charge fill,
 * driven by LadderController from `ladder.getState()` / charge decisions
 * (docs/ladder/00-spec.md §10, VisualLaw.RAIL). Still no costumes, time-warp
 * readout, subject line, or clickable notches — those are S4+.
 *
 * G3 (post-M3 play-test):
 * - BOTTOM-anchored on the right edge (was vertically centered, where it
 *   overlapped TARGET DOSSIER / TRACKED TARGETS in #hud-right-column at every
 *   common viewport). Bottom-anchoring keeps it clear even when the panes
 *   above grow.
 * - Instrument identity: INFO-blue frame/labels (VisualLaw.COLORS.INFO) so the
 *   rail reads as a CONTROL, distinct from the green/dark content panes; the
 *   current floor keeps the PLAYER green identity, charge fill stays PLAYER.
 * - G2i: flashDenied(hint, floor) is real now — a hard wall (undocked F2 /
 *   ladder end) flashes the blocked notch THREAT-red once (one-shot ≤ 3 Hz,
 *   VisualLaw.KLAXON.FLASH_HZ_MAX) and, when the contract provides a hint
 *   ('DOCK TO ENTER DEPOT'), shows a small amber toast above the rail.
 *   Warning amber #ffaa00 is the shipped HUD warning family (DockingReticle) —
 *   deliberately NOT a new VisualLaw law color (the 5-color pin stands).
 *
 * Fully DOM-guarded so it is inert (and constructible) in headless tests; no
 * timers are ever allocated unless the DOM exists.
 *
 * @module ui/RailIndicator
 */

import { FloorContract } from '../core/FloorContract.js';
import { VisualLaw } from '../core/VisualLaw.js';

/** Denial toast hold time (ms) — fade handled by the 0.3 s opacity transition. */
const TOAST_HOLD_MS = 1800;
/** Blocked-notch flash duration (ms). One-shot: 1 flash ≪ 3 Hz cap. */
const DENY_FLASH_MS = 320;
/** Shipped HUD warning amber (DockingReticle.warning) — not a law color. */
const WARN_AMBER = '#ffaa00';

/** Notch resting/active palette (INFO instrument frame, PLAYER current). */
const NOTCH_REST_BORDER = 'rgba(0,204,255,0.35)';
const NOTCH_REST_COLOR = 'rgba(0,204,255,0.62)';

export class RailIndicator {
  constructor() {
    this._root = null;
    this._toast = null;
    this._notches = [];   // per-floor { el, fill, _cur, _pct, _deny } (index 0 = F1)
    this._visible = false;
    this._built = false;
    this._toastTimer = null;
    this._denyTimer = null;
  }

  /**
   * Pure notch-state law (headless-testable): what a notch shows for a state.
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   * @param {number} floorId - 1-based floor id of the notch
   * @returns {{current:boolean, fillPct:number}}
   */
  static notchState(state, floorId) {
    const current = floorId === state.floor;
    let pct = 0;
    if (state.chargeSide === 'up' && floorId === state.floor + 1) pct = state.charge * 100;
    if (state.chargeSide === 'down' && floorId === state.floor - 1) pct = state.charge * 100;
    return { current, fillPct: Math.max(0, Math.min(100, pct)) };
  }

  /**
   * Pure toast law (headless-testable): a denial with a contract hint shows
   * the hint; a hintless denial (ladder end) stays quiet — notch flash only.
   * @param {string|null|undefined} hint
   * @returns {{show:boolean, text:string}}
   */
  static toastFor(hint) {
    const text = (typeof hint === 'string' && hint.trim()) ? hint.trim() : '';
    return { show: text.length > 0, text };
  }

  /** Lazily build the DOM (idempotent, no-op headless). @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;

    const root = document.createElement('div');
    root.id = 'ladder-rail';
    root.style.cssText = [
      // G3: bottom-anchored, clear of the right HUD column at 1024-1440 px.
      'position:absolute', 'bottom:14px', 'right:10px',
      'display:flex', 'flex-direction:column-reverse', 'gap:5px',
      'font-family:"Courier New",monospace', 'font-size:0.6rem', 'letter-spacing:0.08em',
      'text-transform:uppercase',
      'padding:6px 6px 6px 8px',
      `border-left:2px solid ${NOTCH_REST_BORDER}`,
      'background:rgba(0,10,22,0.42)', 'border-radius:4px',
      'z-index:35', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');

    // column-reverse so F1 sits at the bottom, F7 at the top (elevator order).
    for (const f of FloorContract.FLOORS) {
      const notch = document.createElement('div');
      notch.style.cssText = [
        'position:relative', 'min-width:96px', 'padding:2px 8px',
        `border:1px solid ${NOTCH_REST_BORDER}`, 'border-radius:3px',
        'background:rgba(0,14,28,0.55)', `color:${NOTCH_REST_COLOR}`,
        'text-align:right', 'overflow:hidden',
      ].join(';');

      const fill = document.createElement('div');
      fill.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'bottom:0', 'width:0%',
        `background:${VisualLaw.COLORS.PLAYER}`, 'opacity:0.25', 'transition:width 0.05s linear',
      ].join(';');
      notch.appendChild(fill);

      const label = document.createElement('span');
      label.textContent = `${f.id} ${f.name}`;
      label.style.position = 'relative';
      notch.appendChild(label);

      root.appendChild(notch);
      this._notches[f.id - 1] = { el: notch, fill, _cur: null, _pct: null, _deny: false };
    }

    // Denial toast: sits ABOVE the rail (bottom-right region is otherwise
    // empty), amber warning, hidden until flashDenied() with a hint.
    const toast = document.createElement('div');
    toast.id = 'ladder-rail-toast';
    toast.style.cssText = [
      'position:absolute', 'bottom:calc(100% + 8px)', 'right:0',
      'padding:4px 10px', 'white-space:nowrap',
      `border:1px solid ${WARN_AMBER}`, 'border-radius:3px',
      'background:rgba(30,18,0,0.85)', `color:${WARN_AMBER}`,
      'font-size:0.65rem', 'letter-spacing:0.1em',
      'opacity:0', 'transition:opacity 0.3s', 'pointer-events:none',
    ].join(';');
    root.appendChild(toast);
    this._toast = toast;

    document.body.appendChild(root);
    this._root = root;
  }

  /** Show the rail (builds on first show). */
  show() {
    this._build();
    this._visible = true;
    if (this._root) this._root.style.opacity = '1';
  }

  /** Hide the rail (clears any pending denial feedback). */
  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
    this._clearDenied();
  }

  /**
   * Refresh from a ZoomLadder state snapshot (docs/ladder/06-core-api.md).
   * Named `refresh` (not `update`) because it is driven by LadderController from
   * ladder state, not ticked directly by the main loop. Writes are cached — this
   * runs per frame and must not churn same-value styles (G1 discipline).
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   */
  refresh(state) {
    if (!this._root || !state) return;
    for (let i = 0; i < this._notches.length; i++) {
      const n = this._notches[i];
      if (!n) continue;
      const { current, fillPct } = RailIndicator.notchState(state, i + 1);
      if (n._cur !== current && !n._deny) {
        n.el.style.borderColor = current ? VisualLaw.COLORS.PLAYER : NOTCH_REST_BORDER;
        n.el.style.color = current ? VisualLaw.COLORS.PLAYER : NOTCH_REST_COLOR;
        n._cur = current;
      }
      if (n._pct !== fillPct) {
        n.fill.style.width = `${fillPct}%`;
        n._pct = fillPct;
      }
    }
  }

  /**
   * Denied feedback for a hard wall (G2i). Flashes the blocked notch
   * THREAT-red once (one-shot, ≤3 Hz law) and, when the FloorContract
   * provides a deniedHint ('DOCK TO ENTER DEPOT'), shows the amber toast.
   * Re-calls restart both timers. Headless: no DOM → returns before any
   * timer is allocated.
   * @param {string|null} [hint] - FloorContract humps.deniedHint (null = ladder end)
   * @param {number} [floor] - the BLOCKED floor id (denial decision's `floor`)
   */
  flashDenied(hint, floor) {
    if (!this._root) return;
    const t = RailIndicator.toastFor(hint);
    if (t.show && this._toast) {
      this._toast.textContent = t.text;
      this._toast.style.opacity = '1';
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toastTimer = null;
        if (this._toast) this._toast.style.opacity = '0';
      }, TOAST_HOLD_MS);
    }
    const n = this._notches[(floor ?? -1) - 1];
    if (n) {
      n._deny = true;
      n.el.style.borderColor = VisualLaw.COLORS.THREAT;
      n.el.style.color = VisualLaw.COLORS.THREAT;
      if (this._denyTimer) clearTimeout(this._denyTimer);
      this._denyTimer = setTimeout(() => {
        this._denyTimer = null;
        n._deny = false;
        n._cur = null;             // force the next refresh to repaint it
      }, DENY_FLASH_MS);
    }
  }

  /** @private Clear denial timers/visuals (hide/teardown path). */
  _clearDenied() {
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
    if (this._denyTimer) { clearTimeout(this._denyTimer); this._denyTimer = null; }
    if (this._toast) this._toast.style.opacity = '0';
    for (const n of this._notches) if (n && n._deny) { n._deny = false; n._cur = null; }
  }
}
