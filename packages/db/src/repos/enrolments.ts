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

import type { Database, Executor } from '../client.js'
import * as courses from './courses.js'
import { getPerson } from './people.js'
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
  db: Executor
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

/**
 * ENRL-2: every course `personId` may currently ask — the courses behind
 * their active enrolments, and no others.
 *
 * Cheap-fix 10: also excludes a disabled course — a disabled course routes
 * nothing (CORE-2's "a message that matches no enabled course is ignored",
 * `@bloombot/core`'s `routing.ts#routeMessage`), so a course this function
 * still listed here would pass `checkEnrolmentAccessAction` while routing
 * silently dropped it, reading as "you may ask this" for a course nothing
 * ever answers. An enrolment into a disabled course is not ended by this —
 * see `docs/DECISIONS.md` D-34's "what disabling a course does to an
 * enrolment: nothing" — it just does not appear in this particular list
 * while the course stays disabled, exactly as it does not route.
 */
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
      (course): course is courses.CourseWithCategories =>
        course !== undefined && course.enabled
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
      connectedAt: people.connectedAt,
      mergedIntoPersonId: people.mergedIntoPersonId,
      mergedAt: people.mergedAt,
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
 *
 * Rework finding 2: `courseId` and `personId` must both belong to
 * `organizationId` — every other repo in this package refuses a foreign id
 * the same way (`courses.ts#getCourse`, `people.ts#getPerson`), and this is
 * the one place an enrolment row is actually written, so this is the one
 * place that check has to hold for every source, rather than trusting each
 * `enrolVia*` (or a caller upstream of it) to have done it already.
 * `undefined` for a foreign `courseId`/`personId`, indistinguishable from
 * this function's other refusals, the same "caller already knows why"
 * contract `getActiveEnrolment` documents for itself.
 *
 * `db` accepts `Executor`, not just `Database`: `repos/course-join-links.ts#redeemJoinLink`
 * (rework finding 6) calls `enrolViaJoinLink`, and so this, from inside its
 * own transaction — the link's revocation check and the enrolment it admits
 * have to commit or fail together.
 *
 * `reviveEnded`: whether a person who already holds an *ended* enrolment for
 * this course (and, per the check above, no active one) gets a brand-new
 * active row, or is left exactly as ended as whatever ended them last left
 * them (rework finding 3). Each `enrolVia*` below states its own choice
 * explicitly, rather than this function assuming one default for every
 * source — see their own doc comments and `docs/DECISIONS.md` D-34's rework
 * notes.
 */
function admit(
  organizationId: string,
  courseId: string,
  personId: string,
  source: EnrolmentSource,
  reviveEnded: boolean,
  db: Executor
): Enrolment | undefined {
  if (!courses.getCourse(organizationId, courseId, db)) return undefined
  if (!getPerson(organizationId, personId, db)) return undefined

  const existing = getActiveEnrolment(organizationId, courseId, personId, db)
  if (existing) return existing

  if (!reviveEnded) {
    // Rework finding 3: `existing` above already ruled out an *active* row
    // for this pairing, so any row this finds is necessarily an ended one —
    // a caller that does not ask to revive it gets `undefined` rather than a
    // brand-new active row.
    const priorEnded = db
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.organizationId, organizationId),
          eq(enrolments.courseId, courseId),
          eq(enrolments.personId, personId)
        )
      )
      .get()
    if (priorEnded) return undefined
  }

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

/**
 * ENRL-3: enrol via a redeemed course join link — called by
 * `repos/course-join-links.ts#redeemJoinLink`, once it has already validated
 * the link itself, inside the same transaction (rework finding 6).
 *
 * `reviveEnded: true` — redeeming a link is a deliberate, caller-initiated
 * admission (the redeemer presented a secret somebody handed them), not this
 * platform's own idempotent housekeeping the way a roster re-import is
 * (`enrolViaRoster`, below) — an instructor handing the same link back to a
 * student they had previously ended is exactly the "a caller actually means
 * to re-admit this person" case ENRL-6's "ended, not deleted" was written to
 * allow back in, so a prior ended enrolment for this course does not block a
 * fresh one here.
 */
