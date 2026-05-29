# Post-Cinch-Fix QA Pass — Design Docs (Items 5, 6, 10, 11)

*Generated: 2026-05-28 · Companion to the F2 polish pass that fixed Items 1-3, 7-9. Items 4 deferred per user direction.*

This document captures the design proposals for the four items in the QA pass that were tagged ANALYTICAL or DESIGN-ONLY. Code changes for these items are gated on user sign-off in a follow-up shift.

---

## Item 5 — Rim Weight Spin Rate Physics (analytical, doc-only)

**Status:** documented in-line at [`Constants.js`](js/core/Constants.js:1230) — no code change needed.

**Conclusion:** current `SPIN_HZ` values (LARGE=2, MEDIUM=4, SMALL=6 Hz) produce per-weight centripetal force of 47.4 / 78.9 / 16.0 N respectively. All three are above the ~5-10 N minimum tension needed to hold a Dyneema SK78 mouth open in 0g, and well below the ~3500 N break strength of a 1 mm² strand. No retune required.

**Sanity guard for future changes:** if you raise spin rates for visual effect, re-derive `F = m × ω² × r` per weight. Stay above 10 N (mouth stays open) and below 1000 N (well within fiber yield).

See [`Constants.js`](js/core/Constants.js:1230) for the canonical formula and table.

---

## Item 6 — "Gold Ball" Identification

**Status:** awaiting user clarification.

### Candidates found by colour-hex grep

| Object | Color | Geometry | Visible during |
|--------|-------|----------|----------------|
| [`apexHub`](js/ui/CaptureNetVisual.js:351) | `0x665544` (brown-gold) | Sphere, M×0.05 (50 mm scaled) | All net ceremony states from SPINNING_UP onward |
| [`drawstring`](js/ui/CaptureNetVisual.js:340) | `0xffaa44` (orange-gold) | Line (spokes apex→weights) | All net ceremony states from SPINNING_UP onward |
| `mli_mylar` debris ([`Constants.js`](js/core/Constants.js:1730)) | `0xFFD700` (gold) | Whatever mesh the debris uses | Always (if material = mli_mylar) |
| [`apertureRing` laser](js/entities/PlayerSatellite.js:359) | `0xccaa44` (anodized gold) | Ring | Always (mother body) |
| [`goldEdgeMat`](js/entities/PlayerSatellite.js:1121) | `0xccaa44` | Line segments around ROSA panels | Always (mother body) |

### Best guess

The **apexHub** is the only true *sphere* and is positioned at the net center (at `vis.group.position`). During REELING it would render at the daughter's position (post Item 2 fix) — visible as a small gold-brown ball near the daughter.

### Action

Per priority direction "skip Item 4, defer 6 to design": waiting on user to confirm context (was it near the mother, on the strut, inside the net, or in the debris field?). Likely apexHub.

---

## Item 10 — First-Clear Guidance (design proposal)

### Current behavior

[`RewardSystem.js`](js/systems/RewardSystem.js:373-380) fires a comms message when the player clears a cluster:

| Threshold | Comms message |
|-----------|---------------|
| 50% | "Houston: Half the cluster cleared. Keep it up." |
| 75% | "Houston: Three quarters cleared — keep pushing!" (approximate; see line ~373) |
| 100% | "Houston: Field completely cleared! Perfect sweep. Bonus authorized." |

The 100% message is **celebratory but non-directive**. The player has no in-game hint what to do next:

1. Forge salvage at the shop?
2. Scan for a new cluster?
3. Autopilot to another field?

[`TeachingSystem.js`](js/systems/TeachingSystem.js:30) defines 12 teaching moments but none target the first-cluster-cleared event.

### Design proposal

#### A. Make the 100% comms message directive

Replace the celebratory text with a sentence that names the next 2 actions and the keys:

```
"Houston: Field clear! Press K to forge salvage, or scan (S/W) for the next cluster."
```

#### B. Add `FIRST_FIELD_CLEARED` teaching moment

Persistence-gated (fires once across all sessions) and triggered on the first `Events.FIELD_CLEAR` event (tier.pct >= 1.0):

```js
// In TEACHING_MOMENTS array
{
  id: 'first_field_cleared',
  triggerEvent: Events.FIELD_CLEAR,
  triggerFilter: (data) => data.pct >= 1.0,
  oncePerProfile: true,
  title: 'Field Clear — What Next?',
  body: [
    'Your salvage is in cargo. Options:',
    '  • K — forge raw metals into refined ingots (2.5× value) or propellant slugs',
    '  • B — shop (refined metals + reputation unlock upgrades)',
    '  • S/W — scan for the next cluster (Tab cycles targets)',
    '  • A — autopilot once you have a target',
  ].join('\n'),
}
```

The teaching overlay UI auto-handles display + dismiss-on-input + persistence.

#### C. (Optional) HUD hint banner

A 5-10 s ephemeral banner under the HUD top bar:

```
[FIELD CLEAR]  Forge (K) · Shop (B) · Scan (S/W)
```

Cleared by any of:
- 10 s wall-clock
- player presses any of K, B, S, W (= they took the suggested action)
- new cluster engaged

This can reuse the existing comms-toast layout for consistency.

### Sign-off checklist

- [ ] User confirms 2 directives "forge OR scan" is the right next-step.
- [ ] User confirms `FIRST_FIELD_CLEARED` should be once-per-profile (not once-per-session).
- [ ] User approves K hotkey (depends on Item 9 having landed).
- [ ] (Optional) User approves HUD banner pattern.

