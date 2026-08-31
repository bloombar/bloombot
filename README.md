# Bloombot — AI Course Assistant

An AI-powered Discord bot and server management toolkit for university courses. Bloombot answers student questions via OpenAI Assistants and gives instructors a set of automation scripts for setting up and managing their Discord server.

## Components

1. **AI Chatbot** (`response_bot.py`) — listens for student messages on Discord, forwards them to a course-specific OpenAI Assistant, and replies in the same channel. Each course can be wired to a different Assistant with its own uploaded course notes, instructions, and per-user daily request limits.

2. **Server management utilities** — scripts and notebooks that create server categories and channels, merge student rosters with questionnaire responses, and manage Discord roles and permissions.

3. **Analytics** (`analytics.ipynb`) — Jupyter notebook that queries the message log database and produces charts on message volume, user engagement, conversation patterns, and AI-powered topic classification.

---

## Repository structure

```text
bloombot/
├── response_bot.py           # Discord bot — listens and replies via OpenAI
├── hydrate_server.py         # One-time server scaffolding (categories + channels)
├── roster_create_channels.py # Creates per-student private channels from a CSV roster
├── main.py                   # CLI for listing/creating/deleting servers, categories, channels
├── migrate.py                # Database migration — drops, creates, and optionally seeds tables
├── discord_manager.py        # Core DiscordManager class (used by all scripts above)
├── analytics.ipynb           # Conversation analytics notebook
├── roster_setup.ipynb        # Merges roster CSV + questionnaire CSV into a results CSV
├── bot_config.yml            # Per-course configuration (Assistant IDs, roles, categories)
├── ecosystem.config.cjs       # pm2 process config
├── Pipfile / Pipfile.lock    # Python dependencies (managed by pipenv)
├── requirements.txt          # Flat requirements list (alternative to Pipfile)
├── env.example               # Template for required environment variables
├── data/
│   ├── data.db               # SQLite database — logs all bot messages and users
│   └── topic_classifications.json  # Cached OpenAI topic labels for analytics
├── models/
│   ├── base.py               # Peewee base model (shared DB connection)
│   ├── user.py               # User model (discord_id, username, email, etc.)
│   └── message.py            # Message model (content, category, channel, direction)
├── questionnaires/           # Input: intake questionnaire CSV files (one per course)
├── rosters/                  # Input: student roster CSV files (one per course)
├── results/                  # Output: merged roster+questionnaire CSV files
├── tests/                    # pytest suite (see "Tests" below)
├── docs/
│   ├── SPEC.md               # Requirements — the source the project board is built from
│   └── ROADMAP.md            # Delivery phases and current status
├── scripts/board/            # Derives and syncs the GitHub project board from the SPEC
├── scripts/deploy.sh         # Server-side deploy, run on the droplet by CI
└── .github/workflows/ci.yml  # Tests and continuous deployment
```

---

## Local setup

### Prerequisites

