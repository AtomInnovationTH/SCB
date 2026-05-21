# NavSphere Redesign — I-War Inspired Tactical Sphere

## 1. Executive Summary

The NavSphere is the player's primary situational-awareness instrument — a 260px-diameter 2D canvas sphere positioned top-right that projects all contacts onto a pseudo-3D radar display. Currently it projects **direction only**; two objects at 1 km and 40 km along the same bearing appear at the **identical** screen position. At the game's 50 km sensor range, the critical 0–2 km tether-capture zone occupies **< 5 px** from center, making the sphere useless for close-range tactical play.

This document proposes a **hybrid logarithmic + dual-zone distance encoding** (Options A + B combined), together with a suite of I-War-inspired visual enhancements that exploit the rich but currently unused data already flowing through [`DebrisField.js`](js/entities/DebrisField.js), [`SensorSystem.js`](js/systems/SensorSystem.js), and [`Constants.js`](js/core/Constants.js).

**Goal**: Transform the NavSphere from a direction compass into a true spatial tactical map that makes the 0–10 km engagement zone the visual center of attention while still showing the broader 50 km detection envelope.

---

## 2. Core Problem

### 2.1 Direction-Only Projection

In [`NavSphere._drawDebrisDot()`](js/ui/NavSphere.js:384), every contact direction is normalized before projection:

```js
this._tmpDir.normalize();                              // line 389
const { sx, sy, z } = this._toSphere(this._tmpDir, cx, cy, R);  // line 390
```

The `_tmpDir` vector's **magnitude is discarded**. Distance is only used for dot-size bucketing (`DOT_NEAR`/`DOT_MED`/`DOT_FAR` at lines 21–23) and zone coloring — not for radial placement.

### 2.2 Scale Mismatch

| Metric | Value | NavSphere Pixels (130 px radius) |
|---|---|---|
| Lasso range | 0.2 km | **0.52 px** |
| Spinner tether | 0.5 km | **1.30 px** |
| Weaver tether | 2.0 km | **5.20 px** |
| Close combat zone | 5 km | **13.0 px** |
| Half sensor range | 25 km | **65.0 px** |
| Full sensor range | 50 km | **130 px** (rim) |

The tether rings drawn in [`_drawTetherRings()`](js/ui/NavSphere.js:497) produce circles of ≤ 5 px — invisible at a glance and useless for gameplay decisions.

### 2.3 Rich Data Available but Unused

[`DebrisField.getDebrisNear()`](js/entities/DebrisField.js:843) returns objects containing:

| Field | Available | Currently Used in NavSphere |
|---|---|---|
| `type` | ✅ (fragment / rocketBody / defunctSat / missionDebris) | ❌ |
| `sizeMeter` | ✅ | ❌ |
| `mass` | ✅ | ❌ |
| `material` | ✅ | ❌ |
| `tumbleRate` | ✅ | ❌ |
| `hasSalvage` | ✅ | ❌ |
| `salvage` | ✅ (metals, xenon, indium…) | ❌ |
| `tracked` | ✅ | ✅ (filters untracked) |
| `distance` / `distanceKm` | ✅ | Partially (dot size only) |
| `_cartesian.velocity` | ✅ | ❌ |
| `metalMassKg` | ✅ | ❌ |
| `dragMultiplier` | ✅ (web-shot state) | ❌ |

[`SensorSystem`](js/systems/SensorSystem.js) provides `DATA_LEVELS` (CLOSE / NEAR / MEDIUM / FAR) that could progressively reveal information on the sphere itself.

---

## 3. Proposed Solutions — Evaluation & Recommendation

### 3.0 Options Considered

| Option | Summary | Pros | Cons |
|---|---|---|---|
| **A: Logarithmic Scaling** | `r = log(dist+1) / log(max+1) * R` | Smooth, single formula | Tether zone still small (~15 px for weaver) |
| **B: Dual-Zone** | Inner 0–5 km = 40% R, outer 5–50 km = 60% R | Tether zone prominent | Hard boundary, linear within zones |
| **C: Adaptive Zoom** | Default 10 km, expand to 50 km on demand | Always fills sphere | Player must manage zoom; far contacts hidden |
| **D: Multi-Ring Breakdown** | Rings at 1, 2, 5, 10, 25, 50 km with proportional spacing | Clear labeled distances | Linear spacing doesn't solve core compression; rings clutter |

**Decision**: Combine **Option A + B** — dual-zone split with logarithmic compression *within* each zone. This gives the tether zone ~40 px of space (from B) while keeping smooth radial transitions (from A). Option C is deferred as a P2 enhancement. Option D's labeled rings are incorporated as an overlay on the chosen approach.

### 3.1 Recommended Approach: Hybrid Log + Dual-Zone

The sphere is split into two conceptual zones with a **logarithmic warp** within each:

