/**
 * TouchVerbButton.js - u15a (2026-10-22): two controls a touch player had no way to reach, glass only.
 *
 *   FLY THERE  (floor 4)        The Space key on floor 4 flies the transfer to the focused cluster. The button sends the
 *                               SAME key (KeyDispatch.pressKey('Space')), so the ladder's verb dispatch runs
 *                               (LadderController._dispatchVerb -> NavcomFloor.planTransfer -> main.js onPlanTransfer ->
 *                               DEBRIS_MAP_CLUSTER_SELECTED -> engageCluster). Never `planTransfer()` directly (the nets
 *                               lane will point the same verb at "go to the picked row"). Its label comes from the floor's
 *                               Space verb through VERB_LABELS, so a new verb is one more row, not new button logic.
 *                               Shown while floor 4 has a focused cluster, the ladder is not riding, and Space would act
 *                               (not swallowed by the codex, help, the old map, a ceremony, a pause).
 *   DE-SPIN    (floors 2-3)     Press and HOLD to fire the mother's de-spin laser (the L key, held). It shows only while the
 *                               laser could fire at the selected target and the target still tumbles above the net-safe
 *                               spin (DESPIN_LASER.IN_SPEC_DEG): feature on, gameplay, no overlay, the piloted-daughter
 *                               rule, target within RANGE_M. The key goes down with the finger and up on EVERY way the
 *                               hold can end: pointerup, pointercancel, lost pointer capture, pointer leaving, touchend /
 *                               touchcancel, the window seeing the finger lift, the page hiding or losing focus, the
 *                               button hiding (target gone, floor change, laser in spec), dispose. The laser can never stay
 *                               on with no finger down.
 *
 * Why not ticker chips: the hint strip is display:none on floors 3-5 (FloorMask) and a ticker step button is click-only
 * (down and up back to back), so neither a floor-4 button nor a hold fits there.
 *
 * Glass reads at draw time: `glass` is an injected flag (main.js builds this inside the TouchControls.detect() block, after
 * GestureHints.setGlass(true)); desktop never constructs it.
 *
 * @module ui/TouchVerbButton
 */

import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';

export const FLY_BTN_ID = 'touch-verb-fly';
export const DESPIN_BTN_ID = 'touch-verb-despin';

/** The floor's Space verb (FloorContract spaceVerb) -> the label of the button that sends Space. One row per verb. */
export const VERB_LABELS = Object.freeze({ 'plan-transfer': 'FLY THERE' });
export const DESPIN_LABEL = 'DE-SPIN';

/** The key each button presses. */
export const FLY_KEY = 'Space';
export const DESPIN_KEY = 'KeyL';

/** Floors that carry each button. */
export const FLY_FLOOR = 4;
export const DESPIN_FLOORS = Object.freeze([2, 3]);

/** CSS px above the viewport bottom, by floor (floor 2: clear of the hint strip, 88 up to ~148 with a 44 px step button on it; gone on 3-5). */
export const BOTTOM_PX = Object.freeze({ 2: 168, 3: 88, 4: 88 });

/** Re-read cadence for what no event announces (cluster focus, tumble). */
const POLL_MS = 120;

const BASE_CSS = [
  'position:fixed', 'left:50%', 'transform:translateX(-50%)',
  'box-sizing:border-box', 'min-height:48px', 'min-width:132px', 'padding:0 26px',
  'align-items:center', 'justify-content:center',
  'font-family:var(--font-mono)', 'font-size:16px', 'font-weight:bold', 'letter-spacing:0.08em',
  'color:var(--hud-label, #ffffff)',
  'background:rgb(var(--hud-ink-rgb, 0 10 20) / 0.92)',
  'border:2px solid rgb(var(--hud-info-rgb, 0 204 255) / 0.7)', 'border-radius:8px',
  'box-shadow:0 0 10px rgb(var(--hud-info-rgb, 0 204 255) / 0.4)',
  'pointer-events:auto', 'cursor:pointer',
  'touch-action:none', 'user-select:none', '-webkit-user-select:none', '-webkit-touch-callout:none',
  '-webkit-tap-highlight-color:transparent',
  'z-index:39',   // above the cluster icons (33), the turn pad (37), the pause button (40 sits elsewhere); below menus (50+)
].join(';') + ';';

