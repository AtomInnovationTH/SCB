# Per-Language Starting Orbits, Landmarks & Portuguese

## Goals
1. **Accurate space sim** — starting orbit reflects each nation's real launch geography.
2. **Debris-cleanup framing** — the first mission is just a sensible LEO with debris to
   clear; orbit choice is NOT driven by telecom/EO payload type. Sun-synchronous earns a
   place only because it is genuinely the most debris-congested band.
3. **Recognizable reference from orbit** — each player should *see* their homeland (a
   city or distinctive natural feature) in the flight path. It need not be directly
   underneath — **off to the left/right is fine** (visible near the horizon).
4. **Add Portuguese (Brazil)** and **add natural landmarks** (Himalayas, Amazon,
   Kilimanjaro, Andes, …) so there's an iconic reference on every pass.

English is **locked** to the original default route (Gulf of Guinea 0°N/0°E, 51.6°,
`raan=0, ν=0`). Do not change it.

**Resolved decisions:** Portuguese sits **next to Spanish** in the menu; **landmark comms
callouts are in scope**; **first-mission debris is guaranteed** at the player's start
tilt (already true — the welcome field spawns in the player's own orbit).

**Final menu order:** English, Thai, Japanese, Spanish, **Portuguese**, Hindi, Tamil.

## Viewing & orbit model (plain language)
- **Inclination = orbit tilt vs. the equator (degrees)** = the farthest N/S latitude the
  ground track reaches.
- **Visibility, not overflight:** from 350 km the horizon is ~19° of great-circle arc
  away (`√((6378+350)²−6378²) ≈ 2,140 km ≈ 19°`). Anything within ~10° of the track
  reads clearly; out to ~19° it's glimpsable near the limb. **So a homeland is a usable
  reference when its latitude ≤ inclination + ~10°** — it can sit off to the side.
- **Aim the opening pass:** `subPointToOrbit(lat, lon, inc)` (`OrbitalMechanics.js:240`)
  returns the `raan`/`trueAnomaly` that put the first pass over a chosen **anchor
  sub-point**. The anchor's latitude must be **≤ inclination** (else the math clamps).
  For homelands above the tilt (e.g. Tokyo at 35.7° with a 30° orbit), anchor on an
  offshore point at lat ≈ inclination near the country's longitude so the homeland sits
  just off-track and stays in view.
- **There's always debris to clean:** the scattered debris cluster
  (`DebrisField.js:243` — center 45°, spread ±40°, weight 0.25) seeds targets across
  ~5–85°, and dedicated clusters add 28.5° / 51.6° / 65-82° / 97.5°. So even low-tilt
  starts have something to clear (verify density per start — see watch-items).
- Altitude fixed at **350 km** for all (prior decision).

## Proposed per-language design (debris-cleanup + real launch geography)

| Lang | Launch geography / rationale | `incDeg` | Opening anchor sub-point (lat, lon) | Visible reference | Debris band |
|------|------------------------------|----------|-------------------------------------|-------------------|-------------|
| en | USA / NASA — locked original route | **51.6** | Gulf of Guinea (0, 0) | Abidjan; USA later in flight | ISS (Cosmos-1408) |
| th | Thailand / GISTDA — no national pad, regional low LEO | **28.5** | over Bangkok (13.76, 100.50) | Bangkok, Gulf of Thailand | low-LEO + scattered |
| ja | Japan / JAXA — Tanegashima 30.4°N | **30.0** | S of Honshu (28.0, 135.0) | Honshu / Tokyo (just N), Mt Fuji | low-mid + scattered |
| es | Spain / ESA — mid-LEO over Iberia | **45.0** | over Madrid (40.42, −3.70) | Madrid, Pyrenees | scattered (dense) |
| hi | India / ISRO — Sriharikota; Sun-synch = densest debris regime | **97.5** | over Delhi (28.61, 77.21) | Delhi, Himalayas | Sun-synch (densest) |
| ta | India / ISRO — Sriharikota 13.7°N (Tamil region) | **18.0** | over Chennai (13.08, 80.27) | Chennai, Sri Lanka, Western Ghats | low-LEO + scattered |
| pt | Brazil / AEB — Alcântara 2.3°S equatorial launch | **5.0** | over the Amazon (−3.10, −60.02) | Amazon basin, NE Brazil coast | equatorial LEO + scattered |

**Anchor ≤ inclination (no clamp):** Gulf 0≤51.6 ✓ · Bangkok 13.76≤28.5 ✓ · 28.0≤30 ✓ ·
Madrid 40.42≤45 ✓ · Delhi 28.61≤97.5 ✓ · Chennai 13.08≤18 ✓ · Amazon 3.10≤5 ✓.

**Reference visible (homeLat ≤ inc+10°):** Tokyo 35.68 ≤ 40 ✓ (≈6° off-track, clear) ·
Amazon under track ✓ · all others directly under track ✓.

### Notes
- **Tilt spread is now natural: 5° / 18° / 28.5° / 30° / 45° / 51.6° / 97.5°** — driven by
  real launch latitude, not contrived. No artificial duplication.
- **Only one Sun-synchronous (Hindi)**, justified by debris density (the marquee cleanup
  theater) + ISRO's heaviest launch cadence, not payload type.
- **Brazil keeps its true ~5° Alcântara equatorial launch**; the Amazon is the reference
  (Rio at −23° is beyond clear view, which is fine — the rainforest is unmistakable).
- **Japan keeps Tanegashima's ~30°**; Honshu/Tokyo and Mt Fuji sit just north of the
  track, clearly visible to the side.
- **Spain** has no orbital pad (ESA member; Kourou is equatorial and would put Spain out
  of view), so it gets a plausible mid-LEO (45°) debris field directly over Iberia.

## Landmarks & new cities for `data/cities.json`
Budget: 181 used / **220 cap** (`CityLabels.MAX_CITIES`) → ~39 free. Integrity test
(`test-CityLabels.js`) requires every entry valid (lat/lon in range, tier 1–3) and total
≤ cap. Additions below (~30) stay within budget.

**Natural landmarks** (optional additive `kind:"landmark"` field — `parseCityList`
ignores unknown keys, so backward-compatible):

| Name | lat | lon | tier | Reference for |
|------|-----|-----|------|---------------|
| Mt Everest | 27.99 | 86.93 | 1 | Hindi |
| Mt Fuji | 35.36 | 138.73 | 1 | Japanese |
| Mt Kilimanjaro | −3.07 | 37.35 | 1 | (Africa) |
| Grand Canyon | 36.10 | −112.11 | 1 | English/USA |
| Amazon Rainforest | −3.47 | −62.22 | 1 | Portuguese |
| Andes (Aconcagua) | −32.65 | −70.01 | 1 | (Latin America) |
| Iguazu Falls | −25.69 | −54.44 | 2 | Portuguese |
| Sahara (Ahaggar) | 23.29 | 5.53 | 1 | (Africa) |
| Victoria Falls | −17.92 | 25.86 | 2 | (Africa) |
| Great Barrier Reef | −18.29 | 147.70 | 1 | (Australia) |
| Uluru | −25.34 | 131.04 | 2 | (Australia) |
| Pyrenees (Aneto) | 42.63 | 0.66 | 2 | Spanish |
| Western Ghats (Anamudi) | 10.17 | 77.06 | 2 | Tamil |
| Angkor Wat | 13.41 | 103.87 | 2 | Thai region |
| Lake Baikal | 53.50 | 108.20 | 2 | (Russia) |

**New cities** (Portuguese/Brazil + sparse South-America coverage):

| Name | lat | lon | tier |
|------|-----|-----|------|
| Rio de Janeiro | −22.91 | −43.17 | 1 |
| São Paulo | −23.55 | −46.63 | 1 |
| Brasília | −15.79 | −47.88 | 2 |
| Manaus | −3.12 | −60.02 | 2 |
| Recife | −8.05 | −34.88 | 2 |
| Buenos Aires | −34.60 | −58.38 | 1 |
| Lima | −12.05 | −77.04 | 1 |
| Santiago | −33.45 | −70.67 | 2 |

(Final curation at implementation: dedupe vs. existing entries; keep total ≤ 220.)

## Implementation steps

### 1. `js/core/Languages.js`
- Typedef: add `@property {number} [incDeg]` (start tilt, default 51.6°) and optional
  `@property {string} [sight]` (reference-feature name). Document the visibility rule
  (`homeLat ≤ incDeg + ~10°`) and anchor rule (`anchor.lat ≤ incDeg`).
- Header note (lines 31–39): replace "all below 51.6°" text with the new model —
  per-language `incDeg` from launch geography, opening pass anchored so the homeland is
  in view, altitude fixed 350 km, debris always present via the scattered cluster.
- `LANGUAGES` array: add `incDeg` (+ optional `sight`) per entry, update the `start`
  anchor sub-points per the table (note: `ja` anchor is offshore S of Honshu, `pt`
  anchor is over the Amazon — not the capital), refresh rationale comments, and append:
  ```js
  { code: 'pt', label: 'Portuguese', native: 'Português', flag: 'BRA', incDeg: 5.0,
    start: { name: 'Amazon', lat: -3.10, lon: -60.02 }, sight: 'Amazon Rainforest' },
  ```
  `_paintBRA` already exists in `FlagDecalSystem.js:240`, so no flag art is needed.
  Insert the `pt` entry **immediately after `es` (Spanish)** to keep the Iberian/Latin
  pair together — final order: en, th, ja, es, pt, hi, ta.

### 2. `js/systems/GameFlowManager.js` — `_applyStartLocation()` (lines 1219–1233)
- Read `lang.incDeg` (fallback 51.6), convert to radians, pass to `subPointToOrbit`, and
  set `player.orbit.inclination` to it alongside `raan`/`trueAnomaly`.
- Update the docstring (it currently states inclination stays 51.6°).

### 3. `data/cities.json`
- Bump `version` to 5; extend `description` to mention natural landmarks + optional
  `kind`. Add the landmark/city rows; keep total ≤ 220 and tiers 1–3.

### 4. Landmark comms callout (in scope)
- The opening-comms hook already exists at `GameFlowManager.js:1106` (first
  `ORBITAL_VIEW`, emits `Events.COMMS_MESSAGE` with `{sender, text, priority}`).
- Add a one-shot callout there that reads `settingsManager.getLanguageEntry().sight` and
  emits e.g. `text: 'Off your port side — the Amazon Rainforest. Your reference point.'`
  Gate it behind a `_firstTimeComms` key (like the existing 'orbital_view_opening') and
  no-op when `sight` is absent (English locked has no `sight`, or set one — e.g. West
  Africa coast / Abidjan).
- Keep it advisory/`info` priority so it doesn't fight onboarding ("Press S to scan").
  Sequence after the existing opening hint.

### 5. First-mission debris guarantee (already satisfied — verify only)
- The welcome field spawns **in the player's own orbit**: `main.js:947` →
  `DebrisField.spawnWelcomeField(playerOrbit)` → `_spawnWelcomeField` places ~7–8
  fragments at 150–1500 m offsets relative to the player (`DebrisField.js:1887`). Because
  `_applyStartLocation` sets the player's inclination on New Game *before* `MISSION_START`
  fires, the welcome cluster automatically inherits the chosen start tilt — low-tilt
  starts (Brazil 5°, Tamil 18°) get the same guaranteed contacts as today.
- **Verify only:** confirm `_applyStartLocation` runs before the welcome-field spawn
  (New Game path, `GameFlowManager.js:290,304`) and that auto-target of nearest welcome
  debris (`GameFlowManager.js:1098`) is inclination-agnostic. No new spawn logic needed.

### 6. Tests
- New `js/test/test-Languages.js`:
  - `anchor.lat ≤ (incDeg ?? 51.6)` for every entry (no clamp).
  - `homeLat ≤ incDeg + 10` where a distinct home city differs from the anchor
    (visibility invariant).
  - `subPointToOrbit(anchor, incDeg→rad)` returns finite `raan`/`ν` in `[0,2π)` and
    forward-projects back to the anchor latitude (incl. retrograde 97.5°).
  - English locked: `en` → (0, 0, 51.6). Portuguese present: `pt` → flag `BRA`; menu
    index is immediately after `es`.
- Welcome-field inheritance: extend `js/test/test-WelcomeField.js` (or add a case) to
  pass a non-51.6° `playerOrbit` (e.g. 5°) and assert fragments inherit that inclination.
- Re-run `js/test/test-CityLabels.js` after editing `cities.json` (count ≤ 220, all valid).

### 7. Optional polish (low-risk, separate)
- CityLabels styling for `kind:"landmark"` (peak glyph / italic).

## Risks / watch-items
- **Opening-debris density:** handled — the welcome field spawns in the player's orbit
  (step 5), so low-tilt starts get the same guaranteed first contacts. Background catalog
  debris in low bands is naturally sparser, but the welcome cluster covers the first
  mission. Verify the auto-target/scan beats behave at 5°/18°.
- **Retrograde visuals:** sanity-check ground-track rendering (StrategicMap/menu) for the
  Hindi 97.5° start (math is fine; visual check only).
- **Label crowding:** ~30 new tier-1/2 entries may crowd dense regions at low zoom; the
  proposed tiers keep secondary features at tier 2/3 to mitigate.

## Files touched
- `js/core/Languages.js` · `js/systems/GameFlowManager.js` (`_applyStartLocation` +
  opening-comms callout) · `data/cities.json` · `js/test/test-Languages.js` (new) ·
  `js/test/test-WelcomeField.js` (extend) · (optional) CityLabels landmark styling.

## Open questions
None — all design decisions resolved. Ready to implement.
