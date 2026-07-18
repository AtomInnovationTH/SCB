/**
 * HintTicker.js — Bottom-screen single-line onboarding hint presenter
 *
 * Delegation 2 onboarding (2026-05-31). A stateless presenter driven entirely
 * by EventBus messages:
 *   • Events.HINT_POSTED     — show a new hint on the LEFT (latest, brightest)
 *   • Events.HINT_SATISFIED  — fade and remove a hint by `id`
 *   • Events.SKILL_STATE_CHANGED — when the related skillId reaches `practiced`
 *                                  state, the matching hint fades on its own.
 *
 * Layout: fixed strip ~36 px tall, anchored 88 px above viewport bottom
 * (above the existing notification slot at the very bottom).  The latest hint
 * lives on the LEFT — bright cyan border, 16 px font, key glyph in a chip.
 * Older hints push RIGHT, each step dimmer + slightly smaller (~13 px, 95 %
 * scale).  At most 4 hints are visible; a 5th displaces the rightmost.  When
 * a hint clears (satisfied / duration / skill practiced), the remaining items
 * shift left over 250 ms.
 *
 * Inline CSS only — matches the project pattern of self-contained UI modules
 * (TeachingOverlay.js, CommsPanel.js).  No new CSS files.
 *
 * @module ui/hud/HintTicker
 */

import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';
import { decorateGlossary } from '../../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from '../glossaryDom.js';

// Lazy DOM probe — checked on each use so Node-side tests can install a
// minimal document shim AFTER the module has been first evaluated.
function _hasDOM() {
  return typeof document !== 'undefined';
}

// Default tuning falls back when Constants.ONBOARDING.TICKER is absent
// (defensive — keeps the module usable in isolated tests).
const DEFAULTS = {
  BOTTOM_PX: 88,
  ROW_HEIGHT_PX: 36,
  MAX_WIDTH_PX: 1100,
  MAX_VISIBLE: 4,
  FADE_OUT_MS: 300,
  SHIFT_MS: 250,
  FONT_LATEST_PX: 16,
  FONT_OLDER_PX: 13,
  SCALE_OLDER: 0.95,
  KEY_CHIP_BG_GAMEPLAY: '#0a2a3a',
  KEY_CHIP_BG_MODIFIER: '#3a2a0a',
  KEY_CHIP_BG_MOUSE: '#2a0a3a',
  ACCENT_BORDER: '#00ccff',
};

function _tuning() {
  const c = (Constants && Constants.ONBOARDING && Constants.ONBOARDING.TICKER) || {};
  return Object.assign({}, DEFAULTS, c);
}

// ───────────────────────────────────────────────────────────────────────────
// HINT TICKER
// ───────────────────────────────────────────────────────────────────────────

