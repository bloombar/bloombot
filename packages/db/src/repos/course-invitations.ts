/**
 * Repository for `course_invitations` (ROST-21, WEB-82).
 *
 * A roster import of a course without Discord (TEN-11) turns each row into
 * an invitation for the row's email address. An account that has proven that
 * address accepts it, which enrols the account's own person (source
 * `'roster'`, ENRL-3). Nothing here is address matching in PPL-4's sense: the
 * account proved the address, and an invitation holds no conversation,
 * transcript or allowance to inherit — it grants an enrolment and merges
 * nobody.
 *
 * `upsertInvitation`, `listOpenInvitationsForCourse` and `revokeInvitation`
 * are scoped by `organizationId`, the first parameter, like the rest of this
 * package. `claimInvitationsForAccount` is the one documented exception (see
 * `tests/tenant-scoping-convention.test.ts`): it is keyed on a proven account,
 * which can be invited in several organizations.
 */

import { and, asc, eq, isNull } from 'drizzle-orm'

import type { Database, Executor, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import { getAccountById } from './accounts.js'
import { getCourse } from './courses.js'
import * as enrolments from './enrolments.js'
import {
  findPeopleByEmail,
  mergeRosterFields,
  overwriteRosterFields,
} from './people.js'
import { findOrCreateWebPersonForAccount } from './web-person.js'
import {
  courseInvitations,
  courses,
  personIdentities,
  projects,
  type CourseInvitationOutcome,
} from '../schema.js'

export type CourseInvitation = typeof courseInvitations.$inferSelect

/** Narrows a claim (an import claims only for its own organization and course) and says where to report a swallowed error. */
export interface ClaimOptions {
  organizationId?: string
  courseId?: string
  /** Called with the error from an invitation that could not be claimed and was left open; ids only, no personal data. */
  onError?: (
    error: unknown,
    invitation: {
      invitationId: string
      organizationId: string
      courseId: string
    }
  ) => void
}

/** What accepting one invitation did, for the caller's report. */
export interface ClaimedInvitation {
  invitationId: string
  organizationId: string
  courseId: string
  email: string
  /** The person enrolled (or already enrolled); absent when the claim was refused before a person existed. */
  personId?: string
  outcome: CourseInvitationOutcome
}

/** An address as stored: trimmed and lower-cased, like `accounts.email`. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** A blank name is "not given", stored as null. */
function nameOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * ROST-21: record an invitation for `email` to `courseId`. There is at most
 * one open invitation per (course, email): when one is open its names are
 * updated (a blank name leaves the old one), otherwise a new one is made.
 * An invitation already accepted or removed does not block a new open one.
 *
 * `undefined` when `courseId` is not a live course in `organizationId`
 * (TEN-2).
 */
export function upsertInvitation(
  organizationId: string,
  input: {
    courseId: string
    email: string
    firstName?: string | null
    lastName?: string | null
  },
  db: Database
): { invitation: CourseInvitation; created: boolean } | undefined {
  return writeTransaction(db, (tx) => {
    if (!getCourse(organizationId, input.courseId, tx)) return undefined
    return upsertOne(organizationId, input, tx)
  })
}

/** One upsert inside a transaction whose course has already been checked. */
function upsertOne(
  organizationId: string,
  input: {
    courseId: string
    email: string
    firstName?: string | null
    lastName?: string | null
  },
  tx: TransactingExecutor
): { invitation: CourseInvitation; created: boolean } {
  const email = normalizeEmail(input.email)
  const firstName = nameOrNull(input.firstName)
  const lastName = nameOrNull(input.lastName)
  const now = Date.now()

  const open = tx
    .select()
    .from(courseInvitations)
    .where(
      and(
        eq(courseInvitations.organizationId, organizationId),
        eq(courseInvitations.courseId, input.courseId),
        eq(courseInvitations.email, email),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt)
      )
    )
    .get()

  if (open) {
    const updated = tx
      .update(courseInvitations)
      .set({
        firstName: firstName ?? open.firstName,
        lastName: lastName ?? open.lastName,
        updatedAt: now,
      })
      .where(eq(courseInvitations.id, open.id))
      .returning()
      .get()
    return { invitation: updated, created: false }
  }

  const invitation = tx
    .insert(courseInvitations)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      courseId: input.courseId,
      email,
      firstName,
      lastName,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  return { invitation, created: true }
}

/**
 * ROST-21: has somebody at `email` been removed from this course? True when a
 * person in the organization with that address has an ended enrolment in the
 * course and none of the people with that address is actively enrolled (an
 * account that signed in later has its own enrolled person under the same
 * address, which settles it). The same ended-enrolment test the claim uses.
 */
export function wasRemovedFromCourse(
  organizationId: string,
  courseId: string,
  email: string,
  db: Executor
): boolean {
  const matches = findPeopleByEmail(organizationId, normalizeEmail(email), db)
  if (
    matches.some((match) =>
      enrolments.getActiveEnrolment(organizationId, courseId, match.id, db)
    )
  ) {
    return false
  }
  return matches.some((match) =>
    enrolments.hasEndedEnrolment(organizationId, courseId, match.id, db)
  )
}

