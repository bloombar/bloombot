# Running the full stack locally

How to get the platform running on your own machine and see it in a browser: sign in, install the bot into
a Discord server, create a project, define a course, and have the bot answer.

This is the **TypeScript platform**, not the Python bot. They can run side by side — see
[Sharing a database with the Python bot](#sharing-a-database-with-the-python-bot).

## What runs

| process | what it is | needed for |
| --- | --- | --- |
| **API** (`apps/api`) | Express, port 3000 | everything — the panel talks only to this |
| **Web** (`apps/web`) | Vite dev server, port 5173 | the browser UI |
| **Bot** (`apps/bot`) | the Discord gateway connection | answering messages in Discord |
| **Worker** (`apps/worker`) | background jobs | later phases; not needed to browse |

The API and the web dev server are enough to sign in and click around. Add the bot when you want a question
in Discord answered.

## 1. Install and build

```bash
npm ci
npm run build
```

## 2. Configuration

Copy the template and fill it in:

```bash
cp env.example .env
```

`.env` is gitignored and a hook blocks writes to it — nothing in this repository will edit it for you.

### What you can reuse from the Python bot's `.env`

| variable | reuse? |
| --- | --- |
| `BOT_TOKEN` | **yes** — the same bot, the same token |
| `OPENAI_API_KEY` | **yes** |
| `BOT_APP_ID` | **yes** if present; otherwise the application id from the Discord developer portal |
| `BOT_PERMISSIONS` | **yes** if present |
| `SQL_LITE_DB_PATH` | leave as is — the Python bot still reads it |

### What is new

| variable | what to put in it |
| --- | --- |
| `DISCORD_CLIENT_SECRET` | **new.** Developer portal → your application → OAuth2 → Client Secret. The Python bot never did OAuth, so this will not exist in the old file. |
| `PUBLIC_APP_URL` | `http://localhost:5173` locally. The API checks every non-GET request's `Origin` against it, so a mismatch here shows up as a 403 on every save. |
| `DATABASE_PATH` | **the platform's own database.** See the warning below. |
| `API_PORT` / `BOT_HEALTH_PORT` | `3000` / `3001` unless those are taken |
| `NODE_ENV` | `development` |
| `MAIL_FILE` | `tmp/mail.jsonl` — see [Signing in](#4-sign-in) |
| `GOOGLE_CLIENT_ID` | only if you want the Google sign-in button to work; the email link works without it |

> **Do not point `DATABASE_PATH` at `data/data.db`.** That file holds real students' names, emails and
> conversation transcripts. Use `DATABASE_PATH=./tmp/local.db` for ordinary local work. A hook blocks writes
> to `data/*.db`, and `npm run db:migrate` refuses a path under `data/` without an explicit flag — both are
> there because the mistake is easy and irreversible.

Also add the OAuth redirect in the developer portal (OAuth2 → Redirects) so installing works locally:

```
http://localhost:5173/discord/callback
```

## 3. Start it

Three terminals, or one with `&`:

```bash
npm run api:dev     # http://localhost:3000
npm run web:dev     # http://localhost:5173
npm run bot:dev     # only when you want Discord answered
```

The migration runs automatically at API start, so there is no separate database step for a fresh `tmp/`
file.

**Check it worked:**

```bash
curl -s localhost:3000/health     # {"status":"ready",...}
curl -s localhost:3001/           # the bot's gateway health, once the bot is running
```

The bot's endpoint distinguishes *running* from *connected* — a process that is up with a dead gateway is
the state that otherwise looks healthy from outside.

## 4. Sign in

Open <http://localhost:5173> and enter any email address. Nothing is actually emailed, so read the link out
of the mail file:

```bash
tail -1 tmp/mail.jsonl | python3 -c 'import json,sys; print(json.load(sys.stdin)["body"])'
```

Paste that link into the browser. You are signed in, with a personal organization named after your address.

**Why a file rather than a log line:** a sign-in link is a bearer credential — redeeming one yields a
thirty-day session — so the ordinary stand-in logs only the recipient and subject, never the link, and
tokens are stored hashed so a link cannot be recovered from the database either. `MAIL_FILE` is the
development-only way in. It is refused outright when `NODE_ENV=production`, whether or not it is set.

`tmp/mail.jsonl` holds live credentials for as long as its tokens are valid (fifteen minutes). It is
gitignored; treat it like a mailbox.

## 5. Install the bot into a Discord server

In the panel: **Discord → Install to Discord**, pick a server you administer, approve.

The platform checks that you genuinely administer that server — owner, or Manage Server — by asking
Discord, not by trusting the request. A server already bound to another organization is refused, and the
refusal deliberately says nothing about who holds it.

Full walkthrough, including the Discord-side roles and categories:
[docs/DISCORD_SETUP.md](DISCORD_SETUP.md).

## 6. Create a project and a course

**Projects → Create project**, then add a course. The fields that decide whether anything answers:

- **category names** — the primary routing signal, matched against the Discord category a question arrives in
- **role names** — the fallback, matched against the author's Discord roles
- **instructions** — what the assistant is told; a course with neither instructions nor a prompt id answers nobody, on purpose

Save, then **enable** the course. Mention the bot in a channel inside one of its categories.

## Running the tests

```bash
npm test              # unit and integration; no network, no API key needed
npm run e2e           # Playwright: a real browser against a real API and database
npm run test:coverage
```

`npm run e2e` needs a browser once: `npx playwright install chromium`.

## Sharing a database with the Python bot

Both systems can read the same SQLite file during the migration: the Python bot reads `SQL_LITE_DB_PATH`,
the platform reads `DATABASE_PATH`, and they must name the same file for that to work (D-9 records why
there are two names). For local development, do not do this — point the platform at `tmp/` and leave the
Python bot alone.

To work with real data, take a **copy** and import it:

```bash
cp data/data.db tmp/snapshot.db          # a copy, never the live file
npm run legacy:import --workspace packages/legacy-import -- tmp/snapshot.db bot_config.yml
```

The importer refuses a path that resolves into this repository's `data/`, with no override on the source
side — an import that can only ever run against a snapshot can be rehearsed as many times as it takes.

## When something does not work

| symptom | cause |
| --- | --- |
| every save fails with 403 | `PUBLIC_APP_URL` does not match the address in your browser's bar |
| API exits at startup naming a variable | that variable is missing from `.env`; the process refuses to start on an environment it cannot validate rather than failing later |
| sign-in email "sent" but no link anywhere | `MAIL_FILE` is not set — the fallback logs only the recipient and subject |
| bot connects but never answers | the **Message Content Intent** is off in the developer portal; Discord then withholds message text entirely |
| the bot answers nothing in a category you configured | the course is disabled, its project is archived, or the category name does not match exactly |
| `npm ci` fails on a lockfile mismatch | run `npm install` and commit the lockfile — a new workspace package was added without it |
