# Deploying to a single DigitalOcean droplet

The path from an empty droplet to the full platform answering a student's question in
production: one box, pm2 supervising five processes (OPS-8), nginx in front of them
terminating TLS and serving the built control panel as static files (PLAT-4), and the
existing CI deploy job keeping it updated.

This is the deployment this repository's own tooling already assumes — `scripts/deploy.sh`,
`ecosystem.config.cjs` and `.github/workflows/ci.yml`'s `deploy` job are written for exactly
this shape. This document is what to do once, by hand, before that automation has anything to
update.

**Read this alongside, not instead of:**

- [docs/DISCORD_SETUP.md](DISCORD_SETUP.md) — the Discord application, step by step, with how
  to tell each step worked.
- [docs/CUTOVER.md](CUTOVER.md) — rehearsing and running the legacy import, retiring the
  Python bot, rotating credentials, and what "notified" means (OPS-9, OPS-10, OPS-11, OPS-12).
  Do not duplicate those steps from here; this document gets a fresh droplet ready to receive
  them.
- [README.md](../README.md)'s own "Running on a server with pm2" and "Continuous deployment"
  sections — the pm2 and CI mechanics this document's own steps rely on.

> ## Read this first: there is no production email transport yet
>
> Signing in to the control panel is by emailed link (`packages/auth`) or Google. **This
> codebase ships no real `EmailSender` implementation** — `packages/auth/src/email.ts`'s own
> module comment says so directly ("this package ships the interface and a recording fake for
> tests, never a real mail transport... a later slice's adapter package"), and
> `apps/api/src/logging-email-sender.ts#buildEmailSender` **refuses to start `apps/api` at all
> in `NODE_ENV=production`** rather than pretend to send anything. This is not a configuration
> gap this document can close by naming an SMTP host — nothing in the codebase reads one. Until
> a real `EmailSender` adapter is built (a scoped slice of its own; do not improvise one just
> to get a deploy working — see this document's own §7), `apps/api` will not start with
> `NODE_ENV=production` set, and email sign-in has no working path in production at all. Google
> sign-in (§4.3) does not depend on this and is unaffected. Report this rather than route
> around it if you hit it.

---

## 1. Choose and provision the droplet

**Sizing.** This is a single-writer SQLite deployment (D-2) — the constraint is not CPU, it is
one disk holding one file five processes share. A **2 vCPU / 4 GB** droplet (DigitalOcean's
"Basic" or "General Purpose" tier) comfortably runs pm2's five Node processes, the Python bot
during the migration window (docs/CUTOVER.md), and nginx, for the class sizes this platform
was built for (docs/ROADMAP.md/docs/SPEC.md's own scope — a handful of courses, not thousands
of concurrent students). Attach a **block storage volume** if the student body is large enough
that the SQLite file plus course attachments plus logs will meaningfully outgrow the droplet's
own boot disk over a term — mount it once, then point `DATABASE_PATH`/`ATTACHMENT_STORAGE_DIR`/
`LOGS_DIR` at paths under it (§3).

**OS.** Ubuntu 24.04 LTS (or whatever current LTS `ssh-keyscan`/the rest of this repository's
own tooling is exercised against) — the same assumption `scripts/deploy.sh`'s own use of
`pipenv`/`pm2`/`git` on `$PATH` already makes.

**Networking.** Open `22` (SSH), `80` and `443` (nginx) in the droplet's firewall. Nothing else
needs to be reachable from outside the box — every process's own port (`API_PORT`,
`BOT_HEALTH_PORT`, `WORKER_HEALTH_PORT`, `MCP_PORT`) binds `127.0.0.1` only, by each process's
own explicit choice (`apps/*/src/index.ts`'s own module comments), so nginx is the only thing
with a public listener besides SSH.

## 2. Install the runtime dependencies

```bash
# Node 22 (nodesource, or your own preferred method — must match package.json's engines.node)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2, globally
sudo npm install -g pm2

# Python 3.12 + pipenv, for response_bot.py during the migration window (docs/CUTOVER.md)
sudo apt-get install -y python3.12 python3.12-venv python3-pip
pip install --user pipenv

# nginx, and certbot for TLS
sudo apt-get install -y nginx certbot python3-certbot-nginx

# sqlite3 CLI, for the backup step in §8
sudo apt-get install -y sqlite3
```

## 3. Clone the checkout and configure it

```bash
git clone https://github.com/<org>/bloombot.git ~/discord-channel-manager
cd ~/discord-channel-manager
git checkout master

npm ci
npm run build                       # the four Node processes (packages/ + apps/*/dist)
npm run build --workspace apps/web  # the control panel's own static bundle (apps/web/dist) —
                                     # a separate step; the root build above does not produce it

cp env.example .env
chmod 600 .env   # holds live credentials once filled in
```

`APP_DIR` for every command in this document, and the default `scripts/deploy.sh` assumes, is
`~/discord-channel-manager` — override it (`DEPLOY_PATH` in CI's own repository variables,
`APP_DIR` for a manual `scripts/deploy.sh` run) if the checkout lives somewhere else.

### 3.1 Fill in `.env`

Every variable `packages/config/src/env.ts`'s schema validates, plus every one a process reads
directly outside it (CFG-5) — `packages/config/tests/env-example.test.ts` is what keeps
`env.example` from silently missing one. What each is for, whether production needs it, and
what breaks when it is wrong or missing:

| variable | required in production? | what it is | what breaks if wrong |
| --- | --- | --- | --- |
| `NODE_ENV` | **yes** — `production` | which deployment this process believes it is | wrong logging/cookie/error-detail behavior; `apps/api` refuses `MAIL_FILE` and any dev stand-in email sender (see the callout above) |
| `LOG_LEVEL` | no (`info` default) | minimum severity written to `logs/<process>.log` | `debug` is noisy; `error` hides the warnings OPS-12's own monitor and an operator both want |
| `LOGS_DIR` | no (`./logs` default) | where each process's JSONL log file goes | relative to `APP_DIR` (every pm2 app in `ecosystem.config.cjs` deliberately has no `cwd` override — see that file's own module comment) |
| `DATABASE_PATH` | no (`./data/data.db` default) | the platform's own SQLite file | every process opens this; a path a process cannot create/write to fails that process's own startup |
| `ATTACHMENT_STORAGE_DIR` | no (`./data/attachments` default) | course attachment bytes on disk (FILE-1..5) | same failure mode as `DATABASE_PATH` — not writable, that action fails |
| `SQL_LITE_DB_PATH` | **yes, while the Python bot still runs** | the same SQLite file, the Python bot's own name for it (D-9) | must equal `DATABASE_PATH` **exactly** or the two systems silently fork onto different databases with no error until the data has already diverged |
| `PUBLIC_APP_URL` | **yes** | the panel's public origin, scheme+host, no trailing slash | every non-GET API request's `Origin` (falling back to `Referer`) is checked against this (`apps/api/src/middleware/origin.ts`, AUTH-3) — a mismatch is a `403` on every save, sign-in included; also the base every outbound link (a sign-in link, a Discord install redirect) is built from |
| `API_PORT` | no (`3000`) | the Express API's own port | nginx's `proxy_pass` (§5) must match |
| `BOT_HEALTH_PORT` | no (`3001`) | the bot's own `/health` port | `scripts/health-check.mjs`/`scripts/ops-monitor.mjs` poll this |
| `WORKER_HEALTH_PORT` | no (`3002`) | the worker's own `/health` port | same |
| `MCP_PORT` | no (`3003`) | the MCP server's `/mcp` and `/health` | same, plus this is what an MCP client connects to if exposed (§5.1) |
| `ADMIN_EMAILS` | no (empty = nobody) | comma-separated platform-administrator emails (AUTH-4) | empty means nobody can reach the platform-administrator console; not a login credential itself |
| `JOB_CLAIM_LEASE_MS`, `JOB_RETRY_BASE_DELAY_MS`, `JOB_RETRY_BACKOFF_FACTOR`, `JOB_POLL_INTERVAL_MS`, `JOB_HANDLER_TIMEOUT_MS` | no (documented defaults) | the background queue's own policy (JOB-2/3, `apps/worker`) | the defaults in `env.example` are what this platform was built and tested against; do not tune these without reading `docs/DECISIONS.md`'s own reasoning first |
| `MODEL_ADMISSION_LIMIT`, `MODEL_ADMISSION_WAIT_MS` | no (documented defaults) | bounds concurrent model calls (JOB-4) | too low and requests are refused under ordinary load; too high and a provider outage backs up every process sharing this bound |
| `MODEL_PRICING_JSON` | **effectively yes** — see below | per-model rates the cost ledger (COST-1..6) prices token counts against | left empty, `packages/config/src/pricing.ts`'s own documented default (an approximate, publicly listed OpenAI rate) applies — the spending cap (COST-3) still functions, but a cost the ledger records against a stale or wrong rate is not a real number an instructor can trust; **set this explicitly once real rates are known**, in the JSON shape that file documents (`{"rates":{"<model>":{"inputMicrosPerMillionTokens":n,"outputMicrosPerMillionTokens":n}},"defaultRate":{...}}`, integer micros per million tokens, never a float) |
| `DISCORD_API_BASE`, `DISCORD_OAUTH_BASE`, `OPENAI_BASE_URL`, `GOOGLE_ISSUER` | no (default to the real services) | test-only escape hatches (QA-2) | leave unset in production |
| `GOOGLE_CLIENT_ID` | no — see §4.3 | the OAuth client id checked as every Google ID token's `aud` claim | unset means the real verifier refuses every token rather than accepting any audience — the Google sign-in button simply does not work; email sign-in is unaffected |
| `BOT_APP_ID` | **yes** | the Discord application id, which doubles as the OAuth `client_id` | install and connect flows fail without it |
| `BOT_PUBLIC_KEY` | not read by any process today | the application's Ed25519 public key, from the same developer-portal page as the bot token | reserved for a future Discord-interactions signature check; capture it now anyway since it costs nothing and the page is already open |
| `BOT_TOKEN` | **yes** | the bot's own credential | nothing answers, nothing installs, without it |
| `BOT_PERMISSIONS` | **yes** | the permission integer the install link asks a server administrator to grant — `268504080` (see `env.example`'s own comment for the breakdown) | grant less and scaffolding a course fails partway with a `403`; Discord fixes a bot's permissions **at invite time**, so changing this value later needs a re-invite, not a restart |
| `OPENAI_API_KEY` | **yes** | the model provider credential | every model call fails; `apps/api`'s own web chat degrades to an apology (WEB-10) rather than refusing to start, but `apps/bot` refuses to start without it |
| `DISCORD_CLIENT_SECRET` | **yes** | the install flow's OAuth2 client secret | the install flow (and, once landed, the account-connect flow — see §4.2) fails |
| `OPS_ALERT_WEBHOOK_URL` | strongly recommended (OPS-12) | a Discord or Slack incoming-webhook URL `scripts/ops-monitor.mjs` posts to on a health transition | unset means a transition is still written to `logs/ops-monitor.log` but nobody is paged — see `docs/CUTOVER.md`'s own §5 |
| `OPS_ALERT_POLL_INTERVAL_MS` | no (`30000` default) | how often `ops-monitor` polls | lower is faster to notice, and more requests against every process's own `/health` |
| `MAIL_FILE` | **must stay unset in production** | development-only sign-in-link file | refused outright when `NODE_ENV=production`, whether set or not — see the callout at the top of this document |

## 4. Third-party setup, in order

### 4.1 Discord developer portal

Follow [docs/DISCORD_SETUP.md](DISCORD_SETUP.md) in full — it already covers the application,
the bot token, the two privileged intents (**Server Members**, **Message Content**), the OAuth2
client id/secret, and `BOT_PERMISSIONS`. Two things specific to a production deployment:

- **Two redirect URIs, not one.** `{PUBLIC_APP_URL}/discord/callback` is the *install* flow's
  own callback (`apps/api/src/index.ts`'s `discordRedirectUri`, confirmed in this repository
  today). LINK-6..9 (account connecting — "Connecting Discord is signing in with Discord") adds
  a **second** OAuth redirect for connecting an already-signed-in account to a Discord identity,
  landing in a slice concurrent with this one. Register both — but get the second path from
  that slice's own routes (or `apps/web`'s own routing) once it has landed, rather than guessing
  it here; a wrong redirect URI registered against a real Discord application is a mistake
  worth a five-minute check to avoid.
- Add `{PUBLIC_APP_URL}/discord/callback` (and the second URI once known) under **OAuth2 →
  Redirects** using the real production domain, not `localhost`.

### 4.2 OpenAI

Create an API key (platform.openai.com → API keys) scoped to this deployment alone — a key
shared with another project makes COST-3's spending cap meaningless, since it caps what this
platform records, not what the key has actually spent elsewhere. Set `OPENAI_API_KEY`. Set
`MODEL_PRICING_JSON` once real, current rates are known (§3.1) — the cost ledger (COST-1..6)
is only as accurate as this value.

### 4.3 Google Cloud (optional — email sign-in works without it)

Only needed for the **Sign in with Google** button (`apps/web/src/api/google-identity.ts`);
the emailed-link path (once the gap in this document's own callout is closed) does not depend
on it, and leaving `GOOGLE_CLIENT_ID` unset simply disables the button — `packages/auth`'s own
verifier refuses every token rather than accepting an unset audience, so there is no
half-configured state to worry about.

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services →
   Credentials** → **Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized JavaScript origins**: `https://<your production domain>` — the exact origin
   `PUBLIC_APP_URL` names, no path, no trailing slash. This app uses Google's **Identity
   Services** button (`accounts.id.initialize`/`accounts.id.prompt`), which verifies the
   calling origin and hands the browser an ID token directly — there is no redirect step, so
   **no Authorized redirect URI is needed** for this flow.
4. You will also be asked to configure the **OAuth consent screen** once, for the whole Google
   Cloud project — internal or external depending on whether every signer-in is inside your own
   Google Workspace; external needs nothing beyond the app name and support email for this
   platform's own use of it (only `openid`/basic profile scopes are requested — no Google data
   beyond identity is ever read).
5. Copy the **Client ID** (not the client secret — this flow needs none) into
   `GOOGLE_CLIENT_ID`.

### 4.4 Email — see the callout at the top of this document

There is nothing to configure here yet. Come back to this section once a real `EmailSender`
adapter exists.

## 5. nginx: one public origin for the panel and the API

`apps/web`'s own build (`npm run build --workspace apps/web`, already run in §3) produces
`apps/web/dist` — a static bundle with no server of its own (`apps/web/vite.config.ts`'s own
module comment: "in production nginx puts the built bundle and the API behind one origin"). The
only paths `apps/api` actually serves are `/health`, `/auth` and `/organizations` (and
everything nested under them) — `apps/web/vite.config.ts`'s own dev-time proxy names exactly
this list; everything else is the static bundle, with client-side routing falling back to
`index.html`.

```nginx
server {
    listen 443 ssl;
    server_name bloombot.example.edu;   # PUBLIC_APP_URL's own host

    ssl_certificate     /etc/letsencrypt/live/bloombot.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bloombot.example.edu/privkey.pem;

    root /home/deploy/discord-channel-manager/apps/web/dist;

    location = /health {
        proxy_pass http://127.0.0.1:3000;
    }
    location /auth/ {
        proxy_pass http://127.0.0.1:3000;
    }
    location /organizations/ {
        proxy_pass http://127.0.0.1:3000;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name bloombot.example.edu;
    return 301 https://$host$request_uri;
}
```

Get the certificate before enabling the `443` block:

```bash
sudo certbot --nginx -d bloombot.example.edu
```

Reload after any change: `sudo nginx -t && sudo systemctl reload nginx`.

### 5.1 The MCP server and the bot's/worker's own health ports

`MCP_PORT` (`3003`) is not proxied above — decide deliberately whether an outside MCP client
ever needs to reach it. If so, add a `location` block the same shape as `/health` above,
**behind authentication** (MCP-1..5's own session model, not this nginx config, is what
actually authenticates a caller — this is only about whether the port is reachable at all).
`BOT_HEALTH_PORT`/`WORKER_HEALTH_PORT` need no public route at all — `scripts/health-check.mjs`
and `scripts/ops-monitor.mjs` poll them from `127.0.0.1` on the same box.

## 6. Start everything with pm2 — or run the cutover first

If this is a **brand-new deployment** with no Python bot to migrate away from, start every
platform process directly — one at a time, by name, never a bare `pm2 start ecosystem.config.cjs`
(that would also start the `bloombot` app `ecosystem.config.cjs` still names for OPS-2's own
Python deployment, which a brand-new, platform-only droplet has no use for):

```bash
node packages/db/dist/run-migrate.js --i-know   # once, before anything starts (OPS-8)
pm2 start ecosystem.config.cjs --only api
pm2 start ecosystem.config.cjs --only bot
pm2 start ecosystem.config.cjs --only worker
pm2 start ecosystem.config.cjs --only mcp
pm2 start ecosystem.config.cjs --only ops-monitor
pm2 save
pm2 startup   # prints a command to enable autostart on reboot — copy and run it
```

If this droplet is **replacing an existing Python deployment**, do not start the platform's
processes this way — follow [docs/CUTOVER.md](CUTOVER.md) instead, which rehearses the import
against a copy first and rotates credentials as part of the switch (OPS-9, OPS-10, OPS-11).

## 7. Continuous deployment

Once §3–§6 have run once by hand, `.github/workflows/ci.yml`'s `deploy` job and
`scripts/deploy.sh` take over every future `master` merge — see README.md's own "Continuous
deployment" section for the one-time GitHub setup (`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_PATH`
variables, the `DEPLOY_SSH_KEY` secret, `DEPLOY_KNOWN_HOSTS`). `scripts/deploy.sh` builds the
TypeScript workspace, applies the platform migration exactly once (OPS-8), reloads every
process individually, and rolls all of them back together if any fails its health check —
read that script's own header comment for the full sequence, and `docs/DECISIONS.md`'s D-40
for why it is built the way it is.

