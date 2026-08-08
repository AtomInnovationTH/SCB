/**
 * CityLabels.js — Earth city labels (UX-11 #5).
 *
 * Renders each curated city (data/cities.json) as a screen-space HTML label:
 * a small glowing dot anchored to the city's surface point with the name in a
 * crisp 2D overlay beside it. Each frame the city's 3D surface point is
 * projected to screen coordinates (via the layer's camera) and the label DOM
 * element is positioned there — so labels are a constant on-screen size (they
 * never inflate when zooming) and never tilt/float like a 3D billboard.
 * Far-hemisphere labels are culled (dot(surfaceNormal, dirToCamera) <
 * threshold) and fade with camera distance to avoid clutter.
 *
 * One CityLabels instance manages multiple LAYERS — the command-view Earth
 * (js/scene/Earth.js group, projected with the gameplay camera into the
 * #hud-overlay) and the Strategic Map's wireframe Earth (projected with the
 * map camera into the map overlay) — so the toggle/persistence state is shared.
 *
 * Toggle: 5 key (InputManager emits Events.CITY_LABELS_TOGGLE). ON by
 * default (first-timers get reference points immediately); an explicit
 * 5-press to hide persists in localStorage (offline-first).
 *
 * Pure helpers (`parseCityList`, `isCityVisible`, `distanceFade`) are
 * Node-testable; everything THREE/DOM lives behind init guards.
 *
 * @module scene/CityLabels
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { latLonToPosition } from '../ui/StrategicMap.js';
import { StorageKeys } from '../core/StorageKeys.js';
import { fetchData } from '../core/dataUrl.js';

/** Hard cap on rendered labels (performance + clutter). */
export const MAX_CITIES = 420;

/** Recognised label categories; unknown/missing kinds fall back to 'city'. */
export const CITY_KINDS = ['city', 'launch', 'strait', 'landmark'];

/**
 * Number of LOD tiers. tier 1 = always shown (major cities + isolated ocean /
 * remote references), higher tiers reveal progressively as the camera zooms in.
 */
export const TIER_MAX = 3;

/** Marker-dot diameter in CSS px (used to align the label to its surface point). */
const DOT_PX = 8;

// --- Screen-space declutter geometry (estimated label box, for collision) ---
/** Per-character advance for the 12px Courier label text (incl. letter-spacing). */
const CHAR_PX = 7.7;
/** Per-character advance for the 11px tier-2/3 label text. */
const CHAR_PX_SMALL = 7.1;
/** Fixed label-box width overhead: dot + gap + pill padding (CSS px). */
const LABEL_FIXED_PX = 24;
/** Estimated label-box height in CSS px (one text line + pill padding). */
const LABEL_H_PX = 18;

/**
 * Text-pill placement slots around the anchored dot, evaluated in order. The
 * dot never leaves its surface point; only the pill moves, so no leader lines
 * are needed. dx/dy are the pill's top-left offset from the dot centre.
 * E = right of the dot (default), W = left, NE/SE = stacked above/below.
 */
export const LABEL_SLOTS = ['E', 'W', 'NE', 'SE'];
/**
 * Vertical offset for the NE/SE slots. Must exceed LABEL_H_PX so the stacked
 * pills don't self-overlap — otherwise a blocker on E would also block NE and
 * SE, collapsing four genuinely-distinct slots into two.
 */
const SLOT_DY = 20;

/**
 * Limb-fade band on the facing dot: labels are hidden at/below LO and fully
 * opaque at/above HI. Exported as the single source of truth because the pinned
 * path reuses LO as its geometric cutoff — a pinned label skips the dimming but
 * must not render where no other label would appear.
 *
 * The band is deliberately narrow. With the old 0.04–0.16 ramp a label at the
 * horizon sat at 2–16 % alpha — present but unreadable, which is how a city
 * ~1500 km ahead of a low-orbit player looked like a smudge. At 0.03–0.09 the
 * same label reads at 24 % on the silhouette and reaches full strength ~4° of
 * arc sooner, while still fading in softly rather than popping.
 */
export const LIMB_FADE_LO = 0.03;
export const LIMB_FADE_HI = 0.09;

/** localStorage key for the persisted on/off preference. */
const STORAGE_KEY = StorageKeys.CITY_LABELS;

