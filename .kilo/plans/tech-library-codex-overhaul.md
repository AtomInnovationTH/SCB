# Tech Library ("I") — Analysis & Improvement Plan

> Scope: the in-game **Tech Library / Codex** opened with the `I` key.
> Code: [`js/systems/CodexSystem.js`](../../js/systems/CodexSystem.js) (data-driven engine; loads
> [`data/codex.json`](../../data/codex.json), **155 entries** as of this lineage),
> [`js/ui/CodexViewerUI.js`](../../js/ui/CodexViewerUI.js) (DOM overlay),
> design source [`LEARNING_THROUGH_PLAY.md`](../../LEARNING_THROUGH_PLAY.md),
> related surfaces: [`MenuScreen.js`](../../js/ui/MenuScreen.js) `<details>` reference groups,
> [`data/debris-catalog.json`](../../data/debris-catalog.json).
> Goal: turn a solid reference into a **delightful, sticky learning instrument** — the place a
> curious / stuck / confused player goes and leaves *more* curious.
>
> **⇒ Implementers: start at [§13 Implementation Quickstart](#13-implementation-quickstart-start-here)**
> (verified file/symbol map, data schema, dedupe list, linear checklist). Decisions are locked in §5a.

---

## 0. The Big Picture — what this sim (and the library) is really for

Per [`GAME_DESIGN.md`](../../GAME_DESIGN.md) §1, Space Cowboy is **"a Newtonian-physics orbital
mechanics simulation dressed as a game"** that **"teaches real orbital mechanics, real ADR
techniques, and real space physics through progressively challenging gameplay."** It is, underneath
the roguelite fishing loop, a **stealth STEM instrument**: the player thinks they're catching junk
and upgrading a ship; they're actually internalizing ΔV budgeting, rendezvous, materials science,
space weather, and the real debris crisis.

**The Tech Library is the third beat of the core teaching pattern** (EXPERIENCE → CONSEQUENCE →
**EXPLANATION**). Its real job is threefold:
1. **Explain at the moment of maximum receptivity** — turn a thing the player just *felt* (eclipse,
   tumble, ΔV alarm) into a concept they *understand*.
2. **Connect the toy to the real world** — every fictional system maps to real ADR tech, real
   missions, real companies, real materials and physics. The library is where "my GSL net" becomes
   "graphene/CNT tether research" and "my mission" becomes "Astroscale, ClearSpace, ISRO's 2030
   debris-free pledge."
3. **Reward and feed curiosity** — be the delightful place a curious/stuck/confused player *wants*
   to open, and leave them following a thread (one question → a fascination journey).

**How the library should serve learning, by topic the user named:**

| Topic | Library's job | Current state |
|---|---|---|
| **ADR mission & purpose** | Why we clear debris; the win condition is the real-world goal | ✗ no PLAYBOOK / mission-purpose entry |
| **ADR tech** | net / harpoon / gripper / gecko / ion-beam tradeoffs | ⚠ partial (`adr_methods_real` only) |
| **ADR companies & ecosystem** | Astroscale, ClearSpace, D-Orbit, LeoLabs, ISRO/IS4OM, regulators | ✗ absent (lives on menu, green) |
| **Graphene** | the GSL net/tether material; why it's revolutionary | ✓ good (`graphene_gsl`, `graphene_supercap`, `hbn_coating`) |
| **CNT (carbon nanotubes)** | the *other* super-fibre; real space-elevator tether candidate | ✗ **0 — missing** |
| **Carbon carbyne** | theoretically strongest material; the dream tether | ✗ **0 — missing** |
| **ΔV** | the master resource; Tsiolkovsky; why it never refills | ✓ good (`delta_v`, Isp chain) |
| **Solar wind** | what drives storms/aurora/drag; distinct from CME | ⚠ thin (folded into `solar_storm`) |
| **Tether technology** | reel, EDT, gravity gradient, materials, dynamics | ✓ strong (10 entries) |
| **Matching orbits / rendezvous** | the heart of orbital mechanics; phasing | ⚠ thin (inside `relative_velocity`) |
| **Orbital docking** | the redock/grapple final-cm problem | ⚠ thin (`docking_precision`) |
| **Atomic oxygen** | LEO erosion; why surfaces degrade | ✓ covered (over-covered — duplicated) |

> **Through-line to lock in:** CNT + Carbyne are the **real candidate materials for the
> `space_elevator` endgame** (already in the codex at TRL 2, "no material yet meets the tether
> strength requirement"). Adding them and *linking* them to the elevator win is a high-value
> tie-back that turns the endgame into a payoff for a materials-science thread the player has been
> pulling since the GSL net.

---

## 1. What "I" Is Today (as-built)

**Pipeline.** `CodexSystem` builds a hardcoded array of **131** entries (`buildEntries()`), each:
`{ id, title, category, shortText, fullText, triggerEvent, triggerCondition, unlocked, seen, icon }`.
Post-processors add `trl`/`trlRationale` (parallel `TRL_ANNOTATIONS` map) and `unlockHint`. The
system subscribes to every distinct `triggerEvent`; on a match it runs `triggerCondition(payload)`
and **queues** the unlock behind a 20 s cooldown (`Constants.CODEX.UNLOCK_COOLDOWN`). `GAME_WIN`
fires immediately. State persists via `getState()`/`restore()`.

**Surfacing.** Unlock emits `CODEX_UNLOCKED` (audio chime + viewer refresh) and `TECH_UNLOCKED`
(SkillsPane "recent tech" strip). `I` toggles `CodexViewerUI`: category sidebar + responsive card
grid + detail pane + debounced search. Locked cards still show title + one-liner + 🔒 TRL badge.

**Current category distribution (131):** PROPULSION 19 · DEBRIS 17 · SENSORS 16 · POWER 16 ·
SPACE_ENVIRONMENT 12 · MATERIALS 11 · TETHERS 10 · ORBITAL_MECHANICS 10 · COMMS 10 ·
HERITAGE 7 · NEWS 3.

### What works (keep)
- Three-beat unlock (experience → consequence → explain) is real and well-tuned.
- Syllabus reveal (locked cards readable) drives curiosity without spoiling depth.
- TRL badge is a clever, honest "is this real?" signal with rationale tooltips.
- Search + per-category progress counters exist.
- The **hazard/failure entries already have wit** (`feep_mercury` "handle with extreme caution,"
  `feep_cesium` "only for spacecraft that never come home"). This is the best-written copy — proof
  the playful-but-accurate register works here.

---

## 2. Findings — Broad & Deep

### 2.1 Content / prose / organization
- **Stale counts everywhere**: header says "114 entries", UI docstring "45 codex entries", another
  comment "113 cards". Actual: **131**. Derive from `entries.length`.
- **Duplicate / overlapping entries** dilute the catalog and split unlocks:
  `specific_impulse`+`specific_impulse_explained`; `south_atlantic_anomaly`+`saa_radiation`;
  `atomic_oxygen`+`atomic_oxygen_erosion`; `laser_comms`+`laser_comms_optical`;
  `edt_propulsion`(PROP)+`edt_physics`(TETHERS); `star_tracker`+`star_tracker_nav`;
  `reaction_wheels`+`cmg_gyroscopes`; `mmod_impact`+`mmod_impact_physics`;
  `space_aluminum`+`aluminum_space`; `titanium`+`titanium_alloys`;
  `carbon_composite`+`carbon_composites`; `space_tether`/`edt_physics` overlap.
- **Mis-categorization.** `SENSORS` is a dumping ground: attitude (`reaction_wheels`,
  `magnetorquers`, `detumble`) and avionics (`triple_redundancy`, `watchdog_timer`, `telemetry`,
  `ecc_memory`) are filed under SENSORS. No ATTITUDE/AVIONICS category despite the design doc
  treating them as first-class (§14, §16). The sidebar is hand-patched to "Sensors & Avionics."
- **No cross-links / "see also".** Isp ↔ FEEP ↔ Xenon/Krypton/Argon ↔ MPD is a natural chain but the
  cards are isolated. No `related: []` field. The doc's whole thesis is *tie-backs*.
- **No tie-back to the lived moment.** When `eclipse_cycle` unlocks at eclipse, it never says "you
  hit this at T+07:32 over the South Atlantic." The strongest hook (episodic anchoring) is thrown away.

### 2.2 Code / pipeline
- **Brittle comms-string coupling.** ~40 entries unlock via
  `p.text.toLowerCase().includes('keyword')` against comms copy. Editing a comms line silently
  breaks an unlock; no test guarantees reachability. **Biggest reliability risk.**
- **Metadata split across 3 maps** (`buildEntries`, `TRL_ANNOTATIONS`, `UNLOCK_HINTS`) keyed by id;
  easy to add an entry and silently default to TRL 9.
- **2275-line monolith of data-as-code** — the only big content body *not* in `data/*.json` despite
  offline-first being a locked principle.
- **`CODEX_OPENED` fires on toggle (open *and* close)** → `TeachingSystem.first_codex` and skills
  discovery can mis-fire on close.
- **`isGameplay` gate**: `I` does nothing on menu/briefing/game-over — can't browse after a run.
- **Search ignores `fullText`** (`entryMatchesQuery` checks title/shortText/category only).
- **No keyboard nav** inside the pane; cards mouse-only; no `/` focus-search; no prev/next in detail.
- **Inline styles everywhere** → per-category theming and responsive tuning are painful.

### 2.3 UX / visual
- **Monochrome cyan** (`#00d4ff`). Categories have icons but **no color identity** — contradicts the
  design doc's emphasis on color as a memory cue; eyes can't pre-attentively sort the grid.
- **Palette disunity with the menu**: menu reference content is **green** (`#00ff88`), codex is cyan.
  Two learning surfaces, two unrelated looks.
- **Bare progress counter** ("37/131"): no per-category bars in-pane, no milestone, no reward loop
  for the library itself.
- **No filters/sort** (New / Locked / Unlocked / by-Recent / by-TRL).
- **HUD badge is a stub** (`StatusPanel._updateCodexBadge()` TODO) — no "new briefings" indicator.
- **Detail dead-ends**: no prev/next, no related jumps, no "where I saw this."
- **No deep-linking** from the world except the conjunction `?` glyph.

### 2.4 Pedagogy (vs. the stated vision)
The library is a clean encyclopedia but delivers **none of the reinforcement layer** the doc wants:
no **chunking into tracks**, no **spaced repetition/recall**, no **tie-backs**, no **reward for
curiosity**, no **journey** ("one question → a fascination journey").

---

## 3. CONTENT GAP MAP — what the sim *models* vs what the codex *explains*

The deepest issue: large simulated systems are under- or un-documented, and three whole *content
types* are missing (how-to-play, real-object catalog, industry/policy).

### 3.1 Capture technology — UNDER-COVERED (rich spec, ~3 thin entries)
`CAPTURE_NET.md` models: spin physics (covered by `net_yo_yo_despin` ✓), rim weights, **cling /
adhesion probability model** (§3), **two capture modes + secure mechanisms** (§3.1), **soft-catch
doctrine** (§5.3), **fragmentation risk per debris class** (§5.4), **tangle mechanics** (5 scenarios,
§4), range analysis (§2.8). Codex has only `net_yo_yo_despin`, `bolas_weapon`, `miura_ori_net`,
`tether_tangle_physics`. **Missing entries:** cling probability & adhesion strategy; soft-catch vs
slam-wrap; fragmentation prevention (why gentle); gecko / Van-der-Waals & electrostatic grip
(named in shop, never explained); harpoon vs net vs gripper tradeoff (real ADR methods).

### 3.2 FEEP — WELL COVERED (the model to emulate)
7 propellant-metal entries (`feep_indium…tungsten`) + `feep_thruster` + Isp. Honest TRL spread
(In=9 … W=4), real heritage, dry wit on the dangerous ones. **Gaps:** the *emitter physics* (Taylor
cone, capillary needle), and tie-back links to Isp/MPD. Otherwise the gold standard for the rest.

### 3.3 Solar cells — PARTIAL
Have `solar_power`, `multijunction_pv`, `gallium_arsenide`, `solar_cell_degradation`. **Missing:**
the upgrade ladder the design doc spells out (Si 22% → GaAs 30% → triple-junction 39% →
perovskite-tandem 45%); sun-angle / gimbal tracking; eclipse-vs-charge budgeting as its own card.

### 3.4 Furnace / forge — UN-COVERED (system exists, zero process entries)
`ForgeSystem` runs a 5-phase pipeline (`IDLE→INTAKE→SEPARATE→MELT→COOL`) with melt-point time
scaling and per-phase mass loss. The codex has material entries but **nothing on the process**:
electromagnetic levitation melting (EML), why no crucible in microgravity, surface-tension
spherical melt, undercooling/nucleation (ISS TEMPUS), alloying, metal→propellant ionization.
The design doc §6.2 already drafts this copy — it just isn't in the codex.

### 3.5 Orbital mechanics — GOOD breadth, missing the "feel" anchors
10 entries (Kepler, Hohmann, inclination, prograde paradox, J2, drag, relative-v, period,
RAAN). The sim actually computes `solveKepler` (Newton-Raphson), full element↔Cartesian, J2.
**Gaps:** eccentricity/apogee-perigee as its own card; the six orbital elements visualized;
phasing/rendezvous loop (ties to relative-velocity); a "why retrograde to catch up" interactive
tie-back to the moment the player did it.

### 3.6 Debris orbits & size distribution — MISSING THE LAW
Sim spawns weighted buckets (fragment 0.60 / defunctSat 0.16 / rocketBody 0.12) and tracks
`alt_km/inc_deg` per real object. `debris_classification` gives the >10cm / 1-10cm / <1cm *counts*
but **not the power law** itself. **Missing entries:** the cumulative **power-law size
distribution** (N ∝ d^−α, the population pyramid: ~36k tracked, ~1M lethal-untrackable, ~130M
sub-cm); **why orbital shells cluster** (LEO bands at 550/790/850 km, SSO at 97.5°, the ISS 51.6°
corridor); altitude-vs-lifetime (drag decay timescales by altitude); the inclination "highways."

### 3.7 Intro / sim basics / sim strategy — ENTIRELY ABSENT (high priority)
**Zero** entries teach the *game's own systems*. Needed as a new **PLAYBOOK** category:
- *Welcome, Cowboy* (the mission premise, win condition: 50 debris / the arc).
- *The Core Loop* (scan → target → autopilot → capture → salvage).
- *Reading the HUD* (the 3 left panels, NavSphere, OrbitMFD, the 5-color system).
- *ΔV is everything* (the master-resource doctrine; why it never free-regenerates).
- *Autopilot-first doctrine* (manual flight is a 1% mastery skill).
- *Tool choice* (net vs arm vs trawl; auto-recommendation; backtick cycle).
- *The arm-sacrifice tradeoff* (reuse vs ×1.5–2.5 deorbit bonus).
- *The salvage economy* (salvage → forge → propellant; the only ΔV refill).
- *Power triage* (the 3-bus ETS under eclipse).
- *Skill multipliers* (×1.0 → ×3.74 capture-quality ladder).
These are the entries a **stuck or confused** player needs most — and they don't exist.

### 3.8 Real-object catalog — WASTED GOLDMINE (new CATALOG category)
`data/debris-catalog.json` holds 40+ real objects with built-in fascination ("notable" facts):
Vanguard-1 (oldest object in orbit), Envisat (8-ton top-priority ADR target), LES-1 ("zombie sat"
that woke after 46 y), Cosmos-2251/Iridium-33 (the 2009 crash), Fengyun-1C cloud, Ariane/Centaur
upper stages. None surface in the codex; there's no catalog viewer. These are natural **collectible
"trading cards"** — unlock the card when you scan/encounter that object class. **Confirmed scope:
a curated ~10–15 marquee set**, not all 40+. Maximum delight per byte; data already exists.

### 3.9 Industry / policy / people — MISSING TYPE (already on the menu, in green)
`MenuScreen.js` `<details>` groups teach the *ecosystem*: Kessler timeline, "cleanup is now
mandatory" (FCC 5-yr rule, ESA Zero Debris, ISRO Debris-Free 2030, EU Space Act), who removes debris
(Astroscale, ClearSpace, Starfish, D-Orbit…), who tracks it (LeoLabs, Slingshot…), agencies, India's
ecosystem, 2026 events. The codex teaches none of this. Bridging it (a **WORLD/INDUSTRY** category,
or pulling menu content into the codex) connects "why am I doing this" to "here's the real industry
you're roleplaying." Note the **palette split** to resolve.

---

### 3.10 Named advanced concepts — confirmed gaps (coverage audit)
Codex grep counts: `carbon nanotube`/`nanotube`/`CNT` = **0**; `carbyne` = **0**;
`buckyball`/`fullerene` = **0**; `solar wind` = 2 (only inside storm entries); `rendezvous` = 4 and
`matching orbit` = 2 (woven into `relative_velocity`, no dedicated card); `docking` = 2
(`docking_precision` only); `graphene` = 9 ✓; `atomic oxygen` = 9 ✓ (duplicated). **New entries to
add (MATERIALS / ORBITAL / ENVIRONMENT):**
- **Carbon Nanotubes (CNT)** — ~63 GPa measured tensile, the sibling of graphene; real
  space-elevator tether candidate; ties to GSL net lineage. **Link → `space_elevator`.**
- **Carbyne** — linear acetylenic carbon; theoretically ~the strongest material (~270 GPa
  predicted); the "dream tether." TRL 1–2, flagged honestly. **Link → `space_elevator`, CNT, graphene.**
- **Solar Wind** — its own card (continuous plasma stream, ~400 km/s, source of storms/aurora/drag),
  distinct from a discrete CME; **link → `solar_storm`, `geomagnetic_storm`, `van_allen_belts`.**
- **Orbit Matching / Rendezvous** — phasing + closing on matched orbits as the core skill;
  **link → `relative_velocity`, `prograde_paradox`, `hohmann_transfer`.**
- **Docking & Berthing** — the final-centimetre grapple/redock problem; **link → `docking_precision`,
  `detumble`.**

---

## 4. Tone & humor — when a lighter touch helps

The menu proves the playful register lands ("Space Cowboys wanted," the **Rawhide / Blues Brothers**
Easter egg, "zombie sat," "gas stations in space"). The codex is mostly earnest-encyclopedic; its
*best* lines are the witty hazard ones. Guidance for a **register map**:

**Lean playful / warm** (curiosity & memory hooks):
- Card **one-liners** (`shortText`) — a wry hook earns the click.
- **"Did You Know?"** resurfacing prompts and **"Curious next?"** journey teasers.
- **CATALOG trading cards** — "zombie sat," "8-ton derelict, nobody's coming for it."
- **Failure / hazard** entries (already the strongest — keep the dry wit).
- **HERITAGE / NEWS** — human stories, mission lore, a wink (a single Rawhide-style egg is fine).
- **PLAYBOOK** intro voice — Houston/ground-station banter ("Welcome to space, Cowboy").

**Stay earnest / precise** (trust & rigor):
- The science `fullText` body, formulas, numbers.
- **TRL rationale** and any safety/hazard *fact* (be witty about consequences, never about the data).
- Anything a learner might quote as fact.

Rule: **humor in the framing, never in the physics.** One Easter egg, not a comedy routine.

---

## 5. Lessons from the menu dropdowns (apply to the codex)

1. **Collapsible groups with count badges** (`<details><summary>…<span class="adr-count">`) — great
   for the proposed **tracks** and for grouping sub-topics within a category.
2. **Rich hover tooltips** (`title="…"`) deliver a second layer of depth without a click — perfect
   for the **CATALOG** cards and `related` chips.
3. **Currency** — the menu is dated 2024-2026 and names real orgs; the codex should match that
   freshness (and the new INDUSTRY content can literally reuse the menu's vetted copy).
4. **Progressive disclosure** (expand-on-click) is exactly the "syllabus → depth" model the codex
   already aims for; align the interaction patterns.
5. **Palette unification** — pick one identity (cyan chrome + per-category hues) and bridge to the
   menu's green, or theme the menu groups to match the codex.
6. **A single tasteful Easter egg** (Rawhide) sets the tone; the codex can earn one too.

---

## 5a. Locked decisions (confirmed with user)
- **Scope: all six phases (0–5) are committed** for the implementation effort, including anchoring,
  completion comms, and the SM-2 spaced-repetition resurfacing.
- **New categories: all four committed** — **PLAYBOOK** (§3.7), **CATALOG** (§3.8),
  **WORLD/INDUSTRY** (§3.9), and **split SENSORS → SENSORS / ATTITUDE / AVIONICS** (§2.1).
  Post-expansion category count: ~14.
- **CATALOG depth: curated highlights** (~10–15 marquee objects: Vanguard-1, Envisat, LES-1
  zombie sat, Cosmos-2251 / Iridium-33, Fengyun-1C, plus a few signature rocket bodies) — not all 40+.
- **Content: full rewrite pass** — beyond merging dupes + adding relations/tracks, weaker entries
  get rewritten/expanded, and every card gains a `realWorld` callout + `formula` chip where apt.
  Apply the §4 register map throughout.
- **Palette: cyan chrome + per-category hues.** `#00d4ff` stays the global frame (header, search,
  borders); each category gets its own accent hue applied to card border/badge/sidebar tick/detail
  header tint. The menu's green becomes the WORLD/INDUSTRY category hue, bridging the two surfaces.
  Hue is **redundant** (always paired with icon + label) and **CVD-safe** (§11.3).
- **i18n: i18n-ready schema, English-only ship.** `data/codex.json` separates translatable fields
  (`title`/`shortText`/`fullText`/`realWorld`/`unlockHint` + category labels/track names) from logic
  (`id`/`category`/`trl`/`related`/triggers); no translation pipeline built now (§11.1).
- **Voice: diegetic (in-world dossier).** Entries read as the mothership's onboard database / a
  Houston dossier — consistent in-world narrator across science, PLAYBOOK, CATALOG, INDUSTRY, and
  completion comms (Mass Effect / Subnautica databank precedent). Real-world references stay factual
  inside that frame; the §4 register map still governs humor.
- **Phase 5 journey UI: connection-map view.** The `related` graph is rendered as an Outer
  Wilds-style node/link map (signature "fascination journey" feature), in addition to inline
  Related chips + "Curious next?" teasers.
- **Reference content is start-unlocked (added this lineage).** PLAYBOOK + WORLD_INDUSTRY entries
  carry `startUnlocked: true` and open immediately — onboarding/exposition is not a gameplay
  "discovery". CATALOG/NEWS stay locked discovery cards. (Schema: optional `startUnlocked` field.)
- **TRL is shown only when notable (added this lineage).** No Tech-Level badge on cards at all; the
  detail view shows the Tech-Level row **only for `trl < 9`** (not-yet-flight-proven). Flight-proven
  is the unremarkable default and stays silent. Presentation-only; the `getEntryTRL` API is unchanged.
- **Lead categories ordered for new players (added this lineage).** Order: PLAYBOOK, WORLD_INDUSTRY,
  DEBRIS, CATALOG, … ; the "All Entries" tab is removed and the viewer opens on the first category.

## 6. Improvement Plan (phased)

> **STATUS (live).** Phases 0–2 shipped; content expanded well past the original slice.
> Current state: **155 entries**, suite **3360 pass / 0 fail**. Content is data-driven in
> `data/codex.json`, regenerated by idempotent patch scripts (`scripts/phase2-content.mjs`,
> `phase2b-newbie-content.mjs`, `phase2c-catalog-news.mjs`). See the Phase 2 handover
> [`tech-library-codex-phase2-handover.md` §13](./tech-library-codex-phase2-handover.md) for the
> detailed post-Phase-2 log (schema `startUnlocked`, newbie onboarding, Catalog/News expansion, and
> the partial Phase-3 viewer work already done).
> - **Phase 0 — DONE** (dedupe/ALIASES, persistence wired, reachability test, CODEX_OPENED-on-open).
> - **Phase 1 — DONE** (data-driven `CodexSystem`, `codex.json`, triggers/interpolate/loader modules).
> - **Phase 2 — DONE & committed** (`4c3812a`): optional TRL, PROPULSION rewrite, concept entries.
> - **Phase 2b/2c — DONE (uncommitted)**: PLAYBOOK/WORLD onboarding (`startUnlocked`), category
>   reorder, Catalog→10 & News→9 (verified facts, acronyms-expanded voice).
> - **Phase 3 — STARTED**: larger pane, "All Entries" tab removed, TRL off cards (detail shows only
>   `trl < 9`). Remaining: per-category hue, detail redesign, Tracks tab, filters, keyboard nav,
>   open-from-any-screen. **Phases 4–5 — not started.**

### Phase 0 — Data hygiene & reliability (foundation, low risk)
- **Reachability test** (`js/test/codex-*.js`): every `triggerEvent` is a real `Events.*`; every
  comms-substring trigger has a matching live string in `CommsSystem`/`SubsystemEvents` copy.
- **De-duplicate / merge** the §2.1 pairs (keep richer text; union the trigger conditions; add an
  `ALIASES` map so old save ids restore). Target ~110 distinct entries pre-expansion.
- **Fix `CODEX_OPENED`** to fire on *open* only.
- **Single source of count**; delete stale "114/45/113" comments.
- **Search includes `fullText`**.
- **Wire codex persistence (NEW — verified gap).** `CodexSystem.getState()/restore()` exist but are
  **never called** (`PersistenceManager` has no codex key; no `codexSystem.getState()` call in
  `main.js`) — unlocks are lost on reload today. Add codex to the save bundle + restore path. The
  `ALIASES` migration (below) only matters once this is wired, so do it here first.

### Phase 1 — Restructure content model (data-driven + relations)
- **Extract entries to `data/codex.json`** (offline-first), loaded by `CodexSystem`; keep
  `triggerCondition` predicates in code keyed by id. Schema adds: `subcategory`, `trl`,
  `related:[ids]`, `track`+`trackOrder`, `realWorld` (mission callout), `formula?`, `unlockHint`.
- **i18n-ready by construction (NEW — see §11.1)**: separate *translatable* fields (`title`,
  `shortText`, `fullText`, `realWorld`, `unlockHint`) from *logic* (`id`, `category`, `trl`,
  `related`, triggers). Structure so a future `data/codex.<lang>.json` (or per-key string table) can
  drop in without touching code — the game already ships a region selector + an anticipated i18n
  layer (`Events.js:208`), and the codex is the largest English text body in the game.
- **Re-categorize (confirmed)**: split SENSORS → `SENSORS` / `ATTITUDE` / `AVIONICS`; add
  **PLAYBOOK** (§3.7), **CATALOG** (§3.8), **WORLD/INDUSTRY** (§3.9). Update `CodexCategory` +
  `CATEGORY_META` with label, icon, and **per-category color** (WORLD/INDUSTRY = menu green).
- **Author `related` links** + validate (no dangling ids).
- **Define learning tracks** (chunking): *The Propellant Story*, *Power Through the Dark*,
  *Why Orbits Are Weird*, *How We Catch* (capture), *The Debris Crisis*, *India to Orbit*,
  *Cowboy Basics* (playbook).

### Phase 2 — Content expansion (fill the gaps from §3)
- **Capture** (§3.1): +4–5 entries (cling/adhesion, soft-catch, fragmentation, gecko/electrostatic,
  ADR-method tradeoff). **Forge** (§3.4): +3 (EML levitation, microgravity metallurgy, metal→fuel).
- **Solar ladder** (§3.3): +1–2. **Debris law** (§3.6): +2–3 (power-law pyramid, orbital shells,
  altitude-vs-lifetime). **Orbital feel** (§3.5): +2 (orbital elements, eccentricity/apogee).
- **Named advanced concepts** (§3.10): **CNT**, **Carbyne**, **Solar Wind**, **Orbit
  Matching/Rendezvous**, **Docking & Berthing** — with the `related`/`space_elevator` links above.
- **PLAYBOOK** (§3.7): ~10 how-to-play entries. **CATALOG** (§3.8): **curated ~10–15** marquee
  cards generated from `debris-catalog.json` "notable" facts (unlock on first scan of that
  object/class).
- **WORLD/INDUSTRY** (§3.9): port the menu's vetted ecosystem/policy copy into entries; unify palette.
- **Full rewrite pass (confirmed)**: rewrite/expand weak existing entries, add `realWorld` callouts +
  `formula` chips, and apply the **§4 register map** to all copy (old and new).

### Phase 3 — Visual & UX overhaul of `CodexViewerUI`
- **Cyan chrome + per-category hues (confirmed)**: `#00d4ff` stays the global frame; a
  `CATEGORY_META[key].color` drives card border/badge/sidebar tick/detail header tint.
  WORLD/INDUSTRY uses the menu's green so the two learning surfaces visually rhyme.
- **CSS class refactor** (one `.codex-*` style block) → theming + responsive cards.
- **Detail redesign**: category-tinted header, TRL row, one-liner highlight, body with a set-apart
  **Real-world callout** + optional **formula chip**, a **Related** chip row, and **‹ Prev / Next ›**.
- **Tracks tab**: ordered steppers with N/total fill (reuse the menu's `<details>`+count pattern).
- **Filters/sort bar** (All/New/Unlocked/Locked; Recent/Category/TRL).
- **In-pane progress**: per-category bars + overall ring; "Track/Category complete!" banners.
- **Keyboard nav** (arrows move focus, Enter open, `/` search, `[`/`]` prev-next; roving tabindex).
- **Open from any screen** (drop the `isGameplay` gate for `I`).

### Phase 4 — Anchoring, journeys & reward (the "delight" layer)
> **Align with the existing reward grammar.** `SKILLS_ARCHITECTURE.md` §D.4 sets a locked rule:
> rewards are **"not points/XP — undimming panels, new capabilities, codex entries, comm
> messages."** Do **not** grant credits/XP for library milestones. Use the established vocabulary.
> **Route ALL comms through the completed Guidance Arbiter** (`GUIDANCE_ARBITER_SPEC.md`): completion
> lines are `_postOnboarding`-tagged and obey `_suppressionTier`; they are NOT `_critical`.
- **Unlock context**: capture `{ missionTime, altitude, region/event }` on unlock; detail shows
  "Discovered: orbit 3 · eclipse · S. Atlantic." (episodic anchoring).
- **HUD badge** (finish the stub): unseen-count pip on the `I` affordance.
- **Deep-links from the world**: salvage reveal → "Learn: Gallium Arsenide"; weather advisory →
  "Learn: Geomagnetic Storms"; shop tooltip → its entry. New `codex:open-entry` event the viewer honors.
- **Completion acknowledgement** (no points): on first 100% of a category/track, a **Houston comm
  line** + the chime + an in-pane banner (and, where natural, a HUD undim) — never a credit grant.
- **Milestones**: 25/50/75/100% overall → comm line + toast + cosmetic.

### Phase 5 — Spaced repetition & "fascination journey" (highest ambition)
> **Reuse, don't reinvent.** The SM-2 reminder is **already implemented inline in `SkillsSystem`**
> (a 1 Hz loop in `update(dt)` with per-record `nextReminderAt`/`reminderInterval`, seeded from
> `Constants.SKILLS.REMINDER_BASE_INTERVAL`) — there is **no standalone `SkillReminder` class**. The
> Guidance Arbiter is the SSOT for "who can talk": every resurfacing nudge MUST pass
> **`SkillsSystem.canFireHint(id,…)`** (the universal rule: undiscovered OR recently-failed, never
> before, `< Constants.SKILLS.MAX_UNHEEDED_NUDGES` unheeded) and use **`getHintPresentation()`** +
> the `_suppressionTier`. Do not add a parallel cadence.
- **"Did You Know?"** resurfacing via comms during quiet flight, gated by `canFireHint` +
  SM-2 cadence over unlocked-but-unseen entries (respects caps, blitz suppression, veteran downgrade).
- **"Curious next?"** at the foot of each detail: 1–2 related/locked entries framed as questions.
- **Connection-map view (confirmed)**: render the `related` graph as an Outer Wilds-style node/link
  map — a dedicated browsing mode that visualizes how concepts connect and what's still locked,
  turning curiosity into a navigable path.
- **Per-category unlock chimes** (extend `AudioSystem` `CODEX_UNLOCKED`) so sound cues the topic family.
- **One tasteful Easter egg** (codex's own Rawhide), in the diegetic voice.

---

## 7. Concrete file touch-list

| File | Change |
|---|---|
| `js/systems/CodexSystem.js` | Load `data/codex.json`; merge dupes + `ALIASES`; add `related`/`track`/`realWorld`/context fields; open-only `CODEX_OPENED`; `searchEntries` over fullText; `codex:open-entry` hook; capture unlock context; generate CATALOG entries from `debris-catalog.json`. |
| `data/codex.json` (new) | Externalized entries + metadata (offline-first). |
| `js/ui/CodexViewerUI.js` | CSS-class refactor; per-category color; detail redesign (real-world/formula/related/prev-next); Tracks tab; filters/sort; progress bars + milestone banners; keyboard nav; deep-link; drop isGameplay gate at call site. |
| `js/ui/hud/StatusPanel.js` | Implement `_updateCodexBadge()` unseen pip. |
| `js/systems/InputManager.js` | Allow `I` outside gameplay; emit `CODEX_OPENED` on open only. |
| `js/ui/MenuScreen.js` | Source/share INDUSTRY copy; align palette. |
| `js/systems/AudioSystem.js` | Per-category unlock chime (Phase 5). |
| `js/core/Events.js` | Add `CODEX_OPEN_ENTRY` (`codex:open-entry`). |
| `js/core/Constants.js` | Category color map; track defs; reuse `SKILLS.REMINDER_*` for SR cadence. |
| `js/systems/CommsSystem.js` | Houston comm lines for category/track/milestone completion via `addMessage(pri, source, text, { _postOnboarding:true })` (no points). |
| `js/systems/SkillsSystem.js` | Extend the **existing inline 1 Hz reminder loop** (`update(dt)`) to also resurface codex entries; gate via `canFireHint`/`getHintPresentation`. No new class. |
| `js/systems/PersistenceManager.js` + `js/main.js` | **Wire codex `getState()/restore()`** into the save bundle + restore path (currently unwired). |
| `js/test/` | trigger reachability; related-id integrity; track integrity; dedupe/alias restore; search-over-fullText; CATALOG generation. |

---

## 8. Risks & non-goals
- **Codex persistence is currently UNWIRED** (verified): `getState()/restore()` exist but nothing
  calls them. Wire it in Phase 0; then merged/renamed ids restore old saves via an `ALIASES` map +
  test. The full rewrite also changes `seen/unlocked` semantics → version the save schema.
- **Offline-first**: `data/codex.json` and catalog cards load from local disk; no network.
- **Scope is now very large** (all 6 phases + full rewrite + 4 new categories): real risk of a
  stalled mega-effort. Mitigate with a **vertical slice first** (§12) and content batching.
- **UI is not unit-testable in the Node harness** (§11.4): keep all logic in `CodexSystem`
  (testable); validate `CodexViewerUI` via `test.html` / manual / optional jsdom.
- **Comms channel contention** (§11.2): resurfacing + completion lines must obey the Guidance
  Arbiter or they will nag veterans / fight onboarding — a regression risk for a shipped system.
- **Non-goals**: no live data feeds, no cloud sync, no rewrite of the three-beat philosophy, no raster
  diagram pipeline (CSS/vector callouts only).

---

## 11. Plan self-critique — gaps, upgrades, and what each audience needs

### 11.1 Localization / i18n — biggest blind spot (now addressed in Phase 1)
The game ships a **region selector** (English/Thai/Hindi/Tamil via `Languages.js` +
`SettingsManager.setLanguage`) and `Events.js:208` anticipates a re-render-on-language-change i18n
layer — but content is English-only today, and **the codex is the single largest text body**.
Decisions to make explicit: (a) split translatable vs logic fields in `data/codex.json`; (b) decide
English-only-but-ready vs stub the pipeline; (c) number/unit formatting per locale; (d) the
per-category *labels/tracks* are also translatable. Getting the schema right now is nearly free;
retrofitting 160+ entries later is not.

### 11.2 Guidance-Arbiter integration is mandatory, not optional
The arbiter is **already built and is the SSOT** for who may talk: `_suppressionTier` 0–3, tag
bypasses (`_onboarding`/`_postOnboarding`/`_critical`/`_lassoFeedback`), and the **universal
hint-gating rule** (fire only if undiscovered OR recently-failed, never before, ≤3 unheeded → then
silence). Phase 4 completion comms and Phase 5 resurfacing **must** route through
`SkillsSystem.canFireHint`/`getHintPresentation` and the tier model, or they regress a shipped
"respect the player" invariant. Folded into Phases 4–5.

### 11.3 Accessibility — under-specified
- **Color-blind safety**: per-category hue must **never be the only cue** — always pair with the
  category icon + label (the hue is redundant reinforcement, not the signal). Pick a CVD-safe palette.
- **Reduced motion**: respect `prefers-reduced-motion` for the new banners/pulses/chimes.
- **Screen-reader semantics**: the overlay is inline-styled `div`s; add roles/aria, a real focus
  trap (ESC exists), and roving-tabindex (already in Phase 3 keyboard nav) — make it explicit AC.
- **Font scaling / long strings**: i18n + a11y both stress layout (German/Tamil expansion) — cards
  must wrap gracefully, not clip.

### 11.4 Test strategy must match a Node-only harness
`run-tests.js` is Node-safe only (no DOM/THREE). Therefore: **all testable logic lives in
`CodexSystem`** (entry-data integrity, dedupe/ALIASES restore, related-id graph, track integrity,
trigger reachability, search-over-fullText, CATALOG generation). `CodexViewerUI` cannot be unit
tested there — cover it via `test.html` (browser), manual QA checklists per phase, or add jsdom as a
deliberate decision. State acceptance criteria per phase so "done" is unambiguous.

### 11.5 Performance / scale
Today the grid re-creates **every** card on each render; post-expansion (~160+ entries + tracks +
filters) this gets heavier. Use `DocumentFragment`/incremental render, cache card nodes, and
consider light virtualization for the full list. Keep the search debounce.

### 11.6 Surface redundancy — reconcile codex vs SkillsPane "recent tech"
Two places show unlocks: the SkillsPane "recent tech" strip (transient `TECH_UNLOCKED`) and the
library (permanent). Define roles cleanly — strip = *"something new arrived, press I"* ephemeral
nudge; library = the durable home — and make the strip deep-link into the new entry (Phase 4
`codex:open-entry`). Otherwise the two compete and confuse.

### 11.7 Content governance & style guide
160+ factual entries need: a **one-page style guide** (entry length bands, reading level, voice per
category per §4, units, number formatting, em-dash/quote conventions); a **sourcing/verification**
note per volatile fact; and a **"last-verified YYYY-MM"** field for WORLD/INDUSTRY/NEWS. Without
this, the full-rewrite pass drifts in tone and the credibility (the product's whole value) erodes.

### 11.8 What a NEW user expects from this resource
- **"What do I do now?"** — a quick-start / core-loop / controls path (the PLAYBOOK answers this; it
  must be reachable from the menu/briefing, hence "open from any screen").
- **A jargon glossary** — ΔV, RAAN, FEEP, TRL, Isp, eclipse, conjunction. Reuse the menu's
  hover-tooltip (`title=`) pattern as an **inline glossary layer** game-wide, not just in the codex.
- **Skimmable, progressive, non-punishing** — short one-liners, no walls of text, search that works
  (incl. fullText), and zero fear of "doing it wrong" by reading.
- **"You are here / next"** — gentle orientation, not a tech-tree maze.

### 11.9 What an EXPERIENCED player needs
- **Fast lookup**: fullText search, keyboard-only nav, deep-links, prev/next — already planned; keep.
- **Reference / stat tables** bound to live `Constants` (Isp values, propellant cost, net classes,
  debris classes, skill multipliers) — generalize the existing `net_yo_yo_despin` live-value trick.
- **Optimization depth**: when to use which propellant/tool, salvage-synergy sets, the ×1.0→×3.74
  skill ladder — strategy entries, not just physics.
- **Collection meta + declutter**: 100% tracking, CATALOG trading cards, and a **"hide mastered"**
  toggle so veterans aren't re-shown basics.
- **A connection/"tech-tree" view** (see §11.10) for power browsing.

### 11.10 Design upgrades worth considering (best practices)
- **Connection-map view of the `related` graph** — the Outer Wilds "Ship Log / Rumor Map" is the
  gold standard for curiosity-driven exploration and directly serves the "one question → a
  fascination journey" goal better than a flat list. Strong candidate for the Phase 5 journey UI.
- **Dual-mode codex** (just-in-time unlock *and* anytime lookup) — we have unlock; ensure lookup is
  first-class (glossary, search, deep-link).
- **Diegetic framing** (ship database / Houston dossier voice) — Mass Effect / Subnautica databank /
  Outer Wilds precedent; pick one voice and apply consistently (open question in §10.3).
- **Reward, not homework** — Hades/Hollow Knight Hunter's Journal model: optional, celebratory,
  never a quiz. Our SR must stay opt-in and arbiter-gated.
- **Redundant encoding** (icon + label + color), consistency, and progressive disclosure — all
  established codex best practices we should hold as acceptance criteria.

---

## 12. Recommended de-risking: a vertical slice first
Given the now-large scope, build **one category end-to-end through all six phases before scaling**:
suggest **PROPULSION** (rich, already strong, has the FEEP exemplar and a natural track "The
Propellant Story"). Deliver: deduped + rewritten PROPULSION entries in `data/codex.json` (i18n-ready,
related-linked, tracked), the per-category color + detail redesign, one PLAYBOOK + one CATALOG + one
WORLD/INDUSTRY card, the badge, one deep-link, one completion comm line (arbiter-gated), and one SR
resurfacing — all test-gated. This proves the data model, the UI patterns, the arbiter wiring, and
the content style guide on a small surface, then the remaining ~13 categories become batched
content + data work rather than open design questions.

**Per-phase acceptance criteria (define before coding):** e.g., Phase 0 = reachability test green +
zero duplicate ids + counts derived; Phase 1 = `data/codex.json` loads, all `related` resolve, saves
restore via ALIASES; Phase 3 = keyboard-only + CVD-safe + reduced-motion verified in `test.html`;
Phase 4/5 = no nudge fires when the arbiter says silent (unit-tested).

---

## 9. Suggested sequencing
1. Phase 0 — reliability + dedupe (make the current thing correct).
2. Phase 1 — data model + relations + new categories.
3. Phase 2 — fill the §3 content gaps (capture/forge/debris-law/PLAYBOOK/CATALOG/INDUSTRY + §3.10 named concepts).
4. Phase 3 — visual/UX overhaul (the visible win).
5. Phase 4 — anchoring + badge + deep-links + completion comms (stickiness).
6. Phase 5 — spaced repetition (reuse SM-2) + journeys (ambition layer).

---

## 10. Information still needed before/while implementing

### 10.1 From the code (✅ = verified this pass; see §13 for exact anchors)
- **`CatalogLoader.js`** — ✅ singleton `catalogLoader`; `getDebrisByNorad(norad)` + parallel getters;
  Maps keyed by norad/id. **Open contract:** in-world debris is *procedural* (`DebrisField`), so
  CATALOG cards likely unlock via `StrategicMap` / `news-events` / active-sats, **not** `SCAN_*` —
  confirm the trigger before wiring (see §13).
- **`CommsSystem.js`** — ✅ emit via `addMessage(priority, source, text, { _postOnboarding:true })`;
  tags `_critical`/`_onboarding`/`_postOnboarding` bypass tiers. Still enumerate the comms strings
  that codex `triggerCondition`s match for the Phase-0 reachability test.
- **`Events.js`** — ✅ relevant events confirmed: `SCAN_DISCOVERY`, `TARGET_DISCOVERED`,
  `SALVAGE_SCAN`, `CODEX_UNLOCKED/VIEWED/UNLOCK_REQUEST/OPENED`. `CODEX_OPEN_ENTRY` is **new**.
- **`SkillsSystem.js`** — ✅ `canFireHint()` + `getHintPresentation()` exist; SR is an **inline 1 Hz
  loop** in `update(dt)` (no `SkillReminder` class); constants `REMINDER_BASE_INTERVAL`,
  `MAX_UNHEEDED_NUDGES`, `BLITZ_*`.
- **`PersistenceManager.js`** — ✅ **codex is NOT persisted** (no codex key; `getState/restore`
  never called). Wire it in Phase 0, then add `ALIASES`.
- **`ShopScreen.js` / `ForgeSystem.js`** — forge phases are `IDLE/INTAKE/SEPARATE/MELT/COOL`
  (`FORGE_PHASE_CHANGE` event); still map upgrade ids for tooltip deep-links.

### 10.2 From the docs
- **`archive/SKILLS_SYSTEM_DESIGN.md` §5.2** — the original SR/SM-2 spec referenced by
  SKILLS_ARCHITECTURE; confirm the canonical algorithm + constants.
- **`CROSSBOW_ARMS.md`, `DAUGHTER_MULTITOOL_SPEC.md`** — authoritative copy for the capture/grip
  entries (gecko, electrostatic, harpoon-vs-net) so new prose matches the as-designed tech.
- **`MISSION_ARC_IMPLEMENTATION.md` / `MISSION_GUIDANCE_DESIGN.md`** — the 12-mission arc, to slot
  PLAYBOOK + HERITAGE endgame entries (and confirm `space_elevator` tie-back framing).
- **`GUIDANCE_ARBITER_SPEC.md`** — who is allowed to "talk" (coach/comms arbiter) so "Did You Know?"
  resurfacing and completion comms don't fight onboarding for the comms channel.

### 10.3 Questions for the user (product decisions)
- ✅ **Scope**: all six phases (0–5) committed. ✅ **CATALOG**: curated ~10–15. ✅ **Content**: full
  rewrite pass. ✅ **Palette**: cyan chrome + per-category hues. *(resolved — §5a)*
- **Still open — WORLD/INDUSTRY currency**: who owns keeping company/policy facts fresh, and is a
  "last-verified YYYY-MM" stamp acceptable in-entry (matching the menu's dated style)?
- **Still open — Voice / diegesis**: is the library in-world (a ship database / Houston dossier) or
  meta-narrator? (Affects PLAYBOOK/CATALOG/INDUSTRY voice — see §11.10.) How spicy may the Easter egg be?
- **New — i18n intent**: English-only now with an i18n-ready schema, or do we also stub the
  pipeline for the languages the menu already offers (Thai/Hindi/Tamil)? *(see §11.1)*
- **New — a11y baseline**: commit to color-blind-safe (never hue-alone), reduced-motion, and
  keyboard/focus semantics as acceptance criteria? *(see §11.3)*

### 10.4 Online research (verify real-world facts before writing entries)
> Offline-first is a *runtime* principle; authoring research is fine, but every figure must be
> checked — the codex's credibility is the product.
- **CNT** tensile strength (measured vs theoretical), and current space-tether research status/TRL.
- **Carbyne** predicted strength + synthesis state (confined-in-CNT results) for an honest TRL 1–2.
- **Solar wind** baseline numbers (speed, density) and the wind-vs-CME distinction.
- **ADR ecosystem currency (2026)**: Astroscale ADRAS-J2, ClearSpace-1 redirect to PROBA-1,
  D-Orbit RISE, Starfish Otter, LeoLabs/Slingshot, ISRO IS4OM / Debris-Free-2030, FCC 5-yr rule,
  ESA Zero Debris, EU Space Act — reconcile with the menu's existing vetted blurbs.
- **Debris population power-law** exponent and the current ESA/NASA population figures by size bin.
- **Real catalog "notable" facts** (Vanguard-1, Envisat, LES-1 zombie sat) for CATALOG cards.

---

## 13. Implementation Quickstart (start here)

> **Section order note:** the plan grew organically; numeric order is §0–8, **11, 12, 9, 10, 13**.
> A new session can implement straight from this section — it consolidates the verified contracts.

### 13.1 Verified file & symbol map
| Concern | Symbol / location | Notes |
|---|---|---|
| Entry data + unlock engine | `js/systems/CodexSystem.js` (2275 LOC, **131 entries** in `buildEntries()`) | `_performUnlock`, `_checkUnlocks`, 20 s queue; `getState/restore` (unwired) |
| Viewer (DOM) | `js/ui/CodexViewerUI.js` (494 LOC) | inline styles; `_makeCard`, `_showDetail`, `_renderEntryList` |
| Toggle | `InputManager.js` `case 'KeyI'` (~L1301) → `d.codexViewerUI.toggle()` + `eventBus.emit(Events.CODEX_OPENED)` | gated by `isGameplay`; emits on open+close (bug) |
| Toggle bus | `main.js:803` `eventBus.on('codex:toggleUI', …)` | |
| HUD badge stub | `StatusPanel.js:1887` `_updateCodexBadge()` (TODO) | |
| Recent-tech strip | `SkillsPane.js` ← `Events.TECH_UNLOCKED` | reconcile per §11.6 |
| Codex constants | `Constants.js:2045` `CODEX:{UNLOCK_COOLDOWN:20, NOTIFICATION_DURATION:4}` | |
| TRL helpers | `Constants.js` `trlToBadgeColor/trlToLabel/trlToTechLevelLabel/techLevelBadgeText` (exported) | |
| Hint gate | `SkillsSystem.js` `canFireHint(id,{cause,now})` (L261), `getHintPresentation()` (L296), inline 1 Hz SR loop in `update(dt)` | constants `REMINDER_BASE_INTERVAL`, `MAX_UNHEEDED_NUDGES`, `BLITZ_*` |
| Comms emit | `CommsSystem.js` `addMessage(priority, source, text, tags?)`; `Events.COMMS_SEND` forwards to it | tags: `_postOnboarding`, `_critical`, `_onboarding` |
| Catalog | `catalogLoader` singleton; `getDebrisByNorad(norad)` + getters; data `data/debris-catalog.json` | |
| i18n | `js/core/Languages.js` `LANGUAGES`; `SettingsManager.setLanguage(code)`; `Events.js:208` i18n note | content English-only today |
| Tests | `js/test/run-tests.js` (Node-only, no DOM/THREE); browser `test.html` | logic in CodexSystem is testable; viewer is not |
| Teaching overlay | `TeachingSystem.js` `first_codex` ← `Events.CODEX_OPENED`; arbiter queue/drain | |

### 13.2 `data/codex.json` schema (target)
```jsonc
{
  "version": 1,
  "entries": [{
    "id": "feep_indium",                  // stable; logic key (NOT translated)
    "category": "PROPULSION",             // logic
    "subcategory": "feep_metals",         // optional grouping
    "trl": 9,                             // logic (badge)
    "track": "propellant_story",          // optional; chunking
    "trackOrder": 3,                      // position in track
    "related": ["specific_impulse","feep_thruster","mpd_burst"], // graph edges → §Phase5 map
    "trigger": "FEEP_METAL_CHANGED",      // event name (predicate stays in code, keyed by id)
    "icon": "🔬",
    "i18n": {                             // TRANSLATABLE block (English now; per-locale later)
      "title": "FEEP Propellant: Indium",
      "shortText": "…",
      "fullText": "…",
      "realWorld": "Enpulsion IFM Nano · LISA Pathfinder (2016)",
      "formula": "Isp = … (optional)",
      "unlockHint": "Switch a daughter's FEEP metal to Indium."
    }
  }]
}
```
- `triggerCondition` predicates stay in `CodexSystem` keyed by `id` (JSON can't hold functions).
- `ALIASES = { old_id: new_id }` for the dedupe merges so old saves restore.

### 13.3 Dedupe merge list (Phase 0 — keep richer text, alias the loser)
`specific_impulse`←`specific_impulse_explained` · `south_atlantic_anomaly`←`saa_radiation` ·
`atomic_oxygen`←`atomic_oxygen_erosion` · `laser_comms`←`laser_comms_optical` ·
`edt_physics`←`edt_propulsion` · `star_tracker`←`star_tracker_nav` ·
`reaction_wheels`←`cmg_gyroscopes` · `mmod_impact`←`mmod_impact_physics` ·
`aluminum_space`←`space_aluminum` · `titanium_alloys`←`titanium` ·
`carbon_composites`←`carbon_composite`. (Confirm fullText winner per pair before deleting.)

### 13.4 Linear task checklist
1. **Phase 0**: reachability test (every `triggerEvent`∈`Events`; every comms-substring trigger has a
   live string); merge §13.3 + `ALIASES`; **wire persistence** (add codex to save bundle/restore);
   `CODEX_OPENED` open-only; counts from `entries.length`; `searchEntries` over `fullText`. → tests green.
2. **Phase 1**: build `data/codex.json` (§13.2); `CodexSystem` loads it; add categories
   (PLAYBOOK/CATALOG/WORLD_INDUSTRY + split ATTITUDE/AVIONICS) with CVD-safe color+icon+label;
   author + validate `related`; define tracks. → data-integrity tests green.
3. **Phase 2**: full rewrite + new entries (capture/forge/solar/debris-law/orbital/§3.10 CNT·carbyne·
   solar-wind·rendezvous·docking/PLAYBOOK×~10/CATALOG×~12/WORLD_INDUSTRY from menu copy), diegetic
   voice + §4 register + style guide (§11.7).
4. **Phase 3**: `CodexViewerUI` CSS-class refactor; per-category hue; detail redesign (realWorld +
   formula + related chips + prev/next); Tracks tab; filters/sort; progress bars; keyboard nav;
   open-from-any-screen. → verify in `test.html` (keyboard-only, CVD, reduced-motion).
5. **Phase 4**: unlock-context capture; `StatusPanel` badge; `CODEX_OPEN_ENTRY` deep-links (salvage/
   weather/shop/strip); completion comms via `addMessage(...,{_postOnboarding:true})`.
6. **Phase 5**: extend SkillsSystem SR loop to codex (gate via `canFireHint`/`getHintPresentation`);
   "Curious next?"; **connection-map view** of `related`; per-category chimes; one Easter egg.

**Do the PROPULSION vertical slice (§12) across steps 1→6 first**, then batch the rest.
