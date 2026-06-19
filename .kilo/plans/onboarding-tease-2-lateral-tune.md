# Plan: M1 debris taxonomy + onboarding progression (size, appearance, reward)

Supersedes the size-only draft. Driven by a design discussion: debris should obey a
**physical hierarchy** (fragments are *pieces of* sats/rockets → smaller and shaped
like panels/foil/cells/bolts), the onboarding cluster should **progress** (no boss
level first), and the field should *feel* like a real, power-law-distributed junk
cloud. Context: `.kilo/plans/onboarding-tease-debris-pin.md` (as-built).

---

## Design principles (the "why")

### 1. Physical size/mass hierarchy
A `fragment` is by definition a piece that broke off a larger body, so it must be
**smaller than the smallest whole object**. Whole objects, largest→smallest:
- `rocketBody` (cylinders, 5–11 m, 500–5000 kg)
- `defunctSat` (box bus + wings, 1–8 m, 50–2000 kg)
- **`cubesat`/microsat** (small whole box, 0.1–0.5 m, 1–12 kg) — *new category*
- `fragment` / `missionDebris` (panel/foil/cell shards, bolts; sub-metre, <10 kg)

The current type bands already encode most of this (`fragment ≤1 m`, `defunctSat ≥1 m`).
The **only** break is the welcome `sizeM` overrides (2.4–3.0 m fragments → render ~5.7 m,
~3× the 2 m mother). **Invariant to enforce: a `fragment` never renders larger than a
small whole satellite (~1 m).** `sizeMeter` ≈ radius; render width ≈ 1.9 × `sizeMeter`
(geometry normalised to bounding radius 0.95, scaled by `sizeMeter × 1e-5`).

### 2. Net-only ⇒ the M1 cluster is *light pieces*, not whole sats
M1 captures with the Mother net (≤ `LASSO_MAX_CAPTURE_MASS` = 10 kg). Whole sats/rockets
(50–5000 kg) are physically un-nettable and are taught later with other tools. So the
welcome cluster is *correctly* small light junk: bolts, MLI foil, aluminium skin,
solar-cell shards — plus, at most, a **cubesat** (1–10 kg, the heaviest *whole* thing a
net can take). This is physically and mechanically consistent.

### 3. Power-law distribution — yes for realism, no as a literal sampler
Real orbital debris follows an inverse power law: `N(>d) ∝ d^-α` (α≈2–3) — overwhelmingly
many tiny fragments, a handful of large bodies. Recommendation:
- **Background Points (5000):** sample size from a clamped Pareto so the cloud reads as
  "mostly specks, rare big chunks" — cheap realism, no gameplay impact.
- **Interactive field (800):** keep type-frequency weighting (already fragment-dominant
  at 0.60) but bias *within-type size* toward the small end (sub-band power law) so big
  catchable targets stay rare and feel earned. Do **not** literally Pareto-sample the
  interactive field — a true power law would flood it with un-catchable dust and starve
  targets. The realism win is the *hierarchy + appearance*, not the raw statistics.

### 4. Reward theory + spaced repetition (onboarding)
- The M1 beats already repeat the **net** action (`tease_lock→N`, `second_catch→N`,
  `range_wall→A then N`, `free_clear→net the rest`): that *is* spaced repetition of the
  core skill. Keep that cadence; let the gaps grow (close → reach → far) so each rep is
  slightly harder — distributed practice.
- **Escalating reward:** salvage value should climb across the cluster so each catch pays
  more than the last (variable-ratio-flavoured escalation). Decouple from size — a big
  thin solar-panel shard is *large but light*; a cubesat is *small but dense/valuable*.
  So progression is driven by **reward (value/mass)**, with size as a *visual* cue, not a
  strict monotonic ramp.

---

## Concrete M1 welcome cluster (net-only, ≤10 kg, ramped)

All `fragment`/`cubesat`, all sub-metre except large thin panels, all net-catchable.
`sizeMeter` ≈ radius; render ≈ 1.9×. Distances/pins as today unless noted.

| # | piece (reads as) | `sizeM` | render | dist | mass | value |
|---|------------------|---------|--------|------|------|-------|
| 1 | bolt/bracket chunk (daughter-sized) | 0.18 | ~0.34 m | 30 m (pin) | 3 kg | low |
| 2 | aluminium skin / MLI-foil scrap (flat) | 0.30 | ~0.57 m | ~69 m (pin, `latM 25`) | 4 kg | low+ |
| 3 | solar-cell panel shard — RANGE WALL | 0.45 | ~0.86 m | 130–180 m | 5 kg | med |
| 4 | aluminium fragment | 0.55 | ~1.05 m | 200–400 m | 6 kg | med |
| 5 | large thin solar-array section (big, light) | 0.95 | ~1.8 m | 400–670 m | 6 kg | med+ |
| 6 | foil + strut bundle | 0.70 | ~1.33 m | 670–1075 m | 8 kg | high |
| 7 | **cubesat** (small whole microsat, dense) | 0.30 | ~0.57 m | 1075–1475 m | 10 kg | top |