**Building the missing `EmailSender` adapter is not something this document, or
`scripts/deploy.sh`, can route around** — it is application code this deployment depends on
and does not have. Scope it as its own slice before relying on this deployment for real sign-
ins.

## 8. Backups, log rotation, and the post-deploy checklist

### 8.1 Backing up the SQLite file

WAL mode (`packages/db/src/client.ts`'s own pragmas) means the file cannot simply be `cp`'d
while a process holds it open — a copy could land mid-checkpoint. Use SQLite's own online
backup API instead, which is safe against a live database:

```bash
sqlite3 /home/deploy/discord-channel-manager/data/data.db ".backup /tmp/data-backup-$(date +%F).db"
```

Cron this nightly, and copy the result off the droplet (DigitalOcean Spaces, or `scp` to
another host) — a backup that lives on the same disk as the database it backs up survives
neither a full-disk failure nor an accidental `rm`. Back up `bot_config.yml` and `.env`
alongside it (the latter to a location at least as protected as `.env` itself, since it holds
live credentials) — a restored database with no matching configuration is only half a
recovery.

### 8.2 Log rotation

`LOGS_DIR` (`./logs`, per-process JSONL) and pm2's own `error_file`/`out_file`
(`ecosystem.config.cjs`, `./logs/pm2-*.log`) both grow without bound on their own. Install
[`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

This rotates pm2's own `pm2-*.log` files; the per-process JSONL files under `LOGS_DIR` are not
pm2's own output and are not covered by it — rotate those the ordinary way (`logrotate`, a
`/etc/logrotate.d/bloombot` entry pointed at `LOGS_DIR/*.log`) if their volume warrants it.

### 8.3 Post-deploy checklist

Run this after §6 (or after any `scripts/deploy.sh` run) — the automated health check
(`scripts/health-check.mjs`, run by the deploy script itself) proves every process is *running
and reachable*; this proves the product actually works end to end:

1. **Sign in.** Google (§4.3), if configured — email sign-in has no working path until §7's own
   gap is closed (state this plainly if it is what you are testing; do not treat a failure here
   as a regression in anything this deployment did correctly).
2. **The panel loads and shows real data** — an organization, a project, a course.
3. **A Discord answer.** Mention the bot in a channel inside a configured course's category;
   confirm a reply arrives and the transcript is recorded.
4. **A queued job.** Scaffold a course (or attach a knowledge file) and confirm the worker
   picks it up — `apps/worker`'s own `/health` reports `queueDepth` dropping back to what it
   was before.
5. **Health, from outside nginx's own proxy:** `curl -s https://<your domain>/health` should
   read `{"ready":true,"database":true}`.
6. **Alerting is armed** (OPS-12) — confirm `ops-monitor` is in pm2's process list and
   `OPS_ALERT_WEBHOOK_URL` is set; see `docs/CUTOVER.md`'s own §5 for what "notified" means.
