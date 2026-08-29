/**
 * RailIndicator.js — the Zoom Ladder rail indicator STUB (S2, M1 skeleton).
 *
 * Right-edge, 7 notches labelled with instrument names + a spring-charge fill,
 * driven by LadderController from `ladder.getState()` / charge decisions
 * (docs/ladder/00-spec.md §10, VisualLaw.RAIL). This is the S2 stub only:
 * NO costumes, NO time-warp readout, NO subject-name / re-aim UI, NO clickable
 * notches or drag-scrub — those are S4+. It shows the current floor and the
 * charge fill so the spring-charged F4↔F5 crossing is legible in-game.
 *
 * Fully DOM-guarded so it is inert (and constructible) in headless tests.
 *
 * @module ui/RailIndicator
 */

import { FloorContract } from '../core/FloorContract.js';
import { VisualLaw } from '../core/VisualLaw.js';

export class RailIndicator {
  constructor() {
    this._root = null;
    this._notches = [];   // per-floor { el, fill } (index 0 = F1)
    this._visible = false;
    this._built = false;
  }

  /** Lazily build the DOM (idempotent, no-op headless). @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;

    const root = document.createElement('div');
    root.id = 'ladder-rail';
    root.style.cssText = [
      'position:absolute', 'top:50%', 'right:10px', 'transform:translateY(-50%)',
      'display:flex', 'flex-direction:column-reverse', 'gap:6px',
      'font-family:"Courier New",monospace', 'font-size:0.6rem', 'letter-spacing:0.08em',
      'z-index:35', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');

    // column-reverse so F1 sits at the bottom, F7 at the top (elevator order).
    for (const f of FloorContract.FLOORS) {
      const notch = document.createElement('div');
      notch.style.cssText = [
        'position:relative', 'min-width:96px', 'padding:3px 8px',
        'border:1px solid rgba(0,255,136,0.25)', 'border-radius:3px',
        'background:rgba(0,20,40,0.6)', 'color:rgba(0,255,136,0.5)',
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
      this._notches[f.id - 1] = { el: notch, fill };
    }

    document.body.appendChild(root);
    this._root = root;
  }

  /** Show the rail (builds on first show). */
  show() {
    this._build();
    this._visible = true;
    if (this._root) this._root.style.opacity = '1';
  }

  /** Hide the rail. */
  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
  }

  /**
   * Refresh from a ZoomLadder state snapshot (docs/ladder/06-core-api.md).
   * Named `refresh` (not `update`) because it is driven by LadderController from
   * ladder state, not ticked directly by the main loop.
   * @param {{floor:number, charge:number, chargeSide:('up'|'down'|null)}} state
   */
  refresh(state) {
    if (!this._root || !state) return;
    for (let i = 0; i < this._notches.length; i++) {
      const n = this._notches[i];
      if (!n) continue;
      const current = (i + 1) === state.floor;
      n.el.style.borderColor = current ? VisualLaw.COLORS.PLAYER : 'rgba(0,255,136,0.25)';
      n.el.style.color = current ? VisualLaw.COLORS.PLAYER : 'rgba(0,255,136,0.5)';
      // Charge fill decorates the notch we are pushing toward (the destination).
      let pct = 0;
      if (state.chargeSide && current) pct = 0;
      if (state.chargeSide === 'up' && (i + 1) === state.floor + 1) pct = state.charge * 100;
      if (state.chargeSide === 'down' && (i + 1) === state.floor - 1) pct = state.charge * 100;
      n.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
  }

  /** Brief denied feedback (hard wall). Stub: flash the current notch. */
  flashDenied(_hint) {
    // S4+: show the hint text; for M1 the stub simply no-ops beyond the fill.
  }
}
