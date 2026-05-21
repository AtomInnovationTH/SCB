# BIG_PICTURE — Epic 5 & 6 Completed Work History

> **Archived:** 2026-04-25. Verbatim sections §1, §2, §5, §6, §7, §8, §9 of [`BIG_PICTURE.md`](../BIG_PICTURE.md) — all work in these topics shipped in Epic 5 (UX Foundation) and Epic 6 (Data, Education & Honest Framing). Kept here for reference.
>
> Return to active document: [`BIG_PICTURE.md`](../BIG_PICTURE.md) — active sections §§ 3, 4, 10–39 remain in the main file.

---

## 1. Comms Pane — Taller, Smarter, C-Key Doctrine

### 1.1 Current State

[`CommsPanel._build()`](../js/ui/hud/CommsPanel.js:42) renders a 260 × **120 px** panel at bottom-right showing the 8 most recent messages from [`CommsSystem.getRecentMessages(8)`](../js/ui/hud/CommsPanel.js:333). Styling at [`CommsPanel.js:44-50`](../js/ui/hud/CommsPanel.js:44). The `C` key calls [`CommsPanel.toggleComms()`](../js/ui/hud/CommsPanel.js:197) which toggles a **center-screen numbered command overlay** (220 px wide, 6 options) — [`CommsPanel._buildCommsMenu()`](../js/ui/hud/CommsPanel.js:54). The *log* stays visible always; only the *command menu* toggles.

Messages come from five **source** channels (HOUSTON, GROUND STN, JAXA, arm IDs, system) through [`CommsSystem`](../js/systems/CommsSystem.js:1) and are tagged with priority (INFO / WARNING / CRITICAL) at [`CommsPanel.js:343-348`](../js/ui/hud/CommsPanel.js:343). HOUSTON gets special mint-coloured styling ([`:351-354`](../js/ui/hud/CommsPanel.js:351)).

### 1.2 Problems

| # | Problem | Evidence |
|---|---------|----------|
| A | **Too short** — only 3–4 messages readable at 10 px font; critical WARN scrolls off instantly. | [`maxHeight: '120px'`](../js/ui/hud/CommsPanel.js:45) |
| B | **Content is monolithic** — backstory flavour, actionable alerts, arm chatter, attaboys, and Houston tutorial prompts all share one scroll buffer. | [`CommsSystem`](../js/systems/CommsSystem.js:1) has ONE queue |
| C | **Center-screen command popup hijacks the viewport** during a fast-paced moment (player presses `C` to *deploy* an arm, giant dialog covers the target). | [`_buildCommsMenu()`](../js/ui/hud/CommsPanel.js:54) `position:fixed; top:50%; left:50%` |
| D | **`C` overloaded** — same key opens chatter list & issues commands; no separation between "I want to read" and "I want to act". | [`toggleComms()`](../js/ui/hud/CommsPanel.js:197) does both |
| E | **No chatter filter** — can't hide non-actionable flavor during a busy run. | No filter/channel system |

### 1.3 Target Design (V5 Comms)

**Geometry** — grow the pane **20% taller** (144 px → 12 visible lines) and **~400 px wide**, stacked to the left of the NavSphere on the right side of screen. Auto-scroll stays; but support **`Page Up/Down`** or mouse wheel to pause and review.

**Channels (coloured stripes on the left edge of each row):**

| Channel | Color stripe | Purpose | Example |
|---------|-------------|---------|---------|
| `CMD` | Amber `#ffaa00` | Player-invocable actions (deploy, reel, detach) | "Weaver-3 launching at 8 m/s" |
| `ALERT` | Red `#ff4444` | Conjunction, tether critical, collision warnings | "TCA 23s — evade +Y" |
| `HOUSTON` | Mint `#88ffcc` | Tutorial & mission-control guidance | "Try Z — scan the target" |
| `SCI` | Cyan `#00ccff` | Discovery, salvage ID, Codex unlock | "Alloy match: Ti-6Al-4V" |
| `FLAVOR` | Grey `#888` | Attaboys, radio chatter, ambience | "Good catch, Cowboy" |
| `MISSION` | Gold `#ffd700` | Mission state transitions, boss events | "ISS dodge in T-4h" |

**Filter toggles** — 6 small buttons at top (`[CMD] [ALERT] [HOUSTON] [SCI] [FLAVOR] [MISSION]`), click to hide. Default: all on. Save state to localStorage.

