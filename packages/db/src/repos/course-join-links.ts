/**
 * Repository for `course_join_links` (ENRL-3, ENRL-4).
 *
 * `createJoinLink` and `revokeJoinLink` are scoped by `organizationId`, its
 * first parameter, the same as every other function in this package.
 * `redeemJoinLink` is the one documented exception: the same class
 * `sign-in-tokens.ts`'s own module comment describes for `consumeSignInToken`
 * — a redeemer presents only the secret, not an organization id, so there is
 * nothing to scope the lookup by until the hash itself resolves one.
 *
 * Every function here operates on the link's *hash*. The plaintext secret is
 * generated and returned to the caller exactly once, by `@bloombot/actions`'
 * `course-join-links.ts` — this file never sees it and never writes it.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm'

import type { Database } from '../client.js'
import * as enrolments from './enrolments.js'
import { getPerson } from './people.js'
import { courseJoinLinks } from '../schema.js'

export type CourseJoinLink = typeof courseJoinLinks.$inferSelect

/** Fields the caller supplies when issuing a join link. */
export interface NewCourseJoinLink {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  courseId: string
  /** SHA-256 hash of the secret; see `@bloombot/actions`' `course-join-links.ts`. */
  secretHash: string
  /** `null`/omitted: no expiry, valid until revoked. */
  expiresAt?: number | null
  createdByAccountId: string
}

/** Issue (insert) a new join link row. */
export function createJoinLink(
  organizationId: string,
  input: NewCourseJoinLink,
  db: Database
): CourseJoinLink {
  return db
    .insert(courseJoinLinks)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      courseId: input.courseId,
      secretHash: input.secretHash,
      expiresAt: input.expiresAt ?? null,
      createdByAccountId: input.createdByAccountId,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** One join link by id, scoped to `organizationId` — for `@bloombot/actions`' `courseJoinLinks.revoke` policy to resolve before revoking it. */
export function getJoinLink(
  organizationId: string,
  linkId: string,
  db: Database
): CourseJoinLink | undefined {
  return db
    .select()
    .from(courseJoinLinks)
    .where(
      and(
        eq(courseJoinLinks.id, linkId),
        eq(courseJoinLinks.organizationId, organizationId)
      )
    )
    .get()
}

/**
 * ENRL-4: revoke a link — stops it admitting anyone new; never un-enrols
 * anybody already admitted through it, because this file (and
 * `repos/enrolments.ts`, which it calls into) has no function that reads
 * `course_join_links` back out of an existing enrolment at all — there is
 * nothing here *to* cascade. Returns the number of rows changed: `0` for a
 * link that does not exist, belongs to a different organization (TEN-5), or
 * is already revoked.
 */
export function revokeJoinLink(
  organizationId: string,
  linkId: string,
  db: Database
): number {
  const result = db
    .update(courseJoinLinks)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(courseJoinLinks.id, linkId),
        eq(courseJoinLinks.organizationId, organizationId),
        isNull(courseJoinLinks.revokedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * ENRL-3/ENRL-4: redeem a link by its hash — enrols `personId` in the
 * course it names, or refuses. Refuses identically (`undefined`) for a hash
 * that was never issued, one that is revoked, and one that has expired
 * (ENRL-4), the same "no oracle" shape `sign-in-tokens.ts#consumeSignInToken`
 * already gives AUTH-1. Also refuses when `personId` does not belong to the
 * link's own organization (TEN-5) — a caller cannot use somebody else's link
 * to enrol a person from a different tenant.
 *
 * Not wrapped as an `@bloombot/actions` `Action`: dispatch requires an
 * organization id *before* it runs a single line of an action (`DispatchContext`),
 * and a redeemer has not proven one — the same reason `consumeSignInToken`
 * itself is a plain function `@bloombot/auth`'s `sign-in.ts` composes,
 * never a dispatched action. See `docs/DECISIONS.md`.
 */
export function redeemJoinLink(
  secretHash: string,
  personId: string,
  now: number,
  db: Database
): enrolments.Enrolment | undefined {
  const link = db
    .select()
    .from(courseJoinLinks)
    .where(
      and(
        eq(courseJoinLinks.secretHash, secretHash),
        isNull(courseJoinLinks.revokedAt),
        or(
          isNull(courseJoinLinks.expiresAt),
          gt(courseJoinLinks.expiresAt, now)
        )
      )
    )
    .get()
  if (!link) return undefined

  const person = getPerson(link.organizationId, personId, db)
  if (!person) return undefined

  return enrolments.enrolViaJoinLink(
    link.organizationId,
    { courseId: link.courseId, personId },
    db
  )
}
