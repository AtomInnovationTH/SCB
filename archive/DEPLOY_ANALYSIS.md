# Space Cowboy → GitHub Pages Deployment Analysis

> Generated 2026-05-21. Investigation only — no source code modified. All claims verified by direct file inspection plus live HTTP probes against `raw.githubusercontent.com/AtomInnovationTH/SCB` and `atominnovationth.github.io`.

---

## TL;DR

- **Can it run on GitHub Pages?** **YES, with one ~1‑line code fix.** The architecture is pure static (vanilla ES6 modules, relative paths everywhere, no server APIs, no service worker, no build step). The only thing standing between the current `main` branch and a working `https://atominnovationth.github.io/SCB/` is a broken Three.js import map.
- **Estimated work to one-click play:** **~15 minutes.** Three tiny changes (one HTML edit, one empty file, one README badge) plus flipping the GH Pages toggle in repo settings.
- **Estimated first-load download for users:** **~30–50 MB on high-end devices** (16k Earth textures), **~25 MB on mid-tier** (8k fallback), **~6–10 MB on low-end** (4k base). Adaptive LOD already in place — see [`Earth.js:436-461`](js/scene/Earth.js:436). The repo itself (without `node_modules/`) is ~57 MB, well under GH Pages limits.
- **Live-site status verified by HTTP probe:**
  - `https://atominnovationth.github.io/SMX/` → `HTTP 200` (Pages enabled)
  - `https://atominnovationth.github.io/SCB/` → `HTTP 404` (Pages **not yet enabled** for SCB)

---

## 1. Current static-readiness audit

| Item | File / Evidence | Verdict |
|---|---|---|
| Entry HTML | [`index.html`](index.html:1) — single file, inline CSS, `<canvas>` + `<div id="hud-overlay">` | ✅ static |
| Module bootstrap | [`index.html:377`](index.html:377) `import './js/main.js';` (relative) | ✅ subpath-safe |
| Import map (THREE) | [`index.html:355-358`](index.html:355) maps `three` → `./node_modules/three/build/three.module.js` | ❌ **BROKEN on GH** |
| `package.json` build step | [`package.json:1-8`](package.json:1) — no `scripts`, just `"type":"module"` + `three: 0.170.0` dep | ✅ no build |
| Dev launcher | [`start.sh:21`](start.sh:21) — `python3 -m http.server 8081` | ℹ️ dev convenience only — not needed for GH Pages |
| Internal JS imports | All 46+ modules import relatively (`./`, `../`) — verified by regex scan for non-`./` non-`three` imports → 0 hits | ✅ subpath-safe |
| Three addons | [`SceneManager.js:9-12`](js/scene/SceneManager.js:9), [`Starfield.js:8-10`](js/scene/Starfield.js:8) import `three/addons/...` (4 submodules) | ❌ same broken map |
| Data fetches | [`CatalogLoader.js:98`](js/systems/CatalogLoader.js:98) `basePath = './data/'`, [`MissionEventSystem.js:305`](js/systems/MissionEventSystem.js:305) `fetch('data/news-events.json')` | ✅ relative |
| Texture loads | [`Earth.js:464-466`](js/scene/Earth.js:464) `loadTexture('textures/earth_day_16k.jpg')` etc. | ✅ relative |
| Absolute `/`-rooted paths | Regex scan `fetch\(['"]/|src=['"]/[^/]` over `js/*.js` → **0 hits** | ✅ |
| `localhost` / `127.0.0.1` refs in `js/` | regex scan → **0 hits** | ✅ |
| CDN refs in runtime `js/` | regex scan → **0 hits** (only [`test.html:30`](test.html:30) uses jsdelivr) | ✅ runtime is CDN-free |
| Service workers / cache busting | regex scan for `serviceWorker` → **0 hits** | ✅ |
| Audio autoplay gating | [`AudioSystem.js:51`](js/systems/AudioSystem.js:51) constructs `AudioContext` on init, [`AudioSystem.js:69-72`](js/systems/AudioSystem.js:69) `resume()` honors suspended state | ✅ browser-policy compliant |
| Node-only imports in runtime | `node:fs`/`node:path` only appear in two test files ([`test-hud-activate-keys.js:10`](js/test/test-hud-activate-keys.js:10), [`test-no-tutorial-legacy.js:10`](js/test/test-no-tutorial-legacy.js:10)) — never imported from `main.js` chain | ✅ |
| WebGL graceful degrade | [`Earth.js:430-437`](js/scene/Earth.js:430) reads `UNMASKED_RENDERER_WEBGL` and picks LOD; no explicit "no WebGL" fallback screen | ⚠️ minor — see §3 #4 |
| `.nojekyll` present | `curl -I https://raw.githubusercontent.com/AtomInnovationTH/SCB/main/.nojekyll` → **HTTP 404** | ⚠️ should add (see §4) |
| GH Pages enabled | `curl https://atominnovationth.github.io/SCB/` → **HTTP 404** | ❌ not yet enabled |

