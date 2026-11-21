/**
 * PageRow.js — the row of pages to the right of the globe (owner 2026-11-20, DECISIONS record §80 rows 2 and 7, §81 row 1;
 * plan sky-1121-top). Floor 4 (the globe) is the top floor of the ladder; floor 5's chart is page 1 of this row, reached only
 * by a swipe, a key or a page dot from floor 4. The code keeps floor 5 as "the row is open" (FloorContract still has five
 * floors): entering any page from the globe goes through the ladder to floor 5 (`enterFloor`), going back to the globe goes
 * back to floor 4 (`leaveFloor`), and every floor-5 content change is answered by the row (`pageActivate` / `pageDeactivate`)
 * instead of by SdaFloor directly, so going straight to page 2 never flashes page 1.
 *
 * Position model: `pos` is a continuous place on the row, 0 = the globe, 1..N = the pages. A page k is drawn at
 * translateX((k - pos) * 100%) of its own width, so a swipe is just `pos` following the finger. With reduced motion there
 * is no slide: `pos` jumps and the page's own opacity transition is the fade.
 *
 * A page (the master-plan interface): `{ id, title, activate(), deactivate(), update(dtMs), elements() }`.
 *   activate   shows the page's DOM and anything it draws; deactivate hides it;
 *   update     once per frame while the page is active; elements() the top-level DOM nodes the row may slide (may be empty).
 *
 * Headless-safe (no document: the dots and the title are never built); every dep is injected and optional.
 *
 * @module ui/PageRow
 */

/** The slide between two places (ms): "about 250 ms" (plan D4). */
export const PAGE_SLIDE_MS = 250;
/** A swipe past this fraction of the width changes page; less springs back (plan D4, a quarter). */
export const SWIPE_COMMIT_FRAC = 0.25;
/** ...or a quick flick faster than this (px per second) changes page whatever the distance. */
export const SWIPE_FLICK_PX_S = 500;
/** Dot touch target (CSS px, at least 44). */
export const DOT_TARGET_PX = 48;
/**
 * Where the dots and the page title sit (CSS px from the bottom edge, centred). Measured 2026-11-21 at 1728x1117 and 1366x1024:
 * the bottom 6-45 px hold the globe's REACH pill and page 1's two source lines, and the top centre holds the CLEARED HUD (a title
 * there was hidden behind it), so the dots sit above the footer band and the title above them.
 */
export const DOTS_BOTTOM_PX = 56;
export const TITLE_BOTTOM_PX = 108;
/** The floors on which the dots show: the globe and the row's floor. */
export const DOT_FLOORS = Object.freeze([4, 5]);
/** The ladder floor the row lives on (floor 5 in the code; the player never sees it as a floor). */
const ROW_FLOOR = 5;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Does a finished swipe change page? Pure.
 * @param {number} frac        distance travelled toward the next place, as a fraction of the width (0..1+)
 * @param {number} pxPerSec    speed toward the next place at release (px/s, positive = toward)
 * @returns {boolean}
 */
export function swipeCommits(frac, pxPerSec = 0) {
  return frac >= SWIPE_COMMIT_FRAC || (frac > 0.04 && pxPerSec >= SWIPE_FLICK_PX_S);
}

/**
 * Page 1: the debris chart (floor 5 as it was), an adapter over SdaFloor. Its look and its Space lens flip are unchanged.
 * @param {object} sdaFloor  SdaFloor (activate/deactivate/update/chart)
 */
export function createDebrisPage(sdaFloor) {
  return {
    id: 'debris',
    title: 'Debris by height',
    activate() { if (sdaFloor && sdaFloor.activate) sdaFloor.activate(); },
    deactivate() { if (sdaFloor && sdaFloor.deactivate) sdaFloor.deactivate(); },
    update() { if (sdaFloor && sdaFloor.isActive && sdaFloor.isActive() && sdaFloor.update) sdaFloor.update(); },
    elements() {
      const c = sdaFloor && sdaFloor.chart && sdaFloor.chart.element ? sdaFloor.chart.element() : null;
      return c ? [c] : [];
    },
  };
}

