# Bloombot — Specification

Bloombot is an AI course assistant for university courses run on Discord. It has three
parts: a Discord bot that answers student questions using a course-specific OpenAI
prompt, a set of instructor automation scripts that build and maintain the Discord
server (categories, channels, roles, per-student private channels), and an analytics
notebook over the logged conversation history.

This document specifies current, implemented functionality. Requirement ids are stable
and key the GitHub issues generated from this file — never renumber or rename one.

Families used below: `CFG` configuration, `DSC` Discord client library, `SRV` server
scaffolding, `ROST` roster ingestion and student channels, `BOT` chatbot behavior,
`AI` OpenAI integration, `DATA` persistence, `CLI` command-line administration,
`ANLY` analytics, `OPS` operations and deployment, `BOARD` spec and board tooling.

### 1. Configuration

#### CFG-1 Single YAML course configuration

All course-specific behavior is driven by `bot_config.yml`, read at startup by the bot
and by every management script. The file declares one Discord server (`server.name`)
and a list of `server.courses`. Every course entry carries a human-readable `title`, a
short `file_prefix` used to locate its roster and questionnaire CSV files, an
`openai_assistant` block, a `roles` block, and a `categories` list. Nothing about a
course is hard-coded in Python: adding a course means adding a YAML entry, and a course
is deactivated by commenting its entry out.

#### CFG-2 Per-course OpenAI settings

Each course's `openai_assistant` block specifies the OpenAI resources that answer its
students' questions: a display `name`, a stored `prompt_id` (Responses API prompt), a
`vector_store_id` holding the uploaded course notes, syllabus and schedule, free-form
`instructions` describing the assistant's persona, a `tools` list, a `model`, and a
`limits.max_requests_per_day` cap applied per user. A legacy Assistants API `id` field
may still be present but is not used by the running bot.

#### CFG-3 Per-course roles

Each course declares two Discord role names under `roles`: `admins` (instructors and
course assistants) and `students`. Role names are semester-scoped by convention, e.g.
`admins-wd-su26` and `students-wd-su26`, so that a new semester's roles can be created
without disturbing the previous one. These names are the only link between the config
and the server's permission model; scripts resolve them to Discord role ids at runtime.

#### CFG-4 Per-course category and channel declarations

A course's `categories` list declares the Discord categories that belong to it. An
entry may be a plain string (the category name) or a mapping with a `name` and an
optional `channels` list. Each channel entry has a `name` and an optional
`admins_only: true` flag. Categories declared as plain strings receive a placeholder
channel instead of named channels. A course typically declares one `… - GLOBAL`
category holding shared channels and several numbered `… - STUDENTS NN` categories that
hold per-student private channels, since Discord caps a category at 50 channels.

#### CFG-5 Environment variables and secrets

Credentials live only in a `.env` file loaded by `python-dotenv` in every entry point,
never in the YAML config or in source. `env.example` documents the required variables:
`BOT_APP_ID`, `BOT_PUBLIC_KEY`, `BOT_TOKEN`, `BOT_PERMISSIONS` and `OPENAI_API_KEY`.
Three optional variables tune runtime behavior: `LOGS_DIR` (default `./logs`),
`LOG_LEVEL` (default `INFO`) and `SQL_LITE_DB_PATH` (default `./data/data.db`). The bot
token must belong to a Discord application with at least `MANAGE_CHANNELS` permission
and with the Server Members and Message Content privileged intents enabled.

### 2. Discord Client Library

#### DSC-1 DiscordManager client

`DiscordManager` (in `discord_manager.py`) subclasses `discord.Client` and is the single
Discord abstraction used by every script in the project. It requests the default intents
plus `guilds`, `members` and `message_content`, the last two of which are privileged and
must be enabled in the Discord Developer Portal. Its constructor takes a declarative
description of the work to do — which server, category, channel, user or role to act on,
and which of show/create/delete to perform — and its `on_ready` handler executes that
work in a fixed order once the connection is cached and ready.

#### DSC-2 Name-or-id resolution

Every lookup accepts either a numeric Discord id or a human-readable name, so scripts
and CLI users can refer to servers, categories, channels, users and roles by the names
they see in the Discord UI. `get_server_id`, `get_category_id`, `get_channel_id`,
`get_user_id` and `get_role_id` each perform this resolution and return `None` when no
match exists; `get_user_id` optionally matches display names as well as usernames, which
is what makes roster-supplied Discord handles usable. `fix_ids()` normalizes all
constructor arguments from names to ids before any action runs.

#### DSC-3 Create and delete operations

The client can create a category, create a channel (optionally inside a category), and
delete either. `add_category` is a no-op when a category of that name already exists
unless duplicates are explicitly requested, so scripts built on it are safe to re-run.
`remove_category` deletes the category's child channels before the category itself.

#### DSC-4 Membership and permission operations

The client can grant a user access to a category or to an individual channel by writing
a permission overwrite, and can assign a Discord role to a user.
`DiscordManager.create_permissions` builds an overwrite from the four flags the project
uses — `view_channel`, `read_messages`, `send_messages` and `manage_messages`.

#### DSC-5 Inspection output

