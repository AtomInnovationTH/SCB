/**
 * RailIndicator.js — the Zoom Ladder rail: right edge, one notch per floor labelled with instrument names, a
 * spring-charge fill, and the time-rate readout at its head. Driven by LadderController from `ladder.getState()`
 * (docs/ladder/00-spec.md §10, VisualLaw.RAIL; the readout is VisualLaw.RAIL.SHOWS 'warp-readout'). No costumes,
 * subject line or clickable notches.
 *
 * Warp readout (setRate): the live TimeAuthority.rate rounded to an integer ('1×', '100×'); a rate rounding to 0
 * reads 'HOLD'. Written on change AND at most every RATE_WRITE_MIN_MS (4 Hz): no per-frame DOM churn.
 *
 * - Mid-height on the right edge through the shared RailGeometry table (`midHeightCss`), clear of the bottom
 *   ~100 pt iPad thumb rest.
 * - Instrument identity: INFO-blue frame/labels (VisualLaw.COLORS.INFO) so the rail reads as a control; the current
 *   floor and the charge fill keep PLAYER green.
 * - flashDenied(hint, floor): a hard wall flashes the blocked notch THREAT-red once (one-shot ≤ 3 Hz,
 *   VisualLaw.KLAXON.FLASH_HZ_MAX) and, when the contract gives a deniedHint, shows an amber toast above the rail
 *   (no shipping floor carries one). Warning amber is the shipped HUD warning family, deliberately NOT a new
 *   VisualLaw law colour (the 5-colour pin stands).
 *
 * EDGE CHROME (owner 2026-09-07): the rail and its rate label sleep on an external PURE clock
 * (`js/ui/EdgeChrome.js`, duck-typed as `edgeChrome`, never imported). Rest = vanish: opacity → RAIL_GEOMETRY.IDLE_FADE
 * (= 0), then `visibility:hidden` only AFTER the fade (no fade under reduced motion). A 1 px PLAYER "box" outline
 * (BOX_OUTLINE) marks the arrival floor's notch and the rate label while BOX_MS elapses. Wake sources handled HERE:
 * charge, rate write, denial, show; LadderController handles floor apply (wake all + box 'floor') and ride (wake).
 * The box is the notch's `outline`, never `border`/`boxShadow`, which belong to notchPaint. No timers: refresh reads
 * EdgeChrome per frame and writes on change. Without the dep the rail fades but never vanishes.
 *
 * Depot INVITATION (08-workbench §5 D3): from chapter 4 on a mission boundary no longer forces the depot stop; the
 * WORKBENCH notch (floor 1) GLOWS instead — VisualLaw VALUE gold, STEADY (gold never pulses), border + label + soft
 * halo (the shape channel: colour is never the sole channel) — until the player pushes into the doorway or the
 * window lapses. Driven by `setDepotInvitation(open)` from main.js's DEPOT_INVITATION listener (the rail stays
 * EventBus-free). A denial flash wins while it flashes (notchPaint is pure).
 *
 * Fully DOM-guarded: inert and constructible headless; no timers unless the DOM exists.
 *
 * @module ui/RailIndicator
 */

import { FloorContract } from '../core/FloorContract.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { midHeightCss, dodgeTop } from './RailGeometry.js';
import { GestureHints } from './hud/GestureHints.js';
import { clamp } from '../core/MathUtil.js';

/** The HUD column on the WHERE rail's side — what the dodge measures (HUD.js's right stack). */
export const SIDE_COLUMN_ID = 'hud-right-column';
/** The dodge's layout read runs at most this often (the per-frame HUD-poll law: ≤ 1 Hz). */
export const DODGE_MIN_MS = 1000;

/** Denial toast hold time (ms); the fade is the 0.3 s opacity transition. */
const TOAST_HOLD_MS = 1800;
/** Blocked-notch flash duration (ms). One-shot: 1 flash ≪ 3 Hz cap. */
const DENY_FLASH_MS = 320;
/** VisualLaw.COLORS.CAUTION: the shared HUD warning amber (one definition). */
const WARN_AMBER = VisualLaw.COLORS.CAUTION;
/** Warp readout: minimum interval between DOM writes (ms) — 4 Hz cap (G1). */
export const RATE_WRITE_MIN_MS = 250;

/** The EDGE-CHROME "box": a 1 px PLAYER outline. */
export const BOX_OUTLINE = `1px solid ${VisualLaw.COLORS.PLAYER}`;
/** The box's offset — 2 px out (the notch's own 1 px border is NOT the box). */
export const BOX_OUTLINE_OFFSET = '2px';

