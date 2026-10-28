/**
 * @module core/UpdateWatch — the menu "NEW VERSION READY" witness.
 *
 * The game is a GitHub Pages artifact behind a service worker that STARTS FROM ITS LOCAL COPY, always. A new build
 * installs in the background into its own cache and WAITS (no skipWaiting); it takes over at the next cold start or
 * when the page posts SKIP_WAITING (sw-template.js). So "a new version is ready" has one honest meaning: a new worker
 * is installed and waiting. applyUpdate posts SKIP_WAITING and reloads on the resulting controllerchange
 * (no placebo update).
 *
 * POLICY (owner 2026-10-18: "check once or twice, then stop"; "checked every startup and applied immediately"):
 *  - A START is the first MENU entry of a page load, or a return to visible after >= RESUME_AS_START_MS hidden
 *    (an iPad home-screen app is rarely closed). Each start runs ONE check; if that found no waiting or installing
 *    worker, ONE more runs RECHECK_MS later (any game state); then nothing until the next start. No poll, no timer on
 *    every visible edge. Going back to the menu after a game is not a start.
 *  - Event-driven follow-ups stay (reactions, not timers): `controllerchange`, and a tracked worker reaching
 *    `installed` (`updatefound` → `statechange`).
 *  - APPLY RIGHT AWAY, ON THE MENU, BEFORE A GAME BEGINS: when the waiting build is seen while the state is MENU, no
 *    game has begun (`_gameBegun`: set by MENU_DEPARTURE_START / MENU_FAST_START / MENU_START / MENU_CONTINUE or any
 *    state other than MENU), this is the only open window (the worker's GET_BUILD reply says `windows: 1`: a switch
 *    deletes the old app cache, so a game in another tab would load mixed modules) and this build was not already tried
 *    in this tab session (sessionStorage guard), the payload goes out as Events.UPDATE_AUTO_APPLY instead of
 *    UPDATE_AVAILABLE and ui/MenuScreen.js switches. Otherwise it is the card (UPDATE_AVAILABLE): a tap, or the next
 *    start lands it. Nothing interrupts a game; no start waits on any of this
 *    (the checks are fire-and-forget behind the menu).
 *  - three.js / textures / fonts have NO timer here: cache-first in the worker, re-downloaded only when a deploy bumps
 *    CACHE_NAME.
 *
 * LAWS
 *  1. ONE TRUTH — with a registration, the truth is `registration.waiting`; a network tag that merely differs is NEVER
 *     enough (a tap would land nothing). Without one (no worker, or localhost dev), data/build-tag.json's `hash`
 *     decides and a tap is a plain reload. `controllerchange` is only a reason to re-check. This module never reloads
 *     and never posts SKIP_WAITING except inside applyUpdate (MenuScreen calls it); the tag path is never auto-applied.
 *  2. BOOTED OR INERT (tag path) — start() reads the tag once → `booted`. A 404 / throw leaves it null and the tag path
 *     inert: it NEVER emits against an unknown baseline. A later successful check while booted is null adopts that tag
 *     as the baseline and emits nothing. The worker path needs no baseline.
 *  3. ONCE PER BUILD — a waiting build (keyed on `appBuild`) or a tag hash differing from booted.hash emits
 *     UPDATE_AVAILABLE or UPDATE_AUTO_APPLY `{ hash, tag, bullets }` exactly once (`_seen`).
 *  4. FRESH BULLETS ONLY — whats-new.json is read for the new build
 *     (the waiting worker's own cache, or the wire on the tag path); its `.bullets` (strings only, at most 3) ride the
 *     payload only when the fresh text differs from the text read at boot, so a hotfix that forgot the file shows NO
 *     stale bullets.
 *  5. FLAG-INDEPENDENT — never reads the ladder flag (source-pinned).
 *  6. Every read is try/caught; concurrent checks coalesce on one promise
 *     (a check never awaits registration.update(): a hung update on a dead network must not block the next; a worker
 *     that never names its build is given up on after ASK_MS); stop() removes every listener and timer.
 *  7. NO LOOP — the waiting build's id (the auto payload's `appBuild`) is written to sessionStorage[AUTO_APPLY_KEY] by
 *     claimAutoApply(), which MenuScreen calls only when it really STARTS the switch
 *     (a menu that fell back to the card never marks the build "tried"). The same id already there
 *     (a SKIP_WAITING that never landed) or no usable sessionStorage means the card, so a failing switch cannot reload
 *     forever. This module only reads the key (autoApplyAllowed).
 *
 * Each check also STARTS registration.update() (fire and forget) so the download is under way while the player is on
 * the menu. Every dep is injected and optional (headless-safe). main.js wiring (construction + `window.__updateWatch`)
 * is the hub's job; the bus it gets is the shared one. Consumer: ui/MenuScreen.js
 * (mounts ui/UpdateCard.js; its tap and UPDATE_AUTO_APPLY both call applyUpdate).
 */

