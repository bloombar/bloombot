/**
 * Repository for `enrolments` (ENRL-1..6).
 *
 * Which courses a person may ask, as a stored relation (ENRL-1) rather than
 * something inferred per message. Every function here is scoped by
 * `organizationId`, its first parameter — there is no exception in this
 * file.
 *
 * ENRL-3's "a person never enrols themselves out of nothing" is enforced by
 * what this file exports, not by a convention a caller has to remember:
 * there is no function here that takes an arbitrary `source` — only three,
 * each hard-coding its own (`enrolViaJoinLink`/`enrolViaDiscordRole`/
 * `enrolViaRoster`), so creating a row with a source that does not match how
 * it was actually admitted is not something a caller of this file can even
 * express. All three funnel through the module-private `admit`, the one
 * place the row is actually written.
 *
 * ENRL-3's Discord-role path (`enrolViaDiscordRole`) is evaluated here, in
 * the repo layer, rather than in `@bloombot/core`'s `routing.ts` — see
 * `docs/DECISIONS.md`. It is a pure string-membership check against a
 * course's own `studentsRole` (never `adminsRole` — ENRL-5's "a Discord role
 * confers none of them" means even the *admin* role a person holds in
 * Discord has no bearing on enrolment, only the student one does) against
 * whatever role names its caller already resolved; this file makes no
 * Discord call of its own.
 */

import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../client.js'
import * as courses from './courses.js'
import { enrolments, people, type EnrolmentSource } from '../schema.js'

export type Enrolment = typeof enrolments.$inferSelect
export type { EnrolmentSource }

type Person = typeof people.$inferSelect

/**
 * The active enrolment binding `personId` to `courseId`, if any — ENRL-1/
 * ENRL-2's own "is this person actually enrolled" read. `undefined` both
 * when no such enrolment exists and when it exists but has ended (ENRL-6)
 * or belongs to a different organization (TEN-5) — indistinguishable on
 * purpose, the same "the caller already knows why" contract every other
 * scoped lookup in this package uses.
 */
export function getActiveEnrolment(
  organizationId: string,
  courseId: string,
  personId: string,
  db: Database
): Enrolment | undefined {
  return db
    .select()
    .from(enrolments)
    .where(
      and(
        eq(enrolments.organizationId, organizationId),
        eq(enrolments.courseId, courseId),
        eq(enrolments.personId, personId),
        isNull(enrolments.endedAt)
      )
    )
    .get()
}

/** One enrolment by id, active or ended — for `endEnrolment`'s own caller (`@bloombot/actions`' `enrolments.end`) to resolve before ending it. */
export function getEnrolment(
  organizationId: string,
  enrolmentId: string,
  db: Database
): Enrolment | undefined {
  return db
    .select()
    .from(enrolments)
    .where(
      and(
        eq(enrolments.id, enrolmentId),
        eq(enrolments.organizationId, organizationId)
      )
    )
    .get()
}

/** ENRL-2: every course `personId` may currently ask — the courses behind their active enrolments, and no others. */
export function listCoursesForPerson(
  organizationId: string,
  personId: string,
  db: Database
): courses.Course[] {
  const rows = db
    .select()
    .from(enrolments)
    .where(
      and(
        eq(enrolments.organizationId, organizationId),
        eq(enrolments.personId, personId),
        isNull(enrolments.endedAt)
      )
    )
    .all()

  return rows
    .map((row) => courses.getCourse(organizationId, row.courseId, db))
    .filter(
      (course): course is courses.CourseWithCategories => course !== undefined
    )
}

/** Every person currently enrolled in `courseId` — the people behind its active enrolments. */
export function listPeopleForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): Person[] {
  return db
    .select({
      id: people.id,
      organizationId: people.organizationId,
      displayName: people.displayName,
      email: people.email,
      firstName: people.firstName,
      lastName: people.lastName,
      githubHandle: people.githubHandle,
      createdAt: people.createdAt,
    })
    .from(enrolments)
    .innerJoin(
      people,
      and(
        eq(people.id, enrolments.personId),
        eq(people.organizationId, organizationId)
      )
    )
    .where(
      and(
        eq(enrolments.organizationId, organizationId),
        eq(enrolments.courseId, courseId),
        isNull(enrolments.endedAt)
      )
    )
    .all()
}

