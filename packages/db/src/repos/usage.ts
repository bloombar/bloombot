/**
 * Repository for `usage_counters` (CONV-3, BOT-5, BOT-11).
 *
 * A person's daily request count against a course, keyed on (course,
 * person, calendar day). Every function here is scoped by `organizationId`,
 * its first parameter — there is no exception in this file (TEN-2).
 *
 * `day` is always supplied by the caller as an explicit `YYYY-MM-DD`
 * string, never read from the clock in here — BOT-11 is exactly the defect
 * of a day boundary evaluated against a value the check itself derived
 * rather than one passed in fresh, so this package does not repeat it: what
 * "today" means is decided once, by the caller, and the same string has to
 * be used consistently by both the increment and the check for the
 * boundary to behave correctly.
 */

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'

import type { Database } from '../client.js'
import { courses, people, usageCounters } from '../schema.js'

export type UsageCounter = typeof usageCounters.$inferSelect

/**
 * `day`'s required shape — strict `YYYY-MM-DD`, nothing looser. Finding 5 of
 * the CONV-1 rework: without this, a caller formatting the day as
 * `'2026-8-31'` or `'8/31/2026'` gets a *fresh* counter row on every request
 * — `usageCounters`'s composite primary key (`schema.ts`) is textual, so a
 * differently-formatted string for "the same day" never matches an existing
 * row's `day` — which silently bypasses `max_requests_per_day`, the same
 * class of defect BOT-11 fixed one layer up. `usage_counters_day_check`
 * (`schema.ts`) backs this with a `CHECK` too, for a writer that reaches the
 * table directly, but this regex is what turns a malformed `day` into a
 * clear failure at the call site rather than a raw SQL constraint error.
 */
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/

function assertValidDay(day: string): void {
  if (!DAY_FORMAT.test(day)) {
    throw new Error(`Invalid day "${day}": expected the shape "YYYY-MM-DD".`)
  }
}

/**
 * Increment a person's request count for a course on `day`, creating the
 * row on its first request of the day. `INSERT ... ON CONFLICT DO UPDATE`
 * against the table's own composite primary key (`schema.ts`) — portable
 * SQL Postgres supports too (D-2), the same device this package's schema
 * comment names as an allowed alternative to the explicit select-then-write
 * `claimDiscordServerBinding` uses (`docs/DECISIONS.md` D-11).
 *
 * `undefined` when `courseId` or `personId` does not exist, or does not
 * belong to `organizationId` (TEN-2/TEN-5) — the foreign keys on this table
 * only prove each id exists *somewhere*, not that it belongs to this
 * organization, so a foreign id is refused rather than written through.
 */
export function incrementUsage(
  organizationId: string,
  courseId: string,
  personId: string,
  day: string,
  db: Database
): UsageCounter | undefined {
  assertValidDay(day)

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined

  const person = db
    .select({ id: people.id })
    .from(people)
    .where(
      and(eq(people.id, personId), eq(people.organizationId, organizationId))
    )
    .get()
  if (!person) return undefined

  return db
    .insert(usageCounters)
    .values({ organizationId, courseId, personId, day, count: 1 })
    .onConflictDoUpdate({
      target: [
        usageCounters.organizationId,
        usageCounters.courseId,
        usageCounters.personId,
        usageCounters.day,
      ],
      set: { count: sql`${usageCounters.count} + 1` },
    })
    .returning()
    .get()
}

/**
 * What `reserveUsageSlot` reports: `granted` with the count *after* this
 * request is counted, or a plain refusal when the limit was already
 * reached — no count is returned on refusal, since nothing was written.
 */
export type UsageReservation =
  { granted: true; count: number } | { granted: false }

