# Capture Feedback & Risk Overhaul — Live Tool Odds, Orientation Capture, Risk/Reward

## The imagined gameplay (design north star)

You pilot a Weaver toward a 7 m rocket body tumbling at 24°/s. Your wide scan traced
its wireframe into the dossier pane — type, size, and a salvage manifest of redacted
rows: `▓▓▓▓ ▓▓ kg`. Something's in there. You close to 50 m and hold station; a survey
ring fills and the chest opens — line by line: brittleness 0.7, titanium shell,
`Xenon 2.1kg ·₹840`, `EST. VALUE ₹4,300`. Now you *want* this one, and you know it's
fragile. The reticle's tool strip shows live odds for every verb in your toolset,
updating every frame:

```
  NET 0%  TOO WIDE·broadside   MAGNET 12%  non-ferrous   GRIPPER 78% ▶
```

You hold **U** — the de-spin laser bites, and you literally watch `NET 0%` stay pinned
(width problem) while `GRIPPER 78% → 91%` climbs as the tumble bleeds off. The tumble
freezes at 6°/s and the rocket body's long axis stops sweeping. Now the aspect readout
matters: `ASPECT: BROADSIDE — orbit to end-on`. You thrust 90° around the target; the
readout flips to `END-ON ✓` and `NET 0% → 96%` — the 5 m mouth can swallow the 2 m
cross-section lengthwise. Fire. Engulf. The tension bar spikes amber as you hold the
fast-reel key to save time — push it too hard and the net rips or the tether snaps; slam
a brittle solar array at speed and it shatters into five new tracked fragments (Kessler
ticks up, mercy rule the first time). Every lever is visible, every improvement is
instant feedback, every shortcut is a priced risk.

**Core loop payoff:** see odds → pull a lever (de-spin, reposition, close in, slow down,
switch tool) → watch odds rise → fire → quick reward. Impatience is allowed but priced.

---

## Ground truth (verified in code)

- `computeClingProbability()` — js/entities/CaptureNet.js:61-107; already the SSOT for net odds, already rendered as `P-CLING ~NN%` while piloting (js/ui/DockingReticle.js:900-985, per-frame).
- `assessNetFit()` — CaptureNet.js:195-208; scalar width/mass/tumble verdict used by reticle, TargetPanel, ToolRecommender.
- `computeFragRisk()` — CaptureNet.js:221-237; **computed at `_resolveCatch` (CaptureNet.js:757) but never rolled — fragmentation consequence is dormant.** `handleFragmentation()` + mercy rule exist (CaptureNet.js:1266-1277, emits `NET_FRAGMENTATION`); `KesslerSystem` listens to `INTERACTION_FRAGMENTATION` (KesslerSystem.js:332); `DebrisField.createFragments()` exists (DebrisField.js:2625).
- Debris already has live 3D orientation: `tumbleAxis` (unit Vector3) + `tumbleAngle`, applied via `setFromAxisAngle` (DebrisField.js:650-652, 712-713, 1703). Shapes per type: rocketBody=**cylinder**, defunctSat=box, fragment=icosahedron (DebrisField.js:41-46). `sizeMeter` is a single scalar (no aspect data yet).
- ToolRecommender (js/systems/ToolRecommender.js:44-133) returns ★ scores 0-3 + hints, not probabilities.
- Strain slip: `_checkNetIntegrityOnReel` (ArmUnit.js:4204-4250), fail band 80-100% rated (`NET_STRAIN_SAFE_FRACTION`/`FAIL_PROB_MAX`, Constants.js:798-799). Tether snap `_snapTether` (ArmUnit.js:4262+). Reel speed is currently automatic (no player control).
- `fireMotherNet` silent null refusals — CaptureNet.js:1066-1070.
- TeachingSystem moment pattern — js/systems/TeachingSystem.js:30-166 (19 once-per-save moments).
- No eddy-current/magnetic detumble exists anywhere (grep confirmed); de-spin is laser-only (js/systems/DespinLaser.js).
- Progressive data already half-exists: `SensorSystem` has distance-gated `DATA_LEVELS`
  FAR *Unresolved* → MEDIUM *Classified* → NEAR *Analyzed* → CLOSE *Full Profile*
  (SensorSystem.js:51-56, enrichment at :354) and a scan-pays-credits economy
  (SensorSystem.js:97-109). `DebrisWireframe` is a right-column rotating-wireframe
  analysis panel with zone/salvage display (js/ui/DebrisWireframe.js, mounted by
  HUD.js:211-230). Every debris carries a generated salvage manifest (DebrisField.js:689).

---

## Phase 0 — Guidance bug fixes (small, independent, ship first)

