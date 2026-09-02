# Cutover: retiring the Python bot for the platform

The procedure for switching a production course server from `response_bot.py` to the
TypeScript platform — rehearsed against a copy first (OPS-9), the switch itself done
deliberately and in a fixed order (OPS-10), with credentials rotated as part of it (OPS-11)
and a way back that does not depend on anything the cutover deletes.

This is a runbook, not a description of an intention: every step says what it does and how
to tell it worked. It assumes `docs/DISCORD_SETUP.md` has already been followed once (the
platform's own Discord application exists, with its own bot token), `docs/RUNNING_LOCALLY.md`
for what each process is, and `docs/DEPLOY_DROPLET.md` for a droplet already provisioned,
configured and answering as the platform's own §6 describes for a brand-new deployment — this
document is what to do differently when a Python bot is already running on it. `docs/DECISIONS.md`'s
D-9 is why `DATABASE_PATH` and `SQL_LITE_DB_PATH` are two names for what has to be one file
during this whole procedure.

**Every step below that touches a database uses a path under `tmp/`, never `data/data.db`.**
The live file holds real students' names, emails and conversation transcripts, and the
running Python bot is still serving them for the entire rehearsal phase — MIG-1's rule holds
absolutely: the importer refuses to open a path under `data/` as its *source*, with no
override, and `db:migrate`/the platform's own `DATABASE_PATH` refuse a path under `data/` as
a *destination* unless given `--i-know` — which the rehearsal never passes.

---

## Phase 1 — Rehearsal (OPS-9)

Run this as many times as it takes to get right. It never touches the live file, so nothing
here is destructive and nothing here needs to be undone.

### 1.1 Take a copy

On the droplet (or a machine with a copy of the checkout):

```bash
cp data/data.db tmp/rehearsal-snapshot.db   # a copy, never the live file
```

`tmp/` is gitignored and outside the protected-path guard; `data/data.db` is read once, here,
and never again for the rest of this phase.

### 1.2 Import the copy into a throwaway platform database

```bash
DATABASE_PATH=./tmp/rehearsal-platform.db \
  npm run legacy:import --workspace packages/legacy-import -- \
  tmp/rehearsal-snapshot.db bot_config.yml
```

This is `npm run build` followed by the CLI (`packages/legacy-import/src/cli.ts`) — it
builds the destination database from nothing, so the very first run also proves the platform
schema migrates cleanly onto an empty file. Read the report it prints:

- `courses`/`people`/`messages`: `created` should roughly match what `bot_config.yml` and the
  snapshot actually hold; a course reported `skipped`, or a message reported `unplaceable`,
  names something the import could not place (MIG-4) — read why before continuing, not after
  the real cutover.
- **Re-run the exact same command a second time.** Every count should now read `matched`,
  `created: 0` — MIG-4's own guarantee, and the cheapest way to prove the import is safe to
  re-run if step 1.1's snapshot needs to be retaken after a fix.

If the destination path is ever mistyped to something under `data/`, the importer refuses it
outright (`Refusing to import into '...'`) — that guard is not something this rehearsal needs
to route around; a refusal here means the command line was wrong, not that the guard should
be bypassed.

### 1.3 Run the platform against the copy, alongside the Python bot

Point a checkout's `.env` at the throwaway database from 1.2 (`DATABASE_PATH=./tmp/rehearsal-platform.db`,
`NODE_ENV=development` is fine for a rehearsal), and start it:

```bash
npm run build
npm run dev
```

Invite the **same bot application** the Python bot already uses into a **disposable test
server** — never a course server a student is enrolled in. A bot token is not tied to one
server; inviting it somewhere else needs no new credential and touches nothing in production.
**Bind that disposable test server to the rehearsal organization** through the platform's own
panel (Discord → Install to Discord), then recreate one course's categories/channels there (by
hand, or by scaffolding it through the panel) so a mention has somewhere to land. **Never bind
a real course server — one a student is actually enrolled in — to the rehearsal organization.**
That binding is what §1.3's own safety argument below depends on; see the warning at the end of
this section for exactly why.

Send a real message in the test server. Confirm:

- the platform answers it, using the imported course's own instructions
- the transcript is recorded, attributed to the right person and course (check the panel, or
  `apps/api`'s own `/health` plus a read through the panel's conversation view)
