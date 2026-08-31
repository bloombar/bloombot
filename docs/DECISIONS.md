# Decisions

A running record of judgment calls made during the platform build, so "why is it like this?" has an answer
that outlives the conversation that produced it.

Each entry states the **problem**, the **choice**, what was **not** chosen and why, and the **limits** of the
choice — the conditions under which it should be revisited. Entries recording a decision _not_ to build
something, or reversing an earlier call, are as valuable as the rest.

Newest last.

---

## D-1 — The bot is rewritten in TypeScript rather than kept in Python

**Problem.** The web control panel is TypeScript (Vite + React + Express + zod). The bot is Python
(`discord.py`, ~1,100 lines across `response_bot.py` and `discord_manager.py`). A multi-tenant platform needs
both to share a tenant model, a config schema, and a data layer.

**Choice.** Rewrite the bot in TypeScript (discord.js 14 + the OpenAI Node SDK). One language, one toolchain,
one set of zod schemas shared end to end, one deployment story.

**Why not keep Python.** A polyglot monorepo would have kept the existing pytest suite and the proven
`responses.create` call, at the cost of two toolchains, two CI jobs, and a tenant/config contract duplicated
by hand on both sides — where the two copies drifting is a cross-tenant data leak rather than a type error.

**Limits.** The rewrite is the highest-risk work in the plan and touches the only component already serving
real students, which is why Phase 4 does it before any web work and pins the surviving behaviour with tests
(see SPEC BOT-*). If the port proves unable to reproduce current behaviour, the fallback is to keep the
Python bot reading tenant config from the shared database — recoverable, but it costs the shared schema.

---

## D-2 — SQLite is kept, but the data model is written to be portable

**Problem.** A multi-tenant platform with three writing processes (bot, API, worker) on one droplet.

**Choice.** Stay on SQLite with WAL, `busy_timeout`, one shared data package, and Drizzle — but hold the
schema and every query to a portable subset so Postgres is a configuration change rather than a rewrite.

**Why not Postgres now.** It is the technically safer answer for concurrent writers, and it was explicitly
considered and declined: the operational cost of a second daemon to install, secure, back up, monitor and
deploy is not yet earned by the load, and WAL handles a single-host deployment with room to spare.

**Limits.** This holds only while the deployment is single-host. The rules that keep the escape hatch open —
all SQL confined to `packages/db/src/repos/`, no SQLite-only idioms outside `migrations/`, the job-claim
dialect split isolated behind one repo function, full-text search behind a `SearchIndex` port rather than
FTS5 directly, money as INTEGER micros — are load-bearing, not stylistic. Breaking any of them quietly
converts "a config change" into "a rewrite". A CI migration-parity check keeps the claim honest.

---

## D-3 — Stored OpenAI prompt ids are replaced by instructions held in the database

**Problem.** Course prompts live as `prompt_id` references to the OpenAI dashboard. Tenants will not have an
OpenAI account, so they can never author or inspect one.

**Choice.** Store instruction text in `courses.instructions` and pass it inline to `responses.create`.
Version it in `course_instruction_revisions`. Keep `courses.prompt_id` as a nullable escape hatch: when set
it wins, so the two existing courses behave identically on day one.

**Why not manage stored prompts through the API on tenants' behalf.** It mirrors, as an opaque external
artifact, a field that already exists in `bot_config.yml` — and it keeps a failure mode ("the prompt id was
deleted in the dashboard") that cannot be diagnosed from the control panel.

**Limits.** Inline instructions are re-sent on every request, so a very long instruction has a token cost a
stored prompt would not. Revisit if instruction length becomes material.

---

## D-4 — Conversations and daily limits key on (course, person), not on a surface account

**Problem.** Today's in-memory maps key on the Discord member object, so a student in two courses shares one
conversation and one budget, and both reset on every deploy.

**Choice.** `bot_conversations` and `usage_counters` key on `(course_id, end_user_id)`, where `end_user_id`
identifies the person across Discord, web and MCP. `courses.max_requests_per_day` is that person's allowance
**in that course**, not a pooled course total.

**Why not key on the surface account.** Context would not follow a student from Discord to the web chat, and
a daily limit could be evaded by switching surface.

**Limits.** Cross-surface continuity is not always wanted — an instructor may consider a web session distinct
from a Discord thread. `courses.conversation_scope` (`course` | `course_surface`) exists for that.

---

## D-5 — Platform-admin review is per slice, by a different agent, with bounded rework

**Problem.** The supervisor delegates implementation and therefore sees summaries rather than every edit.

**Choice.** Every slice is reviewed by two fresh-context agents that did not write it: `/code-review` for
correctness and `spec-reviewer` for conformance. `spec-reviewer` **re-runs the brief's check itself** rather
than trusting reported output. Findings are triaged, not auto-applied, on a three-tier bar. Re-review is
capped at two rounds; a third means the slice was mis-scoped and gets re-split.

**Why not the documented two-session Writer/Reviewer pattern.** It requires a human to relay findings between
windows on every slice, which is incompatible with running unattended to a first draft. A reviewer subagent
preserves the property that matters — a fresh model that did not write the code does the grading — without
the relay.

**Limits.** A reviewer asked to find gaps will find some even when the work is sound. The three-tier bar and
the two-round cap exist to stop that becoming defensive scaffolding and tests for impossible cases.

---

## D-6 — Auto-merge stops at the integration branch

**Problem.** Slices should merge on green and move on, without waiting on a human.

**Choice.** Slice and phase PRs targeting `feat/PLAT-1-multi-surface-platform` auto-merge on green
(`gh pr merge --auto --squash --delete-branch`). Promotion from the integration branch to `master` stays
manual.

**Why not auto-merge to master too.** `.github/workflows/ci.yml` gates its deploy job on `refs/heads/master`
and pushes to the droplet running the live bot for real students. Auto-merging there is auto-deploying to
production, which is a different category of action — and Phase 4 _is_ the production cutover.

**Limits.** Auto-merge is only meaningful once required status checks are configured on the integration
branch; without them `--auto` has nothing to wait for and merges immediately. Listed on the handover
checklist.

---

## D-7 — Agent guardrails are hooks, not instructions

**Problem.** `data/data.db` holds 99 real students' names, emails and 927 conversation transcripts, and a
`.env` with a live bot token and OpenAI key sits in the working tree of a public repository.

**Choice.** A blocking `PreToolUse` hook (`.claude/hooks/guard-paths.sh`) refuses writes to `data/*.db`,
`.env*`, `logs/*.log` and `results/*.csv`, and refuses `git add -f` and commands that delete or overwrite the
live database. It has its own regression tests in `npm test`.

**Why not a CLAUDE.md rule.** CLAUDE.md is advisory and competes for attention with everything else in the
file; a hook is deterministic and cannot be forgotten mid-session.

**Limits.** The guard is scoped to `data/` rather than every `*.db`, because the test suites deliberately
write throwaway databases under `tmp/` and blocking those would break the build instead of protecting
anything. It guards modification, not inspection: reads are allowed, so it is not a defence against
exfiltration by a hostile agent — it is a defence against accident.
