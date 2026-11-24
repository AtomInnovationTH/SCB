/**
 * AirChart.js - page 2 of the page row: "Air by height", a flat chart of the air from 100 to 900 km (plan sky-air-1121, DECISIONS §80
 * rows 2-3, §81 row 1).
 *
 * Height on the vertical axis (100 km at the bottom, 900 at the top, a tick every 100 km), air density on a log horizontal axis (kg per
 * cubic metre). Four curves at the chosen Sun level: the whole air (bold, off-white), oxygen atoms, nitrogen (N2), helium; the whole
 * air at the other two Sun levels as faint lines; today's whole air as a dashed line when the game has a date. Three buttons:
 * Quiet Sun, Average Sun, Busy Sun (Sky 31, DECISIONS §103 row 7: no "Today" button, no "Other Sun levels" key line, no "Training: average Sun" note and no footer;
 * Average Sun is down on arrival). A line at her height.
 *
 * Built like SdaChart: a full-screen 2D canvas, painted only when its frame signature changes, constructible in Node (no DOM: `render`
 * still computes and returns the frame, `painted` is false). Unlike SdaChart it has its own opaque dark backdrop (a container div), so
 * nothing behind it shows through, and three real <button>s for the Sun level (44 px or taller, touch-friendly).
 *
 * `buildFrame(model, wPx, hPx)` is pure: everything drawn is in its result, so tests read the frame instead of pixels.
 *
 * @module ui/AirChart
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { mono, fontEpoch as defaultFontEpoch } from '../core/Typeface.js';
import { totalDensity, gasDensity, oxygenAtomsDensity, ROW0_KM, ROW_TOP_KM, LEVEL_F107 } from '../systems/AirGases.js';
import { DOTS_BOTTOM_PX, DOT_TARGET_PX, TITLE_TOP_PX, TITLE_H_PX } from './PageRow.js';

/**
 * What page 2 keeps clear (CSS px). The page row's dots stand at the bottom (hit boxes from DOTS_BOTTOM_PX up to DOTS_BOTTOM_PX + DOT_TARGET_PX from the bottom edge: h-148..h-100 since
 * Sky 31, the same height on the globe, page 1 and page 2), so nothing of the chart may reach below
 * `h - PAGE_ROW_CLEAR_PX` (the x axis title included; the footer that stood below the dots is gone, §103 row 7). Sky 20 (owner 2026-11-23): the page title now stands at the TOP centre (PageRow
 * TITLE_TOP_PX, TITLE_H_PX tall) and the time-speed panel is not on this page, so the chart has no heading of its own, its subtitle and
 * Sun buttons move up under the title, and the plot is centred on the screen with a key on its left and the Sun words on its right.
 */
export const PAGE_ROW_CLEAR_PX = DOTS_BOTTOM_PX + DOT_TARGET_PX + 8;
/** The widest height label ("900 km" at SIZE.small, 0.6 em per glyph) and its gap to the axis. */
const Y_LABEL_W = 6 * 13 * 0.6 + 8;
/** The two side columns (the line key on the left, today's Sun and a storm on the right): width and gap to the height labels. */
export const SIDE_W = 250;
export const SIDE_GAP = 24;

/** The three buttons, left to right (Sky 31: "Today" is gone; today's Sun stays as the dashed line and its words when the game has a date). */
export const SUN_BUTTONS = Object.freeze([
  { id: 'low', label: 'Quiet Sun' },
  { id: 'mean', label: 'Average Sun' },
  { id: 'high', label: 'Busy Sun' },
]);
/** The button that is down when the page opens. */
export const DEFAULT_SUN_MODE = 'mean';
/** Words for each table key (also the top-of-chart labels of the whole-air lines). */
export const SUN_WORDS = Object.freeze({ low: 'Quiet Sun', mean: 'Average Sun', high: 'Busy Sun' });
/*
 * The page's footer is gone (owner 2026-11-24 22:10Z, DECISIONS §103 row 7: "remove modeled..."). Its words, kept here as the source note: "Modelled, fitted to satellite data
 * (NRLMSISE-00, ECSS-E-ST-10-04C tables)" (plain text, no link, §56 row 2).
 */
