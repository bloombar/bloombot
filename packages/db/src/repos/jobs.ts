/**
 * Repository for `jobs` (JOB-1..3): the background queue every write that
 * cannot finish inside a request hangs off, instead of holding an HTTP
 * connection open.
 *
 * Every function here is scoped by `organizationId`, its first parameter,
 * except two documented exceptions, one level up the same way
 * `resolveDiscordServerBinding` (`discord-servers.ts`) already is:
 *  - `claimNextJob` — a worker claiming the next job to run has not resolved
 *    an organization yet; the job it happens to claim decides that, so there
 *    is nothing to scope the claim itself by.
 *  - `countQueuedJobs` — `apps/worker`'s own health endpoint's "how deep is
 *    the queue" (JOB-5), an operational metric about the queue as a whole,
 *    the same class `deleteExpiredInstallStates`
 *    (`discord-install-states.ts`) already is.
 *
 * JOB-1's own text is that a queue must not be a way around the scoping
 * every other read and write obeys — worked example: a handler running a
 * claimed job reads `organizationId` off the row this file gave it, then
 * reaches any id its own `payload` names through the usual scoped functions
 * (say, `repos/courses.ts#getCourse(organizationId, courseIdFromPayload,
 * db)`). If the payload names a course belonging to a different
 * organization, that call returns `undefined` the same way it always does
 * for a foreign id (TEN-5) — running through a job payload instead of a
 * request body changes nothing about it. This file adds no special-case
 * enforcement for that; the scoping every other repo function already holds
 * itself to is the whole answer (`tests/jobs.test.ts` proves it against a
 * real handler-shaped call).
 *
 * JOB-6 — `payload` is opaque, but it is not kept forever: it is real
 * personal data (`roster.import`'s own payload is an entire roster CSV —
 * names, emails, Discord handles), and a job outlives the work it described
 * once it reaches a state nothing will ever read the payload from again.
 * `completeJob` and `markJobFailed` below null it out in the same write that
 * records the terminal `succeeded`/`failed` status — clearing it as a
 * separate pass, after the fact, would leave a window where a crash between
 * the two writes lands a terminal job that still carries its payload, and
 * defeats the retention guarantee as surely as never clearing it at all.
 * `rescheduleJobForRetry` is the one write that must *not* clear it: JOB-2's
 * retry and JOB-3's once-only execution across a worker restart both re-read
 * the payload for the next attempt, so a job that failed but has attempts
 * left still needs it, and stays exactly as populated as it was on the last
 * attempt.
 */

import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm'

import type { Database } from '../client.js'
import { jobs } from '../schema.js'

export type Job = typeof jobs.$inferSelect

/** Fields the caller supplies when enqueueing a job. */
export interface NewJob {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  /** Selects the handler `@bloombot/jobs`'s registry runs this job with. */
  kind: string
  /**
   * Opaque to this table (JOB-1) — serialized to JSON here. A handler owns
   * its own shape, and reaches anything it names only through the usual
   * organization-scoped repo functions (this file's own module comment has
   * the worked example).
   */
  payload: unknown
  /**
   * JOB-2's bound on attempts. Required, not defaulted here — the retry
   * policy that decides it is `@bloombot/jobs`'s concern, not this table's,
   * the same "no default value is invented" reasoning
   * `courses.maxRequestsPerDay`'s own comment (`schema.ts`) already applies
   * to a column like this.
   */
  maxAttempts: number
  /**
   * When this job first becomes claimable. Defaults to now; a caller with
   * work that should not start immediately (none in this slice) sets this
   * ahead instead.
   */
  availableAt?: number
}

/**
 * JOB-6 rework note — refuses an `undefined` payload at the point of the
 * mistake, rather than letting it become a misleading diagnosis later.
 * `payload: unknown` accepts `undefined` as a value — `unknown` is
 * TypeScript's top type, so it admits every value including `undefined`,
 * the same as any other — and `JSON.stringify(undefined)` itself returns
 * `undefined`, not the string `"undefined"` — drizzle omits an `undefined`
 * column from its own `INSERT` entirely, so this used to insert a bare
 * `NULL` into `payload` silently. Before `payload` became nullable (JOB-6,
 * `f094665` — this table's own `NOT NULL` until that slice, not this one),
 * that same call was refused at insert time by the column constraint;
 * nulling it deliberately on a terminal row is now this table's own normal
 * behaviour, so that safety net is gone, and the same mistake instead
 * surfaces much later, at claim time, as `runner.ts`'s own "job payload was
 * already cleared" — which is true of the symptom and false about the
 * cause: this payload was never set, not cleared. No call site passes
 * `undefined` today; this guards the mistake at the one place that can tell
 * the two apart.
 */
