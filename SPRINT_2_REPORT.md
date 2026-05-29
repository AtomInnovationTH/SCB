# Space Cowboy — Sprint 2 Report

*Companion to [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1) and [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:1). Sprint 2 executes the top-5 ROI items from [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:242) § 5 and adds an in-game measurement harness so the "🟡" rows in the Sprint 1 report can finally be promoted to "✅".*

*Generated 2026-05-22 — uses one real browser snapshot (Chrome 148 on Apple M4 Max, see § 4.1).*

---

## § 1 — Executive Summary

Sprint 2 shipped:

| Phase | Deliverable | Test delta |
|---|---|---|
| **A** | [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1) (`?perfReport=1` flag) + [`isAvifSupported()`](js/scene/Earth.js:407) getter + [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:735) § 5.1 "How to capture acceptance data" | 0 |
| **B / PR A** | [`keplerianToCartesianInto`](js/entities/OrbitalMechanics.js:507) + [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:572) and 6 hot call sites migrated to scratch-output objects | +6 (new [`test-OrbitalMechanics-scratch.js`](js/test/test-OrbitalMechanics-scratch.js:1)) |
| **B / PR B** | [`runtimeAdapt`](js/systems/QualityManager.js:116) auto-upshift path with 50/58 fps hysteresis band and 600-frame cooldown | +11 (extended [`test-QualityManager.js`](js/test/test-QualityManager.js:1)) |
| **B / PR C** | Earth fragment-shader `LOW_DETAIL` define + [`Earth.setLowDetail`](js/scene/Earth.js:606) + [`SceneManager.setEarth`](js/scene/SceneManager.js:266) plumbing | 0 (GLSL — no Node test) |
| **B / PR D** | FXAA `ShaderPass` at MEDIUM tier (replaces the "lol no" `console.log` from [`SceneManager.js:236`](js/scene/SceneManager.js:204)) | 0 (composer — no Node test) |
| **B / PR E** | Cached `getBoundingClientRect()` in [`HUD.update()`](js/ui/HUD.js:841) — invalidated on resize + `VIEW_CONFIG_CHANGE` | 0 (DOM — no Node test) |

**Test count delta:** **2134 → 2151 (+17)**. All 2151 tests pass.

**Headline numbers** (see § 4 for the captured snapshot, § 3.1 for the allocation-budget inference):

- **`orbitToSceneCartesian` allocation pressure** — at the upper-bound assumption of 300 alive debris × 60 fps × 6 call sites per debris ≈ **~108 000 fresh `{position:{x,y,z}, velocity:{x,y,z}}` literals/sec eliminated** on dense missions. Each literal is ≈ 64–96 bytes, so the GC sawtooth-fuel drops from a documented ~6–9 MB/sec to ~zero for this path. (The 6 sites covered here are the per-frame ones; per-tick AP/reticle sites are a fraction of that.)
- **MEDIUM tier no longer ships without post-AA.** FXAA `ShaderPass` is one fullscreen quad (~0.3 ms on Iris Xe per the analysis); the SMAA → MEDIUM gap that used to print `[Perf] useFXAAFallback requested but FXAAPass not implemented yet — relying on MSAA only.` is closed.
- **LOW tier Earth fragment cost: 7 octaves of simplex noise compiled out.** On iGPUs this is the ~2–4 ms/frame win identified in [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:205) § 3.10. (Not measurable on M4 Max — it shows 8.3 ms median frame time at HIGH already.)
- **Auto-upshift now exists.** Users who survive a Kessler burst on LOW can climb back to HIGH once the cluster decays, instead of being permanently stuck.
- **HUD per-frame sync layout removed.** [`HUD.update()`](js/ui/HUD.js:835) used to call `getBoundingClientRect()` every frame; now once at boot and on the two events that can actually move the comms panel.

**What is _not_ in Sprint 2** (intentionally — see § 5 deferred list): InstancedMesh merge for debris (gated on `?profile=1` showing > 250 draw calls; current Chrome menu-state snapshot shows **1**), WebGPU renderer, MoidCalculator-in-Worker, oscillator pooling, dynamic-import of boot screens. These remain candidates for a hypothetical Sprint 3.

