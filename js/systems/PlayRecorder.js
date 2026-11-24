/**
 * PlayRecorder: the always-on play log. Everything lives in memory (never sent anywhere); the player saves it as ONE JSON file
 * from the help page's "Save play log" button (HotkeyOverlay.setPlayLog), and `scripts/play/drive-training.mjs` writes the same
 * format from a scripted run, so a person's play and a repeatable run read the same way (`scripts/play/summarize-play.mjs`).
 *
 * READ-ONLY by contract: it only listens (event bus, keydown/keyup, pointerdown, window errors) and reads numbers through the
 * probes main.js hands it. Every probe read is wrapped, so a missing field logs `null` and never throws; nothing here changes
 * what a player sees or does.
 *
 * Bounded: one ring of at most `entryCap` entries (default 50,000); the oldest is dropped and counted in meta.droppedEntries.
 *
 * Node-safe import: no window/document at module scope. Listeners, the 1 Hz snapshot timer and the Blob download live in
 * start()/download() behind guards, so the Node suite drives the handlers directly (`snapshotNow()`, `noteKey()`, ...).
 *
 * Entry shape (every entry): { w: wall ms since the recorder was built, g: game seconds (summed SimClock.gameDt via tick()),
 *   m: gameState.missionTime or null, k: kind, ...fields }. Kinds:
 *   event   { ev, d }                       a bus event (name + a payload trimmed to plain numbers/strings/booleans)
 *   hint    { id, text, keys }              HINT_POSTED
 *   msg     { src, ch, text }               COMMS_MESSAGE as posted (may be held or dropped: NOT what was drawn)
 *   coach   { src, ch, text, flags }        a line the comms panel really drew (the CommsPanel._pushShown wrapper)
 *   key     { key, code, up? }              keydown (up:true = keyup); text typed into a field is logged as key '(field)'
 *   tap     { pointer, target }             pointerdown: pointer type and the id of the nearest element that has one
 *   pieces  { mission, rows:[{id,name,massKg,sizeM,distM,spinDegS,driftMps}] }  the field laid out for a mission
 *   snap    { mission, beat, catches, nets, gasKg, argonKg, battery, heatC, target, targetM, daughtersOut, floor }  every 1 s
 *   error   { msg }                         window 'error' / 'unhandledrejection'
 *   note    { text }
 * File shape: { meta, entries }.  meta: { format, game, startedAt, fieldSeed, viewport, input, mission, ... counts }.
 *
 * @module systems/PlayRecorder
 */

/** Log-format tag (bump on shape changes; summarize-play.mjs reads it). */
export const PLAYLOG_FORMAT = 'play-log-1';

export const PLAYLOG_DEFAULTS = {
  entryCap: 50000,
  snapshotMs: 1000,
  textMax: 300,
};

/** The bus events the log keeps (names of `Events` keys; a name the build does not have is listed in meta.missingEvents). */
export const PLAYLOG_EVENTS = [
  'MENU_START', 'MISSION_START', 'MISSION_COMPLETE', 'MISSION_BEAT_STARTED', 'MISSION_BEAT_SATISFIED', 'MOVERS_CHANGED',
  'GAME_STATE_CHANGE', 'ONBOARDING_COMPLETE', 'TEACHING_MOMENT_FORCE',
  'TARGET_SELECTED', 'TARGET_CLEARED', 'SCAN_INITIATED', 'SCAN_COMPLETE', 'SCAN_WIDE',
  'AUTOPILOT_ENGAGE', 'AUTOPILOT_DISENGAGE', 'AUTOPILOT_ARRIVED', 'AUTOPILOT_NO_TARGET', 'DESPIN_IN_SPEC',
  'NET_FIRED', 'NET_CATCH_SUCCESS', 'NET_CATCH_MISS', 'NET_FAILED', 'NET_TORN', 'NET_MOUTH_COLLAPSED', 'NET_FRAGMENTATION',
  'NET_REEL_STARTED', 'NET_REEL_COMPLETED', 'NET_RELEASED', 'NET_BERTHED', 'NET_INVENTORY_CHANGED', 'NET_EMPTY_CLICK',
  'ARM_DEPLOYED', 'ARM_SPRING_FIRED', 'ARM_CAPTURED', 'ARM_CAPTURE_FAILED', 'ARM_RETURNED', 'ARM_DOCKED', 'ARM_RECALLED',
  'ARM_EXPENDED', 'ARM_DETACHED', 'ARM_LOST',
  'LASSO_FIRED', 'LASSO_CAPTURED', 'LASSO_DENIED', 'LASSO_MISSED', 'LASSO_SNAPPED',
  'CATCH_COUNTED', 'CATCH_PROCESSED', 'DEBRIS_CAPTURED', 'DEBRIS_CLEARED',
  'ONBOARDING_STARTED', 'ONBOARDING_MASTERED', 'HINT_SATISFIED',
  'DUAL_FIRE', 'CONTROL_MODE_CHANGE', 'PAIR_LESSON_SKIP', 'STATION_KEEP_ENTERED', 'TARGET_DISCOVERED', 'CODEX_OPENED',
  'OPENING_DANCE_HANDOVER',
];