/**
 * Atomically check the daily allowance and count this request against it, in
 * one statement (finding 8 of the CORE-1 rework). `packages/core`'s
 * `answerQuestion` used to do this as two steps — `getUsageCount` to read the
 * count, then `incrementUsage` to write it, with an `await` on the model call
 * sitting in between — so two requests from the same person arriving close
 * together could both read the same "count so far", both pass the check, and
 * both write, landing the stored count one *past* `limit` even though the
 * check itself never let a request through improperly. SQLite's own
 * single-threaded, synchronous execution (via `better-sqlite3`) makes one
 * statement enough to close that: nothing else can run *inside* the
 * statement below for a second caller to interleave with, the way it could
 * across the two separate calls this replaces.
 *
 * The check and the write are the same `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE` — SQLite evaluates the `WHERE` on the conflicting row as part of
 * applying the conflict resolution itself (verified against this file's own
 * `better-sqlite3` version, not assumed from the docs alone): when it is
 * false the row is left exactly as it was and `RETURNING` reports nothing,
 * which this function surfaces as `{ granted: false }` rather than a
 * separately-read "would this exceed the limit" boolean that could itself
 * go stale before the write that acts on it.
 *
 * The first request of a `(course, person, day)` triple has no existing row
 * to conflict with, so the `INSERT`'s own `SELECT ... WHERE ${limit} > 0`
 * guard is what refuses it for a `limit` of `0` — without that guard, a
 * fresh `INSERT` would always succeed regardless of `limit`, since only the
 * `ON CONFLICT` branch's `WHERE` is conditional.
 *
 * `limit === null` means the course has no configured allowance — always
 * granted, unconditionally, the same "no default value is invented here"
 * reading `hasExhaustedDailyLimit` already gives a `null`
 * `maxRequestsPerDay` (BOT-5's platform default of 10 is `answerQuestion`'s
 * own responsibility to apply before calling this, per
 * `docs/DECISIONS.md` D-13).
 *
 * `undefined` when `courseId` or `personId` does not exist, or does not
 * belong to `organizationId` (TEN-2/TEN-5) — same tenant-scoping convention
 * `incrementUsage` already holds itself to, checked before the reservation
 * statement runs so a foreign id is refused rather than written through.
 */
export function reserveUsageSlot(
  organizationId: string,
  courseId: string,
  personId: string,
  day: string,
  limit: number | null,
  db: Database
): UsageReservation | undefined {
  assertValidDay(day)

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined

  const person = db
    .select({ id: people.id })
    .from(people)
    .where(
      and(eq(people.id, personId), eq(people.organizationId, organizationId))
    )
    .get()
  if (!person) return undefined

  if (limit === null) {
    const row = db
      .insert(usageCounters)
      .values({ organizationId, courseId, personId, day, count: 1 })
      .onConflictDoUpdate({
        target: [
          usageCounters.organizationId,
          usageCounters.courseId,
          usageCounters.personId,
          usageCounters.day,
        ],
        set: { count: sql`${usageCounters.count} + 1` },
      })
      .returning({ count: usageCounters.count })
      .get()
    return { granted: true, count: row.count }
  }

  // Raw SQL, not the query builder: drizzle's `onConflictDoUpdate` supports
  // a `setWhere` on the `DO UPDATE` branch, but not a matching condition on
  // the plain `INSERT` branch a first-ever row takes — the `SELECT ...
  // WHERE` above is what closes that gap for a `limit` of `0`. Column and
  // table names are written out rather than taken from `usageCounters`
  // because interpolating a table-qualified column reference into an
  // unqualified `INSERT` column list produces invalid SQL; they must be kept
  // in sync with `usage_counters`'s definition in `schema.ts` by hand.
  const row = db.get<{ count: number }>(sql`
    INSERT INTO usage_counters (organization_id, course_id, person_id, day, count)
    SELECT ${organizationId}, ${courseId}, ${personId}, ${day}, 1
    WHERE ${limit} > 0
    ON CONFLICT (organization_id, course_id, person_id, day)
    DO UPDATE SET count = count + 1 WHERE usage_counters.count < ${limit}
    RETURNING count
  `)
  if (!row) return { granted: false }
  return { granted: true, count: row.count }
}

/** A person's request count for a course on `day` — `0` when no row exists yet. */
export function getUsageCount(
  organizationId: string,
  courseId: string,
  personId: string,
  day: string,
  db: Database
): number {
  assertValidDay(day)

  const row = db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, organizationId),
        eq(usageCounters.courseId, courseId),
        eq(usageCounters.personId, personId),
        eq(usageCounters.day, day)
      )
    )
    .get()
  return row?.count ?? 0
}

