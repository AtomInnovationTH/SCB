# Target Panel Redesign — Space Cowboy

> Design document for the TargetPanel (right-side debris target list).
> Addresses positioning, visual language, information architecture, typography,
> layout, space recovery, and treasure-hunt UX.
>
> **References:** [`TargetPanel.js`](js/ui/hud/TargetPanel.js), [`HUD.js`](js/ui/HUD.js),
> [`NavSphere.js`](js/ui/NavSphere.js), [`DebrisWireframe.js`](js/ui/DebrisWireframe.js),
> [`DebrisField.js`](js/entities/DebrisField.js), [`SensorSystem.js`](js/systems/SensorSystem.js)

---

## Table of Contents

1. [Panel Positioning & Width](#1-panel-positioning--width)
2. [Visual Language — Debris at a Glance](#2-visual-language--debris-at-a-glance)
3. [Information Architecture — Row Design](#3-information-architecture--row-design)
4. [Text & Typography](#4-text--typography)
5. [Horizontal Layout](#5-horizontal-layout)
6. [Vertical Layout & Space Recovery](#6-vertical-layout--space-recovery)
7. [Treasure Hunt UX](#7-treasure-hunt-ux)
8. [Scanning Range & Progressive Reveal](#8-scanning-range--progressive-reveal)
9. [Danger Taxonomy & Hazard Display](#9-danger-taxonomy--hazard-display)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Panel Positioning & Width

### The Problem

The NavSphere orb is **280px diameter**, flush-right (`MARGIN_RIGHT = 0` in [`NavSphere.js:17`](js/ui/NavSphere.js:17)). The right column sits at `right: 0px` ([`HUD.js:125`](js/ui/HUD.js:125)), but TargetPanel has `minWidth: 260px` ([`TargetPanel.js:47`](js/ui/hud/TargetPanel.js:47)) and DebrisWireframe is `PANEL_WIDTH = 260` ([`DebrisWireframe.js:16`](js/ui/DebrisWireframe.js:16)).

Both the orb and the panel are right-flushed, so the left edges misalign by 20px:

```
Current alignment (right-flushed):

         ←──── 280px ────→
         ┌────────────────┐
         │   NavSphere    │    ← left edge at viewport - 280
         │     (orb)      │
         └────────────────┘
              ←── 260px ──→
              ┌───────────┐
              │ TargetPanel│    ← left edge at viewport - 260
              └───────────┘
         ↑ 20px gap ↑
```

### Recommendation: Match at 280px

**Set TargetPanel and DebrisWireframe both to `width: 280px`.**

| Factor | 260px (current) | 280px (proposed) |
|--------|-----------------|------------------|
| Aligns with NavSphere | ✗ 20px gap | ✓ Pixel-perfect |
| Horizontal breathing room | Cramped (236px content) | Comfortable (256px content) |
| Row data fit | Overflows at 4 items | Fits 4 items cleanly |
| Visual cohesion | Ragged left edge | Clean column |
| 1080p impact | N/A | Negligible (+20px) |

Extra 20px of content width goes directly to solving the Row 2 overflow problem (4 items crammed into too-narrow space).

### Positioning

```
Right column (unchanged logic, new width):

  #hud-right-column {
    position: absolute;
    top: 296px;           /* 6px below NavSphere bottom (10 + 280 + 6) */
    right: 0px;           /* flush-right, same as NavSphere */
    width: 280px;         /* NEW: match NavSphere diameter */
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(100vh - 326px);
    overflow-y: auto;
  }
```

The [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) `PANEL_WIDTH` constant also changes from `260` → `280`. The wireframe `WIRE_CX` stays at `PANEL_WIDTH / 2` (now 140, matching the NavSphere center offset from right edge).

### Alignment Stack (top to bottom)

```
viewport right edge →│
                     │
  ┌──────────────────┤  top: 10px
  │    NavSphere     │  280 × 280 (canvas overlay)
  │    (radar orb)   │
  └──────────────────┤  y = 290px
           6px gap   │
  ┌──────────────────┤  top: 296px (right column start)
  │ DebrisWireframe  │  280 × 320
  │  (selected tgt)  │
  ├──────────────────┤  6px gap
  │  TargetPanel     │  280 × variable
  │  (target list)   │
  └──────────────────┤
```

---

## 2. Visual Language — Debris at a Glance

### Design Goal

The pilot glances at the target list and instantly knows: **what kind, how big, how valuable, should I scan it?** — all from shape, color, and a tiny icon. No reading required for the first pass.

### 2.1 Shape Icons (Debris Type)

Four debris types exist in [`DebrisField.js:26-31`](js/entities/DebrisField.js:26). Each maps to a distinct Unicode glyph that echoes its 3D wireframe shape:

| Type | Shape | Icon | Rationale |
|------|-------|------|-----------|
| `fragment` | Icosahedron (shard) | `△` (U+25B3) | Sharp, small, the "junk" shape |
| `rocketBody` | Cylinder (tall) | `▮` (U+25AE) | Tall rectangle = rocket silhouette |
| `defunctSat` | Box (sat body) | `◻` (U+25FB) | Square = satellite bus |
| `missionDebris` | Sphere (small) | `●` (U+25CF) | Tiny dot = small operational debris |

**Monospace rendering note:** These are all single-character-width in Courier New. Test at 12px to confirm glyph visibility. Fallback: use CSS `::before` pseudo-elements with custom glyphs if Unicode rendering is inconsistent.

The user's "3 shapes" vision maps to the 3 common low-value silhouettes a pilot learns to recognize instantly: **shard, cylinder, box.** Mission debris (`●`) is the fourth — rare, small, and special (FEEP thruster components).

### 2.2 Color Coding (Value Tiers)

Three-color system, consistent with the HUD's established palette and aviation's green/amber/red convention:

| Tier | Color | Hex | Meaning | When Applied |
|------|-------|-----|---------|--------------|
| **Junk** | Dim green | `#557755` | Low value, not worth scanning | Fragment < 0.5m, no salvage flag |
| **Standard** | Green | `#00ff88` | Normal target, some value | Default for tracked targets |
| **Salvage** | Amber/Gold | `#ffcc00` | Has salvage (visible or scanned) | `hasSalvage === true` |
| **Jackpot** | Bright cyan | `#00ccff` | High-value scan result / selected | Scanned + high-value components found |
| **Danger** | Red | `#ff4444` | Mother/daughter derelict, hazard | Future: Kessler risk, conjunction |

**Rules:**
- Color applies to the **type icon and name** only (not the whole row)
- Distance and ΔV numbers stay neutral (`#aaaaaa`) for readability
- Selected row overrides icon color to `#00ccff` regardless of tier
- The border-left highlight (currently `#00ccff`) remains the selection indicator

### 2.3 Size Indicator

Debris size is already encoded in the type (rocket bodies are big, fragments are small), but within a type, size matters for value:

| Size | Indicator | Applied to icon |
|------|-----------|-----------------|
| < 1m | Normal icon size (12px) | Fragments, mission debris |
| 1–5m | Normal icon size (12px) | Default |
| > 5m | **Bold** icon | Rocket bodies, large defunct sats |

Implementation: `font-weight: bold` on the icon `<span>` for size > 5m. Simple, no extra column needed.

### 2.4 Scan Status Indicators

This is the treasure-hunt core. Three states with distinct visual treatments:

| State | Icon | Visual | Meaning |
|-------|------|--------|---------|
| **Unscanned** | `?` | Dim, pulsing opacity | "Mystery box — scan me!" |
| **Scanned — nothing** | (none) | Normal display | "What you see is what you get" |
| **Scanned — components!** | `✦` (U+2726) | Amber glow | "Treasure inside!" |

**Unscanned indicator (`?`):**
```css
.scan-unknown {
  color: #ffcc00;
  opacity: 0.6;
  animation: scan-pulse 2s ease-in-out infinite;
}
@keyframes scan-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
```

The `?` appears after the type name: `◻ Defunct ?` — it asks the pilot "what's inside?" Pressing `[Z]` (Analyze) on a selected target resolves it.

**Scanned-with-treasure indicator (`✦`):**
```css
.scan-treasure {
  color: #ffcc00;
  text-shadow: 0 0 4px rgba(255, 204, 0, 0.5);
}
```

Appears as: `◻ Defunct ✦` — the pilot immediately spots gold.

### 2.5 Danger Indicators

Danger is multi-dimensional in this game. The target list must communicate *what kind* of danger a target poses — each type calls for a different pilot response. See §9 for comprehensive taxonomy; this section covers the visual language.

**Danger icon priority** — only the highest-priority danger icon shows in the collapsed row's scan-status slot:

| Priority | Condition | Icon | Color | Behavior | Pilot Response |
|----------|-----------|------|-------|----------|----------------|
| 1 | Conjunction risk > 50% | `⚠` | `#ff4444` | Blinks at 1Hz | Evade immediately |
| 2 | Hydrazine detected (scan) | `☣` | `#ff4444` | Static | Requires Hazmat Handler upgrade |
| 3 | Extreme tumble > 60°/s | `⟳` | `#ff4444` | Rotates via CSS | Manual pilot required |
| 4 | High brittleness > 0.7 | `◇` | `#ff8844` | Static | Kessler risk — careful approach |
| 5 | Extreme mass > 4000kg | `▮` bold | `#ff8844` | Static | High ΔV cost, long detumble |
| 6 | Derelict (mother) | `☠` | `#ff4444` | Row red-tinted bg | Debris cloud warning |
| 7 | Moderate tumble 20-60°/s | `⟳` | `#ffcc00` | Rotates via CSS | Time net deployment carefully |

**Multiple dangers** — When a target has both danger and treasure, both indicators show:
```
 ◻ Defunct ☣✦    2.1km  ΔV 0.34  ◐     ← Hydrazine AND treasure
 ▮ R/B    ⟳?     5.3km  ΔV 1.20  ●     ← High tumble AND unscanned
```

When space allows (expanded row), all danger flags display on Line 3 in red before salvage hints:
```
 ┃   ⚠ N₂H₄ ⟳48°/s  │  Xe Li ⛏3   Bounty: 200cr
 ┃   ← RED dangers ──→│←─ AMBER treasure ──────────→
```

These replace the scan-status position when danger is the priority signal. See §9 for full details on how each danger type is detected, at what range, and how it affects pilot decisions.

### 2.6 Range Indicator (Simplified)

Current code uses three states (`●` `◐` `○`) which is good but the text labels waste space. Simplify to icon-only in collapsed rows:

| State | Icon | Color | Meaning |
|-------|------|-------|---------|
| In arm range | `●` | `#00ff88` | Deploy now! |
| Approaching (< 3× range) | `◐` | `#ffcc00` | Getting close |
| Far | `○` | `#ff4444` | Not in range |

The range icon sits at the **right edge** of the row. No text label in collapsed view. Expanded (selected) row shows the full `IN RANGE` or distance text.

---

## 3. Information Architecture — Row Design

### Design Principle

**Collapsed = identify & compare. Expanded = decide & act.**

The pilot Tab-cycles through targets. Collapsed rows let them compare at a glance. The expanded row for the selected target gives the decision data: "Is this worth the fuel?"

### 3.1 Collapsed Row (Non-Selected Target) — 1 Line

Every non-selected target gets exactly **one line, ~20px tall**.

```
Collapsed row (280px panel, ~256px content after padding):

 △ Frag        12.3km  ΔV 0.05  ○
 ▮ R/B    ✦    2.1km  ΔV 0.82  ●
 ◻ Defunct ?    8.7km  ΔV 0.34  ◐
 ● MRD         45.2km  ΔV 1.20  ○
```

**Layout columns (left to right):**

| Column | Width | Content | Alignment |
|--------|-------|---------|-----------|
| Icon | 16px | Type shape glyph | Left |
| Type + Scan | 72px | Short name + `?`/`✦`/space | Left |
| Distance | 56px | `XX.Xkm` | Right |
| ΔV | 64px | `ΔV X.XX` | Right |
| Range | 16px | `●`/`◐`/`○` | Center |
| Padding | 32px | Left/right margins (12+12) + gaps | — |
| **Total** | **256px** | Fits in 280px panel | — |

**What's NOT shown in collapsed view:**
- Net ΔV (only shown for selected)
- Points (only shown for selected)
- Salvage hints (only shown for selected)
- Selection icons (`►◆`) — removed entirely (border-left is sufficient)

### 3.2 Expanded Row (Selected Target) — 3 Lines

When a target is selected (Tab or click), its row expands to show decision-critical data:

```
Expanded row (selected):

 ┃ ◻ Defunct Sat ✦              2.1km  ●
 ┃   ΔV 0.82 km/s   Net +142 m/s   850pt
 ┃   Xe Li ⛏3         Bounty: 200cr
```

**Line 1 — Identity & Range:**
```
 ┃ {icon} {full type name} {scan}    {dist}  {range●}
```
- Full type name instead of abbreviation: "Defunct Sat" not "Defunct"
- Scan indicator (`✦` or `?`) if applicable
- Distance in km
- Range dot (with text label: `IN RANGE` / `2.1km`)

**Line 2 — Economics:**
```
 ┃   ΔV {cost}    Net {net ΔV}    {points}pt
```
- ΔV cost in km/s
- Net ΔV in m/s (color-coded: green positive, red negative, yellow neutral)
- Estimated points

**Line 3 — Salvage & Bounty (conditional):**
```
 ┃   {salvage hints}    Bounty: {credits}cr
```
- Only shown if `hasSalvage` or ground station bounty applies
- Salvage hints use the existing compact format: `Xe Li ⛏3`
- Ground station bounty: the reward for deorbiting even junk debris

**If no salvage and no special bounty, Line 3 is omitted** (selected row is 2 lines).

### 3.3 Scanned Target with Components — The Treasure Tease

**Before scanning** (shows `?` mystery):
```
 ┃ ▮ Rocket Body ?               5.3km  ◐
 ┃   ΔV 1.20 km/s   Net ??? m/s   ???pt
 ┃   ░░░░░░░░ SCAN TO REVEAL [Z]
```

- Net ΔV shows `???` (can't calculate without knowing salvage mass)
- Points shows `???`
- Line 3 shows a "scan to reveal" prompt with a subtle shimmer animation
- The `?` pulses gently — "there might be treasure here"

**After scanning — nothing special:**
```
 ┃ ▮ Rocket Body                 5.3km  ◐
 ┃   ΔV 1.20 km/s   Net -340 m/s  420pt
```

- `?` disappears, no `✦`, just clean data
- Net ΔV now calculable (and it's red — not worth it!)
- No Line 3 (no salvage)

**After scanning — jackpot:**
```
 ┃ ▮ Rocket Body ✦               5.3km  ◐
 ┃   ΔV 1.20 km/s   Net +890 m/s 2400pt
 ┃   N₂H₄ Xe ⛏5      Bounty: 800cr
```

- `✦` appears in amber, row text shifts to cyan tint
- Net ΔV is bright green and large positive
- Line 3 reveals the haul: hydrazine, xenon, 5 metal types
- Points spike (high-value target!)

### 3.4 Priority Hierarchy (What Pilots Need)

| Priority | Data | Where Shown | Why |
|----------|------|-------------|-----|
| 1 | **Type + Shape icon** | Collapsed line | Instant debris identification |
| 2 | **Distance** | Collapsed line | "How far?" |
| 3 | **ΔV cost** | Collapsed line | "Can I afford it?" |
| 4 | **Range status** | Collapsed icon | "Can I grab it now?" |
| 5 | **Scan mystery** | `?`/`✦` on collapsed | "Should I investigate?" |
| 6 | **Net ΔV** | Expanded line 2 | "Is it profitable?" |
| 7 | **Points** | Expanded line 2 | "How much is it worth?" |
| 8 | **Salvage details** | Expanded line 3 | "What's inside?" |
| 9 | **Ground bounty** | Expanded line 3 | "Is cleanup worth it?" |

---

## 4. Text & Typography

### 4.1 Font Stack

```css
font-family: 'Courier New', monospace;
```

Monospace is non-negotiable for a space-sim HUD. Courier New is the established choice across all panels ([`CommsPanel.js:69`](js/ui/hud/CommsPanel.js:69), [`StatusPanel.js`](js/ui/hud/StatusPanel.js)).

### 4.2 Size Hierarchy

| Element | Size | Weight | Color | Current | Change |
|---------|------|--------|-------|---------|--------|
| Section header | **11px** | normal | `#00ff88` @ 0.7 opacity | 11px | ✓ Keep (matches StatusPanel, CommsPanel) |
| Collapsed row text | **11px** | normal | tier color (icon) / `#aaaaaa` (data) | 10-12px mixed | Normalize to 11px |
| Expanded row line 1 | **12px** | **bold** | `#00ccff` (selected accent) | 13px bold | Reduce from 13→12 |
| Expanded row line 2 | **11px** | normal | `#aaaaaa` / colored values | 10px | ↑ from 10→11 |
| Expanded row line 3 | **10px** | normal | `#ffcc00` (salvage) / `#aaaaaa` | N/A (new) | New |
| Sort button | **10px** | normal | `#888888` | 9px | ↑ from 9→10 |
| Keyboard hints | **10px** | normal | `#666666` | 9px | ↑ from 9→10 |
| **Minimum size** | **10px** | — | — | 9px | **Kill 9px everywhere** |

### 4.3 The "No 9px" Rule

The current panel uses 9px for Net ΔV ([`TargetPanel.js:208`](js/ui/hud/TargetPanel.js:208)), keyboard hints ([`TargetPanel.js:217`](js/ui/hud/TargetPanel.js:217)), sort button ([`TargetPanel.js:56`](js/ui/hud/TargetPanel.js:56)), and untracked collision risk. **9px monospace is unreadable on most displays.** The minimum across the entire HUD should be **10px**, and only for tertiary information (hints, labels). Primary data should be **11px+**.

### 4.4 Color Palette (Unified with HUD)

| Role | Hex | Used For |
|------|-----|----------|
| Primary accent | `#00ff88` | Section headers, positive indicators |
| Selection accent | `#00ccff` | Selected target, interactive highlights |
| Warning | `#ffcc00` | Scan treasure, salvage hints, approaching range |
| Danger | `#ff4444` | Danger, negative Net ΔV, far range |
| Neutral data | `#aaaaaa` | Distance, ΔV numbers, secondary text |
| Dim/disabled | `#666666` | Keyboard hints, inactive elements |
| Junk tier | `#557755` | Low-value fragments (dimmed green) |
| Background (selected) | `rgba(0,204,255,0.10)` | Selected row background |
| Background (hover) | `rgba(0,255,136,0.06)` | Hover state |

---

## 5. Horizontal Layout

### 5.1 Column Grid (Collapsed Row)

Fixed-width columns ensure vertical alignment across all rows — critical for scanability in a monospace HUD.

```
Panel: 280px total
├─ 12px left pad
├─ 256px content area
│  ├─ 16px  [A] Type icon (△▮◻●)
│  ├─  4px  gap
│  ├─ 68px  [B] Type name + scan status (left-aligned)
│  ├─  4px  gap
│  ├─ 52px  [C] Distance XX.Xkm (right-aligned)
│  ├─  8px  gap
│  ├─ 72px  [D] ΔV cost ΔV X.XX (right-aligned)
│  ├─  4px  gap
│  ├─ 16px  [E] Range dot ●◐○ (center)
│  └─ 12px  right pad (incl border-left 2px)
└─ 12px right pad (panel padding)

Total content: 16+4+68+4+52+8+72+4+16+12 = 256px ✓
```

**ASCII mockup with column markers:**

```
│.............256px content....................│
│A  │..B.....│....C..│.....D...│E│
│△  Frag      12.3km  ΔV  0.05  ○│
│▮  R/B  ✦    2.1km  ΔV  0.82  ●│
│◻  Defunct?   8.7km  ΔV  0.34  ◐│
│●  MRD       45.2km  ΔV  1.20  ○│
```

### 5.2 CSS Implementation (Collapsed Row)

```css
.target-row {
  display: grid;
  grid-template-columns: 16px 72px 1fr 72px 16px;
  align-items: center;
  gap: 0 4px;
  padding: 2px 12px;
  height: 20px;
  line-height: 20px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.15s;
}
.target-row.selected {
  border-left-color: #00ccff;
  background: rgba(0, 204, 255, 0.10);
}
.target-row:hover:not(.selected) {
  background: rgba(0, 255, 136, 0.06);
}
.target-row .col-dist {
  text-align: right;
  color: #aaaaaa;
}
.target-row .col-dv {
  text-align: right;
  color: #aaaaaa;
}
.target-row .col-range {
  text-align: center;
}
```

Using `grid-template-columns: 16px 72px 1fr 72px 16px` — the `1fr` for distance allows flexible spacing. At 280px panel width with 24px total side padding, the grid gets 256px. The `1fr` resolves to ~52px (after fixed columns), which is sufficient for `XX.Xkm`.

### 5.3 Expanded Row Layout

The expanded row breaks out of the single-line grid into a multi-line block:

```css
.target-row.selected .expanded-detail {
  display: block;  /* hidden in collapsed */
  padding: 2px 0 2px 20px;  /* indent past the icon column */
  font-size: 11px;
  color: #aaaaaa;
}
.target-row:not(.selected) .expanded-detail {
  display: none;
}
```

**Expanded line 2 uses flexbox with `justify-content: space-between`:**

```
│  ΔV 0.82 km/s   Net +142 m/s   850pt │
│←─ left ──────→   ←─ center ─→  ←right→│
```

**Expanded line 3 (salvage/bounty) — same layout:**

```
│  Xe Li ⛏3            Bounty: 200cr    │
│←─ left ──→           ←──── right ────→│
```

---

## 6. Vertical Layout & Space Recovery

### 6.1 Space Budget Analysis (1080p)

Screen height: 1080px. Available for right column:

| Element | Height | Notes |
|---------|--------|-------|
| NavSphere | 290px | 10px margin + 280px diameter |
| Gap | 6px | Column gap |
| DebrisWireframe | 320px | Canvas panel (selected target analysis) |
| Gap | 6px | Column gap |
| **Available for TargetPanel** | **458px** | `1080 - 290 - 6 - 320 - 6 = 458px` |

But `max-height: calc(100vh - 326px)` is set on the right column in [`HUD.js:129`](js/ui/HUD.js:129), which means the **entire** right column (wireframe + targets) can be at most `1080 - 326 = 754px`. Wireframe takes 320px, leaving **434px** for the target panel (close to the 458px estimate — the difference is column gaps and rounding).

### 6.2 How Many Targets Fit?

| Row Type | Height | Count |
|----------|--------|-------|
| Section header (TRACKED) | 20px | 1 |
| Collapsed row | 22px (20px + 2px margin) | Variable |
| Expanded row (selected) | ~62px (3 lines × ~18px + padding) | 1 |
| Section header (UNTRACKED) | 20px | 1 (conditional) |
| Untracked row | 22px | Variable |
| Section header (ACTIVE SATS) | 20px | 1 (conditional) |
| Active sat row | 22px | Variable |
| Keyboard hints | 20px | 1 (conditional) |

**Target budget for 434px with all sections visible:**

```
 20px  TRACKED TARGETS header
 62px  1× expanded (selected) target
132px  6× collapsed tracked targets (22px each)
  4px  separator
 20px  UNTRACKED header
 44px  2× untracked rows
  4px  separator
 20px  ACTIVE SATS header
 44px  2× active sat rows
 20px  keyboard hints
────────
370px  ← fits with 64px to spare at 1080p
```

**Recommendation: Cap tracked targets at 7** (1 expanded + 6 collapsed = 194px for tracked section). This replaces the current 10-target cap, saving `3 × 44px = 132px` (each old target was 2 lines × 22px).

At 1440p: `1440 - 326 = 1114px` column budget, minus 320px wireframe = **794px for targets**. Plenty of room — even 10 targets fit comfortably. Consider using the extra space for a 4th expanded line (orbital details) rather than more targets.

### 6.3 Current vs Proposed Space Usage

```
CURRENT (10 targets × 2 lines each):

 20px  Header
440px  10 targets × 44px each (2 lines × 22px)
 20px  Keyboard hints
------
480px  ← overflows on 1080p!

PROPOSED (7 targets, 1 expanded):

 20px  Header
 62px  1 selected target (3 lines)
132px  6 collapsed targets (1 line each)
 20px  Keyboard hints
------
234px  ← 49% of current!  246px SAVED
```

**Space recovered: ~246px** from tracked section alone. This is even more than the estimated 340px from the brief because we're also removing per-row redundancy (no second line for non-selected targets).

### 6.4 Section Stacking Rules

1. **TRACKED TARGETS** — Always visible (even if empty: shows "No targets nearby")
2. **UNTRACKED (SENSOR)** — **Hidden when empty** (current behavior, keep it: [`TargetPanel.js:246`](js/ui/hud/TargetPanel.js:246))
3. **ACTIVE SATS** — **Hidden when empty** (current behavior, keep it: [`TargetPanel.js:268`](js/ui/hud/TargetPanel.js:268))
4. **Keyboard hints** — **Auto-hide after 60 seconds** of gameplay, or when no target is selected

Section separators: `1px solid rgba(0,255,136,0.15)` (current separator style, keep it). `4px` vertical margin above each separator.

### 6.5 Collapse Strategy

| Section | Max Items | Row Height | Collapse Rule |
|---------|-----------|------------|---------------|
| Tracked | **7** | 22px collapsed / 62px expanded | Only selected target expands. All others are 1 line. |
| Untracked | **3** (down from 5) | 22px | Always 1 line. Hide section if empty. |
| Active Sats | **3** (down from 6) | 22px | Always 1 line. Only show sats within 50km. Hide section if empty. |

### 6.6 Responsive: 1440p Bonus

At 1440p, detected extra vertical space (> 500px available for target panel) can:
- Increase tracked cap from 7 → 10
- Show 2 lines for the **second-nearest** target (preview without selecting)
- This is a nice-to-have, not a launch requirement

### 6.7 Full Panel Mockup (1080p)

```
┌────────────────────────────────────┐  280px
│ TRACKED TARGETS [Tab]    ΔV ↑     │  20px header
├────────────────────────────────────┤
│ ┃ ◻ Defunct Sat ✦      2.1km   ● │  Line 1 (selected)
│ ┃   ΔV 0.82    Net +142 m/s 850pt│  Line 2
│ ┃   Xe Li ⛏3       Bounty: 200cr │  Line 3
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│   △ Frag        12.3km  ΔV 0.05 ○│  Collapsed
│   ▮ R/B    ?     5.3km  ΔV 1.20 ◐│  Unscanned
│   ● MRD         45.2km  ΔV 0.18 ○│  Collapsed
│   △ Frag         3.8km  ΔV 0.03 ◐│  Collapsed
│   ◻ Defunct      9.1km  ΔV 0.45 ○│  Collapsed
│   ▮ R/B    ✦    18.6km  ΔV 2.10 ○│  Has treasure
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ UNTRACKED (SENSOR)                │
│   ⚬ 12cm Object  4.2km  ⚠ 23%   │
│   ⚬  3cm Object  8.7km  ⚠  5%   │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ ACTIVE SATS                       │
│   ⊕ Starlink-42 12.3km  SAFE     │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│  [G] Deploy  [Z] Scan  [D] Deorb │  Hints
└────────────────────────────────────┘
 Total: ~370px (fits 434px budget ✓)
```

---

## 7. Treasure Hunt UX

### 7.1 The Scan-to-Reveal Loop

The core treasure-hunt gameplay requires that some targets are **mysteries** that reward investigation. The target list is where the pilot first notices "hmm, that one might be interesting."

**Progression states for a single target:**

```
State 1: UNSCANNED (no salvage scanner upgrade)
┌──────────────────────────────────────┐
│   ◻ Defunct      8.7km  ΔV 0.34  ◐  │  ← Standard green, no hints
└──────────────────────────────────────┘
  Pilot sees: a defunct satellite, 8.7km out.
  No information about what's inside.
  Decision: based on type + distance + ΔV alone.

State 2: UNSCANNED (HAS salvage scanner, target in range)
┌──────────────────────────────────────┐
│   ◻ Defunct ?    8.7km  ΔV 0.34  ◐  │  ← Pulsing amber "?"
└──────────────────────────────────────┘
  Pilot sees: "?" means the scanner detects SOMETHING.
  The "?" only appears when canScanSalvage is true AND
  the target has hasSalvage === true.
  Decision: "I should scan that one — there's something inside!"

State 3: SCANNED — NO TREASURE
┌──────────────────────────────────────┐
│   ◻ Defunct      8.7km  ΔV 0.34  ◐  │  ← Clean, no indicator
└──────────────────────────────────────┘
  The "?" is removed after scanning. No "✦" appears.
  Pilot sees: just a defunct sat. Worth the ground bounty, maybe.

State 4: SCANNED — TREASURE FOUND
┌──────────────────────────────────────┐
│   ◻ Defunct ✦    8.7km  ΔV 0.34  ◐  │  ← Amber "✦" with glow
└──────────────────────────────────────┘
  Pilot sees: "✦" means valuable components confirmed!
  If selected, the expanded row shows what's inside.
```

### 7.2 Triggering "I Want to Scan That One"

The `?` indicator is the key motivator. Design rules:

1. **`?` only appears when the salvage scanner upgrade is purchased** (`canScanSalvage === true` from [`SensorSystem.js:76`](js/systems/SensorSystem.js:76))
2. **`?` only appears on targets with `hasSalvage === true`** — the scanner detects *something* but doesn't reveal what
3. **`?` pulses gently** (CSS animation, not JS timer) to draw the eye
4. **Multiple `?` targets visible at once** creates a "which one do I scan first?" decision
5. **Scanning costs sensor power time** — you can't spam-scan everything. Pick wisely.

The decision matrix becomes:
- **Close + `?`** → scan it! Low ΔV cost, might be treasure
- **Far + `?`** → is it worth the ΔV to get in scan range?
- **Close + no `?`** → just grab it for the bounty
- **Far + no `?`** → probably skip it

### 7.3 Ground Station Bounty Display

Ground station rewards for removing debris (even junk) are shown in the expanded row's Line 3:

```
 ┃   Bounty: 200cr
```

**Bounty calculation factors** (suggested, to be tuned):
- Base bounty per type: Fragment 50cr, MRD 100cr, Defunct 200cr, R/B 500cr
- Size multiplier: mass-proportional
- Orbit risk bonus: higher altitude = higher bounty (more dangerous orbit)
- Kessler zone bonus: targets in congested altitude bands get 2× bounty

The bounty is always known (ground station posts bounties on cataloged debris). It doesn't require scanning. This ensures **even junk targets have visible value** — the pilot always has a reason to collect.

**Display rule:** If `bounty > 0`, show it on Line 3 of the expanded row. If the target also has salvage, both appear on the same line:

```
 ┃   Xe Li ⛏3         Bounty: 200cr    ← Salvage + bounty
 ┃                     Bounty: 50cr     ← Bounty only (no salvage)
```

### 7.4 Scan Results Animation

When a scan completes on the selected target, momentarily "reveal" the results with a flash:

1. Row background flashes `rgba(255,204,0,0.15)` for 0.5s
2. The `?` morphs to `✦` (or disappears if no treasure)
3. Line 3 salvage details slide in (CSS transition, `max-height` from 0 → 18px)
4. A comms message announces the find: `"SCAN COMPLETE: Xenon reserves detected!"`

This creates a satisfying micro-moment — the "loot reveal" that makes the treasure hunt feel rewarding.

### 7.5 Hidden Component Categories

Future-proofing for the user's vision of hidden high-value components. These would appear in the salvage hints line:

| Component | Icon/Code | Color | Rarity |
|-----------|-----------|-------|--------|
| Cold gas (remaining) | `N₂` | `#aaffdd` | Common |
| Xenon reserves | `Xe` | `#aaffdd` | Uncommon |
| Gold components | `Au` | `#ffd700` | Rare |
| Hi-tech parts | `HT` | `#00ccff` | Rare |
| Military parts | `MIL` | `#ff8844` | Very rare |
| Top-secret | `██` (redacted look) | `#ff4444` | Ultra rare |
| Historical artifact | `☆` | `#ffffff` | Ultra rare |
| Mother/daughter link | `M↔D` | `#ff4444` | Special (danger) |

These integrate into the existing salvage hint system ([`TargetPanel._getSalvageHint()`](js/ui/hud/TargetPanel.js:302)) as additional codes. The `✦` indicator on the collapsed row tells the pilot "this has *something*" — they must select and read the expanded row to see *what*.

---

## 8. Scanning Range & Progressive Reveal

### 8.1 The Distance-Gated Information Model

The [`SensorSystem`](js/systems/SensorSystem.js) already implements distance-gated data enrichment via [`DATA_LEVELS`](js/systems/SensorSystem.js:50). The target panel should **reflect what the sensors can actually resolve** at each distance tier, creating a natural "get closer to learn more" loop.

**Current sensor data levels** ([`SensorSystem._getDataLevel()`](js/systems/SensorSystem.js:244)):

| Level | Distance | Fields Available | Label |
|-------|----------|-----------------|-------|
| FAR | > half sensor range | `type` only | "Unresolved" |
| MEDIUM | ≤ half sensor range | `type`, `size`, `mass` | "Classified" |
| NEAR | ≤ 2 km | + `material`, `tumbleRate` | "Analyzed" |
| CLOSE | ≤ 500 m | + `brittleness`, `orbit` | "Full Profile" |

**Sensor tier ranges** ([`SENSOR_TIERS`](js/systems/SensorSystem.js:22)):

| Tier | Range | Half-Range (FAR→MEDIUM threshold) | Upgrade Cost |
|------|-------|--------------------------------------|-------------|
| Basic | 10 km | 5 km | Starting |
| Enhanced | 50 km | 25 km | Shop |
| Advanced | 100 km | 50 km | Shop |

The **power distribution** system ([`PowerDistribution.sensorMultiplier`](js/systems/PowerDistribution.js:39)) further scales effective range: at 30% sensor power allocation, you get 0.7× range. At 50% you get 1.0×. Max 1.3× at 100%.

### 8.2 How Data Level Affects the Target Row

The collapsed target row should only display data the sensors can resolve. Unknown fields show as dim placeholders:

```
FAR (type only — target detected at extreme range):
 ◻ Defunct     ---km  ΔV ---   ○    ← only type icon known
                                      ΔV can't be computed (no orbit data)
                                      distance is approximate

MEDIUM (type + size + mass):
 ◻ Defunct      8.7km  ΔV ---  ○    ← distance known, ΔV still unknown
                                      (need orbit data for ΔV, which is CLOSE only)

NEAR (+ material, tumbleRate):
 ◻ Defunct      8.7km  ΔV 0.34  ◐   ← now ΔV can be estimated
                                      tumble/material visible → danger assessment
                                      scan indicator (?) can appear if canScanSalvage

CLOSE (+ brittleness, orbit — Full Profile):
 ◻ Defunct ✦    2.1km  ΔV 0.34  ●   ← full data, Net ΔV calculable
                                      brittleness → Kessler risk assessment
                                      full expanded row available
```

### 8.3 ΔV Estimation at Different Ranges

Currently [`computeTotalSalvageDeltaV()`](js/entities/OrbitalMechanics.js) and [`totalDeltaV()`](js/entities/OrbitalMechanics.js) compute ΔV from orbit parameters. But orbit data (`semiMajorAxis`, `eccentricity`, etc.) is only fully resolved at the CLOSE level.

**Proposed progressive ΔV display:**

| Data Level | What's Known | ΔV Display | Accuracy |
|------------|-------------|------------|----------|
| FAR | Type only | `ΔV ---` | No data |
| MEDIUM | Mass + distance | `ΔV ~0.5` (tilde = estimate) | ±50% — rough estimate from distance + mass |
| NEAR | + material, tumble | `ΔV ~0.34` | ±20% — better but still orbital uncertainty |
| CLOSE | Full orbit | `ΔV 0.34` (no tilde) | Accurate |

The **tilde prefix (`~`)** is a powerful visual cue: `ΔV ~0.5` tells the pilot "this is an estimate, get closer for accuracy." When the tilde disappears, they know the number is real.

### 8.4 Scanning Range for Salvage Detection

The [`canScanSalvage`](js/systems/SensorSystem.js:76) upgrade enables detecting whether a target contains salvageable components **at range**. Without it, `hasSalvage` is hidden until physical contact (capture).

**Key interaction with target list:**

| Upgrade State | Range | What Pilot Sees |
|---------------|-------|-----------------|
| No salvage scanner | Any | No `?` or `✦` indicators ever. Salvage is a surprise at capture. |
| Has salvage scanner | FAR | No indicator (can't scan at this distance) |
| Has salvage scanner | MEDIUM | `?` appears if `hasSalvage === true` (something detected!) |
| Has salvage scanner | NEAR | `?` remains, but now material/tumble data enriches the guess |
| Has salvage scanner + [Z] Analyze | NEAR/CLOSE | `?` resolves to `✦` (treasure) or disappears (nothing). Danger components turn red. |

The `?` indicator should only appear when:
1. `canScanSalvage === true` (upgrade purchased)
2. `hasSalvage === true` on the debris object
3. Data level ≥ MEDIUM (close enough for the scanner to detect *something*)
4. Target has NOT yet been analyzed (no `[Z]` press on this target)

### 8.5 The Scanning Action (`[Z]` Analyze)

Pressing `[Z]` on the selected target initiates a focused scan. This is distinct from passive sensor detection:

- **Passive detection** (SensorSystem) determines *what fields are available* by range
- **Active scan** (`[Z]`) resolves *salvage contents* and *danger components* for the selected target
- Active scan requires the target to be at NEAR range (≤ 2km) or CLOSE (≤ 500m)
- Scan takes 2-5 seconds (modified by `scanRate` from sensor tier and power allocation)
- During scan, a progress bar appears on the expanded row Line 3:

```
 ┃   ▓▓▓▓▓▓▓▓░░░░ SCANNING...  67%
```

**After scan completes**, results snap into place:
- `?` morphs to `✦` (treasure) or disappears
- Danger components appear in **red** on the salvage line
- Valuable components appear in **amber/cyan**
- An audio + visual "scan complete" micro-moment plays

### 8.6 Scanning Range Summary Diagram

```
←───────────── 50 km (enhanced sensor) ──────────────→
                                    ←── 25 km ──→
                        ←── 2 km ──→
                           ←500m→

  ┌─────────────────────────────────────────────────┐
  │  FAR                    MEDIUM    NEAR    CLOSE │
  │  type only              +mass     +mat    +orbit│
  │  ΔV ---                 ΔV ~est   ΔV ~est ΔV OK │
  │  no scan indicators     ? shows   ? shows ✦/☣   │
  │  no danger assessment   size risk tumble  full   │
  └─────────────────────────────────────────────────┘
           passive detection ───→
                            salvage scanner ? ───→
                                      [Z] analyze ──→
```

---

## 9. Danger Taxonomy & Hazard Display

### 9.1 Why Danger Matters for the Target Panel

The pilot's decision isn't just "is it worth it?" — it's also "is it safe?" A target that's worth 2400 points but has residual hydrazine, extreme tumble, and high brittleness requires a completely different approach (or avoidance) than a gentle defunct satellite.

The target panel must communicate danger **at the right time** — early enough to avoid, specific enough to plan around. Some dangers are visible from far away (big rocket body = mass threat). Others only reveal themselves up close or after scanning (hydrazine, battery volatility).

### 9.2 Comprehensive Danger Taxonomy

Source analysis from the existing codebase:

#### A. Structural / Physical Dangers (Visible via Sensors)

| Danger | Source Data | Detection Range | Icon | Color | Gameplay Impact |
|--------|-----------|----------------|------|-------|-----------------|
| **Extreme tumble** (> 60°/s) | [`tumbleRate`](js/entities/DebrisField.js:213) | NEAR (≤ 2km) | `⟳` | `#ff4444` | Auto-capture fails 70% of time ([`GameFlowManager.js:607`](js/systems/GameFlowManager.js:607)). Manual pilot required. |
| **Moderate tumble** (20-60°/s) | `tumbleRate` | NEAR (≤ 2km) | `⟳` | `#ffcc00` | "Time net deployment" — harder but auto-capturable |
| **Extreme mass** (> 4000 kg) | [`mass`](js/entities/DebrisField.js:27) (R/B) | MEDIUM | (none — `▮` bold) | `#ff4444` | Risk: 'Extreme' ([`DebrisField.js:1079`](js/entities/DebrisField.js:1079)). High ΔV cost, long detumble. |
| **High brittleness** (> 0.7) | [`brittleness`](js/entities/DebrisField.js:221) | CLOSE (≤ 500m) | `◇` | `#ff8844` | Kessler risk — capture may shatter target into fragments ([`effectiveBrittleness()`](js/ui/DebrisWireframe.js:436)). Composite material adds +0.1 brittleness. |
| **Engine zone** | Wireframe zone assessment | CLOSE (visual in DebrisWireframe) | `⚙` | `#ff4444` | "Always red — hazardous propellant/pressure vessels" ([`DebrisWireframe.js:454`](js/ui/DebrisWireframe.js:454)). Approach from opposite end. |

**Key design point:** Tumble and mass dangers are detectable *before* committing to an approach. Brittleness is only known at CLOSE range — by then you've already spent ΔV to get there. This creates tension: "I've come this far... do I risk it?"

#### B. Chemical / Hazmat Dangers (Scan-Revealed)

| Danger | Source Data | Detection | Icon | Color | Gameplay Impact |
|--------|-----------|-----------|------|-------|-----------------|
| **Residual hydrazine (N₂H₄)** | [`salvage.hydrazine`](js/entities/DebrisField.js:323) | `canScanSalvage` + `[Z]` analyze | `☣` | `#ff4444` | Toxic, corrosive. Requires "Hazmat Handler" upgrade (1200cr) to safely recover. Without upgrade: "discarded safely" — value wasted. 1.4× credits if recovered ([`SALVAGE_HAZMAT_MULTIPLIER`](js/core/Constants.js:266)). Exists primarily in **rocket bodies** (10% chance). |
| **Volatile battery** | [`salvage.battery`](js/entities/DebrisField.js:310) (high value) | `canScanSalvage` + `[Z]` | `⚡` | `#ff8844` | Li-ion cells in vacuum can off-gas, swell, or short. Old batteries are more dangerous. The game models this as a "capture carefully" signal. No gameplay penalty currently, but sets up future risk mechanics. |
| **Lithium (MPD fuel)** | [`salvage.lithium`](js/entities/DebrisField.js:315) | `canScanSalvage` + `[Z]` | `Li` | `#88ccff` | Not dangerous per se, but indicates presence of MPD thruster components. Reveals target was military/advanced — flags as "interesting." |

**Hydrazine is the flagship danger component.** It already has special handling:
- DebrisWireframe renders it in red: `ctx.fillStyle = '#ff4444'` with `⚠ N₂H₄: X kg (HAZMAT)` ([`DebrisWireframe.js:1041`](js/ui/DebrisWireframe.js:1041))
- GameFlowManager checks for Hazmat Handler upgrade before allowing recovery ([`GameFlowManager.js:728`](js/systems/GameFlowManager.js:728))
- Comms system warns: `"⚠ N₂H₄ detected but no Hazmat Handler — discarded safely"` ([`GameFlowManager.js:737`](js/systems/GameFlowManager.js:737))

#### C. Environmental / Orbital Dangers (External)

| Danger | Source System | Detection | Icon | Color | Gameplay Impact |
|--------|-------------|-----------|------|-------|-----------------|
| **Conjunction / collision risk** | [`ConjunctionSystem`](js/systems/ConjunctionSystem.js) | Automatic (per-frame scan) | `⚠` | `#ff4444` blink | Target on collision course with player. 3-tier warnings (GREEN/YELLOW/RED). Forces ΔV-costly evasion. |
| **Kessler cascade risk** | [`KesslerSystem`](js/systems/KesslerSystem.js) | Automatic + brittleness | `☢` | `#ff4444` | System-wide fragment count approaching cascade threshold. Brittle targets worsen the count if shattered. |
| **Radiation zone (SAA)** | [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js) | Weather events | (not per-target) | — | Affects sensors, not individual targets. Sensor range reduced during SAA passes. |
| **Geomagnetic storm** | `SpaceWeatherSystem` | Weather events | (not per-target) | — | CME events degrade sensor performance, increase radiation dose. |

Environmental dangers don't attach to specific target rows — they affect the entire session. But **conjunction warnings DO attach to specific debris** and should flash on that target's row.

#### D. Future / Planned Dangers (From User's Vision)

| Danger | Concept | Icon | Color | Notes |
|--------|---------|------|-------|-------|
| **Mother derelict** | Large defunct craft with daughter debris cloud | `☠` | `#ff4444` | Warning: approaching this means flying through a debris cloud |
| **Daughter debris** | Fragments orbiting near a mother derelict | `⚡` | `#ff8844` | Collision risk from multiple small objects |
| **Military debris** | Top-secret / classified components | `██` | `#ff4444` | High value but may trigger "ground station scrutiny" event |
| **Radiation source** | RTG / nuclear debris (rare) | `☢` | `#ff4444` | Extreme danger — proximity damages electronics. Must use long-range capture. |

### 9.3 How Danger Appears in the Target Row

**Collapsed row — danger icon replaces or supplements scan indicator:**

The scan-status slot (after the type name) serves double duty. Priority order:

1. **Danger icon** (red) takes priority over scan icon — safety first
2. If both danger AND scan are relevant, show both: `☣✦` or `⟳?`
3. If only scan: `?` or `✦`
4. If neither: empty

```
Danger only:
 ▮ R/B    ⟳     5.3km  ΔV 1.20  ◐    ← high tumble (visible at NEAR)

Danger + treasure:
 ◻ Defunct ☣✦    2.1km  ΔV 0.82  ●    ← hydrazine + valuable salvage

Danger + mystery:
 ▮ R/B    ⟳?    12.1km  ΔV 2.40  ○    ← tumble + unscanned salvage
```

**Expanded row — Line 3 splits into red dangers + amber salvage:**

```
Full expanded row (selected target with dangers + salvage):

 ┃ ▮ Rocket Body ☣⟳            2.1km  ●
 ┃   ΔV 1.20 km/s   Net +890 m/s  2400pt
 ┃   ☣ N₂H₄ 4.2kg  ⟳ 72°/s  │  Xe ⛏5  Bounty: 800cr
     ├── RED zone ──────────┤  ├── AMBER zone ──────────┤
```

**Color rules for Line 3:**
- Danger components: `#ff4444` (red) — hydrazine, tumble warning, brittleness alert
- Valuable components: `#ffcc00` (amber) — xenon, metals, GaAs, etc.
- Neutral info: `#aaaaaa` — bounty value
- A thin `│` separator divides danger from treasure

### 9.4 Danger-Aware Row Coloring

Beyond the icon, the **row background** subtly shifts for dangerous targets:

```css
/* Danger tint for rows with extreme risk */
.target-row.danger-extreme {
  background: rgba(255, 68, 68, 0.06);
  border-left-color: #ff4444;
}
.target-row.danger-moderate {
  background: rgba(255, 170, 0, 0.04);
}
```

This applies even to collapsed rows — the pilot sees a faint red tint and knows "that one's trouble" before reading any text.

### 9.5 Danger Detection Timeline

A target's danger profile reveals itself progressively as the pilot approaches:

```
50km ─── 25km ─── 2km ─── 500m ─── 200m ─── Contact
  │        │       │       │        │         │
  │        │       │       │        │         └─ ALL data (capture)
  │        │       │       │        └─ [Z] scan resolves salvage:
  │        │       │       │           ☣ N₂H₄ appears RED
  │        │       │       │           ✦ treasure confirmed
  │        │       │       │
  │        │       │       └─ Brittleness known:
  │        │       │          ◇ Kessler risk assessment possible
  │        │       │          Engine zone visible in wireframe
  │        │       │
  │        │       └─ Tumble + material known:
  │        │          ⟳ HIGH TUMBLE warning appears
  │        │          Material → composite = +brittleness
  │        │          Salvage scanner ? appears (if MEDIUM+)
  │        │
  │        └─ Mass known:
  │           Extreme mass (>4000kg) → red type icon
  │           ΔV estimate improves (~tilde)
  │
  └─ Type only:
     Shape icon + color tier
     Rocket body = inherent "big" signal
     Distance approximate
```

**This is the approach decision cascade:**

1. **50km**: "There's a rocket body out there. Big, probably expensive to reach."
2. **25km**: "It's 4200kg. That's an Extreme risk rating. ΔV estimate is high."
3. **2km**: "Tumble is 72°/s — I'll need manual pilot. But the scan shows `?`..."
4. **500m**: "Brittleness 0.8 — if I mess up the capture, Kessler fragments."
5. **200m**: `[Z]` scan → "☣ N₂H₄ 4.2kg! That's hazmat bonus × 1.4. And 5 metals. Jackpot — but dangerous."
6. **Decision**: "Do I have the Hazmat Handler? Do I trust my manual piloting? Is the reward worth the cascade risk?"

### 9.6 Risk vs. Reward Display Integration

The expanded row should make the risk/reward tradeoff immediately visible:

```
DANGEROUS + VALUABLE (worth it?):
 ┃ ▮ Rocket Body ☣⟳            2.1km  ●
 ┃   ΔV 1.20 km/s   Net +890 m/s  2400pt    ← GREEN net ΔV = yes, worth it
 ┃   ☣ N₂H₄ 4.2kg  ⟳ 72°/s  │  Xe ⛏5  800cr     ← danger RIGHT NEXT TO reward

DANGEROUS + LOW VALUE (not worth it):
 ┃ ▮ Rocket Body ⟳              5.3km  ◐
 ┃   ΔV 2.40 km/s   Net -1200 m/s  420pt    ← RED net ΔV = no, terrible deal
 ┃   ⟳ 65°/s  ◇ brittle       │  Bounty: 100cr     ← danger with tiny reward

SAFE + VALUABLE (easy win):
 ┃ ◻ Defunct Sat ✦              2.1km  ●
 ┃   ΔV 0.34 km/s   Net +342 m/s  1200pt    ← GREEN, no dangers
 ┃   Xe Li ⛏3                    Bounty: 200cr     ← pure upside
```

The juxtaposition of red danger tags next to green reward numbers creates the tension that drives gameplay decisions. The pilot *sees* both incentive and risk in the same visual field, forcing a conscious choice.

---

## 10. Implementation Notes

### 10.1 Changes by File

| File | Changes Required |
|------|-----------------|
| [`TargetPanel.js`](js/ui/hud/TargetPanel.js) | Full rewrite of [`_updateTargetList()`](js/ui/hud/TargetPanel.js:134). New row template with grid layout. Scan status logic. Danger indicators. Collapsed/expanded states. Progressive data reveal (§8). Remove `►◆` icons. Cap at 7 tracked. |
| [`HUD.js`](js/ui/HUD.js) | Update right-column width to 280px. Pass scan data + danger assessment through to TargetPanel. Wire `[Z]` analyze action. |
| [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) | Update `PANEL_WIDTH` from 260 → 280. Adjust `WIRE_CX` to 140. |
| [`NavSphere.js`](js/ui/NavSphere.js) | No changes (already 280px diameter, right-flushed). |
| [`SensorSystem.js`](js/systems/SensorSystem.js) | Expose `canScanSalvage` state to HUD. Add per-target `scanned` boolean + `scanResult`. Expose `dataLevel` per target. Add active scan progress timer (for `[Z]` action). |
| [`DebrisField.js`](js/entities/DebrisField.js) | Add `scanned` boolean, `scanResult`, and `dangerFlags` to debris data objects. Extend [`getTargetsForHUD()`](js/entities/DebrisField.js:1024) to include danger assessment (tumble risk, mass risk, brittleness risk from existing [`risk`/`riskStars`](js/entities/DebrisField.js:1070) computation). |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js) | Wire `[Z]` analyze action to SensorSystem scan. Emit scan-complete events with resolved salvage + danger data. |
| [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js) | Expose per-debris conjunction warning flag so TargetPanel can show `⚠` on the specific threat row. |
| `index.html` / CSS | Add `.target-row` grid styles, `.scan-unknown` pulse, `.scan-treasure` glow, `.danger-extreme` / `.danger-moderate` row tints, `⟳` rotation animation, `☣` danger glow. |

### 10.2 Data Flow

```
DebrisField                    SensorSystem              ConjunctionSystem
    │                              │                          │
    │ debris.hasSalvage            │ canScanSalvage           │ conjunctionFlags
    │ debris.salvage               │ debris.scanned (new)     │ per-debris threat
    │ debris.type                  │ debris.scanResult (new)  │
    │ debris.sizeMeter             │ debris.dataLevel (new)   │
    │ debris.tumbleRate            │                          │
    │ debris.brittleness           │                          │
    │ debris.mass                  │                          │
    │ debris.risk / riskStars      │                          │
    ▼                              ▼                          ▼
    ┌───────────────────────────────────────────────────────────┐
    │ HUD.update() → cachedTargets                              │
    │   enriched with:                                          │
    │   • scan state (scanned/scanResult)                       │
    │   • data level (FAR/MEDIUM/NEAR/CLOSE)                    │
    │   • danger flags (tumble/mass/brittleness/hydrazine/conj) │
    │   • value tier (junk/standard/salvage/jackpot)            │
    └──────────────────────┬────────────────────────────────────┘
                           │
                           ▼
    ┌──────────────────────────────────────────────────────────┐
    │ TargetPanel.update()                                      │
    │  • Sort targets                                           │
    │  • Slice to 7                                             │
    │  • For each target:                                       │
    │    ├─ Determine what data is visible (dataLevel)          │
    │    ├─ Compute danger flags from visible data              │
    │    ├─ Select type icon, color tier, scan/danger indicators│
    │    ├─ Render collapsed (1 line) or expanded (selected)    │
    │    └─ Apply row tint (danger-extreme/moderate/normal)     │
    │  • Show scan progress bar if [Z] active                   │
    └──────────────────────────────────────────────────────────┘
```

### 10.3 New CSS Classes

```css
/* Target row grid */
.target-row {
  display: grid;
  grid-template-columns: 16px 72px 1fr 72px 16px;
  align-items: center;
  gap: 0 4px;
  padding: 2px 12px;
  height: 20px;
  line-height: 20px;
  font-size: 11px;
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 2px;
  transition: background 0.15s;
}

/* Selected state */
.target-row.selected {
  height: auto;
  border-left-color: #00ccff;
  background: rgba(0, 204, 255, 0.10);
}

/* Expanded detail block (inside selected row) */
.target-expanded {
  grid-column: 1 / -1;  /* span full width */
  padding: 2px 0 4px 20px;
  font-size: 11px;
}
.target-expanded .econ-line {
  display: flex;
  justify-content: space-between;
  color: #aaaaaa;
}
.target-expanded .salvage-line {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #ffcc00;
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.target-expanded .salvage-line.revealed {
  max-height: 18px;
}

/* Scan status animations */
.scan-unknown {
  color: #ffcc00;
  animation: scan-pulse 2s ease-in-out infinite;
}
@keyframes scan-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}

.scan-treasure {
  color: #ffcc00;
  text-shadow: 0 0 4px rgba(255, 204, 0, 0.5);
}

/* Type icon bold for large debris */
.type-icon.large {
  font-weight: bold;
}

/* Value tier colors */
.tier-junk    { color: #557755; }
.tier-std     { color: #00ff88; }
.tier-salvage { color: #ffcc00; }
.tier-jackpot { color: #00ccff; }
.tier-danger  { color: #ff4444; }

/* Net ΔV coloring */
.net-dv-pos { color: #44ff44; }
.net-dv-neg { color: #ff4444; }
.net-dv-neu { color: #ffff44; }

/* Hover */
.target-row:hover:not(.selected) {
  background: rgba(0, 255, 136, 0.06);
}

/* Range dots */
.range-in    { color: #00ff88; }
.range-near  { color: #ffcc00; }
.range-far   { color: #ff4444; }

/* --- Danger indicators (§9) --- */

/* Danger row tinting */
.target-row.danger-extreme {
  background: rgba(255, 68, 68, 0.06);
}
.target-row.danger-extreme.selected {
  background: rgba(255, 68, 68, 0.10);
  border-left-color: #ff4444;
}
.target-row.danger-moderate {
  background: rgba(255, 170, 0, 0.04);
}

/* Hydrazine/hazmat danger glow */
.danger-hazmat {
  color: #ff4444;
  text-shadow: 0 0 3px rgba(255, 68, 68, 0.4);
}

/* High tumble spinning icon */
.danger-tumble {
  color: #ff4444;
  display: inline-block;
  animation: spin-danger 1.5s linear infinite;
}
.danger-tumble.moderate {
  color: #ffcc00;
  animation-duration: 3s;
}
@keyframes spin-danger {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* Conjunction blink */
.danger-conjunction {
  color: #ff4444;
  animation: conjunction-blink 1s step-end infinite;
}
@keyframes conjunction-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.3; }
}

/* Expanded row Line 3: danger zone (red) vs salvage zone (amber) */
.target-expanded .danger-zone {
  color: #ff4444;
  font-size: 10px;
}
.target-expanded .salvage-zone {
  color: #ffcc00;
  font-size: 10px;
}
.target-expanded .danger-salvage-split {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

/* --- Progressive data reveal (§8) --- */

/* Placeholder for unresolved data */
.data-unknown {
  color: #444444;
  font-style: italic;
}

/* Estimated value (tilde prefix) */
.data-estimated {
  color: #888888;
}
.data-estimated::before {
  content: '~';
  opacity: 0.6;
}

/* Scan progress bar (on expanded Line 3 during [Z] action) */
.scan-progress {
  height: 3px;
  background: rgba(255, 204, 0, 0.2);
  border-radius: 1px;
  overflow: hidden;
  margin: 2px 0;
}
.scan-progress-fill {
  height: 100%;
  background: #ffcc00;
  transition: width 0.2s linear;
}
```

### 10.4 Migration Path

**Phase 1 — Layout & Width (low risk):**
1. Change panel width to 280px (TargetPanel, DebrisWireframe, right column)
2. Apply CSS grid to target rows
3. Reduce tracked cap to 7
4. Remove `►◆` selection icons, rely on border-left
5. Collapse non-selected rows to 1 line

**Phase 2 — Visual Language (medium risk):**
1. Add type shape icons (`△▮◻●`)
2. Apply value-tier color coding
3. Bold icon for large debris
4. Simplified range dots (icon only, no text in collapsed)

**Phase 3 — Progressive Data Reveal (medium risk):**
1. Pass `dataLevel` from SensorSystem through to TargetPanel
2. Show `---` / `~` for fields not yet resolved at current range
3. ΔV shows tilde prefix (`~`) when estimated, no prefix when accurate
4. Fields appear as pilot gets closer — natural information reveal

**Phase 4 — Treasure Hunt (requires new data fields):**
1. Add `scanned`/`scanResult` fields to debris objects
2. Implement `?` pulsing indicator for unscanned salvage (requires MEDIUM+ range)
3. Implement `✦` treasure indicator for scanned salvage
4. Wire `[Z]` analyze action with progress bar and scan-complete animation
5. Add ground station bounty display

**Phase 5 — Danger System (requires danger flag aggregation):**
1. Compute danger flags from existing data (tumble, mass, brittleness, hydrazine, conjunction)
2. Implement danger icons (`⟳` `☣` `◇`) with appropriate colors and animations
3. Red danger zone on expanded row Line 3 (separate from amber salvage)
4. Row background tinting for dangerous targets (`.danger-extreme`, `.danger-moderate`)
5. Wire ConjunctionSystem per-debris threat flags to target row `⚠` blink

### 10.5 Testing Checklist

- [ ] Panel aligns pixel-perfectly under NavSphere at 1080p and 1440p
- [ ] 7 tracked targets + 3 untracked + 3 sats fit without scrolling at 1080p
- [ ] Collapsed rows scan vertically (ΔV column aligned across all rows)
- [ ] Selected target expansion is smooth (no layout jank)
- [ ] Type icons render correctly in Courier New at 11px
- [ ] `?` pulse animation runs at 60fps without JS timer (CSS only)
- [ ] Click-to-select and Tab-cycle still work with new row structure
- [ ] Sort button (ΔV/Dist/Pts) cycles correctly
- [ ] Net ΔV color coding matches thresholds (>50 green, <-50 red, else yellow)
- [ ] All text ≥ 10px (no 9px anywhere)
- [ ] Progressive reveal: FAR targets show `---` for unknown fields
- [ ] ΔV tilde prefix appears for estimated values, disappears at CLOSE range
- [ ] `?` only appears when `canScanSalvage` is true AND target has salvage AND dataLevel ≥ MEDIUM
- [ ] `[Z]` scan progress bar renders and completes correctly
- [ ] Scan reveal animation: `?` morphs to `✦` or disappears, Line 3 slides in
- [ ] Danger icon `⟳` shows for tumble > 60°/s (detected at NEAR range)
- [ ] Danger icon `☣` shows for hydrazine (detected via `[Z]` scan)
- [ ] Danger components display in red (`#ff4444`) on expanded Line 3
- [ ] Valuable components display in amber (`#ffcc00`) on expanded Line 3
- [ ] Danger row tinting: faint red bg for extreme, faint amber for moderate
- [ ] Conjunction `⚠` blinks at 1Hz on the specific threat target row
- [ ] Multiple danger + treasure icons display together: `☣✦` or `⟳?`

---

## Appendix: Before/After Comparison

### Before (Current)
```
         ╭──── 280px ────╮
         │  NavSphere orb │
         ╰────────────────╯
              ╭── 260px ──╮    ← 20px misaligned
              │ Wireframe  │
              ╰────────────╯
              ╭── 260px ──╮
              │►◆ R/B ⛏       12.3km│  ← 2 lines per target
              │ΔV:0.05 Net+12 ● RNG 850│  ← 4 items crammed
              │ ◇ Defunct      8.7km│
              │ΔV:0.34 Net-40 ◐ APR 200│
              │ ◇ Frag        45.2km│
              │ΔV:0.18 Net-5 ○ FAR 100│
              │ ◇ ...                │  ← 10 targets = 440px
              │ ◇ ...                │
              │ ◇ ...                │
              │ [G]Deploy [Z].. [D]..│
              ╰──────────────────────╯
```

### After (Proposed)
```
         ╭──── 280px ────╮
         │  NavSphere orb │
         ╰────────────────╯
         ╭──── 280px ────╮    ← aligned!
         │  Wireframe     │
         ╰────────────────╯
         ╭──── 280px ────╮
         │TRACKED TARGETS    ΔV↑│
         │┃◻ Defunct ✦   2.1km ●│  ← selected: 3 lines
         │┃ ΔV 0.82  Net+142 850│
         │┃ Xe Li ⛏3  Bnty:200cr│
         │ △ Frag      12.3km  ○│  ← collapsed: 1 line each
         │ ▮ R/B ?      5.3km  ◐│
         │ ● MRD       45.2km  ○│
         │ △ Frag       3.8km  ◐│
         │ ◻ Defunct    9.1km  ○│
         │ ▮ R/B  ✦   18.6km  ○│
         │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
         │UNTRACKED            │
         │ ⚬ 12cm Obj  4.2km  │
         │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│
         │ [G]Deploy [Z]Scan   │
         ╰─────────────────────╯
              ~370px total
              (was 480+px)
```

**Net vertical savings: ~246px** — enough to prevent scrolling on 1080p and eliminate the cramped feeling of the current design.