1. **TargetPanel fit badge uses the actual arm's net class** — js/ui/hud/TargetPanel.js:~450
   currently hardcodes MEDIUM. Look up the selected/next-available daughter's class
   (`getNetClassForType(arm.type)`); if no arm context, show dual badge `W✓ S✗`.
2. **No GRIPPER advice on Spinner** — js/ui/DockingReticle.js:958: gate on
   `Constants.DAUGHTER_TOOLSETS[arm.type].includes('GRIPPER')`; Spinner fallback text:
   `'too wide — recall [R], send the Weaver [D]'`.
3. **Mother net refusal comms** — CaptureNet.js:1066-1070 + its caller: on null return emit
   `COMMS_MESSAGE`: `'Mother net reloading — Ns'` / `'Mother net magazine empty — restock at shop [B]'`
   (mirror LassoSystem.js:479-630 denial style).
4. **Strain-band cause in failure message** — ArmUnit.js:4243: when `strainFail`, append
   `'(catch was ${pct}% of the net's rated mass — slips become likely above 80%)'`.
   (Pre-fire strain warning itself lands in Phase 1's odds model.)
5. **`deployFreefly()` parity** — ArmUnit.js:~940-956: add the same mass check `deploy()`
   has (ArmUnit.js:879-886) and `_postDeployRefusalHint` ticker calls for spring/fuel/mass.
6. **De-spin proactive teaching** — new TeachingSystem moments (copy pattern at
   TeachingSystem.js:30-166):
   - `first_high_tumble_target` — trigger: player targets debris with tumble > 10°/s
     (hook `TARGET_SELECTED`/equivalent). Text: *"That target is tumbling at N°/s — nets
     slip off fast spinners. Hold U to fire the de-spin laser; watch the capture odds
     climb as the tumble bleeds off, then net it."*
   - `first_despin_in_spec` — trigger: `DESPIN_IN_SPEC` (Events.js:516, currently unused).
     Text confirms the loop: *"Tumble in spec — odds restored. This works on any spinner."*

## Phase 1 — Unified live Tool Odds model + HUD (the centerpiece)

**1a. New pure module `js/systems/ToolOdds.js`** (Node-safe, unit-tested like ToolRecommender):

```
computeToolOdds({ armType, toolset, target, range, vRel, netClass, despinning })
  → { NET: {p, blocker, hint}, MAGNET: {...}, GRIPPER: {...}, PAD: {...} }
```

- **NET**: `computeClingProbability(...)` (same inputs as DockingReticle.js:917-925)
  **× strain survival** `(1 − strainFailP)` from the 80-100% band (mirror
  `_checkNetIntegrityOnReel` math, ArmUnit.js:4204-4250) **× width gate** (0% when
  presented width > mouth — scalar now, orientation-aware in Phase 2). `blocker` names
  the dominant suppressor: `'TOO WIDE'` / `'STRAIN 26%'` / `'TUMBLE'` / `'RANGE'`.
- **MAGNET**: reuse `MAGNETIC_GRAPPLE` model (ferrous hull ≈ high p, fasteners mid,
  `P_GRIP_NON_FERROUS` 0.05 — Constants.js:319; 0 above `MAX_DEBRIS_MASS_KG`). Verify
  exact grip-probability code in ArmUnit.js:~3400-3540 at implementation and reuse it.
- **GRIPPER / PAD**: largely deterministic gates today → report 95%/0% with the gate
  reason (`'too heavy'`, `'contact too fast'` for pad per ArmUnit.js:3796).
- `ToolRecommender` becomes a thin wrapper (▶ = argmax p) so ★ HUD and odds never disagree.

**1b. Reticle Capture Odds Strip** — replaces the vertical ★-score tool list in
`_drawToolSelectionPanel` (DockingReticle.js:794-893) with a horizontal strip. The %
is the hero; names are footnotes:

```
┌─ WEAVER ────────────────────────────┐
│   68%↑        0%         93%        │   ← 14px bold, color-coded, trend arrow
│  ▶NET·3      MAG        GRAB        │   ← 9px; ▶ selected; ·3 magazine count
│              WIDE                   │   ← 8px red blocker word, only when 0%/--
│  tumbling 18°/s — de-spin [U]       │   ← advisory: single biggest lever
│  [`] cycle   [F] fire    ⚠FRAG 22%  │   ← frag chip only when risk ≥ 10%
└─────────────────────────────────────┘
```

Design rules (constants under a new `Constants.TOOL_HUD` block):
- **Fixed columns in cycle order** (~48px each) so the eye learns positions; numbers
  14px bold, labels 9px dim. Color: ≥80% green `#00ffaa`, 50-79 amber `#ffd166`,
  1-49 `#ff7755`, 0% dim grey + red blocker word (`WIDE` / `HEAVY` / `NON-FERR` /
  `EMPTY` / `FAST`). Empty magazine shows `--` not `0%` (different cause, different fix).
