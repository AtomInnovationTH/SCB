/**
 * RealSkyLayer.js — the real catalogue as small fixed-size dots on floors 4 (NAVCOM) and 5 (SDA) (plan sky-1116, lane L-sky).
 *
 * Data: `data/sky.json` (scripts/build-sky.mjs: Space-Track GP mean elements, GCAT sizes, CelesTrak working / dead), fetched once on the
 * first entry to floor 4 or 5 (never at boot). Positions: SkyPropagator (two-body + J2 secular rates from the dated snapshot) at
 * "sky time" = the game date (`dateMs()`, moves when a trip lands) + the game seconds that have run since it last changed. Nothing is
 * invented: no hashed nodes, no hand-placed objects.
 *
 *   floor 4: one THREE.Points (screen-fixed size, one colour per class) in the same scene frame as the Earth, plus the picked
 *            object's orbit as one fat line (Line2, with a dark edge) and a bigger highlight dot;
 *   floor 5: SdaChart is a screen-static 2D canvas with its own altitude -> radius map, so 3D dots would not line up. The layer paints
 *            its own canvas just above the chart: radius = SdaChart's `radiusPxForAltKm` of the object's height, angle = the direction
 *            of the object as the camera sees it, measured from Earth's projected centre. Repainted every drawn frame (skipped while the clock is paused and the view still).
 *
 * Gates: shows on floors 4 and 5 only (also in training 1-3, DECISIONS §74 row 5). The cost is bounded: ROWS_PER_FRAME rows propagated per
 * frame (the whole sky is refreshed in under a second), every row carried forward from its stored velocity each frame so the dots move
 * smoothly, one `Points` draw call.
 *
 * Everything the game gives it is injected (scene, camera getter, viewport, fetch, clock, gates, card), so it runs headless.
 *
 * @module ui/RealSkyLayer
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Constants } from '../core/Constants.js';
import { fetchData } from '../core/dataUrl.js';
import { SkyPropagator, WGS72 } from '../systems/SkyPropagator.js';
import { meoRadialMap, radiusPxForAltKm, chartTextBoxes, chartTextVersion } from './SdaChart.js';
import { cardFields, CLASS_COLORS, CLASS_NAMES, CLS_STARLINK, isStarlinkRow } from './RealSkyCard.js';
import { StorageKeys } from '../core/StorageKeys.js';
import { LOOK_IDS, buildLook, ringTextureBytes, dotTextureBytes, lookFromSearch, installSkyLookHooks, measureClutter } from './SkyLook.js';

export { CLASS_COLORS };

/** Rows propagated exactly per frame: about 1 ms on the dev Mac (measured: 0.38 ms per 1,500 rows in Node); the whole sky is refreshed in 9 frames, 0.15 s at 60 fps. Between refreshes a row is carried forward from its stored velocity (see `_extrapolate`). */
export const ROWS_PER_FRAME = 4000;
/** A sky-clock step bigger than this (sky seconds between two frames) refreshes every row at once instead of carrying old states forward. */
export const JUMP_S = 120;
/** No row's stored state is carried forward more than about this many sky seconds (measured error at 120 s: a few km for a low orbit). */
export const MAX_AGE_S = 120;
/** Dot size, CSS px: mouse / glass. */
export const DOT_PX = 2;
export const DOT_PX_GLASS = 3;
/** Tap radius, CSS px: mouse / glass (the nearest painted dot inside it opens the card). */
export const PICK_PX = 12;
export const PICK_PX_GLASS = 24;
/** Hover (mouse only, floors 4-5; lane sky-look-1119): the pointer is picked at most once per frame, and only when it moved or this many ms passed (the dots move). */
export const HOVER_MIN_MS = 100;
/** The hover ring's diameter, CSS px (the selected dot's mark is 9 px on floor 4, a 14 px ring on floor 5). */
export const HOVER_RING_PX = 24;
/* Floor 5 repaints its chart every drawn frame (sky-smooth-1118: one repaint measured 2.6 ms median, 32.6k fillRects, 1728x1117); it skips a frame only while nothing moved. */
/** The picked object's orbit ring on floor 4: this many segments (129 points), redrawn this often (ms). */
export const ORBIT_SEGMENTS = 128;
export const ORBIT_REFRESH_MS = 2000;
/** The ring's width, CSS px: mouse / glass; its dark edge is RING_EDGE_PX wider (plan sky8: the 1 px ring was too weak on both screens). */
export const RING_PX = 3;
export const RING_PX_GLASS = 4;
export const RING_EDGE_PX = 2;
/** A double-tap on floor 4 (touch): two taps on the same dot within this many ms and CSS px turn the globe to it (a mouse uses the browser's `dblclick`). */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 24;
/**
 * The dive's peak dot opacity, 0.7 (owner 2026-11-19: the dive's dots are "too bright, too cartoonish"). Multiplies the dive's fade, so
 * the fade's shape is unchanged.
 */
export const DIVE_PEAK = 0.7;

const FLOOR_NAVCOM = 4;
const FLOOR_SDA = 5;
const KM_PER_UNIT = 1 / Constants.SCENE_SCALE;
const DAY_S = 86400;

