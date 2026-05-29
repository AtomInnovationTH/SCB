# Post-Cinch-Fix QA Pass — Design Docs (Items 5, 6, 10, 11) — Stubbed

> **Stubbed:** 2026-05-29 · **Reason:** All four deferred design items from the 2026-05-28 Post-Cinch QA pass have been folded into canonical homes during the doc consolidation sprint. This file is a one-paragraph redirect.

## Where the content now lives

| Item | Topic | New canonical home |
|------|-------|---------------------|
| **5** | Rim weight spin-rate physics (analytical only) | Inline doc comment at [`Constants.js:1230-1248`](js/core/Constants.js:1230) (`SPIN_HZ` values + `F = m × ω² × r` table) |
| **6** | Gold ball / apex hub first-deploy keepsake — candidate analysis + design intent | [`GAME_DESIGN.md §4.1 First-Clear Keepsake — Apex Hub Trophy`](GAME_DESIGN.md:108) |
| **10** | First-clear directive comms + `FIRST_FIELD_CLEARED` teaching moment | [`HANDOFF.md §4.9.2 #6 First-Clear Guidance`](HANDOFF.md:1) (within the Onboarding Flow backlog) |
| **11** | Forge mass chunking (chunk-and-queue residual + cargo reservation) | [`GAME_DESIGN.md §4.0 Forge v2 — Chunk-and-Queue Residual`](GAME_DESIGN.md:108) |

## For history

The original 220-line design doc with full candidate analysis, code snippets, behavioural-change tables, and sign-off checklists is preserved in git:

```bash
git log --follow POST_CINCH_QA_DESIGN_DOCS.md
git show HEAD~1:./POST_CINCH_QA_DESIGN_DOCS.md
```

This stub will be moved to `archive/POST_CINCH_QA_DESIGN_DOCS.md` in the same commit as the other 2026-05-29 archive moves.
