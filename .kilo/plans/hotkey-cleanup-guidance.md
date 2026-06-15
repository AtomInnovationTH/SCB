# Hotkey Cleanup & Guidance Correctness

## Goal
Analyze, clean up, organize, streamline, and verify the keyboard hotkey system.
Make the live bindings, the in-game guidance text, the help pane, and the docs
all agree. Fix functional drift (keys that name nothing, panels that promise the
wrong key), free a redundant key, and close the gap in the automated drift guard
so this class of regression fails loudly next time.

## Background — what is actually true today (verified)

The live bindings live in `js/systems/InputManager.js` (`_handleKeyDown` +
held-key `processInput`). The **single source of truth** is the in-game help
pane `HotkeyOverlay.HOTKEY_GROUPS` (`js/ui/HotkeyOverlay.js`). These two **agree**
with each other and with the README "Full Reference" table and ARCHITECTURE §6.

The user's example is **correct as-built**:
- bare **R** → reel-in (ARM_PILOT: reel the piloted daughter from any live state;
  Mother: recall the closest deployed daughter; else abort autopilot; else a
  "nothing to reel" comms — never silent). `InputManager.js:670-758`.
- **Shift+R** → recall ALL deployed daughters, with an honest count.
This is covered by tests in `js/test/test-InputManager-Hotkeys.js`.

So the core binding layer is healthy. The problems are all **drift in guidance /
labels**, two **orphaned features**, one **redundant key**, and a **coverage gap**
in the drift-guard test.

## Findings (the work)

### A. Stale in-game guidance naming the wrong key (functional drift)
1. `js/ui/ShopScreen.js:43` — MPD Thruster upgrade description:
   "…Press **[M]** to arm burst mode. Requires lithium." `M` is now the Debris
   Map and burst mode has no key (see B1). User direction: *"it is a thruster,
   why does it need a hotkey? It improves thrust."* → reword to describe a thrust
   improvement, drop the hotkey claim.
2. `js/ui/OrbitMFD.js:326,338-341` — header draws "**[M]** Toggle"; `M` no longer
   toggles the Orbit MFD (it opens the Debris Map) and there is no toggle key.
   → remove the stale "[M] Toggle" hint.
3. `js/ui/hud/StatusPanel.js:385` (static markup) and `:925`
   (`el.textContent = `[T] ${fuelData.name}…``) — fuel indicator prefixed "**[T]**".
   `T` is now "Target debris"; fuel cannot be cycled by key (see B2). User
   direction: *"Just fix the label."* → drop the `[T]` prefix; show the fuel
   name/Isp only.
4. `js/ui/hud/NetInventoryPanel.js:407` — tooltip "Press B for shop or **5** to
   forge." `5` is now "City names"; Forge is **F**. → "Press B for shop or F to
   forge."

### B. Orphaned features (no key reaches them)
1. **MPD burst / "Ludicrous mode"** — `PlayerSatellite.toggleMPDArmed()`
   (`PlayerSatellite.js:3266`) has **no caller**; `InputManager`'s `MPD_BURST`
   control-mode branch (`:1824-1827`) keys off `isMPDArmed`, which is never true.
   Per user direction the MPD is a passive thrust upgrade, not a hotkeyed burst.
   - Scope-safe approach (this pass): **do not rip out** the burst subsystem
     (heat/cooldown/lithium/audio/codex/StatusPanel rows are interwoven and
     out of scope). Fix the **shop guidance** (A1) so nothing promises a key,
     and remove the **dead `MPD_BURST` branch** in `InputManager.processInput`
     control-mode calc (`:1824-1827`) since it can never fire (small, safe
     streamlining). Leave a one-line note in the drift register that the burst
     subsystem is dormant/unreachable, flagged for a future gameplay decision.
