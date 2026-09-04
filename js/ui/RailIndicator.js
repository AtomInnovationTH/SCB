/**
 * RailIndicator.js — the Zoom Ladder rail indicator (S2 stub → G3 polish).
 *
 * Right-edge, 7 notches labelled with instrument names + a spring-charge fill,
 * driven by LadderController from `ladder.getState()` / charge decisions
 * (docs/ladder/00-spec.md §10, VisualLaw.RAIL), plus the time-rate readout
 * at the rail's head (VisualLaw.RAIL.SHOWS 'warp-readout'; 08-workbench §2
 * "time rate" vitals / §11 Wave 4 "rail warp readout"). Still no costumes,
 * subject line, or clickable notches — those are S4+.
 *
 * Warp readout (setRate): '1×' / '4×' / '20×' / '100×' — the live
 * TimeAuthority.rate rounded to the nearest integer (intermediate ramp values
 * show rounded), fed per frame by main.js while the ladder is engaged. Write-
 * on-change AND throttled to ≤ RATE_WRITE_MIN_MS (4 Hz) — G1: no per-frame
 * DOM churn even while the rate ramps through every integer.
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
 * Wave 5 Session E (08-workbench §5 D3 — the depot INVITATION): from chapter
 * 4 on a mission boundary no longer forces the depot stop; instead the DEPOT
 * notch GLOWS — VisualLaw VALUE gold, STEADY (gold never pulses), border +
 * label + a soft halo (the shape channel: colour is never the sole channel) —
 * until the player pushes into the doorway or the window lapses. Driven by
 * `setDepotInvitation(open)` from main.js's DEPOT_INVITATION listener (the
 * rail stays EventBus-free). The paint law is pure (`notchPaint`): a denial
 * flash still wins while it flashes, then the glow returns.
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
/** Warp readout: minimum interval between DOM writes (ms) — 4 Hz cap (G1). */
export const RATE_WRITE_MIN_MS = 250;

/** Notch resting/active palette (INFO instrument frame, PLAYER current). */
const NOTCH_REST_BORDER = 'rgba(0,204,255,0.35)';
const NOTCH_REST_COLOR = 'rgba(0,204,255,0.62)';
/**
 * The invitation halo — VisualLaw.COLORS.VALUE (#ffd166) at 0.55 alpha, a
 * STEADY box-shadow (no animation, no transition pulse: gold never pulses).
 */
export const INVITE_HALO = '0 0 10px rgba(255,209,102,0.55)';
/** The floor whose notch carries the invitation (FloorContract F2, 'DEPOT'). */
const DEPOT_FLOOR = (FloorContract.FLOORS.find((f) => f.name === 'DEPOT') || { id: 2 }).id;

export class RailIndicator {
  constructor() {
    this._root = null;
    this._toast = null;
    this._notches = [];   // per-floor { el, fill, _cur, _pct, _deny, _denyTimer } (index 0 = F1)
    this._visible = false;
    this._built = false;
    this._toastTimer = null;
    // Reused notchState() output — refresh() runs per frame; no per-notch
    // literal allocation in the hot path (G5 review follow-up).
    this._notchScratch = { current: false, fillPct: 0 };
    // Warp readout (setRate): the element, the last label WRITTEN, and when.
    this._rate = null;
    this._rateLabel = null;
    this._rateWriteMs = -Infinity;
    /** The depot invitation (Wave 5 Session E): true while the DEPOT notch glows. */
    this._invite = false;
  }

  /**
   * Pure warp-readout label law (headless-testable): the live rate rounded to
   * the nearest integer with the × glyph — '1×', '4×', '20×', '100×'; ramp
   * intermediates show rounded ('7×'). Non-finite input reads as the shipped 1×.
   * @param {number} rate - TimeAuthority.rate (warp multiplier on the base scale)
   * @returns {string}
   */
  static rateLabel(rate) {
    const n = Number.isFinite(rate) ? Math.max(0, Math.round(rate)) : 1;
    return `${n}\u00d7`;
  }