/**
 * Has this person exhausted `courses.maxRequestsPerDay` for this course on
 * `day` (BOT-5)? Tri-state, deliberately not a plain `boolean` (finding 4 of
 * the CONV-1 rework):
 *
 * - `undefined` when `courseId` does not exist, or does not belong to
 *   `organizationId` (TEN-2) — "I cannot tell you" is not the same answer as
 *   "no". A `boolean` `false` here used to be indistinguishable from "no
 *   limit configured", which let a cross-tenant or unknown `courseId` fail
 *   *open*: an action layer calling this with a course from another
 *   organization would see "not exhausted" and let the request proceed,
 *   while the paired `incrementUsage` (above) already returns `undefined`
 *   for the same input and counts nothing — an uncapped, unrecorded
 *   conversation.
 * - `false` when the course has not set a limit at all (`maxRequestsPerDay`
 *   is `null`) — this package does not invent the platform's fallback
 *   default here, the same "no default value is invented" reasoning
 *   `schema.ts`'s comment on `courses.maxRequestsPerDay` already applies to
 *   the column itself (D-10); a limit of "unset" is applied by whatever
 *   later reads the platform default, not by this repo.
 * - `true`/`false` otherwise, from comparing `getUsageCount` against the
 *   configured limit.
 */
export function hasExhaustedDailyLimit(
  organizationId: string,
  courseId: string,
  personId: string,
  day: string,
  db: Database
): boolean | undefined {
  const course = db
    .select({ maxRequestsPerDay: courses.maxRequestsPerDay })
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined
  if (course.maxRequestsPerDay === null) return false

  const count = getUsageCount(organizationId, courseId, personId, day, db)
  return count >= course.maxRequestsPerDay
}

/** One row of `listUsageNearLimit`'s own report — a person, a course, and how close today's count is to what that course allows. */
export interface UsageNearLimit {
  courseId: string
  courseTitle: string
  personId: string
  personDisplayName: string | null
  count: number
  maxRequestsPerDay: number
}

/** `listUsageNearLimit`'s own default — 80% of a course's own daily allowance, not a platform-wide count. */
const DEFAULT_NEAR_LIMIT_RATIO = 0.8

/**
 * COST-4 — "an instructor sees ... the students approaching their limits":
 * every (course, person) pair in `organizationId` whose count for `day` has
 * reached at least `thresholdRatio` (default 80%) of that course's own
 * `maxRequestsPerDay`.
 *
 * Only courses with a *configured* `maxRequestsPerDay` are considered — a
 * course left at `null` has no limit to be near, the same "no default value
 * is invented here" reading `hasExhaustedDailyLimit`'s own comment already
 * gives that column; BOT-5's platform default (applied by
 * `@bloombot/core`'s `answer.ts`, D-13) is that layer's own business, not
 * this repo's, so a course relying on it is simply not reported here rather
 * than reported against a limit this file invented on its behalf.
 */
export function listUsageNearLimit(
  organizationId: string,
  day: string,
  db: Database,
  thresholdRatio: number = DEFAULT_NEAR_LIMIT_RATIO
): UsageNearLimit[] {
  assertValidDay(day)

  const rows = db
    .select({
      courseId: usageCounters.courseId,
      courseTitle: courses.title,
      personId: usageCounters.personId,
      personDisplayName: people.displayName,
      count: usageCounters.count,
      maxRequestsPerDay: courses.maxRequestsPerDay,
    })
    .from(usageCounters)
    .innerJoin(courses, eq(courses.id, usageCounters.courseId))
    .innerJoin(people, eq(people.id, usageCounters.personId))
    .where(
      and(
        eq(usageCounters.organizationId, organizationId),
        eq(usageCounters.day, day),
        isNotNull(courses.maxRequestsPerDay),
        // `maxRequestsPerDay` is proven non-null by the `isNotNull` guard
        // above; SQL itself has no way to express "and compare it" in the
        // same `WHERE` without repeating the column, so the ratio filter
        // below is a second, redundant-looking condition on the same
        // column rather than a single combined one.
        gte(
          sql`cast(${usageCounters.count} as real) / ${courses.maxRequestsPerDay}`,
          thresholdRatio
        )
      )
    )
    .all()

  // The `isNotNull` guard above makes this cast safe — every row reaching
  // here matched it — but drizzle's own inferred type still carries
  // `number | null` for a nullable column regardless of the `WHERE` clause
  // that filtered it.
  return rows.map((row) => ({
    ...row,
    maxRequestsPerDay: row.maxRequestsPerDay as number,
  }))
}