`print_guilds`, `print_categories`, `print_channels` and `print_users` render the
server's structure to standard output, scoped by an optional category or channel. These
are what back the CLI's `--show-*` flags and are the primary way an instructor inspects
a server without opening the Discord UI.

#### DSC-6 One-shot and long-running modes

The `event_loop` constructor flag selects between the two ways the project uses Discord.
With `event_loop=False` the client performs its constructor-described actions on
`on_ready` and then closes the connection cleanly, which is how the CLI and the
management scripts behave. With `event_loop=True` the client stays connected and keeps
dispatching events, which is how the chatbot runs. Scripts in the long-running mode call
`client.stop()` themselves once their work is finished.

#### DSC-7 Server lookup by numeric id

`get_server_id` must return the server whose id actually equals the id it was given, and
`None` when no server matches. Its integer branch currently short-circuits before the id
comparison — operator precedence groups the condition as "is an int, OR (is a numeric
string AND the ids match)" — so passing an integer id returns whichever server happens to
be first in the bot's guild list. Every other lookup in the class (`get_category_id` and
its siblings) groups the same condition correctly and is the model to follow. The defect
is latent today because every caller in the project passes a server name, but it makes
the id form of `--server` silently wrong.

### 3. Server Scaffolding

#### SRV-1 Whole-server hydration from config

`hydrate_server.py` builds the entire category and channel structure for every course in
`bot_config.yml` in a single run. For each course it walks the declared categories, and
for each category it creates the category, applies the course's role permissions, and
then creates that category's channels. It is the first script an instructor runs against
a fresh server, before any students are added.

#### SRV-2 Category permissions from course roles

Every category created by hydration is made private by default: `@everyone` is denied
`read_messages`, and the course's admins and students roles are each granted
`read_messages` and `send_messages`. Because Discord channels inherit their category's
overwrites, this single permission write governs everything created beneath it. A role
named in the config but absent from the server is skipped rather than treated as fatal.

#### SRV-3 Named channels with admin-only overrides

When a category declares a `channels` list, each named channel is created inside it after
the category permissions are in place, so the channel inherits them. A channel marked
`admins_only: true` instead receives its own overwrite denying `@everyone` and granting
only the course's admins role, which is how private instructor channels such as `admins`
are produced alongside student-visible channels such as `general`, `grading`, `tutoring`,
`quizzes` and `exams`.

#### SRV-4 Placeholder channel for bare categories

A category declared as a plain string, with no channels of its own, receives a single
placeholder channel named `temp`. Discord hides a category that contains no channels, so
the placeholder is what makes the category visible and available to receive per-student
channels later. The placeholder's permissions are explicitly synced with its category,
and a one-time notice is posted in it when it is first created.

#### SRV-5 Idempotent re-runs

Hydration is safe to re-run after the config changes. Categories and channels that
already exist are not recreated; their permissions are recomputed and reapplied so that
config edits — a new admin-only channel, a renamed role, a new semester's roles — take
effect on the existing server. When permissions are updated on a pre-existing channel a
short notice is posted to that channel so members can see why access changed.

### 4. Roster Ingestion & Student Channels

#### ROST-1 Roster and questionnaire inputs

Two CSV inputs describe a course's students. A roster exported from the university's
registration system lands in `rosters/PREFIX-roster.csv` and carries the authoritative
names and email addresses. An intake questionnaire exported from a survey tool lands in
`questionnaires/PREFIX-intake.csv` and carries the students' self-reported Discord and
GitHub usernames along with background questions. The `PREFIX` matches the course's
`file_prefix` in the config.

#### ROST-2 Roster merge

`roster_setup.ipynb` joins the roster with the questionnaire on email address and writes
a merged file to `results/PREFIX-result.csv` with five normalized columns: `Last`,
`First`, `Email`, `GitHub` and `Discord`. The notebook normalizes the questionnaire's
verbose column headings to those short names, drops rows without an email address, and
skips the leading non-data rows the registration export includes. Sample inputs and
outputs under the `xx` prefix are committed as a worked example.

#### ROST-3 Per-student private channels

`roster_create_channels.py` reads a merged results CSV and creates one private channel
per student inside a configured students category. A channel is named after the local
part of the student's email address, giving a stable, recognizable name that does not
depend on the student's Discord handle. The script is run once per students category,
after hydration has created the categories.

#### ROST-4 Row-range batching around Discord's category limit

Discord permits at most 50 channels in a category, so a course with more students needs
several numbered students categories. The script exposes `ROSTER_START_ROW` and
`ROSTER_END_ROW` bounds alongside the target category name; the instructor runs it once
per 50-student block, pointing each run at the next category.

#### ROST-5 Student channel permissions

Each student channel denies `@everyone`, grants the individual student `read_messages`
and `send_messages`, and grants the course's admins role the same, producing a private
space between one student and the course staff. The student's Discord member is resolved
from the roster's `Discord` column, matching display names as well as usernames. If the
member cannot be found, the channel is still created with admin access and the missing
student permission is reported rather than aborting the run.

#### ROST-6 Pinned welcome message and bad-handle reporting

On first creation, each student channel receives a pinned welcome message stating that
the channel is for conversation between the student and the course admins, followed by
the student's first name, last name, email, Discord handle and GitHub handle. When the
Discord handle from the intake questionnaire could not be resolved to a server member,
the message instead says so explicitly, so staff can correct the handle by hand. Re-runs
update permissions on existing channels without re-posting the welcome message.