export class HintTicker {
  /**
   * @param {HTMLElement} [containerEl] — DOM mount point (defaults to document.body)
   * @param {object}      [opts]
   * @param {object}      [opts.eventBus] — overridable EventBus (tests pass a mock)
   */
  constructor(containerEl, opts = {}) {
    this._container = containerEl || (_hasDOM() ? document.body : null);
    this._eventBus = opts.eventBus || eventBus;
    /** @type {Array<{ id: string, el: HTMLElement, skillId?: string, timer?: number, payload: object }>} */
    this._items = [];
    this._unsubs = [];
    this._disposed = false;

    /** @type {HTMLElement|null} Container strip element */
    this._strip = null;

    this._build();
    this._wireListeners();
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /** Programmatic post (used by tests).  Same payload contract as HINT_POSTED. */
  post(payload) {
    this._onHintPosted(payload);
  }

  /** Programmatic satisfy (used by tests). */
  satisfy(id) {
    this._onHintSatisfied({ id });
  }

  /** Number of currently-visible hint rows. */
  getVisibleCount() {
    return this._items.length;
  }

  /** Returns the DOM strip (for tests). */
  getStripElement() {
    return this._strip;
  }

  /** Returns the array of item ids in left→right order (for tests). */
  getItemIds() {
    return this._items.map(it => it.id);
  }

  /**
   * Clear every visible hint. Wired to GAME_WIN (F3) so a lingering onboarding
   * chip doesn't sit on top of the victory screen. Also usable programmatically.
   */
  clearAll() {
    // Snapshot ids first — _fadeAndRemove mutates this._items in place.
    for (const id of this._items.map(it => it.id)) {
      this._fadeAndRemove(id);
    }
  }

  /** Tear down DOM + EventBus subscriptions. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const it of this._items) {
      if (it.timer != null && typeof clearTimeout === 'function') clearTimeout(it.timer);
    }
    this._items.length = 0;
    for (const u of this._unsubs) {
      if (typeof u === 'function') u();
    }
    this._unsubs.length = 0;
    if (this._strip && this._strip.parentNode) {
      this._strip.parentNode.removeChild(this._strip);
    }
    this._strip = null;
  }

  // ─── INTERNAL — DOM CONSTRUCTION ───────────────────────────────────────

  _build() {
    if (!_hasDOM() || !this._container) return;
    const T = _tuning();
    const strip = document.createElement('div');
    strip.id = 'hud-hint-ticker';
    strip.style.cssText = [
      'position:fixed',
      `bottom:${T.BOTTOM_PX}px`,
      'left:50%',
      'transform:translateX(-50%)',
      `height:${T.ROW_HEIGHT_PX}px`,
      `max-width:${T.MAX_WIDTH_PX}px`,
      'min-width:200px',
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      'gap:8px',
      'pointer-events:none',
      'z-index:8000',
      "font-family:'Courier New', monospace",
      'white-space:nowrap',
      'overflow:hidden',
    ].join(';') + ';';
    this._strip = strip;
    this._container.appendChild(strip);

    // Inline-glossary affordances. The strip is pointer-events:none (click-
    // through); decorated terms re-enable pointer events on themselves (see the
    // body span below) so a click can deep-link, and this delegated handler on
    // the strip catches the bubbled event.
    ensureGlossaryCss();
    delegateGlossaryClicks(strip);
  }

  // ─── INTERNAL — EVENTBUS WIRING ────────────────────────────────────────

  _wireListeners() {
    const eb = this._eventBus;
    if (!eb) return;
    const on = (evt, h) => {
      const u = eb.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };
    on(Events.HINT_POSTED,    (d) => this._onHintPosted(d));
    on(Events.HINT_SATISFIED, (d) => this._onHintSatisfied(d));
    if (Events.SKILL_STATE_CHANGED) {
      on(Events.SKILL_STATE_CHANGED, (d) => this._onSkillStateChanged(d));
    }
    // F3: the game-win screen takes over — drop any lingering hint chips so they
    // don't hover over the victory report.
    if (Events.GAME_WIN) {
      on(Events.GAME_WIN, () => this.clearAll());
    }
  }

  // ─── EVENT HANDLERS ────────────────────────────────────────────────────

  _onHintPosted(payload) {
    if (this._disposed) return;
    if (!payload || !payload.id) return;
    // Idempotent: re-emitting the same id while alive = no-op.
    if (this._items.some(it => it.id === payload.id)) return;
    const T = _tuning();
    const dur = (payload.duration != null) ? payload.duration : (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000);

    const el = this._buildItemElement(payload, /* highlight= */ true);
    const item = {
      id: payload.id,
      el,
      skillId: payload.skillId || null,
      payload,
      timer: null,
    };

    // Insert as LEFT-most (latest); push existing right.
    this._items.unshift(item);
    if (this._strip) {
      this._strip.insertBefore(el, this._strip.firstChild);
    }

    // Brief flash for `priority:'high'`.
    if (payload.priority === 'high' && _hasDOM()) {
      el.style.boxShadow = '0 0 12px rgba(0,204,255,0.55)';
      setTimeout(() => { if (el) el.style.boxShadow = ''; }, 500);
    }

    // Displace 5th-and-beyond from the RIGHT.
    while (this._items.length > T.MAX_VISIBLE) {
      const oldest = this._items.pop();
      if (oldest) this._removeItemElement(oldest, /* fade= */ false);
    }

    // Restyle older entries (font / opacity / scale) — left-to-right.
    this._restyleAll();

