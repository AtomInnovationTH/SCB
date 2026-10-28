// Exact-form helpers: a call site replaces an inline expression only when it is token-for-token the body below, so results are bit-identical.
// degToRad is `d * Math.PI / 180`, which can differ in the last bit from THREE.MathUtils.degToRad (`d * (π/180)`).

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function degToRad(d) { return d * Math.PI / 180; }
export function radToDeg(r) { return r * 180 / Math.PI; }
export function clamp01(x) { return Math.min(1, Math.max(0, x)); }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep01(t) { return t * t * (3 - 2 * t); }
