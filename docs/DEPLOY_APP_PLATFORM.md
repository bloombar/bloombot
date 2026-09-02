# Deploying to DigitalOcean App Platform — an honest assessment, not a walkthrough

> ## Read this first: there is no production email transport yet, on any host
>
> Before reading any further about App Platform specifically: `apps/api` refuses to start at
> all in `NODE_ENV=production` today, on a droplet or here, because no real `EmailSender` has
> been built yet (`packages/auth/src/email.ts`'s own module comment: "this package ships the
> interface and a recording fake for tests, never a real mail transport"). This is tracked as
> **AUTH-5** and is not specific to App Platform — [docs/DEPLOY_DROPLET.md](DEPLOY_DROPLET.md)'s
> own lead callout has the full detail. It is repeated here, first, because someone deciding
> between the two documents should not have to reach §4 of this one to learn it changes nothing
> about which platform to pick.

**This document is not a "how to deploy" in the same shape as
[docs/DEPLOY_DROPLET.md](DEPLOY_DROPLET.md).** It is written the way the rest of this repository
asks for a runbook to be written: correct, not merely correct in the abstract. The honest
answer for this platform's *current* architecture is that App Platform's component model does
not fit it, for reasons that are structural rather than a missing setting — and a document that
described a deployment which would silently corrupt data or drop jobs would be worse than one
that says so. Where a change would make it fit, this document says what that change is and how
far it is from being built; it does not build it.

If what you actually want is "get this running in DigitalOcean's App Platform product today,"
the answer below is: run it as **one App Platform component**, not four, on **exactly one
instance**, and only after reading §2's own limits and deciding you accept them — this is not
the platform's real production architecture (PLAT-4 names four independent, single-instance
processes on purpose) collapsed for App Platform's convenience; it is App Platform's own
constraints forcing a shape this repository does not otherwise choose. **[docs/DEPLOY_DROPLET.md](DEPLOY_DROPLET.md)
is the deployment this repository's own tooling (`ecosystem.config.cjs`, `scripts/deploy.sh`,
the CI deploy job) is actually built for, and is the recommendation** unless App Platform's own
operational properties (no server to patch, no droplet to size, DigitalOcean's own autoscaling
and zero-downtime deploys) are worth the migration work §3 describes.

> Product names, component types and their exact storage/networking behavior change; verify
> the specifics below against DigitalOcean's own current App Platform documentation before
> relying on them — this document's own claims come from this codebase's architecture and
> DigitalOcean's App Platform model as documented at the time of writing, not from a live
> deployment exercised against it as part of this slice.

---

## 1. Why the four-process, one-SQLite-file architecture does not map onto App Platform

Two properties this platform's own architecture depends on, and how App Platform's component
model breaks each:

**One file, five processes, one host.** `docs/DECISIONS.md`'s D-2 keeps SQLite deliberately,
with WAL and `busy_timeout`, explicitly because the deployment is single-host — "this holds
only while the deployment is single-host" is D-2's own limit, stated outright. `apps/api`,
`apps/bot`, `apps/worker` and `apps/mcp` each open the **same** file
(`packages/db/src/client.ts#openDatabase`, defaulting to `./data/data.db`) directly, as does the
background job queue's own atomic claim (`packages/db/src/repos/jobs.ts`, single-instance by
design, PLAT-4). App Platform's **Service**, **Worker** and **Job** components are each
independently scheduled, on their own container, with their own local disk — components do not
share a filesystem with each other. Deployed as four separate App Platform components the way
their names (api/bot/worker/mcp) would suggest, none of them could open the file any of the
others has open: this is not a permissions problem to fix, there is no file there to share.

**A local disk is not durable storage.** A Service or Worker component's own local disk on App
Platform is ephemeral: it does not survive a redeploy, a restart, or App Platform rescheduling
the container onto different underlying infrastructure — DigitalOcean's own answer for anything
that needs to persist is a Managed Database or Spaces (object storage), not local disk on the
component itself; App Platform does not offer an attachable persistent block volume for a
Service/Worker component the way a Droplet offers an attached Volume. Even collapsed into a
single component (§2), running this platform's current SQLite file on that component's own local
disk means the database — real students' names, emails and transcripts — is destroyed on the
*first* redeploy, restart, or reschedule, not a risk to weigh but a certainty to avoid. (Product
surfaces do change; if DigitalOcean has since added a persistent-volume option App Platform did
not have when this was written, that would change this section's own conclusion — verify against
their current documentation before trusting this claim's own currency, not before trusting its
substance.)

