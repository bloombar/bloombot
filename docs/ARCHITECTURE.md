# Architecture

How the platform is put together, and why. The requirements this satisfies are `PLAT-1`, `PLAT-2` and
`PLAT-5` in [SPEC.md](SPEC.md) §12; the judgment calls behind it are in [DECISIONS.md](DECISIONS.md).

This describes the JavaScript platform being built on `feat/PLAT-1-multi-surface-platform`. The Python bot
in the repository root is the system currently serving students; it is untouched by this work and is
promoted out of the way only when an operator decides to cut over.

## One repository, many packages

The system is an **npm-workspaces monorepo**: one repository, one lockfile, one `npm test`, but each unit
of the system is a separate package with its own `package.json`, `tsconfig.json` and `tests/` directory.

```
packages/   libraries — no process of their own
apps/       processes — the things with a main()
e2e/        Playwright specs and the fake upstreams they run against
scripts/    repository tooling (the project board sync, deploy)
```

`packages/` and `scripts/` exist today; `apps/` arrives with the Discord bot and `e2e/` with the first
change that spans front- and back-end. The table below marks what is built.

A package is a unit of **dependency and testing**, not a unit of release. These are workspace packages, not
independently published ones: they share a lockfile, version together, and `@bloombot/*` resolves to local
source rather than to a registry. The discipline here is architectural, not a distribution strategy.

### The packages, and what each owns

| package                  | owns                                                          | may depend on           |
| ------------------------ | ------------------------------------------------------------- | ----------------------- |
| `packages/schemas`       | zod contracts, including the legacy `bot_config.yml` schema    | **zod, and nothing else** |
| `packages/config`        | the environment parsed once against a schema; admin allowlist  | zod                     |
| `packages/logger`        | structured JSONL logging                                       | —                       |
| `packages/db`            | schema, migrations, and the organization-scoped repositories    | config, logger          |
| `packages/core`          | the answering pipeline and message routing                      | db                      |
| `packages/openai`        | the model adapter — the only package that knows the vendor      | core, config, logger    |
| `packages/legacy-import` | the one-shot importer from the Python system's database         | db, schemas             |
| `apps/bot` _(in flight)_ | the Discord gateway process                                     | core, db, the surface   |

Dependencies point one way and the graph is acyclic. Nothing in `packages/` imports from `apps/`.

## Ports and adapters

Where the platform meets something it does not control — a model provider, a chat network, a mail sender —
the **consumer defines the interface and the vendor code implements it**, rather than the consumer importing
a vendor SDK directly.

`packages/core` declares a `ModelClient`: a question and its context in, an answer out. It never imports an
SDK. `packages/openai` implements that interface against the Responses API. The same shape applies to the
Discord surface: the testable logic takes a plain inbound message and an outbound `reply` port, and
`discord.js` appears only in `apps/bot`.

Three things follow, and they are the reason for the arrangement rather than pleasant side effects:

- **The pipeline is testable without infrastructure.** The whole answering path runs against a fake model
  with no network at all, and the adapter itself runs against a fake upstream on loopback. No test needs an
  API key; a test run costs nothing and reaches nothing.
- **A second provider is an adapter, not a rewrite.** A different model vendor — or a self-hosted model for
  an institution that requires one — is a new package implementing the same interface.
- **The seam is where the awkward vendor behaviour lives.** Retries, timeouts, citation markers, a
  conversation id the provider has forgotten: all of it stays inside the adapter instead of leaking into the
  logic that decides what to say.

## Boundaries are enforced, not documented

A boundary that exists only in a document is a boundary that will be crossed. Each of these fails the build:

- **`apps/web` may import `packages/schemas` and nothing else from the workspace.** An ESLint
  `no-restricted-imports` rule blocks the rest. This is not tidiness — importing the data or configuration
  packages into a browser bundle would ship `BOT_TOKEN` and `OPENAI_API_KEY` to every visitor.
- **`packages/schemas` may not import any workspace package.** Without this the rule above is decorative:
  `schemas` could import `config`, and `apps/web` would pull the credential surface in transitively through
  the one import it is allowed.
- **No vendor SDK outside its adapter.** Source-level tests fail if `packages/core` imports one, or if a
  provider hostname appears anywhere in `packages/openai`'s sources — the base URL is configuration, which
  is what makes the fake upstream possible.
- **Every data-access function takes the organization id first** (`TEN-2`). A test walks the exported
  functions of `packages/db/src/repos/` and fails on one that does not.

## Nothing happens at import time

Importing a module opens no connection, reads no configuration file, constructs no client and writes no
output (`PLAT-5`). Connections and clients come from factory functions called explicitly.

The current Python system does all four, which is why its configuration cannot be reloaded, scoped per
tenant, or tested without a live database — `models/base.py` connects to SQLite as a side effect of being
imported. Here, `CONFIG` is a proxy that validates the environment on first *access*, so importing the
configuration package can never throw or capture an environment a test had not finished setting up.

## The data layer is where tenancy lives

Every scoped record carries an organization id, and every repository function takes it as its first
parameter and puts it in the query (`TEN-1`, `TEN-2`). There is no function that fetches a scoped record by
its own id alone. Tenant isolation is therefore a property of the data layer rather than a rule each route
handler has to remember — and the two places a reviewer found it broken were both caught because the rule is
specific enough to check mechanically.

All SQL is confined to `packages/db/src/repos/`. That is what keeps `D-2`'s escape hatch to Postgres real:
the schema and queries stay inside a portable subset, so a move off SQLite is a configuration change rather
than a rewrite. Callers — including the legacy importer — write through the repositories, never with SQL of
their own, so imported data obeys the same scoping and collision rules as data created by hand.

## Processes

Four processes are planned, each single-instance (`PLAT-4`): the Express API, the Discord bot, the
background worker, and the static web build served by nginx. Only the bot exists so far.

`apps/bot` holds the **only** gateway connection (`PLAT-3`); the API and worker reach Discord over REST with
the same token, so there is no inter-process coordination to get wrong. Two gateway connections on one token
is an error, not redundancy.

## Testing follows the same shape

Each package tests itself, and one root `vitest` configuration runs them as separate projects with aliases
pointing at TypeScript source rather than built output — asserting against a stale `dist/` is the kind of
green that hides a regression for a week.

The coverage floor is enforced on the logic that matters — `packages/db/src/repos`, `packages/core`,
`packages/openai` — rather than as a blanket percentage across the tree, and tests use throwaway databases
under `tmp/`. Never `data/data.db`: it holds real students' names, emails and conversation transcripts, and
a `PreToolUse` hook blocks writes to it.

## What this arrangement costs

Worth stating, since every architecture has a bill:

- More scaffolding per unit of behaviour — a new package means a `package.json`, a `tsconfig.json`, project
  references, a vitest project and a coverage entry.
- Interfaces to keep honest. A port that grows to mirror one vendor's API stops being a port; when the model
  port needed the student's name, the fix was to widen it deliberately and note it, not to let the adapter
  reach around it.
- Cross-package changes touch more files than they would in a single module, which is the trade for having
  the boundary at all.
