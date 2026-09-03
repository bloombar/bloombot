/**
 * Repository for `course_join_links` (ENRL-3, ENRL-4, ENRL-8).
 *
 * `createJoinLink` and `revokeJoinLink` are scoped by `organizationId`, its
 * first parameter, the same as every other function in this package.
 * `redeemJoinLink` and `redeemJoinLinkForWebAccount` are the two documented
 * exceptions: the same class `sign-in-tokens.ts`'s own module comment
 * describes for `consumeSignInToken` — a redeemer presents only the secret,
 * not an organization id, so there is nothing to scope the lookup by until
 * the hash itself resolves one.
 *
 * Every function here operates on the link's *hash*. The plaintext secret is
 * generated and returned to the caller exactly once, by `@bloombot/actions`'
 * `course-join-links.ts` — this file never sees it and never writes it.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm'

import type { Database, TransactingExecutor } from '../client.js'
import * as enrolments from './enrolments.js'
import {
  connectIdentity,
  createPerson,
  getPerson,
  resolveIdentity,
} from './people.js'
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
 * The one query both redemption entry points below run first: a link that is
 * live by its hash (not revoked, not expired) — never issued, revoked and
 * expired all fall through this same single `WHERE`, so a caller cannot time
 * or otherwise distinguish the three from which branch ran (`redeemJoinLink`'s
 * own "no oracle" shape, below). Module-private: nothing outside this file
 * has a reason to see a link before deciding who it is being redeemed for.
 */
function findLiveJoinLinkByHash(
  secretHash: string,
  now: number,
  tx: TransactingExecutor
): CourseJoinLink | undefined {
  return tx
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
}

/**
 * ENRL-3/ENRL-4: redeem a link by its hash — enrols `callerAssertedPersonId`
 * in the course it names, or refuses. Refuses identically (`undefined`) for
 * a hash that was never issued, one that is revoked, and one that has
 * expired (ENRL-4), the same "no oracle" shape
 * `sign-in-tokens.ts#consumeSignInToken` already gives AUTH-1. Also refuses
 * when `callerAssertedPersonId` does not belong to the link's own
 * organization (TEN-5) — a caller cannot use somebody else's link to enrol a
 * person from a different tenant.
 *
 * Rework finding 4 — read the parameter's own name before wiring a caller to
 * this function. `callerAssertedPersonId` is proved only to belong to the
 * link's organization; it is never proof that the caller redeeming this link
 * *is* that person, or was authorized by them. A join link is deliberately
 * shareable with an entire class (ENRL-3 — "a course join link an
 * instructor issues, a student redeems"), so nothing about presenting the
 * *secret* proves who is presenting it, the way `consumeSignInToken`'s own
 * token proves an email address because only that address was ever mailed
 * it. The obvious next-slice wiring — `POST /join { secret, personId }`,
 * with `personId` taken straight from the request body — would let any
 * student holding the secret (everybody it was shared with) enrol *anybody*
 * in the tenant, not just themselves. Binding `callerAssertedPersonId` to
 * the caller's own, already-authenticated identity (a signed-in web
 * account's own person, or the Discord identity a bot-side redemption
 * already resolved from the message itself) is that future caller's own
 * obligation — this function has no way to check it from the two arguments
 * it is given. See `docs/DECISIONS.md` D-34's own Limits, which names this
 * explicitly. ENRL-8's own `redeemJoinLinkForWebAccount` (below) is that
 * next-slice caller for the web surface — it binds to a signed-in account's
 * own identity rather than trusting a body-supplied `personId`; a future
 * Discord-side redemption would call this function directly with the
 * identity it already resolved from the message itself.
 *
 * Rework finding 6 — atomic. All three statements below (the link's own
 * liveness check, the person lookup, and the enrolment write inside
 * `enrolViaJoinLink`) run in one `db.transaction(...)`, the same "narrow the
 * race, don't just document it" discipline `courses.ts#createCourse` already
 * holds its own PROJ-3 check to. Before this, they ran as three separate
 * statements: `courseJoinLinks.revoke` (a different connection, or a
 * concurrent call on this one) could commit *between* the first read here
 * and the enrolment write, and this function would still admit the redeemer
 * — a revoke that returned `{ revoked: true }` would not actually be true
 * yet for whoever was already mid-redemption. Wrapping the three closes that
 * window: SQLite's own write-transaction isolation (`client.ts`'s WAL mode)
 * refuses to let this transaction's later write land against a snapshot a
 * concurrent revoke has since invalidated, rather than silently completing
 * against data that was true when read but is not true anymore.
 *
 * Not wrapped as an `@bloombot/actions` `Action`: dispatch requires an
 * organization id *before* it runs a single line of an action (`DispatchContext`),
 * and a redeemer has not proven one — the same reason `consumeSignInToken`
 * itself is a plain function `@bloombot/auth`'s `sign-in.ts` composes,
 * never a dispatched action. See `docs/DECISIONS.md`.
 */
