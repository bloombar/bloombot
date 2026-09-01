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

## D-6 — Auto-merge everything into the migration branch; `master` needs approval

**Problem.** Slices should merge on green and move on, without waiting on a human — but a merge to `master`
is not the same kind of event as a merge into a feature branch.

**Choice.** Every slice and phase PR targets `feat/PLAT-1-multi-surface-platform` and auto-merges on green
(`gh pr merge --auto --squash --delete-branch`), self-approved. **Promotion from that branch to `master` is
the operator's decision and is never automatic.** Direct pushes to `master` are in the permission deny list.

**Why the exception.** `.github/workflows/ci.yml` fires its deploy job on `refs/heads/master` and ships to
the droplet running the live bot for real students, so a `master` merge is a production deployment. The whole
JavaScript migration therefore lands on one long-lived branch and is promoted deliberately, not incidentally.

**Limits.** A long-lived branch accumulates divergence from `master`. Anything shipped to `master` in the
meantime — a hotfix to the Python bot — must be merged _into_ the migration branch promptly, or the promotion
becomes a conflict resolution nobody wants to review.

**Limits.** Auto-merge is only meaningful once required status checks are configured on the integration
branch; without them `--auto` has nothing to wait for and merges immediately.

**Confirmed the hard way, 2026-08-31.** The first PR (#74) did exactly that — it merged before CI finished,
because nothing was required. The checks passed afterwards, so nothing was lost, but the gate was decorative.
Branch protection is now applied to `feat/PLAT-1-multi-surface-platform` requiring **Python tests**, **Board
tooling tests** and **Shell script lint**, with `strict: true` so a branch must be up to date with its base
before merging, and force-pushes and deletions disabled. Adding a CI job means adding its name to that
protection, or the gate silently stops covering it.

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

---

## D-8 — Permissions are permissive; the hook is the safety net

**Problem.** A narrowed permission allowlist was interrupting the operator with approval prompts on routine
commands, which defeats the requirement to run unattended.

**Choice.** Broad tool permissions (`Bash`, `Edit`, `Write`) with a short deny list for the genuinely
irreversible: force-push, direct push to `master`, `git reset --hard`, `git clean -fd`, `rm -rf /` or `~`,
`ssh`/`scp`, `pm2`, and piping anything into a shell.

**Why this is not a loosening.** The real protection moved from permission prompts to
`.claude/hooks/guard-paths.sh` (D-7), which is deterministic, tested, and blocks the specific paths that
matter regardless of which tool tries to touch them. A prompt asks a human to notice; a hook does not need
anyone to be watching. Prompts were catching the wrong things anyway — `npm ls`, `git for-each-ref` — while
the thing actually worth blocking was a path, not a command.

**Limits.** The deny list is pattern-matched on the command string and can be evaded by an agent that wants
to (a differently-spelled `rm`, a script that force-pushes). It is a guard against accident, not against a
hostile agent. The same is true of the path hook: it guards modification, not exfiltration.

---

## D-9 — `DATABASE_PATH` and `SQL_LITE_DB_PATH` coexist during the migration

**Problem.** `packages/config`'s zod schema names the SQLite file `DATABASE_PATH`. The live Python bot reads
the same file through `SQL_LITE_DB_PATH` (`models/base.py`, `migrate.py`, `tests/conftest.py`), a name chosen
years before this package existed. `env.example` originally documented only the new name.

**Choice.** Keep `DATABASE_PATH` as the name in the TypeScript schema — it is the name every future
TypeScript process will read — but add `SQL_LITE_DB_PATH` to `env.example` too, as a plain documented
variable the zod schema does not know about, with a comment that both must point at the same file for as long
as the Python bot and the TypeScript platform are both writing to it.

**Why not rename one to match the other.** Renaming the Python side mid-migration touches
`response_bot.py`/`migrate.py`/`models/base.py` for no behavioural gain and widens a config-only slice into a
bot change. Renaming the TypeScript schema to the legacy name would carry the old name's awkwardness
(`SQL_LITE_DB_PATH`, not `SQLITE_DB_PATH`) into the code that has no history obligating it to.

**Limits.** Two variables naming one file is a trap for exactly the deployment this note is trying to
prevent: setting one and not the other silently forks the bot and the platform onto two different databases,
with no error until the data has already diverged. It should be deleted the moment the Python bot is retired
(D-1) and only `DATABASE_PATH` remains.

---

## D-10 — The legacy YAML schema mirrors the Python reader's optionality, not the ideal shape

**Problem.** `packages/schemas/legacy-yaml.ts` originally required `openai_assistant.name`, `instructions`,
`vector_store_id`, `model` and `limits.max_requests_per_day`. `response_bot.py` never reads `name` or
`instructions` at all, and reads `model`, `vector_store_id` and `limits.max_requests_per_day` with
`oa_config.get(key, default)` — so a course that has never set one of those keys runs today, and the stricter
schema would have rejected its own config file the moment it was pointed at a course omitting one.

**Choice.** Make those fields `optional()` rather than required, and leave their defaults where the bot
applies them (`OPENAI_DEFAULT_MODEL`, `OPENAI_DEFAULT_MAX_REQUEST_PER_DAY`, `None`) instead of duplicating the
default value inside the schema. `prompt_id` stays required: without it the bot logs a warning and never
answers in that course (`response_bot.py:208`), so a course missing it cannot function even though the
reader does not crash on the missing key.

**Why not tighten instead of loosen.** A schema stricter than the code it models reads like a specification
of how `bot_config.yml` _should_ look, but its job here is narrower: catch a typo before the bot silently
answers nobody, without also rejecting a file the bot itself accepts. Tightening these fields is a legitimate
future change — once the schema is the thing authors are told to satisfy, rather than a check against a
reader nobody has changed yet — but it is a decision about the format, not a bug in this slice.

**Limits.** Because the schema now permits what the reader tolerates, a course silently missing a field
(nobody ever set `model`) parses identically to one that intentionally omitted it. If that distinction ever
matters, it needs the config format to say so explicitly, not a stricter schema.

---

## D-11 — `packages/db`: two unscoped repo functions, application-generated ids, and app-set timestamps

**Problem.** TEN-2 requires that "every data-access function takes the organization id as its first
parameter" and that "there is no function that fetches a scoped record by id alone" — but `accounts` and
`discord_server_bindings` each have exactly one operation that cannot satisfy that literally, because the
organization is not yet known at the point the function is called.

**Choice.** Two documented exceptions, enforced by an allowlist a test checks against (rather than left as a
comment nobody re-reads):

- `accounts.getAccountByEmail(email, db)` — an account is a sign-in identity, not something scoped to one
  organization (the same account can belong to several, through `memberships`), and it has to be found by
  email _before_ sign-in knows which organization is relevant. Every other function in `accounts.ts` reaches
  the account through an organization's membership instead (`getAccountInOrganization`), so a cross-tenant
  read still looks like absence (TEN-5).
- `discord-servers.resolveDiscordServerBinding(serverId, db)` — this _is_ the lookup that establishes which
  organization an incoming Discord message belongs to; it cannot itself take an organization id as input
  without begging the question. It returns `undefined` for both an unbound server and a released one
  (`removed_at` set), which is the correct behaviour either way: no organization currently owns that server's
  messages.

Everything else — including `organizations.ts`'s own `createOrganization`/`getOrganizationById`, where the
"organization id" being scoped by is the row's own id — takes `organizationId` as its first parameter, and
`tests/tenant-scoping-convention.test.ts` reads the actual source of `src/repos/**` to prove it, rather than
trusting every future PR to remember the rule.

**Ids and timestamps.** Every primary key is an application-generated UUID (`crypto.randomUUID()`, called in
the repo layer or supplied by the caller — `organizations.createOrganization` takes its id as an argument, the
same way every scoped function takes its scoping id as one), not `AUTOINCREMENT`: an auto-incrementing integer
key is a SQLite/Postgres detail a schema held to D-2's portable subset should not depend on, and it lets a
repo function hand back the id of a row before reading it back. Timestamps are `INTEGER` epoch milliseconds,
set with `Date.now()` in the repo layer rather than a SQL default — `CURRENT_TIMESTAMP` means seconds-as-text
in SQLite and a native timestamp type in Postgres, so a SQL default would be one more thing to rewrite the day
the engine changes.

**TEN-3's re-claim.** `claimDiscordServerBinding` is a `SELECT` followed by an `INSERT` or `UPDATE` chosen in
application code, not an `INSERT ... ON CONFLICT DO UPDATE ... WHERE`. The latter is still portable SQL (D-2
allows it), but the explicit select-then-write reads plainly as the three cases TEN-3 actually describes
(never bound / released and re-claimable / actively bound elsewhere) without leaning on `ON CONFLICT`'s
less-obvious "conditional no-op" semantics. What protects each branch from a second, genuinely concurrent
writer process is _not_ that better-sqlite3 is single-threaded — D-2 and PLAT-4 both describe several
processes (bot, API, worker) writing this one database, so "nothing else can run between this call's own
`SELECT` and its own write" is a per-process property, not a guarantee about a _different_ process racing it.
What actually holds, per branch: the never-bound insert is backstopped structurally by the primary key on
`server_id`, so a losing concurrent insert fails at the database level regardless of what its own `SELECT`
believed, and the failure is caught and reported as `undefined` rather than left to escape as a raw driver
error; the re-claim update repeats `removed_at IS NOT NULL` in its own `WHERE`, making it a single conditional
statement the database itself refuses once the row no longer matches, rather than a blind write based on an
earlier read. Any future two-step read-then-write added to this package needs the same shape — a write whose
own `WHERE` (or a structural constraint) re-checks the condition its read relied on — not an assumption that
nothing else can have changed the row in between.

**Limits.** The specific two-step claim above is now safe against a second, concurrent writer process racing
the same snowflake, for the reason above — but that safety is a property of _this_ function's two branches,
not of read-then-write in general. A future two-step operation in this package that reads one thing and writes
based on it needs to be checked against the same question this one now answers, rather than assumed safe by
analogy.

---

## D-12 — `packages/db`: PROJ-3's collision rule is a repo-level check, not a SQL constraint

**Problem.** PROJ-3 requires that a course's Discord category names and its two role names be unique across
every _enabled_ course in an organization, excluding a course whose project is archived. `projects`' own name
uniqueness (PROJ-2's "unique among non-archived projects") is the same shape of rule on a single table and is
enforced with a SQL constraint (below); PROJ-3 is not, and the two needed to be decided separately.

**Choice — `projects`: a partial unique index, mostly caught.** `projects_org_name_active_unique` (`schema.ts`)
is a `UNIQUE INDEX ON (organization_id, name) WHERE archived_at IS NULL` — the same "let the database refuse
it" approach `discord_server_bindings`'s primary key takes for TEN-3 (D-11). A partial unique index is portable
SQL Postgres supports too (D-2), so this is not a rewrite later. `renameProject` and `unarchiveProject` catch
the resulting `SQLITE_CONSTRAINT_UNIQUE` and refuse through `{ ok: false, conflict }`, naming the project
already using the name, rather than letting a raw driver error escape — both can reach the constraint on a
write that is not the row's first (a rename into a name freed by someone else's archiving; an unarchive back
into a name reused while archived), so "the caller already knows this row exists and needs to know why the
write failed" applies to them the way it does not to a fresh insert. `createProject` is left unhandled: a
freshly generated id has never collided with anything before this call, so there is no "was this name reused"
question for it to answer, and its return type (`Project`, not a result to unwrap) is depended on directly by
every existing call site in this package's tests — wrapping it to catch a case that cannot arise for a new row
would be a larger, unrelated change for no behavioural gain.

**Choice — `courses`: a repo-level check (`findCourseNameConflict` in `repos/courses.ts`).** Unlike a project's
name, PROJ-3's rule cannot be expressed as a constraint on one table: it spans `courses`, `projects` (to
exclude an archived project) and `course_categories` (for the category half of the rule), and its refusal has
to _name_ the conflicting project and course — a `CHECK` or a unique index can refuse a write, but it cannot
explain one. So `createCourse` and `updateCourse` run a `SELECT`-based check before writing, and refuse with a
structured result (`{ ok: false, conflict }`) that names the field, the colliding name, and the conflicting
project and course, rather than a boolean or a thrown error a caller would have to enrich itself. The same
check also runs, self-only, against `input` itself (`findSelfConflict`): an admin and student role that are the
same name, or two categories sharing a name, break PROJ-3's invariant inside one course, not just across two.

**`projectId` must belong to the organization saving the course (TEN-5).** `courses.project_id`'s foreign key
only proves the row refers to _some_ project, not that it belongs to the organization making the write — the
same gap `claimDiscordServerBinding` closes for `installedByAccountId` (D-11). `loadOwnedProject` (in
`repos/courses.ts`) checks this before `createCourse` or `updateCourse` writes anything, and refuses through the
same `{ ok: false, conflict }` channel as a name collision (`field: 'projectId'`) rather than a thrown
foreign-key error — a course saved against a foreign project would otherwise quote that project's name in a
later PROJ-3 refusal (disclosing it across the tenant boundary) and drop out of the candidate set whenever the
foreign owner archived its own project.

**Replacing a course's categories and channels on update.** `updateCourse` deletes every existing category (and,
through it, every channel) for the course and re-inserts the input's list, rather than diffing old and new by
name or id. A course's categories are always saved as a whole — CFG-4's list, not a set of independently
addressable rows — so there is no partial-update case a diff would serve, and delete-then-insert cannot leave
an orphaned channel the way a partial update that forgot one branch could. Channels are deleted before their
parent category explicitly; nothing in this package relies on `ON DELETE CASCADE` (D-2's portable subset, as
`discord_server_bindings` and `memberships` already establish by using plain foreign keys with no cascade).

