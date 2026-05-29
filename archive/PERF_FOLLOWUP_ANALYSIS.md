# Space Cowboy — Perf Follow-Up Analysis

*Static analysis only — no runtime measurements. Cites line numbers as of 2026-05-22. Companion to [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1).*

---

## § 1 — Executive Verdict

**Headline:** PRs 1–6 captured roughly **70–80 %** of the practically achievable laptop-perf gains. The *biggest* first-load win (AVIF) and the *biggest* stability win (hidden-tab pause + 120 Hz fix + tier auto-downshift) have shipped. **Yes, there are real wins left** — but they are smaller, more invasive, and live mostly inside the hot per-frame allocation path and shader cost, not in low-hanging fruit.

| Value vector | Status | Notes |
|---|---|---|
| First-load bandwidth | **Mostly done** | AVIF + preload hints + SW cache. Remaining: dynamic-import 5–6 boot-screen modules. |
| Sustained FPS | **Partially done** | Tier system ships, GPU probe ships. Remaining: per-frame object-literal allocations in [`OrbitalMechanics.orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:490) (called per-debris per-frame), Earth fragment-shader cost, no FXAA at MEDIUM. |
| Repeat-visit TTI | **Mostly done** | SW network-first HTML/JS + cache-first textures/CDN. No further wins on GH Pages. |
| GC / jank tail | **Partially done** | TimerManager solves leaked-closure class. Untouched: per-frame `{position:{x,y,z}, velocity:{x,y,z}}` literals from orbit propagation (~30k–100k allocs/sec at 50–300 alive debris × 60 fps). |

**Bottom line.** A second sprint is worth running, but it should be **half the size** of the first and focus on three things: kill the `orbitToSceneCartesian` allocation churn, implement `runtimeAdapt` upshift, and shed the Earth fragment-shader cost at LOW tier. Everything else in the deferred list is either polish (timer migrations) or speculative (WebGPU). The single highest-ROI move is **migrating `orbitToSceneCartesian` and `keplerianToCartesian` to scratch-output objects** — see § 3.1.

---

## § 2 — Risk/Reward of the 6 Deferred Items

| # | Item | Effort (h) | Gain (★/5) | User-visible impact | Risk | Priority |
|--:|---|---:|:--:|---|---|---|
| 1 | **PR 7 / WebGPU `?gpu=webgpu` flag** | 24–60+ | ★★ (long term, mostly Chrome) | None today | High — surface huge, three.js WebGPU still beta | **DEFER** |
| 2 | **16 TimerManager-deferred files** | 4–6 (all 16) | ★ | None | Very low | **DO LAST (drop most)** |
| 3 | **FXAA pass for MEDIUM tier** | 2–4 | ★★ | Reduced aliasing on Iris Xe-class GPUs | Low (just plug `FXAAShader` into composer) | **DO NEXT** |
| 4 | **InstancedMesh merge for debris** | 8–16 | ★★ | Fewer draw calls; ~5 fps on iGPU | Medium — UV remap + per-instance colour | **GATE on `?profile=1` data** |
| 5 | **Auto-upshift in `runtimeAdapt`** | 3–5 | ★★★ | Player who closes Kessler view recovers HIGH | Medium — needs hysteresis to avoid oscillation | **DO NEXT** |
| 6 | **Browser-side acceptance checks** | 4–8 | n/a (validation) | n/a | n/a | **DO NOW** (everything else is theoretical until this runs) |

### § 2.1 — WebGPU renderer (DEFER)
- **Pros:** Future-proofing; compute shaders unlock GPU-side orbital prop; 10–30 % wins on Chrome 120+ with native WebGPU drivers.
- **Cons:** three.js WebGPU renderer (`WebGPURenderer`) is still under active churn; Safari is gated behind a flag through 2026; Firefox WebGPU shipped in 121 but only on Windows/Mac. Our entire post chain ([`SceneManager._setupPostProcessing()`](js/scene/SceneManager.js:179)) would need a parallel WebGPU implementation. Bloom + SMAA on WebGPU still rough.
- **Estimated effort:** 24 h minimum stub, 60+ h for parity with the existing WebGL2 chain.
- **Recommendation:** Defer until three.js r170+ stabilises WebGPU. Today the ROI is ★★ at best because all our perf-sensitive users (low-end Intel iGPUs) won't have working WebGPU drivers anyway.

### § 2.2 — 16 TimerManager-deferred files (mostly DROP)
Classified by use-pattern:

| Pattern | Files | Risk |
|---|---|---|
| **Bursty UI fade/dismiss** (one-shot, ≤ 1 active at a time, lifetime < 3 s) | [`MenuScreen.js:260`](js/ui/MenuScreen.js:260), [`ShopScreen.js:662`](js/ui/ShopScreen.js:662), [`GameOverScreen.js:299`](js/ui/GameOverScreen.js:299), [`BriefingScreen.js:366`](js/ui/BriefingScreen.js:366), [`SweepReportUI.js:153`](js/ui/SweepReportUI.js:153), [`CodexViewerUI.js:60`](js/ui/CodexViewerUI.js:60), [`TeachingOverlay.js:208`](js/ui/TeachingOverlay.js:208), [`StatusPanel.js:1177`](js/ui/hud/StatusPanel.js:1177) | Zero |
| **One-shot game tick** (decay, debounce — bounded count) | [`MissionEventSystem.js:292`](js/systems/MissionEventSystem.js:292), [`ResourceSystem.js:581`](js/systems/ResourceSystem.js:581), [`CatalogLoader.js:35`](js/systems/CatalogLoader.js:35) | Zero (CatalogLoader pairs with `clearTimeout`) |
| **Staggered batch** (≤ 10 timers per scan, all fire within 1.2 s) | [`SensorSystem.js:538`](js/systems/SensorSystem.js:538) | Zero |
| **Input chord / windup** (paired with explicit `clearTimeout`) | [`InputManager.js:949`](js/systems/InputManager.js:888), [`InputManager.js:1059`](js/systems/InputManager.js:888) | Zero |
| **Strut deploy stagger** (bounded by arm count) | [`ArmManager.js:1070`](js/entities/ArmManager.js:1070), [`ArmManager.js:1100`](js/entities/ArmManager.js:1070) | Zero |
| **Per-arm pilot nudge** (capped to 3 invocations total) | [`ArmUnit.js:2339`](js/entities/ArmUnit.js:2339), [`ArmUnit.js:2405`](js/entities/ArmUnit.js:2339) | Zero |
| **One-shot boot** | [`main.js:497`](js/main.js:482) (loading-screen remove) | Zero |

**Verdict.** None of these are hot per-frame paths. The original audit's "leaked closure on ghost DOM node" risk was real for the *5 migrated* files (audio, HUD, GameFlow), all of which fired hundreds of timers per session. The remaining 16 collectively fire **<30 timers per session**, almost all one-shot, almost all DOM-lifetime-bound, and most don't even live across state changes. **Migrating them is mechanical busywork with no measurable gain.** Migrate maybe 2–3 (`InputManager._cHoldTimeout` and `_lassoWindupTimeout` since they can race state changes; and `ArmUnit` pilot-nudges since they cross multiple FSM states). **DROP the rest.**

### § 2.3 — FXAA at MEDIUM (DO NEXT)
- **Pros:** Single fullscreen pass, ~0.3 ms GPU on Iris Xe. MEDIUM tier currently emits `[Perf] MEDIUM tier: FXAA fallback selected but not implemented` ([`SceneManager.js:236`](js/scene/SceneManager.js:204)) which is bad UX honesty: the tier advertises post-AA but has none.
- **Cons:** Slight blur vs. SMAA. Need to import `FXAAShader` + `ShaderPass` from three/addons.
- **Effort:** 2 h for the swap, 1–2 h to verify in the composer pipeline.
- **Recommendation:** **DO NEXT.** Closes a public TODO and gives MEDIUM-tier users actual anti-aliasing.

### § 2.4 — InstancedMesh merge for debris (GATE)
- **Pros:** Currently one InstancedMesh per `(type, material, variant)` key — comment in [`DebrisField.js:634`](js/entities/DebrisField.js:634) estimates 20–30 draw calls. Merging to a single atlas-textured InstancedMesh cuts that to **one** draw call for all debris.
- **Cons:** Requires UV remapping (atlas already exists at [`DebrisTextureAtlas.js`](js/ui/DebrisTextureAtlas.js:1)), per-instance colour attribute (already exists for MOID badges — see `_moidTmpColor`), and rewriting the flag overlay logic. Non-trivial.
- **Effort:** 8–16 h.
- **Recommendation:** **GATE on `?profile=1` data.** If `[Profile] calls=…` log routinely shows >250 draw calls, this becomes ★★★★. If it shows <80, **DROP** — modern GPUs swallow 30 extra draws for free.

### § 2.5 — Auto-upshift in `runtimeAdapt` (DO NEXT)
- **Pros:** Today a player who survives a 200-fragment Kessler burst gets downshifted permanently — even after the cluster decays, they stay on LOW until reload. Auto-upshift fixes this asymmetry. The cooldown + hysteresis pattern is already there; we just need an inverse threshold (e.g., median ≥ 58 fps for 600 frames → upshift one step).
- **Cons:** Risk of oscillation (HIGH ↔ MEDIUM ping-pong if the workload is exactly threshold). Mitigated by a wider hysteresis band: downshift at 50, upshift only above 58.
- **Effort:** 3 h code + 2 h tests (current [`test-QualityManager.js`](js/test/test-QualityManager.js:1) covers the downshift cases — mirror them).
- **Recommendation:** **DO NEXT.** High user-visible value, low risk.

### § 2.6 — Browser-side acceptance checks (DO NOW)
- **Pros:** Without DevTools verification, every "🟡" row in [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1) (~12 rows) remains theoretical. SW caching, 120 Hz histogram, memory leak after 5-min play+quit, AVIF first-paint MB — all need a real browser session.
- **Cons:** Manual, time-boxed. Not code.
- **Effort:** 4–8 h with one Chrome + one Safari + one Firefox session.
- **Recommendation:** **DO NOW, before any more code.** This is the cheapest, most decision-critical work in the entire deferred list.

---

## § 3 — Low-Hanging-Fruit Hunt: NEW Findings

### § 3.1 — Render-loop allocations: the big one (★★★★★)

**Finding.** [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:490) and [`keplerianToCartesian()`](js/entities/OrbitalMechanics.js:76) return **fresh object literals** on every call: `{ position: {x,y,z}, velocity: {x,y,z} }` plus an `orbitToKm()` spread copy. They are called:

| Caller | Frequency | Per-frame allocs (50–300 alive debris) |
|---|---|---:|
| [`DebrisField._updateInstanceTransform()`](js/entities/DebrisField.js:1228) | per alive debris per frame | **150–900** |
| [`DebrisField._updateBackground()`](js/entities/DebrisField.js:1329) + spread copy at [`line 1322`](js/entities/DebrisField.js:1322) | 1/4 of background per frame | **~125 + 125 spread copies** |
| [`AutopilotSystem._resolveTargetState()`](js/systems/AutopilotSystem.js:807) | per AP tick | 3–9 |
| [`TargetReticle.update()`](js/ui/TargetReticle.js:673) | per visible target | 5–15 |
| [`main.js:752`](js/main.js:482) approach distance | per frame | 1 |

**Total estimate:** ~30 k–100 k object literals/sec at typical mission load. Each literal allocates 6 numbers + 2 inner objects + an outer object ≈ 64–96 bytes. **At the upper end ≈ 6–9 MB/sec of short-lived heap** = a minor GC roughly every 5–10 seconds.

**Pre-allocated scratch infrastructure already exists in [`DebrisField.js`](js/entities/DebrisField.js:193) (`_tempMatrix`, `_tempPos`, `_tempQuat`, `_tempScale`).** What's missing is a `keplerianToCartesianInto(orbit, outPos, outVel)` variant that writes into caller-provided scratch objects.

- **Effort:** 4–6 h (refactor signature, add scratch outputs, update 6 call sites).
- **Gain:** ★★★★★ — eliminates the largest single source of per-frame GC pressure.
- **Recommendation:** **File now.** This is the highest ROI in the entire follow-up.

> *Note: per-frame Vector3/Quaternion/Matrix4 allocations in [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:413) (relP, relV, goalDir, dvCmd — 4–6 `new THREE.Vector3` per tick) and [`PlayerSatellite._updateRotation()`](js/entities/PlayerSatellite.js:2787) (5–8 per tick) are real but much smaller — covered as ★★ items in § 5. The bulk path is `orbitToSceneCartesian`.*

### § 3.2 — HUD DOM thrash + forced layout (★★)

**Finding.** [`HUD.update()`](js/ui/HUD.js:835) calls [`this.panels.comms.getBoundingClientRect()`](js/ui/HUD.js:841) **every frame** to recompute the right-column top position. `getBoundingClientRect()` forces a synchronous layout if any DOM has been mutated since the last frame — and StatusPanel does mutate (textContent writes at [`StatusPanel.js:807-810`](js/ui/hud/StatusPanel.js:1)).

The rest of HUD is well-throttled: resources at 10 Hz, targets at 2 Hz, target-info on change only. StatusPanel writes are gated behind the 10 Hz cadence so the per-frame layout-flush is the one outlier.

- **Effort:** 1 h — cache the comms-panel rect; recompute only on window resize OR comms-panel display change (already an event boundary).
- **Gain:** ★★ — saves ~0.2–0.5 ms/frame on dense missions where StatusPanel writes happen on the same frame.
- **Recommendation:** **File as follow-up subtask.**

**Other panels checked, all clean:** [`NavSphere.update()`](js/ui/NavSphere.js:233) uses pre-allocated `_right`/`_up`/`_forward`/`_tmpDir`/`_eqDir`. [`TargetReticle`](js/ui/TargetReticle.js:332) uses `_tempVec3`/`_tempVec4`/`_projMatrix`. [`StatusPanel.update()`](js/ui/hud/StatusPanel.js:1) writes `textContent` unconditionally rather than diffing — a low-priority polish item (★) — but the writes are 10 Hz so net impact is small.

### § 3.3 — Texture atlas opportunities (★)

[`DebrisTextureAtlas.js`](js/ui/DebrisTextureAtlas.js:1) already exists and is wired into debris meshes. Checked the obvious extension candidates:

| Module | Atlas opportunity? |
|---|---|
| [`ActiveSatellite.js`](js/entities/ActiveSatellite.js:1) | Uses procedural materials, no separate small textures. **No win.** |
| [`Starfield.js`](js/scene/Starfield.js:1) | Stars are `THREE.Points` with shader-based colour, no texture atlas needed. **No win.** |
| [`FlagDecalSystem.js`](js/ui/FlagDecalSystem.js:1) | Flags rendered as InstancedMesh with type atlas already (verified at [`DebrisField.js:1149`](js/entities/DebrisField.js:1149)). **Already atlas-merged.** |
| [`SunLight.js`](js/scene/SunLight.js:1) | Sun, moon, planet sprites — each uses a canvas-generated gradient texture. **Could atlas** the planet sprites (6 of them) but ★ gain only. |

**Verdict:** Atlas opportunities are mostly already exploited. No high-ROI work here. **DROP.**

### § 3.4 — Frustum culling / LOD (★)

Many objects have `frustumCulled = false`: debris instanced meshes ([`DebrisField.js:708`](js/entities/DebrisField.js:634)), flag meshes ([`DebrisField.js:797`](js/entities/DebrisField.js:634)), starfield ([`Starfield.js:265`](js/scene/Starfield.js:1)), lasso trail points, capture-net tether, sun/moon labels.

**Most are correct** — `Points` and arcs that span the screen, or InstancedMeshes whose bounding spheres are useless because individual instances are scattered across thousands of km.

**One real opportunity:** [`ArmUnit.tetherLine`](js/entities/ArmUnit.js:655) sets `frustumCulled = false` defensively, but tether segments are short (<1 km) and could be safely frustum-culled with a recomputed bounding box. ★ gain (saves ≤ 1 draw per arm when off-screen).

**Debris LOD already exists** at [`DebrisField._updateInstanceTransform():1243-1271`](js/entities/DebrisField.js:1243): scale-to-zero past 50 km, half-scale past 5 km. A billboard-replacement at the far tier would save vertex work but the current InstancedMesh+scale-zero already skips rasterization. **DROP.**

### § 3.5 — Audio oscillator cost (★ → ★★ on Safari)

[`AudioSystem.js`](js/systems/AudioSystem.js:1) creates fresh `ctx.createOscillator()` / `ctx.createBufferSource()` for every SFX (~50+ call sites). **Not pooled.** Each oscillator auto-cleans-up via Web Audio (`osc.stop(now+dur)` schedules teardown).

This is **OK for one-shot SFX** (button clicks, captures, hits) — those are 0.05–1 s and Web Audio garbage-collects them. But the persistent loops (thruster hum, dvAlarm, ambient, forge hum, alignment tone) are already correctly *not* recreated per call — they use `_thrusterGain`/`_dvAlarmInterval`/etc. cached refs.

**Real risk:** on Safari, allocating many short oscillators (e.g., during a debris-collision burst with 20+ hits in 2 s) can spike main-thread CPU. Pooling 5–10 reusable oscillators per type would help, but the API doesn't allow restarting a stopped oscillator — you'd need a pool of `OscillatorNode`s pre-created, each used once, then replaced asynchronously. Non-trivial.

- **Effort:** 6–10 h for proper pooling.
- **Gain:** ★ on Chrome/Firefox; ★★ on Safari iOS in dense audio bursts.
- **Recommendation:** **DEFER** unless `?profile=1` shows audio in the main-thread top-10 during gameplay. Web Audio's auto-cleanup is genuinely fine for our shot rate.

### § 3.6 — Catalog / data loading (★)

From [`data/META.json`](data/META.json:1): 107 debris + 51 active sats + 30 launches + 18 weather + 24 ground stations + 10 constellations + 3 news = **243 records total** across 7 JSON files. Even uncompressed these total well under 200 KB.

[`CatalogLoader.js:35`](js/systems/CatalogLoader.js:35) wraps a single `fetch` with a timeout. SW caches `/data/` cache-first ([`sw.js`](sw.js:1)). One fetch, one parse, one boot — already optimal.

**No streaming/chunking needed.** **DROP.**

### § 3.7 — Web Worker offload candidates (★★★)

Strong candidates — both pure-CPU, both with minimal renderer coupling:

| Candidate | Why it qualifies | Why it would help | Effort |
|---|---|---|---:|
| [`MoidCalculator.computeMOID()`](js/systems/MoidCalculator.js:1) | Pure-math (no THREE), already dynamically imported by [`ConjunctionSystem.js:24`](js/systems/ConjunctionSystem.js:1) | Currently can be called for every alert-band debris on conjunction check; spikes the main thread on bursts | 6–8 h (postMessage protocol + result-cache map) |
| [`OrbitalMechanics.propagateOrbit()`](js/entities/OrbitalMechanics.js:1) for the *background* debris (BACKGROUND_COUNT/4 per frame in [`DebrisField._updateBackground()`](js/entities/DebrisField.js:1306)) | Pure-math; results only feed `posAttr.setXYZ()` so a SharedArrayBuffer or transfer-list round-trip works | Frees the main thread of the background-prop loop entirely | 10–14 h (SharedArrayBuffer setup, fallback when SAB unavailable, etc.) |
| [`KesslerSystem`](js/systems/KesslerSystem.js:1) cascade simulation | Event-driven, only fires on collision | **Not worth it** — it's tiny and infrequent | Drop |

- **Recommendation:** **File MoidCalculator-in-worker as a follow-up subtask** (the ★★★ win). Background-prop in worker is ★★★ too but the SharedArrayBuffer dance is non-trivial; gate on `?profile=1` data first.

### § 3.8 — Particle / trail systems (★)

| System | Strategy | Verdict |
|---|---|---|
| [`TrailSystem.js`](js/ui/TrailSystem.js:1) | Single `THREE.Line` with `BufferGeometry`, [`computeBoundingSphere()`](js/ui/TrailSystem.js:417) on update | Already buffered. Clean. |
| [`VelocityStreaks.js`](js/ui/VelocityStreaks.js:1) | Canvas 2D streaks | Cheap, no GPU buffer churn. Clean. |
| [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) | `THREE.Points` for net particles, pre-allocated scratch vectors `_v3a`/`_v3b` ([`line 36`](js/ui/CaptureNetVisual.js:35)) | Already optimised. Clean. |
| [`LassoSystem`](js/systems/LassoSystem.js:1) trail points | Single `THREE.Points` with `frustumCulled = false` | Clean. |
| Background debris `THREE.Points` ([`DebrisField._updateBackground`](js/entities/DebrisField.js:1306)) | Single Points geometry, batched 25%/frame | Already optimised. Only fix is `_updateBackground`'s `{...orbit}` spread copy (covered in § 3.1). |

**DROP** as its own line item — covered by § 3.1.

### § 3.9 — Network / asset side: dynamic imports (★★)

Boot-time static loads of these screen modules in [`main.js`](js/main.js:1):

| Module | Static today? | First needed at | Lazy-loadable? |
|---|---|---|---|
| [`MenuScreen.js`](js/ui/MenuScreen.js:1) | Yes | t=0 (menu) | No — first paint |
| [`BriefingScreen.js`](js/ui/BriefingScreen.js:1) | Yes | After "START" | **Yes** — 2–4 s gap to load |
| [`ShopScreen.js`](js/ui/ShopScreen.js:1) | Yes | After first mission complete | **Yes** — minutes later |
| [`GameOverScreen.js`](js/ui/GameOverScreen.js:1) | Yes | Game-over event | **Yes** — minutes later |
| [`CodexViewerUI.js`](js/ui/CodexViewerUI.js:1) | Yes | First Tab press | **Yes** |
| [`SweepReportUI.js`](js/ui/SweepReportUI.js:1) | Yes | End of mission | **Yes** |
| [`StrategicMap.js`](js/ui/StrategicMap.js:1) | Already dynamic via `await import('three')` at [`line 29`](js/ui/StrategicMap.js:1) | First map open | Already done |

Converting these 5 modules to `await import(...)` on first use saves maybe **40–80 KB minified** from the initial JS bundle (rough estimate from file-size order). Combined with the SW cache, the second visit is unaffected; the first visit shaves 200–400 ms on a 3G/4G connection.

- **Effort:** 3–5 h (need to defer the listener-registration calls too, e.g., `commsSystem.on(...)` for shop unlocks).
- **Gain:** ★★ on cold cache / mobile networks; ★ on the desktop laptop persona.
- **Recommendation:** **File as follow-up subtask** but lower priority than § 3.1 and FXAA.

> *Brotli on GH Pages:* GitHub Pages does serve Brotli for `.js`/`.css` when the client `Accept-Encoding` header includes it (gzip + brotli both supported). Not in our control to *configure*, but it's already happening. **DROP.**

### § 3.10 — Shader hot spots (★★★)

[`Earth.js`](js/scene/Earth.js:1) fragment shader at [`lines 100–117`](js/scene/Earth.js:100):

- `terrainDetail()` runs **5 octaves** of simplex noise per fragment.
- `detailTiling()` adds **2 more octaves** at higher frequency.
- Both fade with view distance, but `detailFade > 0` whenever you're within ~300 km, i.e., **the entire LEO gameplay range**.
- Each octave is ~50 GPU ops (3D simplex). **7 octaves × ~50 ops × N fragments** is the dominant fragment cost when looking at Earth — and Earth fills 30–60 % of the screen at typical LEO altitude.

**Fix:** At LOW tier, replace `terrainDetail` with a 2-octave variant (or skip it entirely — the base 8k/16k texture is already detailed); skip `detailTiling` outright. This is a **defines-driven shader variant** ([`SceneManager.applyTier()`](js/scene/SceneManager.js:275) already swaps composer; needs to also swap Earth material's shader defines).

- **Effort:** 3–5 h (add `#define LOW_DETAIL` branch in [`Earth.js`](js/scene/Earth.js:36); plumb through tier).
- **Gain:** ★★★ on iGPUs at LOW tier (could be 2–4 ms/frame). ★ on M-series / discrete GPUs.
- **Recommendation:** **File as follow-up subtask.**

[`Starfield.js`](js/scene/Starfield.js:1) shader is a `THREE.Points` material with shader-based size attenuation and bloom — already cheap. No win.

---

## § 4 — Browser-Specific Gotchas

| Browser | Gotcha | Already handled? |
|---|---|---|
| **Safari (all)** | `AudioContext.resume()` returns without resuming until a real user gesture; Brave shields silently block | ✅ [`AUDIO_UNLOCK_FAILED`](js/core/Events.js:540) toast (PR 6) |
| **Safari (all)** | `navigator.deviceMemory` is `undefined` (privacy) | ✅ [`selectInitialTier()`](js/systems/QualityManager.js:59) falls through to Apple-GPU detection |
| **Safari (iOS/iPadOS)** | Per-tab WebGL2 memory limits (≈ 256–512 MB on older iPhone); large 16k textures may silently fall back | 🟡 [`Earth.selectLOD()`](js/scene/Earth.js:506) picks lower LOD on small `maxTextureSize` but does not check actual VRAM ceiling. **Low priority** — iOS users are not the laptop persona. |
| **Safari** | Texture upload is **synchronous on the main thread** — large AVIF decodes can stall the first paint | 🟡 AVIF decode is async via `Image.decode()` ([`Earth.js:389`](js/scene/Earth.js:1)); first-frame upload still blocks. Mitigated by `renderer.compile()` pre-warm. |
| **Firefox** | `EXT_disjoint_timer_query_webgl2` **permanently disabled** (fingerprinting) | ✅ [`GpuProbe.isSupported = false`](js/systems/GpuProbe.js:67) fall-through to fps-based `runtimeAdapt` |
| **Firefox** | `navigator.deviceMemory` values are quantized (0.25, 0.5, 1, 2, 4, 8) | ✅ Heuristic uses `>=` thresholds, quantization is fine |
| **Chrome on iGPU** | Thermal throttling causes mid-session fps drops | ✅ `runtimeAdapt` downshift handles it (PR 4) |
| **Chrome ≥ 119** | `WEBGL_debug_renderer_info` deprecation discussed but not yet shipped; renderer string may return generic `"ANGLE"` | 🟡 [`SceneManager._detectInitialTier():131`](js/scene/SceneManager.js:128) reads `UNMASKED_RENDERER_WEBGL`; if the string is generic, Apple-GPU detection silently returns `false` and we fall through to MEDIUM. Not a regression, just an under-promotion risk for M-series users behind ANGLE. **Low priority.** |
| **All modern browsers** | Battery Status API removed | ✅ No code in this repo references `navigator.getBattery()` (verified — zero matches in workspace grep). |

---

## § 5 — Ranked Action Plan (top 10 by ROI)

| Rank | Item | Source | Effort (h) | Gain | Next step |
|---:|---|---|---:|:--:|---|
| 1 | **Browser-side acceptance checks** (DevTools SW, 120 Hz histogram, 5-min memory leak, AVIF first-paint) | § 2.6 | 4–8 | (validation) | Schedule a 1-day session with Chrome + Safari + Firefox |
| 2 | **`orbitToSceneCartesian` → scratch-output refactor** ([`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:490)) | § 3.1 NEW | 4–6 | ★★★★★ | Add `keplerianToCartesianInto(orbit, outPos, outVel)`; update 6 call sites |
| 3 | **Auto-upshift in `runtimeAdapt`** ([`QualityManager.js`](js/systems/QualityManager.js:116)) | § 2.5 deferred | 3–5 | ★★★ | Mirror downshift tests + hysteresis band (50/58) |
| 4 | **Earth fragment shader LOW-tier variant** ([`Earth.js`](js/scene/Earth.js:100)) | § 3.10 NEW | 3–5 | ★★★ | `#define LOW_DETAIL` short-circuit for `terrainDetail` + `detailTiling` |
| 5 | **FXAA pass at MEDIUM** ([`SceneManager.js:204`](js/scene/SceneManager.js:204)) | § 2.3 deferred | 2–4 | ★★ | Plug `FXAAShader` + `ShaderPass` into composer when `useFXAAFallback` |
| 6 | **MoidCalculator in Web Worker** ([`MoidCalculator.js`](js/systems/MoidCalculator.js:1)) | § 3.7 NEW | 6–8 | ★★★ | postMessage protocol; result cached by (orbitA, orbitB) hash |
| 7 | **Cache `getBoundingClientRect` in HUD.update** ([`HUD.js:841`](js/ui/HUD.js:1)) | § 3.2 NEW | 1 | ★★ | Recompute only on resize + comms-display change events |
| 8 | **Dynamic-import boot-time screen modules** (Shop, Codex, Sweep, GameOver, Briefing) | § 3.9 NEW | 3–5 | ★★ | Wrap first-use sites with `await import(...)`; defer event subscriptions |
| 9 | **InstancedMesh merge for debris** ([`DebrisField.js:634`](js/entities/DebrisField.js:634)) | § 2.4 deferred | 8–16 | ★★–★★★ | **GATE** on `?profile=1` showing >250 draw calls |
| 10 | **Per-frame Vector3 alloc cleanup in AutopilotSystem + PlayerSatellite** | § 3.1 follow-on | 3–5 | ★★ | Reuse `_tmpV1`/`_tmpV2`/`_tmpV3` (already exist in [`AutopilotSystem.js:106`](js/systems/AutopilotSystem.js:105) — just need to route 4–6 sites through them) |

**Dropped from consideration** (★ or worse, or no measurable gain): 16 deferred TimerManager files (except 2–3 borderline ones in § 2.2), WebGPU renderer, audio oscillator pooling, texture atlas beyond debris, frustum culling beyond tether, catalog streaming, Brotli (already on).

---

## § 6 — Sprint 2 Recommendation

**Yes, run a second sprint — but scope it tight (1 week / 5 PRs).**

**Scope:** items 1–5 from § 5 (validation + the four highest-ROI code items). Items 6–8 are excellent ★★★ candidates that would extend the sprint to 2 weeks; consider them stretch goals only if items 1–5 ship under budget. Items 9–10 are conditional (9 on `?profile=1` data; 10 is a cleanup task that pairs naturally with item 2).

**Estimated total effort:** 16–28 h for items 1–5. Single-developer week.

**Expected outcome:** the `orbitToSceneCartesian` refactor (item 2) is the headline — it should visibly reduce GC sawtooth in a DevTools Performance trace and improve 99th-percentile frame time on dense missions. Auto-upshift (item 3) closes a UX wart. Earth shader LOW variant (item 4) makes the LOW tier actually pay back its visual cost. FXAA (item 5) closes a TODO comment that currently reads "lol no" to anyone running MEDIUM.

**Do not run Sprint 2 without first completing item 1.** Every "🟡" row in [`PERF_SPRINT_REPORT.md`](PERF_SPRINT_REPORT.md:1) is currently unmeasured. Decisions like "is InstancedMesh merge worth 8–16 h" depend entirely on `?profile=1` data we do not yet have.

---

### Methodology / honesty notes

- All percentages and ★ ratings are **inference** based on static code reading. No browser traces were collected for this analysis.
- Allocation counts in § 3.1 (30 k–100 k/sec, 6–9 MB/sec) assume 50–300 alive debris × 60 fps × 6 object literals per `orbitToSceneCartesian` call site. Lower-bound assumes 50 debris, no AP active, no target reticle. Upper-bound assumes 300 debris, AP active, target locked. **Real measurements would land within this range but the exact value is unknown.**
- Effort estimates are for an engineer familiar with the codebase. Add 50 % buffer for a new contributor.
- "★★ to ★★★★★" ratings are relative within this analysis, not absolute fps deltas. A ★★★★★ here means "biggest single win remaining in the codebase"; a ★ means "measurable in the noise."
- The "70–80 % captured" headline is based on weighting the four value vectors equally and judging each as "mostly done / partially / wide open" per § 1. A measurement-grounded version of this analysis would replace the % with a real fps delta.