export class PageRow {
  /**
   * @param {object} deps
   * @param {object[]} deps.pages  page objects in order (page 1 first)
   * @param {function():boolean} [deps.enterFloor]  asks the ladder to go from the globe to the row's floor; false = refused
   * @param {function():boolean} [deps.leaveFloor]  asks the ladder to go back to the globe's floor; false = refused
   * @param {function():boolean} [deps.reducedMotion]  true = no slide
   */
  constructor(deps = {}) {
    this._pages = Array.isArray(deps.pages) ? deps.pages.slice() : [];
    this._enterFloor = typeof deps.enterFloor === 'function' ? deps.enterFloor : null;
    this._leaveFloor = typeof deps.leaveFloor === 'function' ? deps.leaveFloor : null;
    this._reduced = typeof deps.reducedMotion === 'function' ? deps.reducedMotion : () => false;
    /** Committed place: 0 = globe, 1..N = page. */
    this._idx = 0;
    /** Continuous place (what is drawn). */
    this._pos = 0;
    /** Indices of pages whose activate() has run and deactivate() has not. */
    this._active = new Set();
    /** The ladder floor last reported by the controller (null = none / unknown). */
    this._floor = null;
    this._anim = null;   // { from, to, t, dur, leaving }
    this._drag = null;   // { from, to, dir }
    /** A cancelled opening swipe whose ride the ladder would not leave yet: go back to the globe once it can. */
    this._pendingLeave = false;
    this._built = false;
    this._dots = [];
    this._dotsRoot = null;
    this._titleEl = null;
    this._shown = null;
    this._titleShown = null;
  }

  // Reads

  get count() { return this._pages.length; }
  get index() { return this._idx; }
  get pos() { return this._pos; }
  get pages() { return this._pages; }
  /** True while any page (not the globe) is the committed place. */
  isOpen() { return this._idx >= 1; }
  /** The committed page object, or null on the globe. */
  currentPage() { return this._idx >= 1 ? (this._pages[this._idx - 1] || null) : null; }
  pageIds() { return this._pages.map((p) => p.id); }
  isAnimating() { return !!(this._anim || this._drag); }
  isActive(i) { return this._active.has(i); }
  /** The floor the controller reported last. */
  floor() { return this._floor; }

  // Moves (key, dot, swipe, trackpad). Each returns true when something moved.

  /** One place forward: globe -> page 1 -> page 2 ... Nothing past the last page. */
  next() { return this._idx < this._pages.length ? this.goTo(this._idx + 1) : false; }
  /** One place back: page 1 -> the globe. Nothing before the globe. */
  prev() { return this._idx >= 1 ? this.goTo(this._idx - 1) : false; }
  /** Straight back to the globe from any page. On the row's floor with no page committed (a cancelled opening swipe whose
   *  ride was still running when the finger lifted) it still asks the ladder for the globe: never stuck on floor 5. */
  toGlobe() {
    if (this._idx >= 1) return this.goTo(0);
    return this._leaveStray();
  }

  /** Floor 5 with no page committed: ask the ladder back to the globe (false = refused, e.g. still riding). */
  _leaveStray() {
    if (this._floor !== ROW_FLOOR || this._drag) return false;
    this._finishAnim();
    return this._leave(0);
  }

  /**
   * Go to a place. Entering a page from the globe asks the ladder for the row's floor first (refused = nothing changes);
   * going back to the globe asks it for floor 4; between pages the floor stays.
   * @param {number} i  0 = globe, 1..N = page
   */
  goTo(i) {
    if (!Number.isInteger(i) || i < 0 || i > this._pages.length) return false;
    if (i === this._idx) return i === 0 ? this._leaveStray() : false;
    if (!this._onRowFloor()) return false;
    this._cancelDrag();
    const from = this._idx;
    if (from === 0) {
      // globe -> page i: the page slides in from one width to the right even when i > 1.
      // The slide-out of an earlier leave ends BEFORE the new index is set, so no page of it stays on over the globe.
      this._finishAnim();
      this._idx = i;
      this._pos = i - 1;
      if (this._enterFloor && this._enterFloor() === false) { this._hardReset(); return false; }
      this._ensureActive(i);
      this._startAnim(i, false);
      return true;
    }
    if (i === 0) return this._leave(from);
    this._idx = i;
    this._ensureActive(i);
    this._startAnim(i, false);
    return true;
  }