import { Events } from './Events.js';

export const UPDATE_WATCH = Object.freeze({
  /** After a start's check found no worker, ONE more check this long later (ms); then none until the next start. */
  RECHECK_MS: 60000,
  /** A return to visible after at least this long hidden counts as a new start (ms). */
  RESUME_AS_START_MS: 3600000,
  /** The tag-path fetches bypass the HTTP cache. */
  FETCH_OPTS: Object.freeze({ cache: 'no-cache' }),
  /** How long a check waits for a waiting worker to name its build (ms). */
  ASK_MS: 3000,
  /** A fresh registration.update() starts only if the last one settled or is older than this (ms). */
  UPDATE_GAP_MS: 10000,
  /** After the tap posts SKIP_WAITING: reload anyway if no controllerchange arrives in this time (ms). */
  APPLY_FALLBACK_MS: 5000,
  /** The notes card's "Check for updates" (checkNow): how long one tap waits for the update to start installing and finish (ms). */
  CHECK_NOW_MS: 10000,
  /** sessionStorage key holding the appBuild an auto-apply was already tried for (the loop guard). */
  AUTO_APPLY_KEY: 'sc_auto_update_v1',
});

/** Bus events that mean "a game has begun": from here on nothing is applied by itself. */
const GAME_BEGUN_EVENTS = Object.freeze(['MENU_DEPARTURE_START', 'MENU_FAST_START', 'MENU_START', 'MENU_CONTINUE']);

/** Payload bullets: strings only, trimmed, non-empty, at most this many. */
const MAX_BULLETS = 3;

/** Bullets of a whats-new.json text (strings only, max 3); malformed → []. */
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

/** Normalize a build hash for comparison: dev builds stamp a trailing '+' while the tree is dirty
 *  (scripts/build-tag.mjs) and the cable server re-stamps on every relaunch, so the suffix toggles WITHOUT a deploy and
 *  never counts. The deployed artifact never carries '+'. */
export function cleanHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.replace(/\+$/, '');
  return h || null;
}

/** sessionStorage (or the injected one); null when there is none or touching it throws. */
function sessionStore(dep) {
  if (dep !== undefined) return dep;
  try { return globalThis.sessionStorage || null; } catch (_) { return null; }
}

/** Read only: may an auto-apply for `appBuild` be tried? False with no usable sessionStorage, no build id, or this
 *  build already tried. `storage`: injected sessionStorage-like; omitted = the page's. */
export function autoApplyAllowed(appBuild, storage) {
  if (typeof appBuild !== 'string' || !appBuild) return false;
  try {
    const st = sessionStore(storage);
    if (!st || typeof st.getItem !== 'function' || typeof st.setItem !== 'function') return false;
    return st.getItem(UPDATE_WATCH.AUTO_APPLY_KEY) !== appBuild;
  } catch (_) {
    return false;
  }
}

/** Take the one auto-apply attempt for `appBuild`: checks like autoApplyAllowed and WRITES the key. MenuScreen calls it
 *  when it really starts the switch; true = go ahead, false = show the card instead. */
