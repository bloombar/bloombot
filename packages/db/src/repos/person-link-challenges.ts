/**
 * Repository for `person_link_challenges` (LINK-3).
 *
 * The storage half of connecting a second surface's proof: one row per
 * attempt, from `@bloombot/auth`'s `beginDiscordPersonLink`/
 * `issueMcpPersonLinkToken` generating a secret, to `consumeChallenge`
 * redeeming it exactly once — or `peekChallenge`, its read-only twin, for a
 * caller that wants to know what a challenge *would* connect without
 * spending it. Keyed on the secret's *hash* — the same class of exception
 * `discord-install-states.ts` documents for itself: a caller consuming this
 * (an OAuth callback, an MCP token redemption) carries only the secret
 * value, not an organization id, so this is one more "found before any
 * organization scoping applies" exception, allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly.
 *
 * `NewPersonLinkChallenge` is a discriminated union on `surface`, not one
 * shape with optional fields either way a caller could get wrong — see
 * `schema.ts#personLinkChallenges`'s own module comment (D-35 rework,
 * finding 3) for why `discord` and `mcp` bind opposite sides of the proof
 * at issue time, and why getting that backwards is an account takeover.
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { personLinkChallenges, type LinkProofSurface } from '../schema.js'

export type PersonLinkChallenge = typeof personLinkChallenges.$inferSelect
export type { LinkProofSurface }

/**
 * Fields the caller supplies when beginning a link attempt — a discriminated
 * union on `surface`, matching `schema.ts`'s own `CHECK
 * person_link_challenges_binding_shape_check`: a `discord` attempt binds the
 * survivor (`personId`, "the account being connected", D-28) and a PKCE
 * verifier; an `mcp` attempt binds the identity being connected
 * (`identityExternalId`) instead, since LINK-3's own token *is* the proof of
 * that identity, delivered to the unconnected caller before any survivor is
 * known.
 */
export type NewPersonLinkChallenge = {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  organizationId: string
  secretHash: string
  expiresAt: number
} & (
  | {
      surface: 'discord'
      personId: string
      /** PKCE verifier, plain text (D-21). */
      codeVerifier: string
    }
  | {
      surface: 'mcp'
      identityExternalId: string
    }
)

/** Begin (insert) a new link-challenge row. */
export function createChallenge(
  input: NewPersonLinkChallenge,
  db: Executor
): PersonLinkChallenge {
  return db
    .insert(personLinkChallenges)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      surface: input.surface,
      personId: input.surface === 'discord' ? input.personId : null,
      identityExternalId:
        input.surface === 'mcp' ? input.identityExternalId : null,
      codeVerifier: input.surface === 'discord' ? input.codeVerifier : null,
      secretHash: input.secretHash,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Redeem a challenge by its secret's hash *and* the surface it was issued
 * for: atomically marks it used and returns the row — the same single
 * conditional `UPDATE` `discord-install-states.ts#consumeInstallState`/
 * `sign-in-tokens.ts#consumeSignInToken` use, so two concurrent redemptions
 * of the same secret resolve to exactly one winner.
 *
 * `surface` is part of the `WHERE`, not a check run against the row
 * afterward (D-35 rework, finding 6): a hash alone could match a row issued
 * for the *other* surface — a Discord state presented to the MCP redemption
 * path, say — and checking `surface` only after the `UPDATE` had already
 * run would burn that row (mark it used) before rejecting it, destroying it
 * for its own, legitimate surface. Filtering by `surface` up front means a
 * mismatched presentation matches no row at all and leaves the real one
 * untouched.
 *
 * Returns `undefined` for a hash that was never issued, one issued for a
 * different surface, one already used, and one that has expired —
 * identically in all four cases (LINK-3's own "no oracle" guarantee, the
 * same one AUTH-1's token already gives).
 */
export function consumeChallenge(
  secretHash: string,
  surface: LinkProofSurface,
  now: number,
  db: Executor
): PersonLinkChallenge | undefined {
  return db
    .update(personLinkChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(personLinkChallenges.secretHash, secretHash),
        eq(personLinkChallenges.surface, surface),
        isNull(personLinkChallenges.usedAt),
        gt(personLinkChallenges.expiresAt, now)
      )
    )
    .returning()
    .get()
}

/**
 * The read-only twin of `consumeChallenge`: the same lookup (hash, surface,
 * unused, unexpired), but a plain `SELECT` — nothing is marked used, so the
 * secret stays valid for whichever caller runs the real `consumeChallenge`
 * afterward. Exists for LINK-3's own "the page names the account being
 * connected and waits to be told to proceed": a caller can preview what a
 * challenge would connect — see `@bloombot/auth`'s `person-link.ts#previewDiscordPersonLink`/
 * `#previewMcpPersonLink` — without committing to it.
 */
export function peekChallenge(
  secretHash: string,
  surface: LinkProofSurface,
  now: number,
  db: Executor
): PersonLinkChallenge | undefined {
  return db
    .select()
    .from(personLinkChallenges)
    .where(
      and(
        eq(personLinkChallenges.secretHash, secretHash),
        eq(personLinkChallenges.surface, surface),
        isNull(personLinkChallenges.usedAt),
        gt(personLinkChallenges.expiresAt, now)
      )
    )
    .get()
}

/**
 * Re-point every still-outstanding (unused, regardless of expiry) `discord`
 * challenge naming `loserPersonId` as its survivor onto `survivorPersonId`
 * instead — called by `people.ts#mergePeople`, in the same transaction as
 * the rest of a merge (D-35 rework, finding 2).
 *
 * Why this exists: a challenge's TTL (ten minutes, `DEFAULT_PERSON_LINK_TTL_MS`)
 * is long enough that a person can begin a Discord connect attempt, be
 * merged into someone else by a *different*, faster proof completing first,
 * and then still return to redeem their own still-live challenge — which,
 * unrepointed, would bind the proven snowflake to a tombstone
 * (`mergedIntoPersonId` already set) that `mergePeople` now refuses as a
 * survivor, permanently declining a legitimate connect attempt with no
 * recovery path. Re-pointing means that attempt still completes, against
 * the person `loserPersonId` actually is now.
 *
 * Only `discord` challenges carry a `personId` at all (this file's own
 * module comment) — an `mcp` challenge is bound to an identity, not a
 * survivor, so merging two people can never orphan one; this function's own
 * `WHERE` already only ever matches `discord` rows as a consequence, without
 * needing to say so explicitly.
 */
export function repointOutstandingChallenges(
  organizationId: string,
  loserPersonId: string,
  survivorPersonId: string,
  db: Executor
): number {
  const result = db
    .update(personLinkChallenges)
    .set({ personId: survivorPersonId })
    .where(
      and(
        eq(personLinkChallenges.organizationId, organizationId),
        eq(personLinkChallenges.personId, loserPersonId),
        isNull(personLinkChallenges.usedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * Delete every challenge row whose `expiresAt` has already passed — the same
 * sweep-on-write device `discord-install-states.ts#deleteExpiredInstallStates`
 * uses for TEN-4, applied here so a person who begins (and abandons) connect
 * attempts over time does not leave an unbounded number of dead rows behind.
 */
export function deleteExpiredChallenges(now: number, db: Executor): number {
  const result = db
    .delete(personLinkChallenges)
    .where(lt(personLinkChallenges.expiresAt, now))
    .run()
  return result.changes
}