/**
 * ENRL-6: end an enrolment — stops the person asking; deletes nothing (not
 * the row itself, and nothing this file ever touches otherwise, since it
 * owns no transcript). Returns the number of rows changed: `0` for an
 * enrolment that does not exist, belongs to a different organization
 * (TEN-5), or has already ended — a caller ending an already-ended
 * enrolment gets the idempotent no-op every other "already in that state"
 * write in this package gives (`courses.ts#disableCourse`'s own comment).
 */
export function endEnrolment(
  organizationId: string,
  enrolmentId: string,
  db: Database
): number {
  const result = db
    .update(enrolments)
    .set({ endedAt: Date.now() })
    .where(
      and(
        eq(enrolments.id, enrolmentId),
        eq(enrolments.organizationId, organizationId),
        isNull(enrolments.endedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * The one place an enrolment row is actually written. Idempotent: a person
 * already actively enrolled in `courseId` (through any source) gets their
 * existing row back unchanged rather than a duplicate — redeeming the same
 * join link twice, or a roster row re-imported, admits the same person at
 * most once at a time (`enrolments_org_course_person_active_unique`,
 * `schema.ts`). Not exported: every caller reaches this only through one of
 * the three `enrolVia*` functions below, each of which supplies its own
 * fixed `source` — see this file's own module comment.
 */
function admit(
  organizationId: string,
  courseId: string,
  personId: string,
  source: EnrolmentSource,
  db: Database
): Enrolment {
  const existing = getActiveEnrolment(organizationId, courseId, personId, db)
  if (existing) return existing

  try {
    return db
      .insert(enrolments)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId,
        personId,
        source,
        createdAt: Date.now(),
      })
      .returning()
      .get()
  } catch (error) {
    // A concurrent admission of the same person into the same course lost
    // the race against `enrolments_org_course_person_active_unique` — the
    // same "caught, and the winner looked up instead of a raw driver error
    // escaping" shape `people.ts#resolvePersonByIdentity` already uses for
    // its own unique constraint.
    const winner = getActiveEnrolment(organizationId, courseId, personId, db)
    if (winner) return winner
    throw error
  }
}

/** ENRL-3: enrol via a redeemed course join link — called by `@bloombot/actions`' `redeemCourseJoinLink`, once it has already validated the link itself (`repos/course-join-links.ts#redeemJoinLink`). */
export function enrolViaJoinLink(
  organizationId: string,
  input: { courseId: string; personId: string },
  db: Database
): Enrolment {
  return admit(organizationId, input.courseId, input.personId, 'join_link', db)
}

/** ENRL-3: enrol via an imported roster row — called by `apps/worker`'s `roster-import.ts` handler for each row it resolves to a person. */
export function enrolViaRoster(
  organizationId: string,
  input: { courseId: string; personId: string },
  db: Database
): Enrolment {
  return admit(organizationId, input.courseId, input.personId, 'roster', db)
}

/**
 * ENRL-3: enrol via holding the course's student role in the organization's
 * bound Discord server. `roleNames` is whatever the caller already resolved
 * (a guild member's own role names) — this function makes no Discord call
 * of its own (this file's own module comment). `undefined` both when
 * `courseId` does not resolve in `organizationId` and when `roleNames` does
 * not include the course's `studentsRole` — nobody is admitted either way.
 */
export function enrolViaDiscordRole(
  organizationId: string,
  input: { courseId: string; personId: string; roleNames: string[] },
  db: Database
): Enrolment | undefined {
  const course = courses.getCourse(organizationId, input.courseId, db)
  if (!course) return undefined
  if (!input.roleNames.includes(course.studentsRole)) return undefined
  return admit(
    organizationId,
    input.courseId,
    input.personId,
    'discord_role',
    db
  )
}
