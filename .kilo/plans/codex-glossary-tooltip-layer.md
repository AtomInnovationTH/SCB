# Step 4 — Inline Glossary / First-Use Tooltip Layer (master §11.8)

> Companion to `tech-library-codex-next-session.md` (Steps 1–3 done) and the master
> `tech-library-codex-overhaul.md` (§11.8 spec, §Phase 4 deep-links). This is the
> actionable plan for the **last** codex step: a game-wide inline glossary so jargon
> (ΔV, LEO, FEEP, TRL, conjunction…) explains itself the first time a player sees it.

---

## 0. Goal (ELI5)

The first time a hard space word appears in player-facing text, give it a dotted
underline. Hover → a one-line plain-language definition (reusing the menu's `title=`
pattern). Click → deep-link into the Tech Library entry for "read more". After a term
has been seen, drop the first-use attention cue so veterans aren't nagged.

This serves the **NEW-user** need from master §11.8 ("a jargon glossary … reuse the
menu's hover-tooltip pattern as an inline glossary layer game-wide, not just in the
codex") and finishes the Phase-4 **deep-links** item ("New `codex:open-entry` event
the viewer honors").

---

## 1. Verified feasibility (researched 2026-06-20)

- **Comms panel = DOM, single chokepoint.** `js/ui/hud/CommsPanel.js:375-391`
  (`_updateCommsPanel`) renders every message body as `${msg.text}` inside `innerHTML`.
  Wrapping terms in `<span>` here decorates ALL comms text in one place. This is the
  primary injection point.
- **Menu already has the target pattern.** `js/ui/MenuScreen.js:267,282-285` use
  `<span class="adr-name" title="…">term</span>` — hover tooltips, no JS. Reuse it.
- **`aliases` is NOT a glossary.** `data/codex.json.aliases` (and `CodexSystem.ALIASES`,
  `CodexSystem.js:59,98,443`) is an old-id→new-id **save-migration** map. Step 4 needs a
  brand-new **term → {definition, optional entryId}** map, because many glossary terms
  (LEO, GEO, MEO, TRL, ASAT) have no dedicated codex entry.
- **No deep-link exists.** `js/core/Events.js` has `CODEX_UNLOCKED/VIEWED/UNLOCK_REQUEST/
  OPENED` but **no** open-entry. Viewer is toggled via `codex:toggleUI`
  (`main.js:807`); construction at `main.js:619`. `CodexViewerUI` has private
  `_showDetail(entry)` (line ~570) and `_firstCategoryKey()` but **no public open-by-id**.
- **Persistence pattern (reuse).** Each system does, on its own:
  `eventBus.on(PERSISTENCE_GATHER, sd => sd.<slice> = serialize())` and
  `eventBus.on(PERSISTENCE_LOADED, () => restore(persistenceManager.peek().<slice>))`,
  with a slice-local `version` and **no** `SAVE_VERSION` bump (see `SkillsSystem.js:427-433,
  786` and `CodexSystem.js:172-187`). `SAVE_VERSION` stays **1**.
- **Other DOM surfaces for later extension:** `ShopScreen.js`, `TeachingOverlay.js`,
  `BriefingScreen.js`, `HintTicker`, and the codex's own `fullText`/`shortText`.
- **Out of scope (canvas — cannot host hover tooltips):** `DebrisWireframe.js`,
  `TargetReticle.js` (both `ctx.fillText`). Glossary terms there stay plain.

---

## 2. Architecture

### 2.1 New: glossary data + pure decorator
`js/systems/codex/glossary.js` (Node-safe, no DOM — mirrors `codexInterpolate.js`):

- `export const GLOSSARY` — an ordered array of term defs:
  ```
  { term: 'ΔV', aliases: ['delta-v','delta v'], def: 'Velocity change a craft can
    produce — its fuel budget in space.', entryId: 'delta_v', flags: 'i' }
  ```
  - `term` + optional `aliases` = the surface forms to match.
  - `def` = the short hover definition (1 line, plain language, acronym expanded).
  - `entryId` = optional codex entry to deep-link (omit for terms with no entry, e.g.
    LEO/GEO/TRL — those are hover-only).
  - `flags`/match config = case sensitivity (LEO/GEO uppercase-only; "delta-v" insensitive).
- `export function decorateGlossary(plainText, opts)` — **pure**:
  1. HTML-escape the input (we are moving from raw interpolation to span-wrapping).
  2. Build/cache one combined matcher from `GLOSSARY` (longest term first to avoid
     partial overlaps), respecting word boundaries and per-term case rules.
  3. Wrap matches in
     `<span class="glossary-term" data-term="KEY" data-entry="ID?" title="DEF">…</span>`.
  4. `opts.once` (default true): wrap only the **first** occurrence of each distinct
     term per call; never double-wrap; never match inside an already-wrapped span.
  - Returns an HTML string safe to assign to `innerHTML`.

### 2.2 New: seen-state controller (first-use semantics)
A tiny `GlossaryState` (or fold into `CodexSystem`):
- `seenTerms: Set<string>`; `markSeen(term)`; `hasSeen(term)`.
- Persistence slice `saveData.glossary = { v: 1, seen: [...] }` (additive; gather/loaded
  via `peek()`; data-loss guard like codex). `SAVE_VERSION` unchanged.
- First-use cue: unseen terms get an extra class (e.g. `glossary-term--new`, a brighter
  underline / one subtle pulse); on first render they're marked seen so the cue drops
  next time. (Exact cue per Open Question Q2.)

### 2.3 Deep-link into the viewer
- Add event `CODEX_OPEN_ENTRY: 'codex:open-entry'` to `js/core/Events.js`
  (payload `{ id }`).
- Add `CodexViewerUI.openEntry(id)`: resolve via `this._codex.getEntry(id)` (run it
  through `ALIASES` for safety); if found, `this.show()`, set `_selectedCategory` to the
  entry's category, then `_showDetail(entry)`. No-op on unknown id.
- Wire in `main.js` next to line 807:
  `eventBus.on(Events.CODEX_OPEN_ENTRY, ({id}) => codexViewerUI?.openEntry(id));`
- Deep-linking to a **locked** entry is fine — the viewer already shows locked entries
  with their how-to-unlock hint (Phase 3). Don't gate on unlock.

### 2.4 Injection at the comms chokepoint
In `CommsPanel._updateCommsPanel` (line ~389) replace the raw `${msg.text}` body with
`decorateGlossary(msg.text, { once: true })`. Decorate **only** the message-body span,
not the `source:` label. Add a delegated click handler on `_logEl`:
`if (e.target.closest('.glossary-term')?.dataset.entry) eventBus.emit(CODEX_OPEN_ENTRY,
{id})`. Add CSS for `.glossary-term` (dotted underline, cursor help/pointer) — reuse the
menu's `.adr-name` look or add a shared class.

---

## 3. Slices (commit between, only when green) — Slices 1 & 2 are in scope (§6.3)

- **Slice 1 — vertical slice (comms panel):** `glossary.js` (data + `decorateGlossary`),
  `CODEX_OPEN_ENTRY` + `CodexViewerUI.openEntry` + `main.js` wiring, CommsPanel injection
  + click-to-deeplink + CSS, glossary persistence slice (seen-state), and tests. ~50–60
  curated terms. This is the whole feature on the highest-traffic teaching surface.
- **Slice 2 — extend to other DOM surfaces (in scope this session):** run
  `decorateGlossary` through `TeachingOverlay`, `ShopScreen` upgrade descriptions,
  `BriefingScreen`, `HintTicker`, and the codex's own `fullText`/`shortText` render in
  `CodexViewerUI._showDetail` (recursive deep-links inside the library itself). Reuse the
  same module, CSS class, and click→`CODEX_OPEN_ENTRY` delegation per surface.
- **Slice 3 — polish (optional follow-up):** first-use cue tuning + "seen" dimming
  refinements; optional glossary index/tab in the viewer; term-list broadening.

---

## 4. Tests (extend `js/test/run-tests.js`)

- `test-Glossary.js` (pure, Node-safe — no DOM):
  - escapes `< > &` in surrounding text; output has no unescaped injection.
  - wraps each known term/alias; respects word boundaries (no match inside `feeper`,
    `description`); honors case rules (LEO uppercase-only; `delta-v` case-insensitive).
  - `once` wraps only the first occurrence; never double-wraps; leaves unknown text alone.
  - **integrity:** every `GLOSSARY[*].entryId` resolves to a real `codex.json` entry
    (mirror the dangling-`related` test in `test-CodexData.js:237`).
- `test-CodexViewer.js` (extend, `Object.create` prototype pattern): `openEntry(id)`
  selects the entry's category and routes to detail; unknown id is a safe no-op.
- Persistence round-trip for the `glossary` slice (mirror codex/skills persistence tests):
  `seenTerms` survives gather→peek→restore; unknown terms ignored; absent slice is safe.

---

## 5. Risks / gotchas

- **HTML-escaping is mandatory.** Comms text is currently injected raw; the decorator
  must escape non-term text before wrapping, or layout/security regresses. (Comms text is
  plain today, but don't assume.)
- **Combined regex ordering:** sort terms longest-first and use boundaries so `Isp`
  doesn't match inside words and `ΔV` (unicode) matches reliably; build once and cache.
- **Performance:** comms shows ≤ 4–8 lines and re-renders only on message events — a
  cached regex pass is negligible. Not a hot path.
- **Don't decorate the `source:` label** (e.g. "HOUSTON:") — body only.
- **Veteran nagging:** §11.8/ELI5 promised the cue "stops nagging" — that's the seen-state
  behavior (Q2). The hover `title` can persist; only the first-use *cue* should drop.
- **Deep-link reachability:** terms with no entry are hover-only (no click). Only render
  the clickable affordance / `data-entry` when `entryId` is present.

---

## 6. Decisions (confirmed 2026-06-20)

1. **Tooltip mechanism = native `title=` + click-to-deep-link.** The hover definition uses
   the menu's `title=` pattern (no custom popover/positioning layer). A term that has an
   `entryId` is also clickable and emits `CODEX_OPEN_ENTRY` to open the viewer on it.
   Terms without an entry are hover-only (no click affordance).
2. **First-use = subtle one-time highlight, then plain.** Unseen terms render with a
   brighter underline / one gentle pulse (`glossary-term--new`); first render marks the
   term seen (persisted), so subsequent appearances are a plain dotted underline + hover.
   The hover `title` always works; only the first-use *cue* drops. Requires the persisted
   `glossary` slice (§2.2).
3. **Scope = Slices 1 AND 2** (comms panel + all other DOM surfaces: `TeachingOverlay`,
   `ShopScreen`, `BriefingScreen`, `HintTicker`, and the codex's own `fullText`/`shortText`).
   Slice 3 (polish / glossary index tab) remains optional follow-up. Commit between slices,
   only when green.
4. **Term list = broad, ~50–60 terms up front.** Cover jargon across all categories;
   every fact/definition web-verified per the project content rules, acronyms expanded,
   plain-language, humor only in framing. Seed examples: ΔV/Isp/specific impulse, LEO/MEO/
   GEO, perigee/apogee, prograde/retrograde, inclination/RAAN, eclipse, conjunction,
   Kessler, ADR, ASAT, MMOD, atomic oxygen, Van Allen, TRL, FEEP/MPD/cold-gas/RCS, ion/
   xenon/krypton/argon, CMG/reaction wheel/magnetorquer/IMU/star tracker/detumble, tether/
   EDT/Miura-ori, MLI/supercapacitor/RTG, station-keeping, deorbit, rendezvous/berthing,
   ground station/TDRS, telemetry, watchdog/TMR/SEU, OSAM. (Map each to an `entryId` where
   one exists; hover-only otherwise.)

---

## 7. Touch list (quick ref)

- **New:** `js/systems/codex/glossary.js`, `js/test/test-Glossary.js`.
- **Edit:** `js/core/Events.js` (+`CODEX_OPEN_ENTRY`), `js/ui/CodexViewerUI.js`
  (`openEntry`), `js/main.js` (~807 wiring), `js/ui/hud/CommsPanel.js` (~375-391 inject +
  click handler + CSS), `js/test/run-tests.js` (register), `js/test/test-CodexViewer.js`
  (openEntry). Persistence: glossary gather/loaded handlers (in `glossary.js` controller
  or `CodexSystem`). `SAVE_VERSION` stays 1.
- **Slice 2 edits (later):** `TeachingOverlay.js`, `ShopScreen.js`, `BriefingScreen.js`,
  HintTicker, `CodexViewerUI._showDetail` fullText.
