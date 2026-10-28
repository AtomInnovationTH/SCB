/**
 * The one "Tests" switch for the developer-only extras: `?tests=1` turns on the Tests fold-out (sound list inside),
 * the "INSPECTION" notice and the orb's LAT/LON/ALT line. `?sounds=1` stays as an alias.
 * Leaf module (imports only the leaf DevHost) so any file can read it without an import cycle.
 *
 * @module ui/hud/TestsSwitch
 */
import { devSearch } from '../../core/DevHost.js';

/** True when `search` (a location.search string) carries `tests=1` or `sounds=1`. */
export function testsRequested(search) {
  try {
    const q = new URLSearchParams(search || '');
    return q.get('tests') === '1' || q.get('sounds') === '1';
  } catch (_e) { return false; }
}

/** The page's own answer, read from `location.search` (false outside a browser). */
export function testsRequestedHere() {
  return testsRequested(devSearch());
}