- **Motion = the reward.** True odds computed at ~10 Hz; *displayed* value eases toward
  it (~300 ms lerp) so de-spinning reads as a live count-up: `41%↑ 48%↑ 57%↑`. Trend
  arrow `↑`/`↓` when |Δ| > 2%/s, with a brightness pulse while rising. This is the
  feedback loop that teaches "laser/eddy/reposition → odds climb".
- **Selected vs recommended**: ▶ + odds-colored underline on selected; if a different
  tool beats the selected by >20 pts, the advisory offers it: `GRAB 93% — switch [\`]`.
- **One advisory line only** — driven by the selected tool's top `blocker`, preserving
  the existing priority chain (DockingReticle.js:957-977: width → range → off-axis →
  tumble, with the live `de-spinning N°/s → 10°/s` readout while lasing).
- **Honest numbers**: same pure fns as the resolve roll; display caps at 99% (sure-shots
  show `99%`, never a lying `100%`); deterministic gates show `✓`/blocker, not fake odds.
- **Colorblind-safe**: color always paired with a symbol or word (↑↓, ▶, blocker text).
- **Context states** — one widget, four modes (same screen real estate):
  - `AIM` (SK pre-fire): odds strip above.
  - `IN FLIGHT`: strip dims to labels only; line: `NET AWAY — 34m`.
  - `REELING` (Phase 3a): strip swaps to the TENSION bar — gradient with RIP and SNAP
    tick marks, payload kg, `hold [⇧] fast reel`; pulses red near snap.
  - `RESULT`: existing full-screen flashes (NET FAILED / TETHER SNAP) unchanged.
- Phase 2 adds an aspect chip by the NET column (`BROADSIDE` ↔ `END-ON ✓`) — the NET %
  already encodes it (0% → 96%); the chip explains *why* and what to do.

Plumbing: `arm._toolScores`/`_toolHints` (refreshed only on target change today) become
`arm._toolOdds` refreshed on a 10 Hz timer during STATION_KEEP; DockingReticle owns the
display easing. P-CLING readout (`_drawNetPreFireReadout`) folds into the NET column +
advisory line — one source, no duplicate %.

**1c. TargetPanel** — replace the single fit badge with best-tool + odds for the
relevant arm (e.g., `NET 92%` / `GRIP ▶ 95%` / `TOO WIDE`), via the same ToolOdds call.

**1d. Mother lasso/net odds** — show the same % readout when aiming the mother tools
(lasso already has range gating; net odds via ToolOdds with `CN.LARGE`).

**Tests**: new `js/test/test-ToolOdds.js` — monotonicity (odds rise as tumble falls,
as range closes, as vRel→optimal), width gate, strain band, magnet ferrous forks.

## Phase 1.5 — Debris Dossier: declutter + progressive reveal ("treasure chest" data)

