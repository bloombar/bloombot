/**
 * Actions over `packages/db`'s `course-join-links` repo (ENRL-3, ENRL-4,
 * ENRL-12): `courseJoinLinks.create`, `.revoke` and `.reveal`, dispatched
 * the ordinary way — and `redeemCourseJoinLink`, which is *not* a dispatched
 * `Action` at all.
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
 *
 * ENRL-12 — `courseJoinLinks.create` and `.reveal` are both built by a
 * factory (`createCourseJoinLinkAction`/`createRevealCourseJoinLinkAction`)
 * taking an optional AES-256-GCM key, the same "a dependency this package
 * cannot construct for itself" shape `course-attachments.ts`'s own
 * `createAttachCourseAttachmentAction` already takes an `AttachmentStorage`
 * for: this package holds no dependency on `@bloombot/config` at all
 * (`actions/index.ts`'s own module comment), so the key — a credential,
 * CFG-5, read directly by `apps/api`'s own `main()` and never through that
 * package's schema — has nowhere to come from except an explicit argument.
 * `createPlatformRegistry` (`actions/index.ts`) is the one place that reads
 * a real key and passes it in; a test that does not care about ENRL-12
 * calls either factory with none, which reproduces exactly this platform's
 * "no key configured" behaviour (this file's own `encryptSecret`/
 * `decryptSecret` doc comments).
 */

import { courseJoinLinks, courses, type Database } from '@bloombot/db'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
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

// ENRL-12 — the standard 96-bit GCM nonce length (NIST SP 800-38D): the
// length every mainstream GCM implementation defaults to and optimizes for.
const GCM_NONCE_BYTES = 12

/** The AES-256-GCM encryption of `secret` under `key`, as three base64 strings — the exact shape `repos/course-join-links.ts#NewCourseJoinLink`'s own `secretCiphertext`/`secretNonce`/`secretAuthTag` store verbatim. A fresh, random nonce every call, never a caller-supplied one: reusing a nonce under the same key breaks AES-GCM's confidentiality guarantee outright, so there is no parameter here to reuse one by mistake. */
function encryptSecret(
  secret: string,
  key: Buffer
): { ciphertext: string; nonce: string; authTag: string } {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ])
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

/**
 * The inverse of `encryptSecret` — throws rather than returning anything if
 * `key` does not match the one `ciphertext` was encrypted under, or if any
 * of the three parts was altered after encryption: `decipher.final()` runs
 * AES-GCM's own authentication check before it ever returns a byte of
 * plaintext, so a tampered ciphertext is *rejected*, never silently
 * decrypted into garbage — the property authenticated encryption exists to
 * give, unlike a cipher mode with no integrity check of its own (this
 * file's own module comment on why GCM, not a bare block cipher mode, was
 * the point of using `node:crypto` here at all). Every caller in this file
 * treats that throw exactly like "this link cannot be revealed" — see
 * `createRevealCourseJoinLinkAction`, below.
 */
function decryptSecret(
  ciphertext: string,
  nonce: string,
  authTag: string,
  key: Buffer
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(nonce, 'base64')
  )
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
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
 * and stores its hash (`repos/course-join-links.ts`) — the same "returned
 * once, stored only as a hash" shape `sign_in_tokens` already uses for
 * AUTH-1.
 *
 * ENRL-12 — a factory, not a plain object (this file's own module comment
 * on why): `encryptionKey`, when supplied, also stores an AES-256-GCM
 * encryption of the same secret (`encryptSecret`, above), so an instructor
 * can ask to see it again later (`createRevealCourseJoinLinkAction`,
 * below). Omitted — the "no key configured" deployment-compatibility
 * promise — stores `null` for all three of `secretCiphertext`/
 * `secretNonce`/`secretAuthTag`, exactly what a database migrated from
 * before this shipped already has for every existing row: creation and the
 * one-time reveal in this response are unaffected either way, the only
 * difference is whether the secret can ever be shown again later.
 */
export function createCourseJoinLinkAction(
  encryptionKey?: Buffer
): Action<
  'courseJoinLinks.create',
  CreateInput,
  Course,
  CreatedCourseJoinLink
