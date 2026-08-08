/**
 * codexData.js — offline-first loader for data/codex.json.
 *
 * Browser- and Node-safe: uses the global fetch by default, accepts an
 * injected fetchImpl for tests. On any failure it resolves to null so
 * CodexSystem can construct an empty (graceful) catalogue rather than crash —
 * mirroring CatalogLoader's back-compat invariant.
 *
 * Does NOT import node:fs (it is bundled into the browser build); Node tests
 * read the JSON themselves and pass it straight to `new CodexSystem(data)`.
 *
 * @module systems/codex/codexData
 */

import { withDataVersion } from '../../core/dataUrl.js';

/**
 * Fetch + parse data/codex.json.
 * @param {{ fetchImpl?: Function, basePath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>} parsed codex data, or null on any failure
 */
export async function loadCodexData(opts = {}) {
  const basePath = opts.basePath || './data/';
  const timeoutMs = opts.timeoutMs || 8000;
  const fetchFn = (typeof opts.fetchImpl === 'function')
    ? opts.fetchImpl
    // Real network reads are version-stamped so a cache-first Service Worker
    // copy cannot answer them (see js/core/dataUrl.js). Injected doubles are
    // left alone — they are not a network, and fixtures key on bare paths.
    : (typeof fetch === 'function' ? (p) => fetch(withDataVersion(p)) : null);

  if (!fetchFn) {
    console.warn('[codexData] no fetch available — codex will load empty.');
    return null;
  }

  try {
    const withTimeout = (p) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('codexData: fetch timed out')), timeoutMs);
      p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
    const res = await withTimeout(fetchFn(basePath + 'codex.json'));
    if (!res || !res.ok) throw new Error(`codexData: HTTP ${res && res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.entries)) throw new Error('codexData: malformed payload');
    return data;
  } catch (e) {
    console.warn('[codexData] load failed, falling back to empty codex:', e.message);
    return null;
  }
}

export default loadCodexData;