  /**
   * Pure write-gate law: write when the label CHANGED and at least
   * RATE_WRITE_MIN_MS passed since the last write (≤ 4 Hz). A label that is
   * still pending after the window is written on the next call (the settled
   * value is never lost — the caller feeds every frame).
   * @param {string} label - candidate label
   * @param {string|null} lastLabel - last label written (null = never)
   * @param {number} lastWriteMs - time of the last write (-Infinity = never)
   * @param {number} nowMs - caller clock
   * @returns {boolean}
   */
  static shouldWriteRate(label, lastLabel, lastWriteMs, nowMs) {
    return label !== lastLabel && (nowMs - lastWriteMs) >= RATE_WRITE_MIN_MS;
  }

  /**
   * Pure notch-state law (headless-testable): what a notch shows for a state.
   * Pass `out` to reuse a scratch object (per-frame callers); omitted, a fresh
   * object is returned (tests, one-shot reads).
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   * @param {number} floorId - 1-based floor id of the notch
   * @param {{current:boolean, fillPct:number}} [out] - optional scratch target
   * @returns {{current:boolean, fillPct:number}}
   */
  static notchState(state, floorId, out) {
    const current = floorId === state.floor;
    let pct = 0;
    if (state.chargeSide === 'up' && floorId === state.floor + 1) pct = state.charge * 100;
    if (state.chargeSide === 'down' && floorId === state.floor - 1) pct = state.charge * 100;
    const fillPct = Math.max(0, Math.min(100, pct));
    if (out) { out.current = current; out.fillPct = fillPct; return out; }
    return { current, fillPct };
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

  /**
   * Pure notch paint law (headless-testable) — what colours a notch wears:
   *   deny    → THREAT border + label (the G2i hard-wall flash; wins while it flashes)
   *   invite  → VALUE border + label + the steady INVITE_HALO (the depot invitation,
   *             Wave 5 Session E — gold never pulses; the halo is the shape channel)
   *   current → PLAYER border + label (the engaged floor)
   *   else    → the INFO resting frame
   * `invite` outranks `current` (a notch that is both — the player standing on the
   * glowing depot — is transient: arriving on F2 enters the SHOP and closes it).
   * @param {{current:boolean, deny?:boolean, invite?:boolean}} flags
   * @returns {{borderColor:string, color:string, boxShadow:string}}
   */
  static notchPaint({ current, deny = false, invite = false }) {
    if (deny) return { borderColor: VisualLaw.COLORS.THREAT, color: VisualLaw.COLORS.THREAT, boxShadow: 'none' };
    if (invite) return { borderColor: VisualLaw.COLORS.VALUE, color: VisualLaw.COLORS.VALUE, boxShadow: INVITE_HALO };
    if (current) return { borderColor: VisualLaw.COLORS.PLAYER, color: VisualLaw.COLORS.PLAYER, boxShadow: 'none' };
    return { borderColor: NOTCH_REST_BORDER, color: NOTCH_REST_COLOR, boxShadow: 'none' };
  }

  /** The DEPOT notch's 1-based floor id (FloorContract F2). */
  static get DEPOT_FLOOR() { return DEPOT_FLOOR; }

  /**
   * The depot invitation (08-workbench §5 D3): `open` true → the DEPOT notch
   * glows VALUE gold, steady, until `open` false (the player entered, the
   * window lapsed, or the game reset). Fed by main.js from DEPOT_INVITATION —
   * the rail never derives the chapter rule itself. Headless / not yet built:
   * the flag is kept and painted on the first refresh after build. Write-on-
   * change: the notch repaints once per flip, never per frame.
   * @param {boolean} open
   */
  setDepotInvitation(open) {
    const want = !!open;
    if (want === this._invite) return;
    this._invite = want;
    const n = this._notches[DEPOT_FLOOR - 1];
    if (n) n._cur = null;                 // force the next refresh to repaint it
  }

  /** @returns {boolean} true while the DEPOT notch glows (the invitation is open). */
  isDepotInvited() { return this._invite; }

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
      this._notches[f.id - 1] = { el: notch, fill, _cur: null, _pct: null, _deny: false, _denyTimer: null };
    }