> {
  return {
    name: 'courseJoinLinks.create',
    description:
      'Create a course join link (ENRL-3): returns the secret to share with students exactly once. Stored as a hash for redemption, and — when the deployment has an encryption key configured (ENRL-12) — also encrypted, so an instructor may ask to see it again later via courseJoinLinks.reveal.',
    inputSchema: createInputSchema,
    policy: {
      descriptor: { resource: 'course', access: 'write' },
      resolve: (input, context) =>
        courses.getCourse(context.organizationId, input.courseId, context.db),
    },
    execute: ({ organizationId, input, entity, accountId, db }) => {
      const createdByAccountId = requireAccountId(accountId)
      const secret = generateSecret()
      const encrypted = encryptionKey
        ? encryptSecret(secret, encryptionKey)
        : undefined

      const link = courseJoinLinks.createJoinLink(
        organizationId,
        {
          courseId: entity.id,
          secretHash: hashSecret(secret),
          secretCiphertext: encrypted?.ciphertext ?? null,
          secretNonce: encrypted?.nonce ?? null,
          secretAuthTag: encrypted?.authTag ?? null,
          expiresAt: input.expiresAt ?? null,
          createdByAccountId,
        },
        db
      )

      return { linkId: link.id, secret, expiresAt: link.expiresAt }
    },
  }
}

const listInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListInput = z.infer<typeof listInputSchema>

/**
 * WEB-20: what a course's join links look like once they leave this
 * package — deliberately narrower than `repos/course-join-links.ts`'s own
 * `CourseJoinLink` row, the same "never mirror a sensitive or irrelevant
 * column just because the row happens to carry it" discipline
 * `CourseAttachmentSummary` (`apps/web/src/api/types.ts`) already applies to
 * `providerFileId`/`vectorStoreId`. Here the omission is load-bearing, not
 * merely tidy: `secretHash` is what redeems a link (`redeemJoinLink`'s own
 * `findLiveJoinLinkByHash`), so a response that included it would hand a
 * browser everything it needs to mint working join URLs for every link a
 * course has ever issued, not only the one just created. `organizationId`
 * is also left out — implied by which organization the caller dispatched
 * this action in, and never needed by the panel's own list.
 *
 * `revealable` (ENRL-12) is capability metadata, not secret material — it
 * says nothing a caller could not already infer by attempting
 * `courseJoinLinks.reveal` and reading whether it refused, so listing it
 * here carries none of the risk `secretHash`'s own omission (above) guards
 * against; it exists so `apps/web`'s own panel can decide whether to offer
 * a reveal control *without* offering one that is certain to fail. Computed
 * from `secretCiphertext` alone (`Boolean(link.secretCiphertext)`), not from
 * whether a key is configured *right now* — the two agree in the ordinary,
 * non-rotating-key deployment this platform assumes (rotation is explicitly
 * out of scope, `docs/DECISIONS.md` D-74's own "Out of scope"), and would
 * only disagree if an operator configured a key, encrypted some links under
 * it, and later removed the key — a real gap, but the same one `reveal`
 * itself has (D-74's own "Limits"), not a new one this field introduces.
 */
export interface CourseJoinLinkSummary {
  id: string
  courseId: string
  expiresAt: number | null
  revokedAt: number | null
  createdByAccountId: string
  createdAt: number
  revealable: boolean
}

function toSummary(link: JoinLink): CourseJoinLinkSummary {
  return {
    id: link.id,
    courseId: link.courseId,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    createdByAccountId: link.createdByAccountId,
    createdAt: link.createdAt,
    revealable: Boolean(link.secretCiphertext),
  }
}

/**
 * WEB-20: list a course's join links, newest first — what the panel's own
 * "join links" screen reads. Projected through `toSummary` (above) before
 * this action returns at all, so the exclusion of `secretHash` is this
 * function's own guarantee, not something a caller has to remember to
 * apply on the way out.
 */
export const listCourseJoinLinksAction: Action<
  'courseJoinLinks.list',
  ListInput,
  Course,
  CourseJoinLinkSummary[]
