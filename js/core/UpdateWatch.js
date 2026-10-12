/**
 * UpdateWatch.js — the menu "NEW VERSION READY" witness (Session J.5 item 5;
 * reworked 2026-10-12 for the local-first service worker).
 *
 * The game is a GitHub Pages runtime artifact behind a service worker that
 * STARTS FROM ITS LOCAL COPY, always. A new build installs in the background
 * into its own cache and WAITS (no skipWaiting); it takes over at the next cold
 * start or when the player taps the card (sw-template.js). So "a new version is
 * ready" has exactly one honest meaning: **a new worker is installed and
 * waiting**. A tap posts SKIP_WAITING and reloads on the resulting
 * controllerchange — it always lands the new build (no placebo update).
 *
 * THE LAWS
 *  1. ONE TRUTH — with a service-worker registration, the truth is
 *     `registration.waiting` (the installed, waiting build); a network tag that
 *     merely differs is NEVER enough (a tap would land nothing). Without a
 *     registration (no worker, or localhost dev), data/build-tag.json's `hash`
 *     decides, as before, and a tap is a plain reload. A serviceWorker
 *     `controllerchange` is only a reason to re-check, never a verdict, and
 *     nothing here ever reloads by itself.
 *  2. BOOTED OR INERT (tag path) — start() reads the tag once → `booted`. A 404
 *     / throw leaves it null and the tag path inert: it NEVER emits against an
 *     unknown baseline. A later check that succeeds while booted is null adopts
 *     that tag as the baseline (a start-like success) and still emits nothing.
 *     The worker path needs no baseline.
 *  3. ONCE PER BUILD — a waiting build (keyed on its `appBuild`) or a tag hash
 *     that differs from booted.hash emits Events.UPDATE_AVAILABLE
 *     `{ hash, tag, bullets }` exactly once (`_seen`); the same build never
 *     nags twice.
 *  4. FRESH BULLETS ONLY — whats-new.json is read for the new build (from the
 *     waiting worker's own cache, or over the wire on the tag path); its
 *     `.bullets` (strings only, at most 3) ride the payload only when the fresh
 *     text differs from the text read at boot — a hotfix that forgot the file
 *     shows the card with NO stale bullets.
 *  5. FLAG-INDEPENDENT — never reads the ladder flag (source-pinned).
 *  6. Every read is try/caught; concurrent checks coalesce on one promise
 *     (a check never awaits registration.update() — a hung update on a dead
 *     network must not block the next one — and a worker that never names its
 *     build is given up on after ASK_MS); stop() removes every listener and
 *     timer.
 *
 * TRIGGERS (all → check()): entering MENU (immediately, then a repeating poll
 * every POLL_MS while on the menu — leaving MENU stops it); `visibilitychange`
 * → visible (any state); serviceWorker `controllerchange`; and, with a
 * registration, `updatefound` → the new worker reaching `installed`. Each check
 * also STARTS registration.update() (fire and forget) so the download is
 * under way while the player is on the menu.
 *
 * Every dep is injected and optional (headless-safe): the test suite drives
 * it with a scripted fetch, fake timers, a fake document / serviceWorker /
 * registration and a recording bus. main.js wiring (construction +
 * `window.__updateWatch`) is the hub's job. Consumer: ui/MenuScreen.js (mounts
 * ui/UpdateCard.js; its tap calls applyUpdate below).
 *
 * @module core/UpdateWatch
 */

import { Events } from './Events.js';

