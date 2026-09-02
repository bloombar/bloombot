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
database connection or any per-request state: every one of those already degrades to a logged error and a
reply rather than taking the whole process down (CORE-5's "a model failure degrades to an apology, never ... a
stack trace" — the same discipline one level up), so there is nothing about them a process-level check could
report that would not just restate what the logs already say better, and a health check that pings the
database on every probe would give a supervisor a reason to restart a process that is otherwise serving
students fine. **Updated by D-33:** the OpenAI adapter is the one exception this paragraph's own "nothing
else" no longer holds — `COST-5` added a second field, `model` (the running call/error count from
`@bloombot/core`'s `createCountingModelClient`), for the reason D-33's own "Choice, on `COST-5`'s monitoring
read" paragraph gives: the provider's error rate has to be observed by the one process that actually calls it.
This paragraph's "gateway connectivity and nothing else" is therefore its own heading, not its own body, as of
that slice — corrected here rather than left to silently disagree with the code.

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

---

## D-24 — `apps/api/tests`: why every test's server must bind loopback itself, and why the bind has to be awaited

**Problem.** Roughly one run in ten of `apps/api`'s test project failed, always shaped as a session or
membership that should exist reading as absent — a live investigation traced this to `supertest`'s own
`Test#serverAddress` (`node_modules/supertest/lib/test.js`), which calls `app.listen(0)` with no host when
handed a bare Express app. That binds the IPv6 wildcard `::`, then dials the hard-coded literal
`http://127.0.0.1:<port>`. `SO_REUSEADDR` lets the OS hand that wildcard listen an ephemeral port some other
process already holds bound specifically to `127.0.0.1` — this machine runs plenty (VS Code's helper sockets,
`vite`'s own dev server) — and the more specific binding wins the connection, so the request never reaches
the app under test and whatever that other process answers gets parsed as if it had. Measured at 0.10% per
request, against ~50-60 requests an `api` run makes: about the observed one-in-ten failure rate. Nothing in
`apps/api/src`, the database, the clock, or the token/tenancy layers was at fault.

**Choice.** `apps/api/tests/helpers/build-test-app.ts`'s `startTestServer` wraps the built Express app in
`http.createServer(app)` and awaits `server.listen(0, '127.0.0.1')` itself, handing supertest an
already-listening server rather than a bare app — supertest reads the address off a server it did not create
instead of picking one itself. `buildTestApp` (and `health.test.ts`'s own inline second app) call it, and are
now async as a result: every `const app = buildTestApp(...)` call site became `await buildTestApp(...)`, and
every helper that took an `Express` now takes the `http.Server` supertest is handed instead
(`tenant-isolation.test.ts`'s `send`, `discord-servers.test.ts`'s `beginInstall`).

**Why the bind has to be awaited, not patched around.** `listen(0, '127.0.0.1')` runs `dns.lookup` even for an
IP literal, so it is asynchronous regardless of how synchronous it looks — `server.address()` is still `null`
immediately after the call returns. A monkey-patch of `Test.prototype.serverAddress` cannot work for the same
reason: there is no synchronous moment at which the address exists to read.

**Why not dial `[::1]` instead.** `vite` already binds `[::1]:5173-5175` on this machine, so the same
collision class would survive, just rarer — the fix has to be a specific loopback address that nothing else
plausibly shares, not merely a different specific address.

**Who owns closing the servers.** supertest closes only a server it created itself (`this._server` is set
only on the `!addr` branch of `serverAddress`) — handing it a pre-bound server means the tests own its
lifetime. `build-test-app.ts` makes that structural rather than a convention each file has to remember: every
server `startTestServer` opens is tracked in a module-level `Set`, and a single `afterEach` registered by the
helper itself (at import time, so it runs once per test file under vitest's own per-file module isolation)
closes whatever that file's tests opened. A test file that imports `buildTestApp` gets this for free; nothing
in the file itself has to call a cleanup function.

**Proof this is the actual fix, not a plausible-sounding one.** `build-test-app.test.ts` binds a squatter to a
specific `127.0.0.1` port, then asks `startTestServer` for that exact port, and asserts the bind rejects with
`EADDRINUSE` rather than silently landing somewhere else — the property that makes this whole class of bug
impossible rather than merely unlikely, and the one a fix that only reduced the odds (a retry loop, a
different but still-shared address) would not have. Separately, `npx vitest run --project api` was run 30
times after the fix, with 0 failures (`docs/DECISIONS.md`'s own author has the raw log; the pre-fix rate was
roughly 1 in 10).

**Limits.** This only fixes `apps/api`'s own suite — the only package in this repo using supertest (checked
by grep, along with every other `.listen(0)` call site in the repo; none found). If a future package adds
HTTP tests over supertest, it needs the same `startTestServer`-style helper, not a bare `request(app)` — the
squatter-collision test above is the regression to copy alongside it.

---

## D-25 — `apps/web`: how `pages/CourseEditor.tsx` maps onto `courses.save`'s partial-update rule, and what QA-8's harness does and does not prove

**Problem.** `courses.save`'s own input (`packages/actions/src/actions/courses.ts`) treats an *omitted*
optional field (`promptId`, `instructions`, `model`, `vectorStoreId`, `maxRequestsPerDay`) as "keep whatever
is stored" and an *explicit* `null` as "clear it" — the distinction `keepOrClear` exists for. That rule is
right for a partial API caller that only wants to touch one field, but it is exactly the rule a defect in an
earlier slice already got wrong once (finding 2 of the PROJ-5/TEN-7/8 rework, `docs/DECISIONS.md` D-23's own
neighbour), so WEB-8's brief asked this slice to get it right deliberately rather than by accident a second
time. Separately, QA-8 asks for "one test [that] drives a browser to create a project and define a course in
it, and then a message ... is answered using that course's own configuration" — a claim that spans a real
browser, a real API, and `@bloombot/discord`'s own Discord-shaped pipeline, none of which this repository's
Playwright harness had previously driven together.

**Choice, `pages/CourseEditor.tsx` never omits a key at all — it always sends every field it manages,
translating an empty input into an explicit `null`.** The omitted/explicit-null distinction exists for a
caller that only has *some* of a course's fields in hand and wants to leave the rest alone; this form is the
opposite case — by the time a save fires, it has just fetched (`courses.get`, on edit) or default-initialized
(on create) the whole record, so it always knows the full set of values it intends the saved row to hold. Its
`handleSave` builds `SaveCourseInput` by mapping each optional field through one `trim() === '' ? null :
value` — `null` when the instructor cleared the field, the trimmed value otherwise — and never spreads in a
conditional key the way `courses.save`'s own `execute` does for `conversationScope`. The one field this form
does *not* manage is `conversationScope` itself: CFG-2..4 do not mention it (D-4's own later addition), so
`SaveCourseInput` (`api/client.ts`) has no field for it at all, and the key is genuinely omitted from every
request this form sends — the one deliberate, documented use of "omitted" in this whole component, relied on
to preserve an update's existing value and let a create fall back to `courses.save`'s own default. The
regression this guards: `apps/web/tests/course-editor.test.tsx`'s "a save clears an optional field to an
explicit null, not an omitted key" asserts the request body literally contains `model: null` (not merely a
missing key) after clearing a field that had a value, and that an untouched nullable field the source course
already had (`promptId`) is still sent explicitly rather than silently dropped.

**Choice, the panel's project/course navigation is a plain `view` union in `pages/ProjectsPanel.tsx`, not a
second `window.location.pathname` switch alongside `App.tsx`'s own.** `App.tsx`'s own pathname-based routing
exists for two one-time entry points a browser can land on directly and must never revisit by pressing "back"
into (a redeemed sign-in link, a completed Discord OAuth callback — D-22's own choice). Moving between a
project and one of its courses has neither property: it is ordinary in-panel navigation with nothing to
protect against a back-button press, so a `useState<View>` discriminated union — the same shape `App.tsx`'s
own `SessionState` already uses one level up — is the whole "path-switch style, no router library" the brief
asked for, without inventing history entries this navigation has no need of. `pages/Shell.tsx` gates
`ProjectsPanel` behind its own `activeTab` state for an unrelated, narrower reason: `ProjectsPanel` fetches
`projects.list` (`api/client.ts#listProjects`) on mount, so mounting it unconditionally on every render of
`Shell.tsx` would fire that request even when an instructor is looking at the Discord tab instead.

**Choice, `activeTab` defaults to `'projects'`, not `'discord'`.** The first version of this gate defaulted to
Discord — the tab that already existed before this slice — for a reason that had nothing to do with the
product: every existing `Shell.tsx` test (`tests/shell.test.tsx`) mocked `dispatchAction` selectively per test
rather than by default, and mounting `ProjectsPanel` unconditionally would have fired an unmocked
`listProjects` call on every one of those tests' first render. That is a real cost, but it is a test-file cost,
not a reason for what an instructor sees on every reload — and a reviewer caught it as exactly that (finding 10
of the WEB-7 rework): the two comments explaining the default disagreed with each other, one giving this
paragraph's real reason and the other inventing a product one. The product reason instead governs the default
now: Projects is what an instructor comes to this panel for on nearly every visit once a server is installed,
so landing them on the install button every reload — one click away from the thing they actually came for — is
worse than the cost of updating the test file. `tests/shell.test.tsx` now mocks `listProjects`/`listCourses`
with a `beforeEach` default so every test's now-unconditional `ProjectsPanel` mount has something to resolve,
and the handful of tests that assert on the Discord tab's own content click it open explicitly first.

**What QA-8's harness proves, and what it stands in for — read `e2e/course-configuration.spec.ts`'s own module
comment for the full breakdown, summarized here.** Real: the browser driving `pages/Projects.tsx`,
`pages/Courses.tsx` and `pages/CourseEditor.tsx`; a real `apps/api`; a real throwaway SQLite database; every
action the panel calls, reached exactly the way any other caller reaches them; and `@bloombot/discord`'s own
`handleMention` plus `@bloombot/core`'s `answerQuestion`/`routeMessage` underneath it, unmodified, run
directly against that same database from the Playwright test process itself (not a second server) once the
browser's own part of the scenario ends. Not real, and each is a documented stand-in rather than an
oversight: there is no discord.js client and no gateway connection anywhere in this harness (`apps/bot` is out
of this slice's scope) — the Discord server binding this test needs is inserted directly with
`discordServers.claimDiscordServerBinding`, the same repository function TEN-4's real OAuth install flow
calls, invoked here instead of walked through Discord's own consent screen, which nothing in this harness can
automate; the "message arriving in Discord" is a plain `InboundMention` object this spec constructs by hand,
not something posted to a real channel; the model is `e2e/support/fake-model-client.ts`, a fixed string with
no OpenAI call anywhere in the run; and the logger passed to `handleMention` is
`e2e/support/fake-logger.ts` rather than `@bloombot/logger`'s real `createLogger`, because that reads
`@bloombot/config`'s `CONFIG` (`NODE_ENV`, `PUBLIC_APP_URL`), which is only ever set as an environment variable
for the *spawned* `apps/api` process (`playwright.config.ts`'s own `webServer.env`), not for the Playwright
test runner process this spec's own post-browser code actually executes in. So this test proves the database
round trip the whole migration exists to make true — a course defined entirely through the panel's own
screens is exactly the configuration `handleMention` routes and answers a matching message with, with no file
in this repository edited and no process restarted between the two — and it does not prove discord.js itself
wires correctly to `handleMention` or that a real OpenAI call succeeds, both of which are untouched by this
slice.

---

## D-26 — Surfaces are providers, and the schema is not yet written that way

**Problem.** Everything above Discord is already surface-agnostic: `CORE-1` makes answering one pipeline
for every surface, the core takes a plain inbound message and a reply port, `discord.js` lives in exactly
one file, and `person_identities.surface` is already an enum (`discord | web | mcp`). But three things are
Discord-shaped in the schema and the SPEC, and a second provider — Slack most likely — would collide with
all three.

**What is Discord-shaped today.**

1. `discord_server_bindings`, keyed on the guild snowflake alone, and `TEN-3`'s "one organization per
   Discord server". A provider-keyed binding — unique on `(provider, workspace_id)` — is the same rule
   stated once instead of once per provider.
2. **Routing.** `CORE-2` matches on a Discord *category* name, then on the author's *roles*. Slack has
   neither: channels are flat, and user groups are not roles. This is the substantive work — routing needs
   a provider-agnostic "the container this arrived in" plus a per-provider resolver, not a second copy of
   `routeMessage`.
3. The install flow (`TEN-4`) is Discord OAuth end to end, including the guild-administration check.

**Choice.** Do not generalize speculatively now, and do not let more Discord-specific structure accumulate
either. The roster and knowledge-file phases hang new tables off courses and servers; **generalizing the
binding and the routing contract is cheaper before those land than after**, so this is scheduled work
rather than a someday. When a second provider is actually wanted, the order is: rename the binding table
to a provider-keyed one with a migration, widen `routeMessage`'s input to a container plus a provider tag,
then add the adapter package and its app.

**Why not now.** No second provider is asked for, and a generalization with one implementation is a guess
about the second. The cost of waiting is one migration and one contract change, both bounded and both
covered by tests that already exist.

**Limits.** The estimate holds only while `discord.js` stays in `apps/bot` and all SQL stays in
`packages/db/src/repos/` — the two rules that keep the blast radius to a rename. If either is broken, this
becomes a rewrite.

---

## D-27 — Linking a person across surfaces is proof of the account, not a matching address

**Problem.** A student answers questions in Discord as a `person` with a `discord` identity; an instructor
signs into the panel as an `account`. Nothing joins the two, and nothing should join them by guessing. When
the web chat surface lands, a student arriving in a browser has to be recognized as the same person the bot
has been talking to — `CONV-1` keys conversations and the daily allowance on the person, not the surface,
and that is the whole point.

**Choice.** Two separate controls, written as `PPL-4` and `PPL-5`.

- **Linking is proof of the surface account.** Signing in with Discord proves control of the snowflake the
  bot already knows, needs no address, and works for the many students who have a person record and no
  email at all — the bot fills its own roster as students arrive (`PPL-3`).
- **Disclosure requires a verified address.** Answering a question needs none. Reading a transcript back,
  exporting one, or carrying a conversation onto a second surface is a disclosure, and that gate is an
  address the platform verified itself.

**Why not match on the roster email.** It inherits `AUTH-2`'s lesson, which cost a real defect in this
build: an unverified assertion now signs nobody in, because matching an address that somebody else asserted
is how one person inherits another's account. A roster address is an instructor's claim about a third
party — good corroboration, poor authority — and it strands every student who was never on a roster.

**Limits.** Discord sign-in on the student surface means a second OAuth client and a second callback to get
right, and the guard rails `TEN-4` already established (single-use state, PKCE, discard the token) apply
there too. A person who genuinely loses access to their Discord account needs an instructor-initiated
re-link, which is an audited action nobody has specified yet.

---

## D-28 — Connecting an account: invite first, prove on the web, and merge without resetting

**Problem.** Three surfaces are planned — Discord, the web chat and MCP — and usage has to be monitored,
logged and capped per person across all three. `CONV-3` already keys the daily count on (course, person,
day), so the counting works the moment the surfaces agree on who the person is. Agreeing is the problem.

**Choice.** An identity the platform cannot attribute is **invited, not answered** (`LINK-1`). The invitation
is the panel's address and nothing else (`LINK-2`); proof happens after signing in, using the surface's own
sign-in where it has one, or a single-use token delivered somewhere only that caller can read it
(`LINK-3`).

**Why the invitation carries no secret.** A course channel is public. A claim link with a token in it is a
token anybody in the channel can spend — the first person to open it binds their account to that student's
Discord identity and inherits their conversations, their transcript and their allowance. Discord's own
OAuth proves the same snowflake with nothing secret in transit, which is `PPL-4` applied to the direction a
student actually travels. MCP is the exception that needs a token: its tool result is private to the calling
client, and the surface has no sign-in of its own to lean on.

**Why nobody is answered before connecting.** The alternative — answer on the first surface, require
connecting only for a second — leaves a window where a person has an unattributed allowance, and a student
who never connects keeps one per surface. That is `D-4`'s evasion, reintroduced. Refusing the first answer
costs a step of friction and buys complete attribution from message one.

**Cost, stated plainly.** This is friction exactly where `PPL-3` deliberately removed it: today nothing
stands between a student and their first answer. Instructors will feel it at the start of term, when thirty
students each meet a connect prompt instead of a reply. It is the price of counting honestly across three
surfaces, and it is reversible per course later if it proves worse than the evasion it prevents.

**The merge is the hard part, not the linking.** A person already exists when they connect, so connecting
merges two records. The rules are `LINK-4`'s: identities move to the survivor, conversations and transcripts
are preserved rather than dropped, and the day's usage is **combined, never restarted** — a merge that reset
the count would make connecting the cheapest way to double an allowance. It is idempotent and recorded,
because it rewrites who owns a transcript.

**Limits.** Two questions are deliberately unanswered here and belong to the slice that builds this: what
happens when a person genuinely loses access to a connected surface account and needs an instructor to
re-link them (an audited action nobody has specified), and whether a merge is ever reversible. Neither is
needed to build `LINK-1..5`, and guessing at them now would be inventing requirements.

---

## D-29 — `packages/db`/`packages/jobs`/`apps/worker`/`packages/core`: a queue in SQLite, the lease and backoff numbers, and where admission sits relative to the allowance

**Problem.** `JOB-1..5` need a queue a worker can claim from without two workers ever running the same job
twice, a retry policy that stops rather than spins forever, and a bound on concurrent model calls (`JOB-4`)
applied somewhere in `packages/core`'s answering path — which, combined with `CORE-3`'s existing allowance
reservation, raises a question neither requirement answers on its own: which happens first?

**Choice, on the queue itself.** `jobs` is a plain table (`packages/db/src/schema.ts`), and claiming a row is
one conditional `UPDATE` whose own `WHERE` re-asserts the exact eligibility the candidate `SELECT` picked it
under (`repos/jobs.ts#claimNextJob`) — the same select-then-conditional-write shape `claimDiscordServerBinding`
already uses for `TEN-3`, not a new device. `D-2`'s own "Limits" paragraph names "the job-claim dialect split
isolated behind one repo function" as one of the rules that keeps the portable-subset claim honest, and this
is exactly that: `claimNextJob` is the one function that would need a Postgres-specific rewrite (`SELECT ...
FOR UPDATE SKIP LOCKED` is the idiomatic form there), and every other function in `repos/jobs.ts` is the same
portable `and`/`or`/`eq` query-builder SQL every other repo in this package already writes. A queue is not
generally something SQLite is good at under real write concurrency — but this platform has exactly one writer
of this table at a time by construction (`apps/worker` is single-instance, `JOB-5`/`PLAT-4`), so the case D-2
actually has to hold up under is "one worker claiming, one enqueuing caller at a time," not the many-consumer
throughput a queue usually implies. If a second worker instance is ever intentionally run, this is the file
to revisit first.

**Choice, on the lease.** `JOB_CLAIM_LEASE_MS` defaults to five minutes. A worker crash mid-job has to make the
claim reclaimable again in a bounded time (`JOB-3`'s "releases its claim"), and the jobs this queue is built
for — provisioning a course's Discord channels, importing a roster, attaching a knowledge file — make more
than a handful of rate-limited Discord/OpenAI calls each; a lease shorter than the slowest of those risks a
second worker reclaiming and re-running a job that is still legitimately in progress, which is worse than
waiting a few extra minutes to notice a genuine crash. Five minutes is a guess bounded on both sides (long
enough for the slowest job this slice anticipates, short enough that a crash is not invisible for an entire
class period) rather than a measurement — there is no real job to time yet, since none is wired to the queue
in this slice. Revisit once phase 9/10 lands real handlers and their actual running time is known.

**Rework finding 5 — `JOB_HANDLER_TIMEOUT_MS`, and what a fired timeout means for idempotency.** Before this,
`runner.ts` awaited a handler call unbounded, and `apps/worker` runs one job at a time (`loop.ts`'s own module
comment) — a handler that never settled would stall every later claim indefinitely, invisibly, since the
lease alone does not reclaim a job while the very worker that claimed it is the one still "holding" it, wedged
mid-`await`. `JOB_HANDLER_TIMEOUT_MS` (default 240s, deliberately under `JOB_CLAIM_LEASE_MS`'s own 300s
default, so the timeout is the thing that actually fires and this worker can move on to its next claim while
the lease it holds the stuck job under is still comfortably unexpired) bounds that wait
(`packages/jobs/src/runner.ts#runHandlerWithTimeout`); past it, the attempt fails (or retries) with a clear
reason rather than hanging. What it does *not* do: stop the handler. JavaScript has no cooperative cancellation
for a `Promise` already in flight (`apps/worker/src/shutdown.ts`'s own module comment already says this about
shutdown, for the same underlying reason) — a handler still running underneath a fired timeout keeps running,
and may still write, call an upstream API, or otherwise act *after* `runNextJob` has already told the row it
failed or is due for retry. Nothing in this slice's own registry is real yet to make that concrete, but the
obligation lands on phase 9/10's own handlers: a handler that can be timed out here must tolerate being invoked
again (by a retry, or by a second worker reclaiming the row once the lease lapses) while its own earlier,
"timed-out" invocation might still be mid-flight — the same idempotency discipline `JOB-3`'s "a job runs once,
even with a worker restart in the middle" already asks of every handler, just triggered by a timeout rather
than a crash.

**Choice, on the backoff.** `JOB_RETRY_BASE_DELAY_MS` defaults to 1000 and `JOB_RETRY_BACKOFF_FACTOR` to 2 —
exponential backoff (`packages/jobs/src/retry.ts#backoffDelayMs`) from one second, doubling each attempt: 1s,
2s, 4s, 8s before whichever attempt is a job's last. This is the ordinary shape for a transient-failure retry
(a rate limit, a momentary network blip) without a real workload to tune against yet; each is its own
environment variable rather than folded into one "retry policy" constant, so a later phase that finds the
schedule too aggressive (or too gentle) for, say, a large roster import can raise it without touching code.

**Rework finding 4 — the bound on attempts is `job.maxAttempts`, not a policy field.** The row itself carries
its own bound (`repos/jobs.ts#NewJob.maxAttempts`, required per-enqueue, checked against `job.attempts` in
`runner.ts`), not a shared `RetryPolicy` default: `RetryPolicy` originally also carried a `maxAttempts` field,
alongside its own `JOB_MAX_ATTEMPTS` environment variable defaulting to 5, but `runner.ts` never actually read
either — the bound it enforced was always `job.maxAttempts` on the row. An operator raising `JOB_MAX_ATTEMPTS`
to give a large roster import more headroom would have changed nothing, silently. Both were deleted rather
than wired up as a default: nothing in this slice enqueues a job yet (`apps/worker`'s own module comment — the
registry is empty), so there was no real call site to default from, and `NewJob.maxAttempts`'s own comment
had already settled the bound as "required, not defaulted" per-enqueue policy, not something a shared default
should quietly override.

**Choice, on where admission sits relative to the allowance.** `JOB-4`'s admission gate is acquired in
`answerQuestion` *before* `usage.reserveUsageSlot`, not around `model.ask` alone. The alternative — reserve the
allowance, then wait behind admission — was rejected because `usage.ts` has no operation that gives an
already-reserved slot back: a request that reserved a day's allowance and then timed out waiting for an
admission slot would have spent that allowance on nothing, and the next answer that same person could actually
get would count as slot two, not slot one, for something they were never actually given. Waiting first costs
nothing when the wait itself is what fails (`declined-busy` reserves no slot, records no message, calls no
model — the same "costs nothing" shape `declined-over-limit` already has), which is the same principle CORE-3
already applies to the allowance check itself, carried one step earlier.

**What that ordering costs.** A course's daily limit is enforced by counting *admitted* requests, not
*arrived* ones — a request that is still queued behind admission has reserved nothing yet, so in principle more
distinct people could be mid-wait for a very busy course than its `maxRequestsPerDay` alone would suggest,
each waiting a turn rather than one holding a reservation while the rest are refused outright on arrival.
`JOB-4`'s own text — "requests wait for a slot rather than failing, up to a bound" — is exactly this trade,
made on purpose: a wait is not a failure, and nobody's allowance is spent on a wait that goes nowhere.

**Why the bound and the ceiling are both configuration.** `MODEL_ADMISSION_LIMIT` (default 5) and
`MODEL_ADMISSION_WAIT_MS` (default 15s) are `@bloombot/config` environment variables — `JOB-4`'s own text is
explicit ("The bound is configuration, not a constant compiled into a client"), and a droplet's real ceiling on
concurrent OpenAI calls is an operational fact (rate limits, the host's own capacity) nobody can know at the
time this code is written.

**Why `packages/core` itself never reads `CONFIG`, and where the real gate is actually built.** The first
version of this built the real, configured `AdmissionGate` lazily inside `answer.ts` on first use, the same
"nothing runs at import time, reading it is cheap forever after" shape `CONFIG` itself is built with (`PLAT-5`).
That broke on contact with the rest of the test suite: `CONFIG` validates the *whole* environment schema on any
property read, not only the one accessed, so every existing test that calls `answerQuestion` or `handleMention`
directly — every test in `packages/core`, `packages/discord`'s own suite, `packages/openai`'s integration test —
would have had to satisfy `PUBLIC_APP_URL` and everything else `CONFIG` requires just to answer a question
against a `FakeModelClient` with no concurrency at all. That is exactly the coupling `CORE-4`'s "dependencies as
arguments" rule exists to prevent, and it is a defect this build actually hit while wiring this in, not a
hypothetical. The fix: `deps.admission` defaults to `NO_ADMISSION_LIMIT`, a stateless gate that always grants
immediately and touches nothing — `packages/core` does not depend on `@bloombot/config` at all. The *real*
gate is built once, from `CONFIG`, by whichever process actually runs concurrent traffic — `apps/bot`'s own
`main()`, the same "read `CONFIG` once at startup" discipline it already uses for `model` — and handed down
through `@bloombot/discord`'s `HandleMentionDependencies.admission`. `packages/core` only has to expose the
seam (`AnswerDependencies.admission`, typed against `packages/jobs`'s `AdmissionGate`); it does not have to
decide when the seam is real.

**Why the gate's implementation lives in `packages/jobs`, not `packages/core`.** It has nothing to do with the
job queue mechanically — it is a plain counting semaphore, dependency-free — but it is part of the same
`JOB-1..5` requirement family and the same phase. Keeping it there rather than duplicating a semaphore inside
`packages/core` avoids a second implementation of the same small, easy-to-get-wrong (release-on-timeout,
FIFO-vs-not) piece of code; `packages/core` only imports its `AdmissionGate` *type*.

**Limits.** `apps/bot` is the only process wired to a real gate in this slice — `apps/api` answers nothing
today (`API-1..6` carries no answering path), and a future MCP process or `apps/api` route that does will need
its own `createAdmissionGate(...)` built at its own startup, the same way. Each process's gate is
process-local, in-memory state: the real ceiling on concurrent model calls *platform-wide* is the sum across
every process that answers, not `MODEL_ADMISSION_LIMIT` alone. Acceptable for the single-droplet, few-process
topology this platform runs today (`D-2`'s own "single-host" scope); revisit if answering ever runs from more
than one process concurrently, or if the ceiling needs to be enforced platform-wide rather than per process.

## D-30 — `packages/discord-rest`/`apps/worker`/`packages/db`/`packages/jobs`: server scaffolding is the queue's first real consumer, "never delete" is structural, and a job's result rides the row

**Problem.** `SRV-6..8` move `hydrate_server.py` behind an action and onto the job queue `D-29` built —
`apps/worker`'s own registry started this build with no real handler in it, so this is also the first proof
that a handler can actually be written against `runNextJob`'s contract (the claim, the lease, the handler
timeout) rather than only against a stand-in in `packages/jobs`'s own tests. Three things needed a choice the
brief did not settle on its own: how "never delete" is *enforced* rather than merely asked for, what happens
when a course and a guild disagree about a name, and what a Discord failure partway through a run means given
the lease and the handler timeout `D-29`'s rework already put in place.

**Choice, on "never delete."** `SRV-8` is enforced structurally, not by convention: `packages/discord-rest`'s
`DiscordRestClient` (`client.ts`) has no method that edits or deletes a category or channel at all — only
`listGuildChannels`, `listGuildRoles`, `createGuildCategory` and `createGuildChannel`. There is nothing for
`apps/worker/src/handlers/discord-scaffold.ts` to call even if it wanted to remove a category or channel no
course declares; `undeclaredCategories`/`undeclaredChannels` in its own `ScaffoldReport` name one, but the
handler is refused the means to act on that name beyond reporting it. Findings 2/3 of the rework: both are
diffed against every course _this organization_ declares (`loadOrganizationDeclaredNames`), not only the course
being scaffolded — a guild can host more than one of an organization's courses at once (one binding per
organization, `TEN-3`), so the first version of this diff reported every _other_ course's own categories and
channels as undeclared, which is exactly the "hand-delete a live course's channels" outcome `SRV-8` exists to
prevent. This is the same "refuse structurally, not by remembering a
rule" discipline `TEN-3`'s primary-key binding and `courses.ts`'s partial unique indexes already apply
elsewhere in this codebase — a reviewer can confirm `SRV-8` by reading one interface's method list rather than
auditing every call site that touches it. The test suite backs this twice: `DiscordRestClient`'s own missing
methods (a compile-time fact — nothing in `apps/worker` can even name a delete call) and, at the fake level,
`FakeDiscordGuildServer` (`apps/worker/tests/helpers/`) and `FakeDiscordServer`
(`packages/discord-rest/tests/helpers/`) implement no route that would honour one, so a test can assert zero
`DELETE`/`PATCH` requests reached the fake at all, not merely that the handler's own report looked right.

**Choice, on reporting a pre-existing category or channel's actual permissions, not the declared ones.**
Finding 4 of the SRV-6..8 rework: the same structural no-edit above means this handler never writes to an
`already_present` category or channel's overwrites — but the first version of this report copied
`adminsOnly`/the category's own privacy straight from what the course _declared_ regardless of status, so an
instructor who set `admins_only: true` on a channel students could already read was told `adminsOnly: true`
with nothing about it actually having changed. The fix is necessarily report-side, not a `PATCH` — this package
still has none — so `ScaffoldChannelReport.adminsOnly`/`ScaffoldCategoryReport.everyoneDenied` are read from
Discord's own response for `already_present` (`channelIsAdminsOnly`/`everyoneIsDenied`,
`apps/worker/src/handlers/discord-scaffold.ts`) rather than copied from the declaration, and
`establishedByThisRun: false` marks that this run did not set it. **What this means for an instructor:** if a
category or channel's actual permissions are wrong — public when a course declares it should not be, or vice
versa — this package has no way to correct it. Fixing a channel `already_present`'s permissions needs an edit
capability this package deliberately does not have (`SRV-8`'s own structural refusal, above, applies to a
permission write exactly as it does to a delete); the only remedy today is an administrator fixing the
overwrite directly in Discord. A future slice that wants scaffolding to _repair_ a wrong permission, not merely
report it, needs to reopen that refusal on purpose — this rework does not, since nothing in `SRV-6..8`'s own
text asks for it and it is exactly the kind of capability `SRV-8` exists to keep this package from having by
accident.

**Choice, on matching by name.** A course's categories and channels carry no Discord id of their own
(`schema.ts`'s `course_categories`/`course_channels` — nothing this platform writes back once created), so the
only way to ask "does this already exist" is by name — case- and whitespace-insensitive, the same
normalization `discord_manager.py`'s own `get_category_id`/`get_channel_id` already apply, carried over rather
than redesigned. **What happens when two categories share a name:** nothing distinguishes them to this match,
so the first one found in the guild's own channel list wins, and every later request for that name — a second
declared category with the same name, or the placeholder/channel-creation loop re-checking after a create —
is treated as "already present" against that same row, even where a stricter implementation might insist on a
one-to-one correspondence. This is a deliberate simplification, not an oversight: an instructor names a
course's own categories and has every reason not to reuse a name within one course (a duplicate is far more
likely a copy-paste mistake than an intentional two-category design), and `courses.save`
(`packages/actions/src/actions/courses.ts`) does not police category-name uniqueness within a course either —
scaffolding matching that same looseness one level down is consistent, not a new gap. Revisit if a real course
config is ever found relying on two identically-named categories meaning two different things.

**Choice, on a guild unreachable mid-run.** `createDiscordScaffoldHandler`'s own function does nothing special
for a Discord failure — a rate limit, a transport error, the guild becoming unreachable partway through a
run — beyond letting it propagate as a thrown error out of the handler. `JOB-2`'s ordinary retry/backoff (built
in the previous slice, `D-29`) takes it from there: the attempt fails, and — attempts remaining — is
rescheduled with backoff. What makes an _ordinary_ failure (the handler itself threw, and so stopped running)
safe to retry, rather than merely convenient, is the same by-name matching above: a retried attempt re-lists
the guild's channels and re-resolves roles from scratch, so whatever the failed attempt already created (say,
three of a course's five declared channels, before the fourth `POST` failed) is found "already present" on the
retry rather than recreated — `SRV-7`'s idempotence is exactly what makes a partial failure resumable without
special-casing resumption.

**Limit this does not cover — `JOB_HANDLER_TIMEOUT_MS` firing on a handler still running underneath it.**
Finding 5 of the SRV-6..8 rework: an earlier version of this section claimed the same by-name matching covers
`D-29`'s own open question about a fired handler timeout too — "the next attempt simply finds it already there
and moves on" — and that claim is stronger than `runHandlerWithTimeout` (`packages/jobs/src/runner.ts`) actually
supports. JavaScript has no way to cancel a `Promise` already in flight, so that function only stops _awaiting_
the handler; the handler itself keeps running. A scaffold call timed out mid-run does not stop creating
categories and channels the moment `runNextJob` gives up on it — it keeps going, against the same guild, for as
long as its own in-flight Discord calls take. If the next attempt (a retry, or a second worker reclaiming the
row once the lease lapses) starts before the abandoned one has actually finished, both are now creating the
same course's missing categories and channels concurrently: two `GET`s can both miss the same not-yet-created
row, and two `POST`s can both then succeed, since nothing here makes "check, then create" atomic against a
second caller doing the same thing at the same time. `SRV-7`'s idempotence check only ever guards against a
_sequential_ re-run finding something already there — it was never built to arbitrate between two calls racing
each other, and does not. This is a known, unclosed gap, not one this slice engineers around: closing it for
real would need either a lock this queue does not have (one job's claim does not stop a _different_ in-flight
call from touching the same guild) or an idempotency key Discord's own create endpoints do not accept. An
operator who raises `JOB_HANDLER_TIMEOUT_MS` well above how long a real scaffold run ever takes narrows the
window this matters in; it does not close it.

**Choice, on where a handler's report lives.** `SRV-6..8`'s brief asks for "a way to see the outcome," which
needs the report to outlive the handler call that produced it — `apps/worker`'s own process, and the
in-memory `ScaffoldReport` it returns, are both gone by the time a caller asks. Rather than a new table, `jobs`
(`packages/db/src/schema.ts`) gained one nullable column, `result`, the same "opaque JSON, not this table's to
interpret" treatment `payload` already gets (that column's own comment). `repos/jobs.ts#completeJob` grew an
optional `result` argument that serializes it in the same write that flips the row to `succeeded` — one
transaction, not a second write after, so there is no window where a job is `succeeded` with no report yet.
`packages/jobs`'s `JobHandler` type changed from `Promise<void>` to `Promise<unknown>` to carry this: a
handler that still returns nothing leaves `result` `null`, exactly as before, so this is additive for every
existing handler shape, not a breaking one. `@bloombot/actions`' `jobs.get` read action is the far end of that
pipe — a generic read over any job, not one written specifically for scaffolding, since the same "how do I
find out what happened" question applies to every future job-backed action (`ROST-*`'s roster import,
`KNOW-*`'s knowledge-file attachment) exactly the way it applies to this one.

**Limits.** `getActiveDiscordServerBindingForOrganization` (`repos/discord-servers.ts`) resolves a job's
`courseId`-only payload to a guild by assuming an organization holds exactly one active Discord server
binding — true of every organization this build creates today, but not a constraint `discord_server_bindings`
itself enforces (an organization *can* hold more than one active binding; `TEN-3` only says a server belongs to
at most one organization, not the reverse). Two active bindings resolve to `undefined`, refusing the whole
scaffold job the same way "no binding at all" does, rather than guessing which guild a course belongs to. If a
real deployment ever needs one organization teaching across multiple Discord servers, a course will need its
own explicit server reference — this slice does not add one, since nothing in `SRV-6..8`'s own text calls for
it and speculative schema is exactly what `CLAUDE.md`'s "do not add abstraction for a future the brief did not
describe" warns against.

## D-31 — `packages/schemas`/`packages/discord-rest`/`apps/worker`/`packages/actions`: roster import, a roster-known-but-unseen person, and how the batching picks a category on a re-run

`ROST-9..12` — an instructor uploads a roster CSV, `apps/worker`'s new `roster.import` handler
(`handlers/roster-import.ts`) creates or corroborates a person per row and a private Discord channel per
student, batched around Discord's per-category cap, and reports what it could not do. This entry is the
roster-side counterpart to `D-30`'s scaffolding one: several of the same shapes (a job handler closing over a
`DiscordRestClient` and a bot token, name-based idempotence, "never delete," a report riding the job's own
`result` column) are reused rather than reinvented, and are not re-argued here — see `D-30` for those. What
follows is what is genuinely new to this slice.

**Scope, on the CSV this parses.** `roster_create_channels.py` reads the _merged_ five-column CSV
(`results/PREFIX-result.csv`) `roster_setup.ipynb` writes by joining the registrar's own roster with an intake
questionnaire on email address — `Last`, `First`, `Email`, `GitHub`, `Discord`. `packages/schemas`'
`parseRosterCsv` mirrors that same merged shape, not the registrar's raw, pre-join roster: this slice's own
brief names "the legacy import" out of scope, and that join is exactly what `packages/legacy-import` (a later
phase) owns. An instructor using this action today uploads a roster already carrying a `Discord` column,
exactly what `roster_create_channels.py` itself expects.

**Choice, on a roster as text, not a file reference.** `roster.import`'s own action input carries the CSV's
raw text (`csvText`) directly in the job's opaque `payload`, rather than a reference to a file stored
elsewhere. A roster is, in practice, a small text file — the same "nothing here needs a streaming parser"
reasoning that kept `parseRosterCsv` a hand-rolled RFC 4180 splitter rather than an added dependency (see
`packages/schemas/src/roster.ts`'s own module comment: `packages/schemas`' `package.json` is explicit that it
"depends on zod alone so it can be bundled into the browser," and a CSV library would break that). A
file-reference design would need a blob-storage table and a lifecycle (pending/ready/failed, a provider
upload) this slice's own brief does not ask for — that is `FILE-1..3`'s own, larger feature, over knowledge
files, not a roster CSV. Nothing about `roster.import`'s shape forecloses a future upload path that hands the
browser a pre-signed URL and enqueues the same job with `csvText` read from wherever it landed.

**Choice, on how a roster-known-but-unseen person is represented (`ROST-10`).** A row's `Discord` handle is
first resolved against the bound guild's own member list (`DiscordRestClient#listGuildMembers`, this slice's
addition to that port — see below) the same way `discord_manager.py`'s `get_user_id` resolves one today:
username or display name, case-insensitively, ignoring anything after a `#`. Two outcomes:

- **The handle resolves to a real guild member.** The member's own snowflake is the identity this row is kept
  under (`resolvePersonByIdentity(organizationId, { surface: 'discord', externalId: member.id }, db)`) — the
  same identity a live message from that same Discord account would resolve to later (`PPL-3`). A student who
  has already joined the server by the time the roster is imported is therefore genuinely recognized the
  moment they first message the bot: the roster import and the bot's own message-time resolution agree on the
  same row.
- **The handle does not resolve.** This is the _common_ case at import time, not a rare failure — `ROST-3`'s
  own workflow is channels created ahead of a student's arrival, before they have necessarily joined the
  Discord server yet, or self-reported a handle without a typo. The row is still kept (`ROST-10`'s own text:
  "kept, so the person is recognized when they first appear"), under a synthetic identity keyed by the
  handle itself: `surface: 'discord'`, `externalId: 'handle:' + normalizedHandle`. This is what lets a
  re-import of the same roster (or a second course sharing a student) recognize the same person and merge
  onto it rather than creating a duplicate every run.

**What this does not do, and why that is out of this slice's scope.** A `handle:`-keyed person is never
reconciled with the snowflake-keyed identity `PPL-3` creates once that same student actually messages the
bot for the first time — the two remain two different `person_identities` rows (and, if nothing else ever
merges them, two different people) unless a later roster import happens to resolve the same handle to a real
member and — even then, only that _one_ row is upgraded; nothing walks back and merges the earlier
`handle:`-keyed person into the snowflake-keyed one PPL-3 may have separately created in between. Closing that
gap for real means teaching message-time resolution (`packages/core`/`apps/bot`) to also try a roster-handle
fallback when a snowflake identity is not yet known, or a background reconciliation pass — neither is named
in this slice's own brief, and `PPL-2`'s own convention that `externalId` is a surface's native id (a
snowflake, not a self-reported string) is knowingly bent by the `handle:` prefix to make "kept" mean something
today rather than nothing. This is recorded here as a known limitation, not a hidden one.

**Which merge rule this handler uses, and why (`PPL-4`).** Every row's name, email and GitHub handle are
written with `mergeRosterFields` — never `overwriteRosterFields` — the same choice `D-13`'s own rename
comment anticipates: a roster is an instructor's assertion about a third party, corroboration rather than
authority, so it fills a gap (`null`) and never overwrites a value a surface (a Discord profile, an earlier
roster) already proved. A field merged in wrong once by a bad roster row stays wrong through every later
`mergeRosterFields`-only re-import of a corrected roster — the same limitation `people.ts`'s own
`overwriteRosterFields` doc comment already names as the reason that escape hatch exists at all. This
handler deliberately does not use it: nothing in `ROST-9..12`'s own text asks for a roster to be able to
correct a name a surface already set, and giving an ordinary import that power by default is a bigger,
un-asked-for change to what "roster" means on this platform.

**How the batching picks a category, and how a re-run picks the same one (`ROST-11`).** `course_categories`
carries no "this is a student category" flag — `CFG-4`'s own convention is purely a naming one ("several
numbered `… - STUDENTS NN` categories"), so this handler discovers a course's student categories the same
way an instructor reading the config would: any declared category whose name ends in the word "students"
followed by a number (`studentCategoryNumber`, case- and separator-insensitive), sorted ascending by that
number. Each must already exist as a real category in the bound guild — created by an earlier
`discordServers.scaffold` run, the previous slice's own job — before this handler will place a channel in it;
this handler never creates a category of its own (see "what this does not carry over," below). A student
category's current channel count, read fresh from the guild (including every channel this same run has
already created), decided against `categoryChannelCap` (configurable; defaults to Discord's real 50), is what
"full" means: the first category with room takes the next row, in file order, exactly `ROST-4`'s own
row-range batching but automatic rather than an instructor manually pointing separate runs at separate
categories. **On a re-run:** nothing about which category a given student's channel already lives in is
recorded anywhere but the guild itself — a channel is matched, across every discovered student category, by
its slugged name (`normalizeChannelName`, the same transform `discord-scaffold.ts` applies for the same
Discord-side-slugging reason) before this handler creates anything, so a student already placed in category
02 on an earlier run is found there again and reported `channelsAlreadyPresent`, never moved or duplicated
into category 01 just because 01 now has room (a student who left mid-term freeing a slot, say). The
category a student lands in is decided once, at first creation, and never revisited.

**Addition to `packages/discord-rest`, and why it could not be avoided.** `DiscordRestClient` had no way to
resolve a Discord handle to a guild member at all — `ROST-10`'s identity resolution and `ROST-5`'s per-student
permission grant both need one. `listGuildMembers` (`GET /guilds/{id}/members`, paginated the same way
`getUserGuilds`/`getBotGuilds` already are) is this slice's one addition to that port: read-only, the same
shape `listGuildChannels`/`listGuildRoles` already are, and it does not reopen `SRV-8`'s structural "never
edit or delete" — nothing about a member's own roles or nickname is written by this call or any caller of it.
`channel-overwrites.ts` also gained `allowMemberOverwrite` (`type: 1`, a member, rather than `allowRoleOverwrite`'s
`type: 0`, a role) — a plain data constructor, not a REST verb, needed because `ROST-5`'s own private channel
grants exactly one student by their member id, the one case in this platform where an overwrite is not
role-scoped. Both were considered and rejected as unnecessary: an approach that skipped member resolution
entirely (granting only the admins role, always) would silently fail `ROST-5`'s own requirement that the
individual student be able to read their own channel.

**What this deliberately does not carry over from `roster_create_channels.py`.** Two behaviors named in
`ROST-5`/`ROST-6` are not carried over, and both are because `DiscordRestClient` has — deliberately, per
`SRV-8` and this file's own `D-30` — no verb for them, and this slice does not add one:

- **The pinned welcome message (`ROST-6`).** `discord_manager.py`'s own client sends a message into a newly
  created channel and pins it; `DiscordRestClient` has no method that sends or pins a channel message at all
  (SRV-6..8 never needed one, and `ROST-9..12`'s own brief says explicitly: "report that rather than adding
  one silently"). This handler creates the channel and stops there. A future slice that wants the welcome
  message needs to add `postMessage`/`pinMessage` to the port deliberately, the same way `listGuildMembers`
  was added here — not something this slice does silently on the side.
- **"Re-runs update permissions on existing channels" (`ROST-6`'s own last sentence).** An already-present
  channel's permissions are never rewritten by a re-run, the same `SRV-8` "no edit verb, structurally" this
  package already holds `discord-scaffold.ts` to (that file's own module comment). A student whose Discord
  handle did not resolve on the first import and later joins the server does _not_ have their channel's
  permissions repaired by importing the same roster again — only a genuinely new channel is ever written to.
  Fixing a channel's permissions after the fact needs the same edit capability `D-30`'s own "what a wrong
  observed value means for an instructor" section already declines to add, for the same reason.

  **Superseded below** — a first review round found this refusal cost ROST-3's own primary workflow (channels
  created ahead of arrival, then nobody's access ever repaired once they showed up); see "Decide and record —
  the narrow permission-overwrite write (rework finding 5)" below for the narrowly-scoped exception this
  rework adds instead.

**Update — a rework pass on `ROST-9..12`: the parser, a narrow permission-overwrite write, and the identity
gap this entry originally only named.** Two reviewers went over this slice after it first shipped, one exercising the parser and the REST client
directly. Thirteen findings came back; what follows is the substance — the parser's own robustness, the one
narrowly-scoped write added to `packages/discord-rest`, and the identity-model gap this entry's own
"what this does not do" section above already named but left open. The remaining findings (report gaps,
missing coverage) are smaller and are not each re-argued here; they are traceable in the diff and the test
files by the same "rework finding N" comment this section and the code both use.

**Update (rework findings 1-3) — the CSV scanner's own bugs, not this package's original design.**
`parseCsvRows` (`packages/schemas/src/roster.ts`) had three defects a hand-rolled RFC 4180 splitter is
exactly the kind of code that hides them in: a `"` toggled quoted mode wherever it appeared, not only at a
field's own start, so a typo like `O"Brien` put the scanner into quoted mode with no real closing quote
anywhere in the rest of the file — three valid rows collapsed to zero rows and one uninformative error, with
two students lost and nothing naming them (finding 1); Excel's own "CSV UTF-8" export — the default a
registrar's file goes through — writes a leading byte-order mark, so the first header silently became a
`First` with an invisible byte-order-mark character glued to its front, and a file that plainly contained
`First` was reported as missing it (finding 2); and a reported line number was the _record's own index_, not
its _physical line_, so a row with a legally embedded
newline (RFC 4180 permits one inside a quoted field) threw off every line number reported after it (finding
3). All three are now fixed at the scanner itself (`findClosingQuote`'s own lookahead, a `field.length === 0`
check before a `"` is ever treated as opening a field, a leading BOM stripped before scanning, and
`physicalLine` tracked as newlines are actually consumed) — see that file's own module and function comments
for the mechanics. None of the three needed `packages/schemas` to stop being "zod alone" (PLAT-2); this was a
correctness gap in the hand-rolled parser, not a reason to reach for a dependency.

**Decide and record — the narrow permission-overwrite write (rework finding 5).** Every channel this handler
creates is built _before_ the student who owns it has necessarily joined the server (`ROST-3`'s own workflow
is channels ahead of arrival), so `resolveMember` returns nothing for essentially the whole roster at import
time, and — per the refusal this entry originally recorded above — a re-import after the student joins
matched the channel by name, filed it under `channelsAlreadyPresent`, and `continue`d _before any overwrite
was built at all_. The student's own channel stayed admin-only forever; no re-run of anything would ever fix
it. `roster_create_channels.py:219-229` (the tool this replaces) calls `channel.edit(overwrites=...)` on both
its "create" and "already exists" branches for exactly this reason — that is how a late-joining student got
access in the tool this platform is replacing.

Two ways to close this were weighed:

- **Refuse ROST-5 outright** — leave every channel admin-only until the _next_ roster import happens to
  re-create... nothing, since the channel already exists, so in practice this means ROST-5 (`the individual
  student can read their own channel`) is simply never delivered for the — likely majority — of students who
  join _after_ their channel is created. `docs/DECISIONS.md`'s own report would have to say so per student,
  every run, forever. This was rejected: `ROST-3`'s whole premise (channels ahead of arrival) makes "student
  joins after their channel exists" the _common_ case, not an edge one, so refusing ROST-5 here means refusing
  it for most of a course's own roster.
- **A narrowly-scoped permission-overwrite write** — `packages/discord-rest` gains exactly one new method,
  `DiscordRestClient#grantChannelMemberAccess(botToken, channelId, memberId)`, a `PUT
  /channels/{id}/permissions/{memberId}` (Discord's own "Edit Channel Permissions" call) that sets one
  target's own `allow`/`deny` bits and nothing else about the channel — no `name`, no `parentId`, no route to
  rename, move, archive or delete anything. This was chosen.

**Why the narrow write does not reopen `SRV-8`.** `SRV-8`'s own guarantee, as `client.ts`'s module comment and
`D-30` both state it, is structural: _a category or channel this client creates cannot later be renamed or
deleted through it_. That guarantee is about a channel's own **shape and existence** — it says nothing about
_who can read_ a channel already granted to admins, because nothing before this rework needed to change that
without also being able to change the channel itself. `grantChannelMemberAccess` cannot rename, move, archive
or delete a channel or category — there is no field in its own request body for any of those, and no other
method reachable from it that could. It is the read-side twin of `overwriteAllowsView`/`overwriteDeniesView`
(`channel-overwrites.ts`, finding 4 of the `SRV-6..8` rework) turned into the one narrow write those
finding-4 read helpers were always going to need a counterpart to eventually: a channel's _privacy_ was
already something this package could observe without editing the channel; now it is also something this
package can _repair_ for one member, without editing the channel either. `roster-import.ts`'s own use of it is
itself narrow: only for a channel `alreadyPresent` (never one this run just created, where the grant is
already baked into the create call), and only when `memberAlreadyGranted` says the resolved member does not
already have it — an idempotent write attempted only when there is something to repair, not on every re-run
regardless. The extended "no mutating verb" test (`apps/worker/tests/handlers/roster-import.test.ts`, the
`rework finding 5` describe block) asserts, the same structural way `discord-scaffold.test.ts` already does
for `DELETE`/`PATCH`, that no `DELETE` or `PATCH` ever reaches the fake and that the one `PUT` this handler
does send matches exactly the narrow `/channels/{id}/permissions/{id}` path — never a general channel edit.

**Decide and record — the identity-model gap (`ROST-10`/`PPL-3`).** This entry's own "what this does not do"
section above named the gap precisely: a `handle:`-keyed person a roster import creates before a student
joins is never reconciled with the snowflake-keyed identity `PPL-3` creates once that student's first live
message actually arrives — the two stayed two different `person_identities` rows (and, absent anything else
merging them, two different people), with the roster's own fields sitting on the now-orphaned `handle:`-keyed
one and the report saying `peopleCreated` twice for what was genuinely one student.

Two ways to close it were on the table, matching this rework's own brief: reconcile on the message path (look
for a `handle:` identity matching the author's own username/display name before creating a person, and
either re-point it at the snowflake or resolve to it directly), or refuse to create the `handle:`-keyed person
at all and report the roster row as deferred until the student is seen live. **Reconciliation on the message
path was chosen** — `packages/discord`'s `handle-mention.ts` is the one file this change touches (`packages/core`
needed no change at all: `answerQuestion` already takes a resolved `personId` as input, and nothing about
_how_ that id was resolved belongs in the answering pipeline). Refusing to create the `handle:`-keyed person
was rejected outright: it is `D-31`'s own "kept, so the person is recognized when they first appear" (`ROST-10`'s
own text) undone — a roster row that resolves to nobody at import time would simply vanish from every report
this handler produces, with no way for an instructor to tell "the roster imported cleanly" from "half the
class silently was not kept."

**What "reconcile" means here, concretely, and what it deliberately still does not do.** Before resolving (or
creating) a person by the message's own snowflake identity, `handleMention` now checks — only when the
snowflake itself does not yet resolve to anyone — for a `handle:`-keyed identity matching the message's own
`authorDisplayName`, normalized the same way `roster-import.ts`'s own `normalizeHandle` normalizes a roster
row's handle (`normalizeRosterHandle`, duplicated rather than shared, the same convention this file already
holds itself to for `normalizeName`/`normalizeChannelName` between `discord-scaffold.ts` and
`roster-import.ts`). A match resolves the message to that same person — same conversation, same daily
allowance, the roster's own fields intact — instead of `resolvePersonByIdentity` minting a second one under
the snowflake. This is deliberately **resolution, not a physical re-point**: the `handle:`-keyed
`person_identities` row itself is left exactly as it was; nothing in `packages/db`'s own `people.ts` gained a
new write for this rework, and `packages/db` is not in this rework's own touched-files list at all. The
trade-off this accepts: every _subsequent_ message from that same student still repeats the same
handle-fallback lookup (the snowflake identity is never created either, since creating a _second_ identity
row for one person the way this package's own repo functions are shaped today is its own, larger change this
rework's brief did not ask for) — a small, repeated read, not a correctness gap, as long as the student's own
`authorDisplayName` keeps normalizing the same way. If a student's own nickname changes _before_ their first
message (matching the roster's own handle) but _after_ it (breaking the match on a later one), a later message
would fail to find the `handle:` row and — since the snowflake still resolves nothing by then either, unless
an earlier message already created it — mint a person the ordinary way; this is a narrower version of the
same gap this entry's own "what this does not do" section already accepted for the original ROST-10 fallback,
not a new one this rework introduces. `handle-mention.test.ts`'s own `D-31 rework` describe block proves both
the reconciliation and its own boundary: a `handle:` identity that does not match the author's own display
name still creates a new person, rather than this fallback ever guessing.

---

## D-32 — `packages/db`/`packages/openai`/`apps/worker`/`packages/actions`: where a course attachment's bytes live, how a vector store gets created, and what a failure costs

`FILE-1..5` — an instructor attaches a course's notes, syllabus and schedule in the panel, and those files
ground that course's answers, replacing a vector store id typed in from a vendor dashboard. This entry
records four judgment calls the brief left open: where the bytes actually live and what protects them, how a
course's vector store is created and what happens to a hand-typed id, what a failed attachment costs, and
whether restoring an instruction revision is a new revision or a pointer move.

**Where the bytes live, and what protects them (FILE-5).** `packages/db`'s new `attachment-storage.ts`
exports `createFilesystemAttachmentStorage`, a small filesystem-backed store rooted at
`CONFIG.ATTACHMENT_STORAGE_DIR` (default `./data/attachments`, gitignored the same way `data/*.db` already
is). The layout is `<root>/<organizationId>/<attachmentId>/content` — both path segments are
application-generated UUIDs (`crypto.randomUUID()`, the same convention every other id in this platform
already follows), and the on-disk filename is always the literal `content`, never the instructor's own
filename (kept only as a display column, `course_attachments.filename`). This is what makes a filename like
`../../etc/passwd` inert by construction: nothing about what a browser upload calls a file ever reaches a
path. `safeSegment` is a charset check, not a UUID check — it refuses any segment holding `/`, `\`, `.` or
anything else outside `[A-Za-z0-9_-]`, which is enough to reject a path-shaped id, but it does not require the
segment to actually look like a UUID (a rework finding: this entry, and `attachment-storage.ts`'s own module
comment, used to claim `safeSegment` "refuses a non-UUID-shaped segment" — it does not, and this slice's own
worker tests pass non-UUID ids like `att-1` and `placeholder` through it deliberately). Every resolved path is
also re-checked to fall inside the storage root before use — belt and braces against a future caller that
reaches this module with something other than a value it generated itself. That second check is, honestly,
unreachable in ordinary operation rather than proven by any test: `safeSegment`'s own charset admits no `.`,
`/` or `\` at all, so `join(rootDir, segment, segment)` can never actually produce a path outside `rootDir`
once both segments have already passed `safeSegment` — an earlier version of this entry claimed a test proved
the containment check alone stops an escape "by neutering the primary guard"; no such test exists, `safeSegment`
is not exported for a test to bypass without reaching into the module's own internals, and writing one was not
worth the reach for a defense this implementation does not expect to trip. Reachability
is TEN-2's own answer, not a new mechanism: an attachment's bytes are found only by an id read off a
`course_attachments` row, and that row is only ever reached through the organization-scoped repo functions
(`repos/course-attachments.ts`) every other record already goes through.

**Why bytes are written by the action, not carried in the job payload.** `roster.import` (`D-31`) carries a
roster's raw CSV text directly in its job's own `payload` — a deliberate choice, reasoned out in that
requirement's own module comment, because a roster is small text and nothing about it needs a blob-storage
table. A course attachment is the opposite case: unbounded binary content, and `jobs.payload`/`jobs.result`
are never deleted (`JOB-2`'s "stays visible... rather than disappearing" is permanent, not just until the row
succeeds) — leaving raw file bytes sitting base64-encoded in that table forever is exactly what `FILE-5`
exists to prevent. `courseAttachments.attach`'s own action therefore decodes the uploaded bytes and writes
them to `AttachmentStorage` itself, before it ever enqueues anything; the job it enqueues carries only the
attachment's own id. Writing to the local filesystem is not the network call `JOB-1` exists to defer, so doing
it inline in the action costs nothing `JOB-1`'s own reasoning protects.

**How a course's vector store is created, and what happens to a hand-typed id.** `courses.vectorStoreId`
(`D-3`'s own escape hatch) is the single field `packages/openai`'s `client.ts` already reads to decide whether
a request is grounded (`MDL-3`) — this slice changes nothing about that read path. What changes is how the
column gets filled in: `apps/worker`'s `courseAttachments.attach` handler reuses the course's own
`vectorStoreId` when it already has one — hand-typed from a vendor dashboard, or set by an earlier attachment,
indistinguishable to this handler and treated identically — and only calls `createVectorStore` when the
column is still null. Crucially, the freshly created id is **not** written to `courses.vectorStoreId` until
the file that justified creating it has actually attached successfully (`repos/courses.ts#setCourseVectorStoreIdIfUnset`,
called only after `attachFileToVectorStore` reports `completed`) — this is what keeps `FILE-2`'s promise: a
course must never look configured while its answers are ungrounded. A course whose first-ever attachment
fails is left with `vectorStoreId` still `null`, exactly as if no attachment had ever been tried, even though a
vector store may already exist, empty, on the provider's side. An existing course with a hand-typed id keeps
working unchanged in every respect: the column is read the same way it always was, and `setCourseVectorStoreIdIfUnset`'s
own `WHERE vector_store_id IS NULL` clause means a hand-typed value is never overwritten by anything this
slice adds.

**What a failed attachment costs.** A `client_error` from the provider (a malformed request, an unsupported
file the provider actively refuses, or a hand-typed `vectorStoreId` that no longer resolves) is caught and
recorded on the row — `markAttachmentFailed`, carrying the provider's own message — and the job itself
*succeeds* with a report saying so, rather than being retried: retrying a call the provider has already
refused for a permanent reason spends nothing but time and confuses `FILE-2`'s own "visible lifecycle" with an
internal retry loop nobody asked to see. A rework finding widened this from "only the upload is guarded" to
all three provider calls the handler makes (upload, create-vector-store, attach-to-vector-store) — the original
guarded only the first, so a non-retryable rejection from either of the other two propagated uncaught and left
the row `pending` with no reason, exactly the state `FILE-2` exists to prevent.

A *transient* failure (a timeout, a rate limit, a 5xx) still propagates on every attempt but the last, for
`JOB-2`'s ordinary retry/backoff, the same division every other handler in this app holds itself to — but a
second rework finding closes the gap that division used to leave open: on this job's own *last* attempt
(`JobContext.maxAttempts`, widened onto `@bloombot/jobs`' own context for exactly this), the handler also calls
`markAttachmentFailed` before re-throwing, so the row reaches the same terminal `failed` state the job row
itself is about to reach, rather than staying `pending` forever once `JOB-2` gives up with no way to tell
"still working" from "dead." `courseAttachments.list` needs no separate job id for a caller to notice this —
the reason lands directly on the row the panel already reads.

**The bytes themselves are kept on disk either way** — a `failed` attachment's own `AttachmentStorage` entry is
never cleaned up automatically. This slice adds no `courseAttachments.retry` action (not named in its own
brief), so today the only way to clear a failed attachment's bytes is `courseAttachments.detach`, which
removes both the row and the bytes together; a future retry action could reuse the bytes already on disk
without asking the browser to upload them again. A third rework finding closed a real leak in that same
detach path: `providerFileId` used to stay `null` on a `failed` attachment whenever the rejection came from
creating or attaching to the vector store (steps 3-4) rather than the upload itself (step 2) — `detach`'s own
`if (attachment.providerFileId)` guard then had nothing to reach, and the successfully uploaded file stayed on
the provider permanently. `repos/course-attachments.ts#recordProviderFileId` now writes the id the instant the
upload succeeds, before either later call runs, so `detach` can always reach a file the upload actually
produced regardless of what happened afterward. Detaching a `failed` (or an abandoned, see below) attachment
also needed `deleteVectorStoreFile`/`deleteFile` to tolerate a `404` as "already gone" rather than an uncaught
`client_error` (a fourth rework finding, load-bearing for ordinary retried detaches too — the first delete of a
retried detach can succeed while the second times out, and the retry then 404s on the one that already landed)
— without it, a detach on a file whose vector-store attach never actually completed could throw on the first
delete and never reach the second, or the local removal.

The cost of a retryable failure that keeps failing transiently is less contained on one remaining axis, an
accepted limitation this rework pass did not close: each full handler retry re-uploads the bytes and, if the
course still has no `vectorStoreId`, creates another empty vector store on the provider — nothing local tracks
or cleans up an earlier attempt's now-orphaned *vector store* (as opposed to the uploaded *file*, which the
third rework finding above now always leaves reachable). Closing it needs the handler to persist an
in-progress `vectorStoreId` somewhere between attempts (on the attachment row itself, most likely) so a retry
can resume rather than restart a fresh vector store each time, which is a larger change than this brief asked
for. Revisit if a flaky provider connection makes orphaned vector stores material.

**A concurrent detach racing an in-flight attach (a rework finding).** `markAttachmentReady` returns
`undefined`, not a row, when the attachment id it was given no longer resolves in this organization (TEN-5's
usual contract) — the original attach handler dropped that return value entirely, so a `courseAttachments.detach`
that completed while this handler's own provider calls were still in flight was silently overwritten: the
handler would still call `setCourseVectorStoreIdIfUnset`, and its own report would still claim `status: 'ready'`
for a file nothing local records any more. The handler now checks the return, skips
`setCourseVectorStoreIdIfUnset` entirely when it is `undefined`, and reports a third status, `'abandoned'`,
naming what happened rather than a false `'ready'`. This is a narrow, honestly-reported race, not a guarantee
that no attach and detach can ever interleave: the uploaded file itself is left on the provider in this case
(the same accepted cost D-32's own "what a failed attachment costs" section above already describes for a
retryable failure's orphaned vector store), since nothing local records an attachment id to reach it through
any more.

**After detaching a course's last attachment, `courses.vectorStoreId` stays set.** `courseAttachments.detach`
removes the attachment row and its bytes, and reaches the provider to remove the file from the vector store and
delete the file object itself — but it never touches `courses.vectorStoreId`, even when that was the course's
only attachment. The column keeps pointing at a vector store that is now empty on the provider's side, so the
course still reads as "configured" even though nothing currently grounds it. Clearing the column automatically
would be wrong for a hand-typed id (`D-3`'s escape hatch): an instructor who typed in a `vectorStoreId` from a
vendor dashboard and later detached every file this platform itself uploaded should not have that hand-typed
value silently erased out from under them — this handler has no way to tell "the id I created" from "the id an
instructor typed in" once it is sitting in `courses.vectorStoreId`, the same indistinguishability `courses.ts`'s
own module comment already accepts for the read path (`MDL-3`). Leaving it set is therefore the defensible
choice, not an oversight, but it was previously undocumented; recorded here so a future reader does not mistake
an empty-but-still-set vector store for a bug.

**Whether restoring a revision is a new revision or a pointer move.** A new revision, always — `FILE-4`'s own
text ("what the assistant was told last week and restore it") and `course_instruction_revisions`'s own module
comment in `schema.ts` are both explicit that a revision is never updated or deleted. `courseInstructions.restore`
copies the chosen revision's text into `courses.instructions` (`setCourseInstructions`) and inserts a *new*
row recording the restore, authored by whoever performed it — not by the original author, an honest record of
who actually chose to bring the text back, and never merely a `currentRevisionId` pointer moved backward. The
practical consequence, proven in `packages/actions/tests/course-instructions.test.ts`: restoring the first of
three saved revisions produces a fourth, and the second and third are still there, unrewritten — an instructor
can restore an even older revision afterward without anything about the intervening history having been lost.
A real tiebreaker was needed for "newest first": `createdAt` is millisecond precision and two saves can land in
the same tick, so `course_instruction_revisions` gained its own `sequence` column, computed the same
read-max-then-insert-in-one-transaction way `messages.sequence` already is (`repos/conversations.ts#appendMessage`'s
own comment) — the bug this closes was caught by `packages/db/tests/course-instruction-revisions.test.ts` itself
failing, non-deterministically by insertion order, before `sequence` existed.

**Who authored a save or a restore (FILE-4), and the one shared-plumbing change this needed.** Neither action
had anywhere to get an author from: `packages/actions`' `DispatchContext`/`ExecuteContext` carried an
organization id and never an account id (`discordServers.ts`'s own module comment states this as a deliberate
prior limit — installing a server needed the caller's own account for a different reason and was routed around
`packages/actions` entirely rather than widen this shape). `FILE-4`'s own "an author and a time" cannot be
satisfied by asking the caller's own input to name one — that is a self-reported, forgeable audit trail, the
same reasoning `apps/api`'s `routes/actions.ts` already gives for never trusting a caller-supplied
`organizationId` out of a request body. `DispatchContext` and `ExecuteContext` therefore both gained one new,
optional field, `accountId`, and `apps/api`'s own action route threads `req.session.accountId` through it —
the account `sessionMiddleware` already proved, never read from the body. Optional, not required: every other
action in this package has no reason to know who is calling (`organizationId` alone already decides what it
may reach), and making this mandatory would have forced every existing test and caller to supply a value it
never uses. `courseInstructions.save`/`.restore` are the only two actions that read it today, and both refuse
outright (`ActionRefusedError`) when `dispatch` was not given one — reachable only by calling `dispatch`
directly with no `accountId`, since `routes/actions.ts` always supplies the authenticated caller's own.

**Why `createPlatformRegistry` gained an options argument, and why its default does not read `CONFIG`.**
`courseAttachments.attach` is the first action in this package whose `execute` needs something beyond
`organizationId`/`db` — the same `AttachmentStorage` this entry's own first section describes — so it is built
by a factory (`createAttachCourseAttachmentAction(attachmentStorage)`) rather than exported as a plain object
the way every other action in this package is. `createPlatformRegistry` gained one new, optional parameter,
`attachmentStorageDir`, to construct that storage and pass it in. The obvious default — fall through to
`AttachmentStorage`'s own `CONFIG.ATTACHMENT_STORAGE_DIR` default — was tried first and rejected: it broke
`packages/actions`' own tests (`catalog.test.ts`, `access-audit.test.ts`), which run in an environment that does
not set every variable `@bloombot/config`'s schema requires (`PUBLIC_APP_URL`, notably) — this package has
never depended on `@bloombot/config` at all, the same "dependencies as arguments, only the process reads
`CONFIG`" discipline `D-15` already holds `packages/core` to, and a zero-arg call reaching `CONFIG` at all
would fail those tests for a reason with nothing to do with what they test. `createPlatformRegistry`'s own
default is a literal string instead — never touching `CONFIG`. A real deployment is unaffected:
`apps/api/src/index.ts` reads `CONFIG.ATTACHMENT_STORAGE_DIR` once, at startup, the same as every other
`CONFIG` value it reads there, and threads it explicitly through `buildApp`/`server.ts` to
`createPlatformRegistry`.

That literal used to be `'./data/attachments'`, matching `ATTACHMENT_STORAGE_DIR`'s own schema default — a
rework finding changed it to `'./tmp/attachments'` instead. A real deployment never reaches this fallback at
all (the paragraph above), so which literal it is only matters to a caller that supplied nothing, and that was
never meant to be more than a test: `apps/api`'s own test helper (`build-test-app.ts`) and the e2e harness's
`start-api.ts` both used to omit `attachmentStorageDir` entirely, which silently wrote real course material
into `data/`, the same directory `data/*.db` is protected on this repository for holding real students' names,
emails and conversations. Both now thread their own `tmp/`-rooted path explicitly, the same "lives under
`tmp/`, never `data/`" discipline QA-2/QA-3 already hold every other test database to — but the fallback itself
was fixed too, not only its two known callers, since a silent default that happens to land in a protected
directory is a hazard for the next caller that forgets, not only the two this rework pass found.

**FILE-1's own request-size ceiling, and why it lives on one route, not globally.** `courseAttachments.attach`'s
payload carries a file's bytes as base64 in this entry's own JSON body (the section above on why bytes, not a
reference) — but `apps/api` never gave that route its own body-size limit, so it inherited `express.json()`'s
ordinary 100 kB default from `server.ts`'s global middleware. Base64 encoding inflates a file's raw size by
4/3, so 100 kB of JSON body is roughly a 74 kB *raw file* ceiling — well under a real syllabus, notes file or
schedule (`FILE-1`'s own text names all three), so an ordinary multi-page PDF was rejected `413` before this
action ever ran, a rework finding. `routes/actions.ts` now exports two constants recording the chosen bound
explicitly: `MAX_COURSE_ATTACHMENT_BYTES` (20 MiB) is the ceiling on a raw file's own size — generous for a
course's own notes, syllabus and schedule, including a scanned PDF, without inviting an instructor to treat
this as general file storage; `ACTION_JSON_BODY_LIMIT_BYTES` (28 MiB) is the JSON body limit that ceiling
actually requires once base64's 4/3 inflation and the payload's other fields (`courseId`, `filename`,
`contentType`) are accounted for. The raised limit is scoped to the `/organizations/:organizationId/actions`
path prefix alone — `server.ts` mounts a second `express.json({ limit: ACTION_JSON_BODY_LIMIT_BYTES })` ahead
of its own general-purpose one, and body-parser's own "already parsed" guard makes the second a no-op for that
one prefix — rather than raising the global default, since every other action's own input is small and a
100 kB-scale body is still the right ceiling for all of them; only this one route carries binary content at
all.

## D-33 — `packages/db`/`packages/config`/`packages/core`/`packages/openai`/`packages/actions`/`apps/bot`: where pricing rates live, what a cap refusal costs, how the cap interacts with the daily allowance, and what the administrator read does not expose

**Problem.** `COST-1..6` need every model call priced and attributed, a per-organization cap enforced before the
model is asked, an estimate that is never confused with a measurement, and two reads — an instructor's own
courses and a platform administrator's usage per organization — neither of which may leak a conversation.
None of the five is free of an ordering or a scope question the SPEC text states as a conclusion
("enforced before the call," "never presented as a measurement," "sees tenants, not conversations") without
settling how.

**Choice, integer micros and where the ledger sits.** `cost_ledger_entries` (`packages/db/src/schema.ts`) is one
row per model call — `organizationId`, `courseId`, `personId` all `.notNull()` with a foreign key each, so
`COST-2`'s "a call that cannot be attributed is a defect, not a row with a null" is structural, not a
convention `repos/cost-ledger.ts#recordCostLedgerEntry` merely tries to honor: nothing can construct a row
missing any of the three, the same "let the database refuse it" device `discord_server_bindings` already uses
for `TEN-3`. `recordCostLedgerEntry` additionally checks that `courseId`/`personId` actually belong to
`organizationId` before inserting — the same TEN-2/TEN-5 refusal `usage.ts#reserveUsageSlot` already gives a
foreign id — so a caller cannot forge attribution by naming a real row from the wrong tenant either.
`inputTokens`/`outputTokens` are nullable, deliberately: `0` would read as "this call used zero tokens," a
fact, when what actually happened is "nobody knows" — `null` is what `COST-6`'s "never presented as a
measurement" means for the token counts themselves, not only for `measurement`'s own column.

**Choice, where rates live, and what happens to an unpriced model.** Rates are `@bloombot/config`'s own
`MODEL_PRICING_JSON` (`env.ts`/`pricing.ts`) — a JSON object of `{ rates: { "<model>": { input…, output… } },
defaultRate: { … } }`, in integer micros per **million** tokens (per-token would round every real call to zero
under integer arithmetic before `costMicros` is even computed). `pricing.ts#getModelPricingTable` parses and
validates it with its own zod schema, defaulting to a documented, approximate rate for `gpt-4o`/`gpt-4o-mini`
(publicly listed as of this writing) when the variable is unset or blank — the same "documents a real value,
needs nothing set for production to get something real" shape `OPENAI_BASE_URL` already takes. A model with no
entry in `rates` is priced against `defaultRate` instead of `0` — `COST-6`'s own text, "must not silently cost
zero" — and flagged `measurement: 'estimated'` (`packages/core/src/pricing.ts#computeCost`), since the number is
a documented guess at what this model probably costs, not what the provider actually billed this specific model
at. A call whose provider reported no usage at all (`@bloombot/openai`'s own `extractUsage`, MDL-5, returning
`undefined` rather than inventing zeros) is priced against a character-based token estimate of the request and
answer text instead (finding 2 of this rework, below), `measurement: 'estimated'` — the same flag an unpriced
model already gets, two different reasons closed by the same `computeCost` branch rather than two separate
un-flagged shortcuts a future change could diverge on.

**Finding 2 of this rework — an unmetered call used to cost `0`, and the cap silently stopped counting it.**
The first version of this slice recorded `costMicros: 0`, `inputTokens`/`outputTokens: null` for a call the
provider reported no usage for — reasoned, at the time, as "there is nothing to multiply." That reasoning
missed what the cap actually does with the number: `hasReachedSpendingCap` sums `cost_micros` with no
exception for how a row got its value, so an organization whose provider kept returning no usage (a proxy that
strips it, a model that never reports it) kept being answered indefinitely — the cap, a safety control, was
being silently defeated by the one case it exists to catch a runaway bill from. Two fixes were considered:
estimate a real number, or make the cap treat an unmetered call as something other than free. This slice takes
the first: `packages/core/src/pricing.ts#computeCost` now estimates both token counts from the request and
answer text's own length — `ESTIMATED_CHARACTERS_PER_TOKEN = 4`, OpenAI's own documented rule of thumb for
English text — and prices that estimate exactly the way a measured call is priced, through the same arithmetic,
flagged `measurement: 'estimated'` rather than `'measured'`. `inputTokens`/`outputTokens` hold that estimate
too, not `null` — `null` was chosen when there was truly nothing to report; there is something now, and hiding
a nonzero `costMicros` behind a `null` token count would be its own kind of misleading. The type stays
`number | null` (`repos/cost-ledger.ts#NewCostLedgerEntry`) for a caller with genuinely nothing to estimate
from, not because this path still produces one. The other half of the same finding: neither COST-4 read used
to carry the `measurement` flag at all, so an instructor or a platform administrator could not tell a total
made partly (or entirely) of estimates apart from one that was fully measured — the exact thing COST-6's own
text says an estimate must never do. `getOrganizationUsageSummary` and `listOrganizationTotals`
(`repos/cost-ledger.ts`) now both report `estimatedCostMicros` alongside `costMicros`/`totalCostMicros` — the
portion of the total that came from an `'estimated'` row, summed in the same query rather than a second pass.

**Finding 3 of this rework — a missing pricing table prices every call at zero, and nothing said so.**
`AnswerDependencies.pricing` is optional, defaulting to `NO_PRICING_CONFIGURED` — an empty `rates` table and a
`0`/`0` `defaultRate` — when a caller omits it. Only `apps/bot` calls `answerQuestion` today, and it always
wires the real table, so this default is unreached in production; but `answer.ts`'s own module comment already
names the web chat and MCP surfaces as future callers, and `@bloombot/discord`'s own `HandleMentionDependencies.
pricing` is optional too, so a surface that simply forgets to wire it would silently price every call at zero
and disable that organization's own cap for every call it makes — indistinguishable, from the ledger alone,
from a healthy, well-priced surface that genuinely costs nothing. Requiring `pricing` outright was considered
and rejected for this slice: it would touch every existing caller of `answerQuestion`/`handleMention` (over
seventy call sites across `packages/core`'s and `packages/discord`'s own test suites alone) to satisfy a
signature change for a gap no caller has hit yet. Instead, `answer.ts` now logs a `warn` every time
`NO_PRICING_CONFIGURED` is actually reached — cheap, and it means a surface running unconfigured shows up in
its own logs immediately rather than waiting for a cap that will never fire to be noticed at all.
`NO_PRICING_CONFIGURED`'s own `defaultRate` stays `0`/`0` on purpose, not a guessed nonzero number: the point of
this seam is to be caught, not quietly papered over with a value that would look like a real estimate.

**Why `packages/core` restates `ModelRate`/`PricingTable` instead of importing `@bloombot/config`'s own types.**
`D-29` already settled this for `AdmissionGate`: `packages/core` depends on `@bloombot/config` not at all, even
for a type-only import, because `@bloombot/config`'s `CONFIG` proxy validates the *whole* environment schema on
any property access, and every existing caller of `answerQuestion` would otherwise have to satisfy it just to
answer a question with a `FakeModelClient`. `packages/core/src/pricing.ts`'s own `ModelRate`/`PricingTable` are
structurally identical to `@bloombot/config`'s, restated rather than imported, and `AnswerDependencies.pricing`
defaults to `NO_PRICING_CONFIGURED` (an empty rate table, `answer.ts`'s own module comment) when a caller omits
it — the same "expose the seam, do not decide when it is real" shape `NO_ADMISSION_LIMIT` already takes.
`apps/bot`'s own `main()` builds the real table once, from `CONFIG.MODEL_PRICING_JSON`, via
`@bloombot/config`'s `getModelPricingTable`, and hands it down — the one place in the platform allowed to
bridge the two shapes, the same role it already plays for `admission`.

**Why `ModelAnswer` gained a required `model` field.** `answer.ts` has `course.model`, but that is `null`
whenever a course leaves it unconfigured (`D-3`) — the *adapter* decides what a `null` falls back to
(`@bloombot/openai`'s own `DEFAULT_MODEL`), and `answer.ts` must not guess at that fallback itself just to
price (or attribute) the call. `ModelAnswer.model` (`ports.ts`) is the adapter's own report of what it actually
ran against, read back the same way `ModelAnswer.upstreamThreadId` already reports what actually happened
rather than what was asked for.

**Choice, where the cap check sits, and why.** `COST-3`'s own text points straight at `D-29`: the cap is
checked in `answerQuestion`, after admission is granted but before `usage.reserveUsageSlot` — not merely before
`model.ask`. The reasoning is the same shape `D-29` already gives admission-before-allowance: `usage.ts` has no
operation that gives an already-reserved daily slot back, so a cap check placed *after* the reservation would
mean an organization refused for being over its cap still spent one of that student's daily requests on the
refusal. Checking the cap *after* admission (rather than before) follows the same logic one step earlier: a
request still queued behind admission has spent nothing yet — `D-29`'s own "waiting costs nothing" — so there
is nothing for a cap check to usefully run against until admission itself is settled. Unlike admission and the
allowance, the cap check itself (`costLedger.hasReachedSpendingCap`) is a plain read, not a reservation: an
organization's spend is a `sum()` over rows already written, so there is nothing to "give back" on an early
exit, because nothing was ever held in the first place. `declined-over-cap` is its own `AnswerResult`/
`HandleMentionResult` variant, not folded into `declined-over-limit` or `declined-busy` — a caller (an
instructor reading logs, a future dashboard) can tell "this organization needs its cap raised" apart from
"this course's own daily allowance is exhausted" or "the process is momentarily busy," the same distinction
the three existing decline kinds already draw from each other.

**What a cap refusal costs the caller.** Nothing, by construction: `declined-over-cap` is returned before
`usage.reserveUsageSlot` runs (no daily slot spent), before a conversation is opened or a message recorded (no
write at all), and before `model.ask` is ever called (no ledger row, because nothing happened to record) — the
same "costs nothing" shape `declined-over-limit`/`declined-busy` already have, proven the same way
(`answer.test.ts`'s own COST-3 suite asserts the fake model recorded zero calls and the ledger did not grow).
The cap is cumulative, not a daily allowance the way `usage_counters` is — `getOrganizationSpentMicros` sums
every ledger row an organization has ever recorded, with no reset. There is no billing period in this slice
(the brief's own "a ledger and a cap, not an invoice"): an operator who wants a monthly cap has to raise it (or
clear it) themselves; nothing in this platform resets it on a calendar boundary.

**What the platform administrator read deliberately does not expose.** `costLedger.listOrganizationTotals`
(`repos/cost-ledger.ts`) reads only `cost_ledger_entries.organization_id`/`cost_micros` and
`organizations.name` — there is no column in its own result for a course, a person, a model or a message to
leak through even by accident, `ADMIN-4`'s "sees tenants, not conversations" held one slice earlier than the
console that requirement actually describes. It is not wired through `dispatch.ts`, on purpose: `DispatchContext.
organizationId` names the one organization a caller is acting within, and an administrator's own read spans
every organization by definition — the same class of exception `repos/jobs.ts#countQueuedJobs` already is for
`JOB-5`'s own platform-wide "how deep is the queue" read, and `TEN-2`'s own convention test now allowlists it
by name. Authorizing the *caller* as a platform administrator (`@bloombot/auth`'s `isPlatformAdministrator`,
`AUTH-4`) is left to whichever surface calls this — the admin console itself is `ADMIN-4`'s own phase, out of
scope here — the same way every other use of that check already defers to its caller rather than checking
itself.

**Choice, on `COST-5`'s monitoring read.** `checkPlatformHealth` (`packages/actions/src/monitoring.ts`) is a
plain function for the same reason `listOrganizationTotals` is: it has no organization to scope a `dispatch`
call to at all. It aggregates the three processes' *existing* loopback health endpoints (`apps/bot`,
`apps/worker`, `apps/api`) rather than reaching into their in-memory state directly — reachable, on purpose:
processes do not share memory, and this is the one channel any of them will ever have to another's live state.
`apps/bot`'s own health endpoint (`apps/bot/src/health.ts`) gained a second field, `model` — the running
call/error count of `@bloombot/core`'s new `createCountingModelClient`, wrapped once around the real model
client in `main()` — since the provider's error rate has to be observed by the one process that actually calls
it; nothing changes about what `worker`/`api` already report (`queueDepth`, `database`), since `COST-5` names
both by name as already sufficient. A process that cannot be reached at all (connection refused, or the fixed
timeout `checkPlatformHealth` applies per process, default 2s) is reported `{ reachable: false }`, never merged
with — or defaulted from — a healthy shape: `COST-5`'s own text, "reports a process it cannot reach as
unreachable rather than healthy," is a distinct outcome from a real `503`, which is still `reachable: true`
with whatever body that process returned.

**Limits.** The spending cap is a single, cumulative, per-organization number with no reset and no action
layer to set it from — `organizations.ts#setSpendingCap` exists for a test (and a future admin action) to call,
but nothing in this slice wires a way to configure it outside direct database access, matching the brief's own
"do not build a billing integration." `checkPlatformHealth`'s three URLs are supplied by its caller, not read
from `CONFIG` itself — the same "packages/core/packages/actions never read CONFIG" discipline `D-29` already
holds `packages/core` to, extended here to `packages/actions`, so whichever surface eventually calls this
(an admin console route, `ADMIN-4`'s own phase) is the one place that has to know the three ports are
`CONFIG.BOT_HEALTH_PORT`/`WORKER_HEALTH_PORT`/`API_PORT` on `127.0.0.1`.

The cap check itself (`hasReachedSpendingCap`) is a plain read against the sum of rows already written, not a
reservation — stated above, and worth stating the bound this actually produces explicitly: an organization can
be overshot by up to `JOB-4`'s own admission limit (`MODEL_ADMISSION_LIMIT`, default 5). Every request already
admitted checks the cap before it was exceeded, then proceeds to call the model and write its own ledger row —
so up to that many concurrent requests can each pass the same "not yet over" read before any of their own
writes lands, and the organization's true spend settles somewhat above its configured cap once all of them
finish. Bounded, not unbounded — the same trade `D-29` already accepts for the daily allowance's own admission
ordering — but explicit here because nothing before this paragraph said the bound had a size.

`organizations.ts#setSpendingCap` is repo-only, wired to no `Action` and no route: an organization that reaches
its own cap answers nothing further until somebody edits `spending_cap_micros` by hand against the database —
a real operational trap for whichever operator hits it first, not merely a missing feature. No phase in
`docs/ROADMAP.md` yet owns wiring an action for it; `ADMIN-4`'s own admin console phase is the natural owner,
the same phase already named above as the one that must authorize `listOrganizationTotals`'s own caller.
Likewise, `listOrganizationTotals` and `checkPlatformHealth` are both plain functions outside `dispatch.ts`
(this file's own paragraphs above have why), which means they sit outside `ACT-5`'s own audit log and
`TEN-5`'s own access matrix entirely — harmless while nothing calls them, but the surface that eventually wires
either one (again, `ADMIN-4`'s own phase) must add its own administrator check and its own audit trail rather
than assuming either already exists, the same way `dispatch.ts` would have given it for free.

---

## D-34 — `packages/db`/`packages/actions`/`apps/worker`: enrolment is a stored relation, where the Discord-role path is evaluated, `active` versus deletion, what archiving does to an enrolment, and what routing should pick up next

**Problem.** ENRL-1..6 needed a `courses`↔`people` relation neither `routing.ts` (which decides a Discord
message's course per-message, from category or role) nor anything else in the schema recorded. Three separate
things create it — a redeemed join link, holding a course's Discord student role, an imported roster row — and
ENRL-5 needed staff roles (`memberships`) to stop being grantable by nothing at all.

**Choice — `enrolments`, and three admission functions, not one with a `source` parameter.**
`packages/db/src/repos/enrolments.ts` exports `enrolViaJoinLink`, `enrolViaDiscordRole` and `enrolViaRoster`,
each hard-coding its own `source` literal, funnelling through a module-private `admit`. There is no exported
function that takes an arbitrary `source` — ENRL-3's "a person never enrols themselves out of nothing" is true
of what this file lets a caller *express*, not merely a convention documented beside a more general function.
`active` is not a separate boolean column: it is `endedAt is null`, the same nullable-timestamp shape
`discordServerBindings.removedAt`/`projects.archivedAt` already use for TEN-6/PROJ-2 — ending an enrolment
(ENRL-6) never deletes the row, and "ended" carries *when*, which a bare boolean would have thrown away.

**Choice — the Discord-role path is evaluated in `packages/db`, not `packages/core`'s `routing.ts`.**
`enrolViaDiscordRole(organizationId, { courseId, personId, roleNames }, db)` is a pure string-membership check
against the course's own `studentsRole` (never `adminsRole` — ENRL-5's "a Discord role confers none of them"
means even the admin role a person holds has no bearing on enrolment) against role names its caller already
resolved; it makes no Discord call of its own. It was not added to `routing.ts` for two reasons. First, this
slice's brief is explicit that Discord's own routing behaviour does not change here — `routeMessage` still
matches a message to a course by category or role, exactly as before, and nothing calls `enrolViaDiscordRole`
from the live message path yet. Second, `routing.ts`'s own job is "which course does this message belong to",
a per-message question; "is this person enrolled" is a per-admission question that only needs to run once,
not on every message — folding it into `routeMessage` would have made every message re-derive a fact that a
stored enrolment already answers cheaper than a role-name comparison plus a database round trip repeated per
message. Keeping the check in the repo layer, next to the write it gates, means the whole discord_role
admission path (matching and writing) is one function a future caller supplies already-known role names to.

**What the linking slice should change in routing.** Today a Discord message still answers on category-or-role
match alone (`routing.ts`), which is exactly the gap ENRL-1's own SPEC text names: "on Discord the category
decides the course... every surface consults the same relation" is not true yet for Discord itself. The
natural change, left to that slice with the full picture rather than guessed at here: once a message resolves
to a person and a candidate course (via `routeMessage`, unchanged), call `enrolViaDiscordRole` (or, if the
person already holds an active enrolment via `getActiveEnrolment`, skip the write) before answering — turning
"holds the role, so route it" into "holds the role, so admit them once, then route through the stored
enrolment," which is what makes a role holder's *second* message just as auditable as their first. This slice
deliberately does not make that change, per its own brief.

**What archiving a project, or disabling a course, does to an enrolment: nothing.** `enrolments` carries no
trigger, and neither `archiveProject` nor `disableCourse` touches this table — an enrolment an instructor
recorded outlives a term the same way a conversation or a transcript does (ENRL-6's own reasoning, and TEN-6's
before it). A disabled or archived course already routes nothing (CORE-2, PROJ-2), so an enrolment against one
is inert rather than dangerous; re-enabling or unarchiving makes it live again with the enrolment already
intact, which is the behaviour a returning course should have.

**Choice — a join link's redemption is a plain function, not a dispatched `Action`.** `dispatch.ts`'s own
`DispatchContext.organizationId` has to be known before a single line of an action runs; a redeemer presents
only the secret from the link they were given, which is *how* the organization becomes known, not something
provable in advance. `@bloombot/auth`'s `consumeSignInToken` is the same shape for the same reason (AUTH-1): a
plain function composed by whichever surface calls it, never a dispatched action. `createCourseJoinLinkAction`
and `revokeCourseJoinLinkAction` are ordinary dispatched actions — both already know their organization, an
instructor issuing or revoking a link they administer.

**Choice — ENRL-5's grant is recorded on the row, not a separate audit table.** `memberships` gained two
nullable columns, `grantedByAccountId`/`grantedAt`, written only by the new `grantMembershipRole` (called by
`memberships.grant`, the one action in the platform that changes a role). The founding-owner membership
`accounts.createAccount` writes inline at sign-up records no grantor — there is nobody to have granted it — the
same "nullable means not applicable, not merely unset" reasoning `courses.promptId`/`maxRequestsPerDay` already
use. `memberships.grant`'s own `execute` (not its policy, which only sees `organizationId`/`db`, never the
caller's account id) checks that the caller holds `'owner'` in the organization being acted on and refuses a
caller granting a role to their own account — "never self-selected" is enforced procedurally here, the same
place `courseInstructions.save`'s `requireAccountId` already enforces "every revision has a real author",
because nothing in `packages/actions`' policy shape today can express "and not to themselves" declaratively.

**Rework finding 1 — `memberships.grant` was a cross-tenant account-existence oracle.** `execute`'s "does
`email` resolve to a real account" check ran through `accounts.getAccountByEmail`, organization-independent by
design (TEN-2's own documented exception) — with no membership check alongside it, an owner of *any*
organization (and sign-in is open to anybody, who becomes owner of their own personal organization on first
sign-up — TEN-1) could call `memberships.grant` against their own organization with an arbitrary email and read
the account/not-found refusal as an oracle over the whole platform's account table, and a success would enrol a
real stranger's account into an organization they never consented to join. `execute` now also requires
`memberships.getMembership(organizationId, target.id, db)` to already find a row before it will change that
account's role — see `actions/memberships.ts`'s own doc comment. This narrows what `memberships.grant` does:
it changes an existing member's role, and no longer doubles as an ad hoc way to add a first-time member by
email — ENRL-5 asks for no invitation flow, and none is added here; a first membership for a new instructor or
TA stays `memberships.createMembership`'s own concern, uncalled by anything in this slice.

**Rework finding 2 — `admit` did not check `courseId`/`personId` belong to `organizationId`.**
`repos/course-join-links.ts#redeemJoinLink` already checked its own `personId` against the link's organization,
but the module-private `admit` (`repos/enrolments.ts`) — the one place every `enrolVia*` actually writes a row —
did not, so `enrolViaRoster`/`enrolViaJoinLink`, called directly (as `apps/worker`'s roster handler and a future
join-link-redemption wiring both do), could write a cross-tenant enrolment that read back as real once
committed. `admit` now resolves both through `courses.getCourse`/`people.getPerson` before writing anything,
refusing (`undefined`) exactly as every other repo function in this package refuses a foreign id.

**Rework finding 3 — a roster re-import silently undid ENRL-6.** `admit` looked only for an *active* row before
deciding whether to write a new one; a person who held an *ended* enrolment for a course had no active row, so
a re-import (`enrolViaRoster`) inserted a brand-new active one — an instructor who ends a student's enrolment
and later re-imports the same, unedited roster (routine hygiene, not a correction) would find that student
quietly back. `admit` gained a `reviveEnded` parameter, and each `enrolVia*` now states its own choice
explicitly rather than sharing one implicit default: `enrolViaRoster` passes `false` (a re-import is not a
deliberate re-admission decision), `enrolViaJoinLink` and `enrolViaDiscordRole` pass `true` (redeeming a link,
or continuing to hold a Discord role, *is* one). See `repos/enrolments.ts`'s own doc comments on `admit` and
each `enrolVia*` for the reasoning in full.

**Rework finding 4 — `callerAssertedPersonId` is not proof of identity, and now says so loudly.**
`redeemJoinLink`'s (and `redeemCourseJoinLink`'s) `personId` parameter used to read like any other
organization-scoped id this package proves belongs to a tenant. It is that, and only that — nothing about
presenting a join link's *secret* proves who is presenting it, since a join link is deliberately shareable with
an entire class (ENRL-3). Both parameters are renamed `callerAssertedPersonId`, and their doc comments now spell
out the obligation this leaves an eventual `POST /join { secret, personId }` wiring: binding it to the caller's
own already-authenticated identity is that future caller's job, not something either function can check from
the two arguments it is given.

**Rework finding 5 — `redeemCourseJoinLink` was unreachable from any app.** It was exported from
`packages/actions/src/actions/index.ts` but not this package's own root `src/index.ts`, and `package.json`'s
`exports` field exposes only the `.` entry — so no app could import it at all, deep or otherwise. It is not a
dispatched `Action` (this section's own earlier "Choice" paragraph), so it has no other door in the way every
other action here does through `createPlatformRegistry`; it is now re-exported from the package root.

**Rework finding 6 — redemption was three statements, not one transaction.** `redeemJoinLink` read the link,
looked up the person, and (through `enrolViaJoinLink`) wrote the enrolment as three separate statements. A
`courseJoinLinks.revoke` committing between the first read and the enrolment write could still let that
in-flight redemption admit somebody — `revoke` reporting success would not yet be true for a redeemer already
past the first check. The whole function now runs inside one `db.transaction(...)`, the same "narrow the race
in the same transaction as the write, don't just document it" discipline `courses.ts#createCourse` already
holds its PROJ-3 check to — a link is multi-use, so the single conditional-`UPDATE` device
`consumeSignInToken`/`claimDiscordServerBinding` use for a single-use secret is not available here.
`repos/enrolments.ts#getActiveEnrolment`/`#admit`/`#enrolViaJoinLink` and `repos/people.ts#getPerson` all widened
their `db` parameter from `Database` to `Executor` to make this possible — see `client.ts`'s own `Executor`
doc comment for what that type already exists for.

**Rework finding 7 — `expiresAt` accepted a past timestamp.** `courseJoinLinks.create`'s input schema now
refuses an `expiresAt` at or before the moment of the call (`z.number().refine(...)`) — before this, a caller
could create a link that reported success and could never be redeemed.

**Limits.** `enrolViaDiscordRole` is unreachable from any live surface in this slice — nothing calls it yet,
by design (previous paragraph). `grantMembershipRole`'s two new columns record only the *most recent* grant,
not a full history the way `course_instruction_revisions` keeps one per save — sufficient for ENRL-5's "the
grant is recorded with who did it," insufficient if a later requirement needs "every role this account has
ever held and who changed it." `courseJoinLinks`' secret is generated and hashed with a small, deliberately
duplicated copy of `@bloombot/auth`'s `secrets.ts` (SHA-256 over a CSPRNG, no salt) rather than a new
cross-package dependency — see `packages/actions/src/actions/course-join-links.ts`'s own module comment for
why duplication was chosen over depending on `@bloombot/auth` for ten lines. `redeemCourseJoinLink`/`redeemJoinLink`
are still unwired from any live surface (rework finding 4's own "nothing calls it yet") — the next slice that
adds a `POST /join` route (web) or a Discord-side redemption is the one that has to bind
`callerAssertedPersonId` to a real, already-authenticated identity; neither function can do that itself from a
secret and a bare id.

---

## D-35 — `packages/db`/`packages/auth`/`packages/core`/`packages/discord`: what a merge does with two conversations on one course, what it does with usage and cost, whether it can be undone, and what changed in routing

**Problem.** LINK-1..5/PPL-4/5 build the mechanism D-28 already designed: an unattributed identity is invited,
not answered (LINK-1/LINK-2); a Discord or MCP identity is proven, not asserted (LINK-3, PPL-4); proving a
second identity that already belongs to someone merges the two (LINK-4); and, once merged, one allowance and
one conversation follow the person across every surface (LINK-5).

**Choice — `connectedAt`, not identity count, is LINK-1's own gate.** `people.connectedAt` (nullable) is set
exactly once, by `mergePeople`, the moment a *proof* first attaches a second identity onto a person — never by
`resolvePersonByIdentity` (PPL-3's own first-sight creation) and never by a roster import
(`mergeRosterFields`/`overwriteRosterFields`, neither of which touches it). `answerQuestion`
(`packages/core/src/answer.ts`) declines with `not-connected` before admission, the spending cap or the
allowance are ever touched whenever `connectedAt` is `null` — LINK-1's own "no model call, no allowance spent"
is true by construction, not by a caller remembering to check first, because the gate sits in the one pipeline
every surface already calls (CORE-1's own "one pipeline every surface calls" is what carries LINK-1 to Discord
today and to the web chat and MCP surfaces automatically once they call `answerQuestion` too).

**Cost, stated plainly, the same way D-28 already does.** Every brand-new person's *first* message, on any
surface — not merely a second surface — now gets the invitation instead of an answer, because `resolvePersonByIdentity`
never sets `connectedAt`. This is D-28's own trade, not a new one introduced here: "the alternative — answer on
the first surface, require connecting only for a second — leaves a window where a person has an unattributed
allowance ... that is D-4's evasion, reintroduced." The whole existing Discord regression suite exercises this
directly: `packages/discord/tests/helpers/seed.ts#seedBoundServerWithCourse` now connects a person under the
default `authorId` before most tests run (a real, if throwaway, merge — not a raw column write), and the
handful of tests that specifically exercise identity *creation* (SURF-4, the D-31 rework) opt out
(`connectDefaultAuthor: false`) since they assert on `people.listPeople`'s own count, not on whether the
message was answered.

**Choice — what a merge does with two conversations on the same course.** `conversations` has two partial
unique indexes (`schema.ts`, CONV-1) that a plain "reassign the loser's conversation to the survivor" would
violate the moment both people already have one for the same `(course, surface-scope)` — this is the "unique
constraints you will hit" case the brief names directly. `mergePeople` (`packages/db/src/repos/people.ts`)
resolves it by *combining* the two transcripts into the survivor's own conversation row: every message from
both, interleaved back into the order they actually happened (`mergeMessagesByCreatedAt`, a stable merge on
`createdAt` — both inputs are already each internally ordered by their own `sequence`, CONV-2's own ordering
column), re-sequenced 0..N-1, and re-pointed at the survivor's conversation and person id. Nothing is dropped —
CONV-2's "no delete path for a message" holds through a merge exactly as it does everywhere else. The loser's
own conversation row is left in place, now empty, rather than reassigned (which would recreate the exact
collision this branch avoids) or deleted (nothing in this package deletes a conversation row, and `mergePeople`
does not start). `upstreamThreadId` keeps the survivor's own value when it already has one — never overwritten
by the loser's, so a live model-thread resumption is never silently swapped for a different one mid-merge.

**Choice — what a merge does with the day's usage.** LINK-4's own text is explicit that this is a requirement,
not a suggestion: "the day's usage is combined rather than restarted." `mergePeople` adds the loser's own count,
for every `(course, day)` it has one, onto the survivor's row for the same pair (creating one if the survivor
had none) — the same `ON CONFLICT DO UPDATE ... count + excluded` shape `usage.ts#incrementUsage` already uses,
just summing an arbitrary amount rather than incrementing by one. The loser's own row is left exactly as it
was: harmless history nothing reads through the loser's id again, since every identity that used to resolve to
the loser now resolves to the survivor. Tested directly (`packages/db/tests/people-merge.test.ts`) against the
brief's own suspicion — the combined count is asserted to be the *sum*, not the larger of the two and not a
reset.

**Choice — enrolments follow the same "one active row wins, nothing is silently dropped" shape.** An *ended*
enrolment moves to the survivor outright (no unique constraint to collide with). An *active* one moves only if
the survivor holds no active enrolment for that course already; when it does, the loser's row is *ended*
instead of moved — `enrolments_org_course_person_active_unique` permits at most one active row per
`(organization, course, person)`, and the survivor's own enrolment (whichever one it already had) is what the
merged person keeps. The loser's now-ended row stays as the historical record of how they were originally
admitted, the same "ended, not deleted" discipline ENRL-6 already holds every other enrolment row to.

**Choice — cost ledger entries are deliberately left alone.** `cost_ledger_entries` rows are not reassigned to
the survivor during a merge, unlike identities, conversations, enrolments and usage. They are a historical
attribution of what was actually spent, by which id, at the time the call was made — not a live balance a
merge needs to keep correct the way a daily allowance is (nothing reads `cost_ledger_entries` by `personId`
to decide whether to answer the *next* request; `hasReachedSpendingCap`/`listOrganizationTotals` are both
organization-wide sums, indifferent to which person a row names). Reassigning them would rewrite history
("this person spent this" becomes false the moment it is reassigned) for no read that needs it to be true. If
a future requirement needs "how much has this merged person's *whole* history cost, across every id they were
ever known by," that reader can already resolve it by following `mergedIntoPersonId` back through
`people`, the same chain COST-4's own instructor-facing read would have to walk regardless of how the ledger
rows are attributed.

**Choice — a merge is not undone by anything in this slice.** `mergedIntoPersonId`/`mergedAt` record *that* a
merge happened and which person survived it, but there is no `unmergePeople` and no code path that ever clears
either column. D-28's own "Limits" paragraph named this as one of the two questions deliberately left open —
"whether a merge is ever reversible" — and nothing in LINK-1..5's own text requires an answer here: undoing a
merge would mean re-splitting interleaved messages back into two conversations, reversing a usage sum with no
record of which half came from which side once further requests have landed on top of it, and deciding which
of two now-identical-looking enrolment histories to revive — none of which this slice's brief asks for, and
guessing at the shape now would be inventing a requirement the way D-28 already warned against.

**Choice — what changed in routing for Discord (D-34's own unfinished business, closed here).**
`packages/discord/src/handle-mention.ts` now calls `enrolments.enrolViaDiscordRole` once a message resolves to
a matched course, before `answerQuestion` runs — exactly the change D-34's own "what the linking slice should
change in routing" named: "holds the role, so route it" becomes "holds the role, so admit them once, then
route through the stored enrolment." Concretely, for Discord: a role holder's *first* message used to route and
answer with no `enrolments` row behind it at all; every message now leaves one behind (idempotently —
`enrolViaDiscordRole`'s own no-op when an active enrolment already exists, or when the author does not hold the
course's `studentsRole`, makes this safe to call on every matched message, not only the first). `routeMessage`'s
own category-or-role match, unchanged, is still the only thing that decides which *course* a message belongs
to; a person routed by category alone, holding no relevant role, still gets an enrolment write attempt that
quietly does nothing (`enrolViaDiscordRole` returns `undefined`, caught and logged, never surfaced to the
student). **What this slice's own first pass got wrong, and the rework below fixes**: it left ENRL-6 hollow for
a role holder specifically — an instructor's `enrolments.end` was silently undone by that same student's very
next `@bloombot`, because `enrolViaDiscordRole` was written (D-34, the previous slice) `reviveEnded: true`, and
this slice is what actually calls it from a live message path for the first time. See "Rework, finding 5"
below for the fix — `reviveEnded: false`, and `handleMention` now refuses to answer (not merely to leave an
audit row) when a student who holds the course's `studentsRole` has an enrolment an instructor ended.

**Limits.** The web chat and MCP surfaces get LINK-1's own gate for free (`answerQuestion` is the one place it
lives), but neither surface exists yet to call `beginDiscordPersonLink`/`issueMcpPersonLinkToken`/
`completeDiscordPersonLink`/`completeMcpPersonLink` (`packages/auth/src/person-link.ts`) — this slice's own
brief is explicit that it "provides the token mechanism, not the server." The actual Discord OAuth token
exchange (`code` → an access token → `/users/@me`'s own snowflake) is not built here either, the same way
`discord-install.ts` leaves Discord's own REST calls to `@bloombot/discord-rest` and `apps/api`'s own routes —
whichever slice wires the web panel's connect screens is the one that completes that round trip and calls
`completeDiscordPersonLink` with the snowflake it got back, and is also the one that establishes
`callerPersonId`/`survivorPersonId` from a real, already-authenticated session (see "Rework, finding 3" below —
this package trusts its caller for that the same way `dispatch.ts`'s own `accountId` already does).
`people.ts#hasVerifiedAddress` (PPL-5) has no caller yet either — there is no transcript-read or export action
in this platform today (`ADMIN-1..5`, not yet built) — it exists ahead of its own caller so that phase does not
have to invent the check when it lands.

---

### Rework — two independent reviewers, converging on the same account-takeover and four more

A rework pass on this slice found the connect flow itself unsafe to ship, plus four smaller defects. Each is
its own finding below, in the reviewers' own numbering; each has a regression test that fails without its fix
(`packages/auth/tests/person-link.test.ts`, `packages/db/tests/people-merge.test.ts`,
`packages/discord/tests/handle-mention.test.ts`).

**Rework, finding 1 — a successful proof of a never-before-seen identity never set `connectedAt`.**
`connectIdentity` (`people.ts`) wrote the `person_identities` row and nothing else; `connectedAt` was set only
by `mergePeople`. Every MCP connect is exactly this case (LINK-3's own token exists *because* that surface has
no prior identity to merge against), and so is any Discord connect for a student who had not yet messaged the
bot: the proof succeeded, the identity attached, and the person was still declined by the LINK-1 gate on their
very next message — a loop with no exit, since redoing the same successful proof is itself idempotent. Fixed by
setting `connectedAt` (the same `coalesce`-never-move-backward write `mergePeople` already used) on both of
`connectIdentity`'s own successful branches — the fresh attach, and the idempotent "already this person's own
identity" branch (re-proving an identity you hold is still a proof).

**Rework, finding 2 — `connectIdentity` accepted a person who had already been merged away, and a merge could
strand an in-flight connect attempt.** `mergePeople` already refused a merged-away *survivor*; `connectIdentity`
had no equivalent guard on the `personId` it was asked to attach an identity to, reachable whenever the identity
itself was new (the common case). Concretely: a person begins a Discord connect attempt (a ten-minute-lived
challenge naming them as its own survivor); within that window a *different*, faster proof merges them into
someone else; their still-live challenge redeems successfully and attaches a genuinely proven identity to a
tombstone — which `mergePeople` now correctly refuses ever to merge forward, so the attempt is permanently
declined with no way out. Fixed on both sides: `connectIdentity` now refuses a `personId` whose
`mergedIntoPersonId` is set, and `mergePeople` re-points every outstanding (unused) Discord challenge naming the
loser as its survivor onto the new survivor instead
(`person-link-challenges.ts#repointOutstandingChallenges`), so the in-flight attempt still completes, against
whoever the person actually is by the time it redeems. `mcp` challenges need no equivalent repointing — see
finding 3, immediately below, for why they no longer carry a survivor at issue time at all.

**Rework, finding 3 — the proof bound the wrong side, on both surfaces, and the MCP half was an account
takeover.** This is the finding that mattered most. `completeMcpPersonLink(token, mcpExternalId)` took the
identity being connected as a bare, caller-supplied string, and attached whoever owned it to the challenge's own
person — so an attacker holding nothing but their *own*, legitimately-issued token could name an arbitrary
victim's identity and absorb them:

```
victim   = resolvePersonByIdentity(org, {mcp, 'victim-mcp-id'})   // transcripts, enrolments, usage
attacker = createPerson(org, {})
issued   = issueMcpPersonLinkToken(org, attacker.id, db)          // the attacker's own legitimate token
completeMcpPersonLink(issued.token, 'victim-mcp-id', db)
→ attacker absorbed victim; victim.mergedInto === attacker.id
```

The Discord half was the same shape by state fixation: `beginDiscordPersonLink` returned a state with nothing
tying it to the caller who began it, so an attacker could begin their own attempt (survivor = attacker), hand
the resulting authorization URL to a victim, and — the moment the victim approved it on Discord's own consent
screen, proving the *victim's real* snowflake — absorb the victim, because nothing checked that the caller
*redeeming* the state was the same caller who began it.

LINK-3's own text is explicit that a token's *delivery* is what proves the identity ("delivered where only that
caller can read it"), which means the challenge has to be issued **bound to the identity being connected**, not
to a survivor that does not exist yet at that point. `person_link_challenges` now binds opposite sides of the
proof depending on the surface (`schema.ts`'s own `CHECK person_link_challenges_binding_shape_check`, structural
rather than a convention two functions have to remember): a `discord` challenge is issued bound to the
*survivor* (`personId`) — sound, because Discord's OAuth genuinely proves the snowflake once the callback runs,
so the identity side does not need binding in advance — and an `mcp` challenge is issued bound to the *identity*
(`identityExternalId`) — because MCP has no sign-in of its own, and the token's own delivery to the unconnected
caller *is* the proof, before any survivor is known. Redemption is symmetric: `completeMcpPersonLink` now takes
the survivor from its own caller (`survivorPersonId`, asserted by whoever is already authenticated as that
person — the same trust `dispatch.ts`'s own `DispatchContext.accountId` already places in its caller) rather
than an identity, and is safe to trust *because* the identity side is fixed by the token — a caller can only
ever attach the one identity a given token was issued for, never assert an arbitrary one.
`completeDiscordPersonLink` now takes an additional `callerPersonId` and refuses a mismatch against the
survivor `state` was issued for — the state-fixation fix, checked inside the one function this module
advertises for completing a Discord connection rather than left for a future callback route to remember (the
same way `discord-install.ts`'s own callback route today checks a state's `accountId` against the caller's
session — this rework brings that check *into* the shared module itself, since `completeDiscordPersonLink` has
no route of its own yet to lean on). A redeemed secret is still consumed on a caller mismatch, the same
"spent either way" rule every single-use secret in this package already follows (`tokens.ts#consumeSignInToken`'s
own comment) — no retry, whatever the outcome.

Redeem-then-attach/merge also now runs as one transaction (this finding's own "also fix" 7, folded in here since
it is what makes the redesign safe to compose): `connectIdentity`/`mergePeople` (`people.ts`) accept
`TransactingExecutor`, not `Database`, the same widening `accounts.ts#createAccount` already established for
this exact "callable standalone, or nested as a savepoint inside a caller's own transaction" shape, and
`completeDiscordPersonLink`/`completeMcpPersonLink` open one transaction wrapping the consume and the
attach-or-merge — a redeemed secret whose attach then fails must not stay spent.

Also exposed, for LINK-3's own "the page names the account being connected and waits to be told to proceed":
`peekChallenge` (`person-link-challenges.ts`) and `previewDiscordPersonLink`/`previewMcpPersonLink`
(`person-link.ts`) — a read-only inspection of what completing a challenge *would* do (which person, which
identity, whether it merges someone in) without spending the secret. The connect screens themselves are still a
later slice; this is the primitive they will need.

**Rework, finding 4 — `hasVerifiedAddress` did not check an address.** It read `person.connectedAt !== null`
— bit-for-bit the fact the LINK-1 answering gate already reads — which PPL-5 is explicit are two separate
controls ("one proves which account is speaking, the other decides what may be shown"). Neither of LINK-3's own
proofs verifies an email at all: Discord's OAuth proves a snowflake, and an MCP token proves possession of a
private channel. Under the old code a person connected only through Discord, `email` still `null`, read `true`
— the first transcript-export or carry-a-conversation-onward caller built against this function would have
disclosed a transcript to someone who had proven nothing more than a snowflake. The only place this platform
actually verifies an *email* is AUTH-1's redeemed sign-in link or AUTH-2's Google-asserted `emailVerified` —
both `accounts`, not `people` — so `hasVerifiedAddress` now checks for a `web` `person_identities` row instead
(PPL-2's own "a web account id"): it can only exist for a person who has connected a real,
already-email-verified account, which is the actual proxy PPL-5 asks for.

**Rework, finding 5 — the role-based enrolment path silently revived what an instructor ended, and this slice
is where that became reachable.** `enrolViaDiscordRole` was written (D-34) `reviveEnded: true`, reasoned sound
in isolation ("holding the role is an ongoing, re-checked fact") but inert until some caller actually admitted
through it on the live message path — which this slice is what supplied. Once live, `true` meant ENRL-6's own
"stops the person asking that course" did not hold for a role holder: the student's next `@bloombot` silently
re-admitted them, with no record the removal had ever happened. Fixed in two parts, both in this slice, not
deferred: `enrolViaDiscordRole` now passes `reviveEnded: false` (matching `enrolViaRoster`'s own reasoning — an
ambient Discord role is not the deliberate re-admission decision redeeming a link or importing a roster row is),
and `handleMention` now refuses to answer, not merely to leave an out-of-step audit row, when a person who holds
the course's own `studentsRole` gets nothing back from `enrolViaDiscordRole` (which, holding that role, can only
mean a prior ended row is blocking them — the function's only other refusal, not holding the role at all, is
already ruled out). An instructor holding no student role of their own (`adminsRole` only, ENRL-5's "a Discord
role confers none of them") is untouched either way, and category-routed messages are gated by the same
`studentsRole` check, independent of which signal actually routed the message.

**Also fixed, finding 6 — a token presented to the wrong surface's redemption path was burned before being
rejected.** `consumeChallenge` matched on the secret's hash alone; checking `surface` only after the `UPDATE`
had already run meant a Discord state presented to the MCP path (or the reverse) was marked used — destroying
it for its own, legitimate surface — before the mismatch was ever noticed. `surface` is now part of the
`WHERE` itself.

**Also fixed, finding 8 — `getPersonIdentity` picked an arbitrary row once a merge made more than one identity
per surface routine.** A survivor absorbing a loser who had their own Discord identity is exactly `mergePeople`'s
own main case, which this function's original unordered `.get()` never accounted for. Ordered by `createdAt`
(oldest first) for determinism — not a full fix: the model's own opening item (`@bloombot/core`'s `answer.ts`)
can still name the "wrong" (but real, same-human) snowflake for a message that arrived on the survivor's *other*
identity on the same surface. True per-message accuracy needs the calling surface to pass its own already-known
external id through rather than this function re-deriving one from `surface` alone, which would touch
`answer.ts`'s own input shape and every surface adapter's — left out of this rework's own scope, and said here
plainly rather than silently left half-fixed.

---

## D-36 — `apps/mcp`: the third surface — an assistant reaches the platform as an ordinary account, a destructive tool asks a human directly, and the tool surface is a curated subset of the catalog

**Problem.** MCP-1..5 ask for a third surface — an MCP server exposing `packages/actions`' catalog to an AI
assistant — with four properties the brief names directly and one it leaves to this slice to work out
mechanically: the same dispatch pipeline the API uses (MCP-1), an explicit tool allowlist rather than the
whole catalog (MCP-2), a connection that carries exactly one account's authority and nothing more (MCP-3), a
destructive tool that asks for a confirmation the assistant itself cannot forge (MCP-4), and metering that
draws on the same ledger, attributed to the authorizing account (MCP-5).

**Choice — reuse AUTH-3's session tokens as the MCP credential, not a new credential type.** A connection
authenticates by presenting an existing session token (`@bloombot/auth#validateSession`) as
`Authorization: Bearer <token>` — the same opaque, hashed-at-rest token a cookie already carries for
`apps/api`. `apps/mcp/src/authenticate.ts` does nothing else: no service credential, no organization-scoped
API key, no separate account type for "an assistant." MCP-3's "no service identity that transcends tenancy"
is true by construction here — there is exactly one kind of principal this surface can authenticate as, an
`accounts` row, the same principal the web panel already authenticates. Minting a token specifically to hand
to an assistant (a "connect an assistant" screen in the panel) is `apps/web`'s own future work, out of this
slice's scope, the same way `packages/auth/src/person-link.ts`'s own module comment already draws that line
for the MCP half of account *linking* — this slice's brief is explicit that a token mechanism already existing
is not the same as a UI to hand one out.

**Choice — a tool call's `organizationId` is checked live, against the database, on every call — never cached
on the session.** `apps/mcp/src/call-tool.ts#callTool` calls `memberships.getMembership` fresh for every
single tool call, the same "read the database, not a snapshot of it" discipline every policy in this platform
already holds itself to, rather than resolving a caller's memberships once at connect time and consulting an
in-memory list thereafter. A membership revoked mid-session stops granting access on the very next tool call,
not merely the next reconnect — and the refusal is `ActionRefusedError`, byte-identical to every other refusal
`dispatch.ts` produces (TEN-5): a connection probing organization ids cannot tell "you have no membership here"
from "this organization does not exist" from "this record does not exist," the same guarantee ACT-3 already
gives the API.

**Choice — the transport is stateful (one `McpServer`/`StreamableHTTPServerTransport` pair per session,
tracked by the SDK's own `Mcp-Session-Id`), not stateless.** A fresh server per HTTP request looked simpler at
first — nothing to track between requests, the shape the SDK's own `simpleStatelessStreamableHttp.ts` example
uses — but MCP-4's own confirmation depends on the client's capabilities negotiated during `initialize`
(`Server#getClientCapabilities`) still being known by the time a later `tools/call` arrives. A fresh server per
request throws that negotiation away the moment the `initialize` response is sent, so every later destructive
call would see no capabilities at all and fail closed *unconditionally* — not the "fails closed when the
client genuinely cannot elicit" MCP-4 asks for, but "fails closed no matter what the client can do." Stateful
mode costs a session map (`apps/mcp/src/server.ts`'s own `sessions`, scoped per `buildApp` call) and the
bookkeeping that goes with it (`onsessioninitialized`/`onsessionclosed`), but it is what makes MCP-4's own gate
meaningful rather than a permanent refusal. Every request against an existing session — not only the one that
creates it — re-validates the bearer token (a token that has since expired or been revoked stops working
immediately, not merely at the next reconnect) and checks it still names the *same* account the session was
created for (`server.ts`'s own `existing.accountId !== accountId` check) — a session is a connection's own
state, not a bearer credential a second account's token can walk into.

**Choice — MCP-4's confirmation is MCP's own `elicitation/create`, aimed at the client application, not a
boolean tool argument.** The mechanical question the brief asks directly: what makes a confirmation something
"the assistant cannot supply on the person's behalf"? A boolean argument in the tool call itself does not,
however it is named or documented — every argument in a tool call is text the model itself generates, so a
model that decides to proceed can simply set `confirm: true` itself, and a model that already read a
"confirmation token" out of an earlier tool result can just as easily echo it back in a later call; neither
requires a human in the loop at all. `elicitation/create` is a distinct request *from the server to the
client*, not a value inside the tool call/result exchange the model drives — the MCP specification's own
elicitation capability exists precisely so a server can ask the *client application* to put a question in
front of the person using it, and the client's own job (not this server's, and not enforceable by this server)
is to actually show it to a human rather than auto-answer it. `apps/mcp/src/server.ts#requestElicitedConfirmation`
sends exactly this — a `mode: 'form'` request with one required boolean field, worded to say the assistant
cannot answer it — before `call-tool.ts` will dispatch `courseAttachments.detach`, the one destructive action
in today's catalog (`tool-surface.ts`'s own module comment has why it is the only one).

**What this does not, and cannot, guarantee.** MCP is a protocol, not an enforcement boundary this server
controls end to end — nothing stops a non-compliant client from auto-answering `elicitation/create` itself,
the same way nothing stops a browser extension from auto-clicking a confirm button in a web UI. What this
design does guarantee is that the *assistant* — the model generating tool-call arguments from the
conversation — has no channel to supply this answer: it is not an argument the model wrote, and it is not a
value the model could have read out of an earlier response and replayed, because `elicitInput`'s own request
is answered by the client's transport layer, not by anything that becomes part of the model's own context
unless the client chooses to show it there. A client that wants to defeat this has to be built to do so
deliberately; an assistant cannot stumble into it by writing a plausible-looking argument.

**Choice — fails closed, not merely "skips the check," when the client cannot elicit at all.**
`requestElicitedConfirmation` checks `getClientCapabilities()?.elicitation?.form` — the exact capability the
SDK's own `elicitInput` requires for the default form mode — before ever sending the request; a client that
never declared it gets `false` back, and `call-tool.ts` treats that identically to an explicit decline
(`ConfirmationRequiredError`). The alternative — silently running the destructive tool anyway when the client
has no way to ask a human — would make MCP-4 optional for exactly the clients least equipped to honor it.
Same fate for a `requestConfirmation` that throws or rejects outright (a connection that drops mid-elicitation):
caught and treated as "not confirmed," never as an unhandled failure that could be mistaken for success.

**Choice — the tool surface (MCP-2) is an explicit array of action names (`apps/mcp/src/tool-surface.ts`'s own
`MCP_TOOL_SURFACE`), checked against a real registry at startup, not derived from `ActionRegistry#list()`.**
`buildToolDefinitions` throws if the array names an action the registry does not have (a typo, a renamed
action) — loud, because a silently shrunken tool list is a worse failure than a crash a reviewer notices
immediately. It silently *omits* an action the registry has that the array does not name — the direction
MCP-2 actually cares about: a new action registered into `createPlatformRegistry` by some other slice must not
become agent-callable by default, and it does not, because nothing added its name to this array.
`tests/tool-surface.test.ts`'s own leak-probe test is the proof this is true mechanically, not merely by
convention: it registers a fresh action nothing has ever heard of into the real platform registry and asserts
it never appears in `buildToolDefinitions`'s output — a test that fails immediately if that function is ever
rewritten to derive the surface from the registry instead of the array (proven directly for this slice: swap
`MCP_TOOL_SURFACE.map` for `registry.list().map` and four tests in that file fail).

Today's array covers the read-only half of the catalog in full, plus the ordinary writes that are either
reversible (`projects.archive`/`.unarchive`) or end/disable access without discarding the record itself
(`courseJoinLinks.revoke`, `enrolments.end`) — deliberately smaller than "everything that would work." Left
off, for a future slice to add explicitly rather than by default: `courseAttachments.attach` (an arbitrary
base64 file upload — a large,
unusual argument shape to hand a model with no size conversation this slice has had),
`discordServers.remove`/`.scaffold` (operational actions against a live Discord server), `roster.import` (a
bulk write of students' own names and emails), and `memberships.grant` (grants account-level authority within
the organization — a privilege change that deserves its own confirmation design, not folded into MCP-4's
"destructive" bucket as an afterthought since it neither deletes, exports, nor spends money by that
requirement's own three named triggers).

**Choice — MCP-5 is satisfied structurally, by routing every call through the same `dispatch()`, not by any
new accounting code in this slice.** `apps/mcp/src/call-tool.ts#callTool`'s only call that actually does
anything is `dispatch(tool.action, actionArgs, { organizationId, db, accountId })` — the same function, the
same pipeline, `apps/api/src/routes/actions.ts` already calls. No action registered in today's catalog carries
a real `meter` hook (`packages/actions/src/types.ts`'s own `Meter` type — every action in `packages/actions/src/actions`
either omits it or the pipeline's own no-op default runs), so there is nothing for this slice to attribute a
cost to yet; the guarantee this slice adds is structural, not a new number anywhere: any action that later
gains a real meter is metered identically for an MCP caller, because `call-tool.ts` has no second write path
that could fall out of sync with it the way `packages/core/src/pricing.ts`'s own `costMicros: 0` fallback once
did for an unmetered model call (that file's own comment: "`0` there used to read as 'this call was free'").
This slice deliberately computes no cost of its own and writes no ledger row of its own — there is no model
call anywhere in this catalog's actions to attribute one to.

**Limits.** The web panel's "connect an assistant" screen — the UI that actually hands an account a token to
paste into an MCP client's configuration — is not built here; this slice's own brief is explicit that it is
out of scope, the same "provides the token mechanism, not the flow that hands it out" shape
`packages/auth/src/person-link.ts`'s own module comment already draws for LINK-3's MCP half.

---

### Rework round — what two independent reviewers reproduced, and what changed

Two reviewers (one on conformance and test quality, one on security) went at `77caabd` independently and both
returned "merge after fixes." Both attacked tenancy, ordering, the bearer credential, session pinning and
metering directly and found nothing — those hold as designed, above. What follows is what they reproduced
against a live listener and real mutations, not what they suspected.

**Rework finding 1 — `courses.save` was on the surface unmarked, and it deletes.** `courses.ts#updateCourse`
calls `deleteCourseCategories` and re-inserts from `input.categories` on every save; `saveInputSchema` makes
`categories` required, so a model that resupplies a partial list (or never read the current one at all)
silently discards the rest. Reproduced live: `courses.save` reported `isError: false`, raised no elicitation,
and left `destructiveHint: false` in its own tool definition — a well-behaved client had nothing to warn a
person on. Fixed by marking it `destructive: true` (`tool-surface.ts`) with its own `describeTarget`
(`describeCourseSaveTarget`) rather than dropping it from the surface — the tool stays useful (renaming a
course, toggling it on or off) while a human now sees what is about to be replaced before it happens. A
partial-update input shape is the real fix and is not this slice's: `saveInputSchema`'s `categories: z.array(...)`
(required, whole-list) is `packages/actions`' own schema, and narrowing it to an optional diff is a design
change to an action every other surface (the web panel, once it exists) would also need to agree to, not
something `apps/mcp` can decide unilaterally by itself.

**Rework finding 2 — `jobs.get` hands a model whatever PII its own job's `payload` carries, unfiltered.**
`roster.import`'s own job payload is `{ courseId, csvText }` — a raw CSV of students' names and emails — and
`jobs.get` (`repos/jobs.ts#toJobStatus`) returns `payload` unparsed-but-unfiltered. `roster.import` itself is
deliberately off the MCP surface for exactly this reason (its own module comment), but `jobs.get` being on the
surface at all defeated that exclusion in one read — reproduced live by enqueueing a roster-import job and
reading its payload straight back through `jobs.get`. The id being otherwise unguessable (`jobs.list` is also
off the surface) was never a real guard and is not relied on as one. Fixed with `ToolSurfaceEntry.sanitizeOutput`
— a per-tool output transform, applied in `call-tool.ts` after `dispatch` succeeds, before this file's own
`callTool` returns.

**Round two of the same finding — `payload` was not the only field carrying it, and denylisting one field at a
time is what produced this in the first place.** The first version of this fix (previous paragraph) stripped
`payload` and left every other field, reasoned about as "status, attempts, result, timestamps still reach the
model, so the tool stays useful" — wrong, because `result` is exactly as capable of carrying PII as `payload`
is, and a **succeeded** `roster.import` job's own `result` is a `RosterImportReport`
(`apps/worker/src/handlers/roster-import.ts`) that carries a student's email or Discord handle in eight of its
own array fields (`unresolvedHandles`, `channelsCreated`, `channelsAlreadyPresent`, `channelAccessGranted`,
`channelsNotCreated`, `channelsFailed`, `channelNameCollisions`, `ambiguousHandles`, plus `peopleCreated`/
`peopleMerged`/`rosterFieldsDeclined`). Reproduced live, one job-state later than the first finding: claim and
complete a roster-import job with a real report, then `jobs.get` it back — four students' addresses and
handles in the response. The existing test only ever exercised a *pending* job, whose `result` is always
`null`, which is exactly why it stayed green through this. Fixed properly this time:
`allowlistJobFields` (`tool-surface.ts`) returns exactly `{id, kind, status, attempts, maxAttempts, lastError,
createdAt, updatedAt}` and nothing else — an allowlist, not a denylist, so the next handler that returns a
richer report does not reopen this by default the way `result` just did. `lastError` stays on the list, but
checked, not assumed: every `throw` in every handler this catalog registers today names a course, an
organization, a job kind, or a malformed-payload shape, never a roster row — a per-row failure in
`roster.import` is caught and pushed into the report (still excluded, as part of `result`), never re-thrown to
become `lastError`. That is a property of today's handlers, not something this tool enforces mechanically; a
future handler that threw a per-row error naming a student would reopen the same shape through the one field
this tool still returns. Making that mechanical — asserting, in a shared place, that no handler's own thrown
error text can embed request-specific data — is bigger than this tool and is not this round's fix. The test
that exercises this now claims and *completes* a job with a real `RosterImportReport`
(`seedCompletedRosterImportJob`) before reading it back, and asserts no email or handle appears anywhere in
the serialized tool result — not that one particular key is absent, the same mistake the first version of this
test made.

**Rework finding 3 — the session map never released anything, and one account could exhaust the process.**
`onsessionclosed` (the SDK's own hook) fires only for a client-driven `DELETE`; nothing closed a session this
process itself decided to end, and nothing bounded how many sessions one account could hold open at once. Both
reviewers measured it independently against a live listener: roughly 165–185 KB retained per abandoned
session, 165 MB retained after 1,000 `initialize` POSTs and a forced GC, 380 MB after 2,000, with `/health`
reporting `ready: true` throughout and the very first abandoned session still live at the end. Fixed three
ways, all in `server.ts`: `transport.onclose` is now wired (using the transport's own `sessionId` getter,
set before `connect`) so a session the SDK itself considers closed — for *any* reason, not only a client
`DELETE` — is evicted the moment it happens; `MAX_SESSIONS_PER_ACCOUNT` (20) refuses a new session with `429`
once one account already holds that many; and `sweepIdleSessions` — a pure function of a session map, a clock,
and a timeout, tested directly with an injected `now` rather than a real timer — closes and evicts whatever
has gone `SESSION_IDLE_TIMEOUT_MS` (30 minutes) without a request against it, run by `buildApp` on an
`.unref()`'d interval so it never itself keeps the process alive. `/health` now also reports `sessions: <count>`,
the same "surface an internal counter" idiom `apps/bot`'s own COST-5 model-stats field already uses — the
specific symptom "healthy report, unbounded growth underneath it" is closed structurally by the bound, and the
counter makes the bound's own effect visible to an operator going forward. The related report that "sign out
everywhere" left a stale `Mcp-Session-Id` usable again after a fresh sign-in was a symptom of the same root
cause (nothing ever closed the old session) rather than a distinct hole in the account-pinning check itself
(unchanged, and still attacked and cleared by both reviewers) — bounding session lifetime is what keeps a
stale session from surviving long enough for that sequence of events to matter.

**Rework finding 4 — MCP-4 was structurally correct but unproven: two mutations survived the whole suite.**
Treating any elicitation response (`decline`, `cancel`, anything) as consent, and deleting the `elicitInput`
call entirely while still returning `true` (keeping only the capability gate), both left 36/36 `mcp` tests and
1426/1426 overall green — the only transport-level test exercised the never-declared-capability path, which a
bare `return false` stub also satisfies, so nothing pinned what a real client's real answer actually did. Fixed
by `tests/mcp-e2e.test.ts`: a real `@modelcontextprotocol/sdk` `Client`, a real `StreamableHTTPClientTransport`,
a real `node:http` server on an ephemeral port, exercising `courseAttachments.detach` end to end for
`accept {confirm:true}`, `accept {confirm:false}`, `decline` and `cancel` — asserting the job queue, the
attachment's own status, and the tool result for each. Both named mutations are killed by this file (verified
directly: reintroducing either locally fails the relevant tests, reverting restores green). The reason this is
possible at all despite the "cannot be tested without a lower-level HTTP client" limitation the first version
of this decision recorded: a real client on a real socket can simply read a streamed SSE response as it
arrives and answer the embedded `elicitation/create` request before that response finishes, which `supertest`'s
own buffered model cannot do — the fix was to stop trying to do this through `supertest` at all, not to work
around it.

**Rework finding 5 — attribution had no test, and dropping it broke two allowlisted actions silently.**
Deleting `accountId: context.accountId` from `call-tool.ts`'s own `dispatch` call left all 1426 tests green —
`call-tool.test.ts`'s own attribution test asserted only that a `projects.create` call's output matched, which
holds regardless of whether `accountId` was threaded through. The real breakage: `courseInstructions.save` and
`.restore` are both allowlisted and both refuse outright (`ActionRefusedError`) with no `accountId`
(`course-instructions.ts#requireAccountId`), so the mutation made both return the platform's generic
not-found-shaped refusal for every MCP caller, silently. Fixed with a test that calls `courseInstructions.save`
through `callTool` and reads the resulting revision's own `savedByAccountId` back through the repository
directly — a passing test is only possible if `dispatch` actually received the calling account, not merely
that the call happened not to throw (reintroducing the mutation locally fails exactly this test and no other).

**Rework finding 6 — `buildToolDefinitions` ran lazily, per session, so a stale allowlist entry killed the
first real session instead of this process's own startup.** A renamed or removed action on the surface used to
surface as a `500` on whichever session happened to hit it first, with `/health` reporting `ready: true` the
whole time — a supervisor (OPS-8) or a liveness probe would see a healthy process with a dead tool surface.
Fixed by calling `buildToolDefinitions(registry)` once in `index.ts`, before `server.listen` — the same
"throws at startup, not on the first request" discipline `apps/api`/`apps/bot` already hold themselves to for
`CONFIG` validation. `ServerDependencies.toolDefinitions` replaces `registry` in `server.ts`'s own dependency
shape; `call-tool.ts#CallToolContext.toolDefinitions` replaces its own `registry` field the same way, which
also closed a separate, smaller finding (13 in the reviewers' own numbering) for free: resolving every
action's own JSON Schema on every single tool call was measured waste, and building the list once removes it.

**Rework finding 7 — the confirmation named the tool and a raw organization id, never the record.** "Confirm
courseAttachments.detach in organization 8dc7bf86-…" reads identically whether the call is about to detach an
old syllabus or a final exam key — the protocol binding was sound (concurrent detaches produced distinct
elicitations; nothing was replayable), but the human's own consent was bound to a tool name, not a record.
Fixed with `ToolSurfaceEntry.describeTarget` — required whenever `destructive` is `true`
(`buildToolDefinitions` throws at build time otherwise, the same loud-failure discipline finding 6's own fix
uses) — resolved in `call-tool.ts#resolveTargetLabel` by calling the action's own `policy.resolve` directly
(the same read `dispatch` is about to make a moment later, never a second lookup that could drift from what
`execute` actually acts on) before `requestConfirmation` is ever called. `courseAttachments.detach` now names
the attachment's own filename; `courses.save` names the course's own title (or, on create, the title it is
about to get). A target that does not resolve at all (a made-up id, or input that does not validate) skips the
confirmation entirely — `dispatch` produces the real refusal instead, and asking a human to confirm deleting
something that does not exist or is not theirs is not a question worth asking.

**Choice — `courses.save`'s own `describeCourseSaveTarget` asks for confirmation on a pure create too, even
though a brand-new course has no existing categories or channels for it to destroy.** `entity.existingCourse`
is only set when `input.id` names a course that already exists (`courses.ts`'s own `CourseSaveEntity`); a
create has nothing to replace, so the confirmation this round adds for it is not, strictly, guarding against
data loss the way it is for an update. Left as-is, deliberately, rather than narrowing `resolveTargetLabel`
(`call-tool.ts`) to skip the gate on a pure create: `courses.save` is one action for both create and update —
the same call shape, told apart only by whether `input.id` is present — and a caller (or a model filling in
arguments) getting that wrong is exactly the kind of mistake this file's own `describeTarget` mechanism exists
to catch before it happens rather than after. This fails safe (one unnecessary confirmation on an ordinary
create) rather than unsafe (a caller who meant to create ends up silently updating, or the reverse), which is
the trade this repository's own idiom already prefers elsewhere (TEN-5's own refusal shape is the same kind of
"say no when genuinely unsure" choice). Noted here rather than left for a future reader to wonder whether it
was an oversight.

**Also fixed, smaller.** `call-tool.ts`'s own module comment used to claim a missing or malformed
`organizationId` "refuses the same way an organization the caller cannot see does" — true only inside
`callTool` itself; over the real HTTP surface zod's own `-32602` shape wins first. Not an oracle either way
(nothing about "malformed" leaks whether any organization exists), but the comment asserted a property the
code did not actually hold everywhere — split into its own `InvalidToolArgumentsError`, distinct from
`ActionRefusedError`, with the comment corrected to say so. `EXPECTED_DESTRUCTIVE`
(`tests/tool-surface.test.ts`) applies ACT-5's own access-audit idiom to MCP-4 directly: an exhaustive table,
one row per allowlisted action, that a reviewer edits by hand — catching a tool *losing* its `destructive`
marker (finding 1's own shape) as well as one gaining one unasked, which `destructive: true` alone (with
nothing cross-checking it) never could. `buildToolDefinitions(registry, surface = MCP_TOOL_SURFACE)` takes an
injectable second parameter now, so a test can build definitions around a fake action (finding 5's own
attribution coverage did not need this, but MCP-5 in general — a metered action this platform's real catalog
does not have yet — has nowhere else to be tested against without it). `elicitInput` now passes an explicit
30-second `timeout` (`DEFAULT_ELICITATION_TIMEOUT_MS`) rather than the SDK's own 60-second default — MCP-4
already fails closed on a timeout the same as an explicit decline, so this is a latency fix, not a correctness
one.
`apps/mcp/src/shutdown.ts` splits this process's own signal handling into its own testable module, matching
`apps/bot`/`apps/worker`'s own `createShutdown` rather than staying inlined the simpler way `apps/api`'s does.

**CI-only flake in `tests/mcp-e2e.test.ts` — a hung elicitation and a vitest test timeout were
indistinguishable.** Reported by CI, not reproducible locally (macOS, 15+ solo runs, a full-suite-loaded run,
and a CPU-stressed run all passed): two of the file's five tests (`cancel`, and the message-naming test, which
uses `decline`) failed at 30008ms/30006ms — `ELICITATION_TIMEOUT_MS`'s own then-value, 30 seconds, is exactly
`vitest.config.ts`'s own root `testTimeout`, inherited three commits later in this same slice's own rebase,
after the constant was already written with no reason to expect it would ever collide with anything. At that
exact ceiling a genuine server-side timeout (the client never answers, `elicitInput` gives up, the tool call
still resolves — correctly — as a fail-closed refusal) and vitest simply killing the test read identically:
same elapsed time, no way to tell which end actually stalled from the report alone. Fixed structurally, the
one change made regardless of ever pinning the exact CI-only cause: `ServerDependencies.elicitationTimeoutMs`
is now injectable (defaulting to `DEFAULT_ELICITATION_TIMEOUT_MS`, still 30 seconds, in production —
`index.ts` never overrides it), and `tests/mcp-e2e.test.ts` runs every one of its own tests at 2 seconds, with
one dedicated test at 300ms proving the fail-closed-on-timeout path fires at all (nothing did before this
round — the file's other tests all supply an answer). A real hang now fails in a couple of seconds with a
message that says a confirmation was not given, not sixty times that with a message that says nothing.

The file was also restructured so every test owns its entire scenario — `setUp()`/`ctx.dispose()`, called
inside each test's own `try`/`finally` — rather than a shared module-level `let client/server` reassigned per
test and torn down from one shared `afterEach`: no two tests share a server, a client, a port, or a database
connection, and one test's own teardown can never be mistaken for bleeding into the next test's timing budget.
`dispose()` also now calls the client transport's own `terminateSession()` (a real `DELETE /mcp`) before
`client.close()` — `close()` alone does not send `DELETE` (this file's own D-36 finding, `MAX_SESSIONS_PER_ACCOUNT`),
so the prior version left each test's own server-side session semantically "open" until the test's own server
was discarded moments later; terminating it explicitly is strictly more correct regardless of whether it bears
on the CI failure.

**Round two — confirmed, not merely hypothesized: the elicitation was going out on the wrong stream, and a
destructive tool could fail closed in production because a confirmation was never delivered at all.** The CI
report after the timeout fix (above) was unambiguous: `cancel` and the message-naming test both recorded an
*empty* `elicitations` array — the client's own handler was never invoked. On the timeout test specifically
that means the server correctly gave up and failed closed, but for the wrong reason: not "the client was asked
and declined to answer" (MCP-4's own requirement) but "the request never reached the client at all" — a
materially weaker property that the fake-`requestConfirmation` unit tests could not tell apart from the real
one, and that this file's own tests, before this finding, did not either.

Mechanism, read directly from the SDK's own source rather than inferred: in Streamable HTTP, an outgoing
server-to-client request is written to a specific stream chosen by `options.relatedRequestId`
(`shared/transport.js`'s own `TransportSendOptions`) — when set, `StreamableHTTPServerTransport#send`
(`server/webStandardStreamableHttp.js`) writes onto *that* incoming request's own POST response stream; when
absent, it treats the message as an unsolicited push and writes onto the *standalone* `GET /mcp` stream
instead — and when that standalone stream has no controller registered yet, `send`'s own standalone branch
does nothing at all: no error, no notification, the message is simply dropped (an event-store-backed replay
is the only recovery path, and this server configures none). `requestElicitedConfirmation` called
`mcpServer.server.elicitInput(...)` — the low-level `Server`'s own convenience method, which calls
`Protocol#request()` with no `relatedRequestId` at all, because outside of a request handler's own context
nothing tells it one exists. The one place the SDK *does* set `relatedRequestId` automatically is
`RequestHandlerExtra.sendRequest` — the function handed to a tool's own callback as `extra`, which stamps
`relatedRequestId: request.id` (`shared/protocol.js`'s own `fullExtra.sendRequest`) using the id of the
`tools/call` currently being handled. `elicitInput`, called from outside that callback's own closure, has no
access to it.

That leaves the standalone stream as the only place the elicitation could go — and the client's own
`StreamableHTTPClientTransport` does not open it synchronously. It is started fire-and-forget, from inside the
handler for the client's *own* `notifications/initialized` send, only after a `202 Accepted` comes back
(`client/streamableHttp.js`): `this._startOrAuthSse(...).catch(...)`, never awaited by anything —
`client.connect()` resolves once `initialize` and `notifications/initialized` are sent, not once the
standalone GET has actually connected server-side. A `tools/call` arriving before that GET registers loses its
own elicitation with no error on either side — the exact race a slower CI runner hits more often than a fast
local one, and the reason `cancel` and the `decline`-based test failed while the file's other tests, run in
the same file moments apart, did not: which test loses the race is closer to arbitrary than tied to what the
test is about.

Confirmed by direct reproduction, not merely read from source: a standalone script built on this app's own
`buildApp` and a real SDK `Client`, with `globalThis.fetch` patched to delay only the client's own GET to
`/mcp`. Against the pre-fix code, a 300ms delay lost the elicitation on every run (`elicited: false`, the tool
call itself still resolving — refused, not hung — from the server's own timeout); an undelayed run never lost
it. Against the fix below, the same 300ms delay — and a 5-second delay, an order of magnitude past anything a
real network hiccup would need — both still delivered the elicitation every time, because the fix no longer
depends on the standalone stream at all.

**Fix.** `requestElicitedConfirmation` now sends through `extra.sendRequest(...)` — the tool call's own
`RequestHandlerExtra`, threaded from `registerTools`' own callback signature (`async (args, extra) => ...`,
where `extra` previously went unused) down through `requestElicitedConfirmation`'s own new parameter — with
`ElicitResultSchema` (imported from the SDK's own `types.js`) validating the response shape, the one piece of
`elicitInput`'s own convenience this loses by going around it; this function's own check
(`content?.['confirm'] === true`) only ever trusted that one field regardless, so nothing this code actually
relied on is weaker for it. `tests/mcp-e2e.test.ts` gained a dedicated regression test —
`setUp`'s own new `delayStandaloneGetMs` option, patching `globalThis.fetch` for the one GET request that
matters — proving the confirmation reaches the client with that stream deliberately still unconnected;
reverting the fix locally (`elicitInput` in place of `extra.sendRequest`) makes exactly that test fail with
the same empty-array assertion CI reported, and no other test in the file.

**What this means for a real assistant client that has not opened its own push stream yet.** Before this fix,
any MCP client whose implementation delays, batches, or altogether skips proactively opening the standalone
GET stream — which the specification itself describes as optional ("server may not support it" is the SDK's
own comment on the *server* side of that same optionality, and nothing obliges a client to race it either) —
could have a destructive tool's confirmation silently vanish, and see an unexplained refusal with no
elicitation ever shown to the person operating it: fail-closed, so not a security hole, but a real reliability
gap a production assistant could hit on every single destructive call if its own client implementation happens
to defer that stream. The fix removes the dependency entirely rather than papering over the race (a longer
client-side timeout, or making this server wait for the standalone stream before proceeding, were both
considered and rejected — the correct fix is to stop needing that stream for a reply to a call already in
flight, not to wait for it longer or delay dispatch on its account, discussed and set aside during this same
round).

**Limits.** This closes the one path this platform's own destructive tool (`courseAttachments.detach`) and
its own confirmation flow use. Any future server-initiated request raised *outside* a tool call's own handler
(a notification unrelated to any specific `tools/call`, say) still has nowhere to go but the standalone
stream, correctly — that is what it is for, and nothing here removes it or the SDK's own optionality around a
client ever opening it. Nothing in this platform raises one today.

**Rebase.** This slice was rebased onto `origin/feat/PLAT-1-multi-surface-platform` directly rather than onto
`feat/LINK-1-account-linking` (D-28's own linking branch, still in review) — this slice never depended on the
account-linking mechanism, so tracking that branch's own base was coupling with no payoff. `scripts/dev.mjs`
(`b558b43`, the platform branch's own) exists on this new base; `apps/mcp` is added to its `PROCESSES` list
with `requires: []` (MCP-3's own "a connection authenticates itself, at request time" — this process reads no
credential of its own at startup, unlike the bot or the worker), and `scripts/dev.test.mjs` is updated to match
— closing the one limitation the first version of this decision recorded that a rebase, not further code, was
what could actually fix.

## D-37 — `apps/web`/`apps/api`: the design system's tokens, the chat sanitizer's allowlist, and how WEB-10 resolves a web person without LINK-1

**Problem.** WEB-11..17 ask for one styling system, one icon set, a responsive shell and a set of conventions
(primary/secondary/destructive, form errors, keyboard/AA) — none of it existed; the panel was unstyled HTML.
WEB-10 asks for a web chat surface that renders Markdown safely, through the same `@bloombot/core#answerQuestion`
pipeline the Discord surface calls. Both landed in the same slice (`spec/web-chat-shell`) because they are the
same screen work, per that slice's own brief.

**Choice — Tailwind v4, tokens in `style.css`'s own `@theme`, not a `tailwind.config.js`.** `@tailwindcss/vite`
(the v4-native integration) reads `apps/web/src/style.css`'s `@theme` block directly — a brand scale, a
neutral scale, `success`/`warning`/`danger` semantic accents, two named type sizes, and two named spacing
values (`--spacing-header`/`--spacing-footer`, so `AppShell.tsx`'s fixed header/footer and its main content's
padding can never drift out of sync with each other). Named once, here, rather than as literal hex codes and
pixel values scattered across every component — the brief's own "we can review and refine later" is one edit
to this file, not a sweep. No separate stylesheet exists anywhere else in `apps/web` (WEB-11's own "not
several").

**Choice — Lucide icons named by intent, not by Lucide's own component name.** `icons.ts` re-exports `Pencil`
as `EditIcon`, `Trash2` as `DeleteIcon`, and so on for every recurring intent WEB-12 names — edit, delete,
add, remove-from-list, disable, enable, duplicate, archive/restore. A call site imports `EditIcon` and reads
"edit"; changing *which* Lucide icon means "edit" later is one line here, not a search-and-replace. Every
icon-only control supplies its own `aria-label` at the call site (this file only names which icon a screen
reader would otherwise say nothing about).

**Choice — the chat sanitizer is an explicit allowlist, and why that is the load-bearing property, not merely
a preference.** `apps/web/src/markdown-schema.ts`'s `CHAT_MARKDOWN_SCHEMA` extends `hast-util-sanitize`'s own
`defaultSchema` but replaces `tagNames`/`attributes`/`protocols` with an explicit, narrow list — exactly what
WEB-10's own headings/emphasis/lists/links/fenced-code, plus GFM's tables/strikethrough (already in the
pipeline via `remark-gfm`). A denylist has to anticipate every dangerous thing a model or a student might
type — the next `on*` attribute, the next dangerous protocol, an element nobody thought to ban yet; an
allowlist only has to name the handful of things Markdown legitimately produces, and everything else (a raw
`<script>`, an `onerror`, a `javascript:` URL, an `<iframe>`) is refused by construction. Two layers, not one:
`react-markdown`'s own default pipeline never turns raw HTML in the Markdown source into real DOM at all (no
`rehype-raw`, `allowDangerousHtml` never set) — a literal `<script>` written into a message is parsed as an
HTML node and dropped outright; `rehype-sanitize` against this schema is the second layer, holding the line on
what Markdown *syntax itself* can legitimately produce (a `[text](url)` link is real Markdown, not raw HTML,
and needs its `href`'s protocol checked). Verified directly (see `docs/DECISIONS.md`'s own habit of recording
what a rework actually proved, and `apps/web/tests/chat-message.test.tsx`'s own hostile-input cases): a raw
`<script>`, an `<img onerror>`, a Markdown link to `javascript:`, a raw-HTML `<a href="javascript:">`, a
Markdown image (images are excluded from the schema entirely — an `<img src>` is a live fetch to whatever URL
the model names, even protocol-restricted, which still lets a message load a tracking pixel or probe a
private address the moment it renders) and a `<style>` block are all neutralized; ordinary Markdown (headings,
bold, links, fenced code, GFM tables) renders as real elements.

**Choice, as first written — WEB-10's backend resolves the caller's own `'web'`-surface identity, not LINK-1's
`connectedAt`.** At the time this slice first ran, `packages/db/src/repos/people.ts` and
`packages/core/src/answer.ts` were both being changed by a separate, open, unmerged PR
(`feat/LINK-1-account-linking`, LINK-1..5/PPL-4/5 — a person proven to hold more than one surface identity,
merged into one so allowance and transcript follow them everywhere, gated behind a new
`person.connectedAt`/`'not-connected'` refusal). Editing either file here would have collided with that PR's
own changes to the same lines, so `apps/api/src/routes/chat.ts` instead resolved the caller through
`people.resolvePersonByIdentity(organizationId, { surface: 'web', externalId: account.id }, db)` — the same
"create on demand" function every other surface's first contact already uses (PPL-3) — and called the
*then-current*, unmodified `answerQuestion`, with no `connectedAt` gate on that branch yet.

**Rework finding — this was wrong, on three counts a review round caught together, and the claim above that it
was merely an interim measure was false: the chat surface it produced was not reachable by any real student at
all, not "reachable, pending a small follow-up."** Kept here, corrected, rather than deleted — the record of
what was tried and why it did not hold is worth as much as the record of what worked (this file's own
convention throughout).

1. *Unreachable in production.* Every real enrolment in this system belongs to a `discord`-surface person —
   `handle-mention.ts`'s own first contact, `roster-import.ts`'s own admission — never to a person created by
   `resolvePersonByIdentity` on the `'web'` surface. `enrolments.listCoursesForPerson` keys strictly on
   `person.id`, so a web-surface person created this way could never resolve to a real enrolment, for any
   account, ever — not a gap a future configuration or a join-link route alone would close, because nothing
   pointed the two person rows at each other in the first place. The slice's own test suite and e2e spec hid
   this: both seeded the enrolment against a web-surface person *resolved the same way the route itself would*
   — tautological about the exact bug this rework fixes, proving only that the code agreed with itself.
2. *A second allowance.* A `{surface: 'web'}` person and a `{surface: 'discord'}` person for the same human are
   two distinct rows, two usage counters, two transcripts, in the same organization — exactly what LINK-5 ("one
   person, one allowance, across every surface") and D-28 exist to prevent, reintroduced by this router's own
   person resolution. Once LINK-1 merged, `answerQuestion` began declining every person whose `connectedAt` is
   `null` — which a `resolvePersonByIdentity`-created person always is — so the practical effect became total:
   every web chat message declined, silently (`Chat.tsx`'s own `describeDeclineNotice` had no case for
   `'not-connected'`, so nothing was shown at all — a student watched their own message post and then nothing
   happen, a silent hang).
3. *A cross-tenant write, before anything checked the caller belonged there.* `resolveCallerPerson` called a
   *creating* function on the raw `:organizationId` URL param before any check that the caller had a
   relationship to that organization — reachable by any signed-in account against any other tenant's
   organization id (writing a `people` row that carried the attacker's own account id, the refusal issued only
   after the write), and a nonexistent organization id produced a raw foreign-key `500` rather than the same
   `404` every other foreign or absent id in this app answers — an existence oracle.

**The fix.** A signed-in web caller *is* the account — they proved control of it by signing in, which is
exactly the proof LINK-3 already asks of every other surface's own connect step, so a *second*, separate
"connect your web account" action was never actually needed for the web surface itself. `@bloombot/auth`'s
`sign-in.ts` (`createConnectedWebPerson`) now creates the account's own person, in its own personal
organization, and connects it immediately — through the real, merged `people.ts#connectIdentity` (LINK-3's own
path), never a raw `connectedAt` column write — the moment the account itself is created (both
`findOrCreateAccountForEmail`'s and `tryCreateAccountForEmail`'s "new account" branches; `createPerson`'s own
`db` parameter widened from `Database` to `Executor` so it can be called from inside their existing
transaction, the same widening `getPerson`'s own doc comment already explains for the identical reason).
`routes/chat.ts` now only ever *looks up* that person (`people.resolveIdentity` — read-only, so there is no
insert left for a foreign or nonexistent organization id to reach) and refuses with the same `chat_not_connected`
"invited to connect" shape LINK-1 gives every other unconnected identity when there is none, or when
`connectedAt` is somehow still `null`. The organization's own existence is checked explicitly, first, so a
foreign and a nonexistent organization id answer identically (TEN-5) rather than a `404` for one and a `500`
existence oracle for the other.

**What this does, and does not, make reachable.** A person created and connected this way lives in the
account's own *personal* organization (TEN-1's own one created alongside it) — the one organization known at
that exact moment. Reaching a course in a *different* organization (an institution's own, where a real student
is admitted through a Discord role or a roster row) still requires something to connect that same account's web
identity to the person that admission already created there — LINK-3's own proof, same as any other surface —
which is exactly what a join-link "connect" route would do, and remains out of this slice's own scope (its own
module comment, and D-31's "Limits", on why `redeemCourseJoinLink` is still unwired from any route). Until that
lands, an account with no connection in a given organization is refused honestly (`chat_not_connected`) rather
than shown a misleading empty course list or a silent hang — `apps/api/tests/routes/chat.test.ts` seeds an
enrolment the way production actually creates one (a `discord`-surface person, `enrolViaRoster`) and proves
both halves: unreachable and honestly refused before any connection exists, reachable once
`people.connectIdentity` — the real function, not a shortcut — has connected the two, the same device a future
join-link route would use. `e2e/chat.spec.ts` no longer creates its own person at all; it looks up the one
`sign-in.ts` already created and connected for the same account, and enrols that.

**Choice — `apps/api`'s own `OPENAI_API_KEY` is optional, unlike `apps/bot`'s.** `apps/bot`'s `main()` calls
`requireEnv('OPENAI_API_KEY')` and refuses to start without it — reasonable there, since a bot process with no
model client has no reason to hold a Discord gateway connection open at all. `apps/api` is different:
`docs/RUNNING_LOCALLY.md` already promises "the API and the panel still come up" for a checkout missing
Discord credentials (`BOT_TOKEN` unset skips only the bot/worker), and this slice's own `routes/chat.ts`
addition must not quietly grow a second, undocumented way to fail that promise. `answerQuestion` already has a
defined, ordinary outcome for a model call that throws — `failed-with-apology` — so `apps/api/src/index.ts`'s
`createUnconfiguredModelClient` builds a `ModelClient` whose `ask()` always rejects (logging a warning once, at
startup) when `OPENAI_API_KEY` is unset, rather than refusing to boot: the panel, sign-in and every other
screen stay usable, and chat itself degrades to an apology exactly the way a real, configured key's own
transient provider failure already would. `apps/api/tests/routes/chat.test.ts`'s own "a model that rejects ...
apologizes rather than 500ing" proves the mechanism this relies on: `middleware/errors.ts` never sees the
rejection, because `routes/chat.ts` awaits `answerQuestion` itself, which already turned it into an ordinary
result.

**Choice — a question is bounded at 4,000 characters, not merely non-empty.** `postMessageInputSchema` shipped
as `z.string().min(1)`, bounded only by `express.json()`'s own 100 kB body limit — a reviewer measured a 99 kB
request reaching the model on a single call. CORE-3's own daily allowance counts *requests*, never tokens or
characters, so an unbounded `text` was no real spending bound at all: ten questions a day at ~$0.02 each
(Discord's own 2,000-character ceiling keeps a question small) became ten questions a day at up to ~$0.60 each
on the web — and COST-3's own spending cap is organization-wide, so one student asking one oversized question
on the web could exhaust a tenant's cap and decline every Discord student in the same organization alongside
them. `4000` matches Discord's own outer bound on a single message (`packages/discord/src/split.ts`'s own
`DISCORD_MESSAGE_LIMIT`, `2000`, is that file's *reply*-splitting threshold, not Discord's inbound ceiling —
Discord itself accepts up to 4,000 characters from a Nitro account) — this surface is bounded no more
generously than the one it mirrors, not picked arbitrarily.

**Rework finding — `GET .../chat/courses/:courseId/messages` was still a write.** Round two's own fix closed
the write on `GET .../chat/courses`, but the transcript route still called `conversations.getOrCreateConversation`
to *read* a transcript — measured, opening a course's chat for the first time (nothing asked yet) took
`conversations` from `0` to `1` rows on a plain `GET`. `middleware/origin.ts` exempts `GET` from the CSRF check
and states why: "a GET is not supposed to change anything in the first place" — a sentence this one route made
false. `packages/db/src/repos/conversations.ts` now splits the lookup from the insert:
`resolveConversationLookup` (private) resolves the course's own `conversationScope` and looks for an existing
conversation once; `findExistingConversation` (new, exported, read-only) is that lookup on its own, and
`getOrCreateConversation` — still the only function in this package that ever inserts a conversation — reuses
the same lookup rather than repeating it. `routes/chat.ts`'s GET handler calls `findExistingConversation` and
treats "no conversation yet" as an empty transcript (`{ messages: [] }`); the `POST` handler is the one place
that still calls `getOrCreateConversation`, and only when a question is actually being asked.
`apps/api/tests/routes/chat.test.ts` proves it by counting rows before and after a GET against a fresh course.

**Rework finding — LINK-9's own healing path: an account that signed up before this shipped never got a web
person at all, silently and permanently.** `createConnectedWebPerson` only ever ran on the account-*creation*
branches of `findOrCreateAccountForEmail`/`tryCreateAccountForEmail`. Reproduced against an account shaped
exactly like every already-deployed one — organization, account and membership, written directly, no person —
`chat_not_connected` on every future sign-in, forever, with nothing telling the account holder or an operator
why: an instructor who signed in the week before this deployed would be refused after it, a colleague who
signs up the day after would not, and the difference would look like a bug report nobody could reproduce.
`healWebPersonForReturningAccount` (`packages/auth/src/sign-in.ts`) closes it: called from every *returning*
sign-in (`redeemSignInLink`'s own "not `createdAccount`" branch, and `signInWithGoogle`'s own `link` branch),
inside the same transaction the caller already has, it finds the account's own personal organization —
`memberships.listMembershipsForAccount` and `organizations.getOrganizationById`, both widened from `Database`
to `Executor` for the same "called from inside another transaction" reason `createOrganization`'s and
`createPerson`'s own doc comments already give — and creates+connects a person there only if
`people.resolveIdentity` finds none, so a post-rework account (which already has one) pays one cheap indexed
read on every sign-in and does nothing further. `createConnectedWebPerson` itself was also tightened in the
same pass: it used to discard `connectIdentity`'s own return value, so a refusal there — unreachable today,
since the organization and person id are both freshly minted in the same transaction — would have left a
person with `connectedAt` still `null` and no identity at all, silently. It now throws instead, making that
unreachability structural rather than merely argued.

**For the record, so it is not re-litigated** — reachability cannot be closed inside this slice, and that is
correct, not merely deferred for lack of time. `people` are organization-scoped (TEN-2): a student enrolled in
a university's own organization needs a web person *in that organization*, but `sign-in.ts` (and its healing
path above) can only ever create one in the account's *own* personal organization — the one organization known
at sign-in time — and that student's roster enrolment belongs to a `discord`-surface person regardless, in the
university's organization, admitted by roster import or a Discord role, never by anything this slice touches.
Nothing unites the two records but LINK-3's own proof — the same connect step every other surface already
requires, merging the two through `people.ts#mergePeople` the identical way a Discord or MCP identity merges
into an existing person today. That proof, and the route that redeems it, is LINK-6..9 on the base branch —
the phase that actually makes web chat reachable for a student admitted anywhere other than their own personal
organization. `e2e/chat.spec.ts`'s own module comment says the same thing about what that spec does and does
not prove, for the same reason: an earlier version of that comment claimed the spec proved reachability
through a Discord role or a roster row, which it does not — it enrols the account's own web person directly,
the identical tautology `apps/api/tests/routes/chat.test.ts`'s own `connectCallerTo` helper exists to escape.

## D-38 — `apps/web`: one modal primitive for alert/confirm/prompt, and the focus-restoration bug only a real browser caught

**Problem.** WEB-15 requires every destructive action to confirm before it runs; WEB-16's unsaved-changes
guard needs the identical confirmation shape. Built per screen, this is either `window.confirm` (no styling,
no destructive/primary distinction, fails WEB-15 outright) or a bespoke dialog component copied per screen —
exactly the "second copy of the modal markup" duplication that makes a later refinement a sweep instead of an
edit, the same reasoning `style.css`'s own `@theme` block already gives for design tokens (D-37).

**Choice — one `<Modal>` component, three modes, reached through `useModal()`.** `components/modal/Modal.tsx`
renders alert/confirm/prompt from one markup, chosen by a `kind` prop; `components/modal/ModalProvider.tsx`
mounts exactly one `<Modal>` for the whole app (`main.tsx`) and exposes `alert()`/`confirm()`/`prompt()` as
promises — a caller writes `const ok = await confirm({...})` rather than wiring `open`/`onConfirm`/`onCancel`
state into every screen. `InstallButton.tsx`'s own former `ConfirmDialog.tsx` (this slice's own earlier,
bespoke dialog, written before the coordinator's explicit "standardize modals" instruction arrived
mid-slice) was deleted and rewired onto this primitive rather than kept alongside it.

**Choice — built on the native `<dialog>` element, not a hand-rolled overlay.** `showModal()` already traps
focus, makes the rest of the page inert to interaction and assistive technology, and (when closed via its own
`close()`) restores focus to whatever triggered it — WEB-17's own three requirements, for free, without this
component reimplementing any of them and risking a subtly wrong trap. `Modal.tsx` still chooses *which*
control gets initial focus deliberately (a prompt focuses its own field; a destructive confirm focuses Cancel,
never the destructive button — the coordinator's own explicit instruction, since a stray `Enter` the instant
the dialog opens must never run the destructive action).

**Rework finding — unmounting the dialog on close skipped the browser's own focus-restoration algorithm
entirely, and only `e2e/keyboard.spec.ts` (a real browser) caught it.** `ModalProvider` originally rendered
`{current && <Modal open .../>}` — clearing `current` on Cancel/Confirm/`Escape` *unmounted* the `<dialog>`
element outright rather than calling its native `close()` first. Focus restoration is `close()`'s own job;
ripping the element out of the DOM without ever calling it means the browser has no dialog left to restore
focus *from*, and focus simply falls back to `<body>`. `apps/web/tests/setup.ts`'s own jsdom polyfill (jsdom
does not implement `showModal`/`close` at all) only simulates the `open` attribute toggling — it cannot
reproduce native focus-restoration, so every one of this component's own unit tests (`tests/modal.test.tsx`)
stayed green through this bug. The fix: `ModalProvider` now keeps a `renderedRequest` — the *last* request's
own content, set once and never cleared — and renders `<Modal>` unconditionally once any request has ever
been shown, toggling only its `open` prop (`current !== undefined`). `Modal.tsx`'s own effect is the *only*
place that ever calls the native `close()` now (its own `<dialog onClose>` handler, which used to double as a
second, redundant path to the same `onCancel` callback, was removed — a native `close` event now fires at
most once per settle, from this one call site, rather than twice). This is exactly the case WEB-17's own text
warns about: "a keyboard test that clicks is not a keyboard test" — a `fireEvent.click` in jsdom cannot
distinguish "the dialog closed" from "the dialog closed *and restored focus correctly*"; only a real browser,
driven by real keys, can.

**What a caller supplies.** `alert({ title, description?, confirmLabel? })` resolves once acknowledged.
`confirm({ title, description?, confirmLabel?, cancelLabel?, destructive? })` resolves `true`/`false`, never
rejects — a caller never needs a `.catch` just to handle "backed out." `prompt({ title, label, placeholder?,
initialValue?, validate? })` resolves the typed value or `undefined`; `validate` returns an error string to
keep the dialog open with that message shown, or `undefined` to let it close. A second call while one is
already open queues behind it (`queueRef`) rather than clobbering the first caller's own pending promise.

## D-39 — `apps/web`: unsaved-changes guard — what "dirty" means, cross-component navigation, and why `beforeunload` is the one case `Modal.tsx` cannot cover

**Problem.** The coordinator's own instruction, mid-slice: forms must confirm before an unsaved edit is lost
— Cancel on the form, in-app navigation started elsewhere (the hamburger menu, a nav link, the home icon,
browser Back), and leaving the page entirely — reusing the modal primitive (D-38), not a second
implementation, and never firing on a form nobody touched.

**Choice — "dirty" is a value comparison against a baseline, not a keystroke count.** `hooks/useFormDirty.ts`
takes `baseline`/`current` and compares them (`JSON.stringify`, since every caller builds both from the same
object shape via the same code path, so key order never differs between them — a plain-object form's state is
exactly what that comparison assumes). A value typed and then reverted compares equal again; nothing here
remembers that a keystroke ever happened. `pages/CourseEditor.tsx` keeps a `baseline` state alongside `form`,
updated in the same three places `form` is ever set *from* a real record rather than an edit (a fresh blank
form, a load, a save) — never on a field-by-field change — so a successful save clears the dirty state the
same way it already resets `form` itself.

**Choice — a `NavigationGuardProvider`, so a navigation started outside the dirty form can still ask it
first.** `hooks/navigation-guard.tsx` is a small context: a dirty form calls `registerGuard(fn)` (and
`registerGuard(null)` once clean or unmounted); anything that navigates within the shell calls
`guardedNavigate(action)`, which runs `action` immediately if nothing is registered, or after the registered
guard resolves `true`. `pages/Shell.tsx` wraps every navigation callback it hands to `AppShell`/
`OrganizationSwitcher` (the nav row, the home control, and the organization switcher — cheap to include and
in the same spirit as the coordinator's own explicit list, even though not named verbatim there) in
`guardedNavigate`, without needing to know anything about whatever nested page might currently be a dirty
form — `pages/CourseEditor.tsx` is the one example today, reachable through `ProjectsPanel`/`Courses`, several
components below `Shell.tsx` itself. `useUnsavedChangesGuard(isDirty)` is what a form actually calls: it
registers/unregisters with the guard above, and exposes `confirmDiscard()` — the exact same check and the
exact same dialog wording — for the form's *own* Cancel control to call directly, so "a navigation that starts
outside the form" and "the form's own exit" are one confirmation, reachable two ways, not two dialogs with
possibly-different wording.

**Why `beforeunload` is the one case this app's own `Modal.tsx` cannot cover, and is registered only while
dirty.** The moment `beforeunload` fires, the page is already tearing down — no React state update, no dialog
render, no `await` can happen before the browser proceeds, so the shared modal primitive (D-38) is
structurally unable to render anything for this case. The only lever a `beforeunload` handler has is
`event.preventDefault()`, which asks the *browser's own* native prompt to appear instead — worded by the
browser, not this app, and not stylable to match WEB-11's design system. `useUnsavedChangesGuard` registers
this handler only inside an effect gated on `isDirty`, and the cleanup removes it the instant the form becomes
clean again — leaving it registered unconditionally would fire the browser's own prompt when leaving an
untouched form, training a person to click through it without reading it (WEB-16's own "a clean form leaves
with no prompt").

**Limits.** Switching organizations via `OrganizationSwitcher` is guarded the same way nav/home are, but this
slice did not add a guard around the browser's own back/forward navigation as a *distinct* case: `apps/web`
has no client-side router (`App.tsx`'s own module comment — three screens, `window.location.pathname` read
directly, no history entries pushed for in-panel navigation), so pressing Back from inside the panel is
already a full page unload, covered by the same `beforeunload` handler as "leaving the page entirely" rather
than a separate in-app case to intercept.

---

## D-48 — `packages/db`/`packages/actions`/`apps/worker`/`apps/api`/`apps/web`: reading a transcript is audited where the read happens, PPL-5 applied to a read versus an export, and the deliberate operation that deletes a tenant

**Problem.** ADMIN-1..5 is the last phase: an instructor reads a course's transcript in the panel, filtered by
student and by date; every read is written to an audit trail; export runs as a job and produces a file; a
platform administrator sees organizations, usage and health — and no route into a tenant's transcripts; and
deleting a tenant's data is a separate, explicit, confirmed, audited operation from TEN-6's "removal preserves
data". None of the five is free of a question the SPEC states as a conclusion ("the recording should live
where the read happens", "no route into a tenant's transcripts") without settling how — the same shape D-33's
own opening paragraph already describes for COST-1..6.

**Choice — the audit write lives inside the one function that actually reads a transcript back, not inside
either of its callers.** `@bloombot/db`'s `repos/transcript-access.ts#readCourseTranscript` is the single
function that queries `messages` for a transcript read or export; it writes the `transcript_access_log` row in
the same `db.transaction(...)` as the `SELECT`, before returning. `@bloombot/actions`' `transcripts.read`
(ADMIN-1, the panel's own screen) and `apps/worker`'s `handlers/transcripts.ts` job handler (ADMIN-3, the
export) both call this one function to get the messages they show or write to a file — neither queries
`messages` itself, and neither could disclose a transcript's contents without the read being recorded. This is
what ADMIN-2's own text asks for literally: "the recording should live where the read happens, not in the one
screen that happens to call it today" — a *third* caller added later (an MCP tool reading a transcript back,
say) is audited for free, not by remembering to add a call to a separate "log it" step. The alternative
considered and rejected — logging from inside each of the two actions' own `execute` — would have left a
future third caller with nothing enforcing it wrote one at all, exactly the gap the requirement's own wording
warns against.

**Choice — PPL-5 gates `transcripts.export` when it names one student, and does not gate `transcripts.read` at
all.** `people.ts#hasVerifiedAddress` (PPL-5, built ahead of its own caller in the LINK-1..5 slice, D-35) checks
whether the *person the disclosure is about* has proven an institutional email, not merely a Discord snowflake
or an MCP token — D-35's own rework finding 4 is explicit that "a person connected only through Discord ...
read `true`" was the defect that function exists to close. Two readings of "who this gate protects" were
weighed:

- Gating an *instructor's* ordinary, audited, on-screen read (ADMIN-1) on whether the *student* has ever linked
  a web account would make CONV-2's own retention guarantee hollow for the ordinary case — a course that only
  ever meets students through Discord, where no student ever holds a `web` identity at all — turning "a record
  an instructor may be required to retain" into one they can never actually look at. The instructor's own
  identity is already proven by their signed-in account (AUTH-1/AUTH-2, a verified email by construction), and
  their authority to read this course's transcript comes from their membership role (ENRL-5) — a completely
  different, already-adequate axis than PPL-5's own "which account is speaking, versus what may be shown". Not
  gating the read is what keeps ADMIN-1 usable for the deployment shape this platform is actually built for.
- Export is different in kind: it produces a portable file, addressed to one named student when `personId` is
  given, that leaves the panel's own access-controlled screen and audit boundary entirely — literally "exporting
  a person's history", PPL-5's own words. `transcripts.export`'s policy refuses (ACT-3-shaped, before a
  `transcript_exports` row is even created) unless `hasVerifiedAddress` is `true` for a student-filtered export;
  an unfiltered, whole-course export (transcripts and usage together, ADMIN-3's own text) names no single
  person's history to gate on and is not refused this way.

**Choice — `deleteOrganizationData` is a plain function in `organizations.ts`, not `dispatch.ts`, reached only
through `apps/api`'s own `/admin` router.** The same class of exception D-33 already gives
`listOrganizationTotals`/`checkPlatformHealth`: a platform administrator's own read (or, here, write) is not
"acting within" one organization the way `DispatchContext.organizationId` assumes every dispatched action is —
an administrator need hold no membership in the tenant being deleted at all (ADMIN-4's own "not a master key"
means membership is not what authorizes this, `AUTH-4`'s allowlist, re-checked on every request, is). Every
organization-scoped table is emptied in one transaction, children before the parents they reference
(`foreign_keys = ON` on every connection, `client.ts`) — `people.mergedIntoPersonId` is nulled out first,
breaking the self-reference before any `people` row is deleted, the one ordering surprise a naive per-table
loop would miss. `accounts`/`sessions`/`sign_in_tokens` are untouched: an account is not scoped to one
organization (TEN-1), so deleting a tenant removes only `memberships`, the join. `tests/conversations.ts`'s own
TEN-6 guard ("no repo source deletes a message or a conversation, anywhere in this package") now names
`organizations.ts` as its one explicit, recorded exception — the same "an exception only if its reason is
recorded in the same test" discipline ACT-5 already holds itself to.

**Choice — the confirmation is enforced server-side, and reads the same preview an administrator saw.**
`routes/admin.ts`'s own delete route re-checks `confirmName === organization.name` itself, before touching
anything — never trusted to the panel's own modal alone. This project's own history has the failure mode this
guards against by name (a destructive confirmation that only *looks* enforced), so the route's own test
(`apps/api/tests/routes/admin.test.ts`) proves a mismatched name refuses with `409` and deletes nothing, not
merely that the panel disables a button.

### Rework — a real browser caught a path collision no unit test could

Playwright's own `e2e/admin-console.spec.ts` (this slice's own extension of the e2e suite, per its brief) failed
on `GET /admin`'s deep link the first time it ran, though every unit and integration test — including
`apps/api/tests/routes/admin.test.ts` and `apps/web`'s own component tests for `pages/Admin.tsx` — was green.
The panel's own client-side page path and `apps/api`'s own `routes/admin.ts` mount were both `/admin`: a
browser navigation to that path needs `index.html` served back (a page, handled client-side by `App.tsx`), but
`fetch('/admin/organizations')` from inside that same page needs the request proxied to `apps/api` instead
(`vite.config.ts`'s own `preview.proxy`, mirroring nginx's job in production, PLAT-4) — one path, two
irreconcilable meanings, invisible to any test that mocks `api/client.ts` (every unit test in this slice does)
rather than actually resolving the URL through a real dev/preview server. Fixed by renaming the *panel's* own
page path to `/platform-admin`, leaving `apps/api`'s own `/admin` mount untouched — the same "a page path and
the API path it posts to are never the same top-level segment" convention `/sign-in/:token` (a page) and
`/auth/redeem` (the API route it posts to) already established, just not yet written down as a rule anywhere
before this. `vite.config.ts`'s own `proxy` object gained a comment naming the convention explicitly, so the
next screen that needs a bespoke (non-`dispatchAction`) API mount does not rediscover this the same way.

**Limits.** `previewOrganizationDeletion` is not exhaustive over every table `deleteOrganizationData` empties
(`cost_ledger_entries`, `person_identities`, `person_link_challenges`, `discord_install_states` have no count
in the preview) — deliberately: it is a confirmation a person reads and acts on, not a schema dump, and the
categories it names are the ones a person recognizes losing. A course attachment's or a transcript export's own
bytes on disk are removed best-effort, *after* the database transaction that is the authoritative "this tenant
is deleted" — `routes/admin.ts` gathers their ids before the delete and calls `AttachmentStorage#remove` for
each afterward, logging rather than failing the request on an individual removal error, since nothing left in
the database references an id it could not clean up. `apps/worker`'s export handler produces JSON, not CSV —
this slice's own judgment call, not a requirement: nothing in ADMIN-3's text names a format, and a hand-rolled
CSV writer's own escaping rules are exactly the kind of complexity `roster.ts`'s own module comment already
warns a slice away from adding without a reason this one does not have. Production nginx's own config (outside
this slice — `docs/DEPLOY_APP_PLATFORM.md`/`docs/DEPLOY_DROPLET.md`, another agent's branch) will need `/admin`
proxied to `apps/api` alongside `/auth`/`/organizations`/`/health`, the same way `vite.config.ts`'s own
`preview.proxy` now is.