/** Channels the director emits as plain strings (not in `Events`): training 1's beats. Logged as event ONBOARDING_BEAT_ENTER. */
export const PLAYLOG_RAW_CHANNELS = { ONBOARDING_BEAT_ENTER: 'onboarding:beatEnter' };

const round = (x, p = 3) => { const f = 10 ** p; return Math.round(x * f) / f; };

/** A bus payload cut down to plain values: numbers (rounded), booleans, strings (80 chars), at most 12 keys, nothing nested. */
export function trimPayload(d) {
  if (d === null || d === undefined) return null;
  if (typeof d === 'number') return Number.isFinite(d) ? round(d) : null;
  if (typeof d === 'boolean') return d;
  if (typeof d === 'string') return d.slice(0, 80);
  if (typeof d !== 'object') return null;
  const out = {};
  let n = 0;
  for (const key of Object.keys(d)) {
    if (n >= 12) break;
    const v = d[key];
    if (typeof v === 'number') { if (Number.isFinite(v)) { out[key] = round(v); n++; } }
    else if (typeof v === 'boolean') { out[key] = v; n++; }
    else if (typeof v === 'string') { out[key] = v.slice(0, 80); n++; }
  }
  return n ? out : null;
}

export class PlayRecorder {
  /**
   * @param {object} deps all optional (Node-safe defaults)
   * @param {{on:Function}} [deps.eventBus] the game's bus
   * @param {object} [deps.Events] the game's Events table (name -> channel)
   * @param {string[]} [deps.eventNames] override of PLAYLOG_EVENTS (tests)
   * @param {function(): number} [deps.now] monotonic ms clock (default performance.now)
   * @param {object} [deps.win] window-like target for listeners / timer / download (default: the real window, resolved in start())
   * @param {function(): object} [deps.metaProbe] extra meta, read once at start() and again at every snapshot()
   *   ({game, fieldSeed, viewport, input, mission} ...); a throw gives {}
   * @param {Object<string, function(): *>} [deps.fields] the 1 Hz snapshot's fields, name -> reader; each read is wrapped
   * @param {function(): ({mission:number, rows:Array}|null)} [deps.pieces] reads the field laid out for the current mission
   * @param {function(): (number|null)} [deps.missionTime] gameState.missionTime reader
   * @param {number} [deps.entryCap] @param {number} [deps.snapshotMs]
   */
  constructor({ eventBus, Events, eventNames, now, win, metaProbe, fields, pieces, missionTime, entryCap, snapshotMs } = {}) {
    this._bus = eventBus || null;
    this._Events = Events || null;
    this._eventNames = eventNames || PLAYLOG_EVENTS;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._win = win || null;
    this._metaProbe = metaProbe || null;
    this._fields = fields || {};
    this._piecesProbe = pieces || null;
    this._missionTimeProbe = missionTime || null;
    this._cap = Math.max(1, (entryCap ?? PLAYLOG_DEFAULTS.entryCap) | 0);
    this._snapshotMs = snapshotMs ?? PLAYLOG_DEFAULTS.snapshotMs;
    this._buf = new Array(this._cap);
    this._n = 0;
    this._i = 0;
    this.dropped = 0;
    this._t0 = this._now();
    this._startedAt = null;
    this._gameS = 0;
    this._started = false;
    this._offs = [];           // unsubscribe functions + listener removers
    this._timer = null;
    this._missing = [];
    this._piecesTaken = new Set();   // mission numbers whose table is in the log (cleared at MENU_START: a new game)
    this._missionStartWall = new Map();   // mission -> wall ms of its MISSION_START
    this._startMeta = {};
    this.lastFileName = null;

    this.noteKeyDown = this.noteKeyDown.bind(this);
    this.noteKeyUp = this.noteKeyUp.bind(this);
    this.noteTap = this.noteTap.bind(this);
    this.noteError = this.noteError.bind(this);
    this.noteRejection = this.noteRejection.bind(this);
    this.snapshotNow = this.snapshotNow.bind(this);
  }

