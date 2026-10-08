# Contributor workflow

How work gets from an idea to `master` in this repository. For a map of the codebase and local setup, start
with the root [CONTRIBUTING.md](../CONTRIBUTING.md). Referenced by `.claude/CLAUDE.md`,
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

See `docs/PROJECT_BOARD.md` for the board tooling itself, and `docs/ARCHITECTURE.md` for how the code is
arranged — the package boundaries it describes are enforced by lint rules and tests, so a change that
crosses one fails the build rather than the review.

## Branches

Feature branches are named `feat/<REQ-ID>-<slug>` — `feat/AUTH-3-email-verification`. Use a short
descriptive slug when no requirement id applies.

**Do not commit code to the default branch.** The exceptions are documentation (Markdown, anything under
`docs/`), `env.example`, and tooling under `scripts/`, which may go straight to the default branch.

Slice branches target `master`. A merge to `master` deploys to the droplet (`.github/workflows/ci.yml`), so a
PR is a release, not just a review.

**Check for stale branches and open PRs before starting anything** — an open PR touching your files means
coordinate, not proceed. The `.claude/skills/stale-check/` skill has the commands.

## Pull requests

Every PR body includes `Closes #N`, where `N` is the board issue's number — one line per requirement the PR
satisfies — so the change and the requirement stay linked in the history.

> **Move the card explicitly anyway (BOARD-4).** `Closes #N` closes the issue when the PR merges into
> `master`, but it never moves a card to `In progress` or `In review`. Move it at each transition:
>
> ```bash
> npm run board:status -- "In progress" TEN-1 TEN-2   # when the slice starts
> npm run board:status -- "In review"   TEN-1 TEN-2   # when the PR opens
> npm run board:status -- Done          TEN-1 TEN-2   # when it merges
> ```
>
> The script writes the status into `scripts/board/manifest.yaml` and reconciles the board with it; `Done`
> also closes the issue. Commit the manifest change — it is the board's source of truth (BOARD-4).

Check the issue number before writing it. Board issues are not numbered in requirement-family order, and a
wrong number closes somebody else's requirement.

Run the checks before opening one:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run e2e
```

**`npm test` does not run the Playwright suite.** `npm run e2e` is a separate command — its own `pree2e`
builds first, and it takes a few minutes. Skipping it is how a change to a shared screen ships green here
and fails in CI.

`npm run board:derive` must leave `scripts/board/manifest.yaml` unchanged — CI fails on a stale manifest.

Cite requirement ids in code comments where you implement them (`// TEN-2`). It costs a few characters and
gives the SPEC and the code traceability in both directions.

## Notebook outputs never reach GitHub

Notebooks may show real student data in their output cells while you work locally, but this repository is
public, so outputs are wiped by tooling rather than by remembering to (ANLY-8):

- **`.githooks/pre-commit`** rewrites the _staged_ copy of every `*.ipynb` with its outputs, execution counts
  and run metadata removed (`scripts/strip-notebook-outputs.mjs`). The file in your working tree keeps its
  outputs, so it will show as modified against the commit; that is expected.
- **`.githooks/post-commit`** strips the index copy again after a commit, because `git commit <path>` re-stages
  the working copy (outputs and all) afterwards. It only touches notebooks that differ from HEAD, so rebases and
  cherry-picks are unaffected.
- **`.githooks/pre-push`** refuses a push if any commit being sent contains a notebook with outputs, naming the
  file and commit (`scripts/check-pushed-notebooks.mjs`).
- **CI** (`npm test`) fails if any tracked notebook has outputs.

The hooks live in tracked `.githooks/` and are enabled by `npm install` (its `prepare` script runs
`git config core.hooksPath .githooks`; it does nothing outside a git checkout). If you cloned without running
`npm install`, run `npm run prepare` once. Never `git commit --no-verify` a notebook.

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

## apps/web build-time configuration

`apps/web` is a static Vite build with no server, so these settings are baked in when it is built. Vite reads
`apps/web/.env*` first, then falls back to the same key in the repository-root `.env*` files
(`apps/web/load-root-env.ts`). Changing one needs a rebuild and redeploy, not a process restart.
`docs/DEPLOY_DROPLET.md` §4.3 has the production sequence.

| Variable | Read by | Default if unset |
| --- | --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | `pages/SignIn.tsx` — the Google sign-in button. A wrong value makes the button silently do nothing (`docs/DEPLOY_DROPLET.md` §4.3). | none — Google sign-in is reported as "not configured" |
| `VITE_PUBLIC_APP_URL` | `prerender-plugin.ts` — the origin for `robots.txt`, `sitemap.xml` and the canonical links on `/privacy` and `/terms`. Also `pages/Mcp.tsx`, for the connector **icon** URL only, because the MCP client's servers fetch it, not the reader's browser; falls back to `window.location.origin`. | `https://bloombot.wonkledge.com` |
| `VITE_MCP_PUBLIC_URL` | `pages/Mcp.tsx` (WEB-47) — the MCP connector URL shown to users. **Must equal `${PUBLIC_MCP_URL}/mcp`**: `apps/mcp` derives its OAuth resource identifier from `PUBLIC_MCP_URL` at startup, and nothing checks that the two agree, so a mismatch surfaces only when a client fails to connect. Set both in the repository-root `.env`, and only once the MCP server is publicly exposed (`deploy/nginx/mcp.conf`, `docs/DEPLOY_DROPLET.md` §5.4). | none — the tab reports the connector as not configured |
| `VITE_OPERATOR_NAME` | `content/document.ts`'s `OPERATOR` — the legal entity the privacy policy and terms name throughout. | `Bloombot` |
| `VITE_OPERATOR_CONTACT_EMAIL` | `content/document.ts`'s `OPERATOR` — where a privacy or legal request should be sent. | `privacy@wonkledge.com` |
| `VITE_OPERATOR_JURISDICTION` | `content/document.ts`'s `OPERATOR` — whose law governs the terms. | `New York, United States` |
| `VITE_OPERATOR_POSTAL_ADDRESS` | `content/document.ts`'s `OPERATOR` — the Contact section's postal address line. | empty — the Contact section omits the line entirely rather than printing a placeholder |

The `VITE_OPERATOR_*` defaults are real values rather than `[placeholders]` because Google's OAuth branding
review rejects a privacy policy containing one (D-92).

## Agent-assisted development

This repository is built with a supervisor/developer agent split defined in `.claude/agents/`. The
guardrails in `.claude/hooks/` are deterministic and tested (`npm test`) — they are not advisory, and a
blocked action is a signal to stop and report, not an obstacle to route around.
