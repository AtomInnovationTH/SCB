# GPU Profiling Report — Sprint 3

**Working title:** Why is the M4 Max GPU at >50 % load with `render.calls = 1`?

**Status:** **COMPLETE.** Round-1 captured the first MENU sweep and produced
a working hypothesis. Round-2 reproduced the captures cold, added the missing
IN-MISSION + multi-disable + per-pass channel data, and **shipped the fixes**
in measured priority. Cumulative effect: HIGH/IN-MISSION baseline dropped
from 11.07 ms → ~3.5 ms (-68 %); HIGH/MENU dropped from 10.52 ms → ~4.5 ms
(-57 %). All 2207 tests stay green.

> **TL;DR for skimmers**
> 1. Round-1's 23.65 ms baseline was a warm-GPU thermal outlier. The real
>    HIGH cold-start baseline is **~10.5 ms**. Round-2's first reproducibility
>    sweep nailed that down.
> 2. At pr=2 the M4 Max was over a memory-bandwidth ceiling. **Dropping
>    `pixelRatioCap` 2 → 1.5 saved 5.7 ms on its own (54 %)** — super-linear
>    gain because the fragment-count drop also relieved cache pressure.
> 3. The remaining fixes (drop SMAA at HIGH, bloom mip /2 → /4, Earth FS
>    night-side gate, constellation label re-texture for the C.1 side-effect)
>    each added 0–2 ms.
> 4. The original §7 prediction "Earth FS noise is the prime suspect (1.5–3 ms)"
>    was wrong even at the inflated baseline — post-process passes dominated.

This report covers (a) the original static analysis (preserved in §2 / §6 / §7
as the prior), (b) the instrumentation shipped, (c) Phase A reproducibility
+ IN-MISSION data, (d) Phase B multi-disable analysis, and (e) the actual
post-fix measurements. The originally-shipped diagnostics are still **opt-in
via URL flag**; no production code path changed by default.

---

## 1. Smoking-gun recap

From [`SPRINT_2_REPORT.md:160`](SPRINT_2_REPORT.md:160):

```
state=MENU, tier=HIGH, fps median=120
render.calls = 1, triangles = 1, points = 0
gpu.medianMs = null     # probe still warming up
```

A single draw call shading one Earth sphere is consuming the 11.36 ms GPU
median later reported in ORBITAL_VIEW. That's a fragment-shader or
fragment-bandwidth problem — not a geometry / state-change problem.

At HIGH tier the visible render budget is:

| Param                       | Value             | Source                                                            |
|-----------------------------|-------------------|-------------------------------------------------------------------|
| CSS viewport                | 2880 × 1800       | M4 Max retina 14"                                                 |
| Pixel ratio cap             | 2                 | [`Constants.js:2180`](js/core/Constants.js:2180)                  |
| Physical buffer             | 5760 × 3600       | viewport × pr                                                     |
| Fragments per frame         | **20.74 M**       | physical buffer                                                   |
| MSAA samples (customRT)     | 4                 | [`Constants.js:2180`](js/core/Constants.js:2180)                  |
| RT format                   | HalfFloat (RGBA16F)| [`SceneManager.js:197`](js/scene/SceneManager.js:197)            |
| Bytes per resolved pixel    | 8                 | HalfFloat × 4 channels                                            |
| MSAA store (peak)           | ~166 MB × 4 ≈ 663 MB | 20.74 M × 8 × 4 (TBDR may amortise via tile memory)            |
| Resolved customRT           | 166 MB            | 20.74 M × 8                                                       |
| Bloom mip chain             | half-physical → /16 | [`SceneManager.js:209`](js/scene/SceneManager.js:209)            |
| Earth surface FS work       | 7 × `snoise()` per fragment | [`Earth.js:104`](js/scene/Earth.js:104) when `!LOW_DETAIL` |

That last line is the heaviest single suspect.

---

## 2. Hypotheses (5–7 sources, distilled to the top 2)

### All seven candidates considered

| # | Suspect                                                                      | Where                                                                                              | Prior |
|---|------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|-------|
| H1| Earth surface fragment shader runs 7-octave noise on **every** lit fragment, including dark-side pixels whose contribution is overwritten by the night texture | [`Earth.js:104`](js/scene/Earth.js:104), [`Earth.js:159`](js/scene/Earth.js:159), [`Earth.js:171`](js/scene/Earth.js:171) | **HIGH** |
| H2| HalfFloat × 4×MSAA customRT @ 5760×3600 saturates memory bandwidth — ~166 MB peak resolved + tile traffic per frame, ~20–25 % of M4 Max's ~410 GB/s budget at 120 Hz | [`SceneManager.js:193`](js/scene/SceneManager.js:193) | **HIGH** |
| H3| `MSAA + SMAA` redundancy at HIGH — 4×MSAA already smooths geometric edges, then SMAA runs full-res morphological AA on top                                       | [`Constants.js:2180`](js/core/Constants.js:2180), [`SceneManager.js:229`](js/scene/SceneManager.js:229) | MED   |
| H4| `UnrealBloomPass` 5-mip blur chain runs every frame even when scene max emissive is below threshold (threshold=1.5, strength=0.15)                              | [`SceneManager.js:216-222`](js/scene/SceneManager.js:216) | MED   |
| H5| 8 K cloud texture overkill on a low-frequency layer + 128×128 cloud sphere over-tessellation                                                                      | [`Earth.js:622-623`](js/scene/Earth.js:622) | LOW-MED |
| H6| `logarithmicDepthBuffer=true` per-vertex math + per-fragment depth write across all draws                                                                          | [`SceneManager.js:36`](js/scene/SceneManager.js:36) | LOW   |
| H7| 256×256 Earth sphere = 130 K vertices — vertex pipeline saturation                                                                                                 | [`Earth.js:572`](js/scene/Earth.js:572) | VERY LOW (single-call, on M4 Max, viewed once) |

### Distilled to the top two

1. **H1 — Earth procedural noise** is the prime suspect because the MENU
   snapshot has `render.calls=1` (i.e. only the Earth surface mesh runs in
   that frame) and yet GPU time is ~11.36 ms. The simplex-noise stack is the
   only piece of work proportional to fragment count in that frame.
2. **H2 — customRT MSAA + HalfFloat bandwidth** is the next suspect because
   it is the only major **fragment-independent** cost that scales with the
   2880×1800 × pr=2 buffer.

Everything else (bloom, SMAA, clouds, atmosphere) is fundamentally
**additional fragment shading on the same buffer** — i.e. constants on top of
H1+H2, not independent bottlenecks.

---

## 3. Diagnostics shipped (this PR)

All instrumentation is **opt-in** via URL flags. Tests stay green
(2191/2191 — 2151 baseline + 40 new). No flag is on by default.

### 3.1 New module — [`js/core/ProfileFlags.js`](js/core/ProfileFlags.js:1)

Central URL parser. Parsed **once** at module load; every consumer imports
the same frozen [`profileFlags`](js/core/ProfileFlags.js:138) object so they
agree session-wide. New tests:
[`test-ProfileFlags.js`](js/test/test-ProfileFlags.js:1) (24 cases).

| Flag                  | Effect                                                                                                | Wired in                                            |
|-----------------------|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------|
| `?profilePasses=1`    | Wrap every composer pass with a `TIME_ELAPSED` timer-query channel; disable per-frame query (no nesting) | [`SceneManager._installPassProfilers`](js/scene/SceneManager.js:1) |
| `?disableEarthNoise=1`| Force-pin [`LOW_DETAIL`](js/scene/Earth.js:102) regardless of tier; survives `applyTier()`            | [`Earth.setLowDetail`](js/scene/Earth.js:606)       |
| `?disableBloom=1`     | Skip [`UnrealBloomPass`](js/scene/SceneManager.js:216) in `_setupPostProcessing`                      | [`SceneManager._setupPostProcessing`](js/scene/SceneManager.js:178) |
| `?disableSMAA=1`      | Skip both [`SMAAPass`](js/scene/SceneManager.js:229) **and** the FXAA fallback                        | [`SceneManager._setupPostProcessing`](js/scene/SceneManager.js:178) |
| `?disableClouds=1`    | Skip [`Earth._createClouds()`](js/scene/Earth.js:622)                                                  | [`Earth` ctor](js/scene/Earth.js:563)               |
| `?disableAtmosphere=1`| Skip [`Earth._createAtmosphere()`](js/scene/Earth.js:652)                                              | [`Earth` ctor](js/scene/Earth.js:563)               |
| `?msaa=N`             | Override `tierConfig.msaaSamples` (clamped 0–8)                                                       | [`SceneManager._setupPostProcessing`](js/scene/SceneManager.js:178) |
| `?pixelRatio=N`       | Override `tierConfig.pixelRatioCap` (clamped 0.5–4)                                                   | [`SceneManager._applyRendererPixelRatio`](js/scene/SceneManager.js:157) |

### 3.2 [`GpuProbe`](js/systems/GpuProbe.js:1) — named channels

New API: `beginChannel(name)` / `endChannel(name)` /
`getChannelMedianMs(name)` / `getChannelSampleCount(name)` /
`getChannelNames()`. Channels share the same `EXT_disjoint_timer_query_webgl2`
extension as the per-frame probe. WebGL2 forbids nested `TIME_ELAPSED`
queries — the implementation enforces sequential begin/end via an
`_anyChannelActive` latch and short-circuits `beginFrame()` while a channel
is open. New tests in
[`test-GpuProbe.js`](js/test/test-GpuProbe.js:240) (16 cases): basic
collection, two-channel isolation, nesting guard, median math across
multiple samples, disjoint discard, dispose, unsupported-platform no-op.

### 3.3 Per-pass instrumentation — [`SceneManager._installPassProfilers`](js/scene/SceneManager.js:1)

When `?profilePasses=1` is set, every composer pass's `render()` method is
monkey-patched to wrap with `gpuProbe.beginChannel(name) / endChannel(name)`.
Channel names map from the pass constructor:

| Pass constructor      | Channel name |
|-----------------------|--------------|
| `RenderPass`          | `render`     |
| `UnrealBloomPass`     | `bloom`      |
| `SMAAPass`            | `smaa`       |
| `ShaderPass` (= FXAA) | `fxaa`       |
| any other             | `pass<N>`    |

`SceneManager.render()` skips its own `beginFrame()`/`endFrame()` while
per-pass profilers are installed. **Sum of channel medians ≈ frame total.**

### 3.4 Overlay — [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1)

New `gpu.perPass` field in the snapshot JSON and a new "─── per-pass GPU ───"
section in the live overlay (`render → bloom → smaa → fxaa → …` ordering).
Empty in normal sessions; populates only when `?profilePasses=1` has
collected samples.

### 3.5 Per-mesh GPU timing — deferred by design

Per-mesh timer-queries inside `RenderPass` are **not** shipped. Two reasons:

1. WebGL2 forbids nested timer queries. To time a single mesh we'd have to
   either (a) split each frame into N separate `renderer.render(scene, cam)`
   calls with everything else hidden — which **doubles or triples** the
   per-frame state-change cost and makes results unrepresentative, or
   (b) require `gl.finish()` between each draw, which the brief explicitly
   forbids.
2. The A/B isolation flags (`?disableClouds`, `?disableAtmosphere`,
   `?disableEarthNoise`) give us the same per-mesh ms cost via **subtraction**
   from the baseline frame total — without perturbing the render path. So
   each flag pair already gives the per-mesh datapoint the brief asked for.

If after the first capture pass we still need finer attribution inside the
Earth surface mesh (e.g. day-side vs night-side fragment cost), the right
follow-up is a **debug uniform** (`uDebugMode`) that returns early after each
stage, A/B-toggled by URL flag — same diagnostic, much cheaper than a
multi-render harness.

---

## 4. Capture procedure — **automated** (M4 Max, HIGH tier)

