# Instructions to Claude

## Testing

New behaviour needs a test that **fails without the change** — a test that passes before the code is written
is not a test of that code. Unit and integration tests throughout; for changes spanning front- and back-end,
Playwright e2e against live front- and back-ends with a live test database. All passing tests must stay
reproducible as regression tests.

Coverage is enforced as a floor on the logic that matters — `packages/core`, `packages/actions`,
`packages/db/repos` — rather than a blanket percentage across the whole tree (see `docs/DECISIONS.md`).

Never point a test suite at `data/data.db`; test databases live under `tmp/`.

## Code conventions

### Formatting

Use ESLint and Prettier for linting and formatting, following defaults.

### Comments

Leave comments explaining any large block of complicated code. Include function-level and module-level comments. Avoid jargon and keep comments concise.

### Check for staleness

Always check for stale branches and PRs before starting a new task — run the `stale-check` skill. An open PR
touching your files means coordinate, not proceed.

### Workflow

An initial specification is written into docs/SPEC.md. This is the general plan for the project, although we may decide to change it along the way.

The project-board sync (`scripts/board`) parses docs/SPEC.md, so keep these formats when editing it:

- **Requirements are `#### <ID> <Title>` subheadings** — `<ID>` is `FAMILY-N` (uppercase family letters, hyphen, number; e.g. `GEN-6`, `AUTH-1`). The prose beneath the heading, up to the next heading, becomes the issue body — put the requirement's description there.
- **Sections are `### <N>. <Title>` headings** (e.g. `### 4. Accounts & Authentication`); they label a requirement's section.
- **Never change an existing ID** — it keys the issue; renaming or renumbering orphans the old issue and creates a new one.

## Git & project-board workflow

Changes are tracked on the GitHub project board and follow a branch → PR flow so the board automation works (details: `docs/CONTRIBUTING.md`, `docs/PROJECT_BOARD.md`). Follow this **by default**:

- **Do not commit code changes directly to the default branch.** Create a feature branch named `feat/<REQ-ID>-<slug>` (e.g. `feat/AUTH-3-email-verification`; use a short descriptive slug when no requirement id applies). **Exception:** documentation (Markdown and anything under `docs/`), `.env.example` files, and project tooling under `scripts/` may be committed directly to the default branch without a PR.
- **Open a pull request** whose description includes `Closes #N` — `N` is the board issue's number, one line per requirement the PR satisfies — so the change and the requirement stay linked. Check the number first: board issues are not numbered in family order, and a wrong one closes somebody else's requirement. Commit and push only when asked, and run the pre-PR checks first (`npm run lint && npm run format:check && npm run typecheck && npm test`).
- **Move the card yourself (BOARD-4).** `Closes #N` fires only on a merge to the **default branch**, and slice branches target `feat/PLAT-1-multi-surface-platform`, so no card ever moves on its own. Run `npm run board:status -- "In progress" <ids>` when a slice starts, `-- "In review" <ids>` when its PR opens, and `-- Done <ids>` when it merges, and commit the manifest change the script makes.
- **Do not hand-create board issues.** The board is generated from the SPEC via `npm run board:derive` then `npm run board:sync` (see docs/PROJECT_BOARD.md).

If asked to use a different workflow (e.g. commit straight to the default branch), **remind the user that it diverges from this flow and confirm before proceeding** — then honor the confirmed request.

## Protected paths

**IMPORTANT:** `data/*.db`, `.env*`, `logs/*.log` and `results/*.csv` hold real student names, emails and
conversation transcripts, or live credentials on a public repository. A `PreToolUse` hook
(`.claude/hooks/guard-paths.sh`, tested in `npm test`) blocks writes to them. A block is a signal to stop and
report — never route around it.

## Agent workflow

Implementation runs as a supervisor/developer split: `.claude/agents/developer-agent.md` implements a scoped
slice against a brief, `.claude/agents/spec-reviewer.md` reviews the diff in fresh context, and the agent
doing the work is never the one grading it. The brief template and definition of done are in the
`phase-handoff` skill. The plan being built is summarised in `docs/SPEC.md` and `docs/ROADMAP.md`; decisions
made along the way are in `docs/DECISIONS.md`.
