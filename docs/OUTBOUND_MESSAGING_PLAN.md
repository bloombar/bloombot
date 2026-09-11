# Outbound messaging — plan

An organization owner can ask the platform to send a message on their behalf — to one enrolled person, or
to everyone enrolled on a course — and the platform records it, attributes it to them, delivers it on the
surface each recipient actually reads, and tells them who it could not reach. The one architectural idea
that makes this consistent across surfaces is that **sending is a capability of the action layer, not a
feature of a surface**: `messages.send` is an ordinary `Action` whose authorization, refusals, confirmation
gate and audit are identical wherever it is invoked from, and each surface contributes exactly three small
adapters — a way to _ask_ for it (a panel screen, an MCP tool, an assistant turn), a way to _confirm_ it
(`ConfirmationPort`), and a way to _deliver_ to a person who lives on that surface (`DeliveryTransport`).
Everything else — the policy, the owner check, the per-recipient outbox, the idempotency, the report,
the rate bound — is written once and inherited. A surface added later implements three small interfaces and
declares by name which capabilities it takes; it gets the rest for free, and gets nothing it did not name.

**Which surfaces can actually send, and when.** This is stated here rather than left to be inferred from the
build sequence, because the honest answer is not "all three at once".

- **During Phase 29, before S5 merges:** none. S1–S3C build the schema, the action, the transport and the
  outbox; nothing is exposed to a human yet.
- **At the end of Phase 29:** the **panel** can send (S5 — compose, confirm, report) and **MCP** can send
  (S7 — the tool plus the elicitation adapter that actually mints the grant). **Discord delivers but cannot
  originate**: a student is reached in a Discord channel or DM, and a student who replies to a DM gets a
  reply telling them where to ask — a fixed, model-free answer, not an assistant answer (S3C, MSG-18) — but
  an owner standing in Discord still has no way to _ask_ for a send. That is not an oversight: the Discord
  ask needs a confirmation primitive (§7) and a tool-calling loop (§8), both of which are Phase 30 work.
- **At the end of Phase 30:** all three ask. The panel's own assistant and the Discord bot both invoke
  `messages.send` through `invokeCapability`, each behind its own `ConfirmationPort`.

## What exists today

**The action layer** (`packages/actions`). An `Action` is six fields — `name`, `description`,
`inputSchema` (zod), `policy` (required, so an action without one does not compile — ACT-2), an optional
`meter`, and `execute` (`packages/actions/src/types.ts`, `Action`). `dispatch`
(`packages/actions/src/dispatch.ts`) runs validate → authorize → meter → execute. A `Policy` sees only
`{ organizationId, db }` (`packages/actions/src/policy.ts`, `PolicyContext`) and returns the tenant-scoped
entity or `undefined`, which is the single refusal channel (`ActionRefusedError`). `DispatchContext` is
`{ organizationId, db, accountId? }`, and its own doc comment says `accountId` is never read out of the
action's input, because "a self-reported author would be a forgeable audit trail". `createPlatformRegistry`
(`packages/actions/src/actions/index.ts:220`) registers **50** actions today — verified by
`grep -c 'registry.register(' packages/actions/src/actions/index.ts` and by the 50 rows in
`EXPECTED_DESCRIPTORS` (`packages/actions/tests/access-audit.test.ts`), which fails if the two ever diverge.
Its signature is `createPlatformRegistry(options?: { attachmentStorageDir?: string; joinLinkEncryptionKey?:
Buffer })` — **all-optional**, and it constructs `createFilesystemAttachmentStorage(...)` itself; there are
21 call sites, two in production (`apps/api/src/server.ts:112`, `apps/mcp/src/index.ts:91`) and 19 in
`apps/mcp` tests calling it with no arguments at all. That fact constrains §1, and is why this draft adds
no new option to it. Because a policy cannot see the caller, every "only an owner may do this" rule lives
inside `execute`, reading `accountId` and calling `memberships.getMembership` — `memberships.grant`
(`packages/actions/src/actions/memberships.ts`) is the exemplar. `packages/actions/package.json` declares
exactly four dependencies: `@bloombot/db`, `@bloombot/schemas`, `yaml`, `zod`. **No action schema in the
tree is strict** — `grep -rn '\.strict()' packages/actions/src` returns nothing — so zod strips unknown keys
silently today.

**The data model** (`packages/db`). `SURFACES = ['discord','web','mcp']` (`packages/db/src/schema.ts`).
`person_identities(organizationId, personId, surface, externalId)` is unique per
`(organizationId, surface, externalId)`. A `web` identity's `externalId` _is_ an account id
(`packages/auth/src/sign-in.ts`; `apps/api/src/routes/chat.ts`), which is the only link between an account
and a person. `conversations` are keyed on `(course, person, surface)` where `surface` is `null` under the
course's default `conversationScope: 'course'` and set under `'course_surface'`
(`packages/db/src/repos/conversations.ts`, `getOrCreateConversation`). `messages` has columns
`id, organizationId, conversationId, personId, courseId, direction, content, surface, channelRef,
categoryRef, sequence, createdAt`, with CHECK constraints pinning `direction` to
`('from_person','to_person')` and `surface` to the three literals, and **no author column and no delete
path** (TEN-6). `appendMessage` (`packages/db/src/repos/conversations.ts:441`) derives `personId`/`courseId`
from the conversation, assigns `sequence` inside its own `writeTransaction(..., { behavior: 'immediate' })`,
and retries a transient `SQLITE_BUSY` up to `MAX_APPEND_MESSAGE_ATTEMPTS` (3) — CONV-4/D-49.
`roster_channel_assignments` durably remembers a per-student private Discord channel, unique per
`(courseId, personId)` and globally unique per channel, written **only** by the roster-import handler; its
columns are `id, organizationId, courseId, personId, discordChannelId, createdAt` — **no guild id**, which
§4 has to account for. A course's guild comes from `courses.discordServerId`
(`packages/db/src/schema.ts:268`, nullable) through `repos/discord-servers.ts#resolveCourseDiscordServer`'s
single-binding fallback.

**Tenant deletion is a hand-maintained ordered list.** `deleteOrganizationData`
(`packages/db/src/repos/organizations.ts`) opens a `writeTransaction`, reads
`previewOrganizationDeletion` inside it, and then issues one `tx.delete(...)` per organization-scoped table
in FK-safe order — **`tx.delete(messages)` is the first statement** (`:299`), and `tx.delete(organizations)`
the last. The function carries its own scar tissue: the `rosterChannelAssignments` delete is preceded by a
comment naming ROST-17 and saying in as many words that "missing this row is exactly why deleting an
organization that had ever run a roster import creating a student channel used to throw
`FOREIGN KEY constraint failed` on the `people` delete below." `OrganizationDeletionPreview` is a fixed
interface of counts (including `rosterChannelAssignments`, added by that same fix), and
`packages/db/tests/organizations-deletion.test.ts`'s `seedFullTenant` seeds only the tables it knows about
— so a table added and forgotten breaks production while that test stays green.

**Three writers of `messages` rows, not one.** `packages/core/src/answer.ts:507` (`from_person`) and
`:698` (`to_person`), **and** `packages/legacy-import/src/import-messages.ts:239` (MIG-3), which
`NewMessage.createdAt`'s own doc comment names as the one caller that supplies a timestamp.

**The transcript readers are a fourth path.** `packages/db/src/repos/transcript-access.ts:37` declares
`TranscriptEntry` as exactly `{ personId, personDisplayName, direction, content, createdAt }` and
`readCourseTranscript` writes the ADMIN-2 audit row as part of the read. Its consumers are
`apps/web/src/pages/Transcripts.tsx` (which hand-mirrors the shape in `apps/web/src/api/types.ts:586`,
because apps/web may not import `@bloombot/db`) and `apps/worker/src/handlers/transcripts.ts:188` (the
ADMIN-3 export). `analytics.ipynb` at the repository root also queries `messages` directly.

**The three surfaces.** _Discord_: `apps/bot` holds the only gateway connection (PLAT-3) and replies
through `buildReplyPort` (`apps/bot/src/reply-port.ts`), the only place `message.reply` is called, which
sets `allowedMentions: SUPPRESS_ALL_MENTIONS` on every call (D-17). `apps/bot` registers no
`InteractionCreate` handler and exposes no inbound interface but a loopback health endpoint. Its `Client`
declares exactly four intents — `Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`
(`apps/bot/src/index.ts:135`–`:144`) — **no `DirectMessages` and no `Partials`**, and
`apps/bot/src/message-handler.ts:46` is `if (!message.inGuild()) return`. _Web_:
`apps/api/src/routes/chat.ts` mounts `GET /courses`, `GET /courses/:courseId/messages` and
`POST /courses/:courseId/messages`; every one resolves the caller to a **connected person**
(`resolveConnectedCallerPerson`) and then `enrolments.resolveChatAdmission` — an owner who is not an
enrolled person on that course gets `404 chat_not_connected` / `chat_course_not_found`. The transcript GET
calls `conversations.getTranscript(organizationId, conversationId, db)` (`chat.ts:289`), which takes no
cursor, and `apps/web/src/pages/Chat.tsx` has no polling, no SSE and no EventSource anywhere in the tree;
four other panel components do poll on an injectable `pollIntervalMs` (`ScaffoldButton`, `RosterImport`,
`CourseAttachments`, `Transcripts`). _MCP_: `apps/mcp` has three independent registration paths —
`MCP_TOOL_SURFACE` (a hand-edited allowlist of **24** entries, dispatched through
`apps/mcp/src/call-tool.ts` behind a `memberships.getMembership` gate), `MCP_CHAT_TOOL_SURFACE` (a second
array with a different entry type, registered directly, deliberately **not** membership-gated because it is
authorized by enrolment), and `bloombot_connectAssistant` hardcoded in `server.ts`. MCP-4's confirmation is
raised in `call-tool.ts` **before** `dispatch`, through an injected `requestConfirmation` that returns a
**boolean**, implemented by `requestElicitedConfirmation` in `server.ts` over `extra.sendRequest` (never
`elicitInput`, a reproduced silent-drop bug) and failing closed.

**The generic HTTP action route.** `POST /organizations/:organizationId/actions/:actionName`
(`apps/api/src/routes/actions.ts`) dispatches **any** registered action for any member, with no
confirmation hook of any kind. It passes `req.body` straight through as the action input:
`dispatch(action, req.body, { organizationId, db, accountId: req.session.accountId })`.

**The job runner.** An action enqueues (`jobs.enqueueJob(organizationId, { kind, payload, maxAttempts,
availableAt? }, db)`) and a handler in `apps/worker/src/handlers/*` does the I/O. `enqueueJob`
(`packages/db/src/repos/jobs.ts:110`) writes `nextAttemptAt: input.availableAt ?? now` — **a job can be
enqueued not-yet-runnable today, with no schema change**, which §4 relies on. `claimNextJob` (`:210`)
selects `.orderBy(asc(jobs.nextAttemptAt)).limit(1)` over rows that are `pending` with
`nextAttemptAt <= now` or `running` with a lapsed lease — **strict FIFO over runnable rows, with no
per-tenant fairness of any kind**. `completeJob` and `markJobFailed` both NULL the payload in the same
write (JOB-6), so a `failed` job is terminal and has forgotten its input. Retryability is a `permanent`
property on the thrown error (`DiscordRequestError.permanent = status >= 400 && status < 500 && status !==
429`, `packages/discord-rest/src/client.ts:141`), read by `packages/jobs/src/runner.ts`. **`apps/worker`
runs exactly one job at a time** (`apps/worker/src/loop.ts`: it sleeps only when the outcome is `empty`),
and PLAT-4 fixes it at one instance. `JobContext` (`packages/jobs/src/registry.ts:15`) carries
`organizationId`, `jobId`, `attempts` and a `logger`. Handler budget is `JOB_HANDLER_TIMEOUT_MS`
(240 000 ms, `packages/config/src/env.ts:141`) and the job's own claim lease is `JOB_CLAIM_LEASE_MS`
(300 000 ms, `:127`) — that file's own comment says the handler timeout "defaults under
`JOB_CLAIM_LEASE_MS`'s own default so a timeout fires … while the lease this attempt claimed the job under
is still comfortably held". Each Discord REST request gets one third of the handler budget
(`apps/worker/src/index.ts:140`, `timeoutMs: Math.floor(handlerTimeoutMs / 3)` — 80 s); shutdown drains for
`drainTimeoutMs ?? 30_000` (`apps/worker/src/shutdown.ts:97`) and its own comment says a job still running
past the drain has its claim left to lapse on its lease (JOB-3). `apps/worker/src/index.ts:125`–`:140`'s
own comment says an abandoned handler's request "might still be writing to a socket underneath it", because
JavaScript cannot cancel it — which §4's claim lease has to survive.

**One bot token, two processes.** `apps/worker/src/index.ts:116` reads `BOT_TOKEN` and builds Discord REST
clients at `:162` and `:175` with the same token `apps/bot`'s gateway holds. Discord's global limit and its
per-route buckets are **per token, not per process**, so anything the worker opens competes with the
gateway process's own REST traffic. §4 treats that as a first-class constraint, not a footnote.

**The Discord REST client has no rate-limit handling at all.** `packages/discord-rest/src/http.ts` is 181
lines: an `AbortController` timeout, a fetch, a tolerant JSON parse, and
`return { status, ok, body }` — **the response headers are discarded** (`:85`). `DiscordRequestError` keeps
`status` and `body` only; nothing reads `Retry-After`, `retry_after`, `X-RateLimit-Global` or any other
`X-RateLimit-*` header, and there is no retry loop, no bucket and no queue anywhere in the package. A 429
is classified retryable and handed to the job runner's generic backoff, which re-runs the whole handler.

**Observability.** `packages/logger` is pino-backed JSONL, one file per process, `createLogger(name)`,
nothing at import time (PLAT-5). `apps/worker` already depends on it (`apps/worker/package.json`) and
threads a `Logger` into `runNextJob`, which puts it on every `JobContext`. `apps/worker/src/health.ts`'s
`checkWorkerHealth` returns exactly `{ ready, database, queueDepth }`, and `ready` is `database` and
nothing else. `scripts/ops-monitor.mjs` (OPS-12) polls those `/health` endpoints on
`DEFAULT_POLL_INTERVAL_MS` (30 000, `:56`) and pages an operator on a healthy→unhealthy _transition_. Its
decision function is **`evaluate(result, previousModel)` (`:107`)** — there is no `verdictFor` — and it
threads a per-process `{ calls, errors, verdict }` snapshot through
`planNotifications(previousHealthy, previousModel, results)` (`:227`), which pushes one notification per
transition in either direction.

**Deployment.** `scripts/deploy.sh` runs, in order: `npm ci` → build → `backup_database` → migrate → reload
every supervised pm2 process, then watches each for `HEALTH_WAIT` seconds and polls
`scripts/health-check.mjs`. **Its rollback is automatic, and it is a _code_ rollback only**: a failed
`reload_everything` (`:979`) or any unhealthy process after the health check (`:1032`) calls
`restore_previous_checkout` and reloads the previous commit, and **never restores the backup it just
took** — the header says the restore is by hand, "docs/DEPLOY_DROPLET.md's own §8.1 has the restore
procedure". `confirm_rolled_back_online` checks pm2 `status = online` only. The backup itself is
OPS-19/D-104 — `better-sqlite3`'s `Database#backup()`, verified with `pragma integrity_check` and switched
out of WAL mode, because the droplet has no `sqlite3` CLI and an unresolvable driver fails loudly rather
than falling back to `cp`. `runMigrations` (`packages/db/src/migrate.ts:45`) toggles `foreign_keys = OFF`
at the connection level around the batch and runs `PRAGMA foreign_key_check` afterward; its own comment
records that **drizzle-orm's `migrate()` wraps every pending migration file in one `BEGIN`/`COMMIT`**, so a
single migration file is atomic — the header's "fails partway through" is about a _batch_ of files, not a
statement inside one. `ecosystem.config.cjs` lists six apps, `apps[0]` being the legacy Python bot
`bloombot`; `DEPLOY_SKIP_PYTHON_BOT` is a repository variable **already set to `1`**
(docs/DEPLOY_DROPLET.md:901), which makes the deploy pass `PM2_APP=` and skip it.

**Deployment is automatic.** `.github/workflows/ci.yml`'s deploy job is
`if: github.ref == 'refs/heads/master' && (github.event_name == 'push' || github.event_name ==
'workflow_dispatch')`, needs the three test jobs, and runs `environment: production`. **A merge to master
ships and migrates, with no human step in between** — unless the `production` environment has a required
reviewer, which that job's own comment names as the way to add one ("Adding required reviewers to this
environment turns every deploy into an approval click", `ci.yml:145`–`:146`). The job composes the remote
command itself: `remote="APP_DIR='$DEPLOY_PATH' bash -s -- $TARGET_SHA"` (`:253`), with `DEPLOY_PATH` a
**required** repository variable — the workflow refuses to run without it (`:245`), because deploy.sh's own
`APP_DIR` default (`$HOME/discord-channel-manager`, `deploy.sh:73`) is the legacy Python checkout and the
first real deploy of this platform reset it by mistake.

**The model port.** `ModelClient.ask(request: ModelRequest): Promise<ModelAnswer>`
(`packages/core/src/ports.ts`) — one call per turn. `ModelAnswer` carries `text`, `upstreamThreadId`,
`model` and optional `usage`; `answer.ts` needs all of them (`computeCost` →
`costLedger.recordCostLedgerEntry`). Continuity is provider-side, through `upstreamThreadId`.

## The gaps

1. **Nothing can initiate a message.** `packages/discord-rest`'s `DiscordRestClient` has fourteen methods
   and none of them posts a message or opens a DM (`packages/discord-rest/src/client.ts`); its module
   comment makes the absence of write verbs a deliberate structural guarantee. Web replies are the HTTP
   response to a POST. MCP replies are the tool result.
2. **There is no inbox on the web.** No SSE, no EventSource, no WebSocket in `apps/api/src` or
   `apps/web/src`; `getTranscript` has no cursor parameter and `Chat.tsx` refetches only on course change.
3. **There is no push on MCP.** An unsolicited notification routes to the standalone `GET /mcp` SSE stream
   and is silently discarded when the client has not opened it (`apps/mcp/src/server.ts`, the
   `requestElicitedConfirmation` module comment, from a reproduced CI bug); `sendLoggingMessage` is a
   no-op unless the server declares the `logging` capability, and `buildMcpServer` declares only
   `{ tools: {} }`. Sessions are in-process, capped per account, idle-swept and lost on restart.
4. **`messages` cannot record an author.** No author column, and `direction` is CHECK-constrained to two
   values, so a staff message is today indistinguishable from an assistant answer — for the chat window,
   for `Transcripts.tsx`, for the ADMIN-3 export and for `analytics.ipynb` alike.
5. **The platform's own model cannot call anything.** `ModelClient.ask` is one-shot text-in/text-out and
   `packages/openai/src/responses.ts` sends only provider-hosted `file_search` and `web_search`. On MCP the
   _client's_ model is the agent; on Discord and the web the _platform's_ model is, and it can invoke
   nothing.
6. **Capabilities do not transfer to a new surface.** They are three hand-maintained shapes inside
   `apps/mcp` (above), plus an audit table (`apps/mcp/tests/tool-surface.test.ts`, `EXPECTED_DESTRUCTIVE`)
   that must move with them.
7. **Confirmation is a property of one route, not of the action.** MCP-4's gate lives in
   `apps/mcp/src/call-tool.ts`; `apps/api/src/routes/actions.ts` dispatches `courses.save` and
   `courseAttachments.detach` unconfirmed today. Any new irreversible action inherits that hole.
8. **Nothing can be said about who is reachable.** `people.getPersonIdentity` returns the _oldest_ identity
   on a surface and its own doc comment says more than one per surface is routine after a merge and that
   ordering only makes the choice deterministic, "not fix the underlying imprecision". A Discord
   `externalId` may be the synthetic `handle:<handle>` string the roster import mints when it cannot resolve
   a handle (`apps/worker/src/handlers/roster-import.ts`), which addresses nobody.
9. **A Discord DM is a conversational dead end.** With no `DirectMessages` intent and no `Partials.Channel`
   the gateway never delivers a DM event at all, and `message-handler.ts:46` would drop it anyway. A
   student who replies to a message the platform DMs them gets no answer, no log line and no transcript
   row — the silent drop SURF-6 exists to forbid.
10. **The REST client cannot be paced.** No header is read, no bucket exists, and a 429 becomes a whole-job
    retry on the runner's generic backoff rather than Discord's stated delay — on the same token the
    answering gateway depends on.
11. **Tenant deletion has no mechanism that notices a new table.** It is an ordered list a human maintains,
    and its test seeds only the tables it already knows.
12. **The queue has no fairness.** `claimNextJob` is strict FIFO over runnable rows and the worker runs one
    at a time, so anything that enqueues many jobs at once puts every other tenant behind all of them.

## Design

### 1. Reachability — a tenant-scoped database read in `packages/db`, so the action can just call it

Surface selection has to happen **before** the message row is written, because
`conversations.getOrCreateConversation` takes a `surface` and a course with `conversationScope:
'course_surface'` keys the conversation by it — a row written under the wrong surface lands in a
conversation the recipient's own surface never reads.

**Where it lives, and why this draft no longer builds a port for it.** The previous draft put
`resolveReachability` in a new `packages/messaging` package and had `packages/actions` declare a
`ReachabilityResolver` interface for it. That does not type-check and it does not wire: the declared
interface returned `Reachability`, a type that existed only in `packages/messaging`, while the draft
asserted in as many words that `packages/actions` "never imports `@bloombot/messaging`"; and nothing could
inject the concrete resolver, because `createPlatformRegistry(options?)`
(`packages/actions/src/actions/index.ts:220`) takes all-optional options and has 21 call sites, 19 of them
zero-argument calls in `apps/mcp` tests — so a required `reachability` option breaks all of them, and a
default built inside `packages/actions` needs exactly the import the draft forbade.

The escape is to notice that resolution is **not a port at all**. It is a read of `person_identities` and
`roster_channel_assignments`, both tenant-scoped, with no I/O, no clock and no process-level dependency —
which is the exact description of everything already in `packages/db/src/repos`. So it goes there:

```ts
// packages/db/src/repos/reachability.ts  — a repo module, like people.ts and enrolments.ts
export function resolveReachability(
  organizationId: string,
  courseId: string,
  personId: string,
  db: Executor,
): Reachability;
```

`packages/actions` already depends on `@bloombot/db` (`packages/actions/package.json` declares exactly
`@bloombot/db`, `@bloombot/schemas`, `yaml`, `zod`) and already calls `courses.getCourse`,
`memberships.getMembership` and `enrolments.*` from it. So `messages.send` calls `resolveReachability`
directly: **no new package, no new dependency edge, no new tsconfig project reference, no interface, no
injection, and no change to `createPlatformRegistry`'s signature or its 21 call sites.** It also puts the
logic inside the coverage floor `.claude/CLAUDE.md` enforces over `packages/db/repos`, rather than in a new
package that would need its own coverage entry. `resolveSpeakerAuthority` (§8) is the same kind of read and
goes to `packages/db/src/repos/speaker-authority.ts` for the same reason. **`packages/messaging` is not
created by this plan.** _Rejected:_ the port-and-new-package shape — a port exists to keep I/O out of a pure
layer, and there is no I/O here to keep out.

