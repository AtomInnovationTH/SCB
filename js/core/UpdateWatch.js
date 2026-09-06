/**
 * UpdateWatch.js — the menu "NEW VERSION READY" witness (Session J.5 item 5).
 *
 * The game is a GitHub Pages runtime artifact behind a service worker that
 * installs with skipWaiting() and activates with clients.claim(); HTML, js/
 * and data/ are NETWORK-FIRST, so `location.reload()` IS the update. The
 * running page's own build sha is baked nowhere — the ONE witness is
 * data/build-tag.json (`{ tag, hash, channel, builtAt }`, written into the
 * deploy artifact; gitignored locally, so a 404 must be harmless).
 *
 * THE LAWS
 *  1. ONE TRUTH — the tag file's `hash` decides. A serviceWorker
 *     `controllerchange` is only a reason to re-read the tag, never a verdict.
 *  2. BOOTED OR INERT — start() reads the tag once → `booted`. A 404 / throw
 *     leaves it null and the watcher inert: it NEVER emits against an unknown
 *     baseline. A later check that succeeds while booted is null adopts that
 *     tag as the baseline (a start-like success) and still emits nothing.
 *  3. ONCE PER HASH — a hash that differs from booted.hash emits
 *     Events.UPDATE_AVAILABLE `{ hash, tag, bullets }` exactly once (`_seen`);
 *     the same build never nags twice.
 *  4. FRESH BULLETS ONLY — whats-new.json is re-fetched on a new hash; its
 *     `.bullets` (strings only, at most 3) ride the payload only when the fresh
 *     text differs from the text read at boot — a hotfix that forgot the file
 *     shows the card with NO stale bullets.
 *  5. FLAG-INDEPENDENT — never reads the ladder flag (source-pinned).
 *  6. Every fetch is try/caught; concurrent checks coalesce on one promise;
 *     stop() removes every listener and timer.
 *
 * TRIGGERS (all → check()): entering MENU (immediately, then a repeating poll
 * every POLL_MS while on the menu — leaving MENU stops it); `visibilitychange`
 * → visible (any state); serviceWorker `controllerchange`.
 *
 * Every dep is injected and optional (headless-safe): the test suite drives
 * it with a scripted fetch, fake timers, a fake document / serviceWorker and a
 * recording bus. main.js wiring (construction + `window.__updateWatch`) is the
 * hub's job. Consumer: ui/MenuScreen.js (mounts ui/UpdateCard.js).
 *
 * @module core/UpdateWatch
 */

import { Events } from './Events.js';

/** The watcher's numbers (own-module export; the house rule). */
export const UPDATE_WATCH = Object.freeze({
  /** Menu-only re-check cadence (ms). */
  POLL_MS: 60000,
  /** Both fetches bypass the HTTP cache (the SW's data/ route is network-first anyway). */
  FETCH_OPTS: Object.freeze({ cache: 'no-cache' }),
});

/** Payload bullets: strings only, trimmed, non-empty, at most this many. */
const MAX_BULLETS = 3;

/**
 * Parse a whats-new.json text into its bullets (strings only, max 3).
 * Malformed text → [].
 * @param {string|null} text
 * @returns {string[]}
 */
export function parseBullets(text) {
  if (typeof text !== 'string' || !text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = parsed && Array.isArray(parsed.bullets) ? parsed.bullets : [];
    return list
      .filter((b) => typeof b === 'string' && b.trim().length > 0)
      .slice(0, MAX_BULLETS);
  } catch (_) {
    return [];
  }
}

export class UpdateWatch {
  /**
   * @param {object} [deps]
   * @param {Function} [deps.fetchFn]        (url, opts) → Promise<Response-like { ok, json(), text() }>
   * @param {Function} [deps.now]            clock (ms) — recorded as `lastCheckAt`
   * @param {Function} [deps.setTimeout]     timer pair (the poll)
   * @param {Function} [deps.clearTimeout]
   * @param {object}   [deps.document]       visibilitychange source
   * @param {object}   [deps.serviceWorker]  controllerchange source (navigator.serviceWorker)
   * @param {object}   [deps.eventBus]       { on, off, emit }
   * @param {object}   [deps.events]         the Events table (GAME_STATE_CHANGE, UPDATE_AVAILABLE)
   * @param {string}   [deps.tagUrl]
   * @param {string}   [deps.newsUrl]
   * @param {number}   [deps.pollMs]
   * @param {string}   [deps.menuState]      GameStates.MENU's value (kept a string so this module imports no state machine)
   */
  constructor(deps = {}) {
    const g = globalThis;
    this._fetch = deps.fetchFn || (typeof g.fetch === 'function' ? (u, o) => g.fetch(u, o) : null);
    this._now = deps.now || (() => Date.now());
    this._setTimeout = deps.setTimeout || ((fn, ms) => g.setTimeout(fn, ms));
    this._clearTimeout = deps.clearTimeout || ((id) => g.clearTimeout(id));
    this._doc = deps.document !== undefined ? deps.document : (g.document || null);
    this._sw = deps.serviceWorker !== undefined ? deps.serviceWorker : (g.navigator?.serviceWorker || null);
    this._bus = deps.eventBus || null;
    this._events = deps.events || Events;
    this._tagUrl = deps.tagUrl || './data/build-tag.json';
    this._newsUrl = deps.newsUrl || './data/whats-new.json';
    this._pollMs = deps.pollMs > 0 ? deps.pollMs : UPDATE_WATCH.POLL_MS;
    this._menuState = deps.menuState || 'MENU';

    /** @type {{ hash: string, tag: string }|null} the baseline read at boot (null = inert) */
    this.booted = null;
    /** @type {string|null} whats-new.json text at boot (null = absent) */
    this.bootedNews = null;
    /** @type {number} last check() clock reading */
    this.lastCheckAt = 0;
    this._seen = new Set();
    this._pending = null;
    this._inflight = null;
    this._started = false;
    this._onMenu = false;
    this._pollId = null;
    this._onState = null;
    this._onVisibility = null;
    this._onController = null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Read the baseline (tag once, whats-new once) and arm the three triggers.
   * Idempotent. Resolves when the boot reads settle (never rejects).
   * @returns {Promise<void>}
   */
  start() {
    if (this._started) return this._bootPromise || Promise.resolve();
    this._started = true;
    if (this._bus && this._bus.on) {
      this._onState = (p) => this._onStateChange(p);
      this._bus.on(this._events.GAME_STATE_CHANGE, this._onState);
    }
    if (this._doc && this._doc.addEventListener) {
      this._onVisibility = () => {
        if (this._doc.visibilityState === 'hidden') return;
        this.check();
      };
      this._doc.addEventListener('visibilitychange', this._onVisibility);
    }
    if (this._sw && this._sw.addEventListener) {
      // Law 1: a new controller is a REASON to re-read the tag, not a verdict.
      this._onController = () => { this.check(); };
      this._sw.addEventListener('controllerchange', this._onController);
    }
    this._bootPromise = this._boot();
    return this._bootPromise;
  }

  /** Remove every listener and timer. The baseline and `pending()` survive. */
  stop() {
    this._stopPoll();
    this._onMenu = false;
    if (this._onState && this._bus && this._bus.off) this._bus.off(this._events.GAME_STATE_CHANGE, this._onState);
    if (this._onVisibility && this._doc && this._doc.removeEventListener) this._doc.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onController && this._sw && this._sw.removeEventListener) this._sw.removeEventListener('controllerchange', this._onController);
    this._onState = this._onVisibility = this._onController = null;
    this._started = false;
  }

