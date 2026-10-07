# Contributing to Bloombot

This guide maps the codebase and its development workflows. Detailed procedures stay in their own guides; see [Documentation ownership](#documentation-ownership) before adding instructions elsewhere.

## Architecture

Bloombot is a TypeScript npm-workspaces monorepo. `apps/` contains deployable services; `packages/` contains shared libraries. Dependencies flow from apps to packages, not the other way around.

| Path          | Responsibility                                                       |
| ------------- | -------------------------------------------------------------------- |
| `apps/web`    | Static instructor and student web interface                          |
| `apps/api`    | HTTP API, sign-in, course and organization management                |
| `apps/bot`    | Discord gateway and message handling                                 |
| `apps/worker` | Background jobs, including roster and course-file processing         |
| `apps/mcp`    | Connection point for external assistant clients                      |
| `packages/`   | Shared data, authorization, conversation, integration, and job logic |
| `e2e/`        | Browser-based end-to-end tests                                       |
| `scripts/`    | Development, deployment, and project-board tooling                   |

The API, Discord bot, worker, and MCP server are separate processes. The web app is built as static files. Package boundaries are enforced by lint rules and tests; see [Architecture](docs/ARCHITECTURE.md).

The Python files and notebooks in the repository root are the deprecated legacy bot, kept for existing installations and migration ([Cutover](docs/CUTOVER.md)). Do not build on them. Their pytest suite in `tests/`, which also checks `scripts/deploy.sh`, still runs in CI.

## Run locally

Use Node.js 22 or newer. From the repository root:

```sh
npm ci
npm run build                # workspace packages resolve to their built output
cp env.example .env          # then set DATABASE_PATH=./tmp/local.db
npm run dev
```

`env.example` points `DATABASE_PATH` at `data/data.db`, the production database location, which holds real student data — always change it for local work. `npm run dev` starts the API, web app, and MCP server, plus the Discord bot and worker when `BOT_TOKEN` is set. The panel is at `http://localhost:5173`. [Running locally](docs/RUNNING_LOCALLY.md) covers the remaining environment values, sign-in, Discord setup, and troubleshooting.

`npm test` runs unit and integration tests; `npm run e2e` runs the Playwright browser tests separately. The pre-PR checks, branch naming, and board workflow are in [Contributor workflow](docs/CONTRIBUTING.md) — read it before opening a pull request.

## Deployment

Production runs on a single DigitalOcean Droplet. Nginx serves the static web app and handles public HTTPS traffic; PM2 supervises the API, bot, worker, MCP server, and operations monitor. A merge to `master` deploys once CI passes, so treat every merge as a release. The deployment workflow is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), with the server-side procedure in [`scripts/deploy.sh`](scripts/deploy.sh).

See [Deploying to a Droplet](docs/DEPLOY_DROPLET.md) for provisioning and production configuration. The [App Platform assessment](docs/DEPLOY_APP_PLATFORM.md) explains why that hosting model is not the current deployment target.

## Developer automation

- `scripts/dev.mjs` starts the local processes and coordinates shutdown.
- `scripts/board/` derives, synchronizes, and updates project-board state from the specification and roadmap.
- Other `scripts/` tools support deployment, health checks, Discord configuration checks, and targeted maintenance. Check each script's help or header before running it against production.
- `.github/workflows/ci.yml` runs the Node and legacy Python test suites, validates the generated board manifest, and deploys successful changes to `master`.
- `.github/workflows/droplet-ops.yml` exposes a narrowly scoped, manually dispatched maintenance operation; it defaults to a dry run.
- `.claude/settings.json` configures Claude Code hooks: protected-path checks before edits, best-effort formatting after edits, and typecheck/tests at the end of a turn. The hooks live in `.claude/hooks/` and their guard has regression tests.
- No project-managed Git hooks are configured.

## Documentation ownership

Keep each procedure in its existing source of truth and link to it rather than copying it:

| Topic                                                         | Source                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Architecture and package boundaries                           | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                  |
| Local environment and startup                                 | [docs/RUNNING_LOCALLY.md](docs/RUNNING_LOCALLY.md)                            |
| Discord application and server setup                          | [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md)                                |
| Production provisioning and operations                        | [docs/DEPLOY_DROPLET.md](docs/DEPLOY_DROPLET.md)                              |
| Requirements and planned work                                 | [docs/SPEC.md](docs/SPEC.md), [docs/ROADMAP.md](docs/ROADMAP.md)              |
| Branches, pull requests, board changes, and completion checks | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)                                  |
| Web build-time (`VITE_*`) settings                            | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#appsweb-build-time-configuration) |
| Design decisions                                              | [docs/DECISIONS.md](docs/DECISIONS.md)                                        |