- `npm run legacy:import`'s own idempotency (1.2) means the snapshot can be re-taken and
  re-imported as many times as this step needs

The Python bot is not stopped for this phase — it keeps answering in its own, real course
servers throughout. Nothing in 1.1–1.3 is visible to it, and nothing here is visible to a real
course server either, even though gateway events for the *same* bot token reach both processes
regardless of which guild they came from: the rehearsal's `apps/bot` never routes a message
from a server the rehearsal organization has no binding for at all.
`packages/discord/src/handle-mention.ts` resolves the Discord server binding (SURF-3,
`resolveDiscordServerBinding`) **before** any course or category matching — an unbound server
is dropped there, unconditionally, before `handleMention` ever looks at what the message says
or which category it arrived in. `packages/legacy-import` never writes a server-binding row at
all (there is nothing in `bot_config.yml` to derive one from), so the rehearsal organization
starts with **no** Discord server bound to it — the disposable test server bound above is the
*only* one it will ever answer in, until an operator binds another.

**This is why the "never bind a real course server" instruction above is load-bearing, not
merely careful.** The protection here is the *absence of a binding*, not that the rehearsal's
own courses happen not to match a real category name (they can, and after §1.2 imports the real
`bot_config.yml`, they do — the rehearsal database knows exactly the real course names). Binding
a real course server to the rehearsal organization removes the one thing standing between this
rehearsal and a second bot double-answering real students on the production token, spending real
model cost, for the rest of the rehearsal.

### 1.4 Rehearse the rollback itself

**Do this before the real cutover, not after it fails once for real.** The rollback path is
the part most likely to be written and never tested; the way to trust it is to run it:

