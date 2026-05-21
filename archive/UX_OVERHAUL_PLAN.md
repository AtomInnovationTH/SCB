# UX Overhaul Plan — Discovery & Comms Rework

> **⚠️ ARCHIVED — 2026-04-22.** All 5 phases fully implemented (2026-04-17). This plan is complete and retained for historical reference. **Move to `archive/`.**

## Implementation Status
✅ **All 5 phases implemented** — 2026-04-17

| Phase | Status | Files Modified |
|-------|--------|----------------|
| 1. Remove `awareness_beauty` | ✅ Complete | Constants.js, SkillsSystem.js, GameFlowManager.js, HUD.js, Events.js |
| 2. Move SkillsPane to bottom-left | ✅ Complete | SkillsPane.js |
| 3. Unified Discovery Pane + renames | ✅ Complete | SkillsPane.js, CodexViewerUI.js, Constants.js, Events.js, CodexSystem.js |
| 4. Clean comms | ✅ Complete | CodexSystem.js (merged with Phase 3) |
| 5. Progression-aware persistence | ✅ Complete | SkillsPane.js |

All 353 tests passing.

> **Status**: ✅ Implemented (2026-04-16)
> **Scope**: 4 interconnected changes across ~7 files
> **Risk**: Medium — UI-only changes, no game mechanics altered
> **Estimated effort**: ~3 implementation sessions (completed in 1)

---

## Table of Contents

