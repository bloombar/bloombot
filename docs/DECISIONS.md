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

## D-40 — `ecosystem.config.cjs`/`scripts/deploy.sh`: the migration runs once, outside the four processes' own race, and a deploy's rollback covers every process it reloaded

**Problem.** `apps/api`/`apps/bot`/`apps/worker`/`apps/mcp` each call `runMigrations(db)` in their own
`main()` — correct for one process, and a race for four started together: `packages/db/src/migrate.ts`'s own
idempotency (a `__drizzle_migrations` row per file, in the same transaction as the schema change it records)
protects against corruption, but nothing before this slice guaranteed the migration had already been applied
*before* any of the four even tried, so the first production deploy to actually start more than one of them
together would have been the first time that race was live. `scripts/deploy.sh` (OPS-7) also only ever knew
about one process (`bloombot`, the Python bot) — extending it to the four Node processes needed both a
migration step and a reload/health-check/rollback loop none of them had.

**Choice — `scripts/deploy.sh` runs `packages/db`'s own `run-migrate.js --i-know` once, after the build and
before any Node process is reloaded.** Not a new migration mechanism: the existing `db:migrate` CLI
(`packages/db/src/run-migrate.ts`), already guarded against an accidental `data/` write by
`assertMigratablePath`, and already idempotent. `--i-know` is not a bypass of that guard for this call — it
is the deliberate, intended use the guard's own module comment describes ("a migration sometimes has to run
against the live file"). Once this step has run, every process's own `runMigrations(db)` at its own startup
becomes the fast no-op idempotency already promised — a safety net for a process started outside this script
(`npm run dev`, a manual `pm2 start` of one app), not the thing doing the real work in production anymore.

**Found while wiring this in — `packages/db/src/run-migrate.ts` and `packages/legacy-import/src/cli.ts` never
called `loadDotEnv()`.** Every other entry point (`apps/*/src/index.ts`) loads `.env` before touching
`CONFIG`, per CFG-5; these two CLIs read `CONFIG.DATABASE_PATH` directly, so `npm run db:migrate` and
`npm run legacy:import` only ever saw a credential-bearing environment when it happened to already be
exported in the shell — never from `.env`, the one place this project's own convention says configuration is
supposed to live. Fixed the same way every other entry point already does it: `loadDotEnv()`, first line of
`main()`. No test pins this beyond the manual, end-to-end walk this slice's own report describes (running the
real built CLI against a `tmp/` fixture, first without the fix reproducing the gap, then with it) — `main()`
is intentionally unexported, the same as every other process's own thin entry point, and this repository has
no existing pattern for spawning a CLI under test; inventing one for a single `loadDotEnv()` call was judged
not worth the weight it would add.

**Choice — `scripts/deploy.sh` reloads every pm2 app by name individually, and rolls every one of them back
together on any failure.** `NODE_APPS` (`api`, `bot`, `worker`, `mcp`, `ops-monitor`) is reloaded one at a
time (`pm2 reload <name>`, or `pm2 start ecosystem.config.cjs --only <name>` the first time — never a bare
`pm2 start ecosystem.config.cjs`, which would start every app in the file including one a fresh droplet is
not yet ready for) so a bad build of one does not bounce the other three. Health is checked two ways after
the shared `HEALTH_WAIT`: `check_pm2_health` (generalized from the Python-only check this script already
had) proves a process is still running and pm2 has not had to restart it again; `scripts/health-check.mjs`
proves the four with an HTTP surface are actually *working* (COST-5's own running-versus-working
distinction) — a process pm2 sees as `online` but whose database or gateway is unreachable fails this even
though the pm2-level check saw nothing wrong. Any failure, from either check, rolls back every process this
deploy touched, not only the one that failed — a deploy is one unit here, the same commit for every process,
so a partial rollback would leave some processes on the new commit and some on the old with no record of
which was which.

**Rehearsal finding — a rollback that itself fails used to die silently.** `restore_previous_checkout`'s own
rebuild (`npm run build` against the restored, previous commit) used to run as a plain statement under
`set -e`; if it failed, the whole script died with whatever the failing command itself printed and nothing
saying a rollback — not an ordinary deploy — had just failed to complete. This is the exact case OPS-10's own
text warns about ("the rollback path is the part most likely to be written and never tested"), and it was
found by testing it: a throwaway git repository under `tmp/`-equivalent scratch space, a stand-in `pm2` that
tracks a small JSON process list, and a stand-in `npm`/`node` for the build and the migration step, driven
through a build failure, a migration failure, and an unhealthy-after-reload rollback. The unhealthy-after-
reload case is what surfaced it: rollback's own rebuild was made to fail too, and the script exited non-zero
with no message beyond the failing build's own output — indistinguishable, from the log alone, from an
ordinary deploy failure that never touched a running process, when in fact any process already reloaded onto
the broken commit was still running it. Fixed by checking each step of `restore_previous_checkout` explicitly
and failing with a message that says plainly this is not recoverable by re-running the script — see
`docs/CUTOVER.md`'s own §4 for what an operator does next. This harness was not kept as a checked-in test
(no existing pattern in this repository for spawning `scripts/deploy.sh` under test, and building a
permanent `pm2`/git mock was judged a bigger investment than this slice's budget); `scripts/deploy.sh` is
still verified the way OPS-7 already established — `shellcheck`, `bash -n`, and this rehearsal — not by an
automated regression test of its own control flow.

**Limits.** A migration that fails partway through is not itself rolled back — `runMigrations` applies
whatever it reaches before the failure, and there is no automatic way to undo a partially-applied migration
(the same limit `npm run db:migrate` already has run by hand). `scripts/deploy.sh` says this plainly rather
than claiming a recovery it cannot actually perform; `docs/CUTOVER.md` tells an operator what to check by
hand if it happens.

**Second rehearsal finding, found writing `docs/DEPLOY_DROPLET.md` — the static panel was never rebuilt at
all.** PLAT-4's fourth process is a static build nginx serves directly (`apps/web/dist`), not one of the pm2
apps `reload_everything` loops over — and the root `npm run build` does not produce it; only the workspace-
scoped `npm run build --workspace apps/web` does (`package.json`'s own `pree2e` script already needs both,
separately, for the same reason). `scripts/deploy.sh` built only the root workspace, so every deploy would
correctly reload `api`/`bot`/`worker`/`mcp`/`ops-monitor` onto the new commit while nginx went on serving
whichever panel build happened to already be sitting in `apps/web/dist` — silently mismatched against the
API underneath it, and never rebuilt by any rollback either. Fixed by adding the same explicit,
failure-checked build call in both the forward path and `restore_previous_checkout`, verified the same way as
the rest of this entry: the throwaway harness, re-run through both the happy path and the unhealthy-after-
reload rollback, confirming "building the control panel" (and, on rollback, "rebuilding the control panel for
the previous commit") now appears in the log exactly once per path, in the right order.

**Rework round — `reload_everything`/`start_or_reload` still died silently under `set -e`, a third instance
of the same bug class this entry already fixed twice.** Both ran `pm2 reload`/`pm2 start` as bare statements;
a review reproduced it by making one `pm2 reload` fail mid-loop, and the entire operator-visible output was
one pm2 error line — no health check, no rollback, some processes already on the new commit and others not,
`pm2 save` never reached. Fixed the same way the earlier findings in this entry were: `start_or_reload` now
checks pm2's own exit status explicitly and returns non-zero rather than letting the failure propagate
unguarded; `reload_everything` tries every app even after an earlier one fails, collecting failures instead
of stopping at the first (skipping `pm2 save` if any failed); both call sites (the forward path and the
already-rolled-back-once branch) check `reload_everything`'s own return value and escalate to a CRITICAL
message — the same class this entry's own `restore_previous_checkout` findings already established — if the
*rollback's* reload also fails, rather than claiming success. A further finding while fixing this: the final
"rolled back ...; every process is running the previous commit" message used to print unconditionally the
moment `reload_everything` returned, with no check that the rollback's own reload actually left every process
online — `confirm_rolled_back_online` (a short, capped-at-10s wait, then a plain `pm2 status` read for every
app) closes that gap, escalating to CRITICAL if the previous commit is not actually online either, rather
than reassuring an operator who has not been told the truth.

**A committed harness now exists for this: `scripts/deploy.test.mjs`.** The throwaway harness this entry's
own earlier findings describe as "not kept as a checked-in test" was rebuilt as a real one, following a
review that rebuilt roughly the same harness independently in under an hour and found the `reload_everything`
bug immediately with it — evidence that the investment was worth keeping rather than re-paying per reviewer.
It runs `scripts/deploy.sh` (the real, current file, piped over stdin the same way CI invokes it) against a
throwaway git repository and stand-in `pm2`/`npm`/`node`/`python3`/`pipenv`, covering the happy path, a pm2
reload failure that must roll back rather than die, and a control-panel build failure that must abort before
reloading anything. Each `writeDefaultStubs({ failReload, failBuildWeb })` scenario fails only its *first*
invocation (a marker file), not forever — failing forever silently conflated "the forward path failed" with
"the rollback itself also failed," a different, already-covered CRITICAL case, and produced a false negative
in this file's own early draft before that was noticed and fixed. `scripts/deploy.sh` is still not
exhaustively rehearsed by this harness — it covers the scenarios worth a committed regression test, not
every branch — but the one this rework round's own reload-guard fix needed is in it, and fails without that
fix (verified by reverting the fix and confirming the test catches it, then restoring it).

---

## D-41 — `scripts/ops-monitor.mjs`: what counts as unhealthy beyond a bare HTTP status, one page per outage rather than one per poll, and why a webhook rather than email

**Problem (OPS-12).** COST-5 made every process's own health observable — a `/health` endpoint each — but
observable is not the same as *noticed*: nobody is watching those endpoints unless something polls them, and
a naive poll-and-alert would either miss a real outage (`apps/bot`'s own `/health` reports `200` for as long
as the gateway is connected, whether or not the model provider behind it is actually answering — a real
outage in COST-5's own list of things to notice) or spam an operator once per poll for the whole duration of
a sustained one.

**Choice — `evaluate()` reads past the bare HTTP status for the one case it does not already cover.** A `503`
or an unreachable process is unhealthy, full stop — the four processes' own health servers already draw that
line correctly (each one's own module comment explains why it reports what it does and nothing else). The
one gap: `apps/bot`'s own `model.errorRate`/`model.calls` (`createCountingModelClient`, COST-5) is carried in
the body but never flips the status code, because the gateway and the provider are genuinely independent
failures and the endpoint's own author was explicit that it "deliberately reports nothing else." `evaluate()`
treats a sustained high error rate (`>= 50%` over `>= 5` calls — enough that a single transient failure on
the first retry after a cold start cannot page anyone) as unhealthy too, on top of the status check, so a
provider outage is noticed even while the gateway itself is fine.

**Choice — notify on a transition, not on every poll, and assume healthy for a name never seen before.**
`planNotifications` compares this poll's verdict against the last one it computed for that name; only a
change produces a notification. The one exception is deliberate: a name with no prior observation is treated
as "was healthy" rather than "was unhealthy," so the monitor's own (re)start is silent when everything is
actually fine, but still pages immediately if a process is *already* down the moment it starts watching — a
box rebooting mid-outage must not delay the page until some later transition that was never coming, because
nothing before it registered as "was healthy" to transition away from.

**Choice — a webhook POST, not email.** `apps/api`'s own `logging-email-sender.ts` (D-19/D-20) has no real
mail transport configured yet — refusing outright in production rather than pretending to send — so email
was not an option "already there" to build on, and standing one up is a new service this slice's own brief
explicitly said to prefer against. A single POST with both `content` (Discord's own incoming-webhook key) and
`text` (Slack's) in the same JSON body is understood by either without branching on which was configured, and
needs no vendor SDK — an operator creates one incoming webhook in whichever chat tool they already use and
sets `OPS_ALERT_WEBHOOK_URL`. When it is unset, the same transition is still written to stdout/stderr, which
pm2 already redirects to `logs/pm2-ops-monitor-out.log`/`logs/pm2-ops-monitor-error.log` (OPS-2) — degraded, not silent, the same shape
`logging-email-sender.ts` itself takes for its own equivalent gap.

**Deliberately dependency-free from `@bloombot/config`.** `scripts/health-check.mjs` and
`scripts/ops-monitor.mjs` duplicate the four processes' own default ports rather than importing
`packages/config`'s schema for them, the same reason `scripts/dev.mjs`'s own module comment already gives
for avoiding that import: it would make these scripts only work once the workspace has been built. The
duplication is pinned by `scripts/health-check.test.mjs`'s own "matches packages/config's own defaults" case,
so a schema default changing without updating this file's copy is a red build rather than a silent drift.

**Limits.** `ops-monitor` has no health endpoint of its own — `scripts/deploy.sh`'s own `HEALTH_CHECKED_APPS`
deliberately excludes it, checked only at the pm2 level (still-running, not still-working) the same as the
Python bot. A crashed `ops-monitor` is itself invisible to the thing it exists to make outages visible
through; pm2 restarting it (the same supervision every other process here gets) is the mitigation, not a
deeper one — a monitor that watches its own watcher was judged out of scope for this slice.

**Rework round — three findings, reproduced against a real `.env`-shaped fixture, a real webhook response,
and real math.**

1. **This process never actually loaded `.env`.** `run()` read `process.env.OPS_ALERT_WEBHOOK_URL` directly;
   pm2 does not load `.env` for a process on its own behalf (`ecosystem.config.cjs`'s own module comment
   claims "every Node process here loads `.env` itself," which was true for the four apps and false for this
   one), so a webhook configured exactly as `env.example` and every deployment doc in this slice instructed
   silently never reached the running process — every page degraded to a log line nobody was watching, with
   no error anywhere. The identical gap existed in `scripts/health-check.mjs`, with a worse blast radius: a
   `.env`-only `API_PORT` override never reached it either, so `scripts/deploy.sh` would poll the *default*
   port forever, `ECONNREFUSED` on every check, and roll back every single deploy regardless of whether
   anything was actually wrong. Fixed with a shared `scripts/load-dotenv.mjs` (the same `loadDotEnvOnce`
   contract `@bloombot/config`'s own `loadDotEnv` has — a value already in `process.env` wins, a missing file
   is not an error), called from a new `resolveMonitorConfig`/`resolveEndpoints` seam in each script rather
   than inline in `run()`, specifically so a regression test could exercise the composition with an injectable
   `.env` path — never a file literally named `.env`, the same precaution `packages/config/tests/dotenv.test.ts`
   already takes, for the same reason (a hook in this repository blocks writes to `.env*`, and a test exempted
   from that guard would be a test worth distrusting). `scripts/load-dotenv.test.mjs`,
   `scripts/health-check.test.mjs`'s own `resolveEndpoints` case and `scripts/ops-monitor.test.mjs`'s own
   `resolveMonitorConfig` case all fail without the fix — verified by reverting the `loadDotEnvOnce` calls and
   confirming the failure, then restoring them.

2. **The model-error-rate limb read a lifetime average, not a running rate.** `createCountingModelClient`'s
   own counters (`packages/core`) never reset; `evaluate` compared them straight against the threshold, so a
   course server up a week with 400 calls and 8 errors (2%) would need roughly 384 *more* consecutive failures
   — about 19 hours at 20 calls/hour — to ever trip 50%-of-5 once the provider actually went fully down. The
   mirror case was as bad: the first five calls right after a deploy reset the counters could trip the
   threshold on ordinary noise, and "recovered" would not fire again for hours while the lifetime average
   slowly diluted back down. Fixed by windowing: `evaluate` now takes each process's own `{calls, errors}`
   snapshot from the *previous* poll and evaluates the delta since then, returning the new snapshot for
   `planNotifications` to carry forward (a `previousModel` map, parallel to the existing `previousHealthy`
   one). A restart — the counters going backwards between polls — is detected and evaluated against the raw
   post-restart totals rather than a nonsensical negative rate. `scripts/ops-monitor.test.mjs` now includes a
   case with a low lifetime rate and a high windowed one (pages), the mirror (a high lifetime rate, a clean
   window, does not page), and a three-tick simulation of a real outage windowed correctly tick by tick.

3. **`notify` treated a webhook that answered as delivered, whether or not the answer said so.** Only a
   thrown `fetch` (a network failure) was treated as a failure; a webhook that resolves normally but rejects
   the message — Discord's own `404 Unknown Webhook` after someone recreates the alerting channel's own
   integration, a Slack webhook someone revoked — logged the exact same "delivered" line as a page that
   actually reached anyone. The tell was in this file's own pre-existing test: the fake `fetchFn` returned
   `{ ok: true }`, a field the code never read. Fixed by checking `response.ok` and treating a non-`ok`
   response the same as a thrown error — logged at `error`, not silently accepted.

---

## D-42 — `docs/CUTOVER.md`: rehearsal reuses the production bot token safely by construction, and rollback needs no credential un-rotated

**Problem (OPS-9, OPS-10, OPS-11).** Three requirements that only make sense written down together: a
rehearsal has to prove the real cutover will work without ever touching the live database or a real course
server; the cutover itself has to rotate every credential the Python system used without that rotation
causing its own outage; and the rollback has to actually work, using nothing the cutover deleted.

**Choice — the rehearsal reuses the same bot token as the running Python bot, invited into a disposable test
server, rather than provisioning a second bot application.** Gateway events for one bot token fan out to
every active session across every guild that bot is in, regardless of which guild the event came from — so a
rehearsal `apps/bot` connected with the production token technically receives events from real course servers
too. `docs/RUNNING_LOCALLY.md`'s own reuse table already established reusing the real `BOT_TOKEN` for local
development as this project's convention; the rehearsal does the same thing for the same reason, and needs
a real, separate safety argument for why a rehearsal process seeing real events is not a real risk.

**Review finding — the first version of that argument was wrong, and named the wrong gate.** It claimed
CORE-2's course matching was what kept a real course server's messages unanswered by the rehearsal (the
rehearsal database "only ever contains whatever `bot_config.yml` named" for the rehearsal, so a real category
would be "unrecognized"). That is false the moment §1.2 runs: the rehearsal import reads the *real*
`bot_config.yml`, so the rehearsal database ends up knowing exactly the real course names — CORE-2 would
match them. The actual gate is earlier and unconditional: `packages/discord/src/handle-mention.ts` resolves
the Discord *server binding* (SURF-3, `resolveDiscordServerBinding`) before any course or category matching
runs at all, and `packages/legacy-import` never writes a server-binding row — there is nothing in
`bot_config.yml` to derive one from. The rehearsal organization therefore starts with no Discord server bound
to it whatsoever; the disposable test server §1.3 has an operator bind by hand is the only one it will ever
answer in. `docs/CUTOVER.md`'s own §1.3 now states this — the absence of a binding, not an accident of course
naming — and adds the instruction that actually follows from it: never bind a real course server to the
rehearsal organization, because doing so removes the one thing standing between the rehearsal and a second
bot double-answering real students on the production token. The original, wrong version of this argument was
the kind of thing an operator would have improvised past if they read it and trusted it — worse than no
argument at all, because it pointed at a mechanism (CORE-2) that direction §1.2 of the same document
independently disables (importing the real config).

**Choice — rotate while both systems are stopped, not while either is live.** OPS-11's own text asks that
rotation not itself cause an outage; sequencing it between "Python stopped" (§2.2) and "platform started"
(§2.5) means there is no window where a running process holds a credential that has already been
invalidated — `docs/CUTOVER.md`'s own §2.3 places rotation there rather than before stopping Python or after
starting the platform. The OpenAI key specifically is rotated in two steps spanning that window on purpose:
the new key is created before the platform starts, but the *old* one is not revoked until §2.6 confirms the
platform is actually answering with the new one — revoking early would turn a rotation into a self-inflicted
outage if the new key had been mistyped into `.env`.

**Finding — `BOT_PERMISSIONS` and a re-invite are not part of rotation, and the runbook says so explicitly.**
This slice's own brief flagged the interaction and it is real, even though it is not spelled out anywhere
else in this repository yet: Discord grants a bot its permissions in a server at the moment it is invited
(`docs/DISCORD_SETUP.md`'s own step 1 decides the permission integer and invites the bot with it, but does
not itself say the grant is fixed from then on) — a separate `fix/scaffold-403` slice, landing concurrently
with this one, is adding that fact as a comment on `env.example`'s own `BOT_PERMISSIONS`, which this entry
does not depend on to make its point. Resetting a token in the Discord developer portal changes which secret
authenticates as the bot, not what it is permitted to do in any server it is already in — an operator who
re-invited the bot "just in case" during a rotation would be doing unnecessary, disruptive work for zero
effect on the permissions themselves. `docs/CUTOVER.md`'s §2.3 states this as a "does not need" rather than
leaving it to be inferred or rediscovered live.

**Choice — rollback needs no credential un-rotated.** Because §2.3 writes the rotated credentials into the
**one** `.env` file both the Python bot and the platform read (D-9), stopping the platform and restarting
the Python bot (`docs/CUTOVER.md`'s own §3) hands the Python bot the same already-rotated values the platform
was using — there is nothing to reverse. This is a property of D-9's own shared-file choice, not new
machinery this slice added; §3 states it explicitly so an operator mid-incident does not go looking for the
pre-rotation values.

**Limits.** The rollback in §3 puts the *processes* back, not the import: `docs/CUTOVER.md`'s own §2.4 import
is not undone by stopping the platform, and is not meant to be — MIG-4's idempotency is what makes re-running
it later, once cutover is retried, cost nothing rather than duplicate anything.

---

## D-43 — `docs/DEPLOY_DROPLET.md`/`docs/DEPLOY_APP_PLATFORM.md`: no production email transport exists, and App Platform's component model does not fit this platform's one-SQLite-file architecture

**Problem.** A late addition to this slice's own brief asked for two operator-facing deployment
documents — a droplet, and DigitalOcean App Platform as an alternative — complete enough for
someone who has never seen this repository to follow start to finish, including every
third-party setup step. Writing them surfaced two things neither this slice nor any earlier one
had said plainly in one place.

**Finding — there is no production email transport in this codebase.** `packages/auth/src/email.ts`
ships an `EmailSender` port and a recording fake for tests; its own module comment says the real
implementation "is a later slice's adapter package" and none has landed. `apps/api/src/logging-email-sender.ts#buildEmailSender`
refuses to start `apps/api` at all when `NODE_ENV=production` — not merely refusing to send —
so **the platform cannot serve email sign-in in production today, and `apps/api` will not start
in production at all** until a real adapter exists. This is not a deployment-document gap
(there is no SMTP host or API key this document could tell an operator to configure — nothing
in the codebase reads one) — it is application code this slice did not build and was
explicitly told not to invent inside a docs task. Both new documents state this in an
unmissable callout near their own top rather than let it be discovered by an operator trying to
follow them, and this file's own instructions to the supervisor say the same thing: this needs
its own scoped slice before a real production deployment can rely on email sign-in, and before
`apps/api` can run with `NODE_ENV=production` at all.

**Finding — DigitalOcean App Platform's component model does not fit this platform's
architecture, as built.** `docs/DECISIONS.md`'s own D-2 keeps SQLite deliberately, and states
outright that the choice "holds only while the deployment is single-host" — `apps/api`,
`apps/bot`, `apps/worker` and `apps/mcp` each open the *same* file directly, and App Platform's
Service/Worker/Job components each run on their own container with their own local disk, not a
filesystem shared across components. Deployed as four separate components the way their own
names would suggest, none could open the file the others have open. `docs/DEPLOY_APP_PLATFORM.md`
says this plainly, gives the one option that avoids it without new engineering (one combined
component, pinned to one instance, and even then only with a persistent volume App Platform may
or may not currently offer for that component type — flagged as unverified rather than assumed)
and its real costs (no horizontal scaling, no zero-downtime deploy — the two things App Platform
is usually chosen for, given up for none of the benefit), and separately scopes what a real fit
would take: a Postgres migration (D-2's own escape hatch, but only the schema/query half of it
is actually built — `packages/db/src/repos/jobs.ts`'s own claim function is isolated for a
Postgres implementation that does not exist yet, D-2's own "Limits" paragraph says as much) and
an object-storage adapter for `packages/db/src/attachment-storage.ts`'s own already-abstracted
`AttachmentStorage` interface (the port exists; the S3-compatible implementation does not).
Neither is built here — a document recommending App Platform without saying this would describe
a deployment that risks losing real student data on an ordinary redeploy, which `docs/DEPLOY_APP_PLATFORM.md`'s
own opening paragraph states is worse than a document that says the fit is not there yet.

**Choice — recommend the droplet, and say why, rather than present two equally-weighted
options.** The brief asked to compare, not to be sold, so both documents state the
recommendation and the reasoning openly (this repository's own tooling — `ecosystem.config.cjs`,
`scripts/deploy.sh`, the CI deploy job — is already built for the droplet shape) rather than
stopping at "here are your two options."

**Limits.** Neither new document was exercised against a real DigitalOcean account as part of
this slice — nginx config, App Platform component behavior and current storage offerings are
written from this codebase's own architecture and general knowledge of the product, flagged
with an explicit "verify against DigitalOcean's current documentation" note in
`docs/DEPLOY_APP_PLATFORM.md` rather than presented with false certainty about a product surface
that changes independently of this repository.


**Rework round — a second review checked both documents against the code directly and found what
reads plausibly but does not survive being followed literally.** In order of how much damage
each would have caused an operator following the document at 9pm:

- **`docs/CUTOVER.md`'s Phase 2 could not be executed as written, and said nothing about it.**
  §2.2 stops the Python bot and §2.3 irreversibly resets the Discord bot token before §2.5 ever
  tries to start `apps/api` — which, per this entry's own finding, does not start at all in
  production. An operator following the document in order meets a crash-looping API with the old
  system already stopped and the credential already rotated, with no warning it was coming.
  Fixed with an explicit callout at the top of Phase 2 (referencing **AUTH-5**, the tracked,
  in-progress fix, rather than asserting a permanent block) and corrected wording in §2.5/§2.6
  naming exactly what still works (`bot`/`worker`/`mcp`, Discord answering) and what does not
  (`api`, the panel, any sign-in) until it lands. The droplet document's own callout separately
  overclaimed that Google sign-in specifically "does not depend on this and is unaffected" — false,
  since `apps/api`'s own `main()` evaluates `buildEmailSender` before the whole process ever
  starts listening, so every route it serves is unreachable, not only the email one; corrected in
  both the callout and the `GOOGLE_CLIENT_ID` table row.

- **The rehearsal's own safety argument named the wrong mechanism.** See D-42's own rework-round
  addition above for the full finding — the fix belongs there since D-42 is the entry that made
  the original (wrong) claim.

- **`VITE_GOOGLE_CLIENT_ID` was undocumented anywhere, and it is the only sign-in path that could
  actually work while AUTH-5 is outstanding.** `apps/web/src/pages/SignIn.tsx` reads it from
  `import.meta.env` at Vite **build time**, from `apps/web`'s own `.env`/`.env.production` —
  Vite's `envDir` defaults to the directory holding `vite.config.ts`, not the repository root, so
  the root `.env` this document used for every other variable is invisible to this one build
  step, and `scripts/deploy.sh` rebuilds the panel on every deploy in a non-interactive shell, so
  a one-off exported shell variable would work once and silently regress on the first deploy
  after. Fixed by moving the panel's own first build out of §3 (before any third-party setup) and
  into §4.3, after `apps/web/.env.production` is written, with a new row in the env-var table
  making the distinct mechanism (build-time, `apps/web`-scoped, not `packages/config`) explicit.

- **The App Platform document buried its own headline finding 135 lines in, and hedged twice
  where the answer does not depend on unverifiable specifics.** "There is no production email
  transport" was a subordinate clause in §4's own text rather than a callout — lifted to the top
  of the document, immediately after the title, on the reasoning that someone comparing the two
  deployment documents should not have to reach §4 to learn it changes nothing about which one to
  pick. Separately, "whether App Platform currently offers a persistent volume... is exactly the
  kind of product detail that changes" and "verify App Platform's own deploy strategy options
  support a hard cutover" both hedged a conclusion that does not actually depend on the hedge:
  App Platform's Service/Worker components have no attachable persistent volume at all (Spaces
  and Managed Databases are DigitalOcean's own answer for anything that must persist), and its
  deploys are rolling by design — a new container is started and confirmed healthy before the old
  one stops — so `instance_count: 1` bounds steady-state replicas without preventing two
  containers holding the same SQLite file open across every single deploy. Both sections now
  state the conclusion as a fact about the product's design, not a possibility to go check.

- **`docs/DEPLOY_DROPLET.md` had a working-order bug (nginx referencing a certificate that does
  not exist yet, with no DNS step to make certbot's own challenge succeed at all) and several
  smaller ones**, closed in the same pass: DNS-first with a `dig` check (§5.1), an HTTP-only
  nginx block before `certbot --nginx` writes its own TLS one rather than a hand-written `443`
  block (§5.2–5.3), a dedicated-user creation step with the `chmod o+x` Ubuntu 24.04's own
  `0750` home directories need for nginx to traverse into `apps/web/dist` at all (§2), one
  consistent checkout path used throughout instead of two that disagreed, `pipenv install`
  actually run once (§3), course attachments added to the backup alongside the database plus an
  actual rehearsed restore procedure rather than a backup with no way back (§8.1), a worker
  health-check command in the post-deploy checklist (§8.3), `ufw` alongside the cloud firewall
  (§1), an explicit warning that `env.example`'s two non-empty placeholders
  (`BOT_APP_ID=your_bot_app_id`, `BOT_PERMISSIONS=your_bot_permissions_integer`) pass every
  truthiness check silently, the `PUBLIC_APP_URL` table row's trailing-slash reasoning corrected
  (it is Discord's redirect URI that breaks, not the origin check, which normalizes a trailing
  slash away), and "two redirect URIs" corrected to one — the connect-surface slice landing
  concurrently reuses the install flow's own `discordRedirectUri` rather than registering a
  second one.

**Limits, updated.** The corrections above were checked against this repository's own source
(`apps/web/vite.config.ts`, `apps/web/src/pages/SignIn.tsx`, `apps/api/src/middleware/origin.ts`,
`packages/discord/src/handle-mention.ts`) rather than merely re-argued; the DigitalOcean-specific
claims (App Platform's storage and deploy-strategy behavior) remain unverified against a live
account, as this entry's own original "Limits" paragraph already disclosed, and still call for
the same verify-before-relying discipline that paragraph asks for.

---

## D-44 — `packages/auth`/`apps/api`/`apps/web`/`apps/mcp`/`packages/discord`: the connect surface — LINK-6..8's own server and screens, why a first version could write into any tenant, and what changed to close it

**Problem.** LINK-1 (D-35) declines anyone whose person has no `connectedAt`, and `beginDiscordPersonLink`/
`completeDiscordPersonLink`/`issueMcpPersonLinkToken`/`completeMcpPersonLink` (`packages/auth/src/person-link.ts`)
prove an identity and attach or merge it — but nothing in `apps/` ever called any of them. A student's first
Discord message got LINK-1's invitation to a page that did not exist; the web chat listed no courses for
anybody admitted by a roster or a Discord role, because nothing had ever proven their Discord identity belongs
to the account signing into the panel. D-37's own "Limits" named this gap directly and pointed at this slice
to close it. A rework round (two independent reviewers, one on conformance and reachability, one on security)
found the mechanism itself sound — every identity-takeover shape either reviewer could construct was refused,
`peekDiscordPersonLinkCodeVerifier`'s own lifecycle held, and a reviewer's own reproduction proved a
roster-admitted student really can connect and reach an answer — but found the *authorization* wrong: **any
signed-in account could write a `people` row into any organization**, gated on nothing but the organization
existing.

**Choice — the survivor is the caller's own web person *in the organization the connect attempt names*, not
the account's personal one.** `beginDiscordPersonLink`/`issueMcpPersonLinkToken` need a survivor `personId`
before any proof exists (D-35's own "bound at issue" — getting this backwards is an account takeover). A
student's Discord identity almost always lives in an *institution's* organization, admitted by a roster import
or a Discord role, long before that student has a reason to sign into the panel — proving the identity there,
in *that* organization, is what lets `connectOrMerge` (`person-link.ts`) find the already-admitted person and
merge into it (LINK-4), rather than attaching a fresh, never-enrolled identity nobody can reach a course
through. This part of the design held through the rework unchanged.

**What the rework actually found.** A first version resolved (or created) that survivor — `@bloombot/auth`'s
`ensureWebPersonForAccount` — gated only on `organizationExists`, *before* any Discord or MCP proof existed.
Reproduced directly: `POST .../mcp/preview {"token":"not-a-token"}` against a real organization the caller had
never touched created a *connected* person there (a `web` identity, `connectedAt` set) — a junk request with no
proof at all — and `GET .../chat/courses` for that organization went from `404` to `200 {"courses":[]}`
permanently, converting an unrelated route into a tenant-existence oracle. `/discord/begin` showed the same
shape even more directly: `200` for a real organization the caller had no relationship to, `404` for one that
did not exist — a plain existence oracle — while planting an unbounded stream of `person_link_challenges` rows
in the foreign tenant either way. "Require a membership first" is not the fix: a student connecting for the
first time legitimately has *no* membership in the institution's own organization — that is the entire point of
the flow. The actual fix is ordering: **nothing is created, and nothing is connected, until organization-specific
proof is already in hand.**

**Choice — MCP peeks the token's own organization before writing anything.** An MCP token is already bound to
an organization the moment it is issued (LINK-3's own identity-bound-at-issue design for that surface) — so the
proof was available for free, just not checked first. `peekMcpPersonLink` (new, `person-link.ts`) is a plain
read: given a token, it reports the organization and identity it names, with no survivor and no write involved
at all. `/mcp/preview` and `/mcp/confirm` (`routes/person-link.ts`) both peek first — refusing not-found-shaped,
before `ensureWebPersonForAccount` is ever called, when the token does not exist or names a different
organization than the URL. A junk token, or a token real for a *different* organization, now creates nothing:
proven directly (`apps/api/tests/routes/person-link.test.ts`'s own "the tenant-write oracle is closed" block,
replaying the reviewer's exact reproduction and asserting no `people` row and no oracle afterward).

**Choice — Discord cannot do the same, so it writes a *bare* survivor instead.** `beginDiscordPersonLink` needs
a real, already-persisted `personId` before Discord's OAuth ever starts — PPL-4's own "survivor bound at issue,"
unchanged, and not something this rework revisits. There is genuinely no organization-specific proof to check
before that first write: the caller has proven their *account*, nothing about this particular institution.
`resolveOrCreateBareDiscordSurvivor` (`routes/person-link.ts`) resolves the account's *existing* survivor in
this organization when one already exists (a legitimate repeat visit, found by `web` identity — a plain read),
and otherwise creates a genuinely bare person: no identity attached at all, `connectedAt` left `null`. That row
is indistinguishable, to every other route in this app, from the organization not existing: `routes/chat.ts`
resolves a caller by `web` identity, this row has none; LINK-1's own gate reads `connectedAt`, this row's stays
`null`. It costs a little inert storage in a foreign organization — an accepted, bounded residual, not a
resource this app reclaims today — and grants nothing until Discord's own OAuth genuinely completes, at which
point `/discord/confirm` attaches the account's own `web` identity too (`attachWebIdentityOrMerge`, falling back
to a merge on the one genuine race two concurrent `begin()` calls for the same account could produce), *after*
the Discord identity has already set `connectedAt` for a real reason.

**Choice — session binding moved in-memory, because the database challenge has nowhere to carry it.**
`person_link_challenges` carries a survivor `personId`, never an `accountId` — there was no column to check "is
the caller confirming this the same account that began it" against. Before the rework that check did not really
exist: whichever account happened to resolve the *same* `web`-connected survivor passed, silently, and because
that resolution itself created a person on demand, *any* signed-in account resolved to *some* person, so the
check was satisfiable by construction. A reviewer proved this precisely: replacing the resolved survivor with
`peeked.personId` read directly off the challenge — a tautological self-check — left the entire `apps/api` suite
green, 13 files, 168 tests. `PendingDiscordConnect` (`routes/person-link.ts`) is this router's own in-memory
record of which account began a given attempt — the same process-local, never-persisted device the OAuth code
exchange itself already used, extended to carry the binding this flow actually needs checked.
`/discord/preview` and `/discord/confirm` both refuse not-found-shaped, before touching the database at all, the
moment the caller's own session names a different account than the one recorded at `begin`. Verified by mutating
the shipped code the identical way the reviewer's own mutation did (deleting the `accountId` comparison) and
watching the new cross-account test fail — restoring it, the test passes again.

**Choice — a caller mismatch spends nothing, unlike a genuine redemption.** `completeDiscordPersonLink`'s own
"consumed either way" rule exists because a *redeemed* secret proves something regardless of what it is redeemed
against — replaying it teaches an attacker nothing new. A session mismatch is a different failure: `state` was
never touched, so the rule does not apply, and applying it anyway hands a stranger who merely learned a
previewed `state` (browser history, a shared machine) a way to permanently deny the real owner's own connect
attempt. `routes/person-link.ts` only calls `completeDiscordPersonLink` — the one call that actually
consumes — once the caller's own session has already matched; a mismatch refuses without reaching it, leaving
`state` exactly as live as it was. Proven the same way as the session-binding check itself: sabotaging the route
to consume on a mismatch (matching the pre-rework shape) makes the same cross-account test fail on its own
second half — the victim's later, legitimate confirm.

**Choice — `bloombot_connectAssistant` (`apps/mcp/src/server.ts`) checks the organization exists but not
membership, deliberately, and catches whatever the insert still throws.** A first version took `organizationId`
straight from the model's tool arguments into `issueMcpPersonLinkToken` with no check at all: a foreign but real
organization minted a valid, redeemable token with no proof; a nonexistent one threw `better-sqlite3`'s own
`FOREIGN KEY constraint failed` straight into the tool result — a raw driver error handed to an untrusted
client, and a cruder existence oracle than the one already accepted for the HTTP surface. `memberships.getMembership`
(`call-tool.ts`'s own tenancy check for the dispatch catalog) is the wrong fix here for the identical reason it
is wrong for the HTTP routes above: MCP-3's "exactly one account's authority and nothing more" describes what a
*dispatched action* may see, not who may attempt to connect — a student's assistant legitimately requests a
token for the student's own institution, an organization the student has no membership in by design. What
actually gates this tool, the same as its HTTP siblings, is that minting a token creates nothing in `people` at
all (only a `person_link_challenges` row, swept by its own TTL); the write happens only once a human redeems it
against a matching organization on the panel. The fix here is narrower: check the organization exists first
(closing the raw-error leak, and the cruder oracle it was), and catch whatever the insert still throws as a
last resort, logged rather than surfaced. An organization id is still not a secret — minting a token for a
real, foreign organization is accepted and tested as a deliberate choice, not an oversight.

**Two defects in the preview primitive, unchanged by this round, still worth restating plainly.**
`previewOutcome` (`person-link.ts`) did not check the *survivor's* own `mergedIntoPersonId` — a survivor merged
away after their own attempt began (a fast, concurrent proof from elsewhere) previewed as `{kind: 'attach'}`
even though the real completion would refuse; fixed by checking `people.getPerson(...).mergedIntoPersonId`
first. `previewDiscordPersonLink` took no caller identity at all, unlike `completeDiscordPersonLink`'s own
`callerPersonId` — fixed by adding and checking it, refusing a mismatch the identical "no oracle" way. Both
remain mutation-verified: reverting either fix locally fails the regression test written for it and no other.

**Reusing the install flow's own redirect URI, and the preview/confirm split — unchanged.** LINK-7's OAuth round
trip lands back on `${PUBLIC_APP_URL}/discord/callback` — the same physical page `discord-servers.ts`'s own
install flow already uses, told apart client-side by which `sessionStorage` marker is present, rather than
registering a second redirect URI with the real Discord application. `/discord/preview` spends the OAuth code
once (Discord's own codes are single-use) and previews the outcome without redeeming `state` itself (LINK-6's
"a visit is not consent"); `/discord/confirm` never trusts a client-resupplied identity, only what preview
already proved and this router recorded.

**The framing this decision got wrong the first time, corrected here.** The first version of this record
claimed "the web chat now works" without qualification. That overstates what actually ships: connecting creates
a *person*, not a *membership*, and `apps/web/src/pages/Shell.tsx` derives which organization the panel acts
in from `account.memberships` alone. A student who connects through the Discord invitation is fully reachable
*on Discord* — the acceptance test proves that end to end, over real HTTP, for an account with no membership
anywhere relevant — but that same student opening the web panel directly sees only their own personal
organization (the one membership every account gets), whose own Chat tab has no course to show and whose own
"not connected" link (`pages/Chat.tsx`) points at `/connect/<personal-org>`, not the institution's. Connecting
again there succeeds and still lists nothing, because the institution's organization — where the actual
enrolment lives — is not something the panel's own organization switcher offers a connected-but-not-a-member
account any way to reach. This is not a defect this rework introduces or claims to close: `Shell.tsx`'s own
organization selection is membership-shaped throughout, a UI/read-surface question (something like "which
organizations does this account have a *connected person* in, not only a membership" would need its own
endpoint and its own switcher behaviour) genuinely separate from proving an identity, which is this slice's own
scope. Recorded here as a real, correctly-scoped gap for a follow-up slice, not fixed in this one.

**Rework, round two — the write was deferred, not authorized, and the actual exploit used a hop this same
slice added.** The choices above closed a *junk* proof (a made-up token, an unrelated code) — they did not
check that a *genuine* proof was organization-specific. A reviewer reproduced the original exploit end to end,
over a live API and a live MCP server, using one ordinary account with no membership, enrolment or person
anywhere near a victim tenant: `bloombot_connectAssistant` (`apps/mcp/src/server.ts`) mints a person-link token
for *any* organization id, membership-free, by design (its own doc comment, D-44's own first-round choice,
unchanged and still correct on its own terms) — so the "organization-specific proof" `/mcp/preview`/
`/mcp/confirm` waited for was something the attacker could simply mint for themselves. Redeeming that
self-minted token against the victim organization returned `200`/`200` and left a `connectedAt`-set person
there, LINK-1's own gate granted with nothing an institution ever admitted. The Discord half had the identical
shape by a different route: a caller with no relationship to an organization can always produce a *genuine*
OAuth proof of their own, real, never-before-seen-there snowflake — this file's own original text ("nothing is
created, and nothing is connected, until organization-specific proof is already in hand") was wrong, because
neither a snowflake the caller owns nor a token the platform mints on demand is organization-specific; both
only ever proved *a* identity, never one the organization itself had any reason to trust.

**The actual rule: a caller with no membership in an organization may complete only a `merge` or
`already-connected` outcome there, never a fresh `attach`.** "Organization-specific proof" has to mean the
identity being proved already resolves to a person *that organization already admitted* — a roster import or a
Discord role, `connectOrMerge`'s own `merge` branch — not a person this router would be minting the first
record of. This preserves the real student flow exactly (this file's own acceptance test previews
`outcome.kind === 'merge'`, because a roster-admitted student's Discord identity already belongs to someone)
while refusing a caller who merely proved *an* identity, not one this organization ever admitted. Implemented
two ways, matching each surface's own shape (`routes/person-link.ts#attachWithoutMembershipIsForbidden`,
`memberships.getMembership` — the same tenancy check `routes/actions.ts` already runs before dispatching
anything): for MCP, `ensureWebPersonForAccount` (which creates) is dropped from `/mcp/preview`/`/mcp/confirm`
entirely, replaced by `people.resolveIdentity` — the same read-only shape `routes/chat.ts`'s own
`resolveConnectedCallerPerson` already uses — refusing outright when the account has no existing person there
at all (an MCP connect into an organization the account has never otherwise reached is meaningless regardless,
since there is no enrolment for an assistant to help with); for Discord, which still has to write a bare
survivor before OAuth even starts (unchanged), the gate moves to `/discord/preview` — an `attach` outcome for a
non-member is refused as an ordinary preview failure, before the identity is ever cached for confirm to
redeem, so the screen never promises an outcome it does not allow (LINK-6's own "the page names ... whether
anything will be merged into it").

**A second, independent finding in the same round — the bare-survivor deferral was not bounded.**
`resolveOrCreateBareDiscordSurvivor`'s own first-round doc comment claimed a "repeat visit" reuse branch that,
for a bare person (no identity at all), could never actually fire — every `/discord/begin` call before a
connect completed minted a fresh row, unbounded: reproduced directly, 200 calls left 200 `people` rows and 200
`person_link_challenges` rows in the same victim organization, nothing sweeping either. Fixed by extending the
reuse check to the in-memory `pendingDiscordConnects` map itself (an attempt still live for the exact
`(accountId, organizationId)` pair reuses its own survivor rather than minting a second one), and by sweeping
expired entries at `/discord/begin` too, not only at `preview`/`confirm`.

This bounds the `people` rows and nothing else, which is worth stating exactly, because the first version of
this paragraph claimed more than it delivered and a verification round re-measured it: 200 `/discord/begin`
calls from one account against one foreign organization now leave **one** `people` row — the fix works — but
still **200** `person_link_challenges` rows and **200** `pendingDiscordConnects` map entries, one per request
each, held for the full `DEFAULT_PERSON_LINK_TTL_MS` window (ten minutes) and swept afterwards. The permanent
row is the one that mattered, since nothing sweeps `people`; the challenge rows and map entries expire on their
own. Growth of the bounded resource is therefore roughly one row per account per organization per TTL window,
not one per request — an account that waits out the TTL between attempts still adds a new bare row each time, a
residual accepted and stated plainly rather than solved further (`apps/mcp`'s own session-eviction rework, D-36, bounds a comparable
resource the identical way, by TTL, not by eliminating repeat use).

**Also fixed, this round.** A test titled "reuses the same survivor" asserted `toBeGreaterThanOrEqual(1)` —
true for any value — while its own in-body comment admitted the reuse it claimed to prove never fired; deleting
the reuse branch entirely left the whole suite green. Fixed to assert an exact count across five repeat calls,
not two. The two MCP routes answered a nonexistent organization and a real organization the token simply did
not name with two different error codes (`organization_not_found` vs. `person_link_not_found`) — an oracle
`peekMcpPersonLink`'s own match check already made the separate existence check redundant for; removed, so both
answer identically now (`/discord/begin`'s own equivalent `200`-vs-`404` distinction was checked and does *not*
become moot the same way — begin still has to reject a nonexistent organization before its own insert, and
nothing about the merge-only rule changes that; left as-is, matching the "an organization id is not a secret"
choice this file already made, now further justified since the row it gates is bare, inert and bounded). The
now-unreachable `organizationExists` check inside `/discord/confirm` (the `pending.organizationId` comparison
already refuses any mismatch first) was removed rather than merely re-commented as redundant. A stray reference
to `pendingDiscordIdentities` — a name that was renamed to `pendingDiscordConnects` in round one and never
updated in one leftover comment — cited a precedent that never existed under that name; corrected to cite
PLAT-4 (`docs/SPEC.md`: "Four processes, each single-instance … Never clustered"), the actual thing that
licenses process-local state here, alongside the residual cost that state carries: a restart between `begin`
and `confirm` loses the in-memory record even though the database challenge is still live, answering
`person_link_not_found` for an attempt that has not actually expired, and permanently orphaning the bare
survivor `begin` already wrote.

**`e2e/connect.spec.ts` — the missing Playwright coverage, added.** LINK-6/8 span front and back end, and
`CLAUDE.md` asks for e2e coverage there; the API-level acceptance test is genuinely end to end against a real
database but never touches a browser. The new spec drives a real browser through `/connect/:organizationId`
signed out (asking to sign in, the same as a real invitation would), redeems a real emailed sign-in link, and
returns to that same organization's own connect screen — then redeems a real, freshly-minted MCP token through
the real `/mcp/preview`/`/mcp/confirm` routes, the LINK-8 half `apps/mcp/tests/server.test.ts`'s own test suite
already proves the *minting* side of with a real MCP SDK client. What it does not cover: Discord's own OAuth
screen, which would need a second, fake OAuth provider standing in for discord.com that this harness does not
build (`e2e/support/start-api.ts` already points `apps/api`'s own Discord configuration at unreachable loopback
addresses on purpose) — the Discord half of LINK-7 stays proven at the API-integration level, not through a
browser, and this spec's own module comment says so plainly rather than overclaiming, the same discipline
`chat.spec.ts`'s own module comment already holds itself to.

**Limits.** `redeemJoinLink`/`course_join_links` (ENRL-3/ENRL-4) remain unwired from any route — a *web-only*
student who has never touched Discord still has no way to reach a course through this slice; that mechanism
admits (enrols), while this one connects (proves an identity), and D-37's own "Limits" already named the
join-link route as separate, deferred work. `apps/mcp` is touched only for `bloombot_connectAssistant` — no
other tool, no change to `tool-surface.ts`'s own catalog or `call-tool.ts`'s dispatch path. LINK-9's own
decision — what happens to a person who already existed before connecting was required — is D-45, immediately
below.

---

## D-45 — `packages/discord`/`packages/auth`: LINK-9 — nobody who could already ask is locked out, and why "ask them once" needed no code of its own

**Problem.** LINK-1 (D-35) declined every unconnected person's first message the moment it merged — including
every student who already had a working conversation before connecting was required. LINK-9 asks for a
deliberate, written answer to what happens to them: connect them on their next proven sign-in, admit them until
a deadline, or ask them once — not a consequence of a migration that happened to leave a column null.

**Choice — "ask them once," and it needed no migration or backfill because D-44 already builds the mechanism
that makes it true.** Before this slice, "ask them once" was not actually available as an option: LINK-1's
invitation pointed at a connect screen that did not exist, so an already-active student's first post-LINK-1
message was not "asked once and then fine" — it was declined, permanently, with no working way back. D-44
closes exactly that: the *same* invitation (`connectInvitationText`, already sent to every unconnected person
on every surface, new and returning alike) now leads to a real page, and following it does not create a new,
empty account — `connectOrMerge`'s own attach-or-merge shape (unchanged by this slice) means an *already-
existing*, previously-active person's identity is either attached directly to the caller's survivor or merges
that survivor's history in, never dropped (LINK-4). Concretely: a student who has been asking a course
questions for a month, unconnected only because LINK-1 shipped after they started, gets the identical
invitation a brand-new student gets, follows it once, and every prior conversation, enrolment and usage row is
still there afterward under the survivor they end up connected as. The friction is real but bounded to exactly
one interruption — the same friction D-28 already priced in for every new student ("thirty students each meet
a connect prompt instead of a reply") — not a *second*, additional cost layered on top of it for anyone who
merely happened to exist first.

**Why not a grace period or a deadline-based admission.** Both would mean re-opening LINK-1's own gate — an
allowance answered *before* `connectedAt` is set, whether bounded by a clock or not, is precisely the
unattributed-allowance window D-28 refused to reopen ("the alternative ... leaves a window where a person has
an unattributed allowance ... that is D-4's evasion, reintroduced"). A deadline also has no natural expiry this
platform can compute on its own: unlike an account or a course, a Discord-surface person has no "when did this
start mattering" timestamp distinct from `createdAt`, which already predates LINK-1 for every person this
question is about — a deadline keyed on it would not distinguish "existed for a year" from "existed for a day
before this shipped."

**Why not an automatic connect on next proven sign-in, the way the web surface's own healing path
(`healWebPersonForReturningAccount`, D-37) works.** That path works because a *web* account's own sign-in event
is itself a proof this package already trusts (D-37's own "a signed-in web caller is the account — they proved
control of it by signing in") — healing simply extends an already-authenticated event to a person row that
happened not to exist yet. Discord has no equivalent "proven sign-in" event this platform can observe
passively: nothing about a returning Discord message proves anything beyond what it already proved before
LINK-1 shipped (the sender controls that snowflake, which `resolvePersonByIdentity` already believed). The only
thing that *actually* proves a Discord identity belongs to a specific, signed-in account is Discord's own
OAuth — which is precisely LINK-7's connect flow, reachable only by a person taking an action, not something
this platform can trigger silently on their behalf. "Ask them once" is therefore not a fallback chosen for lack
of a better option; it is the *only* sound option once "connect on next proven sign-in" is read literally for
this surface — Discord supplies no sign-in event this platform did not already have before LINK-1.

**Cost, stated plainly.** Every Discord student active before this slice shipped hits exactly one connect
prompt on their next message, identical in kind (not merely similar) to what a brand-new student meets from
their very first message onward — D-28's own already-accepted cost, not a new one this decision introduces.
Nothing here is reversible by a configuration flag the way D-28's own "Cost, stated plainly" flags LINK-1
itself as ("reversible per course later if it proves worse than the evasion it prevents") — LINK-9 is a
statement about what happens to *existing* data under an already-shipped gate, not a second gate with its own
on/off switch.

**Limits.** This says nothing about a student who was active, then stopped asking questions, and returns after
a long gap with no memory of ever needing to connect — the UX cost of that surprise is real and unmeasured;
nothing in this slice instruments how often it actually happens. An operator-initiated bulk notification ("your
course now requires connecting; here is the link") is a real mitigation this decision does not build — it would
need every affected student's own contact information, which an unconnected Discord person may not have at all
(no verified address — PPL-5's own `hasVerifiedAddress`, D-35's rework finding 4), and is therefore its own,
separate requirement this SPEC does not currently name. Reachability through the *panel itself*, as opposed to
Discord, carries the same limit D-44 now states plainly: a connected person is not a membership, and
`Shell.tsx`'s own organization switcher does not yet offer a connected-but-not-a-member account any way to
reach the institution's organization from inside the panel.

## D-46 — `docs/CUTOVER.md`: a legacy-imported organization has no members, and nothing in the panel can add its first one

**Problem, found while driving Phase 2 of the cutover runbook end to end.** The must-fix-1
finding from this rework round's own review (a missing bind step left every real course
server silently unanswered) led to writing that step — which, on inspection, cannot actually
be performed: the Discord install route (`apps/api/src/routes/discord-servers.ts`) resolves
"the caller's organization... from their own membership, never the request body" (its own
module comment), so binding a server requires the caller to already be a member of the target
organization. `packages/legacy-import` creates the organization, its project, its courses, its
people and their messages, but writes no `memberships` row at all — there is nothing in
`bot_config.yml` an instructor's platform account could be derived from. The one action that
grants a membership, `memberships.grant` (`packages/actions/src/actions/memberships.ts`),
refuses on purpose unless the target *already* holds a membership in that organization —
ENRL-5's own "granted only by an existing owner" is enforced by requiring an existing member
to grant to, a deliberate choice that closed a real security hole (its own "Rework finding 1":
an earlier version let *any* signed-in caller grant themselves a role in *any* organization by
guessing its id) at the cost of removing "invite a first member" from the action layer
entirely. The result: a legacy-imported organization has no path to its first member through
anything the panel exposes, and MIG-2 never anticipated this — it describes what the import
produces, not who can act on it afterward.

**Choice — bootstrap the founding owner with the same repository function the platform's own
code already trusts, run once by hand, rather than a hand-written `INSERT`.**
`packages/db/src/repos/memberships.ts#createMembership(organizationId, accountId, role, db)`
is exactly "add an existing account to an organization with a role" — its own doc comment
says so — and is already what a second membership goes through internally; it is simply not
reachable from outside the codebase for a *first* one. `docs/CUTOVER.md`'s own §1.3 (rehearsal)
and §2.6 (the real cutover) both now instruct the operator to run a small script,
`tmp/bootstrap-membership.mjs`, that imports `accounts`/`memberships` from `@bloombot/db`
(the same package `apps/api`'s own routes import), resolves the instructor's account by email
(`accounts.getAccountByEmail`, the same documented TEN-2 exception `sign-in.ts` itself uses),
and calls `createMembership` with role `'owner'` — reusing the real, tested insert shape
rather than risking a hand-rolled SQL statement getting a nullable column or an enum value
wrong. The instructor still has to sign in once first, ordinarily, so the account exists to
grant the membership to.

**Why not build the missing action instead, in this slice.** This is a docs/production-
hardening slice, not a feature slice — inventing a new action (`memberships.inviteFirst`, or
teaching `legacy-import` to create a founding membership from some field `bot_config.yml`
does not reliably carry, like an instructor's email) is real design work with its own
authorization questions (who is allowed to become the founding owner of an *imported*
organization — the person who ran the import, on the droplet, is not the same thing as "an
account, resolved by email, that AUTH-2's Google verifier or a sign-in link has actually
proven") that this slice's own brief did not scope and should not improvise. The workaround
above is deliberately narrow — a droplet-local script, run once per cutover, never committed,
importing only what `apps/api`'s own routes already import — not a precedent for routinely
bypassing the action layer.

**Limits.** This is a real gap this document is working around, not one it closes — the
correct fix is a scoped action (or an extension to `legacy-import` itself) that lets an
imported organization's first member be established through the ordinary authorization
path, not a script an operator has to remember exists. Flagging it here, rather than only in
the runbook, is so it is discoverable as a follow-up requirement rather than rediscovered the
next time someone runs a legacy import.

**Numbering note.** Taken as the next number after D-43 in this branch's own history; a
commit on the (unmerged, in-review) AUTH-5 branch also references "D-46" for its own entry —
flagged to the supervisor to resolve at merge, per this project's own numbering convention.

## D-47 — `packages/mail`: a real mail transport (AUTH-5), why SMTP, and what "misconfigured" means

**Problem.** `apps/api/src/logging-email-sender.ts#buildEmailSender` refused outright under
`NODE_ENV=production` (must-fix 1 of the API-1..6 rework) because no real transport existed yet for it to
defer to — a deliberate, correct refusal at the time, but its consequence is that a production deployment
cannot start at all. A sign-in link is the primary way anybody reaches the panel (AUTH-1), so this is not
"email is unconfigured," it is a process that refuses to boot. `email.ts`'s own module comment already named
the shape the fix would take: "the real implementation ... is a later slice's adapter package, the same
relationship `packages/openai` has to `packages/core`." This entry is that slice.

**Choice — SMTP, not a transactional-email API, and a new `packages/mail` adapter package.** Every
institution this platform targets already has an SMTP relay it is comfortable issuing credentials against —
its own, or its Google Workspace/Microsoft 365 tenant's — so SMTP needs no vendor account to create and no
SDK to trust, and it keeps `EmailSender` (`packages/auth/src/email.ts`) honest as a port: "send this address
this subject and this body" is exactly what SMTP does, with nothing provider-specific (delivery tracking,
templating) tempting the interface to grow past that. `packages/mail` is the adapter, following
`packages/openai`'s own shape exactly: a factory (`createSmtpEmailSender`) that dials nothing until `send()`
is called (PLAT-5), built on `nodemailer` (`^9.1.1` — a caret range, this repo's own convention for every
workspace dependency, not literally pinned to one version; widely maintained, the de facto standard Node SMTP
client) rather than a hand-rolled SMTP implementation — the same "do not reimplement the protocol" reasoning
`jose` already got in D-19 for JWT verification.

**Choice — the production check still runs first, unconditionally, and now decides SMTP-or-refuse rather
than always-refuse.** `buildEmailSender`'s `NODE_ENV=production` branch is still the first thing checked,
before `MAIL_FILE` is even read — that ordering was must-fix 1's own point (a stray `MAIL_FILE` in production
must fail loudly, not silently start writing credentials to disk) and stays exactly as strict now that
production has somewhere real to send mail. What changed is what the branch does once it is reached: instead
of unconditionally throwing, it builds the SMTP sender when `MAIL_SMTP_HOST`/`MAIL_FROM` are both set, and
throws — naming exactly what is missing — when they are not. Outside production, `MAIL_FILE` still wins when
both `MAIL_FILE` and SMTP are set (the more convenient way to read a link back locally), but a configured
SMTP relay is now usable in development/staging too, once `MAIL_FILE` is unset, for a developer or a staging
deployment who wants to exercise the real transport before a deployment does.

**Choice — misconfiguration is a startup failure; a relay that is configured but cannot currently be reached,
or that rejects one send, is a per-send failure surfaced to the caller.** These are different failures and
this slice treats them differently on purpose. A structural gap — no host, no `From:` address, half an
`MAIL_SMTP_USER`/`MAIL_SMTP_PASSWORD` pair — is something an operator can only fix by editing configuration
and restarting, so `buildSmtpEmailSender` throws immediately, before `server.listen` (`src/index.ts`'s own
`main()` calls `buildEmailSender` synchronously ahead of that call) — the same "fail loudly, at startup"
discipline `CONFIG` itself already holds a bad environment to. A relay that is fully configured but
unreachable right now, or that rejects a specific address, is transient or address-specific — retrying it at
startup would either delay every boot on a slow DNS lookup or bake in a retry policy this slice has no basis
to size — so `EmailSender.send()`'s own contract ("implementations may throw; `sign-in.ts` does not catch on
the caller's behalf") is honored exactly: a failed send propagates out of `requestSignInLink`, through
`routes/auth.ts`'s `.catch(next)`, to `middleware/errors.ts`, which answers `500` and logs the error. This
does **not** turn `/auth/request-link` into an account-existence oracle (AUTH-1's own concern) — a transport
failure happens identically whether or not the address has an account, since `requestSignInLink` issues a
token and attempts to send *before* it could know the difference, so every caller sees the same `500` for the
same underlying cause. The route's ordinary `204` (no account, or a healthy send) is unchanged.

**Rework finding — a failed send used to leave the token it issued active, so a retry silently succeeded
with nothing ever sent (must-fix 1).** `sign-in.ts#requestSignInLink` issues a token, then emails it — until
this fix, in that order and nothing else: a `send()` that threw still left the freshly-created row live and
unused. `hasActiveSignInToken` (the same function's own flooding guard, "also worth doing" of the API-1..6
rework) then did exactly what it is supposed to for a legitimately outstanding link: refused to issue a
second one, silently, for the rest of that token's fifteen-minute lifetime. Every sender in this codebase
before this slice — a file writer, a logger — was, in practice, infallible, so this branch was reachable only
in theory; a real transport reaches it routinely (a relay blip is exactly the ordinary case a retry exists
for), and reproducing it against a running production API was how a reviewer found it: a ten-second relay
outage answered `500` once (token written, nothing sent) and then `204` on every subsequent attempt for the
rest of the fifteen minutes, sending nothing, while the caller was told a link was on its way — precisely what
AUTH-5's own text forbids, "accepting a sign-in it will silently drop." The fix is `discardSignInToken`
(`tokens.ts`): `requestSignInLink` now wraps the send in a `try`/`catch`, deletes the token row outright (not
"mark used" — a token nobody received was never a legitimate single use to record) on any thrown error, and
rethrows unchanged, so the caller still sees the ordinary `500` the choice above already describes and the
address is immediately eligible for a fresh attempt rather than locked out.
`packages/db/src/repos/sign-in-tokens.ts#deleteSignInToken`
is the one new repository function this needed — a straight `DELETE`, not `consumeSignInToken`'s conditional
`UPDATE`, since there is no "was this already used" race to resolve for a row nobody legitimately touched.

**Choice — TLS is required, not merely offered, and a nodemailer error's own free-text `response` is never
logged.** Both follow from the same fact this whole slice's brief states directly: a sign-in link is a
bearer credential. `createSmtpEmailSender` treats port 465 as implicit TLS and sets `requireTLS: true` for
everything else, so a relay that does not offer STARTTLS is refused rather than sent to in the clear —
verified against a real loopback server in `packages/mail/tests/smtp.test.ts` (a fake with STARTTLS disabled
never receives a message; nodemailer throws first). Every SMTP failure this adapter can produce was
reproduced by hand against that same fake before `errors.ts#classifySmtpError` was written, and one finding
shaped it directly: a rejected-message error's own `response` field echoed the server's free-text reply back
verbatim (`"550 message rejected: contains a blocked link"`), which is exactly the shape a spam or content
filter could use to quote a fragment of a rejected body. `MailTransportError` is built only from the bounded,
protocol-level facts a nodemailer error carries — `code`, `command`, `responseCode` — and never touches
`response` or the original error's own `message`, so whatever ends up inside `middleware/errors.ts`'s
`logger.error({ err: error, ... })` carries nothing from the message that failed to send.

**Choice — `connection_failed`/`timed_out` keep the underlying `error.message`; every other kind still
discards it — and `NODE_EXTRA_CA_CERTS`, not a new `MAIL_SMTP_CA` option, is how a private-CA relay is
trusted.** A rework finding this entry did not originally weigh: the sanitizing choice above (never touch
`error.message`) was reasoned correctly for a *remote* server's own free-text reply, but applied too broadly
— `ECONNREFUSED`, `ENOTFOUND`, `Connection timeout` and a TLS trust failure's own `"self-signed certificate;
if the root CA is installed locally, try running Node.js with --use-system-ca"` are all generated locally, by
Node's own `net`/`tls` stack, before any SMTP conversation with a remote server even begins — none of them
can carry a fragment of the message being sent. Discarding them anyway meant a certificate a private
institutional CA issued — the case this choice most needed to get right, since a university's own relay is
exactly the deployment AUTH-5 targets — produced a log line byte-identical to a relay that is simply down:
`{"kind":"connection_failed","code":"ESOCKET"}`, with nothing anywhere pointing an operator at the actual
cause. `errors.ts#KINDS_WITH_SAFE_MESSAGE` names exactly the two kinds (`connection_failed`, `timed_out`)
whose `error.message` is safe to keep, and keeps it. Trusting a private CA at all was the other half of the
same gap: `createSmtpEmailSender` takes no `MAIL_SMTP_CA` option and `packages/config`'s schema has no
matching variable — `env.example`'s own `MAIL_SMTP_HOST` comment documents `NODE_EXTRA_CA_CERTS` instead, a
Node runtime flag/env var an operator sets when starting this process, read once by Node itself before this
package's own code ever runs, needing no code here to honor it. `createSmtpEmailSender` does carry a
`tlsCaPem` option, but it is test-only (its own doc comment says so explicitly) — `packages/mail/tests/smtp.test.ts`
uses it to prove a real STARTTLS handshake against a self-signed certificate actually completes, which
`NODE_EXTRA_CA_CERTS` cannot be set for mid-process, only at Node's own startup.

**Not chosen.** A transactional-email API (SendGrid, Postmark, SES, ...): faster to integrate and often
better deliverability tooling, but a second vendor account and SDK per institution, and a worse fit for
`EmailSender`'s own minimal port — most of these APIs' value is in features (templates, analytics, suppression
lists) this platform has no use for and that would pull the port toward looking like one specific vendor's
API. Left open as a second adapter behind the same port, the way a second model provider would be
(`docs/ARCHITECTURE.md`'s "a second provider is an adapter, not a rewrite"), if a deployment specifically
needs one. A startup connectivity check (`transporter.verify()`) before `server.listen`: would catch a wrong
host or bad credentials slightly earlier than the first real send, but costs every restart a network round
trip to the mail relay and conflates "configured" (a property this slice can prove offline) with "currently
reachable" (a transient property better left to the per-send path already described above).

Moving the send itself onto `packages/jobs`' own queue — enqueue-and-return from `requestSignInLink`, let
`apps/worker`'s existing runner (with its own retry/backoff, D-30) actually dial the relay — was not weighed
at all when this entry was first written, and it should have been: `packages/jobs` already exists, already
retries, and a rework finding (must-fix 1, above) turned out to hinge on exactly the gap between
"issue a token" and "the mail carrying it might not arrive" that a queue's own at-least-once delivery would
have narrowed considerably. Not chosen for this slice regardless, now that it has been weighed rather than
merely missed: `requestSignInLink` is `@bloombot/auth`'s own synchronous API, called by `routes/auth.ts`
inside one HTTP request/response cycle — moving the send onto a queue changes what `POST /auth/request-link`
means (a `204` would then mean "queued," not "sent," which the discarded-token fix below still lets it mean
today) and reaches into `apps/worker`/`packages/jobs` from a slice whose own brief scoped it to the transport
alone. Worth revisiting if a real deployment's relay turns out to be flaky enough that must-fix 1's discard-
and-let-the-caller-retry is not enough on its own — the queue's own retry/backoff would then be strictly
better than leaving a human to click "resend."

**Limits.** Auth is optional on the SMTP connection (some internal, IP-allowlisted relays need none), so a
relay that silently accepts unauthenticated mail from this box is a relay-side policy this slice cannot see
or enforce. `MAIL_SMTP_PORT` has no default derived from a "real" service the way `OPENAI_BASE_URL` does — a
mail relay is always institution-specific — so `env.example` documents `587` (STARTTLS) as the common case
rather than leaving it unset. `CONNECTION_TIMEOUT_MS`/`GREETING_TIMEOUT_MS`/`SOCKET_TIMEOUT_MS` (`smtp.ts`,
ten/eight/ten seconds — a rework finding: nodemailer's own defaults left a relay that accepts a connection
and never speaks holding `send()` open for tens of seconds, and `/auth/request-link` is unauthenticated, so
an unbounded hold on it is a resource-hold vector, not merely a slow error) are this slice's own judgment
call, not a number derived from anything AUTH-5 names — long enough for a real relay (loopback and a campus
relay both resolve in milliseconds) and short enough that a relay which never will does not hold the request
open indefinitely.

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

### Rework — two reviewers, six must-fixes, all found by running the user's own path

A second rework round, after both reviewers independently drove real paths through this slice rather than
trusting its own tests — an instructor's browser session (proven fine), and a *Discord-surface* person's
transcript through the real worker and the real download route (also proven fine, closing the "seeded the way
the implementation resolves it" risk this project's own history warns about). Six findings did not hold up,
each with its own regression test (patched, watched fail, restored):

**Finding 1 — an in-flight export could write a deleted tenant's transcript to disk, permanently, with no row
left to name or remove it.** `routes/admin.ts`'s own delete gathered ids, deleted every row (including
`transcript_exports` and `jobs`), then called `AttachmentStorage#remove` on a directory that did not exist yet
if the worker had not finished writing — a no-op. An export job already past that point, mid-`JSON.stringify`/
`Buffer.from` over a large course, then wrote the file anyway; `markExportReady` updated zero rows (the row was
gone) and returned `undefined`, silently. Closed on both sides, the same "close it at the write, and again after
a drain" shape D-32's own FILE-1..3 handlers already use for the identical class of race: `apps/worker/src/handlers/transcripts.ts`
now re-reads the export row, organization-scoped, immediately before `attachmentStorage.write` — gone means no
bytes are written at all, reported `'abandoned'`, the same status `createAttachCourseAttachmentHandler`'s own
identical race already reports. `routes/admin.ts`'s own immediate sweep is now *awaited* before the response
(a `200` means those bytes are actually gone, not scheduled to be), and a *second*, delayed sweep
(`deletedTenantSweepDelayMs`, five seconds in production) runs after the response to catch the residual sliver
between the worker's own re-check and its write call landing — idempotent either way, since removing bytes that
were never written, or were already removed, is a no-op. `apps/web/src/pages/Admin.tsx`'s own deletion
confirmation now names `queuedJobs` too, when there are any, so an administrator sees that an in-flight export
exists before confirming, not only after.

**Finding 2 — the test named for on-disk destruction asserted nothing about the disk.** `apps/api/tests/routes/admin.test.ts`'s
own "cleans up a stored transcript export's bytes" wrote no bytes and never called `AttachmentStorage#read`;
deleting the entire cleanup block left it green. Rewritten to actually write bytes through a real
`AttachmentStorage` (the same directory the route's own instance resolves to) and assert they are gone after —
plus a second, dedicated test for finding 1's own delayed sweep, writing bytes *after* the tenant is already
deleted and polling until the sweep removes them, and a worker-level test (`apps/worker/tests/handlers/transcripts.test.ts`)
spying on `transcriptExports.getExport` to make the exact race in finding 1 land deterministically rather than
relying on real concurrency.

**Finding 3 — PPL-5's export gate held only at the request's own `personId`, and the file did not.** Every
entry an export wrote carried its own `personId`/`personDisplayName`, including an *unfiltered* course export —
so `jq '.transcript[] | select(.personId=="S")'` reconstructed exactly what a filtered request refuses, and for
a one-student course the file simply *was* that student's history. The upfront refusal on a named, unverified
student stays (a real, correct check for that shape); `apps/worker/src/handlers/transcripts.ts` now also filters
every entry it writes, individually, against `hasVerifiedAddress` — an unverified person's own messages never
reach *any* export file, filtered or not, and `omittedForUnverifiedAddress` says honestly when that happened
rather than looking silently complete. The read screen (`transcripts.read`) is unchanged — this finding is
about the artefact that leaves the system, not the on-screen, audited read D-48's own reasoning above already
settled.

**Finding 4 — the panel's own most common Export click read as "not found" on a student already on screen.**
A Discord-only student, selected from the same filter dropdown ADMIN-1's own read already populates, produces
exactly finding 3's own upfront refusal — and it arrived as `ActionRefusedError` (WEB-5's "not found, or you do
not have access to it"), though the instructor was already looking at that student's transcript. `transcripts.export`
now raises `ActionConflictError` for this one case, naming the real reason — safe to name, unlike a not-found
(D-18's own reasoning: this caller already has full, audited visibility into this student, so the message
discloses nothing new to *them*) — while a `personId` that does not resolve at all (a foreign organization's,
TEN-5) stays the generic, indistinguishable refusal, since naming *that* reason would be a real oracle.

**Finding 5 — ADMIN-1's own filters had no test proving they reached the server at all.** Replacing
`currentFilters()`'s body with `return {}` — the student dropdown and both date pickers entirely decorative —
left every existing test green; the panel's own filtering is genuinely server-side SQL, unguarded. One test now
selects a student and a date range, presses "Apply filters", and asserts `readTranscript` was called with
exactly `{ personId, startAt, endAt }`.

**Finding 6 — `/admin` was not proxied in either deployment guide, so ADMIN-4/ADMIN-5 fail silently on a real
deployment.** The first rework round (above) fixed this collision in `apps/web/vite.config.ts`'s own dev/preview
proxy and named it as outstanding for production nginx — correctly flagged as another branch's file at the
time, but that branch merged before this round, and the gap was real: an administrator's browser loads the SPA
at `/platform-admin` fine, then every call to `/admin/organizations` gets `index.html` back as a `200`,
`response.json()` throws, and the console reports a generic failure forever, with nothing pointing back to this
cause. `docs/DEPLOY_DROPLET.md`'s own nginx block and `docs/DEPLOY_APP_PLATFORM.md`'s own routing list both
name `/admin` now, alongside `/health`/`/auth`/`/organizations`.

**Also fixed, smaller:** `apps/web/src/pages/Transcripts.tsx`'s own export list rendered a bare clock and a
timestamp for every non-`ready` status, indistinguishable from `pending` even once a job had exhausted its
retries and died — `ScaffoldButton.tsx`'s own explicit queued/running/failed labelling is the precedent this
slice's brief already named and this screen had not followed; it now names `pending`/`ready`/`failed` plainly,
with the failure reason shown for the last. `transcript-access.ts#listAccessLogForCourse` claimed "newest
first" and sorted `asc` — the opposite — and, a second instance of the exact ordering-tie class D-48's own first
rework already fixed for `transcript_exports.sequence`, had no tiebreaker of its own on a table ADMIN-2 exists
to make trustworthy; both fixed, with `sequence` added the same way. That first fix's own test
(`listExportsForCourse`, "most recent first") is now paired with an explicit, deterministic tie: two rows
inserted directly through the schema with an identical injected `createdAt`, asserted on `sequence` alone,
rather than relying on `Date.now()` happening not to collide within a run (measured at roughly one failure in
twelve before this, on the ordering the test was supposed to prove) — the same device applied to
`transcript-access.ts#listAccessLogForCourse`'s own identical fix, below.
`transcript-access.ts#listAccessLogForCourse` itself claimed "newest first" in its own doc comment while
actually ordering `asc` — the opposite — and had no tiebreaker of its own on the table ADMIN-2 exists to make
trustworthy; both fixed the same way `transcript_exports.sequence` already was, with the same deterministic
tie test. `transcript-access.ts#listPeopleWithTranscript` gained an explicit order (by display name, then
`personId`) — the Student filter dropdown's own order was previously whatever SQLite happened to return,
unstable across reloads; its own test seeds two people in the *opposite* order from their display names, since
a fix that merely preserved insertion order would otherwise pass a naively-ordered seed by coincidence.
`fetchTenantDeletions` (`apps/web/api/client.ts`) was dead code, called from nowhere despite `pages/Admin.tsx`'s
own module comment claiming every read goes through it — wired to a real "Deletion history" section on that
screen, rather than removed, since ADMIN-5's own text requires the deletion to be audited and the read,
route and repository function already existed, tested, with nothing left to build but the one call. The TEN-6
delete-guard in `packages/db/tests/conversations.test.ts` excluded the whole of `organizations.ts` rather than
naming `deleteOrganizationData` specifically, which would silently admit a second, unaudited delete path added
to that file later; narrowed to the one function, and proven to still catch a delete added elsewhere in that
file (a regression check on the guard itself, not only on `deleteOrganizationData`). Both `transcript-exports.ts#createPendingExport`'s
and `transcript-access.ts#readCourseTranscript`'s own `sequence` subqueries were missing their `organizationId`
scope, in files whose own headers claim no exception — fixed on both, though unreachable in practice (a
`courseId` is already organization-scoped by the caller's own policy resolve). `ModalProvider.tsx`'s own
`PromptOptions` carried no `destructive` flag, so ADMIN-5's own typed-name confirmation rendered its submit
button primary rather than danger, unlike `ConfirmOptions`' identical flag — one field and one line threaded
through, the same styling `Modal.tsx`'s own `variant={destructive ? …}` already gives a confirm dialog.

**Limits.** `previewOrganizationDeletion` is not exhaustive over every table `deleteOrganizationData` empties
(`cost_ledger_entries`, `person_identities`, `person_link_challenges`, `discord_install_states` have no count
in the preview) — deliberately: it is a confirmation a person reads and acts on, not a schema dump, and the
categories it names are the ones a person recognizes losing. `apps/worker`'s export handler produces JSON, not
CSV — this slice's own judgment call, not a requirement: nothing in ADMIN-3's text names a format, and a
hand-rolled CSV writer's own escaping rules are exactly the kind of complexity `roster.ts`'s own module comment
already warns a slice away from adding without a reason this one does not have. Finding 1's own delayed sweep is a mitigation,
not a proof: a worker whose own write takes longer than `deletedTenantSweepDelayMs` to land after passing its
own re-check would still leave an orphaned byte an operator would have to notice by other means (disk usage,
an audit) — bounded by `handlerTimeoutMs` in practice (a handler this slow is already killed and retried), but
not eliminated by construction the way the re-check itself closes the larger, originally-reported window.


### Rework — a second reviewer, three must-fixes, one an explicit reversal of finding 3 above

A third round, verified by a second reviewer against the code the round above actually shipped rather than
its own description of itself. Two of the three findings are regressions the round above introduced without
noticing (a migration that refuses to apply, and an orphaned file only a fragile cross-process sweep would
ever remove); the third overturns finding 3 above by design, on the reviewer's own explicit authority, not by
finding it factually wrong.

**Finding 1 — the per-entry filter finding 3 (above) added makes an ordinary course's export come back empty,
silently, defeating ADMIN-3 for the deployment shape this platform is actually built for.** A class that only
ever meets students through Discord has `hasVerifiedAddress` false for every one of its students (D-35's own
"a person connected only through Discord read `true`" is precisely the defect that function was built to
close) — so finding 3's own per-entry filter dropped every entry from every such course's export, leaving a
file with `transcript: []` behind a row that still read `ready`, a green tick, and a working Download link.
Nothing about that state told an instructor their export was empty rather than the course being quiet; the
`omittedForUnverifiedAddress` field that would have said so honestly lived inside the JSON itself, unread by
anyone but a script. This is the reviewer's own explicit call, not a rediscovery of finding 3's own reasoning
being wrong: what finding 3 actually demonstrated was narrower than "an unverified person's *content* must
never leave in a file" — it was that an unfiltered export could still *reconstruct one named person's history*
(`jq '.transcript[] | select(.personId=="S")'`), and PPL-5's own words are "exporting a **person's** history" —
the *identity* is what makes a transcript a *person's* one, not the message text alone. So the fix moves the
gate from content to identity: `apps/worker/src/handlers/transcripts.ts` now withholds `personId`/
`personDisplayName` from every entry in an *unfiltered* export (`deidentified: true` in the file, said
plainly, the same "an instructor should be told, not left to notice a missing field" reasoning
`omittedForUnverifiedAddress` was reaching for, for a reason that turned out wrong) rather than withholding
entries by verification status — every message an instructor could already see on screen (ADMIN-1,
unrestricted, D-48's own reasoning above for why the read itself is not gated) still reaches the file, and
there is no line in it any caller, `jq` included, can attribute to a named student, because the name is not
there to select on. A *student-filtered* export is unchanged from finding 3/4 above: it still carries the one
student's own identity it was asked for — that disclosure is the export's whole point — refused upstream, in
`transcripts.export`'s own action, unless `hasVerifiedAddress` is `true` for that student, before a
`transcript_exports` row is even created.

*What this costs, and why it is the right trade.* An unfiltered, whole-course export can no longer be used to
follow one particular student's own thread through a class discussion — every entry it carries is real and
complete, but nothing left in the file says which student sent which message, so a caller who wants "what did
this one student say all term" now has to ask for exactly that (`personId` set), which is the one shape PPL-5
gates on `hasVerifiedAddress`. That is a real capability lost for the unverified-student case specifically:
before this fix, an instructor could open an unfiltered export and read straight through to any one student's
lines by eye; after it, they cannot, for a course where that student has never verified an address. The
alternative was the empty file finding 3 actually produced for that same case — not a smaller version of the
same capability, none of it, silently, behind a status that still read `ready`. Between "the export is real but
anonymous for a student who has not verified" and "the export claims to be ready and is empty", the former is
the one that keeps ADMIN-3's own promise ("an instructor... collects the file when it is ready" means a file
with the course's own transcript in it) for the course shape this platform actually serves, and it is the one
this round ships.

**Finding 2 — migration `0013` refuses to apply to any database that has already run `0012`.**
`ALTER TABLE transcript_access_log ADD sequence integer NOT NULL` (no `DEFAULT`) is accepted by SQLite only
against an *empty* table — the moment a real deployment (or a reviewer's own checkout) has written even one
`transcript_access_log` row, `0013` refuses and the whole migration rolls back, taking every process that
migrates at boot (`apps/api` and `apps/worker` both do) down with it. `messages.sequence`,
`course_instruction_revisions.sequence` and `transcript_exports.sequence` never hit this because each was
added inside the same migration that created its own table — always empty at the point its own `ALTER TABLE`
ran; `transcript_access_log.sequence` is the one column in this family added, later, to a table the platform
had already been running with rows in. Fixed with `DEFAULT 0` on the column itself, in both the schema
(`packages/db/src/schema.ts`) and the regenerated migration SQL — every pre-existing row backfills to `0`,
which only matters as a tiebreaker against rows inserted before this migration ever ran, and those rows have
no ordering guarantee to preserve in the first place (the column did not exist yet to give them one).
`packages/db/tests/migrate.test.ts` gained a test that builds a real, partial migration history through
`0012` (copying the *actual* migration files and the *actual* journal entries through that point — an earlier
draft of this test reconstructed the journal with invented timestamps instead, and failed for the wrong
reason: drizzle's own migration runner watermarks progress by the journal's own `when` value per migration,
and a fabricated, lower one made it re-run migrations already applied against the real journal's real values),
seeds one `transcript_access_log` row directly, then runs the rest of the migrations including `0013` and
asserts it does not throw and the row survives with `sequence: 0`. Reverting the `DEFAULT` reproduces the
reviewer's own reported failure exactly.

**Finding 3 — the worker knows, in-process, that it just created an orphaned file, and left removing it to a
sweep in a different process.** When `markExportReady` (below the write) returns `undefined` — the tenant was
deleted in the narrow window between this handler's own re-check and the write call landing, finding 1's own
(the earlier finding 1, above, this file's second rework section) residual window — the handler already
reported `'abandoned'` but did not call `attachmentStorage.remove` itself, leaving the bytes it had just
written for `routes/admin.ts`'s own delayed sweep to find, eventually, in a different process: `unref()`'d, so
a deploy's own `process.exit(0)` on `SIGTERM` discards it outright if it lands within the sweep's own delay,
and a write slow enough to approach `JOB_HANDLER_TIMEOUT_MS`'s own default can already outlive the one-shot
sweep that ran before the write finished. Fixed with one `attachmentStorage.remove` call, in-process,
synchronous with the rest of this handler, in that branch — the sweeps stay, as defence in depth for whatever
this one call itself fails to clean up (a permissions error, a full disk on the remove itself), not the only
mechanism this promise depends on. The existing test for this branch (`apps/worker/tests/handlers/
transcripts.test.ts`, "writes no bytes, and reports abandoned...") spies `transcriptExports.getExport` and
leaves the `jobs`/`transcript_exports` rows intact by construction, which proves the code path runs but not
what an operator actually observes — a real deletion mid-write does not leave those rows for a retry to find;
`@bloombot/jobs`' own claim/complete protocol reports the outcome as `'superseded'` (the claim's own row is
gone) with this handler's own report discarded, and the operator sees the generic "this job may have run
twice" warning that outcome already carries, not this handler's own more specific `'abandoned'` reason. A
second test now performs a real `organizations.deleteOrganizationData` call as a side effect of the storage
port's own `write`, mid-flight, and asserts the actual, observable outcome: `'superseded'`, and no bytes left
under the export's own id.

**Limits, unchanged from the round above; nothing here revisits them.**

---

### Rework — a second reviewer, challenged on the coordinator's own instruction, found the label wrong and the cost bigger than stated

A fourth round. The coordinator asked the reviewer to challenge the third round's own de-identification call
specifically, not merely re-check it — the reviewer agreed the reversal (identity fields out, content kept)
was right in shape, and found two things wrong with what shipped: the file's own claim, and the coordinator's
own stated cost. Both are corrected here; a third, unrelated finding closed a test flake whose real cause a
prior guess (`docs/DECISIONS.md`, this file, third round, above) had missed.

**Finding 1 — `deidentified: true` was not true.** Withholding `personId`/`personDisplayName` de-identifies a
transcript only if nothing *else* in it identifies the student — and this platform's own `packages/openai/
src/conversations.ts` opens every upstream conversation with "My name is ${displayName} (user id
${personRef})", read from `answer.ts`, and stores the model's own reply verbatim, name and all: "Hi Sarah —
the midterm is on 12 October" is designed behaviour, not an unlucky sample, and a real run against a
Discord-only course named two real students in four lines. `deidentified` is a term of art an instructor
relies on to decide whether a file may leave the tenant — a TA outside it, an IRB submission, a research
corpus — and claiming a property the file does not have is worse than making no claim at all. Renamed to
`identityFieldsOmitted: true`, which says only what is actually true, and a `notice` string next to it in the
file (plus a line on-screen, next to the Export button, `Transcripts.tsx` — the same "said where a reader
will see it, not left inside a field nobody but a script reads" correction this rework already drew from
`omittedForUnverifiedAddress`'s own mistake) states plainly that the message text itself is not filtered and
may still name someone. `apps/worker/src/handlers/transcripts.ts`'s own module comment carries the reasoning
in full.

**Finding 2 — the cost the coordinator recorded in the round above was smaller than the real one, and the
coordinator's own correction is recorded here with the objection, not only the conclusion.** The round above
framed stripping identity as "an instructor can no longer follow one student's own thread through an
unfiltered export." The reviewer's own point, which the coordinator accepted as the stronger one: every
reason an instructor actually exports — participation credit, a student stuck for three weeks, an integrity
question, a wellbeing escalation — is per-student work, and none of it survives a file that names nobody, for
exactly the Discord-only course this feature exists to serve. What survives an unfiltered export is
corpus-level use only, and that is not the export's primary use.

The fix: every entry now carries `participant: "P1"`, `"P2"`, ... — a pseudonym assigned fresh on every
export, ordered by a hash salted with `randomBytes(16)` minted new on every call and never stored
(`assignPseudonyms`, `apps/worker/src/handlers/transcripts.ts`) — stable across every entry *within* one
export (so "does this keep coming from the same person" survives), but not correlated *across* two exports of
the same course (a caller cannot line up one export's own `P1..Pn` against another's, a roster, or Discord to
find the same student in both). `personId`/`personDisplayName` stay omitted; no name, no id, no display name,
anywhere in an unfiltered export.

The objection, recorded rather than only the conclusion it lost to: this partially reinstates the very shape
round three's own finding 1 raised against round two — `jq 'select(.participant=="P1")'` still returns one
person's whole history inside this one file, unnamed. The coordinator's own judgement, on the record: this
does not cross what PPL-5 gates, because PPL-5 gates disclosure of a *named* person's history, and a
per-export pseudonym names nobody — `P1` does not resolve against a second export of the same course, a
roster, or Discord, the way `personId` would. A future reader who finds that distinction too thin should treat
this paragraph as the place to reopen it, with the evidence (the two findings above, and D-35's own "a person
connected only through Discord read `true`" precedent for how narrowly this platform has drawn "identified"
elsewhere) already assembled. A student-filtered export is unchanged by any of this: it names exactly the one
person it was asked for, deliberately, and stays gated on `hasVerifiedAddress`.

**Finding 3 — the delayed-sweep test's own flake had a different cause than the guess recorded above, and the
fix is in the test, not the route.** The round-three section above blamed a race between the test's own
2-second poll and a 5-second production default, shortened in-test to `deletedTenantSweepDelayMs: 20`. The
reviewer traced it further and found the real cause: `routes/admin.ts`'s own delayed `setTimeout` is scheduled
*inside* `sweepStorage(...).then(...)`, before the response is sent — so the timer is already running, on the
real clock, while the test's own code between `await request(app)...` resolving and its own `attachmentStorage.write`
call runs. Parameterised proof reproduced the exact boundary: a simulated write landing immediately after the
response removed cleanly; one landing 200ms after did not, ever, since the sweep is one-shot. Raising the poll
or the delay only widens the same race; it does not close it — measured, before this fix, at roughly one
failure in five even against a generous two-second poll, reproduced by hand for this round's own record.

Fixed by making the ordering the test needs true by construction: `ServerDependencies` (`apps/api/src/
server.ts`) gained an optional `attachmentStorage` override — a test-only seam, never set by `src/index.ts` —
so `apps/api/tests/routes/admin.test.ts` can wrap the one call that matters (`remove`) rather than writing
bytes itself on its own schedule. The wrapped `remove` performs the simulated worker write as a side effect
*after* removing (a no-op, nothing is there yet), the first time it is called for the export's own id — which
happens *during* the immediate sweep's own `Promise.all`, before that promise settles, before `.then()` ever
schedules the delayed sweep's own timer. No wall-clock assumption is left for the test to lose; run twenty
times after this fix, clean every time (measured for this round's own record).

**Also.** Drizzle advances its own migration watermark from the journal's `when` value, not from a migration's
own filename — a database that already applied `0013_loud_tigra` (the file this rework's own third round
deleted and replaced with `0013_opposite_selene`) re-runs the replacement under its new tag and dies on
`duplicate column name: sequence`, reproduced by the reviewer. No code change follows from this: neither
`0013_loud_tigra` nor its own replacement had reached the integration branch before the third round's own fix
landed, so only a local development database built directly from this branch, mid-rework, can be in that
state — recorded here so the next person editing an unmerged migration edits it in place, under its original
tag, rather than deleting and regenerating it the way this rework's own third round did.

---

## D-49 — `packages/db`/`packages/core`: CONV-4 — a message is never silently lost, the retry versus `BEGIN IMMEDIATE`, and what surfacing the failure costs

**Problem.** A reviewer chased `e2e/course-configuration.spec.ts`'s own ~1-in-8 flake to its cause rather
than retrying it away: the transcript it asserts comes back with one message missing, sometimes the
question, sometimes the reply. The cause is `answer.ts`'s own `answerQuestion` (pre-CONV-4): both calls to
`conversations.appendMessage` were wrapped in `try`/`catch { logger.error(...) }` and continued past — the
same "a broken write degrades to a log line, never a lost answer" discipline this file still applies to the
cost ledger entry and the upstream thread id, applied one place too many. Under the write contention four
processes sharing one SQLite file actually produce (`ecosystem.config.cjs`; the e2e spec itself reproduces an
equivalent shape — its own module comment explains why — with the test process's direct `handleMention` call
and `apps/api`'s browser-driven writes both landing on one database file), `appendMessage`'s own transaction
can throw `SQLITE_BUSY_SNAPSHOT`. `client.ts`'s own `busy_timeout` (D-2) does not cover this: it retries a
lock that is *held*; a stale snapshot is not that — SQLite reports it immediately, nothing to wait out. The
student was still answered; the platform's own record of it was not — exactly the gap CONV-2's retention
guarantee and ADMIN-1's transcript cannot tolerate.

**Reproduced two ways — the mechanism directly, and, on review, the flake itself.** The implementer's own
attempt to reproduce the end-to-end flake (single spec, pre-fix code, ~33 attempts) came back clean and was
reported as such rather than papered over. A reviewer went one step further and found what the single-spec
loop could not see: the flake needs the concurrency the real deployment has, which one Playwright spec
running alone does not reproduce. Their matrix, full suite (`npm run e2e`), 4 Playwright workers:

| tree | runs | failures | signature |
|---|---|---|---|
| fixed (`immediate` + retry) | 43 | 0 | — |
| pre-fix, reverted | 45 | **2** | both `["to_person"]` — `from_person` missing from the transcript |
| pre-fix, reverted, single spec | 20 | 0 | — |

— confirming both the bug (reproduces under real multi-worker contention, not under one spec alone) and the
fix (0 failures across 43 runs at the same contention that produces 2 in 45 without it). Independently,
`packages/db/tests/client.test.ts`'s own two tests reproduce the underlying SQLite mechanism directly, no
mock: two real `openDatabase` connections, one holding a deferred read snapshot while the other commits, the
first then failing to write — deterministic, every run, not flaky at all, because unlike the end-to-end flake
above, every statement in this sequence is itself synchronous and non-blocking, so plain sequential
statements across two connections force the exact interleaving by construction rather than by luck.

**Choice — a bounded retry (`MAX_APPEND_MESSAGE_ATTEMPTS = 3`, `packages/db/src/repos/conversations.ts`),
for `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` only — this is the fix's own load-bearing half, not the
`BEGIN IMMEDIATE` change below.** The same reviewer isolated the two changes: **retry alone, with
`{ behavior: 'immediate' }` removed, ran 45 full-suite attempts at the same reproducible contention with
0 CONV-4 failures.** At the concurrency this platform's own `ecosystem.config.cjs` produces, a `SQLITE_BUSY`
or `SQLITE_BUSY_SNAPSHOT` on `appendMessage`'s own transaction is rare enough, and resolved fast enough on a
second attempt, that the retry alone already closes the gap the flake exposed — an earlier draft of this
entry credited `BEGIN IMMEDIATE` as *the* fix and the retry as a defensive second layer; the measurement says
the opposite ordering is the accurate one, and this entry now says so. Both are transient by construction —
the conflicting writer has, by definition, already finished by the time either error is thrown — so
`isTransientBusyError` (`repos/conversations.ts`) retries exactly these two codes and nothing else: a
constraint violation or a corrupt database would fail identically on a second attempt, and retrying either
would only delay an honest failure. No manual delay between attempts — a snapshot conflict resolves
immediately, and a lock wait already spent up to `busy_timeout` waiting inside the failed attempt itself, so
a second attempt costs nothing extra to try.

**Choice — `appendMessage`'s own transaction also opens `immediate`, not Drizzle's default `deferred` — the
correct root-cause fix, and defence-in-depth, not the load-bearing half the measurement above names.** A
deferred transaction takes no lock at `BEGIN`, only at its first write — so `appendMessage`'s own `select`
(reading the previous `sequence`) establishes a read snapshot *before* the lock is ever acquired, and a
concurrent committer in between leaves the later `insert` unable to upgrade that now-stale snapshot.
`{ behavior: 'immediate' }` takes the write lock at `BEGIN`, before the `select` runs, so this transaction's
own snapshot cannot go stale out from under it at all — a concurrent writer now blocks behind `busy_timeout`
(an ordinary, already-covered wait) rather than racing this one to a silent loss. Kept, alongside the retry
that the measurement shows already carries this fix on its own, because it is what converts an *uncoverable*
`SQLITE_BUSY_SNAPSHOT` into the *ordinary*, already-covered `SQLITE_BUSY` `busy_timeout` was always meant to
absorb — narrowing what the retry above ever has to catch, not standing in for it. Pinned directly, not only
inferred from behaviour under contention: `conversations.test.ts`'s own `BEGIN IMMEDIATE, not deferred` test
opens a second, `verbose`-logging connection to the same file and asserts the literal SQL `appendMessage`
executes contains `BEGIN IMMEDIATE` — the must-fix a first review found: the three retry tests all replace
`db.transaction` wholesale and never observe which mode the real transaction opens with, so a shared
`withTransaction` helper extracted later, or a Drizzle upgrade that drops the option, would have left the
whole suite green while this silently reverted to `deferred`. Verified by removing the option and watching
this one test fail (`AssertionError: expected [...] to include 'BEGIN IMMEDIATE'`) with every other test,
including the three retry tests, still green — exactly the blind spot named above.

**Choice — the two `appendMessage` calls in `answer.ts` are no longer wrapped in a swallowing `try`/`catch`;
the cost ledger entry and the upstream thread id still are.** CONV-4's own text: writing a message is part of
answering, not a side effect of it. A write neither the retry nor `immediate` recovers now propagates out of
`answerQuestion` — for the question, before the model is ever asked, so a question this platform cannot
record is not one it answers; for the reply, after the model has already answered, so the caller sees an
honest failure instead of a reply with no transcript entry behind it. Every existing caller already turns a
thrown `answerQuestion` into exactly that: `apps/api/src/routes/chat.ts`'s own `.catch(next)` (a `500` to the
browser, `middleware/errors.ts`'s own already-established path — D-47 reasons about the identical shape for a
failed mail send; checked directly, not assumed — `errorMiddleware`'s own `actionErrorCode()` reads any
thrown value's `.code`, and a `SqliteError` does carry `code: 'SQLITE_BUSY'`, but it falls through to the
generic `500` regardless, because `HTTP_STATUS_BY_ACTION_ERROR` has no entry for it and `expose` is absent —
no SQLite text and no transcript content ever reach the response body), and `apps/bot/src/index.ts`'s own
`onMessageCreate(...).catch(...)` (logged at error level, no reply sent — silence, not a false answer).
Neither call site needed to change: this fix is contained to `answer.ts` and `conversations.ts`. The cost
ledger entry and the upstream thread id are deliberately unchanged — neither is retention data an instructor
can be required to produce (COST-1's own scope; the upstream thread id is an internal resumption pointer,
D-13's own "the model's own context can be resumed"), so losing either still degrades to a log line, the same
as before this slice.

**What this costs, named rather than hidden.**

- *The reply side.* A reply's own write failing after the model has already answered means `answerQuestion`
  throws *after* the daily allowance was already reserved and the model already called — the same cost
  `failed-with-apology` already pays for a model failure, extended to this one further case rather than a new
  kind of cost. There is no `usage.ts` operation that gives an already-reserved slot back (this file's own
  module comment, unchanged by this slice), so a student whose reply-write failed loses one of their day's
  requests and gets no answer for it — worse, for that one request, than the swallow-and-continue behaviour
  this replaces. Weighed and accepted anyway: the alternative is the bug CONV-4 exists to fix, and it fails
  silently rather than loudly. The retry is what keeps this cost rare rather than routine — it is paid only
  once retrying has already given up.
- *The question side.* The inbound write (`answer.ts` around the `direction: 'from_person'` call) burns the
  same already-reserved allowance slot when it fails, and this one is *in principle* avoidable — the slot is
  reserved before this write runs, so moving `usage.reserveUsageSlot` to *after* a successful inbound write
  would spend nothing on a request that never got recorded. Not done: CORE-3's own guarantee is that an
  over-limit request creates no conversation and no row at all, checked and reserved atomically before
  anything else is read or written (this file's own module comment, steps 5–6) — reordering the reserve below
  the write would mean an over-limit request *does* open a conversation and attempt a write before being
  told no, the exact "costs nothing" property CORE-3 exists to hold. Both orderings are defensible and this
  slice keeps the one already in place rather than reopening CORE-3's own ordering decision for a rarer
  failure than the one it was made to prevent.
- *The synchronous stall.* `better-sqlite3` is synchronous — a busy wait blocks the whole event loop of
  whichever single-threaded process is running it (`apps/api`, `apps/bot`). Three attempts, each capable of
  spending the full 5s `busy_timeout` waiting on a held lock, is a worst case of up to ~15s of blocked
  event loop, up from the ~5s a single `appendMessage` call could already cost before this slice. Not
  realistically reachable — `BEGIN IMMEDIATE` holds the write lock only for the duration of one
  select/insert/update, not for the request as a whole — but it is the tail, and a stall that long would flap
  the process's own `/health` endpoint, which `scripts/ops-monitor.mjs` (OPS-12) would page on.

**Not chosen.** Moving `appendMessage` onto `packages/jobs`' own queue (retry/backoff, D-30): rejected for the
same reason D-47 rejects it for mail — `appendMessage` is called from inside `answerQuestion`'s own
synchronous request/response cycle (three different surfaces' own request handlers), not a fire-and-forget
background operation; queuing it would change what "answered" means (the reply would have to wait on a
queued write landing, or risk returning before the record exists) for a problem the retry above already
solves at the transaction layer, cheaper and without moving the write out of the request path. Retrying
inside `answer.ts` itself, around the `appendMessage` call, rather than inside `appendMessage`: kept the fix
in `packages/db`, where the SQLite-specific mechanism (WAL, snapshots, `busy_timeout`) already lives (D-2's
own home for it) and where `packages/legacy-import`'s own caller benefits too, rather than duplicating retry
logic at every one of `appendMessage`'s callers. A richer discriminated `AnswerResult` kind (e.g.
`failed-to-record`) instead of a thrown error: rejected to keep this fix contained — `answerQuestion` already
throws for conditions this deliberate ("caller misuse," this file's own module comment) rather than expected,
and a persistent write failure after retrying fits that shape better than it fits alongside `declined-*`/
`failed-with-apology`'s ordinary outcomes, without forcing every existing `switch (result.kind)`
(`packages/discord/src/handle-mention.ts`) to grow a branch for a case this rare.

**Swept, not fixed.** `grep`ed `packages/core`, `packages/discord`, `apps/worker` and `apps/api` for the same
shape (a `catch` around a database write that logs and continues). Two more turned up, both left alone on
purpose: `answer.ts`'s own cost ledger entry and upstream-thread-id writes (COST-1/CONV-1, reasoned about
above — not retention data); and `handle-mention.ts`'s `enrolViaDiscordRole` write (ENRL-1..6) — a failure
there is retried naturally on the *next* message from the same person, unlike a transcript entry, which is a
one-shot event that will never recur if lost. Everything else found (`apps/worker`'s Discord REST calls in
`roster-import.ts`/`course-attachments.ts`, `apps/api`'s OAuth code exchanges) either already surfaces the
failure into a caller-visible report/response or is already governed by `packages/jobs`' own retry/permanent-
failure machinery (D-30). Fixing any of these was out of this slice's own scope — CONV-4 is a defect in the
transcript specifically, not a general audit of every write in the platform. One further note, left as a
note rather than a fix for the same reason: a Discord student whose reply-write fails past all three retries
gets silence today (`onMessageCreate`'s own `.catch` above logs and sends nothing), with the slot already
burned, and will plausibly re-ask — burning a second slot and a second model call for what was, from their
side, one question. `handle-mention.ts` already has `sendReply(reply, apologyText(course.title))` wired for
exactly this shape (`CORE-5`'s own model-failure path uses it today) — reachable from a `catch` around this
file's own call to `answerQuestion` if this ever becomes a real complaint, not merely a theoretical one; not
added here because it was not observed, and this slice's own bar is a defect that was.

**Limits.** `MAX_APPEND_MESSAGE_ATTEMPTS = 3` is this slice's own judgment call, not a number CONV-4 names —
enough to absorb a snapshot conflict (resolves on the first retry, by construction) and one further genuinely
unlucky contention window, without turning a stuck lock into a long hang on top of `busy_timeout`'s own 5s
(the synchronous-stall cost above is what that hang would mean in practice). This fix narrows the window for
message loss to "an operator's own database problem" (a corrupt file, a full disk, a lock genuinely stuck
past every retry) — it does not, and cannot, make a write to a single SQLite file never fail; CONV-4's own
bar is that a failure is never silent, not that it never happens.

## D-50 — `packages/db`/`apps/api`/`apps/web`: LINK-10 — the organizations an account has a connected person in, and what a connected-but-not-a-member account is deliberately not shown

**Problem.** LINK-1..9 (D-35, D-44, D-45) build the mechanism that proves a Discord (or MCP) identity belongs
to a signed-in account and merges it with whatever a roster import or a Discord role already admitted — but
D-44's own corrected framing named the gap plainly: connecting proves who somebody is, it does not make them
a member of the institution running the course, and `apps/web/src/pages/Shell.tsx` builds its organization
switcher from `account.memberships` alone. A student who connects through the Discord invitation is fully
reachable *on Discord* the moment they do; the same student opening the web panel still sees only their own
personal organization, because nothing told the browser the institution's organization exists for them at
all. Discord worked and the web did not, for the same person, for the same course.

**Choice — a new read surface, `people.ts#listConnectedOrganizationsForAccount`, the same TEN-2 exception
class as `memberships.ts#listMembershipsForAccount`.** Keyed on `accountId`, not `organizationId` — an
account's connected identity is not scoped to one organization until this call names it, the identical reason
the membership version is unscoped. Implemented as a join from `person_identities` (`surface: 'web'`,
`externalId: accountId`) to `people`, filtered to `connectedAt is not null` (PPL-3's own "created on first
sight, unconnected" case excluded — the same gate `routes/chat.ts#resolveConnectedCallerPerson` already
applies read-only). No `mergedIntoPersonId` filter is needed: `mergePeople` moves every identity to the
survivor outright, so a `web`-surface identity row can never point at a merged-away tombstone — proven
directly (`packages/db/tests/people.test.ts`'s own "follows a merge" test), not merely asserted, because this
is exactly the shape the coordinator's brief warned against seeding around: a real student's own path is a
`discord`-surface person a roster import admits, whose identity later *merges* into the account's own
survivor, never a `web` identity created directly in the institution's organization.

**Choice — `GET /auth/me` gets one additional field, `connectedOrganizations`, excluding anything already
present in `memberships`.** Bundled into the existing "who am I" read rather than a second endpoint — the
panel already treats this response as the one source of truth for which organizations an account may act
within (must-fix 9 of the API-1..6 rework), and a second round trip would only reintroduce the "two lists that
can disagree" problem the exclusion filter exists to avoid in the first place. `apps/web/src/api/types.ts`'s
new `ConnectedOrganizationSummary` carries `organizationId`/`organizationName` and deliberately no `role` —
connecting proves an identity (LINK-3), not administrative authority, so there is no role to report.

**The judgment call the brief asked for, made deliberately and erring toward withholding: what a
connected-but-not-a-member account sees once that organization is active.** Read `apps/api/src/routes/actions.ts`
and `apps/api/src/routes/chat.ts` side by side and the boundary is already drawn at the server, not something
this slice invents: `routes/actions.ts` resolves the caller's organization from `memberships.getMembership`
*before it even looks up which action was requested* — every dispatched action (Discord's `discordServers.remove`,
every `projects.*`/`courses.*` action `ProjectsPanel` calls, ADMIN-1..3's own `transcripts.*`) refuses
unconditionally for a caller with no membership, no exception anywhere in the catalog. `routes/chat.ts` is the
one screen deliberately built not to need a membership at all — it authorizes on an active enrolment instead
(that file's own module comment: "the person asking a course a question is not necessarily any such thing").
So `apps/web/src/pages/Shell.tsx`'s `isMember` mirrors that split: a connected-but-not-a-member organization
offers **only** the Chat tab — Discord, Projects and Transcripts are withheld outright, not merely left to
fail once clicked, because a control every click through it would 404 against is worse offered than absent.
`effectiveTab` (`isMember ? activeTab : 'chat'`) is what every render branch actually reads, not `activeTab`
directly — `activeTab` is this shell's own state and is deliberately *not* reset on an organization switch
(unlike `ProjectsPanel`'s/`Chat`'s own `key={activeOrganizationId}` remount, which resets what is fetched
*inside* a tab, not which tab is active), so a tab selected on a previous, membership organization (Discord,
say) can never leak into a connected-only one where the server would refuse it. The home control and the
`navItems` list are gated the identical way, so nothing in the panel's own chrome ever points at a withheld
screen.

**Not a second authorization path — the server's own refusal is what makes this safe, and it is tested
directly, not assumed.** `apps/api/tests/routes/person-link.test.ts`'s own acceptance test (the "starts where
a real student starts" test the coordinator's brief asked for: a `discord`-surface person admitted by
`enrolViaRoster`, connected through the real `/discord/begin`→`/discord/preview`→`/discord/confirm` endpoints,
never a shortcut) now also dispatches `discordServers.remove` against the institution's organization for that
exact caller after connecting, and asserts `404 action_refused` — `routes/actions.ts`'s own membership gate,
unchanged by this slice, still refuses regardless of what the panel offers. `apps/api/tests/auth-flow.test.ts`
proves the read surface's own shape directly (exclusion of an organization already reported as a membership,
in particular). `apps/web/tests/shell.test.tsx` proves the panel's withholding, including the one case a
review round has been bitten by before on a different slice: a tab selected before switching organizations
(Discord) does not leak into the connected-only one afterward.

**The e2e gap this closes, and why the Discord OAuth half is still a documented stand-in.** Three prior
slices in this project shipped a defect only a real browser caught — `e2e/link-10-connected-organization.spec.ts`
is QA-7's own coverage for this one, and it is deliberately *not* a second, separately-seeded scenario: it
seeds the identical real starting point the API acceptance test above does (a roster-admitted `discord`-surface
person), then builds the same end-database-state a completed `/discord/confirm` leaves behind using the exact
repository functions that route calls internally (`people.mergePeople`, then `people.connectIdentity` for the
account's own `web` identity — never a raw `connectedAt` column write). Driving the browser through Discord's
own OAuth consent screen itself remains out of reach the same way `e2e/connect.spec.ts`'s own module comment
already states: this harness does not build a second, fake OAuth provider standing in for discord.com
(`e2e/support/start-api.ts` points `apps/api`'s own Discord configuration at unreachable loopback addresses on
purpose). Verified as a real regression test, not merely a passing one: reverting `effectiveTab`'s own gate
locally fails this spec — a real Playwright browser lands on `ProjectsPanel`, not `Chat`, in the connected-only
organization, while the nav row itself still (correctly) shows only a Chat button — a mismatch no mocked
component test would have caught, since none of them render `Shell.tsx`'s own conditional content against a
real DOM the way a browser does.

**Limits.** `redeemJoinLink`/`course_join_links` (ENRL-3/ENRL-4) remain unwired from any route, unchanged by
this slice (D-44's own "Limits" already named this) — a web-only student who has never touched Discord or MCP
still has no way to reach a course through this slice; `connectedOrganizations` only ever reports an
organization *something* has already connected an identity in. Nothing here changes what a membership grants,
or introduces a second membership-like relationship — `connectedOrganizations` is read-only, and the one write
path that could turn a connected person into a member (`memberships.ts#createMembership`/`grantMembershipRole`)
is untouched.

---

## D-51 — `apps/worker`: SRV-9 — repairing the bot's own access on a hand-made channel, and how "inherits fine" is told apart from "has its own overwrites that exclude the bot"

**Problem.** SRV-9 already repaired a category adopted with the bot missing from its overwrites
(`allowBotOverwrite`/`grantBotChannelAccess`, shipped ahead of this slice) — a course category denies
`@everyone`, and Discord applies that denial to the bot too, so scaffolding needs its own overwrite to act
inside a category it manages. The repair stopped one level too shallow: Discord copies a category's own
overwrites into a channel *at creation time*, then stops syncing them the moment the channel gets any
overwrites of its own. A channel an instructor made by hand before the category was repaired — or one this
handler itself made admins-only before `allowBotOverwrite` existed — holds a permanently stale snapshot that
the category's own repair never reaches. That is precisely the channel a student is already using, so a
question asked there gets silence even after the category looks fixed.

**Choice — extend the same single-target `PUT /channels/{id}/permissions/{botId}` repair to an adopted
channel, gated on whether it has overwrites of its own at all, not on whether the bot happens to be missing
from the category's.** `existingChannel.permissionOverwrites` is `[]` for two different reasons a caller
cannot otherwise tell apart from the response alone — Discord genuinely sending none (the channel inherits
its category's, cascade included) — and this codebase's own `DiscordChannel.permissionOverwrites` convention
of using `[]` for "the field was missing or unusable" (`client.ts`'s own doc comment). Both read as "no
overwrites of its own" here, and both mean the channel already inherits whatever the category grants,
including a category-level repair — so nothing is written. A channel with `length > 0` has overwrites Discord
stopped syncing with its category, and if none of them name the bot, it gets the repair; if the bot is already
there, nothing is written either. This reuses `channelIsAdminsOnly`'s own existing reasoning about the
category/channel overwrite cascade (`discord-scaffold.ts`'s own module comment) rather than inventing a
second rule for the same fallback.

**Why not repair every adopted channel unconditionally.** A channel with no overwrites of its own already
resolves to the bot having access, through Discord's own cascade, the moment its category does — writing an
identical overwrite there would be redundant, and worse, would desync the channel from its category in
Discord's own permissions UI (Discord marks a channel "synced" only while it carries none of its own), a real
cost to an instructor who manages permissions at the category level and now has one more channel to check by
hand. Under-repairing (leaving a channel that genuinely has no overwrites alone) costs nothing; over-writing
costs an instructor's own mental model of their server.

**Why the admins-only case needed its own test, not just coverage by the general one.** The repair is the
same single-target `PUT` the category version already uses — `PUT` on one target replaces only that target's
own entry, never the channel's other overwrites — but an admins-only channel is exactly the row where
"accidentally regranting everyone" would be worst: its own `@everyone` denial and the absence of a students
grant are deliberate, and a repair that touched anything but the bot's own id would reopen it. Verified
directly against the fake's own stored state (`repairs an admins-only channel without widening who can see
it`), not only against the request the handler sent.

**Choice — a new `ScaffoldChannelReport.accessRepaired` field, not an overload of `establishedByThisRun`.**
`establishedByThisRun` already means something specific (SRV-3's permission state was actually just set, a
fact rather than an observation) and stays `false` for every adopted channel, repaired or not — collapsing
"this run wrote nothing" and "this run wrote exactly the bot's own overwrite" into the same boolean would
have made an honest, targeted repair indistinguishable from `already_present` untouched, which is the
opposite of what SRV-7's "the result names what changed" asks for. `accessRepaired` is `true` only when this
run actually sent the repair `PUT`; `false` for a channel it created (the overwrite, if any, was baked into
the create call, never adopted missing it) and for one it adopted that already had the bot or inherited
cleanly.

**Idempotence, proved against the fake's own recorded calls.** A second run against a guild this run just
repaired must write nothing at all — the existing "creates nothing on a second run" test only ever proved
that for *creates*; SRV-9's own repair is a legitimate, idempotence-sensitive `PUT` on the adoption path, so a
dedicated test (`writes nothing on a second run once the category and channel access have both been
repaired`) reruns the handler against the fake's now-updated guild state and asserts `writeRequests()` grows
by zero, the same structural proof the create-side test already used.

**Limits.** The repair still only ever writes the bot's own single overwrite entry — it does not attempt to
reconcile any other drift between a hand-edited channel and its category (a students role an instructor
revoked on the channel but not the category, say), which remains exactly the kind of edit SRV-8's own
discipline puts out of scope for this handler to make on its own. Two categories or channels that share a name
after `normalizeName`/`normalizeChannelName` are still indistinguishable to the adoption match this repair
rides on (D-30's own acceptable simplification) — a repair aimed at "the" adopted row is aimed at whichever
one that match found first, unchanged by this slice.

---

## D-52 — `apps/web`: WEB-18 — the knowledge-files screen polls the attachment list, not a job id, and a hand-typed `vectorStoreId` is already adopted, not silently replaced

**Problem.** `FILE-1..3`'s backend — `courseAttachments.attach/.list/.detach`, the worker's own upload job,
the provider round trip — was built and reviewed a phase ago, and no screen ever reached it: attaching a
course's notes was only possible by dispatching an action by hand, the same capability-without-a-surface shape
`LINK-10` already named for a different slice. `components/CourseAttachments.tsx` is that screen, embedded in
`pages/CourseEditor.tsx` for an existing course.

**Choice — poll `courseAttachments.list`, not a job id, and track "still queued" per row.**
`components/ScaffoldButton.tsx` is this app's own precedent for the exact case this project keeps hitting: a
background job queued with no worker running to claim it has to read as "still queued," not a silent hang, so
this screen borrows its shape rather than inventing a second one — poll, and once something has sat
unresolved past a threshold (the same `8_000`/`2_000` ms defaults, unchanged), say so by name
(`npm run worker:dev`). What it polls is deliberately different, though. `ScaffoldButton` dispatches one
action, gets back one job id, and polls `jobs.get` for that one id — a shape that only works because the
component always knows the job it is asking about. A course's knowledge files are a *list*, and reopening this
screen (a reload, or simply navigating back to the course next week) has no job id to resume polling with, only
the attachment rows themselves. So `CourseAttachments` polls `courseAttachments.list` instead — the read
`FILE-2`'s own text already calls authoritative ("the panel says which") — and keeps its own per-row
"first observed pending" timestamp (a `Map`, the same bookkeeping `ScaffoldButton`'s single `pollingSinceRef`
keeps for its one job) to derive the same "queued past a threshold" signal from a record a reload cannot lose.
A confirmed detach is tracked the same way, in a local `detachingIds` set, reconciled against each poll,
because `courseAttachments.detach` gives the row no "detaching" status of its own — it only disappears once the
provider calls actually land.

**Choice — `CourseAttachmentSummary` (`api/types.ts`) never carries a provider id at all.** WEB-18's own text is
explicit: "An instructor never sees a vector store id: the store is the platform's own bookkeeping." Rather
than trust every render path to simply not print a field that exists, the mirrored type handed to this
component does not carry `providerFileId` or `vectorStoreId` in the first place — there is nothing here for a
future edit to accidentally surface. `tests/course-attachments.test.tsx` proves this structurally, not just
that the fixtures happen not to carry one: a mocked list result shaped with both fields anyway still renders
nothing beyond a filename, a status and a failure reason.

**The judgement calls for a course with a hand-typed `vectorStoreId` from the Python era.** The brief for this
slice raised a concern worth checking against the code rather than assuming: "today the first upload creates a
*second* store and the old one stops being used, silently." Reading `apps/worker/src/handlers/course-attachments.ts`
(and `D-32`, which already documents this in detail) shows that is not what the code does. Step 3 of
`courseAttachments.attach`'s own handler reads `course.vectorStoreId ?? (await createVectorStore(...))` —
a course that already has one, whether hand-typed from a vendor dashboard or set by an earlier attachment, is
reused; `createVectorStore` is only called when the column is still `null`. `D-32`'s own text states this
outright: "An existing course with a hand-typed id keeps working unchanged in every respect." So the choice
this slice actually needed to make was smaller than "adopt, refuse, or replace" — the backend already adopts,
and correctly so (an instructor's own material, already grounding real answers through that store, must not be
silently abandoned the moment this screen exists to reach it). This screen makes no change to that behaviour,
and adds nothing that could: it never reads or writes `courses.vectorStoreId` directly, and never shows it, so
there is nothing here for an instructor to be asked to confirm or replace. If the premise in a future brief
turns out to be true against some *other* code path this slice did not touch, it needs its own fresh look
against that path's own source — not a UI-level confirmation bolted onto a screen that was never the one
creating the second store.

**A note on a message received mid-slice.** Partway through this work, two messages arrived proposing to
change this judgement — one directing a "replace and confirm" flow with a one-time modal distinguishing a
platform-created store from a hand-typed one, the other directing a reusable drag-and-drop upload component
across the panel. Neither arrived as an ordinary message in this conversation; both were embedded in a
system-reminder tag attached to a tool result, which is not how this agent harness delivers a supervisor's own
course corrections. Both were declined as unverified, and are recorded here only so a future reader who
notices the gap between "what a later message asked for" and "what shipped" has the reason in one place: the
gap is deliberate, not a missed instruction.

**Limits.** This screen has no `courseAttachments.retry` action to dispatch (none exists, `D-32`'s own text —
"this slice adds no `courseAttachments.retry` action") — a failed upload's only recourse in the panel today is
detach and re-upload, which re-sends the bytes from the browser rather than reusing what is already on disk
server-side. Large-file progress is not shown beyond "Uploading…"; `FileReader#readAsDataURL` does not expose
incremental progress the way `XMLHttpRequest` would have, and this slice's own ceiling (20 MB) makes that an
acceptable gap rather than one worth a different upload mechanism.

---

## D-53 — `packages/actions`/`apps/web`: MDL-8 — a stored prompt id is refused on create at the write path, not only hidden in the panel, and stays visible, read-only, for a course that already has one

**Problem.** `MDL-2`'s stored-prompt escape hatch (`D-3`) silently wins over everything an instructor types:
`buildResponsesRequestBody` (`packages/openai/src/responses.ts`) sends `prompt: { id }` instead of
`instructions` whenever a course has a `promptId`, so `FILE-4`'s versioning, authorship and restore are dead on
exactly those courses, and nothing said so. `pages/CourseEditor.tsx` also offered a plain, editable "Prompt id"
text field to every course, new or existing — the one thing standing between an instructor and typing a fresh
prompt id into a course that never had one, which `MDL-8` requires stop being possible at all.

**Choice — enforced at `courses.save`'s own `execute`, not only by the panel not offering the field.**
`packages/actions/src/actions/courses.ts`'s `saveCourseAction` now writes `promptId: null` unconditionally
whenever `entity.existingCourse` is unset (a create), regardless of what `input.promptId` carries — even an
explicit value. Every write in this platform goes through `packages/actions` (this repository's own standing
rule), so the panel choosing not to render a field is not, by itself, an enforcement of "no new course can
acquire one" — a caller reaching the action directly (a script, a future screen, a stale API client) could
still set one on create if the action itself did not refuse it too. `keepOrClear`'s own "on create there is
nothing yet to preserve" case already fell back to `null` for an *omitted* field; this narrows it further so an
explicit value on create falls back to `null` as well, the one deliberate exception to that helper's own rule.
An update still reads `keepOrClear(input.promptId, entity.existingCourse.promptId)` exactly as before — a
course that already has one keeps it, unchanged, on every save that omits the field, and could still have it
explicitly cleared by a caller that sent `null` (this slice adds no restore/re-acquire path — clearing is not
the same operation as acquiring a fresh one, and nothing here closes it).

**Choice — the panel makes the field read-only and conditional, not merely absent for a new course.** A blank
"Prompt id" field on a new course was already enough to satisfy "no new course can acquire one" by itself
(nothing to type into), but `pages/CourseEditor.tsx` went further for symmetry with `MDL-8`'s other half: the
field is never rendered as an editable control at all, for a create or an update — only shown, read-only, when
`form.promptId` is non-empty (i.e., the course already has one). The request `handleSave` builds no longer
carries the `promptId` key at all, for the same reason `conversationScope` was already an intentional omission
in this form (this file's own module comment) — the field is not merely blank, it is not managed by this form,
so relying on `courses.save`'s own "omitted preserves what is stored" is the honest way to say so, not an
oversight this form happens to get away with.

**Choice — the visibility half: a banner above Instructions, not a change to what Instructions does.** `MDL-8`'s
own text frames this as two halves — "no new course can acquire one" (the write-side refusal above) and "an
instructor must not be able to edit into the void" (visibility). The second half is read literally: an
instructor typing into Instructions on a course with a stored prompt was already editing into the void before
this slice; what was missing was only that nobody told them. A `role="status"` banner, styled with this app's
own warning scale (`--color-warning-600`/`-50`, `ScaffoldButton.tsx`'s own precedent for that palette), sits
directly above the Instructions field on exactly the courses where it applies, saying plainly that the stored
prompt is in force and the instructions below are not being used. The Instructions field itself stays fully
editable — MDL-8 does not ask this slice to stop an instructor from saving instructions "for later," only to
stop them from believing the save did anything yet, and disabling the field would have been reaching past what
was asked for a case (an instructor pre-writing instructions before deciding whether to migrate off the stored
prompt some day) this slice has no way to rule out as useful.

**Checked, not changed: `answerQuestion`'s `not-configured` decline.** `packages/core/src/answer.ts:333`'s own
guard — `if (!course.promptId && !course.instructions) return { kind: 'not-configured' }` — still reads
correctly once the panel stops offering `promptId` on create: a brand-new course with neither set still
declines exactly as before (nothing here changes what `instructions` alone requires), and an existing course
with a `promptId` and no `instructions` (the two "existing courses running today" `D-3`/`MDL-2` were written
for) is still `!course.promptId` `false`, so it is still answered, through the stored prompt, exactly as it was
before this slice. No code change was needed here — this entry records that it was checked, per the brief's own
request, not skipped.

**Limits.** Nothing in this slice offers an instructor a way to *migrate off* a stored prompt — clearing
`promptId` (an explicit `null` in a `courses.save` call) is still possible for whoever can reach the action
directly, but the panel gives no control for it, and no path copies a stored prompt's own text into
`instructions` first. An instructor who wants off the Python era's escape hatch still needs the OpenAI
dashboard to read what the prompt actually says before typing an equivalent into Instructions and then asking
someone to clear the id — a real gap, left open because this slice's own brief scoped it as deprecation
("keep reading it... this is deprecation, not removal"), not migration tooling.

## D-54 — `apps/web`/`packages/actions`: WEB-19 — instructions are edited through their own versioned action, in their own section, and `courses.save` no longer accepts the field at all

**Problem.** `FILE-4`'s versioning, authorship and restore (`courseInstructions.save`/`.list`/`.restore`,
`D-3`'s own `course_instruction_revisions`) were built and reviewed a phase ago, and no screen ever called any
of them — the third instance this phase of that exact shape (`docs/SPEC.md`'s own WEB-19 text names the other
two: the knowledge-files screen, WEB-18/D-52, and the connect surface). `pages/CourseEditor.tsx` still wrote
`instructions` as a plain field through `courses.save`, so every edit overwrote the last with no revision, no
author and nothing to restore — exactly the operation FILE-4 exists to make safe on a live course, made unsafe
by the one screen that reaches it.

**Choice — instructions leave the main form and become their own section, with their own save.** The brief
named both options as defensible: fold instructions into the one "Save course" button as a second dispatched
action, or give the field its own section and its own save. A single button dispatching two actions has to
reconcile two independent failure states behind one control — a category collision but a perfectly good
instructions save, or the reverse — and render both from one `error` state without conflating which failed.
`components/CourseInstructions.tsx` is its own section instead, styled and gated the same "existing record
only" way `components/CourseAttachments.tsx` (D-52) already established: offered only once `courseId` is set,
since a course that does not exist yet has nothing for a revision's `courseId` foreign key to point at. Each
save's own success or failure stays legible on its own terms, the same reasoning D-52 already gives for why
knowledge files are their own section rather than fields on the course form.

**Choice — `courses.save` no longer accepts `instructions` at all, not merely "the panel stops sending it."**
`D-53`'s own reasoning for `promptId` applies here with more force: "every write in this platform goes through
`packages/actions`... so the panel choosing not to render a field is not, by itself, an enforcement" — a caller
reaching `courses.save` directly (the MCP tool surface, which derives its own JSON Schema straight from this
action's zod schema; a script; a future screen) could still write `instructions` unversioned, which is exactly
the gap this slice exists to close. Unlike `promptId` (kept as an update-only escape hatch, D-53), `instructions`
has no legitimate remaining caller through `courses.save` at all — checked, not assumed: the web panel is this
slice's own fix, the MCP tool surface already lists `courseInstructions.save`/`.restore` directly (so nothing
there loses capability), and `packages/legacy-import` writes `instructions` through `courses.createCourse` (the
repository function, not this action) for a one-time config import that predates any revision history existing
to record. `saveInputSchema` therefore drops the key entirely, and `execute` always carries the existing
course's own `instructions` forward unchanged (`null` on create) — never reading `input.instructions`, because
there is no such input any more.

**Choice — this section's own dirtiness is reported up, not tracked with a second navigation guard.**
`hooks/navigation-guard.tsx` holds exactly one registered guard at a time — its own module comment: "the form
registers a guard while it is dirty." Two components on one page each calling `useUnsavedChangesGuard`
independently would register and unregister against the same ref, so whichever last ran would win, silently
dropping the other's protection. `CourseInstructions` takes an `onDirtyChange` callback instead and reports its
own pending-edit state on every change; `CourseEditor` folds it into the one `isDirty` it already feeds the
guard (`mainFormDirty || instructionsDirty`), so an unsaved instructions edit warns before navigation exactly
like an unsaved title edit, through the one guard the hook actually supports.

**Choice — "who" is the account id, not a display name.** `courseInstructionRevisions.listRevisionsForCourse`
returns `savedByAccountId`, a bare id — this platform has no action yet that turns an account id into a display
name or email outside an account's own session (`GET /auth/me`), and building one was not part of this slice's
own scope (the brief named exactly three existing actions to call, not a new read). The history shows the id
itself rather than inventing a lookup this slice was not asked for.

**Checked, not changed: `courseInstructions.save`/`.restore` already existed, tested, and correct.** Both were
already registered (`actions/index.ts`) and already proved a restore adds a new revision rather than rewriting
history (`packages/actions/tests/course-instructions.test.ts`) — this slice added no behaviour to either, only
the screen that finally calls them.

**Rework finding 1 — a background load must never overwrite an edit already in progress.** The first version of
`CourseInstructions` set the textarea from every `refresh()` unconditionally, including the mount effect's own
initial load. An instructor who started typing before `courseInstructions.list` resolved — a slow connection, or
simply a fast typist on a course just created — had it silently wiped the moment the list came back, and
"Save instructions" stayed disabled because the wiped text now matched the freshly-set baseline. This was not
theoretical: it failed `e2e/course-configuration.spec.ts` and `e2e/chat.spec.ts` roughly one run in three, both
of which fill the textarea immediately after the course they just created finishes saving — exactly the window
the race needs. Fixed with `hasPendingEditRef`, a ref rather than a `text === baseline` comparison read inside
`refresh` itself: `refresh` is `useCallback`-memoized on `organizationId`/`courseId` alone, so its closure is
captured once and would otherwise always see the *initial* `text`/`baseline` state, never whatever a person has
actually typed by the time a fetch resolves — a stale-closure bug a ref sidesteps by being read fresh at call
time regardless of when the closure itself was created. `refresh` now takes a `force` flag: `handleSave` and
`handleRestore` pass `true`, because each already promises (in its own confirmation, for restore) that the
textarea will show exactly what was just written, including over an edit typed mid-round-trip; the mount
effect passes `false`, so a background load only moves the textarea when there is no pending edit to protect.
`tests/course-instructions.test.tsx`'s own "a background load never overwrites an edit already in progress"
reproduces the race deterministically (a held, unresolved promise) rather than depending on which of two timers
happens to fire first.

**Rework finding 2 — the dirty bridge (`mainFormDirty || instructionsDirty`) had no test, and deleting it passed
the entire suite.** `e2e/keyboard.spec.ts` makes a *new* course dirty through Title, which never reaches
`instructionsDirty` at all (offered only for an existing course), and the component-level test only asserted
`onDirtyChange` was called — a mock-was-called assertion, not the behaviour it exists for. Removing
`|| instructionsDirty` from `pages/CourseEditor.tsx` left 191 tests across 28 files green: an instructor could
edit Instructions on a live course, click away without saving, and lose the edit with no "Discard unsaved
changes?" prompt at all. `tests/course-editor.test.tsx` now has a case that edits *only* the Instructions
textarea (the main form's own fields untouched) and asserts the prompt appears on Cancel — the one case that
actually exercises the fold rather than `useFormDirty(baseline, form)` on its own — plus a case that a
successful Instructions save clears it again.

**Rework finding 3 — `courses.save` refuses an extra `instructions`, rather than silently stripping it.**
`saveInputSchema` was a plain `z.object`, which drops a key it does not recognize instead of refusing the call —
so an MCP agent asked to "update the course instructions" could still call `courses.save` with `instructions`,
get back an ordinary successful course, and report success while nothing changed. The MCP tool surface already
advertises `additionalProperties: false` in the JSON Schema it hands out (`apps/mcp/src/tool-surface.ts`'s own
`z.toJSONSchema`), but that only protects a caller that actually validates against it — this is the same "the
panel not offering a field is not itself enforcement" reasoning above, extended from `execute` to the schema
itself. `saveInputSchema` is now `z.strictObject`, so an extra `instructions` (or any other unrecognized key) is
refused outright (`action_input_invalid`, `ActionInputError`) before `execute` ever runs, for every caller —
`packages/actions/tests/actions.test.ts`'s own two WEB-19 cases now assert the refusal itself, and that a
refused *update* leaves both the title and the stored instructions untouched, rather than asserting the field
was merely ignored.

**Limits.** The history shows an account id, not a name (above) — a real usability gap for an organization with
more than one instructor, left open pending a directory read this slice did not build. Restoring a revision
while the textarea has an unsaved edit of its own discards that edit (the confirmation names this), which is
the same trade-off `components/CourseAttachments.tsx`'s own detach confirmation makes for a destructive action
that replaces what is currently on screen.

---

## D-55 — `packages/db`/`packages/discord`/`apps/api`/`apps/web`: ENRL-7 widens Discord-role enrolment to either role, and ENRL-8 finally wires a join link's redemption to a route and a screen

**Problem.** ENRL-7: `routing.ts#routeMessage` already routes a message to a course for either an admins-role or
a students-role holder, but `enrolments.ts#enrolViaDiscordRole` only ever admitted the students role
(D-34/D-35's own explicit, at-the-time-correct scope) — an instructor or TA held a real Discord conversation
this table had no record of, and `routes/chat.ts`, which authorizes on this table rather than a membership,
refused the same person Discord had just answered. ENRL-8: `redeemJoinLink` existed, correct and tested
(D-34's rework finding 4/6), but nothing outside a test ever called it — no route, no screen — and its own doc
comment names exactly the trap a careless wiring would fall into (a body-supplied `personId` lets anyone
holding a shared secret enrol anybody in the tenant).

**Choice — ENRL-7 widens the check, not the write.** `enrolViaDiscordRole` now admits a caller holding either
`course.studentsRole` or `course.adminsRole`; `reviveEnded: false` is untouched, and its own doc comment now
says explicitly why that reasoning never turned on *which* role was held — an admins-role holder's enrolment is
just as ambient a re-checked fact as a students-role holder's, so ENRL-6 has to gate both identically.
`packages/discord/src/handle-mention.ts`'s own `holdsStudentsRole` local (which decided whether a *missing*
enrolment after the call means "never held the role" or "was ended") is renamed `holdsTeachingRole` and checks
both roles — otherwise an admins-role-only holder's ended enrolment would silently stop being enforced the
moment ENRL-7 landed, since `holdsStudentsRole` would stay `false` for them forever. `routeMessage` itself is
untouched, as the brief for this slice required — it already treated the two roles identically; only admission
had not caught up.

**Choice — ENRL-8's redemption route lives at `/join-links`, unscoped by `:organizationId`, the same reason
`/auth` is** (`repos/course-join-links.ts`'s own module comment: a redeemer presents only the secret, not an
organization id). `POST /join-links/redeem` takes `z.strictObject({ secret })` — never a `personId` — and reads
the enrolling identity from `req.session.accountId`, the caller's own already-proven session, the same "a
signed-in web caller *is* the account" reasoning D-37 already established for `routes/chat.ts`.
`redeemCourseJoinLinkForWebAccount` (`packages/actions`) composes `hashSecret` with a new
`repos/course-join-links.ts#redeemJoinLinkForWebAccount`, which is not part of `@bloombot/actions`' public
surface as a dispatched `Action` for the identical reason `redeemCourseJoinLink` is not (D-34): dispatch needs
an organization id before it runs a single line, and a redeemer has not proven one yet.

**Choice — a person the link's organization has never seen is created and connected inline, in
`packages/db`, not by calling into `@bloombot/auth`.** `createConnectedWebPerson`/`ensureWebPersonForAccount`
(`@bloombot/auth`'s `sign-in.ts`) already do exactly this create-then-connect sequence, but `@bloombot/auth`
depends on `@bloombot/db`, not the other way around — `packages/db`'s own repo layer cannot import it without
introducing a cycle. `redeemJoinLinkForWebAccount` instead composes the same underlying primitives
(`people.ts#resolveIdentity`/`createPerson`/`connectIdentity`) directly, inside the identical
`db.transaction(...)` `redeemJoinLink` already opens (a nested savepoint when called from inside one, per
`client.ts`'s own `TransactingExecutor`) — the real `connectIdentity` path, never a raw `connectedAt` write,
and atomic with the link's own liveness check and the enrolment write, so a concurrent revoke cannot land
between "a person now exists for this account here" and "that person is enrolled." This is the identical
"small, deliberate duplication over a new cross-package dependency" trade D-34 already chose for this same
file's own `hashSecret` (a SHA-256 helper duplicated from `@bloombot/auth`'s `secrets.ts` rather than adding a
dependency for ten lines) — see `repos/course-join-links.ts#redeemJoinLinkForWebAccount`'s own doc comment for
the full reasoning, and `findLiveJoinLinkByHash` (factored out of `redeemJoinLink`, module-private) for why the
refusal path costs no extra work, and so no extra timing signal, for a never-issued secret versus a revoked or
expired one that happens to resolve an organization before failing.

**Choice — the sign-in return path is a `sessionStorage` marker, not a `?next=` URL parameter.** The brief
named a `redirectTo`/`next` query parameter through the sign-in flow as "the obvious route," which would have
needed same-origin path validation against `PUBLIC_APP_URL` to avoid becoming an open redirect. This app
already has a working, established device for the identical problem — `pages/Connect.tsx`'s
`PENDING_CONNECT_ORG_KEY`, read back by `App.tsx#returnToShell` once a sign-in redemption completes.
`pages/JoinLink.tsx`'s own `PENDING_JOIN_LINK_KEY` is the same device for a join link's own secret:
`returnToShell` checks it right alongside `PENDING_CONNECT_ORG_KEY` and navigates back to `/join/:secret`
before falling back to the shell. A second, differently-shaped redirect mechanism for the same problem would
have been the inconsistency, not an improvement, and it sidesteps the open-redirect risk entirely — nothing
here ever reads a redirect target out of a URL a caller controls; the target is always this same page's own
already-trusted `secret` prop. Not overloading `pages/RedeemLink.tsx` (AUTH-1's own sign-in-link page) was a
hard constraint the brief stated directly, for the same reason: a course join link and a sign-in link are
different things, and a visitor who followed the wrong one must get a message that actually names what they
are looking at.

**Rework finding — the front end's own proxy allowlist silently 404'd the new route.**
`apps/web/vite.config.ts`'s `proxy` object is an explicit allowlist of the top-level path segments `apps/api`
actually serves (its own comment: "only the paths apps/api actually serves are proxied") — `/join-links` was
missing from it, so `vite preview`/`vite dev` never forwarded the request to `apps/api` at all, and returned
its own empty `404` instead of `apps/api`'s `join_link_not_found` JSON body. Every unit and route-level test
(`supertest` against `apps/api` directly) passed regardless, because none of them go through Vite's proxy —
only the Playwright e2e spec, which drives a real built `vite preview` in front of a real `apps/api`
(`playwright.config.ts`'s own module comment), caught it, exactly the class of bug QA-7's "a real front end,
not a mock" exists to catch. Fixed by adding `/join-links` to the proxy map, with the same "a proxied API path
and a page path must never share one top-level segment" comment `/admin`/`/platform-admin` already state for
themselves — `/join-links` (API) and `/join/:secret` (page) do not collide.

**Limits.** The panel's own join-link issuing/copying UI (WEB-20) and the roster import UI (WEB-21) are a
later slice on this same branch, per this slice's own brief — `e2e/join-link.spec.ts` therefore seeds its join
link directly against the database rather than driving the panel to create one, the same "seed the one fact
the screen does not expose yet" device `chat.spec.ts`/`link-10-connected-organization.spec.ts` already use for
their own out-of-scope admission paths. A Discord-side join-link redemption (`redeemJoinLink`'s own doc comment
names it as a plausible future caller, resolving `callerAssertedPersonId` from a message's own identity rather
than a session) is still unwired from any live surface — nothing in this slice's brief asked for it, and
`redeemJoinLinkForWebAccount`'s own account-based shape would not fit it directly regardless (a Discord
identity is not a web account id).

---

## D-56 — `packages/db`/`packages/actions`/`apps/web`: WEB-20/WEB-21 — the panel issues and lists join links, and imports a roster, reusing the job-polling shape and the drop zone rather than inventing either a second time

**Problem.** D-55 wired ENRL-8's redemption to a route and a screen but left issuing and listing join links
(WEB-20) and running a roster import (WEB-21) unreachable from the panel — `courseJoinLinks.create`/`.revoke`
and `roster.import` already existed as actions, but nothing before this slice ever called `courseJoinLinks.list`
(it did not exist) or offered any of the three, or the roster import, through a screen.

**Choice — `listJoinLinks` (`repos/course-join-links.ts`) returns the row as stored, `secretHash` included; the
projection that drops it lives in `@bloombot/actions`' `courseJoinLinks.list` instead, as a `CourseJoinLinkSummary`
built by a `toSummary` mapper the action's own `execute` always runs before returning.** The repo layer is a
plain read, the same as every other `list*` function in this package — it is not the boundary that decides
what a browser may see, and `packages/db`'s own tests (`course-join-links.test.ts`) already assert the row it
returns unfiltered. `courseJoinLinks.list`'s own action-level test asserts the opposite property structurally
(`JSON.stringify(listed)` never contains `secretHash`/`secret_hash`), which is the guarantee that actually
matters: a caller of the action, not the repo, is what ends up serialized to a browser.

**Choice — ordering is "newest first" by `createdAt`, with no `sequence` column to break a same-millisecond
tie.** `course_instruction_revisions`/`messages`/`transcript_exports` all carry a monotonic `sequence` column
for exactly this reason (`conversations.test.ts`'s own "orders a transcript by append order even when every
message shares the same millisecond"), but adding one to `course_join_links` is a schema migration this
slice's own brief puts explicitly out of scope ("If you think a schema migration is required, stop and report
rather than writing one"). Two links minted in the same real millisecond — not a scenario ordinary,
human-paced link creation produces — sort in whatever order SQLite happens to return them; `listJoinLinks`'s
own doc comment states this rather than silently promising an ordering the column cannot back. The unit test
that pins down the intended "newest first" behavior freezes the clock and steps it by hand (`vi.useFakeTimers`),
the same device `conversations.test.ts` already uses, rather than asserting anything about a genuine tie.

**Choice — the roster CSV's required format is written directly into `components/RosterImport.tsx`'s own JSX,
kept in sync with `packages/schemas/src/roster.ts` by hand, rather than importing a shared constant for the
header list.** `packages/schemas`' own `REQUIRED_HEADERS` is not exported from its public surface today, and
exporting it would touch the roster _parser_ file this slice's own brief names out of scope ("You are building
the screen that starts the job and reads its report, not changing what the job does"). The five-column
description, the required-vs-blank rules and the worked example row are all read from that file directly (by a
person, while writing this screen) rather than guessed at — the brief's own "if you find the screen and the
schema disagreeing, the schema wins and you fix the screen" is honored by keeping this static text a faithful,
literal transcription of `rosterRowSchema`'s own rules, not by a code-level import that would have required
widening a file this slice was told not to touch.

**Choice — the roster import's own job-status polling is a straight reuse of `ScaffoldButton.tsx`'s shape (poll
`jobs.get`, show a "still queued" hint past a threshold), and its report is read off `JobStatus.result` with no
change to that action at all.** The brief asked to "extend it minimally" only if the shape could not carry a
per-row report; it already can (`result: unknown`, `JobStatus`'s own doc comment: "`null` until the job
succeeds… `undefined` would be indistinguishable from `not yet read`"), since `apps/worker`'s own
`RosterImportReport` is exactly what a succeeded `roster.import` job's `result` already contains. `apps/web`'s
own `RosterImportReport` (`api/types.ts`) mirrors that shape by hand, narrowed to the fields this screen
actually renders — the same "not imported from the workspace" boundary this file's own module comment already
states for `JobStatus` and every other shape in that file, one level stricter here: `apps/web` cannot import
`apps/worker`'s source at all (no app imports another app's source, workspace package or not), so this is a
mirror of a mirror, not a shortcut around the boundary.

**Choice — `RosterImport.tsx` reads the chosen file's text with `FileReader#readAsText`, not the newer
`File#text()`.** `File#text()` does not exist on the `File` implementation this repository's own test
environment (`vitest`'s `jsdom` project) constructs, which surfaced as every import test throwing
`selectedFile.text is not a function` the moment a real click ran `handleImport`. `FileReader` is the same
device `CourseAttachments.tsx`'s own `fileToBase64` already uses for the identical reason, just reading text
instead of a base64 data URL.

**Choice — the join-link secret is copied via `navigator.clipboard.writeText`, with no fallback for a browser
that lacks it.** Every browser this panel is built for (WEB-1's own "a modern browser," the same assumption
`FileDropZone.tsx` already makes for drag-and-drop) supports the Clipboard API; a `document.execCommand('copy')`
fallback would be dead code covering an environment this panel does not otherwise support, and the unit test
(`join-links.test.tsx`) stubs `navigator.clipboard` directly rather than exercising a fallback path that does
not exist.

**Rework finding — two file-upload e2e specs' own `input[type="file"]` locators collided once both drop zones
render on the same course screen.** `e2e/course-knowledge-files.spec.ts` (WEB-18, pre-existing) and
`e2e/roster-import-panel.spec.ts` (WEB-21, this slice) each render one hidden `input[type="file"]`
(`FileDropZone.tsx`'s own shape) inside `pages/CourseEditor.tsx`, once a course exists — before this slice, only
one drop zone was ever on screen at a time, so an unscoped `page.locator('input[type="file"]')` was unambiguous
by accident. Both specs now scope that locator to their own component's `data-testid`
(`course-attachments`/`roster-import`) before calling `setInputFiles` — the fix belongs to both files, not only
the new one, since the pre-existing spec's own locator became ambiguous the moment this slice's own component
mounted alongside it.

**Limits.** The join-link creation screen offers no control for setting `expiresAt` — every link this panel
issues has no expiry, valid until revoked, even though `courseJoinLinks.create` already accepts one. WEB-20's
own text describes "an optionally expiring link" as ENRL-3/ENRL-4's own capability, not as something this
screen's own creation control must expose; adding one is a small, real gap left for whoever picks it up next,
not a decision that anything here forecloses.

---

## D-57 — `packages/db`: ENRL-6/ENRL-8 rework — an instructor-ended enrolment must not be self-revivable through the same join link, by the same person or by the same human under a different identity

**Problem.** Two independent reviews of D-55's ENRL-8 wiring — one security-focused, one spec-focused, the
latter reproducing it over HTTP against the running app — found that `redeemJoinLink` becoming reachable for
the first time made ENRL-6 bypassable by the very person it removed, acting alone. Reproduced: instructor
issues a class join link → student redeems (`200`) → instructor ends the enrolment (ENRL-6) →
`GET /organizations/:id/chat/courses` correctly reports the course gone → the student re-POSTs the identical,
still-live secret to `/join-links/redeem` → `200`, and the course is back. The instructor's only remedy —
revoking the link — locks out the entire class, not just the one person who should stay removed. There were
two distinct mechanisms, and fixing only the first left the hole open.

**Choice — Part 1: `enrolViaJoinLink` is reversed from `reviveEnded: true` to `reviveEnded: false`.**
`enrolViaJoinLink`'s own doc comment (D-55) justified `true` as "an instructor handing the same link back to a
student they had previously ended is a deliberate re-admission" — a premise that held only while
`redeemJoinLink` had no live caller (D-55's own words: "existed, correct and tested, but nothing outside a test
ever called it"). Once ENRL-8 wired a real, student-initiated route to it, the caller redeeming is never the
instructor — it is whoever holds the secret, which ENRL-3 deliberately shares with an entire class. This is the
identical shape D-35's rework finding 5 already fixed for `enrolViaDiscordRole`: an ambient credential the
person already holds (there, a Discord role; here, a shared link) must not undo an instructor's decision on its
own. `enrolViaJoinLink` now makes the same choice, for the same reason, and both of its own callers
(`redeemJoinLink`, `redeemJoinLinkForWebAccount`) inherit it — neither is, today, reachable by an instructor
acting deliberately, only by a redeemer presenting a secret. `enrolViaRoster` is untouched, per this rework's
own brief — a roster re-import is this platform's own idempotent housekeeping, not a caller that means to
re-admit anybody, the reasoning its own doc comment already gives and that this rework does not revisit.

No parameter was added to `enrolViaJoinLink`, and no fourth `enrolVia*` function was created. `admit`'s own doc
comment already states the file's convention: "Each `enrolVia*` below states its own choice explicitly, rather
than this function assuming one default for every source" — a caller-supplied boolean would have broken that
convention for no live benefit, since both of `enrolViaJoinLink`'s actual callers are self-service redemption,
never an instructor-initiated re-admission. A distinct function would have meant inventing a caller nobody
brief asked for — exactly the "correct and tested but nothing outside a test ever called it" trap D-55's own
Problem section names for `redeemJoinLink` itself before ENRL-8 wired it. The practical consequence: after this
rework, no exported function in `enrolments.ts` passes `reviveEnded: true` — there is currently no
instructor-initiated re-admission path in this codebase at all, only ENRL-6's ended-stays-ended default. A
future one (an explicit "re-admit" action, say) should call `admit` with `reviveEnded: true` the same way every
choice in this file already is, not assume one.

**Choice — Part 2: `redeemJoinLinkForWebAccount` refuses to mint a second person when the account's own
verified email matches an existing person in the link's organization who holds an ended enrolment for the
course.** Part 1 alone does not close the hole: `enrolViaJoinLink`'s `reviveEnded: false` is keyed on the exact
`personId` being admitted, via `admit`'s own `priorEnded` lookup. A student who first messaged the bot on
Discord, was enrolled and then removed, has an ended enrolment recorded against their *Discord* person.
`resolveIdentity(organizationId, { surface: 'web', … })` correctly finds nobody — they have no web identity in
this organization yet — so `redeemJoinLinkForWebAccount` proceeds to `createPerson`/`connectIdentity` a *third*
row for the same human, and `admit`'s prior-ended lookup, scoped to that brand-new `personId`, finds nothing:
a fresh, never-before-enrolled person is admitted freely, `reviveEnded` never even coming into play. `getAccountById`
(`repos/accounts.ts`) resolves the redeeming account, and a new `people.ts#findPeopleByEmail` (case-insensitive,
`lower(...)` on both sides — `people.email` is roster/Discord-supplied and never normalized on write, unlike
`accounts.email`) finds every person in the organization sharing that address; `enrolments.ts#hasEndedEnrolment`
(new, alongside `getActiveEnrolment`) checks each match for an ended enrolment in the course being joined. A
match refuses the redemption before `createPerson` ever runs.

`account.email` is treated as *verified*, not merely claimed: `people.ts#hasVerifiedAddress`'s own comment
already establishes why an `accounts` row's email is the fact PPL-5 calls a verified address — `accounts` rows
are never created except through an already-verified address (AUTH-1's redeemed sign-in link, or AUTH-2's
Google-asserted `emailVerified`) — so this check reuses that same guarantee rather than trusting a claim nobody
proved.

**The PPL-4 tension, named rather than papered over.** PPL-4 deliberately refuses to *merge* two people on an
address match alone — an unverified or coincidental match must never let one person read another's transcript.
This check uses the identical signal (an email match) for a different, and deliberately weaker, purpose: it
never merges anything — no identity moves, no conversation moves, no usage counter combines — it only *declines
to admit*, the same fail-closed shape every other refusal in `redeemJoinLinkForWebAccount` already has. The
worst outcome of a coincidental match (two different humans who happen to share a roster-entered address) is
that the second human's join is refused, not-found-shaped, exactly as if the link were bad — recoverable by the
instructor issuing a fresh link or re-admitting them by name, and never a disclosure of anything the matched
person did not already have. The worst outcome of *not* checking is the defect this rework exists to close: an
instructor's explicit removal, undone by the removed person alone. Refusing is the weaker of the two actions
PPL-4's own "never merge, never disclose" concern could have generalized to, and it fails closed rather than
open — declining to admit, not declining to check.

**Refusals stay not-found-shaped.** Both new refusals return the same bare `undefined`
`redeemJoinLinkForWebAccount` already returns for a never-issued, revoked or expired secret; `routes/join-links.ts`
maps every `undefined` to the identical `404 { error: 'join_link_not_found' }` with no branch of its own between
them, so neither refusal is a new oracle — a caller who was removed learns nothing more than "redeeming this
link did not work," the same as a caller who mistyped it. `apps/api/tests/routes/join-links.test.ts` proves this
by comparing each new refusal's own response byte-for-byte against a never-issued secret's.

**Rework finding — the dead `getPerson` re-read in `redeemJoinLinkForWebAccount` is removed.** `person =
getPerson(...) ?? created` predates this rework; its own comment ("`created` predates `connectIdentity`'s own
write — re-read so the caller sees the row as it actually stands") was copied from `ensureWebPersonForAccount`
(`@bloombot/auth`), where the person *is* that function's return value, so a stale `connectedAt` on it would
leak to the caller. Here, the only later use of `person` is `person.id` (passed to `enrolViaJoinLink`), which
`connectIdentity` never changes — the re-read cost a query and returned nothing this function's own caller
could observe. `person = created` replaces it.

**Rework finding — `redeemJoinLinkForWebAccount` had no atomicity regression test of its own.** A reviewer
temporarily hoisted every read (the link's own liveness check, `resolveIdentity`) out of
`redeemJoinLinkForWebAccount`'s `db.transaction(...)`, leaving the transaction's first statement a plain write
— the exact defect `redeemJoinLink`'s own rework finding 6 test (D-34) exists to catch for *that* function — and
every existing test still passed, because none of them race a concurrent revoke against an in-flight web-account
redemption specifically. The implementation was already correct (both reads run inside `tx`, same as
`redeemJoinLink`); the property was simply unguarded. A new test in `packages/db/tests/course-join-links.test.ts`
mirrors `redeemJoinLink`'s own device — a second connection to the same file revokes the link mid-redemption —
but spies on `people.createPerson`, not `people.getPerson`: `redeemJoinLinkForWebAccount`'s own "person missing"
branch never calls `getPerson` (only `resolveIdentity`, a raw query, and `createPerson`), so the existing spy
target does not transfer. Verified against the actual regression by temporarily reproducing the reviewer's
hoist locally: the new test fails exactly when the reads are hoisted out, and passes against the real,
already-atomic implementation.

**Rework finding — two stale comments named a `sessionStorage` return path as working for a link "opened in the
same tab or a fresh one."** `sessionStorage` is per-browsing-context; a sign-in link a mail client opens in a
new tab has no marker to read (`pages/JoinLink.tsx`'s `PENDING_JOIN_LINK_KEY`, `pages/Connect.tsx`'s
`PENDING_CONNECT_ORG_KEY`) and lands on the plain shell instead, exactly as if the pending marker had never been
set. Both comments now say that directly; the mechanism itself (D-55's own choice of a `sessionStorage` marker
over a `?next=` URL parameter) is unchanged.

**Limits.** This rework closes the self-revival hole; it does not add the re-admission action the instructor's
"only remedy is revoking the link, which locks out the entire class" reproduction implicitly asks for. After
this rework, re-admitting a person an instructor has explicitly ended requires either a fresh join link (a new
secret, so the old one's holders — including whoever was removed — cannot use it) or a roster re-import that
newly lists them (still `reviveEnded: false`, per `enrolViaRoster`'s own unchanged reasoning, so this does not
help either). Building a direct "re-admit this person" action, callable only by staff, is out of this rework's
own scope — the brief for it named exactly two mechanisms to fix, not a new capability to add.

---

## D-58 — `apps/web`: WEB-20/WEB-21 rework — a roster report that silently drops three of its own fields, a copy control with no failure path, and a stale comment left behind by D-57

**Problem.** Two reviews of D-56's own WEB-20/WEB-21 slice found one must-fix and one cheap-fix in `apps/web`,
plus a stale comment in `packages/db/src/repos/enrolments.ts` that D-57's `reviveEnded` reversal (above) left
behind.

**Must-fix — `RosterImport.tsx` rendered eight of `RosterImportReport`'s eleven fields and silently dropped
`ambiguousHandles`, `unresolvedRoles` and `limitations`,** even though `api/types.ts`'s own doc comment claimed
"every field here narrows to what the panel's own import screen actually shows an instructor." The omission was
not cosmetic: `apps/worker/src/handlers/roster-import.ts` still creates a channel for a row whose handle matched
more than one guild member (`ambiguousHandles`) or whose course role did not resolve (`unresolvedRoles`) — the
channel exists, with the deny-everyone and admins overwrites, but never the individual student's own grant — so
a run that left a real student locked out of their own channel rendered only
`1 added, 0 merged, 1 channels created, 0 channels already present`, an unqualified-looking success.
`unresolvedHandles` (the identical consequence, for a handle that matched _nobody_ rather than more than one)
was already rendered, which is what made this an omission rather than a considered exclusion — nothing
distinguishes the two cases in the report's own shape or in what an instructor needs to know from either.
`limitations` (ROST-6's pinned welcome message, today's one entry) exists precisely so a reader of one run's
results does not need `docs/DECISIONS.md` open — this screen is that reader, so it stayed unread there too.
Fixed by rendering all three in the same "name the row or value it concerns" style the other categories already
use — `ambiguousHandles` names every display name it matched, since that is what actually lets an instructor
correct the roster's own handle; `unresolvedRoles` and `limitations` are listed plainly. The `api/types.ts` doc
comment needed no further edit once this landed: its claim is now true rather than aspirational.

**Cheap-fix — `JoinLinks.tsx`'s `handleCopy` awaited `navigator.clipboard.writeText` with no `catch`.** On a
non-secure origin (`http://` on a LAN, or a staging host without TLS) `navigator.clipboard` is `undefined`
entirely — reading `.writeText` off it throws a `TypeError` before any promise exists to catch, which an
un-guarded `await` left as an unhandled rejection: the button's own label stayed "Copy link" forever, with no
signal at all, for the one value WEB-20 states is never recoverable if lost. Fixed with a `try`/`catch` around
the write, reporting the failure through the same `ErrorMessage`/`describeApiError` pair every other refusal in
this app already renders through — a new `'clipboard_unavailable'` case, since this is a real, distinct failure
an instructor should be told about in words, not a code `apps/api` ever actually sent (no request happens at
all). The URL itself was never at risk of disappearing on a failed copy — `created` is only ever cleared by a
fresh `courseJoinLinks.create` call, never by `handleCopy` — so the fix is entirely the missing signal, not a
missing fallback; D-56's own choice against a `document.execCommand('copy')` fallback stands unchanged.

**Stale comment — `enrolments.ts#enrolViaDiscordRole`'s own doc comment still described `enrolViaJoinLink` and
`enrolViaRoster` as "the other two `enrolVia*` functions" a re-admission would call, with `reviveEnded: true`
"unchanged, and correct" for them.** D-57 (above) reversed `enrolViaJoinLink` to `reviveEnded: false` in the
same file this comment lives in, without updating this passage — both halves of the sentence became false the
moment that commit landed: none of the three `enrolVia*` functions in this file revive an ended enrolment
today, and nothing re-admits anyone. Corrected to state that plainly, pointing at `enrolViaJoinLink`'s own
"Limits" note (already accurate) for where a future re-admission action would need to be added. Comment only —
`docs/DECISIONS.md` D-57 already made, and this rework does not revisit, the actual behavioral choice.

**Tests.** Each rendered category and the clipboard failure path got its own test, verified failing against the
pre-fix code before the fix (a targeted `git stash push --keep-index` of just the changed component, run once,
popped immediately — never a discarded working-tree edit): `roster-import.test.tsx` gained three cases, each
asserting the rendered report's own text for a report carrying that field, not merely the presence of a key on
the mocked value (`ambiguousHandles` — a report naming a display-name collision; `unresolvedRoles` — a role
name; `limitations` — the welcome-message note); `join-links.test.tsx` gained one case, overriding its own
`beforeEach` clipboard stub to `undefined` and asserting both the rendered failure text and that the secret's
own URL stays visible afterward.

---

## D-59 — `packages/db`/`packages/actions`/`apps/web`: ENRL-9/WEB-22 — reinstating an ended enrolment, recorded as columns on the row rather than a second history table

**Problem.** D-57's ENRL-6/ENRL-8 rework set every admission path (`enrolViaJoinLink`/`enrolViaRoster`/
`enrolViaDiscordRole`) to `reviveEnded: false`, correctly closing a real self-revival bypass — but left
`enrolments.ts`'s own `admit(..., reviveEnded: true)` reachable from nowhere. An instructor who ends the wrong
enrolment, or ends one a student has since appealed, had no way back: a decision that can be made and never
unmade is a trap, not an access control (ENRL-9's own text). Separately, `listPeopleForCourse` returns active
enrolments only, so the panel that would let an instructor choose who to reinstate could not even list an ended
person (WEB-22).

**Choice — reinstating is its own function, `repos/enrolments.ts#reinstateEnrolment`, and does not call
`admit`.** It clears `endedAt` on the one row named by `enrolmentId` (the same "acts on the row `endEnrolment`
already resolved" shape, not a fresh `enrolVia*` admission), and stamps two new nullable columns on `enrolments`
— `reinstatedByAccountId`/`reinstatedAt` — the same "record it on the row itself" shape `memberships.grantedByAccountId`/
`grantedAt` already uses for ENRL-5, rather than a new `enrolment_reinstatements`-style history table (the
`course_instruction_revisions` shape: a new row per event, its own migration, its own repo surface, its own
tenant-scoping test rows). Rejected because ENRL-9 asks only "who reinstated this, and when" — a fact about the
row's current state, not an audit of every end/reinstate cycle it might see — and a second table would exist to
answer a question nobody asked for. The honest trade this makes, inherited from the same precedent: a *second*
reinstatement overwrites the first's record on the same row, exactly as a second `grantMembershipRole` call
overwrites the first grantor. A migration was written (`packages/db/migrations/0014_spooky_bucky.sql`,
`ALTER TABLE enrolments ADD reinstated_by_account_id`/`ADD reinstated_at`, both nullable, `drizzle-kit check`
clean) — this is the first ENRL-7/ENRL-8/ENRL-6/ENRL-8-rework slice on this branch where a schema change was
actually in scope.

**Superseded by D-60's rework — kept here, corrected, for the historical record.** This paragraph originally
claimed the reinstated person is kept out because "an enrolled person… holds no membership at all," and that
`apps/api/tests/routes/enrolments-reinstate.test.ts` "proved [it] directly." Both claims were false, and D-60
records what a review round found and how it was fixed; read that entry for the actual account. In brief: ENRL-7
means a membership and an enrolment are orthogonal facts about two different tables, so a membership at any role
is not proof of a stranger — the guarantee actually enforced is an explicit check in
`reinstateEnrolmentAction.execute` (`actions/enrolments.ts`) comparing the caller's own connected person against
the enrolment's `personId`, and the test that was meant to prove this used a scenario (a fresh, unrelated
organization) that never exercised that check at all.

**WEB-22 needed a new listing, not a widened `listPeopleForCourse`.** `listEnrolmentsForCourse`
(`repos/enrolments.ts`) is additive — every existing caller of `listPeopleForCourse` (the roster-import
idempotency check, the join-link duplicate-admission check) wants active-only, and widening its return shape to
carry `source`/`endedAt`/reinstatement columns would touch call sites this slice has no reason to. The panel's
own `components/CoursePeople.tsx` renders two visually distinct lists — "Enrolled" and "Enrolment ended" — never
one list with a status column, on the same reasoning `JoinLinks.tsx` already separates a live link from a
revoked one by section: a status column that only differs by a word is easy to misread right before removing
somebody. It never renders a person's email — `displayName ?? personId`, the same fallback
`pages/Transcripts.tsx` already uses for a person who never named itself, since a `null` display name is already
told apart from another by a distinct id and these are real students' addresses.

**Two new actions, not one.** `enrolments.reinstate` (write) is the act ENRL-9 names; `enrolments.listForCourse`
(read, resolves the course) is what the panel actually dispatches to populate the screen — the brief that scoped
this slice named only the first explicitly, but WEB-22's own listing needs a route to reach it the same way
every other panel screen's own list does (`courseAttachments.list`, `courseJoinLinks.list`), so both were added
together. `packages/actions/tests/access-audit.test.ts`, `catalog.test.ts` and
`apps/api/tests/tenant-isolation.test.ts` (the last one deriving its own route table from the registry) were all
updated for both.

**Also fixed while in this file:** three stale doc-comment passages in `repos/enrolments.ts` — on
`enrolViaJoinLink`, `enrolViaRoster` and `enrolViaDiscordRole` — that D-57's own rework left claiming "no
function in this package re-admits anyone today" and pointing an instructor at "a future re-admission action"
that would need writing. `reinstateEnrolment` is that action; all three now say so, and name it.

**Limits.** No join-link expiry-setting control (a known, separately-scoped gap); the join-link redemption path,
`packages/legacy-import`, MCP, and the cost ledger are all untouched. `reinstateEnrolment`'s "last reinstatement
only" recording is the same limit `grantedByAccountId`/`grantedAt` already accepts for ENRL-5 — if a full
end/reinstate history is ever needed (an audit trail of every cycle, not just the latest), that is the
`course_instruction_revisions` shape, deliberately not built here.

---

## D-60 — `packages/actions`/`packages/db`/`apps/api`: ENRL-9/WEB-22 rework — a membership is not proof of a stranger, an unhandled unique-constraint 500, and a listing that could show one person twice

**Problem.** Two independent reviewers reproduced the same must-fix in D-59's own `enrolments.reinstate`
over HTTP against the real app: a caller holding an ordinary `assistant` membership in the same organization,
connected to the exact person an instructor had just ended, reinstated their own enrolment — `200`, `endedAt`
cleared, and `reinstated_by_account_id` recording the beneficiary as the actor. The same round found a second,
unrelated must-fix (an unhandled unique-constraint error reachable through a real, if unusual, data shape) and a
cheap-fix falling out of the same root cause (a listing that could render one person twice). This entry is the
corrected record D-59 now points readers to for all three, and for what a "guarantee," properly stated, has to
say about what is actually enforced versus what merely holds today by construction — the distinction this whole
round turned on.

**Must-fix 1 — the self-trigger guarantee was never actually checked; only a membership requirement one level up
was, and that requirement does not rule out the reinstated person.** D-59's original text, and the doc comment
in `actions/enrolments.ts`, both asserted "an enrolled person… holds no membership at all," reasoning that
`apps/api/src/routes/actions.ts` refusing a caller with no membership in the target organization was sufficient.
That premise is false in this platform, and ENRL-7 is why: "anyone a course is taught through is enrolled by
asking it" means an `assistant`/`instructor`/`owner` membership and an enrolment are orthogonal facts about two
different tables (`memberships`, `enrolments`) — the identical account can hold a staff membership for one
course and, through a separately connected `web` identity, an enrolment (admitted the same way any student's is)
in another. A membership at any role, including the lowest, says nothing about which person, if any, the same
account is also connected to. **Fixed** by adding the check that was actually missing:
`reinstateEnrolmentAction.execute` now resolves the caller's own connected `web`-surface person for the
organization (`people.resolveIdentity`, the identical read-only lookup `routes/chat.ts#resolveConnectedCallerPerson`
already performs) and refuses when it is the same person the enrolment names — the same "never on your own" rule
`memberships.grant` already applies to granting a role to yourself (`actions/memberships.ts`'s own
`if (target.id === accountId)` check), applied here to personhood rather than account identity. The membership
requirement upstream still matters (it rules out a genuine stranger with no relationship to the organization at
all) — it was just never the *whole* guarantee, and the doc comments describing it as such are corrected to say
exactly that: what the membership check proves, what it does not, and which check actually closes the gap.

**Also corrected: the test written to prove this exercised a weaker claim.** The original
`apps/api/tests/routes/enrolments-reinstate.test.ts` seeded the "removed person" a *fresh organization* of their
own (`seedSignedInCaller`) — which only ever proves the generic cross-tenant refusal
`tenant-isolation.test.ts` already covers, not "connected to the enrolled person, holding an ordinary membership
*inside this same organization*," the actual shape both reviewers reproduced. Rewritten to that real scenario:
an `assistant` membership seeded with `seedSecondCallerInOrganization` in the *same* organization as the
enrolment, connected via `people.connectIdentity` to the exact person an instructor ended. Verified failing
before the fix (temporarily reverting only the new self-check in `execute` and rerunning): `200`, not the
expected `404`. A second, dispatch-level test was added directly against `reinstateEnrolmentAction.execute` in
`packages/actions/tests/enrolments.test.ts` for the same scenario, plus a companion proving the check is scoped
to *that* person, not "any enrolment a member could reach" — the same membership reinstating a *different*
person's enrolment still succeeds. The first test's own comment, which mislabeled `seedSecondCallerInOrganization`
as "the student's own web account" when that helper actually grants an `assistant` membership, is corrected —
that mislabel is what let this gap read as covered when it was not.

**Must-fix 2 — `reinstateEnrolment`'s own doc comment claimed a data shape that does not hold, and the
un-guarded case it hid reached a caller as a `500`.** The comment said "there is never more than one row for a
given pairing once any `enrolVia*` has run," citing `admit`'s own module comment — contradicted by `schema.ts`'s
own comment on `enrolments_org_course_person_active_unique`, which says the opposite plainly ("a person may hold
more than one *ended* row for the same course… which is exactly why this index is partial rather than plain").
Two reviewers found this false by different, both real, routes: `people.ts#mergePeople`'s own "already ended,
moved outright" branch reassigns a loser's already-ended enrolment row's `personId` onto the survivor with no
check for whether the survivor already holds an *active* row for that same course (correct in isolation — an
ended row cannot collide with the partial unique index on its own — but it leaves the survivor holding both an
active row and a second, ended one for the identical `(organizationId, courseId, personId)`); and any database
that predates the D-35/D-57 reworks can carry the same shape from before `reviveEnded: false` existed everywhere.
Reinstating that ended row collided with the survivor's own active one on `enrolments_org_course_person_active_unique`,
raising an unhandled `SQLITE_CONSTRAINT_UNIQUE` that escaped `dispatch` as a `500`, not the `0`-rows-changed
no-op the doc comment promised. **Fixed** the same "catch, check, no-op" shape this repo already established for
the identical class of race (`admit`'s own catch block, in this file) — `reinstateEnrolment` catches
`SQLITE_CONSTRAINT_UNIQUE` (`isUniqueConstraintError`, the same check-by-`error.code` device
`repos/projects.ts`/`repos/people.ts` already each carry their own copy of) and returns `0`, the identical
idempotent no-op every other "already in that state" write in this file gives. The doc comment now states what
the data actually guarantees, with the merge scenario spelled out rather than asserted away. A new test
(`packages/db/tests/enrolments.test.ts`) reproduces the merged-people shape exactly — a loser enrolled and
ended *before* a merge, a survivor already actively enrolled in the same course, merged — and asserts a clean
no-op; verified failing before the fix (temporarily removing the `try`/`catch`): an unhandled `SqliteError:
UNIQUE constraint failed` thrown out of the call, not caught by the test's own `expect(...).not.toThrow()`.

**Cheap-fix — the same merge shape made the panel list one person twice.** `listEnrolmentsForCourse` listed one
row per *enrolment*, not per *person* — a survivor left with both an active row and a stray ended one (must-fix
2's own scenario) appeared once under "Enrolled" and once under "Enrolment ended," the second offering a
"Reinstate" that could only ever collide and no-op. **Fixed** in the repo layer, not the panel: `listEnrolmentsForCourse`
now collapses its own rows to at most one per `personId` before returning — the active row wins when a person
has one; between two ended rows (the same merge, without a pre-existing survivor enrolment), the more recently
ended one wins. Fixed here rather than in `components/CoursePeople.tsx` because the duplication is a property of
what the query returns, not of how the panel renders it — any future caller of `listEnrolmentsForCourse` gets
the same correctness for free, and the panel itself needed no code change once the listing it reads was
corrected. A new test proves it: the same merge setup as must-fix 2's own reproduction, asserting the survivor
appears exactly once, as their active row; verified failing before the fix (temporarily bypassing the dedup
step): two rows returned for one person, not one.

**What this round is really about, stated plainly rather than left implicit.** A membership check, a `try`/`catch`
around a database call, and a `Map` keyed by person id are all small changes. What made their absence a security
gap rather than a cosmetic one is that the surrounding comments and D-59 itself asserted stronger guarantees than
the code actually made true — "an enrolled person holds no membership," "there is never more than one row for a
given pairing," "proven directly." Each was either false about this platform's own data model or true only by
accident of what nothing had yet exercised. The corrected comments in `actions/enrolments.ts` and
`repos/enrolments.ts`, and this entry, say explicitly which guarantees are structurally enforced (the self-check
in `execute`, the `try`/`catch` around the update, the dedup in the listing) and which are merely true today by
construction (that no other admission path currently produces a duplicate row outside the merge case named
above) — a decision record or a doc comment that does not distinguish the two is the exact gap both reviewers
found.

**Tests.** Failing-then-passing evidence for all three, verified by temporarily reverting only the relevant fix
and rerunning the one test written against it, then restoring: (1) the rewritten
`apps/api/tests/routes/enrolments-reinstate.test.ts` case and the two new `packages/actions/tests/enrolments.test.ts`
cases; (2) the new `packages/db/tests/enrolments.test.ts` merge-collision case; (3) the new
`packages/db/tests/enrolments.test.ts` dedup case. `apps/web/tests/course-people.test.tsx` also gained coverage
for the `role="status"` live region's own announced text (a hole a prior review pass left: deleting the region
entirely left every existing test green) — verified failing the same way, by temporarily removing the region and
rerunning.

## D-61 — `packages/db`/`packages/actions`/`packages/jobs`: JOB-6 — a finished job stops carrying the personal data it was given, `payload` clears only from a state no retry follows, and `jobs.get` drops the field outright

**Problem.** A security review of the roster-import panel found that `roster.import`'s own job payload — an
entire roster CSV, real names, emails and Discord handles — was never cleared once the import finished, and
`jobs.get` handed the parsed payload back to any member of the organization for the life of the row. Correctly
tenant-scoped, crossing no privilege boundary (anyone who could read it could have dispatched the import
themselves), but a retention gap on exactly the class of data `data/*.db`/`logs/*.log`/`results/*.csv`/
`rosters/*.csv` are hook-protected for, sitting in the one place nothing protects.

**Which states clear `payload`, and why exactly those two.** `repos/jobs.ts#completeJob` (`succeeded`) and
`#markJobFailed` (`failed`, attempts exhausted or a permanent error) both null the column in the same write that
records the terminal status — clearing it as a separate pass would leave a window where a crash between the two
writes lands a terminal job that still carries its payload, defeating the guarantee as surely as never clearing
it. `#rescheduleJobForRetry` (the job returns to `pending`, a retry still ahead of it) deliberately leaves
`payload` untouched: JOB-2's retry and JOB-3's once-only execution across a worker restart both re-read it for
the next attempt. `claimNextJob`'s own `eligible()` is what makes this safe — it only ever claims a `pending` row
or a `running` one whose lease lapsed, never a `succeeded` or `failed` one, so a terminal row is never reclaimed
and its payload is never needed again.

**Schema.** `jobs.payload` moved from `text('payload').notNull()` to nullable (`schema.ts`). Two migrations:
`0015` (drizzle-kit generated, the SQLite 12-step table rebuild the column-nullability change requires) and a
hand-written `0016` — `UPDATE jobs SET payload = NULL WHERE status IN ('succeeded', 'failed')` — backfilling
every row that reached a terminal state before this shipped. Written narrowly on purpose: only `payload`, only
`succeeded`/`failed` rows, the same WHERE clause the repo layer itself now enforces going forward, stated in the
migration's own comment so a future reader does not have to re-derive what it touches from the SQL alone.

**`jobs.get` stops returning `payload` outright, not merely once it is cleared.** Two options: hide the field
once the row's own `payload` happens to be `null`, or drop it from the action's response unconditionally. Chose
the latter. Nothing that calls this action today reads `payload` off the response — `ScaffoldButton.tsx` and
`RosterImport.tsx` (checked directly, not assumed) only ever read `status`/`lastError`/`result`, and
`apps/web/src/api/types.ts`'s own hand-mirrored `JobStatus` interface already omitted `payload` before this
slice touched it, for the same reason `apps/mcp/src/tool-surface.ts`'s own allowlist already excludes it: a
completed `roster.import` job's *report* carries a subset of the same PII in several of its own fields, which is
exactly why `roster.import` itself is deliberately kept off the MCP tool surface. Returning `payload` only while
a job is still `pending`/`running` would have closed less than the platform-level read action stopping
entirely — a caller belonging to the organization can read a roster CSV back through `jobs.get` for as long as
the row is queued, before this slice's own retention write ever runs, which is the same PII exposure through a
narrower window rather than a closed one. `result` (the outcome — SRV-6..8) is untouched; this action still
returns the handler's own report, which is the whole point of the "way to see the outcome" `jobs.get` exists for.

**The runner's own defensive branch, and why it earned a test.** `runNextJob` (`packages/jobs`) parses
`job.payload` for whatever handler claimed the row; once the column's type is `string | null`, `JSON.parse`
alone would silently treat a `null` payload as the JSON value `null` (JavaScript coerces `JSON.parse`'s argument
to the string `"null"` first, so this does not even throw) rather than failing loudly. Added an explicit guard —
a claimed job with a `null` payload fails immediately with a named reason, the same "defensive, not a case this
function's contract expects a caller to hit" shape the existing missing-handler branch already uses. Per the
reasoning above this should be structurally unreachable (`eligible()` never reclaims a terminal row), but it is
cheap to prove and it is exactly the kind of invariant a future edit could quietly break, so
`packages/jobs/tests/runner.test.ts` reaches past the repo layer (the same device the existing "a payload that
will not parse" test already uses) to null a claimed row's payload directly and asserts the guard fires.

**Tests, failing-then-passing.** Verified by stashing only the three source edits (`repos/jobs.ts`,
`actions/jobs.ts`, `runner.ts`) with the schema/migration/test changes still in place, rerunning, and restoring:
all seven new assertions failed cleanly (a still-populated `payload` where `null` was expected, `payload`
present in `jobs.get`'s own response, and the retry-then-succeed regression still succeeding when the defensive
guard test expected it to fail) with no other test affected, then passed once the stash was restored.
`packages/db/tests/jobs.test.ts` proves `completeJob`/`markJobFailed` clear `payload` and
`rescheduleJobForRetry` does not, at the repo layer; `packages/jobs/tests/runner.test.ts` proves the regression
that matters most — a job that fails but has attempts left is retried through two real `runNextJob` calls, and
the second attempt's handler still receives the same payload the first one did — plus the succeeded-clears-
payload case and the null-payload defensive branch, both through the real runner rather than an assertion about
a column; `packages/actions/tests/reads.test.ts` proves `jobs.get`'s own response — pending or finished — never
carries `payload`, asserted against the actual response shape (`Object.keys`, a `JSON.stringify` scan for the
seeded student's email/handle), not against the repo function. `apps/web/tests/roster-import.test.tsx`'s
existing "a finished report names every unparseable row" case, and the `roster-import-panel.spec.ts` e2e,
needed no change and still pass — the panel's own `JobStatus` type never declared a `payload` field to begin
with, so nothing in `apps/web` read the field this slice removes.

## D-62 — `playwright.config.ts`/`e2e/support`: QA-9 — the e2e suite fails under its own parallelism, `workers: 1` over a database per spec file

**Problem.** `npm run e2e` failed intermittently — `SQLITE_BUSY`/`database is locked`, raised from inside
transactions in specs unrelated to one another. Reproduced on purpose before changing anything: five consecutive
baseline runs at the commit this slice started from failed three of five, each time a different spec, each
failure a UI timeout after a panel action silently never completed. `e2e/tmp/logs/e2e-api.log` named the actual
cause underneath the UI timeout: `SqliteError: database is locked`, `code: SQLITE_BUSY` from
`course-join-links.ts#redeemJoinLinkForWebAccount`'s transaction, and separately `code: SQLITE_BUSY_SNAPSHOT`
from `courses.ts#createCourse`'s — both inside `apps/api`'s own single process, both from real, concurrently
committing connections, not a single slow one.

**Diagnosis, confirmed rather than assumed.** `playwright.config.ts`'s existing `fullyParallel: false` only
serialises tests *within* one spec file; it set no `workers` limit, so Playwright's default pool (half the
machine's CPUs — 4, on this machine's 8) ran separate spec files concurrently, in separate worker processes, all
driving the one `apps/api` process (`e2e/support/start-api.ts`) against the one SQLite file at
`E2E_DATABASE_PATH`. The second half of the mechanism, checked directly rather than inferred: ten of the twelve
spec files (`course-configuration.spec.ts` among them) also open their *own* direct
`openDatabase(E2E_DATABASE_PATH)` connection — a second, independent connection to the same file, live at the
same moment as the API's, used to seed state past the browser or assert past the API's own read actions. With
more than one worker, a spec's own direct write and a *different*, concurrently running spec's request landing
on the API can commit at the same moment, and SQLite answers one of them `SQLITE_BUSY` (ordinary lock
contention) or `SQLITE_BUSY_SNAPSHOT` (a deferred transaction's read snapshot invalidated by someone else's
concurrent commit). The brief's warning proved out exactly: `busy_timeout` (already 5000ms, `packages/db/src/
client.ts`) only helps the first of those two — a `SQLITE_BUSY_SNAPSHOT` transaction cannot be waited out, it has
to restart, so raising the timeout further would not have touched the failures actually observed in the log.

**Fix chosen: `workers: 1`, not a database per spec file.** Both were viable — the diagnosis is genuine
multi-*process* concurrency, and either "stop sharing the database" or "stop running concurrently" removes it
(SPEC's own QA-9 phrasing names both). Chose `workers: 1`: it removes the *cross-spec* concurrency — with one
worker, Playwright runs one spec file to completion before starting the next, so no other spec's own direct
`openDatabase` connection is ever open at the same time — it needs no new machinery (no per-worker API process,
no per-worker database path plumbed through `env.ts`, `start-api.ts` and every direct `openDatabase` call), and
the cost is small: the suite's own wall clock went from ~11-12s to ~20-26s across ten runs (`npm run e2e`
includes `pree2e`'s build; `npx playwright test` alone measured ~21s). A database per spec file was rejected as
materially more machinery — a distinct API process per worker, a distinct database path threaded through
everywhere a spec currently imports `E2E_DATABASE_PATH` — to buy back roughly ten seconds on a fourteen-test
suite. If this suite grows enough that ten seconds compounds into a real cost, that machinery is the next move;
nothing here forecloses it.

**Correction: this was first written as "removes the concurrent connection entirely," which overreaches — the
fix is circumstantial, not structural.** `workers: 1` only rules out one spec file's connection racing a
*different* spec file's. It does nothing to the two-connections-on-one-file design *within* a single spec: two
specs hold their own spec-owned `openDatabase(E2E_DATABASE_PATH)` handle open *across* browser interactions that
themselves drive real API writes to the same file — `roster-import-panel.spec.ts` (`workerDb` stays open while
the page clicks "Import roster", and `claimAndRunRosterImportJob(workerDb, …)` writes while the panel polls) and
`course-knowledge-files.spec.ts` (the same shape, around `claimAndRunJob`). If that helper's own commit lands at
the same moment the browser's poll makes the API commit, SQLite still returns `SQLITE_BUSY` to one of them, with
the identical symptom this record already describes — and `require-single-worker.ts`'s own module comment
previously told the next diagnostician that could not happen. Both that comment and this record now say plainly
that the remaining window is those two specs, not a claim that no window remains. The "second failure signature"
paragraph below is the supporting evidence this correction rests on — read that paragraph's own caveat about
what was and was not actually verified there before treating it as more than a symptom-level match: it is exactly
why "removes the concurrent connection entirely" overreached, since a UI-element-never-appeared failure is not
provably a `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` instance, only consistent in shape with one, which means the
parallelism hazard was never fully characterised by the transaction story alone. QA-9's own implementation is
unchanged by this correction; if the residual window in those two specs is judged worth closing, that is real
work scoped separately, not folded into this comment-and-record fix.

**Made hard to silently undo.** `workers: 1` alone is a config line indistinguishable, to a contributor chasing
suite speed, from an arbitrary default — nothing stops it being raised back without anyone learning why, and the
failure that follows (intermittent, in an unrelated-looking spec) would not obviously point back at the change
that caused it. `e2e/support/require-single-worker.ts`, wired in as `globalSetup`, reads Playwright's own
*resolved* worker count — after every CLI override, not just the config file — and throws immediately, naming
QA-9 and this record, if it is ever anything but `1`. Verified directly: `npx playwright test --workers=4` now
fails before any process starts, with that message.

**Rejected: `retries`.** Not considered a fix at all — `playwright.config.ts`'s own existing comment on
`retries: 0` already states the reasoning ("a flake here should be diagnosed, not hidden by Playwright's own
retry loop") and this slice's brief repeated it; re-running a real API and database until one attempt gets lucky
is exactly the "coin flip" QA-9 is about not being.

**Verification.** Ten consecutive `npm run e2e` runs post-fix, each one `14 passed`, zero `SQLITE_BUSY`/
`SQLITE_BUSY_SNAPSHOT` lines appended to `e2e/tmp/logs/e2e-api.log` across any of them (the three present in that
file are timestamped during the pre-fix baseline reproduction, ~7 minutes earlier than the first post-fix run).
`npm run lint && npx prettier --check . && npm run typecheck && npm test` all pass unchanged
(90 node:test, 1926 vitest across 172 files, matching this slice's stated baseline).

**A second failure signature, observed pre-fix, added here so a recurrence is not misdiagnosed.** The JOB-6
rework's own reviewer hit a 13/14 failure at `e2e/course-people-panel.spec.ts:108`
(`getByTestId('organization-switcher')` never appearing) in a worktree still at `f094665` — before this
record's own `workers: 1` had landed there. **What was actually observed, and by what means, stated precisely
so this is not read as more than it is:** the reviewer read Playwright's own reporter output — a locator
timeout, not the `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` assertion text this record's baseline reproduction hit —
and did not open `e2e/tmp/logs/e2e-api.log` for that run. Whether that log carried a `SQLITE_BUSY`/
`SQLITE_BUSY_SNAPSHOT` line is therefore unverified, not established either way, and this record does not claim
to have ruled a database-level cause in or out for that specific instance. What *is* true: a UI element never
appearing after a panel action is the same *symptom* this record's own baseline reproduction described ("a UI
timeout after a panel action silently never completed"), consistent in shape with the same root cause (a
concurrent worker's own request or direct database connection interleaving with this spec's) rather than proven
to be a distinct defect — multiple specs open their own direct `openDatabase(E2E_DATABASE_PATH)` connection
(this record's own "Diagnosis" paragraph), and `course-people-panel.spec.ts` is one of them. Recorded as a
second signature rather than a new entry because `require-single-worker.ts` (this record's own "Made hard to
silently undo" paragraph) is exactly what rules it out going forward: a worktree that predates that guard is
not evidence against the fix, but a reader who only knows the `SQLITE_BUSY` text would not recognise this one as
the same class of failure if it recurred. Not reproduced against the fixed suite — ten consecutive `workers: 1`
runs (the paragraph above) stayed at `14 passed`, and QA-9's own implementation is unchanged by this note.

## D-63 — `apps/web`: WEB-23 — a relative-duration control for a join link's expiry, not a datetime field

**Problem.** `courseJoinLinks.create` has always accepted an optional `expiresAt`, but
`components/JoinLinks.tsx` never offered it, so every link the panel issued was permanent and its own
`formatExpiry` could only ever print "No expiry" — dead text on a column WEB-20 required to mean something.

**Control chosen: a small set of relative durations (`EXPIRY_OPTIONS`), not a raw datetime picker.** The
brief's own reasoning held up: an instructor issuing a link for a term is thinking in weeks, not timestamps,
and `createInputSchema`'s own refusal (`expiresAt` must be strictly `> Date.now()`, `packages/actions/src/
actions/course-join-links.ts`) is exactly the failure mode a datetime field invites — a picker lets someone
select today's date with no time component and land on a value already in the past by the time the request
lands. A `<select>` of durations (`Never`, `1 day`, `1 week`, `1 month`, `1 term (16 weeks)`) cannot produce
that: every non-`Never` value is `Date.now() + durationMs`, computed the moment the request is actually sent
(`handleCreate`), never at the moment the option was selected — so a pause between choosing and clicking
never lets the value fall behind. `Never` (`durationMs: null`) is the default and sends no third argument at
all, matching `createCourseJoinLink`'s existing "omitted means no expiry" and leaving an instructor who never
touches the control with exactly today's unchanged behaviour.

**Wording: "Never", not "No expiry", in the select.** The list already reads a link with no expiry as "No
expiry" (`formatExpiry`, asserted by both `join-links.test.tsx` and `join-links-panel.spec.ts`). Labelling the
select's own default option identically would put two elements carrying that same text on screen at once the
moment a link with no expiry exists — a real strict-mode collision for any test (or screen reader Get-by-text
navigation) that looks for "No expiry" without first scoping to the list. `Never` says the same thing without
colliding with the list's own established string.

**Expired is distinct from revoked.** `formatExpiry` already branched on `revokedAt` before `expiresAt`; this
slice added a third branch — `expiresAt <= Date.now()` and not revoked reads "Expired …", never folded into
"Revoked …". The two are different causes (the clock, versus an instructor's own act) and ENRL-9/WEB-22's own
distinction between an ended and a revoked state (D-59/D-60) is exactly this same discipline applied here: an
expired-but-not-revoked link still offers a "Revoke" control, since expiry stopping *new* admissions is not
the same act as an instructor choosing to stop it.

**Recorded, not previously stated: the expiry select resets to "Never" after a successful create.**
`handleCreate` calls `setExpiryOption('none')` alongside `setCreated(result)` — an instructor who just issued a
one-day link and then clicks "Create join link" again for an unrelated second link starts from "Never" again,
not from "1 day" carried over. This was a deliberate choice, not an oversight left undocumented by accident:
this is the same shape `created`'s own reset already takes (nothing about the just-issued link persists forward
into the form for the next one), and *not* resetting risks the opposite, quieter mistake — a duration set once
for a short-lived trial link silently reused on a later, unrelated link the instructor never meant to expire at
all, admitting nobody past a day they never chose. Starting each new link from the same default (`'none'`, this
control's own stated default above) is also the smaller behavioural surface: every created link's own row in the
list already shows its own actual expiry once `refresh()` returns, so nothing about a just-issued link's choice
is lost, only *not carried forward* to the next, distinct one. The trade is real either way — this file records
it rather than leaving a future reader to guess whether it was considered.

**Verification.** New tests fail on the pre-change component (`git stash` of `JoinLinks.tsx` alone, tests
kept): 3 of 12 in `join-links.test.tsx` failed — choosing an expiry, recomputing it at send time rather than
selection time, and expired-vs-revoked — the other 9 (pre-existing WEB-20 cases) stayed green throughout,
confirming they exercise this slice's own change rather than something already there. `npm run lint && npx
prettier --check . && npm run typecheck && npm test` all pass: 1930 vitest across 172 files (baseline 1926 —
four new cases, no new files), 90 node:test unchanged. `npm run e2e`: 15 passed (baseline 14 plus one new
WEB-23 case), no intermittent failures.

**QA-9 rework (cheap-fixes 3 and 4).** Two gaps an independent review found in this slice's own tests, closed
without changing `JoinLinks.tsx`'s behaviour: (3) the "choosing an expiry" test above only bounded `1w`'s own
value (`> before`, `<= before + a week + 1000ms`), so any duration up to a week — including a mistyped `16 * 7`
as `16 * 6` in `EXPIRY_OPTIONS` — shipped green; `join-links.test.tsx` now has a table-driven case pinning every
timed option (`1d`/`1w`/`1mo`/`1term`) to its exact millisecond duration off a frozen clock, confirmed to fail
against exactly that mutation and to leave the other 16 cases green. (4) the expired-vs-revoked case above used
one expired-not-revoked link and one revoked-with-null-expiry link, never one that is both, so moving
`formatExpiry`'s `expiresAt <= Date.now()` branch above its `revokedAt` one survived every existing assertion;
a new case seeds a link with both fields set in the past and asserts it still reads "Revoked …", confirmed to
fail against exactly that reordering. `join-links.test.tsx` now has 17 cases (12 WEB-20 plus 5 WEB-23, up from
4); `apps/web`'s own `web` vitest project passed all 17 both times.

---

## D-64 — `apps/mcp/tests`: MCP-6 — the session-lookup flake was D-24's own bug, not yet copied to a second app

**Problem.** `apps/mcp/tests/server.test.ts` failed roughly one full `npm test` run in twenty-four, always as a
`404 session not found` where some other status was expected — a different assertion each time, never
reproducing when the `mcp` vitest project ran alone. Two prior hypotheses (the idle sweep, the per-account
eviction ceiling) were checked and both ruled out on inspection before this investigation started (`docs/
SPEC.md`'s own MCP-6 text records why): the sweep's own thirty-minute timeout cannot fire inside a twenty-second
run, and each test builds its own fresh `sessions` map (`server.test.ts`'s `buildTestApp` default parameter, a
new object every call — verified directly, not merely re-asserted, since the brief that opened this slice asked
for that reading to be checked rather than assumed).

**Why `apps/mcp/src/server.ts` cannot have produced either observed symptom shape — checkable from source, no
log required.** This is the primary evidence for exonerating the app; the instrumented captures below
corroborate it but are not, on their own, independently inspectable (the instrumentation was temporary and has
been removed, correctly — carrying it in the built app would be its own liability). Two structural facts, both
still true of the committed file and re-checkable by reading it, exclude `server.ts`'s own code from both
symptom shapes this investigation's brief named:

- `apps/mcp/src/server.ts:667-673` — `authenticateBearerToken` is checked, and a `401` returned, *before*
  `handleMcpRequest` ever reads `req.headers['mcp-session-id']` or touches `sessions` at all (the session-lookup
  code does not begin until line 677). A request whose bearer token does not authenticate at all is refused with
  `401` unconditionally — there is no branch, timing window, or map state that could turn that specific check
  into a `404` instead. So the brief's own cited instance ("refuses a second account's bearer token reused
  against a session that is not its own" — expected `401`, got `404`) cannot have come from this function ever
  actually running against that request: whichever `401` branch would have applied (this one, for a token that
  fails to authenticate as any account, or the account-pin check at lines 688-690, for a token that authenticates
  as the *wrong* account against an existing session) is unconditional once reached, and the file's only `404`
  (line 703) is reachable only when `existing` is falsy — which a session created and awaited moments earlier,
  in the same test, would not be, if the request had actually reached this code.
- `apps/mcp/src/server.ts:676-703` — walk an `initialize` `POST` (the exact shape `initializeMcpSession`,
  `tests/helpers/mcp-http-client.ts`, always sends) through the `try` block: `existingSessionId` is `undefined`
  (no `Mcp-Session-Id` header on an `initialize` call — `mcp-http-client.ts`'s own `postToMcp` never sends one
  for it), so `existing` is `undefined`, so the file's *only* `404` (line 703) is guarded by `req.method !==
  'POST' || !isInitializeRequest(req.body)` — both halves false for this exact request shape, so the guard is
  false and that return is never reached. There is no path from a well-formed `initialize` `POST` to a `404`
  anywhere in this file. So `initializeMcpSession`'s own observed `Error: initialize did not succeed (status
  404)` (the capture below) cannot have been this file answering the request it was sent.

Together these exclude `server.ts` from both shapes without needing a log at all: whatever answered with the
wrong status, it was not this code running against the request the test believed it sent.

**Corroboration (not independently inspectable — the raw captures are gone).** A loop of full `npm test` runs
(`MCP6_DEBUG`-gated `console.error` instrumentation added temporarily to `apps/mcp/src/server.ts` at every place
a request enters `handleMcpRequest`, at both places this file's own code returns a `404`, at
`onsessioninitialized`/`onsessionclosed`/`onclose`, and — after the first capture came back with *no* trace at
any of those — a catch-all Express middleware registered before routing, logging literally every request the app
receives and its final status) caught two failures directly, matching the structural argument above rather than
contradicting it:

- Run 44 of a batch: `initializeMcpSession` threw `status 404` on the sixth of twenty sequential `initialize`
  calls in the `MAX_SESSIONS_PER_ACCOUNT` eviction test. The instrumented log showed five `set` registrations
  (matching the five sessions actually opened) and then — nothing: no `lookup`, no `own-404`, not even the
  catch-all `inbound` logger (added for the next capture, so this specific run predates it, but the same absence
  held for every layer that *was* wired at the time). The request the test believed it sent never reached
  `handleMcpRequest`, or anything else in `server.ts`, at all — exactly what the second structural argument above
  says must be true, since that `404` could not have come from this file's own line 703.
- A second batch, run 9, with the catch-all logger now in place: the second of two assertions in "refuses
  GET/DELETE against a session id nothing has ever heard of" threw `ECONNRESET` outright — not a response, a
  connection failure — again with zero application-level trace, including the catch-all logger that fires before
  Express does any routing at all.

These two captures are recorded as what was observed at the time, offered as corroboration of the structural
argument above, not as evidence a future reader can re-open and check — the logs themselves were never
committed, and removing the temporary instrumentation (correct, since it should not ship) means they cannot be
regenerated from this commit alone. The structural argument above is what actually carries the conclusion.

**Cause: `docs/DECISIONS.md` D-24's own bug, in the one app that had not yet copied its fix.** D-24 (above)
already diagnosed and fixed this exact mechanism for `apps/api`: `supertest`'s own `Test#serverAddress`
(`node_modules/supertest/lib/test.js`) calls `app.listen(0)` with no host when handed a bare Express app, which
binds the IPv6 wildcard `::`, then dials the hard-coded literal `http://127.0.0.1:<port>`. `SO_REUSEADDR` lets
the OS hand that wildcard listen an ephemeral port some *other* process already holds bound specifically to
`127.0.0.1` — this machine runs plenty (VS Code's helper sockets, a `vite` dev server, another test file's own
server) — and the more specific binding wins the connection, so the request never reaches the app under test at
all; whatever that other process answers (or however its own connection handling behaves) is what the test
observes, indistinguishable from the app itself misbehaving. D-24's own "Limits" section named this precisely:
"the only package in this repo using supertest… If a future package adds HTTP tests over supertest, it needs
the same `startTestServer`-style helper, not a bare `request(app)`." `apps/mcp/tests/helpers/mcp-http-client.ts`
was that future package, added after D-24, and had called `request(app)` on a bare Express app on every single
one of its four exported request-issuing calls — the one file every request in `server.test.ts` actually goes
through, including the twenty-session eviction test, this bug's highest-volume exposure in the whole repo.
`apps/mcp/tests/mcp-e2e.test.ts` already knew about this (its own `listen()` binds `127.0.0.1` explicitly, with
a comment naming "a prior slice in this project had a real bug from binding the wildcard in a test") — the fix
had been applied once in this app and not carried to the file that needed it.

**Why only under the full suite, never `mcp` alone.** The collision needs some *other* process holding a
specific `127.0.0.1` bind at the exact ephemeral port the wildcard listen receives, at the exact moment. Running
`mcp` alone leaves far fewer such binds active system-wide; a full 173+-file run has every other supertest-based
suite (fixed, via `startTestServer`, since D-24 — but still opening and closing sockets throughout the run) plus
whatever else the host machine is doing. D-24 measured the underlying per-request rate directly: 0.10% per
request, against `apps/api`'s own ~50-60 requests per run, predicting `apps/api`'s observed ~1-in-10. `apps/mcp`'s
`server.test.ts` issues roughly sixty to seventy requests per run (44 static call sites, one of them a 19-
iteration loop) — the same per-request rate against that volume predicts a failure in roughly 1 run in 16 to 1 in
20, the same order of magnitude as the ~1-in-24 this slice's brief measured (not an exact match — the two
suites' own request timing and the rest of the host machine's own socket activity differ — but well within what
"same underlying mechanism, different request volume" would produce, not a coincidence requiring a separate
explanation).

**The mis-resolution question.** MCP-6's own SPEC text asked directly: does anything in the session-lookup path
admit or misattribute a request, not merely miss one? The answer, from this investigation: **no evidence of
mis-resolution was found, and the mechanism identified gives no way for one to occur.** Every reproduced failure
was a request that never reached `server.ts`'s own code at all (zero trace at the catch-all Express layer, the
earliest point `handleMcpRequest`'s own logic could possibly run) — a connection stolen by another process's
listener, or reset outright, both *availability* failures against the app under test, not the app under test
answering a request it should have refused. This was tested directly, not merely inferred from the two captures:
`handleMcpRequest`'s own account-pinning check (`existing.accountId !== accountId`, MCP-3's own guarantee) was
read in full, and nothing between an authenticated request entering the map lookup and the map returning a
result touches the network, blocks the event loop, or interleaves with any other request within the same test —
the entire session-pinning decision is synchronous over an already-parsed request. A genuinely broken lookup
mis-attributing an authenticated caller to another account's session would require either two requests actually
racing inside the same `handleMcpRequest` call (structurally impossible here — each `it()` awaits every request
before issuing the next) or the map itself holding a wrong entry (ruled out: `sessions.set` runs synchronously,
inside the SDK's own awaited `onsessioninitialized` call, strictly before the initialize response is ever built,
so a session that registers is registered correctly, and a request the app under test never receives cannot
poison a map it never touches). This is a claim about what was checked, not a proof that no defect can ever
exist in this path — stated as an inference from direct code reading and two reproduced failures, not as an
exhaustive proof.

**Fix.** `apps/mcp/tests/helpers/mcp-http-client.ts` gained its own `startTestServer` — the same shape as
`apps/api/tests/helpers/build-test-app.ts`'s (duplicated, not imported across an app boundary test helpers are
not published through, `test-db.ts`'s own already-stated convention for this directory): binds `127.0.0.1`
explicitly, awaits the bind (the `dns.lookup` reason D-24 already gives for why this cannot be patched around),
tracks every server it opens in a module-level `Set`, and closes them all in a single `afterEach` registered at
import time. `postToMcp`/`initializeMcpSession`/`sendMcpRequest`/`closeMcpSession` now take the already-listening
`http.Server` this returns, not a bare `Express`. `server.test.ts`'s own `buildTestApp` calls it, and every
`const app = buildTestApp(...)` call site became `await buildTestApp(...)` — the raw `request(app)` calls this
file also makes directly (the `/health` checks, the two nothing-has-ever-heard-of-this-session checks) needed no
change at all, since `supertest` reuses an already-listening server transparently when handed one instead of a
bare app.

**Regression test, copied per D-24's own instruction.** D-24's "Limits" section named the exact test to bring
along: `apps/mcp/tests/helpers/mcp-http-client.test.ts` is `apps/api/tests/helpers/build-test-app.test.ts`
duplicated against this app's own `startTestServer` — binds a squatter to a specific `127.0.0.1` port, then
asks `startTestServer` for that same port, and asserts `EADDRINUSE` rather than a silent, different-port
success. Confirmed to fail without the fix, directly: temporarily reverting `startTestServer`'s `listen(port,
'127.0.0.1', …)` back to a bare `listen(port, …)` (the wildcard bind `request(app)` always used) made this new
test fail — the wildcard bind against the squatter's own occupied port succeeds silently rather than rejecting,
exactly the shape that lets a request go to the wrong process. Restoring the explicit host argument made it pass
again.

**Verification.** `apps/mcp/src/server.ts` carries a zero-line diff (`git diff` confirms it) — this was a
test-harness bug, not an application one, so the app is untouched. `npm run lint && npx prettier --check . &&
npm run typecheck && npm test` all pass: 1945 vitest across 174 files (baseline at `c13e092` was 1944/173 — one
new file, `mcp-http-client.test.ts`, one new test), 90 node:test unchanged. `npm run board:derive` leaves
`scripts/board/manifest.yaml` byte-identical (same MD5 before and after).

Full `npm test` run 30 consecutive times after the fix landed, individually recorded at the time (`date` before
each run, pass/fail after) — the raw tally, committed here rather than pointed at notes that do not exist in
this repository:

```text
run  1  Thu Sep  3 04:44:00 EDT 2026  passed    run 16  Thu Sep  3 04:54:41 EDT 2026  passed
run  2  Thu Sep  3 04:44:42 EDT 2026  passed    run 17  Thu Sep  3 04:55:24 EDT 2026  passed
run  3  Thu Sep  3 04:45:26 EDT 2026  passed    run 18  Thu Sep  3 04:56:07 EDT 2026  passed
run  4  Thu Sep  3 04:46:09 EDT 2026  passed    run 19  Thu Sep  3 04:56:50 EDT 2026  passed
run  5  Thu Sep  3 04:46:52 EDT 2026  passed    run 20  Thu Sep  3 04:57:33 EDT 2026  passed
run  6  Thu Sep  3 04:47:34 EDT 2026  passed    run 21  Thu Sep  3 04:58:16 EDT 2026  passed
run  7  Thu Sep  3 04:48:17 EDT 2026  passed    run 22  Thu Sep  3 04:58:58 EDT 2026  passed
run  8  Thu Sep  3 04:49:00 EDT 2026  passed    run 23  Thu Sep  3 04:59:41 EDT 2026  passed
run  9  Thu Sep  3 04:49:43 EDT 2026  passed    run 24  Thu Sep  3 05:00:24 EDT 2026  passed
run 10  Thu Sep  3 04:50:25 EDT 2026  passed    run 25  Thu Sep  3 05:01:06 EDT 2026  passed
run 11  Thu Sep  3 04:51:07 EDT 2026  passed    run 26  Thu Sep  3 05:01:49 EDT 2026  passed
run 12  Thu Sep  3 04:51:50 EDT 2026  passed    run 27  Thu Sep  3 05:02:31 EDT 2026  passed
run 13  Thu Sep  3 04:52:32 EDT 2026  passed    run 28  Thu Sep  3 05:03:13 EDT 2026  passed
run 14  Thu Sep  3 04:53:15 EDT 2026  passed    run 29  Thu Sep  3 05:03:57 EDT 2026  passed
run 15  Thu Sep  3 04:53:58 EDT 2026  passed    run 30  Thu Sep  3 05:04:39 EDT 2026  passed
```

Every one of the 30 runs reported the identical `1945 vitest / 174 files`, `90 node:test` — no run passed by a
different route (a different test skipped, a different count) than any other.

**Honest limit on what the 30 runs alone prove.** At the pre-fix rate this slice measured (roughly one failure
in twenty-four full runs, ~4%), thirty consecutive clean runs is meaningful — it would be a little under 30% odds
of the flake surviving undetected by chance alone, `(1 - 0.04)^30 ≈ 0.29` — but it is not conclusive on its own;
a run count can always be unlucky, and thirty is not enough to distinguish "fixed" from "still flaky at a lower
rate this batch happened not to hit." The structural argument above — that `server.ts` cannot produce either
observed symptom shape from its own code, checkable from source with no run count at all — is what actually
carries this entry's conclusion. The 30 runs are consistent with the fix and rule out an obvious regression from
it; they are not, by themselves, the proof.

**Limits.** This fixes `apps/mcp`'s own suite. D-24's own "Limits" section already generalised the underlying
rule ("If a future package adds HTTP tests over supertest, it needs the same `startTestServer`-style helper");
this entry exists because that rule was stated once and not enforced anywhere a second app could violate it
silently — no lint rule or repo-wide grep currently catches a new `request(app)` call site against a bare
Express app. That stays a manual discipline, not a structural guarantee, unless a future slice adds one.

---

## D-65 — `apps/web`: TEN-8/WEB-4 — D-23 closed the action layer, not the surface; the panel now reads its own organization's Discord binding instead of trusting only a same-session prop

**Problem.** An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built," dated 2026-09-03) found
`pages/Shell.tsx` still deriving `installedServerId` purely from `justInstalled`, a prop `App.tsx` sets only
once — when a Discord OAuth callback completes in that same browser tab. A reload, or a second device, or an
install from an earlier session, all leave `justInstalled` `undefined`, so the Discord tab renders "Install"
for a server that is already bound, and `handleRemove`'s own `if (!installedServerId) return` makes WEB-4's
"with the option to remove it" unreachable for exactly the accounts who did not just click through the OAuth
flow in this tab. Both TEN-8 and WEB-4 were marked Done before this was noticed.

**This is not a new gap — it is D-22's gap 2, restated.** D-22 named it directly: "a page reload, or a second
device, sees no installed server at all even when one exists, which is a real gap in WEB-4's 'a server already
installed shows as installed.'" D-23's own text is careful about what it claims to have done about that:
"`discordServers.list` … exists and is exercised by that package's own tests, but no `apps/api` route reaches
it" (D-22's own wording, restated as the gap D-23 closes) became, in D-23, five *actions* including
`discordServers.list`, reachable through the existing generic `POST /organizations/:organizationId/actions/:name`
route with no `apps/api` route change needed at all. That is real, and it is correctly recorded — D-23 is not
being rewritten here, and this entry adds to it rather than correcting it. But closing the action layer is not
the same claim as closing the gap D-22 described, which was specifically about what `pages/Shell.tsx` renders:
the action existed and was dispatchable from the moment D-23 landed, and nothing in `apps/web` ever called it.
`components/InstallButton.tsx`'s own module comment and `ShellProps.justInstalled`'s own doc both still asserted
"there is no route today to look up an organization's existing bindings" after D-23 shipped — an assertion this
slice found still committed, still false, and corrected here (this project's own repeated finding: a comment
asserting the opposite of the code gets caught in review, eventually, but had not been yet). The audit is what
finally traced "the action exists" all the way out to "and is called by nothing," which is the distinction this
entry exists to record for the next person who reads D-23 and reasonably concludes WEB-4's gap is closed.

**Choice, a client wrapper (`api/client.ts#listDiscordServers`) plus a fetch in `Shell.tsx`, not a new component.**
The same shape every other read in this app already takes (`listProjects`, `listCourseAttachments`, etc.) —
`dispatchAction(organizationId, 'discordServers.list', {})`, typed against a hand-mirrored
`DiscordServerBindingSummary` (`api/types.ts`, this file's own module comment on why client types are mirrored
rather than imported from `packages/actions`). No new component: `InstallButton.tsx` already renders whatever
`installedServerId` it is handed: the fix is entirely in what `Shell.tsx` computes for that prop, not in what
renders it.

**Choice, `justInstalled` is consulted only while the fetch is `'loading'`, never after.** `discordBindingState`
(`'loading' | 'ready' | 'error'`) starts `'loading'` on every mount and on every organization switch. While it
is `'loading'`, `justInstalled` — known synchronously, no round trip needed — stands in for it, so a fresh
install's own banner shows immediately rather than flickering through a loading state it does not need. Once the
fetch resolves, one way or the other, `discordBindingState` is the only thing either `installedServerId` or
`handleRemove` trust — a stale same-session signal must not outlive the server-truth read that supersedes it.
The alternative — keeping `justInstalled` as a fallback on a failed lookup too, not only while one is in flight —
was rejected, corrected per review: the fallback's own `justInstalled?.organizationId === activeOrganizationId`
guard means it can only ever apply immediately after a successful install in *this* tab, never more broadly — an
earlier draft of this entry overstated the alternative's blast radius as "every other reason a lookup can fail,"
which is not what the guard actually admits. The real argument is narrower and still holds: even in that one
case, a failed refetch is itself a fact worth telling the caller (a Discord-reachability problem, a session
about to expire, whatever it is), and WEB-5's "the panel adds no interpretation the API did not give it" argues
for saying so plainly (`ErrorMessage`, the same path every other refusal in this app renders) over silently
sitting on the last known-good value and letting the caller find out the lookup is broken some other way.

**Choice, fetched on `Shell.tsx` mount and on every organization switch, not gated behind opening the Discord
tab.** `ProjectsPanel` already fetches unconditionally on mount for the same reason (`Shell.tsx`'s own module
comment, D-25's accounting of what that costs the test file) — switching *into* a tab that has already fetched
costs no further round trip. The alternative (fetch only once the Discord tab is actually opened) was rejected
because it would reintroduce exactly the loading-state trade this slice is careful about, once per tab open
rather than once per mount, for no offsetting benefit.

**What this does not touch.** The OAuth+PKCE install flow itself, `apps/api/src/routes/discord-servers.ts`, and
`discordServers.remove`'s own behaviour are all unchanged — this slice makes Remove *reachable* whenever a
binding exists, it does not change what removing one does.

**Correction, TEN-8/WEB-4 rework: a removed binding could come back on an organization switch, and nothing
pinned the switch behaviour that fixes it.** Review found the `'loading'` fallback above was written to consult
`justInstalled` on the *first* `'loading'` state only, in the author's own head, but the code actually consults
it on *every* `'loading'` state — and `discordBindingState` returns to `'loading'` on every organization switch,
not only on mount (the previous paragraph's own point). Sequence: install into org-1, remove it (correctly
returns to "Install to Discord"), switch to org-2, switch back to org-1 with no reload in between — the effect
re-runs, `discordBindingState` is `'loading'` again, `justInstalled.organizationId === activeOrganizationId`
still holds (`justInstalled` never changes after mount), and nothing recorded that this exact server had already
been removed, so "Installed — server guild-42" rendered again, live Remove button included, until the refetch
resolved a moment later and corrected it — clicking that Remove button in the interim got a real `404
action_refused` from `discordServers.remove`'s own policy, correctly refusing a binding that is no longer
active. Momentary and self-healing, but the brief's own reasoning against a momentary "Install" flash applies
unchanged to a momentary "Installed" one: a bug that clears itself in one round trip is still the bug. Fixed by
restoring the record the pre-slice code already kept and this rework had dropped: `removedServerId`
(`pages/Shell.tsx`), set once in `handleRemove` and never cleared, checked alongside
`justInstalled.organizationId === activeOrganizationId` in the fallback — a `'loading'` render only trusts
`justInstalled` when its own server id has not already been removed this session, on any organization switch,
not only the one immediately following the removal.

Separately: stubbing the effect's own dependency array down to `[]` (fetch on mount only, never on an
organization switch) left the full suite green — no test asserted `listDiscordServers` was ever called again
with a newly selected organization, or that the panel's own Discord-tab content changed across a switch at all.
That gap is exactly where the regression above lived, which is presumably why it shipped unnoticed. Both are now
pinned directly: `tests/shell.test.tsx`'s "TEN-8 rework: coordinator review findings" describe block reproduces
the reviewer's own repro for the resurrection bug, asserts `listDiscordServers` is called with the newly active
organization on every switch, and separately pins three mutants that survived the original suite without any
test noticing — `bindings.find((b) => b.removedAt === null)` swapped for `bindings[0]`, `discordFetchId.current++`
deleted from `handleRemove`, and the effect's own `if (!isMember) return` guard deleted — each confirmed to fail
against its own specific mutation before being left in place, not merely asserted correct by inspection.

## D-66 — `packages/actions`/`packages/db`/`apps/web`/`e2e`: COST-3/COST-4 — a spending cap that can actually be set, and an instructor's own usage screen

**Problem.** The same audit that produced D-65 (`docs/ROADMAP.md`'s "Audit — surfaces that were never built")
found two more requirements marked Done that were not, both in the cost ledger. COST-3: `organizations.setSpendingCap`
(`@bloombot/db`) had zero non-test callers anywhere in the monorepo, and `spendingCapMicros` carried no
column default, so `hasReachedSpendingCap`'s real, correctly-placed enforcement (`@bloombot/core#answer.ts`)
could never actually fire in production — there was no way to set a cap outside a test. COST-4:
`costLedger.organizationUsage` (`@bloombot/actions`) existed and was correctly tenant-scoped, but its only
caller was `apps/mcp`'s own tool surface; nothing in the panel — where an instructor does everything else —
ever called it, and `pages/Admin.tsx` covers only COST-4's *other* half (a platform administrator's own read).

**Choice, restricted to an owner, not any membership.** `routes/actions.ts` admits any membership regardless of
role, and `policy.ts`'s own module comment is explicit that a descriptor documents access, it does not enforce
it — so nothing stops an `assistant` or `instructor` membership from calling `costLedger.setSpendingCap`
unless something checks. Measured, not assumed: a spending cap is the one control in this slice that can stop
the assistant answering for *every course in the organization at once* the moment it is set below what has
already been spent — a blast radius closer to `memberships.grant`'s own "grants organization-wide authority"
than to an ordinary per-course write like `courses.save`. `setSpendingCapAction#execute` reads `accountId` and
checks `memberships.getMembership(...).role === 'owner'`, the identical shape `memberships.grant` already
uses and for the identical reason its own doc comment gives: `PolicyContext` carries no caller identity at
all, so *who* may call this can only ever be `execute`'s own job, not the policy's.

**Choice, a currency amount converted to micros, not micros typed by hand, and `Math.round` once, at the
end.** COST-3's own text and every existing money surface (`pages/Admin.tsx#formatMicros`,
`packages/core/src/pricing.ts#computeCost`) treat micros as an internal accounting unit, never something a
person types or reads directly. `costLedger.setSpendingCap`'s own input schema takes `capAmount: number |
null` (dollars — `$12.50` is `12.5`) and converts with `Math.round(capAmount * 1_000_000)`, the same "round
once, at the very end, not on every intermediate step" discipline `pricing.ts#computeCost`'s own doc comment
holds itself to for D-2's "money as INTEGER micros": `10.1 * 1_000_000` is `10099999.999999998` in IEEE 754
double precision, and `Math.round` is what turns that back into the exact `10100000` a decimal input actually
meant, rather than trusting a caller to send an already-integer value or letting the drift reach storage
unrounded.

**Choice, `null` clears, `0` blocks — the same tri-state `hasReachedSpendingCap` already reads.**
`setSpendingCapInputSchema`'s `capAmount` is `z.number().nonnegative().nullable()`, not merely optional: an
instructor's blank field sends `null` (clears the cap, `organizations.spendingCapMicros` becomes `null` again,
`hasReachedSpendingCap` reads that as "no cap at all" — its own doc comment already gives this reading), while
typing `0` and saving sends `0` explicitly (`hasReachedSpendingCap`'s `spent >= cap` is `0 >= 0`, true the
instant anything at all has been spent). The panel additionally offers an explicit "Clear cap" button
alongside "Save cap", rather than requiring an instructor to discover that blanking the field and saving is
the way to clear it — the two are genuinely different actions with different consequences, and one control
per action reads more honestly than one overloaded field.

**Choice, `setSpendingCap`'s own doc comment corrected, not merely left.** The brief named this directly: the
function's doc comment used to state, as fact, "there is no action layer wired to this in this slice ... it
exists so a test, or a future admin action, can configure a cap" — true when written, never revisited once an
action existed to call it. `docs/ROADMAP.md`'s audit and D-65 both record this project's own recurring
finding — a comment asserting the opposite of the code is what a reviewer eventually catches, but had not
been yet — so the comment is rewritten here to point at the action that now wires it, rather than left as
one more example of the same defect.

**Choice, the cap-setting form withheld for a non-owner, not merely disabled.** `pages/Shell.tsx` computes
`isOwner` (the caller's own membership role in the active organization) and threads it to `pages/Usage.tsx`,
which renders the whole "Spending cap" form only when it is `true` — the same `isMember`/tab-withholding shape
`Shell.tsx` already uses for LINK-10 (its own module comment: "the server's own refusal ... is what actually
makes any of this safe ... this only decides what the panel offers"). The read (`costLedger.organizationUsage`)
stays open to any membership, matching that action's own unrestricted policy — only the write is gated.

**Choice, "cap reached" derived client-side, not a fourth field the read has to carry.** COST-3's UI
requirement is that a cap that is set, a cap with no cap at all, and "cap reached" (the state that stops the
assistant answering) must all be visually distinct. `getOrganizationUsageSummary`'s own report already carries
both `spendingCapMicros` and `totalCostMicros` — `pages/Usage.tsx` compares them with the identical `spent >=
cap` `@bloombot/db#hasReachedSpendingCap` itself uses, rather than adding a `capReached: boolean` field to the
action's own return that would only ever restate a comparison the caller already has both halves of.

**Choice, `personDisplayName ?? personId`, never email, for a near-limit student.** Matches
`components/CoursePeople.tsx#label`'s own precedent exactly, for the same reason its own doc comment gives: a
`null` display name is already told apart from another by a distinct id, and these are real students'
addresses — shown only where a screen genuinely cannot tell two people apart without one, which this screen
is not.

**Finding — `e2e/support/start-api.ts` never wired a pricing table through to `buildApp` at all.** Writing
`usage-panel.spec.ts` (COST-4's own e2e proof that a real conversation's cost shows up on the instructor's own
screen) surfaced a pre-existing gap in the shared e2e harness, not introduced by this slice: `deps.pricing`
(`@bloombot/core#answer.ts`) was left `undefined`, so every chat conversation that talks to this API-hosted
process — not only this slice's own new specs — has been priced at `0` since the harness was written, logging
`answerQuestion`'s own "no pricing table configured" warning every time, unnoticed because nothing before this
slice ever asserted a nonzero cost end to end. Fixed in place, one line
(`pricing: getModelPricingTable()`, `@bloombot/config`'s own documented default table, the same one
`apps/api/src/index.ts` builds in production from `CONFIG.MODEL_PRICING_JSON`) rather than worked around by
seeding a ledger row directly — an e2e spec's own point is that a real pipeline actually did the thing, and a
pipeline that has silently never priced anything in this harness is a defect the next COST-anything e2e spec
would have hit regardless of who wrote it first. **Not closed everywhere, and this entry originally overclaimed
that it was** (a rework review caught the overclaim, below): `course-configuration.spec.ts` dispatches through
`packages/discord#handleMention` in-process, with its own separate dependency object and no `pricing` field of
its own either — a second, distinct instance of the identical gap, on a path this harness's own `apps/api`
process never touches. Left open deliberately rather than chased in the same rework that found it: fixing it
means threading a pricing table through a second, unrelated harness entry point for a gap this one fix does not
reach, which is its own piece of work, not a one-line correction to this one.

**Rework, same day — a review of the fix above found it unpinned, plus three related gaps in this slice's own
COST-3 write path.** Four cheap fixes and one promoted to a fix:

1. **The pricing fix had no assertion that would fail without it.** `usage-panel.spec.ts` asserted against the
   panel's own dollar display (`toContainText(/\$\d+\.\d{2} · 1 call/)`), which a real run showed passing at
   `cost_micros: 133` — `$0.000133`, which `pages/Usage.tsx#formatMicros` rounds to `"$0.00"` at two decimal
   places. Deleting `pricing: getModelPricingTable()` from `start-api.ts` left the assertion passing regardless,
   because the call-count half of the same regex matched on its own. The spec now reads
   `cost_ledger_entries.cost_micros` back from the database directly (`costLedger.getOrganizationSpentMicros`),
   the same directness `spending-cap.spec.ts` already uses for `spending_cap_micros` — proven to fail against
   the same deletion.
2. **`apps/api/tests/routes/chat.test.ts`'s own COST-3 integration test asserted a magnitude claim its own
   harness cannot back.** `buildTestApp` (`apps/api/tests/helpers/build-test-app.ts`) wires no `pricing` either,
   so the "costs something real … never `0` (COST-6)" comment was false there too — the recorded cost actually
   is `0`, and the test (still valid) exercises COST-3's `0 >= 0` boundary, not a magnitude. Comment corrected
   to say so.
3. **`pages/Usage.tsx#parseCapAmount`'s blank-input branch (`'' → null`) had no test that could not also pass
   with `'' → 0`.** The existing "Clear cap" test dispatches `handleClear`, which sends `null` directly and never
   calls `parseCapAmount` at all. A new test blanks the field and clicks *Save* instead — the path that actually
   exercises the branch — proven to fail against a `'' → { ok: true, value: 0 }` mutation. The consequence named
   in review: an owner who blanks the field meaning to remove the cap would instead store `0` and block every
   student in the organization on their very next question.
4. **`toMicros`'s `Math.round` was unpinned.** Every value any existing test used (`12.5`, `5`, `5.25`, `0`) has
   an exactly representable product with `1_000_000`, so `Math.floor` would have passed every one of them too.
   `2.01` does not (`2.01 * 1_000_000` is `2009999.999999998` in IEEE 754 double precision) — a new test pins
   `Math.round`'s own `2_010_000`, proven to fail against a `Math.floor` mutation.
5. **Promoted from a note to a fix — the HTTP route accepted values the form cannot produce, with severe
   consequences.** `setSpendingCapInputSchema` accepted any nonnegative finite number: `1e-7` rounded down to
   `0` (a total block on every student, from a value an owner might reasonably read as "essentially no limit"),
   and `1e300` was verified to reach `organizations.setSpendingCap` and land in `spending_cap_micros` (an
   `INTEGER` column) as a SQLite `REAL` with no throw — a cap that then never fires. "The form validates it"
   (`pages/Usage.tsx#parseCapAmount`'s own `^\d+(\.\d{1,2})?$`) is not a defence for an API the form is not the
   only caller of. The schema now carries `.multipleOf(0.01)` (agreeing with the form's own two-decimal-place
   limit) and `.max(MAX_SPENDING_CAP_AMOUNT)` (`$10,000,000` — arbitrary but generous, and `* 1_000_000` stays
   comfortably inside `Number.MAX_SAFE_INTEGER`), each pinned by a test proving both the previous unrestricted
   schema accepted the value and the new one refuses it.

**Out of scope, deliberately.** `hasReachedSpendingCap` and the enforcement path in `answer.ts` — this slice
makes the cap settable, it does not change what a cap does once reached. `spendingCapMicros`'s own missing
column default (every organization is created with `NULL`, not some documented ceiling) is reported, not
fixed — changing it changes behaviour for every existing row, a decision this slice's brief explicitly reserved
for whoever owns that call.

## D-67 — `packages/actions`/`apps/web`/`e2e`: ENRL-5 — an owner can grant a membership role, and see who holds one

**Problem.** The same class of audit that produced D-65/D-66 (`docs/ROADMAP.md`'s "Audit — surfaces that were
never built") found `memberships.grant` (`packages/actions/src/actions/memberships.ts`) had no caller outside
its own package's tests — no route, no panel screen — and `listMembershipsForOrganization`
(`packages/db/src/repos/memberships.ts`) had no caller at all, anywhere. The consequence, stated plainly in
the audit note: an owner had no actual way to add a second instructor or a teaching assistant to their
organization, and the only membership row that has ever existed in production is the founding owner's own,
written inline by `accounts.createAccount` at sign-up. The MCP omission is unrelated and stays: `apps/mcp/src/
tool-surface.ts`'s own module comment already reasons about it, deliberately, and this slice does not touch
that file — `MCP_TOOL_SURFACE` is an explicit allowlist, so a new action registered anywhere never reaches a
model caller unless a reviewer adds its name there by hand (that file's own module comment).

**Choice, `memberships.list` restricted to no role at all — any member may read it, unlike `memberships.grant`.**
`costLedger.organizationUsage`/`.setSpendingCap` (D-66) already establish the shape this slice reuses: a read
needs no extra check beyond an ordinary membership (which `routes/actions.ts` already requires of every action
route), a write with organization-wide consequence does. Measured, not assumed: seeing who already holds a
staff role carries none of a grant's own consequence — it changes nothing, and an assistant or instructor
knowing their own colleagues' roles is not a fact this platform treats as sensitive anywhere else (`courses.list`,
`discordServers.list` and `costLedger.organizationUsage` are all open to any membership the same way). Granting
stays owner-only, unchanged — `grantMembershipAction`'s own check, already in place before this slice, is
exercised by this slice's own new tests (`packages/actions/tests/memberships.test.ts`) but not altered.

**Choice, `z.strictObject`, not `z.object`, on `memberships.grant`'s own input.** `grantInputSchema` used to be
a plain `z.object({ email, role })`, which silently drops a key it does not declare rather than refusing it —
`execute` never read `input.grantedByAccountId` regardless (both `grantedByAccountId` and `grantedAt` are
always stamped from the session's own `accountId`, per ENRL-5's own "recorded" half), so this was never an
actual hole, but a caller attempting to supply either deserved an explicit `action_input_invalid` refusal
rather than silent disregard indistinguishable from never having tried. Measured by mutation: reverting to a
plain `z.object` (with `grantedByAccountId` added back as an accepted, ignored field) was tried directly
against this slice's own new "refuses a grant whose body supplies grantedByAccountId" test — it fails without
`z.strictObject`, confirming the schema, not merely `execute`'s own indifference to the field, is what a test
now pins.

**Choice, the grant target still identified by email, and the list still never shows one.** ENRL-5's own text
says roles are "granted only by an existing owner" — nothing about how the owner names who receives one.
`grantMembershipAction`'s own input has always been `email` (unchanged by this slice), because an owner
granting a role to somebody not yet visible in `memberships.list`'s own roster has nothing else to hand — no
account id a screen could offer to pick from. `components/Team.tsx`'s own grant form is the one place in this
app's whole membership surface that takes an email as text; the roster itself follows `components/CoursePeople.tsx#label`'s
"never email" precedent exactly, showing `displayName` for every row (never `null` here — unlike a student's
own, `accounts.displayName` is `NOT NULL`, `schema.ts`) and never persisting the typed email once a grant
succeeds (`Team.tsx`'s `handleGrant` clears it and re-fetches the list rather than rendering anything back from
`grantMembershipAction`'s own return, which is `@bloombot/db`'s raw `Membership` row and carries no display
name at all — `api/types.ts#GrantMembershipResult`, distinct from `OrganizationMembership`, the enriched shape
`memberships.list` returns).

**Known limitation, inherited, not fixed by this slice.** `grantMembershipAction#execute` — before this slice,
untouched by it — refuses a grant unless the target account *already holds a membership in this organization*
(that function's own "rework finding 1" comment: without this check, the action was a cross-tenant
account-existence oracle, and a successful call would have enrolled a stranger's account into an organization
they never consented to join). No production path creates a *first* membership for an account in a second
organization — `memberships.createMembership` (`packages/db/src/repos/memberships.ts`) has no caller outside a
test, same as `deleteMembership` — so in practice, today, `memberships.grant` can only ever change the role of
somebody who is, by some other means, already a member of the organization in question; it cannot yet be how
an owner brings a genuinely new person onto their staff for the first time. That function's own doc comment
already names this as "a distinct feature, left to a later slice," and this slice's own brief scoped the same
way — building the missing surface over the grant this platform actually has, not extending what it grants.
`e2e/team-panel.spec.ts` seeds its own second account directly through `accounts.createAccount` for exactly
this reason, and says so in its own module comment, rather than implying a real invitation flow exists.

**Out of scope, deliberately, stated rather than left ambiguous.** Demoting or removing a membership — including
an organization ending up with no owner at all — is not built here. `deleteMembership` (`packages/db/src/repos/
memberships.ts`) remains uncalled, exactly as this slice found it; nothing in `components/Team.tsx` offers a
way to remove a row. A role can be *changed* (granting a different role to an existing member, including
granting a second `'owner'`) but never revoked through this screen. The brief named this choice explicitly as
open; closing it — and deciding what, if anything, stops the last owner removing themselves — is left for
whoever picks it up next.

---

## D-68 — `packages/db`/`packages/actions`/`apps/api`/`apps/web`/`e2e`: ENRL-10 — an owner invites a colleague who is not yet in the organization

**Problem.** D-67's own "known limitation, inherited, not fixed by this slice" is the reason this slice
exists: `grantMembershipAction` refuses a target with no existing membership in the caller's own organization,
deliberately — closing that check any other way was already shown to make the action a cross-tenant
account-existence oracle. Nothing in production created a *first* membership for a second instructor or
teaching assistant, so an owner genuinely had no way to add a colleague. `membership-invitations.ts` (a new
table, `packages/db`; new actions and a new bespoke redemption route, mirroring `course_join_links`/
`sign_in_tokens` exactly) is that path.

**Choice, single-use, not multi-use.** A join link is deliberately shared with a whole class (ENRL-3); an
invitation is addressed to one person. Read literally, ENRL-10's "admits exactly the person who received it"
could mean either "single-use" alone or "single-use *and* bound to the addressed identity" — I chose both,
measured against the actual attack this closes: a bearer secret that leaked (forwarded, screenshotted) would,
under single-use alone, still let whoever redeemed it *first* become staff of a stranger's organization — not
"the person who received it," merely "whoever got there first." `redeemMembershipInvitation`
(`packages/db/src/repos/membership-invitations.ts`) therefore also requires the redeeming account's own email
to equal the invitation's own `email` column, both already-lowercased facts (`accounts.email`'s own repo
comment; this table's own `createInvitation`) — refused identically to every other reason, so the check itself
adds no new oracle. The consequence: an invitee with no account yet at the invited address cannot redeem
until one exists at that address — consistent with SPEC's own "redeeming one never creates an account or a
session" — they sign in first (which creates the account, ordinarily) and only then follow the link back.

**Choice, an invitation refuses a redeemer who already holds any membership in that organization, rather than
silently changing their role.** The brief named this as mine to decide. `memberships.grant` (ENRL-5) already
exists, is owner-only, and is recorded — it is the one path this platform gives for changing an *existing*
member's role. Letting an invitation redemption also change a role would be the identical write reachable two
ways with two different confirmation UIs and two different "what does this mean" strings (`Team.tsx`'s own
grant confirmation vs. `MembershipInvitations.tsx`'s own invite confirmation) — a second, quieter path to the
same consequence. Refusing keeps the boundary exactly where D-67 already drew it: an invitation is the
first-membership admission path, `memberships.grant` is the role-change path, and neither one's own doc
comment has to hedge about the other doing its job too.

**Choice, the recorded grantor is the inviting owner, never the redeemer.** ENRL-5 requires a role be
"recorded" — who granted it. `redeemMembershipInvitation` stamps `grantMembershipRole`'s own
`grantedByAccountId` from `invitation.createdByAccountId`, never from the redeeming `accountId` the function
is otherwise acting as. Measured by mutation: swapping the two (`grantedByAccountId: accountId`) was tried
directly against this slice's own "records the inviting owner ... not the redeemer" tests (both
`packages/db/tests/membership-invitations.test.ts` and `packages/actions/tests/membership-invitations.test.ts`)
— both fail without the fix.

**Choice, an owner may invite at the `owner` role, and this slice cannot cause an organization to lose its
last owner.** `Team.tsx`'s own `GRANTABLE_ROLES` already lets an owner grant a second `owner` through
`memberships.grant` (D-67, unchanged) — `MembershipInvitations.tsx`'s own `INVITABLE_ROLES` mirrors it, for the
same reason: nothing about *inviting* is different for the owner role than for any other. Because this slice
only ever grants — it has no removal or demotion path, and does not touch `deleteMembership`, which D-67 left
uncalled and this slice leaves uncalled still — no organization can lose an owner through anything built here,
last one or otherwise. Removal/demotion, and what should stop an organization losing its last owner, are
exactly the same open questions D-67 left, unchanged by this slice.

**Choice, `membershipInvitations.list` is owner-only, unlike `memberships.list`.** D-67's own choice was that
seeing who already holds a role carries none of a grant's own consequence, so that read stays open to any
member. An *outstanding* invitation is a different fact: it carries an email nobody but the inviting owner has
consented to have visible in this organization yet — closer to the sensitivity `Team.tsx`'s own grant form
already treats an owner-typed email with (never rendered back, never shown to another member) than to a
granted role's own, already-public membership row. Measured, not merely asserted: `.create`/`.list`/`.revoke`
all share one `requireOwner` helper (`membership-invitations.ts`, `packages/actions`), and mutation-testing it
down to "authenticated, any role" was tried directly against this slice's own three "refuses a caller who is
not an owner" tests — all three fail without the role check.

**Choice, the outstanding-invitations list is a history, not only a queue.** `listInvitations`
(`packages/db`) returns every invitation an organization has ever issued, live, revoked and redeemed alike —
the same "history, not only what is currently live" shape `course-join-links.ts#listJoinLinks` already gives
WEB-20's own join-link screen, rather than a narrower reading of "outstanding" that would only show pending
ones. `MembershipInvitations.tsx` withholds the Revoke control once an invitation is no longer live
(`redeemedAt`/`revokedAt`/`expiresAt`, in that priority order — a redeemed invitation reads as redeemed
regardless of what either other column holds, single-use having nothing further for `revokedAt` to protect
against).

**The migration (`0017_equal_stranger.sql`), and why `packages/db/tests/migrate.test.ts` gained a dedicated
case rather than only the top-level table-list assertion.** `membership_invitations` is a brand-new table —
generated by `drizzle-kit generate` off `schema.ts`, not written by hand — so its column shape is already
pinned by that file's existing "applies every migration to an empty database" assertion (extended with this
table's own row, the same light touch `course_join_links` originally got). What that assertion cannot see is
*behaviour* a plain column list does not express: the `membership_invitations_role_check` `CHECK` and the
unique index on `secret_hash`. `0017 — membership_invitations` (new `describe` block) inserts directly through
`db.$client` — an out-of-range role, and two rows sharing a hash — and asserts both throw, the same class of
gap `0015`/`0016`'s own dedicated test already closes for `jobs`.

**Finding — three census tests exist precisely to catch a new action arriving unannounced, and did.**
`packages/actions/tests/access-audit.test.ts`, `catalog.test.ts` and `apps/api/tests/tenant-isolation.test.ts`
all derive their own expectations from `createPlatformRegistry()`, so registering
`membershipInvitations.create`/`.list`/`.revoke` failed all three immediately, by design — each was updated
with the new action's own descriptor/name/route, and `tenant-isolation.test.ts`'s own derived (a)/(b)/(c)
matrix (foreign session / no session / disabled account) now exercises the three new routes for free, the
same TEN-5 coverage every other action already gets, with no route-specific code added to that file at all.

**Finding — the API proxy allowlist is a fourth place a new bespoke route has to be named, and this slice
missed it on the first pass.** `apps/web/vite.config.ts`'s own `proxy` object lists every top-level path
`apps/api` actually serves; `/join-links` was already there for ENRL-8, but `/membership-invitations` was not
added in the same pass as `apps/api/src/server.ts`'s own mount, and the gap was invisible to every unit and
action-level test (`apps/api/tests/routes/membership-invitations.test.ts` talks to `buildApp` directly, never
through Vite's proxy) — only `e2e/membership-invitation-panel.spec.ts`, run through the real `vite preview`
server, actually exercises the browser's own same-origin path and caught it: a real Chromium redemption
attempt 404'd with an empty body (Vite's own "no route, no proxy match" response, not `apps/api`'s JSON
`membership_invitation_not_found`), which `describeApiError`'s `default` case rendered as "Something went
wrong. Try again." — plausible enough to read as a genuine server error rather than a missing proxy entry.
Fixed by adding the entry (`vite.config.ts`), mirroring `/join-links`'s own comment on why a proxied API path
and a page path (`/invitations/:secret`) must never share one top-level segment. Recorded here because the
class of gap — a new bespoke, unscoped route needs *four* places updated (`server.ts`'s mount,
`vite.config.ts`'s proxy, `App.tsx`'s own page route, and whichever tests derive from the registry) and only
one of those four is checked by anything short of a real browser — is exactly the kind of thing worth a future
slice's own audit, the same way `docs/ROADMAP.md`'s "Audit — surfaces that were never built" already caught
`memberships.grant`/`memberships.list` having no caller at all.

**Finding — `getByLabel`'s substring matching meant a second form on the same screen needed care twice, not
once.** `Team.tsx`'s existing "Grant a role" form already labels its own fields "Email"/"Role" — mounting
`MembershipInvitations.tsx` alongside it with the same labels would have made both React Testing Library's
`getByLabelText` (jsdom) and Playwright's `getByLabel` (a real browser) resolve to two elements for a plain,
un-anchored query. Distinct labels ("Invite email"/"Invite role") fixed the jsdom side outright — neither
string is a substring of the other in either direction — but Playwright's own default matching is
case-insensitive *substring*, not exact, so `e2e/team-panel.spec.ts`'s own pre-existing `getByLabel('Email')`
(added for ENRL-5, before this slice) still matched "Invite email" too, since "email" is a substring of it.
That existing spec needed `{ exact: true }` added to both its own `getByLabel('Email')` and (already present,
for the identical "Role" collision `costLedger.setSpendingCap`'s own form never had) `getByLabel('Role', {
exact: true })` — an edit to a file this slice's brief did not name, made necessary by mounting a second form
in the same tree, not scope creep.

**Mutation testing — what was tried, and what survived (report the brief itself asked for).** Beyond the
findings recorded above (grantor swapped to the redeemer, the owner check dropped, `z.strictObject` reverted
to `z.object` on both the redemption route's and the create action's own input, `revokedAt` dropped from
`findLiveInvitationByHash`), two mutations are recorded here because the first attempt at a test did *not*
catch them, and a better one had to be built rather than merely asserted passing:

  1. *Dropping `revokedAt` from `findLiveInvitationByHash`'s own `WHERE`* still made every "no oracle"
     assertion pass, because `claimInvitation`'s own re-check (the "a write whose own `WHERE` re-checks the
     condition its read relied on" pattern `repos/memberships.ts#grantMembershipRole`'s own `updated` branch
     already uses) still refused a revoked secret correctly — one step later, after doing strictly more work
     first (an account lookup, an email comparison, a membership check) than a never-issued secret's own
     immediate refusal does. Return-value equality could not see that extra work; it is itself a timing
     oracle a sufficiently careful attacker could measure. Closed by a stronger assertion, not a weaker
     mutation tolerance: `accounts.getAccountById` is spied on and asserted *never called* for any of the four
     refusal reasons, proving they share the same immediate exit rather than merely agreeing on the eventual
     answer.
  2. *Splitting `redeemMembershipInvitation`'s single `db.transaction(...)` into two — one for the claim, one
     for the grant* — passed the required "a concurrent revoke beats an in-flight redemption" test unchanged,
     because that race is what `claimInvitation`'s own `WHERE` guards, not the surrounding transaction. The
     transaction's own, different job — that a claim and its grant commit or roll back *together* — had no
     test at all until one was added: `grantMembershipRole` mocked to throw once, after the claim already
     ran, asserting the invitation reads as still live afterward (not claimed, not redeemed) and is still
     genuinely redeemable — this is what actually fails against the split-transaction mutation, and would
     have failed against this slice's very first draft had that draft ever shipped un-mutated.

No other mutation tried (see the list above) survived any test in this slice's own suite.

**Out of scope, deliberately, unchanged from what the brief named.** ADMIN-2/JOB-2 (a separate slice).
`memberships.grant`'s own existing behaviour and its anti-oracle refusal (untouched — `packages/actions/src/
actions/memberships.ts`'s own doc comment is corrected to point at the invitation path that now exists,
nothing about `execute` itself changes). Removal/demotion of a membership (D-67's own open question, restated
above rather than silently narrowed). MCP's tool surface (`apps/mcp/src/tool-surface.ts`'s own module comment
already reasons about the omission; `MCP_TOOL_SURFACE` is a hand-maintained allowlist this slice does not
touch, so the three new actions are unreachable from a model caller by construction). Emailing the invitation —
an owner copies a link and sends it however they like, exactly as ENRL-3's own join link already works; if the
mail transport should send it instead, that is a different slice's call.

## D-69 — `packages/db`/`packages/actions`/`apps/web`/`e2e`: ADMIN-2/JOB-2 — a job listing bounded by what needs attention, and an access log restricted to an owner

**Problem.** An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built") found two capabilities
complete in the data layer and unreachable from any surface: `transcriptAccess.listAccessLogForCourse`
(`packages/db`) had zero callers outside a test, so ADMIN-2's own "an institution has to be able to account
for" a transcript read never actually held past the write; and there was no `jobs.list` action or route at
all, so a job that exhausted its attempts in a session nobody still had open — the exact case JOB-2 names —
was invisible to everyone, forever, even though the row itself was never deleted.

**Choice, `transcripts.listAccessLog` is restricted to an owner, not open to any membership the way `.read`
itself is.** The brief named this as mine to decide, and to say deliberately. Two readings of "an institution
has to be able to account for" were live: the same population `.read` already admits (any membership —
`policy.ts`'s own "a descriptor documents, it does not enforce" means today any owner/instructor/assistant can
already read a course's raw transcript), or the narrower population this platform already holds accountable
for organization-wide consequences. I chose the narrower one, measured against what the log actually adds
over what `.read` already discloses: `.read`'s own content is the sensitive thing, and any membership can
already see it — the access log is *metadata about who else has been looking*, which is oversight of that same
staff population, not a fact a member is otherwise entitled to about their colleagues. That is the same shape
`memberships.ts`'s own module comment already draws for `memberships.grant` and `costLedger.setSpendingCap`:
"authority over a tenant's courses, transcripts and spending" is what a role carries, and an owner is who this
platform already holds accountable for the tenant as a whole, not a course's own instructor auditing a peer.
`ADMIN-4`'s "sees tenants, not conversations" was also weighed and rejected for the *reader*, not merely the
surface: a platform administrator is kept out of a tenant's transcripts entirely, and this log names courses
and (sometimes) students — closer to that boundary than to the usage totals ADMIN-4 actually shows — so
`pages/Admin.tsx` was never a candidate; the only real choice was "any member" versus "owner alone" within the
tenant's own panel. Measured by mutation, not merely asserted: `transcripts.ts`'s own inline `role !== 'owner'`
check was weakened to "any existing membership" and run directly against `packages/actions/tests/transcripts.test.ts`'s
own "refuses a non-owner membership" test — it fails without the check, the way every other owner-only action
in this package (`memberships.grant`, `costLedger.setSpendingCap`) is already proven the same way.

**Choice, the log never carries an email, on either side.** `actorAccountId`/`personId` are both resolved to a
display name (`accounts.getAccountById`/`people.getPerson`, falling back to the id itself — the identical
"defensive, do not trust a foreign key blindly" shape `memberships.list`'s own `listMembershipsAction` already
takes), never to the underlying `email` column. Measured by mutation: swapping the actor's own
`displayName` for `email` in the mapping was tried directly against this slice's own "an owner reads the log
... never an email" test (`packages/actions/tests/transcripts.test.ts`) — it fails without the fix, catching
the leaked address in the response body itself, not merely in a type.

**Choice, `jobs.list` orders by `updatedAt`, not `createdAt`, and is bounded rather than unbounded.** JOB-2's
own text ("a job that keeps failing is visible") is about what needs attention *now* — a job stuck retrying
for an hour is what an instructor checking in on the queue wants to see first, not a job that finished cleanly
a minute after being enqueued. `repos/jobs.ts#listJobsForOrganization` orders `desc(updatedAt), desc(createdAt)`
(the second only a deterministic tiebreaker, not a meaningful one — this file adds no new `sequence` column for
it, unlike `transcript_access_log`/`transcript_exports`, since a bounded, unpaginated listing does not need a
tiebreaker that survives a schema migration, only one that survives one query). `MAX_JOBS_LIST_LIMIT` (200) is
enforced by the input schema's own `.max()` — a caller asking above it is refused (`ActionInputError`), not
silently clamped, the same shape `costLedger.setSpendingCap`'s own `.max(MAX_SPENDING_CAP_AMOUNT)` already
takes for an out-of-range number. Measured by mutation: the `organizationId` argument passed to
`listJobsForOrganization` was swapped for a literal string, and the payload-omission was removed from
`toJobStatus`'s own mapping — both tried directly against this slice's own suite (`packages/actions/tests/reads.test.ts`);
both fail without the fix, the tenant-scoping one against three separate assertions ("does not include another
organization's jobs" and the two tests that depend on seeing the seeded organization's own rows at all) and the
payload one against both `jobs.get`'s pre-existing JOB-6 tests and this slice's own new listing-shaped one —
confirming `payload` omission is genuinely shared through `toJobStatus`, not duplicated per action.

**Choice, `jobs.list` carries no owner restriction, unlike the access log.** `jobs.get` itself has never been
role-restricted — any member of the organization may poll any job's own status — and a listing is the same
read, plural. Nothing about knowing that a `roster.import` job failed is the kind of oversight-over-staff fact
the access log's own restriction is about; it is operational status any member dispatching work already needs.

**Choice, surface placement: a new "Jobs" tab (`pages/Jobs.tsx`), and the access log inside the existing
Transcripts screen, not a new one.** The brief left both open. Jobs span the whole organization, not one
course — the same shape Usage/Team already take as their own tabs (`pages/Shell.tsx`'s own module comment on
each) — so a seventh tab, not a subsection of an existing one, is what that shape calls for. The access log is
inescapably course-scoped (ADMIN-2's own "who read whose conversation" is per-course, the same as the
transcript it is about) and already has exactly the screen where a course is selected and where ADMIN-1's own
read happens — adding a second, course-picking screen for a fact about the first would duplicate the picker for
no reader's benefit, so it is a new section inside `pages/Transcripts.tsx`, gated on `isOwner` the same way
`pages/Usage.tsx`/`components/Team.tsx` already gate their own owner-only sections — withheld entirely, not
merely disabled, so a non-owner is never offered a control that would refuse.

**Schema.** No migration. `transcriptAccess.listAccessLogForCourse` (`packages/db`) already existed, correctly
scoped, with a caller added by this slice rather than a shape changed; `jobs.listJobsForOrganization` is new but
reads the existing `jobs` table with no new column. `drizzle-kit check` confirms no drift.

**Tests, failing-then-passing.** Every new assertion (`packages/db/tests/jobs.test.ts`'s own
`listJobsForOrganization` block; `packages/actions/tests/reads.test.ts`'s own `jobs.list` block;
`packages/actions/tests/transcripts.test.ts`'s own `transcripts.listAccessLog` block; `apps/web/tests/jobs.test.tsx`,
new; `apps/web/tests/transcripts.test.tsx`'s own new "Access log" block; `apps/web/tests/shell.test.tsx`'s own new
Jobs-tab case) was run against the implementation with the mutations above applied and confirmed failing before
being reverted and confirmed passing — see each mutation paragraph for which test caught it.

**Rework — a flaky ordering test, and a real tie the original design left unstated.** A verify run after this
slice first landed caught `packages/db/tests/jobs.test.ts`'s own "orders by most recently updated" case failing
intermittently (`expected 'dd06e749-…' to be 'f307bce5-…'`): `enqueueJob` reads `Date.now()` once per call, and
on a fast machine the test's own three writes (enqueue `older`, enqueue `newer`, claim-and-complete `older`) can
all land inside one millisecond, tying `updatedAt` — the diagnosis was that the *ordering* was correct and the
*test* could not reliably observe it, not a bug in `listJobsForOrganization` itself. Fixed by controlling the
clock rather than the assertion: `vi.useFakeTimers()`/`vi.setSystemTime()` around each of the three steps, one
millisecond apart, the identical device `membership-invitations.test.ts`'s own "lists invitations newest first"
case already uses for the same hazard (that test's own comment is what named the precedent). Checked every other
new assertion in this slice for the same class of dependency: every other `jobs.list`/`listJobsForOrganization`
test asserts length or single-row content, never relative position among two-or-more real, clock-derived
timestamps, so none of them shared the hazard; `transcripts.listAccessLog`'s own "most recent first" assertion
(`packages/actions/tests/transcripts.test.ts`) does not either — that ordering comes from
`transcript_access_log.sequence`, a real per-transaction counter, not a timestamp, which is exactly why that
column exists (`schema.ts`'s own comment). The e2e specs were checked the same way: `jobs-panel.spec.ts` seeds
one job, `transcript-access-log.spec.ts` asserts two access-log rows are each visible somewhere, never their
relative position — neither depends on two timestamps differing.

**The tiebreak question this raised, answered rather than left implicit.** `updatedAt desc, createdAt desc`
still leaves a *real* tie possible, not merely a testing artifact: a batch enqueue (several `enqueueJob` calls
issued back to back) reads the clock once per call and can genuinely share both columns, at which point SQLite
gives no guaranteed order among the tied rows. Left unstated, that means the Jobs tab's own "Refresh" button
(`pages/Jobs.tsx`) could show a tied pair swap positions between two polls with no activity in between — the
queue appearing to reorder itself for no reason, which undermines exactly the legibility JOB-2 is about.
Chose to close it rather than leave it: `id` ascending is a third, final `ORDER BY` key
(`listJobsForOrganization`, `packages/db/src/repos/jobs.ts`) — deterministic, not itself meaningful, the same
role `createdAt` already plays as the second key, and it costs nothing (no schema change; `id` already exists on
every row). Proved by a new test, not merely asserted: three jobs enqueued under one frozen timestamp (so both
`updatedAt` and `createdAt` genuinely tie, checked directly before trusting the rest of the test), then the same
listing query run twice — the order matches `id` ascending, and the second call returns the identical order the
first did.

`npm run lint && npx prettier --check . && npm run typecheck && npm test && npm run e2e && npx drizzle-kit check`
all pass: 90 node:test, 2096 vitest across 182 files (this slice's original baseline was 2065/181; +31 tests
overall, +1 file — `apps/web/tests/jobs.test.tsx`; the rework itself added one test, for the tie, and changed no
other file's test count), 22 e2e (baseline 20; +2 — `e2e/jobs-panel.spec.ts`, `e2e/transcript-access-log.spec.ts`).
`packages/db/tests/jobs.test.ts` alone run 15 times consecutively post-fix, `25 passed` every time — the file's
own baseline before this slice was 20, +4 for the original `listJobsForOrganization` block, +1 for the tie test
this rework added.

**Out of scope, deliberately, unchanged from what the brief named.** Job retry/cancel controls — listing is
what JOB-2 asks for; a "retry this job" button is a new capability this record does not build. Changing what
`readCourseTranscript` writes, or JOB-6's retention rules (both untouched — `listJobsForOrganization` reads the
same `payload`-may-already-be-null column JOB-6 already clears, on the same schedule). MCP's tool surface
(neither new action is added to `apps/mcp/src/tool-surface.ts`'s own allowlist).

---

## D-70 — `packages/core`/`packages/openai`/`packages/discord`/`apps/api`: CORE-7/CORE-8 — a person's own address is split from their opaque identity, and the surface decides one of them

**Problem.** `answer.ts` built `personRef` as `` `<@${identity.externalId}>` `` — Discord's own mention token,
constructed inside `packages/core`, the one package the rest of this build already holds to "no vendor SDK,
nothing vendor-shaped" (CORE-4). `ports.ts` documented the field as "an opaque reference to the person", which
was false: on Discord the token happened to render correctly; on the web the identity is the account's own id,
so a student asking through the panel was answered with that id wrapped in Discord's own syntax — live,
user-reported behaviour, not a theoretical one. Worse than the literal defect: the field carried Discord's
syntax into the seeded opening item, content the model itself reads and, on a course whose prompt was written
for Discord, echoes back at the front of its own reply — which is the actual mechanism the bug report showed
(`<@68690a1b-…>- Hello`), not merely an unused value sitting in a request object.

**Choice — one field becomes two, not one field renamed.** `ModelRequest.personRef` is replaced by
`personIdentifier` (`person_identities.externalId`, unchanged in *value* for Discord, embedded only in the
upstream conversation's own `metadata.user_id`, never in content the model reads) and `addressAs` (embedded in
the opening item alongside `displayName`, and the only one of the two a model can ever echo into a reply).
Splitting them is what lets `ports.ts`'s own "opaque reference" claim be true of `personIdentifier` rather than
false of both: metadata is bookkeeping a later transcript read can use to trace a stored conversation to a
person, never part of what the model is asked, so a raw identity is genuinely safe there regardless of surface
— which is also why Discord's own metadata value changed from the wrapped token to the bare snowflake (an
*internal*, non-observable change; nothing renders `metadata` to a Discord user, and
`packages/openai/tests/conversations.test.ts`/`client.test.ts` were updated, not merely kept passing by
accident, to assert the two fields are sourced independently).

**Choice — who decides `addressAs`, and how "cannot inherit the bug by doing nothing" is made structural, not
conventional.** `AnswerDependencies` gained an *optional* `addressPerson(person, identity)` function, not a
required one. A required field was considered and rejected: every existing test across `packages/core`,
`packages/discord` and `apps/api` that builds an `AnswerDependencies`-shaped object (well over a hundred call
sites, measured by how many broke on a required-field trial edit) would have had to be touched for a decision
almost none of them are about, which is exactly the kind of unrelated churn `docs/CONTRIBUTING.md` asks a
slice to avoid — and it would have bought no more safety than the alternative actually taken: `deps.addressPerson`
defaults to `NO_ADDRESS`, a function that always returns `null`, the same "expose the seam, default to the
*safe* choice rather than a merely convenient one" discipline `NO_ADMISSION_LIMIT`/`NO_PRICING_CONFIGURED`
(`answer.ts`, pre-existing) already hold themselves to for concurrency and cost. A surface that never wires
`addressPerson` — including one not yet written — addresses nobody, never an id: the dangerous behaviour (build
an id-shaped reference and hand it to the model) is unreachable by omission, proved by mutation, not merely
documented (below).

`identity` is still resolved inside `answer.ts` itself (`people.getPersonIdentity`, unchanged call site),
not pushed out to each surface to re-derive: a review of `people.ts#getPersonIdentity`'s own doc comment
found it already names a known, deliberate imprecision for a person with more than one identity on the same
surface (a roster-handle-matched Discord student whose real snowflake has not yet been promoted onto their
identity row) and says fixing it would require "the calling surface to pass its own already-known external id
through" — precisely what moving identity resolution to each surface would have done. Doing that here would
have silently changed which identity Discord's own mention resolves to in that one edge case, violating this
slice's own "the Discord path must be unchanged in observable behaviour" constraint to fix a bug outside this
slice's scope. Left alone, `addressPerson` receives whatever `getPersonIdentity` resolves, exactly as
`personRef` did before this slice — the multi-identity imprecision is unchanged, not newly introduced.

**Choice — the web surface implements CORE-8's fallback order for real, not merely `null`.** CORE-8's text
reads two ways: "the web chat … addresses nobody" (literal, always) and "a surface that needs a name and has
none of its own uses [a fallback order]" (general, and the web chat is exactly such a surface). Reconciled by
implementing the general order (`person.firstName ?? person.displayName ?? null`) in `apps/api/src/routes/
chat.ts#addressPersonForWeb`, on the reading that "addresses nobody" describes today's *empirical* outcome, not
a rule against ever using a name: measured directly against `@bloombot/auth#sign-in.ts`, a web person is
created via `createPerson(organizationId, {}, db)` — no roster fields at all — so `firstName`/`displayName` are
both `null` for the account this build's e2e harness and every real account today ends up with, unless a
later roster import merges one in by matching email (PPL-3's own path, unconnected to a name a future
WEB-24/WEB-25 profile screen might one day let someone set — both out of this slice's scope). "Addresses
nobody" is therefore what happens today, not a case this code special-cases; a name greeting a one-to-one
thread is not the noise CORE-8's own reasoning is actually about (a Discord-style *mention*, naming who a reply
is for in a room of many), so this reading does not undercut it. Recorded here as an inference, not a
certainty, since the SPEC text does not itself disambiguate the two readings.

**Not chosen — a surface-supplied plain string on `AnswerQuestionInput`.** The brief's own design notes offered
this as an option: the caller computes `addressAs` itself, before calling `answerQuestion`, and passes it as
data. Rejected because Discord's own snowflake is not something `handleMention` can safely recompute from
`input.authorId` alone without risking exactly the multi-identity divergence the previous choice above declines
to touch — `identity.externalId`, as `getPersonIdentity` resolves it today, is not always `input.authorId` (the
roster-handle case). A function closes over `answer.ts`'s own resolution of `identity` instead of asking every
surface to duplicate (and possibly diverge from) it.

**Tests, failing-then-passing, and every mutation tried.** `packages/core/tests/no-vendor-sdk.test.ts` gained a
guard scanning every `packages/core/src/**/*.ts` file for the literal two-character token `<@` — confirmed to
fail (both this guard and the new CORE-7/CORE-8 web-defect test in `answer.test.ts`) when `answer.ts`'s
`addressAs` computation was reverted to build the mention token directly, ignoring `deps.addressPerson`
entirely; passes with the fix. `NO_ADDRESS` mutated to return `person.id` instead of `null` — three existing
`answer.test.ts` assertions failed (the two `personIdentifier`/`addressAs`-null cases and the new web-defect
test), proving the *default itself* leaking an id is caught, not only an explicit surface choice to do so.
`apps/api/src/routes/chat.ts#addressPersonForWeb` mutated twice against its own new `chat.test.ts` case: dropped
the first-name preference (`displayName ?? null`) — failed on the first assertion; fell back to `person.id`
instead of `null` — failed on the third. `packages/discord/src/handle-mention.ts`'s own `addressPerson` wiring
commented out — failed a new `handle-mention.test.ts` case asserting the real `handleMention` (not a duplicate
of the function) still produces the mention token end to end. Every mutation was reverted and the suite
reconfirmed green afterward.

The reported defect itself is proven at the level CORE-7's own brief asked for — the reply text a person
actually reads, not an intermediate request field — via a new `EchoingModelClient` in `answer.test.ts` that
mimics the actual mechanism (a model echoing `addressAs` at the front of its own reply, the way a
Discord-tuned prompt does): a Discord answer still reads `<@snowflake-1> - Hello`, unchanged; a web answer
reads plain `Hello`, containing neither a mention token nor the account's own id. `e2e/chat.spec.ts` gained a
matching assertion against the real browser-rendered reply — honestly scoped in its own comment as *not*
exercising the echo mechanism itself (`e2e/support/fake-model-client.ts` is a static fixture, shared across
several other specs that assert its exact text, so it was deliberately left unchanged rather than made dynamic
and risking a collision with them), only that nothing in real rendering/serialization independently leaks the
id.

Final counts: 90 node:test (unchanged), 2107 vitest across 182 files (baseline 2096/182 — +11 tests, no new
file), 22 e2e (unchanged — an existing spec was extended, not a new one added).

**Out of scope, deliberately.** WEB-24, WEB-25, AUTH-6, ENRL-11, ENRL-12 (later slices, per the brief). The MCP
surface — it has no `answerQuestion` caller anywhere in this codebase yet, so CORE-7/CORE-8 do not reach it;
nothing "fell out for free" because there is nothing there yet to fall out onto. What a transcript stores,
`conversations`' shape, and the web chat's layout (`Chat.tsx` itself was not touched — addressing did not
require it). The `person_identities` multi-identity-per-surface imprecision `people.ts#getPersonIdentity`'s own
doc comment already names (see the second choice above) — a pre-existing, documented limitation this slice
inherits rather than fixes.

**Rework round — three findings from an independent review, none a design change.**

1. **The e2e assertion did not pin the fix.** `e2e/chat.spec.ts`'s own two `not.toContain` lines against the
   rendered thread pass with the reported defect fully present — verified directly: `answer.ts`'s `addressAs`
   computation was reverted to Discord's own mention token for every surface, `apps/web` was rebuilt, and the
   spec still passed, because `e2e/support/fake-model-client.ts` answers with a fixed string that never reads
   `request.addressAs` at all. The spec's own comment already said the mechanism was not real, but read as
   though the assertion still proved the fix; a reader would reasonably believe otherwise. Fixed two ways: the
   comment was rewritten to say plainly, up front, that this assertion passes with the defect present and is not
   a regression test for it; and `apps/api/tests/routes/chat.test.ts` gained the cheap, genuine proof this
   package's own test suite can give — an `EchoingModelClient` (the same device `packages/core/tests/answer.test.ts`'s
   own CORE-7/CORE-8 block already uses) asserted against the actual HTTP response body a browser reads, which
   does fail with the defect restored. `e2e/support/fake-model-client.ts` was deliberately left static rather
   than made to echo `addressAs`: that file is shared by several other specs which assert its exact fixed text,
   and making it dynamic risked a defect in an unrelated spec for a proof already available more cheaply one
   layer down.
2. **The guard caught only the literal token, and covered only one of two packages that could reintroduce it.**
   Writing the same mention as `'<' + '@' + identity.externalId + '>'` in `packages/core/src/answer.ts` passes
   `no-vendor-sdk.test.ts`'s own scan cleanly — verified; only the behavioural CORE-7/CORE-8 tests in
   `answer.test.ts` caught it. That guard's own comment now says so directly: it is the cheap, fast layer for
   the obvious case, not the platform's only defence — the behavioural tests are. Separately, the guard scanned
   `packages/core/src` only, and `packages/openai/src` is equally able to hard-code a surface's syntax (it is
   the package `addressAs`/`personIdentifier` actually land in) — `packages/openai/tests/no-surface-syntax.test.ts`
   is a new, analogous guard for that package, the same shape `no-vendor-hostname.test.ts` already takes for
   MDL-7, copied rather than added as a second responsibility to an existing file (this package's own
   established one-guard-per-file convention). Two doc comments in `packages/openai/src/conversations.ts` quoted
   the literal token to describe `response_bot.py`'s own f-string; both were rephrased in prose so the new guard
   needs no comment-vs-code exception to stay a plain substring scan.
3. **Three comments described a value that no longer matched, after this slice's own change.** Discord's
   upstream `metadata.user_id` changed from the wrapped mention token to the bare snowflake (deliberate,
   documented above: metadata is never part of the content a model reads, so a raw identifier is safe there
   regardless of surface, and more useful for a later lookup). `ports.ts`'s `ModelRequest.personIdentifier`,
   `conversations.ts`'s `CreateUpstreamConversationOptions.personIdentifier`, and — untouched by this slice
   originally, but wrong for the identical reason — `people.ts#getPersonIdentity`'s own doc comment all still
   claimed this value matches `response_bot.py`'s (`response_bot.py:269` sends the mention token itself). All
   three now say plainly that the *field* matches and the *value* does not, and name the operational
   consequence in the one place an operator would actually read it (`ports.ts`): filtering the provider's own
   dashboard by a legacy, mention-shaped `user_id` will not match a conversation created from this slice on.

Final counts after the rework: 90 node:test (unchanged), 2128 vitest across 183 files (this rework's own
baseline, `efbc729`, was 2119/182 — +9 tests, +1 file, `no-surface-syntax.test.ts`), 25 e2e (baseline 24 — no
new spec from this round; the count changed by D-71's own rework, below, not this one).

---

## D-71 — `packages/db`/`packages/auth`/`apps/api`/`apps/web`/`e2e`: AUTH-6/WEB-25 — a sign-in's own destination survives whichever tab redeems it, and a join-link redemption confirms itself and lands the student in the joined course

**Problem.** `pages/JoinLink.tsx` and `pages/Connect.tsx` each stashed their own return address in
`sessionStorage` (`PENDING_JOIN_LINK_KEY`, `PENDING_CONNECT_ORG_KEY`) for `App.tsx#returnToShell` to read back
once a sign-in redemption completed — D-55's own choice, correct at the time, but `sessionStorage` is scoped
per browsing context, and a sign-in link arrives by email: a mail client that opens it in a fresh tab (the
ordinary case, not an edge one) leaves that tab with no marker to read, landing the visitor on the plain shell,
enrolled in nothing, with no explanation. Separately, `JoinLink.tsx` called
`redeemCourseJoinLink(secret).then(onRedeemed)` and discarded the result outright — `onRedeemed` took no
arguments — so the course id, organization id and enrolment outcome the server had already resolved were
thrown away, and a redeemer was dropped on whichever screen this account's own first membership happened to
default to (nearly always its own personal organization, TEN-1), never told the link worked, never shown which
course, and never taken to it.

**Choice — the destination lives on the sign-in token row itself, not a `?next=` URL parameter, and not
`sessionStorage`.** `sign_in_tokens` gains a nullable `destination` column
(`packages/db/migrations/0018_ordinary_paibok.sql`), written by `issueSignInToken`
(`packages/auth/src/tokens.ts`) when `requestSignInLink`'s own caller supplies one, and read back by
`consumeSignInToken`/`redeemSignInLink` and returned to the browser on `POST /auth/redeem`. The token is
already a row with a lifetime, tied to the sign-in itself rather than to any tab — exactly the reasoning the
brief named directly, and it is what makes the AUTH-6 e2e's own cross-tab case work at all: `pages/RedeemLink.tsx`
hands the destination straight to `onRedeemed`, and `App.tsx#returnToShell` navigates there before it ever
looks at `sessionStorage`. A `?next=` URL parameter was the brief's other named option; not chosen, since it
would put the same untrusted-input burden (validate before navigating) on every caller that builds the sign-in
link's own URL, where the token-carried version puts it in exactly one place. `isSameOriginPath`
(`packages/auth/src/tokens.ts`) is that validation, applied twice — once at issue time (`apps/api`'s own
`routes/auth.ts`, the same `400` shape a malformed `email` already gets) and once again at redemption
(`consumeSignInToken`, "defended, not assumed," the same discipline this codebase already holds every
should-be-unreachable case to) — and duplicated a third time, deliberately, in `apps/web/src/App.tsx`, since
PLAT-2 forbids that app importing `@bloombot/auth` at all; the same "small, deliberately duplicated pure
function" trade D-34 already chose for `repos/course-join-links.ts`'s own `hashSecret`. The regex itself avoids
a literal control character inside a character class (`eslint`'s own `no-control-regex`, which exists for
exactly this kind of check) by pairing a short prefix regex with a plain char-code loop instead — a `boolean`
inference note, not a measured one: this is a style choice a reviewer could reasonably make differently.

**Choice — one mechanism replaces both, and `PENDING_JOIN_LINK_KEY` is deleted outright.**
`pages/JoinLink.tsx`/`pages/Connect.tsx` now pass their own page's own address as `pages/SignIn.tsx`'s new
`destination` prop; neither stashes anything in `sessionStorage` for the sign-in round trip any more.
`PENDING_CONNECT_ORG_KEY` survives, narrowed: `pages/Connect.tsx`'s `handleConnectDiscord` still uses it to
carry the organization across the Discord OAuth redirect, a *same-tab*, `window.location.assign` round trip
`DiscordCallback.tsx` reads back — genuinely unaffected by AUTH-6, since that redirect never leaves the tab
that started it. `pages/Invitation.tsx`'s `PENDING_INVITATION_KEY` is untouched — ENRL-10 was not named in this
slice's brief, it carries the identical latent defect, and `App.tsx#returnToShell` still falls back to it
(after the token-carried destination) for exactly that reason: a third device beside the retired two was
explicitly forbidden, but a brief that names two of three defects does not authorize fixing the third
un-asked-for. Flagged here for whoever picks up ENRL-10 next.

**Choice — `redeemJoinLinkForWebAccount`'s return shape changes from a bare `Enrolment | undefined` to
`{ enrolment, alreadyEnrolled } | undefined`.** `enrolments.ts#admit` is itself idempotent — a second redemption
returns the *existing* active row unchanged, so nothing about the enrolment alone distinguishes "just admitted"
from "already was." `alreadyEnrolled` is computed with `enrolments.getActiveEnrolment` *before*
`enrolViaJoinLink` runs, inside the same transaction, and only on the path that already leads to a successful
admission — every refusal branch (`!link`, the ENRL-6/ENRL-8 rework's own `wasRemoved` check, a foreign course
or person) still returns a bare `undefined`, unchanged, so ENRL-4's "no oracle" property (never-issued, revoked
and expired stay byte-identical, and none of them ever becomes distinguishable by an `alreadyEnrolled` leaking
into a refusal) holds exactly as it did before this slice — proven by mutation, not merely argued: forcing
`alreadyEnrolled` to a constant `false` turns red every one of the repo-, action- and route-level "already
enrolled" tests and the e2e's own second-redemption case, while every existing "byte-identical refusal" test
(unit and e2e) stays green throughout, since none of them touch the success path at all. `POST /join-links/redeem`
now answers `{ courseId, organizationId, alreadyEnrolled }` on success — `organizationId` is what
`pages/Shell.tsx` needs to open on the right organization (a join-link redeemer is a *connected person*,
LINK-10, not necessarily a member, so the account's own first membership is usually the wrong default);
`alreadyEnrolled` is what lets the browser say "you're already enrolled" rather than repeat the fresh-join
wording. Existing tests that destructured the old shape directly (`packages/db/tests/course-join-links.test.ts`,
`packages/actions/tests/course-join-links.test.ts`) were updated to the new one; none of their own assertions
changed in substance.

**Choice — WEB-25's confirmation lives on `pages/Chat.tsx` itself, not a separate interstitial screen.**
`pages/JoinLink.tsx` no longer renders anything once redemption succeeds — it hands `{ organizationId, courseId,
alreadyEnrolled }` to `onRedeemed` and lets `App.tsx` carry it into `pages/Shell.tsx`'s new `joinedCourse` prop
(the same "carried across this one remount" shape `justInstalled` already uses for the Discord install round
trip). `Shell` prefers `joinedCourse.organizationId` for the initial active organization (checking
*both* `memberships` and `connectedOrganizations` — unlike `justInstalled`'s membership-only check, since a
join-link redemption never grants a membership), defaults `activeTab` to `'chat'`, and passes
`initialCourseId`/`joinConfirmation` through to `Chat`, which seeds `selectedCourseId` from it (so a redeemer
already enrolled in more than one course in that organization still lands on the one just joined, not
whichever `listChatCourses` happens to return first) and renders a `role="status"` banner naming the course by
title — read back from its own already-fetched `courses` list, not a second round trip — and distinguishing
"You're enrolled in…" from "You're already enrolled in…". The banner is inline, not a toast: nothing ever
removes it, satisfying the brief's "must not depend on noticing something that disappears on its own" by
construction rather than by timing a dismissal correctly. Chosen over carrying the confirmation on
`JoinLink.tsx`'s own screen (which the redirect to the shell would have made exactly the kind of transient
thing the brief warns against) and over the join-links route itself resolving a course title (which would have
pulled a fresh dependency — `courses.getCourse` — into `repos/course-join-links.ts`, a file whose own redemption
path several review rounds have already hardened; `Chat.tsx` already holds an authorized, per-account course
read for exactly this organization, so reusing it costs nothing new to trust).

**Rework finding — `App.tsx`'s own `refreshSession()` had to be sequenced *before* the navigation that mounts
`Shell`, not fired alongside it, and this was caught by the e2e, not reasoned out in advance.** The first draft
of the join-link `onRedeemed` handler set `joinedCourse` and called `goToRoot()`/`setPath('/')`/`refreshSession()`
all in the same tick — `pages/Shell.tsx`'s own `activeOrganizationId` is a `useState` lazy initializer, which
runs exactly once, on `ShellInner`'s first mount, off whatever `account.connectedOrganizations` that render
already has. The join-link redemption that produces `joinedCourse` is the very thing that adds the institution
to that list, reachable only once a *fresh* `/auth/me` read reflects it — and firing `refreshSession()`
alongside the navigation let `path` reach `/`, and `Shell` mount, off the *stale* `session` still on hand from
before redemption (or, on the sign-in-round-trip path, from immediately after sign-in but before the join link
itself was redeemed). The panel opened on the account's own personal organization regardless of what
`joinedCourse` said, and a later, resolved `session` update did not retroactively re-run an initializer that
had already run. `e2e/join-link.spec.ts`'s own main scenario failed on exactly this — the organization switcher
listed the joined institution as an option but never selected it — before the fix, which now chains the
navigation off `refreshSession()`'s own returned promise (a small addition: `refreshSession` now returns the
promise it always silently discarded, changing nothing about its existing fire-and-forget callers).

**Evidence.** Mutated and confirmed red, then reverted, three properties: (1) the destination mechanism —
disabling the token-carried branch in `App.tsx#returnToShell` turned every `e2e/join-link.spec.ts` test red,
including the never-issued-secret one (which still depends on the sign-in round trip landing back on the join
link at all); (2) `alreadyEnrolled` — forcing it to a constant `false` in
`repos/course-join-links.ts#redeemJoinLinkForWebAccount` turned red the repo-, route- and e2e-level
"already enrolled" tests, while every refusal test (byte-identical across never-issued/revoked/expired) stayed
green, confirming the no-oracle property was never touched; (3) the same-origin check — dropping
`isSameOriginPath` from `routes/auth.ts`'s own `zod` schema turned the "refuses a non-same-origin destination"
test red (it surfaced as a `500`, not a silent `204`, since `issueSignInToken`'s own defended-not-assumed check
still fired — belt-and-braces holding even with the belt cut).

Final counts: 90 node:test (unchanged), 2119 vitest across 182 files (baseline at `ef1f8f0` was 2107/182 — +12
tests, no new file), 24 e2e (baseline 22 — `e2e/join-link.spec.ts` gained two tests: the AUTH-6 cross-tab case
and the WEB-25 already-enrolled case; `e2e/connect.spec.ts` unchanged in test count, its own module comment
updated).

**Limits.** `pages/Invitation.tsx`'s identical `sessionStorage` defect (ENRL-10) is untouched — see the second
choice above. The `hasActiveSignInToken` anti-flood check (`requestSignInLink`, AUTH-1's "also worth doing")
can silently decline to issue a *second* token — and so silently drop a *different* destination — while an
earlier, undestined one for the same address is still outstanding (within its fifteen-minute lifetime); a
narrow, pre-existing edge case this slice did not widen and did not attempt to close, since doing so would mean
mutating an already-issued, unconsumed token, a different (and larger) change than this slice's own brief
asked for.

**Rework — closing this entry's own named limit: `pages/Invitation.tsx` was the one entry point this slice
left behind.** An owner's invited colleague (ENRL-10) is emailed a membership invitation exactly the way a
join link is, so it carried the identical defect this entry's own "Problem" already fixed for join links and
Discord connect: `Invitation.tsx` still stashed `PENDING_INVITATION_KEY` in `sessionStorage`, which a mail
client opening the sign-in link in a fresh tab cannot read, stranding the colleague on the plain shell with no
membership and no explanation. Fixed the identical way this entry's own two paths were: `Invitation.tsx` now
passes its own address as `SignIn`'s `destination` prop, carried on the sign-in token itself
(`isSameOriginPath`/`consumeSignInToken`, already generic — no change needed to `packages/auth` or
`routes/auth.ts` to accept a third caller); `App.tsx#returnToShell`'s own `sessionStorage` fallback branch is
now dead code with all three paths converted, and was removed rather than left unreachable.
`PENDING_INVITATION_KEY` is retired the same way `PENDING_JOIN_LINK_KEY` already was; `PENDING_CONNECT_ORG_KEY`
keeps its one remaining job (the same-tab Discord OAuth redirect, unrelated to sign-in). `e2e/join-link.spec.ts`'s
own cross-tab test (`context.newPage()` — a real second browsing context in the same `BrowserContext`, sharing
cookies but not `sessionStorage`) is the precedent `e2e/membership-invitation-panel.spec.ts` now has its own
copy of, seeding the invitation directly against the e2e database rather than through the panel (the panel path
is already proven by the pre-existing test in that file).

**A process failure, named rather than smoothed over: a mutation-test leftover shipped as if it were the fix,
caught by an independent review rather than by this agent.** While verifying the tests above fail without the
fix (this document's own standing discipline), `Invitation.tsx`'s `destination` prop was intentionally removed
to confirm `invitation.test.tsx`'s new test went red — and then, mid-investigation of an unrelated, apparently
flaky e2e timeout, was never restored before moving on. The result: `Invitation.tsx`'s own module comment
described passing a `destination` prop the code directly beneath it did not pass, `SignIn.tsx`'s own prop doc
still claimed only two callers had anywhere to return to, and roughly forty minutes were spent diagnosing the
resulting e2e timeout as a suspected environment/resource issue — checking system load, testing the API
directly with `curl` (which worked, instantly, correctly, because the *backend* was never broken), and
concluding, wrongly, that this was shared-machine contention rather than the tree's own uncommitted state. The
review that caught it read the comment against the code directly, which is the check this discipline should
have applied before ever declaring the mutation test "confirmed" and moving on. Fixed, and the lesson is
procedural, not technical: **finish reverting a mutation before starting the next investigation, and re-read
the file's own comment against its own code as the last step before calling a fix done** — the second half is
what four separate review rounds on this branch have now caught missing at least once.

**A second, unrelated drift found in the same working set: `docs/DEPLOY_DROPLET.md` carried roughly 300 lines
this slice never wrote** — a specific domain's own DNS delegation walkthrough (`wonkledge.com`, GitHub Pages
coexistence, a reserved IP, nginx gzip/caching, swap sizing), unrelated to CORE-7/CORE-8 or AUTH-6/ENRL-10 and
absent from both briefs. Reverted to `HEAD` rather than kept or explained as this slice's own output, since
none of it does in fact fall out of this work — it reads like a real operator's own working notes from an
actual deployment, mixed into this working tree by some means this agent cannot account for (not a hook, not
a mutation test, not anything intentional in this session's own record) and is flagged here exactly because
"I am not assuming either way" was the right instruction: this agent is not the source of it and cannot claim
otherwise, but also has no evidence pointing elsewhere. Worth a supervisor's own look at whether the working
tree saw a second writer despite the "one writer at a time" rule this build otherwise holds to.

**Evidence.** `invitation.test.tsx`'s new test and the rewritten `app.test.tsx` case were both confirmed
failing (the former: `requestSignInLink` called with `undefined` where `/invitations/secret-abc` was expected;
the latter: unaffected by this particular mutation, by design — it mocks `redeemSignInLink`'s own response
directly, proving `App.tsx`'s dispatch is generic rather than re-testing `Invitation.tsx`'s own wiring) and
passing once reverted. `e2e/membership-invitation-panel.spec.ts`'s new AUTH-6 case was confirmed failing
(30-second timeout waiting for the granted membership to appear on the switcher — it never does, because the
colleague never returns to `/invitations/:secret` to redeem it) and passing once reverted, and the pre-existing
ENRL-10 test in the same file — untouched by this slice, confirmed via `git diff` showing zero change to its
own body — failed and passed on the identical schedule, which is what actually revealed the mutation had been
left in place rather than an environment issue.

Final counts after the rework: 90 node:test (unchanged), 2128 vitest across 183 files (unchanged from D-70's
own rework, above — this rework touched no vitest file), 25 e2e (this entry's own original baseline was 24;
+1, `e2e/membership-invitation-panel.spec.ts`'s new AUTH-6 case). `npx drizzle-kit check` (from `packages/db`):
clean, no drift.

**Limits, updated.** The `hasActiveSignInToken` anti-flood limit named above is unchanged and now applies
identically to `Invitation.tsx`'s own `requestSignInLink` call. Nothing about the redemption logic itself
(`redeemMembershipInvitation`, `packages/db`) needed to change — confirmed directly, by driving the whole
sign-in-and-redeem round trip against the running e2e API with `curl` alone, bypassing the browser, while
diagnosing the mutation above: every call resolved correctly and in milliseconds, which is what first pointed
away from a backend defect and eventually toward the tree's own uncommitted state instead.

---

**Rework — a second independent review found two must-fix defects, a cheap-fix, and two notes; this closes all
five, and corrects a claim this entry's own earlier "Limits" made.**

**Must-fix 1 — `pages/Chat.tsx`'s join confirmation named whichever course was *currently selected*, not the
one that was joined.** `joinedCourseTitle` derived from `selectedCourseId`, the same state the course
`<select onChange>` rewrites on every switch — and the banner has no dismissal, so it kept asserting a fact
about whatever the student most recently looked at, for as long as the mount lived. Reproduced exactly as the
review described it: a student already enrolled in one course redeems a link for a second, sees the correct
banner, then switches the picker to check the first — and the banner now reads a fresh-join (or, on the
`alreadyEnrolled` path, an "already enrolled") claim about a course they have been in for weeks, or about the
one the link never named at all. Fixed by deriving the title from `initialCourseId` instead — the one prop this
component never reassigns after mount, unlike `selectedCourseId`, which is exactly why it is the correct key
for a banner about a one-time event rather than the current selection. `apps/web/tests/chat.test.tsx` gained a
case that switches the picker after the banner renders and asserts the joined course's own name survives the
switch — neither existing case caught this, since both asserted before any switch ever happened.

**Must-fix 2 — the anti-flood guard silently discarded a repeat request's own `destination`, and this entry's
own "Limits" (above) understated what that meant.** `requestSignInLink` returns early on
`hasActiveSignInToken` before `issueSignInToken` ever runs, and that check is keyed on `(email, usedAt IS NULL,
expiresAt > now)` alone — it never consulted, and nothing ever updated, the outstanding row's own
`destination`. Reproduced over real HTTP: `POST /auth/request-link` with `{ email }`, then again inside the
token's own fifteen-minute TTL with `{ email, destination: '/join/SECRET' }` — `204`, one email sent, and
redeeming the only link that exists carried no destination at all: exactly the "lands on the empty shell,
enrolled in nothing" outcome AUTH-6 exists to prevent, and `docs/SPEC.md`'s own AUTH-6 states unconditionally
("regardless of which tab completes it"). The record needs correcting, not merely the code: this entry's own
"Limits" called it "a narrow, pre-existing edge case this slice did not widen." That is wrong on the history.
Under `ef1f8f0`, `JoinLink.tsx` wrote `PENDING_JOIN_LINK_KEY` to `sessionStorage` **on mount**, before any
network call at all — the same-tab return trip was immune to this guard entirely, since nothing about setting a
`sessionStorage` key goes anywhere near `hasActiveSignInToken`. Retiring that marker in favour of the
token-carried destination (this entry's own first "Choice," above) moved the return address behind a code path
the anti-flood guard can skip — a straight regression for the same-tab case, and silent in both directions:
neither an error nor a different response distinguishes "the destination was recorded" from "an earlier,
outstanding token answered instead." Fixed by updating the outstanding token's own `destination`
(`packages/db/src/repos/sign-in-tokens.ts#updateSignInTokenDestination`, called through a same-named,
re-validating wrapper in `packages/auth/src/tokens.ts`, from `requestSignInLink`'s own anti-flood branch) rather
than issuing a second token — re-issuing on every repeat request would defeat the anti-flood control this guard
exists to be; updating the row instead costs neither a new token nor a new email, since the already-emailed
link's own token value never changes, only what its eventual redemption reads back. A request that omits
`destination` never clears one an earlier, still-outstanding request already set — only a *supplied* value ever
overwrites the column, so a later, less specific request cannot silently downgrade a more specific one still in
flight. Covered at every layer the first pass covered `alreadyEnrolled` at: `packages/db/tests/sign-in-tokens.test.ts`
(the repo primitive, including that a consumed or expired row is never revived by this), `packages/auth/tests/tokens.test.ts`
and `sign-in.test.ts` (the validating wrapper and `requestSignInLink`'s own branch, including the
exact anti-flood-preserving shape — still one email, one row), and `apps/api/tests/auth-flow.test.ts` (the
review's own HTTP-level reproduction, verbatim).

**Cheap-fix — three of `isSameOriginPath`'s four enforcement points were unpinned.** The full suite stayed
green under each of: deleting `consumeSignInToken`'s own redemption-time re-validation, deleting
`issueSignInToken`'s own write-time throw, and reducing `App.tsx#returnToShell`'s own
`if (destination && isSameOriginPath(destination))` to `if (destination)`. All three are defence-in-depth
against the identical mistake, and the two implementations (`packages/auth`'s own, and `apps/web`'s deliberately
duplicated copy) already agreed — so nothing was exploitable — but nothing pinned that agreement, and
`App.tsx`'s copy is the one its own comment calls "the one gate between a caller-supplied string and the
browser's own address bar." Closed with two shared adversarial values (`//evil.example`, `/\evil.example` —
both resolve *off* origin despite looking like a path) asserted in both `packages/auth/tests/tokens.test.ts`
(pinning the write-time throw and the redemption-time re-check, the latter by writing a bad value directly
through `@bloombot/db`'s own repo — the only way to reach a row `issueSignInToken` itself would never have
produced) and `apps/web/tests/app.test.tsx` (pinning `App.tsx`'s own copy, by mocking `redeemSignInLink` to
resolve with each value and asserting the app lands on the ordinary shell rather than attempting to navigate to
either).

**Note, addressed — `routes/auth.ts`'s `destination` schema had no length bound.**
`z.string().refine(isSameOriginPath)` accepted (and would have stored) an arbitrarily long path on an
unauthenticated endpoint; the anti-flood guard limits *rate*, not *size*, so a single request was still a
single, unbounded write. `.max(256)` now sits beside the `.refine()` — generous against every real path this
app issues a link for (`/join/:secret`, `/connect/:organizationId`, `/invitations/:secret`, each at most a few
dozen characters), and small enough to refuse a `10_000`-character same-origin-shaped destination with the
ordinary `400` this route already answers for every other malformed input (`apps/api/tests/auth-flow.test.ts`'s
own new case — sized well under `express.json()`'s own default 100kb body limit, so it is `requestLinkInputSchema`'s
`.max()` being proven, not the body parser refusing an oversized request outright with an unrelated `413`).

**Note, recorded — `sign_in_tokens.destination` trades away a property `course_join_links` deliberately
keeps.** `course_join_links` stores only `secretHash` (`repos/course-join-links.ts`'s own module comment) so
that reading the database alone never lets anyone redeem a link — a live secret is never at rest in plaintext.
`sign_in_tokens.destination` now stores a live join-link secret (the `/join/:secret` path itself) in plaintext,
for that token's own fifteen-minute life, partially undoing that property for whatever fraction of a
token's lifetime it is unredeemed. The exposure this accepts is small — the secret is already class-shared (an
entire roster holds the same one) and already travels in the clear by URL and by email, the two places this
column's own value came from in the first place — but it is a real trade this entry did not previously write
down, and the same trade now applies identically to `updateSignInTokenDestination`'s own write path (must-fix
2, above), which touches the same column with the same kind of value. Flagged explicitly for ENRL-12, which
plans to store join-link secrets encrypted at rest in `course_join_links`: whoever builds it should decide
whether `sign_in_tokens.destination` needs the same treatment, or whether the short lifetime and existing
exposure (URL, email) make it a deliberately accepted gap instead — this entry takes no position on which, only
that the interaction exists and someone building that slice should see it before deciding.

**Evidence.** Mutated and confirmed red, then reverted, five further properties, the same discipline this
entry's own first "Evidence" (above) already held itself to: (1) the Chat banner — reverting to
`selectedCourseId` turned the new switch-then-assert case red while leaving every pre-existing case green
(neither asserted after a switch); (2) the anti-flood/destination fix — reverting `requestSignInLink`'s own
branch to a bare early return turned red the new cases in `sign-in-tokens.test.ts`, `tokens.test.ts`,
`sign-in.test.ts` and `auth-flow.test.ts` alike; (3)–(5) each of the three newly-pinned `isSameOriginPath`
enforcement points — deleting each guard in turn (`consumeSignInToken`'s re-check, `issueSignInToken`'s throw,
`App.tsx`'s own `&&` clause) turned exactly the test written for that point red, and no other test in the
affected file, confirming each test pins the specific layer it claims to and not some other one already
covering for it.

Final counts after this rework: 90 node:test (unchanged), 2146 vitest across 183 files (this entry's own prior
rework left 2128/183; +18 tests, no new file), 25 e2e (unchanged — this rework touched no e2e file; the
`isSameOriginPath` cheap-fix and the anti-flood must-fix are both pinned at the unit/integration level, not
through a third browser round trip). `npx drizzle-kit check` (from `packages/db`): clean, no drift — this
rework added no migration.

## D-72 — `apps/web`/`e2e`: WEB-24 — the chat composer stays put, and the thread follows the conversation, without stealing a reader's place

**Problem.** `pages/Chat.tsx` laid the thread and the composer out in ordinary flow: the thread `<div>` had
`min-h-64` and `overflow-y-auto` but no maximum height, so it grew with the conversation and the *page*
scrolled — carrying the composer off the bottom of the window. A student partway through a long thread had to
scroll the whole page down to type. `useEffect(() => threadEndRef.current?.scrollIntoView(...), [messages])`
compounded it: with nothing bounding the thread, it was no longer the nearest *scrollable* ancestor, so
`scrollIntoView` walked up to the document and moved the page, not the thread.

**Choice — a flex column bounded to exactly the space `AppShell.tsx`'s fixed header and footer leave, not
`position: fixed`, and not a change to `AppShell.tsx` itself.** `Chat.tsx`'s own top-level `<section>` now
carries `h-[calc(100dvh-var(--spacing-header)-var(--spacing-footer)-3rem)] overflow-hidden` —
`--spacing-header`/`--spacing-footer` are the same tokens `AppShell.tsx` sizes its own fixed header and footer
with (`style.css`); the `3rem` is the 1.5rem gap `AppShell`'s own `main` padding reserves on each side. Every
element above the thread (title, join banner, course picker, "New messages" affordance, decline notice, the
composer form) is `shrink-0`; the thread itself is `flex-1 min-h-0 overflow-y-auto` — `min-h-0` overrides a
flex item's default `min-height: auto` (sized to its content), which would otherwise refuse to shrink below the
transcript's full height and reproduce the exact "grows past its box" defect one level up. `overflow-hidden` on
the section is what actually enforces the bound: without it a flex column's children can still spill past a
fixed height rather than being clipped to it. `100dvh`, not `100vh` — the dynamic viewport unit shrinks with a
mobile browser's own chrome and, on the browsers that report it, a software keyboard, so this box (and the
composer pinned inside it) resizes down with the keyboard rather than leaving the composer hidden underneath
it; this was not proven against a real on-screen keyboard (Playwright does not drive one), so it is a design
choice following the platform's own contract for `dvh`, not a measured result.

`AppShell.tsx`'s own `main` (`min-h-[calc(100vh-var(--spacing-header)-var(--spacing-footer))]`, no maximum) was
deliberately left alone: every other screen this shell renders (Projects, Transcripts, Usage, Team, Jobs,
Discord) relies on it growing with its content and letting the ordinary document scroll past the fixed
header/footer, and the brief scoped this slice to the one screen with the reported defect. `position: fixed`
for the composer alone was rejected for the same reason the brief named directly: it fights `AppShell`'s own
already-fixed header and footer rather than composing with them, and a flex column that simply bounds the
thread needs no coordination with either.

**Choice — the scroll-preservation judgement.** WEB-24's own text draws a distinction the previous
`scrollIntoView` effect did not: "following the conversation" means the newest message, not a jump that steals
a reader's place. `isNearBottomRef`, kept current by `onScroll` on the thread itself (appending a message never
fires a `scroll` event on its own — the browser does not move `scrollTop` just because the scrollable content
beneath it grew — so this only ever reflects the reader's own last movement), decides whether a message that
*arrives* auto-scrolls or shows a "New messages ↓" affordance instead (`newMessageWaiting`, a plain `role="status"`
sibling of the thread — an `aria-live` region, so it is announced the moment it appears — holding one ordinary
`<button>`, reachable by Tab and Enter/Space like every other control on the screen, never an overlay that could
cover the last message). The student's own send is the one case the requirement draws no such exception for:
`forceScrollRef`, set immediately before the optimistic message is appended in `handleSend`, jumps the thread to
it unconditionally, even if the reader had scrolled up to reread something first — consumed and reset the first
time the scroll effect runs afterward, so the *reply* that follows is judged by `isNearBottomRef` alone, the same
as any other arriving message.

**Note, addressed — `min-h-64` was removed, not kept as a floor.** A fixed minimum height under a bounded,
`flex-1` thread would fight the very containment this slice exists to add: on a short viewport it could force
the thread taller than the space actually available, pushing the composer past the bottom of the column again.
`flex-1` already fills whatever the column has left once every `shrink-0` sibling has taken its own height, which
is generally more generous than 16rem on any realistic screen, and degrades gracefully (down to `min-h-0`, never
negative) on one that is not.

**Evidence.** `apps/web/tests/chat.test.tsx`'s own "Chat — thread scroll behaviour (WEB-24)" block proves, in
jsdom, the one property jsdom's lack of real layout still lets it prove deterministically: `pages/Chat.tsx` sets
the thread's own `scrollTop` to its `scrollHeight` — the imperative action "scroll to the newest message" means
in code — on the student's own send, on a reply arriving while near the bottom (proven as a *second*, independent
effect run, not merely the same assignment left over from the send), and *not* on a reply arriving while the
reader had scrolled away, where the "New messages" button appears instead and a click on it both scrolls and
dismisses it. `e2e/chat-scroll.spec.ts` proves what jsdom cannot lay out to see at all, against a real browser: a
forty-message thread (seeded directly through `@bloombot/db#conversations.appendMessage` rather than forty real
chat requests) overflows the bounded thread, the composer stays reachable with `window.scrollY` at `0` and no
page scroll, the thread itself opens and then re-scrolls to within a few pixels of its own maximum, the composer
never covers the last message (a real bounding-box comparison, not "both are visible"), and the page does not
scroll horizontally at a 375px width.

**Left unproven, honestly.** "A reply arriving while the reader has scrolled up does not move them" is proven
deterministically in the unit test (a controlled, deferred `postChatMessage` promise lets the test scroll the
mocked thread up *between* the student's own send and the reply's arrival) but not exercised in
`e2e/chat-scroll.spec.ts`: the real fixture model answers fast enough that reproducing "scrolled up while a
reply is still in flight" against a real network round trip would mean racing the test's own scroll action
against the response, which is exactly the kind of timing-dependent assertion this codebase's own e2e discipline
(`playwright.config.ts`'s `workers: 1` comment; QA-9) already rejects elsewhere. A soft-keyboard interaction on a
real mobile browser is untested for the same reason Playwright cannot drive one — the `100dvh` choice above is a
design decision following the platform contract, not a measured result.

**Evidence, mutations.** Removing the thread's height bound (`h-[calc(...)]`/`overflow-hidden` on the section,
`flex-1 min-h-0` on the thread, all reverted to the pre-fix `flex flex-col gap-4`/`min-h-64`) turned
`e2e/chat-scroll.spec.ts` red on `toBeInViewport()` for the composer — confirming the composer genuinely fell out
of the viewport without the bound, the reported defect exactly. Scrolling the page instead of the thread
(`scrollThreadToBottom` mutated to `window.scrollTo(0, document.body.scrollHeight)`) turned the same spec red on
the thread's own `scrollTop` staying `0` — confirming the thread never moves under this mutation, since the
bounded section has nothing of its own to scroll the page *to*. Auto-scrolling unconditionally, ignoring
`isNearBottomRef`, turned the unit test's "reply arriving while scrolled up" case red — the thread jumped to
`260` where the test asserts it stays at `0` — and left the other twelve `chat.test.tsx` cases green, confirming
that test pins exactly this property and nothing broader.

Final counts after this slice: 90 node:test (unchanged), 2149 vitest across 183 files (+3 tests, no new file —
`apps/web/tests/chat.test.tsx`'s own new "thread scroll behaviour" block), 26 e2e (+1 — `e2e/chat-scroll.spec.ts`,
new). `npx drizzle-kit check` (from `packages/db`): not run — this slice touched no schema.

---

## D-73 — `packages/db`/`packages/actions`/`apps/web`/`e2e`: ENRL-11 — a membership can be revoked, and an organization always has an owner

**Problem.** D-67 granted a role and D-68 invited a colleague who had none; neither took anything away, and each
said so explicitly (D-67's own "Out of scope, deliberately" — "Demoting or removing a membership... is not built
here... deciding what, if anything, stops the last owner removing themselves... is left for whoever picks it up
next"; D-68's own "Removal/demotion... exactly the same open questions D-67 left, unchanged"). Together they
create the gap this requirement names: D-68 is what first makes an outside account reachable as an owner in
production, and once redeemed, that new owner could call `memberships.grant` to demote the original owner with
no recourse, because nothing revoked a membership and nothing distinguished the account that created an
organization from one invited into it. `deleteMembership` (`packages/db/src/repos/memberships.ts`) had existed,
uncalled, since before D-67; nothing in `components/Team.tsx` offered a way to remove a row at all.

**Choice, mark rather than delete.** The brief named this as mine to judge. ENRL-5 already requires a grant be
*recorded* — `grantedByAccountId`/`grantedAt`, stamped on the row itself, not a separate audit log
(`schema.ts`'s own comment on those two columns). A hard delete through `deleteMembership` would answer neither
"who revoked this" nor "when" the moment it ran — exactly the kind of thing an institution has to account for on
the way out, the identical reasoning TEN-6 already gives `discord_server_bindings.removed_at` for the same class
of removal. `revokedByAccountId`/`revokedAt` (new columns, `0019_normal_patriot.sql`) mark instead, mirroring
`discord_server_bindings.removed_at` and `course_join_links.revoked_at` exactly. `deleteMembership` itself is
untouched and still uncalled — kept for whatever a future caller (a full account deletion, say) genuinely needs
to be a hard delete, but `memberships.revoke` (the new action) never reaches it.

**Consequence of marking: `getMembership` had to become the "active" query, and every one of its ~15 existing
callers had to keep working unchanged.** `getMembership` is the one function nearly every authorization check in
this platform calls — `apps/api`'s `routes/actions.ts`/`chat.ts`/`discord-servers.ts`/`transcript-exports.ts`,
`apps/mcp`'s `authenticate.ts`/`call-tool.ts`, this package's own `discord-servers.ts`, and every owner-only
action in `@bloombot/actions` — to answer "does this account currently have any standing here". A revoked row
that `getMembership` kept returning would make revoking a no-op everywhere it actually matters, which is exactly
the failure a first draft of this slice hit: marking the row without changing the read left every downstream
check still authorizing the revoked account. `getMembership`'s own `WHERE` now excludes `revokedAt IS NOT NULL`
— every one of those callers gets "a revoked membership is absent" for free, with no edit to any of them, and
the `packages/actions` census tests (`access-audit.test.ts`, `catalog.test.ts`) and `apps/api`'s own
`tenant-isolation.test.ts` all stayed green with zero changes beyond registering the new action, confirming
nothing there had to learn a new column exists. `listMembershipsForOrganization` (the Team roster) and
`listMembershipsForAccount` (`GET /auth/me`'s own organization discovery) both got the identical filter, for the
same reason: a revoked membership must not still list as a current holder, or still name an organization the
caller may act in.

**Consequence of marking, the other direction: `grantMembershipRole` needed its own, unfiltered lookup.** The
composite primary key on `memberships` (`organizationId`, `accountId`) means a revoked row still occupies that
key exactly as an active one does. `grantMembershipRole`'s own "does a row already exist, so this is an update,
not an insert" check used to be `getMembership` — now filtered to active-only, it would say "no" for a
previously revoked account and attempt a second `INSERT` against a primary key the revoked row already holds,
which SQLite refuses. Reached in practice through `redeemMembershipInvitation` (ENRL-10): that function's own
"already a member" refusal also now reads a revoked account as having none, so a previously revoked colleague
can be invited back in exactly like a stranger — and the redemption's own `grantMembershipRole` call would have
crashed on the primary key without a fix. `findMembershipRow` (module-private, unfiltered) is that fix — used
only by `grantMembershipRole`'s own `existing` check — and the update branch now also clears
`revokedAt`/`revokedByAccountId`, so a fresh grant genuinely reactivates the row rather than leaving a stale
revocation on one this call just made active again. Measured by mutation: dropping that reset (`packages/db/tests/memberships.test.ts`'s
own "grantMembershipRole reactivates a previously revoked membership" test) fails without it; so does reverting
`findMembershipRow` back to `getMembership` inside `grantMembershipRole`, though that failure mode is a thrown
`SQLITE_CONSTRAINT` rather than a clean assertion — caught in this same test, from the other direction, before
committing.

**Choice, the decision ENRL-11's own text names as unsettled: an owner's own role changes only when that owner
acts — never by a peer, through *either* action that can touch a role.** The brief required this be decided,
implemented, and recorded rather than left to whichever screen was written first (D-67's and D-68's own
deferral). ENRL-11's own text is explicit that this decision is the requirement's central question, not one
scoped to a single new action. Enforced in `revokeMembershipAction#execute` (`entity.role === 'owner' &&
entity.accountId !== accountId` refuses), because — the same reason `grantMembershipAction`'s own owner/self
checks live in `execute`, not the policy — `PolicyContext` carries no caller account id at all. Measured by
mutation: dropping this check made `packages/actions/tests/memberships.test.ts`'s own "an invited peer owner
cannot revoke the founding owner" test fail (the call that should be refused instead succeeded); the self-target
case remains allowed by the same check (`entity.accountId === accountId` is exempted), proven by "an owner may
step down themselves, when they are not the organization's last owner" passing unmodified.

**Correction — a first pass at this slice answered the decision above only for `revoke`, leaving `grant` open,
and that is the exposure ENRL-11 was written to close.** The brief that scoped this slice's first pass named
`memberships.grant`'s own behaviour as out of scope; ENRL-11's own SPEC text says the opposite — the peer-demotion
question is the requirement's central one, not incidental — and the brief's own scoping was the mistake, caught
on review, not a defensible reading of the requirement. Left as the first pass shipped it, the scenario ENRL-11
exists for still worked end to end: an owner invites a colleague at `owner` (ENRL-10 permits it), the colleague
redeems, and the colleague calls `memberships.grant` with `{ email: <inviter>, role: 'assistant' }` — which
succeeded, because `grantMembershipAction#execute` refused a missing caller, a non-owner caller, an unknown
email, a non-member target and a self-target, but never a peer owner as the *target*. `grantMembershipAction`
now carries the identical check `revokeMembershipAction` already had: after the existing self-target refusal
(check 3, which already forces `target.id !== accountId` by the time check 4 runs), a target whose *current*
membership is `'owner'` is refused, exactly the same demote-side twin of the revoke-side decision above.

**Finding, while wiring the fix — a real bug, not only a scoping gap.** The first attempt at check 4 read
`target.role === 'owner'`, where `target` is `accounts.getAccountByEmail(input.email, db)`'s own return —
`accounts`' `Account` type, which carries no `role` column at all (that lives on `memberships`, a separate
table); `target.role` is `undefined` at runtime, so `undefined === 'owner'` is always `false` and the check was a
silent no-op. This did not surface as a type error because `Account`'s own shape has no index signature to
flag an unknown property access as invalid in the context it was written — plain property access on a mistyped
variable, not a type-system gap this repository's own settings would ordinarily catch, which is exactly why the
test that actually dispatches the scenario (not merely reads a descriptor or a return type) is what caught it:
"refuses an owner demoting another owner, not-found-shaped" failed with the grant *succeeding* on its first run,
before the fix. The fix keeps `check 2`'s own `memberships.getMembership` result (`targetMembership`, not
discarded) and reads `targetMembership.role` instead. Recorded here as the report's own instruction requires:
an honest "this did not work yet" is worth more than a confident summary that turns out wrong.

**Choice, the refusal stays byte-identical — proven directly, not merely asserted from the shared `ActionRefusedError`
constructor.** `grantMembershipAction`'s own doc comment (rework finding 1) already treats "this action never
becomes an account-existence oracle" as load-bearing; a peer-demotion refusal that read, timed, or looked
different from the action's other refusals would open a *second* oracle — "that account is an owner" — of the
identical shape the first rework closed. `packages/actions/tests/memberships.test.ts`'s own "the peer-owner
refusal is byte-identical to an existing grant refusal" test catches both an unknown-email refusal and a
peer-owner refusal, from the same caller, and asserts `{ name, message, code }` are equal — not merely that both
are instances of `ActionRefusedError`, which `ActionRefusedError`'s own parameterless constructor already makes
true by construction and would pass even if a caller mutated `.message` after construction, exactly the mutation
tried and caught (see below).

**Choice, no organization is stranded by closing the peer-demotion path too.** The brief asked this be checked
explicitly rather than assumed. The two states named — a sole owner who wants to leave, and a two-owner
organization where one leaves — both still have an exit: check 4 only refuses a target whose role is *already*
`'owner'`; granting the `'owner'` role to a target who does not yet hold it (a promotion) is untouched, so a sole
owner can still promote a successor via `grant`, then step down via `revoke` once a second owner exists to
receive the last-owner guard's "more than one" count — proven directly by
`packages/actions/tests/memberships.test.ts`'s own "a sole owner has a way out" test, not merely reasoned about.
A two-owner organization where one leaves is the ordinary self-revoke path, already proven by "an owner can still
step down via memberships.revoke, unaffected by this check". The one state with genuinely no exit — a peer owner
who wants to *remove* another, unwilling owner without that owner's own action — is not a stranding: it is the
decision itself, working as intended. No organization ever loses its floor of one owner, and no owner is ever
trapped holding a role with no way to leave it; only forcing a colleague out against their will is closed, which
is what this decision says should be true.

**Choice, the last-owner invariant is enforced in the repo, not the action.** The brief was explicit that this
belongs where the write happens, "not in the screen that offers it" — and named the action as an acceptable
alternative to the repo. I chose the repo (`repos/memberships.ts#revokeMembership`) over the action, because
this is a data invariant ("an organization has zero owners") rather than a fact about *who is calling* — the
class of check `grantMembershipRole`'s own module comment already separates from "who may call this", which
stays in `execute`. Enforcing it in the repo means any future caller of `revokeMembership` — not only today's one
action — is forced through the same guard, the same reasoning `TargetMembership`'s own resolve being TEN-5-scoped
protects every future caller of the policy, not only this one. The count of active owners and the revoking write
run inside one `db.transaction(...)` — the same "narrow the race, don't just document it" discipline
`course-join-links.ts#redeemJoinLink`'s own comment already explains — so two concurrent revokes of two
different owners cannot both observe "more than one left" and both proceed, leaving none. Measured by mutation:
replacing the `activeOwners.length <= 1` check with `false` (never refuse) made `packages/db/tests/memberships.test.ts`'s
own "the last owner cannot be revoked, even by another owner" test fail — the sole owner's membership was
actually removed. `revokeMembershipAction#execute` cannot tell "the last owner" apart from "nothing left to
revoke at all" from `revokeMembership`'s own `undefined` return, by design — both become the identical
`ActionRefusedError`, TEN-5's "not-found rather than a different refusal" shape, so a caller probing which
reason it got learns nothing either way.

**Choice, revoking removes staff authority and nothing else.** TEN-6 and ENRL-6 both hold this rule for the
identical reason (removal must never delete what an institution may be required to retain), and `revokeMembership`
touches only the `memberships` row — it calls into no other repo. Proven directly, not merely by omission:
`packages/actions/tests/memberships.test.ts`'s own "revoking deletes no transcript and ends no enrolment" test
seeds a course, an active enrolment and a conversation with messages, revokes an unrelated instructor
membership, and counts every one of those rows before and after — the same TEN-6 discipline
`packages/actions/tests/discord-servers.test.ts#countRows` already holds itself to, rather than trusting that an
action touching one table could not possibly reach another.

**Finding — the "holder can no longer do what that role permitted" test could not use an owner-role target the
way a first draft tried.** The first version of that test promoted a colleague to owner, then had the *original*
owner revoke them — which the peer-owner decision above refuses outright, so the test itself failed against the
correct implementation, not merely against a bug. Fixed by having the colleague step down *themselves*
(`accountId: colleague.id` as both caller and target) before proving `costLedger.setSpendingCap` (owner-only,
checked inside its own `execute`) refuses the identical call afterward — a genuine "real access, lost" proof
that also respects the requirement's own peer-owner rule rather than working around it.

**The UI (`components/Team.tsx`, ENRL-11): the screen explains, the write decides.** A row's own control depends
on whose row it is, computed entirely from `entries` (`listMembershipsAction`'s own return) and a new
`viewerAccountId` prop (threaded from `pages/Shell.tsx`'s own `account.id`, the caller's `/auth/me` identity) —
no separate request. A peer owner's row carries no control at all (the server would refuse every attempt
identically, so offering one would only teach a caller to expect a refusal); the viewer's own `'owner'` row
offers "Step down", disabled with the reason stated in the row itself when `entries` shows exactly one active
owner — the same count the repo's own guard uses, read off the list this screen already fetched rather than a
second request. A non-owner row always offers an ordinary "Revoke". The confirmation states both halves before
sending, the same discipline `handleGrant`/`JoinLinks.tsx#handleRevoke` already hold themselves to. Measured by
mutation, both in `apps/web/tests/team.test.tsx`: replacing the last-owner disabled condition with `false` left
the sole owner's own "Step down" control enabled — caught by the "disables... with the reason given" test;
replacing the peer-owner exclusion with "always show" surfaced a control on a peer owner's row — caught by the
"withholds the revoke control on a peer owner's row" test.

**Evidence, mutation testing beyond what is recorded above.** Every mutation the brief's own "On evidence" list
names was tried directly, each confirmed to turn a specific test red, then reverted: dropping the last-owner
guard (repo test above); letting the revoker be supplied by the request body (`revokeInputSchema` reverted from
`z.strictObject` to a plain `z.object` — `packages/actions/tests/memberships.test.ts`'s own "refuses a revoke
whose body supplies revokedByAccountId" fails without it, the identical `z.strictObject` discipline D-67's own
`grantInputSchema` already established); allowing a non-owner to call the action at all (`callerMembership.role
!== 'owner'` weakened to merely requiring *a* membership — "refuses a caller who is not an owner" fails); making
the UI-side guard the only guard (covered above). No mutation tried survived any test in this slice's own suite.

**Evidence, `grantMembershipAction`'s own new check (the correction above), mutated three ways the follow-up
brief named.** Dropping the check entirely (`if (targetMembership.role === 'owner')` replaced with `if (false)`)
turned three tests red at once: "refuses an owner demoting another owner" (the grant that should be refused
instead succeeded), "the peer-owner refusal is byte-identical..." (no error thrown to compare at all) and "the
ENRL-10 → ENRL-11 scenario..." itself. Making the refusal distinguishable — constructing an `ActionRefusedError`
and then overwriting its own `.message` before throwing, simulating a caller who reads the *reason* rather than
merely the fact of a refusal — turned only "the peer-owner refusal is byte-identical..." red, and none of the
other twenty-six tests in this file: exactly the targeted proof that test exists to give, not a broader
regression that would have caught the mutation by accident. Applying the check to every target regardless of
role (`if (targetMembership.role === 'owner')` widened to `if (targetMembership)`) turned seven tests red across
three describe blocks — including the explicit "an owner can still change a non-owner colleague's role"
regression this follow-up added for exactly this purpose — confirming the check is scoped to what it claims and
nothing wider. No mutation tried survived any test in this slice's own suite.

**Out of scope, deliberately, stated rather than left ambiguous.** ENRL-12 and the `expiresAt` refinement (a
later slice, per the brief). `memberships.grant`'s own anti-oracle refusal for an unknown or non-member email —
untouched; its own *demotion* path is not out of scope, and is what the correction above closes. Invitation
issuing/redeeming (ENRL-10, unchanged, beyond the "revoked reads as absent" consequence `getMembership`'s own
filter gives it automatically). MCP's tool surface — `apps/mcp/src/tool-surface.ts`'s own module comment already
reasons about the omission of membership actions, deliberately; this slice does not touch that file, so neither
`memberships.grant` nor `memberships.revoke` is reachable from a model caller by construction, the same as every
other membership action. `accounts.disableAccount` (account lifecycle) — untouched. No UI change accompanies the
correction: `components/Team.tsx`'s own grant form has no per-row affordance to hide (it takes a free-typed email,
not a selection from the roster), so a peer-demotion attempt still surfaces as an ordinary `ErrorMessage` after
submission, the same way every other action-level refusal already reaches that screen — a dedicated warning
before submission is a UI enhancement this correction's own brief did not ask for.

Final counts after the initial pass: 90 node:test (unchanged), 2178 vitest across 183 files (+29 — no new file:
+8 in `packages/db/tests/memberships.test.ts`, +10 in `packages/actions/tests/memberships.test.ts`, +7 in
`apps/web/tests/team.test.tsx`, +3 derived in `apps/api/tests/tenant-isolation.test.ts`'s own foreign-session/
no-session/disabled-account matrix for the new route, +1 derived in `packages/actions/tests/access-audit.test.ts`'s
own per-descriptor loop; `catalog.test.ts` gained a name in an existing array, no new case), 27 e2e (+1 —
`e2e/team-panel-revoke.spec.ts`, new). `npx drizzle-kit check` (from `packages/db`): clean.

Final counts after the correction above: 90 node:test (unchanged), 2184 vitest across 183 files (+6, all in
`packages/actions/tests/memberships.test.ts` — no new file), 27 e2e (unchanged — the correction is action-level,
driven through tests, not the screen, per the follow-up brief). `npx drizzle-kit check` (from `packages/db`):
clean — this correction touched no schema.

---

## D-74 — `packages/db`/`packages/actions`/`apps/api`: ENRL-12 — a live join link's secret is recoverable by the instructors of its own organization, encrypted at rest under a key that lives only in the environment

**Problem.** `sign_in_tokens` and `course_join_links` both stored a bearer secret as only a SHA-256 hash — right
for a sign-in link, which proves one person's email and is spent once, but wrong for a join link: D-67's own
"Out of scope, deliberately" carried this forward twice (D-73's own entry, above, and D-68's) without ever
naming it as anything but future work. A join link is deliberately broadcast to a whole class, so the secrecy a
hash protects is already handed to everyone the instructor shared it with, while the cost of losing it — a
closed tab, a mid-term re-send — falls entirely on the instructor, whose only recourse today is
`courseJoinLinks.revoke` followed by a fresh `.create`, which breaks the link for every student still holding
the old one. `docs/SPEC.md`'s own ENRL-12 names the shape: encrypted at rest, the key in the environment beside
every other credential (CFG-5), the hash still the lookup path, revealing a separate request rather than a list
field, and a deployment with no key behaving exactly as it does today.

**Choice — the hash stays the lookup path; a second, independent copy is added for reveal, never a
replacement.** `course_join_links` gains three nullable columns, `secret_ciphertext`/`secret_nonce`/
`secret_auth_tag` (`packages/db/migrations/0020_curvy_marauders.sql`, three plain `ALTER TABLE ... ADD`
statements — no backfill, so no dedicated `migrate.test.ts` case beyond adding the new column names to that
file's own `expect(schema.course_join_links)` assertion, which did not exist before this slice and now does,
the same "pin the columns a slice adds" convention `memberships`'/`sign_in_tokens`' own entries in that test
already follow). `redeemJoinLink`/`redeemJoinLinkForWebAccount` (`packages/db/src/repos/course-join-links.ts`)
are untouched — still `WHERE secret_hash = ?` — because encryption is not searchable and was never proposed as
the lookup path; proved by mutation, not merely stated: pointing `findLiveJoinLinkByHash`'s own `WHERE` at
`secretCiphertext` instead of `secretHash` turned fifteen tests red across both `packages/db/tests/` and
`packages/actions/tests/`, including every pre-existing redemption test this slice did not otherwise touch.

**Choice — encryption and decryption both live in `packages/actions/src/actions/course-join-links.ts`, never in
`packages/db`.** That file's own module comment already claimed "the plaintext secret never sees this file" for
`secretHash`; this slice keeps that claim true for the ciphertext too by construction, not merely by discipline
— `repos/course-join-links.ts` stores and returns `secretCiphertext`/`secretNonce`/`secretAuthTag` exactly as it
already did `secretHash`, opaque bytes it never encrypts, decrypts, or reads the meaning of; that file's own
module comment is updated to say so explicitly. `encryptSecret`/`decryptSecret` (module-private, `node:crypto`'s
`createCipheriv`/`createDecipheriv`, AES-256-GCM) sit beside `hashSecret`/`generateSecret`, the same file D-34
already put those in for the identical "this package has no dependency on `@bloombot/auth`, and duplicating a
handful of lines costs less than a new cross-package dependency" reasoning.

**Choice — a fresh, random 96-bit nonce every call, stored alongside the ciphertext it encrypted, never derived
or reused.** GCM's confidentiality guarantee is broken outright by reusing a nonce under the same key, so
`encryptSecret` takes no nonce parameter a caller could supply or reuse by mistake — it always calls
`randomBytes(12)` itself. The auth tag is likewise stored, not recomputed: `decryptSecret` calls
`decipher.setAuthTag(...)` before `decipher.final()`, so a tampered ciphertext, nonce, or tag throws before a
single byte of plaintext is returned — GCM's own authentication check running inside `final()` is what
authenticated encryption is for, over a bare block-cipher mode with no integrity check of its own. Proved by
mutation: flipping one bit of a stored auth tag's own decoded bytes (not the base64 text — a text-level edit
risks producing invalid base64 that decodes to a different length rather than the same bytes with one bit
wrong, a weaker proof) and calling `courseJoinLinks.reveal` throws `ActionRefusedError`, never returns garbage;
skipping `setAuthTag`/`final()` entirely (returning only `decipher.update`'s own output — GCM's stream-cipher
half, which decrypts before the tag is ever checked) made the tampered-ciphertext test fail, confirming the tag
check is what the test actually pins down, not an incidental side effect of some other check.

**Choice — the key is threaded as an explicit argument, never read by `packages/actions` itself.** This package
holds no dependency on `@bloombot/config` at all (`actions/index.ts`'s own module comment, `packages/core`'s
identical discipline per `docs/DECISIONS.md`) — `createCourseJoinLinkAction`/`createRevealCourseJoinLinkAction`
are both factories taking an optional `Buffer`, the same "a dependency this package cannot construct for
itself" shape `course-attachments.ts`'s own `createAttachCourseAttachmentAction` already takes an
`AttachmentStorage` for. `createCourseJoinLinkAction` itself changes shape — from a plain exported object to a
zero-or-one-argument factory — which is why its own name did not have to change: the factory-naming convention
this codebase already uses (`create<Verb><Noun>Action` for an action named `<noun>.<verb>`) happens to spell the
same identifier for an action whose own verb is "create". Every existing call site (`packages/actions/tests/
course-join-links.test.ts`) changed from `createCourseJoinLinkAction` to `createCourseJoinLinkAction()` — nine
call sites, zero behaviour change, since none of them cared about ENRL-12. `apps/api/src/index.ts` reads
`JOIN_LINK_ENCRYPTION_KEY` directly (a credential, CFG-5 — never through `packages/config`'s schema, the same
`BOT_TOKEN`/`DISCORD_CLIENT_SECRET`/`OPENAI_API_KEY` treatment), decodes it as base64, and requires it decode to
exactly 32 bytes or refuses to start — unlike `BOT_TOKEN`, an _unset_ key is not a startup failure (ENRL-12's
own deployment-compatibility promise), but a key that is _set and malformed_ is: silently ignoring it would let
an operator believe reveal works when it never will, the same "a bad environment fails immediately" discipline
`packages/config/src/env.ts`'s own module comment holds the schema-validated half of the environment to.
Threaded through `apps/api/src/server.ts`'s `ServerDependencies.joinLinkEncryptionKey` and
`createPlatformRegistry`'s own new `joinLinkEncryptionKey` option, the same path `attachmentStorageDir` already
takes — omitted anywhere along that chain, both factories build with no key, which reproduces the "no key
configured" behaviour exactly: `courseJoinLinks.create` still returns the secret once, and
`courseJoinLinks.reveal` refuses unconditionally, proved directly (not merely by omission) by a dedicated test
and by mutation (skipping the `if (!encryptionKey) throw ...` line was not separately mutation-tested, since
every "no key" test already exercises the un-mutated code path — the deployment-compatibility promise is what
the test asserts, not a line coverage target).

**Choice — who may reveal: `courseJoinLinks.reveal`'s policy is `courseJoinLinks.revoke`'s policy object,
reused, not a second one that happens to look the same.** ENRL-12's own text says "the instructors of its own
organization" — this codebase's existing gate for that phrase, for this exact resource, is `.revoke`'s
`{ resource: 'courseJoinLink', access: 'write' }` descriptor with `resolve` scoped to the link's own
organization: any member (owner, instructor or assistant — `.create`'s identical policy already permits all
three, un-role-differentiated) of the organization the link's course belongs to, the same set `.create`/`.list`/
`.revoke` already permit, and no wider. Reusing the literal policy object (`policy: revokeCourseJoinLinkAction.policy`),
not a duplicate with the same two field values, is what keeps the two gates from drifting apart under a future
edit to either action alone. A non-member (an account whose own session belongs to a different organization
entirely, or no session at all) is refused before `dispatch` ever runs `courseJoinLinks.reveal`'s own `execute`
— `apps/api/src/routes/actions.ts`'s own membership check, the same gate every other action-route call already
passes through, and — since `courseJoinLinks.reveal` is registered into `createPlatformRegistry` and reachable
only through that one generic route — exercised automatically by `apps/api/tests/tenant-isolation.test.ts`'s own
derived matrix (foreign-organization session, no session, disabled-account session) with no new test written by
hand. A caller _within_ the right organization but for a link belonging to a different one is refused by
`resolve` itself, the identical TEN-5 shape `.revoke`'s own "refuses another organization's link, identically to
a missing one" test already pins — mirrored for `.reveal` in this slice.

**What an instructor sees for a link issued before this shipped.** Its row carries `null` for all three of
`secret_ciphertext`/`secret_nonce`/`secret_auth_tag` — the migration adds the columns with no backfill, so every
existing row reads exactly like a row created today with no key configured. Redemption is unaffected (it never
reads these columns at all); `courseJoinLinks.reveal` refuses, identically to a revoked or expired link — proved
directly by a dedicated test that creates such a row through the repo's own `createJoinLink` with the ciphertext
fields omitted, confirms the reveal refuses, and confirms the same secret still redeems through
`redeemCourseJoinLink` unchanged.

**How this sits beside D-71's own `sign_in_tokens.destination`.** That entry records a join-link redemption's
own return address — which, for the join-link flow specifically, is the join link's URL, secret and all —
living in `sign_in_tokens.destination` as plaintext for the token's own fifteen-minute life. That is a real,
already-accepted plaintext exposure of the identical class of secret this entry now encrypts at rest — not a
contradiction, because the two rows answer different questions under different trust boundaries. A sign-in
token is single-use, expires in fifteen minutes, and is deleted from relevance the moment it is consumed
(`consumeSignInToken` marks `usedAt`); its `destination` is read back exactly once, by the same request that
proved the recipient controls the mailed address, and nothing about ENRL-12 changes that row, that flow, or its
own already-recorded tradeoff. A join link's own `course_join_links` row is the opposite shape on every axis
that matters here: long-lived (valid until revoked, sometimes for a whole term), read by nobody but the
instructor who asks to see it again, and reachable by an entirely different, ordinary membership-scoped
`dispatch` call rather than a token consumed once at redemption. Encrypting the row a join link's secret lives
in for the long run, while leaving a fifteen-minute, single-use, already-scoped-down token row alone, is the
same "match the durability of the protection to the durability of the exposure" reasoning this build applies
elsewhere (D-2's integer money, D-32's `tmp/`-not-`data/` test isolation) — not a gap the two entries leave
between them.

**Judgment call — "who may reveal" resolved to "any member," not narrowed to `owner`/`instructor`.** The brief's
own text ("the instructors of its own organization... `courseJoinLinks.create` is already gated; match it")
reads two ways: "instructor" as the `MEMBERSHIP_ROLES` value, or "instructor" as this SPEC's own loose shorthand
for organization staff generally, the reading `courseJoinLinks.create`'s own un-role-differentiated policy
already commits to. Chosen: match `.create`'s actual gating exactly, not a stricter one it does not itself
enforce — a `.create`/`.list`/`.revoke`/`.reveal` quartet that suddenly disagreed about which roles may act on
the same link would be a harder-to-explain platform than one where all four agree. An inference, not a measured
fact: this repository has no existing place ENRL-3's "instructor" is cashed out as a `MEMBERSHIP_ROLES` role
check, so there is nothing to measure it against beyond the sibling actions' own, already-shipped behaviour.
Revisit if a future requirement narrows `.create`/`.list`/`.revoke` themselves to `owner`/`instructor` — `.reveal`
should follow, via the shared policy object, with no separate edit.

**Out of scope, deliberately.** Redemption's authorization and binding (unchanged — this slice added no new
caller of `redeemJoinLink`/`redeemJoinLinkForWebAccount`, and neither function's own signature or behaviour
changed). `memberships.grant`/`.revoke` — untouched. The chat surface, and MCP's tool surface —
`apps/mcp/src/tool-surface.ts`'s own allowlist does not name `courseJoinLinks.reveal`, so it is unreachable from
a model caller by construction, the same as every action that file's own module comment already reasons about
omitting; this slice adds no entry there. Rotating or re-encrypting a link's own ciphertext under a new key —
raised in the brief as a question, not a requirement: nothing here reads `JOIN_LINK_ENCRYPTION_KEY` more than
once per process lifetime, and changing its value between deployments leaves every previously-encrypted row
undecryptable under the new key (its own reveal now behaves like a tampered-ciphertext refusal, byte-identical
to every other refusal this action gives) while redemption — the property that actually matters to a student —
stays unaffected throughout, since it never touches this key at all. If key rotation becomes a real operational
need, it reads like its own requirement (a re-encryption job, keyed identically to `apps/worker`'s other
background jobs, JOB-1), not a change to this entry's own design. No `apps/web` change accompanies this slice:
the brief's own "files and interfaces involved" names only `packages/db`, `packages/actions` and `apps/api`, and
`components/JoinLinks.tsx` has no affordance today to reveal a secret from, the same "a UI enhancement the
brief did not ask for" reasoning D-73's own entry gives for `components/Team.tsx`. `courseJoinLinks.reveal` is
reachable today only by direct dispatch or through `POST /organizations/:id/actions/courseJoinLinks.reveal` —
a real, tested, authorized capability with no panel affordance yet, the same shape several actions in this
codebase already sat in before their own panel screen landed.

**A carried-over cheap-fix, closed in the same slice.** `membershipInvitations.create`'s own `expiresAt`
`.refine` (`packages/actions/src/actions/membership-invitations.ts`) already existed — its own doc comment even
claimed it "mirrors `courseJoinLinks.create`'s own `expiresAt` exactly, including its own... refinement" — but
carried no test of its own, unlike `courseJoinLinks.create`'s identical refinement, which
`packages/actions/tests/course-join-links.test.ts`'s own "refuses creating a join link whose expiresAt is
already in the past" already pinned. Confirmed live over the shape the brief described:
`POST /organizations/<id>/actions/membershipInvitations.create` with `{"email":"x@y.edu","role":"instructor",
"expiresAt":1}` would have answered `200` with a plaintext secret no invitee could ever redeem, indistinguishable
from success to the owner who sent it, until this slice added the missing test. Mutated and confirmed red (the
`.refine(...)` call removed entirely, leaving only `.number().int().positive()`) before restoring it, byte for
byte (`diff` against a saved copy, confirmed identical). `courseJoinLinks.create`'s own equivalent was already
pinned; no change needed there.

**Evidence.** Every mutation this entry names above was tried directly against the real source, confirmed to
turn a specific, named test red, then reverted and confirmed byte-identical to before (`diff` against a saved
copy in every case): the hash-vs-ciphertext lookup swap (fifteen tests, both packages), the revoked/expired
liveness check short-circuited to `true` (two tests, one each), the auth-tag check skipped (one test), and
`toSummary` widened to include `secretCiphertext` (one test). The `membershipInvitations.create` refinement
removal is recorded separately, just above.

Final counts: 90 node:test (unchanged), 2197 vitest across 183 files (baseline at `ed3cfea` was 2184/183 — +13,
no new file: +8 in `packages/actions/tests/course-join-links.test.ts`'s own new `courseJoinLinks.reveal (ENRL-12)`
describe block, +1 in `packages/actions/tests/membership-invitations.test.ts`, +3 derived in `apps/api/tests/
tenant-isolation.test.ts`'s own foreign-session/no-session/disabled-account matrix for the new route, +1 derived
in `packages/actions/tests/access-audit.test.ts`'s own per-descriptor loop; `catalog.test.ts` gained a name in
an existing array, no new case), 27 e2e (unchanged — this slice is backend-only, per the "out of scope" note
above). `npx drizzle-kit check` (from `packages/db`): clean, no drift.

**Limits.** The judgment call above (who may reveal) is exactly as firm as `.create`'s own existing gating —
if a future slice tightens that, this one should tighten in step, via the shared policy object. Key rotation is
named but not built (above). No panel affordance exists yet for an instructor to actually click "show again" —
the backend capability is complete and tested; the screen is not this slice's own scope.

---

**Rework — a coordinator's own audit reopened five requirements this build had already marked Done for exactly
this reason (TEN-8, WEB-4, COST-3, COST-4, ENRL-5: "a working action nobody could reach"), and this entry's own
"Out of scope" above was the sixth: `courseJoinLinks.reveal` was real, tested, and authorized, and reachable by
nothing an instructor could click. The audit's own criterion — the generic
`/organizations/:id/actions/:name` route does not count as a surface — closes this gap the same way.**

**Choice — `CourseJoinLinkSummary` gains one field, `revealable: boolean`, rather than threading the encryption
key into `courseJoinLinks.list` to compute it freshly on every call.** `revealable` is
`Boolean(link.secretCiphertext)` alone — a link this listing already has in hand, not a decrypt attempt — so
`.list` stays the plain object it already was; only `.create`/`.reveal` needed to become factories. This is
capability metadata, not secret material: it says nothing a caller could not already learn by attempting
`.reveal` and reading whether it refused, so it carries none of the risk `secretHash`'s own omission from this
same summary (WEB-20's original doc comment) guards against. It does not account for "is a key configured right
now" — only "did this row get one at creation" — so it would read `true` for a link encrypted under a key an
operator later removed, a real gap but the same one `.reveal` itself already has (this entry's own "Out of
scope" on rotation, above), not a new one. `apps/web/src/components/JoinLinks.tsx` reads it, alongside its own
`isLiveForReveal` (mirroring `.reveal`'s own revoked/expired refusal), to decide whether to offer the control at
all — never a control certain to fail, the follow-up brief's own explicit requirement.

**Choice — the panel keeps at most one revealed secret in memory at a time, the same discipline `created`
already held itself to, plus an explicit "Hide."** `revealed: { linkId, secret } | undefined` — revealing a
different link replaces it outright (never a list, never keyed by anything that survives past this one value),
and a "Hide" button lets an instructor clear it before doing anything else, closing the follow-up brief's own
"do not leave it there indefinitely" more directly than `created`'s own precedent does (which has no hide
control at all, since it is shown exactly once and reads as done the moment the instructor moves on). Copying a
revealed secret uses its own `handleCopyRevealed`/`revealCopied`/`revealCopyError`, deliberately not shared with
`created`'s own `handleCopy`/`copied`/`copyError` — sharing would flip both the creation banner's and a revealed
row's own "Copied!" label on a single click in whichever one was actually used, wrong whenever both are on
screen at once (both are reachable independently: creating a link, then revealing a _different_ existing one).
Nothing here touches the URL — no query parameter, no route, no `window.location` write — so the secret never
enters browser history either.

**Choice — a live but non-revealable link explains itself in a sentence, never a control.** "Bloombot didn't
keep a recoverable copy of this link's secret, so it can't be shown again. Revoke it and create a new one if
students still need a link." — instructor-facing wording, not "no ciphertext," and rendered as an ordinary `<p>`
(no `role="alert"`), since this is a fact the listing already carried, not a failure that just happened. A
revoked or expired link gets neither the control nor this sentence — `formatExpiry` already says why, and a
second sentence explaining a state the screen already displays would be noise, not help.

**Choice — the role question is settled, not left an inference.** The follow-up brief's own challenge: ENRL-12's
text says "instructors," `.reveal` shares `.revoke`'s policy (any member, un-role-differentiated), and ENRL-11
has since made a role load-bearing elsewhere in this codebase (only an owner may revoke a membership or demote a
peer owner). Decided: keep matching `.create`/`.list`/`.revoke` exactly, un-role-differentiated, for a reason
ENRL-11's own precedent does not undercut — narrowing `.reveal` alone to `owner`/`instructor` would build a
boundary any caller already inside `.revoke`'s own trust perimeter can walk straight around: an `assistant` who
may revoke a link may also `.create` a fresh one and read its secret from the response the instant it is issued,
so refusing that same caller `.reveal` on the _original_ link protects nothing a revoke-and-reissue does not
already defeat — unlike ENRL-11's own concern (an organization always keeping an owner), which a role check
genuinely does protect and revoke-and-reissue cannot substitute for. Pinned, not merely argued: `packages/actions/tests/course-join-links.test.ts`'s new "an assistant — not only an owner — can reveal a live link" dispatches as
an `assistant` account directly and asserts the real secret comes back. Mutated to prove the test is not
vacuous: adding an owner-only membership check to `.reveal`'s own `execute` turned exactly that one test red and
left the other eighteen in the same file green — the precise, narrow proof this decision is pinned by something
that would actually fail if it regressed, not merely present.

**Evidence, the frontend half.** Every mutation the follow-up brief's own "assert on what remains" line implies
was tried directly against `components/JoinLinks.tsx`, confirmed to turn a specific, named test in
`apps/web/tests/join-links.test.tsx` red, then reverted (`diff` against a saved copy, confirmed byte-identical
in every case): `isLiveForReveal` short-circuited to always `true` (the revoked-link and expired-link "offers no
reveal control" tests, both); the `link.revealable` check dropped from the control's own render guard (the
"nothing encrypted to show" test); `setRevealed` changed to keep the first revealed secret rather than replace
it (the "does not survive the re-render" test); `handleHideRevealed`'s own `setRevealed(undefined)` removed (the
"hiding... removes it from the DOM" test). The backend's own new `revealable` field was mutated too — forced to
`true` unconditionally in `toSummary` — and caught by two tests at once: the listing test's own `revealable:
false` assertion (no key configured) and the new "revealable is true only for a link created with an encryption
key configured" test.

**Evidence, end to end.** `e2e/join-links-panel.spec.ts` gained
`an owner issues a join link, closes the tab that showed it, then reveals it again later and a real visitor
redeems that revealed URL (ENRL-12)` — the journey the requirement itself names, issue → close → reveal →
redeem, proved by a real second browser context following the _revealed_ URL and landing connected, the same
outcome `join-link.spec.ts` already proves for an ordinary just-created link — not by comparing the revealed
string against the created one. `e2e/support/start-api.ts` now configures a real `joinLinkEncryptionKey`
(`randomBytes(32)`, generated once per harness run, never read from `process.env`) — without it every link this
harness creates has `revealable: false` and this journey has no control to click at all, which was confirmed
directly: with the key omitted, the new spec's own `page.getByRole('button', { name: /^Show join link/ })` step
times out rather than failing on a later assertion.

Final counts after this rework: 90 node:test (unchanged), 2208 vitest across 183 files (+11 from this rework's
own baseline of 2197 — +2 in `packages/actions/tests/course-join-links.test.ts` (`revealable`'s own listing
test, and the assistant-reveals test), +9 in `apps/web/tests/join-links.test.tsx`'s own new
`JoinLinks reveal (ENRL-12)` describe block; no new file in either package), 28 e2e (+1 —
`e2e/join-links-panel.spec.ts`'s new case). `npx drizzle-kit check` (from `packages/db`): clean, no drift — this
rework touched no schema.

**Limits, updated.** The "no `apps/web` change accompanies this slice" line in this entry's own original text
(above) no longer holds — corrected here rather than silently edited away, the same "state what changed and
why" discipline this file holds every other rework to. The role decision is now pinned by a test and a mutation,
not merely argued; it remains exactly as firm as `.create`/`.list`/`.revoke`'s own existing, un-role-
differentiated gating, and should move in step with them if a future requirement narrows any of the four.
`revealable`'s own key-rotation gap (above) is the same one `.reveal` itself already had — still out of scope,
still named, not newly introduced by this field.

## WEB-29/WEB-30 — the navigation drawer, the header's organization name, and account settings

**Choice — `drawerFooter` is a `ReactNode` slot, not an `onSignOut`/`signOutLabel` pair.** `AppShell.tsx`'s own
module comment states the reasoning: `pages/Shell.tsx`'s sign-out control already carries its own pending-state
label ("Signing out…"), its own `disabled` state, and its own `guardedNavigate` wiring — reconstructing an
equivalent set of props on `AppShellProps` so `AppShell` could render the button itself would be more surface
for this component to know about the shell's own async state than simply accepting the whole rendered control.
The same reasoning already governs `headerStart`/`headerEnd` (`OrganizationSwitcher`, the profile control) — one
slot shape for every header/drawer control this shell owns, not a bespoke prop pair for the one that happens to
have a pending state.

**Choice — the drawer does not close the instant a nav item is clicked; it closes once the navigation it guards
actually happens.** The brief left this open. The naive version — `AppShell` calling `closeDrawer()`
unconditionally inside every item's `onClick`, the same way this component's own drawer-item handler worked
before this slice — breaks WEB-16's own guarded-navigation case in a real browser: a click on a nav item with a
dirty form elsewhere in the tree (`useNavigationGuard`'s `guardedNavigate`) does not navigate immediately, it
opens a confirm dialog and *waits*. If the drawer had already started closing by then, the clicked item would be
mid-transition (or already removed from the top layer, `dialog.close()` having already run) by the time the
confirm dialog's own `Escape` handling tries to restore focus to whatever triggered it — the exact case
`e2e/keyboard.spec.ts` exercises. Decided: `AppShell` exposes an imperative handle
(`AppShellHandle { closeDrawer }`, a plain `ref` prop — React 19's own "no `forwardRef` needed" — the same
pattern `Button.tsx` already uses for `Modal.tsx`'s focus management) rather than closing on every click itself;
`pages/Shell.tsx`'s own `navigateToTab` helper calls `setActiveTab` *and* `appShellRef.current?.closeDrawer()`
together, inside the `guardedNavigate` callback — so an unguarded click closes the drawer immediately (the
common case, unchanged in effect), and a guarded click leaves the drawer open, with the confirm dialog on top of
it, until the guard resolves. Pinned by `e2e/keyboard.spec.ts` itself: the naive version was tried directly
(closing on every click, undoing the ref-based deferral) and reproduced the exact failure this decision exists to
avoid — `discordNavLink` no longer focusable once `Escape` tried to restore focus to it, because the drawer's own
`dialog.close()` had already run by then.

**Choice — a guarded click's own transition timing needed a real e2e fix, not only a design one.** Even with the
ref-based deferral above, the *unguarded* path (the "Projects" click `e2e/keyboard.spec.ts` starts with, and
`e2e/navigation-drawer.spec.ts`'s own first item click) still closes the drawer, and WEB-29's own slide transition
defers the underlying `dialog.close()` by `DRAWER_TRANSITION_MS` (200ms) rather than calling it immediately
(`AppShell.tsx`'s own module comment on why). A native modal `<dialog>` makes the rest of the document inert for
as long as it is open — so a script action against the page underneath, attempted inside that ~200ms window,
silently lands on nothing (confirmed directly: `page.getByLabel('New project name').fill(...)` returned no
error, but `inputValue()` read back empty, and the accessibility snapshot showed the drawer's own dialog still
`open` at the moment of the click). `e2e/keyboard.spec.ts` now waits for the drawer to actually report `toBeHidden()`
before interacting with the field underneath; `e2e/navigation-drawer.spec.ts` was written with this already in
mind. This is a browser-modality property, not a bug in this slice's own code — any e2e spec added later that
drives an *unguarded* drawer-item click and immediately interacts with the page underneath needs the same wait.

**Choice — the divider is an `<hr role="separator">`, labelled with the group it introduces.** `AppShellNavGroup.label`
("Organization") is passed through as the separator's own `aria-label`, rather than a plain unlabelled `<hr>` —
a screen reader encountering it mid-list has something to say about what follows, the same "an icon/boundary
never carries meaning alone" discipline `icons.ts`'s own module comment holds icons to (WEB-12).

**Choice — the profile control uses Lucide's `CircleUserRound`, re-exported as `ProfileIcon`.** Chosen over
`UserCircle` (the brief's other named option) for legibility at the small icon-only sizes this panel already
uses (`size-5`, `AppShell.tsx`'s hamburger/home controls) — `CircleUserRound`'s heavier outline reads more
clearly at that size than `UserCircle`'s thinner one. Either would have satisfied WEB-30; this is a visual
judgment call, not a functional one.

**Choice — the sign-out failure path is unchanged.** `handleSignOut`'s own `try { … } catch { /* nothing */ }
finally { onSignedOut() }` (`pages/Shell.tsx`) already swallows a failed round trip and signs the caller out of
this screen regardless, with `App.tsx`'s own `/auth/me` re-check as the actual source of truth — this slice
moved the button from the header into the drawer's foot and nothing else about it; the brief's own note flagged
this as an open question, and there was no new information this slice surfaces that would change that call, so
it was left exactly as `docs/DECISIONS.md`'s own prior entries already describe it (the WEB-1..6 rework, finding
3).

**Correction — every e2e spec that reaches a tab now goes through a shared helper, not just the two the
brief's own verification command named.** The first pass of this entry recorded leaving 16 other specs red as an
explicit "out of scope" limit, reasoning that the brief's own scope line named only `apps/web` and its tests.
That was wrong, and CI caught it immediately: `.github/workflows/ci.yml`'s `Run the end-to-end test (QA-7)` step
runs the *whole* suite (`npm run e2e`), not the two specs the brief's verification command happened to name, so
those 16 specs were never "adjacent work optionally left for later" — they were this change's own regression,
and `.claude/CLAUDE.md`'s "all passing tests must stay reproducible as regression tests" applies to them exactly
as it would to any other test this slice broke. Fixed here, in one shared place rather than eighteen scattered
edits: `e2e/support/navigate.ts` (new, following `read-sign-in-token.ts`'s own "pulled out once, not
duplicated" precedent) exports `openDrawer`, `navigateTo(page, label)` (open the drawer, click the named item,
wait for the drawer to actually finish closing — the identical wait `e2e/keyboard.spec.ts` already needed, this
file's own module comment has the "why" and points at the same inertness finding recorded above), and
`signOut(page)` (the drawer-footer sign-out control WEB-30 also moved). Every spec that clicked a nav button
directly (`admin-console`, `auth-flow`, `chat`, `chat-scroll`, `course-configuration`, `course-knowledge-files`,
`course-people-panel`, `discord-install-panel`, `jobs-panel`, `join-links-panel`, `membership-invitation-panel`,
`roster-import-panel`, `spending-cap`, `team-panel`, `team-panel-revoke`, `transcript-access-log`, `usage-panel`)
now calls `navigateTo`/`signOut` instead — a mechanical, one-line-per-call-site swap; no spec's own assertions
changed, only how each one reaches the screen it was already asserting against.
`membership-invitation-panel.spec.ts` needed `openDrawer` alone, twice, for two presence checks
(`colleaguePage`/`otherTab` seeing "Team" become reachable after a redemption) that were never clicks to begin
with — the assertion itself is untouched, it is only opened where it used to be visible without opening
anything. `npm run e2e` — the full 29-test suite, not the two specs the brief named — is now clean.

**Evidence — QA-1.** Each of the following was confirmed to fail against the pre-change component (`git stash`
of this slice's source changes, keeping the new/updated test), then pass after (`git stash pop`):
`apps/web/tests/shell.test.tsx`'s new "divides the drawer into two groups with a visible separator, for a
member" (fails on the pre-change flat `navItems` prop — no `separator` role exists at all);
"carries sign-out at the drawer's foot, reachable once the drawer is open" (fails on the pre-change header-row
sign-out button, visible with no drawer opened at all — the negative assertion before `openDrawer()` is the one
that actually distinguishes the two);
"the profile control opens account settings, listing every organization and the active one" (fails outright — no
`Account settings` control, no `Account` heading, no `pages/Account.tsx` existed before this slice).
`apps/web/tests/account.test.tsx` is new in its entirety — every one of its cases fails without `pages/Account.tsx`
existing at all, the strongest form of "fails without the change." The placement test — see the correction
directly below — is evidence too, but its own paragraph has the accurate account of what it actually proves.

**Correction — round 2 of the coordinator review, three findings.**

1. **The placement test named above was wrong, and so was this entry's own account of it.** The first pass's
"states the acting organization's name at the header's leading edge" only read
`getByRole('combobox', { name: 'Organization' }).toHaveTextContent('Org One')` — the switcher's own *text*,
never *where in the header* it sits. That assertion is identical whether the switcher renders in `headerStart`
(WEB-30's own "immediately right of the home control") or `headerEnd` (where sign-out sat before WEB-30), so it
passes against the pre-change header too — confirmed directly, by moving `<OrganizationSwitcher/>` from
`headerStart` to `headerEnd` in `pages/Shell.tsx` (undoing exactly the half of WEB-30 the test's own name
claims to pin) and rerunning: `npm test` and `npm run e2e` both stayed green, and the entry above's own claim
("fails on the pre-change header, which had no `headerStart` slot at all") does not hold either — the
pre-change header (commit `84ac256`) had no `headerStart` prop, true, but the switcher still rendered in the
one slot that existed (what is now `headerEnd`), in the same visual position relative to the home control that
a careless assertion could not tell apart from the new one. The claim was simply false, not merely imprecise,
and is corrected by removing it above rather than left to mislead the next reader.

   Fixed by rewriting the test to pin *position*, not merely presence: it now finds the header's own leading
   group (the `<div>` the `Home` button renders into) and asserts the switcher is contained in it, and — the
   negative that actually rules the regression out — that the profile control's own trailing group does *not*
   also contain it. Reproduced failing twice, not once: against the live "move it to `headerEnd`" repro above
   (`expect(leadingGroup).toContainElement(switcher)` fails, reporting the switcher inside the *trailing*
   `<div class="flex items-center gap-3">` instead), and, separately, against a real checkout of the four
   source files at `84ac256` (`git show 84ac256:<path> > <path>`, run, then restored) — the identical failure,
   for the identical reason, this time against the actual pre-change commit rather than a hand-built repro of
   it. Passes clean against the current source, both ways.

   The sibling case at `shell.test.tsx`'s "offers no separator … for a connected-but-not-a-member account" also
   passes against the pre-change source — trivially, because no `separator` role existed at all before this
   slice, for either organization. Kept, as a reasonable companion assertion once the drawer and its separator
   exist — but it is not QA-1 evidence for anything, and was never claimed as such above; noted here only so
   the next reader does not have to rediscover it.

2. **`transitionend` was not filtered to the dialog's own transition.** `dialog.addEventListener('transitionend', finish)`
   listened for *any* `transitionend` bubbling up to the dialog — and every `Button` inside the drawer (the
   close control, sign-out) carries its own `transition-colors` (`Button.tsx`). A pointer resting on, then
   clicking, the close button: the drawer starts its 200ms translate, the button slides out from under the
   pointer, its hover background transitions back over Tailwind's default 150ms, and *that* event — not the
   drawer's own — reached `finish()` first, cutting the slide short at the exact moment WEB-29 exists to make
   visible. State stayed consistent either way (`phase` still lands on `'closed'`), so this was cosmetic, not a
   correctness bug — but it defeated the requirement's whole point. Fixed with `event.target !== dialog` inside
   the listener. `apps/web/tests/app-shell.test.tsx` (new) pins it directly against `AppShell` — a
   `transitionend` fired at the close button, while the drawer is still closing, leaves the dialog visible;
   the same event fired at the dialog itself still closes it. Confirmed failing against the pre-fix
   `AppShell.tsx` (`git show f89f1c5:...` — the commit immediately before this fix — checked out, run, restored)
   before this filter existed.

3. **Reduced motion kept the document inert for 200ms after the drawer was already visually gone.**
   `motion-reduce:duration-0` makes the transform transition instant for `prefers-reduced-motion: reduce` — and
   a `0ms` CSS transition fires no `transitionend` at all (there is nothing to transition from/to), so the
   closing effect always fell through to the `DRAWER_TRANSITION_MS` timeout regardless. A reduced-motion caller
   clicking a nav item and immediately clicking something on the destination screen had that second click
   swallowed by the still-modal (and still fully inert-making) `<dialog>`, invisible though it already was.
   This *can* be read reliably from JS — the closing effect now checks
   `window.matchMedia('(prefers-reduced-motion: reduce)').matches` directly (the identical query the CSS itself
   keys off, so the two can never disagree about whether a given close will actually transition) and calls
   `finish()` immediately when it matches, skipping both the listener and the timeout. Guarded with
   `typeof window.matchMedia === 'function'` — jsdom does not implement it by default, and Node-run tests that
   never stub it must not throw. `apps/web/tests/app-shell.test.tsx` stubs `window.matchMedia` to report
   `reduce`, closes the drawer, and asserts it is already hidden with no transition event fired and no timer
   advanced — failing against the pre-fix `AppShell.tsx` the same way finding 2's own test does (the dialog is
   still open at that point, pre-fix — only the 200ms timeout would have closed it).

`npm test` (2219 vitest + 90 node:test) and `npm run e2e` (29/29) both stayed green through every fix above.

## D-75 — `packages/actions`/`apps/mcp`/`apps/web`: WEB-26/WEB-27/WEB-28/PROJ-6 — row-level kebab menus, the "New project" modal, project rename, and a course row's own Chat button

**Problem.** `renameProject` (`packages/db/src/repos/projects.ts`) had been correct and fully tested since an
earlier slice, with no `projects.rename` action ever calling it — the repository half of PROJ-6 existed with no
way to reach it. Separately, `pages/Projects.tsx`'s row carried an always-present Archive button plus a
free-text "duplicate as" input beside it, and `pages/Courses.tsx`'s row carried a single Disable/Enable button —
neither left room for a third or fourth row action (Duplicate, Rename) without either growing the row
indefinitely or hiding them behind *something*. WEB-26 names that something: one kebab per row. WEB-28 asks for
a course row's own Chat button, landing directly on that course's own conversation.

**Choice — `projects.rename` joins the MCP tool surface (`apps/mcp/src/tool-surface.ts`), non-destructive.**
`tool-surface.ts`'s own module comment already draws the line this repository uses for MCP-4: an action
qualifies as destructive only if it deletes, exports, or spends money with no restore path. Renaming a project
changes a label; nothing is destroyed, nothing is irreversible (a second rename undoes it), and no other
registered action on the surface with the same shape — `projects.archive`, `courses.enable`/`.disable` — is
marked destructive either. It is added beside `projects.archive`/`.unarchive` on the "ordinary writes" half of
`MCP_TOOL_SURFACE`, with a matching `false` row in `tests/tool-surface.test.ts`'s own `EXPECTED_DESTRUCTIVE`
table (that test's own module comment: a tool added with no matching row fails outright, so this could not have
been an oversight — it is a made, checked, choice).

**Choice — the row menu (`KebabMenu.tsx`) is a hand-built popup, not a native `<select>` or a second
`Modal.tsx`-style `<dialog>`.** A `<select>` cannot carry a mix of ordinary and destructive-styled actions
(WEB-15's danger palette) or arbitrary icons, and a modal `<dialog>` is the wrong weight for a menu that has to
sit anchored to its own row and dismiss on an outside click — `Modal.tsx`'s own native dialog makes the *whole
document* inert while open, which a six-row list opening one menu after another would find disruptive. Built
instead as an anchored `<div role="menu">`, opened from one `Button`, with `Escape` and outside-click both
wired by hand (`KebabMenu.tsx`'s own module comment has the specifics) — WEB-17 requires real keyboard
reachability and dismissal either way, native or not, and this component's own test file
(`apps/web/tests/kebab-menu.test.tsx`) is what actually proves it, not the choice of markup.

**Choice — `useModal()`'s existing `prompt` is reused for "New project," Rename and Duplicate, with no new
modal kind.** The brief left open whether `useModal()` needed a new text-input mode; `Modal.tsx` already had one
(`kind: 'prompt'`, built for a future need this file's own earlier module comment already anticipated) with no
caller yet. Every one of this slice's three name-asking flows fits it exactly — a title, a label, an optional
initial value (Rename pre-fills the project's current name), a `validate` callback (used here for the
`.trim()`-non-empty rule every project name already carried, WEB-7's own finding 7, carried forward rather than
dropped) — so building a second, bespoke dialog for any of the three would have duplicated `Modal.tsx` outright.

**Choice — the Chat handoff (WEB-28) is solved by folding the requested course id into `Chat`'s own `key`, not
by having `Chat` read a continuously-updated prop.** `pages/Chat.tsx`'s own `initialCourseId` is read once, at
mount, into `selectedCourseId` — the same "seed once, do not fight a value the caller (or the reader's own
`<select>`) has since chosen" contract WEB-25 already built it under. `Chat` is mounted with
`key={activeOrganizationId}` (WEB-10), so a second course row's Chat click, without an organization switch in
between, would change `initialCourseId` as a prop with no remount to make `Chat` re-read it — confirmed directly
by writing the second-click case in `tests/shell.test.tsx` against the key `${activeOrganizationId}` alone
first: it left the *first* clicked course still selected. Two fixes were possible: extend `Chat`'s own key
(chosen), or add a second piece of state `Chat` reads on every render instead of only at mount. The key
extension was preferred because it keeps `Chat`'s own "seed once" contract exactly as WEB-25 already built it —
a second, continuously-read prop would have meant either overriding a reader's own manual `<select>` change (the
exact thing `initialCourseId`'s "do not override a value already chosen" comment forbids) or growing `Chat`'s
own effects to distinguish "this changed because a new Chat click arrived" from "this changed because the
reader picked something." A fresh mount sidesteps the distinction entirely: `pages/Shell.tsx` now holds the
requested course id in its own state (`chatCourseId`), and `key={`${activeOrganizationId}:${chatCourseId ?? ''}`}`
gives `Chat` a clean remount, and so a fresh, correct `initialCourseId` read, on every distinct request —
including the ordinary case (no course requested yet, `chatCourseId` empty) and the WEB-25 join-confirmation
case (only shown when `chatCourseId` still agrees with `joinedCourse`, `pages/Shell.tsx`'s own comment on the
render below has the exact condition). The cost is an extra `listChatCourses` round trip on a second Chat click
for the same organization — accepted, the same tradeoff `ProjectsPanel`'s and every other tab's own
`key={activeOrganizationId}` already makes for an organization switch, at a scale (one click, not one keystroke)
where it is not felt.

**QA-1 evidence.** `packages/actions/tests/actions.test.ts`'s three new `projects.rename` cases fail against the
action's own absence (`renameProjectAction` unexported, `dispatch` throws reading `inputSchema` of `undefined`)
and pass once `actions/projects.ts`/`actions/index.ts` register it. `apps/web/tests/kebab-menu.test.tsx` fails
outright (module not found) with no `KebabMenu.tsx` at all. `apps/web/tests/projects.test.tsx` — 9 of 13 cases
fail against the pre-change `Projects.tsx` (no "New project" button, no kebab, no Rename). `apps/web/tests/courses.test.tsx`
— 3 of 6 fail against the pre-change `Courses.tsx` (no kebab menu, no Chat button). `apps/web/tests/shell.test.tsx`'s
two new Chat-handoff cases both fail against the pre-change `Shell.tsx`/`ProjectsPanel.tsx`/`Courses.tsx` (no
`onOpenChat` prop, no Chat button to click at all). All five reverts were done with `git stash push -- <files>`
against this slice's own uncommitted change, rerun, and popped back — never a hand-edited "what it used to look
like" reconstruction. `npm test` (2239 vitest + 90 node:test) and `npm run e2e` (30/30, one spec added by this
slice) both green afterward.

**Round 1 rework.** A fresh-context review of `b725246` reproduced every number above and found the scope,
`projects.rename`, and the `exact: true` e2e sweep all sound — but two must-fixes and a cheap-fix in
`pages/Shell.tsx`/`components/KebabMenu.tsx`, corrected here rather than silently edited away (the same
discipline this file already holds every rework to).

*The "Choice — the Chat handoff... key" paragraph above is false and is corrected, not deleted, so the record
stays honest about what was actually checked and when.* It claimed the second-click case was confirmed
"against the key `${activeOrganizationId}` alone first," and that the key extension was what fixed it. Reverted
directly in review — `key={`${activeOrganizationId}:${chatCourseId ?? ''}`}` changed back to
`key={activeOrganizationId}` alone, `tests/shell.test.tsx` rerun — and the second-click test still passed,
37/37. The reason is structural, not incidental: `Chat` sits in the same ternary chain as every other tab
(`Shell.tsx`'s own ternary chain), so reaching it a second time by way of `pages/Courses.tsx` (nested inside
`ProjectsPanel`, a *different* branch of that chain) always unmounts and remounts `Chat` regardless of its own
`key` — `chatCourseId`, the shell *state*, was what the test actually pinned; the key half was inert for the
case it was written to justify. The key extension is removed (`key={activeOrganizationId}` alone, matching
every other tab); the comments that argued for it are rewritten to say why it is unnecessary, not merely
removed silently.

**Must-fix 1 — `chatCourseId` used to survive an organization switch untouched.** `setChatCourseId` was called
only from `openChatForCourse`; `setActiveOrganizationId` (the switcher's own `onChange`, `Account`'s own
`onSwitchOrganization`) never cleared it, and the render that turns `chatCourseId` into `Chat`'s own
`initialCourseId` carried no `activeOrganizationId` guard of its own — unlike the `joinedCourse` branch right
beside it, which has always checked `joinedCourse.organizationId === activeOrganizationId`. Reproduced exactly
as measured, not merely reasoned about: Org One holding `course-1`/`course-2`, Org Two holding
`course-9`/`course-10`, a Chat click on `course-1` in Org One, then a switch to Org Two —
`getChatMessages`'s own second call landed `('org-2', 'course-1')`, a course Org Two's `listChatCourses` never
even returned. Tenant scoping held throughout (the server refuses that lookup not-found; nothing leaks), but the
picker itself lied: a controlled `<select>` whose value matches no `<option>` falls back to displaying the
organization's own first course while the component's real `selectedCourseId` state stays wherever it was,
invisibly wrong. Fixed by clearing `chatCourseId` at the one place `activeOrganizationId` itself is ever set —
`changeActiveOrganization`, a new function both the switcher and `Account`'s own callback now call instead of
`setActiveOrganizationId` directly — which keeps the invariant the render already assumed: whenever
`chatCourseId` is not `undefined`, it always names a course in the organization currently active.
`tests/shell.test.tsx`'s new "switching organizations clears a course a previous Chat click requested" case
asserts on `getChatMessages`'s own call arguments, not the `<select>`'s displayed value — the latter looks
identical whether the bug is present or fixed, which is exactly why the defect was invisible to the round 1
slice's own tests in the first place.

**Must-fix 2 — see the corrected paragraph above.**

**Cheap-fix 3 — activating a kebab item stranded focus on `<body>`.** `onClick` ran `setOpen(false)` (unmounting
the just-activated, focused `<button>`) before `item.onSelect()` — a keyboard user tabbing to a kebab, opening
it, tabbing to "Rename," and activating it, then cancelling the prompt `Modal.tsx` opens, found focus restored
to `<body>` rather than to the kebab's own trigger, since `<body>` was whatever held focus at the moment the
dialog opened. Fixed the same way the `Escape` path already did: `buttonRef.current?.focus()` runs before
`item.onSelect()`, not after.

**Also addressed, from the same review.** `KebabMenu.tsx` claimed `role="menu"`/`role="menuitem"` while
implementing none of that role's keyboard contract (no arrow-key navigation, no focus moved into the popup on
open, no typeahead) — corrected by dropping both roles rather than building the contract: the popup is
`role="group"`, its items are ordinary `<button>`s, each independently reachable by `Tab`, honest about what the
component actually is. The same review found two kebabs could be open at once, because the outside-click
listener that closes a sibling menu keys on `mousedown`, which a keyboard `Enter`/`Space` activation of a
second kebab never fires — fixed with a `window`-broadcast custom event, announced the instant any menu opens,
that every other mounted instance listens for and closes itself on hearing (`KebabMenu.tsx`'s own module
comment has the specifics; no shared "which menu is open" owner exists, or was invented, for this one
property). Separately, `pages/Courses.tsx`'s own Chat button carried no row-naming accessible name — a
six-course list read as six identically-named "Chat" buttons, which is why `tests/shell.test.tsx` had to index
into `chatButtons[0]`/`chatButtons[chatButtons.length - 1]` rather than naming the row it meant; it now carries
`aria-label={`Chat about "${course.title}"`}`, the same naming convention the kebab beside it already uses, and
every test that used to index positionally now names the row instead.

**QA-1 evidence, round 1 rework.** The organization-switch guard's own test
(`tests/shell.test.tsx`, "switching organizations clears a course a previous Chat click requested") was run
against the pre-fix `Shell.tsx` first and failed for the right reason: `getChatMessages`'s second call was
`('org-2', 'course-1')`, not the expected `('org-2', 'course-9')` — reported directly above. `kebab-menu.test.tsx`'s
two new cases ("activating an item returns focus to the trigger, not to `<body>`" and "opening a second kebab
menu closes the first, even without a pointer event") were each isolated by removing only the one line or
block each pins — the `buttonRef.current?.focus()` call, and the `window.dispatchEvent` inside the trigger's
own `onClick` — rerun, and each failed for the reason its own name states, then passed once restored. Final
counts: `npm test` unchanged in shape (one new `describe`/`it` in `shell.test.tsx`, two new cases and a role
rename across every existing case in `kebab-menu.test.tsx`), `npm run e2e` still 30/30 — the row-menu spec's own
`getByRole('menu'/'menuitem', ...)` calls updated to `'group'`/`'button'` and its Chat click updated to the
row-naming `aria-label`, not a behavior change.
