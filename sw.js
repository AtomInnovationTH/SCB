/*
 * Space Cowboy — Service Worker (PR 2, Subtask P0.3)
 * ---------------------------------------------------
 * Goal: cache-first repeat visits. Target on 2nd visit:
 *   - TTI < 500 ms, total network < 500 KB.
 *
 * Cache name: 'space-cowboy-v1'. Bump the version suffix when the cache
 * contract changes (e.g. when removing an entry from the pre-cache list)
 * so that `activate` can wipe the old store.
 *
 * Routing strategy (GET requests only — all other methods pass through):
 *
 *   NETWORK-FIRST (so new deploys take effect on the next visit, not the
 *   next-next visit; falls back to cache, then a synthetic offline Response):
 *     - HTML navigations (`request.mode === 'navigate'` OR Accept ~ text/html)
 *     - JS modules (URL pathname ends in .js or .mjs)
 *
 *   CACHE-FIRST (immutable / large blobs / vendor code — fetch from cache
 *   if present, otherwise hit the network and populate the cache):
 *     - Anything under `/vendor/` (Three.js + addons, vendored same-origin)
 *     - Anything under `/textures/`
 *     - Anything under `/data/`
 *
 *   PASS-THROUGH for anything else.
 *
 * Three.js is served same-origin from `./vendor/` (no CDN). The sim is
 * fully offline-first when served from any static host; the only hard limit
 * is that browsers bypass the service worker on a force-refresh, so offline
 * hard-refresh works when a local server is running (localhost serves
 * everything) but on a remote deploy a hard-refresh needs the network — a
 * normal reload is the offline path there.
 *
 * Scope: this file lives at the workspace root and is registered from
 * index.html via the relative path `./sw.js`, so the scope is the page
 * directory by default. Locally that is `/`; on GitHub Pages it is `/SCB/`.
 * Do NOT hard-code `/SCB/` — all paths in this file are relative.
 *
 * The SW does not intercept its own URL (we never call respondWith for it).
 */

const CACHE_NAME = 'space-cowboy-v9';

// Small, safe pre-cache list. Each entry is wrapped in try/catch so a single
// 404 (e.g. local dev without ./js/main.js yet) does NOT abort installation.
const PRECACHE_URLS = [
  './',
  './index.html',
  './js/main.js',
  './vendor/three/build/three.module.js',
  // three.module.js statically imports ./three.core.js — precache both so the
  // engine is self-consistent even on an install-then-immediately-offline boot.
  './vendor/three/build/three.core.js',
];

// ---------------------------------------------------------------------------
// INSTALL — pre-cache the core shell, then activate immediately.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // Add entries one-by-one so a single failure doesn't abort the rest.
      await Promise.all(PRECACHE_URLS.map(async (url) => {
        try {
          await cache.add(url);
        } catch (err) {
          // Swallow — pre-cache is best-effort, not load-bearing.
          // (Avoids 'install failed' on missing files during local dev.)
          // eslint-disable-next-line no-console
          console.warn('[SW] pre-cache miss for', url, err);
        }
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[SW] install error:', err);
    }
    await self.skipWaiting();
  })());
});

// ---------------------------------------------------------------------------
// ACTIVATE — claim clients, evict stale caches.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[SW] activate cleanup error:', err);
    }
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------------
// FETCH — route based on request URL + headers.
// ---------------------------------------------------------------------------

/** Is this an HTML navigation? */
function isHTMLRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

/** Is this a JS module fetch? */
function isJSRequest(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.js') || p.endsWith('.mjs');
}

/** Should this URL be served cache-first? */
function isCacheFirstURL(url) {
  if (url.pathname.includes('/vendor/')) return true;
  if (url.pathname.includes('/textures/')) return true;
  if (url.pathname.includes('/data/')) return true;
  return false;
}

/** Synthetic offline response when both network and cache fail. */
function offlineResponse(url) {
  return new Response(
    `// [SW] offline — ${url.href} not available\n`,
    {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }
  );
}

/**
 * Network-first: try the network, populate cache on success, fall back to
 * cache on failure, then a synthetic offline Response.
 *
 * The network fetch is bounded by a short AbortController timeout ONLY when
 * the browser reports itself offline (`!navigator.onLine`), so a dead-but-
 * connected network (captive portal, VPN with no upstream) falls back to
 * cache fast instead of blocking on the OS socket timeout. When online, the
 * fetch is unbounded so a slow-but-healthy connection still gets the latest
 * deploy rather than being force-aborted into a stale cached copy. On
 * localhost this never trips; it's insurance for remote deploys.
 *
 * IMPORTANT: clone the response BEFORE handing it to the page; `cache.put`
 * consumes the clone's body, not the original.
 */
const NETWORK_TIMEOUT_MS = 4000;

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  // Only arm the abort timer when the browser thinks it's offline — avoids
  // aborting a slow-but-online fetch and serving stale code (see comment above).
  const controller = new AbortController();
  const timer = (typeof navigator !== 'undefined' && navigator.onLine === false)
    ? setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    : null;
  try {
    const networkResponse = await fetch(request, { signal: controller.signal });
    if (networkResponse && networkResponse.ok) {
      // Clone first — do NOT await put before returning to the page.
      const copy = networkResponse.clone();
      cache.put(request, copy).catch(() => { /* ignore quota / opaque errors */ });
    }
    return networkResponse;
  } catch (_err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineResponse(new URL(request.url));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Cache-first: serve from cache if present, otherwise fetch from network
 * and populate cache on success. Only response.ok responses are stored to
 * avoid poisoning the cache.
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const copy = networkResponse.clone();
      cache.put(request, copy).catch(() => { /* ignore */ });
    }
    return networkResponse;
  } catch (_err) {
    return offlineResponse(new URL(request.url));
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Non-GET requests bypass the SW entirely.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_err) {
    return; // malformed URL — let the browser handle it.
  }

  // Don't intercept the SW's own URL.
  if (url.pathname.endsWith('/sw.js')) return;

  // Only handle http(s) — skip chrome-extension://, data:, blob:, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Cache-first: vendored Three.js (./vendor/), textures, data. This MUST be
  // checked before the JS network-first branch below, otherwise vendored
  // `.js` modules would match isJSRequest() and go network-first.
  if (isCacheFirstURL(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Network-first: HTML navigations + JS modules (so new deploys take effect
  // on the next visit; falls back to cache, then a synthetic offline Response).
  if (isHTMLRequest(request) || isJSRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Anything else — passthrough (don't call respondWith).
});