**Principle: the reticle is for *acting*, the dossier pane is for *knowing*.**
The odds strip carries only action data (odds, blocker, advisory, live tumble/range
while they're being changed). All debris *facts* live in one home: the existing
right-column DebrisWireframe panel, upgraded into a **Dossier** with staged reveal.
Remove duplicated static specs from reticle/TargetReticle labels (keep TargetReticle's
threat color + live °/s while lasing — that's action data; TargetReticle.js:924-930).

**Reveal tiers** (reuse `DATA_LEVELS`, SensorSystem.js:51-56 — make them *felt*):

1. **Unscanned** — radar blip only. Dossier: static noise + `UNRESOLVED — scan [S]`.
2. **Scanned (S)** — wireframe silhouette materializes in the pane (draw-on animation:
   edges trace in over ~1 s) + type/size/est-mass. Salvage manifest shows **redacted
   rows**: `▓▓▓▓▓ ▓▓ kg` — visible *that* there's treasure, not *what*.
3. **Proximity scan (the chest opens)** — when a daughter (or the mother) holds within
   `DETAIL_SCAN_RANGE` (~50 m) for ~3 s, an automatic close-range survey runs: progress
   ring on the dossier, then **Full Profile** unlocks line-by-line (typewriter + soft
   chime per row): exact mass, material, tumble axis, **brittleness** (drives the FRAG
   chip), orbit, and the decrypted **salvage manifest with credit values** — `Xenon 2.1kg
   ·₹840`, `GaAs panel ·₹1,200`… ending with `EST. VALUE ₹4,300`. Emit new
   `DEBRIS_PROFILED` event.
4. **Data bounty** — first full profile of each debris pays a small survey credit
   (reuse the once-per-field payout pattern, SensorSystem.js:97-109, per-debris set).
   Getting data *is* income; capturing the now-appraised debris is the jackpot.

**Knowledge gates the odds strip (incentive loop)** — unknown fields degrade the
readout honestly: before Full Profile, FRAG chip shows `FRAG ?` (brittleness unknown)
and NET % renders with a `~` (est-mass strain band uncertain). Advisory offers the fix:
`close to 50m to survey`. Survey first = informed shot; shoot blind = gamble. Both valid,
both legible — same risk/reward grammar as Phase 3.

**Declutter sweep** — with the dossier as SSOT: reticle SK readout keeps θ/φ/R only;
mass/size/material text leaves the reticle and TargetPanel rows slim down to
`name · best-tool odds · value-if-profiled`. HUD right column already coordinates
wireframe expansion (HUD.js:822-829) — no new panes, no new screen real estate.

**Teaching** — `first_detail_scan` moment on first `DEBRIS_PROFILED`: *"Close-range
survey complete — full structural profile and salvage appraisal. Survey before you
commit: brittleness drives fragmentation risk, and appraisal tells you what it's worth."*
Onboarding `inspect`/`scan` beats gain one line pointing at the redacted manifest
("get closer to decrypt").

**Tests**: tier transitions by distance/scan state, per-debris bounty paid once,
odds-strip uncertainty markers clear on `DEBRIS_PROFILED`.

## Phase 2 — Orientation-based capture (wide debris: 0% broadside → ~100% end-on)

**2a. Aspect data** — extend `DEBRIS_TYPES` (DebrisField.js:41-46) with `aspect`
(length:width): rocketBody 3.5, defunctSat 1.6, fragment/missionDebris 1.0. Derive and
store on each debris: `lengthM = sizeMeter`, `widthM = sizeMeter / aspect`. Real-catalog
path (CatalogConverter.js) gets the same derivation by `catalogType`.

**2b. Pure geometry fn in CaptureNet.js**:

```
presentedWidth(lengthM, widthM, cosTheta)  // θ = angle(longAxis, approachDir)
  = max(widthM, lengthM·sinθ)              // end-on → widthM, broadside → lengthM
worldLongAxis(debris) = quat(tumbleAxis, tumbleAngle) applied to the mesh's local
  long axis (cylinder = local Y; verify per-type geometry at DebrisField.js:~884)
```

**2c. Replace scalar width checks with presented width**:
- `assessNetFit` (CaptureNet.js:195-208) gains optional `approachDir` → new fits:
  `TOO_WIDE` (even end-on: `widthM > dia`) vs `ASPECT` (`fits end-on only`).
- `_checkNetIntegrityOnReel` oversize check (ArmUnit.js:4217) uses presented width **at
  catch time** (captured when the net contacts, not at reel).
- `NetProjectile._resolveCatch` (CaptureNet.js:732): compute presented width at contact;
  oversize ⇒ deterministic `_miss('oversize_aspect')`; add that reason to
  `missReasonToText` (CaptureNet.js:246-256): *"Net bounced off broadside — too wide this
  way. De-spin, then come around end-on so the net swallows it lengthwise."* Also add a
  generic default line instead of silent null (keep `'forced'` silent).
- ToolRecommender/ToolOdds width fork uses presented width.

**2d. HUD aspect guidance** — reticle line under P-CLING when the target is elongated and
mouth ∈ (widthM, lengthM): live `ASPECT: BROADSIDE — orbit to end-on` ↔ `END-ON ✓`
driven by current θ; while still tumbling fast show `de-spin to freeze aspect [U]`
(tumble makes θ sweep; de-spin freezes `tumbleAngle`, making lineup possible — this is
the laser↔aspect synergy). Risky option preserved: a timed shot through the swinging
end-on window is legal — odds readout dips/rises as θ sweeps.

**2e. Teaching** — `first_aspect_target` moment when targeting elongated debris wider
than the current net: *"Too wide broadside — but the net can swallow it lengthwise.
De-spin it, then orbit around until the readout says END-ON."*

**Tests**: presentedWidth math, end-on vs broadside fit verdicts, tumbling θ-sweep odds
oscillation, despun freeze.

## Phase 3 — Risk/reward: tension control, fragmentation severity, eddy-current detumble

**3a. Player reel-speed control** — in `_updateGrappled` reel (ArmUnit.js:~4100): hold a
key (default **Shift**, via InputManager binding) for BOOST reel ×2. Tension model:
`tension ∝ reelSpeed² × payloadMass` (extend `REEL_TENSION_COEFF`, Constants.js:793).
The odds-strip widget's `REELING` state (Phase 1b) shows the live **TENSION bar** with
marked NET-RIP and TETHER-SNAP thresholds; boost reel raises both: net rip probability
(reuses strain-slip path → recoverable) and
tether snap (reuses `_snapTether` → catastrophic, already fully messaged). Nominal reel
stays risk-free for in-spec catches, so cautious play is never punished.

**3b. Wire fragmentation (it's 90% built)** — at `_resolveCatch` (CaptureNet.js:753-768),
roll `this._fragRisk` (currently computed and ignored):
- On frag: `captureNetSystem.handleFragmentation(id, count)` (mercy rule intact) → emit
  `INTERACTION_FRAGMENTATION` (Kessler listens) → `DebrisField.createFragments(pos, mass, n)`
  → destroy/replace original per severity.
- **Severity tiers** (scaled by `vRel` excess × `brittleness` × material — brittleness
  already generated per-debris (DebrisField.js:659) and surfaced by sensors):
  - *Crack* (low): debris survives, 1-2 frags shed, capture continues, small score ding.
  - *Breakup* (mid): target destroyed → 3-6 fragments replace it, capture fails.
  - *Shatter* (high, brittle + hot approach): 8-12 fragments + Kessler contribution + comms alert.
- **Pre-fire FRAG % readout** in the tool strip for brittle/fragile targets (uses the
  same `computeFragRisk`) — fast approach visibly raises FRAG % alongside the cling
  penalty, making "go fast" a legible gamble.
- HUD flash + `first_fragmentation` teaching moment explaining mercy + how to avoid
  (slow approach, CINCH mode, pad for fragile bits).
- Existing test scaffold: test-CaptureNet.js:1378 already covers the mercy event.

**3c. Eddy-current detumble (new MAGNET secondary)** — while station-keeping with
**MAGNET selected** near a *conductive* target (aluminum/steel/titanium profiles — use
`DEBRIS_METAL_PROFILES`), bleed `tumbleRate` at a slow range-dependent rate (~⅓ of the
laser, ≤30 m). Gives daughters a local detumble option independent of the mother's laser;
the tool strip shows `MAGNET: eddy-damping N°/s↓` and NET % climbing in real time. New
constants block `EDDY_DAMP`; comms on engage; counts toward `DESPIN_IN_SPEC`.

**Tests**: tension/boost snap-probability math, severity tier selection, eddy damp rate
by material/range, frag-roll mercy path.

## Phase 4 — Tuning & teaching integration pass

- Balance pass on all new constants (single `Constants.js` blocks: `TOOL_ODDS`,
  `ASPECT_CAPTURE`, `REEL_BOOST`, `FRAG_SEVERITY`, `EDDY_DAMP`) so everything is tunable.
- MissionCoach: mention odds strip in Ch1-2 beat text; OnboardingDirector `decision` beat
  gains one line pointing at the live odds.
- Verify guidance arbitration (GUIDANCE_ARBITER_SPEC.md) — new teaching moments enter the
  existing queue (TeachingSystem.js:434-515), no overlay collisions.
- Full test run + manual playtest checklist: tumbling rocket body end-to-end (de-spin →
  watch NET % climb → reposition end-on → boost reel → near-snap), brittle solar panel
  shatter, mercy rule, Spinner-vs-oversize advice.

## Sequencing & risk

- Phases are independently shippable in order 0 → 1 → 1.5 → 2 → 3 → 4; each leaves the game playable.
- Phase 2 is the only one touching capture *resolution* semantics (width check timing
  moves from reel-start to contact) — guarded by a feature flag `ASPECT_CAPTURE` like the
  existing `CAPTURE_NET`/`LASER_DESPIN` flags so it can be toggled during tuning.
- Phase 3a input binding (Shift) must be checked against existing InputManager bindings
  for conflicts before wiring.

## Decisions assumed (flag if you disagree)

1. End-on capture of oversize debris is **near-100% but not free**: still multiplied by
   the normal cling factors (range/vRel/tumble) — "100%" only as a sure-shot at close
   range on a despun target, consistent with the existing SURE_SHOT floor.
2. Eddy-current detumble is a MAGNET-tool secondary (no new key), slower than the laser —
   it's the daughter-local fallback, not a laser replacement.
3. Fragmentation applies to net contact first; lasso/gripper/pad frag risk deferred.
4. Reel boost on **Shift** (hold), no toggle.