/** One row's result in `upsertInvitations`. */
export type UpsertRowResult =
  | { status: 'created' | 'updated'; invitation: CourseInvitation }
  | { status: 'previously_removed' }

/**
 * ROST-21: `upsertInvitation` for a whole roster in one transaction, with
 * the course looked up once. A row whose address belongs to somebody an
 * instructor removed from this course (ENRL-6) makes no invitation and is
 * reported `previously_removed`, since accepting it could never enrol them;
 * reinstating is the instructor's call (ENRL-9). `undefined` when the course
 * is not a live course in `organizationId`.
 */
export function upsertInvitations(
  organizationId: string,
  courseId: string,
  rows: {
    email: string
    firstName?: string | null
    lastName?: string | null
  }[],
  db: Database
): UpsertRowResult[] | undefined {
  return writeTransaction(db, (tx) => {
    if (!getCourse(organizationId, courseId, tx)) return undefined
    return rows.map((row): UpsertRowResult => {
      if (wasRemovedFromCourse(organizationId, courseId, row.email, tx)) {
        return { status: 'previously_removed' }
      }
      const { invitation, created } = upsertOne(
        organizationId,
        { ...row, courseId },
        tx
      )
      return { status: created ? 'created' : 'updated', invitation }
    })
  })
}

/** WEB-82: a course's invitations not yet accepted or removed, oldest first. */
export function listOpenInvitationsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): CourseInvitation[] {
  return db
    .select()
    .from(courseInvitations)
    .where(
      and(
        eq(courseInvitations.organizationId, organizationId),
        eq(courseInvitations.courseId, courseId),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt)
      )
    )
    .orderBy(asc(courseInvitations.createdAt), asc(courseInvitations.email))
    .all()
}

/** One open invitation by id, for the action layer to resolve before removing it. `undefined` when absent, foreign (TEN-5), accepted or already removed. */
export function getOpenInvitation(
  organizationId: string,
  invitationId: string,
  db: Database
): CourseInvitation | undefined {
  return db
    .select()
    .from(courseInvitations)
    .where(
      and(
        eq(courseInvitations.id, invitationId),
        eq(courseInvitations.organizationId, organizationId),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt)
      )
    )
    .get()
}

/**
 * WEB-82: remove an open invitation — the way to correct a mistyped address.
 * `undefined` when it does not exist in `organizationId` or is no longer open
 * (accepted or already removed), the same "not found" a foreign id gets
 * (TEN-5).
 */
export function revokeInvitation(
  organizationId: string,
  invitationId: string,
  accountId: string,
  db: Database
): CourseInvitation | undefined {
  return db
    .update(courseInvitations)
    .set({ revokedAt: Date.now(), revokedByAccountId: accountId })
    .where(
      and(
        eq(courseInvitations.id, invitationId),
        eq(courseInvitations.organizationId, organizationId),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt)
      )
    )
    .returning()
    .get()
}

/**
 * ROST-21: accept every open invitation addressed to `accountId`'s email.
 * The caller must have just established that the account proved its address
 * (a signed-in session, AUTH-1/AUTH-2), or be an import that found the account
 * by that address; this function does not re-check proof.
 *
 * Each invitation is handled inside its own organization, in its own
 * savepoint, and never throws on one bad invitation: a failure rolls that one
 * back, leaves it open for the next sign-in, and the rest still run. That
 * matters because sign-in calls this inside its own transaction and a claim
 * must never block signing in.
 *
 * Per invitation: find or create the account's connected web person
 * (shared with join links — a removed student gets no second person);
 * `refused_ended` when the person (or the address's earlier person) had an
 * enrolment ended (ENRL-6 — an invitation never revives one);
 * `already_enrolled` when already active; otherwise enrol with source
 * `'roster'`. The roster's names then overwrite the person's (ROST-18) and
 * its email fills only an empty field.
 *
 * Skips a soft-deleted course or project, and an account that is missing or
 * deleted.
 */
export function claimInvitationsForAccount(
  accountId: string,
  db: TransactingExecutor,
  options: ClaimOptions = {}
): ClaimedInvitation[] {
  const account = getAccountById(accountId, db)
  if (!account) return []

  const open = db
    .select({ invitation: courseInvitations })
    .from(courseInvitations)
    .innerJoin(courses, eq(courses.id, courseInvitations.courseId))
    .innerJoin(projects, eq(projects.id, courses.projectId))
    .where(
      and(
        eq(courseInvitations.email, account.email.toLowerCase()),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt),
        isNull(courses.deletedAt),
        isNull(projects.deletedAt),
        // TEN-2: an import claims only inside the organization (and course)
        // it ran for; sign-in leaves both unset and claims everything.
        ...(options.organizationId !== undefined
          ? [eq(courseInvitations.organizationId, options.organizationId)]
          : []),
        ...(options.courseId !== undefined
          ? [eq(courseInvitations.courseId, options.courseId)]
          : [])
      )
    )
    .orderBy(asc(courseInvitations.createdAt))
    .all()

  const claimed: ClaimedInvitation[] = []
  for (const { invitation } of open) {
    try {
      claimed.push(
        writeTransaction(db, (tx) => claimOne(invitation, accountId, tx))
      )
    } catch (error) {
      // Left open: a later sign-in or import retries it. Taken by someone
      // else meanwhile is routine and not worth a log line.
      if (!(error instanceof InvitationNoLongerOpenError)) {
        options.onError?.(error, {
          invitationId: invitation.id,
          organizationId: invitation.organizationId,
          courseId: invitation.courseId,
        })
      }
    }
  }
  return claimed
}

