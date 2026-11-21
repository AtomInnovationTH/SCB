/**
 * AirPage.js - page 2 of the page row: "Air by height" (plan sky-air-1121, DECISIONS §80 rows 2-3, §81 row 1).
 *
 * Implements the page interface of the page row (master plan sky-1121): `{ id, title, activate, deactivate, update(dtMs), elements }`.
 * It works out what the chart shows (which Sun level, today's Sun in words, a storm's air factor, her height) and owns the
 * `AirChart` (js/ui/AirChart.js). Nothing here reads the game directly: everything comes in through the constructor.
 *
 *   new AirPage({
 *     sunStorms,            // anything with today(): {ms, f107, kp} | null  (the game's `sunStorms` singleton from SunStorms.js)
 *     getShipAltKm,         // () => number | null | undefined, her height in km (null when she has none)
 *     // optional: getViewport () => {w, h}; stormMultiplier (altKm, f107, kp) => number; fontEpoch; parent (HTMLElement)
 *   })
 *
 * "Today" is the Sun on the game's date (`sunStorms.today()`); in training missions 1-3 `today()` is null and "Today" shows the
 * average Sun and says so. A storm day adds one line with the storm's air factor at her height from `stormMultiplier`
 * (SunStorms.js:139, today's Sun level and Kp): never `dayAirMultiplier`, which already holds the Sun's level. No gas split is
 * made up for a storm: the curves stay at the Sun's level.
 *
 * `update` redraws only when the date, the Sun level, the storm, her height (whole km), the screen size, the button or the font
 * epoch changed.
 *
 * @module systems/AirPage
 */

import { stormMultiplier as defaultStormMultiplier, multText } from './SunStorms.js';
import { todaySunWords } from './AirGases.js';
import { AirChart } from '../ui/AirChart.js';
import { fontEpoch as defaultFontEpoch } from '../core/Typeface.js';

const DAY_MS = 86400000;
/** The height the storm line speaks of when she has none. */
export const STORM_DEFAULT_KM = 400;

export class AirPage {
  /** @param {{sunStorms:{today:()=>({ms:number,f107:number,kp:number}|null)}, getShipAltKm?:()=>(number|null|undefined), getViewport?:()=>{w:number,h:number}, stormMultiplier?:function, fontEpoch?:object, parent?:HTMLElement}} deps */
  constructor(deps = {}) {
    this.id = 'air';
    this.title = 'Air by height';
    this._sun = deps.sunStorms || null;
    this._getAlt = typeof deps.getShipAltKm === 'function' ? deps.getShipAltKm : () => null;
    this._getViewport = typeof deps.getViewport === 'function' ? deps.getViewport : null;
    this._storm = typeof deps.stormMultiplier === 'function' ? deps.stormMultiplier : defaultStormMultiplier;
    this._fontEpoch = deps.fontEpoch || defaultFontEpoch;
    this._mode = 'today';
    this._active = false;
    this._key = null;
    /** Times the chart was asked to draw (tests, probes). */
    this.drawCount = 0;
    this.chart = new AirChart({ onMode: (id) => this.setMode(id), fontEpoch: this._fontEpoch, parent: deps.parent });
  }

  /** @returns {'low'|'mean'|'high'|'today'} the button that is down */
  getMode() { return this._mode; }

  /** Press a Sun button. Unknown ids are ignored. @returns {string} the mode */
  setMode(id) {
    if (id === 'low' || id === 'mean' || id === 'high' || id === 'today') {
      if (id !== this._mode) { this._mode = id; this._key = null; }
    }
    if (this._active) this._draw();
    return this._mode;
  }

  /** @returns {boolean} true while the page is shown */
  isActive() { return this._active; }

  activate() {
    this._active = true;
    this.chart.show();
    this._key = null;
    this._draw();
  }

  deactivate() {
    this._active = false;
    this.chart.hide();
  }

  /** Called each frame while active. @param {number} _dtMs */
  update(_dtMs) {
    if (!this._active) return;
    this._draw();
  }

  /** @returns {HTMLElement[]} the page's top-level DOM nodes */
  elements() {
    const r = this.chart.root();
    return r ? [r] : [];
  }

  dispose() { this._active = false; this.chart.dispose(); }

  /** Today's Sun and storm, or null in training / before the game has a date. */
  _today() {
    const t = this._sun && typeof this._sun.today === 'function' ? this._sun.today() : null;
    return t && Number.isFinite(t.f107) ? t : null;
  }

  _alt() {
    const a = this._getAlt();
    return Number.isFinite(a) ? a : null;
  }

  /**
   * What the chart is told to show now.
   * @returns {{mode:string, curveLevel:(string|number), todayLevel:(string|number), todayLine:string, todaySub:(string|null), stormLine:(string|null), shipAltKm:(number|null), storm:(null|{kp:number,factor:number,altKm:number})}}
   */
  model() {
    const t = this._today();
    const alt = this._alt();
    const todayLevel = t ? t.f107 : 'mean';
    const curveLevel = this._mode === 'today' ? todayLevel : this._mode;
    const todayLine = t ? `Today's Sun: ${todaySunWords(t.f107)}` : 'Training: average Sun';
    const todaySub = t && Number.isFinite(t.ms) ? `Game date ${new Date(t.ms).toISOString().slice(0, 10)}` : null;
    let storm = null;
    let stormLine = null;
    if (t && t.kp >= 5) {
      const altKm = alt !== null ? alt : STORM_DEFAULT_KM;
      const factor = this._storm(altKm, t.f107, t.kp);
      storm = { kp: t.kp, factor, altKm };
      stormLine = `A storm is on today: at ${Math.round(altKm)} km the air is ${multText(factor)} times thicker than on a calm day with this Sun.`;
    }
    return { mode: this._mode, curveLevel, todayLevel, todayLine, todaySub, stormLine, shipAltKm: alt, storm };
  }

  _viewport() {
    const v = this._getViewport ? this._getViewport() : null;
    if (v && v.w > 0 && v.h > 0) return { wPx: v.w, hPx: v.h };
    return typeof window !== 'undefined' ? { wPx: window.innerWidth, hPx: window.innerHeight } : { wPx: 1280, hPx: 720 };
  }

  _draw() {
    // The change key comes from the raw inputs only; strings, the date and the storm factor are built only when it changed.
    const t = this._today();
    const alt = this._alt();
    const vp = this._viewport();
    const epoch = this._fontEpoch && typeof this._fontEpoch.value === 'function' ? this._fontEpoch.value() : 0;
    const key = [
      this._mode, t ? Math.floor(t.ms / DAY_MS) : 'none', t ? t.f107.toFixed(2) : '-', t ? t.kp : '-',
      alt === null ? '-' : Math.round(alt), `${vp.wPx}x${vp.hPx}`, epoch,
    ].join('|');
    if (key === this._key) return;
    this._key = key;
    this.drawCount++;
    this.chart.render(this.model(), vp);
  }
}