**Bottom line:** the code is 99 % already static. One broken import map and one toggle in repo settings stand between you and a working public URL.

---

## 2. Comparison to SMX reference

Probed the SMX repo via `GET https://api.github.com/repos/AtomInnovationTH/SMX/contents` and the live site directly.

**SMX is the trivial case.** Repo contents at root:

```
file  2,757,577  index.html               ← single-file game (2.6 MB, all inline)
file    144,279  Space_Monkey_Elevator.html  ← editable source
file      4,680  README.md
file        216  start.sh                 ← python3 -m http.server 8000
dir              screenshots/
file              .gitignore, LICENSE, CHANGELOG.md, etc.
```

- **No `package.json`, no `node_modules/`, no import maps, no module system.** SMX inlines its single image asset as base64 webp (seen in [`SMX/index.html`](https://github.com/AtomInnovationTH/SMX) head). Plain `<canvas>` 2D, no external deps.
- **Live URL pattern:** `https://atominnovationth.github.io/SMX/` serves `index.html` from `main` branch root. GH Pages config is the standard "Deploy from a branch → main / root" toggle.
- **README pattern** ([`SMX/README.md` line 3](https://raw.githubusercontent.com/AtomInnovationTH/SMX/main/README.md)):

  ```markdown
  # Space Monkey Elevator 🚀🐵

  **Play it:** [atominnovationth.github.io/SMX](https://atominnovationth.github.io/SMX/)
  ```

  A bold play-link immediately under the H1. Quick start lists three options: clone-and-open, local dev server, GitHub Pages.

**SCB is structurally compatible with the same pattern** — same `main`/root deploy, same `start.sh` convenience script — once the import map is fixed. The only real difference is SCB has a `js/` module tree and a `textures/` blob folder, both of which serve perfectly fine as static files.

---

## 3. Blockers

### 🔴 Blocker #1 — Three.js import map points to gitignored `node_modules/`

**Severity:** Showstopper. Without this fix the GH Pages site loads a blank black canvas with `Failed to resolve module specifier "three"` in the console, and `import './js/main.js'` never executes past the first import.

- [`index.html:352-359`](index.html:352):
  ```html
  <!-- Three.js r170 via import map (local — offline-first, no CDN required) -->
  <script type="importmap">
  {
    "imports": {
      "three": "./node_modules/three/build/three.module.js",
      "three/addons/": "./node_modules/three/examples/jsm/"
    }
  }
  </script>
  ```
- [`.gitignore:1`](.gitignore:1) is exactly `node_modules/` — the directory is **excluded from git**.
- **Hard proof:** `curl -I https://raw.githubusercontent.com/AtomInnovationTH/SCB/main/node_modules/three/build/three.module.js` → **HTTP 404**.
- 21 runtime modules import from `'three'`, plus 2 modules import 4 addons:
  - [`SceneManager.js:9-12`](js/scene/SceneManager.js:9) — `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `SMAAPass`
  - [`Starfield.js:8-10`](js/scene/Starfield.js:8) — `LineSegments2`, `LineMaterial`, `LineSegmentsGeometry`
- **The fix already exists in this repo:** [`test.html:27-34`](test.html:27) uses the working CDN import map exactly as needed for production:
  ```html
  <script type="importmap">
  {
      "imports": {
          "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
      }
  }
  </script>
  ```

The comment in [`index.html:352`](index.html:352) ("offline-first, no CDN required") describes a developer-machine preference, not a production constraint. The README intent at [`README.md:18`](README.md:18) — *"Three.js r170 via CDN import maps"* — actually matches what GH Pages needs.

### 🟡 Blocker #2 — GitHub Pages not enabled on the repo

**Severity:** Showstopper. Verified by `curl https://atominnovationth.github.io/SCB/` → **HTTP 404**.

- Fix is in repo Settings → Pages → Source: "Deploy from a branch" → Branch: `main` → Folder: `/ (root)` → Save.
- Not a code change. No CI/CD or workflow file required.

### 🟡 Blocker #3 — No `.nojekyll` marker

**Severity:** Low / preventive. Confirmed missing on `main` (HTTP 404 on raw URL).

- Without it, GitHub Pages runs Jekyll which silently drops any file or directory starting with `_` or processes Liquid templating in markdown.
- The codebase doesn't currently use any `_` prefixed paths, but adding the file is zero-cost insurance against future surprises (e.g. a future `_internals/` directory).
- Fix: `touch .nojekyll` at repo root, commit.

### 🟡 Blocker #4 — No graceful WebGL-missing fallback

**Severity:** Low / UX. Not unique to GH Pages, but more visible to drive-by visitors than to repo cloners.

- If a visitor lands on the page without WebGL (rare modern browsers, locked-down corp machines, some headless preview crawlers), Three.js will throw and the loading screen at [`index.html:363-367`](index.html:363) will sit on "Initializing VLEO systems…" forever.
- Optional improvement, not a blocker for launch.

### 🟢 Non-blockers (verified clean)

| Concern | Status |
|---|---|
| File-size limit (100 MB hard, per-file) | Largest file `textures/earth_day_16k.jpg` = **18.8 MB** ✅ (verified by `curl -o /dev/null -w '%{size_download}'` against raw URL) |
| Repo total size (1 GB soft) | ~57 MB on GH (textures 53 MB + js 3.8 MB + data 88 KB + misc) ✅ |
| MIME types for `.js` | GH Pages serves `.js` as `application/javascript` by default ✅ |
| `.mjs` extensions | grep `\.mjs` → 0 hits ✅ |
| CORS | Same-origin static assets ✅ |
| Subpath `/SCB/` | All imports/fetches use `./` or bare `'three'` (resolved through import map) — no absolute `/data/` etc. ✅ |
| Browser autoplay policy | [`AudioSystem.js:69-72`](js/systems/AudioSystem.js:69) `resume()` defers context activation ✅ |

---

## 4. Required changes for GH Pages deploy

Minimal, ordered, all-low-effort.

### Step 1 — Fix the Three.js import map in [`index.html`](index.html:352)
- **What:** Replace `./node_modules/three/...` paths with the jsdelivr CDN URLs already proven to work in [`test.html:30-31`](test.html:30).
- **Why:** Resolves Blocker #1. Without this nothing else matters.
- **Effort:** 1 minute. Pure HTML edit, ~4 lines.
- **Side effect:** First-time visitors need internet (so does every other web page); offline-first dev workflow still works because devs already have `node_modules/` locally — they can either keep using the CDN (it caches) or swap their local copy temporarily.

### Step 2 — Add `.nojekyll` at repo root
- **What:** `touch .nojekyll && git add -f .nojekyll && git commit -m "chore: disable Jekyll for GH Pages"`.
- **Why:** Resolves Blocker #3. Prevents Jekyll from silently dropping files later.
- **Effort:** 30 seconds.

### Step 3 — Enable GitHub Pages in repo Settings
- **What:** GitHub → `AtomInnovationTH/SCB` → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, Folder: `/ (root)` → Save. Wait ~1 minute for first deploy.
- **Why:** Resolves Blocker #2.
- **Effort:** 2 minutes (UI clicks + waiting).

### Step 4 — Add a "Play now" badge to the top of [`README.md`](README.md:1)
- **What:** Insert immediately under the H1, matching SMX's pattern:
  ```markdown
  # 🤠 Space Cowboy

  **Play it now:** [atominnovationth.github.io/SCB](https://atominnovationth.github.io/SCB/) — one-click in any modern WebGL browser, no install.
  ```
- **Why:** Friction = number of clicks to first photon. SMX has this; SCB doesn't. The current [`README.md:9-14`](README.md:9) "Quick Start" leads with `./start.sh`, which is dev-only.
- **Effort:** 1 minute.

### Step 5 — (Optional but recommended) Update the import-map comment in [`index.html:352`](index.html:352)
- **What:** Change `<!-- Three.js r170 via import map (local — offline-first, no CDN required) -->` to `<!-- Three.js r170 via jsdelivr CDN — keeps repo lean and avoids shipping ~30 MB of node_modules to GH Pages. For pure-offline dev, swap back to ./node_modules/. -->`.
- **Why:** Self-documenting intent, prevents the next maintainer from "fixing" it back.
- **Effort:** 30 seconds.

### Step 6 — (Optional) Add a 1-line WebGL-missing fallback
- **What:** In [`index.html`](index.html:363) inside `#loading-screen`, add `<noscript>` and a small WebGL probe that swaps the message to "WebGL required" if `!document.createElement('canvas').getContext('webgl2')`.
- **Why:** Better drive-by UX. Resolves Blocker #4.
- **Effort:** 5–10 minutes. Defer to a follow-up.

**Total minimum work: Steps 1–4 = ~5 minutes of edits + ~10 minutes of waiting for the first GH Pages build.**

---

## 5. First-load size optimization (optional follow-up — do not implement now)

Verified texture sizes on disk (matches what's served from GitHub raw):

| File | Size | Loaded when |
|---|---|---|
| `textures/earth_day_16k.jpg` | 19 MB | High-end GPU (>16k texture support, ≥8 GB memory, non-Apple Silicon — see [`Earth.js:436-437`](js/scene/Earth.js:436)) |
| `textures/earth_clouds_8k.jpg` | 13 MB | 8k tier and above |
| `textures/earth_night_16k.jpg` | 9.4 MB | High-end (same as day_16k) |
| `textures/earth_day_8k.jpg` | 5.5 MB | Mid-tier (default fallback) |
| `textures/earth_day.jpg` (4k) | <2 MB | Low-end / no UNMASKED_RENDERER_WEBGL |
| `textures/earth_night.jpg` / `_8k` / `_16k` | <2–9 MB | Tier-matched |
| `textures/earth_clouds.jpg` (4k) | <1 MB | Low-end |
| `data/*.json` | 88 KB total | Always |
| `js/` modules | 3.8 MB unminified | Always (3 dozen HTTP requests — HTTP/2 multiplexing on GH Pages mitigates) |
| `three.module.js` (CDN) | ~650 KB minified | Always |

**Estimated first paint (typical user):**
- High-end M-series Mac or desktop GPU → **40–50 MB** (16k textures + JS + Three.js)
- Mid-tier laptop → **25–30 MB** (8k textures)
- Phone / Intel iGPU → **6–10 MB** (4k base textures)

**Adaptive LOD already exists** in [`Earth.js:381-439`](js/scene/Earth.js:381). The system reads `MAX_TEXTURE_SIZE`, `navigator.deviceMemory`, and the WebGL renderer string and picks a tier. Mobile/low-end users already get the small textures; only high-end users opt into the 30+ MB payload.

**Potential follow-up work (NOT for the deploy-MVP sprint):**

1. **Ship a "lite" GH Pages variant** — a `?lite` query param (or a second `index-lite.html`) that forces the 4k tier regardless of hardware. Useful for first-visit / Twitter-share scenarios where you want first paint <10 MB. ~30 min.
2. **Lazy-load high-res textures** — start with the 4k baseline, swap in 8k/16k after the menu screen renders. Requires non-trivial shader/material reload logic in [`Earth.js:476-509`](js/scene/Earth.js:476). ~2–3 hours.
3. **Convert JPEGs to AVIF/WebP** — earth_day_16k.jpg at 19 MB → likely 6–8 MB AVIF at equivalent quality. THREE.TextureLoader supports both via the standard `Image` decode path. Requires regenerating textures with a tool like `cavif` or ImageMagick. ~1 hour.
4. **Bundle `js/` with esbuild** — the 46-module tree is ~3.8 MB unminified across many requests. A single minified bundle would be ~600–900 KB. Contradicts the "no build tools" project principle, so this is a deliberate trade. Not recommended unless first-load JS time becomes a measured problem.
5. **Cache assets via service worker** — for repeat plays, cache the textures. Repos hosted on GH Pages get reasonable `Cache-Control` headers already; SW would mostly help offline scenarios. ~1–2 hours.

---

## 6. Recommended next sprint (concrete checklist for code mode)

Hand off to `💻 Code` mode with these items, in order. All ~15 minutes of wall time, of which only 5 minutes is human attention.

- [ ] **Edit [`index.html:355-358`](index.html:355)** — swap the import-map values to the jsdelivr CDN URLs from [`test.html:30-31`](test.html:30). Also update the comment per §4 Step 5.
- [ ] **Create [`.nojekyll`](.nojekyll:1)** at repo root (empty file).
- [ ] **Insert a Play badge** at the top of [`README.md:1`](README.md:1) per §4 Step 4 wording.
- [ ] **Update [`README.md:18`](README.md:18)** — the "Tech" line already says "Three.js r170 via CDN import maps", which is now accurate again. No edit needed if accurate after Step 1.
- [ ] **Commit + push** to `main` with a single message: `chore(deploy): enable GitHub Pages — CDN import map + .nojekyll + play badge`.
- [ ] **Repo settings → Pages → Source: `main` / `/ (root)` → Save.**
- [ ] **Verify** `curl -I https://atominnovationth.github.io/SCB/` returns HTTP 200, then open in browser and check the JS console for any `Failed to resolve module specifier` errors.
- [ ] **Smoke-test** the menu screen, briefing, and first scan loop. (No code change should affect gameplay; this is a deploy-only sprint.)
- [ ] *(Optional follow-up)* implement WebGL-missing fallback (§4 Step 6).
- [ ] *(Optional follow-up)* file a backlog ticket for a "lite" texture mode (§5 #1).

**Acceptance criterion:** A new visitor with no prior context can click the link in the README and be playing within 30 seconds, with no terminal, no `git clone`, and no `python3` involved — matching the SMX bar exactly.