#### ROST-7 Roster path resolved from the results directory

`roster_create_channels.py` must read its merged roster from the `results/` directory,
the same location `roster_setup.ipynb` writes to and `hydrate_server.py` reads from. It
currently builds the bare filename without the directory, so the path resolves against
the repository root and the script fails to find a roster that is present.

#### ROST-8 Welcome message mentions the student

The pinned welcome message in a per-student channel must mention the student so they are
notified when the channel appears. It currently interpolates the member's *username* into
Discord's *role*-mention syntax, which Discord cannot resolve, so the mention renders as
literal text and the student is never pinged. A user mention takes the member's numeric
id, and the admins-role mention alongside it is already correct and shows the right form.

### 5. AI Chatbot

#### BOT-1 Mention-gated responses

`response_bot.py` connects to Discord and stays running. It replies only when the bot is
directly mentioned in a message or when a message replies to it; every other message in
every channel is ignored. Messages authored by the bot itself are ignored, which prevents
self-triggered loops. This keeps the bot usable in busy shared channels without it
answering conversations between students.

#### BOT-2 Course routing by category

Each incoming mention is attributed to exactly one course before it is answered. The
primary signal is the Discord category containing the message's channel: if that category
name appears in a course's configured `categories` list, the message belongs to that
course. Course attribution determines which OpenAI prompt, vector store, model and rate
limit apply, so a student asking in the Web Design categories gets Web Design course
material and never another course's.

#### BOT-3 Course routing fallback by role

When a message's category matches no course — for example in a direct message or an
uncategorized channel — the bot falls back to the author's Discord roles, matching them
against each course's configured student and admin role names. The first course whose
role the author holds wins.

#### BOT-4 Unattributable messages are ignored

A mention that cannot be attributed to any course by either signal is logged and
discarded with no reply. The bot therefore stays silent outside the course spaces it has
been configured for, rather than answering with generic model knowledge.

#### BOT-5 Per-user daily request limits

Each course sets `limits.max_requests_per_day`, defaulting to 10, and the bot counts
requests per user per calendar day. On the request that reaches the limit the answer is
still given but is prefixed with a notice telling the student they have reached the
day's maximum and should see the course admins for help. Requests beyond the limit are
silently ignored. The counter resets when the date changes, and is held in memory, so it
restarts at zero when the process restarts.

#### BOT-6 Bot mention rewriting

Before a message is sent to the model, the raw Discord mention token for the bot is
replaced with the readable name `@Bloombot`, so the model sees a sentence addressed to a
named assistant rather than an opaque numeric id.

#### BOT-7 Citation marker stripping

File-search answers may carry inline source markers of the form `【…】`. These are
stripped from the reply before it is posted, since they are noise to a student reading in
Discord.

#### BOT-8 Reply in place

The answer is posted back into the same channel the question was asked in, so a student's
conversation with the bot stays in their own private channel or in the shared course
channel where it started, and remains visible to course staff who have access there.

#### BOT-9 Graceful degradation on API failure

If the OpenAI call raises, the error is logged with its detail and the student receives a
plain-language apology stating that the bot cannot respond intelligently right now and
directing them to that course's admins. The bot does not crash, and continues serving
other messages.

#### BOT-10 Structured operational logging

The bot logs, at INFO level, each attributed message with its author, author id, category
and channel; the prompt text; the resolved OpenAI prompt id and conversation id; the
generated answer; and the user's running request count against their limit. OpenAI errors
and database failures are logged at ERROR level. Logs are written to
`response_bot.log` inside the directory named by `LOGS_DIR`, which is created at startup if
it does not exist.

#### BOT-11 Daily request limit resets at the day boundary

A user who exceeds their course's daily request limit must be able to ask again the
following day. The limit is specified as requests *per day* (CFG-2, BOT-5), but the
counter is only reset as part of recording a successful response, and the over-limit
check returns before ever reaching that point. A user who goes over is therefore locked
out permanently rather than until midnight, and only a process restart — which clears the
in-memory counters — releases them. The day boundary must be evaluated when the limit is
checked, not only when it is incremented.

#### BOT-12 Role fallback matches the configured student role

The role-based course routing fallback (BOT-3) must match the author's Discord roles
against both role names a course declares under `roles` — `admins` and `students`. It
currently reads a `student` key, which no course configuration defines, so the student
half of the fallback can never match and only course admins are routed by role. Students
messaging the bot outside a recognized course category go unanswered.

### 6. OpenAI Integration

#### AI-1 Responses API with stored prompts

Answers are generated through the OpenAI Responses API using a stored prompt referenced
by the course's `prompt_id`. The prompt itself — the assistant's persona and answering
rules — is maintained in the OpenAI dashboard rather than in this repository, so an
instructor can revise the assistant's behavior without a code change or a redeploy. A
course with no `prompt_id` configured is logged as a misconfiguration and its messages go
unanswered.

#### AI-2 File search over course materials

Every request enables the `file_search` tool against the course's `vector_store_id`,
which holds that course's uploaded notes, syllabus and schedule. This is what grounds
answers in the actual course material; the configured instructions direct the assistant
to answer from the uploaded files and to keep replies to at most one paragraph.

