/**
 * OpeningDive.js — the opening dive through the real dots, behind a test switch (lane sky-dive-1118, DECISIONS §75 row 5).
 *
 * Owner 2026-11-18: "A job makes a slower dive, about 6 s, from the globe through the real dots down to her ship. The dots fade
 * near the ship, and any key skips it as today. It stays behind a test switch until you look on the Mac."
 *
 * The switch is `?dive=1`, read through `devSearch()`: it works on a dev host (localhost on the Mac) and nowhere else, so a public
 * page never dives. With it off nothing in this file runs and the opening is exactly today's.
 *
 * The camera ride itself belongs to LadderController (`armIntroRide({ dive: true })`, INTRO_DIVE_MS, `diveInFlight()`,
 * `finishDive()`). This file owns what the dive adds on top: the dots' opacity by the camera's distance from the ship, and
 * the skip. Every frame (main.js, next to `realSkyLayer.update()`):
 *   - dive begins: the dots turn on at opacity 0 (RealSkyLayer.diveBegin), and the ship's hull callouts are held back
 *     (`suppress(true)`): the dive's far clip plane brings the ship into the frame 800 u out, where its part names would
 *     hang round a one-pixel ship (measured 2026-11-19, frame at dance t 3.0 s); today's far plane clipped them;
 *   - dive flies: opacity = `diveAlpha(distance from the ship)`, the dots are moved (diveTick);
 *   - a skip (OpeningDance.isSkipping, set by any key / click / tap) during the dive: the camera finishes the descent within
 *     INTRO_DIVE_SKIP_MS (finishDive) and the dots hide at once;
 *   - the dive is over (landing, skip, input): diveEnd puts the dots back on today's floor 4-5 rules at once; `suppress(false)`
 *     lets the callouts in again only when the ladder's dive far plane is released (`diveClipActive()` false), because after
 *     input or a skip the camera still descends with that plane.
 *
 * @module ui/OpeningDive
 */

import { devSearch } from '../core/DevHost.js';

/**
 * The dots are at full opacity while the camera is farther than this from the ship, metres: floor 4's near edge, 7,000 km (the
 * camera then stands among the dots, as the player does on floor 4).
 */
export const DIVE_FADE_START_M = 7.0e6;
/**
 * ... and gone once it is closer than this, metres: 120 km, the top of floor 3 (the ship's own neighbourhood). Between the two
 * the opacity falls with the LOGARITHM of the distance (the ride covers the last decades in its last moments).
 */
export const DIVE_FADE_END_M = 1.2e5;

/**
 * The `?dive=1` test switch (dev host only; `loc` is injectable for tests).
 * @param {{protocol?:string, hostname?:string, search?:string}|null|undefined} [loc]
 * @returns {boolean}
 */
export function devDive(loc = globalThis.location) {
  return new URLSearchParams(devSearch(loc)).get('dive') === '1';
}

/**
 * The dots' opacity at a camera distance from the ship: 1 at DIVE_FADE_START_M and beyond, 0 at DIVE_FADE_END_M and inside,
 * linear in log10(distance) between. A non-finite distance gives 0 (nothing is shown that cannot be placed).
 * @param {number} distM metres
 * @returns {number} 0..1
 */
export function diveAlpha(distM) {
  if (!Number.isFinite(distM)) return 0;
  if (distM >= DIVE_FADE_START_M) return 1;
  if (distM <= DIVE_FADE_END_M) return 0;
  return Math.log(distM / DIVE_FADE_END_M) / Math.log(DIVE_FADE_START_M / DIVE_FADE_END_M);
}

export class OpeningDive {
  /**
   * @param {object} deps every one needed; a missing one makes update() a no-op
   * @param {{diveInFlight:function, finishDive:function, diveClipActive:function}} deps.ladder LadderController
   * @param {{diveBegin:function, diveSetAlpha:function, diveTick:function, diveEnd:function}} deps.layer RealSkyLayer
   * @param {{isSkipping:function}} deps.dance OpeningDance
   * @param {function} deps.getDistM () => the camera's distance from the ship, metres
   * @param {function} [deps.suppress] (on:boolean) => void; holds the hull callouts back (MotherCallouts.setSuppressed)
   */
  constructor(deps = {}) {
    this._ladder = deps.ladder || null;
    this._layer = deps.layer || null;
    this._dance = deps.dance || null;
    this._getDistM = deps.getDistM || (() => NaN);
    this._suppress = deps.suppress || null;
    this._on = false;        // the layer's dive is running
    this._skipped = false;   // a skip ended the dive (stays set until the ladder's dive is over)
    this._held = false;      // the hull callouts are held back (until the ladder's dive far plane is released)
  }

  /** True while the dots are being shown for the dive. */
  active() { return this._on; }

  /** @private the dive's dots off: back to today's rules. The callouts are released separately (`_release`), later. */
  _stop() {
    if (!this._on) return;
    this._on = false;
    this._layer.diveEnd();
  }

  /**
   * @private Lets the hull callouts back, but only once the dive's far plane is gone (`ladder.diveClipActive()`): after input or a
   * skip mid-dive the camera keeps descending with the 2000 far plane, and the names would hang round a one-pixel ship.
   * A ladder with no such getter has no clip to wait for.
   */
  _release() {
    if (!this._held) return;
    const l = this._ladder;
    if (typeof l.diveClipActive === 'function' && l.diveClipActive()) return;
    this._held = false;
    if (this._suppress) this._suppress(false);
  }

  /** One frame. Cheap when no dive flies: one boolean read. */
  update() {
    const ladder = this._ladder, layer = this._layer;
    if (!ladder || !layer) return;
    const flying = ladder.diveInFlight();
    if (!flying) {
      this._skipped = false;
      this._stop();
      this._release();
      return;
    }
    if (!this._skipped && this._dance && this._dance.isSkipping && this._dance.isSkipping()) {
      this._skipped = true;
      ladder.finishDive();
    }
    if (this._skipped) {
      this._stop();
      this._release();
      return;
    }
    if (!this._on) {
      this._on = true;
      if (!this._held) { this._held = true; if (this._suppress) this._suppress(true); }
      layer.diveBegin();
    }
    layer.diveSetAlpha(diveAlpha(this._getDistM()));
    layer.diveTick();
  }
}