export const AIR_TITLE = 'Air by height';
export const AIR_SUBTITLE = 'How thick the air is from 100 to 900 km, for a quiet, an average and a busy Sun';
/** The gas curves, drawn over the whole air: key in AirGases, words, colour (calm; the words carry the meaning too), dash (nitrogen is dashed so it shows where it runs under oxygen). */
export const CURVES = Object.freeze([
  { id: 'total', label: 'All the air' },
  { id: 'nO', label: 'Oxygen atoms', color: '#f0a24f' },
  { id: 'nN2', label: 'Nitrogen', color: '#5aa6f2', dash: Object.freeze([10, 6]) },
  { id: 'nHe', label: 'Helium', color: '#93d6a3' },
]);
/** The whole-air lines of the other Sun levels: faint, but visible. */
const FAINT_COLOR = 'rgba(238, 242, 247, 0.55)';
const FAINT_WIDTH = 1.75;

/** Horizontal axis: 1e-17 .. 1e-6 kg/m3 (11 decades). */
export const X_MIN_EXP = -17;
export const X_MAX_EXP = -6;
export const Y_MIN_KM = ROW0_KM;
export const Y_MAX_KM = ROW_TOP_KM;
/** Buttons are at least this tall (CSS px): a fingertip on the iPad. */
export const BUTTON_MIN_H = 46;
/** Type sizes, CSS px (the 10 px of the floor 5 chart, 25 % bigger: §32). */
export const SIZE = Object.freeze({ title: 22, sub: 14, body: 15, small: 13 });

const BACKDROP = '#060b14';
const OFF_WHITE = '#eef2f7';
const TEXT = 'rgba(214, 224, 236, 0.92)';
const TEXT_DIM = 'rgba(176, 192, 212, 0.78)';
const GRID = 'rgba(150, 176, 206, 0.13)';
const PLOT_BG = 'rgba(14, 24, 40, 0.9)';
const HERE = VisualLaw.COLORS.INFO;
/** The faint marks (debris-field bands, space station): a tint across the plot, a bar and tick at the right edge, dim words. */
const BAND_FILL = 'rgba(190, 200, 230, 0.055)';
const BAND_BAR = 'rgba(190, 200, 230, 0.45)';
const BAND_TICK = 'rgba(190, 200, 230, 0.8)';
const MARK_TEXT = 'rgba(176, 192, 212, 0.7)';
const STEP_KM = 10;
const LABEL_ROWS = 4;
/** Row pitch of the labels above the plot: a label is 16 px tall, so rows are 8 px apart. */
export const LABEL_ROW_PX = 24;
export const LABEL_H = 16;
/** A label box starts this far right of its leader line, so two leaders on the same x (today's Sun equal to a table's) both show. */
export const LABEL_OFFSET = 2;

/** Approximate text width when there is no canvas (Node): B612 Mono is 0.6 em wide. */
const approxWidth = (s, px) => String(s).length * px * 0.6;

/**
 * Where everything goes, CSS px, for a screen.
 * @param {number} wPx @param {number} hPx
 */
export function layoutChart(wPx, hPx) {
  const left = 24;
  // The plot is centred on the screen: the same width of key / words stands on each side of it.
  const x0 = Math.ceil(left + SIDE_W + SIDE_GAP + Y_LABEL_W);
  const x1 = Math.max(x0 + 200, wPx - x0);
  const subY = TITLE_TOP_PX + TITLE_H_PX + 20;   // under the page title (top centre), left aligned
  const btnTop = subY + 12;
  const btnH = BUTTON_MIN_H;
  const y0 = btnTop + btnH + 12 + LABEL_ROWS * LABEL_ROW_PX;
  const y1 = Math.max(y0 + 200, hPx - PAGE_ROW_CLEAR_PX - 44);   // the x axis title sits 40 px under y1 (baseline)
  const buttons = [];
  let bx = left;
  for (const b of SUN_BUTTONS) {
    const w = Math.round(b.label.length * 9.4 + 34);
    buttons.push({ id: b.id, label: b.label, x: bx, y: btnTop, w, h: btnH });
    bx += w + 10;
  }
  return {
    wPx, hPx, left, subY, buttons,
    plot: { x0, x1, y0, y1 },
    panel: { x: left, y: y0, w: SIDE_W },                 // the line key, left of the height labels
    panelR: { x: x1 + SIDE_GAP, y: y0, w: SIDE_W },       // today's Sun and a storm, right of the plot
    labelBaseY: y0 - 8,
    xTickY: y1 + 18,
    xTitleY: y1 + 40,
  };
}

