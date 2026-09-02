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
> `NODE_ENV=production` set at all — **not just email sign-in, every route this process
> serves**, including Google sign-in (§4.3): `buildEmailSender` is evaluated in `apps/api/src/index.ts`'s
> own `main()` before `buildApp`/`server.listen` ever run, so the whole process refuses to come
> up, not merely the email path within it. Discord answering (`apps/bot`) is unaffected — it is
> a separate process with no dependency on `apps/api`. Report this rather than route around it
> if you hit it; it is tracked as **AUTH-5**.

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

**Networking.** Open `22` (SSH), `80` and `443` (nginx) in **both** places a fresh Ubuntu droplet
can have a firewall: DigitalOcean's own cloud firewall (if one is attached to the droplet) *and*
`ufw`, which recent Ubuntu images often ship active by default — a rule in one and not the other
still blocks the traffic.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status   # confirm, and confirm ufw is even active — it may not be
```

Nothing else needs to be reachable from outside the box — every process's own port (`API_PORT`,
`BOT_HEALTH_PORT`, `WORKER_HEALTH_PORT`, `MCP_PORT`) binds `127.0.0.1` only, by each process's
own explicit choice (`apps/*/src/index.ts`'s own module comments), so nginx is the only thing
with a public listener besides SSH.

## 2. Create the deploy user, and install the runtime dependencies

A fresh droplet logs in as `root`; do not run the checkout, pm2 or the deploy key as `root` —
create a dedicated user, the same one `DEPLOY_USER` in README.md's own "Continuous deployment"
section names.

```bash
adduser deploy          # prompts for a password; leave the optional fields blank if you like
usermod -aG sudo deploy # only if this user should also administer the box directly
```

**Ubuntu 24.04's own `adduser` creates the new home directory `0750`** — owner and group only,
not world-traversable. nginx runs as `www-data`, a different user and group, and needs to
*traverse* `/home/deploy` to reach `apps/web/dist` beneath it (§5) even though it never reads
anything else there — a correctly created `deploy` user with the *default* permissions still
gives nginx a `403` on every path until this is set:

```bash
chmod o+x /home/deploy
```

Now install the runtime dependencies (as `root`, or with `sudo`; these are machine-wide):

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

**As the `deploy` user** (`su - deploy`, or a fresh SSH login as `deploy`) from here on — every
command in this document, and every path `scripts/deploy.sh`/`ecosystem.config.cjs` assume,
runs as this user, not `root`.

```bash
git clone https://github.com/<org>/bloombot.git ~/discord-channel-manager
cd ~/discord-channel-manager
git checkout master

npm ci
npm run build   # the four Node processes (packages/ + apps/*/dist) — not the control panel;
                 # that build happens in §4.3, once VITE_GOOGLE_CLIENT_ID is known

pipenv install --deploy   # response_bot.py's own dependencies, for the migration window
                           # (docs/CUTOVER.md) — installed here the same way scripts/deploy.sh
                           # itself installs them on every later deploy that changes Pipfile.lock

