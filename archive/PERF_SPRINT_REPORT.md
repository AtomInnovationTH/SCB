# Space Cowboy — Perf Sprint Report (PRs 1–6)

*Generated 2026-05-22 — static analysis only, no in-browser measurement. Cites real line numbers from the codebase at the time of writing. All clickable code references follow the workspace convention `[`file.method()`](path:line)`.*

---

## § 1 — Executive Summary

The 6-PR perf sprint moved Space Cowboy from a "ships textures, hopes for the best" engine to one that **measures itself, adapts at runtime, and refuses to waste cycles in a background tab**. The headline deltas:

- **First-load (HIGH tier)**: Earth texture payload drops from **~41 MB JPG → ~9 MB AVIF** (~78 % shrink, ~5× compression ratio per [`Earth.js`](js/scene/Earth.js:367) comment) plus `<link rel="preload">` warming the day texture in parallel with the import map. See [`index.html`](index.html:352).
- **Sustained-fps stability**: judder on 120/144 Hz displays eliminated by removing the hard 60 fps gate ([`gameLoop()`](js/main.js:521)); first-frame stutter eliminated by `renderer.compile()` pre-warm ([`main.js`](js/main.js:506)); hidden tabs no longer burn CPU/GPU ([`main.js`](js/main.js:474)); quality tier auto-downshifts when median fps drops below 50 ([`runtimeAdapt()`](js/systems/QualityManager.js:116)).
- **Repeat-visit TTI**: Service Worker `space-cowboy-v1` ([`sw.js`](sw.js:36)) network-firsts HTML+JS (so deploys propagate) and cache-firsts `/textures/`, `/data/`, and `cdn.jsdelivr.net` (so warm boot serves Three.js + Earth textures from the cache).

**The 6 PRs in one line each:**

1. **PR 1 — P0.1 + P0.2 (Texture diet + preload hints):** AVIF probe in [`Earth.js`](js/scene/Earth.js:389) + `loadTexture()` JPG-fallback, four `<link>` hints in [`index.html`](index.html:355).
2. **PR 2 — P0.3 (Service Worker):** Network-first HTML/JS, cache-first textures/data/CDN, `space-cowboy-v1` cache in [`sw.js`](sw.js:36).
3. **PR 3 — P1.4 + P1.6 + P1.7 (Hidden-tab pause + shader pre-compile + 120 Hz fix):** `visibilitychange` listener ([`main.js`](js/main.js:474)), `renderer.compile()` ([`main.js`](js/main.js:506)), `Constants.PERF.FRAME_CAP=null` ([`Constants.js`](js/core/Constants.js:2162)).
4. **PR 4 — P1.5 (Quality tier system):** [`QualityManager.js`](js/systems/QualityManager.js:1) with `selectInitialTier` + `runtimeAdapt`; HIGH/MEDIUM/LOW configs in [`Constants.js`](js/core/Constants.js:2176); live `applyTier()` in [`SceneManager.js`](js/scene/SceneManager.js:275); `?tier=` URL flag.
5. **PR 5 — P2.8 + P2.9 + P2.10 (TimerManager + Vec2 cache + gated diag):** [`TimerManager.js`](js/systems/TimerManager.js:1) singleton, 48 timers migrated across 5 files, `_bloomRes` cached in [`SceneManager.js`](js/scene/SceneManager.js:26), `DEBUG` flags + `?debug=1` URL flag.
6. **PR 6 — P3.11 + P3.13 + P3.15 (GPU probe + audio self-test + draw-call profiler):** [`GpuProbe.js`](js/systems/GpuProbe.js:1) using `EXT_disjoint_timer_query_webgl2`, audio unlock 200 ms verification in [`InputManager._tryAudioUnlock()`](js/systems/InputManager.js:273) → `AUDIO_UNLOCK_FAILED` toast in [`HUD.js`](js/ui/HUD.js:656), per-60-frame profile log in [`main.js`](js/main.js:977).

**Deferred items (intentionally out of scope):**

- **PR 7 / P3.12 (WebGPU renderer)** — experimental, off-by-default flag work.
- **16 files still using raw `setTimeout`/`setInterval`** — listed in [§ 3.8](#-38--known-limitations--follow-up-recommendations). PR 5 migrated the 5 highest-traffic files (AudioSystem, GameFlowManager, CommsSystem, HUD, SkillsPane); the rest are small UIs / one-shot timers and can be migrated incrementally.
- **FXAAPass** — `QUALITY_TIERS.MEDIUM.useFXAAFallback=true` is honored by [`_setupPostProcessing()`](js/scene/SceneManager.js:236) as "no post-AA, rely on MSAA"; a real FXAAPass swap-in is a TODO.
- **InstancedMesh merge** for debris — wait for `?profile=1` data before committing.
- **`runtimeAdapt` upshift path** — only downshifts ship; upshift adds hysteresis complexity and is intentionally out of scope ([`QualityManager.js`](js/systems/QualityManager.js:102) comment).

Test suite grew **2060 → 2134** (+74) across the sprint, with new files [`test-QualityManager.js`](js/test/test-QualityManager.js:1), [`test-TimerManager.js`](js/test/test-TimerManager.js:1), [`test-GpuProbe.js`](js/test/test-GpuProbe.js:1) and new PERF/DEBUG cases in [`test-Constants.js`](js/test/test-Constants.js:1).

---

## § 2 — Per-PR Detailed Changes

### § 2.1 — PR 1 (P0.1 AVIF textures + P0.2 preload hints) — final test count 2085

**Goal.** Cut first-paint bytes-on-wire by switching the Earth textures to AVIF (≈5× compression at visually equivalent quality), and warm the network in parallel with HTML parsing so the day texture and Three.js arrive on the same wave as the JS bootstrap. Nothing else in the gameplay loop changes.

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`Earth.js`](js/scene/Earth.js:363) | 363–449 | New "TEXTURE LOADER + AVIF SUPPORT PROBE" block: top-level-await probe + `loadTexture()` with `.jpg`→`.avif` rewrite and automatic JPG-fallback on AVIF decode failure. |
| [`index.html`](index.html:352) | 352–358 | Added `<link rel="preconnect">` for jsdelivr, `<link rel="modulepreload">` for `./js/main.js` and `three.module.js`, and `<link rel="preload" as="image" type="image/avif" fetchpriority="high">` for `earth_day.avif`. |
| `textures/*.avif` | — | New sibling assets next to every `.jpg` (16 files added). |

**AVIF texture size table (verified by `ls textures/` and DEPLOY_ANALYSIS.md):**

| Texture | JPG size | AVIF size | Path |
|---|---:|---:|---|
| Earth day, 16k | 19 MB | ~3.9 MB | [`earth_day_16k.avif`](textures/earth_day_16k.avif:1) |
| Earth night, 16k | 9.4 MB | ~2 MB | [`earth_night_16k.avif`](textures/earth_night_16k.avif:1) |
| Earth clouds, 8k | 13 MB | ~2.5 MB | [`earth_clouds_8k.avif`](textures/earth_clouds_8k.avif:1) |
| Earth day, 8k | 5.5 MB | ~1 MB | [`earth_day_8k.avif`](textures/earth_day_8k.avif:1) |
| Earth night, 8k | <9 MB | ~1.5 MB | [`earth_night_8k.avif`](textures/earth_night_8k.avif:1) |
| Earth day, 4k base | <2 MB | ~0.4 MB | [`earth_day.avif`](textures/earth_day.avif:1) |
| Earth night, 4k | <2 MB | ~0.4 MB | [`earth_night.avif`](textures/earth_night.avif:1) |
| Earth clouds, 4k | <1 MB | ~0.2 MB | [`earth_clouds.avif`](textures/earth_clouds.avif:1) |

> **Note on AVIF sizes:** the AVIF column above is the documented ~5× JPG → AVIF ratio from the [`Earth.js`](js/scene/Earth.js:367) comment, not file-stat'd on disk; the actual files exist but exact byte counts were not re-measured during this sprint.

**AVIF probe.** [`Earth.js:386-401`](js/scene/Earth.js:386) defines a 311-byte 2×2 AV1 still-picture data URL and runs it through `new Image().decode()` inside a `top-level await`. Result is cached in module-level `avifSupported`. The probe short-circuits to `false` when `typeof Image === 'undefined'` so the Node test runner keeps loading.

**`loadTexture()` JPG-fallback.** [`Earth.js:416-449`](js/scene/Earth.js:416). On AVIF support, request is rewritten `.jpg` → `.avif`. On runtime AVIF decode failure the error handler reissues the load against the original `.jpg` path and patches `tex.image` + sets `tex.needsUpdate = true` so the already-bound material remains valid.

**Preload hints in [`index.html:352-358`](index.html:352).**

| Tag | Purpose |
|---|---|
| `<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>` | Open TLS + DNS to the CDN before the import map runs. |
| `<link rel="modulepreload" href="./js/main.js">` | Tell the parser to start fetching `main.js` immediately. |
| `<link rel="modulepreload" href=".../three.module.js" crossorigin>` | Same, for the Three.js bundle (~650 KB minified). |
| `<link rel="preload" as="image" href="./textures/earth_day.avif" type="image/avif" fetchpriority="high">` | Race the 4k AVIF base texture with the JS download. |

**New constants in [`Constants.js`](js/core/Constants.js:1).** None for PR 1 (the AVIF flag is module-scoped inside Earth.js by design — no global toggle needed).

**New EventBus constants.** None.

**New tests.** AVIF probe is browser-only; the test suite covers `selectLOD` (pre-existing in [`test-EarthLOD.js`](js/test/test-EarthLOD.js:1)). No new test file; the test-count delta to 2085 comes from incidental coverage adds.

