/**
 * Repository for `course_self_enrolment_intents` (ENRL-13).
 *
 * A separate file from `repos/enrolments.ts` on purpose: an intent is not an
 * enrolment and never becomes one on its own (`docs/SPEC.md`'s own words for
 * ENRL-13) — it is a distinct table recording a distinct fact, "this person
 * asked this course while it was inviting self-enrolment," which is redeemed
 * into an actual enrolment (through `repos/enrolments.ts#enrolViaSelfEnrolment`)
 * only by the deliberate, later act of connecting. Keeping it out of
 * `enrolments.ts` keeps that file's own module comment true — "ENRL-3's own
 * three [`enrolVia*`] are the only functions that write [an enrolment] row" —
 * without this file's own two functions needing to pretend to be a fourth.
 * See `docs/DECISIONS.md` for the fuller reasoning behind the split.
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * the same convention every other repo in this package holds itself to
 * (TEN-2).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, isNull } from 'drizzle-orm'

import type { Executor, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import * as courses from './courses.js'
import { enrolViaSelfEnrolment } from './enrolments.js'
import { getPerson } from './people.js'
import { courseSelfEnrolmentIntents } from '../schema.js'

export type CourseSelfEnrolmentIntent =
  typeof courseSelfEnrolmentIntents.$inferSelect

/**
 * `SQLITE_CONSTRAINT_UNIQUE` is what
 * `course_self_enrolment_intents_org_course_person_unredeemed_unique`
 * (`schema.ts`) throws as — duplicated from `repos/enrolments.ts`'s own copy
 * rather than shared, the same "each repo file checks its own constraint
 * against its own error" convention that file's own comment on this helper
 * already states.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof BetterSqlite3.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

/** The one unredeemed intent, if any, binding `personId` to `courseId`. */
function getUnredeemedIntent(
  organizationId: string,
  courseId: string,
  personId: string,
  db: Executor
): CourseSelfEnrolmentIntent | undefined {
  return db
    .select()
    .from(courseSelfEnrolmentIntents)
    .where(
      and(
        eq(courseSelfEnrolmentIntents.organizationId, organizationId),
        eq(courseSelfEnrolmentIntents.courseId, courseId),
        eq(courseSelfEnrolmentIntents.personId, personId),
        isNull(courseSelfEnrolmentIntents.redeemedAt)
      )
    )
    .get()
}

/**
 * ENRL-13: record that `personId` asked `courseId` while it carried
 * `selfEnrolFromDiscord` and was not yet connected — `@bloombot/discord`'s
 * `handle-mention.ts` is the only caller, on every such message, not only
 * the first. Idempotent: a student who messages five times before
 * connecting has one unredeemed intent, not five — the existing row is
 * returned unchanged, the same "no duplicate, existing row back" contract
 * `repos/enrolments.ts#admit` already gives for an active enrolment.
 *
 * `undefined` when `courseId` or `personId` does not belong to
 * `organizationId` — the same TEN-2 guard `admit` runs for the identical
 * reason (this file's own module comment on where the row is actually
 * written applies equally here: nothing downstream should have to trust a
 * caller's own scoping).
 *
 * `db` accepts `Executor`, not just `Database`: `handleMention` calls this
 * from a plain top-level connection today, but nothing here needs more than
 * `Executor` offers, the same minimal-surface convention `enrolments.ts`'s
 * own `enrolVia*` functions already hold themselves to.
 */
export function recordSelfEnrolmentIntent(
  organizationId: string,
  input: { courseId: string; personId: string },
  db: Executor
): CourseSelfEnrolmentIntent | undefined {
  if (!courses.getCourse(organizationId, input.courseId, db)) return undefined
  if (!getPerson(organizationId, input.personId, db)) return undefined

  const existing = getUnredeemedIntent(
    organizationId,
    input.courseId,
    input.personId,
    db
  )
  if (existing) return existing

  try {
    return db
      .insert(courseSelfEnrolmentIntents)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        personId: input.personId,
        createdAt: Date.now(),
      })
      .returning()
      .get()
  } catch (error) {
    // A concurrent message from the same person lost the race against
    // this table's own partial unique index — the same "caught, and the
    // winner looked up instead of a raw driver error escaping" shape
    // `enrolments.ts#admit` already uses for its own unique constraint.
    if (isUniqueConstraintError(error)) {
      const winner = getUnredeemedIntent(
        organizationId,
        input.courseId,
        input.personId,
        db
      )
      if (winner) return winner
    }
    throw error
  }
}

/**
 * ENRL-13: redeem every unredeemed intent `personId` holds, in
 * `organizationId` — called from `apps/api/src/routes/person-link.ts` on a
 * successful `/discord/confirm` **and** `/mcp/confirm`, since the SPEC's own
 * words are "connecting ... is what admits them," and both routes are
 * connecting.
 *
 * **Gated at redemption time, not only at record time.** Each intent's
 * course is re-read here, fresh, rather than trusted from whenever the
 * intent was recorded: a course whose `selfEnrolFromDiscord` has since been
 * turned off — or that has been disabled entirely — admits nobody with it,
 * even though the intent itself still names it. See `docs/DECISIONS.md` for
 * why this re-check belongs here rather than only at record time.
 *
 * **An intent is redeemed once, whether or not it produced an enrolment.**
 * `redeemedAt` is set either way — a refusal (the setting has since been
 * turned off, or `enrolViaSelfEnrolment`'s own `reviveEnded: false` refused
 * an ended enrolment, ENRL-6) is not retried on every later connect attempt;
 * the intent already did the one thing it could do. Each intent is redeemed
 * in its own `writeTransaction` — the enrolment write and the `redeemedAt`
 * stamp commit or fail together, so a crash between the two can never leave
 * an intent marked redeemed with no enrolment to show for a *successful*
 * admission, or vice versa.
 *
 * Returns nothing: this is a side-effecting sweep, not a query, and neither
 * caller needs to know which courses it admitted into — `handleMention`'s
 * own precedent for a write a caller does not need the result of.
 */
export function redeemSelfEnrolmentIntents(
  organizationId: string,
  personId: string,
  db: TransactingExecutor
): void {
  const unredeemed = db
    .select()
    .from(courseSelfEnrolmentIntents)
    .where(
      and(
        eq(courseSelfEnrolmentIntents.organizationId, organizationId),
        eq(courseSelfEnrolmentIntents.personId, personId),
        isNull(courseSelfEnrolmentIntents.redeemedAt)
      )
    )
    .all()

  for (const intent of unredeemed) {
    writeTransaction(db, (tx) => {
      const course = courses.getCourse(organizationId, intent.courseId, tx)
      if (course?.enabled && course.selfEnrolFromDiscord) {
        enrolViaSelfEnrolment(
          organizationId,
          { courseId: intent.courseId, personId },
          tx
        )
      }
      tx.update(courseSelfEnrolmentIntents)
        .set({ redeemedAt: Date.now() })
        .where(eq(courseSelfEnrolmentIntents.id, intent.id))
        .run()
    })
  }
}