    // Warp readout at the rail's HEAD: column-reverse puts a later child at
    // the TOP (above F7). INFO instrument color, small, right-aligned; empty
    // until the first setRate() write.
    const rate = document.createElement('div');
    rate.id = 'ladder-rail-rate';
    rate.style.cssText = [
      'padding:0 8px 2px', 'text-align:right', 'white-space:nowrap',
      `color:${VisualLaw.COLORS.INFO}`, 'font-size:0.62rem', 'letter-spacing:0.12em',
      'opacity:0.85',
    ].join(';');
    root.appendChild(rate);
    this._rate = rate;

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
      const { current, fillPct } = RailIndicator.notchState(state, i + 1, this._notchScratch);
      if (n._cur !== current && !n._deny) {
        // The depot invitation (Wave 5 Session E) paints through the same law
        // as the current-floor mark; a flip of either repaints once (the
        // invite flip nulls _cur — setDepotInvitation). Denial flash wins.
        const invite = this._invite && (i + 1 === DEPOT_FLOOR);
        const p = RailIndicator.notchPaint({ current, invite });
        n.el.style.borderColor = p.borderColor;
        n.el.style.color = p.color;
        n.el.style.boxShadow = p.boxShadow;
        n._cur = current;
      }
      if (n._pct !== fillPct) {
        n.fill.style.width = `${fillPct}%`;
        n._pct = fillPct;
      }
    }
  }

  /**
   * Time-rate readout at the rail's head (VisualLaw.RAIL.SHOWS 'warp-readout').
   * Fed per frame by main.js with `timeAuthority.rate` while the ladder is
   * engaged. Write-on-change, ≤ 4 Hz (RATE_WRITE_MIN_MS) — G1. Headless: no
   * DOM → returns before touching any state.
   * @param {number} rate - TimeAuthority.rate (1 = shipped speed)
   * @param {number} [nowMs] - caller clock (defaults to performance.now())
   * @returns {boolean} whether a DOM write happened this call
   */
  setRate(rate, nowMs) {
    if (!this._rate) return false;
    const label = RailIndicator.rateLabel(rate);
    const t = (nowMs != null) ? nowMs
      : (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!RailIndicator.shouldWriteRate(label, this._rateLabel, this._rateWriteMs, t)) return false;
    this._rate.textContent = label;
    this._rateLabel = label;
    this._rateWriteMs = t;
    return true;
  }

  /**
   * Denied feedback for a hard wall (G2i). Flashes the blocked notch
   * THREAT-red once (one-shot, ≤3 Hz law) and, when the FloorContract
   * provides a deniedHint ('DOCK TO ENTER DEPOT'), shows the amber toast.
   * Re-calls restart both timers. The restore timer is PER NOTCH (G4 review
   * follow-up): a shared timer let a second denial on a DIFFERENT notch
   * cancel the first notch's restore, stranding it THREAT-red — unreachable
   * with one dock-gated floor today, live the moment another one exists.
   * Headless: no DOM → returns before any timer is allocated.
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
      const p = RailIndicator.notchPaint({ current: false, deny: true });
      n.el.style.borderColor = p.borderColor;
      n.el.style.color = p.color;
      n.el.style.boxShadow = p.boxShadow;   // the flash also lifts an invitation halo for its 320 ms
      if (n._denyTimer) clearTimeout(n._denyTimer);
      n._denyTimer = setTimeout(() => {
        n._denyTimer = null;
        n._deny = false;
        n._cur = null;             // force the next refresh to repaint it
      }, DENY_FLASH_MS);
    }
  }

  /** @private Clear denial timers/visuals (hide/teardown path). */
  _clearDenied() {
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
    if (this._toast) this._toast.style.opacity = '0';
    for (const n of this._notches) {
      if (!n) continue;
      if (n._denyTimer) { clearTimeout(n._denyTimer); n._denyTimer = null; }
      if (n._deny) { n._deny = false; n._cur = null; }
    }
  }
}
