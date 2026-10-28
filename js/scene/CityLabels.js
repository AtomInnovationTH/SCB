/**
 * CityLabels.js — Earth city labels (UX-11 #5): each curated city (data/cities.json)
 * is a screen-space HTML dot + name pill. Each frame the city's 3D surface point is
 * projected to screen, so labels keep a constant on-screen size. Far-hemisphere
 * labels are culled; labels fade with camera distance.
 *
 * One instance manages several LAYERS (command-view Earth with the gameplay camera;
 * Strategic Map wireframe Earth with the map camera) so toggle/persistence state is shared.
 *
 * Toggle: 5 key (Events.CITY_LABELS_TOGGLE). ON by default; an explicit hide persists
 * in localStorage.
 *
 * A layer shows iff `_visible && !_suppressed && !_densityHidden` (5-key preference ·
 * F1/F5 suppression · `citypills` density rung). The 5 key ON path clears the density
 * gate (own-key re-reveal; CommsPanel.js `_setupListeners` COMMS_FOCUS, NavSphere.js `toggleMinimized`).
 *
 * Calm labels: (1) within a tier a label shown last frame outranks a hidden one, and a
 * shown label that loses its slot is held 0.5 s before it hides (a per-frame distance
 * sort made same-tier neighbours swap and blink); (2) the layer root is the FIRST child
 * of its container, so HUD panes paint over the pills; (3) attach({ occluders }) hides
 * a dot behind the ship's screen circle; (4) a tier-1 label that loses every pill slot
 * but has a free dot square keeps its dot.
 *
 * Pure helpers (`parseCityList`, `isCityVisible`, `distanceFade`, `compareLabelPriority`,
 * `holdAfterLoss`, `occluderCircle`) are Node-testable; THREE/DOM lives behind init guards.
 *
 * @module scene/CityLabels
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { latLonToPosition } from './Ephemeris.js';
import { StorageKeys } from '../core/StorageKeys.js';
import { fetchData } from '../core/dataUrl.js';
import { MONO_ADVANCE_EM } from '../core/Typeface.js';

/** Hard cap on rendered labels (performance + clutter). */
export const MAX_CITIES = 420;

/**
 * Recognised label categories; unknown/missing kinds fall back to 'city'.
 * 'site' = a human-made facility (Skyroot HQ) — a filled disc, not terrain.
 */
export const CITY_KINDS = ['city', 'launch', 'strait', 'landmark', 'site'];

/** Number of LOD tiers. tier 1 = always shown; higher tiers reveal as the camera zooms in. */
export const TIER_MAX = 3;

/** Marker-dot diameter in CSS px. */
const DOT_PX = 8;

// Screen-space declutter geometry (estimated label box, for collision).
/** Per-character advance for the 12px B612 Mono label text: face advance (Typeface.MONO_ADVANCE_EM 0.65) + 0.5 px
 * letter-spacing. */
const CHAR_PX = 12 * MONO_ADVANCE_EM + 0.5;
/** Per-character advance for the 11px tier-2/3 B612 Mono label text. */
const CHAR_PX_SMALL = 11 * MONO_ADVANCE_EM + 0.5;
/** Fixed label-box width overhead: dot + gap + pill padding (CSS px). */
const LABEL_FIXED_PX = 24;
/** Estimated label-box height in CSS px (one text line + pill padding). */
const LABEL_H_PX = 18;

/**
 * Text-pill placement slots around the anchored dot, evaluated in order. Only the
 * pill moves, never the dot. E = right of the dot (default), W = left, NE/SE =
 * stacked above/below.
 */
export const LABEL_SLOTS = ['E', 'W', 'NE', 'SE'];
/** Vertical offset for the NE/SE slots. Must exceed LABEL_H_PX, else a blocker on E also blocks NE and SE. */
const SLOT_DY = 20;

/**
 * Limb-fade band on the facing dot: hidden at/below LO, fully opaque at/above HI.
 * The pinned path reuses LO as its geometric cutoff — a pinned label skips the
 * dimming but must not render where no other label would appear. Deliberately
 * narrow so a label at the horizon is readable (24 % alpha on the silhouette).
 */
export const LIMB_FADE_LO = 0.03;
export const LIMB_FADE_HI = 0.09;

const STORAGE_KEY = StorageKeys.CITY_LABELS;

/**
 * Per-kind dot/text styling: filled amber disc for cities, hollow amber ring for
 * natural landmarks (settlement vs terrain without a new hue), cyan-white launch
 * pads, pale blue-grey straits.
 */
const KIND_STYLE = {
  city: {
    dot: '#fff3cc',
    dotGlow: '0 0 6px 2px rgba(255,210,90,0.9),0 0 2px 1px rgba(255,235,160,1)',
    text: '#ffedb0',
  },
  landmark: {
    dot: '#fff3cc',
    // Hollow ring reads optically smaller, so it gets a tighter glow.
    dotGlow: '0 0 5px 1px rgba(255,210,90,0.75)',
    text: '#ffedb0',
    ring: true,
  },
  // Human-made facility: the city's filled disc (a ring says "terrain").
  site: {
    dot: '#fff3cc',
    dotGlow: '0 0 6px 2px rgba(255,210,90,0.9),0 0 2px 1px rgba(255,235,160,1)',
    text: '#ffedb0',
  },
  launch: {
    dot: '#e6faff',
    dotGlow: '0 0 7px 2px rgba(80,210,255,0.95),0 0 2px 1px rgba(200,245,255,1)',
    text: '#cfefff',
  },
  strait: {
    dot: '#dbe9ef',
    dotGlow: '0 0 5px 2px rgba(130,190,215,0.75)',
    text: '#dceaf0',
  },
};

