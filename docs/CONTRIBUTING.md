# Contributing

How work gets from an idea to `master` in this repository. Referenced by `.claude/CLAUDE.md`,
`docs/SPEC.md` (BOARD-3) and `scripts/board/derive.mjs`.

## The specification is the source of truth

`docs/SPEC.md` describes what the system does. The GitHub project board is **generated from it** — never
hand-written — so the file's structure is load-bearing:

- A requirement is `#### <FAMILY>-<N> <Title>`, with its description in the prose beneath, up to the next
  heading. `<FAMILY>` is uppercase letters (`BOT`, `ACT`, `TEN`).
- A section is `### <N>. <Title>`.
- **Requirement ids are permanent.** An id keys a GitHub issue; renaming or renumbering one orphans that
  issue and creates a duplicate. To retire a requirement, rewrite its body to name what superseded it and
  prefix the title with `(superseded)` — never delete it.

`docs/ROADMAP.md` assigns requirements to phases on each phase's `**In scope:**` line.

> **The trap worth knowing.** A requirement id claimed by no phase silently becomes phase 0 / **Done** — it
> lands on the board pre-closed and the work is lost. Every new id must appear on an `**In scope:**` line in
> the same pull request that adds it.

See `docs/PROJECT_BOARD.md` for the board tooling itself.

## Branches

Feature branches are named `feat/<REQ-ID>-<slug>` — `feat/AUTH-3-email-verification`. Use a short
descriptive slug when no requirement id applies.

**Do not commit code to the default branch.** The exceptions are documentation (Markdown, anything under
`docs/`), `env.example`, and tooling under `scripts/`, which may go straight to the default branch.

During the platform build, `feat/PLAT-1-multi-surface-platform` is a long-lived integration branch. Phase and
slice branches target it; it is promoted to `master` at phase boundaries.

**Check for stale branches and open PRs before starting anything** — an open PR touching your files means
coordinate, not proceed. The `.claude/skills/stale-check/` skill has the commands.

## Pull requests

Every PR body includes `Closes #N`, where `N` is the board issue's number, so the card links and advances to
Done on merge.

Run the checks before opening one:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

`npm run board:derive` must leave `scripts/board/manifest.yaml` unchanged — CI fails on a stale manifest.

Cite requirement ids in code comments where you implement them (`// TEN-2`). It costs a few characters and
gives the SPEC and the code traceability in both directions.

## What "done" means

- The checks above pass.
- New behaviour has a test that **fails without the change**. A test that passes before the code is written
  is not a test of that code.
- New requirements are in `docs/SPEC.md` _and_ claimed by a phase in `docs/ROADMAP.md`.
- Judgment calls that the specification did not settle are recorded in `docs/DECISIONS.md`.

## Things that must not happen

- **Never commit a secret.** `.env` files are gitignored, but this repository is public and one `git add -f`
  is irreversible. A hook blocks the attempt; do not work around it.
- **Never commit student data.** `data/*.db`, `logs/*.log` and `results/*.csv` hold real names, emails and
  conversation transcripts. Same hook, same rule.
- **Never write a destructive migration.** Migrations run against a live database during deploy while the old
  processes are still serving, and the deploy script's rollback reverts the _checkout_, not the data. Expand
  → migrate → contract, across two releases.

## Agent-assisted development

This repository is built with a supervisor/developer agent split defined in `.claude/agents/`. The
guardrails in `.claude/hooks/` are deterministic and tested (`npm test`) — they are not advisory, and a
blocked action is a signal to stop and report, not an obstacle to route around.
