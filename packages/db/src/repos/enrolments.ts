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
 * `docs/DECISIONS.md`. It is a pure string-membership check against
 * *either* of a course's two roles — its `studentsRole` or its `adminsRole`
 * (ENRL-7: "anyone a course is taught through is enrolled by asking it" —
 * `routing.ts#routeMessage` already answers an admins-role holder's message
 * the same as a students-role holder's, so this file's own admission has to
 * match, or the web surface, which authorizes on this table rather than a
 * membership, refuses the very person Discord just answered). ENRL-5's "a
 * Discord role confers none of [staff authority]" is untouched by this —
 * that requirement is about `memberships` and who may administer a course,
 * a different table and a different question than "who may ask it," which
 * is all `enrolments` ever records — against whatever role names its caller
 * already resolved; this file makes no Discord call of its own.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm'

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
 * ENRL-6/ENRL-8 rework: does `personId` hold an *ended* enrolment for
 * `courseId` — distinct from `getActiveEnrolment` (which only ever finds a
 * live one) and from `admit`'s own module-private `priorEnded` check (which
 * is keyed on the exact `personId` a caller is about to admit, not any
 * other person who might be the same human under a different identity).
 *
 * `repos/course-join-links.ts#redeemJoinLinkForWebAccount` calls this before
 * minting a *second* person for a signed-in web account that has no
 * identity in the link's own organization yet: `reviveEnded: false` on
 * `enrolViaJoinLink` (above) only ever protects a `(course, person)` pairing
 * that already exists, so a person who was ended under a *different*
 * identity (their Discord person, say) is invisible to it — the fresh
 * person that function is about to create has never been enrolled in
 * anything, ended or otherwise. This lets that caller check the *other*
 * person the same human's verified email already names, before deciding
 * whether to mint a new one at all.
 *
 * `db` accepts `Executor`, not just `Database`, for the same reason
 * `getPerson`'s own doc comment gives: a caller inside its own
 * `db.transaction(...)` callback has a `tx` that does not satisfy
 * `Database` itself.
 */
export function hasEndedEnrolment(
  organizationId: string,
  courseId: string,
  personId: string,
  db: Executor
): boolean {
  return (
    db
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.organizationId, organizationId),
          eq(enrolments.courseId, courseId),
          eq(enrolments.personId, personId),
          isNotNull(enrolments.endedAt)
        )
      )
      .get() !== undefined
  )
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
 * `repos/course-join-links.ts#redeemJoinLink` and
 * `#redeemJoinLinkForWebAccount`, once either has already validated the link
 * itself, inside the same transaction (rework finding 6).
 *
 * `reviveEnded: false` (ENRL-6/ENRL-8 rework, reversed from `true`) — this
 * function's own prior reasoning was "redeeming a link is a deliberate,
 * caller-initiated admission… an instructor handing the same link back to a
 * student they had previously ended is exactly the case ENRL-6 was written
 * to allow back in." That premise held only while `redeemJoinLink` had no
 * live caller (D-55's own "correct and tested, but nothing outside a test
 * ever called it"): once ENRL-8 wired a real route to it, the caller
 * redeeming is never the instructor — it is whoever holds the secret, which
 * ENRL-3 deliberately shares with an entire class. An instructor ending one
 * student's enrolment (ENRL-6) does not revoke the link, so that same
 * student re-submitting the identical, still-live secret they already had
 * is not a new instructor decision at all; it is the removed person
 * undoing ENRL-6 by themselves, with the class's shared secret standing in
 * for a re-admission nobody actually made. This is the identical shape D-35
 * rework finding 5 already fixed for `enrolViaDiscordRole` below — an
 * ambient credential the person already holds (there, a Discord role; here,
 * a shared link) must not undo an instructor's decision on its own — so
 * this function now makes the same choice, for the same reason: a person an
 * instructor has explicitly ended stays ended until an instructor
 * re-admits them through a caller that actually means to (see
 * `docs/DECISIONS.md` for this rework's own record, and this file's
 * "Limits": nothing in this package currently exposes that
 * instructor-initiated re-admission action — a future one should call
 * `admit` with `reviveEnded: true` explicitly, the same way every choice in
 * this file is stated, not assumed).
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
    false,
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
 * ENRL-3/ENRL-7: enrol via holding either of the course's two roles — its
 * `studentsRole` or its `adminsRole` — in the organization's bound Discord
 * server. `roleNames` is whatever the caller already resolved (a guild
 * member's own role names) — this function makes no Discord call of its own
 * (this file's own module comment). `undefined` both when `courseId` does
 * not resolve in `organizationId` and when `roleNames` includes neither
 * role — nobody is admitted either way.
 *
 * ENRL-7 widened this from `studentsRole` alone: `routeMessage` already
 * answers an admins-role holder's message the same as a students-role
 * holder's (`@bloombot/core`'s `routing.ts`, unchanged by this — its own
 * `roleMatches` check has always been "either role"), so an instructor or
 * teaching assistant held a Discord conversation this table had no record
 * of, and the web surface (which authorizes on this table, not a
 * membership — `routes/chat.ts`'s own module comment) refused the very
 * person Discord just answered. Both roles now admit identically; nothing
 * below distinguishes which one a caller held.
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
 * Discord role never was — see each function's own comment). This reasoning
 * never turned on *which* role the caller held — an admins-role holder's
 * enrolment is just as ambient a fact, re-checked on every message the same
 * way, as a students-role holder's — so ENRL-7's widening to either role
 * leaves `reviveEnded: false` exactly as it was: an instructor an owner has
 * explicitly ended (ENRL-6) stays ended, full stop, not merely "stays ended
 * unless they happen to hold the other of the course's two roles."
 */
export function enrolViaDiscordRole(
  organizationId: string,
  input: { courseId: string; personId: string; roleNames: string[] },
  db: Executor
): Enrolment | undefined {
  const course = courses.getCourse(organizationId, input.courseId, db)
  if (!course) return undefined
  // ENRL-7: either of the course's two roles admits — see this function's
  // own doc comment for why `adminsRole` is no longer excluded.
  if (
    !input.roleNames.includes(course.studentsRole) &&
    !input.roleNames.includes(course.adminsRole)
  ) {
    return undefined
  }
  return admit(
    organizationId,
    input.courseId,
    input.personId,
    'discord_role',
    false,
    db
  )
}
