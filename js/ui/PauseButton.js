/**
 * PauseButton — the touch way to pause (2026-10-20, iPad slices 2–3). The Mac pauses with Esc; glass has no Esc,
 * and with the zoom ladder engaged Esc rides up a floor instead of pausing, so the button calls the pause path
 * itself (`InputManager.togglePause`) and never sends a key.
 *
 * - A 44×44 CSS px button `#hud-pause-btn` (two vertical bars drawn in CSS, `aria-label="Pause"`), beside the left column
 *   (x 448, y 128 on a 1366×1024 iPad), above the world labels; its position and look are one CSS block in index.html.
 * - Built ONLY when `deps.touch` is true (main.js passes `TouchControls.detect()`; it is always false under Node, so
 *   tests build it directly). Not on the Mac.
 * - Shown during play only: hidden on the menu, briefing, shop and game over (not `isPlaying()`), and while the pause
 *   overlay shows (its own RESUME button and MAIN MENU take over).
 * - A tap pauses. It must not start a view drag or open the radial: the pointer / touch / mouse down events stop at
 *   the button (the canvas handlers never see them), and the button sits outside the canvas.
 *
 * Dependencies are injected (no globals): `doc`, `parent`, `bus` + `events` (EventBus and Events), `isPlaying()`,
 * `isPaused()`, `togglePause()`.
 */

export const PAUSE_BTN_ID = 'hud-pause-btn';
/** Smallest side of the button in CSS px (the touch target floor; the CSS in index.html sets the same). */
export const PAUSE_BTN_PX = 44;

export class PauseButton {
  /**
   * @param {object} deps
   * @param {boolean}  deps.touch        build only when true
   * @param {Document} deps.doc
   * @param {HTMLElement} deps.parent    where the button goes (document.body: #hud-overlay is a z-10 stacking context)
   * @param {object}   [deps.bus]        EventBus (refreshes on state and pause events)
   * @param {object}   [deps.events]     the Events table
   * @param {function(): boolean} deps.isPlaying   gameplay state (not menu / briefing / shop / game over)
   * @param {function(): boolean} deps.isPaused
   * @param {function(): *} deps.togglePause       InputManager.togglePause (bound)
   */
  constructor(deps = {}) {
    this.el = null;
    this._disposed = false;
    this._unsubs = [];
    this._deps = deps;
    if (!deps.touch || !deps.doc || !deps.parent) return;
    const doc = deps.doc;
    const btn = doc.createElement('button');
    btn.id = PAUSE_BTN_ID;
    btn.type = 'button';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Pause');
    btn.setAttribute('title', 'Pause');
    btn.setAttribute('hidden', '');
    for (let i = 0; i < 2; i++) {
      const bar = doc.createElement('span');
      bar.className = 'hud-pause-bar';
      btn.appendChild(bar);
    }
    // The finger that taps the button is nobody else's: no view drag, no radial, no edge wake from it.
    this._stop = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); };
    this._onClick = (e) => {
      this._stop(e);
      if (this._disposed) return;
      try { btn.blur(); } catch (_e) { /* stub */ }
      if (typeof deps.togglePause === 'function') {
        try { deps.togglePause(); } catch (_e) { /* dep */ }
      }
      this.refresh();
    };
    this._stopEvents = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup'];
    for (const t of this._stopEvents) btn.addEventListener(t, this._stop);
    btn.addEventListener('click', this._onClick);
    deps.parent.appendChild(btn);
    this.el = btn;
    if (deps.bus && deps.events && typeof deps.bus.on === 'function') {
      const E = deps.events;
      // Order of listeners is not ours to rely on: a resume event means "running" even if the flow manager has not
      // cleared its flag yet; a pause-to-menu event hides the button until the state change says where we are.
      const subs = [
        [E.GAME_STATE_CHANGE, () => this.refresh()],
        [E.STATE_CHANGE, () => this.refresh()],
        [E.PAUSE_RESUME, () => this.refresh({ paused: false })],
        [E.PAUSE_MENU, () => this.refresh({ paused: true })],
      ];
      for (const [ev, fn] of subs) {
        if (ev) this._unsubs.push(deps.bus.on(ev, fn));
      }
    }
    this.refresh();
  }

  /**
   * Show the button during play when the game runs; hide it otherwise. Write-on-change.
   * @param {{paused?: boolean}} [force] override the paused flag (resume / menu events outrun the flow manager)
   * @returns {boolean} true when the button is shown
   */
  refresh(force) {
    const btn = this.el;
    if (!btn || this._disposed) return false;
    const d = this._deps;
    const playing = typeof d.isPlaying === 'function' ? !!d.isPlaying() : false;
    const paused = force && typeof force.paused === 'boolean' ? force.paused
      : (typeof d.isPaused === 'function' ? !!d.isPaused() : false);
    const show = playing && !paused;
    if (show === !btn.hasAttribute('hidden')) return show;
    if (show) btn.removeAttribute('hidden'); else btn.setAttribute('hidden', '');
    return show;
  }

  /** @returns {boolean} true when the button is built and showing */
  isShown() { return !!this.el && !this.el.hasAttribute('hidden'); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch (_e) { /* stub bus */ }
    }
    this._unsubs = [];
    const btn = this.el;
    if (btn) {
      for (const t of this._stopEvents) {
        try { btn.removeEventListener(t, this._stop); } catch (_e) { /* stub */ }
      }
      try { btn.removeEventListener('click', this._onClick); } catch (_e) { /* stub */ }
      try { if (btn.parentNode) btn.parentNode.removeChild(btn); } catch (_e) { /* stub */ }
    }
    this.el = null;
  }
}
