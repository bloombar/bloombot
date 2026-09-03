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
existing account only when the provider asserts the email is verified and it matches; when
it is verified but matches no account, a new one is created. An identity the provider does
not assert is verified neither links nor creates an account, regardless of whether the
address matches one — it is refused outright. Linking on an unverified email is account
takeover, and so is creating an account from one: an attacker who asserts a victim's real,
unverified address before the victim has ever signed in themselves must not get to hold
that account first.

#### AUTH-3 Sessions

Sessions are opaque random tokens stored as hashes, carried in an HttpOnly, Secure,
SameSite cookie, and rotated on sign-in. Storing hashes rather than the tokens themselves
is what makes administrative session revocation possible. Non-GET requests are checked
against their origin.

#### AUTH-4 Platform administrators

Administrators are identified by an email allowlist in the environment, read on every
check rather than captured at startup, so adding or removing one takes effect without a
deployment. It is never a self-granted role or a database flag.

#### AUTH-5 A sign-in link actually reaches the person

The platform sends mail in production through a real transport, configured by environment
like every other credential. This is what makes AUTH-1 usable at all: a sign-in link is the
primary way anybody reaches the panel, so a deployment that cannot send one is a deployment
nobody can log into. The development stand-in that writes to a file stays refused in
production, and a process that is configured to send mail and cannot must fail where an
operator sees it rather than accepting a sign-in it will silently drop.

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

#### TEN-7 An organization has a name a person recognizes

An organization carries a display name, shown wherever a person has to choose which one
they are acting in. A personal organization created at sign-up is named after the account
that owns it, so the choice is never between two identifiers.

#### TEN-8 A server binding is visible to the organization that holds it

An organization can list the Discord servers bound to it, so the panel can show what is
already installed rather than only what this browser session happened to install. The
listing is scoped like every other read: a server bound to another organization is not in
it, and its existence is not disclosed.

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

#### PROJ-5 The panel reads through the same layer it writes through

Everything the control panel displays about projects and courses is read through the
action layer, not through a route that reaches the database on its own. A read is an
action with a policy like any other, so a screen cannot show a record the caller would not
have been allowed to open, and the audit index covers reading as well as writing.

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

#### QA-7 The signed-in path is tested end to end

At least one test drives a real browser against a real front end, a real API and a real
database: sign in, land in an organization, and see what a signed-in instructor sees. Unit
tests on either side of a contract can both pass while the contract itself is broken, and
this is the test that would notice.

#### QA-8 The product's central claim is tested end to end

One test drives a browser to create a project and define a course in it, and then a message
arriving in that course's Discord category is answered using that course's own
configuration — with no file edited and no process restarted between the two. This is the
sentence the whole migration exists to make true, and it is worth a test that would notice
if it stopped being true.

#### QA-9 The end-to-end suite is a gate, not a coin flip

The Playwright suite fails intermittently under its own parallelism — `SQLITE_BUSY` and `database
is locked`, raised from inside transactions in specs that have nothing to do with one another. It
predates any one feature and reproduces on commits well before the branches that noticed it. A
suite that has to be re-run until it passes is not a gate: it trains everyone reading it to
discount a red result, which is precisely the habit that lets a real regression through. Every
spec gets a database no other spec is writing to, or the runner stops sharing one — whichever the
diagnosis supports. The fix is judged by running the suite repeatedly and getting the same answer,
not by one green run.

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

#### PPL-4 A surface is linked by proving it, never by matching an address

A person gains an identity on a second surface by proving control of the account that
surface knows — signing in with Discord to link a Discord identity, and so on — never by an
address matching one already on file. A roster's email is an instructor's assertion about
somebody else and is corroboration at best; a self-asserted one is worth nothing. Matching
on an address is how one person inherits another's conversations and allowance.

#### PPL-5 Seeing or exporting a person's history requires a verified address

Answering a question needs no address at all — the bot already knows who asked. Reading a
transcript back, exporting one, or carrying a conversation onto a second surface is a
disclosure, and disclosure requires an address the platform verified itself. The two
controls are separate on purpose: one proves which account is speaking, the other decides
what may be shown.

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

#### CONV-4 A message is never silently lost from the record

Writing a message to the conversation is part of answering, not a side effect of it. If the
record cannot be written, that is a failure worth surfacing and retrying — not something to log
and continue past, leaving a student who was answered and a transcript that says they were not.
CONV-2's retention guarantee and ADMIN-1's transcript are only as good as this: a record with
holes in it cannot be audited, exported, or trusted, and the holes appear precisely under load,
when several processes are writing at once.

#### CONV-3 Daily usage counters key on course, person and day

A person's daily allowance is counted per course per calendar day, never pooled across a
course and never resettable by switching surface. The day the counter belongs to is stored
on the row rather than derived when it is read, which is the defect BOT-11 fixed in the
Python bot.

### 19. Enrolment & Course Access

#### ENRL-1 A person's courses are a record, not a guess

