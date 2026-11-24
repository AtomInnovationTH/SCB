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
 * "Today" is the Sun on the game's date (`sunStorms.today()`); in training missions 1-3 `today()` is null and the page has no today at all (Sky 31, DECISIONS §103 row 7:
 * the "Today" button and the "Training: average Sun" line are gone; the Average Sun button is down on arrival, before: the Today button, which showed the average Sun in
 * training and today's own F10.7 with a game date). With a date the dashed line, its "Today" words and the "Today's Sun: ..." note stay. A storm day adds one line with the storm's air factor at her height from `stormMultiplier`
 * (SunStorms.js:139, today's Sun level and Kp): never `dayAirMultiplier`, which already holds the Sun's level. No gas split is
 * made up for a storm: the curves stay at the Sun's level.
 *
 * `update` redraws only when the date, the Sun level, the storm, her height (whole km), the screen size, the button or the font
 * epoch changed.
 *
 * @module systems/AirPage
 */

import { stormMultiplier as defaultStormMultiplier, multText } from './SunStorms.js';
import { todaySunWords, totalDensity } from './AirGases.js';
import { AirChart, DEFAULT_SUN_MODE } from '../ui/AirChart.js';
import { fontEpoch as defaultFontEpoch } from '../core/Typeface.js';
import { Constants } from '../core/Constants.js';
import { atmosphericDensityBase, atmosphericDragOn } from '../entities/OrbitalMechanics.js';
import { referenceDragAreaM2 } from '../entities/MotherDragArea.js';

const DAY_MS = 86400000;
/** The height the storm line speaks of when she has none. */
export const STORM_DEFAULT_KM = 400;

/** A number in the plain way a person says it: 1.5, 2, 40, 300 (one figure, or a half step while the first figure is 1). */
function niceNumber(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const step = m < 2 ? p / 2 : p;
  const r = Math.round(v / step) * step;
  return Number.isInteger(r) ? String(r) : String(Math.round(r * 10) / 10);
}

/**
 * How much thinner the air is than at sea level (1.225 kg/m3), in words: "about 100 billion times thinner than at sea level".
 * @param {number} rho air density here, kg/m3 @returns {string}
 */
export function thinnerWords(rho) {
  const ratio = atmosphericDensityBase(0) / rho;
  if (!(ratio > 1)) return 'Air here is as thick as at sea level.';
  const units = [[1e15, 'quadrillion'], [1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const [size, name] = units.find(([s]) => ratio >= s) || [1, ''];
  return `Air here is about ${niceNumber(ratio / size)}${name ? ' ' + name : ''} times thinner than at sea level.`;
}

/**
 * How far the game's drag sinks her in a day at this height and air density, km. The game's own law (OrbitPane.referenceSinkKmPerRealS:
 * da/dt = 2 a drag / v for her reference area and start mass), run on the chosen curve's density instead of today's.
 * @param {number} altKm @param {number} rho air density here, kg/m3 @returns {number} km per day
 */
export function sinkKmPerDay(altKm, rho) {
  const a = Constants.EARTH_RADIUS_KM + altKm;
  const v = Math.sqrt(Constants.MU_EARTH / a);
  const decel = atmosphericDragOn(altKm, v, referenceDragAreaM2(), Constants.MOTHER_DRAG.MASS_KG, rho / atmosphericDensityBase(altKm));
  return 2 * decel * a / v * 86400;
}

/** "She sinks about 1.7 km a day with this Sun." (metres under 1 km) */
export function sinkWords(kmPerDay) {
  if (!(kmPerDay > 0)) return null;
  if (kmPerDay >= 1) return `She sinks about ${kmPerDay >= 10 ? Math.round(kmPerDay) : (Math.round(kmPerDay * 10) / 10)} km a day with this Sun.`;
  const m = kmPerDay * 1000;
  return m < 1 ? 'She sinks less than a metre a day with this Sun.' : `She sinks about ${niceNumber(m)} metres a day with this Sun.`;
}

export class AirPage {
  /** @param {{sunStorms:{today:()=>({ms:number,f107:number,kp:number}|null)}, getShipAltKm?:()=>(number|null|undefined), getFieldBands?:()=>(Array<{altKm:number[]}>|null|undefined), getStationKm?:()=>(number|null|undefined), getViewport?:()=>{w:number,h:number}, stormMultiplier?:function, fontEpoch?:object, parent?:HTMLElement}} deps */
  constructor(deps = {}) {
    this.id = 'air';
    this.title = 'Air by height';
    this._sun = deps.sunStorms || null;
    this._getAlt = typeof deps.getShipAltKm === 'function' ? deps.getShipAltKm : () => null;
    this._getBands = typeof deps.getFieldBands === 'function' ? deps.getFieldBands : () => null;
    this._getStation = typeof deps.getStationKm === 'function' ? deps.getStationKm : () => null;
    /** Read when the page opens (the catalogue is loaded by then); read again then if it was empty. */
    this._bandsKm = null;
    this._stationKm = null;
    this._getViewport = typeof deps.getViewport === 'function' ? deps.getViewport : null;
    this._storm = typeof deps.stormMultiplier === 'function' ? deps.stormMultiplier : defaultStormMultiplier;
    this._fontEpoch = deps.fontEpoch || defaultFontEpoch;
    this._mode = DEFAULT_SUN_MODE;
    this._active = false;
    this._key = null;
    /** Times the chart was asked to draw (tests, probes). */
    this.drawCount = 0;
    this.chart = new AirChart({ onMode: (id) => this.setMode(id), fontEpoch: this._fontEpoch, parent: deps.parent });
  }

  /** @returns {'low'|'mean'|'high'} the button that is down */
  getMode() { return this._mode; }

  /** Press a Sun button. Unknown ids are ignored. @returns {string} the mode */
  setMode(id) {
    if (id === 'low' || id === 'mean' || id === 'high') {
      if (id !== this._mode) { this._mode = id; this._key = null; }
    }
    if (this._active) this._draw();
    return this._mode;
  }

  /** @returns {boolean} true while the page is shown */
  isActive() { return this._active; }

  activate() {
    this._active = true;
    this._readMarks();
    this.chart.show();
    this._key = null;
    this._draw();
  }

  /** Her debris-field heights and the space station's height, read once the page opens (the catalogue may not have been there before). */
  _readMarks() {
    if (!this._bandsKm) {
      const fb = this._getBands();
      const km = Array.isArray(fb) ? fb.map((b) => b && b.altKm).filter((a) => Array.isArray(a) && a.length === 2 && a[1] > a[0]) : [];
      if (km.length) this._bandsKm = km;
    }
    if (this._stationKm === null) {
      const s = this._getStation();
      if (Number.isFinite(s)) this._stationKm = s;
    }
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
   * @returns {{mode:string, curveLevel:string, todayLevel:(string|number|null), todayLine:string, todaySub:(string|null), stormLine:(string|null), shipAltKm:(number|null), storm:(null|{kp:number,factor:number,altKm:number})}}
   */
  model() {
    const t = this._today();
    const alt = this._alt();
    const todayLevel = t ? t.f107 : null;                // no date (training): no today at all
    const curveLevel = this._mode;
    const todayLine = t ? `Today's Sun: ${todaySunWords(t.f107)}` : '';
    const todaySub = t && Number.isFinite(t.ms) ? `Game date ${new Date(t.ms).toISOString().slice(0, 10)}` : null;
    let storm = null;
    let stormLine = null;
    if (t && t.kp >= 5) {
      const altKm = alt !== null ? alt : STORM_DEFAULT_KM;
      const factor = this._storm(altKm, t.f107, t.kp);
      storm = { kp: t.kp, factor, altKm };
      stormLine = `A storm is on today: at ${Math.round(altKm)} km the air is ${multText(factor)} times thicker than on a calm day with this Sun.`;
    }
    // What the air is like at her height, on the chosen curve: how thin, and how fast it sinks her (the game's own drag law).
    let hereLines = [];
    if (alt !== null && alt >= 100 && alt <= 900) {
      const rho = totalDensity(alt, curveLevel);
      if (rho > 0) hereLines = [thinnerWords(rho), sinkWords(sinkKmPerDay(alt, rho))].filter(Boolean);
    }
    return {
      mode: this._mode, curveLevel, todayLevel, todayLine, todaySub, stormLine, shipAltKm: alt, storm,
      hereLines, fieldBandsKm: this._bandsKm, stationKm: this._stationKm,
    };
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
