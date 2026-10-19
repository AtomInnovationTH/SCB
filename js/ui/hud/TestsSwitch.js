/**
 * TestsSwitch.js — the one "Tests" switch for the developer-only extras.
 *
 * u6-tests-plain D1 (2026-10-19). `?tests=1` turns on everything that exists
 * only for testing: the Tests fold-out (sound list inside), the "INSPECTION"
 * notice and the orb's LAT/LON/ALT line. `?sounds=1` was the old switch and
 * stays as an alias. A leaf module (no imports) so any file can read it
 * without an import cycle.
 *
 * @module ui/hud/TestsSwitch
 */

/** True when `search` (a location.search string) carries `tests=1` or `sounds=1`. */
export function testsRequested(search) {
  try {
    const q = new URLSearchParams(search || '');
    return q.get('tests') === '1' || q.get('sounds') === '1';
  } catch (_e) { return false; }
}

/** The page's own answer, read from `location.search` (false outside a browser). */
export function testsRequestedHere() {
  return testsRequested(typeof location !== 'undefined' ? location.search : '');
}
