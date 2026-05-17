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
├── ecosystem.config.js       # pm2 process config
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
└── results/                  # Output: merged roster+questionnaire CSV files
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

## Running on a server with pm2

[pm2](https://pm2.keymetrics.io/) keeps `response_bot.py` running in the background, restarts it on crash, and survives server reboots.

### Install pm2

```bash
npm install -g pm2
```

### Start the bot

**Quick start:**

```bash
pm2 start response_bot.py --interpreter python3 --name bloombot
```

**Recommended — using the ecosystem config:**

```bash
pm2 start ecosystem.config.js
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