/** Notch resting/active palette (INFO instrument frame, PLAYER current). */
const NOTCH_REST_BORDER = 'rgba(0,204,255,0.35)';
const NOTCH_REST_COLOR = 'rgba(0,204,255,0.62)';
/** Invitation halo: VisualLaw.COLORS.VALUE at 0.55 alpha, a STEADY box-shadow (gold never pulses). Imported by RefitPane. */
const _rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
export const INVITE_HALO = `0 0 10px ${_rgba(VisualLaw.COLORS.VALUE, 0.55)}`;
/**
 * The floor whose notch carries the depot invitation: floor 1 (HULL CAM, the workbench). The name `setDepotInvitation`
 * stays: the signal is still Events.DEPOT_INVITATION.
 */
const INVITE_FLOOR = 1;

export class RailIndicator {
  constructor({ edgeChrome = null, now = null } = {}) {
    this._root = null;
    /** @private the dodge: last applied top (null = mid-height) + last layout read */
    this._dodgeTop = null;
    this._dodgeAtMs = -Infinity;
    this._dodgeBottom = null;
    this._railBottom = null;   // the rail's bottom wherever it sits (bottomPx)
    this._toast = null;
    this._notches = [];   // per-floor { el, fill, _cur, _pct, _deny, _denyTimer } (index 0 = F1)
    this._visible = false;
    this._built = false;
    this._toastTimer = null;
    // Reused notchState() output: refresh() runs per frame, so no per-notch allocation.
    this._notchScratch = { current: false, fillPct: 0 };
    // Warp readout (setRate): the element, the last label WRITTEN, and when.
    this._rate = null;
    this._rateLabel = null;
    this._rateWriteMs = -Infinity;
    /** The depot invitation: true while notch 1 glows. */
    this._invite = false;
    /** The EDGE-CHROME dep (duck-typed EdgeChrome; null = no fade/box). */
    this._edgeChrome = edgeChrome || null;
    /** Optional caller clock (tests): the wake/phase reads ride it. */
    this._now = (typeof now === 'function') ? now : null;
    /** Last phase WRITTEN ('awake'|'fading'|'hidden', null = none yet). */
    this._phase = null;
    /** The notch index (0-based) currently wearing the box, or -1/null. */
    this._boxFloor = null;
    /** Whether the rate label currently wears the box. */
    this._boxRate = false;
  }

