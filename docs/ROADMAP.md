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

**In scope:** PROJ-4, PROJ-5, TEN-7, TEN-8, WEB-7, WEB-8, WEB-9, QA-8

## Phase 8 — Job runner, throttling & server scaffolding

Background jobs, and the foreground admission layer that stops thirty students at the
start of a lecture becoming thirty concurrent model calls.

**In scope:** JOB-1..5, SRV-6..9

SRV-9 was found in use, not in review: scaffolding grants itself access to the categories it
creates and to categories it adopts, but an instructor's own channels inside those categories
keep whatever overwrites they had, so the bot stays locked out of exactly the channels a course
was already using.

## Phase 9 — Roster import & student channels

**In scope:** ROST-9..12

## Phase 10 — Knowledge files & instructions

**In scope:** FILE-1..5, WEB-18, MDL-8, WEB-19

WEB-19 is the third instance of the same shape in this phase, found while building the second:
the versioned-instruction actions were built and reviewed, and the panel never called them.

WEB-18 and MDL-8 were found in use, after the phase closed. FILE-1..5's backend, actions and
provider round trip were all built and reviewed, and no screen was ever scoped to reach them — the
same capability-without-a-surface shape as LINK-10. MDL-8 came out of the same look: a course with
a stored prompt id silently ignores its own instructions, so FILE-4's versioning is dead there and
nothing tells the instructor.

## Phase 11 — Cost ledger, usage caps & monitoring

**In scope:** COST-1..6

## Phase 12 — Web student chat surface

The surface that makes the platform more than a Discord bot: a student asks in a browser
and gets the same course, the same conversation and the same allowance they would in
Discord. That is why the identity rules land here rather than being invented per surface.

Connecting is part of this phase, not a follow-up: LINK-1 declines anybody the platform
cannot attribute to a connected account, so the gate and the way through it have to ship
together. A build that has the gate and no connect surface answers nobody.

**In scope:** PPL-4/5, WEB-10..17, LINK-1..10, ENRL-1..6, CONV-4

CONV-4 was found by a reviewer chasing an end-to-end test flake to its cause rather than
retrying it away: `answerQuestion` catches a failed `appendMessage` and continues, so under the
write contention four processes sharing one SQLite file actually produce, a student can be
answered while the record of it is dropped.

LINK-10 was found by reviewing LINK-6..9 rather than planned: connecting creates a *person*, and
the panel's switcher is built from *memberships*, so the browser half of the payoff does not
land until the two are reconciled. It is scoped separately because it is a read-surface change —
a new "organizations I am connected into" concept — rather than anything to do with proving an
identity.

## Phase 13 — MCP server & agent access

**In scope:** MCP-1..5

## Phase 14 — Admin console, transcripts, audit & export

**In scope:** ADMIN-1..5

## Phase 15 — Production hardening

**In scope:** OPS-8..14, AUTH-5

AUTH-5 lands here rather than with the rest of authentication because it was found here:
production hardening is what surfaced that `apps/api` cannot start under `NODE_ENV=production`
at all, since the only mail transport is a development stand-in that is refused there. A
deployment nobody can sign in to is not a deployment.

## Phase 16 — Course admission surfaces

Every way into a course exists in the action layer and nowhere else: a join link can be
created and revoked but never redeemed, a roster can be imported only by dispatching an
action by hand, and the enrolment relation admits students while quietly leaving the
instructors and assistants who ask the same course through the same channels out of it. This
phase makes admission something a person can actually do — issue a link, hand it out, redeem
it as yourself, upload a roster with its format stated on the screen — and makes asking a
course you are taught through enough to be enrolled in it, whichever role carried you there.

**In scope:** ENRL-7/8/9, WEB-20/21/22
