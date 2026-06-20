/**
 * codexInterpolate.js — resolve live-value placeholders in codex prose.
 *
 * Entry fullText may embed `{{ Constants.path }}` placeholders so an "expert
 * stat-table" entry teaches the SAME numbers the simulation actually uses
 * (e.g. net_yo_yo_despin's settled RPM is derived from Constants.CAPTURE_NET).
 * Baking the numbers into static JSON would let them drift from the constants;
 * resolving at load keeps prose and physics in lock-step.
 *
 * Placeholder grammar (deliberately tiny — no arbitrary eval):
 *     {{ DOTTED.PATH }}          → Constants.DOTTED.PATH
 *     {{ DOTTED.PATH * NUMBER }} → Constants.DOTTED.PATH multiplied by NUMBER
 *     {{ DOTTED.PATH / NUMBER }} → divided by NUMBER
 * Whitespace around tokens is ignored. Unresolvable paths are left verbatim
 * (and reported by the caller's validator) rather than throwing at runtime.
 *
 * @module systems/codex/codexInterpolate
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:([*/])\s*([0-9]*\.?[0-9]+)\s*)?\}\}/g;

/**
 * Walk a dotted path on a root object. Returns undefined if any hop is missing.
 * @param {object} root
 * @param {string} path  e.g. 'CAPTURE_NET.LARGE.SPIN_HZ'
 * @returns {*}
 */
function resolvePath(root, path) {
  let cur = root;
  for (const key of path.split('.')) {
    // own-property only — never traverse the prototype chain (so paths like
    // "__proto__"/"constructor" resolve to undefined, not Object.prototype).
    if (cur == null || typeof cur !== 'object'
      || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Resolve all placeholders in a string against `constants`.
 * @param {string} text
 * @param {object} constants  the Constants object (root for paths)
 * @returns {string}
 */
export function interpolate(text, constants) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  return text.replace(PLACEHOLDER, (whole, path, op, num) => {
    const base = resolvePath(constants, path);
    if (typeof base !== 'number') return whole; // leave verbatim if unresolved
    let val = base;
    if (op === '*') val = base * Number(num);
    else if (op === '/') val = base / Number(num);
    // Trim floating noise (e.g. 120.00000001) without forcing decimals.
    return String(Number.isInteger(val) ? val : Math.round(val * 1e6) / 1e6);
  });
}

/**
 * List the dotted paths referenced by any placeholder in a string (for tests
 * that validate every placeholder resolves against the real Constants).
 * @param {string} text
 * @returns {string[]}
 */
export function placeholderPaths(text) {
  if (typeof text !== 'string') return [];
  const paths = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(text)) !== null) paths.push(m[1]);
  return paths;
}

export default interpolate;