/** Plot x of a density (kg/m3), unclipped. */
export function xOfDensity(geom, rho) {
  const { x0, x1 } = geom.plot;
  return x0 + (Math.log10(rho) - X_MIN_EXP) / (X_MAX_EXP - X_MIN_EXP) * (x1 - x0);
}

/** Plot y of a height (km). */
export function yOfKm(geom, km) {
  const { y0, y1 } = geom.plot;
  return y1 - (km - Y_MIN_KM) / (Y_MAX_KM - Y_MIN_KM) * (y1 - y0);
}

/** One curve as screen points, 100..900 km every 10 km (bottom to top). */
export function curvePoints(geom, curveId, level) {
  const pts = [];
  for (let km = Y_MIN_KM; km <= Y_MAX_KM + 1e-9; km += STEP_KM) {
    const rho = curveId === 'total' ? totalDensity(km, level)
      : curveId === 'nO' ? oxygenAtomsDensity(km, level) : gasDensity(curveId, km, level);
    pts.push([xOfDensity(geom, rho), yOfKm(geom, km), km, rho]);
  }
  return pts;
}

const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** "10⁻¹²" for a decade (superscript minus and digits). */
function decadeLabel(exp) { return '10' + String(exp).split('').map((c) => SUPERSCRIPT[c]).join(''); }

/** Break a string into lines no wider than `maxW` (measure(s) gives a width). */
export function wrapText(text, maxW, measure) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && measure(t) > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Rows for the labels above the plot. Each label is a box that starts at its leader line `x` and runs right `w` px; its leader
 * drops from the label straight to the plot. Working from the right, a label that would sit within `gap` px of a label to its right
 * goes one row ABOVE it (rows are LABEL_ROW_PX apart, so boxes in different rows are at least 8 px apart as well), and its own leader
 * then never crosses a box: the boxes to its right start further right, the ones to its left sit higher or further left.
 * @param {Array<{text:string,x:number,w:number}>} labels any order
 * @returns {Array<object>} the labels, left to right, with `row` (0 = nearest the plot) or -1 when it would need more than LABEL_ROWS rows
 */
export function layoutTopLabels(labels, gap = 8) {
  const byX = labels.slice().sort((a, b) => a.x - b.x);
  const placed = new Array(byX.length);
  for (let i = byX.length - 1; i >= 0; i--) {
    let row = 0;
    for (let j = i + 1; j < byX.length; j++) {
      if (byX[i].x + byX[i].w + gap > byX[j].x) row = Math.max(row, placed[j].row + 1);
    }
    placed[i] = { ...byX[i], row };
  }
  return placed.map((l) => (l.row >= LABEL_ROWS ? { ...l, row: -1 } : l));
}

/**
 * Which Sun level a Sun is: 'low' | 'mean' | 'high' for the key itself or an F10.7 within half a unit of a level (the curves are the same
 * to the eye), else null.
 * @param {string|number} level @returns {string|null}
 */
export function sunKeyOf(level) {
  if (level === 'low' || level === 'mean' || level === 'high') return level;
  if (!Number.isFinite(level)) return null;
  for (const k of ['low', 'mean', 'high']) if (Math.abs(level - LEVEL_F107[k]) < 0.5) return k;
  return null;
}

/** The narrowest and widest the words about the air at her height wrap to (CSS px). */
export const READOUT_MIN_W = 230; // 150 wrapped each sentence into a 4-line column (visual check 2026-11-22)
export const READOUT_MAX_W = 260;
/** Line pitch of the readout and of the edge marks (13 px type). */
export const READOUT_PITCH = 16;

/**
 * How wide the words under her line may be: from the right edge of the plot back to the busy Sun's whole-air curve (the rightmost curve)
 * at the lowest line the words can reach (about 100 px under her line), less 16 px.
 */
export function readoutWidth(geom, shipY) {
  const reach = shipY + 110;
  let maxX = geom.plot.x0;
  for (const p of curvePoints(geom, 'total', 'high')) if (p[1] >= shipY && p[1] <= reach) maxX = Math.max(maxX, p[0]);
  return Math.max(READOUT_MIN_W, Math.min(READOUT_MAX_W, Math.floor(geom.plot.x1 - 8 - maxX - 16)));
}