/** Resolved dot style for a kind; `ring === true` marks a hollow ring. Unknown kinds fall back to 'city'. */
export function dotStyleFor(kind) {
  return KIND_STYLE[kind] || KIND_STYLE.city;
}

// Module scratch vectors (update() runs every frame; no per-frame allocation).
const _center = new THREE.Vector3();
const _world = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _occV = new THREE.Vector3();

/**
 * Declutter priority comparator (pure): lower tier wins, then a label SHOWN last
 * frame beats a hidden one (a label in its slot-loss grace does not count), then
 * the label nearer the camera. The middle key stops the blink of two same-tier
 * labels at near-equal distance swapping order on a float hair every frame.
 * @param {{tier:number, shown:boolean, _lostAt?:number, _dist:number}} a
 * @param {{tier:number, shown:boolean, _lostAt?:number, _dist:number}} b
 */
export function compareLabelPriority(a, b) {
  return (a.tier - b.tier) || (_incumbent(b) - _incumbent(a)) || (a._dist - b._dist);
}
/**
 * An incumbent is shown AND holding its place. A label in slot-loss grace
 * (`_lostAt >= 0`) is drawn but NOT an incumbent: otherwise two shown labels whose
 * distance order swaps each frame reset each other's grace and neither is ever hidden.
 */
function _incumbent(it) { return it.shown && !(it._lostAt >= 0) ? 1 : 0; }
const _byPriority = compareLabelPriority;

/** How long a shown label may sit without a slot before it is hidden (ms). */
export const SLOT_LOSS_GRACE_MS = 500;

/**
 * Hysteresis for a label shown last frame that found no free slot this frame
 * (pure): stays drawn until it has been without a slot for SLOT_LOSS_GRACE_MS.
 * Limb, off-screen, behind-camera and occluder hides stay immediate.
 * @param {boolean} shown — was displayed last frame
 * @param {number} lostAt — ms timestamp the loss began, or -1 if not losing yet
 * @returns {boolean} true = keep it drawn this frame
 */
export function holdAfterLoss(shown, lostAt, nowMs, graceMs = SLOT_LOSS_GRACE_MS) {
  if (!shown) return false;
  if (lostAt < 0) return true;           // first frame of the loss
  return (nowMs - lostAt) < graceMs;
}

/** Margin (CSS px) around an occluder's screen circle before a dot counts as covered. */
export const OCCLUDER_MARGIN_PX = 4;

/**
 * Screen circle of a world sphere (pure). `ndcX/ndcY` = projected centre,
 * `viewDepth` = distance along the camera axis, `focalPx` = projectionMatrix[5] * H / 2.
 * Writes {x, y, r} in CSS px (origin top-left) into `out`.
 */
export function occluderCircle(out, ndcX, ndcY, viewDepth, radius, focalPx, W, H) {
  out.x = (ndcX * 0.5 + 0.5) * W;
  out.y = (ndcY * -0.5 + 0.5) * H;
  out.r = radius * focalPx / viewDepth;
  return out;
}

/** Is a dot at (sx, sy) inside any of the first `n` screen circles (+margin)? */
export function dotInOccluder(sx, sy, circles, n, marginPx = OCCLUDER_MARGIN_PX) {
  for (let i = 0; i < n; i++) {
    const c = circles[i];
    const dx = sx - c.x, dy = sy - c.y, rr = c.r + marginPx;
    if (dx * dx + dy * dy <= rr * rr) return true;
  }
  return false;
}

const EMPTY = [];

/**
 * The player ship's occluder radius (metres): the farthest any non-FX vertex sits
 * from the ship origin over every reachable radiator pose. MEASURED by
 * tmp/probes/occluder-radius-probe.mjs on `js/test/_flowerFold.js` (orbit hull):
 * 0° folded 2.34 m · 90° 3.16 m · 120° 3.48 m · 146°/160° 3.61 m (tip pads) ·
 * 180° 3.54 m. Poses past 90° are reachable, so the circle covers the 3.61 m peak,
 * rounded up to 3.7 m.
 */
export const SHIP_OCCLUDER_RADIUS_M = 3.7;

/**
 * Validate + clamp a parsed cities.json payload ({ cities: [...] } or bare array).
 * @returns {Array<{name:string, lat:number, lon:number, tier:number, kind:string}>}
 */
