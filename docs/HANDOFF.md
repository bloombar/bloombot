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

| PR   | what                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #74  | supervisor/developer agent workflow, tested `PreToolUse` guard, hooks, skills, `CONTRIBUTING.md`, `PROJECT_BOARD.md`, `DECISIONS.md` |
| #76  | SPEC §12–17 (31 requirements across PLAT/ACT/AUTH/TEN/PROJ/QA), roadmap phases 3–15, board config for 15 phases and 14 families      |
| #108 | Phase 3 slice 1 — npm workspaces, `packages/config`, `packages/logger`, `packages/schemas`, TS project references, vitest, CI gates  |
| #109 | Phase 3 slice 2 — `packages/db`: SQLite engine, migrations, and the tenant-scoped repos for organizations, accounts, memberships and Discord-server bindings (TEN-1..3) |

The board issues for the platform requirements now exist (#77–#107): PLAT-1..5 are #77–#81, QA-1..6
#82–#87, ACT-1..6 #88–#93, AUTH-1..4 #94–#97, TEN-1..6 #98–#103, PROJ-1..4 #104–#107. `npm run board:sync`
had never been run since the SPEC merged, so there was nothing for a PR to close.

`master` was merged into this branch on 2026-08-31 (D-6's rule about not letting the promotion become a
conflict resolution). Its roadmap had collapsed to two phases and its `scripts/board/config.mjs` to two
milestones — both predate the fifteen-phase plan, so the conflict was resolved in favour of this branch's
structure, keeping master's newer status facts.

## In flight

Nothing. Phase 3 slice 3 is the next thing to start.

## Queued follow-ups

- **The PLAT-2 boundary lint rule now covers `packages/schemas` as well as `apps/web`** — that gap was
  found in review of #108 and closed. It still has no regression test of its own (a vitest project outside
  `packages/*` running `eslint --stdin`), which is the QA-5 failure mode.
- Phase 3 slice 3: projects and courses — the schema and org-scoped repos behind PROJ-1/2/3. Move those
  ids into phase 3 in the ROADMAP when the slice lands, the way TEN-1..3 were.
- Phase 3 slice 4: people, conversations and messages — the tables the conversation core needs.
- Phase 3 slice 5: `legacy:import`, bringing `bot_config.yml` and a **copy** of `data/data.db` in as
  tenant 1. Never the live file.
- Phases 4 and 8–15 carry roadmap narrative but no requirement ids yet; their SPEC sections land with them.

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