Which courses a person may ask is a stored relation rather than something inferred per message.
On Discord the category a question arrived in decides the course; the web chat has no category,
so the question would otherwise be answered by whichever course the asker names. An enrolment
says plainly which courses are theirs, and every surface consults the same relation.

#### ENRL-2 A student chooses among the courses they are already eligible for

The web surface lets a person pick the course they are asking, from the courses they are
enrolled in and no others. Naming a course they are not enrolled in is refused the way every
other unauthorized read is — as not found. Otherwise anyone inside a tenant could ask any
course, spend that course's budget and appear in its transcripts, where the instructor would
see a stranger's questions.

#### ENRL-3 Enrolment comes from something the instructor controls

An enrolment is created by one of three things, each an admission decision the instructor
already makes: redeeming a course join link they issued and can revoke, holding that course's
student role in the server bound to the organization, or appearing on an imported roster. A
person never enrols themselves out of nothing, and the platform records which of the three
admitted them.

#### ENRL-4 A join link is revocable, and revoking it does not un-enrol anybody

A join link can be disabled or given an expiry, so a link shared beyond its intended audience
can be closed off. Revoking a link stops it admitting anyone new; it does not remove the people
it already admitted, because taking a student's access away is a separate decision an
instructor makes deliberately.

#### ENRL-5 Staff roles are never self-selected

Membership roles — owner, instructor, assistant — carry authority over a tenant's courses,
transcripts and spending, and are granted only by an existing owner through an action that is
recorded. No surface offers them as a choice. A Discord role is a routing signal and confers
none of them: administering a Discord server is not instructing a course, and the two are
deliberately not the same fact.

#### ENRL-6 Ending an enrolment keeps what was said

Removing an enrolment stops a person asking that course; it deletes neither their transcript
nor the course's record of what was asked. A term ending is not a reason to lose what a student
asked during it, and TEN-6's rule about removal applies here for the same reason.

#### ENRL-7 Anyone a course is taught through is enrolled by asking it

CORE-2 routes a message to a course when its author holds either of that course's two Discord
roles — its admins role or its students role — but only a students-role holder is ever admitted to
the enrolment relation. An instructor or teaching assistant therefore holds a conversation on
Discord that the platform has no enrolment record of, and the web surface, which authorizes on an
active enrolment rather than a membership (WEB-10), refuses the same person the Discord surface
just answered. Asking a course through a channel it is taught in enrols the asker, whichever of
the two roles carried them there, so that one person's access does not depend on which surface
they happened to use first. ENRL-6 is untouched: an enrolment an instructor ended stays ended, and
holding a role does not revive it.

#### ENRL-8 A join link enrols whoever redeems it, and only them

ENRL-3 gives an instructor a shareable course join link and `redeemJoinLink` to spend it, but
nothing calls that function: there is no route, no screen, and no way for a student to redeem one.
The function takes the person to enrol as an argument it cannot verify, and its own documentation
names the trap — a link is deliberately shared with a whole class, so presenting the secret proves
nothing about who is presenting it, and a route that took a person id from the request body would
let anyone holding the link enrol anybody in the tenant. Redemption binds to the caller's own
authenticated identity and never to a name they supply. A visitor who is not signed in is asked to
sign in first and returns to the link they were given. A signed-in account with no person in the
link's organization gets one, connected the same way LINK-3 connects every other identity, so the
enrolment it gains is one the web chat can actually find. A link that never existed, one that was
revoked and one that expired are refused identically, because a redemption endpoint that
distinguishes them is an oracle for guessing links.

Redemption never revives an enrolment ENRL-6 already ended. A join link is deliberately shared
with an entire class, so a person an instructor has removed still holds the same secret everybody
else does; redeeming it again is that removed person acting alone, not an instructor's decision,
and must not be able to undo one. This holds even when the removed person's only prior identity in
the organization used a different surface than the one redeeming now — a verified email the
redeeming account shares with a person already holding an ended enrolment for the course refuses
the redemption rather than admitting a second, freshly-created person for the same human. Whoever
actually means to re-admit a removed person does so through a caller that says so, the same way
ROST-9's roster import already does; redeeming a link is never that caller.

#### ENRL-9 An enrolment an instructor ended can be reinstated by an instructor

ENRL-6 lets an instructor stop a person asking a course, and closing ENRL-8's self-service bypass
made that decision genuinely stick: no admission path revives an ended enrolment any more — not a
join link, not a roster row, not a Discord role. That is correct, and it leaves an instructor who
ended the wrong enrolment, or ended one a student has since appealed, with no way to undo it. A
decision that can be made and never unmade is not an access control, it is a trap. Reinstating is
an instructor-initiated act, recorded the way granting a membership already is (ENRL-5): who did
it and when. It is deliberately not something the reinstated person can trigger, which is the
whole distinction ENRL-8's rework turns on — the person who was removed is exactly who must not be
able to reverse it. Reinstating a person who is not currently ended changes nothing, the same
idempotent no-op ending an already-ended enrolment gives.

### 20. Background Jobs & Admission

#### JOB-1 Work that outlives a request runs as a job