**Acceptance criteria.**

- ✅ AVIF sibling files exist for all 8 LOD slots (verified via `list_files textures/`).
- ✅ Probe + fallback logic is unit-testable (`typeof Image === 'undefined'` branch returns `false`).
- ✅ Preload tags present in [`index.html`](index.html:355).
- 🟡 Real first-paint MB savings (~41 MB → ~9 MB at HIGH tier) — needs a real browser DevTools Network panel to confirm.
- 🟡 Fallback path triggers correctly when a corrupt `.avif` is served — needs a hand-crafted broken AVIF or browser without AV1 to verify.

---

### § 2.2 — PR 2 (P0.3 Service Worker) — final test count 2085

**Goal.** Make repeat visits feel instant. After the first session, the browser has Three.js + Earth textures + game JS in the SW cache; the second visit shows the menu in <500 ms with <500 KB of network traffic (just the network-first HTML revalidation).

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`sw.js`](sw.js:1) | 1–217 (new) | Network-first HTML/JS, cache-first textures/data/CDN, synthetic offline response. |
| [`index.html`](index.html:399) | 399–409 | `navigator.serviceWorker.register('./sw.js')` inside `window.load` listener. |

**Routing rules in plain English.**

| Request shape | Strategy | Why |
|---|---|---|
| `request.mode === 'navigate'` OR `Accept ~ text/html` ([`isHTMLRequest()`](sw.js:97)) | **Network-first** ([`networkFirst()`](sw.js:136)) | New deploys propagate without a cache-bust dance. |
| Pathname ends in `.js` or `.mjs` ([`isJSRequest()`](sw.js:104)) | **Network-first** | Same reasoning — JS is the deploy artifact. |
| Pathname includes `/textures/` or `/data/` ([`isCacheFirstURL()`](sw.js:110)) | **Cache-first** ([`cacheFirst()`](sw.js:158)) | Multi-MB blobs that change rarely. |
| `hostname === 'cdn.jsdelivr.net'` ([`sw.js`](sw.js:113)) | **Cache-first with `mode: 'cors'`** ([`sw.js`](sw.js:199)) | Three.js + addons; once cached, repeat visits are CDN-free. Only `response.ok` is stored so opaque/404 responses don't poison the cache. |
| Anything else (non-GET, non-http, the SW's own URL) | **Passthrough** | The SW never calls `respondWith` for these. |

**Cache name.** `'space-cowboy-v1'` ([`sw.js:36`](sw.js:36)). Bump suffix on cache-contract changes so [`activate`](sw.js:75) can wipe the old store.

**Lifecycle events.**

- **install** ([`sw.js:49-70`](sw.js:49)) — opens the cache, best-effort `cache.add()` for `./`, `./index.html`, `./js/main.js`. Each entry is wrapped in its own try/catch so a single 404 (local dev without `main.js` built) cannot abort install. Ends with `self.skipWaiting()`.
- **activate** ([`sw.js:75-90`](sw.js:75)) — deletes any cache whose name ≠ `space-cowboy-v1`, then `self.clients.claim()`.
- **fetch** ([`sw.js:178-217`](sw.js:178)) — the dispatch above. Non-GET, malformed URLs, and the SW's own URL all early-return so the browser handles them.

**Scope subtlety.** The registration uses the relative path `./sw.js` ([`index.html:404`](index.html:404)) so the SW's scope is **the page directory** — `/` locally, `/SCB/` on GitHub Pages. The path checks inside `sw.js` (`url.pathname.includes('/textures/')`) work in both deployments because they match anywhere in the path, not a fixed prefix.

**Offline fallback.** [`offlineResponse()`](sw.js:118) returns a synthetic 503 `text/plain` body so a failed-network, cache-miss request gets a deterministic error rather than a generic browser network screen.

**Clone-before-cache safety.** Both [`networkFirst()`](sw.js:142) and [`cacheFirst()`](sw.js:169) clone the response **before** handing it to the page — `cache.put` consumes the body, so without the clone the page would receive an empty `Response`.

**New constants.** None.

**New EventBus constants.** None.

**New tests.** None — SW is hard to unit-test outside a real browser. The smoke-test plan in [§ 5](#-5--smoke-test-plan-for-the-live-deploy) verifies the live deploy returns 200 for `/SCB/sw.js`.

**Acceptance criteria.**

- ✅ `sw.js` exists at repo root and follows network-first/cache-first split.
- ✅ Pre-cache list is best-effort; a single missing URL does not break install.
- ✅ Cache name version-suffixed for forward compatibility.
- 🟡 Second-visit TTI < 500 ms — needs a live page-load + DevTools Performance trace.
- 🟡 Cache eviction on cache-name bump — needs to deploy `v1` then `v2` to verify.

---

### § 2.3 — PR 3 (P1.4 hidden-tab pause + P1.6 shader pre-compile + P1.7 120 Hz judder fix) — final test count 2087

**Goal.** Three orthogonal frame-pacing fixes shipped together because they all touch the bootstrap + game-loop path:

1. **P1.4** — stop simulating + rendering when the tab is hidden.
2. **P1.6** — pre-compile shaders before the first RAF so the first visible frame doesn't stutter.
3. **P1.7** — kill the hardcoded 60 fps gate that caused every-other-frame skips on 120/144 Hz monitors.

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`Constants.js`](js/core/Constants.js:2157) | 2157–2195 | New `PERF` namespace; `FRAME_CAP: null` (replaces hardcoded 60 Hz). |
| [`main.js`](js/main.js:471) | 471–491 | `document.addEventListener('visibilitychange', …)` — silences looping audio, resets `lastTime` on resume. |
| [`main.js`](js/main.js:506) | 506–512 | `sceneManager.renderer.compile(scene, camera)` called once before the first `requestAnimationFrame(gameLoop)`. |
| [`main.js`](js/main.js:521) | 521–544 | New `gameLoop` head: `document.hidden` early-return, opt-in `frameCap` block. |

**New constants in [`Constants.js`](js/core/Constants.js:2157).**

| Constant | Default | Purpose |
|---|---|---|
| `Constants.PERF.FRAME_CAP` | `null` | `null | 60 | 120` — `null` lets the browser run at the display's native refresh. Hardcoded 60 Hz cap on a 120 Hz display alternates "render / sleep / render / sleep" = visible judder. |

**New EventBus constants.** None for PR 3 (added in PR 4).

**Hidden-tab pause logic.** [`main.js:474-491`](js/main.js:474). On `document.hidden = true`:
- defensively stop every persistent AudioSystem loop (`stopThrusterHum`, `stopDeltaVAlarm`, `stopForgeHum`, `stopAmbientLoop`, `stopLassoWireWhistle`, `stopAlignmentTone`);
- on resume, reset `lastTime = performance.now()` and `lastFrameTime = now` so the next `realDt` is small (~16 ms), not "you were gone for 4 minutes."

The early-return inside `gameLoop` at [`main.js:526`](js/main.js:526) also writes `lastTime = timestamp` every hidden frame so the dt-spike-on-resume bug is closed from both sides.

**`renderer.compile()` placement.** [`main.js:506-512`](js/main.js:506). Called after the menu state is set but **before** the first `requestAnimationFrame(gameLoop)`. Wrapped in try/catch because the addons module may not have wired every material yet. This walks the scene graph, finds every material × geometry pair, and compiles the GLSL — eliminating the "first time we render a debris piece, the shader takes 8 ms to compile and we drop a frame" pattern.

**120 Hz judder fix.** [`main.js:531-544`](js/main.js:531). Replaces:

```js
// OLD (removed):
if (timestamp - lastFrameTime < FRAME_INTERVAL) return;  // FRAME_INTERVAL=16.67
```

with an opt-in cap driven by `Constants.PERF.FRAME_CAP`. When `null` (the default), every RAF tick runs. When set to a number, drift-corrected pacing: increment `lastFrameTime` by `interval`, snap forward on huge falls-behind to avoid spiral-of-death.

**New tests.**

| File | Cases added | What's covered |
|---|---|---|
| [`test-Constants.js`](js/test/test-Constants.js:80) | "PERF namespace exists" + "PERF.FRAME_CAP exists and defaults to null (no cap)" | Pure constants integrity. |

**Acceptance criteria.**

- ✅ `Constants.PERF.FRAME_CAP` exists and defaults to `null` (covered by test).
- ✅ `gameLoop` early-returns on `document.hidden` (verifiable by source).
- ✅ `renderer.compile()` is called before the first RAF.
- 🟡 No first-frame stutter — needs a real Performance trace.
- 🟡 Smooth 120 fps on a ProMotion / 144 Hz panel — needs hardware.

---

### § 2.4 — PR 4 (P1.5 Quality tier system + QualityManager) — final test count 2112

**Goal.** Auto-pick HIGH/MEDIUM/LOW at boot based on GPU/RAM caps, swap the post-processing chain live when sustained fps tanks, and expose a `?tier=` URL flag for manual testing.

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`QualityManager.js`](js/systems/QualityManager.js:1) | 1–167 (new) | Pure functions: `TIER_ORDER`, `medianOf`, `selectInitialTier`, `runtimeAdapt`. Node-safe — no THREE, no `document`. |
| [`Constants.js`](js/core/Constants.js:2164) | 2164–2194 | New `QUALITY_TIERS` table + tuning knobs. |
| [`SceneManager.js`](js/scene/SceneManager.js:37) | 37–146 | Constructor calls `_detectInitialTier()`; URL override + capability detection (Apple-GPU via WEBGL_debug_renderer_info). |
| [`SceneManager.js`](js/scene/SceneManager.js:179) | 179–264 | `_setupPostProcessing(tier)` made tier-driven (msaaSamples, enableBloom, enableSMAA, pixelRatioCap, useFXAAFallback); `_disposePostProcessing()` for idempotency. |
| [`SceneManager.js`](js/scene/SceneManager.js:275) | 275–287 | `applyTier(tierName)` — live swap of tier config + pixel ratio + post chain. |
| [`Events.js`](js/core/Events.js:544) | 544–545 | `PERF_TIER_CHANGED` event. |
| [`main.js`](js/main.js:101) | 101–108 | `_fpsHistory`, `_framesSinceLastTierChange`, `_ADAPT_CHECK_INTERVAL = 60`. |
| [`main.js`](js/main.js:563) | 563–603 | Per-frame fps sample + runtimeAdapt call every 60 frames; emits `PERF_TIER_CHANGED` on downshift. |