**The reason vocabulary and the result types live in `packages/schemas`.** MSG-24 and MSG-12 require the
panel to render each reason as something a person acts on, and `apps/web` may import `@bloombot/schemas`
and nothing else from the workspace (PLAT-2, enforced by `BROWSER_FORBIDDEN_PACKAGES` in `eslint.config.js`
— a hardcoded list). `packages/schemas` depends on zod alone, which is exactly what makes it the only
shared home a browser bundle and a database package can both reach. Putting the union anywhere else
guarantees a hand-copied duplicate in `apps/web/src/api/types.ts` that drifts the first time a reason is
added.

```ts
// packages/schemas/src/messaging.ts  — imports zod and nothing else
export const UNREACHABLE_REASONS = [
  'no_identity', // no identity on any surface this platform can deliver to
  'handle_only', // the only Discord identity is the synthetic `handle:` placeholder
  'ambiguous_identity', // more than one real identity on the preferred surface after a merge
] as const
export type UnreachableReason = (typeof UNREACHABLE_REASONS)[number]

export const DELIVERY_FAILURE_REASONS = [
  'channel_not_permitted', // the remembered private channel no longer grants this person read
  'dm_closed', // the recipient does not accept direct messages from this bot
  'rate_limited', // the surface refused for long enough that the batch gave up (MSG-15)
  'transport_refused', // a settled, non-retryable refusal from the surface
] as const
export type DeliveryFailureReason = (typeof DELIVERY_FAILURE_REASONS)[number]

export type DeliveryReason = UnreachableReason | DeliveryFailureReason

/** The surfaces this platform can actually deliver to. `mcp` is deliberately absent — §4. */
export type DeliverySurface = 'discord' | 'web'

/** Where a recipient is reachable. Never a DM channel id: a DM channel is opened at delivery time, never stored. */
export interface ReachableRecipient {
  personId: string
  surface: DeliverySurface
  /** Opaque to every caller but the transport for `surface`. Discord: the member snowflake. Web: the person id. */
  address: string
  /** Discord only, and only a *candidate*: the transport re-checks the channel's current per-person overwrite before using it. */
  candidateChannelId: string | null
}

export type Reachability =
  | { kind: 'reachable'; recipient: ReachableRecipient }
  | { kind: 'unreachable'; personId: string; reason: UnreachableReason }
```

Declaring `DeliverySurface` here rather than reusing `SURFACES` from `packages/db` is deliberate, and is
what turns "MCP is never a delivery surface" into a *type* error rather than a comment: a transport
registered for `mcp` does not compile.

`not_enrolled` is **not** in that list, and that is deliberate. A `person` audience whose enrolment has
ended is refused in `execute` (§3 step 4) with the same bare `ActionRefusedError` a foreign course raises,
and a `course` audience derives its recipients from `enrolments.listPeopleForCourse`, so every recipient
handed to the resolver is enrolled by construction. A `not_enrolled` reason could therefore only ever
surface as a race, and if it did it would report enrolment state through the send's own output — which is
precisely the disclosure MSG-3 exists to prevent. The enrolment decision belongs to the action, and the
resolver does not repeat it.

Preference order is `discord`, then `web`, and `mcp` is never a delivery surface (§4). `discord`
reachability means: list **every** `discord` identity the person holds in this organization (not
`getPersonIdentity`, which returns the oldest and would pick a stale or synthetic row — gap 8), discard
`handle:`-prefixed ones, and require exactly one survivor; two survivors are `ambiguous_identity`, which is
recorded as unreachable rather than guessed at. The order and the refusals are recorded as **D-109**.

**A new surface implements:** one branch of `resolveReachability` — how to find that surface's address for
a person, from the identity rows that surface already writes — and one member of `DeliverySurface`.
**It gets for free:** the ordering, the ambiguity refusal, and the whole `unreachable` reporting path.

### 2. The schema change — attribution, an outbox, announcements, and confirmation grants

Four changes, one migration file, generated by `drizzle-kit generate` **and then hand-edited** (see "How it
migrates"), journaled in `packages/db/migrations/meta/_journal.json` (the newest tag today is
`0029_purple_pretty_boy`).

```ts
// packages/db/src/schema.ts
export const MESSAGE_AUTHORS = ['person', 'assistant', 'account', 'unattributed'] as const

// messages — two new columns, plus two new CHECKs
authoredBy: text('authored_by', { enum: MESSAGE_AUTHORS }).notNull().default('unattributed'),
authoredByAccountId: text('authored_by_account_id').references(() => accounts.id),
// check('messages_authored_by_check',
//   "authored_by in ('person','assistant','account','unattributed')")
// check('messages_authored_by_account_check',
//   "(authored_by = 'account') = (authored_by_account_id is not null)")

export const DELIVERY_STATES = ['pending', 'claimed', 'sent', 'unreachable', 'failed'] as const

export const announcements = sqliteTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id),
    courseId: text('course_id').notNull().references(() => courses.id),
    sentByAccountId: text('sent_by_account_id').notNull().references(() => accounts.id),
    audienceKind: text('audience_kind', { enum: ['course', 'person'] }).notNull(),
    audiencePersonId: text('audience_person_id').references(() => people.id),
    /** The owner's own text, exactly as typed. Retained: this is the record, not the job payload (JOB-6). */
    body: text('body').notNull(),
    /** MSG-9. */
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at').notNull(),
  },
  // The ARRAY form, which is what every table in this file uses (`schema.ts:125`, `:177`, `:299`, `:413`,
  // `:465` and throughout, drizzle-orm ^0.45.2). The object form is deprecated, and a snippet written in
  // it is a snippet somebody copies.
  (table) => [
    /** MSG-9's uniqueness, as a constraint rather than as a comment. SQLite treats NULLs as distinct in a
     *  unique index, so any number of announcements may carry no key — which is the common case. */
    uniqueIndex('announcements_org_idempotency_key').on(table.organizationId, table.idempotencyKey),
    index('announcements_organization_id_idx').on(table.organizationId),
    /** The organization window (§3 step 3) counts one tenant's rows in a time range. */
    index('announcements_org_created_at_idx').on(table.organizationId, table.createdAt),
  ],
)

export const messageDeliveries = sqliteTable(
  'message_deliveries',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id),
    announcementId: text('announcement_id').notNull().references(() => announcements.id),
    personId: text('person_id').notNull().references(() => people.id),
    /** Null only while `state` is `unreachable` with reason `no_identity`. */
    surface: text('surface', { enum: SURFACES }),
    /** Null until the row is appended — an `unreachable` recipient gets no messages row. */
    messageId: text('message_id').references(() => messages.id),
    state: text('state', { enum: DELIVERY_STATES }).notNull(),
    /** MSG-11: a `DeliveryReason` from `@bloombot/schemas`, never a provider body, an id or a handle. */
    detail: text('detail'),
    claimedBy: text('claimed_by'),
    claimExpiresAt: integer('claim_expires_at'),
    attempts: integer('attempts').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('message_deliveries_organization_id_idx').on(table.organizationId),
    /** The status read-back (§3), the re-drive (§10) and MSG-28's reconciler all scan one announcement. */
    index('message_deliveries_announcement_id_idx').on(table.announcementId),
    /** MSG-28's health count runs on every ops-monitor tick (30 s, `scripts/ops-monitor.mjs:56`) and on
     *  every deploy health check, against the same single-writer file the bot is writing student answers
     *  into. Without this it is a full scan of the largest new table on the box, twice a minute, forever.
     *  It is also the claim protocol's own `WHERE` shape (§4). */
    index('message_deliveries_state_claim_expires_at_idx').on(table.state, table.claimExpiresAt),
  ],
)

export const confirmationGrants = sqliteTable(
  'confirmation_grants',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull().references(() => organizations.id),
    accountId: text('account_id').notNull().references(() => accounts.id),
    actionName: text('action_name').notNull(),
    /** SHA-256 of the canonical JSON of the validated input — a grant confirms one send, not "sending". */
    inputFingerprint: text('input_fingerprint').notNull(),
    /** The human-readable label the surface actually showed. Recorded so an audit can say what was agreed to. */
    targetLabel: text('target_label').notNull(),
    /** CAP-8. Null until a human agreed, through an act that is not the minting request (§7). A grant with
     *  `agreed_at` null is never consumable — this column is the whole difference between a gate and a
     *  formality. */
    agreedAt: integer('agreed_at'),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('confirmation_grants_organization_id_idx').on(table.organizationId),
    /** CAP-11's sweep deletes by expiry across every tenant. */
    index('confirmation_grants_expires_at_idx').on(table.expiresAt),
  ],
)
```

#### How it migrates, and why `authored_by` carries a default

Adding `messages_authored_by_check` changes the table's CHECK set, and drizzle-kit emits a full SQLite
table rebuild whenever it does — the `__new_messages` / `INSERT … SELECT` / `DROP TABLE` / `RENAME` shape of
`packages/db/migrations/0026_clear_stingray.sql`.

**Two hand edits to the generated file, both mandatory, both named here because drizzle-kit will not
produce either.** Every generated rebuild in the tree lists an identical column set on both sides of its
`INSERT … SELECT` (`0025_gray_dreaming_celestial.sql`, `0026_clear_stingray.sql`), and a NOT NULL column
with no default either prompts the generator for one or yields an `INSERT` that violates the constraint.
So S1 edits the generated SQL to:

1. carry the backfill in the `INSERT … SELECT`:
   `case direction when 'from_person' then 'person' else 'assistant' end` in `authored_by`'s position; and
2. declare the column in `__new_messages` as `` `authored_by` text DEFAULT 'unattributed' NOT NULL ``.

The second edit is the fix for a production hazard the previous draft created, and it earns its paragraph:

> `scripts/deploy.sh` rolls the **code** back automatically — on a failed `reload_everything` (`:979`) and
> on any unhealthy process after the health check (`:1032`) — and it **never restores the database backup
> it just took**; the header says the restore is by hand (`docs/DEPLOY_DROPLET.md` §8.1), and
> `confirm_rolled_back_online` then tells the operator "every process is running the previous commit",
> because pm2 still reports every process `online`. With `authored_by` NOT NULL and no default, the
> previous release's `appendMessage` (`packages/db/src/repos/conversations.ts:441`, which names
> `id, organizationId, conversationId, personId, courseId, direction, content, surface, …` and nothing
> else) raises `NOT NULL constraint failed: messages.authored_by` on **every** insert.
> `isTransientBusyError` is false, so `MAX_APPEND_MESSAGE_ATTEMPTS` rethrows and CORE-5 degrades to an
> error reply with no row written. That is a total, silent outage of message recording, reported as a
> successful rollback — and the documented manual rollback (`ci.yml`'s `deploy_sha` input) lands in
> exactly the same state.

**Why `'unattributed'` and not `'assistant'`.** A default of `'assistant'` also survives the rollback, and
the repository has the precedent for a defaulted NOT NULL column (`0025_gray_dreaming_celestial.sql:41`,
`self_enrol_from_discord integer DEFAULT false NOT NULL`). But during a rollback window the old code writes
**both** directions, so `'assistant'` would silently mislabel every student question as the assistant's —
corrupting the retained record MSG-2 exists to protect, in a way no reader could detect afterwards.
`'unattributed'` is a fourth `MESSAGE_AUTHORS` value meaning exactly what is true: *this row was written by
a release that did not record authorship*. It is NOT NULL, so no reader infers anything from absence (the
discipline `cost_ledger_entries` states — "a call that cannot be attributed is a defect, not a row with a
null"); it is self-describing, so `select count(*) from messages where authored_by = 'unattributed'` is a
one-line audit of whether a rollback ever happened; and `NewMessage`'s discriminated union (below) does not
include it, so **no code in this workspace can write it** — only a release that predates the column can,
and only by omitting it.

_Rejected:_ a two-step expand/contract (add nullable, backfill, tighten to NOT NULL in a later release). It
is the textbook answer and it buys less than it costs here: a second migration, a second deploy, a window
in which every reader must handle `null`, and a contract step somebody has to remember. The default gives
the same rollback safety permanently, in one migration, with no nullable window. _Rejected:_ leaving the
column nullable forever — that is inference-on-absence, which this codebase refuses elsewhere for exactly
this reason.

The readers (S4) render `'unattributed'` the way they render a row today — from `direction` — because that
is precisely what such a row is. `messages_authored_by_account_check` still holds for it (`unattributed` →
account id null). There is no destructive step and no column is dropped. `runMigrations`
(`packages/db/src/migrate.ts:45`) toggles `foreign_keys = OFF` at the connection level around the batch —
because drizzle-orm's own `migrate()` runs each file inside a transaction and SQLite only lets that pragma
change outside one — and runs `PRAGMA foreign_key_check` afterward, failing loudly on any violation.

**The backfill gets its own migration test, because this repository tests exactly this.**
`packages/db/tests/migrate.test.ts` already carries "applies 0002 to a database that already has a
course…" (`:317`), "applies 0013 … backfilling sequence rather than refusing to start" (`:443`), "applies
0015 and 0016 to a database with a job row in every status … proves 0016's own WHERE clause, not merely
that the migration runs" (`:564`), plus 0023 (`:803`), 0025 (`:915`) and 0026 (`:1001`) in the same shape.
Each builds a partial migrations folder from the real journal's own entries through `N-1`, runs
`runMigrations`, seeds rows, then runs again against the full folder. S1 adds one in that shape: a database
migrated through `0029`, seeded with a `from_person` message and a `to_person` message in one conversation,
then migrated to the new tag — asserting the first is `person`, the second is `assistant`, both non-null,
the row count unchanged, and **no row `'unattributed'`**. Without the hand-edited `CASE` that test fails;
with only the pinned column-list assertions the previous draft named, it would have passed against a
rebuild that silently defaulted every historical row.

**Tenant deletion.** Three new tables are organization-scoped, so `deleteOrganizationData` has to learn all
three, in FK-safe order, and `previewOrganizationDeletion` has to count the ones a person recognizes
losing. Concretely, inside the existing transaction:

- `tx.delete(messageDeliveries)` runs **strictly before** `tx.delete(messages)`, which is currently the
  function's first statement (`packages/db/src/repos/organizations.ts:299`) —
  `message_deliveries.message_id` references `messages.id`, so the existing first line would throw
  `FOREIGN KEY constraint failed` the moment a tenant had ever sent anything.
- `tx.delete(announcements)` runs after `message_deliveries` (which references it) and before `people`,
  `courses` and `accounts`-adjacent deletes — it references `courses.id`, `accounts.id` and `people.id`.
- `tx.delete(confirmationGrants)` runs before `tx.delete(organizations)`, the last statement. It
  references `accounts.id`, and accounts are deliberately _not_ deleted (TEN-1 — an account is not scoped
  to one organization, and the existing test asserts exactly that), so only the `organizations` edge
  matters here.
- `OrganizationDeletionPreview` gains `announcements` and `messageDeliveries` counts, alongside
  `rosterChannelAssignments`. Both pass the doc comment's own test for what belongs there — an instructor
  recognizes "seven announcements you sent" as a thing being destroyed, in a way they do not recognize
  `person_link_challenges`.

This is not a hypothetical: the ROST-17 comment sitting six lines above the `people` delete in that same
function is the record of the last time a table was added and this list was not. The test that makes it
real is a `seedFullTenant` extension (see S1) — it must seed an announcement, its delivery rows and a
confirmation grant, because the existing helper's blind spot is precisely why production would break while
CI stayed green.

**`NewMessage` gains a required discriminated field**, so no caller can write a row without saying who
wrote it:

```ts
// packages/db/src/repos/conversations.ts
export type MessageAuthor =
  | { authoredBy: 'person' }
  | { authoredBy: 'assistant' }
  | { authoredBy: 'account'; authoredByAccountId: string }
// `'unattributed'` is deliberately absent: it is the column's default, reachable only by a release that
// does not name the column at all. Nothing in this workspace can write it.

export type NewMessage = { /* …unchanged fields… */ } & MessageAuthor
```

`packages/core/src/answer.ts` passes `{ authoredBy: 'person' }` and `{ authoredBy: 'assistant' }` at its
two call sites. **`packages/legacy-import/src/import-messages.ts` is the third caller** and passes
`{ authoredBy: 'person' }` / `{ authoredBy: 'assistant' }` from the direction it already computes — a
legacy transcript predates accounts entirely, so no imported message is ever `'account'`, and the compiler
is what tells whoever touches that file next.

**Transactions.** `getOrCreateConversation` and `appendMessage` both take `db: Database` today and cannot
be handed a transaction handle (`WriteTx` lacks `$client`, so it does not satisfy `Database`). Both are
widened to `TransactingExecutor` — the type `packages/db/src/client.ts` already exports for exactly this,
and which `accounts.createAccount` already uses so that `@bloombot/auth`'s `sign-in.ts` can compose it into
its own transaction. Called with a top-level connection they behave exactly as now; called with an outer
transaction's `tx`, drizzle's nested path turns each `writeTransaction` into a savepoint. Two consequences
the code must state in a comment rather than discover: the `behavior: 'immediate'` option is meaningless
inside a savepoint (drizzle ignores it — `client.ts`'s own comment on `writeTransaction` already says so),
and `appendMessage`'s `SQLITE_BUSY` retry loop no longer means what it means at top level, because a busy
rolls back to the savepoint inside a transaction that already holds the write lock. That is acceptable
_because_ the outer transaction is `immediate`: the write lock is taken up front, so the nested busy case
this loop exists for cannot arise. The rewritten doc comment says that, and MSG-20's test proves that a
failure mid-fan-out rolls the whole send back — no orphan messages, no orphan announcement, no orphan
delivery rows.

**A new surface implements:** nothing. **It gets for free:** the author column, the outbox, the report,
and its rows being deleted when the tenant is.

### 3. `messages.send` — one action, an audience, no I/O

```ts
// packages/actions/src/actions/messages.ts
export const SEND_MESSAGE_MAX_RECIPIENTS = 200 // MSG-21
/** The body an owner may type. Deliberately below Discord's own 2000-character wire limit — see
 *  §4's length arithmetic for the headroom the attribution prefix needs. MSG-21. */
export const SEND_MESSAGE_MAX_LENGTH = 1800
export const SEND_MESSAGE_AUTHOR_LABEL_MAX = 80 // declared here, used by §4's transport
export const SEND_MESSAGE_ORGANIZATION_WINDOW_MS = 60 * 60 * 1000
export const SEND_MESSAGE_ORGANIZATION_WINDOW_MAX = 5

const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('course'), courseId: z.string().min(1) }),
  z.object({
    kind: z.literal('person'),
    courseId: z.string().min(1),
    personId: z.string().min(1),
  }),
])

/** **The first `.strict()` schema in `packages/actions`**, and the plan says so rather than assuming it:
 *  `grep -rn '\.strict()' packages/actions/src` returns nothing today, and zod's default is to strip
 *  unknown keys silently. Without `.strict()` an input carrying `accountId` would be dropped without a
 *  word, and the forged-author test below would pass vacuously — proving nothing. With it, the forgery
 *  attempt is a validation error a test can actually observe. */
const sendMessageInputSchema = z
  .object({
    audience: audienceSchema,
    body: z.string().min(1).max(SEND_MESSAGE_MAX_LENGTH),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict()

export interface SendMessageOutput {
  announcementId: string
  /** Recipients the platform had an address for at send time. Not "reached" — delivery is asynchronous (MSG-24). */
  addressable: number
  /** Recipients with no address on any surface, with the reason code each was recorded under. */
  unaddressable: readonly { personId: string; reason: UnreachableReason }[]
}

export function createSendMessageAction(): Action<
  'messages.send',
  SendMessageInput,
  CourseWithCategories,
  SendMessageOutput
>
```

No factory argument and no injected resolver: §1 put `resolveReachability` in `@bloombot/db`, which this
package already depends on. `createPlatformRegistry`'s signature and its 21 call sites are untouched.

`policy.descriptor` is `{ resource: 'course', access: 'write' }` and `policy.resolve` is
`courses.getCourse(organizationId, input.audience.courseId, db)` — the TEN-5 boundary for the course id.

**The confirmation grant rides on `DispatchContext`, not on the input.** `DispatchContext` gains an
optional `confirmation?: string`. This is the same shape, and for the same stated reason, as `accountId`:
that field's own doc comment says it is never read out of the action's input because "a self-reported
author would be a forgeable audit trail", and a self-asserted confirmation is exactly that. The generic
HTTP route reads the grant id from a request header (`X-Bloombot-Confirmation`) and puts it on the context;
`req.body` continues to be the action input, byte for byte. This is why the plan does **not** change
`/actions/:actionName`'s body shape: an envelope (`{ input, confirmation }`) would break all 50 actions,
every existing `apps/api` route test and every MCP call path, and a sibling key on the input would be
stripped silently by the 49 non-strict schemas.

`execute`, in order:

1. `if (!accountId) throw new ActionRefusedError()`, then
   `memberships.getMembership(organizationId, accountId, db)?.role !== 'owner'` → `ActionRefusedError`.
   This is in `execute`, not the policy, because `PolicyContext` cannot see the caller — the same shape
   `memberships.grant` and `costLedger.setSpendingCap` already use.
2. **The confirmation gate** (§7, CAP-8): consume the grant named by `context.confirmation`, bound to this
   account, this action name and a fingerprint of this exact validated input. No grant, **a grant whose
   `agreedAt` is null**, an expired grant, a consumed grant, a grant for another account or a grant whose
   fingerprint does not match → `ActionRefusedError`. Consumption is a conditional
   `UPDATE … SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND agreed_at IS NOT NULL AND
expires_at > ?` whose zero-rows result is the refusal, so two concurrent dispatches cannot both spend one
   grant. This is what makes confirmation a property of the _action_ rather than of a route, and it is why
   `POST /organizations/:id/actions/messages.send` cannot bypass it.
3. **The organization budget** (MSG-9): count announcements in this organization inside
   `SEND_MESSAGE_ORGANIZATION_WINDOW_MS`; at or over `SEND_MESSAGE_ORGANIZATION_WINDOW_MAX`,
   `ActionRefusedError`. If `idempotencyKey` is present and an announcement in this organization already
   holds it, return **that announcement's output recomputed from its own rows** rather than sending again
   — `announcements.summariseAnnouncement(organizationId, announcementId, db)` derives
   `{ addressable, unaddressable }` by grouping `message_deliveries` for that announcement, because the
   `announcements` row itself stores no counts and a stored count would be a second copy of a fact the
   delivery rows already hold. That one function is also what `messages.announcementStatus` (§9) returns,
   so there is one derivation, not two. The read-then-insert's correctness under a concurrent duplicate
   rests on the unique index on `(organization_id, idempotency_key)`, not on SQLite's single writer.
4. Resolve recipients: a `person` audience through
   `enrolments.getActiveEnrolment(organizationId, courseId, personId, db)` — **an unknown personId, a
   personId from another organization, and a person whose enrolment has ended all raise the identical bare
   `ActionRefusedError` the policy raises for a foreign course** (MSG-3, TEN-5). A `course` audience through
   `enrolments.listPeopleForCourse`, refused over `SEND_MESSAGE_MAX_RECIPIENTS` (MSG-21).
5. Then, in **one** `writeTransaction` (MSG-20): insert the `announcements` row; for each recipient call
   `resolveReachability(...)`; for a reachable one call
   `conversations.getOrCreateConversation(organizationId, { courseId, personId, surface: recipient.surface }, tx)`
   — **the conversation's surface is the resolved delivery surface**, which is exactly why resolution has
   to be a database read the action can perform (MSG-22) — then `appendMessage(..., { direction:
'to_person', authoredBy: 'account', authoredByAccountId: accountId, content: body, surface:
recipient.surface }, tx)`, then a `message_deliveries` row in `pending`; for an unreachable one, a
   `message_deliveries` row in `unreachable` with its reason code and no message row. Then enqueue the
   delivery jobs (§4), **inside the same transaction**, so a rollback takes the jobs with it.

The action performs **no I/O**: every step above is a database read or write. That is the whole reason
`resolveReachability` is synchronous and DM-opening is not part of it.

**A new surface implements:** nothing. **It gets for free:** the entire action.

### 4. `DeliveryTransport` — one interface, two honest adapters, registered by the worker

The interface is declared in `apps/worker/src/delivery/types.ts`, not in a shared package. The consumer is
the `messages.deliver` handler, which lives in `apps/worker`; every implementation lives there too, because
every one of them does process-level I/O. Nothing outside `apps/worker` needs the type.

```ts
// apps/worker/src/delivery/types.ts
import type { DeliveryReason, DeliverySurface } from '@bloombot/schemas'

export interface DeliveryRequest {
  organizationId: string
  announcementId: string
  deliveryId: string
  personId: string
  /** The opaque address `resolveReachability` produced for this surface. */
  address: string
  candidateChannelId: string | null
  /** The owner's text, at most SEND_MESSAGE_MAX_LENGTH. The transport may decorate it for its own surface. */
  body: string
  /** MSG-2 — who to name. Never an account id, never an email. Truncated to SEND_MESSAGE_AUTHOR_LABEL_MAX. */
  authorDisplayName: string | null
  /** MSG-4 — the wall-clock instant after which this handler must stop starting new work. */
  deadlineAt: number
}

export type DeliveryOutcome =
  | { kind: 'delivered' }
  | { kind: 'unreachable'; reason: DeliveryReason }

export interface DeliveryTransport {
  /** `DeliverySurface`, not `Surface`: a transport for `mcp` does not compile (§1). */
  readonly surface: DeliverySurface
  /** Resolves for a settled outcome. THROWS for a transient failure, so `runNextJob` retries with the runner's own backoff; the thrown value carries `permanent` where the provider says so, and `abortBatch` where the whole batch must stop (MSG-27). */
  deliver(request: DeliveryRequest): Promise<DeliveryOutcome>
}
```

_Discord_ (`apps/worker/src/delivery/discord.ts`). Two new verbs on `DiscordRestClient` —
`createMessage(botToken, channelId, content)` and `createDm(botToken, userId)` — each a `postJson` call,
each argued for in `packages/discord-rest/src/client.ts`'s own module comment beside the two existing
write exceptions, and in **D-107**. `createMessage` sets `allowed_mentions: { parse: [] }` **itself**, from
a constant defined in `packages/discord-rest`, so no caller can omit it; the discord.js-shaped
`SUPPRESS_ALL_MENTIONS` stays in `apps/bot` where it belongs (the two are different shapes — camelCase
option versus snake-case wire field — and `apps/worker` has no dependency on `apps/bot` and must not
acquire one).

**The remembered private channel is the preferred path, and a DM is the fallback** — in that order, and the
order matters for MSG-27: a post to an existing channel costs one request in a per-channel bucket, while
opening a DM costs an extra request in `POST /users/@me/channels`, the most aggressively limited route this
platform can touch.

**Verifying the remembered channel, with the verb that actually exists.** The adapter uses the person's
`roster_channel_assignments` channel only after checking two things: that
`getChannelAssignmentByDiscordChannelId` still records that channel for _this_ person, and that the
channel's current per-person overwrite still grants them read. The second check has no per-channel GET to
use: `DiscordRestClient` has fourteen methods, `putChannelPermissionOverwrite`
(`packages/discord-rest/src/client.ts:407`) is a **PUT write**, and the only method that returns
`permission_overwrites` is `listGuildChannels`, which is guild-wide. So the check is a `listGuildChannels`
call, and the plan states its cost rather than pretending it is free: **one guild-wide channel list per
delivery batch, cached for the life of that batch**, keyed by guild. **Where the guild id comes from** —
`roster_channel_assignments` has no guild column (`packages/db/src/schema.ts:1562`–`:1577`), so the handler
reads it from the course: `courses.discordServerId` (`packages/db/src/schema.ts:268`, nullable) through
`repos/discord-servers.ts#resolveCourseDiscordServer`, whose single-binding fallback covers an organization
with exactly one installed server and an unedited course. A course whose server cannot be resolved has no
channel to verify, so every Discord recipient in that batch takes the DM path directly. 25 recipients in
one guild cost one extra REST call, not 25. A third REST verb (`getChannel`) is rejected: it buys one saved
round trip per batch at the cost of another exception to `packages/discord-rest`'s deliberate
no-write-verbs/no-new-reads posture, and the existing guild-wide read is already the one the scaffold
handler uses for the same purpose. The roster importer already records `channelOwnershipConflicts` and
`channelsOrphaned` as real outcomes, so a stale assignment is an expected state, not a hypothetical — and a
private message about an absence posted into a channel a different student now reads is the failure this
check exists to prevent. Failing that check, the adapter opens a DM (`createDm`, at delivery time, never
stored) and posts there; failing that, it returns `unreachable` with `channel_not_permitted` or
`dm_closed`.

**Length arithmetic: one recorded message is one posted message, and nothing splits (MSG-25).** Discord's
wire limit is 2000 characters (`DISCORD_MESSAGE_LIMIT`, `packages/discord/src/split.ts:17`), and the
Discord transport prefixes the delivered text with `<Name> (via the assistant)\n` (§Decisions,
attribution). The plan makes the arithmetic close by construction rather than by splitting:

```
SEND_MESSAGE_MAX_LENGTH            1800
SEND_MESSAGE_AUTHOR_LABEL_MAX        80   (the display name, truncated by the transport)
the fixed " (via the assistant)\n"   21
                                   ----
worst case                         1901  <  2000
```

Both constants are declared in `packages/actions/src/actions/messages.ts` (§3) and imported by the
transport — one declaration, not two, so the arithmetic cannot drift. A body over 1800 is refused by
`inputSchema` before an announcement row exists, with the count shown live in the panel's composer
(MSG-12). _Rejected:_ having the worker split. `splitForDiscord` lives in `@bloombot/discord`, which
`apps/worker` does not depend on and which pulls in `@bloombot/core`, `@bloombot/db`, `@bloombot/jobs` and
`@bloombot/logger` (`packages/discord/package.json`) — dragging the answering pipeline into the delivery
process to save 200 characters of headroom. _Rejected:_ re-homing the splitter into
`packages/discord-rest`; it is churn across a shipped SURF-5 test for a case this design can simply make
unreachable. The consequence worth stating plainly: a delivery row's `sent` state means exactly one Discord
post, so there is no "partially posted" state for a report to explain.

**Pacing, rate limits, and the token the answering bot shares (MSG-15, MSG-27).**
`packages/discord-rest/src/http.ts` discards response headers today (`:85`), so the first change is that
`JsonResponse` gains `headers: Headers` and `DiscordRequestError` gains `retryAfterMs: number | null` and
`global: boolean`, parsed from the `Retry-After` header, the body's `retry_after` (seconds, Discord's JSON
shape) and the `X-RateLimit-Global` header. Nothing else in the package changes behaviour: the extra fields
are additive and every existing caller ignores them.

The transport then paces itself with three constants, exported so each is a one-line change with a test:

```ts
export const DISCORD_DM_OPEN_MIN_INTERVAL_MS = 1_000 // POST /users/@me/channels — the most aggressively limited route
export const DISCORD_POST_MIN_INTERVAL_MS = 250 // POST /channels/:id/messages
export const DISCORD_RATE_LIMIT_RETRIES = 2 // per recipient, inside the batch
```

A **per-route 429** is not left to the job runner's generic backoff, which would re-run the whole batch.
The transport sleeps the `retryAfterMs` Discord actually stated and retries that one recipient up to
`DISCORD_RATE_LIMIT_RETRIES` times; still limited after that, it records the recipient
`failed`/`rate_limited` and lets the batch continue, because the per-row claim protocol means one stalled
recipient does not cost the other twenty-four. §10's re-drive is the remedy for a rate-limited row.

A **global 429 is different, and this is MSG-27's mechanism.** `apps/worker` and `apps/bot` hold the *same*
bot token (`apps/worker/src/index.ts:116`, `:162`, `:175`), and Discord's global limit is per token — so
the realistic bad outcome of a 200-recipient broadcast is not a slow broadcast, it is the token tripping
Discord's global limit or its anti-spam handling and taking down PLAT-3's only gateway connection for every
student on the platform. So: on a response carrying `X-RateLimit-Global`, or on a `429` from
`POST /users/@me/channels` after the per-recipient retries are exhausted, the transport **stops the whole
batch immediately** — it leaves the current recipient and every unattempted one `pending` (releasing its
claim), makes no further Discord call, and throws a retryable error carrying Discord's own `retryAfterMs`
so the runner backs the entire job off rather than continuing to spend a shared token. Yielding the token
to the process students are actually talking to is the right trade every time; a broadcast that arrives
four minutes late is not a failure, and a gateway that is rate-limited out of answering is.

**What that costs at real class size.** A 200-recipient broadcast is 8 batches of 25. Worst case per
recipient is a DM open (1 s pace + round trip) plus a post (0.25 s pace + round trip); at a pessimistic 1 s
per round trip that is ~3.3 s, so a batch is ~82 s of pacing and round trips — inside
`JOB_HANDLER_TIMEOUT_MS` (240 000 ms, `packages/config/src/env.ts:141`) with room, and inside the 80 s
per-request Discord timeout (`apps/worker/src/index.ts:140`) per call. That estimate is *before* any 429:
with `DISCORD_RATE_LIMIT_RETRIES = 2` sleeping a multi-second `retryAfterMs` each time, a batch can exceed
240 s, which is why the budget check below is a requirement and not a nicety. All of this goes in **D-107**
rather than being discovered in production.

**The budget and the claim lease (MSG-4).** Two numbers, stated rather than left implicit:

```ts
export const DELIVERY_CLAIM_LEASE_MS = 300_000 // == JOB_CLAIM_LEASE_MS, and > JOB_HANDLER_TIMEOUT_MS
export const DELIVERY_DEADLINE_MARGIN_MS = 30_000
```

`claim_expires_at` is set to `now + DELIVERY_CLAIM_LEASE_MS`, which is **longer than
`JOB_HANDLER_TIMEOUT_MS` (240 000)** on purpose: `apps/worker/src/index.ts:125`–`:140`'s own comment says
an abandoned handler's request "might still be writing to a socket underneath it", because JavaScript
cannot cancel it. If the lease were shorter than the handler budget, a retry could reclaim a row while the
abandoned handler was still posting it — a double-send to a real student, exactly what MSG-4 forbids. The
lease outliving the handler means a reclaim can only happen once the abandoned attempt is genuinely gone.

The handler computes `deadlineAt = startedAt + JOB_HANDLER_TIMEOUT_MS - DELIVERY_DEADLINE_MARGIN_MS` and
**checks it before claiming each next recipient**. Past the deadline it stops claiming, leaves the rest
`pending`, logs `delivery.batch.deadline` with the count it did not reach, and completes normally. Those
rows are then picked up by MSG-28's reconciler or §10's re-drive — a visible, finishable state, not a
silent one. A batch that is still running when a shutdown drains past `drainTimeoutMs` (30 000 ms,
`apps/worker/src/shutdown.ts:97`) is abandoned mid-flight, and that file's own comment says its claim is
left to lapse on its lease — which is safe here precisely because a claim is not a send, and because the
lease outlives the handler.

_Web_ (`apps/worker/src/delivery/web.ts`). Delivery is **the `messages` row itself**. There is no push on
the web, and this plan does not invent one: the transport is a no-op that returns `delivered`, and the
panel learns about the row by polling `GET /courses/:courseId/messages?since=<sequence>` on the same
injectable-`pollIntervalMs` idiom four existing components already use. Being explicit about this is the
point — "delivered" on the web means "durably readable by the recipient", not "pushed". It ships in S3B
with the handler rather than in S3 with the Discord transport, because it is two lines and its only test is
the handler's.

_MCP_. **MCP is not a delivery surface, and `resolveReachability` never selects it** — `DeliverySurface`
does not include it, so this is enforced by the compiler and not by a comment. An unsolicited notification
is silently dropped when the client has not opened its standalone `GET` stream, sessions are in-process and
lost on restart, and `sendLoggingMessage` is a no-op under the server's current capability declaration.
What MCP gets instead is a _pull_: the read-back chat tool specified in §6.1 (MSG-29). MCP is a send-only
surface, and MSG-23 says so rather than implying parity that does not exist.

**A new surface implements:** one `DeliveryTransport`, registered with the worker in
`apps/worker/src/index.ts` beside the existing handler registrations. **It gets for free:** the outbox,
the claim protocol, the retry and backoff, the report, the mention suppression (it is inside the REST
verb), the pacing scaffolding, the deadline, and the decision about whether it is a delivery surface at all.

**The delivery job, and what batching actually buys (MSG-16).** One job kind, `'messages.deliver'`, whose
payload is `{ announcementId, deliveryIds: string[] }` — a **batch**, not one job per recipient.
`DELIVERY_BATCH_SIZE = 25` bounds one broadcast to eight queue slots.

The previous draft claimed batching lets other tenants' work "interleave". **Against this queue that was
false**, and the correction is a design change rather than a wording change: `claimNextJob`
(`packages/db/src/repos/jobs.ts:210`–`:229`) orders by `asc(jobs.nextAttemptAt)` with no per-tenant
fairness, and `apps/worker/src/loop.ts` runs one job at a time — so eight jobs enqueued inside one
transaction all carry the same `nextAttemptAt`, are claimed back to back, and a roster import enqueued a
minute later waits behind all eight, for the plan's own ~11 minutes.

The fix uses a capability the queue already has. `enqueueJob` writes `nextAttemptAt: input.availableAt ??
now` (`packages/db/src/repos/jobs.ts:127`), and `claimNextJob` only considers `pending` rows with
`nextAttemptAt <= now` — so a job enqueued with a future `availableAt` **is not claimable at all** until
then. Batch _i_ is therefore enqueued with:

```ts
export const DELIVERY_BATCH_STAGGER_MS = 90_000 // > one batch's own worst-case wall clock (~82 s)
availableAt: now + i * DELIVERY_BATCH_STAGGER_MS
```

The stagger exceeds a batch's own worst case, so each batch finishes before the next becomes claimable,
leaving a real gap in which any other job is claimed. The honest, testable property — and what MSG-16's
rewritten body now claims — is **"a job enqueued while a broadcast is running waits at most one batch, not
the whole broadcast"**: at most ~82 s rather than ~11 minutes. It is not per-tenant fairness in the queue,
and the plan does not say it is. _Rejected:_ adding a fairness rule to `claimNextJob` — it changes the
claim semantics every existing job kind depends on, it needs its own requirement and its own D-number, and
it is a much larger blast radius than one broadcast justifies. _Rejected:_ one job per recipient — 200
sequential claims head-of-line block every other tenant's roster imports, scaffolds, attachment uploads and
transcript exports, which is the failure this whole design is avoiding.

**The claim protocol** (this is what makes a retry safe):

```
UPDATE message_deliveries SET state='claimed', claimed_by=?, claim_expires_at=?, attempts=attempts+1
 WHERE id=? AND organization_id=? AND (state='pending' OR (state='claimed' AND claim_expires_at < ?))
```

Zero rows updated means somebody else holds it — skip. After a 2xx, `claimed → sent`. On a settled
`unreachable`, `claimed → unreachable` with the reason code. On a transient failure, `claimed → pending`
and **throw**, so the runner's backoff applies. On a crash or a lapsed lease the row is reclaimable,
because `claimed` is not `sent`: **a claim is not a send**, and the previous draft's "set `sent` first"
made a crash between the claim and the REST call indistinguishable from a success — the message would
never be delivered while the report said it was.

### 5. The capability surface, promoted out of `apps/mcp` into `packages/actions`

```ts
// packages/actions/src/capabilities.ts
export interface CapabilityEntry {
  actionName: string
  /** Kept as `destructive`, not renamed: it is also the field name on `McpToolDefinition` and the value `EXPECTED_DESTRUCTIVE` compares against. MCP-4's trigger list widens (CAP-4); the field does not move. */
  destructive?: boolean
  describeTarget?: (entity: unknown, input: unknown) => string
  sanitizeOutput?: (output: unknown) => unknown
}

/** Every capability the platform is willing to expose to *any* assistant. A registered action is not on it until a reviewer adds it here. */
export const PLATFORM_CAPABILITIES: readonly CapabilityEntry[]

/** What ONE surface takes. `included` is opt-in: a surface that names nothing gets nothing. */
export interface SurfaceCapabilityDeclaration {
  surface: Surface
  included: readonly string[]
  /** A name deliberately withheld, with the reason, so a reviewer sees the omission rather than inferring it. */
  withheld?: readonly { actionName: string; because: string }[]
}

export function resolveCapabilities(
  declaration: SurfaceCapabilityDeclaration,
  registry: ActionRegistry,
  catalog: readonly CapabilityEntry[] = PLATFORM_CAPABILITIES,
): ResolvedCapability[] // throws for a name absent from the catalog, and for destructive-without-describeTarget
```

`PLATFORM_CAPABILITIES` is seeded with exactly today's 24 `MCP_TOOL_SURFACE` entries, including both
destructive ones (`courses.save`, `courseAttachments.detach`), plus **all three** of the new actions:
`messages.send` and `messages.redeliver` marked `destructive: true` with a `describeTarget`, and
`messages.announcementStatus` as an ordinary read. Putting `messages.redeliver` on the catalog is not
cosmetic — §10 makes it consume a grant, and a destructive capability missing from the catalog is exactly
the hole the previous draft left. `included` is **opt-in and per surface**, not inherited: the previous
draft's "a surface that copies nothing inherits everything" was a fail-open default that contradicted MCP-2
("the tool surface is chosen, not derived") and D-36's leak-probe test, and would have handed Discord and
the web `courses.save` — the action that shipped unmarked and deleted every category and channel of a real
course — by default. The initial declarations are stated, not inherited: MCP takes today's 24 plus the
three new ones; Discord and the web take `messages.send`, `messages.redeliver` and
`messages.announcementStatus` and nothing else, and name every withheld capability in `withheld` with a
reason.

**A new surface implements:** one `SurfaceCapabilityDeclaration` in `packages/actions`, named in
`SURFACE_CAPABILITY_DECLARATIONS`. Omitting it fails the build (CAP-2). **It gets for free:** the JSON
Schema per capability (`ActionRegistry#catalog`, ACT-6), the destructive marking, `describeTarget`, output
sanitization, and the parity test that will not let it silently diverge.

### 6. The invoker — the only path from an assistant to `dispatch`

```ts
// packages/actions/src/invoke.ts
export interface InvocationContext {
  organizationId: string
  accountId: string
  db: Database
  confirm: ConfirmationPort
}

/** Resolves `describeTarget` against the capability's own `policy.resolve`, obtains a confirmation grant for any destructive capability, then dispatches with that grant on the `DispatchContext`. The ONE place a capability reaches `dispatch`. */
export async function invokeCapability(
  capability: ResolvedCapability,
  rawInput: unknown,
  context: InvocationContext,
): Promise<unknown>
```

`apps/mcp/src/call-tool.ts` is refactored onto this so there is exactly one implementation of the gate, and
the `CapabilityInvoker` every surface's assistant uses is a thin wrapper over it. It is not possible for an
invoker to reach `dispatch` without passing through `invokeCapability`, and it is not possible for
`messages.send` or `messages.redeliver` to run without an agreed grant even outside an invoker, because the
actions themselves consume one (§3 step 2, §10). Both belts are deliberate: the first makes every
_assistant_ path uniform, the second makes every _route_ path safe, including `POST /actions/:actionName`.

#### 6.1 The MCP read-back tool (MSG-29)

MCP cannot be pushed to (§4), so what it gets instead is a pull, and it is specified here rather than
appearing only in a slice's file list. `bloombot_readMyRecentMessages` joins `MCP_CHAT_TOOL_SURFACE` — the
second registration array, deliberately **not** membership-gated because it is authorized by enrolment
rather than by role. It therefore takes **no person identifier and no conversation identifier at all**: it
resolves the caller's own person exactly as `apps/mcp/src/chat-tools.ts#resolveAdmittedCourse` already
does, takes a `courseId` and an optional `limit`, and returns only that caller's own conversation, most
recent last. Each entry carries `authoredBy` and, for an `account` author, the sender's display name — so
an MCP client can tell a staff announcement from an assistant answer, which is MSG-2's property on a fourth
reader. It returns no address, no snowflake and no other person's text. A `personId`-shaped extra argument
changes nothing about what comes back, and there is a named test that says so.

### 7. `ConfirmationPort` — MCP-4, generalized, fails closed everywhere

```ts
// packages/actions/src/confirmation.ts
export interface ConfirmationRequest {
  organizationId: string
  accountId: string
  actionName: string
  /** What `describeTarget` produced — the record, never just the tool name. */
  targetLabel: string
  /** SHA-256 of the canonical validated input; the minted grant is bound to it. */
  inputFingerprint: string
}

export interface ConfirmationPort {
  /** Resolves to the id of an **agreed** grant when a human agreed, `undefined` otherwise. A throw, a timeout, a decline, a grant minted but never agreed to, and a surface that cannot ask are all `undefined` — it fails closed (D-36). */
  confirm(request: ConfirmationRequest): Promise<string | undefined>
}
```

A grant is a `confirmation_grants` row: single-use, short-lived, bound to `(accountId, actionName,
inputFingerprint)`, and **not consumable until `agreed_at` is set** (CAP-8). This is why a boolean tool
argument is not the mechanism (D-36: "every argument in a tool call is text the model itself generates"); a
model can set a boolean, but it cannot mint a row, and — this is the part the previous draft got wrong — it
must also not be able to _agree_ to one it minted.

_MCP adapter_ (CAP-10): `requestElicitedConfirmation` as it stands, unchanged in mechanism —
`extra.sendRequest` from the in-flight tool call's own `RequestHandlerExtra`, so the SDK attaches
`relatedRequestId` and the message lands on the already-open `tools/call` POST stream rather than the
standalone `GET` stream, where it would be silently dropped. What changes is its return type: today it
returns `boolean` (`apps/mcp/src/server.ts:273`–`:307`) and `call-tool.ts:218` turns `false` into a
`ConfirmationRequiredError`. It becomes `Promise<string | undefined>`: on
`result.action === 'accept' && result.content?.['confirm'] === true` it mints a grant **already agreed** —
the elicitation response _is_ the human's act, arriving over a channel the tool-calling model does not
write — and returns its id; everything else, including a client that declares no elicitation capability at
all, returns `undefined`. `call-tool.ts` passes that id through as `dispatch(..., { confirmation })`.
**This change ships in S7, in Phase 29**, with the tool that needs it — not in S8 — because a tool that
refuses unconditionally is not an exposure, it is a defect.

_Web adapter_ (CAP-9): **three round trips, and the middle one is the human's.** The previous draft minted
the grant inside `/preview` and then had the panel re-POST it, which meant any caller who could reach
`/preview` already held a usable grant with no human step in between — CAP-4 satisfied in form and not in
substance, and a parity test asserting only that a port was _called_ would have passed over the hole.

1. `POST /organizations/:organizationId/actions/:actionName/preview` validates the input, resolves the
   policy entity, mints a grant with `agreed_at = NULL`, and returns `{ targetLabel, confirmationId }`.
   The grant is useless at this point: `execute`'s consuming `UPDATE` requires `agreed_at IS NOT NULL`.
2. The panel shows `useModal().confirm({ destructive: true })` with that label. **The user's click** issues
   `POST /organizations/:organizationId/confirmations/:confirmationId`, which sets `agreed_at` for a grant
   belonging to this session's own account and not already consumed or expired. Nothing else in the system
   may call this route — in particular the panel's own assistant (S10) runs inside `apps/api` and cannot
   originate a browser request, so a server-side invoker that mints a grant cannot also agree to it. It
   returns the label and the grant id to the browser, and the turn ends; the human's click is what resumes
   it.
3. The panel re-POSTs the same input to `/actions/messages.send` with the grant id in the
   `X-Bloombot-Confirmation` header. Re-POSTing _different_ input fails the fingerprint check.

The panel's own compose screen (MSG-12) is the only place a `messages.send` originates on the web today.

_Discord adapter_ (CAP-4, Phase 30): the primitive `apps/bot` already has is a `MessageCreate` in a
channel. The bot replies with the target label and a four-word code; a following message from the **same
authenticated speaker in the same channel** quoting that code within a short window sets `agreed_at` on the
pending grant. That is a request from the platform to a human outside the model's own output channel, which
is D-36's actual requirement — no `InteractionCreate` wiring, no new intents, and it ships in Phase 30
rather than being deferred, because "send from within Discord" is half of what the maintainer asked for and
a `DENY_ALL` port would make the Discord answer a permanent refusal. Three existing behaviours it has to
reconcile, stated here so S10 does not discover them: (a) `handleMention` only sees messages that address
the bot, so the code message must mention it, and the confirmation matcher runs **before** `answerQuestion`
so a code reply does not cost a model call and produce a nonsense answer; (b) SURF-9's catch-up
(`apps/bot/src/catch-up.ts`) replays addressed messages missed across a restart, so a code could arrive
minutes late — the grant's own `expires_at` is the bound, and an expired code gets a plain "that
confirmation has expired" rather than silence; (c) `discord_handled_messages` dedup is keyed on outcome
kinds, so the confirmation outcome joins `isHandledOutcome`'s list or a code is replayed on every catch-up
scan.

**There is no `DENY_ALL` escape.** Every surface that resolves a destructive capability must register a
port that is actually consulted; a surface with no port cannot resolve one.

**A new surface implements:** one `ConfirmationPort`. **It gets for free:** the grant's minting, binding,
expiry, single use, the `agreed_at` requirement, the sweep, and the refusal in `execute` that no route can
route around.

**Grant retention, and the sweep that actually runs (CAP-11).** A grant is minted on every preview,
including every cancelled one. The previous draft created `pruneConfirmationGrantsOlderThan` in S1 and
called it from nowhere, justifying it as running "from the worker's own loop on the same schedule as its
other housekeeping" — `apps/worker/src/loop.ts` is claim → run → sleep and has no housekeeping schedule at
all, and the cited precedent (`pruneHandledMessagesOlderThan`) is called from `apps/bot/src/catch-up.ts`, a
different process. So the function is created **and called in the same slice** (S5), and the caller is a
real precedent in this tree: an `unref()`'d `setInterval` in the composition root, exactly the shape
`apps/mcp/src/server.ts:912` uses for `sweepIdleSessions` and `apps/bot/src/connected-marker.ts:51` uses for
the gateway heartbeat. It lives in `apps/api`, which always runs and is where `/preview` mints, and it
deletes every grant expired for longer than `CONFIRMATION_GRANT_SWEEP_AFTER_MS` (default one day). Running
the same sweep in a second process later would be harmless — a `DELETE` by cutoff is idempotent — but one
is enough. The sweep function itself is pure and tested directly, the way `sweepIdleSessions` is, rather
than by waiting on an interval. A never-agreed grant carries a target label and a fingerprint, not a
message body, so the sweep is hygiene rather than a privacy obligation — but an unbounded table nobody
reads is still a table nobody reads.

### 8. The tool-calling loop in `packages/core`

The existing port is extended rather than duplicated, because a second method would drop `model`, `usage`
and `upstreamThreadId` — all three of which `answer.ts` needs on every call, and two of which COST-1/COST-2
and MDL-4 depend on.

```ts
// packages/core/src/ports.ts
export interface ModelToolDefinition {
  name: string
  description: string
  /** JSON Schema, straight from `ActionRegistry#catalog()` (ACT-6). The core never builds one. */
  inputSchema: unknown
}

export interface ModelRequest {
  // …every existing field, unchanged…
  /** Empty for every call the platform makes today. An adapter that gets `[]` sends no tool definitions at all. */
  availableTools?: readonly ModelToolDefinition[]
  /** Results of the calls the previous round asked for, echoed back verbatim. `handle` is opaque to this core. */
  toolResults?: readonly { handle: string; output: unknown }[]
}

export type ModelAnswer =
  | { kind: 'text'; text: string; upstreamThreadId: string | null; model: string; usage?: ModelUsage }
  | {
      kind: 'tool_calls'
      calls: readonly { handle: string; name: string; input: unknown }[]
      upstreamThreadId: string | null
      model: string
      usage?: ModelUsage
    }
```

Every round — tool round or final text — carries `model`, `usage` and `upstreamThreadId`, and `answer.ts`
records **one `cost_ledger_entries` row per round** (CAP-7), so COST-1/COST-2 keep holding and COST-3's cap
does not under-count by the number of rounds. `handle` is an opaque string the core never interprets, which
is what keeps this a port rather than a transcription of one vendor's function-calling API.

**The loop's bounds are a requirement, not a constant somebody may tune away (CAP-12).** Three of them:
`MAX_CAPABILITY_ROUNDS = 3`; a wall-clock deadline for the whole turn, per MDL-5 ("a request that does not
return within a timeout is abandoned rather than holding a student's reply open"); and **at most one
capability invocation per turn**, counted separately from the round limit. Each has its own assertion in
`packages/core/tests/agent-capabilities.test.ts`, because an implementer could otherwise ship an unbounded
loop that passes every other test in this plan and bills a tenant for it.

**The turn that carries capabilities carries no retrieval (CAP-5).** When the speaker holds capabilities,
`answer.ts` makes the capability round as a _separate_ `model.ask` with `vectorStoreId: null` and
`webSourceDomains: []` — only the speaker's literal text and the tool schemas. Retrieved text is the one
thing in the request the owner did not write and an adversary may control (a knowledge file, any page on a
course's configured web-source domain), and an injected instruction reaching a `messages.send` tool that
holds owner authority is the sharpest risk in this whole design. The answering round that produces the
reply keeps its retrieval exactly as today; it just holds no tools.

**Who the speaker is (CAP-3).** Authority is not derived from a Discord snowflake.
`packages/db/src/repos/speaker-authority.ts` — a tenant-scoped read, in `packages/db` for the same reason
§1 puts reachability there — exports:

```ts
export type SpeakerAuthority =
  | { kind: 'none' }
  | { kind: 'account'; accountId: string; role: MembershipRole }

/** Refuses (`none`) on: no identity, an unconnected person, more than one `web` identity for that person, a disabled account, or no live membership. */
export function resolveSpeakerAuthority(
  organizationId: string,
  surface: Surface,
  externalId: string,
  db: Executor,
): SpeakerAuthority
```

It re-reads `accounts.disabledAt` directly. `memberships.getMembership` checks only `revokedAt`, and
`accounts.disabledAt` is enforced today in exactly two places — `sessions.validateSession`'s subquery and
`sign-in.ts` — so a path that resolved an account through `person_identities` alone would hand a disabled
owner full authority by mentioning the bot in Discord. TEN-5's own matrix names "a disabled account"; this
path gets the same row. Ambiguity refuses rather than picks: `getPersonIdentity` returns the _oldest_
identity and its own comment says that is deterministic, not correct, which is fine for seeding a model's
opening item and is not fine for choosing whose authority an action runs under.

**A new surface implements:** passing its speaker's `(surface, externalId)` to `resolveSpeakerAuthority`
and wiring a `CapabilityInvoker`. **It gets for free:** the disabled-account check, the ambiguity refusal,
the round bound, the deadline, the per-round cost accounting, and the retrieval quarantine.

### 9. Observability — what a send writes to the log, and what notices a wedged outbox

SURF-6's principle is that every outcome reaches the student or the log, and none reaches neither. Applied
to sending, that principle is not satisfied by a report an owner may never look at: a broadcast that
reached nobody must be visible to somebody who was not watching. Nothing in the previous draft specified a
single log line, and `packages/logger` appeared in no slice.

`apps/worker` already has everything needed — it depends on `@bloombot/logger`, and `JobContext`
(`packages/jobs/src/registry.ts:15`) carries a `Logger` into every handler. Five lines, with MSG-11's
discipline applied to log fields exactly as it is to `message_deliveries.detail` (reason codes; never a
snowflake, channel id, handle, email or provider body):

| when                      | level                                                       | fields                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages.send` accepted  | `info`, from `apps/api`'s own logger via the route          | `event: 'announcement.created'`, `organizationId`, `announcementId`, `courseId`, `audienceKind`, `addressable`, `unaddressable`, `surface` counts. No body, no person ids. |
| a delivery batch claimed  | `info`                                                      | `event: 'delivery.batch.claimed'`, `announcementId`, `claimed`, `skipped` (already held elsewhere), `batchSize`                                                            |
| a batch hits its deadline | `warn`                                                      | `event: 'delivery.batch.deadline'`, `announcementId`, `unattempted` — the MSG-4 budget check fired                                                                          |
| a recipient settles       | `debug` for `sent`, **`warn` for every non-`sent` outcome**  | `event: 'delivery.settled'`, `announcementId`, `deliveryId`, `state`, `reason` (a `DeliveryReason`), `attempts`, `surface`                                                 |
| a broadcast completes     | `info` when all `sent`, **`error` when any ended `failed`**  | `event: 'announcement.completed'`, `announcementId`, `sent`, `unreachable`, `failed`                                                                                       |

**The health signal, and why `announcement.completed` alone is not it.** `scripts/ops-monitor.mjs` (OPS-12)
pages an operator on a health _transition_, and a broadcast where 30 of 30 deliveries failed changes no
health endpoint. But the previous draft's two signals both missed the state a terminal job failure actually
leaves rows in: JOB-6 makes a job terminal at `maxAttempts` and `markJobFailed` NULLs the payload in the
same write, so the `deliveryIds` are gone; the recipients the handler never reached are left **`pending`,
not `claimed`**, and `announcement.completed` is written by a handler that reaches completion, which a
terminally failing handler never does. So the health field counts **both** states (MSG-28):

```ts
// apps/worker/src/health.ts — checkWorkerHealth gains one field beside queueDepth
stuckDeliveries: number
// = rows in `claimed` whose claim_expires_at is more than STUCK_DELIVERY_AFTER_MS past
// + rows in `pending` whose updated_at is more than STUCK_DELIVERY_AFTER_MS past
//   (an orphan: no live job carries it, because a terminal job forgot its payload)
```

The `(state, claim_expires_at)` index in §2 is what keeps that count cheap on a 30-second poll.

**`ready` is not touched, and this is stated because the alternative rolls back every deploy.**
`checkWorkerHealth` returns `ready: database` today, and `apps/worker/src/health.ts`'s server answers 503
when `ready` is false, which `scripts/health-check.mjs` reports as not ok, which makes `scripts/deploy.sh`
roll the deploy back (`:1032`). If `stuckDeliveries` fed `ready`, **every deploy would roll itself back for
as long as the outbox was wedged** — an outage caused by the thing that exists to notice outages.
`stuckDeliveries` is a reported number, nothing more.

**What ops-monitor actually needs changing.** The decision function is `evaluate(result, previousModel)`
(`scripts/ops-monitor.mjs:107`) — **there is no `verdictFor`**, and an agent will grep for the name the
plan prints. `evaluate` threads a per-process `{ calls, errors, verdict }` snapshot through
`planNotifications(previousHealthy, previousModel, results)` (`:227`), so a differently shaped signal means
extending that state, not a one-line change: the snapshot gains `stuckSince` (the first tick at which
`body.stuckDeliveries > 0`, cleared whenever it reads 0), and `evaluate` returns unhealthy when `stuckSince`
is older than `STUCK_DELIVERIES_GRACE_MS` (default 10 minutes — long enough that an ordinary retry cycle
never pages). That is the same windowed shape the model-error-rate signal already uses, and for the same
reason: a point-in-time non-zero reading is not an outage, a sustained one is. `formatNotification` needs
no change.

**And the owner who closed the tab.** `messages.announcementStatus` is the durable read-back (MSG-5) — the
same `summariseAnnouncement` derivation §3's idempotent replay returns — and the panel polls it while the
compose screen is open (MSG-12). For an owner who navigated away, the honest answer is that this plan adds
**no** push notification and says so: the announcement's row is readable whenever they come back, the
failure is in the log and on the health endpoint, and a notification channel (email, a panel bell) is named
in "What this plan deliberately does not do" rather than implied. What the plan does fix is the one durable
signal an owner could otherwise stumble on: `apps/web/src/pages/Jobs.tsx` renders a bare `job.kind` string
(`:167`), so `messages.deliver` gains a human label there alongside the existing kinds.

### 10. `messages.redeliver` — the re-drive, specified rather than named

The previous draft mentioned `messages.redeliver` in exactly two places — a slice's file list and an
`EXPECTED_DESCRIPTORS` note — and specified nothing. That is an action which **sends real messages to real
people**, reachable through `POST /organizations/:id/actions/messages.redeliver`, the route this plan
itself documents as having no confirmation hook of any kind — flatly contradicting CAP-4, written in the
same document. It is specified here, in full.

```ts
export const DELIVERY_MAX_ATTEMPTS = 5

const redeliverInputSchema = z.object({ announcementId: z.string().min(1) }).strict()

export interface RedeliverOutput {
  announcementId: string
  /** Rows moved back to `pending` and enqueued by this call. */
  requeued: number
  /** Why the rest were left alone. Counts only — never a person id, never an address. */
  skipped: { sent: number; inFlight: number; unreachable: number; exhausted: number }
}
```

**Authorization and the policy boundary.** `policy.descriptor` is `{ resource: 'course', access: 'write' }`
and `policy.resolve` is `announcements.getAnnouncement(organizationId, input.announcementId, db)` — the
announcement is the tenant-scoped entity, so an announcement id from another organization and one that does
not exist resolve identically to `undefined` and raise the identical bare `ActionRefusedError` (TEN-5,
MSG-3). `execute` then repeats `messages.send`'s step 1 exactly: no `accountId`, or a membership whose role
is not `owner`, refuses. The owner check is in `execute` and not the policy for the same reason as before —
`PolicyContext` cannot see the caller.

**The confirmation gate applies, identically (CAP-4/CAP-8).** `messages.redeliver` is on
`PLATFORM_CAPABILITIES` with `destructive: true` and a `describeTarget` that names the announcement's
course and the number of recipients about to be attempted, and `execute` consumes an **agreed** grant bound
to `(accountId, 'messages.redeliver', fingerprint({ announcementId }))` before it changes a single row —
the same conditional `UPDATE`, the same refusals. A re-drive is not a lesser act than a send: it puts text
in front of real students. The panel's re-drive button therefore goes through the same three round trips
(§7), and a direct POST with no `X-Bloombot-Confirmation` header is refused by the action.

**Which states are re-drivable, and which are not.** One conditional `UPDATE`, whose `WHERE` is the whole
specification:

| state                              | re-driven? | why                                                                                       |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `failed`                           | yes        | a settled failure with a reason; the remedy MSG-10 exists for                              |
| `pending`, orphaned (stale `updated_at`) | yes  | MSG-28's orphan — a terminal job forgot its payload and nothing else will pick this up      |
| `pending`, fresh                   | no         | a live job still holds the batch                                                            |
| `claimed`, lease live              | no (`inFlight`) | somebody is posting it right now; reclaiming is how MSG-4's double-send happens         |
| `claimed`, lease lapsed            | yes        | the claim protocol already treats this as reclaimable                                       |
| `sent`                             | **never**  | the recipient already has it; re-driving is the "everybody gets it twice" failure MSG-10 names |
| `unreachable`                      | **never**  | see below                                                                                   |

Rows at `attempts >= DELIVERY_MAX_ATTEMPTS` are counted `exhausted` and left alone, which is what makes
MSG-10's "once each" a property of the store rather than of a caller's discipline: a looping client calling
redeliver ten times cannot attempt one recipient more than `DELIVERY_MAX_ATTEMPTS` times in total.

**A re-drive does not re-resolve reachability, and does not write new `messages` rows.** Every re-drivable
row already has a `surface` and a `message_id`: the recipient's copy was recorded at send time, in the
conversation their own surface reads (MSG-22), and only the delivery failed. Re-resolving would mean
possibly choosing a *different* surface, which would need a second `messages` row in a second conversation
— two copies of one announcement in one transcript, which is exactly what MSG-23 forbids. So an
`unreachable` row is **not** re-driven either: it has no address and no message row, and giving it one is
not a re-drive, it is a new send. The panel says so in words ("3 recipients had no address; sending again
will not reach them — invite them to connect"), and the `connectUrl` idiom is right there for
`no_identity`.

**What it enqueues.** The moved rows are batched into `DELIVERY_BATCH_SIZE` groups and enqueued as ordinary
`messages.deliver` jobs with the same staggered `availableAt` (§4), inside the same `writeTransaction` as
the `UPDATE`. A re-drive of six recipients is one job; a re-drive of eighty is four, staggered.

**The organization window does not apply, and a per-announcement bound does instead.** MSG-9's window
bounds *announcements started* per hour; a re-drive starts no announcement, reaches nobody who was already
reached, and is the documented remedy for a partial failure — counting it against the window would mean an
owner whose broadcast half-failed could be refused permission to finish it. What bounds a re-drive is
`DELIVERY_MAX_ATTEMPTS` per recipient row, which is a tighter bound than the window anyway: it is a bound
on *messages a real person can receive*, which is the thing that actually matters.

## Migration and rollout

The migration in §2 is a **full rebuild of the production `messages` table** — the largest and most
sensitive table on the box. Nothing about that is unusual for this repository (`0026_clear_stingray.sql`
did the same shape), but doing it on a live droplet has an order, a backup and a rollback, and the previous
draft printed a sequence that **cannot happen**. This section is addressed to the maintainer and belongs,
verbatim, in S1's PR body. **`docs/DEPLOY_DROPLET.md` is the maintainer's own document and no agent edits
it**; everything here is a statement about what `scripts/deploy.sh` and `.github/workflows/ci.yml` already
do, not a change to that document.

**There is no window unless the maintainer creates one, and the previous draft's sequence was unreachable.**
`.github/workflows/ci.yml`'s deploy job is
`if: github.ref == 'refs/heads/master' && (github.event_name == 'push' || github.event_name ==
'workflow_dispatch')`. **A merge to master ships and migrates automatically**, so there is no moment in
which a maintainer could have run "stop the writers, then deploy" — the deploy has already started. The
command that draft printed (`DEPLOY_… scripts/deploy.sh`) was also the known-dangerous invocation: it omits
the mandatory positional commit SHA (`deploy.sh` header; `:136` `usage: deploy.sh <commit-sha>`; `:845`
`git reset --hard "$TARGET_SHA"`) and omits `APP_DIR`, whose default is `$HOME/discord-channel-manager`
(`deploy.sh:73`) — the legacy Python checkout that `docs/DEPLOY_DROPLET.md:904`–`:910` records being
`git reset --hard`ed to a platform commit on the first real deploy, which is why `ci.yml:245` now refuses
to run without `DEPLOY_PATH`.

**The gate the repository actually supports.** `ci.yml:145`–`:146`, on the deploy job's own
`environment: production`, says it outright: *"Adding required reviewers to this environment turns every
deploy into an approval click."* That is the window, and it is a settings change, not a code change:

1. **Before merging S1**, add a required reviewer to the `production` environment (GitHub → Settings →
   Environments → production → Required reviewers). Every deploy now pauses for an approval.
2. Merge S1. CI runs the three test jobs; the deploy job reaches `production` and **waits**.
3. On the droplet, optionally quiet the writers (below), then **approve the deployment** in the Actions UI.
   `deploy.sh` runs its ordinary path: `npm ci` → build → `backup_database` → migrate → reload.
4. After the deploy is confirmed healthy, remove the required reviewer if the maintainer does not want an
   approval click on every future deploy.

If the maintainer would rather not change environment settings at all, the alternative is honest and
simple: **merge S1 at a quiet hour and let it ship**, relying on the three properties below. What is not
available is a sequence that stops processes between the merge and the migration, and the plan no longer
pretends otherwise.

**Why letting it ship is survivable — three properties, each verified.**

1. **The migration file is atomic.** `packages/db/src/migrate.ts`'s own comment records that drizzle-orm's
   `migrate()` "wraps every pending migration file in one `BEGIN`/`COMMIT`". S1 is one file, so a
   `SQLITE_BUSY` from a concurrent writer rolls that file back whole and fails the deploy — which then
   triggers `restore_previous_checkout` (`deploy.sh:944`) with the database untouched. `deploy.sh`'s header
   warning about "a migration that fails partway" is about a *batch of files*, not a statement inside one.
2. **The backup is taken immediately before.** OPS-19/D-104: `better-sqlite3`'s `Database#backup()` (the
   SQLite online backup API, safe under concurrent writers and under WAL, which a `cp` is not), verified
   with `pragma integrity_check` and switched out of WAL so the file stands alone. An unresolvable driver
   fails loudly rather than falling back to `cp`. **That backup is the rollback**, and the restore command
   `backup_database` logs is a Node one-liner, because the droplet has no `sqlite3` CLI.
3. **The automatic code rollback no longer breaks message recording.** This is the whole reason
   `authored_by` carries `DEFAULT 'unattributed'` (§2). `deploy.sh` rolls the code back automatically and
   never restores the backup; without the default, the previous release's `appendMessage` would fail on
   every insert while `confirm_rolled_back_online` reported success. With it, a rolled-back release keeps
   recording messages, marked with a value that says exactly what happened.

**Quieting the writers is optional risk reduction, and here is its own cost.** If the maintainer wants the
rebuild to run against a file nobody is writing, then between steps 2 and 3 above, on the droplet:

```
pm2 stop bloombot-ops-monitor                                        # FIRST — see below
pm2 stop bloombot-api bloombot-bot bloombot-worker bloombot-mcp
# …approve the deployment in the Actions UI; deploy.sh's own reload brings them back…
pm2 status                                                           # confirm all five are `online`
pm2 start ecosystem.config.cjs --only <name>                         # only if one came back stopped
```

Three things about that sequence, none of which the previous draft said:

- **Stop `bloombot-ops-monitor` first.** `planNotifications` (`scripts/ops-monitor.mjs:227`) pushes a
  notification on every healthy→unhealthy transition **and on every recovery**, and OPS-12 exists to page a
  human on exactly that. A planned window otherwise produces four "is unhealthy" pages and four
  "recovered" pages. It is in `SUPERVISED_APPS` (`deploy.sh:110`), so `reload_everything` starts it again.
- **All four Node processes call `runMigrations` at startup** (`apps/api/src/index.ts:213`,
  `apps/bot/src/index.ts:107`, `apps/mcp/src/index.ts:89`, `apps/worker/src/index.ts:151`), and
  `runMigrations` is idempotent, so stopping and restarting them is safe and nothing races the deploy's own
  migrate step.
- **Verify they came back.** `start_or_reload` (`deploy.sh:557`) calls `pm2 reload <name>` for a process
  pm2 already knows — which a *stopped* process still is — and `check_pm2_health` (`:727`) then requires
  `status = online`. If a stopped process does not come back online, the deploy's own health check fails
  and rolls the code back, which property 3 above makes survivable, but it is a rollback nobody wanted.
  That is the risk the maintainer is trading against `SQLITE_BUSY`, and it is why "just let it ship at a
  quiet hour" is a legitimate choice rather than a lazy one.

**Expected duration is dominated by row count, not by the rebuild's complexity** — it is one
`INSERT … SELECT` over `messages` plus three `CREATE TABLE`s and six indexes. The maintainer should run
`select count(*) from messages;` against the droplet first; at the scale this platform runs (thousands to
low tens of thousands of rows) the rebuild is seconds, and if that count is ever in the millions the
calculus changes and this section should be revisited before the deploy.

**Rollback.** Restore the pre-migration backup `backup_database` just wrote, using the Node command it
logged, and redeploy the previous checkout — `ci.yml`'s `workflow_dispatch` with `deploy_sha` set to the
previous 40-character commit is the supported way, and `restore_previous_checkout` already handles the code
half when the deploy fails on its own. There is no "down" migration: `packages/db` has never shipped one
and this change does not introduce the concept. The backup is the undo. **Note the asymmetry the operator
must hold in their head:** the automatic rollback restores *code only*. After it, the database is still on
the new schema — which is fine, because of the default.

**The legacy Python bot — already answered.** The previous draft made this an open question. It is not one:
`DEPLOY_SKIP_PYTHON_BOT` is listed in `docs/DEPLOY_DROPLET.md:901` as a repository variable already set to
`1`, alongside `DEPLOY_PORT` 2222 and `DEPLOY_PATH`, so the deploy passes `PM2_APP=` and never restarts
`response_bot.py`. The supporting reasoning is worth keeping anyway, because it bounds the damage if that
variable is ever unset: `models/message.py` declares `table_name = "messages"` over `content`, `category`,
`channel`, `direction` and a `user` FK, which is *not* the platform's `messages` shape (`organization_id`,
`conversation_id`, `person_id`, `course_id`, `sequence`, …). Two incompatible tables cannot share one name
in one SQLite file, and no migration in `packages/db/migrations` uses `CREATE TABLE IF NOT EXISTS` —
`messages` is created bare in `0002_wet_shotgun.sql` — so if migration `0000` ever succeeded against that
droplet's `DATABASE_PATH`, the Python bot's own `messages` was not in that file. And with `authored_by`
defaulted, even a peewee `INSERT` that does not name the column would now succeed rather than fail.