Anything that cannot finish inside a request — provisioning a server's channels, importing a
roster, attaching a knowledge file, duplicating a term — is queued as a job rather than held
open on an HTTP connection. A job carries the organization it belongs to, so a queue is never
a way around the scoping every other read and write obeys.

#### JOB-2 A job that fails is retried, and a job that keeps failing is visible

A failure is retried with a backoff and a bounded number of attempts; a job that exhausts them
stops and stays visible with the reason it stopped, rather than disappearing. Silent
disappearance is what makes a queue impossible to operate.

#### JOB-3 A job runs once, even with a worker restart in the middle

Claiming a job is atomic, so two workers cannot run one twice, and a worker that dies mid-job
releases its claim rather than stranding it. Where the work itself cannot be made idempotent,
the job records enough to resume rather than repeat.

#### JOB-4 Admission bounds concurrent model calls

Thirty students asking at the start of a lecture must not become thirty concurrent model calls.
Requests wait for a slot rather than failing, up to a bound, and a student who waits is told
they are waiting rather than left with silence. The bound is configuration, not a constant
compiled into a client.

#### JOB-5 The worker is one process, and its health says whether it is working

The background worker is single-instance like every other process, reports whether it can reach
the database and the queue, and shuts down by finishing or releasing what it holds rather than
abandoning it.

#### JOB-6 A finished job stops carrying the personal data it was given

A job's payload is opaque JSON the enqueuer chooses, and `roster.import`'s payload is the whole
roster CSV — every student's name, email and Discord handle. The row is never cleared, and
`jobs.get` returns the parsed payload to any member of the organization, so one roster import
leaves a queryable copy of a class list in the `jobs` table for the life of the database, long
after the work it described has finished. That is the same data `data/*.db`, `results/*.csv` and
`rosters/*.csv` are protected for, kept in the one place nothing protects. A job that has
succeeded or failed permanently no longer needs what it was given: its payload is cleared once it
reaches a terminal state, and what a caller may still read back is the job's own outcome — its
status, its attempts, its error and its report — not its input. Nothing about the queue's own
mechanics depends on re-reading a payload after the work is done; a retry re-reads it, so clearing
waits for a state from which no retry follows.

### 21. Server Scaffolding on the Platform

#### SRV-6 A course's Discord structure is created from its configuration

The categories and channels a course declares are created in its bound server on request, with
the permissions its roles imply. This is the operation the Python `hydrate_server` script
performs today, moved behind an action so an instructor can run it from the panel rather than a
terminal.

#### SRV-7 Scaffolding is idempotent and reports what it did

Running it twice creates nothing twice: what exists is left alone, what is missing is created,
and the result names what changed. An instructor who is unsure whether it ran can run it again
safely, which is the only way a provisioning tool is usable.

#### SRV-9 Scaffolding repairs the bot's own access, wherever it is missing

A course category denies `@everyone`, and Discord applies that denial to the bot as well — so the
platform has to grant itself an overwrite on the structure it manages, or it cannot answer in it.
That grant belongs on every category and channel a course declares, not only on the ones this run
happens to create: a channel an instructor made by hand, or one that predates the platform
granting itself anything, is exactly where a student will ask a question and get silence.

This is the one exception to leaving an existing channel's permissions alone (SRV-8's own
discipline), and it is deliberately the narrowest possible one: a single overwrite for the bot's
own id, replacing nothing else. Every role grant, every per-member permission an instructor added,
and the `@everyone` denial that makes the course private all survive it.

#### SRV-8 Scaffolding never deletes

Creating structure is not the same operation as removing it. A category or channel the
configuration no longer mentions is reported, never deleted — a student's messages live in those
channels, and DATA-4's transcript is not a substitute for them.

### 22. Roster Import on the Platform

#### ROST-9 A roster is imported as a file, into a job

An instructor uploads the roster the registrar gave them and the import runs as a job (JOB-1),
because a large roster outlives a request. The file is parsed against a schema, and a row that
does not parse is reported with its line rather than skipped in silence.

#### ROST-10 A roster row becomes a person, and matching is by handle

A row's Discord handle identifies the person it describes; the roster's name and email are merged
onto that person without overwriting anything a surface already proved (PPL-4's rule, and the
reason a roster is corroboration rather than authority). A row whose handle matches nobody yet is
kept, so the person is recognized when they first appear.

#### ROST-11 Per-student channels are created without exceeding Discord's limits

Private per-student channels are created in batches that respect Discord's cap on channels per
category, spilling into the next numbered category as the current one fills — the behavior
ROST-4 describes for the Python tool, on the platform's own job runner.

#### ROST-12 An import says what it could not do

Handles that do not resolve, students already present, channels that could not be created: each
is reported at the end of the run, with enough detail for an instructor to fix the roster and run
it again. An import that silently half-worked is worse than one that refused.

### 23. Knowledge Files & Instructions

#### FILE-1 A course's knowledge is files an instructor uploads

An instructor attaches the course's notes, syllabus and schedule to the course in the panel. The
platform stores the file, tracks which course it belongs to, and makes it available to that
course's answering — replacing a vector store id typed in from a vendor dashboard.