**Content balance ratio per mission hour** (design heuristic — tune via telemetry):
- ALERT: 3–5 / hour (density scales with difficulty)
- HOUSTON: 2–3 / hour (tutorial phase); 0.5 / hour (veteran)
- SCI: 1–2 / hour (discovery-gated)
- CMD: reactive — 1 per player action
- FLAVOR: ~4 / hour (mostly idle periods, silenced during ALERT)
- MISSION: 1 / 15 min average

**Rate-limit** — Add a "coalescing" layer in [`CommsSystem`](../js/systems/CommsSystem.js:1): if the same channel fires 3 messages in 2 s, collapse to one summary line ("3 arms docked"). Prevents the log from flooding during fish-mode captures.

### 1.4 C-Key Doctrine — Split into Two Modes

Current `C` = toggle the giant center popup. Replace with:

| Key | Action | Visual |
|-----|--------|--------|
| `C` (tap) | Focus comms pane — brings it to front, expands height to ~300 px, enables `Page Up/Down` review | Pane border pulses cyan; `ESC` collapses |
| `C` (hold 300 ms) | Open **contextual radial menu** at target reticle — numbered 1-6 actions available for current selection (deploy weaver, pilot arm, …) | Radial, NOT centered; anchors to selected target so player keeps situational awareness |
| `~` | Quick-command — last executed command repeats | For experienced players |

The **center-screen popup is removed**. A radial anchored to the target reticle (iWar/Freespace 2 style) is preferred because it keeps the viewport usable. If target is off-screen, radial centers on the edge-arrow nearest the target direction.

**Command availability gating** — existing code at [`_updateCommsMenu()`](../js/ui/hud/CommsPanel.js:283) already checks arm state; port that logic into the radial.

### 1.5 Deploy Weaver/Spinner/Fish Popup

The **center-screen deploy popup should NOT exist**. Modal dialogs in a time-pressured sim break immersion. Replace with:

1. **Soft-press deploy** — `1` deploys next Weaver, `2` next Spinner, `3` fishes all (same as current command menu mappings) — *no dialog*.
2. **Confirmation** only on destructive actions — `D` deorbit sacrifice shows a 1-second countdown toast at top-center ("DEORBIT in 1.0 s — press D again to cancel").
3. **Status flash** — the just-deployed arm's row in [`StatusPanel`](../js/ui/hud/StatusPanel.js:1) pulses cyan (`LAUNCHING` state already colour-coded at [`StatusPanel.js:1511`](../js/ui/hud/StatusPanel.js:1511)).

This retains the command menu as a **keyboard-shortcut memory aid** (discoverable via the taller comms pane header "[1=W] [2=S] [3=Fish] [4=Recall] [5=Pilot] [6=Deorbit]") but eliminates the viewport-blocking modal.

### 1.6 Files to touch
- [`js/ui/hud/CommsPanel.js`](../js/ui/hud/CommsPanel.js:1) — add channels, filter buttons, delete center popup, add radial
- [`js/systems/CommsSystem.js`](../js/systems/CommsSystem.js:1) — add `channel` field, rate-limit/coalesce logic
- [`js/core/Events.js`](../js/core/Events.js:1) — emit existing `COMMS_MESSAGE` with a `channel` metadata key (backward compatible)
- New: `js/ui/hud/RadialMenu.js` — anchored contextual menu

---

## 2. Real-World Data Layer — Offline-First Debris, Satellites, Weather

### 2.1 Current State

Debris is entirely procedural — [`DebrisField._createDebrisData()`](../js/entities/DebrisField.js:246) generates random orbits using [`ALT_BANDS`](../js/entities/DebrisField.js:75) (5 bands) × [`INC_CLUSTERS`](../js/entities/DebrisField.js:84) (7 inclinations). Real-world cataloguing is mimicked in the *look* of the Target panel but not driven by real data. Space weather is stubbed in [`SpaceWeatherSystem`](../js/systems/SpaceWeatherSystem.js:1) with random CME/flare events.

### 2.2 The Proposal — `/data/` Catalog

Ship the game with an **offline snapshot** of public catalogs (not a live feed — browser offline-first is a design pillar). Place under `/data/`:

```
/data/
  debris-catalog.json       — 36,500 tracked objects from public USSF catalog snapshot
  active-sats.json          — 8,000 active satellites (CelesTrak "active.txt")
  launches.json             — upcoming launches next 90 days (e.g. NextSpaceflight)
  space-weather.json        — F10.7 flux & Ap index last 5 years (NOAA SWPC)
  ground-stations.json      — GSN, ESTRACK, DSN, commercial networks
  constellations.json       — Starlink shells, OneWeb, GPS, Galileo, BeiDou, Iridium
  META.json                 — snapshot date, sources, checksums, optional_update_url
```

**Snapshot date** is baked into the build; the game plays perfectly offline. An optional, **explicitly user-triggered** "Update Catalog" button in the menu fetches a newer snapshot from `optional_update_url` if the network is available — but this is **never** called automatically.

### 2.3 Debris Band Structure — 7 Altitude Bands × Inclination Clusters

Extend [`ALT_BANDS`](../js/entities/DebrisField.js:75) from 5 to 7 bands to match real atmospheric structure:

| Band | Alt (km) | Real population ~count | Notable |
|------|----------|------------------------|---------|
| VLEO | 160–350 | 2,000 | Starlink VLEO, new deposit zone |
| LEO-Low | 350–550 | 12,000 | Starlink shell 1, ISS operational |
| LEO-Mid | 550–800 | 9,500 | Sun-synchronous Earth-obs |
| LEO-High | 800–1,400 | 3,500 | 1960s–90s legacy, Cosmos debris cluster |
| MEO-Low | 1,400–5,000 | 800 | Gap zone (very few sats) |
| MEO-GPS | 19,000–20,500 | 200 | GPS/GLONASS/Galileo/BeiDou |
| GEO | 35,786 ± 200 | 1,600 | Comms, weather, defunct clusters |

Each real entry has: `{ noradID, name, country, tle, mass?, size?, launchDate, status }`. Country enables the **flag-texture feature** in §6. For procedural fill (fragments), keep the current Gaussian approach so the scene still feels busy even if real data is sparse in a band.

### 2.4 Active Satellite Awareness

Currently [`TargetPanel`](../js/ui/hud/TargetPanel.js:222) has an "ACTIVE SATS" section rendered in white but empty. Populate from `active-sats.json`. These objects must **never be captured** — they're live infrastructure. When a player deploys an arm toward an active sat, [`ConjunctionSystem`](../js/systems/ConjunctionSystem.js:1) should raise a RED alert and [`HOUSTON`](../js/systems/CommsSystem.js:1) should bark a prompt:

> HOUSTON▸ "Negative, Cowboy — GPS-III-05 is active. Stand down."

This teaches **operational discipline**: debris removal is not "grab whatever".

### 2.5 Space Weather Realism

Replace random CME roll with a **seeded replay** of the last solar cycle (2020-01-01 to snapshot date). Each hour of game time advances the replay by X hours (configurable). Kp index, F10.7 flux, and SEP events become deterministic, educational, and replayable.

Teach-through-play moments:
- "Kp 7 geomagnetic storm — atmospheric density doubled below 500 km. Your VLEO targets decay faster today."
- "X9 flare in progress — SEP radiation spike. Your solar panels degrade 2×; battery-only ops until passage."

### 2.6 Files to touch
- New: `/data/*` (static JSON)
- New: `js/systems/CatalogLoader.js` — loads `/data/*.json` at boot, exposes `getDebrisByNorad(id)` etc.
- [`js/entities/DebrisField.js`](../js/entities/DebrisField.js:1) — add "hybrid mode" (real entries + procedural fragments)
- [`js/systems/SpaceWeatherSystem.js`](../js/systems/SpaceWeatherSystem.js:1) — replay mode from `space-weather.json`

---

## 5. Trajectory Trails — Mother & Arms (I-War heritage)

### 5.1 The Source