#### AI-3 Per-user conversation continuity

Each user gets an OpenAI conversation created on their first message and reused for every
message afterward, so follow-up questions carry the earlier context. The conversation is
seeded with an opening item that states the user's Discord name, their Discord user id
and the course they are in, and carries the user id in its metadata. Conversations are
held in memory keyed by Discord member, so a process restart begins fresh conversations.

#### AI-4 Model and output bounds

The model is taken from the course's configuration, defaulting to `gpt-4o` when unset;
courses currently pin `gpt-4.1`. Every request bounds output at 2048 tokens and is stored
on OpenAI's side (`store=True`) so that conversation state persists between turns.

#### AI-5 Analytics topic classification model

The analytics notebook makes its own OpenAI calls, classifying each conversation with
`gpt-4o-mini`. This is deliberately a cheaper model than the one serving students, since
classification runs over the full history rather than per message.

### 7. Persistence & Data Model

#### DATA-1 SQLite store via peewee

All persisted state lives in a single SQLite database, by default `data/data.db` and
overridable with `SQL_LITE_DB_PATH`, accessed through the peewee ORM. The connection is
established and verified at import time by `models/base.py`, which every model shares.
SQLite keeps the deployment to a single process with no database server to operate.

#### DATA-2 Base model conventions

All models inherit from `Base`, which supplies `created_at` and `updated_at` timestamps
and two shared behaviors. Its `get_or_create` override matches on any one of the supplied
fields rather than requiring all of them, so a user can be found by Discord id or by
email or by username, whichever is known at the call site. Its `merge` fills in empty
fields and updates changed ones from a supplied record, reporting each change, so roster
data can be folded into an existing user without clobbering what is already there.

#### DATA-3 User model

A `User` row records a student's `discord_id` (unique), `discord_username`, `email`,
`first_name`, `last_name` and `github_username`, with unique indexes on Discord id and
email. Users are created on demand the first time the bot sees a message from someone, so
the table fills itself without an import step, and the roster fields are available to be
merged in later.

#### DATA-4 Message log

Every message in both directions is logged as a `Message` row: the `content`, the Discord
`category` and `channel` it occurred in, a `direction` of `from` (student to bot) or `to`
(bot to student), and a foreign key to the user, cascading on delete. Rows are indexed by
user and by creation time, the two axes the analytics notebook queries on. Logging is
wrapped so that a database failure is recorded but never blocks the student's reply.

#### DATA-5 Migration script

`migrate.py` manages the schema from the command line, dropping, creating and optionally
seeding the `users` and `messages` tables. Its default run drops and recreates; `--no-drop`
and `--no-create` suppress either step and `--populate` seeds mock data. It is the
documented first step of local setup.

#### DATA-6 Migration seed data matches the models

`migrate.py --populate` must seed rows that the current `User` and `Message` models
accept. Its mock data is left over from an earlier SMS project and sets `phone`,
`from_phone`, `to_phone` and `body` — none of which exist on either model — so the flag
raises rather than seeding. Seed data must use the Discord fields the models actually
declare, and must stay in step with them.

### 8. Command-Line Administration

#### CLI-1 Server inspection commands

`main.py` exposes `DiscordManager`'s inspection over a command line. `--show-servers`
lists every server the bot can see; with a `--server`, the `--show-categories`,
`--show-channels` and `--show-users` flags list that server's structure, optionally
narrowed by `--category` or `--channel`. This is the fastest way to obtain the ids the
other commands take.

#### CLI-2 Create and delete commands

The same CLI creates a category (`--create-category`), creates a channel
(`--create-channel`, optionally within `--category`), and deletes either
(`--delete-category`, `--delete-channel`). These are the manual escape hatch for
one-off corrections that the config-driven scripts do not cover.

#### CLI-3 Name or id arguments

Every selector argument — `--server`, `--category`, `--channel`, `--user`, `--role` and
the delete targets — accepts either a numeric Discord id or a name, converting digit
strings to integers automatically. An instructor can therefore work entirely from the
names visible in the Discord UI.

#### CLI-4 Argument validation and token resolution

The CLI refuses to run without either `--show-servers` or a `--server`, and refuses
category, channel or user operations that were given no server, reporting the missing
argument rather than failing against Discord. The bot token comes from `--token` when
given and otherwise from `BOT_TOKEN` in the environment or `.env`.

### 9. Analytics

#### ANLY-1 Derived course, channel type and semester

`analytics.ipynb` loads the message log joined to its users and derives three analysis
dimensions from the raw Discord category string on each message: the course it belongs
to, the type of channel (a shared global channel versus a private student channel), and
the semester. This derivation is what lets a single database serve cross-course and
cross-semester comparisons.

#### ANLY-2 Message volume reporting

The notebook charts total message volume by course, by course and semester, and by
channel type, plus a weekly activity line chart. Together these answer how much the bot
is used, whether use is growing, and whether it is used more in private or shared spaces.

#### ANLY-3 Per-user engagement reporting

The notebook charts the fifteen most active users and the distribution of messages per
user, showing whether use is broad across a cohort or concentrated in a few students.

#### ANLY-4 Conversation grouping

