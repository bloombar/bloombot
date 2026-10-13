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

import type { Database, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import { getAccountById } from './accounts.js'
import { getCourse } from './courses.js'
import * as enrolments from './enrolments.js'
import { mergeRosterFields, overwriteRosterFields } from './people.js'
import { findOrCreateWebPersonForAccount } from './web-person.js'
import {
  courseInvitations,
  courses,
  projects,
  type CourseInvitationOutcome,
} from '../schema.js'

export type CourseInvitation = typeof courseInvitations.$inferSelect

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
  db: TransactingExecutor
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
        isNull(projects.deletedAt)
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
    } catch {
      // Left open: a later sign-in or import retries it.
    }
  }
  return claimed
}

/** One invitation's claim; throws on anything unexpected so its savepoint rolls back. */
function claimOne(
  invitation: CourseInvitation,
  accountId: string,
  tx: TransactingExecutor
): ClaimedInvitation {
  const { organizationId, courseId } = invitation
  const person = findOrCreateWebPersonForAccount(
    organizationId,
    courseId,
    accountId,
    tx
  )

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

  tx.update(courseInvitations)
    .set({
      acceptedAt: Date.now(),
      acceptedPersonId: person?.id ?? null,
      outcome,
      updatedAt: Date.now(),
    })
    .where(eq(courseInvitations.id, invitation.id))
    .run()

  return {
    invitationId: invitation.id,
    organizationId,
    courseId,
    email: invitation.email,
    ...(person ? { personId: person.id } : {}),
    outcome,
  }
}