/**
 * The faint marks at the right edge of the plot and where their words go: a band for each of her debris-field heights and a tick for
 * the space station. The words are right-aligned at the plot's right edge, in the free column right of the curves; each label is kept
 * clear of her label and readout and of the other labels by moving it up or down a few px (a band label stays inside its band).
 * Words that find no room are dropped (`label: null`) and the band or tick stays.
 * @param {object} geom @param {object|null} ship the ship part of the frame (its `readout` is wrapped lines) @param {object} model
 * @param {(s:string, px:number)=>number} measure
 */
export function placeEdgeMarks(geom, ship, model, measure) {
  const { plot } = geom;
  const rightX = plot.x1 - 8;
  const boxes = [];
  const box = (text, baseline, h = 14) => { const w = measure(text, SIZE.small); return { l: rightX - w, r: rightX, t: baseline - SIZE.small + 1, b: baseline - SIZE.small + 1 + h, w }; };
  if (ship) {
    const lw = measure(ship.text, SIZE.body);
    boxes.push({ l: rightX - lw, r: rightX, t: ship.y - 7 - SIZE.body, b: ship.y - 4 });
    // the readout under her line: its first baseline 18 px below the line, a 6 px gap between sentences
    let by = ship.y + 18;
    ship.readoutLines = [];
    for (const para of ship.readout) {
      for (const line of para) { ship.readoutLines.push({ text: line, y: by }); by += READOUT_PITCH; }
      by += 6;
    }
    by -= 6;
    const shift = ship.readoutLines.length ? Math.min(0, plot.y1 - 4 - by) : 0;
    for (const r of ship.readoutLines) r.y += shift;
    if (ship.readoutLines.length) {
      const w = Math.max(...ship.readoutLines.map((r) => measure(r.text, SIZE.small)));
      boxes.push({ l: rightX - w, r: rightX, t: ship.readoutLines[0].y - SIZE.small, b: ship.readoutLines[ship.readoutLines.length - 1].y + 4 });
    }
  }
  const clear = (c) => boxes.every((o) => c.r <= o.l - 6 || c.l >= o.r + 6 || c.b <= o.t - 4 || c.t >= o.b + 4);
  /** Try offsets 0, -6, +6, -12 ... from the preferred baseline; `lo`/`hi` bound the box's top and bottom. */
  const place = (text, pref, lo, hi) => {
    for (let k = 0; k <= 12; k++) {
      for (const sgn of (k === 0 ? [1] : [-1, 1])) {
        const base = pref + sgn * k * 6;
        const c = box(text, base);
        if (c.t < Math.max(lo, plot.y0 + 2) || c.b > Math.min(hi, plot.y1 - 2)) continue;
        if (!clear(c)) continue;
        boxes.push(c);
        return { text, x: rightX, y: base, w: c.w };
      }
    }
    return null;
  };

  const station = { km: null, y: null, label: null };
  const km = model.stationKm;
  if (Number.isFinite(km) && km >= Y_MIN_KM && km <= Y_MAX_KM) {
    station.km = km; station.y = yOfKm(geom, km);
    station.label = place(`Space station ${Math.round(km)} km`, station.y - 6, plot.y0 + 2, plot.y1 - 2);
  }
  const bands = [];
  for (const b of (Array.isArray(model.fieldBandsKm) ? model.fieldBandsKm : [])) {
    const [lo, hi] = b;
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) continue;
    const yTop = Math.max(plot.y0, yOfKm(geom, Math.min(hi, Y_MAX_KM)));
    const yBot = Math.min(plot.y1, yOfKm(geom, Math.max(lo, Y_MIN_KM)));
    const text = `Debris field ${lo}\u2013${hi} km`;
    const mid = (yTop + yBot) / 2 + 4;
    // inside the band if there is room, else a little outside it (the words carry the heights)
    const label = place(text, mid, yTop + 1, yBot - 1) || place(text, mid, yTop - 30, yBot + 30);
    bands.push({ lo, hi, yTop, yBot, label });
  }
  return { bands, station };
}

