/**
 * shopPin.js — pure progress math for the pinned "next upgrade" chase target (split from ShopScreen so the HUD
 * doesn't pull the shop module graph). The pin is ONLY player-chosen (ShopScreen.pinUpgrade/togglePin); never
 * auto-pin: it advertised capacity bumps the player never chose.
 *
 * @module ui/shopPin
 */

import { clamp01 } from '../core/MathUtil.js';

/** Progress toward a pinned shop upgrade (HUD "next goal" widget). pct is 0..1. */
export function pinProgress(credits, upgrade) {
  if (!upgrade || !(upgrade.cost > 0)) {
    return { pct: 0, remaining: 0, affordable: false };
  }
  const c = Math.max(0, credits || 0);
  const pct = clamp01(c / upgrade.cost);
  const remaining = Math.max(0, upgrade.cost - c);
  return { pct, remaining, affordable: c >= upgrade.cost };
}
