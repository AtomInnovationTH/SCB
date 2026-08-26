/**
 * shopPin.js — S1 retention: pure helpers for the pinned "next upgrade" chase
 * target (2026-07-23).
 *
 * Extracted from ShopScreen so the DOM-bound HUD can import the progress math
 * without pulling the whole shop module graph. The pin is ONLY player-chosen
 * (ShopScreen.pinUpgrade/togglePin) — the former cheapest-item auto-pin was
 * removed: it advertised capacity bumps the player never chose (e.g.
 * "Extra Cold Gas — READY AT DEPOT" with full tanks). Pure — no DOM,
 * no singletons, unit-tested directly.
 *
 * @module ui/shopPin
 */

/**
 * Live progress toward a pinned shop upgrade, for the "visible next goal" HUD
 * widget.
 * @param {number} credits - current spendable credits
 * @param {{cost:number}|null|undefined} upgrade - the pinned upgrade catalog row
 * @returns {{pct:number, remaining:number, affordable:boolean}}
 */
export function pinProgress(credits, upgrade) {
  if (!upgrade || !(upgrade.cost > 0)) {
    return { pct: 0, remaining: 0, affordable: false };
  }
  const c = Math.max(0, credits || 0);
  const pct = Math.max(0, Math.min(1, c / upgrade.cost));
  const remaining = Math.max(0, upgrade.cost - c);
  return { pct, remaining, affordable: c >= upgrade.cost };
}