**The check only applies to a save that would actually route.** `createCourse`, `updateCourse`, `enableCourse`
and `unarchiveProject`'s course half (below) all run the PROJ-3 check only when the course being saved would end
up enabled _and_ in a non-archived project. A disabled course, or one in an archived project, introduces no
routing collision — it is PROJ-3's escape hatch (`schema.ts`'s comment on `courses.enabled`), and the escape
hatch has to stay usable: refusing an edit to a disabled course because its names are now taken elsewhere would
make disabling it permanent, which defeats the point of it being reversible.

**Enabling, and unarchiving, both re-run the check.** `enableCourse` and `findProjectUnarchiveConflict` (called
by `unarchiveProject`, `repos/projects.ts`) both re-run PROJ-3's cross-course check — `createCourse` and
`updateCourse` are not the only places a collision can appear. A course disabled while another course took its
names, then re-enabled, would otherwise produce exactly the state PROJ-3 forbids; the same is true one level up
when an entire project's courses come back at once on unarchive. `findProjectUnarchiveConflict` checks each of
the project's own enabled courses against every other enabled course in a non-archived project _and_ against
each other (`includeProjectId` on `findCourseNameConflict`), since two courses in the same archived project
could have taken the same name without either being a PROJ-3 candidate at the time.

**Limits.** The repo-level check reads every enabled, non-archived-project course's roles (one query) and then
their categories (one more, batched — not one per candidate), so its cost grows with the organization's active
course count, not with the whole table. That is fine at today's scale; a very large tenant would need an
index-backed check instead, the same way any other "check the whole active set" query would.

The check is application code with no SQL constraint behind it (unlike `projects`' partial unique index above),
which is a deliberate trade — PROJ-3 spans three tables and needs to name what it collided with, neither of
which a `CHECK` or a unique index can do. `createCourse` and `updateCourse` now run the check inside the same
`db.transaction(...)` as the write, rather than before it, which narrows but does not close the race PLAT-4's
writer processes create: two concurrent saves can still both read the pre-write state before either commits, so
both can still pass the check and both commit, leaving the invariant broken until the next save notices. Moving
the check into the transaction only helps once SQLite's own write-lock ordering serializes the two connections'
writes — it does not make the check-then-write atomic the way a real constraint would. Closing this fully would
need either a real constraint (not expressible here, per above) or an application-level lock scoped to the
organization around the whole check-and-write, and neither is in this slice's scope.

Two further deviations from PROJ-3's literal wording, both narrowing rather than widening what gets refused:

- PROJ-3 says names are unique across every enabled course in a **Discord server**; this enforces uniqueness per
  **organization**, because the schema has no course-to-server link yet (that link lands with routing, in a
  later phase). Per-organization is stricter, not looser: an organization that has bound two Discord servers
  would be refused a name reuse the SPEC would allow across them. Recorded here so it is a known deviation, not
  rediscovered as a bug when routing is added.
- The comparison is case-sensitive throughout (`findCourseNameConflict`, `findSelfConflict`,
  `findActiveProjectConflict` in `repos/projects.ts`), so `"Web Design - GLOBAL"` and `"web design - global"` are
  treated as different names. This matches the legacy exact-match router and Discord's own tolerance of
  duplicate channel/category names, so it is deliberate, not an oversight — `accounts.email`'s repo-layer
  lowercasing (`schema.ts`) is the precedent for closing this later if a phase wants names case-insensitive too.

---

## D-13 — `packages/db`: `people`/`conversations`/`usage_counters` rename D-4's sketch, and a scope change never merges or splits a conversation

**Problem.** D-4 sketched `bot_conversations` and `usage_counters` keyed on `(course_id, end_user_id)`. PPL-1..3
and CONV-1..3 (`docs/SPEC.md` §18) needed a concrete table and column shape for that sketch, plus a person
table D-4 did not name at all, and a decision about what happens to an existing conversation when a course's
`conversationScope` changes later — neither of which D-4 settled.

**Naming, differing from D-4's sketch on purpose.**

- **`people` / `person_identities`, not `end_user_id`.** D-4's `end_user_id` names a column, not a person; PPL-1
  needed an actual row a course's roster fields, conversations, transcript and usage counters could all key on,
  and PPL-2 needed a place to hold one identity per surface without repeating a person's roster fields once per
  surface. Splitting the two mirrors `accounts`/`memberships` (an identity, and a separate binding of it), rather
  than folding "who this is" and "how this surface reaches them" into one row.
- **`conversations`, not `bot_conversations`.** The `bot_` prefix named the thing that used to be the only
  surface talking to a student; PPL-1 and SURF (`docs/SPEC.md`) are explicit that a person is reached through
  several surfaces, of which Discord is one, so a table this platform-wide should not carry one surface's name.
  Every other tenant-scoped table in this package (`courses`, `projects`, `memberships`) is named for what it
  _is_, not for the component that currently happens to write it.
- **`usage_counters` keeps its name.** D-4's sketch used this name and nothing about PPL/CONV gave a reason to
  change it; what differs from the sketch is the key, `(organizationId, courseId, personId, day)` rather than
  `(course_id, end_user_id)` — `organizationId` for TEN-2 (every table in this package carries it), and an
  explicit `day` string rather than deriving "today" from `end_user_id`'s activity, which is CONV-3's point and
  BOT-11's fix, one layer down (`repos/usage.ts`'s module comment).

**`conversations`'s nullable `surface` needs two partial unique indexes, not one plain unique index.** SQL
treats every `NULL` in a unique index as distinct from every other `NULL` — standard behaviour, not a SQLite
quirk, Postgres does the same — so a single `UNIQUE (organizationId, courseId, personId, surface)` index would
let an unbounded number of `course`-scoped (`surface: null`) rows through for the same person and course, which
is exactly the single row CONV-1 requires. `schema.ts`'s `conversations` table instead has two partial unique
indexes, split on `surface IS NULL`, the same device `projects_org_name_active_unique` already uses for PROJ-2.
Verified by `tests/conversations.test.ts` and, for the underlying SQL behaviour, by temporarily removing both
indexes from the generated migration and confirming the structural-uniqueness test fails (see the slice's PR
description for the exact revert used).

**A course's `conversationScope` changing does not merge or split existing conversations — there is no such
path in this package.** `getOrCreateConversation` (`repos/conversations.ts`) reads the course's _current_
`conversationScope` on every call and looks for a row keyed accordingly (`surface: null` for `course`, `surface:
<arrival surface>` for `course_surface`). An existing conversation's own `surface` value is fixed at the moment
it was created and is never rewritten. So switching a course from `course` to `course_surface` (or back) does
not touch any row already on disk; the next `getOrCreateConversation` call simply looks for a differently-keyed
row than any that exist, finds none, and creates a new one — leaving the old conversation's history in place,
unmerged, and no longer matched by future lookups under the new scope. This was a judgment call, not specified
by CONV-1: a migration that reconciled scope changes (merging every `course_surface` conversation for a person
back into one `course`-scoped row, say) is possible but was out of this slice's scope and has real questions
attached — which surface's `upstreamThreadId` wins, whether merged transcripts need re-ordering — that belong to
whichever later slice actually needs scope changes to be a live, user-facing operation rather than a database
column nobody flips yet. `tests/conversations.test.ts` asserts the behaviour above explicitly, so a future slice
that adds a real merge path will see this test start failing rather than silently no longer describing the
system.

**`resolvePersonByIdentity`'s "merge" fills gaps, it does not overwrite — and `overwriteRosterFields` is the
escape hatch that only-fills rule needs.** PPL-3 says roster fields are "merged onto the person" without
specifying a direction; `mergeRosterFields` (`repos/people.ts`) only ever fills a field that is currently `null`
on the person, never replaces one already set. The alternative — a roster import always wins — was not chosen
because a person's `displayName` may already have been set from something a surface supplied (a Discord display
name) before any roster exists for them, and there is no reason to treat a later roster import as more
authoritative for that field than the identity the student is actually using. But "only fills a gap" has a sharp
edge: once a field is merged in wrong — a bad roster row's mistyped email, say — `mergeRosterFields` alone can
never fix it, because the field is no longer `null`; a corrected re-import through it is silently a no-op. Before
this rework the package had no other write to `people` at all, so a wrong email had no path to correction short of
editing the database directly — not something an instructor can be told to do. `overwriteRosterFields`
(`repos/people.ts`) is the deliberately-named other half: it replaces every field named in its input exactly as
given, `null` included (which clears a field), regardless of what the person's row currently holds, and leaves a
field the caller omits untouched. Revisit if a future import needs a per-field policy finer than "merge fills
gaps, overwrite replaces everything named" (a roster's `firstName`/`lastName` should always win over a Discord
name but `displayName` should not, say) — neither function here expresses that distinction on its own.

**Two seams left for a later slice, made explicit here rather than left as a comment nobody re-reads.**