Notes:
- Nothing renders larger than the ~2 m mother; #5 (a thin array section) is the widest
  but is *flat and light*, reinforcing "big ≠ heavy".
- Reward climbs 1→7 even though size does not strictly — the **cubesat #7** is the small,
  dense, valuable "graduation" catch (introduces the *small whole satellite* idea).
- Every `sizeM < 2 m` ⇒ none is flag-eligible (ties into the flag fix). The cubesat is a
  satellite but tiny; a sub-2 m flag would be invisible, so leave it unflagged.

---

## Implementation — LOCKED SCOPE: Phases 1 + 2 + 3 (appearance = material/variant, no rebind)

### Phase 1 — hierarchy + progression + #2 side + flags (core, low-risk)
- `WELCOME_FIELD` rows (`js/entities/DebrisField.js:231-242`): set each `sizeM`/mass per
  the cluster table; restore fragments to sub-metre; #2 `latM 45 → 25` (≈21° off-axis,
  ≈69 m, in range/arc — fixes "too far right"). #1 `fwdM 30`, #2 `fwdM 65` unchanged.
  **#1 anchor = literal daughter `sizeM 0.18` (~0.34 m)** per stated intent; tunable to
  ~0.25 or pull #1 to ~25 m if too small in playtest (D3, deferred to playtest).
- Reward escalation: `massMin/massMax` ramp + keep `lowValue` only on #1–#2 so early
  catches stay cheap and later ones pay more (reward grows by value, not strictly size).
- Flag safety guard in `_spawnWelcomeField` (after `welcomeSpawn = true`, ~:2175): if
  `_flagLookup.has(id)`, zero that flag instance, delete the lookup, `country = null`.
  (Belt-and-suspenders — sizes already drop below the 2 m flag threshold.)
- **No `isFlagEligible` change** — its size gate already means "rockets + large sats
  only"; test-locked at `test-DebrisTextureAtlas.js:364-382` for real catalog derelicts.

### Phase 2 — appearance: pieces, not boulders (material + variant selection only)
The spawn reuses the candidate's instanced-mesh slot and **cannot** rebind shape or
material (per as-built; `_meshKey = fragment:material:id%7` fixes both). So appearance is
controlled by **selecting the right candidate**, which needs two changes:
- **Re-introduce small `solar_cell` + `mli_mylar` weights to `fragment` materials**
  (`MATERIAL_WEIGHTS_BY_TYPE.fragment`, `js/entities/DebrisField.js:77`; mirror in
  `CatalogConverter.js:51` if used): e.g. `solar_cell: 0.06, mli_mylar: 0.06`. Without
  this there are **no** blue/gold fragment mesh-slots to select (the as-built removed
  them). Scope rationale: a *small shed PV/foil shard* reads as junk, not an intact
  high-value panel — this is a deliberate, minimal partial-reversal of as-built
  symptom #5 (kept small, ~6%, so the field is not "gold/blue soup" again).
- **Plate-variant classifier:** add `DebrisWireframe.isPlateVariant(variantId)` exposing
  the existing `_buildFragmentGeo` plate test (`_hash01(seed+41) > 0.68`) so selection can
  target flat panel-shard variants deterministically (variant = `id % DEBRIS_FRAGMENT_VARIANTS`, =7).
- **Per-row candidate matching** in `_spawnWelcomeField` candidate collection: bucket far
  fragments by `(isPlateVariant, material)` and assign specific candidates to rows —
  #2 = gold `mli_mylar` plate (foil scrap), #3/#5 = blue `solar_cell` plate (panel/array
  shard), others = `aluminum`/`titanium`/`composite` plates or blocky chunks. Falls back
  to any far fragment if a desired bucket is empty (so spawn never fails).
- `spec.material` still set for salvage/flags consistency, but the **rendered** colour now
  comes from having selected a candidate already in that material slot.