  /** Begin recording: bus subscriptions, DOM listeners (only with a window), the 1 Hz snapshot timer. Safe to call twice. */
  start() {
    if (this._started) return;
    this._started = true;
    this._startedAt = new Date().toISOString();
    this._startMeta = this._readMeta();

    if (this._bus && this._Events) {
      for (const name of this._eventNames) {
        const channel = this._Events[name];
        if (!channel) { this._missing.push(name); continue; }
        this._offs.push(this._bus.on(channel, (d) => this._onEvent(name, d)));
      }
      for (const name of Object.keys(PLAYLOG_RAW_CHANNELS)) this._offs.push(this._bus.on(PLAYLOG_RAW_CHANNELS[name], (d) => this._onEvent(name, d)));
      const hint = this._Events.HINT_POSTED;
      if (hint) this._offs.push(this._bus.on(hint, (d) => this._add('hint', { id: _str(d && d.id, 60), text: _str(d && d.text, PLAYLOG_DEFAULTS.textMax), keys: Array.isArray(d && d.keys) ? d.keys.slice(0, 6).map((k) => _str(k, 20)) : null })));
      const msg = this._Events.COMMS_MESSAGE;
      if (msg) this._offs.push(this._bus.on(msg, (d) => { if (d && d.text) this._add('msg', { src: _str(d.source || d.sender, 40), ch: _str(d.channel, 20), text: _str(d.text, PLAYLOG_DEFAULTS.textMax) }); }));
    }

    const win = this._resolveWin();
    if (!win) return;
    if (typeof win.addEventListener === 'function') {
      const opts = { passive: true, capture: true };
      win.addEventListener('keydown', this.noteKeyDown, opts);
      win.addEventListener('keyup', this.noteKeyUp, opts);
      win.addEventListener('pointerdown', this.noteTap, opts);
      win.addEventListener('error', this.noteError);
      win.addEventListener('unhandledrejection', this.noteRejection);
      this._offs.push(() => {
        win.removeEventListener('keydown', this.noteKeyDown, { capture: true });
        win.removeEventListener('keyup', this.noteKeyUp, { capture: true });
        win.removeEventListener('pointerdown', this.noteTap, { capture: true });
        win.removeEventListener('error', this.noteError);
        win.removeEventListener('unhandledrejection', this.noteRejection);
      });
    }
    if (typeof win.setInterval === 'function') this._timer = win.setInterval(this.snapshotNow, this._snapshotMs);
  }

  /** Stop listening (the data and the download stay). */
  stop() {
    if (!this._started) return;
    this._started = false;
    for (const off of this._offs) { try { off(); } catch (_e) { /* ignore */ } }
    this._offs = [];
    const win = this._resolveWin();
    if (this._timer != null && win && typeof win.clearInterval === 'function') win.clearInterval(this._timer);
    this._timer = null;
  }

  /** The game loop calls this once a frame with SimClock.gameDt (game seconds this frame): `g` on every entry is their sum. */
  tick(gameDt) {
    if (Number.isFinite(gameDt) && gameDt > 0) this._gameS += gameDt;
  }

  /** Wall ms since the recorder was built (the `w` clock of every entry), read now. */
  elapsedMs() { return Math.round(this._now() - this._t0); }

  /** Write one entry of kind `k`. */
  _add(k, fields) {
    const e = { w: this.elapsedMs(), g: round(this._gameS, 2), m: this._readMissionTime(), k, ...fields };
    if (this._n === this._cap) this.dropped++;
    else this._n++;
    this._buf[this._i] = e;
    this._i = (this._i + 1) % this._cap;
    return e;
  }

  _readMissionTime() {
    if (!this._missionTimeProbe) return null;
    try { const v = this._missionTimeProbe(); return Number.isFinite(v) ? round(v, 1) : null; } catch (_e) { return null; }
  }

  _onEvent(name, d) {
    if (name === 'MENU_START') { this._piecesTaken.clear(); this._missionStartWall.clear(); }
    if (name === 'MISSION_START' && d && Number.isFinite(d.missionNumber)) {
      this._missionStartWall.set(d.missionNumber, Math.round(this._now() - this._t0));
      this._piecesTaken.delete(d.missionNumber);   // a mission started again lays its field again
    }
    this._add('event', { ev: name, d: trimPayload(d) });
  }

  /** A line the comms panel drew (main.js calls this after the original `_pushShown` returned). */
  noteCoachLine(m) {
    if (!m) return;
    const flags = [m.coach ? 'coach' : '', m.keep ? 'keep' : '', m.onboardingBeatId ? 'beat:' + m.onboardingBeatId : '', m.priority != null ? 'pri:' + m.priority : ''].filter(Boolean).join(',');
    this._add('coach', { src: _str(m.source, 40), ch: _str(m.channel, 20), text: _str(m.text != null ? m.text : '?', PLAYLOG_DEFAULTS.textMax), flags });
  }