function assertPayloadProvided(payload: unknown): void {
  if (payload === undefined) {
    throw new Error(
      'enqueueJob: payload must not be undefined — pass null or an explicit value if a job genuinely has nothing to carry'
    )
  }
}

/** Serializes `payload` and inserts a fresh, unclaimed, pending job. */
export function enqueueJob(
  organizationId: string,
  input: NewJob,
  db: Database
): Job {
  assertPayloadProvided(input.payload)
  const now = Date.now()
  return db
    .insert(jobs)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: input.availableAt ?? now,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
}

/** What a worker supplies when claiming the next job it can run. */
export interface ClaimJob {
  /** An opaque identifier for the claiming worker instance — recorded on the row for attribution, not read back by anything in this file. */
  owner: string
  /** JOB-3's lease length: how long this claim is honoured before another claimant may treat it as released. */
  leaseMs: number
}

/**
 * A job this file already knows is claimed and still owned by the caller —
 * what `completeJob`/`rescheduleJobForRetry`/`markJobFailed` below take, so
 * a write from a claim that has since been superseded (its lease expired
 * and someone else reclaimed the row) cannot land. `claimNextJob`'s own
 * return value satisfies this directly (`{ owner: job.claimedBy, ... }`
 * shaped by the caller from the `Job` it got back).
 */
export interface OwnedClaim {
  owner: string
  claimExpiresAt: number
}

/**
 * The condition every completing write below shares: this exact row, this
 * exact organization, still `running`, still claimed by this exact
 * `owner`/`claimExpiresAt` pair. Matching on the pair rather than `owner`
 * alone is what closes the ABA case a single field would miss — the same
 * worker instance claiming, losing, and later reclaiming the *same* job
 * would otherwise present the same `owner` twice, and a late write from the
 * first claim could be mistaken for one from the second.
 */
function ownsRunningJob(
  jobId: string,
  organizationId: string,
  claim: OwnedClaim
) {
  return and(
    eq(jobs.id, jobId),
    eq(jobs.organizationId, organizationId),
    eq(jobs.status, 'running'),
    eq(jobs.claimedBy, claim.owner),
    eq(jobs.claimExpiresAt, claim.claimExpiresAt)
  )
}

/**
 * Claim the most-overdue eligible job whose `kind` is in `kinds`, marking it
 * running under `claim`. Eligible means pending and due
 * (`nextAttemptAt <= now`), or already `running` but its lease has expired
 * (`claimExpiresAt < now` — JOB-3's "a worker that dies mid-job releases its
 * claim"). `undefined` when nothing eligible exists.
 *
 * TEN-2 exception: unscoped by design (this file's own module comment).
 * `kinds` narrows the claim to what the calling worker actually has
 * handlers registered for (`@bloombot/jobs`'s handler registry), rather than
 * claiming a job kind nothing here can run.
 *
 * JOB-3's own text: "claiming a job is atomic". This is a select-then-write,
 * not one statement — the same shape `claimDiscordServerBinding`'s re-claim
 * branch (`discord-servers.ts`) already takes for TEN-3, and the same
 * reasoning: the `SELECT` below only picks a *candidate* — it proves
 * nothing by itself. The `UPDATE` re-asserts the exact eligibility
 * condition the candidate was selected under, in its own `WHERE` clause,
 * not merely `id = ?` — so a concurrent claimant whose own `SELECT` read
 * this same row before this `UPDATE` commits loses: by the time its
 * `UPDATE` runs, `status` is already `'running'` and `claim_expires_at` is
 * in the future, the `WHERE` no longer matches, and `.get()` returns
 * `undefined` — nothing thrown, nothing double-claimed. It is the `UPDATE`
 * that is atomic, not the read that precedes it, which is what actually
 * has to be true for JOB-3 to hold.
 */
export function claimNextJob(
  kinds: readonly string[],
  claim: ClaimJob,
  db: Database
): Job | undefined {
  if (kinds.length === 0) return undefined
  const now = Date.now()

  const eligible = () =>
    or(
      and(eq(jobs.status, 'pending'), lte(jobs.nextAttemptAt, now)),
      and(eq(jobs.status, 'running'), lt(jobs.claimExpiresAt, now))
    )

  const candidate = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.kind, kinds), eligible()))
    .orderBy(asc(jobs.nextAttemptAt))
    .limit(1)
    .get()
  if (!candidate) return undefined

  return db
    .update(jobs)
    .set({
      status: 'running',
      attempts: sql`${jobs.attempts} + 1`,
      claimedBy: claim.owner,
      claimExpiresAt: now + claim.leaseMs,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, candidate.id), eligible()))
    .returning()
    .get()
}

