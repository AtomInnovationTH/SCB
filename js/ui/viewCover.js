/**
 * viewCover.js — the ONE per-frame "what covers the 3D view" signal
 * (docs/ladder/08-workbench.md §2 "Render policy").
 *
 * main.js computes it once per frame from plain booleans and uses it to skip
 * the paint work nobody can see: `sceneManager.render()` (the whole composer
 * pipeline) and `hud.update()` while an opaque plate covers the canvas. The
 * SIM POLICY IS UNCHANGED — this is a render seam only; the world keeps
 * ticking exactly as before (LIVE mode never pauses the sim; only the DEPOT
 * GameState pauses).
 *
 *   'full'    — an opaque plate covers the canvas: the Tech Library
 *               (CodexViewerUI, rgba(0,0,0,0.92)) or the ShopScreen plate.
 *               MenuScreen is deliberately NOT a cover: its plate is
 *               translucent and the live scene behind it is the design.
 *   'partial' — a workbench pane is open (Wave 5: REFIT / LIBRARY side panes);
 *               nothing consumes it yet, reserved so the signal has its three
 *               documented values from day one.
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
 * May this frame skip the scene paint (sceneManager.render + hud.update)?
 * Only under a 'full' cover, and NEVER while a diagnostic that reads the
 * framebuffer is armed: the BlackFrameProbe (?bfp) reads back scene lumas
 * right after the frame's render (a skipped render would read as a black
 * scene — the exact symptom it triages), and the ?shot harness
 * (DevShotGate.requested) captures #game-canvas pixels on demand.
 * @param {'full'|'partial'|'none'} cover - viewCover() result
 * @param {object} [o]
 * @param {boolean} [o.diagnosticsArmed=false] - BlackFrameProbe installed or DevShotGate.requested
 * @returns {boolean}
 */
export function coverSkipsPaint(cover, { diagnosticsArmed = false } = {}) {
  return cover === 'full' && !diagnosticsArmed;
}