  noteKeyDown(e) { this._noteKey(e, false); }
  noteKeyUp(e) { this._noteKey(e, true); }
  _noteKey(e, up) {
    if (!e || (!up && e.repeat)) return;
    const t = e.target;
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true);
    const fields = inField ? { key: '(field)', code: null } : { key: _str(e.key, 20), code: _str(e.code, 20) };
    if (up) fields.up = true;
    this._add('key', fields);
  }

  noteTap(e) {
    if (!e) return;
    let id = null;
    try {
      let el = e.target;
      for (let hops = 0; el && hops < 6 && !id; hops++, el = el.parentElement) if (el.id) id = String(el.id).slice(0, 60);
    } catch (_e) { id = null; }
    this._add('tap', { pointer: _str(e.pointerType, 10), target: id });
  }

  noteError(e) { this._add('error', { msg: _str((e && (e.message || (e.error && e.error.message))) || 'error', 200) }); }
  noteRejection(e) { const r = e && e.reason; this._add('error', { msg: 'unhandledrejection: ' + _str(r && r.message ? r.message : r, 180) }); }

  noteText(text) { this._add('note', { text: _str(text, 200) }); }

  /** One 1 Hz snapshot; also looks for a field laid out for the current mission (the piece table). Every read is wrapped. */
  snapshotNow() {
    const out = {};
    for (const name of Object.keys(this._fields)) {
      let v = null;
      try { v = this._fields[name](); } catch (_e) { v = null; }
      out[name] = (typeof v === 'number') ? (Number.isFinite(v) ? round(v) : null) : (v === undefined ? null : v);
    }
    const e = this._add('snap', out);
    this._maybeTakePieces();
    return e;
  }

  /**
   * The piece table of the current mission, once: the field's pieces as laid out for this mission number. Training 1 has no
   * MISSION_START (the welcome field is laid on the first frame with an orbit), so it is taken as soon as the pieces exist; missions 2 and up
   * lay their rows ON MISSION_START, so the table waits about a second after it.
   */
  _maybeTakePieces() {
    if (!this._piecesProbe) return;
    let t = null;
    try { t = this._piecesProbe(); } catch (_e) { t = null; }
    if (!t || !Number.isFinite(t.mission) || !Array.isArray(t.rows) || t.rows.length === 0) return;
    if (this._piecesTaken.has(t.mission)) return;
    const startedAt = this._missionStartWall.get(t.mission);
    if (t.mission > 1 && !(startedAt !== undefined && this._now() - this._t0 - startedAt >= 1000)) return;
    this._piecesTaken.add(t.mission);
    this._add('pieces', { mission: t.mission, rows: t.rows });
  }

  _readMeta() {
    if (!this._metaProbe) return {};
    try { const m = this._metaProbe(); return m && typeof m === 'object' ? m : {}; } catch (_e) { return {}; }
  }

  /** The log as an object: { meta, entries } (entries oldest first). */
  snapshot() {
    const entries = new Array(this._n);
    const start = (this._i - this._n + this._cap) % this._cap;
    for (let k = 0; k < this._n; k++) entries[k] = this._buf[(start + k) % this._cap];
    const live = this._readMeta();
    return {
      meta: {
        format: PLAYLOG_FORMAT,
        startedAt: this._startedAt,
        savedAt: new Date().toISOString(),
        ...this._startMeta,
        mission: live.mission ?? this._startMeta.mission ?? null,
        entryCap: this._cap,
        entries: entries.length,
        droppedEntries: this.dropped,
        missingEvents: this._missing.slice(),
      },
      entries,
    };
  }

  /**
   * Save the log as `space-cowboy-play-<YYYYMMDD-HHMM>.json` (Blob + anchor click), else print the JSON to the console.
   * @returns {string} the JSON text
   */
  download() {
    const json = JSON.stringify(this.snapshot());
    const win = this._resolveWin();
    const doc = win && win.document;
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const name = `space-cowboy-play-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    this.lastFileName = name;
    if (doc && typeof doc.createElement === 'function' && typeof Blob !== 'undefined' && win.URL && typeof win.URL.createObjectURL === 'function') {
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = win.URL.createObjectURL(blob);
        const a = doc.createElement('a');
        a.href = url;
        a.download = name;
        doc.body.appendChild(a);
        a.click();
        doc.body.removeChild(a);
        // released late: Safari (the iPad, DECISIONS §32) can cancel a download whose link is revoked at once (as BlackFrameProbe)
        setTimeout(() => { try { win.URL.revokeObjectURL(url); } catch (_e) { /* gone */ } }, 5000);
        this.lastSaveOk = true;
        console.info(`[PlayLog] saved ${name} (${this._n} entries)`);
        return json;
      } catch (err) {
        console.warn('[PlayLog] blob download failed, logging JSON instead:', err);
      }
    }
    this.lastSaveOk = false;
    console.log(json);
    return json;
  }

  _resolveWin() {
    if (this._win) return this._win;
    return (typeof window !== 'undefined') ? window : null;
  }
}

function _str(v, max) {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, max);
}