export function redeemJoinLink(
  secretHash: string,
  callerAssertedPersonId: string,
  now: number,
  db: Database
): enrolments.Enrolment | undefined {
  return db.transaction((tx) => {
    const link = findLiveJoinLinkByHash(secretHash, now, tx)
    if (!link) return undefined

    const person = getPerson(link.organizationId, callerAssertedPersonId, tx)
    if (!person) return undefined

    return enrolments.enrolViaJoinLink(
      link.organizationId,
      { courseId: link.courseId, personId: callerAssertedPersonId },
      tx
    )
  })
}

/**
 * ENRL-8: redeem a link for a signed-in *web* account, rather than an
 * already-resolved person id — `apps/api`'s own join-link route is the one
 * caller (this file's own module comment on why `redeemJoinLink` above is
 * scoped by hash, not organization, applies here identically). The
 * distinction from `redeemJoinLink` is what it does about a caller with no
 * person in the link's own organization yet: rather than refusing
 * (`redeemJoinLink`'s own `getPerson` — a foreign or absent id, TEN-5's
 * "indistinguishable from absence"), it creates one and connects it through
 * the real `people.ts#connectIdentity` path, `{ surface: 'web', externalId:
 * accountId }` — the identical create-then-connect sequence
 * `@bloombot/auth`'s `sign-in.ts#createConnectedWebPerson`/`ensureWebPersonForAccount`
 * already run for an account's own personal organization, inlined here
 * rather than imported: `@bloombot/auth` depends on this package, so this
 * package cannot depend back on it, and `docs/DECISIONS.md`'s D-34 already
 * chose the identical trade for this same file's own `hashSecret` (a small,
 * deliberately duplicated handful of lines over a new cross-package
 * dependency) — see `docs/DECISIONS.md` for this slice's own record of the
 * choice.
 *
 * Never a raw `connectedAt` write — `connectIdentity` is the one function in
 * this package that sets it, the same "real, merged path, not a shortcut"
 * every other connecting caller in this codebase already holds itself to
 * (LINK-3).
 *
 * Atomic, the same as `redeemJoinLink` (that function's own rework finding
 * 6): the link's liveness check, the person resolve-or-create, and the
 * enrolment write all run inside one `db.transaction(...)`, so a concurrent
 * revoke cannot land between "a person now exists for this account in this
 * organization" and "that person is enrolled" — and, just as importantly,
 * the liveness check itself is the exact same query `findLiveJoinLinkByHash`
 * runs for `redeemJoinLink`, so a never-issued, a revoked and an expired
 * secret all still return `undefined` from the identical point, before any
 * of this function's own extra work (the person resolve-or-create) ever
 * runs — nothing here adds a timing or a side-effect difference to the
 * refusal path `redeemJoinLink` already guarantees is indistinguishable
 * three ways.
 *
 * `connectIdentity` requires `TransactingExecutor`, not merely `Executor`,
 * and opens its own nested transaction (a savepoint, `client.ts`'s own
 * `TransactingExecutor` doc comment) when called with a `tx` that is already
 * inside one — exactly this function's own case.
 */
export function redeemJoinLinkForWebAccount(
  secretHash: string,
  accountId: string,
  now: number,
  db: Database
): enrolments.Enrolment | undefined {
  return db.transaction((tx) => {
    const link = findLiveJoinLinkByHash(secretHash, now, tx)
    if (!link) return undefined

    const identity = { surface: 'web' as const, externalId: accountId }
    let person = resolveIdentity(link.organizationId, identity, tx)
    if (!person) {
      const created = createPerson(link.organizationId, {}, tx)
      // `connectIdentity` refuses (`undefined`) on exactly three conditions
      // (its own doc comment): `personId` foreign or absent, already merged
      // away, or the identity already belonging to a *different* person —
      // none can fire here, the same reasoning
      // `createConnectedWebPerson`'s own comment gives for its identical
      // shape: `link.organizationId` and `created.id` were both just used
      // or minted in this same transaction, and this exact `identity` cannot
      // already belong to anyone else, since `resolveIdentity` just found
      // nobody holding it a moment ago, inside the same transaction.
      const connected = connectIdentity(
        link.organizationId,
        created.id,
        identity,
        tx
      )
      if (!connected) {
        throw new Error(
          `redeemJoinLinkForWebAccount: connectIdentity refused for a person (${created.id}) and organization (${link.organizationId}) this function just created — should be unreachable`
        )
      }
      // `created` (above) predates `connectIdentity`'s own write —
      // `connectedAt` on it is still `null`. Re-read so `enrolViaJoinLink`
      // below (and this function's own caller) sees the row as it actually
      // stands.
      person = getPerson(link.organizationId, created.id, tx) ?? created
    }

    return enrolments.enrolViaJoinLink(
      link.organizationId,
      { courseId: link.courseId, personId: person.id },
      tx
    )
  })
}