Consecutive messages from a user are grouped into conversations using a configurable
silence gap, 30 minutes by default. The notebook then reports conversations per course,
the distribution of conversation lengths, and conversations per user — the unit that
matters for "how many distinct questions were asked", as opposed to raw message count.

#### ANLY-5 Topic classification

Each conversation is classified into a topic such as "Assignments & homework" or
"Technical setup & tools" by an OpenAI model. Results are reported as an overall topic
bar chart, a per-course stacked bar, a per-course-per-semester grouped bar, a heatmap of
unique users per topic per course, and a box plot of conversation length by topic. This
section is the only part of the notebook that requires an API key; every other section
runs without one.

#### ANLY-6 Classification cache

Topic labels are cached in `data/topic_classifications.json` and re-used on later runs,
so re-running the notebook classifies only conversations it has not seen before. This
keeps repeat runs fast and keeps the classification cost proportional to new activity
rather than to total history.

#### ANLY-7 Summary table

The notebook closes with a pivot table of conversation count, unique users, average
messages per conversation and average conversation duration, broken down by course,
semester and topic — the single table an instructor can read to compare semesters.

### 10. Operations & Deployment

#### OPS-1 Python environment

The project targets Python 3.12 and pins its dependencies with pipenv (`Pipfile`,
`Pipfile.lock`); `requirements.txt` is maintained as a flat alternative for environments
without pipenv. Runtime dependencies are `discord.py`, `openai`, `python-dotenv`,
`pyyaml` and `peewee`; the analytics stack adds `pandas`, `matplotlib` and `seaborn`, and
the dev extras add `ipykernel` for the notebooks.

#### OPS-2 Process supervision with pm2

The bot runs under pm2 in production, configured by `ecosystem.config.cjs`, which names
the process `bloombot`, runs `response_bot.py` through `pipenv` so it executes inside the
project's virtualenv, and directs pm2's own stdout and stderr to timestamped files in
`logs/`. pm2 restarts the bot on crash, and `pm2 save` plus `pm2 startup` make it survive
a host reboot. No secrets are placed in the pm2 config; the bot loads `.env` itself. The
config file carries the `.cjs` extension because `package.json` declares `type: module`,
under which a `.js` config would be parsed as an ES module and expose no apps to pm2.

#### OPS-3 Configurable logging

Log destination and verbosity are environment-controlled through `LOGS_DIR` and
`LOG_LEVEL`, defaulting to `./logs` at `INFO`. Every log line carries a timestamp and
level. The log file is named after the running script, so each entry point writes its own
file.

#### OPS-4 Documented setup and operation

`README.md` documents the full path from a clean checkout to a running bot: prerequisites,
dependency install, `.env` creation, database migration, course configuration, each
script's purpose and invocation, notebook usage, and the pm2 lifecycle commands. It is the
single onboarding document for a new instructor or maintainer.

#### OPS-5 Secrets and generated data stay out of version control

`.env`, the SQLite database, logs and real student data are excluded from version control;
only `env.example`, empty-directory readmes and the anonymized `xx`-prefixed sample CSVs
are committed. Student names, emails and Discord handles are personal data and must never
be committed.

#### OPS-6 Automated tests and continuous integration

The project's testable logic must be covered by an automated test suite that runs on
every push and pull request. The units worth testing are the ones that are pure or can be
exercised against fakes: the name-or-id resolution helpers, the daily rate-limit
accounting, course routing by category and by role, roster path construction and welcome
message formatting, and the board scripts' SPEC parser. Network calls to Discord and
OpenAI are stubbed rather than exercised. A GitHub Actions workflow runs the suite on the
project's supported Python version so a pull request cannot be merged on unverified
changes.

#### OPS-7 Continuous deployment

A commit merged to the default branch is deployed to the production droplet automatically,
and only after the full test suite has passed. Deployment updates the droplet's existing
git checkout to that exact commit over SSH, so the running version is always identifiable
on both ends; it installs dependencies only when the pinned dependency files changed, and
reloads the pm2 process. It must never disturb untracked files — the `.env`, the SQLite
message log and the logs directory — and must never run the destructive `migrate.py`.

The deploy refuses to overwrite hand edits: if a tracked file has been modified directly on
the server it aborts and reports the diff rather than discarding the change. It verifies
before restarting that the interpreter pm2 uses can import the bot's dependencies, and
after restarting that the process is online and has not been restarted again by pm2 —
a crash-looping deploy is rolled back to the previous commit automatically. A manual run
can deploy any earlier commit, which is the rollback path.

The deploy key and host fingerprint are held as environment-scoped repository secrets, the
host key is pinned, and no pull request event can reach the deployment job.

### 11. Specification & Project Board Tooling

#### BOARD-1 Spec-derived board manifest

`scripts/board/derive.mjs` parses this document — the four-hash requirement subheadings
and the numbered three-hash section headings they sit under — together with `docs/ROADMAP.md`, and
writes `scripts/board/manifest.yaml`, the curated source of truth for the project board.
Re-running it refreshes titles, sections and families from the spec while preserving any
phase, status and review values a human has set, adds newly-introduced ids, and reports
ids that have disappeared from the spec as stale rather than deleting them.

#### BOARD-2 Idempotent board sync

