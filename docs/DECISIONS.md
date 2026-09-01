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
