/**
 * PaneChrome.js — shared "minimize/expand" chrome for HUD panes.
 *
 * Adds a top-right `[KEY]` badge to an HTML pane and manages a multi-step size cycle (an ordered list of named size
 * states, e.g. 2-step ['normal', 'max'], 3-step ['min', 'normal', 'max']).
 *
 * The chrome is agnostic about *how* a pane changes size: on each step change it (a) sets `data-pane-step` on the pane,
 * (b) toggles the classes `pane-step-<name>`, (c) shows elements tagged `data-pane-show="<name>"` only on that step and
 * hides those tagged `data-pane-hide="<name>"`, and (d) calls the optional `onStep` callback so the pane can re-render.
 *
 * Clicking the badge cycles to the next step (wraps); right-click steps backward. Panes whose hotkey is free may also
 * drive `cycle()` from a key handler. No persistence — step state is in-memory and resets each session.
 *
 * @module ui/hud/PaneChrome
 */

/**
 * @typedef {Object} PaneChromeOptions
 * @property {HTMLElement} pane         The pane element to attach chrome to.
 * @property {string}      keyLabel     Short hotkey label, e.g. '7', '0'.
 * @property {boolean}     [bracket]    Wrap keyLabel in [ ] (default true). Set
 *                                       false for badge-only panes with no key.
 * @property {string[]}    steps        Ordered step names (>=2). Last = largest.
 * @property {string}      [initial]    Starting step name (default: 'normal' if
 *                                       present, else the middle/first step).
 * @property {string}      [color]      Badge text colour (default green).
 * @property {(step:string, index:number)=>void} [onStep] Called after each change.
 * @property {string}      [title]      Tooltip for the badge.
 * @property {boolean}     [badge]      Build the corner badge (default true). Set false for a pane with no visible key
 *                                       text: the step cycle still works through cycle() / setStep().
 */

export class PaneChrome {
  /** @param {PaneChromeOptions} opts */
  constructor(opts) {
    this._pane = opts.pane;
    this._steps = opts.steps && opts.steps.length >= 2 ? opts.steps.slice() : ['normal', 'max'];
    this._onStep = opts.onStep || null;
    this._color = opts.color || 'var(--hud-normal, #00ff88)';
    this._bracket = opts.bracket !== false;
    this._keyLabel = opts.keyLabel;

    let startName = opts.initial;
    if (!startName) startName = this._steps.includes('normal') ? 'normal' : this._steps[0];
    this._index = Math.max(0, this._steps.indexOf(startName));

    // `badge: false` builds no badge element at all.
    this._badge = opts.badge === false
      ? null
      : this._buildBadge(opts.keyLabel, opts.title, opts.bracket !== false);
    if (this._badge) this._pane.appendChild(this._badge);

    // Apply the initial step (the callback is generally idempotent; callers can also call refresh()).
    this._apply();
  }

  get step() { return this._steps[this._index]; }

  get index() { return this._index; }

  /** @returns {boolean} true when on the smallest (first) step */
  get isMinimized() { return this._index === 0; }

  cycle() {
    this._index = (this._index + 1) % this._steps.length;
    this._apply();
  }

  cycleBack() {
    this._index = (this._index - 1 + this._steps.length) % this._steps.length;
    this._apply();
  }

  /** Jump directly to a named step. No-op if the name is unknown. */
  setStep(name) {
    const i = this._steps.indexOf(name);
    if (i < 0) return;
    this._index = i;
    this._apply();
  }

  /** Re-apply the current step (e.g. after the pane re-renders its contents). */
  refresh() { this._apply(); }

  _buildBadge(keyLabel, title, bracket) {
    const badge = document.createElement('div');
    badge.className = 'hud-pane-badge';
    badge.textContent = bracket ? `[${keyLabel}]` : keyLabel;
    badge.title = title || `Resize pane. Click to cycle, right-click to reverse`;
    Object.assign(badge.style, {
      position: 'absolute',
      top: '5px',
      right: '7px',
      fontFamily: "var(--font-mono)",
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

  _apply() {
    const name = this._steps[this._index];

    this._pane.dataset.paneStep = name;
    for (const s of this._steps) {
      this._pane.classList.toggle(`pane-step-${s}`, s === name);
    }

    this._pane.querySelectorAll('[data-pane-show]').forEach((el) => {
      el.style.display = (el.dataset.paneShow === name) ? '' : 'none';
    });
    this._pane.querySelectorAll('[data-pane-hide]').forEach((el) => {
      el.style.display = (el.dataset.paneHide === name) ? 'none' : '';
    });

    if (this._onStep) this._onStep(name, this._index);

    if (!this._bracket && this._badge) {
      this._badge.textContent = this.isMinimized ? '+' : '–';
    }
  }
}

export default PaneChrome;
