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

import { and, eq, sql } from 'drizzle-orm'

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
