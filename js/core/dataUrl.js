/**
 * dataUrl.js — one place that cache-busts every ./data/ JSON read.
 *
 * WHY THIS EXISTS
 * The Service Worker used to serve ./data/ cache-first (sw.js), which pins a
 * cached copy until CACHE_NAME changes. Loaders build their DOM/state once at
 * boot from whatever that copy contains, so a client running an older worker
 * kept booting stale content and could never see a shipped data change — no
 * number of reloads helped, because the request URL never changed. sw.js is now
 * network-first for ./data/, but that only helps clients that already took the
 * new worker; a stamped URL fixes the ones that have not, because a cache entry
 * for `x.json` cannot answer a request for `x.json?v=0.998`.
 *
 * Stamping lives in the NETWORK ADAPTER, not in URL construction: an injected
 * test double is not a network and needs no cache busting, so fixtures keyed on
 * bare paths keep working while production requests are always versioned.
 *
 * Bump Constants.VERSION when ./data/ content changes and every loader below
 * picks it up for free.
 *
 * @module core/dataUrl
 */

import { Constants } from './Constants.js';

/**
 * Append `?v=<app version>` to a ./data/ URL. Pure and idempotent.
 * @param {string} url — relative path, with or without an existing query
 * @param {string} [version=Constants.VERSION]
 * @returns {string} the stamped URL (input returned unchanged when not a string)
 */
export function withDataVersion(url, version = Constants.VERSION) {
  if (typeof url !== 'string' || url === '') return url;
  if (/[?&]v=/.test(url)) return url;             // already stamped
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`;
}

/**
 * `fetch` for ./data/ reads — identical to fetch, but always version-stamped.
 * Production loaders must use this (or a fetcher built from it) instead of
 * calling fetch with a bare data path; test-DataVersion.js guards that.
 * @param {string} url @param {object} [init]
 * @returns {Promise<Response>}
 */
export function fetchData(url, init) {
  return fetch(withDataVersion(url), init);
}