`scripts/board/sync.mjs` pushes the manifest to GitHub, upserting one issue per
requirement. Each issue carries a hidden marker keying it to its requirement id, which is
what makes re-runs idempotent rather than duplicative. Title, body, milestone and the
`spec` label are re-enforced from the manifest on every run; an issue's board status and
open/closed state are seeded once at creation and thereafter owned by the board and its
automation unless `--reconcile` is passed. The script supports `--dry-run`, `--limit`,
`--reconcile` and an opt-in `--prune`, and requires an authenticated `gh` CLI.

#### BOARD-3 Spec format contract

Because the board is generated from this file, its structure is load-bearing.
Requirements must be four-hash subheadings whose text is a family-and-number id followed
by a title, with the requirement's description in the prose beneath the heading up to the
next heading; sections must be three-hash headings whose text is a number, a period and a
title; and an existing id must never be changed, since renaming or
renumbering orphans the issue it keys and creates a duplicate. The contract is restated
in `.claude/CLAUDE.md` so it survives contributor turnover.

#### BOARD-4 Card status follows the slice

A requirement's card shows where its work actually is: `In progress` when a slice starts,
`In review` when its pull request opens, and `Done` when that pull request merges. GitHub's
own closing keywords cannot do this here: `Closes #N` fires only for a pull request merged
into the repository's default branch, and every branch in the platform build targets the
long-lived integration branch instead, so nothing would ever close and every card would sit
in Backlog while the work happened. `scripts/board/status.mjs` is the explicit substitute —
it writes the status into `manifest.yaml`, which is the board's source of truth, and
reconciles the board with it. Pull requests still carry `Closes #N`, so the link between a
change and the requirement it satisfies survives in the history and fires automatically on
the eventual merge to the default branch.

### 12. Platform Architecture

#### PLAT-1 Monorepo layout

The system is one npm-workspaces monorepo on Node 22, TypeScript throughout, ESM
throughout. `packages/` holds libraries with no process of their own — configuration,
logging, shared zod schemas, data access, the answering core, the action layer, the
Discord and OpenAI clients, provisioning, background jobs, the MCP server, and the OAuth
authorization server. `apps/` holds the four processes: the Express API, the Discord bot,
the background worker, and the React control panel. `e2e/` holds Playwright specs and the
fake upstreams they run against. Nothing in `packages/` imports from `apps/`.

#### PLAT-2 Package boundaries

Dependencies between packages are acyclic and enforced by lint rule rather than
convention. `packages/schemas` depends on nothing but zod, because it is the contract
shared by web forms, API validation and bot runtime, and a dependency there would pull the
server into the browser bundle. `apps/web` may import `packages/schemas` and nothing else
from the workspace: importing the data, configuration, Discord or OpenAI packages into a
browser bundle would ship secrets to every visitor, so that specific import is blocked by
an ESLint `no-restricted-imports` rule rather than left to review.

#### PLAT-3 One gateway connection

`apps/bot` holds the only Discord gateway connection. The API and the worker reach Discord
over REST with the same token, so there is no inter-process coordination to get wrong;
Discord enforces the shared rate-limit buckets server-side. Each REST client is
configured below the global request ceiling so the two processes together stay under it.

#### PLAT-4 Process topology

Four processes, each single-instance: API, bot, worker, and a static build served by
nginx. Never clustered — multiple API workers would multiply writers against a
single-writer database for no gain, and two gateway connections on one token is an error
rather than redundancy.

#### PLAT-5 No import-time side effects

Modules do not open connections, read configuration files, construct API clients or write
to stdout when they are imported. The current system does all four, which is why its
configuration cannot be reloaded, scoped per tenant, or tested without a live database.
Connections and clients are created lazily and explicitly.

### 13. Action & Authorization Layer

#### ACT-1 Every operation is an action

Everything the platform can do on a user's behalf is an action: a dotted name, a zod input
schema, a declared access policy, an optional metering hook, and an execute function.
Actions are the single write path. The web control panel and the MCP server both reach
them through the same dispatcher, so an assistant's call is an ordinary call by the
account that authorized it rather than a parallel implementation with its own rules.

#### ACT-2 Declared authorization

An action declares how it is authorized rather than checking inside its body, and an
action with no declaration does not compile. A policy pairs a machine-readable descriptor
— the resource it protects and the level of access required — with a function that
resolves and returns the entity it authorized. Because the policy hands the resolved,
tenant-scoped entity to the execute function, an action cannot reach a record without
having been given one that was already checked.

Policies read the database and nothing else. Authorization runs outside the usage
attribution context, so a policy that called a paid provider would spend money nobody is
attributed for.

#### ACT-3 Refusals reveal nothing

Every refusal is the same error whether the record does not exist or the caller has no
access to it, so an identifier cannot be probed to learn which. The error carries no
detail about the record it protected.

#### ACT-4 Dispatch pipeline

Dispatch validates the input against the action's schema, authorizes, meters, then
executes — in that order, in one place. Authorization precedes metering so an unauthorized
call never consumes an allowance. Typed errors are mapped to HTTP statuses by one
middleware; no route maps its own, so the same failure looks the same everywhere.

#### ACT-5 Access audit index

