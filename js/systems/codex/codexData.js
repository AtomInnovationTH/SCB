/**
 * codexData.js — offline-first loader for data/codex.json.
 *
 * Global fetch by default, injected fetchImpl for tests. Any failure resolves to null so CodexSystem builds an empty
 * catalogue rather than crash (as CatalogLoader does).
 * Does NOT import node:fs (bundled into the browser build); Node tests pass the JSON to `new CodexSystem(data)`.
 *
 * @module systems/codex/codexData
 */

import { withDataVersion } from '../../core/dataUrl.js';

/**
 * @param {{ fetchImpl?: Function, basePath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>} parsed codex data, or null on any failure
 */
export async function loadCodexData(opts = {}) {
  const basePath = opts.basePath || './data/';
  const timeoutMs = opts.timeoutMs || 8000;
  const fetchFn = (typeof opts.fetchImpl === 'function')
    ? opts.fetchImpl
    // Real reads are version-stamped so a cache-first Service Worker copy cannot answer them (js/core/dataUrl.js).
    // Injected doubles stay bare: fixtures key on bare paths.
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