- Python 3.12
- [pipenv](https://pipenv.pypa.io/) (`pip install pipenv`)
- A Discord application and bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An OpenAI API key (for the chatbot and analytics topic classification)

### 1. Install dependencies

```bash
pipenv install
```

To also install the Jupyter kernel needed for the notebooks:

```bash
pipenv install --dev
```

### 2. Configure environment variables

Copy the example file and fill in your credentials:

```bash
cp env.example .env
```

```env
BOT_APP_ID=your_bot_app_id
BOT_PUBLIC_KEY=your_bot_public_key
BOT_TOKEN=your_bot_token
BOT_PERMISSIONS=your_bot_permissions_integer
OPENAI_API_KEY=your_openai_api_key
```

`BOT_TOKEN` must belong to a bot with at least `MANAGE_CHANNELS` permissions. All scripts load `.env` automatically via `python-dotenv`.

### 3. Initialise the database

```bash
pipenv run python migrate.py
```

This creates `data/data.db` with the `users` and `messages` tables. Pass `--help` for all options:

```bash
# Drop and recreate tables (default behaviour):
pipenv run python migrate.py

# Keep existing tables, just seed with mock data:
pipenv run python migrate.py --no-drop --no-create --populate
```

| Flag          | Effect                           |
|---------------|----------------------------------|
| `--no-drop`   | Skip dropping existing tables    |
| `--no-create` | Skip creating tables             |
| `--populate`  | Seed the database with mock data |

### 4. Configure courses

Edit `bot_config.yml` to define your Discord server and courses. Each course entry specifies:

- `title` — human-readable course name
- `file_prefix` — short prefix used to match roster/questionnaire CSV files (e.g. `wd`, `py`)
- `openai_assistant` — Assistant ID, Prompt ID, vector store ID, system instructions, model, and per-user daily request limit
- `roles` — Discord role names for admins and students of this course
- `categories` — Discord category names (and optionally named channels within each) for this course

---

## Scripts

Make scripts executable once with:

```bash
chmod u+x *.py
```

### `response_bot.py` — AI chatbot

Connects to Discord and responds to student messages using the OpenAI Assistants API. Course routing, rate limits, and system prompts are all driven by `bot_config.yml`.

```bash
pipenv run ./response_bot.py
```

Logs are written to `logs/response_bot.log`.

### `hydrate_server.py` — server scaffolding

Creates the category and channel structure in the Discord server for all courses defined in `bot_config.yml`. Sets role-based permissions (admins and students) on each category. Run once before adding students.

```bash
pipenv run ./hydrate_server.py
```

### `roster_create_channels.py` — per-student channels

Reads a merged roster/questionnaire CSV from `results/` and creates a private channel for each student, with permissions scoped to that student and the course's admin role. Run after `hydrate_server.py` has created the category structure.

```bash
pipenv run ./roster_create_channels.py
```

### `main.py` — Discord CLI

General-purpose command-line tool for inspecting and modifying a Discord server.

```bash
pipenv run ./main.py --help
pipenv run ./main.py --show-servers
pipenv run ./main.py --server "Server Name" --show-categories
pipenv run ./main.py --server "Server Name" --show-channels
pipenv run ./main.py --server "Server Name" --create-category "New Category"
pipenv run ./main.py --server "Server Name" --category "Cat Name" --create-channel "new-channel"
pipenv run ./main.py --server "Server Name" --delete-channel 123456789
```

### `migrate.py` — database migration

Manages the `data/data.db` SQLite database schema. See [step 3](#3-initialise-the-database) above.

---

## Notebooks

Open notebooks inside the pipenv environment:

```bash
pipenv run jupyter notebook
```

Or register the pipenv kernel so notebooks can be opened in VS Code or JupyterLab:

```bash
pipenv run python -m ipykernel install --user --name bloombot
```

### `roster_setup.ipynb` — roster merge

Merges a student roster CSV (from `rosters/`) with a questionnaire responses CSV (from `questionnaires/`) so that student email addresses and Discord usernames end up in a single output file. Configure the input filenames at the top of the notebook and run all cells. The combined CSV is saved to `results/`.

Sample input files are provided in `rosters/` and `questionnaires/`; sample output files are in `results/`.

### `analytics.ipynb` — conversation analytics

Reads `data/data.db` and produces a full analytics report across five sections:

1. **Load & Prepare** — Joins messages with users; derives course name, channel type, and semester from the raw Discord category string.
2. **Message Overview** — Bar charts of total message volume by course, by course+semester, and by channel type; weekly activity line chart; top-15 users and per-user message distribution.
3. **Conversations** — Groups messages into conversations using a configurable silence gap (default 30 min); charts conversations per course, conversation length distribution, and conversations per user.
4. **Topic Classification** — Classifies each conversation into a topic (e.g. "Assignments & homework", "Technical setup & tools") using `gpt-4o-mini`; results are cached in `data/topic_classifications.json` so re-running the notebook does not re-classify conversations already processed; produces an overall topic bar chart, per-course stacked bar, per-course-per-semester grouped bar, unique-users heatmap, and conversation-length box plot by topic.
5. **Summary Table** — Pivot table of conversations, unique users, average messages per conversation, and average duration by course, semester, and topic.

**Note:** Section 4 requires `OPENAI_API_KEY` in `.env`. All other sections work without an API key.

---

## Tests

The project has two independent suites, both run by CI on every push and pull request,
alongside a `shellcheck` pass over `scripts/deploy.sh` (see `.github/workflows/ci.yml`).
All three must pass before a merge to `master` is deployed.

**Python** — covers the chatbot's course routing and rate-limit accounting, the
`DiscordManager` lookup helpers, roster path and welcome-message formatting, the database
migration, and `scripts/deploy.sh` (run for real against throwaway git repositories, with
`pm2` and `pipenv` replaced by stubs):

```bash
pipenv install --dev
pipenv run pytest tests/ -v
```

Tests never touch real credentials or `data/data.db`: `tests/conftest.py` overrides
`OPENAI_API_KEY`, `BOT_TOKEN`, `SQL_LITE_DB_PATH` and `LOGS_DIR` with throwaway values
before any module is imported, overriding your `.env`. No test makes a network call.

**Node** — covers the project-board tooling and the `docs/SPEC.md` format contract that
the board is generated from:

```bash
npm install
npm test
```

---

## Project board

Requirements live in [`docs/SPEC.md`](docs/SPEC.md) and are delivered in phases defined
in [`docs/ROADMAP.md`](docs/ROADMAP.md). The
[project board](https://github.com/users/bloombar/projects/2) is generated from those two
documents — never by hand:

```bash
npm run board:derive     # SPEC + ROADMAP -> scripts/board/manifest.yaml
npm run board:sync:dry   # preview the changes
npm run board:sync       # push issues, milestones and cards to GitHub
```

`board:sync` needs the `gh` CLI authenticated with the `project` scope. Both scripts are
idempotent: re-running them updates in place rather than creating duplicates. Requirement
ids key the issues, so an existing id must never be renamed or renumbered.

---

## Running on a server with pm2

[pm2](https://pm2.keymetrics.io/) keeps `response_bot.py` running in the background, restarts it on crash, and survives server reboots.

### Install pm2

```bash
npm install -g pm2
```

### Start the bot

**Quick start:**

```bash
pm2 start pipenv --name bloombot -- run ./response_bot.py
```

The bot must run through `pipenv`: its dependencies live in the project's virtualenv, and
the system `python3` generally cannot import `discord.py` at all.

**Recommended — using the ecosystem config:**

```bash
pm2 start ecosystem.config.cjs
```

Environment variables are loaded from `.env` automatically by the bot.

### Persist across reboots

Run these once after first starting the bot:

```bash
pm2 save      # saves the current process list
pm2 startup   # prints a shell command to enable autostart — copy and run it
```

### Common commands

```bash
pm2 status                  # show running processes
pm2 logs bloombot           # stream live logs
pm2 restart bloombot        # restart the bot
pm2 stop bloombot           # stop the bot
pm2 delete bloombot         # remove from pm2's process list
```

---

## Continuous deployment

Merging to `master` deploys the bot. GitHub Actions runs the full test suite and, only if
it passes, connects to the droplet over SSH and updates it to that exact commit
(`.github/workflows/ci.yml` → `scripts/deploy.sh`).

### What a deploy does

1. **Refuses to overwrite hand edits.** If a tracked file — `bot_config.yml`, say — was
   edited directly on the server, the deploy aborts and prints the diff. Commit the change
   or revert it, then re-run.
2. **Updates the checkout** to the deployed commit with `git fetch` + `git reset --hard`.
   Untracked files are never touched: `.env`, `data/*.db` and `logs/` come through
   unchanged, and `git clean` is deliberately never run.
3. **Installs dependencies only if they changed** — that is, if `Pipfile.lock` or
   `requirements.txt` differ between the old and new commit. It uses pipenv if the droplet
   has a pipenv virtualenv, and pip otherwise.
4. **Checks the interpreter pm2 uses can import the bot's dependencies** *before*
   restarting, so a broken environment fails while the old process is still serving.
5. **Reloads pm2** (`pm2 reload bloombot --update-env`, or `pm2 start ecosystem.config.cjs`
   the first time), then `pm2 save`.
6. **Watches the process for 15 seconds.** If it is not `online`, or pm2 had to restart it
   again in that window — a crash loop — the deploy **rolls back** to the previous commit,
   restarts it, and fails the workflow run.

`migrate.py` is never run by a deploy: it drops and recreates tables. Run schema changes by
hand.

### One-time setup

The commands below use shell variables so nothing about a particular server is written
down here. Set them for your droplet first — they are the same three values you will put
into the repository's GitHub variables:

```bash
export DEPLOY_HOST=<droplet ip or hostname>
export DEPLOY_USER=<the unix user the bot runs as>
export DEPLOY_PATH=/home/$DEPLOY_USER/discord-channel-manager
```

On your machine, create a deploy key and register it with the droplet:

```bash
ssh-keygen -t ed25519 -f bloombot_deploy -C "github-actions-bloombot" -N ""
ssh-copy-id -i bloombot_deploy.pub $DEPLOY_USER@$DEPLOY_HOST

# The droplet's host keys, for DEPLOY_KNOWN_HOSTS. 2>/dev/null drops the `#`
# banner lines, leaving just the three key lines to paste — all of them.
ssh-keyscan -t rsa,ecdsa,ed25519 $DEPLOY_HOST 2>/dev/null
```

`ssh-keyscan` trusts whatever answers on port 22, so confirm the keys are really the
droplet's before pinning them. On the droplet (through the DigitalOcean web console, not
over SSH) run `for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done`, and
compare against
`ssh-keyscan -t rsa,ecdsa,ed25519 $DEPLOY_HOST 2>/dev/null | ssh-keygen -lf -`.

Then in the repository's GitHub settings:

| Where | Name | Value |
| --- | --- | --- |
| Variables | `DEPLOY_HOST` | the droplet's IP or hostname |
| Variables | `DEPLOY_USER` | the unix user the bot runs as |
| Variables | `DEPLOY_PATH` | the checkout's absolute path, if it is not `$HOME/discord-channel-manager` |
| Environment `production` → secrets | `DEPLOY_SSH_KEY` | contents of `bloombot_deploy` (the private key) |
| Environment `production` → variables | `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` output — a variable, not a secret: host keys are public, and an unmasked value keeps a fingerprint mismatch readable in the log |

The host key is pinned through `DEPLOY_KNOWN_HOSTS` rather than trusted on first sight. The
secrets belong to the `production` environment, and the deploy job only runs on pushes to
`master`, so a pull request — including one from a fork of this public repo — can never
reach the key. Adding required reviewers to the `production` environment turns every deploy
into an approval click.

Finally, confirm the droplet's checkout is clean and points at this repo:

```bash
ssh $DEPLOY_USER@$DEPLOY_HOST 'cd $DEPLOY_PATH && git remote -v && git status --porcelain'
```

### Rolling back

Run the **CI** workflow manually (Actions → CI → Run workflow) on `master` with
**deploy_sha** set to the full SHA of the last good commit. The same script deploys it and
the same health check guards it.

To deploy or roll back without GitHub, pipe the script in yourself:

```bash
ssh $DEPLOY_USER@$DEPLOY_HOST 'bash -s -- <commit-sha>' < scripts/deploy.sh
```

### Checking a deploy

```bash
ssh $DEPLOY_USER@$DEPLOY_HOST 'cd $DEPLOY_PATH && git rev-parse HEAD'
ssh $DEPLOY_USER@$DEPLOY_HOST 'pm2 status && pm2 logs bloombot --lines 50 --nostream'
```