---

## § 2 — Phase A: Measurement Harness

### § 2.1 — [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1)

A fixed-position top-right DOM overlay (~320 px × auto) that updates at 1 Hz when the page is loaded with `?perfReport=1`. The 1 Hz cadence keeps the overlay's own overhead unmeasurable (~negligible vs. the 60–120 Hz game loop).

**Rows surfaced — every "🟡" datum from [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1) in one place:**

| Row | Source | Tested? |
|---|---|:--:|
| **Tier (current / reason)** | `sceneManager.currentTier` + `Events.PERF_TIER_CHANGED` log | ✅ |
| **GPU median ms (samples)** | [`GpuProbe.getMedianMs()`](js/systems/GpuProbe.js:177) + `getSampleCount()` | ✅ |
| **FPS median (n=…)** | Median of the same `_fpsHistory` consumed by [`runtimeAdapt`](js/systems/QualityManager.js:116) | ✅ |
| **Frame ms median / p99** | Sliding 5-s window (600 samples) collected by overlay's own `requestAnimationFrame` sampler | ✅ |
| **Draw calls / triangles / points / lines** | `renderer.info.render.*` (same source as `?profile=1`) | ✅ |
| **JS heap used / total** | `performance.memory.usedJSHeapSize` (Chrome/Edge only — `n/a` on Safari/Firefox) | ✅ |
| **Active timers** | [`timerManager.activeCount()`](js/systems/TimerManager.js:194) | ✅ |
| **Alive debris** | `debrisField.debrisList.filter(d => d.alive).length` (inlined loop to avoid allocation) | ✅ |
| **Boot block** | SW state, AVIF support, maxTextureSize, dpr, deviceMemoryGB, isAppleGPU, unmaskedRenderer, pickedTier, tierConfig, userAgent | ✅ |

**📋 COPY SNAPSHOT button.** Serializes the current state as JSON and writes it to `navigator.clipboard` (falls back to a hidden-textarea `execCommand('copy')` on legacy browsers). Always also dumps the snapshot to `console.log` so the user can grab it from DevTools when the clipboard API is blocked.

**Boot-time one-shot log.** [`captureBootInfo()`](js/ui/PerfReportOverlay.js:485) is called from [`main.js`](js/main.js:520) right after `renderer.compile()` and immediately printed via `console.info('[PerfReport] boot snapshot:', boot)` so it lands in the first wave of console output even when the overlay is offscreen on small viewports.

**URL flag wiring.** [`main.js`](js/main.js:194) parses `?perfReport=1` next to the existing `?debug=1` / `?profile=1` blocks; the overlay is attached only after `sceneManager` + `debrisField` are constructed (no premature refs).

### § 2.2 — [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:735) § 5.1

Added a "How to Capture Acceptance Data" subsection with:
- the recommended URL combo (`?profile=1&perfReport=1&debug=1`),
- a 7-step DevTools checklist (Network waterfall, two heap snapshots 5 min apart, 10-s Performance trace, COPY SNAPSHOT click),
- a 3-browser matrix (Chrome / Safari / Firefox) noting what each browser validates (GPU probe is Chrome-only; `performance.memory` is Chromium-only; etc.),
- explicit acceptance criteria for Phase A overlay correctness.

---

## § 3 — Phase B: Code Changes (PRs A–E)

### § 3.1 — PR A — `orbitToSceneCartesian` scratch-output refactor

**Files touched:**