  /** @private Injected `now` option, else performance.now/Date.now. */
  _clock() {
    if (this._now) return this._now();
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * Pure warp-readout label: the rate rounded to an integer with ×, e.g. '1×', '7×' (mid-ramp). Non-finite reads 1×.
   * @param {number} rate - TimeAuthority.rate (warp multiplier on the base scale)
   */
  static rateLabel(rate) {
    const n = Number.isFinite(rate) ? Math.max(0, Math.round(rate)) : 1;
    // A held world reads HOLD, never "0×" (the drawer stopped the clock, TimeAuthority.calmCap 0); rates below 0.5 too.
    return n === 0 ? 'HOLD' : `${n}\u00d7`;
  }

  /**
   * Pure write gate: write when the label CHANGED and RATE_WRITE_MIN_MS passed since the last write (≤ 4 Hz). A
   * pending label is written on the next call (the caller feeds every frame), so the settled value is never lost.
   * @param {number} lastWriteMs - time of the last write (-Infinity = never)
   * @param {number} nowMs - caller clock
   */
  static shouldWriteRate(label, lastLabel, lastWriteMs, nowMs) {
    return label !== lastLabel && (nowMs - lastWriteMs) >= RATE_WRITE_MIN_MS;
  }

  /**
   * Pure notch state: what a notch shows. Pass `out` to reuse a scratch object (per-frame callers); omitted, a fresh
   * object is returned.
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   * @param {number} floorId - 1-based floor id of the notch
   */
  static notchState(state, floorId, out) {
    const current = floorId === state.floor;
    let pct = 0;
    if (state.chargeSide === 'up' && floorId === state.floor + 1) pct = state.charge * 100;
    if (state.chargeSide === 'down' && floorId === state.floor - 1) pct = state.charge * 100;
    const fillPct = clamp(pct, 0, 100);
    if (out) { out.current = current; out.fillPct = fillPct; return out; }
    return { current, fillPct };
  }

  /** Pure toast law: a denial with a contract hint shows it; a hintless denial (ladder end) is quiet, notch flash only. */
  static toastFor(hint) {
    const text = (typeof hint === 'string' && hint.trim()) ? hint.trim() : '';
    return { show: text.length > 0, text };
  }

  /**
   * Pure notch paint law, in priority order:
   *   deny    → THREAT border + label (the hard-wall flash)
   *   invite  → VALUE border + label + the steady INVITE_HALO (depot invitation; the halo is the shape channel)
   *   current → PLAYER border + label (the engaged floor)
   *   else    → the INFO resting frame
   * `invite` outranks `current` (a notch that is both resolves when the shop opens or the window lapses).
   */
  static notchPaint({ current, deny = false, invite = false }) {
    if (deny) return { borderColor: VisualLaw.COLORS.THREAT, color: VisualLaw.COLORS.THREAT, boxShadow: 'none' };
    if (invite) return { borderColor: VisualLaw.COLORS.VALUE, color: VisualLaw.COLORS.VALUE, boxShadow: INVITE_HALO };
    if (current) return { borderColor: VisualLaw.COLORS.PLAYER, color: VisualLaw.COLORS.PLAYER, boxShadow: 'none' };
    return { borderColor: NOTCH_REST_BORDER, color: NOTCH_REST_COLOR, boxShadow: 'none' };
  }

  static get INVITE_FLOOR() { return INVITE_FLOOR; }

  /**
   * Depot invitation (08-workbench §5 D3): `open` true → the workbench notch (floor 1) glows VALUE gold, steady, until
   * `open` false (shop entered, window lapsed, game reset). Fed by main.js from DEPOT_INVITATION; the rail never
   * derives the chapter rule. Headless / not yet built: the flag is kept and painted on the first refresh after
   * build. Write-on-change: one repaint per flip.
   */
  setDepotInvitation(open) {
    const want = !!open;
    if (want === this._invite) return;
    this._invite = want;
    const n = this._notches[INVITE_FLOOR - 1];
    if (n) n._cur = null;                 // force the next refresh to repaint it
  }

  isDepotInvited() { return this._invite; }

  /** Lazily build the DOM (idempotent, no-op headless). @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;

    const root = document.createElement('div');
    root.id = 'ladder-rail';
    // Idle-fade opacity ramp rides the chrome's fadeMs (0 under reduced motion); no dep → 0.3 s.
    const fade = this._edgeChrome ? `opacity ${this._edgeChrome.fadeMs}ms` : 'opacity 0.3s';
    // Mid-height on the right edge via the shared rail geometry, clear of the bottom ~100 pt thumb rest. The fragment
    // ends in ';' so it prefixes the joined list cleanly.
    root.style.cssText = midHeightCss('right') + [
      'display:flex', 'flex-direction:column-reverse', 'gap:5px',
      'font-family: var(--font-mono)', 'font-size:0.6rem', 'letter-spacing:0.08em',
      'text-transform:uppercase',
      'padding:6px 6px 6px 8px',
      `border-left:2px solid ${NOTCH_REST_BORDER}`,
      'background:rgba(0,10,22,0.42)', 'border-radius:4px',
      'z-index:35', 'pointer-events:none', 'opacity:0', `transition:${fade}`,
    ].join(';');

    // column-reverse so F1 sits at the bottom, F5 at the top (elevator order).
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

    // Warp readout at the rail's HEAD (column-reverse: a later child sits on top). Empty until the first setRate().
    const rate = document.createElement('div');
    rate.id = 'ladder-rail-rate';
    rate.style.cssText = [
      'padding:0 8px 2px', 'text-align:right', 'white-space:nowrap',
      `color:${VisualLaw.COLORS.INFO}`, 'font-size:0.62rem', 'letter-spacing:0.12em',
      'opacity:0.85',
    ].join(';');
    root.appendChild(rate);
    this._rate = rate;

    // Denial toast ABOVE the rail's head: `bottom:calc(100% + 8px)` is relative to the root, so it rides the
    // mid-height anchor. Hidden until flashDenied() with a hint.
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

  /** Show the rail (builds on first show); wakes the edge chrome and applies the phase at once. */
  show() {
    this._build();
    this._visible = true;
    if (this._root) this._root.style.opacity = '1';
    if (this._edgeChrome) {
      const now = this._clock();
      this._edgeChrome.wake('rail', now);
      if (this._root) this._applyPhase(now);
    }
  }

  /** Hide the rail (clears denial feedback); resets the cached phase so the next show re-applies (hide() is the menu, not a sleep). */
  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
    this._clearDenied();
    this._phase = null;
  }

