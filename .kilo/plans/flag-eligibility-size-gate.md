# Flag eligibility — size-driven gate so large derelict sats get flags

## Goal

Honor the rule: **most satellites and rockets carry a national flag decal on the
surface; smaller debris/fragments do not.** Fix the bug where large, named whole
satellites are silently denied a flag because the catalog labels them `"debris"`.

## Problem

Flag eligibility lives in `isFlagEligible()` — `js/ui/FlagDecalSystem.js:88`:

```js
const t = debris.type;
if (t !== 'rocketBody' && t !== 'defunctSat') return false;   // hard TYPE gate
const minM = C.FLAG_MIN_SIZE_M ?? 2;
return (debris.sizeMeter || 0) >= minM;
```

The gate keys off the **internal** debris type and excludes `fragment` and
`missionDebris` outright. But `CatalogConverter.TYPE_MAP` (`js/entities/CatalogConverter.js:26`)
maps every catalog `"type": "debris"` row to internal `fragment`, and several of
those rows are actually whole large derelict satellites:

| Object | catalog type | internal type | size_m | mass_kg | flag today |
|---|---|---|---|---|---|
| COSMOS 1408 | debris | fragment | 6.0 | 2200 | none |
| COSMOS 2251 | debris | fragment | 4.6 | 950 | none |
| IRIDIUM 33 | debris | fragment | 3.1 | 556 | none |
| FENGYUN-1C | debris | fragment | 2.8 | 750 | none |
| COSMOS 1275 | debris | fragment | 3.0 | 825 | none |
| ENVISAT | inactive | defunctSat | 26.0 | 8211 | **flag** |

Result: ENVISAT (derelict sat) wears a flag, but COSMOS 1408 (an equally large
derelict sat, just tagged "debris") does not — purely due to the type string.

Why a pure size gate is safe:
- Procedural `fragment` sizeMeter is clamped to `sizeMax * 1.15 = 1.15 m`
  (`DebrisField.js:46,651`) — never reaches the 2 m threshold.
- Procedural `missionDebris` clamps to `0.575 m`.
- So the only ≥2 m "fragments" in the game are these mislabeled catalog
  satellites. Size alone perfectly separates "whole object" from "real junk".
- Country codes on these rows (CIS/USA/PRC) already match the flag atlas
  (`COUNTRY_ORDER`), so they render correctly once eligible.
- `DebrisWireframe.getSurfaceDistance()` already supports the `fragment` shape
  (`js/ui/DebrisWireframe.js:1045`), so flag mounting works.

## Approach — size-driven eligibility (chosen)

Rewrite `isFlagEligible()` to gate on **size**, excluding only small operational
debris by type. rocketBody/defunctSat behavior is unchanged; large catalog
satellites become eligible; all sub-threshold fragments stay excluded.

### Change 1 — `js/ui/FlagDecalSystem.js` (`isFlagEligible`, ~line 79–95)

Replace the type allow-list with a size gate plus a `missionDebris` exclusion:

```js
/**
 * Flag eligibility by SIZE, not by catalog label. Any object at least
 * FLAG_MIN_SIZE_M wide carries a national marking — this covers rocket bodies,
 * defunct sats, AND large derelict satellites the catalog happens to tag
 * "debris" (→ internal `fragment`), e.g. COSMOS 1408 / IRIDIUM 33. Small
 * operational debris (lens caps, clamps) never qualifies; genuine fragments are
 * always sub-threshold so they are excluded by size automatically.
 */
export function isFlagEligible(debris) {
  if (!debris) return false;
  if (debris.type === 'missionDebris') return false; // small operational junk
  const C = (typeof Constants !== 'undefined' && Constants.DEBRIS_VISUAL) || {};
  const minM = C.FLAG_MIN_SIZE_M ?? 2;
  return (debris.sizeMeter || 0) >= minM;
}
```

Notes:
- Keep the `Constants` lookup pattern (Node-safe, already used).
- `missionDebris` stays explicitly excluded so a hypothetical large operational
  item never gets a flag.

### Change 2 — keep procedural country assignment intact

`DebrisField._buildFlagOverlays()` (`js/entities/DebrisField.js:1036`) only
assigns a country to `!d.isReal` eligible debris. The newly-eligible objects are
all `isReal` catalog rows that already carry `country`, so no change needed — the
existing grouping/skip logic (`!d.country || d.country === '---'`) handles them.
No procedural fragment becomes eligible (size), so no extra flag instances spawn
beyond the ~5 catalog satellites. Verify visually that flag InstancedMesh counts
grow only by those entries.

### Change 3 — update the unit test

`js/test/test-DebrisTextureAtlas.js:353-386` currently asserts the old behavior.
Update the two cases that encode the type-only gate:

- Line 364-366 `'fragments are NEVER eligible, regardless of size'`:
  change to assert that a **large** fragment-typed object (a mislabeled whole
  satellite) IS eligible, e.g.
  `isFlagEligible({ type: 'fragment', sizeMeter: 6 })` === `true`, and that a
  **small** fragment is NOT, e.g.
  `isFlagEligible({ type: 'fragment', sizeMeter: 1 })` === `false`.
- Line 368-370 `'mission debris is not eligible'`: keep — `missionDebris` stays
  excluded even at 10 m. Good as-is.
- Lines 372-379 (threshold cases) and 381-385 (null/missing) remain valid.

Add a regression test asserting the named catalog sizes flag correctly, e.g.
`isFlagEligible({ type: 'fragment', sizeMeter: 2.8 })` === `true` (FENGYUN-1C).

### Change 4 — refresh the doc comment / Constants note

- The header comment on `FLAG_MIN_SIZE_M` (`js/core/Constants.js:2622-2623`) says
  "Flags only on rocket bodies / defunct sats at least this wide". Update to
  reflect size-driven gating ("any object ≥ this; small operational debris &
  sub-threshold fragments excluded").
- `HANDOFF.md:26` describes Item 12's old rule — update the one-liner so the
  handoff history matches the new behavior.

## Out of scope (noted opportunities, not in this plan)

- These large derelicts still render as `fragment` icosahedron shards (shape from
  `SHAPE_MAP`), not satellite boxes. A separate fidelity fix would re-type or
  re-shape them; deliberately not changed here to avoid touching salvage/economy.
- Real catalog debris with `country === '---'` currently shows no flag (no `'???'`
  fallback). Could optionally fall back to the `'???'` atlas slot; left as-is.

## Verification

1. `npm test` (or the project's test runner) — run `test-DebrisTextureAtlas.js`;
   all eligibility cases pass with the updated assertions.
2. Manual/visual: load a field containing the named catalog objects and confirm
   COSMOS 1408 / 2251 / IRIDIUM 33 / FENGYUN-1C / COSMOS 1275 now wear their
   correct national flags, and that ordinary small fragments still wear none.
3. Confirm no regression for rocket bodies / defunct sats (still flagged) and no
   new flags on procedural fragments / missionDebris.

## Files touched

- `js/ui/FlagDecalSystem.js` — `isFlagEligible()` logic + doc comment.
- `js/test/test-DebrisTextureAtlas.js` — eligibility assertions + regression case.
- `js/core/Constants.js` — `FLAG_MIN_SIZE_M` comment.
- `HANDOFF.md` — Item 12 one-liner.