cp env.example .env
chmod 600 .env   # holds live credentials once filled in
```

**`env.example` ships two variables with non-empty placeholder text, not blank:**
`BOT_APP_ID=your_bot_app_id` and `BOT_PERMISSIONS=your_bot_permissions_integer`. Every process's
own `requireEnv`-style check is a truthiness check — a literal, un-replaced placeholder string
still counts as "set" — so a `.env` copied and only partly filled in starts every process
cleanly, `/health` reports `ready: true`, and the install link Discord actually receives is
built from the word `your_bot_app_id` rather than a real id. Nothing about this fails loudly;
it fails on Discord's own side, and only once someone tries to install the bot. Fill in *every*
variable §3.1's own table marks **yes**, not only the ones whose name obviously looks like a
secret.

`APP_DIR` for every command in this document, and the default `scripts/deploy.sh` assumes, is
`$HOME/discord-channel-manager` — as the `deploy` user, that is `/home/deploy/discord-channel-manager`,
the path this document uses everywhere below. Override it (`DEPLOY_PATH` in CI's own repository
variables, `APP_DIR` for a manual `scripts/deploy.sh` run) if the checkout lives somewhere else,
and use that path consistently in place of `/home/deploy/discord-channel-manager` in every
command below that names it explicitly (nginx's `root`, the backup script).

**The control panel's own build (`npm run build --workspace apps/web`) is deliberately not run
here.** Vite bakes `VITE_GOOGLE_CLIENT_ID` into the bundle *at build time*, not read at runtime
the way every other variable in this document is — building the panel before §4.3 has that value
would need a second build to actually pick it up, and `scripts/deploy.sh` rebuilds the panel on
every future deploy from whatever `apps/web/.env.production` holds at that moment, so a build run
here with the variable unset would appear to work and then be silently wrong on every deploy
after this one. See §4.3 for where this build actually happens, once.

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
| `PUBLIC_APP_URL` | **yes** — e.g. `https://bloombot.example.edu` (no trailing slash — see why) | the panel's public origin, scheme+host | every non-GET API request's `Origin` (falling back to `Referer`) is checked against this (`apps/api/src/middleware/origin.ts`, AUTH-3) — a mismatch is a `403` on every save, sign-in included. A trailing slash here does *not* break that check on its own (`origin.ts` compares `new URL(...).origin`, which normalizes it away) — it breaks the Discord install/connect redirect instead: `discordRedirectUri` is built as a plain string concatenation (`` `${publicAppUrl}/discord/callback` ``, `apps/api/src/index.ts`), so a trailing slash produces `.../callback` with a doubled `//` in the middle and stops matching the URI registered in the Discord developer portal (§4.1) at all |
| `API_PORT` | no (`3000`) | the Express API's own port | nginx's `proxy_pass` (§5) must match |
| `BOT_HEALTH_PORT` | no (`3001`) | the bot's own `/health` port | `scripts/health-check.mjs`/`scripts/ops-monitor.mjs` poll this |
| `WORKER_HEALTH_PORT` | no (`3002`) | the worker's own `/health` port | same |
| `MCP_PORT` | no (`3003`) | the MCP server's `/mcp` and `/health` | same, plus this is what an MCP client connects to if exposed (§5.4) |
| `ADMIN_EMAILS` | no (empty = nobody) | comma-separated platform-administrator emails (AUTH-4) | empty means nobody can reach the platform-administrator console; not a login credential itself |
| `JOB_CLAIM_LEASE_MS`, `JOB_RETRY_BASE_DELAY_MS`, `JOB_RETRY_BACKOFF_FACTOR`, `JOB_POLL_INTERVAL_MS`, `JOB_HANDLER_TIMEOUT_MS` | no (documented defaults) | the background queue's own policy (JOB-2/3, `apps/worker`) | the defaults in `env.example` are what this platform was built and tested against; do not tune these without reading `docs/DECISIONS.md`'s own reasoning first |
| `MODEL_ADMISSION_LIMIT`, `MODEL_ADMISSION_WAIT_MS` | no (documented defaults) | bounds concurrent model calls (JOB-4) | too low and requests are refused under ordinary load; too high and a provider outage backs up every process sharing this bound |
| `MODEL_PRICING_JSON` | **effectively yes** — see below | per-model rates the cost ledger (COST-1..6) prices token counts against | left empty, `packages/config/src/pricing.ts`'s own documented default (an approximate, publicly listed OpenAI rate) applies — the spending cap (COST-3) still functions, but a cost the ledger records against a stale or wrong rate is not a real number an instructor can trust; **set this explicitly once real rates are known**, in the JSON shape that file documents (`{"rates":{"<model>":{"inputMicrosPerMillionTokens":n,"outputMicrosPerMillionTokens":n}},"defaultRate":{...}}`, integer micros per million tokens, never a float) |
| `DISCORD_API_BASE`, `DISCORD_OAUTH_BASE`, `OPENAI_BASE_URL`, `GOOGLE_ISSUER` | no (default to the real services) | test-only escape hatches (QA-2) | leave unset in production |
| `GOOGLE_CLIENT_ID` | no — see §4.3 | the OAuth client id checked as every Google ID token's `aud` claim | unset means the real verifier refuses every token rather than accepting any audience, so the Google sign-in button does not work even once `apps/api` itself can start — see this document's own lead callout for why, in production today, `apps/api` does not start at all regardless of this variable |
| `VITE_GOOGLE_CLIENT_ID` (§4.3, **not** the root `.env`) | no — see §4.3 | the *same* Google client id, but for `apps/web`'s own build — read by `apps/web/src/pages/SignIn.tsx` at **build time**, from `apps/web/.env.production`, not `process.env`/`packages/config` at all | omitted or wrong and the Google button silently does nothing in the browser (`handleGoogle` returns early) — no server-side error, because the browser never sends a request; set it *before* §4.3's own `npm run build --workspace apps/web`, not after, since Vite bakes it into the built bundle rather than reading it at runtime |
| `BOT_APP_ID` | **yes** | the Discord application id, which doubles as the OAuth `client_id` | install and connect flows fail without it |
| `BOT_PUBLIC_KEY` | not read by any process today | the application's Ed25519 public key, from the same developer-portal page as the bot token | reserved for a future Discord-interactions signature check; capture it now anyway since it costs nothing and the page is already open |
| `BOT_TOKEN` | **yes** | the bot's own credential | nothing answers, nothing installs, without it |
| `BOT_PERMISSIONS` | **yes** | the permission integer the install link asks a server administrator to grant — `268504080` (see `env.example`'s own comment for the breakdown) | grant less and scaffolding a course fails partway with a `403`; Discord fixes a bot's permissions **at invite time**, so changing this value later needs a re-invite, not a restart |
| `OPENAI_API_KEY` | **yes** | the model provider credential | every model call fails; `apps/api`'s own web chat degrades to an apology (WEB-10) rather than refusing to start, but `apps/bot` refuses to start without it |
| `DISCORD_CLIENT_SECRET` | **yes** | the install flow's OAuth2 client secret | the install flow (and, once landed, the account-connect flow — see §4.1) fails |
| `OPS_ALERT_WEBHOOK_URL` | strongly recommended (OPS-12) | a Discord or Slack incoming-webhook URL `scripts/ops-monitor.mjs` posts to on a health transition | unset means a transition is still written to `logs/pm2-ops-monitor-out.log`/`logs/pm2-ops-monitor-error.log` (pm2's own redirect for that process, `ecosystem.config.cjs`) but nobody is paged — see `docs/CUTOVER.md`'s own §5 |
| `OPS_ALERT_POLL_INTERVAL_MS` | no (`30000` default) | how often `ops-monitor` polls | lower is faster to notice, and more requests against every process's own `/health` |
| `MAIL_FILE` | **must stay unset in production** | development-only sign-in-link file | refused outright when `NODE_ENV=production`, whether set or not — see the callout at the top of this document |

`PUBLIC_APP_URL` (and the Discord/Google origins registered against it in §4) must match the
*exact* address a browser uses to reach the panel — `docs/RUNNING_LOCALLY.md`'s own
troubleshooting table has the same warning for local development (`localhost` and `127.0.0.1`
are different origins there); in production the equivalent mistake is reaching the droplet by
its bare IP address, or a `www.` variant of the domain that was never registered anywhere in §4
— either one is a different origin from `PUBLIC_APP_URL` and fails the same origin check.

## 4. Third-party setup, in order

### 4.1 Discord developer portal

Follow [docs/DISCORD_SETUP.md](DISCORD_SETUP.md) in full — it already covers the application,
the bot token, the two privileged intents (**Server Members**, **Message Content**), the OAuth2
client id/secret, and `BOT_PERMISSIONS`. Two things specific to a production deployment:

- **One redirect URI, shared by both OAuth flows.** `{PUBLIC_APP_URL}/discord/callback` is the
  *install* flow's own callback (`apps/api/src/index.ts`'s `discordRedirectUri`). LINK-6..9
  (account connecting — "Connecting Discord is signing in with Discord"), landing in a slice
  concurrent with this one, reuses the *same* `deps.discordRedirectUri` rather than a second URI
  of its own (`routes/person-link.ts`) — there is exactly one to register, not two. If a later
  change to that slice ever gives it its own callback path instead, this document's own claim
  above is what to re-check, not assume still holds.
- Add `{PUBLIC_APP_URL}/discord/callback` under **OAuth2 → Redirects** using the real production
  domain, not `localhost`.

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
   `GOOGLE_CLIENT_ID` in `.env`.
6. **Also set it as `VITE_GOOGLE_CLIENT_ID`, for the browser build — a second, separate
   place.** `apps/web/src/pages/SignIn.tsx` reads `import.meta.env['VITE_GOOGLE_CLIENT_ID']`,
   which Vite resolves **at build time**, from `apps/web`'s own `.env`/`.env.production` — not
   the repository root's `.env` this document has used for every other variable so far. Vite's
   `envDir` defaults to the directory holding `vite.config.ts` (`apps/web` itself); nothing in
   this repository overrides that, so the root `.env` is invisible to this one build step.

   ```bash
   printf 'VITE_GOOGLE_CLIENT_ID=%s\n' '<the same client id from step 5>' > apps/web/.env.production
   chmod 600 apps/web/.env.production   # not a bearer credential, but treat consistently with .env
   ```

   (`.gitignore`'s `.env.*` pattern already covers this path — it is never committed.)

7. **Now build the control panel, for the first time** — this is the step §3 deliberately
   skipped, because it needed this variable first:

   ```bash
   npm run build --workspace apps/web
   ```

   Every later deploy (`scripts/deploy.sh`) rebuilds this the same way, reading the same
   `apps/web/.env.production` — set it once, here, and it survives every future deploy without
   needing to be repeated, the same way `.env` itself does for every other process.

### 4.4 Email — see the callout at the top of this document

There is nothing to configure here yet. Come back to this section once a real `EmailSender`
adapter exists.

## 5. nginx: one public origin for the panel and the API

`apps/web`'s own build (`npm run build --workspace apps/web`, run in §4.3 once
`VITE_GOOGLE_CLIENT_ID` was known) produces `apps/web/dist` — a static bundle with no server of
its own (`apps/web/vite.config.ts`'s own module comment: "in production nginx puts the built
bundle and the API behind one origin"). The only paths `apps/api` actually serves are `/health`,
`/auth` and `/organizations` (and everything nested under them) — `apps/web/vite.config.ts`'s
own dev-time proxy names exactly this list; everything else is the static bundle, with
client-side routing falling back to `index.html`.

### 5.1 DNS, before anything else

`certbot`'s own certificate request (§5.3) proves domain ownership by having your DNS resolver
answer for the domain — it has no way to succeed before that answer exists. Point an `A` (and,
for IPv6, `AAAA`) record at the droplet's own address first, and confirm it before touching
nginx at all:

```bash
dig +short bloombot.example.edu
# must print the droplet's own IP — if it prints nothing, or a different address, stop here.
# DNS propagation can take minutes to hours depending on the record's own TTL.
```

Getting this wrong shows up as `certbot` failing an HTTP-01 challenge with a message about the
*challenge*, not about DNS — nothing points you back to this step unless you already suspect it.

### 5.2 nginx, HTTP only first

`certbot --nginx` (§5.3) edits an *existing* server block for the domain to add its own `443`
one — write the HTTP-only block below, reload, confirm it serves plain HTTP, and let `certbot`
add TLS itself rather than hand-writing a `443` block referencing certificates that do not exist
yet (`nginx -t` refuses to reload with `ssl_certificate` pointed at a missing file, which blocks
this *and* every unrelated site nginx also serves — the DNS record from §5.1 must already be
correct by this point, since this file names `bloombot.example.edu` explicitly).

```nginx
# /etc/nginx/sites-available/bloombot
server {
    listen 80;
    server_name bloombot.example.edu;   # PUBLIC_APP_URL's own host

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
```

```bash
sudo ln -s /etc/nginx/sites-available/bloombot /etc/nginx/sites-enabled/bloombot
sudo nginx -t && sudo systemctl reload nginx
curl -sI http://bloombot.example.edu/health   # confirm this actually reaches something before TLS
```

### 5.3 TLS

```bash
sudo certbot --nginx -d bloombot.example.edu
```

`certbot` edits the server block above in place — adding its own `listen 443 ssl` server, the
certificate paths, and an HTTP→HTTPS redirect on the `80` block — rather than needing a second,
hand-written `443` block from this document. Confirm: `curl -sI https://bloombot.example.edu/health`.

Reload after any further change: `sudo nginx -t && sudo systemctl reload nginx`.

### 5.4 The MCP server and the bot's/worker's own health ports

`MCP_PORT` (`3003`, both its `/mcp` endpoint and its own `/health`) is not proxied above —
decide deliberately whether an outside MCP client ever needs to reach it. If so, add a
`location /mcp` block the same shape as `/auth` above, pointed at `127.0.0.1:3003`, **behind
authentication** (MCP-1..5's own session model, not this nginx config, is what actually
authenticates a caller — this is only about whether the port is reachable at all).
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

**If AUTH-5 (this document's own lead callout) has not landed yet, `api` will crash-loop here**
— `pm2 status` shows it restarting continuously, and `https://<your domain>/health` returns
nginx's own `502 Bad Gateway`, not a response from `apps/api`. `bot`/`worker`/`mcp`/`ops-monitor`
come up normally regardless; only the panel, the web chat surface, and anything routed through
`apps/api` are unreachable until AUTH-5 lands and `api` is reloaded.

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

### 8.1 Backing up the SQLite file — and the course attachments it does not contain

WAL mode (`packages/db/src/client.ts`'s own pragmas) means the file cannot simply be `cp`'d
while a process holds it open — a copy could land mid-checkpoint. Use SQLite's own online
backup API instead, which is safe against a live database, and confirm the copy is actually
sound rather than assuming a `.backup` that completed without an error is automatically a
usable file:

```bash
BACKUP=/tmp/data-backup-$(date +%F).db
sqlite3 /home/deploy/discord-channel-manager/data/data.db ".backup $BACKUP"
sqlite3 "$BACKUP" "pragma integrity_check;"   # must print exactly "ok"
```

**Course attachments are not in this file at all.** `ATTACHMENT_STORAGE_DIR` (default
`./data/attachments`, `packages/db/src/attachment-storage.ts`) holds the actual bytes of every
uploaded knowledge file, keyed by an id the database row only *references* — backing up
`data.db` alone and skipping this directory means every knowledge file 404s after a restore,
with the instructor holding no copy of their own to re-upload:

```bash
tar -czf "/tmp/attachments-backup-$(date +%F).tar.gz" \
  -C /home/deploy/discord-channel-manager/data attachments
```

Cron both nightly, and copy the results off the droplet (DigitalOcean Spaces, or `scp` to
another host) — a backup that lives on the same disk as what it backs up survives neither a
full-disk failure nor an accidental `rm`. Back up `bot_config.yml` and `.env` alongside them
(the latter to a location at least as protected as `.env` itself, since it holds live
credentials) — a restored database with no matching configuration, or bytes with no database
row pointing at them, is only half a recovery.

**A backup with no restore procedure is a hypothesis, not a backup.** Rehearse this — against
`tmp/`, on a spare checkout, never the live droplet, the same MIG-1 discipline
[docs/CUTOVER.md](CUTOVER.md) holds itself to:

```bash
# Stop everything that holds data.db open — including the Python bot, if it
# is still running during the migration window (docs/CUTOVER.md): §3.1's
# own SQL_LITE_DB_PATH == DATABASE_PATH (D-9) means bloombot has the exact
# same file open through peewee, and restoring over it while that process
# still holds a handle is exactly what the WAL warning above this section
# exists to prevent — omitting it here would be the same mistake.
pm2 stop bloombot api bot worker mcp ops-monitor
rm -f data/data.db-wal data/data.db-shm   # stale WAL/shared-memory sidecars from the old file —
                                           # leaving them would let SQLite try to replay them
                                           # against the restored file's own, unrelated history
cp "$BACKUP" data/data.db
rm -rf data/attachments && tar -xzf "/tmp/attachments-backup-$(date +%F).tar.gz" -C data
node packages/db/dist/run-migrate.js --i-know   # the restored file may predate a later migration
pm2 start api bot worker mcp ops-monitor
# Restart bloombot too, only if it was stopped above (i.e. this droplet is
# still mid-migration) — a fully cut-over droplet has no such process left.
```

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
and reachable*; this proves the product actually works end to end.

**If AUTH-5 has not landed** (this document's own lead callout), steps 1, 2 and 5 below will not
work — `api` itself is not running, so step 5's `curl` returns nginx's own `502 Bad Gateway`, not
`{"ready":true,"database":true}`, and steps 1–2 have no panel to reach at all. That is expected,
not a regression to chase; steps 3 and 4 (Discord, the worker) do not depend on `api` and are a
real test of the cutover regardless.

1. **Sign in.** Google (§4.3), if configured — email sign-in has no working path until AUTH-5
   lands (state this plainly if it is what you are testing; do not treat a failure here as a
   regression in anything this deployment did correctly).
2. **The panel loads and shows real data** — an organization, a project, a course.
3. **A Discord answer.** Mention the bot in a channel inside a configured course's category;
   confirm a reply arrives and the transcript is recorded.
4. **A queued job.** Scaffold a course (or attach a knowledge file) and confirm the worker
   picks it up — `curl -s http://127.0.0.1:3002/health` (loopback, unproxied — `WORKER_HEALTH_PORT`
   has no public nginx route, §5.4) reports `queueDepth` dropping back to what it was before.
5. **Health, from outside nginx's own proxy:** `curl -s https://<your domain>/health` should
   read `{"ready":true,"database":true}`.
6. **Alerting is armed** (OPS-12) — confirm `ops-monitor` is in pm2's process list and
   `OPS_ALERT_WEBHOOK_URL` is set; see `docs/CUTOVER.md`'s own §5 for what "notified" means.