export function parseCityList(json, maxCount = MAX_CITIES) {
  const raw = Array.isArray(json) ? json : (json && Array.isArray(json.cities) ? json.cities : []);
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    // Tier clamped to [1, TIER_MAX]; default 2 when missing/invalid.
    const tRaw = Math.round(Number(c.tier));
    const tier = isFinite(tRaw) ? Math.min(Math.max(tRaw, 1), TIER_MAX) : 2;
    const kind = CITY_KINDS.includes(c.kind) ? c.kind : 'city';
    const entry = { name: c.name.trim(), lat, lon, tier, kind };
    // `pin: true`: ignores the zoom-LOD gate and is placed BEFORE every other label
    // (launch pads too), so it never loses a collision. Use sparingly: each pinned
    // label takes a slot from the curated set at far zoom.
    if (c.pin === true) entry.pin = true;
    // Optional pill displacement [dx, dy] in CSS px; the dot stays on the TRUE lat/lon.
    // Separates genuinely-close labels (a city and an airport ~18 km away is ~9 px at the limb).
    if (Array.isArray(c.pillOffsetPx) && c.pillOffsetPx.length === 2) {
      const dx = Number(c.pillOffsetPx[0]), dy = Number(c.pillOffsetPx[1]);
      if (isFinite(dx) && isFinite(dy)) entry.pillOffsetPx = [dx, dy];
    }
    out.push(entry);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Highest LOD tier to show at a camera distance: TIER_MAX at/under `near`, tier 1
 * only at/beyond `far`.
 * @param {number} camDist — camera-to-Earth-center distance (scene units)
 * @returns {number} max tier ∈ [1, TIER_MAX]
 */
export function lodMaxTier(camDist, near, far) {
  return 1 + Math.round(distanceFade(camDist, near, far) * (TIER_MAX - 1));
}

/**
 * Cosine of the angle between a city's surface normal and the direction to the
 * camera: ~1 at the sub-camera point, 0 at the geometric limb, <0 on the far hemisphere.
 */
export function cityFacingDot(cityWorldPos, earthCenter, camPos) {
  const nx = cityWorldPos.x - earthCenter.x;
  const ny = cityWorldPos.y - earthCenter.y;
  const nz = cityWorldPos.z - earthCenter.z;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const cx = camPos.x - cityWorldPos.x;
  const cy = camPos.y - cityWorldPos.y;
  const cz = camPos.z - cityWorldPos.z;
  const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  return (nx * cx + ny * cy + nz * cz) / (nLen * cLen);
}

/**
 * Far-hemisphere cull: visible when the surface normal points toward the camera.
 * @param {number} [threshold=0.05] — small positive bias hides limb labels
 */
export function isCityVisible(cityWorldPos, earthCenter, camPos, threshold = 0.05) {
  return cityFacingDot(cityWorldPos, earthCenter, camPos) > threshold;
}

/**
 * Soft limb fade: smoothstep on the facing dot from 0 (at/over the limb) to 1.
 * @param {number} [lo=LIMB_FADE_LO] @param {number} [hi=LIMB_FADE_HI] — fade band on the dot
 * @returns {number} fade ∈ [0, 1] (0 = hidden beyond the limb)
 */
export function limbFade(cityWorldPos, earthCenter, camPos, lo = LIMB_FADE_LO, hi = LIMB_FADE_HI) {
  const d = cityFacingDot(cityWorldPos, earthCenter, camPos);
  if (d <= lo) return 0;
  if (d >= hi) return 1;
  const t = (d - lo) / (hi - lo);
  return t * t * (3 - 2 * t);   // smoothstep
}

/** Distance fade: 1.0 inside `near`, linear to 0.0 at `far` (scene units). */
export function distanceFade(dist, near, far) {
  if (!(far > near)) return 1;
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  return 1 - (dist - near) / (far - near);
}

/**
 * The text-pill collision box for a label whose dot is at screen (sx, sy), in a
 * slot. CSS px, origin top-left. Pass `out` to reuse an object (hot loop).
 * @param {number} textW — estimated pill width
 * @param {string} slot — one of LABEL_SLOTS
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function slotBox(sx, sy, textW, slot, out, offX = 0, offY = 0) {
  const gap = DOT_PX / 2 + 6;
  let x, y = sy - LABEL_H_PX / 2;
  switch (slot) {
    case 'W':  x = sx - gap - textW; break;
    case 'NE': x = sx + gap; y = sy - LABEL_H_PX / 2 - SLOT_DY; break;
    case 'SE': x = sx + gap; y = sy - LABEL_H_PX / 2 + SLOT_DY; break;
    case 'E':
    default:   x = sx + gap; break;
  }
  const b = out || {};
  b.x = x + offX; b.y = y + offY; b.w = textW; b.h = LABEL_H_PX;
  return b;
}

/**
 * Furthest a label's dot or pill can reach from its anchor, in any slot and with
 * any pill offset — the margin an off-viewport reject must allow.
 * @returns {{x:number, y:number}} half-extents in CSS px
 */
export function labelReach(textW, offX = 0, offY = 0) {
  const gap = DOT_PX / 2 + 6;
  return {
    x: gap + textW + Math.abs(offX) + DOT_PX,
    y: LABEL_H_PX / 2 + SLOT_DY + Math.abs(offY) + DOT_PX,
  };
}

/**
 * Can a label anchored at (sx, sy) put ANY pixel (dot or pill, any slot) inside a
 * W×H viewport? Perspective projection sends points just outside the frustum to
 * enormous coordinates (x ≈ 729518 measured); without this reject they would
 * consume maxVisible slots and DOM writes while invisible.
 * @param {number} W @param {number} H — viewport size in CSS px
 * @returns {boolean}
 */
export function isLabelInViewport(sx, sy, textW, W, H, offX = 0, offY = 0) {
  if (!isFinite(sx) || !isFinite(sy)) return false;
  const r = labelReach(textW, offX, offY);
  return sx > -r.x && sx < W + r.x && sy > -r.y && sy < H + r.y;
}

/**
 * The CSS `transform` moving a label's pill into its slot. The rendered
 * counterpart of `slotBox`; the two MUST agree, else the pill renders where
 * collision did not reserve.
 * @returns {string} CSS transform value
 */
export function slotTransform(slot, textW, offX = 0, offY = 0) {
  const gap = DOT_PX / 2 + 6;
  switch (slot) {
    case 'W':  return `translate(${-(textW + gap) + offX}px, ${offY}px)`;
    case 'NE': return `translate(${gap + offX}px, ${-SLOT_DY + offY}px)`;
    case 'SE': return `translate(${gap + offX}px, ${SLOT_DY + offY}px)`;
    case 'E':
    default:   return `translate(${gap + offX}px, ${offY}px)`;
  }
}

/**
 * Is the whole box inside the W x H viewport? owner 2026-10-21: a label is drawn
 * whole or not at all ("Niagara Falls" read "agara Falls" at the left edge).
 */
export function boxInViewport(b, W, H) {
  return b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H;
}

/** Does ANY slot put the whole pill inside the viewport, with the dot too? If none, the label is not drawn at all. */
export function labelFitsViewport(sx, sy, textW, W, H, offX = 0, offY = 0) {
  _fitDot.x = sx - DOT_PX / 2; _fitDot.y = sy - DOT_PX / 2;
  if (!boxInViewport(_fitDot, W, H)) return false;
  for (const slot of LABEL_SLOTS) {
    slotBox(sx, sy, textW, slot, _fitBox, offX, offY);
    if (boxInViewport(_fitBox, W, H)) return true;
  }
  return false;
}

/** Axis-aligned box overlap. */
function _boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Scratch boxes (no per-frame allocation): pickSlot scan; dot-only free test; labelFitsViewport / held-slot check.
const _scanBox = { x: 0, y: 0, w: 0, h: 0 };
const _dotBox = { x: 0, y: 0, w: DOT_PX, h: DOT_PX };
const _fitDot = { x: 0, y: 0, w: DOT_PX, h: DOT_PX };
const _fitBox = { x: 0, y: 0, w: 0, h: 0 };

/**
 * Is a label held through a short slot loss still drawn WHOLE where it was? Its dot
 * must be fully on screen and, unless a bare dot, so must its pill in the held slot.
 * @param {{_sx:number,_sy:number,w:number,_slot?:string,_dotOnly?:boolean,offX?:number,offY?:number}} item
 * @param {number} W @param {number} H  the viewport
 */
export function heldWhole(item, W, H) {
  _fitDot.x = item._sx - DOT_PX / 2; _fitDot.y = item._sy - DOT_PX / 2;
  if (!boxInViewport(_fitDot, W, H)) return false;
  if (item._dotOnly) return true;
  slotBox(item._sx, item._sy, item.w, item._slot || 'E', _fitBox, item.offX, item.offY);
  return boxInViewport(_fitBox, W, H);
}

/**
 * Pick the first free slot for a label; `prevSlot` is tried first if still
 * collision-free (prevents flicker). `keptBoxes` = already-reserved {x,y,w,h} boxes
 * (pills and dot squares); only the first `keptCount` count. `view` {W,H} rejects
 * pills a screen edge would cut.
 * @returns {string|null} slot name, or null when every slot is blocked
 */
export function pickSlot(sx, sy, textW, keptBoxes, prevSlot = null, keptCount = keptBoxes.length,
                         offX = 0, offY = 0, view = null) {
  const order = prevSlot && LABEL_SLOTS.includes(prevSlot)
    ? [prevSlot, ...LABEL_SLOTS.filter(s => s !== prevSlot)]
    : LABEL_SLOTS;
  for (const slot of order) {
    slotBox(sx, sy, textW, slot, _scanBox, offX, offY);
    if (view && !boxInViewport(_scanBox, view.W, view.H)) continue;
    let blocked = false;
    for (let j = 0; j < keptCount; j++) {
      if (_boxesOverlap(_scanBox, keptBoxes[j])) { blocked = true; break; }
    }
    if (!blocked) return slot;
  }
  return null;
}

// Browser-only past this point.

export class CityLabels {
  constructor() {
    /** @type {Array<{name,lat,lon}>} */
    this._cities = [];
    this._layers = [];
    /** Master visibility: the 5-key preference (persisted; default ON). */
    this._visible = true;
    /** F1/F5 transient hide (LadderController); never persisted, so F7 can't clobber the saved choice. */
    this._suppressed = false;
    /** Ladder `citypills` rung gate (NOT persisted); the 5 key ON path clears it. */
    this._densityHidden = false;
    this._loadPreference();

    eventBus.on(Events.CITY_LABELS_TOGGLE, () => this.toggle());
  }

  isVisible() { return this._visible; }

  /** @returns {boolean} true while the ladder's F7 chart suppresses the pills. */
  isSuppressed() { return this._suppressed; }

  /**
   * Occluder provider for attach({ occluders }): the player ship as one reused sphere.
   * `getPosition` must return the LIVE world position — pass `() => player.position`,
   * not the cloning `player.getPosition()`.
   * @param {() => THREE.Vector3} getPosition
   * @param {number} [radiusM=SHIP_OCCLUDER_RADIUS_M] — metres
   * @returns {() => Array<{position: THREE.Vector3, radius: number}>}
   */
  shipOccluders(getPosition, radiusM = SHIP_OCCLUDER_RADIUS_M) {
    const list = [{ position: null, radius: radiusM * 1e-5 }];   // 1 m = 1e-5 scene units
    return () => {
      list[0].position = getPosition();
      return list[0].position ? list : EMPTY;
    };
  }

  /**
   * Can the pills show at all: the 5-key preference is on and F1/F5 do not suppress
   * them. The ladder's `citypills` step exists only while this is true. Ignores the
   * density gate (the ladder's own bit) and whether a pill is in view this frame.
   */
  canShow() { return this._visible && !this._suppressed; }

  /** @returns {boolean} true while the density ladder's `citypills` rung is hidden. */
  isDensityHidden() { return this._densityHidden; }

  /** @private Combined display gate: 5-key preference · F1/F5 suppression · density. */
  _shouldShow() {
    return this._visible && !this._suppressed && !this._densityHidden;
  }

  /**
   * Transient hide for the Zoom Ladder's F7 (SDA DOWNLINK) chart, where pills read
   * as clutter. Unlike setVisible() this NEVER persists: the 5-key preference owns
   * the resting state.
   * @param {boolean} v
   */
  setSuppressed(v) {
    v = !!v;
    if (v === this._suppressed) return;
    this._suppressed = v;
    for (const layer of this._layers) {
      layer.root.style.display = this._shouldShow() ? 'block' : 'none';
    }
    // update() is skipped while suppressed, so positions are stale on un-suppress.
    if (this._shouldShow()) this.update();
  }

  /**
   * Density-ladder gate for the `citypills` rung; orthogonal to the other two gates.
   * Clearing it re-runs update() when they allow a show (positions went stale).
   * @param {boolean} hidden
   */
  setDensityHidden(hidden) {
    hidden = !!hidden;
    if (hidden === this._densityHidden) return;
    this._densityHidden = hidden;
    for (const layer of this._layers) {
      layer.root.style.display = this._shouldShow() ? 'block' : 'none';
    }
    if (this._shouldShow()) this.update();
  }

  /** Whether the player has ever toggled labels (stored '0' or '1'); gates the first-timer "press 5" hint. */
  hasStoredPreference() {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(STORAGE_KEY) !== null;
      }
    } catch (_) { /* private mode etc. */ }
    return false;
  }

  getCities() { return this._cities; }

  /**
   * Load the curated list. Goes through fetchData so a cache-first Service Worker
   * copy cannot answer it: the label DOM is built once in attach(), so a stale boot
   * is permanent (js/core/dataUrl.js).
   * @returns {Promise<number>} number of cities loaded
   */
  async load(url = 'data/cities.json') {
    try {
      const res = await fetchData(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._cities = parseCityList(await res.json());
    } catch (e) {
      console.warn('[CityLabels] load failed. Labels disabled:', e.message);
      this._cities = [];
    }
    return this._cities.length;
  }

  /**
   * Attach a render layer (one Earth + camera + DOM container).
   * @param {object} opts
   * @param {THREE.Object3D} opts.parent — group/mesh the cities ride with (Earth)
   * @param {number} opts.radius — sphere radius in the parent's local units
   * @param {THREE.Camera} opts.camera — camera used to project city points
   * @param {HTMLElement} opts.container — overlay element labels are appended to
   * @param {Function} [opts.isActive] — () => boolean; layer skipped when false
   * @param {number} [opts.lonOffsetDeg=0] — longitude calibration (degrees), applied after mirroring
   * @param {boolean} [opts.mirrorLon=false] — negate longitude to match a default-SphereGeometry
   *   equirectangular texture (command-view Earth); false for the wireframe Strategic Map
   *   so labels co-locate with ground stations.
   * @param {number} [opts.fadeNear=radius*2] @param {number} [opts.fadeFar=radius*18]
   * @param {number} [opts.lodNear=radius*3] — at/under this camera distance all
   *   tiers show; @param {number} [opts.lodFar=radius*10] — at/over this only tier 1.
   * @param {number} [opts.maxVisible=Infinity] — cap on placed non-launch labels per frame
   * @param {number} [opts.maxVisibleLaunch=Infinity] — separate cap for launch pads
   * @param {Function} [opts.occluders] — () => Array<{position: THREE.Vector3
   *   (world), radius: number (scene units)}>; called every frame, must reuse its
   *   objects. A label whose DOT lies inside a projected circle (+OCCLUDER_MARGIN_PX)
   *   is hidden at once. A camera inside the sphere skips it.
   */
  attach({ parent, radius, camera, container, isActive = null,
           lonOffsetDeg = 0, mirrorLon = false,
           fadeNear, fadeFar, lodNear, lodFar,
           maxVisible = Infinity, maxVisibleLaunch = Infinity,
           occluders = null }) {
    if (!parent || !camera || !this._cities.length) return null;
    if (typeof document === 'undefined') return null;

    // Per-layer wrapper: one write shows/hides the layer.
    const root = document.createElement('div');
    root.className = 'sc-city-labels';
    root.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
    root.style.display = this._shouldShow() ? 'block' : 'none';
    // FIRST child of the container: later siblings (HUD panes) paint over the pills
    // by DOM order. No z-index involved.
    if (container) container.insertBefore(root, container.firstChild);

    const items = [];
    // Anchor exactly on the surface: any radial lift would project pins outward from
    // disk-centre, pushing limb/coastal cities into the ocean.
    const surfaceLift = radius;
    for (const city of this._cities) {
      const lonDeg = (mirrorLon ? -city.lon : city.lon) + lonOffsetDeg;
      const pos = latLonToPosition(city.lat, lonDeg, surfaceLift);
      const el = this._makeLabelEl(city.name, city.kind, city.tier);
      root.appendChild(el);
      const tier = city.tier || 2;
      const charPx = tier === 1 ? CHAR_PX : CHAR_PX_SMALL;
      items.push({
        el, textEl: el._textEl, dotEl: el._dotEl, name: city.name, kind: city.kind, tier,
        pin: city.pin === true,
        // Pill displacement; the dot stays on the true point.
        offX: Array.isArray(city.pillOffsetPx) ? city.pillOffsetPx[0] : 0,
        offY: Array.isArray(city.pillOffsetPx) ? city.pillOffsetPx[1] : 0,
        // Estimated pill width (fixed-pitch ⇒ length-proportional).
        w: LABEL_FIXED_PX + city.name.length * charPx,
        anchor: new THREE.Vector3(pos.x, pos.y, pos.z),
        shown: false, _sx: 0, _sy: 0, _op: 1, _dist: 0,
        _slot: null,
        // ms timestamp this shown label lost its pill slot (-1 = not losing); dot drawn with no pill.
        _lostAt: -1, _dotOnly: false,
        // Tier 1 full strength, 2/3 dimmer.
        _opScale: tier === 1 ? 1.0 : (tier === 2 ? 0.85 : 0.70),
        // ms timestamp when the cameo pulse ends (0 = inactive).
        _pulseEnd: 0,
        _pillShadow: el._pillShadow,
      });
    }

    const layer = {
      parent, camera, root, items, isActive,
      // Per-frame declutter scratch (no per-frame allocation).
      _cand: [],
      // Collision-box pool: 2 boxes (pill + dot) per placeable label.
      _kept: [],
      // Occluder provider + screen circles (grown, never shrunk).
      occluders: typeof occluders === 'function' ? occluders : null,
      _occ: [],
      fadeNear: fadeNear != null ? fadeNear : radius * 2,
      fadeFar: fadeFar != null ? fadeFar : radius * 18,
      lodNear: lodNear != null ? lodNear : radius * 3,
      lodFar: lodFar != null ? lodFar : radius * 10,
      maxVisible, maxVisibleLaunch,
    };
    // Pinned labels bypass both caps, so they need boxes on top of the two budgets.
    const pinnedCount = items.reduce((n, it) => n + (it.pin ? 1 : 0), 0);
    const poolSize = 2 * Math.min(
      items.length,
      pinnedCount +
      (isFinite(maxVisible) ? maxVisible : items.length) +
      (isFinite(maxVisibleLaunch) ? maxVisibleLaunch : items.length),
    );
    for (let i = 0; i < poolSize; i++) layer._kept.push({ x: 0, y: 0, w: 0, h: 0 });
    this._layers.push(layer);
    return layer;
  }

  /**
   * Per-frame update: project each city to screen space, apply zoom LOD, cull
   * far-hemisphere / behind-camera labels, position the DOM. Allocation-free.
   * @param {number} [nowMs] — clock for the slot-loss grace (default performance.now())
   */
  update(nowMs) {
    if (!this._shouldShow() || typeof window === 'undefined') return;
    const W = window.innerWidth, H = window.innerHeight;
    const now = nowMs != null ? nowMs
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const layer of this._layers) {
      const active = (!layer.isActive || layer.isActive()) && layer.parent.visible !== false;
      if (layer.root.style.display !== (active ? 'block' : 'none')) {
        layer.root.style.display = active ? 'block' : 'none';
      }
      if (!active) continue;

      const camera = layer.camera;
      // View matrix must be current regardless of render order.
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.getWorldPosition(_cam);
      layer.parent.updateMatrixWorld();
      layer.parent.getWorldPosition(_center);

      const maxTier = lodMaxTier(_cam.distanceTo(_center), layer.lodNear, layer.lodFar);

      // Occluders (the ship): one screen circle each per frame.
      let occN = 0;
      if (layer.occluders) {
        const list = layer.occluders();
        const focalPx = camera.projectionMatrix.elements[5] * H * 0.5;
        for (let i = 0; list && i < list.length; i++) {
          const o = list[i];
          _occV.copy(o.position).applyMatrix4(camera.matrixWorldInverse);
          const depth = -_occV.z;
          // Behind the camera or camera INSIDE the sphere: no silhouette; don't blank the screen.
          if (!(depth > 0) || _occV.length() <= o.radius) continue;
          _proj.copy(o.position).project(camera);
          while (layer._occ.length <= occN) layer._occ.push({ x: 0, y: 0, r: 0 });
          occluderCircle(layer._occ[occN++], _proj.x, _proj.y, depth, o.radius, focalPx, W, H);
        }
      }

      // PASS 1: gather on-screen candidates (LOD + hemisphere + frustum).
      const cand = layer._cand;
      cand.length = 0;
      for (const item of layer.items) {
        // Pinned labels opt out of the LOD gate.
        if (item.tier > maxTier && !item.pin) { this._hide(item); continue; }

        _world.copy(item.anchor);
        layer.parent.localToWorld(_world);

        // Soft limb fade (0 culls the far hemisphere). Pinned labels skip the DIMMING but
        // keep limbFade's `lo` as cutoff: a looser one drew the pinned label alone in a
        // sliver on the horizon silhouette, floating above the ground.
        const lf = item.pin
          ? (cityFacingDot(_world, _center, _cam) > LIMB_FADE_LO ? 1 : 0)
          : limbFade(_world, _center, _cam);
        if (lf <= 0) { this._hide(item); continue; }

        _proj.copy(_world).project(camera);
        if (_proj.z > 1) { this._hide(item); continue; }   // behind the camera

        item._sx = (_proj.x * 0.5 + 0.5) * W;
        item._sy = (_proj.y * -0.5 + 0.5) * H;
        // Off-viewport reject (see isLabelInViewport).
        if (!isLabelInViewport(item._sx, item._sy, item.w, W, H, item.offX, item.offY)) {
          this._hide(item);
          continue;
        }
        if (occN && dotInOccluder(item._sx, item._sy, layer._occ, occN)) {
          this._hide(item);
          continue;
        }
        item._dist = _world.distanceTo(_cam);
        // Pinned labels skip the distance dimming (floor 0.55 otherwise).
        item._op = item.pin
          ? lf
          : (0.55 + 0.45 * distanceFade(item._dist, layer.fadeNear, layer.fadeFar)) * lf;
        cand.push(item);
      }

      // PASS 2: screen-space placement with slots; order per compareLabelPriority.
      cand.sort(_byPriority);
      const kept = layer._kept;
      const view = { W, H };   // the viewport a whole label must fit in
      let keptCount = 0;
      let placedLaunch = 0, placedOther = 0;

      // Free dot square: no reserved pill or dot box overlaps it.
      const dotFree = (item) => {
        _dotBox.x = item._sx - DOT_PX / 2; _dotBox.y = item._sy - DOT_PX / 2;
        for (let j = 0; j < keptCount; j++) if (_boxesOverlap(_dotBox, kept[j])) return false;
        return true;
      };

      // Writes only what changed; no pill when `dotOnly`.
      const draw = (item, slot, dotOnly) => {
        item.el.style.transform =
          `translate(${item._sx.toFixed(1)}px, ${item._sy.toFixed(1)}px) translate(${-DOT_PX / 2}px, -50%)`;
        if (dotOnly !== item._dotOnly) {
          item.textEl.style.display = dotOnly ? 'none' : '';
          item._dotOnly = dotOnly;
        }
        if (!dotOnly && slot !== item._slot) {
          item.textEl.style.transform = slotTransform(slot, item.w, item.offX, item.offY);
          item._slot = slot;
        }
        item.el.style.opacity = (item._op * item._opScale).toFixed(3);
        if (!item.shown) { item.el.style.display = 'flex'; item.shown = true; }

        // Cameo pulse: the fired pad's pill breathes cyan until _pulseEnd (one label at a time).
        if (item._pulseEnd) {
          if (now >= item._pulseEnd) {
            item._pulseEnd = 0;
            item.dotEl.style.transform = '';
            item.textEl.style.boxShadow = item._pillShadow;
          } else {
            const k = 0.5 + 0.5 * Math.sin(now / 150);   // ~1 Hz breathing
            item.dotEl.style.transform = `scale(${(1 + 0.6 * k).toFixed(3)})`;
            item.textEl.style.boxShadow =
              `0 0 ${(5 + 7 * k).toFixed(1)}px ${(1 + 2 * k).toFixed(1)}px rgba(80,210,255,${(0.55 + 0.35 * k).toFixed(3)})`;
          }
        }
      };

      // A label that lost its slot (or cap place). A SHOWN one is held until
      // SLOT_LOSS_GRACE_MS has passed; while held it reserves no box and counts toward
      // no cap. A hidden one stays hidden.
      const lose = (item) => {
        // Held only while that place is still whole on screen.
        if (item.shown && holdAfterLoss(true, item._lostAt, now) && heldWhole(item, W, H)) {
          if (item._lostAt < 0) item._lostAt = now;
          draw(item, item._slot || 'E', item._dotOnly);
        } else {
          this._hide(item);
        }
      };

      // Place one candidate: free slot (with hysteresis), reserve pill box AND dot
      // square, position the DOM. Returns true if placed (counts toward the caps).
      const place = (item) => {
        // Drawn whole or not at all: an edge-cut dot or pill hides the label (no dot-only
        // fallback; that is for a pill blocked by another label).
        if (!labelFitsViewport(item._sx, item._sy, item.w, W, H, item.offX, item.offY)) {
          this._hide(item);
          return false;
        }
        const slot = pickSlot(item._sx, item._sy, item.w, kept, item._slot, keptCount,
                              item.offX, item.offY, view);
        if (slot) {
          // Pill box, then dot square (no pill may cover another entry's dot).
          slotBox(item._sx, item._sy, item.w, slot, kept[keptCount++], item.offX, item.offY);
          const d = kept[keptCount++];
          d.x = item._sx - DOT_PX / 2; d.y = item._sy - DOT_PX / 2; d.w = DOT_PX; d.h = DOT_PX;
          item._lostAt = -1;
          draw(item, slot, false);
          return true;
        }
        // Every pill slot is blocked. A tier-1 label with a free dot square keeps its
        // DOT (Hyderabad lost every slot to the pinned Skyroot HQ). A pill label gets
        // the grace first; a never-pilled label shows at once.
        if (item.tier === 1 && dotFree(item)
            && (item._dotOnly || !item.shown || !holdAfterLoss(true, item._lostAt, now))) {
          const d = kept[keptCount++];
          d.x = item._sx - DOT_PX / 2; d.y = item._sy - DOT_PX / 2; d.w = DOT_PX; d.h = DOT_PX;
          item._lostAt = -1;
          draw(item, null, true);
          return true;
        }
        lose(item);
        return false;
      };

      // PASS 2a-pre: pinned labels go first, outside both budgets (still limb/frustum culled).
      for (const item of cand) {
        if (!item.pin) continue;
        place(item);
      }
      // PASS 2a: launch pads (own budget); they never lose a collision to a city.
      for (const item of cand) {
        if (item.kind !== 'launch' || item.pin) continue;
        if (placedLaunch >= layer.maxVisibleLaunch) { lose(item); continue; }
        if (place(item)) placedLaunch++;
      }
      // PASS 2b: everything else, colliding against the pads' reserved boxes.
      for (const item of cand) {
        if (item.kind === 'launch' || item.pin) continue;
        if (placedOther >= layer.maxVisible) { lose(item); continue; }
        if (place(item)) placedOther++;
      }
    }
  }

  /** @private Hide a label if currently shown (single style write). */
  _hide(item) {
    item._lostAt = -1;
    if (item.shown) { item.el.style.display = 'none'; item.shown = false; }
    // Next show starts fresh (pill, not dot-only).
    if (item._dotOnly) { item.textEl.style.display = ''; item._dotOnly = false; }
    // A pulse must not leave stale glow/scale styles for the next show.
    if (item._pulseEnd) {
      item._pulseEnd = 0;
      item.dotEl.style.transform = '';
      item.textEl.style.boxShadow = item._pillShadow;
    }
  }

  /** Toggle on/off (5 key) — persists and announces the new state. */
  toggle() {
    const turningOn = !this._visible;
    // Own-key re-reveal: 5 ON clears the density gate (CommsPanel.js `_setupListeners`, NavSphere.js `toggleMinimized`); 5 OFF never touches it.
    const wasDensityHidden = turningOn && this._densityHidden;
    if (wasDensityHidden) this._densityHidden = false;
    this.setVisible(!this._visible);
    if (wasDensityHidden) {
      eventBus.emit(Events.HUD_PANE_VISIBILITY, { pane: 'citypills', shown: true });
    }
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: this._visible ? 'City labels ON (5 to hide)' : 'City labels OFF (5 to show)',
      priority: 'info',
      // Reactive: must reach comms even at suppression tier 0 (onboarding / just after Continue).
      _reactive: true,
    });
  }

  /** @param {boolean} v */
  setVisible(v) {
    this._visible = !!v;
    for (const layer of this._layers) {
      layer.root.style.display = this._shouldShow() ? 'block' : 'none';
    }
    this._savePreference();
    if (this._shouldShow()) this.update();
  }

  /** @private */
  _loadPreference() {
    // Default ON: only an explicit '0' (a 5-press to hide) turns labels off.
    try {
      if (typeof localStorage !== 'undefined') {
        this._visible = localStorage.getItem(STORAGE_KEY) !== '0';
        return;
      }
    } catch (_) { /* fall through to default */ }
    this._visible = true;
  }

  /** @private */
  _savePreference() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, this._visible ? '1' : '0');
      }
    } catch (_) { /* private mode etc. — non-fatal */ }
  }

  /**
   * @private Build a label element: marker dot + city name, styled inline. The text
   * span carries the slot `transform`, so it can shift around the dot.
   */
  _makeLabelEl(name, kind = 'city', tier = 1) {
    const style = dotStyleFor(kind);
    const el = document.createElement('div');
    el.className = 'sc-city-label';
    el.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'display:none',
      'align-items:center',
      'pointer-events:none',
      'white-space:nowrap',
    ].join(';');

    const dot = document.createElement('span');
    const dotCss = [
      `width:${DOT_PX}px`, `height:${DOT_PX}px`,
      'border-radius:50%',
      'box-sizing:border-box',        // keep the ring inside DOT_PX (load-bearing)
      `box-shadow:${style.dotGlow}`,
      'flex:0 0 auto',
    ];
    if (style.ring) {
      dotCss.push('background:transparent', `border:1.5px solid ${style.dot}`);
    } else {
      dotCss.push(`background:${style.dot}`);
    }
    dot.style.cssText = dotCss.join(';');

    const text = document.createElement('span');
    text.textContent = name;
    const fontPx = tier === 1 ? 12 : 11;
    text.style.cssText = [
      // Negative margin puts the pill's left edge on the dot centre (sx), so
      // slotTransform()'s offsets are exact and match the slotBox()/pickSlot() collision box.
      `margin-left:${-DOT_PX / 2}px`,
      `font:400 ${fontPx}px/1 var(--font-mono)`,
      'letter-spacing:0.5px',
      `color:${style.text}`,
      // Dark pill keeps the name legible over bright clouds, ice and the sunlit limb.
      'padding:2px 5px',
      'border-radius:3px',
      'background:rgba(4,10,18,0.5)',
      'box-shadow:0 0 0 1px rgba(120,170,150,0.12)',
      'text-shadow:0 1px 2px rgba(0,0,0,0.95),0 0 3px rgba(0,0,0,0.9)',
      'will-change:transform',
    ].join(';');

    el.appendChild(dot);
    el.appendChild(text);
    el._textEl = text;
    el._dotEl = dot;
    el._pillShadow = '0 0 0 1px rgba(120,170,150,0.12)';  // base pill shadow (pulse restores this)
    return el;
  }

  /**
   * Highlight a label (the launch cameo's pad pill breathes cyan). No-op for unknown names.
   * @param {string} name — city name as listed in cities.json
   * @param {number} durationS — seconds
   */
  pulse(name, durationS = 16) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const end = now + durationS * 1000;
    for (const layer of this._layers) {
      for (const item of layer.items) {
        if (item.name === name) item._pulseEnd = end;
      }
    }
  }

  /** Remove all layers + DOM elements. */
  dispose() {
    for (const layer of this._layers) {
      layer.root.remove();
    }
    this._layers = [];
  }
}

/** Singleton (wired in main.js). */
export const cityLabels = new CityLabels();
export default CityLabels;
