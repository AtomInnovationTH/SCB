/**
 * SoundLogPane.js — dev pane: the last 10 sounds, newest at the bottom.
 *
 * DECISIONS §15 row 10. Built ONLY when the URL has `?sounds=1` (a plain query
 * parameter, not a feature flag). A mono-face list bottom-left above the footer
 * band, pointer-events none; oldest line on top so new sounds push the list up.
 * One line each: `2.4s  terminal blip ×4 — <meaning>`. Own 4 Hz timer; no input,
 * no persistence.
 *
 * @module ui/hud/SoundLogPane
 */

import { soundLog, plainName } from '../../systems/audio/SoundLog.js';
import { PANE_CORNER_PX } from '../RailGeometry.js';

export const SOUND_LOG_PANE_ID = 'hud-sound-log';
export const SOUND_LOG_REFRESH_MS = 250;

/** True when `search` (a location.search string) carries `sounds=1`. */
export function soundsRequested(search) {
  try { return new URLSearchParams(search || '').get('sounds') === '1'; } catch (_e) { return false; }
}

export class SoundLogPane {
  /**
   * @param {HTMLElement} parent
   * @param {{ log?:object, search?:string, doc?:Document, now?:()=>number, timer?:boolean }} [opts]
   */
  constructor(parent, opts = {}) {
    this.log = opts.log || soundLog;
    this.now = opts.now || (() => performance.now() / 1000);
    this.el = null;
    this._timer = null;
    const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!parent || !doc || !soundsRequested(search)) return;
    const el = doc.createElement('div');
    el.id = SOUND_LOG_PANE_ID;
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'absolute', left: `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`, bottom: '176px', maxWidth: '520px',   // followups-1018 D4: left edge = the MOTHER pane's
      padding: '6px 8px', background: 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.55)', color: 'var(--hud-normal, #9fd)',
      fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.35', whiteSpace: 'pre',
      pointerEvents: 'none', zIndex: '60',
    });
    parent.appendChild(el);
    this.el = el;
    this.refresh();
    if (opts.timer !== false) this._timer = setInterval(() => this.refresh(), SOUND_LOG_REFRESH_MS);
  }

  /** Lines for the current log, oldest first (newest last). */
  lines() {
    const t = this.now();
    return this.log.entries.map((e) => {
      const age = Math.max(0, t - e.t).toFixed(1);
      const x = e.count > 1 ? ` \u00d7${e.count}` : '';
      return `${age}s  ${plainName(e.name)}${x} \u2014 ${e.meaning}`;
    });
  }

  refresh() {
    if (this.el) this.el.textContent = this.lines().join('\n');
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.el) this.el.remove();
    this.el = null;
  }
}