#### FILE-2 An attachment's lifecycle is visible

An attachment is pending, ready, or failed, and the panel says which. Uploading a file that the
provider then rejects must not leave a course looking configured while its answers are ungrounded.

#### FILE-3 Removing a file removes it from answering

Detaching a file stops it grounding answers, and the removal reaches the provider rather than only
the platform's own record. A course's material is what the instructor last said it was.

#### FILE-4 Instructions are versioned

A course's instructions are edited in the panel and each save is a revision with an author and a
time, so an instructor can see what the assistant was told last week and restore it. This is
D-3's `course_instruction_revisions`, and it is what makes instructions safe to edit on a live
course.

#### FILE-5 A file is scoped like every other record

An attachment belongs to an organization and is reachable only through it, and the stored bytes are
not addressable by anybody who guesses an id. Course material is not public.

### 24. Cost Ledger, Caps & Monitoring

#### COST-1 Every model call is recorded with what it cost

A call records the course, the person, the model, the token counts the provider reported and the
cost in integer micros. Money as a floating-point number is how a ledger stops adding up.

#### COST-2 A cost is attributed to whoever caused it

Every recorded call names the organization, the course and the person it was made for, so an
instructor sees what their course spent and an administrator sees what a tenant spent. A call that
cannot be attributed is a defect, not a row with a null.

#### COST-3 An organization has a spending cap, and the cap is enforced before the call