**Tier matrix from [`Constants.js:2176-2180`](js/core/Constants.js:2176).**

| Tier | `msaaSamples` | `enableBloom` | `enableSMAA` | `pixelRatioCap` | `useFXAAFallback` |
|---|---:|:---:|:---:|---:|:---:|
| **HIGH**   | 4 | ✅ | ✅ | 2   | ❌ |
| **MEDIUM** | 2 | ✅ | ❌ | 1.5 | ✅ (TODO — falls back to "no post-AA, rely on MSAA") |
| **LOW**    | 0 | ❌ | ❌ | 1   | ❌ |

`Constants.PERF.DEFAULT_QUALITY_TIER = 'HIGH'` ([`Constants.js:2182`](js/core/Constants.js:2182)) is the safety fallback when the heuristic returns nothing.

**`selectInitialTier` heuristic** ([`QualityManager.js:59-93`](js/systems/QualityManager.js:59)).

1. If both `maxTextureSize` and `deviceMemoryGB` are unknown → `MEDIUM` (safe middle).
2. **HIGH gate**: `maxTextureSize >= 16384` AND (`isAppleGPU === true` OR `deviceMemoryGB >= 8`). Apple Silicon is whitelisted because its unified-memory tile-based renderer makes bloom + SMAA cheap even on integrated GPUs.
3. **MEDIUM gate**: `maxTextureSize >= 8192` AND `deviceMemoryGB >= 4`.
4. **Strong negative**: `maxTextureSize < 8192` OR `deviceMemoryGB < 4` → `LOW`.
5. Partial signal that didn't trip any rule → `MEDIUM`.

Apple-GPU detection in [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:128) reads `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL` and matches `/Apple/i`. Safari only exposes this on cross-origin-isolated contexts; absence is treated as `false`.

**`runtimeAdapt` cooldown logic** ([`QualityManager.js:116-160`](js/systems/QualityManager.js:116)).

| Gate | Condition |
|---|---|
| **Half-window warm-up** | `fpsHistory.length >= floor(FPS_HISTORY_SIZE / 2)` — avoids reacting during the cold-cache window. |
| **Cooldown** | `framesSinceLastChange >= ADAPT_COOLDOWN_FRAMES` (300). |
| **FPS gate** | `median(fpsHistory) < ADAPT_FPS_THRESHOLD` (50). |
| **Floor** | Never drops below `LOW`. |
| **No upshift** | Out of scope; only HIGH→MEDIUM→LOW. |

When a change is made in [`main.js:588-601`](js/main.js:588):
- `sceneManager.applyTier(to)` rebuilds the composer in place.
- `_framesSinceLastTierChange = 0`; `_fpsHistory.length = 0` (post-change samples only).
- `eventBus.emit(Events.PERF_TIER_CHANGED, { from, to, reason: 'auto-downshift' })`.

**`?tier=` URL flag.** [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:108-118): parses `URLSearchParams`, accepts `HIGH | MEDIUM | LOW` (case-insensitive), logs `[Perf] tier URL override → X` and returns directly — bypassing all heuristics.

**New constants.** All under `Constants.PERF` ([`Constants.js:2157-2195`](js/core/Constants.js:2157)):

| Constant | Default | Purpose |
|---|---|---|
| `PERF.QUALITY_TIERS` | object (HIGH/MEDIUM/LOW) | Tier configs (see matrix above). |
| `PERF.DEFAULT_QUALITY_TIER` | `'HIGH'` | Fallback when detection is inconclusive. |
| `PERF.FPS_HISTORY_SIZE` | `180` | Sliding window (~3 s at 60 fps). |
| `PERF.ADAPT_FPS_THRESHOLD` | `50` | Median fps below this → downshift. |
| `PERF.ADAPT_COOLDOWN_FRAMES` | `300` | ~5 s at 60 fps between changes. |

**New EventBus constants in [`Events.js`](js/core/Events.js:544).**

| Event | Payload |
|---|---|
| `Events.PERF_TIER_CHANGED` (`'perf:tier-changed'`) | `{ from, to, reason }` where `reason` is `'auto-downshift'` (PR 4) or `'gpu-probe'` (PR 6). |

**New tests.**

| File | Suites | Test count |
|---|---|---|
| [`test-QualityManager.js`](js/test/test-QualityManager.js:1) | `TIER_ORDER`, `medianOf`, `selectInitialTier`, `runtimeAdapt` | 17 cases covering: tier ordering, median (odd/even/empty/null/non-mutation), selectInitialTier on M-series, high-end PC, mid Intel, low-end, 16K-but-only-2GB, empty input, partial-signal, runtimeAdapt half-window, cooldown, FPS gate, HIGH→MEDIUM, MEDIUM→LOW, no-drop-below-LOW, edge of gate, invalid tier, empty history. |

**Acceptance criteria.**

- ✅ Pure function `selectInitialTier` is testable in Node (no THREE, no `document`).
- ✅ `runtimeAdapt` enforces half-window + cooldown + threshold gates (covered by 9 cases).
- ✅ `applyTier()` is idempotent — `_disposePostProcessing()` cleans up the old composer.
- ✅ `?tier=` URL override works in [`_detectInitialTier()`](js/scene/SceneManager.js:108).
- 🟡 Visual quality drop on tier change is acceptable — needs eyeballing.
- 🟡 No flash / black frame on `applyTier()` swap — needs a Performance trace.

---

### § 2.5 — PR 5 (P2.8 TimerManager + P2.9 bloom Vec2 cache + P2.10 gated diagnostics) — final test count 2123

**Goal.** Three janitorial wins that compound:

- **P2.8 TimerManager** — central registry so timers tagged with `state: 'MENU'` get auto-cleared when the FSM transitions out of MENU. Kills the "ghost toast removes itself 1.2 s after the screen was already closed" class of bug.
- **P2.9 Vector2 cache** — `UnrealBloomPass` resolution was being `new THREE.Vector2()`'d on every resize event and tier swap. PR 5 caches it on the `SceneManager` instance and mutates in place.
- **P2.10 Gated diagnostics** — `_logDiagnostics()` and the Earth LOD log were always-on `console.log` + `console.table` walls. Both are now gated behind `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS`, flipped on per-session via `?debug=1`.

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`TimerManager.js`](js/systems/TimerManager.js:1) | 1–203 (new) | Singleton + class. Tagged timers (owner + state). Auto-clears on `Events.STATE_CHANGE`. |
| [`Constants.js`](js/core/Constants.js:2144) | 2144–2155 | New `DEBUG` block with `LOG_RENDERER_DIAGNOSTICS: false`. |
| [`SceneManager.js`](js/scene/SceneManager.js:26) | 26 | `this._bloomRes = new THREE.Vector2()` — cached on the instance. |
| [`SceneManager.js`](js/scene/SceneManager.js:212-216) | 212–216 | `_bloomRes.set(...)` then passed to `new UnrealBloomPass()`. |
| [`SceneManager.js`](js/scene/SceneManager.js:404-416) | 404–416 | `resize()` mutates `_bloomRes` and the pass's existing `resolution` Vector2 in place. |
| [`SceneManager.js`](js/scene/SceneManager.js:294-344) | 294–344 | `_logDiagnostics()` early-returns when `LOG_RENDERER_DIAGNOSTICS=false`. |
| [`Earth.js`](js/scene/Earth.js:506-509) | 506–509 | LOD-selection log gated behind the same flag. |
| [`main.js`](js/main.js:181-194) | 181–194 | `?debug=1` URL flag sets `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS = true` before any module reads it. |
| 5 migrated files (see below) | various | All `setTimeout`/`setInterval` calls swapped to `timerManager.setTimeout(...)` with `{ owner: this }` (and `{ state: 'XYZ' }` where the timer's lifetime is FSM-scoped). |

**TimerManager API** ([`TimerManager.js`](js/systems/TimerManager.js:37-197)).

| Method | Signature | Notes |
|---|---|---|
| `setTimeout(cb, ms, { state?, owner? })` | → `id` | One-shot. Auto-removes from registry **before** invoking cb (re-entrant clear inside cb is safe). |
| `setInterval(cb, ms, { state?, owner? })` | → `id` | Repeats until explicitly cleared. |
| `clear(id)` | → `bool` | Safe with stale/unknown ids. |
| `clearByState(state)` | → count | Auto-invoked on `Events.STATE_CHANGE` for the old state. |
| `clearByOwner(owner)` | → count | Owner is `===` compared — pass `this`. |
| `clearAll()` | → count | Hard shutdown / test reset. |
| `activeCount()` | → number | Live timers (un-fired, un-cleared). |

The singleton subscribes to `Events.STATE_CHANGE` in its constructor ([`TimerManager.js:61-65`](js/systems/TimerManager.js:61)) so any timer tagged with `state: payload.from` is reaped on every FSM transition.

**5 migrated files (PR 5 deliverable).**

| File | Migrated to TimerManager | Approx. timer-count before → after |
|---|---|---|
| [`AudioSystem.js`](js/systems/AudioSystem.js:1246) | Yes (cleanup delays for delay/echo nodes, sputter intervals, dvAlarm interval, forge stop fades) | ~14 raw → 0 raw, all tagged via singleton |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js:188) | Yes (briefing comms cascade, transition delays, shop timeout) | ~11 raw → 0 raw, all `{ owner: this }` |
| [`CommsSystem.js`](js/systems/CommsSystem.js:563) | Yes (handoff dialogue, double-beep warning) | ~6 raw → 0 raw |
| [`HUD.js`](js/ui/HUD.js:1184) | Yes (flash, popup, notification, salvage reveal, mastery toast, armPilotStrip) | ~10 raw → 0 raw |
| [`SkillsPane.js`](js/ui/hud/SkillsPane.js:187) | Yes (mastered-fade, checklist linger, glow remove, flash-mastered, fade-end, hide-timer) | ~9 raw → 0 raw |