| Zone | Distance Range | NavSphere Region | Radius Allocation |
|---|---|---|---|
| **Inner (Tactical)** | 0–5 km | Center to 50% R | 65 px |
| **Outer (Awareness)** | 5–50 km | 50% R to rim | 65 px |

Within each zone, radial position uses logarithmic mapping:

```
innerR = log(1 + distKm)      / log(1 + 5)    * 0.50 * R   // 0–5 km → 0–65 px
outerR = log(1 + distKm - 5)  / log(1 + 45)   * 0.50 * R + 0.50 * R   // 5–50 km → 65–130 px
```

### 3.2 Result After Remapping

| Metric | Old px from center | **New px from center** | Calculation |
|---|---|---|---|
| Lasso range (0.2 km) | 0.52 | **6.6** — clearly visible | `ln(1.2)/ln(6) × 65` |
| Spinner tether (0.5 km) | 1.30 | **14.7** — prominent ring | `ln(1.5)/ln(6) × 65` |
| Weaver tether (2.0 km) | 5.20 | **39.9** — large, clear zone | `ln(3)/ln(6) × 65` |
| 5 km boundary | 13.0 | **65.0** — half-sphere boundary | `ln(6)/ln(6) × 65` |
| 10 km | 26.0 | **95.4** | `65 + ln(6)/ln(46) × 65` |
| 25 km | 65.0 | **116.7** | `65 + ln(21)/ln(46) × 65` |
| 50 km | 130 | **130** — rim (unchanged) | `65 + ln(46)/ln(46) × 65` |

The tether rings go from sub-pixel to **15–40 px** — large enough to fill with translucent color and label.

### 3.3 Zone Boundary Visualization

A subtle dashed ellipse at 50% R marks the 5 km tactical/awareness boundary. Label: `5km`. This echoes I-War's weapon-range rings. The boundary should use a distinct color (dim amber) so it doesn't compete with the existing FOV ring at 70% R.

### 3.4 Alternative: Adaptive Zoom (Option C) as Future Enhancement

Mousewheel zoom (or `Z` key toggle) cycling through 3 scales (2 km / 10 km / 50 km) could layer on top of the dual-zone approach for advanced players. This is **P2** — not required for the initial redesign but the architecture should support a `_sphereScale` property.

### 3.5 Radial Mapping Function — Pseudocode

```js
/**
 * Map a distance in km to a NavSphere pixel radius.
 * Uses dual-zone logarithmic compression.
 * @param {number} distKm — distance from mothership in km
 * @param {number} R — sphere pixel radius (130)
 * @param {number} outerKm — sensor range in km (dynamic, from SensorSystem)
 * @returns {number} pixel radius from sphere center
 */
_distToRadius(distKm, R, outerKm) {
  const INNER_KM = this._innerZoneKm;   // from Constants.NAVSPHERE.INNER_ZONE_KM (5)
  const SPLIT = this._zoneSplit;         // from Constants.NAVSPHERE.ZONE_SPLIT (0.50)

  if (distKm <= 0) return 0;

  if (distKm <= INNER_KM) {
    // Inner zone: 0–INNER_KM → 0–SPLIT*R, logarithmic
    return Math.log(1 + distKm) / Math.log(1 + INNER_KM) * SPLIT * R;
  }

  if (distKm <= outerKm) {
    // Outer zone: INNER_KM–outerKm → SPLIT*R–R, logarithmic
    const excess = distKm - INNER_KM;
    const maxExcess = outerKm - INNER_KM;
    return SPLIT * R + Math.log(1 + excess) / Math.log(1 + maxExcess) * (1 - SPLIT) * R;
  }

  // Beyond sensor range: clamp to rim
  return R;
}
```

> **Note**: `outerKm` is derived per-frame from `sensorSystem.range / Constants.SCENE_SCALE`. When `outerKm ≤ INNER_KM` (basic sensor at 10 km), set `INNER_KM` to `outerKm * 0.5` so the dual-zone split still applies within the reduced range.

### 3.6 Impact on `_toSphere()`

The current [`_toSphere()`](js/ui/NavSphere.js:358) method takes a **normalized** direction and scales it to `R * 0.85`. The redesign changes this:

1. Caller passes the **unnormalized** relative vector (player → target).
2. Extract direction: `dir.clone().normalize()`.
3. Extract distance: `dir.length()` → convert to km via `/ Constants.SCENE_SCALE`.
4. Compute camera-space components: `x = dot(dir, right)`, `y = dot(dir, up)`, `z = dot(dir, forward)`.
5. Compute `r_max = _distToRadius(distKm, R)` — the maximum possible screen radius for this distance.
6. Project: `sx = cx + x * r_max`, `sy = cy - y * r_max`.

A new method `_toSphereWithDistance(relVec, cx, cy, R)` replaces the current `_toSphere` for contact rendering.

### 3.7 Projection Model: Angular × Distance Encoding

