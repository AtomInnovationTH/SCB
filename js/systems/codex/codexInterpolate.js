/**
 * codexInterpolate.js — resolve `{{ Constants.path }}` placeholders in codex fullText, so the prose teaches the
 * same numbers the simulation uses (e.g. net_yo_yo_despin's settled RPM comes from Constants.CAPTURE_NET).
 *
 * Grammar (deliberately tiny, no eval): `{{ A.B }}`, `{{ A.B * N }}`, `{{ A.B / N }}`; whitespace ignored.
 * Unresolvable paths are left verbatim (the caller's validator reports them), never thrown.
 *
 * @module systems/codex/codexInterpolate
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:([*/])\s*([0-9]*\.?[0-9]+)\s*)?\}\}/g;

function resolvePath(root, path) {
  let cur = root;
  for (const key of path.split('.')) {
    // own-property only: "__proto__"/"constructor" must resolve to undefined, not Object.prototype.
    if (cur == null || typeof cur !== 'object'
      || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function interpolate(text, constants) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  return text.replace(PLACEHOLDER, (whole, path, op, num) => {
    const base = resolvePath(constants, path);
    if (typeof base !== 'number') return whole;
    let val = base;
    if (op === '*') val = base * Number(num);
    else if (op === '/') val = base / Number(num);
    // trim floating noise (120.00000001) without forcing decimals
    return String(Number.isInteger(val) ? val : Math.round(val * 1e6) / 1e6);
  });
}

export function placeholderPaths(text) {
  if (typeof text !== 'string') return [];
  const paths = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(text)) !== null) paths.push(m[1]);
  return paths;
}

export default interpolate;