/**
 * Everything the chart draws for a model and a screen size.
 * @param {object} model what AirPage works out:
 *   mode 'low'|'mean'|'high'; curveLevel 'low'|'mean'|'high' (the chosen curves); todayLevel (a level or F10.7 number; null when the game has no date, as in training:
 *   then there is no dashed line, no "= today" and no today words); todayLine, todaySub (plain words; '' / null when there is no date), stormLine (string|null);
 *   shipAltKm (number|null); hereLines (strings about the air at her height, optional); fieldBandsKm ([[lo,hi],...], optional); stationKm (number, optional)
 * @param {number} wPx @param {number} hPx
 * @param {(s:string, px:number)=>number} [measure] text width (default: an estimate)
 */
export function buildFrame(model, wPx, hPx, measure = approxWidth) {
  const geom = layoutChart(wPx, hPx);
  const mode = model.mode;
  const buttons = geom.buttons.map((b) => ({ ...b, active: b.id === mode }));
  const hasToday = model.todayLevel !== null && model.todayLevel !== undefined;

  // The chosen curves: whole air (bold) and the three gases.
  const curves = CURVES.map((c) => ({
    id: c.id, label: c.label, color: c.color || OFF_WHITE, dash: c.dash || null, bold: c.id === 'total', level: model.curveLevel,
    pts: curvePoints(geom, c.id, model.curveLevel),
  }));

  // The whole air at the other two Sun levels, faint; today's as a dashed line when the game has a date.
  const faintKeys = ['low', 'mean', 'high'].filter((k) => k !== mode);
  const faint = faintKeys.map((k) => ({ id: `faint-${k}`, label: SUN_WORDS[k], level: k, pts: curvePoints(geom, 'total', k) }));
  const todayDashed = hasToday
    ? { id: 'today-dashed', label: 'Today', level: model.todayLevel, pts: curvePoints(geom, 'total', model.todayLevel) }
    : null;

  // Labels above the plot, at the 900 km end of each whole-air line. When today's Sun IS one of the three levels, that level gets ONE
  // label ("Average Sun = today"), never a "Today" label on top of the level's own (the faint line under the bold one has no label either).
  const topLabels = [];
  const topOf = (pts) => pts[pts.length - 1][0];
  const todayKey = hasToday ? sunKeyOf(model.todayLevel) : null;
  const todayWord = (k) => (todayKey === k ? `${SUN_WORDS[k]} = today` : SUN_WORDS[k]);
  const bold = curves[0];
  for (const f of faint) {
    const text = todayWord(f.level);
    topLabels.push({ id: f.id, text, x: topOf(f.pts), w: measure(text, SIZE.small) + 6, bold: false });
  }
  const chosenText = todayWord(mode);
  topLabels.push({ id: 'chosen', text: chosenText, x: topOf(bold.pts), w: measure(chosenText, SIZE.small) + 6, bold: true });
  if (todayDashed && !todayKey) {
    topLabels.push({ id: todayDashed.id, text: 'Today', x: topOf(todayDashed.pts), w: measure('Today', SIZE.small) + 6, bold: false });
  }
  const topPlaced = layoutTopLabels(topLabels);

  // Her height, and what the air is like there (words come in with the model).
  let ship = null;
  if (Number.isFinite(model.shipAltKm) && model.shipAltKm >= Y_MIN_KM && model.shipAltKm <= Y_MAX_KM) {
    ship = { altKm: model.shipAltKm, y: yOfKm(geom, model.shipAltKm), text: `She is here: ${Math.round(model.shipAltKm)} km`, readout: [] };
    const rw = readoutWidth(geom, ship.y);
    for (const para of (Array.isArray(model.hereLines) ? model.hereLines : [])) {
      const lines = wrapText(para, rw, (t) => measure(t, SIZE.small));
      if (lines.length) ship.readout.push(lines);
    }
  }

  // Faint marks at the right edge: her debris-field heights and the space station (heights come in with the model).
  const marks = placeEdgeMarks(geom, ship, model, measure);

  // Axis ticks.
  const yTicks = [];
  for (let km = Y_MIN_KM; km <= Y_MAX_KM; km += 100) yTicks.push({ km, y: yOfKm(geom, km), text: `${km} km` });
  const xTicks = [];
  for (let e = X_MIN_EXP; e <= X_MAX_EXP; e++) xTicks.push({ exp: e, x: xOfDensity(geom, Math.pow(10, e)), text: decadeLabel(e) });

  // The side panel: what the lines are, then today's Sun, then a storm. (No "Other Sun levels" key line since Sky 31, §103 row 7: the faint lines carry their own words above the plot.)
  const legend = [
    { id: 'total', text: 'All the air', color: OFF_WHITE, style: 'bold' },
    { id: 'nO', text: 'Oxygen atoms', color: CURVES[1].color, style: 'solid' },
    { id: 'nN2', text: 'Nitrogen', color: CURVES[2].color, style: 'solid', dash: CURVES[2].dash },
    { id: 'nHe', text: 'Helium', color: CURVES[3].color, style: 'solid' },
  ];
  if (todayDashed) legend.push({ id: 'today-dashed', text: 'Today', color: OFF_WHITE, style: 'dashed' });
  const textW = geom.panel.w;
  const paraLines = (s, px) => wrapText(s, textW, (t) => measure(t, px));
  const notes = [];
  if (model.todayLine) notes.push({ id: 'today', lines: paraLines(model.todayLine, SIZE.body), px: SIZE.body, color: OFF_WHITE });
  if (model.todaySub) notes.push({ id: 'today-sub', lines: paraLines(model.todaySub, SIZE.small), px: SIZE.small, color: TEXT_DIM });
  if (model.stormLine) notes.push({ id: 'storm', lines: paraLines(model.stormLine, SIZE.body), px: SIZE.body, color: VisualLaw.COLORS.CAUTION });

  const sig = [
    mode, String(model.curveLevel), String(model.todayLevel), model.todayLine || '', model.todaySub || '', model.stormLine || '',
    ship ? Math.round(ship.altKm) : '-', `${wPx}x${hPx}`,
    ship ? ship.readout.map((p) => p.join(' ')).join('/') : '', JSON.stringify(model.fieldBandsKm || null), String(model.stationKm ?? '-'),
  ].join('|');

  return {
    geom, mode, buttons, curves, faint, todayDashed, topLabels: topPlaced, ship, marks, yTicks, xTicks, legend, notes,
    title: AIR_TITLE, subtitle: AIR_SUBTITLE,
    xTitle: 'Air density, kg per cubic metre (log scale: each step to the right is 10 times thicker)',
    sig,
  };
}