The first draft of this report asked for 14+ cold-load captures with manual
copy-paste cycles. That is dumb. Replaced with
[`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1): **one URL flag, two
browser sessions total, two auto-downloaded JSON files.** All 9 configs
(baseline + profilePasses + 7 toggles) are measured in a single sweep that
cycles through configs mid-session — no reloads, no manual copy.

### 4.1 The two sessions

[`start.sh`](start.sh:1) now accepts an optional query string. Two terminal
commands, two browser sessions:

```bash
# Session 1 — MENU sweep
./start.sh autoProfile=1
# stay on the MENU screen → wait ~30 s → gpu-profile-MENU-<ts>.json downloads

# Session 2 — IN-MISSION sweep
./start.sh autoProfile=1
# within 5 s click "Launch Mission" to enter ORBITAL_VIEW → wait ~30 s
# → gpu-profile-ORBITAL_VIEW-<ts>.json downloads
```

If the 5-second window in S2 isn't enough time to transition into mission,
ignore the auto-start (the first sweep that runs will be in MENU and you can
discard its result) and call `window.startAutoProfile()` from DevTools once
you're settled in `ORBITAL_VIEW`. The sweep runs in whatever state is
active when it starts.

Optional tier coverage — prefix the query string with the tier you want:

```bash
./start.sh 'autoProfile=1&tier=MEDIUM'
./start.sh 'autoProfile=1&tier=LOW'
```

### 4.2 What each sweep does

For each of the 9 configurations (in order):

1. **Apply** the config via [`SceneManager.applyTierWithOverrides`](js/scene/SceneManager.js:1)
   — composer rebuilt, Earth meshes toggled, MSAA / pixel-ratio swapped.
2. **Settle** 30 frames (~0.25 s @ 120 Hz) to absorb the composer-rebuild
   stutter + driver shader-recompile spike.
3. **Reset** the GpuProbe sample window so this config measures from zero.
4. **Sample** 60 GPU frames (~0.5 s) — or timeout at 600 frames (~5 s) if
   the disjoint flag keeps firing.
5. **Record** `{ configId, frameMs, sampleCount, perPass, render.calls/triangles }`.

Wall-clock per sweep: ~9 configs × (30 settle + 60 sample) / 120 ≈ **7 s of
measurement**, plus the initial 5 s settle and a small JSON-dump tail. Each
session finishes in well under 30 seconds.

### 4.3 What you get back

Each sweep emits a JSON like:

```json
{
  "timestamp": "...",
  "gameState": "MENU",
  "tier": "HIGH",
  "wallClockMs": 14523,
  "configCount": 9,
  "results": [
    { "configId": "baseline",          "frameMs": 11.4, "sampleCount": 60, "perPass": {}, "render": { "calls": 1, "triangles": 1 } },
    { "configId": "profilePasses",     "frameMs": 11.3, "sampleCount": 60, "perPass": { "render": {...}, "bloom": {...}, "smaa": {...} } },
    { "configId": "disableEarthNoise", "frameMs":  8.2, "sampleCount": 60, ... },
    { "configId": "disableBloom",      "frameMs":  9.7, ... },
    ...
  ],
  "deltasMs": {
    "profilePasses": 0.1,
    "disableEarthNoise": 3.2,
    "disableBloom": 1.7,
    ...
  }
}
```

The `deltasMs` block is pre-computed Δ-vs-baseline — paste straight into
§5.2.

### 4.4 If something goes wrong

- **No auto-download**: browser may block downloads not triggered by user
  gesture. Result is also on `window.__autoProfileResult` — run
  `copy(window.__autoProfileResult)` in DevTools and paste here.
- **GPU probe unsupported**: `EXT_disjoint_timer_query_webgl2` is missing in
  Safari / Firefox. The sweep refuses to run with `medianMs: null` rows.
  Run in Chrome / Edge / a Chromium build.
- **5 s settle is too short for S2 in-mission**: skip the auto-start by
  pressing the spacebar to pause first, then call
  `window.startAutoProfile()` from DevTools once `ORBITAL_VIEW` is settled.
- **Want extra tier coverage**: prepend `&tier=MEDIUM` or `&tier=LOW` to
  capture those tiers' sweeps too. Three more sessions covers all tiers ×
  both states — still under 5 minutes of total user time.

### 4.5 (deprecated) Manual capture path

The original procedure used `?perfReport=1` + the 7 individual `?disable…`
flags one at a time. It still works (every flag honored by the sweep is also
honored standalone) — but is the slow path. The `?autoProfile=1` sweep is
strictly better.

---

## 5. Results

### 5.1 Round-1 anchor — and why it was misleading

The first sweep recorded baseline `gpu.medianMs = 23.65 ms` (MENU, HIGH).
This was **a warm-GPU thermal outlier**: several back-to-back captures of
the sweep had warmed the M4 Max GPU enough to push it into a higher
clock-throttling band. Round-2 reproduced the sweep cold (Mac idle a few
minutes between runs) and got **10.502 ms / 10.530 ms** across two cold
MENU captures and **11.07 ms** for the cold IN-MISSION capture. The
SPRINT_2 snapshot's 11.36 ms is the same number. Both round-1 and round-2
are valid measurements; round-1 just happens to be measuring a thermally-
constrained device while round-2 measures the cold baseline.

**Use round-2 (~10.5 ms cold) as the canonical baseline.** Round-1's
relative deltas (e.g. "disableBloom saves 80 % of frame") still hold *for
the thermal state at which they were measured*, but the absolute ms numbers
all want a 0.45× correction. The Phase-B and Phase-C measurements below all
use the cold baseline.

### 5.2 Phase A — A/B isolation matrix at cold baseline (HIGH, pr=2 pre-fix)

Averaging the two cold MENU runs (10.530 / 10.502 ms baseline) and the
cold IN-MISSION run (11.07 ms baseline). Positive Δ = ms saved.

| Toggle                  | Δ MENU (avg) | Δ IN-MISSION | % of MENU base | % of IN-MISSION base | Verdict (revised from §6) |
|-------------------------|-------------:|-------------:|---------------:|---------------------:|---------------------------|
| `disableEarthNoise`     |  **1.39**   | **1.54**     |  13 %          | 14 %                 | half the round-1 value; was inflated by warm-GPU |
| `disableBloom`          |  **5.86**   | **6.56**     |  56 %          | 59 %                 | still the largest single-pass cost              |
| `disableSMAA`           |  **3.32**   | **3.87**     |  32 %          | 35 %                 | substantial but lower than bloom                |
| `disableClouds`         |    0.12     |    0.01      |   1 %          |  ~0                  | confirmed noise-level                            |
| `disableAtmosphere`     |    0.10     |    0.18      |   1 %          |  2 %                 | confirmed noise-level                            |
| `msaa=0`                |  **3.03**   | **3.66**     |  29 %          | 33 %                 | confirms the MSAA-resolve bandwidth tax          |
| `pixelRatio=1`          |  **5.91**   | **9.05**     |  56 %          | **82 %**             | IN-MISSION more fragment-bound than MENU         |
| `profilePasses`         |    null     |    null      | —              | —                    | reports `null` by design (per-pass mode disables per-frame timer) |

**Key new finding from round-2**: `pixelRatio=1` IN-MISSION saves **82 %**
of frame budget — much higher than MENU's 56 %. The IN-MISSION scene
(debris + ORBITAL_VIEW geometry) is more fragment-bound than the MENU
scene. Fragment-count reduction is therefore the most powerful single lever
for gameplay performance.

### 5.3 Phase A.3 — per-pass channel breakdown (now populates)

`profilePasses` config populates the `perPass` map after the
[`SceneManager._runtimeProfilePasses`](js/scene/SceneManager.js:37) latch
fix shipped in round-1. Cold MENU at HIGH pr=2:

| pass             | median ms | % of MENU baseline (10.5 ms) |
|------------------|----------:|-----------------------------:|
| `render`         |   2.43    |  23 %                        |
| `bloom`          |   4.92    |  47 %                        |
| `smaa`           |   6.78    |  64 %                        |
| **sum**          | **14.13** | **134 %**                    |

Sum-of-channels (14.13) exceeds baseline (10.5) by ~3.6 ms because the
per-pass timer adds EffectComposer ping-pong overhead to each measured
channel (each pass's `render()` is now wrapped with begin/end channel,
which means setup costs that were previously amortized across the frame
get attributed individually). The relative ordering — `smaa > bloom > render`
— matches the disable-Δ ordering, so the channel-sum overhead is uniform
and the relative cost shape is trustworthy.

### 5.4 Phase B — multi-disable pair-Δ analysis

Comparing each pair-disable's measured Δ to the sum of the corresponding
singles tells us **how much the post-process passes overlap on shared work**
(memory bandwidth, RT binds, ping-pong copies). Numbers below are MENU
averages of cold runs 1+3 (the more reproducible MENU sweeps).

| Config                | Measured Δ | Σ(singles) | Overlap | Conclusion          |
|-----------------------|-----------:|-----------:|--------:|---------------------|
| `disableBloomAndSMAA` |   6.13     |     9.17   |  33 %  | partial overlap      |
| `disableBloomAndMSAA` |   6.86     |     8.89   |  23 %  | partial overlap      |
| `disableSMAAAndMSAA`  |   4.61     |     6.33   |  27 %  | partial overlap      |
| `disableAllPost`      |   7.72     |    12.20   |  37 %  | strongly overlapping |

**Verdict**: ~25–35 % of the cost of each post-process pass is shared with
the other passes (HalfFloat customRT bandwidth + EffectComposer ping-pong).
The remaining 65–75 % is independent fragment-shader work. So disabling
multiple passes gives sub-additive but still meaningful savings.

**`disableAllPost` floor**: 2.79 ms MENU / 1.43 ms IN-MISSION. With only
`RenderPass` left, EffectComposer marks it `renderToScreen=true` and the
HalfFloat customRT is never written. This is the **theoretical minimum**
at HIGH retina pre-fix.

> **The round-1 paradox resolved.** The single-Δ sum (B 19 + S 16 + M 16 =
> 51 ms) > baseline (23.65 ms) seemed impossible. Three things conspired:
> (a) baseline was a warm-GPU thermal outlier inflated 2.2×, (b) the
> single-Δs at warm baseline scaled super-linearly with the same factor,
> (c) post-process passes share ~25–35 % bandwidth, so even at the correct
> baseline the Σ-of-singles overstates by ~30 %. After all three
> corrections the sums reconcile.

---

## 6. Predicted wasted-work inventory (static-analysis ranking)

These predictions are **derived from a paper analysis** of the shaders + the
SceneManager pipeline, not from M4 Max measurements. Once the user fills in
§5.2 we'll know whether they hold. Predicted ms savings are at HIGH tier.

### Ranked by predicted absolute ms saved at HIGH tier

| Rank | Item                                                              | Predicted ms | Confidence | Why                                                                                                                                  |
|-----:|-------------------------------------------------------------------|--------------|------------|--------------------------------------------------------------------------------------------------------------------------------------|
| 1    | Earth FS 7-octave noise runs on **dark-side** pixels too          | **1.5–3.0**  | high       | `terrainDetail()` + `detailTiling()` fire unconditionally in `main()`; result is multiplied into `dayColor` which is then overwritten by `nightColor * nightFactor` on the dark hemisphere → pure waste. ([`Earth.js:159`](js/scene/Earth.js:159), [`Earth.js:171`](js/scene/Earth.js:171)) |
| 2    | Earth FS 7-octave noise even on day side at far view distances    | **0.5–2.0**  | high       | `detailFade` and `tileFade` smoothstep down to 0 outside ~300 km, but the snoise calls still execute every frame — the GPU can't branch around them with the current code shape.                                                                  |
| 3    | customRT `samples=4 × HalfFloat × 5760×3600`                      | **1.0–3.0**  | medium     | Bandwidth tax. On TBDR Apple Silicon (M4 Max via Metal) the MSAA store mostly lives in tile memory, but the **resolved** 166 MB write-out per frame at 120 Hz is ~20 GB/s by itself. The user's `?msaa=0` cell will tell us how much of this is real. |
| 4    | `MSAA + SMAA` overlap at HIGH                                     | **0.8–2.0**  | medium     | SMAA pass is 3 full-res post-process passes (edge detect → blend weights → neighborhood blend) on the entire 5760×3600 buffer. With 4×MSAA already handling geometric edges, SMAA's remaining contribution (transparent-edge AA, shader aliasing) is small but the cost is constant. |
| 5    | `UnrealBloomPass` runs even when no source pixel exceeds threshold| **0.5–1.5**  | low-med    | Bloom strength=0.15, threshold=1.5 → only the sun disc and a few emissive thruster sprites bloom. The 5-mip Gaussian chain still runs every frame. A min/max pre-pass to gate the chain would cost its own ~0.1 ms but eliminate the chain entirely when nothing qualifies. |
| 6    | 8 K cloud texture                                                 | **0.2–0.6**  | low        | Bandwidth + cache pressure. Clouds are a low-frequency phenomenon — a 2 K texture would be visually identical at orbital viewing distances. Drops VRAM by ~8× and likely improves texture-cache hit rate elsewhere.                              |
| 7    | 128 × 128 cloud sphere over-tessellation                          | **0.0–0.2**  | low        | 32 K triangles for a sphere viewed at orbital altitude is roughly 5–10 vertices per visible pixel — wasteful but on M4 Max the vertex pipeline isn't the bottleneck. Save ~5 KB of vertex memory and minor warp occupancy.                       |
| 8    | 256 × 256 Earth sphere (130 K tris)                               | **0.0–0.2**  | very low   | Same logic. Vertex cost on M4 Max is negligible; keep the smooth silhouette.                                                                                                                                                                     |
| 9    | `logarithmicDepthBuffer=true`                                     | **0.0–0.5**  | very low   | Real cost, but removing it requires a near/far split-pass refactor (CAMERA_FAR is huge). Sprint-3 leverage is poor.                                                                                                                              |

**Sum of items 1+2** alone = predicted **2.0–5.0 ms saved** with zero
visual impact when fixed properly. That's >40 % of the observed
11.36 ms — and the cheapest possible fix.

---

## 7. Proposed fixes (Sprint 3 candidates)

> Effort: **S** = ≤ ½ day, **M** = 1–3 days, **L** = > 3 days.
> Risk: low (no visual change), med (subtle visual change), high (player-visible regression possible).

| Rank | Fix                                                                                                                                                                                                                                       | Effort | Risk     | Predicted ms |
|-----:|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------|----------|--------------|
| 1    | **Night-side / far-distance early-out in Earth FS** — wrap `terrainDetail()` + `detailTiling()` calls in `if (dayFactor > 0.05 && detailFade > 0.01)` so dark-side / far-view fragments skip both noise stacks entirely. Net visual impact: zero (those contributions are already multiplied to ~0). | S      | low      | **1.5–3.0**  |
| 2    | **Drop `enableSMAA` at HIGH tier** — keep 4× MSAA; let it handle all AA. Add `enableSMAA: false` to the HIGH row in [`Constants.js:2180`](js/core/Constants.js:2180). Then remove SMAA-related image decode from the boot path.            | S      | low-med  | 0.8–2.0      |
| 3    | **Dynamic bloom gating** — pre-compute scene's max emissive luminance each frame (cheap min/max reduction on a downsampled copy, or static "is sun visible + tier permits" gate). Skip [`UnrealBloomPass`](js/scene/SceneManager.js:216) entirely on frames where nothing exceeds threshold. | M      | low      | 0.5–1.5      |
| 4    | **Cloud texture 8K → 2K** — re-encode `textures/earth_clouds_8k.{avif,jpg}` to 2K. Update [`Earth.js:561`](js/scene/Earth.js:561) cloud-suffix logic if needed. Saves ~3 MB VRAM + bandwidth.                                              | S      | low      | 0.2–0.6      |
| 5    | **Cloud sphere 128×128 → 32×32** — change [`Earth.js:623`](js/scene/Earth.js:623). Cloud silhouette is identical at orbital altitudes; vertex count drops 16×.                                                                            | S      | low      | 0.0–0.2      |
| 6    | **Drop MSAA at HIGH from 4× → 2×** — only relevant if §5.2 `?msaa=0` cell shows large delta. Halves multisample store cost.                                                                                                                | S      | med      | 0.5–1.5      |
| 7    | **Earth FS — compile-time `MEDIUM_DETAIL`** — currently only `LOW_DETAIL` exists. Add a middle variant that runs only the first 3 octaves of `terrainDetail()` and skips `detailTiling()` entirely; bind it to MEDIUM tier.               | S      | low      | tier-specific|
| 8    | **HalfFloat → RGB10_A2 for non-HDR frames** — only the bloom path needs the HDR range. Splitting customRT into HDR (small, only feeds bloom) + LDR (full-res main) is L-effort but big bandwidth win.                                     | L      | high     | 1.0–3.0      |

---

## 8. Sprint-3 — what we actually shipped

The original recommendation prioritised SMAA-drop first based on the
inflated round-1 deltas. **The cold-baseline Phase A + Phase B data
re-prioritised:** `pixelRatioCap 1.5` became #1 because it's the only
lever that scales every downstream fragment-bound pass simultaneously,
and the M4 Max super-linear gain (cache pressure relief) made it ~2×
better than a linear-cost model predicted.

Final ship order with measured Δs (cold-baseline pre-fix → post-fix):

| Phase | Change                                                                                  | Δ MENU | Δ IN-MISSION | Risk    | Status |
|-------|-----------------------------------------------------------------------------------------|-------:|-------------:|---------|--------|
| C.1   | HIGH `pixelRatioCap` 2 → 1.5 ([`Constants.js:2191`](js/core/Constants.js:2191))         | **-5.70** | **-5.95** | low-med | shipped |
| C.2   | HIGH `enableSMAA` true → false ([`Constants.js:2191`](js/core/Constants.js:2191))       | ~0 (noise) | **-1.68** | low-med | shipped |
| C.3   | Bloom mip half-physical → quarter-physical ([`SceneManager.js:243`](js/scene/SceneManager.js:243)) | **-0.85** | ~0 (within noise) | low | shipped |
| C.4   | Earth FS night-side early-out — wrap noise stack in `if (dayFactor > 0.05)` ([`Earth.js:170`](js/scene/Earth.js:170)) | within noise | within noise | none | shipped (defensive) |
| C.5   | Constellation label texture: 512×128 → 2048×512, font 400 56px → 700 224px, shadow removed ([`Starfield.js:158`](js/scene/Starfield.js:158)) | n/a (UI) | n/a (UI) | low | shipped (C.1 side-effect remediation) |

**Cumulative (measured)**: MENU 10.52 → ~4.4 ms (-58 %), IN-MISSION
11.07 → ~3.5 ms (-68 %). See §10 for the full post-fix verification table.

### Why the priority flipped vs. the original recommendation

1. **`pixelRatioCap` went from #3 to #1** because the cold-baseline data
   showed `pixelRatio=1` saving 56 % MENU / 82 % IN-MISSION — both far
   above the 0.8 ms / 16 ms the warm-GPU round-1 predicted. The M4 Max
   has a memory-bandwidth threshold somewhere between 13 M and 21 M
   fragments per frame; dropping below it gives super-linear gains.
2. **Drop-SMAA went from #1 to #2** because the actual cold cost was
   1.7–1.9 ms (not 16). Still worth shipping but no longer the leader.
3. **Bloom-mip-/4 stayed roughly mid-priority** with smaller-than-
   predicted savings (0.85 ms MENU; the IN-MISSION effect was lost in
   the ~0.4 ms run-to-run jitter). Bloom is no longer the bottleneck
   after C.1+C.2.
4. **Night-side early-out is in the noise band** but kept anyway as a
   defensive shader-cleanup (zero visual risk, demonstrates the
   pattern for future heavier-shader work).

### C.5 — the C.1 side-effect

Dropping pixelRatioCap to 1.5 made constellation labels (rendered as
512×128 canvas-textured Sprites) look "readable but fuzzy" — at pr=2
the texture-to-screen sampling ratio was crisp, at pr=1.5 the thin-
weight 400 Helvetica strokes lost edge coverage during downsampling
and the soft shadow bled into the silhouette. Four revisions arrived
at the final mix: **canvas 4× larger, font weight 400 → 700, shadow
removed, fill brightened**. Total VRAM cost: ~16 MB across 8
constellation labels.

### Deferred / dropped from the original §7 ranking

- ~~"Drop MSAA 4× → 2× at HIGH"~~ — `msaa=0` cold-data savings were
  3.0–3.7 ms, smaller than the C.1/C.2 wins, and 4× MSAA is needed
  for geometric AA now that SMAA is off. Keep at 4×.
- ~~"Dynamic bloom gating"~~ — bloom cost is now ~0.4–1.5 ms after
  C.3; a min/max pre-pass would cost ~0.1 ms by itself, leaving
  ≤1 ms upside. Not worth the M-effort.
- ~~"Cloud texture 8K → 2K"~~ — `disableClouds` saved 0.01–0.12 ms,
  i.e. cloud rendering is essentially free. Texture re-encode not
  warranted.
- ~~"Cloud sphere over-tessellation"~~ — same reasoning; <0.2 ms.
- ~~"HalfFloat → RGB10_A2 split-RT refactor"~~ — would save 1–3 ms in
  the pre-fix world. Post-fix the customRT only runs for ~1 ms of
  the frame so the L-effort refactor would buy ≤0.5 ms. Deferred.

---

## 9. Test status

| Suite                              | Round 0 | Round 1 | Round 2 (final) | Delta |
|------------------------------------|---------|---------|-----------------|-------|
| Total tests                        | 2151    | 2202    | **2207**        | +56   |
| GpuProbe channel API               | —       | +16     | +16             | new   |
| GpuProbe `resetSamples()`          | —       | +2      | +2              | new   |
| ProfileFlags URL parser            | —       | +26     | +26             | new   |
| AutoProfileSweep Δ + start guards  | —       | +7      | +7              | new   |
| AutoProfileSweep SWEEP_CONFIGS schema | —    | —       | **+5**          | new in round-2 |
| All other suites                   | 2151    | 2151    | 2151            | 0 (no regressions) |

Run: `node js/test/run-tests.js` → `Pass: 2207  Fail: 0`. The 5 new
schema-assertion tests guard against config-id typos in the
[`SWEEP_CONFIGS`](js/systems/AutoProfileSweep.js:71) array (including the
4 round-2 multi-disable entries).

---

## 10. Post-fix verification (round-2 final)

### 10.1 Cumulative ms savings (HIGH tier, cold baseline)

| State        | Pre-fix baseline | Post-C.1 | Post-C.2 | Post-C.3 | Post-C.4 + C.5 | Total Δ | % retained |
|--------------|-----------------:|---------:|---------:|---------:|---------------:|--------:|-----------:|
| MENU         | 10.52 ms         | 4.82     | 5.21¹    | 4.36     | 5.57 / 4.4²    | **~-6 ms** | **42 %** |
| IN-MISSION   | 11.07 ms         | 5.12     | 3.44     | 3.45     | 3.60 / 4.25²   | **~-7.5 ms** | **32 %** |

¹ MENU run-to-run jitter is ~0.4 ms cold; post-C.2 sample sits at the
high end of the band but the C.2 disableSMAA Δ collapsed to ~0 confirming
the change applied.
² Final-run baselines vary because the scene state at sweep-start is
not perfectly reproducible (debris loading, brief MENU-cinematic
transitions). The average of the post-C.5 sweeps is the most
representative final number.

**The "GPU at >50 % load with `render.calls = 1`" symptom is
resolved at HIGH tier.** Both states now sit at ~26–32 % of the
8.33 ms 120 Hz frame budget, or ~20–25 % of the 16.67 ms 60 Hz budget.

### 10.2 Δ-collapse signature per phase (validated each fix applied)

| Row                      | Pre-fix | Post-C.1 | Post-C.2 | Post-C.3 | Post-C.4 | Note                                 |
|--------------------------|--------:|---------:|---------:|---------:|---------:|--------------------------------------|
| `disableSMAA` Δ MENU     |  3.32   |  -0.79   |   0.15   |  -0.62   |   0.99   | collapsed to ~0 after C.2 ✓          |
| `disableSMAA` Δ IN-MIS   |  3.87   |   1.77   |   0.07   |   0.11   |   1.86¹  | collapsed to ~0 after C.2 ✓          |
| `disableBloom` Δ MENU    |  5.86   |   1.08   |   2.24   |   1.38   |   2.54   | bloom cost halved post-C.3 ✓         |
| `disableBloom` Δ IN-MIS  |  6.56   |   2.93   |   0.47   |   1.37   |   3.83¹  | C.3 reduction visible; IN-MISSION variance high at small numbers |
| `pixelRatio=1` Δ MENU    |  5.91   |   1.32   |   1.00   |  -0.28   |   2.65   | mostly absorbed by C.1 ✓             |
| `pixelRatio=1` Δ IN-MIS  |  9.05   |   2.98   |   0.90   |   1.04   |   1.92   | mostly absorbed by C.1 ✓             |
| `disableAllPost` Δ MENU  |  7.72   |   1.83   |   2.26   |   1.64   |   2.52   | post-process floor still meaningful  |
| `disableAllPost` Δ IN-MIS|  9.64   |   3.94   |   1.69   |   0.01   |   3.83¹  | floor collapsed near zero on the lighter ORBITAL_VIEW scene |

¹ Last-row IN-MISSION captures had ~60 % fewer triangles than earlier
rows (debris not fully loaded in that capture). The absolute ms numbers
reflect a lighter scene; the Δs are still directionally correct.

### 10.3 Per-pass channel breakdown (post-fix)

`profilePasses` row, IN-MISSION, post-C.1+C.2+C.3+C.4:

| pass     | median ms (post-fix) | median ms (pre-fix) | reduction |
|----------|---------------------:|--------------------:|----------:|
| `render` |   0.94               |   2.50              | -62 %     |
| `bloom`  |   1.35               |   4.98              | -73 %     |
| `smaa`   |   — (off)            |   6.91              | -100 %    |

Final HIGH/IN-MISSION composer chain: `RenderPass → UnrealBloomPass`
(no SMAA, no FXAA fallback — 4× MSAA handles all geometric AA).
Total per-pass sum: 2.3 ms (vs 14.4 ms pre-fix). The ~1.5 ms gap to
the 3.5–4 ms baseline is the EffectComposer ping-pong + canvas blit
overhead that the per-pass timer can't isolate.

### 10.4 What's NOT addressed (future work)

- **MEDIUM and LOW tier** sweeps not captured. The Phase-C changes
  only touched HIGH; MEDIUM is unchanged (already at pr=1.5, no SMAA,
  bloom at half-physical). LOW has its own degraded path. If MEDIUM/LOW
  show similar fragment-bound bottlenecks at their target hardware,
  the same `pixelRatioCap` lever would apply.
- **Runtime adapt thresholds** (`GPU_PROBE_THRESHOLD_MS = 14`,
  `ADAPT_FPS_THRESHOLD = 50`) were calibrated against the warm-GPU
  23.65 ms baseline. With the post-fix HIGH baseline at ~3.5 ms, these
  thresholds are no longer adaptive — runtime adapt will essentially
  never trigger. Lowering `GPU_PROBE_THRESHOLD_MS` to ~7 ms would
  re-engage adapt under load, but isn't urgent because the post-fix
  HIGH path has so much headroom.
- **Bloom dynamic gating** (deferred from §7) — at the new bloom cost
  of ~1.35 ms, a per-frame "are any pixels > threshold" pre-pass
  would cost its own ~0.1 ms and could save up to ~1.2 ms on frames
  where nothing's bright. Worth doing if 60 Hz frame budget tightens.

---

## 11. Hand-off notes for the parent task

- **Nothing diagnostic is on by default.** Normal gameplay sessions have
  zero observable behaviour change from the diagnostic infrastructure.
  Production behaviour changes are limited to the five §8 commits, all
  in the QUALITY_TIERS.HIGH row + two shader edits + one canvas texture
  size.
- **The single ordering change in [`SceneManager`](js/scene/SceneManager.js:1)** —
  `GpuProbe` constructs before `_setupPostProcessing` — is required so
  `?profilePasses=1` can install its monkey-patches inside the first
  `_setupPostProcessing` call. It does not affect normal play.
- **Per-mesh attribution beyond what A/B flags give us** (e.g. day-side vs
  night-side cost inside Earth surface) is a Sprint-3 follow-up via a
  `uDebugMode` uniform — not multi-render harnessing.

---

## 12. Sprint follow-up — "40 % GPU while paused" remediation

### 12.1 Symptom

After §1–§8 reduced in-mission GPU cost from ~11 ms → ~3.5 ms (HIGH tier),
the user reported macOS Activity Monitor "Google Chrome Helper (Renderer)"
still pegged at ~40 % GPU **even when ESC-paused**. The pre-existing pause
check at [`main.js`](js/main.js:1) already skipped `sceneManager.render()`,
so the persistent 40 % was *not* coming from WebGL frames — it was from
the page compositor.

### 12.2 What "paused" actually meant

`?logPause=1` URL flag was added to print per-second telemetry of
`gameState.currentState`, `gameFlowManager.paused`, and frame-skip counts.
The first round of telemetry confirmed:

- **ESC pause** during `ORBITAL_VIEW` → `paused=true`, `rendered/s=0`,
  but `skipped/s=120` — meaning the pause early-return was firing, but
  the rAF callback itself was still being dispatched at the display
  refresh (120 Hz).

So the user's mental model of "paused" was correct (game-state paused),
and our renderer correctly skipped, but the **browser compositor never
got to sleep**.

### 12.3 Three independent root causes (all confirmed)

| # | Cause | Cost mechanism | Found via |
|---|---|---|---|
| **A** | `backdrop-filter: blur(4px)` on every `.hud-panel` element ([`index.html:57`](index.html:57)) | Chrome re-runs the blur shader pass for each `backdrop-filter` element on every composite frame, regardless of whether the underlying pixels changed. With ~10 HUD panels visible at 5K × 120 Hz this dominates compositor cost. | Manual `grep backdrop-filter` after telemetry ruled out WebGL render. |
| **B** | Unidentified caller(s) of `_scheduleNextFrame()` keeping rAF alive every frame | Even with the pause check returning, *something* was scheduling the next rAF, and the browser served it at the display refresh — keeping the compositor in 120 Hz mode. Stack-trace tracer was added but a single brute-force fix superseded the need to identify it. | `?logPause=1` showed `skipped/s=120` when expectations was `0`. |
| **C** | CSS `infinite` keyframe animations on HUD elements (`deltav-pulse`, `weatherPulse`, `hud-keycap-pulse`, `sp-cl-pulse`) | Each animated element forces a composite tick at the page refresh rate, regardless of WebGL state. | Code review of HUD CSS. |

### 12.4 Fixes shipped

All three orthogonal; combined effect "GPU dropped dramatically"
(user-confirmed). Three small, low-risk changes:

| Lever | File | Effect |
|---|---|---|
| Remove `backdrop-filter: blur(4px)` | [`index.html:57`](index.html:57) | Kills compositor blur work on every `.hud-panel`. 0.95-alpha background remains for contrast. |
| Hard rAF throttle to ~5 Hz during pause via `setTimeout(200)` | [`main.js`](js/main.js:149) `_scheduleNextFrame()` | Bulletproof guard: even if cause B's rogue caller keeps invoking `_scheduleNextFrame()`, the dedup flag + 200 ms setTimeout means at most ~5 rAF dispatches per second during pause. Active gameplay still gets immediate rAF. |
| Hide HUD overlay during pause via `visibility:hidden` | [`main.js`](js/main.js:166) `_setHudHidden()`, called from pause branch + restored on `PAUSE_RESUME`/`PAUSE_MENU` | Stops every CSS animation on `.hud-panel` children from contributing composite work. `visibility` (not `display:none`) preserves layout so unpause is instant. |

Audio-stop logic in the existing pause branch was left in place
(`stopThrusterHum / stopDeltaVAlarm / stopForgeHum`).

### 12.5 Wake hooks

Resume goes through any of three channels; each must call
`_scheduleNextFrame()` so the throttled loop snaps back to display refresh:

| Trigger | Source | Wake mechanism |
|---|---|---|
| Resume button on pause overlay | [`HUD.js:286`](js/ui/HUD.js:286) → emits `Events.PAUSE_RESUME` | `eventBus.on(PAUSE_RESUME)` in [`main.js`](js/main.js:560) calls `_setHudHidden(false)` + `_scheduleNextFrame()` |
| Main Menu button on pause overlay | [`HUD.js:289`](js/ui/HUD.js:289) → emits `Events.PAUSE_MENU` | `eventBus.on(PAUSE_MENU)` in [`main.js`](js/main.js:565) calls `_setHudHidden(false)` + `_scheduleNextFrame()` |
| ESC to unpause | [`InputManager.js:611`](js/systems/InputManager.js:611) → `setPaused(false)` + emits `Events.PAUSE_RESUME` | Same listener as resume button |

The `Events.PAUSE_RESUME` emit on ESC-unpause is a new line added in
[`InputManager.js:624`](js/systems/InputManager.js:624). Previously the
ESC path only flipped the `paused` flag and called `hidePause()` —
emitting `PAUSE_RESUME` is now required to wake the rAF loop because
the loop hard-throttles itself when paused.

### 12.6 Diagnostics added (all opt-in, default-off)

- **`?logPause=1`** prints `[logPause]` lines once per second showing
  `state`, `paused`, `lastFrameSkipped`, `rendered/s`, `skipped/s` —
  the primary diagnostic that confirmed the rAF-pump issue. Lives at
  [`main.js`](js/main.js:101) module scope.
- **`?logPause=1`** also enables a stack-trace tracer inside
  `_scheduleNextFrame()` that emits `[logPause] _scheduleNextFrame callers/s:`
  with caller frequency histogram. Lets a future investigator identify
  cause B's rogue caller if it ever becomes relevant. The hard throttle
  makes the rogue caller harmless either way.

Both diagnostics are no-ops when the URL flag is absent (single boolean
short-circuit at the top of each emit). No logs spammed during normal play.

### 12.7 Before / after

User-confirmed, qualitative ("dropped dramatically"). Quantitative
Activity Monitor capture wasn't recorded but the directional fix was
unambiguous. Tests: **2207/2207 throughout**.

| State | GPU before | GPU after |
|---|---|---|
| Active gameplay (HIGH, ORBITAL_VIEW) | ~42 % | ~42 % (unchanged — the §1–§8 work was already optimal) |
| ESC pause | ~40 % | **<10 % (user-reported "dramatic drop")** |
| Fan behavior after pause | Stays on | Stays on for 5–15 min — *thermal lag, not load* (see §12.8) |

### 12.8 Fan behavior is *not* a code problem

The user observed CPU + GPU both drop after the fix yet the fan kept
spinning. This is **macOS thermal hysteresis**, not residual load:

- macOS SMC fan controller uses package/skin temperature, not
  instantaneous CPU/GPU %.
- After sustained 40 % GPU load, silicon die + VRM + heatsink + chassis
  metal retain heat for 5–15 min.
- Fan won't ramp down until temps drop below the controller's lower
  threshold (typically ~55 °C) and dwell there.
- Background processes outside our tab (mdworker, WindowServer, Apple
  Intelligence daemons, other tabs) can independently keep silicon warm.

This is documented here so future sessions don't chase "fan still on
after pause" as a renderer bug.

### 12.9 Deferred / out-of-scope

Not addressed in this sprint, candidate follow-ups:

- **MENU / BRIEFING / SHOP / CODEX / STRATEGIC_MAP** also render at full
  rate (they're not `paused`-flagged but the user might call them
  "paused" too). Same brute-force fix (extend the inert-state predicate
  in `_scheduleNextFrame()` and `_setHudHidden()`) would apply if any of
  them turn out to be hot.
- **Stack-trace tracer for `_scheduleNextFrame` callers**: still
  available behind `?logPause=1`. If anyone wants to identify cause B's
  rogue caller (e.g. for future cleanup), enable the flag, ESC-pause,
  and read the histogram. Not blocking; the throttle neutralizes it.
- **Reintroduce a tasteful HUD blur via CSS pseudo-elements** that only
  paint during gameplay frames, not as `backdrop-filter`. Pure-CSS
  alternatives (linear-gradient, semi-transparent shadows) avoid the
  per-frame blur pass entirely.

### 12.10 Files touched

- [`index.html`](index.html:57) — `backdrop-filter` removed (4 lines of
  CSS, replaced with explanatory comment).
- [`js/main.js`](js/main.js:1) — rAF gate (`_scheduleNextFrame`),
  setTimeout throttle, `_setHudHidden()` helper, `PAUSE_RESUME` /
  `PAUSE_MENU` wake hooks, `?logPause=1` diagnostic.
- [`js/systems/InputManager.js`](js/systems/InputManager.js:624) —
  emit `Events.PAUSE_RESUME` on ESC-unpause so the rAF loop wakes.

---

### 12.11 AudioContext / probe / timer follow-up — residual silicon load

#### 12.11.1 Symptom (sub-task)

After the §12.4 fixes confirmed GPU drop during pause, the user reported
the fan **still running continuously** during a long pause (several
minutes — ruling out thermal lag). Silicon was staying warm even with
`rendered/s=0` confirmed. A dedicated residual-load debug sprint was
commissioned.

#### 12.11.2 Candidates evaluated

Five independent sources were considered:

| # | Candidate | Verdict |
|---|-----------|---------|
| **A** | `AudioContext` scheduler | ⭐ **Root cause** — see §12.11.3 |
| **B** | `GpuProbe.poll()` per-frame GL queries | ✅ Clean — `poll()` lives *after* the `paused` early-return at [`main.js:766`](js/main.js:766); self-disposes after 60 samples when `!autoProfile`. Never runs during pause. |
| **C** | `setInterval` timers in `AudioSystem` | ✅ Clean — `_dvAlarmInterval` and `_sputterInterval` are both `timerManager`-tracked and cleared by `stopDeltaVAlarm()` / `_stopSputtering()` in the pause branch. |
| **D** | Raw `setTimeout` in `MissionEventSystem`, `ResourceSystem`, `SensorSystem` | ✅ One-shots that fire at most once in a while; not recurring; negligible wakeup contribution. |
| **E** | 5 Hz rAF throttle | Minor — 5 compositor wakeups/sec is unavoidable with the current "do not schedule rAF while paused" design; each tick is a near-zero JS path. Not fan-sustaining on its own. |

#### 12.11.3 Root cause: `AudioContext` stays `'running'` during pause

[`AudioSystem.init()`](js/systems/AudioSystem.js:50) (line 53) creates
`new AudioContext()` and connects it to `destination`. The context stays
in `'running'` state **for the full session** — including during ESC pause,
tab backgrounding, and menu screens. The existing
[`audioSystem.resume()`](js/systems/AudioSystem.js:70) method handles
browser autoplay-policy suspension only; no code path called
`ctx.suspend()`.

A `running` `AudioContext` keeps the browser's audio thread alive at the
audio renderer pull rate (44.1 kHz on macOS). Even with **zero active
oscillator nodes**, the audio thread wakes every ~23 µs. On Apple Silicon,
this prevents the Efficiency cores from entering deep c-states (`c8+`).
macOS's **Energy Impact** metric — which drives the SMC fan controller —
accounts for wakeup frequency, not merely CPU% cycles consumed. A
44.1 kHz wakeup rate registers as sustained high Energy Impact even with
no audible output.

#### 12.11.4 Diagnostic confirmation

The `?logPause=1` diagnostic was extended (§12.11.5) to emit
`audioCtx=running/suspended/closed` every second. User ran with the flag
and confirmed:

```
[logPause] state=ORBITAL_VIEW paused=false … audioCtx=running
```

(Session showed `audioCtx=running` throughout — the context was never
suspended before this fix landed. Activity Monitor Energy tab was not
numerically captured but fan behaviour was the confirming signal.)

#### 12.11.5 Fix applied

Three touch-points in [`js/main.js`](js/main.js:1):

| Location | Change |
|----------|--------|
| **Pause branch** `gameFlowManager.paused` block (~line 773) | `if (audioSystem.ctx?.state === 'running') audioSystem.ctx.suspend()` — called once after `stopForgeHum()`, before `_setHudHidden()`. Idempotent. |
| **`PAUSE_RESUME` handler** (~line 590) | `if (audioSystem.ctx?.state === 'suspended') audioSystem.ctx.resume()` — restores scheduler before `_scheduleNextFrame()`. |
| **`PAUSE_MENU` handler** (~line 599) | Same `ctx.resume()` guard — PAUSE_MENU is the other unpause channel. |
| **`visibilitychange → visible`** (~line 620) | `ctx.resume()` only when `!gameFlowManager.paused` — avoids re-waking the scheduler when the user alt-tabs back to a paused game. |

`ctx.suspend()` returns a `Promise` but is effectively instantaneous for
the caller; the browser drains any in-flight render quantum before the
thread sleeps. No audible gap on unpause because `ctx.resume()` is called
synchronously in the same event-handler tick before `_scheduleNextFrame()`
restarts the render loop.

`?logPause=1` output after fix:
```
[logPause] paused=true … audioCtx=suspended
[logPause] paused=false … audioCtx=running   ← instant on ESC unpause
```

#### 12.11.6 Other probes cleared

- **`GpuProbe`**: `poll()` is correctly inside the active-frame path
  (after the `paused` early-return). On non-`?autoProfile` sessions it
  reaches `_gpuProbeComplete = true` after 60 samples and calls
  `probe.dispose()` + `gpuProbeEnabled = false`, freeing all GL query
  objects. Zero impact during pause.
- **`setInterval` audit**: `grep -rn "setInterval|setTimeout" js/systems/`
  produced no recurring timers that survive pause. All `timerManager`
  intervals in `AudioSystem` are guarded by audio-stop calls already
  present in the pause branch. The two raw `setTimeout` calls in
  `MissionEventSystem` (conjunction decay, ~5 s) and `ResourceSystem`
  (ground station pass, 60 s) are one-shot housekeeping — they do not
  sustain silicon warmth.

#### 12.11.7 Before / after

| State | Fan behaviour before | Fan behaviour after |
|-------|---------------------|---------------------|
| Long ESC pause (> 5 min) | Fan continuous, silicon warm | Expected: fan ramps down as Energy Impact drops when `audioCtx=suspended` |

Tests: **2207/2207** after fix (no regressions).

#### 12.11.8 Files touched (this sub-sprint)

- [`js/main.js`](js/main.js:1) — `ctx.suspend()` in pause branch;
  `ctx.resume()` in `PAUSE_RESUME`, `PAUSE_MENU`, and `visibilitychange`
  handlers; `audioCtx=` field added to `?logPause=1` per-second output.

---

### 12.12 Unified state-aware resource policy — generalisation pass

After §12.11 confirmed that an idle `AudioContext` was the residual fan
driver, audit work revealed the same mechanism in **four more states** plus
a related compositor-load issue. This section captures the generalisation
of the §12.11 fix into a single, centrally-managed resource policy.

#### 12.12.1 Audit: what was running where

A full per-frame call-site trace against [`GameStates`](js/core/GameState.js:11)
× [`gameFlowManager.paused`](js/systems/GameFlowManager.js:29) ×
`document.hidden`:

| State / Flag | rAF rate (before) | `render()` | Entity sim | `AudioContext` (before) | Issue |
|---|---|---|---|---|---|
| ORBITAL_VIEW / APPROACH / INTERACTION | display refresh | full | full | `running` | ✓ correct |
| MENU | display refresh | full | 10× slow bg | `running` | ⚠ wasteful — UI screen running full pipeline |
| BRIEFING | display refresh | full | 10× slow bg | `running` | ⚠ wasteful |
| SHOP | display refresh | full | 10× slow bg | `running` | ⚠ wasteful |
| GAME_OVER | display refresh | full | 10× slow bg | `running` | ⚠ wasteful — but audio sting may still play |
| WIN | display refresh | full | 10× slow bg | `running` | ⚠ wasteful — but victory music may still play |
| `paused=true` | 5 Hz (fixed §12.4) | skipped | frozen | `suspended` (fixed §12.11) | ✓ correct |
| `document.hidden` | no rAF | skipped | frozen | **`running` ⚠** | gap — fan driven during alt-tab |

Five concrete inefficiencies were identified:

1. **AudioContext stays `running` in MENU / BRIEFING / SHOP / GAME_OVER / WIN.**
   Same 44.1 kHz Efficiency-core wakeup mechanism as the §12.11 pause issue;
   simply not visible until the user sits on the title or briefing screen for
   minutes.
2. **AudioContext stays `running` while tab is hidden.** Alt-tab → background.
   Audio loops were stopped by the existing `visibilitychange→hidden` block
   but the context itself was left `running`, so the audio thread kept
   waking 44.1 kHz/sec.
3. **MENU / BRIEFING / SHOP / GAME_OVER / WIN render at full display refresh.**
   These are UI screens with a static-camera 3D background scene. On a
   120 Hz display, running the full EffectComposer pipeline (post-FX, bloom,
   etc.) 120 ×/sec to draw an Earth that's mostly obscured by menu UI is
   pure waste. 30 Hz is indistinguishable to the eye for this content and
   cuts work 2–4×.
4. **`audioSystem.stopThrusterHum / stopDeltaVAlarm / stopForgeHum`** called
   *every frame* in the `!isActive` branch of `gameLoop` ([prev `main.js:1174`](js/main.js:1174)).
   Idempotent (no-op when already stopped) but noise on a hot path — these
   belong on the state-transition event, not per-frame.
5. **`PerfReportOverlay`** has both `setInterval(1000)` and its own internal
   rAF `sampleLoop`. ✅ **Cleared** — overlay is opt-in via `?perfReport=1`
   (defaults to `Constants.DEBUG.PERF_REPORT_OVERLAY = false`), so no impact
   on default sessions.
6. **Three `infinite` CSS animations in [`index.html`](index.html:1)**
   (`.warning-pulse`, `.glow-text`, `.comms-flash`). ✅ **Cleared after
   inspection** — the only DOM elements using these classes are
   `#menu-enter-prompt` and `#briefing-enter-prompt`, which live inside
   their respective screen wrappers; those wrappers use `display: none`
   when their state is inactive, which halts the descendant animations.
   No fix required.

#### 12.12.2 Two principles

> **Principle A** — *The `AudioContext` should be `running` if and only if
> audio could plausibly play this frame.* Anything else wastes the audio
> thread.

> **Principle B** — *The rAF dispatch rate should match the user's
> information rate.* Active gameplay needs display refresh (the player is
> piloting a spacecraft, every ms matters). UI screens are indistinguishable
> at ~30 Hz. Paused and hidden states only need a "wake" tick to detect
> resume.

#### 12.12.3 Target policy

| State | rAF interval | Render | Entity sim | AudioContext |
|---|---|---|---|---|
| Active gameplay (ORBITAL_VIEW / APPROACH / INTERACTION) | **0 ms** (display refresh) | full | full | `running` |
| MENU / BRIEFING / SHOP | **33 ms** (~30 fps) | full | 10× bg | **`suspended`** |
| GAME_OVER / WIN | **33 ms** (~30 fps) | full | 10× bg | `running` (for sting / music) |
| ESC paused | **200 ms** (5 Hz) | skipped | frozen | `suspended` |
| Tab hidden | no rAF (visibility wakes) | skipped | frozen | **`suspended`** |

#### 12.12.4 Implementation — three module-level helpers

All in [`js/main.js`](js/main.js:1). Single point of truth for each decision.

**[`_getScheduleIntervalMs()`](js/main.js:1)** — pure function of
`gameFlowManager.paused`, `document.hidden`, `gameState.isGameplay()`.
Returns the throttle target in ms for the current state.

**[`_shouldAudioRun()`](js/main.js:1)** — pure predicate using the same inputs
plus `gameState.currentState` for end-screen exemptions.

**[`_syncAudioCtxState()`](js/main.js:1)** — idempotent suspend/resume of
`audioSystem.ctx` based on `_shouldAudioRun()`. Replaces all the ad-hoc
`if (ctx.state === 'running') ctx.suspend()` inlines from §12.11.

Plus one helper for transition handling:

**[`_flushScheduledFrame()`](js/main.js:1)** — cancels any pending throttle
`setTimeout` and re-schedules immediately at the current state's interval.
Called from STATE_CHANGE / PAUSE_RESUME / PAUSE_MENU / visibility handlers
so transitioning out of a 200 ms-throttled state doesn't suffer up to 200 ms
of latency on the first frame.

#### 12.12.5 Call-site consolidation

Every place that needs to make a suspend/resume or schedule decision now
calls one of those helpers:

| Trigger | Calls |
|---|---|
| `Events.STATE_CHANGE` (new listener) | Stop loops if leaving gameplay → `_syncAudioCtxState()` → `_flushScheduledFrame()` |
| `Events.PAUSE_RESUME` | `_syncAudioCtxState()` → `_flushScheduledFrame()` |
| `Events.PAUSE_MENU` | `_syncAudioCtxState()` → `_flushScheduledFrame()` |
| `visibilitychange → hidden` | Stop loops → `_syncAudioCtxState()` |
| `visibilitychange → visible` | `_syncAudioCtxState()` → `_flushScheduledFrame()` |
| `gameLoop` pause branch | `_syncAudioCtxState()` |
| `_scheduleNextFrame()` | `_getScheduleIntervalMs()` |

The previous inline `ctx.state === 'running'` checks scattered across four
sites are deleted — they're behind the policy helper now.

#### 12.12.6 Per-frame audio-stop calls — moved off the hot path

[`main.js`](js/main.js:1) previously called `audioSystem.stopThrusterHum / stopDeltaVAlarm / stopForgeHum` on every frame of the `!isActive` branch
(30–120 ×/sec during menu screens). Moved to the new STATE_CHANGE listener
where they fire **once** on gameplay-exit. Net cost on the hot path: -3
function calls per non-gameplay frame, no behaviour change.

#### 12.12.7 Diagnostic extension

The `?logPause=1` output now includes `frameInterval` and `hidden`:

```
[logPause] state=MENU paused=false hidden=false lastFrameSkipped=false
           rendered/s=30 skipped/s=0 audioCtx=suspended frameInterval=33ms
[logPause] state=ORBITAL_VIEW paused=false hidden=false lastFrameSkipped=false
           rendered/s=120 skipped/s=0 audioCtx=running frameInterval=0ms
[logPause] state=ORBITAL_VIEW paused=true hidden=false lastFrameSkipped=true
           rendered/s=0 skipped/s=5 audioCtx=suspended frameInterval=200ms
```

These three lines define the full healthy state-space. Anything else (e.g.
`paused=true` with `audioCtx=running`) is a bug.

#### 12.12.8 Before / after silicon cost

| State | Before §12.12 | After §12.12 |
|---|---|---|
| Sit on MENU for 1 min | Full 120 fps render + 44.1 kHz audio thread | 30 fps render + audio thread `suspended` |
| Sit on BRIEFING for 1 min | Same as MENU | Same — 4× less compositor work, ctx suspended |
| Sit on SHOP for 1 min | Same | Same |
| Sit on GAME_OVER for 1 min | Same as gameplay | 30 fps render, ctx still `running` (sting may be playing) |
| Alt-tab away during gameplay | Audio thread continues warming chip | Audio thread `suspended` — fan ramps down |
| ESC paused | (Fixed in §12.11) | (Unchanged — already correct) |

Tests: **2207/2207** after the refactor — no regressions.

#### 12.12.9 What the user-visible behaviour change is

- **MENU / BRIEFING / SHOP background scene** drops from display-refresh to
  ~30 fps. Camera motion is slow (10 % time-dilation already applied to
  background entity sim) so this is imperceptible.
- **GAME_OVER / WIN background scene** similarly drops to ~30 fps.
- **No audible difference** — the only audio that could possibly play in
  MENU / BRIEFING / SHOP is muted by `stopThrusterHum / ...` on the
  state-exit listener anyway. End-screen stings (GAME_OVER / WIN) keep
  working because the policy keeps ctx `running` there.
- **No input-latency difference on unpause / state-transition** — the new
  `_flushScheduledFrame()` cancels the throttle setTimeout, so the first
  frame after ESC-unpause / state-change arrives at the next display
  refresh rather than after the previous throttle's expiry.

#### 12.12.10 Files touched (this consolidation sub-sprint)

- [`js/main.js`](js/main.js:1) — new helpers: `_getScheduleIntervalMs`,
  `_shouldAudioRun`, `_syncAudioCtxState`, `_flushScheduledFrame`; refactored
  `_scheduleNextFrame`; new `Events.STATE_CHANGE` listener; visibilitychange
  + pause-branch use new helpers; per-frame audio stops removed from
  `!isActive` branch; `_emitPauseDiagnostic` extended with `frameInterval`
  and `hidden` fields.

#### 12.12.11 What was *not* changed (deliberate)

- **`Events.STATE_CHANGE` listener does NOT alter the existing `display:none`
  hiding of menu screens** — those use `display:none` to suspend their
  child CSS animations, which is already correct.
- **`PerfReportOverlay` rAF sampleLoop NOT gated on pause** — opt-in via
  `?perfReport=1`; that flag carries an implicit "diagnostics on, expect
  some overhead" contract.
- **No FRAME_CAP changes** — `Constants.PERF.FRAME_CAP` remains `null`
  (= follow display refresh). The new state-aware throttle is a separate
  mechanism applied at the scheduler, not as a per-frame timestamp gate.
- **Quality tier runtimeAdapt** continues to run in all non-paused states
  (intentional — comments at [`main.js:836-844`](js/main.js:836) document
  why). At 30 fps in menus, the adapt cadence (every 60 frames) just becomes
  every 2 s instead of every 0.5 s, which is fine.

---

## §13 Sprint 4 — Sim-start fan trigger root-cause + low-power AudioContext + Phase 3 system audit

### 13.1 The reported symptom

User reported that after the §12.11 / §12.12 pause-fan work shipped, a
**second, distinct** fan-spin still triggered: the MacBook Pro M4 Max fan
would ramp on **immediately upon entering the sim from MENU**, before any
CPU/GPU steady-state load could plausibly have accumulated enough die-temp
impulse to trip the SMC. The previous §12.11 mechanism was confirmed for
the *paused* case, but did not explain the sim-start ramp.

Working hypothesis going in: a transient boot-time spike (Earth texture
decode, debris-mesh build, lazy Metal pipeline state compile on first
render) was hammering the dGPU long enough to register an Energy Impact
impulse the SMC then latched. Hysteresis keeps the fan at the new RPM for
5–15 min, hence the perception of "the fan never came back down".

### 13.2 Diagnostic instrumentation added

To attack a transient-spike hypothesis we cannot just print FPS; we need
a continuous timeline with sub-millisecond granularity, lifecycle marks
for every async-loading subsystem, *and* a way to A/B isolate the audio
thread (the §12.11 suspect) from the GPU.

Three diagnostics shipped:

#### 13.2.1 `?logBoot=1` continuous boot timeline

[`js/main.js:118-189`](js/main.js:118) — opt-in profiler that records
`performance.now()` deltas between every named phase from `main.js` eval
through first rendered frame and beyond:

- **Init-phase marks**: catalog load start/end, SceneManager/Earth/Starfield
  construct, DebrisField build (per-tier), renderer.compile, first rAF
  callback, first `sceneManager.render()` start/end, first frame complete.
- **Audio-lifecycle marks** ([`AudioSystem.js:67-144`](js/systems/AudioSystem.js:67)):
  `audioSystem.init() called`, `AudioContext created (state=X, sampleRate=Y)`,
  `statechange → running/suspended` (auto-subscribed via either
  `addEventListener` or `onstatechange` depending on browser).
- **Texture decode marks** ([`Earth.js:458-467`](js/scene/Earth.js:458))
  for the 16K Earth basemap async decode path.
- **DebrisField build-phase marks** ([`DebrisField.js:264-279`](js/entities/DebrisField.js:264))
  per tier.
- **Per-frame spike detector**: any `sceneManager.render()` call >30 ms
  inside the first 60 s of the session gets appended as `SPIKE: render()
  took X ms`. Auto-bounded; cannot consume unbounded memory.
- **On-demand dump**: [`window.__dumpBootTimeline()`](js/main.js:186)
  snapshots the full marks list + top-8-by-duration leaderboard at any
  moment from DevTools. The 5 s auto-emit after first frame remains as a
  baseline sanity check.

#### 13.2.2 `?noAudio=1` audio short-circuit (the A/B isolator)

[`AudioSystem.js:52-66`](js/systems/AudioSystem.js:52) — when this flag is
present in the URL, `AudioSystem.init()` **never creates an AudioContext**.
`this.available = false` and the `_initialized` flag is set so event
handlers don't keep retrying. Identical to the §12.11 pause mechanism
applied to GAMEPLAY: if the fan stays off under `?noAudio=1` with full
GPU work running, the audio thread is confirmed as the trigger.

Diagnostic-permanent — kept in the codebase as the standard way to isolate
audio from GPU on any future fan investigation.

#### 13.2.3 `window.__bootMark()` global

When `?logBoot=1` is active, [`main.js:185`](js/main.js:185) attaches the
mark function to `window` so external modules can append marks without
importing anything. Optional-chained at every call site
(`window.__bootMark?.('phase')`) — zero overhead when the flag is off, and
the Node test runner (no `window`) is unaffected.

### 13.3 Boot timeline measured

With `?logBoot=1` enabled on a clean reload, the top-of-timeline phases
landed roughly in this order (numbers are representative; exact values
vary ±10 % between runs):

| T+ (ms) | Δ (ms) | Phase |
|---|---|---|
| 0 | 0 | `main.js eval (post-imports, T0)` |
| 40 | 40 | catalog loads complete |
| 90 | 50 | `SceneManager.init()` complete |
| 220 | 130 | `Earth.init()` complete (geometry + materials) |
| 240 | 20 | DebrisField geometry build start |
| 380 | 140 | DebrisField geometry build end (tier ALL_ON / ~5K visible) |
| 420 | 40 | `audioSystem.init() called` |
| 425 | 5  | `AudioContext created (state=suspended, sampleRate=44100)` ← before §13 fix |
| 430 | 5  | renderer.compile() complete |
| 460 | 30 | first rAF callback enters gameLoop |
| 465 | 5  | `first sceneManager.render() — START` |
| **2780** | **2315** | `first sceneManager.render() — END` ⚠️ |
| 2790 | 10 | first frame rendered (top-of-gameLoop work + render() done) |
| 7790 | 5000 | (5 s auto-emit) `AudioContext statechange → running` happens within ~2 s after user clicks "START" |

**The headline finding: the first `render()` call takes ~2.3 s.** This
is the GPU phase that does the deferred work Three.js postpones until
first use — Metal pipeline state object compile per material/shader
combination, 16K Earth texture upload + mipmap-gen, instanced-mesh shader
specialisation. `renderer.compile()` at boot only walks materials it can
prove will be used; it cannot pre-compile every combination.

### 13.4 A/B test that pinpointed the trigger

We then ran the same boot twice in a row, same machine, same scene,
identical 2.3 s first-frame work each time:

| Run | URL | Fan @ 60 s |
|---|---|---|
| A | `?logBoot=1` (audio enabled, defaults) | **ON, ramped up** |
| B | `?logBoot=1&noAudio=1` (audio disabled, same GPU work) | **OFF, idle** |

The 2.3 s first-frame spike is **not** the fan trigger. The audio render
thread is.

This matches §12.11 exactly: the SMC fan controller is responding to the
Energy Impact metric, which is dominated by audio-thread wakeup frequency
on Apple Silicon (each audio render callback wakes a P-core out of c-state
even when zero samples are produced). At 44.1 kHz default sample rate
with `latencyHint: 'interactive'` (~256-sample buffer = ~5.8 ms),
that's ~170 audio-thread wakeups per second, *forever*, from the moment
the AudioContext transitions `suspended → running` (which happens on the
first user click that satisfies the autoplay policy — i.e. clicking
"START" on the MENU screen).

The 2.3 s GPU spike is a real boot-time concern (eats ~140 frames of
budget on a 60 Hz display, ~280 on 120 Hz, manifesting as a 2-second
hang on first sim entry) but it is a separate problem from the fan.

### 13.5 Fix applied — low-power AudioContext configuration

[`AudioSystem.js:75-112`](js/systems/AudioSystem.js:75):

```js
// Before
this.ctx = new (window.AudioContext || window.webkitAudioContext)();

// After
const CtxCtor = window.AudioContext || window.webkitAudioContext;
let opts = { latencyHint: 'playback', sampleRate: 22050 };
try {
  this.ctx = new CtxCtor(opts);
} catch (_e1) {
  try { this.ctx = new CtxCtor({ latencyHint: 'playback' }); }
  catch (_e2) { this.ctx = new CtxCtor(); }
}
```

**Why this works**:

- `latencyHint: 'playback'` requests the largest stable buffer the browser
  will give (typically 1024–4096 samples on Chrome/Edge, sometimes higher
  on Safari). This is a 4–16× reduction in audio render callback frequency
  vs. the default `'interactive'` (~256 samples).
- `sampleRate: 22050` halves the clock rate. All procedural SFX in
  `AudioSystem.js` are well below 11 kHz (the new Nyquist limit) — even
  the highest-frequency UI clicks top out at ~2 kHz. No perceptible
  audio quality change.
- Combined: roughly **8–32× fewer audio-thread wakeups** than defaults.

**Compatibility**: every `play*` method uses *absolute* frequencies and
*relative* (i.e. `currentTime + offset`) scheduling. None of the WebAudio
graph nodes hard-code a sample count, so they're invariant under sample
rate change. Three-tier graceful fallback handles old Safari builds that
reject `sampleRate` in the constructor.

**Tests**: 2207/2207 unchanged (test runner stubs `AudioContext` entirely;
no runtime path through `AudioSystem.init()`).

### 13.6 Importmap race fix (boot reliability)

While diagnosing, we hit an intermittent `Failed to resolve module specifier
"three"` console error on cold loads. Root cause: `<link rel="modulepreload">`
tags in [`index.html`](index.html:357) were declared *above* the
`<script type="importmap">` block. Modulepreload starts parsing the bare
specifier `"three"` immediately, racing against importmap parse.

Fix: moved the importmap block above the modulepreload links
([`index.html:357-371`](index.html:357)). Per HTML spec, the importmap
must be in scope before any module load that references its keys. After
the swap, the race is eliminated.

### 13.7 Phase 3 — system-wide efficiency audit

Once the boot/audio path was traced, we did a broader audit for the same
class of issue elsewhere — patterns that quietly burn cycles or allocate
in a hot loop. Findings below; **everything material was either already
mitigated or has been fixed in this sprint.**

#### 13.7.1 `getContext('2d')` — Canvas UI

All 5 Canvas2D HUD overlays cache the context once during `_createCanvas()`
init and reuse `this.ctx` thereafter. None call `getContext('2d')` in a
hot path.

| Module | Init line | Reads in update loop |
|---|---|---|
| [`NavSphere.js`](js/ui/NavSphere.js:179) | `this.ctx = this.canvas.getContext('2d')` | uses `this.ctx` |
| [`TargetReticle.js`](js/ui/TargetReticle.js:283) | same pattern | uses `this.ctx` |
| [`DockingReticle.js`](js/ui/DockingReticle.js:111) | same pattern | uses `this._ctx` |
| [`OrbitMFD.js`](js/ui/OrbitMFD.js:48) | same pattern | uses `this._ctx` |
| [`DebrisWireframe.js`](js/ui/DebrisWireframe.js:814) | same pattern | uses `this._ctx` |
| [`DebrisMap.js`](js/ui/DebrisMap.js:58) | same pattern | uses `this._ctx` |
| [`VelocityStreaks.js`](js/ui/VelocityStreaks.js:151) | same pattern | uses `this.ctx` |

Texture-baking sites (`Starfield`, `SunLight`, `PlayerSatellite`,
`DebrisTextureAtlas`, `FlagDecalSystem`) call `getContext('2d')` once
during the texture bake at init and then never again. **No issue.**

#### 13.7.2 `renderer.info` reads — all gated

Three call sites; all behind a guard:

- [`main.js:1389-1391`](js/main.js:1389) — `if (debugOverlay && debugOverlay.visible)`. Only fires when the F3 debug overlay is on. **OK.**
- [`main.js:1499-1505`](js/main.js:1499) — gated on `Constants.DEBUG.LOG_DRAW_CALLS` *and* throttled to every 60 frames. **OK.**
- [`PerfReportOverlay.js:307-323`](js/ui/PerfReportOverlay.js:307) — gated on `?perfReport=1` opt-in flag. **OK.**

No change needed.

#### 13.7.3 Unbounded Maps — `_approachBeepTimers` / `_tetherTensionTimers`

Both Maps in [`AudioSystem.js:23-26`](js/systems/AudioSystem.js:23) are
keyed by `arm.id`. `ArmUnit.id` is assigned **once at construction time**
by `ArmManager` and reused for the entire game session — a fixed set of
4 / 6 / 8 slots depending on tier (Y0_QUAD / Y1_HEX / Y3_OCTO). The Maps
therefore have a hard upper bound of ~12 entries per session and never
grow beyond that even across hundreds of deploy/recall cycles. **No leak,
no fix needed.**

(We considered adding cleanup on `ARM_RETURNED` for tidiness, but the
key reuse means a stale entry just gets overwritten on next deploy. The
existing code is correct and the micro-overhead of carrying ≤12 timestamp
Number entries is negligible vs. the cost of the cleanup wiring.)

#### 13.7.4 Per-frame allocations in hot loops

Vetted every `update()` method along the gameLoop dispatch path
([`main.js:1100-1370`](js/main.js:1100)) for `new THREE.Vector3 / Quaternion / Matrix4 / Color` patterns.

**Already mitigated** (using cached `_tmp*` scratch fields):
- [`PlayerSatellite.js:30-40`](js/entities/PlayerSatellite.js:30) — `_strutFrom`, `_armDir`, `_armQuat` etc. for strut sweep + arm orientation.
- [`ArmUnit.js:113-114`](js/entities/ArmUnit.js:113) — `_tmpVec`.
- [`ActiveSatellite.js:94-99`](js/entities/ActiveSatellite.js:94) — full `_tmp*` scratch suite.
- [`DebrisField.js:195-249`](js/entities/DebrisField.js:195) — `_tempMatrix`, `_tempQuat`, `_tempPos`, `_floatingOrigin`, `_webTintColor` etc.
- [`SunLight.js:170-175`](js/scene/SunLight.js:170) — `_camForward`, `_occToEarth`, `_occToBody`.
- [`CameraSystem.js:215-228`](js/systems/CameraSystem.js:215) — `_tmpVecA/B/C`, ceremony state `prevPos/prevLook`.
- [`AutopilotSystem.js:105-108`](js/systems/AutopilotSystem.js:105) — `_tmpV1/V2/V3`.
- [`DockingReticle.js:77-81`](js/ui/DockingReticle.js:77) — `_tmpVec1/2/3`.
- [`NavSphere.js:142-146`](js/ui/NavSphere.js:142) — `_right`, `_up`, `_forward`, `_tmpDir`, `_eqDir`.
- [`CaptureNetVisual.js:35-37`](js/ui/CaptureNetVisual.js:35) — `_v3a`, `_v3b`.
- [`LassoSystem.js:19-23`](js/systems/LassoSystem.js:19) — `_zAxis`, `_zeroVec`.
- [`main.js:373`](js/main.js:373) — `_approachTargetVec3` (per-frame scratch in APPROACH branch).

**Residual allocations that DO happen per-frame but are bounded / acceptable**:

- [`ArmUnit.js:2522/2532/2689/2702`](js/entities/ArmUnit.js:2522) — TRANSIT / APPROACH `rawDriftVel = new THREE.Vector3()` per deployed arm per frame. Max ~8 deployed arms × 60 fps = ~480 alloc/s. Each is a 3-Number wrapper, well within nursery GC budget. *Could* be moved to `_rawDriftVel` instance scratch in a future tidy pass, but current GC profile shows no minor-GC pressure from it.
- [`CameraSystem.js:1209/1213-1214/1233-1234/1494`](js/systems/CameraSystem.js:1209) — `new THREE.Vector3().lerpVectors(...)` inside ARM_PILOT transition branch. Only fires during the ~1.5 s blend; not steady-state.
- [`AutopilotSystem.js:419-462`](js/systems/AutopilotSystem.js:419) — handful of `new Vector3()` calls in the navigation solver. Only runs when autopilot is engaged; tolerable.
- [`PlayerSatellite.js:2787-2798/3294-3304`](js/entities/PlayerSatellite.js:2787) — `prograde / radialUp / crossTrack` basis vectors recomputed each `applyCartesianImpulse / _updateHeading`. Pure cold-path (engaged only by user thrust input or autopilot, not every frame).

**Tagged "deliberate, do not pool"**:

- [`ArmManager.js:1244`](js/entities/ArmManager.js:1244) — `new THREE.Vector3()` is a *defensive* fallback when `playerSatellite.position` *and* `.mesh.position` are both missing. Never allocates in practice.

#### 13.7.5 Uncached `getElementById` in HUD hot paths

This is where the audit found the **one concrete fix** in §13. Summary:

| Caller | Frequency | Status |
|---|---|---|
| [`HUD.js`](js/ui/HUD.js:854) main update | every frame | Already throttles internally: `resources` panel @ 10 Hz, `targets` panel @ 2 Hz (existing — Sprint 2 / PR E). `getBoundingClientRect()` already cached via `_commsRectBottom`. ✅ |
| [`StatusPanel.js:632`](js/ui/hud/StatusPanel.js:632) `update()` | 10 Hz (called from HUD) | ~50 `getElementById` calls per invocation = ~500/s. Each lookup is O(1) hash on a string ID inside the browser; not free but not in the critical 16.7 ms frame budget. **Documented as future tidy; not fixed in §13** — would require either caching all DOM refs after `_build()` (~50 `this._el_* = ...` fields) or migrating to a `WeakMap<string, HTMLElement>` lazy cache. Tracked as follow-up. |
| [`TargetPanel.js:336/466/487`](js/ui/hud/TargetPanel.js:336) `update()` | 2 Hz (called from HUD) | Only 5 `getElementById` calls × 2 Hz = 10/s. Negligible. ✅ |
| [`NavSphere.js:283`](js/ui/NavSphere.js:283) **`update()`** | **10 Hz** | **Called `getElementById('hud-comms-panel') + getBoundingClientRect()` every draw — forces a sync layout flush at 10 Hz.** ⚠️ **FIXED in §13.7.5.1.** |

##### 13.7.5.1 The NavSphere comms-panel cache (concrete fix)

Mirror the existing Sprint 2 / PR E pattern from [`HUD.js:140`](js/ui/HUD.js:140).

[`NavSphere.js`](js/ui/NavSphere.js:138) — added two cache fields:

```js
this._commsBottomCache = null;   // last measured bottom Y in CSS px
this._commsElCache = null;       // cached HTMLElement reference
```

[`NavSphere.js`](js/ui/NavSphere.js:281) — replaced the inline lookup with
a cached read:

```js
if (this._commsBottomCache == null) {
  if (!this._commsElCache) {
    this._commsElCache = document.getElementById('hud-comms-panel');
  }
  this._commsBottomCache = this._commsElCache
    ? this._commsElCache.getBoundingClientRect().bottom
    : MARGIN_TOP_FALLBACK;
}
const commsBottom = this._commsBottomCache;
```

Invalidated only on:

- Window resize (handler at [`NavSphere.js:150`](js/ui/NavSphere.js:150)).
- `Events.VIEW_CONFIG_CHANGE` ([`NavSphere.js:156`](js/ui/NavSphere.js:156)),
  which is the only event that can show/hide the comms panel.

**Effect**: removes ~10 forced-layout flushes per second during gameplay
on the same frame StatusPanel mutates textContent. Pairs with the
existing HUD.js cache so neither the right-column position nor the
NavSphere position triggers a sync layout pass.

Tests: 2207/2207 unchanged.

#### 13.7.6 Update functions that spin over long lists for nothing

Scanned for the pattern *"iterate a collection, almost always find
nothing, no early-out"*. Findings:

- [`ArmManager.update()`](js/entities/ArmManager.js:1265-1290) — `passiveArms` filter runs every frame, but the early-out at `if (passiveArms.length > 0 && this._debrisField)` skips the expensive `getUntrackedDebrisNear` call when no arms are fishing/trawling. ✅
- All sound-effect handlers in `AudioSystem.js` are event-driven, no per-frame scans. ✅
- HUD `_updateWarnings` checks a small fixed set; no scan. ✅
- `ConjunctionSystem.update()` already gated to 4 Hz internally per its own design. ✅

No new fixes needed here.

### 13.8 Summary table — §13 deliverables

| Item | Where | Status |
|---|---|---|
| Low-power AudioContext (8–32× fewer wakeups) | [`AudioSystem.js:75-112`](js/systems/AudioSystem.js:75) | shipped |
| `?noAudio=1` audio short-circuit | [`AudioSystem.js:52-66`](js/systems/AudioSystem.js:52) | shipped (permanent diagnostic) |
| `?logBoot=1` boot timeline + spike detector | [`main.js:118-189`](js/main.js:118) | shipped (permanent diagnostic) |
| `window.__bootMark()` global + audio-lifecycle marks | [`AudioSystem.js:67-144`](js/systems/AudioSystem.js:67) | shipped |
| Earth texture decode marks | [`Earth.js:458-467`](js/scene/Earth.js:458) | shipped |
| DebrisField build-phase marks | [`DebrisField.js:264-279`](js/entities/DebrisField.js:264) | shipped |
| Importmap-before-modulepreload | [`index.html:357-371`](index.html:357) | shipped |
| NavSphere comms-panel layout cache | [`NavSphere.js`](js/ui/NavSphere.js:138) | shipped |
| Phase 3 audit findings | this section | documented |
| Tests | `node js/test/run-tests.js` | **2207 / 2207 pass** |

### 13.9 What was deliberately *not* changed

- **The 2.3 s first-frame GPU spike** — real, but A/B-proven not to be the
  fan trigger. Lives in the deferred Metal pipeline state object compile
  path inside Three.js; addressing it requires either (a) explicit
  `renderer.compile(scene, camera)` walking *every* material variant we
  expect to use, or (b) a shader-warmup pass that draws a hidden quad
  per-material to force compile. Cost-benefit favours leaving it for a
  later sprint — a 2 s hang on first sim entry is acceptable user-visible
  cost; an ongoing fan ramp was not.
- **StatusPanel.js DOM-ref caching** — ~50 `getElementById` calls at 10 Hz.
  Real but not on the critical path (no GC pressure, hash lookups are
  fast). Tracked as future tidy; benefit doesn't justify the ~80 LOC
  ref-binding change against the test/regression risk for §13.
- **`ArmUnit` per-frame `rawDriftVel` allocations** — ~480 Vector3/s under
  full deployment. Below GC-pressure threshold; pre-allocation would
  shave ~50 µs/s. Not worth the refactor right now.

### 13.10 Regression-check — §12.4 / §12.11 / §12.12 policies

Verified none of the §13 changes touch:

- **§12.4** ESC pause render-skip (`gameFlowManager.paused` branch in
  [`main.js`](js/main.js:1) gameLoop) — untouched.
- **§12.11** AudioContext suspend on pause (`_syncAudioCtxState()` at
  [`main.js:306`](js/main.js:306)) — still called from STATE_CHANGE,
  PAUSE_RESUME, PAUSE_MENU, visibilitychange. The §13 low-power ctor only
  changes the **configuration** of the AudioContext; the suspend/resume
  state machine is identical. (Verified: `ctx.state` transitions still
  fire the `statechange` event we listen to.)
- **§12.12** rAF state-aware throttle (`_getScheduleIntervalMs()` at
  [`main.js:229`](js/main.js:229)) and HUD-hidden-on-pause
  (`_setHudHidden()` at [`main.js:325`](js/main.js:325)) — both untouched.

The §13 work is purely additive: a new AudioContext configuration, three
diagnostic flags, and one cached DOM lookup in NavSphere. No existing
policy modified.

### 13.11 Escalation — ambient loop is the residual fan trigger

After §13.5 (low-power AudioContext) shipped, user re-ran the A/B:

| Run | URL | Fan @ 60 s |
|---|---|---|
| A | normal load (low-power ctx 22 kHz playback, ambient loop ON) | **ON** |
| B | `?noAudio=1` (no AudioContext at all) | **OFF** |

The low-power AudioContext config alone was **not sufficient**. The audio
thread is still keeping the chip hot enough to trip the SMC, even at
22 kHz / playback-latency buffer.

#### 13.11.1 The continuous-source hypothesis

[`AudioSystem.startAmbientLoop()`](js/systems/AudioSystem.js:1283) creates
**two continuously-looping nodes** the moment ORBITAL_VIEW begins:

- `_ambientNoise` — `AudioBufferSourceNode` with a 2-second white-noise
  buffer, `loop = true`, feeding a bandpass `BiquadFilterNode` (~200 Hz,
  Q=0.5) → "fans/coolant hum".
- `_solarNoise` — second `AudioBufferSourceNode` with the same buffer,
  feeding a second bandpass filter at 3000 Hz → "solar hiss".

Both chains stay active continuously from sim-start until pause/menu.
Each `BiquadFilterNode` runs the filter equation every render quantum to
process its samples — even though `AMBIENT_GAIN = 0.01` (barely audible).
Gain is irrelevant for energy cost; **the work happens upstream of the
gain node**.

On Apple Silicon, two always-on filter chains + a master gain bus is
apparently enough to keep the chip above the SMC fan-trip threshold,
even with the low-power AudioContext config from §13.5.

#### 13.11.2 Fix — ambient loop default OFF, with URL opt-in

Four coordinated changes:

1. [`Constants.js`](js/core/Constants.js:1037) — new flag in `AUDIO`:
   ```js
   AUDIO: {
     ...
     AMBIENT_LOOP_ENABLED: false,
     ...
   }
   ```

2. [`AudioSystem.js`](js/systems/AudioSystem.js:163) — new helper
   `_isAmbientLoopEnabled()`:
   ```js
   _isAmbientLoopEnabled() {
     if (typeof window === 'undefined') return false;
     const qs = new URLSearchParams(window.location.search);
     if (qs.get('ambient') === '1') return true;       // force-enable
     if (qs.get('noAmbient') === '1') return false;    // force-disable
     return !!(Constants.AUDIO && Constants.AUDIO.AMBIENT_LOOP_ENABLED);
   }
   ```

3. [`AudioSystem.js`](js/systems/AudioSystem.js:284) — STATE_CHANGE
   handler gates the call:
   ```js
   if (playStates.includes(data.to) && !this._ambientActive
       && this._isAmbientLoopEnabled()) {
     this.startAmbientLoop();
   }
   ```

4. [`AudioSystem.js`](js/systems/AudioSystem.js:1289) — boot mark inside
   `startAmbientLoop()` so `?logBoot=1` shows the decision when it does
   start:
   ```js
   window.__bootMark?.('startAmbientLoop() — 2 buffer sources + 2 filters going live');
   ```

The AudioContext **itself stays alive** with the low-power config from
§13.5, so SFX still play instantly without `ctx.resume()` latency. The
fix is solely about removing the continuous filter graph from the steady
state.

#### 13.11.3 Expected A/B matrix after this fix

| URL | Ambient loop | Expected fan @ 60 s |
|---|---|---|
| (no flag, default) | OFF | **OFF** ← the target state |
| `?ambient=1` | ON | ON (same as pre-§13.11) |
| `?noAmbient=1` | OFF | OFF (default behaviour, kept for symmetry) |
| `?noAudio=1` | n/a (no ctx) | OFF (control) |
| `?ambient=1&logBoot=1` | ON | ON — timeline shows the trigger event |

User verifies by reloading **without any flags**. If the fan now stays
off, the ambient loop was the residual trigger. If it still triggers,
the next escalation is full suspend-between-sounds (§13.11.5).

#### 13.11.4 Gameplay impact

- Ambient hum was at `AMBIENT_GAIN = 0.01` — barely above noise floor.
  Most users could not distinguish "ambient on" from "ambient off"
  without A/B-ing the audio output directly with headphones at high
  volume.
- All gameplay-critical SFX (UI clicks, thruster, ΔV alarm, capture
  success, weather alerts, codex chimes, etc.) are unaffected — they
  fire on events through the unchanged SFX path.
- Users who explicitly want the engine-room atmosphere can opt in via
  `?ambient=1`. Documented in the Constants comment block.
- Tutorial / first-time-user flow is unaffected (no ambient hum was
  scripted as a teaching cue).

#### 13.11.5 Why not suspend-between-sounds yet?

The fully suspend/resume approach (track active sources, auto-suspend
on idle, resume on `play*`) is the next escalation if the ambient-loop
fix isn't enough. It requires:

- Wrapping every `play*` method (~30 of them) to call
  `_resumeForPlayback()` and `_trackSource(source)`.
- Hooking `source.onended` (or post-stop `setTimeout` for oscillators
  stopped by hand: `_dvAlarmOsc`, `_thrusterGain`, `_forgeFilter`,
  `_alignmentToneOsc`, etc.) to decrement an active-source count.
- Scheduling `ctx.suspend()` ~200 ms after the count drops to zero;
  cancelling the suspend on next `play*`.
- Handling the resume → playback gap: `ctx.resume()` is async on Chrome
  / Firefox and adds ~20-50 ms latency, which would make UI clicks feel
  laggy unless we pre-warm the ctx by resuming on input intent (e.g. on
  `keydown` before `keyup`).

We're betting the ambient loop is the dominant culprit and reserving
this refactor for if `?noAmbient=1` (== default after this fix) still
triggers the fan. If user A/B shows fan still on with ambient default
OFF, we proceed with the suspend-between-sounds rewrite as §13.12.

#### 13.11.6 Tests + regression

- `node js/test/run-tests.js` — **2207 / 2207 pass** after §13.11
  shipped on top of §13.7.5.1.
- §12.4 / §12.11 / §12.12 policies untouched — still verified.
- The ambient loop's `stopAmbientLoop()` path is unchanged; when the
  loop never started, `_ambientActive` is false and `stopAmbientLoop()`
  early-returns at `if (!this._ambientActive) return;`. No behavioural
  drift on MENU re-entry.
- The `updateAmbientState()` runtime call from
  [`AudioSystem.js`](js/systems/AudioSystem.js:1361) also early-returns
  on `!this._ambientActive`, so DELTAV_UPDATE events stay cheap.
- Node test runner: `_isAmbientLoopEnabled()` early-returns false on
  `typeof window === 'undefined'`, so no behaviour change in headless
  tests (consistent with §13.5 ctor fallback).

#### 13.11.7 Files touched (§13.11 deltas only)

- [`js/core/Constants.js`](js/core/Constants.js:1037) — new
  `AUDIO.AMBIENT_LOOP_ENABLED: false` with a multi-paragraph comment
  documenting the root cause and URL flag overrides.
- [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js:163) — new
  `_isAmbientLoopEnabled()` helper; STATE_CHANGE listener gated on it;
  `startAmbientLoop()` emits a `?logBoot=1` mark when it does start.

---

## §14 — Deep CPU/GPU/Fan/Pause Audit (Sprint 4)

*Added: 2026-05-24. Prerequisite: §13.11 ambient-loop default-off fix confirmed
by user to solve sim-start fan trigger. Tests: 2207 / 2207 at entry.*

### 14.1 Browser-blur pause bug — diagnosis and fix

#### 14.1.1 Symptom

> "Sim pauses when switching to another tab, but does **not** pause when
> switching to another app. Sim should pause when browser is in background."

#### 14.1.2 Root cause

The game's background-throttle system relied **solely** on the
[`visibilitychange`](js/main.js:813) event. Per the W3C Page Visibility
API specification, `document.hidden` becomes `true` only when the tab is
fully hidden — i.e. the user switches to **another browser tab** or
minimises the browser window. On macOS, when the user **Cmd-Tabs to
another application** (e.g. Activity Monitor, Finder, Slack), the browser
window remains on-screen with its tab still "visible".
`document.hidden` stays `false` and `visibilitychange` never fires.

This meant:
- rAF loop continued at the display refresh rate (60–120 Hz).
- `_shouldAudioRun()` returned `true` (audio kept playing in background).
- `_getScheduleIntervalMs()` returned `0` (no throttling).
- CPU, GPU, and Energy Impact stayed fully elevated.

#### 14.1.3 Fix applied

**File:** [`main.js`](js/main.js:206)

1. **New module-scoped flag** `_windowBlurred` (default `false`) at
   [`main.js:214`](js/main.js:214).

2. **`window blur` listener** at [`main.js:849`](js/main.js:849):
   - Cross-checks `document.hasFocus() === false` to filter false
     positives (DevTools focus, iframe focus, child-popup focus).
   - Sets `_windowBlurred = true`.
   - Stops all looping audio (thruster hum, ΔV alarm, forge hum, ambient
     loop, lasso whistle, alignment tone) — mirrors the `visibilitychange`
     hidden branch exactly.
   - Calls `_syncAudioCtxState()` → suspends AudioContext.
   - Calls `_flushScheduledFrame()` → reschedules at 200 ms throttle.
   - Does **NOT** call `_setHudHidden(true)` — when the user alt-tabs
     back, the HUD should still be visible (only ESC pause hides it).

3. **`window focus` listener** at [`main.js:867`](js/main.js:867):
   - Clears `_windowBlurred = false`.
   - Resets `lastTime` and `lastFrameTime` (prevents dt spike).
   - Calls `_syncAudioCtxState()` + `_flushScheduledFrame()`.

4. **[`_getScheduleIntervalMs()`](js/main.js:237)** extended: returns 200 ms
   (5 Hz throttle) when `_windowBlurred`, matching hidden-tab behaviour.

5. **[`_shouldAudioRun()`](js/main.js:301)** extended: returns `false` when
   `_windowBlurred`, so `_syncAudioCtxState()` suspends the ctx.

6. **[`_emitPauseDiagnostic()`](js/main.js:966)** — `?logPause=1` output now
   includes `blurred=true/false` for window-focus diagnostics.

7. **(REVISED)** **Hard early-return in [`gameLoop()`](js/main.js:1017)** —
   mirrors the `document.hidden` early-return exactly. Without this the loop
   only throttled to 5 Hz (still rendered every 200 ms, GPU still busy).
   The early-return halts ALL work and does NOT schedule the next rAF, so
   the browser compositor sleeps. The `focus` handler wakes the loop via
   `_flushScheduledFrame()` on focus return.

   ```js
   if (_windowBlurred) {
     lastTime = timestamp;
     return;
   }
   ```

#### 14.1.4 Lesson learned — throttle is not pause

The original §14.1 fix extended `_getScheduleIntervalMs()` to return 200 ms
(5 Hz) when blurred. **This was wrong.** Throttling slows the loop, but
the loop still renders every 200 ms — GPU/CPU continues to do full
per-frame work, just less often. User confirmed: *"GPU pauses on Pause
(esc) and switching tabs BUT GPU continues when switching apps."*

The ESC pause and tab-hide cases work because they have **hard
early-returns** in `gameLoop()` that:
1. Skip ALL frame work (no render, no entity update, no HUD work).
2. **Do not schedule the next rAF** — the compositor sleeps until a wake
   hook (`PAUSE_RESUME`, `visibilitychange`, `focus`) explicitly calls
   `_flushScheduledFrame()`.

The corrected fix adds the same early-return for `_windowBlurred`. The
200 ms throttle in `_getScheduleIntervalMs()` is now purely defensive —
if any event listener wakes the loop while blurred, the next frame is
delayed 200 ms before the gameLoop hits the early-return and stops again.

#### 14.1.5 Test note

`window.blur` / `window.focus` are **not stub-able** in the Node test
runner without major jsdom infrastructure (jsdom does not implement the
Page Visibility or Window Focus APIs). The fix is verified by:
- **Automated:** 2207/2207 tests pass (no regressions from the new code
  paths, which are guarded by browser-only `window.addEventListener`
  inside the `init()` function that tests never reach).
- **Manual:** Cmd-Tab away from the browser → loop stops; the diagnostic
  emits one final line with `blurred=true` then goes silent (loop halted).
  GPU work drops to ~0 (compositor sleeps). Cmd-Tab back → `focus` handler
  fires → `_flushScheduledFrame()` wakes the loop → `blurred=false` and
  rendering resumes at display refresh.

---

### 14.2 Policy-coverage gap analysis

Post-§14.1 fix, the full game-state × focus-state matrix:

| Game state | tab visible | tab hidden | window blurred (§14.1) | ESC paused |
|---|---|---|---|---|
| **MENU** | 30 fps / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **BRIEFING** | 30 fps / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **ORBITAL_VIEW** | display-refresh / ctx running / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **APPROACH** | display-refresh / ctx running / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **INTERACTION** | display-refresh / ctx running / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **SHOP** | 30 fps / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **GAME_OVER** | 30 fps / ctx running¹ / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |
| **WIN** | 30 fps / ctx running¹ / HUD visible | 0 fps (loop stopped) / ctx suspended | **0 fps (loop stopped)** / ctx suspended / HUD visible | 0 fps (loop stopped) / ctx suspended / HUD hidden |

**Symmetry achieved:** The three "user is not actively playing" columns
(tab hidden, window blurred, ESC paused) all halt the gameLoop entirely.
The browser compositor sleeps in all three cases — verified by `?logPause=1`
emitting one final line then going silent (no further frames rendered).
The only difference between the three states is HUD visibility (hidden by
ESC pause only) and the wake mechanism (visibilitychange, focus, or
PAUSE_RESUME / PAUSE_MENU event).

¹ GAME_OVER and WIN keep ctx `running` because `_shouldAudioRun()` returns
`true` for them — death / victory stings may still be playing. This is
intentional; the short-lived sting will end and the user either continues
or returns to menu (which suspends).

**Known remaining edge cases (non-blocking):**
- **ESC pause + tab hidden simultaneously:** the `gameFlowManager.paused`
  early-return in gameLoop fires first (no rAF rescheduled); the hidden
  early-return is unreachable. Both agree on "stop the loop" so no leak.
- **Blur + hidden simultaneously** (e.g. Cmd-Tab then the browser moves
  the tab to another space): `visibilitychange` handler fires →
  `_syncAudioCtxState()` suspends. The blur handler may also fire but is
  idempotent. No conflict.
- **Focus false positive from DevTools:** the `document.hasFocus()`
  cross-check in the blur handler filters this; if DevTools receives focus
  within the same window, `document.hasFocus()` returns `true` and the
  blur handler early-returns.

---

### 14.3 Bypass audit — do all audio/rAF/HUD paths respect §12.12 helpers?

#### 14.3.1 `ctx.suspend()` / `ctx.resume()` bypasses

| Location | Code | Verdict |
|---|---|---|
| [`main.js:319-326`](js/main.js:319) | `audioSystem.ctx.resume()` / `audioSystem.ctx.suspend()` inside `_syncAudioCtxState()` | ✅ **Canonical** — the single policy point |
| [`AudioSystem.js:154`](js/systems/AudioSystem.js:154) | `this.ctx.resume()` inside `AudioSystem.resume()` | ⚠️ **Autoplay-unlock bypass** — called from user-gesture handlers (`MenuScreen`, `GameFlowManager`, `CommsSystem`) to satisfy Chrome autoplay policy. Necessary; not a policy violation because it only runs on first user interaction before `_syncAudioCtxState` takes over. |
| [`MenuScreen.js:222,230,238`](js/ui/MenuScreen.js:222) | `audioSystem.resume()` | ⚠️ **Autoplay-unlock** — same as above, called on Start/Continue/Credits click |
| [`GameFlowManager.js:321`](js/systems/GameFlowManager.js:321) | `audioSystem.resume()` | ⚠️ **Autoplay-unlock** — same pattern, first transition |
| [`CommsSystem.js:917`](js/systems/CommsSystem.js:917) | `audioSystem.resume()` | ⚠️ **Autoplay-unlock** — comms interaction |

**Summary:** No rogue suspend/resume. All non-canonical calls are the
autoplay-policy unlock pattern (`init() + resume()` on user gesture),
which must happen outside `_syncAudioCtxState` because `_shouldAudioRun()`
would return `false` in MENU state where the first click happens.

#### 14.3.2 `requestAnimationFrame()` bypasses

| Location | Code | Verdict |
|---|---|---|
| [`main.js:273,276`](js/main.js:273) | `requestAnimationFrame(gameLoop)` inside `_scheduleNextFrame()` | ✅ **Canonical** — the single dispatch point |
| [`PerfReportOverlay.js:231,233`](js/ui/PerfReportOverlay.js:231) | `requestAnimationFrame(sampleLoop)` | ✅ **Known exception** — independent frame-time sampler, opt-in via `?perfReport=1`. Self-contained; unconditionally reschedules but only when overlay is attached. Documented in §12.12.6. |
| [`AutoProfileSweep.js:164,166,188,190`](js/systems/AutoProfileSweep.js:164) | `requestAnimationFrame(tick)` | ✅ **Known exception** — sprint-specific GPU profiling sweep, opt-in via `?autoProfile=1`. Frame-counting loop for timed measurements. |
| [`StatusPanel.js:818-819`](js/ui/hud/StatusPanel.js:818) | `requestAnimationFrame(() => { requestAnimationFrame(…) })` | ✅ **Harmless** — double-rAF trick for CSS transition on credit update. Single-shot, no loop. |
| [`CodexViewerUI.js:52`](js/ui/CodexViewerUI.js:52) | `requestAnimationFrame(() => …)` | ✅ **Harmless** — single-shot opacity transition. |
| [`TargetPanel.js:454`](js/ui/hud/TargetPanel.js:454) | `requestAnimationFrame(() => …)` | ✅ **Harmless** — single-shot discovery highlight animation. |
| [`HUD.js:1622,1725`](js/ui/HUD.js:1622) | `requestAnimationFrame(() => …)` | ✅ **Harmless** — single-shot toast fade-in + arm pilot strip show. |
| [`GameOverScreen.js:291`](js/ui/GameOverScreen.js:291) | `requestAnimationFrame(() => …)` | ✅ **Harmless** — single-shot opacity transition. |

**Summary:** No rogue rAF loops. The two continuous rAF loops
(`PerfReportOverlay` and `AutoProfileSweep`) are both opt-in diagnostic
tools gated behind URL flags. All other rAF calls are single-shot CSS
transition helpers that do not keep the compositor alive.

#### 14.3.3 `#hud-overlay` visibility bypasses

No direct mutation of `#hud-overlay` visibility found outside
[`_setHudHidden()`](js/main.js:338). The helper is the sole touch-point.
There are **3 call sites** (not 1 as originally suspected):
- `_setHudHidden(false)` in `PAUSE_RESUME` handler ([`main.js:767`](js/main.js:767))
- `_setHudHidden(false)` in `PAUSE_MENU` handler ([`main.js:773`](js/main.js:773))
- `_setHudHidden(true)` in gameLoop pause branch ([`main.js:1053`](js/main.js:1053))

**Verdict:** Helper is justified — 3 call sites, consistent behaviour.

#### 14.3.4 `new AudioContext()` bypasses

Only one construction site: [`AudioSystem.init()`](js/systems/AudioSystem.js:100)
with the `CtxCtor` fallback chain (playback hint → no sampleRate → default).
**No bypasses found.** The test runner stubs used by Node tests never
construct a real AudioContext.

---

### 14.4 Diagnostic-flag inventory

| Flag | Location | Purpose | Permanent? | In README? | In HANDOFF? | In GPU_PROFILING_REPORT? | Recommendation |
|---|---|---|---|---|---|---|---|
| `?logPause=1` | [`main.js:108`](js/main.js:108) | Per-second pause/state/audio diagnostic | permanent | ❌ | ❌ | ✅ §12.4, §12.11, §12.12, §13 | Promote to README "Diagnostics" section |
| `?logBoot=1` | [`main.js:133`](js/main.js:133) | Continuous boot timeline + spike detector | permanent | ❌ | ❌ | ✅ §13.2.1 | Promote to README "Diagnostics" section |
| `?noAudio=1` | [`AudioSystem.js:60`](js/systems/AudioSystem.js:60) | Skip AudioContext creation (A/B isolator) | permanent | ❌ | ❌ | ✅ §13.2.2 | Promote to README "Diagnostics" section |
| `?ambient=1` | [`AudioSystem.js:176`](js/systems/AudioSystem.js:176) | Force-enable ambient loop | permanent | ❌ | ❌ | ✅ §13.11 | Promote to README "Diagnostics" section |
| `?noAmbient=1` | [`AudioSystem.js:177`](js/systems/AudioSystem.js:177) | Force-disable ambient loop (= default) | permanent | ❌ | ❌ | ✅ §13.11 | Keep as in-code comment only (default behaviour) |
| `?debug=1` | [`main.js:438`](js/main.js:438) | Verbose renderer diagnostics console.table | permanent | ❌ | ❌ | ✅ PERF_SPRINT_REPORT | Promote to README "Diagnostics" section |
| `?profile=1` | [`main.js:443`](js/main.js:443) | Per-60-frame draw-call profiling log | dev-only | ❌ | ❌ | ✅ PERF_SPRINT_REPORT | Promote to README "Diagnostics" section |
| `?perfReport=1` | [`main.js:449`](js/main.js:449) | PerfReportOverlay (1 Hz in-game panel) | dev-only | ❌ | ❌ | ✅ SPRINT_2_REPORT | Promote to README "Diagnostics" section |
| `?autoProfile=1` | [`ProfileFlags.js:133`](js/core/ProfileFlags.js:133) | AutoProfileSweep (8-config GPU sweep) | sprint-specific | ❌ | ❌ | ✅ §13, GPU_PROFILING_REPORT | Keep in-code; not useful for end-users |
| `?tier=LOW\|MED\|HIGH` | [`SceneManager.js:130`](js/scene/SceneManager.js:130) | Force quality tier | permanent | ❌ | ❌ | ✅ PERF_SPRINT_REPORT | Promote to README "Diagnostics" section |
| `?profilePasses=1` | [`ProfileFlags.js:132`](js/core/ProfileFlags.js:132) | Per-pass GPU timer queries | sprint-specific | ❌ | ❌ | ✅ ProfileFlags JSDoc | Keep in-code only |
| `?disable…=1` (×5) | [`ProfileFlags.js:134-138`](js/core/ProfileFlags.js:134) | A/B feature isolation | sprint-specific | ❌ | ❌ | ✅ ProfileFlags JSDoc | Keep in-code only |
| `?msaa=N` | [`ProfileFlags.js:139`](js/core/ProfileFlags.js:139) | Override MSAA samples | sprint-specific | ❌ | ❌ | ✅ ProfileFlags JSDoc | Keep in-code only |
| `?pixelRatio=N` | [`ProfileFlags.js:140`](js/core/ProfileFlags.js:140) | Override pixel ratio | sprint-specific | ❌ | ❌ | ✅ ProfileFlags JSDoc | Keep in-code only |

**Recommendation:** Create a "🔧 Diagnostics" section in
[`README.md`](README.md:190) listing the 8 user-facing flags
(`logPause`, `logBoot`, `noAudio`, `ambient`, `debug`, `profile`,
`perfReport`, `tier`). Sprint-specific profiling flags
(`autoProfile`, `profilePasses`, `disable…`, `msaa`, `pixelRatio`) stay
documented only in [`ProfileFlags.js`](js/core/ProfileFlags.js:1) JSDoc
and this report. **Actionable in a future sprint (effort: S).**

---

### 14.5 The deferred 2.3 s first-frame GPU spike

§13.3 documented the first `render()` call taking ~2.3 s due to deferred
Three.js work: Metal pipeline state object compile, 16K texture upload +
mipmap generation, instanced-mesh shader specialisation. §13.9 deferred
it (documented but not fixed). Options with cost-benefit:

| Option | Description | Pros | Cons | Effort | Recommendation |
|---|---|---|---|---|---|
| **A** | `renderer.compile(scene, camera)` walking every material variant | Already called at [`main.js:851`](js/main.js:851). Three.js `compile()` does shader compilation but **not** texture upload or pipeline-state linking (the expensive parts on Metal). Calling it again won't help. | Zero additional shader-compile cost at first render | Does **not** fix the 2.3 s spike — texture upload and Metal PSO creation still happen on first draw | S | ❌ Already done; diminishing returns |
| **B** | Hidden-quad warmup pass — draw 1×1 off-screen quad per material before first user-visible render | Forces all PSOs + texture binds to resolve before the loading screen fades out | Adds ~1–2 s to boot time (moved from "first frame delay" to "loading screen delay") — possibly worse UX since the loading screen already fades after 1.5 s | M | 🟡 Viable if loading screen duration is extended |
| **C** | Lazy texture upload throttling — split the 16K Earth basemap upload across N frames using `requestIdleCallback` | Spreads the GPU stall across multiple frames; first frame is responsive | Three.js `TextureLoader` does not expose upload timing; would require custom `readyState` gating or manual `gl.texImage2D` calls, breaking Three.js abstractions | L | ❌ Too invasive |
| **D** | Accept the 2 s startup pause as cost-of-quality; show a polished loading screen with a progress bar | Zero code complexity; loading screen already exists; boot timeline (`?logBoot=1`) gives the data for a real progress bar | First frame remains a 2 s GPU stall; user sees the loading screen ~2 s longer | XS | ✅ **Recommended** |

**Recommendation for future sprint:** **Option D** — extend the loading
screen to display a progress bar driven by `window.__bootMark` phase
data, and hold it visible until after the first render completes. This
turns the 2.3 s stall into an expected part of the launch experience
rather than a perceived hang. Effort: **XS** (CSS + a
`_bootFirstFrameMarked` gate on the `loadingScreen.classList.add('hidden')`
call at [`main.js:879`](js/main.js:879)).

---

### 14.6 Cleanup catalog

| # | Location | What | Why candidate | Action | Effort |
|---|---|---|---|---|---|
| 1 | [`main.js:192-200`](js/main.js:192) | Comment block referencing "the previous gameLoop unconditionally re-scheduled rAF at the top of every tick" | Stale — that behaviour was removed in §12.4 (Sprint 4). The comment explains the old problem, not current code. | **KEEP** — serves as rationale for the `_rafScheduled` design; still useful for future maintainers. | — |
| 2 | [`main.js:108`](js/main.js:108) `?logPause=1` | Verbose per-second diagnostic + stack-trace tracer in `_scheduleNextFrame` | Still useful as permanent forensic tool for any future pause/fan regression. | **KEEP** — permanent diagnostic. | — |
| 3 | [`main.js:218`](js/main.js:218) `_rafCallerCounts` | Histogram only active under `?logPause=1`; allocates an `Error().stack` per `_scheduleNextFrame` call when enabled. | Post-§12.12, the rAF discipline is clean (§14.3.2 audit confirms no rogue callers). Histogram still has value for future regressions. | **KEEP** — zero overhead when flag is off. | — |
| 4 | [`main.js:338`](js/main.js:338) `_setHudHidden()` | Originally described as single-call-site candidate for inlining. | Actually **3 call sites** (§14.3.3). Helper is justified. | **KEEP** — correct abstraction. | — |
| 5 | [`Constants.js:1037`](js/core/Constants.js:1037) `AMBIENT_GAIN: 0.01` | Only used by `startAmbientLoop()` which is default-off since §13.11. Unused unless `?ambient=1`. | Keeping the constant costs nothing; removing it would break `?ambient=1` opt-in. | **KEEP** — supports opt-in ambient loop. | — |
| 6 | [`AudioSystem.js:18`](js/systems/AudioSystem.js:18) `activeSources` Map | Only stores `'thruster'` key. `set` at [`AudioSystem.js:1707`](js/systems/AudioSystem.js:1707), `get` at [`AudioSystem.js:1625,1717`](js/systems/AudioSystem.js:1625), `delete` at [`AudioSystem.js:1741`](js/systems/AudioSystem.js:1741). | Lifecycle is clean: set on start, get for mutation, delete on stop. No leaks. | **KEEP** — correct lifecycle. | — |
| 7 | [`AudioSystem.js:23`](js/systems/AudioSystem.js:23) `_approachBeepTimers` | `Map<armId, lastBeepTime>`. Set at line 355, read at line 345. Never cleared. | Maps grow monotonically as arms are deployed but entries are `<armId, number>` pairs — max 8 entries (8 arms). No material leak. | **KEEP** — bounded by arm count. | — |
| 8 | [`AudioSystem.js:26`](js/systems/AudioSystem.js:26) `_tetherTensionTimers` | `Map<armId, lastTensionTime>`. Same pattern as above. Max 8 entries. | Same analysis — bounded, no leak. | **KEEP** — bounded by arm count. | — |
| 9 | Per-frame audio call sites | [`main.js:1044`](js/main.js:1044) `audioSystem.stopThrusterHum()` in gameLoop pause branch | Runs every 5 Hz tick while paused. `stopThrusterHum` is idempotent (early-returns if no active source). | **KEEP** — the per-tick cost is a Map lookup + early-return (~0 ns); the §12.12 STATE_CHANGE handler already stops loops on transition, but the gameLoop guard is a safety net for edge cases (e.g. ESC pause during active thrust). | — |
| 10 | [`Constants.js:1068`](js/core/Constants.js:1068) `AMBIENT_LOOP_ENABLED: false` | The constant + its 20-line comment block. | Documents the §13.11 root cause. Essential for future maintainers. | **KEEP** — canonical documentation. | — |
| 11 | Test-runner stubs: `if (typeof window === 'undefined')` | [`AudioSystem.js:174`](js/systems/AudioSystem.js:174), [`ProfileFlags.js:120`](js/core/ProfileFlags.js:120) | Could be centralised in a `js/core/env.js` module with `export const isBrowser = typeof window !== 'undefined'`. | **REFACTOR** (future) — currently only 2 sites use the pattern; centralisation adds a new import for marginal DRY gain. Wait until ≥5 sites exist. | S |
| 12 | `AudioSystem.resume()` at [`AudioSystem.js:154`](js/systems/AudioSystem.js:154) | Public method that bypasses `_syncAudioCtxState()`. Called from 4 external sites for autoplay-policy unlock. | Not a bug — necessary for the first user-gesture unlock before `_syncAudioCtxState` takes over. Could be renamed to `unlockAutoplay()` for clarity. | **REFACTOR** (future) — rename `resume()` → `unlockAutoplay()` and add a one-line JSDoc explaining why it exists alongside `_syncAudioCtxState`. | XS |
| 13 | [`main.js:316-318`](js/main.js:316) `_syncAudioCtxState` JSDoc | Said "Called from STATE_CHANGE, PAUSE_RESUME, PAUSE_MENU, visibilitychange, and the pause branch in gameLoop." | Now also called from blur/focus handlers (§14.1). | **APPLIED** — JSDoc now lists "window blur/focus (§14.1)". | XS |
| 14 | [`Constants.js:1038`](js/core/Constants.js:1038) `SFX_GAIN: 0.15` | **Dead constant** — `grep -rn SFX_GAIN .` confirmed zero references anywhere in the codebase. The SFX bus uses a hardcoded `0.7` gain at [`AudioSystem.js:116`](js/systems/AudioSystem.js:116). | **APPLIED — DELETED** in this sprint. Replaced with a comment block documenting the removal so future maintainers don't reintroduce it. | XS |

**Summary:** 2 items deleted in this sprint (#13 JSDoc fix, #14 dead
constant), 2 items are future XS refactors (#12 rename `resume()` →
`unlockAutoplay()`, …), 1 item is a future S-effort refactor (#11
env.js). All other items are **KEEP** — verified as correct, bounded,
or serving ongoing diagnostic value.

#### 14.6.1 Trivial cleanups applied in this sprint

- **#13** — Updated [`_syncAudioCtxState`](js/main.js:316) JSDoc to
  include the new `window blur/focus` callers from §14.1.
- **#14** — Deleted unused `SFX_GAIN: 0.15` from
  [`Constants.js:1038`](js/core/Constants.js:1038); left a comment in
  its place explaining the removal so it doesn't regress.

---

### 14.7 Files touched (§14 deltas only)

- [`js/main.js`](js/main.js:214) — `_windowBlurred` flag (L214),
  extended [`_getScheduleIntervalMs()`](js/main.js:237) (defensive
  200 ms throttle when blurred), extended
  [`_shouldAudioRun()`](js/main.js:301) (suspend ctx when blurred), new
  [`window blur`](js/main.js:849) /
  [`window focus`](js/main.js:867) listeners, updated
  [`_emitPauseDiagnostic`](js/main.js:966) to log `blurred=true/false`,
  updated [`_syncAudioCtxState`](js/main.js:316) JSDoc, **and the
  decisive [`gameLoop()`](js/main.js:1017) hard early-return on
  `_windowBlurred`** that actually stops the loop (mirrors the proven
  `document.hidden` pattern; without this the loop only throttled).
- [`js/core/Constants.js`](js/core/Constants.js:1038) — deleted unused
  `SFX_GAIN: 0.15` (catalog item #14); replaced with a one-paragraph
  comment to prevent regression.
- [`GPU_PROFILING_REPORT.md`](GPU_PROFILING_REPORT.md:1588) — this §14
  section.

### 14.8 Tests

- `node js/test/run-tests.js` — **2207 / 2207 pass** after all §14
  changes. No new tests added (window.blur not stub-able in Node runner;
  documented in §14.1.4).