export function enrolViaJoinLink(
  organizationId: string,
  input: { courseId: string; personId: string },
  db: Executor
): Enrolment | undefined {
  return admit(
    organizationId,
    input.courseId,
    input.personId,
    'join_link',
    true,
    db
  )
}

/**
 * ENRL-3: enrol via an imported roster row — called by `apps/worker`'s
 * `roster-import.ts` handler for each row it resolves to a person.
 *
 * `reviveEnded: false` (rework finding 3): a roster import is not a
 * deliberate re-admission decision the way redeeming a link, or holding a
 * Discord role, is — it is this platform's own idempotent re-sync of the
 * same CSV, re-run on a schedule or by habit, that an instructor never
 * edited to remove anybody. Left free to revive an ended enrolment, an
 * instructor who explicitly ends one (`endEnrolment`, ENRL-6) — routine
 * roster hygiene, not a mistake — would find that student silently
 * re-admitted the moment the next import ran. Leaving it ended here is what
 * keeps "ended" meaning ended until something that actually means to
 * re-admit this person calls one of the other two `enrolVia*` functions
 * instead.
 */
export function enrolViaRoster(
  organizationId: string,
  input: { courseId: string; personId: string },
  db: Executor
): Enrolment | undefined {
  return admit(
    organizationId,
    input.courseId,
    input.personId,
    'roster',
    false,
    db
  )
}

/**
 * ENRL-3: enrol via holding the course's student role in the organization's
 * bound Discord server. `roleNames` is whatever the caller already resolved
 * (a guild member's own role names) — this function makes no Discord call
 * of its own (this file's own module comment). `undefined` both when
 * `courseId` does not resolve in `organizationId` and when `roleNames` does
 * not include the course's `studentsRole` — nobody is admitted either way.
 *
 * `reviveEnded: false` (D-35 rework, finding 5 — reversed from `true`) — a
 * prior ended enrolment blocks a fresh one here, the same choice
 * `enrolViaRoster` already makes and for the closely related reason: ENRL-6
 * says ending an enrolment "stops the person asking that course", and
 * `@bloombot/discord`'s `handleMention` (LINK-5/D-34) now calls this on
 * *every* matched message a role holder sends, not on a one-off admission
 * decision an instructor would separately notice. `reviveEnded: true` was
 * written (D-34) on the reasoning that holding the role is "an ongoing,
 * re-checked fact... so a prior ended enrolment does not block a fresh one
 * here either" — sound in isolation, but inert until this platform actually
 * called this function anywhere, which it did not until D-34's own
 * successor slice (LINK-1..5) wired it into the live Discord message path.
 * Once it was live, `true` meant an instructor's `enrolments.end` (ENRL-6)
 * was silently undone by that same student's next `@bloombot`, with no
 * record — indistinguishable from ENRL-6 never having run at all. `false`
 * closes that: a person who has never held any enrolment for this course is
 * still admitted freely (there is no "prior ended row" to block — `admit`'s
 * own `reviveEnded` only matters once one exists), and a person an
 * instructor has explicitly ended stays ended until an instructor
 * re-admits them through one of the other two `enrolVia*` functions
 * (`reviveEnded: true` there is unchanged, and correct: redeeming a link or
 * a roster row *is* a deliberate re-admission decision the way an ambient
 * Discord role never was — see each function's own comment).
 */
export function enrolViaDiscordRole(
  organizationId: string,
  input: { courseId: string; personId: string; roleNames: string[] },
  db: Executor
): Enrolment | undefined {
  const course = courses.getCourse(organizationId, input.courseId, db)
  if (!course) return undefined
  if (!input.roleNames.includes(course.studentsRole)) return undefined
  return admit(
    organizationId,
    input.courseId,
    input.personId,
    'discord_role',
    false,
    db
  )
}
