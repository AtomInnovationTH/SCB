/**
 * TestsPane.js — the "Tests" fold-out: one closed header button, and behind it
 * the developer extras (today the sound list).
 *
 * u6-tests-plain D2 (2026-10-19). Built ONLY when the Tests switch is on
 * (`?tests=1`, or the old `?sounds=1`; see TestsSwitch.js); otherwise inert, no
 * DOM. `#hud-tests-pane` sits where the sound list sat (left edge = MOTHER's,
 * bottom 176 px, z-index 60) on every floor and the ride. CLOSED at every load:
 * one `Tests ▸` button (44 px tall, takes taps); a tap toggles `Tests ▾` and
 * the body. The body holds the sound list, rendered by SoundLogPane into it.
 *
 * @module ui/hud/TestsPane
 */

import { PANE_CORNER_PX } from '../RailGeometry.js';
import { testsRequested } from './TestsSwitch.js';
import { SoundLogPane } from './SoundLogPane.js';

export const TESTS_PANE_ID = 'hud-tests-pane';
export const TESTS_BUTTON_MIN_PX = 44;
export const TESTS_CLOSED_LABEL = 'Tests \u25B8';
export const TESTS_OPEN_LABEL = 'Tests \u25BE';

export class TestsPane {
  /**
   * @param {HTMLElement} parent
   * @param {{ search?:string, doc?:Document, log?:object, now?:()=>number, timer?:boolean }} [opts]
   */
  constructor(parent, opts = {}) {
    this.el = null;
    this.button = null;
    this.body = null;
    this.soundLog = null;
    this.open = false;
    // Read once at construction (never at import) so tests can set it.
    const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.requested = testsRequested(search);
    const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!parent || !doc || !this.requested) return;

    const el = doc.createElement('div');
    el.id = TESTS_PANE_ID;
    Object.assign(el.style, {
      position: 'absolute', left: `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`, bottom: '176px', maxWidth: '520px',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      color: 'var(--hud-normal, #9fd)', fontFamily: 'var(--font-mono)', fontSize: '11px',
      pointerEvents: 'none', zIndex: '60',
    });
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = TESTS_CLOSED_LABEL;
    button.setAttribute('aria-expanded', 'false');
    Object.assign(button.style, {
      minHeight: `${TESTS_BUTTON_MIN_PX}px`, padding: '0 12px', pointerEvents: 'auto',
      background: 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.55)', color: 'inherit', border: '1px solid currentColor',
      fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer',
    });
    const body = doc.createElement('div');
    body.setAttribute('aria-hidden', 'true');
    Object.assign(body.style, {
      display: 'none', padding: '6px 8px', background: 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.55)',
      lineHeight: '1.35', whiteSpace: 'pre', pointerEvents: 'none',
    });
    el.appendChild(body);   // body above the button: it grows upward from the fixed bottom
    el.appendChild(button);
    parent.appendChild(el);
    this.el = el;
    this.button = button;
    this.body = body;
    this._onClick = () => this.toggle();
    button.addEventListener('click', this._onClick);
    this.soundLog = new SoundLogPane(parent, { ...opts, search, doc, into: body });
  }

  isOpen() { return this.open; }

  setOpen(on) {
    if (!this.el) return;
    this.open = !!on;
    this.body.style.display = this.open ? 'block' : 'none';
    this.body.setAttribute('aria-hidden', this.open ? 'false' : 'true');
    this.button.textContent = this.open ? TESTS_OPEN_LABEL : TESTS_CLOSED_LABEL;
    this.button.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    if (this.open && this.soundLog) this.soundLog.refresh();
  }

  toggle() { this.setOpen(!this.open); }

  dispose() {
    if (this.soundLog) this.soundLog.dispose();
    this.soundLog = null;
    if (this.button && this._onClick) this.button.removeEventListener('click', this._onClick);
    if (this.el) this.el.remove();
    this.el = this.button = this.body = null;
  }
}