### Implementation effort

- A: ~5 LOC change in [`RewardSystem.js`](js/systems/RewardSystem.js:373)
- B: ~30 LOC in [`TeachingSystem.js`](js/systems/TeachingSystem.js:30) + persistence key + test
- C: ~80 LOC new HUD banner component + lifecycle + test

Total: ~150 LOC, ~3 new tests.

---

## Item 11 — Forge Mass Chunking (design proposal)

### Current behavior

[`ForgeSystem.queueBatch()`](js/systems/ForgeSystem.js:110-159) **silently truncates** any incoming mass to `FORGE.BATCH_SIZE_KG = 5.0 kg` ([`Constants.js`](js/core/Constants.js:825)):

```js
const batchMass = Math.min(massKg, FORGE.BATCH_SIZE_KG);
```

If the user queues 50 kg of aluminum from cargo, only 5 kg gets processed. The other 45 kg stays in cargo, unprocessed and unmentioned in the comms log. The user has to press K (or click the forge again) 10 times to chew through the full pile.

### Design proposal — auto-chunk and queue residual

Replace silent truncation with explicit chunking: enqueue `ceil(massKg / BATCH_SIZE_KG)` sub-batches of `BATCH_SIZE_KG` each, plus one final short batch if there's a remainder.

```js
queueBatch(data) {
  const { metalId, massKg, outputMode = 'refine' } = data;
  const totalMass = Math.min(massKg, cargoItem.massKg);  // cap by available
  if (totalMass < 0.01) {
    emitComms('Insufficient ... in cargo', 'warning');
    return false;
  }

  // ── Chunk into N batches ──────────────────────────────────────
  let remaining = totalMass;
  const batches = [];
  while (remaining > 0) {
    const chunkMass = Math.min(remaining, FORGE.BATCH_SIZE_KG);
    batches.push({ ...batchTemplate, massKg: chunkMass });
    remaining -= chunkMass;
  }

  // ── Enqueue all of them ──────────────────────────────────────
  this._queue.push(...batches);

  emitComms(`Queued ${totalMass.toFixed(1)} kg ${name} → ${batches.length} batches × ${BATCH_SIZE_KG} kg, ` +
            `~${(batches.length * cycleTimeForMeltScale).toFixed(0)} s total`);

  // Auto-start if idle
  if (this._phase === 'IDLE') this._startNextBatch();
  return true;
}
```

### Behavioral changes

| Aspect | Before | After |
|--------|--------|-------|
| Silent truncation | Yes — 45 kg discarded silently | No — all queued |
| Comms feedback | "Queued 5.0 kg" | "Queued 50.0 kg → 10 batches × 5 kg, ~400 s" |
| Queue depth | 1 batch max from a single press | N batches |
| Cancel semantics | Drops current + (already truncated) | Drops current AND residual queue |
| Re-press during processing | Adds another truncated batch | Adds another full pile (10× compounded if user spam-presses) |

### Edge cases

1. **Re-press during processing.** Should K-press during MELT enqueue more, or cancel? Currently `toggle()` cycles OFF → REFINE → PROPELLANT → OFF. Proposal: keep that semantics; user explicitly opens cargo + clicks "queue all aluminum" to chunk-enqueue. The K-hotkey continues to drive the toggle.

2. **Cancel mid-batch with queue depth > 1.** New `cancelAll()` drops everything; existing `cancel()` cancels current batch only and continues queue. Add a HUD button + a Shift-K modifier?

3. **Power-pause during MELT.** Existing behavior at [`ForgeSystem.js:228-240`](js/systems/ForgeSystem.js:228) freezes the timer when battery is low. Per-chunk pause behavior unchanged.

4. **Cargo-removal vs queue.** Currently each `_startNextBatch()` re-validates cargo at start. With chunked queues, the user might queue 50 kg, then sell some via shop, then the queued batches that no longer have cargo would error out. Current behavior already handles this via the `removed < 0.01` early-exit. Should the queued batches RESERVE the cargo upfront? Proposal: yes — `queueBatch()` should `removeMetal()` upfront and only restore on cancel. (This is a non-trivial change to cargo state, gated on user sign-off.)

### Sign-off checklist

- [ ] User confirms auto-chunk + queue-residual is the right semantics.
- [ ] User decides cancel semantics: `cancelAll()` (current cancel keeps existing behavior — drops only current).
- [ ] User decides cargo reservation: upfront (clean but couples to cargo state) vs lazy (current — could fail mid-queue if cargo is sold).
- [ ] User approves the comms message text format.

### Implementation effort

- Refactor [`queueBatch()`](js/systems/ForgeSystem.js:110) — ~30 LOC.
- New `cancelAll()` method — ~15 LOC.
- HUD queue-depth indicator — ~20 LOC ([`StatusPanel.js`](js/ui/hud/StatusPanel.js:385) forge inline block).
- Tests: queue-depth assertion, residual completes, cancel-all drops residual — ~80 LOC, 4-5 new tests.

Total: ~150 LOC, ~5 new tests.

---

## Cross-item alignment

- **Item 9 + Item 10:** the first-clear teaching message references the K key for forge — this depends on Item 9 (K-forge swap) having already landed. Confirmed in the F2 polish commit ✓.
- **Item 10 + Item 11:** chunked queue means the player can press K once after clearing a field and the entire pile auto-processes. The teaching moment in Item 10 should say "Press K to forge ALL salvage" not "Press K to forge a 5 kg batch".
- **Item 5:** purely doc; no follow-up.
- **Item 6:** waiting on user.