### Phase 3 — `cubesat` type (new whole-but-tiny satellite)
Add a `cubesat` debris type: small panelled box, net-catchable, the "small satellite"
graduation catch (welcome #7) + sprinkled into the field. Registration checklist:
- `js/entities/DebrisField.js`: `DEBRIS_TYPES` (`sizeMin 0.1 sizeMax 0.5`, `massMin 1
  massMax 12`, low tumble, `shape:'box'`, `aspect ~1.1`); `MATERIAL_WEIGHTS_BY_TYPE`
  (aluminium bus + some solar_cell/mli_mylar); `PROC_TYPE_TO_CATALOG` (→ `'inactive'` or
  new); `TRACKING_PROB`.
- `js/core/Constants.js`: `DEBRIS_TYPES` enum (`CUBESAT:'cubesat'`),
  `DEBRIS_TIER_RANGES` (tier 1–2, label 'CubeSat'), `ASPECT_CAPTURE.ASPECT_BY_TYPE` +
  axis map, `DEBRIS_METAL_PROFILES.cubesat`, and the fragmentation base-rate map (~:1429).
- `js/ui/DebrisWireframe.js`: type label, `SHAPES.cubesat` (small box w/ panel faces),
  `getGeometry` case, `getSurfaceDistance` + bounding-radius map (~:465) entry.
- `js/entities/debrisFerrous.js`: decide if cubesat joins `FIXTURE_TYPES` (grapple
  fixture) — likely no (too small); keep net-only.
- Welcome row #7: `types:['cubesat']`, mass ~10 kg, top reward.
- Flags: cubesat is a satellite but sub-2 m ⇒ not size-eligible ⇒ unflagged (consistent).

### Phase 4 — power-law distribution (DEFERRED, not in this scope)
Documented in principle #3 above for a future pass: clamped Pareto sizing for the 5000
background Points + small-biased within-type sizing for the interactive field. Not
implemented now.

---

## Tests
- Phase 1: pin tests stay green — `test-WelcomeField.js:267` (`fwdM==65`), `:268`
  (`latM>0`, 25 ✓), `:292` (arc `65/69≈0.94≥0.5`). Public planner `spawnWelcomeField`
  uses its own 5–50 kg / 150–1500 m fragments (separate path) — untouched. Add: welcome
  size-hierarchy assertion (all welcome `sizeMeter < 1.1`), reward-monotonic mass check,
  and "welcome piece has no `_flagLookup` entry after spawn".
- Phase 2: assert `DebrisWireframe.isPlateVariant` matches the `_buildFragmentGeo` plate
  branch; assert welcome candidate selection resolves the intended material/variant set
  (gold foil #2, blue cell #3/#5) when such candidates exist, with graceful fallback.
- Phase 3: new test for `cubesat` — size/mass band, net-catchable (≤10 kg), geometry
  builds, registered in every map (label/aspect/metal-profile/tracking). Guard that the
  type appears in `DEBRIS_TYPES` and `getGeometry('cubesat')` returns geometry.
- `node js/test/run-tests.js` green after each phase (currently 3189 passing).

## Playtest (must pass before commit)
Clear `localStorage['spacecowboy_onboarding_v1']`, start M1:
1. #1 dead-centre, ~daughter-sized, net-catchable with **N**; clearly smaller than mother.
2. #2 off to the **right but on-screen**, slightly larger, in range.
3. Cluster reads as a **progression** (small/near → varied/far), reward grows per catch.
4. Pieces look like **spacecraft debris** (panels/foil/cells/bolts), not rocky blobs.
5. #3 out-of-range → teaches **A**; net fires toward target (never 180° off).
6. "OUT OF RANGE" flashes briefly only on the in→out crossing, never while in range.
7. Catching #1 doesn't unpin #2; **no flag** on any welcome piece.

## DECISIONS (resolved)
- **D1 — scope: Phases 1 + 2 + 3** (hierarchy/progression + appearance + cubesat).
  Phase 4 (power-law) deferred.
- **D2 — appearance depth: material + variant selection only**, no geometry rebind.
  Implies re-introducing small `solar_cell`/`mli_mylar` fragment material weights so the
  blue/gold panel-shard slots exist to select (see Phase 2).
- **D3 — #1 anchor: literal daughter** (`sizeM 0.18`, ~0.34 m). Tunable in playtest
  (bump to ~0.25 or pull #1 to ~25 m if it reads too small).

## Out of scope / invariants
- #3 stays centred + free-orbit (autopilot target); pin lifecycle, CA exemption, reticle
  flash logic unchanged. `isFlagEligible` rule unchanged.
- Public `spawnWelcomeField` planner defaults (5–50 kg / 150–1500 m) unchanged.
- `_scenePosition` remains the single source of truth for any pinned target's position.

## Commit
Only after Phases 1–3 pass tests + the M1 playtest. Code changes span
`js/entities/DebrisField.js`, `js/ui/DebrisWireframe.js`, `js/core/Constants.js`,
and (for cubesat) `js/entities/CatalogConverter.js`, `js/entities/debrisFerrous.js`
(+ new tests). Commit per phase if preferred.