export class TouchVerbButton {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {HTMLElement} deps.parent                 where the buttons go (document.body: #hud-overlay is a z-10 stacking context)
   * @param {object} [deps.bus]                       EventBus
   * @param {object} [deps.events]                    the Events table
   * @param {boolean} [deps.glass=true]               false -> builds nothing (desktop)
   * @param {() => (number|null)} deps.getFloor       live ladder floor, null when the ladder is not active
   * @param {() => boolean} [deps.isRiding]           the ladder is riding between floors
   * @param {() => (string|null)} [deps.getSpaceVerb] floor -> that floor's Space verb; default FloorContract.byId(floor).spaceVerb
   * @param {() => (object|null)} [deps.getFocusedCluster]  NavcomFloor.getFocusedCluster
   * @param {() => boolean} [deps.isInputBlocked]     the game would swallow the key: not gameplay, paused, codex / help / old map open, a ceremony
   * @param {(code:string) => *} deps.press           KeyDispatch.pressKey
   * @param {(code:string) => *} deps.hold            KeyDispatch.holdKey (keydown only)
   * @param {(code:string) => *} deps.release         KeyDispatch.releaseKey (keyup)
   * @param {() => boolean} [deps.isDespinEnabled]    default Constants.isFeatureEnabled('LASER_DESPIN')
   * @param {() => (object|null)} [deps.getDespinTarget]  the debris the laser would fire at (selector target, or the piloted daughter's station-keep target)
   * @param {(target:object) => (number|null)} [deps.getTargetDistanceM]  metres from the mother optic, null = unknown (laser treats as in range)
   * @param {Document} [deps.visibilityDoc]           where `visibilitychange` is heard (default `doc`)
   * @param {object} [deps.win]                       where blur / pagehide / pointer lift are heard (default `window`)
   * @param {boolean} [deps.poll=true]                false -> no timer (tests call refresh())
   */
  constructor(deps = {}) {
    this._d = deps;
    this._disposed = false;
    this._unsubs = [];
    this._timer = null;
    this._held = false;
    this._pid = null;
    this._flyShown = false;
    this._despinShown = false;
    this.flyEl = null;
    this.despinEl = null;
    this._winOff = [];
    this._glass = deps.glass !== false;
    if (!this._glass || !deps.doc || !deps.parent) return;
    const doc = deps.doc;

    this.flyEl = this._makeButton(doc, FLY_BTN_ID, 'FLY THERE');
    this.despinEl = this._makeButton(doc, DESPIN_BTN_ID, DESPIN_LABEL);

    // A finger on a button is nobody else's: no view drag, no radial, no scan-on-empty-tap from it.
    this._stop = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); };
    for (const t of ['touchstart', 'mousedown', 'mouseup']) {
      this.flyEl.addEventListener(t, this._stop);
      this.despinEl.addEventListener(t, this._stop);
    }
    this.flyEl.addEventListener('pointerdown', this._stop);
    this.flyEl.addEventListener('pointerup', this._stop);
    this.flyEl.addEventListener('click', (e) => this._onFlyClick(e));

    const de = this.despinEl;
    de.addEventListener('pointerdown', (e) => this._onDespinDown(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) {
      de.addEventListener(t, (e) => this._onDespinEnd(t, e));
    }
    for (const t of ['touchend', 'touchcancel']) {
      de.addEventListener(t, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); this._release(t); });
    }
    de.addEventListener('contextmenu', (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); });

    deps.parent.appendChild(this.flyEl);
    deps.parent.appendChild(this.despinEl);

    // The page going away from the finger: hidden tab, lost focus, a lifted finger the button never heard.
    const vdoc = deps.visibilityDoc || doc;
    const onVis = () => { if (vdoc.hidden === true || vdoc.visibilityState === 'hidden') this._release('visibilitychange'); };
    if (typeof vdoc.addEventListener === 'function') {
      vdoc.addEventListener('visibilitychange', onVis);
      this._winOff.push(() => vdoc.removeEventListener && vdoc.removeEventListener('visibilitychange', onVis));
    }
    const win = deps.win || (typeof window !== 'undefined' ? window : null);
    this._win = win;
    if (win && typeof win.addEventListener === 'function') {
      const onGone = (ev) => this._release(ev && ev.type ? ev.type : 'pagehide');
      for (const t of ['blur', 'pagehide']) {
        win.addEventListener(t, onGone);
        this._winOff.push(() => win.removeEventListener && win.removeEventListener(t, onGone));
      }
    }

    if (deps.bus && deps.events && typeof deps.bus.on === 'function') {
      const E = deps.events;
      for (const name of ['TARGET_SELECTED', 'TARGET_CLEARED', 'GAME_STATE_CHANGE', 'STATE_CHANGE', 'PAUSE_MENU', 'PAUSE_RESUME',
        'DESPIN_IN_SPEC', 'ABLATION_END', 'GAME_RESET', 'ARM_STATE_CHANGE', 'CONTROL_MODE_CHANGE']) {
        if (!E[name]) continue;
        const off = deps.bus.on(E[name], () => this.refresh());
        if (typeof off === 'function') this._unsubs.push(off);
      }
    }
    if (deps.poll !== false && typeof setInterval === 'function') {
      this._timer = setInterval(() => this.refresh(), POLL_MS);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }
    this.refresh();
  }

  /** @private */
  _makeButton(doc, id, label) {
    const b = doc.createElement('button');
    b.id = id;
    b.type = 'button';
    b.setAttribute('type', 'button');
    b.setAttribute('aria-label', label);
    b.setAttribute('hidden', '');
    b.textContent = label;
    b.style.cssText = BASE_CSS + 'display:none;bottom:' + BOTTOM_PX[3] + 'px;';
    return b;
  }

  // ── what is on offer ────────────────────────────────────────────────────

  /** @private */
  _blocked() {
    const f = this._d.isInputBlocked;
    if (typeof f !== 'function') return false;
    try { return !!f(); } catch (_e) { return true; }
  }

  /** @private */
  _floor() {
    try { return this._d.getFloor ? this._d.getFloor() : null; } catch (_e) { return null; }
  }

  /** @private the floor's Space verb, through the injected lookup or the floor table */
  _verb(floor) {
    try {
      if (typeof this._d.getSpaceVerb === 'function') return this._d.getSpaceVerb(floor) || null;
      const row = FloorContract.byId(floor);
      return (row && row.spaceVerb) || null;
    } catch (_e) { return null; }
  }

  /**
   * FLY THERE's label now, or null when it is not on offer: glass, floor 4, the floor's Space verb has a button, a
   * cluster is focused, the ladder is not riding and Space would act.
   * @returns {string|null}
   */
  flyLabel() {
    if (!this._glass || this._disposed) return null;
    if (this._floor() !== FLY_FLOOR) return null;
    const label = VERB_LABELS[this._verb(FLY_FLOOR)];
    if (!label) return null;
    try { if (this._d.isRiding && this._d.isRiding()) return null; } catch (_e) { return null; }
    let c = null;
    try { c = this._d.getFocusedCluster ? this._d.getFocusedCluster() : null; } catch (_e) { c = null; }
    if (!c) return null;
    if (this._blocked()) return null;
    return label;
  }

  /**
   * The debris the laser would fire at right now through this button, or null: floors 2-3, the feature on, input not
   * blocked (gameplay / overlays: the KeyL path's own checks), a target that still tumbles above the net-safe spin, in
   * the mother optic's range.
   * @returns {object|null}
   */
  despinTarget() {
    if (!this._glass || this._disposed) return null;
    if (!DESPIN_FLOORS.includes(this._floor())) return null;
    try { if (this._d.isRiding && this._d.isRiding()) return null; } catch (_e) { return null; }
    let on = true;
    try {
      on = typeof this._d.isDespinEnabled === 'function' ? !!this._d.isDespinEnabled() : Constants.isFeatureEnabled('LASER_DESPIN');
    } catch (_e) { on = false; }
    if (!on) return null;
    if (this._blocked()) return null;
    let t = null;
    try { t = this._d.getDespinTarget ? this._d.getDespinTarget() : null; } catch (_e) { t = null; }
    if (!t) return null;
    const cfg = Constants.DESPIN_LASER || {};
    const inSpec = (cfg.IN_SPEC_DEG ?? 10) * Math.PI / 180;
    if (!((t.tumbleRate || 0) > inSpec)) return null;
    let dist = null;
    try { dist = this._d.getTargetDistanceM ? this._d.getTargetDistanceM(t) : null; } catch (_e) { dist = null; }
    if (Number.isFinite(dist) && dist > (cfg.RANGE_M ?? 5000)) return null;
    return t;
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  /** @private write-on-change show / hide */
  _show(el, on) {
    if (on === !el.hasAttribute('hidden')) return;
    if (on) { el.removeAttribute('hidden'); el.style.display = 'inline-flex'; } else { el.setAttribute('hidden', ''); el.style.display = 'none'; }
  }

  /** Bring both buttons in line with the game. Safe at any time; the hold ends here whenever DE-SPIN is no longer on offer. */
  refresh() {
    if (this._disposed || !this.flyEl) return;
    const fly = this.flyLabel();
    const floor = this._floor();
    if (fly) {
      if (this.flyEl.textContent !== fly) { this.flyEl.textContent = fly; this.flyEl.setAttribute('aria-label', fly); }
      const bottom = BOTTOM_PX[FLY_FLOOR] + 'px';
      if (this.flyEl.style.bottom !== bottom) this.flyEl.style.bottom = bottom;
    }
    this._show(this.flyEl, !!fly);
    this._flyShown = !!fly;

    const t = this.despinTarget();
    if (!t && this._held) this._release('hidden');
    if (t) {
      const bottom = (BOTTOM_PX[floor] ?? BOTTOM_PX[3]) + 'px';
      if (this.despinEl.style.bottom !== bottom) this.despinEl.style.bottom = bottom;
    }
    this._show(this.despinEl, !!t);
    this._despinShown = !!t;
  }

  // ── FLY THERE ───────────────────────────────────────────────────────────

  /** @private a tap = the Space key */
  _onFlyClick(e) {
    this._stop(e);
    if (this._disposed) return;
    if (!this.flyLabel()) { this.refresh(); return; }   // stale: the game would not act on Space now
    try { if (typeof this.flyEl.blur === 'function') this.flyEl.blur(); } catch (_e) { /* stub */ }
    if (typeof this._d.press === 'function') {
      try { this._d.press(FLY_KEY); } catch (_e) { /* dep */ }
    }
    this.refresh();
  }

  // ── DE-SPIN ─────────────────────────────────────────────────────────────

  /** @returns {boolean} the laser key is held down by this button right now */
  isHeld() { return this._held; }

  /** @private a finger lands on DE-SPIN: the key goes down for as long as it stays */
  _onDespinDown(e) {
    this._stop(e);
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (this._disposed || this._held) return;
    if (!this.despinTarget()) { this.refresh(); return; }   // stale button: no laser
    this._pid = e && e.pointerId != null ? e.pointerId : null;
    try {
      if (this._pid != null && typeof this.despinEl.setPointerCapture === 'function') this.despinEl.setPointerCapture(this._pid);
    } catch (_e) { /* capture is best-effort: the window listeners below still hear the lift */ }
    this._held = true;
    this.despinEl.setAttribute('aria-pressed', 'true');
    if (typeof this._d.hold === 'function') {
      try { this._d.hold(DESPIN_KEY); } catch (_e) { /* dep */ }
    }
    // Belt and braces: if the button never hears the lift (capture lost, element removed), the window does.
    const win = this._win;
    if (win && typeof win.addEventListener === 'function') {
      // A touch event has no pointerId, and on iPad every lifting finger sends one: it only counts when this hold has no
      // pointer id (a browser without pointer events). Otherwise a second finger lifting (the turn pad) would cut the laser.
      const up = (ev) => {
        if (ev.pointerId == null) { if (this._pid == null) this._release(ev.type); return; }
        if (this._pid == null || ev.pointerId === this._pid) this._release(ev.type);
      };
      for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) win.addEventListener(t, up, true);
      this._liftOff = () => { for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) win.removeEventListener(t, up, true); };
    }
  }

  /** @private pointerup / pointercancel / lostpointercapture / pointerleave on the button */
  _onDespinEnd(type, e) {
    if (e && this._pid != null && e.pointerId != null && e.pointerId !== this._pid) return;   // another finger
    this._stop(e);
    this._release(type);
  }

  /**
   * Let the laser key go. Every path that ends a hold lands here; safe when nothing is held.
   * @param {string} [why]
   * @returns {boolean} true when a key-up was sent
   */
  _release(why) {
    if (!this._held) return false;
    this._held = false;
    const pid = this._pid;
    this._pid = null;
    if (this._liftOff) { try { this._liftOff(); } catch (_e) { /* stub */ } this._liftOff = null; }
    if (this.despinEl) {
      this.despinEl.removeAttribute('aria-pressed');
      try { if (pid != null && typeof this.despinEl.releasePointerCapture === 'function') this.despinEl.releasePointerCapture(pid); } catch (_e) { /* already released */ }
    }
    this._lastRelease = why || null;
    if (typeof this._d.release === 'function') {
      try { this._d.release(DESPIN_KEY); } catch (_e) { /* dep */ }
    }
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._release('dispose');
    this._disposed = true;
    for (const off of this._unsubs) { try { off(); } catch (_e) { /* stub bus */ } }
    this._unsubs = [];
    for (const off of this._winOff) { try { off(); } catch (_e) { /* stub */ } }
    this._winOff = [];
    if (this._timer != null && typeof clearInterval === 'function') clearInterval(this._timer);
    this._timer = null;
    for (const el of [this.flyEl, this.despinEl]) {
      try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (_e) { /* stub */ }
    }
    this.flyEl = null;
    this.despinEl = null;
  }
}

export default TouchVerbButton;