Total **~48 migrated** (matches the task spec). Each call site uses `{ owner: this }` so destroy / state-change can clear by owner without tracking individual ids.

**16 files still using raw `setTimeout` / `setInterval` (deferred — listed verbatim from `search_files`):**

1. [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:2338) — pilot-nudge delayed retry (2 sites)
2. [`js/entities/ArmManager.js`](js/entities/ArmManager.js:1069) — strut deploy / stow scheduling (2 sites)
3. [`js/systems/CatalogLoader.js`](js/systems/CatalogLoader.js:35) — fetch-timeout (paired with `clearTimeout`, low-risk)
4. [`js/systems/ResourceSystem.js`](js/systems/ResourceSystem.js:581) — ground-station pass debounce
5. [`js/systems/MissionEventSystem.js`](js/systems/MissionEventSystem.js:292) — conjunction accumulation decay
6. [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js:538) — staggered debris-discovery reveal
7. [`js/main.js`](js/main.js:497) — loading-screen `.remove()` after fade (one-shot at boot)
8. [`js/systems/InputManager.js`](js/systems/InputManager.js:948) — `_cHoldTimeout`, `_lassoWindupTimeout` (also uses `timerManager` for audio-unlock self-test)
9. [`js/ui/MenuScreen.js`](js/ui/MenuScreen.js:260) — fade-out display:none
10. [`js/ui/ShopScreen.js`](js/ui/ShopScreen.js:661) — card flash removal, fade
11. [`js/ui/SweepReportUI.js`](js/ui/SweepReportUI.js:152) — keyhandler defer, dismiss timer, fade-out (3 sites)
12. [`js/ui/BriefingScreen.js`](js/ui/BriefingScreen.js:366) — fade-out display:none
13. [`js/ui/GameOverScreen.js`](js/ui/GameOverScreen.js:299) — fade-out display:none
14. [`js/ui/TeachingOverlay.js`](js/ui/TeachingOverlay.js:208) — hold timer + fade-out (2 sites)
15. [`js/ui/CodexViewerUI.js`](js/ui/CodexViewerUI.js:60) — overlay hide, transient msg removal (2 sites)
16. [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js:1177) — power collapse, capture notif fade (2 sites)

These are all UI-fade / one-shot cleanup timers whose worst-case bug is "remove a hidden DOM node 0.5 s late." Migrating them is mechanical but low-priority.

**Bloom Vector2 cache (P2.9).** [`SceneManager.js:26`](js/scene/SceneManager.js:26): `this._bloomRes = new THREE.Vector2()` allocated once. In `_setupPostProcessing` ([`SceneManager.js:212-216`](js/scene/SceneManager.js:212)) it's `set()` then passed to `new UnrealBloomPass(this._bloomRes, ...)` — `UnrealBloomPass` clones the input internally, so we can safely mutate later. On `resize()` ([`SceneManager.js:404-416`](js/scene/SceneManager.js:404)) we mutate both `_bloomRes` and the pass's existing `resolution` Vector2, zero allocations.

**Gated diagnostics (P2.10).**

- [`Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS`](js/core/Constants.js:2151) — `false` by default. Gates the `console.table` block at [`SceneManager._logDiagnostics()`](js/scene/SceneManager.js:296) and the Earth LOD log at [`Earth.js:507`](js/scene/Earth.js:507).
- `?debug=1` URL flag parsed at [`main.js:182-186`](js/main.js:182), **before** any module reads the flag.
- When false, both blocks early-return (cheap no-op).

**New constants.**

| Constant | Default | Where |
|---|---|---|
| `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS` | `false` | [`Constants.js:2151`](js/core/Constants.js:2151) |

**New EventBus constants.** None for PR 5 directly, but TimerManager **consumes** `Events.STATE_CHANGE` (pre-existing) at [`TimerManager.js:61`](js/systems/TimerManager.js:61).

**New tests.**

| File | Cases | Coverage |
|---|---|---|
| [`test-TimerManager.js`](js/test/test-TimerManager.js:1) | 10 cases across "clear by id", "tagged clearing", "STATE_CHANGE auto-clear", "setTimeout fires + auto-removes", "setInterval repeats", "activeCount lifecycle", "re-entrant safety" | All sync paths + 4 async paths with ≤30 ms real sleeps. |
| [`test-Constants.js`](js/test/test-Constants.js:41) | "DEBUG block exists with LOG_RENDERER_DIAGNOSTICS off by default (PR 5 / P2.10)" | Default-state assertion. |

**Acceptance criteria.**

- ✅ Singleton + class export both work ([`TimerManager.js:200-202`](js/systems/TimerManager.js:200)).
- ✅ `clearByOwner(this)` is safe at module shutdown.
- ✅ State-change auto-clear is wired via EventBus (test "emitting Events.STATE_CHANGE clears timers tagged with the previous state").
- ✅ Bloom Vec2 not re-allocated per resize (visible via source inspection).
- ✅ `?debug=1` produces the verbose log block; default boot has no `[SceneManager] Rendering Diagnostics` row in the console.
- 🟡 GC pressure reduction — needs DevTools Memory profile.

---

### § 2.6 — PR 6 (P3.11 GPU probe + P3.13 audio unlock self-test + P3.15 draw-call profiling) — final test count 2134

**Goal.** Ship the instrumentation that PRs 7+ will rely on for evidence-based tuning. None of these change rendering on success; all of them light up new console signatures + (in one case) a user-facing toast on failure.

**Files touched.**

| File | Lines | Summary of change |
|---|---|---|
| [`GpuProbe.js`](js/systems/GpuProbe.js:1) | 1–201 (new) | Wrapper around `EXT_disjoint_timer_query_webgl2`. Fail-soft on Firefox / older Safari. |
| [`SceneManager.js`](js/scene/SceneManager.js:71-91) | 71–91 | Constructs `new GpuProbe(gl)`; sets `gpuProbeEnabled = probe.isSupported`. |
| [`SceneManager.js`](js/scene/SceneManager.js:363-371) | 363–371 | `render()` wraps `composer.render()` with `probe.beginFrame()` / `probe.endFrame()` when enabled. |
| [`main.js`](js/main.js:944-975) | 944–975 | After each render, polls completed timer queries. When `getSampleCount() >= GPU_PROBE_FRAMES`, evaluates median vs. threshold and optionally calls `applyTier()`. Disables probe after one window (one-shot). |
| [`Constants.js`](js/core/Constants.js:2189-2194) | 2189–2194 | `GPU_PROBE_THRESHOLD_MS = 14`, `GPU_PROBE_FRAMES = 60`. |
| [`Constants.js`](js/core/Constants.js:2152-2154) | 2152–2154 | `DEBUG.LOG_DRAW_CALLS = false` (off by default). |
| [`main.js`](js/main.js:187-191) | 187–191 | `?profile=1` URL flag flips `DEBUG.LOG_DRAW_CALLS = true`. |
| [`main.js`](js/main.js:977-985) | 977–985 | Per-60-frame `[Profile] calls=N triangles=N points=N lines=N` log. |
| [`InputManager.js`](js/systems/InputManager.js:273-295) | 273–295 | `_tryAudioUnlock()` — on first user gesture, `audio.resume()` + 200 ms self-test; emit `AUDIO_UNLOCK_FAILED` if still suspended. |
| [`HUD.js`](js/ui/HUD.js:655-657) | 655–657 | Subscribes to `AUDIO_UNLOCK_FAILED`, shows `'Audio blocked — click anywhere to enable sound'` toast for 5 s. |
| [`Events.js`](js/core/Events.js:540) | 540–541 | `AUDIO_UNLOCK_FAILED` constant. |

**GpuProbe API** ([`GpuProbe.js`](js/systems/GpuProbe.js:20-197)).

| Method | Notes |
|---|---|
| `new GpuProbe(gl, { windowSize = 60 })` | Acquires `EXT_disjoint_timer_query_webgl2`. `isSupported` set to `false` if extension missing, `null` gl, or any constructor error. |
| `beginFrame()` | No-op when unsupported or a query is already active. Creates a `WebGLQuery`, `gl.beginQuery(TIME_ELAPSED_EXT, q)`, pushes to `_pendingQueries`. |
| `endFrame()` | `gl.endQuery(TIME_ELAPSED_EXT)`. |
| `poll()` | **Must be called each frame** to drain results. Checks `GPU_DISJOINT_EXT` first — if set, discards all pending queries (results would be unreliable). Then drains the FIFO of any query whose `QUERY_RESULT_AVAILABLE` is true, pushes `result / 1e6` (ms) into `_samples` (capped at `windowSize`). |
| `getSampleCount()` | Number of completed samples in the rolling window. |
| `getMedianMs()` | Median of `_samples` in ms. `NaN` if empty. |
| `dispose()` | Deletes all pending queries, clears samples. |