A test table pins every registered action to its declared access descriptor. Weakening a
guard still type-checks, so the table is what makes the change visible: it appears as a
one-line diff in a file a reviewer reads. An action may authorize itself by an explicit
exception only if its reason is recorded in the same test.

#### ACT-6 Machine-readable catalog

The registry derives a JSON-Schema catalog of every action — name, description, input
schema and access descriptor — for AI channels to consume. The catalog is machinery, not
itself a tool list: what an assistant may reach is decided by the MCP tool surface, not by
what the catalog contains.

### 14. Accounts & Authentication

#### AUTH-1 Passwordless email sign-in

An account is created and accessed by a link sent to an email address. Tokens are stored
as hashes, expire within minutes, and are single-use — consumed in the same transaction
that creates the session, so a link cannot be replayed.

#### AUTH-2 Google sign-in

Google OAuth 2.0 with PKCE is offered alongside email. A Google identity links to an
existing account only when the provider asserts the email is verified and it matches;
otherwise a new account is created. Linking on an unverified email is account takeover.

#### AUTH-3 Sessions

Sessions are opaque random tokens stored as hashes, carried in an HttpOnly, Secure,
SameSite cookie, and rotated on sign-in. Storing hashes rather than the tokens themselves
is what makes administrative session revocation possible. Non-GET requests are checked
against their origin.

#### AUTH-4 Platform administrators

Administrators are identified by an email allowlist in the environment, read on every
check rather than captured at startup, so adding or removing one takes effect without a
deployment. It is never a self-granted role or a database flag.

### 15. Tenancy & Server Registration

#### TEN-1 The tenant is an organization

Every scoped record carries an organization id. An account gets a personal organization on
sign-up; membership is a separate record so a second instructor or a teaching assistant
can be added without restructuring anything.

#### TEN-2 Repository-level scoping

Every data-access function takes the organization id as its first parameter and includes
it in the query. There is no function that fetches a scoped record by id alone, and route
handlers do not reach the database directly. Tenant isolation is therefore a property of
the data layer rather than a rule each handler must remember.

#### TEN-3 One organization per Discord server

A Discord server is bound to exactly one organization, structurally: the server's
snowflake is the primary key of the binding record, so a second claim cannot be inserted.
An attempt to register a server already registered elsewhere is refused, and a server
whose bot was removed may be re-claimed.

#### TEN-4 Installation

The bot is installed through Discord's OAuth flow, initiated from a signed-in session.
The platform verifies that the installing account actually administers the server before
binding it, and discards the user access token afterwards: nothing needs it, and storing
it is a liability.

#### TEN-5 Cross-tenant access is indistinguishable from absence

A request for another organization's record is refused as not-found rather than
forbidden, so the existence of a record is never disclosed. This is verified by a test
matrix covering every route against another organization's session, an absent session, and
a disabled account.

#### TEN-6 Removal preserves data

Removing the bot from a server marks the binding inactive; it never deletes the
organization's courses, rosters or transcripts. A re-installation restores a working
setup, and transcripts are records an instructor may be required to retain. Deleting that
data is a separate, explicitly confirmed, audited action.

### 16. Projects

#### PROJ-1 Courses are grouped into projects

Course configurations belong to a project — typically a term, such as "Fall 2026". An
organization may have any number of projects and a project any number of courses. This
replaces the convention of encoding the term in Discord role names.

#### PROJ-2 Archiving a project

Archiving a project stops its courses routing without deleting anything. This is the
first-class form of the existing practice of commenting a course out of the configuration
file, and it is reversible.

#### PROJ-3 Names must not collide within a server

A course is matched to an incoming message by the name of the Discord category it arrived
in, and secondarily by the author's roles. One server may host several projects at once,
so category and role names must be unique across every enabled course in that server,
regardless of project. A save that would collide is refused, naming the project and course
it conflicts with. Archived projects are excluded, so a term may reuse the previous term's
names once that term is archived.

#### PROJ-4 Duplicating a project

A project can be copied into a new one, bringing its courses, categories, channels,
instructions and knowledge-file attachments, and leaving rosters empty. Rolling a course
forward to the next term is the largest piece of recurring manual work in the current
system.

### 17. Quality, Types & Tooling

#### QA-1 Tests fail before they pass

New behaviour is covered by a test that fails without the change. A test that passes
before the code is written proves nothing about the code.

#### QA-2 No live services in tests

Unit and integration tests never reach a real network. External services are replaced by
adapters pinned in the test configuration, each with a comment naming the leak it
prevents. End-to-end tests run the real API, the real production web build and the real
worker against fake upstreams and a throwaway database.

#### QA-3 Test data is synthetic

No test, fixture or continuous-integration job reads the live database. It holds real
students' names, email addresses and conversations.

#### QA-4 Coverage floor where it matters

Coverage is enforced as a floor on the answering core, the action layer and the data
access layer, rather than as a blanket percentage across the whole tree. A uniform target
across a user interface buys assertions about markup at the cost of attention to logic.

#### QA-5 Agent guardrails are executable

The constraints that protect student data and credentials from automated tooling are
implemented as blocking hooks with their own regression tests, not as prose instructions.
A prose rule competes for attention; a hook does not need anyone to be watching. A silent
regression in such a hook simply stops blocking, which is why it is tested like production
code.