export class AirChart {
  /**
   * @param {{onMode?:(id:string)=>void, fontEpoch?:object, parent?:HTMLElement}} [deps] `onMode` is called with 'low'|'mean'|'high' when a
   *   button is pressed; `fontEpoch` stamps the signature so a chart painted before the faces settle repaints once; `parent` (default body).
   */
  constructor(deps = {}) {
    this._onMode = deps.onMode || null;
    this._fontEpoch = deps.fontEpoch || defaultFontEpoch;
    this._parent = deps.parent || null;
    this._root = null;
    this._canvas = null;
    this._ctx2d = null;
    this._buttons = new Map();
    this._visible = false;
    this._lastSig = null;
    /** Frames computed / rasterized (tests, probes). */
    this.renderCount = 0;
    this.paintCount = 0;
    /** The last frame (tests read it). */
    this.lastFrame = null;
  }

  /** @returns {HTMLElement|null} the top-level DOM node (null until shown in a browser) */
  root() { return this._root; }

  isVisible() { return this._visible; }

  _build() {
    if (this._root || typeof document === 'undefined' || !document.body) return;
    const root = document.createElement('div');
    root.id = 'air-page';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', `background:${BACKDROP}`,
      'z-index:35', 'display:none', 'opacity:0', 'transition:opacity 0.3s', 'overflow:hidden', 'pointer-events:none',
      'font-family:var(--font-mono)', 'user-select:none', '-webkit-user-select:none',
    ].join(';');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    root.appendChild(canvas);
    for (const b of SUN_BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.dataset.mode = b.id;
      el.setAttribute('aria-pressed', 'false');
      el.style.cssText = [
        'position:absolute', 'box-sizing:border-box', 'cursor:pointer', 'border-radius:6px', 'color:' + OFF_WHITE,
        'font-family:inherit', `font-size:${SIZE.body}px`, 'touch-action:manipulation', 'padding:0 8px', 'pointer-events:auto',
      ].join(';');
      const press = (e) => { e.preventDefault(); e.stopPropagation(); if (this._onMode) this._onMode(b.id); };
      el.addEventListener('click', press);
      root.appendChild(el);
      this._buttons.set(b.id, el);
    }
    (this._parent || document.body).appendChild(root);
    this._root = root;
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
  }

  show() {
    this._build();
    this._visible = true;
    this._lastSig = null;
    if (this._root) {
      this._root.style.display = 'block';
      // the opacity change needs a frame after display:block to transition
      this._root.style.opacity = '1';
    }
  }

  hide() {
    this._visible = false;
    if (this._root) { this._root.style.opacity = '0'; this._root.style.display = 'none'; }
    if (this._ctx2d && this._canvas) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  /**
   * Compute the frame for a model and paint it when its signature changed.
   * @param {object} model see `buildFrame` @param {{wPx?:number,hPx?:number}} [vp]
   * @returns {object} the frame, plus `painted` and `wouldPaint`
   */
  render(model, vp = {}) {
    const wPx = vp.wPx || ((typeof window !== 'undefined') ? window.innerWidth : 1280);
    const hPx = vp.hPx || ((typeof window !== 'undefined') ? window.innerHeight : 720);
    const g = this._ctx2d;
    const measure = g && typeof g.measureText === 'function'
      ? (s, px) => { g.font = mono(px); return g.measureText(String(s)).width; }
      : approxWidth;
    const frame = buildFrame(model, wPx, hPx, measure);
    const epoch = this._fontEpoch && typeof this._fontEpoch.value === 'function' ? this._fontEpoch.value() : 0;
    const sig = `${frame.sig}|e${epoch}`;
    const wouldPaint = sig !== this._lastSig;
    this.renderCount++;
    this.lastFrame = frame;
    let painted = false;
    if (wouldPaint && this._visible && this._ctx2d && this._canvas) {
      this._paint(frame, wPx, hPx);
      this._lastSig = sig;
      painted = true;
    } else if (wouldPaint && !this._ctx2d) {
      this._lastSig = sig;
    }
    return { ...frame, painted, wouldPaint };
  }

  _placeButtons(frame) {
    for (const b of frame.buttons) {
      const el = this._buttons.get(b.id);
      if (!el) continue;
      const s = el.style;
      s.left = `${b.x}px`; s.top = `${b.y}px`; s.width = `${b.w}px`; s.height = `${b.h}px`;
      s.background = b.active ? 'rgba(86, 116, 156, 0.55)' : 'rgba(30, 44, 66, 0.9)';
      s.border = b.active ? `2px solid ${OFF_WHITE}` : '1px solid rgba(150, 176, 206, 0.45)';
      el.setAttribute('aria-pressed', b.active ? 'true' : 'false');
    }
  }

  _paint(f, w, h) {
    const g = this._ctx2d;
    const canvas = this._canvas;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.paintCount++;
    this._placeButtons(f);
    const { plot, panel, panelR } = f.geom;
    const T = (s, x, y, px, color, align = 'left', weight) => {
      g.font = mono(px, weight); g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y);
    };

    // No heading here: the page row's title ("Air by height") stands at the top centre (Sky 20).
    T(f.subtitle, f.geom.left, f.geom.subY, SIZE.sub, TEXT_DIM);

    // Plot area and grid.
    g.fillStyle = PLOT_BG;
    g.fillRect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    g.lineWidth = 1;
    g.strokeStyle = GRID;
    for (const t of f.yTicks) { g.beginPath(); g.moveTo(plot.x0, t.y); g.lineTo(plot.x1, t.y); g.stroke(); }
    for (const t of f.xTicks) { g.beginPath(); g.moveTo(t.x, plot.y0); g.lineTo(t.x, plot.y1); g.stroke(); }
    for (const t of f.yTicks) T(t.text, plot.x0 - 8, t.y + 4, SIZE.small, TEXT, 'right');
    for (const t of f.xTicks) T(t.text, t.x, f.geom.xTickY, SIZE.small, TEXT, 'center');
    T(f.xTitle, (plot.x0 + plot.x1) / 2, f.geom.xTitleY, SIZE.small, TEXT_DIM, 'center');
    g.strokeStyle = 'rgba(176, 192, 212, 0.55)';
    g.strokeRect(plot.x0 + 0.5, plot.y0 + 0.5, plot.x1 - plot.x0 - 1, plot.y1 - plot.y0 - 1);

    // Faint marks under the curves: a band for each of her debris-field heights, a tick for the space station, both at the right edge.
    g.fillStyle = BAND_FILL;
    for (const b of f.marks.bands) g.fillRect(plot.x0 + 1, b.yTop, plot.x1 - plot.x0 - 2, b.yBot - b.yTop);
    g.fillStyle = BAND_BAR;
    for (const b of f.marks.bands) g.fillRect(plot.x1 - 4, b.yTop, 3, b.yBot - b.yTop);
    if (f.marks.station.y !== null) {
      g.strokeStyle = BAND_TICK; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(plot.x1 - 26, f.marks.station.y); g.lineTo(plot.x1 - 1, f.marks.station.y); g.stroke();
    }

    // Curves, clipped to the plot.
    g.save();
    g.beginPath(); g.rect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0); g.clip();
    const stroke = (pts, color, width, dash) => {
      g.beginPath();
      pts.forEach((p, i) => { if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]); });
      g.setLineDash(dash || []); g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
    };
    for (const l of f.faint) stroke(l.pts, FAINT_COLOR, FAINT_WIDTH);
    if (f.todayDashed) stroke(f.todayDashed.pts, 'rgba(238, 242, 247, 0.85)', 2, [7, 5]);
    for (const c of f.curves) if (c.bold) stroke(c.pts, c.color, 3.5);
    for (const c of f.curves) if (!c.bold) stroke(c.pts, c.color, 2.25, c.dash);
    if (f.ship) {
      g.strokeStyle = HERE; g.globalAlpha = 0.9; g.lineWidth = 1.5; g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(plot.x0, f.ship.y); g.lineTo(plot.x1, f.ship.y); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
    g.restore();
    if (f.ship) T(f.ship.text, plot.x1 - 8, f.ship.y - 7, SIZE.body, HERE, 'right', 'bold');
    if (f.ship) for (const r of f.ship.readoutLines || []) T(r.text, plot.x1 - 8, r.y, SIZE.small, TEXT, 'right');
    for (const b of f.marks.bands) if (b.label) T(b.label.text, b.label.x, b.label.y, SIZE.small, MARK_TEXT, 'right');
    if (f.marks.station.label) T(f.marks.station.label.text, f.marks.station.label.x, f.marks.station.label.y, SIZE.small, MARK_TEXT, 'right');

    // Labels above the plot, at the 900 km end of each whole-air line.
    // Leaders first, then each label on a patch of the backdrop so a leader never runs through a word.
    for (const l of f.topLabels) {
      if (l.row < 0) continue;
      const y = f.geom.labelBaseY - l.row * LABEL_ROW_PX;
      g.strokeStyle = l.bold ? OFF_WHITE : 'rgba(176, 192, 212, 0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(l.x, y + 3); g.lineTo(l.x, plot.y0); g.stroke();
    }
    for (const l of f.topLabels) {
      if (l.row < 0) continue;
      const y = f.geom.labelBaseY - l.row * LABEL_ROW_PX;
      g.fillStyle = BACKDROP;
      g.fillRect(l.x + LABEL_OFFSET, y - SIZE.small + 1, l.w, LABEL_H);
      T(l.text, l.x + LABEL_OFFSET + 3, y, SIZE.small, l.bold ? OFF_WHITE : TEXT_DIM, 'left', l.bold ? 'bold' : undefined);
    }

    // Side columns: the line key on the left, today's Sun words and a storm on the right.
    let py = panel.y + 6;
    for (const e of f.legend) {
      const mid = py - 5;
      g.beginPath(); g.moveTo(panel.x, mid); g.lineTo(panel.x + 44, mid);
      if (e.style === 'bold') { g.strokeStyle = e.color; g.lineWidth = 3.5; g.setLineDash([]); }
      else if (e.style === 'dashed') { g.strokeStyle = 'rgba(238, 242, 247, 0.85)'; g.lineWidth = 2; g.setLineDash([7, 5]); }
      else { g.strokeStyle = e.color; g.lineWidth = 2.25; g.setLineDash(e.dash || []); }
      g.stroke(); g.setLineDash([]);
      T(e.text, panel.x + 56, py, SIZE.body, TEXT);
      py += 26;
    }
    py = panelR.y + 6;   // today's Sun and a storm: the column right of the plot, from the plot's top
    for (const n of f.notes) {
      for (const line of n.lines) { T(line, panelR.x, py, n.px, n.color); py += Math.round(n.px * 1.4); }
      py += 10;
    }
  }

  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null; this._canvas = null; this._ctx2d = null;
    this._buttons.clear();
    this._visible = false;
    this._lastSig = null;
  }
}
