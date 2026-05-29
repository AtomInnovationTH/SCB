# Capture-Flow UX Audit & Improvement Plan

**Scope** — daughter-arm capture loop from autopilot engage through dock-and-reload,
including failure paths (tether snap, net miss, target lost). The state machine in
[`ArmUnit.js`](js/entities/ArmUnit.js) was just made correct by the prior Debug
subtask; this audit identifies and orders the UX changes needed for the player to
*perceive* that correctness.

**Method** — full code trace of every `Events.COMMS_MESSAGE` / `Events.SHOW_NOTIFICATION` /
`AudioSystem` / `HUD` channel on the capture loop. Findings are mapped to existing
patterns; no new widgets are proposed for the priority-1 set.

---

## 0. Hidden live bugs uncovered by this audit

The deeper trace surfaced three pre-existing bugs that were not in the user's
original report but partially **explain** the report. They block — or rather,
multiply — the value of any new comms we add.

### 0.1 BUG-A (highest impact): sourceless `COMMS_MESSAGE` emits are silently dropped

The strict listener at [`CommsSystem.js:362-367`](js/systems/CommsSystem.js:362) requires
a `source`, `sender`, or `speaker` field:

```js
eventBus.on(Events.COMMS_MESSAGE, (data) => {
  if (!data || data._internal) return;
  const src = data.source || data.sender || data.speaker;
  if (!src || !data.text) return;  // ← drops payload
  ...
});
```

The HUD listener at [`HUD.js:615`](js/ui/HUD.js:615) only forwards to
[`CommsPanel.onMessage()`](js/ui/hud/CommsPanel.js:222), which **only** sets a flash
timer — it does not store the message. Rendering pulls from `CommsSystem.messages[]`.

**Net effect:** any `COMMS_MESSAGE` without a `source`/`sender`/`speaker` field
appears nowhere in the comms panel today.

**Audit of [`ArmUnit.js`](js/entities/ArmUnit.js):** 30+ comms emits have only
`text:` and `priority:`. Only 7 use `sender: this.id` ([:910](js/entities/ArmUnit.js:910),
[:924](js/entities/ArmUnit.js:924), [:949](js/entities/ArmUnit.js:949),
[:3732](js/entities/ArmUnit.js:3732), [:3738](js/entities/ArmUnit.js:3738),
[:3780](js/entities/ArmUnit.js:3780), [:3842](js/entities/ArmUnit.js:3842)). The
other 23+ — including all the lines the player *expects* to see during the capture
loop — are invisible.

**Representative invisible lines** the player should be seeing today but isn't:
- `${this.id}: Crossbow launch — target X` ([:798](js/entities/ArmUnit.js:798))
- `${this.id}: Deploying ${this.config.netSize}m net` ([:2828](js/entities/ArmUnit.js:2828))
- `${this.id}: Beginning final approach` ([:2598](js/entities/ArmUnit.js:2598))
- `${this.id}: Target secured! SMA cinch complete.` ([:3226](js/entities/ArmUnit.js:3226))
- `${this.id}: Reeling target back to core` ([:3429](js/entities/ArmUnit.js:3429))
- `${this.id}: Netting failed — holding standoff. Press F to retry.` ([:3362](js/entities/ArmUnit.js:3362))
- `${this.id}: Target lost during net flight — returning empty.` ([:3352](js/entities/ArmUnit.js:3352))
- `${this.id}: Insufficient fuel to return — expended` ([:1033](js/entities/ArmUnit.js:1033))
- `AUTOPILOT OFF — ${reason}` ([`AutopilotSystem.js:331`](js/systems/AutopilotSystem.js:331)) — also sourceless
- `✓ ON STATION — ready for capture` ([`AutopilotSystem.js:578`](js/systems/AutopilotSystem.js:578)) — also sourceless

This single bug explains a large part of the user's "what happened?" experience.
The state machine *did* announce itself — the announcements just never rendered.

**Recommended fix (one line, defensive default):**

In [`CommsSystem.js:366`](js/systems/CommsSystem.js:366) **and** in
[`addMessage()`](js/systems/CommsSystem.js:739):

```js
// Before: const src = data.source || data.sender || data.speaker;
//         if (!src || !data.text) return;
// After:  default to 'SYSTEM' rather than dropping
const src = data.source || data.sender || data.speaker || 'SYSTEM';
if (!data.text) return;
```

Or, slightly nicer, extract a leading `ARM-ID: ` prefix from `data.text` into
`source`:

```js
const m = !src && data.text ? data.text.match(/^([\w-]+):\s*(.*)$/) : null;
const effectiveSrc = src || (m ? m[1] : 'SYSTEM');
const effectiveText = m ? m[2] : data.text;
```

Either variant is < 6 LOC. It unlocks every existing capture-loop announcement
without touching ArmUnit.

### 0.2 BUG-B: `TETHER_SNAP` is not wired to its own audio

[`AudioSystem.playTetherSnap()`](js/systems/AudioSystem.js:889) is implemented
(155 Hz lateral whip + harmonic decay) but only fires on `ARM_DETACHED`
([`AudioSystem.js:223-226`](js/systems/AudioSystem.js:223)). The catastrophic
break path emits `Events.TETHER_SNAP` ([`ArmUnit.js:3544`](js/entities/ArmUnit.js:3544))
and has no audio binding. The sound is built; the listener is missing.

### 0.3 BUG-C: `TETHER_SNAP` is not wired to `COMMS_MESSAGE`

A grep across [`CommsSystem`](js/systems/CommsSystem.js) and
[`ArmUnit`](js/entities/ArmUnit.js) confirms zero `COMMS_MESSAGE` emit accompanies
`TETHER_SNAP`. The red radial flash from
[`HUD.showTetherSnapAlert()`](js/ui/HUD.js:1486) and the queued warning toast
fire, but the comms history shows nothing about what happened or what's
recoverable.

**Synergy:** because of BUG-A, even if we add a comms emit here it will be dropped
unless it has a `source`. Fixing BUG-A first prevents needing to remember `source:`
on every new emit (defensive default makes the codebase fault-tolerant).

---

## 1. Pattern inventory — reusable feedback channels

Before designing anything new, every reusable channel already in the codebase:

