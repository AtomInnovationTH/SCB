/**
 * PaneChrome.js — shared "minimize/expand" chrome for HUD panes.
 *
 * Adds a consistent, unobtrusive top-right `[KEY]` badge to an HTML pane and
 * manages a multi-step size cycle so the player can shrink each pane down to
 * only the info they need.
 *
 * Steps are an ordered list of named size states, e.g.:
 *   - 2-step:  ['normal', 'max']
 *   - 3-step:  ['min', 'normal', 'max']
 *
 * The chrome is technology-agnostic about *how* a pane changes size: on each
 * step change it (a) sets `data-pane-step` on the pane element, (b) toggles the
 * classes `pane-step-<name>` so CSS / the pane can react, (c) shows elements
 * tagged `data-pane-show="<name>"` only on that step and hides those tagged
 * `data-pane-hide="<name>"`, and (d) calls the optional `onStep` callback so the
 * pane can re-render (e.g. recompute how many comms lines fit).
 *
 * Interaction:
 *   - Clicking the badge cycles to the next step (wraps).
 *   - Right-clicking the badge steps backward (handy to re-expand quickly).
 *   - Panes whose hotkey is free may also drive `cycle()` from a key handler.
 *
 * No persistence — step state is in-memory and resets each session.
 *
 * @module ui/hud/PaneChrome
 */

/**
 * @typedef {Object} PaneChromeOptions
 * @property {HTMLElement} pane         The pane element to attach chrome to.
 * @property {string}      keyLabel     Short hotkey label, e.g. 'C', 'A', 'Tab'.
 * @property {boolean}     [bracket]    Wrap keyLabel in [ ] (default true). Set
 *                                       false for badge-only panes with no key.
 * @property {string[]}    steps        Ordered step names (>=2). Last = largest.
 * @property {string}      [initial]    Starting step name (default: 'normal' if
 *                                       present, else the middle/first step).
 * @property {string}      [color]      Badge text colour (default green).
 * @property {(step:string, index:number)=>void} [onStep] Called after each change.
 * @property {string}      [title]      Tooltip for the badge.
 */

export class PaneChrome {
  /** @param {PaneChromeOptions} opts */
  constructor(opts) {
    this._pane = opts.pane;
    this._steps = opts.steps && opts.steps.length >= 2 ? opts.steps.slice() : ['normal', 'max'];
    this._onStep = opts.onStep || null;
    this._color = opts.color || '#00ff88';
    this._bracket = opts.bracket !== false;
    this._keyLabel = opts.keyLabel;

    // Resolve the initial step.
    let startName = opts.initial;
    if (!startName) startName = this._steps.includes('normal') ? 'normal' : this._steps[0];
    this._index = Math.max(0, this._steps.indexOf(startName));

    this._badge = this._buildBadge(opts.keyLabel, opts.title, opts.bracket !== false);
    // Avoid overlapping the dormant-keycap ::after glyph (same top-right corner)
    // on panes that opt into the data-activate-key onboarding affordance.
    if (this._pane.dataset && this._pane.dataset.activateKey) {
      this._badge.style.right = '34px';
    }
    this._pane.appendChild(this._badge);

    // Apply the initial step (no callback churn — pane is mid-build, but the
    // callback is generally idempotent; callers can also call refresh()).
    this._apply();
  }

  /** @returns {string} current step name */
  get step() { return this._steps[this._index]; }

  /** @returns {number} current step index */
  get index() { return this._index; }

  /** @returns {boolean} true when on the smallest (first) step */
  get isMinimized() { return this._index === 0; }

  /** Advance to the next step (wraps to the first). */
  cycle() {
    this._index = (this._index + 1) % this._steps.length;
    this._apply();
  }

  /** Step backward (wraps to the last). */
  cycleBack() {
    this._index = (this._index - 1 + this._steps.length) % this._steps.length;
    this._apply();
  }

  /**
   * Jump directly to a named step. No-op if the name is unknown.
   * @param {string} name
   */
  setStep(name) {
    const i = this._steps.indexOf(name);
    if (i < 0) return;
    this._index = i;
    this._apply();
  }

  /** Re-apply the current step (e.g. after the pane re-renders its contents). */
  refresh() { this._apply(); }

  // --------------------------------------------------------------------------
  // PRIVATE
  // --------------------------------------------------------------------------

  /** @private Build the clickable corner badge. */
  _buildBadge(keyLabel, title, bracket) {
    const badge = document.createElement('div');
    badge.className = 'hud-pane-badge';
    badge.textContent = bracket ? `[${keyLabel}]` : keyLabel;
    badge.title = title || `Resize pane — click to cycle, right-click to reverse`;
    Object.assign(badge.style, {
      position: 'absolute',
      top: '5px',
      right: '7px',
      fontFamily: "'Courier New', monospace",
      fontSize: '10px',
      fontWeight: 'bold',
      color: this._color,
      opacity: '0.35',
      letterSpacing: '0.5px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      zIndex: '5',
      transition: 'opacity 0.15s ease',
    });
    badge.addEventListener('mouseenter', () => { badge.style.opacity = '0.9'; });
    badge.addEventListener('mouseleave', () => { badge.style.opacity = '0.35'; });
    badge.addEventListener('click', (e) => { e.stopPropagation(); this.cycle(); });
    badge.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cycleBack();
    });
    return badge;
  }

  /** @private Apply the current step to the pane DOM and notify the pane. */
  _apply() {
    const name = this._steps[this._index];

    // 1) data attribute + per-step class (one active at a time).
    this._pane.dataset.paneStep = name;
    for (const s of this._steps) {
      this._pane.classList.toggle(`pane-step-${s}`, s === name);
    }

    // 2) show/hide tagged children for this step.
    this._pane.querySelectorAll('[data-pane-show]').forEach((el) => {
      el.style.display = (el.dataset.paneShow === name) ? '' : 'none';
    });
    this._pane.querySelectorAll('[data-pane-hide]').forEach((el) => {
      el.style.display = (el.dataset.paneHide === name) ? 'none' : '';
    });

    // 3) let the pane react (recompute layout, line counts, etc.).
    if (this._onStep) this._onStep(name, this._index);

    // 4) badge-only panes (no hotkey) reflect state with a +/− glyph.
    if (!this._bracket && this._badge) {
      this._badge.textContent = this.isMinimized ? '+' : '–';
    }
  }
}

export default PaneChrome;
