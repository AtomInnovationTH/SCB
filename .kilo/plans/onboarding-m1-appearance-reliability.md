# Plan: M1 onboarding — make the cluster reliably look right (appearance + cubesat shape)

Follow-up to `.kilo/plans/onboarding-tease-2-lateral-tune.md` (Phases 1–3 are
implemented + tests green). This closes the gap between "tests pass" and
"actually looks like the plan intended" for the first-mission welcome cluster.

## Problem (verified in code)

The welcome spawn reuses an existing debris' instanced-mesh slot, so the rendered
**shape + material/colour** come from *which candidate is selected*, not from the
spec. Two selection defects defeat the intended look:

1. **Appearance starvation (the real bug).** `_spawnWelcomeField` collects
   candidates with an early-break at `farFragments.length >= 7`
   (`js/entities/DebrisField.js:2086`). It grabs the first 7 far fragments in
   `debrisList` order, *before* looking at material/variant, then the matcher
   chooses among only those 7. Gold MLI / blue solar-cell fragments are ~6% each,
   so the odds those 7 contain a gold-foil plate are ~12%. Result: #2 (gold
   foil), #3/#5 (blue panel) **usually fall back to generic grey chunks** — the
   "panels/foil/cells, not rocky blobs" goal (playtest #4) rarely shows. Current
   Phase-2 tests pass only because the mock seeds a candidate pool already rich in
   those materials; they don't exercise the starvation.

2. **Cubesat #7 renders as a fragment.** #7's candidate is a reused *fragment*
   (it's in a `fragment:…` mesh slot), so the "small whole satellite graduation
   catch" looks like a junk chunk. The `cubesat` geometry exists but is never
   selected for #7.

## Approach — fix both via candidate selection (no mesh-slot surgery)

The whole as-built model is "select the candidate that already renders the way you
want." Both fixes are the same mechanism extended:

- **Remove the early-break; collect a real pool.** Scan all alive non-welcome
  debris once (≤800, one-time at spawn — negligible) and bucket far candidates by
  type. Keep `farOther` / `fallbackCandidates` for graceful fallback so spawn
  never under-fills.
- **Type-aware scoring in the matcher.** Score each candidate per spec:
  - `+4` if `debris.type` matches the spec's desired type (fragment rows want
    `fragment`; #7 wants `cubesat`) — shape is the dominant visual, so it
    outranks material.
  - `+2` if `debris.material === spec.appearMaterial`.
  - `+1` if `DebrisWireframe.isPlateVariant(id % N) === spec.appearPlate`.
  Best score wins; ties keep placed-order (stable). Fallback chain unchanged
  (any far candidate → far other → near) so a missing bucket never blocks spawn.
- **#7 becomes a real cubesat by selecting an existing cubesat candidate.**
  `cubesat` has `weight: 0.02` ⇒ ~16 spawn into the 800-piece field at boot, each
  in a `cubesat:<material>` mesh slot. Row #7 (`types:['cubesat']`) will score
  those candidates highest and reuse one — so it renders as the cubesat geometry,
  shape and all. If (astronomically unlikely) no far cubesat exists, it falls back
  to a fragment exactly as today.

### Why not a literal per-welcome mesh rebind
InstancedMeshes are one-per-`(type,material[,variant])` key and fixed-count at
boot, so a true rebind means reserving spare cubesat slots and hand-managing
`_meshKey`/`_instanceLookup`/old-slot zeroing — real risk for no extra benefit.
Selecting an existing cubesat candidate achieves the identical on-screen result,
stays consistent with the as-built architecture, and is far lower risk. (If the
"~16 cubesats" assumption ever proves shaky in playtest, the cheap lever is to
nudge `cubesat.weight` up slightly — not to add rebind machinery.)

## Concrete changes — `js/entities/DebrisField.js`, `_spawnWelcomeField`

Candidate-collection + matcher block (currently `:2070`–`:2121`):

1. **Drop the `farFragments.length >= 7` break** at `:2086`; iterate the full
   list. Add a `farCubesats` bucket (or a single `farPool` with type retained on
   each debris) so cubesat candidates are reachable. `fragment` still buckets to a
   junk-look pool; `defunctSat`/`rocketBody` stay lowest-priority fallback.
2. **Add a per-spec "desired type"** — for the current rows that's the first entry
   of `spec.types` (fragment for #1–#6, cubesat for #7). Use it in scoring.
3. **Generalise `pickFar`** to scan the combined far pool with the `+4/+2/+1`
   scoring above (was fragment-only, `+2/+1`). Preserve `usedIds` dedupe and the
   `pickAny(...)` fallback order.
4. Leave the downstream loop (mass/size/material/lowValue/pin/flag-strip/
   `_welcomeSpecIndex`) unchanged — #7 keeps `type==='cubesat'` (its
   `spec.types.includes(debris.type)` is already true, so no retype), `sizeM 0.30`
   and mass 10 still apply.

No other files change. (Cubesat geometry, labels, maps, and the mass cap fix are
already in place from the prior plan.)

## Tests — `js/test/test-WelcomeField.js`

- **Starvation regression:** build a mock whose *first* 7 far fragments are all
  `aluminum` non-plate, with gold/blue plate fragments only *later* in the list.
  Assert #2 still resolves to `mli_mylar` and #3/#5 to `solar_cell` (this fails
  today with the early-break, passes after the fix). Use `_welcomeSpecIndex` +
  `captureOriginal` (the original material of the selected slot) as already done.
- **Cubesat selection:** seed the mock with a few far `type:'cubesat'` candidates
  among fragments; assert the piece realising spec #7 (`_welcomeSpecIndex===6`)
  has `type==='cubesat'` (i.e. a cubesat slot was selected, so it renders as one).
- **Graceful fallback unchanged:** all-fragment / no-cubesat mock still fills 7.
- Existing Phase-1/2/3 + cubesat tests must stay green; `node js/test/run-tests.js`
  green (currently 3206).

## Playtest gate (only the user can run; browser)
Clear `localStorage['spacecowboy_onboarding_v1']`, start M1, confirm:
1. Cluster reads as spacecraft debris — #2 looks like **gold foil**, #3/#5 like
   **blue solar panels**, others as metal/composite chunks (not grey blobs).
2. #7 reads as a **small satellite** (cubesat body), distinct from the chunks.
3. #1 dead-centre daughter-sized; #2 right-but-on-screen, in range; reward climbs.
4. #3 out-of-range teaches **A**; net fires toward target; OUT OF RANGE flashes
   only on the in→out crossing; catching #1 doesn't unpin #2; no flag on any piece.

## Invariants / out of scope
- Spawn must never under-fill (graceful fallback preserved).
- `_scenePosition` stays the single source of truth for pinned positions; pin
  lifecycle, CA exemption, reticle flash logic unchanged.
- No mesh-slot rebind; no change to `isFlagEligible`; no change to the public
  `spawnWelcomeField` planner.
- One-time O(debris) scan at spawn only — no new per-frame cost.

## Commit
After tests + the M1 playtest pass.
