/**
 * Actions over `packages/db`'s `course-join-links` repo (ENRL-3, ENRL-4):
 * `courseJoinLinks.create` and `.revoke`, dispatched the ordinary way — and
 * `redeemCourseJoinLink`, which is *not* a dispatched `Action` at all.
 *
 * A redeemer presents only the secret from the link they were given, not an
 * organization id — `dispatch.ts`'s own `DispatchContext.organizationId` has
 * to be known before a single line of an action runs, which begs the
 * question redemption exists to answer. `@bloombot/auth`'s
 * `consumeSignInToken` is the same shape for the same reason (AUTH-1): a
 * plain function `sign-in.ts` composes, never a dispatched action. See
 * `docs/DECISIONS.md`.
 *
 * `generateSecret`/`hashSecret` below are a small, deliberate duplicate of
 * `@bloombot/auth`'s `secrets.ts` (SHA-256 over `node:crypto`'s CSPRNG, no
 * salt, no slow KDF — that file's own module comment has the reasoning),
 * not an import: this package has no dependency on `@bloombot/auth` today,
 * and a join link's secret has nothing to do with signing in — the same
 * "two handlers, not a shared library either owns" reasoning
 * `apps/worker`'s `roster-import.ts` already gives for its own duplicated
 * `normalizeName`/`normalizeChannelName`.
 */

import { courseJoinLinks, courses, type Database } from '@bloombot/db'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type JoinLink = NonNullable<ReturnType<typeof courseJoinLinks.getJoinLink>>

const SECRET_BYTES = 32

/** A new high-entropy, URL-safe secret. Never stored; only `hashSecret(secret)` is. */
function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/** The SHA-256 hash of a secret, hex-encoded, for storage and lookup. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Both `.save` and `.restore`-style actions in this package refuse the same way when `dispatch` was not given an authenticated caller — the same helper `course-instructions.ts` already defines for itself (module-private, not shared: `docs/DECISIONS.md` has the reasoning for keeping small helpers like this un-shared). */
function requireAccountId(accountId: string | undefined): string {
  if (!accountId) throw new ActionRefusedError()
  return accountId
}

const createInputSchema = z.object({
  courseId: z.string().min(1),
  /**
   * Epoch milliseconds. Omitted or `null`: no expiry, valid until revoked
   * (ENRL-4). Rework finding 7: must be strictly in the future — a past
   * value would create a link that reports success but can never be
   * redeemed (`courseJoinLinks.redeemJoinLink`'s own expiry check refuses
   * anything at or before `now`), which is a confusing way to fail an
   * instructor never sees the reason for.
   */
  expiresAt: z
    .number()
    .int()
    .positive()
    .refine((value) => value > Date.now(), {
      message: 'expiresAt must be in the future',
    })
    .nullable()
    .optional(),
})
type CreateInput = z.infer<typeof createInputSchema>

/** What `courseJoinLinks.create` hands back — the plaintext secret, exactly once, never recoverable afterward. */
export interface CreatedCourseJoinLink {
  linkId: string
  /** Put this in the link a student redeems; never written to the database. */
  secret: string
  expiresAt: number | null
}

/**
 * ENRL-3/ENRL-4: issue a new join link for a course. Resolves the course
 * itself (scoped to the caller's organization, ACT-2), generates a secret,
 * and stores only its hash (`repos/course-join-links.ts`) — the same
 * "returned once, stored only as a hash" shape `sign_in_tokens` already
 * uses for AUTH-1.
 */
export const createCourseJoinLinkAction: Action<
  'courseJoinLinks.create',
  CreateInput,
  Course,
  CreatedCourseJoinLink
