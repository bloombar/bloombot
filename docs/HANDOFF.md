# Handoff — JavaScript migration

Current state of the multi-phase migration. Update this at each phase boundary; delete it when the
migration merges to `master`.

The full plan lives in the approved plan file; the specification is `docs/SPEC.md` §12–17, the phase
sequence is `docs/ROADMAP.md` phases 3–15, and every judgment call is in `docs/DECISIONS.md`.

## Branches

- **`feat/PLAT-1-multi-surface-platform`** — the long-lived migration branch. All work merges here.
  Protected: three required checks (Python tests, Board tooling tests, Shell script lint), strict
  up-to-date enforcement, no force-push, no deletion.
- **`master`** — untouched. Promotion is the operator's decision and never automatic (D-6), because a
  merge there triggers a production deploy to the droplet serving real students.

## Done

Phases 3 and 4 are complete on `feat/PLAT-1-multi-surface-platform`.

| PR   | what                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| #74  | supervisor/developer agent workflow, tested `PreToolUse` guard, hooks, skills, contributing/board docs    |
| #76  | SPEC §12–17, roadmap phases 3–15, board config                                                            |
| #108 | Phase 3 — npm workspaces, `packages/config`, `packages/logger`, `packages/schemas`, TS refs, vitest, CI   |
| #109 | Phase 3 — `packages/db`: engine, migrations, organizations/accounts/memberships/bindings (TEN-1..3)       |
| #110 | Phase 3 — projects, courses, and the PROJ-3 name-collision rule (PROJ-1..3)                               |
| #112 | BOARD-4 — `npm run board:status`, because `Closes #N` never fires on a merge into a non-default branch    |
| #119 | Phase 3 — people, identities, conversations, transcripts, usage counters (PPL-1..3, CONV-1..3)            |
| #124 | Phase 3 — `packages/legacy-import` (MIG-1..4), reading a copy and refusing the live database              |
| #131 | Phase 4 — `packages/core`, the answering pipeline behind a model port (CORE-1..6)                         |
| #139 | Phase 4 — `packages/openai`, the only package that knows the vendor (MDL-1..7)                            |
| #147 | Phase 4 — `packages/discord` and `apps/bot`, the first process (SURF-1..7, PLAT-3/4)                      |

`docs/ARCHITECTURE.md` describes the shape all of this follows and which boundaries are machine-enforced.

## In flight

Nothing. **Phase 5 — API, action layer & authentication (ACT-1..6, AUTH-1..4) — is next**, and the roadmap
puts the action layer with the API deliberately: retrofitting declared authorization underneath routes that
already exist means writing every route twice.

## Board

Every requirement through phase 4 is closed and Done. Cards do **not** move on merge — `Closes #N` only fires
for a merge into the default branch, and every slice merges into the integration branch — so each slice runs
`npm run board:status -- "In review" <ids>` at PR time and `-- Done <ids>` after the merge, and commits the
manifest change. See BOARD-4 and `docs/PROJECT_BOARD.md`.

## Cutover is not done and is not automatic

The Python bot still serves students. Nothing in this branch touches `ecosystem.config.cjs`, the deploy
script, the CI deploy job or any `.env`. Promotion to `master` triggers a production deploy (D-6), so it is
the operator's decision. Before it can sensibly happen: the legacy import needs a rehearsal against a
**copy** of the live database, and `apps/bot` needs a real Discord test server.

Known divergences from the Python bot, all deliberate and recorded: the day is one request shorter (D-15),
the bot replies in place rather than posting to the channel, an over-limit request is refused out loud
rather than silently, and long answers are split (D-17).

## Working notes

- Spawn implementation agents with **worktree isolation**. Subagents share this checkout, so a running
  agent switches the supervisor's branch out from under it.
- Agent definitions in `.claude/agents/` load at session start. Creating one mid-session does not register
  it; the fallback is `general-purpose` with the role inlined, which works.
- Run implementers **in the main checkout, one at a time**, and reviewers in isolated worktrees. Worktree
  isolation gives an agent its own branch, which is wrong for an implementer whose diff the supervisor has
  to commit on the slice branch. Remove a reviewer's worktree when it reports (`git worktree remove`).
- Check the issue number before writing `Closes #N`. The board issues are not numbered in family order —
  #88–#93 are ACT, not TEN — and a wrong number closes somebody else's requirement on merge.
- `.claude/settings.local.json` is globally gitignored, so permissions are per-machine and not shared.