/** Thrown inside a claim's savepoint to roll it back when the invitation was accepted or removed in the meantime. */
class InvitationNoLongerOpenError extends Error {}

/**
 * ROST-21: an enrolment the earlier discord-off roster path made for a
 * placeholder person (identified only by a synthetic `handle:` Discord
 * identity, never connected to anyone) can never be used by the student who
 * signs in, so it is ended when the real person is enrolled in the same
 * course. A person with any other identity, or ever connected, is left alone.
 */
function endPlaceholderEnrolments(
  organizationId: string,
  courseId: string,
  email: string,
  keepPersonId: string,
  tx: TransactingExecutor
): void {
  for (const match of findPeopleByEmail(organizationId, email, tx)) {
    if (match.id === keepPersonId || match.connectedAt !== null) continue
    const identities = tx
      .select()
      .from(personIdentities)
      .where(
        and(
          eq(personIdentities.organizationId, organizationId),
          eq(personIdentities.personId, match.id)
        )
      )
      .all()
    const isPlaceholder =
      identities.length > 0 &&
      identities.every(
        (identity) =>
          identity.surface === 'discord' &&
          identity.externalId.startsWith('handle:')
      )
    if (!isPlaceholder) continue
    const enrolment = enrolments.getActiveEnrolment(
      organizationId,
      courseId,
      match.id,
      tx
    )
    if (enrolment?.source === 'roster') {
      enrolments.endEnrolment(organizationId, enrolment.id, tx)
    }
  }
}

/** One invitation's claim; throws on anything unexpected so its savepoint rolls back. */
function claimOne(
  invitation: CourseInvitation,
  accountId: string,
  tx: TransactingExecutor
): ClaimedInvitation {
  const { organizationId, courseId } = invitation
  const resolved = findOrCreateWebPersonForAccount(
    organizationId,
    courseId,
    accountId,
    tx
  )
  const person = resolved?.person

  let outcome: CourseInvitationOutcome
  if (!person) {
    outcome = 'refused_ended'
  } else if (
    enrolments.getActiveEnrolment(organizationId, courseId, person.id, tx)
  ) {
    outcome = 'already_enrolled'
  } else if (
    enrolments.hasEndedEnrolment(organizationId, courseId, person.id, tx)
  ) {
    outcome = 'refused_ended'
  } else {
    if (
      !enrolments.enrolViaRoster(
        organizationId,
        { courseId, personId: person.id },
        tx
      )
    ) {
      throw new Error(
        `claimInvitationsForAccount: enrolViaRoster refused for invitation ${invitation.id}`
      )
    }
    outcome = 'enrolled'
    // A newly made person may stand in for a placeholder an older roster
    // import enrolled for this same address (see the helper).
    if (resolved?.created) {
      endPlaceholderEnrolments(
        organizationId,
        courseId,
        invitation.email,
        person.id,
        tx
      )
    }
  }

  // Names and email go onto the person only when the roster's enrolment
  // stands; a removed student's person is left alone.
  if (person && outcome !== 'refused_ended') {
    const names: { firstName?: string; lastName?: string } = {}
    if (invitation.firstName) names.firstName = invitation.firstName
    if (invitation.lastName) names.lastName = invitation.lastName
    if (Object.keys(names).length > 0) {
      overwriteRosterFields(organizationId, person.id, names, tx)
    }
    mergeRosterFields(
      organizationId,
      person.id,
      { email: invitation.email },
      tx
    )
  }

  // Only an invitation still open may be accepted; if it was accepted or
  // removed since it was read, undo everything above.
  const now = Date.now()
  const result = tx
    .update(courseInvitations)
    .set({
      acceptedAt: now,
      acceptedPersonId: person?.id ?? null,
      outcome,
      updatedAt: now,
    })
    .where(
      and(
        eq(courseInvitations.id, invitation.id),
        isNull(courseInvitations.acceptedAt),
        isNull(courseInvitations.revokedAt)
      )
    )
    .run()
  if (result.changes === 0) throw new InvitationNoLongerOpenError()

  return {
    invitationId: invitation.id,
    organizationId,
    courseId,
    email: invitation.email,
    ...(person ? { personId: person.id } : {}),
    outcome,
  }
}