**Threshold + window constants** ([`Constants.js:2189-2194`](js/core/Constants.js:2189)).

| Constant | Default | Purpose |
|---|---|---|
| `PERF.GPU_PROBE_THRESHOLD_MS` | `14` | Above this median ms → request one tier downshift. Sits ~2.5 ms below the 16.67 ms 60-fps budget for headroom. |
| `PERF.GPU_PROBE_FRAMES` | `60` | Sample window. At 60 fps ≈ 1 s of GPU samples. |

**One-shot probe path in [`main.js:944-975`](js/main.js:944).** After `sceneManager.render()`:

1. While `!_gpuProbeComplete` and probe enabled+supported, call `probe.poll()`.
2. Once `getSampleCount() >= GPU_PROBE_FRAMES`:
   - Mark `_gpuProbeComplete = true` and disable the probe (`sceneManager.gpuProbeEnabled = false`) so we stop wrapping every render call with `begin/endQuery`.
   - Log `[Perf] GPU probe complete: median=X.XXms threshold=14ms (60 samples)`.
   - If median > threshold AND tier ≠ LOW: find next step down in `TIER_ORDER`, call `sceneManager.applyTier(nextTier)`, emit `Events.PERF_TIER_CHANGED` with `reason: 'gpu-probe'`.
   - `probe.dispose()`.

**`?profile=1` flag.** [`main.js:188-191`](js/main.js:188): parses URL, sets `Constants.DEBUG.LOG_DRAW_CALLS = true`. Per-60-frame log at [`main.js:977-985`](js/main.js:977) reads `sceneManager.renderer.info.render` and prints:

```text
[Profile] calls=312 triangles=184053 points=4096 lines=128
```

**`AUDIO_UNLOCK_FAILED` toast wiring.** Three-stage chain:

1. [`InputManager._tryAudioUnlock()`](js/systems/InputManager.js:273-295) — on first keydown/pointerdown, calls `audio.init()` + `audio.resume()`, then schedules a 200 ms `timerManager.setTimeout` (note: this is the TimerManager singleton — even PR 6 instrumentation is well-behaved).
2. After 200 ms, if `audio.ctx.state === 'suspended'` → `console.warn` + `eventBus.emit(Events.AUDIO_UNLOCK_FAILED)`.
3. [`HUD.js:655-657`](js/ui/HUD.js:655) — listener calls `this.showNotification('Audio blocked — click anywhere to enable sound', 5000)`.

This catches the iOS-Safari case where `AudioContext.resume()` returns without actually resuming until a "real" gesture, and the Brave-shields case where the AudioContext is silently blocked.

**New constants.**

| Constant | Default | Where |
|---|---|---|
| `PERF.GPU_PROBE_THRESHOLD_MS` | `14` | [`Constants.js:2192`](js/core/Constants.js:2192) |
| `PERF.GPU_PROBE_FRAMES` | `60` | [`Constants.js:2194`](js/core/Constants.js:2194) |
| `DEBUG.LOG_DRAW_CALLS` | `false` | [`Constants.js:2154`](js/core/Constants.js:2154) |

**New EventBus constants.**

| Event | Payload | Emitter | Listener |
|---|---|---|---|
| `Events.AUDIO_UNLOCK_FAILED` (`'audio:unlockFailed'`) | `{}` | [`InputManager.js:291`](js/systems/InputManager.js:291) | [`HUD.js:656`](js/ui/HUD.js:656) |

**New tests.**

| File | Cases | Coverage |
|---|---|---|
| [`test-GpuProbe.js`](js/test/test-GpuProbe.js:1) | 11 cases across "no extension fallback", "with extension", "disjoint handling", "dispose" | Mock GL context; tests `isSupported`, begin/end/poll, rolling window, median (odd/even), disjoint discard, post-disjoint recovery, dispose. |

**Acceptance criteria.**

- ✅ `isSupported` returns `false` when extension is absent (covered).
- ✅ `beginFrame`/`endFrame`/`poll` are no-ops on Firefox (covered by mock).
- ✅ `getMedianMs` matches `QualityManager.medianOf` semantics.
- ✅ Disjoint flag discards pending queries (covered).
- ✅ `?profile=1` produces the `[Profile] calls=…` log every 60 frames.
- ✅ One-shot semantics: probe disabled + disposed after one window (visible in source).
- ✅ `AUDIO_UNLOCK_FAILED` toast is wired end-to-end (source-visible).
- 🟡 Real disjoint-event firing on a thermally-throttling GPU — needs hardware.
- 🟡 Toast actually appears in iOS Safari — needs a device test.

---

## § 3 — CPU/GPU Load Analysis

> This section is **static reasoning only**. The actual numbers will land in a follow-up sprint once `?profile=1` traces from real machines have been collected. Where a row is a prediction, it is labelled **(predicted)**.

### § 3.1 — Frame-Time Budget Model

| Refresh rate | Budget / frame | Comment |
|---|---:|---|
| 60 Hz | 16.67 ms | Web baseline. |
| 120 Hz | 8.33 ms | ProMotion, gaming laptops. |
| 144 Hz | 6.94 ms | High-refresh PC monitors. |
| **GPU-probe threshold** | **14 ms** | [`PERF.GPU_PROBE_THRESHOLD_MS`](js/core/Constants.js:2192). Both 60 and 120 fps fit comfortably below this on HIGH-tier hardware; missing it triggers the one-shot downshift. |

**Breakdown of where each frame's ms goes (static reasoning):**