  /** The last emitted payload (`{ hash, tag, bullets }`) or null — MenuScreen reads it when shown later. */
  pending() { return this._pending; }

  /**
   * Re-read the tag; emit UPDATE_AVAILABLE once per new hash (laws 2–4).
   * Concurrent calls coalesce on the in-flight promise. Never rejects.
   * @returns {Promise<object|null>} the payload emitted by THIS check, else null
   */
  check() {
    if (this._inflight) return this._inflight;
    this._inflight = this._check().catch(() => null).finally(() => { this._inflight = null; });
    return this._inflight;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** @private Law 2: the baseline — tag once (null on 404 / throw), whats-new once. */
  async _boot() {
    const tag = await this._fetchJson(this._tagUrl);
    const hash = tag && typeof tag.hash === 'string' && tag.hash ? tag.hash : null;
    this.booted = hash ? { hash, tag: typeof tag.tag === 'string' ? tag.tag : '' } : null;
    this.bootedNews = await this._fetchText(this._newsUrl);
  }

  /** @private */
  async _check() {
    this.lastCheckAt = this._now();
    if (!this.booted) {
      // Inert until a start-like success establishes a baseline; never emit here.
      await this._boot();
      return null;
    }
    const tag = await this._fetchJson(this._tagUrl);
    const hash = tag && typeof tag.hash === 'string' && tag.hash ? tag.hash : null;
    if (!hash || hash === this.booted.hash || this._seen.has(hash)) return null;
    this._seen.add(hash);                                  // law 3: once per hash
    const news = await this._fetchText(this._newsUrl);     // fresh, 404 → null
    const bullets = (news !== null && news !== this.bootedNews) ? parseBullets(news) : [];   // law 4
    const payload = Object.freeze({ hash, tag: typeof tag.tag === 'string' ? tag.tag : '', bullets });
    this._pending = payload;
    if (this._bus && this._bus.emit) this._bus.emit(this._events.UPDATE_AVAILABLE, payload);
    return payload;
  }

  /** @private GAME_STATE_CHANGE → MENU checks now + polls; anything else stops the poll. */
  _onStateChange(p) {
    const to = p && p.to;
    if (to === this._menuState) {
      if (!this._onMenu) {
        this._onMenu = true;
        this.check();
        this._armPoll();
      }
    } else if (this._onMenu) {
      this._onMenu = false;
      this._stopPoll();
    }
  }

  /** @private One pending timer at a time; re-armed BEFORE the check so the cadence never waits on a fetch. */
  _armPoll() {
    if (this._pollId !== null || !this._onMenu) return;
    this._pollId = this._setTimeout(() => {
      this._pollId = null;
      if (!this._onMenu) return;
      this._armPoll();
      this.check();
    }, this._pollMs);
  }

  /** @private */
  _stopPoll() {
    if (this._pollId !== null) {
      this._clearTimeout(this._pollId);
      this._pollId = null;
    }
  }

  /** @private Law 6: guarded fetch → parsed JSON object, or null on !ok / throw / no fetch. */
  async _fetchJson(url) {
    const j = await this._fetchAs(url, 'json');
    return j && typeof j === 'object' ? j : null;
  }

  /** @private Law 6: guarded fetch → response text, or null on !ok / throw / no fetch. */
  async _fetchText(url) {
    const t = await this._fetchAs(url, 'text');
    return typeof t === 'string' ? t : null;
  }

  /** @private The ONE guarded fetch: `as` = 'json' | 'text'. */
  async _fetchAs(url, as) {
    if (!this._fetch) return null;
    try {
      const r = await this._fetch(url, UPDATE_WATCH.FETCH_OPTS);
      if (!r || !r.ok) return null;
      return await r[as]();
    } catch (_) {
      return null;
    }
  }
}

export default UpdateWatch;