A cap is checked in the same place the daily allowance is (ACT-4's metering step), before the model
is asked, so exceeding it costs nothing. A tenant at their cap is refused with a message that says
so, not a generic failure.

#### COST-4 Usage is visible to the people it concerns

An instructor sees their courses' usage and the students approaching their limits; a platform
administrator sees usage per organization. Neither has to read a log file or run a query to find
out what is being spent.

#### COST-5 The bot's own health is monitored, not inferred

Whether each process is running, connected and answering is observable — the gateway connection,
the queue depth, the model provider's error rate — so a failure is noticed before a student
reports it.

#### COST-6 An estimate is never presented as a measurement

Where a provider does not report usage, the ledger records that the number is an estimate rather
than quietly storing a guess in the same column as a fact.

### 25. MCP Server & Agent Access

#### MCP-1 An assistant reaches the platform through the action layer

The MCP server exposes actions as tools and dispatches them through the same pipeline the API
uses. An assistant's call is an ordinary call by the account that authorized it — same policies,
same refusals, same audit — not a parallel implementation.

#### MCP-2 The tool surface is chosen, not derived

What an assistant may reach is an explicit list, not everything in the catalog. A new action does
not silently become an agent-callable tool; adding one to the surface is a deliberate edit that a
reviewer sees.

#### MCP-3 An agent acts as an account, with that account's authority

A connection authenticates as an account and carries that account's memberships and nothing more.
There is no service identity that transcends tenancy, because an assistant with more authority than
the person who ran it is a privilege escalation with a friendly interface.

#### MCP-4 A destructive tool asks first

A tool that deletes, exports, or spends money is marked as such and requires an explicit
confirmation the assistant cannot supply on the person's behalf.

#### MCP-5 Agent usage is metered and attributed like any other

Calls made through MCP draw on the same allowances and the same cost ledger, attributed to the
account that authorized the connection. An assistant is not a way around a cap.

### 26. Admin Console, Transcripts & Export

#### ADMIN-1 An instructor can read their course's transcripts

The conversations a course has had are readable in the panel, filtered by student and by date, so
an instructor can see what was asked and what was answered. This is the record CONV-2 exists to
keep, made usable.

#### ADMIN-2 Reading a transcript is itself recorded

Who read whose conversation, and when, is written to an audit trail. Transcripts are student
speech, and access to them is the kind of thing an institution has to be able to account for.

#### ADMIN-3 Export produces a file, as a job

An instructor exports a course's transcripts and usage as a job (JOB-1), and collects the file
when it is ready. The export carries only that organization's data, and the same audit entry as a
read.

#### ADMIN-4 A platform administrator sees tenants, not conversations

The platform-administrator console shows organizations, their usage and their health. It does not
grant a route into a tenant's transcripts: administering the platform is not the same as reading
a student's questions, and AUTH-4's allowlist is not a master key.

#### ADMIN-5 Deleting a tenant's data is explicit, confirmed and audited

TEN-6 keeps data when a bot is removed; this is the separate, deliberate operation that removes
it. It names exactly what will be deleted, requires confirmation, and is recorded.

### 27. Production Hardening & Cutover

#### OPS-8 The platform deploys as the processes it actually is

The deployment runs the API, the bot, the worker and the static panel as supervised processes,
each restarted independently, with the migration applied once before they start rather than by
whichever process wins the race.

#### OPS-9 Cutover is rehearsed against a copy before it is real

The legacy import runs against a copy of the production database, and the platform answers
alongside the Python bot in a test server, before anything is switched. MIG-1's rule holds:
the rehearsal never touches the live file.

#### OPS-10 The old system is retired deliberately, and can be returned to

Cutover stops the Python bot and starts the platform's, in that order, with a documented way back
that does not depend on anything the cutover deleted. The two systems share a database file
during the migration (D-9), which is what makes returning possible.

#### OPS-11 Secrets are rotated at cutover

Every credential the Python system used is rotated when the platform takes over, because a
credential that has been in two systems' environments is a credential with two chances of having
leaked.

#### OPS-14 The whole stack runs locally from documentation alone

A developer can bring up the API, the panel and the bot on their own machine and reach the product in a
browser, following one document: what to install, which configuration values carry over from the system
being replaced and which are new, how to sign in when no mail transport exists, and what each way of
failing to start looks like. Signing in locally needs a development-only mail file, because a sign-in link
is a bearer credential that is never logged and never recoverable from a database that stores it hashed —
that file is refused outright in production.

#### OPS-13 A server administrator can set the platform up from documentation alone

The path from an empty Discord application to a bot answering a student's question is written down,
in order, with what each step is for and how to tell it worked — including which privileged intents
must be enabled, which single value is both the application id and the OAuth client id, what the
platform verifies before it binds a server, and what each way of failing to answer looks like from
the channel. An instructor who has never seen this repository should not need to read its source to
install it.

#### OPS-12 A student-facing failure pages somebody

When the bot stops answering — gateway lost, provider failing, database unreachable — an operator
is notified rather than finding out from an instructor. COST-5 makes it observable; this makes it
noticed.

### 28. Account Linking Across Surfaces

#### LINK-1 An unrecognized person is invited to connect, not answered

The first message from an identity the platform cannot attribute to a connected account is
answered with an invitation to connect, and nothing else. No model call is made and no
allowance is spent. Attribution is therefore complete from the first message rather than
reconstructed later, which is what makes usage across surfaces countable at all.

#### LINK-2 The invitation carries no secret

The reply is the control panel's own address and nothing more. A course channel is public,
so a link carrying a claim token is a token anybody can spend: whoever opens it first binds
their account to that student's identity, and inherits their conversations, their transcript
and their allowance. What travels in public is an address; what proves anything happens
after signing in.

#### LINK-3 Proof is the surface's own sign-in, or a token that never left a private channel

A surface with a sign-in of its own is proven with it — connecting Discord means signing in
with Discord, which proves the account the bot already saw. A surface without one is proven
with a single-use, expiring token delivered where only that caller can read it: the MCP tool
result, or a direct message. A token is never posted where a third party can read it, and an
identity is never bound on a visit alone — the page names the account being connected and
waits to be told to proceed.

#### LINK-4 Connecting merges, and merging never resets

A person exists before they connect, because one is created the first time a course sees
them. Connecting therefore merges two records: identities move to the surviving person,
conversations and transcripts are preserved rather than dropped, and the day's usage is
combined rather than restarted. A merge that handed back a fresh allowance would make
connecting the cheapest way to double it. The operation is idempotent and recorded, because
it rewrites who owns a transcript.

#### LINK-5 One person, one allowance, across every surface

After connecting, a person's daily allowance and conversation follow the person, not the
surface they arrived on. Asking in Discord, in the web chat and through an assistant draws
on one count and continues one conversation, so a cap cannot be evaded by changing surface
and an instructor sees one student rather than three.

#### LINK-6 The connect page names the account and waits to be told to proceed

Arriving at the connect address shows who is about to be connected to what — the account
signed in, the identity being attached, and whether anything will be merged into it — and
does nothing until the person says to. A visit is not consent. The page can describe the
outcome without spending the proof, so a person who followed a link by mistake, or who is
signed in as somebody else on a shared machine, can leave without having changed anything.

#### LINK-7 Connecting Discord is signing in with Discord

The panel's connect flow sends the person to Discord's own authorization screen and
completes on the way back, binding the account that Discord itself asserts — never one the
request claims. The exchange is tied to the browser session that began it, so a link
prepared by one person cannot be finished by another.

#### LINK-8 An assistant is handed its token where only it can read it

A person connects an assistant from the panel, and the token reaches the assistant through
the tool result or a direct message — never a channel, a page, or a log. It is single-use
and short-lived, and the account it will attach to is fixed when it is issued, so a token
that leaks anyway attaches nothing to whoever found it.

#### LINK-10 A connected person can reach the course they connected to, in the browser

Connecting proves who somebody is; it does not make them a member of the institution running
the course. The panel's organization switcher is built from memberships, so a student who has
connected — and who Discord now answers — still opens the web app and sees only their own
personal organization, with no way to reach the course their enrolment lives in. The browser has
to know about the organizations a person is connected into, not only the ones their account
administers, or LINK-6's payoff never arrives on the web surface at all.

#### LINK-9 Nobody who could already ask is locked out by connecting

Introducing the connect requirement must not silently stop answering every student who
already had a working conversation. Whatever the platform does for people who existed
before connecting was required — connect them on their next proven sign-in, admit them
until a deadline, or ask them once — it is a decision made deliberately and written down,
not a consequence of a migration that left a column null.

### 29. Legacy Import

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

### 30. Conversation Core

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

### 31. Model Adapter

#### MDL-1 One package knows the vendor

The Responses API, the shapes it accepts and the errors it raises live in a single adapter
behind the answering core's model port. Nothing else in the platform imports a vendor SDK,
so a second provider — or a self-hosted model for an institution that requires one — is a
new adapter rather than a change to how the bot answers.

#### MDL-2 A stored prompt when the course has one, its own instructions otherwise

A course with a `prompt_id` is answered through that stored prompt, so the two courses
running today behave exactly as they do now. A course without one is answered with the
instructions held in its own record, which is what lets an instructor who has never seen
the OpenAI dashboard write the assistant's persona in the control panel.

#### MDL-8 Instructions are how a course is configured; a stored prompt id is only inherited

MDL-2's stored prompt was a migration affordance for a tenant who already had one in a vendor
dashboard, and it silently wins over everything an instructor types: a course with a `prompt_id`
ignores its own instructions entirely, so FILE-4's versioning, authorship and restore are dead on
exactly those courses and nothing says so. The platform stops offering it. A course that has one
keeps working and keeps being answered through it — nothing is migrated behind an instructor's
back — but the panel says plainly that the stored prompt is in force and that the instructions
below it are not being used, and no new course can acquire one.

#### MDL-3 Answers are grounded in the course's own material

When a course has a vector store, every request enables file search against it, so answers
come from that course's uploaded notes, syllabus and schedule rather than from the model's
general knowledge. A course without one is answered without the tool rather than refused.

#### MDL-4 Continuity is an upstream conversation the platform remembers

The adapter creates the upstream conversation on a person's first turn in a course, seeded
with who they are and which course they are in, and reuses the identifier the platform
stored for every turn after that. Unlike the in-memory map it replaces, this survives a
restart. An identifier the provider no longer recognizes starts a new conversation instead
of failing the turn.

#### MDL-5 Every request is bounded, and a transient failure is retried once

Output is capped, the model comes from the course or a platform default, and a request that
does not return within a timeout is abandoned rather than holding a student's reply open.
A transient failure — a timeout, a rate limit, a 5xx — is retried once; a refusal or an
invalid request is not, because repeating it only spends money to fail again. The token
counts the provider reports are returned for the cost ledger to record.

#### MDL-6 Citation markers never reach a student

The provider's inline source markers are stripped from an answer before it leaves the
adapter, exactly as the running bot strips them today.

#### MDL-7 No test ever calls OpenAI

The provider's base URL is configuration, never a literal in a client, and the test suite
runs against a fake upstream in-process. No test needs an API key, and a test run costs
nothing and reaches no network.

### 32. Discord Surface

#### SURF-1 The bot process holds the only gateway connection

One process connects to the Discord gateway. The API and the background worker reach
Discord over REST with the same token, so there is no inter-process coordination to get
wrong and no second connection competing for the same session. The process is
single-instance by design: two gateway connections on one token is an error rather than
redundancy.

#### SURF-2 Only a direct mention is answered

The bot answers a message that mentions it, ignores its own messages and those of other
bots, and rewrites the mention into a readable name before the question reaches the
model, so the model sees a sentence rather than a numeric reference. What the student
actually typed is what the transcript records.

#### SURF-3 A server that is not bound to an organization is ignored

An incoming message is answered only when its Discord server resolves to an organization
through the binding record. A message from an unbound server is logged and dropped
rather than answered, so a bot added to a server by someone who has not installed it
through the platform does nothing at all.

#### SURF-4 A person is recognized by their Discord account

The author's snowflake resolves to a person in that organization, and to a new person and
identity the first time they are seen. The bot therefore fills its own roster as students
arrive, and a student who later reaches the same course from the web is the same person
with the same history.

#### SURF-5 The answer is a reply, and a long answer is split rather than lost

The bot replies to the message it is answering, so a busy channel stays legible. An answer
longer than Discord's message limit is split on a boundary that keeps it readable and sent
in order, rather than truncated or dropped by the platform.

#### SURF-6 Every outcome reaches the student or the log, and none reaches neither

Each outcome the answering core can return has a rendering: an answer, an answer carrying
the day's-last notice, a refusal when the allowance is spent, an apology when the model
fails, and — for a course configured to answer nothing, or a message that matches no
course — a log line naming the cause rather than a silent drop the instructor cannot see.

#### SURF-7 The process starts, reports its health, and stops cleanly

The bot exposes a health endpoint that reports whether the gateway is connected, so a
supervisor can tell "running" from "connected". On shutdown it closes the gateway and the
database rather than leaving the socket to time out, and it refuses to start on an
environment that does not validate.

### 33. HTTP API

#### API-1 Routes carry, they do not decide

A route validates nothing, authorizes nothing and writes nothing itself: it turns a request
into an action dispatch and the result into a response. Every rule about who may do what
therefore lives in one place, and a second surface — the MCP server, a future mobile
client — reaches the same rules without a route to copy.

#### API-2 The session is a cookie the browser cannot read

A session token travels in an HttpOnly, Secure, SameSite cookie, scoped to the site, and is
rotated when a sign-in succeeds. Nothing hands the token to JavaScript, so a cross-site
script cannot read it, and signing out revokes the session rather than only clearing the
cookie.

#### API-3 A state-changing request must come from the site

Every non-GET request is checked against its origin before it reaches an action, and one
that does not match is refused without being dispatched. Cookies are sent by the browser
whatever page asked for the request, so the origin check is what stands between a student's
authenticated session and a form on somebody else's site.

#### API-4 One place turns a failure into a status

Typed errors from the action layer are mapped to HTTP statuses by a single middleware, and
no route maps its own. A refusal is the same status and the same body whether the record is
missing or belongs to another organization, so the API discloses no more than the action
layer does.

#### API-5 The API reaches Discord over REST, never the gateway

The API process opens no gateway connection: that is the bot's alone. Anything the API needs
from Discord it does over REST with the same token, so there is no second connection to
coordinate and no session to lose.

#### API-6 The process reports readiness honestly

The API answers a health check with whether it can actually serve — that its configuration
validated and its database is reachable — rather than merely that the process is running,
and it shuts down by closing the server and the database rather than exiting under load.

### 34. Web Control Panel

#### WEB-1 The panel is a static build

The control panel is a static bundle served by nginx, talking to the API over the same
origin. It runs no server of its own, so there is no third process to deploy, and the API
is the only thing that ever touches the database.

#### WEB-2 Signing in happens in the browser, and the session never does

A visitor signs in with an emailed link or with Google, and the session cookie is set by
the API and never read by JavaScript. Nothing in the bundle stores a token, so there is
nothing for a cross-site script to steal, and signing out ends the session on the server
rather than only in the tab.

#### WEB-3 The panel always knows which organization it is acting in

A signed-in account may belong to several organizations. The panel shows which one it is
acting in and carries that organization in every request, so a person who teaches in two
places cannot act in one while believing they are in the other.

#### WEB-4 Installing the bot is one button, and its outcomes are honest

Installing starts the platform's own OAuth flow and reports what actually happened: bound,
refused because the account does not administer that server, or refused because the server
belongs to somebody else — without saying who. A server already installed shows as
installed, with the option to remove it.

#### WEB-5 A failure reads the way the API reported it

A refusal reads as not found, a validation failure names the field that was wrong, and
nothing renders a stack trace, an internal message or an identifier the caller has no use
for. The panel adds no interpretation the API did not give it.

#### WEB-6 The bundle contains no server code and no secret

The browser bundle imports only the shared schema package from the workspace. The data,
configuration, Discord and model packages are unreachable from it by lint rule, because
bundling any of them would ship credentials to every visitor.

#### WEB-7 Projects are managed in the panel

An instructor lists their projects, creates one, archives and restores one, and duplicates
one into the next term — each through the same action the API exposes to anything else. A
duplicated project's courses arrive disabled, and the panel says so rather than leaving the
instructor to discover it when nothing routes.

#### WEB-8 A course is defined in the panel, not in a file

A course's title, its Discord role names, its categories and channels, its instructions and
its model settings are all editable in the panel, and saving writes them through the
platform's own action. Nothing about a course requires editing a file in this repository or
restarting a process, which is the whole point of the migration.

#### WEB-9 The panel shows what will route, and why a save was refused

A course screen shows the category and role names that decide which questions reach it, so
an instructor can see what a save will claim before making it. A save refused because those
names collide with another course names that course and its project, because that refusal is
about a record in the instructor's own organization and is theirs to resolve.

#### WEB-10 Chat renders Markdown, and renders it safely

Messages in the web chat render standard Markdown — headings, emphasis, lists, links, and
fenced code blocks with their formatting intact, which is what makes a programming course's
answers readable. The text being rendered is model output and student input, so raw HTML in
it is never passed through, links carry no script scheme, and nothing reaches the page
through an unsanitized HTML sink. A chat surface that renders assistant output as HTML is
the shortest path to a student's session, and WEB-6 exists to keep that path closed.


#### WEB-11 One styling system, not several

The panel is styled with Tailwind CSS and nothing else: no parallel stylesheet, no
component library with its own opinions, no hand-rolled utility classes competing with the
framework's. A second system is how a two-screen app becomes one that looks like two
applications, and the divergence is invisible until somebody sees two pages side by side.

#### WEB-12 One icon set, used to mean something

Icons come from Lucide React, and each recurring intent keeps the same icon everywhere it
appears — editing, deleting, disabling, adding, removing from a list. An icon never carries
meaning alone: every icon-only control has an accessible name, because an icon is a
reminder for people who already know what it does and nothing at all for a screen reader.

#### WEB-13 The panel works on the screen a person actually has

The layout is responsive from a phone to a desktop. Nothing requires horizontal scrolling
to reach a control, no table becomes unusable by narrowing, and the navigation collapses
rather than overflowing. Instructors do this work on a laptop and check it on a phone, and
a course that cannot be enabled from a phone is a course that waits until Monday.

#### WEB-14 A conventional application shell

A fixed header carries the main navigation — a menu control that opens it on narrow
screens, with a home control beside it — and a fixed footer carries the standard links and
the information a person expects to find there. Content lives between them and scrolls
independently. This is the shape people already know; a control panel is not the place to
teach somebody a new one.

#### WEB-15 A primary action looks different from a secondary one

Each screen makes plain which action it expects — one primary call to action, visually
distinct from the secondary ones — and destructive actions are distinguishable from both.
Archiving a term and deleting one must never look alike.

#### WEB-16 Forms say what they want and what went wrong

Every field has a visible label, related fields are grouped, and a refusal names the field
it concerns and appears next to it rather than only at the top. A form that reports "invalid
input" for a course with fourteen fields has told the instructor nothing.

#### WEB-19 A course's instructions are edited as revisions, and their history is visible

FILE-4 says each save of a course's instructions is a revision with an author and a time, so an
instructor can see what the assistant was told last week and restore it — and
`courseInstructions.save` and `.restore` exist and do exactly that. The panel calls neither: the
course form writes `instructions` as a plain field through `courses.save`, so every edit
overwrites the last with no revision, no author and nothing to restore. Editing instructions on a
live course is the operation FILE-4 was written to make safe, and it is the one the panel makes
unsafe. The instructions editor saves through the versioned action, shows who changed what and
when, and restores a previous revision — which is itself a new revision, because history that can
be rewritten is not history.

#### WEB-20 A course's join links are issued and copied from the panel

ENRL-3 and ENRL-4 give a course shareable join links that are revocable and optionally expiring,
and the actions to create and revoke them exist, but no screen ever offered either — so the one
way to admit a student who is not already carrying a Discord role does not exist in practice. The
course screen issues a join link, shows its full URL once at creation with a control that copies
it, and lists the links a course currently has with when each expires and whether it is revoked.
The secret is shown once and never again, because it is stored only as a hash and the panel cannot
recover what it did not keep. Revoking is behind a confirmation and says plainly what it does and
does not do: it stops the link admitting anyone new, and it un-enrols nobody who already redeemed
it.

#### WEB-21 A roster is imported from the panel, with its format stated on the screen

ROST-9 through ROST-12 parse an instructor's roster CSV, enrol each row and report what could not
be done, and `roster.import` enqueues that job — but no screen ever offered it, so the capability
was reachable only by dispatching an action by hand. The course screen takes a roster through a
large drop zone that also accepts a click, and states the file's required format on the screen
rather than in documentation the instructor does not have open: the five columns it reads, which
are required and which may be blank, and a worked example row. The screen shows the import's
progress while it runs and its report when it finishes, including every row that could not be
parsed with the line number it was on, so a spreadsheet can be corrected and re-uploaded. Re-
importing the same roster admits nobody twice.

#### WEB-23 A join link's expiry is chosen when it is issued

ENRL-3 gives a join link an optional expiry and `courseJoinLinks.create` accepts one, but no screen
offers it, so every link the panel issues never expires. WEB-20 requires the links list to show
"when each expires" — a column that can only ever read "No expiry", which is not information. A
link handed to a class at the start of term should be able to stop admitting people at the end of
it without an instructor having to remember to revoke it. The creation screen offers an expiry,
defaulting to none so the existing behaviour is what an instructor gets by not choosing, and the
list shows what was chosen.

#### WEB-22 A course's people are visible in the panel, and admission is reversible there

ENRL-2's enrolment relation decides who may ask a course, ENRL-6 ends an enrolment and ENRL-9
reinstates one — and no screen shows any of it. `enrolments.end` has existed as an action with no
surface, so removing a student has only ever been possible by dispatching an action by hand, and
the repo cannot even list the people an instructor would be choosing between: `listPeopleForCourse`
returns active enrolments only, so a person who was ended is invisible to every query the panel
could make. The course screen lists the people enrolled in that course and the ones whose enrolment
has ended, says how each was admitted — a join link, a roster row, or a Discord role — and lets an
instructor end an active enrolment or reinstate an ended one. Ending is behind a confirmation that
says what it does and does not do: it stops that person asking this course, and it deletes neither
their transcript nor the course's record of what was asked (ENRL-6).

#### WEB-18 A course's knowledge files are managed in the panel

FILE-1 says an instructor attaches a course's notes, syllabus and schedule in the panel, and the
action layer, the upload job and the provider round trip all exist — but no screen ever offered
it, so the capability was reachable only by dispatching an action by hand. The course screen lists
what a course is grounded in, takes an upload, shows each file as pending, ready or failed, and
detaches one behind a confirmation, because detaching reaches the provider and cannot be undone.
An instructor never sees a vector store id: the store is the platform's own bookkeeping, and
showing it would be the vendor-dashboard workflow FILE-1 exists to replace.

#### WEB-17 The panel is usable from the keyboard

Every control is reachable and operable by keyboard, focus is always visible, and the
contrast of text and controls meets WCAG AA. The panel is administrative software used
daily by people whose institutions require this, and retrofitting it costs more than
building it in.
