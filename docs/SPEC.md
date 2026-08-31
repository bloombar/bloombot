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

The bot runs under pm2 in production, configured by `ecosystem.config.js`, which names
the process `bloombot`, runs `response_bot.py` under `python3`, and directs pm2's own
stdout and stderr to timestamped files in `logs/`. pm2 restarts the bot on crash, and
`pm2 save` plus `pm2 startup` make it survive a host reboot. No secrets are placed in the
pm2 config; the bot loads `.env` itself.

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
