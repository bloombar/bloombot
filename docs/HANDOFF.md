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

| PR  | what                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #74 | supervisor/developer agent workflow, tested `PreToolUse` guard, hooks, skills, `CONTRIBUTING.md`, `PROJECT_BOARD.md`, `DECISIONS.md` |
| #76 | SPEC §12–17 (31 requirements across PLAT/ACT/AUTH/TEN/PROJ/QA), roadmap phases 3–15, board config for 15 phases and 14 families      |

## In flight

**`feat/PLAT-3-monorepo-scaffold`** (commit `18744a4`, pushed, **no PR yet**) — Phase 3 slice 1: npm
workspaces, `packages/config`, `packages/logger`, `packages/schemas`. Implementer reports lint, prettier,
typecheck clean; 23 node-test assertions plus 45 vitest tests passing; board manifest unchanged.

**Next action: review it before opening the PR.** Run `/code-review` and the `spec-reviewer` agent against
`git diff origin/feat/PLAT-1-multi-surface-platform...feat/PLAT-3-monorepo-scaffold`. Points to weigh:

1. Does `npm test` still run `.claude/hooks/*.test.mjs`? Those tests protect the live student database;
   silently dropping them is a serious finding. Verify from the output, not the script.
2. Is `isAdminEmail` genuinely per-call? A module-level cache defeats AUTH-4.
3. Does anything run at import time in the three packages (PLAT-5)? `CONFIG` is a Proxy for this reason —
   check the Proxy does not evaluate eagerly.
4. `packages/schemas` must depend on zod and nothing else in the workspace.
5. It added `.prettierignore` covering 11 pre-existing files it did not author. Judge whether that is
   justified or hides a real formatting problem. `scripts/board/manifest.yaml` genuinely must stay
   byte-identical or the board diff check fails.

## Queued follow-ups

- **The PLAT-2 boundary lint rule has no regression test.** It was verified by live `eslint --stdin` output,
  but a silent regression in it is exactly the QA-5 failure mode. Needs a vitest project outside
  `packages/*`.
- Phase 3 slice 2: `packages/db` — Drizzle schema, migrations, org-scoped repos.
- Phase 3 slice 3: `legacy:import` bringing `bot_config.yml` and a **copy** of `data/data.db` in as tenant 1.
- Phases 4 and 8–15 carry roadmap narrative but no requirement ids yet; their SPEC sections land with them.

## Working notes

- Spawn implementation agents with **worktree isolation**. Subagents share this checkout, so a running
  agent switches the supervisor's branch out from under it.
- Agent definitions in `.claude/agents/` load at session start. Creating one mid-session does not register
  it; the fallback is `general-purpose` with the role inlined, which works.
- `.claude/settings.local.json` is globally gitignored, so permissions are per-machine and not shared.