> = {
  name: 'courseJoinLinks.list',
  description:
    "List a course's join links (ENRL-3, WEB-20): id, expiry and revoked state for each — never the secret, which only ever existed at creation.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courseJoinLinks.listJoinLinks(organizationId, entity.id, db).map(toSummary),
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

const revealInputSchema = z.object({
  linkId: z.string().min(1),
})
type RevealInput = z.infer<typeof revealInputSchema>

/** `courseJoinLinks.reveal` hands back the plaintext secret it just decrypted, and nothing else — never the ciphertext, the nonce or the tag, none of which a caller has any use for. */
export interface RevealedCourseJoinLink {
  secret: string
}

/**
 * ENRL-12: show a live link's secret again. Its own policy is exactly
 * `courseJoinLinks.revoke`'s (above) — same descriptor, same `resolve` —
 * rather than something new: the requirement names "the instructors of its
 * own organization" as who may reveal, and `.revoke` is already the gate
 * this codebase gives that phrase for a course join link (any member of the
 * organization the link's course belongs to — owner, instructor or
 * assistant, un-role-differentiated; `dispatch.ts`'s own `routes/actions.ts`
 * caller already proved *that* much before `execute` here ever runs).
 * Reusing the identical policy object, not merely an equivalent-looking
 * one, is what keeps the two gates from drifting apart under a future edit
 * to either action alone.
 *
 * Settled, not merely carried over: `.create`/`.list`/`.revoke` were
 * already un-role-differentiated before this action existed, so narrowing
 * `.reveal` alone to `owner`/`instructor` would build a boundary a caller
 * already inside this action's own trust perimeter could walk straight
 * around — anyone who may `.revoke` a link may also `.create` a fresh one
 * and read its secret from the response the moment it is issued, so
 * refusing that same caller `.reveal` on the *original* link protects
 * nothing a revoke-and-reissue does not already defeat. If a future
 * requirement narrows the other three to `owner`/`instructor`, `.reveal`
 * should follow through this shared policy object, with no separate edit
 * needed here. See `docs/DECISIONS.md` D-74 for the fuller record.
 *
 * A factory, the same reason `.create` (above) is one: decrypting needs the
 * key `.create` encrypted under, and this package has no way to reach for
 * one itself (this file's own module comment).
 *
 * Refuses — `ActionRefusedError`, ACT-3's single, byte-identical shape,
 * indistinguishable from a plain not-found — on every one of these, and
 * never says which: no key configured at all (this deployment's own
 * "reveal is refused" promise, this file's own module comment on `.create`);
 * the link is revoked or has expired ("no reason to hand back a secret that
 * admits nobody," ENRL-12's own text); the link carries no ciphertext at
 * all (a row from before this shipped, or one created while no key was
 * configured); or decryption itself throws (`decryptSecret`'s own doc
 * comment — a wrong key or a tampered ciphertext, indistinguishable from
 * each other and from every other refusal here on purpose, the same
 * "carries nothing about the record it protected" discipline
 * `ActionRefusedError`'s own doc comment already holds every other refusal
 * in this package to).
 */
export function createRevealCourseJoinLinkAction(
  encryptionKey?: Buffer
): Action<
  'courseJoinLinks.reveal',
  RevealInput,
  JoinLink,
  RevealedCourseJoinLink
> {
  return {
    name: 'courseJoinLinks.reveal',
    description:
      "Show a live course join link's secret again (ENRL-12): refuses for a revoked or expired link, for a link with nothing encrypted to show (created before this shipped, or while no key was configured), or when this deployment has no encryption key configured at all.",
    inputSchema: revealInputSchema,
    policy: revokeCourseJoinLinkAction.policy,
    execute: ({ entity }) => {
      if (!encryptionKey) throw new ActionRefusedError()
      const isLive =
        !entity.revokedAt &&
        (entity.expiresAt === null || entity.expiresAt > Date.now())
      if (!isLive) throw new ActionRefusedError()
      if (
        !entity.secretCiphertext ||
        !entity.secretNonce ||
        !entity.secretAuthTag
      ) {
        throw new ActionRefusedError()
      }

      let secret: string
      try {
        secret = decryptSecret(
          entity.secretCiphertext,
          entity.secretNonce,
          entity.secretAuthTag,
          encryptionKey
        )
      } catch {
        // A wrong key or a tampered ciphertext — `decryptSecret`'s own doc
        // comment. Never rethrown as-is: the underlying `Error` carries no
        // plaintext, but folding it into the same refusal every other
        // branch here throws keeps this action's own promise that nothing
        // it throws ever distinguishes *why*.
        throw new ActionRefusedError()
      }
      return { secret }
    },
  }
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
