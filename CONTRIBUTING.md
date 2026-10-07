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

The API, Discord bot, worker, and MCP server are separate processes. The web app is built as static files. The package boundaries and dependency rules are described in [Architecture](docs/ARCHITECTURE.md).

## Run locally

Use Node.js 22 or newer. From the repository root:

```sh
npm ci
cp env.example .env
npm run dev
```

The development command starts the API, web app, and MCP server; it starts the Discord bot and worker when their required credentials are configured. The panel is available at `http://localhost:5173`. Follow [Running locally](docs/RUNNING_LOCALLY.md) for environment values, sign-in, Discord setup, and troubleshooting.

Run `npm test` for unit and integration checks, and `npm run e2e` for browser tests. The full pull-request gates and board workflow are maintained in [Contributor workflow](docs/CONTRIBUTING.md).

## Deployment

Production runs on a single DigitalOcean Droplet. Nginx serves the static web app and handles public HTTPS traffic; PM2 supervises the API, bot, worker, MCP server, and operations monitor. A push to `master` deploys after CI passes. The deployment workflow is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), with the server-side procedure in [`scripts/deploy.sh`](scripts/deploy.sh).

See [Deploying to a Droplet](docs/DEPLOY_DROPLET.md) for provisioning and production configuration. The [App Platform assessment](docs/DEPLOY_APP_PLATFORM.md) explains why that hosting model is not the current deployment target.

## Developer automation

- `scripts/dev.mjs` starts the local processes and coordinates shutdown.
- `scripts/board/` derives, synchronizes, and updates project-board state from the specification and roadmap.
- Other `scripts/` tools support deployment, health checks, Discord configuration checks, and targeted maintenance. Check each script's help or header before running it against production.
- `.github/workflows/ci.yml` runs checks, validates the generated board manifest, and deploys successful changes to `master`.
- `.github/workflows/droplet-ops.yml` exposes a narrowly scoped, manually dispatched maintenance operation; it defaults to a dry run.
- `.claude/settings.json` configures Claude Code hooks: protected-path checks before edits, best-effort formatting after edits, and typecheck/tests at the end of a turn. The hooks live in `.claude/hooks/` and their guard has regression tests.
- No project-managed Git hooks are configured.

## Documentation ownership

Keep each procedure in its existing source of truth and link to it rather than copying it:

| Topic                                                         | Source                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Architecture and package boundaries                           | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                     |
| Local environment and startup                                 | [docs/RUNNING_LOCALLY.md](docs/RUNNING_LOCALLY.md)               |
| Discord application and server setup                          | [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md)                   |
| Production provisioning and operations                        | [docs/DEPLOY_DROPLET.md](docs/DEPLOY_DROPLET.md)                 |
| Requirements and planned work                                 | [docs/SPEC.md](docs/SPEC.md), [docs/ROADMAP.md](docs/ROADMAP.md) |
| Branches, pull requests, board changes, and completion checks | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)                     |
| Design decisions                                              | [docs/DECISIONS.md](docs/DECISIONS.md)                           |
