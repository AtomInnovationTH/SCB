/**
 * @module core/DevHost — is this page on the dev machine? (DECISIONS §47 row 8.)
 * Debug URL switches and `window.__*` hooks work only where `isDevHost()` is true; the public site gets the defaults.
 * Leaf module, no imports. Dev host: no `location` at all (Node), `file:`, `localhost`, 127.0.0.0/8, `::1`, `*.local`,
 * private IPv4 (10/8, 172.16/12, 192.168/16: the iPad reaches the Mac over `start.sh --lan`). A location with no
 * hostname and no protocol (a test stand-in) counts as dev; `about:`/`data:` do not. Deliberately not `touchTelemetry.isTelemetryHost` (stricter on purpose).
 */

/** @param {string} host lower-case hostname @returns {boolean} */
function privateOrLoopbackV4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * @param {{protocol?:string, hostname?:string}|null|undefined} [loc] defaults to the page's own `location`
 * @returns {boolean}
 */
export function isDevHost(loc = globalThis.location) {
  if (!loc) return true;
  if (loc.protocol === 'file:') return true;
  const host = String(loc.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return !loc.protocol;   // a test stand-in has no protocol; about:/data: pages are not dev
  return host === 'localhost' || host === '::1' || host.endsWith('.local') || privateOrLoopbackV4(host);
}

/**
 * The query string a debug switch may read: `loc.search` on a dev host, '' elsewhere (every switch then gives its default).
 * @param {{protocol?:string, hostname?:string, search?:string}|null|undefined} [loc]
 * @returns {string}
 */
export function devSearch(loc = globalThis.location) {
  return isDevHost(loc) ? (loc?.search ?? '') : '';
}

/**
 * `?mission=N` (dev host only): the training mission a NEW game starts at, 2 or 3; null for no switch, any other value, or a public
 * host (every switch gives its default there, DECISIONS §47 row 8).
 * @param {{protocol?:string, hostname?:string, search?:string}|null|undefined} [loc]
 * @returns {(number|null)}
 */
export function devStartMission(loc = globalThis.location) {
  const raw = new URLSearchParams(devSearch(loc)).get('mission');
  return raw === '2' || raw === '3' ? Number(raw) : null;
}

/**
 * Make a NEW game start at training mission `mission` (the `?mission=N` look; training-3-movers plan T5). Once, after the next new game
 * has finished resetting, entered the orbit view and posted its start lines (the opening dance's hand-over, else 10 s later), it gives the game the catches a finished mission N-1 leaves (`debrisCleared`) and
 * lets the scoring system fire the boundary `MISSION_START { missionNumber: N, profile }`: the coach arms chapter N, the field registry and
 * the debris field lay out the mission's extra rows at the start field. The tutorial is skipped (the director's dev flag: a
 * veteran start, no chapter-1 beats), for that new game only: the director's flag is set at its MENU_START and cleared at a MENU_CONTINUE. A saved game continuing (MENU_CONTINUE) never arms it; credits and tools stay as a new game's.
 * Registered BEFORE the game flow manager's own MENU_START handler, so it is armed before that handler enters the orbit view.
 * @param {object} deps
 * @param {{on:Function}} deps.eventBus
 * @param {{MENU_START:string, MENU_CONTINUE?:string, MENU_FAST_START?:string, GAME_STATE_CHANGE:string}} deps.Events
 * @param {{debrisCleared:number}} deps.gameState
 * @param {{checkMissionTransition:Function}} deps.scoringSystem
 * @param {{setDevSkip?:Function}|null} deps.onboardingDirector
 * @param {number} deps.mission 2 or 3 @param {number} deps.debrisPerMission `Constants.MISSIONS.DEBRIS_PER_MISSION`
 * @param {string} [deps.orbitalView] the state name that ends a new game's start (default 'ORBITAL_VIEW')
 * @param {{set:(fn:Function, ms:number)=>*, clear:(h:*)=>void}|null} [deps.timers] real-time timers (default setTimeout/clearTimeout; tests pass fakes)
 * @returns {() => void} undo (removes the listeners, cancels a pending jump)
 */
export function installDevStart({ eventBus, Events, gameState, scoringSystem, onboardingDirector = null, mission, debrisPerMission, orbitalView = 'ORBITAL_VIEW', timers = null }) {
  const skip = (on) => { if (onboardingDirector && typeof onboardingDirector.setDevSkip === 'function') onboardingDirector.setDevSkip(on); };
  const setT = timers?.set ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = timers?.clear ?? ((h) => clearTimeout(h));
  let armed = false;
  let waiting = false;   // entered the orbit view, the mission jump not yet made
  let fallback = null, afterStart = null;
  const cancel = () => {
    waiting = false;
    if (fallback !== null) clearT(fallback);
    if (afterStart !== null) clearT(afterStart);
    fallback = afterStart = null;
  };
  const jump = () => {
    if (!waiting) return;
    cancel();
    gameState.debrisCleared = (mission - 1) * debrisPerMission;
    scoringSystem.checkMissionTransition();
  };
  // The dev skip belongs to the dev-start NEW game only: it is set when that game begins (MENU_START, before the director's own
  // orbit-view start) and cleared when a saved game continues, so a Continue in the same session plays the tutorial as saved.
  const offStart = eventBus.on(Events.MENU_START, () => { cancel(); armed = true; skip(true); });
  const offContinue = Events.MENU_CONTINUE ? eventBus.on(Events.MENU_CONTINUE, () => { cancel(); armed = false; skip(false); }) : null;
  // MENU_FAST_START (a reserved new-game hook, no emitter today) is a game start that is not MENU_START: it clears the skip like a Continue,
  // so a stale skip from an earlier dev-start new game never carries into it. MENU_DEPARTURE_START begins no game (MENU_START or MENU_CONTINUE follows it).
  // (The key is read by destructuring, not `Events.MENU_FAST_START ?`: test-events-graph counts a bare `Events.X` reference as an emit path, and this guard is not one.)
  const { MENU_FAST_START: fastKey } = Events;
  const offFast = fastKey ? eventBus.on(fastKey, () => { cancel(); armed = false; skip(false); }) : null;
  // The jump waits for the start burst: the comms panel keeps 4 waiting lines and skips the oldest plain one, so a chapter intro posted
  // in the middle of the boot lines is never drawn. The burst ends at the opening dance's hand-over (it posts "Arrived" / "Systems...
  // nominal." in that tick); the jump runs one timer tick later, so the intro is the newest line. No dance (flag off, reduced motion,
  // ?shot) means no hand-over: a real-time fallback fires START_JUMP_FALLBACK_MS after the orbit-view entry.
  const offState = eventBus.on(Events.GAME_STATE_CHANGE, (d) => {
    if (!armed || !d || d.to !== orbitalView) return;
    armed = false;
    waiting = true;
    fallback = setT(jump, START_JUMP_FALLBACK_MS);
  });
  const offHandover = Events.OPENING_DANCE_HANDOVER ? eventBus.on(Events.OPENING_DANCE_HANDOVER, () => {
    if (!waiting || afterStart !== null) return;
    afterStart = setT(jump, 0);
  }) : null;
  return () => {
    cancel();
    for (const off of [offStart, offContinue, offFast, offState, offHandover]) if (typeof off === 'function') off();
    skip(false);
  };
}

/** Real-time ceiling (ms) from the orbit-view entry to the dev start's mission jump when no opening-dance hand-over comes (measured: the start burst ends ~6 s after the entry). */
export const START_JUMP_FALLBACK_MS = 10000;