1. Stop the rehearsal's platform processes (`Ctrl-C` on `npm run dev`, or `pm2 stop api bot
   worker mcp ops-monitor` if it was brought up under pm2 instead).
2. Confirm the Python bot alone still answers in the test server — it never stopped, so this
   should need nothing.
3. Time how long step 1 actually took, end to end. That number is what an operator should
   expect during the real cutover's own rollback (§3).

This project's own deploy script rollback was rehearsed the same way while this slice was
built: a throwaway git checkout and a stand-in `pm2`, driven through a build failure, a
migration failure and an unhealthy-after-reload failure. That rehearsal is what found a real
bug — `scripts/deploy.sh`'s own rollback used to die silently, under `set -e`, if the rebuild
it needs to restore the previous commit's `dist/` itself failed, instead of saying so. Fixed
before it could be the thing discovered at 9pm; see `scripts/deploy.sh`'s own
`restore_previous_checkout` for the fix and docs/DECISIONS.md's own entry for this slice.

---

## Phase 2 — Cutover (OPS-10, OPS-11)

> ### Before you start: does `apps/api` have a real email transport yet?
>
> `apps/api/src/logging-email-sender.ts#buildEmailSender` refuses to start this process at all
> in `NODE_ENV=production` until a real `EmailSender` is configured — `packages/auth/src/email.ts`
> ships only a port and a test fake (see `docs/DEPLOY_DROPLET.md`'s own lead callout). That gap
> is tracked as **AUTH-5** and, as of this writing, is being built on the integration branch in
> parallel with this document — check whether it has landed (`git log` for AUTH-5, or simply try
> starting `api` against a `.env` with `NODE_ENV=production` and see whether it stays up) before
> running §2.2 below.
>
> **If AUTH-5 has not landed yet:** §2.5 will start `bot`, `worker` and `mcp` successfully — none
> of them depend on email — but `api` will crash-loop, so the panel and the web chat surface are
> unreachable through the platform. §2.2 has already stopped the Python bot and §2.3 has already
> reset the Discord token in the developer portal by that point, both irreversibly, so **do not
> reach §2.2 without first deciding this is acceptable** (Discord answers still work; the panel
> and any Google/email sign-in do not, until AUTH-5 lands and this cutover's own `api` is
> restarted). §3's rollback still works regardless — it does not depend on `api` ever having come
> up — but it is a worse position to roll back from than never having started.

Do this once the rehearsal above has been run at least once successfully, including 1.4.
Pick a low-traffic window — there is a real, if short, gap between stopping the Python bot
and the platform's own processes answering again.

### 2.1 Take the real import's own copy

Same as 1.1, but this is now the **input to the real import**, not a rehearsal:

```bash
cp data/data.db tmp/cutover-snapshot.db
```

### 2.2 Stop the Python bot

```bash
pm2 stop bloombot
```

**Stop before rotating (§2.3) and before importing (§2.4).** Nothing should be reading or
writing through the Python bot's own credentials once this step finishes, which is what
makes the rotation below safe to do without racing a still-running process. The bot's own
process entry is left in pm2 (`pm2 stop`, not `pm2 delete`) — §4 depends on it still being
there.

### 2.3 Rotate every credential the Python system used (OPS-11)

`BOT_TOKEN` and `OPENAI_API_KEY` are the two — `packages/config/src/env.ts` and
`env.example` name every other credential the platform reads, and neither of them
(`DISCORD_CLIENT_SECRET`, `BOT_PUBLIC_KEY`) is one the Python system ever held, so there is
nothing to rotate there; they are configured once, per `docs/DISCORD_SETUP.md`, not rotated
at cutover.

A credential that has lived in two systems' environments has had two chances to leak — the
Python bot's `.env` and the platform's are the **same file** (D-9), read by both, so in
practice this is "generate a new value, write it once, restart everything that reads it,"
not two separate rotations:

1. **Discord developer portal → Bot → Reset Token.** This invalidates the old token
   immediately — which is fine, because the Python bot that read it was just stopped in
   §2.2, and the platform has not started yet.
2. **OpenAI dashboard → API keys → create a new key.** Do not revoke the old one yet — see
   §2.6.
3. Write both new values into the **one** `.env` file both systems share.

**What rotation does *not* need to touch: `BOT_PERMISSIONS`, or a re-invite.** A bot's
permissions in a server are set when it is invited (`docs/DISCORD_SETUP.md`'s own step 1,
which is where the permission integer itself is decided), not by the token it currently
holds — resetting the token above changes which secret authenticates as the bot, not what
the bot is allowed to do in any server it is already in. Re-inviting is a *separate* action,
needed only when `BOT_PERMISSIONS` itself changes; doing it as part of an ordinary rotation
is unnecessary and, for a bot already live in every course server, disruptive for no reason —
nothing here asks for it.

### 2.4 Apply the real import

```bash
DATABASE_PATH=./data/data.db \
  npm run legacy:import --workspace packages/legacy-import -- \
  tmp/cutover-snapshot.db bot_config.yml --i-know
```

`--i-know` is the deliberate override MIG-1 describes for exactly this call: the
*destination* is legitimately the live file now that the Python bot has been stopped. The
*source* (`tmp/cutover-snapshot.db`) is still a copy — the importer would refuse a live
source unconditionally regardless of the flag. Read the report the same way as 1.2's
rehearsal; every count should match what the rehearsal already showed for the same snapshot
if nothing changed between taking the two copies.

### 2.5 Start the platform

```bash
pm2 start ecosystem.config.cjs --only api
pm2 start ecosystem.config.cjs --only bot
pm2 start ecosystem.config.cjs --only worker
pm2 start ecosystem.config.cjs --only mcp
pm2 start ecosystem.config.cjs --only ops-monitor
pm2 save
```

(`scripts/deploy.sh` does this same sequence, plus the migration step, automatically on every
future deploy once this one has run by hand — this manual sequence is only for the very first
cutover.) If AUTH-5 (see this Phase's own callout above) has not landed, `pm2 status` will show
`api` crash-looping (`restart_time` climbing) while `bot`/`worker`/`mcp`/`ops-monitor` come up
normally — expected, not a sign the other four are broken too.

### 2.6 Verify, then finish the rotation

```bash
curl -s 127.0.0.1:3000/health   # api — will not answer at all if AUTH-5 has not landed; see §2.5
curl -s 127.0.0.1:3001/health   # bot — gatewayConnected: true
curl -s 127.0.0.1:3002/health   # worker
curl -s 127.0.0.1:3003/health   # mcp
```

Send a real message in a real course channel and confirm the platform answers it — this exercises
`bot`, not `api`, so it is a real check of the cutover even while `api` is down. Only once `api`
itself has actually come up (`curl` above returns `{"ready":true,"database":true}`, not a
connection refusal) — not merely started — go back to the OpenAI dashboard and revoke the *old*
key from §2.3. Revoking it earlier, before confirming the new one is actually wired up anywhere
that reads it, would turn a rotation into a self-inflicted outage; if `api` cannot come up at
all yet, hold off revoking the old key until it can.

### 2.7 Arm alerting (OPS-12)

`ops-monitor` was already started in §2.5 — confirm `OPS_ALERT_WEBHOOK_URL` is set in `.env`
before this cutover, not after the first incident. See §5 below for what it does and what
"notified" means concretely.

---

## §3 Rollback (OPS-10)

The way back that does not depend on anything the cutover deleted: nothing in Phase 2 deletes
`response_bot.py`, `migrate.py`, `bot_config.yml` or the Python bot's own pm2 entry (§2.2
stopped it, never removed it), and §2.4's import writes new rows into the platform's own
tables without touching the ones the Python bot itself reads — D-9's "both systems can read
the same SQLite file" is exactly what makes this possible.

```bash
pm2 stop api bot worker mcp ops-monitor
pm2 start bloombot
```

No credential needs to change back. §2.3 rotated `BOT_TOKEN`/`OPENAI_API_KEY` once, into the
`.env` file both systems read — the Python bot picks up the same, already-rotated values the
platform was using, not the ones it had before cutover. There is nothing to un-rotate.

**How this is verified, not merely asserted:** §1.4 runs this exact sequence (against the
rehearsal's own processes) before the real cutover ever happens, and times it — so the number
an operator has going into Phase 2 is measured, not guessed. If §3's own rollback is ever
actually needed for real, treat it as a signal to re-run §1.4 again once things are stable,
the same way this slice's own rehearsal of `scripts/deploy.sh`'s rollback (§1.4) found and
fixed a real bug in it before it could be discovered live.

**What this does not undo:** the import in §2.4. Rolling the *processes* back to the Python
bot does not remove the people, courses and messages the import wrote into the platform's own
tables — MIG-4's own idempotency means running the import again later, once the real cutover
is retried, still costs nothing (everything from §2.4 is matched, not duplicated).

---

## §4 If the rollback itself fails

`scripts/deploy.sh`'s own `restore_previous_checkout` (used by every deploy *after* this
cutover, not by the manual sequence in §3 above) draws this distinction explicitly, and §1.4
found the reason it matters: a rollback that fails partway is not the same situation as a
deploy that never touched anything running. If `pm2 start bloombot` in §3 itself fails —
Python dependencies missing, `response_bot.py` itself broken — the platform's own processes
from §2.5 are still running; nothing has gone dark. Fix whatever broke `pm2 start bloombot`
and retry §3's second line alone; there is no need to repeat §3's first line or any of Phase
2.

---

## §5 What "notified" means (OPS-12)

`scripts/ops-monitor.mjs` polls `api`/`bot`/`worker`/`mcp`'s own `/health` endpoints
(`scripts/health-check.mjs`) every `OPS_ALERT_POLL_INTERVAL_MS` (default 30s) and — on a
transition from healthy to unhealthy, or back — POSTs a plain JSON body
(`{ "content": "...", "text": "..." }`, understood by a Discord or a Slack incoming webhook
without a vendor SDK) to `OPS_ALERT_WEBHOOK_URL`. "Unhealthy" covers everything COST-5 made
observable: the gateway disconnected (the bot's own `/health` goes `503`), the database
unreachable (any of the four), the job queue backing up is visible in the worker's own body
but does not by itself flip its status, and — the one case none of the four processes' own
HTTP status already reflects — the model provider's own running error rate climbing past 50%
over at least 5 calls, read from the same `model.calls`/`model.errorRate` numbers the bot's
`/health` body already carries.

Only a **transition** notifies, not every poll — a sustained outage produces one page, not
one every 30 seconds — and the monitor's own restart does not re-page for a problem it was
already watching before it restarted; it pages immediately, though, if a process is *already*
down the moment it starts polling.

If `OPS_ALERT_WEBHOOK_URL` is unset, the same transition is still written to
`logs/ops-monitor.log` (pm2 redirects this process's own stdout/stderr there, OPS-2) —
degraded, not silent, but nobody is paged unless something is also watching that file. Set
the webhook before the cutover in §2.7, not after the first incident makes the gap obvious.