  // The floor handshake (LadderController)

  /**
   * The controller tells the row which floor it is on (every floor apply; null at disengage). The dots show on floors 4 and 5.
   * @param {number|null} floor
   */
  setFloor(floor) {
    this._floor = Number.isFinite(floor) ? floor : null;
    this._syncDots();
  }

  /**
   * Floor 5's content arrives: activate the current page. A row that was not asked (a save, a hook, a script reached floor 5)
   * opens page 1 with no slide. Re-entry while a slide-out is still running ends that slide first.
   */
  pageActivate() {
    if (!this._pages.length) return;
    if (this._anim && this._anim.leaving) this._finishAnim();
    if (this._idx === 0) { this._idx = 1; this._pos = 1; }
    this._ensureActive(this._idx);
    this._apply();
  }

  /**
   * Floor 5's content leaves. After a row-asked leave (toGlobe, a dot, a swipe, a key) the page slides out first and is
   * deactivated when the slide ends; any other way off floor 5 (zoom in, a trip, a menu, a mission) deactivates at once and
   * puts the row back on the globe.
   */
  pageDeactivate() {
    if (this._anim && this._anim.leaving) return;
    this._hardReset();
  }

  /** Everything off, back on the globe, no slide (the ladder disengages: a menu, a trip, a mission). */
  reset() { this._hardReset(); }

  /** Per frame (main loop): advance the slide, then tick the active pages. */
  update(dtMs) {
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (this._pendingLeave && !this._drag) {
      if (this._floor !== ROW_FLOOR) this._pendingLeave = false;   // she is on the globe (or off the ladder) already
      else if (!this._anim && this._leave(0)) this._pendingLeave = false;
    }
    const a = this._anim;
    if (a) {
      a.t += dt;
      const k = a.dur > 0 ? clamp01(a.t / a.dur) : 1;
      this._pos = a.from + (a.to - a.from) * easeInOut(k);
      if (k >= 1) this._finishAnim();
      else this._apply();
    }
    for (const i of this._active) {
      const p = this._pages[i - 1];
      if (p && typeof p.update === 'function') p.update(dt);
    }
  }

  // Swipe following the finger (iPad). dir +1: finger-left, toward the next place; -1: toward the previous one.

  /**
   * A swipe begins. From the globe this takes the ladder to the row's floor right away (the page then follows the finger).
   * @returns {boolean} false when there is no place in that direction, or the ladder refused
   */
  dragBegin(dir) {
    if (dir !== 1 && dir !== -1) return false;
    if (!this._onRowFloor()) return false;
    if (this._drag) return true;
    const from = this._idx;
    const to = from + dir;
    if (to < 0 || to > this._pages.length) return false;
    this._finishAnim();
    if (from === 0) {
      this._idx = to;
      this._pos = 0;
      if (this._enterFloor && this._enterFloor() === false) { this._idx = 0; return false; }
      this._ensureActive(to);
    } else {
      this._ensureActive(to === 0 ? from : to);
    }
    this._drag = { from, to, dir };
    this._apply();
    return true;
  }

  /** @param {number} frac  how far the finger has gone toward the next place, 0..1 (of the width) */
  dragMove(frac) {
    const d = this._drag;
    if (!d) return;
    this._pos = d.from + d.dir * clamp01(frac);
    this._apply();
  }