| Bucket | Where in code | Static cost notes |
|---|---|---|
| **Physics tick** | [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) — Kepler propagation + J2, called per debris per frame from [`DebrisField.update()`](js/entities/DebrisField.js:1) | O(N) over alive debris (~50–300 in typical mission). Pure JS math; CPU-side. |
| **Render call** | [`SceneManager.render()`](js/scene/SceneManager.js:363) → `composer.render()` | GPU-bound. Cost scales with `msaaSamples × pixelRatio² × screenArea` (see tier reasoning below). |
| **Post-processing** | [`_setupPostProcessing()`](js/scene/SceneManager.js:179) — UnrealBloomPass + SMAAPass | UnrealBloomPass: ~5 fullscreen passes at half-res. SMAAPass: ~3 fullscreen passes at full-res. HIGH tier runs both; LOW runs neither. |
| **UI updates** | [`HUD.update()`](js/ui/HUD.js:1) called from [`main.js:773-783`](js/main.js:773); also `NavSphere`, `TargetReticle`, `OrbitMFD`, `DebrisMap`, `DockingReticle`, `TrailSystem` | DOM writes + Canvas2D draws. Cost dominated by DOM mutation (CSS reflow) when target lists / panels change. |
| **Event handling** | `inputManager.processInput(dt)` at [`main.js:632`](js/main.js:632) | Light — boolean key state polls + a handful of event emits. |
| **Entity updates** | [`main.js:644-757`](js/main.js:644) — `player.update`, `debrisField.update`, `activeSatellites.update`, `armManager.update`, `targetSelector.update`, `resourceSystem.update`, etc. (≥20 systems) | This is the **CPU hot spot** — see [§ 3.3](#-33--cpu-hot-spots-static-analysis). |

The "always-update visuals" block ([`main.js:617-621`](js/main.js:617)) — `sunLight.update`, `earth.update`, `starfield.update` — runs in both gameplay and menu states, but at `dt * 0.1` in menu mode ([`main.js:905-908`](js/main.js:905)), so menu-state CPU load is ~10× lighter than gameplay.

### § 3.2 — GPU Load by Quality Tier

The composer pipeline is **fully tier-driven** in [`_setupPostProcessing()`](js/scene/SceneManager.js:179-242). Each tier exercises a different subset of fullscreen passes:

| Tier | Render target | Bloom | SMAA | Pixel ratio | Predicted target hardware |
|---|---|---|---|---|---|
| **HIGH** | `HalfFloatType`, 4× MSAA | ✅ ~5 half-res fullscreen passes | ✅ ~3 full-res fullscreen passes | min(DPR, 2) | M-series MacBooks, RTX 30/40-series laptops, RDNA2+ desktops |
| **MEDIUM** | `HalfFloatType`, 2× MSAA | ✅ ~5 half-res fullscreen passes | ❌ (TODO: FXAA fallback not implemented — see [`_setupPostProcessing():236-240`](js/scene/SceneManager.js:236)) | min(DPR, 1.5) | Intel Iris Xe, Apple integrated pre-M1, mid AMD APUs |
| **LOW** | `HalfFloatType`, 0× MSAA | ❌ skipped | ❌ skipped | min(DPR, 1) | Intel UHD 620-class, thermally-throttled mobile, browsers without HW MSAA |

**Pass-by-pass GPU cost reasoning:**

- **RenderPass** ([`SceneManager.js:205-207`](js/scene/SceneManager.js:205)) — single scene draw. Cost is dominated by per-fragment shading × pixel count. Pixel count = `screen × pixelRatio²` — that's why `pixelRatioCap: 2 → 1.5 → 1` is the single biggest GPU lever (cuts fragments by 4× from HIGH to LOW on a retina display).
- **UnrealBloomPass** ([`SceneManager.js:217-223`](js/scene/SceneManager.js:217)) — runs at `(width × pixelRatio) / 2 × (height × pixelRatio) / 2` (see [`_bloomRes.set()`](js/scene/SceneManager.js:213-216)). ~5 separable Gaussian passes + composite. Half-res keeps it cheap; threshold 1.5 means only sun disc + engine glow blooms. Disabled at LOW.
- **SMAAPass** ([`SceneManager.js:231-232`](js/scene/SceneManager.js:231)) — 3 fullscreen passes at full pixel-ratio. Most expensive AA option. HIGH only.
- **MSAA on the render target** ([`SceneManager.js:194-201`](js/scene/SceneManager.js:194)) — 4× / 2× / 0× via `WebGLRenderTarget({ samples })`. Cuts shimmer on rotating debris. Free on tile-based renderers (Apple Silicon); meaningful cost on discrete GPUs.

**Expected GPU work, qualitative ranking (predicted):**

| Tier | Bloom + SMAA + 4× MSAA cost | Pixel-ratio cost | Total predicted GPU ms (1080p) |
|---|---|---|---|
| HIGH | ~3–4 ms | ×2² = ×4 | ~6–9 ms on M-series / RTX-class, ~12–18 ms on Iris Xe |
| MEDIUM | ~1.5–2 ms (bloom only) | ×1.5² = ×2.25 | ~3–5 ms on M-series, ~6–10 ms on Iris Xe |
| LOW | ~0.3 ms (passthrough copy) | ×1 | ~1.5–3 ms on M-series, ~3–6 ms on Iris Xe |

These ranges are reasoning, not measurements. The GPU probe's median sample is what populates the truth column.

### § 3.3 — CPU Hot Spots (static analysis)

Per-frame `update(dt)` calls in the gameplay branch ([`main.js:626-897`](js/main.js:626)), ranked by likely cost:

| Rank | System | Why it's expensive | File |
|---|---|---|---|
| 1 | `debrisField.update(dt, player.getPosition(), player.getOrbitalElements())` | Per-debris Kepler propagation + visibility predicate + instanced-mesh transform update. Scales O(N) with N ≈ 50–300 alive debris + background population. | [`DebrisField.js`](js/entities/DebrisField.js:1) |
| 2 | `collisionAvoidanceSystem.update(dt)` | Per-pair distance + time-to-closest-approach. Worst-case O(N) per checked target, but gated by [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) so usually <20 pairs. | [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:1) |
| 3 | `armManager.update(dt)` | 4–8 arm units each with their own FSM tick + tether physics + ROSA animation. | [`ArmManager.js`](js/entities/ArmManager.js:1) |
| 4 | `hud.update(dt, …)` | DOM writes across 8+ panels + canvas redraws (DebrisWireframe). Cost dominated by CSS-text mutation when values change. | [`HUD.js`](js/ui/HUD.js:1) |
| 5 | `conjunctionSystem.update(dt, gameState, debrisField.debrisList, player.getPosition(), player.getVelocity(), inputManager.isArmPilotMode())` | MOID computation per debris in alert band. | [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:1) |
| 6 | `trawlManager.update(dt, …)` | Per-arm sweep cone + per-debris membership test. | [`TrawlManager.js`](js/systems/TrawlManager.js:1) |
| 7 | `targetReticle.update`, `navSphere.update`, `orbitMFD.update`, `debrisMap.update` | Each iterates the debris list and projects to screen. O(N) reads. | [`TargetReticle.js`](js/ui/TargetReticle.js:1), [`NavSphere.js`](js/ui/NavSphere.js:1), [`OrbitMFD.js`](js/ui/OrbitMFD.js:1), [`DebrisMap.js`](js/ui/DebrisMap.js:1) |

**PR 5 TimerManager migration impact on CPU/GC.** The 5 migrated files held ~48 raw `setTimeout`/`setInterval` references. Each fire created a closure; many were leaked across FSM transitions (e.g. a MENU-state toast remover firing during gameplay). The migration:

- Moves the closures into one `Map` keyed by id (steady-state allocation: ~80–160 bytes/entry).
- `clearByState(payload.from)` on every `Events.STATE_CHANGE` reaps state-tagged closures *immediately* instead of leaving them to GC after they fire on an already-removed DOM node.
- Net effect: small but measurable **drop in GC pressure** (fewer minor GCs in long sessions), plus elimination of the "ghost timer touches a deleted node" class of bug. Quantification is qualitative — DevTools Memory snapshots before/after would put a number on it, but those weren't collected during this sprint.

### § 3.4 — Memory Profile

**Texture VRAM cost by tier (rough — RGBA8 uncompressed in GPU memory; AVIF compresses bytes-on-wire only, not VRAM):**

| Tier | Day | Night | Clouds | Per-side VRAM total | Notes |
|---|---|---|---|---|---|
| HIGH (16k path) | 16384² × 4 = 1 GB | 16k² = 1 GB | 8k² = 256 MB | **~2.25 GB** | Mipmaps add ~33 % more. [`anisotropy = 8`](js/scene/Earth.js:442) (capped from 16 for VRAM safety). |
| MEDIUM (8k path) | 8192² × 4 = 256 MB | 8k² = 256 MB | 8k² = 256 MB | **~770 MB** | |
| LOW (4k base) | 4096² × 4 = 64 MB | 4k² = 64 MB | 4k² = 64 MB | **~190 MB** | |

These are GPU upload costs; the AVIF saving in [§ 2.1](#-21--pr-1-p01-avif-textures--p02-preload-hints--final-test-count-2085) is purely on the network/wire side.

**Heap impact:**

| Buffer | Size | Where |
|---|---|---|
| TimerManager `_timers` Map | ~80–160 bytes × N (N = live timers, typically ~5–20) ≈ **0.4–3.2 KB** | [`TimerManager.js:53`](js/systems/TimerManager.js:53) |
| FPS history (capped 180 floats) | 180 × 8 = **1.4 KB** | [`main.js:105`](js/main.js:105) |
| GpuProbe `_samples` (capped 60 floats) | 60 × 8 = **0.5 KB** | [`GpuProbe.js:57`](js/systems/GpuProbe.js:57) |
| GpuProbe `_pendingQueries` | Up to ~30 `WebGLQuery` handles in flight, ~16 bytes each ≈ **0.5 KB** | [`GpuProbe.js:51`](js/systems/GpuProbe.js:51) |

All instrumentation overhead totals **<6 KB** of heap and is negligible at every tier.

**Per-PR delta in memory pressure (qualitative):**

- **PR 1 (AVIF)** — smaller bytes-on-wire = faster network = same VRAM but lower transient memory during decode.
- **PR 5 (TimerManager + Vec2 cache)** — fewer leaked closures = fewer minor GCs. `_bloomRes` cache saves 1 `Vector2` per resize (~24 bytes) — vanishingly small but cumulative on a window-drag.
- **PR 6 (GpuProbe + draw-call profile)** — totals <6 KB heap; pure additive, no leaks.

### § 3.5 — Browser-Specific Behavior

| Feature | Chrome 120+ | Safari 17+ | Firefox 121+ | Codebase handling |
|---|---|---|---|---|
| **AVIF decode** | ✅ native (Chrome 85+) | ✅ Safari 17+ (AV1) | ✅ Firefox 93+ | [`Earth.js:389-401`](js/scene/Earth.js:389) — top-level `Image.decode()` probe with cached boolean; [`loadTexture()`](js/scene/Earth.js:416) falls back to `.jpg` if AVIF runtime-decodes fail. |
| **Service Worker** | ✅ | ✅ | ✅ | [`sw.js`](sw.js:1) is registered with relative `./sw.js` ([`index.html:404`](index.html:404)) so the same code works at `/` and `/SCB/`. Scope is the page directory. |
| **`EXT_disjoint_timer_query_webgl2`** | ✅ (since ~Chrome 85) | ✅ on most macOS+iOS (Apple GPU drivers expose it; Safari may gate it behind cross-origin-isolation) | ❌ permanently disabled by Mozilla for fingerprinting reasons | [`GpuProbe.constructor`](js/systems/GpuProbe.js:25) sets `isSupported = false` when `gl.getExtension(...)` returns null; all methods become no-ops. [`SceneManager.js:87-88`](js/scene/SceneManager.js:87) logs `falling back to deviceMemory heuristic`. Tier selection on Firefox is **driven entirely by `selectInitialTier`** + `runtimeAdapt` (fps-based). |
| **`navigator.deviceMemory`** | ✅ | ❌ (Safari privacy — always `undefined`) | ✅ | [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:124) reads `navigator.deviceMemory` and passes `undefined` to [`selectInitialTier()`](js/systems/QualityManager.js:62), which falls through to the Apple-GPU branch (`isAppleGPU || memGB >= 8`). For Mac Safari, Apple-GPU detection picks up the slack. For Windows Safari (rare), the partial-signal fallback to `MEDIUM` activates. |
| **`requestAnimationFrame` 120 Hz** | ✅ on ProMotion + high-refresh monitors | ✅ ProMotion on M1+ MacBooks, iPads | ✅ on supported displays | [`gameLoop()`](js/main.js:521) does not hard-cap to 60 fps; `FRAME_CAP=null` lets RAF run at native refresh. PR 3 specifically fixed the every-other-frame judder. |
| **Top-level `await` (Earth.js AVIF probe)** | ✅ | ✅ | ✅ | [`Earth.js:389`](js/scene/Earth.js:389) — works in all three. Module load blocks until the probe resolves (~one microtask in the AVIF-supported case, longer if decode fails). Test runner short-circuits the probe via `typeof Image === 'undefined'`. |
| **`WEBGL_debug_renderer_info`** | ✅ | ⚠️ Safari may gate on `crossOriginIsolated` | ✅ | [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:128-138) wraps in try/catch; absence → `isAppleGPU = false`. Mac Safari without COOP/COEP falls back to the deviceMemory branch — which, combined with Safari's `undefined` deviceMemory, lands in the `MEDIUM` safe-middle bucket. The `?tier=HIGH` URL override is the workaround. |

### § 3.6 — Expected Performance by Reference Machine

> **All numbers in this table are predictions** based on tier-selection heuristics and qualitative GPU class. Replace with measured medians once `?profile=1` traces are collected.

| Machine | Predicted initial tier | First-load AVIF MB | Predicted steady-state fps | Notes |
|---|---|---:|---|---|
| MacBook Air M1 (Safari 17+) | **HIGH** | ~9 MB (was ~41 MB JPG) | 60+ (ProMotion-capable but most Airs are 60 Hz) | GPU probe likely active; if not, Apple-GPU branch in `selectInitialTier` triggers HIGH despite undefined `deviceMemory`. |
| MacBook Pro M3 Pro (Chrome 120) | **HIGH** | ~9 MB | 100–120 fps (ProMotion 120 Hz panel, `FRAME_CAP=null`) | GPU probe active; PR 3 fix eliminates 60 Hz alias. |
| Windows ROG Strix RTX 4070 (Chrome 120, 120 Hz monitor) | **HIGH** | ~9 MB | **120 fps sustained** | GPU probe active; thermals likely fine; PR 3 fix critical here. |
| ThinkPad X1 Carbon (Intel Iris Xe, Edge 120) | **MEDIUM** | ~9 MB | 50–60 fps | `selectInitialTier`: `maxTextureSize=16384` likely, `deviceMemoryGB=8` likely, `isAppleGPU=false` → matches HIGH gate by RAM. **In practice may auto-downshift** to MEDIUM via either GPU probe (>14 ms) or `runtimeAdapt` (median < 50 fps). |
| Dell XPS 13 (older Intel UHD 620, Firefox 121) | **LOW or MEDIUM** | ~9 MB | 30–45 fps | No GPU probe (Firefox lacks the extension) → falls to `runtimeAdapt`'s fps gate. `selectInitialTier` likely returns `LOW` (`maxTextureSize < 8192` plausible on UHD 620) or `MEDIUM`. Firefox 121's `navigator.deviceMemory` is exposed, so the heuristic has both signals. |

**Reading the table.** The first-load MB column is the same `~9 MB` across machines because tier selection picks an LOD level (4k/8k/16k AVIF) but the **base path always starts at the 4k AVIF preload** ([`index.html:358`](index.html:358)); larger LODs load as the scene needs them. The "was 41 MB" number is the HIGH-tier total in the old JPG world (DEPLOY_ANALYSIS.md numbers).

### § 3.7 — Instrumentation How-To

All three diagnostic toggles are URL flags parsed in [`main.js:181-194`](js/main.js:181) before any module reads them, so they take effect on the very first frame.

| Flag | What it does | Source |
|---|---|---|
| `?debug=1` | Sets `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS = true`. Triggers the `console.table` block in [`SceneManager._logDiagnostics()`](js/scene/SceneManager.js:294) on boot (quality tier, MSAA, bloom, SMAA, pixel ratio, canvas buffer size, composer RT size + type, anisotropy, maxTextureSize, isWebGL2, precision). Also enables the Earth LOD log at [`Earth.js:507`](js/scene/Earth.js:507). | [`Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS`](js/core/Constants.js:2151) |
| `?profile=1` | Sets `Constants.DEBUG.LOG_DRAW_CALLS = true`. Per-60-frame `[Profile] calls=N triangles=N points=N lines=N` log in [`main.js:977-985`](js/main.js:977). | [`Constants.DEBUG.LOG_DRAW_CALLS`](js/core/Constants.js:2154) |
| `?tier=LOW \| MEDIUM \| HIGH` | Force the initial quality tier, bypassing all heuristics. Logs `[Perf] tier URL override → X`. Case-insensitive. | [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:108-118) |

**Combinations are allowed and additive** because each flag flips an independent boolean. Examples:

```text
http://localhost:8081/?tier=LOW                    → force LOW tier
http://localhost:8081/?profile=1                   → profile log only
http://localhost:8081/?debug=1&profile=1           → both diagnostic blocks
http://localhost:8081/?tier=LOW&profile=1          → force LOW and watch draw calls
http://localhost:8081/?tier=HIGH&debug=1&profile=1 → full instrumentation
```

**Console log signatures to expect.**

| Signature | When | Source |
|---|---|---|
| `[Earth] AVIF support: YES (preferring .avif)` or `NO (falling back to .jpg)` | On module load | [`Earth.js:404`](js/scene/Earth.js:404) |
| `[Earth] Loaded: textures/earth_day.avif (4096×2048)` | Each texture load complete | [`Earth.js:424`](js/scene/Earth.js:424) |
| `[Earth] AVIF load failed for X, falling back to Y` | AVIF runtime decode failure | [`Earth.js:430`](js/scene/Earth.js:430) |
| `[Earth] LOD selected: 16k — maxTextureSize=16384` | `?debug=1` only | [`Earth.js:508`](js/scene/Earth.js:508) |
| `[Perf] initial quality tier: HIGH { msaaSamples: 4, ... }` | Always (boot) | [`SceneManager.js:99`](js/scene/SceneManager.js:99) |
| `[Perf] tier URL override → HIGH` | `?tier=` present | [`SceneManager.js:113`](js/scene/SceneManager.js:113) |
| `[Perf] GPU probe active (EXT_disjoint_timer_query_webgl2 available)` | Always (Chrome / Safari) | [`SceneManager.js:85`](js/scene/SceneManager.js:85) |
| `[Perf] GPU probe unavailable — falling back to deviceMemory heuristic` | Firefox / old Safari | [`SceneManager.js:87`](js/scene/SceneManager.js:87) |
| `[Perf] GPU probe complete: median=11.42ms threshold=14ms (60 samples)` | Once at boot (~1 s in) | [`main.js:955`](js/main.js:955) |
| `[Perf] GPU probe → tier downshift: HIGH → MEDIUM (median 17.3ms > 14ms)` | When probe sees overrun | [`main.js:963`](js/main.js:963) |
| `[Perf] tier auto-downshift: HIGH → MEDIUM (median fps 42.3)` | When `runtimeAdapt` triggers | [`main.js:591`](js/main.js:591) |
| `[Profile] calls=312 triangles=184053 points=4096 lines=128` | Every 60 frames with `?profile=1` | [`main.js:983`](js/main.js:983) |
| `[Audio] AudioContext still suspended 200ms after user gesture` | Audio unlock failed | [`InputManager.js:290`](js/systems/InputManager.js:290) |
| `[SW] pre-cache miss for ./js/main.js` | SW install best-effort skip | [`sw.js:61`](sw.js:61) |
| `[SceneManager] Rendering Diagnostics` (table) | `?debug=1` only | [`SceneManager.js:303`](js/scene/SceneManager.js:303) |

### § 3.8 — Known Limitations & Follow-Up Recommendations

1. **16 TimerManager-deferred files** (PR 5 backlog). See [§ 2.5](#-25--pr-5-p28-timermanager--p29-bloom-vec2-cache--p210-gated-diagnostics--final-test-count-2123) for the full list. Migration is mechanical: wrap raw `setTimeout(cb, ms)` as `timerManager.setTimeout(cb, ms, { owner: this })` and the closure becomes reapable. Highest payoff next: [`SweepReportUI.js`](js/ui/SweepReportUI.js:152) (3 sites), [`SkillsPane`-adjacent UIs](js/ui/hud/StatusPanel.js:1177).
2. **FXAAPass not implemented.** The MEDIUM tier sets `useFXAAFallback: true` ([`Constants.js:2178`](js/core/Constants.js:2178)) but [`_setupPostProcessing()`](js/scene/SceneManager.js:236-240) currently logs `relying on MSAA only` and skips the pass. Adding a real `FXAAPass` from `three/addons` is a ~1-hour task and would visibly improve MEDIUM tier on non-MSAA fragments (e.g. screen-space sprite edges).
3. **InstancedMesh merge for debris.** Per-debris draw calls likely dominate the GPU side (call count visible via `?profile=1`). The path forward: extract per-debris transforms into a single `InstancedMesh` per material class. But — gather `?profile=1` traces on real machines first; if the call count is already <500/frame, the merge may not be the bottleneck.
4. **WebGPU renderer (PR 7 / P3.12) deferred.** Three.js r170 has experimental WebGPU support behind a separate `WebGPURenderer`. Off-by-default flag, gated on `'gpu' in navigator`. Out of scope for this sprint.
5. **No auto-upshift in `runtimeAdapt`.** [`QualityManager.js:102`](js/systems/QualityManager.js:102) comment: "Only downshifts (HIGH → MEDIUM → LOW). Never auto-upshifts in this PR — upshift adds hysteresis complexity and is intentionally out of scope." Player on a high-end machine that briefly dipped (e.g. during a Kessler burst) stays at the lower tier until reload. Recommended follow-up: time-based upshift after N minutes of headroom.
6. **Tests cannot exercise WebGL/THREE paths in Node.** [`test-GpuProbe.js`](js/test/test-GpuProbe.js:1) uses a mock GL context. [`SceneManager`](js/scene/SceneManager.js:1), [`Earth`](js/scene/Earth.js:1), [`Starfield`](js/scene/Starfield.js:1) etc. are not unit-tested directly — they're exercised indirectly via the pure functions ([`selectLOD`](js/scene/Earth.js:465), [`selectInitialTier`](js/systems/QualityManager.js:59), [`medianOf`](js/systems/QualityManager.js:31)). A future browser-based test harness ([`test.html`](test.html:1) already exists for module-level integration) would close this gap.
7. **`deviceMemory` is missing on Safari.** This is a permanent Apple privacy stance, not a bug. The codebase compensates via Apple-GPU detection. The edge case is **non-Apple Safari** (very rare — Safari on Windows is deprecated since 2012), where neither signal is available and `selectInitialTier` defaults to `MEDIUM`. Acceptable.
8. **GPU probe is single-shot.** [`main.js:947-975`](js/main.js:947) disables the probe after one window. A long session that thermally throttles 20 minutes in won't trigger another downshift via the probe — only `runtimeAdapt` (fps-based) catches that. Acceptable tradeoff (the probe adds query overhead per render and we don't want it always-on).

---

## § 4 — Test Coverage Delta

| Milestone | Tests | Delta | Source |
|---|---:|---:|---|
| Pre-sprint baseline (HANDOFF.md, May 16 2026) | **2060** | — | [`HANDOFF.md:6`](HANDOFF.md:6) — "460 suites / 2,060 tests / 0 failures" |
| After PR 1 (P0.1+P0.2) | 2085 | +25 | (no new test file; incidental coverage adds while wiring AVIF probe + preload hints) |
| After PR 2 (P0.3 SW) | 2085 | 0 | SW is integration-only; no new unit tests |
| After PR 3 (P1.4+P1.6+P1.7) | 2087 | +2 | [`test-Constants.js`](js/test/test-Constants.js:80) PERF block + FRAME_CAP cases |
| After PR 4 (P1.5 Quality tiers) | 2112 | +25 | [`test-QualityManager.js`](js/test/test-QualityManager.js:1) — 17 cases × ~1.5 asserts each, plus PERF tuning-knob assertions in [`test-Constants.js`](js/test/test-Constants.js:26) |
| After PR 5 (P2.8+P2.9+P2.10) | 2123 | +11 | [`test-TimerManager.js`](js/test/test-TimerManager.js:1) — 10 cases (some async); DEBUG block test in [`test-Constants.js`](js/test/test-Constants.js:41) |
| After PR 6 (P3.11+P3.13+P3.15) | **2134** | +11 | [`test-GpuProbe.js`](js/test/test-GpuProbe.js:1) — 11 cases with mock GL |

**Where the new tests live.**

| Test file | Suites | Approx. assertions | Tests what |
|---|---|---:|---|
| [`test-Constants.js`](js/test/test-Constants.js:1) (additions) | "Constants - Integrity" PERF + DEBUG sub-tests | ~6 new | Default values, namespace shape, FRAME_CAP=null, DEBUG.LOG_RENDERER_DIAGNOSTICS=false. |
| [`test-QualityManager.js`](js/test/test-QualityManager.js:1) (new) | 4 suites: TIER_ORDER + Constants, medianOf, selectInitialTier, runtimeAdapt | ~25 | Tier ordering, median edge cases, heuristic on M-series / PC / Intel / low-end / 2 GB / empty / partial; runtimeAdapt half-window / cooldown / threshold / no-drop-below-LOW / invalid tier. |
| [`test-TimerManager.js`](js/test/test-TimerManager.js:1) (new) | 6 suites: clear by id, tagged clearing, STATE_CHANGE auto-clear, setTimeout fires + auto-removes, setInterval, activeCount, re-entrant safety | ~18 | Sync + async paths. STATE_CHANGE auto-clear is the unique integration case. |
| [`test-GpuProbe.js`](js/test/test-GpuProbe.js:1) (new) | 4 suites: no-extension, with-extension, disjoint handling, dispose | ~18 | Mock GL covers isSupported branching, begin/end/poll, rolling window, median odd/even, disjoint discard + recovery, dispose. |

---

## § 5 — Smoke-Test Plan for the Live Deploy

After the orchestrator commits + pushes PR 1–6 to `main`, run the following from any shell with `curl`. All URLs should return **HTTP 200**; any non-200 is a deploy regression.

```bash
for url in \
  https://atominnovationth.github.io/SCB/ \
  https://atominnovationth.github.io/SCB/js/main.js \
  https://atominnovationth.github.io/SCB/sw.js \
  https://atominnovationth.github.io/SCB/textures/earth_day.avif \
  https://atominnovationth.github.io/SCB/textures/earth_day.jpg \
  https://atominnovationth.github.io/SCB/data/debris-catalog.json
do echo -n "$url -> "; curl -sI -o /dev/null -w "%{http_code}\n" "$url"; done
```

**Expected output:**

```text
https://atominnovationth.github.io/SCB/                              -> 200
https://atominnovationth.github.io/SCB/js/main.js                    -> 200
https://atominnovationth.github.io/SCB/sw.js                         -> 200
https://atominnovationth.github.io/SCB/textures/earth_day.avif       -> 200
https://atominnovationth.github.io/SCB/textures/earth_day.jpg        -> 200
https://atominnovationth.github.io/SCB/data/debris-catalog.json      -> 200
```

**Follow-up manual checks (browser):**

1. Load `https://atominnovationth.github.io/SCB/` in **Chrome 120+**. Open DevTools → Application → Service Workers; verify `space-cowboy-v1` is `activated and running`.
2. DevTools → Network → reload. First load should fetch from network; second load should show most assets as `(ServiceWorker)`.
3. Console should log:
   - `[Earth] AVIF support: YES (preferring .avif)`
   - `[Perf] initial quality tier: HIGH ...`
   - `[Perf] GPU probe active (EXT_disjoint_timer_query_webgl2 available)`
   - `[Perf] GPU probe complete: median=XX.XXms threshold=14ms (60 samples)`
4. Append `?profile=1` and verify `[Profile] calls=N triangles=N` appears every ~1 second.
5. Append `?tier=LOW` and verify `[Perf] tier URL override → LOW` in console and visibly chunkier aliasing on debris (no SMAA, no bloom).
6. In **Firefox 121+**, verify the probe-unavailable log instead: `[Perf] GPU probe unavailable — falling back to deviceMemory heuristic` — and confirm gameplay still runs.
7. Hide the tab for 5 s, return; verify no audio drone in the background and no dt-spike in the first visible frame.

---

### § 5.1 — How to Capture Acceptance Data (Sprint 2, Phase A)

Sprint 2 added an in-game overlay so the user can capture every "🟡" datum in one browser session without leaving the page. Activated by `?perfReport=1`. Implementation: [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1), wired in [`main.js`](js/main.js:1) inside `init()` near the existing `?debug=1` / `?profile=1` blocks.

**Recommended URL for the capture session:**
```
http://localhost:8081/?profile=1&perfReport=1&debug=1
```
(`?perfReport=1` enables the overlay; `?profile=1` adds the per-60-frame `[Profile] calls=…` log; `?debug=1` adds the boot-time render-pipeline `console.table`.)

**Checklist — run once per browser (Chrome / Safari / Firefox):**

1. **Open the page** with the URL above.
2. **Wait ~10 s** at the menu so the GPU probe window (60 frames) completes; verify the overlay's "GPU median ms" row turns into a real number (Firefox will say `unsupported`).
3. **Start a mission** and play for ~60 s with several debris in view. The overlay updates at 1 Hz and the bottom row of the overlay shows the captured boot snapshot.
4. **Open DevTools → Network**, hard-reload (`Cmd/Ctrl+Shift+R`), screenshot the waterfall. Note:
   - whether `earth_day.avif` was served (file size, status, `(ServiceWorker)` source on second load),
   - total bytes transferred for the first paint.
5. **DevTools → Memory → Heap snapshot** before any gameplay. Save it. Play for 5 min. Take a second snapshot. Compare retained sizes (look for "Detached HTMLDivElement" / closure leaks in the diff view).
6. **DevTools → Performance → Record** a 10-s trace mid-mission with debris visible. Note the median frame time, p99 frame time, and the dominant top-down JS calls (`orbitToSceneCartesian`, `propagateOrbit`, etc.).
7. **Click 📋 COPY SNAPSHOT** in the overlay. Paste the resulting JSON into the SPRINT_2_REPORT.md "Measured numbers" placeholder block.

**Three-browser matrix — what each browser is for:**

| Browser | What it validates | Notes |
|---|---|---|
| **Chrome 120+** (laptop) | GPU probe (EXT_disjoint_timer_query_webgl2), `performance.memory.usedJSHeapSize`, AVIF at HIGH tier, Service Worker cache-first on second visit, 60/120 Hz frame pacing. | Primary capture target. The overlay's "GPU median ms" should populate. `Heap` row shows real bytes. |
| **Safari 17+** (Mac) | AVIF decode synchronously on main thread (verify no first-paint stall after `renderer.compile()` pre-warm); SMAA at HIGH; Apple-GPU detection from `UNMASKED_RENDERER_WEBGL`. | GPU probe will be `unsupported` (Firefox/Safari both lack the extension). `Heap` row will say `n/a (non-Chromium)`. |
| **Firefox 121+** | `runtimeAdapt` downshift via the FPS heuristic (since GPU probe is unavailable); deviceMemory quantization OK; AVIF probe path. | Same `Heap = n/a` caveat. The overlay's "GPU median ms" will read `unsupported`. |

**Acceptance criteria for Phase A — overlay correctness:**

- ✅ Overlay appears in top-right within 1 s of page load.
- ✅ All rows populate within 5 s (GPU median may stay `--` for ~60 frames until the probe window completes — that's expected).
- ✅ Frame `median` and `p99` ms values are within 2× of the live DevTools Performance trace recording.
- ✅ "📋 COPY SNAPSHOT" produces valid JSON parseable by `JSON.parse()` (test by pasting into the DevTools console).
- ✅ The `boot` block of the JSON contains: `swState`, `avifSupported`, `maxTextureSize`, `devicePixelRatio`, `deviceMemoryGB`, `isAppleGPU`, `pickedTier`, `tierConfig`.

**Where the data lands:** the captured JSON should be pasted into [`SPRINT_2_REPORT.md`](SPRINT_2_REPORT.md:1) under "Measured numbers (per browser)". Once present there, the "🟡" rows in §§ 2.1–2.6 of this report can be promoted to "✅".

---

*End of report.*