2. **FEEP fuel cycle** — `Events.FUEL_CYCLE` (`Events.js:278`, comment "player
   pressed T") is listened by `ResourceSystem.cycleFuel` (`ResourceSystem.js:573`)
   but **never emitted**. User direction: *"Just fix the label."* → only fix the
   StatusPanel `[T]` label (A3); leave `cycleFuel`/the event in place for future
   use. Update the stale `// player pressed T` comment to note it is currently
   un-emitted.

### C. Redundancy — free the C key
- Bare **C** (`InputManager.js:935-942`) and **7** (`:1189-1196`) emit the
  identical `COMMS_FOCUS` + `COMMS_OPENED`. User direction: *"free the C key for
  something else."*
  - Remove the bare-`C` `case 'KeyC'` handler so **C is unbound/available**;
    **7 remains** the comms key (keeps skills-discovery `COMMS_OPENED` reachable).
  - Clean the now-moot `KeyC` pass-through in the Debris-Map intercept
    (`InputManager.js:497`) and the obsolete `_handleKeyUp` C-tap comment
    (`:1324-1325`).
  - C is left intentionally unbound (joining the already-free `W`, `Y`, `O`,
    `,`). No new action is assigned now — noted as available for a future verb.

### D. "7 = Comms" wording is inaccurate (not a toggle / not a size cycle)
- `COMMS_FOCUS` → `CommsPanel._expandPane()` = a momentary **expand**, not a
  toggle and not a small/med/large size cycle.
  - `HotkeyOverlay.js:87` `'toggle: Comms'` → `'Expand comms'`.
  - README `:204` "Comms size (small/med/large)" → "Expand comms".
  - ARCHITECTURE §6 `:175` "Comms toggle" and `:198` "Comms size cycle" →
    "Comms expand".

### E. Docs drift
1. `README.md:18` ("Controls:" blurb) and `:152` ("Systems:") list **removed**
   bindings: `W` wide-scan, `T` cycle-tool, `F` focus-action, `P` arm-pilot,
   `O` NavSphere, `M` MPD/orbit, `5` Forge, `6` fuel cycle, `Shift+C` city labels.
   → rewrite to the current core verbs (or point at the Full Reference). The
   "Full Reference" block (`:169-216`) is already correct and stays.
2. `README.md:156-163` "Key Bindings — Command Cluster (WASD Redesigned)" table
   implies WASD thrust + `W` wide-scan still exist. WASD thrust is removed.
   → delete this stale table (the Full Reference + the note at `:218` supersede it).
3. `ARCHITECTURE.md:173` lists the Codex overlay as "Codex `L`" — it is **`I`**
   now (`L` is the de-spin laser). → fix to `I`.
4. Add a drift-register row in ARCHITECTURE §16 noting the MPD burst subsystem is
   dormant/unreachable (deferred gameplay decision) and that `C` is now free.

### F. Close the automated drift-guard gap
- `js/test/test-GuidanceHotkeyDrift.js` scans onboarding beats, teaching moments,
  mission-coach tables, arm-idle hints, and the skills catalog — but **not the UI
  panel strings**, which is exactly where A1-A4 hid. Also its `/\bpress 5\b/`
  pattern misses "5 to forge".
  - Add a new test block that scans the offending UI surfaces for stale-key
    promises. Low-risk approach: assert the specific corrected strings
    (ShopScreen MPD desc, OrbitMFD header, StatusPanel fuel label, NetInventory
    tooltip) no longer contain `[M]`/`[T]`/`5 to forge`/"arm burst mode".
  - Add a `/\bto forge\b/i` paired with a not-`F` check (or simply forbid
    `[5]`/"5 to forge") so the forge-key drift can't recur.

## Out of scope (explicitly not doing)
- No re-bind of MPD burst or FEEP fuel cycle to a key (user declined both).
- No removal of the MPD burst subsystem internals or `ResourceSystem.cycleFuel`
  (kept dormant for a future gameplay decision).
- No new action bound to the freed `C` key (left available).
- No change to the verified, working core bindings (R/Shift+R, deploy, scan, etc.).

## Implementation steps
1. **InputManager** (`js/systems/InputManager.js`)
   - Remove `case 'KeyC':` bare-comms handler (free C); update the `KeyC`
     pass-through in the Debris-Map intercept and the `_handleKeyUp` comment.
   - Remove the dead `MPD_BURST` branch in the `processInput` control-mode calc.
2. **UI guidance fixes**
   - `ShopScreen.js:43` MPD description → passive thrust wording, no hotkey.
   - `OrbitMFD.js` `_drawHeader` → remove the "[M] Toggle" hint.
   - `StatusPanel.js:385` + the `:925` template → drop `[T]` prefix.
   - `NetInventoryPanel.js:407` → "F to forge".
3. **Help pane wording** — `HotkeyOverlay.js:87` "Expand comms".
4. **Events comment** — `Events.js:278` note `FUEL_CYCLE` is currently un-emitted;
   (optional) `Events.js:453` `ORBIT_MFD_TOGGLE` comment "M key" is stale → note
   it is un-emitted.
5. **Docs** — README `:18`, `:152`, delete `:156-163` table, `:204` wording;
   ARCHITECTURE §6 `:173` Codex `I`, `:175`/`:198` "Comms expand", §16 drift rows.
6. **Tests** — extend `test-GuidanceHotkeyDrift.js` with the UI-panel scan +
   tighter forge pattern. Run the full suite (`./test.sh`) and confirm the
   existing hotkey tests still pass (no behavioral changes to bound keys).

## Verification
- `./test.sh` (or `node js/test/run-tests.js`) green, including the extended
  drift guard and `test-InputManager-Hotkeys.js`.
- Manual grep sanity: no remaining `[M] to arm`, `[M] Toggle`, `[T] ` fuel chip,
  or `5 to forge` in `js/`.
- Spot-check in browser: `?` help pane, shop MPD card, fuel indicator, net
  inventory tooltip, and that C now does nothing while 7 still expands comms.

## Open question for the user (non-blocking)
- The MPD "Ludicrous mode" burst subsystem (heat/cooldown/lithium, audio, codex
  entry, StatusPanel HEAT row) is now fully dormant. Long-term, do you want it
  (a) reworked into a passive thrust bonus and the burst internals removed, or
  (b) left dormant as-is? This plan leaves it dormant + flagged; happy to do the
  rework as a follow-up.