In [Independence War](https://en.wikipedia.org/wiki/Independence_War), every ship left a **coloured motion-trail** — green for prograde, amber for lateral, red for retrograde. The trail *curved* when the player applied WASD — a gorgeous visualisation of Newtonian physics. This is the **single most impactful visual** for teaching "you do not steer in space, you accelerate".

### 5.2 Current State

Player has no trail. Arms have no trail. Debris has no trail. [`VelocityStreaks`](../js/ui/VelocityStreaks.js:1) renders instantaneous motion streaks on the HUD but no historical path.

### 5.3 The Proposal — Ribbon Trails

Implement `js/ui/TrailSystem.js`:

- **Mother trail**: last 90 seconds of world-frame position sampled at 10 Hz → 900 points → triangle strip with lateral width proportional to velocity
- **Colour encoding** (shader, per-vertex):
  - Prograde component (dot(v, v_orbit_tangent) > 0.7) → green
  - Retrograde → red
  - Radial / normal → amber
  - Blend smoothly
- **Fade** — oldest points at opacity 0
- **Curve visibility** — when player presses W (cold-gas thrust), the trail bends visibly over ~2 s. This teaches the core physical intuition.

**Arm trails** — each deployed arm gets a thinner trail (white fading to transparent). During TRANSIT/APPROACH the trail traces the path from dock cavity to target. During REELING the trail *shortens from the arm end*, creating a satisfying "reeling back in" visual.

### 5.4 Performance Budget

- 900 vertices × 9 arms = 8100 verts max. Negligible on modern GPUs.
- Single `THREE.BufferGeometry` with `drawRange` updated per frame for ring-buffer behaviour.
- Shader colour done per vertex using pre-computed `a_progradeDot` attribute.

### 5.5 Files to touch
- New: `js/ui/TrailSystem.js`
- [`js/entities/PlayerSatellite.js`](../js/entities/PlayerSatellite.js:1) — emit position/velocity every 0.1 s
- [`js/entities/ArmUnit.js`](../js/entities/ArmUnit.js:1) — same, per arm
- [`js/scene/SceneManager.js`](../js/scene/SceneManager.js:1) — register trail system

---

## 6. Debris Visualization — Wireframe Parity, Flags, Textures

### 6.1 The Problem

When the player scans (`Z`) a target, [`DebrisWireframe.setTarget()`](../js/ui/DebrisWireframe.js:682) renders a gorgeous procedural wireframe with labeled zones (nozzle, tank, avionics, panels). The game-world debris mesh, however, is a **single generic shape per category** — [`DebrisField._buildInstancedMeshes()`](../js/entities/DebrisField.js:444) creates one geometry for all `FRAGMENT`, one for all `DEFUNCT_SAT`, etc. This creates a **visual-identity dissonance**: "The thing I'm scanning looks nothing like the thing I'm flying toward."

### 6.2 The Proposal — Wireframe-to-Mesh Parity

**Phase 1 (cheap win, 1 day):** For each of the four wireframe types at [`DebrisWireframe.buildRocketBody()`](../js/ui/DebrisWireframe.js:94) / [`buildDefunctSat()`](../js/ui/DebrisWireframe.js:146) / [`buildMissionDebris()`](../js/ui/DebrisWireframe.js:213) / [`buildFragment()`](../js/ui/DebrisWireframe.js:273), the vertex data can be **reused as-is** to build a low-poly world mesh. Wrap the wireframe vertex arrays in `THREE.BufferGeometry`, apply `MeshBasicMaterial` with `wireframe: true` flag overridden by a solid metal-texture on close approach. One geometry per wireframe-type, instanced.

**Phase 2 (texture pass, ~1 week):** Add flat textures matching wireframe colours. Metal surface for bodies, solar-blue for panels. At distance: single-color silhouette. Close-up: shaded with sun direction.

**Phase 3 (country flags, 2-3 days):** When real catalog data (§2) is attached, look up `owner_country` from NORAD ID. Render a **small flag decal** on the bus face — ~8×5 px texture from `/data/flags/{ISO}.png`. Seen only at < 500 m. Adds personality — the player learns "that's a Russian Cosmos rocket body" by sight.

**Phase 4 (beyond — mission debris):** For landmark objects (Vanguard-1, Explorer-1, Cosmos-1408 parent, ENVISAT, Long March debris), hand-modelled glb files in `/assets/models/`. These become **photo-op moments**: scanning Vanguard-1 (the oldest man-made object still in orbit) unlocks the "1958" Codex entry.

### 6.3 Files to touch
- [`js/entities/DebrisField.js`](../js/entities/DebrisField.js:444) — replace `_buildInstancedMeshes()` geometry source with wireframe vertex data
- [`js/ui/DebrisWireframe.js`](../js/ui/DebrisWireframe.js:1) — expose `buildRocketBody()` etc. as importable `getGeometry(type, id) => BufferGeometry`
- New: `/data/flags/` — ISO 3166-1 flag PNGs
- New: `/assets/models/` — landmark glb files

---

## 7. Earth Visualization — 16k Textures, Limb Distortion, VLEO Missions

### 7.1 Existing Textures

The workspace already has premium textures in [`textures/`](../textures):
- `earth_day_16k.jpg` (100+ MB) ← highest resolution available
- `earth_day_8k.jpg`, `earth_day.jpg` (lower)
- `earth_night_16k.jpg`, `earth_night_8k.jpg`, `earth_night.jpg`
- `earth_clouds_8k.jpg`, `earth_clouds.jpg`

Current [`Earth.js`](../js/scene/Earth.js:1) samples these in an elaborate day/night/specular/cloud shader (very high-quality), with procedural noise octaves at [`:100-117`](../js/scene/Earth.js:100) for VLEO surface detail.

### 7.2 Problems

| # | Problem | Evidence |
|---|---------|----------|
| A | **Wrong texture at load** — no code picks the 16k variant based on GPU capability. | No LOD selector |
| B | **Limb distortion** — Planets at camera edges appear oval. This is mostly Three.js `PerspectiveCamera` **FOV too wide** (≥75°). At FOV 90°, a sphere at 60° off-axis renders as an ellipse ~1.3× wider than tall. | Check `camera.fov` in [`SceneManager`](../js/scene/SceneManager.js:1) |
| C | **No fixed first-mission VLEO view** — player spawns and sees Earth from a random angle. First impressions matter. |
| D | **Cloud layer stationary** — real clouds rotate ~ once per 24 h. Current cloud layer has no rotation. |

### 7.3 Fix Ladder

**A — Texture LOD (half-day):** On boot, query `renderer.capabilities.maxTextureSize`. Pick:
- ≥16384 → `earth_day_16k.jpg`
- ≥8192 → `earth_day_8k.jpg`
- else → `earth_day.jpg`
Same for night and clouds. Log to console for QA.

**B — Limb distortion (half-day):** Narrow camera FOV to **50-60°** (cinematic standard). This reduces edge sphere distortion by factor 2. Current main-scene `CameraSystem` values should be audited at [`js/systems/CameraSystem.js`](../js/systems/CameraSystem.js:1). Note that orbital-view could keep wider FOV for awareness; but chase/first-person should be 55°.

**C — VLEO intro (1 day):** When GameFlowManager enters `ORBITAL_VIEW` for the **first-time player** (save absent), position camera such that:
1. Player satellite at screen center
2. Earth fills **lower 60%** of viewport — a beautiful planet-below view
3. Sun at ~30° elevation for day/night terminator visible
4. Terminator line visible across Indian Ocean (recognisable)
Hold this view for 4 s before HUD fades in. This is **the 90-second first-experience money shot**.

**D — Cloud rotation (15 min):** In [`Earth.update(dt)`](../js/scene/Earth.js:1) rotate cloud mesh `0.00007 rad/s` (matches Earth sidereal rate). Clouds drift noticeably over a game hour. Subtle realism.

### 7.4 Browser Max Resolution & Memory

Chromium/Firefox support 16384² textures on any GPU < 5 years old (`MAX_TEXTURE_SIZE` typically 16384+). iOS Safari caps at 8192². For mobile graceful degradation, the LOD selector handles it automatically.

16k texture memory: 16384² × 4 bytes = **1 GB uncompressed**. JPG file is ~100 MB on disk, but WebGL uploads full RGBA. Use `THREE.TextureLoader` with `anisotropy = 8` + mipmaps (auto).

### 7.5 Files to touch
- [`js/scene/Earth.js`](../js/scene/Earth.js:1) — LOD selector, cloud rotation
- [`js/systems/CameraSystem.js`](../js/systems/CameraSystem.js:1) — FOV narrowing
- [`js/systems/GameFlowManager.js`](../js/systems/GameFlowManager.js:1) — first-time VLEO arrival

---

## 8. NavSphere "Orb" — Self-Awareness, Selection Prominence, I-War Stalks

### 8.1 Current State

[`NavSphere`](../js/ui/NavSphere.js:1) is a 280×280 px canvas in the top-right corner. It shows:
- Hemisphere bg gradient with lat/long grid ([`:207-264`](../js/ui/NavSphere.js:207))
- Earth indicator (always-visible direction to Earth) ([`:273-275`](../js/ui/NavSphere.js:273))
- Sun indicator ([`:278-282`](../js/ui/NavSphere.js:278))
- Prograde velocity marker ([`:284-301`](../js/ui/NavSphere.js:284))
- Debris as dots coloured by reach zone ([`:886-897`](../js/ui/NavSphere.js:886))
- Arm tethers as translucent lines

Inspired by Independence War's Nav Sphere, per header comment at [`NavSphere.js:5`](../js/ui/NavSphere.js:5).

### 8.2 Problems

| # | Problem |
|---|---------|
| A | **Low self-position awareness** — player is at center (implicit), but no sense of "where in space am I?" relative to Earth rotation. |
| B | **Selection prominence lacking** — selected debris looks like a slightly different dot. In a busy field of 30 contacts, the eye can't find it. |
| C | **Stalks not implemented** — I-War's Nav Sphere used 3D "stalks" (a vertical line from each contact to the equatorial plane) to show altitude above/below player's orbital plane. Current NavSphere is flat. |
| D | **No relative velocity vectors** — each contact should show a small arrow indicating its closure direction. |

### 8.3 The I-War Fix — 3D Stalks

When a 3D point is projected to 2D, a *stalk* connects it to its shadow on the equatorial plane. Two visual affordances:
1. **Altitude** — stalk length encodes radial distance (above/below player's current orbit plane)
2. **Direction** — stalk direction tells you whether the contact is *above* or *below* your plane at a glance

**Implementation sketch:**

```js
// In _drawContact():
const { sx, sy, z } = this._toSphere(dir, cx, cy, R);
// 'z' is out-of-plane component in ∈ [-1, +1]
const stalkLen = Math.abs(z) * R * 0.25; // up to 25% of sphere radius
const stalkDx  = 0;                      // stalks purely vertical in screen space
const stalkDy  = z > 0 ? -stalkLen : +stalkLen; // above = upward
ctx.strokeStyle = color;
ctx.lineWidth = 0.8;
ctx.globalAlpha = 0.5;
ctx.beginPath();
ctx.moveTo(sx, sy);
ctx.lineTo(sx + stalkDx, sy + stalkDy);
ctx.stroke();
```

Result: contacts above the player's plane appear to "stand up" on stalks; contacts below "hang down". Altitude reads at a glance without numbers.

### 8.4 Selection Prominence

Selected debris rendering (at [`:936-956`](../js/ui/NavSphere.js:936) for untracked) needs a **lock-on ring** — double pulsing cyan circle at 1.5× normal dot size, with the dot itself filled bright white. Matches the target reticle ceremony at [`TargetReticle.showLockOn()`](../js/ui/TargetReticle.js:1).

Also: always draw the selected dot **last** (painter's order) so it's on top of all others. Simple but overlooked.

### 8.5 Self-Position Awareness

Add at sphere bottom, outside the orb: a small text readout:
```
 LAT  +51.6°
 LON  -089.3°
 ALT  412 km
```
Updates at 2 Hz. Player knows "I'm over Illinois right now". Grounds the abstract space view in reality. Geolocation is computed from ECI → ECEF → geodetic; math is straightforward (WGS-84).

### 8.6 Relative-Velocity Arrows

For each contact within 50 km, draw a 4-px arrow from the dot indicating closure direction:
- Point toward player → **closing** (good for targets, bad for conjunctions)
- Point away → **receding**
Arrow length proportional to closure rate (0-2 km/s).

### 8.7 Files to touch
- [`js/ui/NavSphere.js`](../js/ui/NavSphere.js:1) — stalks, lock-on ring, geolocation readout, velocity arrows

---

## 9. Red Tracking-Line 90° Bug — Root Cause Found

### 9.1 Symptom

When a daughter arm is far from the mother (near tether max), the red-coloured tether line (rendered by [`ArmUnit._updateTether()`](../js/entities/ArmUnit.js:2083) when strain > 0.9 at [`:2108`](../js/entities/ArmUnit.js:2108)) appears to make a "90° hard-left turn" instead of a smooth curve.

### 9.2 Diagnosis

Read of [`_updateTether()`](../js/entities/ArmUnit.js:2083):

```js
// Line 2132:
const sag = Math.sin(t * Math.PI) * this.tetherLength * M * 0.015;
posArr[idx + 1] -= sag;
```

The **sag is applied unconditionally in group-local `+Y`**. The tether line is a child of `this.group`, whose world orientation inherits from the scene (identity rotation). But the *sag direction* should be in **tether-perpendicular**, not world-Y.

Two issues compound:

1. **Magnitude scales with `tetherLength`** (maximum tether length from [`Constants.TETHER_TIERS`](../js/core/Constants.js:326)), not with current *separation*. For a 2 km max tether held at 1.9 km separation, `sag_max = 2000 × M × 0.015 = 0.0003 scene units = 30 m` — small relative to the tether, fine. But for a 10 km GSL tether (§14 below) at 9 km separation: `sag = 150 m` — still small relative, but …
2. **Direction is world-Y**. When the tether direction in world-frame happens to lie along `+Y` (e.g., arm is directly "above" the mother in world space — rare but possible during docking manoeuvres or when the player tilts the camera), the sag is *along the tether direction* instead of perpendicular. Subtracting Y from a point already on the +Y axis causes the mid-segment to visually fold back — creating the appearance of a sharp turn.

The "90° hard-left" specifically happens when the arm is displaced in +X from the mother (tether goes horizontally in world), but a *side-wind-like* visual artifact emerges because the sag is applied in world-Y over a *long* arm that is far away. At the midpoint `t=0.5`, the sag is maximum — shifts the midpoint vertex vertically by 30-150 m, which from the camera angle appears as a kink.

### 9.3 Fix

Replace the world-Y sag with a **true catenary perpendicular to tether direction**:

```js
// Compute tether-perpendicular direction in world frame
const dx = parentPos.x - this.position.x;
const dy = parentPos.y - this.position.y;
const dz = parentPos.z - this.position.z;
const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
if (len < 1e-6) return;

// Perpendicular-to-tether, projected into the world-Y-gravity plane
// (real-world intuition: gravity sags the rope downward in the plane
//  containing the tether and the gravity vector)
const tHat = { x: dx/len, y: dy/len, z: dz/len };
// Project world-down (0, -1, 0) onto the plane perpendicular to tHat
const dotDown = -tHat.y; // down·tHat
const sagDir = {
  x: 0 - dotDown * tHat.x,
  y: -1 - dotDown * tHat.y,
  z: 0 - dotDown * tHat.z,
};
const sagMag = Math.hypot(sagDir.x, sagDir.y, sagDir.z);
if (sagMag < 1e-6) return; // tether aligned with gravity — no sag
sagDir.x /= sagMag; sagDir.y /= sagMag; sagDir.z /= sagMag;

// Apply sag scaled by current separation (not max tether length)
const sagAmp = len * 0.015;
for (let i = 0; i < segments; i++) {
  const t = i / (segments - 1);
  const invT = 1 - t;
  const bell = Math.sin(t * Math.PI);
  const idx = i * 3;
  posArr[idx]     = dx * invT + sagDir.x * bell * sagAmp;
  posArr[idx + 1] = dy * invT + sagDir.y * bell * sagAmp;
  posArr[idx + 2] = dz * invT + sagDir.z * bell * sagAmp;
}
```

Two substantive changes:
- **Scale by current separation**, not max tether length → sag proportional to the visible rope, not the reel.
- **Project sag into the plane** containing tether and world-down → visually correct catenary, no world-axis folding.

In vacuum there's no real gravity sag (microgravity), so this is purely aesthetic. In gameplay, a *visible* sag is a useful affordance to indicate tether-state without reading a number. Keep the 1.5% amplitude.

### 9.4 Regression Test

Add to `js/test/test-ArmUnit.js`:

```js
it('tether sag perpendicular to tether direction, not world-Y', () => {
  // Arm displaced purely in +Y from mother (tether is vertical in world)
  const arm = makeArmAt({ x: 0, y: 1000 * M, z: 0 });
  const motherPos = new THREE.Vector3(0, 0, 0);
  arm._updateTether(motherPos);
  const midIdx = Math.floor(Constants.TETHER_SEGMENTS / 2) * 3;
  const pa = arm.tetherLine.geometry.attributes.position.array;
  // Midpoint should not be on the straight line from parent→arm ONLY in an
  // orthogonal direction; it must NOT be along the tether direction itself.
  const midY = pa[midIdx + 1];
  const expectedLinearY = (1000 * M) * 0.5;
  // Before fix: midY was *less* than expectedLinearY by sag (folded).
  // After fix: sag is purely in X/Z, so midY == expectedLinearY.
  assert.closeTo(midY, expectedLinearY, 1e-6);
});
```

### 9.5 Files to touch
- [`js/entities/ArmUnit.js`](../js/entities/ArmUnit.js:2083) — rewrite catenary math
- New test in `js/test/test-ArmUnit.js`