- **A course created without `max_requests_per_day` has no cap at all, today.** BOT-5 says the platform default
  is 10 requests/day; this slice deliberately does not invent that default — `hasExhaustedDailyLimit`
  (`repos/usage.ts`) returns `false` ("not exhausted") for a course whose `maxRequestsPerDay` is `null`, the same
  "no default value is invented" reasoning D-10 already applies to the column itself. That means: as of this
  slice, a course saved with no `maxRequestsPerDay` is _unlimited_ in practice, not defaulted to 10, until
  whichever later layer reads the platform default (`OPENAI_DEFAULT_MAX_REQUEST_PER_DAY`'s successor, presumably)
  is wired in front of this repo and applies it before calling `hasExhaustedDailyLimit` — or writes it onto the
  course at creation time instead. Until that lands, nothing in this package enforces BOT-5's "10" for a course
  that never set the column, and nothing here will start silently enforcing it later either: the seam is that
  later layer's responsibility to close, not a database default this table should grow on its own.
- **`hasExhaustedDailyLimit` is tri-state (`boolean | undefined`), not a plain `boolean`.** `undefined` means "this
  `courseId` does not belong to `organizationId`" (TEN-2) — deliberately not collapsed into `false`, because
  `false` already means something else here ("no limit configured"), and a caller cannot tell those two apart
  from a bare `boolean`. Collapsing them let a cross-tenant or unknown `courseId` fail _open_: an action layer
  calling `hasExhaustedDailyLimit(orgA, courseFromOrgB, …)` would see `false` and let the request proceed, while
  the paired `incrementUsage` already returns `undefined` for the same input and counts nothing — an uncapped,
  unrecorded conversation. Every other tenant-checked function in this package already returns `undefined` for an
  id that does not belong to the calling organization; this brings `hasExhaustedDailyLimit` in line with that
  convention instead of leaving it as the one function that answers a foreign id with "no".

---

## D-14 — `packages/legacy-import`: idempotency keys, the shared path guard, and what "the same snapshot into two organizations" means

**Problem.** MIG-4 requires that re-running the importer against the same snapshot change nothing the second
time. Most rows have a natural key already in the schema to match on — a course's title within its project, a
person's Discord snowflake on `person_identities` — but `messages` has none: two distinct legacy rows can carry
identical content, category, channel and direction, and `packages/db` takes caller-generated ids rather than
inventing its own.

**Choice — a deterministic message id.** `import-messages.ts` derives each imported message's id from
`(organizationId, the legacy row's own autoincrement id)`, hashed through `ids.ts#deterministicId` (SHA-256,
truncated, prefixed for readability). Before appending, it checks that id against every message id already
recorded across _all_ of the run's routable courses' conversations (`loadExistingMessageIds`, read once up front);
if it is already there, the row is reported `matched` and nothing is written. `organizationId` is folded into the
hash — not just the legacy row's id — specifically so two different organizations can each import the same
snapshot without their message ids colliding on the single, non-tenant-partitioned `messages.id` primary key.

The dedupe check was originally scoped to the one conversation the current run's message routes to, read and
cached per conversation. That undercounted: `messages.id` is a single global primary key, not scoped per
conversation, and a course's `conversationScope` flipping to `course_surface` between two runs opens a _new_
conversation for a person who already had one (D-13) — so a message that landed on the old conversation is not
in the new one's transcript, the per-conversation check missed it, and `appendMessage` threw
`SQLITE_CONSTRAINT_PRIMARYKEY` uncaught instead of reporting the row `matched` (finding 5 of the MIG-1 rework).
The fix reads every conversation each routable course has, not just the one this run's message resolves to, so
the check is scoped the same way the primary key actually is.

**Why not a content hash instead of the legacy row's id.** A hash of `(category, channel, direction, content)`
would collide for two genuinely different messages with identical text (a repeated "thanks!"), silently dropping
the second one on both the first _and_ every later run. The legacy row's own autoincrement id has no such
collision, and it is already the thing this package uses to order the transcript (`read-legacy.ts#readLegacyMessages`
reads `order by id asc`), so reusing it for identity as well as ordering is one fact, not two.

**The organization and project id/name choice, made for the same reason.** `import-config.ts` derives the
organization's id deterministically from `bot_config.yml`'s `server.name` (there is no `organizations.name`
uniqueness constraint to look up against, so the id itself has to be the stable thing a re-run can find again),
and looks the project up by name inside that organization rather than needing a second deterministic id. Both
default to `server.name` — the legacy format has no explicit term field, and the role-name suffixes that hint at
one (`admins-wd-su26` vs `admins-py-s26` in the same file) are inconsistently abbreviated across courses, which
is exactly the "looks right, is wrong for a config nobody has tested this against yet" trap D-10 already declined
for the YAML schema itself. `importConfig` accepts an optional `projectName` override for a caller that wants
something more specific (an actual term, for a later re-import).

**What "the same snapshot into two different organizations" means, concretely.** Since the organization id is
derived from `server.name` and not from the snapshot path, running the importer twice with the _same_ snapshot
file but two _different_ `bot_config.yml`s (different `server.name`) produces two organizations, each fully and
independently populated — person and course lookups are scoped by `organizationId` (TEN-2), so the second
organization's import sees none of the first's rows and re-creates its own complete copy, with its own message
ids (they embed `organizationId`, so nothing collides on the shared `messages` table). Running the importer twice
with the _same_ YAML — and therefore the same derived organization id — is the ordinary MIG-4 idempotent case
above, not a second organization.

**The path guard, extracted rather than duplicated.** MIG-1's refusal ("never open the live database") needed
the same real-path-resolution logic `db:migrate`'s `assertMigratablePath` already had
(`packages/db/src/run-migrate.ts`) — follow symlinks, tolerate a not-yet-existing target, compare against this
repository's own `data/` directory. Rather than writing a second, subtly different version of that logic inside
`packages/legacy-import`, it was pulled out into `packages/db/src/path-guard.ts` and both callers now use it:
`run-migrate.ts` still layers its own `--i-know` override on top for an operator who genuinely needs to migrate
the live file, while `packages/legacy-import/src/guard.ts#assertLegacySnapshotPath` calls the same
`isUnderRepoData` with no override at all, for the _source_ snapshot — there is no legitimate reason for an
import to ever read the live database, so no escape hatch was added for it.

That left a real gap (finding 1 of the MIG-1 rework): the guard was only ever applied to the source, and the
CLI's _destination_ — the platform database it opens and migrates via `CONFIG.DATABASE_PATH` — was never
checked at all, defaulting to `./data/data.db`, the same live file. Unlike the source, the destination
legitimately is the live database once an operator is ready to run the real, final import, so it takes the same
shape `db:migrate` does rather than the source guard's "no escape hatch, ever": a new
`guard.ts#assertImportDestinationPath` refuses `CONFIG.DATABASE_PATH` under `data/` unless `--i-know` is passed,
called in `cli.ts` before `openDatabase`, ahead of `runMigrations` and ahead of `runImport` ever validating the
source path.

Separately, `resolveReal` (`packages/db/src/path-guard.ts`) resolved a candidate path with plain `realpathSync`,
which follows symlinks but does not canonicalize filesystem case — invisible on a case-sensitive filesystem, but
this project's development and CI platform (darwin) is case-insensitive, where `DATA/data.db` and `data/data.db`
name the same on-disk file while comparing unequal as strings (finding 2). Both guards now compare through
`realpathSync.native`, which asks the OS for the real on-disk casing, closing the gap for both callers.

**Merge, not overwrite, for a person's roster fields (finding 4).** `import-people.ts` originally wrote a legacy
row's roster fields (`email`, `first_name`, `last_name`, `github_username`) through
`people.overwriteRosterFields` — every field named, written exactly as given, on every run. MIG-4 makes
re-running the importer the normal way to pick up new transcripts, and the legacy snapshot is the _oldest_
source of roster data in the system, not the newest: by the time a re-run happens, an instructor may have
corrected a blank email by hand, or a real roster import may have filled it in, and the legacy snapshot knows
nothing about either. Overwriting reset all of that on every re-run, including back to `null` where the legacy
row itself never had a value. `import-people.ts` now uses `people.mergeRosterFields` instead, which only ever
fills a field that is currently `null` — a re-run still repairs a person's roster fields the first time they are
seen, and never re-clobbers a field something newer has since filled in.

**The YAML is authoritative for course configuration on re-import (finding 3) — the opposite of the people
choice above, deliberately.** `import-config.ts` originally left an already-matched course untouched on a
second run, on the reasoning that re-saving would needlessly churn its category and channel ids. That let a bad
import — the concrete case: `promptId` was being read from the legacy Assistants `id` field instead of
`prompt_id`, the value the running bot actually reads (CFG-2) — stay wrong forever, since nothing would ever
write the corrected value onto an already-matched course. Course configuration has no equivalent of "an
instructor already corrected this by hand" the way a person's roster fields do: `bot_config.yml` is the one and
only source for a course's assistant settings during this migration, so unlike a person (merged, above), a
matched course is now re-saved from the YAML through `updateCourse` on every run, repairing whatever an earlier
run got wrong. The category/channel id churn this causes on every re-run is accepted as harmless: nothing outside
this run persists a reference to a previous run's category or channel id, and `import-messages.ts` always
re-reads a course's categories fresh through `loadRoutableCourses`, never from a previous run's own output.

**Limits.** The deterministic message id is stable only for as long as the legacy row's own autoincrement id is
stable, which holds for a read-only snapshot but would not survive, say, re-exporting the legacy database with
its ids renumbered. The organization-id-from-`server.name` scheme means renaming the Discord server in
`bot_config.yml` between two runs of the importer against the _same_ underlying course would be read as "a new
organization," not "the same one, renamed" — acceptable for a one-shot migration tool, but worth knowing if this
importer is ever pressed into service as a recurring sync rather than a single cutover. The destination guard's
`--i-know` override means the same single flag both lets an operator run the real, final import against the live
database _and_ lets them accidentally run a rehearsal against it if they pass it out of habit — a narrower risk
than the pre-fix state (no guard at all), but worth knowing since it is the one place in this package an escape
hatch exists at all.

---

## D-15 — `packages/core`: a discriminated result instead of exceptions, and how the port carries D-3's escape hatch

**Problem.** `answerQuestion` (CORE-1, 3, 5, 6) has two outcomes the brief calls "ordinary" — an over-limit
request and a failed model call — that a naive port would signal by throwing, the same way a bug would. A
caller (the Discord adapter, the web chat, MCP) then has to distinguish "the pipeline told me the allowance
is spent" from "the pipeline itself broke" by inspecting an error message, which is exactly the kind of thing
a `catch` block gets wrong under review pressure. Separately, `ModelClient.ask` (`src/ports.ts`) has to carry
D-3's `promptId`/`instructions` pair to an adapter that has not been written yet — the OpenAI adapter lands in
the next slice — so this slice has to decide what the port hands across that boundary without knowing the
adapter's own shape.

**Choice, result type.** `AnswerResult` is a discriminated union — `answered` / `answered-last-request` /
`declined-over-limit` / `failed-with-apology` — and `answerQuestion` returns one instead of throwing for
either of the two ordinary cases. A `courseId`/`personId` that does not resolve to this organization is kept
out of that union and thrown instead: CORE-2 (routing) and PPL-3 (identity resolution) are what is supposed to
guarantee the ids `answerQuestion` receives already belong to the organization, so a resolution failure here
is a caller bug, not a state a student's own request can reach — the same "ordinary vs. exceptional" line
`repos/courses.ts`'s `SaveCourseResult` already draws between a name collision (returned) and a malformed
input (thrown).

**Choice, D-3 through the port.** `ModelRequest` (`src/ports.ts`) carries both `promptId` and `instructions`
unresolved — it does not pick a winner. `courses.promptId` wins when set (D-3), but _which one wins_ is
encoded once, in `answer.ts` reading `course.promptId`/`course.instructions` straight off the row and handing
both to the port, not duplicated into every future adapter's own resolution logic. An adapter that only
understands one of the two (a provider with no concept of a stored prompt reference) still receives both
fields and is free to ignore the one it cannot use — the port stays a plain description of "what the course
says to answer with," not a resolved instruction ready for one specific vendor's call shape.

**Choice, a model failure still counts against the daily allowance.** `response_bot.py`'s own counter update
runs unconditionally after the `try`/`except` around its OpenAI call — a request whose model call raised still
increments `num_requests_today` (the `is_response` flag it sets is computed and never read). CORE-3 and CORE-5
are both silent on whether a failed call spends part of the allowance, so `answer.ts` matches the bot: the
allowance is reserved — counted — before the model is ever asked (see the finding 8 update below), so a request
whose model call raises has already been counted by construction, the same as one that succeeds. Only the
`declined-over-limit` path, which returns before the reservation is even attempted, never counts. This is
carried over deliberately, not rediscovered by accident — worth revisiting if a future slice decides a provider
outage should not cost a student part of their day.

**Update (finding 8 of the CORE-1 rework) — the allowance check and the count are one atomic operation, reserved
before the model call, not two steps straddling it.** As first shipped, this slice checked the allowance
(`usage.getUsageCount`) before recording anything, then only counted the request (`usage.incrementUsage`) after
the reply was recorded — with the model call's own `await` sitting between the two. That gap meant two requests
from the same person arriving close together could both read the same "count so far", both be judged under the
allowance, and both proceed, landing the stored count one past `limit` even though the check itself never let a
request through improperly — the legacy bot has the same shape of race, but it kept its counter in memory, and
this one has a real, shared `usage_counters` table connected processes can genuinely race on (D-2's "three
writing processes"), which the in-memory version could not be raced on the same way. The fix is
`packages/db/repos/usage.ts`'s `reserveUsageSlot`: one `INSERT ... ON CONFLICT DO UPDATE ... WHERE` statement
that checks and counts atomically, called before the model is asked rather than after the reply is recorded.
The "a failed call still counts" behaviour above is unchanged by this — reserving before the call means it holds
by construction, not by a separate write after the fact that could be skipped or raced.

**Why a combined "last request, and it failed" state exists after all.** The paragraph above originally read
this slice as narrower than the Python bot on purpose, because `answer.ts` decided the last-request notice
before the model was asked and only applied it to a successful answer, so the combination could not occur.
Finding 7 of the CORE-1 rework reversed that: during a provider outage, a student whose allowance-reaching
request is the one whose model call fails used to get a bare apology, be charged for it, and then be declined
on their next request with no text at all — the notice was the only signal the day had ended, and it was lost
exactly when it mattered. `failed-with-apology` now carries `lastRequestOfDay: boolean` for this reason. The
apology's own _text_ still never combines with the notice's — it stays byte-identical to `response_bot.py`'s,
and nothing in CORE-3 or CORE-5 asks for the combined message `response_bot.py` itself produces ("you have
reached your limit... sorry, I can't respond") — but the _fact_ is no longer thrown away: a surface reads
`lastRequestOfDay` off the result and decides for itself how (or whether) to say so, separately from the
apology.

**One request shorter than the running bot's day.** `response_bot.py` sets `rate_limit_message` when
`num_requests_today == request_limit` and only refuses once `num_requests_today > request_limit` —
`num_requests_today` is read _before_ being incremented for the current request, so with `request_limit = 10`
the bot answers the request that arrives with a stored count of 0 through the one that arrives with a stored
count of 10 (eleven answers total), puts the notice on the eleventh, and only refuses the twelfth.
`reserveUsageSlot` refuses once the _stored_ count would reach `limit`, so with the same `limit = 10` this
pipeline answers ten questions, puts the notice on the tenth, and declines the eleventh onward. This is CORE-3
and BOT-5 exactly as written — "a person's count... is checked first" against `maxRequestsPerDay`, not against
one fewer than it — so it is kept rather than patched to match the bot's own off-by-one. It is recorded here
because it is cutover-visible: a real student moving from the running bot to this pipeline gets one fewer
answer on their busiest day, the same kind of behavioural divergence D-14 documents for the legacy import.

**Limits.** The two `throw`s (course/conversation not found) mean `answer.ts` is not safe to call with
unvalidated input — a future MCP or web surface that accepts a raw `courseId` from outside the platform must
resolve and validate it first, the same way CORE-2's routing and PPL-3's identity resolution already do for
Discord. If a later slice finds a legitimate reason for `answerQuestion` to be called with an id it cannot
resolve, that is a new discriminated outcome to add, not a reason to swallow the exception.

---

## D-16 — `packages/openai`: raw `fetch` over the SDK, retry-per-attempt, a forgotten conversation id, and a port gap closed in a later rework

**Problem.** MDL-1..7 need an adapter that talks the Responses and Conversations APIs, bounds and retries a
request (MDL-5), survives the provider forgetting a conversation id (MDL-4), and is provably reachable by no
test over the real network (MDL-7). Three judgment calls fell out of building it, plus one the brief asked to
be reported rather than guessed at — closed in this package's first rework, below.

**Choice, `fetch` over the `openai` package.** The adapter is raw HTTP (`src/http.ts`'s `postJson`) rather than
the official SDK. The SDK is a large, in this repo entirely unaudited dependency for what this slice actually
needs — two POST calls with a bearer header and a JSON body — and pulling it in would add a second thing
MDL-7's "no test ever calls OpenAI" has to prove holds through (the SDK's own retry/timeout defaults, its own
base-URL handling) on top of this adapter's. `fetch` is native to Node 22 (`tsconfig.base.json` already targets
it) and needs no new dependency at all. The cost: this adapter re-derives, by hand, the one shape the SDK would
have given for free — walking the Responses API's `output` array for `output_text` (`responses.ts`'s
`extractOutputText`) — rather than reading a convenience property `response_bot.py`'s own SDK call already
computes. Revisit if a second vendor call (embeddings, moderation, …) needs enough of the SDK's surface that
re-deriving it by hand stops being cheaper than auditing the dependency.

**Choice, the retry applies per attempt, not to a shared budget.** MDL-5 says "bounded" and "retried once";
it does not say whether a retry gets its own fresh clock or shares one with the attempt it followed. This
adapter gives every attempt (`src/http.ts`'s `postJson`, called fresh by `conversations.ts` and by
`client.ts`'s `postResponses`) its own `timeoutMs` window, so a retried request can take up to roughly twice
`timeoutMs` end to end in the worst case. The alternative — one shared deadline across both attempts — makes a
slow-but-not-quite-timed-out first attempt eat into the retry's own budget, which is a subtler failure mode to
reason about (and to test) than "each attempt gets the bound the caller configured." Revisit if a real
`timeoutMs` proves too generous once doubled for a retry.

**Choice, a forgotten conversation id creates one and retries once, never in a loop.** MDL-4's stored id can be
rejected as a 404 the provider's own error body names as the conversation (`errors.ts`'s
`classifyHttpError`/`isUnknownConversation`) rather than any other 404 (a bad prompt id, a bad vector store
id). `client.ts`'s `ask` only takes this path once — `newConversationId === null` guards it, so a 404 on the
_freshly created_ replacement conversation is treated as a provider bug and propagated rather than retried
again, the same "once, not a loop" MDL-4's own text asks for. This is a second, independent retry mechanism
from MDL-5's transient-failure retry (`askOnceWithTransientRetry`), not a special case folded into it: a
transient failure retries the _same_ call; a forgotten conversation id changes the call (a new `conversation`
field) before retrying it, and conflating the two would make either one harder to reason about in isolation.

**Closed in the MDL-1 rework: `ModelRequest` now expresses MDL-4's own opening item.** `response_bot.py` seeds
a new conversation with the student's Discord name, their Discord id and the course name
(`response_bot.py:262-269`); MDL-4 asks for the same. At the time this slice first shipped, `ModelRequest`
(`packages/core/src/ports.ts`) carried `promptId`, `instructions`, `vectorStoreId`, `model`, `upstreamThreadId`
and `question` — no person id, no display name, no course title — and this section originally reported that
gap rather than guessing at a fix, per that slice's own brief ("do not widen the port for a gap like this
without reporting it first"). Finding 1 of this package's first rework picked it up: `ModelRequest` gained
`displayName`, `courseTitle` and `personRef`, populated at `answer.ts`'s one `model.ask` call site from
`people.getPerson` (a roster-merged display name, or `null`) and a new `people.getPersonIdentity` (the
identity on the request's own surface, formatted as `<@id>` the way `response_bot.py`'s own
`metadata={"user_id": ...}` does) — `course.title` was already in hand there for the apology text. `client.ts`
now threads all three straight into `createUpstreamConversation` on every path that creates a conversation, and
`conversations.ts`'s `buildSeedText` still degrades gracefully (a course title with no name, a name with no
course, neither) for whichever of the three a future caller genuinely lacks.