| Channel | Entry point | Notes |
|---|---|---|
| Comms line (text + priority sound) | [`Events.COMMS_MESSAGE`](js/core/Events.js:117) → [`CommsSystem.addMessage()`](js/systems/CommsSystem.js:739) | After BUG-A fix, the de-facto channel for the capture loop. Priority levels `info` / `warning` / `critical` map to distinct audio beeps via [`AudioSystem._playMessageSound()`](js/systems/AudioSystem.js:877). |
| Comms critical-flash | [`CommsPanel.onMessage()`](js/ui/hud/CommsPanel.js:222) sets `_commsFlashTimer = 3.0` | Free 3-second border flash for any `priority: 'critical'` comms. Use for TETHER_SNAP, fuel-depleted-detached, etc. |
| Channel routing | [`sourceToChannel()`](js/systems/CommsSystem.js:45) — `payload.channel` is honoured if present | Explicit `channel: 'CMD'` or `'ALERT'` puts the row on the right colour stripe in [`CommsPanel`](js/ui/hud/CommsPanel.js:56). |
| HOUSTON styling | `source: 'HOUSTON'` triggers mint colour + `HOUSTON▸` prefix at [`CommsPanel.js:438-443`](js/ui/hud/CommsPanel.js:438) | Reserve for ground-narrative lines; arm telemetry uses `source: 'Weaver-1'` etc. |
| Coalescing | [`shouldCoalesce()`](js/systems/CommsSystem.js:91) — 3+ same-channel within 2 s collapse to summary | **Risk** for the capture loop bursts; see §6 mitigation. |
| Bottom-center transient toast | [`Events.SHOW_NOTIFICATION`](js/core/Events.js:1) → [`HUD.showNotification()`](js/ui/HUD.js:1241) | Already used for autopilot disengage + camera labels. Single slot — overwrites. |
| Queued warning toast | [`HUD.showWarning()`](js/ui/HUD.js:816) → `_warningQueue[]`, 3-second display | Used by `TETHER_SNAP` (`showWarning(...'critical')`), low fuel, collision warnings. Different visual track from the comms panel. |
| Floating score popup | [`HUD.showScorePopup()`](js/ui/HUD.js:1202) | 1.6 s drift-upward. Fires on score delta. |
| Mastery / synergy popup | [`HUD._showMasteryToast()`](js/ui/HUD.js:1561), [`showSynergyPopup()`](js/ui/HUD.js:1256) | Reusable pattern for "FIRST CAPTURE" etc. — already gated to first N occurrences. |
| Salvage-style banner | [`HUD.showSalvageReveal()`](js/ui/HUD.js:1424) | Gold-bordered 3 s "important moment" pattern. |
| Red radial flash | [`HUD.showTetherSnapAlert()`](js/ui/HUD.js:1486) | Already mounted for TETHER_SNAP — visual is great, the rest of the alert chain is missing (see §0.2/§0.3). |
| Per-arm fleet card (live, 10 Hz) | [`StatusPanel._renderArmPanel()`](js/ui/hud/StatusPanel.js:1337) | Already shows state colour (REELING=cyan, DOCKING=blue, RELOADING=amber), tether tension bar, **RELOADING progress %**. **DOCKING has no progress bar** — visible gap to mirror. |
| Approach audio ladder | `ARM_APPROACH_PING` → [`AudioSystem.playApproachBeep()`](js/systems/AudioSystem.js:1810) | Distance-fraction proportional. Already fires during TRANSIT/APPROACH. Could be reused on DOCKING for a closing-distance beep. |
| Tether tension audio | `TETHER_TENSION` → [`AudioSystem.playTetherTension()`](js/systems/AudioSystem.js:1843) | Already plays as tether nears break. The snap itself needs binding (BUG-B). |
| Capture / dock / fail sounds | [`playCatchClamp()`](js/systems/AudioSystem.js:515), [`playCaptureSuccess()`](js/systems/AudioSystem.js:568), [`playDockClick()`](js/systems/AudioSystem.js:798), [`playFailBuzz()`](js/systems/AudioSystem.js:946) | All wired in [`AudioSystem._setupListeners()`](js/systems/AudioSystem.js:92). Strong sonic backbone already in place. |
| One-shot teaching overlay | [`TeachingSystem.MOMENTS`](js/systems/TeachingSystem.js:31) (17 today, localStorage-persisted) | Pattern fits "press [V] to follow daughter" and "first tether snap" overlays. |
| Camera view indicator | [`CameraSystem._showViewIndicator()`](js/systems/CameraSystem.js:1682) | Already routes via notification zone. Free for "📡 FOLLOWING WEAVER-2" follow-up. |
| Launch ceremony auto-camera | [`CameraSystem._updateLaunchCeremony()`](js/systems/CameraSystem.js:970) | 4 s OBSERVE→TETHER_FOLLOW→HANDOFF, ends in ARM_PILOT. Triggered **only on G-key deploy**, not number-key deploy — see §3.2. |

### 1.5 Channel routing matrix for new comms

| Source-string | CommsPanel stripe | Use for |
|---|---|---|
| `'Weaver-N'` / `'Spinner-N'` / `arm.id` | DEFAULT (green) | Daughter-arm telemetry (launch, SK, dock, reload, snap). |
| `'HOUSTON'` | mint, `HOUSTON▸` prefix | Ground-narrative ("Bounty posted…", "Welcome to ISTRAC…"). Reserve. |
| `'AUTOPILOT'` | CMD (cyan) | AP engage / disengage / arrived / phase. |
| `'SYSTEM'` | DEFAULT | Out-of-band ("Comms boot complete", crash fallbacks). |
| Explicit `channel: 'ALERT'` | red stripe | Tether snap, fuel depletion, collision evasion. |

**Coding convention** for the implementation handoff: all new comms in the capture
loop should carry both `source: this.id` and an explicit `channel:` field —
robust against future refactors of `sourceToChannel()`.

---

## 2. Camera auto-transitions — when they help vs hijack

Every place the camera moves on its own during the capture loop:

| Trigger | Where | Helps? | Hijacks? |
|---|---|---|---|
| G-key deploy → launch ceremony auto-enters `ARM_PILOT` (4 s) | [`CameraSystem.js:1052`](js/systems/CameraSystem.js:1052) | ✅ Player launched a daughter — they want to see her go. | ❌ — and existing code at [`InputManager.js:725-733`](js/systems/InputManager.js:725) explicitly exits ARM_PILOT first for a previous daughter, so deploys queue cleanly. |
| Number-key (1-6) deploy | [`InputManager._handleArmNumberKey()`](js/systems/InputManager.js:1232) | — emits comms "Arm X deployed — press P to pilot" only (BUG-A: comms drops if sourceless; verify). | ❌ No hijack — but also no follow-cue. The "didn't see daughter-2 get to SK" gap. |
| ESC from STATION_KEEP (in ARM_PILOT) | [`InputManager.js:540-543`](js/systems/InputManager.js:540) | ✅ Player is recalling — natural to stay on arm as RETURNING begins. | ❌ |
| REELING → DOCKING → RELOADING → DOCKED | No auto-transition; ARM_PILOT keeps tracking the same arm | Camera stays on arm visually — **but the daughter merges with the strut** during DOCKING/RELOADING, so it *reads* as "camera left." | ⚠ Perceived hijack. Fix is to make docking legible from current view, not to add a camera move. |
| `ARM_CAPTURED`, `ARM_DOCKED` | No camera response | — | — |
| AP disengage (any reason) | Comms + `SHOW_NOTIFICATION` ([`AutopilotSystem.js:329-335`](js/systems/AutopilotSystem.js:329)) | ✅ Discreet. | ❌ |