export function claimAutoApply(appBuild, storage) {
  if (!autoApplyAllowed(appBuild, storage)) return false;
  try {
    sessionStore(storage).setItem(UPDATE_WATCH.AUTO_APPLY_KEY, appBuild);
    return true;
  } catch (_) {
    return false;
  }
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
 * RESTART NOW. If a build is installed and waiting, switch to it and reload once it has taken over; otherwise a plain
 * reload. Order matters: ONE one-time `controllerchange` listener is added FIRST
 * (guarded by `reloading`, so it reloads exactly once), THEN SKIP_WAITING is posted. If no controllerchange arrives
 * within APPLY_FALLBACK_MS the registration is read again: a worker still waiting gets SKIP_WAITING once more and one
 * more APPLY_FALLBACK_MS; after that (or at once if none waits) the page reloads anyway — a tap must never do nothing,
 * and a reload is never sent before the switch was asked for twice. Nothing else in the game reloads on
 * controllerchange.
 *
 * deps: serviceWorker (navigator.serviceWorker), reload (() → void; the page's one reload site, MenuScreen._reload),
 * setTimeout, clearTimeout, fallbackMs, cancelled (() → boolean; the automatic switch passes "the menu gave up on it":
 * checked before every SKIP_WAITING and every reload including the fallback; once true nothing more is posted and this
 * call never reloads the page).
 * @returns {Promise<'reload'|'switching'|'cancelled'>} what the tap did (for tests)
 */
export async function applyUpdate(deps = {}) {
  const g = globalThis;
  const sw = deps.serviceWorker !== undefined ? deps.serviceWorker : (g.navigator?.serviceWorker || null);
  const reload = typeof deps.reload === 'function' ? deps.reload : () => g.location.reload();
  const st = deps.setTimeout || ((fn, ms) => g.setTimeout(fn, ms));
  const ct = deps.clearTimeout || ((id) => g.clearTimeout(id));
  const fallbackMs = deps.fallbackMs > 0 ? deps.fallbackMs : UPDATE_WATCH.APPLY_FALLBACK_MS;
  const isCancelled = () => {
    try { return typeof deps.cancelled === 'function' && !!deps.cancelled(); } catch (_) { return false; }
  };

  let waiting = null;
  try {
    const reg = sw && typeof sw.getRegistration === 'function' ? await sw.getRegistration() : null;
    waiting = (reg && reg.waiting) || null;
  } catch (_) { waiting = null; }
  // getRegistration() may hang for a long time: by the time it answers the menu may have given up (a game can be running).
  if (isCancelled()) return 'cancelled';
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
    if (isCancelled()) return;   // the menu gave up: no reload, whatever woke us
    reload();
  };
  // First wait over with no controllerchange: the message may never have reached the waiting worker, and a reload now
  // could land the OLD build. Look once more; if a worker still waits, post SKIP_WAITING ONE more time and wait one
  // more fallbackMs, then reload.
  const retry = async () => {
    if (reloading) return;
    if (isCancelled()) { go(); return; }   // cleans the listener and timer, reloads nothing
    let again = null;
    try {
      const reg = typeof sw.getRegistration === 'function' ? await sw.getRegistration() : null;
      again = (reg && reg.waiting) || null;
    } catch (_) { again = null; }
    if (reloading) return;
    if (isCancelled()) { go(); return; }
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
  /** All deps are injected and optional: fetchFn, now (() => ms, default Date.now), setTimeout/clearTimeout, document,
   *  serviceWorker, caches (the waiting build's tag/news are read from its cache), newChannel
   *  (asks the waiting worker its build), eventBus, events, storage
   *  (sessionStorage-like loop guard; null = never auto-apply), tagUrl, newsUrl, menuState
   *  (GameStates.MENU's value, a string so this module imports no state machine). */
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
    // index.html's corner-stamp fetch stashes its promise on `window.__bootBuildTag`; the watcher adopts that ONE boot
    // read (two reads let a deploy landing between them split the baselines).
    this._bootTag = deps.bootTag !== undefined ? deps.bootTag : (() => g.__bootBuildTag || null);
    this._tagUrl = deps.tagUrl || './data/build-tag.json';
    this._newsUrl = deps.newsUrl || './data/whats-new.json';
    this._storageDep = deps.storage;   // undefined = the page's sessionStorage, looked up when needed
    this._menuState = deps.menuState || 'MENU';

    /** @type {{ hash: string, tag: string }|null} the baseline read at boot (null = inert) */
    this.booted = null;
    /** @type {string|null} whats-new.json text at boot (null = absent) */
    this.bootedNews = null;
    /** @type {number} last check() clock reading */
    this.lastCheckAt = 0;
    this._seen = new Set();          // tag-path hashes already announced
    this._seenBuilds = new Set();    // worker-path appBuilds already announced (a new start forgets them)
    this._pending = null;
    this._inflight = null;
    this._started = false;
    this._onMenu = false;        // the state is MENU right now
    this._menuSeen = false;      // the first MENU entry of this page load has happened (that was the start)
    this._gameBegun = false;     // a departure / MENU_START / MENU_CONTINUE / a non-menu state happened: nothing is applied by itself
    this._hiddenAt = null;       // clock reading of the first hidden edge since the last visible one
    this._found = false;         // this start's checks have seen a waiting / installing worker (or announced a build)
    this._recheckId = null;      // the one pending recheck timer
    this._onState = null;
    this._onBegun = null;
    this._begunNames = [];
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
    this._manualCheck = false;   // checkNow() is running: nothing found by it applies by itself, and it owns the update call
    this._tapped = false;        // checkNow() was ever called in this page: no build found from then on applies by itself (never cleared)
    this._manualRun = null;      // the promise of the checkNow() in flight (a second tap shares it)
    this._published = 0;         // how many payloads _publish() has emitted (checkNow compares before / after)
  }

  /** Read the baseline (tag once, whats-new once) and arm the triggers
   *  (state change, "a game has begun" events, visibility, controllerchange). Idempotent. Resolves when the boot reads
   *  settle; never rejects. @returns {Promise<void>} */
  start() {
    if (this._started) return this._bootPromise || Promise.resolve();
    this._started = true;
    if (this._bus && this._bus.on) {
      this._onState = (p) => this._onStateChange(p);
      this._bus.on(this._events.GAME_STATE_CHANGE, this._onState);
      // A departure beginning is the first sign of a game: from then on nothing is applied by itself.
      this._onBegun = () => { this._gameBegun = true; };
      this._begunNames = GAME_BEGUN_EVENTS.map((k) => this._events[k]).filter((n) => typeof n === 'string');
      for (const name of this._begunNames) this._bus.on(name, this._onBegun);
    }
    if (this._doc && this._doc.addEventListener) {
      // Only a long absence counts: hidden >= RESUME_AS_START_MS, then visible = a new start; a quick tab switch checks
      // nothing.
      this._onVisibility = () => {
        if (this._doc.visibilityState === 'hidden') {
          if (this._hiddenAt === null) this._hiddenAt = this._now();
          return;
        }
        const since = this._hiddenAt;
        this._hiddenAt = null;
        if (since !== null && this._menuSeen && this._now() - since >= UPDATE_WATCH.RESUME_AS_START_MS) this._beginStart(true);
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
    this._clearRecheck();
    this._onMenu = false;
    if (this._onState && this._bus && this._bus.off) this._bus.off(this._events.GAME_STATE_CHANGE, this._onState);
    if (this._onBegun && this._bus && this._bus.off) for (const name of this._begunNames) this._bus.off(name, this._onBegun);
    if (this._onVisibility && this._doc && this._doc.removeEventListener) this._doc.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onController && this._sw && this._sw.removeEventListener) this._sw.removeEventListener('controllerchange', this._onController);
    this._onState = this._onBegun = this._onVisibility = this._onController = null;
    this._begunNames = [];
    this._unwatch();
    this._started = false;
  }

  /** The last emitted payload (`{ hash, tag, bullets }`) or null — MenuScreen reads it when shown later. */
  pending() { return this._pending; }

  /** With a registration: start its update (not awaited) and emit UPDATE_AVAILABLE
   *  (or, on the menu before a game began, UPDATE_AUTO_APPLY) once per WAITING build. Without one: re-read the tag,
   *  emit UPDATE_AVAILABLE once per new hash (laws 2–4). Concurrent calls coalesce. Never rejects.
   *  @returns {Promise<object|null>} the payload this check emitted, else null */
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

  /**
   * The notes card's "Check for updates" (owner 2026-10-26, DECISIONS §43): ONE explicit check, started by a tap and
   * the only thing here that ever waits on the network. Starts `registration.update()` NOW
   * (UPDATE_GAP_MS limits the automatic checks, not a tap), then waits up to CHECK_NOW_MS for the new worker to
   * install. A build it finds is announced as UPDATE_AVAILABLE
   * (never UPDATE_AUTO_APPLY: the player asked and was promised a choice); a build already waiting at the tap is
   * announced again (an earlier LATER does not hide it from an explicit check).
   * @returns {Promise<'ready'|'current'|'offline'>} ready = a build is waiting and announced; current = this build is
   * the newest; offline = no registration,
   *   the update failed or hung, or the install did not finish in time.
   */
  checkNow() {
    if (!this._manualRun) {
      this._manualRun = this._checkNow().catch(() => 'offline').finally(() => { this._manualRun = null; });
    }
    return this._manualRun;
  }

  /** @private checkNow(): see there. */
  async _checkNow() {
    this._tapped = true;   // page lifetime: a worker still installing after the 10 s window must not switch builds under "Can't check right now"
    const reg = await this._registration();
    if (!reg) return 'offline';
    this._manualCheck = true;
    const before = this._published;
    try {
      this._watch(reg);
      this._seenBuilds.clear();
      const budget = this._now() + UPDATE_WATCH.CHECK_NOW_MS;
      if (!reg.waiting) {
        if (typeof reg.update !== 'function') return 'offline';
        this._updating = true;
        this._updateAt = this._now();
        let outcome;
        try {
          outcome = await this._within(() => reg.update(), UPDATE_WATCH.CHECK_NOW_MS);
        } finally {
          this._updating = false;
        }
        if (outcome !== 'done') return 'offline';
        if (!reg.waiting) {
          if (!reg.installing) return 'current';
          const left = Math.max(0, budget - this._now());
          if (!(await this._installedWithin(reg, left))) return 'offline';
        }
      }
      // A worker is waiting. Announce it (the follow-up check of a worker reaching `installed` may already have).
      await this.check();
      while (this._inflight) await this._inflight;
      return this._published > before ? 'ready' : 'offline';
    } finally {
      this._manualCheck = false;
    }
  }

  /** @private Run `fn` (returns a promise) with a time limit: 'done' | 'failed' (it threw / rejected) | 'timeout'. */
  _within(fn, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (timer !== null) this._clearTimeout(timer);
        resolve(v);
      };
      timer = this._setTimeout(() => finish('timeout'), ms);
      try { Promise.resolve(fn()).then(() => finish('done'), () => finish('failed')); } catch (_) { finish('failed'); }
    });
  }

  /** @private Wait up to `ms` for the registration's installing worker to reach `installed` (true) or fail / time out (false). */
  _installedWithin(reg, ms) {
    return new Promise((resolve) => {
      const worker = reg.installing;
      if (reg.waiting) { resolve(true); return; }
      if (!worker || !worker.addEventListener) { resolve(false); return; }
      let done = false;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (timer !== null) this._clearTimeout(timer);
        if (worker.removeEventListener) worker.removeEventListener('statechange', onState);
        resolve(v);
      };
      const onState = () => {
        if (worker.state === 'installed') finish(true);
        else if (worker.state === 'redundant') finish(false);
      };
      worker.addEventListener('statechange', onState);
      timer = this._setTimeout(() => finish(false), ms);
      onState();   // it may have finished between the read and the listener
    });
  }

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
    const hash = cleanHash(tag && tag.hash);   // '+' dirty suffix never counts
    if (!hash || hash === this.booted.hash || this._seen.has(hash)) return null;
    this._seen.add(hash);                                  // law 3: once per hash
    const news = await this._fetchText(this._newsUrl);     // fresh, 404 → null
    const bullets = (news !== null && news !== this.bootedNews) ? parseBullets(news) : [];   // law 4
    return this._publish(hash, typeof tag.tag === 'string' ? tag.tag : '', bullets);
  }

  /** @private The ONE emit site: freeze, remember (pending()), announce. `auto` sends the payload as UPDATE_AUTO_APPLY
   *  (MenuScreen switches) instead of
   *  UPDATE_AVAILABLE (MenuScreen shows the card). Either way this start has found its build, so the recheck is not
   *  needed. */
  _publish(hash, tag, bullets, auto = false, appBuild = '') {
    // The auto payload also names the build (MenuScreen claims the loop-guard key with it); the card's payload is unchanged.
    const payload = Object.freeze(auto ? { hash, tag, bullets, appBuild } : { hash, tag, bullets });
    this._pending = payload;
    this._published += 1;
    this._markFound();
    if (this._bus && this._bus.emit) {
      this._bus.emit(auto ? this._events.UPDATE_AUTO_APPLY : this._events.UPDATE_AVAILABLE, payload);
    }
    return payload;
  }

  /** @private The page's service-worker registration, or null (no worker API, none registered, or it threw). */
  async _registration() {
    const sw = this._sw;
    if (!sw || typeof sw.getRegistration !== 'function') return null;
    try { return (await sw.getRegistration()) || null; } catch (_) { return null; }
  }

  /** @private One check with a registration: start the update (never awaited), then announce the WAITING build once per
   *  `appBuild` (law 3); tag and news come
   *  from that build's own cache, not the wire. */
  async _checkWorker(reg) {
    this._watch(reg);
    this._kickUpdate(reg);
    if (reg.waiting || reg.installing) this._markFound();   // a worker is already on its way: no recheck needed
    const waiting = reg.waiting;
    if (!waiting) return null;
    const build = await this._askBuild(waiting);
    const appBuild = build && typeof build.appBuild === 'string' ? build.appBuild : '';
    if (!appBuild || this._seenBuilds.has(appBuild)) return null;
    this._seenBuilds.add(appBuild);                        // law 3: once per waiting build (per start, see _beginStart)
    const cacheName = typeof build.cache === 'string' ? build.cache : '';
    const tag = parseObject(await this._cachedText(cacheName, this._tagUrl));
    const news = await this._cachedText(cacheName, this._newsUrl);
    const bullets = (news !== null && news !== this.bootedNews) ? parseBullets(news) : [];   // law 4
    // Decided NOW, after every await: the state may have moved on while the worker was being asked.
    const auto = this._mayAutoApply(appBuild, build);
    return this._publish(cleanHash(tag && tag.hash) || appBuild, tag && typeof tag.tag === 'string' ? tag.tag : '', bullets, auto, appBuild);
  }

  /** @private May this waiting build be switched to without the player doing anything? Only on the menu, before any
   *  game began, as the only open window, and
   *  if this build was not already tried in this tab session (loop guard READ here; MenuScreen writes it via
   *  claimAutoApply() when it really starts the switch;
   *  a missing or throwing sessionStorage is a "no"). Anything else → the card. */
  _mayAutoApply(appBuild, build) {
    if (this._manualCheck || this._tapped) return false;   // checkNow(): the player asked, so he is offered the restart, never handed it (also when the build lands after the window)
    if (!this._onMenu || this._gameBegun) return false;
    if (typeof this._events.UPDATE_AUTO_APPLY !== 'string') return false;
    if (!build || build.windows !== 1) return false;
    return autoApplyAllowed(appBuild, this._storageDep);
  }

  /** @private This start has seen a worker (or announced a build): its recheck is not needed. */
  _markFound() {
    this._found = true;
    this._clearRecheck();
  }

  /** @private Cancel the pending recheck timer, if any. */
  _clearRecheck() {
    if (this._recheckId !== null) {
      this._clearTimeout(this._recheckId);
      this._recheckId = null;
    }
  }

  /** @private A START: the first MENU entry of the page load, or a return to visible after a long absence. One check
   *  now; if it finds no worker, one more
   *  RECHECK_MS later in any state. A resume that finds the menu showing re-opens "no game has begun"; one that finds a
   *  game state leaves it closed. A start
   *  that finds the menu showing also forgets which waiting builds were announced: one shown as a card earlier is
   *  announced again, now as an auto-apply, because
   *  the window is open (a build already tried this tab session still stops at the loop guard). The timer is armed
   *  BEFORE the check so a worker the check finds
   *  can cancel it. */
  _beginStart(resume) {
    this._found = false;
    this._clearRecheck();
    if (this._onMenu) {
      this._seenBuilds.clear();
      if (resume) this._gameBegun = false;
    }
    this._recheckId = this._setTimeout(() => {
      this._recheckId = null;
      if (this._started && !this._found) this.check();
    }, UPDATE_WATCH.RECHECK_MS);
    this.check();
  }

  /** @private registration.update(), fire and forget. A new one starts only when the previous settled or is older than
   *  UPDATE_GAP_MS (a hung update on a dead
   *  network must neither be awaited nor starve later checks). */
  _kickUpdate(reg) {
    if (typeof reg.update !== 'function') return;
    if (this._manualCheck) return;   // checkNow() owns the update call (it started one itself, past the gap)
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
    this._markFound();          // a build is installing: nothing more to look for this start
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

  /** @private GAME_STATE_CHANGE. The FIRST entry to MENU in the page load is the start
   *  (boot emits menu → menu; that counts once); later entries are not.
   *  Any state other than MENU means a game has begun. */
  _onStateChange(p) {
    const to = p && p.to;
    if (to === this._menuState) {
      this._onMenu = true;
      if (!this._menuSeen) {
        this._menuSeen = true;
        this._beginStart(false);
      }
    } else if (typeof to === 'string' && to) {
      this._onMenu = false;
      this._gameBegun = true;
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