**Closed in the MDL-1 rework: a transient failure creating a conversation is retried, and a conversation minted
just before a failure is not orphaned.** Two further findings from the same rework: (1) `createUpstreamConversation`
now goes through the same `withTransientRetry` helper as the answer call (MDL-5's "every request", not just the
answer request) — a 429 or 5xx creating the conversation is retried once, the same as one on `POST /responses`.
(2) A call that successfully creates a new conversation and then fails to answer with it no longer loses that
id: the failure is thrown as `ModelAskError` (`packages/core/src/ports.ts` — defined there, not in this
package, because `answer.ts` must never import a vendor type per CORE-4) carrying the id, and `answer.ts`
persists it before taking the apology path. Without this, each failing turn after a recreate orphaned another
upstream conversation the platform could never resume.

**Limits.** The per-attempt timeout means a caller budgeting "this request will return within `timeoutMs`" is
wrong by more than 2x now that creating the conversation shares the same retry policy: the worst case for a
first turn is _create_ (one attempt, one retry) _then_ _answer_ (one attempt, one retry) — up to roughly 3x
`timeoutMs`, wall-clock, not 2x. A surface wiring this in (the Discord bot, when it lands) should budget for
that 3x, not the answer call's own `timeoutMs` alone, when it decides how long it is willing to leave a student
waiting on a reply; a future slice that needs a hard bound across the whole call (not just each attempt) will
need to thread a deadline through instead of a duration.

MDL-6's citation stripping is not quite byte-for-byte with `response_bot.py`'s own `re.sub(r"【.*?】", "", …)`
either, and this is the one place that says so precisely: `responses.ts`'s `CITATION_MARKER_RE` adds the `s`
flag, so a `【…】` pair whose content spans a newline is still removed here, where Python's `re.sub` (no
`re.DOTALL`) would leave it — and the newline inside it — untouched. Realistic only for an answer that discusses
the bracket syntax itself, and worth keeping regardless: MDL-6's own requirement is "never reach a student," not
matching a regex that happens not to use `re.DOTALL`.

---

## D-17 — `packages/discord`/`apps/bot`: how a long answer is split, what the health endpoint reports, and two deliberate departures from `response_bot.py`

**Problem.** `packages/discord`'s `handleMention` (SURF-1..7) is the first surface built on `answerQuestion`
(CORE-1) and the first `apps/*` process in the repository. Three questions the brief left to this slice's own
judgment: how to split an answer over Discord's 2000-character limit, what a process health check should and
should not report, and how far to follow `response_bot.py`'s own behaviour where the SPEC's own text (SURF-5,
SURF-6) asks for something different.

**Choice, splitting: paragraph, then line, then word, then a hard cut — plain slicing, nothing trimmed.**
`response_bot.py:345`'s `message.channel.send(openai_response)` has no split at all: Discord's API rejects a
message over 2000 characters outright, so an answer that long today is silently never sent — not truncated,
not logged as failed, just gone. `split.ts`'s `splitForDiscord` fixes this by finding the latest boundary
within the limit that keeps a message readable, in priority order: a paragraph break first (`\n\n`, both
newlines kept with the part before them), a single line break next, a word boundary after that, and only when
none of those exist within the limit at all — a single "word" longer than the limit itself, with nowhere
readable to break it — a hard cut exactly at the limit. Every cut is plain `String.slice`, with nothing
trimmed or rewritten at the boundary, so `parts.join('')` always reconstructs the original text exactly
(asserted directly in `packages/discord/tests/split.test.ts`) — SURF-5's "sent in order, ... nothing lost"
is a property the tests check by reassembly, not a claim taken on trust.

