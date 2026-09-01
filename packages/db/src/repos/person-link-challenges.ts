/**
 * Repository for `person_link_challenges` (LINK-3).
 *
 * The storage half of connecting a second surface's proof: one row per
 * attempt, from `@bloombot/auth`'s `beginDiscordPersonLink`/
 * `issueMcpPersonLinkToken` generating a secret, to `consumeChallenge`
 * redeeming it exactly once. Keyed on the secret's *hash* — the same class
 * of exception `discord-install-states.ts` documents for itself: a caller
 * consuming this (an OAuth callback, an MCP token redemption) carries only
 * the secret value, not an organization id, so this is one more "found
 * before any organization scoping applies" exception, allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly.
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { personLinkChallenges, type LinkProofSurface } from '../schema.js'

export type PersonLinkChallenge = typeof personLinkChallenges.$inferSelect
export type { LinkProofSurface }

/** Fields the caller supplies when beginning a link attempt. */
export interface NewPersonLinkChallenge {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  organizationId: string
  /** The survivor — "the account being connected" (D-28) — not the identity being proved. */
  personId: string
  surface: LinkProofSurface
  /** SHA-256 hash of the secret; see `@bloombot/auth`'s `person-link.ts`. */
  secretHash: string
  /** PKCE verifier, plain text (D-21) — only set for `surface: 'discord'`. */
  codeVerifier?: string | null
  expiresAt: number
}

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
      personId: input.personId,
      surface: input.surface,
      secretHash: input.secretHash,
      codeVerifier: input.codeVerifier ?? null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Redeem a challenge by its secret's hash: atomically marks it used and
 * returns the row — the same single conditional `UPDATE`
 * `discord-install-states.ts#consumeInstallState`/`sign-in-tokens.ts#consumeSignInToken`
 * use, so two concurrent redemptions of the same secret resolve to exactly
 * one winner.
 *
 * Returns `undefined` for a hash that was never issued, one already used,
 * and one that has expired — identically in all three cases (LINK-3's own
 * "no oracle" guarantee, the same one AUTH-1's token already gives).
 */
export function consumeChallenge(
  secretHash: string,
  now: number,
  db: Executor
): PersonLinkChallenge | undefined {
  return db
    .update(personLinkChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(personLinkChallenges.secretHash, secretHash),
        isNull(personLinkChallenges.usedAt),
        gt(personLinkChallenges.expiresAt, now)
      )
    )
    .returning()
    .get()
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