    // Auto-expire timer.
    if (typeof setTimeout === 'function' && Number.isFinite(dur) && dur > 0) {
      item.timer = setTimeout(() => this._fadeAndRemove(item.id), dur);
    }
  }

  _onHintSatisfied(payload) {
    if (!payload || !payload.id) return;
    this._fadeAndRemove(payload.id);
  }

  _onSkillStateChanged(payload) {
    if (!payload || !payload.skillId || !payload.to) return;
    // When the related skill becomes 'practiced' (or higher), fade matching hints.
    const reached = (payload.to === 'practiced' || payload.to === 'mastered');
    if (!reached) return;
    const matches = this._items.filter(it => it.skillId === payload.skillId);
    for (const it of matches) this._fadeAndRemove(it.id);
  }

  // ─── ITEM LIFECYCLE ────────────────────────────────────────────────────

  _fadeAndRemove(id) {
    const idx = this._items.findIndex(it => it.id === id);
    if (idx < 0) return;
    const item = this._items[idx];
    if (!item) return;
    if (item.timer != null && typeof clearTimeout === 'function') {
      clearTimeout(item.timer);
      item.timer = null;
    }
    const T = _tuning();
    if (_hasDOM() && item.el) {
      item.el.style.transition = `opacity ${T.FADE_OUT_MS}ms ease-out, transform ${T.SHIFT_MS}ms ease-out`;
      item.el.style.opacity = '0';
    }
    // Remove from array immediately so list logic stays consistent.
    this._items.splice(idx, 1);
    // Physically remove after fade.
    const el = item.el;
    setTimeout(() => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, T.FADE_OUT_MS);
    this._restyleAll();
  }

  /** Force-remove without fade (e.g. displaced by 5th post). */
  _removeItemElement(item, fade = true) {
    if (!_hasDOM()) return;
    if (item.timer != null && typeof clearTimeout === 'function') clearTimeout(item.timer);
    const T = _tuning();
    if (fade && item.el) {
      item.el.style.transition = `opacity ${T.FADE_OUT_MS}ms ease-out`;
      item.el.style.opacity = '0';
      setTimeout(() => {
        if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
      }, T.FADE_OUT_MS);
    } else if (item.el && item.el.parentNode) {
      item.el.parentNode.removeChild(item.el);
    }
  }

  /** Re-apply opacity / font / scale across the row (left = brightest). */
  _restyleAll() {
    if (!_hasDOM()) return;
    const T = _tuning();
    this._items.forEach((it, i) => {
      const isLatest = (i === 0);
      const dimSteps = i; // 0 = brightest, 1..3 = older
      const opacity = Math.max(0.35, 1.0 - dimSteps * 0.18);
      const scale = isLatest ? 1.0 : T.SCALE_OLDER;
      const fontPx = isLatest ? T.FONT_LATEST_PX : T.FONT_OLDER_PX;
      const borderColor = isLatest ? T.ACCENT_BORDER : 'rgba(0,204,255,0.35)';
      const el = it.el;
      el.style.transition = `opacity ${T.SHIFT_MS}ms ease-out, transform ${T.SHIFT_MS}ms ease-out`;
      el.style.opacity = String(opacity);
      el.style.transform = `scale(${scale})`;
      el.style.fontSize = `${fontPx}px`;
      el.style.borderColor = borderColor;
      el.dataset.position = String(i);
    });
  }

  /**
   * Build the DOM for one hint row.
   * @param {object} payload
   * @param {boolean} highlight — whether this slot is the latest (left-most)
   * @returns {HTMLElement}
   */
  _buildItemElement(payload, highlight) {
    const T = _tuning();
    const row = _hasDOM() ? document.createElement('div') : null;
    if (!row) return row;
    row.className = 'hint-ticker-item';
    row.dataset.hintId = payload.id;
    row.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:4px 10px',
      'border:1px solid ' + (highlight ? T.ACCENT_BORDER : 'rgba(0,204,255,0.35)'),
      'border-radius:4px',
      'background:rgba(0,10,20,0.78)',
      'color:#ccddee',
      `font-size:${highlight ? T.FONT_LATEST_PX : T.FONT_OLDER_PX}px`,
      'letter-spacing:0.02em',
      'pointer-events:none',
      'box-shadow:0 0 4px rgba(0,204,255,0.18)',
      'opacity:1',
      'transform:scale(1)',
      'will-change:opacity,transform',
    ].join(';') + ';';

    // Glyph chip (left).
    const chipText = this._resolveGlyph(payload);
    if (chipText) {
      const chip = document.createElement('span');
      chip.textContent = chipText;
      const chipBg = this._chipBg(payload, T);
      chip.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'min-width:24px',
        'height:22px',
        'padding:0 6px',
        'border-radius:3px',
        `background:${chipBg}`,
        'color:#ffffff',
        'font-weight:bold',
        "font-family:'Courier New', monospace",
        'font-size:12px',
        'letter-spacing:0.04em',
      ].join(';') + ';';
      row.appendChild(chip);
    }

    // Body text (right) — inline glossary decorated. `pointer-events:auto`
    // re-enables hit-testing inside the click-through strip so glossary terms
    // are clickable; decorateGlossary escapes the source before wrapping.
    const body = document.createElement('span');
    body.innerHTML = decorateGlossary(payload.text || '', { once: true });
    body.style.cssText = 'color:#ccddee;pointer-events:auto;';
    row.appendChild(body);

    return row;
  }

  _resolveGlyph(payload) {
    if (payload.glyph) return payload.glyph;
    if (Array.isArray(payload.keys) && payload.keys.length > 0) {
      // Friendly fallback: just take first character of first key.
      const k = String(payload.keys[0]);
      // Strip 'Key' prefix from KeyS / KeyD codes.
      if (k.startsWith('Key')) return k.slice(3);
      if (k.startsWith('Arrow')) return '←';
      if (k === 'Space') return '␣';
      if (k === 'Tab') return '⇥';
      if (k === 'Equal') return '+';
      if (k === 'Minus') return '−';
      return k.slice(0, 3);
    }
    return null;
  }

  _chipBg(payload, T) {
    const glyph = (payload.glyph || '').toLowerCase();
    if (glyph.includes('🖱') || glyph.includes('mouse')) return T.KEY_CHIP_BG_MOUSE;
    if (glyph.includes('shift') || glyph.includes('ctrl') || glyph.includes('alt') || glyph.includes('meta')) {
      return T.KEY_CHIP_BG_MODIFIER;
    }
    return T.KEY_CHIP_BG_GAMEPLAY;
  }
}

export default HintTicker;