**Why not sentence-aware splitting, or a fixed-width cut.** A sentence-boundary splitter (breaking after a
`.`, `?` or `!` followed by whitespace) would read better for prose, but the model's answers already come back either as short paragraphs
or as one long paragraph with no sentence-ending punctuation pattern reliable enough to trust over a genuine
mid-sentence colon or abbreviation — misjudging that boundary risks a worse cut than the word-boundary
fallback already gives, for a readability gain only worth it on the (rare, given MDL-3's "keep replies to one
paragraph") over-limit answer. A fixed-width cut (always exactly at `limit`, no boundary search at all) was
rejected outright: it is simpler, but it is also the one Discord already inflicts on a message it truncates
elsewhere, and the whole point of building a splitter here is not to do that to a student mid-word.

**Choice, the health endpoint reports gateway connectivity and nothing else.** `startHealthServer`
(`apps/bot/src/health.ts`) answers every request with one boolean, `gatewayConnected`, read fresh per request
rather than cached — `200` once the gateway is connected, `503` before that, after shutdown begins, or once it
has dropped again. Finding 4 of this slice's rework: the flag used to be set `true` on `Events.ClientReady` and
never cleared, so it reported "has ever connected" rather than "is connected" — a token rotation or a dropped
socket hours into a run left the endpoint answering `200` while no message was actually being delivered, which
is exactly the state this endpoint exists to catch. `apps/bot/src/gateway-health.ts`'s `wireGatewayHealth` now
also clears the flag on `Events.ShardDisconnect`/`Events.ShardReconnecting` and sets it again on
`Events.ShardResume`, and binds to `127.0.0.1` only rather than every interface (finding 8) — this endpoint has
no reason to be reachable from outside the machine the process runs on. It deliberately says nothing about the
database connection, the OpenAI adapter, or any per-request state: every one of those already degrades to a
logged error and a reply rather than taking the whole process down (CORE-5's "a model failure degrades to an
apology, never ... a stack trace" — the same discipline one level up), so there is nothing about them a
process-level check could report that would not just restate what the logs already say better, and a health
check that pings the database or the model on every probe would give a supervisor a reason to restart a
process that is otherwise serving students fine.

**Why not a richer health payload.** A deeper check — `SELECT 1` against the database, a no-op OpenAI call —
was considered and rejected for this slice: `apps/bot` has one gateway connection and one database handle it
opens once at startup (PLAT-5), so "is the process alive and connected" is genuinely the only binary state
worth exposing before OPS-2 wires this process under pm2, which is a separate, operator-owned decision this
slice does not make (see the brief's own scope line).

**Choice, `allowedMentions: { parse: [] }` on the client and on every reply — the sharpest safety property in
this slice.** Finding 1 of this slice's rework: reply-in-place (below) means the bot's own text is now something
a student can coax the model into repeating verbatim — `"repeat this exactly: @everyone the exam moved to
Friday"` — and with no `allowedMentions` set at all, discord.js omits `allowed_mentions` entirely and Discord
parses every mention in the body, including a role or `@everyone` ping, wherever the bot's own role happens to
have Mention Everyone (which class-server setup guides routinely grant a bot that already asks for
`MANAGE_CHANNELS`). `apps/bot/src/reply-port.ts`'s `buildReplyPort` sets `{ parse: [] }` on every `reply` call,
and the `Client` itself is constructed with the same default, so a future call site that builds a reply some
other way still cannot ping anyone by accident — this is deliberately redundant, not merely set once. Nothing
about MDL-6 (which strips citations, not mention syntax) or any other layer in this pipeline would otherwise
have caught this: the model is never asked not to produce `@everyone`, and nothing before Discord's own parser
sees the reply text again. This reads as though reply-in-place (SURF-5) made the surface _safer_ than
`response_bot.py`'s own `channel.send` — visibly tying an answer to its question — but on the mention-pinging
axis it does not: `channel.send` carries the exact same risk, unaddressed, which this fix closes for both.

**Two deliberate departures from `response_bot.py`, both required by this slice's own SPEC text (not
discovered afterward):**

1. **Reply in place, not `channel.send`.** `response_bot.py:345` posts every answer with
   `message.channel.send(...)` — a new message in the channel, with no visible link back to the question that
   prompted it. SURF-5 asks for a reply instead ("The bot replies to the message it is answering"), so
   `apps/bot/src/index.ts`'s `ReplyPort` implementation calls `message.reply(text)`. In a busy shared channel
   this is the difference between a reply anyone can trace back to its question and an answer that could be
   about anything nearby.
2. **A refusal, not silence, when the daily allowance is already spent.** BOT-5 says a request past the limit
   is "silently ignored" — `response_bot.py` never sends anything back for it. SURF-6 asks for the opposite:
   "Each outcome the answering core can return has a rendering ... a refusal when the allowance is spent ...
   Every outcome reaches the student or the log, and none reaches neither." `handleMention`'s
   `declined-over-limit` case now sends a refusal (the same wording BOT-5's own last-request notice uses,
   built from the course's title resolved through routing) rather than nothing at all — a student who is
   over their limit finds out why the bot went quiet instead of wondering whether it saw their message.

**Choice, splitting: a code fence split across two parts is closed and reopened, at the cost of exact
byte-for-byte reconstruction.** A CS course's long answers are usually code, and Discord renders an unclosed
code fence badly across two messages — the first never closes, the second opens with a stray closing marker
and no opener of its own. `splitForDiscord` (finding 12 of this slice's rework) tracks whether a cut lands
inside an open fence (counting ``` markers by XOR, composed across parts) and, when it does, appends a closing
marker to the part that opened it and prepends a reopening one to the next — reserving room for both against
`limit` first, re-splitting within a smaller margin if the boundary `findSplitIndex` already chose does not
leave enough. This is the one case where `parts.join('')` no longer reproduces the original text exactly: two
synthetic markers are inserted at the seam. Nothing else about the text changes — stripping every ``` marker
and all whitespace from both sides still gives back the same code and prose, in the same order — but the
literal-reconstruction property the rest of this module holds is the one thing knowingly given up here, for
the sake of every individual message actually rendering as a legible code block on its own.

**Choice, splitting: a hard cut backs off one code unit rather than split a surrogate pair.** The word-boundary
fallback's very last resort — a single "word" with nowhere to break at all — cuts at exactly `limit`, which can
land between the two UTF-16 code units of one emoji. `findSplitIndex` now checks for a lone leading surrogate
at that exact boundary and backs off by one when it finds one, so the pair stays whole in the next part instead
of each half degrading to U+FFFD wherever the split text is later encoded to UTF-8. This costs nothing —
the cut simply moves one code unit earlier — so losslessness is unaffected by it.

**Limits.** The splitter has no upper bound on how many parts one answer produces — a pathological answer with
no whitespace at all anywhere near any boundary degrades gracefully to hard cuts every `DISCORD_MESSAGE_LIMIT`
characters, but nothing here rate-limits how many messages `handleMention` sends for one reply, which is a
question for whichever slice adds Discord's own per-channel send rate limit to the picture (PLAT-3's own "each
REST client is configured below the global request ceiling" is about the gateway token's request budget
overall, not about one reply's own message count). The health endpoint's binary signal also stops being enough
the moment a second kind of "degraded but running" state matters — a gateway connected but rate-limited,
say — and that is a real gap to close before this process runs unsupervised, not a hypothetical one. The
fence-closing behaviour above tracks only bare ``` markers, not which language (if any) followed the opening
one, so a reopened fence always loses its syntax highlighting even when the original had a language tag — a
readability regression, not a correctness one. `apps/bot`'s own shutdown (finding 7 of this slice's rework) waits
for in-flight message handlers to settle before closing the gateway and the database, but only up to a bounded
timeout — a handler wedged past it is abandoned mid-answer on shutdown, the same trade-off every bounded drain
makes between closing promptly and closing completely.

---

## D-18 — `packages/actions`: a required `policy` field, why a conflict names itself but a refusal never does, and where metering lands

**Problem.** ACT-2 makes three specific demands: "an action with no declaration does not compile," a policy
that "resolves and returns the entity it authorized" so an action can never reach a record it was not handed,
and (ACT-2's second paragraph) that "authorization runs outside the usage attribution context." Separately,
ACT-3 requires that a not-found and a not-yours refusal be the _same_ error, while this slice's own ported
actions (`courses.save`) need to surface `packages/db`'s PROJ-3 collisions, which _do_ name what they collided
with (D-12) — the same pipeline has to treat these two "the write did not happen" outcomes differently on
purpose, not accidentally reuse one error type for both. And ACT-1 declares a metering hook this slice has
nothing real to plug into it.

**Choice, "does not compile" as a required property, not a runtime check.** `Action<Name, Input, Entity,
Output>` (`types.ts`) declares `policy` as an ordinary required field, the same way every other field on the
interface is required. An object literal assigned to (or passed as an argument typed) `Action` that omits
`policy` fails TypeScript's own missing-property check at the call site — before `ActionRegistry#register`
(`registry.ts`) or `dispatch.ts` ever sees it, so there is no runtime path that reaches an unauthorized action
at all. This is not a novel mechanism; it is what a required property already does, and it is enough to
satisfy ACT-2's literal text without inventing a compile-time framework this repo has no other example of.

**What this does not catch.** TypeScript's structural typing means a value assembled through `any`, a wide
enough intersection, or a cast can still slip past a required-property check — `policy: undefined as any`
compiles. Nothing in this package (or TypeScript itself) closes that gap; the brief for this slice asks that
_declaring_ an action without a policy fail to compile, which this does, not that every possible way to smuggle
one past the type checker is impossible. A reviewer reading a diff that adds `as any` or `as unknown as Action`
near a new action is the actual backstop, the same as it is for every other type-level guarantee in this
codebase (`packages/core/src/answer.ts`'s own discriminated result can be similarly bypassed by a caller willing
to lie to the compiler).

**Choice, `ActionRefusedError` carries nothing; `ActionConflictError` carries the whole conflict.** The two
errors `dispatch.ts` and the ported actions raise for "the write did not happen" are asymmetric on purpose.
`ActionRefusedError` (ACT-3) is thrown for a record that does not exist, or exists in another organization —
and an organization boundary is exactly the boundary a message must never cross, so the error is a fixed
sentence with no detail about the record at all: probing ids for "not found" versus "not yours" learns
nothing either way. `ActionConflictError` is thrown when `packages/db`'s own repos refuse a write with
`{ ok: false, conflict }` (PROJ-3, TEN-5 — D-12) — a name, a project, a course, already named by the repo
itself. That is safe to pass through because PROJ-3 and TEN-5 are both scoped to the _caller's own_
organization (`repos/courses.ts`'s `findCourseNameConflict`, `loadOwnedProject`): the record named in a
conflict is always one the caller could already find by listing their own courses and projects, so naming it
again in the error saves a round trip rather than leaking anything. The asymmetry is about whose data a
message can expose, not a looser editorial bar for "how much detail is too much" — the same record, reached
through a policy refusal on a _different_ organization's data, still gets `ActionRefusedError`'s empty
sentence regardless of what it collided with.

**Choice, the meter hook stays unfilled.** `Action.meter` (`types.ts`) and `MeterContext` exist, and
`dispatch.ts` calls a declared meter after authorization and before execution (ACT-4's ordering), but none of
the six ported actions supplies one — this slice has no cost ledger to attribute against, and ACT-2's own text
("authorization runs outside the usage attribution context") is about _when_ metering may run relative to
authorization, not a license to build the ledger itself here. Tests exercise the pipeline's ordering with a
recording no-op meter (`tests/dispatch-order.test.ts`) rather than a real one. The real implementation belongs
to whichever future slice adds the cost ledger — likely `packages/jobs` or the worker, since the same "an
unauthorized call must not be metered" ordering this slice already enforces is exactly what a paid action (a
model call `answer.ts` already meters informally via its own `usage` counters, D-15) would need before it can
be billed per organization rather than per platform.

**Limits.** `ActionRegistry` is a plain class rather than a validated, versioned catalog — two actions
registered under the same name throw at registration time, which only surfaces if something actually calls
`register` for both (a test does, for the six ported actions; nothing enforces that every future action's
registration is exercised at all). The JSON-Schema catalog (ACT-6, `z.toJSONSchema`) is derived correctly for
this slice's own schemas but was only checked against the subset of JSON Schema those schemas actually produce
(object, array, string, number/integer, boolean, null, `enum`, `anyOf`, `minLength`) — a future action with a
schema shape outside that subset (a `oneOf`, a `pattern`, a recursive type) is untested territory for the
catalog's own correctness, though `z.toJSONSchema` itself is responsible for producing valid output regardless.

**Finding 9 (rework pass) — ACT-2's "an action cannot reach a record without having been given one that was
already checked" is a convention today, not a structural guarantee.** `ExecuteContext` (`types.ts`) hands
`execute` a live `Database`, and `packages/db`'s repos are ordinary importable functions scoped only by
whatever `organizationId` they are called with — so nothing stops an `execute` from importing `getCourse` and
calling it with an id, or an `organizationId`, `entity` never resolved. The six ported actions simply do not:
every `execute` in `src/actions/` reaches a record through `entity`, on purpose, but that is a fact about this
slice's own code, not one TypeScript or `dispatch.ts` enforces about the next action written. What would make
it real: dropping `db` from `ExecuteContext` entirely, and replacing it with a narrowed set of
already-org-scoped closures derived from the entity the policy just resolved (`entity.saveCategories`, say,
rather than `db` plus `courses.updateCourse`), so that a call reaching an arbitrary organization id is not
expressible in `execute`'s own signature — not merely avoided by convention. That is a larger reshaping of
`Action`, `Policy`, and every ported action's `execute` than this rework pass's brief calls for; it is recorded
here as the design question whichever slice builds the API (the first caller with untrusted callers on the
other end of `dispatch`) has to settle, not attempted in this one.

**Finding 10 (rework pass) — a descriptor names the resource an action's policy resolves, not necessarily the
one its `execute` writes.** `courses.save`'s descriptor is `{ resource: 'project', access: 'write' }` on both
the create and the update path — accurate to what the policy resolves (a project, always; a course too, on
update), but on update, `execute` writes a _course_, not the project. Nothing enforces descriptors yet (see
`policy.ts`'s own comment: they are read by `registry.ts`'s catalog, ACT-6, and pinned by the access audit
index, ACT-5, but not themselves checked by `dispatch.ts`), so this has no effect today. The day something
does enforce them — an assistant's own permission grant checked against a descriptor before `dispatch` is
called, say — an actor permitted only to write projects would be permitted to rewrite courses through this one
action, which is worth a reviewer's attention rather than a surprise. `tests/access-audit.test.ts`'s
`EXPECTED_DESCRIPTORS` comment on `courses.save` says so; this is the same note kept alongside it here.

---

## D-19 — `packages/auth`: lifetimes, why SHA-256 rather than a password KDF, no network for Google verification, and what AUTH-3's origin check still needs

**Problem.** AUTH-1 says a sign-in token "expires within minutes" without naming one; AUTH-3 gives sessions no
lifetime at all. Both need a stored form that is provably not the secret itself, and a choice about *how*
that form is derived matters for a token (unlike a password) because the two have different threat models.
AUTH-2 needs Google's public keys to check a signature without this package's tests ever reaching Google, and
AUTH-3 names an origin check this slice's brief explicitly defers to the HTTP layer — worth saying precisely
what is left undone, not just that it is out of scope.

**Choice, a fifteen-minute token and a thirty-day session.** `tokens.ts`'s `DEFAULT_TOKEN_TTL_MS` (fifteen
minutes) is long enough that a slow mail queue or a spam filter's delivery delay does not strand a legitimate
sign-in, short enough that a link sitting unread — or forwarded, or captured in a mail provider's own logs —
stops being useful within the same sitting it was requested in. `sessions.ts`'s `DEFAULT_SESSION_TTL_MS`
(thirty days) is not named by AUTH-3 at all; thirty days keeps an instructor signed in across a normal
teaching week without friction while still bounding how long a stolen laptop's session outlives the person
who stole it, and `revokeAllSessions` (AUTH-3's "every session of an account") is the escape hatch for the
gap between "expires eventually" and "should end now" — a password change or a reported compromise calls it
directly rather than waiting out the thirty days.

**Choice, SHA-256 rather than bcrypt/scrypt/argon2.** A password needs a slow, salted KDF because a human
picks it from a small effective space (dictionary words, patterns, reuse across sites) and a stolen hash is
then brute-forceable offline at whatever rate the attacker's hardware allows — the KDF's whole job is making
that rate expensive. A sign-in token and a session token are neither: both are `secrets.ts#generateSecret`'s
32 bytes of `node:crypto` CSPRNG output, 256 bits of entropy no dictionary or pattern search touches. Brute-
forcing a SHA-256 hash of a uniformly random 256-bit value is infeasible regardless of hash speed, so a slow
KDF here would only tax every request's CPU for a security property the token's own entropy already provides.
This is the standard distinction (the same reasoning GitHub, Stripe and most API-token systems apply to their
own tokens) and the reason `secrets.ts` says so inline rather than leaving the choice to look like an
oversight next to `packages/config`'s complete absence of a password feature.

**Choice, Google verification reaches no network in tests by resolving the JWKS through OIDC discovery, not a
hardcoded path.** The real Google issuer (`https://accounts.google.com`, `CONFIG.GOOGLE_ISSUER`'s default)
does not itself serve keys — the actual JWKS lives at a different host
(`https://www.googleapis.com/oauth2/v3/certs`) that only the issuer's own
`/.well-known/openid-configuration` document names. `google.ts#discoverJwks` fetches that discovery document
first, reads its `jwks_uri`, and fetches keys from there — through an injectable `fetchFn`, defaulting to the
global `fetch`. `tests/helpers/fake-google-server.ts` is a loopback `http.Server` serving both documents from
one port; every test in `tests/google.test.ts` points `issuer` at that server's own `baseUrl`, so the real
verifier's discovery, signature, issuer and audience checks are all exercised without any test ever reaching
`accounts.google.com`. Signature verification itself goes through `jose` (added as a dependency) rather than
being hand-rolled: RSA/JWT verification is exactly the class of code — skip `alg` confirmation, accept `none`,
miscompare a MAC without constant time — where a subtle mistake is a security defect rather than a bug, and
`jose` is a small, dependency-free, actively maintained implementation built for exactly this.

**Choice, `GOOGLE_CLIENT_ID` added to `packages/config`'s schema.** AUTH-2 requires the audience checked, and
nothing in the existing environment schema named it. Added as an optional string defaulting to `''` rather
than a required `z.url()`-style field, so a deployment that has not configured Google sign-in yet still
starts — `google.ts#createGoogleIdTokenVerifier` refuses every token outright when it is empty (the same
"never silently accept an unset audience" reasoning `admin.ts` and AUTH-4 already apply to an unset
`ADMIN_EMAILS`), rather than the schema forcing every deployment to set a value before it can start at all.

**Choice, `signInWithGoogle`'s response to AUTH-2's own collision case: refuse rather than fabricate a second
account.** AUTH-2's text says an unverified email matching an existing account "creates a new account rather
than linking." Taken completely literally that is impossible here: `accounts.email` is `UNIQUE` (a constraint
this slice does not touch — it ships with `TEN-1`/`TEN-2` and is out of this slice's file list), so a second
account cannot hold the identical email string a first one already does. `sign-in.ts#signInWithGoogle`
attempts the create anyway, catches exactly that constraint's violation (matched on the driver's own error
code and the constraint's column, the same way `discord-servers.ts#claimDiscordServerBinding` catches its own
primary-key race for TEN-3) and returns `undefined` — a clean refusal, not a session for the existing account
and not a crash. Refusing is still "not the existing account," the property the requirement's own attack
sentence exists to guarantee; the alternative (loosening `accounts.email`'s uniqueness to let a second row
share an address) would reopen the exact ambiguity email-based lookup exists to close, for a real-world
collision this rare. `tests/sign-in.test.ts` asserts the refusal directly: the victim's account and session
count are untouched by the attempt.

**Choice, `packages/db`'s two new repo files (`sign-in-tokens.ts`, `sessions.ts`) are organization-independent,
allowlisted the same way `accounts.ts#getAccountByEmail` and `discord-servers.ts#resolveDiscordServerBinding`
already are.** A sign-in token is keyed on the *email* it was requested for, not an account id — the account
it resolves to may not exist yet, since AUTH-1's "an account is created and accessed by a link" means a
first-time sign-in creates the account only on redemption (deliberately: creating an account merely because
someone typed an email address, before proving control of the mailbox, would let anyone pre-create accounts
for addresses they do not own). A session is keyed on `accountId`, the same account-not-org scoping `accounts`
itself uses, since a session authenticates a person across every organization their account belongs to.
`tests/tenant-scoping-convention.test.ts` was extended (new file list, new allowlist entries) rather than
carved around.

**Choice, `Executor`/`TransactingExecutor` exported from `packages/db/src/client.ts`.** AUTH-1's "consumed in
the same transaction that creates the session" and TEN-1's "a failure part-way leaves none of the three" both
span `sign_in_tokens`, `organizations`, `accounts` and `sessions` — four tables across three existing repo
files plus two new ones — and the architecture's own rule ("all SQL is confined to `packages/db/src/repos/`")
means that transaction has to be composed from calls into those repos, not written by `packages/auth` itself.
`db.transaction(...)`'s own callback parameter is structurally *not* a `Database` (it lacks `$client`, which
is not a connection you can close), so a repo function typed to take only `Database` cannot be called from
inside another transaction the way `sign-in.ts` needs to call `organizations.createOrganization` and
`accounts.createAccount`. `courses.ts` already had a module-private version of this exact idea (`Executor`,
for its own internal helpers); this slice exports the same shape from `client.ts` — plus
`TransactingExecutor`, `Executor & Pick<Database, 'transaction'>`, for `accounts.ts#createAccount`, which
opens its *own* nested transaction (a savepoint, when called from inside one) — and widens
`getAccountByEmail`, `createAccount` and `createOrganization`'s parameter types to accept it. This is a
type-level widening only: every existing caller still passes a full `Database`, which trivially satisfies the
narrower type, so no existing behaviour changed — proven by `packages/db`'s full existing suite passing
unmodified.

**What AUTH-3's origin check is waiting on.** SPEC.md's AUTH-3 sentence — "non-GET requests are checked
against their origin" — is CSRF defence, and CSRF is a property of a browser sending a cookie automatically
alongside a request the site did not intend; it has no meaning for a package with no HTTP server, no cookie,
and no request object at all. This slice's brief names it explicitly as deferred to the API slice that mounts
Express on top of `sessions.ts`. What that slice needs from here: `sessions.ts` already returns the *token*
value, not a cookie — the API slice owns wrapping it in a `Set-Cookie` header (`HttpOnly`, `Secure`,
`SameSite`, per SPEC.md) and reading the `Origin`/`Referer` header against `CONFIG.PUBLIC_APP_URL` on every
non-`GET` request before it ever reaches `validateSession`. Nothing in this package's surface makes that check
harder to add later — `validateSession` takes a bare token string and knows nothing about how it arrived.

**Limits.** `signInWithGoogle`'s collision refusal (above) is exercised by `tests/sign-in.test.ts` against a
throwaway SQLite database, not against Postgres — `TransactingExecutor`'s nested-transaction (savepoint)
behaviour is drizzle-orm's better-sqlite3 driver's own implementation, and D-2's portable-SQL discipline
covers the *schema* this slice adds, not a proof that savepoint semantics carry over unchanged to whichever
Postgres driver a later migration adopts. `google.ts`'s discovery step (which host serves the JWKS) is still
resolved once per process and not rediscovered — Google's own `jwks_uri` is stable in practice, and rediscovery
on every token would be a discovery-endpoint request per sign-in for no benefit; the *keys themselves* are a
different matter and are covered by the rework below (finding 6), since Google does rotate those on a schedule
this package cannot predict.

---

## Rework pass — three reviewers, including a security review (findings 1–9)

**Finding 1 — an expired session could be rotated back into a live one, and repeated rotation had no ceiling.**
`packages/db/src/repos/sessions.ts#revokeSessionByHash` checked `token_hash` and `revoked_at` but not
`expires_at`, so it reported an already-expired session as successfully revoked — indistinguishable, to its
caller, from revoking one that was still alive. `packages/auth/src/sessions.ts#rotateSession` read that
`Session` object back as proof the token it named was live and minted a fresh thirty-day session from it; the
practical effect was that any session token that had expired months ago — recovered from an old browser
profile, a filesystem backup, a stale device — could be presented to the sign-in path and walk away with a
brand-new, fully authenticated thirty-day session, no link and no Google token required. Two reviewers
reproduced it independently. `revokeSessionByHash` now takes `now` and checks `gt(expires_at, now)` the same
way `validateSession` already did, and `revokeSession` (the public single-session revoke) inherits the fix for
free — an already-dead session now reports "nothing to do," not "an active session just ended." The second half
of the same finding — repeated rotation extending a session forever, since each rotation resets the clock — is
closed by carrying the *original* session's `created_at` forward through every rotation in a chain
(`NewSession.createdAt`, threaded through by a new internal `createSessionRow` rather than exposed on the
public `createSession`, which has no legitimate reason to accept a caller-supplied creation time) and refusing
to rotate once that chain is older than `MAX_SESSION_AGE_MS` — six times `DEFAULT_SESSION_TTL_MS`. The old
token is revoked either way in that case, ending the chain rather than reviving it. `tests/sessions.test.ts`
(both packages) covers all three: rotating an expired session, revoking an expired session, and a chain past
the age cap.

**Finding 2 — an unverified Google identity could pre-register an account before its real owner ever signed
in, and a proven return did not revoke what came before it.** `link.ts#decideLinkOutcome` returned `create` for
an unverified email matching nobody — read in isolation this looked like the ordinary first-time case
`link.ts`'s own comment described it as, but AUTH-2's own attack sentence is about who gets to *hold* an
account, not only about who gets to *reach* an existing one. An attacker asserting `victim@school.edu` with
`emailVerified: false` got a real, thirty-day session on a freshly created account for that address; the actual
victim, redeeming a legitimate sign-in link for the same address moments or months later, was handed the
*same* account (`getAccountByEmail` found it) with `createdAccount: false` — and the attacker's session kept
validating throughout, on the victim's own account. The fix tightens `decideLinkOutcome` to a third outcome,
`reject`, returned whenever `emailVerified` is false — matching an existing account or not — so an unverified
assertion cannot link *or* create; SPEC.md's AUTH-2 body was updated to say this plainly (the id is unchanged;
only the requirement's prose changed, per `docs/CONTRIBUTING.md`'s "never change an existing id" rule — the
manifest was regenerated with `npm run board:derive` to match). Belt and braces, in the same fix:
`redeemSignInLink` now revokes a returning account's other sessions the moment it proves control of the
address — proving an address is the moment to invalidate anything issued before the proof, closing the window
even for whatever pre-registration route reaches an account next. `packages/auth/tests/link.test.ts` and
`tests/sign-in.test.ts` both cover the reproduction directly: a `signInWithGoogle` call with an unverified,
non-matching identity, asserted first, followed by the legitimate owner's own first sign-in, which must create
a *fresh* account rather than inherit the attacker's.

Not settled here, and worth a future slice's attention: this fix makes an unverified Google identity unable to
reach *any* account through `signInWithGoogle`, which also means there is currently no way to add a Google
identity to an account that signed up by email only, short of Google itself asserting that account's email
verified. That is almost certainly the common case (Google verifies its own users' emails before it will assert
`email_verified: true`), so it is not expected to be a practical gap — but a Google `sub`-to-account binding
table, letting an already-authenticated session explicitly link a Google identity regardless of the email
match, is a design question a reviewer raised and this rework pass deliberately left unsettled, rather than
building a binding mechanism the brief did not ask for.

**Finding 3 — `accounts.disabled_at` was enforced nowhere.** The column's own comment ("set to disable sign-in
without deleting the account or anything it owns") described a control nothing read in a conditional — a grep
found it only in the column definition and one `select` projection. An operator disabling a compromised
account changed nothing observable: existing sessions kept validating for their full remaining TTL, and the
account could request a fresh sign-in link and use it immediately. Closed in three places, atomically where it
matters: `packages/db/src/repos/accounts.ts#disableAccount` sets `disabled_at` and revokes every session the
account holds in one transaction, so disabling is one operation, not two a caller could forget the second half
of; `packages/db/src/repos/sessions.ts#validateSession` now excludes a session whose account is disabled via a
subquery in the same `UPDATE ... WHERE` (not a join, so it stays one statement — D-2's portable-SQL discipline),
so an in-flight session stops the moment the account is disabled rather than at its own TTL; and both
`redeemSignInLink` and `signInWithGoogle` refuse to sign in a disabled account. `redeemSignInLink` still
consumes the token on that refusal — it was legitimately issued and legitimately redeemed, and leaving it
usable against a possible future re-enable would reopen AUTH-1's single-use property. `disableAccount` is
account-wide by design, the same TEN-2 exception class as `getAccountByEmail` (`disabled_at` lives on
`accounts`, not `memberships`) — `tests/tenant-scoping-convention.test.ts` already carried a comment describing
exactly the wrong shape to avoid (`organizationId` used only for a membership pre-check ahead of an unscoped
`UPDATE`) from when this table was first added; `disableAccount` does not repeat it, and is allowlisted
alongside `getAccountByEmail` rather than taking an `organizationId` it would not use to scope its own write.

**Finding 4 — the mail port was never used.** `email.ts`'s own module comment said `sign-in.ts` sends a
sign-in link through it; nothing did. `sign-in.ts#requestSignInLink` now composes `issueSignInToken` and
`EmailSender#send`, taking the sender and a `buildLink` callback as explicit deps (this package has no notion
of the web app's own base URL or route, so that stays the caller's to supply) and returning nothing — the
plaintext token's only destination is the outgoing email. Tested with `RecordingEmailSender`.

**Finding 5 — `issueSignInToken`'s `ttlMs` had no upper bound.** A caller could ask for, and a reviewer
confirmed redeemed, a year-long sign-in link — AUTH-1's "expire within minutes" held only because every caller
today happens to ask for the default, not because anything enforced it. `issueSignInToken` now clamps `ttlMs`
to a new `MAX_TOKEN_TTL_MS`, set equal to `DEFAULT_TOKEN_TTL_MS`: nothing about a sign-in link needs to live
longer than the fifteen minutes already chosen for it.

**Finding 6 — Google's key set was fetched once per process and never refreshed.** `google.ts` used
`createLocalJWKSet` over a JWKS fetched once, on the first `verifyIdToken` call, and cached for the process's
whole lifetime — accurate to what the file's own comment said, and wrong: Google rotates its signing keys on
its own schedule, and a long-running API process would start refusing *every* Google sign-in the moment its
cached key stopped being served, recovering only on the next restart. Switched to `jose`'s `createRemoteJWKSet`,
which does the caching, cooldown and on-unknown-`kid` refetch properly, keeping only the JWKS *location*
(resolved via the same OIDC discovery as before) cached across calls rather than the keys themselves. The
loopback fake (`tests/helpers/fake-google-server.ts`) gained a `rotateKey()` that swaps in a new key under a
new `kid`, and `google.test.ts` proves a token signed after rotation still verifies — with `cooldownDuration: 0`
passed through the new `jwksOptions` escape hatch, since `jose`'s real default (thirty seconds) exists
specifically to stop a flood of bad tokens turning into a flood of requests to Google, and a test should not
need to out-wait a protection a production deployment keeps.

**Finding 7 — `packages/auth` depended on `@bloombot/logger` and imported it nowhere.** Dropped from
`package.json`; `packages/auth` logs nothing, which is deliberate (the security review noted it as something
that held, not something to add) and this dependency did not reflect that.

**Finding 8 — a test that could not fail.** `tests/tokens.test.ts`'s replay test asserted
`expect(neverExisted).toBe(replayed)`, comparing two `undefined`s — trivially true regardless of what either
call actually did, and no stronger than the `toBeUndefined()` assertions already sitting above it. Replaced
with an assertion the no-oracle property actually needs: that the replay attempt leaves no further trace on the
row's own `used_at` — the one place a "was this already spent" fact lives — so a caller cannot use a side
effect of the *replay itself* to tell "never existed" apart from "already used."

**Finding 9 — two things for whoever runs the tooling next.** `drizzle-kit check`, run from the repository
root, is *vacuous*: `packages/db/drizzle.config.ts`'s `out: './migrations'` resolves against the current
working directory, not the config file's own location, so running it from the root silently creates an empty
`./migrations/meta` there and reports "Everything's fine" without having examined a single real migration —
must be run from `packages/db`. And: `validateSession` writes on every request, to touch `last_seen_at`, so
with the API and the bot sharing one SQLite file (D-2), every authenticated request takes a write lock — fine
at this scale with WAL and the five-second busy timeout already set in `client.ts`, but worth the API slice
knowing before it is the thing explaining an unexpected `SQLITE_BUSY` under load.

---

## D-20 — `apps/api`: the origin check's missing-header default, `SameSite=Lax`, one route for every action, and how a caller's organization is resolved

**Problem.** API-3 says a non-GET request "is checked against its origin," but says nothing about a request
carrying neither `Origin` nor `Referer` at all — the brief for this slice calls that out explicitly as the
usual way such a check ends up decorative. API-2 names `SameSite` without naming which value. ACT-6's catalog
indexes every action by one dotted name; nothing in ACT-1..6 says whether the HTTP surface should mirror that
with one route or one per action. And every action's policy resolves against `context.organizationId`
(`packages/actions`'s own `DispatchContext`), but nothing before this slice decided how that value reaches
`dispatch` from an HTTP request in the first place.

**Choice, a non-GET request with neither `Origin` nor `Referer` is refused, not allowed through.**
`middleware/origin.ts`'s own module comment makes the reasoning explicit: this API expects to serve a same-site
front end, and a same-site `fetch` or form submission always carries `Origin` — there is no legitimate request
shape this API needs to support that arrives with both headers stripped. Treating "absent" as "allowed" would
not exempt some real, awkward client; it would just be the gap an attacker's request finds, since a page that
wants to hide where a request came from can suppress both headers far more easily than it can forge a matching
one. `tests/middleware/origin.test.ts` asserts this directly, with a recording action so the refusal is proven
by "never dispatched," not merely by a status code.

**Choice, `SameSite=Lax` rather than `Strict`.** AUTH-1's sign-in flow depends on a link delivered by email —
an external origin by construction. Clicking that link is a cross-site, top-level `GET` navigation into this
platform's own front end; a `Strict` cookie would not be sent on that very navigation (were a session already
live in the same browser), which is a real, live flow this platform needs to keep working, not a hypothetical
one. `Lax` still withholds the cookie from a cross-site non-GET request — precisely the CSRF property AUTH-3
cares about — so nothing is given up on the axis the origin check (API-3) already covers explicitly; `Strict`
would only cost the email-link flow for no additional protection against the attack API-3 and `SameSite` both
exist to stop. `middleware/session.ts#setSessionCookie` sets it on every session cookie this API issues.

**Choice, one route dispatches any action by name, not a route per action.** `packages/actions`' own
`ActionRegistry` already indexes every action by its dotted name (ACT-1, ACT-6's catalog); a route per action
would be a second list of the same names to keep in sync with it by hand, the exact "rewriting every route
twice" the roadmap's own phase-5 note warns retrofitting authorization onto existing routes would cause, one
level down. `routes/actions.ts#buildActionsRouter` is `POST /organizations/:organizationId/actions/:actionName`
— a new action registered in `packages/actions` reaches this API with no change here at all, and API-1's own
"a route validates nothing, authorizes nothing" is easier to keep true for one small route than to re-verify
for every route a hand-written list would eventually accumulate.

**Choice, the caller's organization comes from their own membership, resolved via the `:organizationId` route
parameter, never from the request body.** An account is not organization-scoped (TEN-1/TEN-2: the same account
can hold a membership in more than one organization), so nothing about a signed-in session alone names "the"
organization a request acts within — unlike `accountId`, there is no single value `sessionMiddleware` can
attach. `routes/actions.ts` takes the organization id from the URL and checks it against
`memberships.getMembership(organizationId, accountId, db)` (an existing, already-scoped `packages/db` function
— nothing was added to that package for this slice) before ever calling `dispatch`; a caller with no membership
there is refused the same way ACT-3 refuses any other absence (TEN-5: indistinguishable from "does not exist").
Nothing in the request body is ever read for this — most of the six actions' own input schemas have no
`organizationId` field for a body to name in the first place, and `dispatch`'s zod validation strips an
unrecognized one from those that could be confused for it either way; `tests/routes/actions.test.ts` proves the
stronger property directly, with a body that names a second, real organization, checking the *record* dispatch
actually created rather than trusting that the field was merely absent.

**Choice, no real mail transport exists yet, so `src/index.ts` logs the email it would have sent.**
`@bloombot/auth`'s own D-19 says its `EmailSender` port's real implementation "is a later slice's adapter
package" — none exists. Rather than invent a credential this slice was told not to, or silently drop every
sign-in link in production, `src/logging-email-sender.ts#LoggingEmailSender` implements the same port and logs
each send at `info` level, visible to whoever operates the process. This is a deliberate, temporary stand-in:
replacing it with a real transport later needs no change anywhere else, since every caller of `EmailSender`
already depends on the interface, not this implementation.

**Choice, "who am I" reports only what the session cookie itself already proved.** `GET /auth/me` returns
`{ account: { id } }` (or `{ account: null }`) — `req.session.accountId`, nothing looked up beyond it. Reaching
further (an email, a display name) would need an unscoped account-by-id lookup `packages/db`'s `accounts.ts`
does not currently expose — its own two documented TEN-2 exceptions are keyed on email or are the account-wide
`disableAccount`, neither of which fits "look this account up by the id a session already named." Adding one
was judged out of this slice's own file list (`apps/api` only) for a field nothing in this slice's own tests or
brief actually needs; a richer profile read is better scoped to whichever future slice gives it a real
consumer (an account-settings page, say) than added speculatively here.

**Limits.** The origin check compares scheme+host+port only (`URL#origin`), not the full URL — the standard
shape this kind of check takes, and matches how a browser itself scopes `SameSite`. `checkHealth` (API-6) proves
the database is reachable with a cheap `select 1` against the live connection; it does not (and given D-19's own
note about `validateSession` already taking a write lock on every authenticated request, deliberately does not)
attempt a write of its own on every health check. `apps/api` is not part of the coverage floor `vitest.config.ts`
enforces, the same call already made for `apps/bot` and for the same reason — see that file's own comment.

---

## D-21 — `packages/db`/`packages/auth`/`packages/discord-rest`/`apps/api`: where the install state lives, what the guild-administration check trusts, and what happens to a binding when an organization is deleted

**Problem.** TEN-4 needs somewhere to hold an OAuth+PKCE attempt between "a signed-in caller begins an
install" and "Discord's callback completes it" — a state value, a PKCE verifier, which account and
organization began it, and a short expiry — and needs to decide, concretely, what "verify the installing
account actually administers the server" is allowed to trust. Neither is settled by TEN-1..6's own text.

**Choice, the install state lives in `packages/db` as `discord_install_states`, with the state hashed and the
verifier in plain text.** Mirrors `sign_in_tokens` closely (AUTH-1's own shape, `schema.ts`'s comment on
`signInTokens`): a random secret returned to the caller exactly once and stored only as its SHA-256 hash
(`@bloombot/auth`'s `secrets.ts#hashSecret`, the same function `tokens.ts`/`sessions.ts` already use), single-use
(`used_at`), short-lived (ten minutes — `discord-install.ts#DEFAULT_INSTALL_STATE_TTL_MS`; AUTH-1's own
fifteen-minute sign-in link is the closest precedent, shortened here because this state never sits in a mail
queue the way an emailed link does — it only ever travels as a URL parameter and a same-site POST body). The
PKCE `code_verifier` breaks that pattern deliberately: unlike a session token or a sign-in token, nothing ever
presents the verifier back to this platform to prove anything — the callback needs the *exact* value this
server generated, to hand to Discord's own token endpoint verbatim (RFC 7636 §4.5), and a SHA-256 hash of it
cannot be un-hashed to recover that value. Hashing it would not make it safer, only unusable, so it is stored
in plain text, in the same row the hashed state is found by. This is the sense in which "state" and "verifier"
are not the same kind of secret at all, despite sitting in the same table: the state is a bearer credential
(whoever presents the right one on callback is trusted to be the caller the attempt began for) and the
verifier is not (it is never presented to this platform by anyone; this platform presents it to Discord).

**Choice, the guild-administration check reads the caller's own guild list from Discord after the token
exchange, not the `guild_id` Discord's own redirect carries on its own.** `apps/api/src/routes/discord-servers.ts`'s
callback takes `guildId` from its request body (posted by the front end, which read it off Discord's own
redirect query string) only as *which entry to look up* in a list `@bloombot/discord-rest#getUserGuilds` reads
fresh, with the access token the exchange just returned — never as a claim taken at face value. What this
still trusts: that the access token itself proves who it belongs to (ordinary OAuth trust, not something this
slice can improve on) and that Discord's own `owner`/`permissions` fields on a guild summary are honest about
that account's real standing in that guild — `@bloombot/discord-rest#administersGuild` treats `owner: true` or
the `MANAGE_GUILD` bit (`0x20`, read as a `BigInt` since Discord's own bitfield can exceed the 32 bits
JavaScript's `&` operator works on) as sufficient, matching TEN-4's own text exactly and no more strictly. A
second read — the bot's own guild list, `getBotGuilds` with `BOT_TOKEN` — confirms the bot the exchange is
meant to have just installed is actually a member of the guild being claimed, closing the separate gap where a
caller administers a real guild the bot was never added to at all.

**Choice, an organization's deletion has no effect on its Discord server bindings, because organization
deletion does not exist yet.** No function anywhere in `packages/db` deletes an `organizations` row — TEN-1's
personal-organization-on-signup and every scoped table's `organization_id` foreign key assume the row simply
exists for the lifetime of the account structure built on it, and nothing in AUTH-1..4, TEN-1..6, or this
slice's own brief introduces a delete path. `discord_server_bindings.organization_id` references
`organizations.id` with SQLite's default `ON DELETE NO ACTION` (`schema.ts`), so if a future slice does add
organization deletion, a straightforward `DELETE FROM organizations` would fail with a foreign-key violation
while an active or removed binding still references it — refusing loudly rather than leaving an orphaned
binding row, but that is FROM this schema's default behaviour, not a decision this slice made on purpose. The
day organization deletion is designed, it needs its own answer for what happens to a binding (and to every
other tenant-scoped table) — plausibly "released the same way TEN-6's own removal already is," but that is a
call for that slice to make with TEN-6's full text in front of it, not one this slice should anticipate.

---

## D-22 — `apps/web`/`e2e`: framework and build choices, how the e2e harness starts and stops its processes, and three things the panel needed that the API does not expose

**Problem.** WEB-1..6 and QA-7 needed a real browser app and a real Playwright harness, neither of which
existed before this slice, plus a set of build-tooling decisions (`tsc --build`'s composite-project rules,
`vite build` vs. a dev-server transform, jsdom vs. node per test file) the rest of the monorepo's own
conventions do not directly answer for a browser bundle. Writing the panel also surfaced three places where
`apps/api`'s existing routes (deliberately out of this slice's scope — "do not change the API's routes") do
not give the panel enough to do everything WEB-3/WEB-4's text describes.

**Choice, React + Vite + TypeScript, no router and no state-management library.** `docs/ARCHITECTURE.md` and
SPEC §12 (PLAT-1) already name "the React control panel"; Vite is the build tool the brief itself suggested
and the one that makes a same-origin static bundle (WEB-1) cheapest to produce. The brief for this slice is
explicit that the panel is "a shell, not a design system" — three screens (sign in, redeem a link, the signed-
in shell) and two callback pages (`/sign-in/:token`, `/discord/callback`) do not need a router library;
`App.tsx` switches on `window.location.pathname` directly and uses `history.replaceState` for the two
one-time transitions (a redeemed link, a completed OAuth callback) that must not be reachable by pressing
"back." State lives in component `useState`, refetched from `GET /auth/me` after anything that changes it
(sign-in, sign-out) rather than a client-side store that could drift from what the session cookie actually
proves (WEB-2).

**Choice, `apps/web` is two composite tsc projects, not one.** `vite.config.ts` runs under Node at build/dev
time and needs `@types/node`; the browser source needs the DOM lib and `types: ["vite/client"]` for
`import.meta.env`, and mixing the two in one `tsconfig.json` would give one or the other the wrong ambient
globals. `apps/web/tsconfig.json` is a solution file (`files: []`, two references), the same shape the repo
root's own `tsconfig.json` already takes — `apps/web/tsconfig.app.json` for `src/`, `apps/web/tsconfig.node.json`
for `vite.config.ts`. Both emit into `.tsbuild/` rather than `dist/`: `dist/` is `vite build`'s own output
directory, and letting `tsc --build`'s declaration files land there risked one build's artifacts being mistaken
for (or clobbered by) the other's, for a declaration output nothing in this repo ever imports the way another
package imports, say, `packages/db`'s. The same reasoning splits `apps/web/tsconfig.tests.json` out of the root
`tsconfig.tests.json`: this package's tests are `.tsx` and need the DOM lib and the JSX runtime, which every
other package's plain-Node test suite must not inherit — the root project's `include` explicitly `exclude`s
`apps/web/tests/**` and references the dedicated project instead of folding its settings into the shared one.

**Choice, the `web` vitest project stays outside the coverage floor.** `apps/web` (WEB-1..6, QA-7) is added to
`vitest.config.ts`'s `projects` array so its tests run under `npm test`, but not to `coverage.include` — the
same call already made for `apps/bot` and `apps/api`, and for the same reason (that file's own comment): it is
a thin translation layer (HTTP calls and JSX markup) around rules `packages/actions`/`packages/auth` already
hold to the floor, and QA-4's own text warns that a uniform target over markup buys assertions about DOM
structure at the cost of attention to logic. `tests/bundle.test.ts` (WEB-6) still enforces the one property
that actually matters about the bundle's content, just not as a line/branch percentage.

**Choice, the WEB-6 bundle test checks bundled *signatures*, not the bare import specifier.** The first version
of `tests/bundle.test.ts` searched the built `dist/` for the literal string `"@bloombot/db"` and passed even
after a scratch import of `@bloombot/db` was added to `apps/web/src/main.tsx` to check the test actually
catches something — Rollup inlines a bundled module's source rather than leaving its specifier as a string to
require at runtime, so the specifier itself does not survive being bundled. What does survive is
runtime-significant string content *inside* that source: `better-sqlite3` (an `import`/`require` of
`@bloombot/db`'s own native driver) and `discord_server_bindings` (a SQL table name literal in
`packages/db/src/schema.ts`) both did, and the test now checks for those — verified the same way, by
re-adding the scratch import, confirming the test fails, then removing it. `pino` (`@bloombot/logger`'s own
dependency) covers that package the same way; `@bloombot/auth` needs no signature of its own because it
depends on `@bloombot/db` (`eslint.config.js`'s own comment on why it is in `BROWSER_FORBIDDEN_PACKAGES` at
all), so importing it trips the `@bloombot/db` signatures already in the list.

**Choice, the e2e harness reuses `apps/api/src/server.ts#buildApp` directly, never `apps/api/src/index.ts`.**
`src/index.ts`'s own `main()` builds a `LoggingEmailSender`, which — on purpose (its own module comment) —
logs that mail was "sent" without ever logging the body, because a sign-in link is a bearer credential and
`logs/*.log` is a protected path for exactly that reason. That is exactly right for a real deployment and
useless for a test that needs to read the link back out, so `e2e/support/start-api.ts` calls `buildApp` with
its own `FileEmailSender` (`e2e/support/file-email-sender.ts`) instead — the same factory
`apps/api/tests/helpers/build-test-app.ts` already drives for the unit suite, so this needed no change to
`apps/api` itself. `FileEmailSender` appends each "sent" mail as one JSON line to `e2e/tmp/mail.jsonl`
(`.claude/hooks/guard-paths.sh`'s own comment already anticipates `e2e/tmp/` as a throwaway path); the
Playwright spec, a separate process, polls that file rather than sharing memory with the API process.

**Choice, fixed ports and a fixed database path, not dynamic allocation.** `e2e/support/env.ts` hardcodes
`E2E_API_PORT=3919`, `E2E_WEB_PORT=5919` and `e2e/tmp/e2e.db`, chosen away from `env.example`'s own dev
defaults (`3000`, `5173`) so this suite does not collide with a `npm run dev` already running locally. This
slice runs one Playwright project at a time, not several in parallel, so a free-port search would solve a
problem this harness does not have; `start-api.ts` deletes its own database (and the mail file) at the start
of every run rather than reusing one across runs, so a prior run's sign-in tokens and sessions cannot leak
into the next. `playwright.config.ts`'s `webServer` array starts and stops both processes around the whole
run — `reuseExistingServer: false` always, so a stale process left over from a previous manual run is refused
rather than silently reused (`http://127.0.0.1:5919 is already used` was hit, and fixed by killing the leftover
process, while writing this harness). `vite preview`'s command explicitly passes `--host 127.0.0.1`: without
it, its default host binding was observed not to answer on `127.0.0.1` promptly enough for Playwright's own
readiness poll, which checks exactly that address.

**What the panel needed that the API does not expose — three gaps, not fixed here (the brief: "do not change
the API's routes ... stop and report").**

1. **No route turns an organization id into a name.** `GET /auth/me` returns only `{ organizationId, role }`
   per membership (D-20's own "who am I reports only what the session cookie itself already proved," which
   explicitly left a richer profile/organization read to "whichever future slice gives it a real consumer").
   `components/OrganizationSwitcher.tsx` therefore shows the organization's id, not a name — WEB-3's "shows
   which one it is acting in" is satisfied literally, just not with a name a person would recognize at a
   glance. A `GET /organizations/:organizationId` (or a name on `/auth/me`'s own membership entries) is the
   natural fix, for whichever future slice gives it a consumer beyond this one.
2. **No route lists an organization's Discord server bindings.** `packages/db/src/repos/discord-servers.ts#listDiscordServerBindingsForOrganization`
   exists and is exercised by that package's own tests, but no `apps/api` route reaches it — only
   `install/begin`, `install/callback` and the `discordServers.remove` action exist, none of which answer "what
   is already installed." `components/InstallButton.tsx` can therefore only show "installed" for a server this
   *same browser session* just finished installing (state kept in the parent, `pages/Shell.tsx`) — a page
   reload, or a second device, sees no installed server at all even when one exists, which is a real gap in
   WEB-4's "a server already installed shows as installed" rather than something this slice's UI chose not to
   do. A `GET /organizations/:organizationId/discord-servers` route wrapping that existing repo function is
   the natural fix.
3. **The install callback's refusal is one outcome, not three.** WEB-4's text describes three outcomes —
   bound, "refused because the account does not administer that server," and "refused because the server
   belongs to somebody else — without saying who" — but TEN-5 and `apps/api/src/routes/discord-servers.ts`'s
   own callback deliberately collapse every refusal reason (an expired state, a guild the caller does not
   administer, a guild the bot was never added to, a server bound elsewhere) into the same `ActionRefusedError`
   (`404`, byte-identical body, "indistinguishable in every case" per that file's own comment) — a security
   choice this slice's brief also states directly (WEB-4's own "without saying who") and did not ask this
   slice to weaken. `pages/DiscordCallback.tsx` therefore renders the one refusal message
   `components/ErrorMessage.tsx` already renders for `action_refused` everywhere else in this app, rather than
   inventing two more specific messages the API gives it no way to tell apart — WEB-5's "the panel adds no
   interpretation the API did not give it" reads as the tie-breaker between the two requirements where they
   pull in different directions.

---

## D-23 — `packages/actions`/`apps/api`: read actions close D-22's first two gaps, a duplicate's courses are copied disabled, and what a removed binding looks like in the listing

**Problem.** PROJ-5 asks that "everything the control panel displays about projects and courses is read
through the action layer," and TEN-7/TEN-8 ask for an organization's own name and its Discord server bindings
to be readable at all — three things D-22 already named as gaps `apps/api`'s existing routes left open, closed
here as read _actions_ rather than the bespoke routes D-22 sketched as "the natural fix." Separately, PROJ-4
("a project can be copied into a new one, bringing its courses...") runs straight into PROJ-3: a duplicate's
courses are, by construction, copies — same category names, same admin and student role names as their
originals — which is exactly the collision PROJ-3 forbids among enabled courses in the same organization.
Something has to give, and the brief asked that it be a deliberate choice, not an accident discovered by the
first person who duplicates a project and then tries to enable its courses.

**Choice, five new actions, not five new routes.** `projects.list`, `courses.list`, `courses.get` and
`discordServers.list` (`packages/actions/src/actions/*.ts`) each declare a policy the same way every write in
this package already does — `projects.list` and `discordServers.list` resolve the caller's own organization
(the same "no existing record to resolve, resolve what it protects instead" shape `projects.create`'s policy
already uses), `courses.list` resolves the project a course list is scoped to, and `courses.get` resolves the
course itself, reusing `courses.enable`/`courses.disable`'s own `resolveOwnCourse`. `apps/api/src/routes/actions.ts`
needed no change at all: registering these five in `createPlatformRegistry` is enough for the existing generic
route, the existing `ACT-5` audit table and the existing `ACT-6` catalog test, and the `TEN-5` matrix
(`apps/api/tests/tenant-isolation.test.ts`) picks each one up automatically because it is derived from the
registry — the brief's own point in choosing actions over routes for a read.

**Choice, TEN-7's fix is `/auth/me`, not a new route.** The organization name itself already existed —
`@bloombot/auth`'s `sign-in.ts` already names a personal organization after the account that owns it
(`displayNameFromEmail(email)`), on both the email and Google paths, since before this slice. What was
missing was anywhere to read it back: `/auth/me`'s memberships now carry `organizationName` alongside
`organizationId`, looked up per membership with `organizations.getOrganizationById` — the one `apps/api`
change TEN-7 needed, matching the brief's "keep `apps/api` changes to what TEN-7 needs."

**Choice, a duplicate's courses are copied disabled, unconditionally — not refused, and not renamed.** Three
options were on the table: refuse to duplicate unless the source project is archived (PROJ-3's own other
escape hatch); auto-rename each copy's categories and roles to something guaranteed unique; or copy every
course disabled regardless of the source's own `enabled` flag. Refusing unless archived was rejected because
it makes duplication less useful exactly when it is most wanted — rolling a project forward while the current
term is still live and still routing. Auto-renaming was rejected because a category name and a role name are
not just database columns: they are supposed to match real Discord category and role names an instructor will
go configure to match, and silently generating `"Web Design - GLOBAL (2)"` would hand back a course that looks
configured but is not, for a distinction only readable in a diff. Copying disabled (`projects.ts#duplicateProjectAction`,
`enabled: false` unconditionally, whatever the source course's own flag was) makes the PROJ-3 collision this
slice worried about _unreachable at the point of copying_ — `createCourse`'s own PROJ-3 check only runs when
`input.enabled && projectResult.project.archivedAt === null` (`repos/courses.ts`), so a disabled copy runs no
collision check at all, succeeds unconditionally, and leaves the exact same names sitting there, inert, until
an instructor edits them (or the source project is archived) and enables the copy through `courses.enable`,
which re-runs PROJ-3 the same way it always does. The organization is never, at any point, in a state PROJ-3
would have refused — `tests/project-duplicate.test.ts`'s "copies every course disabled, even one that was
enabled in the source project" asserts exactly the case that would have collided, disabled instead.

**Correction, finding 1 of the PROJ-4/5/TEN-7/8 rework: the missing transaction was not, in fact, fine.** A
side effect this paragraph originally named, and then drew the wrong conclusion from: because the copy step
never runs PROJ-3's own check, `duplicateProjectAction`'s loop over `courses.createCourse` has no real failure
mode left *from PROJ-3* except a database error — true — and the original text treated that as license to skip
an outer transaction, reasoning that "a partial copy is not currently reachable in practice." That is exactly
backwards: a database error is precisely the case a transaction exists to cover, not a reason to omit one. A
fault on, say, the second course's own insert used to leave the new project committed with only some of its
courses — indistinguishable from a complete duplicate to anything that did not count — while also consuming
the chosen name, so the obvious recovery (retry the duplicate under the same name) was refused as a collision
with the very stub the failed attempt left behind, until the caller found and archived it. `createProject` and
`createCourse` now accept `Executor`/`TransactingExecutor` (`repos/projects.ts`, `repos/courses.ts`) the same
way `accounts.ts#createAccount` already did, so `duplicateProjectAction` opens one `db.transaction(...)` and
runs the whole copy — the new project and every course — inside it: a failure anywhere rolls all of it back,
including the project insert, so the name is free again for a retry. The "more machinery than this slice's own
scope asked for" judgment was the actual mistake here, not the transaction itself.

**Choice, `discordServers.list` shows a removed binding as removed, not omitted — corrected (finding 6 of the
PROJ-4/5/TEN-7/8 rework).** `listDiscordServerBindingsForOrganization` (`repos/discord-servers.ts`) already
returns every binding an organization has ever held, active or removed — nothing in this slice needed to
change that function, only give an action a way to call it. The action passes that shape straight through
rather than filtering to `removedAt IS NULL`, for the reason D-22's own gap 2 named: the panel's "what is
already installed" screen needs to tell "never installed" apart from "installed, then removed."

That distinction is **not stable**, and this paragraph originally overstated it. `discord_server_bindings` is
keyed on the Discord server's own snowflake alone (`claimDiscordServerBinding`'s own module comment,
`repos/discord-servers.ts`), and re-claiming a released binding *updates that same row* to the new
organization rather than inserting a second one (the same function, the `removed_at IS NULL` branch). So a
server organization A installed and later released shows in A's own `discordServers.list` as "installed, then
removed" — right up until organization B claims it, at which point the row's `organizationId` becomes B's and
the binding vanishes from A's listing entirely, reverting to indistinguishable from "never installed." Two
consequences follow, neither of which the original text named: first, "installed, then removed" is not a
durable fact about a binding A can rely on — it silently degrades back to "never installed" for exactly the
servers most likely to have moved. Second, an organization that polls this action can *detect* a re-claim: a
binding that used to appear removed and now does not appear at all means some other organization claimed that
server in between — a cross-tenant signal TEN-8's own text rules out ("a server bound to another organization
is not in it, and its existence is not disclosed"). The signal is weak (a disappearance, not a name or an id),
but it is real, and it is a direct consequence of one row standing in for a server's whole history.

Closing this properly needs a binding *history* table — one row per claim/release rather than one row per
server, `discordServerBindings` kept as "current state" and a new `discord_server_binding_events` (or similar)
recording every claim and release with its own organization id — so a released binding stays visibly removed
for the organization that released it regardless of what happens to the server afterward, and no listing ever
has to reuse a row across two different organizations' histories. That is real schema and migration work, well
past what this slice's own read-surface scope asked for; it is left for whichever slice next touches
`discord_server_bindings`.

**What "knowledge-file attachments" will mean, for whichever slice adds them.** PROJ-4's own SPEC text says a
duplicate brings "instructions and knowledge-file attachments" — nothing in `packages/db`'s schema has a table
for either a knowledge file or an attachment yet (Phase 10, "Knowledge files & instructions," is still empty in
`docs/ROADMAP.md`), so this slice's `duplicateProjectAction` copies every column `courses` actually has today
(`instructions`, `promptId`, `model`, `vectorStoreId`, `maxRequestsPerDay`, `conversationScope`) and copies
nothing for knowledge files because there is nothing to copy. The natural shape, whenever that table exists, is
the same one this slice already uses for categories and channels: read the source course's attachment rows,
insert new rows pointing at the same underlying file (or a copy of it, if a file's own lifecycle turns out to
be tied to one course) under the new course's id — the same "bring the settings, not the roster" pattern PROJ-4
already describes, extended to a table this slice never touched.