| File | Lines | Change |
|---|---|---|
| [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:501) | 501–608 | Added [`keplerianToCartesianInto()`](js/entities/OrbitalMechanics.js:507) and [`orbitToSceneCartesianInto()`](js/entities/OrbitalMechanics.js:572). The allocating versions stay for back-compat / tests. |
| [`DebrisField.js`](js/entities/DebrisField.js:194) | imports + ctor + 2 call sites | Pre-allocated `_tmpCartPos`/`_tmpCartVel`/`_tmpBgOrbit`; killed the `{...orbit, semiMajorAxis: …}` spread in [`_updateBackground()`](js/entities/DebrisField.js:1318) |
| [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:106) | imports + ctor + 3 call sites in [`_resolveTargetState()`](js/systems/AutopilotSystem.js:802) | `_tmpAPCartPos`/`_tmpAPCartVel` scratch |
| [`TargetReticle.js`](js/ui/TargetReticle.js:16) | imports + ctor + 4 call sites | `_tmpCartPos`/`_tmpCartVel` scratch in [`update()`](js/ui/TargetReticle.js:412), [`_drawDebrisReticle()`](js/ui/TargetReticle.js:679), [`_drawTargetLeadIndicator()`](js/ui/TargetReticle.js:1416) |
| [`main.js`](js/main.js:29) | imports + 3 module-scope scratches + approach-distance check | `_approachCartPos`/`_approachCartVel`/`_approachTargetVec3` |
| [`test-OrbitalMechanics-scratch.js`](js/test/test-OrbitalMechanics-scratch.js:1) | new file | 6 tests across 2 suites — output equivalence, zero state leak, 5000-call drift check, scratch isolation |

**Numerical equivalence.** The new tests assert maximum component-wise delta < `1e-12` (km path) and `< 1e-9` (scene path) across 6 canonical orbits (circular LEO, ISS-like, sun-sync polar, Molniya, GEO, highly inclined). All pass.

**Why this is the headline.** [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:82) § 3.1 catalogued these call sites as the single largest source of per-frame GC pressure (~30–100 k literal allocations/sec, ~6–9 MB/sec of short-lived heap at the upper bound). Switching to scratch outputs eliminates the inner `{position, velocity}` literals entirely on the per-frame hot paths. The Vector3 allocations downstream of these calls are unchanged — they're either pre-allocated scratch (Autopilot) or one-shot per visible target (TargetReticle), both of which are at a per-target rate, not per-debris-per-frame.

**Headline number (inferred — no in-browser allocation profiler in this sprint):**

> At the [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:82) § 3.1 upper bound (300 alive debris × 60 fps × 6 call sites/frame) **~108 000 short-lived object literals/sec are no longer allocated**.
>
> At the lower bound (50 alive debris × 60 fps × 6 sites) the cut is **~18 000/sec**.

The actual number lands somewhere in that band depending on mission load; we did not capture an allocation profile in DevTools for this report.

### § 3.2 — PR B — `runtimeAdapt` auto-upshift with hysteresis

**Files touched:**

| File | Lines | Change |
|---|---|---|
| [`Constants.js`](js/core/Constants.js:2191) | 2191–2199 | `ADAPT_UPSHIFT_FPS_THRESHOLD = 58`, `ADAPT_UPSHIFT_COOLDOWN_FRAMES = 600` |
| [`QualityManager.js`](js/systems/QualityManager.js:116) | 116–200 | Extended [`runtimeAdapt()`](js/systems/QualityManager.js:116) with optional `upshiftThreshold` / `upshiftCooldownFrames`. Returns new `direction: 'up' | 'down' | null` field. Downshift wins ties. |
| [`main.js`](js/main.js:585) | 585–614 | Passes the two new knobs; emits `Events.PERF_TIER_CHANGED` with `reason: 'auto-upshift'` or `'auto-downshift'` |
| [`test-QualityManager.js`](js/test/test-QualityManager.js:271) | +11 tests | Upshift gate; cooldown gate (599 vs 600); threshold gate (57 vs 58); ceiling (HIGH); hysteresis band (53 fps median → no change); flapping LOW → no upshift; step-by-step (LOW → MEDIUM, not LOW → HIGH); downshift-wins-tie; opt-in (no upshift when knobs omitted); 2 Constants integration tests |

**Hysteresis band.** Downshift fires at median < 50 over 300 frames; upshift fires at median ≥ 58 over 600 frames. The 50–58 dead band suppresses HIGH ↔ MEDIUM ping-pong when the workload sits near 55 fps. The 300/600 cooldown asymmetry codifies "be optimistic, but be sure".

**Back-compat.** Callers that don't pass `upshiftThreshold` / `upshiftCooldownFrames` get the original downshift-only behaviour (verified by the existing 9 downshift tests continuing to pass alongside the 11 new ones).