#### QA-6 Environment template cannot drift

Every environment variable the configuration schema requires appears in the tracked
example file, verified by a test. A missing variable otherwise surfaces as a failure hours
into a deployment.

### 18. People, Conversations & Transcripts

#### PPL-1 People are the platform's end users

A person is the human a course serves — usually a student — and is distinct from the
account that signs in to administer a tenant. Every person belongs to exactly one
organization, and nothing about a person is visible outside it. Conversations,
transcripts and usage all key on the person, so a student who reaches a course from
Discord today and from the web chat tomorrow is one person with one history.

#### PPL-2 Identities link a person to a surface

A person is reached through identities: one per surface, each holding that surface's own
identifier — a Discord snowflake, an email address, a web account id. An identity is
unique per organization, surface and external id, so one Discord account cannot resolve to
two people in the same organization. Resolving an incoming message means resolving its
identity to a person.

#### PPL-3 People are created on demand

The first time a course sees a message from someone it has no identity for, the person and
the identity are created together. No import step stands between a student and their first
answer, and roster fields — name, email, GitHub handle — are merged onto the person later
when a roster is imported.

#### CONV-1 Conversations key on course and person

A conversation is the continuity of one person's exchange with one course, keyed on the
course and the person rather than on the surface account it arrived through. A course
declares its conversation scope: `course`, the default, is one conversation per person per
course across every surface; `course_surface` keeps a web session distinct from a Discord
thread, for instructors who want that. A conversation records the upstream model thread it
corresponds to, so the model's own context can be resumed.

#### CONV-2 The transcript records both directions

Every message is recorded: its text, its direction — from the person, or to them — the
surface and channel context it occurred in, and the person, course and conversation it
belongs to. A transcript is a record an instructor may be required to retain, so removing
a bot from a server never deletes one.

#### CONV-3 Daily usage counters key on course, person and day

A person's daily allowance is counted per course per calendar day, never pooled across a
course and never resettable by switching surface. The day the counter belongs to is stored
on the row rather than derived when it is read, which is the defect BOT-11 fixed in the
Python bot.

### 19. Legacy Import

#### MIG-1 The import reads a copy, never the live database

The importer takes the path of a **copy** of the production SQLite file and refuses to
open the live one. The running bot is still serving students while an import is being
rehearsed, the file holds their names, emails and transcripts, and an import that can only
ever be run against a snapshot can be run as many times as it takes to get right.

#### MIG-2 Course configuration is imported from the YAML

`bot_config.yml` becomes an organization, one project holding the term's courses, and for
each course its Discord role names, categories and channels — the same records the control
panel writes, through the same repositories, so imported courses obey the same collision
and scoping rules as courses created by hand.

#### MIG-3 Students and transcripts are imported with their history intact

Each legacy user becomes a person with a Discord identity, keeping the roster fields the
row carries. Each message becomes a message on the conversation for that person and course,
preserving its direction and its original timestamp — a transcript whose times were
rewritten to the moment of import would be useless as the record it exists to be.

#### MIG-4 Importing twice changes nothing the second time

An import is idempotent: re-running it against the same snapshot neither duplicates a
person nor appends a transcript twice, so a failed run can be fixed and repeated. The
importer reports what it created, what it matched to something already there, and what it
could not place, and a message whose course cannot be identified is reported rather than
dropped silently.

### 20. Conversation Core

#### CORE-1 One answering pipeline for every surface

Answering a question is one function no matter where the question arrived from — a
Discord mention, the web chat, or an agent through the MCP server. It takes the
organization, course, person, surface and text; it enforces the daily allowance, records
the inbound message, asks the model, records the reply and returns it. A surface adapter
translates its own events into that call and renders the result, and holds no answering
logic of its own, so a change to how the bot answers cannot apply to one surface and not
another.

#### CORE-2 Routing attributes a message to exactly one course

A message is attributed by the Discord category it arrived in, and failing that by the
author's roles, matching the behaviour the running bot already has. A message that
matches no enabled course is ignored rather than answered from general knowledge, and a
message that matches two is a configuration error the platform reports rather than a
choice it makes quietly.

#### CORE-3 The daily allowance is enforced before the model is called

A person's count for that course and day is checked first, so an over-limit request costs
nothing. The request that reaches the allowance is answered with a notice that it is the
day's last; requests past it are declined without a model call. The day is supplied by
the caller, never read from a clock inside the core, so the boundary is testable and does
not drift with a process's timezone.

#### CORE-4 The model is a port, not an import

The core depends on an interface — a question and its context in, an answer out — and
never on a vendor's SDK. The whole pipeline therefore runs in tests against a fake model
with no network, and a second model provider is an adapter rather than a rewrite.

#### CORE-5 A model failure degrades to an apology, never to silence or a stack trace

When the model call fails, the failure is logged with its cause and the person is told
plainly that the assistant cannot answer right now and pointed at the course's staff. The
inbound message is still recorded, because a question the system failed to answer is
exactly the one an instructor needs to see.

#### CORE-6 Both directions are recorded, and recording never blocks the reply

The question and the answer are both written to the transcript against the same
conversation. A failure to record is logged and does not prevent the person receiving
their answer: losing a transcript row is bad, and withholding a student's answer because
of it is worse.
