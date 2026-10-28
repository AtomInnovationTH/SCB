/**
 * viewCover.js — the ONE per-frame "what covers the 3D view" signal
 * (docs/ladder/08-workbench.md §2 "Render policy"). main.js uses it to skip
 * `sceneManager.render()` and `hud.update()` while an opaque plate covers the canvas.
 * Render seam only: the sim policy is unchanged (LIVE mode never pauses the sim).
 *
 *   'full'    — an opaque plate covers the canvas: the Tech Library or the ShopScreen plate.
 *               MenuScreen is deliberately NOT a cover: its plate is translucent and the live scene is the design.
 *   'partial' — a workbench side pane is open; nothing consumes it yet (reserved).
 *   'none'    — the canvas is the view.
 *
 * Pure functions over booleans; no DOM, no imports.
 *
 * @module ui/viewCover
 */

/**
 * @param {object} [s]
 * @param {boolean} [s.codexVisible=false] - CodexViewerUI.isVisible()
 * @param {boolean} [s.shopVisible=false]  - ShopScreen.visible
 * @param {boolean} [s.paneOpen=false]     - a workbench side pane is open (reserved)
 * @returns {'full'|'partial'|'none'}
 */
export function viewCover({ codexVisible = false, shopVisible = false, paneOpen = false } = {}) {
  if (codexVisible || shopVisible) return 'full';
  if (paneOpen) return 'partial';
  return 'none';
}

/**
 * May this frame skip the scene paint? Only under a 'full' cover, and NEVER while a
 * framebuffer-reading diagnostic is armed: the BlackFrameProbe (?bfp) would read a skipped
 * render as a black scene, and the ?shot harness (DevShotGate.requested) captures canvas pixels.
 * @param {'full'|'partial'|'none'} cover - viewCover() result
 * @param {object} [o]
 * @param {boolean} [o.diagnosticsArmed=false] - BlackFrameProbe installed or DevShotGate.requested
 * @returns {boolean}
 */
export function coverSkipsPaint(cover, { diagnosticsArmed = false } = {}) {
  return cover === 'full' && !diagnosticsArmed;
}
