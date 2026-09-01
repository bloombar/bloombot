# Bloombot — Roadmap

This file assigns each requirement in [docs/SPEC.md](SPEC.md) to a delivery phase, and
records its current status. `scripts/board/derive.mjs` reads it alongside the SPEC to
build `scripts/board/manifest.yaml`, which `scripts/board/sync.mjs` pushes to the
[project board](https://github.com/users/bloombar/projects/2).

## How this file is read

A requirement id is claimed by a phase when it appears on that phase's
`**In scope:**` line. Ranges (`BOT-1..10`) and slash-lists (`BOT-1/2/3`) both expand.

A requirement claimed by **no** phase is treated as the **shipped baseline**: phase 0,
status Done. That is deliberate — the initial SPEC documents functionality that already
works, so the default is "already built". New program work must therefore be added to a
phase's `**In scope:**` line in the same pull request that adds it to the SPEC; the
manifest diff makes a miss visible.

The `### Current status` snapshot below can override a claimed requirement's status.

## Phase 0 — Shipped baseline

Everything currently described in the SPEC: the course configuration format (`CFG`), the
`DiscordManager` client library (`DSC`), server scaffolding (`SRV`), roster ingestion and
per-student channels (`ROST`), the chatbot (`BOT`), the OpenAI integration (`AI`), the
message log and data model (`DATA`), the administration CLI (`CLI`), the analytics
notebook (`ANLY`), deployment and logging (`OPS`), and the spec/board tooling (`BOARD`).

**In scope:** claimed implicitly — every SPEC id not listed under a later phase.

## Phase 1 — Defect fixes & test coverage

Six defects found while writing the initial SPEC, plus the automated test suite and CI
that would have caught them. Each defect is specified as the behavior that must hold, in
the section of the SPEC that owns it, rather than in a separate "bugs" section that would
rot as the fixes land.

**In scope:** BOT-11/12, DSC-7, ROST-7/8, DATA-6, OPS-6

### Current status

- Done: every Phase 0 requirement — the shipped baseline — and every defect in this
  phase: BOT-11/12, DSC-7, ROST-7/8, DATA-6, OPS-6, all shipped to `master`.
- Outstanding: none here. Phase 2 shipped as well; the JavaScript migration, phases 3
  onward, is in flight on `feat/PLAT-1-multi-surface-platform`.

## Phase 2 — Continuous deployment

CI proves a commit is good; nothing yet ships it. This phase closes the loop so a merge to
`master` updates the droplet automatically, with the deployed commit visible on both ends
and an automatic rollback when the bot fails to come back up.

**In scope:** OPS-7

## Phase 3 — Monorepo & data layer

The JavaScript migration starts by building the ground everything else stands on: npm
workspaces, the shared zod contract, the tenant-scoped data layer, and a real migration
tool. Production is untouched — it keeps running the Python bot, and the legacy import
runs against a copy of the live database rather than the database itself.

**In scope:** PLAT-1/2/5, QA-1..6, TEN-1..3, PROJ-1..3, BOARD-4, PPL-1..3, CONV-1..3, MIG-1..4

## Phase 4 — Conversation core & Discord surface

The bot is rewritten in TypeScript and cut over. This is the highest-risk work in the
programme and the only component already serving real students, so it happens before any
web work rather than after: the behaviour it must preserve is easiest to verify while it
is still the only thing running. Requirement ids land with this phase's SPEC sections.

PLAT-3/4 move here from phase 3: a single gateway connection and the four-process
topology are properties this phase's own `apps/bot` is what actually satisfies them, not
the monorepo scaffold phase 3 built before any process existed to connect at all.

**In scope:** CORE-1..6, MDL-1..7, SURF-1..7, PLAT-3/4

## Phase 5 — API, action layer & authentication

The action layer lands with the API rather than after it. Retrofitting declared
authorization underneath routes that already exist means rewriting every route twice.

**In scope:** ACT-1..6, AUTH-1..4, API-1..6

## Phase 6 — Web shell & server registration

Sign-in, the control panel shell, and the Discord installation flow end to end.

**In scope:** TEN-4..6, WEB-1..6, QA-7

## Phase 7 — Projects & course configuration

The point at which the product exists: a second tenant creates a project, defines a course
in it, and the bot answers in their server without anyone editing a file in this
repository.

**In scope:** PROJ-4, PROJ-5, TEN-7, TEN-8

## Phase 8 — Job runner, throttling & server scaffolding

Background jobs, and the foreground admission layer that stops thirty students at the
start of a lecture becoming thirty concurrent model calls.

**In scope:**

## Phase 9 — Roster import & student channels

**In scope:**

## Phase 10 — Knowledge files & instructions

**In scope:**

## Phase 11 — Cost ledger, usage caps & monitoring

**In scope:**

## Phase 12 — Web student chat surface

**In scope:**

## Phase 13 — MCP server & agent access

**In scope:**

## Phase 14 — Admin console, transcripts, audit & export

**In scope:**

## Phase 15 — Production hardening

**In scope:**
