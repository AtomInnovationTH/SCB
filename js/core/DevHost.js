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