**Important constraint**: The hemisphere projection inherently couples direction and radial position. For a normalized direction `(x, y, z)`, the screen radius is `sqrt(x² + y²) * r_max`. This means:

- Object **directly ahead** (x≈0, y≈0, z≈1): screen radius ≈ 0 regardless of distance — **by design**, it's where you're looking.
- Object **perpendicular** to view (large x or y): screen radius ≈ `_distToRadius(distKm, R)` — full distance encoding.
- Object **behind** (z < 0): appears at `sqrt(x² + y²) * r_max` with dimmed alpha — distance clearly encoded.

This is the same trade-off as a real radar PPI mounted on a rotating antenna: contacts along the boresight compress. In practice this is **acceptable** because:

1. Objects directly ahead are already visible in the 3D viewport — the NavSphere adds most value for off-screen contacts.
2. The selected target's distance readout (E5) provides exact km for the forward target.
3. I-War's sphere had the same property — it was most useful for lateral and rear awareness.

**Alternative considered**: True plan-position display (contact position = direction on disc, distance = radius from center, no camera-space coupling). Rejected because this loses the front/back hemisphere distinction that the stalks and alpha dimming provide — a key I-War feature already implemented.

### 3.8 FOV Ring and Sensor Range Adaptation

**FOV ring**: The existing FOV boundary ring at 70% R ([`FOV_RING_RATIO`](js/ui/NavSphere.js:26)) was meaningful when radial position encoded viewing angle — contacts inside the ring were "in view." With distance encoding, radial position no longer corresponds to angular FOV, so **the FOV ring should be removed**. The dashed 5 km zone boundary replaces it as the primary visual landmark.

**Dynamic sensor range**: The NavSphere currently hardcodes [`SENSOR_RANGE = 0.5`](js/ui/NavSphere.js:19) (50 km) for the `getDebrisNear()` query. However, [`SensorSystem.range`](js/systems/SensorSystem.js:67) tracks the actual detection range (starts at 0.1 = 10 km for basic tier, scales to 0.5/1.0 with upgrades). The redesign must:

1. Pass `sensorSystem.range` as the query radius instead of the hardcoded constant.
2. Set `OUTER_ZONE_KM` dynamically: `sensorSystem.range / Constants.SCENE_SCALE` (e.g., 10 km → 50 km as upgrades progress).
3. When `OUTER_ZONE_KM` is only 10 km (basic tier), the entire sphere shows tactical range — ideal for early game.
4. As sensors upgrade, the outer zone expands and the 5 km boundary naturally appears.

This makes the NavSphere **responsive to progression** — a free gameplay feedback loop.

---

## 4. I-War-Inspired Visual Enhancements

#### Enhancement Matrix