  /**
   * The finger lifts. `commit` true goes on to the place the swipe was heading for, false springs back.
   * @param {boolean} commit
   */
  dragEnd(commit) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (commit) {
      if (d.to === 0) {
        if (!this._leave(d.from)) this._startAnim(d.from, false);
      } else {
        this._idx = d.to;
        this._startAnim(d.to, false);
      }
      return;
    }
    if (d.from === 0) {
      // an opening swipe that was let go: back to the globe (the ladder goes back too). If the ladder is still on the
      // 4 -> 5 ride it started at the first touch, it refuses; the row then slides the page away and asks again each frame
      // until the ride is over (F1, fix round 1: never left on floor 5 with no page).
      if (!this._leave(1)) {
        this._idx = 0;
        this._pendingLeave = true;
        this._startAnim(0, false);
      }
    } else {
      this._idx = d.from;
      this._startAnim(d.from, false);
    }
  }

  // Internals

  /** The row only moves from the globe's floor or the row's floor (a stub controller that never reports a floor is allowed). */
  _onRowFloor() { return this._floor == null || DOT_FLOORS.includes(this._floor); }

  /**
   * Back to the globe: the slide-out is registered BEFORE the ladder is asked, so the controller's `pageDeactivate` (floor 4's
   * content arriving) sees a row-asked leave and keeps the page on screen until it has slid away. Refused: nothing changes.
   * @param {number} from  the place the row is leaving (its committed index)
   */
  _leave(from) {
    this._idx = 0;
    this._anim = { from: this._pos, to: 0, t: 0, dur: this._reduced() ? 0 : PAGE_SLIDE_MS, leaving: true };
    if (this._leaveFloor && this._leaveFloor() === false) {
      this._anim = null; this._idx = from;
      return false;
    }
    if (this._anim && this._anim.dur === 0) this._finishAnim(); else this._apply();
    return true;
  }

  _cancelDrag() {
    if (!this._drag) return;
    this._drag = null;
  }

  _ensureActive(i) {
    if (i < 1 || this._active.has(i)) return;
    const p = this._pages[i - 1];
    if (!p) return;
    this._active.add(i);
    if (typeof p.activate === 'function') p.activate();
  }

  _deactivatePage(i) {
    if (!this._active.has(i)) return;
    this._active.delete(i);
    const p = this._pages[i - 1];
    if (p) {
      this._clearTransform(p);
      if (typeof p.deactivate === 'function') p.deactivate();
    }
  }

  _startAnim(to, leaving) {
    const reduced = !!this._reduced();
    const dur = reduced ? 0 : PAGE_SLIDE_MS;
    this._anim = { from: this._pos, to, t: 0, dur, leaving: !!leaving };
    if (dur === 0) this._finishAnim();
    else this._apply();
  }

  /** The slide is over: land exactly, drop pages that are no longer on the row's screen. */
  _finishAnim() {
    const a = this._anim;
    this._anim = null;
    if (a) this._pos = a.to;
    if (this._pos === 0 && this._idx === 0) {
      for (const i of Array.from(this._active)) this._deactivatePage(i);
    } else {
      for (const i of Array.from(this._active)) if (i !== this._idx) this._deactivatePage(i);
    }
    this._apply();
  }

  /** Every way off the row that was not the row's own: no slide, everything off, back on the globe. */
  _hardReset() {
    this._anim = null;
    this._drag = null;
    this._pendingLeave = false;
    for (const i of Array.from(this._active)) this._deactivatePage(i);
    this._idx = 0;
    this._pos = 0;
    this._apply();
  }

  _clearTransform(p) {
    if (!p || typeof p.elements !== 'function') return;
    for (const el of p.elements()) if (el && el.style && el.style.transform) el.style.transform = '';
  }

  /** Draw: every active page at its offset; the title of the place nearest to `pos`; the dots. */
  _apply() {
    const reduced = !!this._reduced();
    for (const i of this._active) {
      const p = this._pages[i - 1];
      if (!p || typeof p.elements !== 'function') continue;
      const off = i - this._pos;
      const t = (!reduced && Math.abs(off) > 1e-4) ? `translateX(${(off * 100).toFixed(2)}%)` : '';
      for (const el of p.elements()) if (el && el.style && el.style.transform !== t) el.style.transform = t;
    }
    this._syncDots();
  }

  // Dots and title (DOM)

  _build() {
    if (this._built || typeof document === 'undefined' || !document.body || !document.createElement) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'page-row-dots';
    root.setAttribute && root.setAttribute('role', 'tablist');
    root.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', `bottom:${DOTS_BOTTOM_PX}px`, 'display:none',
      'flex-direction:row', 'align-items:center', 'z-index:36', 'pointer-events:none',
      'font-family:var(--font-mono)',
    ].join(';');
    for (let i = 0; i <= this._pages.length; i++) {
      const hit = document.createElement('div');
      hit.setAttribute && hit.setAttribute('role', 'tab');
      hit.setAttribute && hit.setAttribute('data-page-dot', String(i));
      const label = i === 0 ? 'Globe' : (this._pages[i - 1] && this._pages[i - 1].title) || `Page ${i}`;
      hit.setAttribute && hit.setAttribute('aria-label', label);
      hit.title = label;
      hit.style.cssText = [
        `width:${DOT_TARGET_PX}px`, `height:${DOT_TARGET_PX}px`, 'display:flex', 'align-items:center', 'justify-content:center',
        'pointer-events:auto', 'cursor:pointer', '-webkit-tap-highlight-color:transparent',
      ].join(';');
      const dot = document.createElement('div');
      dot.style.cssText = 'width:9px;height:9px;border-radius:50%;box-sizing:border-box;border:1.5px solid rgba(0,204,255,0.8);background:transparent;transition:background 0.15s';
      hit.appendChild(dot);
      if (typeof hit.addEventListener === 'function') {
        hit.addEventListener('click', (ev) => {
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
          this.goTo(i);
        });
        // a touch or press on a dot is the dot's, never the canvas's
        for (const type of ['touchstart', 'mousedown', 'pointerdown']) {
          hit.addEventListener(type, (ev) => { if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation(); });
        }
      }
      root.appendChild(hit);
      this._dots.push({ hit, dot, filled: null });
    }
    document.body.appendChild(root);
    this._dotsRoot = root;
    const title = document.createElement('div');
    title.id = 'page-row-title';
    title.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', `bottom:${TITLE_BOTTOM_PX}px`, 'display:none',
      'z-index:36', 'pointer-events:none', 'font-family:var(--font-mono)', 'font-size:0.8rem', 'letter-spacing:0.12em',
      'text-transform:uppercase', 'color:rgba(0,204,255,0.85)', 'text-shadow:0 0 6px rgba(0,10,22,0.9)', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(title);
    this._titleEl = title;
  }

  _syncDots() {
    const want = this._floor != null && DOT_FLOORS.includes(this._floor) && this._pages.length > 0;
    if (!this._built) {
      if (!want) return;
      this._build();
      if (!this._built) return;
    }
    if (this._shown !== want) {
      this._shown = want;
      this._dotsRoot.style.display = want ? 'flex' : 'none';
    }
    // The current place: the nearest one to the drawn position
    const near = Math.max(0, Math.min(this._pages.length, Math.round(this._pos)));
    for (let i = 0; i < this._dots.length; i++) {
      const d = this._dots[i];
      const filled = i === near;
      if (d.filled !== filled) {
        d.filled = filled;
        d.dot.style.background = filled ? 'rgba(0,204,255,0.95)' : 'transparent';
      }
    }
    const page = want && near >= 1 ? this._pages[near - 1] : null;
    const text = page ? (page.title || '') : '';
    if (this._titleEl && this._titleShown !== text) {
      this._titleShown = text;
      this._titleEl.textContent = text;
      this._titleEl.style.display = text ? 'block' : 'none';
    }
  }

  /** Tidy the DOM (hot reload, tests). */
  dispose() {
    this._hardReset();
    if (this._dotsRoot && this._dotsRoot.parentNode) this._dotsRoot.parentNode.removeChild(this._dotsRoot);
    if (this._titleEl && this._titleEl.parentNode) this._titleEl.parentNode.removeChild(this._titleEl);
    this._dotsRoot = null; this._titleEl = null; this._dots = []; this._built = false;
  }
}