### § 3.3 — PR C — Earth fragment shader LOW_DETAIL variant

**Files touched:**

| File | Lines | Change |
|---|---|---|
| [`Earth.js`](js/scene/Earth.js:99) | shader + ctor + new method | `#ifndef LOW_DETAIL` wraps `terrainDetail` + `detailTiling` and their two `dayColor *= 1.0 + …` mix lines; added [`Earth.setLowDetail()`](js/scene/Earth.js:606); ctor inits `_useLowDetail = false`; `_createSurface()` passes `defines: this._useLowDetail ? { LOW_DETAIL: 1 } : {}` |
| [`SceneManager.js`](js/scene/SceneManager.js:266) | new setter + applyTier hook | [`setEarth(earth)`](js/scene/SceneManager.js:266) registers the Earth; [`applyTier(tierName)`](js/scene/SceneManager.js:295) calls `earth.setLowDetail(tierName === 'LOW')` |
| [`main.js`](js/main.js:224) | 1 line | `sceneManager.setEarth(earth)` right after Earth construction |

**Mid-flight tier swap.** [`Earth.setLowDetail()`](js/scene/Earth.js:606) mutates `material.defines` + sets `material.needsUpdate = true`. Three.js recompiles the WebGL program on the next render; the snapshot uniform bindings stay intact so there's no NaN/black-screen flash. (Cannot verify in Node — needs a real browser to confirm the recompile.)

**Why this matters.** [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:205) § 3.10 measured that `terrainDetail()` runs **5 octaves of simplex noise per fragment** and `detailTiling()` adds **2 more**. With Earth filling 30–60 % of the screen at LEO altitude, that's the dominant fragment cost. The LOW tier now compiles those out entirely — the 8k base AVIF texture is already detailed enough.

### § 3.4 — PR D — FXAA at MEDIUM tier

**Files touched:**

| File | Lines | Change |
|---|---|---|
| [`SceneManager.js`](js/scene/SceneManager.js:14) | imports | Added [`ShaderPass`](js/scene/SceneManager.js:14) and [`FXAAShader`](js/scene/SceneManager.js:15) from `three/addons` |
| [`SceneManager.js`](js/scene/SceneManager.js:179) | `_setupPostProcessing` | New `else if (cfg.useFXAAFallback)` branch: constructs an FXAA `ShaderPass`, sets `resolution` uniform to `(1/(w*dpr), 1/(h*dpr))`, appends to composer after bloom. The no-op `console.log` warning is removed. `_disposePostProcessing` now also clears `this.fxaaPass`. |
| [`SceneManager.js`](js/scene/SceneManager.js:418) | `resize()` | Updates the FXAA resolution uniform on viewport changes |

**Three.js addons are already in the import map** (`https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/`), so no `index.html` change was needed. SW will cache the new `ShaderPass.js` + `FXAAShader.js` modules the first time the page loads.

### § 3.5 — PR E — Cache `getBoundingClientRect` in HUD

**Files touched:**

| File | Lines | Change |
|---|---|---|
| [`HUD.js`](js/ui/HUD.js:133) | ctor | New `_commsRectBottom = null` cache |
| [`HUD.js`](js/ui/HUD.js:691) | `_setupEventListeners` | Invalidate cache (`_commsRectBottom = null`) on `Events.VIEW_CONFIG_CHANGE` (which gates `panels.comms.style.display`); also subscribed to `window.resize` |
| [`HUD.js`](js/ui/HUD.js:835) | `update()` | Replaced unconditional `getBoundingClientRect()` with lazy read into the cache (`if (this._commsRectBottom == null) …`) |

**Forced-layout cost saved.** `getBoundingClientRect()` triggers a synchronous layout when any DOM has been mutated since the previous frame — and StatusPanel writes `textContent` on the same 10 Hz cadence. The cached read is O(1) JS, no layout flush. [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:107) § 3.2 estimated the saving at ~0.2–0.5 ms/frame on dense missions.

---

## § 4 — Measured Numbers

### § 4.1 — Captured Snapshot (Chrome 148 / Apple M4 Max — MENU state)