  /**
   * The rail's bottom edge in CSS px while DODGED under the right HUD column, else null. Kept as the dodge witness
   * (probe / tests); no runtime consumer. Refreshed with the 1 Hz dodge read.
   * @returns {number|null}
   */
  dodgeBottom() { return this._visible ? this._dodgeBottom : null; }

  /**
   * The rail's bottom edge in CSS px wherever it sits (dodged, or mid-height: innerH/2 + railH/2), else null while
   * hidden / unmeasured. main.js feeds it to RangeMap's `rail` dep. Refreshed with the 1 Hz dodge read; no layout
   * read of its own.
   * @returns {number|null}
   */
  bottomPx() { return this._visible ? this._railBottom : null; }

  /**
   * The rail's LEFT edge in CSS px wherever it sits, else null while hidden / unmeasured. The hub feeds it (as
   * `innerWidth - leftPx()`, the reach from the RIGHT screen edge) to MotherCallouts.setRailInsets so the hull
   * callouts' right column starts left of the rail. Recorded by the 1 Hz dodge read from the same root rect that
   * gives railH; `_railLeft` is first written by that read (unwritten reads as null).
   * @returns {number|null}
   */
  leftPx() { return (this._visible && this._railLeft != null) ? this._railLeft : null; }

  /**
   * Refresh from a ZoomLadder state snapshot (archive/ladder/06-core-api.md). Named
   * `refresh` (not `update`): LadderController drives it from ladder state, not the main loop. Writes are cached;
   * this runs per frame and must not churn same-value styles.
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   */
  refresh(state) {
    if (!this._root || !state) return;
    for (let i = 0; i < this._notches.length; i++) {
      const n = this._notches[i];
      if (!n) continue;
      const { current, fillPct } = RailIndicator.notchState(state, i + 1, this._notchScratch);
      if (n._cur !== current && !n._deny) {
        // The depot invitation paints through the same law as the current-floor mark; a flip of either repaints once
        // (the invite flip nulls _cur — setDepotInvitation). Denial flash wins.
        const invite = this._invite && (i + 1 === INVITE_FLOOR);
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
    this._applyDodge();
    // Edge chrome: a live zoom charge wakes the rail; the phase applies ONLY while shown by the controller (a hide()-
    // hidden rail on the menu is never re-shown by refresh); boxes ride the arrival floor/rate state.
    if (this._edgeChrome) {
      const now = this._clock();
      if (state.charge !== 0) this._edgeChrome.wake('rail', now);
      if (this._visible) this._applyPhase(now);
      this._applyBoxes(state, now);
    }
  }

  /**
   * @private THE DODGE (RailGeometry.dodgeTop; owner 2026-09-06): the rail slides under the RIGHT HUD column when
   * mid-height would overlap it, and back when it clears. ONE layout read per DODGE_MIN_MS (refresh runs per frame:
   * the ≤ 1 Hz poll law); write-on-change on `top`/`transform`. Headless / no column → mid-height.
   */
  _applyDodge() {
    const root = this._root;
    if (!root || typeof document === 'undefined' || typeof root.getBoundingClientRect !== 'function') return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - this._dodgeAtMs < DODGE_MIN_MS) return;
    this._dodgeAtMs = now;
    const col = document.getElementById(SIDE_COLUMN_ID);
    const cr = (col && typeof col.getBoundingClientRect === 'function') ? col.getBoundingClientRect() : null;
    const colBottom = (cr && cr.height > 0) ? cr.bottom : -Infinity;
    const innerH = (typeof window !== 'undefined') ? Number(window.innerHeight) : 0;
    const rr = root.getBoundingClientRect();   // the ONE root read: .height (the dodge) + .left (leftPx)
    const railH = rr.height;
    const top = dodgeTop({ railH, colBottom, innerH });
    this._dodgeBottom = (top == null) ? null : top + railH;
    // The rail's bottom wherever it sits (mid-height = the 50 % anchor).
    this._railBottom = (railH > 0) ? ((top == null) ? (innerH / 2 + railH / 2) : top + railH) : null;
    // The rail's LEFT edge from the SAME rect (leftPx → hub → MotherCallouts.setRailInsets).
    this._railLeft = (railH > 0) ? rr.left : null;
    if (top === this._dodgeTop) return;
    this._dodgeTop = top;
    if (top == null) {
      root.style.top = '50%';
      root.style.transform = 'translateY(-50%)';
    } else {
      root.style.top = `${top}px`;
      root.style.transform = 'none';
    }
  }

  /**
   * @private The EDGE-CHROME phase applied to the root. Write-on-change (refresh runs per frame). 'awake' → op 1 +
   * visible; 'fading' → op = restOpacity (the CSS transition ramps; visibility stays); 'hidden' → visibility hidden +
   * op = restOpacity defensively (a reduced-motion instant hide lands at rest). No-op headless or without the dep.
   * @param {number} now - caller clock (the chrome reads it)
   */
  _applyPhase(now) {
    if (!this._edgeChrome || !this._root) return;
    let ph = this._edgeChrome.phase('rail', now);
    // On glass the rail is the only thing that says which floor you are on (floors 1-2 have no caption), and an edge
    // tap to wake it is not discoverable: once revealed (the mission-1 quiet state is its own CSS attribute) it never
    // fades or hides. Desktop keeps the fade.
    if (ph !== 'awake' && GestureHints.isGlass()) ph = 'awake';
    if (ph === this._phase) return;
    this._phase = ph;
    if (ph === 'awake') {
      this._root.style.opacity = '1';
      this._root.style.visibility = 'visible';
    } else if (ph === 'fading') {
      this._root.style.opacity = String(this._edgeChrome.restOpacity);
    } else if (ph === 'hidden') {
      this._root.style.visibility = 'hidden';
      this._root.style.opacity = String(this._edgeChrome.restOpacity);
    }
  }

  /**
   * @private The EDGE-CHROME "box": an additive 1 px PLAYER outline on the arrival floor's notch and the rate label
   * while BOX_MS elapses (write-on-change). `outline` never collides with notchPaint's border/boxShadow. No-op
   * without the dep.
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   * @param {number} now - caller clock (the chrome reads it)
   */
  _applyBoxes(state, now) {
    if (!this._edgeChrome) return;
    const want = this._edgeChrome.isBoxed('floor', now) ? (state.floor - 1) : -1;
    if (want !== this._boxFloor) {
      if (this._boxFloor != null && this._boxFloor >= 0) {
        const old = this._notches[this._boxFloor];
        if (old) old.el.style.outline = 'none';
      }
      this._boxFloor = want;
      if (want >= 0) {
        const n = this._notches[want];
        if (n) {
          n.el.style.outline = BOX_OUTLINE;
          n.el.style.outlineOffset = BOX_OUTLINE_OFFSET;
        }
      }
    }
    const wantRate = this._edgeChrome.isBoxed('rate', now);
    if (wantRate !== this._boxRate) {
      this._boxRate = wantRate;
      if (this._rate) {
        this._rate.style.outline = wantRate ? BOX_OUTLINE : 'none';
        if (wantRate) this._rate.style.outlineOffset = BOX_OUTLINE_OFFSET;
      }
    }
  }

  /**
   * Time-rate readout at the rail's head. Fed per frame by main.js with `timeAuthority.rate` while the ladder is
   * engaged. Write-on-change, ≤ 4 Hz (RATE_WRITE_MIN_MS). Headless: no DOM → returns before touching any state.
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
    // A rate WRITE wakes the rail and boxes the readout (a mode appeared). No write, no wake/box (the throttled path
    // above returns first).
    if (this._edgeChrome) {
      this._edgeChrome.wake('rail', t);
      this._edgeChrome.box('rate', t);
    }
    this._rate.textContent = label;
    this._rateLabel = label;
    this._rateWriteMs = t;
    return true;
  }

  /**
   * Denied feedback for a hard wall. Flashes the blocked notch THREAT-red once (one-shot, ≤3 Hz law) and, when the
   * FloorContract provides a deniedHint, shows the amber toast (no shipping floor carries one; the mechanism stays,
   * pinned by tests). Re-calls restart both timers. The restore timer is PER NOTCH: a shared timer let a second
   * denial on a DIFFERENT notch cancel the first notch's restore, stranding it THREAT-red. Headless: no DOM →
   * returns before any timer is allocated.
   * @param {string|null} [hint] - FloorContract humps.deniedHint (null = ladder end)
   * @param {number} [floor] - the BLOCKED floor id (denial decision's `floor`)
   */
  flashDenied(hint, floor) {
    if (!this._root) return;
    // A hard-wall denial wakes the rail (the blocked notch's flash is feedback, visible on a sleeping rail too).
    if (this._edgeChrome) this._edgeChrome.wake('rail', this._clock());
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