**No new process, no new pm2 app, no new nginx change.** Delivery is a job kind on the existing worker; the
preview, confirmation and status routes are three routes on the existing `apps/api`. **Four new env vars**,
all optional with defaults, all following the `JOB_*`/`DISCORD_CATCHUP_*` idiom in
`packages/config/src/env.ts` and all added to `env.example`: `DELIVERY_BATCH_SIZE` (default 25),
`DELIVERY_BATCH_STAGGER_MS` (default 90 000) and `STUCK_DELIVERY_AFTER_MS` (default 3 600 000) in S3B, and
`CONFIRMATION_GRANT_TTL_MS` (default 600 000) in S5. The Discord pacing intervals stay exported constants
rather than configuration, because they describe Discord's limits, not this operator's preference.

## Decisions taken, with reasons

**Attribution, not impersonation.** A sent message is recorded as `direction: 'to_person'` with
`authoredBy: 'account'` and the sender's account id, and every reader renders the distinction. _Rejected:_
a third `direction` value — it forces the same table rebuild for less information, and "to the person" is
still true. _Rejected:_ a nullable `sentByAccountId` where `NULL` means the assistant — that is an inference
on absence, which this codebase refuses elsewhere for exactly this reason. **Where the name is rendered is
per surface, and the recorded text is never decorated:** `messages.content` is the owner's own text, and
the panel, the Transcripts screen and the ADMIN-3 export all render the author from the column. Discord has
no renderer of its own — a channel post is just text — so the Discord transport prefixes the delivered text
with `<Name> (via the assistant)` at delivery time, within the arithmetic §4 fixes. **Four readers, not
two:** `apps/web/src/pages/Chat.tsx`, `apps/web/src/pages/Transcripts.tsx` (which today derives the speaker
from `entry.direction === 'from_person' ? 'asked' : 'answered'`), the ADMIN-3 export
(`apps/worker/src/handlers/transcripts.ts:188`), and `analytics.ipynb` — plus a fifth on MCP (§6.1). The
first three are in scope, because a retained record that still says the assistant said it is the exact
failure MSG-2 names, and they all read `TranscriptEntry` from `packages/db/src/repos/transcript-access.ts`
— so **that file is in S4's scope**, gaining `authoredBy` and `authoredByAccountDisplayName` on
`TranscriptEntry`, which also changes the ADMIN-3 export's column set (a widening, not a rename; the
existing columns keep their meaning and order). `analytics.ipynb` is named here rather than edited: ANLY-2
and ANLY-3 chart message volume and per-user engagement off `messages`, and staff announcements become
`to_person` rows that will inflate "bot messages" until a notebook cell filters on `authored_by` — a
one-line change in a notebook the maintainer owns, flagged in S4's PR body.