**Course attachments have the same problem, independently.** `ATTACHMENT_STORAGE_DIR`
(`packages/db/src/attachment-storage.ts`) is a local filesystem path, written by `apps/worker`
and read by `apps/api`/`apps/mcp` — the same "one shared local directory, several processes"
shape as the database, and the same failure on App Platform's component model.

## 2. If you still want to run it on App Platform today, unmodified

The only shape that avoids splitting the shared file across components no App Platform
component model lets you rejoin: run **api, bot, worker and mcp inside one component**, as one
container, pinned to **`instance_count: 1`**. That bounds *steady-state* replica count, but it
does not make a deploy a hard cutover: App Platform's own deploys are rolling by design — it
starts the new container, waits for it to become healthy, and only then stops the old one — so
two instances of this one combined component, each holding the same SQLite file open, are both
briefly live across every single deploy regardless of `instance_count`. That is exactly the
multi-writer scenario D-2 confines to a single host, on every deploy, not an edge case to
configure around. This needs:

- **A combined entry point** that starts all four processes' own `main()` in one Node process
  (or as child processes of one small supervisor) — nothing in `apps/*` is built to do this
  today; each is its own `apps/*/dist/index.js`, deliberately (PLAT-1's own "apps/ holds the
  four processes"). Writing this combinator is a real, if small, engineering task, not a
  configuration choice — it is not built here.
- **A persistent volume mounted into that one component — which App Platform does not offer for
  a Service/Worker component** (§1's own "a local disk is not durable storage"). Without one,
  this option does not meet the bar "does not risk data loss" and must not be used for real
  student data — and the rolling-deploy overlap above means even a persistent volume would not
  be enough on its own, since two containers would still briefly share it as two writers.
- **The static panel served separately** — App Platform's own **Static Site** component type
  is a reasonable fit for `apps/web/dist` (it is exactly what it is for), proxied to the
  combined component's own API routes (`/health`, `/auth`, `/organizations`, `/admin` —
  `apps/web/vite.config.ts`'s own dev-time proxy names the same list) the way App Platform's
  own routing rules support cross-component paths. `/admin` is `apps/api`'s own mount for the
  platform-administrator console (`routes/admin.ts`), a different path from the panel's own
  `/platform-admin` page — the same collision `docs/DEPLOY_DROPLET.md`'s own nginx block and
  `docs/DECISIONS.md` D-48 both name, and the same reason to not drop it here either: an
  administrator console that cannot reach its own API fails silently, not loudly.

This is not a recommendation, only what the constraint in §1 leaves as an option if a Postgres
migration (§3) is not on the table yet. It gives up App Platform's own horizontal scaling and
zero-downtime deploys — the two things App Platform is usually chosen for — while keeping
every one of D-2's single-host assumptions, on a platform whose whole value proposition assumes
you do not need them.

## 3. What would actually make this fit — a Postgres migration, honestly scoped

D-2's own text is direct about this: "Postgres is a configuration change rather than a
rewrite" — but that claim rests on rules D-2 itself calls load-bearing, and "configuration
change" undersells the work by omission of what still needs building, not by being wrong about
the schema layer. What is already true today, and what is not yet:

**Already true — the schema and query layer.** Every query lives in `packages/db/src/repos/`,
using Drizzle against a schema written to a portable subset (no SQLite-only idioms outside
`migrations/`, money as integer micros, a CI migration-parity check keeping the claim honest —
D-2's own "Limits" paragraph). Swapping `better-sqlite3`/`drizzle-orm/better-sqlite3` for a
Postgres driver and `drizzle-orm/node-postgres` (or DigitalOcean's own Managed PostgreSQL
connection string) is close to what D-2 promises: a driver and a migration-generation target,
not a rewrite of every repo function.

**Not yet built — the job queue's own claim.** D-2's own "Limits" paragraph names "the
job-claim dialect split isolated behind one repo function" as one of the rules that keeps the
Postgres escape hatch open — meaning the *seam* exists (`packages/db/src/repos/jobs.ts`'s own
claim function is the one place this would need to change), but the **Postgres-side
implementation of that claim does not exist yet**. SQLite's WAL + single-writer model is what
`apps/worker`'s current claim leans on; a real multi-writer deployment (which App Platform's
own horizontal scaling exists to let you do) needs the standard Postgres pattern for this —
`SELECT ... FOR UPDATE SKIP LOCKED` — written, tested, and run through this project's own
migration-parity check, not assumed to fall out of switching the driver.

**Not yet built — attachment storage.** `packages/db/src/attachment-storage.ts`'s own
`AttachmentStorage` interface already separates the port from its one implementation
(`createFilesystemAttachmentStorage`) — swapping to DigitalOcean Spaces (S3-compatible object
storage) is a new implementation of an interface that already exists, not a new abstraction to
invent, but it is not written.

**Once those two are built,** api/bot/worker/mcp become genuinely independent App Platform
Service/Worker components, each free to scale (worker and bot still single-instance by their
own design — PLAT-4 — but api could scale horizontally for the first time), a DigitalOcean
Managed PostgreSQL cluster replaces the shared SQLite file, DigitalOcean Spaces replaces
`ATTACHMENT_STORAGE_DIR`, and the static panel is an App Platform Static Site pointed at
`apps/web/dist`. This is the shape App Platform is actually for. It is a scoped follow-on
slice, not a checkbox in this one — say so plainly if asked to "just deploy it to App Platform"
without this work having happened first.

## 4. Everything else — env vars and third-party setup

Identical to [docs/DEPLOY_DROPLET.md](DEPLOY_DROPLET.md)'s own §3.1 (every variable, what it is
for, what breaks) and §4 (Discord, OpenAI, Google Cloud, and the same missing-email-transport
gap that document's own callout describes — App Platform does not change that fact, and the
same warning applies here without qualification). App Platform's own **App-Level Environment
Variables** (or a component's own, if the combined-component shape in §2 is used) replace
`.env` — mark every credential-shaped one **encrypted**, App Platform's own equivalent of this
repository's own QA-6 "a credential is never committed" discipline. `PUBLIC_APP_URL` is the
App Platform-assigned domain, or a custom domain once attached — the same AUTH-3 origin check
described in the droplet document applies unchanged.

**Backups and logs** are DigitalOcean-managed once a Postgres migration (§3) is in place — the
managed database's own automated backups replace §8.1 of the droplet document, and App
Platform's own log destinations replace `LOGS_DIR`/pm2's log files. Neither of those exists for
the SQLite-on-local-disk shape in §2 — see §1's own warning about durability.

## 5. Droplet vs. App Platform — where they actually differ

| | Droplet (recommended today) | App Platform, unmodified (§2) | App Platform, after a Postgres migration (§3) |
| --- | --- | --- | --- |
| Matches this repository's own tooling (`ecosystem.config.cjs`, `scripts/deploy.sh`, CI) | yes, directly | no — needs a combined entry point | no — needs the combined entry point *and* the migration |
| Data durability | real (a real disk, backed up per §8.1) | **not guaranteed** — see §1 | real (managed Postgres) |
| Horizontal scaling / zero-downtime deploys | no (single droplet, single-writer SQLite by design) | no — worse than the droplet, since it gives up App Platform's own value for none of the benefit | yes, for `api`; `bot`/`worker` stay single-instance by PLAT-4's own design regardless of host |
| Operational burden | patch and size a server yourself | DigitalOcean-managed compute, same single-instance/no-volume caveats as the droplet without the droplet's own control over them | DigitalOcean-managed compute *and* database |
| Engineering work still needed | none — this is the built architecture | a combined entry point (small, but real) | the combined entry point avoided, but the job-claim dialect and attachment-storage adapter (real, scoped work) |

**Recommendation:** deploy to the droplet ([docs/DEPLOY_DROPLET.md](DEPLOY_DROPLET.md)) today.
Revisit App Platform once — and only once — a Postgres migration and an object-storage
attachment adapter are their own scoped, deliberately-built slice; §2's unmodified option is
not a safe middle ground for real student data and should not be used for it.
