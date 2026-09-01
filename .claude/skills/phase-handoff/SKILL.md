---
name: phase-handoff
description: The brief template and definition of done for handing a slice to developer-agent. Use when scoping work on the platform build.
---

# Handing off a slice

A slice is work small enough that its **diff can be reviewed in one pass**. Not a phase. If you cannot
describe the change in a few sentences, split it.

## The brief template

A brief without a runnable check is not ready to hand over. That check is the whole point: it is what lets
the loop close without a human watching it.

````markdown
## Slice: <short name>

**Phase:** <n> — <phase title>
**SPEC ids:** <FAMILY-N, …> (must already exist in docs/SPEC.md and be claimed in docs/ROADMAP.md)
**Branch:** feat/<REQ-ID>-<slug>, cut from feat/PLAT-1-multi-surface-platform

### Goal

One paragraph. What exists after this slice that did not before.

### Files and interfaces

- `path/to/file.ts` — what it must contain
- Reuse `existingHelper()` from `packages/…` rather than writing a new one

### Out of scope

Explicitly. Name the adjacent things you do NOT want touched — this is the line that keeps the diff
reviewable, and the reviewer checks it.

### Verification

```bash
<the exact command, and what its output must show>
```
````

### Notes

Prior art in this repo or in the sibling slide-machine repo, and any decision already taken that constrains
the implementation.

```

## Definition of done

- `npm run lint && npx prettier --check . && npm run typecheck && npm test` pass
- Both reviewers have run and every **must-fix** finding is resolved
- New behaviour has a test that **fails without the change**
- `npm run board:derive` leaves `scripts/board/manifest.yaml` unchanged
- New requirements are in `docs/SPEC.md` **and** claimed by a phase's `**In scope:**` line in
  `docs/ROADMAP.md` — an unclaimed id silently becomes phase 0 / Done
- Requirement ids cited in code comments where implemented
- Judgment calls the brief did not settle are recorded in `docs/DECISIONS.md`
- The PR body carries `Closes #N`

## The loop

1. Run `stale-check`. An open PR touching these files means coordinate, not proceed.
2. `npm run board:status -- "In progress" <ids>` — the board is the only place anyone else can see what is
   underway, and nothing moves it automatically (BOARD-4).
3. Spawn `developer-agent` with the brief.
4. Run `/code-review` and `spec-reviewer` in parallel on the diff. Effort scales with blast radius — high for
   authentication, tenant scoping, access policies, the MCP tool surface, migrations, or the cost ledger.
5. Triage. **must-fix** → back to the developer. **cheap-fix** → only within files already touched.
   **note** → `docs/DECISIONS.md` or a ROADMAP line, and ship.
6. Commit, push, open the PR with `Closes #N` (verify the number — issues are not numbered in family order),
   then `npm run board:status -- "In review" <ids>` and set auto-merge.
7. When it merges: `npm run board:status -- Done <ids>`, and commit the manifest change on the integration
   branch. `Closes #N` does not fire on a merge into a non-default branch, so this is the only thing that
   moves the card.

**Two rounds of rework, maximum.** A third means the slice was mis-scoped rather than merely wrong — re-split
it and write a sharper brief. Grinding on a bad brief is the most expensive thing this loop can do.
```
