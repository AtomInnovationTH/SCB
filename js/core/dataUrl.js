/**
 * @module core/dataUrl — one place that cache-busts every ./data/ JSON read.
 *
 * WHY: the Service Worker once served ./data/ cache-first, pinning a cached copy until CACHE_NAME changes; loaders
 * build their DOM/state once at boot from whatever that copy holds, so a client on an older worker kept booting stale
 * content and no reload helped (the request URL never changed). sw.js is now network-first for ./data/, but that only
 * helps clients that already took the new worker; a stamped URL fixes the rest, because a cache entry for `x.json`
 * cannot answer a request for `x.json?v=0.998`.
 *
 * Stamping lives in the NETWORK ADAPTER, not in URL construction: an injected test double is not a network and needs no
 * cache busting, so fixtures keyed on bare paths keep working. The stamp reads Constants.DATA_VERSION, deliberately
 * separate from Constants.VERSION (a content edit must invalidate cached JSON without moving the release number in the
 * menu). Bump DATA_VERSION whenever ./data/ content changes and every loader picks it up.
 */

import { Constants } from './Constants.js';

/**
 * Append `?v=<data version>` to a ./data/ URL (relative path, with or without a query). Pure and idempotent; non-string
 * input is returned unchanged.
 */
export function withDataVersion(url, version = Constants.DATA_VERSION) {
  if (typeof url !== 'string' || url === '') return url;
  if (/[?&]v=/.test(url)) return url;             // already stamped
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`;
}

/**
 * `fetch` for ./data/ reads, always version-stamped. Production loaders must use this (or a fetcher built from it),
 * never fetch with a bare data path; test-DataVersion.js guards that.
 */
export function fetchData(url, init) {
  return fetch(withDataVersion(url), init);
}