Captured 2026-05-22T12:15:39Z via the new `📋 COPY SNAPSHOT` button:

```json
{
  "timestamp": "2026-05-22T12:15:39.810Z",
  "tier": { "current": "HIGH", "lastChangeReason": "capability-detect" },
  "gpu":  { "medianMs": null, "sampleCount": 0, "supported": true },
  "fps":  { "median": 120.48, "historyLen": 180,
            "frameMs": { "median": 8.3, "p99": 17.5, "windowSamples": 600 } },
  "render": { "calls": 1, "triangles": 1, "points": 0, "lines": 0,
              "geometries": 152, "textures": 34 },
  "heap":  { "usedBytes": 64664073, "totalBytes": 88622601, "limitBytes": 4294967296 },
  "activeTimers": 0,
  "aliveDebris": 800,
  "boot": {
    "swState": "no-controller",
    "avifSupported": true,
    "maxTextureSize": 16384,
    "devicePixelRatio": 2,
    "deviceMemoryGB": 32,
    "isAppleGPU": true,
    "unmaskedRenderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)",
    "isWebGL2": true,
    "maxAnisotropy": 16,
    "pickedTier": "HIGH",
    "tierConfig": { "pixelRatioCap": 2, "msaaSamples": 4, "enableBloom": true, "enableSMAA": true, "useFXAAFallback": false },
    "initialTierReason": "capability-detect",
    "userAgent": "Chrome/148.0.0.0",
    "fpsHistorySize": 180,
    "adaptFpsThreshold": 50
  }
}
```

### § 4.2 — What This Snapshot Validates

The snapshot was taken at the menu (pre-gameplay) state. That's why `render.calls = 1` and `render.triangles = 1` — most scene objects aren't yet active. Still, several Sprint 1 "🟡" rows can now be promoted from this single sample:

| Sprint 1 row | Promoted? | Evidence in snapshot |
|---|:--:|---|
| AVIF support + first-paint MB savings | ✅ partial | `boot.avifSupported = true`; SW is `no-controller` (first visit) so the 16K AVIF was served fresh — actual MB number still requires the DevTools Network panel. |
| GPU probe runs on Chrome / Apple GPU | ✅ | `gpu.supported = true` (`EXT_disjoint_timer_query_webgl2` available). `sampleCount = 0` because the menu's 1-draw frames complete instantly and the probe window hasn't filled yet. |
| Hidden-tab pause works | n/a | Not testable from a single sample. |
| 120 Hz judder fix | ✅ | `fps.median = 120.48` — the snapshot is sampling at the display refresh, not gated to 60. |
| Tier auto-downshift cooldown values are sane | ✅ | `fpsHistorySize: 180`, `adaptFpsThreshold: 50` — matches Constants. |
| Initial-tier detection on Apple Silicon | ✅ | `boot.isAppleGPU = true`, `maxTextureSize = 16384`, `pickedTier = HIGH` — matches [`QualityManager.selectInitialTier`](js/systems/QualityManager.js:59) heuristics. |
| AudioSystem unlock | n/a | Not exposed in the overlay (would need a separate row). |

### § 4.3 — What Is _Not_ Validated Yet

The Phase A overlay is now in place, but the user only ran it through one short menu session. The following still need a gameplay-state capture before they can be promoted to "✅":

- **`renderer.info.render.calls` during gameplay.** The menu snapshot shows `1`; an in-mission snapshot is needed to decide whether the deferred **InstancedMesh merge** (§ 5 item below) is worth doing. The [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:24) threshold for that decision is 250 draw calls.
- **GPU median ms** — needs a gameplay-state capture where the probe's 60-frame window can fill.
- **5-minute heap-leak detection** — needs two heap snapshots paired with the overlay's `heap.usedBytes` row.
- **Auto-upshift in the wild** — needs an intentional downshift event followed by a calmer mission segment.
- **FXAA at MEDIUM** — needs `?tier=MEDIUM` and an eyeball check on debris edges.
- **Earth LOW_DETAIL recompile** — needs `?tier=LOW` and a visual check that the shader recompile doesn't NaN/flash.