/**
 * Per-kind dot/text styling. Cities keep the filled amber disc; natural
 * landmarks use a hollow amber ring so "settlement" and "terrain" are
 * distinguishable at a glance without adding a fourth hue. Launch pads read as
 * cyan-white infrastructure and straits / chokepoints as pale blue-grey.
 */
const KIND_STYLE = {
  city: {
    dot: '#fff3cc',
    dotGlow: '0 0 6px 2px rgba(255,210,90,0.9),0 0 2px 1px rgba(255,235,160,1)',
    text: '#ffedb0',
  },
  landmark: {
    dot: '#fff3cc',
    // Hollow ring: transparent fill + border. Slightly tighter glow than the
    // filled disc — a ring reads optically smaller, so it needs less halo.
    dotGlow: '0 0 5px 1px rgba(255,210,90,0.75)',
    text: '#ffedb0',
    ring: true,
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

/**
 * Resolved dot style for a kind (pure, Node-testable). `ring === true` marks a
 * hollow-ring dot (landmarks); everything else is a filled disc. Unknown kinds
 * fall back to the filled city style.
 * @param {string} kind
 * @returns {{dot:string, dotGlow:string, text:string, ring?:boolean}}
 */
export function dotStyleFor(kind) {
  return KIND_STYLE[kind] || KIND_STYLE.city;
}

// Module-level scratch vectors — update() runs every frame; no per-frame
// allocations (project scratch-vector discipline).
const _center = new THREE.Vector3();
const _world = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _proj = new THREE.Vector3();

/**
 * Declutter priority comparator: lower tier wins (major cities/landmarks kept
 * first), then the label nearer the camera. Used to decide which label "owns"
 * a screen region when several overlap.
 */
function _byPriority(a, b) {
  return (a.tier - b.tier) || (a._dist - b._dist);
}

// ============================================================================
// PURE HELPERS (Node-safe)
// ============================================================================

/**
 * Validate + clamp a parsed cities.json payload.
 * @param {object|Array} json — parsed JSON ({ cities: [...] } or bare array)
 * @param {number} [maxCount=MAX_CITIES]
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
    // LOD tier: clamp to [1, TIER_MAX]; default 2 (mid) when missing/invalid.
    const tRaw = Math.round(Number(c.tier));
    const tier = isFinite(tRaw) ? Math.min(Math.max(tRaw, 1), TIER_MAX) : 2;
    // Category: unknown/missing → 'city' (keeps every existing entry valid).
    const kind = CITY_KINDS.includes(c.kind) ? c.kind : 'city';
    const entry = { name: c.name.trim(), lat, lon, tier, kind };
    // Optional hard override (`pin: true`): the label ignores the zoom-LOD gate
    // and is placed BEFORE every other label — including launch pads — so it
    // can never lose a screen-space collision. Use sparingly: each pinned label
    // takes a slot away from the recognition-curated set at far zoom.
    if (c.pin === true) entry.pin = true;
    // Optional screen-space pill displacement [dx, dy] in CSS px. The anchor dot
    // stays on the TRUE lat/lon; only the text pill moves. This separates two
    // genuinely-close labels (e.g. a city and an airport ~18 km away, which is
    // ~9 px at the limb) without falsifying either coordinate.
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
 * Highest LOD tier to show at a given camera distance. Reuses the near/far ramp:
 * full detail (TIER_MAX) at/under `near`, down to tier 1 only at/beyond `far`.
 * @param {number} camDist — camera-to-Earth-center distance (scene units)
 * @param {number} near @param {number} far
 * @returns {number} max tier ∈ [1, TIER_MAX]
 */
export function lodMaxTier(camDist, near, far) {
  return 1 + Math.round(distanceFade(camDist, near, far) * (TIER_MAX - 1));
}

/**
 * Cosine of the angle between a city's surface normal and the direction to the
 * camera. ~1 at the sub-camera point, 0 at the geometric limb, <0 on the far
 * hemisphere. Shared by `isCityVisible` and `limbFade`. Plain-object math.
 * @param {{x,y,z}} cityWorldPos @param {{x,y,z}} earthCenter @param {{x,y,z}} camPos
 * @returns {number}
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
 * Far-hemisphere cull: a city is visible when its surface normal points
 * toward the camera.
 * @param {{x,y,z}} cityWorldPos
 * @param {{x,y,z}} earthCenter
 * @param {{x,y,z}} camPos
 * @param {number} [threshold=0.05] — small positive bias hides limb labels
 * @returns {boolean}
 */
export function isCityVisible(cityWorldPos, earthCenter, camPos, threshold = 0.05) {
  return cityFacingDot(cityWorldPos, earthCenter, camPos) > threshold;
}

/**
 * Soft limb fade: instead of a hard cull at the horizon, ramp opacity from 0
 * (at/over the limb) to 1 (a few degrees inside) using a smoothstep on the
 * facing dot. Avoids labels popping in/out as the globe rotates under you.
 * @param {{x,y,z}} cityWorldPos @param {{x,y,z}} earthCenter @param {{x,y,z}} camPos
 * @param {number} [lo=0.04] @param {number} [hi=0.16] — fade band on the dot
 * @returns {number} fade ∈ [0, 1] (0 = hidden beyond the limb)
 */
export function limbFade(cityWorldPos, earthCenter, camPos, lo = LIMB_FADE_LO, hi = LIMB_FADE_HI) {
  const d = cityFacingDot(cityWorldPos, earthCenter, camPos);
  if (d <= lo) return 0;
  if (d >= hi) return 1;
  const t = (d - lo) / (hi - lo);
  return t * t * (3 - 2 * t);   // smoothstep
}

/**
 * Distance fade: 1.0 inside `near`, linear to 0.0 at `far`.
 * @param {number} dist — camera-to-city distance (scene units)
 * @param {number} near @param {number} far
 * @returns {number} opacity ∈ [0, 1]
 */
export function distanceFade(dist, near, far) {
  if (!(far > near)) return 1;
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  return 1 - (dist - near) / (far - near);
}

/**
 * The text-pill collision box for a label whose dot is anchored at screen
 * (sx, sy), in a given slot. Coordinates are CSS px, origin top-left.
 * Pass `out` to write into a reused object (allocation-free in the hot loop);
 * omit it for a fresh object (convenient for tests / one-off callers).
 * @param {number} sx @param {number} sy — dot centre on screen
 * @param {number} textW — estimated pill width
 * @param {string} slot — one of LABEL_SLOTS
 * @param {object} [out] — optional target {x,y,w,h} to mutate and return
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
 * Furthest a label's dot or pill can reach from its anchor, in any slot and
 * with any pill offset — the margin an off-viewport reject must allow.
 * @param {number} textW @param {number} [offX=0] @param {number} [offY=0]
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
 * Can a label anchored at (sx, sy) put ANY pixel — dot or pill, in any slot —
 * inside a W×H viewport? Pure, so the hot loop can reject labels that project
 * off screen before they consume a placement budget slot. Perspective
 * projection sends points just outside the frustum to enormous coordinates
 * (one was measured at x ≈ 729518), and without this they were "placed",
 * counted against maxVisible, and written to the DOM while invisible —
 * starving labels that were actually on screen.
 *
 * @param {number} sx @param {number} sy — anchor in CSS px
 * @param {number} textW — estimated pill width
 * @param {number} W @param {number} H — viewport size in CSS px
 * @param {number} [offX=0] @param {number} [offY=0] — pill offset
 * @returns {boolean}
 */
export function isLabelInViewport(sx, sy, textW, W, H, offX = 0, offY = 0) {
  if (!isFinite(sx) || !isFinite(sy)) return false;
  const r = labelReach(textW, offX, offY);
  return sx > -r.x && sx < W + r.x && sy > -r.y && sy < H + r.y;
}

/**
 * The CSS `transform` that moves a label's text pill into its slot around the
 * anchored dot. Pure and Node-testable — this is the rendered counterpart of
 * `slotBox`'s collision geometry, and the two MUST agree (a desync means the
 * pill renders somewhere the collision system didn't reserve).
 * @param {string} slot — one of LABEL_SLOTS
 * @param {number} textW — estimated pill width (for the W slot)
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

/** Axis-aligned box overlap. */
function _boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Module scratch box for the pickSlot scan loop (no per-frame allocation).
const _scanBox = { x: 0, y: 0, w: 0, h: 0 };

/**
 * Pick the first free slot for a label, honouring hysteresis: if `prevSlot`
 * is still collision-free it is reused (prevents flicker as labels drift).
 * `keptBoxes` is an array-like of {x,y,w,h} already-reserved boxes (text pills
 * and dot squares); only the first `keptCount` entries are considered.
 * Returns the slot name, or null when every slot is blocked.
 * @param {number} sx @param {number} sy @param {number} textW
 * @param {Array<{x,y,w,h}>} keptBoxes
 * @param {string|null} [prevSlot]
 * @param {number} [keptCount=keptBoxes.length]
 * @returns {string|null}
 */
export function pickSlot(sx, sy, textW, keptBoxes, prevSlot = null, keptCount = keptBoxes.length,
                         offX = 0, offY = 0) {
  const order = prevSlot && LABEL_SLOTS.includes(prevSlot)
    ? [prevSlot, ...LABEL_SLOTS.filter(s => s !== prevSlot)]
    : LABEL_SLOTS;
  for (const slot of order) {
    slotBox(sx, sy, textW, slot, _scanBox, offX, offY);
    let blocked = false;
    for (let j = 0; j < keptCount; j++) {
      if (_boxesOverlap(_scanBox, keptBoxes[j])) { blocked = true; break; }
    }
    if (!blocked) return slot;
  }
  return null;
}

// ============================================================================
// CITY LABELS (browser-only past this point)
// ============================================================================

export class CityLabels {
  constructor() {
    /** @type {Array<{name,lat,lon}>} */
    this._cities = [];
    /** @type {Array<object>} attached render layers */
    this._layers = [];
    /** @type {boolean} master visibility (persisted; default ON) */
    this._visible = true;
    this._loadPreference();

    eventBus.on(Events.CITY_LABELS_TOGGLE, () => this.toggle());
  }

  /** @returns {boolean} */
  isVisible() { return this._visible; }

  /**
   * Whether the player has ever explicitly toggled labels (stored '0' or '1').
   * Used to show the one-time "press 5 to hide" hint only to first-timers.
   * @returns {boolean}
   */
  hasStoredPreference() {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(STORAGE_KEY) !== null;
      }
    } catch (_) { /* private mode etc. */ }
    return false;
  }

  /** @returns {Array<{name,lat,lon}>} */
  getCities() { return this._cities; }

  /**
   * Load the curated list (offline-first local JSON, same pattern as the
   * catalog loader). Reads go through fetchData so the request is always
   * version-stamped and a cache-first Service Worker copy cannot answer it —
   * the label DOM is built once in attach(), so a stale boot is permanent.
   * See js/core/dataUrl.js.
   *
   * @param {string} [url='data/cities.json']
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
   *   (e.g. the Strategic Map layer while the map is closed, or the command
   *   layer while the map is open)
   * @param {number} [opts.lonOffsetDeg=0] — optional longitude calibration
   *   (degrees), applied after any mirroring; normally 0.
   * @param {boolean} [opts.mirrorLon=false] — negate longitude so labels match a
   *   default-SphereGeometry equirectangular texture (command-view Earth). Leave
   *   false for the wireframe Strategic Map so labels co-locate with ground stations.
   * @param {number} [opts.fadeNear=radius*2] @param {number} [opts.fadeFar=radius*18]
   * @param {number} [opts.lodNear=radius*3] — at/under this camera distance all
   *   tiers show; @param {number} [opts.lodFar=radius*10] — at/over this only tier 1.
   * @param {number} [opts.maxVisible=Infinity] — cap on placed non-launch labels
   *   per frame (priority-sorted, so the most recognisable survive).
   * @param {number} [opts.maxVisibleLaunch=Infinity] — separate cap for launch
   *   pads, which are placed in a first pass so they never lose a collision.
   */
  attach({ parent, radius, camera, container, isActive = null,
           lonOffsetDeg = 0, mirrorLon = false,
           fadeNear, fadeFar, lodNear, lodFar,
           maxVisible = Infinity, maxVisibleLaunch = Infinity }) {
    if (!parent || !camera || !this._cities.length) return null;
    if (typeof document === 'undefined') return null;

    // A per-layer wrapper so the whole layer can be shown/hidden in one write.
    const root = document.createElement('div');
    root.className = 'sc-city-labels';
    root.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
    root.style.display = this._visible ? 'block' : 'none';
    if (container) container.appendChild(root);

    const items = [];
    // Anchor exactly on the surface. These are 2D DOM overlays (no depth test,
    // so no z-fighting), and any radial lift would project pins outward from
    // disk-centre — pushing limb/coastal cities off the coast into the ocean.
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
        // Data-level declutter/LOD override (see parseCityList).
        pin: city.pin === true,
        // Screen-space pill displacement; the dot stays on the true point.
        offX: Array.isArray(city.pillOffsetPx) ? city.pillOffsetPx[0] : 0,
        offY: Array.isArray(city.pillOffsetPx) ? city.pillOffsetPx[1] : 0,
        // Estimated on-screen pill width (monospace ⇒ length-proportional),
        // used by the screen-space slot placement in update().
        w: LABEL_FIXED_PX + city.name.length * charPx,
        anchor: new THREE.Vector3(pos.x, pos.y, pos.z),
        shown: false, _sx: 0, _sy: 0, _op: 1, _dist: 0,
        _slot: null,
        // Tier-based type hierarchy: tier 1 full strength, 2/3 dimmer.
        _opScale: tier === 1 ? 1.0 : (tier === 2 ? 0.85 : 0.70),
        // Cameo pulse: ms timestamp when the highlight ends (0 = inactive).
        _pulseEnd: 0,
        _pillShadow: el._pillShadow,
      });
    }

    const layer = {
      parent, camera, root, items, isActive,
      // Reusable scratch for the per-frame declutter (no per-frame allocation).
      _cand: [],
      // Preallocated collision-box pool: 2 boxes (pill + dot) per placeable
      // label. Sized to the caps (or the full item count when uncapped).
      _kept: [],
      fadeNear: fadeNear != null ? fadeNear : radius * 2,
      fadeFar: fadeFar != null ? fadeFar : radius * 18,
      lodNear: lodNear != null ? lodNear : radius * 3,
      lodFar: lodFar != null ? lodFar : radius * 10,
      maxVisible, maxVisibleLaunch,
    };
    // Preallocate the box pool (2 per placeable label). Pinned labels bypass
    // both caps, so they need boxes of their own on top of the two budgets.
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
   * Per-frame update: project each city's surface point to screen space, apply
   * zoom-based LOD (hide higher tiers when far), cull far-hemisphere /
   * behind-camera labels, and position the DOM elements. Allocation-free
   * (module scratch vectors). Skipped entirely while hidden; a layer is hidden
   * wholesale when its `isActive` gate is false.
   */
  update() {
    if (!this._visible || typeof window === 'undefined') return;
    const W = window.innerWidth, H = window.innerHeight;
    for (const layer of this._layers) {
      const active = (!layer.isActive || layer.isActive()) && layer.parent.visible !== false;
      if (layer.root.style.display !== (active ? 'block' : 'none')) {
        layer.root.style.display = active ? 'block' : 'none';
      }
      if (!active) continue;

      const camera = layer.camera;
      // Ensure the camera's view matrix is current regardless of render order.
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.getWorldPosition(_cam);
      layer.parent.updateMatrixWorld();
      layer.parent.getWorldPosition(_center);

      // Zoom-based LOD: how detailed a tier to reveal at this camera distance.
      const maxTier = lodMaxTier(_cam.distanceTo(_center), layer.lodNear, layer.lodFar);

      // --- PASS 1: gather on-screen candidates (LOD + hemisphere + frustum) ---
      const cand = layer._cand;
      cand.length = 0;
      for (const item of layer.items) {
        // LOD declutter: hide tiers above the current zoom's threshold. Pinned
        // labels opt out — they stay legible at every zoom.
        if (item.tier > maxTier && !item.pin) { this._hide(item); continue; }

        // City surface point in world space.
        _world.copy(item.anchor);
        layer.parent.localToWorld(_world);

        // Soft limb fade (also culls the far hemisphere when fade reaches 0).
        // Pinned labels skip the DIMMING but keep the same geometric cutoff as
        // everything else (limbFade's `lo`): full strength wherever a normal
        // label would be visible at all, hidden past that. Using a looser cutoff
        // made the pinned label the only thing drawn in a sliver right on the
        // horizon silhouette, which reads as a marker floating above the ground.
        const lf = item.pin
          ? (cityFacingDot(_world, _center, _cam) > LIMB_FADE_LO ? 1 : 0)
          : limbFade(_world, _center, _cam);
        if (lf <= 0) { this._hide(item); continue; }

        // Project to normalised device coords, then to CSS pixels.
        _proj.copy(_world).project(camera);
        if (_proj.z > 1) { this._hide(item); continue; }   // behind the camera

        item._sx = (_proj.x * 0.5 + 0.5) * W;
        item._sy = (_proj.y * -0.5 + 0.5) * H;
        // Off-viewport reject: a point just outside the frustum projects to
        // enormous coordinates, and placing it would burn a maxVisible slot and
        // a DOM write on a label nobody can see (see isLabelInViewport).
        if (!isLabelInViewport(item._sx, item._sy, item.w, W, H, item.offX, item.offY)) {
          this._hide(item);
          continue;
        }
        item._dist = _world.distanceTo(_cam);
        // Pinned labels also skip the distance dimming (floor 0.55 otherwise).
        item._op = item.pin
          ? lf
          : (0.55 + 0.45 * distanceFade(item._dist, layer.fadeNear, layer.fadeFar)) * lf;
        cand.push(item);
      }

      // --- PASS 2: screen-space placement with slots + two-pass pads ---
      // Priority: lower tier first (major cities win), then nearer the camera.
      cand.sort(_byPriority);
      const kept = layer._kept;
      let keptCount = 0;
      let placedLaunch = 0, placedOther = 0;

      // Place one candidate: find a free slot (with hysteresis), reserve its
      // pill box AND its dot square, position the DOM. Returns true if placed.
      // Allocation-free: writes into the preallocated `kept` pool.
      const place = (item) => {
        const slot = pickSlot(item._sx, item._sy, item.w, kept, item._slot, keptCount,
                              item.offX, item.offY);
        if (!slot) { this._hide(item); return false; }
        // Pill box.
        slotBox(item._sx, item._sy, item.w, slot, kept[keptCount++], item.offX, item.offY);
        // Dot square (so no pill covers another entry's dot).
        const d = kept[keptCount++];
        d.x = item._sx - DOT_PX / 2; d.y = item._sy - DOT_PX / 2; d.w = DOT_PX; d.h = DOT_PX;

        // Anchor the marker dot on the surface point; the pill sits in its slot.
        item.el.style.transform =
          `translate(${item._sx.toFixed(1)}px, ${item._sy.toFixed(1)}px) translate(${-DOT_PX / 2}px, -50%)`;
        if (slot !== item._slot) {
          item.textEl.style.transform = slotTransform(slot, item.w, item.offX, item.offY);
          item._slot = slot;
        }
        item.el.style.opacity = (item._op * item._opScale).toFixed(3);
        if (!item.shown) { item.el.style.display = 'flex'; item.shown = true; }

        // Cameo pulse — the fired pad's pill breathes cyan (dot scale + pill
        // glow) until _pulseEnd. At most one label pulses at a time, so the
        // per-frame style writes here cost nothing measurable.
        if (item._pulseEnd) {
          const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (nowMs >= item._pulseEnd) {
            item._pulseEnd = 0;
            item.dotEl.style.transform = '';
            item.textEl.style.boxShadow = item._pillShadow;
          } else {
            const k = 0.5 + 0.5 * Math.sin(nowMs / 150);   // ~1 Hz breathing
            item.dotEl.style.transform = `scale(${(1 + 0.6 * k).toFixed(3)})`;
            item.textEl.style.boxShadow =
              `0 0 ${(5 + 7 * k).toFixed(1)}px ${(1 + 2 * k).toFixed(1)}px rgba(80,210,255,${(0.55 + 0.35 * k).toFixed(3)})`;
          }
        }
        return true;
      };

      // PASS 2a-pre — pinned labels (data-level `pin: true`) are placed before
      // anything else and outside both budgets, so neither the zoom LOD nor a
      // pad's reserved box can hide them. They are still limb/frustum culled.
      for (const item of cand) {
        if (!item.pin) continue;
        place(item);
      }
      // PASS 2a — launch pads first (own budget). They can never lose a
      // collision to a city, which is what keeps Sriharikota beside Chennai.
      for (const item of cand) {
        if (item.kind !== 'launch' || item.pin) continue;
        if (placedLaunch >= layer.maxVisibleLaunch) { this._hide(item); continue; }
        if (place(item)) placedLaunch++;
      }
      // PASS 2b — everything else, colliding against the pads' reserved boxes.
      for (const item of cand) {
        if (item.kind === 'launch' || item.pin) continue;
        if (placedOther >= layer.maxVisible) { this._hide(item); continue; }
        if (place(item)) placedOther++;
      }
    }
  }

  /** @private Hide a label if currently shown (single style write). */
  _hide(item) {
    if (item.shown) { item.el.style.display = 'none'; item.shown = false; }
    // A pulse that outlives visibility must not leave stale glow/scale styles
    // on the element for when it next rotates into view.
    if (item._pulseEnd) {
      item._pulseEnd = 0;
      item.dotEl.style.transform = '';
      item.textEl.style.boxShadow = item._pillShadow;
    }
  }

  /** Toggle on/off (5 key) — persists and announces the new state. */
  toggle() {
    this.setVisible(!this._visible);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: this._visible ? 'City labels ON (5 to hide)' : 'City labels OFF (5 to show)',
      priority: 'info',
      // Reactive: the player just pressed 5. Must reach comms even at
      // suppression tier 0 (onboarding / just after Continue) — the previous
      // `_postOnboarding` tag was muted there, which was the reported bug.
      _reactive: true,
    });
  }

  /** @param {boolean} v */
  setVisible(v) {
    this._visible = !!v;
    for (const layer of this._layers) {
      layer.root.style.display = this._visible ? 'block' : 'none';
    }
    this._savePreference();
    if (this._visible) this.update();
  }

  /** @private */
  _loadPreference() {
    // Default ON: an absent key means the player has never chosen, so show
    // labels (first-timers get reference points immediately). Only an explicit
    // '0' (a 5-press to hide) turns them off, and that choice persists.
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
   * @private Build a screen-space label element: a glowing marker dot followed
   * by the city name. Styled inline (no stylesheet dependency) and sized in CSS
   * px so it stays constant on screen. Positioned each frame by `update()`.
   * The dot is anchored on the surface point; the text span carries a
   * `transform` set by the slot placement, so it can shift around the dot.
   * Landmarks render as a hollow ring dot (terrain) vs the filled city disc.
   */
  _makeLabelEl(name, kind = 'city', tier = 1) {
    const style = dotStyleFor(kind);
    const el = document.createElement('div');
    el.className = 'sc-city-label';
    el.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'display:none',                 // shown by update() once projected on-screen
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
      // Negative margin pulls the pill's base-flow left edge back over the
      // dot's right half so it lands exactly on the dot centre (sx) — making
      // slotTransform()'s from-dot offsets exact and the rendered pill agree
      // with the collision box slotBox()/pickSlot() reserved. (The old
      // margin-left:6px added a second ~10px offset on top of slotTransform,
      // desyncing every slot and overlapping W-slot pills onto their own dot.)
      `margin-left:${-DOT_PX / 2}px`,
      `font:500 ${fontPx}px/1 'Courier New',monospace`,
      'letter-spacing:0.5px',
      `color:${style.text}`,
      // Subtle dark pill keeps the name legible over bright clouds, deserts,
      // ice and the sunlit limb without looking heavy over dark ocean/night.
      'padding:2px 5px',
      'border-radius:3px',
      'background:rgba(4,10,18,0.5)',
      'box-shadow:0 0 0 1px rgba(120,170,150,0.12)',
      'text-shadow:0 1px 2px rgba(0,0,0,0.95),0 0 3px rgba(0,0,0,0.9)',
      // The slot placement moves the pill around the anchored dot.
      'will-change:transform',
    ].join(';');

    el.appendChild(dot);
    el.appendChild(text);
    el._textEl = text;   // exposed for the slot placement in update()
    el._dotEl = dot;     // exposed for the cameo pulse in update()
    el._pillShadow = '0 0 0 1px rgba(120,170,150,0.12)';  // base pill shadow (pulse restores this)
    return el;
  }

  /**
   * Briefly highlight a label — used when the launch cameo fires so the pad's
   * pill breathes cyan for the plume's duration, tying the 3D event to the
   * reference layer ("THAT'S where it launched from"). No-op for unknown names.
   * @param {string} name — city name as listed in cities.json
   * @param {number} durationS — highlight duration in seconds
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