> = {
  name: 'courseJoinLinks.create',
  description:
    'Create a course join link (ENRL-3): returns the secret to share with students exactly once — the database only ever stores its hash.',
  inputSchema: createInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, accountId, db }) => {
    const createdByAccountId = requireAccountId(accountId)
    const secret = generateSecret()

    const link = courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: entity.id,
        secretHash: hashSecret(secret),
        expiresAt: input.expiresAt ?? null,
        createdByAccountId,
      },
      db
    )

    return { linkId: link.id, secret, expiresAt: link.expiresAt }
  },
}

const revokeInputSchema = z.object({
  linkId: z.string().min(1),
})
type RevokeInput = z.infer<typeof revokeInputSchema>

/**
 * ENRL-4: revoke a join link — stops it admitting anyone new; never
 * un-enrols anyone it already admitted (`repos/course-join-links.ts#revokeJoinLink`'s
 * own module comment).
 */
export const revokeCourseJoinLinkAction: Action<
  'courseJoinLinks.revoke',
  RevokeInput,
  JoinLink,
  { revoked: boolean }
> = {
  name: 'courseJoinLinks.revoke',
  description:
    'Revoke a course join link (ENRL-4): stops it admitting anyone new, without un-enrolling anyone it already admitted.',
  inputSchema: revokeInputSchema,
  policy: {
    descriptor: { resource: 'courseJoinLink', access: 'write' },
    resolve: (input, context) =>
      courseJoinLinks.getJoinLink(
        context.organizationId,
        input.linkId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    // Idempotent no-op on an already-revoked link, the same
    // "rows-changed is not state" treatment `courses.enable`/`.disable`
    // already give this shape (`actions/courses.ts`'s own comments) — the
    // policy already proved this link exists and belongs to this
    // organization, so there is no refusal case left here.
    courseJoinLinks.revokeJoinLink(organizationId, entity.id, db)
    return { revoked: true }
  },
}

/**
 * ENRL-3: redeem a join link — enrols `callerAssertedPersonId` in the course
 * it names, or refuses. Not a dispatched `Action`; see this file's own
 * module comment. `db` is a plain `Database`, not a `DispatchContext`, since
 * there is no organization to carry one with yet.
 *
 * Rework finding 4/5: exported from `@bloombot/actions`' own package root
 * (`src/index.ts`) — before this it was reachable only through
 * `./actions/index.js`, which `package.json`'s `exports` field does not
 * expose to a deep import, so no app could actually call it. And read
 * `callerAssertedPersonId`'s own name, and `repos/course-join-links.ts#redeemJoinLink`'s
 * doc comment, before wiring a caller to this: this function proves the
 * secret was issued and is still live, never that whoever is calling it *is*
 * the person named — see `docs/DECISIONS.md` D-34's own Limits.
 */
export function redeemCourseJoinLink(
  secret: string,
  callerAssertedPersonId: string,
  db: Database
) {
  return courseJoinLinks.redeemJoinLink(
    hashSecret(secret),
    callerAssertedPersonId,
    Date.now(),
    db
  )
}

/**
 * ENRL-8: redeem a join link for a signed-in *web* account — the composed
 * entry point `apps/api`'s own join-link route calls, the same way this
 * file's `redeemCourseJoinLink` (above) composes `hashSecret` with
 * `repos/course-join-links.ts#redeemJoinLink` for a caller that already has
 * a person id in hand. `accountId` comes from the caller's own
 * already-authenticated session — never a request body — the same
 * obligation `redeemCourseJoinLink`'s own doc comment states for
 * `callerAssertedPersonId`, except this one is impossible to get wrong from
 * the arguments alone: there is no person id parameter here for a caller to
 * mis-supply. See `repos/course-join-links.ts#redeemJoinLinkForWebAccount`
 * for what this does about an account with no person in the link's own
 * organization yet.
 */
export function redeemCourseJoinLinkForWebAccount(
  secret: string,
  accountId: string,
  db: Database
) {
  return courseJoinLinks.redeemJoinLinkForWebAccount(
    hashSecret(secret),
    accountId,
    Date.now(),
    db
  )
}