/** Search: a number finds that NORAD number; text ranks exact name > name starts with > a word starts with > contains. @returns {number} row index or -1 */
export function searchRows(rows, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return -1;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    for (let i = 0; i < rows.length; i++) if (rows[i][0] === n) return i;
    return -1;
  }
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i][1]).toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    let rank;
    if (name === q) rank = 0;
    else if (at === 0) rank = 1;
    else if (/[\s(\-[/]/.test(name[at - 1])) rank = 2;
    else rank = 3;
    // class: the working / satellite objects before debris, then the shorter name, then the lower number (rows are sorted by NORAD)
    const kind = rows[i][2] === 3 || rows[i][2] === 4 || rows[i][2] === 2 ? 0 : 1;
    const score = rank * 1e6 + kind * 1e5 + name.length;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

const defaultFetchJson = async (url) => {
  const res = await fetchData(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export class RealSkyLayer {
  /**
   * @param {object} [deps] every one optional (headless tests inject stubs)
   * @param {object} [deps.scene] THREE.Scene (add / remove)
   * @param {function} [deps.getCamera] () => THREE.PerspectiveCamera
   * @param {function} [deps.getViewport] () => {w, h} CSS px of the game canvas
   * @param {function} [deps.fetchJson] (url) => Promise<object>; default: fetchData(url).json()
   * @param {function} [deps.dateMs] () => game date ms (SunStorms.dateMs); NaN before the first start
   * @param {function} [deps.isGlass] () => true on touch (bigger dots, bigger tap radius)
   * @param {function} [deps.pixelRatio] () => device pixel ratio
   * @param {function} [deps.now] () => monotonic ms
   * @param {object} [deps.card] RealSkyCard (show / hide / setObject / setNoMatch / setCredit)
   * @param {Document} [deps.document]
   * @param {number} [deps.rowsPerFrame]
   */
  constructor(deps = {}) {
    this._scene = deps.scene || null;
    this._getCamera = deps.getCamera || (() => null);
    this._getViewport = deps.getViewport || (() => ({ w: 1728, h: 1117 }));
    this._fetchJson = deps.fetchJson || defaultFetchJson;
    this._dateMs = deps.dateMs || (() => NaN);
    this._isGlass = deps.isGlass || (() => false);
    this._pixelRatio = deps.pixelRatio || (() => (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._card = deps.card || null;
    // Floor 4 "fly to a dot": onFlyTo(sceneDir) turns the globe to put that direction in the middle (main.js: cameraSystem.ladderTurnEarthDir).
    this._onFlyTo = typeof deps.onFlyTo === 'function' ? deps.onFlyTo : null;
    this._storage = deps.storage !== undefined ? deps.storage : (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; } })();
    this._hideCls = new Uint8Array(CLASS_NAMES.length);   // 1 = that kind is switched off (index = class number); read from storage now
    this._loadHiddenKinds();
    this._idxAttr = null;               // the draw index floor 4 uses while a kind is hidden (created once, reused)
    this._lastTap = null;               // the previous floor 4 touch tap that hit a dot: {i, x, y, t}
    // mouse hover (lane sky-look-1119): setCursor(css) sets the game canvas's cursor; the ring and label are DOM elements made on the first hover
    this._setCursor = typeof deps.setCursor === 'function' ? deps.setCursor : null;
    this._hover = -1;                   // row under the mouse, or -1
    this._hoverPtr = null;              // {x, y} last mouse position over the canvas (CSS px), or null
    this._hoverMoved = false;           // the pointer moved since the last hover pick
    this._hoverPickMs = -Infinity;
    this._hoverText = '';
    this._hoverRing = null;
    this._hoverLabel = null;
    this._hoverScr = { x: 0, y: 0 };    // scratch for _screenOf (no allocation per frame)
    this._hoverShown = { ring: false, label: false, rx: NaN, ry: NaN, lx: NaN, ly: NaN };   // last written ring / label state: a style is written only on change
    this._cursorOn = false;
    // floor 4 look (lane sky-look-1121; DECISIONS §83 row 1: variant 'b' is the game's look on every host). Variant '0' = the old fixed-size
    // dots, the base scene built exactly as before; the other variants add Points beside it (one per dot size, one for rings) and hide the
    // original. Dev host only: `?look=<id>`, `window.__skyLook(id)`, `window.__skyLookStats()` switch it for comparing.
    const lookLoc = deps.location !== undefined ? deps.location : globalThis.location;
    this._lookWant = lookFromSearch(lookLoc);   // the variant to build when the data arrives (DEFAULT_LOOK 'b' on a public host)
    this._lookId = '0';
    this._lookData = null;              // buildLook() of the current variant (also made for '0' when a stat is asked)
    this._lookGlass = null;
    this._lookBaseCol = null;           // today's per-row colours (never changed)
    this._lookGroups = [];              // [{size, pts, geo, idx}] sorted by size; rings last
    this._lookRing = null;
    this._lookTex = null;
    this._lookTexs = [];                // the round-dot maps of the look's bigger Points
    const lookWin = deps.lookWindow !== undefined ? deps.lookWindow : (typeof window !== 'undefined' ? window : null);
    installSkyLookHooks(this, lookLoc, lookWin);
    if (this._card && this._card.setHandlers) {
      this._card.setHandlers({
        onSearch: (q) => this.search(q), onClose: () => this.select(-1),
        onToggleKind: (name) => this.setKindHidden(name, !this.isKindHidden(name)),
        isKindHidden: (name) => this.isKindHidden(name),
        onFlyName: () => this.flySelected(),
      });
    }
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._rowsPerFrame = deps.rowsPerFrame || ROWS_PER_FRAME;
    // Objects that draw made-up positions on floors 4-5 (ActiveSatellites' group): hidden while the layer shows, restored after.
    this._hideWhileActive = Array.isArray(deps.hideWhileActive) ? deps.hideWhileActive : [];
    this._hidden = null;                // [{obj, was}] while they are hidden
    this._loadPromise = null;

    this._floor = null;                 // 4 or 5 while a floor asks for the layer, else null
    this._loadState = 'idle';           // idle | loading | ready | failed
    this._fetchCount = 0;
    this._sky = null;                   // data/sky.json
    this._rows = [];
    this._prop = null;
    this._snapshotMs = NaN;
    this._pos = null;                   // Float32Array(3N): scene units, the Points' position attribute too (the DRAWN position: carried forward to now)
    this._base = null;                  // Float32Array(3N): position at the row's last exact refresh
    this._vel = null;                   // Float32Array(3N): velocity then, scene units per sky second
    this._acc = null;                   // Float32Array(3N): two-body acceleration then, scene units per sky second squared
    this._t0 = null;                    // Float64Array(N): sky time of that refresh
    this._lastT = null;                 // sky time of the last extrapolation
    this._cursor = 0;
    this._lastBatch = 0;
    this._points = null;
    this._geo = null;
    this._posAttr = null;
    this._hiPoints = null;
    this._orbitLine = null;
    this._selected = -1;
    this._lastOrbitMs = -Infinity;
    this._tmp = new Float64Array(3 * (ORBIT_SEGMENTS + 1));
    this._tmp3 = new Float64Array(3);
    this._tmpV = new Float64Array(3);

    // the clock
    this._sumS = 0;
    this._lastDate = undefined;

    // floor 5
    this._canvas = null;
    this._ctx = null;
    this._sx = null;
    this._sy = null;
    this._cls = null;                   // Uint8Array(N): class per row (0-5 the data's class, 6 = Starlink; floor 5 paints by class from it)
    this._starlink = 0;
    this._lastPaintMs = -Infinity;      // -Infinity = repaint at once (a show, a selection change)
    this._lastPaintKey = '';
    this._lastPaintT = NaN;
    this._lastVP = new Float64Array(16);
    this._painted5 = 0;

    this._vp = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._gate = '';
    this._creditShown = '';
  }

  /* ---------------------------------------------------------------- gates and loading */

  /** A floor (4 or 5) asks for the layer. The first call starts the one fetch of data/sky.json. */
  show(floor) {
    if (floor !== FLOOR_NAVCOM && floor !== FLOOR_SDA) return;
    this._floor = floor;
    if (this._loadState === 'idle' || this._loadState === 'failed') this._loadPromise = this._load();
    this._lastPaintMs = -Infinity;      // a re-show repaints floor 5 at once
    this._apply();
  }

  /** The floor that asked leaves; ignored when another floor has taken the layer since (activation order is not guaranteed). */
  hide(floor) {
    if (floor != null && this._floor !== floor) return;
    this._floor = null;
    this._apply();
  }

  /** Floors 4-5 are showing the layer's slot: the layer draws (once loaded), in training too. */
  isActive() { return this._floor !== null; }

  floor() { return this._floor; }
  fetchCount() { return this._fetchCount; }
  loadState() { return this._loadState; }
  dotCount() { return this._rows.length; }
  /** Rows drawn as the Starlink kind (computed at load). */
  starlinkCount() { return this._starlink; }
  /** Rows of each kind now drawn (index = CLASS_NAMES index), hidden kinds included; for tests and probes. */
  kindCounts() { const out = new Array(CLASS_NAMES.length).fill(0); if (this._cls) for (let i = 0; i < this._cls.length; i++) out[this._cls[i]]++; return out; }
  rows() { return this._rows; }
  snapshotUtc() { return this._sky ? this._sky.snapshotUtc : null; }
  selected() { return this._selected; }
  lastBatch() { return this._lastBatch; }
  propagator() { return this._prop; }
  /** The Points (floor 4) and the 2D canvas (floor 5), for the browser probe. */
  points() { return this._points; }
  canvas() { return this._canvas; }
  /** Number of dots the last floor-5 paint drew. */
  paintedCount() { return this._painted5; }

  /** Resolves when the load that a show() started has finished (tests, probes). */
  whenLoaded() { return this._loadPromise || Promise.resolve(); }

  async _load() {
    this._loadState = 'loading';
    this._fetchCount++;
    try {
      const sky = await this._fetchJson('data/sky.json');
      if (!sky || !Array.isArray(sky.rows)) throw new Error('data/sky.json: no rows');
      this._ingest(sky);
      this._loadState = 'ready';
      if (this._lookWant !== '0') { this._lookId = this._lookWant; this._lookBuild(); }   // 'b' by default, or a dev host `?look=<id>`; its _apply follows
      this._apply();
    } catch (err) {
      this._loadState = 'failed';
      this._apply();                    // the card says the data could not load; the game's own objects stay visible
      if (typeof console !== 'undefined') console.warn('[RealSkyLayer] data/sky.json not loaded:', err && err.message);
    }
  }

  _ingest(sky) {
    this._sky = sky;
    this._rows = sky.rows;
    this._snapshotMs = Date.parse(sky.snapshotUtc);
    this._prop = new SkyPropagator(sky.rows, sky.fields);
    const N = sky.rows.length;
    this._pos = new Float32Array(3 * N);
    this._base = new Float32Array(3 * N);
    this._vel = new Float32Array(3 * N);
    this._acc = new Float32Array(3 * N);
    this._t0 = new Float64Array(N);
    this._lastT = null;
    this._sx = new Float32Array(N).fill(NaN);
    this._sy = new Float32Array(N).fill(NaN);
    const col = new Float32Array(3 * N);
    this._cls = new Uint8Array(N);
    const c = new THREE.Color();
    const palette = CLASS_COLORS.map((h) => { c.setStyle(h); return [c.r, c.g, c.b]; });
    this._starlink = 0;
    for (let i = 0; i < N; i++) {
      const k = sky.rows[i][2];
      let ci = k >= 0 && k < CLS_STARLINK ? k : CLS_STARLINK - 1;   // an unknown class number draws as "unknown"
      if (isStarlinkRow(sky.rows[i])) { ci = CLS_STARLINK; this._starlink++; }   // computed here, not in the data: no rebuild, no DATA_VERSION change
      this._cls[i] = ci;
      const p = palette[ci];
      col[3 * i] = p[0]; col[3 * i + 1] = p[1]; col[3 * i + 2] = p[2];
    }
    if (this._card && this._card.setStatusJoined) this._card.setStatusJoined(sky.statusJoined === true);
    this._buildScene(col);
    this._applyHiddenDraw();
    this.refreshAll();
    this._lookBaseCol = col;
  }

  _buildScene(col) {
    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this._pos, 3);
    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // The dots go through the composer's OutputPass (ACES) like the rest of the frame, so the colours in CLASS_COLORS are chosen for ACES
    // (see there); a material flag could not change that. Lane sky-look-1119.
    const mat = new THREE.PointsMaterial({ size: DOT_PX, sizeAttenuation: false, vertexColors: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;                       // positions move every frame; no bounding sphere to keep right
    pts.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    pts.visible = false;
    pts.name = 'real-sky-dots';
    this._geo = geo;
    this._points = pts;

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const hm = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffffff, depthWrite: false });
    this._hiPoints = new THREE.Points(hg, hm);
    this._hiPoints.frustumCulled = false;
    this._hiPoints.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT + 0.1;
    this._hiPoints.visible = false;
    this._hiPoints.name = 'real-sky-selected';

    // The ring is a fat line (Line2: a plain THREE.Line is 1 px in WebGL whatever its width, "visible but weak" on the Mac, "hard to see" on the iPad;
    // plan sky8). Kind colour, RING_PX / RING_PX_GLASS wide, over a dark edge RING_EDGE_PX wider (a second Line2 on the same points, a child so it
    // shows and hides with the ring) so it reads over Earth's bright land and cloud. Widths are in CSS px (the resolution is the CSS viewport).
    const lg = new LineGeometry();
    lg.setPositions(new Float32Array(3 * (ORBIT_SEGMENTS + 1)));
    this._orbitLine = new Line2(lg, new LineMaterial({ color: 0xffffff, linewidth: RING_PX, transparent: true, opacity: 1, depthWrite: false }));
    this._orbitLine.frustumCulled = false;
    this._orbitLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    this._orbitLine.visible = false;
    this._orbitLine.name = 'real-sky-orbit';
    this._orbitShadow = new Line2(lg, new LineMaterial({ color: 0x000000, linewidth: RING_PX + RING_EDGE_PX, transparent: true, opacity: 0.8, depthWrite: false }));
    this._orbitShadow.frustumCulled = false;
    this._orbitShadow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT - 0.1;
    this._orbitShadow.name = 'real-sky-orbit-shadow';
    this._orbitLine.add(this._orbitShadow);
    this._ringSize();

    if (this._scene && this._scene.add) {
      this._scene.add(this._points);
      this._scene.add(this._hiPoints);
      this._scene.add(this._orbitLine);
    }
  }

  /**
   * Apply the gates to everything drawn: Points on floor 4, canvas on floor 5, card on both. The dots, the highlight and the hiding of
   * the game's own template satellites wait for the data (`ready`); the card shows when the data is ready or when the fetch failed
   * (then it says so, and the game's own objects stay visible).
   */
  _apply() {
    const on = this.isActive();
    const ready = this._loadState === 'ready';
    const failed = this._loadState === 'failed';
    const showSky = on && ready;
    const f4 = showSky && this._floor === FLOOR_NAVCOM;
    const f5 = showSky && this._floor === FLOOR_SDA;
    // opening dive (lane sky-dive-1118): the dots show while the dive flies, though no floor holds the layer (_floor is null)
    const diveDots = this._dive === true && ready && this._diveAlpha > 0;
    if (this._dive === true) this._diveMaterial(this.diveAlpha());   // the Points are built when the data arrives, possibly mid-dive
    if (this._points) {
      // a look variant draws its own Points on floor 4 instead; the opening dive always draws these plain dots (the look's Points carry no dive fade)
      this._points.visible = this._lookGroups.length === 0 ? (f4 || diveDots) : (diveDots && !f4);
      for (const g of this._lookGroups) g.pts.visible = f4;
      this._points.material.size = this._isGlass() ? DOT_PX_GLASS : DOT_PX;   // 3 px on glass, 2 px with a mouse
      const sel = this._selected >= 0;
      this._hiPoints.visible = f4 && sel;
      this._orbitLine.visible = f4 && sel;
    }
    if (this._canvas) this._canvas.style.opacity = f5 ? '1' : '0';
    if (!f4 && !f5 && (this._hover >= 0 || this._cursorOn)) this.hoverClear();   // another floor, a menu, the opening dive: no hover
    if (this._card) {
      if (this._card.setLayout) this._card.setLayout(this._isGlass(), this._floor);
      if (this._card.setLoadFailed) this._card.setLoadFailed(on && failed);
      if (on && (ready || failed)) this._card.show(); else this._card.hide();
    }
    this._gate = `${on}|${this._loadState}`;
    if (showSky || (this._dive === true && ready)) {
      if (!this._hidden) {
        this._hidden = this._hideWhileActive.map((obj) => ({ obj, was: obj.visible }));
        for (const h of this._hidden) h.obj.visible = false;
      }
    } else if (this._hidden) {
      for (const h of this._hidden) h.obj.visible = h.was;
      this._hidden = null;
    }
  }

  /* ---------------------------------------------------------------- the clock */

  _syncDate() {
    const d = this._dateMs();
    const same = Object.is(d, this._lastDate) || (Number.isNaN(d) && Number.isNaN(this._lastDate));
    if (!same) { this._sumS = 0; this._lastDate = d; }
  }

  /**
   * Game seconds that ran this frame (the world clock, held and warped as the game holds and warps it). Called every frame from the
   * game loop, on every floor: a game date change (a trip landed) restarts the sum.
   */
  tickClock(dtWorldS) {
    this._syncDate();
    if (dtWorldS > 0 && Number.isFinite(dtWorldS)) this._sumS += dtWorldS;
  }

  /** Game seconds since `dateMs()` last changed. */
  sinceDateS() { this._syncDate(); return this._sumS; }

  /** Sky time as seconds after the snapshot: the game date (else the snapshot itself) + the seconds since it last changed. */
  skySeconds() {
    this._syncDate();
    const d = this._dateMs();
    const base = Number.isFinite(d) ? d : this._snapshotMs;
    return (base + this._sumS * 1000 - this._snapshotMs) / 1000;
  }

  /** The credit line; after a year the snapshot is called old. Without the CelesTrak status join it does not claim "Working / not working: CelesTrak." */
  creditLine() {
    if (!this._sky) return '';
    let credit = this._sky.credit;
    if (this._sky.statusJoined !== true) credit = credit.replace(/\s*Working \/ not working: CelesTrak\.?/, '');
    const days = Math.floor(this.skySeconds() / DAY_S);
    return days > 365 ? `${credit} Snapshot ${days} days old.` : credit;
  }

  /* ---------------------------------------------------------------- per frame */

  /** One frame: propagate the row budget, move the highlight, repaint floor 5 when due. No-op while the layer is off. */
  update() {
    const on = this.isActive();
    // the load never depends on the moment the floor was entered: a floor with the layer and nothing loaded starts it here
    if (on && this._loadState === 'idle') this._loadPromise = this._load();
    if (`${on}|${this._loadState}` !== this._gate) this._apply();
    if (this._card && this._card.setLayout) this._card.setLayout(this._isGlass(), this._floor);   // a first touch / a floor change moves the panel clear of Earth
    if (this._points) { const s = this._isGlass() ? DOT_PX_GLASS : DOT_PX; if (this._points.material.size !== s) this._points.material.size = s; }
    if (this._lookData && this._isGlass() !== this._lookGlass) this._lookBuild();   // the mouse / touch sizes differ
    this._ringSize();
    if (!on || this._loadState !== 'ready') { this._lastBatch = 0; return; }
    const t = this.skySeconds();
    this._propagateBatch(t);
    const credit = this.creditLine();
    if (credit !== this._creditShown) { this._creditShown = credit; if (this._card && this._card.setCredit) this._card.setCredit(credit); }
    if (this._selected >= 0) this._moveSelection(t);
    if (this._floor === FLOOR_SDA) this._paint5(t);
    this._hoverTick();
  }

  /**
   * One batch of rows is propagated exactly (position, velocity, gravity at that moment, and the sky time); then EVERY row is drawn at
   * its stored state carried forward to now, in one pass (`_extrapolate`). Without that, a row only moved when its batch came round
   * (every 9 frames) and a dot jumped tens of px at the floor's 200x clock (lane sky-smooth-1118).
   */
  _propagateBatch(t) {
    const N = this._rows.length;
    // the budget grows with the clock so no row is ever more than MAX_AGE_S sky seconds old (the carry-forward error grows with its cube)
    const dtT = this._lastT === null ? 0 : Math.abs(t - this._lastT);
    const jump = dtT > JUMP_S;                       // a clock jump (a trip landed, the date changed): every stored state is too old to carry forward
    const n = jump ? Math.min(N, this._rowsPerFrame) : Math.min(N, Math.max(this._rowsPerFrame, Math.ceil(N * dtT / MAX_AGE_S)));
    let c = this._cursor;
    let left = n;
    if (jump) { this.refreshAll(); left = 0; }
    while (left > 0) {
      const take = Math.min(left, N - c);
      this._propagateRange(c, c + take, t);
      left -= take;
      c = (c + take) % N;
    }
    this._cursor = c;
    this._lastBatch = n;
    this._extrapolate(t);
  }

  /** Propagate rows [from, to) exactly at sky time t and store their state for `_extrapolate`. */
  _propagateRange(from, to, t) {
    const prop = this._prop, base = this._base, vel = this._vel, acc = this._acc, t0 = this._t0;
    const p = this._tmp3, v = this._tmpV, S = Constants.SCENE_SCALE, GM = WGS72.MU * S;
    for (let i = from; i < to; i++) {
      prop.positionVelocityInto(i, t, p, 0, v, 0);
      const k = 3 * i;
      const r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
      const g = -GM / (r2 * Math.sqrt(r2));              // two-body pull: acceleration = (km position) * g, already in scene units
      base[k] = p[0] * S; base[k + 1] = p[1] * S; base[k + 2] = p[2] * S;
      vel[k] = v[0] * S; vel[k + 1] = v[1] * S; vel[k + 2] = v[2] * S;
      acc[k] = p[0] * g; acc[k + 1] = p[1] * g; acc[k + 2] = p[2] * g;
      t0[i] = t;
    }
  }

  /**
   * Draw every row at `base + vel*dt + acc*dt^2/2` (dt = sky seconds since its refresh) and upload the buffer once. A paused clock keeps
   * dt, so the dots stand still. Measured error against a fresh propagation: about 0.05 km at 30 sky-s (the 9-frame cycle at 200x).
   */
  _extrapolate(t) {
    const N = this._rows.length, pos = this._pos, base = this._base, vel = this._vel, acc = this._acc, t0 = this._t0;
    for (let i = 0; i < N; i++) {
      const dt = t - t0[i], h = 0.5 * dt * dt, k = 3 * i;
      pos[k] = base[k] + vel[k] * dt + acc[k] * h;
      pos[k + 1] = base[k + 1] + vel[k + 1] * dt + acc[k + 1] * h;
      pos[k + 2] = base[k + 2] + vel[k + 2] * dt + acc[k + 2] * h;
    }
    this._lastT = t;
    this._posAttr.clearUpdateRanges();
    this._posAttr.needsUpdate = true;
  }

  /** Every row now (first load, and tests). */
  refreshAll() {
    if (!this._prop) return;
    const t = this.skySeconds();
    this._propagateRange(0, this._rows.length, t);
    this._extrapolate(t);
  }

  /** Scene-unit position of row i as of the last propagation. @returns {{x:number,y:number,z:number}} */
  positionOf(i) { return { x: this._pos[3 * i], y: this._pos[3 * i + 1], z: this._pos[3 * i + 2] }; }

  /** Exact (not budgeted) position and orbit ring of the selected row. */
  _moveSelection(t) {
    const i = this._selected, S = Constants.SCENE_SCALE, o = this._tmp3;
    this._prop.positionInto(i, t, o, 0);
    const a = this._hiPoints.geometry.attributes.position;
    a.array[0] = o[0] * S; a.array[1] = o[1] * S; a.array[2] = o[2] * S;
    a.needsUpdate = true;
    const now = this._now();
    if (now - this._lastOrbitMs >= ORBIT_REFRESH_MS) { this._lastOrbitMs = now; this._fillOrbit(t); }
  }

  /** Ring width (3 px mouse, 4 px glass; the dark edge 2 px wider) and the line material's resolution = the CSS viewport; cheap, called each frame. */
  _ringSize() {
    if (!this._orbitLine) return;
    const v = this._getViewport(), w = Math.max(1, v.w || 1), h = Math.max(1, v.h || 1);
    const rs = this._orbitLine.material.resolution;   // LineMaterial copies what it is given: set each material's own Vector2
    if (rs.x !== w || rs.y !== h) { rs.set(w, h); this._orbitShadow.material.resolution.set(w, h); }
    const px = this._isGlass() ? RING_PX_GLASS : RING_PX;
    if (this._orbitLine.material.linewidth !== px) {
      this._orbitLine.material.linewidth = px;
      this._orbitShadow.material.linewidth = px + RING_EDGE_PX;
    }
  }

  _fillOrbit(t) {
    const i = this._selected, S = Constants.SCENE_SCALE;
    this._prop.orbitLineInto(i, t, ORBIT_SEGMENTS, this._tmp);
    // Fat-line geometry: one instance per segment, [start xyz, end xyz] interleaved; rewritten in place (no per-refresh allocation).
    const buf = this._orbitLine.geometry.attributes.instanceStart.data, arr = buf.array, tmp = this._tmp;
    for (let k = 0; k < ORBIT_SEGMENTS; k++) {
      for (let c = 0; c < 6; c++) arr[6 * k + c] = tmp[3 * k + c] * S;
    }
    buf.needsUpdate = true;
    // The ring wears the dot's own kind colour at full strength (plan sky-trio-1118 T1: the old 0.85 white ring was faint over Earth's bright land and cloud).
    this._orbitLine.material.color.set(CLASS_COLORS[this._cls[i]] || '#ffffff');
    this._orbitLine.material.opacity = 1;
  }

  /* ---------------------------------------------------------------- floor 5 canvas */

  _build5() {
    if (this._canvas || !this._doc || !this._doc.body) return;
    const canvas = this._doc.createElement('canvas');
    canvas.id = 'ladder-real-sky';
    // z-index 34: just above the SdaChart canvas (33); the card (z 35+) sits over both.
    canvas.style.cssText = ['position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', 'pointer-events:none',
      'z-index:34', `opacity:${this._floor === FLOOR_SDA && this.isActive() ? 1 : 0}`, 'transition:opacity 0.3s'].join(';');
    this._doc.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext ? canvas.getContext('2d') : null;
  }

  /** The projection of the camera as a flat matrix (row-major access via .elements, column-major storage) or null. */
  _viewProj() {
    const cam = this._getCamera();
    if (!cam) return null;
    cam.updateMatrixWorld();
    this._inv.copy(cam.matrixWorld).invert();
    this._vp.multiplyMatrices(cam.projectionMatrix, this._inv);
    return cam;
  }

  _paint5(t) {
    if (!this._canvas) this._build5();
    const g = this._ctx;
    if (!g) return;
    const vpSize = this._getViewport();
    const W = vpSize.w, H = vpSize.h;
    const key = `${W}x${H}|${this._selected}|${chartTextVersion()}`;   // the chart's text moved or repainted: clear its boxes again
    if (!this._viewProj()) return;
    // every drawn frame, from the carried-forward positions; but not while nothing moved (paused clock, still camera, same selection)
    const el = this._vp.elements, last = this._lastVP;
    let same = key === this._lastPaintKey && t === this._lastPaintT && this._lastPaintMs !== -Infinity;
    for (let k = 0; same && k < 16; k++) if (el[k] !== last[k]) same = false;
    if (same) return;
    for (let k = 0; k < 16; k++) last[k] = el[k];
    this._lastPaintKey = key;
    this._lastPaintT = t;
    this._lastPaintMs = this._now();

    const dpr = this._pixelRatio();
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // No per-row allocation: the projection is inlined, screen points go into the preallocated _sx / _sy, and each class is painted
    // by a pass over the preallocated class array (6 cheap passes, no arrays built, nothing grown by push).
    const m = this._vp.elements;
    const m0 = m[0], m1 = m[1], m3 = m[3], m4 = m[4], m5 = m[5], m7 = m[7], m8 = m[8], m9 = m[9], m11 = m[11], m12 = m[12], m13 = m[13], m15 = m[15];
    const map = meoRadialMap({ wPx: W, hPx: H });
    const cx = W / 2, cy = H / 2;
    const px = this._isGlass() ? DOT_PX_GLASS : DOT_PX;
    const half = px / 2;
    const pos = this._pos, N = this._rows.length, sx = this._sx, sy = this._sy, cls = this._cls, hide = this._hideCls, sel = this._selected;
    sx.fill(NaN); sy.fill(NaN);
    const w0 = m15;                                    // Earth's centre is the origin: clip w = m15
    if (!(w0 > 1e-9)) { this._painted5 = 0; return; }
    const c0x = (m12 / w0 * 0.5 + 0.5) * W, c0y = (-m13 / w0 * 0.5 + 0.5) * H;
    const rEarthU = Constants.EARTH_RADIUS, geoPx = map.geoPx;
    for (let i = 0; i < N; i++) {
      if (hide[cls[i]] === 1 && i !== sel) continue;   // a switched-off kind is neither painted nor pickable (only a search's pick keeps its ring)
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      const w = m3 * x + m7 * y + m11 * z + m15;
      if (!(w > 1e-9)) continue;                       // behind the camera
      let dx = ((m0 * x + m4 * y + m8 * z + m12) / w * 0.5 + 0.5) * W - c0x;
      let dy = (-(m1 * x + m5 * y + m9 * z + m13) / w * 0.5 + 0.5) * H - c0y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      const altKm = Math.max(0, Math.sqrt(x * x + y * y + z * z) - rEarthU) * KM_PER_UNIT;
      const r = Math.min(radiusPxForAltKm(map, altKm), geoPx);   // above the GEO ring: on the ring (the chart's edge)
      sx[i] = cx + dx * r; sy[i] = cy + dy * r;
    }
    let n = 0;
    // Starlink first, so its dim dots lie under every other kind's (draw order = painting order here).
    for (let o = 0; o < CLASS_COLORS.length; o++) {
      const c = (o + CLS_STARLINK) % CLASS_COLORS.length;
      if (hide[c] === 1) continue;
      g.fillStyle = CLASS_COLORS[c];
      for (let i = 0; i < N; i++) {
        if (cls[i] !== c || sx[i] !== sx[i]) continue;   // sx[i] !== sx[i]: NaN, not painted
        g.fillRect(sx[i] - half, sy[i] - half, px, px);
        n++;
      }
    }
    this._painted5 = n;
    // The chart's own text (ring labels, tag, bottom lines, strip title) is on the canvas UNDER this one: wipe the dots out of each
    // string's box, 3 px of margin, so every label reads (lane fix F1, 2026-11-18; the dense LEO shells covered the top labels).
    for (const b of chartTextBoxes()) g.clearRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    const s = this._selected;
    if (s >= 0 && Number.isFinite(sx[s])) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(sx[s], sy[s], 7, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** Screen point (CSS px) a row was last painted at on floor 5, or null. */
  paintedPoint(i) { return this._sx && Number.isFinite(this._sx[i]) ? { x: this._sx[i], y: this._sy[i] } : null; }

  /** The radius (CSS px from the screen centre) floor 5 gives an object at this height, through the chart's own map. */
  radiusPxFor(altKm) {
    const v = this._getViewport();
    return radiusPxForAltKm(meoRadialMap({ wPx: v.w, hPx: v.h }), altKm);
  }

  /* ---------------------------------------------------------------- pick, select, search */

  /**
   * The nearest painted dot to a tap (CSS px) inside the tap radius, or -1. Floor 5: the dots as last painted. Floor 4: the dots as the
   * camera sees them now, those behind Earth excluded (they are not painted).
   * @param {number} x @param {number} y @param {{glass?: boolean}} [opts]
   * @returns {number} row index or -1
   */
  pick(x, y, opts = {}) {
    if (!this.isActive() || this._loadState !== 'ready') return -1;
    const glass = opts.glass !== undefined ? opts.glass : this._isGlass();
    const R = glass ? PICK_PX_GLASS : PICK_PX;
    return this._floor === FLOOR_SDA ? this._pick5(x, y, R) : this._pick4(x, y, R);
  }

  _pick5(x, y, R) {
    const sx = this._sx, sy = this._sy, hide = this._hideCls, cls = this._cls;
    let best = -1, bd = R * R;
    for (let i = 0; i < sx.length; i++) {
      const dx = sx[i] - x, dy = sy[i] - y;          // NaN (unpainted) compares false
      const d = dx * dx + dy * dy;
      if (d <= bd && hide[cls[i]] !== 1) { bd = d; best = i; }
    }
    return best;
  }

  _pick4(x, y, R) {
    const cam = this._viewProj();
    if (!cam) return -1;
    const v = this._getViewport(), W = v.w, H = v.h;
    const m = this._vp.elements;
    const cp = cam.position;
    const pos = this._pos, N = this._rows.length, RE = Constants.EARTH_RADIUS, hide = this._hideCls, cls = this._cls;
    let best = -1, bd = R * R;
    // look: a dot bigger than today's is hit anywhere on its extra size (the pick radius grows by its radius beyond today's dot; inside that, the
    // nearer centre wins); a dot of today's size picks exactly as before (centre distance). null = no look
    const lp = this._lookData && this._lookData.id !== '0' ? this._lookData.px : null;
    const lb = this._lookGlass ? DOT_PX_GLASS : DOT_PX;
    for (let i = 0; i < N; i++) {
      if (hide[cls[i]] === 1) continue;                // a switched-off kind is not drawn, so it is not pickable
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (!(w > 1e-9)) continue;
      const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * W;
      const sy = (-(m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5) * H;
      const dx = sx - x, dy = sy - y;
      let d = dx * dx + dy * dy;
      if (lp !== null && lp[i] > lb) { const e = Math.sqrt(d) - (lp[i] - lb) * 0.5; d = e > 0 ? e * e : d * 1e-6; }
      if (d > bd) continue;
      // behind Earth? the camera-to-dot segment enters the sphere before it reaches the dot
      const ex = px - cp.x, ey = py - cp.y, ez = pz - cp.z;
      const a = ex * ex + ey * ey + ez * ez;
      const b = cp.x * ex + cp.y * ey + cp.z * ez;
      const c = cp.x * cp.x + cp.y * cp.y + cp.z * cp.z - RE * RE;
      const disc = b * b - a * c;
      if (disc > 0) {
        const t1 = (-b - Math.sqrt(disc)) / a;
        if (t1 > 0 && t1 < 1) continue;
      }
      bd = d; best = i;
    }
    return best;
  }

  /** The card's content for row i (strings). */
  describe(i) {
    if (i < 0 || !this._prop) return null;
    const g = this._sky.gcatNames;
    const f = cardFields(this._rows[i], this._prop.heightsKm(i), this._sky.snapshotUtc, g ? g[this._rows[i][0]] : undefined);
    if (this._cls && this._cls[i] === CLS_STARLINK) f.cls = CLS_STARLINK;   // the card's dot wears the Starlink colour; its kind line still says "working satellite"
    return f;
  }

  /** Open the card on row i (or close with -1), highlight its dot, draw its orbit (floor 4). */
  select(i) {
    this._selected = i >= 0 && i < this._rows.length ? i : -1;
    if (this._card) this._card.setObject(this._selected >= 0 ? this.describe(this._selected) : null);
    if (this._selected >= 0) {
      this._lastOrbitMs = -Infinity;
      const t = this.skySeconds();
      this._moveSelection(t);
    }
    this._lastPaintMs = -Infinity;
    this._apply();
    return this._selected;
  }

  /**
   * Tap resolver: pick, and open the card when a dot was hit. On floor 4 with a finger, a second tap on the same dot within
   * DOUBLE_TAP_MS and DOUBLE_TAP_PX also turns the globe to it (a mouse's double-click comes through `flyAt`).
   * @returns {boolean} true when a dot was hit (the tap is used)
   */
  tap(x, y, opts) {
    const i = this.pick(x, y, opts);
    if (i < 0) { this._lastTap = null; return false; }
    this.select(i);
    if (this._card && this._card.clearSearch) this._card.clearSearch();
    if (this._floor === FLOOR_NAVCOM && !(opts && opts.mouse)) {
      const now = this._now(), lt = this._lastTap;
      if (lt && lt.i === i && now - lt.t <= DOUBLE_TAP_MS && Math.hypot(x - lt.x, y - lt.y) <= DOUBLE_TAP_PX) {
        this._lastTap = null;
        this.flyTo(i);
      } else this._lastTap = { i, x, y, t: now };
    }
    return true;
  }

  /** A mouse double-click at (x, y): select the dot there (as a tap does) and, on floor 4, turn the globe to it. @returns {boolean} true when a dot was hit */
  flyAt(x, y, opts) {
    const i = this.pick(x, y, opts);
    if (i < 0) return false;
    this.select(i);
    if (this._card && this._card.clearSearch) this._card.clearSearch();
    this.flyTo(i);
    return true;
  }

  /** Floor 4 only: turn the globe so row i sits in the middle of the view (onFlyTo gets the scene direction from Earth's centre). @returns {boolean} true when a turn started */
  flyTo(i) {
    if (this._floor !== FLOOR_NAVCOM || !this._onFlyTo || !this._pos || !(i >= 0 && i < this._rows.length)) return false;
    return !!this._onFlyTo({ x: this._pos[3 * i], y: this._pos[3 * i + 1], z: this._pos[3 * i + 2] });
  }

  /** Turn the globe to the card's object (a double-click or double-tap on its name). */
  flySelected() { return this._selected >= 0 ? this.flyTo(this._selected) : false; }

  /* ---------------------------------------------------------------- mouse hover (lane sky-look-1119; owner 2026-11-19: "some mouse hover clue ... to show the dot is select, can click") */

  /**
   * The mouse moved over the game canvas (main.js calls this from the canvas's `pointermove`). Remembers the spot only; the pick runs in
   * `update()` (`_hoverTick`), at most once per frame. Anything but a plain mouse move (touch or pen, a button held = a drag) clears the hover.
   * @param {number} x CSS px @param {number} y @param {{mouse?: boolean, buttons?: number}} [opts]
   */
  hoverMove(x, y, opts) {
    if (!opts || opts.mouse !== true || opts.buttons) { this.hoverClear(); return; }
    this._hoverPtr = { x, y };
    this._hoverMoved = true;
  }

  /** The mouse left the canvas, a drag began, or the layer went off: no ring, no label, the normal cursor. */
  hoverClear() {
    this._hoverPtr = null;
    this._hoverMoved = false;
    this._setHover(-1);
  }

  /** The row under the mouse now, or -1 (probes and tests). */
  hoverIndex() { return this._hover; }

  /** The name the hover label shows ('' = no label). */
  hoverLabelText() { return this._hoverLabel && this._hoverLabel.style.display !== 'none' ? this._hoverText : ''; }

  /** The hover ring and label elements, or null before the first hover (probes and tests). */
  hoverElements() { return { ring: this._hoverRing, label: this._hoverLabel }; }

  /** Once per frame from `update()`: pick under the pointer when it moved or HOVER_MIN_MS passed, then keep the ring on its (moving) dot. */
  _hoverTick() {
    const p = this._hoverPtr;
    if (!p) return;
    if (this._dive === true || (this._floor !== FLOOR_NAVCOM && this._floor !== FLOOR_SDA) || this._loadState !== 'ready') { this.hoverClear(); return; }
    const now = this._now();
    if (this._hoverMoved || now - this._hoverPickMs >= HOVER_MIN_MS) {
      this._hoverPickMs = now;
      this._hoverMoved = false;
      this._setHover(this.pick(p.x, p.y, { glass: false }));
    }
    if (this._hover >= 0) this._placeHover();
  }

  /** Make (or clear, -1) the hover: cursor, name text, and show / hide the ring and label. */
  _setHover(i) {
    const was = this._hover;
    this._hover = i;
    const on = i >= 0;
    if (on !== this._cursorOn) {
      this._cursorOn = on;
      if (this._setCursor) this._setCursor(on ? 'pointer' : '');
    }
    if (i === was) return;
    if (!on) {
      this._hoverText = '';
      if (this._hoverRing) this._hoverRing.style.display = 'none';
      if (this._hoverLabel) this._hoverLabel.style.display = 'none';
      this._hoverResetShown();
      return;
    }
    const d = this.describe(i);
    this._hoverText = d ? d.name : '';
    this._hoverBuild();
    if (this._hoverLabel) {
      this._hoverLabel.textContent = this._hoverText;
      this._hoverLabel.style.borderLeftColor = CLASS_COLORS[this._cls[i]] || '#ffffff';
    }
  }

  _hoverBuild() {
    if (this._hoverRing || !this._doc || !this._doc.body || !this._doc.createElement) return;
    const ring = this._doc.createElement('div');
    ring.id = 'real-sky-hover-ring';
    ring.style.cssText = ['position:fixed', 'display:none', 'pointer-events:none', 'z-index:35', `width:${HOVER_RING_PX}px`, `height:${HOVER_RING_PX}px`,
      'box-sizing:border-box', 'border-radius:50%', 'border:2px solid #ffffff', 'box-shadow:0 0 0 1px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(0,0,0,0.75)'].join(';');
    const label = this._doc.createElement('div');
    label.id = 'real-sky-hover-label';
    label.style.cssText = ['position:fixed', 'display:none', 'pointer-events:none', 'z-index:35', 'max-width:260px', 'box-sizing:border-box', 'padding:3px 7px',
      'border-radius:4px', 'border-left:3px solid #ffffff', 'background:rgba(8,12,22,0.88)', 'color:#e8eefc', 'font-family:var(--font-mono)', 'font-size:12px',
      'line-height:1.3', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'user-select:none', '-webkit-user-select:none'].join(';');
    this._doc.body.appendChild(ring);
    this._doc.body.appendChild(label);
    this._hoverRing = ring;
    this._hoverLabel = label;
  }

  /** Forget what was last written to the ring and label (they were hidden or dropped), so the next placement writes everything. */
  _hoverResetShown() {
    const c = this._hoverShown;
    c.ring = false; c.label = false; c.rx = NaN; c.ry = NaN; c.lx = NaN; c.ly = NaN;
  }

  /** Screen point (CSS px) of row i now into the scratch `_hoverScr`: floor 5 = as last painted, floor 4 = projected through the camera; false when it has none. */
  _screenOf(i) {
    const out = this._hoverScr;
    if (this._floor === FLOOR_SDA) {
      if (!this._sx || !Number.isFinite(this._sx[i])) return false;
      out.x = this._sx[i]; out.y = this._sy[i];
      return true;
    }
    if (!this._viewProj()) return false;
    const v = this._getViewport(), m = this._vp.elements, pos = this._pos;
    const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
    if (!(w > 1e-9)) return false;
    out.x = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * v.w;
    out.y = (-(m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5) * v.h;
    return true;
  }

  /** Put the ring on the hovered dot and the label beside the pointer (kept inside the viewport). A style is written only when its value changed. */
  _placeHover() {
    if (!this._hoverRing) return;
    const c = this._hoverShown, ring = this._hoverRing, p = this._hoverPtr;
    const v = this._getViewport();
    if (this._screenOf(this._hover)) {
      const s = this._hoverScr;
      const rx = Math.round(s.x - HOVER_RING_PX / 2), ry = Math.round(s.y - HOVER_RING_PX / 2);
      if (!c.ring) { ring.style.display = 'block'; c.ring = true; }
      if (rx !== c.rx) { ring.style.left = `${rx}px`; c.rx = rx; }
      if (ry !== c.ry) { ring.style.top = `${ry}px`; c.ry = ry; }
    } else if (c.ring) { ring.style.display = 'none'; c.ring = false; }
    if (p && this._hoverText) {
      const lab = this._hoverLabel;
      if (!c.label) { lab.style.display = 'block'; c.label = true; }
      const w = Math.min(260, 14 + this._hoverText.length * 7.5);
      const lx = Math.round(Math.max(4, p.x + 16 + w > v.w - 4 ? p.x - 16 - w : p.x + 16));
      const ly = Math.round(Math.max(4, p.y + 22 + 24 > v.h ? p.y - 30 : p.y + 18));
      if (lx !== c.lx) { lab.style.left = `${lx}px`; c.lx = lx; }
      if (ly !== c.ly) { lab.style.top = `${ly}px`; c.ly = ly; }
    }
  }

  /* ---------------------------------------------------------------- show / hide by kind (legend boxes) */

  /** True when the legend box of this kind (a name from CLASS_NAMES) is switched off. */
  isKindHidden(name) {
    const k = CLASS_NAMES.indexOf(name);
    return k >= 0 && this._hideCls[k] === 1;
  }

  /** The kinds switched off now (CLASS_NAMES order). */
  hiddenKinds() { return CLASS_NAMES.filter((n, k) => this._hideCls[k] === 1); }

  /**
   * Switch a kind off or on: not drawn on floors 4 and 5 and not pickable while off; saved. Switching off the kind of the object
   * that is open closes its card and ring. A search still opens a hidden kind's card (an explicit ask).
   * @param {string} name a name from CLASS_NAMES @param {boolean} hide
   */
  setKindHidden(name, hide) {
    const k = CLASS_NAMES.indexOf(name);
    if (k < 0) return false;
    const h = hide ? 1 : 0;
    if (this._hideCls[k] === h) return h === 1;
    this._hideCls[k] = h;
    this._saveHiddenKinds();
    this._applyHiddenDraw();
    this._lookReindex();
    this._lastPaintMs = -Infinity;                     // floor 5 repaints at once
    if (h === 1 && this._selected >= 0 && this._cls && this._cls[this._selected] === k) this.select(-1);
    if (this._card && this._card.refreshKinds) this._card.refreshKinds();
    return h === 1;
  }

  _loadHiddenKinds() {
    try {
      const raw = this._storage ? this._storage.getItem(StorageKeys.REAL_SKY_HIDDEN) : null;
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list)) for (const n of list) { const k = CLASS_NAMES.indexOf(n); if (k >= 0) this._hideCls[k] = 1; }
    } catch (_) { /* a bad value = all shown */ }
  }

  _saveHiddenKinds() {
    try { if (this._storage) this._storage.setItem(StorageKeys.REAL_SKY_HIDDEN, JSON.stringify(this.hiddenKinds())); } catch (_) { /* private mode: not saved */ }
  }

  /**
   * Floor 4: which rows are drawn and in what order. The Starlink rows go first in the index, so every other kind's dots are drawn over
   * them (the Points draw in index order, depthWrite off); a hidden kind is left out. With no Starlink rows and nothing hidden it is the
   * plain non-indexed draw as before. One Uint32 attribute, rebuilt only here, when the set changes; no per-frame cost.
   */
  _applyHiddenDraw() {
    const geo = this._geo;
    if (!geo || !this._cls) return;
    const N = this._rows.length, cls = this._cls, hide = this._hideCls;
    let any = false;
    for (let k = 0; k < hide.length; k++) if (hide[k] === 1) any = true;
    if (!any && this._starlink === 0) { geo.setIndex(null); geo.setDrawRange(0, Infinity); return; }
    if (!this._idxAttr) this._idxAttr = new THREE.BufferAttribute(new Uint32Array(N), 1);
    const arr = this._idxAttr.array;
    let n = 0;
    if (hide[CLS_STARLINK] !== 1) for (let i = 0; i < N; i++) if (cls[i] === CLS_STARLINK) arr[n++] = i;
    for (let i = 0; i < N; i++) if (cls[i] !== CLS_STARLINK && hide[cls[i]] !== 1) arr[n++] = i;
    this._idxAttr.needsUpdate = true;
    geo.setIndex(this._idxAttr);
    geo.setDrawRange(0, n);
  }

  /* --- floor 4 look (lane sky-look-1121): how heavy objects stand out; 'b' by default, the other variants dev-only, see SkyLook.js --- */

  /** The variant now drawn ('0' = the old fixed-size dots, also before the data loads; 'b' the default once it has). */
  lookId() { return this._lookId; }

  /** The look's Points (one per dot size, the ring Points last), for probes and tests. */
  lookPoints() { return this._lookGroups.map((g) => g.pts); }

  /**
   * Switch the floor 4 dots to a variant in place (same dots, no reload). `window.__skyLook` calls this on a dev host only.
   * @param {string} id one of LOOK_IDS @returns {boolean} false for an unknown id or before the data has loaded
   */
  setLook(id) {
    if (!LOOK_IDS.includes(id) || this._loadState !== 'ready' || !this._lookBaseCol) return false;
    this._lookId = id;
    this._lookBuild();
    this._apply();
    return true;
  }

  /** (Re)build the current variant's per-row sizes and its Points. */
  _lookBuild() {
    this._lookDrop();
    if (this._loadState !== 'ready' || !this._lookBaseCol) return;
    const glass = this._isGlass();
    const data = buildLook(this._lookId, this._rows, glass, this._lookBaseCol);
    this._lookData = data;
    this._lookGlass = glass;
    if (this._lookId === '0') { this._lookReindex(); return; }
    const N = this._rows.length;
    const colAttr = data.col === this._lookBaseCol ? this._geo.getAttribute('color') : new THREE.BufferAttribute(data.col, 3);
    const sizes = [...new Set(data.px)].sort((a, b) => a - b);
    sizes.forEach((size, k) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', this._posAttr);   // the one shared, carried-forward position buffer
      geo.setAttribute('color', colAttr);
      const idx = new THREE.BufferAttribute(new Uint32Array(N), 1);
      geo.setIndex(idx);
      geo.setDrawRange(0, 0);
      // a dot bigger than today's is drawn round (a plain Points is a square): a soft-edged disc map; today's size stays a plain square
      const opts = { size, sizeAttenuation: false, vertexColors: true, depthWrite: false };
      if (size > (glass ? DOT_PX_GLASS : DOT_PX)) {
        const tex = new THREE.DataTexture(dotTextureBytes(32, size), 32, 32, THREE.RGBAFormat);
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this._lookTexs.push(tex);
        opts.map = tex; opts.transparent = true; opts.alphaTest = 0.02;
      }
      const mat = new THREE.PointsMaterial(opts);
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT + 0.001 * (k + 1);   // the bigger the dot, the later it is drawn
      pts.visible = false;
      pts.name = `real-sky-look-${size}`;
      this._lookGroups.push({ size, pts, geo, idx });
    });
    if (data.ringCol) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', this._posAttr);
      geo.setAttribute('color', new THREE.BufferAttribute(data.ringCol, 3));
      const idx = new THREE.BufferAttribute(new Uint32Array(N), 1);
      geo.setIndex(idx);
      geo.setDrawRange(0, 0);
      this._lookTex = new THREE.DataTexture(ringTextureBytes(32), 32, 32, THREE.RGBAFormat);
      this._lookTex.minFilter = THREE.LinearFilter; this._lookTex.magFilter = THREE.LinearFilter; this._lookTex.generateMipmaps = false;
      this._lookTex.needsUpdate = true;
      const mat = new THREE.PointsMaterial({ size: data.ringPx, sizeAttenuation: false, vertexColors: true, map: this._lookTex, transparent: true, alphaTest: 0.05, depthWrite: false });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT + 0.0005;   // under the dots
      pts.visible = false;
      pts.name = 'real-sky-look-rings';
      this._lookRing = { pts, geo, idx };
      this._lookGroups.push({ size: -1, pts, geo, idx, ring: true });
    }
    for (const g of this._lookGroups) if (this._scene && this._scene.add) this._scene.add(g.pts);
    this._lookReindex();
  }

  /** Which rows each look Points draws, kept in step with the hidden kinds; Starlink first inside a size (drawn under the rest), as `_applyHiddenDraw`. */
  _lookReindex() {
    const data = this._lookData;
    if (!data || !this._cls || this._lookGroups.length === 0) return;
    const N = this._rows.length, cls = this._cls, hide = this._hideCls;
    const bySize = new Map(this._lookGroups.filter((g) => !g.ring).map((g) => [g.size, g]));
    const counts = new Map();
    for (const g of this._lookGroups) counts.set(g, 0);
    const put = (g, i) => { const n = counts.get(g); g.idx.array[n] = i; counts.set(g, n + 1); };
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < N; i++) {
        const isSl = cls[i] === CLS_STARLINK;
        if ((pass === 0) !== isSl || hide[cls[i]] === 1) continue;
        put(bySize.get(data.px[i]), i);
        if (this._lookRing && data.ring[i]) put(this._lookGroups[this._lookGroups.length - 1], i);
      }
    }
    for (const g of this._lookGroups) { g.idx.needsUpdate = true; g.geo.setDrawRange(0, counts.get(g)); }
  }

  /** Remove the look's Points from the scene and free them. The position and colour buffers shared with today's Points are taken off the look's
   *  geometries first: `geometry.dispose()` frees every attribute it still holds, and a freed shared buffer would freeze today's dots. */
  _lookDrop() {
    const sharedCol = this._geo ? this._geo.getAttribute('color') : null;
    for (const g of this._lookGroups) {
      if (this._scene && this._scene.remove) this._scene.remove(g.pts);
      g.geo.deleteAttribute('position');
      if (sharedCol && g.geo.getAttribute('color') === sharedCol) g.geo.deleteAttribute('color');
      g.geo.dispose(); g.pts.material.dispose();
    }
    if (this._lookTex) { this._lookTex.dispose(); this._lookTex = null; }
    for (const t of this._lookTexs) t.dispose();
    this._lookTexs = [];
    this._lookGroups = []; this._lookRing = null; this._lookData = null;
  }

  /**
   * The clutter measure of the dots as the camera sees them now (floor 4 view; same projection and behind-Earth test as `_pick4`; hidden kinds
   * left out). `window.__skyLookStats` calls this on a dev host only.
   * @returns {{look:string, glass:boolean, dots:number, coverPct:number, overlapPct:number, heavy:number, heavyHiddenPct:number, heavyOverlappedPct:number}|null}
   */
  lookStats() {
    if (this._loadState !== 'ready' || !this._lookBaseCol) return null;
    const cam = this._viewProj();
    if (!cam) return null;
    if (!this._lookData || this._lookGlass !== this._isGlass()) {
      if (this._lookId === '0') { this._lookData = buildLook('0', this._rows, this._isGlass(), this._lookBaseCol); this._lookGlass = this._isGlass(); }
      else this._lookBuild();
    }
    const data = this._lookData;
    const v = this._getViewport(), W = v.w, H = v.h;
    const m = this._vp.elements, cp = cam.position;
    const pos = this._pos, N = this._rows.length, RE = Constants.EARTH_RADIUS, hide = this._hideCls, cls = this._cls;
    const pts = [];
    for (let i = 0; i < N; i++) {
      if (hide[cls[i]] === 1) continue;
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (!(w > 1e-9)) continue;
      const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * W;
      const sy = (-(m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5) * H;
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
      const ex = px - cp.x, ey = py - cp.y, ez = pz - cp.z;
      const a = ex * ex + ey * ey + ez * ez;
      const b = cp.x * ex + cp.y * ey + cp.z * ez;
      const c = cp.x * cp.x + cp.y * cp.y + cp.z * cp.z - RE * RE;
      const disc = b * b - a * c;
      if (disc > 0) { const t1 = (-b - Math.sqrt(disc)) / a; if (t1 > 0 && t1 < 1) continue; }
      pts.push({ x: sx, y: sy, r: data.px[i] * 0.5, heavy: data.heavy[i] === 1, ringR: data.ring[i] ? data.ringPx * 0.5 : 0, i });
    }
    // draw order, as the look's Points are drawn: the bigger size later, Starlink first inside a size, then by row (`_lookReindex`)
    const sl = (p) => (cls[p.i] === CLS_STARLINK ? 0 : 1);
    pts.sort((p, q) => (p.r - q.r) || (sl(p) - sl(q)) || (p.i - q.i));
    return { look: this._lookId, glass: this._isGlass(), ...measureClutter(pts, W, H) };
  }

  /** Search by name or NORAD number: opens the best match's card, highlights its dot (also for a hidden kind: an explicit ask); on floor 4 the globe turns to it. @returns {number} row index or -1 */
  search(query) {
    if (this._loadState !== 'ready') return -1;
    const i = searchRows(this._rows, query);
    if (i >= 0) { this.select(i); this.flyTo(i); }
    else if (this._card && this._card.setNoMatch) this._card.setNoMatch(String(query == null ? '' : query).trim());
    return i;
  }

  dispose() {
    this._lookDrop();
    if (this._scene && this._scene.remove) {
      for (const o of [this._points, this._hiPoints, this._orbitLine]) if (o) this._scene.remove(o);
    }
    for (const o of [this._points, this._hiPoints, this._orbitLine]) {
      if (o) { o.geometry.dispose(); o.material.dispose(); }
    }
    if (this._orbitShadow) this._orbitShadow.material.dispose();   // its geometry is the ring's, disposed above
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null; this._ctx = null;
    this.hoverClear();
    for (const o of [this._hoverRing, this._hoverLabel]) if (o && o.parentNode) o.parentNode.removeChild(o);
    this._hoverRing = null; this._hoverLabel = null;
    this._hoverResetShown();
  }

  /* --- opening dive (lane sky-dive-1118) ---
   * The opening dive (test switch ?dive=1, ui/OpeningDive.js) flies the camera from the globe down to the ship through the real
   * dots. No floor holds the layer then (`_floor` is null), so these methods carry the dots: `diveBegin()` turns them on at
   * opacity 0, `diveSetAlpha(a)` fades them, `diveTick()` moves them (update() returns early without a floor), `diveEnd()`
   * puts everything back to today's floor 4-5 rules. The material is only made transparent in here and restored by diveEnd(). */

  /** Start the one fetch of data/sky.json now (the switch-on menu start calls it); never waits. @returns {Promise} */
  preload() {
    if (this._loadState === 'idle' || this._loadState === 'failed') this._loadPromise = this._load();
    return this._loadPromise || Promise.resolve();
  }

  /** True from diveBegin() to diveEnd(). */
  diveOn() { return this._dive === true; }

  /** The dots' current dive opacity (0..1). */
  diveAlpha() { return this._diveAlpha > 0 ? this._diveAlpha : 0; }

  diveBegin() {
    this._dive = true;
    this._diveAlpha = 0;
    this.preload();
    this._diveMaterial(0);
    this._apply();
  }

  /** Set the dots' opacity (0 hides them). Re-applies the gates when the dots turn on or off. */
  diveSetAlpha(a) {
    if (this._dive !== true) return;
    const v = a > 0 ? (a < 1 ? a : 1) : 0;
    const flip = (v > 0) !== (this._diveAlpha > 0);
    this._diveAlpha = v;
    this._diveMaterial(v);
    if (flip) this._apply();
  }

  /** One frame of the dive: propagate and draw the dots at the sky's current time. No-op until the data is ready. */
  diveTick() {
    if (this._dive !== true || this._loadState !== 'ready') return;
    this._propagateBatch(this.skySeconds());
  }

  diveEnd() {
    if (this._dive !== true) return;
    this._dive = false;
    this._diveAlpha = 0;
    if (this._points) {
      const m = this._points.material;
      if (m.transparent || m.opacity !== 1) { m.transparent = false; m.opacity = 1; m.needsUpdate = true; }
    }
    this._apply();
  }

  /** @private the dots' material for opacity `v`: transparent only while the dive runs. */
  _diveMaterial(v) {
    if (!this._points) return;
    const m = this._points.material;
    if (m.transparent !== true) { m.transparent = true; m.needsUpdate = true; }
    m.opacity = v * DIVE_PEAK;
  }
}