**One surface per recipient, by preference order — not fan-out to all of them.** A person reachable on
Discord and on the web gets one message, on Discord. _Rejected:_ delivering on every surface — it turns one
announcement into N copies in one transcript and makes "reached" unanswerable. The order is stated in
D-109, and a recipient's chosen surface is recorded on their delivery row, so a report can say where each
one went.

**Job-queued, batched, staggered, never synchronous.** `execute` writes rows and enqueues; the worker does
the I/O. _Rejected:_ sending inline from the action — it would put network I/O inside a database
transaction, in a process (the API) that PLAT-3 keeps off Discord's gateway, with no retry. _Rejected:_ one
job per recipient — the worker runs one job at a time and 200 of them head-of-line block every other
tenant's roster imports and exports. Batches of 25, enqueued with a staggered `availableAt`, bound that to
"one batch" while the per-row conditional claim keeps idempotency per recipient (§4).

**The shared bot token is the scarcest thing this feature spends.** `apps/worker` and `apps/bot` hold the
same token, and Discord's limits are per token. So the transport prefers an existing private channel over
opening a DM, and a global rate-limit response stops the whole batch rather than continuing (MSG-27). The
blast radius being protected is not a slow broadcast: it is PLAT-3's single gateway connection, which every
student on the platform depends on to be answered at all.

**An announcement does not enter the model's context, and the plan says so.** `answerQuestion` builds its
request from the course configuration plus the single `question`; continuity is entirely provider-side
through `upstreamThreadId` (`packages/core/src/answer.ts`, `model.ask({ …, upstreamThreadId, question })`),
and `getTranscript` has exactly two non-test callers — `apps/api/src/routes/chat.ts:289` and
`packages/legacy-import/src/import-messages.ts:128` — neither of which is the answering pipeline. Writing a
`messages` row therefore puts **nothing** in the model's context, and a student who replies "what do you
mean, Friday?" is answered by a model that has not seen the announcement. This plan does not pretend
otherwise and does not fix it: injecting an announcement into the upstream thread would mean a new verb on
the model port and a write against `packages/openai`'s conversation object, which is its own requirement
with its own cost. It is named in "What this plan deliberately does not do".

**A recipient unreachable on every surface is recorded, not retried and not dropped.** They get a
`message_deliveries` row in `unreachable` with an enumerated reason and **no** `messages` row — writing a
transcript entry nobody can read would make the transcript lie. The count and the reasons come back in the
send's own output and are readable afterwards through `messages.announcementStatus`. This is ROST-12's
shape ("an import says what it could not do"), applied to sending. The panel renders each reason in words,
not codes, and reuses the existing idiom for the commonest one: `no_identity` renders as the same
`connectUrl` invitation `packages/discord/src/handle-mention.ts` already embeds in its own refusal, so a
student who never connected is one link away rather than one jargon term away. An `unreachable` row is not
re-drivable (§10), and the panel says so where the re-drive button is.

**Bounded by a real bound.** A recipient cap alone bounds one call, not the number of calls. The
organization gets at most `SEND_MESSAGE_ORGANIZATION_WINDOW_MAX` announcements per rolling window, refused
with the same bare `ActionRefusedError`; an `idempotencyKey` dedupes an identical resend inside that window
so a retrying client, a looping agent and a double-clicked button are one announcement, not three. One send
reaches at most `SEND_MESSAGE_MAX_RECIPIENTS` people and carries at most `SEND_MESSAGE_MAX_LENGTH`
characters (MSG-21); one recipient row is attempted at most `DELIVERY_MAX_ATTEMPTS` times across every
re-drive (§10); and a capability turn is bounded in rounds, invocations and wall clock (CAP-12). Without
these, an owner's leaked MCP token or a looping agent fans out repeatedly against a single-writer SQLite
with a 5 s `busy_timeout`.

**Charged to nobody.** Sending spends no model tokens, so it writes no `cost_ledger_entries` row and
consumes no recipient's CONV-3 daily allowance — a student's allowance bounds what _they_ may ask, and
spending it on a message they did not ask for would let an owner silence their own students. _Rejected:_
the `meter` hook — no action in the platform defines one, and the precedent that does exist is to reserve
and record inside the code that does the work. The _assistant turn_ that invokes the capability is priced
normally, per round (§8, CAP-7), because that turn really does call a model.

**Retention and PII.** The durable record is `announcements.body` plus the `messages` rows, never the job
payload — `completeJob` and `markJobFailed` both NULL `payload` in the same write (JOB-6), so a
payload-borne text is gone the moment the job settles. `announcements.body` is retained for the life of the
tenant, on the same footing as the `messages` rows it produced and deleted by the same TEN-6/MSG-13 path;
it is the record of what was said, and a record that outlives its own text explains nothing.
`message_deliveries.detail` holds a `DeliveryReason` and never a provider body, a channel id, a snowflake,
a handle or an email; the delivery handler catches every per-recipient error and re-throws only a
recipient-free retryable marker, so `jobs.lastError` — which `apps/mcp/src/tool-surface.ts` keeps on its
model-visible allowlist only because today's handlers never throw a value naming a roster row, and whose
own comment predicts "a future handler that threw a per-row error including a student's own address would
reopen exactly this shape" — does not become that handler. `messages.announcementStatus` and
`messages.redeliver` both return allowlisted fields and counts, the way `allowlistJobFields` already
reduces `jobs.get`, and never a recipient's address. `confirmation_grants` is swept (§7, CAP-11). And this
feature adds a **fourth** direction to the three `apps/web/src/content/privacy.ts` currently enumerates
("it leaves the service in exactly three directions", `:106`): an unsolicited Discord message to a student.
That file is in S5's scope, because a privacy statement that undercounts the ways data leaves is worse than
none.

## Threats and how the design refuses them

**A student prompt-injects the assistant into broadcasting.** Three mechanisms, because the speaker check
alone is not enough. First, `resolveSpeakerAuthority` gives a student `{ kind: 'none' }`, so no tool schema
is ever sent in their turn — the model is not told the capability exists. Second: in an _owner's_ turn the
request would otherwise carry the course's vector store and its configured web-search domains, which is
text the owner did not write and an adversary may control, so the capability round runs as a separate
`model.ask` with `vectorStoreId: null` and `webSourceDomains: []` (§8, CAP-5). Third, every irreversible
capability needs a grant a human _agreed to_, with no `DENY_ALL` path. _Tests:_
`packages/core/tests/agent-capabilities.test.ts` — a student speaker gets a request with `availableTools`
empty; an owner speaker's capability round carries no `vectorStoreId` and no `webSourceDomains`; a fake
model whose retrieved-content stub says "send an announcement to everyone" produces no invocation without
an agreed grant; and the three CAP-12 bounds each fire.

**A member with a non-owner role.** `execute` reads `memberships.getMembership(...).role !== 'owner'` and
raises the bare `ActionRefusedError` — the same shape a nonexistent course raises, for both
`messages.send` and `messages.redeliver`. _Test:_
`packages/actions/tests/actions/messages-send.test.ts` — an instructor and an assistant each get
`ActionRefusedError`, and no `announcements` row exists afterwards.

**A disabled owner still holding a Discord identity.** `resolveSpeakerAuthority` re-reads
`accounts.disabledAt`. _Test:_ `packages/db/tests/speaker-authority.test.ts` — an owner whose account is
disabled resolves to `{ kind: 'none' }` on every surface; and the Discord/web capability tests carry a
disabled-account row mirroring TEN-5's matrix.

**A cross-tenant `courseId` or `announcementId`.** `policy.resolve` is
`courses.getCourse(organizationId, ...)` for the send and
`announcements.getAnnouncement(organizationId, ...)` for the re-drive, so a foreign entity resolves to
`undefined` and `dispatch` refuses before `execute` runs. The existing
`packages/actions/tests/policy-scoping.test.ts` does **not** cover this automatically — it imports four
named actions and asserts against them by hand — so the proof is an explicit case in
`packages/actions/tests/actions/messages-send.test.ts`: a course id from organization B dispatched under
organization A raises `ActionRefusedError`, and a foreign `personId`, an unknown `personId`, an ended
enrolment and a foreign `announcementId` all raise the byte-identical error.

**A forged author.** `accountId` comes from `DispatchContext`, never from the action's input — the existing
rule, and the reason `SendMessageInput` has no author field at all. `authoredByAccountId` is written from
that same value inside the transaction. The same argument covers the grant id, which rides on
`DispatchContext.confirmation` and is read off a header by the route, never off the body. _Test:_
`messages-send.test.ts` — an input carrying `accountId`, `authoredByAccountId` or `confirmation` **fails
`inputSchema` parsing**, which is a real assertion only because `sendMessageInputSchema` is `.strict()`
(§3); a companion case asserts the schema _is_ strict, so a later refactor that drops `.strict()` fails
loudly rather than turning the forgery test vacuous. Dispatch with no `accountId` refuses rather than
writing an anonymous message.

**A confirmation nobody agreed to.** A grant minted by `/preview` and never agreed to is an
`agreed_at IS NULL` row, and `execute`'s consuming `UPDATE` requires `agreed_at IS NOT NULL`. _Tests:_
`apps/api/tests/routes/actions.test.ts` — `/preview` followed immediately by the action, with no
`POST /confirmations/:id` in between, is refused and writes no `announcements` row; and the cross-surface
parity test (below) asserts the same property through `invokeCapability` for every surface.

**Mention / `@everyone` abuse.** The REST verb itself sets `allowed_mentions: { parse: [] }`; no caller can
omit it, which is stronger than the `apps/bot` arrangement D-17 describes (where the value is set
redundantly in two places by convention). _Test:_ `packages/discord-rest/tests/create-message.test.ts` — a
captured request body always carries `allowed_mentions: { parse: [] }`, including for a body containing
`@everyone`.

**A broadcast that swamps Discord — or takes the answering bot down with it.** The transport paces DM
opens and posts, reads the `retry_after` Discord actually states, retries a limited recipient in place
rather than re-running the batch, and **stops the whole batch on a global limit** rather than spending more
of a token `apps/bot` depends on. _Test:_ `apps/worker/tests/delivery/discord.test.ts` — a fake clock
asserts that 25 deliveries issue DM opens no closer together than `DISCORD_DM_OPEN_MIN_INTERVAL_MS`; a 429
carrying `retry_after: 2` sleeps 2000 ms and succeeds on the retry; a recipient limited past
`DISCORD_RATE_LIMIT_RETRIES` settles `failed`/`rate_limited` **and the remaining recipients in the batch
are still attempted**; and a 429 carrying `X-RateLimit-Global` makes **zero** further Discord calls, leaves
the unattempted rows `pending`, and throws a retryable error carrying Discord's own delay.

**A batch that runs out of budget.** The handler stops claiming at
`JOB_HANDLER_TIMEOUT_MS - DELIVERY_DEADLINE_MARGIN_MS` and leaves the rest `pending`; the claim lease
(`DELIVERY_CLAIM_LEASE_MS`, 300 000) outlives the handler budget (240 000), so an abandoned handler that is
still writing to a socket cannot have its row reclaimed underneath it. _Test:_
`apps/worker/tests/handlers/message-delivery.test.ts` — a fake clock advanced past the deadline mid-batch
leaves the remaining rows `pending`, logs `delivery.batch.deadline`, and makes no further transport call;
and a second run started while the first row's lease is live makes zero transport calls for that row.

**An MCP client that cannot elicit a confirmation.** `getClientCapabilities()?.elicitation?.form` absent,
a thrown request, a timeout, a decline and a cancel are all `undefined` from the port, which mints no grant,
and `messages.send`'s own gate refuses without one. _Test:_ `apps/mcp/tests/mcp-e2e.test.ts` — a client with
no elicitation capability gets `ConfirmationRequiredError` and no `announcements` row exists.

**A request straight to the generic HTTP action route.** `POST /organizations/:id/actions/messages.send`
(and `…/messages.redeliver`) with no `X-Bloombot-Confirmation` is refused by the action, not by the route.
_Test:_ `apps/api/tests/routes/actions.test.ts` — an owner POSTing `messages.send` with a valid body and no
confirmation header gets 404 `action_refused`; the same body with a grant minted for _different_ input is
refused too; and a regression case asserts that an action with no confirmation requirement
(`projects.list`) still dispatches with `req.body` unchanged, so the header addition breaks nothing.

**Replay of a job after a worker restart.** The conditional claim moves `pending → claimed` and only a 2xx
moves `claimed → sent`; a crash between the claim and the REST call leaves a `claimed` row whose lease
lapses and which is then reclaimed, so a crash is not silently reported as a success and a redelivery is
not a double-send. _Test:_ `apps/worker/tests/handlers/message-delivery.test.ts` — a handler that throws
after claiming leaves the row reclaimable and one transport call in total once the retry completes; a
handler run twice against a `sent` row makes zero transport calls.

**An outbox that stops mid-flight and nobody notices.** A terminally failed job NULLs its own payload
(JOB-6), so the recipients it never reached sit `pending` with nothing carrying them.
`checkWorkerHealth().stuckDeliveries` counts those alongside lease-lapsed `claimed` rows, ops-monitor pages
on a sustained non-zero value, and §10's re-drive finishes them. _Test:_ `apps/worker/tests/health.test.ts`
— a `claimed` row whose lease lapsed over an hour ago **and** a `pending` row untouched for over an hour
each count toward `stuckDeliveries`, while `ready` stays `true`; plus
`scripts/board`-style unit coverage of `evaluate` in `scripts/ops-monitor.test.mjs` for the `stuckSince`
window.