/** The watcher's numbers (own-module export; the house rule). */
export const UPDATE_WATCH = Object.freeze({
  /** Menu-only re-check cadence (ms). */
  POLL_MS: 60000,
  /** The tag-path fetches bypass the HTTP cache. */
  FETCH_OPTS: Object.freeze({ cache: 'no-cache' }),
  /** How long a check waits for a waiting worker to name its build (ms). */
  ASK_MS: 3000,
  /** A fresh registration.update() starts only if the last one settled or is older than this (ms). */
  UPDATE_GAP_MS: 10000,
  /** After the tap posts SKIP_WAITING: reload anyway if no controllerchange arrives in this time (ms). */
  APPLY_FALLBACK_MS: 5000,
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

/**
 * Normalize a build hash for comparison (Session J.5 review fix). Dev builds
 * stamp `hash` with a trailing '+' while the tree is dirty (scripts/
 * build-tag.mjs), and the cable server re-stamps on every relaunch — the
 * suffix toggles WITHOUT a deploy. The card's law is "new BUILD", so the
 * suffix never counts. The deployed artifact never carries '+' (publish
 * refuses a dirty tree).
 * @param {*} hash
 * @returns {string|null}
 */
export function cleanHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.replace(/\+$/, '');
  return h || null;
}

/** A JSON object from text, else null. */
function parseObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * TAP TO UPDATE. If a build is installed and waiting, switch to it and reload
 * once it has taken over; otherwise (no worker, none waiting) a plain reload.
 *
 * The order matters: ONE one-time `controllerchange` listener is added FIRST
 * (guarded by `reloading`, so it reloads exactly once), THEN SKIP_WAITING is
 * posted to the waiting worker. If no controllerchange arrives within
 * APPLY_FALLBACK_MS the registration is read again: a worker still waiting gets
 * SKIP_WAITING once more and one more APPLY_FALLBACK_MS; after that (or at once
 * if none waits) the page reloads anyway — a tap must never do nothing, and a
 * reload is never sent before the switch was asked for twice.
 * Nothing else in the game reloads on controllerchange.
 *
 * @param {object} [deps]
 * @param {object}   [deps.serviceWorker]  navigator.serviceWorker
 * @param {Function} [deps.reload]         () → void; the page's one reload site (MenuScreen._reload)
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @param {number}   [deps.fallbackMs]
 * @returns {Promise<'reload'|'switching'>} what the tap did (for tests)
 */
export async function applyUpdate(deps = {}) {
  const g = globalThis;
  const sw = deps.serviceWorker !== undefined ? deps.serviceWorker : (g.navigator?.serviceWorker || null);
  const reload = typeof deps.reload === 'function' ? deps.reload : () => g.location.reload();
  const st = deps.setTimeout || ((fn, ms) => g.setTimeout(fn, ms));
  const ct = deps.clearTimeout || ((id) => g.clearTimeout(id));
  const fallbackMs = deps.fallbackMs > 0 ? deps.fallbackMs : UPDATE_WATCH.APPLY_FALLBACK_MS;

  let waiting = null;
  try {
    const reg = sw && typeof sw.getRegistration === 'function' ? await sw.getRegistration() : null;
    waiting = (reg && reg.waiting) || null;
  } catch (_) { waiting = null; }
  if (!waiting || !sw.addEventListener) {
    reload();
    return 'reload';
  }

  let reloading = false;
  let timer = null;
  const go = () => {
    if (reloading) return;
    reloading = true;
    if (sw.removeEventListener) sw.removeEventListener('controllerchange', go);
    if (timer !== null) ct(timer);
    reload();
  };
  // First wait over with no controllerchange: the message may never have reached
  // the waiting worker, and a reload now could land the OLD build. Look once more;
  // if a worker still waits, post SKIP_WAITING ONE more time and wait one more
  // fallbackMs. Only then (or at once, if nothing waits) reload.
  const retry = async () => {
    if (reloading) return;
    let again = null;
    try {
      const reg = typeof sw.getRegistration === 'function' ? await sw.getRegistration() : null;
      again = (reg && reg.waiting) || null;
    } catch (_) { again = null; }
    if (reloading) return;
    if (!again) { go(); return; }
    timer = st(go, fallbackMs);
    try {
      again.postMessage({ type: 'SKIP_WAITING' });
    } catch (_) {
      go();
    }
  };
  sw.addEventListener('controllerchange', go);
  timer = st(retry, fallbackMs);
  try {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch (_) {
    go();   // could not reach it: reload now rather than strand the tap
  }
  return 'switching';
}

export class UpdateWatch {
  /**
   * @param {object} [deps]
   * @param {Function} [deps.fetchFn]        (url, opts) → Promise<Response-like { ok, json(), text() }>
   * @param {Function} [deps.now]            clock (ms) — recorded as `lastCheckAt`
   * @param {Function} [deps.setTimeout]     timer pair (the poll)
   * @param {Function} [deps.clearTimeout]
   * @param {object}   [deps.document]       visibilitychange source
   * @param {object}   [deps.serviceWorker]  controllerchange source + getRegistration() (navigator.serviceWorker)
   * @param {object}   [deps.caches]         CacheStorage (the waiting build's tag / news are read from its cache)
   * @param {Function} [deps.newChannel]     () → MessageChannel-like { port1, port2 } (asks the waiting worker its build)
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
    this._caches = deps.caches !== undefined ? deps.caches : (g.caches || null);
    this._newChannel = deps.newChannel !== undefined
      ? deps.newChannel
      : (typeof g.MessageChannel === 'function' ? () => new g.MessageChannel() : null);
    // Session J.5 review fix: index.html's corner-stamp fetch and this
    // watcher used to be two independent boot reads of the SAME file — a
    // deploy landing between them split the baselines (corner A, watcher B →
    // the B update never announced). index.html now stashes its promise on
    // `window.__bootBuildTag`; the watcher adopts that ONE read when present.
    this._bootTag = deps.bootTag !== undefined ? deps.bootTag : (() => g.__bootBuildTag || null);
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
    // Worker path (a service-worker registration exists):
    this._reg = null;            // the registration being watched
    this._onFound = null;        // its `updatefound` listener
    this._tracked = new WeakSet();   // installing workers already given a statechange listener
    this._stateListeners = [];   // [[worker, fn]] for stop()
    this._again = false;         // an installed worker arrived while a check was in flight → re-check after it
    this._updating = false;      // a registration.update() is outstanding
    this._updateAt = 0;          // …and was started at this clock reading
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
        if (this._doc.visibilityState === 'hidden') {
          // Review fix: a hidden tab must not keep fetching — the menu poll
          // pauses with the page and re-arms on the visible edge below.
          this._stopPoll();
          return;
        }
        this.check();
        this._armPoll();   // no-op off the menu (_armPoll gates on _onMenu)
      };
      this._doc.addEventListener('visibilitychange', this._onVisibility);
    }
    if (this._sw && this._sw.addEventListener) {
      // Law 1: a new controller is a REASON to re-read the tag, not a verdict.
      this._onController = () => { this.check(); };
      this._sw.addEventListener('controllerchange', this._onController);
    }
    this._bootPromise = this._boot();
    // Listen for a worker installing from the first moment — no check needed.
    this._registration().then((reg) => { if (reg && this._started) this._watch(reg); });
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
    this._unwatch();
    this._started = false;
  }

  /** The last emitted payload (`{ hash, tag, bullets }`) or null — MenuScreen reads it when shown later. */
  pending() { return this._pending; }

  /**
   * With a service-worker registration: start its update (not awaited) and emit
   * UPDATE_AVAILABLE once per WAITING build. Without one: re-read the tag and
   * emit once per new hash (laws 2–4). Concurrent calls coalesce on the
   * in-flight promise. Never rejects.
   * @returns {Promise<object|null>} the payload emitted by THIS check, else null
   */
  check() {
    if (this._inflight) return this._inflight;
    this._again = false;
    this._inflight = this._check().catch(() => null).finally(() => {
      this._inflight = null;
      // A worker finished installing while this check was running: look again.
      if (this._again && this._started) { this._again = false; this.check(); }
    });
    return this._inflight;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** @private Law 2: the baseline — tag once (null on 404 / throw), whats-new once. */
  async _boot() {
    let tag = null;
    try {
      const shared = this._bootTag ? await this._bootTag() : null;
      if (shared && typeof shared === 'object') tag = shared;
    } catch (_) { /* the shared read failed — fall back to our own fetch */ }
    if (!tag) tag = await this._fetchJson(this._tagUrl);
    const hash = cleanHash(tag && tag.hash);
    this.booted = hash ? { hash, tag: typeof tag.tag === 'string' ? tag.tag : '' } : null;
    this.bootedNews = await this._fetchText(this._newsUrl);
  }

  /** @private */
  async _check() {
    this.lastCheckAt = this._now();
    const reg = await this._registration();
    if (reg) return this._checkWorker(reg);
    if (!this.booted) {
      // Inert until a start-like success establishes a baseline; never emit here.
      await this._boot();
      return null;
    }
    const tag = await this._fetchJson(this._tagUrl);
    const hash = cleanHash(tag && tag.hash);   // '+' dirty suffix never counts (review fix)
    if (!hash || hash === this.booted.hash || this._seen.has(hash)) return null;
    this._seen.add(hash);                                  // law 3: once per hash
    const news = await this._fetchText(this._newsUrl);     // fresh, 404 → null
    const bullets = (news !== null && news !== this.bootedNews) ? parseBullets(news) : [];   // law 4
    return this._publish(hash, typeof tag.tag === 'string' ? tag.tag : '', bullets);
  }

  /** @private The ONE emit site: freeze, remember (pending()), announce. */
  _publish(hash, tag, bullets) {
    const payload = Object.freeze({ hash, tag, bullets });
    this._pending = payload;
    if (this._bus && this._bus.emit) this._bus.emit(this._events.UPDATE_AVAILABLE, payload);
    return payload;
  }

  // ── the worker path ───────────────────────────────────────────────────────

  /** @private The page's service-worker registration, or null (no worker API, none registered, or it threw). */
  async _registration() {
    const sw = this._sw;
    if (!sw || typeof sw.getRegistration !== 'function') return null;
    try { return (await sw.getRegistration()) || null; } catch (_) { return null; }
  }

  /**
   * @private One check with a registration: start the update (never awaited),
   * then announce the WAITING build — once per `appBuild` (law 3). Tag and news
   * come from that build's own cache, not the wire.
   */
  async _checkWorker(reg) {
    this._watch(reg);
    this._kickUpdate(reg);
    const waiting = reg.waiting;
    if (!waiting) return null;
    const build = await this._askBuild(waiting);
    const appBuild = build && typeof build.appBuild === 'string' ? build.appBuild : '';
    if (!appBuild || this._seen.has(appBuild)) return null;
    this._seen.add(appBuild);                              // law 3: once per waiting build
    const cacheName = typeof build.cache === 'string' ? build.cache : '';
    const tag = parseObject(await this._cachedText(cacheName, this._tagUrl));
    const news = await this._cachedText(cacheName, this._newsUrl);
    const bullets = (news !== null && news !== this.bootedNews) ? parseBullets(news) : [];   // law 4
    return this._publish(cleanHash(tag && tag.hash) || appBuild, tag && typeof tag.tag === 'string' ? tag.tag : '', bullets);
  }

  /**
   * @private registration.update(), fire and forget. A new one starts only when
   * the previous settled or is older than UPDATE_GAP_MS — a hung update on a
   * dead network is neither awaited nor allowed to starve later checks.
   */
  _kickUpdate(reg) {
    if (typeof reg.update !== 'function') return;
    const now = this._now();
    if (this._updating && now - this._updateAt < UPDATE_WATCH.UPDATE_GAP_MS) return;
    this._updating = true;
    this._updateAt = now;
    try {
      Promise.resolve(reg.update()).catch(() => {}).finally(() => { this._updating = false; });
    } catch (_) {
      this._updating = false;
    }
  }

  /** @private Listen on a registration once: a worker starting to install → follow it to `installed` → re-check. */
  _watch(reg) {
    if (!reg || this._reg === reg) return;
    this._unwatch();
    this._reg = reg;
    if (reg.addEventListener) {
      this._onFound = () => this._follow(reg.installing);
      reg.addEventListener('updatefound', this._onFound);
    }
    this._follow(reg.installing);   // an install already under way when we attached
  }

  /** @private */
  _follow(worker) {
    if (!worker || !worker.addEventListener || this._tracked.has(worker)) return;
    this._tracked.add(worker);
    const onState = () => {
      if (worker.state !== 'installed') return;
      this._again = true;       // if a check is running it reads `waiting` before this worker landed
      this.check();
    };
    worker.addEventListener('statechange', onState);
    this._stateListeners.push([worker, onState]);
  }

  /** @private */
  _unwatch() {
    if (this._reg && this._onFound && this._reg.removeEventListener) this._reg.removeEventListener('updatefound', this._onFound);
    for (const [w, fn] of this._stateListeners) if (w.removeEventListener) w.removeEventListener('statechange', fn);
    this._stateListeners = [];
    this._reg = null;
    this._onFound = null;
  }

  /** @private Ask a waiting worker which build it is: `{ appBuild, cache }`, or null (no answer in ASK_MS / no channel). */
  _askBuild(worker) {
    return new Promise((resolve) => {
      let channel = null;
      try { channel = this._newChannel ? this._newChannel() : null; } catch (_) { channel = null; }
      if (!channel || !worker || typeof worker.postMessage !== 'function') { resolve(null); return; }
      let done = false;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (timer !== null) this._clearTimeout(timer);
        try { if (channel.port1.close) channel.port1.close(); } catch (_) { /* already closed */ }
        resolve(value && typeof value === 'object' ? value : null);
      };
      channel.port1.onmessage = (e) => finish(e && e.data);
      timer = this._setTimeout(() => finish(null), UPDATE_WATCH.ASK_MS);
      try { worker.postMessage({ type: 'GET_BUILD' }, [channel.port2]); } catch (_) { finish(null); }
    });
  }

  /** @private Text of `url` in the named cache, or null (no CacheStorage, no such cache, no entry, any throw). */
  async _cachedText(cacheName, url) {
    if (!this._caches || !cacheName) return null;
    try {
      if (typeof this._caches.has === 'function' && !(await this._caches.has(cacheName))) return null;
      const cache = await this._caches.open(cacheName);
      const r = await cache.match(url);
      if (!r || r.ok === false) return null;
      const text = await r.text();
      return typeof text === 'string' ? text : null;
    } catch (_) {
      return null;
    }
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
