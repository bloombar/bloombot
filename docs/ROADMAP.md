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

- Done: every Phase 0 requirement — the shipped baseline.
- Outstanding: BOT-11/12, DSC-7, ROST-7/8, DATA-6, OPS-6