1. [Problem Analysis](#1-problem-analysis)
2. [Change 1: Defuse `awareness_beauty`](#2-change-1-defuse-awareness_beauty)
3. [Change 2: Relocate Skills Pane to Bottom-Left](#3-change-2-relocate-skills-pane-to-bottom-left)
4. [Change 3: "New Tech" Pane — Unified Discovery Pane](#4-change-3-new-tech-pane--unified-discovery-pane)
5. [Change 4: Focus Comms on Tactical/Strategic Info](#5-change-4-focus-comms-on-tacticalstrategic-info)
6. [Revised HUD Layout](#6-revised-hud-layout)
7. [Implementation Order](#7-implementation-order)
8. [Files Affected](#8-files-affected)

---

## 1. Problem Analysis

### Problem 1: "Beauty" is Not a Skill

**Current**: After 5 seconds in ORBITAL_VIEW, `awareness_beauty` auto-triggers via `setTimeout` ([`SkillsSystem._setupListeners()`](js/systems/SkillsSystem.js:296)). This emits `SKILL_DISCOVERED`, causing the SkillsPane to slide in with "New Skill: Beauty!" — treating passive observation as a player achievement.

**Discovery**: The `awareness_beauty` catalog entry at [`Constants.js:973`](js/core/Constants.js:973) has `hudGroup: null` and `triggerEvent: null`. It gates nothing. Score-group is already unconditionally activated at [`HUD.js:433-434`](js/ui/HUD.js:433) (`activeDom.add('score-group')`). This "skill" is purely cosmetic noise.

**After**: Remove `awareness_beauty` from the skill system entirely. The timer, the catalog entry, the notification — all gone. Score-group remains always-visible as it already is.

---

### Problem 2: Skills Pane is on the Wrong Side

**Current**: SkillsPane sits at `bottom: 180px; right: 10px` ([`SkillsPane._injectStyles()`](js/ui/hud/SkillsPane.js:241)), stacking on top of the right column that already contains target wireframe, target list, and comms panel.

**After**: SkillsPane moves to `bottom: 180px; left: 10px`, using the currently empty bottom-left area. This creates spatial separation: **left = learning/discovery**, **right = tactical/operational**.

---

### Problem 3: "Codex" is Indistinguishable Noise in Comms

**Current**: When a codex entry unlocks, [`CodexSystem._performUnlock()`](js/systems/CodexSystem.js:1500) emits `COMMS_MESSAGE` with `{ priority: 'LOW', source: 'CODEX' }`. This LOW-priority message enters the same 8-message scrolling log as tactical guidance like "On station. Press Space to lasso." The codex message can push critical guidance off-screen.

**After**: Codex unlock notifications no longer go through comms. Instead, they appear in a new "New Tech" section within the Discovery Pane (bottom-left). The term "Codex" is replaced with "New Tech" in all player-facing text. Comms becomes a clean tactical/strategic channel.

---

## 2. Change 1: Defuse `awareness_beauty`

### 2.1 Rationale

`awareness_beauty` is the only skill in the 34-skill catalog with both `triggerEvent: null` and `hudGroup: null`. It contributes nothing to game mechanics. Its sole effect is a misleading notification. Removing it simplifies the catalog to 33 real skills.

### 2.2 Code Changes

#### A. Remove catalog entry  
**File**: [`js/core/Constants.js`](js/core/Constants.js:973)  
**Line 973**: Delete the `awareness_beauty` catalog entry entirely.

```js
// DELETE this line:
{ id: 'awareness_beauty', label: 'Beauty', key: null, tier: 1, category: 'awareness', hudGroup: null, prereqs: [], prereqType: 'none', noReminder: true, triggerEvent: null },
```

**Note**: The `awareness` category has 4 other skills (`awareness_mouse_look` at [`Constants.js:981`](js/core/Constants.js:981), `awareness_kessler` at [`Constants.js:998`](js/core/Constants.js:998), `awareness_weather` at [`Constants.js:999`](js/core/Constants.js:999), `mastery_ca_dodge` at [`Constants.js:1006`](js/core/Constants.js:1006)) — so the category and its [`CATEGORY_META`](js/ui/hud/SkillsPane.js:32) entry must stay. Only `awareness_beauty` is removed.

#### B. Remove beauty timer constant  
**File**: [`js/core/Constants.js`](js/core/Constants.js:942)  
**Line 942**: Delete `BEAUTY_TIMER: 5`.

```js
// DELETE:
BEAUTY_TIMER: 5,                 // seconds — auto beauty discovery in ORBITAL_VIEW
```

#### C. Remove timer setup in SkillsSystem  
**File**: [`js/systems/SkillsSystem.js`](js/systems/SkillsSystem.js:72)  
**Line 72**: Remove `this._beautyTimer = null;` from constructor.  
**Lines 296–307**: Delete the entire "Beauty auto-trigger on ORBITAL_VIEW" listener block.

```js
// DELETE this entire block (lines 296-307):
// ── Beauty auto-trigger on ORBITAL_VIEW ───────────────────────────
this._unsubs.push(eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
    if (to === GameStates.ORBITAL_VIEW && !this.isDiscovered('awareness_beauty')) {
        if (this._beautyTimer !== null) clearTimeout(this._beautyTimer);
        this._beautyTimer = setTimeout(() => {
            this._beautyTimer = null;
            if (!this.isDiscovered('awareness_beauty')) {
                this._onSkillTriggered('awareness_beauty');
            }
        }, Constants.SKILLS.BEAUTY_TIMER * 1000);
    }
}));
```

#### D. Remove beauty timer cleanup from `reset()` and `dispose()`
**File**: [`js/systems/SkillsSystem.js`](js/systems/SkillsSystem.js)
**Lines 196–200** ([`reset()`](js/systems/SkillsSystem.js:196)): Delete the `clearTimeout(this._beautyTimer)` / `this._beautyTimer = null` block.
**Lines 230–234** ([`dispose()`](js/systems/SkillsSystem.js:230)): Delete the identical cleanup block.

#### E. Awareness category — no further action needed
The `awareness` category retains 4 other skills (`awareness_mouse_look`, `awareness_kessler`, `awareness_weather`, `mastery_ca_dodge`). The [`CATEGORY_META.awareness`](js/ui/hud/SkillsPane.js:32) entry stays.

### 2.3 Verification

- Start game → enter ORBITAL_VIEW → wait 10+ seconds → no skill notification appears
- Open expanded skills view (I key) → no "Beauty" skill listed
- Score bar still visible immediately (unchanged — it was never gated by beauty)

---

## 3. Change 2: Relocate Skills Pane to Bottom-Left

### 3.1 Layout Reasoning

Current bottom-left is empty — the left column's status panels (propulsion, energy, crossbow) end well above it. Moving SkillsPane there:
- Eliminates right-side overcrowding
- Creates a "discovery zone" (bottom-left) vs "operations zone" (right side)
- Provides room for the New Tech section (Change 3) adjacent to skills

### 3.2 Positioning Change

**File**: [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js:241)

```css
/* BEFORE (line 243-244): */
bottom: 180px;
right: 10px;

/* AFTER: */
bottom: 180px;
left: 10px;
```

The `bottom: 180px` matches the left column's natural lower extent and clears the warning strip at `bottom: 170px` ([`HUD.js:181`](js/ui/HUD.js:181)). Both occupy the same vertical band but the skills pane is flush-left while warnings are centered — no overlap for the 260px-wide pane on screens ≥920px wide.

### 3.3 Animation Direction

All slide/fade animations currently go right-to-left (slide in from right edge). Reverse them to left-to-right.

**File**: [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js)

#### A. Compact pane show animation (lines 149-154)
```js
// BEFORE:
p.style.transform = 'translateX(20px)';   // start: shifted right
// ...
p.style.transform = 'translateX(0)';       // end: in position

// AFTER:
p.style.transform = 'translateX(-20px)';  // start: shifted left
// ...
p.style.transform = 'translateX(0)';      // end: in position (unchanged)
```

#### B. Compact pane hide/fade animation (line 984)
```js
// BEFORE:
p.style.transform = 'translateX(10px)';    // fade out right

// AFTER:
p.style.transform = 'translateX(-10px)';   // fade out left
```

#### C. Entry slide-in keyframes (lines 322-325)
```css
/* BEFORE: */
@keyframes spSlideIn {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
}

/* AFTER: */
@keyframes spSlideIn {
    from { opacity: 0; transform: translateX(-20px); }
    to   { opacity: 1; transform: translateX(0); }
}
```

#### D. Edge glow effect (lines 336-339)
```css
/* BEFORE: */
.sp-edge-glow {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 40px;
    /* gradient goes to left */
}

/* AFTER: */
.sp-edge-glow {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 40px;
}
```

And update the gradient direction in [`_showEdgeGlow()`](js/ui/hud/SkillsPane.js:958):
```js
// BEFORE:
glow.style.background = `linear-gradient(to left, ${tierColor}50, transparent)`;

// AFTER:
glow.style.background = `linear-gradient(to right, ${tierColor}50, transparent)`;
```

### 3.4 Z-Index Considerations

The SkillsPane uses `z-index: 200` (via `position: fixed`). The warning strip in [`HUD.js`](js/ui/HUD.js:179) is inside `#hud-overlay` (z-index varies). Since both are `position: fixed` and the skills pane is at `bottom: 180px` while warnings are at `bottom: 170px`, they're vertically adjacent but shouldn't overlap. If edge cases arise on narrow viewports, the warning strip takes visual priority (it's transient and critical). Skills pane `z-index: 200` should be confirmed ≤ warning strip's effective z-index, or the skills pane should temporarily dodge when warnings are active.

**Recommendation**: No z-index change needed. Monitor during QA on viewport widths < 920px.

### 3.5 Verification

- Discover a skill → pane slides in from the **left** edge
- Auto-hide → pane fades out toward the **left**
- Pane positioned at bottom-left, above warning strip
- No overlap with left-column status panels (propulsion/energy/crossbow)
- Edge glow flashes on left edge

---

## 4. Change 3: "New Tech" Pane — Unified Discovery Pane

### 4.1 Design Decision: Combined Pane ✅

**Decision**: Combine Skills and New Tech into a single **"Discovery Pane"** rather than two separate panes.

**Rationale**:
- One location for all progression feedback reduces cognitive load
- Skills = "controls you've learned", Tech = "knowledge you've discovered" — both are player rewards
- Two tiny adjacent panes in bottom-left would feel cluttered
- A single pane with two sections (or tabs) is cleaner

### 4.2 Unified Discovery Pane Architecture

The existing SkillsPane (1,231 LOC) becomes the **Discovery Pane** with two sections:

```
┌─────────────────────────┐
│ 📡 DISCOVERY        [I] │  ← header (renamed from "NEW SKILLS")
├─────────────────────────┤
│ ⚡ NEW TECH              │  ← tech section (0-2 recent unlocks)
│  🔩 Kessler Syndrome     │
│  📡 Laser Ranging        │
├─────────────────────────┤
│ 🎯 SKILLS                │  ← skills section (existing compact view)
│  ● Quick Scan [S]        │
│  ● Lasso [Space]         │
│  ○ Try: Orbit Raise [W]  │
└─────────────────────────┘
```

### 4.3 Renaming Strategy

All **player-facing** text changes from "Codex" → "New Tech" / "Tech Library":

| Context | Before | After | File:Line |
|---------|--------|-------|-----------|
| Comms message | `"CODEX: New entry — Kessler Syndrome."` | *(removed from comms entirely)* | [`CodexSystem.js:1504`](js/systems/CodexSystem.js:1504) |
| L key overlay title | `"📖 CODEX LIBRARY"` | `"📖 TECH LIBRARY"` | [`CodexViewerUI.js:102`](js/ui/CodexViewerUI.js:102) |
| Skill label | `label: 'Codex'` (manage_codex skill) | `label: 'Tech Library'` | [`Constants.js:990`](js/core/Constants.js:990) |
| Compact pane header | `'▸ New Skills'` | `'▸ Discovery'` | [`SkillsPane.js:501`](js/ui/hud/SkillsPane.js:501) |
| L key hint text | — | `"Press L for full Tech Library"` | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) (new) |
| Expanded view (I key) | `"Press I to close"` | `"Press I to close"` (unchanged) | — |
| New compact notification | *(none)* | `"⚡ NEW TECH: Kessler Syndrome"` | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) (new) |

All **internal** code names stay unchanged: `CodexSystem`, `CodexViewerUI`, `CODEX_UNLOCKED` event, DOM IDs (`codex-overlay`, `codex-panel`, etc.), `console.log` prefixes. Only strings shown to the player are renamed.

### 4.4 New Tech Section in Discovery Pane

#### A. Listen for `CODEX_UNLOCKED` in SkillsPane

**File**: [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js:582)

Add to [`_setupListeners()`](js/ui/hud/SkillsPane.js:582):
```js
this._unsubs.push(
    eventBus.on(Events.CODEX_UNLOCKED, (d) => this._onTechUnlocked(d))
);
```

#### B. New handler: `_onTechUnlocked(data)`

```js
/**
 * Handle CODEX_UNLOCKED: add to recent tech list, render tech section, auto-show pane.
 * @param {{ id: string, title: string, shortText: string, icon: string, category: string }} data
 * @private
 */
_onTechUnlocked(data) {
    this._recentTech.push({
        id: data.id,
        title: data.title,
        icon: data.icon,
        time: Date.now(),
    });
    // Keep only 2 most recent
    if (this._recentTech.length > 2) this._recentTech.shift();
    
    this._renderCompact();  // re-render with tech section
    this.show();            // slide in / reset auto-hide timer
}
```

#### C. New state: `_recentTech` array

Add to constructor:
```js
/** @type {Array<{id: string, title: string, icon: string, time: number}>} */
this._recentTech = [];
```

#### D. Render tech section in `_renderCompact()`

In the existing [`_renderCompact()`](js/ui/hud/SkillsPane.js:716) method, prepend a "NEW TECH" section before the skills list when `this._recentTech.length > 0`:

```html
<div class="sp-tech-section">
  <div class="sp-section-label">⚡ NEW TECH</div>
  <div class="sp-tech-entry">
    <span class="sp-tech-icon">🔩</span>
    <span class="sp-tech-title">Kessler Syndrome</span>
  </div>
</div>
<div class="sp-divider"></div>
<!-- existing skills entries follow -->
```

Tech entries should have:
- Same visual style as skill entries but with a distinct accent color (amber `#ffaa00` instead of the green `#00ff88` used for skills)
- Click/hover on a tech entry → hint "Press L for details"
- Auto-fade tech entries after 30 seconds (they're less actionable than skills)

#### E. Rename compact pane header

**File**: [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js:501)

In [`_buildCompactPane()`](js/ui/hud/SkillsPane.js:493), line 501 currently reads:
```js
title.textContent = '▸ New Skills';
```
Change to:
```js
title.textContent = '▸ Discovery';
```

The `[I]` hint in the header should remain (opens expanded skills view). Add `[L]` if tech entries are present (opens tech library).

#### F. Expanded view (I key) — no tech content

The expanded overlay (I key) remains skills-only. It already has its own full layout with categories and tiers. Tech entries have their own dedicated viewer via L key. The I-key header can add a small hint: "Tech Library: press L".

### 4.5 Rename CodexViewerUI Labels

**File**: [`js/ui/CodexViewerUI.js`](js/ui/CodexViewerUI.js)

#### A. Overlay title
**Line 102** of [`CodexViewerUI.js`](js/ui/CodexViewerUI.js:102) currently reads:
```html
<span style="...">📖 CODEX LIBRARY</span>
```
Change to:
```html
<span style="...">📖 TECH LIBRARY</span>
```

#### B. Category sidebar labels — keep as-is
The category names (Orbital Mechanics, Propulsion, etc.) are already clear and technology-themed. No renaming needed.

#### C. Header/footer hints
Any reference to "Codex" in player-visible hint text → "Tech Library".

### 4.6 Styling for Tech Entries

Add to [`_injectStyles()`](js/ui/hud/SkillsPane.js:235):

```css
.sp-tech-section {
    margin-bottom: 6px;
}
.sp-section-label {
    font-size: 9px;
    letter-spacing: 2px;
    color: #ffaa00;
    opacity: 0.7;
    margin-bottom: 3px;
}
.sp-tech-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    font-size: 11px;
    color: #ffcc44;
    border-left: 2px solid #ffaa0050;
    margin-bottom: 2px;
}
.sp-tech-icon {
    font-size: 12px;
}
.sp-tech-title {
    flex: 1;
}
.sp-skills-label {
    font-size: 9px;
    letter-spacing: 2px;
    color: #00ff88;
    opacity: 0.7;
    margin-bottom: 3px;
}
.sp-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 6px 0;
}
```

### 4.7 Verification

- Unlock a codex entry → Discovery Pane slides in from left with "⚡ NEW TECH: [title]" in amber
- Discover a skill → same pane shows skill below tech section in green
- Both can appear simultaneously in the pane
- Press L → full Tech Library overlay opens (renamed from "Codex")
- Press I → expanded skills view opens (unchanged)
- No codex messages appear in comms log

---

## 5. Change 4: Focus Comms on Tactical/Strategic Info

### 5.1 Remove Codex Messages from Comms

**File**: [`js/systems/CodexSystem.js`](js/systems/CodexSystem.js:1500)  
**Lines 1500–1505**: Delete the `COMMS_MESSAGE` emission entirely.

```js
// DELETE these lines (1500-1505):
// Emit comms message (LOW priority from CODEX source)
eventBus.emit(Events.COMMS_MESSAGE, {
  priority: 'LOW',
  source: 'CODEX',
  text: `CODEX: New entry — ${entry.title}. ${entry.shortText}`,
});
```

The `CODEX_UNLOCKED` event emission at [lines 1492–1498](js/systems/CodexSystem.js:1492) stays — it's how the Discovery Pane learns about new tech.

### 5.2 Comms Message Audit

Current message sources flowing through [`CommsSystem.addMessage()`](js/systems/CommsSystem.js:551):

| Source | Priority | Type | Verdict |
|--------|----------|------|---------|
| `HOUSTON` | INFO | Flavor ("Orbital environment looking good") | **Keep but reduce frequency** |
| `HOUSTON` | INFO | Tactical ("Achievement: X debris cleared!") | **Keep** |
| `MISSION CTRL` | INFO | Flavor + tactical | **Keep** |
| `GROUND STN` | INFO | Flavor | **Keep but reduce frequency** |
| `SPACECRAFT` | WARNING | Resource warnings (low xenon, battery) | **Keep — critical** |
| `NOAA SWPC` | WARNING/CRITICAL | Weather alerts | **Keep — critical** |
| `SDA` | CRITICAL | Collision events | **Keep — critical** |
| `NORAD` | WARNING | Conjunction risk | **Keep — critical** |
| `18 SDS` | WARNING | Debris cloud expansion | **Keep** |
| `LAUNCH ALERT` | INFO/WARNING | Launch corridor warnings | **Keep** |
| `LeoLabs` | INFO | Characterization data | **Keep** |
| `ClearSpace` | WARNING | Contract updates | **Keep** |
| `ESOC` | INFO | Orbital decay notices | **Keep** |
| `CODEX` | LOW | Codex unlocks | **REMOVE** (Change 3 handles this) |

### 5.3 Flavor Message Frequency Reduction

**File**: [`js/systems/CommsSystem.js`](js/systems/CommsSystem.js:169)

Current flavor messages ([`FLAVOR_MESSAGES`](js/systems/CommsSystem.js:169), 15 entries) fire every 30–120 seconds. **Recommendation**: Increase minimum interval to 60–180 seconds. This keeps the radio feeling alive without drowning out tactical messages.

Additionally, review [`_sendFlavorMessage()`](js/systems/CommsSystem.js:472) — if it's called on a fixed timer, adjust the timer constants. These timers are likely in the `update()` method of CommsSystem.

### 5.4 Optional: Houston Tactical Priority Boost

Currently Houston tactical messages (capture confirmations, milestones) use `CommsPriority.INFO` — same as flavor. Consider:
- Boost capture/milestone messages to a custom `CommsPriority.TACTICAL` (displayed with a brighter color, e.g., bold mint green)
- Or simply ensure tactical messages have a longer display persistence than flavor

**Recommendation**: Defer this to a follow-up. Removing codex noise and reducing flavor frequency is sufficient for Phase 1.

### 5.5 Verification

- Play for 5 minutes → no "CODEX: New entry..." messages in comms log
- Comms log shows: Houston tactical, spacecraft warnings, weather alerts, launch alerts, flavor (less frequent)
- Flavor messages feel appropriately spaced (not dominating the log)

---

## 6. Revised HUD Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ [Weather Badges]             SCORE BAR (top center)     [NavSphere]│
│ LEFT COLUMN                                        RIGHT COLUMN    │
│ (top:10,left:10,w:260px)    (gameplay area)       (top:296,right:0)│
│ ┌──────────────┐                                   ┌────────────┐  │
│ │🚀 PROPULSION │ fuel-group                        │ WIREFRAME  │  │
│ │ ΔV,Xe,Gas,Bat│                                   │ target-    │  │
│ │ Cargo,Forge  │                                   │ detail grp │  │
│ ├──────────────┤                                   ├────────────┤  │
│ │ ⚡ ENERGY    │ power-group                       │ TARGET     │  │
│ ├──────────────┤                                   │ LIST       │  │
│ │🏹 CROSSBOW  │ arms-group                        │ target-    │  │
│ └──────────────┘                                   │ list grp   │  │
│                                                    └────────────┘  │
│  ┌─────────────────┐                                               │
│  │ 📡 DISCOVERY [I]│       [Warning Strip]                         │
│  │ ⚡ NEW TECH     │       bot:170 center          [Comms Panel]   │
│  │  🔩 Kessler..   │                               bot:10,right:10 │
│  │ 🎯 SKILLS       │                               w:260,h:120max  │
│  │  ● Scan [S]     │                                               │
│  │  ○ Try: Lasso   │                                               │
│  └─────────────────┘                                               │
│   bot:180,left:10                                                  │
│   w:260,z:200                                                      │
└────────────────────────────────────────────────────────────────────┘
```

### Key Spatial Relationships

| Element | Position | Notes |
|---------|----------|-------|
| Left column (status) | `top: 10px; left: 10px; width: 260px` | Unchanged |
| **Discovery Pane** | `bottom: 180px; left: 10px; width: 260px` | **Moved from right** |
| Warning strip | `bottom: 170px; left: 50%; transform: translateX(-50%)` | Unchanged, horizontally centered |
| Comms panel | `bottom: 10px; right: 10px; width: 260px` | Unchanged position, cleaner content |
| Right column (targets) | `top: 296px; right: 0` | Unchanged, **no longer crowded** |

### What Left Bottom-Right

The Skills Pane no longer occupies `bottom: 180px; right: 10px`. That space is now empty — providing breathing room for the right column. The right side retains only the target panels (wireframe + list) and comms panel, which is a much more manageable stack.

---

## 7. Implementation Order

### Phase 1: Remove Beauty (Low Risk, No Dependencies)

| Step | Task | File(s) |
|------|------|---------|
| 1.1 | Delete `awareness_beauty` from CATALOG | [`Constants.js`](js/core/Constants.js:973) |
| 1.2 | Delete `BEAUTY_TIMER` constant | [`Constants.js`](js/core/Constants.js:942) |
| 1.3 | Remove beauty timer logic from constructor + `_setupListeners()` | [`SkillsSystem.js`](js/systems/SkillsSystem.js:72) |
| 1.4 | Remove beauty timer cleanup from `reset()`/`dispose()` | [`SkillsSystem.js`](js/systems/SkillsSystem.js) |
| 1.5 | Verify: `awareness` category still has 4 other skills — no removal needed | [`Constants.js`](js/core/Constants.js) |
| 1.6 | Verify: no runtime errors, score bar still visible | Manual QA |

**Risk**: Very low. Removing one unused skill entry and its timer. No other code depends on `awareness_beauty`.

---

### Phase 2: Relocate Skills Pane (Low-Medium Risk)

| Step | Task | File(s) |
|------|------|---------|
| 2.1 | Change CSS: `right: 10px` → `left: 10px` | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:244) |
| 2.2 | Reverse slide animations (translateX signs) | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:150) |
| 2.3 | Reverse fade-out animation | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:984) |
| 2.4 | Reverse entry slide-in keyframe | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:322) |
| 2.5 | Move edge glow from right → left | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:338) |
| 2.6 | Update glow gradient direction | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:958) |
| 2.7 | Visual QA: check overlap with left column, warning strip | Manual QA |

**Risk**: Low-medium. Pure CSS/animation changes. Risk of visual overlap on narrow viewports.

**Dependency**: Phase 1 should complete first (avoids testing a beauty notification that will be removed). Not a hard dependency.

---

### Phase 3: New Tech in Discovery Pane (Medium Risk, Largest Change)

| Step | Task | File(s) |
|------|------|---------|
| 3.1 | Add `_recentTech` array to SkillsPane constructor | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:55) |
| 3.2 | Subscribe to `CODEX_UNLOCKED` in `_setupListeners()` | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:582) |
| 3.3 | Implement `_onTechUnlocked()` handler | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) |
| 3.4 | Add tech section rendering in `_renderCompact()` | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) |
| 3.5 | Add CSS for `.sp-tech-section`, `.sp-tech-entry`, etc. | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:235) |
| 3.6 | Rename compact header text to "DISCOVERY" | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) |
| 3.7 | Rename CodexViewerUI title: `"📖 CODEX LIBRARY"` → `"📖 TECH LIBRARY"` | [`CodexViewerUI.js:102`](js/ui/CodexViewerUI.js:102) |
| 3.8 | Rename `manage_codex` skill label: `'Codex'` → `'Tech Library'` | [`Constants.js:990`](js/core/Constants.js:990) |
| 3.9 | Import `Events` properly if not already imported | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:17) (already imported) |
| 3.10 | QA: unlock codex entry → appears in Discovery Pane, not in comms | Manual QA |

**Risk**: Medium. Adding new rendering logic to a 1,231-line UI file. The `_renderCompact()` method is the most complex touchpoint.

**Dependency**: Phase 2 must complete first (pane must be in correct position before adding new content).

---

### Phase 4: Clean Comms (Low Risk)

| Step | Task | File(s) |
|------|------|---------|
| 4.1 | Remove `COMMS_MESSAGE` emission from `_performUnlock()` | [`CodexSystem.js`](js/systems/CodexSystem.js:1500) |
| 4.2 | (Optional) Increase flavor message interval | [`CommsSystem.js`](js/systems/CommsSystem.js) |
| 4.3 | QA: no codex messages in comms, tactical messages visible longer | Manual QA |

**Risk**: Very low. Deleting 5 lines from CodexSystem. Flavor interval change is optional.

**Dependency**: Phase 3 must be working first (so codex notifications have a home before removing them from comms).

---

## 8. Files Affected

### Primary Changes

| File | LOC | Scope | Phase |
|------|-----|-------|-------|
| [`js/core/Constants.js`](js/core/Constants.js) | ~3 lines modified | Remove beauty entry + timer constant (Phase 1); rename `manage_codex` label (Phase 3) | 1, 3 |
| [`js/systems/SkillsSystem.js`](js/systems/SkillsSystem.js) | ~15 lines deleted | Remove beauty timer setup/cleanup | 1 |
| [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js) | ~80 lines modified/added | Relocate positioning, reverse animations, add tech section, rename header | 2, 3 |
| [`js/systems/CodexSystem.js`](js/systems/CodexSystem.js) | ~5 lines deleted | Remove COMMS_MESSAGE emission | 4 |
| [`js/ui/CodexViewerUI.js`](js/ui/CodexViewerUI.js) | ~5 lines modified | Rename "Codex"/"Library" → "Tech Library" in DOM strings | 3 |

### Secondary Changes (verify/audit)

| File | Scope | Phase |
|------|-------|-------|
| [`js/systems/CommsSystem.js`](js/systems/CommsSystem.js) | Optional: adjust flavor message interval | 4 |
| [`js/ui/HUD.js`](js/ui/HUD.js) | Verify score-group still works without beauty — already unconditional at [line 434](js/ui/HUD.js:434) | 1 |
| [`js/main.js`](js/main.js) | No changes needed (CodexViewerUI instantiation unchanged) | — |
| [`js/systems/InputManager.js`](js/systems/InputManager.js) | No player-facing "Codex" strings found — no changes needed | — |

### No Changes Needed

| File | Reason |
|------|--------|
| [`js/core/Events.js`](js/core/Events.js) | `CODEX_UNLOCKED` event stays (internal name) |
| [`js/core/EventBus.js`](js/core/EventBus.js) | Infrastructure, no changes |
| [`js/ui/hud/CommsPanel.js`](js/ui/hud/CommsPanel.js) | Comms panel position unchanged; content cleaned upstream |
| [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js) | Codex badge stub unchanged for now |
| [`js/ui/hud/TargetPanel.js`](js/ui/hud/TargetPanel.js) | No changes |

---

## Summary

Four changes, executed in dependency order:

1. **Phase 1** — Delete `awareness_beauty` (trivial, ~20 lines removed)
2. **Phase 2** — Move SkillsPane to bottom-left (CSS + animation, ~15 lines changed)
3. **Phase 3** — Add "New Tech" section to Discovery Pane (largest: ~80 lines new/modified)
4. **Phase 4** — Remove codex messages from comms (trivial, ~5 lines removed)

**Total footprint**: ~5 files modified, ~100 lines added, ~40 lines removed. Zero game mechanics changes. Zero new files required.

---

## Phase 5: Progression-Aware Persistence

> **Status**: ✅ Implemented (2026-04-17)
> **Scope**: Single-file iteration — [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js)
> **Risk**: Low — behavior is additive; VETERAN path preserves Phase 3 toast semantics.

### Problem

After Phase 3 landed, the Discovery Pane auto-hid after 4s (8s for the first 3 discoveries) for **every** player. This made sense for advanced players — the pane became a transient toast that didn't crowd the HUD. But **new players** need the pane as a **constant reference**: a visible list of what they've learned and a nudge toward what's next. Losing the pane before the player had internalized the skill tree undercut the "Discovery Pane IS the reward" philosophy from the Session 24 architecture.

### Design: Three Persistence Levels

A single progression axis — the count of skills in any state beyond `'undiscovered'` — drives three distinct persistence behaviors:

| Level | Threshold | Idle opacity | Auto-hide (standard / first-3) | Renders when idle? |
|-------|-----------|--------------|--------------------------------|--------------------|
| **NOVICE**     | `< 5`   discovered | **0.85** | **none** (pane is always on-screen)        | ✅ Yes |
| **APPRENTICE** | `5–14`  discovered | **0.45** | **15000 ms** / **20000 ms** → fade to 0.45 | ✅ Yes |
| **VETERAN**    | `≥ 15`  discovered | **0.00** | **4000 ms** / **8000 ms** → fade to hidden | ❌ No  |

The three levels create a natural UX evolution: training-wheels → ambient helper → transient toast.

### Behavior Rules

1. **On ANY skill/tech discovery**, the pane immediately brightens to 100% opacity. If currently hidden (VETERAN idle only), it slides in from the left. The auto-hide timer is reset to the current level's duration.
2. **Idle state differs per level.** NOVICE stays at 0.85 (readable, highlights next suggestions). APPRENTICE stays at 0.45 (dimmed but readable — ambient helper). VETERAN fully hides (`display: none`).
3. **Level-up is implicit.** When a player crosses a threshold (e.g., their 5th skill bumps NOVICE → APPRENTICE), the new behavior takes effect on the next `show()`/`_fadeOut()` call. A single `console.log('[SkillsPane] Level advanced:', …)` marks the transition for dev visibility — no in-game celebration.
4. **Expanded view (`I`) and Tech Library (`L`)** behave identically at all levels.
5. **Save restore aware.** `SKILLS_LOADED` recomputes the level from restored `_states` and calls `_applyInitialDisplay()` so a loaded save drops the player into the right mode instantly.

### Implementation Notes

- New `EXPERIENCE_LEVELS` constant table at the top of [`SkillsPane.js`](js/ui/hud/SkillsPane.js) is the single source of truth (thresholds, idle opacities, autohide windows). No magic numbers in methods.
- `_getExperienceLevel()` derives the level from `_getDiscoveredSkillCount()` (counts states `≠ 'undiscovered'` in the local `_states` Map).
- `show()` no longer plays the slide-in animation when the pane is already rendered (NOVICE/APPRENTICE idle); it just transitions opacity back to 100%.
- `_fadeOut()` branches on level: NOVICE/APPRENTICE call the new `_fadeToIdle(opacity)` helper (300 ms transition, `display:block` retained); VETERAN keeps the classic fade-and-hide path.
- Constructor schedules `_applyInitialDisplay()` 500 ms post-construct so the initial fade-in doesn't compete with briefing/menu transitions.
- New `reset()` method clears state and re-applies NOVICE behavior (for new-game flow).

### Files Modified

| File | Changes |
|------|---------|
| [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js) | ~170 LOC added — `EXPERIENCE_LEVELS` table, `_getExperienceLevel()`, `_getDiscoveredSkillCount()`, `_fadeToIdle()`, `_applyInitialDisplay()`, `_checkLevelTransition()`, `reset()`; level-aware `show()` / `_fadeOut()` / `_getShowDuration()` |
| [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) | Added §B.9 "Progression-Aware Persistence" subsection |
| [`HANDOFF.md`](HANDOFF.md) | Session 27 summary |

**Tests:** 353 / 353 passing (no new tests — DOM-dependent behavior not testable in Node harness).