**Recommendation:** keep all current auto-transitions exactly as they are. The
fix to "daughter took a long time to appear on strut" is *not* a new camera
move — it is comms + an HUD pip + audio cue (see §3.8). Auto-camera-follow on
number-key deploy is **explicitly rejected**: it contradicts the documented
intent at [`InputManager.js:1233`](js/systems/InputManager.js:1233) ("deploy
does NOT auto-switch camera"), which exists precisely so the player can keep
their COMMAND view while deploying.

---

## 3. Flow walkthrough — state-by-state UX gap analysis

Each subsection: what the player perceives today (with file/line refs), the
perceived gap, ranked surgical options. File pointers feed §4 backlog.

### 3.1 Mother autopilot engages (A-key) → RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD

**Today**
- Comms: `✓ ON STATION — ready for capture` ([`AutopilotSystem.js:578`](js/systems/AutopilotSystem.js:578)) — **sourceless: dropped under BUG-A**.
- Autopilot phase chip in [`StatusPanel`](js/ui/hud/StatusPanel.js:1042) shows `Auto:TARGET·HOLD`.
- Audio: [`playAPArrived()`](js/systems/AudioSystem.js:2605) — ascending triple-beep.

**Gap** — autopilot **arrival comms is invisible** until BUG-A is fixed. The
phase chip and audio carry the signal; the text the player would benefit from
("you can launch now") never renders.

**Options**
| # | Approach | Cost |
|---|---|---|
| **A (preferred)** | Add `source: 'AUTOPILOT'` to the emit at [`AutopilotSystem.js:578`](js/systems/AutopilotSystem.js:578) so it lands even if BUG-A is not fixed. | 1 LOC |
| B | Fix BUG-A globally (CommsSystem source-fallback). | 6 LOC, fixes 20+ other lines for free |

Recommend **B first** (#0.1 / backlog #1), **then A** for the autopilot file as belt-and-braces.

---

### 3.2 Daughter deploy (G or 1-6) → arm DOCKED → LAUNCHING → TRANSIT → APPROACH → STATION_KEEP

**Today (G-key path)**
- 4 s launch ceremony ([`CameraSystem.js:970-1100`](js/systems/CameraSystem.js:970)).
- Arm card flips to LAUNCHING cyan ⚡ in fleet panel.
- Comms: "Arm X deployed — tracking…" ([`InputManager.js:746`](js/systems/InputManager.js:746)) — **sourceless: dropped**.
- Camera ends in ARM_PILOT view; daughter visible through transit; approach beep ladder.
- On SK entry: `STATION_KEEP_ENTERED` event ([`ArmUnit.js:2653`](js/entities/ArmUnit.js:2653)) — **no comms emit at all**.

**Today (1-6 number-key path while camera on mother)**
- Comms: "Arm X deployed — press P to pilot" ([`InputManager.js:1258`](js/systems/InputManager.js:1258)) — sourceless: dropped.
- Fleet card recolors.
- **No camera follow, no transit visuals, no SK arrival announcement.**
- Exactly the "2nd daughter didn't seem to get to SK" gap.

**Gaps**
1. SK arrival is silent on every path.
2. Number-key deploy + camera-on-mother gives no spatial cue.
3. Pre-existing latent comms wouldn't help even if added (BUG-A).

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Single `COMMS_MESSAGE` emit on `STATION_KEEP_ENTERED` (handled centrally in [`CommsSystem._setupListeners()`](js/systems/CommsSystem.js:430) — pattern matches existing event-driven templates). Text: `Weaver-2: ON STATION — 8 m standoff on debris #142. [V] view · [F] capture.` `source: armId`, `channel: 'CMD'`. | ~12 LOC | [`CommsSystem.js`](js/systems/CommsSystem.js) |
| B | Emit inline in [`ArmUnit.js:2653`](js/entities/ArmUnit.js:2653) and [:2814](js/entities/ArmUnit.js:2814) (two transition sites). | ~8 LOC | [`ArmUnit.js`](js/entities/ArmUnit.js) |
| C | New teaching moment `first_station_keep` — one-shot persistent overlay with "F to capture, V to view, ESC to recall." | ~25 LOC | [`TeachingSystem.js`](js/systems/TeachingSystem.js:31) |
| D | Auto-camera-follow on number-key deploy. **REJECTED** — contradicts documented intent at [`InputManager.js:1233`](js/systems/InputManager.js:1233). |
| E | `📡 Follow [V]` pill in HUD when an arm is in SK but camera not on her. | ~40 LOC | [`HUD.js`](js/ui/HUD.js) |

**Recommendation** A + C. A is the smallest-surgery legibility fix; C cements the
mental model on the first occurrence. Skip B (less DRY), D (breaks UX contract),
E (out-of-budget; revisit if A/C insufficient).

---

### 3.3 Optional long SK wait

**Today** — fleet card stays amber on STATION_KEEP. [`DockingReticle`](js/ui/DockingReticle.js)
shows aim reticle if in ARM_PILOT view. No gap reported. **Skip.**

---

### 3.4 F-key capture: STATION_KEEP → NETTING

**Today**
- Comms: `Weaver-1: Deploying net — stand by for capture` ([`ArmUnit.js:3123`](js/entities/ArmUnit.js:3123)) — **sourceless: dropped**.
- Net visual deploys.
- Audio: `playNetWhoosh()` is only wired to `ARM_DEPLOYED` ([`AudioSystem.js:93-99`](js/systems/AudioSystem.js:93)) which fires on first launch, **NOT on the SK→NETTING transition**. The net flying out is silent.

**Gap** — sound and text both missing on F-key capture once you're already in SK.

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Wire `STATION_KEEP_EXITED` listener in [`AudioSystem`](js/systems/AudioSystem.js:92) to `playNetWhoosh()` when payload has `reason === 'NET_FIRED'`. Emit-side already exists at [`ArmUnit.js:3098`](js/entities/ArmUnit.js:3098). | ~6 LOC | [`AudioSystem.js`](js/systems/AudioSystem.js) |
| B | Add `source: this.id` + `channel: 'CMD'` to the NETTING comms at [:3123](js/entities/ArmUnit.js:3123) and [:2828](js/entities/ArmUnit.js:2828). | ~4 LOC | [`ArmUnit.js`](js/entities/ArmUnit.js) |

Recommend A + B (or just A if BUG-A fix in #1 already lands).

---

### 3.5 Net flight → CAPTURED / MISSED / RELEASED

**Today**
- Net visual + net-FSM logs `[NETTING-FSM ${id}]`.
- Success → comms `Target secured! SMA cinch complete.` + [`playCatchClamp()`](js/systems/AudioSystem.js:515) on `ARM_CAPTURED`.
- Miss-with-target-alive → comms `Netting failed — holding standoff. Press F to retry.` ([:3362](js/entities/ArmUnit.js:3362)) + `playFailBuzz()`.
- Miss-with-target-dead → comms `Target lost during net flight — returning empty.` ([:3352](js/entities/ArmUnit.js:3352)).

**Gap** — minor; all three texts are sourceless and currently drop (BUG-A).
Recovery hint `Press F to retry` already exists. Once BUG-A is fixed, the
gap closes.

**Polish:** wrap `F` in `[F]` to match HUD glyph convention. ~1 LOC.

---

### 3.6 GRAPPLED (1.5 s stabilize)

**Today**
- Comms: `Target secured! SMA cinch complete.` ([:3226](js/entities/ArmUnit.js:3226)) — sourceless.
- Audio: `playNetWhoosh(0.3)` + `playCatchClamp()` on `ARM_CAPTURED`.
- Fleet card → GRAPPLED amber + 🎣 badge.

**Gap** — minor. The "Reeling in" line follows quickly. **Skip** unless the
stabilize ever drifts in practice.

---

### 3.7 REELING (4 m/s closing, distance-proportional)

**Today**
- Comms: `Weaver-1: Reeling target back to core` ([:3429](js/entities/ArmUnit.js:3429)) — sourceless.
- Fleet card → REELING cyan, T:{tetherLength}m visible.
- Tether visual contracts.

**Gap (the headline user-reported one)**
- For a daughter that net-captured at < 1 m, REELING completes in a single frame.
  The player perceives no transit — daughter "teleports" from net-fire to dock.

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Add ETA to the REELING comms: `Weaver-1: Reeling in — ETA 0.2 s` (calc `distance / reel_speed`). For sub-second ETAs the text itself communicates "instant; debris was already inside the net." | ~6 LOC | [`ArmUnit.js:3429`](js/entities/ArmUnit.js:3429) |
| B | When ETA < 1 s, suppress REELING comms entirely; jump straight to DOCKING comms (which #3.8 adds). | ~8 LOC | [`ArmUnit.js`](js/entities/ArmUnit.js) |
| C | Add REELING progress sliver on the fleet card (mirror existing RELOADING bar at [`StatusPanel.js:1426-1438`](js/ui/hud/StatusPanel.js:1426)). | ~20 LOC | [`StatusPanel.js`](js/ui/hud/StatusPanel.js) |

**Recommendation** A primary. Add C later if long-distance reels feel slow.

---

### 3.8 DOCKING (3 s, [`ARM_DOCK_DURATION`](js/core/Constants.js:218))

**Today**
- Fleet card → DOCKING blue.
- **No comms message at all on DOCKING entry.**
- No sound until completion (`ARM_DOCKED` → [`playDockClick()`](js/systems/AudioSystem.js:798)).
- Daughter visually merges with strut.

This is the *"Daughter took a long time to appear on strut"* gap.

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Two comms calls (DOCKING entry + RELOADING entry). DOCKING: `Weaver-1: Docking — 3 s.`. RELOADING: extend existing `Capture #N.` line. Both with `source: this.id`, `channel: 'CMD'`. | ~8 LOC | [`ArmUnit.js`](js/entities/ArmUnit.js) DOCKING entries at [:3467](js/entities/ArmUnit.js:3467), [:3518](js/entities/ArmUnit.js:3518), [:3584](js/entities/ArmUnit.js:3584); RELOADING at [:3608](js/entities/ArmUnit.js:3608) |
| B | DOCKING progress sliver on fleet card (mirror RELOADING bar at [`StatusPanel.js:1426`](js/ui/hud/StatusPanel.js:1426)). | ~15 LOC | [`StatusPanel.js`](js/ui/hud/StatusPanel.js) |
| C | Bottom-center `SHOW_NOTIFICATION` `🤖 Weaver-1 docking…` on DOCKING entry. | ~4 LOC | [`ArmUnit.js`](js/entities/ArmUnit.js) |
| D | Mastery-style gold toast for first 3 dockings (reuse [`_showMasteryToast`](js/ui/HUD.js:1561)). | ~30 LOC | [`HUD.js`](js/ui/HUD.js) |

**Recommendation** A + B. A delivers the legibility win in 8 LOC; B fills the
silent middle for long sessions with a familiar widget.

---

### 3.9 RELOADING

**Today**
- Fleet card already shows the reload `%` bar — [`StatusPanel.js:1426-1438`](js/ui/hud/StatusPanel.js:1426). Spring icon ◌.
- `CROSSBOW_RELOAD_START` event at [:3637](js/entities/ArmUnit.js:3637); `CROSSBOW_RELOAD_COMPLETE` at [:3664](js/entities/ArmUnit.js:3664).
- **No comms on either.**
- No sound until ARM_DOCKED.

**Gap** — minor; visible progress bar exists. Worth one comms line on completion
so the player knows the arm is ready again.

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Add comms `Weaver-1: Spring re-charged — ready for next deploy.` on `CROSSBOW_RELOAD_COMPLETE`, **wired in `CommsSystem._setupListeners()`** for clean separation. | ~5 LOC | [`CommsSystem.js`](js/systems/CommsSystem.js:430) |
| B | Add `playPracticeChime()` audio at low gain on the same event. | ~3 LOC | [`AudioSystem.js`](js/systems/AudioSystem.js) |

Recommend A.

---

### 3.10 Tether snap → EXPENDED

**Today**
- Red radial flash + "TETHER SNAP" text via [`HUD.showTetherSnapAlert()`](js/ui/HUD.js:1486).
- Warning queue line `⚠ TETHER SNAP — overload`.
- Fleet card clears tension; state → EXPENDED.
- **No comms emit (BUG-C).**
- **No audio (BUG-B).**
- **No guidance** ("what next?", "is the arm recoverable?").
- EXPENDED arm still draws a dimmed tether ([:4127](js/entities/ArmUnit.js:4127)) — visual ambiguity.

**Options**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Three small fixes wired in one place: <br/>– `eventBus.on(Events.TETHER_SNAP, ...)` listener in [`AudioSystem.js:223`](js/systems/AudioSystem.js:223) → `playTetherSnap()`. <br/>– `eventBus.on(Events.TETHER_SNAP, ...)` listener in [`CommsSystem._setupListeners()`](js/systems/CommsSystem.js:430) → `addMessage('CRITICAL', armId, 'TETHER SEVERED — arm lost. Payload jettisoned. Reload not possible.', {channel: 'ALERT'})`. <br/>Critical priority gets the 3 s panel-border flash for free. | ~12 LOC | [`AudioSystem.js`](js/systems/AudioSystem.js), [`CommsSystem.js`](js/systems/CommsSystem.js) |
| B | New teaching moment `first_tether_snap` — explains break-load mechanics. Persistent. | ~25 LOC | [`TeachingSystem.js`](js/systems/TeachingSystem.js:31) |
| C | Recovery sub-line in [`HUD.showTetherSnapAlert()`](js/ui/HUD.js:1486): "Daughter expended · payload jettisoned · deploy another arm with G." | ~10 LOC | [`HUD.js:1486`](js/ui/HUD.js:1486) |
| D | EXPENDED arm badge in fleet card (`🗑 LOST` dimmed row). | ~5 LOC | [`StatusPanel.js:1354-1374`](js/ui/hud/StatusPanel.js:1354) |
| E | Hide the dimmed tether line for EXPENDED arms (reduce visual confusion). | ~2 LOC | [`ArmUnit.js:4127`](js/entities/ArmUnit.js:4127) |

**Recommendation** A this week. B+C+D second wave. E is optional polish.

---

### 3.11 Net miss-fallback paths — minor polish only

Wrap `F` in `[F]` at [`ArmUnit.js:3362`](js/entities/ArmUnit.js:3362). 1 LOC.

---

### 3.12 Autopilot disengage reasons — friendly phrasing

**Today** — comms `AUTOPILOT OFF — ${reason}` ([`AutopilotSystem.js:331`](js/systems/AutopilotSystem.js:331)),
sourceless (dropped under BUG-A), uses internal jargon (`TARGET_LOST`, `DELTAV`, `TRAWL`).

**Recommendation**

| # | Approach | Cost | Files |
|---|---|---|---|
| **A (preferred)** | Map table at the emit site: `TARGET_LOST → 'Target lost'`, `DELTAV → 'Out of fuel budget'`, `TRAWL → 'Trawl override'`, `COLLISION → 'Collision avoidance'`, `ARROW_INPUT → 'Manual override'`, `MANUAL → 'Disengaged'`, `ARRIVED → 'Arrived on station'`. Add `source: 'AUTOPILOT', channel: 'CMD'`. | ~14 LOC | [`AutopilotSystem.js:329-333`](js/systems/AutopilotSystem.js:329) |

---

### 3.13 Cross-cutting: daughter-2 while camera on mother

Covered in §3.2 + §3.8. Net effect after BUG-A + #4 + #3 fixes: player launches
daughter-2 via number-key, sees comms `Weaver-2: Crossbow launch…` → `…approach
ping audio…` → `Weaver-2: ON STATION — 8 m standoff on debris #142. [V] view ·
[F] capture.` — and the spatial uncertainty is fully replaced by textual
certainty without yanking the camera.

---

## 4. Prioritized improvement backlog

Ordered by impact ÷ surgical cost. Each row: file(s), acceptance test, LOC estimate, risk.

| # | Item | File(s) | Acceptance | LOC | Risk |
|---|---|---|---|---|---|
| **1** | **CommsSystem source-fallback (closes BUG-A)** | [`CommsSystem.js:367`](js/systems/CommsSystem.js:367), [`:741`](js/systems/CommsSystem.js:741) | Sourceless `COMMS_MESSAGE` emits now render in panel with `SYSTEM:` (or extracted prefix from `text`). Spot-check: launch a daughter, see `Crossbow launch — target X` in the comms log. | ~6 | Low. Adds messages, doesn't suppress. Only risk is comms-flood from previously-silent lines — mitigated by existing coalescing (3-in-2s collapses). |
| **2** | **TETHER_SNAP → audio + comms (closes BUG-B, BUG-C)** | [`AudioSystem.js:223`](js/systems/AudioSystem.js:223), [`CommsSystem.js:430`](js/systems/CommsSystem.js:430) | Force a snap (high-mass debris + REELING). Hear `playTetherSnap()` sound; see `Weaver-1: TETHER SEVERED — arm lost. Payload jettisoned. Reload not possible.` in critical-stripe (gets 3 s border flash). | ~12 | Low. Both listener additions; no existing behaviour changes. |
| **3** | **DOCKING + RELOADING comms (closes "daughter took a long time")** | [`ArmUnit.js`](js/entities/ArmUnit.js) DOCKING entries [:3467](js/entities/ArmUnit.js:3467) / [:3518](js/entities/ArmUnit.js:3518) / [:3584](js/entities/ArmUnit.js:3584); reload complete via [`CommsSystem`](js/systems/CommsSystem.js:430) listener on `CROSSBOW_RELOAD_COMPLETE` | After capture, comms reads `Weaver-1: Docking — 3 s.` → `Weaver-1: Capture #1.` (existing) → `Weaver-1: Spring re-charged — ready for next deploy.` Player can hear the whole loop close. | ~10 | Low. **Watch coalescing**: three CMD-channel messages within ~3 s. Will likely *not* coalesce (window is 2 s, REELING→DOCKING separated by 3 s `ARM_DOCK_DURATION`). |
| **4** | **STATION_KEEP_ENTERED comms (closes "didn't get to SK")** | [`CommsSystem.js:430`](js/systems/CommsSystem.js:430) — new event listener | Deploy daughter via number key while camera on mother. Comms reads `Weaver-2: ON STATION — 8 m standoff on debris #142. [V] view · [F] capture.` `source: armId`, `channel: 'CMD'`. | ~12 | Low. New listener only. |
| **5** | **REELING ETA comms (closes "instant reel" perception)** | [`ArmUnit.js:3429`](js/entities/ArmUnit.js:3429) | Reel from 1 km → `Reeling in — ETA 4.0 s`. Reel from < 1 m → `Reeling in — ETA 0.1 s`. Add `source: this.id, channel: 'CMD'`. | ~6 | Low. |
| **6** | **Friendly AP disengage reason map** | [`AutopilotSystem.js:329-333`](js/systems/AutopilotSystem.js:329) | Force each reason; comms reads e.g. `AUTOPILOT OFF — Target lost`. Add `source: 'AUTOPILOT', channel: 'CMD'`. | ~14 | Low. |
| **7** | **DOCKING progress sliver in fleet card** | [`StatusPanel.js:1426`](js/ui/hud/StatusPanel.js:1426) — mirror existing reload bar | While arm DOCKING, card shows blue 0→100% bar over 3 s. | ~20 | Low. UI-only, copies existing widget. |
| **8** | **Net-fire whoosh on SK→NETTING** | [`AudioSystem.js`](js/systems/AudioSystem.js) — `STATION_KEEP_EXITED` listener filtered on `reason === 'NET_FIRED'`; **also confirm/add the `reason` field in the existing emit at** [`ArmUnit.js:3098`](js/entities/ArmUnit.js:3098) | F-key capture from SK audibly whooshes. | ~6 | Low. |
| **9** | **EXPENDED badge in fleet card** | [`StatusPanel.js:1354-1374`](js/ui/hud/StatusPanel.js:1354) | EXPENDED arms get `🗑 LOST` + dimmed row. | ~5 | Low. |
| **10** | **Recovery hint in TETHER SNAP banner** | [`HUD.js:1486-1516`](js/ui/HUD.js:1486) | Red flash now has a smaller sub-line: `Daughter expended · payload jettisoned · deploy another arm with G.` | ~10 | Low. |
| **11** | **Teaching moment `first_station_keep`** | [`TeachingSystem.js:31`](js/systems/TeachingSystem.js:31) (add to MOMENTS list + wire to `STATION_KEEP_ENTERED` in `_setupListeners`) | First time daughter enters SK, one-shot overlay explains controls. Persists. | ~25 | Low. |
| **12** | **Teaching moment `first_tether_snap`** | [`TeachingSystem.js:31`](js/systems/TeachingSystem.js:31) | First tether snap: overlay explains mechanics + what's recoverable. Persists. | ~25 | Low. |
| **13** | **`[F]` glyph polish on net-retry hint** | [`ArmUnit.js:3362`](js/entities/ArmUnit.js:3362) | Comms `Netting failed — holding standoff. Press [F] to retry.` matches HUD glyph convention. | ~1 | Trivial. |
| **14** | **Suppress sub-second REELING comms** (alt to #5) | [`ArmUnit.js:3429`](js/entities/ArmUnit.js:3429) | Captures within 1 m skip REELING line, jump to DOCKING. | ~8 | Low. Only ship if #5 feels noisy in playtest. |
| **15** | **Gate `[DBG-*]` console logs behind `Constants.DEBUG_FLAGS.CAPTURE_FLOW`** | Sites in [`ArmUnit.js`](js/entities/ArmUnit.js) ([:1920](js/entities/ArmUnit.js:1920), [:2163](js/entities/ArmUnit.js:2163), [:3495](js/entities/ArmUnit.js:3495)), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) ([:296](js/systems/AutopilotSystem.js:296), [:492](js/systems/AutopilotSystem.js:492), [:565](js/systems/AutopilotSystem.js:565), [:739](js/systems/AutopilotSystem.js:739)), [`DebrisField.js`](js/entities/DebrisField.js) ([:1214](js/entities/DebrisField.js:1214), [:1977](js/entities/DebrisField.js:1977)), [`CameraSystem.js`](js/systems/CameraSystem.js) ([:293-301](js/systems/CameraSystem.js:293), [:830](js/systems/CameraSystem.js:830)) | Add `Constants.DEBUG_FLAGS.CAPTURE_FLOW = false`. Default off → console clean. Flip to true to debug. | ~25 | Very low. Reversible. |
| **16** | **Hide dimmed tether on EXPENDED arms** | [`ArmUnit.js:4127`](js/entities/ArmUnit.js:4127) | EXPENDED arm tether becomes invisible (not just dimmed). | ~2 | Low. |
| **17** | **Spring-charge subtle chime on RELOAD_COMPLETE** | [`AudioSystem.js:92`](js/systems/AudioSystem.js:92) listener → `playPracticeChime()` low gain | Reload-done has audible micro-tone distinct from dock click. | ~5 | Low. Risk: too chimey if reload finishes mid-action. |

**Total ship-this-week (items 1-5):** ~46 LOC across 4 files
([`CommsSystem.js`](js/systems/CommsSystem.js), [`AudioSystem.js`](js/systems/AudioSystem.js),
[`ArmUnit.js`](js/entities/ArmUnit.js), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js)).

**Total whole-backlog estimate:** ~187 LOC across 7 files.

---

## 5. Ship-this-week subset

Items #1 – #5 above. Five edits, ~46 LOC, no new patterns, no new files, no camera-policy changes.

| # | What it closes |
|---|---|
| 1 | All the player's "what happened?" questions where the answer is "the message was emitted, but the comms layer dropped it." Single line in CommsSystem unlocks 20+ existing emits. |
| 2 | "What guidance is needed in Comms?" for tether snap. Closes BUG-B + BUG-C in one go. |
| 3 | "Daughter took a long time to appear on strut." Now the docking + reload window is fully narrated. |
| 4 | "2nd daughter didn't seem to get to SK." Comms confirms arrival and gives next inputs. |
| 5 | "Reel-in seemed instant." ETA tells the player it was instant by design (sub-second distance). |

**Order of implementation matters.** Item 1 should land *first* because items 2-5
all rely on the comms layer rendering. Once 1 lands, items 2-5 are mechanically
independent and can be parallelised.

---

## 6. Risk matrix & mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| BUG-A fix unleashes a flood of previously-silent comms during a long session | Medium | Low | Existing 3-in-2s coalescing already protects ([`CommsSystem.js:91`](js/systems/CommsSystem.js:91)). Confirm by replaying a 5 min capture session with verbose console off. |
| New CMD-channel messages from items 3 + 4 + 5 trigger coalescing into `× 3 cmd messages queued` | Low–Medium | Low | DOCKING and RELOADING are separated by 3 s `ARM_DOCK_DURATION`, outside the 2 s coalesce window. SK arrival and REELING ETA are seconds apart. Monitor in playtest. Mitigation: stagger via `setTimeout(…, 250)` between bursts if needed. |
| New comms text references key hints (`[V]`, `[F]`) that may become wrong if rebindings ship | Low | Low | Hints already used throughout codebase ([`CommsPanel.js:307`](js/ui/hud/CommsPanel.js:307), [`InputManager.js:1258`](js/systems/InputManager.js:1258)). Future rebinding work should treat all of them centrally. |
| BUG-A defensive-default obscures a future legitimate "missing source" bug | Low | Low | Add a single `console.debug('[CommsSystem] sourceless emit defaulted to SYSTEM:', data.text);` behind a debug flag for diagnosability. |
| Item #2 critical-priority audio + radial flash + border flash + comms entry feels like overkill | Low | Low | All four ARE the alert — losing an arm is a significant event. If playtest says "too much" the dial is the `priority` field; demote to `warning`. |
| Item #7 DOCKING progress sliver re-renders at 10 Hz, adds DOM churn | Very low | Very low | Mirrors existing RELOADING bar at the same rate. No new render cost beyond ~20 chars of HTML per arm. |
| AutopilotSystem reason-map (item #6) drifts from internal enum | Low | Low | Centralise in a `const FRIENDLY_REASONS = { ... }` map at top of file. Any new reason without an entry falls back to the original string. |

No high-severity risks identified.

---

## 7. Synergies & freebies discovered

Things that "come along for free" once items 1-5 land:

- **Critical priority → 3 s comms border flash** ([`CommsPanel.js:223-225`](js/ui/hud/CommsPanel.js:223)). Item #2 gets this automatically. **No HUD changes needed for the visual emphasis.**
- **`channel: 'ALERT'` → red-stripe row** in [`CommsPanel`](js/ui/hud/CommsPanel.js:56). Item #2 stripe matches the radial flash colour.
- **`AudioSystem._playMessageSound(priority)`** ([`AudioSystem.js:877`](js/systems/AudioSystem.js:877)) plays distinct beeps for info/warning/critical. **Every priority-tagged comms auto-cues audio**, so we don't need to add `playX()` calls beside each comms emit. (Item #2's `playTetherSnap()` is an *additional* dramatic effect on top of the critical beep.)
- **`ARM_RETURNED { captured: boolean }`** ([`ArmUnit.js:3468`](js/entities/ArmUnit.js:3468)) lets us conditionally announce "Capture #N" vs "Returned empty" *from a single listener* in CommsSystem — cleaner than two emits inside ArmUnit.
- **`HUD.showTetherSnapAlert()`** ([`HUD.js:1486`](js/ui/HUD.js:1486)) already fires `showWarning(... 'critical')` — meaning item #2's critical-priority comms layers on top of an existing warning toast for triple-redundant alert (radial flash + queued warning + comms critical flash + audio). For a "you lost an arm" moment, this is correct.
- **Items 11 + 12 (teaching moments)** can be added without touching ArmUnit at all — they wire entirely in [`TeachingSystem.js`](js/systems/TeachingSystem.js) on existing events.
- **Item #6 (AP reason map)** can be reused if more autopilot reasons are added later (CONJUNCTION, TIMEOUT, etc.). Future-proofs the human phrasing.

---

## 8. Diagnostic `[DBG-*]` logs — recommendation

**Keep, but gate behind `Constants.DEBUG_FLAGS.CAPTURE_FLOW` (backlog #15).**

Rationale:
- These logs were load-bearing during the prior Debug subtask and remain useful for regression triage (gap drift, REEL-IN start distance, AP HOLD sync, capture-pin invariants).
- Stripping discards free regression coverage.
- Leaving them at default verbosity floods the console and drowns the new comms signal we are adding.
- One `Constants.DEBUG_FLAGS.CAPTURE_FLOW = false` plus a wrap is ~25 LOC and keeps both audiences happy: default off in production; the Debug mode flips the flag.

**Alternative considered & rejected:** onboarding overlay "Filter `[DBG-` in DevTools."
This shifts the user-facing problem onto the user. Item #15 is strictly better.

---

## 9. Implementation sequencing for orchestrator handoff

A natural breakdown into self-contained code-mode subtasks. Each subtask is
independent after Phase 0 lands.

### Phase 0 — Bug-fix substrate (must land first, blocks all comms work)

- **Subtask 0.1** — Add CommsSystem source-fallback (backlog #1). 6 LOC; ~5 min.
  - Acceptance: deploy a daughter via G; comms log shows `Weaver-1: Crossbow launch — target {id}`. Repeat with number-key path — confirm same text appears.
  - Regression check: existing `source: 'HOUSTON'` lines still render with mint styling.
  - **Optional test:** add a unit test in [`js/test/test-CommsSystem.js`](js/test/test-CommsSystem.js) covering the fallback path.

### Phase 1 — Ship-this-week comms expansion (parallelisable after Phase 0)

- **Subtask 1.1** — TETHER_SNAP audio + comms (backlog #2). ~12 LOC across 2 files.
- **Subtask 1.2** — DOCKING + RELOADING comms (backlog #3). ~10 LOC.
- **Subtask 1.3** — STATION_KEEP_ENTERED comms (backlog #4). ~12 LOC.
- **Subtask 1.4** — REELING ETA comms (backlog #5). ~6 LOC.

Acceptance for Phase 1 overall: replay the user's full live test sequence (engage
A → deploy G → capture F → wait for dock → deploy 2 → capture → snap tether on a
big target). Comms panel narrates the entire loop without confusion. Player can
answer "what happened?" by reading the log.

### Phase 2 — HUD widget polish (independent, can run in parallel with Phase 1)

- **Subtask 2.1** — DOCKING progress sliver (backlog #7). ~20 LOC, mirrors RELOADING bar.
- **Subtask 2.2** — EXPENDED badge in fleet card (backlog #9). ~5 LOC.
- **Subtask 2.3** — Recovery sub-line in TETHER SNAP banner (backlog #10). ~10 LOC.
- **Subtask 2.4** — `[F]` glyph polish (backlog #13). ~1 LOC.
- **Subtask 2.5** — Hide EXPENDED tether line (backlog #16). ~2 LOC.

### Phase 3 — AP comms polish

- **Subtask 3.1** — AP disengage reason map (backlog #6). ~14 LOC.
- **Subtask 3.2** — Net-fire whoosh (backlog #8). ~6 LOC.

### Phase 4 — Teaching layer (depends on Phases 0+1 landing)

- **Subtask 4.1** — `first_station_keep` moment (backlog #11). ~25 LOC.
- **Subtask 4.2** — `first_tether_snap` moment (backlog #12). ~25 LOC.

### Phase 5 — Console hygiene

- **Subtask 5.1** — Gate `[DBG-*]` logs behind flag (backlog #15). ~25 LOC.
- **Subtask 5.2** *(optional)* — RELOADING chime (backlog #17). ~5 LOC.
- **Subtask 5.3** *(optional)* — Sub-second REELING suppression (backlog #14). ~8 LOC.

### Suggested orchestrator delivery

- **Week 1, day 1 morning:** Phase 0 (single 6-LOC change, 30 min including test).
- **Week 1, day 1 afternoon:** Phase 1 subtasks 1.1 – 1.4 in parallel (~45 LOC total).
- **Week 1, day 2:** Phase 2 + 3 polish.
- **Week 2:** Phases 4 + 5.

Phase 0 + Phase 1 together fully close every user-reported gap in ~50 LOC of one
day's work.

---

## 10. Cross-references — existing systems being reused

No new patterns invented for the ship-this-week subset:

- Comms backbone — [`CommsSystem.addMessage()`](js/systems/CommsSystem.js:739), priority `info`/`warning`/`critical` (audio side-effects free via [`_playMessageSound()`](js/systems/AudioSystem.js:877)).
- Channel routing + colour stripes — [`sourceToChannel()`](js/systems/CommsSystem.js:45), `payload.channel: 'CMD'` for capture-loop telemetry.
- Critical-priority panel-border flash — [`CommsPanel.onMessage()`](js/ui/hud/CommsPanel.js:222) (free with `priority: 'critical'`).
- Coalescing protection — [`shouldCoalesce()`](js/systems/CommsSystem.js:91) auto-trims comms floods.
- Bottom-center transient toast — [`HUD.showNotification()`](js/ui/HUD.js:1241).
- Red radial flash banner — [`HUD.showTetherSnapAlert()`](js/ui/HUD.js:1486).
- Per-arm fleet card progress bar — [`StatusPanel._renderArmPanel()`](js/ui/hud/StatusPanel.js:1426) (RELOADING bar mirrored for DOCKING in #7).
- Teaching overlay one-shot — [`TeachingSystem.MOMENTS`](js/systems/TeachingSystem.js:31).
- Audio wiring — [`AudioSystem._setupListeners()`](js/systems/AudioSystem.js:92).

No new HUD widgets, no new camera modes, no new event types are required by
items 1-6. Items 7 + 11 + 12 add net new UI elements but follow established
patterns.

---

## Appendix A — User-reported pain point traceability

| User-reported issue | Root cause | Backlog item | Phase |
|---|---|---|---|
| "Daughter took a long time to appear on strut" | DOCKING has no comms emit + no progress widget + sourceless legacy comms dropped (BUG-A) | #1, #3, #7 | 0, 1, 2 |
| "2nd daughter didn't seem to get to SK" | `STATION_KEEP_ENTERED` has no comms emit + sourceless legacy comms dropped (BUG-A) | #1, #4, #11 | 0, 1, 4 |
| "What happened with tether snap? What guidance is in Comms?" | BUG-B (audio not wired) + BUG-C (no comms emit) + no recovery guidance | #2, #10, #12 | 1, 2, 4 |
| "Reel-in seemed instant — what happened?" | No ETA in comms; sub-second reel reads as a teleport | #5 | 1 |
| Hundreds of `requestAnimationFrame` stack lines on verbose | `[DBG-*]` logs default to verbose | #15 | 5 |

Every user-reported issue maps to ≥ 1 backlog item, and every gap has a
named, scoped implementation path. Phase 0 alone closes the majority of
"what happened?" pain because the answer was already being emitted —
just to a comms layer that silently dropped it.