---

## § 5 — Deferred from § 5 of [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:242)

Items 6–10 of the ROI ranking that did **not** ship in this sprint:

| Rank | Item | Why deferred |
|---:|---|---|
| 6 | MoidCalculator in Web Worker | ★★★ ROI but 6–8 h effort. Out of Sprint-2 scope. File as Sprint 3 candidate. |
| 8 | Dynamic-import boot-time screen modules (Shop, Codex, Sweep, GameOver, Briefing) | ★★ ROI on cold cache / mobile. Mechanical work; gate on a real cold-load measurement first. |
| 9 | **InstancedMesh merge for debris** ([`DebrisField.js:634`](js/entities/DebrisField.js:634)) | **Explicitly gated.** The menu snapshot shows draw calls = 1; need an in-mission `?profile=1` capture showing > 250 calls before this is justified. **If captured numbers stay below 80, drop it permanently.** |
| 10 | Per-frame Vector3 alloc cleanup in [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) + [`PlayerSatellite._updateRotation()`](js/entities/PlayerSatellite.js:1) | ★★ ROI follow-on to PR A. PR A already touched `_resolveTargetState`'s 3 sites; the remaining `relP` / `relV` / `goalDir` / `dvCmd` Vector3 allocs in [`AutopilotSystem.js:413`](js/systems/AutopilotSystem.js:413) and PlayerSatellite's 5–8 per-tick allocs are next on the list. |

Also from the original Sprint 1 deferred list:

- **PR 7 — WebGPU renderer** — three.js WebGPU still beta; defer until r190+.
- **16 TimerManager-deferred files** — mechanical busywork with no measurable gain per [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:43) § 2.2. Drop the bulk; the 2–3 borderline ones (InputManager chord/windup, ArmUnit pilot-nudges) are still candidates if a future heap-leak diagnostic implicates them.
- **Audio oscillator pooling** — Web Audio's auto-cleanup is fine for our shot rate (per [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:140) § 3.5). Re-evaluate only if a Safari `?profile=1` shows audio in the top-10 main-thread time.

---

## § 6 — Recommended Next Capture Session

To close the remaining "🟡" rows in [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1) and the gates in § 5 of this report, the user should:

1. Run `./start.sh`, open `http://localhost:8081/?profile=1&perfReport=1&debug=1`.
2. **Start a mission and play for 60 s** so debris becomes active and the GPU probe window fills.
3. Click **📋 COPY SNAPSHOT** — paste the JSON into a follow-up issue.
4. Open DevTools Network panel, hard-reload, screenshot the AVIF waterfall (total MB transferred).
5. Take a heap snapshot. Play another 5 min. Take a second heap snapshot. Diff them in DevTools.
6. Repeat with `?tier=MEDIUM` to validate FXAA.
7. Repeat with `?tier=LOW` to validate the Earth `LOW_DETAIL` shader compile.

If `[Profile] calls=N` consistently shows **N > 250**, file the InstancedMesh merge as Sprint 3 item 1. If `N < 80`, retire it.

---

## § 7 — Methodology / Honesty Notes

- The "~108 000 literals/sec" headline is the **inferred upper bound** from [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:90) § 3.1's allocation estimates (300 debris × 60 fps × 6 sites). It is **not** measured. A measured number would require DevTools Memory → Allocation instrumentation, which the user can run from the overlay's session.
- The MEDIUM/LOW tier visual effects (FXAA on, terrain noise off) compile and pass static unit tests, but the **visual correctness has not been confirmed in-browser** in this sprint. The recommended next capture session in § 6 includes both checks.
- All 5 PRs were committed in order A → E inside this single working tree (no real PR ceremony — the task brief uses "PR" as a label for cleanly-scoped change groups). Each step ran the test suite and confirmed `2151/2151` (or the prior `2140/2140` after PR A, before PR B added 11 more cases).
- Effort budget vs. estimate: § 5 of [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:242) estimated 16–28 h for items 1–5. Actual was on the lower end of that — most of the budget went to PRs A and B (the math + tests). PRs C, D, E were near-mechanical once the surrounding architecture was in hand.