**A stale private channel.** The Discord transport verifies the assignment still belongs to this person and
that their current per-person overwrite (read from the batch's one cached `listGuildChannels` response)
still grants read, before posting. _Test:_ `apps/worker/tests/delivery/discord.test.ts` — a person whose
`roster_channel_assignments` channel is now recorded for somebody else is delivered by DM, and a person
whose overwrite is gone is recorded `unreachable` with `channel_not_permitted`, with no post to that
channel; and 25 recipients in one guild produce exactly one `listGuildChannels` call.

**A re-drive that sends somebody a second copy.** `messages.redeliver`'s conditional `UPDATE` never touches
a `sent` row, never touches a `claimed` row whose lease is live, and never touches an `unreachable` one;
rows at `DELIVERY_MAX_ATTEMPTS` are counted `exhausted`. _Test:_
`packages/actions/tests/actions/messages-redeliver.test.ts` — a `failed` row is re-driven exactly once, a
`sent` row is untouched, a live-lease `claimed` row is reported `inFlight`, an `unreachable` row is
untouched, a tenth call cannot push any row past `DELIVERY_MAX_ATTEMPTS`, and the whole thing is refused
without an agreed grant.

**A student replying into the void.** The DM fallback is a common path for any student without a verified
private channel, and today a reply to one reaches nothing at all (gap 9). S3C makes the bot receive DMs and
reply. _Test:_ `apps/bot/tests/message-handler.test.ts` — a `messageCreate` whose `inGuild()` is false
produces a reply naming where to ask and a log line, and makes no model call; a second DM inside
`DM_REPLY_COOLDOWN_MS` produces no second reply.

**A tenant deleted after it ever sent.** _Test:_ `packages/db/tests/organizations-deletion.test.ts` —
`seedFullTenant` seeds an announcement, two delivery rows (one with a `message_id`, one `unreachable`) and
a confirmation grant; `deleteOrganizationData` removes every one of them and the organization, and
`previewOrganizationDeletion` counts them first. **This test fails before the change with
`FOREIGN KEY constraint failed`**, which is the point.

**A student reading somebody else's messages through the MCP read-back tool.** That tool joins
`MCP_CHAT_TOOL_SURFACE`, which is deliberately not membership-gated, so it takes **no** person or
conversation identifier: it resolves the caller's own person exactly as `chat-tools.ts#resolveAdmittedCourse`
does and returns only that person's own conversation (§6.1). _Test:_
`apps/mcp/tests/chat-tools-server.test.ts` — a `personId`-shaped extra argument changes nothing about what
comes back.

## Build sequence

Branches target `feat/PLAT-1-multi-surface-platform` unless noted, and each is named
`feat/<REQ-ID>-<slug>` per `.claude/CLAUDE.md` — with that file's own fallback ("use a short descriptive
slug when no requirement id applies") for the one enabling slice that claims no id. Each slice's PR body
carries `Closes #N` for the issue numbers `npm run board:sync` produced in S0 (checked, not guessed — board
issues are not numbered in family order). Each slice runs `npm run board:status -- "In progress" <ids>`
when it starts, `-- "In review" <ids>` when its PR opens and `-- Done <ids>` when it merges, and commits the
manifest change the script makes.

**Each requirement id belongs to exactly one slice, and that slice is the one that makes it observably
true.** This is the repartition the previous draft failed: six ids were owned by slices that did not build
them, so `board:status -- Done <id>` would have closed a card for work that merged in a different PR or had
not merged at all — and one slice shipped user-visible MCP tools under no id whatsoever, against
`docs/ROADMAP.md:15`–`:17`'s own rule that new program work joins a phase's `**In scope:**` line in the
same PR. Where a requirement genuinely bundled two testable properties landing in two slices, it was split
by **adding** an id (MSG-19…MSG-29, CAP-8…CAP-12); no existing id was repurposed.

**Only one agent writes the working tree at a time** unless each gets its own `git worktree`. Where two
slices are marked parallel-safe, they are so only with separate worktrees.

**`docs/DECISIONS.md` is a serialisation point, and the plan says so rather than discovering it.** Four
slices append a decision (D-107 in S3, D-108 in S1, D-109 in S2, D-110 in S5) while S3/S3B/S3C/S4/S5
interleave and S3 is parallel-safe with S4. Two rules follow: **the numbers above are reservations, not
guarantees** — a slice re-reads the highest `D-` in the file at merge time and takes the next free number,
updating its own cross-references; and a slice that finds a conflict in that file rebases rather than
resolving by hand, because the file is append-only and a rebase is always the smaller change. (D-106 is the
highest today, `docs/DECISIONS.md:11660`.)

**S0 — SPEC, ROADMAP and the board.** Branch: **straight to `master`** (documentation and `scripts/` are
the documented exception to the PR flow). Edits `docs/SPEC.md` (§36, §37, and the two in-place amendments
to MCP-4 and CONV-2), `docs/ROADMAP.md` (Phases 29 and 30), `scripts/board/config.mjs` (all three edits —
see the SPEC.md additions section for the exact shapes). Then `npm run board:derive`, commit the manifest,
`npm run board:sync`, and record the **forty-one** issue numbers in the PR descriptions of every later
slice. Cherry-picked onto `feat/PLAT-1-multi-surface-platform` so the manifest is present there. _Ids:_
none. _Blocks everything_ — `Closes #N` cannot be written before the issues exist. _Done when:_
`npm run board:derive` leaves `scripts/board/manifest.yaml` unchanged on a second run and every new id
shows a non-zero phase (an id claimed by no phase is seeded phase 0 / status Done and lands pre-closed).

**S1 — Schema, repos, transactions, tenant deletion.** Branch `feat/MSG-19-message-authorship-and-outbox`.
Files: `packages/db/src/schema.ts`, a generated-then-hand-edited migration (the backfill `CASE` and the
`DEFAULT 'unattributed'`), `packages/db/src/repos/conversations.ts` (widen
`getOrCreateConversation`/`appendMessage` to `TransactingExecutor`, `NewMessage` gains the `MessageAuthor`
union, rewrite the retry-loop comment), **`packages/db/src/repos/organizations.ts`** (the three tables
added to `deleteOrganizationData` in FK-safe order — `message_deliveries` strictly before the existing
first `messages` delete — plus two new counts on `OrganizationDeletionPreview`), new
`packages/db/src/repos/announcements.ts` (including `summariseAnnouncement`), `message-deliveries.ts`,
`confirmation-grants.ts`, `reachability.ts`, new `packages/schemas/src/messaging.ts` and its `index.ts`
export, `packages/core/src/answer.ts` (two call sites), `packages/legacy-import/src/import-messages.ts`
(one call site), `packages/db/tests/*`, `docs/DECISIONS.md` (**D-108** — the rebuild, the
`'unattributed'` default, the deployment ordering and the rollback asymmetry). _Ids:_ **MSG-13, MSG-19**.
_Fails without it:_ (a) the new `migrate.test.ts` case — a database migrated through `0029`, seeded with one
message in each direction, then migrated forward: `person`/`assistant`, none `unattributed`, row count
unchanged; (b) `packages/db/tests/migrate.test.ts`'s pinned column and table lists; (c)
`packages/db/tests/organizations-deletion.test.ts` with `seedFullTenant` extended — `deleteOrganizationData`
throws `FOREIGN KEY constraint failed` before the reordering; (d) `packages/db/tests/reachability.test.ts`.
_Done when:_ migrations are idempotent, the tenant-scoping convention test passes with no new allowlist
entry, and the deletion test passes. The PR body carries the **Migration and rollout** section verbatim.
**Serialise.** Blocks S2–S6.

**S2 — The action, the fan-out and the confirmation grant.** Branch `feat/MSG-22-send-message-action`.
Files: `packages/actions/src/actions/messages.ts` (the action, the `.strict()` input schema, the five
exported constants), `packages/actions/src/confirmation.ts`, `packages/actions/src/actions/index.ts`,
`packages/actions/src/dispatch.ts` (`DispatchContext.confirmation`),
`packages/actions/tests/access-audit.test.ts`, `docs/DECISIONS.md` (**D-109** — preference order and the
unreachable vocabulary). **No change to `packages/actions/package.json`, its tsconfig references, or
`createPlatformRegistry`'s signature**: `resolveReachability` comes from `@bloombot/db` and the reason
vocabulary from `@bloombot/schemas`, both already dependencies (§1). _Ids:_ **MSG-3, MSG-8, MSG-9, MSG-20,
MSG-21, MSG-22, MSG-23, MSG-24, CAP-8**. _Fails without it:_
`packages/actions/tests/actions/messages-send.test.ts`. _Done when:_ `EXPECTED_DESCRIPTORS` gains **one**
row (`messages.send`) and "registers exactly the actions this table expects" passes —
`messages.announcementStatus` is S5's and `messages.redeliver` is S6's, and each of those slices adds its
own row in the same commit that registers it. **Serialise** (S1 → S2).

**S3 — Discord delivery: the REST verbs and the transport.** Branch `feat/MSG-25-discord-delivery`. Files:
`packages/discord-rest/src/http.ts` (`JsonResponse.headers`), `packages/discord-rest/src/client.ts`
(`createMessage`, `createDm`, the REST mention constant, `DiscordRequestError.retryAfterMs` and `.global`,
and the module-comment justification beside the two existing write exceptions),
`packages/discord-rest/tests/create-message.test.ts`, `apps/worker/src/delivery/types.ts`,
`apps/worker/src/delivery/discord.ts`, `docs/DECISIONS.md` (**D-107** — the write verbs, the pacing
constants, the global-limit breaker and the 200-recipient wall-clock). _Ids:_ **MSG-7, MSG-15, MSG-25,
MSG-26, MSG-27**. _Fails without it:_ `apps/worker/tests/delivery/discord.test.ts` (which owns **every**
pacing, retry, global-breaker and stale-channel assertion in this plan — they are named in one file, not
two) and `packages/discord-rest/tests/create-message.test.ts`. **Parallel-safe with S4 in a separate
worktree.**

**S3B — The delivery handler: batching, staggering, the web transport, logging, health.** Branch
`feat/MSG-4-delivery-claim-and-batching`. Files: `apps/worker/src/handlers/message-delivery.ts` (the claim
protocol, the deadline check, `DELIVERY_BATCH_SIZE`, the five log lines of §9),
`apps/worker/src/delivery/web.ts`, `apps/worker/src/index.ts` (registration),
`apps/worker/src/health.ts` (`stuckDeliveries`), `scripts/ops-monitor.mjs` (the `stuckSince` window in
`evaluate` and the state it threads), `packages/config/src/env.ts` and `env.example`
(`DELIVERY_BATCH_SIZE`, `DELIVERY_BATCH_STAGGER_MS`, `STUCK_DELIVERY_AFTER_MS`),
`apps/web/src/pages/Jobs.tsx` (a label for `messages.deliver`). _Ids:_ **MSG-4, MSG-11, MSG-16, MSG-17,
MSG-28**. _Fails without it:_ `apps/worker/tests/handlers/message-delivery.test.ts` (claim protocol,
deadline, lease, the `lastError`/`detail` reason-code discipline), `apps/worker/tests/health.test.ts`
(`stuckDeliveries` counts both states, `ready` unchanged) and a `packages/db/tests/jobs.test.ts` case —
with a delivery batch enqueued `availableAt` in the future, `claimNextJob` returns the roster import
enqueued after it. **Serialise after S3.**

**S3C — The DM reply path.** Branch `feat/MSG-18-dm-reply-path`. Files: `apps/bot/src/index.ts`
(`GatewayIntentBits.DirectMessages` and `Partials.Channel` — `DirectMessages` is **not** a privileged
intent, unlike `GuildMembers`/`MessageContent`, so it needs no developer-portal change; `Partials.Channel`
is required because discord.js does not cache DM channels and would otherwise drop the event),
`apps/bot/src/message-handler.ts` (replace the bare `if (!message.inGuild()) return` with a DM branch),
new `apps/bot/src/dm-reply.ts`. The DM branch does **not** call the model: BOT-1's routing is by category
and channel, a DM has neither, and a student may be enrolled on several courses, so a model call would have
to guess which course it is about. It replies with a fixed message naming where to ask — the course
channel, or the `connectUrl` if the speaker resolves to no person — logs `event: 'dm.received'` with a
reason and no message content, and rate-limits itself to one reply per channel per `DM_REPLY_COOLDOWN_MS`
so a student typing three messages gets one answer. It records nothing in `discord_handled_messages`:
SURF-9's catch-up scans guild channels only, so there is no scan to dedup against. _Ids:_ **MSG-18**.
_Fails without it:_ `apps/bot/tests/message-handler.test.ts` — a DM produces a reply and a log line (today
neither), and a second DM inside the cooldown produces no second reply. **Parallel-safe with S4/S5 in a
separate worktree.**

**S4 — The web inbox and the attribution renderers.** Branch
`feat/MSG-2-staff-attribution-and-inbox`. Files: `apps/api/src/routes/chat.ts` (a `since` cursor on the
transcript GET), `packages/db/src/repos/conversations.ts` (`getTranscript` gains an optional
`afterSequence`), **`packages/db/src/repos/transcript-access.ts`** (`TranscriptEntry` gains `authoredBy`
and `authoredByAccountDisplayName`), `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`
(`ChatMessageEntry.role` gains `'staff'` plus an author name; the hand-mirrored `TranscriptEntry` at `:586`
gains the same two fields), `apps/web/src/pages/Chat.tsx` (poll on an injectable `pollIntervalMs`, the
idiom `ScaffoldButton` and `CourseAttachments` already use, plus the `role="status"` region and politeness
level WEB-25 established), `apps/web/src/components/ChatMessage.tsx`, `apps/web/src/pages/Transcripts.tsx`,
`apps/worker/src/handlers/transcripts.ts`. Every renderer treats `'unattributed'` exactly as it treats a
pre-MSG-19 row — from `direction` — and there is a case for it. _Ids:_ **MSG-2, MSG-14**. _Fails without
it:_ `apps/web/tests/chat.test.tsx`, `packages/db/tests/transcript-access.test.ts` and
`e2e/outbound-messaging-arrival.spec.ts`. Its PR body notes the ADMIN-3 export's widened column set and the
`analytics.ipynb` cell the maintainer may want to add. **Parallel-safe with S3 in a separate worktree.**

**S5 — The panel: compose, the human's own confirmation, the status read-back, the sweep.** Branch
`feat/MSG-12-compose-and-confirm`. Files: `apps/api/src/routes/actions.ts` (the `/preview` sibling route,
reading `X-Bloombot-Confirmation` onto `DispatchContext`), a new `apps/api/src/routes/confirmations.ts`
(`POST /organizations/:organizationId/confirmations/:id` — the human's own agreement round trip),
`apps/api/src/server.ts` (the `unref()`'d grant sweep interval, in the shape of
`apps/mcp/src/server.ts:912`), `packages/db/src/repos/confirmation-grants.ts`
(`pruneConfirmationGrantsOlderThan`, created **and** called in this slice),
`packages/actions/src/actions/messages.ts` (`messages.announcementStatus`) and its `EXPECTED_DESCRIPTORS`
row, a new `apps/web/src/components/ComposeAnnouncement.tsx` (the composer, the character counter announced
to a screen reader, the modal whose destructive confirm focuses Cancel per `Modal.tsx`'s documented rules,
and the unreachable report rendered in words with the `connectUrl` idiom for `no_identity`),
`apps/web/src/pages/Course*.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/content/privacy.ts` (the
fourth direction), `packages/config/src/env.ts` (`CONFIRMATION_GRANT_TTL_MS`), `docs/DECISIONS.md`
(**D-110** — the two-step grant and the header, not the body). _Ids:_ **MSG-5, MSG-6, MSG-12, CAP-9,
CAP-11**. _Fails without it:_ `apps/api/tests/routes/actions.test.ts` (the mint-without-agree case),
`apps/api/tests/confirmation-sweep.test.ts` (the pure sweep function, driven directly) and
`e2e/outbound-messaging-send.spec.ts`. **Serialise after S2 and S4.**

**S6 — Re-drive.** Branch `feat/MSG-10-redeliver`. Files: `packages/actions/src/actions/messages.ts`
(`messages.redeliver`, per §10) and its `EXPECTED_DESCRIPTORS` row,
`packages/db/src/repos/message-deliveries.ts` (the conditional re-drive `UPDATE`),
`apps/web/src/components/ComposeAnnouncement.tsx` (the button, and the words that say an `unreachable`
recipient will not be reached by it). _Ids:_ **MSG-10**. _Fails without it:_
`packages/actions/tests/actions/messages-redeliver.test.ts` and the access-audit assertion.
**Serialise after S5.**

**S7 — MCP exposure: the tools, the grant-minting adapter, and the read-back.** Branch
`feat/MSG-1-mcp-outbound-exposure`. Files: `apps/mcp/src/tool-surface.ts` (three entries),
`apps/mcp/src/chat-tools.ts` (the §6.1 read-back tool), **`apps/mcp/src/server.ts`**
(`requestElicitedConfirmation` returns `Promise<string | undefined>` and mints an already-agreed grant on
accept), **`apps/mcp/src/call-tool.ts`** (`requestConfirmation`'s type, and passing the grant id into
`dispatch`), `apps/mcp/tests/tool-surface.test.ts` (`EXPECTED_DESTRUCTIVE` rows),
`apps/mcp/tests/chat-tools-server.test.ts`, `apps/mcp/tests/mcp-e2e.test.ts`. _Ids:_ **MSG-1, MSG-29,
CAP-10**. MSG-1 lands here and not at S2 because it is the requirement that *two* surfaces ask through one
action with one authorization — which is not observable until a second surface can ask, and S5 was the
first. _Fails without it:_ `apps/mcp/tests/mcp-e2e.test.ts` — a full accept → grant → send; a client with
no elicitation capability refused; and an MCP non-owner receiving the byte-identical refusal the panel's
non-owner receives (MSG-1's actual property) — **failing without S7 alone**, not spanning two phases.
**Serialise after S5.** — end of Phase 29. **At this point the panel and MCP can send; Discord delivers and
answers DM replies but cannot originate.**

**S8 — The capability catalog and the invoker.** Branch `feat/CAP-1-capability-catalog`. Files:
`packages/actions/src/capabilities.ts`, `packages/actions/src/invoke.ts`, `apps/mcp/src/tool-surface.ts`
and `apps/mcp/src/call-tool.ts` (refactored onto `invokeCapability`; `MCP_TOOL_SURFACE` becomes MCP's
`SurfaceCapabilityDeclaration`, and S7's grant-minting adapter becomes MCP's `ConfirmationPort` unchanged
in behaviour). _Ids:_ **CAP-1, CAP-2, CAP-6**. _Fails without it:_
`packages/actions/tests/capability-parity.test.ts`. **Serialise.** Lands **before** S9 and S10, so no
surface can reach a capability before the gate exists.

**S9 — The tool-calling loop.** Branch `feat/CAP-3-tool-loop`. Files: `packages/core/src/ports.ts`,
`packages/core/src/answer.ts`, `packages/db/src/repos/speaker-authority.ts`,
`packages/openai/src/responses.ts`, `packages/openai/src/client.ts`, every `FakeModelClient` in the tree.
_Ids:_ **CAP-3, CAP-5, CAP-7, CAP-12**. _Fails without it:_
`packages/core/tests/agent-capabilities.test.ts` and `packages/db/tests/speaker-authority.test.ts`.
**Serialise after S8.**

**S10 — The two remaining ConfirmationPorts, and the surfaces that ask.** Branch
`feat/CAP-4-confirmation-ports`. Files: `apps/bot/src/index.ts` and a new `apps/bot/src/confirmation.ts`
(the follow-up-code port, matched before `answerQuestion` so a code costs no model call, and joining
`isHandledOutcome`), `apps/bot/src/message-handler.ts`, `packages/discord/src/handle-mention.ts` (speaker
authority and the invoker), a new owner-assistant endpoint in `apps/api` authorized by **membership**, not
enrolment (the student chat routes resolve a connected person and then `resolveChatAdmission`, so an owner
who is not enrolled on the course is refused there — the invoker does not belong in that route),
`apps/web/src/pages/*`. _Ids:_ **CAP-4**. _Fails without it:_ `apps/bot/tests/confirmation.test.ts` and
`e2e/assistant-capabilities.spec.ts`. **Serialise after S9.** — end of Phase 30. **All three surfaces can
now ask.**

### The slice-to-id map, in one place

| slice | ids                                                        |
| ----- | ---------------------------------------------------------- |
| S0    | none (documentation and `scripts/`)                        |
| S1    | MSG-13, MSG-19                                             |
| S2    | MSG-3, MSG-8, MSG-9, MSG-20, MSG-21, MSG-22, MSG-23, MSG-24, CAP-8 |
| S3    | MSG-7, MSG-15, MSG-25, MSG-26, MSG-27                      |
| S3B   | MSG-4, MSG-11, MSG-16, MSG-17, MSG-28                      |
| S3C   | MSG-18                                                     |
| S4    | MSG-2, MSG-14                                              |
| S5    | MSG-5, MSG-6, MSG-12, CAP-9, CAP-11                        |
| S6    | MSG-10                                                     |
| S7    | MSG-1, MSG-29, CAP-10                                      |
| S8    | CAP-1, CAP-2, CAP-6                                        |
| S9    | CAP-3, CAP-5, CAP-7, CAP-12                                |
| S10   | CAP-4                                                      |

Forty-one ids, each appearing exactly once, and each in the slice whose named failing test proves it.

## Test strategy

**Unit.**

- `packages/db/tests/migrate.test.ts` (existing, extended) — fails without S1, in two ways: the pinned
  column list for `messages` and the pinned table list both change; **and** a new case in the repository's
  own partial-journal shape (`:317`, `:443`, `:564`, `:803`, `:915`, `:1001`) migrates a database through
  `0029`, seeds one `from_person` and one `to_person` message, migrates forward, and asserts `person` /
  `assistant`, no `unattributed` row, and an unchanged row count. Without the hand-edited backfill `CASE`
  that case fails; the pinned lists alone would not catch it.
- `packages/db/tests/organizations-deletion.test.ts` (existing, extended) — fails without S1 with
  `FOREIGN KEY constraint failed`, once `seedFullTenant` seeds an announcement, two delivery rows and a
  confirmation grant; and `previewOrganizationDeletion` reports the two new counts.
- `packages/db/tests/conversations.test.ts` — fails without S1: `appendMessage` called with an outer
  transaction's `tx` does not compile today; and a `course_surface`-scoped course appends to the
  conversation for the _delivery_ surface, not the default one.
- `packages/db/tests/reachability.test.ts` — fails without S1: a person whose only `discord` identity is
  `handle:`-prefixed is `unreachable/handle_only`; a merged person with two real snowflakes is
  `unreachable/ambiguous_identity`; a person with both a `handle:` row and a real snowflake **is**
  reachable on the snowflake (which `getPersonIdentity`'s oldest-wins lookup would get wrong); a person
  with only a `web` identity resolves to `web`; and a person with neither is `no_identity`.
- `packages/db/tests/jobs.test.ts` (existing, extended) — fails without S3B: with eight delivery batches
  enqueued at staggered `availableAt` and a roster import enqueued a minute later, `claimNextJob` returns
  the roster import rather than a not-yet-available batch. This is MSG-16's real property, and it fails
  against the previous draft's same-`nextAttemptAt` enqueue.
- `packages/db/tests/speaker-authority.test.ts` — fails without S9: a disabled owner's account resolves to
  `none`; a person holding two `web` identities resolves to `none`.
- `packages/db/tests/transcript-access.test.ts` — fails without S4: a `to_person` row written with
  `authoredBy: 'account'` comes back from `readCourseTranscript` carrying the author, not as an assistant
  answer; an `'unattributed'` row comes back rendered from `direction`, as today.
- `packages/actions/tests/actions/messages-send.test.ts` — fails without S2: owner-only; a
  non-owner/instructor/assistant refusal; cross-tenant `courseId`; foreign, unknown and ended-enrolment
  `personId` all raising the byte-identical `ActionRefusedError`; no grant / **unagreed grant** / expired
  grant / wrong-account grant / wrong-fingerprint grant / already-consumed grant each refused; the
  organization window; idempotency-key dedupe returning the recomputed summary (and the unique index
  rejecting a duplicate key directly); the recipient cap and the body-length cap (MSG-21); an input
  carrying `accountId` or `confirmation` failing strict parsing, plus an assertion that the schema _is_
  strict; **a recipient's `usage_counters` row and the organization's `cost_ledger_entries` total are
  unchanged after N announcements** (MSG-8); and **a fan-out that throws on the third recipient leaves no
  announcement, no messages and no delivery rows** (MSG-20).
- `packages/actions/tests/actions/messages-redeliver.test.ts` — fails without S6: the state table in §10,
  row by row; `DELIVERY_MAX_ATTEMPTS` as a ceiling across repeated calls; a foreign `announcementId`
  raising the identical refusal; and the whole action refused without an agreed grant.
- `packages/actions/tests/access-audit.test.ts` (existing) — fails without S2/S5/S6: each slice's new
  action with no row fails "registers exactly the actions this table expects".
- `packages/discord-rest/tests/create-message.test.ts` — fails without S3: a captured body always carries
  `allowed_mentions: { parse: [] }`; a 429 response with `retry_after: 2` produces a
  `DiscordRequestError` whose `retryAfterMs` is 2000; an `X-RateLimit-Global` response sets `global`.
- `apps/worker/tests/delivery/discord.test.ts` — fails without S3, and owns **every** pacing assertion in
  this plan (the previous draft split them across two files and two sections, so one slice's
  "fails without it" list was wrong): the fake-clock DM-open interval over 25 recipients; `retry_after: 2`
  sleeping 2000 ms and succeeding; a recipient limited past `DISCORD_RATE_LIMIT_RETRIES` settling
  `failed`/`rate_limited` while the rest are still attempted; a global 429 making zero further calls and
  throwing; exactly one `listGuildChannels` per batch; the stale-assignment DM fallback; and the
  missing-overwrite `channel_not_permitted`.
- `apps/worker/tests/handlers/message-delivery.test.ts` — fails without S3B: the claim protocol (a throw
  after claiming leaves the row reclaimable and one transport call in total; a `sent` row makes zero); the
  deadline check leaving rows `pending` and logging `delivery.batch.deadline`; the lease outliving the
  handler budget; and MSG-11's discipline — a 403 naming a channel id produces a `detail` and a
  `jobs.lastError` containing no identifier.
- `apps/worker/tests/health.test.ts` — fails without S3B: a lease-lapsed `claimed` row **and** an orphaned
  `pending` row each count toward `stuckDeliveries`, and `ready` is unchanged by either.
- `scripts/ops-monitor.test.mjs` (existing, extended) — fails without S3B: `evaluate` holds a verdict
  across a `stuckDeliveries` window and reports unhealthy only once `stuckSince` is older than
  `STUCK_DELIVERIES_GRACE_MS`.
- `apps/bot/tests/message-handler.test.ts` — fails without S3C: a message whose `inGuild()` is false
  produces a reply and a log line, and makes no model call; a second DM inside the cooldown produces no
  second reply.
- `packages/core/tests/agent-capabilities.test.ts` — fails without S9: a student speaker's request carries
  no `availableTools`; an owner's capability round carries `vectorStoreId: null` and no `webSourceDomains`;
  a retrieved-content stub instructing a broadcast invokes nothing; and each of CAP-12's three bounds —
  `MAX_CAPABILITY_ROUNDS`, the wall-clock deadline, one invocation per turn — fires on its own case.
- `apps/mcp/tests/mcp-e2e.test.ts` — fails without S7 alone: a client with no elicitation capability
  cannot send; accept mints a grant and the send succeeds; decline/cancel/timeout each refuse with no
  announcement row; and an MCP caller who is not an owner gets the same refusal the panel gives (MSG-1).
- `apps/mcp/tests/chat-tools-server.test.ts` — fails without S7: the read-back tool ignores a
  `personId`-shaped argument and returns only the caller's own conversation, with `authoredBy` on each
  entry.
- `apps/api/tests/confirmation-sweep.test.ts` — fails without S5: the pure sweep function deletes a grant
  expired beyond the cutoff and leaves a live one, driven directly rather than through an interval.
- `apps/bot/tests/confirmation.test.ts` — fails without S10: a follow-up code from a _different_ speaker,
  a different channel, or after the window agrees no grant; a code message costs no model call.

**The cross-surface parity test** — `packages/actions/tests/capability-parity.test.ts`, the mechanical thing
that keeps a fourth surface honest. Fails without S8. It asserts, over `SURFACE_CAPABILITY_DECLARATIONS`:
every `Surface` in `SURFACES` has exactly one declaration (a surface added to the enum with none fails the
build — CAP-2); every name in every `included` list exists in `PLATFORM_CAPABILITIES` and is registered in
`createPlatformRegistry`; every `destructive` entry has a `describeTarget`; and — the part that matters —
for each surface, `invokeCapability` is driven against a destructive capability with **two** fakes in turn:
a port that mints a grant and agrees to it (the send happens, and the port was actually _called_), and **a
port that mints a grant and returns its id without ever agreeing to it — which must produce a refusal and
zero `announcements` rows.** The second fake is the assertion the previous draft lacked: it tests the
property CAP-4 actually states (a human agreed), not the property a mocked call proves (a function ran). A
leak probe registers a fresh unknown action into the real platform registry and asserts it appears on no
surface (MCP-2/D-36's shipped property, preserved).

**e2e** (Playwright, `workers: 1`, one database per spec file). The harness starts only `apps/api` and the
built web bundle — `e2e/support/start-api.ts` says so outright and points the Discord API and OAuth bases
at an unreachable loopback port (`http://127.0.0.1:1/discord-api-unused`) — so a spec that needs a job
executed imports the handler and builds a `HandlerRegistry` in-spec as a deliberate stand-in, exactly as
`e2e/roster-import-panel.spec.ts` already does. Both specs below need that stand-in, a second signed-in
browser context whose account has a connected person enrolled on the course, and **two** new routes on
`e2e/support/fake-discord-guild-server.ts` — which today routes only `GET /users/@me` (`:187`),
`/guilds/:id/channels` (`:192`), `/guilds/:id/roles` (`:238`), `/guilds/:id/members` (`:250`) and
`/channels/:id/permissions/:id` (`:275`):

- `POST /channels/:id/messages` — the channel post.
- `POST /users/@me/channels` — the DM open. The previous draft named only the first, which would have left
  the DM fallback (the path any student without a verified private channel takes) unroutable, so a send
  spec exercising it could not run at all.

- `e2e/outbound-messaging-arrival.spec.ts` (S4) — arrival only: an announcement seeded through the action
  appears in the student's already-open panel without a reload, rendered as staff and not as the assistant,
  and announced in the `role="status"` region.
- `e2e/outbound-messaging-send.spec.ts` (S5) — the full flow: an owner signs in, opens a course, composes,
  confirms the modal (which really does issue the `POST /confirmations/:id` round trip), and the in-spec
  worker stand-in delivers against the fake guild server; the report names the recipient it could not
  reach.
- `e2e/assistant-capabilities.spec.ts` (S10) — an owner asks the panel's assistant to send, confirms, and
  the message arrives; a student asking the same thing is answered with no capability offered.

**What e2e cannot cover, stated rather than implied.** There is **no bot process in the Playwright
harness** and no Playwright spec can drive Discord — so "send a message from within Discord", which is half
of what the maintainer asked for, ships proved by `apps/bot/tests/confirmation.test.ts`,
`apps/bot/tests/message-handler.test.ts` and the unit-level speaker-authority tests, and by **a manual
check named in S10's PR body**: in a real guild, an owner mentions the bot asking it to send to a test
course, receives the code, quotes it, and sees the message arrive in a student channel — then repeats with
a non-owner account and sees a refusal. S3C's DM path gets the same treatment: DM the bot, get the "ask in
your course channel" reply. Neither slice is called done until that check is recorded in the PR.

## SPEC.md additions

**Insert both sections at the end of `docs/SPEC.md`, after `### 35. Course Portability`** (the last `###`
section, beginning at line 2840 and running to EOF), so no existing section number changes.

**Also amend two existing requirements in place** (ids and titles unchanged — the repo's convention is to
rewrite a body to name what qualifies it, as SURF-6's own body names SURF-8):

- Append to **MCP-4**'s body: _"CAP-4 generalizes this requirement beyond MCP and widens the trigger list
  to include a capability that reaches a real person; where the two differ, CAP-4 governs."_
- Append to **CONV-2**'s body: _"MSG-19 adds one field to that record: who wrote the message — the person,
  the assistant, or a named account acting on their own behalf."_

```markdown
### 36. Outbound Messaging

#### MSG-1 Sending is one capability, asked for from more than one place

An owner can ask the platform to send a message on their behalf from more than one place, and every one of
those places reaches the same capability: one authorization, one set of refusals, one record. A surface
contributes the way it is asked and the way it delivers; it contributes nothing to who may send, what is
recorded, or what comes back — so a refusal reads identically whichever surface a person is standing in. A
second implementation of sending, living inside one surface, is the thing this requirement exists to
prevent: it is how two surfaces come to disagree about who may send, and neither disagreement is visible
until somebody sends the wrong thing from the wrong place.

#### MSG-2 Every reader renders a staff message as staff, not as the assistant

Every reader of the record renders who wrote a message — the chat window, the panel's transcript screen,
the transcript export an instructor may be required to retain, and an assistant client reading its own
messages back. Recording a member's announcement the way an assistant's answer is recorded makes that
retained record say something that is not true, and a reader that ignores the distinction makes the column
that carries it worthless. The message's own text is the sender's, unchanged; naming the sender is the
reader's rendering. A message recorded before the platform tracked authorship, or by a release that did not,
is rendered the way it always was rather than guessed at.

#### MSG-3 Only an owner may send, and every refusal looks the same

Sending is refused for a caller who is not an owner of the organization, and refused identically for a
course in another organization, a course that does not exist, a person who is not enrolled, a person who
does not exist, and a person in another organization. One refusal, with one message, because a refusal that
distinguishes "not yours" from "does not exist" turns the send form into a way of asking whether a
particular person is enrolled somewhere.

#### MSG-4 A delivery is claimed, attempted and settled once per recipient

Delivery is claimed, attempted and settled per recipient, and a claim is not a send: a worker that crashes
between claiming a delivery and completing it leaves work that is picked up again, rather than a record
that says the message went out when it did not. A delivery already sent is never sent twice — which means
the claim a worker holds must outlive the moment that worker is abandoned, because a runtime that cannot
cancel an in-flight request can still be writing one while a retry begins. A worker that is running out of
time stops taking on new recipients and leaves them plainly unstarted, rather than beginning work it cannot
finish.

#### MSG-5 What happened to a send can be read back afterwards, in words

What actually happened to each recipient of a send is readable afterwards through the same platform that
sent it, rather than being lost with the job that carried it — and each reason is shown to the sender in
words they can act on rather than as a code. The commonest one, a student who never connected, carries the
same invitation link the platform already offers that student elsewhere. Delivery is not instantaneous, so
a sender who looks immediately and a sender who looks an hour later are asking different questions, and
both deserve an answer.

#### MSG-6 An unsolicited message is a new way data leaves, and the platform says so

A message the platform starts, to a person who did not ask for it, is a way data leaves this service that
did not exist before, and the platform's own privacy statement names it rather than continuing to describe
a smaller set. An assistant answering that recipient later has not seen the announcement — the answering
pipeline is built from the course's own configuration and the question asked, not from the transcript —
and nothing the platform shows a sender implies that it has.

#### MSG-7 An outbound message mentions nobody

A message the platform posts on a surface with mention syntax parses no mentions at all, whatever its text
contains, and the suppression is set by the call that posts it rather than by each caller remembering to.
A member can be talked into pasting text that would otherwise ping a whole server, and the platform's own
bot is usually granted exactly the permission that would make that work. Splitting a long message is
already SURF-5's requirement and is unchanged here.

#### MSG-8 An announcement is charged to nobody

Sending spends no model budget and consumes no recipient's daily allowance, because no model is called to
produce it. A student's allowance bounds what that student may ask; spending it on a message they did not
ask for would let a member quietly silence their own class for the rest of the day. An assistant turn that
was asked to send is priced normally, as the model call it actually is.

#### MSG-9 Sending is bounded per organization, and an identical send is not repeated

One organization may start only a bounded number of sends within a window, and a send may carry a key that
makes repeating it return the first send rather than starting a second — a uniqueness the store enforces,
not one the sending code merely intends. A cap on how many people one send reaches bounds one send and
nothing else; a leaked credential, a retrying client and an assistant that loops all produce many sends,
and without a bound on sends the only thing standing between a class and a hundred copies of the same
announcement is the good behaviour of whatever is calling.

#### MSG-10 A delivery that failed can be driven again, and nobody is reached twice

A send whose deliveries did not all succeed can be driven again, and driving it again attempts only the
recipients not already reached and not currently being attempted — never one already delivered, and never
one the platform had no address for in the first place, which is a different act and is named as one. Each
recipient has a fixed ceiling on how many attempts they can ever receive, enforced where the record lives
rather than by the discipline of whatever is calling, so a caller that asks ten times cannot turn one
announcement into ten messages. Driving a send again reaches real people, so it asks a human first on
exactly the terms the original send did. A job that has failed has forgotten what it was carrying, so
without this the only remedy for a half-delivered announcement is sending the whole thing again.

#### MSG-11 A delivery says what happened without saying who to

What a failed delivery records is a reason drawn from a fixed list — not the provider's own message, not a
channel or account identifier, not a handle and not an address — and the same discipline governs what it
writes to the log. The platform already hands a job's last error back to assistants on the strength of no
handler ever throwing a value that names a student; a per-recipient delivery is exactly the handler that
would, and the fix is to never construct that string rather than to filter it afterwards.

#### MSG-12 The panel is where an owner composes, confirms and reviews a send

The control panel offers an owner a way to write a message for one course or one enrolled person, shows
them what they are about to do and to how many people before it happens, and shows afterwards which
recipients were reached and which were not, with the reason. A refusal leaves the text they wrote on screen
rather than discarding it. This is the surface an owner reaches for first, and a capability that exists only
through an assistant is a capability most owners will never find.

#### MSG-13 Deleting an organization deletes everything sending created

Deleting a tenant removes the announcements it sent, the per-recipient delivery records those produced, and
any confirmations it had outstanding, alongside the messages and conversations already covered — and the
deletion preview counts the announcements and deliveries, so an administrator is told what they are about
to destroy rather than discovering it afterwards. The list of what deletion touches is maintained by hand,
so a table added and forgotten does not degrade gracefully: it makes deleting a tenant that ever used this
feature fail outright, while every test that does not know about the new table keeps passing.

#### MSG-14 A message arrives in an open panel without a reload, and says so out loud

A recipient with the panel open sees a message arrive without refreshing the page, and the platform asks
for only what it does not already have rather than re-reading the whole transcript each time. The arrival
is announced to a screen reader politely — content appearing in a live region while somebody is typing must
not steal their focus or interrupt them mid-word — and the composer's remaining-character count and the
unreachable report are announced on the same terms.

#### MSG-15 Delivery is paced to the surface's own stated limits

The platform paces what it sends to a surface rather than sending as fast as it can, and when a surface
says it is being asked too often, the platform waits exactly as long as that surface said to and retries
that one recipient — it does not restart the whole batch on a generic timer, and it does not let one
throttled recipient stop the others from being attempted. A class of two hundred is the ordinary case for
this feature, not the extreme one, and opening two hundred private conversations is among the most
aggressively limited things this platform can ask a chat service to do.

#### MSG-16 A broadcast does not put every other tenant behind it

Sending to a whole class is carried out in bounded groups, and those groups are spaced so that work
arriving while a broadcast runs waits for at most one group rather than for the whole class. The platform
runs one background worker, on purpose, and takes work in the order it becomes available with no notion of
fairness between tenants — so a design that simply queues everything at once turns a single large class
into a queue every other organization sits behind, and nothing about that failure is visible to the tenant
it happens to.

#### MSG-17 Every delivery outcome reaches the owner or the log, and none reaches neither

Each stage of a send is recorded where somebody can find it: the send being accepted, each group being
picked up, a group that ran out of time, each recipient settling, and the send finishing. A send that
finished with failures is recorded at a level an operator's monitoring notices. An owner who closed the tab
is not notified — the platform does not invent a notification channel here — but the outcome is waiting for
them when they return and has already reached the log, which is what stops a send that reached nobody from
reaching nobody twice.

#### MSG-18 A student who replies to a message the platform sent is not ignored

A student who replies to a message the platform sent them privately gets a reply. The platform routes what
it answers by where the question was asked, and a private conversation has no course attached to it, so the
reply says where to ask rather than guessing at an answer — and because it is not an answer, it costs no
model call and claims no knowledge it does not have. A student who writes three times in a row gets one
reply, not three. The platform records that the exchange happened where an operator can see it. A message
the platform chose to start is the worst possible place for the platform to then say nothing: the student
has no way to tell being ignored from being broken, and nobody operating the service can tell either.

#### MSG-19 A message carries its author, and an older release keeps recording while it arrives

Every message the platform records says who wrote it — the person, the assistant, or the account of a
member who sent it on their own behalf — and the record refuses to be written without that, so no writer
can add a message the platform cannot attribute. Existing messages are given their true author when the
column arrives, not a placeholder. The deployment that adds it is not a one-way door: this platform's own
deploy rolls code back automatically and does not roll the database back with it, so a release that predates
the column must keep recording messages rather than failing on every write while the operator is told the
rollback succeeded. What such a release records is marked as exactly what it is — written by something that
did not know who the author was — rather than being quietly filed under somebody who did not write it.

#### MSG-20 A send is written completely or not at all

An announcement, the copy of it recorded for each recipient, and the per-recipient delivery records are
written as one indivisible act: a failure part-way through leaves no announcement, no half-delivered set of
messages and no orphaned delivery records. Sending fans out over many recipients, so part-way through is
the ordinary failure, not the exotic one — and a half-written send is the one state from which neither
re-sending nor re-driving can recover, because nobody can tell which half happened.

#### MSG-21 One send is bounded in how far and how long it reaches

One send reaches at most a fixed number of recipients and carries at most a fixed number of characters, and
both are refused before anything is recorded. The recipient bound is what a single background worker can
absorb without making every other tenant wait; the length bound is what leaves room for the platform to name
the sender on a surface that has no way to show a sender, so that one recorded message is always one
delivered message and never two.

#### MSG-22 A recipient's surface is chosen before their copy is recorded

Which surface a recipient will be reached on is decided before their copy of the message is written, so the
message is recorded in the conversation that recipient's own surface reads rather than one they never look
at. A platform that records first and routes afterwards can put a message somewhere the recipient will
never see while truthfully reporting that it was recorded.

#### MSG-23 A recipient is reached on one surface, and never on all of them

A recipient is reached on one surface, chosen by a stated order of preference among the surfaces the
platform can actually deliver to, rather than on every surface they hold an identity on — so one
announcement is one message in one conversation rather than the same words repeated in several. A surface
the platform has no way to push to is not a delivery surface at all, and saying so plainly is better than a
delivery that silently reaches nobody. On a surface that cannot be pushed to but can be read, delivery means
the message is durably readable the next time the recipient looks, and the platform does not describe that
as having reached them.

#### MSG-24 A send says immediately who it had no way to address

Sending returns, straight away, how many recipients the platform had an address for and which it did not,
naming the reason for each — no identity on any surface, a placeholder identity that reaches nobody, or an
identity that cannot be told apart from another belonging to the same person. That count is what is knowable
at the moment of sending and is not a claim that anybody has read anything; it is what lets a sender decide
whether to send at all, before the delivery they cannot take back.

#### MSG-25 A message the platform decorates still fits where it is going

On a surface where the platform has to add the sender's name to the text itself, the decorated message still
fits that surface's own length limit, by construction rather than by splitting — so one recorded message is
one delivered message, and a report never has to explain a half-posted announcement. The bounds that make
that arithmetic hold are declared once and used by both the part that accepts the text and the part that
posts it.

#### MSG-26 A remembered private channel is used only while it is still theirs

A private channel remembered for a student is used only after checking that it is still recorded for that
student and that they can still read it; otherwise the platform reaches them another way or reports that it
could not. Roster imports already record channels changing hands and being orphaned as ordinary outcomes, so
a stale record is expected rather than hypothetical — and a private message about somebody's absence posted
into a channel a different student now reads is worse than not sending it.

#### MSG-27 Outbound delivery yields to the connection students depend on

The platform's outbound sending and its answering bot share one credential, and the limits that credential
is subject to are counted against the credential and not against either process. So sending prefers the
cheaper route where one exists, and when the chat service says the credential as a whole is being asked too
often, sending stops immediately and waits rather than spending more of it. A slow broadcast is an
inconvenience; a credential throttled out of answering takes the platform away from every student at once,
including the ones who never received anything.

#### MSG-28 A send that stopped part-way is visible, and can be finished

Recipients left unattempted by a send that stopped part-way — a worker that ran out of time, a job that
failed for the last time and forgot what it was carrying — are visible on the platform's own health report
rather than only in a table nobody queries, and an operator's monitoring notices when that count stays above
zero. They are also in a state a re-drive can finish. A background job that exhausts its attempts discards
what it was carrying, so an outbox with no reconciler loses exactly the recipients nobody watched.

#### MSG-29 An assistant client can read its own recent messages back

A client whose surface the platform cannot push to can ask for its own recent messages instead, and what
comes back is that caller's own conversation and nothing else — it takes no identifier naming whose messages
to return, because an identifier in a tool call is text a model generated. Each message says who wrote it,
so a client can tell a staff announcement from an assistant answer. Without this, a surface that cannot be
pushed to is a surface on which an announcement is invisible forever.
```

…and immediately after it, still in `docs/SPEC.md` (the fence is split here only so this document stays
readable; the two blocks are consecutive text in the file):

```markdown
### 37. Capabilities Across Surfaces

#### CAP-1 One catalog names every capability an assistant may reach

Which actions an assistant may invoke is one list belonging to the platform, not a list per surface, and an
action is not on it until a reviewer adds it. The catalog carries what a confirmation needs in order to
name the record it is about to affect, and what must be stripped from a result before a model reads it.
Keeping this in one place is what makes the same capability behave the same way on every surface; keeping
it out of any one surface is what stops a second surface from acquiring a subtly different copy.

#### CAP-2 A surface takes capabilities by name, and a new surface starts with none

Each surface declares which capabilities in the catalog it offers, by name, and a capability absent from a
surface's declaration is absent from that surface. A surface that declares nothing offers nothing, and a
surface added without a declaration at all fails the build rather than quietly starting life with
somebody else's list. The alternative — a new surface inheriting whatever the last one had — is how an
action whose blast radius was argued for one surface arrives silently on another.

#### CAP-3 The platform's own assistant can invoke a capability, as the person speaking

The assistant the platform runs on its own surfaces can invoke a capability, and it does so as the account
of the person who is speaking, with that account's memberships and nothing more. The speaker's account is
established by the platform from the surface's own proven identity — and an account that has been disabled,
or an identity that cannot be told apart from another, establishes nobody. An identity a model supplied is
never the identity a capability runs as, because an argument in a tool call is text the model generated.

#### CAP-4 Every surface that offers an irreversible capability asks a human, and none can opt out

A capability that deletes, exports, spends money, or sends something to a real person runs only after an
explicit confirmation from a human, obtained outside the model's own output channel and naming the record
it is about to affect — and this holds on every surface the platform offers it on, with no surface exempt.
A surface that cannot ask a human refuses rather than proceeding; there is no arrangement in which a
surface offers such a capability while answering "no human is available" by default, because a permanent
refusal and an unasked question are indistinguishable from the outside until the day one of them sends
something. The confirmation is a property of the capability rather than of the route it arrived on, so a
caller who reaches the action directly is refused exactly as an assistant is.

#### CAP-5 A turn that can invoke a capability carries no retrieved text

When the platform offers an assistant a capability in a turn, that turn's request to the model carries only
what the speaker themselves wrote and the capabilities on offer — not the course's knowledge files and not
the contents of the websites the course names. Those are the parts of a request the speaker did not write
and somebody else may control, and a turn holding an owner's authority is the worst possible place to put
text an outsider can edit. The turn that composes the reply keeps its retrieval; it just offers nothing to
invoke.

#### CAP-6 A capability is invoked through one path, and that path is the only one

Every invocation — from any surface, by any assistant — goes through one function that resolves what the
capability is about to affect, obtains the confirmation the capability requires, and only then dispatches.
A surface cannot reach dispatch any other way. A gate implemented once per surface is a gate that is
missing on the surface somebody forgot, and the way that failure presents is a broadcast nobody agreed to.

#### CAP-7 Every round of a capability turn is priced

A turn in which the assistant calls a capability is more than one request to the model, and each of those
requests is recorded against the organization's spending the same way a single answer already is. Pricing
only the round that produced the visible reply would make a turn that used three rounds cost what one
costs, which quietly under-counts every spending cap the platform enforces — and the under-count grows with
exactly the turns that do the most work.

#### CAP-8 A confirmation is a record, and whoever asked for it cannot answer it

Whatever the platform creates when it asks for a confirmation is unusable until a separate act by a person
answers it, so a caller that can start the question cannot also answer it — and the thing that finally
performs the capability checks that separate act itself, rather than trusting that some earlier step made
it. A confirmation agrees to one specific request, not to a kind of request: it names one caller, one
capability and one exact set of arguments, it may be spent only once, and it expires. Without the
separation, asking and answering collapse into one step that any caller who can reach the platform performs
alone, which is a gate in shape and a formality in substance.

#### CAP-9 On the control panel, the person's own action is what answers

On the control panel, what answers a confirmation is an action the person took in their own browser —
distinct from the request that asked for it and from the request that finally acts — and the platform's own
server-side assistant, which cannot originate a request from somebody's browser, therefore cannot answer
one. Re-submitting a different request than the one confirmed is refused. A flow in which the same call
both asks and answers looks identical in a screenshot and proves nothing.

#### CAP-10 A client that cannot ask its user is refused, not assumed

Where the platform is driven by somebody else's assistant client, the platform asks that client's own user
directly, over the channel the client opened for the call in progress rather than one it may never have
opened. A client that declares no way to ask, one that never answers, one that answers with a decline and
one that fails are all treated the same: no confirmation was obtained, and the capability does not run.
Assuming consent from a silent client is how a capability that reaches real people runs with nobody having
agreed to it.

#### CAP-11 A confirmation nobody answered does not live forever

Confirmations that expired without being answered are removed on a schedule, by a process that actually
runs — created alongside the thing that calls it, not left as a function nobody invokes. Every request that
was started and abandoned leaves one of these behind, which is the common case rather than the rare one,
and an unbounded table of abandoned questions is a table nobody reads and nobody prunes.

#### CAP-12 A capability turn is bounded in rounds, in invocations and in time

A turn in which the assistant may invoke a capability is bounded three ways: how many times it may go back
to the model, how many capabilities it may actually invoke, and how long the whole turn may take before it
is abandoned. Each bound is enforced separately, because each fails differently — a model that keeps asking
for tools bills the organization for every round, a model that invokes repeatedly reaches real people
repeatedly, and a turn with no deadline holds a student's reply open indefinitely.
```

## ROADMAP.md additions

Append after `## Phase 28 — A message the bot never received` (the last phase block, at line 362).

```markdown
## Phase 29 — A message the platform sends first

Everything this platform does today begins with somebody asking it a question. An instructor who needs to
tell a class that the exam moved has no way to make that happen through the platform at all. This phase
makes sending a first-class action: an owner asks, the platform records who said what to whom, resolves
each recipient to the surface they actually read, delivers on Discord at a pace Discord will accept without
starving the bot that answers students, says plainly which recipients it had no way to reach, and answers
the student who replies. It does not close D-45's own unbuilt mitigation — a bulk notification telling
unconnected students to connect — because the students D-45 names are precisely the ones with no usable
identity; what this phase does for them is report them as unreachable, by name of reason, with the
connect link the sender can act on, instead of silently reaching nobody. At the end of it an owner can send
from the control panel and from an MCP client; Discord delivers but does not yet originate.

**In scope:** MSG-1..29, CAP-8..11

## Phase 30 — One set of capabilities, every surface

An MCP client's own model can invoke this platform's actions; the assistant the platform runs on Discord
and in the panel cannot invoke anything at all, because the model port is one-shot text in, text out. So
the capability Phase 29 built is reachable from a panel form and an MCP tool, and an owner who simply asks
the bot is answered with prose. This phase gives the platform's own assistant a bounded tool-calling loop,
moves the list of what an assistant may reach out of the MCP server and into the platform, and generalizes
MCP's destructive-tool confirmation into one that every surface — including the next one — has to
implement before it can offer anything irreversible.

**In scope:** CAP-1/2/3/4/5/6/7/12
```

`scripts/board/config.mjs` needs three edits in the same commit, and the previous draft got the reasoning
for one of them backwards:

- **`MILESTONE_TITLE` gains** `29: 'Phase 29 — A message the platform sends first'` and
  `30: 'Phase 30 — One set of capabilities, every surface'`, matching the `##` headings character for
  character including the em dash. **This is the edit that creates the milestones** —
  `scripts/board/sync.mjs:178` iterates `Object.entries(MILESTONE_TITLE)`, and
  `scripts/board/derive.test.mjs:115`–`:130` asserts on `MILESTONE_TITLE`. Omitting it fails CI.
- **`PHASES` gains `29, 30`.** `PHASES` is imported only by `derive.mjs` (`:24`) and used only for its
  console tally (`:313`–`:319`); omitting it would **not** fail CI, which is exactly why it is easy to
  forget. It is still required — the tally is how a human notices an id claimed by no phase.
- **`FAMILY_LABEL` gains `MSG` and `CAP`**, each as the full `{ name, color, description }` object every
  one of its 33 existing values is (`scripts/board/config.mjs:69`ff) — not a bare name. Suggested:
  `MSG: { name: 'area:messaging', color: '0e8a16', description: 'Owner-initiated outbound messaging' }` and
  `CAP: { name: 'area:capabilities', color: '8250df', description: 'Capabilities across surfaces' }`.
  Without them `familyLabel`'s fallback (`:238`–`:242`) gives forty-one new cards an unstyled grey
  `ededed` label with an empty description — the only unlabelled work on a board where all 33 existing
  families are curated.

## What this plan deliberately does not do

**It does not put an announcement into the model's context.** `answerQuestion` builds its request from the
course configuration and the question; continuity is provider-side. Making a later answer aware of an
announcement means writing it into the upstream conversation object through the model port, which is a new
port verb, a `packages/openai` write, and a decision about what happens when that write fails. It is real
work with a real cost and it is not implied by writing a database row.

**It does not push to MCP.** Server-initiated notification is doubly gated and silently lossy, and MCP
sessions are in-process and lost on restart. MCP is a send-only surface with a pull for reading back
(§6.1, MSG-29).

**It does not notify an owner who navigated away.** A broadcast that fails for half its recipients reaches
the log, the worker's health endpoint and the announcement's own read-back, but nothing pushes to the
person who started it. Email is not built (below); a panel notification centre is a screen this plan does
not design. MSG-17 states the bound honestly rather than implying an alert that does not exist.

**It does not build email or SMS.** PPL-5's `hasVerifiedAddress` exists, and D-45 already named the
unconnected-student reachability problem, but a new transport is a new vendor adapter, a new set of
credentials and a new class of abuse; a recipient unreachable on Discord and the web is _reported_ as
unreachable here rather than routed to a channel this plan has not designed.

**It does not add per-tenant fairness to the job queue.** MSG-16 is solved by spacing one broadcast's own
batches, which needs no change to `claimNextJob`. A real fairness rule — round-robin by organization, or a
per-tenant concurrency bound — would change the claim semantics every existing job kind depends on, and is
its own requirement with its own decision record.

**It does not let a sender unsend.** An owner who sends to the wrong course, or with a typo, thirty seconds
ago cannot take it back, and that is a decision rather than an oversight. `messages` has no delete path at
all (TEN-6) and nothing in the platform deletes a Discord post; adding either means a new REST verb, a new
action whose blast radius is "erase evidence", and an answer to what "recalled" means for a message a
student has already read on their phone. The mitigation this plan does ship is the one that works before
the fact: a confirmation that names the course and the recipient count, and that a human has to agree to
separately (CAP-4/CAP-8/CAP-9). A recall capability is a later requirement with its own argument.

**It does not add a fourth surface.** `SURFACES` is CHECK-constrained in three tables
(`person_identities`, `conversations`, `messages`), each a table rebuild. The point of §5–§7 is that the
_capability_ work for a fourth surface is three small interfaces; the _enum_ work is a separate, known cost.

**It does not localize anything.** Nothing in this repository is localized today, so the new vocabulary is
written once, in English, in the panel — what this plan does owe, and pays in MSG-5, is that the words a
sender reads are words rather than the reason codes the database stores.

**It does not add confirmation to `courses.save` or `courseAttachments.detach` over HTTP.** They are
unconfirmed on that route today. The mechanism this plan builds makes fixing that a one-line change per
action (consume a grant in `execute`), and that change belongs in its own slice with its own test, not
smuggled into this one.

**It does not build a scheduled or recurring send, a draft, or a template.** One message, sent once, to a
course or a person.

## Open questions for the maintainer

1. **"Organization/project owners" — the data model has no project-scoped role.** `MEMBERSHIP_ROLES` is
   `['owner','instructor','assistant']` and roles are organization-wide. _Recommendation:_ organization
   `owner` only, as written. If a project owner is really wanted, it is a `memberships` change of its own
   and should be its own requirement.
2. **`SEND_MESSAGE_MAX_RECIPIENTS = 200`, `SEND_MESSAGE_MAX_LENGTH = 1800` and five sends an hour.** The
   first two are what a single-instance worker can absorb without making other tenants wait long, and the
   length is chosen so the attribution prefix always fits Discord's 2000-character limit (§4).
   _Recommendation:_ ship these, and revisit once a real class size is known — they are exported
   constants, so raising them is a one-line change with a test.
3. **Does an announcement to a course also post to the course's shared Discord channel, or only to each
   student privately?** This plan does per-recipient delivery only, **and the trade is now named with its
   blast radius**: a 200-recipient broadcast opens up to 200 DMs on the same bot token PLAT-3's only
   gateway connection uses, on Discord's most aggressively limited route. MSG-27's global-limit breaker and
   the channel-before-DM preference are what make that acceptable rather than reckless, but they are
   mitigations, not an argument that the cost is zero. A shared-channel post would be one request instead
   of up to four hundred. What stops it being the default is D-105/MF4: the bot must not post into a
   channel routing agrees answers nothing, and a course's shared channel is frequently exactly that.
   _Recommendation:_ per-recipient only for now; a shared-channel audience is a third `audience` variant,
   is the first thing to build if §4's pacing proves too slow in practice, and is the right answer sooner
   if the maintainer would rather not spend the shared token at all. **This is the one open question whose
   answer could change a design decision in this plan rather than a constant.**
4. **Will the maintainer add a required reviewer to the `production` environment for S1's deploy?** See
   **Migration and rollout**. A merge to master ships and migrates automatically (`ci.yml:141`–`:143`), so
   this is the only mechanism in the repository that creates a window, and it is a settings change rather
   than a code change. _Recommendation:_ yes for S1, removed afterwards. The plan is safe either way — the
   `'unattributed'` default makes the automatic rollback survivable and the migration file is atomic — but
   a quiet file is strictly better than a busy one for a rebuild of `messages`.
5. **Does the Discord confirmation's follow-up-code flow feel acceptable, or is a slash-command /
   interaction-button surface worth the new gateway wiring?** _Recommendation:_ the follow-up code, in
   Phase 30, because it needs no new intents and no `InteractionCreate` handler; buttons are a later
   polish slice, not a prerequisite for shipping "send from within Discord". Note that S3C does add one
   new intent (`DirectMessages`) for a different reason — receiving a student's reply — and that it is not
   a privileged intent, so it needs no developer-portal change.

## Review findings rejected, and why

**Finding 31 — "add a `WEB-<next>` requirement for the panel's send flow."** Rejected as written, accepted
in substance. The instruction governing this plan is explicit: _"Do not invent requirement IDs in families
already in use. MSG and CAP only."_ The reviewer's own evidence is also wrong on the number — the highest
WEB id in `docs/SPEC.md` is **WEB-47** (`grep -o 'WEB-[0-9]*' docs/SPEC.md | sort -u -t- -k2 -n | tail`),
not WEB-39, so "use the next free WEB number, WEB-39 is the highest today" would have collided with eight
shipped requirements. The substance — that the panel's compose, confirm and report flow needs its own
independently testable requirement rather than being implied by MSG-6 and CAP-4 — is accepted and is
**MSG-12**, claimed by exactly one slice (S5) with a named failing test.

**Finding 10 — "state that the `destructive` → `irreversible` rename reaches `McpToolDefinition.destructive`
and the tool-definition output."** Rejected in favour of the reviewer's own first alternative: the field
keeps the name `destructive`. It is the field on `ToolSurfaceEntry`
(`apps/mcp/src/tool-surface.ts:122`), the field on `McpToolDefinition` (`:266`), the value
`apps/mcp/tests/tool-surface.test.ts` asserts on, and the name `EXPECTED_DESTRUCTIVE` is built around.
Renaming it would be churn across two shipped tests and a tool-definition output for no behavioural gain.
What widens is MCP-4's _trigger list_, in CAP-4's prose — not the field.

**Finding 44, second half — "state the initial contents of `PLATFORM_AGENT_CAPABILITIES`, because
inheriting MCP's 24 hands Discord and the web `courses.save`."** The premise is accepted and the design
changed accordingly (opt-in `included` lists, §5), but the specific worry about `courses.save` reaching
Discord does not survive that change: with opt-in declarations, Discord and the web take exactly the three
`messages.*` capabilities, named in the plan, and inherit nothing. The catalog containing all 27 is not the
same as a surface offering all 27.

**Finding 29, second half — "CAP-2 restates MCP-2 and its only named test is the shared parity test."**
Rejected. CAP-2 is not a restatement: MCP-2 says _the MCP surface_ is chosen rather than derived; CAP-2
says _every_ surface must declare, that an undeclared surface fails the build, and that declaring nothing
yields nothing. The second and third clauses have no counterpart in MCP-2 and are exactly the property a
fourth surface needs. Its failing test is named and is not merely the parity test's existence: the parity
test's first assertion is that every member of `SURFACES` has exactly one declaration, which fails today
and fails again the moment a fourth surface is added without one. CAP-6, by contrast, was accepted as
overlapping MCP-1/MCP-3 and has been rewritten as the _single invocation path_ requirement — a distinct,
mechanically testable property (no surface can reach `dispatch` except through `invokeCapability`) rather
than a restatement of attribution.

**Finding 11's line-range complaint.** Accepted and acted on — this document cites symbol names
(`appendMessage`, `MCP_TOOL_SURFACE`, `resolveConnectedCallerPerson`) rather than line ranges wherever a
symbol exists, and the few remaining line numbers were re-derived against HEAD. Noted as not-a-rejection so
it is not re-litigated.

**"The `/actions/:actionName` body becomes `{ input, confirmation }`, which is a breaking change for all 50
actions and every route test."** The premise is correct and the conclusion is rejected, because the
dilemma it poses is false. `apps/api/src/routes/actions.ts` really does pass `req.body` straight through
(`dispatch(action, req.body, { organizationId, db, accountId })`), and a sibling key really would be
stripped silently by 49 non-strict schemas — but a grant id is not action input at all. It is exactly the
same kind of thing as `accountId`, which `DispatchContext`'s own doc comment says is never read out of the
input because "a self-reported author would be a forgeable audit trail". So it travels the way `accountId`
travels: established by the transport, placed on `DispatchContext`, and unreachable from the body. The
route reads an `X-Bloombot-Confirmation` header; `req.body` is unchanged for all 50 actions; and a
regression case in `apps/api/tests/routes/actions.test.ts` asserts a confirmation-free action still
dispatches with its body byte-for-byte as before. **A third option the finding did not enumerate, and the
one the plan takes.**

**"A `putChannelPermissionOverwrite`-shaped read" and "a third new REST verb in S3."** The criticism is
correct — `putChannelPermissionOverwrite` (`packages/discord-rest/src/client.ts:407`) is a PUT write, and
`DiscordRestClient` has no per-channel GET — but the proposed remedy of a third write-adjacent verb is
rejected. `listGuildChannels` already returns `permission_overwrites` and is already the read the scaffold
handler uses for the same class of question. The plan therefore uses it, once per batch, cached by guild,
with the cost stated (§4) and a test asserting exactly one call for 25 recipients. Adding `getChannel`
would buy one saved round trip per batch at the price of another exception to a package whose module
comment makes its narrow verb set a structural guarantee.

**"Which module splits an outbound message for Discord, and how does `apps/worker` reach it without
depending on `@bloombot/discord`?"** The arithmetic problem is real and the framing is rejected: nothing
splits, because nothing needs to. `DISCORD_MESSAGE_LIMIT` is 2000 (`packages/discord/src/split.ts:17`),
and the plan caps the body at 1800 and the rendered author label at 80, so a decorated message is at most
1901 characters (§4, MSG-25). `apps/worker/package.json` does not list `@bloombot/discord`, and that
package depends on `@bloombot/core`, `@bloombot/db`, `@bloombot/jobs` and `@bloombot/logger` — dragging the
answering pipeline into the delivery process to solve a problem that 200 characters of headroom removes
entirely. Re-homing `splitForDiscord` into `packages/discord-rest` was the other candidate and is rejected
as churn across a shipped SURF-5 test. The benefit is not only avoided work: one recorded message is now
one posted message by construction, so there is no multi-part delivery state for a report to explain.

**"`JOB_HANDLER_TIMEOUT_MS` (240 000) and the drain timeout of a third of that
(`apps/worker/src/index.ts:140`)."** The interaction is worth stating and is now stated (§4), but the
citation is wrong and is corrected rather than repeated: `apps/worker/src/index.ts:140` is
`timeoutMs: Math.floor(handlerTimeoutMs / 3)` on the **Discord REST client's per-request timeout**, not a
drain timeout — its own comment says "one third of the handler's own budget per request". The drain timeout
is `drainTimeoutMs ?? 30_000` in `apps/worker/src/shutdown.ts:97`, and that file's own comment already
records the right answer for a batch caught by it: the claim is not released, and lapses on its lease
(JOB-3). Both numbers now appear in §4 with their real sources, alongside `JOB_CLAIM_LEASE_MS` (300 000,
`packages/config/src/env.ts:127`), which the previous draft never mentioned and which is what makes the
delivery lease safe.

**"The migration rebuilds the production transcript table possibly beside the legacy Python bot on the same
SQLite file (D-9)."** The precondition is accepted; the specific mechanism is rejected on evidence, and the
precondition itself turns out to be already satisfied. `models/message.py` declares
`table_name = "messages"` over `content`, `category`, `channel`, `direction` and a `user` foreign key; the
platform's `messages` has `organization_id`, `conversation_id`, `person_id`, `course_id`, `sequence`,
`surface`, `channel_ref`, `category_ref` and `created_at`. One SQLite file cannot hold two different tables
under one name, and no migration in `packages/db/migrations` uses `CREATE TABLE IF NOT EXISTS`, so if
migration `0000` ever succeeded against the droplet's `DATABASE_PATH`, the Python bot's own `messages` was
not in that file — whatever `SQL_LITE_DB_PATH` is set to.

**"Is `DEPLOY_SKIP_PYTHON_BOT` set? — the one precondition the plan cannot verify from the repository."**
This was the previous draft's own open question 4, and it is **rejected as a question**: it is answered in
the repository. `docs/DEPLOY_DROPLET.md:901` lists `| DEPLOY_SKIP_PYTHON_BOT | variable | 1 |` alongside
`DEPLOY_PORT` 2222 and `DEPLOY_PATH`, and `:918` explains it. Presenting a settled fact as unverifiable
cost the plan the two preconditions that actually matter and were unnamed: **the deploy is automatic**, and
**the automatic rollback is code-only**. Both are now stated in **Migration and rollout**, and the second
is what `authored_by`'s default exists for.

**"Restore the OPS-18 backup."** Accepted in substance, corrected on the citation. The pre-migration backup
is no longer OPS-18's `sqlite3` CLI shell-out: OPS-19/D-104 replaced it with `better-sqlite3`'s
`Database#backup()` because the droplet has no `sqlite3` on PATH, and the restore command `backup_database`
logs is a Node one-liner for the same reason. The rollback section says so, because an operator who reaches
for `.restore` on that box will not find it.

**"`not_enrolled` is an `UnreachableReason` the design cannot reach."** Accepted, and the reason is removed
(§1) rather than defended. The reviewer's argument is exactly right: a `person` audience with an ended
enrolment is refused in `execute` before any resolution happens, a `course` audience derives its recipients
from `enrolments.listPeopleForCourse`, and surfacing the reason at all would leak the enrolment state
MSG-3 exists to withhold. The enrolment check moves out of the resolver's "gets for free" list and stays
where it belongs, in the action.

**Round 2, ENFORCER finding 7(a) — "`getTranscript` has exactly two non-test callers … only `chat.ts:289`
is non-test; legacy-import's only use is in its test."** **Rejected on the evidence.**
`packages/legacy-import/src/import-messages.ts:128` calls `conversationsRepo.getTranscript` inside
`collectExistingMessageIds`, in `src/`, not in a test — the file the reviewer cites
(`packages/legacy-import/tests/import-messages.test.ts:111`) is an additional, separate use. The plan's
original claim was correct and stands, with both line numbers now cited. `grep -rn 'getTranscript'
packages apps --include='*.ts'` shows exactly two matches under any `src/`. Finding 7(b) — that the opening
summary said a student who replies to a DM "is answered (S3C)" while S3C deliberately makes no model call —
is accepted, and the summary now says "gets a reply telling them where to ask — a fixed, model-free answer,
not an assistant answer".

**Round 2, SPEC-AND-COVERAGE finding 12(c) — "`MAX_CAPABILITY_ROUNDS = 3` and one invocation per turn have
no requirement; CAP-7 prices rounds but bounds none."** Accepted, and now **CAP-12** — with the finding's
own framing widened: the plan adds the wall-clock deadline as a third bound rather than two, because MDL-5
already requires it of every model call and a capability turn is the one place it was about to be lost.

**Round 2, ENFORCER finding 1 — "the `ReachabilityResolver` escape hatch does not close."** Accepted
entirely, and the fix is not the one the finding implies. The finding is right that the interface cannot be
declared in `packages/actions` while returning a type declared in `packages/messaging`, and right that no
composition root wires the concrete resolver. But the remedy is not to pick one of those two and patch it:
it is that **reachability is not a port**. It is a tenant-scoped database read with no I/O, so it belongs
in `packages/db/src/repos` with every other one, and `packages/actions` — which already depends on
`@bloombot/db` — simply calls it (§1). That deletes the interface, the injection, the composition-root
edits, the new package, and with it `packages/messaging` entirely, including for `resolveSpeakerAuthority`.
`createPlatformRegistry`'s signature and all 21 of its call sites are untouched. The reviewer found a real
hole; the hole was the indirection, not the wiring.