/**
 * Mark a claimed job succeeded. `undefined` when `claim` no longer owns a
 * running job by this id in this organization (see `ownsRunningJob`).
 *
 * `result` (SRV-6..8) is what a handler resolved with — opaque JSON, the
 * same "not this table's to interpret" discipline `payload` (`schema.ts`'s
 * own comment) already holds itself to, serialized here so `@bloombot/jobs`'s
 * `runNextJob` (the only real caller) never has to. Omitted entirely by a
 * handler that resolves with nothing (`Promise<void>`, still the common
 * case for a job with no report worth keeping) — the column stays `null`
 * rather than becoming the string `"undefined"` or `"null"`.
 *
 * JOB-6 — `payload` is nulled in this same write. `succeeded` is terminal:
 * nothing ever reclaims this row (`claimNextJob`'s own `eligible()` only
 * matches `pending` or a lapsed `running` lease), so nothing will read the
 * payload again — the input this job was given is not the job's outcome,
 * and does not outlive it.
 */
export function completeJob(
  organizationId: string,
  jobId: string,
  claim: OwnedClaim,
  db: Database,
  result?: unknown
): Job | undefined {
  const now = Date.now()
  return db
    .update(jobs)
    .set({
      status: 'succeeded',
      claimedBy: null,
      claimExpiresAt: null,
      payload: null,
      updatedAt: now,
      ...(result !== undefined ? { result: JSON.stringify(result) } : {}),
    })
    .where(ownsRunningJob(jobId, organizationId, claim))
    .returning()
    .get()
}

/** What a retryable failure records: why, and when the next attempt becomes claimable. */
export interface RetryFailure {
  reason: string
  nextAttemptAt: number
}

/**
 * A claimed job's attempt failed, and it has not exhausted its attempts —
 * releases the claim and returns it to `pending`, due again at
 * `nextAttemptAt` (JOB-2's backoff, computed by `@bloombot/jobs`, not this
 * file). `reason` is kept on `lastError` even though this is not the
 * terminal state, so the row shows why the *last* attempt failed while it
 * waits for the next one.
 *
 * JOB-6 — `payload` is deliberately left untouched here, unlike
 * `completeJob`/`markJobFailed`: this is not a terminal state, a retry
 * follows, and the next attempt (JOB-2) reads the same payload the previous
 * one did.
 */
export function rescheduleJobForRetry(
  organizationId: string,
  jobId: string,
  claim: OwnedClaim,
  input: RetryFailure,
  db: Database
): Job | undefined {
  const now = Date.now()
  return db
    .update(jobs)
    .set({
      status: 'pending',
      claimedBy: null,
      claimExpiresAt: null,
      lastError: input.reason,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: now,
    })
    .where(ownsRunningJob(jobId, organizationId, claim))
    .returning()
    .get()
}

/**
 * A claimed job's attempt failed, and it has exhausted its attempts —
 * JOB-2's terminal state: stays on the table with `reason` in `lastError`,
 * never deleted and never silently dropped.
 *
 * JOB-6 — `payload` is nulled in this same write, the same reasoning
 * `completeJob`'s own doc comment gives: `failed` is as terminal as
 * `succeeded` is (this file's own `eligible()`, in `claimNextJob`, never
 * reclaims either), so the row keeps the reason it stopped but not the
 * input it was given.
 */
export function markJobFailed(
  organizationId: string,
  jobId: string,
  claim: OwnedClaim,
  reason: string,
  db: Database
): Job | undefined {
  const now = Date.now()
  return db
    .update(jobs)
    .set({
      status: 'failed',
      claimedBy: null,
      claimExpiresAt: null,
      payload: null,
      lastError: reason,
      updatedAt: now,
    })
    .where(ownsRunningJob(jobId, organizationId, claim))
    .returning()
    .get()
}

/** Look up a job by id, scoped to `organizationId`. */
export function getJob(
  organizationId: string,
  jobId: string,
  db: Database
): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
    .get()
}

/**
 * How many jobs are currently queued — pending, or running (whether or not
 * their lease has expired; a stranded job is still "in the queue" from an
 * operator's point of view) — across every organization.
 *
 * TEN-2 exception: unscoped by design (this file's own module comment).
 */
export function countQueuedJobs(db: Database): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(inArray(jobs.status, ['pending', 'running']))
    .get()
  return row?.count ?? 0
}