| # | Enhancement | Data Source | Priority | Complexity | Notes |
|---|---|---|---|---|---|
| E1 | [Debris type shapes](#41-e1--debris-type-shapes) | `target.type` from [`DebrisField`](js/entities/DebrisField.js:26) | **P0** | Low | Different shapes per type |
| E2 | [Size scaling](#42-e2--size-scaling) | `target.sizeMeter` | **P0** | Low | Map size to dot radius |
| E3 | [Velocity vectors](#43-e3--velocity-vectors) | `target._cartesian.velocity` | **P1** | Med | Short tail lines |
| E4 | [Closure rate coloring](#44-e4--closure-rate-coloring) | velocity dot product with `playerVel` | **P0** | Med | Red/amber/green scheme |
| E5 | [Distance readout](#45-e5--selected-target-distance-readout) | `distanceKm` from `getDebrisNear()` | **P0** | Low | Text label near dot |
| E6 | [Tether zone fill](#46-e6--tether-zone-fill-shading) | [`Constants.LASSO_RANGE`](js/core/Constants.js:604), `SPINNER_TETHER_LENGTH`, `WEAVER_TETHER_LENGTH` | **P0** | Low | Translucent fill rings |
| E7 | [Salvage indicator](#47-e7--salvage-indicator) | `target.hasSalvage`, `target.salvage` | **P1** | Low | Small marker overlay |
| E8 | [Density heatmap](#48-e8--density-heatmap-overlay) | Spatial density from `getDebrisNear()` result count | **P2** | High | Grid-cell heat coloring |
| E9 | [Sensor tier viz](#49-e9--sensor-tier-data-gating) | [`SensorSystem._getDataLevel()`](js/systems/SensorSystem.js:244) `DATA_LEVELS` | **P1** | Med | Progressive detail |
| E10 | [Range rings](#410-e10--labeled-range-rings) | Computed from `_distToRadius()` | **P0** | Low | 1km, 2km, 5km labels |

---

### 4.1 E1 — Debris Type Shapes

**What**: Replace uniform circles with distinct shapes per debris type.

| Type | Shape | Canvas Drawing | Reference |
|---|---|---|---|
| `fragment` | Small circle (dot) | `ctx.arc()` | [`DEBRIS_TYPES.fragment`](js/entities/DebrisField.js:27) |
| `rocketBody` | Rectangle (tall) | `ctx.fillRect()` | [`DEBRIS_TYPES.rocketBody`](js/entities/DebrisField.js:28) |
| `defunctSat` | Diamond (rotated square) | 4-point path | [`DEBRIS_TYPES.defunctSat`](js/entities/DebrisField.js:29) |
| `missionDebris` | Triangle (small) | 3-point path | [`DEBRIS_TYPES.missionDebris`](js/entities/DebrisField.js:30) |

**Data source**: `target.type` — always available on every debris object returned by [`getDebrisNear()`](js/entities/DebrisField.js:843).

**Priority**: **P0** — Highest impact per line of code. Shape differentiation is the single most impactful I-War pattern.

**Complexity**: **Low** — Replace the single `ctx.arc()` call in [`_drawDebrisDot()`](js/ui/NavSphere.js:384) with a shape switch.

---

### 4.2 E2 — Size Scaling

**What**: Map `sizeMeter` to dot/shape pixel radius.

```js
// Clamp sizeMeter to [0.05, 11] range (from DEBRIS_TYPES definitions)
const baseSize = 2 + Math.log10(Math.max(sizeMeter, 0.05) + 1) * 4;
// result: fragment (0.1m) → ~2.2 px, rocketBody (11m) → ~6.3 px
```

**Data source**: `target.sizeMeter` — generated at [`DebrisField._createDebrisData()`](js/entities/DebrisField.js:209).

**Priority**: **P0** — Instant visual mass/threat differentiation without reading text.

**Complexity**: **Low** — Single calculation replacing the fixed `DOT_NEAR`/`DOT_MED`/`DOT_FAR` constants at [lines 21–23](js/ui/NavSphere.js:21).

---

### 4.3 E3 — Velocity Vectors

**What**: Short tail line extending from each contact dot showing relative velocity direction (player-relative). Length proportional to closure speed. Mimics I-War's velocity vector display.

```
                  ·——→   (moving right, approaching slowly)
        ·————→          (moving right, approaching fast)
              ←——·       (moving left, receding)
```

**Data source**: `target._cartesian.velocity` returned by [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js) via [`getDebrisNear()`](js/entities/DebrisField.js:856). Player velocity available from `data.playerVel` passed to [`update()`](js/ui/NavSphere.js:149).

**Computation**:
```js
const relVel = new THREE.Vector3(
  target._cartesian.velocity.x - playerVel.x,
  target._cartesian.velocity.y - playerVel.y,
  target._cartesian.velocity.z - playerVel.z,
);
// Project relVel onto sphere surface as a short line from dot position
const velDir = relVel.clone().normalize();
const speed = relVel.length();
const tailLength = Math.min(15, speed * VELOCITY_SCALE_FACTOR);
```

**Priority**: **P1** — Extremely valuable for intercept planning but slightly complex.

**Complexity**: **Medium** — Requires projecting a second point per contact and drawing a line. Performance consideration: only draw for contacts within 10 km or the N nearest contacts.

---

### 4.4 E4 — Closure Rate Coloring

**What**: Color-code contacts by whether they're approaching, orbit-crossing, or receding. This replaces the current distance-only zone coloring for non-tether-zone contacts.

| Closure State | Color | Condition |
|---|---|---|
| **Approaching** (collision risk) | `#ff4444` (red) | `dot(relVel, relPos) < -threshold` |
| **Close approach** (orbit crossing) | `#ffaa00` (amber) | `|closureRate| < threshold` AND dist < 5 km |
| **Receding** | `#00ff88` (green) | `dot(relVel, relPos) > threshold` |
| **In tether zone** | Existing zone colors | `distKm < 2.0` (keep [`_getZoneColor()`](js/ui/NavSphere.js:561)) |
| **Selected** | `#00ccff` (cyan) | `target.id === selectedId` |

**Data source**: Relative velocity computed from `target._cartesian.velocity` and `data.playerVel`. Closure rate = `dot(relVel, relPos.normalize())`.

**Priority**: **P0** — This is the single most important tactical information for a space debris game. Red = danger/opportunity, green = leaving.

**Complexity**: **Medium** — Requires computing the dot product per contact. The velocity data is already available in the `_cartesian` field.

---

### 4.5 E5 — Selected Target Distance Readout

**What**: Display distance text (`2.3km`) near the selected target's dot on the sphere.

```
        ◆ 2.3km
        |   (stalk)
        ·   (equatorial foot)
```

**Data source**: `distanceKm` already computed in [`_drawDebrisDot()`](js/ui/NavSphere.js:394) as `distScene * 100`.

**Priority**: **P0** — Trivial to implement, huge situational awareness gain.

**Complexity**: **Low** — Add `ctx.fillText()` after the selected-target ring pulse at [line 416](js/ui/NavSphere.js:416).

---

### 4.6 E6 — Tether Zone Fill Shading

**What**: Instead of thin stroke-only rings, fill the tether zones with translucent color. This creates I-War-style range disc visualization.

| Zone | Fill Color | Condition |
|---|---|---|
| Lasso (0–0.2 km) | `rgba(255, 255, 255, 0.06)` | Always shown |
| Spinner (0.2–0.5 km) | `rgba(0, 255, 136, 0.04)` | Brighter when spinner deployed |
| Weaver (0.5–2.0 km) | `rgba(0, 204, 255, 0.03)` | Brighter when weaver deployed |

After the dual-zone mapping, these zones will be **prominent** (7–38 px radius), making the fill visible and useful.

**Data source**: Tether lengths from [`Constants.LASSO_RANGE`](js/core/Constants.js:604) (200m), [`Constants.SPINNER_TETHER_LENGTH`](js/core/Constants.js:133) (500m), [`Constants.WEAVER_TETHER_LENGTH`](js/core/Constants.js:114) (2000m). Arm deployment state from `armManager.arms[].state`.

**Priority**: **P0** — Small code change, large visual improvement. Currently the rings are invisible at ≤5 px.

**Complexity**: **Low** — Add `ctx.fill()` calls with translucent colors in [`_drawTetherRings()`](js/ui/NavSphere.js:497). Use `_distToRadius()` for ring radii instead of the linear calculation.

---

### 4.7 E7 — Salvage Indicator

**What**: High-value salvage targets get a small `$` marker or a colored inner dot:
- Gold inner dot: `hasSalvage === true && metalMassKg > 50`
- Dim gold ring: `hasSalvage === true`

**Data source**: `target.hasSalvage` and `target.metalMassKg` from [`DebrisField._createDebrisData()`](js/entities/DebrisField.js:252). Available on all debris objects. Also `target.salvage.metals[]` for detailed value.

**Priority**: **P1** — Helps players prioritize which targets to pursue. Gated by `sensorSystem.canScanSalvage` upgrade from [`SensorSystem.applyUpgrade()`](js/systems/SensorSystem.js:146).

**Complexity**: **Low** — Conditional extra draw call per salvage contact.

---

### 4.8 E8 — Density Heatmap Overlay

**What**: Divide the sphere into an 8×8 angular grid. For each cell, count the number of contacts and render a translucent color (cool → hot) behind the dots. This shows cluster density at a glance when 800 contacts are on screen.

**Data source**: Aggregate of all contacts returned by [`getDebrisNear()`](js/entities/DebrisField.js:843). Group by angular bucket (azimuth × elevation in camera space).

**Priority**: **P2** — Nice-to-have. Most useful at full 50 km range where individual dots may overlap.

**Complexity**: **High** — Requires angular bucketing, grid rendering, and careful performance tuning to avoid O(N×cells) per frame. Should only render when contact count > 100.

---

### 4.9 E9 — Sensor Tier Data Gating

**What**: Contacts farther away show less detail, matching [`SensorSystem`](js/systems/SensorSystem.js)'s `DATA_LEVELS`:

| Data Level | Distance | NavSphere Display |
|---|---|---|
| `CLOSE` (≤ 500m) | Full profile | Type shape + size + velocity vector + salvage indicator |
| `NEAR` (≤ 2 km) | Analyzed | Type shape + size + velocity vector |
| `MEDIUM` (≤ half range) | Classified | Type shape + dot (no velocity) |
| `FAR` (> half range) | Unresolved | Generic dim dot only |

**Data source**: [`SensorSystem._getDataLevel(distance)`](js/systems/SensorSystem.js:244) — already distance-gated. The `sensorSystem` ref is already passed to [`NavSphere.update()`](js/ui/NavSphere.js:161).

**Priority**: **P1** — Reinforces the sensor upgrade loop and adds information hierarchy to the sphere.

**Complexity**: **Medium** — Need to query data level per contact and conditionally enable/disable drawing features.

---

### 4.10 E10 — Labeled Range Rings

**What**: Concentric range rings at meaningful distances, each labeled with distance in km. Replaces the current grid of latitude/longitude ellipses (which are cosmetic only).

| Ring | Distance | New Radius (px) | Label |
|---|---|---|---|
| Inner 1 | 0.5 km | 14.7 | `0.5` |
| Inner 2 | 2.0 km | 39.9 | `2` |
| Zone boundary | 5.0 km | 65.0 | `5km` |
| Outer 1 | 10 km | 95.4 | `10` |
| Outer 2 | 25 km | 116.7 | `25` |
| Rim | 50 km | 130.0 | `50km` |

**Data source**: Computed from `_distToRadius()`. Labels drawn with `ctx.fillText()`.

**Priority**: **P0** — Fundamental to making the distance encoding readable.

**Complexity**: **Low** — Loop over distance values, compute radius, draw arc + text.

---

## 5. Implementation Approach

### 5.1 Files to Modify

| File | Changes |
|---|---|
| [`NavSphere.js`](js/ui/NavSphere.js) | Major — new methods, modified rendering |
| [`Constants.js`](js/core/Constants.js) | Minor — new NavSphere constants block |
| [`SensorSystem.js`](js/systems/SensorSystem.js) | None initially (already provides needed API) |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js) | None (already passes `sensorSystem` and `armManager`) |

### 5.2 NavSphere.js — Methods to Modify

| Method | Action |
|---|---|
| [`_toSphere()`](js/ui/NavSphere.js:358) | **Replace** with `_toSphereWithDistance()` that accepts unnormalized vector and applies logarithmic radial mapping (see §3.6) |
| [`_drawDebrisDot()`](js/ui/NavSphere.js:384) | **Major rewrite** — use `target.distanceKm` (already on result from [`getDebrisNear()`](js/entities/DebrisField.js:868)), draw type shapes, closure rate coloring, velocity tail, distance readout for selected |
| [`_drawTetherRings()`](js/ui/NavSphere.js:497) | **Modify** — use `_distToRadius()` for ring radii, add translucent fills |
| [`_getZoneColor()`](js/ui/NavSphere.js:561) | **Extend** — integrate closure rate into color logic |
| [`_drawStalk()`](js/ui/NavSphere.js:453) | **Modify** — equatorial foot must also use `_distToRadius()` for the horizontal distance component (see §7.4) |
| [`_drawSatDot()`](js/ui/NavSphere.js:425) | **Modify** — use distance-encoded projection |
| [`_drawArmTetherLines()`](js/ui/NavSphere.js:592) | **Modify** — use distance-encoded projection for arm positions |
| [`update()`](js/ui/NavSphere.js:149) | **Modify** — (a) store `playerVel` as `this._playerVel`; (b) read `sensorSystem.range` to compute `this._outerZoneKm`; (c) **remove FOV ring draw** (see §3.8); (d) replace hardcoded [`SENSOR_RANGE`](js/ui/NavSphere.js:19) with `sensorSystem.range` in `getDebrisNear()` call |

### 5.3 NavSphere.js — New Methods to Add

| Method | Purpose |
|---|---|
| `_distToRadius(distKm, R, outerKm)` | Dual-zone logarithmic km → px mapping (see §3.5). `outerKm` from sensor range |
| `_toSphereWithDistance(relVec, cx, cy, R, outerKm)` | Combined direction + distance projection (see §3.6–3.7) |
| `_drawContactShape(ctx, sx, sy, type, size, alpha)` | Render debris type shape (circle/rect/diamond/triangle) |
| `_drawVelocityTail(ctx, sx, sy, relVel, cx, cy, R)` | Short line showing relative velocity direction |
| `_computeClosureRate(targetCart, playerPos, playerVel)` | Returns closure rate scalar (negative = approaching) |
| `_drawRangeRings(ctx, cx, cy, R, outerKm)` | Labeled concentric distance rings. Ring set adapts to `outerKm` |
| `_drawSalvageIndicator(ctx, sx, sy, hasSalvage, metalMassKg)` | Gold dot/ring for salvage targets |

### 5.4 NavSphere.js — Code to Remove

| Item | Reason |
|---|---|
| `const SENSOR_RANGE = 0.5` ([line 19](js/ui/NavSphere.js:19)) | Replaced by dynamic `sensorSystem.range` |
| `const FOV_RING_RATIO = 0.7` ([line 26](js/ui/NavSphere.js:26)) | FOV ring removed — meaningless with distance encoding (§3.8) |
| `const DOT_NEAR / DOT_MED / DOT_FAR` ([lines 21–23](js/ui/NavSphere.js:21)) | Replaced by continuous size scaling from `sizeMeter` |
| FOV ring draw block ([lines 246–252](js/ui/NavSphere.js:246)) | Removed — replaced by 5 km zone boundary |

### 5.5 Constants to Add in [`Constants.js`](js/core/Constants.js)

```js
// === NAVSPHERE REDESIGN ===
NAVSPHERE: {
  SPHERE_RADIUS: 130,                  // px
  INNER_ZONE_KM: 5,                    // tactical zone boundary
  // Note: OUTER_ZONE_KM is dynamic (from SensorSystem.range), this is a fallback max
  OUTER_ZONE_KM_MAX: 100,             // max awareness zone (advanced sensor tier)
  ZONE_SPLIT: 0.50,                    // fraction of radius for inner zone
  
  RANGE_RINGS_KM: [0.5, 2, 5, 10, 25, 50],  // filtered at runtime to outerKm
  
  // Dot sizing
  DOT_MIN_PX: 1.5,
  DOT_MAX_PX: 8,
  
  // Velocity tail
  VELOCITY_TAIL_MAX_PX: 15,
  VELOCITY_SCALE_FACTOR: 200,          // scene velocity → px multiplier
  VELOCITY_MIN_CONTACTS_KM: 10,        // only draw tails within this range
  
  // Closure rate thresholds (km/s scene units)
  CLOSURE_APPROACHING_THRESHOLD: -0.0001,
  CLOSURE_RECEDING_THRESHOLD: 0.0001,
  
  // Colors
  COLOR_APPROACHING: '#ff4444',
  COLOR_ORBIT_CROSS: '#ffaa00',
  COLOR_RECEDING: '#00ff88',
  COLOR_ZONE_BOUNDARY: 'rgba(255, 170, 0, 0.25)',
  COLOR_RANGE_RING: 'rgba(0, 150, 255, 0.12)',
  COLOR_RANGE_LABEL: 'rgba(0, 150, 255, 0.5)',
  COLOR_SALVAGE_HIGH: '#ffd700',
  COLOR_SALVAGE_LOW: 'rgba(255, 215, 0, 0.3)',
  
  // Performance
  MAX_VELOCITY_TAILS: 50,              // only N nearest contacts get tails
  MAX_SHAPE_CONTACTS_VISIBLE: 200,     // beyond this, distant contacts become simple dots
},
```

### 5.6 Data Flow Changes

The current [`update()`](js/ui/NavSphere.js:149) signature already receives everything needed:

```js
update(dt, {
  playerPos,           // ✅ have
  playerVel,           // ✅ have — store as this._playerVel for closure calc
  debrisField,         // ✅ have — provides getDebrisNear()
  activeSatellites,    // ✅ have
  sunDirection,        // ✅ have
  targetSelector,      // ✅ have
  sensorSystem,        // ✅ have — provides getDataTier() AND .range for dynamic outerKm
  armManager,          // ✅ have
})
```

**No new parameters needed.** Key changes inside `update()`:

1. Compute `this._outerZoneKm` from `sensorSystem.range / Constants.SCENE_SCALE` each frame.
2. Replace `getDebrisNear(playerPos, SENSOR_RANGE)` with `getDebrisNear(playerPos, sensorSystem.range)`.
3. Use `target.distanceKm` directly — it's already computed by [`getDebrisNear()`](js/entities/DebrisField.js:868) and avoids redundant `distScene * 100` calculation.
4. Use `target._cartesian.velocity` for closure rate and velocity vectors — already returned by [`getDebrisNear()`](js/entities/DebrisField.js:857).

### 5.7 SensorSystem Integration

Use [`sensorSystem.getDataTier(target, playerPos)`](js/systems/SensorSystem.js:128) to determine how much detail to show per contact. This is already a public method — just call it from the drawing loop.

The `canScanSalvage` flag on [`SensorSystem`](js/systems/SensorSystem.js:76) gates whether salvage indicators appear at all.

---

## 6. Implementation Priority & Phases

### Phase 1 — Core Spatial Mapping (P0, ~200 LOC)

1. Add `_distToRadius()` method
2. Add `_toSphereWithDistance()` method
3. Modify `_drawDebrisDot()` to use distance-encoded projection
4. Modify `_drawTetherRings()` to use `_distToRadius()` for radii + add fills
5. Add `_drawRangeRings()` with labeled rings at 0.5, 2, 5, 10, 25, 50 km
6. Update `_drawSatDot()` and `_drawArmTetherLines()` for new projection

**Result**: NavSphere now encodes distance. Tether zones are visible. Range is readable.

### Phase 2 — Contact Differentiation (P0, ~100 LOC)

7. Add `_drawContactShape()` for type-specific shapes
8. Add size scaling from `sizeMeter`
9. Add `_computeClosureRate()` and integrate into coloring
10. Add distance readout for selected target

**Result**: Each contact is visually distinct by type, size, and threat.

### Phase 3 — Tactical Information (P1, ~150 LOC)

11. Add `_drawVelocityTail()` with performance cap
12. Integrate `SensorSystem.getDataTier()` for progressive detail
13. Add salvage indicators gated by `canScanSalvage`

**Result**: Full I-War tactical experience with velocity, data gating, and salvage intel.

### Phase 4 — Polish (P2, ~100 LOC)

14. Density heatmap overlay (optional)
15. Adaptive zoom (`_sphereScale` property + key binding)
16. Tooltip on hover (would require enabling `pointer-events` on the canvas)

---

## 7. Risk & Compatibility Notes

### 7.1 Performance with 800 Contacts

**Current behavior**: [`getDebrisNear()`](js/entities/DebrisField.js:843) already iterates all 800 debris per call. The NavSphere already processes all returned contacts. Adding shape/velocity/closure calculations is O(N) additional work per contact — negligible compared to the orbit propagation.

**Mitigations**:
- NavSphere already throttles to **10 Hz** via `_frameSkip % 6` at [line 155](js/ui/NavSphere.js:155) — only 1 in 6 frames redraws.
- Velocity tails capped at `MAX_VELOCITY_TAILS` (50) nearest contacts.
- Shape contacts capped at `MAX_SHAPE_CONTACTS_VISIBLE` (200) — beyond that, distant contacts revert to simple dots.
- The `_cartesian` data is already computed by `getDebrisNear()` and cached per frame via [`_cacheFrame`](js/entities/DebrisField.js:167).

**Estimated overhead**: ≤ 0.5ms per NavSphere redraw at 800 contacts (Canvas2D shape draws are cheap).

### 7.2 Canvas 2D Adequacy

All proposed changes use standard Canvas2D operations:
- `ctx.arc()`, `ctx.fillRect()`, `ctx.moveTo()`/`ctx.lineTo()` — shapes
- `ctx.fillText()` — labels
- `ctx.createRadialGradient()` — already in use for background
- No WebGL, no offscreen canvas, no image assets needed

The density heatmap (E8, P2) would be the only performance-sensitive addition — it can be implemented as a pre-rendered offscreen canvas updated independently.

### 7.3 Backward Compatibility

| System | Impact |
|---|---|
| [`GameFlowManager.applyViewConfig()`](js/systems/GameFlowManager.js:56) | **None** — calls `setVisible()` which is unchanged |
| [`TargetSelector`](js/systems/TargetSelector.js) | **None** — NavSphere reads `targetSelector.getActiveTarget().id`, unchanged |
| [`EventBus`](js/core/EventBus.js) events | **None** — no new events required for Phase 1–3 |
| [`HUD.js`](js/ui/HUD.js) | **None** — NavSphere is independently rendered on its own canvas |
| CSS / DOM | **None** — same canvas, same position, same z-index |

The only **breaking** change is the visual appearance: objects will move to different radial positions on the sphere. This is purely visual and affects no game logic.

### 7.4 Stalk Behavior After Distance Encoding

The current [`_drawStalk()`](js/ui/NavSphere.js:453) projects the dot direction onto the equatorial plane **without normalizing**, so the equatorial foot naturally sits inside the sphere. With distance encoding, stalks should use the **same** radial mapping for the equatorial foot — project the 3D direction onto the XZ plane, then apply `_distToRadius()` to the horizontal distance component. This preserves the I-War depth perception effect at all distances.

### 7.5 Web-Shot Debris Indication

Debris with `dragMultiplier > 1.0` (web-shot targets decaying) could show a subtle spiral or "webbed" marker. This is a **nice-to-have** addition that piggybacks on the existing `target.dragMultiplier` field checked in [`DebrisField.update()`](js/entities/DebrisField.js:579). **P2** priority.

---

## 8. Visual Reference — Before & After

### Before (Current)

```
         ┌──────────── 130px ────────────┐
         │          ·  ·                  │
         │        · ·  ·· ·              │
         │       ·    ···  ·             │  ← all dots at rim
         │      ·   ◈ · ··  ·            │     (direction only)
         │     ·  ·  ●  · ·  ·           │
         │      ·  · · ··  ·             │  ← tether rings: invisible
         │       ·  · ··  ·              │     (< 5px radius)
         │        ·  ··  ·               │
         │          ·  ·                  │
         └───────────────────────────────┘
```

### After (Redesigned)

```
         ┌──────────── 130px ────────────┐
         │     ·         ·        [50km] │  ← outer awareness zone
         │   ·       ·       ·    [25km] │
         │  △   ·  ▫    ·     ·   [10km]│
         │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ [5km] │  ← zone boundary
         │ ╲  ◆→  ▫↗ ████  ◇← ╱        │  ← shapes + velocity tails
         │  ╲  ◆  ●  2.3km  ╱           │  ← selected target + distance
         │   ╲ ▒▒SPINNER▒▒ ╱            │  ← visible tether fills
         │    ╲▒▒LASSO▒▒▒╱              │
         │     ╲╌╌╌╌╌╌╌╱                │
         └───────────────────────────────┘
         
  Legend: ◆ defunctSat  ▫ rocketBody  △ missionDebris  · fragment
          → velocity tail (approaching=red, receding=green)
          ● selected target (pulsing cyan ring)
```

---

## 9. Summary of Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Distance encoding | Hybrid log + dual-zone (A+B) | Best spread of tether zone with compression of far contacts |
| Zone split | 50% R at 5 km | Tether zones occupy meaningful visual area |
| Shape system | 4 shapes for 4 types | I-War pattern, simple, high impact |
| Color priority | Closure rate > zone color > distance | Threat assessment is most time-critical info |
| Velocity tails | P1, capped at 50 | Valuable but must be performance-guarded |
| Zoom | Deferred to P2 | Architecture supports it, but dual-zone solves the core problem |
| Density heatmap | Deferred to P2 | Complex, lower ROI than the core changes |
